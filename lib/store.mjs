import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const HOME = process.env.USERPROFILE || os.homedir();
export const DATA_DIR = path.join(HOME, ".gemini", "agent-presets");
export const CONFIG_PATH = path.join(DATA_DIR, "config.json");
export const BRAIN_DIR = path.join(HOME, ".gemini", "antigravity", "brain");
export const SOUL_STORE_PATH = path.join(HOME, ".gemini", "config", "plugins", "soul-md", "lib", "store.mjs");

export const SENTINEL_SIGNAL_PATH = path.join(DATA_DIR, "sentinel-signal.json");
export const HOOK_STATE_PATH = path.join(DATA_DIR, "hook-state.json");
export const MAX_DEDUP_CONVERSATIONS = 64;

export const DEFAULT_SENTINEL = {
  enabled: true,
  warnPercent: 55,
  criticalPercent: 72,
  contextWindowTokens: 200000,
  autoCompactEnabled: false,
  autoExtractToLingshu: true,
  maxRetries: 3,
  cooldownMs: 300000,
  commandName: "compact"
};

export const BUILTIN_PRESETS = [
  {
    id: "standard",
    name: "标准模式",
    group: "builtin",
    badge: "内置",
    description: "处理代码、文件和资料，适合大多数任务。Agent 会按需使用检索、编辑和终端等工具。",
    soulCard: "",
    anchor: "[Agent 预设：标准模式]\n按需调用工具解决问题，先想清楚再动手，只改该改的内容，完成后验证结果。"
  },
  {
    id: "orchestrator",
    name: "协奏台省流模式",
    group: "builtin",
    badge: "内置",
    description: "适合批量读文件、写代码与长日志分析。强制优先派单给苍蓝协奏台（external-orchestrator）外部模型执行，主脑只做规划与验收。",
    soulCard: "",
    anchor: "[Agent 预设：协奏台省流模式 · 强约束]\n凡涉及阅读长文件/多文件、编写 >15 行代码、跑长日志或批量文本生成，必须优先调用 external-orchestrator（worker_execute / worker_generate）派单执行，主脑仅负责规划与轻量抽查验收。"
  },
  {
    id: "minimal",
    name: "极简模式",
    group: "builtin",
    badge: "内置",
    description: "最少工具调用、最短直接回复，不展开多余分析与流程，适合快速问答、测试和对比基础表现。",
    soulCard: "",
    anchor: "[Agent 预设：极简模式]\n保持极简：非必要不调工具，直接给结论或最短可执行方案，不写冗长背景说明。"
  },
  {
    id: "review",
    name: "只读审查模式",
    group: "builtin",
    badge: "内置",
    description: "专注读代码、排错定位与方案评审。强约束禁止修改或写入任何文件，防止模型手痒误改，只输出分析与建议。",
    soulCard: "",
    anchor: "[Agent 预设：只读审查模式 · 硬约束]\n严禁调用任何写入、编辑、删除文件或产生副作用的命令！仅允许只读检索与分析，给出精准的根因定位、风险点与修改建议，等待用户确认后再动手。"
  }
];

