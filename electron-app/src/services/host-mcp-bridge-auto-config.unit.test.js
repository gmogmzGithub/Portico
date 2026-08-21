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
  getAtlasDesktopLauncherPath,
  getAtlasDesktopProxyPath,
  removeMcpClientConfigs,
  removeWorkbenchMcpServerToml,
  repairAtlasCodeProjectScopedConfig,
  revealMcpClientConfig,
  resolveAtlasDesktopConfigPath,
  resolveAtlasCodeConfigPath,
  sanitizeConfigError,
  stripJsonComments,
  upsertWorkbenchMcpServerToml,
  writeAmpConfig,
  writeAtlasCodeHeadersHelper,
  writeAtlasDesktopConfig,
  writeWorkbenchConfig,
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

function createAtlasCodeExecMock({ homeDir, calls, removeError } = {}) {
  const configPath = resolveAtlasCodeConfigPath(homeDir);
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
  assert.deepEqual(ids, ["atlas-code", "atlas-desktop", "workbench", "cursor", "amp"]);
  assert.equal(ids.includes("windsurf"), false);
});

test("detection marks installed clients and ignores Atlas Desktop extension policy for local config", () => {
  const homeDir = tempDir("host-mcp-auto-detect-");
  fs.mkdirSync(path.join(homeDir, ".workbench"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".workbench", "config.toml"), "");
  fs.mkdirSync(path.join(homeDir, ".config", "amp"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".config", "amp", "settings.json"), "{}");
  const existingPaths = new Set([
    "/Applications/Atlas.app",
    path.join(homeDir, ".workbench", "config.toml"),
    path.join(homeDir, ".config", "amp", "settings.json"),
  ]);

  const clients = detectMcpClients({
    homeDir,
    platform: "darwin",
    env: { portico_ATLAS_DESKTOP_EXTENSIONS_DISABLED: "1" },
    commandExists: (command) => command === "atlas",
    fileExists: (filePath) => existingPaths.has(filePath),
  });
  const byId = new Map(clients.map((client) => [client.id, client]));

  assert.equal(byId.get("atlas-code").detected, true);
  assert.equal(byId.get("atlas-code").selectable, true);
  assert.equal(byId.get("atlas-desktop").detected, true);
  assert.equal(byId.get("atlas-desktop").blocked, false);
  assert.equal(byId.get("atlas-desktop").selectable, true);
  assert.equal(byId.get("atlas-desktop").statusText, "Detected");
  assert.equal(byId.get("workbench").detected, true);
  assert.equal(byId.get("amp").detected, true);
  assert.deepEqual(
    clients.map((client) => client.id),
    ["atlas-code", "atlas-desktop", "workbench", "amp", "cursor"],
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
      if (args[0] === "atlas" && options.env.PATH.includes(`${os.homedir()}/.local/bin`)) {
        return Buffer.alloc(0);
      }
      throw new Error("not found");
    },
    fileExists: () => false,
  });

  assert.equal(clients.find((client) => client.id === "atlas-code").detected, true);
  assert.equal(commandCalls.length, 4);
  assert.equal(commandCalls.every((call) => call.command === "/usr/bin/which"), true);
  assert.equal(
    commandCalls.every((call) => call.options.env.PATH.includes(`${os.homedir()}/.local/bin`)),
    true,
  );
  assert.equal(commandCalls.every((call) => call.options.env.PATH.includes("/usr/bin")), true);
});

test("Atlas Desktop detection ignores stale Application Support without an installed app", () => {
  const homeDir = tempDir("host-mcp-auto-atlas-stale-");
  const staleSupportDir = path.join(homeDir, "Library", "Application Support", "Atlas");
  fs.mkdirSync(staleSupportDir, { recursive: true });

  const clients = detectMcpClients({
    homeDir,
    platform: "darwin",
    commandExists: () => false,
    fileExists: (filePath) => filePath === staleSupportDir,
  });
  const atlasDesktop = clients.find((client) => client.id === "atlas-desktop");

  assert.equal(atlasDesktop.detected, false);
  assert.equal(atlasDesktop.selectable, false);
  assert.equal(atlasDesktop.statusText, "Not detected");
});

