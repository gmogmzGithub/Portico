const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const stylesPath = path.join(repoRoot, 'electron-app', 'src', 'styles.css');
const mcpConfigModalPath = path.join(
  repoRoot,
  'electron-app',
  'src',
  'renderer',
  'components',
  'mcp-config-modal.js',
);
const mcpConfigParserPath = path.join(
  repoRoot,
  'electron-app',
  'src',
  'renderer',
  'components',
  'mcp-config-markdown-parser.js',
);
const mcpConfigGuidancePath = path.join(
  repoRoot,
  'electron-app',
  'src',
  'renderer',
  'components',
  'mcp-config-guidance.js',
);
const accordionVisibilityPath = path.join(
  repoRoot,
  'electron-app',
  'src',
  'renderer',
  'components',
  'accordion-visibility.js',
);
const configurationGuidancePath = path.join(
  repoRoot,
  'electron-app',
  'src',
  'renderer',
  'components',
  'configuration-guidance.js',
);
const indexHtmlPath = path.join(repoRoot, 'electron-app', 'src', 'renderer', 'views', 'index.html');
const toolConfigModalPath = path.join(
  repoRoot,
  'electron-app',
  'src',
  'renderer',
  'components',
  'tool-config-modal.js',
);
const indexJsPath = path.join(
  repoRoot,
  'electron-app',
  'src',
  'renderer',
  'views',
  'index.js',
);
const backendModalListenersPath = path.join(
  repoRoot,
  'electron-app',
  'src',
  'renderer',
  'components',
  'backend-modal-listeners.js',
);
const ipcPath = path.join(repoRoot, 'electron-app', 'src', 'services', 'ipc.js');

test('Darwin MCP config modal stays on the centered large-modal overlay path', () => {
  const stylesSource = fs.readFileSync(stylesPath, 'utf8');

  assert.match(
    stylesSource,
    /\.platform-darwin\s+#mcp-config-modal,\s*\.platform-darwin\s+#log-viewer-modal,\s*\.platform-darwin\s+#tool-config-modal\s*\{[^}]*align-items:\s*center;[^}]*padding-top:\s*0;[^}]*padding-bottom:\s*0;[^}]*\}/s,
    'the MCP config modal should share the centered Darwin overlay treatment with the other corrected large modals',
  );
  assert.doesNotMatch(
    stylesSource,
    /\.platform-darwin\s+#mcp-config-modal\s*\{[^}]*align-items:\s*flex-start;[^}]*\}/s,
    'the MCP config modal should no longer use the top-aligned Darwin overlay treatment',
  );
});

test('actionable new-chat guidance gets compact responsive sizing without changing form or testing workspaces', () => {
  const stylesSource = fs.readFileSync(stylesPath, 'utf8');
  const modalSource = fs.readFileSync(mcpConfigModalPath, 'utf8');

  assert.match(
    modalSource,
    /function setMcpConfigChatHandoffPresentation\(enabled\)[\s\S]*classList\.toggle\('chat-handoff', isChatHandoff\)[\s\S]*saveBtn\.hidden = isChatHandoff;/s,
  );
  assert.match(
    modalSource,
    /parser\.hasActionableNewChatControl\?\.\(\s*mcpConfigState\.setupMarkdown,\s*mcpConfigState\.envVars,\s*\) === true/s,
  );
  assert.match(
    stylesSource,
    /\.modal-overlay \.mcp-config-modal\.chat-handoff:not\(\.testing-expanded\)\s*\{[^}]*width:\s*min\(720px, calc\(100vw - 32px\)\);[^}]*height:\s*auto;[^}]*max-height:\s*min\(640px, calc\(100vh - 48px\)\);/s,
  );
  assert.match(
    stylesSource,
    /\.modal-overlay \.mcp-config-modal\.chat-handoff:not\(\.testing-expanded\) \.mcp-config-body\s*\{[^}]*flex:\s*0 1 auto;[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s,
  );
  assert.match(
    stylesSource,
    /\.modal-overlay \.mcp-config-modal\.chat-handoff #mcp-config-save-btn\s*\{[^}]*display:\s*none;/s,
  );
  assert.doesNotMatch(
    stylesSource,
    /\.mcp-config-modal\.chat-handoff[^}]*#mcp-config-cancel-btn/s,
  );
  assert.match(
    stylesSource,
    /\.modal-overlay \.mcp-config-modal\s*\{[^}]*width:\s*900px;[^}]*height:\s*85vh;/s,
  );
  assert.match(
    stylesSource,
    /\.modal-overlay \.mcp-config-modal\.testing-expanded\s*\{[^}]*width:\s*1400px;/s,
  );
});

