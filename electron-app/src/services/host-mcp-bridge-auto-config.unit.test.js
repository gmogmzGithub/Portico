const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");

const {
  BRIDGE_SERVER_NAME,
  SUPPORTED_MCP_CLIENTS,
  configureMcpClients,
  detectMcpClients,
  inspectMcpClientConfig,
  getClaudeDesktopLauncherPath,
  getClaudeDesktopProxyPath,
  removeMcpClientConfigs,
  removeCodexMcpServerToml,
  repairClaudeCodeProjectScopedConfig,
  revealMcpClientConfig,
  resolveClaudeDesktopConfigPath,
  resolveClaudeCodeConfigPath,
  sanitizeConfigError,
  stripJsonComments,
  upsertCodexMcpServerToml,
  writeAmpConfig,
  writeClaudeCodeHeadersHelper,
  writeClaudeDesktopConfig,
  writeCodexConfig,
  writeCursorConfig,
} = require("./host-mcp-bridge-auto-config");
const {
  ensureClientBridgeToken,
  getBridgeAuthRedactedStatus,
} = require("./host-mcp-bridge-auth");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function createClaudeCodeExecMock({ homeDir, calls, removeError } = {}) {
  const configPath = resolveClaudeCodeConfigPath(homeDir);
  return async (command, args, options) => {
    calls?.push({ command, args, options });
    if (args[1] === "remove") {
      if (removeError) throw removeError;
      const config = fs.existsSync(configPath) ? readJson(configPath) : {};
      if (config.mcpServers && typeof config.mcpServers === "object") {
        delete config.mcpServers[BRIDGE_SERVER_NAME];
      }
      fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
      return { stdout: "", stderr: "" };
    }
    if (args[1] === "add-json") {
      const config = fs.existsSync(configPath) ? readJson(configPath) : {};
      config.mcpServers = config.mcpServers && typeof config.mcpServers === "object"
        ? config.mcpServers
        : {};
      config.mcpServers[BRIDGE_SERVER_NAME] = JSON.parse(args.at(-1));
      fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    }
    return { stdout: "", stderr: "" };
  };
}

function countOccurrences(text, pattern) {
  return (text.match(pattern) || []).length;
}

test("supported MCP clients exclude Windsurf", () => {
  const ids = SUPPORTED_MCP_CLIENTS.map((client) => client.id);
  assert.deepEqual(ids, ["claude-code", "claude-desktop", "codex", "cursor", "amp"]);
  assert.equal(ids.includes("windsurf"), false);
});

test("detection marks installed clients and ignores Claude Desktop extension policy for local config", () => {
  const homeDir = tempDir("host-mcp-auto-detect-");
  fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".codex", "config.toml"), "");
  fs.mkdirSync(path.join(homeDir, ".config", "amp"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".config", "amp", "settings.json"), "{}");
  const existingPaths = new Set([
    "/Applications/Claude.app",
    path.join(homeDir, ".codex", "config.toml"),
    path.join(homeDir, ".config", "amp", "settings.json"),
  ]);

  const clients = detectMcpClients({
    homeDir,
    platform: "darwin",
    env: { portico_CLAUDE_DESKTOP_EXTENSIONS_DISABLED: "1" },
    commandExists: (command) => command === "claude",
    fileExists: (filePath) => existingPaths.has(filePath),
  });
  const byId = new Map(clients.map((client) => [client.id, client]));

  assert.equal(byId.get("claude-code").detected, true);
  assert.equal(byId.get("claude-code").selectable, true);
  assert.equal(byId.get("claude-desktop").detected, true);
  assert.equal(byId.get("claude-desktop").blocked, false);
  assert.equal(byId.get("claude-desktop").selectable, true);
  assert.equal(byId.get("claude-desktop").statusText, "Detected");
  assert.equal(byId.get("codex").detected, true);
  assert.equal(byId.get("amp").detected, true);
  assert.deepEqual(
    clients.map((client) => client.id),
    ["claude-code", "claude-desktop", "codex", "amp", "cursor"],
  );
});

test("detection uses the shared enhanced PATH for GUI-launched CLI clients", () => {
  const homeDir = tempDir("host-mcp-auto-gui-path-");
  const commandCalls = [];
  const clients = detectMcpClients({
    homeDir,
    platform: "darwin",
    env: { PATH: "/usr/bin:/bin" },
    execFileSync(command, args, options) {
      commandCalls.push({ command, args, options });
      if (args[0] === "claude" && options.env.PATH.includes(`${os.homedir()}/.local/bin`)) {
        return Buffer.alloc(0);
      }
      throw new Error("not found");
    },
    fileExists: () => false,
  });

  assert.equal(clients.find((client) => client.id === "claude-code").detected, true);
  assert.equal(commandCalls.length, 4);
  assert.equal(commandCalls.every((call) => call.command === "/usr/bin/which"), true);
  assert.equal(
    commandCalls.every((call) => call.options.env.PATH.includes(`${os.homedir()}/.local/bin`)),
    true,
  );
  assert.equal(commandCalls.every((call) => call.options.env.PATH.includes("/usr/bin")), true);
});

test("Claude Desktop detection ignores stale Application Support without an installed app", () => {
  const homeDir = tempDir("host-mcp-auto-claude-stale-");
  const staleSupportDir = path.join(homeDir, "Library", "Application Support", "Claude");
  fs.mkdirSync(staleSupportDir, { recursive: true });

  const clients = detectMcpClients({
    homeDir,
    platform: "darwin",
    commandExists: () => false,
    fileExists: (filePath) => filePath === staleSupportDir,
  });
  const claudeDesktop = clients.find((client) => client.id === "claude-desktop");

  assert.equal(claudeDesktop.detected, false);
  assert.equal(claudeDesktop.selectable, false);
  assert.equal(claudeDesktop.statusText, "Not detected");
});

test("Codex detection supports CLI-only and app-only installs", () => {
  const homeDir = tempDir("host-mcp-auto-codex-detect-");
  const codexAppPath = path.join(homeDir, "Applications", "Codex.app");
  fs.mkdirSync(codexAppPath, { recursive: true });

  const cliOnly = detectMcpClients({
    homeDir,
    platform: "darwin",
    commandExists: (command) => command === "codex",
    fileExists: () => false,
  }).find((client) => client.id === "codex");
  assert.equal(cliOnly.detected, true);
  assert.equal(cliOnly.selectable, true);

  const appOnly = detectMcpClients({
    homeDir,
    platform: "darwin",
    commandExists: () => false,
    fileExists: (filePath) => filePath === codexAppPath,
  }).find((client) => client.id === "codex");
  assert.equal(appOnly.detected, true);
  assert.equal(appOnly.selectable, true);
});

