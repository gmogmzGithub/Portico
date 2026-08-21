import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const APP_CSS_PATH = new URL('../src/patches/frontend/src/app.css', import.meta.url);
const CHAT_ITEM_PATH = new URL(
	'../src/patches/frontend/src/lib/components/layout/Sidebar/ChatItem.svelte',
	import.meta.url
);
const SIDEBAR_PATH = new URL(
	'../src/patches/frontend/src/lib/components/layout/Sidebar.svelte',
	import.meta.url
);

// Selector-aware rule lookup: returns the declaration block of the first rule
// whose comma-separated selector list contains `selector` exactly. Asserting
// through this keeps the contract ("this selector gets these declarations")
// stable when a rule gains sibling selectors (e.g. the tiling round OR'd
// `.portico-chat-canvas` into the #chat-container canvas rules).
const cssDeclarationsFor = (css, selector) => {
	let searchFrom = 0;
	while (true) {
		const braceIndex = css.indexOf('{', searchFrom);
		if (braceIndex === -1) {
			return null;
		}
		const selectorStart = Math.max(
			css.lastIndexOf('}', braceIndex),
			css.lastIndexOf('{', braceIndex - 1)
		);
		const selectorList = css
			.slice(selectorStart + 1, braceIndex)
			.split(',')
			.map((part) => part.trim());
		const closeIndex = css.indexOf('}', braceIndex);
		if (selectorList.includes(selector)) {
			return css.slice(braceIndex + 1, closeIndex === -1 ? undefined : closeIndex);
		}
		searchFrom = braceIndex + 1;
	}
};

