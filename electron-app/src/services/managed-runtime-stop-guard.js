// ============================================================================
// Managed-runtime stop classification for the update pipeline (PORTICO-323).
//
// Before applying an update the app stops the managed runtime so it can't swap
// files while services are live. The original guard (introduced by the
// "Overhaul update pipeline data safety" change) treated ANY non-success from
// `docker-compose.sh stop` as "the runtime may still be live -> refuse to
// apply". That conflates the real hazard with two benign states in which there
// is simply nothing to stop:
//
//   1. The managed runtime tree was never seeded (fresh install / stub root),
//      so the stop script does not exist -> bash exits 127 ("No such file or
//      directory"). No compose project exists, so nothing can be running.
//   2. Docker/OrbStack is not running or not installed, so `check_docker`
//      exits 1 ("Docker is not running") before anything is stopped. With the
//      daemon down no container can be live.
//
// Both dead-ended fresh installs in an unrecoverable "Update failed / Retry"
// loop. This helper lets both stop surfaces (main.js apply path and
// prerequisites-service.js runtime-update path) distinguish "nothing to stop"
// (safe to proceed) from "stop genuinely failed while the runtime may be live"
// (must refuse), from a single source of truth.
// ============================================================================

const {
  isComposeV2OrNewer,
} = require("./docker-compose-command");

