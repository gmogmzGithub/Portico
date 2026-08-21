const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { build } = require('../electron-app/node_modules/esbuild');

const ROOT = path.resolve(__dirname, '..');

let tempDir;
let buildForkedHistory;
let buildForkedChatPayload;

before(async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-fork-'));
	const outfile = path.join(tempDir, 'chat-fork.cjs');
	await build({
		entryPoints: [path.join(ROOT, 'src/patches/frontend/src/lib/utils/chatFork.ts')],
		bundle: true,
		format: 'cjs',
		platform: 'node',
		target: ['node20'],
		logLevel: 'silent',
		outfile
	});
	({ buildForkedHistory, buildForkedChatPayload } = require(outfile));
});

after(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

const makeMessage = (id, parentId, childrenIds, extra = {}) => ({
	id,
	parentId,
	childrenIds,
	role: id.startsWith('u') ? 'user' : 'assistant',
	content: `content of ${id}`,
	done: true,
	...extra
});

// u1 ── a1 (regenerated sibling, dropped)
//    └─ a2 ── u2 ── a3 ── u3 ── a4   (fork at a3 keeps u1→a2→u2→a3)
const makeBranchyHistory = () => ({
	messages: {
		u1: makeMessage('u1', null, ['a1', 'a2']),
		a1: makeMessage('a1', 'u1', []),
		a2: makeMessage('a2', 'u1', ['u2'], {
			contentBlocks: [{ type: 'text', text: 'hello' }]
		}),
		u2: makeMessage('u2', 'a2', ['a3']),
		a3: makeMessage('a3', 'u2', ['u3']),
		u3: makeMessage('u3', 'a3', ['a4']),
		a4: makeMessage('a4', 'u3', [])
	},
	currentId: 'a4'
});

test('forking mid-tree keeps only the visible path up to the message', () => {
	const history = makeBranchyHistory();
	const fork = buildForkedHistory(history, 'a3');

	assert.ok(fork);
	assert.deepEqual(fork.messageIds, ['u1', 'a2', 'u2', 'a3']);
	assert.deepEqual(Object.keys(fork.history.messages).sort(), ['a2', 'a3', 'u1', 'u2']);
	assert.equal(fork.history.currentId, 'a3');
	assert.deepEqual(fork.history.messages.u1.childrenIds, ['a2']);
	assert.deepEqual(fork.history.messages.a2.childrenIds, ['u2']);
	assert.deepEqual(fork.history.messages.u2.childrenIds, ['a3']);
	assert.deepEqual(fork.history.messages.a3.childrenIds, []);
});

test('the source history is never mutated and fork copies are isolated', () => {
	const history = makeBranchyHistory();
	const snapshot = JSON.parse(JSON.stringify(history));

	const fork = buildForkedHistory(history, 'a3');
	assert.deepEqual(history, snapshot);

	fork.history.messages.a2.content = 'mutated';
	fork.history.messages.a2.contentBlocks[0].text = 'mutated';
	fork.history.messages.u1.childrenIds.push('a1');
	assert.deepEqual(history, snapshot);
});

test('multi-model turns collapse onto the kept branch model', () => {
	const history = {
		messages: {
			u1: makeMessage('u1', null, ['a1', 'a2'], { models: ['model-a', 'model-b'] }),
			a1: makeMessage('a1', 'u1', [], { model: 'model-a', modelIdx: 0 }),
			a2: makeMessage('a2', 'u1', [], { model: 'model-b', modelIdx: 1 })
		},
		currentId: 'a2'
	};
	const snapshot = JSON.parse(JSON.stringify(history));

	const fork = buildForkedHistory(history, 'a2');
	assert.deepEqual(fork.history.messages.u1.models, ['model-b']);
	assert.equal(fork.history.messages.a2.modelIdx, 0);
	assert.deepEqual(history, snapshot);
});

test('payload carries provenance, linear messages, and pass-through fields', () => {
	const history = makeBranchyHistory();
	const payload = buildForkedChatPayload({
		history,
		messageId: 'a3',
		id: 'fork-id',
		title: 'Fork of Original',
		models: ['model-a'],
		system: 'be terse',
		params: { temperature: 0.2 },
		files: [{ id: 'file-1' }],
		sourceChatId: 'chat-1',
		timestamp: 1234567890
	});

	assert.ok(payload);
	assert.equal(payload.id, 'fork-id');
	assert.equal(payload.title, 'Fork of Original');
	assert.deepEqual(payload.models, ['model-a']);
	assert.equal(payload.system, 'be terse');
	assert.deepEqual(payload.params, { temperature: 0.2 });
	assert.deepEqual(payload.files, [{ id: 'file-1' }]);
	assert.deepEqual(payload.tags, []);
	assert.equal(payload.timestamp, 1234567890);
	assert.equal(payload.originalChatId, 'chat-1');
	assert.equal(payload.branchPointMessageId, 'a3');
	assert.equal(payload.history.currentId, 'a3');
	assert.deepEqual(
		payload.messages.map((message) => message.id),
		['u1', 'a2', 'u2', 'a3']
	);
});

test('system is omitted when not provided', () => {
	const payload = buildForkedChatPayload({
		history: makeBranchyHistory(),
		messageId: 'a2',
		id: 'fork-id',
		title: 'Fork',
		models: [],
		params: {},
		files: [],
		sourceChatId: 'chat-1',
		timestamp: 1
	});

	assert.ok(payload);
	assert.equal('system' in payload, false);
});

test('degenerate inputs fail closed', () => {
	assert.equal(buildForkedHistory(null, 'a1'), null);
	assert.equal(buildForkedHistory({ messages: {} }, 'a1'), null);
	assert.equal(buildForkedHistory(makeBranchyHistory(), 'ghost'), null);

	const cyclic = {
		messages: {
			m1: makeMessage('m1', 'm2', ['m2']),
			m2: makeMessage('m2', 'm1', ['m1'])
		},
		currentId: 'm1'
	};
	assert.equal(buildForkedHistory(cyclic, 'm1'), null);

	assert.equal(
		buildForkedChatPayload({
			history: null,
			messageId: 'a1',
			id: 'x',
			title: 'x',
			timestamp: 1
		}),
		null
	);
});

test('a dangling parentId truncates to a best-effort root', () => {
	const history = {
		messages: {
			a2: makeMessage('a2', 'ghost-parent', [])
		},
		currentId: 'a2'
	};

	const fork = buildForkedHistory(history, 'a2');
	assert.ok(fork);
	assert.deepEqual(fork.messageIds, ['a2']);
	assert.deepEqual(fork.history.messages.a2.childrenIds, []);
	assert.equal(fork.history.currentId, 'a2');
});
