const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const McpServerRequirements = require('./guided-setup/server-requirements');
const McpConfigMarkdownParser = require('../renderer/components/mcp-config-markdown-parser');

class FakeClassList {
  constructor(initial = []) {
    this.classes = new Set(initial);
  }

  add(...names) {
    names.filter(Boolean).forEach((name) => this.classes.add(name));
  }

  remove(...names) {
    names.filter(Boolean).forEach((name) => this.classes.delete(name));
  }

  toggle(name, force) {
    if (force === true) {
      this.classes.add(name);
      return true;
    }
    if (force === false) {
      this.classes.delete(name);
      return false;
    }
    if (this.classes.has(name)) {
      this.classes.delete(name);
      return false;
    }
    this.classes.add(name);
    return true;
  }

  contains(name) {
    return this.classes.has(name);
  }

  toString() {
    return [...this.classes].join(' ');
  }
}

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.classList = new FakeClassList();
    this.style = {};
    this.dataset = {};
    this.value = '';
    this.placeholder = '';
    this.type = 'text';
    this.disabled = false;
    this.hidden = false;
    this.innerHTML = '';
    this.textContent = '';
    this.listeners = new Map();
    this.onclick = null;
    this.parentNode = null;
    this.parentElement = null;
  }

  get className() {
    return this.classList.toString();
  }

  set className(value) {
    this.classList = new FakeClassList(
      String(value || '')
        .split(/\s+/)
        .filter(Boolean),
    );
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    this.listeners.set(
      type,
      handlers.filter((item) => item !== handler),
    );
  }

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }

  cloneNode() {
    const clone = new FakeElement(this.id);
    clone.className = this.className;
    clone.style = { ...this.style };
    clone.dataset = { ...this.dataset };
    clone.value = this.value;
    clone.disabled = this.disabled;
    clone.hidden = this.hidden;
    clone.innerHTML = this.innerHTML;
    clone.textContent = this.textContent;
    return clone;
  }

  async click(event = {}) {
    const handlers = this.listeners.get('click') || [];
    for (const handler of handlers) {
      await handler({
        currentTarget: this,
        target: this,
        preventDefault() {},
        stopPropagation() {},
        ...event,
      });
    }

    if (typeof this.onclick === 'function') {
      await this.onclick({
        currentTarget: this,
        target: this,
        preventDefault() {},
        stopPropagation() {},
        ...event,
      });
    }
  }
}