test('MCP config modal keeps badge suppression ahead of overlay release while closing', () => {
  const source = fs.readFileSync(mcpConfigModalPath, 'utf8');
  const closeStart = source.indexOf('function closeMcpConfigModal(options = {}) {');
  const closeBlock = source.slice(
    closeStart,
    source.indexOf('// Attach event listeners', closeStart),
  );

  assert.match(
    closeBlock,
    /window\.suppressMcpBadgeTooltip\?\.\(\{\s*untilPointerMove:\s*true\s*\}\);\s*modal\.classList\.remove\('visible'\);\s*window\.setNativeOverlayInteractionSuppressed\?\.\('mcp-config-modal',\s*false\);/s,
    'MCP config modal close should suppress the badge tooltip before hiding the modal and releasing overlay suppression',
  );
});

test('MCP config promotion hands readiness ownership to the authoritative operation', () => {
  const source = fs.readFileSync(mcpConfigModalPath, 'utf8');
  const promoteStart = source.indexOf('async function promoteToProduction() {');
  const promoteBlock = source.slice(
    promoteStart,
    source.indexOf('// Close the modal', promoteStart),
  );

  assert.match(
    promoteBlock,
    /setConfigFinalizing\(true\);\s*window\.McpOperationOverlayController\?\.acceptSnapshot\?\.\(toggleResult\);/s,
    'successful config promotes should immediately adopt the authoritative operation snapshot',
  );
  assert.doesNotMatch(
    promoteBlock,
    /markMcpServerPostSuccessStarting|refreshServerAfterOperation|configured and enabled successfully/,
    'config promotion must not start a competing readiness loop or claim success before the authoritative operation finishes',
  );
});

test('MCP configuration saved-secret warnings use theme tokens and keep true failures red', () => {
  const stylesSource = fs.readFileSync(stylesPath, 'utf8');
  const modalSource = fs.readFileSync(mcpConfigModalPath, 'utf8');

  assert.match(
    stylesSource,
    /\.mcp-config-test-warning\s*\{[^}]*background:\s*var\(--status-warning-bg\);[^}]*border:\s*1px solid var\(--status-warning-border\);/s,
  );
  assert.match(
    stylesSource,
    /\.mcp-config-test-warning-title\s*\{[^}]*color:\s*var\(--status-warning\);/s,
  );
  assert.match(
    stylesSource,
    /\.mcp-config-test-error\s*\{[^}]*rgba\(248, 113, 113, 0\.1\)[^}]*rgba\(248, 113, 113, 0\.3\)/s,
  );
  assert.match(
    modalSource,
    /configurationIssue === 'saved_secret_unavailable'[\s\S]*renderTestingWarning\(warning\);/s,
  );
  assert.match(
    modalSource,
    /function renderTestingError\(errorMessage\)[\s\S]*mcp-config-test-error/s,
  );
});

