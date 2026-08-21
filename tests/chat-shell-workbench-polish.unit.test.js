import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const APP_CSS = new URL('../src/patches/frontend/src/app.css', import.meta.url);
const ELECTRON_CSS = new URL('../electron-app/src/styles.css', import.meta.url);
const SIDEBAR = new URL(
	'../src/patches/frontend/src/lib/components/layout/Sidebar.svelte',
	import.meta.url
);
const CHAT_MENU = new URL(
	'../src/patches/frontend/src/lib/components/layout/Sidebar/ChatMenu.svelte',
	import.meta.url
);
const MESSAGE_INPUT = new URL(
	'../src/patches/frontend/src/lib/components/chat/MessageInput.svelte',
	import.meta.url
);
const ACTIVE_CAPABILITIES = new URL(
	'../src/patches/frontend/src/lib/components/chat/ActiveCapabilities.svelte',
	import.meta.url
);
const COMPOSER_METRICS = new URL(
	'../src/patches/frontend/src/lib/components/chat/MessageInput/ComposerMetrics.svelte',
	import.meta.url
);
const MODEL_SELECTOR = new URL(
	'../src/patches/frontend/src/lib/components/chat/ModelSelector.svelte',
	import.meta.url
);
const MODEL_SELECTOR_MENU = new URL(
	'../src/patches/frontend/src/lib/components/chat/ModelSelector/Selector.svelte',
	import.meta.url
);
const NAVBAR = new URL(
	'../src/patches/frontend/src/lib/components/chat/Navbar.svelte',
	import.meta.url
);
const PLACEHOLDER = new URL(
	'../src/patches/frontend/src/lib/components/chat/Placeholder.svelte',
	import.meta.url
);
const REASONING_CONTROL = new URL(
	'../src/patches/frontend/src/lib/components/chat/MessageInput/ReasoningEffortControl.svelte',
	import.meta.url
);
const ANIMATED_ATLAS_LOGO = new URL(
	'../src/patches/frontend/src/lib/components/common/AnimatedAtlasLogo.svelte',
	import.meta.url
);
const MODEL_BRANDING = new URL(
	'../src/patches/frontend/src/lib/utils/modelBranding.ts',
	import.meta.url
);
const ANIMATED_TERRA_LOGO = new URL(
	'../src/patches/frontend/src/lib/components/common/AnimatedTerraLogo.svelte',
	import.meta.url
);
const RESPONSE_MESSAGE = new URL(
	'../src/patches/frontend/src/lib/components/chat/Messages/ResponseMessage.svelte',
	import.meta.url
);
const CHAT_LINK_INTERACTION = new URL(
	'../src/patches/frontend/src/lib/utils/chat-link-interaction.mjs',
	import.meta.url
);
const MARKDOWN_INLINE_TOKENS = new URL(
	'../src/patches/frontend/src/lib/components/chat/Messages/Markdown/MarkdownInlineTokens.svelte',
	import.meta.url
);
const CODE_SPAN_TOKEN = new URL(
	'../src/patches/frontend/src/lib/components/chat/Messages/Markdown/MarkdownInlineTokens/CodespanToken.svelte',
	import.meta.url
);
const WEB_SEARCH_RESULTS = new URL(
	'../src/patches/frontend/src/lib/components/chat/Messages/ResponseMessage/WebSearchResults.svelte',
	import.meta.url
);
const CITATION_MODAL = new URL(
	'../src/patches/frontend/src/lib/components/chat/Messages/Citations/CitationModal.svelte',
	import.meta.url
);
const OPEN_WEBUI_DOCKERFILE = new URL('../Dockerfile.open-webui-patched', import.meta.url);

test('sidebar resize target is centered on the visual seam', async () => {
	const source = await fs.readFile(SIDEBAR, 'utf8');

	assert.match(
		source,
		/id="sidebar-resizer"[\s\S]*?on:mousedown=\{resizeStartHandler\}[\s\S]*?role="separator"/
	);
	assert.match(source, /left-\[var\(--sidebar-width\)\]/);
	assert.match(source, /w-3\.5 -translate-x-1\/2 cursor-col-resize/);
	assert.doesNotMatch(source, /-left-1\.5 -right-1\.5/);
});

