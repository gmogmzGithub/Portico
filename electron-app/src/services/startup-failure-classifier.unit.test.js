const test = require("node:test");
const assert = require("node:assert/strict");

const {
  STARTUP_STALE_CONTAINER_RECOVERY_COMMAND,
  PORT_CONFLICT_RECOVERY_COMMAND,
  ENGINE_WEDGE_RECOVERY_COMMAND,
  buildLoadingErrorPayload,
  classifyContainerStartupFailure,
  describeFailedStopPhase,
  parsePortConflictDetails,
  shouldEmitLateStartupFailureUpdate,
} = require("./startup-failure-classifier");

// Verbatim from the PORTICO-236 debug bundle (initialization_temp.log).
const BUNDLE_PORT_CONFLICT_OUTPUT = [
  " Container portico-redis Started ",
  "Error response from daemon: ports are not available: exposing port TCP 0.0.0.0:3835 -> 127.0.0.1:0: listen tcp 0.0.0.0:3835: bind: address already in use",
  "Docker compose failed after 3 attempts (exit code: 1)",
  "❌ Docker compose up failed",
].join("\n");

const PORT_CONFLICT_MARKER_LINE = (holder) =>
  `❌ PORT_CONFLICT: host port 3835 is already in use (holder: ${holder}; active docker context: orbstack)`;

test("bundle-verbatim port conflict output classifies as a port conflict naming the port", () => {
  const result = classifyContainerStartupFailure(null, null, {
    success: false,
    output: BUNDLE_PORT_CONFLICT_OUTPUT,
  });

  assert.match(result.uiMessage, /port 3835/);
  assert.match(result.uiMessage, /Retry Initialization/);
  assert.match(result.logMessage, /host port conflict/i);
  // Without a named holder there must be no scripted recovery command.
  assert.equal(result.recovery, undefined);
});

test("PORT_CONFLICT marker naming Docker Desktop produces Desktop guidance with recovery", () => {
  const output = `${BUNDLE_PORT_CONFLICT_OUTPUT}\n${PORT_CONFLICT_MARKER_LINE("Docker Desktop")}`;
  const result = classifyContainerStartupFailure(null, null, {
    success: false,
    output,
  });

  assert.match(result.uiMessage, /Docker Desktop/);
  assert.match(result.uiMessage, /port 3835/);
  assert.ok(result.recovery, "Docker Desktop holder should offer a recovery command");
  assert.equal(result.recovery.command, PORT_CONFLICT_RECOVERY_COMMAND);
  assert.match(PORT_CONFLICT_RECOVERY_COMMAND, /quit app "Docker Desktop"/);
  assert.match(PORT_CONFLICT_RECOVERY_COMMAND, /open -a "Portico"/);
});

test("PORT_CONFLICT marker naming OrbStack produces OrbStack guidance without scripted recovery", () => {
  const output = `${BUNDLE_PORT_CONFLICT_OUTPUT}\n${PORT_CONFLICT_MARKER_LINE("OrbStack")}`;
  const result = classifyContainerStartupFailure(null, null, {
    success: false,
    output,
  });

  assert.match(result.uiMessage, /OrbStack/);
  assert.doesNotMatch(result.uiMessage, /Docker Desktop/);
  assert.equal(result.recovery, undefined);
});

test("PORT_CONFLICT marker naming an arbitrary process names it without scripted recovery", () => {
  // e.g. an lsof COMMAND that is not a known Docker runtime (possibly truncated).
  const output = `${BUNDLE_PORT_CONFLICT_OUTPUT}\n${PORT_CONFLICT_MARKER_LINE("node")}`;
  const result = classifyContainerStartupFailure(null, null, {
    success: false,
    output,
  });

  assert.match(result.uiMessage, /"node"/);
  assert.equal(result.recovery, undefined);
});

test("PORT_CONFLICT marker with unknown holder falls back to generic port-conflict guidance", () => {
  const output = `${BUNDLE_PORT_CONFLICT_OUTPUT}\n${PORT_CONFLICT_MARKER_LINE("unknown")}`;
  const result = classifyContainerStartupFailure(null, null, {
    success: false,
    output,
  });

  assert.match(result.uiMessage, /Another Docker runtime or process/);
  assert.match(result.uiMessage, /port 3835/);
  assert.equal(result.recovery, undefined);
});

test("port conflict wins over readiness timeout when both are present", () => {
  const combined = [
    "Timeout waiting for containers after 120 seconds",
    BUNDLE_PORT_CONFLICT_OUTPUT,
  ].join("\n");
  const result = classifyContainerStartupFailure(
    { success: false, output: combined },
    null,
    null,
  );

  assert.match(result.uiMessage, /port 3835/);
  assert.doesNotMatch(result.uiMessage, /did not become ready in time/);
});

