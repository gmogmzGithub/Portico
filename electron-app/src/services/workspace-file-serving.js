const fs = require("node:fs");
const path = require("node:path");

const {
  resolveChatWorkspaceEntryPathWithSkillAssetFallback,
} = require("./chat-workspaces");

const INLINE_IMAGE_CONTENT_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/vnd.microsoft.icon",
  "image/webp",
  "image/x-icon",
]);

const INLINE_SVG_CONTENT_SECURITY_POLICY = [
  "sandbox",
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function normalizedContentType(value) {
  return String(value || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
}

function requestWantsInlineImage(req) {
  return (
    String(req.query?.inline || "") === "1" ||
    String(req.get("Sec-Fetch-Dest") || "").toLowerCase() === "image"
  );
}

function encodedContentDisposition(disposition, fileName) {
  const fallback = String(fileName || "download")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\\r\n]/g, "_");
  const encoded = encodeURIComponent(String(fileName || "download")).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function applyWorkspaceFileResponseHeaders(req, res, { filePath, fileSize }) {
  res.type(path.extname(filePath) || "application/octet-stream");
  const contentType = normalizedContentType(res.getHeader("Content-Type"));
  const inline =
    requestWantsInlineImage(req) && INLINE_IMAGE_CONTENT_TYPES.has(contentType);
  const disposition = inline ? "inline" : "attachment";

  res.setHeader(
    "Content-Disposition",
    encodedContentDisposition(disposition, path.basename(filePath)),
  );
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Length", fileSize);

  if (inline && contentType === "image/svg+xml") {
    res.setHeader("Content-Security-Policy", INLINE_SVG_CONTENT_SECURITY_POLICY);
  }

  return { contentType, inline };
}

function createWorkspaceFileRequestHandler({
  projectRoot,
  logger = console,
  resolveEntryPath = resolveChatWorkspaceEntryPathWithSkillAssetFallback,
} = {}) {
  if (!String(projectRoot || "").trim()) {
    throw new Error("projectRoot is required");
  }

  return async (req, res) => {
    const { chatId } = req.params;
    const filePathParts = req.params.filePath;
    const filePath = Array.isArray(filePathParts)
      ? filePathParts.join("/")
      : filePathParts;

    if (!chatId || !filePath) {
      return res.status(400).json({ error: "chatId and file path required" });
    }

    const normalizedFilePath = String(filePath || "")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "");
    let resolved;
    try {
      resolved = resolveEntryPath({
        projectRoot,
        chatId,
        relativePath: normalizedFilePath,
      });
    } catch (_error) {
      logger.warn?.(`[API] Blocked path traversal attempt: ${filePath}`);
      return res.status(403).json({ error: "Invalid path" });
    }

    let servedPath = resolved.targetPath;
    let stats;
    try {
      stats = await fs.promises.stat(servedPath);
    } catch {
      // Skill assets are only materialized in the canonical workspace dir by
      // the Rust skills server; chats bound to a custom workspace fall back to
      // that canonical copy so visual-aid URLs keep resolving.
      const fallbackPath = resolved.skillAssetFallbackPath || null;
      if (!fallbackPath) {
        return res.status(404).json({ error: "File not found" });
      }
      try {
        stats = await fs.promises.stat(fallbackPath);
        servedPath = fallbackPath;
      } catch {
        return res.status(404).json({ error: "File not found" });
      }
    }

    if (stats.isDirectory()) {
      return res.status(400).json({ error: "Cannot download directory" });
    }

    logger.log?.(`[API] Serving workspace file: ${chatId}/${normalizedFilePath}`);
    applyWorkspaceFileResponseHeaders(req, res, {
      filePath: servedPath,
      fileSize: stats.size,
    });

    const fileStream = fs.createReadStream(servedPath);
    fileStream.on("error", (error) => {
      logger.error?.(`[API] Error streaming file: ${error.message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: "Error reading file" });
      } else {
        res.destroy(error);
      }
    });
    return fileStream.pipe(res);
  };
}

function registerWorkspaceFileRoute(apiApp, options) {
  apiApp.get(
    "/workspace/:chatId/{*filePath}",
    createWorkspaceFileRequestHandler(options),
  );
}

module.exports = {
  INLINE_IMAGE_CONTENT_TYPES,
  INLINE_SVG_CONTENT_SECURITY_POLICY,
  applyWorkspaceFileResponseHeaders,
  createWorkspaceFileRequestHandler,
  registerWorkspaceFileRoute,
  requestWantsInlineImage,
};