function buildHarness(options = {}) {
  const sourcePath = path.join(
    __dirname,
    '..',
    'renderer',
    'components',
    'mcp-config-modal.js',
  );
  const source = `${fs.readFileSync(sourcePath, 'utf8')}
window.__mcpConfigModalTestHooks = {
  applyStoredSensitiveFieldState,
  attachModalEventListeners,
  closeMcpConfigModal,
  createInitialMcpConfigState,
  ensureMcpConfigOAuthReady,
  mcpConfigReadinessTimeoutMs,
  openMcpConfigNewChat,
  openMcpConfigModal,
  renderTestingWarning,
  startServerTest,
  validateAndSave,
  getState() {
    return mcpConfigState;
  },
};
`;

  const elements = new Map();
  const documentListeners = new Map();
  const notifications = [];
  const uiNotifications = [];
  const oauthUnauthenticatedCalls = [];
  const suppressionCalls = [];
  const startSingleMcpServerArgs = [];
  const stopSingleMcpServerArgs = [];
  const upsertRuntimeSecretArgs = [];
  const openNewChatTabArgs = [];
  let checkSingleMcpServerCalls = 0;
  let startSingleMcpServerCalls = 0;

  const ensureElement = (id, className = '') => {
    if (!elements.has(id)) {
      const element = new FakeElement(id);
      if (className) {
        element.className = className;
      }
      elements.set(id, element);
    }
    return elements.get(id);
  };

  [
    ['mcp-config-modal', 'modal-overlay'],
    ['mcp-config-modal-content', 'modal-content mcp-config-modal'],
    ['mcp-config-main', 'mcp-config-main'],
    ['mcp-config-body', 'modal-body mcp-config-body'],
    ['mcp-config-content'],
    ['mcp-config-close-btn'],
    ['mcp-config-cancel-btn'],
    ['mcp-config-save-btn'],
    ['mcp-config-testing-close-btn'],
    ['mcp-config-retry-btn'],
    ['mcp-config-promote-btn'],
    ['mcp-config-testing-content'],
    ['mcp-config-server-icon', 'mcp-config-server-icon'],
    ['mcp-config-title', 'mcp-config-title'],
    ['mcp-config-subtitle', 'mcp-config-subtitle'],
    ['mcp-config-finalizing'],
    ['mcp-config-divider'],
    ['mcp-config-test-recovery-chat-btn'],
  ].forEach(([id, className]) => ensureElement(id, className));

  const buttonIds = [
    'mcp-config-close-btn',
    'mcp-config-cancel-btn',
    'mcp-config-save-btn',
    'mcp-config-testing-close-btn',
    'mcp-config-retry-btn',
    'mcp-config-promote-btn',
  ];

  for (const id of buttonIds) {
    const parentNode = {
      replaceChild(newChild, oldChild) {
        newChild.parentNode = parentNode;
        newChild.parentElement = parentNode;
        elements.set(oldChild.id, newChild);
      },
    };
    const element = ensureElement(id);
    element.parentNode = parentNode;
    element.parentElement = parentNode;
  }

  const modal = ensureElement('mcp-config-modal');
  const modalContent = ensureElement('mcp-config-modal-content');
  const configContent = ensureElement('mcp-config-content');
  const configInputs = options.configInputs || [];
  configContent.querySelectorAll = (selector) => (
    selector === '.input-field' ? configInputs : []
  );
  modal.querySelector = (selector) => (
    selector === '.mcp-config-modal' ? modalContent : null
  );

  const selectorMap = {
    '.mcp-config-modal': modalContent,
    '.mcp-config-main': ensureElement('mcp-config-main'),
    '.mcp-config-body': ensureElement('mcp-config-body'),
    '.mcp-config-server-icon': ensureElement('mcp-config-server-icon'),
    '.mcp-config-title': ensureElement('mcp-config-title'),
    '.mcp-config-subtitle': ensureElement('mcp-config-subtitle'),
  };

  const testSteps = new Map();
  for (const stepId of ['start', 'health', 'tools']) {
    const step = new FakeElement(`test-step-${stepId}`);
    const icon = new FakeElement(`test-step-${stepId}-icon`);
    const detail = new FakeElement(`test-step-${stepId}-detail`);
    icon.className = 'mcp-config-test-icon pending';
    detail.className = 'mcp-config-test-detail';
    step.querySelector = (selector) => {
      if (selector === '.mcp-config-test-icon') return icon;
      if (selector === '.mcp-config-test-detail') return detail;
      return null;
    };
    testSteps.set(stepId, { step, icon, detail });
    selectorMap[`.mcp-config-test-step[data-step="${stepId}"]`] = step;
  }

  const document = {
    getElementById(id) {
      return elements.get(id) || null;
    },
    querySelector(selector) {
      return selectorMap[selector] || null;
    },
    addEventListener(type, handler) {
      if (!documentListeners.has(type)) {
        documentListeners.set(type, []);
      }
      documentListeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const handlers = documentListeners.get(type) || [];
      documentListeners.set(
        type,
        handlers.filter((item) => item !== handler),
      );
    },
  };

  const context = {
    console,
    confirm: () => true,
    document,
    window: {
      appState: {
        servers: [
          {
            id: 'gitlab',
            display_name: 'GitLab',
            requiredVars: [],
            presetVars: [],
            ...options.server,
          },
        ],
      },
      McpServerRequirements,
      McpConfigMarkdownParser: options.markdownParser || null,
      McpConfigGuidance: {
        clearMcpConfigPulseState() {},
        initializeMcpConfigGuidance() {},
        refreshMcpConfigGuidance() {},
        resetMcpConfigGuidance() {},
      },
      electronAPI: {
        async notifyGuidedSetupCompleted(
          serverId,
          outcome,
          flowId = null,
          details = {},
        ) {
          notifications.push({ serverId, outcome, flowId, details });
        },
        async readEnvFile() {
          return {
            success: true,
            content: options.envContent || '',
          };
        },
        async writeEnvFile(content) {
          if (typeof options.writeEnvFile === 'function') {
            return options.writeEnvFile(content);
          }
          return { success: true };
        },
        async getMcpSensitiveSecretPresence() {
          return {
            success: true,
            presence: options.secretPresence || {},
          };
        },
        async upsertRuntimeSecret(key, value) {
          upsertRuntimeSecretArgs.push({ key, value });
          return { success: true };
        },
        async checkOAuthTokensExist() {
          return { exists: options.hasOAuthTokens === true };
        },
        async startSingleMcpServer(serverId, startOptions) {
          startSingleMcpServerCalls += 1;
          startSingleMcpServerArgs.push({ serverId, options: startOptions });
          if (typeof options.startSingleMcpServer === 'function') {
            return options.startSingleMcpServer(serverId, startOptions);
          }
          return { success: true, sessionId: 'test-session' };
        },
        async stopSingleMcpServer(serverId, stopOptions) {
          stopSingleMcpServerArgs.push({ serverId, options: stopOptions });
          return { success: true };
        },
        async checkSingleMcpServer(serverId, checkOptions) {
          checkSingleMcpServerCalls += 1;
          if (typeof options.checkSingleMcpServer === 'function') {
            return options.checkSingleMcpServer(serverId, checkOptions);
          }
          return {
            success: true,
            state: 'healthy',
            healthy: true,
            tools: ['tool'],
          };
        },
        async getSingleMcpServerBaseUrl() {
          return { success: true, baseUrl: 'http://localhost:8770' };
        },
        async getWizardMcpServerLogs() {
          return { success: true, logs: '' };
        },
      },
      openNewChatTab(optionsValue) {
        openNewChatTabArgs.push(optionsValue);
        return options.openNewChatTabResult !== false;
      },
      setNativeOverlayInteractionSuppressed(reason, suppressed) {
        suppressionCalls.push({ reason, suppressed });
      },
      markMcpServerOAuthUnauthenticated(serverId) {
        oauthUnauthenticatedCalls.push(serverId);
      },
      suppressMcpBadgeTooltip() {},
      addEventListener() {},
      removeEventListener() {},
      showNotification(message, type) {
        uiNotifications.push({ message, type });
      },
    },
    setTimeout,
    clearTimeout,
  };

  vm.runInNewContext(source, context, { filename: sourcePath });

  return {
    elements,
    testSteps,
    notifications,
    uiNotifications,
    oauthUnauthenticatedCalls,
    suppressionCalls,
    hooks: context.window.__mcpConfigModalTestHooks,
    window: context.window,
    getStartSingleMcpServerCalls() {
      return startSingleMcpServerCalls;
    },
    getCheckSingleMcpServerCalls() {
      return checkSingleMcpServerCalls;
    },
    startSingleMcpServerArgs,
    stopSingleMcpServerArgs,
    upsertRuntimeSecretArgs,
    openNewChatTabArgs,
    async dispatchKeydown(key) {
      const handlers = documentListeners.get('keydown') || [];
      for (const handler of handlers) {
        await handler({
          key,
          prevented: false,
          stopped: false,
          preventDefault() {
            this.prevented = true;
          },
          stopPropagation() {
            this.stopped = true;
          },
        });
      }
    },
  };
}

