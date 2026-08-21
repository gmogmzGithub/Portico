// Round-9 pins for the patched OWUI frontend:
// 1) message editing is readable in light mode (explicit text color on the
//    edit textarea + a wrapper background distinct from the page), and
// 2) the marketplace_publish native-input kind reaches the composer's
//    minimized-pill affordance so a hidden publish approval can be restored.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..');
const USER_MESSAGE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/Messages/UserMessage.svelte'
);
const RESPONSE_MESSAGE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/Messages/ResponseMessage.svelte'
);
const CHAT_RUNTIME_STATE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/stores/chatRuntimeState.ts'
);
const MESSAGE_INPUT_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/MessageInput.svelte'
);

test('message edit wells are readable in light mode (both user and assistant messages)', async () => {
	const [userMessage, responseMessage] = await Promise.all([
		fs.readFile(USER_MESSAGE_PATH, 'utf8'),
		fs.readFile(RESPONSE_MESSAGE_PATH, 'utf8')
	]);

	for (const [name, source] of [
		['UserMessage.svelte', userMessage],
		['ResponseMessage.svelte', responseMessage]
	]) {
		// The edit well separates from the white page in light mode; dark mode
		// keeps its original gray-800 surface.
		assert.match(
			source,
			/bg-gray-100 dark:bg-gray-800 rounded-3xl/,
			`${name}: edit wrapper must use the light-differentiated bg-gray-100 well`
		);
		assert.doesNotMatch(
			source,
			/bg-gray-50 dark:bg-gray-800 rounded-3xl/,
			`${name}: the washed-out bg-gray-50 edit wrapper must not return`
		);
		// The transparent textarea carries an explicit text color so light mode
		// shows dark readable text instead of inheriting an ambient light color.
		assert.match(
			source,
			/bg-transparent outline-hidden w-full resize-none text-gray-900 dark:text-gray-100/,
			`${name}: edit textarea must set explicit light/dark text colors`
		);
	}
});

test('marketplace_publish reaches the composer minimized-pill affordance', async () => {
	const [chatRuntimeState, messageInput] = await Promise.all([
		fs.readFile(CHAT_RUNTIME_STATE_PATH, 'utf8'),
		fs.readFile(MESSAGE_INPUT_PATH, 'utf8')
	]);

	assert.match(
		chatRuntimeState,
		/NATIVE_INPUT_ATTENTION_KINDS = new Set\(\[\s*'user_question',\s*'sensitive_info',\s*'chat_workspace_consent',\s*'marketplace_publish'\s*\]\)/
	);

	// The snapshot filter accepts publish flows (which carry no chat id) and
	// the pill matcher shows them in whichever chat is active.
	assert.match(messageInput, /'marketplace_publish'\s*\]\.includes\(flow\?\.kind\)/);
	assert.match(
		messageInput,
		/typeof flow\?\.chat_id === 'string' \|\| flow\?\.kind === 'marketplace_publish'/
	);
	assert.match(
		messageInput,
		/flow\.chat_id === chatId \|\| flow\.kind === 'marketplace_publish'/
	);
	assert.match(messageInput, /Marketplace publish approval is waiting/);
	assert.match(messageInput, /Return to review the publish request and continue this chat/);
	// PORTICO-348: the "publish must never inert the composer" rule moved out of a
	// source-text pin and into an executable one. The expression now lives in
	// src/patches/frontend/src/lib/utils/nativeInputLock.js and is covered
	// behaviourally by tests/native-input-lock.unit.test.js, which exercises the
	// rule for every kind instead of asserting how it happens to be written.
});
