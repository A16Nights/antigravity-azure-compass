import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_MEDIA_GUARD = {
  enabled: true,
  warnMb: 12,
  blockMb: 20,
  singleFileMaxMb: 10,
  blockEnabled: true
};

export const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".tif",
  ".tiff",
  ".avif",
  ".heic",
  ".heif"
]);

export const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".mkv",
  ".avi",
  ".webm",
  ".flv",
  ".wmv",
  ".m4v",
  ".ts",
  ".mpeg",
  ".mpg"
]);

export const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".ogg",
  ".flac",
  ".opus",
  ".wma"
]);

export const DOC_MEDIA_EXTENSIONS = new Set([".pdf"]);

export const MEDIA_EXTENSIONS = new Set([
  ...IMAGE_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
  ...DOC_MEDIA_EXTENSIONS
]);

const MB = 1024 * 1024;
const MAX_SCAN_BYTES = 8 * 1024 * 1024;

export function normalizeMediaGuardConfig(raw = {}) {
  const src = raw && typeof raw === "object" ? raw : {};
  const warnMb = Math.max(2, Math.min(100, Number(src.warnMb) || DEFAULT_MEDIA_GUARD.warnMb));
  const blockMb = Math.max(
    warnMb + 2,
    Math.min(200, Number(src.blockMb) || DEFAULT_MEDIA_GUARD.blockMb)
  );
  const singleFileMaxMb = Math.max(
    1,
    Math.min(100, Number(src.singleFileMaxMb) || DEFAULT_MEDIA_GUARD.singleFileMaxMb)
  );
  return {
    enabled: src.enabled !== false,
    warnMb,
    blockMb,
    singleFileMaxMb,
    blockEnabled: src.blockEnabled !== false
  };
}

export function isMediaExtension(filePath) {
  if (!filePath || typeof filePath !== "string") return false;
  const ext = path.extname(filePath.trim()).toLowerCase();
  return MEDIA_EXTENSIONS.has(ext);
}

