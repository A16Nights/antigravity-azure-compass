---
name: agent-presets
description: 苍蓝套件 Agent 预设中心：支持一键切换标准/协奏台省流/极简/只读审查/冷静工程等模式，每轮通过 PreInvocation 注入底层锚点并联动 soul-md 人设卡，内置上下文 Token 水位监测与媒体载荷防装死守卫（PreToolUse 硬拦截 + CHECKPOINT 自动重置）。
---

# 苍蓝罗盘 · Azure Compass（agent-presets）

当用户想切换 Agent 工作模式、打开预设卡片面板、调整上下文与媒体载荷防装死阈值，或管理全局 AGENTS.md 热同步与外接模型防掉线强化时使用。

- 侧栏面板链接：`[苍蓝罗盘](sidecar://agent-presets/presets/)（Antigravity 2.35.1+ 回复含该链接会自动在侧栏展开，仅在用户要求打开控制台时按需输出）`
- 配置文件路径：`~/.gemini/agent-presets/config.json`
- 工作机制：`SessionStart` + `PreInvocation` 负责预设锚点注入、全局 `AGENTS.md` 变更热同步以及上下文 Token / 媒体载荷黄红灯预警；`PreToolUse` 在读取图片/视频/音频/PDF 超过单文件上限或累计红线时即时硬拦截，防止每轮全量重传引发界面无限 `working` 装死（按 `CHECKPOINT` 自动归零）。
