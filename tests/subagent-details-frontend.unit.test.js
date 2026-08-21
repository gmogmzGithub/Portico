const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..');
const CHAT_SVELTE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/Chat.svelte'
);
const MODEL_SELECTION_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/utils/modelSelection.ts'
);

test('subagent details hydrate multimodal message arrays into display text', async () => {
	const source = await fs.readFile(CHAT_SVELTE_PATH, 'utf8');

	assert.ok(source.includes('formatHydratedContentArrayForDisplay'));
	assert.ok(source.includes('Image inputs attached for model analysis:'));
	assert.ok(source.includes('browserFacingWorkspaceUrl'));
	assert.ok(source.includes('normalizeHydratedMessageContent(message)'));
	const hydrationLoop = source.slice(source.indexOf('normalizeHydratedMessageContent(message)'));
	assert.ok(
		hydrationLoop.indexOf('normalizeHydratedMessageContent(message)') <
			hydrationLoop.indexOf("if (message?.role !== 'assistant')")
	);
});

test('chat model defaults tolerate string and array shapes', async () => {
	const chatSource = await fs.readFile(CHAT_SVELTE_PATH, 'utf8');
	const modelSelectionSource = await fs.readFile(MODEL_SELECTION_PATH, 'utf8');

	assert.ok(chatSource.includes('normalizeSelectedModelIds($config?.default_models)'));
	assert.ok(chatSource.includes('normalizeSelectedModelIds('));
	assert.ok(chatSource.includes('? chatContent.models'));
	assert.ok(!chatSource.includes('$config?.default_models.split'));
	assert.ok(modelSelectionSource.includes('candidateIds: unknown'));
	assert.ok(modelSelectionSource.includes("if (typeof candidateIds === 'string')"));
	assert.ok(modelSelectionSource.includes(".split(',')"));
});
