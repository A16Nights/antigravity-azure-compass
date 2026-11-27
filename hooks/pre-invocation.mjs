#!/usr/bin/env node
// agent-presets · PreInvocation Hook
// 1) 每轮前置强化：同一用户轮次只注入一次预设锚点（回合级去重，修宿主不传 invocationNum 时反复注入的坑）
// 2) 上下文监测预警：仅在首次达到 warn/critical 或等级升级时注入提示，避免每步刷屏
// 3) 红线自动压缩：达到 critical 且开启 autoCompactEnabled 时写信号，交给 Stop hook 真正派发 /compact
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  PresetStore,
  evaluateTurnDedup,
  loadSentinelSignal,
  patchSentinelSignal
} from "../lib/store.mjs";
import { evaluateAgentsHotSync } from "../lib/agents-sync.mjs";
import { isExternalModel } from "../lib/external-model-guard.mjs";
import { formatMb, summarizeMediaCounts } from "../lib/media-guard.mjs";
import { buildPostCompactRehydration } from "../lib/transcript-telemetry.mjs";

const LEVEL_RANK = { none: 0, ok: 0, warn: 1, critical: 2 };

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data.trim()));
    process.stdin.on("error", () => resolve(""));
  });
}

function sha256Short(text) {
  try {
    return crypto.createHash("sha256").update(String(text ?? "")).digest("hex").slice(0, 16);
  } catch {
    return "";
  }
}

function normalizeTurnKey(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || typeof value === "object") return null;
  const text = String(value).trim();
  if (!text) return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : text;
}

/**
 * 纯函数：判断本轮是否需要注入监测预警文本。
 * 规则：首次达到 warn/critical 注入；等级升级（none->warn / warn->critical）注入；其余跳过。
 */
export function shouldEmitSentinelWarning(signal, { conversationId, userTurnKey, level }) {
  const rank = LEVEL_RANK[level] ?? 0;
  if (rank <= 0) return { emit: false, reason: "below_warn" };
  const sig = signal && typeof signal === "object" ? signal : {};
  const sameConversation = String(sig.conversationId || "") === String(conversationId || "");
  if (!sameConversation) return { emit: true, reason: "new_conversation" };
  const lastLevel = LEVEL_RANK[sig.warnedLevel] ?? 0;
  if (rank > lastLevel) {
    return { emit: true, reason: lastLevel === 0 ? "first_reach" : "level_upgraded" };
  }
  const sameTurn = normalizeTurnKey(sig.warnedTurnKey ?? null) === userTurnKey && userTurnKey !== null;
  if (!sameTurn) return { emit: true, reason: "new_turn" };
  return { emit: false, reason: "same_turn_already_warned" };
}

