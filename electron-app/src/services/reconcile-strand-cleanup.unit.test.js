const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  DEFAULT_MAX_AGE_MS,
  cleanupStaleReconcileStrands,
} = require("./reconcile-strand-cleanup");

test("cleanupStaleReconcileStrands removes only strict, day-old strand directories", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "strand-cleanup-"));
  const nowMs = Date.UTC(2026, 6, 10, 12, 0, 0);
  const oldDate = new Date(nowMs - DEFAULT_MAX_AGE_MS - 1000);
  const recentDate = new Date(nowMs - DEFAULT_MAX_AGE_MS + 1000);
  const stale = path.join(tmpRoot, "managed-runtime-reconcile.old");
  const recent = path.join(tmpRoot, "managed-runtime-reconcile.recent");
  const nearMatch = path.join(tmpRoot, "managed-runtime-reconcile-old");
  const symlink = path.join(tmpRoot, "managed-runtime-reconcile.link");
  const symlinkTarget = path.join(tmpRoot, "must-not-delete");

  try {
    for (const candidate of [stale, recent, nearMatch, symlinkTarget]) {
      fs.mkdirSync(candidate);
    }
    fs.symlinkSync(symlinkTarget, symlink);
    fs.utimesSync(stale, oldDate, oldDate);
    fs.utimesSync(recent, recentDate, recentDate);
    fs.utimesSync(nearMatch, oldDate, oldDate);

    const result = await cleanupStaleReconcileStrands({ tmpRoot, nowMs });
    assert.deepEqual(result.removed, [stale]);
    assert.deepEqual(result.failed, []);
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(recent), true);
    assert.equal(fs.existsSync(nearMatch), true);
    assert.equal(fs.existsSync(symlink), true);
    assert.equal(fs.existsSync(symlinkTarget), true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
