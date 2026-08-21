const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  normalizeHttpExternalUrl,
  normalizeLocalPath,
  openLocalPath,
  validateProbeUrl,
} = require("./shell-open");

test("normalizeHttpExternalUrl only accepts http and https URLs", () => {
  assert.equal(
    normalizeHttpExternalUrl("https://example.test/path?q=1"),
    "https://example.test/path?q=1",
  );
  assert.equal(
    normalizeHttpExternalUrl("http://localhost:8877/"),
    "http://localhost:8877/",
  );
  assert.throws(() => normalizeHttpExternalUrl("file:///tmp/demo"), /Protocol not allowed/);
  assert.throws(() => normalizeHttpExternalUrl("slack://channel"), /Protocol not allowed/);
});

test("validateProbeUrl rejects loopback and private network hosts", () => {
  assert.equal(
    validateProbeUrl("https://login.okta.com/oauth2/v1/authorize").host,
    "login.okta.com",
  );
  assert.throws(() => validateProbeUrl("http://localhost:8000/test"), /Local addresses/);
  assert.throws(() => validateProbeUrl("http://127.0.0.1/test"), /Private IPv4/);
  assert.throws(() => validateProbeUrl("http://192.168.1.10/test"), /Private IPv4/);
});

test("normalizeLocalPath requires an existing local path", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shell-open-"));
  const targetFile = path.join(tempDir, "demo.txt");
  fs.writeFileSync(targetFile, "demo", "utf8");

  try {
    assert.equal(normalizeLocalPath(targetFile), targetFile);
    assert.throws(() => normalizeLocalPath(path.join(tempDir, "missing.txt")), /does not exist/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("openLocalPath surfaces shell.openPath errors", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shell-open-"));

  try {
    await assert.rejects(
      () =>
        openLocalPath(
          {
            openPath: async () => "failed to open",
          },
          tempDir,
        ),
      /failed to open/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
