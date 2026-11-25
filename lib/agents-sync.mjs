import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const HOME = process.env.USERPROFILE || os.homedir();
export const DEFAULT_AGENTS_PATH = path.join(HOME, ".gemini", "config", "AGENTS.md");
export const DEFAULT_DATA_DIR = path.join(HOME, ".gemini", "agent-presets");
export const DEFAULT_BRAIN_DIR = path.join(HOME, ".gemini", "antigravity", "brain");

export const AGENTS_LIMIT_BYTES = 24 * 1024; // 24,576 bytes (Antigravity single rule file limit)
export const MAX_SNAPSHOTS = 20;
export const MAX_TRACKED_CONVERSATIONS = 128;
const MAX_DIFF_SUMMARY_CHARS = 3200;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function atomicWriteJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

function atomicWriteText(filePath, text) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, String(text ?? ""), "utf8");
  fs.renameSync(tmp, filePath);
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function normalizeLf(text) {
  return String(text ?? "").replace(/\r\n/g, "\n");
}

export function detectEol(text) {
  return String(text ?? "").includes("\r\n") ? "\r\n" : "\n";
}

export function applyEol(text, eol) {
  const lf = normalizeLf(text);
  return eol === "\r\n" ? lf.replace(/\n/g, "\r\n") : lf;
}

export function sha256Hex(text) {
  return crypto.createHash("sha256").update(normalizeLf(text), "utf8").digest("hex");
}

export function computeAgentsStats(content) {
  const raw = String(content ?? "");
  const bytes = Buffer.byteLength(raw, "utf8");
  const chars = raw.length;
  const lines = raw.length === 0 ? 0 : normalizeLf(raw).split("\n").length;
  const percent = Number(((bytes / AGENTS_LIMIT_BYTES) * 100).toFixed(1));
  const level = bytes > AGENTS_LIMIT_BYTES ? "over" : percent >= 85 ? "warn" : "ok";
  return {
    bytes,
    limitBytes: AGENTS_LIMIT_BYTES,
    chars,
    lines,
    percent,
    level,
    sha256: sha256Hex(raw)
  };
}

/**
 * 解析 AGENTS.md 的真实目标路径，完整识别符号链接，确保后续写入不破坏链接。
 */
export function resolveAgentsTarget(logicalPath = DEFAULT_AGENTS_PATH) {
  const target = path.resolve(logicalPath || DEFAULT_AGENTS_PATH);
  let exists = false;
  let isSymlink = false;
  let linkTarget = "";
  let realPath = target;
  let brokenSymlink = false;

  try {
    const lstat = fs.lstatSync(target);
    isSymlink = lstat.isSymbolicLink();
    if (isSymlink) {
      try {
        linkTarget = fs.readlinkSync(target);
      } catch {}
      try {
        realPath = fs.realpathSync(target);
        exists = fs.existsSync(realPath);
      } catch {
        // 悬空符号链接：手动解析相对/绝对目标路径
        realPath = linkTarget ? path.resolve(path.dirname(target), linkTarget) : target;
        exists = false;
        brokenSymlink = true;
      }
    } else {
      exists = true;
      realPath = target;
    }
  } catch {
    exists = false;
  }

  return {
    logicalPath: target,
    realPath,
    isSymlink,
    linkTarget,
    exists,
    brokenSymlink
  };
}

export function readAgentsFile(logicalPath = DEFAULT_AGENTS_PATH) {
  const target = resolveAgentsTarget(logicalPath);
  if (!target.exists) {
    return {
      target,
      content: "",
      eol: "\n",
      mtimeMs: 0,
      stats: computeAgentsStats("")
    };
  }
  const raw = fs.readFileSync(target.realPath, "utf8");
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(target.realPath).mtimeMs;
  } catch {}
  return {
    target,
    content: raw,
    eol: detectEol(raw),
    mtimeMs,
    stats: computeAgentsStats(raw)
  };
}

/**
 * 符号链接安全写入：
 * 若 logicalPath 为符号链接，严格写入其 realPath，绝不 rename 覆盖 logicalPath 本身。
 */
