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
    if (pathname === "/healthz") {
      sendJson(res, 200, { ok: true, service: "agent-presets" });
      return;
    }

    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      const html = fs.readFileSync(INDEX_HTML, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.method === "GET" && pathname === "/api/state") {
      const cfg = store.getConfig();
      const presets = store.getAllPresets();
      sendJson(res, 200, {
        activeId: cfg.activeId,
        perTurnReinforce: cfg.perTurnReinforce,
        configPath: CONFIG_PATH,
        presets
      });
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
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