test('manual MCP config launches default to manual mode and Escape dismisses the modal', async () => {
  const harness = buildHarness();
  const modal = harness.elements.get('mcp-config-modal');

  await harness.hooks.openMcpConfigModal('gitlab');

  assert.equal(harness.hooks.getState().launchSource, 'manual');
  assert.equal(modal.classList.contains('visible'), true);

  await harness.dispatchKeydown('Escape');

  assert.equal(modal.classList.contains('visible'), false);
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].serverId, 'gitlab');
  assert.equal(harness.notifications[0].outcome, 'dismissed');
  assert.equal(harness.notifications[0].flowId, null);
  assert.equal(Object.keys(harness.notifications[0].details).length, 0);
  assert.deepEqual(harness.suppressionCalls, [
    { reason: 'mcp-config-modal', suppressed: true },
    { reason: 'mcp-config-modal', suppressed: false },
  ]);
});

test('actionable new-chat guidance uses compact handoff presentation and resets for normal configuration', async () => {
  const harness = buildHarness({
    markdownParser: McpConfigMarkdownParser,
    server: {
      id: 'snowflake',
      display_name: 'Snowflake',
      setupMarkdown: [
        '# Snowflake MCP Configuration',
        '<new-chat prompt="Help me set up Snowflake" label="Set up Snowflake in chat" />',
      ].join('\n'),
    },
  });
  const modalContent = harness.elements.get('mcp-config-modal-content');

  await harness.hooks.openMcpConfigModal('snowflake');

  assert.equal(modalContent.classList.contains('chat-handoff'), true);
  assert.equal(
    harness.hooks.getState().hasActionableNewChatControl,
    true,
  );
  assert.equal(harness.elements.get('mcp-config-save-btn').hidden, true);
  assert.equal(harness.elements.get('mcp-config-cancel-btn').hidden, false);

  harness.window.appState.servers[0].setupMarkdown =
    '# Snowflake Manual Configuration\nEnter the required values below.';
  await harness.hooks.openMcpConfigModal('snowflake');

  assert.equal(modalContent.classList.contains('chat-handoff'), false);
  assert.equal(
    harness.hooks.getState().hasActionableNewChatControl,
    false,
  );
  assert.equal(harness.elements.get('mcp-config-save-btn').hidden, false);
  assert.equal(harness.elements.get('mcp-config-cancel-btn').hidden, false);
});

