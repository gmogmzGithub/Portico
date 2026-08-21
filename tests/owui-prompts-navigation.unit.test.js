const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..');
const SIDEBAR_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/layout/Sidebar.svelte'
);
const WORKSPACE_LAYOUT_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/routes/(app)/workspace/+layout.svelte'
);
const ROUTE_POLICY_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/utils/promptsManagementRoute.mjs'
);
const DOCKER_COMPOSE_PATH = path.join(REPO_ROOT, 'docker-compose.yml');

const countOccurrences = (source, value) => source.split(value).length - 1;

test('OWUI sidebar exposes Prompts directly in collapsed and expanded states', async () => {
	const source = await fs.readFile(SIDEBAR_PATH, 'utf8');
	const promptPermissionGate =
		"$user?.role === 'admin' || $user?.permissions?.workspace?.prompts";

	assert.equal(countOccurrences(source, promptPermissionGate), 2);
	assert.equal(countOccurrences(source, 'href="/workspace/prompts"'), 2);
	assert.equal(countOccurrences(source, "aria-label={$i18n.t('Prompts')}"), 2);
	assert.match(source, /Tooltip content=\{\$i18n\.t\('Prompts'\)\} placement="right"/);
	assert.match(source, /goto\('\/workspace\/prompts'\);/);
	assert.match(source, /id="sidebar-workspace-button"/);
	assert.match(
		source,
		/<div class=" self-center text-sm font-primary">\{\$i18n\.t\('Prompts'\)\}<\/div>/
	);
	assert.doesNotMatch(source, /href="\/workspace"/);
	assert.doesNotMatch(source, /\/workspace\/(?:models|knowledge|tools)/);
	assert.doesNotMatch(source, /\$i18n\.t\('Workspace'\)/);
});

test('normal authenticated users receive the complete Prompts library permission set', async () => {
	const compose = await fs.readFile(DOCKER_COMPOSE_PATH, 'utf8');

	for (const permission of ['ACCESS', 'IMPORT', 'EXPORT']) {
		assert.match(
			compose,
			new RegExp(`USER_PERMISSIONS_WORKSPACE_PROMPTS_${permission}=True`)
		);
	}

	assert.doesNotMatch(
		compose,
		/USER_PERMISSIONS_WORKSPACE_(?:MODELS|KNOWLEDGE|TOOLS)_ACCESS=True/
	);
});

test('Prompts route policy redirects legacy and unauthorized workspace paths', async () => {
	const routePolicy = await import(pathToFileURL(ROUTE_POLICY_PATH).href);

	for (const pathname of [
		'/workspace/prompts',
		'/workspace/prompts/create',
		'/workspace/prompts/edit'
	]) {
		assert.equal(routePolicy.isPromptsManagementPath(pathname), true);
		assert.equal(
			routePolicy.resolvePromptsManagementRedirect({ pathname, canManagePrompts: true }),
			null
		);
	}

	for (const pathname of [
		'/workspace',
		'/workspace/models',
		'/workspace/knowledge',
		'/workspace/tools',
		'/workspace/prompts-archive'
	]) {
		assert.equal(routePolicy.isPromptsManagementPath(pathname), false);
		assert.equal(
			routePolicy.resolvePromptsManagementRedirect({ pathname, canManagePrompts: true }),
			'/workspace/prompts'
		);
	}

	assert.equal(
		routePolicy.resolvePromptsManagementRedirect({
			pathname: '/workspace/prompts',
			canManagePrompts: false
		}),
		'/'
	);
});

test('workspace layout renders only the authorized Prompts subtree', async () => {
	const source = await fs.readFile(WORKSPACE_LAYOUT_PATH, 'utf8');

	assert.match(source, /resolvePromptsManagementRedirect/);
	assert.match(source, /await goto\(redirectTarget, \{ replaceState: true \}\);/);
	assert.match(
		source,
		/\{#if loaded && canManagePrompts && promptsManagementPathActive && !redirecting\}/
	);
	assert.match(source, /\{\$i18n\.t\('Prompts'\)\} • \{\$WEBUI_NAME\}/);
	assert.match(source, /href="\/workspace\/prompts"/);
	assert.doesNotMatch(source, /\/workspace\/(?:models|knowledge|tools)/);
	assert.doesNotMatch(source, /permissions\?\.workspace\?\.(?:models|knowledge|tools)/);
});
