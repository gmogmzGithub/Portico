const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCHEDULED_TASKS_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/routes/(app)/scheduled-tasks/+page.svelte'
);
const SCHEDULED_TASK_DETAIL_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/routes/(app)/scheduled-tasks/[taskId]/+page.svelte'
);
const SIDEBAR_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/layout/Sidebar.svelte'
);
const APP_CSS_PATH = path.join(REPO_ROOT, 'src/patches/frontend/src/app.css');
const SCHEDULED_TASK_ICON_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/scheduled-tasks/ScheduledTaskIcon.svelte'
);

test('scheduled tasks compact list and modal use the application surface tokens in both themes', async () => {
	const [source, detailSource, appCss, iconSource] = await Promise.all([
		fs.readFile(SCHEDULED_TASKS_PATH, 'utf8'),
		fs.readFile(SCHEDULED_TASK_DETAIL_PATH, 'utf8'),
		fs.readFile(APP_CSS_PATH, 'utf8'),
		fs.readFile(SCHEDULED_TASK_ICON_PATH, 'utf8')
	]);

	assert.ok(source.includes("import { models, showSidebar } from '$lib/stores';"));
	assert.match(
		source,
		/class="scheduled-tasks-shell relative flex h-screen max-h-\[100dvh\] w-full max-w-full flex-col transition-width duration-200 ease-in-out \{\$showSidebar\s*\? 'md:max-w-\[calc\(100%-var\(--sidebar-width\)\)\]'\s*: ''\}"/
	);
	assert.ok(
		source.includes(
			'class="scheduled-tasks-content flex-1 overflow-y-auto px-5 pb-12 pt-14 md:px-8"'
		)
	);
	for (const pageSource of [source, detailSource]) {
		assert.match(
			pageSource,
			/scheduled-tasks-page[\s\S]*md:-translate-x-\[1\.625rem\][\s\S]*data-portico-rail-compensated=\{\$showSidebar \? 'false' : 'true'\}/
		);
	}
	assert.match(source, /<header class="scheduled-task-compact-header">/);
	assert.match(source, /Plan work once, or keep it moving on a recurring schedule./);
	assert.match(source, /scheduled-task-button scheduled-task-button-primary/);
	assert.match(source, /class="scheduled-task-toolbar"/);
	assert.match(source, /class="scheduled-task-compact-table"/);
	assert.match(source, /class="scheduled-task-compact-row"/);
	assert.match(source, /class="scheduled-task-expand-panel"/);
	assert.match(source, /class="scheduled-task-modal-scrim"/);
	assert.match(source, /class="scheduled-task-modal"/);
	assert.match(source, /No scheduled tasks yet/);
	assert.match(appCss, /\.scheduled-tasks-shell,[\s\S]*background: var\(--portico-light-canvas\);/);
	assert.match(appCss, /\.scheduled-task-compact-table\s*\{[^}]*background: var\(--scheduled-surface\);[^}]*box-shadow: var\(--scheduled-shadow\);/s);
	assert.match(appCss, /\.scheduled-task-compact-row:hover,[\s\S]*background: var\(--scheduled-surface-muted\);/s);
	assert.match(appCss, /\.scheduled-task-row-caret\s*\{[^}]*top: 50%;[^}]*display: flex;[^}]*align-items: center;[^}]*transform: translateY\(-50%\);/s);
	assert.match(appCss, /\.scheduled-task-compact-row\.expanded \.scheduled-task-row-caret\s*\{[^}]*transform: translateY\(-50%\) rotate\(180deg\);/s);
	assert.match(appCss, /\.scheduled-task-detail-run-row\s*\{[^}]*grid-template-columns: 11rem 8rem minmax\(0, 1fr\) 1rem;[^}]*text-align: left;[^}]*transition: background-color 120ms ease;/s);
	assert.match(appCss, /\.scheduled-task-detail-run-row:not\(:disabled\):hover\s*\{[^}]*background: var\(--scheduled-surface-muted\);/s);
	assert.match(appCss, /\.scheduled-task-modal-scrim\s*\{[^}]*position: fixed;[^}]*background: rgba\(15, 23, 42, 0\.46\);/s);
	assert.doesNotMatch(appCss, /\.scheduled-task-modal-scrim\s*\{[^}]*backdrop-filter:/s);
	assert.match(appCss, /\.scheduled-task-modal\s*\{[^}]*background: var\(--scheduled-surface\);/s);
	assert.match(appCss, /\.dark \.scheduled-tasks-page,[\s\S]*\.dark \.scheduled-task-modal-scrim\s*\{[^}]*--scheduled-surface:/s);
	assert.match(appCss, /@media \(max-width: 639px\)[\s\S]*\.scheduled-task-column-head\s*\{\s*display: none;/s);
	assert.match(iconSource, /data-scheduled-task-icon=\{kind\}/);
	assert.match(iconSource, /kind === 'enabled'/);
	assert.match(iconSource, /kind === 'history'/);
	assert.ok(source.includes('listScheduledTaskCapabilities'));
	assert.ok(source.includes('selectedSkillIds'));
	assert.ok(source.includes('selectedToolServerIds'));
	assert.ok(!source.includes('<SkillPicker'));
	assert.ok(source.includes('<McpServerPicker'));
	assert.ok(!source.includes('bind:value={skillIds}'));
	assert.ok(!source.includes('bind:value={toolServerIds}'));
	assert.ok(!source.includes('>Skill ids<'));
	assert.ok(!source.includes('>MCP server ids<'));
});