test("Workbench detection supports CLI-only and app-only installs", () => {
  const homeDir = tempDir("host-mcp-auto-workbench-detect-");
  const workbenchAppPath = path.join(homeDir, "Applications", "Workbench.app");
  fs.mkdirSync(workbenchAppPath, { recursive: true });

  const cliOnly = detectMcpClients({
    homeDir,
    platform: "darwin",
    commandExists: (command) => command === "workbench",
    fileExists: () => false,
  }).find((client) => client.id === "workbench");
  assert.equal(cliOnly.detected, true);
  assert.equal(cliOnly.selectable, true);

  const appOnly = detectMcpClients({
    homeDir,
    platform: "darwin",
    commandExists: () => false,
    fileExists: (filePath) => filePath === workbenchAppPath,
  }).find((client) => client.id === "workbench");
  assert.equal(appOnly.detected, true);
  assert.equal(appOnly.selectable, true);
});

test("detection promotes already configured clients to Configured state", () => {
  const homeDir = tempDir("host-mcp-auto-configured-detect-");
  const userDataPath = tempDir("host-mcp-auto-configured-detect-userdata-");
  const bridgeUrl = "http://127.0.0.1:8891/mcp";
  const token = "portico_mcp_detected";
  const atlasTokenInfo = ensureClientBridgeToken({
    userDataPath,
    clientId: "atlas-code",
    displayName: "Atlas Code",
  });
  const atlasHelperPath = writeAtlasCodeHeadersHelper({
    userDataPath,
    tokenPath: atlasTokenInfo.tokenPath,
  });

  fs.writeFileSync(resolveAtlasCodeConfigPath(homeDir), JSON.stringify({
    mcpServers: {
      [BRIDGE_SERVER_NAME]: {
        type: "http",
        url: bridgeUrl,
        headersHelper: `'${atlasHelperPath}'`,
      },
    },
  }, null, 2));
  fs.mkdirSync(path.dirname(resolveAtlasDesktopConfigPath(homeDir, "darwin", {})), { recursive: true });
  fs.writeFileSync(resolveAtlasDesktopConfigPath(homeDir, "darwin", {}), JSON.stringify({
    mcpServers: {
      [BRIDGE_SERVER_NAME]: {
        command: "/bin/sh",
        args: [getAtlasDesktopLauncherPath(userDataPath, "darwin")],
      },
    },
  }, null, 2));
  writeWorkbenchConfig({ homeDir, bridgeUrl, token });
  writeCursorConfig({ homeDir, bridgeUrl, token });
  writeAmpConfig({ homeDir, bridgeUrl, token });

  const clients = detectMcpClients({
    homeDir,
    platform: "darwin",
    env: {},
    userDataPath,
    bridgeUrl,
    commandExists: () => false,
    fileExists: (filePath) => filePath === "/Applications/Atlas.app" || fs.existsSync(filePath),
  });
  const byId = new Map(clients.map((client) => [client.id, client]));

  for (const clientId of ["atlas-code", "atlas-desktop", "workbench", "cursor", "amp"]) {
    const client = byId.get(clientId);
    assert.equal(client.configured, true, `${clientId} should be configured`);
    assert.equal(client.selectable, true, `${clientId} should be selectable`);
    assert.equal(client.status, "configured");
    assert.equal(client.statusText, "Configured");
    assert.equal(typeof client.configPath, "string");
  }
  assert.deepEqual(
    clients.map((client) => client.id),
    ["atlas-code", "atlas-desktop", "workbench", "cursor", "amp"],
  );
});

