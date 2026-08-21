const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyLocalToggleHealthState,
  buildTrackerView,
  createOptimisticOperationSnapshot,
  createTracker,
  normalizeOperationSnapshot,
  recalculateHealthSummary,
  resolveEffectiveEnabled,
  resolveEffectiveConfigured,
  resolveEffectiveHealthStatus,
  shouldPreferPendingStateForEnableBackendStatus,
  stageFromHealthStatus,
  stageFromReadiness,
  shouldAcceptOperationSnapshot,
  updateTrackerServer,
} = require("../renderer/components/mcp-operation-progress");

test("tracker view reports per-server and overall progress", () => {
  const tracker = createTracker({
    action: "enable",
    title: "Enabling MCP servers",
    servers: [
      { id: "gitlab-mcp", label: "GitLab" },
      { id: "slack", label: "Slack" },
    ],
  });

  updateTrackerServer(tracker, "gitlab-mcp", {
    stage: "healthy",
    detail: "Running",
  });
  updateTrackerServer(tracker, "slack", {
    stage: "starting",
    detail: "Starting...",
  });

  const view = buildTrackerView(tracker);
  assert.equal(view.total, 2);
  assert.equal(view.completed, 1);
  assert.equal(view.terminal, false);
  assert.equal(view.operationId, tracker.operationId);
  assert.equal(view.rows[0].percent, 100);
  assert.equal(view.rows[1].percent, 62);
  assert.equal(view.overallPercent, 81);
});

test("readiness and health status map into operation stages", () => {
  assert.equal(stageFromReadiness({ healthy: true }), "healthy");
  assert.equal(
    stageFromReadiness({ readiness_phase: "needs_oauth" }),
    "needs_oauth",
  );
  assert.equal(stageFromReadiness({ readiness_phase: "checking" }), "checking");
  assert.equal(stageFromReadiness({ readiness_phase: "wat" }), "waiting");

  assert.equal(stageFromHealthStatus("healthy"), "healthy");
  assert.equal(stageFromHealthStatus("starting"), "starting");
  assert.equal(stageFromHealthStatus("wat"), "waiting");
});

test("pending enable operations override stale backend disabled state", () => {
  const pendingOperation = {
    targetEnabled: true,
    stage: "starting",
  };

  assert.equal(
    resolveEffectiveEnabled({
      backendStatus: "disabled",
      toggleEnabled: true,
      pendingOperation,
    }),
    true,
  );
  assert.equal(
    resolveEffectiveHealthStatus("disabled", pendingOperation),
    "starting",
  );
});

test("pending disable operations override stale backend healthy state", () => {
  const pendingOperation = {
    targetEnabled: false,
    stage: "disabled",
  };

  assert.equal(
    resolveEffectiveEnabled({
      backendStatus: "healthy",
      toggleEnabled: false,
      pendingOperation,
    }),
    false,
  );
  assert.equal(
    resolveEffectiveHealthStatus("healthy", pendingOperation),
    "disabled",
  );
});

test("pending enable operations suppress transient failed backend states during startup", () => {
  const pendingOperation = {
    targetEnabled: true,
    stage: "starting",
    updatedAt: Date.now(),
  };

  assert.equal(
    shouldPreferPendingStateForEnableBackendStatus("failed", pendingOperation, {
      backendError: "Server started but exposed no tools",
    }),
    true,
  );
  assert.equal(
    resolveEffectiveHealthStatus("failed", pendingOperation, {
      backendError: "Server started but exposed no tools",
    }),
    "starting",
  );
});

