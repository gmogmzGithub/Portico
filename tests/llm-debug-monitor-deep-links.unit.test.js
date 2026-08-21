const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { build } = require('../electron-app/node_modules/esbuild');

const REPO_ROOT = path.resolve(__dirname, '..');
const APP_TSX_PATH = path.join(REPO_ROOT, 'llm-debug-monitor/src/App.tsx');
const SIDEBAR_TSX_PATH = path.join(
	REPO_ROOT,
	'llm-debug-monitor/src/components/Layout/Sidebar.tsx'
);
const REQUEST_CARD_TSX_PATH = path.join(
	REPO_ROOT,
	'llm-debug-monitor/src/components/RequestTimeline/RequestCard.tsx'
);
const REQUEST_TIMELINE_TSX_PATH = path.join(
	REPO_ROOT,
	'llm-debug-monitor/src/components/RequestTimeline/RequestTimeline.tsx'
);
const DEEP_LINK_HOOK_TS_PATH = path.join(
	REPO_ROOT,
	'llm-debug-monitor/src/hooks/useMonitorDeepLinkNavigation.ts'
);
const API_MONITOR_TS_PATH = path.join(REPO_ROOT, 'llm-debug-monitor/src/api/monitor.ts');

let tempDir;
let deepLinkUtils;

async function bundleModule(entryPath, outFile) {
	await build({
		entryPoints: [path.join(REPO_ROOT, entryPath)],
		bundle: true,
		format: 'cjs',
		platform: 'node',
		target: ['node20'],
		logLevel: 'silent',
		tsconfig: path.join(REPO_ROOT, 'llm-debug-monitor/tsconfig.json'),
		outfile: outFile
	});
	return require(outFile);
}

before(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-debug-monitor-deep-links-'));
	deepLinkUtils = await bundleModule(
		'llm-debug-monitor/src/utils/monitorDeepLinks.ts',
		path.join(tempDir, 'monitorDeepLinks.cjs')
	);
});

after(async () => {
	if (tempDir) {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test('monitor deep-link utility parses chat, request, session, and sidebar params', () => {
	const parsed = deepLinkUtils.parseMonitorDeepLinkSearch(
		'?session=session-1&chat=chat-1&request=req-1&sidebar=hidden'
	);

	assert.deepEqual(parsed, {
		sessionId: 'session-1',
		chatId: 'chat-1',
		requestId: 'req-1',
		sidebar: 'hidden'
	});
});

test('monitor deep-link utility hides the sidebar by default for explicit chat or request links', () => {
	assert.equal(
		deepLinkUtils.shouldDefaultSidebarHiddenForDeepLink({
			chatId: 'chat-1'
		}),
		true
	);
	assert.equal(
		deepLinkUtils.shouldDefaultSidebarHiddenForDeepLink({
			requestId: 'req-1',
			sidebar: 'visible'
		}),
		false
	);
	assert.equal(
		deepLinkUtils.shouldDefaultSidebarHiddenForDeepLink({}),
		false
	);
});

test('monitor deep-link utility builds shareable request URLs with optional chat scope', () => {
	const url = deepLinkUtils.buildMonitorDeepLinkUrl('http://localhost:8879/', {
		sessionId: 'session-1',
		chatId: 'chat-1',
		requestId: 'req-1'
	});

	assert.equal(
		url,
		'http://localhost:8879/?session=session-1&chat=chat-1&request=req-1'
	);
});

test('monitor deep-link utility selects the earliest request for a chat', () => {
	const requestId = deepLinkUtils.getFirstRequestIdForChat([
		{ request_id: 'req-2', timestamp: '2026-03-27T10:00:02Z' },
		{ request_id: 'req-1', timestamp: '2026-03-27T10:00:00Z' },
		{ request_id: 'req-3', timestamp: '2026-03-27T10:00:01Z' }
	]);

	assert.equal(requestId, 'req-1');
});

test('monitor app source wires deep-link navigation, request ids, scroll-to-selection, and sidebar collapse controls', async () => {
	const [appSource, sidebarSource, requestCardSource, requestTimelineSource, deepLinkHookSource, apiSource] =
		await Promise.all([
			fs.readFile(APP_TSX_PATH, 'utf8'),
			fs.readFile(SIDEBAR_TSX_PATH, 'utf8'),
			fs.readFile(REQUEST_CARD_TSX_PATH, 'utf8'),
			fs.readFile(REQUEST_TIMELINE_TSX_PATH, 'utf8'),
			fs.readFile(DEEP_LINK_HOOK_TS_PATH, 'utf8'),
			fs.readFile(API_MONITOR_TS_PATH, 'utf8')
		]);

	assert.equal(appSource.includes('useMonitorDeepLinkNavigation(sessionId)'), true);
	assert.equal(appSource.includes('collapsible'), true);
	assert.equal(appSource.includes('collapsedSize={0}'), true);
	assert.equal(appSource.includes('Show active chats pane'), true);
	assert.equal(sidebarSource.includes('Hide active chats pane'), true);
	assert.equal(requestCardSource.includes('Request ID'), true);
	assert.equal(requestCardSource.includes('data-request-card-id={request.request_id}'), true);
	assert.equal(requestTimelineSource.includes('scrollIntoView({ block: \'nearest\' })'), true);
	assert.equal(deepLinkHookSource.includes('fetchChatRequests(resolvedChatId)'), true);
	assert.equal(deepLinkHookSource.includes('fetchRequestDetail(nextState.requestId)'), true);
	assert.equal(deepLinkHookSource.includes('fetchRequestDetail(selectedRequestId)'), true);
	assert.equal(deepLinkHookSource.includes('selectedRequest && selectedRequest.messages.length > 0'), true);
	assert.equal(deepLinkHookSource.includes('getFirstRequestIdForChat(requests) || null'), true);
	assert.equal(deepLinkHookSource.includes("window.history.replaceState({}, '', normalizedUrl);"), true);
	assert.equal(apiSource.includes("'X-Debug-Monitor-Token': token"), true);
	assert.equal(apiSource.includes('getDebugMonitorFetchOptions()'), true);
});