test('runtime menus use shared surfaces, row hover tokens, and collision padding', async () => {
	const [css, chatMenu, messageInput, dockerfile] = await Promise.all([
		fs.readFile(APP_CSS, 'utf8'),
		fs.readFile(CHAT_MENU, 'utf8'),
		fs.readFile(MESSAGE_INPUT, 'utf8'),
		fs.readFile(OPEN_WEBUI_DOCKERFILE, 'utf8')
	]);

	assert.match(css, /--portico-menu-surface:/);
	assert.match(css, /--portico-menu-shadow:/);
	assert.match(css, /\[role='menu'\]:not\(\.model-selector-content\)/);
	assert.match(
		css,
		/\.portico-menu-item\[data-highlighted\],[\s\S]*?background:\s*var\(--portico-sidebar-row-hover\) !important;/s
	);
	assert.match(chatMenu, /portico-menu-surface w-full max-w-\[200px\]/);
	assert.match(chatMenu, /portico-menu-submenu w-full/);
	assert.match(chatMenu, /collisionPadding=\{12\}/);
	assert.match(messageInput, /class="portico-menu-surface w-full max-w-48"/);
	assert.match(messageInput, /collisionPadding=\{12\}/);
	assert.match(dockerfile, /grep -Fq "portico-menu-surface"/);
	assert.doesNotMatch(dockerfile, /grep -Fq "bg-\[rgba\(195,203,216,0\.98\)\]"/);
});

test('composer uses diffused elevation and a visible light reasoning pill', async () => {
	const [css, messageInput] = await Promise.all([
		fs.readFile(APP_CSS, 'utf8'),
		fs.readFile(MESSAGE_INPUT, 'utf8')
	]);

	assert.doesNotMatch(messageInput, /id="message-input-container"[\s\S]{0,180}\bshadow-lg\b/);
	assert.match(
		css,
		/#message-input-container\s*\{[^}]*0 1px 3px rgba\(15, 23, 42, 0\.075\)[^}]*0 11px 30px -17px/s
	);
	assert.doesNotMatch(css, /#message-input-container\s*\{[^}]*0 26px 64px -36px/s);
	assert.match(css, /--owui-pill-bg-light:\s*rgba\(15, 23, 42, 0\.065\);/);
	assert.match(css, /--owui-pill-border-light:\s*rgba\(15, 23, 42, 0\.08\);/);
	assert.match(css, /\.capability-pill\s*\{[^}]*border:\s*1px solid var\(--owui-pill-border-light\)/s);
});

test('artifact count uses the same composer pill surface while retaining its identity icon', async () => {
	const [css, activeCapabilities] = await Promise.all([
		fs.readFile(APP_CSS, 'utf8'),
		fs.readFile(ACTIVE_CAPABILITIES, 'utf8')
	]);

	assert.match(
		activeCapabilities,
		/capability-pill capability-pill--interactive capability-pill--artifact/
	);
	assert.match(
		css,
		/\.capability-pill--artifact\s*\{[^}]*background:\s*var\(--owui-pill-bg-light\);[^}]*border-color:\s*var\(--owui-pill-border-light\);[^}]*color:\s*var\(--owui-pill-text-light\);/s
	);
	assert.match(
		css,
		/\.dark \.capability-pill--artifact\s*\{[^}]*background:\s*var\(--owui-pill-bg-dark\);[^}]*border-color:\s*rgba\(255,\s*255,\s*255,\s*0\.08\);[^}]*color:\s*var\(--owui-pill-text-dark\);/s
	);
	assert.match(
		css,
		/\.capability-pill--artifact > svg\s*\{[^}]*color:\s*var\(--owui-artifact-accent-light\);/s
	);
	assert.match(css, /\.capability-pill--interactive:focus-visible\s*\{[^}]*outline:/s);
});

