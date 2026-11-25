// agent-presets · 增量沉淀器（compactor）
// 目标：会话触发 /compact 前，把"上次提炼点之后新增"的对话内容提炼成 3~5 条中文要点，
// 写入蓝汐（lanxi-memory）长期记忆，然后记录 lastExtractedLine，保证后续只提炼增量、不重复吃 token。
// 设计原则：全部外部依赖（协奏台配置 / 蓝汐引擎）都允许失败，失败即降级为本地提取，绝不抛出。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();

export const MIN_INCREMENT_CHARS = 1000;
export const ORCHESTRATOR_CONFIG_PATH = path.join(
  HOME,
  ".gemini",
  "external-orchestrator",
  "config.json"
);

export const LANXI_ENGINE_PATHS = [
  path.join(HOME, ".gemini", "config", "plugins", "lanxi-memory", "lib", "engine.mjs"),
  path.join(HOME, ".gemini", "extensions", "lanxi-memory", "lib", "engine.mjs")
];

// ---------- transcript 增量读取 ----------

function readTranscriptLines(transcriptPath) {
  try {
    const text = fs.readFileSync(transcriptPath, "utf8");
    return text.split(/\r?\n/);
  } catch {
    return [];
  }
}

function extractLineText(record) {
  if (!record || typeof record !== "object") return "";
  const type = String(record.type || "");
  let body = "";
  const raw = record.content ?? record.text ?? record.thinking ?? record.output ?? "";
  if (typeof raw === "string") body = raw;
  else if (raw && typeof raw === "object") {
    if (typeof raw.text === "string") body = raw.text;
    else if (Array.isArray(raw.parts)) body = raw.parts.map((p) => p?.text || "").join("\n");
  }
  if (!body && typeof record.thinking === "string") body = record.thinking;
  // USER_INPUT 包裹的标签去掉，保留正文
  body = body
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "")
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, "")
    .replace(/<\/?USER_REQUEST>/g, "")
    .trim();
  if (!body) return "";
  return body;
}

// 读取 lastExtractedLine 之后新增的 USER_INPUT / PLANNER_RESPONSE 文本
export function collectIncrement(transcriptPath, lastExtractedLine = 0) {
  const lines = readTranscriptLines(transcriptPath);
  const start = Math.max(0, Number(lastExtractedLine) || 0);
  const totalLines = lines.length;
  const segments = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const type = String(record?.type || "");
    if (type !== "USER_INPUT" && type !== "PLANNER_RESPONSE") continue;
    const text = extractLineText(record);
    if (!text) continue;
    const truncated = text.length > 1200 ? text.slice(0, 1200) + "…" : text;
    segments.push({ type, text: truncated });
  }
  const joined = segments.map((s) => s.text).join("\n\n");
  return {
    totalLines,
    lastExtractedLine: start,
    newLineCount: Math.max(0, totalLines - start),
    segments,
    text: joined,
    chars: joined.length
  };
}

// ---------- 本地降级摘要 ----------

export function buildLocalSummary(increment) {
  const segs = Array.isArray(increment?.segments) ? increment.segments : [];
  const users = segs.filter((s) => s.type === "USER_INPUT").map((s) => s.text);
  const models = segs.filter((s) => s.type === "PLANNER_RESPONSE").map((s) => s.text);
  const oneLine = (t, n) =>
    String(t || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, n);

  const bullets = [];
  const userTail = users.slice(-3);
  userTail.forEach((u) => {
    const line = oneLine(u, 120);
    if (line) bullets.push(`用户诉求：${line}`);
  });
  const modelTail = models.slice(-2);
  modelTail.forEach((m) => {
    const line = oneLine(m, 140);
    if (line) bullets.push(`关键进展：${line}`);
  });
  if (bullets.length === 0) {
    bullets.push("本轮对话为无正文的工具调用流水，暂无可用要点。");
  }
  return bullets.slice(0, 5);
}

// ---------- 协奏台配置与远程提炼 ----------

export function loadOrchestratorConfig(configPath) {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
}

