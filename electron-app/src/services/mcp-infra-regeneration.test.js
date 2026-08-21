const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  getControlPlanePrograms,
  getControlPlaneWaitTargets,
  getMcpControlPlaneNginxReloadCommand,
  getMcpControlPlaneNginxTestCommand,
  getMcpControlPlaneRefreshCommand,
  getMcpInfraRegenerationCommand,
  invalidateMcpAggregatorCaches,
  refreshMcpControlPlane,
  waitForControlPlaneReady,
  regenerateMcpInfrastructure,
} = require("./mcp-infra-regeneration");

function makeProjectWithDebugBinary() {
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "mcp-infra-regeneration-"),
  );
  const sourceDir = path.join(
    projectRoot,
    "src",
    "mcp-orc-rust",
    "crates",
    "mcp-orc",
    "src",
  );
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, "src", "mcp-orc-rust", "Cargo.toml"),
    "[workspace]\n",
    "utf8",
  );
  fs.writeFileSync(path.join(sourceDir, "main.rs"), "fn main() {}\n", "utf8");
  const binaryPath = path.join(
    projectRoot,
    "src",
    "mcp-orc-rust",
    "target",
    "debug",
    "mcp-orc",
  );
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
  fs.writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n", "utf8");
  fs.chmodSync(binaryPath, 0o755);
  return { projectRoot, binaryPath };
}

function makeProjectWithoutBinary() {
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "mcp-infra-regeneration-bootstrap-"),
  );
  const sourceDir = path.join(
    projectRoot,
    "src",
    "mcp-orc-rust",
    "crates",
    "mcp-orc",
    "src",
  );
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, "src", "mcp-orc-rust", "Cargo.toml"),
    "[workspace]\n",
    "utf8",
  );
  fs.writeFileSync(path.join(sourceDir, "main.rs"), "fn main() {}\n", "utf8");
  const scriptPath = path.join(
    projectRoot,
    "src",
    "scripts",
    "build-host-mcp-binaries.sh",
  );
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, "#!/bin/sh\nexit 0\n", "utf8");
  const binaryPath = path.join(
    projectRoot,
    "host-mcp-binaries",
    process.platform === "darwin"
      ? process.arch === "arm64"
        ? "aarch64-apple-darwin"
        : "x86_64-apple-darwin"
      : process.arch === "arm64"
        ? "aarch64-unknown-linux-gnu"
        : "x86_64-unknown-linux-gnu",
    "mcp-orc",
  );
  return { projectRoot, binaryPath, scriptPath };
}

