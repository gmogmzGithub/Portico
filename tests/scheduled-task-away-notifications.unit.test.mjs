// Behavioral tests for the sidebar's scheduled-task run notifications,
// specifically the away-failure summary: runs that terminated badly while
// the app was closed used to be seeded as "seen" on the first poll and
// never surfaced anywhere. Extract-and-exec of the real Sidebar.svelte
// poller — no source-pin regex assertions.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sidebarPath = path.join(
	repoRoot,
	'src/patches/frontend/src/lib/components/layout/Sidebar.svelte'
);
const require = createRequire(import.meta.url);
const { transformSync } = require('../electron-app/node_modules/esbuild');

const block = (source, startMarker, endMarker) => {
	const start = source.indexOf(startMarker);
	assert.notEqual(start, -1, `missing ${startMarker}`);
	const end = source.indexOf(endMarker, start + startMarker.length);
	assert.notEqual(end, -1, `missing ${endMarker}`);
	return source.slice(start, end);
};

const source = await fs.readFile(sidebarPath, 'utf8');

const buildHarness = ({ tasks }) => {
	const stateBlock = block(
		source,
		'let scheduledTaskNotificationInterval',
		'\n\tconst onNavigateToMessage'
	);
	const pollerBlock = block(
		source,
		'const loadScheduledTaskNotificationSeen',
		'\n\tconst startScheduledTaskRunNotifications'
	);
	const capture = '\n__harness.poll = pollScheduledTaskRunNotifications;\n';
	const { code } = transformSync(stateBlock + '\n' + pollerBlock + capture, { loader: 'ts' });

	const toasts = [];
	const navigations = [];
	const sessionStore = new Map();
	const sandbox = {
		__harness: {},
		console,
		toast: {
			warning: (body, options = {}) => toasts.push({ kind: 'warning', body, ...options }),
			success: (body, options = {}) => toasts.push({ kind: 'success', body, ...options })
		},
		goto: async (target) => {
			navigations.push(target);
		},
		listScheduledTasks: async () => ({ tasks }),
		localStorage: { token: 'test-token' },
		sessionStorage: {
			getItem: (key) => (sessionStore.has(key) ? sessionStore.get(key) : null),
			setItem: (key, value) => sessionStore.set(key, String(value))
		}
	};
	vm.createContext(sandbox);
	vm.runInContext(code, sandbox);
	return {
		poll: () => sandbox.__harness.poll(),
		toasts,
		navigations,
		setTasks: (next) => {
			sandbox.listScheduledTasks = async () => ({ tasks: next });
		}
	};
};

const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

let runCounter = 0;
const run = ({ status, finishedAgoMs, needsAttention = false, chatId = null, error = null }) => ({
	run_id: `run-${runCounter++}`,
	chat_id: chatId,
	started_at: iso(-(finishedAgoMs + MINUTE)),
	finished_at: iso(-finishedAgoMs),
	status,
	trigger: 'scheduled',
	error,
	response_preview: null,
	needs_attention: needsAttention,
	needs_attention_reason: needsAttention ? 'run_failed' : null
});

const task = (id, runs, prompt = `prompt for ${id}`) => ({ id, prompt, runs });

test('failures that finished while the app was closed produce one summary toast on the first poll', async () => {
	const harness = buildHarness({
		tasks: [
			task('task-a', [
				run({ status: 'missed', finishedAgoMs: 2 * HOUR, error: 'skipped' }),
				run({ status: 'failed', finishedAgoMs: HOUR, error: 'boom' }),
				run({ status: 'success', finishedAgoMs: 26 * HOUR })
			]),
			task('task-b', [run({ status: 'auth_required', finishedAgoMs: 3 * HOUR, needsAttention: true })])
		]
	});

	await harness.poll();

	assert.equal(harness.toasts.length, 1, 'exactly one summary toast');
	const [summary] = harness.toasts;
	assert.equal(summary.kind, 'warning');
	assert.equal(summary.body, '3 scheduled runs across 2 tasks need attention since you were away.');
	assert.equal(summary.description, 'Scheduled tasks need attention');
	summary.action.onClick();
	await Promise.resolve();
	assert.deepEqual(harness.navigations, ['/scheduled-tasks']);
});

test('a single away failure surfaces as the regular per-run toast with its chat action', async () => {
	const harness = buildHarness({
		tasks: [
			task('task-solo', [
				run({ status: 'failed', finishedAgoMs: HOUR, chatId: 'chat-solo', error: 'exploded' })
			])
		]
	});

	await harness.poll();

	assert.equal(harness.toasts.length, 1);
	const [toast] = harness.toasts;
	assert.equal(toast.kind, 'warning');
	assert.equal(toast.body, 'exploded');
	assert.equal(toast.description, 'Scheduled task needs attention');
	assert.equal(toast.action.label, 'Open chat');
	toast.action.onClick();
	await Promise.resolve();
	assert.deepEqual(harness.navigations, ['/c/chat-solo']);
});

test('successes, cancellations, and stale failures while away stay silent', async () => {
	const harness = buildHarness({
		tasks: [
			task('task-quiet', [
				run({ status: 'success', finishedAgoMs: HOUR }),
				run({ status: 'cancelled', finishedAgoMs: HOUR }),
				run({ status: 'failed', finishedAgoMs: 72 * HOUR, error: 'ancient history' })
			])
		]
	});

	await harness.poll();

	assert.equal(harness.toasts.length, 0);
});

test('away summary fires only once; later polls notify fresh terminal runs individually', async () => {
	const awayRun = run({ status: 'missed', finishedAgoMs: HOUR, error: 'skipped while away' });
	const harness = buildHarness({ tasks: [task('task-live', [awayRun])] });

	await harness.poll();
	assert.equal(harness.toasts.length, 1, 'away failure notified once');

	// Nothing new: polls stay quiet, no duplicate for the same run.
	await harness.poll();
	assert.equal(harness.toasts.length, 1);

	// A run finishing after session start notifies through the live path.
	const liveRun = run({ status: 'success', finishedAgoMs: -MINUTE, chatId: 'chat-live' });
	liveRun.response_preview = 'digest delivered';
	harness.setTasks([task('task-live', [awayRun, liveRun])]);
	await harness.poll();

	assert.equal(harness.toasts.length, 2);
	const live = harness.toasts[1];
	assert.equal(live.kind, 'success');
	assert.equal(live.body, 'digest delivered');

	await harness.poll();
	assert.equal(harness.toasts.length, 2, 'live run notified exactly once');
});
