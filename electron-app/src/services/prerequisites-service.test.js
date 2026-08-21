const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const { markSetupRequirementCompleted } = require("./setup-completion");
const runtimeSecretsConfig = require("../config/runtime-secrets-config");

const serviceModulePath = require.resolve("./prerequisites-service");
const bootstrapModulePath = require.resolve("./bootstrap");
const prereqLoggerModulePath = require.resolve("./prereq-logger");
const dockerImagePlanModulePath = require.resolve("./docker-image-plan");
const dockerMcpModulePath = require.resolve("./docker-mcp");
const mcpOrcCliModulePath = require.resolve("./mcp-orc-cli");
const updatePreparationModulePath = require.resolve("./update-preparation");
const runtimeSecretsConfigModulePath = require.resolve("../config/runtime-secrets-config");
const cloudsmithConfigModulePath = require.resolve("../config/cloudsmith-config");
const originalLoad = Module._load;

const IMAGE_BASE = "harbor.example.invalid/portico";
const DEFAULT_FULL_IMAGES = [
  { name: "nginx", tag: "alpine", label: "Nginx" },
  { name: `${IMAGE_BASE}/mcp-orc-rust`, tag: "latest", label: "MCP Runtime" },
  { name: `${IMAGE_BASE}/open-webui-patched`, tag: "latest", label: "Open WebUI" },
];

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "prerequisites-service-"));
}

function writeSetupRequirement(appRoot, setupRequirementId) {
  fs.mkdirSync(appRoot, { recursive: true });
  fs.writeFileSync(
    path.join(appRoot, "setup-requirement.json"),
    `${JSON.stringify({ schemaVersion: 1, setupRequirementId }, null, 2)}\n`,
    "utf8",
  );
}

function writeEnv(projectRoot, porticoUserName = "Dionny Santiago") {
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, ".env"),
    `PORTICO_USER_ID=dsantiago\nPORTICO_USER_NAME=${porticoUserName}\n`,
    "utf8",
  );
}

