// Behavioral tests for non-blocking debug-info collection in the control
// plane: no full-screen overlay, triggers disabled while a run is in
// flight, a spinner + bare percentage anchored to the right edge of the
// Collect Debug Info button, and a double-start guard. Extract-and-exec of the real
// control-plane.js block — no source-pin regex assertions.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const controlPlanePath = path.join(
	repoRoot,
	'electron-app/src/renderer/components/control-plane.js'
);

const source = await fs.readFile(controlPlanePath, 'utf8');

const block = (startMarker, endMarker) => {
	const start = source.indexOf(startMarker);
	assert.notEqual(start, -1, `missing ${startMarker}`);
	const end = source.indexOf(endMarker, start + startMarker.length);
	assert.notEqual(end, -1, `missing ${endMarker}`);
	return source.slice(start, end);
};

class FakeElement {
	constructor(tagName = 'div') {
		this.tagName = tagName;
		this.classes = new Set();
		this.textContent = '';
		this.disabled = false;
		this.id = '';
	}
	get classList() {
		const classes = this.classes;
		return {
			add: (name) => classes.add(name),
			remove: (name) => classes.delete(name),
			contains: (name) => classes.has(name),
			toggle: (name, force) => {
				const shouldHave = force === undefined ? !classes.has(name) : Boolean(force);
				if (shouldHave) classes.add(name);
				else classes.delete(name);
				return shouldHave;
			}
		};
	}
}

const buildHarness = () => {
	const code = block(
		'// Debug info collection runs in the BACKGROUND.',
		'\nasync function collectAndUploadDebugInfo'
	);

	const elements = new Map();
	for (const id of ['debug-btn', 'bug-report-submit-btn', 'debug-btn-progress', 'debug-btn-percent']) {
		const el = new FakeElement(id.endsWith('btn') ? 'button' : 'span');
		el.id = id;
		if (id === 'debug-btn-progress') el.classes.add('hidden');
		elements.set(id, el);
	}

	const calls = { notifications: [], overlay: [], logToMain: [] };
	let progressCallback = null;
	let resolveCollect;
	let rejectCollect;
	let collectInvocations = 0;

	const sandbox = {
		document: {
			getElementById: (id) => elements.get(id) ?? null
		},
		showNotification: (message, type) => calls.notifications.push({ message, type }),
		showLoading: (message) => calls.overlay.push({ fn: 'showLoading', message }),
		hideLoading: () => calls.overlay.push({ fn: 'hideLoading' }),
		Number,
		Math,
		String,
		Date,
		window: {
			setNativeOverlayInteractionSuppressed: (...args) =>
				calls.overlay.push({ fn: 'suppress', args }),
			electronAPI: {
				logToMain: (level, message) => calls.logToMain.push({ level, message }),
				onDebugCollectProgress: (callback) => {
					progressCallback = callback;
				},
				collectDebugInfo: () => {
					collectInvocations += 1;
					return new Promise((resolve, reject) => {
						resolveCollect = resolve;
						rejectCollect = reject;
					});
				}
			}
		}
	};
	vm.createContext(sandbox);
	vm.runInContext(code + '\n__harness = { collectDebugInfo };', sandbox);

	return {
		collect: () => sandbox.__harness.collectDebugInfo(),
		resolve: (value) => resolveCollect(value),
		reject: (error) => rejectCollect(error),
		progress: (payload) => progressCallback?.(payload),
		progressVisible: () => !elements.get('debug-btn-progress').classes.has('hidden'),
		percentText: () => elements.get('debug-btn-percent').textContent,
		button: (id) => elements.get(id),
		calls,
		collectInvocations: () => collectInvocations
	};
};