test("readiness timeout alone still classifies as the timeout banner", () => {
  const result = classifyContainerStartupFailure(
    { success: false, output: "Timeout waiting for containers after 420 seconds (wait budget 120s after compose up, wall cap 420s)" },
    null,
    null,
  );

  assert.match(result.uiMessage, /did not become ready in time/);
});

test("container name conflicts keep precedence over port conflicts", () => {
  const combined = [
    'Error response from daemon: Conflict. The container name "/mcpo" is already in use by container "old".',
    BUNDLE_PORT_CONFLICT_OUTPUT,
  ].join("\n");
  const result = classifyContainerStartupFailure(null, null, {
    success: false,
    output: combined,
  });

  assert.match(result.uiMessage, /stale Portico container/);
  assert.equal(result.recovery.command, STARTUP_STALE_CONTAINER_RECOVERY_COMMAND);
});

test("package_prepare_failed keeps its dedicated classification and precedence", () => {
  const combined = [
    "PACKAGE_PREPARE_FAILED: managed node package preparation requires an npm registry",
    BUNDLE_PORT_CONFLICT_OUTPUT,
  ].join("\n");
  const result = classifyContainerStartupFailure(null, null, {
    success: false,
    output: combined,
  });

  assert.match(result.uiMessage, /npm registry configuration is missing/);
  assert.match(result.logMessage, /package preparation failed/i);
});

test("unmatched output still returns the generic fallback with empty logMessage", () => {
  const result = classifyContainerStartupFailure(null, null, {
    success: false,
    output: "something completely unexpected",
  });

  assert.equal(result.uiMessage, "Core containers failed to start. Check Docker logs.");
  assert.equal(result.logMessage, "");
});

test("parsePortConflictDetails extracts port/holder/context from the marker line", () => {
  const details = parsePortConflictDetails(PORT_CONFLICT_MARKER_LINE("Docker Desktop"));
  assert.deepEqual(details, {
    port: "3835",
    holder: "Docker Desktop",
    activeContext: "orbstack",
  });

  const fallback = parsePortConflictDetails(BUNDLE_PORT_CONFLICT_OUTPUT);
  assert.equal(fallback.port, "3835");
  assert.equal(fallback.holder, null);
});

test("buildLoadingErrorPayload keeps its legacy shapes", () => {
  assert.equal(buildLoadingErrorPayload("plain message"), "plain message");
  assert.deepEqual(
    buildLoadingErrorPayload("msg", { title: "t", command: "c" }),
    { message: "msg", recovery: { title: "t", command: "c" } },
  );
});

test("shouldEmitLateStartupFailureUpdate gates the late banner correctly", () => {
  const base = {
    attempt: 2,
    currentAttempt: 2,
    resultSuccess: false,
    failureDisplayed: true,
    loadingWindowAlive: true,
  };

  assert.equal(shouldEmitLateStartupFailureUpdate(base), true);
  // A stale attempt's docker result must never touch a newer attempt's UI.
  assert.equal(
    shouldEmitLateStartupFailureUpdate({ ...base, attempt: 1 }),
    false,
  );
  // Success results never rewrite the banner.
  assert.equal(
    shouldEmitLateStartupFailureUpdate({ ...base, resultSuccess: true }),
    false,
  );
  // If no failure banner is displayed, there is nothing to upgrade.
  assert.equal(
    shouldEmitLateStartupFailureUpdate({ ...base, failureDisplayed: false }),
    false,
  );
  assert.equal(
    shouldEmitLateStartupFailureUpdate({ ...base, loadingWindowAlive: false }),
    false,
  );
});

// ---------------------------------------------------------------------------
// PORTICO-373: a wedged container engine (accepts connections, never answers).
// ---------------------------------------------------------------------------

// Shape produced by executeWithStreaming when its wrapper budget expires and
// the process group was killed without a confirmed exit.
const WEDGED_STOP_RESULT = {
  success: false,
  error: "Command timed out",
  timedOut: true,
  treeExited: false,
};

test('"command timed out" output names Retry instead of the generic Docker-logs banner', () => {
  // Baseline: whatever the fallback says, unrecognised output must still get it.
  const generic = classifyContainerStartupFailure(null, null, {
    success: false,
    output: "totally unrecognised failure text with no known marker",
  });
  assert.equal(generic.uiMessage, "Core containers failed to start. Check Docker logs.");
  assert.equal(generic.logMessage, "");

  const timeoutOutputs = [
    "Command timed out",
    "COMMAND TIMED OUT",
    "docker compose down: command timed out after 240000ms",
  ];

  for (const output of timeoutOutputs) {
    const result = classifyContainerStartupFailure(null, null, {
      success: false,
      output,
    });

    assert.notEqual(
      result.uiMessage,
      generic.uiMessage,
      `"${output}" must not fall through to the generic banner`,
    );
    // Telling the user to check Docker logs is exactly the advice that failed
    // the two blocked users: the log collector hangs on the same dead engine.
    assert.doesNotMatch(result.uiMessage, /Check Docker logs/i);
    assert.match(result.uiMessage, /Retry Initialization/);
    assert.notEqual(result.logMessage, "");
  }
});