test("detection promotes already configured clients to Configured state", () => {
  const homeDir = tempDir("host-mcp-auto-configured-detect-");
  const userDataPath = tempDir("host-mcp-auto-configured-detect-userdata-");
  const bridgeUrl = "http://127.0.0.1:8891/mcp";
  const token = "portico_mcp_detected";
  const claudeTokenInfo = ensureClientBridgeToken({
    userDataPath,
    clientId: "claude-code",
    displayName: "Claude Code",
  });
  const claudeHelperPath = writeClaudeCodeHeadersHelper({
    userDataPath,
    tokenPath: claudeTokenInfo.tokenPath,
  });

  fs.writeFileSync(resolveClaudeCodeConfigPath(homeDir), JSON.stringify({
    mcpServers: {
      [BRIDGE_SERVER_NAME]: {
        type: "http",
        url: bridgeUrl,
        headersHelper: `'${claudeHelperPath}'`,
      },
    },
  }, null, 2));
  fs.mkdirSync(path.dirname(resolveClaudeDesktopConfigPath(homeDir, "darwin", {})), { recursive: true });
  fs.writeFileSync(resolveClaudeDesktopConfigPath(homeDir, "darwin", {}), JSON.stringify({
    mcpServers: {
      [BRIDGE_SERVER_NAME]: {
        command: "/bin/sh",
        args: [getClaudeDesktopLauncherPath(userDataPath, "darwin")],
      },
    },
  }, null, 2));
  writeCodexConfig({ homeDir, bridgeUrl, token });
  writeCursorConfig({ homeDir, bridgeUrl, token });
  writeAmpConfig({ homeDir, bridgeUrl, token });

  const clients = detectMcpClients({
    homeDir,
    platform: "darwin",
    env: {},
    userDataPath,
    bridgeUrl,
    commandExists: () => false,
    fileExists: (filePath) => filePath === "/Applications/Claude.app" || fs.existsSync(filePath),
  });
  const byId = new Map(clients.map((client) => [client.id, client]));

  for (const clientId of ["claude-code", "claude-desktop", "codex", "cursor", "amp"]) {
    const client = byId.get(clientId);
    assert.equal(client.configured, true, `${clientId} should be configured`);
    assert.equal(client.selectable, true, `${clientId} should be selectable`);
    assert.equal(client.status, "configured");
    assert.equal(client.statusText, "Configured");
    assert.equal(typeof client.configPath, "string");
  }
  assert.deepEqual(
    clients.map((client) => client.id),
    ["claude-code", "claude-desktop", "codex", "cursor", "amp"],
  );
});

test("Claude Code detection marks the observed unauthenticated config shape as needing repair", () => {
  const homeDir = tempDir("host-mcp-auto-claude-drift-detect-");
  const userDataPath = tempDir("host-mcp-auto-claude-drift-detect-userdata-");
  fs.writeFileSync(resolveClaudeCodeConfigPath(homeDir), JSON.stringify({
    mcpServers: {
      [BRIDGE_SERVER_NAME]: {},
    },
    projects: {
      "/repo": {
        mcpServers: {
          [BRIDGE_SERVER_NAME]: {
            type: "http",
            url: "http://127.0.0.1:8891/mcp",
          },
        },
      },
    },
  }, null, 2));

  const inspected = inspectMcpClientConfig("claude-code", {
    homeDir,
    userDataPath,
  });
  assert.equal(inspected.configured, false);
  assert.equal(inspected.repairNeeded, true);
  assert.equal(inspected.projectEntries, 1);
  assert.equal(inspected.repairReasons.includes("invalid_headers_helper"), true);
  assert.equal(inspected.repairReasons.includes("project_scope_override"), true);

  const detected = detectMcpClients({
    homeDir,
    userDataPath,
    commandExists: () => true,
    fileExists: fs.existsSync,
  }).find((client) => client.id === "claude-code");
  assert.equal(detected.configured, false);
  assert.equal(detected.repairNeeded, true);
  assert.equal(detected.status, "needs_repair");
  assert.equal(detected.statusText, "Needs repair");
  assert.equal(detected.selectable, true);
});

