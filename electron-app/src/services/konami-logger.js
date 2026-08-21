const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const MAX_LOG_FILES = 10;

function serializeMeta(value, seen = new WeakSet(), depth = 0) {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "bigint") {
    return `${value.toString()}n`;
  }

  if (typeof value !== "object") {
    return value;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (seen.has(value)) {
    return "[Circular]";
  }

  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map((entry) =>
        depth >= 6 ? "[MaxDepth]" : serializeMeta(entry, seen, depth + 1),
      );
    }

    const serialized = {};
    for (const [key, entryValue] of Object.entries(value)) {
      serialized[key] =
        depth >= 6 ? "[MaxDepth]" : serializeMeta(entryValue, seen, depth + 1);
    }
    return serialized;
  } finally {
    seen.delete(value);
  }
}

class KonamiLogger {
  constructor() {
    this.logDir = path.join(app.getPath("userData"), "logs");
    this.logFile = path.join(
      this.logDir,
      `konami-${new Date().toISOString().split("T")[0]}.log`,
    );
    this.logStream = null;
    this.initialized = false;
  }

  init() {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }

    this.logStream = fs.createWriteStream(this.logFile, { flags: "a" });
    this.initialized = true;

    const separator = "=".repeat(60);
    this.writeToFile(
      `\n${separator}\n` +
        `[${new Date().toISOString()}] [Konami:System] [INFO] KONAMI LOGGER START\n` +
        `${separator}\n`,
    );
    this.writeToFile(
      `[${new Date().toISOString()}] [Konami:System] [INFO] Konami logger initialized - Log file: ${this.logFile}\n`,
    );

    this.cleanupOldLogs();

    process.on("exit", () => this.close());
    process.on("SIGTERM", () => this.close());
    process.on("SIGINT", () => this.close());
  }

  log(layer, level, message, meta = null) {
    if (!this.initialized || !this.logStream || !this.logStream.writable) {
      return;
    }

    const normalizedLayer = typeof layer === "string" && layer.trim()
      ? layer.trim()
      : "Unknown";
    const normalizedLevel = String(level || "INFO").toUpperCase();
    const text = String(message || "");
    let suffix = "";

    if (meta !== null && meta !== undefined) {
      try {
        suffix = ` ${JSON.stringify(serializeMeta(meta))}`;
      } catch (_error) {
        suffix = ` ${String(meta)}`;
      }
    }

    this.writeToFile(
      `[${new Date().toISOString()}] [Konami:${normalizedLayer}] [${normalizedLevel}] ${text}${suffix}\n`,
    );
  }

  writeToFile(message) {
    if (!this.logStream || !this.logStream.writable) {
      return;
    }

    try {
      this.logStream.write(message);
    } catch (_error) {
      // Best effort logging only.
    }
  }

  cleanupOldLogs() {
    try {
      const files = fs
        .readdirSync(this.logDir)
        .filter((file) => file.startsWith("konami-") && file.endsWith(".log"))
        .map((file) => ({
          name: file,
          path: path.join(this.logDir, file),
          mtime: fs.statSync(path.join(this.logDir, file)).mtimeMs,
        }))
        .sort((left, right) => right.mtime - left.mtime);

      for (const file of files.slice(MAX_LOG_FILES)) {
        try {
          fs.unlinkSync(file.path);
        } catch (_error) {
          // Best effort cleanup only.
        }
      }
    } catch (_error) {
      // Best effort cleanup only.
    }
  }

  getLogPath() {
    return this.logFile;
  }

  close() {
    if (!this.logStream) {
      return;
    }

    try {
      this.logStream.write(
        `[${new Date().toISOString()}] [Konami:System] [INFO] Konami logger shutting down\n`,
      );
      this.logStream.end();
    } catch (_error) {
      // Ignore shutdown logging failures.
    }

    this.logStream = null;
    this.initialized = false;
  }
}

let konamiLoggerInstance = null;

function initKonamiLogger() {
  if (!konamiLoggerInstance) {
    konamiLoggerInstance = new KonamiLogger();
    konamiLoggerInstance.init();
  }
  return konamiLoggerInstance;
}

function getKonamiLogger() {
  return konamiLoggerInstance;
}

function getKonamiLogPath() {
  return konamiLoggerInstance ? konamiLoggerInstance.getLogPath() : null;
}

module.exports = {
  initKonamiLogger,
  getKonamiLogger,
  getKonamiLogPath,
};
