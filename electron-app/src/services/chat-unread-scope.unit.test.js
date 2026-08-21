// PORTICO-432: a tab's unread flag describes the chat that tab was showing. When the
// tab navigates to a different chat the flag is stale, and because
// buildChatAttentionSnapshot resolves tabMeta.unread against the tab's CURRENT
// chat, leaving it set attributed unread to a chat that never had activity.
//
// Behavioural: the real chat-tab.js functions are driven in a node:vm harness and
// the assertions are on the published snapshot, not on source text.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const chatTabSource = fs.readFileSync(
  path.join(repoRoot, 'electron-app', 'src', 'renderer', 'components', 'chat-tab.js'),
  'utf8',
);

function sliceBetween(startMarker, endMarker) {
  const start = chatTabSource.indexOf(startMarker);
  const end = chatTabSource.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return chatTabSource.slice(start, end);
}

const CHAT_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const CHAT_B = 'bbbbbbbb-1111-2222-3333-444444444444';

function createHarness({ activeTab = 'chat' } = {}) {
  const code =
    sliceBetween('function extractChatIdFromRuntimeUrl', 'function publishChatAttentionSnapshot') +
    sliceBetween('function setTabBusyState', 'function tabModelIdentityKey') +
    sliceBetween('function setTabUnreadState', 'function setTabAttentionRequiredState');

  const published = [];
  const elements = new Map();
  const context = {
    URL,
    Map,
    Object,
    String,
    Number,
    Boolean,
    console,
    document: { getElementById: (id) => elements.get(id) || null },
    publishChatAttentionSnapshot() {
      published.push(context.buildChatAttentionSnapshot());
    },
    scheduleBackgroundTabUnloadCheck() {},
    window: {
      appState: { activeTab, tabMeta: {}, conversationTabs: {} },
      tabBar: { setActivity() {}, setUnread() {} },
      backendModalAttention: { claimForChat() {} },
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(
    `${code}\nthis.buildChatAttentionSnapshot = buildChatAttentionSnapshot;\nthis.resetTabBusyOnChatSwitch = resetTabBusyOnChatSwitch;\nthis.setTabUnreadState = setTabUnreadState;`,
    context,
  );

  const setTabChat = (tabId, chatId) => {
    elements.set(`conversation-webview-${tabId}`, {
      getURL: () => `http://localhost:3789/c/${chatId}`,
    });
  };

  // Snapshots are built inside the vm realm, so their arrays/objects carry that
  // realm's prototypes and deepStrictEqual would reject them as not
  // reference-equal. Round-trip through JSON to get plain main-realm values.
  const latestChats = () => JSON.parse(JSON.stringify(published.at(-1)?.chats ?? []));

  return {
    context,
    published,
    setTabChat,
    state: context.window.appState,
    latestChats,
    unreadChatIds: () =>
      latestChats()
        .filter((chat) => chat.unread === true)
        .map((chat) => String(chat.chatId)),
  };
}

test('a tab navigating to another chat drops its stale unread instead of moving it', () => {
  const h = createHarness();
  h.state.tabMeta.side = { unread: false, busy: false, currentChatId: CHAT_A };
  h.setTabChat('side', CHAT_A);

  // Chat A finished while this tab was in the background.
  h.context.setTabUnreadState('side', true);
  assert.deepEqual(h.unreadChatIds(), [CHAT_A]);

  // That tab now shows a different chat.
  h.setTabChat('side', CHAT_B);
  h.context.resetTabBusyOnChatSwitch('side', `http://localhost:3789/c/${CHAT_B}`);

  assert.deepEqual(
    h.unreadChatIds(),
    [],
    'the flag described chat A, so it must not be reported against chat B',
  );
  assert.equal(h.state.tabMeta.side.unread, false);
});

test('a busy background tab switching chats does not mark the arriving chat unread', () => {
  // setTabBusyState marks an inactive tab unread on any busy->idle transition,
  // and it records the new chat id before doing so, so the departing chat's
  // completion used to land on the chat being opened.
  const h = createHarness({ activeTab: 'chat' });
  h.state.tabMeta.side = { unread: false, busy: true, currentChatId: CHAT_A };
  h.setTabChat('side', CHAT_B);

  h.context.resetTabBusyOnChatSwitch('side', `http://localhost:3789/c/${CHAT_B}`);

  assert.deepEqual(
    h.unreadChatIds(),
    [],
    'chat B never had activity and must not be flagged',
  );
});

test('a tab that stays on the same chat keeps its unread dot', () => {
  const h = createHarness();
  h.state.tabMeta.side = { unread: false, busy: false, currentChatId: CHAT_A };
  h.setTabChat('side', CHAT_A);
  h.context.setTabUnreadState('side', true);

  // Re-entrant navigation to the same chat must not clear a legitimate dot.
  h.context.resetTabBusyOnChatSwitch('side', `http://localhost:3789/c/${CHAT_A}`);

  assert.deepEqual(h.unreadChatIds(), [CHAT_A]);
  assert.equal(h.state.tabMeta.side.unread, true);
});

test('the published snapshot still resolves a tab to the chat it currently shows', () => {
  const h = createHarness();
  h.state.tabMeta.side = { unread: false, busy: false, currentChatId: CHAT_B };
  h.setTabChat('side', CHAT_B);
  h.context.setTabUnreadState('side', true);

  assert.deepEqual(
    h.unreadChatIds(),
    [CHAT_B],
    'attribution by live URL is intended behaviour and must survive the fix',
  );
});