test("pending enable operations keep OAuth servers in starting during token discovery failures", () => {
  const pendingOperation = {
    targetEnabled: true,
    stage: "starting",
    updatedAt: Date.now(),
  };

  assert.equal(
    shouldPreferPendingStateForEnableBackendStatus("failed", pendingOperation, {
      backendError:
        "error sending request for url (http://mcpo-google-workspace:8000/oauth/status)",
      expectsOAuth: true,
    }),
    true,
  );
  assert.equal(
    resolveEffectiveHealthStatus("failed", pendingOperation, {
      backendError:
        "error sending request for url (http://mcpo-google-workspace:8000/oauth/status)",
      expectsOAuth: true,
    }),
    "starting",
  );
});

test("post-auth recovery keeps stale needs_oauth snapshots in checking", () => {
  const pendingOperation = {
    targetEnabled: true,
    stage: "checking",
    operationKind: "post_oauth_recovery",
    postAuthRecovery: true,
    updatedAt: Date.now(),
  };

  assert.equal(
    shouldPreferPendingStateForEnableBackendStatus(
      "needs_oauth",
      pendingOperation,
      {
        backendError: "Server configured but waiting for OAuth authorization",
        expectsOAuth: true,
      },
    ),
    true,
  );
  assert.equal(
    resolveEffectiveHealthStatus("needs_oauth", pendingOperation, {
      backendError: "Server configured but waiting for OAuth authorization",
      expectsOAuth: true,
    }),
    "checking",
  );
  assert.equal(
    shouldPreferPendingStateForEnableBackendStatus(
      "needs_oauth",
      {
        targetEnabled: true,
        stage: "checking",
        updatedAt: Date.now(),
      },
      { expectsOAuth: true },
    ),
    false,
  );
});

test("pending enable operations suppress stale not_configured state after successful setup", () => {
  const pendingOperation = {
    targetEnabled: true,
    stage: "starting",
    updatedAt: Date.now(),
  };

  assert.equal(
    shouldPreferPendingStateForEnableBackendStatus(
      "not_configured",
      pendingOperation,
      {
        backendError: "missing environment variable GITLAB_TOKEN",
        allowNotConfiguredOverride: true,
      },
    ),
    true,
  );
  assert.equal(
    resolveEffectiveConfigured({
      serverConfigured: false,
      backendConfigured: false,
      backendStatus: "not_configured",
      backendError: "missing environment variable GITLAB_TOKEN",
      pendingOperation,
      allowNotConfiguredOverride: true,
    }),
    true,
  );
  assert.equal(
    resolveEffectiveHealthStatus("not_configured", pendingOperation, {
      backendError: "missing environment variable GITLAB_TOKEN",
      allowNotConfiguredOverride: true,
    }),
    "starting",
  );
});

test("healthy backend state wins over stale configured false snapshots", () => {
  assert.equal(
    resolveEffectiveConfigured({
      serverConfigured: false,
      backendConfigured: false,
      backendStatus: "healthy",
    }),
    true,
  );
});

test("regular enable does not suppress not_configured for servers that still need setup", () => {
  const pendingOperation = {
    targetEnabled: true,
    stage: "starting",
    updatedAt: Date.now(),
  };

  assert.equal(
    shouldPreferPendingStateForEnableBackendStatus(
      "not_configured",
      pendingOperation,
      {
        backendError: "missing environment variable GITLAB_TOKEN",
        allowNotConfiguredOverride: false,
      },
    ),
    false,
  );
  assert.equal(
    resolveEffectiveConfigured({
      serverConfigured: false,
      backendConfigured: false,
      backendStatus: "not_configured",
      backendError: "missing environment variable GITLAB_TOKEN",
      pendingOperation,
      allowNotConfiguredOverride: false,
    }),
    false,
  );
  assert.equal(
    resolveEffectiveHealthStatus("not_configured", pendingOperation, {
      backendError: "missing environment variable GITLAB_TOKEN",
      allowNotConfiguredOverride: false,
    }),
    "not_configured",
  );
});

