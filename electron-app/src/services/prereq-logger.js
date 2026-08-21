// prereq-logger.js - Dedicated logging for prerequisites flow
// Captures all 4 phases: Download, Dependencies, Docker Setup, Host Mode
// Follows oauth-logger.js patterns with session IDs and throttling

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// ============================================================================
// CONFIGURATION
// ============================================================================

// Max files to retain before cleanup
const MAX_LOG_FILES = 10;

// Throttle configuration
const DOCKER_PROGRESS_THROTTLE_MS = 5000;  // Max 1 log per image per 5 seconds
const SHELL_OUTPUT_BATCH_INTERVAL_MS = 2000;  // Batch shell output every 2 seconds
const SHELL_OUTPUT_MAX_LOG_CHARS = 12000;
const SHELL_OUTPUT_HEAD_CHARS = 8000;
const SHELL_OUTPUT_TAIL_CHARS = 2000;

// ============================================================================
// REDACTION PATTERNS
// ============================================================================

const REDACTION_PATTERNS = [
  // API keys and tokens
  { regex: /\b(api[_-]?key|apikey)=[\w-]+/gi, replacement: '$1=[REDACTED]' },
  { regex: /\b(token|bearer|auth)[:=][\w.-]+/gi, replacement: '$1=[REDACTED]' },
  { regex: /(x-api-key:\s*)\S+/gi, replacement: '$1[REDACTED]' },
  { regex: /(authorization:\s*)\S.+/gi, replacement: '$1[REDACTED]' },
  // AWS credentials
  { regex: /\b(aws[_-]?(?:access[_-]?key|secret|session[_-]?token))=[\w/+=]+/gi, replacement: '$1=[REDACTED]' },
  // Generic secrets in env vars
  { regex: /(secret|password|credential|private[_-]?key)=.+/gi, replacement: '$1=[REDACTED]' },
  // URLs with credentials
  { regex: /:\/\/[^:]+:[^@]+@/g, replacement: '://[REDACTED]@' },
  // Cloudsmith tokens
  { regex: /\b(cloudsmith[_-]?(?:api[_-]?key|entitlement[_-]?token))=.+/gi, replacement: '$1=[REDACTED]' },
  // LLM API keys (Portico specific)
  { regex: /\b(portico[_-]?llm[_-]?api[_-]?key)=.+/gi, replacement: '$1=[REDACTED]' },
];

// ============================================================================
// LOGGER CLASS
// ============================================================================

/**
 * Prerequisites Logger - Singleton class for prerequisites flow logging
 *
 * Log format: [ISO8601_TIMESTAMP] [SESSION_ID] [Prereq:LAYER] [LEVEL] MESSAGE
 *
 * Layer identifiers:
 * - [Prereq:System] - General prerequisites orchestration
 * - [Prereq:Download] - Phase 1: Cloudsmith download
 * - [Prereq:Dependencies] - Phase 2: Homebrew, Node.js, etc.
 * - [Prereq:Docker] - Phase 3: Docker setup and image pulls
 * - [Prereq:HostMode] - Phase 4: Host mode check
 * - [Prereq:IPC] - IPC event emissions
 */
class PrereqLogger {
  constructor() {
    this.logDir = path.join(app.getPath('userData'), 'logs');
    this.logFile = null;
    this.logStream = null;
    this.initialized = false;
    this.sessionId = null;

    // Throttling state for Docker progress
    this.lastDockerLogTime = {};  // Map of image -> last log timestamp

    // Batching state for shell output
    this.shellOutputBuffer = [];
    this.shellOutputBatchTimer = null;
    this.currentPhase = null;
  }