test("Atlas Code detection marks the observed unauthenticated config shape as needing repair", () => {
  const homeDir = tempDir("host-mcp-auto-atlas-drift-detect-");
  const userDataPath = tempDir("host-mcp-auto-atlas-drift-detect-userdata-");
  fs.writeFileSync(resolveAtlasCodeConfigPath(homeDir), JSON.stringify({
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

  const inspected = inspectMcpClientConfig("atlas-code", {
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
  }).find((client) => client.id === "atlas-code");
  assert.equal(detected.configured, false);
  assert.equal(detected.repairNeeded, true);
  assert.equal(detected.status, "needs_repair");
  assert.equal(detected.statusText, "Needs repair");
  assert.equal(detected.selectable, true);
});

test("Workbench, Cursor, and Amp config writers store bearer headers in expected config formats", () => {
  const homeDir = tempDir("host-mcp-auto-writers-");
  const token = "portico_mcp_config_writer";
  const bridgeUrl = "http://127.0.0.1:8891/mcp";

  const workbench = writeWorkbenchConfig({ homeDir, bridgeUrl, token });
  assert.equal(workbench.success, true);
  const workbenchText = fs.readFileSync(path.join(homeDir, ".workbench", "config.toml"), "utf8");
  assert.match(workbenchText, /\[mcp_servers\.portico\]/);
  assert.match(workbenchText, /url = "http:\/\/127\.0\.0\.1:8891\/mcp"/);
  assert.match(workbenchText, /http_headers = \{ Authorization = "Bearer portico_mcp_config_writer" \}/);
  const workbenchAgain = writeWorkbenchConfig({ homeDir, bridgeUrl, token });
  assert.equal(workbenchAgain.success, true);
  const workbenchTextAgain = fs.readFileSync(path.join(homeDir, ".workbench", "config.toml"), "utf8");
  assert.equal(countOccurrences(workbenchTextAgain, /\[mcp_servers\.portico\]/g), 1);
  assert.equal(countOccurrences(workbenchTextAgain, /http_headers\s*=/g), 1);

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

  fs.writeFileSync(resolveAtlasCodeConfigPath(homeDir), JSON.stringify({
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

  const atlasDesktopConfigPath = resolveAtlasDesktopConfigPath(homeDir, "darwin", {});
  fs.mkdirSync(path.dirname(atlasDesktopConfigPath), { recursive: true });
  fs.writeFileSync(atlasDesktopConfigPath, JSON.stringify({
    mcpServers: {
      [BRIDGE_SERVER_NAME]: { command: "/bin/sh", args: ["launcher.sh"] },
      otherDesktop: { command: "keep-desktop" },
    },
  }, null, 2));

  const workbenchConfigPath = path.join(homeDir, ".workbench", "config.toml");
  writeWorkbenchConfig({ homeDir, bridgeUrl, token });
  fs.writeFileSync(workbenchConfigPath, [
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

  for (const clientId of ["atlas-code", "atlas-desktop", "workbench", "cursor", "amp"]) {
    ensureClientBridgeToken({
      userDataPath,
      clientId,
      displayName: clientId,
    });
  }
  const helperPath = writeAtlasCodeHeadersHelper({
    userDataPath,
    tokenPath: path.join(userDataPath, "token"),
  });
  const proxyPath = getAtlasDesktopProxyPath(userDataPath);
  fs.mkdirSync(path.dirname(proxyPath), { recursive: true });
  fs.writeFileSync(proxyPath, "proxy", "utf8");

  const result = await removeMcpClientConfigs({
    userDataPath,
    homeDir,
    platform: "darwin",
    env: {},
    clientIds: ["atlas-code", "atlas-desktop", "workbench", "cursor", "amp"],
  });

  assert.equal(result.success, true);
  assert.equal(result.results.length, 5);
  assert.equal(result.results.every((entry) => entry.success), true);
  assert.equal(result.results.every((entry) => entry.revoked), true);
  assert.equal(result.results.every((entry) => entry.backupPath && fs.existsSync(entry.backupPath)), true);
  assert.equal(JSON.stringify(result).includes(token), false);

  const atlasCode = readJson(resolveAtlasCodeConfigPath(homeDir));
  assert.equal(atlasCode.mcpServers[BRIDGE_SERVER_NAME], undefined);
  assert.deepEqual(atlasCode.mcpServers.other, { command: "keep-user" });
  assert.equal(atlasCode.projects["/repo"].mcpServers[BRIDGE_SERVER_NAME], undefined);
  assert.deepEqual(atlasCode.projects["/repo"].mcpServers.projectOther, { command: "keep-project" });

  const atlasDesktop = readJson(atlasDesktopConfigPath);
  assert.equal(atlasDesktop.mcpServers[BRIDGE_SERVER_NAME], undefined);
  assert.deepEqual(atlasDesktop.mcpServers.otherDesktop, { command: "keep-desktop" });

  const workbenchText = fs.readFileSync(workbenchConfigPath, "utf8");
  assert.doesNotMatch(workbenchText, /\[mcp_servers\.portico(?:\]|\.)/);
  assert.match(workbenchText, /\[mcp_servers\.other\]\nurl = "http:\/\/other"/);
  assert.equal(readJson(cursorConfigPath).mcpServers[BRIDGE_SERVER_NAME], undefined);
  assert.deepEqual(readJson(cursorConfigPath).mcpServers.otherCursor, { command: "keep-cursor" });
  const ampConfig = readJson(path.join(homeDir, ".config", "amp", "settings.jsonc"));
  assert.equal(ampConfig["amp.mcpServers"][BRIDGE_SERVER_NAME], undefined);
  assert.deepEqual(ampConfig["amp.mcpServers"].otherAmp, { command: "keep-amp" });

  const status = getBridgeAuthRedactedStatus({ userDataPath });
  assert.equal(status.clients.every((client) => client.revoked === true), true);
  for (const clientId of ["atlas-code", "atlas-desktop", "workbench", "cursor", "amp"]) {
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

test("Workbench removal helper drops duplicate parent and descendant PORTICO sections only", () => {
  const removed = removeWorkbenchMcpServerToml([
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
    clientId: "workbench",
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

test("Atlas Code configuration replaces an existing user-scope entry before adding", async () => {
  const homeDir = tempDir("host-mcp-auto-atlas-");
  const userDataPath = tempDir("host-mcp-auto-atlas-userdata-");
  const calls = [];
  const result = await configureMcpClients({
    userDataPath,
    homeDir,
    clientIds: ["atlas-code"],
    env: { PATH: "/usr/bin:/bin" },
    execFileImpl: createAtlasCodeExecMock({ homeDir, calls }),
  });

  assert.equal(result.success, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, "atlas");
  assert.deepEqual(calls[0].args, ["mcp", "remove", "--scope", "user", BRIDGE_SERVER_NAME]);
  assert.equal(calls[1].command, "atlas");
  assert.deepEqual(calls[1].args.slice(0, -1), ["mcp", "add-json", "--scope", "user", BRIDGE_SERVER_NAME]);
  assert.equal(
    calls.every((call) => call.options.env.PATH.includes(`${os.homedir()}/.local/bin`)),
    true,
  );
  assert.equal(calls.every((call) => call.options.env.PATH.includes("/usr/bin")), true);
  const config = JSON.parse(calls[1].args.at(-1));
  assert.equal(config.type, "http");
  assert.equal(config.url, "http://127.0.0.1:8891/mcp");
  assert.match(config.headersHelper, /^'.*atlas-code-headers-helper\.sh'$/);
  assert.doesNotMatch(calls.flatMap((call) => call.args).join(" "), /portico_mcp_/);
  assert.doesNotMatch(JSON.stringify(result), /portico_mcp_/);
});

test("Atlas Code configuration ignores the current CLI missing user-scoped server response", async () => {
  const homeDir = tempDir("host-mcp-auto-atlas-missing-");
  const userDataPath = tempDir("host-mcp-auto-atlas-missing-userdata-");
  const calls = [];
  const removeError = new Error("No user-scoped MCP server found with name: portico");
  removeError.stderr = "No user-scoped MCP server found with name: portico";
  const result = await configureMcpClients({
    userDataPath,
    homeDir,
    clientIds: ["atlas-code"],
    execFileImpl: createAtlasCodeExecMock({ homeDir, calls, removeError }),
  });

  assert.equal(result.success, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ["mcp", "remove", "--scope", "user", BRIDGE_SERVER_NAME]);
  assert.deepEqual(calls[1].args.slice(0, -1), ["mcp", "add-json", "--scope", "user", BRIDGE_SERVER_NAME]);
  assert.doesNotMatch(JSON.stringify(result), /portico_mcp_/);
});

test("Atlas Code configuration reports unexpected remove failures without leaking tokens", async () => {
  const homeDir = tempDir("host-mcp-auto-atlas-remove-fail-");
  const userDataPath = tempDir("host-mcp-auto-atlas-remove-fail-userdata-");
  const calls = [];
  const result = await configureMcpClients({
    userDataPath,
    homeDir,
    clientIds: ["atlas-code"],
    execFileImpl: async (command, args) => {
      calls.push({ command, args });
      if (args[1] === "remove") {
        const error = new Error("permission denied while updating Atlas Code MCP config");
        error.code = "EACCES";
        throw error;
      }
      return { stdout: "", stderr: "" };
    },
  });

  assert.equal(result.success, false);
  assert.equal(calls.length, 1);
  assert.equal(result.results[0].success, false);
  assert.equal(result.results[0].error, "Atlas Code remove failed (EACCES)");
  assert.doesNotMatch(JSON.stringify(result), /portico_mcp_/);
});

test("configuration failure reporting bounds and redacts CLI argument JSON, headers, and tokens", async () => {
  const homeDir = tempDir("host-mcp-auto-atlas-redacted-fail-");
  const userDataPath = tempDir("host-mcp-auto-atlas-redacted-fail-userdata-");
  const logged = [];
  const originalConsoleError = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  let result;
  try {
    result = await configureMcpClients({
      userDataPath,
      homeDir,
      clientIds: ["atlas-code"],
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
  assert.match(logged[0], /Atlas Code remove failed \(EACCES\)/);
  assert.doesNotMatch(serialized, /portico_mcp_should_not_leak|Authorization|Bearer portico_mcp/);
  assert.equal(sanitizeConfigError(`Bearer portico_mcp_direct ${"y".repeat(500)}`).length <= 320, true);
});

test("Atlas Code project-scope repair removes PORTICO overrides and preserves unrelated config", () => {
  const homeDir = tempDir("host-mcp-auto-atlas-project-repair-");
  const configPath = resolveAtlasCodeConfigPath(homeDir);
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

  const result = repairAtlasCodeProjectScopedConfig({ homeDir });

  assert.equal(result.success, true);
  assert.equal(result.configPath, configPath);
  assert.equal(result.removedProjectEntries, 2);
  assert.match(result.backupPath, /\.atlas\.json\.bak\.\d+$/);
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

test("Atlas Code configuration repairs project-scope overrides idempotently without leaking tokens", async () => {
  const homeDir = tempDir("host-mcp-auto-atlas-project-configure-");
  const userDataPath = tempDir("host-mcp-auto-atlas-project-configure-userdata-");
  const configPath = resolveAtlasCodeConfigPath(homeDir);
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
  const execFileImpl = createAtlasCodeExecMock({ homeDir, calls });

  const first = await configureMcpClients({
    userDataPath,
    homeDir,
    clientIds: ["atlas-code"],
    execFileImpl,
  });
  const second = await configureMcpClients({
    userDataPath,
    homeDir,
    clientIds: ["atlas-code"],
    execFileImpl,
  });

  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(calls.length, 4);
  assert.equal(readJson(configPath).projects["/repo-one"].mcpServers[BRIDGE_SERVER_NAME], undefined);
  assert.doesNotMatch(JSON.stringify(first), /portico_mcp_/);
  assert.doesNotMatch(JSON.stringify(second), /portico_mcp_/);
});

test("Atlas Code project-scope repair fails on invalid JSON without overwrite", async () => {
  const homeDir = tempDir("host-mcp-auto-atlas-project-invalid-");
  const userDataPath = tempDir("host-mcp-auto-atlas-project-invalid-userdata-");
  const configPath = resolveAtlasCodeConfigPath(homeDir);
  const invalidJson = "{\n  \"projects\": {\n";
  fs.writeFileSync(configPath, invalidJson);

  assert.throws(
    () => repairAtlasCodeProjectScopedConfig({ homeDir }),
    /Failed to read Atlas Code config/,
  );
  assert.equal(fs.readFileSync(configPath, "utf8"), invalidJson);

  const calls = [];
  const result = await configureMcpClients({
    userDataPath,
    homeDir,
    clientIds: ["atlas-code"],
    execFileImpl: async (...args) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    },
  });
  assert.equal(result.success, false);
  assert.equal(calls.length, 0);
  assert.match(result.results[0].error, /Failed to read Atlas Code config/);
  assert.equal(fs.readFileSync(configPath, "utf8"), invalidJson);
  assert.doesNotMatch(JSON.stringify(result), /portico_mcp_/);
});

test("Atlas Code configuration backs up blank config and rolls back failed CLI replacement", async () => {
  const blankHomeDir = tempDir("host-mcp-auto-atlas-blank-");
  const blankUserDataPath = tempDir("host-mcp-auto-atlas-blank-userdata-");
  const blankConfigPath = resolveAtlasCodeConfigPath(blankHomeDir);
  fs.writeFileSync(blankConfigPath, " \n", "utf8");
  const blankResult = await configureMcpClients({
    userDataPath: blankUserDataPath,
    homeDir: blankHomeDir,
    clientIds: ["atlas-code"],
    execFileImpl: createAtlasCodeExecMock({ homeDir: blankHomeDir }),
  });
  assert.equal(blankResult.success, true);
  assert.equal(fs.readFileSync(blankResult.results[0].backupPath, "utf8"), " \n");
  assert.deepEqual(Object.keys(readJson(blankConfigPath).mcpServers[BRIDGE_SERVER_NAME]).sort(), [
    "headersHelper",
    "type",
    "url",
  ]);

  const rollbackHomeDir = tempDir("host-mcp-auto-atlas-rollback-");
  const rollbackUserDataPath = tempDir("host-mcp-auto-atlas-rollback-userdata-");
  const rollbackConfigPath = resolveAtlasCodeConfigPath(rollbackHomeDir);
  const originalConfig = '{\n  "theme": "dark",\n  "mcpServers": {"other": {"command": "keep"}}\n}\n';
  fs.writeFileSync(rollbackConfigPath, originalConfig, "utf8");
  const rollbackResult = await configureMcpClients({
    userDataPath: rollbackUserDataPath,
    homeDir: rollbackHomeDir,
    clientIds: ["atlas-code"],
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
  assert.equal(rollbackResult.results[0].error, "Atlas Code add-json failed (EIO)");
  assert.equal(fs.readFileSync(rollbackConfigPath, "utf8"), originalConfig);
  assert.equal(
    fs.readdirSync(rollbackHomeDir).filter((name) => name.startsWith(".atlas.json.bak.")).length >= 1,
    true,
  );
  assert.doesNotMatch(JSON.stringify(rollbackResult), /headersHelper|portico_mcp_/);
});

test("Atlas Code configuration rolls back when CLI success leaves an unhealthy entry", async () => {
  const homeDir = tempDir("host-mcp-auto-atlas-verify-rollback-");
  const userDataPath = tempDir("host-mcp-auto-atlas-verify-rollback-userdata-");
  const configPath = resolveAtlasCodeConfigPath(homeDir);
  const originalConfig = '{\n  "theme": "dark"\n}\n';
  fs.writeFileSync(configPath, originalConfig);

  const result = await configureMcpClients({
    userDataPath,
    homeDir,
    clientIds: ["atlas-code"],
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

test("Atlas Code rejects non-object config before helper or CLI side effects", async () => {
  const homeDir = tempDir("host-mcp-auto-atlas-array-");
  const userDataPath = tempDir("host-mcp-auto-atlas-array-userdata-");
  const configPath = resolveAtlasCodeConfigPath(homeDir);
  fs.writeFileSync(configPath, "[]\n", "utf8");
  const calls = [];
  const result = await configureMcpClients({
    userDataPath,
    homeDir,
    clientIds: ["atlas-code"],
    execFileImpl: async (...args) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    },
  });

  assert.equal(result.success, false);
  assert.match(result.results[0].error, /JSON object at the top level/);
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(path.join(userDataPath, "host-mcp-bridge", "atlas-code-headers-helper.sh")), false);
  assert.equal(fs.readFileSync(configPath, "utf8"), "[]\n");
});

test("Atlas Code headers helper emits Authorization JSON from the token file", () => {
  const userDataPath = tempDir("host-mcp-auto-helper-");
  const tokenPath = path.join(userDataPath, "token file");
  fs.writeFileSync(tokenPath, "portico_mcp_helper\n");
  const helperPath = writeAtlasCodeHeadersHelper({ userDataPath, tokenPath });
  const firstOutput = childProcess.execFileSync("sh", [helperPath], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(firstOutput), { Authorization: "Bearer portico_mcp_helper" });

  fs.writeFileSync(tokenPath, "portico_mcp_helper_updated\n");
  const secondOutput = childProcess.execFileSync("sh", [helperPath], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(secondOutput), {
    Authorization: "Bearer portico_mcp_helper_updated",
  });
});

test("Atlas Code quoted headers helper command supports Application Support paths", async () => {
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
    clientIds: ["atlas-code"],
    execFileImpl: createAtlasCodeExecMock({ homeDir, calls }),
  });

  assert.equal(result.success, true);
  const config = JSON.parse(calls[1].args.at(-1));
  assert.match(config.headersHelper, /^'.*Application Support.*atlas-code-headers-helper\.sh'$/);
  const output = childProcess.execFileSync("sh", ["-c", config.headersHelper], { encoding: "utf8" });
  const headers = JSON.parse(output);
  assert.match(headers.Authorization, /^Bearer portico_mcp_/);
  assert.equal(config.headersHelper.includes(headers.Authorization.slice("Bearer ".length)), false);
  assert.equal(JSON.stringify(result).includes(headers.Authorization.slice("Bearer ".length)), false);
});

test("Atlas Desktop local config writes an idempotent stdio proxy entry without embedding the token", async () => {
  const homeDir = tempDir("host-mcp-auto-atlas-desktop-home-");
  const userDataPath = tempDir("host-mcp-auto-atlas-desktop-userdata-");
  const tokenInfo = ensureClientBridgeToken({
    userDataPath,
    clientId: "atlas-desktop",
    displayName: "Atlas Desktop",
  });
  const configPath = resolveAtlasDesktopConfigPath(homeDir, "darwin", {});
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

  const result = writeAtlasDesktopConfig({
    userDataPath,
    homeDir,
    bridgeUrl: "http://127.0.0.1:8891/mcp",
    tokenPath: tokenInfo.tokenPath,
    platform: "darwin",
    env: {},
  });
  const proxyPath = getAtlasDesktopProxyPath(userDataPath);
  const launcherPath = getAtlasDesktopLauncherPath(userDataPath, "darwin");

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

  const resultAgain = writeAtlasDesktopConfig({
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
    clientIds: ["atlas-desktop"],
    platform: "darwin",
    env: {},
    shell: {
      openPath: () => {
        throw new Error("MCPB openPath should not be used");
      },
    },
  });
  assert.equal(configured.success, true);
  assert.equal(configured.results[0].clientId, "atlas-desktop");
  assert.equal(configured.results[0].restartRequired, true);
  assert.equal(configured.results[0].configPath, configPath);
  assert.equal(JSON.stringify(configured).includes(tokenInfo.token), false);
  assert.doesNotMatch(JSON.stringify(configured), /installConfirmationRequired|packagePath/);
});

test("Atlas Desktop local config fails on invalid JSON without overwriting the config file", () => {
  const homeDir = tempDir("host-mcp-auto-atlas-desktop-invalid-home-");
  const userDataPath = tempDir("host-mcp-auto-atlas-desktop-invalid-userdata-");
  const tokenInfo = ensureClientBridgeToken({
    userDataPath,
    clientId: "atlas-desktop",
    displayName: "Atlas Desktop",
  });
  const configPath = resolveAtlasDesktopConfigPath(homeDir, "darwin", {});
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const invalidJson = "{\n  \"mcpServers\": {\n";
  fs.writeFileSync(configPath, invalidJson);

  assert.throws(
    () => writeAtlasDesktopConfig({
      userDataPath,
      homeDir,
      bridgeUrl: "http://127.0.0.1:8891/mcp",
      tokenPath: tokenInfo.tokenPath,
      platform: "darwin",
      env: {},
    }),
    /Failed to read Atlas Desktop config/,
  );
  assert.equal(fs.readFileSync(configPath, "utf8"), invalidJson);
  assert.equal(fs.existsSync(path.dirname(getAtlasDesktopProxyPath(userDataPath))), false);
});

test("Atlas Desktop local config uses the Windows command shape under APPDATA", () => {
  const homeDir = tempDir("host-mcp-auto-atlas-desktop-win-home-");
  const appData = tempDir("host-mcp-auto-atlas-desktop-win-appdata-");
  const userDataPath = tempDir("host-mcp-auto-atlas-desktop-win-userdata-");
  const tokenInfo = ensureClientBridgeToken({
    userDataPath,
    clientId: "atlas-desktop",
    displayName: "Atlas Desktop",
  });
  const result = writeAtlasDesktopConfig({
    userDataPath,
    homeDir,
    bridgeUrl: "http://127.0.0.1:8891/mcp",
    tokenPath: tokenInfo.tokenPath,
    platform: "win32",
    env: { APPDATA: appData },
  });
  const configPath = resolveAtlasDesktopConfigPath(homeDir, "win32", { APPDATA: appData });
  const launcherPath = getAtlasDesktopLauncherPath(userDataPath, "win32");
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

test("JSONC stripper and Workbench upsert preserve unrelated config while replacing the PORTICO section", () => {
  assert.deepEqual(JSON.parse(stripJsonComments('{"a":1,// comment\n"b":[2,],}')), { a: 1, b: [2] });
  const updated = upsertWorkbenchMcpServerToml(
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

test("Workbench upsert repairs duplicate PORTICO http_headers without touching other MCP servers", () => {
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
  const updated = upsertWorkbenchMcpServerToml(
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
