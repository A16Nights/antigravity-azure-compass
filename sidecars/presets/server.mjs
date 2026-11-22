import { checkGithubUpdate } from "../../lib/update-checker.mjs";
import { isLeftSidebarEnabled, setLeftSidebarEnabled, listOwnedPluginsNavState, registerSidecarRuntime, refreshAntigravityMcpServers, injectSidebarToggleWidget } from "../../lib/sidebar-nav.mjs";
import { handleAzureThemeHttp } from "../../lib/azure-theme.mjs";
import { injectAzureUiKit } from "../../lib/azure-ui-kit.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import { PresetStore, CONFIG_PATH } from "../../lib/store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.join(__dirname, "index.html");
const PORT = parseInt(
  process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || process.env.PORT || "18793",
  10
);

const store = new PresetStore();

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (!data.trim()) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  const pathname = url.pathname;

  try {
    if (req.method === "GET" && pathname === "/api/check-update") {
      const force = new URL(req.url, "http://127.0.0.1").searchParams.get("force") === "1";
      const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
      const info = await checkGithubUpdate({ pluginRoot, repo: "A16Nights/antigravity-azure-compass", force });
      sendJson(res, 200, info);
      return;
    }

    if (pathname === "/healthz") {
      sendJson(res, 200, { ok: true, service: "agent-presets" });
      return;
    }

    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      const html = fs.readFileSync(INDEX_HTML, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(injectAzureUiKit(injectSidebarToggleWidget(html, "agent-presets"), "agent-presets"));
      return;
    }

    if (await handleAzureThemeHttp(req, res)) return;
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
      const session = store.inspectLatestSession();
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
      const sentinel = store.updateSentinel(body);
      const session = store.inspectLatestSession();
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
      const cfg = store.deleteCustomPreset(id);
      sendJson(res, 200, { ok: true, activeId: cfg.activeId });
      return;
    }

    if (req.method === "POST" && pathname === "/api/open-config") {
      exec(`start "" "${CONFIG_PATH}"`);
      sendJson(res, 200, { ok: true, configPath: CONFIG_PATH });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    sendJson(res, 400, { error: String(err?.message || err) });
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