test('chat shell typography shares a 12px token without flattening message prose', async () => {
	const [css, electronCss] = await Promise.all([
		fs.readFile(APP_CSS, 'utf8'),
		fs.readFile(ELECTRON_CSS, 'utf8')
	]);

	assert.match(css, /--portico-shell-font-size:\s*12px;/);
	assert.match(
		css,
		/#sidebar,[\s\S]*?#message-input-rail,[\s\S]*?\.model-selector-content,[\s\S]*?font-size:\s*var\(--portico-shell-font-size\) !important;/s
	);
	assert.match(
		css,
		/:is\(#messages-container, #chat-preview\) \.prose,[\s\S]*?font-size:\s*0\.9rem !important;/s
	);
	assert.match(
		electronCss,
		/\.header :is\(\.mcp-badge, \.mcp-operation-banner, \.tab-btn, \.tab-label, \.tab-rename-input\)\s*\{[^}]*font-size:\s*12px;/s
	);
});

test('landing hero is centered and the model chooser lives in the composer', async () => {
	const [css, messageInput, modelSelector, navbar, placeholder] = await Promise.all([
		fs.readFile(APP_CSS, 'utf8'),
		fs.readFile(MESSAGE_INPUT, 'utf8'),
		fs.readFile(MODEL_SELECTOR, 'utf8'),
		fs.readFile(NAVBAR, 'utf8'),
		fs.readFile(PLACEHOLDER, 'utf8')
	]);

	assert.match(messageInput, /<ModelSelector bind:selectedModels compact=\{true\} \/>/);
	assert.match(
		modelSelector,
		/data-model-selector-placement=\{compact \? 'composer' : formField \? 'form' : 'navbar'\}/
	);
	assert.doesNotMatch(navbar, /<ModelSelector/);
	assert.match(placeholder, /portico-landing-shell[^\n]*min-h-full[^\n]*justify-center/);
	assert.match(
		placeholder,
		/class="portico-landing-hero \{isAgentModel \? 'portico-landing-hero--agent' : ''\}"/
	);
	assert.match(placeholder, /What should we work on today\?/);
	assert.match(placeholder, /primaryModelLogoSources = getModelLogoSources/);
	assert.match(placeholder, /getStreamingModelLogoMotionStyle/);
	assert.match(placeholder, /data-model-logo-ambient="true"/);
	assert.match(css, /\.portico-landing-hero h1\s*\{[^}]*font-size:\s*clamp\(2rem, 4vw, 3rem\)/s);
});

test('dark menus stay readable and native rail layers remain translucent', async () => {
	const css = await fs.readFile(APP_CSS, 'utf8');

	assert.match(css, /html\.dark :is\(\.portico-menu-surface,[\s\S]*?color:\s*#f3f4f6 !important;/s);
	assert.match(
		css,
		/html\.portico-native-sidebar-vibrancy #sidebar\s*\{[^}]*background:\s*transparent !important;/s
	);
	assert.match(css, /html\.portico-native-sidebar-vibrancy #sidebar\s*\{[^}]*backdrop-filter:\s*none;/s);
	assert.match(
		css,
		/html\.portico-native-sidebar-vibrancy\.dark #sidebar\s*\{[^}]*background:\s*#0d0d0d !important;/s
	);
});

test('model and reasoning controls align right with a discrete animated gradient slider', async () => {
	const [css, messageInput, reasoningControl, modelSelector, modelSelectorMenu] = await Promise.all([
		fs.readFile(APP_CSS, 'utf8'),
		fs.readFile(MESSAGE_INPUT, 'utf8'),
		fs.readFile(REASONING_CONTROL, 'utf8'),
		fs.readFile(MODEL_SELECTOR, 'utf8'),
		fs.readFile(MODEL_SELECTOR_MENU, 'utf8')
	]);

	assert.match(css, /\.composer-intelligence-control\s*\{[^}]*order:\s*90;[^}]*margin-left:\s*auto;/s);
	assert.match(
		css,
		/\.composer-intelligence-control\s*\{[^}]*border:\s*1px solid var\(--portico-menu-border\);[^}]*background:\s*var\(--portico-menu-surface\);/s
	);
	assert.match(
		css,
		// Round 10: content-grown width (min 7.25rem) — a hard width made wide
		// labels ("Extra High") overflow their grid column into the chevron.
		/\.composer-reasoning-control\s*\{[^}]*inline-size:\s*auto;[^}]*min-inline-size:\s*7\.25rem;[^}]*flex:\s*0 0 auto;[^}]*height:\s*100%;[^}]*min-height:\s*100%;[^}]*max-height:\s*100%;[^}]*overflow:\s*hidden;/s
	);
	assert.match(
		css,
		/\.composer-intelligence-control\s*\{[^}]*box-sizing:\s*border-box;[^}]*height:\s*var\(--owui-capability-pill-height\);[^}]*min-height:\s*var\(--owui-capability-pill-height\);[^}]*max-height:\s*var\(--owui-capability-pill-height\);[^}]*align-self:\s*center;/s
	);
	assert.match(
		css,
		/\.composer-metrics-row,\s*\.composer-active-capabilities\s*\{[^}]*height:\s*var\(--owui-capability-pill-height\);[^}]*min-height:\s*var\(--owui-capability-pill-height\);[^}]*max-height:\s*var\(--owui-capability-pill-height\);[^}]*align-items:\s*center;/s
	);
	assert.match(
		css,
		// Round 10 widened the chevron track (1.25rem) so wide labels keep clearance.
		/\.reasoning-effort-trigger\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*1rem minmax\(0, 1fr\) 1\.25rem;[^}]*inline-size:\s*100%;[^}]*min-inline-size:\s*100%;[^}]*height:\s*100%;[^}]*min-height:\s*100%;[^}]*max-height:\s*100%;[^}]*align-items:\s*center;[^}]*background:\s*transparent;/s
	);
	assert.match(
		css,
		/\.reasoning-effort-trigger > span\s*\{[^}]*width:\s*100%;[^}]*text-align:\s*center;/s
	);
	assert.match(
		css,
		/\.composer-reasoning-control:hover\s*\{[^}]*background:\s*var\(--owui-composer-control-bg-light\);/s
	);
	assert.match(
		css,
		/\.dark \.composer-reasoning-control:hover\s*\{[^}]*background:\s*var\(--owui-composer-control-bg-dark\);/s
	);
	assert.match(
		css,
		/\.reasoning-effort-control-inner,\s*\.reasoning-effort-control-inner > \*\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*block-size:\s*100%;[^}]*min-height:\s*100%;[^}]*max-height:\s*100%;/s
	);
	assert.match(reasoningControl, /class="reasoning-effort-control-inner"/);
	assert.match(
		reasoningControl,
		/import ChevronDown from '\$lib\/components\/icons\/ChevronDown\.svelte';/
	);
	assert.match(
		reasoningControl,
		/<ChevronDown className="size-3 shrink-0" strokeWidth="2\.5" \/>/
	);
	assert.match(
		modelSelectorMenu,
		/<ChevronDown className="size-3 shrink-0" strokeWidth="2\.5" \/>/
	);
	assert.match(messageInput, /data-composer-intelligence-control/);
	assert.match(
		messageInput,
		/class="composer-intelligence-control composer-rail-control-surface" data-composer-intelligence-control/
	);
	assert.match(messageInput, /composer-metrics-row \{readOnlyMode \? 'self-center' : 'ml-auto self-center'\}/);
	assert.match(messageInput, /composer-active-capabilities flex shrink-0 items-center/);
	assert.doesNotMatch(messageInput, /composer-metrics-row[^\n]*relative -top-px/);
	assert.match(messageInput, /<ModelSelector bind:selectedModels compact=\{true\} \/>/);
	assert.match(messageInput, /<ReasoningEffortControl[\s\S]*?onSelect=\{onReasoningEffortSelect\}/s);
	assert.match(reasoningControl, /type="range"/);
	assert.match(reasoningControl, /availableOptions\[index\]/);
	assert.match(reasoningControl, /--effort-progress:/);
	assert.match(reasoningControl, /--effort-particle-speed:/);
	assert.match(reasoningControl, /<span>Faster<\/span>/);
	assert.match(reasoningControl, /<span>Smarter<\/span>/);
	assert.match(reasoningControl, /data-effort-max=\{isMaximumEffort \? 'true' : 'false'\}/);
	assert.match(reasoningControl, /<DropdownMenu\.Root>/);
	assert.match(reasoningControl, /<DropdownMenu\.Trigger[\s\S]*?class="reasoning-effort-trigger[^\"]*cursor-pointer/s);
	assert.doesNotMatch(reasoningControl, /<Dropdown\s/);
	assert.doesNotMatch(reasoningControl, /<Tooltip\s/);
	assert.match(
		reasoningControl,
		/<DropdownMenu\.Content[\s\S]*?side="top"[\s\S]*?align="center"[\s\S]*?sideOffset=\{12\}/s
	);
	assert.match(modelSelectorMenu, /sideOffset=\{composer \? 12 : 2\}/);
	assert.match(
		css,
		/\.model-selector-content\.is-composer-model-selector\s*\{[^}]*box-shadow:[^}]*0 26px 68px -24px rgba\(0, 0, 0, 0\.72\)/s
	);
	assert.match(css, /@keyframes reasoning-gradient-drift/);
	assert.match(css, /@keyframes reasoning-particle-stream/);
	assert.match(css, /translateX\(-17rem\)/);
	assert.match(css, /reasoning-effort-slider-shell\[data-effort-max='true'\]/);
	assert.match(css, /linear-gradient\(105deg, #6366f1/);
	assert.match(
		css,
		/\.dark \.reasoning-effort-trigger\[data-effort-max='true'\] > span\s*\{[^}]*#e0e7ff[^}]*#fda4af/s
	);
	assert.match(css, /\.reasoning-effort-popover\s*\{[^}]*width:\s*min\(20rem, calc\(100vw - 24px\)\);/s);
	assert.match(css, /\.composer-attachment-preview\s*\{[^}]*width:\s*7\.25rem;[^}]*height:\s*5\.5rem;/s);
	assert.match(css, /\.composer-attachment-remove\s*\{[^}]*background:\s*#202124;/s);
	assert.match(css, /\.capability-pill--readonly\s*\{[^}]*background:\s*var\(--owui-readonly-pill-bg-light\)/s);
	assert.match(css, /\.dark \.capability-pill--readonly\s*\{[^}]*background:\s*var\(--owui-readonly-pill-bg-dark\)/s);
	assert.match(css, /\.model-selector-content \.model-selector-scroll-region\s*\{[^}]*scrollbar-width:\s*none;/s);
	assert.match(css, /\.model-selector-scroll-region::\-webkit-scrollbar\s*\{[^}]*display:\s*none;/s);
	assert.match(css, /\.model-selector-content\s*\{[^}]*z-index:\s*10000 !important;/s);
	assert.match(
		css,
		/#message-input-rail:has\(\.model-selector-content\),[\s\S]*?overflow:\s*visible;/s
	);
});

