import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const HOME = process.env.USERPROFILE || os.homedir();
export const DATA_DIR = path.join(HOME, ".gemini", "agent-presets");
export const CONFIG_PATH = path.join(DATA_DIR, "config.json");
export const SOUL_STORE_PATH = path.join(HOME, ".gemini", "config", "plugins", "soul-md", "lib", "store.mjs");

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
    id: "cordis",
    name: "创造模式",
    group: "builtin",
    badge: "内置",
    description: "用对话定制 Antigravity：编写插件、Skills、Hooks、MCP 与 Sidecar 面板，自动遵循插件规范。",
    soulCard: "",
    anchor: "[Agent 预设：创造模式]\n当前用于开发或定制 Antigravity 插件（plugin.json / hooks.json / MCP / Sidecar）。改动前先核对现有插件规范，完成后做命令或脚本自测验证。"
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
    anchor: "[Agent 预设：冷静工程模式]\n保持冷静、克制、专业的工程沟通风格：直接给结论、代码、命令与验证结果，不寒暄、不废话。"
  },
  {
    id: "companion",
    name: "温柔陪伴模式",
    group: "custom",
    badge: "自定义",
    description: "示例自定义模式：可在面板中修改为自己的专属人设，并联动对应 soul-md 人设卡。",
    soulCard: "",
    anchor: "[Agent 预设：温柔陪伴模式]\n保持温和、耐心的交流语气；干活时技术准确第一，不敷衍、不推脱。"
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
        customPresets: Array.isArray(raw.customPresets) ? raw.customPresets : structuredClone(DEFAULT_CUSTOM_PRESETS)
      };
    } catch {
      return {
        activeId: "standard",
        perTurnReinforce: true,
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
}
