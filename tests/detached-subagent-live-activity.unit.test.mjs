import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { rebindSocketListeners } from '../src/patches/frontend/src/lib/utils/socket-listener-binding.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHAT_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/Chat.svelte'
);

const fakeSocket = () => ({
	listeners: new Map(),
	onCalls: [],
	offCalls: [],
	on(event, listener) {
		this.onCalls.push([event, listener]);
		this.listeners.set(event, listener);
	},
	off(event, listener) {
		this.offCalls.push([event, listener]);
		if (this.listeners.get(event) === listener) this.listeners.delete(event);
	}
});

test('socket listener rebinding detaches the old socket and follows replacements', () => {
	const first = fakeSocket();
	const second = fakeSocket();
	const events = () => {};
	const connect = () => {};
	const listeners = [
		['events', events],
		['connect', connect]
	];

	let current = rebindSocketListeners(null, first, listeners);
	assert.equal(current, first);
	assert.deepEqual(first.onCalls, listeners);

	current = rebindSocketListeners(current, second, listeners);
	assert.equal(current, second);
	assert.deepEqual(first.offCalls, listeners);
	assert.deepEqual(second.onCalls, listeners);
	assert.equal(first.listeners.size, 0);
	assert.equal(second.listeners.get('events'), events);

	const onCallCount = second.onCalls.length;
	current = rebindSocketListeners(current, second, listeners);
	assert.equal(second.onCalls.length, onCallCount);

	current = rebindSocketListeners(current, null, listeners);
	assert.equal(current, null);
	assert.deepEqual(second.offCalls, listeners);
});

test('Chat starts user-only detached reconciliation and enforces lifecycle guards', async () => {
	const source = await fs.readFile(CHAT_PATH, 'utf8');
	const navigateStart = source.indexOf('const navigateHandler = async () => {');
	const navigateEnd = source.indexOf('const onSelect = async', navigateStart);
	const navigate = source.slice(navigateStart, navigateEnd);

	assert.match(source, /const DETACHED_SUBAGENT_RECONCILE_INTERVAL_MS = 5000;/);
	assert.match(source, /const DETACHED_SUBAGENT_RECONCILE_BUDGET_MS = 2 \* 60 \* 60 \* 1000;/);
	assert.match(
		source,
		/loading = false;[\s\S]*?if \(isDelegatedSubagentLoad\(\)\) \{[\s\S]*?startDetachedSubagentReconciler\(targetChatId, generation\);/
	);
	assert.match(source, /void reconcileDetachedSubagentSnapshot\('hydrate'\);/);
	assert.match(source, /const \[snapshot, taskSnapshot\] = await Promise\.all\(/);
	assert.match(source, /getChatReconciliationById\(/);
	assert.match(source, /const abortController = new AbortController\(\);/);
	assert.match(source, /detachedSubagentReconcileAbortController\?\.abort\(\);/);
	assert.match(source, /if \(detachedSubagentReconcilePromise\) \{/);
	assert.match(source, /isCurrentChatLoad\(generation, targetChatId\)/);
	assert.match(source, /get\(chatId\) === targetChatId/);
	assert.match(source, /if \(document\.hidden && reason === 'fallback'\) return;/);
	assert.match(source, /document\.addEventListener\('visibilitychange'/);
	assert.match(source, /window\.addEventListener\('focus'/);
	assert.match(source, /reconcileDetachedSubagentSnapshot\('socket_reconnect'\)/);
	assert.match(source, /if \(isDetachedSubagentHistoryTerminal\(history\)\) \{/);
	assert.match(source, /stopDetachedSubagentReconciler\(\);/);
	assert.ok(
		navigate.indexOf('stopDetachedSubagentReconciler();') <
			navigate.indexOf('const generation = ++chatLoadGeneration;')
	);
	assert.ok(
		navigate.indexOf('const generation = ++chatLoadGeneration;') <
			navigate.indexOf('startDetachedSubagentReconciler(targetChatId, generation);')
	);
});

test('Chat reactively binds the current socket instead of mount-time snapshot binding', async () => {
	const source = await fs.readFile(CHAT_PATH, 'utf8');

	assert.match(source, /\$: bindChatSocket\(\$socket\);/);
	assert.match(source, /rebindSocketListeners\(boundChatSocket, nextSocket/);
	assert.doesNotMatch(source, /\$socket\?\.on\('events', chatEventHandler\)/);
	assert.doesNotMatch(source, /\$socket\?\.off\('events', chatEventHandler\)/);
	assert.match(source, /bindChatSocket\(null\);/);
});

test('live events defer fallback polling while preserving immediate reconnect catch-up', async () => {
	const source = await fs.readFile(CHAT_PATH, 'utf8');
	const handlerStart = source.indexOf('const chatEventHandler = async');
	const handlerEnd = source.indexOf('const onMessageHandler = async', handlerStart);
	const handler = source.slice(handlerStart, handlerEnd);

	assert.match(handler, /if \(delegatedSubagentView\) \{[\s\S]*?noteDetachedSubagentLiveEvent\(type\);/);
	assert.match(source, /detachedSubagentLastLiveEventAt = Date\.now\(\);/);
	assert.match(source, /eventType === 'chat:completion'/);
	assert.match(source, /eventType === 'chat:tasks:cancel'/);
	assert.match(source, /eventType === 'chat:message:error'/);
	assert.match(source, /detachedSubagentTerminalReconcilePending = true;/);
	assert.match(source, /const inFlightPromise = detachedSubagentReconcilePromise;/);
	assert.match(source, /reconcileDetachedSubagentSnapshot\('live_terminal'\)/);
	assert.match(
		source,
		/sinceLiveEvent < DETACHED_SUBAGENT_RECONCILE_INTERVAL_MS[\s\S]*?scheduleDetachedSubagentReconcile/
	);
});

test('detached live completion is terminal locally but never replays completion side effects', async () => {
	const source = await fs.readFile(CHAT_PATH, 'utf8');
	const completedStart = source.indexOf('const chatCompletedHandler = async');
	const completedEnd = source.indexOf('const chatActionHandler = async', completedStart);
	const completedHandler = source.slice(completedStart, completedEnd);
	const eventStart = source.indexOf('const chatCompletionEventHandler = async');
	const eventEnd = source.indexOf('// Portico: Stream watchdog', eventStart);
	const eventHandler = source.slice(eventStart, eventEnd);

	assert.notEqual(completedStart, -1);
	assert.notEqual(completedEnd, -1);
	assert.notEqual(eventStart, -1);
	assert.notEqual(eventEnd, -1);
	assert.ok(
		completedHandler.indexOf('if (delegatedSubagentView) {') <
			completedHandler.indexOf('const res = await chatCompleted(')
	);
	assert.match(
		completedHandler,
		/if \(delegatedSubagentView\) \{[\s\S]*?clearGenerationStateIfIdle\(\);[\s\S]*?return;[\s\S]*?\}/
	);
	assert.match(completedHandler, /const res = await chatCompleted\(/);
	assert.match(completedHandler, /const updatedChat = await updateChatById\(/);
	assert.match(eventHandler, /if \(done && !message\.done\) \{[\s\S]*?message\.done = true;/);
	assert.match(eventHandler, /clearGenerationStateIfIdle\(\{ clearTaskIds: delegatedSubagentView \}\);/);
	assert.match(
		eventHandler,
		/if \(!delegatedSubagentView\) \{[\s\S]*?await chatCompletedHandler\([\s\S]*?\);[\s\S]*?\}/
	);
});
