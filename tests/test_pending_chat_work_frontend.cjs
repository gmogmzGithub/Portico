const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
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
const PLACEHOLDER_SVELTE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/Placeholder.svelte'
);
const COLLAPSIBLE_SVELTE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/common/Collapsible.svelte'
);
const MESSAGES_SVELTE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/Messages.svelte'
);
const MESSAGE_SVELTE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/Messages/Message.svelte'
);
const MULTI_RESPONSE_MESSAGES_SVELTE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/Messages/MultiResponseMessages.svelte'
);
const RESPONSE_MESSAGE_SVELTE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/Messages/ResponseMessage.svelte'
);
const CONTENT_RENDERER_SVELTE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/Messages/ContentRenderer.svelte'
);
const MARKDOWN_SVELTE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/Messages/Markdown.svelte'
);
const MARKDOWN_TOKENS_SVELTE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/Messages/Markdown/MarkdownTokens.svelte'
);
const DEBUG_REQUEST_MARKER_SVELTE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/DebugRequestMarker.svelte'
);
const OWUI_DEBUG_MONITOR_TS_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/utils/owuiDebugMonitor.ts'
);
const OWUI_TOOL_BATCH_MARKERS_TS_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/utils/owuiToolBatchMarkers.ts'
);
const ELECTRON_RENDERER_INDEX_JS_PATH = path.join(
	REPO_ROOT,
	'electron-app/src/renderer/views/index.js'
);
const ELECTRON_RENDERER_INDEX_HTML_PATH = path.join(
	REPO_ROOT,
	'electron-app/src/renderer/views/index.html'
);
const ELECTRON_IPC_JS_PATH = path.join(REPO_ROOT, 'electron-app/src/services/ipc.js');
const ELECTRON_PRELOAD_JS_PATH = path.join(REPO_ROOT, 'electron-app/src/services/preload.js');
const ELECTRON_BOOTSTRAP_JS_PATH = path.join(REPO_ROOT, 'electron-app/src/services/bootstrap.js');
const CHAT_WEBVIEW_PRELOAD_JS_PATH = path.join(
	REPO_ROOT,
	'electron-app/src/services/chat-webview-preload.js'
);
const PENDING_CHAT_WORK_PY_PATH = path.join(
	REPO_ROOT,
	'src/patches/backend/open_webui/utils/pending_chat_work.py'
);
const APP_CSS_PATH = path.join(REPO_ROOT, 'src/patches/frontend/src/app.css');

let tempDir;
let pendingChatWork;
let owuiDebugMonitor;

const bundleModule = async (entryPath, outFile) => {
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
};

before(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pending-chat-work-frontend-tests-'));
	pendingChatWork = await bundleModule(
		'src/patches/frontend/src/lib/utils/pendingChatWork.ts',
		path.join(tempDir, 'pendingChatWork.cjs')
	);
	owuiDebugMonitor = await bundleModule(
		'src/patches/frontend/src/lib/utils/owuiDebugMonitor.ts',
		path.join(tempDir, 'owuiDebugMonitor.cjs')
	);
});

