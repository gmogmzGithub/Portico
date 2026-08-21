const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const guard = require("./app-location-guard");

const HOME = "/Users/tester";

// A fake `app` whose bundle resolves to `exePath`. `exitCodes` records every
// app.exit() the guard performs -- PORTICO-399 made the guard terminal, so "did the
// launch get killed" is now the primary observable.
function makeApp(exePath, overrides = {}) {
  const exitCodes = [];
  return {
    isPackaged: true,
    getPath: (key) => (key === "exe" ? exePath : null),
    getAppPath: () => exePath,
    quit: () => {},
    exit: (code) => exitCodes.push(code),
    exitCodes,
    ...overrides,
  };
}

// Dialog recorder: captures the blocking prompt's options and any terminal
// error box, so tests assert on what the user was actually offered.
function makeDialog({ choice = 0 } = {}) {
  const prompts = [];
  const errorBoxes = [];
  return {
    prompts,
    errorBoxes,
    showMessageBoxSync: (options) => {
      prompts.push(options);
      return choice;
    },
    showErrorBox: (title, message) => errorBoxes.push({ title, message }),
  };
}

// fs stub: existsSync(false) forces resolveCurrentAppBundlePath to use
// path.resolve(candidate) verbatim (no realpath), which is what we want for
// deterministic location classification. `files` maps absolute paths -> string.
function makeFs(files = {}, overrides = {}) {
  return {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    realpathSync: (p) => p,
    readFileSync: (p) => {
      if (Object.prototype.hasOwnProperty.call(files, p)) return files[p];
      const err = new Error(`ENOENT: ${p}`);
      err.code = "ENOENT";
      throw err;
    },
    mkdirSync: () => {},
    writeFileSync: () => {},
    rmSync: () => {},
    renameSync: () => {},
    ...overrides,
  };
}

function exeIn(bundlePath) {
  return path.join(bundlePath, "Contents", "MacOS", "Portico");
}

// ---------------------------------------------------------------------------
// classifyAppLocation / blessed predicate
// ---------------------------------------------------------------------------

test("classify: /Applications is blessed", () => {
  const bundle = "/Applications/Portico.app";
  const loc = guard.classifyAppLocation({
    app: makeApp(exeIn(bundle)),
    fsRef: makeFs(),
    pathRef: path,
    homedir: HOME,
  });
  assert.equal(loc.inSystemApplications, true);
  assert.equal(loc.blessed, true);
});

test("classify: ~/Applications is blessed", () => {
  const bundle = `${HOME}/Applications/Portico.app`;
  const loc = guard.classifyAppLocation({
    app: makeApp(exeIn(bundle)),
    fsRef: makeFs(),
    pathRef: path,
    homedir: HOME,
  });
  assert.equal(loc.inUserApplications, true);
  assert.equal(loc.blessed, true);
});

test("classify: ~/Downloads is NOT blessed", () => {
  const bundle = `${HOME}/Downloads/Portico.app`;
  const loc = guard.classifyAppLocation({
    app: makeApp(exeIn(bundle)),
    fsRef: makeFs(),
    pathRef: path,
    homedir: HOME,
  });
  assert.equal(loc.blessed, false);
  assert.equal(loc.inSystemApplications, false);
  assert.equal(loc.inUserApplications, false);
});

test("classify: mounted DMG is NOT blessed", () => {
  const bundle = "/Volumes/Portico/Portico.app";
  const loc = guard.classifyAppLocation({
    app: makeApp(exeIn(bundle)),
    fsRef: makeFs(),
    pathRef: path,
    homedir: HOME,
  });
  assert.equal(loc.blessed, false);
});

test("classify: translocated /Applications-looking path is NOT blessed", () => {
  const bundle =
    "/private/var/folders/ab/xyz/T/AppTranslocation/UUID/d/Portico.app";
  const loc = guard.classifyAppLocation({
    app: makeApp(exeIn(bundle)),
    fsRef: makeFs(),
    pathRef: path,
    homedir: HOME,
  });
  assert.equal(loc.translocated, true);
  assert.equal(loc.blessed, false);
});

test("isTranslocatedPath detects AppTranslocation segment", () => {
  assert.equal(
    guard.isTranslocatedPath("/x/AppTranslocation/uuid/d/Portico.app"),
    true,
  );
  assert.equal(
    guard.isTranslocatedPath("/Applications/Portico.app"),
    false,
  );
  assert.equal(guard.isTranslocatedPath(null), false);
});

// ---------------------------------------------------------------------------
// compareBuilds (version-aware, via build-info.json timestamp)
// ---------------------------------------------------------------------------