test('collection shows in-button progress instead of the blocking overlay', async () => {
	const harness = buildHarness();
	const pending = harness.collect();

	assert.equal(harness.calls.overlay.length, 0,
		'no showLoading/hideLoading/interaction-suppression during collection');
	assert.equal(harness.progressVisible(), true,
		'right-anchored spinner+percent shown on the button');
	assert.equal(harness.percentText(), '0%');
	assert.equal(harness.button('debug-btn').disabled, true, 'trigger disabled while running');
	assert.equal(harness.button('bug-report-submit-btn').disabled, true);

	harness.resolve({ success: true, zipFile: '/tmp/debug.zip' });
	await pending;

	assert.equal(harness.calls.overlay.length, 0, 'overlay still untouched after completion');
	assert.equal(harness.progressVisible(), false, 'progress hidden after completion');
	assert.equal(harness.button('debug-btn').disabled, false, 'trigger re-enabled');
	const success = harness.calls.notifications.find((n) => n.type === 'success');
	assert.match(success.message, /\/tmp\/debug\.zip/);
});

test('progress events drive a monotonic percentage on the button', async () => {
	const harness = buildHarness();
	const pending = harness.collect();

	harness.progress({ percent: 6, label: 'Capturing container logs' });
	assert.equal(harness.percentText(), '6%', 'bare percent, no label details');

	harness.progress({ percent: 53, label: 'Redacting sensitive information' });
	assert.equal(harness.percentText(), '53%');

	// Out-of-order (parallel redaction workers) and malformed events are ignored.
	harness.progress({ percent: 41, label: 'stale worker event' });
	harness.progress({ percent: undefined, label: 'no percent' });
	assert.equal(harness.percentText(), '53%');

	harness.progress({ percent: 100, label: 'Done' });
	assert.equal(harness.percentText(), '100%');

	harness.resolve({ success: true, zipFile: '/tmp/d.zip' });
	await pending;

	harness.progress({ percent: 100, label: 'straggler after completion' });
	assert.equal(harness.percentText(), '100%', 'post-completion events are ignored');
});

test('percentage resets between runs', async () => {
	const harness = buildHarness();
	const first = harness.collect();
	harness.progress({ percent: 92, label: 'Compressing bundle' });
	harness.resolve({ success: true, zipFile: '/tmp/a.zip' });
	await first;

	const second = harness.collect();
	assert.equal(harness.percentText(), '0%', 'fresh run starts back at 0%');
	harness.progress({ percent: 6, label: 'Capturing container logs' });
	assert.equal(harness.percentText(), '6%',
		'low percents accepted again after reset');
	harness.resolve({ success: true, zipFile: '/tmp/b.zip' });
	await second;
});

test('a second click while running is rejected without starting a new collection', async () => {
	const harness = buildHarness();
	const pending = harness.collect();

	await harness.collect();
	assert.equal(harness.collectInvocations(), 1, 'IPC invoked exactly once');
	const info = harness.calls.notifications.find((n) => n.type === 'info');
	assert.match(info.message, /already running/i);

	harness.resolve({ success: true, zipFile: '/tmp/d.zip' });
	await pending;
});

test('failures re-enable the triggers, hide the progress, and surface an error', async () => {
	const harness = buildHarness();
	const pending = harness.collect();
	harness.reject(new Error('bash exploded'));
	await pending;

	assert.equal(harness.progressVisible(), false);
	assert.equal(harness.button('debug-btn').disabled, false);
	assert.ok(harness.calls.notifications.some((n) => n.type === 'error'));

	const retry = harness.collect();
	assert.equal(harness.collectInvocations(), 2, 'guard released after failure');
	harness.resolve({ success: true, zipFile: '/tmp/d3.zip' });
	await retry;
});

test('an alreadyRunning result from the main process stays quiet (no error toast)', async () => {
	const harness = buildHarness();
	const pending = harness.collect();
	harness.resolve({ success: false, alreadyRunning: true, error: 'Debug collection is already running.' });
	await pending;

	assert.ok(!harness.calls.notifications.some((n) => n.type === 'error'),
		'main-side already-running rejection is not surfaced as a failure');
	assert.equal(harness.progressVisible(), false);
});
