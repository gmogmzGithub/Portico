const os = require("os");

const SYSTEM_PATH_DIRS = [
  "/Applications/OrbStack.app/Contents/MacOS/xbin",
  "/Applications/OrbStack.app/Contents/MacOS/bin",
  `${os.homedir()}/Applications/OrbStack.app/Contents/MacOS/xbin`,
  `${os.homedir()}/Applications/OrbStack.app/Contents/MacOS/bin`,
  `${os.homedir()}/.orbstack/bin`,
  `${os.homedir()}/.local/bin`,
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

const SYSTEM_PATH_FALLBACK = SYSTEM_PATH_DIRS.join(":");

function splitPathEntries(pathValue) {
  return String(pathValue || "")
    .split(":")
    .map((e) => e.trim())
    .filter(Boolean);
}

function mergePathEntries(...pathValues) {
  const merged = [];
  const seen = new Set();
  for (const pv of pathValues) {
    for (const entry of splitPathEntries(pv)) {
      if (!seen.has(entry)) {
        seen.add(entry);
        merged.push(entry);
      }
    }
  }
  return merged.join(":");
}

function prependPathEntry(pathEntry, existingPath) {
  if (!pathEntry) return mergePathEntries(existingPath);
  return mergePathEntries(pathEntry, existingPath);
}

function buildEnhancedPath(basePath = process.env.PATH || "") {
  return mergePathEntries(SYSTEM_PATH_FALLBACK, basePath);
}

function createEnhancedEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  env.PATH = buildEnhancedPath(env.PATH || process.env.PATH || "");
  return env;
}

module.exports = {
  SYSTEM_PATH_DIRS,
  SYSTEM_PATH_FALLBACK,
  splitPathEntries,
  mergePathEntries,
  prependPathEntry,
  buildEnhancedPath,
  createEnhancedEnv,
};
