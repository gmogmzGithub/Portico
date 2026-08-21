// oauth-logger.js - Unified OAuth logging across all application layers
// Aggregates OAuth events from Docker/Python, Electron main, Frontend, and MCP tools
// into a single dedicated log file for easy debugging

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/**
 * OAuth Logger - Singleton class for unified OAuth logging
 *
 * Log format: [ISO8601_TIMESTAMP] [OAuth:LAYER] [LEVEL] MESSAGE
 *
 * Layer identifiers:
 * - [OAuth:MCPO] - Docker Python MCPO containers
 * - [OAuth:Electron] - Electron main process
 * - [OAuth:Frontend] - Renderer/browser components
 * - [OAuth:MCP-Tools] - Core MCP assistant tools
 */
class OAuthLogger {
  constructor() {
    this.logDir = path.join(app.getPath('userData'), 'logs');
    this.logFile = path.join(this.logDir, `oauth-${new Date().toISOString().split('T')[0]}.log`);
    this.logStream = null;

    this.init();
  }

  init() {
    // Create logs directory if it doesn't exist
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }

    // Attach the error listener before any startup writes. Stream errors are
    // asynchronous and must never become uncaught application errors.
    const stream = fs.createWriteStream(this.logFile, { flags: 'a' });
    stream.on('error', () => {
      if (this.logStream === stream) {
        this.logStream = null;
      }
    });
    this.logStream = stream;

    // Write startup marker for easier log navigation
    const separator = '='.repeat(60);
    const startupMarker = `\n${separator}\n` +
                          `[${new Date().toISOString()}] [OAuth:System] [INFO] 🚀 Portico STARTING\n` +
                          `${separator}\n`;
    this.writeToFile(startupMarker);

    // Write initialization message
    const initMsg = `[${new Date().toISOString()}] [OAuth:System] [INFO] OAuth logger initialized - Log file: ${this.logFile}\n`;
    this.writeToFile(initMsg);

    // Cleanup old OAuth logs (keep last 10)
    this.cleanupOldLogs();

