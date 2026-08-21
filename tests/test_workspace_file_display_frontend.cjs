const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..');
const RESPONSE_MESSAGE_SVELTE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/Messages/ResponseMessage.svelte'
);
const COLLAPSIBLE_SVELTE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/common/Collapsible.svelte'
);
const MARKDOWN_TOKENS_SVELTE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/Messages/Markdown/MarkdownTokens.svelte'
);
const MARKDOWN_SVELTE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/Messages/Markdown.svelte'
);
const CONTENT_RENDERER_SVELTE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/Messages/ContentRenderer.svelte'
);
const DISPLAY_FILES_INLINE_SVELTE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/Messages/Markdown/DisplayFilesInline.svelte'
);

test('ResponseMessage no longer renders a bottom gallery from tool-result files', async () => {
	const source = await fs.readFile(RESPONSE_MESSAGE_SVELTE_PATH, 'utf8');

	assert.match(source, /function getVisibleInlineImageFiles\(_message: MessageType\): any\[]/);
	assert.match(source, /return \[];/);
	assert.doesNotMatch(
		source,
		/getVisibleInlineImageFiles[\s\S]*getToolResultImageFilesFromContentBlocks\(message\?\.contentBlocks\)/
	);
	assert.match(source, /Explicit file display renders at the tool-call location/);
});

test('Collapsible does not render Display Files previews inside the accordion', async () => {
	const source = await fs.readFile(COLLAPSIBLE_SVELTE_PATH, 'utf8');

	assert.doesNotMatch(source, /isDisplayFilesToolName/);
	assert.doesNotMatch(source, /agent_vm_display_files/);
	assert.doesNotMatch(source, /display_files/);
	assert.doesNotMatch(source, /data-display-files-inline/);
});

test('MarkdownTokens renders DisplayFilesInline as a sibling after tool call collapsibles', async () => {
	const source = await fs.readFile(MARKDOWN_TOKENS_SVELTE_PATH, 'utf8');

	assert.match(source, /import DisplayFilesInline from '\.\/DisplayFilesInline\.svelte';/);
	assert.match(
		source,
		/import \{ isDisplayFilesToolCall \} from '\$lib\/utils\/work-activity-summary\.mjs';/
	);
	assert.match(
		source,
		/<\/Collapsible>\s*\{#if renderDisplayFilesInline && isDisplayFilesToolCall\(token\?\.attributes\)\}\s*<DisplayFilesInline[\s\S]*attributes=\{token\?\.attributes\}/
	);
	assert.match(
		source,
		/<\/Collapsible>\s*\{#if renderDisplayFilesInline && isDisplayFilesToolCall\(segment\.attributes\)\}\s*<DisplayFilesInline[\s\S]*attributes=\{segment\.attributes\}/
	);
});

test('ResponseMessage projects Display Files output while activity renderers suppress duplicates', async () => {
	const [responseSource, contentRendererSource, markdownSource, markdownTokensSource] =
		await Promise.all([
			fs.readFile(RESPONSE_MESSAGE_SVELTE_PATH, 'utf8'),
			fs.readFile(CONTENT_RENDERER_SVELTE_PATH, 'utf8'),
			fs.readFile(MARKDOWN_SVELTE_PATH, 'utf8'),
			fs.readFile(MARKDOWN_TOKENS_SVELTE_PATH, 'utf8')
		]);

	assert.match(responseSource, /import DisplayFilesInline from '\.\/Markdown\/DisplayFilesInline\.svelte';/);
	assert.match(
		responseSource,
		/segment\.type === 'display_files'[\s\S]*<DisplayFilesInline[\s\S]*attributes=\{segment\.attributes\}/
	);
	assert.match(responseSource, /renderDisplayFilesInline=\{segment\.type !== 'activity'\}/);

	assert.match(contentRendererSource, /export let renderDisplayFilesInline = true;/);
	assert.match(contentRendererSource, /<Markdown[\s\S]*\{renderDisplayFilesInline\}/);
	assert.match(markdownSource, /export let renderDisplayFilesInline = true;/);
	assert.match(markdownSource, /<MarkdownTokens[\s\S]*\{renderDisplayFilesInline\}/);
	assert.match(markdownTokensSource, /export let renderDisplayFilesInline = true;/);
	assert.match(
		markdownTokensSource,
		/<svelte:self[\s\S]*?\{renderDisplayFilesInline\}[\s\S]*?\/>/
	);
});

test('DisplayFilesInline supports files attributes and display_files result fallback', async () => {
	const source = await fs.readFile(DISPLAY_FILES_INLINE_SVELTE_PATH, 'utf8');

	assert.match(source, /extractFilesAttribute\(attributes\?\.files\)/);
	assert.match(source, /extractDisplayPayloadFiles\(attributes\?\.result\)/);
	assert.match(source, /\$: resultDisplayFiles = extractDisplayPayloadFiles\(attributes\?\.result\);/);
	assert.match(
		source,
		/resultDisplayFiles\.length > 0 \? resultDisplayFiles : extractFilesAttribute\(attributes\?\.files\)/
	);
	assert.match(source, /record\.display_files === true && Array\.isArray\(record\.files\)/);
	assert.match(source, /record\.type === 'image'/);
	assert.match(source, /record\.is_image === true/);
	assert.match(source, /contentType\.startsWith\('image\/'\)/);
	assert.match(source, /selectDisplayFileUrl\(record, isImage\)/);
	assert.match(source, /<Image[\s\S]*src=\{file\.url\}[\s\S]*alt=\{file\.name\}/);
});
