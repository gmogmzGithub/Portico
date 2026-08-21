import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	buildLongChatPerformanceFixture,
	buildPersistedSubagentReopenFixture,
	compactLongChatPerformanceFixture,
	LONG_CHAT_TOOL_CALL_COUNT
} from './fixtures/long-chat-performance-fixture.mjs';
import { segmentWorkActivity } from '../src/patches/frontend/src/lib/utils/work-activity-summary.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// CI runs Node 20, which cannot import .ts modules (no type stripping), so
// transpile subagentDetails.ts with esbuild and require the CJS bundle — the
// same pattern chat-list-pagination.unit.test.js uses.
const require = createRequire(import.meta.url);
const { build } = require('../electron-app/node_modules/esbuild');
const subagentDetailsTempDir = await fs.mkdtemp(
	path.join(os.tmpdir(), 'chat-load-performance-')
);
const subagentDetailsOutfile = path.join(subagentDetailsTempDir, 'subagent-details.cjs');
await build({
	entryPoints: [
		path.join(repoRoot, 'src/patches/frontend/src/lib/utils/subagentDetails.ts')
	],
	bundle: true,
	format: 'cjs',
	platform: 'node',
	target: ['node20'],
	logLevel: 'silent',
	outfile: subagentDetailsOutfile
});
const { normalizeSubagentToolCallDetails, resolveSubagentToolCallDetail } = require(
	subagentDetailsOutfile
);
after(async () => {
	await fs.rm(subagentDetailsTempDir, { recursive: true, force: true });
});
const chatPath = path.join(
	repoRoot,
	'src/patches/frontend/src/lib/components/chat/Chat.svelte'
);
const responseMessagePath = path.join(
	repoRoot,
	'src/patches/frontend/src/lib/components/chat/Messages/ResponseMessage.svelte'
);
const chatItemPath = path.join(
	repoRoot,
	'src/patches/frontend/src/lib/components/layout/Sidebar/ChatItem.svelte'
);
const apiPath = path.join(
	repoRoot,
	'src/patches/frontend/src/lib/apis/chatHydration.ts'
);
const collapsiblePath = path.join(
	repoRoot,
	'src/patches/frontend/src/lib/components/common/Collapsible.svelte'
);

const block = (source, startMarker, endMarker) => {
	const start = source.indexOf(startMarker);
	assert.notEqual(start, -1, `missing ${startMarker}`);
	const end = source.indexOf(endMarker, start + startMarker.length);
	assert.notEqual(end, -1, `missing ${endMarker}`);
	return source.slice(start, end);
};

test('pathological fixture reproduces the compactable 3.1 MiB long chat', () => {
	const fixture = buildLongChatPerformanceFixture();
	const compact = compactLongChatPerformanceFixture(fixture);
	const legacyBytes = Buffer.byteLength(JSON.stringify(fixture));
	const compactBytes = Buffer.byteLength(JSON.stringify(compact));
	const assistant = fixture.chat.history.messages['assistant-message'];
	const segments = segmentWorkActivity(assistant.content, true);

	assert.equal(Object.keys(fixture.chat.history.messages).length, 2);
	assert.equal(assistant.contentBlocks.length, LONG_CHAT_TOOL_CALL_COUNT);
	assert.ok(legacyBytes >= 3.0 * 1024 * 1024, `fixture too small: ${legacyBytes}`);
	assert.ok(legacyBytes <= 3.25 * 1024 * 1024, `fixture too large: ${legacyBytes}`);
	assert.ok(compactBytes <= legacyBytes * 0.6, 'hydration must remove at least 40%');
	assert.ok(
		segments.some(
			(segment) =>
				segment.type === 'activity' && segment.sourceEnd - segment.sourceStart > 450_000
		),
		'fixture must contain substantial collapsed work activity'
	);
	const activitySegment = segments.find((segment) => segment.type === 'activity');
	assert.equal(
		typeof Object.getOwnPropertyDescriptor(activitySegment, 'content')?.get,
		'function',
		'collapsed activity content must remain lazily materialized'
	);
	assert.ok(
		segments.some(
			(segment) =>
				segment.type === 'content' && segment.content.includes('Final project status')
		),
		'fixture must retain an immediately visible final narrative'
	);
});