test('composer telemetry is one pill with one elevated details pane', async () => {
	const [css, messageInput, metrics] = await Promise.all([
		fs.readFile(APP_CSS, 'utf8'),
		fs.readFile(MESSAGE_INPUT, 'utf8'),
		fs.readFile(COMPOSER_METRICS, 'utf8')
	]);

	assert.match(messageInput, /<ComposerMetrics[\s\S]*?capabilities=\{activeCapabilities\}/s);
	assert.doesNotMatch(messageInput, /capability-pill--cost/);
	assert.doesNotMatch(messageInput, /capability-pill--context/);
	assert.match(
		metrics,
		/composer-metrics-trigger composer-rail-control-surface capability-pill capability-pill--readonly/
	);
	assert.match(
		metrics,
		/<button\s+type="button"[\s\S]*?aria-describedby="composer-metrics-tooltip"/s
	);
	assert.match(metrics, /\{contextPercentLabel\}%/);
	assert.match(metrics, /\{costLabel\}/);
	// "Connected capabilities" heading pin removed: the popover now stacks
	// separate "Active MCPs" / "Active skills" panels (behavioral home:
	// tests/active-skill-badges.unit.test.js + live visual QA).
	assert.match(metrics, /Spend and cache/);
	assert.match(metrics, /Context usage/);
	assert.ok(
		metrics.indexOf('Context usage') < metrics.indexOf('Spend and cache'),
		'context usage should appear before spend and cache'
	);
	assert.match(metrics, /Without cache/);
	assert.match(metrics, /Cache reads/);
	// "This turn" stat pin removed: 14ff9bbb reworked the spend section to a
	// per-chat rollup ("Chat total" row fed by costLabel, already asserted
	// above); the row copy is presentation, not contract (behavioral home:
	// live visual QA on the composer metrics popover).
	// The details pane is portaled to document.body with fixed positioning so
	// it can never be clipped by the composer's backdrop-filter stacking
	// context (the old :has() wrapper-lift hack is gone).
	assert.match(css, /\.composer-metrics-popover\s*\{[^}]*position:\s*fixed;[^}]*border-radius:\s*1\.1rem;[^}]*box-shadow:/s);
	assert.match(
		css,
		/\.composer-metrics-popover\s*\{[^}]*transform:\s*translateY\(4px\) scale\(0\.985\);[^}]*transform-origin:\s*bottom center;/s
	);
	assert.match(
		css,
		/\.composer-metrics-popover\.composer-metrics-popover--open\s*\{[^}]*pointer-events:\s*auto;[^}]*transform:\s*translateY\(0\) scale\(1\);/s
	);
	assert.doesNotMatch(css, /--composer-metrics-popover-shift-x/);
	assert.doesNotMatch(css, /:has\(\.composer-metrics-control/);
	assert.match(metrics, /document\.body\.appendChild\(popoverElement\)/);
	assert.match(metrics, /const rect = controlElement\.getBoundingClientRect\(\)/);
	assert.match(metrics, /popoverElement\.style\.left = `\$\{left\}px`/);
	assert.match(metrics, /popoverElement\.style\.bottom = `\$\{window\.innerHeight - rect\.top \+ 12\}px`/);
	assert.match(metrics, /new ResizeObserver\(schedulePopoverPlacement\)/);
	assert.match(metrics, /controlElement\.addEventListener\('mouseenter', openPopover\)/);
	assert.match(metrics, /window\.visualViewport\?\.addEventListener\('resize', schedulePopoverPlacement\)/);
	assert.match(css, /\.composer-metrics-popover-header\s*\{[^}]*text-align:\s*left;/s);
	assert.match(css, /\.composer-metrics-section\s*\{[^}]*text-align:\s*left;/s);
	assert.match(
		css,
		/\.composer-metrics-popover\s*\{[^}]*background-color:\s*#f7f7f7;[^}]*isolation:\s*isolate;/s
	);
	assert.match(
		css,
		/\.dark \.composer-metrics-popover\s*\{[^}]*background:\s*#222225;/s
	);
	assert.match(
		css,
		/\.dark \.composer-metrics-section\s*\{[^}]*background:\s*#2b2b2f;/s
	);
	// Popover width / grid-shape / split-name pins removed: the details pane is
	// now a two-column layout (MCPs-over-skills, context-over-spend) whose
	// skills panel renders provenance badges instead of split names. Behavioral
	// homes: badge/label logic in tests/active-skill-badges.unit.test.js,
	// backend enrichment in tests/test_chat_capabilities_regressions.py, and
	// layout/theming in live visual QA. (Source-pin ban: do not re-point.)
	assert.match(
		css,
		/\.composer-metrics-capability-name\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s
	);
	assert.match(metrics, /title=\{tool\.display_name\}/);
	assert.match(
		css,
		/\.composer-metrics-popover :is\([\s\S]*?\.composer-metrics-detail-list dt,[\s\S]*?\.composer-metrics-detail-list dd,[\s\S]*?\)\s*\{[^}]*word-break:\s*normal;[^}]*overflow-wrap:\s*normal;/s
	);
	assert.match(
		css,
		/\.composer-metrics-detail-list > div\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) max-content;/s
	);
	assert.match(css, /\.composer-metrics-detail-list dt\s*\{[^}]*white-space:\s*nowrap;/s);
	assert.match(css, /\.composer-metrics-detail-list dd\s*\{[^}]*white-space:\s*nowrap;/s);
	// Container-query pins removed with the 3-column grid (behavioral home:
	// live visual QA at narrow widths).
	// Scroll-navigation class pin removed: the cluster now portals INTO
	// #message-input-container and centers on the composer's right edge
	// (top-1/2 -right-12), so the old "absolute right-4 z-30" shape is gone.
	// Behavioral home: live visual QA of the composer scroll buttons in all
	// pane modes. (Source-pin ban: do not re-point.)
	// The body-portaled popover paints above the scroll navigation on its own;
	// the old :has()-based suppression hack must stay gone.
	assert.doesNotMatch(css, /\.chat-scroll-navigation,?\s*\{?[^}]*visibility:\s*hidden/);
});

