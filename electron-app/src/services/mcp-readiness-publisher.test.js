const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  McpReadinessPublisher,
  acquireHealthStatusWriteLock,
} = require("./mcp-readiness-publisher");

test("readiness publication serializes atomic health merges and broadcasts", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-readiness-publisher-"));
  const healthStatusPath = path.join(dir, "health-status", "health_status.json");
  await fs.writeFile(
    path.join(dir, "mcp_toggles.json"),
    '{"slack":true,"snowflake":true}\n',
  );
  await fs.mkdir(path.dirname(healthStatusPath), { recursive: true });
  await fs.writeFile(
    healthStatusPath,
    JSON.stringify({
      timestamp: 1,
      timestamp_iso: "1970-01-01T00:00:01.000Z",
      servers: {
        slack: {
          status: "failed",
          startup_failure: { error: "old failure" },
          startup_failure_source: "config",
          startup_failure_stage: "config_generation",
          startup_failure_timestamp: "1970-01-01T00:00:01.000Z",
          container_name: "mcpo-single-slack",
          config_path: "/tmp/stale.yaml",
          oauth_state: "waiting_callback",
          authorization_url_available: true,
          disabled_by_user: true,
          disabled_reason: "stale",
        },
      },
      summary: {},
      sync: {},
    }),
  );
  const broadcasts = [];
  const publisher = new McpReadinessPublisher({
    getProjectRoot: () => dir,
    broadcast: async (health) => broadcasts.push(health),
  });

  try {
    await Promise.all([
      publisher.publish({
        serverId: "slack",
        deploymentType: "docker",
        phase: "tool_ready",
        providerReadiness: "ready",
        healthy: true,
        toolsCount: 5,
        operationId: "op-1",
        desiredRevision: 2,
        transitionSequence: 3,
      }, { operationId: "op-1" }),
      publisher.publish({
        serverId: "snowflake",
        deploymentType: "docker",
        phase: "needs_oauth",
        healthy: false,
        operationId: "op-1",
        desiredRevision: 2,
        transitionSequence: 2,
      }, { operationId: "op-1" }),
    ]);

    const persisted = JSON.parse(await fs.readFile(healthStatusPath, "utf8"));
    assert.equal(persisted.servers.slack.status, "healthy");
    assert.equal(persisted.servers.slack.provider_readiness, "ready");
    assert.equal(persisted.servers.snowflake.status, "needs_oauth");
    assert.equal(persisted.summary.total, 2);
    assert.equal(persisted.summary.healthy, 1);
    assert.equal(persisted.summary.needs_oauth, 1);
    assert.ok(persisted.timestamp > 1);
    assert.notEqual(persisted.timestamp_iso, "1970-01-01T00:00:01.000Z");
    assert.equal(persisted.servers.slack.startup_failure, undefined);
    assert.equal(persisted.servers.slack.container_name, undefined);
    assert.equal(persisted.servers.slack.config_path, undefined);
    assert.equal(persisted.servers.slack.oauth_state, "completed");
    assert.equal(persisted.servers.slack.authorization_url_available, false);
    assert.equal(persisted.servers.slack.disabled_by_user, false);
    assert.equal(persisted.servers.slack.disabled_reason, null);
    assert.equal(broadcasts.length, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("health status write lock serializes independent publishers", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-health-lock-"));
  const lockPath = path.join(dir, "health_status.json.lock");
  try {
    const releaseFirst = await acquireHealthStatusWriteLock(lockPath);
    let secondAcquired = false;
    const second = acquireHealthStatusWriteLock(lockPath, {
      timeoutMs: 1_000,
      retryMs: 5,
    }).then((release) => {
      secondAcquired = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(secondAcquired, false);
    await releaseFirst();
    const releaseSecond = await second;
    assert.equal(secondAcquired, true);
    await releaseSecond();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("not-configured readiness publication keeps its actionable error", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-readiness-publisher-"));
  const healthStatusPath = path.join(dir, "health-status", "health_status.json");
  await fs.writeFile(path.join(dir, "mcp_toggles.json"), '{"broken-yaml":true}\n');
  const publisher = new McpReadinessPublisher({
    getProjectRoot: () => dir,
  });

  try {
    await publisher.publish({
      serverId: "broken-yaml",
      deploymentType: "docker",
      phase: "not_configured",
      configured: false,
      healthy: false,
      requiredAction: "configure",
      error:
        "invalid YAML in /tmp/broken-yaml.yaml: expected ',' or ']' at line 2 column 1",
    });

    const persisted = JSON.parse(await fs.readFile(healthStatusPath, "utf8"));
    assert.equal(persisted.servers["broken-yaml"].status, "not_configured");
    assert.equal(persisted.servers["broken-yaml"].configured, false);
    assert.equal(
      persisted.servers["broken-yaml"].error,
      "invalid YAML in /tmp/broken-yaml.yaml: expected ',' or ']' at line 2 column 1",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("empty flock-style leftover lock file is reclaimed after the grace period", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-health-lock-"));
  const lockPath = path.join(dir, "health_status.json.lock");
  try {
    // The Rust health-check writer leaves an empty lock file behind after
    // releasing its flock; Node must not treat it as held forever.
    await fs.writeFile(lockPath, "");
    const release = await acquireHealthStatusWriteLock(lockPath, {
      timeoutMs: 3_000,
      retryMs: 5,
      flockGraceMs: 50,
    });
    const content = await fs.readFile(lockPath, "utf8");
    assert.match(content, new RegExp(`^${process.pid} `));
    await release();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("fresh empty lock file is honored during the flock grace period", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-health-lock-"));
  const lockPath = path.join(dir, "health_status.json.lock");
  try {
    await fs.writeFile(lockPath, "");
    await assert.rejects(
      acquireHealthStatusWriteLock(lockPath, {
        flockGraceMs: 10_000,
        timeoutMs: 200,
        retryMs: 5,
      }),
      (error) => error.code === "MCP_HEALTH_STATUS_LOCK_TIMEOUT",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("lock held by a dead pid is reclaimed immediately", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-health-lock-"));
  const lockPath = path.join(dir, "health_status.json.lock");
  try {
    await fs.writeFile(lockPath, `999999999 ${Date.now()}\n`);
    const startedAt = Date.now();
    const release = await acquireHealthStatusWriteLock(lockPath, {
      retryMs: 5,
    });
    assert.ok(
      Date.now() - startedAt < 1_000,
      "dead-pid lock should be reclaimed without waiting for staleMs",
    );
    await release();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("lock held by a live pid is honored until timeout", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-health-lock-"));
  const lockPath = path.join(dir, "health_status.json.lock");
  try {
    const originalContent = `${process.pid} ${Date.now()}\n`;
    await fs.writeFile(lockPath, originalContent);
    await assert.rejects(
      acquireHealthStatusWriteLock(lockPath, {
        timeoutMs: 200,
        retryMs: 5,
      }),
      (error) => error.code === "MCP_HEALTH_STATUS_LOCK_TIMEOUT",
    );
    assert.equal(await fs.readFile(lockPath, "utf8"), originalContent);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
