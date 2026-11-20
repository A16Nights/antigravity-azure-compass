#!/usr/bin/env node
import { PresetStore } from "../lib/store.mjs";

async function main() {
  const store = new PresetStore();
  const cfg = store.getConfig();
  if (!cfg.perTurnReinforce) {
    process.stdout.write("{}\n");
    return;
  }
  const active = store.getActivePreset();
  if (!active || !active.anchor) {
    process.stdout.write("{}\n");
    return;
  }
  const output = {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: active.anchor
        }
      }
    ]
  };
  process.stdout.write(JSON.stringify(output) + "\n");
}

main().catch(() => {
  process.stdout.write("{}\n");
});
