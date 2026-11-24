#!/usr/bin/env node
// agent-presets · Stop Hook（上下文监测执行端）
// 职责：
//  1) 结算上一轮 /compact：pendingAt 满 SETTLE_MS 后校验 transcript 是否出现新 CHECKPOINT，成功清理状态，失败累加熔断计数
//  2) 增量沉淀：需要压缩时把新增对话提炼写入蓝汐（runCompactPipeline）
//  3) 自动派发 /compact：严格满足 needCompact && 无 pending && 未熔断 && 冷却已过 时才派发，防止重复触发
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PresetStore, BRAIN_DIR, loadSentinelSignal, patchSentinelSignal } from "../lib/store.mjs";
import { runCompactPipeline } from "../lib/compactor.mjs";
import { dispatchSlashCommand } from "../lib/ls-client.mjs";

export const SETTLE_MS = 90000;

function resolveTranscriptPath(conversationId, options = {}) {
  const convId = String(conversationId || "").trim();
  if (!convId) return "";
  const brainDir = options.brainDir || BRAIN_DIR;
  return path.join(brainDir, convId, ".system_generated", "logs", "transcript.jsonl");
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data.trim()));
    process.stdin.on("error", () => resolve(""));
  });
}

/**
 * Stop Hook 主逻辑（导出以便单测）
 * payload: { conversationId, continuationActive, terminationReason }
 * options: { dataDir, store, settleMs, now, transcriptPath, dispatch, runPipeline, daemonDir }
 */
