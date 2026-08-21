const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { build } = require('../electron-app/node_modules/esbuild');

const REPO_ROOT = path.resolve(__dirname, '..');
const STATUS_ITEM_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/Messages/ResponseMessage/StatusHistory/StatusItem.svelte'
);

let tempDir;
let chatStatusHistory;

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
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-status-history-tests-'));
	chatStatusHistory = await bundleModule(
		'src/patches/frontend/src/lib/utils/chatStatusHistory.ts',
		path.join(tempDir, 'chatStatusHistory.cjs')
	);
});

after(async () => {
	if (tempDir) {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test('appends ordinary status events without a status key', () => {
	const nextHistory = chatStatusHistory.upsertStatusHistoryEntry(
		[{ action: 'web_search', description: 'Searching the web', done: false }],
		{ action: 'web_search', description: 'Searched 3 sites', done: true }
	);

	assert.deepEqual(nextHistory, [
		{ action: 'web_search', description: 'Searching the web', done: false },
		{ action: 'web_search', description: 'Searched 3 sites', done: true }
	]);
});

test('replaces retry status events that share a status key', () => {
	const nextHistory = chatStatusHistory.upsertStatusHistoryEntry(
		[
			{
				action: 'upstream_retry',
				status_key: 'upstream_retry',
				description: 'Model provider stalled; retrying (attempt 1/4)',
				done: false
			}
		],
		{
			action: 'upstream_retry',
			status_key: 'upstream_retry',
			description: 'Model provider stalled; retrying (attempt 2/4)',
			done: false
		}
	);

	assert.deepEqual(nextHistory, [
		{
			action: 'upstream_retry',
			status_key: 'upstream_retry',
			description: 'Model provider stalled; retrying (attempt 2/4)',
			done: false
		}
	]);
});

test('removes an existing keyed status when a hidden completion arrives', () => {
	const nextHistory = chatStatusHistory.upsertStatusHistoryEntry(
		[
			{
				action: 'upstream_retry',
				status_key: 'upstream_retry',
				description: 'Model provider stalled; retrying (attempt 2/4)',
				done: false
			},
			{ action: 'web_search', description: 'Searched 3 sites', done: true }
		],
		{
			action: 'upstream_retry',
			status_key: 'upstream_retry',
			description: 'Recovered after upstream retry',
			done: true,
			hidden: true
		}
	);

	assert.deepEqual(nextHistory, [
		{ action: 'web_search', description: 'Searched 3 sites', done: true }
	]);
});

test('partitions ordinary statuses into the top render bucket', () => {
	const partitions = chatStatusHistory.partitionStatusHistory([
		{ action: 'web_search', description: 'Searching', done: false },
		{ action: 'knowledge_search', description: 'Reading docs', done: true }
	]);

	assert.deepEqual(partitions, {
		top: [
			{ action: 'web_search', description: 'Searching', done: false },
			{ action: 'knowledge_search', description: 'Reading docs', done: true }
		],
		bottom: []
	});
});

test('partitions upstream retry statuses into the bottom render bucket', () => {
	const partitions = chatStatusHistory.partitionStatusHistory([
		{ action: 'web_search', description: 'Searching', done: false },
		{
			action: 'upstream_retry',
			status_key: 'upstream_retry',
			description: 'Model provider stalled; retrying (attempt 1/8)',
			done: false
		},
		{
			action: 'upstream_retry',
			description: 'Model provider did not recover after retries',
			done: true,
			error: true
		}
	]);

	assert.deepEqual(partitions, {
		top: [{ action: 'web_search', description: 'Searching', done: false }],
		bottom: [
			{
				action: 'upstream_retry',
				status_key: 'upstream_retry',
				description: 'Model provider stalled; retrying (attempt 1/8)',
				done: false
			},
			{
				action: 'upstream_retry',
				description: 'Model provider did not recover after retries',
				done: true,
				error: true
			}
		]
	});
});

test('hidden upstream retry recovery entries stay removed before partitioning', () => {
	const nextHistory = chatStatusHistory.upsertStatusHistoryEntry(
		[
			{
				action: 'upstream_retry',
				status_key: 'upstream_retry',
				description: 'Model provider stalled; retrying (attempt 1/8)',
				done: false
			}
		],
		{
			action: 'upstream_retry',
			status_key: 'upstream_retry',
			description: 'Recovered after upstream retry',
			done: true,
			hidden: true
		}
	);

	assert.deepEqual(chatStatusHistory.partitionStatusHistory(nextHistory), {
		top: [],
		bottom: []
	});
});

test('terminal upstream retry error status uses darker light-mode text', async () => {
	const source = await fs.readFile(STATUS_ITEM_PATH, 'utf8');

	assert.match(source, /status\?\.action === UPSTREAM_RETRY_STATUS_KEY/);
	assert.match(source, /status\?\.status_key === UPSTREAM_RETRY_STATUS_KEY/);
	assert.match(source, /status\?\.done === true/);
	assert.match(source, /status\?\.error === true/);
	assert.match(source, /text-gray-700 dark:text-gray-400/);
	assert.match(source, /text-gray-500 dark:text-gray-500/);
});