export async function handlePreInvocation(input = {}, options = {}) {
  const store = options.store || new PresetStore();
  const dataDir = options.dataDir;
  const cfg = store.getConfig();
  const parts = [];

  const conversationId = String(input.conversationId || input.conversation_id || "").trim();
  const userTurnKey = normalizeTurnKey(input.initialNumSteps ?? input.initial_num_steps ?? null);
  const invocationNum = normalizeTurnKey(input.invocationNum ?? input.invocation_num ?? null);

  // ---------- 0) 全局 AGENTS.md 热更新（所有模型生效，变更单次热推，未变 0 开销） ----------
  if (conversationId) {
    const agentsSync = evaluateAgentsHotSync(conversationId, {
      agentsPath: options.agentsPath,
      dataDir,
      brainDir: options.brainDir
    });
    if (agentsSync.shouldPush && agentsSync.message) {
      parts.push(agentsSync.message);
    }
  }

  // ---------- 1) 预设锚点（仅对外接模型生效 + 回合级去重） ----------
  if (cfg.perTurnReinforce && isExternalModel(input, { customModelsPath: options.customModelsPath })) {
    const active = store.getActivePreset();
    if (active && active.anchor) {
      const fingerprint = `preset:${active.id}|${sha256Short(active.anchor)}`;
      const decision = evaluateTurnDedup(
        { conversationId, userTurnKey, invocationNum, fingerprint },
        dataDir
      );
      if (!decision.skip) {
        parts.push(active.anchor);
      }
    }
  }

  // ---------- 2) 上下文监测 ----------
  if (cfg.sentinel && cfg.sentinel.enabled) {
    // 切换到新会话时自动解除旧会话遗留的熔断与待压缩状态
    if (conversationId) {
      const prevSig = loadSentinelSignal(dataDir);
      if (prevSig.conversationId && prevSig.conversationId !== conversationId) {
        patchSentinelSignal(
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
            lastExtractedLine: 0,
            lastExtractedBullets: [],
            rehydratedCheckpoint: "",
            mediaWarnedLevel: "none",
            mediaWarnedTurnKey: null
          },
          dataDir
        );
      }
    }

    const status = store.inspectLatestSession(conversationId);

    // ---------- 2.1) /compact 后自动无损回注（仅压缩后第一轮触发一次，不重复污染前缀） ----------
    if (
      status.found &&
      status.compacted &&
      status.checkpointMarker &&
      cfg.sentinel.autoRehydrateAfterCompact !== false &&
      conversationId
    ) {
      const curSig = loadSentinelSignal(dataDir);
      const sameConv = !curSig.conversationId || curSig.conversationId === conversationId;
      const alreadyRehydrated =
        sameConv && String(curSig.rehydratedCheckpoint || "") === String(status.checkpointMarker);
      // 仅在压缩后刚开始续聊（CHECKPOINT 之后尚未产生多轮回复，<=1 轮）时注入，避免首次打开历史已压缩老会话时误触发
      const isFreshAfterCompact = Number(status.plannerTurnsAfterCheckpoint || 0) <= 1;
      if (!alreadyRehydrated && isFreshAfterCompact) {
        const rehydrationText = buildPostCompactRehydration(status.transcriptPath, {
          lastBullets: sameConv ? curSig.lastExtractedBullets || [] : [],
          lastExtractedAt: sameConv ? curSig.lastExtractedAt || "" : ""
        });
        if (rehydrationText) {
          parts.push(rehydrationText);
        }
        patchSentinelSignal(
          {
            conversationId,
            rehydratedCheckpoint: status.checkpointMarker
          },
          dataDir
        );
      } else if (!alreadyRehydrated) {
        // 老会话此前早已压缩并继续聊了很多轮，直接标记已同步，避免后续反复判断
        patchSentinelSignal(
          {
            conversationId,
            rehydratedCheckpoint: status.checkpointMarker
          },
          dataDir
        );
      }
    }

    if (status.found && (status.level === "critical" || status.level === "warn")) {
      const signal = loadSentinelSignal(dataDir);
      const gate = shouldEmitSentinelWarning(signal, {
        conversationId,
        userTurnKey,
        level: status.level
      });

      if (gate.emit) {
        const k = Math.round(status.estimatedTokens / 1000);
        const winK = Math.round((status.contextWindowTokens || 200000) / 1000);
        const srcTag = status.tokenSource === "api" ? "实测" : "估算约";
        const cacheTag =
          typeof status.cacheHitRate === "number" ? `，缓存命中 ${status.cacheHitRate}%` : "";
        if (status.level === "critical") {
          parts.push(
            `[上下文监测 · 红线预警] 当前会话${srcTag} ${k}k / ${winK}k tokens（${status.percent}%${cacheTag}），已逼近原生自动压缩红线。请在回复末尾主动提醒用户：现在适合立刻执行 /compact 安全压缩，或将关键进度存入蓝汐后新开会话，避免触发原生黑盒压缩导致失忆。`
          );
        } else {
          parts.push(
            `[上下文监测 · 预警] 当前会话${srcTag} ${k}k / ${winK}k tokens（${status.percent}%${cacheTag}）。若本轮刚好完成一个独立阶段，请在回复末尾顺带提醒用户可以执行 /compact 做一次主动压缩。`
          );
        }
        patchSentinelSignal(
          {
            conversationId,
            warnedLevel: status.level,
            warnedTurnKey: userTurnKey,
            lastPercent: status.percent,
            lastTokens: status.estimatedTokens
          },
          dataDir
        );
      }

      // ---------- 3) 红线自动压缩标记 ----------
      if (status.level === "critical") {
        const cur = loadSentinelSignal(dataDir);
        if (
          cfg.sentinel.autoCompactEnabled &&
          !cur.needCompact &&
          (!cur.conversationId || cur.conversationId === conversationId)
        ) {
          patchSentinelSignal(
            {
              conversationId,
              needCompact: true,
              lastPercent: status.percent,
              lastTokens: status.estimatedTokens
            },
            dataDir
          );
        }
      }
    } else if (status.found && conversationId) {
      // 水位已回落到 warn 以下（如手动 /compact 生效）且非结算期：清理待压缩标记与历史失败熔断
      const cur = loadSentinelSignal(dataDir);
      const sameConv = !cur.conversationId || cur.conversationId === conversationId;
      const needsReset =
        Boolean(cur.needCompact) ||
        Number(cur.failCount) > 0 ||
        Boolean(cur.lastError) ||
        Boolean(cur.warnedLevel && cur.warnedLevel !== "none") ||
        Number(cur.lastPercent) >= Number(cfg.sentinel.warnPercent || 55);
      if (sameConv && !cur.pendingAt && needsReset) {
        patchSentinelSignal(
          {
            conversationId,
            needCompact: false,
            warnedLevel: "none",
            failCount: 0,
            lastError: "",
            lastAttemptAt: 0,
            lastPercent: status.percent,
            lastTokens: status.estimatedTokens
          },
          dataDir
        );
      }
    }

    // ---------- 2.5) 媒体载荷水位监测（防大媒体每轮全量重传装死） ----------
    const mediaStatus = status.found ? status.media : null;
    if (cfg.sentinel.mediaGuard?.enabled !== false && mediaStatus && mediaStatus.found) {
      const mLevel = mediaStatus.level || "ok";
      const curSig = loadSentinelSignal(dataDir);
      if (mLevel === "critical" || mLevel === "warn") {
        const mediaGate = shouldEmitSentinelWarning(
          {
            conversationId: curSig.conversationId,
            warnedLevel: curSig.mediaWarnedLevel || "none",
            warnedTurnKey: curSig.mediaWarnedTurnKey ?? null
          },
          { conversationId, userTurnKey, level: mLevel }
        );
        if (mediaGate.emit) {
          const mbText = formatMb(mediaStatus.totalBytes);
          const breakdown = summarizeMediaCounts(mediaStatus.counts);
          const detail = breakdown ? `（${breakdown}）` : "";
          if (mLevel === "critical") {
            parts.push(
              `[上下文监测 · 媒体载荷红灯] 当前会话自上次 CHECKPOINT 以来已累计二进制媒体 ${mbText} MB（${mediaStatus.fileCount} 个文件${detail}），已达到防装死红线 ${mediaStatus.blockMb} MB！请在回复末尾立即提醒用户：切勿在当前老对话中途切换模型（会触发冷重传），请立刻执行 /compact 清理历史媒体或新开会话；后续读图/视频请改派独立子代理隔离。`
            );
          } else {
            parts.push(
              `[上下文监测 · 媒体载荷黄灯] 当前会话自上次 CHECKPOINT 以来已累计二进制媒体 ${mbText} MB（${mediaStatus.fileCount} 个文件${detail}），接近防装死红线 ${mediaStatus.blockMb} MB。后续看图/看视频请优先派独立子代理（invoke_subagent）只返回文字结论，并提醒用户避免带大量媒体中途切换模型。`
            );
          }
          patchSentinelSignal(
            {
              conversationId,
              mediaWarnedLevel: mLevel,
              mediaWarnedTurnKey: userTurnKey
            },
            dataDir
          );
        }
      } else if (
        conversationId &&
        (!curSig.conversationId || curSig.conversationId === conversationId) &&
        curSig.mediaWarnedLevel &&
        curSig.mediaWarnedLevel !== "none"
      ) {
        patchSentinelSignal(
          {
            conversationId,
            mediaWarnedLevel: "none",
            mediaWarnedTurnKey: null
          },
          dataDir
        );
      }
    }
  }

  if (parts.length === 0) {
    return {};
  }

  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: parts.join("\n\n")
        }
      }
    ]
  };
}

async function main() {
  const raw = await readStdin();
  let input = {};
  if (raw) {
    try {
      input = JSON.parse(raw);
    } catch {
      // ignore
    }
  }
  const output = await handlePreInvocation(input);
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
    process.stdout.write("{}\n");
  });
}
