const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  removeLegacyGuidedSetupDir,
  removePathRecursivelyNoAsar,
} = require("./legacy-guided-setup-cleanup");

test("legacy guided-setup cleanup removes nested app bundles with app.asar files", () => {
  const managedDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-guided-setup-"));
  const asarPath = path.join(
    managedDir,
    "guided-setup",
    "dist",
    "mac-arm64",
    "Portico.app",
    "Contents",
    "Resources",
    "app.asar",
  );
  fs.mkdirSync(path.dirname(asarPath), { recursive: true });
  fs.writeFileSync(asarPath, "asar bytes");

  const result = removeLegacyGuidedSetupDir(managedDir);

  assert.equal(result.existed, true);
  assert.equal(result.removed, true);
  assert.equal(fs.existsSync(path.join(managedDir, "guided-setup")), false);

  fs.rmSync(managedDir, { recursive: true, force: true });
});

test("recursive cleanup temporarily disables Electron asar path handling", () => {
  const calls = [];
  const processRef = { noAsar: false };

  removePathRecursivelyNoAsar("/tmp/stale-guided-setup", {
    processRef,
    fsRef: {
      rmSync(targetPath, options) {
        calls.push({
          targetPath,
          options,
          noAsarDuringRm: processRef.noAsar,
        });
      },
    },
  });

  assert.deepEqual(calls, [
    {
      targetPath: "/tmp/stale-guided-setup",
      options: {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      },
      noAsarDuringRm: true,
    },
  ]);
  assert.equal(processRef.noAsar, false);
});