export function writeAgentsSafely(logicalPath, nextContent, preferredEol = null) {
  const target = resolveAgentsTarget(logicalPath);
  let eol = preferredEol;
  if (!eol && target.exists) {
    try {
      eol = detectEol(fs.readFileSync(target.realPath, "utf8"));
    } catch {
      eol = "\n";
    }
  }
  const finalText = applyEol(nextContent, eol || "\n");
  const writePath = target.realPath;
  ensureDir(path.dirname(writePath));
  // 直接覆写 realPath 内容（不替换 symlink 文件项，同时保留原文件句柄/硬链接属性）
  fs.writeFileSync(writePath, finalText, "utf8");

  if (target.isSymlink) {
    const check = fs.lstatSync(target.logicalPath);
    if (!check.isSymbolicLink()) {
      throw new Error("Symlink integrity verification failed after write");
    }
  }

  return {
    target: resolveAgentsTarget(target.logicalPath),
    content: finalText,
    eol: detectEol(finalText),
    stats: computeAgentsStats(finalText)
  };
}

/**
 * 轻量零依赖行级 Diff（LCS + 公共前后缀裁剪 + 超长自动降级）
 */
export function computeLineDiff(oldText, newText, options = {}) {
  const contextLines = Number.isInteger(options.contextLines) ? Math.max(0, options.contextLines) : 2;
  const oldLines = normalizeLf(oldText) === "" ? [] : normalizeLf(oldText).split("\n");
  const newLines = normalizeLf(newText) === "" ? [] : normalizeLf(newText).split("\n");

  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start++;
  }
  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (oldEnd >= start && newEnd >= start && oldLines[oldEnd] === newLines[newEnd]) {
    oldEnd--;
    newEnd--;
  }

  const ops = [];
  for (let i = 0; i < start; i++) {
    ops.push({ type: "ctx", oldLine: i + 1, newLine: i + 1, text: oldLines[i] });
  }

  const midOld = oldLines.slice(start, oldEnd + 1);
  const midNew = newLines.slice(start, newEnd + 1);
  const m = midOld.length;
  const n = midNew.length;

  if (m === 0 && n === 0) {
    // identical
  } else if (m * n <= 250000) {
    // 标准 LCS 动态规划
    const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      const row = dp[i];
      const nextRow = dp[i + 1];
      const a = midOld[i];
      for (let j = n - 1; j >= 0; j--) {
        if (a === midNew[j]) row[j] = nextRow[j + 1] + 1;
        else row[j] = nextRow[j] >= row[j + 1] ? nextRow[j] : row[j + 1];
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (midOld[i] === midNew[j]) {
        ops.push({ type: "ctx", oldLine: start + i + 1, newLine: start + j + 1, text: midOld[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.push({ type: "del", oldLine: start + i + 1, newLine: null, text: midOld[i] });
        i++;
      } else {
        ops.push({ type: "add", oldLine: null, newLine: start + j + 1, text: midNew[j] });
        j++;
      }
    }
    while (i < m) {
      ops.push({ type: "del", oldLine: start + i + 1, newLine: null, text: midOld[i] });
      i++;
    }
    while (j < n) {
      ops.push({ type: "add", oldLine: null, newLine: start + j + 1, text: midNew[j] });
      j++;
    }
  } else {
    // 极大文件降级：整块展示差异区间
    for (let i = 0; i < m; i++) {
      ops.push({ type: "del", oldLine: start + i + 1, newLine: null, text: midOld[i] });
    }
    for (let j = 0; j < n; j++) {
      ops.push({ type: "add", oldLine: null, newLine: start + j + 1, text: midNew[j] });
    }
  }

  for (let oi = oldEnd + 1, ni = newEnd + 1; oi < oldLines.length && ni < newLines.length; oi++, ni++) {
    ops.push({ type: "ctx", oldLine: oi + 1, newLine: ni + 1, text: oldLines[oi] });
  }

  let added = 0;
  let removed = 0;
  const changeIndexes = [];
  for (let idx = 0; idx < ops.length; idx++) {
    if (ops[idx].type === "add") {
      added++;
      changeIndexes.push(idx);
    } else if (ops[idx].type === "del") {
      removed++;
      changeIndexes.push(idx);
    }
  }

  if (changeIndexes.length === 0) {
    return {
      changed: false,
      added: 0,
      removed: 0,
      lines: [],
      unifiedSummary: ""
    };
  }

  const keep = new Uint8Array(ops.length);
  for (const idx of changeIndexes) {
    const lo = Math.max(0, idx - contextLines);
    const hi = Math.min(ops.length - 1, idx + contextLines);
    for (let k = lo; k <= hi; k++) keep[k] = 1;
  }

  const lines = [];
  let inGap = false;
  for (let idx = 0; idx < ops.length; idx++) {
    if (keep[idx]) {
      if (inGap && lines.length > 0) {
        lines.push({ type: "sep", oldLine: null, newLine: null, text: "···" });
      }
      lines.push(ops[idx]);
      inGap = false;
    } else {
      inGap = true;
    }
  }

  // 生成紧凑的 unified 文本摘要（供热推给旧会话高亮变动条款）
  const summaryRows = [];
  let charBudget = 0;
  let truncated = false;
  for (const row of lines) {
    const prefix = row.type === "add" ? "+ " : row.type === "del" ? "- " : row.type === "sep" ? "..." : "  ";
    const lineStr = row.type === "sep" ? "..." : `${prefix}${row.text}`;
    if (charBudget + lineStr.length + 1 > MAX_DIFF_SUMMARY_CHARS) {
      truncated = true;
      break;
    }
    summaryRows.push(lineStr);
    charBudget += lineStr.length + 1;
  }
  if (truncated) {
    summaryRows.push("...（其余变更已折叠，请以正文为准）");
  }

  return {
    changed: true,
    added,
    removed,
    lines,
    unifiedSummary: summaryRows.join("\n")
  };
}

function defaultSyncState() {
  return {
    enabled: true,
    latestHash: "",
    latestUpdatedAt: "",
    lastChange: null,
    conversations: {}
  };
}

function getPaths(options = {}) {
  const dataDir = path.resolve(options.dataDir || DEFAULT_DATA_DIR);
  const agentsPath = path.resolve(options.agentsPath || DEFAULT_AGENTS_PATH);
  const brainDir = path.resolve(options.brainDir || DEFAULT_BRAIN_DIR);
  const statePath = path.join(dataDir, "agents-sync-state.json");
  const snapDir = path.join(dataDir, "agents-snapshots");
  const snapIndexPath = path.join(snapDir, "index.json");
  const baselinePath = path.join(snapDir, "_baseline.md");
  return { dataDir, agentsPath, brainDir, statePath, snapDir, snapIndexPath, baselinePath };
}

function pruneConversations(conversations) {
  const entries = Object.entries(conversations || {});
  if (entries.length <= MAX_TRACKED_CONVERSATIONS) return conversations || {};
  entries.sort((a, b) => {
    const ta = Date.parse(a[1]?.syncedAt || "") || 0;
    const tb = Date.parse(b[1]?.syncedAt || "") || 0;
    return tb - ta;
  });
  return Object.fromEntries(entries.slice(0, MAX_TRACKED_CONVERSATIONS));
}

function loadSyncState(paths) {
  const raw = readJsonSafe(paths.statePath, null);
  if (!raw) return defaultSyncState();
  return {
    enabled: raw.enabled !== false,
    latestHash: typeof raw.latestHash === "string" ? raw.latestHash : "",
    latestUpdatedAt: typeof raw.latestUpdatedAt === "string" ? raw.latestUpdatedAt : "",
    lastChange: raw.lastChange && typeof raw.lastChange === "object" ? raw.lastChange : null,
    conversations: raw.conversations && typeof raw.conversations === "object" ? raw.conversations : {}
  };
}

function saveSyncState(paths, state) {
  const next = {
    enabled: state.enabled !== false,
    latestHash: String(state.latestHash || ""),
    latestUpdatedAt: String(state.latestUpdatedAt || ""),
    lastChange: state.lastChange || null,
    conversations: pruneConversations(state.conversations || {})
  };
  atomicWriteJson(paths.statePath, next);
  return next;
}

function loadSnapshotIndex(paths) {
  const raw = readJsonSafe(paths.snapIndexPath, []);
  return Array.isArray(raw) ? raw : [];
}

function saveSnapshotIndex(paths, list) {
  atomicWriteJson(paths.snapIndexPath, list);
}

function sanitizeSnapshotId(id) {
  const clean = String(id || "").trim();
  if (!clean || !/^[a-zA-Z0-9._-]+$/.test(clean) || clean.includes("..")) {
    throw new Error("无效的快照 ID");
  }
  return clean;
}

function createSnapshotInternal(paths, content, { reason = "save", summary = "" } = {}) {
  const text = String(content ?? "");
  const stats = computeAgentsStats(text);
  ensureDir(paths.snapDir);
  const list = loadSnapshotIndex(paths);
  // 若与最近一条快照完全一致则复用，避免重复占位
  if (list.length > 0 && list[0].hash === stats.sha256) {
    return list[0];
  }

  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const id = `snap-${stamp}-${stats.sha256.slice(0, 6)}`;
  const filePath = path.join(paths.snapDir, `${id}.md`);
  atomicWriteText(filePath, text);

  const meta = {
    id,
    createdAt: now.toISOString(),
    hash: stats.sha256,
    bytes: stats.bytes,
    chars: stats.chars,
    lines: stats.lines,
    reason,
    summary: String(summary || "")
  };

  const nextList = [meta, ...list];
  const removed = nextList.slice(MAX_SNAPSHOTS);
  const kept = nextList.slice(0, MAX_SNAPSHOTS);
  saveSnapshotIndex(paths, kept);

  for (const old of removed) {
    try {
      const oldFile = path.join(paths.snapDir, `${sanitizeSnapshotId(old.id)}.md`);
      if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile);
    } catch {}
  }

  return meta;
}

function readBaselineContent(paths) {
  try {
    if (fs.existsSync(paths.baselinePath)) {
      return fs.readFileSync(paths.baselinePath, "utf8");
    }
  } catch {}
  return null;
}

function writeBaselineContent(paths, content) {
  try {
    ensureDir(paths.snapDir);
    atomicWriteText(paths.baselinePath, String(content ?? ""));
  } catch {}
}

function findSnapshotContentByHash(paths, hash) {
  if (!hash) return null;
  const list = loadSnapshotIndex(paths);
  const match = list.find((item) => item.hash === hash);
  if (!match) return null;
  try {
    const filePath = path.join(paths.snapDir, `${sanitizeSnapshotId(match.id)}.md`);
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, "utf8");
  } catch {}
  return null;
}