export async function handleStopHook(payload = {}, options = {}) {
  const store = options.store || new PresetStore();
  const dataDir = options.dataDir;
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const settleMs = Number.isFinite(options.settleMs) ? Number(options.settleMs) : SETTLE_MS;

  // 用户主动中止 / 会话仍在继续时不处理，避免打断或重复压缩
  if (payload.continuationActive) return { skipped: "continuation_active" };
  if (String(payload.terminationReason || "") === "USER_CANCELED") return { skipped: "user_canceled" };

  const cfg = store.getConfig();
  const sentinelCfg = cfg.sentinel || {};
  if (!sentinelCfg.enabled) return { skipped: "sentinel_disabled" };

  const conversationId = String(payload.conversationId || payload.conversation_id || "").trim();
  const sig = loadSentinelSignal(dataDir);
  const transcriptPath =
    options.transcriptPath || resolveTranscriptPath(conversationId || sig.conversationId);

  let signal = { ...sig };
  if (conversationId && signal.conversationId && signal.conversationId !== conversationId) {
    // 切换到新会话时自动解除旧会话遗留的熔断与待压缩状态
    signal = patchSentinelSignal(
      {
        conversationId,
        needCompact: false,
        warnedLevel: "none",
        warnedTurnKey: null,
        pendingAt: 0,
        pendingLineCount: 0,
        lastAttemptAt: 0,
        failCount: 0,
        lastError: "",
        lastPercent: 0,
        lastTokens: 0,
        lastExtractedLine: 0
      },
      dataDir
    );
  } else if (conversationId && !signal.conversationId) {
    signal = patchSentinelSignal({ conversationId }, dataDir);
  }
  const activeConvId = conversationId || signal.conversationId || "";

  const maxRetries = Math.max(1, Number(sentinelCfg.maxRetries) || 3);
  const cooldownMs = Math.max(10000, Number(sentinelCfg.cooldownMs) || 300000);
  const commandName = String(sentinelCfg.commandName || "compact").replace(/^\/+/, "") || "compact";
  const result = { action: "none" };

  // ---------- 1) 结算上一轮 pending ----------
  if (signal.pendingAt) {
    const elapsed = now - Number(signal.pendingAt);
    if (elapsed < settleMs) {
      return { skipped: "settling", pendingAt: signal.pendingAt, elapsed };
    }
    const compacted = store.hasCheckpointAfterLine(transcriptPath, signal.pendingLineCount || 0);
    if (compacted) {
      signal = patchSentinelSignal(
        {
          needCompact: false,
          pendingAt: 0,
          pendingLineCount: 0,
          failCount: 0,
          lastError: "",
          compactedAt: new Date(now).toISOString()
        },
        dataDir
      );
      result.action = "compacted";
    } else {
      const failCount = Math.max(0, Number(signal.failCount) || 0) + 1;
      signal = patchSentinelSignal(
        {
          pendingAt: 0,
          pendingLineCount: 0,
          failCount,
          lastError: "checkpoint_not_found"
        },
        dataDir
      );
      result.action = "settle_failed";
      result.failCount = failCount;
    }
  }

  const levelCritical = Number(signal.lastPercent) >= Number(sentinelCfg.criticalPercent || 72);
  const needCompact = Boolean(signal.needCompact) || levelCritical;

  // ---------- 2) 增量沉淀入蓝汐 ----------
  if (needCompact && sentinelCfg.autoExtractToLingshu !== false) {
    try {
      const pipeline = options.runPipeline || runCompactPipeline;
      const extracted = await pipeline(
        {
          conversationId: activeConvId,
          transcriptPath,
          lastExtractedLine: Number(signal.lastExtractedLine) || 0
        },
        { dataDir, store }
      );
      if (extracted && extracted.ok && extracted.lastExtractedAt) {
        signal = patchSentinelSignal(
          {
            lastExtractedLine: extracted.lastExtractedLine || 0,
            lastExtractedAt: extracted.lastExtractedAt
          },
          dataDir
        );
      }
      result.extract = extracted
        ? { ok: extracted.ok, skipped: extracted.skipped || "", source: extracted.summarySource || "" }
        : { ok: false };
    } catch (err) {
      result.extract = { ok: false, error: String(err?.message || err) };
    }
  }

  // ---------- 3) 自动派发 /compact ----------
  const failCount = Math.max(0, Number(signal.failCount) || 0);
  const breakerOpen = failCount >= maxRetries;
  const lastAttemptMs = Number(signal.lastAttemptAt) || 0;
  const cooldownPassed = !lastAttemptMs || now - lastAttemptMs >= cooldownMs;

  if (
    sentinelCfg.autoCompactEnabled &&
    needCompact &&
    !signal.pendingAt &&
    !breakerOpen &&
    cooldownPassed &&
    activeConvId
  ) {
    const lineCount = store.getTranscriptLineCount(transcriptPath);
    signal = patchSentinelSignal(
      {
        conversationId: activeConvId,
        pendingAt: now,
        lastAttemptAt: now,
        pendingLineCount: lineCount
      },
      dataDir
    );
    const dispatch = options.dispatch || dispatchSlashCommand;
    let dispatchRes;
    try {
      dispatchRes = await dispatch({
        cascadeId: activeConvId,
        commandName,
        daemonDir: options.daemonDir,
        preferredPort: Number(signal.dispatchPort) || 0,
        timeoutMs: 20000
      });
    } catch (err) {
      dispatchRes = { ok: false, error: String(err?.message || err) };
    }
    if (dispatchRes && dispatchRes.ok) {
      signal = patchSentinelSignal(
        { dispatchPort: Number(dispatchRes.port) || 0, lastError: "" },
        dataDir
      );
      result.action = "compacted_dispatch";
      result.port = dispatchRes.port;
    } else {
      const nextFail = failCount + 1;
      signal = patchSentinelSignal(
        {
          pendingAt: 0,
          pendingLineCount: 0,
          failCount: nextFail,
          lastError: String(dispatchRes?.error || "dispatch_failed").slice(0, 200)
        },
        dataDir
      );
      result.action = "dispatch_failed";
      result.failCount = nextFail;
      result.error = dispatchRes?.error || "dispatch_failed";
    }
  } else if (signal.needCompact && breakerOpen) {
    result.breakerOpen = true;
    result.failCount = failCount;
  }

  return result;
}

async function main() {
  const raw = await readStdin();
  let payload = {};
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      // ignore
    }
  }
  try {
    await handleStopHook(payload);
  } catch {
    // 任何异常都不阻塞宿主，静默输出空对象
  }
  process.stdout.write("{}\n");
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
    process.stdout.write("{}\n");
  });
}