function buildInfo(bundle, timestamp) {
  return {
    [path.join(bundle, "Contents", "Resources", "build-info.json")]:
      JSON.stringify({ timestamp }),
  };
}

test("compareBuilds: current newer than existing", () => {
  const cur = "/Users/tester/Downloads/Portico.app";
  const exi = "/Applications/Portico.app";
  const fsRef = makeFs({
    ...buildInfo(cur, "2026-06-03T00:00:00.000Z"),
    ...buildInfo(exi, "2026-04-01T00:00:00.000Z"),
  });
  assert.equal(guard.compareBuilds(cur, exi, { fsRef, pathRef: path }), "current");
});

test("compareBuilds: existing newer than current", () => {
  const cur = "/Users/tester/Downloads/Portico.app";
  const exi = "/Applications/Portico.app";
  const fsRef = makeFs({
    ...buildInfo(cur, "2026-04-01T00:00:00.000Z"),
    ...buildInfo(exi, "2026-06-03T00:00:00.000Z"),
  });
  assert.equal(guard.compareBuilds(cur, exi, { fsRef, pathRef: path }), "existing");
});

test("compareBuilds: missing build-info -> unknown", () => {
  const fsRef = makeFs();
  assert.equal(
    guard.compareBuilds("/a/Portico.app", "/b/Portico.app", {
      fsRef,
      pathRef: path,
    }),
    "unknown",
  );
});

// ---------------------------------------------------------------------------
// loop-breaker marker
// ---------------------------------------------------------------------------

test("hasRecentRelocateAttempt: within window true, outside false", () => {
  const markerPath = guard.relocateAttemptMarkerPath(HOME);
  const fsRecent = makeFs({ [markerPath]: JSON.stringify({ at: 1000 }) });
  assert.equal(
    guard.hasRecentRelocateAttempt({ fsRef: fsRecent, homedir: HOME, now: 1000 + 10_000 }),
    true,
  );
  assert.equal(
    guard.hasRecentRelocateAttempt({ fsRef: fsRecent, homedir: HOME, now: 1000 + 200_000 }),
    false,
  );
});

test("hasRecentRelocateAttempt: no marker -> false", () => {
  assert.equal(
    guard.hasRecentRelocateAttempt({ fsRef: makeFs(), homedir: HOME, now: 5 }),
    false,
  );
});

// ---------------------------------------------------------------------------
// tryMoveToSystemApplications conflict policy
// ---------------------------------------------------------------------------

function systemConflictHarness({ conflictType, curTs, exiTs }) {
  const cur = "/Users/tester/Downloads/Portico.app";
  const exi = "/Applications/Portico.app";
  const fsRef = makeFs({
    ...buildInfo(cur, curTs),
    ...buildInfo(exi, exiTs),
  });
  let handlerReturn = null;
  const app = makeApp(exeIn(cur), {
    moveToApplicationsFolder: ({ conflictHandler }) => {
      handlerReturn = conflictHandler(conflictType);
      // Emulate Electron: false from handler aborts the move.
      return handlerReturn === true;
    },
  });
  const location = guard.classifyAppLocation({ app, fsRef, pathRef: path, homedir: HOME });
  const result = guard.tryMoveToSystemApplications({
    app,
    fsRef,
    pathRef: path,
    location,
  });
  return { result, handlerReturn };
}

test("system conflict: existing newer -> defer to existing (no downgrade)", () => {
  const { result, handlerReturn } = systemConflictHarness({
    conflictType: "exists",
    curTs: "2026-04-01T00:00:00.000Z",
    exiTs: "2026-06-03T00:00:00.000Z",
  });
  assert.equal(handlerReturn, false);
  assert.equal(result, "deferred-to-existing");
});

test("system conflict: current newer -> replace existing", () => {
  const { result, handlerReturn } = systemConflictHarness({
    conflictType: "exists",
    curTs: "2026-06-03T00:00:00.000Z",
    exiTs: "2026-04-01T00:00:00.000Z",
  });
  assert.equal(handlerReturn, true);
  assert.equal(result, true);
});

test("system conflict: existsAndRunning -> defer to running instance", () => {
  const { result, handlerReturn } = systemConflictHarness({
    conflictType: "existsAndRunning",
    curTs: "2026-06-03T00:00:00.000Z",
    exiTs: "2026-04-01T00:00:00.000Z",
  });
  assert.equal(handlerReturn, false);
  assert.equal(result, "deferred-to-existing");
});

