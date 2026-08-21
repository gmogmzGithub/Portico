// diagnostic-collector.js - On-demand diagnostic snapshot collector
// Assembles a structured JSON snapshot of Docker, MCP, system, and app-log state
// when called. One-shot only — no background work, no timers, no event listeners.
//
// Architecture layers: Observability (primary), Docker Orchestration, MCP Orchestration
//
// Used by: ipc.js (collect-diagnostic-snapshot handler)
// Called by: renderer on button press (Phase 1 feedback dialog)

'use strict';

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const state = require('./shared-state');
const { getLastHealthStatus, listMcpoServers } = require('./docker-mcp');

// ============================================================================
// SECTION COLLECTORS
// ============================================================================

/**
 * Collect system-level information.
 * All fields are safe synchronous reads — no external processes except docker version.
 */
function collectSystemInfo() {
  let docker_version = 'unavailable';
  try {
    docker_version = execSync("docker version --format '{{.Server.Version}}'", {
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (_err) {
    // Docker unreachable or not installed — leave as 'unavailable'
  }

  return {
    platform: process.platform,
    os_version: os.release(),
    node_version: process.version,
    arch: process.arch,
    docker_version,
    electron_version: process.versions.electron || 'unknown',
  };
}

/**
 * Collect Docker container states from shared-state (no new Docker calls for state)
 * and last-50-lines logs per container via execSync.
 *
 * If Docker is unreachable the section degrades gracefully:
 *   - containers: list of containers from shared-state (may be stale)
 *   - logs: {} (empty — Docker not reachable for log fetch)
 *   - error: error message string
 */
function collectDockerInfo() {
  const result = {
    containers: [],
    logs: {},
    error: null,
  };

  // Read container states from in-memory shared state — no Docker probe
  try {
    const containers = state.dockerStatus.containers || {};
    for (const [name, info] of Object.entries(containers)) {
      result.containers.push({
        name,
        state: info.state || info.status || 'unknown',
        restart_count: info.restart_count != null ? info.restart_count : null,
        status_detail: info.status_detail || info.detail || null,
      });
    }
  } catch (err) {
    result.error = `Failed to read container states from shared-state: ${err.message}`;
  }

  // Fetch last 50 lines of logs per container — sequential execSync, one-shot
  for (const container of result.containers) {
    try {
      const logs = execSync(`docker logs --tail 50 ${container.name} 2>&1`, {
        timeout: 8000,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      result.logs[container.name] = logs;
    } catch (err) {
      if (!result.error) {
        // Only set top-level error on first Docker-unreachable signal
        // Check if it looks like a connectivity failure vs a container issue
        const msg = err.message || '';
        if (
          msg.includes('Cannot connect to the Docker daemon') ||
          msg.includes('Error response from daemon') ||
          msg.includes('No such container')
        ) {
          result.logs[container.name] = `[log unavailable: ${err.stderr || err.message}]`;
        } else {
          result.logs[container.name] = `[log unavailable: ${err.message}]`;
        }
      } else {
        result.logs[container.name] = `[log unavailable: ${err.message}]`;
      }
    }
  }

  // If no containers known yet, note it (not an error — may be pre-startup)
  if (result.containers.length === 0 && !result.error) {
    result.error = null; // Deliberate: empty containers list is valid, not an error
  }

  return result;
}

/**
 * Collect MCP health status and server list.
 * Uses cached data only — does not trigger a new health check.
 */
async function collectMcpInfo() {
  const result = {
    health_status: null,
    servers: [],
    error: null,
  };

  try {
    result.health_status = getLastHealthStatus();
  } catch (err) {
    result.error = `Failed to get last health status: ${err.message}`;
  }

  try {
    const serverList = await listMcpoServers();
    const healthStatus = result.health_status;

    for (const server of serverList) {
      const serverId = server.serverId || server.id || '';
      // Try to pull oauth_state from health status if available
      let oauth_state = null;
      if (healthStatus && healthStatus.servers) {
        const serverHealth = healthStatus.servers[serverId] || healthStatus.servers[server.containerName];
        if (serverHealth) {
          oauth_state = serverHealth.oauth_state || serverHealth.oauthState || null;
        }
      }

      result.servers.push({
        id: serverId,
        status: server.status || 'unknown',
        oauth_state,
      });
    }
  } catch (err) {
    const errMsg = `Failed to list MCP servers: ${err.message}`;
    result.error = result.error ? `${result.error}; ${errMsg}` : errMsg;
  }

  return result;
}

/**
 * Collect last 200 lines each from the most recent app-*.log and error-*.log files.
 * Uses fs.readFileSync — safe for one-shot diagnostic use.
 */
function collectAppLogs() {
  const result = {
    app_log: '',
    error_log: '',
    error: null,
  };

  try {
    const logDir = path.join(app.getPath('userData'), 'logs');

    const readLastNLines = (filePath, n) => {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        return lines.slice(-n).join('\n');
      } catch (err) {
        return `[unreadable: ${err.message}]`;
      }
    };

    const getMostRecent = (pattern) => {
      try {
        const files = fs.readdirSync(logDir)
          .filter(f => {
            // Match pattern like 'app-' or 'error-'
            return f.startsWith(pattern) && f.endsWith('.log');
          })
          .sort()
          .reverse(); // Descending — most recent first
        return files.length > 0 ? path.join(logDir, files[0]) : null;
      } catch (_err) {
        return null;
      }
    };

    const appLogPath = getMostRecent('app-');
    result.app_log = appLogPath
      ? readLastNLines(appLogPath, 200)
      : '[no app log found]';

    const errorLogPath = getMostRecent('error-');
    result.error_log = errorLogPath
      ? readLastNLines(errorLogPath, 200)
      : '[no error log found]';
  } catch (err) {
    result.error = `Failed to collect app logs: ${err.message}`;
    result.app_log = result.app_log || '';
    result.error_log = result.error_log || '';
  }

  return result;
}

// ============================================================================
// MAIN EXPORT
// ============================================================================

/**
 * Assemble a complete diagnostic snapshot.
 *
 * Each top-level section is wrapped in an independent try/catch so a failure
 * in one section does not prevent the others from collecting.
 *
 * Performance: one-shot only, called on button press. No background work.
 *
 * @returns {Promise<object>} Structured diagnostic snapshot
 */
async function collectDiagnosticSnapshot() {
  const snapshot = {
    collected_at: new Date().toISOString(),
    portico_version: (() => {
      try { return app.getVersion(); } catch (_e) { return 'unknown'; }
    })(),
    system: null,
    docker: null,
    mcp: null,
    app_logs: null,
  };

  // Each section collected independently — failure in one does not block others
  try {
    snapshot.system = collectSystemInfo();
  } catch (err) {
    snapshot.system = { error: `System info collection failed: ${err.message}` };
  }

  try {
    snapshot.docker = collectDockerInfo();
  } catch (err) {
    snapshot.docker = { containers: [], logs: {}, error: `Docker info collection failed: ${err.message}` };
  }

  try {
    snapshot.mcp = await collectMcpInfo();
  } catch (err) {
    snapshot.mcp = { health_status: null, servers: [], error: `MCP info collection failed: ${err.message}` };
  }

  try {
    snapshot.app_logs = collectAppLogs();
  } catch (err) {
    snapshot.app_logs = { app_log: '', error_log: '', error: `App log collection failed: ${err.message}` };
  }

  return snapshot;
}

module.exports = { collectDiagnosticSnapshot };