  /**
   * Initialize the logger
   */
  init() {
    try {
      // Create logs directory if it doesn't exist
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }

      // Create log file with date suffix
      const dateStr = new Date().toISOString().split('T')[0];
      this.logFile = path.join(this.logDir, `prereq-${dateStr}.log`);

      // Create write stream with append mode
      this.logStream = fs.createWriteStream(this.logFile, { flags: 'a' });

      this.initialized = true;

      // Cleanup old log files
      this.cleanupOldLogs();

      // Handle process exit
      process.on('exit', () => this.close());
      process.on('SIGTERM', () => this.close());
      process.on('SIGINT', () => this.close());

      console.log(`[Prereq] Logger initialized - Log file: ${this.logFile}`);
    } catch (err) {
      console.error('[Prereq] Failed to initialize logger:', err.message);
      this.initialized = false;
    }
  }

  /**
   * Generate new session ID for each prerequisites run
   * Call this at the start of runAllPrerequisites()
   */
  startSession() {
    this.sessionId = `sess-${Math.random().toString(36).substring(2, 10)}`;
    this.lastDockerLogTime = {};
    this.shellOutputBuffer = [];
    this.currentPhase = null;

    // Write session start marker
    const separator = '='.repeat(60);
    const startupMarker = `\n${separator}\n` +
      `[${new Date().toISOString()}] [${this.sessionId}] [Prereq:System] [INFO] PREREQUISITES SESSION START\n` +
      `${separator}\n`;
    this.writeToFile(startupMarker);

    return this.sessionId;
  }

  /**
   * Main logging method
   * @param {string} layer - Source layer (System, Download, Dependencies, Docker, HostMode, IPC)
   * @param {string} level - Log level (INFO, WARN, ERROR, DEBUG)
   * @param {string} message - Log message
   */
  log(layer, level, message) {
    if (!this.initialized || !this.logStream || !this.logStream.writable) {
      return;  // Drop silently if not initialized (graceful degradation)
    }

    const timestamp = new Date().toISOString();
    const normalizedLevel = (level || 'INFO').toUpperCase();
    const sessionPart = this.sessionId ? `[${this.sessionId}] ` : '';
    const redactedMessage = this.redactSensitive(this.stripAnsi(String(message)));

    const logEntry = `[${timestamp}] ${sessionPart}[Prereq:${layer}] [${normalizedLevel}] ${redactedMessage}\n`;

    this.writeToFile(logEntry);

    // Also log to console in dev mode
    if (!app.isPackaged) {
      console.log(`[Prereq:${layer}] ${redactedMessage}`);
    }
  }

  /**
   * Log phase start
   */
  logPhaseStart(phaseNum, label) {
    this.currentPhase = phaseNum;
    const layerMap = { 1: 'Download', 2: 'Dependencies', 3: 'Docker', 4: 'HostMode' };
    const layer = layerMap[phaseNum] || 'System';
    this.log(layer, 'INFO', `Phase ${phaseNum} starting: ${label}`);
  }

  /**
   * Log phase completion
   */
  logPhaseComplete(phaseNum, success, elapsedMs) {
    this.flushShellOutputBuffer();
    const layerMap = { 1: 'Download', 2: 'Dependencies', 3: 'Docker', 4: 'HostMode' };
    const layer = layerMap[phaseNum] || 'System';
    const elapsed = elapsedMs ? ` (elapsed: ${Math.round(elapsedMs / 1000)}s)` : '';
    this.log(layer, success ? 'INFO' : 'ERROR', `Phase ${phaseNum} ${success ? 'complete' : 'failed'}${elapsed}`);
    this.currentPhase = null;
  }

  /**
   * Log step update (from shell script markers)
   */
  logStepUpdate(step, status) {
    const layerMap = { 1: 'Download', 2: 'Dependencies', 3: 'Docker', 4: 'HostMode' };
    const layer = layerMap[this.currentPhase] || 'System';
    this.log(layer, status === 'failed' ? 'ERROR' : 'INFO', `Step: ${step} - ${status.toUpperCase()}`);
  }

  /**
   * Log shell output with batching
   * Accumulates output and writes in batches to reduce log noise
   */
  logShellOutput(text, type = 'info') {
    // Add to buffer
    this.shellOutputBuffer.push({ text: this.stripAnsi(text), type, timestamp: Date.now() });

    // Set up batch timer if not already running
    if (!this.shellOutputBatchTimer) {
      this.shellOutputBatchTimer = setTimeout(() => {
        this.flushShellOutputBuffer();
      }, SHELL_OUTPUT_BATCH_INTERVAL_MS);
    }
  }

  /**
   * Flush accumulated shell output to log
   */
  flushShellOutputBuffer() {
    if (this.shellOutputBatchTimer) {
      clearTimeout(this.shellOutputBatchTimer);
      this.shellOutputBatchTimer = null;
    }

    if (this.shellOutputBuffer.length === 0) return;

    const layerMap = { 1: 'Download', 2: 'Dependencies', 3: 'Docker', 4: 'HostMode' };
    const layer = layerMap[this.currentPhase] || 'System';

    // Combine buffered output
    const lines = this.shellOutputBuffer.map(b => b.text.trim()).filter(t => t);
    const hasErrors = this.shellOutputBuffer.some(b => b.type === 'error');

    if (lines.length > 0) {
      // Keep substantially more shell context so download diagnostics survive batching.
      const combined = lines.join('\n');
      const preview = combined.length > SHELL_OUTPUT_MAX_LOG_CHARS
        ? `${combined.substring(0, SHELL_OUTPUT_HEAD_CHARS)}\n...[truncated ${combined.length - SHELL_OUTPUT_HEAD_CHARS - SHELL_OUTPUT_TAIL_CHARS} chars]...\n${combined.slice(-SHELL_OUTPUT_TAIL_CHARS)}`
        : combined;
      const level = hasErrors ? 'ERROR' : 'DEBUG';
      this.log(layer, level, `Shell output (${lines.length} lines):\n${preview}`);
    }

    this.shellOutputBuffer = [];
  }

  /**
   * Log Docker pull progress with throttling
   * Max 1 log per image per 5 seconds
   */
  logDockerPull(image, status, percent, eta) {
    const now = Date.now();
    const lastTime = this.lastDockerLogTime[image] || 0;

    // Always log start, complete, and failed
    const alwaysLog = ['starting', 'complete', 'failed'].includes(status);

    if (alwaysLog || (now - lastTime >= DOCKER_PROGRESS_THROTTLE_MS)) {
      this.lastDockerLogTime[image] = now;
      const level = status === 'failed' ? 'ERROR' : (status === 'complete' ? 'INFO' : 'DEBUG');
      const etaStr = eta ? ` ETA: ${eta}` : '';
      this.log('Docker', level, `${image} - ${status} (${percent}%)${etaStr}`);
    }
  }

  /**
   * Log error with optional stack trace
   */
  logError(layer, error) {
    const errorMsg = error instanceof Error
      ? `${error.message}\n${error.stack || ''}`
      : String(error);
    this.log(layer || 'System', 'ERROR', errorMsg);
  }

  /**
   * Log retry attempt
   */
  logRetry(phaseNum, attempt, maxAttempts, delayMs) {
    const layerMap = { 1: 'Download', 2: 'Dependencies', 3: 'Docker', 4: 'HostMode' };
    const layer = layerMap[phaseNum] || 'System';
    this.log(layer, 'WARN', `Retry ${attempt}/${maxAttempts} after ${delayMs}ms delay`);
  }

  /**
   * Log IPC event emission
   */
  logIpcEvent(eventName, data) {
    // Redact data before logging
    let dataStr;
    try {
      dataStr = JSON.stringify(data, (key, value) => {
        // Redact known sensitive keys
        if (['token', 'secret', 'password', 'apiKey', 'auth'].includes(key)) {
          return '[REDACTED]';
        }
        return value;
      });
    } catch {
      dataStr = '[unserializable]';
    }
    this.log('IPC', 'DEBUG', `Emit: ${eventName} ${dataStr}`);
  }

  /**
   * Log session end
   */
  logSessionEnd(success, elapsedMs) {
    this.flushShellOutputBuffer();
    const elapsed = Math.round(elapsedMs / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

    this.log('System', success ? 'INFO' : 'ERROR', `Prerequisites session ${success ? 'complete' : 'failed'} (total: ${timeStr})`);

    const separator = '='.repeat(60);
    this.writeToFile(`${separator}\n\n`);
  }

  /**
   * Redact sensitive information from text
   */
  redactSensitive(text) {
    if (typeof text !== 'string') return String(text);

    let redacted = text;
    for (const { regex, replacement } of REDACTION_PATTERNS) {
      redacted = redacted.replace(regex, replacement);
    }
    return redacted;
  }

  /**
   * Strip ANSI escape codes
   */
  stripAnsi(text) {
    if (typeof text !== 'string') return String(text);
    // eslint-disable-next-line no-control-regex
    return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
  }

  /**
   * Write to file with safety check
   */
  writeToFile(message) {
    if (this.logStream && this.logStream.writable) {
      try {
        this.logStream.write(message);
      } catch (e) {
        console.error('[Prereq] Failed to write to log:', e.message);
      }
    }
  }

  /**
   * Cleanup old log files (keep last 10)
   */
  cleanupOldLogs() {
    try {
      const files = fs.readdirSync(this.logDir)
        .filter(f => f.startsWith('prereq-') && f.endsWith('.log'))
        .map(f => ({
          name: f,
          path: path.join(this.logDir, f),
          mtime: fs.statSync(path.join(this.logDir, f)).mtime
        }))
        .sort((a, b) => b.mtime - a.mtime);  // Most recent first

      // Keep the most recent MAX_LOG_FILES, delete the rest
      const toDelete = files.slice(MAX_LOG_FILES);
      for (const file of toDelete) {
        try {
          fs.unlinkSync(file.path);
          console.log(`[Prereq] Deleted old log: ${file.name}`);
        } catch (e) {
          console.warn(`[Prereq] Failed to delete old log ${file.name}:`, e.message);
        }
      }

      if (toDelete.length > 0) {
        this.log('System', 'INFO', `Cleaned up ${toDelete.length} old log file(s)`);
      }
    } catch (e) {
      console.warn('[Prereq] Failed to cleanup old logs:', e.message);
    }
  }

  /**
   * Get current log file path
   */
  getLogPath() {
    return this.logFile;
  }

  /**
   * Get logs directory
   */
  getLogDir() {
    return this.logDir;
  }

  /**
   * Close the log stream gracefully
   */
  close() {
    if (this.shellOutputBatchTimer) {
      clearTimeout(this.shellOutputBatchTimer);
      this.shellOutputBatchTimer = null;
    }

    if (this.logStream) {
      try {
        const closeMsg = `[${new Date().toISOString()}] [Prereq:System] [INFO] Prerequisites logger shutting down\n`;
        this.logStream.write(closeMsg);
        this.logStream.end();
      } catch (e) {
        // Ignore errors during shutdown
      }
      this.logStream = null;
    }
  }
}

