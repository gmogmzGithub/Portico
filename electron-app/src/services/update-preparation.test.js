const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  COMMUNITY_DOCKER_IMAGES_TO_PULL,
  buildFallbackHarborImageSpecs,
} = require("./docker-image-plan");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const updatePreparationPath = path.join(
  repoRoot,
  "electron-app",
  "src",
  "services",
  "update-preparation.js",
);
const bootstrapPath = path.join(
  repoRoot,
  "electron-app",
  "src",
  "services",
  "bootstrap.js",
);
const prerequisitesServicePath = path.join(
  repoRoot,
  "electron-app",
  "src",
  "services",
  "prerequisites-service.js",
);
const dockerMcpPath = path.join(
  repoRoot,
  "electron-app",
  "src",
  "services",
  "docker-mcp.js",
);
const sharedStatePath = path.join(
  repoRoot,
  "electron-app",
  "src",
  "services",
  "shared-state.js",
);
const webContentsSafePath = path.join(
  repoRoot,
  "electron-app",
  "src",
  "services",
  "webcontents-safe.js",
);
const dockerStorageMaintenancePath = path.join(
  repoRoot,
  "electron-app",
  "src",
  "services",
  "docker-storage-maintenance.js",
);
const diskSpacePath = path.join(
  repoRoot,
  "electron-app",
  "src",
  "services",
  "disk-space.js",
);
const reconcileStrandCleanupPath = path.join(
  repoRoot,
  "electron-app",
  "src",
  "services",
  "reconcile-strand-cleanup.js",
);
const prepareUpdateScriptPath = path.join(
  repoRoot,
  "electron-app",
  "src",
  "scripts",
  "prepare-update-cloudsmith.sh",
);
const TEST_BUILD_NUMBER = "03102026-deadbeef";