test('composer rail controls share one exact height and centerline', async () => {
	const [css, messageInput] = await Promise.all([
		fs.readFile(APP_CSS, 'utf8'),
		fs.readFile(MESSAGE_INPUT, 'utf8')
	]);

	assert.match(css, /--owui-capability-pill-height:\s*2rem;/);
	assert.match(
		css,
		/\.composer-rail-control-surface\s*\{[^}]*block-size:\s*var\(--owui-capability-pill-height\);[^}]*min-block-size:\s*var\(--owui-capability-pill-height\);[^}]*max-block-size:\s*var\(--owui-capability-pill-height\);[^}]*align-items:\s*center;[^}]*align-self:\s*center;/s
	);
	assert.match(
		css,
		/\.composer-intelligence-control\s*\{[^}]*height:\s*var\(--owui-capability-pill-height\);[^}]*align-items:\s*center;[^}]*align-self:\s*center;/s
	);
	assert.match(
		css,
		/\.composer-metrics-row,\s*\.composer-active-capabilities\s*\{[^}]*height:\s*var\(--owui-capability-pill-height\);[^}]*align-items:\s*center;/s
	);
	assert.match(
		messageInput,
		/<div inert=\{nativeInputInteractionLocked\} class="self-center flex space-x-1 mr-1 shrink-0">/
	);
	assert.match(
		messageInput,
		/class="composer-intelligence-control composer-rail-control-surface" data-composer-intelligence-control/
	);
	assert.doesNotMatch(messageInput, /<div class="self-end flex space-x-1 mr-1 shrink-0">/);
});

