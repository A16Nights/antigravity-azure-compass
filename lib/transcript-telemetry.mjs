// agent-presets · 真实 Token 用量、动态模型窗口与 /compact 后无损回注引擎
// 零第三方依赖、纯本地快速扫描（<20ms），所有读盘异常 fail-open 绝不阻断宿主。
import fs from "node:fs";
import path from "node:path";

const MAX_TAIL_BYTES = 2 * 1024 * 1024;

// 敏感凭据脱敏规则（防止密钥/Token 随回注简报二次扩散）
const REDACT_PATTERNS = [
  { re: /\b(ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, rep: "[REDACTED_GH_TOKEN]" },
  { re: /\b(sk-[A-Za-z0-9_-]{16,})\b/g, rep: "[REDACTED_API_KEY]" },
  { re: /\b(AIza[0-9A-Za-z_-]{20,})\b/g, rep: "[REDACTED_GOOGLE_KEY]" },
  { re: /(Authorization\s*:\s*(?:Bearer|Basic)\s+)[^\s"'`]+/gi, rep: "$1[REDACTED]" },
  { re: /((?:api[_-]?key|access[_-]?token|secret|password)\s*[=:]\s*["']?)[^\s"'`,;]{8,}/gi, rep: "$1[REDACTED]" }
];

export function redactSecrets(text) {
  let out = String(text || "");
  for (const p of REDACT_PATTERNS) {
    out = out.replace(p.re, p.rep);
  }
  return out;
}

/**
 * 根据模型名解析该模型在 Antigravity 中的有效输入上限（tokens，与官方上下文窗口弹窗口径一致）。
 * 说明：Gemini 2.5/3/4 物理总窗口为 1M (1,048,576)，Antigravity 宿主预留 256K (262,144) 输出/思考预算，
 * 实际有效输入上限 / 原生自动压缩天花板为 786,432 (786.4k)。
 * 若未知或为空，回退到 fallbackWindowTokens。
 */
export function resolveModelContextWindow(modelName = "", fallbackWindowTokens = 200000) {
  const m = String(modelName || "").trim().toLowerCase();
  const fallback = Math.max(32000, Math.min(2000000, Number(fallbackWindowTokens) || 200000));
  if (!m) return { windowTokens: fallback, physicalWindowTokens: fallback, source: "fallback" };

  // Gemini 2.5 / 3 / 4 & Antigravity 编排/工作模型：物理 1M (1,048,576)，官方有效输入上限 786,432 (75%)
  if (
    /^gemini-(?:4|3|2\.5|pro-orchestrator|flash-worker)/.test(m) ||
    m.includes("1m")
  ) {
    return { windowTokens: 786432, physicalWindowTokens: 1048576, source: "model" };
  }
  // Claude 系列（非 1m 标识）默认 200K
  if (m.includes("claude") || m.includes("sonnet") || m.includes("opus") || m.includes("haiku")) {
    return { windowTokens: 200000, physicalWindowTokens: 200000, source: "model" };
  }
  // OpenAI GPT-5 / Codex 系列 400K，GPT-4.1 1M，o3/o4 200K，GPT-4o 128K
  if (m.includes("gpt-4.1")) return { windowTokens: 786432, physicalWindowTokens: 1048576, source: "model" };
  if (m.includes("gpt-5") || m.includes("codex")) return { windowTokens: 400000, physicalWindowTokens: 400000, source: "model" };
  if (/\bo[134]\b|o3-|o4-/.test(m)) return { windowTokens: 200000, physicalWindowTokens: 200000, source: "model" };
  if (m.includes("gpt-4o")) return { windowTokens: 128000, physicalWindowTokens: 128000, source: "model" };
  // 国产主流推理/代码模型
  if (m.includes("kimi-k2") || m.includes("qwen3") || m.includes("glm-5")) {
    return { windowTokens: 256000, physicalWindowTokens: 256000, source: "model" };
  }
  if (m.includes("deepseek") || m.includes("qwen") || m.includes("glm") || m.includes("minimax")) {
    return { windowTokens: 128000, physicalWindowTokens: 128000, source: "model" };
  }

  return { windowTokens: fallback, physicalWindowTokens: fallback, source: "fallback" };
}

function readTailBuffer(filePath, maxBytes = MAX_TAIL_BYTES) {
  const stat = fs.statSync(filePath);
  if (stat.size <= maxBytes) {
    return { buf: fs.readFileSync(filePath), totalBytes: stat.size, truncated: false };
  }
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const readLen = fs.readSync(fd, buf, 0, maxBytes, stat.size - maxBytes);
    return { buf: buf.subarray(0, readLen), totalBytes: stat.size, truncated: true };
  } finally {
    fs.closeSync(fd);
  }
}

function cleanUserText(raw) {
  let body = "";
  if (typeof raw === "string") body = raw;
  else if (raw && typeof raw === "object") {
    if (typeof raw.text === "string") body = raw.text;
    else if (Array.isArray(raw.parts)) body = raw.parts.map((p) => p?.text || "").join("\n");
  }
  return redactSecrets(
    body
      .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "")
      .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, "")
      .replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/g, "")
      .replace(/<\/?USER_REQUEST>/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * 解析 transcript.jsonl 尾部：
 * - 精准定位最新 CHECKPOINT 边界（只统计该边界之后的活跃上下文）
 * - 优先使用 API 实测 input_tokens + cache_read_tokens（无实测值时回退 activeBytes / 4.2）
 * - 自动识别当前会话最近使用的模型与动态窗口上限、KV-Cache 命中率
 */
export function analyzeTranscriptTelemetry(
  transcriptPath,
  { fallbackWindowTokens = 200000, autoWindow = true } = {}
) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { found: false };
  }
  const { buf, totalBytes, truncated } = readTailBuffer(transcriptPath, MAX_TAIL_BYTES);
  const text = buf.toString("utf8");
  const rawLines = text.split(/\r?\n/);
  const startIdx = truncated ? 1 : 0; // 丢弃可能截断的首行残片

  let lastCheckpointIdx = -1;
  let lastCheckpointStep = null;
  let lastCheckpointAt = "";

  for (let i = rawLines.length - 1; i >= startIdx; i -= 1) {
    const line = rawLines[i];
    if (!line || !line.includes('"CHECKPOINT"')) continue;
    try {
      const rec = JSON.parse(line);
      if (String(rec?.type || "") === "CHECKPOINT") {
        lastCheckpointIdx = i;
        lastCheckpointStep = rec.step_index ?? i;
        lastCheckpointAt = String(rec.created_at || "");
        break;
      }
    } catch {}
  }

  const activeStartIdx = lastCheckpointIdx >= 0 ? lastCheckpointIdx + 1 : startIdx;
  const activeSliceText =
    lastCheckpointIdx >= 0 ? rawLines.slice(lastCheckpointIdx).join("\n") : text;
  const activeBytes =
    lastCheckpointIdx >= 0 ? Buffer.byteLength(activeSliceText, "utf8") : totalBytes;

  // 在活跃区间（最新 CHECKPOINT 之后）找最后一条带真实用量的 PLANNER_RESPONSE
  let lastModel = "";
  let apiInputTokens = null;
  let apiCacheReadTokens = null;
  let apiOutputTokens = null;
  let plannerTurnsAfterCheckpoint = 0;

  for (let i = rawLines.length - 1; i >= activeStartIdx; i -= 1) {
    const line = rawLines[i];
    if (!line || !line.includes('"PLANNER_RESPONSE"')) continue;
    try {
      const rec = JSON.parse(line);
      if (String(rec?.type || "") !== "PLANNER_RESPONSE") continue;
      plannerTurnsAfterCheckpoint += 1;
      if (!lastModel && typeof rec.model === "string" && rec.model.trim()) {
        lastModel = rec.model.trim();
      }
      if (apiInputTokens === null) {
        const inp = Number(rec.input_tokens);
        const cache = Number(rec.cache_read_tokens || 0);
        const out = Number(rec.output_tokens || 0);
        if (Number.isFinite(inp) && inp >= 0 && inp + cache > 0) {
          apiInputTokens = inp;
          apiCacheReadTokens = Number.isFinite(cache) && cache >= 0 ? cache : 0;
          apiOutputTokens = Number.isFinite(out) && out >= 0 ? out : 0;
        }
      }
      if (lastModel && apiInputTokens !== null) break;
    } catch {}
  }

  // 若刚压缩完还没产生新的 PLANNER_RESPONSE，向前找最近一次模型名（只用于窗口识别）
  if (!lastModel) {
    for (let i = Math.min(activeStartIdx - 1, rawLines.length - 1); i >= startIdx; i -= 1) {
      const line = rawLines[i];
      if (!line || !line.includes('"model"')) continue;
      try {
        const rec = JSON.parse(line);
        if (typeof rec?.model === "string" && rec.model.trim()) {
          lastModel = rec.model.trim();
          break;
        }
      } catch {}
    }
  }

  const hasApiTokens = apiInputTokens !== null;
  const estimatedTokens = hasApiTokens
    ? apiInputTokens + (apiCacheReadTokens || 0)
    : Math.round(activeBytes / 4.2);
  const cacheHitRate =
    hasApiTokens && estimatedTokens > 0
      ? Math.round(((apiCacheReadTokens || 0) / estimatedTokens) * 100)
      : null;

  const resolvedWin = autoWindow
    ? resolveModelContextWindow(lastModel, fallbackWindowTokens)
    : { windowTokens: Math.max(32000, Number(fallbackWindowTokens) || 200000), source: "manual" };

  const checkpointMarker =
    lastCheckpointIdx >= 0
      ? `${lastCheckpointStep ?? lastCheckpointIdx}:${lastCheckpointAt || "unknown"}`
      : "";

  return {
    found: true,
    bytes: activeBytes,
    totalBytes,
    compacted: lastCheckpointIdx >= 0,
    checkpointStep: lastCheckpointStep,
    checkpointAt: lastCheckpointAt,
    checkpointMarker,
    plannerTurnsAfterCheckpoint,
    model: lastModel,
    tokenSource: hasApiTokens ? "api" : "estimate",
    estimatedTokens,
    inputTokens: apiInputTokens,
    cacheReadTokens: apiCacheReadTokens,
    outputTokens: apiOutputTokens,
    cacheHitRate,
    contextWindowTokens: resolvedWin.windowTokens,
    windowSource: resolvedWin.source
  };
}

function collectToolFilePath(args) {
  if (!args || typeof args !== "object") return [];
  const out = [];
  for (const key of ["Path", "path", "TargetFile", "targetFile", "filePath"]) {
    if (typeof args[key] === "string" && args[key].trim()) out.push(args[key].trim());
  }
  if (Array.isArray(args.edits)) {
    for (const e of args.edits) {
      if (typeof e?.path === "string" && e.path.trim()) out.push(e.path.trim());
    }
  }
  return out;
}

/**
 * 为 /compact 后的第一轮提取精简无损回注上下文（纯本地零 LLM，<20ms）：
 * - 合并压缩前刚沉淀进蓝汐的要点（lastBullets）
 * - 提取最近修改/新建的文件列表
 * - 提取最近测试/校验命令与最近 2 条用户核心指令
 */
export function buildPostCompactRehydration(
  transcriptPath,
  { lastBullets = [], lastExtractedAt = "", maxChars = 1150 } = {}
) {
  const modifiedFiles = [];
  const seenFiles = new Set();
  const recentUsers = [];
  let lastCheckCmd = "";

  if (transcriptPath && fs.existsSync(transcriptPath)) {
    try {
      const { buf, truncated } = readTailBuffer(transcriptPath, MAX_TAIL_BYTES);
      const rawLines = buf.toString("utf8").split(/\r?\n/);
      const startIdx = truncated ? 1 : 0;

      // 找到最新 CHECKPOINT 位置，向前扫最多 600 行提取压缩前的真实工作进度
      let cpIdx = rawLines.length;
      for (let i = rawLines.length - 1; i >= startIdx; i -= 1) {
        if (rawLines[i] && rawLines[i].includes('"CHECKPOINT"')) {
          try {
            const rec = JSON.parse(rawLines[i]);
            if (String(rec?.type || "") === "CHECKPOINT") {
              cpIdx = i;
              break;
            }
          } catch {}
        }
      }
      const scanFrom = Math.max(startIdx, cpIdx - 600);
      for (let i = cpIdx - 1; i >= scanFrom; i -= 1) {
        const line = rawLines[i];
        if (!line || !line.trim()) continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        const t = String(rec?.type || "");
        if (t === "USER_INPUT" && recentUsers.length < 2) {
          const cleaned = cleanUserText(rec.content ?? rec.text);
          if (cleaned && cleaned !== "/compact" && !cleaned.startsWith("/compact ")) {
            recentUsers.push(cleaned.slice(0, 120));
          }
        }
        if (t === "PLANNER_RESPONSE" && Array.isArray(rec.tool_calls)) {
          for (let j = rec.tool_calls.length - 1; j >= 0; j -= 1) {
            const tc = rec.tool_calls[j];
            const name = String(tc?.name || "");
            const args = tc?.args || tc?.arguments || {};
            if (
              /edit_file|write_file|replace_file_content|apply_edits/i.test(name) &&
              modifiedFiles.length < 8
            ) {
              for (const fp of collectToolFilePath(args)) {
                const norm = fp.replace(/\\/g, "/");
                const key = norm.toLowerCase();
                if (!seenFiles.has(key)) {
                  seenFiles.add(key);
                  // 保留末尾最多两段路径，既清晰又省 token
                  const segs = norm.split("/").filter(Boolean);
                  const shortPath = segs.length > 2 ? segs.slice(-2).join("/") : norm;
                  modifiedFiles.push(shortPath);
                }
              }
            }
            if (!lastCheckCmd && /run_command|run_checks/i.test(name)) {
              const summary = String(args.toolSummary || args.CommandLine || "").trim();
              if (summary && /test|check|verify|build|lint|语法|验收|验证|测试/i.test(summary)) {
                lastCheckCmd = redactSecrets(summary.replace(/\s+/g, " ").slice(0, 90));
              }
            }
          }
        }
        if (recentUsers.length >= 2 && modifiedFiles.length >= 8 && lastCheckCmd) break;
      }
    } catch {}
  }

  const bullets = Array.isArray(lastBullets)
    ? lastBullets.map((b) => redactSecrets(String(b || "").trim())).filter(Boolean).slice(0, 5)
    : [];

  if (bullets.length === 0 && modifiedFiles.length === 0 && recentUsers.length === 0) {
    return "";
  }

  const lines = ["[苍蓝罗盘 · /compact 后自动无损回注]"];
  if (bullets.length > 0) {
    const stamp = lastExtractedAt ? `（${String(lastExtractedAt).replace("T", " ").slice(0, 16)} 沉淀）` : "";
    lines.push(`压缩前蓝汐要点${stamp}：`);
    for (const b of bullets) lines.push(`- ${b.slice(0, 160)}`);
  }
  if (modifiedFiles.length > 0) {
    lines.push(`近期改动文件：${modifiedFiles.join("、")}`);
  }
  if (lastCheckCmd) {
    lines.push(`最近验证项：${lastCheckCmd}`);
  }
  if (recentUsers.length > 0) {
    lines.push(`压缩前最近指令：${recentUsers.reverse().join(" → ")}`);
  }
  lines.push("（以上由本地日志自动提取，仅在本次 /compact 后回注一次；如需更多历史可用蓝汐记忆检索。）");

  let result = lines.join("\n");
  if (result.length > maxChars) {
    result = result.slice(0, maxChars - 1) + "…";
  }
  return result;
}