test('backend-requested MCP config launches block implicit dismissal but keep explicit close controls', async () => {
  const harness = buildHarness();
  const modal = harness.elements.get('mcp-config-modal');

  await harness.hooks.openMcpConfigModal('gitlab', null, {
    flowId: 'guided-setup-1',
    launchSource: 'backend-requested',
  });

  assert.equal(harness.hooks.getState().launchSource, 'backend-requested');
  await harness.dispatchKeydown('Escape');
  assert.equal(modal.classList.contains('visible'), true);
  assert.deepEqual(harness.notifications, []);

  await modal.onclick({ target: modal });
  assert.equal(modal.classList.contains('visible'), true);
  assert.deepEqual(harness.notifications, []);

  await harness.elements.get('mcp-config-close-btn').click();
  assert.equal(modal.classList.contains('visible'), false);
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].serverId, 'gitlab');
  assert.equal(harness.notifications[0].outcome, 'dismissed');
  assert.equal(harness.notifications[0].flowId, 'guided-setup-1');
  assert.equal(Object.keys(harness.notifications[0].details).length, 0);

  await harness.hooks.openMcpConfigModal('gitlab', null, {
    flowId: 'guided-setup-2',
    launchSource: 'backend-requested',
  });
  await harness.elements.get('mcp-config-cancel-btn').click();
  assert.equal(modal.classList.contains('visible'), false);
  assert.equal(harness.notifications.length, 2);
  assert.deepEqual(
    harness.notifications.map(({ serverId, outcome, flowId }) => ({
      serverId,
      outcome,
      flowId,
    })),
    [
      {
        serverId: 'gitlab',
        outcome: 'dismissed',
        flowId: 'guided-setup-1',
      },
      {
        serverId: 'gitlab',
        outcome: 'dismissed',
        flowId: 'guided-setup-2',
      },
    ],
  );
});

test('Slack configuration health check covers a cold workspace cache rebuild', () => {
  const harness = buildHarness();
  assert.equal(harness.hooks.mcpConfigReadinessTimeoutMs('slack'), 12 * 60_000);
  assert.equal(harness.hooks.mcpConfigReadinessTimeoutMs('gitlab'), 180_000);
});

test('promotion treats requiresConfiguration toggle result as a failed finalization', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'components', 'mcp-config-modal.js'),
    'utf8',
  );

  assert.match(
    source,
    /if \(toggleResult\?\.requiresConfiguration\) \{[\s\S]*throw new Error\(/,
  );
  assert.match(
    source,
    /showConfigNotification\('Failed to enable server: ' \+ err\.message, 'error'\)/,
  );
});

test('reconfigure save path persists sensitive required vars through runtime secrets and keeps presets in env content', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'components', 'mcp-config-modal.js'),
    'utf8',
  );

  assert.match(
    source,
    /const sensitiveKeys = Object\.keys\(valuesToSave\)\.filter\(isSensitiveRequiredEnvVar\);[\s\S]*content = stripSensitiveEnvKeys\(content, sensitiveKeys\);/,
  );
  assert.match(
    source,
    /if \(isSensitiveRequiredEnvVar\(key\)\) \{[\s\S]*await window\.electronAPI\.upsertRuntimeSecret\(key, value\);[\s\S]*continue;/,
  );
  assert.match(
    source,
    /for \(const preset of \(mcpConfigState\.presetVars \|\| \[\]\)\) \{[\s\S]*content \+= `\\n\$\{preset\.name\}=\$\{preset\.value\}`;/,
  );
});

