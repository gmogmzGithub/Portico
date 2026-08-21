const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function serializeForLog(value, seen = new WeakSet(), depth = 0) {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'bigint') {
    return `${value.toString()}n`;
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (value instanceof Error) {
    const serializedError = {
      name: value.name,
      message: value.message,
      stack: value.stack
    };

    if ('code' in value) {
      serializedError.code = value.code;
    }

    if (value.cause !== undefined) {
      serializedError.cause =
        depth >= 6 ? '[MaxDepth]' : serializeForLog(value.cause, seen, depth + 1);
    }

    const enumerableEntries = Object.entries(value);
    for (const [key, entryValue] of enumerableEntries) {
      if (!(key in serializedError)) {
        serializedError[key] =
          depth >= 6 ? '[MaxDepth]' : serializeForLog(entryValue, seen, depth + 1);
      }
    }

    return serializedError;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }

  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map((item) =>
        depth >= 6 ? '[MaxDepth]' : serializeForLog(item, seen, depth + 1),
      );
    }

    const serializedObject = {};
    for (const [key, entryValue] of Object.entries(value)) {
      serializedObject[key] =
        depth >= 6 ? '[MaxDepth]' : serializeForLog(entryValue, seen, depth + 1);
    }
    return serializedObject;
  } finally {
    seen.delete(value);
  }
}

const MAX_LOG_FILE_SIZE = 50 * 1024 * 1024; // 50 MB per log file
const LOG_RETENTION_DAYS = 7;

// PORTICO-215: show the disk-full dialog at most once per session, no matter how
// many streams or uncaught exceptions report ENOSPC.
let diskFullNotified = false;

class Logger {
  constructor() {
    this.logDir = path.join(app.getPath('userData'), 'logs');
    this.logFile = path.join(this.logDir, `app-${new Date().toISOString().split('T')[0]}.log`);
    this.errorFile = path.join(this.logDir, `error-${new Date().toISOString().split('T')[0]}.log`);
    this.consoleFile = path.join(this.logDir, `console-${new Date().toISOString().split('T')[0]}.log`);
    this.logStream = null;
    this.errorStream = null;
    this.consoleStream = null;
    this.consoleEnabled = !app.isPackaged; // Only use console in development
    this._rotationInProgress = new Set();
    
    this.init();
  }

  init() {
    // Create logs directory
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }

    // Create write streams
    this.logStream = this.createStream(this.logFile);
    this.errorStream = this.createStream(this.errorFile);
    this.consoleStream = this.createStream(this.consoleFile);

    // Override console methods
    this.overrideConsole();
    
    // Handle uncaught exceptions
    this.setupErrorHandlers();

