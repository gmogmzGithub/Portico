const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const tokenPath = path.join(repoRoot, 'src/patches/frontend/src/lib/utils/crossChatToken.mjs');
const badgePath = path.join(repoRoot, 'src/patches/frontend/src/lib/utils/displayNameBadge.mjs');

let tokenUtils;
let badgeUtils;

test.before(async () => {
	tokenUtils = await import(pathToFileURL(tokenPath).href);
	badgeUtils = await import(pathToFileURL(badgePath).href);
});

test('xchat prefix format/parse round-trips every field', () => {
	const fields = {
		chatId: 'bee10e5c-b8e7-4e9e-b45b-b1307dd99f22',
		displayName: 'Reviewer',
		modelName: 'GPT-5.6 Terra',
		modelId: 'gpt-5.6-terra',
		isAgent: false
	};
	const wire = tokenUtils.formatXchatPrefix(fields);
	assert.ok(wire.startsWith('[Message from another chat: [[xchat:'));
	// The workflows-skill trigger substring must survive the new format.
	assert.match(wire.toLowerCase(), /message from another chat/);

	const parsed = tokenUtils.parseXchatPrefix(`${wire}\n\nHello`);
	assert.deepEqual(parsed, { raw: wire, ...fields });
});

test('grammar characters in fields escape and unescape faithfully', () => {
	const fields = {
		chatId: 'source-1',
		displayName: 'Rev|iewer',
		modelName: 'GPT [v2] 50%',
		modelId: 'gpt|v2',
		isAgent: false
	};
	const wire = tokenUtils.formatXchatPrefix(fields);
	// Exact parity with the Rust builder's escaping (subagents_tests.rs).
	assert.equal(
		wire,
		'[Message from another chat: [[xchat:source-1|Rev%7Ciewer|GPT %5Bv2%5D 50%25|gpt%7Cv2|model]]]'
	);
	assert.deepEqual(tokenUtils.parseXchatPrefix(wire), { raw: wire, ...fields });
	// A literal '%25' in a name survives the round trip.
	assert.equal(
		tokenUtils.unescapeXchatField(tokenUtils.escapeXchatField('100%25 [sic]|x')),
		'100%25 [sic]|x'
	);
});

test('agent kind and empty model fields parse', () => {
	const wire = tokenUtils.formatXchatPrefix({
		chatId: 'c1',
		displayName: 'Critic',
		isAgent: true
	});
	const parsed = tokenUtils.parseXchatPrefix(wire);
	assert.equal(parsed.isAgent, true);
	assert.equal(parsed.modelName, '');
	assert.equal(parsed.modelId, '');
});

test('legacy and malformed prefixes return null (render as plain text)', () => {
	for (const src of [
		'[Message from another chat: bee10e5c from Model GPT-5.6 Terra]\n\nhi', // legacy
		'[Message from another chat]\n\nhi',
		'[Message from another chat: [[xchat:c1|Name]]]', // wrong arity
		'[Message from another chat: [[xchat:|Name|m|id|model]]]', // empty chat id
		'[Message from another chat: [[xchat:c1||m|id|model]]]', // empty display name
		'[Message from another chat: [[xchat:c1|Name|m|id|robot]]]', // bad kind
		'plain text'
	]) {
		assert.equal(tokenUtils.parseXchatPrefix(src), null, src);
	}
});

test('badge colors are deterministic, synced by name, and cover the palette', () => {
	const { badgePaletteIndex, badgeColors, badgeStyleVars, BADGE_PALETTE } = badgeUtils;
	assert.ok(BADGE_PALETTE.length >= 6);

	// Determinism + normalization: same name (any case/padding) → same color.
	assert.equal(badgePaletteIndex('Reviewer'), badgePaletteIndex('  reviewer  '));
	assert.equal(badgeStyleVars('Reviewer'), badgeStyleVars('reviewer'));
	assert.deepEqual(badgeColors('Orchestrator'), badgeColors('orchestrator'));

	// Distribution: a spread of names hits more than a couple of hues.
	const names = ['Reviewer', 'Critic', 'Researcher', 'Writer', 'Planner', 'Tester', 'Analyst', 'Editor', 'Scout', 'Judge'];
	const used = new Set(names.map((name) => badgePaletteIndex(name)));
	assert.ok(used.size >= 3, `only ${used.size} palette entries used`);

	// Style vars expose both light and dark values for the CSS rule.
	const style = badgeStyleVars('Reviewer');
	for (const needle of ['--badge-bg:', '--badge-text:', '--badge-border:', '--badge-bg-dark:', '--badge-text-dark:', '--badge-border-dark:']) {
		assert.ok(style.includes(needle), needle);
	}

	assert.equal(badgeUtils.ORCHESTRATOR_DISPLAY_NAME, 'Orchestrator');
});