export function classifyMediaType(mimeType = "", filePath = "") {
  const mime = String(mimeType || "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (DOC_MEDIA_EXTENSIONS.has(ext)) return "pdf";
  return "other";
}

export function resolveMediaUriToPath(uri) {
  const raw = String(uri || "").trim();
  if (!raw) return "";
  if (/^file:\/\//i.test(raw)) {
    try {
      return fileURLToPath(raw);
    } catch {
      let stripped = decodeURIComponent(raw.replace(/^file:\/\//i, ""));
      if (/^\/[a-zA-Z]:/.test(stripped)) stripped = stripped.slice(1);
      return stripped;
    }
  }
  return raw;
}

export function formatMb(bytes) {
  const mb = Math.max(0, Number(bytes) || 0) / MB;
  return mb >= 10 ? mb.toFixed(1) : mb.toFixed(2);
}

export function summarizeMediaCounts(counts = {}) {
  const parts = [];
  if (counts.image > 0) parts.push(`图片 ${counts.image}`);
  if (counts.video > 0) parts.push(`视频 ${counts.video}`);
  if (counts.audio > 0) parts.push(`音频 ${counts.audio}`);
  if (counts.pdf > 0) parts.push(`PDF ${counts.pdf}`);
  if (counts.other > 0) parts.push(`其他 ${counts.other}`);
  return parts.join(" / ");
}

/**
 * 扫描单个 transcript.jsonl 在最近一次 CHECKPOINT 之后累计引入的二进制媒体文件。
 * 覆盖用户上传（.user_uploaded/*）与工具读入（.system_generated/logs/media/*）两类载荷。
 */
export function inspectSessionMedia(transcriptPath, mediaGuardCfg = {}) {
  const cfg = normalizeMediaGuardConfig(mediaGuardCfg);
  const empty = {
    found: false,
    enabled: cfg.enabled,
    totalBytes: 0,
    totalMb: 0,
    fileCount: 0,
    missingCount: 0,
    counts: { image: 0, video: 0, audio: 0, pdf: 0, other: 0 },
    largestFile: null,
    warnMb: cfg.warnMb,
    blockMb: cfg.blockMb,
    singleFileMaxMb: cfg.singleFileMaxMb,
    blockEnabled: cfg.blockEnabled,
    percent: 0,
    level: "ok",
    compacted: false
  };

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return empty;
  }

  try {
    const stat = fs.statSync(transcriptPath);
    let rawBuf;
    let tailTruncated = false;
    if (stat.size > MAX_SCAN_BYTES) {
      tailTruncated = true;
      const fd = fs.openSync(transcriptPath, "r");
      try {
        rawBuf = Buffer.allocUnsafe(MAX_SCAN_BYTES);
        const readLen = fs.readSync(fd, rawBuf, 0, MAX_SCAN_BYTES, stat.size - MAX_SCAN_BYTES);
        rawBuf = rawBuf.subarray(0, readLen);
      } finally {
        fs.closeSync(fd);
      }
    } else {
      rawBuf = fs.readFileSync(transcriptPath);
    }

    const text = rawBuf.toString("utf8");
    const checkpointRegex = /\n[^\n]*"type"\s*:\s*"CHECKPOINT"/g;
    let lastCheckpointPos = -1;
    let match;
    while ((match = checkpointRegex.exec(text)) !== null) {
      lastCheckpointPos = match.index + 1;
    }
    if (!tailTruncated && lastCheckpointPos < 0 && /^[^\n]*"type"\s*:\s*"CHECKPOINT"/.test(text)) {
      lastCheckpointPos = 0;
    }

    const activeSlice = lastCheckpointPos >= 0 ? text.slice(lastCheckpointPos) : text;
    const lines = activeSlice.split(/\r?\n/);
    const seenUris = new Set();
    const counts = { image: 0, video: 0, audio: 0, pdf: 0, other: 0 };
    let totalBytes = 0;
    let fileCount = 0;
    let missingCount = 0;
    let largestFile = null;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line || !line.includes('"media"')) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (!Array.isArray(rec?.media) || rec.media.length === 0) continue;
      for (const item of rec.media) {
        if (!item || typeof item !== "object") continue;
        const localPath = resolveMediaUriToPath(item.uri);
        if (!localPath) continue;
        const normKey = path.normalize(localPath).toLowerCase();
        if (seenUris.has(normKey)) continue;
        seenUris.add(normKey);

        let size = -1;
        try {
          if (fs.existsSync(localPath)) {
            const fst = fs.statSync(localPath);
            if (fst.isFile()) size = fst.size;
          }
        } catch {
          size = -1;
        }
        if (size < 0) {
          missingCount += 1;
          continue;
        }
        const kind = classifyMediaType(item.mime_type || item.mimeType, localPath);
        counts[kind] = (counts[kind] || 0) + 1;
        totalBytes += size;
        fileCount += 1;
        if (!largestFile || size > largestFile.bytes) {
          largestFile = {
            name: path.basename(localPath),
            bytes: size,
            mb: Number((size / MB).toFixed(2)),
            kind
          };
        }
      }
    }

    const totalMb = Number((totalBytes / MB).toFixed(2));
    const percent = cfg.blockMb > 0 ? Math.min(100, Math.round((totalMb / cfg.blockMb) * 100)) : 0;
    let level = "ok";
    if (totalMb >= cfg.blockMb) level = "critical";
    else if (totalMb >= cfg.warnMb) level = "warn";

    return {
      found: true,
      enabled: cfg.enabled,
      totalBytes,
      totalMb,
      fileCount,
      missingCount,
      counts,
      largestFile,
      warnMb: cfg.warnMb,
      blockMb: cfg.blockMb,
      singleFileMaxMb: cfg.singleFileMaxMb,
      blockEnabled: cfg.blockEnabled,
      percent,
      level,
      compacted: lastCheckpointPos >= 0
    };
  } catch {
    return empty;
  }
}

/**
 * 评估一次 read_file / view_file 媒体读取是否应放行或拦截。
 */
