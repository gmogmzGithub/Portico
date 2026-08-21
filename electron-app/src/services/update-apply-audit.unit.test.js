const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  appendUpdateHistory,
  findPendingPostHealthCleanup,
  persistApplyAudit,
  sanitizeFileComponent,
} = require("./update-apply-audit");

test("persistApplyAudit records combined output and retains the newest ten logs", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "update-apply-audit-"));

  try {
    for (let index = 0; index < 12; index += 1) {
      const now = new Date(Date.UTC(2026, 6, 10, 12, 0, index));
      const result = persistApplyAudit({
        projectRoot,
        updateKey: `build/${index}`,
        startedAt: now,
        finishedAt: now,
        command: ["bash", "apply-prepared-update.sh"],
        combinedOutput: `stdout-${index}\n[stderr] stderr-${index}\n`,
        result: { success: index % 2 === 0, code: index % 2 },
      });
      assert.equal(result.success, true);
    }

    const healthStatusDir = path.join(projectRoot, "health-status");
    const logs = fs
      .readdirSync(healthStatusDir)
      .filter((name) => name.startsWith("update-apply-") && name.endsWith(".log"))
      .sort();
    assert.equal(logs.length, 10);
    assert.equal(logs.some((name) => name.includes("build-0-")), false);
    assert.equal(logs.some((name) => name.includes("build-11-")), true);

    const newest = fs.readFileSync(
      path.join(healthStatusDir, logs.find((name) => name.includes("build-11-"))),
      "utf8",
    );
    assert.match(newest, /Result: fail/);
    assert.match(newest, /stdout-11/);
    assert.match(newest, /\[stderr\] stderr-11/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("sanitizeFileComponent keeps audit paths inside health-status", () => {
  assert.equal(sanitizeFileComponent("../../beta latest"), "..-..-beta-latest");
  assert.equal(sanitizeFileComponent(""), "runtime-update");
});

test("appendUpdateHistory records attempts and caps the ledger at 500 lines", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "update-history-"));

  try {
    for (let index = 0; index < 502; index += 1) {
      const result = appendUpdateHistory({
        projectRoot,
        timestamp: new Date(Date.UTC(2026, 6, 10, 12, 0, index)),
        from: `old-${index}`,
        to: `new-${index}`,
        step: index % 2 === 0 ? "download" : "restore",
        result: { success: index % 3 === 0 },
        freeDiskKb: 12345 + index,
      });
      assert.equal(result.success, true);
    }

    const historyPath = path.join(
      projectRoot,
      "health-status",
      "update-history.jsonl",
    );
    const entries = fs
      .readFileSync(historyPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(entries.length, 500);
    assert.deepEqual(entries[0], {
      ts: new Date(Date.UTC(2026, 6, 10, 12, 0, 2)).toISOString(),
      from: "old-2",
      to: "new-2",
      step: "download",
      result: "fail",
      freeDiskKb: 12347,
    });
    assert.equal(entries.at(-1).from, "old-501");
    assert.equal(entries.at(-1).result, "ok");
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

function createManagedBuild(projectRoot, buildNumber) {
  const buildInfoPath = path.join(projectRoot, "electron-app", "build-info.json");
  fs.mkdirSync(path.dirname(buildInfoPath), { recursive: true });
  fs.writeFileSync(buildInfoPath, JSON.stringify({ buildNumber }), "utf8");
}

test("post-health cleanup selects the latest exact authoritative transition once", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "update-history-"));
  createManagedBuild(projectRoot, "07172026-bbccddee");

  try {
    appendUpdateHistory({
      projectRoot,
      from: "07162026-aabbccdd",
      to: "07172026-bbccddee",
      step: "complete",
      result: "ok",
      source: "apply-prepared-update",
      transitionId: "update-1",
    });

    const pending = findPendingPostHealthCleanup({
      projectRoot,
      currentBuild: "07172026-bbccddee",
    });
    assert.equal(pending.pending, true);
    assert.deepEqual(pending.transition, {
      from: "07162026-aabbccdd",
      to: "07172026-bbccddee",
      source: "apply-prepared-update",
      transitionId: "update-1",
    });

    appendUpdateHistory({
      projectRoot,
      from: "07162026-aabbccdd",
      to: "07172026-bbccddee",
      step: "post_health_cleanup",
      result: "ok",
      source: "docker-storage-maintenance",
      transitionId: "update-1",
    });
    assert.deepEqual(
      findPendingPostHealthCleanup({
        projectRoot,
        currentBuild: "07172026-bbccddee",
      }),
      { pending: false, reason: "cleanup-complete" },
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("post-health cleanup fails closed on malformed or non-authoritative latest history", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "update-history-"));
  createManagedBuild(projectRoot, "07172026-bbccddee");
  const historyDir = path.join(projectRoot, "health-status");
  const historyPath = path.join(historyDir, "update-history.jsonl");
  fs.mkdirSync(historyDir, { recursive: true });

  try {
    fs.writeFileSync(historyPath, "{not-json\n", "utf8");
    assert.equal(
      findPendingPostHealthCleanup({
        projectRoot,
        currentBuild: "07172026-bbccddee",
      }).reason,
      "history-malformed",
    );

    fs.writeFileSync(
      historyPath,
      `${JSON.stringify({
        from: "07162026-aabbccdd",
        to: "07172026-bbccddee",
        step: "complete",
        result: "ok",
      })}\n`,
      "utf8",
    );
    assert.equal(
      findPendingPostHealthCleanup({
        projectRoot,
        currentBuild: "07172026-bbccddee",
      }).reason,
      "transition-not-authoritative",
    );

    fs.writeFileSync(
      historyPath,
      `${JSON.stringify({
        from: "dev-build",
        to: "07172026-bbccddee",
        step: "complete",
        result: "ok",
        source: "runtime-reconcile",
        transitionId: "first-install",
      })}\n`,
      "utf8",
    );
    assert.equal(
      findPendingPostHealthCleanup({
        projectRoot,
        currentBuild: "07172026-bbccddee",
      }).reason,
      "transition-mismatch",
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("a newer transition or repeated from/to pair cannot reuse an old cleanup receipt", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "update-history-"));
  createManagedBuild(projectRoot, "07172026-bbccddee");

  try {
    for (const entry of [
      {
        from: "07162026-aabbccdd",
        to: "07172026-bbccddee",
        step: "complete",
        result: "ok",
        source: "apply-prepared-update",
        transitionId: "attempt-1",
      },
      {
        from: "07162026-aabbccdd",
        to: "07172026-bbccddee",
        step: "post_health_cleanup",
        result: "ok",
        source: "docker-storage-maintenance",
        transitionId: "attempt-1",
      },
      {
        from: "07162026-aabbccdd",
        to: "07172026-bbccddee",
        step: "complete",
        result: "ok",
        source: "apply-prepared-update",
        transitionId: "attempt-2",
      },
    ]) {
      appendUpdateHistory({ projectRoot, ...entry });
    }

    const pending = findPendingPostHealthCleanup({
      projectRoot,
      currentBuild: "07172026-bbccddee",
    });
    assert.equal(pending.pending, true);
    assert.equal(pending.transition.transitionId, "attempt-2");

    appendUpdateHistory({
      projectRoot,
      from: "07172026-bbccddee",
      to: "07182026-ccddeeaa",
      step: "complete",
      result: "ok",
      source: "apply-prepared-update",
      transitionId: "attempt-3",
    });
    assert.equal(
      findPendingPostHealthCleanup({
        projectRoot,
        currentBuild: "07172026-bbccddee",
      }).reason,
      "transition-mismatch",
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
