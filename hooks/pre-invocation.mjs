#!/usr/bin/env node
import { PresetStore } from "../lib/store.mjs";

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data.trim()));
    process.stdin.on("error", () => resolve(""));
  });
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

  const store = new PresetStore();
  const cfg = store.getConfig();
  const parts = [];

  if (cfg.perTurnReinforce) {
    const active = store.getActivePreset();
    if (active && active.anchor) {
      parts.push(active.anchor);
    }
  }

  if (cfg.sentinel && cfg.sentinel.enabled) {
    const convId = input.conversationId || input.conversation_id || "";
    const status = store.inspectLatestSession(convId);
    if (status.found && status.level === "critical") {
      const k = Math.round(status.estimatedTokens / 1000);
      parts.push(
        `[上下文哨兵 · 红线预警] 当前会话估算约 ${k}k tokens（${status.percent}%），已逼近原生自动压缩红线。请在回复末尾主动提醒用户：现在适合立刻执行 /compact 安全压缩，或将关键进度存入蓝汐后新开会话，避免触发原生黑盒压缩导致失忆。`
      );
    } else if (status.found && status.level === "warn") {
      const k = Math.round(status.estimatedTokens / 1000);
      parts.push(
        `[上下文哨兵 · 预警] 当前会话估算约 ${k}k tokens（${status.percent}%）。若本轮刚好完成一个独立阶段，请在回复末尾顺带提醒用户可以执行 /compact 做一次主动压缩。`
      );
    }
  }

  if (parts.length === 0) {
    process.stdout.write("{}\n");
    return;
  }

  const output = {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: parts.join("\n\n")
        }
      }
    ]
  };
  process.stdout.write(JSON.stringify(output) + "\n");
}

main().catch(() => {
  process.stdout.write("{}\n");
});