test('navigation blocks only on abortable compact hydration and emits paint readiness', async () => {
	const source = await fs.readFile(chatPath, 'utf8');
	const loadChat = block(source, 'const loadChat = async (', '\n\tconst getErrorMessage =');
	const navigate = block(source, 'const navigateHandler = async () => {', '\n\tconst onSelect =');
	const reportReady = block(
		source,
		'const reportChatLoadReady = async',
		'\n\n\tconst eventTarget'
	);

	assert.match(loadChat, /getChatHydrationById\(localStorage\.token, targetChatId, signal\)/);
	assert.match(loadChat, /normalizeHydratedMessagesForFirstPaint\(/);
	assert.doesNotMatch(loadChat, /normalizeHydratedAssistantMessages\(/);
	for (const deferredRequest of [
		'getTagsById',
		'getTaskIdsByChatId',
		'getChatPendingWork',
		'getChatState',
		'getChatCapabilities'
	]) {
		assert.doesNotMatch(loadChat, new RegExp(deferredRequest));
	}
	assert.match(navigate, /chatLoadAbortController\?\.abort\(\)/);
	assert.match(navigate, /isCurrentChatLoad\(generation, targetChatId\)/);
	assert.ok(navigate.indexOf('loading = false;') < navigate.indexOf('reportChatLoadReady('));
	assert.ok(navigate.indexOf('reportChatLoadReady(') < navigate.indexOf('loadDeferredChatState('));
	assert.equal((reportReady.match(/await waitForAnimationFrame\(\);/g) ?? []).length, 2);
	assert.match(reportReady, /new CustomEvent\('portico-chat-load-ready'/);
	assert.match(reportReady, /chatRichContentReady = true/);
	assert.match(navigate, /chatRichContentReady = false/);
	assert.match(source, /data-chat-load-state=/);
	assert.match(source, /data-chat-id=/);
});

test('sidebar hover does not prefetch the full chat before navigation', async () => {
	const source = await fs.readFile(chatItemPath, 'utf8');
	const hoverSetup = block(source, 'let chat = null;', '\n\tlet showShareChatModal');
	const dragStart = block(source, 'const onDragStart = (event) => {', '\n\n\tconst onDrag =');

	assert.doesNotMatch(hoverSetup, /getChatById|loadChat|draggable/);
	assert.match(source, /draggable=\{!confirmEdit\}/);
	assert.doesNotMatch(dragStart, /item:\s*chat/);
});

test('deferred state is concurrent, generation guarded, and reconciles active tasks', async () => {
	// Behavioral (extract-and-exec) — replaces the legacy source-pin regexes.
	// The real loadDeferredChatState body runs against fakes; assertions cover
	// the guard semantics (instance-local, NOT the global chatId store — tiles
	// never set the global store, yet must hydrate), the Promise.all batching,
	// and the task-id reconcile.
	const source = await fs.readFile(chatPath, 'utf8');
	const deferred = block(
		source,
		'const loadDeferredChatState = async',
		'\n\n\tconst loadChat = async'
	);
	const { transformSync } = require('../electron-app/node_modules/esbuild');
	const { code } = transformSync(deferred, { loader: 'ts' });

	const makeHarness = ({ activeChatId, globalChatId, currentLoad = true }) => {
		const calls = [];
		const fetchStarts = [];
		let releaseFetches;
		const gate = new Promise((resolve) => {
			releaseFetches = resolve;
		});
		const fetcher = (name, result) => async () => {
			fetchStarts.push(name);
			await gate;
			return result;
		};
		const deps = {
			localStorage: { token: 'tok' },
			getTagsById: fetcher('tags', ['tag-a']),
			getTaskIdsByChatId: fetcher('tasks', { task_ids: ['task-1'] }),
			getChatPendingWork: fetcher('pending', { queued_prompts: [] }),
			getChatState: fetcher('state', { fast_mode: false }),
			getChatCapabilities: fetcher('capabilities', { tools: [], skills: [] }),
			isCurrentChatLoad: () => currentLoad,
			activeChatId,
			get: (store) => store.value,
			chatId: { value: globalChatId },
			tags: [],
			taskIds: null,
			setTaskIds: (ids) => {
				calls.push(['setTaskIds', ids]);
				deps.taskIds = ids;
			},
			delegatedSubagentView: false,
			normalizeDetachedSubagentActiveHistory: (history) => ({ changed: false, history }),
			history: { messages: {}, currentId: null },
			normalizeHydratedAssistantMessages: () => ({
				changed: false,
				staleNormalizedCount: 0
			}),
			console,
			applyPendingWorkState: (state) => calls.push(['applyPendingWorkState', state]),
			applyPersistedChatState: (state) => calls.push(['applyPersistedChatState', state]),
			reasoningEffortReady: false,
			applyActiveCapabilities: (capabilities, chatId) =>
				calls.push(['applyActiveCapabilities', chatId]),
			resyncRunningAssistantMessages: async (chatId) => calls.push(['resync', chatId]),
			tabActivityChatId: ''
		};
		const factory = new Function(
			'deps',
			`with (deps) { ${code}; return loadDeferredChatState; }`
		);
		return { run: factory(deps), deps, calls, fetchStarts, releaseFetches: () => releaseFetches() };
	};

	// Tile case: instance-local activeChatId matches while the GLOBAL chatId
	// store points elsewhere — hydration must still apply (the F0 regression:
	// a global-store guard skipped deferred hydration for every tile).
	const tile = makeHarness({ activeChatId: 'chat-tile', globalChatId: 'other-chat' });
	const tileRun = tile.run('chat-tile', 1);
	// All five requests start before ANY resolves — concurrent batch, not serial.
	assert.deepEqual(
		[...tile.fetchStarts].sort(),
		['capabilities', 'pending', 'state', 'tags', 'tasks']
	);
	tile.releaseFetches();
	await tileRun;
	assert.deepEqual(tile.calls.find((c) => c[0] === 'setTaskIds'), ['setTaskIds', ['task-1']]);
	assert.ok(tile.calls.some((c) => c[0] === 'applyPendingWorkState'));
	assert.ok(tile.calls.some((c) => c[0] === 'applyPersistedChatState'));
	assert.ok(tile.calls.some((c) => c[0] === 'applyActiveCapabilities' && c[1] === 'chat-tile'));
	assert.equal(tile.deps.reasoningEffortReady, true);
	assert.deepEqual(tile.deps.tags, ['tag-a']);
	// The global store differs, so tab-activity attribution stays untouched.
	assert.equal(tile.deps.tabActivityChatId, '');

	// Primary case: global store matches → tab activity attributes to the chat.
	const primary = makeHarness({ activeChatId: 'chat-main', globalChatId: 'chat-main' });
	const primaryRun = primary.run('chat-main', 1);
	primary.releaseFetches();
	await primaryRun;
	assert.equal(primary.deps.tabActivityChatId, 'chat-main');

	// Stale instance: a different chat is active locally → no state writes.
	const stale = makeHarness({ activeChatId: 'chat-current', globalChatId: 'chat-current' });
	const staleRun = stale.run('chat-superseded', 1);
	stale.releaseFetches();
	await staleRun;
	assert.deepEqual(stale.calls, []);
	assert.equal(stale.deps.reasoningEffortReady, false);

	// Stale generation: load superseded mid-flight → no state writes.
	const superseded = makeHarness({
		activeChatId: 'chat-x',
		globalChatId: 'chat-x',
		currentLoad: false
	});
	const supersededRun = superseded.run('chat-x', 1);
	superseded.releaseFetches();
	await supersededRun;
	assert.deepEqual(superseded.calls, []);
});

test('collapsed work activity never constructs markdown and expansion yields a frame first', async () => {
	const source = await fs.readFile(responseMessagePath, 'utf8');
	const toggle = block(
		source,
		'const setWorkActivityGroupExpanded =',
		'\n\n\texport let siblings'
	);
	const renderArea = block(
		source,
		'{#each workActivitySegments as segment',
		'\n\t\t\t\t\t\t\t<!-- PORTICO_PATCH: Show activity indicator'
	);

	assert.equal((toggle.match(/window\.requestAnimationFrame/g) ?? []).length, 2);
	assert.match(toggle, /mountedWorkActivityGroups = .*\[groupId\]: false/s);
	assert.match(renderArea, /segment\.type === 'content' && !richContentReady/);
	assert.match(renderArea, /data-chat-narrative-first-paint="true"/);
	assert.match(
		renderArea,
		/\{:else if segment\.type !== 'activity' \|\| mountedWorkActivityGroups\[segment\.id\]\}[\s\S]*<ContentRenderer/
	);
	assert.match(renderArea, /data-work-activity-render-state="pending"/);
	assert.match(renderArea, /Loading work details…/);
});

test('cost discovery is one deferred descendants request with coalescing and no fan-out', async () => {
	const source = await fs.readFile(chatPath, 'utf8');
	const apiSource = await fs.readFile(apiPath, 'utf8');
	const descendantCache = block(
		source,
		'const getCachedSubagentDescendants = async',
		'\n\n\tconst fetchWorkflowCostMetrics'
	);
	const costRefresh = block(
		source,
		'const refreshAggregateWorkflowCostMetrics = async',
		'\n\n\tconst refreshContextTurnSummary'
	);

	assert.match(apiSource, /\/api\/v1\/chats\/\$\{encodeURIComponent\(chatId\)\}\/subagent-descendants/);
	assert.match(descendantCache, /subagentDescendantRequests\.get/);
	assert.match(descendantCache, /getSubagentDescendants\(/);
	assert.match(source, /const SUBAGENT_COST_CACHE_TTL_MS = 30_000;/);
	assert.match(costRefresh, /getCachedSubagentDescendants\(targetChatId\)/);
	assert.match(descendantCache, /normalizeSubagentToolCallDetails\(payload\?\.tool_calls\)/);
	assert.match(costRefresh, /subagentToolCallDetails\.set\(toolCalls\)/);
	assert.doesNotMatch(descendantCache, /subagents\/tool-call|getChatById/);
	assert.doesNotMatch(costRefresh, /subagents\/tool-call|getChatById/);
	assert.doesNotMatch(source, /getCachedChatPayload|collectRecursiveDescendantChatIds/);
	assert.match(source, /if \(!chatFirstPaintReady\) \{\s*clearAggregateCostRefreshTimer\(\);/);

	// Behavioral: the message-driven reactive block invalidates the descendant
	// cache for the INSTANCE-ACTIVE chat (tiles never set the global store) and
	// always schedules the coalesced refresh — extracted and executed rather
	// than source-pinned.
	const invalidationBlock = block(source, '$: {\n\t\thistory?.messages;', '\n\t}\n\n\t$: {');
	const invalidationBody = invalidationBlock.replace(/^\$:\s*\{/, '');
	const runInvalidation = ({ chatFirstPaintReady, activeChatId }) => {
		const calls = [];
		new Function(
			'deps',
			`with (deps) { ${invalidationBody} }`
		)({
			history: { messages: {} },
			activeChatId,
			chatFirstPaintReady,
			invalidateSubagentDescendantCache: (chatId) => calls.push(['invalidate', chatId]),
			scheduleAggregateWorkflowCostRefresh: () => calls.push(['schedule'])
		});
		return calls;
	};
	assert.deepEqual(runInvalidation({ chatFirstPaintReady: true, activeChatId: 'chat-tile' }), [
		['invalidate', 'chat-tile'],
		['schedule']
	]);
	assert.deepEqual(runInvalidation({ chatFirstPaintReady: false, activeChatId: 'chat-tile' }), [
		['schedule']
	]);
	assert.deepEqual(runInvalidation({ chatFirstPaintReady: true, activeChatId: '' }), [
		['schedule']
	]);
});

test('terminal subagent details rehydrate in the existing tool block after reopen', async () => {
	const fixture = buildPersistedSubagentReopenFixture();
	const source = await fs.readFile(chatPath, 'utf8');
	const collapsibleSource = await fs.readFile(collapsiblePath, 'utf8');
	const assistant = fixture.parent.chat.history.messages['assistant-message'];
	const persistedResult = assistant.contentBlocks[0].results[0].content;

	assert.equal(JSON.parse(persistedResult).chat_id, undefined);
	assert.equal(fixture.child.chat.meta.subagent.parent_tool_call_id, fixture.toolCallId);
	const normalized = normalizeSubagentToolCallDetails(fixture.descendants.tool_calls);
	const resolved = resolveSubagentToolCallDetail({
		embeddedStats: null,
		deferredDetail: normalized[fixture.toolCallId],
		isTerminal: true
	});
	assert.deepEqual(resolved, {
		chatId: fixture.childChatId,
		toolCallCount: 12,
		displayTokens: 179483
	});

	assert.match(source, /setContext\(SUBAGENT_DETAILS_CONTEXT, subagentToolCallDetails\)/);
	assert.match(collapsibleSource, /getContext<Readable<SubagentToolCallDetails>>/);
	assert.match(collapsibleSource, /resolveSubagentToolCallDetail\(\{/);
	assert.match(collapsibleSource, /if \(isDone && resolvedDetail\)/);
	assert.match(collapsibleSource, /View details ↗/);
	assert.match(collapsibleSource, /\{subagentToolCallsLabel\}/);
	assert.match(collapsibleSource, /\{subagentTokensLabel\}/);
	assert.match(collapsibleSource, /stats \|\| \(isDone && deferredDetail\)/);
});

test('live subagent result stats remain authoritative over deferred reload metadata', () => {
	const deferredDetail = {
		chatId: 'deferred-child',
		toolCallCount: 3,
		displayTokens: 300
	};
	const embeddedStats = {
		chatId: 'live-child',
		toolCallCount: 9,
		displayTokens: 900
	};

	assert.deepEqual(
		resolveSubagentToolCallDetail({ embeddedStats, deferredDetail, isTerminal: true }),
		{ chatId: 'live-child', toolCallCount: 9, displayTokens: 900 }
	);
	assert.deepEqual(
		resolveSubagentToolCallDetail({ embeddedStats, deferredDetail, isTerminal: false }),
		{ chatId: 'live-child', toolCallCount: 9, displayTokens: 900 }
	);
	assert.equal(
		resolveSubagentToolCallDetail({
			embeddedStats: null,
			deferredDetail,
			isTerminal: false
		}),
		null
	);
	assert.deepEqual(
		resolveSubagentToolCallDetail({
			embeddedStats: { chatId: null, toolCallCount: 0, displayTokens: null },
			deferredDetail,
			isTerminal: true
		}),
		{ chatId: 'deferred-child', toolCallCount: 3, displayTokens: 300 }
	);
});
