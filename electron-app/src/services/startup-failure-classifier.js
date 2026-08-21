// ============================================================================
// Startup failure classification for the loading screen (extracted from
// main.js so the logic is unit-testable — PORTICO-236).
//
// classifyContainerStartupFailure maps the combined output of the container
// readiness check and the background docker-compose.sh start run to a
// user-facing error banner (and optional copyable Terminal recovery command).
// ============================================================================

const STARTUP_STALE_CONTAINER_RECOVERY_COMMAND = [
  'osascript -e \'quit app "Portico"\' 2>/dev/null || true',
  'for c in $(docker ps -aq --filter "label=com.docker.compose.project=portico"); do docker rm -f "$c"; done',
  'for c in $(docker ps -aq --filter "label=com.docker.compose.project=portico-single"); do docker rm -f "$c"; done',
  'for c in $(docker ps -aq --filter ancestor=registry.example.invalid/sourcegraph-mcp-server:latest); do docker rm -f "$c"; done',
  'docker rm -f mcpo-sourcegraph nifty_brown 2>/dev/null || true',
  'open -a "Portico"',
].join("\n");

// PORTICO-373: last resort when the app has already tried to restart the container
// engine itself and the engine still will not answer. Only shown in that case --
// while automatic recovery is available, the user is never sent to Terminal.
const ENGINE_WEDGE_RECOVERY_COMMAND = [
  'osascript -e \'quit app "Portico"\' 2>/dev/null || true',
  "orbctl restart -a",
  'open -a "Portico"',
].join("\n");

// PORTICO-236: shown when a host-port conflict is attributed to Docker Desktop
// (an app stack from an earlier setup run left running there).
const PORT_CONFLICT_RECOVERY_COMMAND = [
  'osascript -e \'quit app "Docker Desktop"\' 2>/dev/null || true',
  'osascript -e \'quit app "Docker"\' 2>/dev/null || true',
  'open -a "Portico"',
].join("\n");

// Matches the greppable diagnostic emitted by docker-compose.sh
// report_compose_port_conflict (PORTICO-236).
const PORT_CONFLICT_LINE_REGEX =
  /PORT_CONFLICT: host port (\d+) is already in use \(holder: ([^;)]+); active docker context: ([^)]+)\)/i;

function buildLoadingErrorPayload(message, recovery = null) {
  if (!recovery) {
    return message;
  }

  return {
    message,
    recovery,
  };
}

function parsePortConflictDetails(combinedOutput) {
  const markerMatch = combinedOutput.match(PORT_CONFLICT_LINE_REGEX);
  if (markerMatch) {
    const holderRaw = markerMatch[2].trim();
    return {
      port: markerMatch[1],
      holder: holderRaw && holderRaw.toLowerCase() !== "unknown" ? holderRaw : null,
      activeContext: markerMatch[3].trim(),
    };
  }

  const portMatch =
    combinedOutput.match(/listen tcp [0-9.]*:(\d+)/i) ||
    combinedOutput.match(/exposing port TCP [0-9.]*:(\d+)/i);

  return {
    port: portMatch ? portMatch[1] : null,
    holder: null,
    activeContext: null,
  };
}

