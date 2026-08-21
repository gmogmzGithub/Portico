const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const utilityPath = path.join(
	repoRoot,
	'src/patches/frontend/src/lib/utils/streaming-activity.mjs'
);
const activityIndicatorPath = path.join(
	repoRoot,
	'src/patches/frontend/src/lib/components/chat/ActivityIndicator.svelte'
);
const responseMessagePath = path.join(
	repoRoot,
	'src/patches/frontend/src/lib/components/chat/Messages/ResponseMessage.svelte'
);
const messagesPath = path.join(
	repoRoot,
	'src/patches/frontend/src/lib/components/chat/Messages.svelte'
);
const messagePath = path.join(
	repoRoot,
	'src/patches/frontend/src/lib/components/chat/Messages/Message.svelte'
);
const multiResponseMessagesPath = path.join(
	repoRoot,
	'src/patches/frontend/src/lib/components/chat/Messages/MultiResponseMessages.svelte'
);
const chatPath = path.join(
	repoRoot,
	'src/patches/frontend/src/lib/components/chat/Chat.svelte'
);

let streamingActivity;
test.before(async () => {
	streamingActivity = await import(pathToFileURL(utilityPath).href);
});

test('compact elapsed durations cover seconds, minutes, hours, and days', () => {
	assert.equal(streamingActivity.formatElapsedDuration(-1), '0s');
	assert.equal(streamingActivity.formatElapsedDuration(0), '0s');
	assert.equal(streamingActivity.formatElapsedDuration(8.9), '8s');
	assert.equal(streamingActivity.formatElapsedDuration(59), '59s');
	assert.equal(streamingActivity.formatElapsedDuration(60), '1m');
	assert.equal(streamingActivity.formatElapsedDuration(84), '1m 24s');
	assert.equal(streamingActivity.formatElapsedDuration(7_380), '2h 3m');
	assert.equal(streamingActivity.formatElapsedDuration(90_061), '1d 1h 1m 1s');
});

test('stream start timestamps accept persisted seconds, live milliseconds, and legacy fallbacks', () => {
	assert.equal(streamingActivity.normalizeStreamStartedAt(1_700_000_000), 1_700_000_000_000);
	assert.equal(
		streamingActivity.normalizeStreamStartedAt(1_700_000_000_123),
		1_700_000_000_123
	);
	assert.equal(streamingActivity.normalizeStreamStartedAt(null, 1234), 1234);
	assert.equal(streamingActivity.normalizeStreamStartedAt('invalid', 5678), 5678);
});