test('Save & Test refuses to start a dual-requirement server when OAuth tokens are missing', async () => {
  const harness = buildHarness({
    server: {
      requiredVars: [{ name: 'API_KEY' }],
      oauth: {
        type: 'oauth2',
        requires_user_authorization: true,
      },
    },
    hasOAuthTokens: false,
  });

  await harness.hooks.openMcpConfigModal('gitlab');
  const started = await harness.hooks.startServerTest();

  assert.equal(started, false);
  assert.equal(harness.getStartSingleMcpServerCalls(), 0);
  assert.deepEqual(harness.oauthUnauthenticatedCalls, ['gitlab']);
  assert.equal(
    harness.window.appState.servers[0].hasOAuthTokens,
    false,
  );
  assert.deepEqual(harness.uiNotifications, [
    {
      message:
        'GitLab must be authenticated before configuration can be tested.',
      type: 'warning',
    },
  ]);
});

test('Save & Test renders unavailable Snowflake secure material as a warning and starts no health probe', async () => {
  const recoveryPrompt =
    'My Snowflake token is broken. Help me replace it with a fresh token.';
  const harness = buildHarness({
    server: {
      id: 'snowflake',
      display_name: 'Snowflake',
    },
    startSingleMcpServer: async () => ({
      success: false,
      state: 'configuration_required',
      requiresConfiguration: true,
      errorCode: 'SAVED_SECRET_UNAVAILABLE',
      configurationIssue: 'saved_secret_unavailable',
      requiredAction: 'replace_saved_secret',
      severity: 'warning',
      message: 'The saved Snowflake connection is unavailable.',
      recoveryPrompt,
      recoveryLabel: 'Replace Snowflake connection in chat',
    }),
  });

  await harness.hooks.openMcpConfigModal('snowflake', null, {
    flowId: 'guided-snowflake',
    launchSource: 'backend-requested',
  });
  const succeeded = await harness.hooks.startServerTest();

  assert.equal(succeeded, false);
  assert.equal(harness.getStartSingleMcpServerCalls(), 1);
  assert.equal(harness.getCheckSingleMcpServerCalls(), 0);
  assert.deepEqual(harness.stopSingleMcpServerArgs, []);
  assert.equal(harness.hooks.getState().testingStatus, 'warning');
  const rendered = harness.elements.get('mcp-config-testing-content').innerHTML;
  assert.match(rendered, /mcp-config-test-warning/);
  assert.match(rendered, /Setup needed/);
  assert.match(rendered, /Replace Snowflake connection in chat/);
  assert.doesNotMatch(rendered, /mcp-config-test-error/);
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].outcome, 'test_failed');
  assert.equal(
    harness.notifications[0].details.configurationIssue,
    'saved_secret_unavailable',
  );
  assert.equal(harness.notifications[0].details.recoveryPrompt, recoveryPrompt);

  await harness.elements.get('mcp-config-test-recovery-chat-btn').click();
  assert.equal(harness.openNewChatTabArgs.length, 1);
  assert.equal(harness.openNewChatTabArgs[0].prompt, recoveryPrompt);
  assert.equal(
    harness.elements.get('mcp-config-modal').classList.contains('visible'),
    false,
  );
  assert.equal(
    harness.notifications.length,
    1,
    'the already-acknowledged failed flow must not be mislabeled as dismissed',
  );
});