function detectConversationCreatedAtMs(brainDir, conversationId) {
  if (!conversationId) return null;
  const safeId = path.basename(String(conversationId).trim());
  if (!safeId || safeId !== String(conversationId).trim()) return null;
  const convDir = path.join(brainDir, safeId);
  try {
    if (!fs.existsSync(convDir)) return null;
    const transcript = path.join(convDir, ".system_generated", "logs", "transcript.jsonl");
    if (fs.existsSync(transcript)) {
      const fd = fs.openSync(transcript, "r");
      try {
        const buf = Buffer.alloc(4096);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        const firstLine = buf.subarray(0, n).toString("utf8").split(/\r?\n/)[0];
        if (firstLine) {
          const obj = JSON.parse(firstLine);
          const ts = Date.parse(obj.created_at || obj.timestamp || "");
          if (Number.isFinite(ts)) return ts;
        }
      } catch {
        // fallback to birthtime
      } finally {
        fs.closeSync(fd);
      }
    }
    const st = fs.statSync(convDir);
    if (Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0) return st.birthtimeMs;
    return st.ctimeMs || null;
  } catch {
    return null;
  }
}

/**
 * 同步检查磁盘是否发生过外部编辑（如在外部编辑器中直接改了 AGENTS.md）。
 * 若检测到外部变更，自动为旧 baseline 留存快照并刷新 latestHash 与 lastChange。
 */
