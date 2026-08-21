// Behavioral tests for the PER-TAB multi-chat artifact gate: a tiled workflow
// in one tab must not force windowed-only artifacts (or dead Attach buttons)
// on other, untiled tabs. Extract-and-exec of the real source — no source-pin
// regex assertions.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const artifactPanelPath = path.join(
  repoRoot,
  'electron-app',
  'src',
  'renderer',
  'components',
  'artifact-panel.js',
);
const owuiHostPath = path.join(
  repoRoot,
  'electron-app',
  'src',
  'renderer',
  'components',
  'owui-host.js',
);
const owuiViewsPath = path.join(
  repoRoot,
  'electron-app',
  'src',
  'services',
  'owui-views.js',
);

const block = (source, startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(start, end);
};

const panelSource = fs.readFileSync(artifactPanelPath, 'utf8');

const buildTabHelpers = ({ tiledViewKeys, webviewsByTab }) => {
  const helpersSource = block(
    panelSource,
    'function getActiveArtifactTabKey()',
    '\nfunction ensureArtifactWrapperForChatContainer',
  );
  const sandbox = {
    window: {
      appState: { activeTab: 'chat' },
      owuiMultiChat: {
        anyActive: () => tiledViewKeys.size > 0,
        isActiveForViewKey: (viewKey) => tiledViewKeys.has(viewKey),
      },
    },
    document: {
      getElementById: (id) => webviewsByTab[id] ?? null,
    },
  };
  const factory = new Function(
    'window',
    'document',
    `${helpersSource}; return { isMultiChatActiveForArtifactTab, getChatWebviewForArtifactTab };`,
  );
  return { helpers: factory(sandbox.window, sandbox.document), sandbox };
};

test('per-tab query: only the tab whose view is tiled reports multi-chat', () => {
  const { helpers } = buildTabHelpers({
    tiledViewKeys: new Set(['conversation:abc']),
    webviewsByTab: {
      'chat-webview': { dataset: { owuiViewKey: 'main' } },
      'conversation-webview-abc': { dataset: { owuiViewKey: 'conversation:abc' } },
      'conversation-webview-def': { dataset: { owuiViewKey: 'conversation:def' } },
    },
  });

  assert.equal(helpers.isMultiChatActiveForArtifactTab('conversation-abc'), true);
  assert.equal(helpers.isMultiChatActiveForArtifactTab('conversation-def'), false);
  assert.equal(helpers.isMultiChatActiveForArtifactTab('chat'), false);
  assert.equal(helpers.isMultiChatActiveForArtifactTab(null), false);
  // Unknown tab (no webview element) never reads as tiled.
  assert.equal(helpers.isMultiChatActiveForArtifactTab('conversation-missing'), false);
});

const buildRouteHarness = ({ tiledTabKeys, anyActive, resolvedTabKey }) => {
  const routeSource = block(
    panelSource,
    'async routeArtifactOpen(data, options = {}) {',
    '\n\n  async handleTabChatLoaded',
  );
  const calls = [];
  const fakePanel = {
    openDetached: (data) => calls.push(['openDetached', data.artifact_id]),
    notifyIndicator: () => {},
    resolveTabKeyForChatId: () => resolvedTabKey,
    getLoadedChatIdForTabKey: () => 'chat-b',
    isTabLoadedForChat: () => resolvedTabKey !== null,
    getAttachedState: () => null,
    isAttachedStateValidForTab: () => false,
    queuePendingArtifactOpen: (data) => {
      calls.push(['queued', data.artifact_id]);
      return true;
    },
    open: (artifactId) => calls.push(['openInline', artifactId]),
  };
  // routeSource is a class-method shorthand ("async routeArtifactOpen(...)
  // {...}") — rewrap it as a function expression.
  const factory = new Function(
    'isMultiChatActiveForArtifactTab',
    'window',
    `return async function ${routeSource.replace(/^async /, '')};`,
  );
  const route = factory(
    (tabKey) => tiledTabKeys.has(tabKey),
    { owuiMultiChat: { anyActive: () => anyActive } },
  ).bind(fakePanel);
  return { route, calls };
};

