const DEFAULT_READINESS_TIMEOUT_MS = 120_000;
// A measured Portico workspace cold sync takes about 7.5 minutes; 12 minutes
// leaves bounded network variance without extending unrelated integrations.
const SLACK_READINESS_TIMEOUT_MS = 12 * 60_000;
const DEFAULT_OPERATION_WAIT_TIMEOUT_MS = 5 * 60_000;
// The operation wait includes container/configuration work before polling and
// cache invalidation/finalization afterward, so it must exceed the poll budget.
const SLACK_OPERATION_WAIT_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_SLOW_POLL_INTERVAL_MS = 3_000;
const DEFAULT_FAST_POLL_DURATION_MS = 30_000;
const DEFAULT_CONCURRENCY = 6;
const TERMINAL_ATTENTION_PHASES = new Set([
  "needs_oauth",
  "waiting_callback",
  "not_configured",
]);
const TERMINAL_FAILURE_PHASES = new Set(["failed", "timeout"]);
const EXPLICIT_PROVIDER_NONREADY_STATES = new Set([
  "starting",
  "unsupported",
  "probe_failed",
]);
// A server whose aggregator route keeps returning 5xx with no callable tools is
// almost certainly a dead upstream (e.g. the stdio child crashed at init). A
// crash-looping child alternates 5xx with probe timeouts (each probe triggers a
// lazy respawn attempt that can outlast the probe's request timeout), so
// timeouts extend the streak — but at least FATAL_STARTUP_MIN_5XX hard 5xx
// results are required, keeping merely-slow starters (pure timeouts) exempt.
// The streak + elapsed floors and the log classifier guard false positives.
const FATAL_STARTUP_PROBE_STREAK = 8;
const FATAL_STARTUP_MIN_5XX = 3;
const FATAL_STARTUP_MIN_ELAPSED_MS = 20_000;
const FATAL_STARTUP_VERDICTS = new Set(["auth", "config", "crash_loop"]);

function providerReadinessState(result) {
  return String(
    result?.providerReadiness || result?.provider_readiness || "",
  ).toLowerCase();
}

function hasExplicitProviderNonreadyState(result) {
  return EXPLICIT_PROVIDER_NONREADY_STATES.has(providerReadinessState(result));
}

function readinessTimeoutMsForServer(serverId, fallbackMs = DEFAULT_READINESS_TIMEOUT_MS) {
  return String(serverId || "").trim().toLowerCase() === "slack"
    ? SLACK_READINESS_TIMEOUT_MS
    : fallbackMs;
}

function operationWaitTimeoutMs(
  operation,
  fallbackMs = DEFAULT_OPERATION_WAIT_TIMEOUT_MS,
) {
  const rows = Array.isArray(operation?.rows)
    ? operation.rows
    : Array.isArray(operation?.servers)
      ? operation.servers
      : [];
  const serverIds = [
    ...(Array.isArray(operation?.serverIds) ? operation.serverIds : []),
    ...rows.map((row) => row?.serverId || row?.id),
  ];
  return serverIds.some(
    (serverId) => String(serverId || "").trim().toLowerCase() === "slack",
  )
    ? SLACK_OPERATION_WAIT_TIMEOUT_MS
    : fallbackMs;
}

function isFatalStartupProbe(result) {
  if (hasExplicitProviderNonreadyState(result)) return false;
  const error = String(result?.error || "");
  if (/^http_5\d\d$/.test(error)) {
    return (result.tools_count ?? result.toolsCount ?? 0) === 0;
  }
  return /^tool_probe_http_5\d\d$/.test(error);
}

function isStartupStallProbe(result) {
  if (hasExplicitProviderNonreadyState(result)) return false;
  if (isFatalStartupProbe(result)) return true;
  return (
    String(result?.error || "") === "request_timeout" &&
    (result.tools_count ?? result.toolsCount ?? 0) === 0
  );
}