// ---------------------------------------------------------------------------
// runAppLocationGuard orchestration
// ---------------------------------------------------------------------------

function neverDialog() {
  return {
    showMessageBoxSync: () => {
      throw new Error("dialog should not show");
    },
    showErrorBox: () => {
      throw new Error("error box should not show");
    },
  };
}

test("guard: skips on non-darwin", async () => {
  const app = makeApp(exeIn(`${HOME}/Downloads/Portico.app`));
  const res = await guard.runAppLocationGuard({
    app,
    dialog: neverDialog(),
    platform: "win32",
  });
  assert.equal(res.skipped, "non-darwin");
  assert.deepEqual(app.exitCodes, [], "non-darwin launches must never be killed");
});

test("guard: skips when not packaged (dev)", async () => {
  const app = makeApp(exeIn(`${HOME}/Downloads/Portico.app`), { isPackaged: false });
  const res = await guard.runAppLocationGuard({
    app,
    dialog: neverDialog(),
    platform: "darwin",
  });
  assert.equal(res.skipped, "not-packaged");
  // Dev runs from the repo, never a blessed .app -- the enforcing guard must not
  // make `npm start` unlaunchable.
  assert.deepEqual(app.exitCodes, [], "dev launches must never be killed");
});

test("guard: blessed location returns early, no dialog, no marker I/O", async () => {
  let touchedFs = false;
  const bundle = "/Applications/Portico.app";
  // Blessed path must not write/delete the relocate marker (steady-state = zero marker I/O).
  const fsRef = makeFs(
    {},
    {
      rmSync: () => { touchedFs = true; },
      writeFileSync: () => { touchedFs = true; },
    },
  );
  const app = makeApp(exeIn(bundle));
  const res = await guard.runAppLocationGuard({
    app,
    dialog: neverDialog(),
    fsRef,
    pathRef: path,
    homedir: HOME,
    platform: "darwin",
  });
  assert.equal(res.blessed, true);
  assert.equal(res.moved, false);
  assert.equal(touchedFs, false);
  assert.deepEqual(app.exitCodes, []);
});

// ---------------------------------------------------------------------------
// PORTICO-399: a non-blessed launch is terminal -- move or quit, never "run anyway"
// ---------------------------------------------------------------------------

test("guard: prompt offers only Move and Quit, and cancels to Quit", async () => {
  const bundle = `${HOME}/Downloads/Portico.app`;
  const dialog = makeDialog({ choice: 1 });
  await guard.runAppLocationGuard({
    app: makeApp(exeIn(bundle)),
    dialog,
    fsRef: makeFs(),
    pathRef: path,
    homedir: HOME,
    platform: "darwin",
    now: 1000,
    logger: { warn() {}, error() {} },
  });

  assert.equal(dialog.prompts.length, 1);
  const [prompt] = dialog.prompts;
  assert.deepEqual(prompt.buttons, ["Move to Applications", "Quit"]);
  // Esc / close must resolve to Quit, never to a run-anyway escape hatch.
  assert.equal(prompt.cancelId, 1);
  assert.equal(prompt.defaultId, 0);
});

test("guard: declining the prompt kills the launch without moving", async () => {
  const bundle = `${HOME}/Downloads/Portico.app`;
  const app = makeApp(exeIn(bundle), {
    moveToApplicationsFolder: () => {
      throw new Error("must not attempt a move after Quit");
    },
  });
  const dialog = makeDialog({ choice: 1 });
  const res = await guard.runAppLocationGuard({
    app,
    dialog,
    fsRef: makeFs(),
    pathRef: path,
    homedir: HOME,
    platform: "darwin",
    now: 1000,
    logger: { warn() {}, error() {} },
  });

  assert.equal(res.declined, true);
  assert.equal(res.blocked, true);
  assert.equal(res.moved, false);
  assert.deepEqual(app.exitCodes, [1], "declining must exit, not fall through");
  // The user chose Quit -- don't scold them with an extra error box.
  assert.deepEqual(dialog.errorBoxes, []);
});

test("guard: both move targets failing kills the launch with manual instructions", async () => {
  const bundle = `${HOME}/Downloads/Portico.app`;
  const app = makeApp(exeIn(bundle), {
    moveToApplicationsFolder: () => {
      throw new Error("EACCES: /Applications not writable");
    },
  });
  const dialog = makeDialog({ choice: 0 });
  const res = await guard.runAppLocationGuard({
    app,
    dialog,
    fsRef: makeFs(),
    pathRef: path,
    homedir: HOME,
    platform: "darwin",
    now: 1000,
    spawnRef: () => ({ unref() {} }),
    execFileSyncRef: (cmd) => {
      if (cmd === "ditto") throw new Error("ditto failed");
    },
    logger: { warn() {}, error() {} },
  });

  assert.equal(res.blocked, true);
  assert.equal(res.reason, "move-failed");
  assert.equal(res.moved, false);
  assert.deepEqual(app.exitCodes, [1]);
  assert.equal(dialog.errorBoxes.length, 1);
  assert.match(dialog.errorBoxes[0].message, /drag Portico into your Applications folder/);
});

