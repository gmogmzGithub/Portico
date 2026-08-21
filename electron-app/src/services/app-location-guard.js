// App Location Guard (PORTICO-105, hardened in PORTICO-399)
//
// Architecture layer: Electron Shell (launch-time guard) + Update & Distribution.
//
// Why this exists: Portico can only self-update when it runs from a
// writable, non-translocated location. The two dominant real-world failure
// causes -- running from the mounted DMG, and Gatekeeper App Translocation --
// are READ-ONLY by macOS design, so "update in place" is physically impossible
// there. The Apple/Electron-sanctioned cure is to MOVE the app into an
// Applications folder at launch (LetsMove pattern).
//
// PORTICO-399: this guard is now ENFORCING. The original never-block design (warn,
// then run anyway behind a dismissable banner) shipped a population of installs
// that were permanently stranded on an old build: users dismissed the warning,
// ignored the banner, and silently stopped receiving updates. So a non-blessed
// launch is now terminal -- the app offers to move itself and relaunch, and
// exits if it can't. It never runs from a location it cannot update from.
//
// The guard runs before any heavy startup (Docker/prerequisites). Outcomes:
//   blessed        -> proceed
//   moved          -> `relaunching: true`; caller halts, the relocated copy takes over
//   anything else  -> `blocked: true`; the process has already been told to exit
//
// Everything is dependency-injected so the decision logic is unit-testable
// without a real Electron runtime.

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const childProcess = require("node:child_process");

const APP_BUNDLE_NAME = "Portico.app";

// Loop-breaker: if we very recently attempted a relocation and are STILL not
// blessed on the next launch, we must NOT prompt+move again (that would loop).
const RELOCATE_ATTEMPT_WINDOW_MS = 90_000;

