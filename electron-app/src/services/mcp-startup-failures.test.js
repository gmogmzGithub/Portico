const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  clearStartupFailure,
  discoverInstalledMcpServerIds,
  getManagedNodePackagePreparationStatusPath,
  loadManagedNodePackagePreparationFailures,
  loadStartupFailures,
  overlayStartupFailures,
  recordStartupFailure,
} = require("./mcp-startup-failures");

function writeServerConfig(root, scope, serverId) {
  const serverDir = path.join(root, scope, serverId);
  fs.mkdirSync(serverDir, { recursive: true });
  fs.writeFileSync(path.join(serverDir, `${serverId}.yaml`), "deployment_type: docker\n");
}

test("recordStartupFailure stores durable per-server startup failures", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "startup-failure-"));
  try {
    const failure = recordStartupFailure(projectRoot, {
      serverId: "user-snowflake-cortex",
      operation: "enable",
      stage: "config_generation",
      source: "config",
      error: "Invalid JSON in fragment for user-snowflake-cortex: trailing comma at line 8 column 3",
      configPath:
        "/tmp/project/mcp-configs-user/user-snowflake-cortex/user-snowflake-cortex.fragment",
    });

    assert.equal(failure.serverId, "user-snowflake-cortex");
    assert.equal(failure.stage, "config_generation");

    const failures = loadStartupFailures(projectRoot);
    assert.equal(
      failures["user-snowflake-cortex"].error,
      "Invalid JSON in fragment for user-snowflake-cortex: trailing comma at line 8 column 3",
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("overlayStartupFailures overlays persisted failures over stale disabled health", () => {
  const health = {
    servers: {
      "user-snowflake-cortex": {
        status: "disabled",
        disabled_by_user: true,
      },
      "assumeapi-product": {
        status: "starting",
      },
    },
    summary: {
      total: 2,
      disabled: 1,
      starting: 1,
    },
  };

  const overlaid = overlayStartupFailures(health, "/tmp/project", {
    knownServerIds: ["user-snowflake-cortex", "assumeapi-product"],
    failures: {
      "user-snowflake-cortex": {
        serverId: "user-snowflake-cortex",
        operation: "enable",
        stage: "config_generation",
        source: "config",
        error: "Invalid JSON in fragment for user-snowflake-cortex: trailing comma at line 8 column 3",
      },
      "assumeapi-product": {
        serverId: "assumeapi-product",
        operation: "enable",
        stage: "runtime_start",
        source: "container",
        error: "Container did not reach running state",
      },
    },
  });

  assert.equal(overlaid.servers["user-snowflake-cortex"].status, "failed");
  assert.equal(overlaid.servers["user-snowflake-cortex"].disabled_by_user, false);
  assert.equal(overlaid.servers["user-snowflake-cortex"].disabled_reason, null);
  assert.equal(
    overlaid.servers["user-snowflake-cortex"].startup_failure.error,
    "Invalid JSON in fragment for user-snowflake-cortex: trailing comma at line 8 column 3",
  );
  assert.equal(overlaid.servers["assumeapi-product"].status, "failed");
  assert.equal(
    overlaid.servers["assumeapi-product"].error,
    "Container did not reach running state",
  );
  assert.equal(overlaid.summary.failed, 2);
  assert.equal(overlaid.summary.starting, 0);
  assert.equal(overlaid.summary.disabled, 0);
});

test("overlayStartupFailures maps managed Node preparation failures to server startup failures", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "startup-failure-"));
  try {
    writeServerConfig(projectRoot, "mcp-configs", "gitlab-mcp");
    const statusPath = getManagedNodePackagePreparationStatusPath(projectRoot);
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(
      statusPath,
      JSON.stringify({
        version: 1,
        updated_at: "2026-07-01T02:43:10Z",
        best_effort: true,
        deployment_type: "docker",
        prepared: [],
        failures: {
          "gitlab-mcp": {
            server_id: "gitlab-mcp",
            package_spec: "@zereight/mcp-gitlab@2.1.11",
            package_name: "@zereight/mcp-gitlab",
            error: "managed Node direct npm preparation requires executable npm at /usr/local/bin/npm",
            timestamp: "2026-07-01T02:43:10Z",
            deployment_type: "docker",
          },
        },
      }),
      "utf8",
    );

    const overlaid = overlayStartupFailures(
      { servers: { "gitlab-mcp": { status: "starting" } }, summary: {} },
      projectRoot,
    );

    assert.equal(overlaid.servers["gitlab-mcp"].status, "failed");
    assert.equal(
      overlaid.servers["gitlab-mcp"].startup_failure.errorCode,
      "MANAGED_NODE_PACKAGE_PREPARATION_FAILED",
    );
    assert.match(
      overlaid.servers["gitlab-mcp"].error,
      /@zereight\/mcp-gitlab@2\.1\.11/,
    );
    assert.equal(overlaid.summary.failed, 1);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("overlayStartupFailures does not let stale managed Node prep failures override healthy servers", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "startup-failure-"));
  try {
    writeServerConfig(projectRoot, "mcp-configs", "gitlab-mcp");
    const statusPath = getManagedNodePackagePreparationStatusPath(projectRoot);
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(
      statusPath,
      JSON.stringify({
        version: 1,
        updated_at: "2026-07-01T02:43:10Z",
        best_effort: true,
        failures: {
          "gitlab-mcp": {
            server_id: "gitlab-mcp",
            package_spec: "@zereight/mcp-gitlab@2.1.11",
            error: "previous package preparation failure",
            timestamp: "2026-07-01T02:43:10Z",
          },
        },
      }),
      "utf8",
    );

    const overlaid = overlayStartupFailures(
      {
        servers: {
          "gitlab-mcp": {
            status: "healthy",
            healthy: true,
            running: true,
          },
        },
        summary: { total: 1, healthy: 1 },
      },
      projectRoot,
    );

    assert.equal(overlaid.servers["gitlab-mcp"].status, "healthy");
    assert.equal(overlaid.servers["gitlab-mcp"].startup_failure, undefined);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("generated server config status supersedes managed Node preparation failures", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "startup-failure-"));
  try {
    writeServerConfig(projectRoot, "mcp-configs-user", "broken-node");
    const statusPath = getManagedNodePackagePreparationStatusPath(projectRoot);
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(
      statusPath,
      JSON.stringify({
        version: 1,
        updated_at: "2026-07-01T02:43:10Z",
        failures: {
          "broken-node": {
            server_id: "broken-node",
            package_spec: "unknown",
            error: "npm recipe must use exec, not start",
          },
        },
      }),
      "utf8",
    );
    const generatedDir = path.join(projectRoot, "mcpo-configs-generated");
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(
      path.join(generatedDir, "server-config-status.json"),
      JSON.stringify({
        servers: {
          "broken-node": {
            configured: false,
            status: "not_configured",
            error: "UNSUPPORTED_NPM_SUBCOMMAND: npm recipe must use exec, not start",
            error_code: "UNSUPPORTED_NPM_SUBCOMMAND",
            source: "fragment",
            stage: "config_generation",
          },
        },
      }),
      "utf8",
    );

    const overlaid = overlayStartupFailures(
      { servers: { "broken-node": { status: "starting" } }, summary: {} },
      projectRoot,
    );

    assert.equal(overlaid.servers["broken-node"].status, "not_configured");
    assert.equal(overlaid.servers["broken-node"].configured, false);
    assert.equal(
      overlaid.servers["broken-node"].error_code,
      "UNSUPPORTED_NPM_SUBCOMMAND",
    );
    assert.equal(
      overlaid.servers["broken-node"].configuration_source,
      "fragment",
    );
    assert.equal(overlaid.servers["broken-node"].startup_failure, undefined);
    assert.equal(overlaid.summary.not_configured, 1);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("managed Node preparation failures aggregate Docker and host status files", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "startup-failure-"));
  try {
    const healthDir = path.join(projectRoot, "health-status");
    fs.mkdirSync(healthDir, { recursive: true });
    for (const [fileName, serverId, deploymentType] of [
      ["managed_node_package_preparation.json", "docker-node", "docker"],
      ["managed_node_package_preparation-host.json", "host-node", "host"],
    ]) {
      fs.writeFileSync(
        path.join(healthDir, fileName),
        JSON.stringify({
          deployment_type: deploymentType,
          failures: {
            [serverId]: {
              server_id: serverId,
              package_spec: "demo@1.0.0",
              error: `${deploymentType} preparation failed`,
            },
          },
        }),
        "utf8",
      );
    }

    const failures = loadManagedNodePackagePreparationFailures(projectRoot);
    assert.equal(failures["docker-node"].deploymentType, "docker");
    assert.equal(failures["host-node"].deploymentType, "host");
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("discoverInstalledMcpServerIds reads system and user MCP config catalogs", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "startup-failure-"));
  try {
    writeServerConfig(projectRoot, "mcp-configs", "core-demo");
    writeServerConfig(projectRoot, "mcp-configs-user", "user-demo");

    const ids = discoverInstalledMcpServerIds(projectRoot);

    assert.equal(ids.has("core-demo"), true);
    assert.equal(ids.has("user-demo"), true);
    assert.equal(ids.has("deleted-demo"), false);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("overlayStartupFailures ignores and prunes stale failures for deleted servers", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "startup-failure-"));
  try {
    writeServerConfig(projectRoot, "mcp-configs-user", "installed-demo");
    recordStartupFailure(projectRoot, {
      serverId: "installed-demo",
      error: "Container did not reach running state",
      source: "container",
      stage: "runtime_start",
    });
    recordStartupFailure(projectRoot, {
      serverId: "deleted-demo",
      error: "Docker Compose service \"mcpo-deleted-demo\" not found",
      source: "config",
      stage: "config_generation",
    });

    const overlaid = overlayStartupFailures(
      { servers: { "installed-demo": { status: "starting" } }, summary: {} },
      projectRoot,
    );

    assert.equal(overlaid.servers["installed-demo"].status, "failed");
    assert.equal(overlaid.servers["deleted-demo"], undefined);
    assert.equal(overlaid.startup_failures["deleted-demo"], undefined);
    assert.equal(loadStartupFailures(projectRoot)["installed-demo"].serverId, "installed-demo");
    assert.equal(loadStartupFailures(projectRoot)["deleted-demo"], undefined);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("overlayStartupFailures prunes compose startup failures when runtime files are not configured", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "startup-failure-"));
  try {
    writeServerConfig(projectRoot, "mcp-configs", "runtime-demo");
    const generatedDir = path.join(projectRoot, "mcpo-configs-generated");
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(
      path.join(generatedDir, "runtime-file-status.json"),
      JSON.stringify({
        servers: {
          "runtime-demo": {
            configured: false,
            status: "not_configured",
            error: "Missing runtime file: ./runtime/mcp_config.yaml",
          },
        },
      }),
      "utf8",
    );
    recordStartupFailure(projectRoot, {
      serverId: "runtime-demo",
      error: 'Docker Compose service "mcpo-runtime-demo" not found after config regeneration.',
      source: "config",
      stage: "config_generation",
      errorCode: "SERVICE_NOT_FOUND",
    });

    const overlaid = overlayStartupFailures(
      {
        servers: {
          "runtime-demo": {
            status: "failed",
            configured: true,
            error:
              'Docker Compose service "mcpo-runtime-demo" not found after config regeneration.',
            startup_failure: {
              serverId: "runtime-demo",
              error:
                'Docker Compose service "mcpo-runtime-demo" not found after config regeneration.',
            },
          },
        },
        summary: {},
      },
      projectRoot,
    );

    assert.equal(overlaid.servers["runtime-demo"].status, "not_configured");
    assert.equal(overlaid.servers["runtime-demo"].startup_failure, undefined);
    assert.equal(overlaid.summary.not_configured, 1);
    assert.equal(loadStartupFailures(projectRoot)["runtime-demo"], undefined);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("authoritative server config status overrides stale runtime file status", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "startup-failure-"));
  try {
    writeServerConfig(projectRoot, "mcp-configs", "runtime-demo");
    const generatedDir = path.join(projectRoot, "mcpo-configs-generated");
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(
      path.join(generatedDir, "runtime-file-status.json"),
      JSON.stringify({
        servers: {
          "runtime-demo": {
            configured: false,
            status: "not_configured",
            error: "stale missing runtime file",
          },
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(generatedDir, "server-config-status.json"),
      JSON.stringify({
        servers: {
          "runtime-demo": {
            configured: true,
            status: "configured",
            error: "",
          },
        },
      }),
      "utf8",
    );
    recordStartupFailure(projectRoot, {
      serverId: "runtime-demo",
      error: "Container did not reach running state",
      source: "container",
      stage: "runtime_start",
    });

    const overlaid = overlayStartupFailures(
      { servers: { "runtime-demo": { status: "starting" } }, summary: {} },
      projectRoot,
    );

    assert.equal(overlaid.servers["runtime-demo"].status, "failed");
    assert.equal(
      loadStartupFailures(projectRoot)["runtime-demo"].error,
      "Container did not reach running state",
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("clearStartupFailure removes stale startup failure overlays", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "startup-failure-"));
  try {
    recordStartupFailure(projectRoot, {
      serverId: "assumeapi-product",
      error: "Container did not reach running state",
      source: "container",
      stage: "runtime_start",
    });
    assert.equal(Boolean(loadStartupFailures(projectRoot)["assumeapi-product"]), true);

    assert.equal(clearStartupFailure(projectRoot, "assumeapi-product"), true);
    assert.equal(Boolean(loadStartupFailures(projectRoot)["assumeapi-product"]), false);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
