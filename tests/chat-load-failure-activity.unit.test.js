const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const chatSveltePath = path.join(
  repoRoot,
  'src',
  'patches',
  'frontend',
  'src',
  'lib',
  'components',
  'chat',
  'Chat.svelte',
);

test('failed chat hydration clears local activity before redirecting', async () => {
  const source = await fs.readFile(chatSveltePath, 'utf8');
  const helperStart = source.indexOf('const clearFailedChatLoadActivityState = () => {');
  assert.notEqual(helperStart, -1, 'failed-load activity cleanup helper should exist');
  const helperEnd = source.indexOf('\n\t};', helperStart);
  const helper = source.slice(helperStart, helperEnd);

  assert.match(helper, /setTaskIds\(null\);/);
  assert.match(helper, /generating = false;/);
  assert.match(helper, /generationController\?\.abort\(\);/);
  assert.match(helper, /stopStreamWatchdog\(\);/);
  assert.match(helper, /clearAllStreamingMessageCommitStates\(\);/);
	assert.match(helper, /tabActivityChatId = '';/);
  assert.match(
		helper,
		/clearFailedChatLoadActivityState = \(\) => \{[\s\S]*tabActivityChatId = '';[\s\S]*setTaskIds\(null\);/,
		'failed hydration should detach local activity ownership before clearing transient state',
  );
	assert.doesNotMatch(
		helper,
		/reportTabActivity\(/,
		'failed hydration must not publish an idle transition for a chat it no longer owns',
	);

  const loadChatStart = source.indexOf('const loadChat = async (');
  assert.notEqual(loadChatStart, -1, 'loadChat should exist');
  const loadChatEnd = source.indexOf('const getErrorMessage =', loadChatStart);
  const loadChat = source.slice(loadChatStart, loadChatEnd);

  assert.match(
    loadChat,
    /getChatHydrationById\(localStorage\.token, targetChatId, signal\)/,
    'primary chat loading should use the compact abortable hydration endpoint',
  );

	const navigateStart = source.indexOf('const navigateHandler = async () => {');
	const navigateEnd = source.indexOf('const onSelect =', navigateStart);
	const navigate = source.slice(navigateStart, navigateEnd);
	assert.match(
		navigate,
		/clearFailedChatLoadActivityState\(\);[\s\S]*await goto\('\/'\);/s,
		'failed non-aborted hydration should clear activity before redirecting home',
	);

	const deferredStart = source.indexOf('const loadDeferredChatState = async');
	const deferredEnd = source.indexOf('const loadChat = async (', deferredStart);
	const deferred = source.slice(deferredStart, deferredEnd);
  assert.match(
    deferred,
    /if \(Array\.isArray\(taskRes\?\.task_ids\)\) \{[\s\S]*setTaskIds\(taskRes\.task_ids\);[\s\S]*\} else \{[\s\S]*setTaskIds\(null\);/s,
    'failed or malformed task lookups should clear stale local task ids',
  );
});