test('scheduled tasks sidebar item matches neighboring top nav styling', async () => {
	const [sidebarSource, appCssSource] = await Promise.all([
		fs.readFile(SIDEBAR_PATH, 'utf8'),
		fs.readFile(APP_CSS_PATH, 'utf8')
	]);

	assert.match(
		appCssSource,
		/#sidebar-new-chat-button \.text-sm,\s*#sidebar-search-button \.text-sm,\s*#sidebar-notes-button \.text-sm,\s*#sidebar-scheduled-tasks-button \.text-sm,\s*#sidebar-workspace-button \.text-sm\s*\{\s*font-size: var\(--portico-shell-font-size\) !important;\s*\}/m
	);
	assert.match(
		appCssSource,
		/\.light #sidebar #sidebar-new-chat-button,\s*\.light #sidebar #sidebar-search-button,\s*\.light #sidebar #sidebar-notes-button,\s*\.light #sidebar #sidebar-scheduled-tasks-button,\s*\.light #sidebar #sidebar-workspace-button\s*\{\s*border: none !important;\s*\}/m
	);
	assert.match(
		appCssSource,
		/\.light #sidebar #sidebar-new-chat-button:hover,\s*\.light #sidebar #sidebar-search-button:hover,\s*\.light #sidebar #sidebar-notes-button:hover,\s*\.light #sidebar #sidebar-scheduled-tasks-button:hover,\s*\.light #sidebar #sidebar-workspace-button:hover\s*\{\s*background-color: var\(--portico-sidebar-light-hover\) !important;\s*border-color: transparent !important;\s*\}/m
	);
	assert.match(
		sidebarSource,
		/id="sidebar-scheduled-tasks-button"\s+class="group grow flex items-center space-x-3 rounded-2xl px-2\.5 py-2 hover:bg-gray-100 dark:hover:bg-gray-900 transition outline-none"/
	);
	assert.match(
		sidebarSource,
		/id="sidebar-scheduled-tasks-button"[\s\S]*<div class="flex flex-1 self-center translate-y-\[0\.5px\]">\s*<div class=" self-center text-sm font-primary">\{\$i18n\.t\('Scheduled Tasks'\)\}<\/div>/m
	);
	assert.equal((sidebarSource.match(/sidebar-hotkey-hint/g) ?? []).length, 2);
	assert.match(
		appCssSource,
		/\.light #sidebar \.sidebar-hotkey-hint\s*\{[^}]*color:\s*#475569 !important;/s
	);
	assert.match(
		appCssSource,
		/#sidebar-new-chat-button:hover \.sidebar-hotkey-hint,[\s\S]*#sidebar-search-button:focus-visible \.sidebar-hotkey-hint\s*\{[^}]*color:\s*#1e293b !important;/s
	);
});