function classifyContainerStartupFailure(
  containerCheckResult,
  containerCheckError,
  dockerStartResult,
) {
  const combinedOutput = [
    containerCheckResult?.output,
    containerCheckResult?.error,
    containerCheckError?.message,
    dockerStartResult?.output,
    dockerStartResult?.error,
  ]
    .filter(Boolean)
    .join("\n");
  const normalizedOutput = combinedOutput.toLowerCase();

  if (normalizedOutput.includes("package_prepare_failed")) {
    const registryMissing = normalizedOutput.includes(
      "managed node package preparation requires an npm registry",
    );
    return {
      uiMessage: registryMissing
        ? "Portico could not prepare an enabled Node-based MCP integration because the packaged npm registry configuration is missing. Install a corrected build and retry initialization."
        : "Portico could not prepare an enabled Node-based MCP integration. Review the package preparation error in the initialization logs and retry.",
      logMessage:
        "Managed Node MCP package preparation failed before Docker startup.\n",
    };
  }

  if (
    normalizedOutput.includes("container name") &&
    normalizedOutput.includes("already in use")
  ) {
    return {
      uiMessage:
        "Docker reported a stale Portico container from an older run. Click Retry Initialization; if it still fails, run the Terminal recovery command below.",
      logMessage:
        "Detected stale Docker container name conflict while starting containers.\n",
      recovery: {
        type: "docker-start-failure",
        title: "Run This In Terminal",
        command: STARTUP_STALE_CONTAINER_RECOVERY_COMMAND,
      },
    };
  }

  if (normalizedOutput.includes("failed to register layer")) {
    return {
      uiMessage:
        "Docker image layer registration failed while starting containers. Retry initialization; cleanup is now attempted automatically.",
      logMessage:
        "Detected Docker layer registration failure while starting containers.\n",
    };
  }

  if (
    normalizedOutput.includes("registry-1.docker.io") &&
    (normalizedOutput.includes("no such host") ||
      normalizedOutput.includes("temporary failure"))
  ) {
    return {
      uiMessage:
        "Docker could not reach Docker Hub (DNS/network issue). Check network/DNS and retry initialization.",
      logMessage:
        "Detected Docker registry DNS/network failure while starting containers.\n",
    };
  }

  // PORTICO-236: a host-port conflict is more specific than the readiness timeout
  // that usually accompanies it, so this branch must come before the
  // "timeout waiting for containers" branch.
  if (
    normalizedOutput.includes("ports are not available") ||
    normalizedOutput.includes("bind: address already in use")
  ) {
    const details = parsePortConflictDetails(combinedOutput);
    const portText = details.port ? `port ${details.port}` : "a port it needs";

    if (details.holder === "Docker Desktop") {
      return {
        uiMessage: `Docker Desktop is still holding ${portText} — an Portico stack from an earlier setup run is likely still running there. Quit Docker Desktop (whale menu → Quit Docker Desktop), then click Retry Initialization.`,
        logMessage: `Detected host port conflict (${portText}) held by Docker Desktop while starting containers.\n`,
        recovery: {
          type: "docker-start-failure",
          title: "Run This In Terminal",
          command: PORT_CONFLICT_RECOVERY_COMMAND,
        },
      };
    }

    if (details.holder === "OrbStack") {
      return {
        uiMessage: `OrbStack is still holding ${portText} needed by Portico. Quit OrbStack from its menu-bar icon, then click Retry Initialization.`,
        logMessage: `Detected host port conflict (${portText}) held by OrbStack while starting containers.\n`,
      };
    }

    if (details.holder) {
      return {
        uiMessage: `The process "${details.holder}" is using ${portText} needed by Portico. Stop that process, then click Retry Initialization.`,
        logMessage: `Detected host port conflict (${portText}) held by "${details.holder}" while starting containers.\n`,
      };
    }

    return {
      uiMessage: `Another Docker runtime or process is already using ${portText} needed by Portico — most often a stack left running on Docker Desktop after switching to OrbStack. Quit any other Docker runtime (e.g. Docker Desktop), then click Retry Initialization.`,
      logMessage: `Detected host port conflict (${portText}) while starting containers — the app stack may be running on another Docker daemon.\n`,
    };
  }

  if (normalizedOutput.includes("timeout waiting for containers")) {
    return {
      uiMessage:
        "Containers did not become ready in time. Review initialization logs and retry.",
      logMessage: "Container readiness timed out during initialization.\n",
    };
  }

  if (
    normalizedOutput.includes("packaged runtime repair failed") ||
    normalizedOutput.includes("packaged runtime requires harbor images") ||
    normalizedOutput.includes("generated harbor compose override tag mismatch") ||
    normalizedOutput.includes("unable to resolve the packaged mcp-orc generator binary")
  ) {
    return {
      uiMessage:
        "The packaged runtime failed its integrity checks before Docker startup. Review initialization logs and retry after the integrity issue is fixed.",
      logMessage: "Packaged runtime integrity preflight failed during initialization.\n",
    };
  }

  // PORTICO-373: our own wrapper timeout, surfaced verbatim by executeWithStreaming.
  // It used to fall through to the generic banner below, which told the user to
  // check Docker logs -- from an app whose log collector is hanging on the same
  // unresponsive engine. Retry Initialization already restarts the engine before
  // retrying (start-initialization-with-retry), so name it instead.
  if (normalizedOutput.includes("command timed out")) {
    return {
      uiMessage:
        "Docker stopped responding while starting Portico services. Click Retry Initialization — it restarts the container engine first.",
      logMessage:
        "Docker startup exceeded its budget with no engine response; recoverable via Retry Initialization.\n",
    };
  }

  return {
    uiMessage: "Core containers failed to start. Check Docker logs.",
    logMessage: "",
  };
}

