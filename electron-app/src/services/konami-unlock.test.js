const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  KONAMI_ENV_FLAG,
  getKonamiFlagPath,
  getManagedKonamiMirrorPath,
  readKonamiUnlocked,
  persistKonamiUnlocked,
  clearKonamiUnlocked,
  syncKonamiManagedMirror,
  applyKonamiRuntimeEnv,
} = require("./konami-unlock");

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("konami unlock persists in userData and mirrors into health-status", () => {
  const root = createTempDir("konami-unlock-");
  const userDataPath = path.join(root, "userData");
  const projectRoot = path.join(root, "project");

  const authoritativePath = getKonamiFlagPath(userDataPath);
  const mirrorPath = getManagedKonamiMirrorPath(projectRoot);

  assert.equal(readKonamiUnlocked({ userDataPath }), false);
  assert.equal(fs.existsSync(authoritativePath), false);
  assert.equal(fs.existsSync(mirrorPath), false);

  persistKonamiUnlocked({ userDataPath });
  syncKonamiManagedMirror({ userDataPath, projectRoot });

  assert.equal(readKonamiUnlocked({ userDataPath }), true);
  assert.equal(fs.existsSync(authoritativePath), true);
  assert.equal(fs.existsSync(mirrorPath), true);
  assert.equal(fs.readFileSync(authoritativePath, "utf8"), "");
  assert.equal(fs.readFileSync(mirrorPath, "utf8"), "");
});

test("konami mirror is removed when the authoritative userData flag is absent", () => {
  const root = createTempDir("konami-mirror-");
  const userDataPath = path.join(root, "userData");
  const projectRoot = path.join(root, "project");

  persistKonamiUnlocked({ userDataPath });
  syncKonamiManagedMirror({ userDataPath, projectRoot });

  assert.equal(clearKonamiUnlocked({ userDataPath }), getKonamiFlagPath(userDataPath));
  assert.equal(readKonamiUnlocked({ userDataPath }), false);
  syncKonamiManagedMirror({ userDataPath, projectRoot });

  assert.equal(fs.existsSync(getManagedKonamiMirrorPath(projectRoot)), false);
});

test("konami runtime env exposes a stable boolean override", () => {
  assert.equal(
    applyKonamiRuntimeEnv({ EXISTING: "1" }, true)[KONAMI_ENV_FLAG],
    "1",
  );
  assert.equal(
    applyKonamiRuntimeEnv({ EXISTING: "1" }, false)[KONAMI_ENV_FLAG],
    "0",
  );
});
