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
const preloadSource = fs.readFileSync(
  path.join(repoRoot, 'electron-app', 'src', 'services', 'chat-webview-preload.js'),
  'utf8',
);

function getFunctionBlock(startMarker, endMarker) {
  const start = chatTabSource.indexOf(startMarker);
  const end = chatTabSource.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return chatTabSource.slice(start, end);
}

test('owner snapshot merges unread and attention by resolved chat ID', () => {
  const source = getFunctionBlock(
    'function extractChatIdFromRuntimeUrl',
    'function publishChatAttentionSnapshot',
  );
  const elements = new Map([
    ['chat-webview', { getURL: () => 'http://localhost:3789/c/shared-chat' }],
    [
      'conversation-webview-tab-a',
      { getURL: () => 'http://localhost:3789/c/shared-chat' },
    ],
  ]);
  const context = {
    URL,
    Map,
    Object,
    String,
    window: {
      appState: {
        tabMeta: {
          chat: { attentionRequired: true },
          'tab-a': { unread: true, conversationId: 'tab-a' },
          'tab-b': {
            unread: true,
            url: 'http://localhost:3789/c/unread-chat',
            conversationId: 'tab-b',
          },
        },
        conversationTabs: {
          'tab-a': { url: 'http://localhost:3789/c/shared-chat' },
          'tab-b': { url: 'http://localhost:3789/c/unread-chat' },
        },
      },
    },
    document: {
      getElementById: (id) => elements.get(id) || null,
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);

  const snapshot = JSON.parse(
    JSON.stringify(vm.runInContext('buildChatAttentionSnapshot()', context)),
  );
  assert.deepEqual(snapshot, {
    version: 1,
    chats: [
      {
        chatId: 'shared-chat',
        attentionRequired: true,
        unread: true,
      },
      { chatId: 'unread-chat', unread: true },
    ],
  });
});

test('shell republishes the compatible snapshot whenever status or route identity changes', () => {
  const unreadSetter = getFunctionBlock(
    'function setTabUnreadState',
    'function setTabAttentionRequiredState',
  );
  const attentionSetter = getFunctionBlock(
    'function setTabAttentionRequiredState',
    'const owuiFocusSuppressionReasons',
  );
  const urlSync = getFunctionBlock(
    'function syncConversationUrlState',
    'function createReplacementMainChatView',
  );
  const busySetter = getFunctionBlock(
    'function setTabBusyState',
    'function setTabUnreadState',
  );

  assert.match(unreadSetter, /publishChatAttentionSnapshot\(\);/);
  assert.match(attentionSetter, /publishChatAttentionSnapshot\(\);/);
  assert.match(urlSync, /publishChatAttentionSnapshot\(\);/);
  assert.match(
    busySetter,
    /previousChatId !== normalizedChatId[\s\S]*publishChatAttentionSnapshot\(\);/,
  );
  assert.match(
    chatTabSource,
    /broadcast\('owui-chat-attention-snapshot', buildChatAttentionSnapshot\(\)\)/,
  );
});

test('OWUI preload stores and exposes the full compatible status payload', () => {
  assert.match(preloadSource, /function getChatAttentionSnapshot\(\) \{\s*return latestChatAttentionSnapshot;/);
  assert.match(
    preloadSource,
    /ipcRenderer\.on\('owui-chat-attention-snapshot',[\s\S]*latestChatAttentionSnapshot = detail && typeof detail === 'object'[\s\S]*detail: latestChatAttentionSnapshot/,
  );
});