test('MCP configuration testing revalidates OAuth before saving or starting a test server', () => {
  const source = fs.readFileSync(mcpConfigModalPath, 'utf8');
  const saveStart = source.indexOf("newSaveBtn.addEventListener('click', async () => {");
  const saveBlock = source.slice(
    saveStart,
    source.indexOf("if (testingCloseBtn)", saveStart),
  );
  const testStart = source.indexOf('async function startServerTest(options = {}) {');
  const testBlock = source.slice(
    testStart,
    source.indexOf('// Resolve the single-server MCPO base URL', testStart),
  );

  assert.match(
    source,
    /async function ensureMcpConfigOAuthReady\(\) \{[\s\S]*checkOAuthTokensExist\?\.\(mcpConfigState\.serverId\)[\s\S]*markMcpServerOAuthUnauthenticated\?\.\(mcpConfigState\.serverId\)[\s\S]*must be authenticated before configuration can be tested/s,
  );
  assert.match(
    saveBlock,
    /const oauthReady = await ensureMcpConfigOAuthReady\(\);[\s\S]*if \(oauthReady\) \{[\s\S]*const saved = await validateAndSave\(\);[\s\S]*startServerTest\(\{ skipOAuthCheck: true \}\)/s,
  );
  assert.match(
    testBlock,
    /if \(!options\.skipOAuthCheck && !\(await ensureMcpConfigOAuthReady\(\)\)\) \{\s*return false;/s,
  );
});

test('single-server Save & Test preflights unavailable saved secrets before Docker setup', () => {
  const ipcSource = fs.readFileSync(ipcPath, 'utf8');
  const handlerStart = ipcSource.indexOf(
    'ipcMain.handle("start-single-mcp-server"',
  );
  const handlerEnd = ipcSource.indexOf(
    '// Stop single MCP server',
    handlerStart,
  );
  const handler = ipcSource.slice(handlerStart, handlerEnd);
  const preflightIndex = handler.indexOf(
    'const preflightIssue = detectToggleEnablePreflightIssue(serverId',
  );
  const leaseIndex = handler.indexOf(
    'await acquireMcpMutationLeaseWithWait(',
  );
  const orphanCleanupIndex = handler.indexOf(
    'cleanupOrphanedSingleServerStack',
  );
  const dockerStartIndex = handler.indexOf('const runStartAttempt = () =>');

  assert.ok(preflightIndex >= 0);
  assert.ok(leaseIndex > preflightIndex);
  assert.ok(orphanCleanupIndex > preflightIndex);
  assert.ok(dockerStartIndex > preflightIndex);
  assert.match(
    handler.slice(preflightIndex, leaseIndex),
    /state:\s*"configuration_required"[\s\S]*configurationIssue:[\s\S]*requiresSecretReplacement:\s*savedSecretUnavailable/,
  );
  assert.match(
    handler.slice(preflightIndex, leaseIndex),
    /severity:\s*preflightIssue\.severity \|\| "warning"[\s\S]*if \(preflightIssue\) \{[\s\S]*state:\s*"failed"/,
    'malformed YAML and other fatal preflight errors must stop before Docker setup and retain error severity',
  );
  assert.match(
    handler,
    /startupClassification === "saved_secret_unavailable"[\s\S]*buildSavedSecretUnavailableIssue\(serverId\)/,
  );
});

test('post-config startup priming marks the server configured before backend health catches up', () => {
  const source = fs.readFileSync(
    path.join(
      repoRoot,
      'electron-app',
      'src',
      'renderer',
      'components',
      'mcp-servers.js',
    ),
    'utf8',
  );
  const helperStart = source.indexOf('function markMcpServerPostSuccessStarting(serverId, options = {}) {');
  const helperBlock = source.slice(
    helperStart,
    source.indexOf('function clearPendingServerOperation(serverId) {', helperStart),
  );

  assert.match(
    helperBlock,
    /if \(server\) \{\s*server\.isConfigured = true;\s*\}/s,
    'post-success startup priming should immediately mark the in-memory server metadata as configured',
  );
  assert.match(
    helperBlock,
    /healthStatus\.servers\[serverId\] = \{[\s\S]*configured:\s*true,[\s\S]*status:\s*stage === "checking" \? "checking" : "starting"/s,
    'post-success startup priming should stamp the local health snapshot as configured and starting or checking',
  );
});

test('MCP config modal uses a shared state initializer for open and close resets', () => {
  const source = fs.readFileSync(mcpConfigModalPath, 'utf8');
  const closeStart = source.indexOf('function closeMcpConfigModal(options = {}) {');
  const closeBlock = source.slice(
    closeStart,
    source.indexOf('// Attach event listeners', closeStart),
  );

  assert.match(
    source,
    /function createInitialMcpConfigState\(overrides = \{\}\) \{[\s\S]*presetVars:\s*\[\],[\s\S]*reason:\s*null,[\s\S]*launchSource:\s*'manual',[\s\S]*\.\.\.overrides,[\s\S]*\}/s,
    'the MCP config modal should define a single initializer that covers preset vars and modal reason state',
  );
  assert.match(
    source,
    /var mcpConfigState = createInitialMcpConfigState\(\);/,
    'the MCP config modal should initialize module state through the shared initializer without a TDZ-prone let binding',
  );
  assert.match(
    source,
    /function getMcpConfigGuidanceApi\(\)\s*\{[\s\S]*window\.McpConfigGuidance[\s\S]*typeof require === 'function'[\s\S]*require\('\.\/mcp-config-guidance'\)[\s\S]*throw new Error\('McpConfigGuidance is not available'\);[\s\S]*\}/s,
    'the MCP config modal should prefer the browser-global guidance helper and only fall back to require in test contexts',
  );
  assert.match(
    source,
    /mcpConfigState = createInitialMcpConfigState\(\{[\s\S]*serverId,[\s\S]*reason:\s*options\.reason \|\| null,[\s\S]*launchSource:\s*getMcpConfigLaunchSource\(options\),[\s\S]*\}\);/s,
    'opening the MCP config modal should reset state through the shared initializer',
  );
  assert.match(
    source,
    /function getMcpConfigLaunchSource\(options = \{\}\) \{[\s\S]*options\.launchSource === 'backend-requested'[\s\S]*'manual'[\s\S]*\}/s,
    'the MCP config modal should normalize the launch source through a dedicated helper',
  );
  assert.match(
    source,
    /mcpConfigState = createInitialMcpConfigState\(\{[\s\S]*launchSource:\s*getMcpConfigLaunchSource\(options\),[\s\S]*\}\);/s,
    'opening the MCP config modal should persist the normalized launch source in modal state',
  );
  assert.match(
    closeBlock,
    /mcpConfigState = createInitialMcpConfigState\(\);/,
    'closing the MCP config modal should reset state through the shared initializer',
  );
});

test('guided setup opens the MCP config modal in backend-requested launch mode and the overlay safety net tracks the modal roots', () => {
  const indexSource = fs.readFileSync(indexJsPath, 'utf8');
  const backendModalListenersSource = fs.readFileSync(backendModalListenersPath, 'utf8');

  assert.match(
    indexSource,
    /'tool-config-modal': '#tool-config-modal\.visible',\s*'mcp-config-modal': '#mcp-config-modal\.visible'/s,
    'overlay suppression safety checks should watch the modal overlay roots, not the inner modal cards',
  );
  assert.match(
    backendModalListenersSource,
    /await window\.openMcpConfigModal\(server_id,\s*null,\s*\{[\s\S]*reason,[\s\S]*launchSource:\s*"backend-requested"[\s\S]*\}\);/s,
    'LLM-triggered guided setup should tag MCP config modal opens as backend-requested',
  );
});

test('MCP config guidance is exposed as a browser global and loaded before the modal', () => {
  const accordionVisibilitySource = fs.readFileSync(accordionVisibilityPath, 'utf8');
  const configurationGuidanceSource = fs.readFileSync(configurationGuidancePath, 'utf8');
  const mcpConfigGuidanceSource = fs.readFileSync(mcpConfigGuidancePath, 'utf8');
  const indexHtmlSource = fs.readFileSync(indexHtmlPath, 'utf8');

  assert.match(
    accordionVisibilitySource,
    /\(function \(root,\s*factory\)\s*\{[\s\S]*root\.AccordionVisibility = accordionVisibilityApi;[\s\S]*\}\)\(typeof globalThis !== 'undefined' \? globalThis : this,\s*function createAccordionVisibilityApi\(\)/s,
    'accordion visibility should publish a browser global for script-tag consumers without leaking top-level names into the shared script scope',
  );
  assert.match(
    configurationGuidanceSource,
    /\(function \(root,\s*factory\)\s*\{[\s\S]*root\.ConfigurationGuidance = configurationGuidanceApi;[\s\S]*\}\)\(typeof globalThis !== 'undefined' \? globalThis : this,\s*function createConfigurationGuidanceApi\(\)/s,
    'shared configuration guidance should publish a browser global for script-tag consumers without colliding with other renderer helper scripts',
  );
  assert.match(
    mcpConfigGuidanceSource,
    /root\?\.ConfigurationGuidance\s*\|\|\s*\(typeof require === 'function' \? require\('\.\/configuration-guidance'\) : null\)/s,
    'MCP config guidance should consume the shared browser global and only fall back to require in Node/test contexts',
  );
  assert.match(
    mcpConfigGuidanceSource,
    /root\.McpConfigGuidance = api;/,
    'MCP config guidance should publish a browser-global API for the modal runtime',
  );
  assert.match(
    indexHtmlSource,
    /<script src="renderer\/components\/accordion-visibility\.js"><\/script>\s*<script src="renderer\/components\/configuration-guidance\.js"><\/script>\s*<script src="renderer\/components\/mcp-config-guidance\.js"><\/script>\s*<script src="renderer\/components\/mcp-config-markdown-parser\.js"><\/script>\s*<script src="renderer\/components\/mcp-config-modal\.js"><\/script>/s,
    'the main window should load the modal browser helpers before the MCP config markdown parser and modal scripts',
  );
});

test('MCP config browser helper scripts load cleanly together in one script-tag context', () => {
  const context = {
    console,
    module: undefined,
    exports: undefined,
    require: undefined,
  };
  context.window = context;
  context.globalThis = context;
  context.navigator = {};
  context.Node = { ELEMENT_NODE: 1 };
  context.document = {
    body: { style: {}, classList: { add() {}, remove() {}, toggle() {} } },
    createElement() {
      return {
        classList: { add() {}, remove() {}, contains() { return false; }, toggle() { return false; } },
        children: [],
        appendChild() {},
        insertBefore() {},
        removeChild() {},
        parentNode: null,
        parentElement: null,
        style: {},
      };
    },
    getElementById() {
      return null;
    },
    querySelector() {
      return null;
    },
    addEventListener() {},
    removeEventListener() {},
  };

  [
    accordionVisibilityPath,
    configurationGuidancePath,
    mcpConfigGuidancePath,
    mcpConfigParserPath,
    mcpConfigModalPath,
  ].forEach((filePath) => {
    vm.runInNewContext(fs.readFileSync(filePath, 'utf8'), context, {
      filename: path.basename(filePath),
    });
  });

  assert.equal(typeof context.AccordionVisibility?.scheduleExpandedAccordionVisibility, 'function');
  assert.equal(typeof context.ConfigurationGuidance?.createConfigurationGuidanceController, 'function');
  assert.equal(typeof context.McpConfigGuidance?.initializeMcpConfigGuidance, 'function');
  assert.equal(typeof context.McpConfigMarkdownParser?.parseMarkdownContent, 'function');
  assert.equal(typeof context.openMcpConfigModal, 'function');
});

test('MCP setup chat actions close only after a main or detached tab opens successfully', async () => {
  function createHarness() {
    const notifications = [];
    const removedClasses = [];
    const modal = {
      classList: {
        remove(name) {
          removedClasses.push(name);
        },
      },
    };
    const context = {
      console: { log() {}, warn() {}, error() {} },
      confirm: () => true,
      setTimeout,
      clearTimeout,
      Node: { ELEMENT_NODE: 1 },
      navigator: {},
      document: {
        body: { style: {} },
        getElementById(id) {
          return id === 'mcp-config-modal' ? modal : null;
        },
        querySelector() {
          return null;
        },
        addEventListener() {},
        removeEventListener() {},
      },
    };
    context.window = context;
    context.globalThis = context;
    context.McpConfigGuidance = {
      resetMcpConfigGuidance() {},
    };
    context.showNotification = (message, type) => {
      notifications.push({ message, type });
    };
    vm.runInNewContext(fs.readFileSync(mcpConfigModalPath, 'utf8'), context, {
      filename: path.basename(mcpConfigModalPath),
    });
    return { context, modal, notifications, removedClasses };
  }

  const mainHarness = createHarness();
  const mainRequests = [];
  mainHarness.context.openNewChatTab = (options) => {
    mainRequests.push(options);
    return true;
  };
  assert.equal(
    await mainHarness.context.openMcpConfigNewChat('  Help me set up Snowflake  '),
    true,
  );
  assert.equal(mainRequests.length, 1);
  assert.equal(mainRequests[0].prompt, 'Help me set up Snowflake');
  assert.deepEqual(mainHarness.removedClasses, ['visible']);

  const cappedHarness = createHarness();
  cappedHarness.context.openNewChatTab = () => {
    cappedHarness.context.showNotification(
      'Maximum of 5 tabs reached. Close some tabs first.',
      'warning',
    );
    return false;
  };
  assert.equal(
    await cappedHarness.context.openMcpConfigNewChat('Help me set up Snowflake'),
    false,
  );
  assert.deepEqual(cappedHarness.removedClasses, []);
  assert.deepEqual(cappedHarness.notifications, [{
    message: 'Maximum of 5 tabs reached. Close some tabs first.',
    type: 'warning',
  }]);

  const detachedHarness = createHarness();
  const detachedRequests = [];
  detachedHarness.context.electronAPI = {
    async requestOpenNewChatTab(options) {
      detachedRequests.push(options);
      return { success: true };
    },
  };
  assert.equal(
    await detachedHarness.context.openMcpConfigNewChat('Help me set up Snowflake'),
    true,
  );
  assert.equal(detachedRequests[0].prompt, 'Help me set up Snowflake');
  assert.deepEqual(detachedHarness.removedClasses, ['visible']);

  const failedDetachedHarness = createHarness();
  failedDetachedHarness.context.electronAPI = {
    async requestOpenNewChatTab() {
      return { success: false, error: 'Could not reach the main chat window.' };
    },
  };
  assert.equal(
    await failedDetachedHarness.context.openMcpConfigNewChat('Help me set up Snowflake'),
    false,
  );
  assert.deepEqual(failedDetachedHarness.removedClasses, []);
  assert.deepEqual(failedDetachedHarness.notifications, [{
    message: 'Could not reach the main chat window.',
    type: 'error',
  }]);
});

test('MCP setup chat button reuses theme-aware configuration action styling', () => {
  const stylesSource = fs.readFileSync(stylesPath, 'utf8');

  assert.match(
    stylesSource,
    /\.mcp-config-open-browser-btn,\s*\.mcp-config-new-chat-btn\s*\{[^}]*background:\s*var\(--accent-primary\);[^}]*border:\s*none;/s,
    'the new chat control should share the generated MCP action vocabulary',
  );
  assert.match(
    stylesSource,
    /\[data-theme="light"\]\s+\.mcp-config-open-browser-btn,\s*\[data-theme="light"\]\s+\.mcp-config-new-chat-btn,\s*\[data-theme="light"\]\s+\.mcp-config-copy-btn\s*\{[^}]*background:\s*#003a9b;[^}]*color:\s*#fff;/s,
    'the new chat control should use the existing light-theme action colors',
  );
  assert.match(
    stylesSource,
    /\.mcp-config-new-chat-btn:disabled\s*\{[^}]*cursor:\s*default;[^}]*opacity:\s*0\.55;/s,
    'the async launch control should expose a disabled in-flight state',
  );
});

test('MCP config modal reuses the wizard pulse hooks and compact confirmation styling', () => {
  const stylesSource = fs.readFileSync(stylesPath, 'utf8');
  const accordionAuraKeyframe = stylesSource.match(
    /@keyframes mcp-config-accordion-aura-pulse\s*\{[\s\S]*?\n\}/,
  )?.[0] || '';
  const confirmationAuraKeyframe = stylesSource.match(
    /@keyframes mcp-config-confirmation-aura-pulse\s*\{[\s\S]*?\n\}/,
  )?.[0] || '';

  assert.match(
    stylesSource,
    /\.mcp-config-body\s*\{[^}]*--mcp-config-surface-border:\s*var\(--border-default\);[^}]*--mcp-config-surface-border-subtle:\s*var\(--border-subtle\);[^}]*--mcp-config-surface-shadow:\s*var\(--shadow-sm\);[^}]*--mcp-config-guidance-accent-rgb:\s*var\(--accent-primary-rgb\);[^}]*--mcp-config-guidance-confirm-ring:\s*var\(--status-info-bg\);/s,
  );
  assert.match(
    stylesSource,
    /\[data-theme="dark"\]\s+\.mcp-config-body\s*\{[^}]*--mcp-config-guidance-confirm-ring:\s*rgba\(var\(--mcp-config-guidance-accent-rgb\),\s*0\.22\);[^}]*--mcp-config-guidance-save-halo:\s*rgba\(var\(--mcp-config-guidance-accent-rgb\),\s*0\.34\);[^}]*--mcp-config-guidance-aura-halo:\s*rgba\(var\(--mcp-config-guidance-accent-rgb\),\s*0\.26\);[^}]*--mcp-config-guidance-aura-border:\s*rgba\(var\(--mcp-config-guidance-accent-rgb\),\s*0\.42\);/s,
    'dark mode should strengthen the MCP config pulse treatment without affecting light mode overrides',
  );
  assert.match(
    stylesSource,
    /\[data-theme="light"\]\s+\.mcp-config-body\s*\{[^}]*--mcp-config-surface-border:\s*rgba\(0,\s*0,\s*0,\s*0\.08\);[^}]*--mcp-config-surface-border-subtle:\s*rgba\(0,\s*0,\s*0,\s*0\.03\);[^}]*--mcp-config-surface-shadow:\s*0 2px 8px rgba\(0,\s*0,\s*0,\s*0\.06\);/s,
  );
  assert.match(
    stylesSource,
    /#mcp-config-save-btn\.is-pulsing\s*\{[^}]*animation:\s*wizard-cta-pulse 1\.8s ease-in-out infinite;/s,
  );
  assert.match(
    stylesSource,
    /\.mcp-config-body\s+\.mcp-config-accordion\.is-guidance-pulsing\s*\{[^}]*animation:\s*mcp-config-accordion-aura-pulse 1\.9s ease-in-out infinite;[^}]*overflow:\s*visible;[^}]*position:\s*relative;[^}]*z-index:\s*1;/s,
  );
  assert.match(
    stylesSource,
    /\.mcp-config-body\s+\.mcp-config-accordion\.is-guidance-pulsing:hover,\s*\.mcp-config-body\s+\.mcp-config-accordion\.is-guidance-pulsing:focus-within\s*\{[^}]*animation-play-state:\s*paused;/s,
  );
  assert.match(
    stylesSource,
    /\.mcp-config-body\s+\.input-field\.is-input-guidance-pulsing\s*\{[^}]*animation:\s*wizard-input-guidance-pulse 1\.8s ease-in-out infinite;[^}]*transform:\s*none;[^}]*border-color:\s*var\(--input-focus-border\);/s,
  );
  assert.match(
    stylesSource,
    /\.mcp-config-body\s+\.mcp-config-accordion-header\s*\{[^}]*border-radius:\s*inherit;/s,
  );
  assert.match(
    stylesSource,
    /\.mcp-config-body\s+\.mcp-config-accordion:not\(\.collapsed\)\s+\.mcp-config-accordion-header\s*\{[^}]*border-bottom-left-radius:\s*0;[^}]*border-bottom-right-radius:\s*0;/s,
  );
  assert.match(
    stylesSource,
    /\.mcp-config-body\s+\.mcp-config-confirmation-card\.is-guidance-pulsing\s*\{[^}]*animation:\s*mcp-config-confirmation-aura-pulse 1\.9s ease-in-out infinite;[^}]*overflow:\s*visible;[^}]*position:\s*relative;[^}]*z-index:\s*1;/s,
  );
  assert.doesNotMatch(
    stylesSource,
    /\.mcp-config-body\s+\.mcp-config-confirmation-card\.is-guidance-pulsing:hover,\s*\.mcp-config-body\s+\.mcp-config-confirmation-card\.is-guidance-pulsing:focus-within\s*\{[^}]*animation-play-state:\s*paused;/s,
  );
  assert.match(
    stylesSource,
    /\.mcp-config-body\s+\.mcp-config-accordion\s*\{[^}]*border:\s*1px solid var\(--mcp-config-surface-border\);[^}]*box-shadow:\s*var\(--mcp-config-surface-shadow\);/s,
  );
  assert.match(
    stylesSource,
    /\.mcp-config-body\s+\.mcp-config-confirmation-card\s*\{[^}]*width:\s*min\(100%,\s*32rem\);[^}]*max-width:\s*32rem;/s,
  );
  assert.match(
    stylesSource,
    /\.mcp-config-body\s+\.mcp-config-confirmation-card\s*\{[^}]*border:\s*1px solid var\(--mcp-config-surface-border\);[^}]*box-shadow:\s*var\(--mcp-config-surface-shadow\);/s,
  );
  assert.doesNotMatch(
    stylesSource,
    /\.mcp-config-body\s+\.mcp-config-accordion\.is-guidance-pulsing\s*\{[^}]*animation:\s*wizard-accordion-pulse/s,
  );
  assert.doesNotMatch(
    stylesSource,
    /\.mcp-config-body\s+\.mcp-config-confirmation-card\.is-guidance-pulsing\s*\{[^}]*animation:\s*wizard-confirmation-pulse/s,
  );
  assert.match(
    stylesSource,
    /@keyframes wizard-cta-pulse\s*\{[\s\S]*?50%\s*\{[\s\S]*?transform:\s*scale\(1\.05\);[\s\S]*?box-shadow:\s*0 0 0 14px var\(--mcp-config-guidance-save-halo\);/s,
  );
  assert.match(
    stylesSource,
    /@keyframes mcp-config-accordion-aura-pulse\s*\{[\s\S]*?0%,\s*100%\s*\{[\s\S]*?box-shadow:\s*0 0 0 0 rgba\(var\(--mcp-config-guidance-accent-rgb\),\s*0\),\s*var\(--mcp-config-surface-shadow\);[\s\S]*?border-color:\s*var\(--mcp-config-surface-border\);[\s\S]*?50%\s*\{[\s\S]*?box-shadow:\s*0 0 0 10px var\(--mcp-config-guidance-aura-halo\),\s*var\(--mcp-config-surface-shadow\);[\s\S]*?border-color:\s*var\(--mcp-config-guidance-aura-border\);/s,
  );
  assert.match(
    stylesSource,
    /@keyframes mcp-config-confirmation-aura-pulse\s*\{[\s\S]*?50%\s*\{[\s\S]*?box-shadow:\s*0 0 0 3px var\(--mcp-config-guidance-confirm-ring\),\s*0 0 0 10px var\(--mcp-config-guidance-aura-halo\),\s*var\(--mcp-config-surface-shadow\);/s,
  );
  assert.match(
    accordionAuraKeyframe,
    /border-color:/,
  );
  assert.doesNotMatch(
    confirmationAuraKeyframe,
    /border-color:/,
  );
  assert.doesNotMatch(
    accordionAuraKeyframe,
    /transform:/,
  );
  assert.doesNotMatch(
    confirmationAuraKeyframe,
    /transform:/,
  );
  assert.match(
    stylesSource,
    /@keyframes wizard-input-guidance-pulse\s*\{[\s\S]*?50%\s*\{[\s\S]*?box-shadow:\s*0 0 0 3px var\(--mcp-config-guidance-confirm-ring\),\s*0 0 0 10px var\(--mcp-config-guidance-aura-halo\);/s,
  );
});

test('MCP config modal initializes collapsed accordions and guidance callbacks through the markdown parser', () => {
  const modalSource = fs.readFileSync(mcpConfigModalPath, 'utf8');
  const parserSource = fs.readFileSync(mcpConfigParserPath, 'utf8');
  const guidanceSource = fs.readFileSync(mcpConfigGuidancePath, 'utf8');

  assert.match(
    modalSource,
    /parser\.attachEventListeners\(contentEl,\s*\{[\s\S]*startCollapsed:\s*true,[\s\S]*onToggle:\s*\(details\)\s*=>\s*getMcpConfigGuidanceApi\(\)\.handleMcpConfigAccordionToggle\(details,\s*guidanceCallbacks\),[\s\S]*refreshGuidance:\s*\(\)\s*=>\s*getMcpConfigGuidanceApi\(\)\.refreshMcpConfigGuidance\(guidanceCallbacks\),[\s\S]*scrollContainer:\s*\(\)\s*=>\s*getMcpConfigScrollContainer\(\),/s,
  );
  assert.match(
    parserSource,
    /root\?\.AccordionVisibility[\s\S]*typeof require === 'function' \? require\('\.\/accordion-visibility'\) : null[\s\S]*\|\|\s*\{\}/s,
  );
  assert.match(
    parserSource,
    /const startCollapsed = options\.startCollapsed !== false;/,
  );
  assert.match(
    parserSource,
    /const autoExpandFirst = options\.autoExpandFirst === true;/,
  );
  assert.match(
    parserSource,
    /scheduleExpandedAccordionVisibility\(accordion,\s*\{[\s\S]*scrollContainer:\s*options\.scrollContainer,/s,
  );
  assert.match(
    parserSource,
    /if \(autoExpandFirst && startCollapsed && createdAccordions\.length > 0\) \{[\s\S]*const firstAccordion = createdAccordions\[0\];[\s\S]*firstAccordion\.header\.onclick\(\);/s,
  );
  assert.match(
    parserSource,
    /createAccordionsForMcpConfig\(afterContent,\s*\{[\s\S]*startCollapsed:\s*true,[\s\S]*autoExpandFirst:\s*true,[\s\S]*onToggle:\s*options\.onToggle,[\s\S]*scrollContainer:\s*options\.scrollContainer,/s,
  );
  assert.match(
    guidanceSource,
    /const MCP_CONFIG_INPUT_PULSE_CLASS = 'is-input-guidance-pulsing';/,
  );
  assert.match(
    guidanceSource,
    /event\.target\.classList\?\.remove\?\.\(MCP_CONFIG_INPUT_PULSE_CLASS\);/,
  );
  assert.match(
    guidanceSource,
    /focusedInputId:\s*focusedInput\?\.id \|\| null,/,
  );
  assert.match(
    guidanceSource,
    /function focusMcpConfigAccordionInput\(accordion,\s*doc = globalThis\.document\) \{/,
  );
});

test('tool config modal keeps badge suppression ahead of overlay release while closing', () => {
  const source = fs.readFileSync(toolConfigModalPath, 'utf8');
  const closeStart = source.indexOf('function closeToolsModal() {');
  const closeBlock = source.slice(
    closeStart,
    source.indexOf('function toggleModalMaximize() {', closeStart),
  );

  assert.match(
    closeBlock,
    /window\.suppressMcpBadgeTooltip\?\.\(\{\s*untilPointerMove:\s*true\s*\}\);\s*modal\.classList\.remove\("visible"\);\s*window\.setNativeOverlayInteractionSuppressed\?\.\("tool-config-modal",\s*false\);/s,
    'tool config modal close should suppress the badge tooltip before hiding the modal and releasing overlay suppression',
  );
});