    // Clean up old log files
    this.cleanOldLogs();
  }

  // PORTICO-215: a log write stream without an 'error' listener turns an async
  // ENOSPC write failure into an uncaughtException (and, before this fix, a
  // generic "Application Error" dialog). Attach a listener that keeps the
  // process alive; the errored stream is destroyed, so writeToFile() skips
  // it via its stream.writable guard.
  createStream(filePath) {
    const stream = fs.createWriteStream(filePath, { flags: 'a' });
    stream.on('error', (error) => {
      try {
        if (error && error.code === 'ENOSPC') {
          this.notifyDiskFullOnce();
        }
        if (this.consoleEnabled && this.isConsoleSafe()) {
          process.stderr.write(`[Logger] log stream error: ${error && error.message}\n`);
        }
      } catch (e) {
        // Never throw from error handling
      }
    });
    return stream;
  }

  // PORTICO-215: replace the generic "unexpected error" dialog with an
  // actionable one when the real problem is a full disk.
  notifyDiskFullOnce() {
    if (diskFullNotified) {
      return;
    }
    diskFullNotified = true;
    try {
      if (app.isPackaged) {
        const { dialog } = require('electron');
        dialog.showErrorBox('Disk Full',
          'Portico cannot write to your disk because it is full. ' +
          'Free up disk space, then relaunch the app. If an update was in progress, ' +
          'it will resume automatically after relaunch.');
      }
    } catch (e) {
      // Never throw from error handling
    }
  }

  overrideConsole() {
    const originalConsole = {
      log: console.log,
      error: console.error,
      warn: console.warn,
      info: console.info,
      debug: console.debug
    };

    // Override console.log
    console.log = (...args) => {
      const message = this.formatMessage('LOG', args);
      this.writeToFile(this.logStream, message);
      
      // Only write to original console if safe to do so
      if (this.consoleEnabled && this.isConsoleSafe()) {
        try {
          originalConsole.log.apply(console, args);
        } catch (e) {
          // Silently fail if console write fails
        }
      }
    };

    // Override console.error
    console.error = (...args) => {
      const message = this.formatMessage('ERROR', args);
      this.writeToFile(this.errorStream, message);
      this.writeToFile(this.logStream, message);
      
      if (this.consoleEnabled && this.isConsoleSafe()) {
        try {
          originalConsole.error.apply(console, args);
        } catch (e) {
          // Silently fail
        }
      }
    };

    // Override console.warn
    console.warn = (...args) => {
      const message = this.formatMessage('WARN', args);
      this.writeToFile(this.logStream, message);
      
      if (this.consoleEnabled && this.isConsoleSafe()) {
        try {
          originalConsole.warn.apply(console, args);
        } catch (e) {
          // Silently fail
        }
      }
    };

    // Override console.info
    console.info = (...args) => {
      const message = this.formatMessage('INFO', args);
      this.writeToFile(this.logStream, message);
      
      if (this.consoleEnabled && this.isConsoleSafe()) {
        try {
          originalConsole.info.apply(console, args);
        } catch (e) {
          // Silently fail
        }
      }
    };
  }

  setupErrorHandlers() {
    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      const message = `[${new Date().toISOString()}] [UNCAUGHT EXCEPTION] ${error.stack || error}\n`;
      this.writeToFile(this.errorStream, message);
      this.writeToFile(this.logStream, message);

      // PORTICO-215: a full disk is a specific, user-fixable condition — say so
      // instead of showing the generic dialog.
      if (error && error.code === 'ENOSPC') {
        this.notifyDiskFullOnce();
        return;
      }

      // Optionally show dialog to user in production
      if (app.isPackaged) {
        const { dialog } = require('electron');
        dialog.showErrorBox('Application Error',
          'An unexpected error occurred. Please check the logs for details.');
      }
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      const message = `[${new Date().toISOString()}] [UNHANDLED REJECTION] ${reason}\n`;
      this.writeToFile(this.errorStream, message);
      this.writeToFile(this.logStream, message);
    });

    // Handle SIGTERM/SIGINT gracefully
    process.on('SIGTERM', () => this.close());
    process.on('SIGINT', () => this.close());
  }

  isConsoleSafe() {
    try {
      // Test if we can write to stdout
      if (process.stdout && process.stdout.writable) {
        return true;
      }
    } catch (e) {
      // Console not available
    }
    return false;
  }

  formatMessage(level, args) {
    const timestamp = new Date().toISOString();
    const message = args.map(arg => {
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(serializeForLog(arg), null, 2);
        } catch (e) {
          return String(arg);
        }
      }
      return String(arg);
    }).join(' ');
    
    return `[${timestamp}] [${level}] ${message}\n`;
  }

  writeToFile(stream, message) {
    if (stream && stream.writable) {
      try {
        stream.write(message);
        this.rotateIfNeeded(stream);
      } catch (e) {
        // Failed to write to file, nothing we can do
      }
    }
  }

  rotateIfNeeded(stream) {
    const filePath = stream.path;
    if (!filePath || this._rotationInProgress.has(filePath)) {
      return;
    }
    try {
      const stats = fs.statSync(filePath);
      if (stats.size < MAX_LOG_FILE_SIZE) {
        return;
      }
    } catch (e) {
      return;
    }

    this._rotationInProgress.add(filePath);
    try {
      const rotatedPath = filePath + '.1';
      // Close current stream
      stream.end();
      // Rotate: overwrite the .1 backup with current file
      try { fs.unlinkSync(rotatedPath); } catch (e) { /* may not exist */ }
      fs.renameSync(filePath, rotatedPath);
      // Reopen stream (PORTICO-215: with the shared 'error' listener)
      const newStream = this.createStream(filePath);
      if (stream === this.logStream) { this.logStream = newStream; }
      else if (stream === this.errorStream) { this.errorStream = newStream; }
      else if (stream === this.consoleStream) { this.consoleStream = newStream; }
    } catch (e) {
      // Best effort rotation
    } finally {
      this._rotationInProgress.delete(filePath);
    }
  }

  cleanOldLogs() {
    try {
      const now = Date.now();
      const files = fs.readdirSync(this.logDir);
      for (const file of files) {
        if (!file.endsWith('.log') && !file.endsWith('.log.1')) continue;
        const filePath = path.join(this.logDir, file);
        try {
          const stats = fs.statSync(filePath);
          const ageDays = (now - stats.mtimeMs) / (1000 * 60 * 60 * 24);
          if (ageDays > LOG_RETENTION_DAYS) {
            fs.unlinkSync(filePath);
          }
        } catch (e) { /* skip */ }
      }
    } catch (e) { /* best effort */ }
  }

  writeWebviewConsoleEntry(entry = {}) {
    const level = String(entry.level || 'info').toUpperCase();
    const message = String(entry.message || '');
    const timestamp = new Date().toISOString();
    let formatted = `[${timestamp}] [${level}] ${message}`;

    if (entry.meta !== undefined) {
      try {
        formatted += ` ${JSON.stringify(serializeForLog(entry.meta))}`;
      } catch (error) {
        formatted += ` ${String(entry.meta)}`;
      }
    }

    this.writeToFile(this.consoleStream, `${formatted}\n`);
  }

  close() {
    if (this.logStream) {
      this.logStream.end();
    }
    if (this.errorStream) {
      this.errorStream.end();
    }
    if (this.consoleStream) {
      this.consoleStream.end();
    }
  }

  // Get log file paths for debugging
  getLogPaths() {
    return {
      logFile: this.logFile,
      errorFile: this.errorFile,
      consoleFile: this.consoleFile,
      logDir: this.logDir
    };
  }
}

// Create singleton instance
let loggerInstance = null;

module.exports = {
  initLogger: () => {
    if (!loggerInstance) {
      loggerInstance = new Logger();
    }
    return loggerInstance;
  },
  getLogger: () => loggerInstance,
  getLogPaths: () => loggerInstance ? loggerInstance.getLogPaths() : null
};
