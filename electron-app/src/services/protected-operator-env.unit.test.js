const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  findNonEmptyAssignmentLine,
  isProtectedRepositoryRoot,
  preserveCloudsmithApiKey,
  writeProtectedRepositoryEnvAtomic,
  writeProtectedRepositoryEnvAtomicSync,
} = require("./protected-operator-env");

test("protected operator env restores an omitted Cloudsmith API key", () => {
  const existing = [
    "HARBOR_TOKEN=harbor-test-token",
    'export CLOUDSMITH_API_KEY="cloudsmith-test-token"',
    "",
  ].join("\n");
  const proposed = "HARBOR_TOKEN=updated-harbor-token\n";

  const preserved = preserveCloudsmithApiKey(existing, proposed);

  assert.match(preserved, /HARBOR_TOKEN=updated-harbor-token/);
  assert.match(
    preserved,
    /export CLOUDSMITH_API_KEY="cloudsmith-test-token"/,
  );
});

test("application rewrites cannot replace an operator's Cloudsmith rotation", () => {
  const existing = "CLOUDSMITH_API_KEY=old-test-token\n";
  const proposed = "CLOUDSMITH_API_KEY=new-test-token\n";

  assert.equal(preserveCloudsmithApiKey(existing, proposed), existing);
});

test("protected operator env replaces a blank assignment with the existing key", () => {
  const preserved = preserveCloudsmithApiKey(
    "CLOUDSMITH_API_KEY=existing-test-token\n",
    'CLOUDSMITH_API_KEY=""\nPORTICO_USER_ID=test-user\n',
  );

  assert.doesNotMatch(preserved, /CLOUDSMITH_API_KEY=""/);
  assert.match(preserved, /CLOUDSMITH_API_KEY=existing-test-token/);
  assert.match(preserved, /PORTICO_USER_ID=test-user/);
});

test("protected operator env leaves content unchanged when no key exists", () => {
  const proposed = "PORTICO_USER_ID=test-user\n";
  assert.equal(preserveCloudsmithApiKey("", proposed), proposed);
  assert.equal(findNonEmptyAssignmentLine(proposed, "CLOUDSMITH_API_KEY"), null);
});

test("blank quoted assignments with comments do not count as a key", () => {
  assert.equal(
    findNonEmptyAssignmentLine(
      'CLOUDSMITH_API_KEY="" # intentionally blank\n',
      "CLOUDSMITH_API_KEY",
    ),
    null,
  );
});

test("atomic env writes re-read and retain the current operator key", async (t) => {
  const fixture = fs.mkdtempSync("/tmp/portico-protected-env-async-");
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const envPath = path.join(fixture, ".env");
  fs.writeFileSync(
    envPath,
    "FOO=current\nCLOUDSMITH_API_KEY=current-operator-key\n",
    { mode: 0o600 },
  );

  await writeProtectedRepositoryEnvAtomic(envPath, "FOO=stale-proposal\n");

  const persisted = fs.readFileSync(envPath, "utf8");
  assert.match(persisted, /^FOO=stale-proposal$/m);
  assert.match(persisted, /^CLOUDSMITH_API_KEY=current-operator-key$/m);
  assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
});

test("synchronous preset writes use the same atomic protected path", (t) => {
  const fixture = fs.mkdtempSync("/tmp/portico-protected-env-sync-");
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const envPath = path.join(fixture, ".env");
  fs.writeFileSync(envPath, "CLOUDSMITH_API_KEY=current-operator-key\n", {
    mode: 0o600,
  });

  writeProtectedRepositoryEnvAtomicSync(envPath, "FOO=updated\n");

  const persisted = fs.readFileSync(envPath, "utf8");
  assert.match(persisted, /^FOO=updated$/m);
  assert.match(persisted, /^CLOUDSMITH_API_KEY=current-operator-key$/m);
  assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
});

test("repository-root detection protects dev runs and packaged source checkouts", () => {
  assert.equal(
    isProtectedRepositoryRoot("/tmp/source", { isPackaged: false }),
    true,
  );
  assert.equal(
    isProtectedRepositoryRoot("/tmp/source", {
      isPackaged: true,
      existsSync: (candidate) => candidate === "/tmp/source/.git",
    }),
    true,
  );
  assert.equal(
    isProtectedRepositoryRoot("/tmp/managed", {
      isPackaged: true,
      existsSync: () => false,
    }),
    false,
  );
});

test("Electron raw env writes use the atomic protected repository writer", () => {
  const ipcSource = fs.readFileSync(path.join(__dirname, "ipc.js"), "utf8");
  const handlerStart = ipcSource.indexOf('ipcMain.handle("write-env-file"');
  const handlerEnd = ipcSource.indexOf("// Read JSON file", handlerStart);
  const handlerSource = ipcSource.slice(handlerStart, handlerEnd);

  assert.ok(handlerStart >= 0, "write-env-file handler must exist");
  assert.match(handlerSource, /writeCanonicalIdentityEnv\(/);
  assert.match(
    handlerSource,
    /writeProtectedRepositoryEnvAtomic\(envPath, contentToWrite\)/,
  );
});

test("legacy configuration saves use the same protected env write path", () => {
  const ipcSource = fs.readFileSync(path.join(__dirname, "ipc.js"), "utf8");
  const handlerStart = ipcSource.indexOf('ipcMain.handle("save-config"');
  const handlerEnd = ipcSource.indexOf("// Load MCP toggles", handlerStart);
  const handlerSource = ipcSource.slice(handlerStart, handlerEnd);

  assert.ok(handlerStart >= 0, "save-config handler must exist");
  assert.match(
    handlerSource,
    /writeProtectedRepositoryEnvAtomic\(\s*envPath,\s*envContent,\s*\)/,
  );
});

test("preset application preserves the current operator key before rewriting env", () => {
  const dockerMcpSource = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );
  const functionStart = dockerMcpSource.indexOf(
    "async function applyPresetEnvVars",
  );
  const functionEnd = dockerMcpSource.indexOf(
    "// MCP INITIALIZATION",
    functionStart,
  );
  const functionSource = dockerMcpSource.slice(functionStart, functionEnd);

  assert.ok(functionStart >= 0, "applyPresetEnvVars must exist");
  assert.match(
    functionSource,
    /writeProtectedRepositoryEnvAtomicSync\(envPath, serializeEnvFile\(envVars\)\)/,
  );
});
