import test from 'node:test';
import assert from 'node:assert/strict';

import {
	getDisplayContextTokenCount,
	getDisplayTokenCountFromUsage,
	getLatestContextUsageFromHistory
} from '../../../src/patches/frontend/src/lib/utils/usage-tokens.mjs';

test('getDisplayTokenCountFromUsage prefers prompt tokens and does not double count cache tokens', () => {
	const usage = {
		prompt_tokens: 879408,
		completion_tokens: 4850,
		total_tokens: 884258,
		cached_tokens: 760371,
		cache_read_input_tokens: 760371,
		cache_creation_input_tokens: 148259,
		cache_write_input_tokens: 148259
	};

	assert.equal(getDisplayTokenCountFromUsage(usage), 879408);
});

test('getDisplayTokenCountFromUsage falls back to total when prompt tokens are missing', () => {
	const usage = {
		completion_tokens: 3456,
		total_tokens: 123456,
		cache_read_input_tokens: 90000
	};

	assert.equal(getDisplayTokenCountFromUsage(usage), 123456);
});

test('getDisplayTokenCountFromUsage prefers input token aliases when present', () => {
	const usage = {
		input_tokens: 555000,
		output_tokens: 12000,
		total_tokens: 567000
	};

	assert.equal(getDisplayTokenCountFromUsage(usage), 555000);
});

test('getDisplayTokenCountFromUsage falls back to the best available usage counter', () => {
	assert.equal(getDisplayTokenCountFromUsage({ prompt_tokens: 777 }), 777);
	assert.equal(getDisplayTokenCountFromUsage({ completion_tokens: 222 }), 222);
	assert.equal(getDisplayTokenCountFromUsage(undefined), 0);
});

test('getLatestContextUsageFromHistory retains the previous turn while the current assistant is empty', () => {
	const previousUsage = { prompt_tokens: 879408, completion_tokens: 4850 };
	const messages = {
		'assistant-1': {
			id: 'assistant-1',
			parentId: 'user-1',
			role: 'assistant',
			usage: previousUsage
		},
		'user-2': {
			id: 'user-2',
			parentId: 'assistant-1',
			role: 'user'
		},
		'assistant-2': {
			id: 'assistant-2',
			parentId: 'user-2',
			role: 'assistant',
			done: false
		}
	};

	assert.equal(getLatestContextUsageFromHistory(messages, 'assistant-2'), previousUsage);
	assert.equal(
		getDisplayContextTokenCount({
			usage: getLatestContextUsageFromHistory(messages, 'assistant-2'),
			persistedContextTokens: 0,
			persistedMaxContextTokens: 1000000
		}),
		879408
	);
});

test('getLatestContextUsageFromHistory accepts lower and higher measurements from the current turn', () => {
	const messages = {
		'assistant-1': {
			id: 'assistant-1',
			parentId: 'user-1',
			role: 'assistant',
			usage: { prompt_tokens: 879408 }
		},
		'user-2': {
			id: 'user-2',
			parentId: 'assistant-1',
			role: 'user'
		},
		'assistant-2': {
			id: 'assistant-2',
			parentId: 'user-2',
			role: 'assistant',
			usage: { prompt_tokens: 410000 }
		}
	};

	assert.equal(
		getDisplayTokenCountFromUsage(
			getLatestContextUsageFromHistory(messages, 'assistant-2')
		),
		410000
	);

	messages['assistant-2'].usage = { prompt_tokens: 959548 };
	assert.equal(
		getDisplayTokenCountFromUsage(
			getLatestContextUsageFromHistory(messages, 'assistant-2')
		),
		959548
	);
});

test('getLatestContextUsageFromHistory stays on the active branch', () => {
	const activeBranchUsage = { prompt_tokens: 420000 };
	const messages = {
		'assistant-root': {
			id: 'assistant-root',
			parentId: 'user-root',
			role: 'assistant',
			usage: activeBranchUsage
		},
		'user-active': {
			id: 'user-active',
			parentId: 'assistant-root',
			role: 'user'
		},
		'assistant-active': {
			id: 'assistant-active',
			parentId: 'user-active',
			role: 'assistant'
		},
		'assistant-sibling': {
			id: 'assistant-sibling',
			parentId: 'user-root',
			role: 'assistant',
			usage: { prompt_tokens: 999999 }
		}
	};

	assert.equal(
		getLatestContextUsageFromHistory(messages, 'assistant-active'),
		activeBranchUsage
	);
});

test('getLatestContextUsageFromHistory fails safely for missing and cyclic history', () => {
	assert.equal(getLatestContextUsageFromHistory(null, 'assistant-1'), undefined);
	assert.equal(getLatestContextUsageFromHistory({}, 'missing'), undefined);
	assert.equal(
		getLatestContextUsageFromHistory(
			{
				'assistant-1': {
					id: 'assistant-1',
					parentId: 'user-1',
					role: 'assistant'
				},
				'user-1': {
					id: 'user-1',
					parentId: 'assistant-1',
					role: 'user'
				}
			},
			'assistant-1'
		),
		undefined
	);
});

test('getDisplayContextTokenCount prefers live streamed usage over older persisted chat-state', () => {
	assert.equal(
		getDisplayContextTokenCount({
			usage: {
				prompt_tokens: 959548,
				completion_tokens: 3984,
				total_tokens: 963532
			},
			persistedContextTokens: 270000,
			persistedMaxContextTokens: 1000000
		}),
		959548
	);
});

test('getDisplayContextTokenCount falls back to persisted chat-state when live usage is unavailable', () => {
	assert.equal(
		getDisplayContextTokenCount({
			usage: {},
			persistedContextTokens: 879408,
			persistedMaxContextTokens: 1000000
		}),
		879408
	);
});

test('getDisplayContextTokenCount caps live usage to the persisted model window', () => {
	assert.equal(
		getDisplayContextTokenCount({
			usage: {
				prompt_tokens: 1548200
			},
			persistedContextTokens: 0,
			persistedMaxContextTokens: 1000000
		}),
		1000000
	);
});
