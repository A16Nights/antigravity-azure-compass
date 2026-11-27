// agent-presets · 本地 Language Server (daemon hub) 客户端
// 用途：直接向本机 Antigravity daemon 的 LanguageServerService 派发 slash command（如 /compact），
// 绕开"需要用户手动输入"的限制，实现上下文监测的自动压缩能力。
// 设计原则：零依赖、只读 daemon 目录、任何异常一律吞掉并以 ok:false 返回，绝不让 hook 崩掉。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();

export const DEFAULT_DAEMON_DIR = path.join(HOME, ".gemini", "antigravity", "daemon");

const SEND_MESSAGE_PATH =
  "/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage";

const DEFAULT_TIMEOUT_MS = 20000;

function resolveDaemonDir(dir) {
  const raw = dir || process.env.AGENT_PRESETS_DAEMON_DIR || DEFAULT_DAEMON_DIR;
  return String(raw);
}

// 进程存活判定：EPERM（进程存在但无权限发信号）同样视为存活。
export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    if (err && err.code === "EPERM") return true;
    return false;
  }
}

// 扫描 daemon 目录下的 hub_*.json，返回按端口排序的存活 hub 列表。
// 字段实测：{ pid, httpsPort, httpPort, lsVersion, csrfToken }
export function listHubs(daemonDir) {
  const dir = resolveDaemonDir(daemonDir);
  const hubs = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return hubs;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/^hub_.*\.json$/i.test(entry.name)) continue;
    const filePath = path.join(dir, entry.name);
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const port = Number(raw.httpPort || raw.port || raw.httpsPort || 0);
      if (!port) continue;
      const pid = Number(raw.pid || 0);
      if (pid && !isPidAlive(pid)) continue;
      hubs.push({
        pid,
        port,
        httpPort: port,
        httpsPort: Number(raw.httpsPort || 0),
        lsVersion: String(raw.lsVersion || ""),
        csrfToken: String(raw.csrfToken || ""),
        filePath,
        mtimeMs: (() => {
          try {
            return fs.statSync(filePath).mtimeMs;
          } catch {
            return 0;
          }
        })()
      });
    } catch {
      // 跳过损坏或半写入的 hub 文件
    }
  }
  hubs.sort((a, b) => b.mtimeMs - a.mtimeMs || a.port - b.port);
  return hubs;
}

// 构造 SendUserCascadeMessage 请求体
export function buildSlashCommandBody(cascadeId, commandName) {
  return {
    cascadeId: String(cascadeId || ""),
    items: [
      {
        item: {
          slashCommand: {
            info: {
              name: String(commandName || "compact"),
              type: "SLASH_COMMAND_TYPE_SYSTEM"
            }
          }
        }
      }
    ]
  };
}

