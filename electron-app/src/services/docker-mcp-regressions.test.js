const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "../../..");

function assertContainsInOrder(source, snippets, message) {
  let cursor = 0;
  for (const snippet of snippets) {
    const index = source.indexOf(snippet, cursor);
    assert.notEqual(index, -1, message || `expected to find snippet: ${snippet}`);
    cursor = index + snippet.length;
  }
}

function getYamlServiceBlock(source, serviceName) {
  const lines = source.split("\n");
  const startIndex = lines.findIndex((line) => line === `  ${serviceName}:`);
  assert.notEqual(startIndex, -1, `expected to find service block ${serviceName}`);

  const blockLines = [lines[startIndex]];
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line && /^  [^ ]/.test(line)) {
      break;
    }
    blockLines.push(line);
  }

  return blockLines.join("\n");
}

function assertInternalNoProxyPolicy(source, label) {
  assert.match(
    source,
    /NO_PROXY=.*llm-gateway.*open-webui-health-check.*host\.docker\.internal/,
    `expected ${label} to set uppercase internal NO_PROXY entries`,
  );
  assert.match(
    source,
    /no_proxy=.*llm-gateway.*open-webui-health-check.*host\.docker\.internal/,
    `expected ${label} to set lowercase internal no_proxy entries`,
  );
}

test("docker-mcp host restart paths use the canonical toggle mutator", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );

  const explicitMutatorMatches = source.match(
    /mutateToggles:\s*mutateMcpToggles/g,
  );
  assert.ok(
    explicitMutatorMatches && explicitMutatorMatches.length >= 3,
    "expected restart paths to pass mutateMcpToggles explicitly",
  );
  assert.doesNotMatch(
    source,
    /\n\s+mutateToggles,\n\s+isCoreServer,\n\s+logger: console,\n\s+reasonPrefix: "restartMcpo(?:Server|Servers)"/,
  );
});

test("docker-mcp startup self-heal recreates HOST_MODE as explicit FALSE", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );

  assert.match(source, /file === "HOST_MODE"/);
  assert.match(source, /fs\.writeFileSync\(filePath, "FALSE\\n", "utf8"\)/);
  assert.match(source, /file\.endsWith\("\.json"\)/);
});

test("host MCPO runtime resolution prefers user Node before managed fallback", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );

  const resolverSection = source.slice(
    source.indexOf("function getHostNodeRuntimeCandidateDirs"),
    source.indexOf("/**\n * Check if server is configured"),
  );
  assert.match(resolverSection, /HOST_NODE_BIN_DIR/);
  assert.match(resolverSection, /HOST_NODE_INSTALL_ROOTS/);
  assert.match(resolverSection, /\.local", "lib", "nodejs"/);
  assert.match(resolverSection, /"\/usr\/local\/lib\/nodejs"/);
  assert.match(source, /function listNvmNodeBinDirs/);
  assert.match(resolverSection, /process\.env\.NVM_DIR/);
  assert.match(resolverSection, /\.nvm"/);
  assertContainsInOrder(resolverSection, [
    "configuredNodeBinDir",
    "splitPathEntries(process.env.PATH || \"\")",
    "listNvmNodeBinDirs",
    "installRoots",
  ]);
  assert.match(resolverSection, /path\.join\(nodeBinDir, "node"\)/);
  assert.doesNotMatch(resolverSection, /path\.join\(nodeBinDir, "npx"\)/);
  assert.match(resolverSection, /isNodeVersionCompatible\(nodeVersion, requiredVersion\)/);
});

