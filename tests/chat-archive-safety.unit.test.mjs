import assert from 'node:assert/strict';
import test from 'node:test';

import { archiveChatSafely } from '../src/patches/frontend/src/lib/apis/chatArchive.mjs';

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({
	ok,
	status,
	json: async () => body
});

test('archive request sets an exact state and reconciles it before returning', async () => {
	const calls = [];
	const fetchImpl = async (url, options) => {
		calls.push({ url, options });
		return options.method === 'POST'
			? jsonResponse({ archived: true })
			: jsonResponse({ id: 'chat/a', archived: true });
	};

	const chat = await archiveChatSafely('token', 'chat/a', {
		fetchImpl,
		apiBaseUrl: '/api/v1/'
	});

	assert.equal(chat.archived, true);
	assert.equal(calls.length, 2);
	assert.equal(calls[0].url, '/api/v1/chats/chat%2Fa/archive?archived=true');
	assert.equal(calls[0].options.method, 'POST');
	assert.equal(calls[1].url, '/api/v1/chats/chat%2Fa');
	assert.equal(calls[1].options.method, 'GET');
	assert.equal(calls[1].options.cache, 'no-store');
});

test('navbar and sidebar callers share one in-flight archive request', async () => {
	let releaseMutation;
	const mutationGate = new Promise((resolve) => {
		releaseMutation = resolve;
	});
	const calls = [];
	const fetchImpl = async (url, options) => {
		calls.push({ url, method: options.method });
		if (options.method === 'POST') {
			await mutationGate;
			return jsonResponse({ archived: true });
		}
		return jsonResponse({ id: 'shared-chat', archived: true });
	};

	const navbarRequest = archiveChatSafely('token', 'shared-chat', { fetchImpl });
	const sidebarRequest = archiveChatSafely('token', 'shared-chat', { fetchImpl });
	assert.strictEqual(navbarRequest, sidebarRequest);

	releaseMutation();
	await Promise.all([navbarRequest, sidebarRequest]);
	assert.deepEqual(
		calls.map((call) => call.method),
		['POST', 'GET']
	);
});

test('a post-commit transport failure is resolved by the reconciliation read', async () => {
	const calls = [];
	const fetchImpl = async (_url, options) => {
		calls.push(options.method);
		if (options.method === 'POST') {
			throw new Error('connection closed after commit');
		}
		return jsonResponse({ id: 'committed-chat', archived: true });
	};

	const chat = await archiveChatSafely('token', 'committed-chat', { fetchImpl });
	assert.equal(chat.archived, true);
	assert.deepEqual(calls, ['POST', 'GET']);
});

test('an unconfirmed archive rejects and releases the shared claim for a safe retry', async () => {
	let attempt = 0;
	const calls = [];
	const fetchImpl = async (_url, options) => {
		calls.push(options.method);
		if (options.method === 'POST') {
			attempt += 1;
			return jsonResponse({ archived: true });
		}
		return jsonResponse({ id: 'retry-chat', archived: attempt > 1 });
	};

	await assert.rejects(
		archiveChatSafely('token', 'retry-chat', { fetchImpl }),
		/The chat archive state could not be confirmed/
	);
	const chat = await archiveChatSafely('token', 'retry-chat', { fetchImpl });

	assert.equal(chat.archived, true);
	assert.deepEqual(calls, ['POST', 'GET', 'POST', 'GET']);
});