function reconcileDiskState(paths) {
  const file = readAgentsFile(paths.agentsPath);
  const state = loadSyncState(paths);
  const currentHash = file.target.exists ? file.stats.sha256 : "";

  if (!file.target.exists) {
    return { file, state };
  }

  if (!state.latestHash) {
    // 首次初始化基线
    state.latestHash = currentHash;
    state.latestUpdatedAt = file.mtimeMs ? new Date(file.mtimeMs).toISOString() : new Date().toISOString();
    writeBaselineContent(paths, file.content);
    saveSyncState(paths, state);
    return { file, state };
  }

  if (state.latestHash !== currentHash) {
    const prevContent = readBaselineContent(paths);
    let diff = { changed: true, added: 0, removed: 0, unifiedSummary: "" };
    if (prevContent !== null) {
      diff = computeLineDiff(prevContent, file.content);
      createSnapshotInternal(paths, prevContent, {
        reason: "external",
        summary: `外部更新前 (+${diff.added} / -${diff.removed} 行)`
      });
    }
    const nowIso = new Date().toISOString();
    state.lastChange = {
      fromHash: state.latestHash,
      toHash: currentHash,
      updatedAt: nowIso,
      added: diff.added,
      removed: diff.removed,
      diffSummary: diff.unifiedSummary,
      source: "external"
    };
    state.latestHash = currentHash;
    state.latestUpdatedAt = nowIso;
    writeBaselineContent(paths, file.content);
    saveSyncState(paths, state);
  } else if (readBaselineContent(paths) === null) {
    writeBaselineContent(paths, file.content);
  }

  return { file, state };
}

