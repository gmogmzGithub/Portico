const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { build } = require('../electron-app/node_modules/esbuild');

const REPO_ROOT = path.resolve(__dirname, '..');
const CHAT_SVELTE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/Chat.svelte'
);
const MESSAGE_INPUT_SVELTE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/MessageInput.svelte'
);
const COMPOSER_METRICS_SVELTE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/MessageInput/ComposerMetrics.svelte'
);
const MESSAGES_SVELTE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/Messages.svelte'
);
const ELECTRON_RENDERER_INDEX_JS_PATH = path.join(
	REPO_ROOT,
	'electron-app/src/renderer/views/index.js'
);
const ELECTRON_IPC_JS_PATH = path.join(REPO_ROOT, 'electron-app/src/services/ipc.js');
const ELECTRON_PRELOAD_JS_PATH = path.join(REPO_ROOT, 'electron-app/src/services/preload.js');
const ELECTRON_BOOTSTRAP_JS_PATH = path.join(REPO_ROOT, 'electron-app/src/services/bootstrap.js');
const TOOL_BATCH_MARKERS_TS_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/utils/owuiToolBatchMarkers.ts'
);

let tempDir;
let debugMonitorUtils;
let toolBatchMarkerUtils;

async function bundleModule(entryPath, outFile) {
	await build({
		entryPoints: [path.join(REPO_ROOT, entryPath)],
		bundle: true,
		format: 'cjs',
		platform: 'node',
		target: ['node20'],
		logLevel: 'silent',
		outfile: outFile
	});
	return require(outFile);
}

before(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'owui-debug-monitor-tests-'));
	debugMonitorUtils = await bundleModule(
		'src/patches/frontend/src/lib/utils/owuiDebugMonitor.ts',
		path.join(tempDir, 'owuiDebugMonitor.cjs')
	);
	toolBatchMarkerUtils = await bundleModule(
		'src/patches/frontend/src/lib/utils/owuiToolBatchMarkers.ts',
		path.join(tempDir, 'owuiToolBatchMarkers.cjs')
	);
});