function buildReleaseDockerImages(buildNumber = TEST_BUILD_NUMBER) {
  return [
    ...COMMUNITY_DOCKER_IMAGES_TO_PULL.map((image) => ({ ...image })),
    ...buildFallbackHarborImageSpecs({
      tag: buildNumber,
      mcpMode: "rust-full",
      llmGatewayMode: "bifrost",
    }),
  ];
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createUpdateInfo({
  buildNumber = TEST_BUILD_NUMBER,
  checksum = "abc",
} = {}) {
  return {
    downloadUrl: "https://updates.example.test/payload.zip",
    filename: `${buildNumber}.zip`,
    latestBuildNumber: buildNumber,
    updateChannel: "portico",
    checksum: { sha256: checksum },
    fileSize: 1024,
  };
}

function loadUpdatePreparationModule(options = {}) {
  const previousAppSupportDir = process.env.PORTICO_APP_SUPPORT_DIR;
  if (options.appSupportDir) {
    process.env.PORTICO_APP_SUPPORT_DIR = options.appSupportDir;
  } else {
    delete process.env.PORTICO_APP_SUPPORT_DIR;
  }
  require.cache[bootstrapPath] = {
    id: bootstrapPath,
    filename: bootstrapPath,
    loaded: true,
    exports: {
      PROJECT_ROOT: repoRoot,
    },
  };
  require.cache[prerequisitesServicePath] = {
    id: prerequisitesServicePath,
    filename: prerequisitesServicePath,
    loaded: true,
    exports: {
      ...(options.prerequisitesService || {}),
    },
  };
  require.cache[dockerMcpPath] = {
    id: dockerMcpPath,
    filename: dockerMcpPath,
    loaded: true,
    exports: {
      ensureDockerRunning: async () => true,
      restartOrbStackAndWaitForDocker: async () => ({ success: true, method: "orbctl" }),
      ...(options.dockerMcp || {}),
    },
  };
  require.cache[sharedStatePath] = {
    id: sharedStatePath,
    filename: sharedStatePath,
    loaded: true,
    exports: {
      windows: {},
    },
  };
  require.cache[webContentsSafePath] = {
    id: webContentsSafePath,
    filename: webContentsSafePath,
    loaded: true,
    exports: {
      safeWebContentsSend() {},
    },
  };
  require.cache[dockerStorageMaintenancePath] = {
    id: dockerStorageMaintenancePath,
    filename: dockerStorageMaintenancePath,
    loaded: true,
    exports: {
      runDockerStorageMaintenance: async () => ({ success: true }),
      ...(options.dockerStorageMaintenance || {}),
    },
  };
  require.cache[diskSpacePath] = {
    id: diskSpacePath,
    filename: diskSpacePath,
    loaded: true,
    exports: {
      checkPrepareDiskSpace: async () => ({ ok: true }),
      ...(options.diskSpace || {}),
    },
  };
  require.cache[reconcileStrandCleanupPath] = {
    id: reconcileStrandCleanupPath,
    filename: reconcileStrandCleanupPath,
    loaded: true,
    exports: {
      cleanupStaleReconcileStrands: async () => ({ removed: [], failed: [] }),
      ...(options.reconcileStrandCleanup || {}),
    },
  };

  delete require.cache[updatePreparationPath];
  const loaded = require(updatePreparationPath);

  if (previousAppSupportDir === undefined) {
    delete process.env.PORTICO_APP_SUPPORT_DIR;
  } else {
    process.env.PORTICO_APP_SUPPORT_DIR = previousAppSupportDir;
  }

  return loaded;
}

function withTempStage(fn) {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "update-preparation-test-"),
  );

  let result;
  try {
    result = fn(tempDir);
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }

  if (result && typeof result.then === "function") {
    return result.finally(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
  return result;
}

function createPreparedStage(stageDir, channel = "portico") {
  const dockerImages = buildReleaseDockerImages();
  const payloadDir = path.join(stageDir, "payload");
  const managedRootDir = path.join(payloadDir, "managed-root");
  const appBundle = path.join(
    payloadDir,
    "artifacts",
    "apps",
    "darwin-arm64",
    "Portico.app",
  );
  const dmgPath = path.join(
    payloadDir,
    "artifacts",
    "dmg",
    "darwin-arm64",
    "Portico-arm64.dmg",
  );
  const buildInfoPath = path.join(managedRootDir, "electron-app", "build-info.json");
  const releaseManifestPath = path.join(payloadDir, "release-manifest.json");
  const manifestPath = path.join(stageDir, "manifest.json");

  fs.mkdirSync(path.dirname(buildInfoPath), { recursive: true });
  fs.mkdirSync(path.join(appBundle, "Contents", "MacOS"), { recursive: true });
  fs.mkdirSync(path.dirname(dmgPath), { recursive: true });

  fs.writeFileSync(
    buildInfoPath,
    JSON.stringify({
      buildNumber: TEST_BUILD_NUMBER,
      channel,
    }),
    "utf8",
  );
  fs.writeFileSync(path.join(appBundle, "Contents", "MacOS", "Portico"), "", "utf8");
  fs.writeFileSync(dmgPath, "dmg-bytes", "utf8");
  fs.writeFileSync(
    releaseManifestPath,
    JSON.stringify(
      {
        schemaVersion: 2,
        buildNumber: TEST_BUILD_NUMBER,
        fullSha: "deadbeefcafefeed",
        channelPackageName: channel,
        managedRootDir: "managed-root",
        dockerImageTag: TEST_BUILD_NUMBER,
        dockerImages,
        appBundles: {
          "darwin-arm64": "artifacts/apps/darwin-arm64/Portico.app",
          "darwin-x64": "artifacts/apps/darwin-x64/Portico.app",
        },
        dmgs: {
          "darwin-arm64": "artifacts/dmg/darwin-arm64/Portico-arm64.dmg",
          "darwin-x64": "artifacts/dmg/darwin-x64/Portico-x64.dmg",
        },
        hostMcpTargets: ["darwin-arm64", "darwin-x64"],
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        updateKey: `03102026-deadbeef|sha256:abc|${channel}`,
        stageDir,
        sourceDir: payloadDir,
        managedRootDir,
        selectedAppBundle: appBundle,
        selectedDmg: dmgPath,
        buildInfoPath,
        manifestPath,
        releaseManifestPath,
        selectedArch: "darwin-arm64",
        dockerImages,
        installMode: "applications",
        backupRequired: false,
        fullBackupPath: "",
        checksumAlgorithm: "sha256",
        checksumValue: "abc",
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    payloadDir,
    managedRootDir,
    appBundle,
    dmgPath,
    buildInfoPath,
    manifestPath,
    releaseManifestPath,
    updateKey: `03102026-deadbeef|sha256:abc|${channel}`,
    checksumAlgorithm: "sha256",
    checksumValue: "abc",
  };
}

function readPreparedMetadata(prepared) {
  return {
    ...JSON.parse(fs.readFileSync(prepared.manifestPath, "utf8")),
    dockerImages: buildReleaseDockerImages(),
  };
}

test("packaged preparation uses the bundled script instead of a stale managed-runtime copy", () => {
  const updatePreparation = loadUpdatePreparationModule();

  withTempStage((tempDir) => {
    const resourcesPath = path.join(tempDir, "app-resources");
    const managedRoot = path.join(tempDir, "managed-runtime");
    const bundledScript = path.join(
      resourcesPath,
      "prereq-scripts",
      "prepare-update-cloudsmith.sh",
    );
    const staleManagedScript = path.join(
      managedRoot,
      "electron-app",
      "src",
      "scripts",
      "prepare-update-cloudsmith.sh",
    );
    fs.mkdirSync(path.dirname(bundledScript), { recursive: true });
    fs.mkdirSync(path.dirname(staleManagedScript), { recursive: true });
    fs.writeFileSync(bundledScript, "#!/bin/sh\n# current bundled script\n", "utf8");
    fs.writeFileSync(staleManagedScript, "#!/bin/sh\n# stale managed script\n", "utf8");

    assert.equal(
      updatePreparation._test.resolvePrepareScriptPath({
        isPackaged: true,
        resourcesPath,
        projectRoot: managedRoot,
      }),
      bundledScript,
    );

    fs.rmSync(bundledScript);
    assert.throws(
      () => updatePreparation._test.resolvePrepareScriptPath({
        isPackaged: true,
        resourcesPath,
        projectRoot: managedRoot,
      }),
      /Packaged prepare script not found/,
    );
  });
});

test("loadPreparedArtifacts reads managed-root and app bundle metadata from staged manifest", () => {
  const updatePreparation = loadUpdatePreparationModule();

  withTempStage((stageDir) => {
    const prepared = createPreparedStage(stageDir);
    const result = updatePreparation._test.loadPreparedArtifacts(
      stageDir,
      {
        manifestPath: prepared.manifestPath,
        updateInfo: {
          checksum: { sha256: "abc" },
          lastModified: "2026-03-10T15:00:00.000Z",
        },
      },
      "03102026-deadbeef|sha256:abc|portico",
    );

    assert.equal(result.managedRootDir, prepared.managedRootDir);
    assert.equal(result.selectedAppBundle, prepared.appBundle);
    assert.equal(result.selectedDmg, prepared.dmgPath);
    assert.equal(result.selectedArch, "darwin-arm64");
    assert.equal(result.dockerImages.length, buildReleaseDockerImages().length);
    assert(
      result.dockerImages.some(
        (image) =>
          image.name === "harbor.example.invalid/portico/agent-vm" &&
          image.tag === TEST_BUILD_NUMBER,
      ),
    );
    assert.equal(result.installMode, "applications");
    assert.equal(result.releaseManifestPath, prepared.releaseManifestPath);
  });
});

test("loadReleaseManifest requires schema v2 and payload-declared docker images", () => {
  const updatePreparation = loadUpdatePreparationModule();

  withTempStage((stageDir) => {
    const prepared = createPreparedStage(stageDir);
    const manifest = updatePreparation._test.loadReleaseManifest(
      prepared.releaseManifestPath,
    );
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.dockerImages.length, buildReleaseDockerImages().length);

    fs.writeFileSync(
      prepared.releaseManifestPath,
      JSON.stringify(
        {
          ...manifest,
          schemaVersion: 1,
          dockerImages: undefined,
        },
        null,
        2,
      ),
      "utf8",
    );

    assert.throws(
      () => updatePreparation._test.loadReleaseManifest(prepared.releaseManifestPath),
      /missing staged-update Docker metadata|missing a valid dockerImages list/,
    );
  });
});

test("validatePreparedArtifactsForInstall normalizes staged artifacts against the selected arch from the payload", () => {
  const updatePreparation = loadUpdatePreparationModule();

  withTempStage((stageDir) => {
    const prepared = createPreparedStage(stageDir);
    const validation = updatePreparation._test.validatePreparedArtifactsForInstall({
      stageDir,
      sourceDir: prepared.payloadDir,
      managedRootDir: prepared.managedRootDir,
      selectedAppBundle: prepared.appBundle,
      selectedDmg: prepared.dmgPath,
      buildInfoPath: prepared.buildInfoPath,
      manifestPath: prepared.manifestPath,
      releaseManifestPath: prepared.releaseManifestPath,
      selectedArch: "darwin-arm64",
      dockerImages: buildReleaseDockerImages(),
      updateKey: prepared.updateKey,
      checksumAlgorithm: prepared.checksumAlgorithm,
      checksumValue: prepared.checksumValue,
    });
    assert.equal(validation.success, true);
    assert.equal(validation.prepared.selectedArch, "darwin-arm64");
    assert.equal(
      validation.prepared.dockerImages.length,
      buildReleaseDockerImages().length,
    );
    assert.equal(validation.prepared.selectedAppBundle, prepared.appBundle);
    assert.equal(validation.prepared.selectedDmg, prepared.dmgPath);
  });
});

test("prepared artifact validation preserves canonical custom channel identity", () => {
  const updatePreparation = loadUpdatePreparationModule();

  withTempStage((stageDir) => {
    const channel = "portico_team-alpha";
    const prepared = createPreparedStage(stageDir, channel);
    const validation = updatePreparation._test.validatePreparedArtifactsForInstall(
      readPreparedMetadata(prepared),
    );

    assert.equal(validation.success, true);
    assert.equal(validation.prepared.channel, channel);
    assert.equal(validation.prepared.updateKey, prepared.updateKey);
  });
});

test("clearing preparation removes staged payloads so a prior channel cannot recover", () => {
  withTempStage((tempDir) => {
    const appSupportDir = path.join(tempDir, "app-support");
    const stageDir = path.join(appSupportDir, "update-prep", "custom-stage");
    createPreparedStage(stageDir, "portico_team-alpha");
    const updatePreparation = loadUpdatePreparationModule({ appSupportDir });

    updatePreparation.initialize();
    assert.equal(updatePreparation.getPreparationStatus().prepared !== null, true);
    const result = updatePreparation.clearPreparation("release-channel-changed");

    assert.equal(result.success, true);
    assert.equal(result.status.state, "idle");
    assert.equal(result.status.prepared, null);
    assert.equal(fs.existsSync(stageDir), false);
  });
});

test("arePreparedArtifactsValid rejects payloads whose prepared selection does not match the declared selected arch", () => {
  const updatePreparation = loadUpdatePreparationModule();

  withTempStage((stageDir) => {
    const prepared = createPreparedStage(stageDir);
    const wrongArchApp = path.join(
      prepared.payloadDir,
      "artifacts",
      "apps",
      "darwin-x64",
      "Portico.app",
    );
    fs.mkdirSync(path.join(wrongArchApp, "Contents", "MacOS"), { recursive: true });
    fs.writeFileSync(
      path.join(wrongArchApp, "Contents", "MacOS", "Portico"),
      "",
      "utf8",
    );

    const invalid = updatePreparation._test.arePreparedArtifactsValid({
      stageDir,
      sourceDir: prepared.payloadDir,
      managedRootDir: prepared.managedRootDir,
      selectedAppBundle: wrongArchApp,
      selectedDmg: prepared.dmgPath,
      buildInfoPath: prepared.buildInfoPath,
      manifestPath: prepared.manifestPath,
      releaseManifestPath: prepared.releaseManifestPath,
      selectedArch: "darwin-arm64",
      dockerImages: buildReleaseDockerImages(),
      updateKey: prepared.updateKey,
      checksumAlgorithm: prepared.checksumAlgorithm,
      checksumValue: prepared.checksumValue,
    });
    assert.equal(invalid, false);
  });
});

test("prepared artifact validation rejects corrupt manifests, missing backups, missing checksums, and escaped paths", () => {
  const updatePreparation = loadUpdatePreparationModule();

  withTempStage((stageDir) => {
    const prepared = createPreparedStage(stageDir);
    const metadata = readPreparedMetadata(prepared);

    assert.equal(
      updatePreparation._test.validatePreparedArtifactsForInstall({
        ...metadata,
        checksumValue: "",
      }).success,
      false,
    );

    const missingBackupMetadata = {
      ...metadata,
      backupRequired: true,
      fullBackupPath: path.join(stageDir, "backup", "missing.zip"),
    };
    assert.match(
      updatePreparation._test.validatePreparedArtifactsForInstall(
        missingBackupMetadata,
      ).error,
      /backup archive is missing/,
    );

    const outsideSource = path.join(path.dirname(stageDir), "outside-payload");
    const escapedManifest = {
      ...metadata,
      sourceDir: outsideSource,
    };
    fs.writeFileSync(
      prepared.manifestPath,
      `${JSON.stringify(escapedManifest, null, 2)}\n`,
      "utf8",
    );
    assert.match(
      updatePreparation._test.validatePreparedArtifactsForInstall(
        escapedManifest,
      ).error,
      /source path escapes the staging directory/,
    );

    fs.writeFileSync(prepared.manifestPath, "{not-json", "utf8");
    assert.match(
      updatePreparation._test.validatePreparedArtifactsForInstall(metadata).error,
      /Failed to parse prepared manifest\.json/,
    );
  });
});

test("restart handoff validation ignores a missing pre-apply backup archive (PORTICO-318)", () => {
  const updatePreparation = loadUpdatePreparationModule();

  withTempStage((stageDir) => {
    const prepared = createPreparedStage(stageDir);
    const metadata = readPreparedMetadata(prepared);

    const missingBackupMetadata = {
      ...metadata,
      backupRequired: true,
      fullBackupPath: path.join(stageDir, "backup", "missing.zip"),
    };

    // Pre-apply callers (default) still require the backup safety net.
    assert.match(
      updatePreparation._test.validatePreparedArtifactsForInstall(
        missingBackupMetadata,
      ).error,
      /backup archive is missing/,
    );

    // The post-apply restart handoff opts out: a missing backup must not
    // dead-end an update that already applied.
    const restartValidation =
      updatePreparation._test.validatePreparedArtifactsForInstall(
        missingBackupMetadata,
        { requireBackupArtifact: false },
      );
    assert.equal(restartValidation.success, true, restartValidation.error);
  });
});

test("artifact-staged Docker-incomplete preparation survives restart without becoming UI-ready", () => {
  withTempStage((tempDir) => {
    const appSupportDir = path.join(tempDir, "app-support");
    const preparationRoot = path.join(appSupportDir, "update-prep");
    const stageDir = path.join(preparationRoot, "staged-update");
    const prepared = createPreparedStage(stageDir);
    const metadata = {
      ...readPreparedMetadata(prepared),
      artifactsReady: true,
      dockerReady: false,
      ready: false,
    };
    fs.mkdirSync(preparationRoot, { recursive: true });
    fs.writeFileSync(
      path.join(preparationRoot, "state.json"),
      JSON.stringify(
        {
          state: "preparing",
          updateKey: prepared.updateKey,
          phase: "docker",
          message: "Pulling Docker images...",
          logPath: path.join(appSupportDir, "logs", "update-prep-test.log"),
          prepared: metadata,
        },
        null,
        2,
      ),
      "utf8",
    );

    const updatePreparation = loadUpdatePreparationModule({ appSupportDir });
    updatePreparation.initialize();
    const status = updatePreparation.getPreparationStatus();

    assert.equal(status.state, "interrupted");
    assert.equal(status.phase, "docker");
    assert.equal(status.prepared.artifactsReady, true);
    assert.equal(status.prepared.dockerReady, false);
    assert.equal(status.prepared.ready, false);
    assert.equal(fs.existsSync(prepared.manifestPath), true);
    assert.equal(
      updatePreparation.getPreparedInfoForUpdate({
        latestBuildNumber: TEST_BUILD_NUMBER,
        updateChannel: "portico",
        checksum: { sha256: "abc" },
      }),
      null,
      "interrupted artifacts must not make the normal update UI ready",
    );

    const logContents = fs.readFileSync(status.logPath, "utf8");
    assert.match(logContents, /phase=docker/);
    assert.match(logContents, /quitProvenance=user\/OS\/external/);
  });
});

test("startup discovers valid staged artifacts discarded by an older beta state file", () => {
  withTempStage((tempDir) => {
    const appSupportDir = path.join(tempDir, "app-support");
    const preparationRoot = path.join(appSupportDir, "update-prep");
    const stageDir = path.join(preparationRoot, "legacy-beta-stage");
    const prepared = createPreparedStage(stageDir);
    fs.mkdirSync(preparationRoot, { recursive: true });
    fs.writeFileSync(
      path.join(preparationRoot, "state.json"),
      JSON.stringify(
        {
          state: "idle",
          updateKey: prepared.updateKey,
          phase: "idle",
          message: "Preparation stopped",
          prepared: null,
        },
        null,
        2,
      ),
      "utf8",
    );

    const updatePreparation = loadUpdatePreparationModule({ appSupportDir });
    updatePreparation.initialize();
    const status = updatePreparation.getPreparationStatus();

    assert.equal(status.state, "interrupted");
    assert.equal(status.phase, "docker");
    assert.equal(status.updateKey, prepared.updateKey);
    assert.equal(status.prepared.manifestPath, prepared.manifestPath);
    assert.equal(status.prepared.ready, false);
    assert.equal(status.prepared.artifactsReady, true);
    assert.equal(fs.existsSync(prepared.manifestPath), true);

    const logContents = fs.readFileSync(status.logPath, "utf8");
    assert.match(logContents, /Discovered validated staged artifacts left by an earlier app/);
    assert.match(logContents, /quitProvenance=user\/OS\/external/);
  });
});

test("update preparation no longer computes Docker images from the live install during staged prep", () => {
  const updatePreparationSource = fs.readFileSync(updatePreparationPath, "utf8");
  assert.doesNotMatch(updatePreparationSource, /getDockerImagesToPull\(/);
  assert.match(updatePreparationSource, /loadReleaseManifest\(/);
  const startPreparationSource = updatePreparationSource.slice(
    updatePreparationSource.indexOf("async function startPreparation"),
    updatePreparationSource.indexOf("function ensureInitialized"),
  );
  assert(
    startPreparationSource.indexOf("await runPreflightDockerStorageMaintenance();") <
      startPreparationSource.indexOf("await checkPrepareDiskSpace({"),
    "expected safe Docker storage maintenance before the existing free-space preflight",
  );
  assert(
    updatePreparationSource.indexOf("await runPrepareScript(job, updateInfo, stageDir, updateKey);") <
      updatePreparationSource.indexOf("await runDockerPreparation(job, prepared.dockerImages);"),
    "expected staged update prep to pull Docker images after payload extraction and manifest parsing",
  );
});

test("same-key update preparation is single-flight during awaited preflight", async () => {
  await withTempStage(async (tempDir) => {
    const appSupportDir = path.join(tempDir, "app-support");
    const cleanupEntered = createDeferred();
    const releaseCleanup = createDeferred();
    let cleanupCalls = 0;
    let maintenanceCalls = 0;
    let diskCalls = 0;

    const updatePreparation = loadUpdatePreparationModule({
      appSupportDir,
      reconcileStrandCleanup: {
        async cleanupStaleReconcileStrands() {
          cleanupCalls += 1;
          if (cleanupCalls === 1) {
            cleanupEntered.resolve();
            await releaseCleanup.promise;
          }
          return { removed: [], failed: [] };
        },
      },
      dockerStorageMaintenance: {
        async runDockerStorageMaintenance() {
          maintenanceCalls += 1;
          return { success: true };
        },
      },
      diskSpace: {
        async checkPrepareDiskSpace() {
          diskCalls += 1;
          return { ok: false, message: "Not enough disk space for test" };
        },
      },
    });
    const updateInfo = createUpdateInfo();
    const updateKey = updatePreparation.buildUpdateKey(updateInfo);

    updatePreparation.initialize();
    const firstStart = updatePreparation.startPreparation(updateInfo);
    await cleanupEntered.promise;

    const duplicate = await updatePreparation.startPreparation(updateInfo);
    assert.equal(duplicate.success, true);
    assert.equal(duplicate.alreadyRunning, true);
    assert.equal(duplicate.preflightBusy, false);
    assert.equal(duplicate.activeUpdateKey, updateKey);
    assert.equal(duplicate.status.state, "preparing");
    assert.equal(duplicate.status.phase, "preflight");
    assert.equal(duplicate.status.updateKey, updateKey);
    assert.equal(cleanupCalls, 1);
    assert.equal(maintenanceCalls, 0);
    assert.equal(diskCalls, 0);

    releaseCleanup.resolve();
    const firstResult = await firstStart;
    assert.equal(firstResult.success, false);
    assert.match(firstResult.error, /disk space/i);
    assert.equal(cleanupCalls, 1);
    assert.equal(maintenanceCalls, 1);
    assert.equal(diskCalls, 1);

    const preparationRoot = path.join(appSupportDir, "update-prep");
    const stageDirectories = fs
      .readdirSync(preparationRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory());
    assert.equal(stageDirectories.length, 0);

    const retry = await updatePreparation.startPreparation(updateInfo);
    assert.notEqual(retry.alreadyRunning, true);
    assert.equal(retry.success, false);
    assert.equal(cleanupCalls, 2);
    assert.equal(diskCalls, 2);
  });
});

test("different update key waits behind the reserved preflight window", async () => {
  await withTempStage(async (tempDir) => {
    const appSupportDir = path.join(tempDir, "app-support");
    const cleanupEntered = createDeferred();
    const releaseCleanup = createDeferred();
    let cleanupCalls = 0;
    let diskCalls = 0;

    const updatePreparation = loadUpdatePreparationModule({
      appSupportDir,
      reconcileStrandCleanup: {
        async cleanupStaleReconcileStrands() {
          cleanupCalls += 1;
          if (cleanupCalls === 1) {
            cleanupEntered.resolve();
            await releaseCleanup.promise;
          }
          return { removed: [], failed: [] };
        },
      },
      diskSpace: {
        async checkPrepareDiskSpace() {
          diskCalls += 1;
          return { ok: false, message: "Not enough disk space for test" };
        },
      },
    });
    const firstInfo = createUpdateInfo();
    const secondInfo = createUpdateInfo({
      buildNumber: "03112026-feedface",
      checksum: "def",
    });
    const firstKey = updatePreparation.buildUpdateKey(firstInfo);

    updatePreparation.initialize();
    const firstStart = updatePreparation.startPreparation(firstInfo);
    await cleanupEntered.promise;

    const blockedSecond = await updatePreparation.startPreparation(secondInfo);
    assert.equal(blockedSecond.success, true);
    assert.equal(blockedSecond.alreadyRunning, true);
    assert.equal(blockedSecond.preflightBusy, true);
    assert.equal(blockedSecond.activeUpdateKey, firstKey);
    assert.equal(blockedSecond.status.updateKey, firstKey);
    assert.equal(cleanupCalls, 1);
    assert.equal(diskCalls, 0);

    releaseCleanup.resolve();
    await firstStart;

    const secondRetry = await updatePreparation.startPreparation(secondInfo);
    assert.notEqual(secondRetry.alreadyRunning, true);
    assert.equal(secondRetry.success, false);
    assert.equal(cleanupCalls, 2);
    assert.equal(diskCalls, 2);
  });
});

test("preflight exceptions release the update preparation reservation", async () => {
  await withTempStage(async (tempDir) => {
    const appSupportDir = path.join(tempDir, "app-support");
    let cleanupCalls = 0;
    let shouldThrow = true;

    const updatePreparation = loadUpdatePreparationModule({
      appSupportDir,
      reconcileStrandCleanup: {
        async cleanupStaleReconcileStrands() {
          cleanupCalls += 1;
          if (shouldThrow) {
            throw new Error("test cleanup failure");
          }
          return { removed: [], failed: [] };
        },
      },
      dockerStorageMaintenance: {
        async runDockerStorageMaintenance() {
          throw new Error("test maintenance failure");
        },
      },
      diskSpace: {
        async checkPrepareDiskSpace() {
          return { ok: false, message: "Not enough disk space for test" };
        },
      },
    });
    const updateInfo = createUpdateInfo();

    updatePreparation.initialize();
    await assert.rejects(
      updatePreparation.startPreparation(updateInfo),
      /test cleanup failure/,
    );

    shouldThrow = false;
    const retry = await updatePreparation.startPreparation(updateInfo);
    assert.notEqual(retry.alreadyRunning, true);
    assert.equal(retry.success, false);
    assert.match(retry.error, /disk space/i);
    assert.equal(cleanupCalls, 2);

    const logContents = fs.readFileSync(retry.status.logPath, "utf8");
    assert.match(
      logContents,
      /Docker storage maintenance failed before disk preflight: test maintenance failure/,
    );
  });
});

test("update preparation tracks stage-level download progress and writes a dedicated prep log", () => {
  withTempStage((tempDir) => {
    const appSupportDir = path.join(tempDir, "app-support");
    const updatePreparation = loadUpdatePreparationModule({ appSupportDir });

    updatePreparation.initialize();
    updatePreparation._test.setPreparingState("03122026-deadbeef|sha256:abc|portico");
    updatePreparation._test.handlePrepareScriptLine("[UPDATE_PREP:STEP:DOWNLOAD:START]", {});
    updatePreparation._test.handlePrepareScriptLine("[UPDATE_PREP:DOWNLOAD:TOTAL_BYTES:100]", {});
    updatePreparation._test.handlePrepareScriptLine("[UPDATE_PREP:DOWNLOAD:BYTES:40]", {});
    updatePreparation._test.handlePrepareScriptLine("[UPDATE_PREP:DOWNLOAD:PERCENT:40]", {});

    const status = updatePreparation._test.getPreparationStatus();
    assert.equal(status.phase, "download");
    assert.equal(status.phasePercent, 40);
    assert.equal(status.download.totalBytes, 100);
    assert.equal(status.download.downloadedBytes, 40);
    assert.equal(status.download.percent, 40);
    assert.match(status.phaseDetail, /40 B \/ 100 B downloaded/);
    assert.match(status.logPath, /update-prep-\d{4}-\d{2}-\d{2}\.log$/);

    const logContents = fs.readFileSync(status.logPath, "utf8");
    assert.match(logContents, /Downloading update payload/);
  });
});

test("update preparation diagnostics redact credential-bearing download URLs", () => {
  const updatePreparation = loadUpdatePreparationModule();
  const redacted = updatePreparation._test.redactDownloadUrl(
    "https://dl.artifacts.example.invalid/super-secret-token/portico/raw/package.zip",
  );
  assert.equal(redacted, "https://dl.artifacts.example.invalid/[redacted]");
  assert.doesNotMatch(redacted, /super-secret-token/);
});

test("update preflight ensures Docker before best-effort storage maintenance", async () => {
  const calls = [];
  const updatePreparation = loadUpdatePreparationModule({
    dockerMcp: {
      ensureDockerRunning: async () => {
        calls.push("docker-ready");
        return true;
      },
    },
    dockerStorageMaintenance: {
      runDockerStorageMaintenance: async (options) => {
        calls.push("maintenance");
        assert.equal(options.projectRoot, repoRoot);
        assert.equal(options.includeMigration, true);
        assert.equal(options.includeCleanup, false);
        return { success: false };
      },
    },
  });

  const result =
    await updatePreparation._test.runPreflightDockerStorageMaintenance();
  assert.equal(result.success, false);
  assert.deepEqual(calls, ["docker-ready", "maintenance"]);
});

test("update preflight skips maintenance nonfatally when Docker is unavailable", async () => {
  let maintenanceCalls = 0;
  const updatePreparation = loadUpdatePreparationModule({
    dockerMcp: {
      ensureDockerRunning: async () => false,
    },
    dockerStorageMaintenance: {
      runDockerStorageMaintenance: async () => {
        maintenanceCalls += 1;
        return { success: true };
      },
    },
  });

  const result =
    await updatePreparation._test.runPreflightDockerStorageMaintenance();
  assert.equal(result.skipped, true);
  assert.equal(maintenanceCalls, 0);
});

test("update preparation auto-recovers once after Docker readiness failure", async () => {
  await withTempStage(async (tempDir) => {
    const appSupportDir = path.join(tempDir, "app-support");
    let ensureDockerRunningCalls = 0;
    let restartOrbStackCalls = 0;
    let pullDockerImagesCalls = 0;
    let resetCancellationCalls = 0;

    const updatePreparation = loadUpdatePreparationModule({
      appSupportDir,
      prerequisitesService: {
        resetPrerequisitesCancellation() {
          resetCancellationCalls += 1;
        },
        async pullDockerImagesWithProgress() {
          pullDockerImagesCalls += 1;
          return {
            success: true,
            pulled: ["nginx:alpine"],
            failed: [],
            failureDetails: [],
          };
        },
      },
      dockerMcp: {
        async ensureDockerRunning() {
          ensureDockerRunningCalls += 1;
          return ensureDockerRunningCalls > 1;
        },
        async restartOrbStackAndWaitForDocker() {
          restartOrbStackCalls += 1;
          return { success: true, method: "orbctl" };
        },
      },
    });

    updatePreparation.initialize();
    updatePreparation._test.setPreparingState("03122026-deadbeef|sha256:abc|portico");
    await updatePreparation._test.runDockerPreparation(
      {
        releaseManifestPath: path.join(tempDir, "release-manifest.json"),
        cancelled: false,
      },
      buildReleaseDockerImages(),
    );

    const logContents = fs.readFileSync(
      updatePreparation._test.getPreparationStatus().logPath,
      "utf8",
    );
    assert.equal(ensureDockerRunningCalls, 2);
    assert.equal(restartOrbStackCalls, 1);
    assert.equal(pullDockerImagesCalls, 1);
    assert.equal(resetCancellationCalls, 2);
    assert.match(logContents, /Docker stalled; restarting OrbStack/);
    assert.match(logContents, /Retrying Docker image preparation\.\.\. \(2\/2\)/);
    assert.match(logContents, /Docker recovered after OrbStack restart/);
  });
});

test("update preparation auto-recovers once after Docker runtime pull failure", async () => {
  await withTempStage(async (tempDir) => {
    const appSupportDir = path.join(tempDir, "app-support");
    let pullDockerImagesCalls = 0;
    let restartOrbStackCalls = 0;

    const updatePreparation = loadUpdatePreparationModule({
      appSupportDir,
      prerequisitesService: {
        resetPrerequisitesCancellation() {},
        async pullDockerImagesWithProgress() {
          pullDockerImagesCalls += 1;
          if (pullDockerImagesCalls === 1) {
            return {
              success: false,
              pulled: [],
              failed: ["nginx:alpine"],
              failureDetails: [
                {
                  image: "nginx:alpine",
                  failureKind: "daemon_unavailable",
                  error: "Cannot connect to the Docker daemon",
                },
              ],
            };
          }
          return {
            success: true,
            pulled: ["nginx:alpine"],
            failed: [],
            failureDetails: [],
          };
        },
      },
      dockerMcp: {
        async ensureDockerRunning() {
          return true;
        },
        async restartOrbStackAndWaitForDocker() {
          restartOrbStackCalls += 1;
          return { success: true, method: "orbctl" };
        },
      },
    });

    updatePreparation.initialize();
    updatePreparation._test.setPreparingState("03122026-deadbeef|sha256:abc|portico");
    await updatePreparation._test.runDockerPreparation(
      {
        releaseManifestPath: path.join(tempDir, "release-manifest.json"),
        cancelled: false,
      },
      buildReleaseDockerImages(),
    );

    assert.equal(pullDockerImagesCalls, 2);
    assert.equal(restartOrbStackCalls, 1);
  });
});

test("update preparation does not auto-recover non-Docker pull failures", async () => {
  await withTempStage(async (tempDir) => {
    const appSupportDir = path.join(tempDir, "app-support");
    let restartOrbStackCalls = 0;
    let pullDockerImagesCalls = 0;

    const updatePreparation = loadUpdatePreparationModule({
      appSupportDir,
      prerequisitesService: {
        resetPrerequisitesCancellation() {},
        async pullDockerImagesWithProgress() {
          pullDockerImagesCalls += 1;
          return {
            success: false,
            pulled: [],
            failed: ["harbor.example.invalid/portico/mcp-orc-rust:03102026-deadbeef"],
            failureDetails: [
              {
                image: "harbor.example.invalid/portico/mcp-orc-rust:03102026-deadbeef",
                failureKind: "registry_denied",
                error: "requested access to the resource is denied",
              },
            ],
          };
        },
      },
      dockerMcp: {
        async ensureDockerRunning() {
          return true;
        },
        async restartOrbStackAndWaitForDocker() {
          restartOrbStackCalls += 1;
          return { success: true, method: "orbctl" };
        },
      },
    });

    updatePreparation.initialize();
    updatePreparation._test.setPreparingState("03122026-deadbeef|sha256:abc|portico");
    await assert.rejects(
      updatePreparation._test.runDockerPreparation(
        {
          releaseManifestPath: path.join(tempDir, "release-manifest.json"),
          cancelled: false,
        },
        buildReleaseDockerImages(),
      ),
      /Failed to pull Docker images/,
    );

    assert.equal(pullDockerImagesCalls, 1);
    assert.equal(restartOrbStackCalls, 0);
  });
});

test("update preparation surfaces snapshot repair failure without a second recovery owner", async () => {
  await withTempStage(async (tempDir) => {
    const appSupportDir = path.join(tempDir, "app-support");
    let pullDockerImagesCalls = 0;
    let restartOrbStackCalls = 0;
    const dockerPullResult = {
      success: false,
      pulled: [],
      failed: ["nginx:alpine"],
      failureDetails: [
        {
          image: "nginx:alpine",
          failureKind: "overlayfs_snapshot_parent_missing",
          retryable: false,
          error: "missing overlayfs parent snapshot",
        },
      ],
      snapshotStoreRepair: {
        attempted: true,
        success: false,
        error: "PORTICO container still exists",
      },
      snapshotStoreRepairError: "owner-provided terminal repair failure",
    };
    const updatePreparation = loadUpdatePreparationModule({
      appSupportDir,
      prerequisitesService: {
        resetPrerequisitesCancellation() {},
        async pullDockerImagesWithProgress() {
          pullDockerImagesCalls += 1;
          return dockerPullResult;
        },
      },
      dockerMcp: {
        async ensureDockerRunning() {
          return true;
        },
        async restartOrbStackAndWaitForDocker() {
          restartOrbStackCalls += 1;
          return { success: true, method: "orbctl" };
        },
      },
    });

    updatePreparation.initialize();
    updatePreparation._test.setPreparingState("03122026-deadbeef|sha256:abc|portico");
    let failure = null;
    try {
      await updatePreparation._test.runDockerPreparation(
        {
          releaseManifestPath: path.join(tempDir, "release-manifest.json"),
          cancelled: false,
        },
        buildReleaseDockerImages(),
      );
    } catch (error) {
      failure = error;
    }

    assert(failure);
    assert.equal(failure.code, "docker_snapshot_store_repair_required");
    assert.equal(failure.dockerPullResult, dockerPullResult);
    assert.equal(pullDockerImagesCalls, 1);
    assert.equal(restartOrbStackCalls, 0);
    assert.equal(
      updatePreparation._test.translatePreparationError(failure),
      "owner-provided terminal repair failure",
    );
  });
});

test("update preparation stops after the second Docker runtime failure", async () => {
  await withTempStage(async (tempDir) => {
    const appSupportDir = path.join(tempDir, "app-support");
    let pullDockerImagesCalls = 0;
    let restartOrbStackCalls = 0;

    const updatePreparation = loadUpdatePreparationModule({
      appSupportDir,
      prerequisitesService: {
        resetPrerequisitesCancellation() {},
        async pullDockerImagesWithProgress() {
          pullDockerImagesCalls += 1;
          return {
            success: false,
            pulled: [],
            failed: ["nginx:alpine"],
            failureDetails: [
              {
                image: "nginx:alpine",
                failureKind: "daemon_unavailable",
                error: "Cannot connect to the Docker daemon",
              },
            ],
          };
        },
      },
      dockerMcp: {
        async ensureDockerRunning() {
          return true;
        },
        async restartOrbStackAndWaitForDocker() {
          restartOrbStackCalls += 1;
          return { success: true, method: "orbctl" };
        },
      },
    });

    updatePreparation.initialize();
    updatePreparation._test.setPreparingState("03122026-deadbeef|sha256:abc|portico");
    await assert.rejects(
      updatePreparation._test.runDockerPreparation(
        {
          releaseManifestPath: path.join(tempDir, "release-manifest.json"),
          cancelled: false,
        },
        buildReleaseDockerImages(),
      ),
      /Failed to pull Docker images: nginx:alpine/,
    );

    assert.equal(pullDockerImagesCalls, 2);
    assert.equal(restartOrbStackCalls, 1);
  });
});

test("update preparation stores machine-readable prep script errors", () => {
  const updatePreparation = loadUpdatePreparationModule();
  const job = {};

  updatePreparation._test.handlePrepareScriptLine(
    "[UPDATE_PREP:ERROR:Failed to download update payload after 3 attempts: curl: (56) Recv failure: Connection reset by peer]",
    job,
  );

  assert.equal(
    job.scriptError,
    "Failed to download update payload after 3 attempts: curl: (56) Recv failure: Connection reset by peer",
  );
});

test("missing Command Line Tools recovery survives prep error parsing", () => {
  const updatePreparation = loadUpdatePreparationModule();
  const job = {};
  const message =
    "Apple Command Line Tools are missing or incomplete. Run xcode-select --install, finish Apple's installer, then retry the update";

  updatePreparation._test.handlePrepareScriptLine(
    `[UPDATE_PREP:ERROR:${message}]`,
    job,
  );

  assert.equal(job.scriptError, message);
  assert.equal(
    updatePreparation._test.resolvePrepareScriptFailureMessage(job, 1),
    message,
  );
});

test("update preparation prefers machine-readable prep script errors over generic exit codes", () => {
  const updatePreparation = loadUpdatePreparationModule();

  const preferred = updatePreparation._test.resolvePrepareScriptFailureMessage(
    {
      scriptError: "Failed to download update payload after 3 attempts: curl: (56) Recv failure: Connection reset by peer",
    },
    1,
  );
  const fallback = updatePreparation._test.resolvePrepareScriptFailureMessage({}, 1);

  assert.equal(
    preferred,
    "Failed to download update payload after 3 attempts: curl: (56) Recv failure: Connection reset by peer",
  );
  assert.equal(fallback, "prepare script failed with exit code 1");
});

// --- PORTICO-215 disk-full handling ---

test("update preparation flags ENOSPC script output and resolves the disk-full message", () => {
  const updatePreparation = loadUpdatePreparationModule();
  const { DISK_FULL_PREPARE_MESSAGE } = require("./update-failure-message");
  const job = {};

  // Real shape: the backup zip phase reports ENOSPC as plain stderr with no
  // [UPDATE_PREP:ERROR:] marker.
  updatePreparation._test.handlePrepareScriptLine(
    "zip I/O error: No space left on device",
    job,
    "stderr",
  );

  assert.equal(job.diskFullDetected, true);
  assert.equal(
    updatePreparation._test.resolvePrepareScriptFailureMessage(job, 1),
    DISK_FULL_PREPARE_MESSAGE,
  );
});

test("update preparation prefers the disk-full message over unrelated script errors", () => {
  const updatePreparation = loadUpdatePreparationModule();
  const { DISK_FULL_PREPARE_MESSAGE } = require("./update-failure-message");
  const job = { scriptError: "Failed to create prepared backup archive" };

  updatePreparation._test.handlePrepareScriptLine(
    "unzip: write error (disk full?).  Continue? (y/n/^C)",
    job,
    "stdout",
  );

  assert.equal(
    updatePreparation._test.resolvePrepareScriptFailureMessage(job, 1),
    DISK_FULL_PREPARE_MESSAGE,
  );
});

test("update preparation translates ENOSPC errors into the disk-full message", () => {
  const updatePreparation = loadUpdatePreparationModule();
  const { DISK_FULL_PREPARE_MESSAGE } = require("./update-failure-message");

  const enospc = Object.assign(new Error("ENOSPC: no space left on device, mkdir"), {
    code: "ENOSPC",
  });
  assert.equal(
    updatePreparation._test.translatePreparationError(enospc),
    DISK_FULL_PREPARE_MESSAGE,
  );
  assert.equal(
    updatePreparation._test.translatePreparationError(new Error("manifest missing")),
    "manifest missing",
  );
});

test("prepare update script emits machine-readable download progress markers", () => {
  const scriptSource = fs.readFileSync(prepareUpdateScriptPath, "utf8");

  assert.match(scriptSource, /emit_download_marker "TOTAL_BYTES"/);
  assert.match(scriptSource, /emit_download_marker "BYTES"/);
  assert.match(scriptSource, /emit_download_marker "PERCENT"/);
  assert.match(scriptSource, /download_payload_with_retry\(\)/);
  assert.match(scriptSource, /emit_error_marker/);
  assert.match(scriptSource, /EXPECTED_FILE_SIZE="\$\{11:-0\}"/);
});
