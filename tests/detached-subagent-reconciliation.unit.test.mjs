import assert from 'node:assert/strict';
import test from 'node:test';

import {
	extractDetachedSubagentHistory,
	isDetachedSubagentHistoryTerminal,
	mergeDetachedSubagentCollection,
	mergeDetachedSubagentHistory,
	normalizeDetachedSubagentActiveHistory
} from '../src/patches/frontend/src/lib/utils/detached-subagent-reconciliation.mjs';

const userOnlyHistory = () => ({
	currentId: 'user-1',
	messages: {
		'user-1': {
			id: 'user-1',
			role: 'user',
			content: 'research this',
			childrenIds: []
		}
	}
});

test('user-only hydration accepts a newly persisted assistant placeholder', () => {
	const local = userOnlyHistory();
	const snapshot = {
		chat: {
			history: {
				currentId: 'assistant-1',
				messages: {
					'user-1': { ...local.messages['user-1'], childrenIds: ['assistant-1'] },
					'assistant-1': {
						id: 'assistant-1',
						role: 'assistant',
						parentId: 'user-1',
						content: '',
						done: false,
						statusHistory: [{ timestamp: 1, description: 'Starting' }]
					}
				}
			}
		}
	};

	const result = mergeDetachedSubagentHistory(local, snapshot);

	assert.equal(result.changed, true);
	assert.equal(result.history.currentId, 'assistant-1');
	assert.deepEqual(result.history.messages['user-1'].childrenIds, ['assistant-1']);
	assert.equal(result.history.messages['assistant-1'].done, false);
	assert.equal(isDetachedSubagentHistoryTerminal(result.history), false);
});

test('detached hydration normalizes only an incomplete current assistant', () => {
	const history = {
		currentId: 'assistant-2',
		messages: {
			'assistant-1': { id: 'assistant-1', role: 'assistant', done: true, timestamp: 1 },
			'assistant-2': {
				id: 'assistant-2',
				role: 'assistant',
				timestamp: 1_700_000_000
			}
		}
	};

	const normalized = normalizeDetachedSubagentActiveHistory(history, 1_700_000_010_000);
	assert.equal(normalized.changed, true);
	assert.equal(normalized.history.messages['assistant-2'].done, false);
	assert.equal(normalized.history.messages['assistant-2'].streamStartedAt, 1_700_000_000_000);
	assert.equal(normalized.history.messages['assistant-1'].done, true);
	assert.equal(history.messages['assistant-2'].done, undefined, 'input remains immutable');

	const repeated = normalizeDetachedSubagentActiveHistory(
		normalized.history,
		1_700_000_020_000
	);
	assert.equal(repeated.changed, false);
	assert.equal(repeated.history.messages['assistant-2'].streamStartedAt, 1_700_000_000_000);
});

test('detached activity normalization never revives terminal or legacy history', () => {
	for (const terminalState of [
		{ done: true },
		{ error: { content: 'failed' } },
		{ stop_reason: 'end_turn' },
		{ completed: true },
		{ status: 'completed' }
	]) {
		const history = {
			currentId: 'assistant-1',
			messages: {
				'assistant-1': {
					id: 'assistant-1',
					role: 'assistant',
					timestamp: 10,
					...terminalState
				}
			}
		};
		const result = normalizeDetachedSubagentActiveHistory(history, 20_000);
		assert.equal(result.changed, false, JSON.stringify(terminalState));
		assert.equal(result.history, history);
	}

	const legacyHistory = {
		currentId: 'user-2',
		messages: {
			'assistant-1': { id: 'assistant-1', role: 'assistant', timestamp: 10 },
			'user-2': { id: 'user-2', role: 'user', timestamp: 20 }
		}
	};
	assert.equal(
		normalizeDetachedSubagentActiveHistory(legacyHistory, 20_000).changed,
		false
	);
	const oldUnmarkedHistory = {
		currentId: 'assistant-old',
		messages: {
			'assistant-old': {
				id: 'assistant-old',
				role: 'assistant',
				timestamp: 1_700_000_000
			}
		}
	};
	assert.equal(
		normalizeDetachedSubagentActiveHistory(
			oldUnmarkedHistory,
			1_700_000_000_000 + 2 * 60 * 60 * 1000
		).changed,
		false
	);
	assert.equal(
		normalizeDetachedSubagentActiveHistory(
			{
				currentId: 'assistant-1',
				messages: { 'assistant-1': { id: 'assistant-1', role: 'assistant' } }
			},
			123
		).changed,
		true
	);
});