function writeRuntimeFiles(projectRoot, buildNumber = "dev-build") {
  fs.mkdirSync(path.join(projectRoot, "src", "scripts"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "electron-app"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "docker-compose.yml"), "services:\n", "utf8");
  fs.writeFileSync(path.join(projectRoot, "docker-compose.advanced.yml"), "services:\n", "utf8");
  fs.writeFileSync(path.join(projectRoot, "cloudsmith.env"), "CLOUDSMITH_OWNER=portico\n", "utf8");
  fs.writeFileSync(
    path.join(projectRoot, "electron-app", "build-info.json"),
    `${JSON.stringify({ buildNumber })}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(projectRoot, "src", "scripts", "docker-compose.sh"),
    "#!/bin/bash\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(projectRoot, "src", "scripts", "repair-missing-overlayfs-snapshot-images.sh"),
    "#!/bin/bash\n",
    "utf8",
  );
  fs.writeFileSync(path.join(projectRoot, ".env.runtime"), "LLM_GATEWAY_MODE=bifrost\n", "utf8");
}

function writeServerYaml(projectRoot, serverId, content) {
  const serverDir = path.join(projectRoot, "mcp-configs", serverId);
  fs.mkdirSync(serverDir, { recursive: true });
  fs.writeFileSync(path.join(serverDir, `${serverId}.yaml`), content, "utf8");
}

function prepareInstalledRuntimeFixture() {
  const root = makeTempDir();
  const projectRoot = path.join(root, "project");
  const userDataPath = path.join(root, "user-data");
  const appRoot = path.join(projectRoot, "electron-app");

  writeSetupRequirement(appRoot, "requirement-a");
  writeEnv(projectRoot);
  writeRuntimeFiles(projectRoot);
  const completion = markSetupRequirementCompleted({
    userDataPath,
    setupRequirementId: "requirement-a",
    buildNumber: "dev-build",
  });
  assert.equal(completion.success, true);

  return { projectRoot, userDataPath, appRoot };
}

function prepareUncompletedRuntimeFixture(projectName = "project") {
  const root = makeTempDir();
  const projectRoot = path.join(root, projectName);
  const userDataPath = path.join(root, "user-data");
  const appRoot = path.join(projectRoot, "electron-app");

  writeSetupRequirement(appRoot, "requirement-a");
  writeEnv(projectRoot);
  writeRuntimeFiles(projectRoot);

  return { projectRoot, userDataPath, appRoot };
}

function prepareRuntimeUpdateMismatchFixture() {
  const fixture = prepareUncompletedRuntimeFixture();
  const fixtureRoot = path.dirname(fixture.projectRoot);
  const resourcesPath = path.join(fixtureRoot, "bundled-resources");
  const preparedManagedRoot = path.join(fixtureRoot, "prepared-managed-root");
  const preparedBuildInfoPath = path.join(
    preparedManagedRoot,
    "electron-app",
    "build-info.json",
  );
  const applyScript = path.join(
    preparedManagedRoot,
    "electron-app",
    "src",
    "scripts",
    "apply-prepared-update.sh",
  );
  const installedBuildInfoPath = path.join(
    fixture.projectRoot,
    "electron-app",
    "build-info.json",
  );
  const bundledBuild = {
    buildNumber: "08052026-6e6901cd",
    channel: "portico",
  };

  fs.mkdirSync(resourcesPath, { recursive: true });
  fs.mkdirSync(path.dirname(preparedBuildInfoPath), { recursive: true });
  fs.mkdirSync(path.dirname(applyScript), { recursive: true });
  fs.writeFileSync(
    installedBuildInfoPath,
    `${JSON.stringify({
      buildNumber: "05282026-c2bf1c8a",
      channel: "portico",
    })}\n`,
  );
  fs.writeFileSync(
    path.join(resourcesPath, "build-info.json"),
    `${JSON.stringify(bundledBuild)}\n`,
  );
  fs.writeFileSync(preparedBuildInfoPath, `${JSON.stringify(bundledBuild)}\n`);
  fs.writeFileSync(applyScript, "#!/bin/bash\n", { mode: 0o755 });

  const prepared = {
    managedRootDir: preparedManagedRoot,
    buildInfoPath: preparedBuildInfoPath,
    checksumAlgorithm: "sha256",
    checksumValue: "fixture",
    updateKey: "08052026-6e6901cd|sha256:fixture|portico",
    selectedAppBundle: path.join(fixtureRoot, "Portico.app"),
    selectedDmg: path.join(fixtureRoot, "Portico.dmg"),
  };

  return {
    ...fixture,
    applyScript,
    bundledBuild,
    installedBuildInfoPath,
    prepared,
    resourcesPath,
    updatePreparation: {
      getPreparationStatus: () => ({ state: "ready", prepared }),
      validatePreparedArtifactsForInstall: (candidate) => ({
        success: true,
        prepared: candidate,
      }),
      consumePreparedArtifacts: () => ({ success: true }),
    },
  };
}

function getFullRuntimeReadyImages() {
  return [
    "nginx:alpine",
    `${IMAGE_BASE}/mcp-orc-rust:latest`,
    `${IMAGE_BASE}/open-webui-patched:latest`,
  ];
}

function getExpectedDockerArch() {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return "amd64";
  return process.arch;
}

function getWrongDockerArch() {
  return getExpectedDockerArch() === "arm64" ? "amd64" : "arm64";
}

function createSuccessfulSpawnStub(onSpawn = () => {}) {
  return (command, args = []) => {
    onSpawn(command, args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => {
      child.emit("close", 0, null);
    });
    return child;
  };
}

function createDockerPullSpawnStub(onPull) {
  return (command, args = []) => {
    assert.equal(command, "docker");
    assert.equal(args[0], "pull");
    const outcome = onPull(args[1]);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => {
      if (outcome.stdout) {
        child.stdout.emit("data", Buffer.from(outcome.stdout));
      }
      if (outcome.stderr) {
        child.stderr.emit("data", Buffer.from(outcome.stderr));
      }
      child.emit("close", outcome.code, null);
    });
    return child;
  };
}

function loadPrerequisitesService({
  projectRoot,
  userDataPath = path.join(projectRoot, "user-data"),
  readyImages = [],
  wrongArchImages = [],
  fullImages = DEFAULT_FULL_IMAGES,
  generatorReady = true,
  isPackaged = false,
  dockerMcp = null,
  updatePreparation = null,
  cloudsmithConfig = null,
  resourcesPath = path.join(projectRoot, "electron-app"),
  spawnImpl = null,
  isReadyImage = null,
  buildRuntimeSecretEnvImpl = runtimeSecretsConfig.buildRuntimeSecretEnv,
  secureCloudsmithBootstrapSecretsImpl = () => ({
    apiKeyPersisted: true,
    entitlementTokenPersisted: true,
  }),
} = {}) {
  const readyImageSet = new Set(readyImages);
  const wrongArchImageSet = new Set(wrongArchImages);
  const previousBootstrap = require.cache[bootstrapModulePath];
  const previousPrereqLogger = require.cache[prereqLoggerModulePath];
  const previousDockerImagePlan = require.cache[dockerImagePlanModulePath];
  const previousDockerMcp = require.cache[dockerMcpModulePath];
  const previousMcpOrcCli = require.cache[mcpOrcCliModulePath];
  const previousUpdatePreparation = require.cache[updatePreparationModulePath];
  const previousRuntimeSecretsConfig = require.cache[runtimeSecretsConfigModulePath];
  const previousCloudsmithConfig = require.cache[cloudsmithConfigModulePath];
  const previousService = require.cache[serviceModulePath];
  const previousResourcesPath = process.resourcesPath;

  process.resourcesPath = resourcesPath;

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") {
      return {
        app: {
          getPath(name) {
            assert.equal(name, "userData");
            return userDataPath;
          },
          isPackaged,
        },
      };
    }

    if (request === "child_process") {
      return {
        ...childProcess,
        execSync(command, options) {
          void options;
          if (String(command).startsWith("docker info")) {
            return Buffer.from("docker ready\n");
          }
          const imageRef = String(command).match(/"([^"]+)"\s*$/)?.[1] || "";
          const imageIsReady = readyImageSet.has(imageRef) || isReadyImage?.(imageRef) === true;
          if (!imageIsReady && !wrongArchImageSet.has(imageRef)) {
            const error = new Error(`missing image: ${imageRef}`);
            error.code = 1;
            throw error;
          }

          if (String(command).includes("--format '{{.Architecture}}'")) {
            if (wrongArchImageSet.has(imageRef)) {
              return Buffer.from(`${getWrongDockerArch()}\n`);
            }
            return Buffer.from(`${getExpectedDockerArch()}\n`);
          }

          return Buffer.from("[]\n");
        },
        spawn: spawnImpl || childProcess.spawn,
      };
    }

    return originalLoad.apply(this, arguments);
  };

  require.cache[bootstrapModulePath] = {
    id: bootstrapModulePath,
    filename: bootstrapModulePath,
    loaded: true,
    exports: {
      PROJECT_ROOT: projectRoot,
      SCRIPTS_DIR: path.join(projectRoot, "src", "scripts"),
    },
  };
  require.cache[prereqLoggerModulePath] = {
    id: prereqLoggerModulePath,
    filename: prereqLoggerModulePath,
    loaded: true,
    exports: {
      getPrereqLogger() {
        return null;
      },
      logPrereq() {},
    },
  };
  require.cache[dockerImagePlanModulePath] = {
    id: dockerImagePlanModulePath,
    filename: dockerImagePlanModulePath,
    loaded: true,
    exports: {
      buildDockerImagesToPull() {
        return fullImages.map((image) => ({ ...image }));
      },
      harborToLocalImageRef() {
        return null;
      },
      HARBOR_IMAGE_BASE: IMAGE_BASE,
    },
  };
  if (dockerMcp) {
    require.cache[dockerMcpModulePath] = {
      id: dockerMcpModulePath,
      filename: dockerMcpModulePath,
      loaded: true,
      exports: dockerMcp,
    };
  }
  if (updatePreparation) {
    require.cache[updatePreparationModulePath] = {
      id: updatePreparationModulePath,
      filename: updatePreparationModulePath,
      loaded: true,
      exports: updatePreparation,
    };
  }
  require.cache[mcpOrcCliModulePath] = {
    id: mcpOrcCliModulePath,
    filename: mcpOrcCliModulePath,
    loaded: true,
    exports: {
      resolveMcpOrcBinary() {
        if (!generatorReady) {
          throw new Error("missing bundled generator");
        }
        return "/tmp/mcp-orc";
      },
    },
  };
  require.cache[runtimeSecretsConfigModulePath] = {
    id: runtimeSecretsConfigModulePath,
    filename: runtimeSecretsConfigModulePath,
    loaded: true,
    exports: {
      ...runtimeSecretsConfig,
      buildRuntimeSecretEnv: buildRuntimeSecretEnvImpl,
      secureCloudsmithBootstrapSecrets: secureCloudsmithBootstrapSecretsImpl,
    },
  };
  if (cloudsmithConfig) {
    require.cache[cloudsmithConfigModulePath] = {
      id: cloudsmithConfigModulePath,
      filename: cloudsmithConfigModulePath,
      loaded: true,
      exports: cloudsmithConfig,
    };
  }

  delete require.cache[serviceModulePath];
  const service = require("./prerequisites-service");

  return {
    service,
    restore() {
      Module._load = originalLoad;
      process.resourcesPath = previousResourcesPath;
      delete require.cache[serviceModulePath];

      if (previousBootstrap) {
        require.cache[bootstrapModulePath] = previousBootstrap;
      } else {
        delete require.cache[bootstrapModulePath];
      }

      if (previousPrereqLogger) {
        require.cache[prereqLoggerModulePath] = previousPrereqLogger;
      } else {
        delete require.cache[prereqLoggerModulePath];
      }

      if (previousDockerImagePlan) {
        require.cache[dockerImagePlanModulePath] = previousDockerImagePlan;
      } else {
        delete require.cache[dockerImagePlanModulePath];
      }

      if (previousDockerMcp) {
        require.cache[dockerMcpModulePath] = previousDockerMcp;
      } else {
        delete require.cache[dockerMcpModulePath];
      }

      if (previousMcpOrcCli) {
        require.cache[mcpOrcCliModulePath] = previousMcpOrcCli;
      } else {
        delete require.cache[mcpOrcCliModulePath];
      }

      if (previousUpdatePreparation) {
        require.cache[updatePreparationModulePath] = previousUpdatePreparation;
      } else {
        delete require.cache[updatePreparationModulePath];
      }

      if (previousRuntimeSecretsConfig) {
        require.cache[runtimeSecretsConfigModulePath] = previousRuntimeSecretsConfig;
      } else {
        delete require.cache[runtimeSecretsConfigModulePath];
      }

      if (previousCloudsmithConfig) {
        require.cache[cloudsmithConfigModulePath] = previousCloudsmithConfig;
      } else {
        delete require.cache[cloudsmithConfigModulePath];
      }

      if (previousService) {
        require.cache[serviceModulePath] = previousService;
      }
    },
  };
}

test("latest prerequisite lookup ignores a newer package until release verification marks it ready", async () => {
  const fixture = prepareUncompletedRuntimeFixture();
  const previousFetch = global.fetch;
  let requestedUrl = "";
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    cloudsmithConfig: {
      CLOUDSMITH_OWNER: "portico",
      CLOUDSMITH_REPO: "portico",
      CLOUDSMITH_API_BASE: "https://api.example.test/v1",
      CLOUDSMITH_READ_TOKEN: "read-key",
      CLOUDSMITH_API_KEY: "read-key",
    },
  });

  global.fetch = async (url) => {
    requestedUrl = url;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      async json() {
        return [
          {
            name: "portico_beta",
            version: "08132026-bbbbbbbb",
            filename: "portico_beta-08132026-bbbbbbbb.zip",
            uploaded_at: "2026-08-13T12:01:00.000Z",
            tags: { info: ["portico-update-ready-v1"] },
            tags_immutable: { info: [] },
          },
          {
            name: "portico_beta",
            version: "08132026-aaaaaaaa",
            filename: "portico_beta-08132026-aaaaaaaa.zip",
            uploaded_at: "2026-08-13T12:00:00.000Z",
            tags_immutable: { info: ["portico-update-ready-v1"] },
          },
        ];
      },
    };
  };

  try {
    const result = await service._test.fetchLatestBuildFromCloudsmith("portico_beta");
    assert.deepEqual(result, {
      success: true,
      buildNumber: "08132026-aaaaaaaa",
      channel: "portico_beta",
    });
    assert.match(
      new URL(requestedUrl).searchParams.get("query"),
      /tag:\^portico-update-ready-v1\$/,
    );
  } finally {
    global.fetch = previousFetch;
    restore();
  }
});

test("readBundledBuildInfo reads and logs immutable packaged metadata once", () => {
  const fixture = prepareUncompletedRuntimeFixture();
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
    isPackaged: true,
  });
  const originalLog = console.log;
  const messages = [];

  try {
    console.log = (...args) => messages.push(args.join(" "));
    const first = service.readBundledBuildInfo();
    const second = service.readBundledBuildInfo();

    assert.equal(first.success, true);
    assert.equal(second, first);
    assert.equal(
      messages.filter((message) =>
        message.includes("Read build-info.json from bundled resources"),
      ).length,
      1,
    );
  } finally {
    console.log = originalLog;
    restore();
  }
});

test("runtime update stop guard invokes docker-compose stop and propagates failures", async () => {
  const fixture = prepareUncompletedRuntimeFixture();
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
  });
  const calls = [];

  try {
    const success = await service._test.stopManagedRuntimeForUpdate({
      projectRoot: fixture.projectRoot,
      executeWithStreaming: async (...args) => {
        calls.push(args);
        return { success: true };
      },
    });
    assert.equal(success.success, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0][0], /docker-compose\.sh/);
    assert.deepEqual(calls[0][1], ["stop"]);

    const failure = await service._test.stopManagedRuntimeForUpdate({
      projectRoot: fixture.projectRoot,
      executeWithStreaming: async () => ({
        success: false,
        error: "container refused to stop",
      }),
    });
    // PORTICO-373: timedOut travels with the verdict so callers can tell an engine
    // that never answered from a stop that ran and failed. A refusal is the
    // latter, so it must not look like a wedge.
    assert.deepEqual(failure, {
      success: false,
      error: "container refused to stop",
      timedOut: false,
    });

    const recoveryCalls = [];
    const brokenPluginWithNothingRunning =
      await service._test.stopManagedRuntimeForUpdate({
        projectRoot: fixture.projectRoot,
        executeWithStreaming: async (command, args) => {
          recoveryCalls.push([command, args]);
          if (command.startsWith("bash ")) {
            return {
              success: false,
              code: 125,
              error:
                "unknown shorthand flag: 'p' in -p\nUsage: docker [OPTIONS] COMMAND [ARG...]",
            };
          }
          return { success: true, output: "" };
        },
      });
    assert.deepEqual(brokenPluginWithNothingRunning, {
      success: true,
      skipped: true,
      reason: "no-project-containers",
    });
    assert.equal(recoveryCalls.length, 2);
    assert.equal(recoveryCalls[1][0], "docker");
  } finally {
    restore();
  }
});

test("packaged prepared-update reconciliation proceeds after broken-plugin zero-container proof", async () => {
  const fixture = prepareRuntimeUpdateMismatchFixture();
  const events = [];
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
    isPackaged: true,
    resourcesPath: fixture.resourcesPath,
    updatePreparation: fixture.updatePreparation,
    buildRuntimeSecretEnvImpl: () => ({}),
    dockerMcp: {
      executeWithStreaming: async (command) => {
        if (command.startsWith("bash ")) {
          events.push("managed-stop-failed");
          return {
            success: false,
            code: 125,
            error:
              "unknown shorthand flag: 'p' in -p\nUsage: docker [OPTIONS] COMMAND [ARG...]",
          };
        }
        events.push("zero-containers-proven");
        return { success: true, output: "" };
      },
    },
    spawnImpl: createSuccessfulSpawnStub((command, args) => {
      assert.equal(command, "bash");
      assert.equal(args[0], fixture.applyScript);
      events.push("prepared-apply");
      fs.writeFileSync(
        fixture.installedBuildInfoPath,
        `${JSON.stringify(fixture.bundledBuild)}\n`,
      );
    }),
  });

  try {
    const result = await service.updateInstalledRuntimeToBundledBuild({
      projectRoot: fixture.projectRoot,
    });

    assert.deepEqual(events, [
      "managed-stop-failed",
      "zero-containers-proven",
      "prepared-apply",
    ]);
    assert.equal(result.success, true);
    assert.equal(result.updated, true);
    assert.equal(result.source, "prepared-update");
  } finally {
    restore();
  }
});

test("packaged prepared-update reconciliation never applies after an unproven stop", async () => {
  const fixture = prepareRuntimeUpdateMismatchFixture();
  let applyCalls = 0;
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
    isPackaged: true,
    resourcesPath: fixture.resourcesPath,
    updatePreparation: fixture.updatePreparation,
    dockerMcp: {
      executeWithStreaming: async () => ({
        success: false,
        error: "container refused to stop",
      }),
    },
    spawnImpl: createSuccessfulSpawnStub(() => {
      applyCalls += 1;
    }),
  });

  try {
    const result = await service.updateInstalledRuntimeToBundledBuild({
      projectRoot: fixture.projectRoot,
    });

    assert.equal(result.success, false);
    assert.equal(result.updated, false);
    assert.equal(result.source, "prepared-update");
    assert.equal(result.reason, "runtime-stop-failed");
    assert.equal(applyCalls, 0);
  } finally {
    restore();
  }
});

test("packaged exact-build reconciliation never downloads after an unproven stop", async () => {
  const fixture = prepareRuntimeUpdateMismatchFixture();
  let phase1Calls = 0;
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
    isPackaged: true,
    resourcesPath: fixture.resourcesPath,
    updatePreparation: {
      getPreparationStatus: () => ({ state: "idle", prepared: null }),
      validatePreparedArtifactsForInstall: () => ({ success: false }),
    },
    dockerMcp: {
      executeWithStreaming: async () => ({
        success: false,
        error: "container refused to stop",
      }),
    },
    spawnImpl: createSuccessfulSpawnStub(() => {
      phase1Calls += 1;
    }),
  });

  try {
    const result = await service.updateInstalledRuntimeToBundledBuild({
      projectRoot: fixture.projectRoot,
    });

    assert.equal(result.success, false);
    assert.equal(result.updated, false);
    assert.equal(result.source, "cloudsmith-phase1");
    assert.equal(result.reason, "runtime-stop-failed");
    assert.equal(phase1Calls, 0);
  } finally {
    restore();
  }
});

test("shouldSkipPrerequisites requires finalize images, not just authorize images", async () => {
  const fixture = prepareInstalledRuntimeFixture();
  const authorizeReadyImages = [
    "nginx:alpine",
    `${IMAGE_BASE}/mcp-orc-rust:latest`,
  ];
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
    readyImages: authorizeReadyImages,
  });

  try {
    const result = await service.shouldSkipPrerequisites({
      projectRoot: fixture.projectRoot,
      userDataPath: fixture.userDataPath,
      appRoot: fixture.appRoot,
    });

    assert.equal(result.skip, false);
    assert.equal(result.reason, "finalize-images-missing");
    assert.deepEqual(result.missingImages, [
      `${IMAGE_BASE}/open-webui-patched:latest`,
    ]);
  } finally {
    restore();
  }
});

test("getDockerImagesToPull excludes unselected optional server images", async () => {
  const fixture = prepareUncompletedRuntimeFixture();
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
  });

  try {
    assert.deepEqual(
      service.getDockerImagesToPull().map((image) => `${image.name}:${image.tag}`),
      getFullRuntimeReadyImages(),
    );
  } finally {
    restore();
  }
});

test("checkAuthorizeReadiness still allows OAuth when only the authorize image set is ready", async () => {
  const fixture = prepareInstalledRuntimeFixture();
  const authorizeReadyImages = [
    "nginx:alpine",
    `${IMAGE_BASE}/mcp-orc-rust:latest`,
  ];
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
    readyImages: authorizeReadyImages,
  });

  try {
    const readiness = await service.checkAuthorizeReadiness();

    assert.equal(readiness.ready, true);
    assert.equal(readiness.waiting, false);
    assert.equal(readiness.error, null);
    assert.deepEqual(readiness.requiredImages, [
      "nginx:alpine",
      `${IMAGE_BASE}/mcp-orc-rust:latest`,
    ]);
  } finally {
    restore();
  }
});

test("the installed fast path used by prerequisitesResumeInteractive stays disabled for partial installs", async () => {
  const fixture = prepareInstalledRuntimeFixture();
  const authorizeReadyImages = [
    "nginx:alpine",
    `${IMAGE_BASE}/mcp-orc-rust:latest`,
  ];
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
    readyImages: authorizeReadyImages,
  });

  try {
    const authorizeReadiness = await service._test.getInstalledPrereqReadiness({
      projectRoot: fixture.projectRoot,
      userDataPath: fixture.userDataPath,
      appRoot: fixture.appRoot,
      scope: "authorize",
    });
    const finalizeReadiness = await service._test.getInstalledPrereqReadiness({
      projectRoot: fixture.projectRoot,
      userDataPath: fixture.userDataPath,
      appRoot: fixture.appRoot,
      scope: "finalize",
      includeFinalizeGenerator: true,
    });

    assert.equal(authorizeReadiness.skip, true);
    assert.equal(finalizeReadiness.skip, false);
    assert.equal(
      service._test.canUseInstalledPrereqFastPath({
        onboardingMode: "basic",
        installedReadiness: finalizeReadiness,
      }),
      false,
    );
  } finally {
    restore();
  }
});

test("checkFinalizeReadiness accepts runtime-ready assets before setup completion is recorded", async () => {
  const fixture = prepareUncompletedRuntimeFixture();
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
    readyImages: getFullRuntimeReadyImages(),
  });

  try {
    const readiness = await service.checkFinalizeReadiness({
      mode: "basic",
      hasHostSelections: false,
      selectedServerIds: [],
    });

    assert.equal(readiness.ready, true);
    assert.equal(readiness.waiting, false);
    assert.equal(readiness.error, null);
    assert.deepEqual(readiness.missingImages, []);
  } finally {
    restore();
  }
});

test("runtime-ready assets cannot bypass missing host prerequisites", () => {
  const fixture = prepareUncompletedRuntimeFixture();
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
    readyImages: getFullRuntimeReadyImages(),
  });

  try {
    const readiness = service._test.getRuntimeFinalizeReadiness({
      requiredSpecs: [],
      mode: "basic",
      hasHostSelections: false,
      hostPrerequisites: {
        isComplete: false,
        reason: "command-line-tools-unavailable",
        reasonMessage: "Apple Command Line Tools are missing or incomplete.",
      },
    });

    assert.equal(readiness.ready, false);
    assert.equal(readiness.waiting, false);
    assert.equal(readiness.prerequisiteReason, "command-line-tools-unavailable");
    assert.equal(readiness.error, "Apple Command Line Tools are missing or incomplete.");
  } finally {
    restore();
  }
});

test("active finalize sessions cannot bypass missing host prerequisites", async () => {
  const fixture = prepareUncompletedRuntimeFixture();
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
    readyImages: getFullRuntimeReadyImages(),
  });

  try {
    service._test.markSessionReadyFromExistingRuntime({
      onboardingMode: "basic",
      hostModeEnabled: false,
      requiresHost: false,
    });
    const readiness = await service.checkFinalizeReadiness({
      mode: "basic",
      hasHostSelections: false,
      selectedServerIds: [],
      hostPrerequisites: {
        isComplete: false,
        reason: "command-line-tools-unavailable",
        reasonMessage: "Apple Command Line Tools are missing or incomplete.",
      },
    });

    assert.equal(readiness.ready, false);
    assert.equal(readiness.waiting, false);
    assert.equal(readiness.prerequisiteReason, "command-line-tools-unavailable");
    assert.equal(readiness.error, "Apple Command Line Tools are missing or incomplete.");
  } finally {
    restore();
  }
});

test("checkFinalizeReadiness still blocks when host mode is required and unavailable", async () => {
  const fixture = prepareUncompletedRuntimeFixture();
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
    readyImages: getFullRuntimeReadyImages(),
  });

  try {
    const readiness = await service.checkFinalizeReadiness({
      mode: "power",
      hasHostSelections: true,
      selectedServerIds: [],
    });

    assert.equal(readiness.ready, false);
    assert.equal(readiness.waiting, false);
    assert.equal(
      readiness.error,
      "Oops, something went wrong. Please navigate to the prereqs step.",
    );
  } finally {
    restore();
  }
});

test("checkFinalizeReadiness does not require the retired n8n Docker image", async () => {
  const fixture = prepareUncompletedRuntimeFixture();
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
    readyImages: getFullRuntimeReadyImages(),
    wrongArchImages: ["harbor.example.invalid/n8n/n8n-mcp:latest"],
  });

  try {
    const readiness = await service.checkFinalizeReadiness({
      mode: "power",
      hasHostSelections: false,
      selectedServerIds: ["mcp-n8n"],
    });

    assert.equal(readiness.ready, true);
    assert.equal(readiness.waiting, false);
    assert.equal(readiness.error, null);
    assert.deepEqual(readiness.missingImages, []);
    assert.deepEqual(readiness.wrongArchitectureImages, []);
  } finally {
    restore();
  }
});

test("getOptionalServerImageSpecs excludes the hosted n8n MCP server", async () => {
  const fixture = prepareUncompletedRuntimeFixture();
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
  });

  try {
    assert.deepEqual(service._test.getOptionalServerImageSpecs(["mcp-n8n"]), []);
  } finally {
    restore();
  }
});

test("getOptionalServerImageSpecs pre-pulls the community-fork n8n image when selected", async () => {
  const fixture = prepareUncompletedRuntimeFixture();
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
  });

  try {
    assert.deepEqual(
      service._test.getOptionalServerImageSpecs(["n8n-community-mcp"]),
      [
        {
          name: "harbor.example.invalid/n8n/n8n-mcp",
          tag: "latest",
          label: "n8n MCP (Community Fork)",
        },
      ],
    );
    assert.deepEqual(
      service._test.getOptionalServerImageSpecs(["sourcegraph"]),
      [],
      "non-fork selections stay out of the optional pre-pull set",
    );
  } finally {
    restore();
  }
});

test("guided-setup finalize recovery can rehydrate runtime-ready prerequisites without setup completion", async () => {
  const fixture = prepareUncompletedRuntimeFixture();
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
    readyImages: getFullRuntimeReadyImages(),
  });

  try {
    const result = await service.prerequisitesResumeInteractive({
      onboardingMode: "basic",
      purpose: "guided-setup-finalize",
      hasHostSelections: false,
      selectedServerIds: ["glean", "google_workspace"],
    });

    assert.equal(result.success, true);
    assert.equal(result.started, false);
    assert.equal(result.status.currentSequence, "complete");
    assert.equal(result.status.blockingReady, true);
    assert.equal(result.status.backgroundReady, true);
  } finally {
    restore();
  }
});

test("guided-setup finalize recovery repulls missing images after a completed prereq session", async () => {
  const fixture = prepareUncompletedRuntimeFixture();
  const pulledImages = [];
  const missingRuntimeImages = [
    { name: "redis", tag: "7-alpine", label: "Redis" },
    { name: `${IMAGE_BASE}/agent-vm`, tag: "latest", label: "Agent VM" },
  ];
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
    readyImages: [],
    fullImages: missingRuntimeImages,
    spawnImpl: createSuccessfulSpawnStub((_command, args) => {
      pulledImages.push(args[1]);
    }),
  });

  try {
    service._test.resetPrerequisitesSession({ onboardingMode: "basic" });
    const session = service._test.getSessionState();
    session.phaseResults.phase1 = { success: true };
    session.phaseResults.phase2 = { success: true };
    session.phaseResults.phase3 = { success: true };
    session.phaseResults.phase4 = { success: true, skipped: true };
    session.phaseResults.dockerPull = { success: true, pulled: [], failed: [] };
    session.currentSequence = "complete";
    session.startedAt = Date.now();

    const result = await service.prerequisitesResumeInteractive({
      onboardingMode: "basic",
      purpose: "guided-setup-finalize",
      hasHostSelections: false,
      selectedServerIds: [],
    });

    assert.equal(result.success, true);
    assert.equal(result.started, true);
    assert.equal(result.status.currentSequence, "background");

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(pulledImages, ["redis:7-alpine", `${IMAGE_BASE}/agent-vm:latest`]);
    assert.equal(service._test.getSessionState().phaseResults.dockerPull.success, true);
    assert.deepEqual(
      service._test.getSessionState().phaseResults.dockerPull.pulled,
      ["redis:7-alpine", `${IMAGE_BASE}/agent-vm:latest`],
    );
  } finally {
    restore();
  }
});

test("prerequisite marker parsing persists failure codes, details, and Homebrew retry suppression", async () => {
  const fixture = prepareUncompletedRuntimeFixture();
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
  });

  try {
    service._test.resetPrerequisitesSession({ onboardingMode: "power" });
    service._test.ensurePrerequisitesSession({
      onboardingMode: "power",
      previousFailureCode: "homebrew_sudo_validation_failed",
      skipHomebrewAuthOnRetry: true,
    });
    service._test.parseAndEmitMarkers(
      [
        "[PREREQ:CODE:homebrew_sudo_validation_failed]",
        "[PREREQ:DETAIL:sudo -A -v exit code: 1]",
        "[PREREQ:DETAIL:osascript probe exit code: 0]",
        "",
      ].join("\n"),
      () => {},
    );

    const status = service._test.buildDetailedStatus();
    assert.equal(status.lastFailureCode, "homebrew_sudo_validation_failed");
    assert.deepEqual(status.lastFailureDetails, [
      "sudo -A -v exit code: 1",
      "osascript probe exit code: 0",
    ]);
    assert.equal(service._test.getSessionState().skipHomebrewAuthOnRetry, true);
  } finally {
    restore();
  }
});

test("successful packaged Phase 1 secures and scrubs Cloudsmith bootstrap values before returning", async () => {
  const fixture = prepareUncompletedRuntimeFixture();
  fs.writeFileSync(
    path.join(fixture.projectRoot, "src", "scripts", "prereq-download.sh"),
    "#!/bin/bash\n",
    "utf8",
  );

  let secureOptions = null;
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
    isPackaged: true,
    spawnImpl: createSuccessfulSpawnStub(() => {
      writeRuntimeFiles(fixture.projectRoot, "05252026-abcdef12");
    }),
    secureCloudsmithBootstrapSecretsImpl(options) {
      secureOptions = options;
      return {
        apiKeyPersisted: true,
        entitlementTokenPersisted: true,
      };
    },
  });

  try {
    const resourcesPath = path.join(fixture.projectRoot, "signed-resources");
    const result = await service.runPhase1Download(
      "05252026-abcdef12",
      null,
      {
        cloudsmithBootstrap: {
          isPackagedApp: true,
          platform: "darwin",
          managedRoot: fixture.projectRoot,
          projectRoot: fixture.projectRoot,
          resourcesPath,
          env: {},
        },
      },
    );

    assert.equal(result.success, true);
    assert.deepEqual(secureOptions, {
      env: {},
      projectRoot: fixture.projectRoot,
      resourcesPath,
      managedRoot: fixture.projectRoot,
      isPackagedApp: true,
      platform: "darwin",
    });
    const historyEntries = fs
      .readFileSync(result.updateHistoryFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(historyEntries.at(-1).source, "runtime-reconcile");
    assert.equal(historyEntries.at(-1).step, "complete");
    assert.equal(historyEntries.at(-1).result, "ok");
  } finally {
    restore();
  }
});

test("packaged Phase 1 fails closed when Cloudsmith bootstrap verification fails", async () => {
  const fixture = prepareUncompletedRuntimeFixture();
  fs.writeFileSync(
    path.join(fixture.projectRoot, "src", "scripts", "prereq-download.sh"),
    "#!/bin/bash\n",
    "utf8",
  );

  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
    isPackaged: true,
    spawnImpl: createSuccessfulSpawnStub(() => {
      writeRuntimeFiles(fixture.projectRoot, "05252026-abcdef12");
    }),
    secureCloudsmithBootstrapSecretsImpl() {
      throw new Error("Keychain readback verification failed");
    },
  });

  try {
    const result = await service.runPhase1Download(
      "05252026-abcdef12",
      null,
      {
        cloudsmithBootstrap: {
          isPackagedApp: true,
          platform: "darwin",
        },
      },
    );

    assert.equal(result.success, false);
    assert.equal(result.retryable, true);
    assert.match(result.error, /Cloudsmith bootstrap hardening failed/);
    assert.match(result.error, /Keychain readback verification failed/);
    const historyEntries = fs
      .readFileSync(result.updateHistoryFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(historyEntries.some((entry) => entry.source === "runtime-reconcile"), false);
  } finally {
    restore();
  }
});

test("phase 1 download stalls after 20 minutes without new bytes and does not retry", async () => {
  const fixture = prepareUncompletedRuntimeFixture();
  fs.writeFileSync(
    path.join(fixture.projectRoot, "src", "scripts", "prereq-download.sh"),
    "#!/bin/bash\n",
    "utf8",
  );

  let spawnedChild = null;
  let spawnCount = 0;
  const timers = new Map();
  let nextTimerId = 1;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;

  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
    spawnImpl() {
      spawnCount += 1;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {
        child.killed = true;
      };
      spawnedChild = child;
      return child;
    },
  });

  function activeStallTimers() {
    return [...timers.values()].filter(
      (timer) =>
        timer.delay === service._test.PHASE1_DOWNLOAD_STALL_TIMEOUT_MS &&
        !timer.cleared,
    );
  }

  try {
    global.setTimeout = (fn, delay, ...args) => {
      const id = nextTimerId++;
      timers.set(id, { id, fn, delay, args, cleared: false });
      return id;
    };
    global.clearTimeout = (id) => {
      if (timers.has(id)) {
        timers.get(id).cleared = true;
      }
    };

    const resultPromise = service.runPhase1Download("05252026-abcdef12");
    assert.equal(spawnCount, 1);

    spawnedChild.stdout.emit(
      "data",
      Buffer.from("[PREREQ:PROGRESS:phase1_step:download]\n"),
    );
    const firstTimer = activeStallTimers()[0];
    assert.ok(firstTimer, "download step should start a stall timer");

    spawnedChild.stdout.emit(
      "data",
      Buffer.from("[PREREQ:PROGRESS:download_bytes:0]\n"),
    );
    assert.equal(activeStallTimers()[0].id, firstTimer.id);

    spawnedChild.stdout.emit(
      "data",
      Buffer.from("[PREREQ:PROGRESS:download_bytes:100]\n"),
    );
    const secondTimer = activeStallTimers()[0];
    assert.notEqual(secondTimer.id, firstTimer.id);
    assert.equal(timers.get(firstTimer.id).cleared, true);

    spawnedChild.stdout.emit(
      "data",
      Buffer.from("[PREREQ:PROGRESS:download_bytes:100]\n"),
    );
    assert.equal(activeStallTimers()[0].id, secondTimer.id);

    spawnedChild.stdout.emit(
      "data",
      Buffer.from("[PREREQ:PROGRESS:download_total_bytes:1000]\n[PREREQ:PROGRESS:download_bytes:200]\n"),
    );
    const finalTimer = activeStallTimers()[0];
    assert.notEqual(finalTimer.id, secondTimer.id);
    finalTimer.fn(...finalTimer.args);

    const result = await resultPromise;
    const status = service._test.buildDetailedStatus();

    assert.equal(result.success, false);
    assert.equal(result.retryable, false);
    assert.equal(result.code, service._test.PHASE1_DOWNLOAD_STALLED_CODE);
    assert.equal(status.lastFailureCode, service._test.PHASE1_DOWNLOAD_STALLED_CODE);
    assert.deepEqual(status.lastFailureDetails, [
      "No new bytes were downloaded for 20 minutes.",
      "Last downloaded bytes: 200",
      "Total bytes: 1000",
    ]);
    assert.match(result.error, /stopped receiving new bytes for 20 minutes/);
    assert.equal(spawnCount, 1);
    assert.ok(result.auditLogFile);
    assert.match(
      fs.readFileSync(result.auditLogFile, "utf8"),
      /\[PREREQ:PROGRESS:phase1_step:download\]/,
    );
    assert.ok(result.updateHistoryFile);
    const historyEntries = fs
      .readFileSync(result.updateHistoryFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(historyEntries.at(-1), {
      ts: historyEntries.at(-1).ts,
      from: "dev-build",
      to: "05252026-abcdef12",
      step: "download",
      result: "fail",
      freeDiskKb: historyEntries.at(-1).freeDiskKb,
    });
    assert.ok(Number.isInteger(historyEntries.at(-1).freeDiskKb));
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    restore();
  }
});

test("prerequisitesResumeInteractive restarts OrbStack before retrying docker recovery failures", async () => {
  const fixture = prepareUncompletedRuntimeFixture();
  let restartCalls = 0;
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
    dockerMcp: {
      async restartOrbStackAndWaitForDocker() {
        restartCalls += 1;
        return { success: true, method: "orbctl" };
      },
    },
  });

  try {
    service._test.resetPrerequisitesSession({ onboardingMode: "basic" });
    const session = service._test.getSessionState();
    session.phaseResults.phase1 = { success: true };
    session.phaseResults.phase2 = { success: true };
    session.currentSequence = "interactive";
    session.startedAt = Date.now();

    const result = await service.prerequisitesResumeInteractive({
      onboardingMode: "basic",
      previousFailureCode: "docker_pull_recovery_required",
      hasHostSelections: false,
      selectedServerIds: [],
    });

    assert.equal(result.success, true);
    assert.equal(result.started, false);
    assert.equal(restartCalls, 1);
  } finally {
    restore();
  }
});

test("docker recovery retry falls through when OrbStack restart fails", async () => {
  const fixture = prepareUncompletedRuntimeFixture();
  let restartCalls = 0;
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
    dockerMcp: {
      async restartOrbStackAndWaitForDocker() {
        restartCalls += 1;
        return { success: false, error: "OrbStack hung" };
      },
    },
  });

  try {
    service._test.resetPrerequisitesSession({ onboardingMode: "basic" });
    const session = service._test.getSessionState();
    session.phaseResults.phase1 = { success: true };
    session.phaseResults.phase2 = { success: true };
    session.currentSequence = "interactive";
    session.startedAt = Date.now();

    const result = await service.prerequisitesResumeInteractive({
      onboardingMode: "basic",
      previousFailureCode: "docker_pull_recovery_required",
      hasHostSelections: false,
      selectedServerIds: [],
    });

    assert.equal(result.success, true);
    assert.equal(result.started, false);
    assert.equal(restartCalls, 1);
  } finally {
    restore();
  }
});

test("handleSystemResume resets active docker pull controllers and ignores stale ones", async () => {
  const fixture = prepareUncompletedRuntimeFixture();
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
  });

  try {
    let resetCalls = 0;
    const controller = {
      resetInactivityTimer(reason) {
        assert.equal(reason, "resume");
        resetCalls += 1;
      },
    };

    service._test.registerActiveDockerPullController("nginx:alpine", controller);
    service._test.handleSystemResume();
    assert.equal(resetCalls, 1);

    service._test.unregisterActiveDockerPullController("nginx:alpine", controller);
    service._test.handleSystemResume();
    assert.equal(resetCalls, 1);
  } finally {
    restore();
  }
});

test("automatic OrbStack recovery only triggers for runtime-only waves that saw resume or daemon failures", async () => {
  const fixture = prepareUncompletedRuntimeFixture();
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
  });

  try {
    assert.equal(
      service._test.shouldAttemptDockerWaveOrbStackRecovery({
        allowOrbStackRestartRecovery: true,
        pulled: [],
        failureDetails: [
          { failureKind: "timeout_inactivity" },
          { failureKind: "daemon_unavailable" },
        ],
        waveState: { sawSystemResume: false, autoRecoveryAttempted: false },
      }),
      true,
    );

    assert.equal(
      service._test.shouldAttemptDockerWaveOrbStackRecovery({
        allowOrbStackRestartRecovery: true,
        pulled: [],
        failureDetails: [
          { failureKind: "timeout_inactivity" },
          { failureKind: "process_error" },
        ],
        waveState: { sawSystemResume: true, autoRecoveryAttempted: false },
      }),
      true,
    );

    assert.equal(
      service._test.shouldAttemptDockerWaveOrbStackRecovery({
        allowOrbStackRestartRecovery: true,
        pulled: [],
        failureDetails: [
          { failureKind: "registry_denied" },
        ],
        waveState: { sawSystemResume: true, autoRecoveryAttempted: false },
      }),
      false,
    );

    assert.equal(
      service._test.shouldAttemptDockerWaveOrbStackRecovery({
        allowOrbStackRestartRecovery: true,
        pulled: [],
        failureDetails: [
          { failureKind: "timeout_inactivity" },
        ],
        waveState: { sawSystemResume: false, autoRecoveryAttempted: false },
      }),
      false,
    );
  } finally {
    restore();
  }
});

const MISSING_SNAPSHOT_PARENT_SIGNATURE =
  "failed to stat parent: stat /var/lib/docker/containerd/daemon/io.containerd.snapshotter.v1.overlayfs/snapshots/1081/fs: no such file or directory";
const FRAMED_MISSING_SNAPSHOT_PARENT_SIGNATURE =
  `failed to prepare extraction snapshot "extract-951610003-XTwM sha256:${"f".repeat(64)}": ${MISSING_SNAPSHOT_PARENT_SIGNATURE}`;

test("Docker pull classifier isolates the exact missing-parent signature from near misses", () => {
  const fixture = prepareUncompletedRuntimeFixture();
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
  });

  try {
    assert.deepEqual(
      service._test.classifyDockerPullFailure({
        stdout: "0123456789ab: Already exists\n",
        stderr: FRAMED_MISSING_SNAPSHOT_PARENT_SIGNATURE,
        exitCode: 1,
      }),
      {
        failureKind: "overlayfs_snapshot_parent_missing",
        retryable: false,
        error: FRAMED_MISSING_SNAPSHOT_PARENT_SIGNATURE,
      },
    );

    const nearMiss = service._test.classifyDockerPullFailure({
      stderr: MISSING_SNAPSHOT_PARENT_SIGNATURE.replace("snapshots/1081", "snapshots/not-numeric"),
      exitCode: 1,
    });
    assert.equal(nearMiss.failureKind, "docker_pull_failed");
    assert.equal(nearMiss.retryable, true);

    for (const stderr of [
      `${MISSING_SNAPSHOT_PARENT_SIGNATURE}.bak`,
      MISSING_SNAPSHOT_PARENT_SIGNATURE.replace("failed to stat", "Failed to stat"),
      MISSING_SNAPSHOT_PARENT_SIGNATURE.replace(": stat /var/lib", ":\nstat /var/lib"),
    ]) {
      assert.notEqual(
        service._test.classifyDockerPullFailure({ stderr, exitCode: 1 }).failureKind,
        "overlayfs_snapshot_parent_missing",
      );
    }

    for (const stderr of [
      `unauthorized: ${MISSING_SNAPSHOT_PARENT_SIGNATURE}`,
      `${MISSING_SNAPSHOT_PARENT_SIGNATURE}\nno space left on device`,
      `${MISSING_SNAPSHOT_PARENT_SIGNATURE}\nunexpected EOF`,
    ]) {
      assert.notEqual(
        service._test.classifyDockerPullFailure({ stderr, exitCode: 1 }).failureKind,
        "overlayfs_snapshot_parent_missing",
      );
    }
  } finally {
    restore();
  }
});

test("missing snapshot parent uses direct argv for one owned repair and a full Docker pull replay", async () => {
  const fixture = prepareUncompletedRuntimeFixture('project $(must-not-run) "quoted"');
  const images = [
    { name: "nginx", tag: "alpine", label: "Nginx" },
    { name: `${IMAGE_BASE}/agent-vm`, tag: "build-1", label: "Agent VM" },
  ];
  const pullCalls = [];
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
    isPackaged: true,
    fullImages: images,
    spawnImpl: createDockerPullSpawnStub((imageRef) => {
      pullCalls.push(imageRef);
      return pullCalls.length === 1
        ? { code: 1, stderr: `${MISSING_SNAPSHOT_PARENT_SIGNATURE}\n` }
        : { code: 0 };
    }),
  });
  const repairCalls = [];

  try {
    const result = await service.pullDockerImagesWithProgress({
      images,
      concurrency: 1,
      runProcess: async (...args) => {
        repairCalls.push(args);
        return { stdout: "image-only repair complete\n", stderr: "", code: 0 };
      },
    });

    assert.equal(result.success, true);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.pulled, ["nginx:alpine", `${IMAGE_BASE}/agent-vm:build-1`]);
    assert.deepEqual(pullCalls, [
      "nginx:alpine",
      `${IMAGE_BASE}/agent-vm:build-1`,
      "nginx:alpine",
      `${IMAGE_BASE}/agent-vm:build-1`,
    ]);
    assert.equal(repairCalls.length, 1);
    assert.equal(repairCalls[0][0], "bash");
    assert.deepEqual(repairCalls[0][1], [
      path.join(fixture.projectRoot, "src", "scripts", "repair-missing-overlayfs-snapshot-images.sh"),
      "--apply-missing-overlayfs-parent-repair",
    ]);
    assert.equal(repairCalls[0][2].cwd, fixture.projectRoot);
    assert.equal(repairCalls[0][2].timeoutMs, 5 * 60 * 1000);
    assert(repairCalls[0][2].signal instanceof AbortSignal);
    assert.equal(result.snapshotStoreRepair.success, true);
  } finally {
    restore();
  }
});

test("repair refusal leaves the exact Docker pull failure hard and does not replay", async () => {
  const fixture = prepareUncompletedRuntimeFixture();
  const images = [{ name: "nginx", tag: "alpine", label: "Nginx" }];
  const pullCalls = [];
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
    isPackaged: true,
    fullImages: images,
    spawnImpl: createDockerPullSpawnStub((imageRef) => {
      pullCalls.push(imageRef);
      return { code: 1, stderr: `${MISSING_SNAPSHOT_PARENT_SIGNATURE}\n` };
    }),
  });

  try {
    const result = await service.pullDockerImagesWithProgress({
      images,
      concurrency: 1,
      allowOrbStackRestartRecovery: true,
      runProcess: async () => {
        const error = new Error("PORTICO container still exists");
        error.code = 1;
        throw error;
      },
    });

    assert.equal(result.success, false);
    assert.deepEqual(pullCalls, ["nginx:alpine"]);
    assert.equal(result.failureDetails[0].failureKind, "overlayfs_snapshot_parent_missing");
    assert.equal(result.snapshotStoreRepair.success, false);
    assert.match(result.snapshotStoreRepair.error, /PORTICO container still exists/);
    const failure = service.buildPackagedDockerRecoveryFailure(result, { imageSpecs: images });
    assert.equal(failure.code, "docker_snapshot_store_repair_required");
    assert.equal(failure.recovery, null);
  } finally {
    restore();
  }
});

test("partial image removal failure is terminal and the pull owner never replays", async () => {
  const fixture = prepareUncompletedRuntimeFixture();
  const images = [{ name: "nginx", tag: "alpine", label: "Nginx" }];
  const pullCalls = [];
  let repairCalls = 0;
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
    isPackaged: true,
    fullImages: images,
    spawnImpl: createDockerPullSpawnStub((imageRef) => {
      pullCalls.push(imageRef);
      return { code: 1, stderr: `${MISSING_SNAPSHOT_PARENT_SIGNATURE}\n` };
    }),
  });

  try {
    const result = await service.pullDockerImagesWithProgress({
      images,
      concurrency: 1,
      runProcess: async () => {
        repairCalls += 1;
        const error = new Error("Docker refused non-force removal after deleting one immutable image ID");
        error.code = 1;
        error.stderr = "partial multi-ID removal is a hard failure\n";
        throw error;
      },
    });

    assert.equal(result.success, false);
    assert.deepEqual(pullCalls, ["nginx:alpine"]);
    assert.equal(repairCalls, 1);
    assert.equal(result.snapshotStoreRepair.success, false);
    assert.match(result.snapshotStoreRepair.error, /partial multi-ID removal/);
    assert.equal(
      service.buildPackagedDockerRecoveryFailure(result, { imageSpecs: images }).code,
      "docker_snapshot_store_repair_required",
    );
  } finally {
    restore();
  }
});

test("mixed terminal pull failures never trigger snapshot-store repair", async () => {
  const fixture = prepareUncompletedRuntimeFixture();
  const images = [
    { name: "nginx", tag: "alpine", label: "Nginx" },
    { name: "mongo", tag: "7", label: "MongoDB" },
  ];
  const pullCalls = [];
  let repairCalls = 0;
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
    isPackaged: true,
    fullImages: images,
    spawnImpl: createDockerPullSpawnStub((imageRef) => {
      pullCalls.push(imageRef);
      return imageRef === "nginx:alpine"
        ? { code: 1, stderr: `${MISSING_SNAPSHOT_PARENT_SIGNATURE}\n` }
        : { code: 1, stderr: "unauthorized: authentication required\n" };
    }),
  });

  try {
    const result = await service.pullDockerImagesWithProgress({
      images,
      concurrency: 1,
      maxRetries: 2,
      runProcess: async () => {
        repairCalls += 1;
        return { stdout: "", stderr: "", code: 0 };
      },
    });

    assert.equal(result.success, false);
    assert.deepEqual(pullCalls, ["nginx:alpine", "mongo:7"]);
    assert.equal(repairCalls, 0);
    assert.equal(result.snapshotStoreRepair, null);
    assert.deepEqual(
      result.failureDetails.map((detail) => detail.failureKind),
      ["overlayfs_snapshot_parent_missing", "registry_denied"],
    );
  } finally {
    restore();
  }
});

test("one pull output containing the exact signature and another terminal line fails without repair", async () => {
  const fixture = prepareUncompletedRuntimeFixture();
  const images = [{ name: "nginx", tag: "alpine", label: "Nginx" }];
  let repairCalls = 0;
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
    isPackaged: true,
    fullImages: images,
    spawnImpl: createDockerPullSpawnStub(() => ({
      code: 1,
      stderr: `${MISSING_SNAPSHOT_PARENT_SIGNATURE}\nno space left on device\n`,
    })),
  });

  try {
    const result = await service.pullDockerImagesWithProgress({
      images,
      concurrency: 1,
      runProcess: async () => {
        repairCalls += 1;
        return { stdout: "", stderr: "", code: 0 };
      },
    });

    assert.equal(result.success, false);
    assert.equal(result.failureDetails[0].failureKind, "docker_pull_failed");
    assert.equal(result.snapshotStoreRepair, null);
    assert.equal(repairCalls, 0);
  } finally {
    restore();
  }
});

test("mixed pull failure remains ineligible after more than the diagnostic tail limit", async () => {
  const fixture = prepareUncompletedRuntimeFixture();
  const images = [{ name: "nginx", tag: "alpine", label: "Nginx" }];
  const acceptedProgress = Array.from(
    { length: 600 },
    () => "0123456789ab: Already exists",
  ).join("\n");
  let repairCalls = 0;
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
    isPackaged: true,
    fullImages: images,
    spawnImpl: createDockerPullSpawnStub(() => ({
      code: 1,
      stderr: `no space left on device\n${acceptedProgress}\n${MISSING_SNAPSHOT_PARENT_SIGNATURE}\n`,
    })),
  });

  try {
    const result = await service.pullDockerImagesWithProgress({
      images,
      concurrency: 1,
      runProcess: async () => {
        repairCalls += 1;
        return { stdout: "", stderr: "", code: 0 };
      },
    });

    assert.equal(result.success, false);
    assert.equal(result.failureDetails[0].failureKind, "docker_pull_failed");
    assert.equal(result.failureDetails[0].retryable, false);
    assert.equal(result.snapshotStoreRepair, null);
    assert.equal(repairCalls, 0);
  } finally {
    restore();
  }
});

test("prerequisites cancellation aborts the owned repair and waits for process close before returning", async () => {
  const fixture = prepareUncompletedRuntimeFixture();
  const images = [{ name: "nginx", tag: "alpine", label: "Nginx" }];
  const pullCalls = [];
  let observedSignal = null;
  let processClosed = false;
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
    isPackaged: true,
    fullImages: images,
    spawnImpl: createDockerPullSpawnStub((imageRef) => {
      pullCalls.push(imageRef);
      return { code: 1, stderr: `${MISSING_SNAPSHOT_PARENT_SIGNATURE}\n` };
    }),
  });

  try {
    const repairStarted = new Promise((resolve) => {
      observedSignal = resolve;
    });
    const resultPromise = service.pullDockerImagesWithProgress({
      images,
      concurrency: 1,
      runProcess: (_command, _args, options) => new Promise((_resolve, reject) => {
        observedSignal(options.signal);
        options.signal.addEventListener("abort", () => {
          setImmediate(() => {
            processClosed = true;
            const error = new Error("Command aborted: bash");
            error.name = "AbortError";
            error.aborted = true;
            error.stderr = "repair stopped\n";
            reject(error);
          });
        }, { once: true });
      }),
    });

    const signal = await repairStarted;
    assert.equal(signal.aborted, false);
    let cancellationSettled = false;
    const cancellationPromise = service.cancelPrerequisites()
      .finally(() => { cancellationSettled = true; });

    assert.equal(signal.aborted, true);
    assert.equal(cancellationSettled, false);
    const [result] = await Promise.all([resultPromise, cancellationPromise]);
    assert.equal(processClosed, true);
    assert.equal(cancellationSettled, true);
    assert.equal(result.cancelled, true);
    assert.deepEqual(pullCalls, ["nginx:alpine"]);
    assert.equal(result.snapshotStoreRepair.cancelled, true);
  } finally {
    restore();
  }
});

test("concurrent pull owners share one cancellable repair process and neither replays before close", async () => {
  const fixture = prepareUncompletedRuntimeFixture();
  const images = [{ name: "nginx", tag: "alpine", label: "Nginx" }];
  const pullCalls = [];
  let repairCalls = 0;
  let closeRepair = null;
  let settledOwners = 0;
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
    isPackaged: true,
    fullImages: images,
    spawnImpl: createDockerPullSpawnStub((imageRef) => {
      pullCalls.push(imageRef);
      return { code: 1, stderr: `${MISSING_SNAPSHOT_PARENT_SIGNATURE}\n` };
    }),
  });

  try {
    const repairStarted = new Promise((resolve) => {
      closeRepair = { started: resolve, finish: null };
    });
    const runProcess = (_command, _args, options) => {
      repairCalls += 1;
      closeRepair.started(options.signal);
      return new Promise((_resolve, reject) => {
        closeRepair.finish = () => {
          const error = new Error("Command aborted: bash");
          error.name = "AbortError";
          error.aborted = true;
          reject(error);
        };
      });
    };

    const firstOwner = service.pullDockerImagesWithProgress({ images, concurrency: 1, runProcess })
      .finally(() => { settledOwners += 1; });
    const signal = await repairStarted;
    const secondOwner = service.pullDockerImagesWithProgress({ images, concurrency: 1, runProcess })
      .finally(() => { settledOwners += 1; });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(repairCalls, 1);
    assert.equal(pullCalls.length, 1);
    let cancellationSettled = false;
    const cancellationPromise = service.cancelPrerequisites()
      .finally(() => { cancellationSettled = true; });
    assert.equal(signal.aborted, true);
    assert.equal(cancellationSettled, false);
    assert.equal(settledOwners, 0);
    closeRepair.finish();

    const [firstResult, secondResult] = await Promise.all([
      firstOwner,
      secondOwner,
      cancellationPromise,
    ]);
    assert.equal(cancellationSettled, true);
    assert.equal(settledOwners, 2);
    assert.equal(firstResult.cancelled, true);
    assert.equal(secondResult.cancelled, true);
    assert.equal(firstResult.snapshotStoreRepair.cancelled, true);
    assert.equal(secondResult.snapshotStoreRepair.cancelled, true);
    assert.equal(repairCalls, 1);
    assert.equal(pullCalls.length, 1);
  } finally {
    restore();
  }
});

test("concurrent pull owners share one successful repair and exactly one full replay", async () => {
  const fixture = prepareUncompletedRuntimeFixture();
  const images = [{ name: "nginx", tag: "alpine", label: "Nginx" }];
  const locallyReady = new Set();
  const pullCalls = [];
  let repairCalls = 0;
  let finishRepair = null;
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
    isPackaged: true,
    fullImages: images,
    isReadyImage: (imageRef) => locallyReady.has(imageRef),
    spawnImpl: createDockerPullSpawnStub((imageRef) => {
      pullCalls.push(imageRef);
      if (pullCalls.length === 1) {
        return { code: 1, stderr: `${MISSING_SNAPSHOT_PARENT_SIGNATURE}\n` };
      }
      locallyReady.add(imageRef);
      return { code: 0 };
    }),
  });

  try {
    const repairStarted = new Promise((resolve) => {
      finishRepair = { started: resolve, close: null };
    });
    const runProcess = (_command, _args, options) => {
      repairCalls += 1;
      finishRepair.started(options);
      return new Promise((resolve) => {
        finishRepair.close = () => resolve({ stdout: "repair complete\n", stderr: "", code: 0 });
      });
    };

    const firstOwner = service.pullDockerImagesWithProgress({ images, concurrency: 1, runProcess });
    const repairOptions = await repairStarted;
    const secondOwner = service.pullDockerImagesWithProgress({ images, concurrency: 1, runProcess });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(repairCalls, 1);
    assert.equal(repairOptions.timeoutMs, 5 * 60 * 1000);
    assert.deepEqual(pullCalls, ["nginx:alpine"]);
    finishRepair.close();

    const [firstResult, secondResult] = await Promise.all([firstOwner, secondOwner]);
    assert.equal(firstResult.success, true);
    assert.equal(secondResult.success, true);
    assert.equal(firstResult.snapshotStoreRepair.success, true);
    assert.equal(secondResult.snapshotStoreRepair.success, true);
    assert.equal(repairCalls, 1);
    assert.deepEqual(pullCalls, [
      "nginx:alpine",
      "nginx:alpine",
    ]);
  } finally {
    restore();
  }
});

test("a joined recovery verifies its own plan locally and fails closed without another replay", async () => {
  const fixture = prepareUncompletedRuntimeFixture();
  const firstImages = [{ name: "nginx", tag: "alpine", label: "Nginx" }];
  const joinedImages = [{ name: "mongo", tag: "7", label: "MongoDB" }];
  const locallyReady = new Set();
  const pullCalls = [];
  let finishRepair = null;
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
    isPackaged: true,
    fullImages: [...firstImages, ...joinedImages],
    isReadyImage: (imageRef) => locallyReady.has(imageRef),
    spawnImpl: createDockerPullSpawnStub((imageRef) => {
      pullCalls.push(imageRef);
      if (pullCalls.length === 1) {
        return { code: 1, stderr: `${MISSING_SNAPSHOT_PARENT_SIGNATURE}\n` };
      }
      locallyReady.add(imageRef);
      return { code: 0 };
    }),
  });

  try {
    const repairStarted = new Promise((resolve) => {
      finishRepair = { started: resolve, close: null };
    });
    const runProcess = (_command, _args, options) => {
      finishRepair.started(options);
      return new Promise((resolve) => {
        finishRepair.close = () => resolve({ stdout: "repair complete\n", stderr: "", code: 0 });
      });
    };

    const firstOwner = service.pullDockerImagesWithProgress({
      images: firstImages,
      concurrency: 1,
      runProcess,
    });
    await repairStarted;
    const joinedOwner = service.pullDockerImagesWithProgress({
      images: joinedImages,
      concurrency: 1,
      runProcess,
    });
    finishRepair.close();

    const [firstResult, joinedResult] = await Promise.all([firstOwner, joinedOwner]);
    assert.equal(firstResult.success, true);
    assert.equal(joinedResult.success, false);
    assert.deepEqual(joinedResult.failed, ["mongo:7"]);
    assert.equal(joinedResult.failureDetails[0].retryable, false);
    assert.match(joinedResult.failureDetails[0].error, /not available after the shared snapshot-store recovery/);
    assert.deepEqual(pullCalls, ["nginx:alpine", "nginx:alpine"]);
  } finally {
    restore();
  }
});

test("finite repair timeout keeps recovery pending until the managed process closes", async () => {
  const fixture = prepareUncompletedRuntimeFixture();
  const images = [{ name: "nginx", tag: "alpine", label: "Nginx" }];
  let closeTimedOutProcess = null;
  let ownerSettled = false;
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
    isPackaged: true,
    fullImages: images,
    spawnImpl: createDockerPullSpawnStub(() => ({
      code: 1,
      stderr: `${MISSING_SNAPSHOT_PARENT_SIGNATURE}\n`,
    })),
  });

  try {
    const repairStarted = new Promise((resolve) => {
      closeTimedOutProcess = { started: resolve, close: null };
    });
    const resultPromise = service.pullDockerImagesWithProgress({
      images,
      concurrency: 1,
      runProcess: (_command, _args, options) => {
        closeTimedOutProcess.started(options);
        return new Promise((_resolve, reject) => {
          closeTimedOutProcess.close = () => {
            const error = new Error(`Command timed out after ${options.timeoutMs}ms: bash`);
            error.timedOut = true;
            error.stderr = "managed repair process closed after timeout\n";
            reject(error);
          };
        });
      },
    }).finally(() => {
      ownerSettled = true;
    });

    const repairOptions = await repairStarted;
    assert.equal(repairOptions.timeoutMs, 5 * 60 * 1000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ownerSettled, false);
    closeTimedOutProcess.close();

    const result = await resultPromise;
    assert.equal(ownerSettled, true);
    assert.equal(result.success, false);
    assert.equal(result.snapshotStoreRepair.success, false);
    assert.match(result.snapshotStoreRepair.error, /managed repair process closed after timeout/);
  } finally {
    restore();
  }
});

test("repeated missing snapshot parent after repair stops after one full replay", async () => {
  const fixture = prepareUncompletedRuntimeFixture();
  const images = [{ name: "nginx", tag: "alpine", label: "Nginx" }];
  const pullCalls = [];
  let repairCalls = 0;
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
    isPackaged: true,
    fullImages: images,
    spawnImpl: createDockerPullSpawnStub((imageRef) => {
      pullCalls.push(imageRef);
      return { code: 1, stderr: `${MISSING_SNAPSHOT_PARENT_SIGNATURE}\n` };
    }),
  });

  try {
    const result = await service.pullDockerImagesWithProgress({
      images,
      concurrency: 1,
      maxRetries: 2,
      allowOrbStackRestartRecovery: true,
      runProcess: async () => {
        repairCalls += 1;
        return { stdout: "", stderr: "", code: 0 };
      },
    });

    assert.equal(result.success, false);
    assert.deepEqual(pullCalls, ["nginx:alpine", "nginx:alpine"]);
    assert.equal(repairCalls, 1);
    assert.equal(result.failureDetails[0].retryable, false);
    assert.equal(result.failureDetails[0].failureKind, "overlayfs_snapshot_parent_missing");
  } finally {
    restore();
  }
});

test("a different failure after snapshot repair remains terminal to the pull owner", async () => {
  const fixture = prepareUncompletedRuntimeFixture();
  const images = [{ name: "nginx", tag: "alpine", label: "Nginx" }];
  const pullCalls = [];
  let repairCalls = 0;
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
    isPackaged: true,
    fullImages: images,
    spawnImpl: createDockerPullSpawnStub((imageRef) => {
      pullCalls.push(imageRef);
      return pullCalls.length === 1
        ? { code: 1, stderr: `${MISSING_SNAPSHOT_PARENT_SIGNATURE}\n` }
        : { code: 1, stderr: "Cannot connect to the Docker daemon\n" };
    }),
  });

  try {
    const result = await service.pullDockerImagesWithProgress({
      images,
      concurrency: 1,
      maxRetries: 2,
      allowOrbStackRestartRecovery: true,
      runProcess: async () => {
        repairCalls += 1;
        return { stdout: "", stderr: "", code: 0 };
      },
    });

    assert.equal(result.success, false);
    assert.deepEqual(pullCalls, ["nginx:alpine", "nginx:alpine"]);
    assert.equal(repairCalls, 1);
    assert.equal(result.failureDetails[0].failureKind, "daemon_unavailable");
    assert.match(result.snapshotStoreRepairError, /full image replay still failed/i);
    assert.equal(
      service.buildPackagedDockerRecoveryFailure(result, { imageSpecs: images }).code,
      "docker_snapshot_store_repair_required",
    );
  } finally {
    restore();
  }
});

// ============================================================================
// PORTICO-342: the Phase 1 payload download holds a power assertion.
//
// Reconstructing the reported install from its per-second progress lines showed
// 60.9 of ~65 minutes of dead time was the machine ASLEEP mid transfer. Four of the
// five failed attempts contained a suspension, and because the payload went to a
// disposable temp file each one restarted from byte zero: 2,294 MB moved for a
// 777 MB payload across 11 hours. This is the highest-value part of the fix, so
// these pin the policy rather than its spelling.
// ============================================================================

function fakePowerBlocker(overrides = {}) {
  const calls = { started: [], stopped: [] };
  const live = new Set();
  let next = 1;
  return {
    calls,
    start(type) {
      const id = next++;
      calls.started.push(type);
      live.add(id);
      return id;
    },
    isStarted(id) {
      return live.has(id);
    },
    stop(id) {
      calls.stopped.push(id);
      live.delete(id);
    },
    ...overrides,
  };
}

test("PORTICO-342: Phase 1 prevents system suspension, not display sleep", () => {
  const fixture = prepareUncompletedRuntimeFixture();
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
  });
  try {
    const blocker = fakePowerBlocker();
    const handle = service._test.startPhase1PowerAssertion(blocker);
    // 'prevent-display-sleep' would keep the user's screen lit all night for a
    // background download. Suspension is what actually killed the transfer.
    assert.deepEqual(blocker.calls.started, ["prevent-app-suspension"]);
    handle.release();
    assert.equal(blocker.calls.stopped.length, 1);
  } finally {
    restore();
  }
});

test("PORTICO-342: releasing the Phase 1 assertion twice cannot stop an unrelated one", () => {
  const fixture = prepareUncompletedRuntimeFixture();
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
  });
  try {
    const blocker = fakePowerBlocker();
    const first = service._test.startPhase1PowerAssertion(blocker);
    const second = service._test.startPhase1PowerAssertion(blocker);
    first.release();
    first.release();
    assert.equal(blocker.isStarted(2), true, "the second assertion must survive");
    second.release();
    assert.deepEqual(blocker.calls.stopped, [1, 2]);
  } finally {
    restore();
  }
});

test("PORTICO-342: power-management failures never block or break the download", () => {
  const fixture = prepareUncompletedRuntimeFixture();
  const { service, restore } = loadPrerequisitesService({
    projectRoot: fixture.projectRoot,
  });
  try {
    // An unprotected download still beats no download; the reporter was already
    // blocked, so failing closed here would be worse than the bug.
    const cannotStart = fakePowerBlocker({
      start() {
        throw new Error("power assertions unavailable");
      },
    });
    let handle;
    assert.doesNotThrow(() => {
      handle = service._test.startPhase1PowerAssertion(cannotStart);
    });
    assert.doesNotThrow(() => handle.release());

    // release() runs in a finally around the retry envelope; throwing there would
    // replace the real Phase 1 result with a power-management error.
    const cannotStop = fakePowerBlocker({
      stop() {
        throw new Error("stop failed");
      },
    });
    const stuck = service._test.startPhase1PowerAssertion(cannotStop);
    assert.doesNotThrow(() => stuck.release());
  } finally {
    restore();
  }
});
