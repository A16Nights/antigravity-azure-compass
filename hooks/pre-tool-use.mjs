#!/usr/bin/env node
// agent-presets · PreToolUse Hook（媒体载荷防装死守卫）
// 仅在 read_file / view_file / Read 读取二进制媒体文件（图片/视频/音频/PDF）时介入，
// 对所有代码、文本、日志与命令工具 0 开销秒放行。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PresetStore, BRAIN_DIR } from "../lib/store.mjs";
import { evaluateMediaRead, isMediaExtension } from "../lib/media-guard.mjs";

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data.trim()));
    process.stdin.on("error", () => resolve(""));
  });
}

function resolveTranscriptPath(conversationId, brainDir = BRAIN_DIR) {
  const convId = String(conversationId || "").trim();
  if (convId) {
    const candidate = path.join(brainDir, convId, ".system_generated", "logs", "transcript.jsonl");
    if (fs.existsSync(candidate)) return candidate;
  }
  return "";
}

function extractToolInfo(payload = {}) {
  let isClaudeFormat = false;
  let toolName = "";
  let args = {};

  if (payload.toolCall && typeof payload.toolCall === "object") {
    toolName = String(payload.toolCall.name || "");
    args = payload.toolCall.args && typeof payload.toolCall.args === "object" ? payload.toolCall.args : {};
  } else if (payload.hook_event_name === "PreToolUse" || typeof payload.tool_name === "string") {
    isClaudeFormat = true;
    toolName = String(payload.tool_name || "");
    args = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  }

  const filePath =
    args.Path ||
    args.path ||
    args.filePath ||
    args.file_path ||
    args.AbsolutePath ||
    args.absolutePath ||
    "";

  const conversationId = String(
    payload.conversationId ||
      payload.conversation_id ||
      payload.common?.conversationId ||
      payload.common?.conversation_id ||
      payload.sessionId ||
      payload.session_id ||
      ""
  ).trim();

  return {
    isClaudeFormat,
    toolName,
    filePath: String(filePath || "").trim(),
    conversationId,
    cwd: String(payload.cwd || process.cwd())
  };
}

export function formatVerdict(verdict, isClaudeFormat = false) {
  if (isClaudeFormat) {
    if (verdict.decision === "deny") {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: verdict.reason || "Blocked by Azure Compass media guard."
        }
      };
    }
    return {};
  }
  if (verdict.decision === "deny") {
    return { decision: "deny", reason: verdict.reason || "Blocked by Azure Compass media guard." };
  }
  return { decision: "allow" };
}

export function handlePreToolUse(payload = {}, options = {}) {
  const info = extractToolInfo(payload);
  const isReadTool = info.toolName === "read_file" || info.toolName === "view_file" || info.toolName === "Read";
  if (!isReadTool || !info.filePath || !isMediaExtension(info.filePath)) {
    return formatVerdict({ decision: "allow" }, info.isClaudeFormat);
  }

  const store = options.store || new PresetStore();
  const cfg = store.getConfig();
  const sentinelEnabled = cfg.sentinel?.enabled !== false;
  if (!sentinelEnabled) {
    return formatVerdict({ decision: "allow" }, info.isClaudeFormat);
  }

  const transcriptPath =
    options.transcriptPath || resolveTranscriptPath(info.conversationId, options.brainDir || BRAIN_DIR);

  const verdict = evaluateMediaRead({
    filePath: info.filePath,
    cwd: info.cwd,
    transcriptPath,
    mediaGuardConfig: cfg.sentinel?.mediaGuard
  });
  return formatVerdict(verdict, info.isClaudeFormat);
}

async function main() {
  const raw = await readStdin();
  if (!raw) {
    process.stdout.write(JSON.stringify({ decision: "allow" }) + "\n");
    return;
  }
  let payload = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stdout.write(JSON.stringify({ decision: "allow" }) + "\n");
    return;
  }
  const output = handlePreToolUse(payload);
  process.stdout.write(JSON.stringify(output) + "\n");
}

const isDirectRun = (() => {
  try {
    if (!process.argv[1]) return false;
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch(() => {
    process.stdout.write(JSON.stringify({ decision: "allow" }) + "\n");
  });
}