test('configuration chat handoff acknowledges redirected_to_chat and closes only after the tab opens', async () => {
  const harness = buildHarness({
    server: {
      id: 'snowflake',
      display_name: 'Snowflake',
    },
  });
  const prompt = 'Help me set up Snowflake';

  await harness.hooks.openMcpConfigModal('snowflake', null, {
    flowId: 'guided-chat-handoff',
    launchSource: 'backend-requested',
  });
  assert.equal(await harness.hooks.openMcpConfigNewChat(prompt), true);

  assert.equal(harness.openNewChatTabArgs.length, 1);
  assert.equal(harness.openNewChatTabArgs[0].prompt, prompt);
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].serverId, 'snowflake');
  assert.equal(harness.notifications[0].outcome, 'redirected_to_chat');
  assert.equal(harness.notifications[0].flowId, 'guided-chat-handoff');
  assert.equal(Object.keys(harness.notifications[0].details).length, 0);
  assert.equal(
    harness.elements.get('mcp-config-modal').classList.contains('visible'),
    false,
  );
});

test('true single-server startup failures stay red and acknowledge test_failed rather than dismissed', async () => {
  const harness = buildHarness({
    server: {
      id: 'snowflake',
      display_name: 'Snowflake',
    },
    startSingleMcpServer: async () => ({
      success: false,
      errorCode: 'START_SINGLE_MCP_SERVER_FAILED',
      error: 'Single-server backend failed before readiness',
      details: {
        container_logs: [
          '{"level":"error","message":"Snowflake process exited"}',
          'container exited with code 1',
        ].join('\n'),
      },
    }),
  });

  await harness.hooks.openMcpConfigModal('snowflake', null, {
    flowId: 'guided-start-failed',
    launchSource: 'backend-requested',
  });
  assert.equal(await harness.hooks.startServerTest(), false);

  const rendered = harness.elements.get('mcp-config-testing-content').innerHTML;
  assert.match(rendered, /mcp-config-test-error/);
  assert.match(rendered, /Test Failed/);
  assert.doesNotMatch(rendered, /mcp-config-test-warning/);
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].outcome, 'test_failed');
  assert.equal(
    harness.notifications[0].details.errorCode,
    'START_SINGLE_MCP_SERVER_FAILED',
  );

  harness.hooks.closeMcpConfigModal();
  assert.equal(
    harness.notifications.length,
    1,
    'closing a failed test must not emit a second dismissed outcome',
  );
});

test('Save & Test renders malformed YAML as an actionable error without probing health', async () => {
  const yamlError =
    "invalid YAML in /tmp/broken-yaml.yaml: expected ',' or ']' at line 2 column 1";
  const harness = buildHarness({
    server: {
      id: 'broken-yaml',
      display_name: 'Broken YAML',
    },
    startSingleMcpServer: async () => ({
      success: false,
      state: 'configuration_required',
      requiresConfiguration: true,
      errorCode: 'INVALID_USER_SERVER_CONFIG',
      configurationIssue: 'invalid_server_config',
      requiredAction: 'configure',
      severity: 'error',
      error: yamlError,
      message: yamlError,
    }),
  });

  await harness.hooks.openMcpConfigModal('broken-yaml');
  assert.equal(await harness.hooks.startServerTest(), false);

  assert.equal(harness.getCheckSingleMcpServerCalls(), 0);
  assert.deepEqual(harness.stopSingleMcpServerArgs, []);
  assert.equal(harness.hooks.getState().testingStatus, 'failed');
  const rendered = harness.elements.get('mcp-config-testing-content').innerHTML;
  assert.match(rendered, /mcp-config-test-error/);
  assert.match(rendered, /invalid YAML in \/tmp\/broken-yaml\.yaml/);
  assert.match(rendered, /line 2 column 1/);
  assert.doesNotMatch(rendered, /mcp-config-test-warning/);
  assert.equal(harness.testSteps.get('start').icon.classList.contains('failed'), true);
  assert.equal(harness.testSteps.get('start').icon.classList.contains('running'), false);
  assert.equal(
    harness.testSteps.get('start').detail.textContent,
    'Failed to start test server',
  );
  assert.equal(
    harness.hooks.getState().testingFailure.errorCode,
    'INVALID_USER_SERVER_CONFIG',
  );
});

function createSensitiveConfigInput(name) {
  const input = new FakeElement(`input-${name}`);
  input.className = 'input-field';
  input.type = 'password';
  input.dataset.var = name;
  const error = new FakeElement(`error-${name}`);
  input.parentElement = {
    querySelector(selector) {
      return selector === '.input-error' ? error : null;
    },
  };
  return { input, error };
}

