const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), 'utf8');

const chatSource = read(
  'src', 'patches', 'frontend', 'src', 'lib', 'components', 'chat', 'Chat.svelte',
);
const sidebarSource = read(
  'src', 'patches', 'frontend', 'src', 'lib', 'components', 'layout', 'Sidebar.svelte',
);
const chatItemSource = read(
  'src', 'patches', 'frontend', 'src', 'lib', 'components', 'layout', 'Sidebar', 'ChatItem.svelte',
);
const blocksSource = read(
  'src', 'patches', 'frontend', 'src', 'lib', 'components', 'layout', 'Sidebar', 'ChatActivityBlocks.svelte',
);
const runtimeStoreSource = read(
  'src', 'patches', 'frontend', 'src', 'lib', 'stores', 'chatRuntimeState.ts',
);
const preloadSource = read('electron-app', 'src', 'services', 'chat-webview-preload.js');
const ipcSource = read('electron-app', 'src', 'services', 'ipc.js');
const owuiViewsSource = read('electron-app', 'src', 'services', 'owui-views.js');
const chatTabSource = read('electron-app', 'src', 'renderer', 'components', 'chat-tab.js');

test('chat activity reports carry the canonical chat ID and de-duplicate navigation correctly', () => {
  assert.match(chatSource, /let lastReportedTabChatId = '';/);
  assert.match(chatSource, /let tabActivityChatId = '';/);
  assert.match(chatSource, /lastReportedTabChatId === normalizedChatId/);
  assert.match(
    chatSource,
		/const busy = composerStreamingState\.isStreaming;[\s\S]*tabActivityChatId === currentChatId[\s\S]*reportTabActivity\([\s\S]*?busy,[\s\S]*?phase,[\s\S]*?currentChatId/,
  );
	assert.doesNotMatch(chatSource, /const busy = generating \|\| hasActiveTasks;/);
	assert.match(
		preloadSource,
		/chatId: typeof payload\?\.chatId === 'string' \? payload\.chatId : ''/,
	);
	const destroyBlock = chatSource.split('onDestroy(() => {')[1]?.split('pageSubscribe();')[0] ?? '';
	assert.doesNotMatch(
		destroyBlock,
		/reportTabActivity\(false, 'idle'/,
		'leaving a running chat must not report a synthetic terminal transition',
	);
});

test('chat navigation isolates activity until the captured chat task state is authoritative', () => {
	const navigateStart = chatSource.indexOf('const navigateHandler = async () => {');
	const navigateEnd = chatSource.indexOf('const onSelect = async', navigateStart);
	assert.notEqual(navigateStart, -1);
	assert.notEqual(navigateEnd, -1);
	const navigateBlock = chatSource.slice(navigateStart, navigateEnd);

	assert.match(navigateBlock, /const targetChatId = String\(chatIdProp \?\? ''\)\.trim\(\);/);
	assert.match(navigateBlock, /const generation = \+\+chatLoadGeneration;/);
	assert.match(navigateBlock, /tabActivityChatId = '';[\s\S]*setTaskIds\(null\);/);
	assert.match(navigateBlock, /chatLoadAbortController\?\.abort\(\);/);
	assert.match(
		navigateBlock,
		/loadChat\(targetChatId, generation, abortController\.signal\)/,
	);
	assert.match(
		chatSource,
		/taskStateKnown &&[\s\S]*isCurrentChatLoad\(generation, targetChatId\)[\s\S]*tabActivityChatId = targetChatId;/,
	);
	assert.match(
		chatSource,
		/const nextChat = await getChatHydrationById\([\s\S]*if \(!isCurrentChatLoad\(generation, targetChatId\)\)[\s\S]*chat = nextChat;/,
	);

	const failedLoadStart = chatSource.indexOf('const clearFailedChatLoadActivityState = () => {');
	const failedLoadEnd = chatSource.indexOf('\n\t$: {', failedLoadStart);
	const failedLoadBlock = chatSource.slice(failedLoadStart, failedLoadEnd);
	assert.match(failedLoadBlock, /tabActivityChatId = '';/);
	assert.doesNotMatch(failedLoadBlock, /reportTabActivity\(/);
});

test('deferred stream reconciliation and follow-up activity remain chat scoped', () => {
	assert.match(
		chatSource,
		/resyncRunningAssistantMessages\(targetChatId, generation\)/,
	);
	assert.match(
		chatSource,
		/const resyncRunningAssistantMessages = async \([\s\S]*expectedChatId[\s\S]*expectedGeneration[\s\S]*isCurrentChatLoad\(expectedGeneration, expectedChatId\)/,
	);
	assert.match(
		chatSource,
		/const targetChatId = expectedChatId \|\| \$chatId;[\s\S]*getChatById\(localStorage\.token, targetChatId\)[\s\S]*!remainsCurrent\(\)/,
	);

	const sendStart = chatSource.indexOf('const sendMessage = async (');
	const sendEnd = chatSource.indexOf('\n\tconst getFeatures =', sendStart);
	const sendBlock = chatSource.slice(sendStart, sendEnd);
	assert.match(sendBlock, /let _chatId = \$chatId;[\s\S]*tabActivityChatId = _chatId;/);
	assert.match(sendBlock, /_chatId = await initChatHandler\([\s\S]*tabActivityChatId = _chatId;/);
});

test('main process keeps per-chat runtime state across navigation and supports cold snapshots', () => {
	assert.doesNotMatch(owuiViewsSource, /entry\.chatActivity\s*=\s*normalizeChatActivity/);
	assert.match(owuiViewsSource, /function updateChatActivityForContents\(contents, payload = \{\}\)/);
  assert.match(owuiViewsSource, /function getChatActivitySnapshotForContents\(contents\)/);
  assert.match(
    owuiViewsSource,
    /broadcastToViews\("owui-chat-activity-snapshot", snapshot\)/,
  );
  assert.match(ipcSource, /owuiViews\.updateChatActivityForContents\(event\.sender, payload\)/);
	assert.match(ipcSource, /ipcMain\.handle\("owui-get-chat-activity-snapshot"/);
	assert.match(ipcSource, /ipcMain\.handle\("owui-reconcile-chat-runtime"/);
	assert.match(preloadSource, /function getChatActivitySnapshot\(\)/);
	assert.match(preloadSource, /function reconcileChatRuntime\(payload = \{\}\)/);
	assert.match(preloadSource, /ipcRenderer\.on\('owui-chat-activity-snapshot'/);
});

test('chat navigation claims chat-keyed native input without creating a replacement tab', () => {
	assert.match(
		chatTabSource,
		/if \(hasReportedChatId && normalizedChatId\) \{[\s\S]*backendModalAttention\?\.claimForChat\?\.\(normalizedChatId, tabId\)/,
	);
	assert.match(
		chatTabSource,
		/const activeChatId = getRuntimeChatIdForTab\(tabId, state\);[\s\S]*backendModalAttention\?\.claimForChat\?\.\(activeChatId, tabId\);[\s\S]*backendModalAttention\?\.drainForTab\?\.\(tabId\)/,
	);
});

test('background chat reconciliation fails closed and requires two empty task checks', () => {
	assert.match(runtimeStoreSource, /getTaskIdsByChatId/);
	assert.match(runtimeStoreSource, /BACKGROUND_EMPTY_CONFIRMATIONS = 2/);
	assert.match(runtimeStoreSource, /BACKGROUND_RECONCILE_GRACE_MS = 4_500/);
	assert.match(runtimeStoreSource, /chatId !== visibleChatId/);
	assert.match(runtimeStoreSource, /if \(!Array\.isArray\(taskResult\?\.task_ids\)\)/);
	assert.match(runtimeStoreSource, /emptyChecks < BACKGROUND_EMPTY_CONFIRMATIONS/);
	assert.match(runtimeStoreSource, /hostApi\.reconcileChatRuntime\(\{/);
	assert.match(runtimeStoreSource, /busy:\s*false/);
});

test('shell unread and attention state share one snapshot and merge with persistent OWUI attention', () => {
  assert.match(chatTabSource, /function buildChatAttentionSnapshot\(state = window\.appState\)/);
  assert.match(
    chatTabSource,
    /broadcast\('owui-chat-attention-snapshot', buildChatAttentionSnapshot\(\)\)/,
  );
  assert.match(chatTabSource, /function extractChatIdFromRuntimeUrl\(rawUrl\)/);
  assert.match(preloadSource, /function getChatAttentionSnapshot\(\)/);
	assert.match(runtimeStoreSource, /shellStateByChatId = next/);
	assert.match(runtimeStoreSource, /unread:\s*activity\.unread \|\| shellState\?\.unread === true/);
	assert.match(runtimeStoreSource, /nativeInputAttentionByChatId = new Set<string>\(\)/);
	assert.match(runtimeStoreSource, /nativeInputAttentionByChatId\.has\(chatId\)/);
	assert.match(runtimeStoreSource, /owui-native-input-presentation-snapshot/);
	assert.match(runtimeStoreSource, /getNativeInputPresentationSnapshot/);
	assert.match(
		runtimeStoreSource,
		/\[[\s\S]*'user_question',[\s\S]*'sensitive_info',[\s\S]*'chat_workspace_consent'[\s\S]*\]/,
	);
	assert.match(
		chatItemSource,
		/persistedAttentionReason !== null \|\| runtimeState\?\.attentionRequired === true/,
  );
});

test('sidebar initializes one shared runtime bridge', () => {
  assert.match(sidebarSource, /initializeChatRuntimeStateBridge/);
  assert.match(sidebarSource, /void initializeChatRuntimeStateBridge\(\)/);
  assert.match(runtimeStoreSource, /if \(initialized \|\| typeof window === 'undefined'\)/);
  assert.match(runtimeStoreSource, /chatRuntimeState\.set\(next\)/);
});

test('active sidebar chats render the four-block loader before the title', () => {
  assert.match(blocksSource, /class="chat-activity-blocks"/);
  assert.equal((blocksSource.match(/<span><\/span>/g) || []).length, 4);
  assert.match(blocksSource, /1\.05s ease-in-out infinite/);
  assert.match(blocksSource, /animation-delay: 120ms/);
  assert.match(blocksSource, /animation-delay: 240ms/);
  assert.match(blocksSource, /animation-delay: 360ms/);
	assert.match(blocksSource, /prefers-reduced-motion: reduce/);
	assert.match(blocksSource, /:global\(\.light \.selected\)/);
	assert.match(blocksSource, /--chat-activity-block-color:\s*#0047b3/);

  const loaderIndex = chatItemSource.indexOf('<ChatActivityBlocks />');
  const titleIndex = chatItemSource.indexOf('{title}', loaderIndex);
  assert.ok(loaderIndex !== -1 && titleIndex > loaderIndex, 'loader must sit left of the title');
});

test('orange attention and blue unread dots sit at the edge and shift before the hover menu', () => {
	const attentionSlotIndex = chatItemSource.indexOf('sidebar-chat-status-slot');
  const menuIndex = chatItemSource.indexOf('id="sidebar-chat-item-menu"');
  assert.ok(attentionSlotIndex !== -1 && menuIndex > attentionSlotIndex);
	assert.match(chatItemSource, /mouseOver[\s\S]*right-\[52px\][\s\S]*right-\[12px\]/);
  assert.match(chatItemSource, /right-\[52px\]/);
  assert.match(chatItemSource, /right-\[78px\]/);
	assert.match(chatItemSource, /transition-\[right\] duration-150/);
	assert.match(chatItemSource, /absolute z-20/);
	assert.match(chatItemSource, /runtimeState\?\.unread === true && !needsAttention/);
	assert.match(chatItemSource, /sidebar-chat-unread-dot/);
	assert.match(chatItemSource, /bg-blue-500/);
	assert.match(chatItemSource, /\{#if needsAttention\}[\s\S]*\{:else if hasUnreadUpdate\}/);
  assert.match(
    chatItemSource,
    /needsAttention && id !== \$chatId && !selected && !confirmEdit && !mouseOver/,
  );
  assert.match(chatItemSource, /sidebar-chat-attention-pulse 2\.4s ease-in-out infinite/);
  assert.match(chatItemSource, /prefers-reduced-motion: reduce/);
});