after(async () => {
	if (tempDir) {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test('debug monitor utility keeps upstream request ids distinct from outer-turn debug ids', () => {
	const event = {
		event_id: 'event-1',
		event_type: 'llm_request_start',
		timestamp: '2026-03-27T10:00:00Z',
		chat_id: 'chat-1',
		message_id: 'assistant-1',
		debug_request_id: 'dbg-outer-turn',
		upstream_request_id: 'upstream-2',
		trigger_message_id: 'user-1',
		request_phase: 'tool_followup',
		followup_index: 2,
		outer_message_id: 'assistant-1',
		transcript_anchor_kind: 'assistant_tool_block',
		transcript_anchor_message_id: 'assistant-1',
		transcript_anchor_tool_block_index: 2,
		data: {
			model: 'Atlas Opus 4.6',
			message_count: 4,
			tool_ids: ['tool-1']
		}
	};

	const summary = debugMonitorUtils.applyDebugMonitorEventToSummary(undefined, event);
	assert.equal(debugMonitorUtils.resolveDebugMonitorRequestId(event), 'upstream-2');
	assert.equal(summary.request_id, 'upstream-2');
	assert.equal(summary.debug_request_id, 'dbg-outer-turn');
	assert.equal(summary.upstream_request_id, 'upstream-2');
	assert.equal(summary.trigger_message_id, 'user-1');
	assert.equal(summary.request_phase, 'tool_followup');
	assert.equal(summary.followup_index, 2);
	assert.equal(summary.transcript_anchor_kind, 'assistant_tool_block');
	assert.equal(summary.transcript_anchor_message_id, 'assistant-1');
	assert.equal(summary.transcript_anchor_tool_block_index, 2);
});

test('debug monitor utility falls back from upstream request id to debug request id to event id', () => {
	assert.equal(
		debugMonitorUtils.resolveDebugMonitorRequestId({
			event_id: 'event-1',
			debug_request_id: 'dbg-1'
		}),
		'dbg-1'
	);
	assert.equal(
		debugMonitorUtils.resolveDebugMonitorRequestId({
			event_id: 'event-2'
		}),
		'event-2'
	);
	assert.equal(
		debugMonitorUtils.resolveDebugMonitorRequestId({
			event_id: 'event-3',
			event_type: 'llm_request_transformed',
			data: {
				payload: {
					metadata: {
						upstream_request_id: 'upstream-3'
					}
				}
			}
		}),
		'upstream-3'
	);
});

test('debug monitor utility normalizes anchor fields and numeric indices from request summaries', () => {
	const summary = debugMonitorUtils.normalizeDebugMonitorRequestSummary({
		request_id: 'upstream-9',
		timestamp: '2026-03-27T12:00:00Z',
		model: 'Atlas Opus 4.6',
		status: 'complete',
		message_count: '3',
		tool_count: '1',
		followup_index: '4',
		transcript_anchor_kind: 'assistant_tool_block',
		transcript_anchor_message_id: 'assistant-9',
		transcript_anchor_tool_block_index: '5'
	});

	assert.equal(summary.followup_index, 4);
	assert.equal(summary.message_count, 3);
	assert.equal(summary.tool_count, 1);
	assert.equal(summary.transcript_anchor_kind, 'assistant_tool_block');
	assert.equal(summary.transcript_anchor_message_id, 'assistant-9');
	assert.equal(summary.transcript_anchor_tool_block_index, 5);

	const invalid = debugMonitorUtils.normalizeDebugMonitorRequestSummary({
		request_id: 'upstream-10',
		timestamp: '2026-03-27T12:00:00Z',
		model: 'Atlas Opus 4.6',
		status: 'pending',
		transcript_anchor_kind: 'nonsense'
	});
	assert.equal(invalid.transcript_anchor_kind, undefined);
});

test('debug monitor utility builds external request URLs for the monitor', () => {
	assert.equal(
		debugMonitorUtils.buildDebugMonitorRequestUrl({
			chatId: 'chat-1',
			requestId: 'upstream-1',
			sidebar: 'hidden'
		}),
		'http://localhost:8879/?chat=chat-1&request=upstream-1&sidebar=hidden'
	);
	assert.equal(
		debugMonitorUtils.buildDebugMonitorRequestUrl({
			chatId: 'chat-1',
			requestId: 'upstream-1',
			sidebar: 'hidden',
			access: { token: 'debug-token' }
		}),
		'http://localhost:8879/?chat=chat-1&request=upstream-1&sidebar=hidden&token=debug-token'
	);
});

test('debug monitor utility sends auth headers and websocket token when access is provided', async () => {
	const originalFetch = globalThis.fetch;
	try {
		let observedUrl = '';
		let observedOptions;
		globalThis.fetch = async (url, options) => {
			observedUrl = String(url);
			observedOptions = options;
			return {
				ok: true,
				json: async () => ({ requests: [] })
			};
		};

		await debugMonitorUtils.fetchChatDebugRequests('chat-1', { token: 'debug-token' });

		assert.equal(
			observedUrl,
			'http://localhost:8879/api/chats/chat-1/requests?limit=200'
		);
		assert.equal(observedOptions.headers['X-Debug-Monitor-Token'], 'debug-token');
		assert.equal(
			debugMonitorUtils.buildDebugMonitorWebSocketUrl({
				chatId: 'chat-1',
				access: { token: 'debug-token' }
			}),
			'ws://localhost:8879/ws/events?chat_id=chat-1&token=debug-token'
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('debug monitor utility merges transformed payload metadata and preserves zero followup anchors', () => {
	const transformedEvent = {
		event_id: 'transformed-1',
		event_type: 'llm_request_transformed',
		timestamp: '2026-03-28T12:00:00Z',
		chat_id: 'chat-1',
		data: {
			model: 'Atlas Opus 4.6',
			api_path: 'responses',
			payload: {
				messages: [{ role: 'user', content: 'hello' }],
				tools: [{ id: 'tool-1' }],
				metadata: {
					message_id: 'assistant-1',
					debug_request_id: 'dbg-1',
					upstream_request_id: 'upstream-1',
					request_phase: 'tool_followup',
					followup_index: 0,
					outer_message_id: 'assistant-1',
					trigger_message_id: 'user-1',
					transcript_anchor_kind: 'assistant_tool_block',
					transcript_anchor_message_id: 'assistant-1',
					transcript_anchor_tool_block_index: 0
				}
			}
		}
	};

	const summary = debugMonitorUtils.applyDebugMonitorEventToSummary(undefined, transformedEvent);
	assert.equal(summary.request_id, 'upstream-1');
	assert.equal(summary.message_id, 'assistant-1');
	assert.equal(summary.request_phase, 'tool_followup');
	assert.equal(summary.followup_index, 0);
	assert.equal(summary.outer_message_id, 'assistant-1');
	assert.equal(summary.trigger_message_id, 'user-1');
	assert.equal(summary.transcript_anchor_kind, 'assistant_tool_block');
	assert.equal(summary.transcript_anchor_message_id, 'assistant-1');
	assert.equal(summary.transcript_anchor_tool_block_index, 0);
	assert.equal(summary.message_count, 1);
	assert.equal(summary.tool_count, 1);
	assert.equal(summary.status, 'streaming');
});

test('debug monitor utility keeps best-known anchor metadata when later events omit it', () => {
	const initial = debugMonitorUtils.applyDebugMonitorEventToSummary(undefined, {
		event_id: 'transformed-2',
		event_type: 'llm_request_transformed',
		timestamp: '2026-03-28T12:01:00Z',
		chat_id: 'chat-1',
		upstream_request_id: 'upstream-2',
		data: {
			model: 'Atlas Opus 4.6',
			payload: {
				metadata: {
					message_id: 'assistant-2',
					request_phase: 'initial',
					outer_message_id: 'assistant-2',
					trigger_message_id: 'user-2',
					transcript_anchor_kind: 'user_message',
					transcript_anchor_message_id: 'user-2'
				}
			}
		}
	});

	const afterResponse = debugMonitorUtils.applyDebugMonitorEventToSummary(initial, {
		event_id: 'response-2',
		event_type: 'llm_response_complete',
		timestamp: '2026-03-28T12:01:02Z',
		chat_id: 'chat-1',
		upstream_request_id: 'upstream-2',
		data: {
			model: 'Atlas Opus 4.6',
			duration_ms: 250
		}
	});

	assert.equal(afterResponse.request_phase, 'initial');
	assert.equal(afterResponse.outer_message_id, 'assistant-2');
	assert.equal(afterResponse.trigger_message_id, 'user-2');
	assert.equal(afterResponse.transcript_anchor_kind, 'user_message');
	assert.equal(afterResponse.transcript_anchor_message_id, 'user-2');
	assert.equal(afterResponse.status, 'complete');
});

test('debug monitor utility resolves initial requests after the triggering user message', () => {
	const request = {
		request_id: 'upstream-1',
		trigger_message_id: 'user-1',
		transcript_anchor_kind: 'user_message',
		transcript_anchor_message_id: 'user-1'
	};
	const messageMap = {
		'user-1': { id: 'user-1', role: 'user', parentId: null },
		'assistant-1': { id: 'assistant-1', role: 'assistant', parentId: 'user-1' }
	};

	assert.deepEqual(
		debugMonitorUtils.resolveDebugMarkerPlacement(request, messageMap, [
			'user-1',
			'assistant-1'
		]),
		{ kind: 'after_message', messageId: 'user-1' }
	);
});

test('debug monitor utility resolves explicit user anchors through an assistant parent fallback', () => {
	const request = {
		request_id: 'upstream-parent-user',
		transcript_anchor_kind: 'user_message',
		transcript_anchor_message_id: 'assistant-1'
	};
	const messageMap = {
		'user-1': { id: 'user-1', role: 'user', parentId: null },
		'assistant-1': { id: 'assistant-1', role: 'assistant', parentId: 'user-1' }
	};

	assert.deepEqual(
		debugMonitorUtils.resolveDebugMarkerPlacement(request, messageMap, [
			'user-1',
			'assistant-1'
		]),
		{ kind: 'after_message', messageId: 'user-1' }
	);
});

test('debug monitor utility resolves explicit background anchors to the background lane', () => {
	const request = {
		request_id: 'upstream-bg',
		transcript_anchor_kind: 'background'
	};
	const messageMap = {
		'user-1': { id: 'user-1', role: 'user', parentId: null }
	};

	assert.deepEqual(
		debugMonitorUtils.resolveDebugMarkerPlacement(request, messageMap, ['user-1']),
		{ kind: 'background' }
	);
});

test('debug monitor utility falls back to background when an explicit assistant tool anchor is not visible', () => {
	const request = {
		request_id: 'upstream-hidden-tool',
		transcript_anchor_kind: 'assistant_tool_block',
		transcript_anchor_message_id: 'assistant-hidden',
		transcript_anchor_tool_block_index: 1
	};
	const messageMap = {
		'assistant-hidden': { id: 'assistant-hidden', role: 'assistant', parentId: 'user-1' }
	};

	assert.deepEqual(
		debugMonitorUtils.resolveDebugMarkerPlacement(request, messageMap, ['user-1']),
		{ kind: 'background' }
	);
});

test('debug monitor utility resolves tool follow-ups after the anchored assistant tool block', () => {
	const request = {
		request_id: 'upstream-2',
		message_id: 'assistant-1',
		outer_message_id: 'assistant-1',
		request_phase: 'tool_followup',
		followup_index: 1,
		transcript_anchor_kind: 'assistant_tool_block',
		transcript_anchor_message_id: 'assistant-1',
		transcript_anchor_tool_block_index: 1
	};
	const messageMap = {
		'user-1': { id: 'user-1', role: 'user', parentId: null },
		'assistant-1': {
			id: 'assistant-1',
			role: 'assistant',
			parentId: 'user-1',
			contentBlocks: [{ type: 'tool_calls' }, { type: 'text' }, { type: 'tool_calls' }]
		}
	};

	assert.deepEqual(
		debugMonitorUtils.resolveDebugMarkerPlacement(request, messageMap, [
			'user-1',
			'assistant-1'
		]),
		{ kind: 'after_tool_block', messageId: 'assistant-1', toolBlockIndex: 1 }
	);
});

test('debug monitor utility treats code interpreter follow-ups like inline tool follow-ups', () => {
	const request = {
		request_id: 'upstream-code',
		message_id: 'assistant-code',
		outer_message_id: 'assistant-code',
		request_phase: 'code_interpreter_followup',
		followup_index: 0
	};
	const messageMap = {
		'user-code': { id: 'user-code', role: 'user', parentId: null },
		'assistant-code': { id: 'assistant-code', role: 'assistant', parentId: 'user-code' }
	};

	assert.deepEqual(
		debugMonitorUtils.resolveDebugMarkerPlacement(request, messageMap, [
			'user-code',
			'assistant-code'
		]),
		{ kind: 'after_tool_block', messageId: 'assistant-code', toolBlockIndex: 0 }
	);
});

test('debug monitor utility falls back to the triggering user turn for non-followup requests without explicit anchors', () => {
	const request = {
		request_id: 'upstream-initial-fallback',
		request_phase: 'initial',
		outer_message_id: 'assistant-2',
		message_id: 'assistant-2'
	};
	const messageMap = {
		'user-2': { id: 'user-2', role: 'user', parentId: null },
		'assistant-2': { id: 'assistant-2', role: 'assistant', parentId: 'user-2' }
	};

	assert.deepEqual(
		debugMonitorUtils.resolveDebugMarkerPlacement(request, messageMap, [
			'user-2',
			'assistant-2'
		]),
		{ kind: 'after_message', messageId: 'user-2' }
	);
});

test('debug monitor utility falls back to legacy tool-followup placement when explicit anchor fields are absent', () => {
	const request = {
		request_id: 'upstream-legacy',
		message_id: 'assistant-1',
		outer_message_id: 'assistant-1',
		request_phase: 'tool_followup',
		followup_index: 2
	};
	const messageMap = {
		'user-1': { id: 'user-1', role: 'user', parentId: null },
		'assistant-1': {
			id: 'assistant-1',
			role: 'assistant',
			parentId: 'user-1'
		}
	};

	assert.deepEqual(
		debugMonitorUtils.resolveDebugMarkerPlacement(request, messageMap, [
			'user-1',
			'assistant-1'
		]),
		{ kind: 'after_tool_block', messageId: 'assistant-1', toolBlockIndex: 2 }
	);
});

test('debug monitor utility keeps tool follow-ups anchored inline even before contentBlocks catch up', () => {
	const request = {
		request_id: 'upstream-3',
		message_id: 'assistant-1',
		outer_message_id: 'assistant-1',
		request_phase: 'tool_followup',
		followup_index: 3,
		transcript_anchor_kind: 'assistant_tool_block',
		transcript_anchor_message_id: 'assistant-1',
		transcript_anchor_tool_block_index: 3
	};
	const messageMap = {
		'user-1': { id: 'user-1', role: 'user', parentId: null },
		'assistant-1': {
			id: 'assistant-1',
			role: 'assistant',
			parentId: 'user-1',
			contentBlocks: [{ type: 'tool_calls' }]
		}
	};

	assert.deepEqual(
		debugMonitorUtils.resolveDebugMarkerPlacement(request, messageMap, [
			'user-1',
			'assistant-1'
		]),
		{ kind: 'after_tool_block', messageId: 'assistant-1', toolBlockIndex: 3 }
	);
});

test('debug monitor utility falls back to background when an explicit user anchor is not visible', () => {
	const request = {
		request_id: 'upstream-missing',
		trigger_message_id: 'user-hidden',
		transcript_anchor_kind: 'user_message',
		transcript_anchor_message_id: 'user-hidden'
	};
	const messageMap = {
		'user-hidden': { id: 'user-hidden', role: 'user', parentId: null }
	};

	assert.deepEqual(
		debugMonitorUtils.resolveDebugMarkerPlacement(request, messageMap, ['assistant-1']),
		{ kind: 'background' }
	);
});

test('debug monitor utility preserves existing anchor metadata when later response events omit it', () => {
	const existing = {
		request_id: 'upstream-11',
		timestamp: '2026-03-27T10:00:00Z',
		model: 'Atlas Opus 4.6',
		message_count: 2,
		tool_count: 1,
		status: 'streaming',
		transcript_anchor_kind: 'assistant_tool_block',
		transcript_anchor_message_id: 'assistant-11',
		transcript_anchor_tool_block_index: 1
	};
	const event = {
		event_id: 'resp-11',
		event_type: 'llm_response_complete',
		timestamp: '2026-03-27T10:00:05Z',
		upstream_request_id: 'upstream-11',
		data: {
			model: 'Atlas Opus 4.6',
			duration_ms: 512,
			usage: { prompt_tokens: 20 }
		}
	};

	const summary = debugMonitorUtils.applyDebugMonitorEventToSummary(existing, event);
	assert.equal(summary.transcript_anchor_kind, 'assistant_tool_block');
	assert.equal(summary.transcript_anchor_message_id, 'assistant-11');
	assert.equal(summary.transcript_anchor_tool_block_index, 1);
	assert.equal(summary.status, 'complete');
	assert.deepEqual(summary.usage, { prompt_tokens: 20 });
});

test('debug monitor utility modal payload prefers transformed provider payloads', () => {
	const payload = debugMonitorUtils.buildDebugRequestModalPayload({
		request: {
			request_id: 'upstream-3',
			model: 'atlas-opus',
			base_model: 'Atlas Opus 4.6',
			request_phase: 'initial',
			raw_payload: { stale: true },
			transformed_payloads: [{ api_path: 'bedrock-converse', payload: { current: true } }]
		}
	});

	assert.equal(payload.requestId, 'upstream-3');
	assert.equal(payload.model, 'Atlas Opus 4.6');
	assert.deepEqual(JSON.parse(payload.json), { current: true });
});

test('debug monitor utility modal payload uses the latest transformed provider payload when multiple exist', () => {
	const payload = debugMonitorUtils.buildDebugRequestModalPayload({
		request: {
			request_id: 'upstream-3b',
			model: 'atlas-opus',
			base_model: 'Atlas Opus 4.6',
			request_phase: 'tool_followup',
			followup_index: 1,
			raw_payload: { stale: true },
			transformed_payloads: [
				{ api_path: 'chat-completions', payload: { older: true } },
				{ api_path: 'bedrock-converse', payload: { newest: true } }
			]
		}
	});

	assert.equal(payload.subtitle.includes('phase=tool_followup'), true);
	assert.equal(payload.subtitle.includes('followup=1'), true);
	assert.deepEqual(JSON.parse(payload.json), { newest: true });
});

test('debug monitor utility modal payload falls back to raw payload when no transformed payload exists', () => {
	const payload = debugMonitorUtils.buildDebugRequestModalPayload({
		request: {
			request_id: 'upstream-12',
			model: 'atlas-opus',
			base_model: 'Atlas Opus 4.6',
			request_phase: 'tool_followup',
			followup_index: 2,
			raw_payload: { raw: true }
		}
	});

	assert.equal(payload.requestId, 'upstream-12');
	assert.equal(payload.requestPhase, 'tool_followup');
	assert.equal(payload.subtitle.includes('followup=2'), true);
	assert.deepEqual(JSON.parse(payload.json), { raw: true });
});

test('debug monitor utility payload events transition summaries to streaming and retain existing counts when arrays are absent', () => {
	const existing = {
		request_id: 'upstream-stream',
		timestamp: '2026-03-27T10:20:00Z',
		model: 'Atlas Opus 4.6',
		message_count: 5,
		tool_count: 2,
		status: 'pending'
	};
	const summary = debugMonitorUtils.applyDebugMonitorEventToSummary(existing, {
		event_id: 'payload-stream',
		event_type: 'llm_request_payload',
		timestamp: '2026-03-27T10:20:01Z',
		upstream_request_id: 'upstream-stream',
		data: {
			model: 'Atlas Opus 4.6'
		}
	});

	assert.equal(summary.status, 'streaming');
	assert.equal(summary.message_count, 5);
	assert.equal(summary.tool_count, 2);
});

test('tool batch marker utility groups consecutive tool-call details into one batch and marks only the terminal card', () => {
	const tokens = [
		{ type: 'details', attributes: { type: 'reasoning' } },
		{ type: 'paragraph', raw: 'Let me inspect this.\n\n' },
		{ type: 'details', attributes: { type: 'tool_calls' }, summary: 'Tool 1' },
		{ type: 'space', raw: '\n\n' },
		{ type: 'details', attributes: { type: 'tool_calls' }, summary: 'Tool 2' },
		{ type: 'space', raw: '\n\n' },
		{ type: 'details', attributes: { type: 'reasoning' } },
		{ type: 'details', attributes: { type: 'tool_calls' }, summary: 'Tool 3' }
	];

	toolBatchMarkerUtils.annotateToolBatchTokens(tokens);

	assert.equal(tokens[2].__owuiToolBlockIndex, 0);
	assert.equal(tokens[2].__owuiToolBlockTerminal, false);
	assert.equal(tokens[4].__owuiToolBlockIndex, 0);
	assert.equal(tokens[4].__owuiToolBlockTerminal, true);
	assert.equal(tokens[7].__owuiToolBlockIndex, 1);
	assert.equal(tokens[7].__owuiToolBlockTerminal, true);
});

test('tool batch marker utility groups html-segmented tool cards into one batch and marks only the last segment', () => {
	const tokens = [
		{
			type: 'html',
			text:
				'<details type="tool_calls"><summary>Tool A</summary>A</details>\n' +
				'<details type="tool_calls"><summary>Tool B</summary>B</details>\n' +
				'<details type="reasoning"><summary>Thought</summary>C</details>\n' +
				'<details type="tool_calls"><summary>Tool C</summary>D</details>'
		}
	];

	toolBatchMarkerUtils.annotateToolBatchTokens(tokens);
	const segments = tokens[0].__owuiDetailsSegments;

	assert.equal(Array.isArray(segments), true);
	assert.equal(segments.length, 4);
	assert.equal(segments[0].__owuiToolBlockIndex, 0);
	assert.equal(segments[0].__owuiToolBlockTerminal, false);
	assert.equal(segments[1].__owuiToolBlockIndex, 0);
	assert.equal(segments[1].__owuiToolBlockTerminal, true);
	assert.equal(segments[2].__owuiToolBlockIndex, undefined);
	assert.equal(segments[3].__owuiToolBlockIndex, 1);
	assert.equal(segments[3].__owuiToolBlockTerminal, true);
});

test('tool batch marker utility ignores whitespace-only html separators between consecutive tool-call cards', () => {
	const tokens = [
		{ type: 'details', attributes: { type: 'tool_calls' }, summary: 'Tool 1' },
		{ type: 'html', text: '\n\n' },
		{ type: 'details', attributes: { type: 'tool_calls' }, summary: 'Tool 2' }
	];

	toolBatchMarkerUtils.annotateToolBatchTokens(tokens);

	assert.equal(tokens[0].__owuiToolBlockIndex, 0);
	assert.equal(tokens[0].__owuiToolBlockTerminal, false);
	assert.equal(tokens[2].__owuiToolBlockIndex, 0);
	assert.equal(tokens[2].__owuiToolBlockTerminal, true);
});

test('chat UI source wires live debug markers and host modal inspection', async () => {
	const [chatSource, messagesSource] = await Promise.all([
		fs.readFile(CHAT_SVELTE_PATH, 'utf8'),
		fs.readFile(MESSAGES_SVELTE_PATH, 'utf8')
	]);

	assert.equal(chatSource.includes('fetchChatDebugRequests(chatId, access)'), true);
	assert.equal(chatSource.includes('new WebSocket(buildDebugMonitorWebSocketUrl({ chatId, access }))'), true);
	assert.equal(chatSource.includes('getDebugMonitorAccess?: () => Promise<DebugMonitorAccess>;'), true);
	assert.equal(chatSource.includes("window.addEventListener('owui-debug-mode-changed'"), true);
	assert.equal(chatSource.includes('buildDebugMonitorRequestUrl({'), true);
	assert.equal(chatSource.includes('hostApi?.openDebugMonitorLink'), true);
	assert.equal(chatSource.includes("window.open(targetUrl, '_blank', 'noopener,noreferrer');"), true);
	assert.equal(chatSource.includes('resolveDebugMarkerPlacement('), true);
	assert.equal(chatSource.includes('const resolveDebugModeEnabled = (value: unknown): boolean => {'), true);
	assert.equal(chatSource.includes('const applyDebugModeEnabled = (enabled: boolean) => {'), true);
	assert.equal(chatSource.includes('debugMonitorSyncVersion += 1;'), true);
	assert.equal(
		chatSource.includes("void syncDebugMonitorRequests(debugModeEnabled ? activeDebugMonitorChatId : '');"),
		true
	);
	assert.equal(
		chatSource.includes(
			'applyDebugModeEnabled(resolveDebugModeEnabled(await getWebviewHostApi()?.getDebugMode?.()));'
		),
		true
	);
	assert.equal(chatSource.includes('applyDebugModeEnabled(Boolean(detail?.enabled));'), true);
	assert.equal(chatSource.includes('debugMarkersAfterMessageId = nextMarkersAfterMessageId;'), true);
	assert.equal(
		chatSource.includes('debugMarkersAfterToolBlockByMessageId = nextMarkersAfterToolBlockByMessageId;'),
		true
	);
	assert.equal(
		chatSource.includes(
			'debugMarkersAfterMessageId={debugModeEnabled ? debugMarkersAfterMessageId : {}}'
		),
		true
	);
	assert.equal(
		chatSource.includes('debugBackgroundMarkers={debugModeEnabled ? debugBackgroundMarkers : []}'),
		true
	);
	assert.equal(messagesSource.includes('debugMarkersAfterMessageId?.[message.id]?.length'), true);
	assert.equal(messagesSource.includes('debugMarkersAfterToolBlockByMessageId'), true);
	assert.equal(messagesSource.includes('debugBackgroundMarkers?.length'), true);
});

test('electron host source wires global debug mode state and modal delivery', async () => {
	const [indexSource, ipcSource, preloadSource, chatWebviewPreloadSource, bootstrapSource] = await Promise.all([
		fs.readFile(ELECTRON_RENDERER_INDEX_JS_PATH, 'utf8'),
		fs.readFile(ELECTRON_IPC_JS_PATH, 'utf8'),
		fs.readFile(ELECTRON_PRELOAD_JS_PATH, 'utf8'),
		fs.readFile(
			path.join(REPO_ROOT, 'electron-app/src/services/chat-webview-preload.js'),
			'utf8'
		),
		fs.readFile(ELECTRON_BOOTSTRAP_JS_PATH, 'utf8')
	]);

	assert.equal(indexSource.includes('setNativeOverlayInteractionSuppressed(\'debug-request-modal\', true);'), true);
	assert.equal(indexSource.includes('const initialDebugMode = await window.electronAPI?.owui?.getDebugMode?.();'), true);
	assert.equal(indexSource.includes('window.electronAPI.onOwuiDebugRequestModal((payload) => {'), true);
	assert.equal(indexSource.includes('window.electronAPI.onOwuiDebugModeChanged((payload) => {'), true);
	assert.equal(ipcSource.includes('ipcMain.handle("owui-set-debug-mode"'), true);
	assert.equal(ipcSource.includes('ipcMain.handle("owui-get-debug-mode"'), true);
	assert.equal(ipcSource.includes('ipcMain.handle("owui-get-debug-monitor-access"'), true);
	assert.equal(ipcSource.includes('ipcMain.handle("owui-open-debug-request-modal"'), true);
	assert.equal(ipcSource.includes('ipcMain.handle("owui-open-debug-monitor-link"'), true);
	assert.equal(ipcSource.includes('bootstrap.buildDebugMonitorUrl(url)'), true);
	assert.equal(ipcSource.includes('owuiViews.broadcastToViews("owui-debug-mode-changed", payload);'), true);
	assert.equal(ipcSource.includes('BrowserWindow.getAllWindows()'), true);
	assert.equal(preloadSource.includes('onOwuiDebugRequestModal: (callback) => {'), true);
	assert.equal(preloadSource.includes('onOwuiDebugModeChanged: (callback) => {'), true);
	assert.equal(preloadSource.includes('setDebugMode: async (enabled) => {'), true);
	assert.equal(preloadSource.includes('getDebugMode: async () => {'), true);
	assert.equal(chatWebviewPreloadSource.includes("const result = await ipcRenderer.invoke('owui-get-debug-mode');"), true);
	assert.equal(
		chatWebviewPreloadSource.includes(
			"throw new Error(result?.error || 'Failed to get OWUI debug mode');"
		),
		true
	);
	assert.equal(chatWebviewPreloadSource.includes('return Boolean(result.enabled);'), true);
	assert.equal(chatWebviewPreloadSource.includes("const result = await ipcRenderer.invoke('owui-get-debug-monitor-access');"), true);
	assert.equal(chatWebviewPreloadSource.includes('getDebugMonitorAccess,'), true);
	assert.equal(bootstrapSource.includes('runtimeSecrets.BIFROST_BRIDGE_LOCAL_API_KEY'), true);
	assert.equal(bootstrapSource.includes("url.searchParams.set('token', runtimeSecrets.LOCAL_STACK_API_KEY)"), false);
});

// Retired source-pin test ("cost reporting source wires turn summaries and
// keeps combined context details scoped to the current turn"): the context
// gauge logic was extracted into $lib/utils/context-turn-summary.mjs and is
// covered behaviorally by tests/test_context_turn_summary_frontend.cjs plus
// electron-app/tests/cost-reporting-chat-summary.test.js.

test('middleware source normalizes non-stream debug response usage before publishing completion events', async () => {
	const middlewareSource = await fs.readFile(
		path.join(REPO_ROOT, 'src/patches/backend/open_webui/utils/middleware.py'),
		'utf8'
	);

	assert.equal(middlewareSource.includes('debug_response_usage = response_data.get("usage", {}) or {}'), true);
	assert.equal(middlewareSource.includes('debug_response_usage = _normalize_llm_debug_usage('), true);
	assert.equal(middlewareSource.includes('usage=debug_response_usage'), true);
});

test('tool batch marker source is present for markdown renderers', async () => {
	const [toolBatchSource, markdownSource, markdownTokensSource] = await Promise.all([
		fs.readFile(TOOL_BATCH_MARKERS_TS_PATH, 'utf8'),
		fs.readFile(
			path.join(
				REPO_ROOT,
				'src/patches/frontend/src/lib/components/chat/Messages/Markdown.svelte'
			),
			'utf8'
		),
		fs.readFile(
			path.join(
				REPO_ROOT,
				'src/patches/frontend/src/lib/components/chat/Messages/Markdown/MarkdownTokens.svelte'
			),
			'utf8'
		)
	]);

	assert.equal(toolBatchSource.includes('export const annotateToolBatchTokens = (tokenList: Token[]): Token[] => {'), true);
	assert.equal(
		toolBatchSource.includes('pendingToolCarrier.target.__owuiToolBlockTerminal = true;'),
		true
	);
	assert.equal(markdownSource.includes("import { annotateToolBatchTokens } from '$lib/utils/owuiToolBatchMarkers';"), true);
	assert.equal(markdownSource.includes('const allTokens = annotateToolBatchTokens('), true);
	assert.equal(markdownTokensSource.includes("import { splitDetailsHtml, type DetailSegment } from '$lib/utils/owuiToolBatchMarkers';"), true);
	assert.equal(markdownTokensSource.includes('toolBlockIndex !== undefined && shouldRenderToolBlockMarker(token)'), true);
	assert.equal(markdownTokensSource.includes('segmentToolBlockIndex !== undefined && shouldRenderToolBlockMarker(segment)'), true);
});