test('artifact menu uses the same elevated composer surface and compact action rows', async () => {
	const [css, activeCapabilities] = await Promise.all([
		fs.readFile(APP_CSS, 'utf8'),
		fs.readFile(ACTIVE_CAPABILITIES, 'utf8')
	]);

	assert.match(activeCapabilities, /class="artifact-composer-popover"/);
	assert.match(activeCapabilities, /class="artifact-composer-popover-item"/);
	assert.match(activeCapabilities, /class="artifact-composer-action artifact-composer-action--primary"/);
	assert.match(css, /\.artifact-composer-popover-shell\s*\{[^}]*bottom:\s*calc\(100% \+ 12px\);/s);
	assert.match(css, /\.artifact-composer-popover\s*\{[^}]*border-radius:\s*1rem;[^}]*box-shadow:/s);
	assert.match(css, /\.dark \.artifact-composer-popover\s*\{[^}]*background:\s*rgba\(20, 20, 20, 0\.99\);/s);
});

test('celestial marks restore Luna, rebalance Sol, and refine Terra rotation', async () => {
	const [css, placeholder, response, atlasLogo, branding, terraLogo] = await Promise.all([
		fs.readFile(APP_CSS, 'utf8'),
		fs.readFile(PLACEHOLDER, 'utf8'),
		fs.readFile(RESPONSE_MESSAGE, 'utf8'),
		fs.readFile(ANIMATED_ATLAS_LOGO, 'utf8'),
		fs.readFile(MODEL_BRANDING, 'utf8'),
		fs.readFile(ANIMATED_TERRA_LOGO, 'utf8')
	]);

	assert.match(atlasLogo, /const rayDefinitions = rayAngles\.map/);
	assert.match(
		atlasLogo,
		/const rayAngles = \[-179, -146, -124, -87, -55, -24, 11, 39, 77, 101, 126, 148\] as const/
	);
	assert.match(atlasLogo, /const haikuGroups = \[4, 1, 9, 6, 12, 3, 8, 11, 2, 7, 10, 5\] as const/);
	assert.match(atlasLogo, /const sonnetGroups = \[3, 1, 5, 2, 4, 1, 3, 5, 2, 4, 3, 5\] as const/);
	assert.match(atlasLogo, /animated-atlas-mark--\{tier\}/);
	assert.match(atlasLogo, /atlas-haiku-group--\$\{ray\.haikuGroup\}/);
	assert.match(atlasLogo, /atlas-sonnet-group--\$\{ray\.sonnetGroup\}/);
	assert.match(atlasLogo, /atlas-opus-group--\$\{group\}/);
	assert.match(atlasLogo, /atlas-ray-direction--\$\{ray\.direction\}/);
	assert.match(atlasLogo, /clip-path=\{`url\(#atlas-ray-clip-\$\{index\}\)`\}/);
	assert.match(placeholder, /primaryModelMotionKind === 'atlas'[\s\S]*?<AnimatedAtlasLogo/s);
	assert.match(response, /assistantModelMotionKind === 'atlas'[\s\S]*?<AnimatedAtlasLogo/s);
	assert.doesNotMatch(placeholder, /AnimatedLunaLogo/);
	assert.doesNotMatch(response, /AnimatedLunaLogo/);
	assert.match(branding, /LUNA_MODEL_LOGO_SRC\s*=\s*'\/luna\.png'/);
	assert.match(placeholder, /primaryModelMotionKind === 'terra'[\s\S]*?<AnimatedTerraLogo/s);
	assert.match(response, /assistantModelMotionKind === 'terra'[\s\S]*?<AnimatedTerraLogo/s);
	assert.match(css, /assistant-logo-atlas-ray-pulse-haiku 48s/);
	assert.match(css, /assistant-logo-atlas-ray-pulse-sonnet 20s/);
	assert.match(css, /assistant-logo-atlas-ray-pulse-opus 14s/);
	assert.match(css, /@keyframes assistant-logo-atlas-opus-spin/);
	assert.match(css, /\.animated-atlas-mark--opus \.atlas-ray-direction--in[\s\S]*0\.76/);
	assert.match(css, /--model-logo-atlas-ray-peak/);
	assert.match(css, /\.assistant-model-logo-motion--sol::before\s*\{[^}]*inset:\s*-11px/s);
	assert.match(
		css,
		/@keyframes assistant-logo-sol-breathe[\s\S]*scale\(0\.97\)[\s\S]*scale\(1\.16\)[\s\S]*saturate\(1\.4\)[\s\S]*brightness\(1\.2\)/s
	);
	assert.match(
		css,
		/@keyframes assistant-logo-solar-corona[\s\S]*opacity:\s*0\.76[\s\S]*scale\(1\.35\)/s
	);
	assert.match(css, /@keyframes assistant-logo-solar-ray[\s\S]*opacity:\s*0\.72[\s\S]*scale\(1\.32\)/s);
	assert.match(css, /\.assistant-model-logo-motion--sol::after\s*\{[^}]*repeating-conic-gradient/s);
	assert.match(terraLogo, /const surfaceOffsets = \[0, 100\] as const/);
	assert.match(terraLogo, /animated-terra-surface-strip/);
	assert.match(terraLogo, /animated-terra-night-shade/);
	assert.match(terraLogo, /animated-terra-atmosphere/);
	assert.match(terraLogo, /animated-terra-region--north-america/);
	assert.match(terraLogo, /animated-terra-region--africa/);
	assert.match(terraLogo, /animated-terra-region--australia/);
	assert.equal((terraLogo.match(/<circle class="animated-terra-sparkle/g) ?? []).length, 12);
	assert.ok(terraLogo.indexOf('animated-terra-water-glints') < terraLogo.indexOf('animated-terra-surface-strip'));
	assert.match(css, /--model-logo-terra-flourish-duration/);
	assert.match(
		css,
		/@keyframes assistant-logo-terra-surface-pan[\s\S]*41%[\s\S]*41\.71%[\s\S]*42\.52%[\s\S]*43\.53%[\s\S]*44\.84%[\s\S]*46\.65%[\s\S]*49\.26%[\s\S]*53\.07%[\s\S]*59%[\s\S]*translateX\(-100px\)/s
	);
	assert.match(css, /@keyframes assistant-logo-terra-aura[\s\S]*opacity:\s*0\.34[\s\S]*scale\(1\.08\)/s);
	assert.match(css, /@keyframes assistant-logo-terra-sparkle-a/);
	assert.match(css, /@keyframes assistant-logo-terra-sparkle-d/);
	assert.doesNotMatch(css, /assistant-logo-terra-spin/);
	assert.match(css, /@keyframes assistant-logo-luna-tumble[\s\S]*rotate\(378deg\)/s);
	assert.match(css, /@keyframes assistant-logo-luna-terminator[\s\S]*translateX\(-72%\)[\s\S]*translateX\(72%\)/s);
	assert.match(css, /\.assistant-model-logo-motion--luna::after\s*\{[^}]*inset:\s*2px;[^}]*linear-gradient/s);
	assert.doesNotMatch(css, /animated-luna|model-logo-luna-light|assistant-logo-luna-light-phases/);
	assert.match(css, /animation-direction:\s*var\(--model-logo-sweep-direction, normal\)/);
	assert.match(css, /@keyframes assistant-logo-gemini-sparkles/);
});

test('chat links copy normally, open with Command or Control, and preserve app-owned actions', async () => {
	const { getChatLinkAction, normalizeAbsoluteHttpUrl } = await import(CHAT_LINK_INTERACTION);
	const currentHref = 'http://localhost:3789/c/chat-1';

	assert.deepEqual(getChatLinkAction({}, 'https://example.test/docs', currentHref, 'MacIntel'), {
		action: 'copy',
		url: 'https://example.test/docs'
	});
	assert.equal(
		getChatLinkAction({ metaKey: true }, 'https://example.test/docs', currentHref, 'MacIntel').action,
		'open'
	);
	assert.equal(
		getChatLinkAction({ ctrlKey: true }, 'https://example.test/docs', currentHref, 'Win32').action,
		'open'
	);
	assert.equal(
		getChatLinkAction({ ctrlKey: true }, 'https://example.test/docs', currentHref, 'MacIntel').action,
		'copy'
	);
	assert.equal(
		getChatLinkAction({ metaKey: true }, 'https://example.test/docs', currentHref, 'Win32').action,
		'copy'
	);
	assert.equal(
		getChatLinkAction({}, 'http://localhost:3789/c/other-chat', currentHref, 'MacIntel').action,
		'preserve'
	);
	assert.equal(
		getChatLinkAction(
			{ metaKey: true },
			'http://127.0.0.1:9876/workspace/report.pdf',
			currentHref,
			'MacIntel'
		).action,
		'preserve'
	);
	assert.equal(normalizeAbsoluteHttpUrl('javascript:alert(1)'), null);
	assert.equal(normalizeAbsoluteHttpUrl('/api/v1/files/file-1/content'), null);
});

test('chat hyperlink surfaces share the modifier-aware interaction helper', async () => {
	const [markdown, codeSpan, webSearch, citation] = await Promise.all([
		fs.readFile(MARKDOWN_INLINE_TOKENS, 'utf8'),
		fs.readFile(CODE_SPAN_TOKEN, 'utf8'),
		fs.readFile(WEB_SEARCH_RESULTS, 'utf8'),
		fs.readFile(CITATION_MODAL, 'utf8')
	]);

	for (const source of [markdown, codeSpan, webSearch, citation]) {
		assert.match(source, /getChatLinkAction/);
	}
	assert.match(markdown, /decision\.action !== 'copy'[\s\S]*event\.preventDefault\(\)[\s\S]*copyToClipboard\(decision\.url\)/s);
	assert.match(codeSpan, /decision\.action === 'open'[\s\S]*window\.open\(decision\.url, '_blank', 'noopener,noreferrer'\)/s);
	assert.match(webSearch, /on:click=\{\(event\) => handleChatLinkClick\(event, item\.link\)\}/);
	assert.match(citation, /normalizeAbsoluteHttpUrl\(document\.source\?\.url\)/);
	assert.doesNotMatch(citation, /source\?\.url\?\.includes\('http'\)/);
});
