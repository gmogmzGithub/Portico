const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const childProcess = require("node:child_process");

const serviceModulePath = require.resolve("./prerequisites-service");
const bootstrapModulePath = require.resolve("./bootstrap");
const prereqLoggerModulePath = require.resolve("./prereq-logger");
const dockerImagePlanModulePath = require.resolve("./docker-image-plan");
const mcpOrcCliModulePath = require.resolve("./mcp-orc-cli");
const originalLoad = Module._load;

const IMAGE_BASE = "harbor.example.invalid/portico";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "prereq-packaged-policy-"));
}

function writeRuntimeFiles(projectRoot, buildNumber = "dev-build") {
  fs.mkdirSync(path.join(projectRoot, "src", "scripts"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "electron-app"), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, "electron-app", "build-info.json"),
    `${JSON.stringify({ buildNumber })}\n`,
    "utf8",
  );
  fs.writeFileSync(path.join(projectRoot, "docker-compose.yml"), "services:\n", "utf8");
  fs.writeFileSync(path.join(projectRoot, ".env.runtime"), "LLM_GATEWAY_MODE=bifrost\n", "utf8");
}

function loadPrerequisitesService({
  buildNumber = "dev-build",
  isPackaged = false,
  harborToLocalMap = {},
  fullImages = [],
} = {}) {
  const projectRoot = makeTempDir();
  writeRuntimeFiles(projectRoot, buildNumber);

  const previousBootstrap = require.cache[bootstrapModulePath];
  const previousPrereqLogger = require.cache[prereqLoggerModulePath];
  const previousDockerImagePlan = require.cache[dockerImagePlanModulePath];
  const previousMcpOrcCli = require.cache[mcpOrcCliModulePath];
  const previousService = require.cache[serviceModulePath];
  const previousResourcesPath = process.resourcesPath;

  process.resourcesPath = path.join(projectRoot, "electron-app");

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") {
      return {
        app: {
          getPath() {
            return path.join(projectRoot, "user-data");
          },
          isPackaged,
        },
      };
    }

    if (request === "child_process") {
      return {
        ...childProcess,
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
      harborToLocalImageRef(imageRef) {
        return harborToLocalMap[imageRef] || null;
      },
      HARBOR_IMAGE_BASE: IMAGE_BASE,
    },
  };
  require.cache[mcpOrcCliModulePath] = {
    id: mcpOrcCliModulePath,
    filename: mcpOrcCliModulePath,
    loaded: true,
    exports: {
      resolveMcpOrcBinary() {
        return "/tmp/mcp-orc";
      },
    },
  };

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

      if (previousMcpOrcCli) {
        require.cache[mcpOrcCliModulePath] = previousMcpOrcCli;
      } else {
        delete require.cache[mcpOrcCliModulePath];
      }

      if (previousService) {
        require.cache[serviceModulePath] = previousService;
      }
    },
  };
}

test("packaged managed builds require the exact Harbor-tagged image ref", () => {
  const exactRef = `${IMAGE_BASE}/mcp-orc-rust:04032026-261faa30`;
  const localRef = "mcp-orc-rust:04032026-261faa30";
  const { service, restore } = loadPrerequisitesService({
    buildNumber: "04032026-261faa30",
    isPackaged: true,
    harborToLocalMap: {
      [exactRef]: localRef,
    },
  });

  try {
    const refs = service._test.getCandidateImageRefsForSpec({
      name: `${IMAGE_BASE}/mcp-orc-rust`,
      tag: "04032026-261faa30",
      label: "MCP Runtime",
    });
    assert.deepEqual(refs, [exactRef]);
    assert.equal(service._test.isPackagedManagedBuild(), true);
  } finally {
    restore();
  }
});

test("dev builds still allow local image aliases for Harbor-tagged refs", () => {
  const exactRef = `${IMAGE_BASE}/mcp-orc-rust:dev-build`;
  const localRef = "mcp-orc-rust:dev-build";
  const { service, restore } = loadPrerequisitesService({
    buildNumber: "dev-build",
    isPackaged: false,
    harborToLocalMap: {
      [exactRef]: localRef,
    },
  });

  try {
    const refs = service._test.getCandidateImageRefsForSpec({
      name: `${IMAGE_BASE}/mcp-orc-rust`,
      tag: "dev-build",
      label: "MCP Runtime",
    });
    assert.deepEqual(refs, [exactRef, localRef]);
    assert.equal(service._test.isPackagedManagedBuild(), false);
  } finally {
    restore();
  }
});

