const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  isCoveredByUnpackRoot,
  isRealPathInsideDirectory,
  verifyConfiguredDependencyClosure,
} = require("../../scripts/verify-sandbox-runtime-package");

test("sandbox runtime direct dependency closure is unpacked", () => {
  assert.deepEqual(verifyConfiguredDependencyClosure(), [
    "@pondwader/socks5-server",
    "commander",
    "node-forge",
    "shell-quote",
    "zod",
  ]);
});

test("unpack coverage includes dependencies nested under sandbox runtime", () => {
  assert.equal(
    isCoveredByUnpackRoot(
      "node_modules/@anthropic-ai/sandbox-runtime/node_modules/commander/index.js",
      ["node_modules/@anthropic-ai/sandbox-runtime"],
    ),
    true,
  );
  assert.equal(
    isCoveredByUnpackRoot("node_modules/node-forge/lib/index.js", [
      "node_modules/@anthropic-ai/sandbox-runtime",
    ]),
    false,
  );
});

test("packaged dependency containment resolves path aliases and rejects escapes", (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "sandbox-runtime-package-"),
  );
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  const realResources = path.join(temporaryRoot, "real-resources");
  const unpackedRoot = path.join(realResources, "app.asar.unpacked");
  const insideEntrypoint = path.join(
    unpackedRoot,
    "node_modules",
    "inside-package",
    "index.js",
  );
  const outsideDirectory = path.join(temporaryRoot, "outside-package");
  const outsideEntrypoint = path.join(outsideDirectory, "index.js");
  fs.mkdirSync(path.dirname(insideEntrypoint), { recursive: true });
  fs.mkdirSync(outsideDirectory, { recursive: true });
  fs.writeFileSync(insideEntrypoint, "module.exports = {};\n");
  fs.writeFileSync(outsideEntrypoint, "module.exports = {};\n");

  const directorySymlinkType = process.platform === "win32" ? "junction" : "dir";
  const resourcesAlias = path.join(temporaryRoot, "resources-alias");
  fs.symlinkSync(realResources, resourcesAlias, directorySymlinkType);
  const aliasedUnpackedRoot = path.join(resourcesAlias, "app.asar.unpacked");

  assert.equal(
    isRealPathInsideDirectory(aliasedUnpackedRoot, insideEntrypoint),
    true,
  );
  assert.equal(
    isRealPathInsideDirectory(aliasedUnpackedRoot, outsideEntrypoint),
    false,
  );

  const escapedPackage = path.join(
    unpackedRoot,
    "node_modules",
    "escaped-package",
  );
  fs.symlinkSync(outsideDirectory, escapedPackage, directorySymlinkType);
  assert.equal(
    isRealPathInsideDirectory(
      aliasedUnpackedRoot,
      path.join(escapedPackage, "index.js"),
    ),
    false,
  );
});