test('light sidebar has a distinct Codex-like neutral surface and dimensional divider', async () => {
	const appCss = await fs.readFile(APP_CSS_PATH, 'utf8');

	assert.match(
		appCss,
		/--portico-sidebar-light-surface:\s*linear-gradient\([\s\S]*?#edeef0 0%[\s\S]*?#e9ebed 100%[\s\S]*?\);/
	);
	assert.match(
		appCss,
		/\.light #sidebar\s*\{[^}]*background:\s*var\(--portico-sidebar-light-surface\) !important;[^}]*border-right:\s*1px solid rgba\(15, 23, 42, 0\.1\) !important;[^}]*box-shadow:\s*2px 0 3px -2px rgba\(15, 23, 42, 0\.22\) !important;/s
	);
	assert.doesNotMatch(
		appCss,
		/\.light #sidebar\s*\{[^}]*box-shadow:\s*(?:10px 0|22px 0)/s
	);
	assert.match(
		appCss,
		/\.light #sidebar > div\s*\{[^}]*background:\s*transparent !important;/s
	);
});

test('chat rows use shared Codex hover and selection tokens without action gradients', async () => {
	const [appCss, chatItem] = await Promise.all([
		fs.readFile(APP_CSS_PATH, 'utf8'),
		fs.readFile(CHAT_ITEM_PATH, 'utf8')
	]);

	assert.match(appCss, /--portico-sidebar-light-hover:\s*rgba\(15, 23, 42, 0\.07\);/);
	assert.match(appCss, /--portico-sidebar-light-selected:\s*rgba\(15, 23, 42, 0\.1\);/);
	assert.match(
		appCss,
		/\.dark\s*\{[^}]*--portico-sidebar-row-hover:\s*rgba\(255, 255, 255, 0\.065\);[^}]*--portico-sidebar-row-selected:\s*rgba\(255, 255, 255, 0\.1\);/s
	);
	assert.match(
		appCss,
		/\.light #sidebar-chat-item\.selected,[^}]*background-color:\s*var\(--portico-sidebar-light-selected\) !important;/s
	);
	assert.match(appCss, /#sidebar-chat-item-menu,[\s\S]*?background-image:\s*none !important;/s);
	assert.doesNotMatch(chatItem, /bg-linear-to-l|group-hover:from|hover:bg\[#aeb9c8\]/);
	assert.match(chatItem, /class="sidebar-chat-action/);
});

test('Electron native sidebar material is alpha-gated while the chat canvas stays opaque', async () => {
	const [appCss, sidebar] = await Promise.all([
		fs.readFile(APP_CSS_PATH, 'utf8'),
		fs.readFile(SIDEBAR_PATH, 'utf8')
	]);

	assert.match(
		appCss,
		/html\.portico-native-sidebar-vibrancy body,[\s\S]*?html\.portico-native-sidebar-vibrancy \.app > div\s*\{[^}]*background:\s*transparent !important;/s
	);
	// Portaled floating panels (model picker, composer metrics, bits-ui menus)
	// live as direct <body> children; a blanket `body > div` in the vibrancy
	// block wipes their backgrounds with !important and must never come back.
	assert.doesNotMatch(appCss, /portico-native-sidebar-vibrancy body > div/);
	assert.match(appCss, /html\.portico-native-sidebar-vibrancy #splash-screen/);
	assert.match(
		appCss,
		/html\.portico-native-sidebar-vibrancy\.light\s*\{[^}]*--portico-sidebar-light-surface:\s*rgba\(255, 255, 255, 0\.22\);/s
	);
	assert.doesNotMatch(
		appCss,
		/html\.portico-native-sidebar-vibrancy\.light\s*\{[^}]*--portico-sidebar-light-surface:\s*(?:#|rgb\([^a])/s
	);
	// The chat canvas must stay opaque in vibrancy mode — for the main
	// #chat-container AND the shared tile canvas class (tiles carry suffixed
	// ids, so the canvas rules key on both).
	for (const canvasSelector of [
		'html.portico-native-sidebar-vibrancy #chat-container',
		'html.portico-native-sidebar-vibrancy .portico-chat-canvas'
	]) {
		assert.match(
			cssDeclarationsFor(appCss, canvasSelector) ?? '',
			/background:\s*#171717 !important;/,
			`${canvasSelector} keeps the opaque dark canvas`
		);
	}
	for (const canvasSelector of [
		'html.portico-native-sidebar-vibrancy.light #chat-container',
		'html.portico-native-sidebar-vibrancy.light .portico-chat-canvas'
	]) {
		assert.match(
			cssDeclarationsFor(appCss, canvasSelector) ?? '',
			/background:\s*var\(--portico-light-canvas\) !important;/,
			`${canvasSelector} keeps the opaque light canvas`
		);
	}
	assert.match(
		appCss,
		/html\.portico-native-sidebar-vibrancy\.light #sidebar\s*\{[^}]*background:\s*var\(--portico-sidebar-light-surface\) !important;[^}]*border-right:\s*0 !important;[^}]*box-shadow:\s*none !important;/s
	);
	assert.match(
		appCss,
		/html\.portico-native-sidebar-vibrancy #sidebar \.sidebar-bg-gradient-to-b\s*\{[^}]*background:\s*transparent !important;/s
	);
	assert.match(
		appCss,
		/html\.portico-native-sidebar-vibrancy\.light #sidebar::after\s*\{[^}]*rgba\(15, 23, 42, 0\.01\) 38%[^}]*rgba\(15, 23, 42, 0\.065\) 100%[^}]*inset -1px 0 rgba\(255, 255, 255, 0\.22\);/s
	);
	assert.match(
		appCss,
		/html\.portico-native-sidebar-vibrancy #sidebar::after\s*\{[^}]*z-index:\s*60;/s
	);
	assert.match(
		appCss,
		/html\.portico-native-sidebar-vibrancy #sidebar-resizer\s*\{[^}]*border:\s*0 !important;[^}]*background:\s*transparent !important;[^}]*box-shadow:\s*none !important;/s
	);
	assert.match(
		sidebar,
		/class="fixed top-0 left-\[var\(--sidebar-width\)\] z-\[70\] h-\[100dvh\] w-3\.5 -translate-x-1\/2 cursor-col-resize bg-transparent"/
	);
	assert.doesNotMatch(
		appCss,
		/html\.portico-native-sidebar-vibrancy #sidebar\s*\{[^}]*position:/s
	);
	assert.match(
		appCss,
		/html\.portico-native-sidebar-vibrancy #sidebar:not\(\[data-state\]\)\s*\{[^}]*position:\s*relative;/s
	);
	assert.match(
		sidebar,
		/id="sidebar"[\s\S]*?fixed top-0 left-0 overflow-x-hidden[\s\S]*?transition:slide=\{\{ duration: 250, axis: 'x' \}\}/s
	);
	assert.doesNotMatch(
		appCss,
		/html\.portico-native-sidebar-vibrancy(?:\.light)? #sidebar\s*\{[^}]*box-shadow:[^;}]*,/s
	);
	assert.match(
		appCss,
		/@media \(max-width: 767px\)\s*\{[\s\S]*?html\.portico-native-sidebar-vibrancy\.light #sidebar\s*\{[^}]*background:\s*#e4e5e7 !important;[\s\S]*?html\.portico-native-sidebar-vibrancy #sidebar::after\s*\{[^}]*display:\s*none;/s
	);
});