test('standalone streaming activity keeps its shimmer while replacing rotating phrases', () => {
	const source = fs.readFileSync(activityIndicatorPath, 'utf8');

	assert.match(source, /data-testid="streaming-activity-indicator"/);
	assert.match(source, /Working for \{elapsedDuration\}/);
	assert.match(source, /setInterval\([\s\S]*1000\)/);
	assert.match(source, /onDestroy\(\(\) => \{[\s\S]*clearActivityTimer\(\)/);
	assert.match(source, /animation: activity-text-shimmer 4s ease-in-out infinite/);
	assert.match(source, /prefers-reduced-motion: reduce/);
	assert.doesNotMatch(source, /Clauding|Cogitating|phraseCache|phraseInterval|currentPhrase/);
});

test('response rendering restores activity after every top-level stream element', () => {
	const responseSource = fs.readFileSync(responseMessagePath, 'utf8');
	const activityMatches = responseSource.match(/<ActivityIndicator/g) ?? [];
	const imageBlockIndex = responseSource.indexOf('{#if imageFiles.length > 0}');
	const activityIndex = responseSource.indexOf('<ActivityIndicator');

	assert.equal(activityMatches.length, 1);
	assert.match(responseSource, /assistantModelLogoIsStreaming = !message\.done && !message\.error/);
	assert.match(responseSource, /\{#if assistantModelLogoIsStreaming\}[\s\S]*<ActivityIndicator/);
	assert.match(responseSource, /startedAt=\{message\.streamStartedAt \?\? message\.timestamp\}/);
	assert.doesNotMatch(responseSource, /!workActivitySummary\.hasActivity/);
	assert.ok(imageBlockIndex >= 0, 'expected the top-level image block');
	assert.ok(
		activityIndex > imageBlockIndex,
		'streaming activity must render after prose, summaries, statuses, citations, and files'
	);
});

test('new generations record a start time and Continue Response resets it', () => {
	const chatSource = fs.readFileSync(chatPath, 'utf8');

	assert.match(chatSource, /const responseStartedAt = Date\.now\(\);/);
	assert.match(chatSource, /timestamp: Math\.floor\(responseStartedAt \/ 1000\)/);
	assert.match(chatSource, /streamStartedAt: responseStartedAt/);
	assert.match(
		chatSource,
		/const continueResponse = async[\s\S]*responseMessage\.streamStartedAt = Date\.now\(\);[\s\S]*responseMessage\.done = false;/
	);
});

test('detached subagent hydration keeps the shared elapsed label active until terminal state', () => {
	const chatSource = fs.readFileSync(chatPath, 'utf8');
	const messagesSource = fs.readFileSync(messagesPath, 'utf8');
	const messageSource = fs.readFileSync(messagePath, 'utf8');
	const multiResponseSource = fs.readFileSync(multiResponseMessagesPath, 'utf8');
	const responseSource = fs.readFileSync(responseMessagePath, 'utf8');
	const renderingPathSource = [
		messagesSource,
		messageSource,
		multiResponseSource,
		responseSource
	].join('\n');

	assert.match(
		chatSource,
		/const activeHistory = normalizeDetachedSubagentActiveHistory\(history\);[\s\S]*?normalizeHydratedMessagesForFirstPaint\(/
	);
	assert.match(
		chatSource,
		/const merged = mergeDetachedSubagentHistory\(history, snapshot\);[\s\S]*?normalizeDetachedSubagentActiveHistory\(merged\.history\)/
	);
	assert.match(
		chatSource,
		/hasActiveChatTasks: delegatedSubagentView[\s\S]*?\? true[\s\S]*?: taskStateKnown/
	);
	assert.doesNotMatch(
		`${chatSource}\n${renderingPathSource}`,
		/forceStreamingActivity|streamingActivityMessageId|detachedSubagentActivityMessageId|resolveDetachedSubagentActivityMessageId/
	);
	assert.doesNotMatch(renderingPathSource, /detachedSubagent|subagent/i);
	assert.match(responseSource, /assistantModelLogoIsStreaming = !message\.done && !message\.error/);
	assert.equal(
		(responseSource.match(/<ActivityIndicator/g) ?? []).length,
		1,
		'detached activity must reuse the root ActivityIndicator location'
	);
});

test('open reasoning blocks suppress the stall heartbeat (known activity)', () => {
	const { hasOpenReasoningActivity } = streamingActivity;

	// Live thinking indicator: open reasoning block, no ended_at yet.
	assert.equal(
		hasOpenReasoningActivity({
			contentBlocks: [{ type: 'reasoning', content: '', started_at: 100.0 }]
		}),
		true
	);

	// Closed block => no live reasoning; heartbeat may show again.
	assert.equal(
		hasOpenReasoningActivity({
			contentBlocks: [
				{ type: 'reasoning', content: 'done', started_at: 100.0, ended_at: 109.0 }
			]
		}),
		false
	);

	// Serialized-content fallback (contentBlocks not hydrated yet).
	assert.equal(
		hasOpenReasoningActivity({
			content: '<details type="reasoning" done="false" started_at="100" elapsed="4">\n<summary>Thinking…</summary>\n</details>'
		}),
		true
	);
	assert.equal(
		hasOpenReasoningActivity({
			content: '<details type="reasoning" done="true" duration="9">\n<summary>Thought for 9 seconds</summary>\n</details>'
		}),
		false
	);

	assert.equal(hasOpenReasoningActivity({ contentBlocks: [], content: 'plain text' }), false);
	assert.equal(hasOpenReasoningActivity(null), false);
});

test('open reasoning blocks are transient: durable content excludes them', () => {
	const { stripOpenReasoningBlocks } = streamingActivity;
	const openBlock =
		'<details type="reasoning" done="false" started_at="1754265600.123456" elapsed="0">\n<summary>Thinking…</summary>\n\n</details>\n';
	const openBlockNoStartedAt =
		'<details type="reasoning" done="false" elapsed="7">\n<summary>Thinking…</summary>\n\n</details>\n';
	const openBlockWithSummaryText =
		'<details type="reasoning" done="false" started_at="100" elapsed="4">\n<summary>Thinking…</summary>\n&gt; Weighing &amp; comparing &lt;options&gt;\n</details>\n';
	const closedBlock =
		'<details type="reasoning" done="true" duration="9" started_at="100">\n<summary>Thought for 9 seconds</summary>\n&gt; Done thinking\n</details>\n';
	const openToolCallsBlock =
		'<details type="tool_calls" done="false" started_at="100" elapsed="2" id="tc1" name="search" arguments="{}">\n<summary>Searching…</summary>\n</details>\n';

	// Plain text is untouched.
	assert.equal(stripOpenReasoningBlocks('Hello there'), 'Hello there');

	// The live thinking-indicator marker snapshot has zero durable content,
	// with and without the optional started_at attribute.
	assert.equal(stripOpenReasoningBlocks(openBlock), '');
	assert.equal(stripOpenReasoningBlocks(openBlockNoStartedAt), '');

	// Text inside an open block is transient too (it becomes the closed
	// block later); html-escaped bodies terminate at the block's own closer.
	assert.equal(stripOpenReasoningBlocks(openBlockWithSummaryText), '');

	// The serializer's separator newline before the block is consumed.
	assert.equal(stripOpenReasoningBlocks('Hello\n' + openBlock), 'Hello');

	// The stale chopped-stream shape: indicator markup followed by appended
	// deltas keeps only the appended text.
	assert.equal(stripOpenReasoningBlocks(openBlock + '! I can help'), '! I can help');

	// Closed reasoning and open tool_calls blocks are durable.
	assert.equal(stripOpenReasoningBlocks(closedBlock + 'Welcome!'), closedBlock + 'Welcome!');
	assert.equal(
		stripOpenReasoningBlocks(openToolCallsBlock + 'result'),
		openToolCallsBlock + 'result'
	);

	// A closed block followed by an open one keeps the closed block (its
	// trailing separator newline is consumed with the open block).
	assert.equal(stripOpenReasoningBlocks(closedBlock + openBlock), closedBlock.trimEnd());

	// Multiple open blocks around durable text.
	assert.equal(
		stripOpenReasoningBlocks(openBlock + 'middle\n' + openBlockNoStartedAt),
		'middle'
	);

	// Non-string input passes through.
	assert.equal(stripOpenReasoningBlocks(null), null);
	assert.equal(stripOpenReasoningBlocks(undefined), undefined);
});
