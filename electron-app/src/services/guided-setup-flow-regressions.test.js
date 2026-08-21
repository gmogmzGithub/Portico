const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const apiSource = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');
const ipcSource = fs.readFileSync(path.join(__dirname, 'ipc.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
const backendModalListenersSource = fs.readFileSync(
  path.join(__dirname, '..', 'renderer', 'components', 'backend-modal-listeners.js'),
  'utf8',
);

function assertContainsInOrder(source, snippets) {
  let cursor = 0;
  for (const snippet of snippets) {
    const index = source.indexOf(snippet, cursor);
    assert.notEqual(index, -1, `expected source to contain snippet after ${cursor}: ${snippet}`);
    cursor = index + snippet.length;
  }
}

test('guided setup creates a flow id, registers the waiter first, and broadcasts that same attempt id', () => {
  assertContainsInOrder(apiSource, [
    'const flowId = `guided-setup-${randomUUID()}`;',
    'const setupPromise = new Promise(r => { setupResolve = r; });',
    'guidedSetupWaiters.set(server_id, { resolve: setupResolve, flowId });',
    "sendBackendModalRequest('guided-setup-requested', {",
    'server_id,',
    'chat_id: chatId,',
    'reason,',
    'flow_id: flowId,',
  ]);
});

test('guided setup completion notifications keep the flow id and ignore stale completions', () => {
  assert.match(
    preloadSource,
    /notifyGuidedSetupCompleted:\s*\([\s\S]*serverId,[\s\S]*outcomeOrSuccess,[\s\S]*flowId = null,[\s\S]*details = \{\},[\s\S]*\) => \{/,
  );
  assertContainsInOrder(backendModalListenersSource, [
    'const { server_id, reason, flow_id } = payload;',
    'await window.openMcpConfigModal(server_id, null, {',
    'flowId: flow_id,',
    'launchSource: "backend-requested",',
    'waitForClose: true,',
    'window.electronAPI?.notifyGuidedSetupCompleted?.(',
    'server_id,',
    '"test_failed",',
    'flow_id,',
  ]);
  assertContainsInOrder(ipcSource, [
    'if (waiter.flowId && flow_id && waiter.flowId !== flow_id) {',
    'Ignoring stale completion for ${server_id}:',
    'return;',
  ]);
});

test('guided setup bridge distinguishes completed, failed, dismissed, and chat handoff outcomes', () => {
  assert.match(
    ipcSource,
    /buildGuidedSetupCompletionResult\(payload\)/,
  );
  assert.match(apiSource, /result\.outcome === 'completed'/);
  assert.match(apiSource, /result\.outcome === 'test_failed'/);
  assert.match(apiSource, /result\.outcome === 'redirected_to_chat'/);
  assert.match(apiSource, /outcome: 'dismissed'/);
  assert.match(
    apiSource,
    /The user did not dismiss the form/,
  );
});