test('structured progress merges monotonically without regressing streamed text or usage', () => {
	const local = {
		currentId: 'assistant-1',
		messages: {
			'assistant-1': {
				id: 'assistant-1',
				role: 'assistant',
				content: 'A longer streamed answer',
				done: false,
				usage: { prompt_tokens: 100, completion_tokens: 25 },
				statusHistory: [{ timestamp: 1, description: 'Searching' }],
				contentBlocks: [
					{ type: 'reasoning', text: 'I am investigating', done: false },
					{
						type: 'tool_calls',
						content: [{ id: 'call-1', function: { name: 'search', arguments: '{}' } }],
						results: []
					}
				],
				files: [{ id: 'file-1', name: 'first.txt' }],
				sources: [{ url: 'https://example.com/one' }]
			}
		}
	};
	const snapshot = {
		history: {
			currentId: 'assistant-1',
			messages: {
				'assistant-1': {
					id: 'assistant-1',
					role: 'assistant',
					content: 'A shorter',
					done: false,
					usage: { prompt_tokens: 90, completion_tokens: 30, total_tokens: 120 },
					statusHistory: [
						{ timestamp: 1, description: 'Searching', done: true },
						{ timestamp: 2, description: 'Reading results' }
					],
					contentBlocks: [
						{ type: 'reasoning', text: 'I am investigating several sources', done: true },
						{
							type: 'tool_calls',
							content: [{ id: 'call-1', function: { name: 'search', arguments: '{}' } }],
							results: [{ tool_call_id: 'call-1', content: 'found it' }]
						}
					],
					files: [{ id: 'file-2', name: 'second.txt' }],
					sources: [{ url: 'https://example.com/two' }]
				}
			}
		}
	};

	const { history } = mergeDetachedSubagentHistory(local, snapshot);
	const message = history.messages['assistant-1'];

	assert.equal(message.content, 'A longer streamed answer');
	assert.deepEqual(message.usage, {
		prompt_tokens: 100,
		completion_tokens: 30,
		total_tokens: 120
	});
	assert.equal(message.statusHistory.length, 2);
	assert.equal(message.statusHistory[0].done, true);
	assert.equal(message.contentBlocks[0].text, 'I am investigating several sources');
	assert.equal(message.contentBlocks[0].done, true);
	assert.equal(message.contentBlocks[1].results[0].content, 'found it');
	assert.deepEqual(
		message.files.map((file) => file.id),
		['file-1', 'file-2']
	);
	assert.deepEqual(
		message.sources.map((source) => source.url),
		['https://example.com/one', 'https://example.com/two']
	);
});

test('terminal snapshots retain richer local fields while advancing terminal state', () => {
	const local = {
		currentId: 'assistant-1',
		messages: {
			'assistant-1': {
				id: 'assistant-1',
				role: 'assistant',
				content: 'Complete answer with details',
				done: false,
				files: [{ id: 'artifact-1' }]
			}
		}
	};
	const snapshot = {
		chat: {
			history: {
				currentId: 'assistant-1',
				messages: {
					'assistant-1': {
						id: 'assistant-1',
						role: 'assistant',
						content: 'Complete answer',
						done: true,
						stop_reason: 'end_turn',
						usage: { total_tokens: 300 }
					}
				}
			}
		}
	};

	const { history } = mergeDetachedSubagentHistory(local, snapshot);

	assert.equal(history.messages['assistant-1'].content, 'Complete answer with details');
	assert.equal(history.messages['assistant-1'].done, true);
	assert.equal(history.messages['assistant-1'].stop_reason, 'end_turn');
	assert.deepEqual(history.messages['assistant-1'].files, [{ id: 'artifact-1' }]);
	assert.equal(isDetachedSubagentHistoryTerminal(history), true);
});

