const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  evaluateSetupRequirementStatus,
  inspectAppleDeveloperToolsState,
  inspectOrbStackInstallationState,
  markSetupRequirementCompleted,
  validateSetupCompletionPrerequisites,
} = require("./setup-completion");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "setup-completion-"));
}

function writeSetupRequirement(appRoot, setupRequirementId) {
  fs.mkdirSync(appRoot, { recursive: true });
  fs.writeFileSync(
    path.join(appRoot, "setup-requirement.json"),
    `${JSON.stringify({ schemaVersion: 1, setupRequirementId }, null, 2)}\n`,
    "utf8",
  );
}

function writeEnv(projectRoot, porticoUserName = "Dan Santiago") {
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, ".env"),
    `PORTICO_USER_ID=dsantiago\nPORTICO_USER_NAME=${porticoUserName}\n`,
    "utf8",
  );
}

function writeRuntimeFiles(projectRoot, { llmGatewayMode = "bifrost" } = {}) {
  fs.mkdirSync(path.join(projectRoot, "src", "scripts"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "electron-app"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "docker-compose.yml"), "services:\n", "utf8");
  fs.writeFileSync(path.join(projectRoot, "docker-compose.advanced.yml"), "services:\n", "utf8");
  fs.writeFileSync(path.join(projectRoot, "cloudsmith.env"), "CLOUDSMITH_OWNER=portico\n", "utf8");
  fs.writeFileSync(
    path.join(projectRoot, "electron-app", "build-info.json"),
    '{"buildNumber":"03112026-abcdef12"}\n',
    "utf8",
  );
  fs.writeFileSync(path.join(projectRoot, "src", "scripts", "docker-compose.sh"), "#!/bin/bash\n", "utf8");
  fs.writeFileSync(path.join(projectRoot, ".env.runtime"), `LLM_GATEWAY_MODE=${llmGatewayMode}\n`, "utf8");
}

function createOrbStackApp(root) {
  const appPath = path.join(root, "OrbStack.app");
  const orbctlPath = path.join(appPath, "Contents", "MacOS", "bin", "orbctl");
  fs.mkdirSync(path.dirname(orbctlPath), { recursive: true });
  fs.writeFileSync(orbctlPath, "#!/bin/sh\n", { mode: 0o755 });
  return appPath;
}

function successfulDeveloperToolsProbe(_command, args) {
  return args[0] === "-p"
    ? {
      status: 0,
      stdout: "/Library/Developer/CommandLineTools\n",
      stderr: "",
    }
    : {
      status: 0,
      stdout: "/Library/Developer/CommandLineTools/usr/bin/stapler\n",
      stderr: "",
    };
}

function evaluateFixture({
  projectRoot,
  userDataPath,
  appRoot,
  platform = "linux",
  spawnSyncRef,
  orbStackAppPaths,
}) {
  return evaluateSetupRequirementStatus({
    projectRoot,
    userDataPath,
    appRoot,
    platform,
    spawnSyncRef,
    orbStackAppPaths,
  });
}

test("partial setup files never backfill completion while Command Line Tools are missing", () => {
  const root = makeTempDir();
  const projectRoot = path.join(root, "project");
  const userDataPath = path.join(root, "user-data");
  const appRoot = path.join(root, "app-root");

  writeSetupRequirement(appRoot, "requirement-a");
  writeEnv(projectRoot);
  writeRuntimeFiles(projectRoot);

  const result = evaluateFixture({
    projectRoot,
    userDataPath,
    appRoot,
    platform: "darwin",
    spawnSyncRef() {
      return {
        status: 1,
        stdout: "",
        stderr: "xcode-select: error: No developer tools were found.",
      };
    },
    orbStackAppPaths: [createOrbStackApp(root)],
  });
  assert.equal(result.needsSetup, true);
  assert.equal(result.reason, "command-line-tools-unavailable");
  assert.equal(result.setupRequirementId, "requirement-a");
  assert.equal(fs.existsSync(path.join(userDataPath, "setup-completion.json")), false);
});

