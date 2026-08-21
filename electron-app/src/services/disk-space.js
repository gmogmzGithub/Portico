"use strict";

// Free-space preflight for update preparation.
//
// The slim-backup pipeline no longer walks or archives the managed tree. Its
// incremental backup cost is one SQLite snapshot (S) plus a small config ZIP.
// The release staging directory retains the downloaded archive (D) and one
// extracted payload tree (U); extraction is finalized with an intra-volume
// rename, so there is no second U-sized payload copy. Cloudsmith currently
// exposes D but not U, so this estimator conservatively models U as 2D:
//
//   required ~= D + 2D + S + config allowance + safety margin
//
// All measurements are O(1) stat/statfs calls. In particular, this module
// must never run a recursive du across user workspaces or Open WebUI uploads.

const fs = require("fs");
const path = require("path");

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const DOWNLOAD_BYTES_FLOOR = GIB;
const DB_SNAPSHOT_BYTES_FLOOR = 512 * MIB;
const SLIM_CONFIG_BACKUP_ALLOWANCE_BYTES = 16 * MIB;
const PREPARE_MARGIN_BYTES = GIB;
const EXTRACTED_PAYLOAD_MULTIPLIER = 2;

function formatByteCount(bytes) {
  const numericBytes = Number(bytes);
  if (!Number.isFinite(numericBytes) || numericBytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = numericBytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 100 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function findExistingAncestor(dirPath, deps = {}) {
  const existsSync = deps.existsSync || fs.existsSync;
  let candidate = path.resolve(String(dirPath || "/"));
  for (;;) {
    try {
      if (existsSync(candidate)) {
        return candidate;
      }
    } catch {
      return candidate;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      return candidate;
    }
    candidate = parent;
  }
}

function getFreeBytes(dirPath, deps = {}) {
  const statfsSync = "statfsSync" in deps ? deps.statfsSync : fs.statfsSync;
  if (typeof statfsSync !== "function") {
    return null;
  }
  try {
    const probe = findExistingAncestor(dirPath, deps);
    const stats = statfsSync(probe);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    return Number.isFinite(freeBytes) && freeBytes >= 0 ? freeBytes : null;
  } catch {
    return null;
  }
}

function estimateWebUiDbSnapshotBytes({ managedDir, deps = {} } = {}) {
  const existsSync = deps.existsSync || fs.existsSync;
  const statSync = deps.statSync || fs.statSync;
  if (!managedDir) {
    return 0;
  }

  const dbPath = path.join(managedDir, "open-webui-data", "webui.db");
  try {
    if (!existsSync(dbPath)) {
      return 0;
    }
    const size = Number(statSync(dbPath).size);
    return Number.isFinite(size) && size > 0
      ? size
      : DB_SNAPSHOT_BYTES_FLOOR;
  } catch {
    // A present-but-unmeasurable database must not make the estimator assume
    // a zero-cost snapshot. This floor covers typical production databases
    // without reintroducing a recursive filesystem walk.
    return DB_SNAPSHOT_BYTES_FLOOR;
  }
}

function estimateSlimBackupBytes({ managedDir, deps = {} } = {}) {
  return (
    estimateWebUiDbSnapshotBytes({ managedDir, deps }) +
    SLIM_CONFIG_BACKUP_ALLOWANCE_BYTES
  );
}

async function computeRequiredPrepareBytes({ fileSize, managedDir, deps = {} } = {}) {
  const numericFileSize = Number(fileSize);
  const downloadBytes =
    Number.isFinite(numericFileSize) && numericFileSize > 0
      ? numericFileSize
      : DOWNLOAD_BYTES_FLOOR;
  const extractedPayloadBytes = downloadBytes * EXTRACTED_PAYLOAD_MULTIPLIER;
  const backupBytes = estimateSlimBackupBytes({ managedDir, deps });
  const requiredBytes =
    downloadBytes +
    extractedPayloadBytes +
    backupBytes +
    PREPARE_MARGIN_BYTES;

  return {
    requiredBytes,
    downloadBytes,
    extractedPayloadBytes,
    backupBytes,
  };
}

function buildInsufficientPrepareSpaceMessage(requiredBytes, freeBytes) {
  const shortfallBytes = Math.max(0, requiredBytes - freeBytes);
  return (
    "Not enough free disk space to download and prepare the update. About " +
    `${formatByteCount(requiredBytes)} is needed, but only ${formatByteCount(freeBytes)} is free. ` +
    `Free up at least ${formatByteCount(shortfallBytes)}, then click Retry or relaunch Portico.`
  );
}

async function checkPrepareDiskSpace({
  preparationRoot,
  fileSize,
  managedDir,
  deps = {},
} = {}) {
  const freeBytes = getFreeBytes(preparationRoot, deps);
  if (freeBytes == null) {
    return { ok: true, skipped: true };
  }
  const estimate = await computeRequiredPrepareBytes({
    fileSize,
    managedDir,
    deps,
  });
  if (freeBytes >= estimate.requiredBytes) {
    return { ok: true, ...estimate, freeBytes };
  }
  return {
    ok: false,
    ...estimate,
    freeBytes,
    message: buildInsufficientPrepareSpaceMessage(
      estimate.requiredBytes,
      freeBytes,
    ),
  };
}

module.exports = {
  DB_SNAPSHOT_BYTES_FLOOR,
  DOWNLOAD_BYTES_FLOOR,
  EXTRACTED_PAYLOAD_MULTIPLIER,
  PREPARE_MARGIN_BYTES,
  SLIM_CONFIG_BACKUP_ALLOWANCE_BYTES,
  buildInsufficientPrepareSpaceMessage,
  checkPrepareDiskSpace,
  computeRequiredPrepareBytes,
  estimateSlimBackupBytes,
  estimateWebUiDbSnapshotBytes,
  findExistingAncestor,
  formatByteCount,
  getFreeBytes,
};
