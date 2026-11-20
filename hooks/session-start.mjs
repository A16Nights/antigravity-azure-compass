#!/usr/bin/env node
import { PresetStore } from "../lib/store.mjs";

async function main() {
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
