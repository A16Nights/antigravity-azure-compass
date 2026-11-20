# 苍蓝罗盘 · Azure Compass (`antigravity-azure-compass`)

仿 DSH 桌面端的 **Google Antigravity** Agent 预设中心插件：提供多套工作模式预设，通过 `SessionStart` + `PreInvocation` 钩子每轮前置注入精简底层锚点，专治长会话与外接 API 模型（如苍蓝星轨挂载模型）掉人设、忘规则问题，并自动联动 [antigravity-soul-md](https://github.com/A16Nights/antigravity-soul-md) 人设卡。

## 核心特性

- **内置 4 套模式**：
  - `standard`（标准模式）：日常编码、文件与资料处理
  - `orchestrator`（协奏台省流模式）：强约束优先派单给 `external-orchestrator` 执行重活
  - `minimal`（极简模式）：最少工具调用、最短直接响应
  - `cordis`（创造模式）：开发定制 Antigravity 插件、Skills、Hooks 与 Sidecar
- **自定义预设 + 人设联动**：支持在侧栏卡片面板一键新建/编辑/删除自定义预设，绑定 `soul-md` 人设卡后切换模式自动同步切换人设。
- **双通道防掉线**：`SessionStart` 开局声明 + `PreInvocation` 每轮前置强化（可一键开关），有效防止长上下文与外接模型指令漂移。
- **零外部依赖**：纯 Node.js 原生模块实现。

## 安装方式

将本仓库克隆或复制到 Antigravity 全局插件目录：

```bash
git clone https://github.com/A16Nights/antigravity-azure-compass.git ~/.gemini/config/plugins/agent-presets
```

在 Antigravity 中按 `Ctrl+R` 重载，启用 **苍蓝罗盘** 插件即可在侧栏打开卡片面板。

## 配置文件

用户配置保存在 `~/.gemini/agent-presets/config.json`，可直接在面板右上角点击「打开配置文件」编辑。

## License

MIT
