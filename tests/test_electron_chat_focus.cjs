const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const REPO_ROOT = path.resolve(__dirname, '..');
const chatTabScript = path.join(
	REPO_ROOT,
	'electron-app',
	'src',
	'renderer',
	'components',
	'chat-tab.js'
);
const conversationWindowScript = path.join(
	REPO_ROOT,
	'electron-app',
	'src',
	'renderer',
	'views',
		'conversation-window.js'
);
const owuiHostScript = path.join(
	REPO_ROOT,
	'electron-app',
	'src',
	'renderer',
	'components',
	'owui-host.js'
);

function extractFunctionSource(source, functionName) {
	const patterns = [`async function ${functionName}(`, `function ${functionName}(`];
	let start = -1;

	for (const pattern of patterns) {
		start = source.indexOf(pattern);
		if (start !== -1) {
			break;
		}
	}

	assert.notEqual(start, -1, `Could not find function ${functionName}`);

	const bodyStart = source.indexOf('{', start);
	assert.notEqual(bodyStart, -1, `Could not find function body for ${functionName}`);

	let depth = 0;
	let end = -1;
	for (let index = bodyStart; index < source.length; index += 1) {
		if (source[index] === '{') {
			depth += 1;
		} else if (source[index] === '}') {
			depth -= 1;
			if (depth === 0) {
				end = index + 1;
				break;
			}
		}
	}

	assert.notEqual(end, -1, `Could not find function end for ${functionName}`);
	return source.slice(start, end);
}

function buildChatTabFocusHarness({
	activeTab = 'chat',
	interactionSuppressed = false,
	focusSuppressed = false
} = {}) {
	const source = fs.readFileSync(chatTabScript, 'utf8');
	const focusCalls = [];
	const rendererFocusCalls = [];
	const elements = {
		'chat-webview': { dataset: { owuiViewKey: 'main-chat-view' } },
		'conversation-webview-abc123': {
			dataset: { owuiViewKey: 'conversation-view-abc123' }
		}
	};

	const context = {
		window: {
			appState: { activeTab },
			isOwuiInteractionSuppressed: () => interactionSuppressed,
			isOwuiFocusSuppressed: () => focusSuppressed,
			requestAnimationFrame(callback) {
				callback();
				return 1;
			},
			electronAPI: {
				focusRenderer: async () => {
					rendererFocusCalls.push('renderer');
				},
				owui: {
					focusView: async (viewKey) => {
						focusCalls.push(viewKey);
						return { viewKey };
					}
				}
			}
		},
		document: {
			getElementById(id) {
				return elements[id] || null;
			}
		},
		console
	};

	const harnessSource = [
		extractFunctionSource(source, 'getOwuiViewKeyForWebview'),
		extractFunctionSource(source, 'focusActiveOwuiView'),
		extractFunctionSource(source, 'focusShellRenderer'),
		extractFunctionSource(source, 'handoffActiveTabFocus'),
		extractFunctionSource(source, 'scheduleActiveTabFocusHandoff'),
		'this.focusActiveOwuiView = focusActiveOwuiView;',
		'this.handoffActiveTabFocus = handoffActiveTabFocus;',
		'this.scheduleActiveTabFocusHandoff = scheduleActiveTabFocusHandoff;'
	].join('\n\n');

	vm.runInNewContext(harnessSource, context, { filename: chatTabScript });

	return {
		source,
		focusCalls,
		rendererFocusCalls,
		elements,
		focusActiveOwuiView: context.focusActiveOwuiView,
		handoffActiveTabFocus: context.handoffActiveTabFocus,
		scheduleActiveTabFocusHandoff: context.scheduleActiveTabFocusHandoff
	};
}