export class AgentsSyncStore {
  constructor(options = {}) {
    this.options = options;
    this.paths = getPaths(options);
  }

  getState() {
    const { file, state } = reconcileDiskState(this.paths);
    const snapshots = loadSnapshotIndex(this.paths);
    const currentHash = file.target.exists ? file.stats.sha256 : "";
    const convEntries = Object.entries(state.conversations || {});
    let syncedCount = 0;
    let staleCount = 0;
    const recentConversations = convEntries
      .map(([id, rec]) => {
        const upToDate = Boolean(currentHash && rec?.hash === currentHash);
        if (upToDate) syncedCount++;
        else staleCount++;
        return {
          id,
          shortId: id.slice(0, 8),
          hash: rec?.hash || "",
          shortHash: (rec?.hash || "").slice(0, 8),
          syncedAt: rec?.syncedAt || "",
          source: rec?.source || "",
          upToDate
        };
      })
      .sort((a, b) => (Date.parse(b.syncedAt || "") || 0) - (Date.parse(a.syncedAt || "") || 0))
      .slice(0, 12);

    return {
      ok: true,
      content: file.content,
      eol: file.eol,
      stats: file.stats,
      target: file.target,
      sync: {
        enabled: state.enabled !== false,
        latestHash: state.latestHash,
        shortHash: (state.latestHash || "").slice(0, 8),
        latestUpdatedAt: state.latestUpdatedAt,
        lastChange: state.lastChange
          ? {
              updatedAt: state.lastChange.updatedAt,
              added: state.lastChange.added || 0,
              removed: state.lastChange.removed || 0,
              source: state.lastChange.source || "save"
            }
          : null,
        totalTracked: convEntries.length,
        syncedCount,
        staleCount,
        recentConversations
      },
      snapshots
    };
  }

  setSyncEnabled(enabled) {
    const { state } = reconcileDiskState(this.paths);
    state.enabled = Boolean(enabled);
    saveSyncState(this.paths, state);
    return { enabled: state.enabled };
  }

  previewDiff(draftContent) {
    const { file } = reconcileDiskState(this.paths);
    const diff = computeLineDiff(file.content, String(draftContent ?? ""));
    const stats = computeAgentsStats(applyEol(String(draftContent ?? ""), file.eol));
    return { ok: true, diff, stats };
  }

  saveContent(nextContent) {
    if (typeof nextContent !== "string") {
      throw new Error("文件内容必须为字符串");
    }
    const maxAllowedBytes = 256 * 1024;
    if (Buffer.byteLength(nextContent, "utf8") > maxAllowedBytes) {
      throw new Error("内容过大（超过 256 KB 保护上限）");
    }

    const { file, state } = reconcileDiskState(this.paths);
    const oldContent = file.content;
    const oldHash = file.target.exists ? file.stats.sha256 : "";
    const diff = computeLineDiff(oldContent, nextContent);

    if (file.target.exists && !diff.changed) {
      return {
        ok: true,
        unchanged: true,
        diff,
        state: this.getState()
      };
    }

    let snapshot = null;
    if (file.target.exists) {
      snapshot = createSnapshotInternal(this.paths, oldContent, {
        reason: "save",
        summary: `保存前备份 (+${diff.added} / -${diff.removed} 行)`
      });
    }

    const written = writeAgentsSafely(this.paths.agentsPath, nextContent, file.eol);
    const nowIso = new Date().toISOString();
    state.lastChange = {
      fromHash: oldHash,
      toHash: written.stats.sha256,
      updatedAt: nowIso,
      added: diff.added,
      removed: diff.removed,
      diffSummary: diff.unifiedSummary,
      source: "save"
    };
    state.latestHash = written.stats.sha256;
    state.latestUpdatedAt = nowIso;
    writeBaselineContent(this.paths, written.content);
    saveSyncState(this.paths, state);

    return {
      ok: true,
      unchanged: false,
      snapshot,
      diff,
      state: this.getState()
    };
  }

