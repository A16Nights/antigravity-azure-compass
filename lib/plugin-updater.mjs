/**
 * agent-presets · 全机已装插件更新检查器（100% 只读扫描本机插件 + 免限流优先查询）
 *
 * 数据来源（只读）：
 *  - ~/.gemini/config/plugins/<id>/plugin.json
 *  - ~/.gemini/config/config.json（installedFrom / enabled）
 *  - ~/.gemini/config/plugins/<id>/.git/config（origin remote）
 *  - 用户自定义绑定：~/.gemini/agent-presets/plugin-repos.json
 *  - 检查结果缓存：~/.gemini/agent-presets/plugin-updates-cache.json
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { compareVersions } from "./update-checker.mjs";

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
export const PLUGINS_ROOT = path.join(HOME, ".gemini", "config", "plugins");
export const HOST_CONFIG_PATH = path.join(HOME, ".gemini", "config", "config.json");
export const DEFAULT_DATA_DIR = path.join(HOME, ".gemini", "agent-presets");

export const CACHE_TTL_MS = 30 * 60 * 1000;
export const ERR_CACHE_TTL_MS = 3 * 60 * 1000;

export const BUILTIN_AZURE_REPOS = {
  "agent-presets": "A16Nights/antigravity-azure-compass",
  "lanxi-memory": "A16Nights/antigravity-lanxi-memory",
  "think-zh": "A16Nights/antigravity-think-zh",
  "azure-corridor": "A16Nights/antigravity-azure-corridor",
  "azure-orbit": "A16Nights/antigravity-azure-orbit",
  "external-orchestrator": "A16Nights/antigravity-external-orchestrator",
  "soul-md": "A16Nights/antigravity-soul-md",
  "azure-prism": "A16Nights/antigravity-azure-prism",
  "azure-wand": "A16Nights/antigravity-azure-wand"
};

const REPO_SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SEMVER_IN_TAG_RE = /v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/;
const PURE_SEMVER_TAG_RE = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/i;

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

export function parseGithubRepoUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (REPO_SLUG_RE.test(s)) {
    return { repo: s.replace(/\.git$/i, ""), subpath: "" };
  }
  // 支持 https://github.com/owner/repo(/tree/branch/subpath) 或 git@github.com:owner/repo.git
  const ssh = s.match(/github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:\/|$)/i);
  if (!ssh) return null;
  const repo = ssh[1].replace(/\.git$/i, "");
  if (!REPO_SLUG_RE.test(repo)) return null;
  let subpath = "";
  const tree = s.match(/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/tree\/[^/?#]+\/([^?#]+)/i);
  if (tree) {
    subpath = tree[1].replace(/^\/+|\/+$/g, "");
  }
  return { repo, subpath };
}

function readGitOriginRepo(pluginDir) {
  const cfgPath = path.join(pluginDir, ".git", "config");
  try {
    if (!fs.existsSync(cfgPath)) return null;
    const txt = fs.readFileSync(cfgPath, "utf8");
    const m = txt.match(/\[remote\s+"origin"\][\s\S]*?^\s*url\s*=\s*(.+)$/m);
    if (!m) return null;
    return parseGithubRepoUrl(m[1].trim());
  } catch {
    return null;
  }
}

function scanSidecarRepoHint(pluginDir) {
  const candidates = [path.join(pluginDir, "mcp-server.mjs")];
  const sidecarsDir = path.join(pluginDir, "sidecars");
  try {
    if (fs.existsSync(sidecarsDir)) {
      for (const ent of fs.readdirSync(sidecarsDir, { withFileTypes: true })) {
        if (ent.isDirectory()) {
          candidates.push(path.join(sidecarsDir, ent.name, "server.mjs"));
        }
      }
    }
  } catch {}
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const txt = fs.readFileSync(file, "utf8");
      const m = txt.match(/checkGithubUpdate\s*\(\s*\{[^}]*\brepo\s*:\s*["']([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)["']/);
      if (m && REPO_SLUG_RE.test(m[1])) {
        return { repo: m[1], subpath: "" };
      }
    } catch {}
  }
  return null;
}

export function loadCustomRepoBindings(dataDir = DEFAULT_DATA_DIR) {
  const raw = readJsonSafe(path.join(dataDir, "plugin-repos.json"), {});
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

export function saveCustomRepoBinding(pluginId, repoInput, dataDir = DEFAULT_DATA_DIR) {
  const id = String(pluginId || "").trim();
  if (!id || /[\\/]/.test(id)) throw new Error("无效的插件 ID");
  const filePath = path.join(dataDir, "plugin-repos.json");
  const cur = loadCustomRepoBindings(dataDir);
  const raw = String(repoInput || "").trim();
  if (!raw) {
    delete cur[id];
  } else {
    const parsed = parseGithubRepoUrl(raw);
    if (!parsed || !REPO_SLUG_RE.test(parsed.repo)) {
      throw new Error("请输入合法的 GitHub 仓库（例如 owner/repo 或完整 GitHub 链接）");
    }
    cur[id] = parsed.subpath ? `https://github.com/${parsed.repo}/tree/main/${parsed.subpath}` : parsed.repo;
  }
  writeJsonAtomic(filePath, cur);
  return cur;
}

export function loadUpdateCache(dataDir = DEFAULT_DATA_DIR) {
  const raw = readJsonSafe(path.join(dataDir, "plugin-updates-cache.json"), { version: 1, updatedAt: 0, entries: {} });
  if (!raw || typeof raw !== "object") return { version: 1, updatedAt: 0, entries: {} };
  return {
    version: 1,
    updatedAt: Number(raw.updatedAt) || 0,
    entries: raw.entries && typeof raw.entries === "object" ? raw.entries : {}
  };
}

function saveUpdateCache(cache, dataDir = DEFAULT_DATA_DIR) {
  try {
    writeJsonAtomic(path.join(dataDir, "plugin-updates-cache.json"), cache);
  } catch {
    // 缓存落盘失败不影响主流程
  }
}

export function discoverInstalledPlugins(options = {}) {
  const pluginsRoot = options.pluginsRoot || PLUGINS_ROOT;
  const hostConfigPath = options.hostConfigPath || HOST_CONFIG_PATH;
  const dataDir = options.dataDir || DEFAULT_DATA_DIR;

  const hostCfg = readJsonSafe(hostConfigPath, {});
  const hostPlugins = hostCfg?.plugins && typeof hostCfg.plugins === "object" ? hostCfg.plugins : {};
  const customBindings = loadCustomRepoBindings(dataDir);

  if (!fs.existsSync(pluginsRoot)) return [];

  const dirs = fs
    .readdirSync(pluginsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));

  const items = [];
  for (const id of dirs) {
    const dir = path.join(pluginsRoot, id);
    const pj = readJsonSafe(path.join(dir, "plugin.json"), null);
    if (!pj || typeof pj !== "object") continue;

    const hostEntry = hostPlugins[id] || {};
    const from = hostEntry.installedFrom || null;
    const enabled = hostEntry.enabled === undefined ? true : Boolean(hostEntry.enabled);
    const currentVersion = String(pj.version || "0.0.0").trim();
    const displayName = String(pj.displayName || pj.display_name || pj.name || id).trim();
    const description = String(pj.description || "").trim();

    let repo = "";
    let subpath = "";
    let repoSource = "";
    let isCustomBound = false;

    // 1. 用户自定义绑定最高优先级
    if (customBindings[id]) {
      const parsed = parseGithubRepoUrl(customBindings[id]);
      if (parsed) {
        repo = parsed.repo;
        subpath = parsed.subpath;
        repoSource = "custom";
        isCustomBound = true;
      }
    }

    // 2. host config installedFrom (github/owner/repo)
    if (!repo && from && typeof from.id === "string" && from.marketplace === "github") {
      const m = from.id.match(/^github\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/);
      if (m) {
        repo = m[1];
        repoSource = "installedFrom";
      }
    }

    // 3. plugin.json repository / homepage
    if (!repo) {
      const rawRepo = typeof pj.repository === "string" ? pj.repository : pj.repository?.url || "";
      const parsed = parseGithubRepoUrl(rawRepo) || parseGithubRepoUrl(pj.homepage || "");
      if (parsed) {
        repo = parsed.repo;
        subpath = parsed.subpath;
        repoSource = "manifest";
      }
    }

    // 4. .git/config origin
    if (!repo) {
      const gitOrigin = readGitOriginRepo(dir);
      if (gitOrigin) {
        repo = gitOrigin.repo;
        subpath = gitOrigin.subpath;
        repoSource = "git";
      }
    }

    // 5. 自研插件内置 server.mjs/mcp-server.mjs 中的 checkGithubUpdate 提示
    if (!repo) {
      const hint = scanSidecarRepoHint(dir);
      if (hint) {
        repo = hint.repo;
        repoSource = "sidecar";
      }
    }

    // 6. 内置苍蓝系列兜底映射
    if (!repo && BUILTIN_AZURE_REPOS[id]) {
      repo = BUILTIN_AZURE_REPOS[id];
      repoSource = "builtin-azure";
    }

    // 分类
    let category = "local";
    if (BUILTIN_AZURE_REPOS[id] || id.startsWith("azure-")) {
      category = "azure";
    } else if (from?.marketplace && from.marketplace !== "github") {
      category = "marketplace";
    } else if (repo) {
      category = "github";
    }

    items.push({
      id,
      displayName,
      description,
      currentVersion,
      enabled,
      category,
      marketplace: from?.marketplace || "",
      installedFromId: from?.id || "",
      repo,
      subpath,
      repoSource,
      isCustomBound,
      repoUrl: repo ? `https://github.com/${repo}` : ""
    });
  }

  return items;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function getOptionalGithubAuthHeader() {
  const tok = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();
  return tok ? { Authorization: `Bearer ${tok}` } : {};
}

function extractSemver(tag) {
  const s = String(tag || "").trim();
  const m = s.match(SEMVER_IN_TAG_RE);
  return m ? m[1] : "";
}

async function fetchLatestReleaseViaRedirect(repo) {
  const res = await fetchWithTimeout(
    `https://github.com/${repo}/releases/latest`,
    {
      method: "HEAD",
      redirect: "follow",
      headers: { "User-Agent": "antigravity-azure-compass-updater" }
    },
    6000
  );
  const finalUrl = res.url || "";
  const m = finalUrl.match(/\/releases\/tag\/([^/?#]+)/i);
  if (!m) return null;
  const tag = decodeURIComponent(m[1]).trim();
  const version = extractSemver(tag);
  if (!version) return null;
  return {
    latestVersion: version,
    tag,
    releaseUrl: finalUrl,
    releaseName: tag,
    releaseNotes: "",
    publishedAt: "",
    method: "release-redirect"
  };
}

async function fetchRemoteManifestVersion(repo, subpath = "") {
  const sub = subpath ? `${subpath.replace(/^\/+|\/+$/g, "")}/` : "";
  const candidates = [
    `https://raw.githubusercontent.com/${repo}/HEAD/${sub}plugin.json`,
    `https://raw.githubusercontent.com/${repo}/main/${sub}plugin.json`
  ];
  for (const url of candidates) {
    try {
      const res = await fetchWithTimeout(
        url,
        { headers: { "User-Agent": "antigravity-azure-compass-updater" } },
        5000
      );
      if (!res.ok) continue;
      const pj = await res.json();
      const ver = extractSemver(pj?.version || "");
      if (ver) {
        return {
          latestVersion: ver,
          tag: `v${ver}`,
          releaseUrl: `https://github.com/${repo}`,
          releaseName: `plugin.json (v${ver})`,
          releaseNotes: "",
          publishedAt: "",
          method: "remote-manifest"
        };
      }
    } catch {}
  }
  return null;
}

async function fetchReleaseDetailsViaApi(repo) {
  try {
    const res = await fetchWithTimeout(
      `https://api.github.com/repos/${repo}/releases/latest`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "antigravity-azure-compass-updater",
          ...getOptionalGithubAuthHeader()
        }
      },
      5500
    );
    if (!res.ok) return null;
    const json = await res.json();
    const tag = String(json?.tag_name || json?.name || "").trim();
    const version = extractSemver(tag);
    return {
      latestVersion: version || "",
      tag,
      releaseUrl: json?.html_url || `https://github.com/${repo}/releases`,
      releaseName: String(json?.name || tag).trim(),
      releaseNotes: String(json?.body || "").trim().slice(0, 600),
      publishedAt: String(json?.published_at || ""),
      method: "release-api"
    };
  } catch {
    return null;
  }
}

async function fetchLatestTagViaAtom(repo) {
  const res = await fetchWithTimeout(
    `https://github.com/${repo}/tags.atom`,
    { headers: { "User-Agent": "antigravity-azure-compass-updater" } },
    6000
  );
  if (res.status === 404) return { notFound: true };
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const xml = await res.text();
  const entries = [...xml.matchAll(/<entry>[\s\S]*?<title>([^<]+)<\/title>/g)].map((m) => m[1].trim());
  for (const tag of entries) {
    // 仅匹配纯语义化版本标签（v1.2.3 / 1.2.3），过滤 monorepo 中 @scope/pkg@x.y.z 避免误报
    const m = tag.match(PURE_SEMVER_TAG_RE);
    if (m) {
      return {
        latestVersion: m[1],
        tag,
        releaseUrl: `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`,
        releaseName: tag,
        releaseNotes: "",
        publishedAt: "",
        method: "tags-atom"
      };
    }
  }
  return { noMatchingTag: true };
}

function computeStatus(plugin, checkEntry) {
  if (!plugin.repo) return "local_only";
  if (!checkEntry) return "unchecked";
  if (checkEntry.specialStatus) return checkEntry.specialStatus;
  if (!checkEntry.ok) return "error";
  if (!checkEntry.latestVersion) return "error";
  const cmp = compareVersions(checkEntry.latestVersion, plugin.currentVersion);
  if (cmp > 0) return "has_update";
  if (cmp < 0) return "ahead";
  return "up_to_date";
}

function mergePluginWithCache(plugin, cacheEntry) {
  const entry = cacheEntry && cacheEntry.repo === plugin.repo ? cacheEntry : null;
  const status = computeStatus(plugin, entry);
  return {
    ...plugin,
    status,
    hasUpdate: status === "has_update",
    latestVersion: entry?.ok ? entry.latestVersion : "",
    releaseUrl: entry?.releaseUrl || (plugin.repo ? `https://github.com/${plugin.repo}/releases` : ""),
    releaseName: entry?.releaseName || "",
    releaseNotes: entry?.releaseNotes || "",
    publishedAt: entry?.publishedAt || "",
    checkMethod: entry?.method || "",
    error: entry && !entry.ok ? entry.error || "检查失败" : "",
    checkedAt: entry?.checkedAt || 0
  };
}

export async function checkSinglePluginRemote(plugin, options = {}) {
  const now = Date.now();
  if (!plugin.repo) {
    return {
      ok: false,
      repo: "",
      error: "未绑定远端仓库",
      checkedAt: now
    };
  }

  const fetcher = options.fetcher;
  if (typeof fetcher === "function") {
    return fetcher(plugin);
  }

  try {
    let info = null;

    // 带 subpath 的子目录插件（如 deja-vu/antigravity-plugin）优先读对应子目录的 plugin.json，再结合 releases/latest
    if (plugin.subpath) {
      info = await fetchRemoteManifestVersion(plugin.repo, plugin.subpath);
    }

    // 1. 优先走免限流网页 releases/latest 重定向
    if (!info) {
      try {
        info = await fetchLatestReleaseViaRedirect(plugin.repo);
      } catch {}
    }

    // 2. 仓库没发 Release 时，尝试免限流 raw.githubusercontent.com 读取远端 plugin.json
    if (!info) {
      info = await fetchRemoteManifestVersion(plugin.repo, plugin.subpath);
    }

    // 3. 兜底走免限流 GitHub tags.atom（仅认纯语义化标签，防 monorepo 子包误报）
    if (!info) {
      const atomRes = await fetchLatestTagViaAtom(plugin.repo);
      if (atomRes?.notFound) {
        return {
          ok: true,
          specialStatus: "unreleased",
          repo: plugin.repo,
          releaseUrl: `https://github.com/${plugin.repo}`,
          method: "repo-head",
          error: "",
          checkedAt: now
        };
      }
      if (atomRes?.noMatchingTag) {
        return {
          ok: true,
          specialStatus: plugin.category === "marketplace" ? "marketplace_managed" : "unreleased",
          repo: plugin.repo,
          releaseUrl: `https://github.com/${plugin.repo}`,
          method: "tags-atom",
          error: "",
          checkedAt: now
        };
      }
      if (atomRes?.error) {
        return {
          ok: false,
          repo: plugin.repo,
          releaseUrl: `https://github.com/${plugin.repo}/releases`,
          error: atomRes.error,
          checkedAt: now
        };
      }
      info = atomRes;
    }

    // 4. 若通过 redirect 发现确实有新版本，按需补一次 Release 更新说明（失败不影响版本判定）
    if (
      info &&
      info.method === "release-redirect" &&
      compareVersions(info.latestVersion, plugin.currentVersion) > 0
    ) {
      const details = await fetchReleaseDetailsViaApi(plugin.repo);
      if (details) {
        if (details.releaseName) info.releaseName = details.releaseName;
        if (details.releaseNotes) info.releaseNotes = details.releaseNotes;
        if (details.publishedAt) info.publishedAt = details.publishedAt;
      }
    }

    return {
      ok: true,
      repo: plugin.repo,
      latestVersion: info.latestVersion,
      tag: info.tag || "",
      releaseUrl: info.releaseUrl || `https://github.com/${plugin.repo}/releases`,
      releaseName: info.releaseName || "",
      releaseNotes: info.releaseNotes || "",
      publishedAt: info.publishedAt || "",
      method: info.method || "",
      error: "",
      checkedAt: now
    };
  } catch (err) {
    return {
      ok: false,
      repo: plugin.repo,
      releaseUrl: `https://github.com/${plugin.repo}/releases`,
      error: err?.name === "AbortError" ? "请求超时" : String(err?.message || err),
      checkedAt: now
    };
  }
}

async function runWithConcurrency(list, limit, worker) {
  const out = new Array(list.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (cursor < list.length) {
      const idx = cursor++;
      out[idx] = await worker(list[idx], idx);
    }
  });
  await Promise.all(runners);
  return out;
}

function summarize(items, lastCheckedAt) {
  const counts = {
    total: items.length,
    hasUpdate: 0,
    upToDate: 0,
    ahead: 0,
    localOnly: 0,
    managed: 0,
    error: 0,
    unchecked: 0
  };
  for (const it of items) {
    if (it.status === "has_update") counts.hasUpdate++;
    else if (it.status === "up_to_date") counts.upToDate++;
    else if (it.status === "ahead") counts.ahead++;
    else if (it.status === "local_only" || it.status === "unreleased") counts.localOnly++;
    else if (it.status === "marketplace_managed") counts.managed++;
    else if (it.status === "error") counts.error++;
    else counts.unchecked++;
  }
  return {
    ok: true,
    counts,
    lastCheckedAt: lastCheckedAt || 0,
    items
  };
}

export function getInstalledPluginsSnapshot(options = {}) {
  const dataDir = options.dataDir || DEFAULT_DATA_DIR;
  const plugins = discoverInstalledPlugins(options);
  const cache = loadUpdateCache(dataDir);
  const items = plugins.map((p) => mergePluginWithCache(p, cache.entries[p.id]));
  return summarize(items, cache.updatedAt);
}

export async function checkAllPluginUpdates(options = {}) {
  const dataDir = options.dataDir || DEFAULT_DATA_DIR;
  const force = Boolean(options.force);
  const targetId = String(options.id || "").trim();
  const concurrency = Math.max(1, Math.min(8, Number(options.concurrency) || 4));
  const now = Date.now();

  const plugins = discoverInstalledPlugins(options);
  const cache = loadUpdateCache(dataDir);

  const targets = plugins.filter((p) => {
    if (!p.repo) return false;
    if (targetId && p.id !== targetId) return false;
    if (force) return true;
    const prev = cache.entries[p.id];
    if (!prev || prev.repo !== p.repo) return true;
    const ttl = prev.ok ? CACHE_TTL_MS : ERR_CACHE_TTL_MS;
    return now - (Number(prev.checkedAt) || 0) >= ttl;
  });

  if (targets.length > 0) {
    const checked = await runWithConcurrency(targets, concurrency, async (p) => {
      const entry = await checkSinglePluginRemote(p, options);
      return { id: p.id, entry };
    });
    for (const { id, entry } of checked) {
      cache.entries[id] = entry;
    }
    cache.updatedAt = Date.now();
    saveUpdateCache(cache, dataDir);
  }

  const items = plugins.map((p) => mergePluginWithCache(p, cache.entries[p.id]));
  return summarize(items, cache.updatedAt);
}
