const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  APP_PAGE_FILES,
} = require("./app-protocol");
const {
  verifyAppProtocolContract,
} = require("../../scripts/verify-app-protocol-contract");

function createFixture({ grantFilePrivileges = false, windowsSource = "" } = {}) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "app-protocol-contract-"),
  );
  fs.mkdirSync(path.join(root, "src", "services"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "renderer", "views"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      build: {
        electronFuses: {
          grantFileProtocolExtraPrivileges: grantFilePrivileges,
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(root, "src", "services", "windows.js"),
    windowsSource,
  );
  for (const page of APP_PAGE_FILES) {
    fs.writeFileSync(
      path.join(root, "src", "renderer", "views", page),
      "<!doctype html>",
    );
  }
  return root;
}

test("pre-bundle verifier accepts the app protocol contract", (t) => {
  const root = createFixture({
    windowsSource: "loadAppPage(windowRef, 'index.html');",
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = verifyAppProtocolContract(root);
  assert.equal(result.pages, 8);
  assert.equal(result.grantFileProtocolExtraPrivileges, false);
});

test("pre-bundle verifier rejects loadFile with hardened fuses", (t) => {
  const root = createFixture({
    windowsSource: "windowRef.loadFile('/tmp/index.html');",
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(
    () => verifyAppProtocolContract(root),
    /BrowserWindow\.loadFile\(\) cannot be used/,
  );
});

test("pre-bundle verifier scans runtime modules beyond windows.js", (t) => {
  const root = createFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "src", "services", "secondary-window.js"),
    "secondaryWindow.loadFile('/tmp/secondary.html');",
  );

  assert.throws(
    () => verifyAppProtocolContract(root),
    /src\/services\/secondary-window\.js/,
  );
});

test("pre-bundle verifier rejects missing declared pages", (t) => {
  const root = createFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.rmSync(
    path.join(root, "src", "renderer", "views", "guided-setup.html"),
  );

  assert.throws(
    () => verifyAppProtocolContract(root),
    /Declared application page is missing: src\/renderer\/views\/guided-setup\.html/,
  );
});