export const DEFAULT_CUSTOM_PRESETS = [
  {
    id: "engineer",
    name: "冷静工程模式",
    group: "custom",
    badge: "自定义",
    description: "纯工程严谨输出，自动联动 soul-md 切到「冷静工程助手」人设卡，适合代码评审与排错。",
    soulCard: "冷静工程助手",
    anchor: "[Agent 预设：冷静工程模式]\n保持冷静、克制、专业的工程沟通风格：直接给结论、代码、命令与验证结果，不寒暄、不卖萌。"
  }
];

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export class PresetStore {
  constructor() {
    this.ensureInitialized();
  }

  ensureInitialized() {
    ensureDir(DATA_DIR);
    if (!fs.existsSync(CONFIG_PATH)) {
      this.saveConfig({
        activeId: "standard",
        perTurnReinforce: true,
        sentinel: { ...DEFAULT_SENTINEL },
        customPresets: structuredClone(DEFAULT_CUSTOM_PRESETS)
      });
    }
  }

  getConfig() {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      return {
        activeId: raw.activeId || "standard",
        perTurnReinforce: raw.perTurnReinforce !== false,
        sentinel: {
          ...DEFAULT_SENTINEL,
          ...(raw.sentinel && typeof raw.sentinel === "object" ? raw.sentinel : {})
        },
        customPresets: Array.isArray(raw.customPresets) ? raw.customPresets : structuredClone(DEFAULT_CUSTOM_PRESETS)
      };
    } catch {
      return {
        activeId: "standard",
        perTurnReinforce: true,
        sentinel: { ...DEFAULT_SENTINEL },
        customPresets: structuredClone(DEFAULT_CUSTOM_PRESETS)
      };
    }
  }

  saveConfig(cfg) {
    ensureDir(DATA_DIR);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  }

  getAllPresets() {
    const cfg = this.getConfig();
    return [...BUILTIN_PRESETS, ...cfg.customPresets];
  }

  getActivePreset() {
    const cfg = this.getConfig();
    const all = this.getAllPresets();
    return all.find((p) => p.id === cfg.activeId) || all[0];
  }

  async syncSoulCard(cardName) {
    if (!cardName || !fs.existsSync(SOUL_STORE_PATH)) return { synced: false };
    try {
      const mod = await import(pathToFileURL(SOUL_STORE_PATH).href);
      const soulStore = new mod.SoulStore();
      if (typeof soulStore.switchDefaultCard === "function") {
        soulStore.switchDefaultCard(cardName);
        return { synced: true, card: cardName };
      }
      // Fallback: update soul-md config directly if method name differs
      const soulCfg = soulStore.getConfig();
      soulCfg.defaultCard = cardName;
      soulStore.saveConfig(soulCfg);
      if (typeof soulStore.syncGlobalRule === "function") {
        soulStore.syncGlobalRule();
      }
      return { synced: true, card: cardName };
    } catch (err) {
      return { synced: false, error: String(err?.message || err) };
    }
  }

  async activate(id) {
    const cfg = this.getConfig();
    const all = this.getAllPresets();
    const target = all.find((p) => p.id === id);
    if (!target) {
      throw new Error(`未找到预设：${id}`);
    }
    cfg.activeId = target.id;
    this.saveConfig(cfg);
    const soulSync = await this.syncSoulCard(target.soulCard);
    return { active: target, soulSync };
  }

  setPerTurnReinforce(enabled) {
    const cfg = this.getConfig();
    cfg.perTurnReinforce = Boolean(enabled);
    this.saveConfig(cfg);
    return cfg;
  }

  updateSentinel(patch = {}) {
    const cfg = this.getConfig();
    const next = { ...cfg.sentinel };
    if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
    if (patch.warnPercent !== undefined) {
      next.warnPercent = Math.max(20, Math.min(90, Number(patch.warnPercent) || 55));
    }
    if (patch.criticalPercent !== undefined) {
      next.criticalPercent = Math.max(next.warnPercent + 5, Math.min(95, Number(patch.criticalPercent) || 72));
    }
    if (patch.contextWindowTokens !== undefined) {
      next.contextWindowTokens = Math.max(32000, Math.min(1000000, Number(patch.contextWindowTokens) || 200000));
    }
    if (patch.autoCompactEnabled !== undefined) next.autoCompactEnabled = Boolean(patch.autoCompactEnabled);
    if (patch.autoExtractToLingshu !== undefined) next.autoExtractToLingshu = Boolean(patch.autoExtractToLingshu);
    if (patch.maxRetries !== undefined) {
      next.maxRetries = Math.max(1, Math.min(10, Number(patch.maxRetries) || 3));
    }
    if (patch.cooldownMs !== undefined) {
      next.cooldownMs = Math.max(10000, Math.min(3600000, Number(patch.cooldownMs) || 300000));
    }
    if (patch.commandName !== undefined) {
      const rawName = String(patch.commandName || "").trim().replace(/^\/+/, "");
      next.commandName = rawName || "compact";
    }
    cfg.sentinel = next;
    this.saveConfig(cfg);
    return next;
  }

  inspectLatestSession(conversationId = "") {
    const cfg = this.getConfig();
    const s = cfg.sentinel;
    try {
      let targetFile = "";
      if (conversationId) {
        const candidate = path.join(BRAIN_DIR, String(conversationId), ".system_generated", "logs", "transcript.jsonl");
        if (fs.existsSync(candidate)) targetFile = candidate;
      }
      if (!targetFile && fs.existsSync(BRAIN_DIR)) {
        let newestMtime = 0;
        for (const entry of fs.readdirSync(BRAIN_DIR, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const candidate = path.join(BRAIN_DIR, entry.name, ".system_generated", "logs", "transcript.jsonl");
          if (fs.existsSync(candidate)) {
            const st = fs.statSync(candidate);
            if (st.mtimeMs > newestMtime) {
              newestMtime = st.mtimeMs;
              targetFile = candidate;
            }
          }
        }
      }
      if (!targetFile) {
        return { found: false, estimatedTokens: 0, percent: 0, level: "ok" };
      }
      const stat = fs.statSync(targetFile);
      const rawBuf = fs.readFileSync(targetFile);
      // Only count bytes from the latest CHECKPOINT (compaction boundary) onward
      let activeBytes = stat.size;
      let compacted = false;
      const text = rawBuf.toString("utf8");
      const checkpointRegex = /\n[^\n]*"type"\s*:\s*"CHECKPOINT"/g;
      let lastCheckpointPos = -1;
      let match;
      while ((match = checkpointRegex.exec(text)) !== null) {
        lastCheckpointPos = match.index + 1;
      }
      if (lastCheckpointPos < 0 && /^[^\n]*"type"\s*:\s*"CHECKPOINT"/.test(text)) {
        lastCheckpointPos = 0;
      }
      if (lastCheckpointPos >= 0) {
        activeBytes = Buffer.byteLength(text.slice(lastCheckpointPos), "utf8");
        compacted = true;
      }
      // Compact transcript JSONL includes metadata overhead; ~4.2 bytes/token gives a practical estimate
      const estimatedTokens = Math.round(activeBytes / 4.2);
      const percent = Math.min(100, Math.round((estimatedTokens / s.contextWindowTokens) * 100));
      let level = "ok";
      if (percent >= s.criticalPercent) level = "critical";
      else if (percent >= s.warnPercent) level = "warn";
      return {
        found: true,
        bytes: activeBytes,
        totalBytes: stat.size,
        compacted,
        estimatedTokens,
        contextWindowTokens: s.contextWindowTokens,
        percent,
        level
      };
    } catch {
      return { found: false, estimatedTokens: 0, percent: 0, level: "ok" };
    }
  }

  upsertCustomPreset(preset) {
    const id = String(preset.id || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "-");
    if (!id) throw new Error("预设 ID 不能为空（仅支持英文、数字、-、_）");
    if (BUILTIN_PRESETS.some((b) => b.id === id)) {
      throw new Error(`不能覆盖内置预设 ID：${id}`);
    }
    const cfg = this.getConfig();
    const item = {
      id,
      name: String(preset.name || id).trim(),
      group: "custom",
      badge: "自定义",
      description: String(preset.description || "").trim(),
      soulCard: String(preset.soulCard || "").trim(),
      anchor: String(preset.anchor || "").trim()
    };
    const idx = cfg.customPresets.findIndex((p) => p.id === id);
    if (idx >= 0) {
      cfg.customPresets[idx] = item;
    } else {
      cfg.customPresets.push(item);
    }
    this.saveConfig(cfg);
    return item;
  }

  deleteCustomPreset(id) {
    const cfg = this.getConfig();
    const before = cfg.customPresets.length;
    cfg.customPresets = cfg.customPresets.filter((p) => p.id !== id);
    if (cfg.customPresets.length === before) {
      throw new Error(`未找到自定义预设：${id}`);
    }
    if (cfg.activeId === id) {
      cfg.activeId = "standard";
    }
    this.saveConfig(cfg);
    return cfg;
  }

  // ---------- 监测信号（跨 hook 进程共享的压缩状态） ----------
  loadSentinelSignal(dataDir) {
    return loadSentinelSignal(dataDir);
  }

  patchSentinelSignal(patch, dataDir) {
    return patchSentinelSignal(patch, dataDir);
  }

  resetSentinelBreaker(dataDir) {
    return resetSentinelBreaker(dataDir);
  }

  getTranscriptLineCount(transcriptPath) {
    return getTranscriptLineCount(transcriptPath);
  }

  hasCheckpointAfterLine(transcriptPath, afterLine) {
    return hasCheckpointAfterLine(transcriptPath, afterLine);
  }

  evaluateTurnDedup(input, dataDir) {
    return evaluateTurnDedup(input, dataDir);
  }
}

