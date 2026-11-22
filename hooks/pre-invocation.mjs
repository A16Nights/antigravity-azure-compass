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
import { isExternalModel } from "../lib/external-model-guard.mjs";

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
    const status = store.inspectLatestSession(conversationId);
    if (status.found && (status.level === "critical" || status.level === "warn")) {
      const signal = loadSentinelSignal(dataDir);
      const gate = shouldEmitSentinelWarning(signal, {
        conversationId,
        userTurnKey,
        level: status.level
      });

      if (gate.emit) {
        const k = Math.round(status.estimatedTokens / 1000);
        if (status.level === "critical") {
          parts.push(
            `[上下文监测 · 红线预警] 当前会话估算约 ${k}k tokens（${status.percent}%），已逼近原生自动压缩红线。请在回复末尾主动提醒用户：现在适合立刻执行 /compact 安全压缩，或将关键进度存入蓝汐后新开会话，避免触发原生黑盒压缩导致失忆。`
          );
        } else {
          parts.push(
            `[上下文监测 · 预警] 当前会话估算约 ${k}k tokens（${status.percent}%）。若本轮刚好完成一个独立阶段，请在回复末尾顺带提醒用户可以执行 /compact 做一次主动压缩。`
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
      // 压缩已生效（水位回落到 warn 以下）时清掉历史标记，避免 Stop hook 反复派发
      const cur = loadSentinelSignal(dataDir);
      if (cur.needCompact && !cur.pendingAt && cur.conversationId === conversationId) {
        patchSentinelSignal({ needCompact: false, warnedLevel: "none" }, dataDir);
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
