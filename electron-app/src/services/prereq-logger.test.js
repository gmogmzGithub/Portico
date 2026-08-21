const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const prereqLoggerModulePath = require.resolve("./prereq-logger");
const originalLoad = Module._load;

function loadPrereqLogger(tempDir) {
  const previousModule = require.cache[prereqLoggerModulePath];

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") {
      return {
        app: {
          getPath(name) {
            assert.equal(name, "userData");
            return tempDir;
          },
          isPackaged: true,
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };

  delete require.cache[prereqLoggerModulePath];

  const moduleExports = require("./prereq-logger");

  return {
    ...moduleExports,
    restore() {
      Module._load = originalLoad;
      delete require.cache[prereqLoggerModulePath];
      if (previousModule) {
        require.cache[prereqLoggerModulePath] = previousModule;
      }
    },
  };
}

test("prereq logger redacts API keys but preserves tokenized Cloudsmith URLs", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "prereq-logger-test-"));
  const { initPrereqLogger, getPrereqLogger, restore } = loadPrereqLogger(tempDir);

  try {
    const logger = initPrereqLogger();
    const original =
      'curl -H "X-Api-Key: secret123" ' +
      "https://dl.artifacts.example.invalid/9QfcUgUjk84aWuon/portico/raw/names/portico_dev/versions/03162026-27c78cfb/pkg.zip " +
      "CLOUDSMITH_API_KEY=secret123";

    const redacted = logger.redactSensitive(original);

    assert.match(redacted, /X-Api-Key: \[REDACTED\]/);
    assert.match(redacted, /CLOUDSMITH_API_KEY=\[REDACTED\]/i);
    assert.doesNotMatch(redacted, /secret123/);
    assert.match(
      redacted,
      /https:\/\/dl\.artifacts\.portico\.tech\/9QfcUgUjk84aWuon\/portico\/raw\/names\/portico_dev\/versions\/03162026-27c78cfb\/pkg\.zip/,
    );
  } finally {
    const logger = getPrereqLogger();
    if (logger) {
      logger.close();
    }
    restore();
  }
});
