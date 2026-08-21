const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { build } = require('../electron-app/node_modules/esbuild');

const ROOT = path.resolve(__dirname, '..');
const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), 'utf8');
const makeRows = (prefix, count, start = 1) =>
	Array.from({ length: count }, (_, index) => ({
		id: `${prefix}-${start + index}`,
		title: `${prefix} ${start + index}`
	}));

let tempDir;
let createChatListPaginationController;

before(async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-list-pagination-'));
	const outfile = path.join(tempDir, 'chat-list-pagination-core.cjs');
	await build({
		entryPoints: [
			path.join(
				ROOT,
				'src/patches/frontend/src/lib/utils/chatListPaginationCore.ts'
			)
		],
		bundle: true,
		format: 'cjs',
		platform: 'node',
		target: ['node20'],
		logLevel: 'silent',
		outfile
	});
	({ createChatListPaginationController } = require(outfile));
});

after(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

const createHarness = (fetchPage) => {
	let rows = [];
	let committedPage = 0;
	const controller = createChatListPaginationController({
		fetchPage,
		readRows: () => rows,
		replaceRows: (nextRows) => {
			rows = nextRows;
		},
		setCommittedPage: (page) => {
			committedPage = page;
		}
	});
	return {
		controller,
		getRows: () => rows,
		getCommittedPage: () => committedPage
	};
};

test('page one replaces and subsequent pages append all 73 chats', async () => {
	const firstPage = makeRows('chat', 60);
	const secondPage = makeRows('chat', 13, 61);
	const calls = [];
	const harness = createHarness(async (_token, page) => {
		calls.push(page);
		return page === 1 ? firstPage : page === 2 ? secondPage : [];
	});

	await harness.controller.refreshPageOne('token');
	assert.equal(harness.getRows().length, 60);
	assert.equal(harness.getCommittedPage(), 1);

	await harness.controller.appendNextPage('token');
	assert.equal(harness.getRows().length, 73);
	assert.equal(new Set(harness.getRows().map((row) => row.id)).size, 73);
	assert.equal(harness.getCommittedPage(), 2);
	assert.equal(harness.controller.getState().exhausted, false);

	await harness.controller.appendNextPage('token');
	assert.equal(harness.getRows().length, 73);
	assert.equal(harness.getCommittedPage(), 3);
	assert.equal(harness.controller.getState().exhausted, true);
	assert.deepEqual(calls, [1, 2, 3]);
});

test('refreshing after page two can only replace with page one', async () => {
	const firstPage = makeRows('chat', 60);
	const secondPage = makeRows('chat', 13, 61);
	const harness = createHarness(async (_token, page) =>
		page === 1 ? firstPage : page === 2 ? secondPage : []
	);

	await harness.controller.refreshPageOne('token');
	await harness.controller.appendNextPage('token');
	assert.equal(harness.getRows().length, 73);

	await harness.controller.refreshPageOne('token');
	assert.deepEqual(harness.getRows(), firstPage);
	assert.equal(harness.getCommittedPage(), 1);
	assert.equal(harness.controller.getState().exhausted, false);

	await harness.controller.appendNextPage('token');
	assert.equal(harness.getRows().length, 73);
});

test('a delayed append is ignored after a newer page-one generation starts', async () => {
	const initialPage = makeRows('initial', 60);
	const refreshedPage = makeRows('refreshed', 60);
	const delayedPage = makeRows('initial', 13, 61);
	let pageOne = initialPage;
	let resolvePageTwo;
	const pageTwo = new Promise((resolve) => {
		resolvePageTwo = resolve;
	});
	const harness = createHarness(async (_token, page) => (page === 1 ? pageOne : pageTwo));

	await harness.controller.refreshPageOne('token');
	const appendPromise = harness.controller.appendNextPage('token');
	pageOne = refreshedPage;
	await harness.controller.refreshPageOne('token');
	resolvePageTwo(delayedPage);

	const appendResult = await appendPromise;
	assert.equal(appendResult.status, 'stale');
	assert.deepEqual(harness.getRows(), refreshedPage);
	assert.equal(harness.getCommittedPage(), 1);
});

test('transient refresh failures preserve rows and retry explicit page one', async () => {
	const firstPage = makeRows('chat', 60);
	const secondPage = makeRows('chat', 13, 61);
	const calls = [];
	let failPageOne = false;
	const harness = createHarness(async (_token, page) => {
		calls.push(page);
		if (page === 1 && failPageOne) throw new Error('temporary failure');
		return page === 1 ? firstPage : page === 2 ? secondPage : [];
	});

	await harness.controller.refreshPageOne('token');
	await harness.controller.appendNextPage('token');
	assert.equal(harness.getRows().length, 73);

	failPageOne = true;
	await assert.rejects(harness.controller.refreshPageOne('token'), /temporary failure/);
	assert.equal(harness.getRows().length, 73);
	assert.equal(harness.getCommittedPage(), 2);
	assert.equal(harness.controller.getState().loadingInitial, false);
	assert.equal(harness.controller.getState().exhausted, false);

	failPageOne = false;
	await harness.controller.refreshPageOne('token');
	assert.equal(calls.at(-1), 1);
	assert.equal(harness.getRows().length, 60);
	assert.equal(harness.getCommittedPage(), 1);
	await harness.controller.appendNextPage('token');
	assert.equal(harness.getRows().length, 73);
});

test('concurrent append requests share one fetch and de-duplicate rows', async () => {
	const firstPage = makeRows('chat', 60);
	const secondPage = [...makeRows('chat', 13, 61), firstPage[0]];
	let pageTwoFetches = 0;
	let resolvePageTwo;
	const pageTwo = new Promise((resolve) => {
		resolvePageTwo = resolve;
	});
	const harness = createHarness(async (_token, page) => {
		if (page === 1) return firstPage;
		pageTwoFetches += 1;
		return pageTwo;
	});

	await harness.controller.refreshPageOne('token');
	const firstAppend = harness.controller.appendNextPage('token');
	const duplicateAppend = harness.controller.appendNextPage('token');
	assert.equal(firstAppend, duplicateAppend);
	assert.equal(pageTwoFetches, 1);
	resolvePageTwo(secondPage);
	await Promise.all([firstAppend, duplicateAppend]);

	assert.equal(harness.getRows().length, 73);
	assert.equal(new Set(harness.getRows().map((row) => row.id)).size, 73);
});

test('components cannot replace chat rows using a mutable current page', () => {
	const componentPaths = [
		['src', 'patches', 'frontend', 'src', 'lib', 'components', 'layout', 'Sidebar.svelte'],
		['src', 'patches', 'frontend', 'src', 'lib', 'components', 'chat', 'Chat.svelte'],
		['src', 'patches', 'frontend', 'src', 'lib', 'components', 'chat', 'Placeholder.svelte'],
		['src', 'patches', 'frontend', 'src', 'lib', 'components', 'chat', 'Messages.svelte'],
		[
			'src',
			'patches',
			'frontend',
			'src',
			'lib',
			'components',
			'layout',
			'Sidebar',
			'ChatItem.svelte'
		]
	];

	for (const segments of componentPaths) {
		const source = read(...segments);
		assert.doesNotMatch(source, /getChatList\([^\n]*currentChatPage/);
		assert.doesNotMatch(source, /currentChatPage\.set\(/);
		assert.match(source, /refreshChatListPageOne/);
	}

	const sidebar = read(...componentPaths[0]);
	assert.match(sidebar, /appendNextChatListPage/);
	assert.match(sidebar, /chatListPaginationState/);
});