test('stale user-only currentId cannot hide an already inserted assistant', () => {
	const local = {
		currentId: 'assistant-1',
		messages: {
			'user-1': { id: 'user-1', role: 'user', parentId: null, childrenIds: ['assistant-1'] },
			'assistant-1': {
				id: 'assistant-1',
				role: 'assistant',
				parentId: 'user-1',
				content: 'working',
				done: false
			}
		}
	};
	const staleSnapshot = {
		history: {
			currentId: 'user-1',
			messages: {
				'user-1': { id: 'user-1', role: 'user', parentId: null, childrenIds: [] }
			}
		}
	};

	const { history } = mergeDetachedSubagentHistory(local, staleSnapshot);

	assert.equal(history.currentId, 'assistant-1');
	assert.equal(history.messages['assistant-1'].content, 'working');
});

test('scalar status and terminal booleans cannot regress', () => {
	const local = {
		currentId: 'assistant-1',
		messages: {
			'assistant-1': {
				id: 'assistant-1',
				role: 'assistant',
				content: 'done',
				done: true,
				completed: true,
				status: 'completed'
			}
		}
	};
	const staleSnapshot = {
		history: {
			currentId: 'assistant-1',
			messages: {
				'assistant-1': {
					id: 'assistant-1',
					role: 'assistant',
					content: 'done',
					done: false,
					completed: false,
					status: 'running'
				}
			}
		}
	};

	const { history } = mergeDetachedSubagentHistory(local, staleSnapshot);
	const message = history.messages['assistant-1'];

	assert.equal(message.done, true);
	assert.equal(message.completed, true);
	assert.equal(message.status, 'completed');
	assert.equal(isDetachedSubagentHistoryTerminal(history), true);
});

test('every persisted terminal shape stops detached reconciliation', () => {
	for (const terminalField of [
		{ completed: true },
		{ cancelled: true },
		{ canceled: true },
		{ failed: true },
		{ finished: true },
		{ stopped: true },
		{ terminal: true },
		{ status: 'completed' },
		{ status: 'error' }
	]) {
		const history = {
			currentId: 'assistant-1',
			messages: {
				'assistant-1': {
					id: 'assistant-1',
					role: 'assistant',
					content: 'terminal',
					...terminalField
				}
			}
		};
		assert.equal(
			isDetachedSubagentHistoryTerminal(history),
			true,
			`expected terminal field ${JSON.stringify(terminalField)}`
		);
	}
});

test('error is terminal and nested response shape is extracted', () => {
	const snapshot = {
		chat: {
			history: {
				currentId: 'assistant-1',
				messages: {
					'assistant-1': {
						role: 'assistant',
						done: true,
						error: { content: 'failed' }
					}
				}
			}
		}
	};

	assert.equal(extractDetachedSubagentHistory(snapshot), snapshot.chat.history);
	assert.equal(isDetachedSubagentHistoryTerminal(snapshot.chat.history), true);
});

test('top-level file reconciliation remains distinct and stable', () => {
	assert.deepEqual(
		mergeDetachedSubagentCollection(
			[{ id: 'one', name: 'one.txt' }],
			[
				{ id: 'one', name: 'one.txt', size: 10 },
				{ id: 'two', name: 'two.txt' }
			],
			'files'
		),
		[
			{ id: 'one', name: 'one.txt', size: 10 },
			{ id: 'two', name: 'two.txt' }
		]
	);
});
