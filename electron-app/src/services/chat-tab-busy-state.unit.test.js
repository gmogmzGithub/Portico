const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const chatTabPath = path.join(
  repoRoot,
  'electron-app',
  'src',
  'renderer',
  'components',
  'chat-tab.js',
);

function extractSourceBlock(startMarker, endMarker) {
  const source = fs.readFileSync(chatTabPath, 'utf8');
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(start, end);
}

function readConversationListenerSegment() {
  return extractSourceBlock(
    'function attachConversationWebviewListeners',
    'async function recoverVisibleWebview',
  );
}

function readMainChatListenerSegment() {
  return extractSourceBlock(
    'function attachMainChatWebviewListeners',
    'function attachConversationWebviewListeners',
  );
}

function createBusyStateHarness({ tabId = 'chat', busy = true, currentChatId = 'chat-old' } = {}) {
  const activityCalls = [];
  const publishCalls = [];
  const claimCalls = [];
  const context = {
    URL,
    String,
    Boolean,
    console,
    window: {
      appState: {
        activeTab: tabId === 'chat' || tabId === 'control' ? tabId : `conversation-${tabId}`,
        tabMeta: {
          [tabId]: {
            busy,
            busyPhase: busy ? 'responding' : 'idle',
            currentChatId,
          },
        },
      },
      tabBar: {
        setActivity: (id, payload) => activityCalls.push({ id, ...payload }),
      },
      backendModalAttention: {
        claimForChat: (chatId, id) => claimCalls.push({ chatId, tabId: id }),
      },
    },
    setTabUnreadState: () => {},
    scheduleBackgroundTabUnloadCheck: () => {},
    publishChatAttentionSnapshot: () => publishCalls.push(true),
  };
  vm.createContext(context);
  vm.runInContext(
    [
      extractSourceBlock(
        'function extractChatIdFromRuntimeUrl',
        'function getRuntimeChatIdForTab',
      ),
      extractSourceBlock('function setTabBusyState', 'function setTabUnreadState'),
    ].join('\n'),
    context,
  );
  return {
    context,
    activityCalls,
    publishCalls,
    claimCalls,
    meta: context.window.appState.tabMeta[tabId],
  };
}