const APP_COMPOSE_PROJECT = "portico";
const COMPOSE_FRONTEND_FAILURE_SIGNATURES = [
  /DOCKER_COMPOSE_UNAVAILABLE/i,
  /unknown shorthand flag:\s*['"]?[fp]['"]?\s+in\s+-[fp]/i,
  /docker:\s+unknown command:\s+docker compose/i,
  /docker:\s+['"]?compose['"]?\s+is not a docker command/i,
];

// Output/error signatures that mean "there was nothing to stop" rather than
// "the stop failed while services may still be running". Kept intentionally
// specific so a genuine stop failure (e.g. "container refused to stop") is
// never misread as safe.
const NOTHING_TO_STOP_SIGNATURES = [
  "docker is not running", // docker-compose.sh check_docker
  "cannot connect to the docker daemon", // docker CLI, daemon down
  "is the docker daemon running", // docker CLI, daemon down
  "orbstack is not installed", // docker recovery, runtime absent
];

function stopOutputIndicatesNothingToStop(output) {
  if (!output) {
    return false;
  }
  const normalized = String(output).toLowerCase();
  return NOTHING_TO_STOP_SIGNATURES.some((signature) =>
    normalized.includes(signature),
  );
}

// Decide whether a managed-runtime stop result is safe to proceed past.
//   { safeToProceed: true }  -> nothing was running to stop; applying is safe.
//   { safeToProceed: false } -> stop failed while the runtime may be live; refuse.
// `scriptExists === false` short-circuits to safe: the caller already knows the
// stop script is absent and never ran it.
function classifyManagedRuntimeStop({
  scriptExists,
  stopScriptPath,
  stopResult,
} = {}) {
  if (stopResult && stopResult.success) {
    return { safeToProceed: true, reason: "stopped" };
  }

  if (scriptExists === false) {
    return { safeToProceed: true, reason: "stop-script-absent" };
  }

  const combinedOutput = [
    stopResult && stopResult.output,
    stopResult && stopResult.error,
  ]
    .filter(Boolean)
    .join("\n");

  if (
    stopResult?.code === 127 &&
    stopScriptPath &&
    combinedOutput.includes(stopScriptPath) &&
    combinedOutput.toLowerCase().includes("no such file or directory")
  ) {
    return { safeToProceed: true, reason: "stop-script-absent" };
  }

  if (stopOutputIndicatesNothingToStop(combinedOutput)) {
    return { safeToProceed: true, reason: "nothing-to-stop" };
  }

  return {
    safeToProceed: false,
    reason: "stop-failed",
    error:
      (stopResult && stopResult.error) ||
      "docker-compose stop exited unsuccessfully",
  };
}

function collectStopOutput(stopResult) {
  return [stopResult?.output, stopResult?.error].filter(Boolean).join("\n");
}

function stopBudgetRemaining(deadlineAt, now) {
  return Math.max(0, deadlineAt - now());
}

async function runStopCommand(
  executeWithStreaming,
  command,
  args,
  deadlineAt,
  now,
) {
  const timeoutMs = stopBudgetRemaining(deadlineAt, now);
  if (timeoutMs === 0) {
    // PORTICO-373: an exhausted budget is the same observable condition as a command
    // that hit its own timeout, and callers key engine-wedge recovery off it.
    return {
      success: false,
      error: "Managed runtime stop timed out.",
      timedOut: true,
    };
  }

  try {
    // PORTICO-373: the update teardown has the same surviving-grandchild hazard as the
    // restart teardown, so it asks for process-group isolation explicitly rather
    // than inheriting it. It does NOT wait for group exit: unlike the restart, a
    // failed update stop aborts the update outright, so nothing downstream can
    // race the dying command.
    return await executeWithStreaming(command, args, timeoutMs, {
      isolateProcessGroup: true,
    });
  } catch (error) {
    return {
      success: false,
      error: error?.message || `${command} failed`,
    };
  }
}

async function inspectAppProjectContainers(
  executeWithStreaming,
  deadlineAt,
  now,
) {
  const result = await runStopCommand(
    executeWithStreaming,
    "docker",
    [
      "ps",
      "-aq",
      "--filter",
      `label=com.docker.compose.project=${APP_COMPOSE_PROJECT}`,
    ],
    deadlineAt,
    now,
  );
  if (!result.success) {
    return {
      success: false,
      error: result.error || "Could not inspect managed runtime containers.",
    };
  }

  return {
    success: true,
    containerIds: String(result.output || "")
      .split(/\s+/)
      .filter(Boolean),
  };
}

async function recoverBrokenComposeStop({
  executeWithStreaming,
  deadlineAt,
  now,
  originalStopResult,
}) {
  const initialContainers = await inspectAppProjectContainers(
    executeWithStreaming,
    deadlineAt,
    now,
  );
  if (!initialContainers.success) {
    return { success: false, error: initialContainers.error };
  }
  if (initialContainers.containerIds.length === 0) {
    return {
      success: true,
      skipped: true,
      reason: "no-project-containers",
    };
  }

  const standaloneProbe = await runStopCommand(
    executeWithStreaming,
    "docker-compose",
    ["version"],
    deadlineAt,
    now,
  );
  const standaloneVersionOutput = collectStopOutput(standaloneProbe);
  if (!standaloneProbe.success || !isComposeV2OrNewer(standaloneVersionOutput)) {
    return {
      success: false,
      error:
        originalStopResult?.error ||
        "docker-compose stop exited unsuccessfully",
    };
  }

  const standaloneStop = await runStopCommand(
    executeWithStreaming,
    "docker-compose",
    ["-p", APP_COMPOSE_PROJECT, "down", "--remove-orphans"],
    deadlineAt,
    now,
  );
  const remainingContainers = await inspectAppProjectContainers(
    executeWithStreaming,
    deadlineAt,
    now,
  );
  if (remainingContainers.success && remainingContainers.containerIds.length === 0) {
    return standaloneStop.success
      ? { success: true, reason: "standalone-compose-stopped" }
      : {
          success: true,
          skipped: true,
          reason: "no-project-containers",
        };
  }

  return {
    success: false,
    error:
      standaloneStop.error ||
      remainingContainers.error ||
      "Managed runtime containers remain after the standalone Compose stop.",
  };
}

async function stopManagedRuntimeForUpdate({
  stopScriptPath,
  scriptExists,
  executeWithStreaming,
  timeoutMs = 60000,
  now = Date.now,
} = {}) {
  if (scriptExists === false) {
    return { success: true, skipped: true, reason: "stop-script-absent" };
  }

  if (typeof executeWithStreaming !== "function") {
    throw new TypeError("executeWithStreaming (function) is required");
  }
  const deadlineAt = now() + timeoutMs;

  const stopResult = await runStopCommand(
    executeWithStreaming,
    `bash "${stopScriptPath}"`,
    ["stop"],
    deadlineAt,
    now,
  );
  const verdict = classifyManagedRuntimeStop({
    scriptExists: true,
    stopScriptPath,
    stopResult,
  });
  if (verdict.safeToProceed) {
    return verdict.reason === "stopped"
      ? { success: true }
      : { success: true, skipped: true, reason: verdict.reason };
  }

  const stopOutput = collectStopOutput(stopResult);
  if (
    !COMPOSE_FRONTEND_FAILURE_SIGNATURES.some((signature) =>
      signature.test(stopOutput),
    )
  ) {
    return {
      success: false,
      error: stopResult.error || "docker-compose stop exited unsuccessfully",
      // PORTICO-373: propagated so the caller can distinguish "the engine never
      // answered" from "the command ran and disagreed with us". Only the former
      // justifies restarting the container engine.
      timedOut: stopResult.timedOut === true,
    };
  }

  return recoverBrokenComposeStop({
    executeWithStreaming,
    deadlineAt,
    now,
    originalStopResult: stopResult,
  });
}

module.exports = {
  NOTHING_TO_STOP_SIGNATURES,
  stopOutputIndicatesNothingToStop,
  classifyManagedRuntimeStop,
  stopManagedRuntimeForUpdate,
};
