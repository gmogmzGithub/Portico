const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { build } = require('../electron-app/node_modules/esbuild');
const { marked } = require('../electron-app/node_modules/marked');

const REPO_ROOT = path.resolve(__dirname, '..');

let tempDir;
let reasoningMarkup;
let textTokenSource;

const bundleModule = async (entryPath, outFile) => {
	await build({
		entryPoints: [path.join(REPO_ROOT, entryPath)],
		bundle: true,
		format: 'cjs',
		platform: 'node',
		target: ['node20'],
		logLevel: 'silent',
		outfile: outFile
	});

	return require(outFile);
};

before(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reasoning-markup-tests-'));
	reasoningMarkup = await bundleModule(
		'src/patches/frontend/src/lib/utils/reasoningMarkup.ts',
		path.join(tempDir, 'reasoningMarkup.cjs')
	);
	textTokenSource = await fs.readFile(
		path.join(
			REPO_ROOT,
			'src/patches/frontend/src/lib/components/chat/Messages/Markdown/MarkdownInlineTokens/TextToken.svelte'
		),
		'utf8'
	);
});

after(async () => {
	if (tempDir) {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test('normalizes complete legacy thinking markup into reasoning details', () => {
	const normalized = reasoningMarkup.normalizeLegacyReasoningMarkup(
		'Before\n<thinking>Map the next step.</thinking>\nAfter'
	);

	assert.match(normalized, /<details type="reasoning" done="true">/);
	assert.match(normalized, /<summary>Thought<\/summary>/);
	assert.match(normalized, /Map the next step\./);
	assert.doesNotMatch(normalized, /<thinking>/);
});

test('does not rewrite legacy reasoning tags inside code spans or fences', () => {
	const content = [
		'Inline `<thinking>literal</thinking>` should stay the same.',
		'```md',
		'<thinking>literal fence</thinking>',
		'```'
	].join('\n');

	const normalized = reasoningMarkup.normalizeLegacyReasoningMarkup(content);

	assert.equal(normalized, content);
});

test('does not rewrite inline literal legacy reasoning tags', () => {
	const content = 'The literal string <thinking>example</thinking> should stay visible.';

	const normalized = reasoningMarkup.normalizeLegacyReasoningMarkup(content);

	assert.equal(normalized, content);
});

test('allows code inside a complete legacy reasoning block', () => {
	const content =
		'<think>Compare `job_status=EXPIRED` before continuing.</think>Visible continuation';
	const normalized = reasoningMarkup.normalizeLegacyReasoningMarkup(content);

	assert.match(normalized, /<details type="reasoning" done="true">/);
	assert.match(normalized, /Compare `job_status=EXPIRED` before continuing\./);
	assert.match(normalized, /<\/details>Visible continuation$/);
	assert.doesNotMatch(normalized, /<\/?think>/);
});

test('normalizes line-start reasoning followed immediately by visible prose', () => {
	const normalized = reasoningMarkup.normalizeLegacyReasoningMarkup(
		'<think>Inspect one more result.</think>Continue with the visible answer.'
	);

	assert.match(normalized, /<details type="reasoning" done="true">/);
	assert.match(normalized, /Inspect one more result\./);
	assert.match(normalized, /<\/details>Continue with the visible answer\./);
	assert.doesNotMatch(normalized, /<think>/);
});

test('decodes HTML entities through the escaped text-token display path', () => {
	const tokens = marked.lexer(
		'[Doc](https://example.com/doc) &nbsp;•&nbsp; [Download](https://example.com/file)'
	);
	const separator = tokens[0].tokens.find((token) => token.type === 'text');

	assert.equal(separator.raw, ' &nbsp;•&nbsp; ');
	assert.match(textTokenSource, /import \{ unescapeHtml \} from '\$lib\/utils';/);
	assert.match(textTokenSource, /raw\.includes\('&'\) \? \(unescapeHtml\(raw\) \?\? raw\) : raw/);
	assert.match(textTokenSource, /const text = decodeTextToken\(raw\);/);
	assert.match(textTokenSource, /\{renderedText\}/);
	assert.doesNotMatch(textTokenSource, /\{token\?\.raw\}/);
});

test('thought header time is hidden for reasoning details without any measured duration', () => {
	// Converted legacy/leaked blocks carry no duration attribute and never
	// streamed in this client — no fabricated "Thought 0s".
	assert.equal(reasoningMarkup.shouldShowThoughtDuration({}, 0), false);
	assert.equal(reasoningMarkup.shouldShowThoughtDuration(undefined, 0), false);
	assert.equal(reasoningMarkup.shouldShowThoughtDuration({ duration: 'None' }, 0), false);
	assert.equal(reasoningMarkup.shouldShowThoughtDuration({ duration: 'abc' }, 0), false);

	// Measured durations (including a genuine 0s) and live-tracked elapsed
	// time keep the label.
	assert.equal(reasoningMarkup.shouldShowThoughtDuration({ duration: '5' }, 0), true);
	assert.equal(reasoningMarkup.shouldShowThoughtDuration({ duration: '0' }, 0), true);
	assert.equal(reasoningMarkup.shouldShowThoughtDuration({}, 12), true);
});

test('exports structured streaming markers for legacy reasoning tags', () => {
	assert.equal(
		reasoningMarkup.EXTRA_REASONING_STREAMING_MARKERS.some((pattern) =>
			pattern.test('<thinking>')
		),
		true
	);
	assert.equal(
		reasoningMarkup.EXTRA_REASONING_STREAMING_MARKERS.some((pattern) =>
			pattern.test('</thinking>')
		),
		true
	);
});