// 从 routing.profiles 的 fast / default 里挑第一个可用渠道
export function resolveFastChannel(cfg) {
  if (!cfg || typeof cfg !== "object") return null;
  const providers = Array.isArray(cfg.providers) ? cfg.providers : [];
  const enabled = providers.filter((p) => p && p.enabled && p.baseUrl);
  if (enabled.length === 0) return null;
  const byId = new Map(enabled.map((p) => [String(p.id), p]));
  const profiles = cfg.routing?.profiles && typeof cfg.routing.profiles === "object" ? cfg.routing.profiles : {};
  const order = ["fast", "default"];
  for (const name of order) {
    const profile = profiles[name];
    const candidates = [];
    if (profile?.primary) candidates.push(String(profile.primary));
    if (Array.isArray(profile?.fallbacks)) {
      for (const f of profile.fallbacks) candidates.push(String(f));
    }
    for (const spec of candidates) {
      const idx = spec.indexOf(":");
      if (idx <= 0) continue;
      const pid = spec.slice(0, idx);
      const model = spec.slice(idx + 1);
      const provider = byId.get(pid);
      if (!provider) continue;
      return {
        provider,
        model,
        protocol: String(provider.protocol || "openai"),
        profile: name
      };
    }
  }
  const fallbackProvider = enabled[0];
  return {
    provider: fallbackProvider,
    model: String(fallbackProvider.defaultModel || ""),
    protocol: String(fallbackProvider.protocol || "openai"),
    profile: "fallback"
  };
}

const SYSTEM_PROMPT =
  "你是会话记忆提炼器。请把输入的对话增量提炼成 3~5 条简体中文要点，每条一行，以「- 」开头。" +
  "只保留决策、结论、待办、关键事实与未解决问题，不要寒暄、不要复述过程、不要编造未出现的信息。" +
  "直接输出要点列表，不要任何前后缀说明。";

function buildUserPrompt(text) {
  return `以下是本次会话自上次提炼之后新增的对话内容：\n\n${text}\n\n请输出 3~5 条中文要点。`;
}

function parseBullets(raw) {
  const lines = String(raw || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^[-*•\d.、)）\s]+/, "").trim())
    .filter(Boolean);
  const uniq = [];
  for (const line of lines) {
    const clipped = line.length > 200 ? line.slice(0, 200) + "…" : line;
    if (!uniq.includes(clipped)) uniq.push(clipped);
  }
  return uniq.slice(0, 5);
}

async function callOpenAIChannel(channel, prompt, timeoutMs) {
  const p = channel.provider;
  const base = String(p.baseUrl || "").replace(/\/+$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}),
      ...(p.headers && typeof p.headers === "object" ? p.headers : {})
    },
    body: JSON.stringify({
      model: channel.model || p.defaultModel,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt }
      ],
      temperature: 0.2,
      max_tokens: 700
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`openai http ${res.status}`);
  const json = await res.json();
  return json?.choices?.[0]?.message?.content || "";
}

