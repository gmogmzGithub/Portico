const fs = require("fs");
const path = require("path");

const KONAMI_FLAG_FILENAME = "KONAMI";
const KONAMI_ENV_FLAG = "PORTICO_KONAMI_UNLOCK_GPT54_PRO";

function getKonamiFlagPath(userDataPath) {
  if (!userDataPath || typeof userDataPath !== "string") {
    throw new Error("Missing userDataPath");
  }
  return path.join(userDataPath, KONAMI_FLAG_FILENAME);
}

function getManagedKonamiMirrorPath(projectRoot) {
  if (!projectRoot || typeof projectRoot !== "string") {
    throw new Error("Missing projectRoot");
  }
  return path.join(projectRoot, "health-status", KONAMI_FLAG_FILENAME);
}

function readKonamiUnlocked({ userDataPath } = {}) {
  try {
    return fs.existsSync(getKonamiFlagPath(userDataPath));
  } catch (_error) {
    return false;
  }
}

function persistKonamiUnlocked({ userDataPath } = {}) {
  const flagPath = getKonamiFlagPath(userDataPath);
  fs.mkdirSync(path.dirname(flagPath), { recursive: true });
  fs.closeSync(fs.openSync(flagPath, "a"));
  return flagPath;
}

function clearKonamiUnlocked({ userDataPath } = {}) {
  const flagPath = getKonamiFlagPath(userDataPath);
  fs.rmSync(flagPath, { force: true });
  return flagPath;
}

function syncKonamiManagedMirror({ userDataPath, projectRoot } = {}) {
  if (!projectRoot || typeof projectRoot !== "string") {
    return null;
  }

  const mirrorPath = getManagedKonamiMirrorPath(projectRoot);
  const unlocked = readKonamiUnlocked({ userDataPath });

  if (unlocked) {
    fs.mkdirSync(path.dirname(mirrorPath), { recursive: true });
    fs.closeSync(fs.openSync(mirrorPath, "a"));
  } else {
    try {
      fs.rmSync(mirrorPath, { force: true });
    } catch (_error) {
      // Ignore stale cleanup failures; the authoritative flag remains userData/KONAMI.
    }
  }

  return mirrorPath;
}

function applyKonamiRuntimeEnv(env = {}, unlocked = false) {
  return {
    ...env,
    [KONAMI_ENV_FLAG]: unlocked ? "1" : "0",
  };
}

module.exports = {
  KONAMI_ENV_FLAG,
  getKonamiFlagPath,
  getManagedKonamiMirrorPath,
  readKonamiUnlocked,
  persistKonamiUnlocked,
  clearKonamiUnlocked,
  syncKonamiManagedMirror,
  applyKonamiRuntimeEnv,
};