test("pending enable operations suppress transient startup timeout errors", () => {
  const pendingOperation = {
    targetEnabled: true,
    stage: "starting",
    updatedAt: Date.now(),
  };

  assert.equal(
    shouldPreferPendingStateForEnableBackendStatus("timeout", pendingOperation, {
      backendError: "Server did not become ready within 30 seconds",
    }),
    true,
  );
  assert.equal(
    resolveEffectiveHealthStatus("timeout", pendingOperation, {
      backendError: "Server did not become ready within 30 seconds",
    }),
    "starting",
  );
});

test("pending enable operations do not mask hard configuration failures", () => {
  const pendingOperation = {
    targetEnabled: true,
    stage: "starting",
    updatedAt: Date.now(),
  };

  assert.equal(
    shouldPreferPendingStateForEnableBackendStatus("failed", pendingOperation, {
      backendError: "error mounting /tmp/config.json: not a directory",
    }),
    false,
  );
  assert.equal(
    resolveEffectiveHealthStatus("failed", pendingOperation, {
      backendError: "error mounting /tmp/config.json: not a directory",
    }),
    "failed",
  );
  assert.equal(
    resolveEffectiveConfigured({
      serverConfigured: false,
      backendConfigured: false,
      backendStatus: "failed",
      backendError: "error mounting /tmp/config.json: not a directory",
      pendingOperation,
    }),
    false,
  );
});

test("pending enable operations do not mask hard config generation errors", () => {
  const pendingOperation = {
    targetEnabled: true,
    stage: "starting",
    updatedAt: Date.now(),
  };
  const errors = [
    "Invalid JSON in fragment for user-snowflake-cortex: trailing comma at line 8 column 3",
    "Config regeneration failed: invalid JSON in user-snowflake-cortex.fragment",
  ];

  for (const backendError of errors) {
    assert.equal(
      shouldPreferPendingStateForEnableBackendStatus("failed", pendingOperation, {
        backendError,
        expectsOAuth: true,
      }),
      false,
    );
    assert.equal(
      resolveEffectiveHealthStatus("failed", pendingOperation, {
        backendError,
        expectsOAuth: true,
      }),
      "failed",
    );
  }
});

test("explicit false toggle wins over stale backend healthy state", () => {
  assert.equal(
    resolveEffectiveEnabled({
      backendStatus: "healthy",
      toggleEnabled: false,
      pendingOperation: null,
    }),
    false,
  );
});

test("background presentation never converts a starting row into a terminal stage", () => {
  const tracker = createTracker({
    action: "enable",
    title: "Enabling MCP servers",
    servers: [{ id: "glean", label: "Glean" }],
  });

  updateTrackerServer(tracker, "glean", {
    stage: "starting",
    detail: "Still starting in background...",
  });

  const view = buildTrackerView(tracker);
  assert.equal(view.completed, 0);
  assert.equal(view.terminal, false);
  assert.equal(view.rows[0].stageLabel, "Starting");
});

