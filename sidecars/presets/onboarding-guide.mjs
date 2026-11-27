export const COMPASS_ONBOARDING_GUIDE = {
  version: "1",
  icon: "🧭",
  title: "欢迎使用苍蓝罗盘——Agent 预设与上下文监控",
  subtitle: "1 分钟了解工作模式切换、上下文水位防爆、全局 AGENTS 编辑与插件更新检测（随时点「? 指南」重看）",
  steps: [
    {
      icon: "🎯",
      navTitle: "切换工作模式",
      title: "一键切换 Agent 工作模式预设",
      desc: "不同任务需要不同风格：日常编码、协奏台省流、极简速答、只读审查或自定义预设，点一下立刻生效。",
      spotlight: {
        clickBefore: "#tabPresets",
        selector: "#chkReinforce",
        buttonText: "定位预设开关",
        hint: "点下方预设卡片即可切换模式；开启「每轮锚点强化」可防止长对话漂移"
      },
      items: [
        {
          icon: "⚡",
          title: "开箱内置多套实用预设",
          text: "包含标准模式、协奏台省流、极简快答、只读审查等模式，也支持自定义新建与排序。"
        },
        {
          icon: "🔒",
          title: "PreInvocation 底层注入",
          text: "开启强化后在每轮调用前自动注入当前模式锚点，并与苍蓝魂匣人设卡自然联动。"
        }
      ],
      tip: "平时想省主脑额度时，切到「协奏台省流」模式体验最明显。"
    },
    {
      icon: "📊",
      navTitle: "水位与媒体守卫",
      title: "上下文 Token 水位监测 & 媒体载荷防装死",
      desc: "自动跟随当前打开的对话，基于 API 实测 Token 与缓存命中率监控窗口占用，支持按模型自动识别上限、/compact 后首轮无损回注与媒体防装死。",
      spotlight: {
        clickBefore: "#tabPresets",
        selector: "#chkSentinel",
        buttonText: "定位水位守卫",
        hint: "可选择「按模型自动识别」窗口、开启 /compact 自动压缩与压缩后无损回注，及媒体体积拦截线"
      },
      items: [
        {
          icon: "🌊",
          title: "实测 Token 水位 & 按模型自动识别窗口",
          text: "读取最新 CHECKPOINT 后的实测 Token 与 KV-Cache 命中率，自动匹配当前模型窗口（如 200K / 400K / 1M），切对话或新建空白对话时面板瞬间同步。"
        },
        {
          icon: "🔁",
          title: "/compact 压缩前沉淀 + 压缩后首轮自动回注",
          text: "压缩前自动提炼要点入蓝汐；完成手动或自动 /compact 后，下一轮自动无损带回核心要点、近期改动文件与最近校验线索（仅回注一次、不污染前缀）。"
        },
        {
          icon: "🖼️",
          title: "媒体载荷防卡死拦截",
          text: "连续读大图或超大媒体载荷前由 PreToolUse 提前预警拦截，防止接口 504 或上下文瞬间撑爆。"
        }
      ],
      tip: "触发熔断拦截后，完成压缩或点「重置熔断」即可恢复正常调用。"
    },
    {
      icon: "📜",
      navTitle: "全局规则编辑",
      title: "可视化管理全局 AGENTS.md 规则",
      desc: "不用每次翻隐藏目录找配置文件，在面板里就能直接编辑、格式化与保存跨工作区通用的 AGENTS.md。",
      spotlight: {
        selector: "#tabAgents",
        buttonText: "定位全局规则页",
        hint: "切到「全局 AGENTS.md」标签即可直接在线编辑并热保存全局行为规范"
      },
      items: [
        {
          icon: "✏️",
          title: "所见即所得实时落盘",
          text: "清晰展示当前生效的全局规则正文与字数，修改保存后下一轮对话立刻生效。"
        }
      ],
      tip: "建议把跨项目的通用约定放在全局 AGENTS.md，把特定场景要求交给工作模式预设。"
    },
    {
      icon: "📦",
      navTitle: "插件更新与总控",
      title: "全插件更新雷达 & 苍蓝套件左侧栏总控",
      desc: "集中扫描本机已安装的苍蓝及社区插件是否有新版本，还能一键统一管理苍蓝全家桶在左侧栏的入口显隐。",
      spotlight: {
        selector: "#tabPlugins",
        buttonText: "定位插件更新页",
        hint: "切到「插件更新」可检查各插件 GitHub 最新 Release；顶栏主题与左侧栏开关全套件共享"
      },
      items: [
        {
          icon: "🔔",
          title: "批量检查 GitHub 新版本",
          text: "角标自动提示有更新的插件，一眼看清本地版本与线上最新 Release 差异。"
        },
        {
          icon: "🎨",
          title: "统一主题与入口管理",
          text: "顶栏可一键切换苍蓝共享主题配色、明暗模式与左侧栏快捷入口。"
        }
      ],
      tip: "随时可点顶栏「? 指南」重看本教程；支持键盘 ← / → 翻页与 Esc 关闭。"
    }
  ]
};