test("getMcpInfraRegenerationCommand uses the mcp-orc infra generator CLI", () => {
  const { projectRoot, binaryPath } = makeProjectWithDebugBinary();

  assert.equal(
    getMcpInfraRegenerationCommand(projectRoot),
    `"${binaryPath}" "generate-docker-compose-override" "--project-root" "${projectRoot}"`,
  );
  assert.equal(
    getMcpInfraRegenerationCommand(projectRoot, { force: true }),
    `"${binaryPath}" "generate-docker-compose-override" "--force" "--project-root" "${projectRoot}"`,
  );

  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("regenerateMcpInfrastructure invokes execAsync with project-root cwd", async () => {
  const { projectRoot, binaryPath } = makeProjectWithDebugBinary();
  const calls = [];
  const execAsync = async (command, options) => {
    calls.push({ command, options });
    return { stdout: "", stderr: "" };
  };

  await regenerateMcpInfrastructure(execAsync, projectRoot, { PATH: "/bin" }, {
    force: true,
    timeout: 1234,
  });

  assert.deepEqual(calls, [
    {
      command: `"${binaryPath}" "generate-docker-compose-override" "--force" "--project-root" "${projectRoot}"`,
      options: {
        cwd: projectRoot,
        env: { PATH: "/bin" },
        timeout: 1234,
      },
    },
  ]);

  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("regenerateMcpInfrastructure re-ensures MCP create_dirs before invoking the generator", async () => {
  const { projectRoot } = makeProjectWithDebugBinary();
  const serverDir = path.join(projectRoot, "mcp-configs", "snowflake");
  fs.mkdirSync(serverDir, { recursive: true });
  fs.writeFileSync(
    path.join(serverDir, "snowflake.yaml"),
    "id: snowflake\ncreate_dirs:\n  - runtime-cache\n",
    "utf8",
  );
  const ensuredDir = path.join(projectRoot, "runtime-cache");
  const execAsync = async () => ({ stdout: "", stderr: "" });

  await regenerateMcpInfrastructure(execAsync, projectRoot, { PATH: "/bin" }, {});
  assert.equal(fs.statSync(ensuredDir).isDirectory(), true);

  // Restart-all / per-server / toggle flows regenerate again after the user
  // deleted the directory mid-session; it must come back.
  fs.rmSync(ensuredDir, { recursive: true, force: true });
  await regenerateMcpInfrastructure(execAsync, projectRoot, { PATH: "/bin" }, {});
  assert.equal(fs.statSync(ensuredDir).isDirectory(), true);

  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("regenerateMcpInfrastructure bootstraps mcp-orc before executing the generator in dev mode", async () => {
  const { projectRoot, binaryPath, scriptPath } = makeProjectWithoutBinary();
  const calls = [];
  const execAsync = async (command, options) => {
    calls.push({ command, options });
    if (command.includes("build-host-mcp-binaries.sh")) {
      fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
      fs.writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n", "utf8");
      fs.chmodSync(binaryPath, 0o755);
    }
    return { stdout: "", stderr: "" };
  };

  await regenerateMcpInfrastructure(execAsync, projectRoot, { PATH: "/bin" }, {
    force: true,
    timeout: 1234,
    isPackagedApp: false,
  });

  assert.equal(calls.length, 2);
  assert.ok(calls[0].command.startsWith("bash "));
  assert.ok(calls[0].command.includes(scriptPath));
  assert.ok(calls[0].command.endsWith(" --host-only"));
  assert.deepEqual(calls[0].options, {
    cwd: projectRoot,
    env: { PATH: "/bin" },
    timeout: 900000,
  });
  assert.deepEqual(calls[1], {
    command: `"${binaryPath}" "generate-docker-compose-override" "--force" "--project-root" "${projectRoot}"`,
    options: {
      cwd: projectRoot,
      env: { PATH: "/bin" },
      timeout: 1234,
    },
  });

  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("regenerateMcpInfrastructure coalesces identical concurrent requests", async () => {
  const { projectRoot, binaryPath } = makeProjectWithDebugBinary();
  const calls = [];
  let resolveExec;
  const execAsync = (command, options) => {
    calls.push({ command, options });
    return new Promise((resolve) => {
      resolveExec = () => resolve({ stdout: "ok", stderr: "" });
    });
  };

  const first = regenerateMcpInfrastructure(
    execAsync,
    projectRoot,
    { PATH: "/bin" },
    { force: true, timeout: 2000 },
  );
  const second = regenerateMcpInfrastructure(
    execAsync,
    projectRoot,
    { PATH: "/bin" },
    { force: true, timeout: 2000 },
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].command,
    `"${binaryPath}" "generate-docker-compose-override" "--force" "--project-root" "${projectRoot}"`,
  );
  resolveExec();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(firstResult, { stdout: "ok", stderr: "" });
  assert.deepEqual(secondResult, { stdout: "ok", stderr: "" });
  assert.equal(calls.length, 1);

  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("getMcpControlPlaneRefreshCommand targets supervisor-managed control-plane programs", () => {
  assert.equal(
    getMcpControlPlaneRefreshCommand(),
    "docker exec mcpo supervisorctl -s unix:///tmp/supervisor.sock restart aggregator-regular aggregator-core",
  );
});

test("getControlPlanePrograms scopes refresh to the affected aggregator tier", () => {
  assert.deepEqual(getControlPlanePrograms({ includeCore: false }), [
    "aggregator-regular",
  ]);
  assert.deepEqual(getControlPlanePrograms({ includeRegular: false }), [
    "aggregator-core",
  ]);
  assert.deepEqual(
    getControlPlanePrograms({ includeRegular: false, includeCore: false }),
    [],
  );
});

test("getMcpControlPlaneRefreshCommand supports regular-only refreshes", () => {
  assert.equal(
    getMcpControlPlaneRefreshCommand({ includeCore: false }),
    "docker exec mcpo supervisorctl -s unix:///tmp/supervisor.sock restart aggregator-regular",
  );
});

test("getMcpControlPlaneNginxReloadCommand uses graceful nginx reload", () => {
  assert.equal(
    getMcpControlPlaneNginxReloadCommand(),
    "docker exec mcpo nginx -s reload",
  );
});

test("getControlPlaneWaitTargets scopes readiness checks to selected tiers", () => {
  assert.deepEqual(getControlPlaneWaitTargets(), [
    "http://127.0.0.1:8765/openapi.json",
    "http://127.0.0.1:8766/openapi.json",
  ]);
  assert.deepEqual(getControlPlaneWaitTargets({ includeCore: false }), [
    "http://127.0.0.1:8765/openapi.json",
  ]);
  assert.deepEqual(getControlPlaneWaitTargets({ includeRegular: false }), [
    "http://127.0.0.1:8766/openapi.json",
  ]);
  assert.deepEqual(
    getControlPlaneWaitTargets({ includeRegular: false, includeCore: false }),
    [],
  );
});

test("getControlPlaneWaitTargets includes the server route when a single tier is refreshed", () => {
  assert.deepEqual(
    getControlPlaneWaitTargets({
      includeCore: false,
      serverId: "google_workspace",
    }),
    [
      "http://127.0.0.1:8765/openapi.json",
      "http://127.0.0.1:8765/google_workspace/openapi.json",
    ],
  );
  assert.deepEqual(
    getControlPlaneWaitTargets({
      includeRegular: false,
      serverId: "agent-vm",
    }),
    [
      "http://127.0.0.1:8766/openapi.json",
      "http://127.0.0.1:8766/agent-vm/openapi.json",
    ],
  );
  assert.deepEqual(
    getControlPlaneWaitTargets({
      serverId: "google_workspace",
    }),
    [
      "http://127.0.0.1:8765/openapi.json",
      "http://127.0.0.1:8766/openapi.json",
    ],
  );
});

test("getControlPlaneWaitTargets skips the server route when disable flows request it", () => {
  assert.deepEqual(
    getControlPlaneWaitTargets({
      includeCore: false,
      serverId: "google_workspace",
      serverRouteWait: "skip",
    }),
    ["http://127.0.0.1:8765/openapi.json"],
  );
});

test("waitForControlPlaneReady polls until all selected endpoints are healthy", async () => {
  const seen = [];
  const attempts = new Map();
  const fetchImpl = async (url) => {
    seen.push(url);
    const count = (attempts.get(url) || 0) + 1;
    attempts.set(url, count);
    if (count < 2) {
      throw new Error("connection refused");
    }
    return { ok: true, status: 200 };
  };

  const result = await waitForControlPlaneReady({
    fetchImpl,
    pollIntervalMs: 0,
    readinessTimeoutMs: 2000,
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.targets, [
    "http://127.0.0.1:8765/openapi.json",
    "http://127.0.0.1:8766/openapi.json",
  ]);
  assert.ok(seen.length >= 4);
});

test("refreshMcpControlPlane invalidates caches, tests config, reloads nginx, and waits for the server route", async () => {
  const calls = [];
  const fetchRequests = [];
  const execAsync = async (command, options) => {
    calls.push({ command, options });
    return { stdout: "", stderr: "" };
  };
  const fetchImpl = async (url, options) => {
    fetchRequests.push({ url, options });
    if (options?.method === "POST") {
      return { ok: true, status: 200 };
    }
    return { ok: true, status: 200 };
  };

  const result = await refreshMcpControlPlane(
    execAsync,
    "/tmp/project",
    { PATH: "/bin" },
    {
      fetchImpl,
      includeCore: false,
      serverId: "google_workspace",
      pollIntervalMs: 0,
      sleep: () => Promise.resolve(),
    },
  );

  assert.deepEqual(calls, [
    {
      command: "docker exec mcpo nginx -t",
      options: {
        cwd: "/tmp/project",
        env: { PATH: "/bin" },
        timeout: 10000,
      },
    },
    {
      command: "docker exec mcpo nginx -s reload",
      options: {
        cwd: "/tmp/project",
        env: { PATH: "/bin" },
        timeout: 30000,
      },
    },
  ]);
  assert.deepEqual(
    fetchRequests.map((request) => request.url),
    [
      "http://127.0.0.1:8765/internal/cache/invalidate",
      "http://127.0.0.1:8765/openapi.json",
      "http://127.0.0.1:8765/google_workspace/openapi.json",
    ],
  );
  assert.equal(result.success, true);
  assert.equal(result.mode, "nginx-reload");
});

test("refreshMcpControlPlane skips removed server routes during disable refreshes", async () => {
  const fetchRequests = [];
  const execAsync = async () => ({ stdout: "", stderr: "" });
  const fetchImpl = async (url, options) => {
    fetchRequests.push({ url, options });
    return { ok: true, status: 200 };
  };

  const result = await refreshMcpControlPlane(
    execAsync,
    "/tmp/project",
    { PATH: "/bin" },
    {
      fetchImpl,
      includeCore: false,
      serverId: "google_workspace",
      serverRouteWait: "skip",
      pollIntervalMs: 0,
      sleep: () => Promise.resolve(),
    },
  );

  assert.deepEqual(
    fetchRequests.map((request) => request.url),
    [
      "http://127.0.0.1:8765/internal/cache/invalidate",
      "http://127.0.0.1:8765/openapi.json",
    ],
  );
  assert.equal(result.success, true);
  assert.equal(result.mode, "nginx-reload");
});

test("getMcpControlPlaneNginxTestCommand validates config without reloading", () => {
  assert.equal(
    getMcpControlPlaneNginxTestCommand(),
    "docker exec mcpo nginx -t",
  );
  assert.equal(
    getMcpControlPlaneNginxTestCommand({ controlPlaneContainer: "my-proxy" }),
    "docker exec my-proxy nginx -t",
  );
});

test("refreshMcpControlPlane continues through nginx reload when cache invalidation fails", async () => {
  const calls = [];
  const warnings = [];
  const execAsync = async (command, options) => {
    calls.push({ command, options });
    return { stdout: "", stderr: "" };
  };
  const fetchImpl = async (url, options) => {
    if (options?.method === "POST") {
      throw new Error("connection reset");
    }
    return { ok: true, status: 200 };
  };

  const result = await refreshMcpControlPlane(
    execAsync,
    "/tmp/project",
    { PATH: "/bin" },
    {
      fetchImpl,
      includeCore: false,
      serverId: "google_workspace",
      pollIntervalMs: 0,
      sleep: () => Promise.resolve(),
      logger: {
        warn(message) {
          warnings.push(message);
        },
      },
    },
  );

  assert.deepEqual(calls, [
    {
      command: "docker exec mcpo nginx -t",
      options: {
        cwd: "/tmp/project",
        env: { PATH: "/bin" },
        timeout: 10000,
      },
    },
    {
      command: "docker exec mcpo nginx -s reload",
      options: {
        cwd: "/tmp/project",
        env: { PATH: "/bin" },
        timeout: 30000,
      },
    },
  ]);
  assert.equal(result.success, true);
  assert.equal(result.cacheInvalidation.success, false);
  assert.equal(result.mode, "nginx-reload");
  assert.ok(
    warnings.some((message) => /continuing with control-plane refresh/.test(message)),
  );
});

test("refreshMcpControlPlane falls back to recreating mcpo when process refresh fails", async () => {
  const calls = [];
  const warnings = [];
  const execAsync = async (command, options) => {
    calls.push({ command, options });
    if (command.includes("supervisorctl")) {
      throw new Error("supervisor unavailable");
    }
    return { stdout: "", stderr: "" };
  };
  const fetchImpl = async (url, options) => {
    if (options?.method === "POST") {
      return { ok: true, status: 200 };
    }

    if (url === "http://127.0.0.1:8765/openapi.json") {
      return { ok: true, status: 200 };
    }

    if (url === "http://127.0.0.1:8765/google_workspace/openapi.json") {
      const recreated = calls.some((call) =>
        call.command.includes("up-container mcpo"),
      );
      return { ok: recreated, status: recreated ? 200 : 404 };
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  await refreshMcpControlPlane(
    execAsync,
    "/tmp/project",
    { PATH: "/bin" },
    {
      fetchImpl,
      includeCore: false,
      serverId: "google_workspace",
      pollIntervalMs: 0,
      readinessTimeoutMs: 0,
      sleep: () => Promise.resolve(),
      logger: {
        warn(message) {
          warnings.push(message);
        },
      },
    },
  );

  const supervisorCall = calls.find((c) => c.command.includes("supervisorctl"));
  const recreateCall = calls.find((c) => c.command.includes("up-container mcpo"));
  assert.ok(supervisorCall, "should attempt supervisorctl restart");
  assert.equal(
    recreateCall.command,
    'bash "/tmp/project/src/scripts/docker-compose.sh" up-container mcpo --no-deps',
  );
  assert.ok(
    warnings.some((message) => /Control-plane cache refresh failed/.test(message)),
  );
  assert.ok(
    warnings.some((message) => /Control-plane program refresh failed/.test(message)),
  );
});

test("refreshMcpControlPlane retries nginx reload when config test fails initially", async () => {
  const calls = [];
  const warnings = [];
  let testCallCount = 0;
  const execAsync = async (command, options) => {
    calls.push({ command, options });
    if (command.includes("nginx -t")) {
      testCallCount++;
      if (testCallCount === 1) {
        throw new Error("nginx: config file /etc/nginx/nginx.conf test failed");
      }
    }
    return { stdout: "", stderr: "" };
  };
  const fetchImpl = async (url, options) => {
    if (options?.method === "POST") {
      return { ok: true, status: 200 };
    }
    return { ok: true, status: 200 };
  };

  const result = await refreshMcpControlPlane(
    execAsync,
    "/tmp/project",
    { PATH: "/bin" },
    {
      fetchImpl,
      includeCore: false,
      serverId: "google_workspace",
      pollIntervalMs: 0,
      nginxReloadRetries: 2,
      sleep: () => Promise.resolve(),
      logger: {
        warn(message) {
          warnings.push(message);
        },
      },
    },
  );

  assert.deepEqual(
    calls.map((c) => c.command),
    [
      "docker exec mcpo nginx -t",
      "docker exec mcpo nginx -t",
      "docker exec mcpo nginx -s reload",
    ],
  );
  assert.equal(result.success, true);
  assert.ok(
    warnings.some((message) => /nginx config test failed.*attempt 1/.test(message)),
  );
});

test("refreshMcpControlPlane falls back when the server route stays unavailable after a fast reload", async () => {
  const calls = [];
  const warnings = [];
  const execAsync = async (command, options) => {
    calls.push({ command, options });
    return { stdout: "", stderr: "" };
  };
  const fetchImpl = async (url, options) => {
    if (options?.method === "POST") {
      return { ok: true, status: 200 };
    }

    if (url === "http://127.0.0.1:8765/openapi.json") {
      return { ok: true, status: 200 };
    }

    if (url === "http://127.0.0.1:8765/google_workspace/openapi.json") {
      const usedProcessFallback = calls.some((call) =>
        call.command.includes("supervisorctl -s unix:///tmp/supervisor.sock restart aggregator-regular"),
      );
      return { ok: usedProcessFallback, status: usedProcessFallback ? 200 : 404 };
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  const result = await refreshMcpControlPlane(
    execAsync,
    "/tmp/project",
    { PATH: "/bin" },
    {
      fetchImpl,
      includeCore: false,
      serverId: "google_workspace",
      pollIntervalMs: 0,
      readinessTimeoutMs: 0,
      nginxReloadRetries: 1,
      sleep: () => Promise.resolve(),
      logger: {
        warn(message) {
          warnings.push(message);
        },
      },
    },
  );

  assert.deepEqual(
    calls.map((c) => c.command),
    [
      "docker exec mcpo nginx -t",
      "docker exec mcpo nginx -s reload",
      "docker exec mcpo supervisorctl -s unix:///tmp/supervisor.sock restart aggregator-regular",
    ],
  );
  assert.equal(result.success, true);
  assert.equal(result.mode, "process-refresh");
  assert.ok(
    warnings.some((message) => /cache refresh failed/.test(message)),
  );
});

test("refreshMcpControlPlane serializes overlapping refresh requests", async () => {
  const started = [];
  const release = [];
  const execAsync = (command) => {
    started.push(command);
    return new Promise((resolve) => {
      release.push(() => resolve({ stdout: "", stderr: "" }));
    });
  };
  const fetchImpl = async () => ({ ok: true, status: 200 });

  const first = refreshMcpControlPlane(
    execAsync,
    "/tmp/project",
    { PATH: "/bin" },
    {
      fetchImpl,
      includeCore: false,
      serverId: "google_workspace",
      pollIntervalMs: 0,
      sleep: () => Promise.resolve(),
    },
  );
  const second = refreshMcpControlPlane(
    execAsync,
    "/tmp/project",
    { PATH: "/bin" },
    {
      fetchImpl,
      includeRegular: false,
      serverId: "mcp-assistant",
      pollIntervalMs: 0,
      sleep: () => Promise.resolve(),
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started, ["docker exec mcpo nginx -t"]);

  release.shift()();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started, [
    "docker exec mcpo nginx -t",
    "docker exec mcpo nginx -s reload",
  ]);

  release.shift()();
  await first;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started, [
    "docker exec mcpo nginx -t",
    "docker exec mcpo nginx -s reload",
    "docker exec mcpo nginx -t",
  ]);

  release.shift()();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started, [
    "docker exec mcpo nginx -t",
    "docker exec mcpo nginx -s reload",
    "docker exec mcpo nginx -t",
    "docker exec mcpo nginx -s reload",
  ]);

  release.shift()();
  await second;
});

test("refreshMcpControlPlane only invalidates selected tiers when no aggregator tier is selected", async () => {
  const calls = [];
  const fetchRequests = [];
  const execAsync = async (command, options) => {
    calls.push({ command, options });
    return { stdout: "", stderr: "" };
  };
  const fetchImpl = async (url, options) => {
    fetchRequests.push({ url, options });
    return { ok: true, status: 200 };
  };

  await refreshMcpControlPlane(
    execAsync,
    "/tmp/project",
    { PATH: "/bin" },
    {
      includeRegular: false,
      includeCore: false,
      fetchImpl,
      pollIntervalMs: 0,
    },
  );

  assert.deepEqual(calls, []);
  assert.deepEqual(fetchRequests, []);
});

test("invalidateMcpAggregatorCaches posts to regular and core aggregators", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 200 };
  };

  const result = await invalidateMcpAggregatorCaches({
    fetchImpl,
    reason: "bulk-disable",
    serverId: "gitlab-mcp",
  });

  assert.equal(result.success, true);
  assert.deepEqual(
    requests.map((request) => request.url),
    [
      "http://127.0.0.1:8765/internal/cache/invalidate",
      "http://127.0.0.1:8766/internal/cache/invalidate",
    ],
  );
  for (const request of requests) {
    assert.equal(request.options.method, "POST");
    assert.equal(
      request.options.body,
      JSON.stringify({
        reason: "bulk-disable",
        server_id: "gitlab-mcp",
        server_ids: ["gitlab-mcp"],
      }),
    );
  }
});

test("invalidateMcpAggregatorCaches reports partial failures without throwing", async () => {
  const warnings = [];
  const fetchImpl = async (url) => {
    if (url.includes(":8765/")) {
      throw new Error("connection reset");
    }
    return { ok: true, status: 200 };
  };

  const result = await invalidateMcpAggregatorCaches({
    fetchImpl,
    includeCore: true,
    includeRegular: true,
    logger: {
      warn: (message) => warnings.push(message),
    },
  });

  assert.equal(result.success, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /connection reset/);
});

test("invalidateMcpAggregatorCaches times out hung requests without falling through to long waits", async () => {
  const warnings = [];
  const result = await invalidateMcpAggregatorCaches({
    fetchImpl: async () => new Promise(() => {}),
    includeRegular: true,
    includeCore: false,
    invalidationTimeoutMs: 1,
    logger: {
      warn: (message) => warnings.push(message),
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.results.length, 1);
  assert.match(result.results[0].error, /timeout/);
  assert.equal(warnings.length, 1);
});