test('stored sensitive fields render as retained and blank preserves the Keychain value', async () => {
  const { input } = createSensitiveConfigInput('waldoapikey');
  const harness = buildHarness({
    server: {
      id: 'trust-kit-mcp',
      display_name: 'Trust Kit',
      requiredVars: [{ name: 'waldoapikey', sensitive: true }],
    },
    configInputs: [input],
    secretPresence: { waldoapikey: true },
  });

  await harness.hooks.openMcpConfigModal('trust-kit-mcp');

  assert.equal(input.dataset.secretStored, 'true');
  assert.equal(input.placeholder, 'Stored securely; leave blank to keep');
  assert.equal(await harness.hooks.validateAndSave(), true);
  assert.deepEqual(harness.upsertRuntimeSecretArgs, []);
});

test('invalid stored credentials require an explicit sensitive replacement', async () => {
  const { input, error } = createSensitiveConfigInput('waldoapikey');
  const harness = buildHarness({
    server: {
      id: 'trust-kit-mcp',
      display_name: 'Trust Kit',
      requiredVars: [{ name: 'waldoapikey', sensitive: true }],
    },
    configInputs: [input],
    secretPresence: { waldoapikey: true },
  });

  await harness.hooks.openMcpConfigModal('trust-kit-mcp', null, {
    reason: 'credentials_invalid',
  });

  assert.equal(input.dataset.secretStored, undefined);
  assert.equal(await harness.hooks.validateAndSave(), false);
  assert.equal(error.classList.contains('visible'), true);

  input.value = 'replacement-waldo-key';
  assert.equal(await harness.hooks.validateAndSave(), true);
  assert.deepEqual(harness.upsertRuntimeSecretArgs, [
    { key: 'waldoapikey', value: 'replacement-waldo-key' },
  ]);
});

test('configuration tests use existing-record mode and stop immediately on authorization_required', async () => {
  const harness = buildHarness({
    server: {
      id: 'trust-kit-mcp',
      display_name: 'Trust Kit',
      requiredVars: [{ name: 'waldoapikey', sensitive: true }],
      oauth: {
        type: 'oauth2',
        requires_user_authorization: true,
      },
    },
    hasOAuthTokens: true,
    checkSingleMcpServer: async () => ({
      success: true,
      state: 'authorization_required',
      healthy: false,
      tools: [],
    }),
  });

  await harness.hooks.openMcpConfigModal('trust-kit-mcp');
  const succeeded = await harness.hooks.startServerTest();

  assert.equal(succeeded, false);
  assert.equal(harness.startSingleMcpServerArgs.length, 1);
  assert.equal(harness.startSingleMcpServerArgs[0].serverId, 'trust-kit-mcp');
  assert.equal(
    harness.startSingleMcpServerArgs[0].options.oauthMode,
    'existing-record',
  );
  assert.equal(harness.getCheckSingleMcpServerCalls(), 1);
  assert.equal(harness.stopSingleMcpServerArgs.length, 1);
  assert.equal(harness.stopSingleMcpServerArgs[0].serverId, 'trust-kit-mcp');
  assert.equal(
    harness.stopSingleMcpServerArgs[0].options.sessionId,
    'test-session',
  );
  assert.deepEqual(harness.oauthUnauthenticatedCalls, ['trust-kit-mcp']);
});

test('closing during startup stops only the session returned by the stale start', async () => {
  let resolveStart;
  const startPromise = new Promise((resolve) => {
    resolveStart = resolve;
  });
  const harness = buildHarness({
    server: {
      id: 'trust-kit-mcp',
      display_name: 'Trust Kit',
    },
    startSingleMcpServer: async () => startPromise,
  });

  await harness.hooks.openMcpConfigModal('trust-kit-mcp');
  const testPromise = harness.hooks.startServerTest({ skipOAuthCheck: true });
  await Promise.resolve();
  harness.hooks.closeMcpConfigModal();
  resolveStart({ success: true, sessionId: 'stale-session' });

  assert.equal(await testPromise, false);
  assert.equal(harness.getCheckSingleMcpServerCalls(), 0);
  assert.equal(harness.stopSingleMcpServerArgs.length, 1);
  assert.equal(harness.stopSingleMcpServerArgs[0].serverId, 'trust-kit-mcp');
  assert.equal(
    harness.stopSingleMcpServerArgs[0].options.sessionId,
    'stale-session',
  );
});