function humanizeStartupFailureDetail(verdict, probeError) {
  const httpMatch = /^(?:tool_probe_)?http_(\d{3})$/.exec(String(probeError || ""));
  const runtimePart = httpMatch
    ? `The runtime kept returning HTTP ${httpMatch[1]} while starting.`
    : "The server never became ready.";
  const verdictPart =
    verdict === "auth"
      ? "Logs indicate a credential error (rejected token or failed authentication) — fix the credential and re-enable."
      : verdict === "config"
        ? "Logs indicate a configuration error — review the server's configuration."
        : "The server appears to be crash-looping.";
  // Verdict first: it is the clause the user needs even when the row clips.
  return `Failed to start. ${verdictPart} ${runtimePart} Check the server logs for details.`;
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "");
}

function getReadinessPlanePort(deploymentType) {
  if (deploymentType === "core") return 8766;
  if (deploymentType === "host") return 8890;
  return 8765;
}

function extractCallableToolPaths(openApiSpec) {
  return Object.entries(openApiSpec?.paths || {}).flatMap(([pathKey, pathItem]) => {
    const normalized = pathKey.toLowerCase();
    const isToolPath =
      normalized !== "/openapi.json" &&
      normalized !== "openapi.json" &&
      !normalized.includes("/oauth") &&
      !normalized.endsWith("/docs");
    return isToolPath && pathItem?.post && typeof pathItem.post === "object"
      ? [pathKey]
      : [];
  });
}

async function probeActionRequiredState({
  readinessBaseUrl,
  serverId,
  fetchImpl,
  signal,
}) {
  try {
    const response = await fetchImpl(
      `${readinessBaseUrl}/servers/${encodeURIComponent(serverId)}/status`,
      { signal },
    );
    if (!response.ok) return null;
    const status = await response.json();
    const readinessPhase =
      status.readiness_phase || status.readinessPhase || status.status;
    const providerReadiness =
      status.provider_readiness || status.providerReadiness || null;
    const requiresAttention = TERMINAL_ATTENTION_PHASES.has(readinessPhase);
    const providerIsNonready = EXPLICIT_PROVIDER_NONREADY_STATES.has(
      String(providerReadiness || "").toLowerCase(),
    );
    if (!requiresAttention && !providerIsNonready) return null;
    return {
      ...status,
      serverId,
      ready: requiresAttention,
      healthy: false,
      readinessPhase: requiresAttention ? readinessPhase : "starting",
      providerReadiness,
      error: null,
    };
  } catch (_error) {
    return null;
  }
}