test('main chat host registers a window focus listener that forwards into the focus helper', () => {
	const source = fs.readFileSync(chatTabScript, 'utf8');

	assert.match(source, /window\.addEventListener\('focus', \(\) => \{\s*void focusActiveOwuiView\(\);/s);
});

test('main chat host refocuses the main OWUI view on window focus when chat is active', async () => {
	const harness = buildChatTabFocusHarness({ activeTab: 'chat' });

	await harness.focusActiveOwuiView();

	assert.deepEqual(harness.focusCalls, ['main-chat-view']);
});

test('main chat host refocuses the active conversation OWUI view on window focus', async () => {
	const harness = buildChatTabFocusHarness({
		activeTab: 'conversation-abc123'
	});

	await harness.focusActiveOwuiView();

	assert.deepEqual(harness.focusCalls, ['conversation-view-abc123']);
});

test('main chat host does not steal focus for control-plane tabs', async () => {
	const harness = buildChatTabFocusHarness({ activeTab: 'control' });

	await harness.focusActiveOwuiView();

	assert.deepEqual(harness.focusCalls, []);
});

test('main chat host does not refocus OWUI while interaction is suppressed', async () => {
	const harness = buildChatTabFocusHarness({ activeTab: 'chat', interactionSuppressed: true });

	await harness.focusActiveOwuiView();

	assert.deepEqual(harness.focusCalls, []);
});

test('tab-switch focus handoff refocuses the active OWUI view for chat tabs', async () => {
	const harness = buildChatTabFocusHarness({ activeTab: 'conversation-abc123' });

	await harness.handoffActiveTabFocus();

	assert.deepEqual(harness.focusCalls, ['conversation-view-abc123']);
	assert.deepEqual(harness.rendererFocusCalls, []);
});

test('tab-switch focus handoff moves focus back to the shell for non-chat tabs', async () => {
	const harness = buildChatTabFocusHarness({ activeTab: 'control' });

	await harness.handoffActiveTabFocus();

	assert.deepEqual(harness.focusCalls, []);
	assert.deepEqual(harness.rendererFocusCalls, ['renderer']);
});

test('tab-switch focus handoff prefers the shell when OWUI focus is suppressed', async () => {
	const harness = buildChatTabFocusHarness({
		activeTab: 'chat',
		focusSuppressed: true
	});

	await harness.handoffActiveTabFocus();

	assert.deepEqual(harness.focusCalls, []);
	assert.deepEqual(harness.rendererFocusCalls, ['renderer']);
});

test('tab-switch scheduling only hands off focus if the tab is still active', async () => {
	const harness = buildChatTabFocusHarness({ activeTab: 'chat' });
	harness.scheduleActiveTabFocusHandoff('control');

	assert.deepEqual(harness.focusCalls, []);
	assert.deepEqual(harness.rendererFocusCalls, []);
});

test('tab switches and late OWUI attachment both schedule focus handoff', () => {
	const source = fs.readFileSync(chatTabScript, 'utf8');

	assert.match(source, /scheduleActiveTabFocusHandoff\(tabName\);/);
	assert.match(
		source,
		/attachOwuiViewAndSyncActiveKey[\s\S]*scheduleActiveTabFocusHandoff\(tabName\);/m
	);
	assert.match(
		source,
		/function switchTab\(tabName\) \{[\s\S]*scheduleActiveTabFocusHandoff\(tabName\);/m
	);
});

test('owui host exposes a suppression-state helper to the renderer', () => {
	const source = fs.readFileSync(owuiHostScript, 'utf8');

	assert.match(source, /function isOwuiInteractionSuppressed\(\)\s*\{\s*return interactionSuppressionReasons\.size > 0;\s*\}/s);
	assert.match(source, /window\.isOwuiInteractionSuppressed = isOwuiInteractionSuppressed;/);
});

test('detached conversation windows refocus their OWUI view on window focus', () => {
	const source = fs.readFileSync(conversationWindowScript, 'utf8');

	assert.equal(
		source.includes('window.addEventListener("focus", () => {'),
		true,
		'conversation-window should listen for detached-window focus events'
	);
	assert.equal(
		source.includes('window.electronAPI.owui.focusView(viewKey)'),
		true,
		'conversation-window should refocus its detached OWUI view'
	);
});