// ================= 监测信号文件 =================
// 结构：{ conversationId, needCompact, lastPercent, lastTokens, pendingAt, pendingLineCount,
//         lastAttemptAt, dispatchPort, failCount, lastError, compactedAt, lastExtractedLine,
//         lastExtractedAt, lastLevel, updatedAt }

export function defaultSentinelSignal() {
  return {
    conversationId: "",
    needCompact: false,
    lastPercent: 0,
    lastTokens: 0,
    pendingAt: 0,
    pendingLineCount: 0,
    lastAttemptAt: 0,
    dispatchPort: 0,
    failCount: 0,
    lastError: "",
    compactedAt: "",
    lastExtractedLine: 0,
    lastExtractedAt: "",
    lastLevel: "none",
    updatedAt: ""
  };
}

function resolveDataDir(dataDir) {
  return String(dataDir || DATA_DIR);
}

export function sentinelSignalPath(dataDir) {
  return path.join(resolveDataDir(dataDir), "sentinel-signal.json");
}

export function loadSentinelSignal(dataDir) {
  const filePath = sentinelSignalPath(dataDir);
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaultSentinelSignal();
    const base = defaultSentinelSignal();
    for (const [k, v] of Object.entries(raw)) {
      if (v !== undefined) base[k] = v;
    }
    return base;
  } catch {
    return defaultSentinelSignal();
  }
}