async function probeMcpServerReadiness(options = {}) {
  const serverId = String(options.serverId || "").trim();
  const readinessBaseUrl = normalizeBaseUrl(
    options.readinessBaseUrl ||
      options.aggregatorBaseUrl ||
      `http://127.0.0.1:${getReadinessPlanePort(options.deploymentType)}`,
  );
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!serverId || !readinessBaseUrl) {
    return {
      serverId,
      ready: false,
      healthy: false,
      readinessPhase: "starting",
      error: "aggregator_unavailable",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.requestTimeoutMs || 5_000,
  );
  try {
    const serverBaseUrl = `${readinessBaseUrl}/${encodeURIComponent(serverId)}`;
    const response = await fetchImpl(
      `${serverBaseUrl}/openapi.json`,
      { signal: controller.signal },
    );
    if (!response.ok) {
      const actionRequired = await probeActionRequiredState({
        readinessBaseUrl,
        serverId,
        fetchImpl,
        signal: controller.signal,
      });
      if (actionRequired) {
        return {
          ...actionRequired,
          error: hasExplicitProviderNonreadyState(actionRequired)
            ? response.status === 404
              ? "not_discovered"
              : `http_${response.status}`
            : actionRequired.error,
        };
      }
      return {
        serverId,
        ready: false,
        healthy: false,
        readinessPhase: "starting",
        error:
          response.status === 404 ? "not_discovered" : `http_${response.status}`,
      };
    }
    const openApiSpec = await response.json();
    const callableToolPaths = extractCallableToolPaths(openApiSpec);
    if (callableToolPaths.length === 0) {
      const hasOAuthRoutes = Object.keys(openApiSpec?.paths || {}).some((pathKey) =>
        pathKey.toLowerCase().includes("/oauth"),
      );
      if (!hasOAuthRoutes) {
        const actionRequired = await probeActionRequiredState({
          readinessBaseUrl,
          serverId,
          fetchImpl,
          signal: controller.signal,
        });
        if (actionRequired) return actionRequired;
      }
      return {
        serverId,
        ready: hasOAuthRoutes,
        healthy: false,
        readinessPhase: hasOAuthRoutes ? "needs_oauth" : "starting",
        toolsCount: 0,
        totalPaths: Object.keys(openApiSpec?.paths || {}).length,
        error: hasOAuthRoutes ? null : "no_callable_tool_paths",
      };
    }

    const probePath = callableToolPaths[0].replace(/^\/+/, "");
    const probeResponse = await fetchImpl(`${serverBaseUrl}/${probePath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Deliberately malformed JSON proves the route exists without invoking a
      // tool implementation or constructing tool-specific arguments.
      body: "{",
      signal: controller.signal,
    });
    const actionRequired = await probeActionRequiredState({
      readinessBaseUrl,
      serverId,
      fetchImpl,
      signal: controller.signal,
    });
    if (actionRequired) {
      return {
        ...actionRequired,
        toolsCount: callableToolPaths.length,
        totalPaths: Object.keys(openApiSpec?.paths || {}).length,
        probeStatus: probeResponse.status,
        error: hasExplicitProviderNonreadyState(actionRequired)
          ? `tool_probe_http_${probeResponse.status}`
          : actionRequired.error,
      };
    }
    const probeReady =
      probeResponse.status !== 401 &&
      probeResponse.status !== 403 &&
      probeResponse.status !== 404 &&
      probeResponse.status < 500;
    return {
      serverId,
      healthy: probeReady,
      ready: probeReady,
      readinessPhase: probeReady ? "tool_ready" : "starting",
      toolsCount: callableToolPaths.length,
      totalPaths: Object.keys(openApiSpec?.paths || {}).length,
      toolName: probePath.split("/").filter(Boolean)[0] || probePath,
      probeStatus: probeResponse.status,
      error: probeReady ? null : `tool_probe_http_${probeResponse.status}`,
    };
  } catch (error) {
    return {
      serverId,
      ready: false,
      healthy: false,
      readinessPhase: "starting",
      error: error.name === "AbortError" ? "request_timeout" : error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

function classifyProbeResult(result) {
  const phase = result.readinessPhase || result.readiness_phase || "starting";
  if (
    !hasExplicitProviderNonreadyState(result) &&
    (result.healthy || phase === "tool_ready")
  ) {
    return {
      terminal: true,
      status: "succeeded",
      phase: "tool_ready",
      outcome: "tool_ready",
      healthy: true,
      success: true,
    };
  }
  if (TERMINAL_ATTENTION_PHASES.has(phase)) {
    return {
      terminal: true,
      status: "attention_required",
      phase,
      outcome: phase,
      healthy: false,
      success: true,
      requiredAction:
        phase === "not_configured" ? "configure" : "authenticate",
    };
  }
  if (TERMINAL_FAILURE_PHASES.has(phase)) {
    return {
      terminal: true,
      status: phase === "timeout" ? "timed_out" : "failed",
      phase,
      outcome: phase === "timeout" ? "timed_out" : "failed",
      healthy: false,
      success: false,
    };
  }
  return {
    terminal: false,
    status: "running",
    phase,
    outcome: null,
    healthy: false,
    success: null,
  };
}

class McpReadinessScheduler {
  constructor(options = {}) {
    if (!options.operationManager) {
      throw new TypeError("McpReadinessScheduler requires operationManager");
    }
    this.operationManager = options.operationManager;
    this.probe = options.probe || probeMcpServerReadiness;
    this.concurrency = options.concurrency || DEFAULT_CONCURRENCY;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.slowPollIntervalMs =
      options.slowPollIntervalMs ?? DEFAULT_SLOW_POLL_INTERVAL_MS;
    this.fastPollDurationMs =
      options.fastPollDurationMs ?? DEFAULT_FAST_POLL_DURATION_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    this.useServerDefaultTimeouts = options.timeoutMs === undefined;
    this.beforePolling = options.beforePolling || null;
    this.onReadyBatch = options.onReadyBatch || null;
    this.publishReadiness = options.publishReadiness || null;
    this.classifyStartupFailure = options.classifyStartupFailure || null;
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now || (() => Date.now());
  }

  async timeoutTarget(operationId, target) {
    const timeoutMs = target.readinessTimeoutMs;
    // With the progress-anchored budget, reaching here means a full budget
    // elapsed with NO advancement — say so, with the last known position,
    // instead of the generic "may have failed to start".
    const warmup = target.lastWarmup;
    const timeoutMessage = warmup?.items_fetched
      ? `No sync progress for ${Math.round(timeoutMs / 60000)} minutes — stalled at ${Number(warmup.items_fetched).toLocaleString("en-US")} ${warmup.phase === "channels" ? "channels" : "users"}; check its logs`
      : `Readiness timed out after ${timeoutMs}ms`;
    if (this.publishReadiness) {
      const snapshot = this.operationManager.getMcpOperation(operationId);
      const currentRow = snapshot?.servers?.find(
        (entry) => entry.serverId === target.serverId,
      );
      await this.publishReadiness({
        serverId: target.serverId,
        deploymentType: target.deploymentType,
        readinessPhase: "timeout",
        healthy: false,
        error: timeoutMessage,
        operationId,
        lifecycleSessionId: snapshot?.lifecycleSessionId,
        desiredRevision: snapshot?.desiredRevision,
        transitionSequence: (currentRow?.sequence || 0) + 1,
        operationStatus: snapshot?.status,
        targetEnabled: snapshot?.targetEnabled,
      });
    }
    this.operationManager.updateServer(operationId, target.serverId, {
      status: "timed_out",
      phase: "timeout",
      outcome: "timed_out",
      healthy: false,
      success: false,
      terminal: true,
      progressPercent: 100,
      error: timeoutMessage,
    });
  }

  async run(operationId, targets = []) {
    const operation = this.operationManager.getMcpOperation(operationId);
    if (!operation) {
      throw new Error(`MCP operation ${operationId} not found`);
    }
    const pending = new Map(
      targets.map((target) => {
        const normalized =
          typeof target === "string" ? { serverId: target } : { ...target };
        const explicitTimeoutMs = Number(normalized.readinessTimeoutMs);
        normalized.readinessTimeoutMs = Number.isFinite(explicitTimeoutMs)
          ? Math.max(1, explicitTimeoutMs)
          : this.useServerDefaultTimeouts
            ? readinessTimeoutMsForServer(normalized.serverId, this.timeoutMs)
            : this.timeoutMs;
        return [normalized.serverId, normalized];
      }),
    );
    const startedAt = this.now();
    const readyBatch = new Set();
    const fatalStreaks = new Map();
    const fatalClassifyAttempted = new Set();
    for (const target of pending.values()) {
      // The readiness budget measures from the last OBSERVED PROGRESS, not
      // from operation start: a provider mid-directory-build under Slack
      // rate limiting can legitimately take far longer than any fixed
      // budget, and declaring it "timed out / may have failed to start"
      // while its item counts advance is a lie to the user (2026-08-03
      // incident). A genuinely wedged provider stops advancing and still
      // times out after one full budget of silence.
      target.lastProgressAt = startedAt;
      target.lastProgressMarker = null;
      target.lastWarmup = null;
    }

    if (this.beforePolling) {
      await this.beforePolling({ operationId, targets: [...pending.values()] });
    }
    this.operationManager.markOperationRunning(operationId);

    while (pending.size > 0) {
      for (const target of [...pending.values()]) {
        if (!this.operationManager.ownsServer(operationId, target.serverId)) {
          pending.delete(target.serverId);
          continue;
        }
        const budgetAnchor = Math.max(startedAt, target.lastProgressAt || 0);
        if (this.now() - budgetAnchor >= target.readinessTimeoutMs) {
          await this.timeoutTarget(operationId, target);
          pending.delete(target.serverId);
        }
      }
      if (pending.size === 0) break;
      const roundTargets = [...pending.values()];

      const results = await mapWithConcurrency(
        roundTargets,
        this.concurrency,
        async (target) => ({
          target,
          result: await this.probe(target),
        }),
      );
      for (const { target, result } of results) {
        const classification = classifyProbeResult(result);
        if (!classification.terminal) {
          const previous = fatalStreaks.get(target.serverId);
          const isFatal = isFatalStartupProbe(result);
          const streak = isStartupStallProbe(result)
            ? {
                total: (previous?.total || 0) + 1,
                fatal: (previous?.fatal || 0) + (isFatal ? 1 : 0),
                lastFatalError: isFatal
                  ? result.error
                  : previous?.lastFatalError || null,
              }
            : { total: 0, fatal: 0, lastFatalError: null };
          fatalStreaks.set(target.serverId, streak);
          if (
            streak.total >= FATAL_STARTUP_PROBE_STREAK &&
            streak.fatal >= FATAL_STARTUP_MIN_5XX &&
            this.now() - startedAt >= FATAL_STARTUP_MIN_ELAPSED_MS &&
            this.classifyStartupFailure &&
            !fatalClassifyAttempted.has(target.serverId)
          ) {
            fatalClassifyAttempted.add(target.serverId);
            const probeError = streak.lastFatalError || result.error || null;
            let verdict = null;
            try {
              verdict = await this.classifyStartupFailure({
                serverId: target.serverId,
                deploymentType: target.deploymentType,
                error: probeError,
              });
            } catch (_error) {
              verdict = null;
            }
            if (FATAL_STARTUP_VERDICTS.has(verdict)) {
              const failureDetail = humanizeStartupFailureDetail(
                verdict,
                probeError,
              );
              if (this.publishReadiness) {
                const snapshot = this.operationManager.getMcpOperation(operationId);
                const currentRow = snapshot?.servers?.find(
                  (entry) => entry.serverId === target.serverId,
                );
                await this.publishReadiness({
                  serverId: target.serverId,
                  deploymentType: target.deploymentType,
                  readinessPhase: "startup_failed",
                  healthy: false,
                  error: failureDetail,
                  startupFailureKind: verdict,
                  operationId,
                  lifecycleSessionId: snapshot?.lifecycleSessionId,
                  desiredRevision: snapshot?.desiredRevision,
                  transitionSequence: (currentRow?.sequence || 0) + 1,
                  operationStatus: snapshot?.status,
                  targetEnabled: snapshot?.targetEnabled,
                });
              }
              this.operationManager.updateServer(operationId, target.serverId, {
                status: "failed",
                phase: "startup_failed",
                outcome: "failed",
                healthy: false,
                success: false,
                terminal: true,
                progressPercent: 100,
                error: failureDetail,
              });
              pending.delete(target.serverId);
              continue;
            }
          }
        }
        if (classification.terminal && this.publishReadiness) {
          const snapshot = this.operationManager.getMcpOperation(operationId);
          const currentRow = snapshot?.servers?.find(
            (entry) => entry.serverId === target.serverId,
          );
          await this.publishReadiness({
            ...result,
            ...classification,
            serverId: target.serverId,
            deploymentType: target.deploymentType,
            readinessPhase: classification.phase,
            operationId,
            lifecycleSessionId: snapshot?.lifecycleSessionId,
            desiredRevision: snapshot?.desiredRevision,
            transitionSequence: (currentRow?.sequence || 0) + 1,
            operationStatus: snapshot?.status,
            targetEnabled: snapshot?.targetEnabled,
            requiredAction: classification.requiredAction || null,
          });
        }
        const providerWarmup =
          result.provider_warmup ?? result.providerWarmup ?? null;
        if (providerWarmup && typeof providerWarmup === "object") {
          const progressMarker = `${providerWarmup.phase || ""}:${providerWarmup.items_fetched ?? ""}:${providerWarmup.progress_percent ?? ""}`;
          if (progressMarker !== target.lastProgressMarker) {
            target.lastProgressMarker = progressMarker;
            target.lastProgressAt = this.now();
          }
          target.lastWarmup = providerWarmup;
        }
        const update = this.operationManager.updateServer(
          operationId,
          target.serverId,
          {
            ...classification,
            ...(classification.terminal ? { progressPercent: 100 } : {}),
            error: result.error || null,
            toolsCount: result.tools_count ?? result.toolsCount,
            probeStatus: result.proxy_probe_status ?? result.probeStatus,
            providerReadiness:
              result.provider_readiness ?? result.providerReadiness ?? null,
            providerWarmup,
          },
        );
        if (!update.accepted) {
          pending.delete(target.serverId);
          continue;
        }
        if (classification.terminal) {
          pending.delete(target.serverId);
          if (classification.status === "succeeded") {
            readyBatch.add(target.serverId);
          }
        }
      }

      if (readyBatch.size > 0 && this.onReadyBatch) {
        const serverIds = [...readyBatch];
        readyBatch.clear();
        await this.onReadyBatch({ operationId, serverIds });
      }
      if (pending.size > 0) {
        const elapsedMs = this.now() - startedAt;
        const pollDelayMs =
          elapsedMs < this.fastPollDurationMs
            ? this.pollIntervalMs
            : this.slowPollIntervalMs;
        // Deadlines are anchored to each target's last observed progress
        // (same anchor as the timeout check above); measuring from
        // operation start here would go negative once progress extends a
        // budget and pin the loop to zero-length sleeps.
        const nextDeadlineMs = Math.min(
          ...[...pending.values()].map((target) => {
            const anchor = Math.max(startedAt, target.lastProgressAt || 0);
            return target.readinessTimeoutMs - (this.now() - anchor);
          }),
        );
        await this.sleep(
          Math.max(1, Math.min(pollDelayMs, Math.max(1, nextDeadlineMs))),
        );
      }
    }
    return this.operationManager.getMcpOperation(operationId);
  }
}

module.exports = {
  DEFAULT_CONCURRENCY,
  DEFAULT_FAST_POLL_DURATION_MS,
  DEFAULT_OPERATION_WAIT_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_READINESS_TIMEOUT_MS,
  DEFAULT_SLOW_POLL_INTERVAL_MS,
  SLACK_OPERATION_WAIT_TIMEOUT_MS,
  SLACK_READINESS_TIMEOUT_MS,
  FATAL_STARTUP_MIN_5XX,
  FATAL_STARTUP_MIN_ELAPSED_MS,
  FATAL_STARTUP_PROBE_STREAK,
  McpReadinessScheduler,
  classifyProbeResult,
  extractCallableToolPaths,
  getReadinessPlanePort,
  hasExplicitProviderNonreadyState,
  humanizeStartupFailureDetail,
  isFatalStartupProbe,
  isStartupStallProbe,
  mapWithConcurrency,
  operationWaitTimeoutMs,
  providerReadinessState,
  readinessTimeoutMsForServer,
  probeMcpServerReadiness,
  probeActionRequiredState,
};