test("guard: loop-breaker dead-ends instead of re-prompting", async () => {
  const bundle = `${HOME}/Downloads/Portico.app`;
  const markerPath = guard.relocateAttemptMarkerPath(HOME);
  const fsRef = makeFs({ [markerPath]: JSON.stringify({ at: 1000 }) });
  const app = makeApp(exeIn(bundle));
  const dialog = makeDialog({ choice: 0 });
  const res = await guard.runAppLocationGuard({
    app,
    dialog,
    fsRef,
    pathRef: path,
    homedir: HOME,
    platform: "darwin",
    now: 1000 + 5_000,
    logger: { warn() {}, error() {} },
  });

  assert.equal(res.blocked, true);
  assert.equal(res.reason, "recent-attempt");
  assert.deepEqual(dialog.prompts, [], "must not re-offer the move (relaunch loop)");
  assert.equal(dialog.errorBoxes.length, 1);
  assert.match(dialog.errorBoxes[0].message, /still not in your Applications folder/);
  assert.deepEqual(app.exitCodes, [1]);
});

test("guard: a missing dialog implementation still kills a non-blessed launch", async () => {
  // Fail closed: if the error box can't be shown we must still refuse to run.
  const bundle = `${HOME}/Downloads/Portico.app`;
  const markerPath = guard.relocateAttemptMarkerPath(HOME);
  const fsRef = makeFs({ [markerPath]: JSON.stringify({ at: 1000 }) });
  const app = makeApp(exeIn(bundle));
  const res = await guard.runAppLocationGuard({
    app,
    dialog: {},
    fsRef,
    pathRef: path,
    homedir: HOME,
    platform: "darwin",
    now: 1000 + 5_000,
    logger: { warn() {}, error() {} },
  });

  assert.equal(res.blocked, true);
  assert.deepEqual(app.exitCodes, [1]);
});

test("guard: consent -> system move success -> relaunching", async () => {
  const bundle = `${HOME}/Downloads/Portico.app`;
  const app = makeApp(exeIn(bundle), {
    moveToApplicationsFolder: () => true,
  });
  const res = await guard.runAppLocationGuard({
    app,
    dialog: { showMessageBoxSync: () => 0 },
    fsRef: makeFs(),
    pathRef: path,
    homedir: HOME,
    platform: "darwin",
    now: 1000,
  });
  assert.equal(res.moved, true);
  assert.equal(res.target, "system");
  assert.equal(res.relaunching, true);
});

test("guard: system unwritable -> falls back to ~/Applications", async () => {
  const bundle = `${HOME}/Downloads/Portico.app`;
  const dittoCalls = [];
  const app = makeApp(exeIn(bundle), {
    moveToApplicationsFolder: () => {
      throw new Error("EACCES: /Applications not writable");
    },
  });
  const res = await guard.runAppLocationGuard({
    app,
    dialog: { showMessageBoxSync: () => 0 },
    fsRef: makeFs(), // target ~/Applications does not exist -> simple rename path
    pathRef: path,
    spawnRef: () => ({ unref() {} }),
    execFileSyncRef: (cmd, args) => dittoCalls.push([cmd, args[0]]),
    homedir: HOME,
    platform: "darwin",
    now: 1000,
    logger: { warn() {}, error() {} },
  });
  assert.equal(res.moved, true);
  assert.equal(res.target, "user");
  assert.equal(res.relaunching, true);
  assert.equal(dittoCalls[0][0], "ditto");
});

// ---------------------------------------------------------------------------
// QA override (PORTICO_LOCATION_GUARD_FORCE)
// ---------------------------------------------------------------------------

test("normalizeForceMode: accepts user/system, rejects others", () => {
  assert.equal(guard.normalizeForceMode("user"), "user");
  assert.equal(guard.normalizeForceMode(" SYSTEM "), "system");
  assert.equal(guard.normalizeForceMode("nope"), null);
  assert.equal(guard.normalizeForceMode(undefined), null);
});

