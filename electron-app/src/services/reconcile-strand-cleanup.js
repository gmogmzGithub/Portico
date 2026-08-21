const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STRAND_NAME_PATTERN = /^managed-runtime-reconcile\.[^/]+$/;

async function cleanupStaleReconcileStrands(options = {}) {
  const fsPromises = options.fsPromises || fs.promises;
  const tmpRoot = path.resolve(options.tmpRoot || os.tmpdir());
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const maxAgeMs = Number.isFinite(options.maxAgeMs)
    ? Math.max(0, options.maxAgeMs)
    : DEFAULT_MAX_AGE_MS;
  const result = { tmpRoot, removed: [], failed: [] };

  let entries;
  try {
    entries = await fsPromises.readdir(tmpRoot, { withFileTypes: true });
  } catch (error) {
    return { ...result, skipped: true, error: error.message };
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !STRAND_NAME_PATTERN.test(entry.name)) {
      continue;
    }
    const candidate = path.join(tmpRoot, entry.name);
    try {
      const stats = await fsPromises.lstat(candidate);
      if (!stats.isDirectory() || nowMs - stats.mtimeMs < maxAgeMs) {
        continue;
      }
      // Use the asynchronous filesystem path: historical strands can contain
      // hundreds of gigabytes, and reclaiming them must not block Electron's
      // main thread while the update UI is visible.
      await fsPromises.rm(candidate, { recursive: true, force: true });
      result.removed.push(candidate);
    } catch (error) {
      result.failed.push({ path: candidate, error: error.message });
    }
  }

  return result;
}

module.exports = {
  DEFAULT_MAX_AGE_MS,
  STRAND_NAME_PATTERN,
  cleanupStaleReconcileStrands,
};
