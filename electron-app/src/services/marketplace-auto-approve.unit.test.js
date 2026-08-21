const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  MARKETPLACE_AUTO_APPROVE_FILENAME,
  MARKETPLACE_AUTO_APPROVE_SCHEMA_VERSION,
  defaultMarketplaceAutoApprovePreferences,
  getMarketplaceAutoApprovePath,
  normalizeMarketplaceAutoApprovePreferences,
  readMarketplaceAutoApprovePreferences,
  saveMarketplaceAutoApprovePreferences,
  resolveMarketplaceAutoApprove,
} = require("./marketplace-auto-approve");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "marketplace-auto-approve-"));
}

test("missing auto-approve file resolves to defaults (off)", () => {
  const root = makeTempDir();
  const result = readMarketplaceAutoApprovePreferences({ userDataPath: root });

  assert.equal(result.success, true);
  assert.equal(result.exists, false);
  assert.equal(result.parseError, null);
  assert.equal(result.data.autoApprove, false);
  assert.equal(result.path, path.join(root, MARKETPLACE_AUTO_APPROVE_FILENAME));

  assert.equal(
    resolveMarketplaceAutoApprove({ userDataPath: root, isDevBuild: true }),
    false,
  );
});

test("dev builds round-trip the toggle across relaunch-style reads", () => {
  const root = makeTempDir();

  const onSave = saveMarketplaceAutoApprovePreferences({
    userDataPath: root,
    autoApprove: true,
    isDevBuild: true,
  });
  assert.equal(onSave.success, true);
  assert.equal(onSave.data.autoApprove, true);
  assert.equal(
    resolveMarketplaceAutoApprove({ userDataPath: root, isDevBuild: true }),
    true,
  );

  const offSave = saveMarketplaceAutoApprovePreferences({
    userDataPath: root,
    autoApprove: false,
    isDevBuild: true,
  });
  assert.equal(offSave.success, true);
  assert.equal(offSave.data.autoApprove, false);
  assert.equal(
    resolveMarketplaceAutoApprove({ userDataPath: root, isDevBuild: true }),
    false,
  );

  const readResult = readMarketplaceAutoApprovePreferences({
    userDataPath: root,
  });
  assert.equal(readResult.exists, true);
  assert.match(readResult.data.updatedAt, /\d{4}-\d{2}-\d{2}T/);
});

test("write clamp: non-dev saves persist false even when asked for true", () => {
  const root = makeTempDir();

  const saveResult = saveMarketplaceAutoApprovePreferences({
    userDataPath: root,
    autoApprove: true,
    isDevBuild: false,
  });
  assert.equal(saveResult.success, true);
  assert.equal(saveResult.data.autoApprove, false);

  const onDisk = JSON.parse(
    fs.readFileSync(path.join(root, MARKETPLACE_AUTO_APPROVE_FILENAME), "utf8"),
  );
  assert.equal(onDisk.autoApprove, false);

  const missingFlagSave = saveMarketplaceAutoApprovePreferences({
    userDataPath: root,
    autoApprove: true,
  });
  assert.equal(missingFlagSave.data.autoApprove, false);
});

test("read clamp: hand-edited autoApprove=true never resolves true off dev builds", () => {
  const root = makeTempDir();
  fs.writeFileSync(
    path.join(root, MARKETPLACE_AUTO_APPROVE_FILENAME),
    JSON.stringify({
      schemaVersion: MARKETPLACE_AUTO_APPROVE_SCHEMA_VERSION,
      autoApprove: true,
      updatedAt: "2026-07-31T00:00:00.000Z",
    }),
    "utf8",
  );

  assert.equal(
    resolveMarketplaceAutoApprove({ userDataPath: root, isDevBuild: false }),
    false,
  );
  assert.equal(
    resolveMarketplaceAutoApprove({ userDataPath: root, isDevBuild: undefined }),
    false,
  );
  assert.equal(
    resolveMarketplaceAutoApprove({ userDataPath: root, isDevBuild: "dev-build" }),
    false,
  );
  // Same file, dev build: the stored value is honored.
  assert.equal(
    resolveMarketplaceAutoApprove({ userDataPath: root, isDevBuild: true }),
    true,
  );
});