test('routing: untiled tab attaches inline even while another tab is tiled', async () => {
  const { route, calls } = buildRouteHarness({
    tiledTabKeys: new Set(['conversation-tiled']),
    anyActive: true,
    resolvedTabKey: 'chat',
  });
  await route({ artifact_id: 'a1', chat_id: 'chat-b', preview_url: 'u', name: 'n', version: 1 });
  assert.deepEqual(calls, [['openInline', 'a1']]);
});

test('routing: the tiled tab itself stays windowed-only', async () => {
  const { route, calls } = buildRouteHarness({
    tiledTabKeys: new Set(['conversation-tiled']),
    anyActive: true,
    resolvedTabKey: 'conversation-tiled',
  });
  await route({ artifact_id: 'a2', chat_id: 'chat-a' });
  assert.deepEqual(calls, [['openDetached', 'a2']]);
});

test('routing: explicit detached requests always open windowed', async () => {
  const { route, calls } = buildRouteHarness({
    tiledTabKeys: new Set(),
    anyActive: false,
    resolvedTabKey: 'chat',
  });
  await route({ artifact_id: 'a3', chat_id: 'chat-b', detached: true });
  assert.deepEqual(calls, [['openDetached', 'a3']]);
});

test('routing: unresolved target falls back to the shell-wide gate, except dock-backs', async () => {
  const unresolved = buildRouteHarness({
    tiledTabKeys: new Set(['conversation-tiled']),
    anyActive: true,
    resolvedTabKey: null,
  });
  await unresolved.route({ artifact_id: 'a4', chat_id: 'chat-x' });
  assert.deepEqual(unresolved.calls, [['openDetached', 'a4']]);

  // A dock-back (reattached) was explicitly aimed at a tab by the user: it
  // must not be re-windowed by an unrelated tab's tiling; with no loadable
  // target it queues instead of bouncing back to a window.
  const dockBack = buildRouteHarness({
    tiledTabKeys: new Set(['conversation-tiled']),
    anyActive: true,
    resolvedTabKey: null,
  });
  await dockBack.route({ artifact_id: 'a5', chat_id: 'chat-x', reattached: true });
  assert.deepEqual(dockBack.calls, [['queued', 'a5']]);
});

test('owui-host exposes the per-view query alongside anyActive', () => {
  const hostSource = fs.readFileSync(owuiHostPath, 'utf8');
  const multiChatBlock = block(
    hostSource,
    'const multiChatActiveByViewKey = new Map();',
    '\n  const interactionSuppressionReasons',
  );
  const sandbox = { window: {} };
  new Function('window', multiChatBlock)(sandbox.window);
  const { owuiMultiChat } = sandbox.window;
  const record = new Function(
    'window',
    `${multiChatBlock}; return recordMultiChatActivity;`,
  );
  // Re-exec with a shared window so record + queries share state.
  const shared = {};
  const recorder = record(shared);
  assert.equal(shared.owuiMultiChat.anyActive(), false);
  assert.equal(shared.owuiMultiChat.isActiveForViewKey('conversation:x'), false);
  recorder('conversation:x', true);
  assert.equal(shared.owuiMultiChat.anyActive(), true);
  assert.equal(shared.owuiMultiChat.isActiveForViewKey('conversation:x'), true);
  assert.equal(shared.owuiMultiChat.isActiveForViewKey('main'), false);
  recorder('conversation:x', false);
  assert.equal(shared.owuiMultiChat.anyActive(), false);
  assert.equal(shared.owuiMultiChat.isActiveForViewKey('conversation:x'), false);
  assert.ok(owuiMultiChat, 'owuiMultiChat installs on window');
});

test('main process: isMultiChatActiveForChatId is per-chat, not any-view', () => {
  const viewsSource = fs.readFileSync(owuiViewsPath, 'utf8');
  const fnSource = block(
    viewsSource,
    'function isMultiChatActiveForChatId(chatId) {',
    '\n\n// Runtime-only reconciliation',
  );
  const viewEntries = new Map([
    ['view-a', { currentChatId: 'chat-a', multiChatActive: true }],
    ['view-b', { currentChatId: 'chat-b', multiChatActive: false }],
  ]);
  const probe = new Function(
    'viewEntries',
    `${fnSource}; return isMultiChatActiveForChatId;`,
  )(viewEntries);
  assert.equal(probe('chat-a'), true);
  assert.equal(probe('chat-b'), false);
  assert.equal(probe('chat-unknown'), false);
  assert.equal(probe(''), false);
  assert.equal(probe(null), false);
});