test("healthy markerless legacy setup is backfilled only after live prerequisite probes", () => {
  const root = makeTempDir();
  const projectRoot = path.join(root, "project");
  const userDataPath = path.join(root, "user-data");
  const appRoot = path.join(root, "app-root");

  writeSetupRequirement(appRoot, "requirement-a");
  writeEnv(projectRoot);
  writeRuntimeFiles(projectRoot);
  const result = evaluateFixture({
    projectRoot,
    userDataPath,
    appRoot,
    platform: "darwin",
    spawnSyncRef: successfulDeveloperToolsProbe,
    orbStackAppPaths: [createOrbStackApp(root)],
  });

  assert.equal(result.needsSetup, false);
  assert.equal(result.backfilledCompletion, true);
  const completion = JSON.parse(
    fs.readFileSync(path.join(userDataPath, "setup-completion.json"), "utf8"),
  );
  assert.equal(
    completion.completedRequirements["requirement-a"].buildNumber,
    "03112026-abcdef12",
  );
});

test("markerless setup is not backfilled while OrbStack is missing", () => {
  const root = makeTempDir();
  const projectRoot = path.join(root, "project");
  const userDataPath = path.join(root, "user-data");
  const appRoot = path.join(root, "app-root");

  writeSetupRequirement(appRoot, "requirement-a");
  writeEnv(projectRoot);
  writeRuntimeFiles(projectRoot);
  const result = evaluateFixture({
    projectRoot,
    userDataPath,
    appRoot,
    platform: "darwin",
    spawnSyncRef: successfulDeveloperToolsProbe,
    orbStackAppPaths: [path.join(root, "missing-OrbStack.app")],
  });

  assert.equal(result.needsSetup, true);
  assert.equal(result.reason, "orbstack-unavailable");
  assert.equal(fs.existsSync(path.join(userDataPath, "setup-completion.json")), false);
});

test("Apple developer tools probe rejects the xcrun shim when no toolchain is selected", () => {
  const calls = [];
  const result = inspectAppleDeveloperToolsState({
    platform: "darwin",
    spawnSyncRef(command, args) {
      calls.push([command, args]);
      return {
        status: 1,
        stdout: "",
        stderr: "xcode-select: error: No developer tools were found.",
      };
    },
  });

  assert.equal(result.isComplete, false);
  assert.equal(result.reason, "command-line-tools-unavailable");
  assert.match(result.reasonMessage, /Command Line Tools are missing or incomplete/);
  assert.deepEqual(calls, [["/usr/bin/xcode-select", ["-p"]]]);
});

test("Apple developer tools probe requires stapler to resolve through xcrun", () => {
  const result = inspectAppleDeveloperToolsState({
    platform: "darwin",
    spawnSyncRef(_command, args) {
      if (args[0] === "-p") {
        return {
          status: 0,
          stdout: "/Library/Developer/CommandLineTools\n",
          stderr: "",
        };
      }
      return {
        status: 1,
        stdout: "",
        stderr: "xcrun: error: unable to find utility stapler",
      };
    },
  });

  assert.equal(result.isComplete, false);
  assert.equal(result.selectedDeveloperDir, "/Library/Developer/CommandLineTools");
  assert.match(result.reasonMessage, /cannot run stapler/);
});

test("OrbStack probe requires an executable orbctl inside the app bundle", () => {
  const root = makeTempDir();
  const appPath = createOrbStackApp(root);
  const orbctlPath = path.join(appPath, "Contents", "MacOS", "bin", "orbctl");
  fs.chmodSync(orbctlPath, 0o644);

  let result = inspectOrbStackInstallationState({
    platform: "darwin",
    appPaths: [appPath],
  });
  assert.equal(result.isComplete, false);
  assert.equal(result.reason, "orbstack-unavailable");

  fs.chmodSync(orbctlPath, 0o755);
  result = inspectOrbStackInstallationState({
    platform: "darwin",
    appPaths: [appPath],
  });
  assert.equal(result.isComplete, true);
  assert.equal(result.orbctlPath, orbctlPath);
});