test("startup failures broadcast immediately without waiting for a health check", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );

  assert.match(source, /function publishStartupFailureState\(failureOrServerId,\s*context = \{\}\) \{/);
  assert.match(source, /state\.updateServerPhase\(failure\.serverId,\s*phase,/);
  assert.match(
    source,
    /annotateHealthSyncDiagnostics\(baseStatus,\s*\{[\s\S]*?mode: "startup-failure",[\s\S]*?bumpSequence: true,/,
  );
  assert.match(source, /broadcastHealthStatusUpdate\(overlaid,\s*\{/);
  assert.match(source, /publishStartupFailureState,/);
});

test("docker restart failures use startup failure publishing wrapper", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );

  assert.match(source, /function recordAndPublishStartupFailure\(projectRoot,\s*failure,\s*options = \{\}\) \{/);
  assert.match(source, /recordAndPublishStartupFailure\(\s*PROJECT_ROOT,[\s\S]*?reason: `restart-config-failure:\$\{serverId\}`/s);
  assert.match(source, /recordAndPublishStartupFailure\(\s*PROJECT_ROOT,[\s\S]*?reason: `restart-failure:\$\{serverId\}`/s);
  assert.doesNotMatch(
    source,
    /const failure = recordStartupFailure\(\s*PROJECT_ROOT,[\s\S]*?restart/s,
  );
});

test("host MCPO launch strips package manager credential environment", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );
  const startSection = source.slice(
    source.indexOf("async function startHostMcpoUnlocked"),
    source.indexOf("state.hostMcpo.process = spawn"),
  );

  assert.match(startSection, /stripPackageManagerCredentialEnv\(hostMcpoEnv\)/);
  for (const credentialPattern of [
    "npm_config_",
    "NPM_CONFIG_",
    "YARN_NPM_",
    "COREPACK_NPM_",
    "BUN_CONFIG_",
    "NODE_AUTH_TOKEN",
    "NPM_AUTH_TOKEN",
    "NPM_TOKEN",
    "YARN_NPM_AUTH_IDENT",
    "COREPACK_NPM_PASSWORD",
    "BUN_AUTH_TOKEN",
    "NVM_NODEJS_ORG_MIRROR",
  ]) {
    assert.match(source, new RegExp(credentialPattern));
  }
  assert.doesNotMatch(
    startSection,
    /NPM_CONFIG_GLOBALCONFIG\s*=\s*path\.join\(PROJECT_ROOT,\s*"\.npmrc"\)/,
  );
  assert.doesNotMatch(startSection, /Preferred npx runtime/);
});

test("Chrome DevTools managed package uses explicit stdio MCP bin at runtime", () => {
  const fragment = JSON.parse(
    fs.readFileSync(
      path.join(REPO_ROOT, "mcp-configs/chrome-devtools/chrome-devtools.fragment"),
      "utf8",
    ),
  );

  assert.equal(fragment.command, "__portico_managed_node_package__");
  assert.equal(fragment.managed_node_package.bin, "chrome-devtools-mcp");
  assert.deepEqual(
    fragment.managed_node_package.runtime_args,
    ["--autoConnect"],
  );
});

test("Slack OAuth uses HTTP loopback instead of local certificate trust", () => {
  const fragment = JSON.parse(
    fs.readFileSync(
      path.join(REPO_ROOT, "mcp-configs/slack/slack.fragment"),
      "utf8",
    ),
  );
  const singleServerScript = fs.readFileSync(
    path.join(REPO_ROOT, "src/scripts/start-single-mcp-server.sh"),
    "utf8",
  );

  assert.equal(fragment.oauth.credentials_source.type, "inline");
  assert.equal(
    fragment.oauth.credentials_source.client_id,
    "2317524819.11152506261415",
  );
  assert.equal(fragment.oauth.credentials_source.client_secret, undefined);
  assert.equal(fragment.oauth.credentials_source.client_id_var, undefined);
  assert.equal(fragment.oauth.credentials_source.client_secret_var, undefined);
  assert.equal(fragment.oauth.client_metadata?.redirect_uris, undefined);
  assert.doesNotMatch(
    JSON.stringify(fragment),
    /https:\/\/localhost:3838\/callback/,
  );
  assert.doesNotMatch(singleServerScript, /security\s+add-trusted-cert/);
  assert.doesNotMatch(singleServerScript, /listen\s+3838\s+ssl/);
  assert.doesNotMatch(singleServerScript, /oauth\.(?:crt|key)/);
  assert.doesNotMatch(singleServerScript, /127\.0\.0\.1:3838:3838/);
});

test("Host MCP Bridge lifecycle publishes PID status and cleanup hooks", () => {
  const dockerSource = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );
  const sharedStateSource = fs.readFileSync(
    path.join(__dirname, "shared-state.js"),
    "utf8",
  );
  const preloadSource = fs.readFileSync(path.join(__dirname, "preload.js"), "utf8");
  const ipcSource = fs.readFileSync(path.join(__dirname, "ipc.js"), "utf8");
  const managerSource = fs.readFileSync(path.join(__dirname, "manager.js"), "utf8");

  assert.match(sharedStateSource, /const hostMcpBridge = \{[\s\S]*port:\s*8891/);
  assert.match(dockerSource, /async function startHostMcpBridgeUnlocked\(\)/);
  assert.match(dockerSource, /MCP_BRIDGE\.pid/);
  assert.match(dockerSource, /HOST_MCP_BRIDGE_PORT_CLEAR_TIMEOUT_MS/);
  assert.match(dockerSource, /HOST_MCP_BRIDGE_STOP_TIMEOUT_MS/);
  assert.match(dockerSource, /HOST_MCP_BRIDGE_PREFERENCES_FILENAME/);
  assert.match(dockerSource, /host-mcp-bridge-preferences\.json/);
  assert.match(dockerSource, /LEGACY_STANDALONE_HOST_MCP_BRIDGE_AGENTS/);
  assert.match(dockerSource, /function readHostMcpBridgePreferences\(options = \{\}\)/);
  assert.match(dockerSource, /function setHostMcpBridgeDesiredEnabled\(enabled, options = \{\}\)/);
  assert.match(dockerSource, /async function listListeningPidsOnPort\(port\)/);
  assert.match(dockerSource, /async function isPortListenerOwnedByProcessGroup\(port, processGroupPid\)/);
  assert.match(dockerSource, /async function waitForPortListenersToClear\(/);
  assert.match(dockerSource, /async function stopLegacyStandaloneHostMcpBridgeLaunchAgents\(\)/);
  assert.match(dockerSource, /com\.portico\.portico-mcp-bridge\.bridge/);
  assert.match(dockerSource, /com\.portico\.portico-mcp-bridge\.serve/);
  assert.match(dockerSource, /launchctl"[\s\S]*\["disable", `\$\{domain\}\/\$\{agent\.label\}`\]/);
  assert.match(dockerSource, /launchctl"[\s\S]*\["bootout", domain, plistPath\]/);
  assert.match(dockerSource, /const hostMcpBridgeListenerPids = hostMcpBridgeProcessRunning\s*\?\s*\[\]\s*:\s*await listListeningPidsOnPort\(state\.hostMcpBridge\.port\);/);
  assert.match(dockerSource, /const hostMcpBridgeHealthResponding = hostMcpBridgeProcessRunning[\s\S]*await checkHostMcpBridgeHealth\(500\);/);
  assert.match(dockerSource, /status\["host-mcp-bridge"\]\s*=\s*"running"/);
  assert.match(dockerSource, /status\["host-mcp-bridge-pid"\]\s*=\s*hostMcpBridgePid/);
  assert.match(dockerSource, /startHostMcpBridge,/);
  assert.match(dockerSource, /ensureHostMcpBridgeReady,/);
  assert.match(dockerSource, /stopHostMcpBridge,/);
  assert.match(dockerSource, /readHostMcpBridgePreferences,/);
  assert.match(dockerSource, /isHostMcpBridgeDesiredEnabled,/);
  assert.match(dockerSource, /setHostMcpBridgeDesiredEnabled,/);
  assert.match(dockerSource, /require\("\.\/host-mcp-bridge-telemetry"\)/);
  assert.match(dockerSource, /emitBridgeLogRepoEvent\("bridge_process_start_requested"/);
  assert.match(dockerSource, /emitBridgeLogRepoEvent\("bridge_process_started"/);
  assert.match(dockerSource, /emitBridgeLogRepoEvent\("bridge_health_probe"/);
  assert.match(dockerSource, /emitBridgeLogRepoEvent\("bridge_process_exited"/);
  assert.match(dockerSource, /emitBridgeLogRepoEvent\("bridge_process_stop_requested"/);
  assert.match(dockerSource, /emitBridgeLogRepoEvent\("bridge_process_stop_failed"/);
  assert.match(dockerSource, /Host MCP Bridge port \$\{state\.hostMcpBridge\.port\} is still in use after stop/);
  assert.match(preloadSource, /hostMcpBridgeLogs:\s*\(lines\) => ipcRenderer\.invoke\('host-mcp-bridge-logs', lines\)/);
  assert.match(preloadSource, /hostMcpBridgeStart:\s*\(\) => ipcRenderer\.invoke\('start-host-mcp-bridge'\)/);
  assert.match(ipcSource, /ipcMain\.handle\("start-host-mcp-bridge"/);
  assert.match(ipcSource, /ipcMain\.handle\("host-mcp-bridge-logs"/);
  assert.match(ipcSource, /await checkDockerStatus\(\);/);
  assert.match(managerSource, /'host-mcp-bridge': \{ displayName: 'Host MCP Bridge', type: 'host-bridge'/);
  assert.match(managerSource, /stopHostMcpBridge\(\)/);
});

test("Host MCP Bridge startup preserves healthy sessions across service restarts", () => {
  const dockerSource = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );
  const mainSource = fs.readFileSync(
    path.join(REPO_ROOT, "electron-app/src/services/main.js"),
    "utf8",
  );
  const startSection = dockerSource.slice(
    dockerSource.indexOf("async function startHostMcpBridgeUnlocked()"),
    dockerSource.indexOf("async function pollHostMcpBridgeHealth"),
  );
  const ensureSection = dockerSource.slice(
    dockerSource.indexOf("async function ensureHostMcpBridgeReady("),
    dockerSource.indexOf("async function stopHostMcpBridgeUnlocked"),
  );
  const startupWrapper = mainSource.slice(
    mainSource.indexOf("const ensureHostMcpBridgeReadyForStartup = async () =>"),
    mainSource.indexOf("if (!checkResult.needsRestart)"),
  );

  assert.match(dockerSource, /async function checkHostMcpBridgeHealth\(timeoutMs = 2000, options = \{\}\)/);
  assert.match(startSection, /await checkHostMcpBridgeHealth\(2000,\s*\{\s*expectedProcessGroupPid: existingPid,\s*\}\)/);
  assert.match(startSection, /alreadyRunning:\s*true/);
  assert.match(startSection, /isHostMcpoStartupPending\(state\.hostMcpBridge\)/);
  assert.match(startSection, /Existing process is unhealthy; replacing it/);
  assert.match(startSection, /await stopHostMcpBridgeUnlocked\(\{ reason: "startup_cleanup" \}\)/);
  assert.match(startSection, /await waitForPortListenersToClear\(state\.hostMcpBridge\.port\)/);
  assert.match(startSection, /Host MCP Bridge port \$\{state\.hostMcpBridge\.port\} is still in use after cleanup/);
  assert.match(startSection, /const bridgeProcess = spawn\("bash", \[bridgeScript\]/);
  assert.match(startSection, /if \(state\.hostMcpBridge\.process === bridgeProcess\) \{/);
  assert.match(startSection, /expectedProcessGroupPid: bridgeProcess\.pid \|\| null/);
  assert.match(dockerSource, /checkHostMcpBridgeHealth\(2000, options\)/);
  assert.match(dockerSource, /Health polling cancelled; process \$\{expectedProcessGroupPid\} is no longer active/);
  assert.match(ensureSection, /const expectedProcessGroupPid = startResult\?\.pid \|\| null;/);
  assert.match(ensureSection, /await checkHostMcpBridgeHealth\(500, \{ expectedProcessGroupPid \}\)/);
  assert.doesNotMatch(ensureSection, /stopHostMcpBridge/);
  // PORTICO-200: the external-client bridge preference must never stop the OAuth
  // broker daemon at startup; a disabled preference is informational only.
  assert.match(startupWrapper, /if \(!isHostMcpBridgeDesiredEnabled\(\)\) \{/);
  assert.doesNotMatch(startupWrapper, /stopHostMcpBridge/);
  assert.doesNotMatch(startupWrapper, /startup_disabled_preference/);
  assert.doesNotMatch(startupWrapper, /ensuring it is stopped/);
  assert.match(startupWrapper, /keeping the OAuth broker available/);
  assert.match(startupWrapper, /await ensureHostMcpBridgeReady\(\)/);

  // PORTICO-200: broker readiness must not require the external-client
  // `bridgeEnabled` preference, only genuine broker health/auth signals.
  const brokerStatusSection = dockerSource.slice(
    dockerSource.indexOf("async function checkHostMcpBridgeBrokerStatus("),
    dockerSource.indexOf("async function startHostMcpBridgeUnlocked()"),
  );
  assert.match(brokerStatusSection, /payload\?\.success === true/);
  assert.match(brokerStatusSection, /payload\?\.bridgeReady === true/);
  assert.match(brokerStatusSection, /payload\?\.brokerAuthReady === true/);
  assert.doesNotMatch(brokerStatusSection, /payload\?\.bridgeEnabled === true/);
});

test("Host MCP Bridge readiness gates fast and full Docker startup paths", () => {
  const mainSource = fs.readFileSync(
    path.join(REPO_ROOT, "electron-app/src/services/main.js"),
    "utf8",
  );
  const fastPath = mainSource.slice(
    mainSource.indexOf("if (!checkResult.needsRestart)"),
    mainSource.indexOf("// FULL RESTART PATH"),
  );
  const fullPath = mainSource.slice(
    mainSource.indexOf("// FULL RESTART PATH"),
    mainSource.indexOf("// CONTAINER CHECK"),
  );

  assertContainsInOrder(
    fastPath,
    [
      '"loading-step-complete",\n          "mcp-config",',
      "await ensureHostMcpBridgeReadyForStartup()",
      "if (configChanged)",
      "dockerComposeCommand",
    ],
    "fast startup must wait for the OAuth broker before Docker launch",
  );
  assertContainsInOrder(
    fullPath,
    [
      '"loading-step-complete",\n          "mcp-config",',
      "await ensureHostMcpBridgeReadyForStartup()",
      "const dockerComposeCommand",
      "dockerStartResult = await executeWithStreaming",
      "if (!dockerStartResult.success)",
    ],
    "full startup must wait for the OAuth broker before Docker launch",
  );
});

test("manual packaged runtime updates prepare exact Docker images before startup", () => {
  const mainSource = fs.readFileSync(
    path.join(REPO_ROOT, "electron-app/src/services/main.js"),
    "utf8",
  );
  const dockerReadyIndex = mainSource.indexOf(
    "const dockerReady = await ensureDockerRunning()",
  );
  const imagePreparationIndex = mainSource.indexOf(
    "if (app.isPackaged && runtimeUpdateResult.updated)",
  );
  const dockerLaunchIndex = mainSource.indexOf(
    "const dockerComposeCommand",
    imagePreparationIndex,
  );
  const imagePreparationSection = mainSource.slice(
    imagePreparationIndex,
    dockerLaunchIndex,
  );

  assert.ok(dockerReadyIndex >= 0, "expected Docker readiness gate");
  assert.ok(
    imagePreparationIndex > dockerReadyIndex,
    "exact-build image preparation must run after Docker is ready",
  );
  assert.ok(
    dockerLaunchIndex > imagePreparationIndex,
    "exact-build images must be prepared before Docker startup",
  );
  assertContainsInOrder(
    imagePreparationSection,
    [
      "getDockerImagesToPull({",
      "tag: updatedBuildNumber",
      "pullDockerImagesWithProgress({",
      "buildPackagedDockerRecoveryFailure(",
    ],
    "manual runtime updates must pull the exact build and retain recovery guidance",
  );
});

test("Docker startup preflight owns failures before container readiness begins", () => {
  const mainSource = fs.readFileSync(
    path.join(REPO_ROOT, "electron-app/src/services/main.js"),
    "utf8",
  );
  const classifierSource = fs.readFileSync(
    path.join(
      REPO_ROOT,
      "electron-app/src/services/startup-failure-classifier.js",
    ),
    "utf8",
  );
  const startupSection = mainSource.slice(
    mainSource.indexOf("const dockerComposeCommand"),
    mainSource.indexOf("// CONTAINER CHECK"),
  );
  const classifierSection = classifierSource.slice(
    classifierSource.indexOf("function classifyContainerStartupFailure"),
    classifierSource.indexOf("module.exports"),
  );

  assertContainsInOrder(
    startupSection,
    [
      "dockerStartResult = await executeWithStreaming",
      "if (!dockerStartResult.success)",
      '"loading-step-complete",\n          "start",',
      "proceeding to container readiness",
    ],
    "container readiness must not consume its budget during Docker preflight",
  );
  assert.doesNotMatch(
    startupSection,
    /Promise\.race/,
    "Docker startup failures must not race a fixed readiness timeout",
  );
  assertContainsInOrder(
    classifierSection,
    ["package_prepare_failed", "timeout waiting for containers"],
    "managed package failures must be classified before generic readiness timeouts",
  );
});

test("host mode caches are invalidated around toggles and MCP restarts", () => {
  const dockerSource = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );
  const ipcSource = fs.readFileSync(path.join(__dirname, "ipc.js"), "utf8");
  const rendererSource = fs.readFileSync(
    path.join(REPO_ROOT, "electron-app/src/renderer/views/index.js"),
    "utf8",
  );
  const mcpServersSource = fs.readFileSync(
    path.join(REPO_ROOT, "electron-app/src/renderer/components/mcp-servers.js"),
    "utf8",
  );

  assert.match(dockerSource, /function invalidateHostModeCaches\(\)/);
  assert.match(dockerSource, /async function restartMcpoServer[\s\S]*invalidateHostModeCaches\(\)/);
  assert.match(dockerSource, /async function restartMcpoServers[\s\S]*invalidateHostModeCaches\(\)/);
  assert.match(dockerSource, /async function restartAllMcpoServers[\s\S]*invalidateHostModeCaches\(\)/);
  assert.match(ipcSource, /dockerMcp\.invalidateHostModeCaches\?\.\(\);/);
  assert.match(
    rendererSource,
    /onMcpServerToggled\(async[\s\S]*await checkHostModeSupport\(\);[\s\S]*window\.updateMcpServersList\(\);/,
  );
  assert.match(mcpServersSource, /await window\.checkHostModeSupport\(\);/);
});

test("docker-mcp canonicalizes legacy agent-vm disabled tool ids on read and save", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );

  assert.match(source, /const AGENT_VM_DISABLED_TOOL_RENAMES = Object\.freeze\(\{/);
  assert.match(source, /vm_search_files:\s*"vm_grep"/);
  assert.match(source, /vm_search_file_matches:\s*"vm_grep_file"/);
  assert.match(source, /disabledTools = normalizeDisabledTools\(\s*serverId,\s*toolsConfig\[serverId\]\?\.disabled_tools \|\| \[\],/);
  assert.match(source, /const normalizedDisabledTools = normalizeDisabledTools\(\s*serverId,\s*disabledTools \|\| \[\],/);
  assert.match(source, /disabled_tools:\s*normalizedDisabledTools/);
});

test("docker compose start can skip duplicate MCP override regeneration after an explicit refresh", () => {
  const source = fs.readFileSync(
    path.join(REPO_ROOT, "src/scripts/docker-compose.sh"),
    "utf8",
  );

  assert.match(source, /MCPO_SKIP_GENERATED_OVERRIDE_REFRESH/);
  assert.match(
    source,
    /Skipping generated MCPO compose override refresh \(already refreshed by caller\)/,
  );
});

test("base compose resolves the reporting mount from an explicit host-dir env with a repo-local default", () => {
  const source = fs.readFileSync(
    path.join(REPO_ROOT, "docker-compose.yml"),
    "utf8",
  );

  assert.match(
    source,
    /"\$\{PORTICO_COST_REPORTING_HOST_DIR:-\.\/open-webui-data\/reporting\}:\/app\/reporting"/,
  );
  assert.match(source, /PORTICO_COST_REPORTING_DIR=\/app\/reporting/);
});

test("stable compose services set internal NO_PROXY policy for Compose hostnames", () => {
  const baseCompose = fs.readFileSync(
    path.join(REPO_ROOT, "docker-compose.yml"),
    "utf8",
  );
  for (const serviceName of [
    "llm-gateway",
    "mcpo",
    "open-webui",
    "chat-state-api",
    "health-check",
  ]) {
    assertInternalNoProxyPolicy(
      getYamlServiceBlock(baseCompose, serviceName),
      `docker-compose.yml ${serviceName}`,
    );
  }

});

test("docker-mcp injects a packaged-aware reporting host dir into compose env", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );
  const helperSource = fs.readFileSync(
    path.join(__dirname, "runtime-reporting-path.js"),
    "utf8",
  );

  assert.match(source, /const COST_REPORTING_HOST_DIR_ENV = "PORTICO_COST_REPORTING_HOST_DIR";/);
  assert.match(source, /resolveRuntimeCostReportingHostDir/);
  assert.match(source, /app\.getPath\("userData"\)/);
  assert.match(source, /Runtime host reporting directory:/);
  assert.match(helperSource, /path\.join\(normalizedUserDataPath, "reporting"\)/);
  assert.match(helperSource, /path\.join\(normalizedProjectRoot, "open-webui-data", "reporting"\)/);
});

test("docker-mcp injects the runtime Application Support host dir into compose env", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );

  assert.match(source, /const APP_SUPPORT_HOST_DIR_ENV = "PORTICO_APP_SUPPORT_DIR";/);
  assert.match(source, /app\.getPath\("userData"\)/);
  assert.match(source, /path\.join\(getProjectRoot\(\), "open-webui-data", "app-support"\)/);
  assert.match(source, /Runtime host Application Support directory:/);
  assert.match(source, /ensureRuntimeAppSupportHostDir\(/);
});

test("docker-mcp injects the runtime workspace config host dir into compose env", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );

  assert.match(source, /const WORKSPACE_CFG_HOST_DIR_ENV = "PORTICO_WORKSPACE_CFG_DIR";/);
  assert.match(source, /path\.join\(userDataPath, "workspace-cfg"\)/);
  assert.match(source, /path\.join\(getProjectRoot\(\), "open-webui-data", "workspace-cfg"\)/);
  assert.match(source, /Runtime host workspace config directory:/);
  assert.match(source, /ensureRuntimeWorkspaceCfgHostDir\(/);
});

test("shared mcpo control-plane service mounts only workspace config for chat workspace settings", () => {
  const composeSource = fs.readFileSync(path.join(REPO_ROOT, "docker-compose.yml"), "utf8");
  const overrideSource = fs.readFileSync(path.join(REPO_ROOT, "docker-compose.override.yml"), "utf8");
  const mcpoBlock = getYamlServiceBlock(composeSource, "mcpo");
  const overrideMcpoBlock = getYamlServiceBlock(overrideSource, "mcpo");

  for (const [label, block] of [
    ["base compose mcpo", mcpoBlock],
    ["generated override mcpo", overrideMcpoBlock],
  ]) {
    assert.match(
      block,
      /\$\{PORTICO_WORKSPACE_CFG_DIR:-\.\/open-webui-data\/workspace-cfg\}:\/app\/workspace-cfg:rw/,
      `expected ${label} to mount workspace config`,
    );
    assert.match(
      block,
      /PORTICO_WORKSPACE_CFG_DIR=\/app\/workspace-cfg/,
      `expected ${label} to expose workspace config to the runtime`,
    );
    assert.doesNotMatch(
      block,
      /PORTICO_APP_SUPPORT_DIR|\/app\/app-support/,
      `expected ${label} not to mount full Application Support for workspace settings`,
    );
  }
});

test("docker-mcp canonicalizes health snapshots before caching lifecycle phase", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );

  assert.match(
    source,
    /const \{\s*READINESS_PHASE_TOOL_READY,\s*canonicalizeReadinessPhase,\s*\} = require\("\.\/readiness-phase"\);/,
  );
  assert.match(
    source,
    /const phase = canonicalizeReadinessPhase\(\{\s*healthy,[\s\S]*status: serverInfo\.status,[\s\S]*\}\);/,
  );
});

test("single-server health probes publish tool_ready through the canonical publisher", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );

  assert.match(
    source,
    /await publishTargetedMcpReadiness\(\{[\s\S]*serverId,[\s\S]*phase: READINESS_PHASE_TOOL_READY,[\s\S]*healthy: true,/,
  );
  assert.match(
    source,
    /source: "single-server-direct-probe"/,
  );
  assert.doesNotMatch(source, /healthData\.servers\[serverId\]\.readiness_phase/);
});

test("Rust compose generator mounts workspace config, Application Support, and internal NO_PROXY into runtime containers", () => {
  const rustGeneratorSource = fs.readFileSync(
    path.join(REPO_ROOT, "src/mcp-orc-rust/crates/mcp-orc/src/generator.rs"),
    "utf8",
  );

  assert.match(
    rustGeneratorSource,
    /\$\{\{PORTICO_WORKSPACE_CFG_DIR:-\.\/open-webui-data\/workspace-cfg\}\}:\/app\/workspace-cfg:rw/,
  );
  assert.match(
    rustGeneratorSource,
    /PORTICO_WORKSPACE_CFG_DIR=\/app\/workspace-cfg/,
  );
  assert.match(
    rustGeneratorSource,
    /\$\{\{PORTICO_APP_SUPPORT_DIR:-\.\/open-webui-data\/app-support\}\}:\/app\/app-support:rw/,
  );
  assert.match(
    rustGeneratorSource,
    /PORTICO_APP_SUPPORT_DIR=\/app\/app-support/,
  );
  assert.match(
    rustGeneratorSource,
    /INTERNAL_DOCKER_NO_PROXY_BASE_ENTRIES[\s\S]*llm-gateway/,
  );
  assert.match(rustGeneratorSource, /fn dynamic_internal_no_proxy_default/);
  assert.match(
    rustGeneratorSource,
    /INTERNAL_DOCKER_NO_PROXY_DEFAULT_PLACEHOLDER/,
  );
  assert.match(rustGeneratorSource, /fn internal_no_proxy_env_lines/);
  assert.match(
    rustGeneratorSource,
    /NO_PROXY=\$\{\{NO_PROXY:-\}\},\$\{\{PORTICO_INTERNAL_NO_PROXY:-/,
  );
  assert.match(
    rustGeneratorSource,
    /mcpo:\\n[\s\S]*volumes: !override\\n[\s\S]*\$\{\{PORTICO_WORKSPACE_CFG_DIR:-\.\/open-webui-data\/workspace-cfg\}\}:\/app\/workspace-cfg:rw[\s\S]*environment: !override\\n[\s\S]*PORTICO_WORKSPACE_CFG_DIR=\/app\/workspace-cfg/,
  );
});

test("readiness docker run inherits internal NO_PROXY policy", () => {
  const source = fs.readFileSync(
    path.join(REPO_ROOT, "src/scripts/check-containers-ready.sh"),
    "utf8",
  );

  assert.match(
    source,
    /PORTICO_INTERNAL_NO_PROXY_BASE_DEFAULT=.*llm-gateway/,
  );
  assert.match(source, /build_internal_no_proxy_default/);
  assert.match(source, /server-routing\.json/);
  assert.match(source, /HEALTH_CHECK_IMAGE_FALLBACK="portico-health-check:latest"/);
  assert.match(source, /resolve_health_check_image_from_harbor_compose/);
  assert.match(source, /docker-compose\.harbor\.yml/);
  assert.match(source, /echo "\$HEALTH_CHECK_IMAGE_FALLBACK"/);
  assert.match(source, /HEALTH_CHECK_IMAGE="\$\(resolve_health_check_image\)"/);
  assert.match(source, /docker image inspect "\$HEALTH_CHECK_IMAGE"/);
  assert.doesNotMatch(source, /python -c/);
  assert.match(source, /\/usr\/local\/bin\/health-check-rust startup-readiness/);
  assert.match(source, /"\$HEALTH_CHECK_IMAGE"\s*\\\n\s*\/usr\/local\/bin\/health-check-rust startup-readiness/);
  assert.match(
    source,
    /-e NO_PROXY="\$\{NO_PROXY:-\},\$\{PORTICO_INTERNAL_NO_PROXY:-\$PORTICO_INTERNAL_NO_PROXY_DEFAULT\}"/,
  );
  assert.match(
    source,
    /-e no_proxy="\$\{no_proxy:-\},\$\{PORTICO_INTERNAL_NO_PROXY:-\$PORTICO_INTERNAL_NO_PROXY_DEFAULT\}"/,
  );
});

test("startup uses a longer MCP config timeout and keeps docker-compose.sh responsible for the final runtime refresh", () => {
  const source = fs.readFileSync(
    path.join(REPO_ROOT, "electron-app/src/services/main.js"),
    "utf8",
  );

  assert.match(source, /const MCP_CONFIG_STARTUP_TIMEOUT_MS = 180000;/);
  assert.match(source, /ensureMcpOrcGeneratorCommand\(\s*PROJECT_ROOT,\s*"generate-docker-compose-override"/);
  assert.match(source, /const dockerComposeCommand = `bash "\$\{path\.join\(SCRIPTS_DIR, "docker-compose\.sh"\)\}"`;/);
  assert.doesNotMatch(source, /MCPO_SKIP_GENERATED_OVERRIDE_REFRESH=1 bash/);
  assert.doesNotMatch(source, /generate-docker-compose-override\.sh/);
});

// PORTICO-373: this was a source pin that read main.js and asserted a literal ordering
// of `sendInitLog`/`webContents.send` calls. The invariant it guarded -- config and
// runtime-secret preparation must never run alongside or after an unfinished
// teardown -- is now enforced structurally: the stop phase fails closed and returns
// before config generation, so the ordering cannot be violated without deleting the
// guard. The decision that produces it (stop, repair a wedged engine, retry once,
// otherwise abort) is covered behaviourally by runTeardownWithEngineRecovery in
// engine-wedge-recovery.unit.test.js.
//
// Not re-pointed at the new source text: that is explicitly forbidden by AGENTS.md,
// and the old pin would have passed against the fail-OPEN code that caused PORTICO-373.
// main.js itself has no behavioural harness in this repo (this whole file is source
// pins); giving the restart flow one is a larger piece of work than this fix.

test("packaged runtime startup runs a Harbor-only self-heal before docker compose", () => {
  const dockerComposeSource = fs.readFileSync(
    path.join(REPO_ROOT, "src/scripts/docker-compose.sh"),
    "utf8",
  );

  assert.match(dockerComposeSource, /managed_runtime_self_heal_packaged_runtime "\$PROJECT_ROOT" "\$SCRIPT_DIR"/);
  assert.match(
    dockerComposeSource,
    /Packaged runtime requires Harbor images for build \$build_number; aborting instead of falling back to local Dockerfile builds/,
  );
  assert.match(
    dockerComposeSource,
    /Skipping generated MCPO compose override refresh \(already refreshed by packaged runtime preflight\)/,
  );
});

test("docker compose startup cleans stale app MCP containers before forced recreate", () => {
  const dockerComposeSource = fs.readFileSync(
    path.join(REPO_ROOT, "src/scripts/docker-compose.sh"),
    "utf8",
  );

  assert.match(dockerComposeSource, /function cleanup_stale_app_mcp_containers\(\)|cleanup_stale_app_mcp_containers\(\)\s*\{/);
  assert.match(
    dockerComposeSource,
    /run_docker_compose \$compose_files config --services/,
  );
  assert.match(dockerComposeSource, /case "\$service_name" in[\s\S]*mcpo-\*\)/);
  assert.match(dockerComposeSource, /label=com\.docker\.compose\.project=portico/);
  assert.match(dockerComposeSource, /label=com\.docker\.compose\.service=\$\{service_name\}/);
  assert.match(dockerComposeSource, /if \[ -n "\$force_recreate" \]; then[\s\S]*docker rm -f "\$container_name"/);
  assert.match(dockerComposeSource, /Removing orphaned app-owned MCP runtime container/);
  assertContainsInOrder(dockerComposeSource, [
    'cleanup_stale_app_mcp_containers "$COMPOSE_FILES" "$FORCE_RECREATE"',
    'cleanup_mcp_docker_run_child_containers',
    'if run_compose_up_with_retry "$COMPOSE_FILES" "$FORCE_RECREATE"; then',
  ]);
});

test("docker compose startup retries expected stale name conflicts only once", () => {
  const dockerComposeSource = fs.readFileSync(
    path.join(REPO_ROOT, "src/scripts/docker-compose.sh"),
    "utf8",
  );

  assert.match(dockerComposeSource, /extract_compose_container_name_conflicts\(\)\s*\{/);
  assert.match(dockerComposeSource, /container name "\\\/\?\(\[\^"\]\+\)"/);
  assert.match(dockerComposeSource, /is_expected_compose_container_name "\$compose_files" "\$conflict_name"/);
  assert.match(dockerComposeSource, /Docker reported a name conflict for non-app container/);
  assertContainsInOrder(dockerComposeSource, [
    "local conflict_cleanup_done=false",
    'if [ "$conflict_cleanup_done" = false ] && cleanup_compose_container_name_conflicts "$compose_files" "$compose_output"; then',
    "conflict_cleanup_done=true",
  ]);
});

test("docker-backed MCP child cleanup is constrained to declared docker run images", () => {
  const dockerComposeSource = fs.readFileSync(
    path.join(REPO_ROOT, "src/scripts/docker-compose.sh"),
    "utf8",
  );

  assert.match(dockerComposeSource, /list_declared_mcp_docker_run_images\(\)\s*\{/);
  assert.match(dockerComposeSource, /"\$PROJECT_ROOT\/mcpo-configs-generated"/);
  assert.match(dockerComposeSource, /"\$PROJECT_ROOT\/mcp-configs"/);
  assert.match(dockerComposeSource, /"\$PROJECT_ROOT\/mcp-configs-user"/);
  assert.match(dockerComposeSource, /select\(\.command\? == "docker" and \(\.args\? \| type == "array"\)\)/);
  assert.match(dockerComposeSource, /docker ps -aq --filter "ancestor=\$\{image_ref\}"/);
  assert.doesNotMatch(dockerComposeSource, /docker system prune/);
});

// PORTICO-373: this was a source pin on executeWithStreaming's abort wiring, including
// the literal `child.kill("SIGTERM")` that WAS the bug -- signalling the leader
// alone leaves the real command running. Killing a tree cannot be asserted by
// reading source, so the invariant moved to behavioural coverage against real
// processes in process-tree-termination.unit.test.js (tree termination and
// confirmed exit) and execute-with-streaming-tree-termination.unit.test.js
// (timeout/abort settle contract). Re-pointing the regex would have pinned the
// new spelling of a fixed bug.

test("runtime shell env propagates packaged mcp-orc context to child shells", () => {
  const shellEnvSource = fs.readFileSync(
    path.join(REPO_ROOT, "electron-app/src/services/runtime-shell-env.js"),
    "utf8",
  );
  const mainSource = fs.readFileSync(
    path.join(REPO_ROOT, "electron-app/src/services/main.js"),
    "utf8",
  );
  const updatesSource = fs.readFileSync(
    path.join(REPO_ROOT, "electron-app/src/services/updates.js"),
    "utf8",
  );

  assert.match(shellEnvSource, /HOST_MCP_IS_PACKAGED = isPackagedApp \? "1" : "0"/);
  assert.match(shellEnvSource, /HOST_MCP_RESOURCES_ROOT = resourcesPath/);
  assert.match(mainSource, /createRuntimeShellEnv/);
  assert.match(updatesSource, /createRuntimeShellEnv/);
});

test("OrbStack Docker startup uses a bounded docker-info probe and shared restart helper", () => {
  const dockerMcpSource = fs.readFileSync(
    path.join(REPO_ROOT, "electron-app/src/services/docker-mcp.js"),
    "utf8",
  );
  const mainSource = fs.readFileSync(
    path.join(REPO_ROOT, "electron-app/src/services/main.js"),
    "utf8",
  );

  assert.match(
    dockerMcpSource,
    /const ORBSTACK_DOCKER_STARTUP_TIMEOUT_MS = 180000;/,
  );
  assert.match(
    dockerMcpSource,
    /const DOCKER_INFO_PROBE_TIMEOUT_MS = 10000;/,
  );
  assert.match(dockerMcpSource, /async function probeDockerDaemon\(\{/);
  assert.match(dockerMcpSource, /async function waitForDockerReady\(\{/);
  assert.match(dockerMcpSource, /const probe = await probeDockerDaemon\(\{/);
  assert.match(
    dockerMcpSource,
    /async function restartOrbStackAndWaitForDocker\(\{/,
  );
  assert.match(dockerMcpSource, /const ORBSTACK_USER_APP_PATH = path\.join\(os\.homedir\(\), "Applications", "OrbStack\.app"\)/);
  assert.match(dockerMcpSource, /function resolveOrbStackAppPath\(\)/);
  assert.match(dockerMcpSource, /execFilePromise\("\/usr\/bin\/open", \["-g", "-j", appPath\]/);
  assert.doesNotMatch(dockerMcpSource, /open -gj -a OrbStack/);
  assert.match(
    dockerMcpSource,
    /OrbStack failed to start Docker within \$\{ORBSTACK_DOCKER_STARTUP_TIMEOUT_LABEL\}/,
  );
  assert.doesNotMatch(dockerMcpSource, /within 60 seconds/);
  assert.doesNotMatch(
    dockerMcpSource,
    /Please ensure OrbStack is installed\./,
  );
  assert.match(mainSource, /restartOrbStackAndWaitForDocker,/);
  assert.match(mainSource, /await restartOrbStackAndWaitForDocker\(\{/);
  assert.doesNotMatch(mainSource, /await execPromise\("orbctl stop"/);
  assert.doesNotMatch(mainSource, /You can install OrbStack from:/);
});

test("electron MCP callers resolve generator work through the Rust mcp-orc CLI", () => {
  const dockerMcpSource = fs.readFileSync(
    path.join(REPO_ROOT, "electron-app/src/services/docker-mcp.js"),
    "utf8",
  );
  const finalizeSource = fs.readFileSync(
    path.join(
      REPO_ROOT,
      "electron-app/src/renderer/screens/guided-setup/screen-finalize.js",
    ),
    "utf8",
  );
  const infraSource = fs.readFileSync(
    path.join(REPO_ROOT, "electron-app/src/services/mcp-infra-regeneration.js"),
    "utf8",
  );
  const preloadSource = fs.readFileSync(
    path.join(REPO_ROOT, "electron-app/src/services/preload.js"),
    "utf8",
  );
  const ipcSource = fs.readFileSync(
    path.join(REPO_ROOT, "electron-app/src/services/ipc.js"),
    "utf8",
  );

  assert.match(dockerMcpSource, /ensureMcpOrcGeneratorCommand\(\s*PROJECT_ROOT,\s*"generate-docker-compose-override"/);
  assert.doesNotMatch(dockerMcpSource, /generate-docker-compose-override\.sh/);
  assert.match(finalizeSource, /window\.electronAPI\.generateMcpConfig\(projectRoot\)/);
  assert.doesNotMatch(finalizeSource, /src\/scripts\/mcp-orc-cli\.sh/);
  assert.doesNotMatch(finalizeSource, /generate-mcp-config\.sh/);
  assert.match(preloadSource, /generateMcpConfig:\s*\(projectRoot\)\s*=>\s*ipcRenderer\.invoke\('generate-mcp-config',\s*projectRoot\)/);
  assert.match(ipcSource, /ipcMain\.handle\("generate-mcp-config"/);
  assert.match(ipcSource, /ensureMcpOrcGeneratorCommand\(\s*normalizedRoot,\s*"generate-mcp-config"/);
  assert.match(infraSource, /ensureMcpOrcGeneratorCommand\(\s*projectRoot,\s*"generate-docker-compose-override"/);
});

test("chat-state-api startup is decoupled from MongoDB container health checks", () => {
  const source = fs.readFileSync(
    path.join(REPO_ROOT, "docker-compose.yml"),
    "utf8",
  );
  const mongodbBlock = getYamlServiceBlock(source, "mongodb");
  const chatStateApiBlock = getYamlServiceBlock(source, "chat-state-api");

  assertContainsInOrder(
    mongodbBlock,
    ["  mongodb:", "healthcheck:", "interval: 60s"],
    "expected mongodb to keep its longer healthcheck interval",
  );
  assert.doesNotMatch(
    chatStateApiBlock,
    /depends_on:\n\s+mongodb:\n\s+condition:\s+service_healthy/,
  );
  assert.match(
    chatStateApiBlock,
    /CHAT_STATE_ALLOWED_ORIGINS=http:\/\/localhost:3789,http:\/\/127\.0\.0\.1:3789,http:\/\/localhost:8080,http:\/\/127\.0\.0\.1:8080/,
    "expected chat-state-api to allow OWUI browser origins",
  );
});

test("build script keeps the shipped rust runtime and bifrost image allowlist", () => {
  const source = fs.readFileSync(
    path.join(REPO_ROOT, "build_docker_images.sh"),
    "utf8",
  );

  assert.match(
    source,
    /MCP_RUNTIME_IMAGES="mcpo-control-plane-rust:Dockerfile\.mcpo-control-plane-rust mcp-orc-rust:Dockerfile\.mcp-orc-rust"/,
  );
  assert.match(
    source,
    /LLM_GATEWAY_IMAGES="bifrost-bridge:Dockerfile\.bifrost-bridge"/,
  );
  assert.match(
    source,
    /mcp-orc-rust\)\s+BUILD_ARGS="--build-arg ENABLE_SUPERVISOR=1 --build-arg INCLUDE_NODE=1 --build-arg INCLUDE_DOCKER_CLI=1"/,
  );
  assert.doesNotMatch(
    source,
    /mcp-orc-rust-group|mcp-orc-rust-group-core|mcpo-group:/,
  );
});

test("runHealthCheckAndBroadcast falls back to the latest health status snapshot on command failure", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );

  assertContainsInOrder(
    source,
    [
      "const fallbackData = await readAnnotatedHealthStatusFile(healthStatusFile, {",
      "        mode,",
      "        reason,",
      "        bumpSequence: true,",
      "      });",
    ],
    "expected fallback snapshot reads to preserve mode, reason, and bumpSequence",
  );
  assert.match(source, /Using latest health_status\.json snapshot after .* health check failure/);
});

test("health snapshots are toggle-revision coherent and stale results queue one light retry", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );
  const readerSection = source.slice(
    source.indexOf("async function readAnnotatedHealthStatusFile"),
    source.indexOf("function readHealthStatusSnapshotSync"),
  );
  const runnerSection = source.slice(
    source.indexOf("async function runHealthCheckAndBroadcast"),
    source.indexOf("async function runStartupCoreHealthGate"),
  );

  assert.match(readerSection, /TOGGLE_REVISION_MISMATCH/);
  assert.match(readerSection, /TOGGLE_REVISION_MISSING/);
  assert.match(readerSection, /onToggleRevisionRejected/);
  assert.match(runnerSection, /toggle-revision-retry:/);
  assert.match(runnerSection, /mode: "light"/);
});

test("health runner normalizes toggle source before invoking shell health checks", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );
  const runnerSection = source.slice(
    source.indexOf("async function runHealthCheckAndBroadcast"),
    source.indexOf("async function runStartupCoreHealthGate"),
  );

  assert.match(source, /normalizeMcpToggleSourceAtPath/);
  assert.match(source, /function ensureMcpToggleSourceReady/);
  assertContainsInOrder(runnerSection, [
    "ensureMcpToggleSourceReady(`health-check:${mode}:${reason}`)",
    "health_sync_runner_toggle_source_repaired",
    "runManagedProcess(",
  ]);
  assert.match(runnerSection, /lastHealthCheckFailureCode = isToggleSourceHealthCheckFailure/);
});

test("startup-core retries once after repairing invalid toggle source", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );
  const startupCoreSection = source.slice(
    source.indexOf("async function runStartupCoreHealthGate"),
    source.indexOf("function queueFullHealthCheck"),
  );

  assert.match(startupCoreSection, /lastHealthCheckFailureCode === "TOGGLE_SOURCE_INVALID"/);
  assert.match(startupCoreSection, /startup-core-retry:\$\{reason\}/);
  assert.match(startupCoreSection, /reason: `\$\{reason\}:toggle-source-retry`/);
  assertContainsInOrder(startupCoreSection, [
    "ensureMcpToggleSourceReady(`startup-core-retry:${reason}`)",
    "const retryData = await runHealthCheckAndBroadcast({",
    "repairedToggleSource: true",
  ]);
});

test("startup-core timeout waits for the active health run before queueing full sync", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );
  const startupCoreSection = source.slice(
    source.indexOf("async function runStartupCoreHealthGate"),
    source.indexOf("function scheduleOnDemandFullHealth"),
  );

  assert.match(startupCoreSection, /queueFullSyncAfterStartupCore/);
  assert.match(
    startupCoreSection,
    /Startup-core runner finished after timeout; queueing debounced full sync/,
  );
  assert.match(
    startupCoreSection,
    /queueFullHealthCheck\(`startup-core-timeout:\$\{reason\}`,[\s\S]*?immediate:\s*false/,
  );
  assert.doesNotMatch(
    startupCoreSection,
    /queueFullHealthCheck\(`startup-core-timeout:\$\{reason\}`,[\s\S]*?immediate:\s*true/,
  );
});

test("post-release health proof rejects fallback and stale health snapshots", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );
  const runnerSection = source.slice(
    source.indexOf("async function runHealthCheckAndBroadcast"),
    source.indexOf("async function runStartupCoreHealthGate"),
  );
  const startupCoreSection = source.slice(
    source.indexOf("async function runStartupCoreHealthGate"),
    source.indexOf("function scheduleOnDemandFullHealth"),
  );

  assert.match(source, /function verifyFreshHealthRun/);
  assert.match(source, /isFreshHealthResult\(\{/);
  assert.match(source, /expectedRunId: healthSyncRunId/);
  assert.match(source, /expectedMode: mode/);
  assert.match(source, /healthData/);
  assert.match(
    runnerSection,
    /return options\.requireFreshResult === true \? null : healthData;/,
  );
  assert.match(
    startupCoreSection,
    /requireFreshResult: options\.requireFreshResult === true/,
  );
});

test("rapid health checks back off on busy locks and ignore terminal auth/config states", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );
  const rapidSection = source.slice(
    source.indexOf("function runRapidHealthChecks"),
    source.indexOf("/**\n * Stop rapid health checks", source.indexOf("function runRapidHealthChecks")),
  );

  assert.match(source, /const RAPID_HEALTH_LOCK_BUSY_BACKOFF_MS = Math\.max\(\s*5000,/);
  assert.match(source, /const RAPID_HEALTH_TERMINAL_STATUSES = new Set/);
  assert.match(source, /"needs_oauth"/);
  assert.match(source, /"not_configured"/);
  assert.match(source, /function getRapidHealthStartingCount/);
  assert.match(rapidSection, /getRapidHealthStartingCount\(data\)/);
  assert.match(rapidSection, /RAPID_HEALTH_LOCK_BUSY_BACKOFF_MS/);
  assert.doesNotMatch(rapidSection, /retrying in 1 second/);
  assert.doesNotMatch(rapidSection, /setTimeout\(checkAndContinue,\s*1000\)/);
});

test("health sync diagnostics expose active startup/full health runs", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );
  const diagnosticsSection = source.slice(
    source.indexOf("function buildHealthSyncDiagnostics"),
    source.indexOf("function toSequenceNumber"),
  );
  const runnerSection = source.slice(
    source.indexOf("async function runHealthCheckAndBroadcast"),
    source.indexOf("async function runStartupCoreHealthGate"),
  );

  assert.match(source, /let activeFullHealthSyncStartedAt = 0;/);
  assert.match(diagnosticsSection, /active_full_sync/);
  assert.match(
    diagnosticsSection,
    /in_flight:\s*onDemandFullHealthInFlight \|\| activeFullSyncInFlight/,
  );
  assert.match(
    runnerSection,
    /if \(mode === "full" \|\| mode === "startup-core"\) \{/,
  );
  assert.match(runnerSection, /activeFullHealthSyncRunId === activeHealthSyncRunId/);
});

test("health-check runner appends durable health-sync lifecycle events", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );

  assert.match(source, /function appendHealthSyncRunnerEvent/);
  assert.match(source, /HEALTH_SYNC_RUN_ID: healthSyncRunId/);
  assert.match(source, /HEALTH_SYNC_REASON: reason/);
  assert.match(source, /HEALTH_SYNC_TIMEOUT_BUDGET_MS: String\(healthCheckExecTimeoutMs\)/);
  assertContainsInOrder(
    source,
    [
      "const enhancedEnv = createEnhancedEnv({",
      "HEALTH_SYNC_RUN_ID: healthSyncRunId",
      "HEALTH_SYNC_REASON: reason",
      "HEALTH_SYNC_TIMEOUT_BUDGET_MS: String(healthCheckExecTimeoutMs)",
      "const healthCheckRunnerEnv = {",
      'HEALTH_SYNC_TOGGLE_SNAPSHOT_READY: "1"',
      "env: healthCheckRunnerEnv",
    ],
    "expected runner metadata and the prepared snapshot marker to reach run-health-check.sh",
  );
  for (const event of [
    "health_sync_runner_start",
    "health_sync_runner_success",
    "health_sync_runner_timeout",
    "health_sync_runner_stop_failed",
    "health_sync_runner_failure",
    "health_sync_runner_fallback_snapshot",
    "health_sync_runner_queued_retry",
  ]) {
    assert.match(source, new RegExp(event));
  }
  assert.match(source, /function formatHealthSyncRunnerTextEntry/);
  assert.match(source, /function removeLegacyJsonHealthSyncLines/);
  assert.match(source, /removeLegacyJsonHealthSyncLines\(logPath\)/);
  assert.match(source, /`health-sync-\$\{date\}\.log`/);
  assert.doesNotMatch(source, /health-sync-\$\{date\}\.jsonl/);
  assert.match(source, /stdout[\s\S]*"\[redacted\]"/);
  assert.match(source, /stderr[\s\S]*"\[redacted\]"/);
});

test("MCP regeneration and health runners use hardened runtime secret env", () => {
  const dockerMcpSource = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );
  const mainSource = fs.readFileSync(
    path.join(__dirname, "main.js"),
    "utf8",
  );
  const ipcSource = fs.readFileSync(
    path.join(__dirname, "ipc.js"),
    "utf8",
  );

  assert.match(dockerMcpSource, /const \{ createRuntimeShellEnv \} = require\("\.\/runtime-shell-env"\);/);
  assertContainsInOrder(
    dockerMcpSource,
    [
      "function createEnhancedEnv(overrides = {})",
      "const runtimeEnv = createRuntimeShellEnv({",
      "PROJECT_ROOT: projectRoot",
      "applyKonamiRuntimeEnv(runtimeEnv, konamiUnlocked)",
    ],
    "docker-mcp createEnhancedEnv must resolve hardened runtime secrets before launching health/regeneration commands",
  );
  assert.match(dockerMcpSource, /const generationEnv = createEnhancedEnv\(\);/);
  assert.match(mainSource, /function createMcpRuntimeEnv\(overrides = \{\}\)/);
  assert.doesNotMatch(mainSource, /env: process\.env,\n\s*}\s*,\n\s*\);\n\s*const mcpConfigResult/);
  assert.match(ipcSource, /function createMcpRuntimeEnv\(overrides = \{\}\)/);
  assert.match(ipcSource, /const generationEnv = createMcpRuntimeEnv\(\{\s*PROJECT_ROOT: normalizedRoot,\s*}\);/);
});

test("docker-mcp mints per-server OAuth access-token broker env from generated configs", () => {
  const dockerMcpSource = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );

  assert.match(dockerMcpSource, /function discoverOAuthServerIdsFromGeneratedConfigs/);
  assert.match(dockerMcpSource, /function configSupportsNativeOAuth/);
  assert.match(dockerMcpSource, /\["mcp-configs", "mcp-configs-user"\]/);
  assert.match(dockerMcpSource, /parsed\.oauth/);
  assert.match(dockerMcpSource, /serverType === "streamable-http"/);
  assert.match(dockerMcpSource, /config\.http_subprocess/);
  assert.match(dockerMcpSource, /\.fragment/);
  assert.match(dockerMcpSource, /function ensureOAuthAccessTokenBridgeTokenEnv/);
  assert.match(dockerMcpSource, /config\.oauth/);
  assert.match(dockerMcpSource, /`oauth:access-token:\$\{serverId\}`/);
  assert.match(dockerMcpSource, /oauthAccessTokenTokenEnvVar\(serverId\)/);
  assert.match(
    dockerMcpSource,
    /portico_OAUTH_ACCESS_TOKEN_BROKER_DEFAULT_URL\s*=\s*"http:\/\/host\.docker\.internal:8891\/secrets\/oauth\/access-token"/,
  );
  assertContainsInOrder(
    dockerMcpSource,
    [
      "function createEnhancedEnv(overrides = {})",
      "ensureOAuthAccessTokenBridgeTokenEnv(",
      "ensureStaticSecretBridgeTokenEnv(",
      "ensureSchedulerBridgeStatusTokenEnv(",
    ],
    "createEnhancedEnv must prepare scoped broker/status tokens before compose commands run",
  );
});

test("scheduler bridge status token is scoped and stripped from bridge process env", () => {
  const dockerMcpSource = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );

  assert.match(dockerMcpSource, /function ensureSchedulerBridgeStatusTokenEnv/);
  assert.match(dockerMcpSource, /clientId: "scheduling-status"/);
  assert.match(dockerMcpSource, /scopes: \["bridge:status"\]/);
  assert.match(
    dockerMcpSource,
    /portico_SCHEDULER_BRIDGE_STATUS_URL[\s\S]*http:\/\/host\.docker\.internal:8891\/bridge\/status/,
  );
  assert.match(dockerMcpSource, /env\.portico_SCHEDULER_BRIDGE_STATUS_TOKEN = tokenInfo\.token/);
  assert.match(dockerMcpSource, /delete cleaned\.portico_SCHEDULER_BRIDGE_STATUS_URL/);
  assert.match(dockerMcpSource, /delete cleaned\.portico_SCHEDULER_BRIDGE_STATUS_TOKEN/);
});

test("main startup migrates physical OAuth state before Docker launch", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  assertContainsInOrder(
    mainSource,
    [
      "migrateAllLegacyOAuthRecords({",
      "projectRoot: PROJECT_ROOT",
      "const dockerReady = await ensureDockerRunning();",
    ],
    "startup must migrate plaintext OAuth records before MCP infrastructure starts",
  );
});

test("Host MCP Bridge spawn env excludes container-only OAuth broker vars", () => {
  const dockerMcpSource = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );

  assert.match(dockerMcpSource, /function sanitizeHostMcpBridgeEnv\(env\)/);
  assert.match(dockerMcpSource, /delete cleaned\.portico_OAUTH_ACCESS_TOKEN_BROKER_URL/);
  assert.match(dockerMcpSource, /delete cleaned\.portico_OAUTH_ACCESS_TOKEN_BROKER_TOKEN/);
  assert.match(dockerMcpSource, /delete cleaned\.portico_OAUTH_ACCESS_TOKEN_SERVER_ID/);
  assert.match(
    dockerMcpSource,
    /key\.startsWith\("portico_OAUTH_ACCESS_TOKEN_TOKEN_"\)/,
  );
  assertContainsInOrder(
    dockerMcpSource,
    [
      "const env = applyMainStackOAuthCallbackPortEnv(",
      "sanitizeHostMcpBridgeEnv(",
      "createEnhancedEnv({",
      "HOST_MCP_BRIDGE_ELECTRON_OAUTH_INVALIDATE_URL",
      "HOST_MCP_BRIDGE_ELECTRON_BROKER_TOKEN",
      "const bridgeProcess = spawn(\"bash\", [bridgeScript],",
      "state.hostMcpBridge.process = bridgeProcess;",
      "env,",
    ],
    "Host MCP Bridge launch must keep Electron broker auth but strip container broker env",
  );
});

test("patched OWUI auth bridge imports current session cookie config names", () => {
  const bridgeSource = fs.readFileSync(
    path.join(
      REPO_ROOT,
      "src/patches/backend/open_webui/routers/portico_auth_bridge.py",
    ),
    "utf8",
  );

  assert.match(
    bridgeSource,
    /from open_webui\.env import \([\s\S]*WEBUI_SESSION_COOKIE_SAME_SITE\s+as\s+WEBUI_AUTH_COOKIE_SAME_SITE/,
  );
  assert.match(
    bridgeSource,
    /WEBUI_SESSION_COOKIE_SAME_SITE\s+as\s+WEBUI_AUTH_COOKIE_SAME_SITE/,
  );
  assert.match(
    bridgeSource,
    /WEBUI_SESSION_COOKIE_SECURE\s+as\s+WEBUI_AUTH_COOKIE_SECURE/,
  );
  assert.match(bridgeSource, /except ImportError:[\s\S]*WEBUI_AUTH_COOKIE_SAME_SITE/);
  assert.ok(
    bridgeSource.indexOf("WEBUI_SESSION_COOKIE_SAME_SITE as WEBUI_AUTH_COOKIE_SAME_SITE") <
      bridgeSource.indexOf("except ImportError:"),
    "current OWUI cookie config names must be tried before the compatibility fallback",
  );
  assert.ok(
    bridgeSource.indexOf("from open_webui.env import WEBUI_AUTH_COOKIE_SAME_SITE") >
      bridgeSource.indexOf("except ImportError:"),
    "old OWUI cookie config names must only appear in the compatibility fallback",
  );
});

test("patched OWUI auth bridge completes handoff with frontend token bootstrap", () => {
  const bridgeSource = fs.readFileSync(
    path.join(
      REPO_ROOT,
      "src/patches/backend/open_webui/routers/portico_auth_bridge.py",
    ),
    "utf8",
  );

  const completeRoute = bridgeSource.slice(
    bridgeSource.indexOf('@router.get("/complete")'),
  );
  assert.match(bridgeSource, /def _handoff_bootstrap_response/);
  assert.match(bridgeSource, /"Cache-Control": "no-store/);
  assert.match(bridgeSource, /"Content-Security-Policy"/);
  assert.match(bridgeSource, /window\.localStorage\.setItem\("token", token\)/);
  assert.match(bridgeSource, /window\.location\.replace\(redirect \|\| "\/"\)/);
  assert.match(completeRoute, /_handoffs\.pop\(handoff_id, None\)/);
  assert.doesNotMatch(completeRoute, /RedirectResponse\(url=f"\/auth\?redirect=/);
});

test("patched OWUI auth bridge activates trusted Portico human users", () => {
  const bridgeSource = fs.readFileSync(
    path.join(
      REPO_ROOT,
      "src/patches/backend/open_webui/routers/portico_auth_bridge.py",
    ),
    "utf8",
  );

  const humanSessionRoute = bridgeSource.slice(
    bridgeSource.indexOf('@router.post("/human/session")'),
    bridgeSource.indexOf('@router.post("/service-token")'),
  );
  assert.match(bridgeSource, /def _resolve_existing_user_role/);
  assertContainsInOrder(bridgeSource, [
    'if existing_role == "admin":',
    'return "admin"',
    'if requested_role == "admin":',
    'return "admin"',
    'if requested_role == "user" and existing_role == "pending":',
    'return "user"',
  ]);
  assert.match(humanSessionRoute, /role="user"/);
  assert.doesNotMatch(humanSessionRoute, /DEFAULT_USER_ROLE/);
  // Admin activation moved out of the inline route into the legacy-admin adoption
  // helper (the admin role logic itself is pinned via _resolve_existing_user_role
  // above); the route delegates to it rather than hardcoding role="admin".
  assert.match(humanSessionRoute, /_adopt_legacy_admin_user\(/);
  assert.match(bridgeSource, /existing\.active = True/);
});

test("Docker status polling is serial, bounded, and bypasses shell grep pipelines", () => {
  const dockerSource = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );
  const ipcSource = fs.readFileSync(
    path.join(__dirname, "ipc.js"),
    "utf8",
  );

  assert.match(dockerSource, /createSerialPoller\(/);
  assert.match(dockerSource, /await probeDockerStatus\(\{/);
  assert.match(dockerSource, /timeoutMs: DOCKER_STATUS_TIMEOUT_MS/);
  assert.match(dockerSource, /cancelInFlight: cancelActiveDockerStatusProbe/);
  assert.doesNotMatch(
    dockerSource,
    /setInterval\(checkDockerStatus,\s*5000\)/,
  );
  assert.doesNotMatch(
    dockerSource,
    /docker-compose\.sh[^;\n]*status/,
  );
  // Port scans (lsof/ps) block the main thread for seconds under fd pressure
  // when run synchronously; they must stay async (execFileAsync).
  assert.doesNotMatch(dockerSource, /execFileSync\(\s*["']lsof["']/);
  assert.doesNotMatch(dockerSource, /execSync\(\s*[`"'][^`"')]*\blsof\b/);
  assert.doesNotMatch(dockerSource, /execFileSync\(\s*["']ps["']/);
  assert.match(
    dockerSource,
    /const hostMcpBridgeListenerPids = hostMcpBridgeProcessRunning\s*\?\s*\[\]\s*:\s*await listListeningPidsOnPort\(state\.hostMcpBridge\.port\);/,
  );
  assert.match(
    dockerSource,
    /runManagedProcess\(\s*"bash",\s*\[healthCheckScript,\s*"--mode",\s*mode\]/,
  );
  assert.match(
    ipcSource,
    /reason:\s*"manual-rerun"[\s\S]*waitForLock:\s*true/,
  );
  assert.doesNotMatch(
    ipcSource,
    /const healthCheckScript = path\.join\(/,
  );
});

test("restartMcpoServers waits for restarted containers through the concurrent helper", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );
  const restartMcpoServersSection = source.slice(
    source.indexOf("async function restartMcpoServers"),
    source.indexOf("async function restartAllMcpoServers"),
  );

  assert.match(restartMcpoServersSection, /await waitForContainersRunning\(/);
  assert.doesNotMatch(
    restartMcpoServersSection,
    /for \(const target of targets\) \{\s+[\s\S]*await waitForContainerRunning\(/,
  );
});

test("restartMcpoServers resolves all Docker targets from one compose service snapshot", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );
  const restartMcpoServersSection = source.slice(
    source.indexOf("async function restartMcpoServers"),
    source.indexOf("async function restartAllMcpoServers"),
  );

  assert.equal(
    (restartMcpoServersSection.match(/getConfiguredComposeServices\(/g) || []).length,
    1,
  );
  assert.match(
    restartMcpoServersSection,
    /resolveConfiguredMcpoServerContainerNameFromServices\(\s*serverId,\s*configuredComposeServices,/,
  );
  assert.doesNotMatch(
    restartMcpoServersSection,
    /await resolveConfiguredMcpoServerContainerName\(/,
  );
  assert.match(
    restartMcpoServersSection,
    /errorCode: "COMPOSE_DISCOVERY_FAILED"/,
  );
  assert.match(
    restartMcpoServersSection,
    /for \(const serverId of configuredComposeServices \? dockerServers : \[\]\)/,
  );
});

test("restartMcpoServers records attributed startup failures and completes per-server results", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );
  const restartMcpoServersSection = source.slice(
    source.indexOf("async function restartMcpoServers"),
    source.indexOf("async function restartAllMcpoServers"),
  );

  assert.match(restartMcpoServersSection, /recordBulkStartupFailure/);
  assert.match(restartMcpoServersSection, /extractAttributedServerFailure/);
  assert.match(restartMcpoServersSection, /ensureBulkResultsForRequested/);
  assert.match(restartMcpoServersSection, /attributedServerId/);
  assert.match(restartMcpoServersSection, /recordAndPublishStartupFailure\(PROJECT_ROOT/);
});

test("missing compose service caused by generated config status becomes configuration-required", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );
  const restartMcpoServerSection = source.slice(
    source.indexOf("async function restartMcpoServer"),
    source.indexOf("/**\n * Restart multiple specific MCPO servers", source.indexOf("async function restartMcpoServer")),
  );
  const restartMcpoServersSection = source.slice(
    source.indexOf("async function restartMcpoServers"),
    source.indexOf("async function restartAllMcpoServers"),
  );

  assert.match(source, /getGeneratedMcpConfigStatusForServer/);
  assert.match(source, /isRuntimeFileNotConfiguredStatus/);
  assert.match(
    restartMcpoServerSection,
    /const generatedConfigurationStatus = getGeneratedConfigurationGap\([\s\S]*?if \(generatedConfigurationStatus\) \{[\s\S]*?buildGeneratedConfigurationRequiredResult\(/,
  );
  assert.match(
    restartMcpoServersSection,
    /const generatedConfigurationStatus = getGeneratedConfigurationGap\([\s\S]*?if \(generatedConfigurationStatus\) \{[\s\S]*?buildGeneratedConfigurationRequiredResult\(/,
  );
  assert.match(source, /errorCode: status\?\.errorCode \|\| "NOT_CONFIGURED"/);
  assert.match(source, /source: status\?\.source \|\| "config"/);
  assert.match(source, /stage: status\?\.stage \|\| "config_generation"/);
  assert.match(source, /message: error/);
  assert.doesNotMatch(restartMcpoServerSection, /snowflake/i);
  assert.doesNotMatch(restartMcpoServersSection, /snowflake/i);
});

test("restartMcpoServer excludes generically attributed config failures before retrying requested server", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );
  const helperSection = source.slice(
    source.indexOf("async function regenerateMcpInfrastructureForSingleRestart"),
    source.indexOf("/**\n * Restart a specific MCPO server container", source.indexOf("async function regenerateMcpInfrastructureForSingleRestart")),
  );
  const restartMcpoServerSection = source.slice(
    source.indexOf("async function restartMcpoServer"),
    source.indexOf("/**\n * Restart multiple specific MCPO servers", source.indexOf("async function restartMcpoServer")),
  );

  assert.match(source, /extractAttributedServerFailure\(errorText,\s*projectRoot\)/);
  assert.match(helperSection, /attributedServerId === requestedServerId/);
  assert.match(helperSection, /excluded\.has\(attributedServerId\)/);
  assert.match(helperSection, /toggles\[attributedServerId\] = false;/);
  assert.match(
    helperSection,
    /serverId:\s*attributedServerId,[\s\S]*stage:\s*"config_generation",[\s\S]*source:\s*"config"/,
  );
  assert.match(
    restartMcpoServerSection,
    /regenerateMcpInfrastructureForSingleRestart\(\s*serverId,\s*execAsync,\s*PROJECT_ROOT,/,
  );
  assert.match(
    restartMcpoServerSection,
    /source:\s*isConfigGenerationFailure\s*\?\s*"config"/,
  );
  assert.doesNotMatch(helperSection, /snowflake|gitlab/i);
  assert.doesNotMatch(restartMcpoServerSection, /snowflake|gitlab/i);
});

test("docker health and restart paths ignore deleted MCP server ids", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );
  const broadcastSection = source.slice(
    source.indexOf("function broadcastHealthStatusUpdate"),
    source.indexOf("function getHealthSyncState"),
  );
  const autoHealSection = source.slice(
    source.indexOf("function scheduleAutoHealFromHealthStatus"),
    source.indexOf("function runRapidHealthChecks"),
  );
  const restartSection = source.slice(
    source.indexOf("async function restartMcpoServer"),
    source.indexOf("/**\n * Restart multiple specific MCPO servers", source.indexOf("async function restartMcpoServer")),
  );

  assert.match(source, /discoverInstalledMcpServerIds/);
  assert.match(source, /function isKnownMcpServerId\(serverId\)/);
  assert.match(broadcastSection, /knownServerIds\.size > 0 && !knownServerIds\.has\(serverId\)/);
  assert.match(autoHealSection, /knownServerIds\.size > 0 && !knownServerIds\.has\(serverId\)/);
  assert.match(restartSection, /if \(!isKnownMcpServerId\(serverId\)\) \{/);
  assert.match(restartSection, /errorCode:\s*"MCP_SERVER_NOT_FOUND"/);
});

test("health broadcasts update the preservation baseline for readiness sync", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );
  const broadcastSection = source.slice(
    source.indexOf("function broadcastHealthStatusUpdate"),
    source.indexOf("function getHealthSyncState"),
  );

  assert.match(
    broadcastSection,
    /lastHealthStatus = cloneHealthStatusSnapshot\(data\) \|\| data;/,
  );
  assert.match(
    source,
    /preserveLaggingServerStates\(healthStatus,\s*lastHealthStatus,/,
  );
});