async function callAnthropicChannel(channel, prompt, timeoutMs) {
  const p = channel.provider;
  const base = String(p.baseUrl || "").replace(/\/+$/, "");
  const res = await fetch(`${base}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": String(p.apiKey || ""),
      "anthropic-version": "2023-06-01",
      ...(p.headers && typeof p.headers === "object" ? p.headers : {})
    },
    body: JSON.stringify({
      model: channel.model || p.defaultModel,
      system: SYSTEM_PROMPT,
      max_tokens: 700,
      messages: [{ role: "user", content: prompt }]
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`anthropic http ${res.status}`);
  const json = await res.json();
  const blocks = Array.isArray(json?.content) ? json.content : [];
  return blocks.map((b) => b?.text || "").join("\n");
}

async function summarizeRemotely(text, options) {
  const configPath = options.orchestratorConfigPath || ORCHESTRATOR_CONFIG_PATH;
  const cfg = loadOrchestratorConfig(configPath);
  const channel = resolveFastChannel(cfg);
  if (!channel) return { ok: false, error: "no_channel" };
  const timeoutMs = Math.max(5000, Number(options.llmTimeoutMs) || 45000);
  const prompt = buildUserPrompt(text);
  const raw =
    channel.protocol === "anthropic"
      ? await callAnthropicChannel(channel, prompt, timeoutMs)
      : await callOpenAIChannel(channel, prompt, timeoutMs);
  const bullets = parseBullets(raw);
  if (bullets.length === 0) return { ok: false, error: "empty_summary" };
  return { ok: true, bullets, provider: channel.provider.id, model: channel.model, profile: channel.profile };
}

// ---------- 蓝汐写入 ----------

async function writeToLanxi({ title, bullets, conversationId, options }) {
  let engine = null;
  try {
    let mod = null;
    const explicit = options.lanxiEnginePath;
    const candidates = explicit ? [explicit, ...LANXI_ENGINE_PATHS] : LANXI_ENGINE_PATHS;
    for (const candidate of candidates) {
      try {
        if (!fs.existsSync(candidate)) continue;
        mod = await import(pathToFileURL(candidate).href);
        break;
      } catch {
        mod = null;
      }
    }
    if (!mod || typeof mod.LanxiEngine !== "function") {
      return { ok: false, error: "engine_unavailable" };
    }
    engine = new mod.LanxiEngine();
    const content = bullets.map((b) => `- ${b}`).join("\n");
    const res = engine.writeMemory({
      layer: "episodic",
      title,
      content,
      tags: ["auto-sentinel", "compact-extract"],
      importance: 0.55,
      confidence: 0.85,
      session_id: String(conversationId || ""),
      role: "assistant",
      source: "agent-presets-sentinel"
    });
    return { ok: true, id: res?.id || "", deduplicated: Boolean(res?.deduplicated) };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  } finally {
    if (engine) {
      try {
        engine.close();
      } catch {
        // ignore
      }
    }
  }
}

// ---------- 主流程 ----------

function buildTitle(conversationId, at) {
  const short = String(conversationId || "").slice(0, 8) || "unknown";
  const stamp = String(at || "").replace("T", " ").replace(/\..*$/, "").slice(0, 16);
  return `会话压缩沉淀 · ${short} · ${stamp}`;
}

/**
 * 执行增量沉淀流水线。
 * payload: { conversationId, transcriptPath, lastExtractedLine }
 * 返回：{ ok, skipped?, summarySource, bullets, written, lastExtractedLine, lastExtractedAt }
 */
export async function runCompactPipeline(payload = {}, options = {}) {
  const transcriptPath = String(payload.transcriptPath || "");
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { ok: false, skipped: "no_transcript" };
  }
  const lastExtractedLine = Math.max(0, Number(payload.lastExtractedLine) || 0);
  let increment;
  try {
    increment = collectIncrement(transcriptPath, lastExtractedLine);
  } catch {
    return { ok: false, skipped: "read_error" };
  }
  if (increment.chars < MIN_INCREMENT_CHARS) {
    return {
      ok: true,
      skipped: "too_short",
      chars: increment.chars,
      lastExtractedLine,
      lastExtractedAt: ""
    };
  }

  let bullets = null;
  let summarySource = "remote";
  let remoteError = "";
  try {
    const remote = await summarizeRemotely(increment.text, options);
    if (remote.ok) bullets = remote.bullets;
    else remoteError = remote.error;
  } catch (err) {
    remoteError = String(err?.message || err);
  }
  if (!bullets) {
    bullets = buildLocalSummary(increment);
    summarySource = "local";
  }

  const at = new Date().toISOString();
  const title = buildTitle(payload.conversationId, at);
  const written = await writeToLanxi({
    title,
    bullets,
    conversationId: payload.conversationId,
    options
  });

  if (!written || !written.ok) {
    return {
      ok: false,
      skipped: "write_failed",
      lastExtractedLine,
      lastExtractedAt: "",
      summarySource,
      remoteError,
      written
    };
  }

  const nextLine = increment.totalLines;
  if (typeof options.onExtract === "function") {
    try {
      options.onExtract({
        lastExtractedLine: nextLine,
        lastExtractedAt: at,
        bullets,
        summarySource,
        written
      });
    } catch {
      // ignore
    }
  }

  return {
    ok: true,
    skipped: "",
    summarySource,
    remoteError,
    bullets,
    written,
    chars: increment.chars,
    lastExtractedLine: nextLine,
    lastExtractedAt: at
  };
}
