const fs = require("node:fs");
const fsPromises = fs.promises;
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const { computeMcpToggleRevision } = require("./mcp-toggle-store");

function buildHealthSummary(servers = {}) {
  const summary = {
    total: 0,
    healthy: 0,
    starting: 0,
    checking: 0,
    failed: 0,
    needs_oauth: 0,
    not_configured: 0,
    disabled: 0,
    timeout: 0,
    unknown: 0,
  };
  for (const value of Object.values(servers)) {
    if (!value || typeof value !== "object") continue;
    summary.total += 1;
    const status = String(
      value.status || value.readiness_phase || "unknown",
    ).toLowerCase();
    if (Object.prototype.hasOwnProperty.call(summary, status)) {
      summary[status] += 1;
    } else if (status === "tool_ready") {
      summary.healthy += 1;
    } else {
      summary.unknown += 1;
    }
  }
  return summary;
}

function getPort(deploymentType) {
  if (deploymentType === "host") return 8890;
  if (deploymentType === "core") return 8766;
  return 8765;
}

const HEALTH_STATUS_LOCK_STALE_MS = 30_000;
const HEALTH_STATUS_LOCK_TIMEOUT_MS = 5_000;
const HEALTH_STATUS_FLOCK_LOCK_GRACE_MS = 2_000;
const OPERATION_PUBLICATION_MARKER = "mcp_operation_publication.json";