test("malformed or wrong-schema auto-approve files resolve to off", () => {
  const brokenRoot = makeTempDir();
  fs.writeFileSync(
    path.join(brokenRoot, MARKETPLACE_AUTO_APPROVE_FILENAME),
    "{broken-json",
    "utf8",
  );
  const brokenRead = readMarketplaceAutoApprovePreferences({
    userDataPath: brokenRoot,
  });
  assert.equal(brokenRead.success, true);
  assert.deepEqual(brokenRead.data, defaultMarketplaceAutoApprovePreferences());
  assert.match(brokenRead.parseError, /Unexpected token|Expected property name/);
  assert.equal(
    resolveMarketplaceAutoApprove({ userDataPath: brokenRoot, isDevBuild: true }),
    false,
  );

  const wrongSchemaRoot = makeTempDir();
  fs.writeFileSync(
    path.join(wrongSchemaRoot, MARKETPLACE_AUTO_APPROVE_FILENAME),
    JSON.stringify({ schemaVersion: 999, autoApprove: true }),
    "utf8",
  );
  const wrongSchemaRead = readMarketplaceAutoApprovePreferences({
    userDataPath: wrongSchemaRoot,
  });
  assert.equal(
    wrongSchemaRead.parseError,
    "unsupported marketplace auto-approve schemaVersion: 999",
  );
  assert.equal(
    resolveMarketplaceAutoApprove({
      userDataPath: wrongSchemaRoot,
      isDevBuild: true,
    }),
    false,
  );
});

test("auto-approve helpers normalize supported data and reject malformed payloads", () => {
  assert.deepEqual(defaultMarketplaceAutoApprovePreferences(), {
    schemaVersion: MARKETPLACE_AUTO_APPROVE_SCHEMA_VERSION,
    autoApprove: false,
    updatedAt: null,
  });

  assert.equal(
    getMarketplaceAutoApprovePath("/tmp/preferences-root"),
    "/tmp/preferences-root/marketplace-auto-approve.json",
  );

  assert.deepEqual(
    normalizeMarketplaceAutoApprovePreferences({
      schemaVersion: "1",
      autoApprove: true,
      updatedAt: " 2026-04-08T16:00:00.000Z ",
    }),
    {
      success: true,
      data: {
        schemaVersion: MARKETPLACE_AUTO_APPROVE_SCHEMA_VERSION,
        autoApprove: true,
        updatedAt: "2026-04-08T16:00:00.000Z",
      },
    },
  );
  // Non-boolean truthy values are not honored.
  assert.equal(
    normalizeMarketplaceAutoApprovePreferences({
      schemaVersion: 1,
      autoApprove: "true",
    }).data.autoApprove,
    false,
  );

  assert.deepEqual(normalizeMarketplaceAutoApprovePreferences(null), {
    success: false,
    error: "marketplace auto-approve preferences must be a JSON object",
  });
  assert.deepEqual(normalizeMarketplaceAutoApprovePreferences([]), {
    success: false,
    error: "marketplace auto-approve preferences must be a JSON object",
  });
});

test("auto-approve guards invalid inputs when reading or saving", () => {
  const missingPathRead = readMarketplaceAutoApprovePreferences({
    userDataPath: "",
  });
  assert.equal(missingPathRead.success, false);
  assert.equal(missingPathRead.path, null);
  assert.equal(missingPathRead.error, "userDataPath is required");
  assert.deepEqual(missingPathRead.data, defaultMarketplaceAutoApprovePreferences());

  assert.deepEqual(
    saveMarketplaceAutoApprovePreferences({
      userDataPath: null,
      autoApprove: true,
      isDevBuild: true,
    }),
    { success: false, error: "userDataPath is required", path: null },
  );

  assert.equal(
    resolveMarketplaceAutoApprove({ userDataPath: "", isDevBuild: true }),
    false,
  );
});
