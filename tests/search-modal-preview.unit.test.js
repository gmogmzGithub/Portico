const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { before, test } = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..');
const SEARCH_MODAL_SVELTE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/layout/SearchModal.svelte'
);

let searchModalSource;

before(async () => {
	searchModalSource = await fs.readFile(SEARCH_MODAL_SVELTE_PATH, 'utf8');
});

test('search chat preview scrolls to the top instead of the bottom after render', () => {
	assert.equal(searchModalSource.includes('scrollTop = messagesContainerElement.scrollHeight'), false);
	assert.equal(searchModalSource.includes('function scrollChatPreviewToTop(chatId: string)'), true);
	assert.match(
		searchModalSource,
		/messagesContainerElement\?\.scrollTo\(\{\s*top:\s*0,\s*behavior:\s*'auto'\s*\}\);/
	);
	assert.match(
		searchModalSource,
		/await tick\(\);\s*if \(messageId\) \{\s*scrollChatPreviewToMessage\(chatId, messageId\);\s*\} else \{\s*scrollChatPreviewToTop\(chatId\);\s*window\.requestAnimationFrame\(\(\) => \{\s*scrollChatPreviewToTop\(chatId\);\s*\}\);\s*\}/
	);
	assert.match(searchModalSource, /<Messages[\s\S]*autoScroll=\{false\}[\s\S]*\/>/);
});

test('search result group headers keep first Today label breathing room', () => {
	const firstHeaderSpacingMatches =
		searchModalSource.match(
			/font-medium \{idx ===\s*0\s*\?\s*'pt-2'\s*:\s*'pt-5'\} pb-2 px-2"/g
		) ?? [];

	assert.equal(firstHeaderSpacingMatches.length, 2);
	assert.equal(searchModalSource.includes("? ''\n\t\t\t\t\t\t\t\t\t\t\t: 'pt-5'} pb-2 px-2\""), false);
});
