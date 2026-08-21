const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function buildServiceDrawerToggleHarness({
  activeTab = "chat",
  isOpen = false,
  activationSucceeds = true,
} = {}) {
  const sourcePath = path.join(
    REPO_ROOT,
    "electron-app/src/renderer/views/index.js",
  );
  const indexSource = fs.readFileSync(sourcePath, "utf8");
  const helperStart = indexSource.indexOf("function waitForNextAnimationFrame()");
  const helperEnd = indexSource.indexOf("function initServiceDrawer()", helperStart);

  assert.notEqual(helperStart, -1);
  assert.notEqual(helperEnd, -1);

  const calls = {
    activations: 0,
    openStates: [],
    warnings: [],
  };
  const serviceDrawerState = { isOpen };
  const rendererWindow = {
    appState: { activeTab },
    requestAnimationFrame(callback) {
      callback();
    },
  };
  rendererWindow.ensureControlPlaneTabActive = () => {
    calls.activations += 1;
    if (activationSucceeds) {
      rendererWindow.appState.activeTab = "control";
    }
  };

  const context = {
    window: rendererWindow,
    serviceDrawerState,
    setServiceDrawerOpen(nextOpen) {
      const normalizedOpen = Boolean(nextOpen);
      serviceDrawerState.isOpen = normalizedOpen;
      calls.openStates.push(normalizedOpen);
    },
    console: {
      warn(...args) {
        calls.warnings.push(args.join(" "));
      },
    },
  };

  vm.runInNewContext(
    `${indexSource.slice(helperStart, helperEnd)}\nthis.openServiceDrawerInControlPlane = openServiceDrawerInControlPlane;`,
    context,
    { filename: sourcePath },
  );

  return {
    calls,
    serviceDrawerState,
    window: rendererWindow,
    openServiceDrawerInControlPlane: context.openServiceDrawerInControlPlane,
  };
}

