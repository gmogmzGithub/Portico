const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  CLEANUP_TIMEOUT_MS,
  resolveMaintenanceScript,
  runDockerStorageMaintenance,
  _test: { runDockerStorageMaintenanceUnserialized },
} = require("./docker-storage-maintenance");

test("storage maintenance runs migration, re-probes Docker, then applies exact cleanup", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portico-maintenance-"));
  const scriptsDir = path.join(projectRoot, "src", "scripts");
  fs.mkdirSync(scriptsDir, { recursive: true });
  for (const script of ["migrate-buildkit-gc-policy.sh", "portico-docker-cleanup.sh"]) {
    fs.writeFileSync(path.join(scriptsDir, script), "#!/bin/bash\n", "utf8");
  }

  const calls = [];
  try {
    const result = await runDockerStorageMaintenanceUnserialized({
      projectRoot,
      expectedCurrentTag: "07172026-aabbccdd",
      expectedPreviousTag: "07162026-1122aabb",
      runProcess: async (command, args, options) => {
        calls.push({ command, args, options });
        return { stdout: "ok\n", stderr: "", code: 0 };
      },
    });

    assert.equal(result.success, true);
    assert.deepEqual(
      calls.map(({ command, args }) => [command, ...args]),
      [
        ["bash", path.join(scriptsDir, "migrate-buildkit-gc-policy.sh")],
        ["docker", "info"],
        [
          "bash",
          path.join(scriptsDir, "portico-docker-cleanup.sh"),
          "--apply",
          "--expected-current-tag",
          "07172026-aabbccdd",
          "--expected-previous-tag",
          "07162026-1122aabb",
        ],
      ],
    );
    assert.equal(calls[0].options.timeoutMs, 0);
    assert.equal(calls[0].options.maxBufferBytes, Number.POSITIVE_INFINITY);
    assert.equal(calls[2].options.timeoutMs, CLEANUP_TIMEOUT_MS);
    assert.equal(
      calls[2].options.env.PORTICO_MANAGED_DIR,
      projectRoot,
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("storage maintenance skips cleanup when Docker is not ready after migration", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portico-maintenance-"));
  const scriptsDir = path.join(projectRoot, "src", "scripts");
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(
    path.join(scriptsDir, "migrate-buildkit-gc-policy.sh"),
    "#!/bin/bash\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(scriptsDir, "portico-docker-cleanup.sh"),
    "#!/bin/bash\n",
    "utf8",
  );

  const calls = [];
  try {
    const result = await runDockerStorageMaintenanceUnserialized({
      projectRoot,
      expectedCurrentTag: "07172026-aabbccdd",
      expectedPreviousTag: "07162026-1122aabb",
      runProcess: async (command, args) => {
        calls.push([command, ...args]);
        if (command === "docker") throw new Error("daemon unavailable");
        return { stdout: "", stderr: "", code: 0 };
      },
    });

    assert.equal(result.success, false);
    assert.deepEqual(calls, [
      ["bash", path.join(scriptsDir, "migrate-buildkit-gc-policy.sh")],
      ["docker", "info"],
    ]);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("exact cleanup appends validated current and previous transition tags", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portico-maintenance-"));
  const scriptsDir = path.join(projectRoot, "src", "scripts");
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(path.join(scriptsDir, "portico-docker-cleanup.sh"), "#!/bin/bash\n");
  const calls = [];
  try {
    const result = await runDockerStorageMaintenanceUnserialized({
      projectRoot,
      includeMigration: false,
      expectedCurrentTag: "07172026-aabbccdd",
      expectedPreviousTag: "07162026-1122aabb",
      runProcess: async (command, args) => {
        calls.push([command, ...args]);
        return { stdout: "", stderr: "", code: 0 };
      },
    });
    assert.equal(result.success, true);
    assert.deepEqual(calls[1], [
      "bash",
      path.join(scriptsDir, "portico-docker-cleanup.sh"),
      "--apply",
      "--expected-current-tag",
      "07172026-aabbccdd",
      "--expected-previous-tag",
      "07162026-1122aabb",
    ]);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("exact cleanup rejects unpaired, invalid, and equal tags before running commands", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portico-maintenance-"));
  try {
    for (const tags of [
      { expectedCurrentTag: "07172026-aabbccdd" },
      { expectedCurrentTag: "invalid", expectedPreviousTag: "07162026-aabbccdd" },
      { expectedCurrentTag: "07172026-aabbccdd", expectedPreviousTag: "07172026-aabbccdd" },
    ]) {
      let called = false;
      const result = await runDockerStorageMaintenanceUnserialized({
        projectRoot,
        ...tags,
        runProcess: async () => {
          called = true;
        },
      });
      assert.equal(result.success, false);
      assert.equal(called, false);
    }
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("automated cleanup rejects heuristic deletion without exact transition tags", async () => {
  let called = false;
  const result = await runDockerStorageMaintenanceUnserialized({
    projectRoot: "/managed",
    includeMigration: false,
    includeCleanup: true,
    runProcess: async () => {
      called = true;
    },
  });
  assert.equal(result.success, false);
  assert.match(result.error, /requires an exact current and previous release tag/);
  assert.equal(called, false);
});

test("cleanup fail-closed exit remains non-destructive and is reported as skipped", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portico-maintenance-"));
  const scriptsDir = path.join(projectRoot, "src", "scripts");
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(
    path.join(scriptsDir, "portico-docker-cleanup.sh"),
    "#!/bin/bash\n",
    "utf8",
  );

  try {
    const result = await runDockerStorageMaintenanceUnserialized({
      projectRoot,
      includeMigration: false,
      expectedCurrentTag: "07172026-aabbccdd",
      expectedPreviousTag: "07162026-1122aabb",
      runProcess: async (command) => {
        if (command === "docker") return { stdout: "", stderr: "", code: 0 };
        const error = new Error("exit 3");
        error.code = 3;
        error.stderr = "FAIL-CLOSED\n";
        throw error;
      },
    });

    assert.equal(result.success, false);
    assert.equal(result.cleanup.failClosed, true);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("maintenance serializes cleanup mutations within the app process", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portico-maintenance-"));
  const scriptsDir = path.join(projectRoot, "src", "scripts");
  const cleanupScript = path.join(scriptsDir, "portico-docker-cleanup.sh");
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(cleanupScript, "#!/bin/bash\n", "utf8");

  let cleanupCalls = 0;
  let releaseFirstCleanup;
  const firstCleanupBlocked = new Promise((resolve) => {
    releaseFirstCleanup = resolve;
  });
  const runProcess = async (command) => {
    if (command === "docker") return { stdout: "", stderr: "", code: 0 };
    cleanupCalls += 1;
    if (cleanupCalls === 1) await firstCleanupBlocked;
    return { stdout: "", stderr: "", code: 0 };
  };

  try {
    const first = runDockerStorageMaintenance({
      projectRoot,
      includeMigration: false,
      expectedCurrentTag: "07172026-aabbccdd",
      expectedPreviousTag: "07162026-1122aabb",
      runProcess,
    });
    while (cleanupCalls === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const second = runDockerStorageMaintenance({
      projectRoot,
      includeMigration: false,
      expectedCurrentTag: "07172026-aabbccdd",
      expectedPreviousTag: "07162026-1122aabb",
      runProcess,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cleanupCalls, 1);

    releaseFirstCleanup();
    const results = await Promise.all([first, second]);
    assert.equal(cleanupCalls, 2);
    assert.equal(results.every((result) => result.success), true);
  } finally {
    releaseFirstCleanup();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("maintenance resolves bundled scripts before stale managed fallbacks", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portico-maintenance-"));
  const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), "portico-resources-"));
  const managedScript = path.join(projectRoot, "src", "scripts", "portico-docker-cleanup.sh");
  const bundledScript = path.join(resourcesPath, "prereq-scripts", "portico-docker-cleanup.sh");
  fs.mkdirSync(path.dirname(managedScript), { recursive: true });
  fs.mkdirSync(path.dirname(bundledScript), { recursive: true });
  fs.writeFileSync(managedScript, "managed", "utf8");
  fs.writeFileSync(bundledScript, "bundled", "utf8");

  try {
    assert.equal(
      resolveMaintenanceScript("portico-docker-cleanup.sh", {
        projectRoot,
        resourcesPath,
      }),
      bundledScript,
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(resourcesPath, { recursive: true, force: true });
  }
});

test("packaged resources include cleanup scripts and their sourced dependency", () => {
  const packageJson = require(path.resolve(__dirname, "..", "..", "package.json"));
  assert(
    packageJson.build.extraResources.some(
      (entry) => entry.from === "../src/scripts" && entry.to === "prereq-scripts",
    ),
  );

  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  for (const script of [
    "portico-docker-cleanup.sh",
    "migrate-buildkit-gc-policy.sh",
    "mcp-orc-backend.sh",
  ]) {
    assert.equal(fs.existsSync(path.join(repoRoot, "src", "scripts", script)), true);
  }
});

test("installer runs the one-time migration without destructive image cleanup", () => {
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  const installer = fs.readFileSync(path.join(repoRoot, "install_v2.sh"), "utf8");
  const buildStart = installer.indexOf("build_docker_images() {");
  const buildEnd = installer.indexOf("\n}\n", buildStart);
  const buildFunction = installer.slice(buildStart, buildEnd);

  assert.match(installer, /run_buildkit_policy_migration\n/);
  const migrationFunction = installer.slice(
    installer.indexOf("run_buildkit_policy_migration() {"),
    installer.indexOf("build_docker_images() {"),
  );
  assert.doesNotMatch(migrationFunction, /portico-docker-cleanup\.sh|--apply/);
  assert.doesNotMatch(buildFunction, /run_harbor_image_cleanup|portico-docker-cleanup/);
});
