const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildHostMcpSandboxSettings,
  resolveCuratedHostMcpWriteRoots,
  buildNoKeychainSeatbeltProfile,
  writeHostMcpSandboxFiles,
  consumeProcessOutputLines,
  shouldSuppressHostMcpoLogLine,
  classifyHostMcpoStderrLine,
  createSerialTaskQueue,
  markHostMcpoStarting,
  markHostMcpoReady,
  markHostMcpoStopped,
  isHostMcpoStartupPending,
  getHostMcpoStartupPhase,
  shouldTreatHostServerAsStarting,
} = require("./host-mcpo-runtime");

function withTempDir(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-mcp-runtime-"));
  try {
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("consumeProcessOutputLines handles CR-only separators and trailing partial chunks", () => {
  const first = consumeProcessOutputLines(
    "",
    "alpha\rbeta\rpartial",
  );
  assert.deepEqual(first.lines, ["alpha", "beta"]);
  assert.equal(first.remainder, "partial");

  const second = consumeProcessOutputLines(first.remainder, "_line\r");
  assert.deepEqual(second.lines, ["partial_line"]);
  assert.equal(second.remainder, "");
});

test("shouldSuppressHostMcpoLogLine suppresses benign DevTools issue formatter gaps", () => {
  assert.equal(
    shouldSuppressHostMcpoLogLine(
      "No handler registered for issue code PerformanceIssue",
    ),
    true,
  );
  assert.equal(
    shouldSuppressHostMcpoLogLine(
      "No handler registered for issue code SelectivePermissionsInterventionIssue",
    ),
    true,
  );
  assert.equal(
    shouldSuppressHostMcpoLogLine(
      "No handler registered for issue code Performance_Issue",
    ),
    true,
  );
  assert.equal(
    shouldSuppressHostMcpoLogLine(
      "No handler registered for issue code PerformanceIssue: details",
    ),
    false,
  );
  assert.equal(
    shouldSuppressHostMcpoLogLine("No handler registered for issue code "),
    false,
  );
  assert.equal(
    shouldSuppressHostMcpoLogLine("ERROR No handler registered for issue code X"),
    false,
  );
});

test("classifyHostMcpoStderrLine treats informational runtime chatter as info", () => {
  assert.equal(
    classifyHostMcpoStderrLine(
      "[2026-03-08T05:11:37Z] INFO [mcp_orc] Starting native mcp-orc CLI",
    ),
    "info",
  );
  assert.equal(
    classifyHostMcpoStderrLine(
      "chrome-devtools-mcp exposes content of the browser instance to the MCP clients",
    ),
    "info",
  );
});

test("classifyHostMcpoStderrLine preserves real failures as errors", () => {
  assert.equal(
    classifyHostMcpoStderrLine(
      "[2026-03-08T05:12:11Z] ERROR [mcp_orc] failed to bind 127.0.0.1:8890: Address already in use (os error 48)",
    ),
    "error",
  );
  assert.equal(
    classifyHostMcpoStderrLine("npm error Incorrect or missing password."),
    "error",
  );
});

test("classifyHostMcpoStderrLine marks warnings distinctly", () => {
  assert.equal(
    classifyHostMcpoStderrLine(
      "[2026-03-08T05:12:11Z] WARN [mcp_orc::app] native MCP startup failed",
    ),
    "warning",
  );
});

test("createSerialTaskQueue runs enqueued tasks sequentially", async () => {
  const enqueue = createSerialTaskQueue();
  const events = [];

  const first = enqueue(async () => {
    events.push("first-start");
    await new Promise((resolve) => setTimeout(resolve, 30));
    events.push("first-end");
    return "first";
  });

  const second = enqueue(async () => {
    events.push("second-start");
    events.push("second-end");
    return "second";
  });

  const third = enqueue(async () => {
    events.push("third-start");
    events.push("third-end");
    return "third";
  });

  assert.deepEqual(await Promise.all([first, second, third]), [
    "first",
    "second",
    "third",
  ]);
  assert.deepEqual(events, [
    "first-start",
    "first-end",
    "second-start",
    "second-end",
    "third-start",
    "third-end",
  ]);
});

test("host startup state stays pending until deadline and then times out", () => {
  const hostMcpo = {};

  markHostMcpoStarting(hostMcpo, { now: 1000, timeoutMs: 5000 });
  assert.equal(isHostMcpoStartupPending(hostMcpo, { now: 4000 }), true);
  assert.equal(getHostMcpoStartupPhase(hostMcpo, { now: 4000 }), "starting");
  assert.equal(isHostMcpoStartupPending(hostMcpo, { now: 6001 }), false);
  assert.equal(getHostMcpoStartupPhase(hostMcpo, { now: 6001 }), "timed_out");
});

test("host startup state moves to ready and stopped explicitly", () => {
  const hostMcpo = {};

  markHostMcpoStarting(hostMcpo, { now: 1000, timeoutMs: 5000 });
  markHostMcpoReady(hostMcpo, { now: 2500 });
  assert.equal(isHostMcpoStartupPending(hostMcpo, { now: 2600 }), false);
  assert.equal(getHostMcpoStartupPhase(hostMcpo, { now: 2600 }), "ready");

  markHostMcpoStopped(hostMcpo, { now: 3000, phase: "failed" });
  assert.equal(getHostMcpoStartupPhase(hostMcpo, { now: 3100 }), "failed");
});

test("host server failures are masked during host startup grace", () => {
  const hostMcpo = {};
  markHostMcpoStarting(hostMcpo, { now: 1000, timeoutMs: 5000 });

  assert.equal(
    shouldTreatHostServerAsStarting(
      {
        deployment: "host",
        configured: true,
        status: "failed",
        error:
          "Host MCP server is not running - check Host MCPO logs for startup errors",
      },
      hostMcpo,
      { now: 2000 },
    ),
    true,
  );

  assert.equal(
    shouldTreatHostServerAsStarting(
      {
        deployment: "host",
        configured: true,
        status: "healthy",
        error: null,
      },
      hostMcpo,
      { now: 2000 },
    ),
    false,
  );
});

test("host MCP sandbox settings deny secrets without allowing the whole project tree", () => {
  withTempDir((projectRoot) => {
    const cacheDir = path.join(projectRoot, "cache", "runtime-secrets");
    const configPath = path.join(projectRoot, "mcp_config_host_sideload.json");
    const settings = buildHostMcpSandboxSettings({
      projectRoot,
      cacheDir,
      configPath,
      homeDir: path.join(projectRoot, "home"),
      allowedDomains: ["api.example.com", "api.example.com"],
      resourcesPath: path.join(projectRoot, "resources"),
    });

    assert.deepEqual(settings.network.allowedDomains, ["api.example.com"]);
    assert.equal(settings.network.allowLocalBinding, true);
    assert.equal(settings.filesystem.allowRead.includes(projectRoot), false);
    assert.equal(settings.filesystem.allowRead.includes(configPath), true);
    assert.equal(settings.filesystem.denyRead.includes(path.join(projectRoot, ".env")), true);
    assert.equal(settings.filesystem.denyRead.includes(path.join(projectRoot, ".npmrc")), true);
    assert.equal(
      settings.filesystem.denyRead.includes(
        path.join(projectRoot, "open-webui-data", "managed-node-mcp-package-acquisition"),
      ),
      true,
    );
    assert.equal(
      settings.filesystem.allowRead.includes(
        path.join(projectRoot, "open-webui-data", "managed-node-mcp-package-acquisition"),
      ),
      false,
    );
    assert.equal(settings.filesystem.denyRead.includes(cacheDir), true);
  });
});

test("host MCP no-Keychain Seatbelt profile denies securityd and project secret files", () => {
  withTempDir((projectRoot) => {
    const profile = buildNoKeychainSeatbeltProfile({
      projectRoot,
      cacheDir: path.join(projectRoot, "cache", "runtime-secrets"),
      homeDir: path.join(projectRoot, "home"),
    });

    assert.match(profile, /com\.apple\.SecurityServer/);
    assert.match(profile, /com\.apple\.securityd\.xpc/);
    assert.match(profile, /process-exec \(literal "\/usr\/bin\/security"\)/);
    assert.match(profile, new RegExp(`${projectRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*\\.env`));
    assert.match(
      profile,
      new RegExp(
        `${projectRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*managed-node-mcp-package-acquisition`,
      ),
    );
  });
});

test("writeHostMcpSandboxFiles writes private settings with host allowed domain union", () => {
  withTempDir((projectRoot) => {
    const cacheDir = path.join(projectRoot, "cache", "runtime-secrets");
    const configPath = path.join(projectRoot, "mcp_config_host_sideload.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { "chrome-devtools": {}, "custom-host": {} } }),
      "utf8",
    );
    const customDir = path.join(projectRoot, "mcp-configs", "custom-host");
    fs.mkdirSync(customDir, { recursive: true });
    fs.writeFileSync(
      path.join(customDir, "custom-host.yaml"),
      [
        "name: Custom Host",
        "deployment_type: host",
        "allowed_domains:",
        "  - api.example.com",
        "  - logs.example.com",
        "",
      ].join("\n"),
      "utf8",
    );
    const chromeDir = path.join(projectRoot, "mcp-configs", "chrome-devtools");
    fs.mkdirSync(chromeDir, { recursive: true });
    fs.writeFileSync(
      path.join(chromeDir, "chrome-devtools.yaml"),
      ["name: Chrome DevTools", "deployment_type: host", "allowed_domains: []", ""].join("\n"),
      "utf8",
    );
    const runnerDir = path.join(projectRoot, "src", "scripts");
    fs.mkdirSync(runnerDir, { recursive: true });
    fs.writeFileSync(path.join(runnerDir, "srt-sandbox-runner.mjs"), "", "utf8");

    const env = writeHostMcpSandboxFiles({
      projectRoot,
      configPath,
      cacheDir,
      resourcesPath: path.join(projectRoot, "resources"),
      homeDir: path.join(projectRoot, "home"),
    });

    assert.equal(env.HOST_MCP_SANDBOX_ENABLED, "1");
    assert.equal(
      env.HOST_MCP_SRT_RUNNER_JS,
      path.join(projectRoot, "src", "scripts", "srt-sandbox-runner.mjs"),
    );
    assert.equal(fs.statSync(env.HOST_MCP_SRT_SETTINGS_PATH).mode & 0o777, 0o600);
    assert.equal(
      fs.statSync(env.HOST_MCP_NO_KEYCHAIN_PROFILE_PATH).mode & 0o777,
      0o600,
    );
    const settings = JSON.parse(fs.readFileSync(env.HOST_MCP_SRT_SETTINGS_PATH, "utf8"));
    assert.deepEqual(settings.network.allowedDomains, [
      "api.example.com",
      "logs.example.com",
    ]);
  });
});

// ---------------------------------------------------------------------------
// PORTICO-352: host MCP writes to user folders failed with EPERM because the SRT
// write policy allowed only the PORTICO cache and /tmp. A reviewed, PORTICO-owned
// curated root restores the reported Obsidian vault case without widening the
// sandbox anywhere else.
// ---------------------------------------------------------------------------

test("an existing Obsidian vault becomes a writable root", () => {
  withTempDir((homeDir) => {
    const vault = path.join(homeDir, "Obsidian-Vault");
    fs.mkdirSync(vault, { recursive: true });

    assert.deepEqual(
      resolveCuratedHostMcpWriteRoots({ homeDir }),
      [fs.realpathSync(vault)],
    );
  });
});

test("a missing vault grants nothing and never throws", () => {
  withTempDir((homeDir) => {
    assert.deepEqual(resolveCuratedHostMcpWriteRoots({ homeDir }), []);
  });
});

test("a vault that is a file, not a directory, is not granted", () => {
  withTempDir((homeDir) => {
    fs.writeFileSync(path.join(homeDir, "Obsidian-Vault"), "not a directory");
    assert.deepEqual(resolveCuratedHostMcpWriteRoots({ homeDir }), []);
  });
});

test("a vault symlinked outside the home directory is not granted", () => {
  withTempDir((root) => {
    const homeDir = path.join(root, "home");
    const outside = path.join(root, "outside");
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(homeDir, "Obsidian-Vault"));

    // Escaping home via symlink must not become a writable root.
    assert.deepEqual(resolveCuratedHostMcpWriteRoots({ homeDir }), []);
  });
});

test("a vault overlapping a protected root is not granted", () => {
  withTempDir((homeDir) => {
    const vault = path.join(homeDir, "Obsidian-Vault");
    fs.mkdirSync(path.join(vault, "nested"), { recursive: true });

    // Protected path sitting inside the candidate root.
    assert.deepEqual(
      resolveCuratedHostMcpWriteRoots({
        homeDir,
        protectedRoots: [path.join(vault, "nested")],
      }),
      [],
    );
    // Candidate root sitting inside a protected path.
    assert.deepEqual(
      resolveCuratedHostMcpWriteRoots({ homeDir, protectedRoots: [homeDir] }),
      [],
    );
  });
});

test("sandbox settings grant the vault while keeping every deny boundary intact", () => {
  withTempDir((root) => {
    const projectRoot = path.join(root, "project");
    const homeDir = path.join(root, "home");
    const vault = path.join(homeDir, "Obsidian-Vault");
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(vault, { recursive: true });

    const settings = buildHostMcpSandboxSettings({
      projectRoot,
      homeDir,
      cacheDir: path.join(projectRoot, "cache", "runtime-secrets"),
      configPath: path.join(projectRoot, "mcp_config_host_sideload.json"),
    });

    const { allowWrite, denyWrite } = settings.filesystem;
    assert.equal(allowWrite.includes(fs.realpathSync(vault)), true);
    // The pre-existing grants must survive.
    assert.equal(
      allowWrite.includes(path.join(homeDir, "Library", "Caches", "portico")),
      true,
    );
    assert.equal(allowWrite.includes("/tmp"), true);
    // Nothing else in home becomes writable.
    assert.equal(allowWrite.includes(homeDir), false);
    assert.equal(allowWrite.includes(projectRoot), false);
    for (const protectedPath of [
      path.join(homeDir, ".ssh"),
      path.join(homeDir, ".aws"),
      path.join(homeDir, "Library", "Keychains"),
      path.join(projectRoot, ".env"),
    ]) {
      assert.equal(denyWrite.includes(protectedPath), true);
      assert.equal(allowWrite.includes(protectedPath), false);
    }
  });
});

test("sandbox settings are unchanged when no curated root is present", () => {
  withTempDir((root) => {
    const projectRoot = path.join(root, "project");
    const homeDir = path.join(root, "home");
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });

    const settings = buildHostMcpSandboxSettings({
      projectRoot,
      homeDir,
      cacheDir: path.join(projectRoot, "cache", "runtime-secrets"),
      configPath: path.join(projectRoot, "mcp_config_host_sideload.json"),
    });

    assert.deepEqual(settings.filesystem.allowWrite, [
      "/tmp",
      path.join(homeDir, "Library", "Caches", "portico"),
    ]);
  });
});