test("applyLocalToggleHealthState updates summary immediately for disable and enable", () => {
  const servers = {
    slack: {
      status: "failed",
      deployment: "docker",
      error: "Invalid JSON in fragment",
      startup_failure: {
        serverId: "slack",
        stage: "config_generation",
        source: "config",
        error: "Invalid JSON in fragment",
      },
      startup_failure_source: "config",
      startup_failure_stage: "config_generation",
      startup_failure_timestamp: "2026-04-20T00:00:00.000Z",
      config_path: "/tmp/slack.fragment",
      container_name: "mcpo-slack",
    },
    glean: { status: "healthy", deployment: "docker" },
  };

  const disabled = applyLocalToggleHealthState(servers, "slack", false);
  assert.equal(disabled.server.status, "disabled");
  assert.equal(disabled.server.disabled_by_user, true);
  assert.equal(disabled.server.disabled_reason, "explicit_false");
  assert.equal(disabled.server.error, null);
  assert.equal(disabled.server.startup_failure, undefined);
  assert.equal(disabled.server.startup_failure_source, undefined);
  assert.equal(disabled.server.startup_failure_stage, undefined);
  assert.equal(disabled.server.startup_failure_timestamp, undefined);
  assert.equal(disabled.server.config_path, undefined);
  assert.equal(disabled.server.container_name, undefined);
  assert.deepEqual(disabled.summary, {
    total: 2,
    healthy: 1,
    needs_oauth: 0,
    timeout: 0,
    failed: 0,
    not_running: 0,
    not_configured: 0,
    starting: 0,
    disabled: 1,
  });

  servers.slack.startup_failure = {
    serverId: "slack",
    stage: "config_generation",
    source: "config",
    error: "Invalid JSON in fragment",
  };
  servers.slack.startup_failure_source = "config";
  servers.slack.startup_failure_stage = "config_generation";
  servers.slack.startup_failure_timestamp = "2026-04-20T00:00:00.000Z";
  servers.slack.config_path = "/tmp/slack.fragment";
  servers.slack.container_name = "mcpo-slack";

  const enabled = applyLocalToggleHealthState(servers, "slack", true);
  assert.equal(enabled.server.status, "starting");
  assert.equal(enabled.server.configured, true);
  assert.equal(enabled.server.disabled_by_user, false);
  assert.equal(enabled.server.disabled_reason, null);
  assert.equal(enabled.server.error, null);
  assert.equal(enabled.server.startup_failure, undefined);
  assert.equal(enabled.server.startup_failure_source, undefined);
  assert.equal(enabled.server.startup_failure_stage, undefined);
  assert.equal(enabled.server.startup_failure_timestamp, undefined);
  assert.equal(enabled.server.config_path, undefined);
  assert.equal(enabled.server.container_name, undefined);
  assert.deepEqual(enabled.summary, {
    total: 2,
    healthy: 1,
    needs_oauth: 0,
    timeout: 0,
    failed: 0,
    not_running: 0,
    not_configured: 0,
    starting: 1,
    disabled: 0,
  });

  assert.deepEqual(recalculateHealthSummary(servers), enabled.summary);
});

test("applyLocalToggleHealthState can stamp enabled servers as not_configured", () => {
  const servers = {
    gitlab: { status: "disabled", configured: false },
    slack: { status: "healthy", configured: true },
  };

  const result = applyLocalToggleHealthState(servers, "gitlab", true, {
    configured: false,
    status: "not_configured",
    authorizationUrlAvailable: false,
    oauthState: null,
  });

  assert.equal(result.server.status, "not_configured");
  assert.equal(result.server.configured, false);
  assert.equal(result.server.disabled_by_user, false);
  assert.equal(result.server.disabled_reason, null);
  assert.equal(result.server.authorization_url_available, false);
  assert.equal(result.server.authorizationUrlAvailable, false);
  assert.equal(result.server.oauth_state, null);
  assert.deepEqual(result.summary, {
    total: 2,
    healthy: 1,
    needs_oauth: 0,
    timeout: 0,
    failed: 0,
    not_running: 0,
    not_configured: 1,
    starting: 0,
    disabled: 0,
  });
});

test("authoritative snapshots normalize operation sequence and server outcomes", () => {
  const view = normalizeOperationSnapshot({
    operationId: "operation-1",
    sequence: 7,
    action: "enable",
    status: "partial",
    total: 2,
    completed: 2,
    failed: 1,
    servers: [
      {
        id: "slack",
        label: "Slack",
        status: "succeeded",
        terminal: true,
        success: true,
      },
      {
        id: "snowflake",
        label: "Snowflake",
        status: "timed_out",
        terminal: true,
        success: false,
        error: "Readiness timed out",
      },
    ],
  });

  assert.equal(view.revision, 7);
  assert.equal(view.status, "partial");
  assert.equal(view.terminal, true);
  assert.equal(view.successful, false);
  assert.equal(view.attention, true);
  assert.equal(view.rows[0].stage, "healthy");
  assert.equal(view.rows[1].stage, "timeout");
  assert.equal(view.overallPercent, 100);
});