export function evaluateMediaRead({
  filePath = "",
  cwd = "",
  transcriptPath = "",
  mediaGuardConfig = {}
} = {}) {
  const cfg = normalizeMediaGuardConfig(mediaGuardConfig);
  if (!cfg.enabled || !cfg.blockEnabled) {
    return { decision: "allow", skipped: cfg.enabled ? "block_disabled" : "guard_disabled" };
  }
  const clean = String(filePath || "").trim().replace(/^["']|["']$/g, "");
  if (!clean || !isMediaExtension(clean)) {
    return { decision: "allow", skipped: "not_media" };
  }

  const absPath = path.isAbsolute(clean) ? clean : path.resolve(cwd || process.cwd(), clean);
  let targetBytes = 0;
  try {
    if (!fs.existsSync(absPath)) {
      return { decision: "allow", skipped: "file_not_found" };
    }
    const st = fs.statSync(absPath);
    if (!st.isFile()) return { decision: "allow", skipped: "not_file" };
    targetBytes = st.size;
  } catch {
    return { decision: "allow", skipped: "stat_failed" };
  }

  const fileName = path.basename(absPath);
  const targetMb = targetBytes / MB;
  const current = inspectSessionMedia(transcriptPath, cfg);
  const projectedBytes = current.totalBytes + targetBytes;
  const projectedMb = projectedBytes / MB;

  if (targetMb > cfg.singleFileMaxMb) {
    return {
      decision: "deny",
      code: "single_file_too_large",
      targetBytes,
      currentBytes: current.totalBytes,
      projectedBytes,
      reason:
        `[苍蓝罗盘 · 媒体防装死拦截] 目标媒体文件 "${fileName}" 体积 ${formatMb(targetBytes)} MB，` +
        `超过单文件安全上限 ${cfg.singleFileMaxMb} MB。Antigravity 主对话会将已读媒体永久保留在上下文历史中并在后续每轮全量重传，` +
        `极易触发后端超时重试导致界面长时间挂在 working 装死。\n` +
        `建议处理：\n` +
        `1) 音视频请先用 ffmpeg 压缩降码率/切片，大图请先缩放压缩后再读取；\n` +
        `2) 优先通过 invoke_subagent 派独立子代理查看并只返回文字结论，避免污染主对话历史；\n` +
        `3) 若确需读取原文件，可在「苍蓝罗盘」侧栏面板调高单文件上限或临时关闭硬拦截。`
    };
  }

  if (projectedMb > cfg.blockMb) {
    const breakdown = summarizeMediaCounts(current.counts);
    const detail = breakdown ? `（${breakdown}）` : "";
    return {
      decision: "deny",
      code: "session_media_budget_exceeded",
      targetBytes,
      currentBytes: current.totalBytes,
      projectedBytes,
      reason:
        `[苍蓝罗盘 · 媒体防装死拦截] 当前会话自上次 CHECKPOINT 以来已累计媒体载荷 ${formatMb(current.totalBytes)} MB` +
        `（${current.fileCount} 个文件${detail}），加上本次 "${fileName}"（${formatMb(targetBytes)} MB）将达到 ${formatMb(projectedBytes)} MB，` +
        `超过安全红线 ${cfg.blockMb} MB。继续塞入媒体极易触发每轮全量重传超时导致界面无限 working 装死。\n` +
        `建议处理：\n` +
        `1) 先执行 /compact 触发 CHECKPOINT 清理历史媒体载荷，或直接新开会话继续；\n` +
        `2) 切勿在已塞满媒体的当前老对话里中途切换模型（会触发服务端缓存失效与冷重传）；\n` +
        `3) 批量看图/看视频请改派独立子代理（invoke_subagent）隔离处理，只把文字结论带回主对话。`
    };
  }

  return {
    decision: "allow",
    targetBytes,
    currentBytes: current.totalBytes,
    projectedBytes,
    level: projectedMb >= cfg.warnMb ? "warn" : "ok"
  };
}