test("guard: FORCE=user prompts even when blessed and uses ~/Applications", async () => {
  // App is in /Applications (blessed) but QA forces the user fallback.
  const bundle = "/Applications/Portico.app";
  const dittoCalls = [];
  let systemMoveCalled = false;
  const app = makeApp(exeIn(bundle), {
    moveToApplicationsFolder: () => {
      systemMoveCalled = true;
      return true;
    },
  });
  const res = await guard.runAppLocationGuard({
    app,
    dialog: { showMessageBoxSync: () => 0 },
    fsRef: makeFs(),
    pathRef: path,
    spawnRef: () => ({ unref() {} }),
    execFileSyncRef: (cmd) => dittoCalls.push(cmd),
    homedir: HOME,
    platform: "darwin",
    now: 1000,
    env: { PORTICO_LOCATION_GUARD_FORCE: "user" },
    logger: { warn() {}, error() {} },
  });
  assert.equal(systemMoveCalled, false, "FORCE=user must skip the system move");
  assert.equal(res.target, "user");
  assert.equal(res.relaunching, true);
  assert.equal(dittoCalls[0], "ditto");
});

test("guard: FORCE=system prompts even when blessed, keeps system ladder", async () => {
  const bundle = "/Applications/Portico.app";
  let systemMoveCalled = false;
  const app = makeApp(exeIn(bundle), {
    moveToApplicationsFolder: () => {
      systemMoveCalled = true;
      return true;
    },
  });
  const res = await guard.runAppLocationGuard({
    app,
    dialog: { showMessageBoxSync: () => 0 },
    fsRef: makeFs(),
    pathRef: path,
    homedir: HOME,
    platform: "darwin",
    now: 1000,
    env: { PORTICO_LOCATION_GUARD_FORCE: "system" },
    logger: { warn() {} },
  });
  assert.equal(systemMoveCalled, true);
  assert.equal(res.target, "system");
});

test("guard: failed ~/Applications move cleans up the incoming copy", async () => {
  const bundle = `${HOME}/Downloads/Portico.app`;
  const rmPaths = [];
  const fsRef = makeFs({}, { rmSync: (p) => rmPaths.push(p) });
  const app = makeApp(exeIn(bundle)); // no system mover -> falls to ~/Applications
  const res = await guard.runAppLocationGuard({
    app,
    dialog: makeDialog({ choice: 0 }),
    fsRef,
    pathRef: path,
    homedir: HOME,
    platform: "darwin",
    now: 1000,
    env: { PORTICO_LOCATION_GUARD_FORCE: "user" },
    spawnRef: () => ({ unref() {} }),
    execFileSyncRef: (cmd) => {
      if (cmd === "ditto") throw new Error("ditto failed");
    },
    logger: { warn() {}, error() {} },
  });
  assert.equal(res.blocked, true);
  assert.ok(
    rmPaths.some((p) => p.includes(".incoming-")),
    "incoming copy must be cleaned up on failure",
  );
});

// ---------------------------------------------------------------------------
// Prompt copy: the user has to be told WHERE the misplaced copy is
// ---------------------------------------------------------------------------

function promptFor(bundlePath, extra = {}) {
  return guard.buildRelocationPromptContent({
    location: { bundlePath, ...extra },
    homedir: HOME,
  });
}

test("prompt copy: names a home-relative folder with ~", () => {
  assert.match(
    promptFor(`${HOME}/Downloads/Portico.app`).detail,
    /from ~\/Downloads/,
  );
});

test("prompt copy: names a mounted disk image generically", () => {
  assert.match(
    promptFor("/Volumes/Portico/Portico.app").detail,
    /from a mounted disk image/,
  );
});

test("prompt copy: explains translocation instead of printing the random path", () => {
  const detail = promptFor(
    "/private/var/folders/ab/xyz/T/AppTranslocation/UUID/d/Portico.app",
    { translocated: true },
  ).detail;
  assert.match(detail, /quarantined/);
  assert.doesNotMatch(detail, /AppTranslocation/);
});

test("prompt copy: stays readable when the bundle path is unknown", () => {
  const detail = guard.buildRelocationPromptContent({
    location: { bundlePath: null },
    homedir: HOME,
  }).detail;
  assert.doesNotMatch(detail, /undefined|null/);
  assert.match(detail, /from its current location/);
});

test("describeCurrentLocation: keeps a non-home absolute path verbatim", () => {
  assert.equal(
    guard.describeCurrentLocation(
      { bundlePath: "/opt/tools/Portico.app" },
      HOME,
    ),
    "/opt/tools",
  );
});