test("disable success normalizes to the disabled row stage", () => {
  const view = normalizeOperationSnapshot({
    operationId: "disable-1",
    sequence: 2,
    action: "disable",
    status: "succeeded",
    servers: [
      {
        id: "slack",
        label: "Slack",
        targetEnabled: false,
        status: "succeeded",
        terminal: true,
      },
    ],
  });
  assert.equal(view.rows[0].stage, "disabled");
  assert.equal(view.successful, true);
});

test("terminal rows remain finalizing until main-process effects are complete", () => {
  const finalizing = normalizeOperationSnapshot({
    operationId: "enable-finalizing",
    sequence: 8,
    action: "enable",
    status: "succeeded",
    effectsFinalized: false,
    progressPercent: 100,
    servers: [
      {
        id: "slack",
        status: "succeeded",
        phase: "tool_ready",
        terminal: true,
        progressPercent: 100,
      },
    ],
  });
  assert.equal(finalizing.terminal, false);
  assert.equal(finalizing.successful, false);
  assert.equal(finalizing.effectsFinalized, false);
  assert.equal(finalizing.phase, "finalizing");

  const finalized = normalizeOperationSnapshot({
    operationId: "enable-finalizing",
    sequence: 9,
    action: "enable",
    status: "succeeded",
    effectsFinalized: true,
    progressPercent: 100,
    servers: finalizing.rows,
  });
  assert.equal(finalized.terminal, true);
  assert.equal(finalized.successful, true);
});

test("manager schema uses operation sequence, action, phase progress, and structured errors", () => {
  const running = normalizeOperationSnapshot({
    schemaVersion: 1,
    kind: "mcp_operation",
    operationId: "restart-1",
    action: "restart",
    desiredRevision: 3,
    revision: 3,
    sequence: 12,
    status: "running",
    progressPercent: 80,
    servers: [
      {
        id: "snowflake",
        status: "running",
        phase: "waiting_readiness",
        progressPercent: 80,
      },
    ],
  });
  assert.equal(running.revision, 12);
  assert.equal(running.desiredRevision, 3);
  assert.equal(running.kind, "restart");
  assert.equal(running.overallPercent, 80);
  assert.equal(running.rows[0].stage, "waiting");
  assert.equal(running.rows[0].stageLabel, "Waiting for readiness");

  const failed = normalizeOperationSnapshot({
    kind: "mcp_operation",
    operationId: "restart-1",
    action: "restart",
    sequence: 13,
    status: "failed",
    error: { code: "MCP_RUNTIME_START_FAILED", message: "Docker failed" },
    servers: [
      {
        id: "snowflake",
        status: "failed",
        phase: "failed",
        terminal: true,
        success: false,
        error: { code: "MCP_RUNTIME_START_FAILED", message: "Docker failed" },
      },
    ],
  });
  assert.equal(failed.error, "Docker failed");
  assert.equal(failed.rows[0].detail, "Docker failed");

  const authorization = normalizeOperationSnapshot({
    kind: "mcp_operation",
    operationId: "auth-1",
    action: "enable",
    sequence: 4,
    status: "attention_required",
    servers: [
      {
        id: "google-workspace",
        status: "attention_required",
        phase: "needs_oauth",
        terminal: true,
        success: true,
        requiredAction: { type: "authorize" },
      },
    ],
  });
  assert.equal(authorization.rows[0].stage, "needs_oauth");
  assert.equal(authorization.rows[0].requiredAction, "authorize");
});