    // Handle process exit
    process.on('exit', () => this.close());
    process.on('SIGTERM', () => this.close());
    process.on('SIGINT', () => this.close());
  }

  /**
   * Log an OAuth event
   * @param {string} layer - Source layer (MCPO, Electron, Frontend, MCP-Tools)
   * @param {string} level - Log level (INFO, WARN, ERROR, DEBUG)
   * @param {string} message - Log message
   */
  log(layer, level, message) {
    const timestamp = new Date().toISOString();
    const normalizedLayer = this.normalizeLayer(layer);
    const normalizedLevel = (level || 'INFO').toUpperCase();
    const redactedMessage = this.redactTokens(message);

    const logEntry = `[${timestamp}] [OAuth:${normalizedLayer}] [${normalizedLevel}] ${redactedMessage}\n`;

    this.writeToFile(logEntry);

    // Also log to console for development visibility
    if (!app.isPackaged) {
      console.log(`[OAuth:${normalizedLayer}] ${redactedMessage}`);
    }
  }

  /**
   * Normalize layer name to standard format
   * @param {string} layer - Input layer name
   * @returns {string} - Normalized layer name
   */
  normalizeLayer(layer) {
    const layerMap = {
      'mcpo': 'MCPO',
      'python': 'MCPO',
      'docker': 'MCPO',
      'electron': 'Electron',
      'main': 'Electron',
      'frontend': 'Frontend',
      'renderer': 'Frontend',
      'browser': 'Frontend',
      'mcp-tools': 'MCP-Tools',
      'mcp': 'MCP-Tools',
      'mcp-assistant': 'MCP-Tools',
      'system': 'System'
    };

    const normalized = layerMap[(layer || 'unknown').toLowerCase()];
    return normalized || layer || 'Unknown';
  }

  /**
   * Redact sensitive OAuth tokens and secrets from log messages
   * @param {string} message - Input message
   * @returns {string} - Message with redacted tokens
   */
  redactTokens(message) {
    if (typeof message !== 'string') {
      try {
        message = JSON.stringify(message, null, 2);
      } catch (e) {
        message = String(message);
      }
    }

    // Patterns to redact (common OAuth token patterns)
    const patterns = [
      // Access tokens (various formats)
      { regex: /(access_token["']?\s*[:=]\s*["']?)([a-zA-Z0-9_\-\.]+)/gi, replacement: '$1[REDACTED]' },
      { regex: /(Bearer\s+)([a-zA-Z0-9_\-\.]+)/gi, replacement: '$1[REDACTED]' },

      // Refresh tokens
      { regex: /(refresh_token["']?\s*[:=]\s*["']?)([a-zA-Z0-9_\-\.\/\+]+)/gi, replacement: '$1[REDACTED]' },

      // Authorization codes
      { regex: /(code["']?\s*[:=]\s*["']?)([a-zA-Z0-9_\-\.\/\+]{20,})/gi, replacement: '$1[REDACTED]' },
      { regex: /([?&]code=)([^&\s"'`]+)/gi, replacement: '$1[REDACTED]' },

      // Client secrets
      { regex: /(client_secret["']?\s*[:=]\s*["']?)([a-zA-Z0-9_\-\.]+)/gi, replacement: '$1[REDACTED]' },

      // PKCE code verifiers (keep first 8 chars for debugging)
      { regex: /(code_verifier["']?\s*[:=]\s*["']?)([a-zA-Z0-9_\-]{8})([a-zA-Z0-9_\-]+)/gi, replacement: '$1$2...[REDACTED]' },

      // JWT tokens (keep header visible, redact payload and signature)
      { regex: /(eyJ[a-zA-Z0-9_\-]+)\.(eyJ[a-zA-Z0-9_\-]+)\.([a-zA-Z0-9_\-]+)/gi, replacement: '$1.[PAYLOAD].[SIGNATURE]' },

      // State is a bearer-style CSRF correlation value; never retain a prefix.
      { regex: /([?&]state=)([^&\s"'`]+)/gi, replacement: '$1[REDACTED]' },
      { regex: /(state["']?\s*[:=]\s*["']?)([^"'\s,&}]+)/gi, replacement: '$1[REDACTED]' },
    ];

    let redacted = message;
    for (const { regex, replacement } of patterns) {
      redacted = redacted.replace(regex, replacement);
    }

    return redacted;
  }

  /**
   * Write message to log file
   * @param {string} message - Formatted log message
   */
  writeToFile(message) {
    const stream = this.logStream;
    if (!stream || !stream.writable) {
      return;
    }

    try {
      stream.write(message);
    } catch {
      if (this.logStream === stream) {
        this.logStream = null;
      }
    }
  }

  /**
   * Cleanup old OAuth log files, keeping the most recent 10
   */
  cleanupOldLogs() {
    try {
      const files = fs.readdirSync(this.logDir)
        .filter(f => f.startsWith('oauth-') && f.endsWith('.log'))
        .map(f => ({
          name: f,
          path: path.join(this.logDir, f),
          mtime: fs.statSync(path.join(this.logDir, f)).mtime
        }))
        .sort((a, b) => b.mtime - a.mtime); // Most recent first

      // Keep the 10 most recent files, delete the rest
      const toDelete = files.slice(10);
      for (const file of toDelete) {
        try {
          fs.unlinkSync(file.path);
          console.log(`[OAuth:System] Deleted old OAuth log: ${file.name}`);
        } catch (e) {
          console.warn(`[OAuth:System] Failed to delete old OAuth log ${file.name}:`, e.message);
        }
      }

      if (toDelete.length > 0) {
        this.log('System', 'INFO', `Cleaned up ${toDelete.length} old OAuth log file(s)`);
      }
    } catch (e) {
      console.warn('[OAuth:System] Failed to cleanup old OAuth logs:', e.message);
    }
  }

  /**
   * Get the current OAuth log file path
   * @returns {string} - Path to current log file
   */
  getLogPath() {
    return this.logFile;
  }

  /**
   * Get the OAuth logs directory
   * @returns {string} - Path to logs directory
   */
  getLogDir() {
    return this.logDir;
  }

  /**
   * Close the log stream gracefully
   */
  close() {
    if (this.logStream) {
      const closeMsg = `[${new Date().toISOString()}] [OAuth:System] [INFO] OAuth logger shutting down\n`;
      try {
        this.logStream.write(closeMsg);
        this.logStream.end();
      } catch (e) {
        // Ignore errors during shutdown
      }
      this.logStream = null;
    }
  }
}

// Singleton instance
let oauthLoggerInstance = null;

/**
 * Initialize the OAuth logger singleton
 * @returns {OAuthLogger} - The OAuth logger instance
 */
function initOAuthLogger() {
  if (!oauthLoggerInstance) {
    oauthLoggerInstance = new OAuthLogger();
  }
  return oauthLoggerInstance;
}

/**
 * Get the OAuth logger instance (must be initialized first)
 * @returns {OAuthLogger|null} - The OAuth logger instance or null
 */
function getOAuthLogger() {
  return oauthLoggerInstance;
}

/**
 * Log an OAuth event (convenience function)
 * @param {string} layer - Source layer
 * @param {string} level - Log level
 * @param {string} message - Log message
 */
function logOAuth(layer, level, message) {
  if (oauthLoggerInstance) {
    oauthLoggerInstance.log(layer, level, message);
  } else {
    // Fallback to console if logger not initialized
    console.log(`[OAuth:${layer}] [${level}] ${message}`);
  }
}

/**
 * Get the OAuth log file path
 * @returns {string|null} - Path to current log file or null
 */
function getOAuthLogPath() {
  return oauthLoggerInstance ? oauthLoggerInstance.getLogPath() : null;
}

module.exports = {
  initOAuthLogger,
  getOAuthLogger,
  logOAuth,
  getOAuthLogPath
};