function safeCall(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

// QA/test override (PORTICO_LOCATION_GUARD_FORCE): 'user' forces the prompt + the
// ~/Applications fallback (so the no-admin path is testable on an admin Mac);
// 'system' forces the prompt while keeping the normal /Applications-first ladder.
function normalizeForceMode(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized === "user" || normalized === "system" ? normalized : null;
}

// Resolve a path to its canonical (symlink-resolved) real form, falling back to a
// lexical resolve when it doesn't exist. Used for BOTH the running bundle and the
// comparison targets so a symlinked / network home dir (or symlinked Applications)
// doesn't make a genuinely-installed app classify as mis-located.
function canonicalizePath(p, fsRef = fs, pathRef = path) {
  if (!p) return null;
  try {
    return fsRef.realpathSync(p);
  } catch {
    return pathRef.resolve(p);
  }
}

function systemApplicationsBundlePath() {
  return path.join("/Applications", APP_BUNDLE_NAME);
}

function userApplicationsBundlePath(homedir = os.homedir()) {
  return path.join(homedir, "Applications", APP_BUNDLE_NAME);
}

// Resolve the .app bundle the running process lives in (or null in dev).
function resolveCurrentAppBundlePath({ app, fsRef = fs, pathRef = path } = {}) {
  // safeCall swallows a missing app / non-function getter, so no extra guards.
  const candidates = [
    safeCall(() => app.getPath("exe")),
    safeCall(() => app.getAppPath()),
    typeof process !== "undefined" ? process.execPath : null,
  ].filter(Boolean);

  const marker = `${pathRef.sep}${APP_BUNDLE_NAME}${pathRef.sep}`;
  for (const candidate of candidates) {
    const resolved = canonicalizePath(candidate, fsRef, pathRef);
    if (!resolved) continue;
    const markerIndex = resolved.indexOf(marker);
    if (markerIndex >= 0) {
      return resolved.slice(0, markerIndex + marker.length - 1);
    }
    if (resolved.endsWith(".app")) {
      return resolved;
    }
  }
  return null;
}

// Gatekeeper App Translocation mounts the app under a randomized read-only path
// like /private/var/folders/<...>/AppTranslocation/<uuid>/d/Portico.app.
function isTranslocatedPath(bundlePath) {
  if (!bundlePath) return false;
  return bundlePath.includes("/AppTranslocation/");
}

// Classify where the app is running from.
function classifyAppLocation({
  app,
  fsRef = fs,
  pathRef = path,
  homedir = os.homedir(),
} = {}) {
  const bundlePath = resolveCurrentAppBundlePath({ app, fsRef, pathRef });
  const systemTarget = systemApplicationsBundlePath();
  const userTarget = userApplicationsBundlePath(homedir);

  // Compare canonical (symlink-resolved) forms on both sides so a symlinked home
  // / Applications path can't make an installed app look mis-located.
  const resolvedBundle = canonicalizePath(bundlePath, fsRef, pathRef);
  const matchesTarget = (target) =>
    resolvedBundle != null &&
    resolvedBundle === canonicalizePath(target, fsRef, pathRef);

  const inSystemApplications = matchesTarget(systemTarget);
  const inUserApplications = matchesTarget(userTarget);
  const translocated = isTranslocatedPath(bundlePath);
  const blessed = (inSystemApplications || inUserApplications) && !translocated;

  return {
    bundlePath,
    inSystemApplications,
    inUserApplications,
    translocated,
    blessed,
    systemTarget,
    userTarget,
  };
}

function isInBlessedLocation(deps = {}) {
  return classifyAppLocation(deps).blessed;
}

// ---------------------------------------------------------------------------
// Dialog copy (pure -- unit-tested without a dialog implementation)
// ---------------------------------------------------------------------------

// Human-readable "where the app is running from" for the prompt. Returns null
// when the location can't be named, so callers substitute a generic phrase
// instead of printing an empty path.
function describeCurrentLocation(location, homedir = os.homedir()) {
  if (!location) return null;
  if (location.translocated) {
    // The real path is a randomized /private/var/folders/... AppTranslocation
    // dir; naming it would only confuse. Explain the mechanism instead.
    return "a temporary read-only copy macOS made because the app is still quarantined";
  }
  if (!location.bundlePath) return null;
  const parent = path.dirname(location.bundlePath);
  if (parent.startsWith("/Volumes/")) {
    return "a mounted disk image";
  }
  if (homedir && (parent === homedir || parent.startsWith(`${homedir}/`))) {
    return `~${parent.slice(homedir.length)}`;
  }
  return parent;
}

const MOVE_BUTTON_LABEL = "Move to Applications";
const QUIT_BUTTON_LABEL = "Quit";

// The blocking prompt. Only two ways out: relocate, or quit.
function buildRelocationPromptContent({ location, homedir = os.homedir() } = {}) {
  // Falls back to a generic phrase so the sentence still reads correctly when we
  // couldn't resolve the bundle path.
  const where =
    describeCurrentLocation(location, homedir) || "its current location";

  return {
    type: "warning",
    buttons: [MOVE_BUTTON_LABEL, QUIT_BUTTON_LABEL],
    defaultId: 0,
    // Esc / window close resolves to Quit -- fail closed, never "run anyway".
    cancelId: 1,
    title: "Move Portico to Applications",
    message: "Portico must be in your Applications folder to run.",
    detail:
      `Portico can't keep itself up to date from ${where}, so it won't ` +
      `start there.\n\nChoose ${MOVE_BUTTON_LABEL} and it will move itself and ` +
      "reopen automatically.",
  };
}

// Terminal dead-end copy: the move was attempted and the app is still not in a
// location it can update from, so it is about to exit. Tell the user the one
// thing that always works -- drag it in by hand.
function buildRelocationBlockedContent({ reason } = {}) {
  const lead =
    reason === "recent-attempt"
      ? "Portico is still not in your Applications folder after the last move attempt, so it can't start."
      : "Portico couldn't move itself into your Applications folder, so it can't start.";

  return {
    title: "Move Portico to Applications",
    message:
      `${lead}\n\n` +
      "Open Finder, drag Portico into your Applications folder, then " +
      "open it from there.",
  };
}

// Read a bundle's build timestamp (ISO 8601) from Contents/Resources/build-info.json.
// Build NUMBERS (e.g. "05282026-c2bf1c8a") are MMDDYYYY and are NOT chronologically
// sortable, so we compare the ISO `timestamp` field instead.
function readBuildTimestamp(bundlePath, { fsRef = fs, pathRef = path } = {}) {
  if (!bundlePath) return null;
  const infoPath = pathRef.join(
    bundlePath,
    "Contents",
    "Resources",
    "build-info.json",
  );
  try {
    const parsed = JSON.parse(fsRef.readFileSync(infoPath, "utf8"));
    const ts =
      parsed && parsed.timestamp ? Date.parse(parsed.timestamp) : Number.NaN;
    return Number.isFinite(ts) ? ts : null;
  } catch {
    return null;
  }
}

// Version-aware comparison: which bundle is newer?
// Returns 'current' | 'existing' | 'equal' | 'unknown'.
function compareBuilds(currentBundle, existingBundle, deps = {}) {
  const current = readBuildTimestamp(currentBundle, deps);
  const existing = readBuildTimestamp(existingBundle, deps);
  if (current == null || existing == null) return "unknown";
  if (current > existing) return "current";
  if (existing > current) return "existing";
  return "equal";
}

function relocateAttemptMarkerPath(homedir = os.homedir()) {
  return path.join(
    homedir,
    "Library",
    "Application Support",
    "portico",
    "relocate-attempt.json",
  );
}

function hasRecentRelocateAttempt({
  fsRef = fs,
  homedir = os.homedir(),
  now = Date.now(),
  windowMs = RELOCATE_ATTEMPT_WINDOW_MS,
} = {}) {
  try {
    const parsed = JSON.parse(
      fsRef.readFileSync(relocateAttemptMarkerPath(homedir), "utf8"),
    );
    return (
      parsed &&
      typeof parsed.at === "number" &&
      now - parsed.at >= 0 &&
      now - parsed.at < windowMs
    );
  } catch {
    return false;
  }
}

function writeRelocateAttempt({
  fsRef = fs,
  homedir = os.homedir(),
  now = Date.now(),
} = {}) {
  try {
    const markerPath = relocateAttemptMarkerPath(homedir);
    fsRef.mkdirSync(path.dirname(markerPath), { recursive: true });
    fsRef.writeFileSync(markerPath, JSON.stringify({ at: now }));
  } catch {
    // Best effort -- a missing marker only weakens loop protection, never blocks.
  }
}

function launchBundleAndQuit({ app, spawnRef, bundlePath, logger = console }) {
  try {
    const child = spawnRef("open", ["-n", bundlePath], {
      detached: true,
      stdio: "ignore",
    });
    if (child && typeof child.unref === "function") child.unref();
  } catch (error) {
    logger.warn?.(
      `[LocationGuard] Failed to relaunch ${bundlePath}: ${error.message}`,
    );
  }
  setTimeout(() => {
    try {
      app.quit?.();
    } catch {
      // ignore
    }
  }, 250);
}

// PORTICO-399: terminal exit path. `reason: 'declined'` shows nothing extra -- the
// user just chose Quit -- every other reason explains the dead end first.
// Mirrors the sibling launch guards (mac-arch, stale-guided-setup): non-zero
// exit so "refused to start" is distinguishable from a normal quit.
function blockLaunch({ app, dialog, reason, logger = console }) {
  if (reason !== "declined") {
    const content = buildRelocationBlockedContent({ reason });
    try {
      dialog?.showErrorBox?.(content.title, content.message);
    } catch (error) {
      logger.error?.(
        `[LocationGuard] Failed to show blocked-launch dialog: ${error.message}`,
      );
    }
  }

  logger.error?.(
    `[LocationGuard] Blocking launch from non-blessed location (${reason})`,
  );

  try {
    app?.exit?.(1);
  } catch (error) {
    logger.error?.(`[LocationGuard] app.exit failed: ${error.message}`);
  }

  return { blessed: false, moved: false, blocked: true, reason };
}

// Try the Electron built-in mover (system /Applications only). It auto-relaunches
// on success. Returns:
//   true                  -> moved + Electron is relaunching
//   'deferred-to-existing'-> a newer/running copy already in /Applications; run that
//   false                 -> did not move (caller falls back to ~/Applications)
function tryMoveToSystemApplications({ app, fsRef, pathRef, location }) {
  if (typeof app.moveToApplicationsFolder !== "function") return false;

  let deferToExisting = false;
  const result = app.moveToApplicationsFolder({
    conflictHandler: (conflictType) => {
      if (conflictType === "existsAndRunning") {
        // Another copy is already running from /Applications -> let it win.
        deferToExisting = true;
        return false;
      }
      // conflictType === 'exists' (present in /Applications, not running).
      const cmp = compareBuilds(location.bundlePath, location.systemTarget, {
        fsRef,
        pathRef,
      });
      if (cmp === "existing") {
        // The /Applications copy is newer -> never silently downgrade it.
        deferToExisting = true;
        return false;
      }
      // Our running copy is newer / equal / unknown -> replace the stale one.
      return true;
    },
  });

  if (result === true) return true;
  if (deferToExisting) return "deferred-to-existing";
  return false;
}

// Custom move into ~/Applications (no admin required). ditto the bundle out,
// strip quarantine so the relocated copy isn't itself translocated next launch,
// then relaunch from the new location. Version-aware: never downgrades.
function moveToUserApplications({
  app,
  fsRef,
  pathRef,
  spawnRef,
  execFileSyncRef,
  location,
  logger,
}) {
  const source = location.bundlePath;
  const target = location.userTarget;
  if (!source) return false;

  const targetDir = pathRef.dirname(target);
  fsRef.mkdirSync(targetDir, { recursive: true });

  if (fsRef.existsSync(target)) {
    const cmp = compareBuilds(source, target, { fsRef, pathRef });
    if (cmp === "existing") {
      // ~/Applications copy is newer -> run it instead of downgrading.
      launchBundleAndQuit({ app, spawnRef, bundlePath: target, logger });
      return true;
    }
  }

  const tempPath = (kind) =>
    pathRef.join(targetDir, `.${APP_BUNDLE_NAME}.${kind}-${process.pid}`);
  const incoming = tempPath("incoming");
  const backup = tempPath("backup");

  fsRef.rmSync(incoming, { recursive: true, force: true });
  try {
    execFileSyncRef("ditto", [source, incoming]);
    // Strip quarantine (best effort) so the copy isn't translocated next launch.
    try {
      execFileSyncRef("xattr", ["-dr", "com.apple.quarantine", incoming]);
    } catch (error) {
      logger.warn?.(
        `[LocationGuard] Failed to strip quarantine on ${incoming}: ${error.message}`,
      );
    }

    if (fsRef.existsSync(target)) {
      fsRef.rmSync(backup, { recursive: true, force: true });
      fsRef.renameSync(target, backup);
      try {
        fsRef.renameSync(incoming, target);
      } catch (error) {
        // Restore the previous copy on failure (leave the backup in place if even
        // the restore fails, so the bundle is still recoverable).
        fsRef.renameSync(backup, target);
        throw error;
      }
      fsRef.rmSync(backup, { recursive: true, force: true });
    } else {
      fsRef.renameSync(incoming, target);
    }
  } finally {
    // Never leave the multi-hundred-MB ditto copy orphaned on a failed move.
    // On success `incoming` was renamed to `target`, so this is a no-op.
    fsRef.rmSync(incoming, { recursive: true, force: true });
  }

  launchBundleAndQuit({ app, spawnRef, bundlePath: target, logger });
  return true;
}

// Orchestrator. Returns a result describing what happened; main.js halts further
// startup when `relaunching` OR `blocked` is true.
async function runAppLocationGuard({
  app,
  dialog,
  fsRef = fs,
  pathRef = path,
  spawnRef = childProcess.spawn,
  execFileSyncRef = childProcess.execFileSync,
  homedir = os.homedir(),
  platform = process.platform,
  now = Date.now(),
  env = process.env,
  logger = console,
} = {}) {
  // macOS, packaged builds only. Dev builds don't run from a .app bundle.
  if (platform !== "darwin") return { skipped: "non-darwin" };
  if (!app || app.isPackaged !== true) return { skipped: "not-packaged" };

  // QA/test override: force the relocation prompt (and, for 'user', the
  // ~/Applications fallback) regardless of the real location.
  const forceMode = normalizeForceMode(env && env.PORTICO_LOCATION_GUARD_FORCE);

  const location = classifyAppLocation({ app, fsRef, pathRef, homedir });
  if (location.blessed && !forceMode) {
    // No marker cleanup here: the relocate-attempt marker self-expires after
    // RELOCATE_ATTEMPT_WINDOW_MS and is irrelevant on the blessed path, so the
    // steady-state (already-installed) launch does zero marker I/O.
    return { blessed: true, moved: false, bundlePath: location.bundlePath };
  }
  if (forceMode) {
    logger.warn?.(
      `[LocationGuard] QA override PORTICO_LOCATION_GUARD_FORCE=${forceMode}; forcing relocation prompt`,
    );
  }

  // Loop-breaker: we just tried to relocate and are still not blessed, so a
  // "move + relaunch" cycle would repeat forever. Dead-end with manual-move
  // instructions instead of re-prompting. Skipped under a QA force override.
  if (!forceMode && hasRecentRelocateAttempt({ fsRef, homedir, now })) {
    logger.warn?.(
      "[LocationGuard] Recent relocate attempt but still not blessed; refusing to re-prompt (loop guard)",
    );
    return blockLaunch({ app, dialog, reason: "recent-attempt", logger });
  }

  const choice = dialog.showMessageBoxSync(
    buildRelocationPromptContent({ location, homedir }),
  );

  if (choice !== 0) {
    return {
      ...blockLaunch({ app, dialog, reason: "declined", logger }),
      declined: true,
    };
  }

  writeRelocateAttempt({ fsRef, homedir, now });

  // 1) Preferred: system /Applications via Electron's tested mover. Skipped when
  //    QA forces the ~/Applications fallback (PORTICO_LOCATION_GUARD_FORCE=user).
  if (forceMode !== "user") {
    try {
      const moved = tryMoveToSystemApplications({
        app,
        fsRef,
        pathRef,
        location,
      });
      if (moved === true) {
        return { moved: true, target: "system", relaunching: true };
      }
      if (moved === "deferred-to-existing") {
        launchBundleAndQuit({
          app,
          spawnRef,
          bundlePath: location.systemTarget,
          logger,
        });
        return { moved: true, target: "system-existing", relaunching: true };
      }
    } catch (error) {
      logger.warn?.(
        `[LocationGuard] moveToApplicationsFolder failed (${error.message}); falling back to ~/Applications`,
      );
    }
  }

  // 2) Fallback: per-user ~/Applications (no admin / MDM Macs).
  try {
    const moved = moveToUserApplications({
      app,
      fsRef,
      pathRef,
      spawnRef,
      execFileSyncRef,
      location,
      logger,
    });
    if (moved) {
      return { moved: true, target: "user", relaunching: true };
    }
  } catch (error) {
    logger.error?.(
      `[LocationGuard] Failed to relocate into ~/Applications: ${error.message}`,
    );
  }

  // 3) Both targets failed. PORTICO-399: do NOT fall back to running from here --
  //    that is exactly the stranded-install state this guard exists to prevent.
  return blockLaunch({ app, dialog, reason: "move-failed", logger });
}

module.exports = {
  // Public surface actually consumed by main.js and the unit test. Other helpers
  // remain module-private.
  normalizeForceMode,
  systemApplicationsBundlePath,
  resolveCurrentAppBundlePath,
  isTranslocatedPath,
  classifyAppLocation,
  isInBlessedLocation,
  describeCurrentLocation,
  buildRelocationPromptContent,
  buildRelocationBlockedContent,
  compareBuilds,
  relocateAttemptMarkerPath,
  hasRecentRelocateAttempt,
  tryMoveToSystemApplications,
  runAppLocationGuard,
};
