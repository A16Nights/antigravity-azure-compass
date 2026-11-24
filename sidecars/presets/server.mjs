import { checkGithubUpdate } from "../../lib/update-checker.mjs";
import { isLeftSidebarEnabled, setLeftSidebarEnabled, listOwnedPluginsNavState, registerSidecarRuntime, refreshAntigravityMcpServers, injectSidebarToggleWidget } from "../../lib/sidebar-nav.mjs";
import { handleAzureThemeHttp } from "../../lib/azure-theme.mjs";
import { injectAzureUiKit } from "../../lib/azure-ui-kit.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { PresetStore, CONFIG_PATH } from "../../lib/store.mjs";

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
      const html = fs.readFileSync(INDEX_HTML, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(injectAzureUiKit(injectSidebarToggleWidget(html, "agent-presets"), "agent-presets"));
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
      const cfg = await store.deleteCustomPreset(id);
      sendJson(res, 200, { ok: true, activeId: cfg.activeId });
      return;
    }

    if (req.method === "POST" && pathname === "/api/open-config") {
      openFileCrossPlatform(CONFIG_PATH);
      sendJson(res, 200, { ok: true, configPath: CONFIG_PATH });
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
