const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..');
const PROMPTS_LIST_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/workspace/Prompts.svelte'
);
const PROMPT_EDITOR_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/workspace/Prompts/PromptEditor.svelte'
);
const PROMPT_ICON_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/workspace/Prompts/PromptIcon.svelte'
);
const WORKSPACE_LAYOUT_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/routes/(app)/workspace/+layout.svelte'
);
const APP_CSS_PATH = path.join(REPO_ROOT, 'src/patches/frontend/src/app.css');

const countOccurrences = (source, value) => source.split(value).length - 1;

test('Prompts index uses the product-native hero, library, and empty/search states', async () => {
	const source = await fs.readFile(PROMPTS_LIST_PATH, 'utf8');

	assert.match(source, /prompts as _prompts, showSidebar, user/);
	assert.match(source, /prompts-management-page[\s\S]*md:-translate-x-\[1\.625rem\][\s\S]*data-portico-rail-compensated/);
	assert.match(source, /class="prompts-management-hero"/);
	assert.match(source, /class="prompts-management-hero-icon"/);
	assert.match(source, /class="prompts-management-count"/);
	assert.match(source, /class="prompts-management-hero-actions"/);
	assert.match(source, /\{#if prompts\.length\}\s*<div class="prompts-management-hero-actions">/);
	assert.match(source, /class="prompts-empty-actions"[\s\S]*Create your first prompt[\s\S]*\$i18n\.t\('Import'\)/);
	assert.match(source, /\{#if prompts\.length === 0\}/);
	assert.match(source, /class="prompts-empty-state"/);
	assert.match(source, /class="prompts-library-surface"/);
	assert.match(source, /class="prompts-search-field"/);
	assert.match(source, /class="prompts-no-results"/);
	assert.match(source, /<article class="prompts-card">/);
	assert.match(source, /href=\{`\/workspace\/prompts\/edit\?command=/);
	assert.match(source, /aria-label=\{\$i18n\.t\('Actions for \{\{name\}\}'/);
	assert.doesNotMatch(source, /workspace-search-shell|workspace-prompt-card|workspace-card-grid/);
	assert.doesNotMatch(source, /😕/);
});

test('Prompt create, clone, and edit share one calm form surface and one primary action', async () => {
	const source = await fs.readFile(PROMPT_EDITOR_PATH, 'utf8');

	assert.match(source, /import \{ showSidebar \} from '\$lib\/stores';/);
	assert.match(source, /prompts-editor-page[\s\S]*md:-translate-x-\[1\.625rem\][\s\S]*data-portico-rail-compensated/);
	assert.match(source, /class="prompts-editor-hero"/);
	assert.match(source, /class="prompts-editor-command-preview"/);
	assert.match(source, /class="prompts-editor-surface"/);
	assert.match(source, /class="prompts-editor-step">1</);
	assert.match(source, /class="prompts-editor-step">2</);
	assert.match(source, /class="prompts-editor-fields-grid"/);
	assert.match(source, /className="prompts-editor-textarea"/);
	assert.match(source, /class="prompts-editor-actions"/);
	assert.match(source, /disabled=\{edit\}/);
	assert.equal(countOccurrences(source, 'type="submit"'), 1);
	assert.doesNotMatch(source, /<aside|Prompt Identity|rounded-\[2rem\]/);
});

test('Prompts-only layout uses a descendant breadcrumb without a redundant index tab', async () => {
	const source = await fs.readFile(WORKSPACE_LAYOUT_PATH, 'utf8');

	assert.match(source, /promptsIndexActive = \$page\.url\.pathname === '\/workspace\/prompts'/);
	assert.match(source, /\{#if \$mobile \|\| !promptsIndexActive\}/);
	assert.match(source, /class="prompts-workspace-back-link" href="\/workspace\/prompts"/);
	assert.match(source, /prompts-workspace-nav-inner[\s\S]*md:-translate-x-\[1\.625rem\][\s\S]*data-portico-rail-compensated/);
	assert.match(source, /class="workspace-shell-content prompts-workspace-content/);
	assert.doesNotMatch(source, /workspace-nav-pill/);
});

test('Prompts visual system shares the Scheduled Tasks canvas, keyline, and responsive contract', async () => {
	const [css, icon] = await Promise.all([
		fs.readFile(APP_CSS_PATH, 'utf8'),
		fs.readFile(PROMPT_ICON_PATH, 'utf8')
	]);

	assert.match(css, /\.prompts-workspace-shell \{[\s\S]*--prompts-surface:/);
	assert.match(css, /\.dark \.prompts-workspace-shell \{[\s\S]*background: #171717;/);
	assert.match(css, /\.prompts-empty-state,[\s\S]*\.prompts-editor-surface \{[\s\S]*var\(--prompts-shadow\)/);
	assert.match(css, /\.prompts-card:hover \{[\s\S]*translateY\(-1px\)/);
	assert.match(css, /\.prompts-empty-actions \{[\s\S]*justify-content: center;/);
	assert.match(css, /@media \(max-width: 767px\) \{[\s\S]*\.prompts-card-grid/);
	assert.match(icon, /viewBox="0 0 24 24"/);
	assert.match(icon, /aria-hidden="true"/);
});
