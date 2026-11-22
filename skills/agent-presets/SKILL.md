---
name: agent-presets
description: 仿 DSH 桌面端的 Agent 预设中心：支持一键切换标准/协奏台省流/极简/创造/冷静工程等模式，每轮通过 PreInvocation 注入底层锚点并联动 soul-md 人设卡。
---

# 苍蓝罗盘 · Azure Compass（agent-presets）

当用户想切换 Agent 工作模式、打开预设卡片面板，或调整外接模型的防掉线前置强化时使用。

- 侧栏面板链接：`[苍蓝罗盘](sidecar://agent-presets/presets/)`
- 配置文件路径：`~/.gemini/agent-presets/config.json`
- 工作机制：`SessionStart` + `PreInvocation` 每轮向模型注入当前预设的精简底层锚点；若预设绑定了 `soulCard`，切换时会自动同步 `soul-md` 默认人设卡。
