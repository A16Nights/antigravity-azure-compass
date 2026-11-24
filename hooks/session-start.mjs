#!/usr/bin/env node
import { PresetStore } from "../lib/store.mjs";
import { registerAgentsSessionStart } from "../lib/agents-sync.mjs";

function readStdin(timeoutMs = 500) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(data.trim());
    };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

async function main() {
  const raw = await readStdin();
  let input = {};
  if (raw) {
    try {
      input = JSON.parse(raw);
    } catch {}
  }
  const conversationId = String(input.conversationId || input.conversation_id || "").trim();
  if (conversationId) {
    registerAgentsSessionStart(conversationId);
  }

  const store = new PresetStore();
  const active = store.getActivePreset();
  if (!active || !active.anchor) {
    process.stdout.write("{}\n");
    return;
  }
  const output = {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: `[Agent 预设已加载：${active.name} (${active.id})]\n${active.anchor}`
        }
      }
    ]
  };
  process.stdout.write(JSON.stringify(output) + "\n");
}

main().catch(() => {
  process.stdout.write("{}\n");
});