test("Codex, Cursor, and Amp config writers store bearer headers in expected config formats", () => {
  const homeDir = tempDir("host-mcp-auto-writers-");
  const token = "portico_mcp_config_writer";
  const bridgeUrl = "http://127.0.0.1:8891/mcp";

  const codex = writeCodexConfig({ homeDir, bridgeUrl, token });
  assert.equal(codex.success, true);
  const codexText = fs.readFileSync(path.join(homeDir, ".codex", "config.toml"), "utf8");
  assert.match(codexText, /\[mcp_servers\.portico\]/);
  assert.match(codexText, /url = "http:\/\/127\.0\.0\.1:8891\/mcp"/);
  assert.match(codexText, /http_headers = \{ Authorization = "Bearer portico_mcp_config_writer" \}/);
  const codexAgain = writeCodexConfig({ homeDir, bridgeUrl, token });
  assert.equal(codexAgain.success, true);
  const codexTextAgain = fs.readFileSync(path.join(homeDir, ".codex", "config.toml"), "utf8");
  assert.equal(countOccurrences(codexTextAgain, /\[mcp_servers\.portico\]/g), 1);
  assert.equal(countOccurrences(codexTextAgain, /http_headers\s*=/g), 1);

  const cursor = writeCursorConfig({ homeDir, bridgeUrl, token });
  assert.equal(cursor.success, true);
  const cursorAgain = writeCursorConfig({ homeDir, bridgeUrl, token });
  assert.equal(cursorAgain.success, true);
  assert.deepEqual(readJson(path.join(homeDir, ".cursor", "mcp.json")).mcpServers[BRIDGE_SERVER_NAME], {
    type: "http",
    url: bridgeUrl,
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(Object.keys(readJson(path.join(homeDir, ".cursor", "mcp.json")).mcpServers).filter((key) => key === BRIDGE_SERVER_NAME).length, 1);

  fs.mkdirSync(path.join(homeDir, ".config", "amp"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".config", "amp", "settings.jsonc"), "{\n  // keep existing settings\n  \"theme\": \"dark\",\n}\n");
  const amp = writeAmpConfig({ homeDir, bridgeUrl, token });
  assert.equal(amp.success, true);
  const ampAgain = writeAmpConfig({ homeDir, bridgeUrl, token });
  assert.equal(ampAgain.success, true);
  const ampConfig = readJson(path.join(homeDir, ".config", "amp", "settings.jsonc"));
  assert.deepEqual(ampConfig["amp.mcpServers"][BRIDGE_SERVER_NAME], {
    type: "http",
    url: bridgeUrl,
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(Object.keys(ampConfig["amp.mcpServers"]).filter((key) => key === BRIDGE_SERVER_NAME).length, 1);
});

test("JSON config writers recover blank files with backups but reject malformed and invalid roots", () => {
  const bridgeUrl = "http://127.0.0.1:8891/mcp";
  const token = "portico_mcp_json_writer";

  const blankHomeDir = tempDir("host-mcp-auto-blank-json-");
  const blankConfigPath = path.join(blankHomeDir, ".cursor", "mcp.json");
  fs.mkdirSync(path.dirname(blankConfigPath), { recursive: true });
  fs.writeFileSync(blankConfigPath, "  \n", "utf8");
  const blankResult = writeCursorConfig({ homeDir: blankHomeDir, bridgeUrl, token });
  assert.equal(blankResult.success, true);
  assert.equal(fs.readFileSync(blankResult.backupPath, "utf8"), "  \n");
  assert.deepEqual(readJson(blankConfigPath).mcpServers[BRIDGE_SERVER_NAME], {
    type: "http",
    url: bridgeUrl,
    headers: { Authorization: `Bearer ${token}` },
  });

  for (const [label, content, expectedError] of [
    ["malformed", '{"mcpServers":', /Failed to read Cursor config/],
    ["array-root", "[]\n", /JSON object at the top level/],
  ]) {
    const homeDir = tempDir(`host-mcp-auto-${label}-json-`);
    const configPath = path.join(homeDir, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, content, "utf8");
    assert.throws(
      () => writeCursorConfig({ homeDir, bridgeUrl, token }),
      expectedError,
    );
    assert.equal(fs.readFileSync(configPath, "utf8"), content);
    assert.equal(
      fs.readdirSync(path.dirname(configPath)).some((name) => name.includes(".bak.")),
      false,
    );
  }
});

test("configured client removal preserves unrelated config, writes backups, revokes tokens, and cleans app-owned files", async () => {
  const homeDir = tempDir("host-mcp-auto-remove-home-");
  const userDataPath = tempDir("host-mcp-auto-remove-userdata-");
  const bridgeUrl = "http://127.0.0.1:8891/mcp";
  const token = "portico_mcp_remove";

  fs.writeFileSync(resolveClaudeCodeConfigPath(homeDir), JSON.stringify({
    mcpServers: {
      [BRIDGE_SERVER_NAME]: { type: "http", url: bridgeUrl },
      other: { command: "keep-user" },
    },
    projects: {
      "/repo": {
        mcpServers: {
          [BRIDGE_SERVER_NAME]: { type: "http", url: bridgeUrl },
          projectOther: { command: "keep-project" },
        },
      },
    },
  }, null, 2));

  const claudeDesktopConfigPath = resolveClaudeDesktopConfigPath(homeDir, "darwin", {});
  fs.mkdirSync(path.dirname(claudeDesktopConfigPath), { recursive: true });
  fs.writeFileSync(claudeDesktopConfigPath, JSON.stringify({
    mcpServers: {
      [BRIDGE_SERVER_NAME]: { command: "/bin/sh", args: ["launcher.sh"] },
      otherDesktop: { command: "keep-desktop" },
    },
  }, null, 2));

  const codexConfigPath = path.join(homeDir, ".codex", "config.toml");
  writeCodexConfig({ homeDir, bridgeUrl, token });
  fs.writeFileSync(codexConfigPath, [
    `[mcp_servers.${BRIDGE_SERVER_NAME}]`,
    `url = "${bridgeUrl}"`,
    "",
    `[mcp_servers.${BRIDGE_SERVER_NAME}.http_headers]`,
    `Authorization = "Bearer ${token}"`,
    "",
    `[mcp_servers.${BRIDGE_SERVER_NAME}.tools.call_bridge_tool]`,
    'approval_mode = "approve"',
    "",
    "[mcp_servers.other]",
    'url = "http://other"',
    "",
  ].join("\n"));
  writeCursorConfig({ homeDir, bridgeUrl, token });
  const cursorConfigPath = path.join(homeDir, ".cursor", "mcp.json");
  const cursorConfig = readJson(cursorConfigPath);
  cursorConfig.mcpServers.otherCursor = { command: "keep-cursor" };
  fs.writeFileSync(cursorConfigPath, JSON.stringify(cursorConfig, null, 2));

  fs.mkdirSync(path.join(homeDir, ".config", "amp"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".config", "amp", "settings.jsonc"), "{\n  // keep parseable jsonc\n  \"amp.mcpServers\": {\n    \"otherAmp\": { \"command\": \"keep-amp\" }\n  },\n}\n");
  writeAmpConfig({ homeDir, bridgeUrl, token });

  for (const clientId of ["claude-code", "claude-desktop", "codex", "cursor", "amp"]) {
    ensureClientBridgeToken({
      userDataPath,
      clientId,
      displayName: clientId,
    });
  }
  const helperPath = writeClaudeCodeHeadersHelper({
    userDataPath,
    tokenPath: path.join(userDataPath, "token"),
  });
  const proxyPath = getClaudeDesktopProxyPath(userDataPath);
  fs.mkdirSync(path.dirname(proxyPath), { recursive: true });
  fs.writeFileSync(proxyPath, "proxy", "utf8");

  const result = await removeMcpClientConfigs({
    userDataPath,
    homeDir,
    platform: "darwin",
    env: {},
    clientIds: ["claude-code", "claude-desktop", "codex", "cursor", "amp"],
  });

  assert.equal(result.success, true);
  assert.equal(result.results.length, 5);
  assert.equal(result.results.every((entry) => entry.success), true);
  assert.equal(result.results.every((entry) => entry.revoked), true);
  assert.equal(result.results.every((entry) => entry.backupPath && fs.existsSync(entry.backupPath)), true);
  assert.equal(JSON.stringify(result).includes(token), false);

  const claudeCode = readJson(resolveClaudeCodeConfigPath(homeDir));
  assert.equal(claudeCode.mcpServers[BRIDGE_SERVER_NAME], undefined);
  assert.deepEqual(claudeCode.mcpServers.other, { command: "keep-user" });
  assert.equal(claudeCode.projects["/repo"].mcpServers[BRIDGE_SERVER_NAME], undefined);
  assert.deepEqual(claudeCode.projects["/repo"].mcpServers.projectOther, { command: "keep-project" });

  const claudeDesktop = readJson(claudeDesktopConfigPath);
  assert.equal(claudeDesktop.mcpServers[BRIDGE_SERVER_NAME], undefined);
  assert.deepEqual(claudeDesktop.mcpServers.otherDesktop, { command: "keep-desktop" });

  const codexText = fs.readFileSync(codexConfigPath, "utf8");
  assert.doesNotMatch(codexText, /\[mcp_servers\.portico(?:\]|\.)/);
  assert.match(codexText, /\[mcp_servers\.other\]\nurl = "http:\/\/other"/);
  assert.equal(readJson(cursorConfigPath).mcpServers[BRIDGE_SERVER_NAME], undefined);
  assert.deepEqual(readJson(cursorConfigPath).mcpServers.otherCursor, { command: "keep-cursor" });
  const ampConfig = readJson(path.join(homeDir, ".config", "amp", "settings.jsonc"));
  assert.equal(ampConfig["amp.mcpServers"][BRIDGE_SERVER_NAME], undefined);
  assert.deepEqual(ampConfig["amp.mcpServers"].otherAmp, { command: "keep-amp" });

  const status = getBridgeAuthRedactedStatus({ userDataPath });
  assert.equal(status.clients.every((client) => client.revoked === true), true);
  for (const clientId of ["claude-code", "claude-desktop", "codex", "cursor", "amp"]) {
    assert.equal(inspectMcpClientConfig(clientId, { homeDir, platform: "darwin", env: {} }).configured, false);
  }
  assert.equal(fs.existsSync(helperPath), false);
  assert.equal(fs.existsSync(path.dirname(proxyPath)), false);
});

test("config removal failure does not revoke a still-valid token", async () => {
  const homeDir = tempDir("host-mcp-auto-remove-invalid-home-");
  const userDataPath = tempDir("host-mcp-auto-remove-invalid-userdata-");
  const cursorConfigPath = path.join(homeDir, ".cursor", "mcp.json");
  fs.mkdirSync(path.dirname(cursorConfigPath), { recursive: true });
  fs.writeFileSync(cursorConfigPath, "{\n  \"mcpServers\": {\n", "utf8");
  ensureClientBridgeToken({
    userDataPath,
    clientId: "cursor",
    displayName: "Cursor",
  });

  const result = await removeMcpClientConfigs({
    userDataPath,
    homeDir,
    clientIds: ["cursor"],
  });

  assert.equal(result.success, false);
  assert.equal(result.results[0].success, false);
  assert.match(result.results[0].error, /Failed to read Cursor config/);
  assert.equal(getBridgeAuthRedactedStatus({ userDataPath }).clients[0].revoked, false);
});

test("Codex removal helper drops duplicate parent and descendant PORTICO sections only", () => {
  const removed = removeCodexMcpServerToml([
    "[mcp_servers.portico]",
    "url = \"old\"",
    "",
    "[mcp_servers.portico.http_headers]",
    'Authorization = "Bearer old"',
    "",
    "[mcp_servers.portico.tools.call_bridge_tool]",
    'approval_mode = "approve"',
    "",
    "[mcp_servers.other]",
    "url = \"http://other\"",
    "",
    "[mcp_servers.portico-preview]",
    "url = \"http://preview\"",
    "",
    "[mcp_servers.portico]",
    "url = \"old-again\"",
  ].join("\n"));

  assert.equal(removed.removed, true);
  assert.doesNotMatch(removed.content, /\[mcp_servers\.portico(?:\]|\.)/);
  assert.match(removed.content, /\[mcp_servers\.other\]\nurl = "http:\/\/other"/);
  assert.match(removed.content, /\[mcp_servers\.portico-preview\]\nurl = "http:\/\/preview"/);
});

test("revealMcpClientConfig reveals only a backend-resolved client config path", () => {
  const homeDir = tempDir("host-mcp-auto-reveal-home-");
  writeCursorConfig({
    homeDir,
    bridgeUrl: "http://127.0.0.1:8891/mcp",
    token: "portico_mcp_reveal",
  });
  const opened = [];
  const result = revealMcpClientConfig({
    clientId: "cursor",
    homeDir,
    shell: {
      showItemInFolder(filePath) {
        opened.push(filePath);
      },
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.configPath, path.join(homeDir, ".cursor", "mcp.json"));
  assert.deepEqual(opened, [result.configPath]);

  const missing = revealMcpClientConfig({
    clientId: "codex",
    homeDir,
    shell: {
      showItemInFolder() {
        assert.fail("missing configs should not be revealed");
      },
    },
  });
  assert.equal(missing.success, false);
  assert.match(missing.error, /does not exist/);
});

test("Claude Code configuration replaces an existing user-scope entry before adding", async () => {
  const homeDir = tempDir("host-mcp-auto-claude-");
  const userDataPath = tempDir("host-mcp-auto-claude-userdata-");
  const calls = [];
  const result = await configureMcpClients({
    userDataPath,
    homeDir,
    clientIds: ["claude-code"],
    env: { PATH: "/usr/bin:/bin" },
    execFileImpl: createClaudeCodeExecMock({ homeDir, calls }),
  });

  assert.equal(result.success, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, "claude");
  assert.deepEqual(calls[0].args, ["mcp", "remove", "--scope", "user", BRIDGE_SERVER_NAME]);
  assert.equal(calls[1].command, "claude");
  assert.deepEqual(calls[1].args.slice(0, -1), ["mcp", "add-json", "--scope", "user", BRIDGE_SERVER_NAME]);
  assert.equal(
    calls.every((call) => call.options.env.PATH.includes(`${os.homedir()}/.local/bin`)),
    true,
  );
  assert.equal(calls.every((call) => call.options.env.PATH.includes("/usr/bin")), true);
  const config = JSON.parse(calls[1].args.at(-1));
  assert.equal(config.type, "http");
  assert.equal(config.url, "http://127.0.0.1:8891/mcp");
  assert.match(config.headersHelper, /^'.*claude-code-headers-helper\.sh'$/);
  assert.doesNotMatch(calls.flatMap((call) => call.args).join(" "), /portico_mcp_/);
  assert.doesNotMatch(JSON.stringify(result), /portico_mcp_/);
});

test("Claude Code configuration ignores the current CLI missing user-scoped server response", async () => {
  const homeDir = tempDir("host-mcp-auto-claude-missing-");
  const userDataPath = tempDir("host-mcp-auto-claude-missing-userdata-");
  const calls = [];
  const removeError = new Error("No user-scoped MCP server found with name: portico");
  removeError.stderr = "No user-scoped MCP server found with name: portico";
  const result = await configureMcpClients({
    userDataPath,
    homeDir,
    clientIds: ["claude-code"],
    execFileImpl: createClaudeCodeExecMock({ homeDir, calls, removeError }),
  });

  assert.equal(result.success, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ["mcp", "remove", "--scope", "user", BRIDGE_SERVER_NAME]);
  assert.deepEqual(calls[1].args.slice(0, -1), ["mcp", "add-json", "--scope", "user", BRIDGE_SERVER_NAME]);
  assert.doesNotMatch(JSON.stringify(result), /portico_mcp_/);
});

test("Claude Code configuration reports unexpected remove failures without leaking tokens", async () => {
  const homeDir = tempDir("host-mcp-auto-claude-remove-fail-");
  const userDataPath = tempDir("host-mcp-auto-claude-remove-fail-userdata-");
  const calls = [];
  const result = await configureMcpClients({
    userDataPath,
    homeDir,
    clientIds: ["claude-code"],
    execFileImpl: async (command, args) => {
      calls.push({ command, args });
      if (args[1] === "remove") {
        const error = new Error("permission denied while updating Claude Code MCP config");
        error.code = "EACCES";
        throw error;
      }
      return { stdout: "", stderr: "" };
    },
  });

  assert.equal(result.success, false);
  assert.equal(calls.length, 1);
  assert.equal(result.results[0].success, false);
  assert.equal(result.results[0].error, "Claude Code remove failed (EACCES)");
  assert.doesNotMatch(JSON.stringify(result), /portico_mcp_/);
});

test("configuration failure reporting bounds and redacts CLI argument JSON, headers, and tokens", async () => {
  const homeDir = tempDir("host-mcp-auto-claude-redacted-fail-");
  const userDataPath = tempDir("host-mcp-auto-claude-redacted-fail-userdata-");
  const logged = [];
  const originalConsoleError = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  let result;
  try {
    result = await configureMcpClients({
      userDataPath,
      homeDir,
      clientIds: ["claude-code"],
      execFileImpl: async () => {
        const error = new Error(
          `Command failed with {"headers":{"Authorization":"Bearer portico_mcp_should_not_leak"}} ${"x".repeat(500)}`,
        );
        error.code = "EACCES";
        throw error;
      },
    });
  } finally {
    console.error = originalConsoleError;
  }

  const serialized = JSON.stringify({ result, logged });
  assert.equal(result.success, false);
  assert.equal(result.results[0].error.length <= 320, true);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /"errorCode":"EACCES"/);
  assert.match(logged[0], /Claude Code remove failed \(EACCES\)/);
  assert.doesNotMatch(serialized, /portico_mcp_should_not_leak|Authorization|Bearer portico_mcp/);
  assert.equal(sanitizeConfigError(`Bearer portico_mcp_direct ${"y".repeat(500)}`).length <= 320, true);
});

test("Claude Code project-scope repair removes PORTICO overrides and preserves unrelated config", () => {
  const homeDir = tempDir("host-mcp-auto-claude-project-repair-");
  const configPath = resolveClaudeCodeConfigPath(homeDir);
  fs.writeFileSync(configPath, JSON.stringify({
    theme: "dark",
    mcpServers: {
      [BRIDGE_SERVER_NAME]: {
        type: "http",
        url: "http://127.0.0.1:8891/mcp",
        headersHelper: "/portico/helper.sh",
      },
      "other-user-server": {
        command: "other-user-command",
      },
    },
    projects: {
      "/repo-one": {
        allowedTools: ["Read"],
        mcpServers: {
          [BRIDGE_SERVER_NAME]: {
            type: "http",
            url: "http://127.0.0.1:8891/mcp",
          },
          "other-project-server": {
            command: "other-project-command",
          },
        },
      },
      "/repo-two": {
        history: ["keep"],
        mcpServers: {
          [BRIDGE_SERVER_NAME]: {
            type: "http",
            url: "http://127.0.0.1:8891/mcp",
            headersHelper: "/stale/project-helper.sh",
          },
        },
      },
      "/repo-three": {
        mcpServers: {
          "not-portico": {
            command: "keep-me",
          },
        },
      },
    },
  }, null, 2));

  const result = repairClaudeCodeProjectScopedConfig({ homeDir });

  assert.equal(result.success, true);
  assert.equal(result.configPath, configPath);
  assert.equal(result.removedProjectEntries, 2);
  assert.match(result.backupPath, /\.claude\.json\.bak\.\d+$/);
  assert.equal(fs.existsSync(result.backupPath), true);

  const config = readJson(configPath);
  assert.deepEqual(config.mcpServers[BRIDGE_SERVER_NAME], {
    type: "http",
    url: "http://127.0.0.1:8891/mcp",
    headersHelper: "/portico/helper.sh",
  });
  assert.deepEqual(config.mcpServers["other-user-server"], {
    command: "other-user-command",
  });
  assert.equal(config.projects["/repo-one"].allowedTools[0], "Read");
  assert.equal(config.projects["/repo-one"].mcpServers[BRIDGE_SERVER_NAME], undefined);
  assert.deepEqual(config.projects["/repo-one"].mcpServers["other-project-server"], {
    command: "other-project-command",
  });
  assert.equal(config.projects["/repo-two"].history[0], "keep");
  assert.deepEqual(config.projects["/repo-two"].mcpServers, {});
  assert.deepEqual(config.projects["/repo-three"].mcpServers["not-portico"], {
    command: "keep-me",
  });
});

test("Claude Code configuration repairs project-scope overrides idempotently without leaking tokens", async () => {
  const homeDir = tempDir("host-mcp-auto-claude-project-configure-");
  const userDataPath = tempDir("host-mcp-auto-claude-project-configure-userdata-");
  const configPath = resolveClaudeCodeConfigPath(homeDir);
  fs.writeFileSync(configPath, JSON.stringify({
    projects: {
      "/repo-one": {
        mcpServers: {
          [BRIDGE_SERVER_NAME]: {
            type: "http",
            url: "http://127.0.0.1:8891/mcp",
          },
        },
      },
    },
  }, null, 2));
  const calls = [];
  const execFileImpl = createClaudeCodeExecMock({ homeDir, calls });

  const first = await configureMcpClients({
    userDataPath,
    homeDir,
    clientIds: ["claude-code"],
    execFileImpl,
  });
  const second = await configureMcpClients({
    userDataPath,
    homeDir,
    clientIds: ["claude-code"],
    execFileImpl,
  });

  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(calls.length, 4);
  assert.equal(readJson(configPath).projects["/repo-one"].mcpServers[BRIDGE_SERVER_NAME], undefined);
  assert.doesNotMatch(JSON.stringify(first), /portico_mcp_/);
  assert.doesNotMatch(JSON.stringify(second), /portico_mcp_/);
});

test("Claude Code project-scope repair fails on invalid JSON without overwrite", async () => {
  const homeDir = tempDir("host-mcp-auto-claude-project-invalid-");
  const userDataPath = tempDir("host-mcp-auto-claude-project-invalid-userdata-");
  const configPath = resolveClaudeCodeConfigPath(homeDir);
  const invalidJson = "{\n  \"projects\": {\n";
  fs.writeFileSync(configPath, invalidJson);

  assert.throws(
    () => repairClaudeCodeProjectScopedConfig({ homeDir }),
    /Failed to read Claude Code config/,
  );
  assert.equal(fs.readFileSync(configPath, "utf8"), invalidJson);

  const calls = [];
  const result = await configureMcpClients({
    userDataPath,
    homeDir,
    clientIds: ["claude-code"],
    execFileImpl: async (...args) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    },
  });
  assert.equal(result.success, false);
  assert.equal(calls.length, 0);
  assert.match(result.results[0].error, /Failed to read Claude Code config/);
  assert.equal(fs.readFileSync(configPath, "utf8"), invalidJson);
  assert.doesNotMatch(JSON.stringify(result), /portico_mcp_/);
});

test("Claude Code configuration backs up blank config and rolls back failed CLI replacement", async () => {
  const blankHomeDir = tempDir("host-mcp-auto-claude-blank-");
  const blankUserDataPath = tempDir("host-mcp-auto-claude-blank-userdata-");
  const blankConfigPath = resolveClaudeCodeConfigPath(blankHomeDir);
  fs.writeFileSync(blankConfigPath, " \n", "utf8");
  const blankResult = await configureMcpClients({
    userDataPath: blankUserDataPath,
    homeDir: blankHomeDir,
    clientIds: ["claude-code"],
    execFileImpl: createClaudeCodeExecMock({ homeDir: blankHomeDir }),
  });
  assert.equal(blankResult.success, true);
  assert.equal(fs.readFileSync(blankResult.results[0].backupPath, "utf8"), " \n");
  assert.deepEqual(Object.keys(readJson(blankConfigPath).mcpServers[BRIDGE_SERVER_NAME]).sort(), [
    "headersHelper",
    "type",
    "url",
  ]);

  const rollbackHomeDir = tempDir("host-mcp-auto-claude-rollback-");
  const rollbackUserDataPath = tempDir("host-mcp-auto-claude-rollback-userdata-");
  const rollbackConfigPath = resolveClaudeCodeConfigPath(rollbackHomeDir);
  const originalConfig = '{\n  "theme": "dark",\n  "mcpServers": {"other": {"command": "keep"}}\n}\n';
  fs.writeFileSync(rollbackConfigPath, originalConfig, "utf8");
  const rollbackResult = await configureMcpClients({
    userDataPath: rollbackUserDataPath,
    homeDir: rollbackHomeDir,
    clientIds: ["claude-code"],
    execFileImpl: async (_command, args) => {
      if (args[1] === "remove") {
        fs.writeFileSync(rollbackConfigPath, "{}\n", "utf8");
        return { stdout: "", stderr: "" };
      }
      const error = new Error(`failed command ${args.at(-1)}`);
      error.code = "EIO";
      throw error;
    },
  });
  assert.equal(rollbackResult.success, false);
  assert.equal(rollbackResult.results[0].error, "Claude Code add-json failed (EIO)");
  assert.equal(fs.readFileSync(rollbackConfigPath, "utf8"), originalConfig);
  assert.equal(
    fs.readdirSync(rollbackHomeDir).filter((name) => name.startsWith(".claude.json.bak.")).length >= 1,
    true,
  );
  assert.doesNotMatch(JSON.stringify(rollbackResult), /headersHelper|portico_mcp_/);
});

test("Claude Code configuration rolls back when CLI success leaves an unhealthy entry", async () => {
  const homeDir = tempDir("host-mcp-auto-claude-verify-rollback-");
  const userDataPath = tempDir("host-mcp-auto-claude-verify-rollback-userdata-");
  const configPath = resolveClaudeCodeConfigPath(homeDir);
  const originalConfig = '{\n  "theme": "dark"\n}\n';
  fs.writeFileSync(configPath, originalConfig);

  const result = await configureMcpClients({
    userDataPath,
    homeDir,
    clientIds: ["claude-code"],
    execFileImpl: async (_command, args) => {
      if (args[1] === "add-json") {
        fs.writeFileSync(configPath, JSON.stringify({
          theme: "dark",
          mcpServers: {
            [BRIDGE_SERVER_NAME]: {},
          },
        }, null, 2));
      }
      return { stdout: "", stderr: "" };
    },
  });

  assert.equal(result.success, false);
  assert.match(result.results[0].error, /configuration verification failed \(invalid_transport\)/);
  assert.equal(fs.readFileSync(configPath, "utf8"), originalConfig);
});

test("Claude Code rejects non-object config before helper or CLI side effects", async () => {
  const homeDir = tempDir("host-mcp-auto-claude-array-");
  const userDataPath = tempDir("host-mcp-auto-claude-array-userdata-");
  const configPath = resolveClaudeCodeConfigPath(homeDir);
  fs.writeFileSync(configPath, "[]\n", "utf8");
  const calls = [];
  const result = await configureMcpClients({
    userDataPath,
    homeDir,
    clientIds: ["claude-code"],
    execFileImpl: async (...args) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    },
  });

  assert.equal(result.success, false);
  assert.match(result.results[0].error, /JSON object at the top level/);
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(path.join(userDataPath, "host-mcp-bridge", "claude-code-headers-helper.sh")), false);
  assert.equal(fs.readFileSync(configPath, "utf8"), "[]\n");
});

test("Claude Code headers helper emits Authorization JSON from the token file", () => {
  const userDataPath = tempDir("host-mcp-auto-helper-");
  const tokenPath = path.join(userDataPath, "token file");
  fs.writeFileSync(tokenPath, "portico_mcp_helper\n");
  const helperPath = writeClaudeCodeHeadersHelper({ userDataPath, tokenPath });
  const firstOutput = childProcess.execFileSync("sh", [helperPath], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(firstOutput), { Authorization: "Bearer portico_mcp_helper" });

  fs.writeFileSync(tokenPath, "portico_mcp_helper_updated\n");
  const secondOutput = childProcess.execFileSync("sh", [helperPath], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(secondOutput), {
    Authorization: "Bearer portico_mcp_helper_updated",
  });
});

test("Claude Code quoted headers helper command supports Application Support paths", async () => {
  const homeDir = tempDir("host-mcp-auto-helper-command-home-");
  const userDataPath = path.join(
    tempDir("host-mcp-auto-helper-command-userdata-"),
    "Library",
    "Application Support",
    "portico",
  );
  const calls = [];
  const result = await configureMcpClients({
    userDataPath,
    homeDir,
    clientIds: ["claude-code"],
    execFileImpl: createClaudeCodeExecMock({ homeDir, calls }),
  });

  assert.equal(result.success, true);
  const config = JSON.parse(calls[1].args.at(-1));
  assert.match(config.headersHelper, /^'.*Application Support.*claude-code-headers-helper\.sh'$/);
  const output = childProcess.execFileSync("sh", ["-c", config.headersHelper], { encoding: "utf8" });
  const headers = JSON.parse(output);
  assert.match(headers.Authorization, /^Bearer portico_mcp_/);
  assert.equal(config.headersHelper.includes(headers.Authorization.slice("Bearer ".length)), false);
  assert.equal(JSON.stringify(result).includes(headers.Authorization.slice("Bearer ".length)), false);
});

test("Claude Desktop local config writes an idempotent stdio proxy entry without embedding the token", async () => {
  const homeDir = tempDir("host-mcp-auto-claude-desktop-home-");
  const userDataPath = tempDir("host-mcp-auto-claude-desktop-userdata-");
  const tokenInfo = ensureClientBridgeToken({
    userDataPath,
    clientId: "claude-desktop",
    displayName: "Claude Desktop",
  });
  const configPath = resolveClaudeDesktopConfigPath(homeDir, "darwin", {});
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    theme: "dark",
    mcpServers: {
      other: {
        command: "other-command",
        args: ["--flag"],
      },
    },
  }, null, 2));

  const result = writeClaudeDesktopConfig({
    userDataPath,
    homeDir,
    bridgeUrl: "http://127.0.0.1:8891/mcp",
    tokenPath: tokenInfo.tokenPath,
    platform: "darwin",
    env: {},
  });
  const proxyPath = getClaudeDesktopProxyPath(userDataPath);
  const launcherPath = getClaudeDesktopLauncherPath(userDataPath, "darwin");

  assert.equal(result.success, true);
  assert.equal(result.restartRequired, true);
  assert.equal(result.configPath, configPath);
  assert.equal(fs.existsSync(proxyPath), true);
  assert.equal(fs.existsSync(launcherPath), true);

  const config = readJson(configPath);
  assert.deepEqual(config.mcpServers.other, {
    command: "other-command",
    args: ["--flag"],
  });
  assert.deepEqual(config.mcpServers[BRIDGE_SERVER_NAME], {
    command: "/bin/sh",
    args: [launcherPath],
    env: {
      portico_MCP_BRIDGE_URL: "http://127.0.0.1:8891/mcp",
      portico_MCP_BRIDGE_TOKEN_FILE: tokenInfo.tokenPath,
    },
  });
  assert.equal(Object.keys(config.mcpServers).filter((key) => key === BRIDGE_SERVER_NAME).length, 1);

  const resultAgain = writeClaudeDesktopConfig({
    userDataPath,
    homeDir,
    bridgeUrl: "http://127.0.0.1:8891/mcp",
    tokenPath: tokenInfo.tokenPath,
    platform: "darwin",
    env: {},
  });
  assert.equal(resultAgain.success, true);
  const configAgain = readJson(configPath);
  assert.equal(Object.keys(configAgain.mcpServers).filter((key) => key === BRIDGE_SERVER_NAME).length, 1);
  assert.deepEqual(configAgain.mcpServers[BRIDGE_SERVER_NAME], config.mcpServers[BRIDGE_SERVER_NAME]);

  const proxySource = fs.readFileSync(proxyPath, "utf8");
  const launcherSource = fs.readFileSync(launcherPath, "utf8");
  assert.match(proxySource, /Authorization/);
  assert.match(launcherSource, /portico_NODE_BINARY/);
  assert.match(launcherSource, /HOST_NODE_BIN_DIR/);
  const combined = [
    JSON.stringify(configAgain),
    JSON.stringify(result),
    JSON.stringify(resultAgain),
    proxySource,
    launcherSource,
  ].join("\n");
  assert.equal(combined.includes(tokenInfo.token), false);
  assert.doesNotMatch(JSON.stringify(result), /installConfirmationRequired|packagePath/);

  const configured = await configureMcpClients({
    userDataPath,
    homeDir,
    clientIds: ["claude-desktop"],
    platform: "darwin",
    env: {},
    shell: {
      openPath: () => {
        throw new Error("MCPB openPath should not be used");
      },
    },
  });
  assert.equal(configured.success, true);
  assert.equal(configured.results[0].clientId, "claude-desktop");
  assert.equal(configured.results[0].restartRequired, true);
  assert.equal(configured.results[0].configPath, configPath);
  assert.equal(JSON.stringify(configured).includes(tokenInfo.token), false);
  assert.doesNotMatch(JSON.stringify(configured), /installConfirmationRequired|packagePath/);
});

