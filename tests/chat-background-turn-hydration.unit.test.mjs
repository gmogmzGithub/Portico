// Behavioral tests for the tile hydration hardenings: freshly-started chats
// race their first queued-prompt dispatch against the tile's initial load and
// can miss earlier socket events entirely. Extract-and-exec of the real
// Chat.svelte helpers — no source-pin regex assertions.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chatPath = path.join(
	repoRoot,
	'src/patches/frontend/src/lib/components/chat/Chat.svelte'
);
const require = createRequire(import.meta.url);
const { transformSync } = require('../electron-app/node_modules/esbuild');

const block = (source, startMarker, endMarker) => {
	const start = source.indexOf(startMarker);
	assert.notEqual(start, -1, `missing ${startMarker}`);
	const end = source.indexOf(endMarker, start + startMarker.length);
	assert.notEqual(end, -1, `missing ${endMarker}`);
	return source.slice(start, end);
};

const source = await fs.readFile(chatPath, 'utf8');

const turnPayload = ({ userId, parentId, assistantId }) => ({
	userMessageId: userId,
	assistantMessageIds: [assistantId],
	insertedUserMessage: {
		id: userId,
		parentId,
		childrenIds: [assistantId],
		role: 'user',
		content: `prompt ${userId}`
	},
	insertedAssistantMessages: [
		{ id: assistantId, parentId: userId, childrenIds: [], role: 'assistant', content: '' }
	],
	insertedCurrentId: assistantId
});

const buildRepairHarness = (payloads) => {
	const extracted = block(
		source,
		'const hydrateBackgroundTurnMessagesIntoHistory = ',
		'\n\n\tconst syncHistoryWithBackend'
	);
	const { code } = transformSync(extracted, { loader: 'ts' });
	const payloadMap = new Map();
	for (const payload of payloads) {
		for (const id of [payload.userMessageId, ...payload.assistantMessageIds]) {
			payloadMap.set(id, payload);
		}
	}
	const deps = {
		cloneSerializableValue: (value) => JSON.parse(JSON.stringify(value)),
		backgroundTurnInsertionPayloadsByMessageId: payloadMap,
		console: { warn: () => {} }
	};
	const factory = new Function(
		'deps',
		`with (deps) { ${code}; return repairProtectedBackgroundTurnHistoryWithStoredPayloads; }`
	);
	return factory(deps);
};

test('initial-load repair merges a whole remembered turn the snapshot missed', () => {
	const repair = buildRepairHarness([
		turnPayload({ userId: 'u1', parentId: null, assistantId: 'a1' })
	]);

	// Snapshot fetched before the first dispatch committed: empty history.
	const staleSnapshot = { messages: {}, currentId: null };

	// Default (sync path) keeps the conservative gate: assistant not persisted
	// in the snapshot means no resurrection.
	const conservative = repair(staleSnapshot);
	assert.equal(conservative.repaired, false);
	assert.deepEqual(Object.keys(conservative.history.messages), []);

	// Initial-load mode merges the remembered turn instead of clobbering it.
	const repaired = repair(staleSnapshot, { requirePersistedAssistant: false });
	assert.equal(repaired.repaired, true);
	assert.ok(repaired.history.messages.u1);
	assert.ok(repaired.history.messages.a1);
	assert.equal(repaired.history.currentId, 'a1');
});

test('repair never duplicates turns the snapshot already has', () => {
	const repair = buildRepairHarness([
		turnPayload({ userId: 'u1', parentId: null, assistantId: 'a1' })
	]);
	const completeSnapshot = {
		currentId: 'a1',
		messages: {
			u1: { id: 'u1', parentId: null, childrenIds: ['a1'], role: 'user', content: 'x' },
			a1: { id: 'a1', parentId: 'u1', childrenIds: [], role: 'assistant', content: 'y' }
		}
	};
	const result = repair(completeSnapshot, { requirePersistedAssistant: false });
	assert.equal(result.repaired, false);
	assert.equal(result.history.messages.u1.content, 'x');
});

test('insertion ancestry gap routes to full sync instead of hydrating a hole', () => {
	// The gap predicate lives inline in reconcileBackgroundTurnInsertion —
	// exec the decision slice with both local-history shapes.
	const slice = block(
		source,
		'const insertedParentId =',
		'\n\n\t\tif (nextHistory) {'
	);
	const { code } = transformSync(slice, { loader: 'ts' });
	const run = ({ history, insertedUserMessage }) => {
		const deps = {
			history,
			insertedUserMessage,
			insertedAssistantMessages: [],
			insertedCurrentId: 'a2',
			hydrateBackgroundTurnMessagesIntoHistory: () => ({ hydrated: true })
		};
		const factory = new Function(
			'deps',
			`with (deps) { ${code}; return { hasAncestryGap, nextHistory }; }`
		);
		return factory(deps);
	};

	// Round-2 insertion whose parent (round-1 assistant) was never seen: gap →
	// no local hydration (the caller's sync branch takes over).
	const gapped = run({
		history: { messages: {} },
		insertedUserMessage: { id: 'u2', parentId: 'a1', childrenIds: [] }
	});
	assert.equal(gapped.hasAncestryGap, true);
	assert.equal(gapped.nextHistory, null);

	// Same insertion with the parent present hydrates locally as before.
	const linked = run({
		history: { messages: { a1: { id: 'a1' } } },
		insertedUserMessage: { id: 'u2', parentId: 'a1', childrenIds: [] }
	});
	assert.equal(linked.hasAncestryGap, false);
	assert.deepEqual(linked.nextHistory, { hydrated: true });

	// A root turn (no parent) never reads as a gap — empty tiles must still
	// hydrate their first turn locally.
	const root = run({
		history: { messages: {} },
		insertedUserMessage: { id: 'u1', parentId: null, childrenIds: [] }
	});
	assert.equal(root.hasAncestryGap, false);
	assert.deepEqual(root.nextHistory, { hydrated: true });
});