test("the Slack MCP cache leaf is created 0700 and granted when absent", () => {
  withTempDir((homeDir) => {
    fs.mkdirSync(path.join(homeDir, "Library", "Caches"), { recursive: true });
    const cache = path.join(homeDir, "Library", "Caches", "slack-mcp-server");
    assert.equal(fs.existsSync(cache), false);

    const granted = resolveCuratedHostMcpWriteRoots({ homeDir });

    assert.equal(granted.includes(fs.realpathSync(cache)), true);
    assert.equal(fs.statSync(cache).isDirectory(), true);
    assert.equal(fs.statSync(cache).mode & 0o777, 0o700);
  });
});

test("an existing Slack MCP cache directory is granted without being recreated", () => {
  withTempDir((homeDir) => {
    const cache = path.join(homeDir, "Library", "Caches", "slack-mcp-server");
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, "users_cache.json"), "{}");

    const granted = resolveCuratedHostMcpWriteRoots({ homeDir });

    assert.equal(granted.includes(fs.realpathSync(cache)), true);
    // Pre-existing cache contents must survive.
    assert.equal(fs.existsSync(path.join(cache, "users_cache.json")), true);
  });
});

test("the cache leaf is not created when its parent is missing", () => {
  withTempDir((homeDir) => {
    // No ~/Library/Caches at all: never materialise intermediate directories.
    assert.deepEqual(resolveCuratedHostMcpWriteRoots({ homeDir }), []);
    assert.equal(fs.existsSync(path.join(homeDir, "Library")), false);
  });
});

test("the cache leaf is not created when its parent escapes home", () => {
  withTempDir((root) => {
    const homeDir = path.join(root, "home");
    const outside = path.join(root, "outside");
    fs.mkdirSync(path.join(homeDir, "Library"), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    // ~/Library/Caches symlinked outside home must not become writable.
    fs.symlinkSync(outside, path.join(homeDir, "Library", "Caches"));

    assert.deepEqual(resolveCuratedHostMcpWriteRoots({ homeDir }), []);
    assert.equal(fs.existsSync(path.join(outside, "slack-mcp-server")), false);
  });
});