test("Claude Desktop local config fails on invalid JSON without overwriting the config file", () => {
  const homeDir = tempDir("host-mcp-auto-claude-desktop-invalid-home-");
  const userDataPath = tempDir("host-mcp-auto-claude-desktop-invalid-userdata-");
  const tokenInfo = ensureClientBridgeToken({
    userDataPath,
    clientId: "claude-desktop",
    displayName: "Claude Desktop",
  });
  const configPath = resolveClaudeDesktopConfigPath(homeDir, "darwin", {});
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const invalidJson = "{\n  \"mcpServers\": {\n";
  fs.writeFileSync(configPath, invalidJson);

  assert.throws(
    () => writeClaudeDesktopConfig({
      userDataPath,
      homeDir,
      bridgeUrl: "http://127.0.0.1:8891/mcp",
      tokenPath: tokenInfo.tokenPath,
      platform: "darwin",
      env: {},
    }),
    /Failed to read Claude Desktop config/,
  );
  assert.equal(fs.readFileSync(configPath, "utf8"), invalidJson);
  assert.equal(fs.existsSync(path.dirname(getClaudeDesktopProxyPath(userDataPath))), false);
});

test("Claude Desktop local config uses the Windows command shape under APPDATA", () => {
  const homeDir = tempDir("host-mcp-auto-claude-desktop-win-home-");
  const appData = tempDir("host-mcp-auto-claude-desktop-win-appdata-");
  const userDataPath = tempDir("host-mcp-auto-claude-desktop-win-userdata-");
  const tokenInfo = ensureClientBridgeToken({
    userDataPath,
    clientId: "claude-desktop",
    displayName: "Claude Desktop",
  });
  const result = writeClaudeDesktopConfig({
    userDataPath,
    homeDir,
    bridgeUrl: "http://127.0.0.1:8891/mcp",
    tokenPath: tokenInfo.tokenPath,
    platform: "win32",
    env: { APPDATA: appData },
  });
  const configPath = resolveClaudeDesktopConfigPath(homeDir, "win32", { APPDATA: appData });
  const launcherPath = getClaudeDesktopLauncherPath(userDataPath, "win32");
  const config = readJson(configPath);

  assert.equal(result.success, true);
  assert.equal(result.configPath, configPath);
  assert.deepEqual(config.mcpServers[BRIDGE_SERVER_NAME], {
    command: "cmd",
    args: ["/c", launcherPath],
    env: {
      portico_MCP_BRIDGE_URL: "http://127.0.0.1:8891/mcp",
      portico_MCP_BRIDGE_TOKEN_FILE: tokenInfo.tokenPath,
    },
  });
  assert.equal(fs.existsSync(launcherPath), true);
  assert.match(fs.readFileSync(launcherPath, "utf8"), /where node/);
  assert.equal(JSON.stringify(config).includes(tokenInfo.token), false);
});

