import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	DETACHED_WINDOW_MODE_SUBAGENT,
	SUBAGENT_VIEW_ENABLED,
	SUBAGENT_VIEW_PARAM,
	getDetachedWindowMode,
	hasDelegatedSubagentMetadata,
	isDelegatedSubagentRoute,
	isDetachedSubagentView
} from '../../../src/patches/frontend/src/lib/utils/detached-window-mode.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const chatComponentPath = path.join(
	repoRoot,
	'src',
	'patches',
	'frontend',
	'src',
	'lib',
	'components',
	'chat',
	'Chat.svelte'
);
const collapsibleComponentPath = path.join(
	repoRoot,
	'src',
	'patches',
	'frontend',
	'src',
	'lib',
	'components',
	'common',
	'Collapsible.svelte'
);

test('detached subagent view helper detects the tagged query param', () => {
	const params = new URLSearchParams('detached-window=subagent');

	assert.equal(getDetachedWindowMode(params), DETACHED_WINDOW_MODE_SUBAGENT);
	assert.equal(isDetachedSubagentView(params), true);
	assert.equal(isDelegatedSubagentRoute(params), true);
});

test('delegated subagent route helper survives redocking without detached-window state', () => {
	const params = new URLSearchParams(`${SUBAGENT_VIEW_PARAM}=${SUBAGENT_VIEW_ENABLED}`);

	assert.equal(isDetachedSubagentView(params), false);
	assert.equal(isDelegatedSubagentRoute(params), true);
});

test('delegated subagent metadata identifies direct child routes after hydration', () => {
	assert.equal(
		hasDelegatedSubagentMetadata({
			meta: { subagent: { parent_chat_id: 'root-chat' } }
		}),
		true
	);
	assert.equal(
		hasDelegatedSubagentMetadata({
			chat: { meta: { subagent: { parent_tool_call_id: 'call-123' } } }
		}),
		true
	);
	assert.equal(hasDelegatedSubagentMetadata({ meta: {} }), false);
});

test('detached subagent view helper ignores unrelated routes', () => {
	assert.equal(isDetachedSubagentView(new URLSearchParams('')), false);
	assert.equal(isDetachedSubagentView(new URLSearchParams('detached-window=chat')), false);
	assert.equal(isDetachedSubagentView(undefined), false);
	assert.equal(isDelegatedSubagentRoute(new URLSearchParams('subagent-view=0')), false);
});

test('detached subagent chat load failures do not navigate back home', () => {
	const source = fs.readFileSync(chatComponentPath, 'utf8');
	const navigateStart = source.indexOf('const navigateHandler = async () => {');
	assert.notEqual(navigateStart, -1, 'chat component should define navigateHandler');
	const navigateEnd = source.indexOf('\n\tconst onSelect = async', navigateStart);
	assert.notEqual(navigateEnd, -1, 'chat component should define onSelect after navigateHandler');
	const navigateBlock = source.slice(navigateStart, navigateEnd);
	const detachedGuard = navigateBlock.indexOf('else if (isDelegatedSubagentLoad())');
	const homeFallback = navigateBlock.indexOf("await goto('/');", detachedGuard);

	assert.notEqual(detachedGuard, -1, 'load failure should check detached subagent mode');
	assert.notEqual(homeFallback, -1, 'normal chat load failures should still fall back home');
	assert.ok(
		detachedGuard < homeFallback,
		'detached subagent failure handling must run before home fallback'
	);
	assert.match(navigateBlock, /setDetachedSubagentStatus\('error'\)/);
	assert.match(source, /Subagent details unavailable/);
});

test('detached subagent navigation cannot stay in a no-dom loading state', () => {
	const source = fs.readFileSync(chatComponentPath, 'utf8');
	const navigateStart = source.indexOf('const navigateHandler = async () => {');
	assert.notEqual(navigateStart, -1, 'chat component should define navigateHandler');
	const navigateEnd = source.indexOf('\n\tconst onSelect = async', navigateStart);
	assert.notEqual(navigateEnd, -1, 'chat component should define onSelect after navigateHandler');
	const navigateBlock = source.slice(navigateStart, navigateEnd);

	assert.match(navigateBlock, /try\s*\{/);
	assert.match(navigateBlock, /catch\s*\(error\)/);
	assert.match(navigateBlock, /finally\s*\{/);
	assert.match(
		navigateBlock,
		/isDelegatedSubagentLoad\(\)[\s\S]*loading[\s\S]*isCurrentChatLoad\(generation, targetChatId\)[\s\S]*loading\s*=\s*false;/,
		'detached subagent navigation should clear loading in finally'
	);
	assert.match(
		navigateBlock,
		/setDetachedSubagentStatus\('ready',\s*''\)/,
		'loaded detached subagents should mark the route ready'
	);
});

test('detached subagent loading and failure states render visible route markers', () => {
	const source = fs.readFileSync(chatComponentPath, 'utf8');

	assert.match(source, /type DetachedSubagentStatus = 'loading' \| 'ready' \| 'pending' \| 'error';/);
	assert.match(
		source,
		/data-detached-subagent-state=\{delegatedSubagentView \? detachedSubagentStatus : undefined\}/,
		'chat container should expose detached subagent state for the shell health probe'
	);
	assert.match(
		source,
		/\{#if delegatedSubagentView && loading\}[\s\S]*Opening subagent[\s\S]*\{:else if !loading\}/,
		'detached loading branch should render visible loading content before the normal chat branch'
	);
	assert.match(
		source,
		/data-detached-subagent-state=\{detachedSubagentStatus\}[\s\S]*Subagent details unavailable/,
		'detached load failure should render visible fallback UI with the same state marker'
	);
});

test('detached subagent detail links keep IPC payload shape and pass context in href only', () => {
	const source = fs.readFileSync(collapsibleComponentPath, 'utf8');

	assert.match(source, /import \{ page \} from '\$app\/stores';/);
	assert.match(source, /subagent-parent-chat-id/);
	assert.match(source, /subagent-tool-call-id/);
	assert.match(source, /url\.searchParams\.set\('subagent-view', '1'\)/);
	assert.match(
		source,
		/const result = await hostApi\.openConversationWindow\(\{\s*conversationId: chatId,\s*href,\s*title: 'Subagent',\s*windowType: 'subagent'\s*\}\);/s,
		'detached subagent IPC payload should keep the existing fields only'
	);
	assert.doesNotMatch(
		source,
		/openConversationWindow\(\{[\s\S]*subagent-parent-chat-id/,
		'parent chat context should not become a new IPC field'
	);
});

test('delegated subagent identity drives the ordinary chat tree read-only props and mutation guards', () => {
	const source = fs.readFileSync(chatComponentPath, 'utf8');

	assert.match(source, /hydratedDelegatedSubagentView = hasDelegatedSubagentMetadata\(chatContent\)/);
	assert.match(source, /readOnly=\{delegatedSubagentView\}/);
	assert.match(source, /readOnlyMode=\{delegatedSubagentView\}/);
	assert.match(source, /readOnlyView=\{delegatedSubagentView\}/);
	assert.match(source, /showModelSelector=\{!delegatedSubagentView\}/);
	assert.match(source, /const submitPrompt = async[\s\S]*?if \(delegatedSubagentView\) return;/);
	assert.match(source, /const sendMessage = async[\s\S]*?if \(delegatedSubagentView\) return;/);
	assert.match(source, /const regenerateResponse = async[\s\S]*?if \(delegatedSubagentView\) return;/);
});
