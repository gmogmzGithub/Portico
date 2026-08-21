const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

function readRepoFile(relativePath) {
	return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

test('sidebar exposes direct settings entrypoints in both sidebar states', () => {
	const source = readRepoFile('src/patches/frontend/src/lib/components/layout/Sidebar.svelte');

	assert.doesNotMatch(
		source,
		/import UserMenu from '\.\/Sidebar\/UserMenu\.svelte';/,
		'Sidebar should no longer use the profile dropdown menu'
	);
	assert.match(
		source,
		/id="sidebar-collapsed-settings-button"/,
		'collapsed sidebar rail should expose a direct settings trigger'
	);
	assert.match(
		source,
		/id="sidebar-expanded-settings-button"/,
		'expanded sidebar should expose a direct settings footer trigger'
	);
	assert.doesNotMatch(
		source,
		/showCollapsedUserMenu|showExpandedUserMenu|handleUserMenuShow|showArchivedChats/,
		'Sidebar should remove the old profile-menu and archived-chat routing state'
	);
	assert.match(
		source,
		/id="sidebar-collapsed-settings-button"[\s\S]*showSettings\.set\(true\);/s,
		'collapsed sidebar settings button should open the existing settings modal directly'
	);
	assert.doesNotMatch(
		source,
		/<div class="mt-auto pt-2">[\s\S]*id="sidebar-collapsed-settings-button"/s,
		'collapsed sidebar settings button should not sit in a special footer-spacing wrapper'
	);
	assert.match(
		source,
		/id="sidebar-expanded-settings-button"[\s\S]*showSettings\.set\(true\);/s,
		'expanded sidebar settings row should open the existing settings modal directly'
	);
	assert.doesNotMatch(
		source,
		/<button\s+class="flex flex-col flex-1 \{isWindows \? 'cursor-pointer' : 'cursor-\[e-resize\]'\}"/,
		'collapsed sidebar should not wrap the entire rail in a single button'
	);
});

test('sidebar no longer carries the old user menu width and placement plumbing', () => {
	const sidebarSource = readRepoFile('src/patches/frontend/src/lib/components/layout/Sidebar.svelte');

	assert.doesNotMatch(
		sidebarSource,
		/className="w-\[280px\]"|side="right"|sideOffset=\{8\}|side="top"|align="end"/,
		'Sidebar should no longer pass user-menu sizing or anchoring props'
	);
});

test('settings modal only exposes interface and data controls, with admin entry hidden', () => {
	const source = readRepoFile(
		'src/patches/frontend/src/lib/components/chat/SettingsModal.svelte'
	);

	assert.doesNotMatch(
		source,
		/import Search from '\.\.\/icons\/Search\.svelte';/,
		'settings modal should not import the search icon once the search box is removed'
	);
	assert.match(source, /id:\s*'interface'/, 'settings modal should keep the Interface tab');
	assert.match(
		source,
		/id:\s*'data_controls'/,
		'settings modal should keep the Data Controls tab'
	);
	assert.match(
		source,
		/let selectedTab:\s*SettingsTab\['id'\]\s*=\s*'interface';/,
		'settings modal should default to the Interface tab'
	);
	assert.doesNotMatch(
		source,
		/id:\s*'general'|id:\s*'connections'|id:\s*'tools'|id:\s*'personalization'|id:\s*'audio'|id:\s*'account'|id:\s*'about'/,
		'settings modal should not expose hidden categories in the visible tab list'
	);
	assert.doesNotMatch(
		source,
		/Admin Settings/,
		'settings modal should hide the Admin Settings link'
	);
	assert.doesNotMatch(
		source,
		/id="settings-search"|search-input-settings-modal|searchDebounceHandler|setFilteredSettings|No results found/,
		'settings modal should remove the search UI and filtering-only logic'
	);
	assert.doesNotMatch(
		source,
		/text-gray-300 dark:text-gray-600 hover:text-gray-700/,
		'settings modal should not use the washed-out light-mode inactive tab styling'
	);
	assert.match(
		source,
		/text-gray-900 dark:text-gray-100/,
		'settings modal should use a darker readable light-mode text palette'
	);
});

test('interface settings only render the UI Scale control', () => {
	const source = readRepoFile(
		'src/patches/frontend/src/lib/components/chat/Settings/Interface.svelte'
	);

	assert.match(source, /UI Scale/, 'interface settings should keep the UI Scale control');
	assert.doesNotMatch(
		source,
		/High Contrast Mode|Widescreen Mode|Notification Sound|Landing Page Mode|Chat Bubble UI|Save/,
		'interface settings should hide the rest of the interface controls and the save button'
	);
});
