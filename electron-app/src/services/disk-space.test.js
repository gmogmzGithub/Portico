const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  DB_SNAPSHOT_BYTES_FLOOR,
  DOWNLOAD_BYTES_FLOOR,
  PREPARE_MARGIN_BYTES,
  SLIM_CONFIG_BACKUP_ALLOWANCE_BYTES,
  checkPrepareDiskSpace,
  computeRequiredPrepareBytes,
  estimateSlimBackupBytes,
  estimateWebUiDbSnapshotBytes,
  findExistingAncestor,
  getFreeBytes,
} = require("./disk-space");

const GIB = 1024 * 1024 * 1024;
const DB_PATH = path.join("/managed", "open-webui-data", "webui.db");

test("getFreeBytes multiplies bavail by bsize", () => {
  const free = getFreeBytes("/anywhere", {
    existsSync: () => true,
    statfsSync: () => ({ bavail: 1024, bsize: 4096 }),
  });
  assert.equal(free, 1024 * 4096);
});

test("getFreeBytes probes the nearest existing ancestor", () => {
  const seen = [];
  const root = path.parse(path.resolve("/")).root;
  const free = getFreeBytes("/missing/deeper/leaf", {
    existsSync: (candidate) => candidate === root,
    statfsSync: (probe) => {
      seen.push(probe);
      return { bavail: 10, bsize: 10 };
    },
  });
  assert.equal(free, 100);
  assert.deepEqual(seen, [root]);
});

test("getFreeBytes returns null when statfs is unavailable or throws", () => {
  assert.equal(getFreeBytes("/x", { statfsSync: undefined }), null);
  assert.equal(
    getFreeBytes("/x", {
      existsSync: () => true,
      statfsSync: () => {
        throw Object.assign(new Error("ENOSYS"), { code: "ENOSYS" });
      },
    }),
    null,
  );
});

test("findExistingAncestor walks up to the filesystem root when nothing exists", () => {
  const root = path.parse(path.resolve("/a/b")).root;
  assert.equal(findExistingAncestor("/a/b/c", { existsSync: () => false }), root);
});

test("slim backup estimate stats only webui.db and adds a small config allowance", () => {
  const seen = [];
  const dbBytes = 330 * 1024 * 1024;
  const deps = {
    existsSync(candidate) {
      seen.push(["exists", candidate]);
      return candidate === DB_PATH;
    },
    statSync(candidate) {
      seen.push(["stat", candidate]);
      return { size: dbBytes };
    },
  };

  assert.equal(
    estimateWebUiDbSnapshotBytes({ managedDir: "/managed", deps }),
    dbBytes,
  );
  assert.equal(
    estimateSlimBackupBytes({ managedDir: "/managed", deps }),
    dbBytes + SLIM_CONFIG_BACKUP_ALLOWANCE_BYTES,
  );
  assert.equal(seen.some(([, candidate]) => candidate === "/managed"), false);
});

test("database snapshot estimate uses zero when absent and a floor when unmeasurable", () => {
  assert.equal(
    estimateWebUiDbSnapshotBytes({
      managedDir: "/managed",
      deps: { existsSync: () => false },
    }),
    0,
  );
  assert.equal(
    estimateWebUiDbSnapshotBytes({
      managedDir: "/managed",
      deps: {
        existsSync: () => true,
        statSync: () => {
          throw new Error("EACCES");
        },
      },
    }),
    DB_SNAPSHOT_BYTES_FLOOR,
  );
});

test("computeRequiredPrepareBytes models one archive, one extracted tree, and the slim backup", async () => {
  const dbBytes = 330 * 1024 * 1024;
  const estimate = await computeRequiredPrepareBytes({
    fileSize: 2 * GIB,
    managedDir: "/managed",
    deps: {
      existsSync: (candidate) => candidate === DB_PATH,
      statSync: () => ({ size: dbBytes }),
    },
  });

  assert.equal(estimate.downloadBytes, 2 * GIB);
  assert.equal(estimate.extractedPayloadBytes, 4 * GIB);
  assert.equal(
    estimate.backupBytes,
    dbBytes + SLIM_CONFIG_BACKUP_ALLOWANCE_BYTES,
  );
  assert.equal(
    estimate.requiredBytes,
    6 * GIB +
      dbBytes +
      SLIM_CONFIG_BACKUP_ALLOWANCE_BYTES +
      PREPARE_MARGIN_BYTES,
  );
});

test("computeRequiredPrepareBytes floors an unusable fileSize", async () => {
  for (const fileSize of [undefined, 0, -5, "garbage", NaN]) {
    const { downloadBytes } = await computeRequiredPrepareBytes({
      fileSize,
      managedDir: null,
    });
    assert.equal(downloadBytes, DOWNLOAD_BYTES_FLOOR);
  }
});

test("checkPrepareDiskSpace passes, blocks with numbers, and skips without statfs", async () => {
  const deps = (freeBytes) => ({
    existsSync: (candidate) => candidate === DB_PATH || candidate === "/prep",
    statSync: () => ({ size: 0 }),
    statfsSync: () => ({ bavail: freeBytes / 4096, bsize: 4096 }),
  });

  const ok = await checkPrepareDiskSpace({
    preparationRoot: "/prep",
    fileSize: GIB,
    managedDir: "/managed",
    deps: deps(100 * GIB),
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.skipped, undefined);

  const blocked = await checkPrepareDiskSpace({
    preparationRoot: "/prep",
    fileSize: GIB,
    managedDir: "/managed",
    deps: deps(2 * GIB),
  });
  const expectedRequired =
    3 * GIB +
    DB_SNAPSHOT_BYTES_FLOOR +
    SLIM_CONFIG_BACKUP_ALLOWANCE_BYTES +
    PREPARE_MARGIN_BYTES;
  assert.equal(blocked.ok, false);
  assert.equal(blocked.requiredBytes, expectedRequired);
  assert.match(
    blocked.message,
    /^Not enough free disk space to download and prepare the update/,
  );
  assert.match(blocked.message, /About 4\.5 GB is needed, but only 2\.0 GB is free/);
  assert.match(blocked.message, /Free up at least 2\.5 GB/);

  const skipped = await checkPrepareDiskSpace({
    preparationRoot: "/prep",
    fileSize: GIB,
    managedDir: "/managed",
    deps: { statfsSync: undefined },
  });
  assert.deepEqual(skipped, { ok: true, skipped: true });
});
