import { checkGithubUpdate } from "../../lib/update-checker.mjs";
import { isLeftSidebarEnabled, setLeftSidebarEnabled, listOwnedPluginsNavState, registerSidecarRuntime, refreshAntigravityMcpServers, injectSidebarToggleWidget } from "../../lib/sidebar-nav.mjs";
import { handleAzureThemeHttp } from "../../lib/azure-theme.mjs";
import { injectAzureUiKit } from "../../lib/azure-ui-kit.mjs";
import { handleAzureOnboardingHttp, injectAzureOnboarding } from "../../lib/azure-onboarding.mjs";
import { COMPASS_ONBOARDING_GUIDE } from "./onboarding-guide.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { PresetStore, CONFIG_PATH } from "../../lib/store.mjs";
import { AgentsSyncStore } from "../../lib/agents-sync.mjs";
import {
  getInstalledPluginsSnapshot,
  checkAllPluginUpdates,
  saveCustomRepoBinding
} from "../../lib/plugin-updater.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.join(__dirname, "index.html");
const PORT = parseInt(
  process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || process.env.PORT || "18793",
  10
);
const TOKEN = (
  process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN ||
  process.env.ANTIGRAVITY_SIDECAR_AUTH_TOKEN ||
  process.env.ANTIGRAVITY_SIDECAR_WEB_TOKEN ||
  ""
).trim();

const store = new PresetStore();
const agentsStore = new AgentsSyncStore();

