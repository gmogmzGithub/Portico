const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const konamiLoggerModulePath = require.resolve("./konami-logger");
const originalLoad = Module._load;

function loadKonamiLogger(tempDir) {
  const previousModule = require.cache[konamiLoggerModulePath];

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

  delete require.cache[konamiLoggerModulePath];

  const moduleExports = require("./konami-logger");

  return {
    ...moduleExports,
    restore() {
      Module._load = originalLoad;
      delete require.cache[konamiLoggerModulePath];
      if (previousModule) {
        require.cache[konamiLoggerModulePath] = previousModule;
      }
    },
  };
}

test("konami logger writes dedicated structured entries under userData logs", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "konami-logger-test-"));
  const { initKonamiLogger, getKonamiLogger, getKonamiLogPath, restore } = loadKonamiLogger(tempDir);

  try {
    const logger = initKonamiLogger();
    logger.log("Renderer", "info", "Burst detected", {
      phase: "rapid-press",
      attempt: 10,
      viewKey: "main",
    });
    logger.close();
    await new Promise((resolve) => setTimeout(resolve, 25));

    const logPath = getKonamiLogPath();
    assert.equal(typeof logPath, "string");
    assert.match(path.basename(logPath), /^konami-\d{4}-\d{2}-\d{2}\.log$/);

    const contents = fs.readFileSync(logPath, "utf8");
    assert.match(contents, /\[Konami:System\] \[INFO\] Konami logger initialized/);
    assert.match(contents, /\[Konami:Renderer\] \[INFO\] Burst detected/);
    assert.match(contents, /"phase":"rapid-press"/);
    assert.match(contents, /"attempt":10/);
    assert.equal(getKonamiLogger(), logger);
  } finally {
    const logger = getKonamiLogger();
    if (logger) {
      logger.close();
    }
    restore();
  }
});