test("control plane missing-setup cards render a plain badge instead of an interactive tooltip", () => {
  const source = readRepoFile("electron-app/src/renderer/components/mcp-servers.js");

  assert.match(source, /const HOST_MODE_MISSING_SETUP_MESSAGE =/);
  assert.match(
    source,
    /badge-missing">Missing Setup<\/span>/,
  );
  assert.doesNotMatch(
    source,
    /data-tooltip="\$\{escapeHtml\(HOST_MODE_MISSING_SETUP_MESSAGE\)\}"/,
  );
  assert.doesNotMatch(source, /buildMissingSetupTooltipHtml\(/);
  assert.doesNotMatch(source, /bindMissingSetupBadgeTooltips\(list\);/);
  assert.doesNotMatch(source, /host-warning-control-panel/);
});

test("service drawer no longer renders the stop services quick action", () => {
  const html = readRepoFile("electron-app/src/renderer/views/index.html");

  assert.doesNotMatch(html, /id="stop-btn"/);
  assert.doesNotMatch(html, />\s*Stop Services\s*</);
});

test("Host MCP Bridge configure button uses a solid amber lightning badge icon", () => {
  const html = readRepoFile("electron-app/src/renderer/views/index.html");
  const styles = readRepoFile("electron-app/src/styles.css");
  const drawerToggleRule = /^\.service-drawer-toggle \{/m.exec(styles);
  const drawerToggleStyleStart = drawerToggleRule?.index ?? -1;
  const drawerToggleStyleEnd = styles.indexOf("}", drawerToggleStyleStart);
  const bridgeConfigStyleStart = styles.indexOf(".service-card-compact #host-mcp-bridge-config-btn {");
  const bridgeConfigStyleEnd = styles.indexOf("}", bridgeConfigStyleStart);
  const toggleSection = html.slice(
    html.indexOf('id="service-drawer-toggle"'),
    html.indexOf("</button>", html.indexOf('id="service-drawer-toggle"')),
  );
  const bridgeConfigSection = html.slice(
    html.indexOf('id="host-mcp-bridge-config-btn"'),
    html.indexOf("</button>", html.indexOf('id="host-mcp-bridge-config-btn"')),
  );
  const drawerToggleStyles = styles.slice(
    drawerToggleStyleStart,
    drawerToggleStyleEnd + 1,
  );
  const bridgeConfigStyles = styles.slice(
    bridgeConfigStyleStart,
    bridgeConfigStyleEnd + 1,
  );

  assert.notEqual(drawerToggleStyleStart, -1);
  assert.notEqual(drawerToggleStyleEnd, -1);
  assert.notEqual(bridgeConfigStyleStart, -1);
  assert.notEqual(bridgeConfigStyleEnd, -1);
  assert.match(toggleSection, /fill="currentColor"/);
  assert.match(toggleSection, /M20 8h-2\.81/);
  assert.match(drawerToggleStyles, /background:\s*rgba\(248,\s*113,\s*113,\s*0\.14\);/);
  assert.match(drawerToggleStyles, /color:\s*#f87171;/);
  assert.match(bridgeConfigSection, /<polygon points="13 2 4 14 12 14 11 22 20 10 12 10 13 2" fill="currentColor"><\/polygon>/);
  assert.match(bridgeConfigSection, /width="13"/);
  assert.match(bridgeConfigSection, /height="13"/);
  assert.doesNotMatch(bridgeConfigSection, /<circle\b/);
  assert.match(bridgeConfigStyles, /background:\s*rgba\(251,\s*146,\s*60,\s*0\.15\);/);
  assert.match(bridgeConfigStyles, /border:\s*1px solid rgba\(251,\s*146,\s*60,\s*0\.6\);/);
  assert.match(bridgeConfigStyles, /border-radius:\s*999px;/);
  assert.match(bridgeConfigStyles, /color:\s*#ffb020;/);
});

test("service drawer shows the signed-in user section before the build section", () => {
  const html = readRepoFile("electron-app/src/renderer/views/index.html");

  assert.match(
    html,
    /<div class="service-user-section" id="service-user-section">[\s\S]*?<h3>User<\/h3>[\s\S]*?id="service-user-email"[\s\S]*?<div class="service-drawer-build-section">[\s\S]*?<h3>Build<\/h3>/,
  );
});

test("service drawer shows Host MCP Bridge with generic PID rendering", () => {
  const html = readRepoFile("electron-app/src/renderer/views/index.html");
  const controlPlaneSource = readRepoFile(
    "electron-app/src/renderer/components/control-plane.js",
  );
  const logsPanelSource = readRepoFile(
    "electron-app/src/renderer/components/logs-panel.js",
  );
  const logViewerSource = readRepoFile(
    "electron-app/src/renderer/components/log-viewer-modal.js",
  );

  assert.match(
    html,
    /data-service="host-mcpo"[\s\S]*Host MCP Runtime[\s\S]*id="host-mcp-bridge-config-btn"[\s\S]*data-service="host-mcp-bridge"[\s\S]*Host MCP Bridge[\s\S]*data-service="portico-open-webui"/,
  );
  assert.doesNotMatch(html, /host-mcp-bridge-power-btn/);
  assert.doesNotMatch(html, /data-bridge-action/);
  assert.doesNotMatch(controlPlaneSource, /updateHostMcpBridgePowerButton/);
  assert.match(controlPlaneSource, /const servicePid = status\.containers\[`\$\{service\}-pid`\]/);
  assert.match(controlPlaneSource, /Running \(PID: \$\{servicePid\}\)/);
  assert.match(logsPanelSource, /"host-mcp-bridge": "Host MCP Bridge"/);
  assert.match(logViewerSource, /"host-mcp-bridge": "Host MCP Bridge"/);
  assert.match(logViewerSource, /hostMcpBridgeLogs\(500\)/);
});

test("service drawer treats an empty Host MCP Runtime as not needed", () => {
  const controlPlaneSource = readRepoFile(
    "electron-app/src/renderer/components/control-plane.js",
  );

  assert.match(
    controlPlaneSource,
    /service === 'host-mcpo' && \(serviceStatus === 'not_configured' \|\| !hostMcpoConfigured\)[\s\S]*dot\.classList\.remove\('running', 'error', 'warning'\);[\s\S]*text\.textContent = 'Not Needed';/,
  );
});

test("service drawer user fields refresh from the auth-backed current user API", () => {
  const indexSource = readRepoFile("electron-app/src/renderer/views/index.js");

  assert.match(indexSource, /function updateServiceDrawerCurrentUser\(currentUser = null\)/);
  assert.match(indexSource, /const sessionSummary = currentUser\?\.sessionSummary \|\| null;/);
  assert.match(indexSource, /const user = sessionSummary\?\.user \|\| \{\};/);
  assert.match(indexSource, /user\.email/);
  assert.match(indexSource, /window\.electronAPI\.currentUser\.get\(\)/);
});

test("MCP server logs preserve stderr and use the MCP-specific provider", () => {
  const ipcSource = readRepoFile("electron-app/src/services/ipc.js");
  const mcpServersSource = readRepoFile("electron-app/src/renderer/components/mcp-servers.js");
  const dockerLogsSection = ipcSource.slice(
    ipcSource.indexOf('ipcMain.handle("docker-logs"'),
    ipcSource.indexOf("function registerHostMcpoHandlers"),
  );
  const logsSection = mcpServersSource.slice(
    mcpServersSource.indexOf("async function showServerLogs"),
    mcpServersSource.indexOf("let startupFailureModalInitialized", mcpServersSource.indexOf("async function showServerLogs")),
  );

  assert.doesNotMatch(ipcSource, /stdout\s*\|\|\s*stderr\s*\|\|\s*""/);
  assert.doesNotMatch(ipcSource, /resolvedLogs\s*\|\|\s*resolvedErrorLogs\s*\|\|\s*""/);
  assert.match(ipcSource, /const mergeLogsOutput = \(stdout, stderr\) =>/);
  assert.match(ipcSource, /const logsOutput = mergeLogsOutput\(stdout, stderr\);/);
  assert.match(ipcSource, /const logsOutput = mergeLogsOutput\(resolvedLogs, resolvedErrorLogs\);/);
  const directDockerLogsIndex = dockerLogsSection.indexOf(
    "docker logs ${candidate} --tail ${lines}",
  );
  const composeLogsIndex = dockerLogsSection.indexOf("docker-compose.sh");
  assert.notEqual(directDockerLogsIndex, -1);
  assert.notEqual(composeLogsIndex, -1);
  assert.ok(directDockerLogsIndex < composeLogsIndex);
  assert.match(
    logsSection,
    /const logProvider = window\.electronAPI\?\.getSingleMcpServerLogs[\s\S]*\? \(\) => window\.electronAPI\.getSingleMcpServerLogs\(serverId, 500\)[\s\S]*: null;/,
  );
  assert.doesNotMatch(logsSection, /deploymentType === "host" && window\.electronAPI\?\.getSingleMcpServerLogs/);
});

test("runtime startup failures route View logs to the real log viewer", () => {
  const mcpServersSource = readRepoFile("electron-app/src/renderer/components/mcp-servers.js");
  const indexHtml = readRepoFile("electron-app/src/renderer/views/index.html");
  const configFailureSection = mcpServersSource.slice(
    mcpServersSource.indexOf("function isConfigStartupFailure"),
    mcpServersSource.indexOf("function markMcpServerStartupFailure"),
  );

  // Only true config-stage failures may use the fields-only startup-failure
  // modal; runtime readiness timeouts (source "runtime", no containerName)
  // must reach the docker-logs viewer.
  assert.match(configFailureSection, /source === "config"/);
  assert.match(configFailureSection, /stage === "config_generation"/);
  assert.match(configFailureSection, /stage === "preflight"/);
  assert.doesNotMatch(configFailureSection, /!failure\?\.containerName/);

  // The startup-failure modal itself offers a jump to the real log viewer.
  assert.match(mcpServersSource, /function openServerLogViewer\(serverId, deploymentType, isCore = false\)/);
  assert.match(mcpServersSource, /startupFailureModalServerId = serverId;/);
  assert.match(indexHtml, /id="startup-failure-logs-btn"/);
  assert.match(
    mcpServersSource,
    /logsBtn\.addEventListener\("click",[\s\S]*?hideStartupFailureModal\(\);[\s\S]*?openServerLogViewer\(/,
  );
});

// "add marketplace modal copy and renderer accept GitLab and sparse
// repositories" was a source pin on index.html + marketplaces.js; round 9's
// allowlist copy change tripped it and it now lives behaviorally in
// marketplaces-add-modal.unit.test.js (open/focus/submit/error flows, allowed-
// source copy, provider badges) via the marketplaces-harness vm harness.

// "marketplace details modal exposes copy-url and view-repo actions before
// sync" was a source pin on index.html + marketplaces.js + styles.css; the
// details modal became an inline page (its markup now renders from
// marketplaces.js into #marketplace-details-page) which tripped the html
// regexes. It now lives behaviorally in
// marketplaces-details-page.unit.test.js ("opening the details page takes
// over the Agent Skills subview...", "copy URL and view repo dispatch
// clipboard/openExternal...", and "the contribution notice renders only for
// the Portico AI marketplace") via the marketplaces-harness vm harness.

test("marketplace sync notifications distinguish same-version content refreshes", async () => {
  const { loadMarketplacesHarness, flushAsync } = require("./marketplaces-harness");
  const harness = loadMarketplacesHarness({
    electronAPI: {
      syncMarketplace: async () => ({
        success: true,
        skillsUpdated: [
          { skillId: "alpha", updateKind: "content" },
          { skillId: "beta" },
        ],
        skillsConflicted: [],
        skillSyncErrors: [],
      }),
    },
  });

  await harness.context.syncMarketplace("test-mp");
  await flushAsync();

  const [kind, message] = harness.notifications.at(-1) || [];
  assert.equal(kind, "success");
  assert.match(message, /Marketplace "test-mp" synced/);
  // A bumped-version skill and a same-version content refresh must be
  // reported as distinct outcomes, not folded into one "updated" count.
  assert.match(message, /1 skill\(s\) updated/);
  assert.match(message, /1 skill\(s\) refreshed from changed content/);
});

test("content-only marketplace syncs report refreshes without claiming version updates", async () => {
  const { loadMarketplacesHarness, flushAsync } = require("./marketplaces-harness");
  const harness = loadMarketplacesHarness({
    electronAPI: {
      syncMarketplace: async () => ({
        success: true,
        skillsUpdated: [{ skillId: "alpha", updateKind: "content" }],
        skillsConflicted: [],
        skillSyncErrors: [],
      }),
    },
  });

  await harness.context.syncMarketplace("test-mp");
  await flushAsync();

  const [kind, message] = harness.notifications.at(-1) || [];
  assert.equal(kind, "success");
  assert.match(message, /1 skill\(s\) refreshed from changed content/);
  assert.doesNotMatch(message, /skill\(s\) updated/);
});

// The former "marketplaces browse reloads local marketplace state ..." and
// "solutions marketplace uses the shared installedSkills state ..." tests
// lived here as SOURCE-PIN tests. Source pins are banned (AGENTS.md "Testing
// Rules"); the round-6 restructure (Git tab + inline Solutions Discover)
// moved their coverage to behavioral homes:
// - Git tab ("marketplaces-browse") still swaps to the marketplaces view and
//   calls window.loadMarketplaces without touching remote solutions:
//   skills-discover.unit.test.js ("the Git tab keeps the marketplaces
//   browse ...").
// - The marketplaces list renders git marketplaces only (synthetic Solutions
//   card removed) and solutions provenance refresh stays on the header Sync
//   All path: ai-marketplace-publish-lifecycle.unit.test.js ("marketplaces:
//   the list renders git marketplaces only ..." and "... Check Updates
//   refreshes only persisted Solutions Marketplace provenance").

test("light mode marketplace delete hover uses the darker destructive treatment", () => {
  const styles = readRepoFile("electron-app/src/styles.css");

  assert.match(
    styles,
    /\.marketplace-remove-btn:hover,\s*\.marketplace-remove-btn:focus-visible\s*\{[^}]*background:\s*var\(--btn-danger-hover\);[^}]*color:\s*var\(--status-error\);/s,
  );
  assert.match(
    styles,
    /\[data-theme="light"\]\s+\.marketplace-remove-btn:hover,\s*\[data-theme="light"\]\s+\.marketplace-remove-btn:focus-visible\s*\{[^}]*background:\s*#b91c1c;[^}]*color:\s*#fff;/s,
  );
  assert.doesNotMatch(
    styles,
    /\.marketplace-remove-btn:hover\s*\{[^}]*rgba\(248,\s*113,\s*113,\s*0\.2\)[^}]*#f87171/s,
  );
});

// "marketplace details surface dirty and conflict actions ..." was a source
// pin on marketplaces.js + preload.js + styles.css; round 9's plugin_name
// threading tripped its preload-signature regex and it now lives behaviorally
// in marketplaces-details-page.unit.test.js (dirty/conflict badges + action
// buttons render, discard/detach clicks dispatch the real IPC calls) via the
// marketplaces-harness vm harness.

test("agent skills cards show and index the originating marketplace name", () => {
  const ipcSource = readRepoFile("electron-app/src/services/ipc.js");
  const agentSkillsSource = readRepoFile(
    "electron-app/src/renderer/components/agent-skills.js",
  );
  const styles = readRepoFile("electron-app/src/styles.css");

  assert.match(ipcSource, /marketplace_name:\s*marketplaceName/);
  assert.match(ipcSource, /marketplaceName = marketplace\?\.name \|\| marketplaceId/);
  assert.match(agentSkillsSource, /skill\.marketplace_name/);
  assert.match(agentSkillsSource, /badge-marketplace-name/);
  assert.match(styles, /\.mcp-card-badge\.badge-marketplace-name\s*\{/);
});

test("agent skills cards expose platform-aware open-folder and export actions", () => {
  const ipcSource = readRepoFile("electron-app/src/services/ipc.js");
  const preloadSource = readRepoFile("electron-app/src/services/preload.js");
  const agentSkillsSource = readRepoFile(
    "electron-app/src/renderer/components/agent-skills.js",
  );

  assert.match(
    preloadSource,
    /openSkillFolder:\s*\(skillPath\)\s*=>\s*ipcRenderer\.invoke\('open-skill-folder',\s*\{\s*skillPath\s*\}\)/,
  );
  assert.match(
    preloadSource,
    /exportSkill:\s*\(skillPath\)\s*=>\s*ipcRenderer\.invoke\('export-skill',\s*\{\s*skillPath\s*\}\)/,
  );
  assert.match(
    ipcSource,
    /ipcMain\.handle\("open-skill-folder", async \(_event,\s*\{\s*skillPath\s*\}\s*=\s*\{\}\) => \{/,
  );
  assert.match(
    ipcSource,
    /ipcMain\.handle\("export-skill", async \(_event,\s*\{\s*skillPath\s*\}\s*=\s*\{\}\) => \{/,
  );
  assert.match(
    ipcSource,
    /const resolvedPath = resolveSkillPathFromInput\(skillPath,\s*allowedRoots\);/,
  );
  assert.match(
    ipcSource,
    /const skillMdPath = path\.join\(resolvedPath,\s*"SKILL\.md"\);/,
  );
  assert.match(
    ipcSource,
    /const openError = await shell\.openPath\(resolvedPath\);/,
  );
  assert.match(
    ipcSource,
    /return path\.join\(bootstrap\.PROJECT_ROOT,\s*"skills-exported"\);/,
  );
  assert.match(ipcSource, /crypto\.randomUUID\(\)\.replaceAll\("-", ""\)/);
  assert.match(ipcSource, /shell\.showItemInFolder\(archivePath\);/);
  assert.match(agentSkillsSource, /function getSkillFolderMenuLabel\(\)/);
  assert.match(
    agentSkillsSource,
    /window\.electronAPI\.platform === "darwin"\s*\?\s*"Open in Finder"\s*:\s*"Open Folder"/s,
  );
  assert.match(
    agentSkillsSource,
    /const openFolderOption = skill\.skill_path && skill\.source !== "marketplace"/,
  );
  assert.match(
    agentSkillsSource,
    /const exportSkillOption = skill\.skill_path\s*\?/,
  );
  assert.match(agentSkillsSource, /skill-open-folder-menu-btn/);
  assert.match(agentSkillsSource, /skill-export-menu-btn/);
  assert.match(
    agentSkillsSource,
    /<button class="mcp-dropdown-item skill-details-menu-btn"[\s\S]*?\$\{openFolderOption\}[\s\S]*?\$\{exportSkillOption\}[\s\S]*?\$\{deleteOption\}/s,
  );
  assert.match(
    agentSkillsSource,
    /window\.electronAPI\.openSkillFolder\(skill\.skill_path\)/,
  );
  assert.match(
    agentSkillsSource,
    /window\.electronAPI\.exportSkill\(skill\.skill_path\)/,
  );
  assert.match(agentSkillsSource, /Failed to open skill folder:/);
  assert.match(agentSkillsSource, /Failed to export skill:/);
});

test("skill cards use the same bottom-aligned action row treatment as agent cards", () => {
  const styles = readRepoFile("electron-app/src/styles.css");

  assert.match(
    styles,
    /\.skill-card-actions\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;[^}]*border-top:\s*1px solid rgba\(127,\s*127,\s*127,\s*0\.18\);/s,
  );
  assert.match(
    styles,
    /\.skill-card-actions\s+\.btn-secondary,\s*\.skill-card-actions\s+\.btn-danger\s*\{[^}]*font-size:\s*0\.75rem;[^}]*white-space:\s*normal;/s,
  );
  assert.match(
    styles,
    /\.skill-card\s+\.mcp-card-body\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s,
  );
});

test("marketplace publish actions show inline busy feedback in the renderer", () => {
  const agentsSource = readRepoFile("electron-app/src/renderer/components/agents.js");
  const agentSkillsSource = readRepoFile(
    "electron-app/src/renderer/components/agent-skills.js",
  );
  const mcpServersSource = readRepoFile(
    "electron-app/src/renderer/components/mcp-servers.js",
  );

  assert.match(agentsSource, /submitBusyLabel:\s*"Creating\.\.\."/);
  assert.match(agentsSource, /submitBusyLabel:\s*"Saving\.\.\."/);
  assert.match(
    agentsSource,
    /const busyLabel = isLinked \? "Republishing\.\.\." : "Publishing\.\.\.";/,
  );
  assert.match(agentsSource, /submitBusyLabel:\s*busyLabel/);
  assert.match(agentsSource, /setBusyButtonState\(triggerBtn,\s*"Installing\.\.\."\)/);
  // Destructive flows spin the confirm modal's button instead of the (closed)
  // dropdown trigger.
  assert.match(agentsSource, /confirmBusyLabel:\s*"Removing\.\.\."/);
  assert.match(agentsSource, /confirmBusyLabel:\s*"Deleting\.\.\."/);
  assert.match(agentSkillsSource, /function setSkillMenuActionBusy\(button,\s*label\)/);
  // Round 11: the busy spinner targets the (possibly detached) dropdown item
  // with a fallback to the page-level publish button after the confirm modal.
  assert.match(agentSkillsSource, /setSkillMenuActionBusy\(busyTarget,\s*"Publishing\.\.\."\)/);
  assert.match(agentSkillsSource, /triggerBtn && triggerBtn\.isConnected/);
  assert.match(agentSkillsSource, /closeAllSkillDropdowns\(\);/);
  assert.match(mcpServersSource, /closeAllDropdowns\(\);/);
});

test("mcp server cards expose platform-aware open-folder and export actions", () => {
  const ipcSource = readRepoFile("electron-app/src/services/ipc.js");
  const preloadSource = readRepoFile("electron-app/src/services/preload.js");
  const mcpServersSource = readRepoFile(
    "electron-app/src/renderer/components/mcp-servers.js",
  );

  assert.match(
    preloadSource,
    /openMcpServerFolder:\s*\(serverPath\)\s*=>\s*ipcRenderer\.invoke\('open-mcp-server-folder',\s*\{\s*serverPath\s*\}\)/,
  );
  assert.match(
    preloadSource,
    /exportMcpServer:\s*\(serverPath\)\s*=>\s*ipcRenderer\.invoke\('export-mcp-server',\s*\{\s*serverPath\s*\}\)/,
  );
  assert.match(
    ipcSource,
    /ipcMain\.handle\(\s*"open-mcp-server-folder",\s*async \(_event,\s*\{\s*serverPath\s*\}\s*=\s*\{\}\) => \{/,
  );
  assert.match(
    ipcSource,
    /ipcMain\.handle\("export-mcp-server", async \(_event,\s*\{\s*serverPath\s*\}\s*=\s*\{\}\) => \{/,
  );
  assert.match(
    ipcSource,
    /server_path:\s*serverPath/,
  );
  assert.match(ipcSource, /"mcp-configs"/);
  assert.match(ipcSource, /"mcp-configs-user"/);
  assert.match(
    ipcSource,
    /const serverDir = path\.basename\(resolvedPath\);/,
  );
  assert.match(
    ipcSource,
    /const yamlPath = path\.join\(resolvedPath,\s*`\$\{serverDir\}\.yaml`\);/,
  );
  assert.match(
    ipcSource,
    /return path\.join\(bootstrap\.PROJECT_ROOT,\s*"mcp-servers-exported"\);/,
  );
  assert.match(
    ipcSource,
    /const openError = await shell\.openPath\(resolvedPath\);/,
  );
  assert.match(ipcSource, /shell\.showItemInFolder\(archivePath\);/);
  assert.match(mcpServersSource, /function getMcpServerFolderMenuLabel\(\)/);
  assert.match(
    mcpServersSource,
    /window\.electronAPI\.platform === "darwin"\s*\?\s*"Open in Finder"\s*:\s*"Open Folder"/s,
  );
  assert.match(mcpServersSource, /mcp-open-folder-btn/);
  assert.match(mcpServersSource, /mcp-export-btn/);
  assert.match(
    mcpServersSource,
    /if \(isEnabled\) \{[\s\S]*mcp-tools-btn[\s\S]*\}\s*dropdownItems\.push\(`[\s\S]*mcp-open-folder-btn[\s\S]*`\);\s*dropdownItems\.push\(`[\s\S]*Export Integration[\s\S]*`\);[\s\S]*\/\/ Add Delete item/s,
  );
  assert.match(
    mcpServersSource,
    /window\.electronAPI\.openMcpServerFolder\(serverPath\)/,
  );
  assert.match(
    mcpServersSource,
    /window\.electronAPI\.exportMcpServer\(serverPath\)/,
  );
  assert.doesNotMatch(mcpServersSource, /mcp-publish-ai-marketplace-btn/);
  assert.doesNotMatch(mcpServersSource, /publishMcpServerToAiMarketplace/);
  assert.match(mcpServersSource, /Failed to open integration folder:/);
  assert.match(mcpServersSource, /Failed to export integration:/);
});

test("control-plane card menus share the compact chat-menu visual system", () => {
  const styles = readRepoFile("electron-app/src/styles.css");
  const mcpServersSource = readRepoFile(
    "electron-app/src/renderer/components/mcp-servers.js",
  );

  assert.match(styles, /--portico-menu-surface:/);
  assert.match(styles, /--portico-menu-hover:\s*rgba\(15, 23, 42, 0\.07\)/);
  assert.match(styles, /\.mcp-card-dropdown\s*\{[\s\S]*?min-width:\s*13rem;[\s\S]*?border-radius:\s*0\.9rem;[\s\S]*?box-shadow:\s*var\(--portico-menu-shadow\)/);
  assert.match(styles, /\.mcp-dropdown-item\s*\{[\s\S]*?min-height:\s*2\.35rem;[\s\S]*?border-radius:\s*0\.65rem/);
  assert.match(styles, /\.mcp-dropdown-item:hover,[\s\S]*?background:\s*var\(--portico-menu-hover\)/);
  assert.match(styles, /\.mcp-card-dropdown \.mcp-logs-btn,[\s\S]*?color:\s*var\(--text-primary\)/);
  assert.doesNotMatch(styles, /\[data-theme="light"\] \.mcp-card-dropdown\s*\{\s*box-shadow:\s*none;/);
  assert.match(mcpServersSource, /mcp-dropdown-divider[^`]*mcp-open-folder-btn/);
  assert.match(mcpServersSource, /const dropdownWidth = dropdown\.offsetWidth;/);
  assert.match(mcpServersSource, /let left = btnRect\.left;/);
  assert.doesNotMatch(mcpServersSource, /let left = btnRect\.right - dropdownWidth;/);
  assert.match(styles, /\.mcp-card-dropdown\s*\{[\s\S]*?transform-origin:\s*top left;/);
  assert.match(styles, /\.mcp-card-dropdown\.open-upward\s*\{[\s\S]*?transform-origin:\s*bottom left;/);
});

test("mcp server cards do not expose AI Marketplace publish actions", () => {
  const mcpServersSource = readRepoFile(
    "electron-app/src/renderer/components/mcp-servers.js",
  );

  assert.doesNotMatch(mcpServersSource, /Publish to AI Marketplace/);
  assert.doesNotMatch(mcpServersSource, /mcp-publish-ai-marketplace-btn/);
  assert.doesNotMatch(mcpServersSource, /publishMcpServerToAiMarketplace/);
});

test("agents discover installs route skills and MCP servers into immediately usable control-plane views", () => {
  const agentsSource = readRepoFile("electron-app/src/renderer/components/agents.js");
  const indexHtmlSource = readRepoFile("electron-app/src/renderer/views/index.html");

  assert.match(
    agentsSource,
    /typeof require === "function"[\s\S]*require\("\.\.\/\.\.\/services\/agent-name-validation"\)/,
  );
  assert.match(agentsSource, /selfButton\?\.addEventListener\("click", showAgentsView\)/);
  assert.match(agentsSource, /window\.AgentsTabModule = agentsTabController;/);
  assert.match(agentsSource, /function invalidateCatalogs\(\)/);
  assert.match(agentsSource, /async function refreshInstalledSkillViews\(/);
  assert.match(agentsSource, /async function refreshInstalledMcpServers\(\)/);
  assert.match(agentsSource, /function openMcpServersTab\(\)/);
  assert.match(indexHtmlSource, /id="view-agents-tab-btn"/);
  assert.match(indexHtmlSource, /id="agents-tab-view"/);
  // The TYPE_AGENTS install-branch flow (upsert + link refresh + landing on
  // the Installed tab) is pinned BEHAVIORALLY in
  // agents-tab-overhaul-v2.unit.test.js ("a successful agent install from
  // Discover lands on the Installed tab") — the old source regex here was a
  // banned source-pin and was retired when the landing changed to Installed.
  assert.doesNotMatch(
    agentsSource,
    /if \(data\.type === TYPE_AGENTS\) \{[\s\S]{0,1400}?aiMarketplace\?\.setLink\(resolvedAgentId, solutionId\)/,
  );
  assert.match(
    agentsSource,
    /else if \(data\.type === TYPE_MCP_SERVERS\) \{[\s\S]*refreshInstalledMcpServers\(\)[\s\S]*openMcpServersTab\(\)/,
  );
  assert.match(agentsSource, /function enableRequiredMcpServersForAgentInstall\(data\)/);
  assert.match(
    agentsSource,
    /toggleMcpServer\([\s\S]*runtimeServerId,[\s\S]*true,[\s\S]*deploymentType,[\s\S]*\{\s*backgroundLifecycle:\s*true\s*\}/,
  );
  assert.match(
    agentsSource,
    /Configuration required for \$\{mcpEnableSummary\.needsConfiguration\.join\(", "\)\} before the agent can use it\./,
  );
  assert.doesNotMatch(indexHtmlSource, /id="view-marketplaces-btn"/);
  assert.match(indexHtmlSource, /data-filter="marketplace">\s*Installed/s);
  assert.doesNotMatch(agentsSource, /DISCOVER_TYPES = new Set\(\[[^\]]*TYPE_MCP_SERVERS/);
});

test("agent cards show MCP server icons without changing ID-backed agent payloads", () => {
  const agentsSource = readRepoFile("electron-app/src/renderer/components/agents.js");
  const styles = readRepoFile("electron-app/src/styles.css");

  assert.match(
    agentsSource,
    /async function loadMyAgents\(\)[\s\S]*Promise\.all\(\[[\s\S]*callSubagent\(TOOL_LIST,\s*\{\}\),\s*loadCatalogs\(\)[\s\S]*state\.myAgents = agentsRaw\.map\(normalizeAgentRecord\)\.filter\(Boolean\);/s,
  );
  assert.match(
    agentsSource,
    /state\.myAgents = state\.myAgents\.filter\(\s*\(agent\) => !String\(agent\.id \|\| ""\)\.startsWith\(SYSTEM_AGENT_PREFIX\),\s*\);/s,
  );
  assert.match(agentsSource, /function renderAgentToolServerIcon\(id\)/);
  assert.match(
    agentsSource,
    /catalogOptionFor\(normalizedId,\s*state\.catalogs\.toolServers \|\| \[\]\)/,
  );
  assert.match(agentsSource, /class="agent-tool-icon-chip"/);
  assert.match(agentsSource, /data-tool-server-id="\$\{escapeHtml\(normalizedId\)\}"/);
  assert.match(
    agentsSource,
    /tool_server_ids:\s*readPickerSelection\([\s\S]*?\)\.map\(normalizeToolServerId\),/s,
  );
  assert.match(agentsSource, /tool_server_ids:\s*args\.tool_server_ids,/);
  assert.match(
    styles,
    /#agents-tab-view\s*\{[^}]*min-height:\s*0;/s,
  );
  assert.match(
    styles,
    /#agents-tab-list\s*\{[^}]*min-height:\s*0;/s,
  );
  const agentsListGrid = styles.match(/#agents-tab-list\s*\{([^}]*)\}/s)?.[1] || "";
  assert.match(
    agentsListGrid,
    /--agent-card-track:\s*clamp\(17rem,\s*22vw,\s*20rem\);/,
  );
  assert.match(
    agentsListGrid,
    /grid-template-columns:\s*repeat\(auto-fill,\s*var\(--agent-card-track\)\);/,
  );
  assert.match(agentsListGrid, /justify-content:\s*start;/);
  assert.match(agentsListGrid, /align-content:\s*start;/);
  assert.doesNotMatch(agentsListGrid, /\b1fr\b/);
  assert.match(
    styles,
    /\.agent-tool-icon-list\s*\{[^}]*max-height:[^;]+;[^}]*overflow-y:\s*auto;/s,
  );
  assert.match(
    styles,
    /\.agent-tool-icon-chip\s*\{[^}]*width:\s*1\.75rem;[^}]*height:\s*1\.75rem;/s,
  );
  // Logos render contained (not cropped) and light mode gets the same dark
  // backdrop the Integrations .mcp-card-icon uses, so transparent/white
  // logos stay visible in both themes.
  assert.match(
    styles,
    /\.agent-tool-icon-chip img\s*\{[^}]*object-fit:\s*contain;[^}]*padding:\s*0\.15rem;/s,
  );
  assert.match(
    styles,
    /\[data-theme="light"\] \.agent-tool-icon-chip\s*\{[^}]*background:\s*#374151;/s,
  );
  assert.match(
    styles,
    /\[data-theme="light"\] \.agent-tool-icon-fallback\s*\{[^}]*color:\s*#e5e7eb;/s,
  );
  // The Agents tab search bar must keep the SHARED mcp-search styling — the
  // round-9 removal of the scoped "prompts language" override may not return.
  assert.doesNotMatch(styles, /#agents-tab-view\s+\.mcp-search-wrapper/);
  assert.doesNotMatch(styles, /#agents-tab-view\s+\.mcp-search-input/);
});

test("agent skills refresh every time the subview is entered, including control-plane restore", () => {
  const agentSkillsSource = readRepoFile(
    "electron-app/src/renderer/components/agent-skills.js",
  );
  const agentsSource = readRepoFile(
    "electron-app/src/renderer/components/agents.js",
  );
  const marketplacesSource = readRepoFile(
    "electron-app/src/renderer/components/marketplaces.js",
  );
  const indexHtmlSource = readRepoFile("electron-app/src/renderer/views/index.html");
  const chatTabSource = readRepoFile(
    "electron-app/src/renderer/components/chat-tab.js",
  );

  assert.match(
    agentSkillsSource,
    /function showAgentSkillsView\(\{\s*refresh = true\s*\} = \{\}\)/,
  );
  assert.match(
    agentSkillsSource,
    /agentSkillsBtn\.addEventListener\("click", \(\) => \{\s*showAgentSkillsView\(\);\s*\}\);/s,
  );
  assert.match(
    agentSkillsSource,
    /if \(skillsLoading\) \{\s*skillsRefreshQueued = true;\s*return;\s*\}/s,
  );
  assert.match(
    agentSkillsSource,
    /do \{[\s\S]*renderSkillsList\(\);[\s\S]*\} while \(skillsRefreshQueued\);/s,
  );
  assert.match(
    agentSkillsSource,
    /window\.showAgentSkillsView = showAgentSkillsView;/,
  );
  assert.match(
    agentSkillsSource,
    /window\.switchAgentSkillsToInstalledTab = switchAgentSkillsToInstalledTab;/,
  );
  assert.match(
    indexHtmlSource,
    /data-filter="marketplaces-browse"/,
  );
  assert.doesNotMatch(
    marketplacesSource,
    /agentSkillsBtn\.addEventListener\("click", \(\) => \{/,
  );
  assert.match(
    chatTabSource,
    /currentState\?\.controlPlaneView === 'agent-skills'[\s\S]*window\.showAgentSkillsView[\s\S]*window\.showAgentSkillsView\(\{ refresh: true \}\);/s,
  );
  assert.match(agentsSource, /window\.AgentsTabModule = agentsTabController;/);
  assert.match(
    chatTabSource,
    /currentState\?\.controlPlaneView === 'agents-tab'[\s\S]*window\.AgentsTabModule\?\.show[\s\S]*window\.AgentsTabModule\.show\(\);/s,
  );
});

test("host-mode warning copy is updated consistently across control plane surfaces", () => {
  const controlPlaneSource = readRepoFile(
    "electron-app/src/renderer/components/mcp-servers.js",
  );
  const setupCardSource = readRepoFile(
    "electron-app/src/renderer/components/setup-server-card.js",
  );
  const expectedCopy =
    /The necessary dependencies needed to run Host-mode integrations are not installed\. These servers will be unavailable\. For help, please ask in/;

  assert.match(controlPlaneSource, expectedCopy);
  assert.match(setupCardSource, expectedCopy);
  assert.doesNotMatch(controlPlaneSource, /Host MCP Server Setup Required:/);
  assert.doesNotMatch(setupCardSource, /Host MCP Server Setup Required:/);
});

test("log viewer preserves terminal-style host MCP logs", () => {
  const source = readRepoFile("electron-app/src/renderer/components/log-viewer-modal.js");
  const mcpServersSource = readRepoFile("electron-app/src/renderer/components/mcp-servers.js");
  const guidedSetupCss = readRepoFile("electron-app/src/renderer/views/guided-setup.css");
  const mainCss = readRepoFile("electron-app/src/styles.css");

  assert.match(source, /function normalizeLogText\(logs\)/);
  assert.match(source, /\.replace\(\/\\r\\n\/g, "\\n"\)/);
  assert.match(source, /\.replace\(\/\\r\/g, "\\n"\)/);
  assert.match(source, /fetchPromise: null/);
  assert.match(
    source,
    /if \(logViewerState\.fetchPromise\) \{\s*return logViewerState\.fetchPromise;\s*\}/,
  );
  assert.match(source, /const fetchPromise = fetchAndDisplayLogsUntracked\(\);/);
  assert.match(
    source,
    /finally \{[\s\S]*logViewerState\.fetchPromise === fetchPromise[\s\S]*logViewerState\.fetchPromise = null;/,
  );
  assert.match(mcpServersSource, /deploymentType === "host"[\s\S]*getSingleMcpServerLogs\(serverId, 500\)/);
  assert.match(guidedSetupCss, /\.log-viewer-content\s*\{[\s\S]*overflow-x: auto;/);
  assert.match(guidedSetupCss, /\.log-line\s*\{[\s\S]*white-space: pre;/);

  for (const css of [guidedSetupCss, mainCss]) {
    assert.match(css, /\.log-viewer-body\s*\{[\s\S]*gap:\s*0\.75rem;/);
    assert.match(css, /\.log-viewer-toolbar\.mcp-search-filter-bar\s*\{[\s\S]*margin:\s*0;/);
    assert.match(css, /\.log-viewer-content\s*\{[\s\S]*margin-top:\s*0;/);
  }
});

test("missing-setup system cards hide the ellipsis when no menu actions exist", () => {
  const source = readRepoFile("electron-app/src/renderer/components/mcp-servers.js");

  assert.match(source, /const canToggleFromMenu = !server\.isCore && !isHostDisabled;/);
  assert.match(source, /const hasMenuActions = dropdownItems\.length > 0 \|\| canToggleFromMenu;/);
  assert.match(source, /\$\{\s*hasMenuActions\s*\?/);
});

test("control plane OAuth cards render a gated Re-auth menu action and confirmation modal", () => {
  const source = readRepoFile("electron-app/src/renderer/components/mcp-servers.js");
  const html = readRepoFile("electron-app/src/renderer/views/index.html");

  assert.match(
    source,
    /const showAuthenticateButton = isEnabled && showNeedsAuth;/,
  );
  assert.match(
    source,
    /const showReauthMenuItem =\s*serverRequiresOAuth\(server\) && !showAuthenticateButton;/,
  );
  assert.match(
    source,
    /if \(showReauthMenuItem\) \{\s*dropdownItems\.push\(`[\s\S]*mcp-reauth-btn/s,
  );
  assert.match(source, /if \(showAuthenticateButton\) \{\s*setupButton = `/);
  assert.match(source, /showReauthConfirmationModal\(serverId,\s*serverName\)/);
  assert.match(html, /id="reauth-confirm-modal"/);
  assert.match(html, /id="reauth-modal-confirm-btn">[\s\S]*Re-auth[\s\S]*<\/button>/);
  assert.match(html, /<rect x="5" y="11" width="14" height="10" rx="2" ry="2"><\/rect>/);
});

test("header service drawer activates control plane while quick actions preserve their routing", () => {
  const indexSource = readRepoFile("electron-app/src/renderer/views/index.js");
  const helperStart = indexSource.indexOf("async function openServiceDrawerInControlPlane()");
  const helperEnd = indexSource.indexOf("function initServiceDrawer()", helperStart);
  const helperSource = indexSource.slice(helperStart, helperEnd);
  const initEnd = indexSource.indexOf("function ensureDebugRequestModal()", helperEnd);
  const initSource = indexSource.slice(helperEnd, initEnd);

  assert.match(indexSource, /function ensureControlPlaneTabActive\(\)/);
  assert.match(indexSource, /window\.ensureControlPlaneTabActive = ensureControlPlaneTabActive;/);
  assert.notEqual(helperStart, -1);
  assert.notEqual(helperEnd, -1);
  assert.match(helperSource, /if \(window\.appState\?\.activeTab !== 'control'\)/);
  assert.match(helperSource, /window\.ensureControlPlaneTabActive\?\.\(\);\s*await waitForNextAnimationFrame\(\);/s);
  assert.match(helperSource, /if \(window\.appState\?\.activeTab !== 'control'\) \{[\s\S]*return;\s*\}/s);
  assert.match(helperSource, /setServiceDrawerOpen\(true\);\s*return;/s);
  assert.match(helperSource, /setServiceDrawerOpen\(!serviceDrawerState\.isOpen\);/);
  assert.doesNotMatch(indexSource, /toggleServiceDrawerInCurrentTab/);
  assert.match(initSource, /toggle\.addEventListener\('click', \(e\) => \{[\s\S]*void openServiceDrawerInControlPlane\(\);/s);
  assert.match(indexSource, /async function runServiceDrawerActionInControlPlane\(action, options = \{\}\)/);
  assert.match(indexSource, /const activateControlPlane = options\.activateControlPlane !== false;/);
  assert.match(indexSource, /activateControlPlane && window\.appState\?\.activeTab !== 'control'/);
  assert.match(indexSource, /window\.ensureControlPlaneTabActive\?\.\(\)/);
  assert.match(indexSource, /runServiceDrawerActionInControlPlane\(startServices\)/);
  assert.match(indexSource, /runServiceDrawerActionInControlPlane\(restartServices\)/);
  assert.match(indexSource, /runServiceDrawerActionInControlPlane\(window\.collectDebugInfo, \{\s*activateControlPlane: false,\s*\}\)/s);
  assert.match(indexSource, /runServiceDrawerActionInControlPlane\(window\.launchGuidedSetup\)/);
});

test("header service drawer opens on control plane from chat and conversation tabs", async () => {
  for (const activeTab of ["chat", "conversation-test-chat"]) {
    for (const isOpen of [false, true]) {
      const harness = buildServiceDrawerToggleHarness({ activeTab, isOpen });

      await harness.openServiceDrawerInControlPlane();

      assert.equal(harness.window.appState.activeTab, "control");
      assert.equal(harness.calls.activations, 1);
      assert.deepEqual(harness.calls.openStates, [true]);
      assert.equal(harness.serviceDrawerState.isOpen, true);
      assert.equal(harness.calls.warnings.length, 0);
    }
  }
});

test("header service drawer stays closed when control plane activation fails", async () => {
  const harness = buildServiceDrawerToggleHarness({
    activeTab: "chat",
    isOpen: false,
    activationSucceeds: false,
  });

  await harness.openServiceDrawerInControlPlane();

  assert.equal(harness.window.appState.activeTab, "chat");
  assert.equal(harness.calls.activations, 1);
  assert.deepEqual(harness.calls.openStates, []);
  assert.equal(harness.serviceDrawerState.isOpen, false);
  assert.equal(harness.calls.warnings.length, 1);
});

test("header service drawer toggles closed when already open on control plane", async () => {
  const harness = buildServiceDrawerToggleHarness({
    activeTab: "control",
    isOpen: true,
  });

  await harness.openServiceDrawerInControlPlane();

  assert.equal(harness.window.appState.activeTab, "control");
  assert.equal(harness.calls.activations, 0);
  assert.deepEqual(harness.calls.openStates, [false]);
  assert.equal(harness.serviceDrawerState.isOpen, false);
  assert.equal(harness.calls.warnings.length, 0);
});

test("renderer reloads MCP toggles when backend health sync discovers new servers", () => {
  const indexSource = readRepoFile("electron-app/src/renderer/views/index.js");

  assert.match(indexSource, /const serversChanged = healthServerNames\.length !== currentServerNames\.length/);
  assert.match(indexSource, /if \(serversChanged\) \{[\s\S]*await loadMcpToggles\(\);[\s\S]*await checkHostModeSupport\(\);/);
});

test("recent successful startup keeps configured cards out of the unconfigured lane", () => {
  const source = readRepoFile("electron-app/src/renderer/components/mcp-servers.js");
  const progressSource = readRepoFile(
    "electron-app/src/renderer/components/mcp-operation-progress.js",
  );
  const block = source.slice(
    source.indexOf("function isServerConfiguredForUi(server, state) {"),
    source.indexOf("function isServerToggleable(server, state) {"),
  );

  assert.match(block, /progressApi\?\.resolveEffectiveConfigured/);
  assert.match(
    progressSource,
    /backendStatusImpliesConfigured[\s\S]*backendConfigured === false[\s\S]*return false/s,
    "running backend states should be treated as configured before stale configured=false snapshots",
  );
  assert.doesNotMatch(
    block,
    /if \(healthInfo\?\.status === "not_configured"\) return false;/,
    "configured card grouping should no longer let a stale not_configured snapshot override recent successful startup state",
  );
});

test("post-config readiness polling keeps transient not_configured in the starting path", () => {
  const source = readRepoFile("electron-app/src/renderer/components/mcp-servers.js");
  const stageBlock = source.slice(
    source.indexOf("function getPostOperationReadinessStage(progressApi, readiness = {}) {"),
    source.indexOf("function shouldContinueWaitingForPostOperationReadiness(", source.indexOf("function getPostOperationReadinessStage(progressApi, readiness = {}) {")),
  );
  const waitBlock = source.slice(
    source.indexOf("function shouldContinueWaitingForPostOperationReadiness("),
    source.indexOf("/**", source.indexOf("function shouldContinueWaitingForPostOperationReadiness(")),
  );

  assert.doesNotMatch(
    stageBlock,
    /stage === "waiting"[\s\S]*?not_configured[\s\S]*?return "failed"/s,
    "post-operation readiness should not coerce transient not_configured into a hard failure stage",
  );
  assert.match(
    waitBlock,
    /allowNotConfiguredOverride:\s*Boolean\(server\?\.isConfigured\)/,
    "post-operation readiness waiting should reuse the recent-success not_configured override gate",
  );
});

test("config-required enable results resolve authentication before configuration", () => {
  const source = readRepoFile("electron-app/src/renderer/components/mcp-servers.js");
  const progressSource = readRepoFile(
    "electron-app/src/renderer/components/mcp-operation-progress.js",
  );

  assert.match(
    source,
    /function markMcpServerEnabledNeedsConfiguration\(serverId,\s*options = \{\}\) \{[\s\S]*server\.isConfigured = false;[\s\S]*applyLocalToggleState\(serverId,\s*true,\s*\{[\s\S]*configured:\s*false,[\s\S]*status:\s*"not_configured"/s,
  );
  assert.match(
    source,
    /if \(result\.requiresConfiguration\) \{[\s\S]*resolveSetupActionAfterConfigurationRequired\(server\)[\s\S]*setupAction === "authenticate"[\s\S]*markMcpServerEnabledNeedsAuthentication\(serverId,[\s\S]*markMcpServerEnabledNeedsConfiguration\(serverId,/s,
  );
  assert.match(
    source,
    /if \(enabled && entry\?\.requiresConfiguration\) \{[\s\S]*resolveSetupActionAfterConfigurationRequired\(server\)[\s\S]*requiresAuthenticationCount \+= 1;[\s\S]*markMcpServerEnabledNeedsAuthentication\(server\.id,[\s\S]*requiresConfigurationCount \+= 1;[\s\S]*markMcpServerEnabledNeedsConfiguration\(server\.id,/s,
  );
  assert.match(
    progressSource,
    /not_configured:\s*\{[\s\S]*label:\s*"Needs configuration"[\s\S]*terminal:\s*true[\s\S]*healthStatus:\s*"not_configured"/s,
  );
});

test("dual-requirement cards expose Authenticate first and Configure only after token persistence", () => {
  const source = readRepoFile("electron-app/src/renderer/components/mcp-servers.js");
  const helperSource = readRepoFile(
    "electron-app/src/services/guided-setup/server-requirements.js",
  );
  const renderBlock = source.slice(
    source.indexOf(
      "function renderServerCard(server, state, setupActionOverride) {",
    ),
    source.indexOf("// Render unconfigured server card"),
  );
  const unconfiguredBlock = source.slice(
    source.indexOf("function renderUnconfiguredCard("),
    source.indexOf("// Save MCP toggle state"),
  );

  assert.match(
    helperSource,
    /if \(requiresOAuth && !hasOAuthTokens\) \{\s*return "authenticate";\s*\}[\s\S]*if \(requiresConfig && !isConfigured\) \{\s*return "configure";/s,
  );
  assert.match(
    renderBlock,
    /const setupAction =\s*setupActionOverride === undefined[\s\S]*resolveVisibleServerSetupAction\(server,[\s\S]*const showNeedsAuth = setupAction === "authenticate";[\s\S]*const needsConfiguration = setupAction === "configure";[\s\S]*const showAuthenticateButton = isEnabled && showNeedsAuth;[\s\S]*const showConfigureButton = isEnabled && needsConfiguration;/s,
  );
  assert.match(
    renderBlock,
    /if \(hasConfigOptions && setupAction !== "authenticate"\)/,
  );
  assert.match(
    renderBlock,
    /if \(showAuthenticateButton\) \{[\s\S]*Authenticate[\s\S]*\} else if \(showConfigureButton\) \{[\s\S]*Configure/s,
  );
  assert.match(
    unconfiguredBlock,
    /const needsAuthentication = setupAction === "authenticate";[\s\S]*const needsConfiguration = setupAction === "configure";[\s\S]*needsAuthentication[\s\S]*Authenticate[\s\S]*needsConfiguration[\s\S]*Configure/s,
  );
  assert.match(
    source,
    /function markMcpServerOAuthAuthenticated\(serverId, options = \{\}\) \{[\s\S]*server\.hasOAuthTokens = true;[\s\S]*status: "not_configured"/s,
  );
});

test("control plane cards use one visible setup action for filtering, sorting, and rendering", () => {
  const source = readRepoFile("electron-app/src/renderer/components/mcp-servers.js");
  const styles = readRepoFile("electron-app/src/styles.css");

  assert.match(
    source,
    /function buildMcpServerGridEntry\(server, state = window\.appState\) \{[\s\S]*const setupAction = resolveVisibleServerSetupAction\(server,[\s\S]*return \{[\s\S]*setupAction,/s,
  );
  assert.match(
    source,
    /case "attention":\s*return \(\s*Boolean\(entry\.setupAction\) \|\|[\s\S]*entry\.enabled/s,
  );
  assert.match(
    source,
    /const \{ ordered: orderedGridEntries \} =\s*partitionMcpServerGridEntries\(filteredGridEntries\);/,
  );
  assert.match(
    source,
    /orderedGridEntries[\s\S]*entry\.configured \|\| entry\.missingSetup[\s\S]*renderServerCard\(entry\.server, state, entry\.setupAction\)[\s\S]*renderUnconfiguredCard\(entry\.server, state, entry\.setupAction\)/s,
  );
  assert.match(
    source,
    /if \(entry\?\.missingSetup\) return 4;[\s\S]*entry\?\.setupAction === "authenticate"[\s\S]*entry\?\.setupAction === "configure"[\s\S]*entry\?\.enabled/s,
    "the renderer fallback must preserve the shared setup-first ordering",
  );
  assert.doesNotMatch(source, /Not Configured/);
  assert.match(source, /mcp-card-status-text needs-config">Needs Config/);
  assert.match(source, /needsConfiguration\s*\?\s*"needs-config-state"/);
  assert.doesNotMatch(source, /style="opacity: 0\.5;"/);

  assert.match(
    styles,
    /\[data-theme="dark"\] #control-tab \.mcp-server-card\.needs-attention\s*\{[^}]*background:\s*rgba\(251,\s*191,\s*36,\s*0\.16\);/s,
  );
  assert.match(
    styles,
    /\[data-theme="dark"\] #control-tab \.mcp-server-card\.needs-attention:hover\s*\{[^}]*background:\s*rgba\(251,\s*191,\s*36,\s*0\.22\);/s,
  );
  assert.match(
    styles,
    /\[data-theme="dark"\] #control-tab \.mcp-server-card\.needs-config-state\s*\{[^}]*background:\s*rgba\(167,\s*139,\s*250,\s*0\.16\);/s,
  );
  assert.match(
    styles,
    /\[data-theme="dark"\] #control-tab \.mcp-server-card\.needs-config-state:hover\s*\{[^}]*background:\s*rgba\(167,\s*139,\s*250,\s*0\.22\);/s,
  );
  assert.match(
    styles,
    /\[data-theme="light"\] \.mcp-server-card\.needs-attention\s*\{[^}]*background:\s*rgba\(217,\s*119,\s*6,\s*0\.18\);/s,
  );
  assert.match(
    styles,
    /\[data-theme="light"\] \.mcp-server-card\.needs-attention:hover\s*\{[^}]*background:\s*rgba\(217,\s*119,\s*6,\s*0\.24\);/s,
  );
  assert.match(
    styles,
    /\[data-theme="light"\] \.mcp-server-card\.needs-config-state\s*\{[^}]*background:\s*#cec4f5;/s,
  );
  assert.match(
    styles,
    /\[data-theme="light"\] \.mcp-server-card\.needs-config-state:hover\s*\{[^}]*background:\s*#c6b8ef;/s,
  );
  assert.match(
    styles,
    /\.mcp-card-status-text\.needs-config\s*\{[^}]*color:\s*#c4b5fd;[\s\S]*\[data-theme="light"\] \.mcp-card-status-text\.needs-config\s*\{[^}]*color:\s*#6d28d9;/s,
  );
  assert.match(
    styles,
    /\[data-theme="light"\] #control-tab \.mcp-card-oauth-btn\.authenticate-btn\s*\{[^}]*background:\s*#b45309;[^}]*color:\s*#fff;/s,
  );
  assert.match(
    styles,
    /\[data-theme="light"\] #control-tab \.mcp-card-oauth-btn\.authenticate-btn:hover\s*\{[^}]*background:\s*#92400e;[^}]*color:\s*#fff;[^}]*opacity:\s*1;/s,
  );
  assert.match(
    styles,
    /\[data-theme="light"\] \.mcp-server-card\s*\{[^}]*background:\s*#f8f9fb;[^}]*border:\s*1px solid rgba\(15,\s*23,\s*42,\s*0\.1\);[^}]*box-shadow:[^}]*0 8px 20px -16px rgba\(15,\s*23,\s*42,\s*0\.3\);/s,
  );
  assert.match(
    styles,
    /\[data-theme="light"\] \.mcp-server-card:hover\s*\{[^}]*background:\s*#ffffff;[^}]*border-color:\s*rgba\(15,\s*23,\s*42,\s*0\.15\);[^}]*transform:\s*translateY\(-1px\);/s,
  );
});

test("dark surfaces lift control-plane cards without changing their light treatment", () => {
  const styles = readRepoFile("electron-app/src/styles.css");

  assert.match(
    styles,
    /\[data-theme="dark"\]\s*\{[^}]*--portico-dark-card-surface:\s*#222225;[^}]*--portico-dark-card-hover:\s*#2b2b2f;[^}]*--portico-dark-card-border:\s*rgba\(255,\s*255,\s*255,\s*0\.14\);[^}]*--portico-dark-card-border-hover:\s*rgba\(255,\s*255,\s*255,\s*0\.21\);[^}]*--portico-dark-card-shadow:[^}]*0 16px 36px -24px rgba\(0,\s*0,\s*0,\s*0\.95\);/s,
    "the contrast lift should be defined by dark-only card tokens while the canvas remains black",
  );
  // Batch 6: dark Control Plane cards are borderless — the surface + shadow
  // separate them from the black canvas (no border in dark mode).
  assert.match(
    styles,
    /\[data-theme="dark"\] #control-tab \.mcp-server-card\s*\{[^}]*background:\s*var\(--portico-dark-card-surface\);[^}]*border:\s*none;[^}]*box-shadow:\s*var\(--portico-dark-card-shadow\);/s,
    "dark Control Plane integration cards should separate from the black canvas via surface + shadow, no border",
  );
  assert.match(
    styles,
    /\[data-theme="dark"\] #control-tab \.mcp-server-card:hover\s*\{[^}]*background:\s*var\(--portico-dark-card-hover\);[^}]*\}/s,
    "dark Control Plane integration cards should retain a restrained hover step",
  );
  assert.doesNotMatch(
    styles,
    /\[data-theme="dark"\] #control-tab \.mcp-server-card(:hover)?\s*\{[^}]*border(-color)?:\s*(1px solid )?var\(--portico-dark-card-border/s,
    "dark Control Plane cards must not reintroduce a border",
  );
  assert.match(
    styles,
    /\[data-theme="light"\] \.mcp-server-card\s*\{[^}]*background:\s*#f8f9fb;[^}]*border:\s*1px solid rgba\(15,\s*23,\s*42,\s*0\.1\);[^}]*box-shadow:[^}]*0 8px 20px -16px rgba\(15,\s*23,\s*42,\s*0\.3\);/s,
    "the dark-mode contrast pass must preserve the existing light integration-card surface",
  );
  assert.match(
    styles,
    /\[data-theme="light"\] \.mcp-server-card:hover\s*\{[^}]*background:\s*#ffffff;[^}]*border-color:\s*rgba\(15,\s*23,\s*42,\s*0\.15\);[^}]*transform:\s*translateY\(-1px\);/s,
    "the dark-mode contrast pass must preserve the existing light integration-card hover",
  );
});

test("loaded MCP metadata reports persisted OAuth token state through the existing validator", () => {
  const ipcSource = readRepoFile("electron-app/src/services/ipc.js");

  assert.match(
    ipcSource,
    /const \{\s*serverSupportsOAuth,\s*\} = require\("\.\/guided-setup\/server-requirements"\);/s,
  );
  assert.match(
    ipcSource,
    /if \(serverSupportsOAuth\(serverData\)\) \{[\s\S]*checkPersistedOAuthTokens\(serverId,\s*\{[\s\S]*projectRoot:\s*bootstrap\.PROJECT_ROOT,[\s\S]*isCoreServer,[\s\S]*\}\)\.exists === true;/s,
  );
  assert.match(ipcSource, /oauth:\s*serverData\.oauth \|\| null,[\s\S]*hasOAuthTokens,/s);
});

test("bulk selection can include stale-disabled cards while actions use effective card state", () => {
  const source = readRepoFile("electron-app/src/renderer/components/mcp-servers.js");
  const confirmBulkSection = source.slice(
    source.indexOf("async function confirmBulkToggleServers() {"),
    source.indexOf("// ===== Restart Confirmation Modal Functions =====", source.indexOf("async function confirmBulkToggleServers() {")),
  );

  assert.match(source, /function isServerBulkSelectable\(server,\s*state\) \{/);
  assert.match(source, /function isServerDesiredEnabled\(server,\s*state\) \{/);
  assert.match(
    source,
    /function isServerBulkEnableTarget\(server,\s*state\) \{[\s\S]*return isServerBulkSelectable\(server,\s*state\) && !isServerEnabled\(server,\s*state\);[\s\S]*\}/s,
  );
  assert.match(
    source,
    /function isServerBulkDisableTarget\(server,\s*state\) \{[\s\S]*return isServerBulkSelectable\(server,\s*state\) && isServerEnabled\(server,\s*state\);[\s\S]*\}/s,
  );
  assert.match(
    source,
    /function getVisibleSelectableServers\(state\) \{[\s\S]*return getFilteredServers\(state\.servers\)\.filter\(\(server\) =>\s*isServerBulkSelectable\(server,\s*state\),/s,
  );
  assert.match(
    source,
    /function getSelectedServersForAction\(state,\s*enabled\) \{[\s\S]*const predicate = enabled \? isServerBulkEnableTarget : isServerBulkDisableTarget;[\s\S]*return getSelectedServers\(state\)\.filter\(\(server\) => predicate\(server,\s*state\)\);[\s\S]*\}/s,
  );
  assert.match(
    source,
    /const enableTargets = selectedServers\.filter\(\(server\) =>\s*isServerBulkEnableTarget\(server,\s*state\),/s,
  );
  assert.match(
    source,
    /const disableTargets = selectedServers\.filter\(\(server\) =>\s*isServerBulkDisableTarget\(server,\s*state\),/s,
  );
  assert.match(
    confirmBulkSection,
    /const actionTargets = selectedIds[\s\S]*?\.filter\(\(server\) => server && isServerBulkSelectable\(server,\s*state\)\);/s,
  );
  assert.doesNotMatch(
    confirmBulkSection,
    /isServerDesiredEnabled\(server,\s*state\) !== enabled/,
    "bulk confirmation must not re-drop modal-confirmed stale-disabled targets",
  );
  assert.match(
    source,
    /syncSelectedServersWithVisible\(\s*filteredGridEntries\.map\(\(entry\) => entry\.server\),\s*state,\s*\);/s,
  );
  assert.match(source, /list\.querySelectorAll\("\.mcp-server-card"\)/);
});

test("pending enable state renders starting instead of stale disabled", () => {
  const source = readRepoFile("electron-app/src/renderer/components/mcp-servers.js");
  const enabledSection = source.slice(
    source.indexOf("function isServerEnabled(server, state) {"),
    source.indexOf("function isHostModeMissingSetup", source.indexOf("function isServerEnabled(server, state) {")),
  );
  const statusSection = source.slice(
    source.indexOf("function getServerHealthStatus(serverName) {"),
    source.indexOf("// Get full health info object", source.indexOf("function getServerHealthStatus(serverName) {")),
  );
  const renderSection = source.slice(
    source.indexOf(
      "function renderServerCard(server, state, setupActionOverride) {",
    ),
    source.indexOf(
      "// Render unconfigured server card",
      source.indexOf(
        "function renderServerCard(server, state, setupActionOverride) {",
      ),
    ),
  );

  assert.match(
    enabledSection,
    /if \(pendingOperation\?\.targetEnabled === false\) \{[\s\S]*?return false;[\s\S]*?\}[\s\S]*?if \(pendingOperation\?\.targetEnabled === true\) \{[\s\S]*?return true;[\s\S]*?\}[\s\S]*?backendInfo\?\.disabled_by_user === true/s,
    "pending enable must win before stale backend disabled metadata can make the card disabled",
  );
  assert.match(
    statusSection,
    /progressApi\.resolveEffectiveHealthStatus\([\s\S]*backendStatus,[\s\S]*pendingOperation,/s,
    "health status should still resolve pending enable as starting/checking",
  );
  assert.match(
    renderSection,
    /if \(!isEnabled\) \{[\s\S]*Disabled[\s\S]*\} else if \(healthStatus === "starting" \|\| healthStatus === "checking"\)/s,
    "card render order relies on isServerEnabled allowing pending enables through to Starting",
  );
});

test("completed authoritative operation supersedes stale post_oauth_recovery pending op", () => {
  const source = readRepoFile("electron-app/src/renderer/components/mcp-servers.js");
  const pendingSection = source.slice(
    source.indexOf("function getPendingServerOperation(serverId) {"),
    source.indexOf(
      "function ensureLocalHealthStatusSnapshot",
      source.indexOf("function getPendingServerOperation(serverId) {"),
    ),
  );

  assert.match(
    pendingSection,
    /if \(authoritative\.terminal !== true\) \{[\s\S]*\} else if \(row\) \{/s,
    "terminal authoritative snapshots must take a distinct branch from in-progress ones",
  );
  assert.match(
    pendingSection,
    /const legacy = window\.appState\.pendingServerOperations\?\.\[serverId\][\s\S]*const authoritativeAt = Number\([\s\S]*authoritative\.updatedAt \|\| authoritative\.createdAt[\s\S]*const legacyAt = Number\(legacy\.updatedAt \|\| legacy\.startedAt[\s\S]*if \(authoritativeAt >= legacyAt\) \{[\s\S]*clearPendingServerOperation\(serverId\);[\s\S]*return null;/s,
    "a completed authoritative op at least as recent as a locally-seeded pending op must clear it and defer to health (prevents post_oauth_recovery pinning the card enabled after an explicit disable)",
  );
});

test("terminal enable operations reconcile the local toggle cache from the authoritative snapshot", () => {
  const source = readRepoFile("electron-app/src/renderer/components/mcp-servers.js");
  const reconcilerSection = source.slice(
    source.indexOf("function reconcileEnableTerminalOperationState(snapshot) {"),
    source.indexOf(
      "function markMcpServerOAuthAuthenticated",
      source.indexOf("function reconcileEnableTerminalOperationState(snapshot) {"),
    ),
  );

  assert.match(
    reconcilerSection,
    /if \(snapshot\.kind !== "enable"\) \{[\s\S]*return;/s,
    "reconciler must only act on enable operations",
  );
  assert.match(
    reconcilerSection,
    /if \(stage === "needs_oauth" \|\| stage === "waiting_callback"\) \{[\s\S]*markMcpServerEnabledNeedsAuthentication\(row\.id/s,
    "needs-auth terminal rows must mark the server enabled + needs authentication",
  );
  assert.match(
    reconcilerSection,
    /else if \(stage === "not_configured"\) \{[\s\S]*markMcpServerEnabledNeedsConfiguration\(row\.id/s,
    "not-configured terminal rows must mark the server enabled + needs configuration",
  );
  assert.match(
    reconcilerSection,
    /stage === "healthy"[\s\S]*stage === "running"[\s\S]*applyLocalToggleState\(row\.id,\s*true/s,
    "healthy/running terminal rows must flip the stale local toggle to enabled",
  );

  assert.match(
    source,
    /window\.reconcileMcpEnableTerminalState = reconcileEnableTerminalOperationState;/,
    "the reconciler must be exposed for the operation overlay controller to invoke",
  );
});

test("operation overlay reconciles enable terminal state once per terminal operation", () => {
  const source = readRepoFile("electron-app/src/renderer/components/control-plane.js");
  const notifySection = source.slice(
    source.indexOf("function notifyTerminalOnce() {"),
    source.indexOf("function render() {"),
  );

  assert.match(
    notifySection,
    /presentation\.terminalNotified === true[\s\S]*return;[\s\S]*window\.reconcileMcpEnableTerminalState\?\.\(currentSnapshot\);/s,
    "reconciliation must run after the terminal-notified guard so it fires exactly once per operation, even when dismissed via Done",
  );
});

test("IPC enable preflight treats NOT_CONFIGURED as enabled-with-follow-up instead of a failed restart", () => {
  const ipcSource = readRepoFile("electron-app/src/services/ipc.js");

  assert.match(ipcSource, /detectToggleEnablePreflightIssue/);
  assert.match(
    ipcSource,
    /const requiresConfiguration =\s*enabled\s*&&\s*isConfigurationRequiredPreflightIssue\(enablePreflightIssue\);/s,
  );
  assert.match(
    ipcSource,
    /requiresConfiguration:\s*true,[\s\S]*started:\s*false,[\s\S]*uiStatus:\s*"not_configured"/s,
  );
  assert.match(
    ipcSource,
    /configRequiredServerIds\.forEach\(\(serverId\) => \{[\s\S]*requiresConfiguration:\s*true,[\s\S]*started:\s*false,[\s\S]*uiStatus:\s*"not_configured"/s,
  );
  assert.match(
    ipcSource,
    /const lifecycleTargetIds = enabled\s*\?\s*startableServerIds\s*:\s*normalizedServerIds;/s,
  );
});

test("bulk startup failures render as failed cards and open the right failure surface", () => {
  const source = readRepoFile("electron-app/src/renderer/components/mcp-servers.js");
  const html = readRepoFile("electron-app/src/renderer/views/index.html");

  assert.match(source, /function markMcpServerEnableAttemptStarted\(serverId,\s*options = \{\}\) \{/);
  assert.match(
    source,
    /markMcpServerEnableAttemptStarted\(serverId,[\s\S]*?detail:\s*"Applying configuration\.\.\."/s,
  );
  assert.match(
    source,
    /actionTargets\.forEach\(\(server\) => \{[\s\S]*?if \(enabled\) \{[\s\S]*?markMcpServerEnableAttemptStarted\(server\.id,/s,
  );
  assert.match(source, /function hasStartupFailureState\(healthStatus,\s*healthInfo,\s*serverId = null\) \{/);
  assert.match(
    source,
    /healthInfo\?\.startup_failure[\s\S]*?typeof healthInfo\.startup_failure === "object"[\s\S]*?return Boolean\(getStartupFailureInfo\(healthInfo,\s*serverId\)\);[\s\S]*?normalizedStatus === "disabled"/s,
  );
  assert.match(source, /function markMcpServerStartupFailure\(serverId,\s*failure = \{\}\) \{/);
  assert.match(
    source,
    /status:\s*startupFailure\.stage === "timeout" \? "timeout" : "failed",[\s\S]*?disabled_by_user:\s*false,[\s\S]*?disabled_reason:\s*null,[\s\S]*?startup_failure:\s*startupFailure/s,
  );
  assert.match(source, /function scheduleMcpServersListRefresh\(reason = "mcp-state-change"\) \{/);
  assert.match(
    source,
    /markMcpServerStartupFailure\(\s*serverId,\s*result\.startupFailure \|\| \{/s,
  );
  assert.match(
    source,
    /scheduleMcpServersListRefresh\(`startup-failure:\$\{serverId\}`\)/,
  );
  assert.match(
    source,
    /if \(hasStartupFailureState\(backendStatus,\s*backendInfo,\s*server\.id\)\) \{\s*return true;\s*\}/s,
  );
  assert.match(
    source,
    /markMcpServerStartupFailure\(\s*server\.id,\s*entry\?\.startupFailure/s,
  );
  assert.match(
    source,
    /if \(hasStartupFailureState\(healthStatus,\s*healthInfo,\s*serverId\)\) \{[\s\S]*isConfigStartupFailure\(healthInfo,\s*serverId\)[\s\S]*showStartupFailureModal\(serverId\)[\s\S]*showServerLogs\(serverId,\s*deploymentType/s,
  );
  assert.match(
    source,
    /if \(card\.dataset\.enabled === "false"\) \{[\s\S]*return;[\s\S]*\}[\s\S]*if \(hasStartupFailureState\(healthStatus,\s*healthInfo,\s*serverId\)\) \{/,
  );
  assert.match(html, /id="startup-failure-modal"/);
  assert.match(html, /id="startup-failure-error"/);
  assert.match(html, /id="startup-failure-copy-btn"/);
  assert.match(source, /window\.electronAPI\?\.copyToClipboard/);
  assert.match(source, /navigator\.clipboard\.writeText\(startupFailureModalDetails\)/);
});

test("startup failure rendering ignores mismatched server metadata and sends config failures to startup modal", () => {
  const source = readRepoFile("electron-app/src/renderer/components/mcp-servers.js");
  const failureInfoSection = source.slice(
    source.indexOf("function getStartupFailureInfo"),
    source.indexOf("function hasStartupFailureState", source.indexOf("function getStartupFailureInfo")),
  );
  const logsSection = source.slice(
    source.indexOf("async function showServerLogs"),
    source.indexOf("let startupFailureModalInitialized", source.indexOf("async function showServerLogs")),
  );

  assert.match(
    failureInfoSection,
    /const expectedServerId = String\(serverId \|\| ""\)\.trim\(\);[\s\S]*failureServerId === expectedServerId/s,
  );
  assert.match(
    failureInfoSection,
    /if \(!failureMatchesServer\(healthInfo\.startup_failure\)\) \{[\s\S]*return null;[\s\S]*\}/s,
  );
  assert.match(
    logsSection,
    /hasStartupFailureState\(healthStatus,\s*healthInfo,\s*serverId\)[\s\S]*isConfigStartupFailure\(healthInfo,\s*serverId\)[\s\S]*showStartupFailureModal\(serverId\);[\s\S]*return;/s,
  );
});

test("badge effective health ignores deleted health-only server ids", () => {
  const source = readRepoFile("electron-app/src/renderer/components/mcp-servers.js");
  const section = source.slice(
    source.indexOf("function getServersWithEffectiveHealth"),
    source.indexOf("async function fetchServerReadiness", source.indexOf("function getServersWithEffectiveHealth")),
  );

  assert.match(section, /\.\.\.serversById\.keys\(\)/);
  assert.match(
    section,
    /Object\.keys\(state\?\.pendingServerOperations \|\| \{\}\)\.filter\(\(serverId\) =>\s*serversById\.has\(serverId\),\s*\)/s,
  );
  assert.doesNotMatch(
    section,
    /Object\.keys\(state\?\.healthStatus\?\.servers \|\| \{\}\)/,
  );
  assert.match(section, /return false;/);
});

test("control plane reconciles lagging checking cards with one bulk readiness call", () => {
  const source = readRepoFile("electron-app/src/renderer/components/mcp-servers.js");
  const bulkSection = source.slice(
    source.indexOf("async function fetchServerReadinessBulk"),
    source.indexOf("function getLocalMcpoPortForDeployment"),
  );
  const renderSection = source.slice(
    source.indexOf("async function updateMcpServersList"),
    source.indexOf("function updateMcpBadge"),
  );

  assert.match(source, /const BULK_READINESS_RECONCILE_MIN_INTERVAL_MS = 10000;/);
  assert.match(source, /function getLaggingReadinessServerIds\(state = window\.appState\) \{/);
  assert.match(source, /state\?\.healthStatus\?\.sync_diagnostics\?\.lagging_server_ids/);
  assert.match(bulkSection, /fetch\(`\$\{LOCAL_API_BASE_URL\}\/api\/server-readiness\/bulk`,\s*\{/);
  assert.match(bulkSection, /body:\s*JSON\.stringify\(\{\s*server_ids:\s*serverIds\s*\}\)/);
  assert.match(bulkSection, /for \(const \[serverId,\s*readiness\] of Object\.entries\(results\)\) \{[\s\S]*applyReadinessToLocalHealthState\(serverId,\s*readiness\);/);
  assert.match(renderSection, /void refreshLaggingServerReadiness\(\{\s*reason:\s*"control-plane-render"\s*\}\);/);
  assert.match(source, /window\.refreshLaggingServerReadiness = refreshLaggingServerReadiness;/);
});

test("rendered control plane badge fallback derives configured servers before filtering them", () => {
  const source = readRepoFile("electron-app/src/renderer/components/mcp-servers.js");
  const renderSection = source.slice(
    source.indexOf("async function updateMcpServersList"),
    source.indexOf("const CONTROL_PLANE_ATTENTION_FAILURE_STATUSES"),
  );
  const badgeFallback = renderSection.slice(
    renderSection.lastIndexOf("// Update MCP badge"),
  );

  assert.match(
    badgeFallback,
    /const configuredServers = state\.servers\.filter\(\(s\) =>\s*isServerConfiguredForUi\(s, state\),\s*\);[\s\S]*let enabledServers = configuredServers\.filter\(\(s\) =>\s*isServerEnabled\(s, state\),\s*\);/,
  );
});

test("control plane tab switch schedules heavy refresh work after activation", () => {
  const source = readRepoFile("electron-app/src/renderer/components/chat-tab.js");
  const switchSection = source.slice(
    source.indexOf("function switchTab(tabName)"),
    source.indexOf("// Hide all conversation webviews", source.indexOf("function switchTab(tabName)")),
  );
  const controlBranch = switchSection.slice(
    switchSection.indexOf("if (tabName === 'control')"),
    switchSection.indexOf("// Hide all debugger webviews"),
  );
  const scheduledWorkSection = source.slice(
    source.indexOf("function scheduleControlPlaneActivationWork"),
    source.indexOf("// Tab switching - EXACT code", source.indexOf("function scheduleControlPlaneActivationWork")),
  );

  assert.match(source, /let controlPlaneActivationWorkToken = 0;/);
  assert.match(source, /function scheduleAfterNextPaint\(callback\)/);
  assert.match(source, /window\.requestAnimationFrame\(\(\) => \{[\s\S]*window\.requestAnimationFrame\(run\);/);
  assert.match(controlBranch, /scheduleControlPlaneActivationWork\(state\);/);
  assert.doesNotMatch(controlBranch, /window\.updateMcpServersList\(\);/);
  assert.doesNotMatch(controlBranch, /window\.refreshToolsCountForHealthyServers\(\{ forceRender: true \}\);/);
  assert.match(switchSection, /state\.activeTab = tabName;/);
  assert.match(switchSection, /targetTab\.classList\.add\('active'\);/);
  assert.match(scheduledWorkSection, /currentState\?\.activeTab !== 'control'/);
  assert.match(scheduledWorkSection, /window\.initControlPlaneV2\(\);/);
  assert.match(scheduledWorkSection, /window\.updateMcpServersList\(\);/);
  assert.match(scheduledWorkSection, /window\.refreshToolsCountForHealthyServers\(\{ forceRender: true \}\);/);
});

test("preload and renderer listen for backend MCP toggle events", () => {
  const preloadSource = readRepoFile("electron-app/src/services/preload.js");
  const indexSource = readRepoFile("electron-app/src/renderer/views/index.js");

  assert.match(preloadSource, /onMcpServerToggled:\s*\(callback\)\s*=>\s*\{/);
  assert.match(preloadSource, /ipcRenderer\.on\('mcp-server-toggled',\s*\(event,\s*data\)\s*=>\s*callback\(data\)\);/);
  assert.match(indexSource, /setupMcpServerToggleListener\(\);/);
  assert.match(indexSource, /function setupMcpServerToggleListener\(\)/);
  assert.match(indexSource, /window\.electronAPI\.onMcpServerToggled\((?:async\s*)?\(\{\s*server_id,\s*enabled\s*\}\)\s*=>/);
  assert.match(indexSource, /state\.toggles = state\.toggles && typeof state\.toggles === 'object'/);
  assert.match(indexSource, /if \(window\.applyLocalMcpToggleState\) \{/);
  assert.match(indexSource, /window\.applyLocalMcpToggleState\(server_id,\s*Boolean\(enabled\)\);/);
});

test("header MCP badge opens Control Plane Integrations through the shared helper", () => {
  const html = readRepoFile("electron-app/src/renderer/views/index.html");
  const indexSource = readRepoFile("electron-app/src/renderer/views/index.js");

  assert.match(
    html,
    /<button[\s\S]*class="mcp-badge"[\s\S]*id="mcp-badge"[\s\S]*type="button"[\s\S]*aria-label="Open Control Plane Integrations"/s,
  );
  assert.match(
    html,
    /<span class="mcp-badge-count">0<\/span> MCPs/,
    "the header badge should use the compact MCPs label",
  );
  assert.doesNotMatch(
    html,
    /<button[\s\S]*id="mcp-badge"[\s\S]*title="Open Control Plane Integrations"/s,
    "the MCP badge should keep its accessible label but not show a native title tooltip",
  );
  assert.match(indexSource, /function openControlPlaneIntegrations\(\)/);
  assert.match(indexSource, /window\.openControlPlaneIntegrations = openControlPlaneIntegrations;/);
  assert.match(indexSource, /ensureControlPlaneTabActive\(\);/);
  assert.match(indexSource, /const integrationsButton = document\.getElementById\('view-mcp-servers-btn'\);/);
  assert.match(indexSource, /integrationsButton\.click\(\);/);
  assert.match(indexSource, /window\.appState\.controlPlaneView = 'mcp-servers';/);
  assert.match(indexSource, /window\.refreshToolsCountForHealthyServers\?\.\(\{ forceRender: true \}\);/);
  assert.match(indexSource, /const mcpBadge = document\.getElementById\('mcp-badge'\);/);
  assert.match(
    indexSource,
    /mcpBadge\.addEventListener\('click',\s*\(\)\s*=>\s*\{\s*window\.openControlPlaneIntegrations\?\.\(\);\s*\}\);/s,
  );
});

test("header Control Plane button replaces the permanent tab and preserves the current subview", () => {
  const html = readRepoFile("electron-app/src/renderer/views/index.html");
  const indexSource = readRepoFile("electron-app/src/renderer/views/index.js");
  const chatTabSource = readRepoFile("electron-app/src/renderer/components/chat-tab.js");
  const stateSource = readRepoFile("electron-app/src/renderer/state.js");
  const tabBarSource = readRepoFile("electron-app/src/renderer/components/tab-bar.js");

  assert.doesNotMatch(html, /data-tab="control"/);
  assert.match(
    html,
    /<button[\s\S]*class="control-plane-toggle"[\s\S]*id="control-plane-toggle"[\s\S]*type="button"[\s\S]*title="Control Plane"[\s\S]*aria-label="Control Plane"[\s\S]*aria-pressed="false"/s,
  );
  assert.match(
    html,
    /id="control-plane-toggle"[\s\S]*id="control-plane-attention-badge"[\s\S]*class="control-plane-attention-badge hidden"[\s\S]*aria-hidden="true"[\s\S]*>\s*0\s*<\/span>/s,
  );
  assert.match(
    html,
    /id="control-plane-toggle"[\s\S]*id="theme-toggle"/s,
    "the Control Plane button should sit immediately to the left of the theme toggle in the header action group",
  );
  assert.match(indexSource, /function syncControlPlaneToggleActive\(isActive\)/);
  assert.match(indexSource, /window\.syncControlPlaneToggleActive = syncControlPlaneToggleActive;/);
  assert.match(indexSource, /const controlPlaneToggle = document\.getElementById\('control-plane-toggle'\);/);
  assert.match(
    indexSource,
    /controlPlaneToggle\.addEventListener\('click',\s*\(\)\s*=>\s*\{\s*window\.ensureControlPlaneTabActive\?\.\(\);\s*\}\);/s,
  );
  assert.doesNotMatch(indexSource, /querySelector\('\.tab-btn\[data-tab="control"\]'\)/);
  assert.match(chatTabSource, /window\.syncControlPlaneToggleActive\?\.\(tabName === 'control'\);/);
  assert.match(stateSource, /tabOrder:\s*\['chat'\]/);
  assert.match(tabBarSource, /const PERMANENT_TABS = new Set\(\['chat'\]\);/);
  assert.match(tabBarSource, /const newOrder = \['chat'\];/);
});

test("Control Plane icon badge shows enabled MCP servers needing attention", () => {
  const styles = readRepoFile("electron-app/src/styles.css");
  const source = readRepoFile("electron-app/src/renderer/components/mcp-servers.js");

  assert.match(
    styles,
    /\.control-plane-toggle\s*\{[^}]*position:\s*relative;[^}]*overflow:\s*visible;[^}]*\}/s,
  );
  assert.match(
    styles,
    /\.control-plane-attention-badge\s*\{[^}]*position:\s*absolute;[^}]*top:\s*-4px;[^}]*right:\s*-4px;[^}]*display:\s*inline-grid;[^}]*place-items:\s*center;[^}]*min-width:\s*16px;[^}]*height:\s*16px;[^}]*background:\s*#8a0303;[^}]*line-height:\s*1;[^}]*text-align:\s*center;[^}]*pointer-events:\s*none;[^}]*\}/s,
  );
  assert.match(
    styles,
    /\.control-plane-attention-badge\.hidden\s*\{[^}]*display:\s*none;[^}]*\}/s,
  );
  assert.match(
    source,
    /const CONTROL_PLANE_ATTENTION_FAILURE_STATUSES = new Set\(\[[\s\S]*"failed"[\s\S]*"timeout"[\s\S]*"not_running"[\s\S]*\]\);/s,
  );
  assert.match(
    source,
    /function calculateMcpAttentionCount\(state = window\.appState\) \{[\s\S]*getServersWithEffectiveHealth\(state\)[\s\S]*isServerEnabled\(server,\s*state\)[\s\S]*healthStatus === "disabled"[\s\S]*disabled_by_user === true[\s\S]*shouldShowNeedsAuth\(healthStatus,\s*info\)[\s\S]*hasStartupFailureState\(healthStatus,\s*info,\s*serverId\)[\s\S]*CONTROL_PLANE_ATTENTION_FAILURE_STATUSES\.has\(healthStatus\)[\s\S]*\.length;[\s\S]*\}/s,
  );
  assert.match(
    source,
    /function updateControlPlaneAttentionBadge\(count\) \{[\s\S]*document\.getElementById\("control-plane-attention-badge"\)[\s\S]*document\.getElementById\("control-plane-toggle"\)[\s\S]*button\.setAttribute\("aria-label", buttonLabel\)[\s\S]*normalizedCount > 99 \? "99\+" : String\(normalizedCount\)[\s\S]*badge\.classList\.toggle\("hidden", !hasAttention\)/s,
  );
  assert.match(
    source,
    /const attentionCount = window\.appState\?\.healthStatus\?\.servers[\s\S]*calculateMcpAttentionCount\(window\.appState\)[\s\S]*updateControlPlaneAttentionBadge\(attentionCount\);/s,
  );
  assert.match(
    source,
    /const allServersWithHealth = getServersWithEffectiveHealth\(state\);\s*updateControlPlaneAttentionBadge\(calculateMcpAttentionCount\(state\)\);/,
  );
});

test("post-auth recovery keeps control plane in checking over stale needs_oauth", () => {
  const source = readRepoFile("electron-app/src/renderer/components/mcp-servers.js");
  const progressSource = readRepoFile(
    "electron-app/src/renderer/components/mcp-operation-progress.js",
  );

  assert.match(
    source,
    /function markMcpServerPostSuccessStarting\(serverId, options = \{\}\) \{[\s\S]*status: stage === "checking" \? "checking" : "starting"[\s\S]*operationKind: options\.operationKind \|\| null[\s\S]*postAuthRecovery: options\.postAuthRecovery === true/s,
  );
  assert.match(
    source,
    /const currentPendingOperation =\s*getPendingServerOperation\(serverId\) \|\| pendingOperation;[\s\S]*const shouldContinueWaiting =\s*shouldContinueWaitingForPostOperationReadiness\([\s\S]*currentPendingOperation[\s\S]*POST_OPERATION_STABLE_READINESS_PHASES\.has\(lastReadinessPhase\) &&\s*!shouldContinueWaiting/s,
  );
  assert.match(
    progressSource,
    /const isPostAuthRecovery =[\s\S]*pendingOperation\.postAuthRecovery === true[\s\S]*pendingOperation\.operationKind === "post_oauth_recovery"[\s\S]*const canOverridePostAuthNeedsOAuth =[\s\S]*normalizedStatus === "needs_oauth"[\s\S]*if \(canOverridePostAuthNeedsOAuth\) \{[\s\S]*return true;/s,
  );
});

test("control plane retains the legacy report modal implementation alongside direct debug collection", () => {
  const html = readRepoFile("electron-app/src/renderer/views/index.html");
  const indexSource = readRepoFile("electron-app/src/renderer/views/index.js");
  const controlPlaneSource = readRepoFile("electron-app/src/renderer/components/control-plane.js");

  assert.doesNotMatch(html, /id="diagnostics-btn"/);
  assert.doesNotMatch(html, /id="diagnostics-modal"/);
  assert.doesNotMatch(indexSource, /initDiagnosticsModal/);
  assert.doesNotMatch(indexSource, /collectDiagnosticSnapshot/);
  assert.doesNotMatch(indexSource, /saveDiagnosticReport/);
  assert.match(html, /id="bug-report-modal"/);
  assert.match(html, />\s*Report a Bug\s*</);
  assert.match(html, />\s*Send Report\s*</);
  assert.match(controlPlaneSource, /function initBugReportModal\(\)/);
  assert.match(controlPlaneSource, /async function collectAndUploadDebugInfo\(\)/);
  assert.match(controlPlaneSource, /window\.electronAPI\.uploadDebugLogs\(\{/);
  assert.match(controlPlaneSource, /initBugReportModal\(\);/);
});

test("header hit test diagnostics are removed from production renderer code", () => {
  const indexSource = readRepoFile("electron-app/src/renderer/views/index.js");
  const chatTabSource = readRepoFile("electron-app/src/renderer/components/chat-tab.js");

  assert.doesNotMatch(indexSource, /installHeaderHitTestDiagnostics/);
  assert.doesNotMatch(indexSource, /inspectHeaderHitTest/);
  assert.doesNotMatch(indexSource, /\[HeaderHitTest\]/);
  assert.doesNotMatch(chatTabSource, /inspectHeaderHitTest/);
});

test("main chat renderer no longer includes the privacy warning banner or dismissal state", () => {
  const html = readRepoFile("electron-app/src/renderer/views/index.html");
  const indexSource = readRepoFile("electron-app/src/renderer/views/index.js");
  const styles = readRepoFile("electron-app/src/styles.css");

  assert.doesNotMatch(html, /id="warning-banner"/);
  assert.doesNotMatch(html, /id="guidelines-link"/);
  assert.doesNotMatch(html, /id="banner-close-btn"/);
  assert.doesNotMatch(indexSource, /warning-banner-dismissed-time/);
  assert.doesNotMatch(indexSource, /company-wide-generative-ai-use-guidelines/);
  assert.doesNotMatch(styles, /\[data-theme="light"\]\s+\.warning-banner\s*\{/);
  assert.doesNotMatch(styles, /\.warning-banner\s*\{/);
  assert.doesNotMatch(styles, /\.warning-text\s*\{/);
  assert.doesNotMatch(styles, /\.warning-link\s*\{/);
  assert.doesNotMatch(styles, /\.banner-close-btn\s*\{/);
});

test("control plane disabled, unconfigured, and missing-setup cards render without opacity dimming", () => {
  const styles = readRepoFile("electron-app/src/styles.css");

  assert.match(
    styles,
    /\.mcp-server-card\s*\{[^}]*overflow:\s*visible;/s,
  );
  assert.match(
    styles,
    /\.mcp-server-card\.disabled-state\s*\{[^}]*opacity:\s*1;/s,
  );
  assert.match(
    styles,
    /\.mcp-card-badge\.badge-missing\s*\{[^}]*background:\s*var\(--status-warning-bg\);[^}]*color:\s*var\(--status-warning\);/s,
  );
  assert.match(
    styles,
    /\[data-theme="light"\]\s+\.mcp-server-card\.disabled-state\s*\{[^}]*opacity:\s*1;[^}]*filter:\s*none;/s,
  );
  assert.match(
    styles,
    /\[data-theme="light"\]\s+\.mcp-server-card\.disabled-state\s+\.mcp-card-icon-wrapper,[^}]*opacity:\s*1;/s,
  );
  assert.match(
    styles,
    /\[data-theme="light"\]\s+\.mcp-server-card\.disabled-state\s+\.mcp-card-status-dot\s*\{[^}]*opacity:\s*1;/s,
  );
  assert.doesNotMatch(
    styles,
    /\.mcp-card-badge\.badge-missing\[data-tooltip\]\s*\{/,
  );
  assert.doesNotMatch(
    styles,
    /\.mcp-tooltip\[data-variant="warning"\]\s*\{/,
  );
  assert.doesNotMatch(
    styles,
    /\.mcp-tooltip-warning-copy\s*\{/,
  );
  assert.doesNotMatch(
    styles,
    /\.mcp-card-badge\.badge-missing\[data-tooltip\]::after\s*\{/,
  );
});

test("control plane search bars use the original shared wide layout", () => {
  const styles = readRepoFile("electron-app/src/styles.css");
  const controlPlaneSource = readRepoFile(
    "electron-app/src/renderer/components/control-plane.js",
  );

  assert.match(
    styles,
    /\.mcp-search-wrapper\s*\{[^}]*position:\s*relative;[^}]*flex:\s*1;[^}]*min-width:\s*200px;/s,
  );
  assert.doesNotMatch(
    styles,
    /--control-plane-search-width/,
  );
  assert.doesNotMatch(
    styles,
    /#mcp-servers-view\s+\.mcp-search-wrapper,\s*#agent-skills-view\s+\.mcp-search-wrapper,\s*#marketplaces-view\s+\.mcp-search-wrapper/,
  );
  assert.doesNotMatch(
    styles,
    /#mcp-servers-view\s+\.mcp-filter-tabs,\s*#agent-skills-view\s+\.mcp-filter-tabs,\s*#marketplaces-view\s+\.mcp-filter-tabs/,
  );
  assert.doesNotMatch(
    controlPlaneSource,
    /syncControlPlaneSearchWidth|initControlPlaneSearchWidthSync|controlPlaneSearchWidthObserver|--control-plane-search-width/,
  );
});

test("MCP badge tooltip uses one shared six-column card grid and stacks status groups vertically", () => {
  const source = readRepoFile("electron-app/src/renderer/components/mcp-servers.js");
  const styles = readRepoFile("electron-app/src/styles.css");

  const sectionRenderCalls = source.match(/renderTooltipSection\(\{/g) || [];
  const sectionStackMatches = source.match(/class="tooltip-sections"/g) || [];
  const helperDefinitions = source.match(/const renderTooltipSection = \(\{/g) || [];

  assert.equal(
    helperDefinitions.length,
    2,
    "both tooltip render paths should define the shared section helper",
  );
  assert.equal(
    sectionRenderCalls.length,
    9,
    "both tooltip render paths should render every category through the shared section helper",
  );
  assert.equal(
    sectionStackMatches.length,
    2,
    "both tooltip render paths should render their sections inside one shared vertical stack",
  );
  assert.doesNotMatch(
    source,
    /tooltip-servers-list|tooltip-servers-list-user|tooltip-status-grid|tooltip-main-grid|tooltip-status-section|class="tooltip-column"|class="tooltip-status-group"/,
    "the renderer should not use the legacy multi-wrapper tooltip section layout",
  );
  assert.match(
    styles,
    /\.tooltip-card-grid\s*\{[^}]*grid-template-columns:\s*repeat\(6,\s*minmax\(0,\s*1fr\)\);[^}]*gap:\s*10px;[^}]*\}/s,
    "the shared tooltip card grid should render up to six servers per row",
  );
  assert.match(
    styles,
    /\.tooltip-sections\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*gap:\s*var\(--tooltip-section-gap\);[^}]*\}/s,
    "all tooltip sections should live in one shared vertical stack",
  );
  assert.match(
    styles,
    /\.mcp-tooltip\s*\{[^}]*--tooltip-section-gap:\s*16px;[^}]*\}/s,
    "the tooltip should give grouped server sections room to breathe",
  );
  assert.match(
    styles,
    /\.tooltip-section\s*\{[^}]*min-width:\s*0;[^}]*\}/s,
    "each tooltip section should share the same block wrapper styling",
  );
  assert.doesNotMatch(
    styles,
    /\.tooltip-servers-list\s*\{|\.tooltip-servers-list-user\s*\{|\.tooltip-status-grid\s*\{|\.tooltip-main-grid\s*\{|\.tooltip-status-section\s*\{|\.tooltip-column\s*\{|\.tooltip-status-group\s*\{/,
    "the stylesheet should not define legacy per-section tooltip stack classes",
  );
});

test("MCP badge pane shares the landing page's elevated card treatment", () => {
  const styles = readRepoFile("electron-app/src/styles.css");

  assert.match(
    styles,
    /\.mcp-tooltip\s*\{[^}]*background:\s*rgba\(23,\s*23,\s*23,\s*0\.985\);[^}]*border-radius:\s*16px;[^}]*box-shadow:[^}]*0 22px 48px -18px rgba\(0,\s*0,\s*0,\s*0\.72\);/s,
    "dark mode should use a restrained elevated pane rather than the old blue-gray sheet",
  );
  assert.match(
    styles,
    /\[data-theme="light"\] \.mcp-tooltip\s*\{[^}]*background:\s*rgba\(247,\s*247,\s*247,\s*0\.985\);[^}]*border-color:\s*rgba\(15,\s*23,\s*42,\s*0\.09\);[^}]*box-shadow:/s,
    "light mode should match the landing page's off-white elevated surface",
  );
  assert.match(
    styles,
    /\.tooltip-server-card\s*\{[^}]*min-height:\s*76px;[^}]*background:\s*#1d1d1d;[^}]*border:\s*1px solid rgba\(255,\s*255,\s*255,\s*0\.075\);[^}]*border-radius:\s*12px;[^}]*box-shadow:/s,
    "server tiles should read as individual compact cards in dark mode",
  );
  assert.match(
    styles,
    /\[data-theme="light"\] \.tooltip-server-card\s*\{[^}]*background:\s*#ffffff;[^}]*border-color:\s*rgba\(15,\s*23,\s*42,\s*0\.09\);[^}]*box-shadow:/s,
    "server tiles should use the landing page's white cards in light mode",
  );
});

test("dark MCP quick-pane tiles gain contrast without changing their light surfaces", () => {
  const styles = readRepoFile("electron-app/src/styles.css");

  assert.match(
    styles,
    /\[data-theme="dark"\] \.mcp-tooltip\s*\{[^}]*background:\s*rgba\(28,\s*28,\s*30,\s*0\.985\);[^}]*border-color:\s*var\(--portico-dark-card-border\);[^}]*box-shadow:\s*var\(--portico-dark-card-shadow\);/s,
    "the dark quick pane should lift above the black canvas without changing the canvas itself",
  );
  assert.match(
    styles,
    /\[data-theme="dark"\] \.tooltip-server-card\s*\{[^}]*background:\s*var\(--portico-dark-card-surface\);[^}]*border-color:\s*var\(--portico-dark-card-border\);[^}]*box-shadow:\s*var\(--portico-dark-card-shadow\);/s,
    "dark MCP quick-pane tiles should be visibly lighter than their pane",
  );
  assert.match(
    styles,
    /\[data-theme="dark"\] \.tooltip-server-card:hover\s*\{[^}]*background:\s*var\(--portico-dark-card-hover\);[^}]*border-color:\s*var\(--portico-dark-card-border-hover\);/s,
    "dark MCP quick-pane tiles should retain a clear hover state",
  );
  assert.match(
    styles,
    /\[data-theme="light"\] \.mcp-tooltip\s*\{[^}]*background:\s*rgba\(247,\s*247,\s*247,\s*0\.985\);[^}]*border-color:\s*rgba\(15,\s*23,\s*42,\s*0\.09\);[^}]*box-shadow:/s,
    "the dark contrast pass must preserve the light quick-pane surface",
  );
  assert.match(
    styles,
    /\[data-theme="light"\] \.tooltip-server-card\s*\{[^}]*background:\s*#ffffff;[^}]*border-color:\s*rgba\(15,\s*23,\s*42,\s*0\.09\);[^}]*box-shadow:/s,
    "the dark contrast pass must preserve the light quick-pane tiles",
  );
  assert.match(
    styles,
    /\[data-theme="light"\] \.tooltip-server-card:hover\s*\{[^}]*background:\s*#ffffff;[^}]*border-color:\s*rgba\(15,\s*23,\s*42,\s*0\.14\);[^}]*box-shadow:/s,
    "the dark contrast pass must preserve the light quick-pane hover treatment",
  );
});

test("MCP badge tooltip headers use one shared label style and keep count pills adjacent to the label", () => {
  const source = readRepoFile("electron-app/src/renderer/components/mcp-servers.js");
  const styles = readRepoFile("electron-app/src/styles.css");

  const headerHelperMatches =
    source.match(
      /<span class="tooltip-section-title">\$\{title\}<\/span>\s*<span class="tooltip-column-count">\$\{count\}<\/span>/g,
    ) || [];

  assert.equal(
    headerHelperMatches.length,
    2,
    "both tooltip render paths should use the shared title and adjacent count pill markup",
  );
  assert.match(
    source,
    /title:\s*"Initializing",\s*count:\s*allServers\.length,/s,
    "the initializing section should pass its label and count separately into the shared helper",
  );
  assert.match(
    source,
    /title:\s*"Starting",\s*count:\s*startingCount,/s,
    "the starting section should pass its label and count separately into the shared helper",
  );
  assert.match(
    source,
    /title:\s*"Need OAuth",\s*count:\s*allNeedsAuth\.length,/s,
    "the Need OAuth section should pass its label and count separately into the shared helper",
  );
  assert.match(
    source,
    /title:\s*"Failed",\s*count:\s*allFailed\.length,/s,
    "the Failed section should pass its label and count separately into the shared helper",
  );
  assert.match(
    source,
    /title:\s*"Disabled",\s*count:\s*disabledCount,/s,
    "the Disabled section should pass its label and count separately into the shared helper",
  );
  assert.doesNotMatch(
    source,
    /tooltip-column-title|tooltip-status-label|tooltip-column-header|tooltip-status-header|tooltip-section-header-primary/,
    "the renderer should no longer use split header classes for main vs status sections",
  );
  assert.match(
    styles,
    /\.tooltip-section-title\s*\{[^}]*font-size:\s*11px;[^}]*font-weight:\s*650;[^}]*text-transform:\s*uppercase;[^}]*letter-spacing:\s*0\.08em;[^}]*\}/s,
    "all tooltip headers should share the same title typography",
  );
  assert.match(
    styles,
    /\.tooltip-section-header\s*\{[^}]*gap:\s*6px;[^}]*margin-bottom:\s*10px;[^}]*\}/s,
    "the shared header structure should separate labels cleanly from the cards",
  );
  assert.match(
    styles,
    /\.tooltip-column-count\s*\{[^}]*font-size:\s*10px;[^}]*padding:\s*1px 6px;[^}]*border-radius:\s*999px;[^}]*\}/s,
    "the shared count pill should use the landing page's quiet rounded treatment",
  );
  assert.doesNotMatch(
    styles,
    /\.tooltip-column-title|\.tooltip-status-label|\.tooltip-column-header|\.tooltip-status-header|\.tooltip-section-header-primary/,
    "the stylesheet should not define split or primary-only tooltip header classes",
  );
});

test("internal system agents are hidden from the My Agents grid", () => {
  const source = readRepoFile("electron-app/src/renderer/components/agents.js");

  assert.match(source, /const SYSTEM_AGENT_PREFIX = "portico_agent_";/);
  assert.match(
    source,
    /state\.myAgents = state\.myAgents\.filter\(\s*\(agent\) => !String\(agent\.id \|\| ""\)\.startsWith\(SYSTEM_AGENT_PREFIX\),\s*\);/s,
    "loadMyAgents should filter out portico_agent_-prefixed system agents after normalizing raw records",
  );
});

// The former "agent creator identity ..." and "agent saves are strictly
// local ..." tests lived here as SOURCE-PIN tests (regexes over agents.js
// source). Source pins are banned (AGENTS.md "Testing Rules"); the coverage
// moved to behavioral homes:
// - creator identity on create (no created_by_email sent, restricted creates
//   fail closed without a usable authenticated email), card-click routing
//   (installed/foreign → read-only page, owned/unlinked → editor), and
//   local-only saves (no sync opt-in markup, update-only IPC, markLinkDirty
//   on linked saves): agents-tab-overhaul.unit.test.js.
// - author badge rendering + identity normalization on cards:
//   agents-tab-overhaul-v2.unit.test.js (badge matrix + agentOwnedByViewer).
// - "Author" identity row on the read-only pages:
//   agents-skill-freshness.unit.test.js (read-only view tests).

test("startup_failed is a terminal-error stage with logs action and wrapped detail", () => {
  const controlPlaneSource = readRepoFile(
    "electron-app/src/renderer/components/control-plane.js",
  );
  const styles = readRepoFile("electron-app/src/styles.css");

  assert.match(
    controlPlaneSource,
    /\['failed', 'startup_failed', 'timeout', 'not_running', 'error'\]\.includes\(/,
  );
  // Failure rows wrap the detail (3-line clamp) instead of ellipsizing the
  // sentence mid-word; active rows keep the single-line treatment.
  assert.match(
    styles,
    /\.loading-progress-row\.terminal-error \.loading-progress-row-detail \{[^}]*white-space: normal;[^}]*-webkit-line-clamp: 3;/s,
  );
});