// EPERM (a pid owned by another user) counts as alive; only ESRCH is dead.
function isLockOwnerAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function acquireHealthStatusWriteLock(lockPath, options = {}) {
  const staleMs = options.staleMs ?? HEALTH_STATUS_LOCK_STALE_MS;
  const timeoutMs = options.timeoutMs ?? HEALTH_STATUS_LOCK_TIMEOUT_MS;
  const retryMs = options.retryMs ?? 25;
  const flockGraceMs = options.flockGraceMs ?? HEALTH_STATUS_FLOCK_LOCK_GRACE_MS;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      await fsPromises.writeFile(lockPath, `${process.pid} ${Date.now()}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await fsPromises.rm(lockPath, { force: true });
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const stat = await fsPromises.stat(lockPath);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs > staleMs) {
          await fsPromises.rm(lockPath, { force: true });
          continue;
        }
        if (stat.size === 0) {
          // The Rust health-check writer flocks this same path and its
          // leftover lock file is always EMPTY (it never writes content and
          // never unlinks on older builds). Rust holds the flock only for
          // milliseconds, so existence does not mean held; the grace period
          // avoids stealing an actively-held flock.
          if (ageMs > flockGraceMs) {
            await fsPromises.rm(lockPath, { force: true });
            continue;
          }
        } else {
          const content = await fsPromises.readFile(lockPath, "utf8");
          const pidMatch = /^(\d+)\s/.exec(content);
          if (!pidMatch) {
            // Unrecognized content: treat like a flock-style leftover and
            // reclaim only after the grace period.
            if (ageMs > flockGraceMs) {
              await fsPromises.rm(lockPath, { force: true });
              continue;
            }
          } else {
            const ownerPid = Number(pidMatch[1]);
            if (ownerPid !== process.pid && !isLockOwnerAlive(ownerPid)) {
              // The Node writer that created this lock is gone; reclaim now.
              await fsPromises.rm(lockPath, { force: true });
              continue;
            }
            // Live owner (or our own pid): honor the lock up to staleMs.
          }
        }
      } catch (statError) {
        if (statError.code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() >= deadline) {
        const timeout = new Error(
          `Timed out acquiring health status write lock: ${lockPath}`,
        );
        timeout.code = "MCP_HEALTH_STATUS_LOCK_TIMEOUT";
        throw timeout;
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
}

class McpReadinessPublisher {
  constructor(options = {}) {
    if (typeof options.getProjectRoot !== "function") {
      throw new TypeError("McpReadinessPublisher requires getProjectRoot");
    }
    this.getProjectRoot = options.getProjectRoot;
    this.broadcast = options.broadcast || (() => {});
    this.logger = options.logger || console;
    this.getSequenceFloor = options.getSequenceFloor || (() => 0);
    this._queue = Promise.resolve();
    this.resetInterruptedOperationMarker();
  }

  _operationMarkerPath() {
    const projectRoot = this.getProjectRoot();
    if (!projectRoot) return null;
    return path.join(
      projectRoot,
      "health-status",
      OPERATION_PUBLICATION_MARKER,
    );
  }

  _writeOperationMarkerSync(status, operationId = null) {
    const markerPath = this._operationMarkerPath();
    if (!markerPath) return null;
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    const marker = {
      schemaVersion: 1,
      revision: randomUUID(),
      status,
      operationId,
      updatedAt: new Date().toISOString(),
    };
    const tempPath = `${markerPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(marker)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tempPath, markerPath);
    return marker;
  }

  resetInterruptedOperationMarker() {
    return this._writeOperationMarkerSync("interrupted", null);
  }

  beginOperation(operationId) {
    return this._writeOperationMarkerSync("active", operationId);
  }

  endOperation(operationId) {
    return this._writeOperationMarkerSync("completed", operationId);
  }

  publish(entries, options = {}) {
    const normalizedEntries = Array.isArray(entries) ? entries : [entries];
    const execute = () => this._publish(normalizedEntries, options);
    const pending = this._queue.then(execute, execute);
    this._queue = pending.catch(() => {});
    return pending;
  }

  async _publish(entries, options) {
    const projectRoot = this.getProjectRoot();
    if (!projectRoot) {
      throw new Error("Project root is unavailable for readiness publication");
    }
    const healthPath = path.join(projectRoot, "health-status", "health_status.json");
    const togglesPath = path.join(projectRoot, "mcp_toggles.json");
    await fsPromises.mkdir(path.dirname(healthPath), { recursive: true });
    const releaseLock = await acquireHealthStatusWriteLock(
      `${healthPath}.lock`,
    );
    try {
    let healthData = { servers: {}, summary: {}, sync: {} };
    try {
      healthData = JSON.parse(await fsPromises.readFile(healthPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    let toggles;
    try {
      const parsed = JSON.parse(await fsPromises.readFile(togglesPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("toggle map must be an object");
      }
      if (Object.values(parsed).some((value) => typeof value !== "boolean")) {
        throw new Error("toggle map values must be booleans");
      }
      toggles = Object.fromEntries(
        Object.entries(parsed).filter(([, value]) => typeof value === "boolean"),
      );
    } catch (error) {
      const failure = new Error(
        `Cannot publish readiness without valid mcp_toggles.json: ${error.message}`,
      );
      failure.code = "MCP_TOGGLES_UNAVAILABLE";
      throw failure;
    }

    const nextServers = {
      ...(healthData.servers && typeof healthData.servers === "object"
        ? healthData.servers
        : {}),
    };
    const observedAt = new Date().toISOString();
    for (const entry of entries) {
      const serverId = String(entry?.serverId || entry?.id || "").trim();
      if (!serverId) continue;
      const deploymentType = entry.deploymentType || "docker";
      const readinessPhase =
        entry.readinessPhase ||
        entry.readiness_phase ||
        entry.phase ||
        (entry.healthy ? "tool_ready" : "starting");
      const status = entry.healthy
        ? "healthy"
        : readinessPhase === "tool_ready"
          ? "healthy"
          : readinessPhase;
      const existing = { ...(nextServers[serverId] || {}) };
      // A targeted operation owns this row. Never carry failure attribution
      // from an older operation/revision into the new observation.
      delete existing.startup_failure;
      delete existing.startup_failure_source;
      delete existing.startup_failure_stage;
      delete existing.startup_failure_timestamp;
      delete existing.container_name;
      delete existing.config_path;
      const isDisabled = readinessPhase === "disabled";
      const needsOAuth = ["needs_oauth", "waiting_callback"].includes(
        readinessPhase,
      );
      const oauthState = needsOAuth
        ? entry.oauthState ||
          entry.oauth_state ||
          existing.oauth_state ||
          readinessPhase
        : readinessPhase === "tool_ready"
          ? "completed"
          : null;
      const nextServer = {
        ...existing,
        deployment: deploymentType,
        configured: entry.configured !== false,
        enabled: toggles[serverId] !== false,
        status,
        readiness_phase: readinessPhase,
        provider_readiness:
          entry.providerReadiness || entry.provider_readiness || null,
        healthy: entry.healthy === true,
        running: entry.healthy === true || entry.runtimeStarted === true,
        error: entry.error?.message || entry.error || null,
        tools_count: Number.isFinite(entry.toolsCount) ? entry.toolsCount : 0,
        host: "localhost",
        port: getPort(deploymentType),
        operation_id: options.operationId || null,
        lifecycle_session_id: entry.lifecycleSessionId || null,
        desired_revision: entry.desiredRevision ?? null,
        transition_sequence: entry.transitionSequence ?? null,
        target_enabled:
          typeof entry.targetEnabled === "boolean" ? entry.targetEnabled : null,
        source: entry.source || "mcp-operation-direct-probe",
        observed_at: observedAt,
        disabled_by_user: isDisabled,
        disabled_reason: isDisabled ? "Disabled by user" : null,
        oauth_state: oauthState,
        authorization_url_available: needsOAuth
          ? Boolean(
              entry.authorizationUrlAvailable ??
                entry.authorization_url_available ??
                existing.authorization_url_available,
            )
          : false,
      };
      if (
        (readinessPhase === "failed" || readinessPhase === "startup_failed") &&
        entry.error
      ) {
        const structuredError =
          typeof entry.error === "object"
            ? entry.error
            : { message: String(entry.error) };
        const startupFailure = {
          serverId,
          operation: options.kind || "enable",
          stage: structuredError.stage || "startup",
          error:
            structuredError.message ||
            structuredError.error ||
            "Startup failed",
          source: structuredError.source || "runtime",
          timestamp: observedAt,
          ...(entry.configPath || structuredError.configPath
            ? { configPath: entry.configPath || structuredError.configPath }
            : {}),
          ...(structuredError.code
            ? { errorCode: structuredError.code }
            : {}),
        };
        nextServer.startup_failure = startupFailure;
        nextServer.startup_failure_source = startupFailure.source;
        nextServer.startup_failure_stage = startupFailure.stage;
        nextServer.startup_failure_timestamp = startupFailure.timestamp;
        if (startupFailure.configPath) {
          nextServer.config_path = startupFailure.configPath;
        }
      }
      nextServers[serverId] = nextServer;
    }

    const sequence =
      Math.max(
        0,
        Number(healthData.sync?.sequence || healthData.sequence || 0) || 0,
        Number(this.getSequenceFloor()) || 0,
        Number(options.sequenceFloor) || 0,
      ) + 1;
    const toggleRevision = computeMcpToggleRevision(toggles);
    const next = {
      ...healthData,
      timestamp: Date.now() / 1000,
      timestamp_iso: observedAt,
      servers: nextServers,
      summary: buildHealthSummary(nextServers),
      toggle_revision: toggleRevision,
      sync: {
        ...(healthData.sync || {}),
        sequence,
        mode: "targeted-readiness",
        reason: options.reason || "mcp-operation-direct-probe",
        updated_at: observedAt,
        toggle_revision: toggleRevision,
      },
    };

    const tempPath = `${healthPath}.${process.pid}.${Date.now()}.tmp`;
    await fsPromises.writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      await fsPromises.rename(tempPath, healthPath);
    } catch (error) {
      await fsPromises.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
    await this.broadcast(next);
    return next;
    } finally {
      await releaseLock();
    }
  }
}

module.exports = {
  McpReadinessPublisher,
  acquireHealthStatusWriteLock,
  buildHealthSummary,
  getPort,
};
