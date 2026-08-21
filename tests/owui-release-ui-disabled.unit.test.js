const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

test('the OWUI container disables upstream version checks', () => {
	const compose = read('docker-compose.yml');
	const openWebuiService = compose.match(/^  open-webui:\n([\s\S]*?)(?=^  [a-z0-9-]+:\n)/m)?.[1];

	assert.ok(openWebuiService, 'open-webui compose service must exist');
	assert.match(openWebuiService, /^      - ENABLE_VERSION_UPDATE_CHECK=False$/m);
});

test('upstream OWUI release components are hard-disabled', () => {
	const changelogModal = read(
		'src/patches/frontend/src/lib/components/ChangelogModal.svelte'
	);
	const updateToast = read(
		'src/patches/frontend/src/lib/components/layout/UpdateInfoToast.svelte'
	);

	assert.match(changelogModal, /export let show = false/);
	assert.match(changelogModal, /\$: if \(show\) \{\s*show = false;/);
	assert.doesNotMatch(changelogModal, /getChangelog|Release Notes|What's New in|<Modal/);

	assert.match(updateToast, /export let version/);
	assert.doesNotMatch(
		updateToast,
		/getVersionUpdates|new version|Update for the latest|github\.com\/open-webui|<div|<a/
	);
});

test('startup user settings also keep both OWUI release surfaces disabled', () => {
	const healthCheck = read('src/mcp-orc-rust/crates/health-check/src/app.rs');

	assert.match(healthCheck, /ui\.insert\("showChangelog"\.to_string\(\), json!\(false\)\);/);
	assert.match(healthCheck, /ui\.insert\("showUpdateToast"\.to_string\(\), json!\(false\)\);/);
});
