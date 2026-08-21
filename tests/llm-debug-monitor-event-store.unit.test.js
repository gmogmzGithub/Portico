const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { build } = require('../electron-app/node_modules/esbuild');

const REPO_ROOT = path.resolve(__dirname, '..');

let tempDir;
let eventStoreModule;

async function bundleModule(entryPath, outFile, tsconfig) {
	await build({
		entryPoints: [path.join(REPO_ROOT, entryPath)],
		bundle: true,
		format: 'cjs',
		platform: 'node',
		target: ['node20'],
		logLevel: 'silent',
		tsconfig,
		outfile: outFile
	});
	return require(outFile);
}

function resetStore() {
	eventStoreModule.useEventStore.getState().clearEvents();
	eventStoreModule.useEventStore.setState({
		selectionOrigin: null,
		selectedToolCallId: null,
		isConnected: false
	});
}

before(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-debug-monitor-store-tests-'));
	eventStoreModule = await bundleModule(
		'llm-debug-monitor/src/store/eventStore.ts',
		path.join(tempDir, 'eventStore.cjs'),
		path.join(REPO_ROOT, 'llm-debug-monitor/tsconfig.json')
	);
});

after(async () => {
	if (tempDir) {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test('frontend monitor store keeps same outer-turn requests separate by upstream request id', () => {
	resetStore();

	const processEvent = eventStoreModule.useEventStore.getState().processEvent;
	processEvent({
		event_id: 'req-0',
		event_type: 'llm_request_start',
		timestamp: '2026-03-27T10:00:00Z',
		session_id: 'session-1',
		chat_id: 'chat-1',
		debug_request_id: 'dbg-shared',
		upstream_request_id: 'upstream-0',
		data: {
			model: 'Atlas Opus 4.6',
			base_model: 'Atlas Opus 4.6',
			message_count: 1,
			tool_ids: [],
			skills: [],
			metadata: {
				message_id: 'assistant-1',
				debug_request_id: 'dbg-shared',
				upstream_request_id: 'upstream-0',
				request_phase: 'initial',
				followup_index: 0,
				outer_message_id: 'assistant-1',
				trigger_message_id: 'user-1',
				transcript_anchor_kind: 'user_message',
				transcript_anchor_message_id: 'user-1'
			}
		}
	});
	processEvent({
		event_id: 'req-1',
		event_type: 'llm_request_start',
		timestamp: '2026-03-27T10:00:01Z',
		session_id: 'session-1',
		chat_id: 'chat-1',
		debug_request_id: 'dbg-shared',
		upstream_request_id: 'upstream-1',
		data: {
			model: 'Atlas Opus 4.6',
			base_model: 'Atlas Opus 4.6',
			message_count: 3,
			tool_ids: ['tool-1'],
			skills: [],
			metadata: {
				message_id: 'assistant-1',
				debug_request_id: 'dbg-shared',
				upstream_request_id: 'upstream-1',
				request_phase: 'tool_followup',
				followup_index: 1,
				outer_message_id: 'assistant-1',
				trigger_message_id: 'user-1',
				transcript_anchor_kind: 'assistant_tool_block',
				transcript_anchor_message_id: 'assistant-1',
				transcript_anchor_tool_block_index: 1
			}
		}
	});

	const state = eventStoreModule.useEventStore.getState();
	assert.equal(state.requests.size, 2);
	assert.equal(state.chats.get('chat-1').request_count, 2);

	const initial = state.requests.get('upstream-0');
	const followup = state.requests.get('upstream-1');
	assert.equal(initial.debug_request_id, 'dbg-shared');
	assert.equal(initial.transcript_anchor_kind, 'user_message');
	assert.equal(initial.transcript_anchor_message_id, 'user-1');
	assert.equal(initial.transcript_anchor_tool_block_index, undefined);
	assert.equal(followup.debug_request_id, 'dbg-shared');
	assert.equal(followup.followup_index, 1);
	assert.equal(followup.transcript_anchor_kind, 'assistant_tool_block');
	assert.equal(followup.transcript_anchor_message_id, 'assistant-1');
	assert.equal(followup.transcript_anchor_tool_block_index, 1);
});

test('frontend monitor store parses payload-only anchor metadata and preserves it through response completion', () => {
	resetStore();

	const processEvent = eventStoreModule.useEventStore.getState().processEvent;
	processEvent({
		event_id: 'payload-1',
		event_type: 'llm_request_payload',
		timestamp: '2026-03-27T10:05:00Z',
		session_id: 'session-2',
		chat_id: 'chat-2',
		data: {
			model: 'Atlas Opus 4.6',
			base_model: 'Atlas Opus 4.6',
			messages: [{ role: 'user', content: 'hello' }],
			tools: [{ id: 'tool-1' }],
			raw_payload: {
				metadata: {
					message_id: 'assistant-2',
					debug_request_id: 'dbg-2',
					upstream_request_id: 'upstream-2',
					request_phase: 'tool_followup',
					followup_index: '3',
					outer_message_id: 'assistant-2',
					trigger_message_id: 'user-2',
					transcript_anchor_kind: 'assistant_tool_block',
					transcript_anchor_message_id: 'assistant-2',
					transcript_anchor_tool_block_index: '4'
				}
			}
		}
	});
	processEvent({
		event_id: 'resp-1',
		event_type: 'llm_response_complete',
		timestamp: '2026-03-27T10:05:02Z',
		session_id: 'session-2',
		chat_id: 'chat-2',
		upstream_request_id: 'upstream-2',
		data: {
			model: 'Atlas Opus 4.6',
			duration_ms: 250,
			finish_reason: 'stop',
			usage: { prompt_tokens: 11 },
			ultra_audit: {
				child_agent_count: 1,
				tool_call_count: 2,
				child_tool_call_count: 1,
				tool_result_count: 2,
				continuation_count: 1,
				arguments_logged: false,
				results_logged: false
			}
		}
	});

	const request = eventStoreModule.useEventStore.getState().requests.get('upstream-2');
	assert.equal(request.request_phase, 'tool_followup');
	assert.equal(request.followup_index, 3);
	assert.equal(request.transcript_anchor_kind, 'assistant_tool_block');
	assert.equal(request.transcript_anchor_message_id, 'assistant-2');
	assert.equal(request.transcript_anchor_tool_block_index, 4);
	assert.equal(request.status, 'complete');
	assert.deepEqual(request.response.usage, { prompt_tokens: 11 });
	assert.deepEqual(request.response.ultra_audit, {
		child_agent_count: 1,
		tool_call_count: 2,
		child_tool_call_count: 1,
		tool_result_count: 2,
		continuation_count: 1,
		arguments_logged: false,
		results_logged: false
	});
});

test('frontend monitor store matches transformed payloads by upstream request id before shared debug request id', () => {
	resetStore();

	const processEvent = eventStoreModule.useEventStore.getState().processEvent;
	for (const upstreamRequestId of ['upstream-a', 'upstream-b']) {
		processEvent({
			event_id: `req-${upstreamRequestId}`,
			event_type: 'llm_request_start',
			timestamp: '2026-03-27T10:10:00Z',
			session_id: 'session-3',
			chat_id: 'chat-3',
			debug_request_id: 'dbg-shared',
			upstream_request_id: upstreamRequestId,
			data: {
				model: 'Atlas Opus 4.6',
				base_model: 'Atlas Opus 4.6',
				message_count: 2,
				tool_ids: [],
				skills: [],
				metadata: {
					message_id: 'assistant-3',
					debug_request_id: 'dbg-shared',
					upstream_request_id: upstreamRequestId,
					trigger_message_id: 'user-3',
					transcript_anchor_kind: 'assistant_tool_block',
					transcript_anchor_message_id: 'assistant-3',
					transcript_anchor_tool_block_index: 2
				}
			}
		});
	}

	processEvent({
		event_id: 'stage-b',
		event_type: 'llm_request_transformed',
		timestamp: '2026-03-27T10:10:02Z',
		session_id: 'session-3',
		chat_id: 'chat-3',
		message_id: 'assistant-3',
		debug_request_id: 'dbg-shared',
		upstream_request_id: 'upstream-b',
		data: {
			model: 'Atlas Opus 4.6',
			api_path: 'bedrock-converse',
			payload: { messages: [{ role: 'user', content: 'hello' }] }
		}
	});

	const state = eventStoreModule.useEventStore.getState();
	assert.deepEqual(state.requests.get('upstream-a').transformed_payloads, []);
	assert.equal(state.requests.get('upstream-b').transformed_payloads.length, 1);
	assert.equal(
		state.requests.get('upstream-b').transformed_payloads[0].api_path,
		'bedrock-converse'
	);
	assert.equal(state.requests.get('upstream-b').trigger_message_id, 'user-3');
	assert.equal(
		state.requests.get('upstream-b').transcript_anchor_tool_block_index,
		2
	);
});

test('frontend monitor store extracts transformed payload metadata and preserves zero tool block indices', () => {
	resetStore();

	const processEvent = eventStoreModule.useEventStore.getState().processEvent;
	processEvent({
		event_id: 'transformed-zero',
		event_type: 'llm_request_transformed',
		timestamp: '2026-03-28T09:00:00Z',
		session_id: 'session-zero',
		chat_id: 'chat-zero',
		data: {
			model: 'Atlas Opus 4.6',
			api_path: 'responses',
			payload: {
				messages: [{ role: 'user', content: 'hello' }],
				tools: [{ id: 'tool-1' }],
				metadata: {
					message_id: 'assistant-zero',
					debug_request_id: 'dbg-zero',
					upstream_request_id: 'upstream-zero',
					request_phase: 'tool_followup',
					followup_index: 0,
					outer_message_id: 'assistant-zero',
					trigger_message_id: 'user-zero',
					transcript_anchor_kind: 'assistant_tool_block',
					transcript_anchor_message_id: 'assistant-zero',
					transcript_anchor_tool_block_index: 0
				}
			}
		}
	});
	processEvent({
		event_id: 'response-zero',
		event_type: 'llm_response_complete',
		timestamp: '2026-03-28T09:00:02Z',
		session_id: 'session-zero',
		chat_id: 'chat-zero',
		upstream_request_id: 'upstream-zero',
		data: {
			model: 'Atlas Opus 4.6',
			duration_ms: 120
		}
	});

	const request = eventStoreModule.useEventStore.getState().requests.get('upstream-zero');
	assert.equal(request.message_id, 'assistant-zero');
	assert.equal(request.request_phase, 'tool_followup');
	assert.equal(request.followup_index, 0);
	assert.equal(request.outer_message_id, 'assistant-zero');
	assert.equal(request.trigger_message_id, 'user-zero');
	assert.equal(request.transcript_anchor_kind, 'assistant_tool_block');
	assert.equal(request.transcript_anchor_message_id, 'assistant-zero');
	assert.equal(request.transcript_anchor_tool_block_index, 0);
	assert.equal(request.status, 'complete');
	assert.equal(request.transformed_payloads.length, 1);
});

test('frontend monitor store preserves hydrated response payloads for deep-linked request details', () => {
	resetStore();

	const store = eventStoreModule.useEventStore.getState();
	store.hydrateChatRequests('chat-response', [
		{
			request_id: 'req-response',
			timestamp: '2026-03-29T10:00:00Z',
			chat_id: 'chat-response',
			model: 'Atlas Opus 4.6',
			message_count: 3,
			tool_count: 0,
			status: 'complete',
			usage: {
				prompt_tokens: 10,
				completion_tokens: 5,
				total_tokens: 15
			}
		}
	]);

	store.hydrateRequestDetail({
		request_id: 'req-response',
		chat_id: 'chat-response',
		session_id: 'session-response',
		timestamp: '2026-03-29T10:00:00Z',
		model: 'Atlas Opus 4.6',
		messages: [{ role: 'user', content: 'hello' }],
		tools: [],
		parameters: {},
		raw_payload: {},
		status: 'complete',
		response: {
			content: 'Deep linked response body',
			tool_calls: [],
			finish_reason: 'stop',
			usage: {
				prompt_tokens: 10,
				completion_tokens: 5,
				total_tokens: 15
			},
			thinking: ''
		}
	});

	const request = eventStoreModule.useEventStore.getState().requests.get('req-response');
	assert.equal(request.response.content, 'Deep linked response body');
	assert.equal(request.response.finish_reason, 'stop');
	assert.deepEqual(request.response.usage, {
		prompt_tokens: 10,
		completion_tokens: 5,
		total_tokens: 15
	});
});

test('frontend monitor store rekeys legacy debug-id requests when a later payload introduces an upstream request id', () => {
	resetStore();

	const processEvent = eventStoreModule.useEventStore.getState().processEvent;
	processEvent({
		event_id: 'req-legacy',
		event_type: 'llm_request_start',
		timestamp: '2026-03-27T10:12:00Z',
		session_id: 'session-legacy',
		chat_id: 'chat-legacy',
		debug_request_id: 'dbg-legacy',
		data: {
			model: 'Atlas Opus 4.6',
			base_model: 'Atlas Opus 4.6',
			message_count: 1,
			tool_ids: [],
			skills: [],
			metadata: {
				message_id: 'assistant-legacy',
				debug_request_id: 'dbg-legacy',
				trigger_message_id: 'user-legacy',
				transcript_anchor_kind: 'user_message',
				transcript_anchor_message_id: 'user-legacy'
			}
		}
	});
	processEvent({
		event_id: 'payload-legacy',
		event_type: 'llm_request_payload',
		timestamp: '2026-03-27T10:12:01Z',
		session_id: 'session-legacy',
		chat_id: 'chat-legacy',
		debug_request_id: 'dbg-legacy',
		data: {
			model: 'Atlas Opus 4.6',
			base_model: 'Atlas Opus 4.6',
			messages: [{ role: 'user', content: 'hello' }],
			tools: [],
			raw_payload: {
				metadata: {
					message_id: 'assistant-legacy',
					debug_request_id: 'dbg-legacy',
					upstream_request_id: 'upstream-legacy',
					request_phase: 'initial',
					trigger_message_id: 'user-legacy',
					transcript_anchor_kind: 'user_message',
					transcript_anchor_message_id: 'user-legacy'
				}
			}
		}
	});

	const state = eventStoreModule.useEventStore.getState();
	assert.equal(state.requests.size, 1);
	assert.equal(state.requests.has('dbg-legacy'), false);
	assert.equal(state.requests.has('upstream-legacy'), true);
	assert.equal(state.requests.get('upstream-legacy').debug_request_id, 'dbg-legacy');
	assert.equal(state.requests.get('upstream-legacy').trigger_message_id, 'user-legacy');
	assert.equal(state.requests.get('upstream-legacy').transcript_anchor_kind, 'user_message');
});

test('frontend monitor store falls back to debug request identity for legacy transformed payloads without upstream ids', () => {
	resetStore();

	const processEvent = eventStoreModule.useEventStore.getState().processEvent;
	processEvent({
		event_id: 'req-legacy-transform',
		event_type: 'llm_request_start',
		timestamp: '2026-03-27T10:13:00Z',
		session_id: 'session-legacy-transform',
		chat_id: 'chat-legacy-transform',
		debug_request_id: 'dbg-transform',
		data: {
			model: 'Atlas Opus 4.6',
			base_model: 'Atlas Opus 4.6',
			message_count: 1,
			tool_ids: [],
			skills: [],
			metadata: {
				message_id: 'assistant-transform',
				debug_request_id: 'dbg-transform'
			}
		}
	});
	processEvent({
		event_id: 'stage-legacy-transform',
		event_type: 'llm_request_transformed',
		timestamp: '2026-03-27T10:13:01Z',
		session_id: 'session-legacy-transform',
		chat_id: 'chat-legacy-transform',
		debug_request_id: 'dbg-transform',
		message_id: 'assistant-transform',
		data: {
			model: 'Atlas Opus 4.6',
			api_path: 'chat-completions',
			payload: { messages: [{ role: 'user', content: 'legacy hello' }] }
		}
	});

	const request = eventStoreModule.useEventStore.getState().requests.get('dbg-transform');
	assert.equal(request.transformed_payloads.length, 1);
	assert.equal(request.transformed_payloads[0].api_path, 'chat-completions');
});
test('frontend monitor store tracks auxiliary background requests and preserves anchors through errors', () => {
	resetStore();

	const processEvent = eventStoreModule.useEventStore.getState().processEvent;
	processEvent({
		event_id: 'req-aux',
		event_type: 'llm_request_start',
		timestamp: '2026-03-27T10:15:00Z',
		session_id: 'session-4',
		chat_id: 'chat-4',
		debug_request_id: 'dbg-aux',
		upstream_request_id: 'upstream-aux',
		task_name: 'title_generation',
		data: {
			model: 'Atlas Haiku 4.5',
			base_model: 'Atlas Haiku 4.5',
			message_count: 1,
			tool_ids: [],
			skills: [],
			metadata: {
				message_id: 'assistant-4',
				debug_request_id: 'dbg-aux',
				upstream_request_id: 'upstream-aux',
				task: 'title_generation',
				transcript_anchor_kind: 'background'
			}
		}
	});
	processEvent({
		event_id: 'err-aux',
		event_type: 'error',
		timestamp: '2026-03-27T10:15:01Z',
		session_id: 'session-4',
		chat_id: 'chat-4',
		upstream_request_id: 'upstream-aux',
		data: { error: 'boom' }
	});

	const request = eventStoreModule.useEventStore.getState().requests.get('upstream-aux');
	assert.equal(request.task_name, 'title_generation');
	assert.equal(request.is_auxiliary, true);
	assert.equal(request.transcript_anchor_kind, 'background');
	assert.equal(request.transcript_anchor_message_id, undefined);
	assert.equal(request.transcript_anchor_tool_block_index, undefined);
	assert.equal(request.status, 'error');
});

test('frontend monitor store hydrates chat request summaries for deep links and preserves request-local metadata', () => {
	resetStore();

	const store = eventStoreModule.useEventStore.getState();
	store.hydrateChatRequests(
		'chat-deep-link',
		[
			{
				request_id: 'upstream-2',
				timestamp: '2026-03-27T10:00:02Z',
				chat_id: 'chat-deep-link',
				model: 'Atlas Opus 4.6',
				status: 'complete',
				message_count: 3,
				tool_count: 1,
				debug_request_id: 'dbg-outer',
				upstream_request_id: 'upstream-2',
				request_phase: 'tool_followup',
				followup_index: 1,
				outer_message_id: 'assistant-1',
				trigger_message_id: 'user-1',
				transcript_anchor_kind: 'assistant_tool_block',
				transcript_anchor_message_id: 'assistant-1',
				transcript_anchor_tool_block_index: 1,
				tool_ids: ['server:skills', 'server:google_workspace'],
				skills: ['calibration-host']
			},
			{
				request_id: 'upstream-1',
				timestamp: '2026-03-27T10:00:00Z',
				chat_id: 'chat-deep-link',
				model: 'Atlas Opus 4.6',
				status: 'complete',
				message_count: 1,
				tool_count: 0,
				debug_request_id: 'dbg-outer',
				upstream_request_id: 'upstream-1',
				request_phase: 'initial',
				followup_index: 0,
				outer_message_id: 'assistant-1',
				trigger_message_id: 'user-1',
				transcript_anchor_kind: 'user_message',
				transcript_anchor_message_id: 'user-1',
				tool_ids: ['server:skills'],
				skills: []
			}
		],
		2
	);
	store.setSelection('chat-deep-link', 'upstream-1', 'deep_link');

	const state = eventStoreModule.useEventStore.getState();
	assert.equal(state.selectedChatId, 'chat-deep-link');
	assert.equal(state.selectedRequestId, 'upstream-1');
	assert.equal(state.selectionOrigin, 'deep_link');
	assert.equal(state.chats.get('chat-deep-link').request_count, 2);
	assert.equal(state.requests.get('upstream-1').transcript_anchor_kind, 'user_message');
	assert.deepEqual(state.requests.get('upstream-2').tool_ids, [
		'server:skills',
		'server:google_workspace'
	]);
	assert.equal(state.requests.get('upstream-2').transcript_anchor_tool_block_index, 1);
});

test('frontend monitor store merges full request detail into an existing summary shell', () => {
	resetStore();

	const store = eventStoreModule.useEventStore.getState();
	store.hydrateChatRequests(
		'chat-detail',
		[
			{
				request_id: 'upstream-detail',
				timestamp: '2026-03-27T10:05:00Z',
				chat_id: 'chat-detail',
				model: 'Atlas Opus 4.6',
				status: 'streaming',
				message_count: 2,
				tool_count: 1,
				debug_request_id: 'dbg-detail',
				upstream_request_id: 'upstream-detail',
				request_phase: 'tool_followup',
				followup_index: 2,
				outer_message_id: 'assistant-9',
				trigger_message_id: 'user-9',
				transcript_anchor_kind: 'assistant_tool_block',
				transcript_anchor_message_id: 'assistant-9',
				transcript_anchor_tool_block_index: 2,
				tool_ids: ['server:google_workspace'],
				skills: ['calibration-host']
			}
		],
		1
	);

	store.hydrateRequestDetail({
		request_id: 'upstream-detail',
		chat_id: 'chat-detail',
		session_id: 'session-detail',
		timestamp: '2026-03-27T10:05:00Z',
		model: 'Atlas Opus 4.6',
		base_model: 'Atlas Opus 4.6',
		message_id: 'assistant-9',
		debug_request_id: 'dbg-detail',
		upstream_request_id: 'upstream-detail',
		request_phase: 'tool_followup',
		followup_index: 2,
		outer_message_id: 'assistant-9',
		trigger_message_id: 'user-9',
		transcript_anchor_kind: 'assistant_tool_block',
		transcript_anchor_message_id: 'assistant-9',
		transcript_anchor_tool_block_index: 2,
		messages: [
			{ role: 'assistant', content: 'Working on it' },
			{ role: 'tool', content: 'tool output', tool_call_id: 'tool-call-1' }
		],
		parameters: { max_tokens: 1024 },
		raw_payload: { messages: [{ role: 'assistant', content: 'Working on it' }] },
		transformed_payloads: [
			{
				event_id: 'stage-1',
				api_path: 'bedrock-converse',
				payload: { input: [] }
			}
		],
		status: 'complete',
		response: {
			content: 'Done',
			finish_reason: 'stop',
			usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
		},
		duration_ms: 777,
		tool_ids: ['server:google_workspace', 'server:agent-vm'],
		skills: ['calibration-host']
	});

	const request = eventStoreModule.useEventStore.getState().requests.get('upstream-detail');
	assert.equal(request.session_id, 'session-detail');
	assert.equal(request.messages.length, 2);
	assert.equal(request.parameters.max_tokens, 1024);
	assert.equal(request.transformed_payloads.length, 1);
	assert.equal(request.response.content, 'Done');
	assert.deepEqual(request.tool_ids, ['server:google_workspace', 'server:agent-vm']);
	assert.deepEqual(request.skills, ['calibration-host']);
});