after(async () => {
	if (tempDir) {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test('streaming hotkeys split steer, queue, and stop actions correctly', () => {
	assert.equal(
		pendingChatWork.resolveComposerHotkeyAction({
			key: 'Enter',
			altKey: false,
			shiftKey: false,
			isStreaming: true,
			prompt: 'steer this',
			hasFiles: false,
			hasPendingSteer: false,
			queuedPromptCount: 0,
			pendingWorkEditMode: 'none'
		}),
		'submit-steer'
	);
	assert.equal(
		pendingChatWork.resolveComposerHotkeyAction({
			key: 'Enter',
			altKey: true,
			shiftKey: true,
			isStreaming: true,
			prompt: 'queue this',
			hasFiles: false,
			hasPendingSteer: false,
			queuedPromptCount: 0,
			pendingWorkEditMode: 'none'
		}),
		'submit-queue'
	);
	assert.equal(
		pendingChatWork.resolveComposerHotkeyAction({
			key: 'Enter',
			altKey: false,
			shiftKey: true,
			isStreaming: true,
			prompt: 'newline please',
			hasFiles: false,
			hasPendingSteer: false,
			queuedPromptCount: 0,
			pendingWorkEditMode: 'none'
		}),
		'none'
	);
	assert.equal(
		pendingChatWork.resolveComposerHotkeyAction({
			key: 'Escape',
			altKey: false,
			shiftKey: false,
			isStreaming: true,
			prompt: 'anything',
			hasFiles: false,
			hasPendingSteer: false,
			queuedPromptCount: 0,
			pendingWorkEditMode: 'none'
		}),
		'none'
	);
	assert.equal(
		pendingChatWork.resolveComposerHotkeyAction({
			key: 'Enter',
			altKey: false,
			shiftKey: false,
			isStreaming: true,
			prompt: '',
			hasFiles: false,
			hasPendingSteer: false,
			queuedPromptCount: 2,
			pendingWorkEditMode: 'queue'
		}),
		'submit-queue'
	);
	assert.equal(
		pendingChatWork.resolveComposerHotkeyAction({
			key: 'Escape',
			altKey: false,
			shiftKey: false,
			isStreaming: true,
			prompt: 'cancel edit',
			hasFiles: false,
			hasPendingSteer: true,
			queuedPromptCount: 2,
			pendingWorkEditMode: 'steer'
		}),
		'cancel-pending-work-edit'
	);
});

test('visible assistant activity is scoped to the current turn', () => {
	assert.equal(
		pendingChatWork.hasVisibleActiveAssistantMessages({
			currentId: 'assistant-done',
			messages: {
				'assistant-done': {
					id: 'assistant-done',
					parentId: 'user-1',
					role: 'assistant',
					done: true
				},
				'user-1': {
					id: 'user-1',
					role: 'user',
					childrenIds: ['assistant-done']
				}
			}
		}),
		false
	);

	assert.equal(
		pendingChatWork.hasVisibleActiveAssistantMessages({
			currentId: 'user-2',
			messages: {
				'user-1': {
					id: 'user-1',
					role: 'user',
					childrenIds: ['assistant-stale']
				},
				'assistant-stale': {
					id: 'assistant-stale',
					parentId: 'user-1',
					role: 'assistant',
					done: false
				},
				'user-2': {
					id: 'user-2',
					role: 'user',
					childrenIds: ['assistant-done']
				},
				'assistant-done': {
					id: 'assistant-done',
					parentId: 'user-2',
					role: 'assistant',
					done: true
				}
			}
		}),
		false
	);

	assert.equal(
		pendingChatWork.hasVisibleActiveAssistantMessages({
			currentId: 'user-3',
			messages: {
				'user-3': {
					id: 'user-3',
					role: 'user',
					childrenIds: ['assistant-active']
				},
				'assistant-active': {
					id: 'assistant-active',
					parentId: 'user-3',
					role: 'assistant',
					done: false
				}
			}
		}),
		true
	);
});

test('composer streaming state falls back to active task progress for the visible assistant turn', () => {
	const streamingState = pendingChatWork.deriveComposerStreamingState({
		currentId: 'assistant-active',
		messages: {
			'user-1': {
				id: 'user-1',
				role: 'user',
				childrenIds: ['assistant-active']
			},
			'assistant-active': {
				id: 'assistant-active',
				parentId: 'user-1',
				role: 'assistant',
				done: true
			}
		},
		activeTaskIds: ['task-1'],
		activeStreamingMessageIds: ['assistant-active'],
		forceStoppedMessageIds: []
	});

	assert.equal(streamingState.isStreaming, true);
	assert.equal(streamingState.usedActiveTaskFallback, true);
	assert.equal(streamingState.visibleTailMessageId, 'assistant-active');
	assert.deepEqual(streamingState.currentTurnAssistantIds, ['assistant-active']);
});

test('composer streaming state does not revive completed turns from stale task ids alone', () => {
	const streamingState = pendingChatWork.deriveComposerStreamingState({
		currentId: 'assistant-done',
		messages: {
			'user-1': {
				id: 'user-1',
				role: 'user',
				childrenIds: ['assistant-done']
			},
			'assistant-done': {
				id: 'assistant-done',
				parentId: 'user-1',
				role: 'assistant',
				done: true
			}
		},
		activeTaskIds: ['task-1'],
		activeStreamingMessageIds: [],
		forceStoppedMessageIds: []
	});

	assert.equal(streamingState.isStreaming, false);
	assert.equal(streamingState.usedActiveTaskFallback, false);
});

test('composer streaming state respects force-stopped visible assistants even with active tasks', () => {
	const streamingState = pendingChatWork.deriveComposerStreamingState({
		currentId: 'assistant-force-stopped',
		messages: {
			'user-1': {
				id: 'user-1',
				role: 'user',
				childrenIds: ['assistant-force-stopped']
			},
			'assistant-force-stopped': {
				id: 'assistant-force-stopped',
				parentId: 'user-1',
				role: 'assistant',
				done: true
			}
		},
		activeTaskIds: ['task-1'],
		activeStreamingMessageIds: ['assistant-force-stopped'],
		forceStoppedMessageIds: ['assistant-force-stopped']
	});

	assert.equal(streamingState.isStreaming, false);
	assert.equal(streamingState.usedActiveTaskFallback, false);
});

test('plain enter stays on the normal send path when no assistant is visibly active', () => {
	const isStreaming = pendingChatWork.hasVisibleActiveAssistantMessages({
		currentId: 'user-2',
		messages: {
			'user-1': {
				id: 'user-1',
				role: 'user',
				childrenIds: ['assistant-stale']
			},
			'assistant-stale': {
				id: 'assistant-stale',
				parentId: 'user-1',
				role: 'assistant',
				done: false
			},
			'user-2': {
				id: 'user-2',
				role: 'user',
				childrenIds: ['assistant-done']
			},
			'assistant-done': {
				id: 'assistant-done',
				parentId: 'user-2',
				role: 'assistant',
				done: true
			}
		}
	});

	assert.equal(isStreaming, false);
	assert.equal(
		pendingChatWork.resolveComposerHotkeyAction({
			key: 'Enter',
			altKey: false,
			shiftKey: false,
			isStreaming,
			prompt: 'normal follow-up',
			hasFiles: false,
			hasPendingSteer: false,
			queuedPromptCount: 0,
			pendingWorkEditMode: 'none'
		}),
		'none'
	);
});

test('plain enter and option-enter route to pending work when task/progress fallback says streaming', () => {
	const streamingState = pendingChatWork.deriveComposerStreamingState({
		currentId: 'assistant-active',
		messages: {
			'user-1': {
				id: 'user-1',
				role: 'user',
				childrenIds: ['assistant-active']
			},
			'assistant-active': {
				id: 'assistant-active',
				parentId: 'user-1',
				role: 'assistant',
				done: true
			}
		},
		activeTaskIds: ['task-1'],
		activeStreamingMessageIds: ['assistant-active'],
		forceStoppedMessageIds: []
	});

	assert.equal(
		pendingChatWork.resolveComposerHotkeyAction({
			key: 'Enter',
			altKey: false,
			shiftKey: false,
			isStreaming: streamingState.isStreaming,
			prompt: 'steer now',
			hasFiles: false,
			hasPendingSteer: false,
			queuedPromptCount: 0,
			pendingWorkEditMode: 'none'
		}),
		'submit-steer'
	);

	assert.equal(
		pendingChatWork.resolveComposerHotkeyAction({
			key: 'Enter',
			altKey: true,
			shiftKey: false,
			isStreaming: streamingState.isStreaming,
			prompt: 'queue now',
			hasFiles: false,
			hasPendingSteer: false,
			queuedPromptCount: 0,
			pendingWorkEditMode: 'none'
		}),
		'submit-queue'
	);
});

test('multi-model siblings keep the current turn in streaming mode until all assistants finish', () => {
	assert.equal(
		pendingChatWork.hasVisibleActiveAssistantMessages({
			currentId: 'assistant-a',
			messages: {
				'user-1': {
					id: 'user-1',
					role: 'user',
					childrenIds: ['assistant-a', 'assistant-b']
				},
				'assistant-a': {
					id: 'assistant-a',
					parentId: 'user-1',
					role: 'assistant',
					done: true
				},
				'assistant-b': {
					id: 'assistant-b',
					parentId: 'user-1',
					role: 'assistant',
					done: false
				}
			}
		}),
		true
	);

	assert.equal(
		pendingChatWork.hasVisibleActiveAssistantMessages({
			currentId: 'assistant-a',
			messages: {
				'user-1': {
					id: 'user-1',
					role: 'user',
					childrenIds: ['assistant-a', 'assistant-b']
				},
				'assistant-a': {
					id: 'assistant-a',
					parentId: 'user-1',
					role: 'assistant',
					done: true
				},
				'assistant-b': {
					id: 'assistant-b',
					parentId: 'user-1',
					role: 'assistant',
					done: true
				}
			}
		}),
		false
	);
});

test('arrow-up prioritizes pending steer and option-arrow keys rotate queued prompts', () => {
	assert.equal(
		pendingChatWork.resolveComposerHotkeyAction({
			key: 'ArrowUp',
			altKey: false,
			shiftKey: false,
			isStreaming: true,
			prompt: '',
			hasFiles: false,
			hasPendingSteer: true,
			queuedPromptCount: 2,
			pendingWorkEditMode: 'none'
		}),
		'restore-steer'
	);
	assert.equal(
		pendingChatWork.resolveComposerHotkeyAction({
			key: 'ArrowUp',
			altKey: true,
			shiftKey: false,
			isStreaming: true,
			prompt: '',
			hasFiles: false,
			hasPendingSteer: true,
			queuedPromptCount: 2,
			pendingWorkEditMode: 'none'
		}),
		'restore-queue-previous'
	);
	assert.equal(
		pendingChatWork.resolveComposerHotkeyAction({
			key: 'ArrowDown',
			altKey: true,
			shiftKey: false,
			isStreaming: true,
			prompt: '',
			hasFiles: false,
			hasPendingSteer: true,
			queuedPromptCount: 2,
			pendingWorkEditMode: 'none'
		}),
		'restore-queue-next'
	);
	assert.equal(
		pendingChatWork.resolveComposerHotkeyAction({
			key: 'ArrowDown',
			altKey: true,
			shiftKey: false,
			isStreaming: true,
			prompt: 'draft in progress',
			hasFiles: false,
			hasPendingSteer: true,
			queuedPromptCount: 2,
			pendingWorkEditMode: 'queue'
		}),
		'restore-queue-next'
	);
	assert.equal(
		pendingChatWork.resolveComposerHotkeyAction({
			key: 'ArrowUp',
			altKey: false,
			shiftKey: false,
			isStreaming: false,
			prompt: '',
			hasFiles: false,
			hasPendingSteer: false,
			queuedPromptCount: 0,
			pendingWorkEditMode: 'none'
		}),
		'none'
	);
});

test('queued prompt edit rotation walks in both directions and wraps', () => {
	const queuedPrompts = [
		{ id: 'first', sort_index: 0, prompt: 'first' },
		{ id: 'second', sort_index: 1, prompt: 'second' },
		{ id: 'third', sort_index: 2, prompt: 'third' }
	];

	assert.equal(
		pendingChatWork.getQueuedPromptEditTarget(queuedPrompts, null, 'previous').id,
		'third'
	);
	assert.equal(
		pendingChatWork.getQueuedPromptEditTarget(queuedPrompts, 'third', 'previous').id,
		'second'
	);
	assert.equal(
		pendingChatWork.getQueuedPromptEditTarget(queuedPrompts, 'second', 'previous').id,
		'first'
	);
	assert.equal(
		pendingChatWork.getQueuedPromptEditTarget(queuedPrompts, 'first', 'previous').id,
		'third'
	);
	assert.equal(
		pendingChatWork.getQueuedPromptEditTarget(queuedPrompts, null, 'next').id,
		'first'
	);
	assert.equal(
		pendingChatWork.getQueuedPromptEditTarget(queuedPrompts, 'first', 'next').id,
		'second'
	);
	assert.equal(
		pendingChatWork.getQueuedPromptEditTarget(queuedPrompts, 'second', 'next').id,
		'third'
	);
	assert.equal(
		pendingChatWork.getQueuedPromptEditTarget(queuedPrompts, 'third', 'next').id,
		'first'
	);
});

test('dispatch order stays ascending by sort index', () => {
	const ordered = pendingChatWork.sortQueuedPromptsForDispatch([
		{ id: 'third', sort_index: 3 },
		{ id: 'first', sort_index: 1 },
		{ id: 'second', sort_index: 2 }
	]);

	assert.deepEqual(
		ordered.map((item) => item.id),
		['first', 'second', 'third']
	);
});

test('pending-work shortcut keycaps switch between mac and non-mac platforms', () => {
	assert.deepEqual(
		pendingChatWork.getPendingWorkShortcutKeycaps('MacIntel', 'steer-submit'),
		['↩']
	);
	assert.deepEqual(
		pendingChatWork.getPendingWorkShortcutKeycaps('MacIntel', 'queue-submit'),
		['⌥', '↩']
	);
	assert.deepEqual(
		pendingChatWork.getPendingWorkShortcutKeycaps('MacIntel', 'queue-edit-previous'),
		['⌥', '↑']
	);
	assert.deepEqual(
		pendingChatWork.getPendingWorkShortcutKeycaps('Win32', 'queue-edit-next'),
		['Alt', 'Down']
	);
	assert.deepEqual(
		pendingChatWork.getPendingWorkShortcutKeycaps('Linux x86_64', 'queue-edit-previous'),
		['Alt', 'Up']
	);
});

test('queued prompts widget only shows the edit hint in the header', async () => {
	const source = await fs.readFile(MESSAGE_INPUT_SVELTE_PATH, 'utf8');
	const widgetStart = source.indexOf('<span class="text-sky-700 dark:text-sky-200">Queued Prompts</span>');
	const widgetEnd = source.indexOf('{queuedPrompts.length}', widgetStart);
	assert.notEqual(widgetStart, -1);
	assert.notEqual(widgetEnd, -1);

	const segment = source.slice(widgetStart, widgetEnd);
	assert.equal(segment.includes('queues after the response finishes'), false);
	assert.equal(segment.includes('{queueEditPreviousKeycaps[0]}'), true);
	assert.equal(segment.includes('{queueEditPreviousKeycaps[1]}'), true);
	assert.equal(segment.includes('{queueEditNextKeycaps[1]}'), true);
	assert.equal(segment.includes('<span>to edit queued prompts</span>'), true);
	assert.equal(segment.includes('<span class="text-slate-400 dark:text-slate-500">+</span>'), true);
	assert.equal(segment.includes('<span class="text-slate-400 dark:text-slate-500">/</span>'), true);
});

test('pending steer widget uses the same header and nested-item card pattern as queued prompts', async () => {
	const source = await fs.readFile(MESSAGE_INPUT_SVELTE_PATH, 'utf8');
	const widgetStart = source.indexOf('<span class="text-sky-700 dark:text-sky-200">Pending Steer</span>');
	const widgetEnd = source.indexOf('{#if queuedPrompts.length > 0}', widgetStart);
	assert.notEqual(widgetStart, -1);
	assert.notEqual(widgetEnd, -1);

	const segment = source.slice(widgetStart, widgetEnd);
	assert.equal(segment.includes('Sends on the next turn'), true);
	assert.equal(
		segment.includes(
			'inline-flex min-w-5 items-center justify-center rounded-md border border-slate-300/80 bg-white/90 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600'
		),
		true
	);
	assert.equal(segment.includes('↑'), true);
	assert.equal(segment.includes('<span>to edit pending steer</span>'), true);
	assert.equal(
		segment.includes(
			'rounded-full border border-sky-200/80 bg-sky-50 px-2 py-0.5 text-xs font-semibold text-sky-700'
		),
		true
	);
	assert.equal(
		segment.includes('flex items-start gap-3 rounded-xl border border-slate-200/80 bg-slate-50/80 px-3 py-2'),
		true
	);
	assert.equal(segment.includes('truncate text-xs italic text-slate-500 dark:text-slate-400'), true);
	assert.equal(
		segment.includes('hover:bg-slate-200/80 hover:text-slate-700 dark:hover:bg-white/10 dark:hover:text-slate-200'),
		true
	);
	assert.equal(segment.includes("aria-label={$i18n.t('Cancel pending steer')}"), true);
});

test('pending-work previews use the first prompt line and attachment fallbacks', () => {
	assert.equal(
		pendingChatWork.getPendingWorkPreviewText({
			id: 'queued-1',
			status: 'queued',
			prompt: 'first line\nsecond line',
			files: []
		}),
		'first line'
	);
	assert.equal(
		pendingChatWork.getPendingWorkPreviewText({
			id: 'queued-2',
			status: 'queued',
			prompt: '',
			files: [{ id: 'file-1' }, { id: 'file-2' }]
		}),
		'2 attachments ready'
	);
});

test('pending-work state snapshots prefer newer timestamps over stale higher versions on the same chat', () => {
	assert.equal(
		pendingChatWork.shouldApplyPendingWorkStateSnapshot(
			{
				chat_id: 'chat-1',
				version: 9,
				updated_at: '2026-03-23T15:00:02.000Z',
				pending_steer: { id: 'steer-1', prompt: 'active', files: [], status: 'active' },
				queued_prompts: []
			},
			{
				chat_id: 'chat-1',
				version: 8,
				updated_at: '2026-03-23T15:00:03.000Z',
				pending_steer: null,
				queued_prompts: []
			}
		),
		true
	);

	assert.equal(
		pendingChatWork.shouldApplyPendingWorkStateSnapshot(
			{
				chat_id: 'chat-1',
				version: 9,
				updated_at: '2026-03-23T15:00:03.000Z',
				pending_steer: null,
				queued_prompts: []
			},
			{
				chat_id: 'chat-1',
				version: 999,
				updated_at: '2026-03-23T15:00:02.000Z',
				pending_steer: { id: 'steer-1', prompt: 'stale', files: [], status: 'active' },
				queued_prompts: []
			}
		),
		false
	);

	assert.equal(
		pendingChatWork.shouldApplyPendingWorkStateSnapshot(
			{
				chat_id: 'chat-1',
				version: 9,
				updated_at: '2026-03-23T15:00:03.000Z',
				pending_steer: null,
				queued_prompts: []
			},
			{
				chat_id: 'chat-2',
				version: 1,
				updated_at: '2026-03-23T15:00:01.000Z',
				pending_steer: null,
				queued_prompts: []
			}
		),
		true
	);
});

test('unknown streaming events trigger backend-started turn reconciliation only when needed', () => {
	assert.equal(
		pendingChatWork.shouldReconcileBackendStartedTurnEvent({
			eventType: 'chat:message:delta',
			messageId: 'assistant-2',
			messages: {
				'assistant-1': { id: 'assistant-1' }
			}
		}),
		true
	);

	assert.equal(
		pendingChatWork.shouldReconcileBackendStartedTurnEvent({
			eventType: 'chat:title',
			messageId: 'assistant-2',
			messages: {}
		}),
		false
	);

	assert.equal(
		pendingChatWork.shouldReconcileBackendStartedTurnEvent({
			eventType: 'chat:message',
			messageId: 'assistant-1',
			messages: {
				'assistant-1': { id: 'assistant-1' }
			}
		}),
		false
	);
});

test('background-turn inserted events trigger immediate reconcile before stream deltas', async () => {
	const source = await fs.readFile(CHAT_SVELTE_PATH, 'utf8');
	assert.equal(source.includes("const reconcileBackgroundTurnInsertion = async"), true);
	assert.equal(source.includes("if (type === 'chat:background-turn:inserted')"), true);
	assert.equal(source.includes('await reconcileBackgroundTurnInsertion(data);'), true);
	assert.equal(source.includes('payload?.user_message'), true);
	assert.equal(source.includes('payload?.assistant_messages'), true);
	assert.equal(source.includes('payload?.pending_work'), true);
});

test('background-turn insertion locally hydrates the steered user message even if the branch is only partially present', async () => {
	const source = await fs.readFile(CHAT_SVELTE_PATH, 'utf8');
	assert.equal(source.includes('const hydrateBackgroundTurnMessagesIntoHistory = ({'), true);
	assert.equal(source.includes('const rememberBackgroundTurnInsertionPayload = ({'), true);
	assert.equal(
		source.includes('const nextHistory = cloneSerializableValue(baseHistory);'),
		true
	);
	assert.equal(
		source.includes('backgroundTurnInsertionPayloadsByMessageId.set(messageId, storedPayload);'),
		true
	);
	assert.equal(
		source.includes('const nextHistory =\n\t\t\tinsertedUserMessage && history?.messages'),
		true
	);
});

test('background-turn inserted message IDs are protected against regressive backend syncs', async () => {
	const source = await fs.readFile(CHAT_SVELTE_PATH, 'utf8');
	assert.equal(source.includes('let protectedBackgroundTurnMessageIds = new Set<string>();'), true);
	assert.equal(source.includes('const protectBackgroundTurnMessageIds = (messageIds: string[]) => {'), true);
	assert.equal(
		source.includes('const missingProtectedBackgroundTurnIds = [...protectedBackgroundTurnMessageIds].filter('),
		true
	);
	assert.equal(
		source.includes("!!history?.messages?.[messageId] && !backendHistory?.messages?.[messageId]"),
		true
	);
	assert.equal(
		source.includes("'[Chat] Refused regressive backend sync that would drop protected background-turn message IDs:'"),
		true
	);
	assert.equal(source.includes('protectBackgroundTurnMessageIds(expectedMessageIds);'), true);
	assert.equal(source.includes('repairProtectedBackgroundTurnHistoryWithStoredPayloads('), true);
	assert.equal(
		source.includes("'[Chat] Rehydrated missing protected background-turn user message from stored insertion payload:'"),
		true
	);
});

test('background-turn insertion clears matching pending-work items locally before applying payload state', async () => {
	const source = await fs.readFile(CHAT_SVELTE_PATH, 'utf8');
	assert.equal(source.includes('const clearDispatchedPendingWorkItemLocally = ({'), true);
	assert.equal(source.includes("if (itemKind === 'steer' && nextPendingWork.pending_steer?.id === itemId)"), true);
	assert.equal(
		source.includes('const nextQueuedPrompts = nextPendingWork.queued_prompts.filter((item) => item.id !== itemId);'),
		true
	);
	assert.equal(
		source.includes("payload?.item_kind === 'steer' || payload?.item_kind === 'queue' ? payload.item_kind : null"),
		true
	);
	assert.equal(source.includes('clearDispatchedPendingWorkItemLocally({'), true);
	assert.equal(source.includes('shouldApplyPendingWorkStateSnapshot(pendingWork, nextPendingWork)'), true);
});

test('pending-work request context scopes active capability tool ids to the current chat', async () => {
	const source = await fs.readFile(CHAT_SVELTE_PATH, 'utf8');
	assert.equal(source.includes('import { getScopedActiveCapabilityToolIds } from'), true);
	assert.equal(source.includes('const getActiveCapabilityToolIdsForRequest = ('), true);
	assert.equal(
		source.includes(
			'const activeCapabilityToolIds = getActiveCapabilityToolIdsForRequest(getPendingWorkChatId());'
		),
		true
	);
	assert.equal(
		source.includes('tool_ids: [...new Set([...toolIds, ...activeCapabilityToolIds])]'),
		true
	);
});

test('foreground completion requests scope active capability tool ids to the current chat', async () => {
	const source = await fs.readFile(CHAT_SVELTE_PATH, 'utf8');
	assert.equal(source.includes('const completionRequest = () =>'), true);
	assert.equal(source.includes('toolIds.length > 0 || activeCapabilityToolIds.length > 0'), true);
	assert.equal(source.includes('[...new Set([...toolIds, ...activeCapabilityToolIds])]'), true);
	assert.equal(
		source.includes(
			"const activeCapabilityToolIds = getActiveCapabilityToolIdsForRequest(\n\t\t\tString($chatId ?? chatIdProp ?? '').trim()"
		),
		true
	);
});

test('streaming hint block keeps its spacing tweaks while scroll arrows stay in the original wrapper', async () => {
	const source = await fs.readFile(MESSAGE_INPUT_SVELTE_PATH, 'utf8');
	const outerArrowWrapperStart = source.indexOf('absolute right-4 z-30 pointer-events-none flex flex-col gap-2 -top-20');
	const railStart = source.indexOf('id="message-input-rail"');
	const streamingHintStart = source.indexOf('{#if !readOnlyMode && isStreaming}');
	const composerContainerStart = source.indexOf('id="message-input-container"', streamingHintStart);
	assert.notEqual(outerArrowWrapperStart, -1);
	assert.notEqual(railStart, -1);
	assert.notEqual(streamingHintStart, -1);
	assert.notEqual(composerContainerStart, -1);
	assert(railStart < streamingHintStart);
	assert(streamingHintStart < composerContainerStart);

	const railSegment = source.slice(railStart, composerContainerStart);
	const segment = source.slice(streamingHintStart, composerContainerStart);
	assert.equal(
		source.includes('id="message-input-rail" class="relative flex w-full flex-col gap-2"'),
		true
	);
	assert.equal(source.includes('aria-label="Scroll to top"'), true);
	assert.equal(source.includes('aria-label="Scroll to bottom"'), true);
	assert.equal(railSegment.includes('aria-label="Scroll to top"'), false);
	assert.equal(railSegment.includes('aria-label="Scroll to bottom"'), false);
	assert.equal(segment.includes('flex w-full justify-end'), true);
	assert.equal(segment.includes('justify-end text-[11px]'), true);
	assert.equal(segment.includes('pr-6'), false);
	assert.equal(segment.includes('pointer-events-none flex flex-col items-end gap-y-1.5'), true);
	assert.equal(
		segment.indexOf("{$i18n.t('to steer')}") < segment.indexOf("{$i18n.t('to queue prompt')}"),
		true
	);
	assert.equal(segment.includes('absolute right-5 top-2.5'), false);
	assert.equal(
		source.includes('absolute right-4 z-30 pointer-events-none flex flex-col gap-2 -top-20'),
		true
	);
	assert.equal(source.includes("? 'pt-8'"), false);
	assert.equal(source.includes(": 'pt-9'"), false);
	assert.equal(source.includes("style:min-height={readOnlyMode ? undefined : '5.25rem'}"), true);
});

test('composer rail and composer shell share the same width token without an extra horizontal offset', async () => {
	const source = await fs.readFile(APP_CSS_PATH, 'utf8');
	assert.equal(source.includes("font-family: 'Portico Sans';"), true);
	assert.equal(source.includes('/static/fonts/portico-sans/PorticoSansVF.woff2'), true);
	assert.equal(source.includes('Urbanist'), false);
	assert.equal(source.includes('#message-input-rail {'), true);
	assert.equal(source.includes('--message-input-max-width: 50.5rem;'), true);
	assert.equal(source.includes('--message-input-max-width: 53.5rem;'), true);
	assert.equal(source.includes('--message-input-horizontal-offset'), false);
	assert.equal(
		source.includes('--message-input-max-width: calc(630px * var(--app-text-scale, 1));'),
		false
	);
	assert.equal(source.includes('--message-input-max-width: 56rem;'), false);
	assert.equal(source.includes('transform: translateX(var(--message-input-horizontal-offset));'), false);
	assert.match(source, /@media \(max-width: 1023\.98px\)\s*{\s*#message-input-rail\s*{\s*--message-input-max-width: 53\.5rem;/);
	assert.match(
		source,
		/#message-input-rail,\s*#message-input-container\s*{\s*max-width: var\(--message-input-max-width\) !important;/
	);
});

test('composer shell whitespace clicks focus the editor without hijacking interactive controls', async () => {
	const source = await fs.readFile(MESSAGE_INPUT_SVELTE_PATH, 'utf8');
	const start = source.indexOf('const handleEditorMouseDownCapture = (event: MouseEvent) => {');
	const end = source.indexOf('onMount(async () => {', start);
	assert.notEqual(start, -1);
	assert.notEqual(end, -1);

	const segment = source.slice(start, end);
	assert.equal(
		segment.includes("target.closest('button, a, input, select, textarea, label, [role=\"button\"]')"),
		true
	);
	assert.equal(segment.includes("document.getElementById('message-input-container')"), true);
	assert.equal(segment.includes('messageInputContainer.contains(target)'), true);
	assert.equal(segment.includes('placeEditorCaretAtEnd(editorElement);'), true);
	assert.equal(source.includes('const placeEditorCaretAtEnd = (editorElement: HTMLElement) => {'), true);
});

test('blank pending-work edit submits delete via chat helpers', async () => {
	const source = await fs.readFile(CHAT_SVELTE_PATH, 'utf8');
	assert.equal(source.includes("editingPendingWork?.kind === 'steer' && isBlankPendingWorkDraft()"), true);
	assert.equal(source.includes('await deletePendingSteer('), true);
	assert.equal(source.includes("editingPendingWork?.kind === 'queue' && isBlankPendingWorkDraft()"), true);
	assert.equal(source.includes('await deleteQueuedPrompt('), true);
});

test('submitPrompt yields the optimistic user message before sendMessage starts heavy work', async () => {
	const source = await fs.readFile(CHAT_SVELTE_PATH, 'utf8');
	const start = source.indexOf('const submitPrompt = async');
	const end = source.indexOf('const sendMessage = async', start);
	assert.notEqual(start, -1);
	assert.notEqual(end, -1);

	const segment = source.slice(start, end);
	const userMessageInsertIndex = segment.indexOf('history.messages[userMessageId] = userMessage;');
	const currentIdIndex = segment.indexOf('history.currentId = userMessageId;');
	const historyAssignmentIndex = segment.indexOf('history = history;');
	const tickIndex = segment.indexOf('await tick();');
	const reasoningSnapshotIndex = segment.indexOf('const reasoningEffortByModelSnapshot =');
	const sendMessageIndex = segment.indexOf('await sendMessage(history, userMessageId, {');

	assert(userMessageInsertIndex >= 0);
	assert(currentIdIndex > userMessageInsertIndex);
	assert(historyAssignmentIndex > currentIdIndex);
	assert(tickIndex > historyAssignmentIndex);
	assert(reasoningSnapshotIndex > tickIndex);
	assert(sendMessageIndex > tickIndex);
});

test('sendMessage stages assistant placeholders before cloning the full history snapshot', async () => {
	const source = await fs.readFile(CHAT_SVELTE_PATH, 'utf8');
	const start = source.indexOf('const sendMessage = async');
	const end = source.indexOf('const getFeatures = () =>', start);
	assert.notEqual(start, -1);
	assert.notEqual(end, -1);

	const segment = source.slice(start, end);
	const historyAssignmentIndex = segment.indexOf('history = history;');
	const tickIndex = segment.indexOf('await tick();');
	const snapshotIndex = segment.indexOf('const historySnapshot = cloneSerializableValue(history);');

	assert(historyAssignmentIndex >= 0);
	assert(tickIndex > historyAssignmentIndex);
	assert(snapshotIndex > tickIndex);
	assert.equal(segment.includes('_history = JSON.parse(JSON.stringify(_history));'), false);
});

test('streaming message commits invalidate history so the composer re-renders during streams', async () => {
	const source = await fs.readFile(CHAT_SVELTE_PATH, 'utf8');
	const start = source.indexOf('const scheduleStreamingMessageCommit = (message: any): boolean => {');
	const end = source.indexOf('const flushPendingStreamingMessageCommit =', start);
	assert.notEqual(start, -1);
	assert.notEqual(end, -1);

	const segment = source.slice(start, end);
	const messageCommitIndex = segment.indexOf('history.messages[messageId] = message;');
	const historyAssignmentIndex = segment.indexOf('history = history;');
	const committedAtIndex = segment.indexOf('state.lastCommittedAt = Date.now();');

	assert(messageCommitIndex >= 0);
	assert(historyAssignmentIndex > messageCommitIndex);
	assert(committedAtIndex > historyAssignmentIndex);
});

test('MessageInput receives a reactive chat-level streaming flag instead of an inline helper call', async () => {
	const source = await fs.readFile(CHAT_SVELTE_PATH, 'utf8');
	assert.equal(source.includes('isStreaming={isStreamingComposerMode()}'), false);
	assert.equal(source.includes('isStreaming={composerStreamingState.isStreaming}'), true);
	assert.equal(source.includes('composerStreamingStateVersion;'), true);
	assert.equal(source.includes('composerStreamingState = computeComposerStreamingState();'), true);
});

test('MessageInput no longer depends on live history props for composer rendering', async () => {
	const source = await fs.readFile(CHAT_SVELTE_PATH, 'utf8');
	assert.equal(source.includes('{history}\n\t\t\t\t\t\t\t\t\t{taskIds}'), false);
	assert.equal(source.includes('hasConversation={Boolean(history?.currentId)}'), true);
	assert.equal(source.includes('getAutocompleteMessages={getAutocompleteContextMessages}'), true);
});

test('reasoning effort is hydrated per chat instead of from global localStorage', async () => {
	const chatSource = await fs.readFile(CHAT_SVELTE_PATH, 'utf8');
	const inputSource = await fs.readFile(MESSAGE_INPUT_SVELTE_PATH, 'utf8');
	const placeholderSource = await fs.readFile(PLACEHOLDER_SVELTE_PATH, 'utf8');

	assert.equal(chatSource.includes("localStorage.getItem('reasoningEffortByModel')"), false);
	assert.equal(chatSource.includes("localStorage.setItem('reasoningEffortByModel'"), false);
	assert.equal(inputSource.includes("localStorage.getItem('reasoningEffortByModel')"), false);
	assert.equal(inputSource.includes("localStorage.setItem('reasoningEffortByModel'"), false);
	assert.equal(placeholderSource.includes('export let reasoningEffortByModel: Record<string, string> = {};'), true);
	assert.equal(chatSource.includes('reasoningEffortReady={reasoningEffortReady}'), true);
	assert.equal(inputSource.includes('export let reasoningEffortReady = false;'), true);
	assert.equal(chatSource.includes('resetReasoningEffortState({ ready: false });'), true);
});

test('reasoning persistence is explicit instead of a reactive chat-state side effect', async () => {
	const source = await fs.readFile(CHAT_SVELTE_PATH, 'utf8');
	assert.equal(source.includes('$: if ($chatId && reasoningEffortReady && !detachedSubagentView)'), false);
	assert.equal(source.includes('const persistReasoningEffortSnapshot = ({'), true);
});

test('first-turn reasoning dispatch no longer uses hardcoded medium fallbacks', async () => {
	const chatSource = await fs.readFile(CHAT_SVELTE_PATH, 'utf8');
	const backendSource = await fs.readFile(PENDING_CHAT_WORK_PY_PATH, 'utf8');

	assert.equal(
		chatSource.includes("reasoning_effort: reasoningEffortByModel[String(modelIdx)] || 'medium'"),
		false
	);
	assert.equal(
		chatSource.includes(
			"sanitizeReasoningEffortByModel(reasoningEffortByModelSnapshot)[String(modelIdx)] ?? null"
		),
		true
	);
	assert.equal(
		backendSource.includes('reasoning_effort_by_model.get(str(model_idx)) or "medium"'),
		false
	);
	assert.equal(backendSource.includes('if reasoning_effort:'), true);
});

test('draft restoration brings back reasoning state for unsaved and existing chats', async () => {
	const source = await fs.readFile(CHAT_SVELTE_PATH, 'utf8');

	assert.equal(source.includes("if ('reasoningEffortByModel' in input)"), true);
	assert.equal(
		source.includes('nextMap: sanitizeReasoningEffortByModel(input.reasoningEffortByModel)'),
		true
	);
	assert.equal(source.includes('applyDraftInput(input);'), true);
});

test('reasoning badge resolves string effort values instead of option objects', async () => {
	const inputSource = await fs.readFile(MESSAGE_INPUT_SVELTE_PATH, 'utf8');

	assert.equal(inputSource.includes('allowedOptions: availableOptions'), false);
	assert.equal(inputSource.includes('allowedOptions: model.options'), true);
	assert.equal(inputSource.includes('}) ?? model.options[0]}'), true);
	assert.equal(inputSource.includes('}) ?? availableOptions[0]}'), false);
});

test('new-chat placeholder forwards reasoning state into the shared MessageInput', async () => {
	const source = await fs.readFile(PLACEHOLDER_SVELTE_PATH, 'utf8');

	assert.equal(source.includes('{reasoningEffortByModel}'), true);
	assert.equal(source.includes('{reasoningEffortReady}'), true);
	assert.equal(source.includes('{onReasoningEffortSelect}'), true);
});

test('reasoning selection is owned by Chat.svelte instead of mutating MessageInput props', async () => {
	const chatSource = await fs.readFile(CHAT_SVELTE_PATH, 'utf8');
	const inputSource = await fs.readFile(MESSAGE_INPUT_SVELTE_PATH, 'utf8');

	assert.equal(chatSource.includes('const handleReasoningEffortSelection = ({'), true);
	assert.equal(chatSource.includes('void saveDraftImmediately('), true);
	assert.equal(chatSource.includes('bind:reasoningEffortByModel'), false);
	assert.equal(inputSource.includes('export let onReasoningEffortSelect: Function = () => {};'), true);
	assert.equal(inputSource.includes('onReasoningEffortSelect({'), true);
	assert.equal(inputSource.includes('reasoningEffortByModel[modelKey] = option.value;'), false);
	assert.equal(inputSource.includes('reasoningEffortByModel = { ...reasoningEffortByModel };'), false);
});

test('first-turn requests and chat-state saves use a frozen reasoning snapshot', async () => {
	const source = await fs.readFile(CHAT_SVELTE_PATH, 'utf8');

	assert.equal(source.includes('const reasoningEffortByModelSnapshot ='), true);
	assert.equal(source.includes('reasoningEffortByModelSnapshot?: Record<string, string> | null;'), true);
	assert.equal(
		source.includes('sanitizeReasoningEffortByModel(reasoningEffortByModelSnapshot)[String(modelIdx)]'),
		true
	);
	assert.equal(source.includes('reasoningEffortByModelSnapshot = getResolvedReasoningEffortByModelSnapshot(modelIdsSnapshot)'), true);
});

test('reasoning selections save drafts immediately and persist saved chats from resolved snapshots', async () => {
	const source = await fs.readFile(CHAT_SVELTE_PATH, 'utf8');

	assert.equal(source.includes('void saveDraftImmediately('), true);
	assert.equal(source.includes('buildDraftInput({'), true);
	assert.equal(source.includes('nextReasoningEffortByModel: normalizedExplicitReasoningEffortByModel'), true);
	assert.equal(source.includes('}),\n\t\t\t\t$chatId || null'), true);
	assert.equal(source.includes('persistReasoningEffortSnapshot({'), true);
	assert.equal(source.includes('reasoningEffortByModelSnapshot: getResolvedReasoningEffortByModelSnapshotFromState({'), true);
});

test('stream watchdog backend sync merges usage monotonically instead of overwriting with lower snapshots', async () => {
	const source = await fs.readFile(CHAT_SVELTE_PATH, 'utf8');
	const contentUpdateStart = source.indexOf('const mergedUsage = backendMessage.usage');
	const contentUpdateEnd = source.indexOf('lastSocketEventTime[messageId] = Date.now(); // Reset stall timer', contentUpdateStart);
	const usageOnlyStart = source.indexOf('} else if (backendMessage.usage) {', contentUpdateEnd);
	const usageOnlyEnd = source.indexOf('} else {', usageOnlyStart);

	assert.notEqual(contentUpdateStart, -1);
	assert.notEqual(contentUpdateEnd, -1);
	assert.notEqual(usageOnlyStart, -1);
	assert.notEqual(usageOnlyEnd, -1);

	const contentUpdateSegment = source.slice(contentUpdateStart, contentUpdateEnd);
	const usageOnlySegment = source.slice(usageOnlyStart, usageOnlyEnd);

	assert.equal(contentUpdateSegment.includes("mergePromptUsage("), true);
	assert.equal(contentUpdateSegment.includes("usage: mergedUsage"), true);
	assert.equal(contentUpdateSegment.includes("usage: backendMessage.usage"), false);
	assert.equal(usageOnlySegment.includes("mergePromptUsage("), true);
	assert.equal(usageOnlySegment.includes("usage: mergedUsage"), true);
});

test('streaming usage updates use cumulative max merges and preserve throttled pending snapshots', async () => {
	const source = await fs.readFile(CHAT_SVELTE_PATH, 'utf8');
	const applyStart = source.indexOf('const applyStreamingUsageUpdate = (');
	const applyEnd = source.indexOf('const flushPendingStreamingUsageUpdate = (', applyStart);

	assert.notEqual(applyStart, -1);
	assert.notEqual(applyEnd, -1);

	const segment = source.slice(applyStart, applyEnd);
	assert.equal(segment.includes("const mergedUsage = mergePromptUsage("), true);
	assert.equal(segment.includes("'max'"), true);
	assert.equal(segment.includes('state.pendingUsage = mergedUsage;'), true);
	assert.equal(segment.includes('message.usage = mergedUsage;'), true);
	assert.equal(segment.includes('message.usage = usage;'), false);
});

test('flushing pending streaming usage preserves the monotonic merged snapshot and emits progress', async () => {
	const source = await fs.readFile(CHAT_SVELTE_PATH, 'utf8');
	const flushStart = source.indexOf('const flushPendingStreamingUsageUpdate = (');
	const flushEnd = source.indexOf('const estimateWordCount = (content: string): number => {', flushStart);

	assert.notEqual(flushStart, -1);
	assert.notEqual(flushEnd, -1);

	const segment = source.slice(flushStart, flushEnd);
	assert.equal(segment.includes('message.usage = state.pendingUsage;'), true);
	assert.equal(segment.includes('noteVisibleAssistantProgress(message);'), true);
	assert.equal(segment.includes('bumpContextTokensVersion();'), true);
});

test('chatCompletedHandler merges persisted usage snapshots by max before replacing history messages', async () => {
	const source = await fs.readFile(CHAT_SVELTE_PATH, 'utf8');
	const handlerStart = source.indexOf('const chatCompletedHandler = async (_chatId, modelId, responseMessageId, messages) => {');
	const handlerEnd = source.indexOf('const chatActionHandler = async (_chatId, actionId, modelId, responseMessageId, event = null) => {', handlerStart);

	assert.notEqual(handlerStart, -1);
	assert.notEqual(handlerEnd, -1);

	const segment = source.slice(handlerStart, handlerEnd);
	assert.equal(segment.includes('const mergedUsage = mergePromptUsage('), true);
	assert.equal(segment.includes("'max'"), true);
	assert.equal(segment.includes('usage: mergedUsage'), true);
	assert.equal(segment.includes('usage: message?.usage'), false);
	assert.equal(segment.includes('if (get(chatId) !== _chatId) {'), true);
	assert.equal(segment.includes('const updatedChat = await updateChatById('), true);
	assert.equal(segment.includes('chat = updatedChat;'), true);
});

test('scrollToBottom uses the guarded helper instead of writing scrollTop directly', async () => {
	const source = await fs.readFile(CHAT_SVELTE_PATH, 'utf8');
	const scrollToBottomStart = source.indexOf("const scrollToBottom = async (behavior = 'auto') => {");
	const scrollToBottomEnd = source.indexOf('const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 50;', scrollToBottomStart);

	assert.notEqual(scrollToBottomStart, -1);
	assert.notEqual(scrollToBottomEnd, -1);

	const segment = source.slice(scrollToBottomStart, scrollToBottomEnd);
	assert.equal(segment.includes('await tick();'), true);
	assert.equal(segment.includes('scrollMessagesContainerToBottom(behavior);'), true);
	assert.equal(segment.includes('scrollTop = 9999999'), false);
});

test('scroll helper marks programmatic writes before bottom snapping the messages container', async () => {
	const source = await fs.readFile(CHAT_SVELTE_PATH, 'utf8');
	const helperStart = source.indexOf("const scrollMessagesContainerToBottom = (behavior: ScrollBehavior = 'auto') => {");
	const helperEnd = source.indexOf('// PORTICO_PATCH: Sticky auto-scroll.', helperStart);

	assert.notEqual(helperStart, -1);
	assert.notEqual(helperEnd, -1);

	const segment = source.slice(helperStart, helperEnd);
	assert.equal(segment.includes('markAutoScrollProgrammaticWrite();'), true);
	assert.equal(segment.includes('messagesContainerElement.scrollTo({'), true);
	assert.equal(segment.includes('top: messagesContainerElement.scrollHeight,'), true);
});

test('sticky auto-scroll detaches from user scroll and no longer runs a force-scroll interval', async () => {
	const source = await fs.readFile(CHAT_SVELTE_PATH, 'utf8');
	const observerStart = source.indexOf("const setupAutoScrollObserver = () => {");
	const observerEnd = source.indexOf("$: if (messagesContentElement && messagesContainerElement) {", observerStart);
	const pollingStart = source.indexOf("const startAutoScrollPolling = () => {");
	const pollingEnd = source.indexOf("const stopAutoScrollPolling = () => {", pollingStart);
	const wheelStart = source.indexOf("const handleMessagesWheel = (event: WheelEvent) => {");
	const wheelEnd = source.indexOf("const handleMessagesScroll = () => {", wheelStart);
	const scrollStart = wheelEnd;
	const scrollEnd = source.indexOf("const clearGenerationStateIfIdle = (options: { clearTaskIds?: boolean } = {}) => {", scrollStart);

	assert.notEqual(pollingStart, -1);
	assert.notEqual(pollingEnd, -1);
	assert.notEqual(observerStart, -1);
	assert.notEqual(observerEnd, -1);
	assert.notEqual(wheelStart, -1);
	assert.notEqual(wheelEnd, -1);
	assert.notEqual(scrollEnd, -1);

	const pollingSegment = source.slice(pollingStart, pollingEnd);
	const observerSegment = source.slice(observerStart, observerEnd);
	const wheelSegment = source.slice(wheelStart, wheelEnd);
	const scrollSegment = source.slice(scrollStart, scrollEnd);

	assert.equal(source.includes('const AUTO_SCROLL_PROGRAMMATIC_GUARD_MS = 200;'), true);
	assert.equal(source.includes('messagesContainerElement.scrollTo({'), true);
	assert.equal(pollingSegment.includes('setInterval('), false);
	assert.equal(pollingSegment.includes('return;'), true);
	assert.equal(observerSegment.includes("scrollMessagesContainerToBottom('auto');"), true);
	assert.equal(observerSegment.includes('scrollTop = 9999999'), false);
	assert.equal(wheelSegment.includes('!hasActiveProgrammaticScrollWrite()'), true);
	assert.equal(scrollSegment.includes('const isNearBottom = distanceFromBottom <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX;'), true);
	assert.equal(scrollSegment.includes('if (isNearBottom) {'), true);
	assert.equal(scrollSegment.includes('autoScroll = true;'), true);
	assert.equal(scrollSegment.includes('} else if (!hasActiveProgrammaticScrollWrite()) {'), true);
	assert.equal(scrollSegment.includes('autoScroll = isNearBottom;'), true);
});

test('hidden detached chats pause the stream watchdog until the window is visible again', async () => {
	const source = await fs.readFile(CHAT_SVELTE_PATH, 'utf8');
	const watchdogStart = source.indexOf('const checkStreamWatchdog = async () => {');
	const watchdogEnd = source.indexOf('const resyncRunningAssistantMessages = async (', watchdogStart);

	assert.notEqual(watchdogStart, -1);
	assert.notEqual(watchdogEnd, -1);

	const watchdogSegment = source.slice(watchdogStart, watchdogEnd);
	assert.equal(source.includes("const isDocumentHidden = () =>"), true);
	assert.equal(watchdogSegment.includes("if (isDocumentHidden()) return;"), true);
});

test('tool cards stay completed when a later parent-message stop_reason is present', async () => {
	const source = await fs.readFile(COLLAPSIBLE_SVELTE_PATH, 'utf8');

	assert.equal(
		source.includes("const hasExplicitToolResult = Object.prototype.hasOwnProperty.call(attributes ?? {}, 'result')"),
		true
	);
	assert.equal(
		source.includes("const isToolDisplayStopped = !hasExplicitToolResult && (isToolStopped || (!hasExplicitToolDone && !!String(messageStopReason ?? '').trim()))"),
		true
	);
});

test('tool cards distinguish preparing and running phases for streamed tool batches', async () => {
	const source = await fs.readFile(COLLAPSIBLE_SVELTE_PATH, 'utf8');

	assert.equal(
		source.includes("const toolPhase = String(attributes?.phase ?? '').trim().toLowerCase()"),
		true
	);
	assert.equal(
		source.includes("const toolBlockAnimationClass = isToolDone ? '' : isToolPreparing ? 'tool-preview-shimmer' : 'tool-shimmer'"),
		true
	);
	assert.equal(
		source.includes("const toolRunningLabel = isToolPreparing ? 'Preparing tool' : 'Running tool'"),
		true
	);
});

test('auto-scroll stop path still performs one guarded final snap after streaming ends', async () => {
	const source = await fs.readFile(CHAT_SVELTE_PATH, 'utf8');
	const stopStart = source.indexOf("const stopAutoScrollPolling = () => {");
	const stopEnd = source.indexOf("// Start/stop polling when streaming starts/stops.", stopStart);

	assert.notEqual(stopStart, -1);
	assert.notEqual(stopEnd, -1);

	const stopSegment = source.slice(stopStart, stopEnd);
	assert.equal(stopSegment.includes('setTimeout(() => {'), true);
	assert.equal(stopSegment.includes("scrollMessagesContainerToBottom('auto');"), true);
	assert.equal(stopSegment.includes('scrollTop = 9999999'), false);
});

test('wheel detachment only happens on upward manual scroll while auto-scroll is active', async () => {
	const source = await fs.readFile(CHAT_SVELTE_PATH, 'utf8');
	const wheelStart = source.indexOf("const handleMessagesWheel = (event: WheelEvent) => {");
	const wheelEnd = source.indexOf("const handleMessagesScroll = () => {", wheelStart);

	assert.notEqual(wheelStart, -1);
	assert.notEqual(wheelEnd, -1);

	const segment = source.slice(wheelStart, wheelEnd);
	assert.equal(
		segment.includes('if (event.deltaY < -2 && autoScroll && !hasActiveProgrammaticScrollWrite()) {'),
		true
	);
	assert.equal(segment.includes('autoScroll = false;'), true);
});

test('debug monitor summaries use upstream request ids as the primary identity', () => {
	const event = {
		event_id: 'event-1',
		event_type: 'llm_request_payload',
		timestamp: '2026-03-27T10:00:00Z',
		chat_id: 'chat-1',
		message_id: 'assistant-1',
		debug_request_id: 'dbg-1',
		upstream_request_id: 'upstream-1',
		trigger_message_id: 'user-1',
		request_phase: 'tool_followup',
		followup_index: 2,
		outer_message_id: 'assistant-1',
		data: {
			model: 'Atlas Opus 4.6',
			messages: [{ role: 'user', content: 'hello' }],
			tools: [{ id: 'tool-1' }]
		}
	};

	assert.equal(owuiDebugMonitor.resolveDebugMonitorRequestId(event), 'upstream-1');

	const summary = owuiDebugMonitor.applyDebugMonitorEventToSummary(undefined, event);
	assert.equal(summary.request_id, 'upstream-1');
	assert.equal(summary.debug_request_id, 'dbg-1');
	assert.equal(summary.upstream_request_id, 'upstream-1');
	assert.equal(summary.trigger_message_id, 'user-1');
	assert.equal(summary.request_phase, 'tool_followup');
	assert.equal(summary.followup_index, 2);
	assert.equal(summary.outer_message_id, 'assistant-1');
	assert.equal(summary.message_count, 1);
	assert.equal(summary.tool_count, 1);
	assert.equal(summary.status, 'streaming');
});

test('debug monitor modal payload prefers the latest transformed payload over raw payload', () => {
	const payload = owuiDebugMonitor.buildDebugRequestModalPayload({
		request: {
			request_id: 'upstream-1',
			model: 'atlas-opus',
			base_model: 'Atlas Opus 4.6',
			request_phase: 'tool_followup',
			followup_index: 1,
			raw_payload: { stale: true },
			transformed_payloads: [
				{ payload: { step: 1 }, api_path: 'chat-completions' },
				{ payload: { step: 2, model: 'provider-shape' }, api_path: 'bedrock-converse' }
			]
		}
	});

	assert.equal(payload.requestId, 'upstream-1');
	assert.equal(payload.model, 'Atlas Opus 4.6');
	assert.equal(payload.requestPhase, 'tool_followup');
	assert.equal(payload.subtitle.includes('phase=tool_followup'), true);
	assert.equal(payload.subtitle.includes('followup=1'), true);
	assert.deepEqual(JSON.parse(payload.json), { step: 2, model: 'provider-shape' });
});

test('chat debug mode source wires global debug mode events, monitor hydration, websocket streaming, and external debug monitor links', async () => {
	const source = await fs.readFile(CHAT_SVELTE_PATH, 'utf8');

	assert.equal(source.includes("window.addEventListener('owui-debug-mode-changed'"), true);
	assert.equal(source.includes('const resolveDebugModeEnabled = (value: unknown): boolean => {'), true);
	assert.equal(source.includes('const applyDebugModeEnabled = (enabled: boolean) => {'), true);
	assert.equal(source.includes('debugMonitorSyncVersion += 1;'), true);
	assert.equal(
		source.includes(
			'applyDebugModeEnabled(resolveDebugModeEnabled(await getWebviewHostApi()?.getDebugMode?.()));'
		),
		true
	);
	assert.equal(source.includes('applyDebugModeEnabled(Boolean(detail?.enabled));'), true);
	assert.equal(source.includes('fetchChatDebugRequests(chatId, access)'), true);
	assert.equal(source.includes('new WebSocket(buildDebugMonitorWebSocketUrl({ chatId, access }))'), true);
	assert.equal(source.includes('getDebugMonitorAccess?: () => Promise<DebugMonitorAccess>;'), true);
	assert.equal(source.includes('resolveDebugMonitorRequestId(event)'), true);
	assert.equal(source.includes('resolveDebugMarkerPlacement('), true);
	assert.equal(source.includes('buildDebugMonitorRequestUrl({'), true);
	assert.equal(source.includes('hostApi?.openDebugMonitorLink'), true);
	assert.equal(source.includes("window.open(targetUrl, '_blank', 'noopener,noreferrer');"), true);
	assert.equal(source.includes('closeDebugMonitorSocket();'), true);
	assert.equal(source.includes('clearDebugMonitorState();'), true);
	assert.equal(
		source.includes('return !activeDebugMonitorChatId || requestChatId === activeDebugMonitorChatId;'),
		true
	);
	assert.equal(source.includes('debugMarkersAfterMessageId = nextMarkersAfterMessageId;'), true);
	assert.equal(
		source.includes('debugMarkersAfterToolBlockByMessageId = nextMarkersAfterToolBlockByMessageId;'),
		true
	);
	assert.equal(source.includes('debugBackgroundMarkers = nextBackgroundMarkers;'), true);
	assert.equal(
		source.includes('debugMarkersAfterMessageId={debugModeEnabled ? debugMarkersAfterMessageId : {}}'),
		true
	);
	assert.equal(
		source.includes('debugMarkersAfterToolBlockByMessageId={debugModeEnabled'),
		true
	);
	assert.equal(
		source.includes('debugBackgroundMarkers={debugModeEnabled ? debugBackgroundMarkers : []}'),
		true
	);
});

test('chat navigation clears debug-monitor state before the next chat rehydrates', async () => {
	const source = await fs.readFile(CHAT_SVELTE_PATH, 'utf8');
	const navigateStart = source.indexOf('const navigateHandler = async () => {');
	const navigateEnd = source.indexOf('const onSelect = async', navigateStart);

	assert.notEqual(navigateStart, -1);
	assert.notEqual(navigateEnd, -1);

	const segment = source.slice(navigateStart, navigateEnd);
	assert.equal(segment.includes('closeDebugMonitorSocket();'), true);
	assert.equal(segment.includes('clearDebugMonitorState();'), true);
	assert.equal(
		segment.indexOf('closeDebugMonitorSocket();') < segment.indexOf('await loadChat(targetChatId, generation, abortController.signal)'),
		true
	);
	assert.equal(
		segment.indexOf('clearDebugMonitorState();') < segment.indexOf('await loadChat(targetChatId, generation, abortController.signal)'),
		true
	);
});

test('messages render anchored debug markers after messages, inline tool blocks, and background requests', async () => {
	const source = await fs.readFile(MESSAGES_SVELTE_PATH, 'utf8');

	assert.equal(source.includes("import DebugRequestMarker from './DebugRequestMarker.svelte';"), true);
	assert.equal(source.includes('export let debugMarkersAfterMessageId: Record<string, any[]> = {};'), true);
	assert.equal(
		source.includes(
			'export let debugMarkersAfterToolBlockByMessageId: Record<string, Record<number, any[]>> = {};'
		),
		true
	);
	assert.equal(source.includes('export let debugBackgroundMarkers: any[] = [];'), true);
	assert.equal(source.includes('export let openDebugRequestModal: (requestId: string) => void = () => {};'), true);
	assert.equal(source.includes('{#if debugMarkersAfterMessageId?.[message.id]?.length}'), true);
	assert.equal(source.includes('<DebugRequestMarker request={request} onInspect={openDebugRequestModal} />'), true);
	assert.equal(source.includes('{#if debugBackgroundMarkers?.length}'), true);
});

test('chat webview preload unwraps debug mode to a boolean for the embedded chat host API', async () => {
	const source = await fs.readFile(CHAT_WEBVIEW_PRELOAD_JS_PATH, 'utf8');

	assert.equal(source.includes("const result = await ipcRenderer.invoke('owui-get-debug-mode');"), true);
	assert.equal(
		source.includes("throw new Error(result?.error || 'Failed to get OWUI debug mode');"),
		true
	);
	assert.equal(source.includes('return Boolean(result.enabled);'), true);
});

test('assistant render path threads tool-block debug markers through every component layer', async () => {
	const [
		messageSource,
		multiResponseSource,
		responseSource,
		contentRendererSource,
		markdownSource,
		markdownTokensSource,
		toolBatchMarkersSource
	] = await Promise.all([
		fs.readFile(MESSAGE_SVELTE_PATH, 'utf8'),
		fs.readFile(MULTI_RESPONSE_MESSAGES_SVELTE_PATH, 'utf8'),
		fs.readFile(RESPONSE_MESSAGE_SVELTE_PATH, 'utf8'),
		fs.readFile(CONTENT_RENDERER_SVELTE_PATH, 'utf8'),
		fs.readFile(MARKDOWN_SVELTE_PATH, 'utf8'),
		fs.readFile(MARKDOWN_TOKENS_SVELTE_PATH, 'utf8'),
		fs.readFile(OWUI_TOOL_BATCH_MARKERS_TS_PATH, 'utf8')
	]);

	assert.equal(
		messageSource.includes(
			'debugMarkersAfterToolBlockIndex={debugMarkersAfterToolBlockByMessageId?.[messageId] ?? {}}'
		),
		true
	);
	assert.equal(messageSource.includes('{openDebugRequestModal}'), true);
	assert.equal(multiResponseSource.includes('debugMarkersAfterToolBlockIndex'), true);
	assert.equal(multiResponseSource.includes('{openDebugRequestModal}'), true);
	assert.equal(responseSource.includes('export let debugMarkersAfterToolBlockIndex: Record<number, any[]> = {};'), true);
	assert.equal(responseSource.includes('{debugMarkersAfterToolBlockIndex}'), true);
	assert.equal(contentRendererSource.includes('export let debugMarkersAfterToolBlockIndex: Record<number, any[]> = {};'), true);
	assert.equal(contentRendererSource.includes('{debugMarkersAfterToolBlockIndex}'), true);
	assert.equal(markdownSource.includes("import { annotateToolBatchTokens } from '$lib/utils/owuiToolBatchMarkers';"), true);
	assert.equal(markdownSource.includes('const allTokens = annotateToolBatchTokens('), true);
	assert.equal(markdownSource.includes('{debugMarkersAfterToolBlockIndex}'), true);
	assert.equal(markdownTokensSource.includes("{:else if token.type === 'details'}"), true);
	assert.equal(markdownTokensSource.includes('toolBlockIndex !== undefined && shouldRenderToolBlockMarker(token)'), true);
	assert.equal(markdownTokensSource.includes('renderSegmentToolBlockMarker'), true);
	assert.equal(markdownTokensSource.includes('getAnnotatedHtmlSegments(token)'), true);
	assert.equal(markdownTokensSource.includes('<DebugRequestMarker request={request} onInspect={openDebugRequestModal} />'), true);
	assert.equal(toolBatchMarkersSource.includes('const assignToolBatchToToken = (token: ToolBatchToken) => {'), true);
	assert.equal(toolBatchMarkersSource.includes('const assignToolBatchToSegment = (segment:'), true);
	assert.equal(toolBatchMarkersSource.includes('pendingToolCarrier.target.__owuiToolBlockTerminal = true;'), true);
});

test('debug marker placement keeps initial calls on the user turn and follow-ups inline after tool blocks', () => {
	const messageMap = {
		'user-1': { id: 'user-1', role: 'user', parentId: null },
		'assistant-1': { id: 'assistant-1', role: 'assistant', parentId: 'user-1' }
	};

	assert.deepEqual(
		owuiDebugMonitor.resolveDebugMarkerPlacement(
			{
				request_id: 'upstream-1',
				trigger_message_id: 'user-1',
				transcript_anchor_kind: 'user_message',
				transcript_anchor_message_id: 'user-1'
			},
			messageMap,
			['user-1', 'assistant-1']
		),
		{ kind: 'after_message', messageId: 'user-1' }
	);

	assert.deepEqual(
		owuiDebugMonitor.resolveDebugMarkerPlacement(
			{
				request_id: 'upstream-2',
				message_id: 'assistant-1',
				outer_message_id: 'assistant-1',
				request_phase: 'tool_followup',
				followup_index: 2,
				transcript_anchor_kind: 'assistant_tool_block',
				transcript_anchor_message_id: 'assistant-1',
				transcript_anchor_tool_block_index: 2
			},
			messageMap,
			['user-1', 'assistant-1']
		),
		{ kind: 'after_tool_block', messageId: 'assistant-1', toolBlockIndex: 2 }
	);

	assert.deepEqual(
		owuiDebugMonitor.resolveDebugMarkerPlacement(
			{
				request_id: 'upstream-bg',
				transcript_anchor_kind: 'background'
			},
			messageMap,
			['user-1', 'assistant-1']
		),
		{ kind: 'background' }
	);
});

test('debug request marker uses the requested visual treatment and exposes hover/click inspection affordances', async () => {
	const source = await fs.readFile(DEBUG_REQUEST_MARKER_SVELTE_PATH, 'utf8');

	assert.equal(source.includes("import MaybeTooltip from '$lib/components/common/MaybeTooltip.svelte';"), true);
	assert.equal(source.includes('aria-label="Inspect upstream request JSON"'), true);
	assert.equal(source.includes('background: linear-gradient(90deg, rgba(252, 165, 165, 0.86), rgba(254, 202, 202, 0.78));'), true);
	assert.equal(source.includes('on:click={() => onInspect(request.request_id)}'), true);
	assert.equal(source.includes('<MaybeTooltip content={tooltipText} placement="top">'), true);
});

test('electron debug mode and request modal sources are wired through the global bridge', async () => {
	const [indexJs, indexHtml, ipcJs, preloadJs, chatWebviewPreloadJs, bootstrapJs] = await Promise.all([
		fs.readFile(ELECTRON_RENDERER_INDEX_JS_PATH, 'utf8'),
		fs.readFile(ELECTRON_RENDERER_INDEX_HTML_PATH, 'utf8'),
		fs.readFile(ELECTRON_IPC_JS_PATH, 'utf8'),
		fs.readFile(ELECTRON_PRELOAD_JS_PATH, 'utf8'),
		fs.readFile(CHAT_WEBVIEW_PRELOAD_JS_PATH, 'utf8'),
		fs.readFile(ELECTRON_BOOTSTRAP_JS_PATH, 'utf8')
	]);

	assert.equal(indexHtml.includes('id="debug-mode-toggle"'), true);
	assert.equal(indexHtml.includes('id="debug-request-modal"'), true);
	assert.equal(indexJs.includes('const initialDebugMode = await window.electronAPI?.owui?.getDebugMode?.();'), true);
	assert.equal(indexJs.includes("setNativeOverlayInteractionSuppressed('debug-request-modal', true);"), true);
	assert.equal(indexJs.includes("if (event.key === 'Escape' && overlay.classList.contains('visible'))"), true);
	assert.equal(indexJs.includes("window.electronAPI.onOwuiDebugRequestModal((payload) => {"), true);
	assert.equal(indexJs.includes("window.electronAPI.onOwuiDebugModeChanged((payload) => {"), true);
	assert.equal(ipcJs.includes('ipcMain.handle("owui-set-debug-mode"'), true);
	assert.equal(ipcJs.includes('ipcMain.handle("owui-get-debug-mode"'), true);
	assert.equal(ipcJs.includes('ipcMain.handle("owui-get-debug-monitor-access"'), true);
	assert.equal(ipcJs.includes('ipcMain.handle("owui-open-debug-request-modal"'), true);
	assert.equal(ipcJs.includes('ipcMain.handle("owui-open-debug-monitor-link"'), true);
	assert.equal(ipcJs.includes('bootstrap.buildDebugMonitorUrl(url)'), true);
	assert.equal(ipcJs.includes('owuiViews.broadcastToViews("owui-debug-mode-changed", payload);'), true);
	assert.equal(ipcJs.includes('BrowserWindow.getAllWindows()'), true);
	assert.equal(preloadJs.includes('onOwuiDebugRequestModal: (callback) => {'), true);
	assert.equal(preloadJs.includes('onOwuiDebugModeChanged: (callback) => {'), true);
	assert.equal(preloadJs.includes('setDebugMode: async (enabled) => {'), true);
	assert.equal(preloadJs.includes('getDebugMode: async () => {'), true);
	assert.equal(chatWebviewPreloadJs.includes("window.dispatchEvent(new CustomEvent('owui-debug-mode-changed', { detail }))"), true);
	assert.equal(chatWebviewPreloadJs.includes('openDebugRequestModal,'), true);
	assert.equal(chatWebviewPreloadJs.includes('openDebugMonitorLink,'), true);
	assert.equal(chatWebviewPreloadJs.includes('getDebugMonitorAccess,'), true);
	assert.equal(chatWebviewPreloadJs.includes('getDebugMode,'), true);
	assert.equal(bootstrapJs.includes('runtimeSecrets.BIFROST_BRIDGE_LOCAL_API_KEY'), true);
	assert.equal(bootstrapJs.includes("url.searchParams.set('token', runtimeSecrets.LOCAL_STACK_API_KEY)"), false);
});