  getSnapshotDetail(snapshotId) {
    const safeId = sanitizeSnapshotId(snapshotId);
    const list = loadSnapshotIndex(this.paths);
    const meta = list.find((item) => item.id === safeId);
    if (!meta) throw new Error("未找到指定快照");
    const filePath = path.join(this.paths.snapDir, `${safeId}.md`);
    if (!fs.existsSync(filePath)) throw new Error("快照正文文件已丢失");
    const snapshotContent = fs.readFileSync(filePath, "utf8");
    const { file } = reconcileDiskState(this.paths);
    // 展示如果从当前磁盘回滚到该快照，将会产生哪些变更
    const rollbackDiff = computeLineDiff(file.content, snapshotContent);
    return {
      ok: true,
      snapshot: meta,
      content: snapshotContent,
      stats: computeAgentsStats(snapshotContent),
      rollbackDiff
    };
  }

  rollbackSnapshot(snapshotId) {
    const detail = this.getSnapshotDetail(snapshotId);
    const { file, state } = reconcileDiskState(this.paths);
    const diff = computeLineDiff(file.content, detail.content);

    if (file.target.exists && !diff.changed) {
      return {
        ok: true,
        unchanged: true,
        diff,
        state: this.getState()
      };
    }

    let backup = null;
    if (file.target.exists) {
      backup = createSnapshotInternal(this.paths, file.content, {
        reason: "rollback",
        summary: `回滚前备份 (+${diff.added} / -${diff.removed} 行)`
      });
    }

    const written = writeAgentsSafely(this.paths.agentsPath, detail.content, file.eol);
    const nowIso = new Date().toISOString();
    state.lastChange = {
      fromHash: file.target.exists ? file.stats.sha256 : "",
      toHash: written.stats.sha256,
      updatedAt: nowIso,
      added: diff.added,
      removed: diff.removed,
      diffSummary: diff.unifiedSummary,
      source: "rollback",
      rollbackFromId: detail.snapshot.id
    };
    state.latestHash = written.stats.sha256;
    state.latestUpdatedAt = nowIso;
    writeBaselineContent(this.paths, written.content);
    saveSyncState(this.paths, state);

    return {
      ok: true,
      unchanged: false,
      backup,
      rolledBackTo: detail.snapshot,
      diff,
      state: this.getState()
    };
  }

  /**
   * SessionStart 调用：新会话启动时原生已读取最新版 AGENTS.md，
   * 直接登记当前哈希，避免后续 PreInvocation 重复注入。
   */
  registerSessionStart(conversationId) {
    const cid = String(conversationId || "").trim();
    const { file, state } = reconcileDiskState(this.paths);
    if (!cid || !file.target.exists) {
      return { registered: false };
    }
    const nowIso = new Date().toISOString();
    state.conversations[cid] = {
      hash: file.stats.sha256,
      syncedAt: nowIso,
      source: "session_start"
    };
    saveSyncState(this.paths, state);
    return { registered: true, hash: file.stats.sha256 };
  }