test("terminal attention operations report enabled count separately from rows needing attention", () => {
  const attention = normalizeOperationSnapshot({
    operationId: "enable-attention-1",
    action: "enable",
    status: "attention_required",
    effectsFinalized: true,
    summary: {
      total: 1,
      completed: 1,
      succeeded: 1,
      attentionRequired: 1,
    },
    servers: [
      {
        id: "snowflake",
        label: "Snowflake",
        status: "attention_required",
        phase: "not_configured",
        outcome: "not_configured",
        terminal: true,
        success: true,
        requiredAction: "replace_saved_secret",
      },
    ],
  });

  assert.equal(attention.title, "MCP server enable needs attention");
  assert.equal(attention.subtitle, "0 servers enabled · 1 needs attention");
  assert.equal(attention.completed, 1);
  assert.equal(attention.rows[0].stage, "not_configured");
});

test("successful enable operations retain completion wording", () => {
  const completed = normalizeOperationSnapshot({
    operationId: "enable-complete-1",
    action: "enable",
    status: "succeeded",
    effectsFinalized: true,
    servers: [
      {
        id: "snowflake",
        status: "succeeded",
        phase: "tool_ready",
        terminal: true,
        success: true,
      },
    ],
  });

  assert.equal(completed.title, "MCP server enable complete");
  assert.equal(completed.subtitle, "1/1 server complete");
});

test("snapshot revision guard rejects stale updates and replaces optimism", () => {
  const optimistic = createOptimisticOperationSnapshot(
    {
      clientRequestId: "client-1",
      kind: "enable",
      serverIds: ["slack"],
    },
    [{ id: "slack", label: "Slack" }],
  );
  const accepted = normalizeOperationSnapshot({
    operationId: "client-1",
    sequence: 0,
    action: "enable",
    status: "running",
    servers: [{ id: "slack", status: "queued" }],
  });
  const newer = normalizeOperationSnapshot({
    operationId: "client-1",
    sequence: 2,
    action: "enable",
    status: "running",
    servers: [{ id: "slack", status: "checking" }],
  });
  const stale = normalizeOperationSnapshot({
    operationId: "client-1",
    sequence: 1,
    action: "enable",
    status: "running",
    servers: [{ id: "slack", status: "queued" }],
  });

  assert.equal(shouldAcceptOperationSnapshot(optimistic, accepted), true);
  assert.equal(shouldAcceptOperationSnapshot(newer, stale), false);
});

test("snapshot revision guard rejects an older operation after a newer one", () => {
  const current = normalizeOperationSnapshot({
    operationId: "new-operation",
    desiredRevision: 4,
    sequence: 1,
    createdAt: 2_000,
    status: "running",
    servers: [{ id: "slack", status: "queued" }],
  });
  const delayed = normalizeOperationSnapshot({
    operationId: "old-operation",
    desiredRevision: 3,
    sequence: 99,
    createdAt: 1_000,
    status: "succeeded",
    servers: [{ id: "slack", status: "succeeded", terminal: true }],
  });

  assert.equal(shouldAcceptOperationSnapshot(current, delayed), false);
});

test("machine probe codes never reach the row detail verbatim", () => {
  const { humanizeRowDetail } = require("../renderer/components/mcp-operation-progress");

  assert.equal(
    humanizeRowDetail("http_503"),
    "Runtime returned HTTP 503 while starting",
  );
  assert.equal(
    humanizeRowDetail("tool_probe_http_502"),
    "Runtime returned HTTP 502 while starting",
  );
  assert.equal(
    humanizeRowDetail("not_discovered"),
    "Waiting for the runtime to publish this server's routes",
  );
  assert.equal(
    humanizeRowDetail("request_timeout"),
    "Readiness check timed out while contacting the runtime",
  );
  assert.equal(
    humanizeRowDetail("aggregator_unavailable"),
    "The MCP runtime is not reachable yet",
  );
  assert.equal(
    humanizeRowDetail("no_callable_tool_paths"),
    "The server has not exposed any tools yet",
  );
  assert.equal(
    humanizeRowDetail("Readiness timed out after 120000ms"),
    "Did not become ready within 120s — the server may have failed to start; check its logs",
  );
  // Anything already human-readable passes through untouched.
  assert.equal(humanizeRowDetail("Starting"), "Starting");
  assert.equal(humanizeRowDetail(""), "");
});