test("JSONC stripper and Codex upsert preserve unrelated config while replacing the PORTICO section", () => {
  assert.deepEqual(JSON.parse(stripJsonComments('{"a":1,// comment\n"b":[2,],}')), { a: 1, b: [2] });
  const updated = upsertCodexMcpServerToml(
    [
      '[mcp_servers.other]',
      'url = "http://other"',
      '',
      '[mcp_servers.portico.http_headers]',
      'Authorization = "Bearer old"',
      '',
      '[mcp_servers.portico.tools.call_bridge_tool]',
      'approval_mode = "approve"',
      '',
      '[mcp_servers.portico-preview]',
      'url = "http://preview"',
      '',
    ].join("\n"),
    "portico_mcp_new",
    "http://127.0.0.1:8891/mcp",
  );
  assert.match(updated, /\[mcp_servers\.other\]\nurl = "http:\/\/other"/);
  assert.match(updated, /\[mcp_servers\.portico-preview\]\nurl = "http:\/\/preview"/);
  assert.match(updated, /Bearer portico_mcp_new/);
  assert.doesNotMatch(updated, /Bearer old|approval_mode/);
  assert.doesNotMatch(updated, /\[mcp_servers\.portico\./);
  assert.equal(countOccurrences(updated, /\[mcp_servers\.portico\]/g), 1);
  assert.equal(countOccurrences(updated, /http_headers\s*=/g), 1);
});

test("Codex upsert repairs duplicate PORTICO http_headers without touching other MCP servers", () => {
  const broken = [
    '[mcp_servers.other]',
    'url = "http://other"',
    'http_headers = { Authorization = "Bearer other" }',
    '',
    '[mcp_servers.portico]',
    'url = "http://127.0.0.1:8891/mcp"',
    'http_headers = { Authorization = "Bearer redacted" }',
    'http_headers = { Authorization = "Bearer redacted" }',
    '',
    '[mcp_servers.after]',
    'url = "http://after"',
    '',
  ].join("\n");
  const updated = upsertCodexMcpServerToml(
    broken,
    "portico_mcp_repaired",
    "http://127.0.0.1:8891/mcp",
  );

  assert.match(updated, /\[mcp_servers\.other\]\nurl = "http:\/\/other"\nhttp_headers = \{ Authorization = "Bearer other" \}/);
  assert.match(updated, /\[mcp_servers\.after\]\nurl = "http:\/\/after"/);
  assert.equal(countOccurrences(updated, /\[mcp_servers\.portico\]/g), 1);
  assert.equal(countOccurrences(updated, /Bearer portico_mcp_repaired/g), 1);
  assert.equal(countOccurrences(updated, /http_headers\s*=\s*\{ Authorization = "Bearer redacted" \}/g), 0);
  assert.equal(countOccurrences(updated, /http_headers\s*=/g), 2);
});