test("failed stop after a repaired engine points at Retry and offers no Terminal command", () => {
  const result = describeFailedStopPhase(WEDGED_STOP_RESULT, {
    wedged: true,
    attempted: true,
    recovered: true,
    method: "orbctl-restart",
    error: null,
    reason: "recovered",
  });

  // The engine was already restarted for the user; sending them to Terminal to
  // restart it again would be wrong.
  assert.equal(result.recovery, null);
  assert.match(result.uiMessage, /Retry Initialization/);
  assert.notEqual(result.logMessage, "");
});

test("failed stop with an unrepairable engine offers the engine-wedge Terminal command", () => {
  const result = describeFailedStopPhase(WEDGED_STOP_RESULT, {
    wedged: true,
    attempted: true,
    recovered: false,
    method: "orbctl-restart",
    error: "orbctl restart exited 1: engine unresponsive",
    reason: "recovery-failed",
  });

  assert.ok(
    result.recovery,
    "an engine we could not repair is the only case the user can act on",
  );
  assert.equal(result.recovery.command, ENGINE_WEDGE_RECOVERY_COMMAND);
  assert.ok(result.recovery.title, "a Terminal fallback must carry a title to render");
  // Why automatic recovery gave up has to survive into the logs.
  assert.match(result.logMessage, /orbctl restart exited 1: engine unresponsive/);
  assert.match(result.uiMessage, /Retry Initialization/);
});

test("stop timeout with a responsive engine never sends the user to Terminal", () => {
  const stopResult = {
    success: false,
    error: "Managed runtime stop timed out.",
    timedOut: true,
  };

  // No recovery attempt recorded at all (e.g. callers that skip the probe).
  const withoutRecoveryInfo = describeFailedStopPhase(stopResult, null);
  assert.equal(withoutRecoveryInfo.recovery, null);
  assert.match(withoutRecoveryInfo.logMessage, /Managed runtime stop timed out\./);

  // Probe ran and found the engine healthy: same story, still no Terminal.
  const probedHealthy = describeFailedStopPhase(stopResult, {
    wedged: false,
    attempted: false,
    recovered: false,
    error: null,
    reason: "engine-healthy",
  });
  assert.equal(probedHealthy.recovery, null);
  assert.equal(probedHealthy.uiMessage, withoutRecoveryInfo.uiMessage);
});

test("stop failure that did not time out is reported without any engine claim", () => {
  const result = describeFailedStopPhase(
    {
      success: false,
      error: "compose file not found: docker-compose.yml",
      timedOut: false,
    },
    null,
  );

  assert.equal(result.recovery, null);
  assert.match(result.logMessage, /compose file not found: docker-compose\.yml/);
  assert.match(result.uiMessage, /Retry Initialization/);
});

test("the four failed-stop outcomes stay four distinct user-facing messages", () => {
  const uiMessages = [
    // wedged + repaired
    describeFailedStopPhase(WEDGED_STOP_RESULT, { wedged: true, recovered: true })
      .uiMessage,
    // wedged + unrepairable
    describeFailedStopPhase(WEDGED_STOP_RESULT, {
      wedged: true,
      recovered: false,
      error: "restart failed",
    }).uiMessage,
    // plain timeout, engine responsive
    describeFailedStopPhase(WEDGED_STOP_RESULT, null).uiMessage,
    // plain failure, no timeout
    describeFailedStopPhase({ success: false, error: "exit code 1" }, null).uiMessage,
  ];

  assert.equal(
    new Set(uiMessages).size,
    4,
    `each outcome needs its own banner; got ${JSON.stringify(uiMessages)}`,
  );
  for (const uiMessage of uiMessages) {
    assert.match(uiMessage, /Retry Initialization/);
  }
});

test("ENGINE_WEDGE_RECOVERY_COMMAND restarts the engine and force-removes nothing", () => {
  assert.match(ENGINE_WEDGE_RECOVERY_COMMAND, /orbctl\s+restart/);
  assert.match(ENGINE_WEDGE_RECOVERY_COMMAND, /open -a "Portico"/);
  // Forced container removal belongs to the stale-container recovery; it is
  // far more destructive and must not leak into the engine-wedge fallback.
  assert.doesNotMatch(ENGINE_WEDGE_RECOVERY_COMMAND, /docker\s+rm\s+-f/);
  assert.notEqual(ENGINE_WEDGE_RECOVERY_COMMAND, STARTUP_STALE_CONTAINER_RECOVERY_COMMAND);
});