  /**
   * PreInvocation 调用：
   * 仅当 AGENTS.md 已更新且当前会话落后于磁盘最新哈希时，单次返回热推 systemMessage 并登记最新哈希。
   * 未更新时返回 { shouldPush: false }（0 Token、不破坏 Prompt Cache）。
   */
  evaluateHotSync(conversationId) {
    const cid = String(conversationId || "").trim();
    if (!cid) return { shouldPush: false, reason: "no_conversation_id" };

    const { file, state } = reconcileDiskState(this.paths);
    if (state.enabled === false) {
      return { shouldPush: false, reason: "disabled" };
    }
    if (!file.target.exists) {
      return { shouldPush: false, reason: "missing_file" };
    }

    const currentHash = file.stats.sha256;
    const rec = state.conversations[cid];

    // 已同步过且版本一致 -> 0 开销静默放行
    if (rec && rec.hash === currentHash) {
      return { shouldPush: false, reason: "up_to_date" };
    }

    // 未曾登记过的会话：判断它是在最近一次变更之前还是之后创建的
    if (!rec) {
      if (!state.lastChange) {
        // 自启用以来尚未发生任何更新，登记基线但不打扰
        state.conversations[cid] = {
          hash: currentHash,
          syncedAt: new Date().toISOString(),
          source: "baseline"
        };
        saveSyncState(this.paths, state);
        return { shouldPush: false, reason: "initial_baseline" };
      }

      const convCreatedMs = detectConversationCreatedAtMs(this.paths.brainDir, cid);
      const updatedMs = Date.parse(state.latestUpdatedAt || "") || 0;
      if (convCreatedMs !== null && updatedMs > 0 && convCreatedMs >= updatedMs) {
        // 新会话原生已加载最新 AGENTS.md，登记基线不重复注入
        state.conversations[cid] = {
          hash: currentHash,
          syncedAt: new Date().toISOString(),
          source: "session_start_inferred"
        };
        saveSyncState(this.paths, state);
        return { shouldPush: false, reason: "newer_than_update" };
      }
    }

    // 落后版本：优先从快照库计算「该会话上次版本 -> 当前最新版」的精准 Diff
    let diffSummary = "";
    let added = 0;
    let removed = 0;
    if (rec?.hash) {
      if (state.lastChange && state.lastChange.fromHash === rec.hash && state.lastChange.toHash === currentHash) {
        diffSummary = state.lastChange.diffSummary || "";
        added = state.lastChange.added || 0;
        removed = state.lastChange.removed || 0;
      } else {
        const oldSnap = findSnapshotContentByHash(this.paths, rec.hash);
        if (oldSnap !== null) {
          const d = computeLineDiff(oldSnap, file.content);
          diffSummary = d.unifiedSummary;
          added = d.added;
          removed = d.removed;
        }
      }
    } else if (state.lastChange && state.lastChange.toHash === currentHash) {
      diffSummary = state.lastChange.diffSummary || "";
      added = state.lastChange.added || 0;
      removed = state.lastChange.removed || 0;
    }

    const updatedAt = (state.latestUpdatedAt || new Date().toISOString()).replace("T", " ").slice(0, 19);
    const shortHash = currentHash.slice(0, 8);
    const sections = [
      `[全局 AGENTS.md 热更新通知 · ${updatedAt} · 版本 ${shortHash}]`,
      `用户的全局规则文件 AGENTS.md 已更新。请从本轮起立即以以下最新版本为准，覆盖本会话启动时旧版 <user_rules> 中的全局规则（无需向用户重复朗读本通知，直接按新规则执行即可）。`
    ];

    if (diffSummary) {
      sections.push(
        `### 本次变更摘要（+${added} / -${removed} 行）\n\`\`\`diff\n${diffSummary}\n\`\`\``
      );
    }

    sections.push(`### 最新全局 AGENTS.md 全文\n${file.content}`);

    state.conversations[cid] = {
      hash: currentHash,
      syncedAt: new Date().toISOString(),
      source: "hot_push"
    };
    saveSyncState(this.paths, state);

    return {
      shouldPush: true,
      reason: rec ? "hash_changed" : "legacy_session_stale",
      hash: currentHash,
      added,
      removed,
      message: sections.join("\n\n")
    };
  }
}

export function registerAgentsSessionStart(conversationId, options = {}) {
  try {
    return new AgentsSyncStore(options).registerSessionStart(conversationId);
  } catch {
    return { registered: false };
  }
}

export function evaluateAgentsHotSync(conversationId, options = {}) {
  try {
    return new AgentsSyncStore(options).evaluateHotSync(conversationId);
  } catch {
    return { shouldPush: false, reason: "error" };
  }
}