// PORTICO-236: on branches where docker-compose.sh start runs in the background,
// it usually finishes AFTER the readiness timeout has already put a generic
// banner on the loading screen. This decides whether that late, more specific
// failure should replace the banner. Pure logic so the race stays
// unit-testable. (On branches that await Docker startup synchronously the
// classifier already sees the compose output directly and this stays unused.)
function shouldEmitLateStartupFailureUpdate({
  attempt,
  currentAttempt,
  resultSuccess,
  failureDisplayed,
  loadingWindowAlive,
}) {
  if (attempt !== currentAttempt) {
    // A newer initialization attempt is in flight; never let a stale run's
    // docker result touch the current attempt's UI.
    return false;
  }
  if (resultSuccess) {
    // Never override anything with a success-shaped result.
    return false;
  }
  if (!failureDisplayed) {
    // The failure path already classified this result (or initialization is
    // still in progress) — nothing to update.
    return false;
  }
  if (!loadingWindowAlive) {
    return false;
  }
  return true;
}

/**
 * PORTICO-373: turn a failed full-restart teardown into what the user should see.
 *
 * Four outcomes, and the distinction matters because only one of them is the
 * user's problem to act on:
 *   - engine was wedged and we repaired it, but the retried stop still failed
 *   - engine was wedged and we could not repair it  -> Terminal fallback
 *   - engine is healthy, the stop just overran      -> retry is worth a try
 *   - the stop failed without timing out            -> not an engine story at all
 *
 * @param {{ timedOut?: boolean, error?: string, treeExited?: boolean|null }} stopResult
 * @param {{ wedged?: boolean, attempted?: boolean, recovered?: boolean, error?: string|null }} [engineRecovery]
 */
function describeFailedStopPhase(stopResult, engineRecovery = null) {
  const stopError = stopResult?.error || "unknown error";
  const timedOut = stopResult?.timedOut === true;
  const wedged = engineRecovery?.wedged === true;
  const recovered = engineRecovery?.recovered === true;

  if (wedged && recovered) {
    return {
      uiMessage:
        "The container engine had stopped responding and was restarted, but Portico services still could not be stopped. Click Retry Initialization.",
      logMessage:
        "Stop phase failed again after a successful container engine restart; refusing to continue.\n",
      recovery: null,
    };
  }

  if (wedged) {
    return {
      uiMessage:
        "The container engine stopped responding and could not be restarted automatically, so Portico did not restart its services. Click Retry Initialization, or run the Terminal recovery command below.",
      logMessage: `Container engine wedge could not be repaired automatically (${engineRecovery?.error || "unknown reason"}); refusing to continue past an unfinished teardown.\n`,
      recovery: {
        type: "engine-wedge",
        title: "Run This In Terminal",
        command: ENGINE_WEDGE_RECOVERY_COMMAND,
      },
    };
  }

  if (timedOut) {
    return {
      uiMessage:
        "Stopping Portico services took too long, so the restart was cancelled to avoid starting services on top of a partial shutdown. Click Retry Initialization.",
      logMessage: `Stop phase timed out while the container engine was still responsive (${stopError}); refusing to continue.\n`,
      recovery: null,
    };
  }

  return {
    uiMessage:
      "Portico services could not be stopped, so the restart was cancelled. Click Retry Initialization.",
    logMessage: `Stop phase failed (${stopError}); refusing to continue.\n`,
    recovery: null,
  };
}

module.exports = {
  STARTUP_STALE_CONTAINER_RECOVERY_COMMAND,
  PORT_CONFLICT_RECOVERY_COMMAND,
  ENGINE_WEDGE_RECOVERY_COMMAND,
  buildLoadingErrorPayload,
  classifyContainerStartupFailure,
  describeFailedStopPhase,
  parsePortConflictDetails,
  shouldEmitLateStartupFailureUpdate,
};
