# 苍蓝罗盘 · Azure Compass (`antigravity-azure-compass`)

面向 **Google Antigravity** 的 Agent 工作模式预设中心、上下文水位实时监测与苍蓝套件全局入口管理插件。

通过 **静态规则（`rules/AGENTS.md`）+ 生命周期钩子（`SessionStart` + `PreInvocation`）+ 可视化侧栏面板（Sidecar + 独立 Web UI）**，为不同开发场景提供一键切换的 Agent 行为模式，精准解决长会话或外接 API 模型（如苍蓝星轨挂载模型）指令漂移、掉人设问题，并与 **[苍蓝魂匣（Soul.md）](https://github.com/A16Nights/antigravity-soul-md)**、**[蓝汐（Lanxi Memory）](https://github.com/A16Nights/antigravity-lanxi-memory)** 及 Antigravity 原生 `/compact` 深度联动。

---

## ✨ 功能全景

### 1. 内置 4 套核心工作模式预设
- **`standard`（标准模式）**：均衡的日常软件工程、文件读写、命令执行与资料整理模式。
- **`orchestrator`（协奏台省流模式）**：强约束主脑专注轻量规划与最终抽查验收，将多文件检索、>15 行代码编写、长日志排查与文本生成优先委派给 **[苍蓝协奏台](https://github.com/A16Nights/antigravity-external-orchestrator)** 中的高性价比外部模型执行。
- **`minimal`（极简模式）**：最小化工具调用轮次与解释篇幅，直奔结论与核心代码。
- **`review`（只读审查模式）**：专注代码走查、架构评估、安全审计与 Bug 定位，硬性约束禁止修改或覆写业务文件。

### 2. 自定义预设管理（新建 / 编辑 / 删除）
- 在「自定义」区域末尾点击 **`＋ 新建预设`** 虚线卡片即可创建专属工作模式：
  - 自定义 **预设 ID**、**显示名称**、**一句话简介**；
  - 编写 **完整静态规则正文**（切换模式时自动原子写入 `rules/AGENTS.md`）与 **每轮前置核心锚点（Anchor）**；
  - **联动 Soul.md 人设卡**：可为每个预设绑定一张 `soul-md` 人设卡，切换工作模式时自动同步切换全局生效人设卡；
  - 支持随时编辑已有自定义预设，或通过面板内毛玻璃确认弹窗安全删除（若删除当前生效预设，自动平滑切回 `standard`）。

### 3. 外接模型智能识别与双通道防掉线
- **`SessionStart` 开场锚定**：新会话启动时注入当前生效模式的核心行为边界。
- **`PreInvocation` 每轮前置强化（外接模型智能守卫）**：
  - 内置 `external-model-guard` 检测器，**仅在当前主模型为外接自定义模型时注入每轮强化锚点**；
  - 使用 Antigravity 内置原生模型时自动跳过每轮注入，零额外 Token 损耗；
  - 支持在面板顶栏一键开关每轮强化。

### 4. 上下文监测与自动 `/compact` 压缩联动
- **实时水位估算**：读取当前活跃会话的 `transcript.jsonl`，实时计算上下文 Token 占用百分比、累计步数与最近压缩断点（`CHECKPOINT`）。
- **两级阈值预警**：
  - **阶段提醒线（默认 55%）**：提示可在阶段性任务完成后主动整理上下文；
  - **红线强提醒（默认 72%）**：抢在宿主黑盒硬截断前发出高优先级预警；
  - 支持自由切换目标上下文窗口基准（`128k` / `200k` / `256k` / `500k` / `1M`）。
- **原生 `/compact` 压缩与蓝汐归档联动**：
  - 支持在面板一键触发 **「立即提炼并触发 `/compact`」**（通过本地 Language Server 接口触发原生上下文压缩，并联动蓝汐沉淀关键记忆）；
  - 支持开启 **「达到红线自动触发压缩」**，无需手动干预即可保持长会话清爽。

### 5. 苍蓝套件 · 左侧栏快捷入口统一管理
- 在面板底部集中展示本机已安装的苍蓝系列 8 款插件（苍蓝罗盘、苍蓝回廊、苍蓝星轨、苍蓝协奏台、蓝汐认知图谱、苍蓝魂匣、思语中文、苍蓝棱镜）；
- 支持一键单独开启或关闭任意插件在 Antigravity 左侧栏的全局快捷入口（关闭左侧栏入口后，仍可在右侧辅助栏或通过对话正常打开）。

### 6. 苍蓝统一视觉与交互体系
- **Neko Glass 毛玻璃界面**：支持深色 / 浅色明暗双主题切换、自定义毛玻璃下拉框（`AzureSelect`）与 7px 细圆角滚动条。
- **跨插件共享「苍蓝主题色调中心」**：内置 6 套官方主题预设（苍蓝星辉、霓虹幻紫、薄荷青岚、绯樱珊瑚、琥珀流金、极光翠影）、自定义主副双色取色器及 4 个自定义保存栏位，一处切换全套件实时同步。
- **独立 Web UI & 在线更新检查**：点击顶栏 `Web UI` 即可在系统默认浏览器全屏打开；点击顶栏版本号徽章可实时对比 GitHub Release 最新版本。

---

## 🚀 安装方式

> 前置要求：**Node.js >= 22.0.0**（零第三方 npm 依赖，纯 Node.js 原生 ESM 实现）。

将本仓库克隆或复制到 Antigravity 全局插件目录（目录名固定为 `agent-presets`）：

```powershell
# Windows (PowerShell)
git clone https://github.com/A16Nights/antigravity-azure-compass.git "$env:USERPROFILE\.gemini\config\plugins\agent-presets"

# macOS / Linux
git clone https://github.com/A16Nights/antigravity-azure-compass.git ~/.gemini/config/plugins/agent-presets
```

重启或重载 Antigravity（`Ctrl+R`），在 **Plugins** 面板确认 **苍蓝罗盘** 已启用，即可从左侧栏或右侧辅助面板打开。

---

## 📂 数据与配置存储

- **预设与上下文监测配置**：`~/.gemini/agent-presets/config.json`
- **苍蓝套件左侧栏显示配置**：`~/.gemini/azure-sidebar-nav.json`
- **苍蓝套件共享主题配置**：`~/.gemini/azure-theme.json`

所有用户配置与插件代码目录完全隔离，升级插件不会丢失自定义预设。

---

## 📄 License

[MIT](./LICENSE)