test('conversation tab load lifecycle clears stale busy state', () => {
  const segment = readConversationListenerSegment();

  assert.match(
    segment,
    /webview\.addEventListener\('did-fail-load', \(event\) => \{[\s\S]*if \(isExpectedNavigationAbort\(event\)\) \{[\s\S]*return;[\s\S]*setTabBusyState\(conversationId, false, 'idle'\);[\s\S]*scheduleWebviewHealthProbe/s,
    'non-abort conversation load failures should clear the tab busy spinner before health probing',
  );
  assert.match(
    segment,
    /webview\.addEventListener\('did-finish-load', \(\) => \{[\s\S]*syncConversationUrlState\(conversationId[\s\S]*setTabBusyState\(conversationId, false, 'idle'\);[\s\S]*scheduleWebviewHealthProbe/s,
    'conversation load completion should clear stale busy state before waiting for OWUI activity events',
  );
});

test('main chat tab wires navigation resets and guarded activity events', () => {
  const segment = readMainChatListenerSegment();

  assert.match(
    segment,
    /webview\.addEventListener\('did-navigate', \(event\) => \{\s*resetTabBusyOnChatSwitch\('chat', event\?\.url\);\s*\}\);/,
    'main chat did-navigate should reset stale busy state on chat switch',
  );
  assert.match(
    segment,
    /webview\.addEventListener\('did-navigate-in-page', \(event\) => \{\s*resetTabBusyOnChatSwitch\('chat', event\?\.url\);\s*\}\);/,
    'main chat SPA navigation should reset stale busy state on chat switch',
  );
  assert.match(
    segment,
    /webview\.addEventListener\('tab-activity-changed', \(event\) => \{\s*applyTabActivityEvent\('chat', event\);\s*\}\);/,
    'main chat activity events should flow through the stale-chat guard',
  );
});

test('conversation navigation sync resets busy state and guards activity events', () => {
  const urlSync = extractSourceBlock(
    'function syncConversationUrlState',
    'function createReplacementMainChatView',
  );
  assert.match(
    urlSync,
    /resetTabBusyOnChatSwitch\(conversationId, normalizedUrl\);/,
    'conversation URL sync should reset stale busy state when the chat id changes',
  );

  const segment = readConversationListenerSegment();
  assert.match(
    segment,
    /webview\.addEventListener\('did-navigate', \(event\) => \{\s*syncConversationUrlState\(conversationId, event\?\.url, fallbackUrl\);\s*\}\);/,
    'conversation did-navigate should keep flowing through syncConversationUrlState',
  );
  assert.match(
    segment,
    /webview\.addEventListener\('did-navigate-in-page', \(event\) => \{\s*syncConversationUrlState\(conversationId, event\?\.url, fallbackUrl\);\s*\}\);/,
    'conversation SPA navigation should keep flowing through syncConversationUrlState',
  );
  assert.match(
    segment,
    /webview\.addEventListener\('tab-activity-changed', \(event\) => \{\s*applyTabActivityEvent\(conversationId, event\);\s*\}\);/,
    'conversation activity events should flow through the stale-chat guard',
  );
});

test('navigating a busy main chat tab to a different chat clears the spinner', () => {
  const { context, activityCalls, meta } = createBusyStateHarness({
    tabId: 'chat',
    busy: true,
    currentChatId: 'chat-old',
  });

  vm.runInContext(
    "resetTabBusyOnChatSwitch('chat', 'http://localhost:3789/c/chat-new')",
    context,
  );

  assert.equal(meta.busy, false);
  assert.equal(meta.busyPhase, 'idle');
  assert.equal(meta.currentChatId, 'chat-new');
  assert.deepEqual(activityCalls, [{ id: 'chat', busy: false, phase: 'idle' }]);
});

test('navigating a busy conversation tab to a different chat clears the spinner', () => {
  const { context, activityCalls, meta } = createBusyStateHarness({
    tabId: 'tab-1',
    busy: true,
    currentChatId: 'chat-old',
  });

  vm.runInContext(
    "resetTabBusyOnChatSwitch('tab-1', 'http://localhost:3789/c/chat-new')",
    context,
  );

  assert.equal(meta.busy, false);
  assert.equal(meta.busyPhase, 'idle');
  assert.equal(meta.currentChatId, 'chat-new');
  assert.deepEqual(activityCalls, [{ id: 'tab-1', busy: false, phase: 'idle' }]);
});

test('navigating a busy tab to the new-chat route clears the spinner', () => {
  const { context, activityCalls, meta } = createBusyStateHarness({
    tabId: 'chat',
    busy: true,
    currentChatId: 'chat-old',
  });

  vm.runInContext("resetTabBusyOnChatSwitch('chat', 'http://localhost:3789/')", context);

  assert.equal(meta.busy, false);
  assert.equal(meta.busyPhase, 'idle');
  assert.equal(meta.currentChatId, '');
  assert.deepEqual(activityCalls, [{ id: 'chat', busy: false, phase: 'idle' }]);
});

test('committed same-chat navigation still claims queued native input', () => {
  const { context, claimCalls, meta } = createBusyStateHarness({
    tabId: 'chat',
    busy: false,
    currentChatId: 'chat-a',
  });

  vm.runInContext(
    "resetTabBusyOnChatSwitch('chat', 'http://localhost:3789/c/chat-a')",
    context,
  );

  assert.equal(meta.currentChatId, 'chat-a');
  assert.deepEqual(claimCalls, [{ chatId: 'chat-a', tabId: 'chat' }]);
});

test('new-chat navigation never claims a chat-keyed native input', () => {
  const { context, claimCalls } = createBusyStateHarness({
    tabId: 'chat',
    busy: false,
    currentChatId: 'chat-a',
  });

  vm.runInContext(
    "resetTabBusyOnChatSwitch('chat', 'http://localhost:3789/')",
    context,
  );

  assert.deepEqual(claimCalls, []);
});

test('same-chat navigation leaves the busy spinner untouched', () => {
  const { context, activityCalls, publishCalls, meta } = createBusyStateHarness({
    tabId: 'chat',
    busy: true,
    currentChatId: 'chat-old',
  });

  vm.runInContext(
    "resetTabBusyOnChatSwitch('chat', 'http://localhost:3789/c/chat-old?temporary-chat=true')",
    context,
  );

  assert.equal(meta.busy, true);
  assert.equal(meta.busyPhase, 'responding');
  assert.equal(meta.currentChatId, 'chat-old');
  assert.deepEqual(activityCalls, []);
  assert.deepEqual(publishCalls, []);
});

test('idle tab chat switch records the new chat id without re-render churn', () => {
  const { context, activityCalls, publishCalls, meta } = createBusyStateHarness({
    tabId: 'chat',
    busy: false,
    currentChatId: 'chat-old',
  });

  vm.runInContext(
    "resetTabBusyOnChatSwitch('chat', 'http://localhost:3789/c/chat-new')",
    context,
  );

  assert.equal(meta.busy, false);
  assert.equal(meta.currentChatId, 'chat-new');
  assert.deepEqual(activityCalls, [], 'idle chat switches should not touch the tab bar');
  assert.equal(publishCalls.length, 1, 'route identity changes should republish the snapshot');
});

test('stale busy activity for a departed chat is ignored after a switch', () => {
  const { context, activityCalls, meta } = createBusyStateHarness({
    tabId: 'chat',
    busy: false,
    currentChatId: 'chat-new',
  });

  vm.runInContext(
    "applyTabActivityEvent('chat', { busy: true, phase: 'responding', chatId: 'chat-old' })",
    context,
  );

  assert.equal(meta.busy, false, 'late activity from the departed chat must not re-light the spinner');
  assert.equal(meta.currentChatId, 'chat-new');
  assert.deepEqual(activityCalls, []);

  vm.runInContext(
    "applyTabActivityEvent('chat', { busy: true, phase: 'responding', chatId: 'chat-new' })",
    context,
  );

  assert.equal(meta.busy, true, 'activity for the current chat should still apply');
  assert.equal(meta.busyPhase, 'responding');
  assert.deepEqual(activityCalls, [{ id: 'chat', busy: true, phase: 'responding' }]);
});

test('stale busy=false activity still clears the spinner without hijacking the chat id', () => {
  const { context, meta } = createBusyStateHarness({
    tabId: 'tab-1',
    busy: true,
    currentChatId: 'chat-new',
  });

  vm.runInContext(
    "applyTabActivityEvent('tab-1', { busy: false, phase: 'idle', chatId: 'chat-old' })",
    context,
  );

  assert.equal(meta.busy, false, 'busy=false events are always allowed through');
  assert.equal(
    meta.currentChatId,
    'chat-new',
    'a stale busy=false event must not rebind the tab to the departed chat',
  );
});

test('activity events apply normally before any chat id is recorded', () => {
  const { context, meta } = createBusyStateHarness({
    tabId: 'chat',
    busy: false,
    currentChatId: '',
  });

  vm.runInContext(
    "applyTabActivityEvent('chat', { busy: true, phase: 'thinking', chatId: 'chat-first' })",
    context,
  );

  assert.equal(meta.busy, true);
  assert.equal(meta.busyPhase, 'thinking');
  assert.equal(meta.currentChatId, 'chat-first');
});