test("non-terminal rows never surface transient probe errors as detail", () => {
  // The scheduler writes each probe's error (http_502/503, timeouts) on every
  // non-terminal tick; a still-starting row must show its stage label, not a
  // scary transient error that usually self-heals (round 9, item 4).
  const view = normalizeOperationSnapshot({
    operationId: "enable-503",
    sequence: 1,
    action: "enable",
    status: "running",
    servers: [
      {
        id: "snowflake",
        label: "Snowflake",
        status: "running",
        phase: "starting",
        error: "http_503",
      },
    ],
  });
  assert.equal(view.rows[0].stage, "starting");
  assert.equal(view.rows[0].terminal, false);
  assert.equal(view.rows[0].detail, "Starting");
});

test("terminal rows humanize http probe errors end to end", () => {
  const view = normalizeOperationSnapshot({
    operationId: "enable-503-terminal",
    sequence: 1,
    action: "enable",
    status: "failed",
    servers: [
      {
        id: "snowflake",
        label: "Snowflake",
        status: "failed",
        phase: "failed",
        terminal: true,
        success: false,
        error: "http_503",
      },
    ],
  });
  assert.equal(view.rows[0].terminal, true);
  assert.equal(view.rows[0].detail, "Runtime returned HTTP 503 while starting");
});

test("not-configured rows render their actionable configuration message", () => {
  const view = normalizeOperationSnapshot({
    operationId: "enable-invalid-yaml",
    sequence: 3,
    action: "enable",
    status: "attention_required",
    servers: [
      {
        id: "broken-yaml",
        label: "Broken YAML",
        status: "attention_required",
        phase: "not_configured",
        outcome: "not_configured",
        terminal: true,
        requiredAction: "configure",
        configurationErrorCode: "INVALID_USER_SERVER_CONFIG",
        configurationMessage:
          "invalid YAML in /tmp/broken-yaml.yaml: expected ',' or ']' at line 2 column 1",
      },
    ],
  });

  assert.equal(view.rows[0].stage, "not_configured");
  assert.equal(view.rows[0].stageLabel, "Needs configuration");
  assert.equal(
    view.rows[0].detail,
    "invalid YAML in /tmp/broken-yaml.yaml: expected ',' or ']' at line 2 column 1",
  );
  assert.equal(view.rows[0].attention, true);
});

test("startup_failed rows render a terminal attention fail state", () => {
  const view = normalizeOperationSnapshot({
    operationId: "enable-fatal",
    sequence: 2,
    action: "enable",
    status: "failed",
    servers: [
      {
        id: "snowflake",
        label: "Snowflake",
        status: "failed",
        phase: "startup_failed",
        terminal: true,
        success: false,
        error:
          "Failed to start. The runtime kept returning HTTP 503 while starting. Logs indicate a credential error (rejected token or failed authentication) — fix the credential and re-enable. Check the server logs for details.",
      },
    ],
  });
  const row = view.rows[0];
  assert.equal(row.stage, "startup_failed");
  assert.equal(row.stageLabel, "Failed to start");
  assert.equal(row.terminal, true);
  assert.equal(row.attention, true);
  assert.equal(row.terminalState, "failed");
  assert.match(row.detail, /credential error/);
  assert.equal(view.attention, true);
});

test("startup_failed stage meta is terminal with a failed health status", () => {
  const { getStageMeta, isTerminalStage } = require("../renderer/components/mcp-operation-progress");
  const meta = getStageMeta("startup_failed");
  assert.equal(meta.label, "Failed to start");
  assert.equal(meta.terminal, true);
  assert.equal(meta.healthStatus, "failed");
  assert.equal(isTerminalStage("startup_failed"), true);
});