test("missing completion record still requires setup when .env is incomplete", () => {
  const root = makeTempDir();
  const projectRoot = path.join(root, "project");
  const userDataPath = path.join(root, "user-data");
  const appRoot = path.join(root, "app-root");

  writeSetupRequirement(appRoot, "requirement-a");
  writeRuntimeFiles(projectRoot);

  const result = evaluateFixture({ projectRoot, userDataPath, appRoot });
  assert.equal(result.needsSetup, true);
  assert.equal(result.reason, "setup-not-completed");
  assert.equal(fs.existsSync(path.join(userDataPath, "setup-completion.json")), false);
});

test("missing project root fails closed before incomplete onboarding", () => {
  const root = makeTempDir();
  const projectRoot = path.join(root, "missing-project");
  const userDataPath = path.join(root, "user-data");
  const appRoot = path.join(root, "app-root");

  writeSetupRequirement(appRoot, "requirement-a");
  const result = evaluateFixture({ projectRoot, userDataPath, appRoot });
  assert.equal(result.needsSetup, true);
  assert.equal(result.reason, "project-root-missing");
});

test("malformed existing completion records fail closed", () => {
  const root = makeTempDir();
  const projectRoot = path.join(root, "project");
  const userDataPath = path.join(root, "user-data");
  const appRoot = path.join(root, "app-root");

  writeSetupRequirement(appRoot, "requirement-a");
  writeEnv(projectRoot);
  writeRuntimeFiles(projectRoot);
  fs.mkdirSync(userDataPath, { recursive: true });

  for (const record of [
    { schemaVersion: 1 },
    { schemaVersion: 1, completedRequirements: { "requirement-a": null } },
    {
      schemaVersion: 1,
      completedRequirements: {
        "requirement-a": { completedAt: "2026-06-22T00:00:00.000Z" },
      },
    },
  ]) {
    fs.writeFileSync(
      path.join(userDataPath, "setup-completion.json"),
      `${JSON.stringify(record)}\n`,
      "utf8",
    );
    const result = evaluateFixture({ projectRoot, userDataPath, appRoot });
    assert.equal(result.needsSetup, true);
    assert.equal(result.reason, "setup-completion-invalid");
  }
});

test("matching completion record and valid .env skip guided setup", () => {
  const root = makeTempDir();
  const projectRoot = path.join(root, "project");
  const userDataPath = path.join(root, "user-data");
  const appRoot = path.join(root, "app-root");

  writeSetupRequirement(appRoot, "requirement-a");
  writeEnv(projectRoot);
  writeRuntimeFiles(projectRoot);
  const completion = markSetupRequirementCompleted({
    userDataPath,
    setupRequirementId: "requirement-a",
    buildNumber: "03112026-abcdef12",
  });
  assert.equal(completion.success, true);

  const result = evaluateFixture({ projectRoot, userDataPath, appRoot });
  assert.equal(result.needsSetup, false);
  assert.equal(result.setupRequirementId, "requirement-a");
});

test("an existing completion record is revalidated when Command Line Tools disappear", () => {
  const root = makeTempDir();
  const projectRoot = path.join(root, "project");
  const userDataPath = path.join(root, "user-data");
  const appRoot = path.join(root, "app-root");

  writeSetupRequirement(appRoot, "requirement-a");
  writeEnv(projectRoot);
  writeRuntimeFiles(projectRoot);
  markSetupRequirementCompleted({
    userDataPath,
    setupRequirementId: "requirement-a",
    buildNumber: "03112026-abcdef12",
  });

  const result = evaluateFixture({
    projectRoot,
    userDataPath,
    appRoot,
    platform: "darwin",
    spawnSyncRef() {
      return {
        status: 1,
        stdout: "",
        stderr: "xcode-select: error: No developer tools were found.",
      };
    },
    orbStackAppPaths: [path.join(root, "missing-OrbStack.app")],
  });

  assert.equal(result.needsSetup, true);
  assert.equal(result.reason, "command-line-tools-unavailable");
});