// 向单个 hub 发送 slash command
export async function sendSlashCommand(hub, cascadeId, commandName, options = {}) {
  if (!hub || !hub.port) {
    return { ok: false, error: "no_hub" };
  }
  if (!cascadeId) {
    return { ok: false, error: "no_cascade_id" };
  }
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const url = `http://127.0.0.1:${hub.port}${SEND_MESSAGE_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        ...(hub.csrfToken ? { "x-codeium-csrf-token": String(hub.csrfToken) } : {})
      },
      body: JSON.stringify(buildSlashCommandBody(cascadeId, commandName)),
      signal: controller.signal
    });
    let text = "";
    try {
      text = await res.text();
    } catch {
      text = "";
    }
    return {
      ok: res.ok,
      status: res.status,
      port: hub.port,
      body: text.slice(0, 500)
    };
  } catch (err) {
    return {
      ok: false,
      port: hub.port,
      error: String(err?.message || err)
    };
  } finally {
    clearTimeout(timer);
  }
}

// 派发 slash command：优先使用 preferredPort 指定的 hub，其余按新鲜度依次尝试。
export async function dispatchSlashCommand({
  cascadeId,
  commandName = "compact",
  daemonDir,
  preferredPort,
  timeoutMs
} = {}) {
  const hubs = listHubs(daemonDir);
  if (hubs.length === 0) {
    return { ok: false, error: "no_alive_hub", attempted: [] };
  }
  const preferred = Number(preferredPort) || 0;
  const ordered = preferred
    ? [...hubs].sort((a, b) => (a.port === preferred ? -1 : b.port === preferred ? 1 : 0))
    : hubs;

  const attempted = [];
  for (const hub of ordered) {
    const result = await sendSlashCommand(hub, cascadeId, commandName, { timeoutMs });
    attempted.push({ port: hub.port, ok: result.ok, status: result.status, error: result.error });
    if (result.ok) {
      return { ok: true, port: hub.port, commandName, attempted, ...result };
    }
  }
  return { ok: false, error: "all_hubs_failed", commandName, attempted };
}

const GENERATOR_METADATA_PATH =
  "/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata";
const LIVE_META_CACHE = new Map();
const LIVE_META_TTL_MS = 4000;

/**
 * 向本机 Antigravity Language Server 实时查询指定会话的官方上下文元数据：
 * 直接拿到宿主当前模型真实的 maxContextTokens（如 Gemini 4 的 786,432、Claude / GPT / 外接模型各自的真实上限）
 * 以及最近一次 API 计费的 inputTokens / cacheReadTokens，确保切换任何模型都 100% 与官方弹窗对齐。
 * 任何异常或超时均 fail-open 返回 { ok: false }。
 */
export async function fetchLiveContextMetadata(cascadeId, { daemonDir, timeoutMs = 1200, force = false } = {}) {
  const cid = String(cascadeId || "").trim();
  if (!cid || cid === "__empty__") return { ok: false, error: "empty_cascade_id" };

  const now = Date.now();
  const cached = LIVE_META_CACHE.get(cid);
  if (!force && cached && now - cached.at < LIVE_META_TTL_MS) {
    return cached.value;
  }

  const hubs = listHubs(daemonDir);
  if (hubs.length === 0) return { ok: false, error: "no_alive_hub" };

  for (const hub of hubs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(400, Number(timeoutMs) || 1200));
    try {
      const url = `http://127.0.0.1:${hub.port}${GENERATOR_METADATA_PATH}`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
          ...(hub.csrfToken ? { "x-codeium-csrf-token": String(hub.csrfToken) } : {})
        },
        body: JSON.stringify({ cascadeId: cid }),
        signal: controller.signal
      });
      if (!res.ok) continue;
      const data = await res.json();
      const list = Array.isArray(data?.generatorMetadata) ? data.generatorMetadata : [];
      let maxContextTokens = 0;
      let estimatedTokensUsed = 0;
      let inputTokens = null;
      let cacheReadTokens = null;
      let modelEnum = "";

      for (let i = list.length - 1; i >= 0; i -= 1) {
        const cm = list[i]?.chatModel;
        if (!cm || typeof cm !== "object") continue;
        const cwm = cm.chatStartMetadata?.contextWindowMetadata;
        if (!maxContextTokens && Number(cwm?.maxContextTokens) > 0) {
          maxContextTokens = Number(cwm.maxContextTokens);
        }
        if (!estimatedTokensUsed && Number(cwm?.estimatedTokensUsed) > 0) {
          estimatedTokensUsed = Number(cwm.estimatedTokensUsed);
        }
        if (!modelEnum && typeof cm.model === "string" && cm.model.trim()) {
          modelEnum = cm.model.trim();
        }
        if (inputTokens === null && cm.usage && typeof cm.usage === "object") {
          const inp = Number(cm.usage.inputTokens);
          const cache = Number(cm.usage.cacheReadTokens || 0);
          if (Number.isFinite(inp) && inp >= 0 && inp + cache > 0) {
            inputTokens = inp;
            cacheReadTokens = Number.isFinite(cache) && cache >= 0 ? cache : 0;
          }
        }
        if (maxContextTokens > 0 && inputTokens !== null) break;
      }

      if (maxContextTokens > 0 || inputTokens !== null || estimatedTokensUsed > 0) {
        const value = {
          ok: true,
          port: hub.port,
          maxContextTokens,
          estimatedTokensUsed,
          inputTokens,
          cacheReadTokens,
          modelEnum
        };
        if (LIVE_META_CACHE.size > 32) LIVE_META_CACHE.clear();
        LIVE_META_CACHE.set(cid, { at: now, value });
        return value;
      }
    } catch {
      // 尝试下一个 hub 或回退本地日志
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: "unavailable" };
}