function isAllowedLocalOrigin(req) {
  const origin = String(req.headers?.origin || "").trim();
  if (!origin || origin === "null") return true;
  try {
    const u = new URL(origin);
    const h = u.hostname.toLowerCase();
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
}

function safeTokenEqual(a, b) {
  const ba = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function checkAuth(req, url) {
  if (!isAllowedLocalOrigin(req)) return false;
  if (!TOKEN) return true;
  const hdr = req.headers["x-codeium-sidecar-token"] || req.headers["x-sidecar-token"];
  const q = url.searchParams.get("token");
  return safeTokenEqual(hdr, TOKEN) || safeTokenEqual(q, TOKEN);
}

function openFileCrossPlatform(targetPath) {
  if (process.platform === "win32") {
    spawn("rundll32.exe", ["url.dll,FileProtocolHandler", targetPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [targetPath], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [targetPath], { detached: true, stdio: "ignore" }).unref();
  }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function readBody(req, maxBytes = 512 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    req.on("data", (c) => {
      if (settled) return;
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(String(c), "utf8");
      total += buf.length;
      if (total > maxBytes) {
        settled = true;
        req.destroy();
        const err = new Error("Payload too large");
        err.statusCode = 413;
        reject(err);
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      const data = Buffer.concat(chunks).toString("utf8").trim();
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        const err = new Error("Invalid JSON");
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on("error", (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  const pathname = url.pathname;

  try {
    if (pathname === "/healthz") {
      sendJson(res, 200, { ok: true, service: "agent-presets" });
      return;
    }

    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      let html = fs.readFileSync(INDEX_HTML, "utf8");
      // 注入 Antigravity 原生 /preload.js 以自动获取当前活跃 conversationId（独立浏览器打开时自动忽略）
      if (!html.includes("/preload.js")) {
        html = html.replace("<head>", '<head>\n<script src="/preload.js" onerror="void 0"></script>');
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(injectAzureOnboarding(injectAzureUiKit(injectSidebarToggleWidget(html, "agent-presets"), "agent-presets"), "agent-presets", COMPASS_ONBOARDING_GUIDE));
      return;
    }

    if (pathname.startsWith("/api/")) {
      if (!checkAuth(req, url)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
    }

    if (req.method === "GET" && pathname === "/api/check-update") {
      const force = url.searchParams.get("force") === "1";
      const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
      const info = await checkGithubUpdate({ pluginRoot, repo: "A16Nights/antigravity-azure-compass", force });
      sendJson(res, 200, info);
      return;
    }

    if (await handleAzureThemeHttp(req, res)) return;
    if (await handleAzureOnboardingHttp(req, res, "agent-presets", COMPASS_ONBOARDING_GUIDE.version)) return;
    if (req.method === "GET" && pathname === "/api/sidebar-nav") {
      sendJson(res, 200, {
        ok: true,
        pluginId: "agent-presets",
        showInLeftSidebar: isLeftSidebarEnabled("agent-presets"),
        plugins: listOwnedPluginsNavState()
      });
      return;
    }
    if (req.method === "POST" && pathname === "/api/sidebar-nav") {
      const body = await readBody(req);
      const targetId = String(body.pluginId || "agent-presets").trim();
      const nextVal = Boolean(body.showInLeftSidebar);
      setLeftSidebarEnabled(targetId, nextVal);
      const rf = await refreshAntigravityMcpServers();
      sendJson(res, 200, {
        ok: true,
        pluginId: targetId,
        showInLeftSidebar: nextVal,
        refreshed: Boolean(rf?.ok),
        plugins: listOwnedPluginsNavState()
      });
      return;
    }
    if (req.method === "GET" && pathname === "/api/state") {
      const cfg = store.getConfig();
      const presets = store.getAllPresets();
      const reqCid = String(url.searchParams.get("conversationId") || "").trim();
      const session = await store.inspectLatestSessionLive(reqCid, { timeoutMs: 1200 });
      sendJson(res, 200, {
        activeId: cfg.activeId,
        perTurnReinforce: cfg.perTurnReinforce,
        sentinel: cfg.sentinel,
        session,
        sentinelSignal: store.loadSentinelSignal(),
        configPath: CONFIG_PATH,
        presets
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/sentinel") {
      const body = await readBody(req);
      const reqCid = String(body.conversationId || url.searchParams.get("conversationId") || "").trim();
      const sentinel = store.updateSentinel(body);
      const session = await store.inspectLatestSessionLive(reqCid, { timeoutMs: 1200 });
      sendJson(res, 200, { ok: true, sentinel, session });
      return;
    }

    // 重置熔断：清 pending / failCount / lastError，保留 conversationId 与提炼进度
    if (req.method === "POST" && pathname === "/api/sentinel/reset") {
      store.resetSentinelBreaker();
      sendJson(res, 200, { ok: true, sentinelSignal: store.loadSentinelSignal() });
      return;
    }

    if (req.method === "POST" && pathname === "/api/activate") {
      const body = await readBody(req);
      const result = await store.activate(body.id);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    if (req.method === "POST" && pathname === "/api/toggle") {
      const body = await readBody(req);
      const cfg = store.setPerTurnReinforce(body.perTurnReinforce);
      sendJson(res, 200, { ok: true, perTurnReinforce: cfg.perTurnReinforce });
      return;
    }

    if (req.method === "POST" && pathname === "/api/presets") {
      const body = await readBody(req);
      const item = store.upsertCustomPreset(body);
      sendJson(res, 200, { ok: true, preset: item });
      return;
    }

    if (req.method === "DELETE" && pathname.startsWith("/api/presets/")) {
      const id = decodeURIComponent(pathname.slice("/api/presets/".length));
      const cfg = await store.deleteCustomPreset(id);
      sendJson(res, 200, { ok: true, activeId: cfg.activeId });
      return;
    }

    if (req.method === "POST" && pathname === "/api/open-config") {
      openFileCrossPlatform(CONFIG_PATH);
      sendJson(res, 200, { ok: true, configPath: CONFIG_PATH });
      return;
    }

    // ---------- 全局 AGENTS.md 编辑、Diff、快照回滚与热同步 API ----------
    if (req.method === "GET" && pathname === "/api/agents") {
      sendJson(res, 200, agentsStore.getState());
      return;
    }

    if (req.method === "POST" && pathname === "/api/agents/save") {
      const body = await readBody(req);
      const result = agentsStore.saveContent(body.content);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && pathname === "/api/agents/toggle-sync") {
      const body = await readBody(req);
      const result = agentsStore.setSyncEnabled(body.enabled);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    if (req.method === "POST" && pathname === "/api/agents/diff") {
      const body = await readBody(req);
      const result = agentsStore.previewDiff(body.content);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/api/agents/snapshots/")) {
      const id = decodeURIComponent(pathname.slice("/api/agents/snapshots/".length));
      const detail = agentsStore.getSnapshotDetail(id);
      sendJson(res, 200, detail);
      return;
    }

    if (req.method === "POST" && pathname === "/api/agents/rollback") {
      const body = await readBody(req);
      const result = agentsStore.rollbackSnapshot(body.id);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && pathname === "/api/agents/open") {
      const st = agentsStore.getState();
      const targetFile = st.target?.exists ? st.target.realPath : path.dirname(st.target?.realPath || CONFIG_PATH);
      openFileCrossPlatform(targetFile);
      sendJson(res, 200, { ok: true, path: targetFile });
      return;
    }

    // ---------- 全机已装插件更新检查 API ----------
    if (req.method === "GET" && pathname === "/api/plugins/updates") {
      const refresh = url.searchParams.get("refresh") === "1";
      const data = refresh
        ? await checkAllPluginUpdates({ force: true })
        : getInstalledPluginsSnapshot();
      sendJson(res, 200, data);
      return;
    }

    if (req.method === "POST" && pathname === "/api/plugins/updates/check") {
      const body = await readBody(req);
      const data = await checkAllPluginUpdates({
        force: body.force !== false,
        id: String(body.id || "").trim()
      });
      sendJson(res, 200, data);
      return;
    }

    if (req.method === "POST" && pathname === "/api/plugins/updates/bind") {
      const body = await readBody(req);
      saveCustomRepoBinding(body.id, body.repo);
      const data = body.repo
        ? await checkAllPluginUpdates({ force: true, id: String(body.id || "").trim() })
        : getInstalledPluginsSnapshot();
      sendJson(res, 200, data);
      return;
    }

    if (req.method === "POST" && pathname === "/api/open-url") {
      const body = await readBody(req);
      let parsed;
      try {
        parsed = new URL(String(body.url || "").trim());
      } catch {
        sendJson(res, 400, { ok: false, error: "无效链接" });
        return;
      }
      if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") {
        sendJson(res, 403, { ok: false, error: "仅允许打开 GitHub 页面链接" });
        return;
      }
      openFileCrossPlatform(parsed.toString());
      sendJson(res, 200, { ok: true, url: parsed.toString() });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    sendJson(res, err?.statusCode || 400, { error: String(err?.message || err) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[agent-presets] sidecar listening on http://127.0.0.1:${PORT}`);
  try {
    const __a = server.address();
    const __p = (__a && typeof __a === "object" && __a.port) ? __a.port : Number(PORT) || 0;
    const __t = (process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || process.env.ANTIGRAVITY_SIDECAR_AUTH_TOKEN || process.env.ANTIGRAVITY_SIDECAR_WEB_TOKEN || "").trim();
    const __u = __t ? `http://127.0.0.1:${__p}/?token=${encodeURIComponent(__t)}` : `http://127.0.0.1:${__p}/`;
    registerSidecarRuntime("agent-presets", { port: __p, url: __u });
  } catch {}
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