// ============================================================================
// SINGLETON MANAGEMENT
// ============================================================================

let prereqLoggerInstance = null;

/**
 * Initialize the prerequisites logger singleton
 * @returns {PrereqLogger} - The logger instance
 */
function initPrereqLogger() {
  if (!prereqLoggerInstance) {
    prereqLoggerInstance = new PrereqLogger();
    prereqLoggerInstance.init();
  }
  return prereqLoggerInstance;
}

/**
 * Get the prerequisites logger instance (must be initialized first)
 * @returns {PrereqLogger|null} - The logger instance or null
 */
function getPrereqLogger() {
  return prereqLoggerInstance;
}

/**
 * Log a prerequisites event (convenience function with fallback)
 * @param {string} layer - Source layer
 * @param {string} level - Log level
 * @param {string} message - Log message
 */
function logPrereq(layer, level, message) {
  if (prereqLoggerInstance && prereqLoggerInstance.initialized) {
    prereqLoggerInstance.log(layer, level, message);
  } else {
    // Fallback to console if logger not initialized
    const prefix = `[Prereq:Fallback:${layer}]`;
    if (level === 'ERROR') {
      console.error(prefix, message);
    } else if (level === 'WARN') {
      console.warn(prefix, message);
    } else {
      console.log(prefix, message);
    }
  }
}

/**
 * Get the prerequisites log file path
 * @returns {string|null} - Path to current log file or null
 */
function getPrereqLogPath() {
  return prereqLoggerInstance ? prereqLoggerInstance.getLogPath() : null;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  initPrereqLogger,
  getPrereqLogger,
  logPrereq,
  getPrereqLogPath
};
