import test from 'node:test';
import assert from 'node:assert/strict';

import {
	resolveSubagentLookupResult,
	resolveSubagentPollingMode
} from '../../../src/patches/frontend/src/lib/utils/subagent-polling-mode.mjs';

test('resolveSubagentPollingMode keeps collapsed in-progress subagents hydrated in background', () => {
	assert.equal(
		resolveSubagentPollingMode({
			hasToolCallId: true,
			isDone: false,
			open: false
		}),
		'background'
	);
});

test('resolveSubagentPollingMode uses foreground polling for open in-progress subagents', () => {
	assert.equal(
		resolveSubagentPollingMode({
			hasToolCallId: true,
			isDone: false,
			open: true
		}),
		'foreground'
	);
});

test('resolveSubagentPollingMode stops polling once the subagent tool call is done', () => {
	assert.equal(
		resolveSubagentPollingMode({
			hasToolCallId: true,
			isDone: true,
			open: false
		}),
		null
	);
});

test('resolveSubagentLookupResult triggers immediate stats hydration for a newly resolved chat', () => {
	assert.deepEqual(
		resolveSubagentLookupResult({
			previousChatId: null,
			lookupPayload: { chat_id: ' child-chat-123 ' }
		}),
		{
			nextChatId: 'child-chat-123',
			shouldFetchStats: true
		}
	);
});

test('resolveSubagentLookupResult avoids duplicate stats fetches for the same chat', () => {
	assert.deepEqual(
		resolveSubagentLookupResult({
			previousChatId: 'child-chat-123',
			lookupPayload: { chat_id: 'child-chat-123' }
		}),
		{
			nextChatId: 'child-chat-123',
			shouldFetchStats: false
		}
	);
});

test('resolveSubagentLookupResult ignores empty lookup payloads', () => {
	assert.deepEqual(
		resolveSubagentLookupResult({
			previousChatId: null,
			lookupPayload: { chat_id: '   ' }
		}),
		{
			nextChatId: null,
			shouldFetchStats: false
		}
	);
});