test("packaged Harbor pull errors surface timeout reasons", () => {
  const { service, restore } = loadPrerequisitesService({
    buildNumber: "04032026-261faa30",
    isPackaged: true,
  });

  try {
    const message = service._test.buildRequiredDockerPullFailureError({
      failureDetails: [
        {
          image: "nginx:alpine",
          failureKind: "timeout_inactivity",
          error: "No pull activity for 480s",
        },
        {
          image: `${IMAGE_BASE}/mcp-orc-rust:04032026-261faa30`,
          failureKind: "timeout_total",
          error: "Timed out after 1200s total",
        },
      ],
    });

    assert.match(message, /Required Docker images could not be downloaded from Harbor after retries/);
    assert.match(message, /nginx:alpine \(No pull activity for 480s\)/);
    assert.match(message, /mcp-orc-rust:04032026-261faa30 \(Timed out after 1200s total\)/);
  } finally {
    restore();
  }
});

test("packaged Harbor pull errors surface recovery budget exhaustion distinctly", () => {
  const { service, restore } = loadPrerequisitesService({
    buildNumber: "04032026-261faa30",
    isPackaged: true,
  });

  try {
    const exhaustedFailure = service._test.buildRecoveryBudgetExhaustedFailure(
      "nginx:alpine",
      {
        recoveryBudgetMs: 30 * 60 * 1000,
        recoveryExhaustedBeforeAttempt: true,
      },
    );
    const message = service._test.buildRequiredDockerPullFailureError({
      failureDetails: [exhaustedFailure],
    });

    assert.match(
      message,
      /within the 30 minute recovery budget/,
    );
    assert.match(
      message,
      /nginx:alpine \(Not attempted - recovery budget exhausted before reaching this image\)/,
    );
  } finally {
    restore();
  }
});

test("docker pull recovery budget scales with retryable failure count", () => {
  const { service, restore } = loadPrerequisitesService();

  try {
    assert.equal(service._test.getDockerPullRecoveryBudgetMs(0), 30 * 60 * 1000);
    assert.equal(service._test.getDockerPullRecoveryBudgetMs(2), 30 * 60 * 1000);
    assert.equal(service._test.getDockerPullRecoveryBudgetMs(10), 45 * 60 * 1000);
  } finally {
    restore();
  }
});

test("packaged docker recovery payload builds a single copyable pull command", () => {
  const fullImages = [
    { name: "redis", tag: "7-alpine", label: "Redis Cache" },
    { name: `${IMAGE_BASE}/mcp-orc-rust`, tag: "04032026-261faa30", label: "MCP Runtime" },
    { name: "nginx", tag: "alpine", label: "Nginx" },
  ];
  const { service, restore } = loadPrerequisitesService({
    buildNumber: "04032026-261faa30",
    isPackaged: true,
    fullImages,
  });

  try {
    const recovery = service._test.buildDockerPullRecoveryPayload(
      service._test.prioritizeDockerImagesForPull(fullImages),
    );
    assert.equal(recovery.title, "Run This In Terminal");
    assert.equal(recovery.restartOnRetry, true);
    assert.match(recovery.command, /^docker pull "harbor\.example\.invalid\/portico\/mcp-orc-rust:04032026-261faa30" && \\/m);
    assert.match(recovery.command, /docker pull "redis:7-alpine" && \\/);
    assert.match(recovery.command, /docker pull "nginx:alpine" && \\/);
    assert.match(recovery.command, /echo "Done - click Retry in Portico"$/);
  } finally {
    restore();
  }
});

test("docker pull recovery ceilings clamp all per-image timers to the remaining aggregate budget", () => {
  const { service, restore } = loadPrerequisitesService();

  try {
    assert.deepEqual(
      service._test.getDockerPullTimeoutCeilings(1_000_000, 999_250),
      {
        remainingBudgetMs: 750,
        inactivityTimeoutMs: 750,
        extractionInactivityTimeoutMs: 750,
        totalTimeoutMs: 750,
      },
    );
  } finally {
    restore();
  }
});

test("docker pull classification treats daemon failures as retryable runtime errors", () => {
  const { service, restore } = loadPrerequisitesService();

  try {
    const result = service._test.classifyDockerPullFailure({
      stderr:
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n",
      exitCode: 1,
    });

    assert.equal(result.failureKind, "daemon_unavailable");
    assert.equal(result.retryable, true);
    assert.match(result.error, /Cannot connect to the Docker daemon/);
  } finally {
    restore();
  }
});

test("docker pull classification keeps registry denials out of automatic Docker recovery", () => {
  const { service, restore } = loadPrerequisitesService();

  try {
    const result = service._test.classifyDockerPullFailure({
      stderr: "pull access denied, repository does not exist or may require authorization: requested access to the resource is denied\n",
      exitCode: 1,
    });

    assert.equal(result.failureKind, "registry_denied");
    assert.equal(result.retryable, false);
    assert.match(result.error, /requested access to the resource is denied/);
  } finally {
    restore();
  }
});