test("setup completion validation fails closed before writing a marker", () => {
  const root = makeTempDir();
  const projectRoot = path.join(root, "project");
  writeEnv(projectRoot);
  writeRuntimeFiles(projectRoot);

  const result = validateSetupCompletionPrerequisites({
    projectRoot,
    platform: "darwin",
    spawnSyncRef() {
      return {
        status: 1,
        stdout: "",
        stderr: "xcode-select: error: No developer tools were found.",
      };
    },
    appPaths: [path.join(root, "missing-OrbStack.app")],
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, "command-line-tools-unavailable");
  assert.match(result.error, /Command Line Tools/);
});

test("bumping setupRequirementId forces guided setup again", () => {
  const root = makeTempDir();
  const projectRoot = path.join(root, "project");
  const userDataPath = path.join(root, "user-data");
  const appRoot = path.join(root, "app-root");

  writeSetupRequirement(appRoot, "requirement-a");
  writeEnv(projectRoot);
  writeRuntimeFiles(projectRoot);
  const completion = markSetupRequirementCompleted({
    userDataPath,
    setupRequirementId: "requirement-a",
    buildNumber: "03112026-abcdef12",
  });
  assert.equal(completion.success, true);

  writeSetupRequirement(appRoot, "requirement-b");

  const result = evaluateFixture({ projectRoot, userDataPath, appRoot });
  assert.equal(result.needsSetup, true);
  assert.equal(result.reason, "setup-not-completed");
  assert.equal(result.setupRequirementId, "requirement-b");
});

test("missing .env still requires guided setup even after completion was recorded", () => {
  const root = makeTempDir();
  const projectRoot = path.join(root, "project");
  const userDataPath = path.join(root, "user-data");
  const appRoot = path.join(root, "app-root");

  writeSetupRequirement(appRoot, "requirement-a");
  writeRuntimeFiles(projectRoot);
  const completion = markSetupRequirementCompleted({
    userDataPath,
    setupRequirementId: "requirement-a",
    buildNumber: "03112026-abcdef12",
  });
  assert.equal(completion.success, true);

  const result = evaluateFixture({ projectRoot, userDataPath, appRoot });
  assert.equal(result.needsSetup, true);
  assert.equal(result.reason, "env-missing");
});

test("completed setup reconciles when either identity mirror is missing", () => {
  const root = makeTempDir();
  const projectRoot = path.join(root, "project");
  const userDataPath = path.join(root, "user-data");
  const appRoot = path.join(root, "app-root");

  writeSetupRequirement(appRoot, "requirement-a");
  writeRuntimeFiles(projectRoot);
  markSetupRequirementCompleted({
    userDataPath,
    setupRequirementId: "requirement-a",
    buildNumber: "03112026-abcdef12",
  });

  for (const content of [
    "PORTICO_USER_NAME=Dan Santiago\n",
    "PORTICO_USER_ID=dsantiago\n",
  ]) {
    fs.writeFileSync(path.join(projectRoot, ".env"), content, "utf8");
    const result = evaluateFixture({ projectRoot, userDataPath, appRoot });
    assert.equal(result.needsSetup, true);
    assert.equal(result.reason, "env-user-missing");
  }
});

test("missing setup requirement manifest forces guided setup", () => {
  const root = makeTempDir();
  const projectRoot = path.join(root, "project");
  const userDataPath = path.join(root, "user-data");
  const appRoot = path.join(root, "app-root");

  writeEnv(projectRoot);
  writeRuntimeFiles(projectRoot);

  const result = evaluateFixture({ projectRoot, userDataPath, appRoot });
  assert.equal(result.needsSetup, true);
  assert.equal(result.reason, "setup-requirement-missing");
});

test("missing required runtime files forces guided setup again", () => {
  const root = makeTempDir();
  const projectRoot = path.join(root, "project");
  const userDataPath = path.join(root, "user-data");
  const appRoot = path.join(root, "app-root");

  writeSetupRequirement(appRoot, "requirement-a");
  writeEnv(projectRoot);
  writeRuntimeFiles(projectRoot, { llmGatewayMode: "bifrost" });
  fs.rmSync(path.join(projectRoot, "src", "scripts", "docker-compose.sh"));

  const completion = markSetupRequirementCompleted({
    userDataPath,
    setupRequirementId: "requirement-a",
    buildNumber: "03112026-abcdef12",
  });
  assert.equal(completion.success, true);

  const result = evaluateFixture({ projectRoot, userDataPath, appRoot });
  assert.equal(result.needsSetup, true);
  assert.equal(result.reason, "runtime-file-missing");
  assert.match(result.reasonMessage, /src\/scripts\/docker-compose\.sh/);
});
