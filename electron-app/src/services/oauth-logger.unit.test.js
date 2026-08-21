const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const loggerPath = require.resolve("./oauth-logger");
const electronPath = require.resolve("electron");
const fsPath = require.resolve("fs");

class FakeLogStream extends EventEmitter {
  constructor() {
    super();
    this.writable = true;
    this.writeCalls = [];
    this.writeError = null;
  }

  write(value) {
    this.writeCalls.push(value);
    if (this.writeError) {
      throw this.writeError;
    }
    return true;
  }

  end() {
    this.writable = false;
  }
}

function loadOAuthLogger(fakeStream) {
  const previousLogger = require.cache[loggerPath];
  const previousElectron = require.cache[electronPath];
  const previousFs = require.cache[fsPath];

  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      app: {
        getPath: () => "/tmp/oauth-logger-test",
        isPackaged: true,
      },
    },
  };
  require.cache[fsPath] = {
    id: fsPath,
    filename: fsPath,
    loaded: true,
    exports: {
      createWriteStream: () => fakeStream,
      existsSync: () => true,
      mkdirSync: () => undefined,
      readdirSync: () => [],
      statSync: () => ({ mtime: new Date(0) }),
      unlinkSync: () => undefined,
    },
  };
  delete require.cache[loggerPath];
  const moduleExports = require("./oauth-logger");

  return {
    logger: moduleExports.initOAuthLogger(),
    restore() {
      delete require.cache[loggerPath];
      if (previousLogger) require.cache[loggerPath] = previousLogger;
      if (previousElectron) require.cache[electronPath] = previousElectron;
      else delete require.cache[electronPath];
      if (previousFs) require.cache[fsPath] = previousFs;
      else delete require.cache[fsPath];
    },
  };
}

function captureProcessOutput(run) {
  const previousStderrWrite = process.stderr.write;
  const previousConsoleError = console.error;
  const previousConsoleWarn = console.warn;
  const output = [];
  process.stderr.write = (value) => {
    output.push(String(value));
    return true;
  };
  console.error = (...values) => output.push(values.join(" "));
  console.warn = (...values) => output.push(values.join(" "));

  try {
    run(output);
  } finally {
    process.stderr.write = previousStderrWrite;
    console.error = previousConsoleError;
    console.warn = previousConsoleWarn;
  }
}

test("OAuth logger contains asynchronous stream errors without exposing them", () => {
  const stream = new FakeLogStream();
  const loaded = loadOAuthLogger(stream);
  try {
    captureProcessOutput((output) => {
      assert.doesNotThrow(() => {
        stream.emit("error", new Error("SECRET_ASYNC_SENTINEL"));
      });
      assert.equal(loaded.logger.logStream, null);
      assert.doesNotThrow(() => {
        loaded.logger.log("Electron", "ERROR", "safe diagnostic");
      });
      assert.doesNotMatch(output.join("\n"), /SECRET_ASYNC_SENTINEL/);
    });
  } finally {
    loaded.logger.close();
    loaded.restore();
  }
});

test("OAuth logger contains synchronous writes that throw without exposing them", () => {
  const stream = new FakeLogStream();
  const loaded = loadOAuthLogger(stream);
  try {
    const writesBeforeFailure = stream.writeCalls.length;
    stream.writeError = new Error("SECRET_SYNC_SENTINEL");
    captureProcessOutput((output) => {
      assert.doesNotThrow(() => {
        loaded.logger.log("Electron", "ERROR", "safe diagnostic");
      });
      assert.equal(loaded.logger.logStream, null);
      assert.equal(stream.writeCalls.length, writesBeforeFailure + 1);
      assert.doesNotThrow(() => {
        loaded.logger.log("Electron", "ERROR", "second diagnostic");
      });
      assert.equal(stream.writeCalls.length, writesBeforeFailure + 1);
      assert.doesNotMatch(output.join("\n"), /SECRET_SYNC_SENTINEL/);
    });
  } finally {
    loaded.logger.close();
    loaded.restore();
  }
});


test("OAuth logger preserves fixed setup-auth diagnostics through redaction", () => {
  const stream = new FakeLogStream();
  const loaded = loadOAuthLogger(stream);
  try {
    const diagnostic = {
      event: "setup_auth_failed",
      failure: "access_denied_user_cancelled",
      httpStatus: 400,
      provider: "unsupported_response_type",
      reason: "user_cancelled",
      bodyKind: "oauth_error_json",
    };
    loaded.logger.log("Electron", "ERROR", JSON.stringify(diagnostic));

    const written = stream.writeCalls.at(-1);
    assert.match(written, /"failure":"access_denied_user_cancelled"/);
    assert.match(written, /"provider":"unsupported_response_type"/);
    assert.doesNotMatch(written, /\[REDACTED\]/);
  } finally {
    loaded.logger.close();
    loaded.restore();
  }
});
