const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildMacArchitectureMismatchDialogContent,
  detectMacHardwareArchitecture,
  enforcePackagedMacArchitectureMatch,
  getPackagedMacArchitectureMismatch,
} = require("./mac-arch-guard");

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

test("packaged x64 app on Apple Silicon is blocked with Apple Silicon guidance", () => {
  const dialogCalls = [];
  const exitCalls = [];

  const result = enforcePackagedMacArchitectureMatch({
    appRef: {
      isPackaged: true,
      runningUnderARM64Translation: true,
      exit(code) {
        exitCalls.push(code);
      },
    },
    dialogRef: {
      showErrorBox(title, message) {
        dialogCalls.push({ title, message });
      },
    },
    platform: "darwin",
    processArch: "x64",
    execFileSyncRef() {
      throw new Error("sysctl should not run when translation is already known");
    },
    logger: { log() {}, error() {} },
  });

  assert.equal(result.blocked, true);
  assert.equal(result.buildArch, "x64");
  assert.equal(result.hardwareArch, "arm64");
  assert.deepEqual(dialogCalls, [
    {
      title: "Wrong Build Installed",
      message:
        "This Mac uses Apple Silicon, but this copy of Portico is the Intel build.\n\n" +
        "Download the Apple Silicon build and open that instead.",
    },
  ]);
  assert.deepEqual(exitCalls, [1]);
});

test("packaged arm64 app on Apple Silicon is allowed", () => {
  const result = enforcePackagedMacArchitectureMatch({
    appRef: {
      isPackaged: true,
      runningUnderARM64Translation: false,
      exit() {
        throw new Error("exit should not be called");
      },
    },
    dialogRef: {
      showErrorBox() {
        throw new Error("dialog should not be shown");
      },
    },
    platform: "darwin",
    processArch: "arm64",
    execFileSyncRef() {
      return "1\n";
    },
    logger: { log() {}, error() {} },
  });

  assert.equal(result.blocked, false);
  assert.equal(result.hardwareArch, "arm64");
});

test("packaged x64 app on Intel is allowed", () => {
  const result = getPackagedMacArchitectureMismatch({
    appRef: { isPackaged: true, runningUnderARM64Translation: false },
    platform: "darwin",
    processArch: "x64",
    execFileSyncRef() {
      return "0\n";
    },
  });

  assert.equal(result.blocked, false);
  assert.equal(result.hardwareArch, "x64");
});

test("packaged macOS guard is skipped for unpackaged and non-macOS runs", () => {
  const unpackaged = getPackagedMacArchitectureMismatch({
    appRef: { isPackaged: false, runningUnderARM64Translation: true },
    platform: "darwin",
    processArch: "x64",
    execFileSyncRef() {
      return "1\n";
    },
  });
  const nonMac = getPackagedMacArchitectureMismatch({
    appRef: { isPackaged: true },
    platform: "linux",
    processArch: "x64",
  });

  assert.equal(unpackaged.blocked, false);
  assert.equal(nonMac.blocked, false);
});

test("sysctl host detection falls back to Apple Silicon when translation state is unavailable", () => {
  assert.equal(
    detectMacHardwareArchitecture({
      platform: "darwin",
      processArch: "x64",
      runningUnderARM64Translation: false,
      execFileSyncRef() {
        return "1\n";
      },
    }),
    "arm64",
  );
});

test("dialog content supports the inverse Intel guidance path", () => {
  assert.deepEqual(
    buildMacArchitectureMismatchDialogContent({
      buildArch: "arm64",
      hardwareArch: "x64",
    }),
    {
      title: "Wrong Build Installed",
      message:
        "This Mac uses Intel, but this copy of Portico is the Apple Silicon build.\n\n" +
        "Download the Intel build and open that instead.",
    },
  );
});

test("startup guard is enforced before migration, menu creation, and any window launch", () => {
  const mainSource = readRepoFile("electron-app/src/services/main.js");
  const startupMatch = mainSource.match(
    /app\s*\.whenReady\(\)\s*\.then\(async \(\) => \{([\s\S]*?)\}\)\s*\.catch/s,
  );

  assert.ok(startupMatch, "expected to locate the main startup block");

  const startupBlock = startupMatch[1];
  const guardIndex = startupBlock.indexOf("enforcePackagedMacArchitectureMatch({");
  const migrationIndex = startupBlock.indexOf("await performMigrationIfNeeded()");
  const menuIndex = startupBlock.indexOf("createMenu()");
  const loadingWindowIndex = startupBlock.indexOf("createLoadingWindow()");
  const mainWindowIndex = startupBlock.indexOf("createMainWindow()");

  assert.ok(guardIndex >= 0, "expected startup to invoke the mac architecture guard");
  assert.ok(migrationIndex >= 0, "expected startup to perform migration work");
  assert.ok(menuIndex >= 0, "expected startup to create the application menu");
  assert.ok(loadingWindowIndex >= 0, "expected startup to create the loading window");
  assert.ok(mainWindowIndex >= 0, "expected startup to create the main window in config mode");
  assert.ok(
    guardIndex < migrationIndex,
    "the mac architecture guard must run before migration work",
  );
  assert.ok(
    guardIndex < menuIndex,
    "the mac architecture guard must run before menu creation",
  );
  assert.ok(
    guardIndex < loadingWindowIndex,
    "the mac architecture guard must run before loading window creation",
  );
  assert.ok(
    guardIndex < mainWindowIndex,
    "the mac architecture guard must run before main window creation",
  );
});
