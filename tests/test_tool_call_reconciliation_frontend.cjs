const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { build } = require('../electron-app/node_modules/esbuild');

const REPO_ROOT = path.resolve(__dirname, '..');
let tempDir;
let reconciliation;

before(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-call-reconciliation-tests-'));
	const outfile = path.join(tempDir, 'toolCallReconciliation.cjs');
	await build({
		entryPoints: [
			path.join(
				REPO_ROOT,
				'src/patches/frontend/src/lib/utils/toolCallReconciliation.ts'
			)
		],
		bundle: true,
		format: 'cjs',
		platform: 'node',
		target: ['node20'],
		logLevel: 'silent',
		outfile
	});
	reconciliation = require(outfile);
});

after(async () => {
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

test('deduplicates the same execution id across payload and content block sources', () => {
	const result = reconciliation.reconcileRecordedToolCalls(
		[{ id: 'call-1', function: { name: 'agent_vm_bash', arguments: '{}' } }],
		[{ id: 'call-1', function: { name: 'agent_vm_bash' }, result: { ok: true } }],
		[{ id: 'call-1', duration: 1 }]
	);

	assert.deepEqual(result, [
		{
			id: 'call-1',
			function: { name: 'agent_vm_bash', arguments: '{}' },
			result: { ok: true },
			duration: 1
		}
	]);
});

test('preserves distinct execution ids in first-seen order', () => {
	const result = reconciliation.reconcileRecordedToolCalls(
		[{ id: 'call-1' }, { id: 'call-2' }],
		[{ id: 'call-2' }],
		[{ id: 'call-1' }]
	);

	assert.deepEqual(result, [{ id: 'call-1' }, { id: 'call-2' }]);
});

test('collapses identical id-less calls only across overlapping sources', () => {
	const call = { function: { name: 'legacy_tool', arguments: '{"value":1}' } };
	const result = reconciliation.reconcileRecordedToolCalls(
		[call, call],
		[{ ...call }, { ...call }],
		[{ ...call }, { ...call }]
	);

	assert.equal(result.length, 2);
});

test('detects same-length tool call arrays with different executions', () => {
	assert.equal(
		reconciliation.recordedToolCallArraysEqual([{ id: 'call-1' }], [{ id: 'call-2' }]),
		false
	);
});
