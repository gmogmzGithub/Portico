const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..');
const CHAT_SVELTE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/Chat.svelte'
);

test('chat composer allows new prompts after a done error-only assistant response', async () => {
	const source = await fs.readFile(CHAT_SVELTE_PATH, 'utf8');

	assert.ok(source.includes('if (lastMessage.done != true)'));
	assert.ok(!source.includes('Oops! There was an error in the previous response.'));
	assert.ok(!source.includes('lastMessage.error && !lastMessage.content'));
});

test('chat request payload still omits contentless non-user messages', async () => {
	const source = await fs.readFile(CHAT_SVELTE_PATH, 'utf8');

	assert.ok(
		source.includes(
			".filter((message) => message?.role === 'user' || message?.content?.trim());"
		)
	);
});
