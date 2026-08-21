const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildRuntimeDiagnosticsText,
  collectStaleGuidedSetupAppBuildInfo,
  isStaleGuidedSetupAppPath,
  summarizeLastInstalledBuildState,
} = require("./app-runtime-diagnostics");

test("detects stale guided-setup app launch paths", () => {
  assert.equal(
    isStaleGuidedSetupAppPath(
      "/Users/dihlo/portico/portico-managed/guided-setup/dist/mac-arm64/Portico.app/Contents/Resources/app.asar",
    ),
    true,
  );
  assert.equal(
    isStaleGuidedSetupAppPath(
      "/Applications/Portico.app/Contents/Resources/app.asar",
    ),
    false,
  );
});

test("collects stale guided-setup app build-info files from managed root", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-diagnostics-"));
  const buildInfoPath = path.join(
    tmpDir,
    "guided-setup",
    "dist",
    "mac-arm64",
    "Portico.app",
    "Contents",
    "Resources",
    "build-info.json",
  );
  fs.mkdirSync(path.dirname(buildInfoPath), { recursive: true });
  fs.writeFileSync(buildInfoPath, '{"buildNumber":"11042025-224ca842"}\n');

  const findings = collectStaleGuidedSetupAppBuildInfo({ managedRoot: tmpDir });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].path, buildInfoPath);
  assert.match(findings[0].content, /11042025-224ca842/);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("runtime diagnostics include launch paths and stale build metadata", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-diagnostics-"));
  const managedRoot = path.join(tmpDir, "portico", "portico-managed");
  const homeDir = path.join(tmpDir, "home");
  const appResources = path.join(
    tmpDir,
    "Applications",
    "Portico.app",
    "Contents",
    "Resources",
  );
  const buildInfoPath = path.join(
    managedRoot,
    "guided-setup",
    "dist",
    "mac-arm64",
    "Portico.app",
    "Contents",
    "Resources",
    "build-info.json",
  );
  fs.mkdirSync(path.dirname(buildInfoPath), { recursive: true });
  fs.writeFileSync(buildInfoPath, '{"buildNumber":"11042025-224ca842"}\n');
  fs.mkdirSync(appResources, { recursive: true });
  fs.mkdirSync(path.join(managedRoot, "electron-app"), { recursive: true });
  fs.writeFileSync(
    path.join(appResources, "build-info.json"),
    '{"buildNumber":"06292026-5c5bc1aa","fullSha":"5c5bc1aa2a3e403790d7a5f345c21b997059aa29","timestamp":"2026-06-29T17:53:07.000Z","channel":"portico_dev"}\n',
  );
  fs.writeFileSync(
    path.join(managedRoot, "electron-app", "build-info.json"),
    '{"buildNumber":"06292026-e10cd4b0","fullSha":"e10cd4b00b6952f337ebd0cfcc6c293b9e4de8ce","timestamp":"2026-06-29T20:52:10.000Z","channel":"portico_beta-staging"}\n',
  );
  fs.writeFileSync(
    path.join(managedRoot, "UPDATE_CHANNEL"),
    "portico_beta-staging\n",
  );
  const lastInstalledPath = path.join(
    homeDir,
    "Library",
    "Application Support",
    "portico",
    "LAST_INSTALLED_BUILD",
  );
  fs.mkdirSync(path.dirname(lastInstalledPath), { recursive: true });
  fs.writeFileSync(lastInstalledPath, "2026-06-29T23:36:09.428883Z");

  const diagnostics = buildRuntimeDiagnosticsText({
    managedRoot,
    homeDir,
    projectRoot: managedRoot,
    appRef: {
      getAppPath() {
        return path.join(
          managedRoot,
          "guided-setup",
          "dist",
          "mac-arm64",
          "Portico.app",
          "Contents",
          "Resources",
          "app.asar",
        );
      },
      getPath(name) {
        assert.equal(name, "exe");
        return path.join(
          managedRoot,
          "guided-setup",
          "dist",
          "mac-arm64",
          "Portico.app",
          "Contents",
          "MacOS",
          "Portico",
        );
      },
    },
    processRef: {
      execPath: "/Applications/Portico.app/Contents/MacOS/Portico",
      resourcesPath: appResources,
      cwd() {
        return managedRoot;
      },
    },
  });

  assert.match(diagnostics, /process\.resourcesPath:/);
  assert.match(diagnostics, /staleLaunchDetected: true/);
  assert.match(diagnostics, /11042025-224ca842/);
  assert.match(diagnostics, /=== Installed Build State ===/);
  assert.match(diagnostics, /appBuildInfo: buildNumber=06292026-5c5bc1aa/);
  assert.match(diagnostics, /managedBuildInfo: buildNumber=06292026-e10cd4b0/);
  assert.match(diagnostics, /updateChannel: portico_beta-staging/);
  assert.match(diagnostics, /lastInstalledBuild: legacyTimestamp=2026-06-29T23:36:09\.428883Z/);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("last installed build diagnostics distinguish structured and legacy state", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-diagnostics-"));
  const statePath = path.join(tmpDir, "LAST_INSTALLED_BUILD");

  fs.writeFileSync(
    statePath,
    '{"schemaVersion":1,"buildNumber":"06292026-e10cd4b0","timestamp":"2026-06-29T23:36:09.428883Z"}\n',
  );
  assert.match(
    summarizeLastInstalledBuildState(statePath),
    /schemaVersion=1 buildNumber=06292026-e10cd4b0 timestamp=2026-06-29T23:36:09\.428883Z/,
  );

  fs.writeFileSync(statePath, "2026-06-29T23:36:09.428883Z");
  assert.equal(
    summarizeLastInstalledBuildState(statePath),
    "legacyTimestamp=2026-06-29T23:36:09.428883Z",
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// PORTICO-443: address-space telemetry in the debug bundle.
//
// The crash was a main-process V8 OOM caused by mapping exhaustion (27,599 VM
// regions against ~1,887 healthy). Nothing in the bundle could have shown it.
// These cases pin the wiring that makes the next occurrence diagnosable, and pin
// that telemetry can never prevent a bundle from being produced.
// ============================================================================

const { formatAddressSpaceReport } = require("./address-space-telemetry");

const portico443_SNAPSHOT = {
  baselineRegions: 1887,
  peakRegions: 27599,
  fast: [],
  slow: [],
  growthSnapshot: {
    t: 1,
    baselineRegions: 1887,
    totalRegions: 27599,
    byTag: [{ label: "Memory Tag 255", regions: 15969 }],
  },
};

test("PORTICO-443: the bundle carries the address-space block when telemetry ran", () => {
  const text = buildRuntimeDiagnosticsText({
    projectRoot: "/tmp/project",
    addressSpaceSnapshot: portico443_SNAPSHOT,
    formatAddressSpace: formatAddressSpaceReport,
  });
  assert.match(text, /27599/, "the region count that diagnoses the crash");
  assert.match(text, /15969/, "the per-tag breakdown that names the subsystem");
});

test("PORTICO-443: the block goes after the existing build-state section", () => {
  const text = buildRuntimeDiagnosticsText({
    projectRoot: "/tmp/project",
    addressSpaceSnapshot: portico443_SNAPSHOT,
    formatAddressSpace: formatAddressSpaceReport,
  });
  // Ordering is deliberate: readers already know where the build state lives.
  assert.ok(
    text.indexOf("Installed Build State") < text.indexOf("Address Space"),
    "address-space telemetry must be appended, not inserted",
  );
});

test("PORTICO-443: without telemetry the diagnostics are unchanged", () => {
  const text = buildRuntimeDiagnosticsText({ projectRoot: "/tmp/project" });
  assert.equal(
    /Address Space/i.test(text),
    false,
    "absent monitor must mean an absent block, not an empty heading",
  );
  assert.match(text, /Installed Build State/, "everything else still present");
});

test("PORTICO-443: half-wired telemetry omits the block instead of emitting junk", () => {
  const snapshotOnly = buildRuntimeDiagnosticsText({
    projectRoot: "/tmp/project",
    addressSpaceSnapshot: portico443_SNAPSHOT,
  });
  assert.equal(/Address Space/i.test(snapshotOnly), false);
  assert.equal(/\[object Object\]/.test(snapshotOnly), false);

  const formatterOnly = buildRuntimeDiagnosticsText({
    projectRoot: "/tmp/project",
    formatAddressSpace: formatAddressSpaceReport,
  });
  assert.equal(/Address Space/i.test(formatterOnly), false);
});

test("PORTICO-443: a throwing formatter cannot stop a bundle being collected", () => {
  // The whole point of this ticket is that the one moment a bundle matters most
  // was the moment it could not be made. Telemetry must never reintroduce that.
  const text = buildRuntimeDiagnosticsText({
    projectRoot: "/tmp/project",
    addressSpaceSnapshot: portico443_SNAPSHOT,
    formatAddressSpace: () => {
      throw new Error("telemetry formatting blew up");
    },
  });
  assert.match(text, /Installed Build State/, "the rest of the bundle survives");
  assert.equal(/telemetry formatting blew up/.test(text), false);
});