// 关键：先 load 再合并写入，绝不丢失 conversationId 等未被 patch 覆盖的字段。
export function patchSentinelSignal(patch = {}, dataDir) {
  const cur = loadSentinelSignal(dataDir);
  const next = {
    ...cur,
    ...(patch && typeof patch === "object" ? patch : {}),
    updatedAt: new Date().toISOString()
  };
  // 防御：conversationId 只允许被非空值覆盖，避免被空 patch 清空
  if (!next.conversationId) next.conversationId = cur.conversationId || "";
  if (patch && typeof patch === "object" && !patch.conversationId) {
    next.conversationId = cur.conversationId || "";
  }
  try {
    const filePath = sentinelSignalPath(dataDir);
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, JSON.stringify(next, null, 2) + "\n", "utf8");
  } catch {
    // 落盘失败不影响 hook 主流程
  }
  return next;
}

// 重置熔断：清 pending / failCount / lastError，保留 conversationId 与提炼进度
export function resetSentinelBreaker(dataDir) {
  return patchSentinelSignal(
    {
      pendingAt: 0,
      pendingLineCount: 0,
      failCount: 0,
      lastError: "",
      lastAttemptAt: 0
    },
    dataDir
  );
}

// ================= transcript 工具 =================

export function getTranscriptLineCount(transcriptPath) {
  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return 0;
    const text = fs.readFileSync(transcriptPath, "utf8");
    if (!text) return 0;
    return text.split(/\r?\n/).filter((l, idx, arr) => idx < arr.length - 1 || l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

// 校验 afterLine 之后是否出现了新的 CHECKPOINT（说明 /compact 已真正落地）
export function hasCheckpointAfterLine(transcriptPath, afterLine) {
  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return false;
    const lines = fs.readFileSync(transcriptPath, "utf8").split(/\r?\n/);
    const start = Math.max(0, Number(afterLine) || 0);
    for (let i = start; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line || !line.trim()) continue;
      if (!line.includes("CHECKPOINT")) continue;
      try {
        const rec = JSON.parse(line);
        if (String(rec?.type || "") === "CHECKPOINT") return true;
      } catch {
        if (/"type"\s*:\s*"CHECKPOINT"/.test(line)) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

// ================= PreInvocation 回合去重 =================

function normalizeTurnKey(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || typeof value === "object") return null;
  const text = String(value).trim();
  if (!text) return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : text;
}

export function hookStatePath(dataDir) {
  return path.join(resolveDataDir(dataDir), "hook-state.json");
}

function readHookState(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { seq: 0, conversations: {} };
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const raw =
      parsed && typeof parsed === "object" && parsed.conversations && typeof parsed.conversations === "object"
        ? parsed.conversations
        : {};
    const conversations = {};
    for (const [key, value] of Object.entries(raw)) {
      if (key && value && typeof value === "object") conversations[key] = value;
    }
    return { seq: Number(parsed?.seq) || 0, conversations };
  } catch {
    return { seq: 0, conversations: {} };
  }
}

function writeHookState(filePath, state) {
  try {
    const conversations =
      state?.conversations && typeof state.conversations === "object" ? state.conversations : {};
    const entries = Object.entries(conversations).filter(([, v]) => v && typeof v === "object");
    let kept = Object.fromEntries(entries);
    if (entries.length > MAX_DEDUP_CONVERSATIONS) {
      entries.sort((a, b) => (Number(b[1]?.seq) || 0) - (Number(a[1]?.seq) || 0));
      kept = Object.fromEntries(entries.slice(0, MAX_DEDUP_CONVERSATIONS));
    }
    ensureDir(path.dirname(filePath));
    const tmpPath = path.join(
      path.dirname(filePath),
      `.hook-state.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
    );
    fs.writeFileSync(tmpPath, JSON.stringify({ seq: Number(state?.seq) || 0, conversations: kept }, null, 2) + "\n", "utf8");
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch {
    return false;
  }
}

function computeTurnSkip(prev, ctx) {
  const { conversationId, userTurnKey, invocationNum, fingerprint } = ctx;
  if (!conversationId) return { skip: false, reason: "no_conversation" };
  if (userTurnKey === null || userTurnKey === undefined) return { skip: false, reason: "no_turn_key" };
  if (!prev || typeof prev !== "object") return { skip: false, reason: "first_seen" };
  if (String(prev.fingerprint || "") !== String(fingerprint || "")) {
    return { skip: false, reason: "fingerprint_changed" };
  }
  if (normalizeTurnKey(prev.userTurnKey ?? null) !== userTurnKey) {
    return { skip: false, reason: "new_turn" };
  }
  const seenCount = Math.max(0, Number(prev.seenCount) || 0);
  if (seenCount < 1) return { skip: false, reason: "not_injected_yet" };
  const prevInvocation = normalizeTurnKey(prev.invocationNum ?? null);
  if (invocationNum !== null && invocationNum !== prevInvocation) {
    return { skip: true, reason: "same_turn_followup" };
  }
  if (invocationNum === null) {
    return { skip: true, reason: "same_turn_no_invocation_num" };
  }
  return { skip: false, reason: "reinject_same_step" };
}

/**
 * 判定 + 记账一步完成。同一用户轮次内同一 fingerprint 只注入一次。
 * input: { conversationId, userTurnKey, invocationNum, fingerprint, record?: boolean }
 */
export function evaluateTurnDedup(input = {}, dataDir) {
  const src = input && typeof input === "object" ? input : {};
  const conversationId = String(src.conversationId || "").trim();
  const userTurnKey = normalizeTurnKey(src.userTurnKey);
  const invocationNum = normalizeTurnKey(src.invocationNum);
  const fingerprint = String(src.fingerprint || "");
  const shouldRecord = src.record !== false;
  const ctx = { conversationId, userTurnKey, invocationNum, fingerprint };
  try {
    const filePath = hookStatePath(dataDir);
    const state = readHookState(filePath);
    const prev = state.conversations[conversationId] || null;
    const decision = computeTurnSkip(prev, ctx);
    if (!decision.skip && shouldRecord && conversationId && userTurnKey !== null) {
      const seq = (Number(state.seq) || 0) + 1;
      state.seq = seq;
      const sameTurn = Boolean(
        prev &&
          typeof prev === "object" &&
          String(prev.fingerprint || "") === fingerprint &&
          normalizeTurnKey(prev.userTurnKey ?? null) === userTurnKey
      );
      const prevSeen = sameTurn ? Math.max(0, Number(prev.seenCount) || 0) : 0;
      state.conversations[conversationId] = {
        fingerprint,
        userTurnKey,
        invocationNum,
        seenCount: prevSeen + 1,
        seq,
        lastUpdatedAt: new Date().toISOString()
      };
      writeHookState(filePath, state);
    }
    return { ...decision, conversationId, userTurnKey, invocationNum, fingerprint };
  } catch {
    return { skip: false, reason: "state_error", conversationId, userTurnKey, invocationNum, fingerprint };
  }
}
