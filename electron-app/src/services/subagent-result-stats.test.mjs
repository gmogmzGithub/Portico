import test from 'node:test';
import assert from 'node:assert/strict';

import {
	extractSubagentResultStats,
	parseSubagentResultPayload
} from '../../../src/patches/frontend/src/lib/utils/subagent-result-stats.mjs';

test('parseSubagentResultPayload unwraps nested JSON strings', () => {
	const payload = JSON.stringify(
		JSON.stringify({
			chat_id: 'chat-123',
			tool_call_count: 7
		})
	);

	assert.deepEqual(parseSubagentResultPayload(payload), {
		chat_id: 'chat-123',
		tool_call_count: 7
	});
});

test('extractSubagentResultStats derives chat id and display tokens from tool result', () => {
	const stats = extractSubagentResultStats(
		JSON.stringify({
			chat_id: 'chat-456',
			tool_call_count: 7,
			usage_tokens: 1548200,
			context_tokens: 3034894,
			max_context_tokens: 1000000
		})
	);

	assert.equal(stats.chatId, 'chat-456');
	assert.equal(stats.toolCallCount, 7);
	assert.equal(stats.usageTokens, 1548200);
	assert.equal(stats.displayTokens, 1000000);
});

test('extractSubagentResultStats tolerates missing or local chat ids', () => {
	const stats = extractSubagentResultStats(
		JSON.stringify({
			chat_id: 'local:placeholder',
			tool_call_count: 0,
			usage_tokens: 42
		})
	);

	assert.equal(stats.chatId, null);
	assert.equal(stats.toolCallCount, 0);
	assert.equal(stats.displayTokens, 42);
});
