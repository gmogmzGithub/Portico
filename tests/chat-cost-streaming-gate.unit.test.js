// Round-10 pins for the patched OWUI frontend:
// 1) Live cost tracking works in brand-new chats: initNewChat flips the
//    chatFirstPaintReady gate (new chats never run navigateHandler — the first
//    turn only replaceState()s the URL, so nothing else ever sets the flag and
//    the cost pill stayed $0.00 until the chat was reopened), and
// 2) the chat-load perf gates from 1f6768fbd stay in place for loaded chats
//    (cost + turn-summary refreshes are deferred until first paint), and
// 3) the reasoning-effort picker's chevron keeps a wider grid track so wide
//    labels ("Extra High") don't run flush against it.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..');
const CHAT_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/Chat.svelte'
);
const APP_CSS_PATH = path.join(REPO_ROOT, 'src/patches/frontend/src/app.css');

test('initNewChat marks first paint ready so new-chat cost refreshes are not gated off', async () => {
	const chat = await fs.readFile(CHAT_PATH, 'utf8');

	// The flip is the FIRST statement of initNewChat (before the non-admin
	// temporary-chat early return): it must immediately precede the function's
	// original first assignment, not merely appear somewhere in the body.
	assert.match(
		chat,
		/const initNewChat = async \(\) => \{[\s\S]{0,600}?chatFirstPaintReady = true;\s*urlSelectedModelResolutionFailed = false;/,
		'initNewChat must set chatFirstPaintReady = true before any early return'
	);

	// The load path still sets the flag on first paint (reportChatLoadReady)…
	assert.match(chat, /const reportChatLoadReady = async[\s\S]{0,300}?chatFirstPaintReady = true;/);
	// …and navigateHandler still re-arms the gate when switching to a loaded
	// chat (deleting the reset would silently disable the chat-load perf gate).
	assert.match(chat, /chatFirstPaintReady = false;/);
});

test('the chat-load perf gates stay intact for loaded chats', async () => {
	const chat = await fs.readFile(CHAT_PATH, 'utf8');

	// Aggregate cost refresh defers until first paint…
	assert.match(
		chat,
		/if \(!chatFirstPaintReady\) \{\s*clearAggregateCostRefreshTimer\(\);\s*return;\s*\}/,
		'cost refresh must keep its first-paint gate'
	);
	// …and so does the context turn summary refresh.
	assert.match(
		chat,
		/if \(!chatFirstPaintReady\) \{\s*clearContextTurnSummaryRefreshTimer\(\);\s*return;\s*\}/,
		'turn-summary refresh must keep its first-paint gate'
	);
});

test('unpersisted local: temporary chats never schedule host cost/summary fetches', async () => {
	const chat = await fs.readFile(CHAT_PATH, 'utf8');

	// With the first-paint gate now open during new chats, the schedulers must
	// still skip local: ids — webui.db never has rows for temporary chats, so
	// those refreshes would be pure wasted IPC on a perf-hot path.
	assert.match(
		chat,
		/if \(!currentChatId \|\| currentChatId\.startsWith\('local:'\)\) \{\s*clearAggregateCostRefreshTimer\(\);/,
		'cost scheduler must skip local: temporary chats'
	);
	assert.match(
		chat,
		/if \(!currentChatId \|\| currentChatId\.startsWith\('local:'\) \|\| !currentMessageId\) \{\s*clearContextTurnSummaryRefreshTimer\(\);/,
		'turn-summary scheduler must skip local: temporary chats'
	);
});

test('the snowflake visual-cue assets stay wide enough for the --large tooltip variant', async () => {
	// The sensitive-info tooltip renders --large only when naturalWidth > 600;
	// both round-9/10 replacement screenshots must keep that width.
	for (const rel of [
		'skills/snowflake-setup/assets/token-name-field.png',
		'skills/snowflake-setup/assets/generate-token-generate-button.png'
	]) {
		const buf = await fs.readFile(path.join(REPO_ROOT, rel));
		// PNG IHDR: width is the big-endian u32 at byte offset 16.
		const width = buf.readUInt32BE(16);
		assert.ok(width > 600, `${rel} width ${width} must exceed the 600px --large threshold`);
	}
});

test('the reasoning-effort chevron track is wider than the icon (label clearance)', async () => {
	const css = await fs.readFile(APP_CSS_PATH, 'utf8');
	assert.match(
		css,
		/\.reasoning-effort-trigger \{[\s\S]{0,400}?grid-template-columns: 1rem minmax\(0, 1fr\) 1\.25rem;/,
		'.reasoning-effort-trigger must reserve a 1.25rem end track for the chevron'
	);
});
