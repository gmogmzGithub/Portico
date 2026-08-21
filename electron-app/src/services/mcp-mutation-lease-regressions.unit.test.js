const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function assertContainsInOrder(source, snippets, message) {
  let cursor = 0;
  for (const snippet of snippets) {
    const index = source.indexOf(snippet, cursor);
    assert.notEqual(index, -1, message || `expected to find snippet: ${snippet}`);
    cursor = index + snippet.length;
  }
}

// docker-start / docker-restart take the global single-writer lease and park the
// release closure on appState so it can span the whole runtime bring-up. Before
// this fix the only release lived in start-initialization, which several
// reachable paths never reach -- orphaning the lease and failing every later MCP
// mutation with MCP_OPERATION_BUSY until the app was restarted.

test("the pending runtime mutation release lives in shared-state, not main", () => {
  const sharedState = readRepoFile("electron-app/src/services/shared-state.js");
  const main = readRepoFile("electron-app/src/services/main.js");

  assert.match(sharedState, /function releasePendingMcpRuntimeMutation\(reason = 'unspecified'\)/);
  assert.match(sharedState, /^\s*releasePendingMcpRuntimeMutation,$/m);
  assert.doesNotMatch(
    main,
    /function releasePendingMcpRuntimeMutation/,
    "main.js must not keep a private copy that windows.js and ipc.js cannot reach",
  );
  assert.match(main, /state\.releasePendingMcpRuntimeMutation\("start-initialization-finally"\)/);
});

test("guided setup handoff releases the runtime mutation lease before opening the wizard", () => {
  const source = readRepoFile("electron-app/src/services/ipc.js");
  const handlerStart = source.indexOf('ipcMain.on("launch-electron-app-from-init"');
  assert.notEqual(handlerStart, -1);
  const handler = source.slice(handlerStart, handlerStart + 2000);

  assertContainsInOrder(
    handler,
    [
      'state.releasePendingMcpRuntimeMutation("guided-setup-handoff")',
      "state.windows.loading.close()",
      "dependencies.createGuidedSetupWindow(",
    ],
    "the lease must be released before the loading window closes and the wizard opens",
  );
});

test("docker start and restart release the lease when no loading window can be created", () => {
  const source = readRepoFile("electron-app/src/services/ipc.js");

  for (const [handler, reason] of [
    ['ipcMain.handle("docker-start"', "docker-start-loading-window-unavailable"],
    ['ipcMain.handle("docker-restart"', "docker-restart-loading-window-unavailable"],
  ]) {
    const start = source.indexOf(handler);
    assert.notEqual(start, -1, `expected handler: ${handler}`);
    const body = source.slice(start, start + 3000);
    assertContainsInOrder(
      body,
      [
        "acquireMutationLease(",
        "if (dependencies.createLoadingWindow) {",
        "} else {",
        `state.releasePendingMcpRuntimeMutation(\n          "${reason}",\n        )`,
      ],
      `${handler} must release its lease when the loading window is unavailable`,
    );
  }
});

test("the loading window closed handler is identity guarded before releasing", () => {
  const source = readRepoFile("electron-app/src/services/windows.js");

  // Without the guard, docker-start closing the PREVIOUS loading window would
  // immediately release the lease it just acquired for the new one.
  assertContainsInOrder(
    source,
    [
      "const loadingWindow = state.windows.loading;",
      "loadingWindow.on('closed', () => {",
      "if (state.windows.loading !== loadingWindow) {",
      "return;",
      "state.windows.loading = null;",
      "state.releasePendingMcpRuntimeMutation('loading-window-closed')",
    ],
    "the closed handler must capture its own window and bail out if superseded",
  );
  assert.doesNotMatch(
    source,
    /state\.windows\.loading\.on\('closed'/,
    "binding through the mutable slot is what allowed a stale handler to null a newer window",
  );
});

test("initialization adopts an existing lease by renewing it rather than re-acquiring", () => {
  const source = readRepoFile("electron-app/src/services/main.js");
  const start = source.indexOf("function ensurePendingMcpRuntimeMutation");
  assert.notEqual(start, -1);
  const fn = source.slice(start, source.indexOf("\n}", start));

  assertContainsInOrder(
    fn,
    [
      'if (typeof state.appState.mcpRuntimeMutationRelease === "function") {',
      "defaultMcpOperationManager.renewMutationLease({ kind, source })",
      "return false;",
    ],
    "a long cold init must re-stamp the adopted lease so it cannot age into eviction",
  );
});

test("stale lease eviction runs only on the contended path and adds no timers", () => {
  const source = readRepoFile("electron-app/src/services/mcp-operation-manager.js");

  // Both mutex gates: evict first, then re-check, then throw.
  const gate = [
    "if (this._activeOperationId || this._externalMutation) {",
    "this._evictStaleExternalMutation();",
    "if (this._activeOperationId || this._externalMutation) {",
    "throw this._mutationBusyError();",
  ];
  const acquireStart = source.indexOf("acquireMutationLease(details = {}) {");
  assert.notEqual(acquireStart, -1);
  assertContainsInOrder(source.slice(acquireStart), gate);

  const startOperationStart = source.indexOf("const initialStatus = \"queued\";");
  assert.notEqual(startOperationStart, -1);
  assertContainsInOrder(source.slice(0, startOperationStart), gate);

  assert.doesNotMatch(
    source,
    /_pruneHistory\(\)\s*\{[\s\S]*?_evictStaleExternalMutation/,
    "_pruneHistory also runs on uncontended paths and would evict live leases",
  );

  // Performance constraint (ATLAS.md): eviction must stay lazy. No reaper.
  assert.doesNotMatch(
    source,
    /setInterval|setTimeout/,
    "the operation manager must not introduce timers, intervals, or polling",
  );
});

test("the busy error names the holder without leaking payloads", () => {
  const source = readRepoFile("electron-app/src/services/mcp-operation-manager.js");
  const start = source.indexOf("_mutationBusyError() {");
  assert.notEqual(start, -1);
  const fn = source.slice(start, source.indexOf("\n  }", start));

  assert.match(fn, /Another MCP change is still running/);
  assert.match(fn, /restart Portico/);
  assert.match(fn, /formatMutationAge\(this\._clock\(\) - startedAt\)/);
  assert.doesNotMatch(
    fn,
    /mutationId/,
    "the user-facing message must not interpolate the raw mutation id",
  );
  // Structured detail must still be attached for programmatic consumers.
  assert.match(fn, /error\.code = "MCP_OPERATION_BUSY"/);
  assert.match(fn, /error\.activeMutation = activeMutation/);
});

test("eviction logging records identifiers only, never mutation payloads", () => {
  const source = readRepoFile("electron-app/src/services/mcp-operation-manager.js");
  const start = source.indexOf("_evictStaleExternalMutation() {");
  assert.notEqual(start, -1);
  const fn = source.slice(start, source.indexOf("\n  }", start));

  assert.match(fn, /kind=\$\{mutation\.kind\}/);
  assert.match(fn, /source=\$\{mutation\.source\}/);
  assert.match(fn, /ageMs=\$\{ageMs\}/);
  assert.doesNotMatch(
    fn,
    /JSON\.stringify|\$\{mutation\}/,
    "never serialize the whole mutation -- it can carry secret-bearing detail",
  );
  assert.doesNotMatch(
    fn,
    /this\._activeOperationId\s*=/,
    "eviction must only ever clear _externalMutation",
  );
});

test("guided setup finalize escapes rendered errors and drops the misleading prereqs advice", () => {
  const source = readRepoFile(
    "electron-app/src/renderer/screens/guided-setup/screen-finalize.js",
  );

  assert.match(source, /function escapeHtml\(value\)/);
  assert.match(source, /<div class="setup-readiness-error">\$\{escapeHtml\(error\)\}<\/div>/);
  assert.match(
    source,
    /<div class="setup-readiness-title">\$\{escapeHtml\(title \|\| 'Finalize is blocked\.'\)\}<\/div>/,
  );

  // Returning to prereqs cannot clear a held lease, so that branch must be
  // suppressed and replaced with wait-or-restart guidance.
  assert.match(source, /const isMcpMutationBusy = errorCode === 'MCP_OPERATION_BUSY'/);
  assert.match(source, /!isMcpMutationBusy &&/);
  assert.match(source, /quit Portico completely and reopen it/);

  // The code has to survive both re-wraps for that branch to ever fire.
  assert.match(source, /writeError\.code = writeResult\.errorCode \|\| null/);
  assert.match(source, /wrapped\.code = err\?\.code \|\| null/);
  assert.match(source, /errorCode: err\?\.code \|\| null/);
});

// --- PORTICO-339 follow-up: guided-setup finalize vs single-server teardown ------
// The stop handler holds the global lease across a docker compose down; the
// wizard used to enter finalize before that stop even started. Two layers:
// the renderer stops before advancing, and the finalize IPC handlers absorb a
// short busy window by waiting once (event-driven) for the lock to free.
//
// Single-server start/stop originally kept fail-fast semantics, but that made
// back-to-back OAuth setups fail: each completed OAuth spawns a background
// recovery restart (api.js restartServerAndWaitReady, source
// "oauth-complete-recovery") that holds the lease for up to ~30s
// (TOOL_READY_TIMEOUT_MS), so authorizing the next server inside that window
// bounced off MCP_OPERATION_BUSY at the wizard's very first step. Start/stop
// now absorb that holder with the same wait-once helper under a longer
// ceiling (SINGLE_SERVER_LEASE_WAIT_MS).

test("the release paths emit a one-shot idle notification; eviction does not", () => {
  const source = readRepoFile("electron-app/src/services/mcp-operation-manager.js");

  // External lease release notifies.
  const acquireStart = source.indexOf("acquireMutationLease(details = {}) {");
  assert.notEqual(acquireStart, -1);
  assertContainsInOrder(source.slice(acquireStart), [
    "released = true",
    "this._externalMutation = null",
    "this._notifyMutationIdle()",
  ]);

  // Every operation-terminal path funnels through _releaseOwners.
  const releaseOwnersStart = source.indexOf("_releaseOwners(operation) {");
  assert.notEqual(releaseOwnersStart, -1);
  const releaseOwners = source.slice(
    releaseOwnersStart,
    source.indexOf("\n  }", releaseOwnersStart),
  );
  assert.match(releaseOwners, /this\._notifyMutationIdle\(\);/);

  // whenMutationIdle resolves immediately when the lock is already free.
  const whenIdleStart = source.indexOf("whenMutationIdle() {");
  assert.notEqual(whenIdleStart, -1);
  const whenIdle = source.slice(whenIdleStart, source.indexOf("\n  }", whenIdleStart));
  assertContainsInOrder(whenIdle, [
    "if (!this._activeOperationId && !this._externalMutation) {",
    "return Promise.resolve(true);",
    'this._events.once("mutation:released"',
  ]);

  // Eviction runs inside a contended acquire gate where the contender takes
  // the lock immediately -- waking waiters there would burn their one retry.
  const evictStart = source.indexOf("_evictStaleExternalMutation() {");
  assert.notEqual(evictStart, -1);
  const evict = source.slice(evictStart, source.indexOf("\n  }", evictStart));
  assert.doesNotMatch(evict, /_notifyMutationIdle/);

  // The guard itself must stay pure state-check.
  const notifyStart = source.indexOf("_notifyMutationIdle() {");
  assert.notEqual(notifyStart, -1);
  const notify = source.slice(notifyStart, source.indexOf("\n  }", notifyStart));
  assert.match(notify, /if \(!this\._activeOperationId && !this\._externalMutation\)/);
});

test("guided-setup finalize handlers wait once for the lock instead of failing busy", () => {
  const source = readRepoFile("electron-app/src/services/ipc.js");

  // Helper: event-driven wait, one-shot leaf timeout, exactly one retry.
  const helperStart = source.indexOf(
    "async function acquireMcpMutationLeaseWithWait(details, { waitMs } = {}) {",
  );
  assert.notEqual(helperStart, -1);
  const helper = source.slice(helperStart, source.indexOf("\n}", helperStart));
  assertContainsInOrder(helper, [
    "defaultMcpOperationManager.acquireMutationLease(details)",
    'if (error?.code !== "MCP_OPERATION_BUSY") throw error;',
    "Promise.race",
    "whenMutationIdle()",
    "setTimeout(resolve, waitMs)",
    "clearTimeout(timer)",
    "return defaultMcpOperationManager.acquireMutationLease(details);",
  ]);
  assert.match(source, /const GUIDED_SETUP_FINALIZE_LEASE_WAIT_MS = 10_000;/);
  assert.match(source, /const SINGLE_SERVER_LEASE_WAIT_MS = 35_000;/);

  // The finalize acquire stays a thin delegation with the short ceiling.
  const wrapperStart = source.indexOf(
    "async function acquireGuidedSetupFinalizeLease(details) {",
  );
  assert.notEqual(wrapperStart, -1);
  const wrapper = source.slice(wrapperStart, source.indexOf("\n}", wrapperStart));
  assertContainsInOrder(wrapper, [
    "acquireMcpMutationLeaseWithWait(details, {",
    "waitMs: GUIDED_SETUP_FINALIZE_LEASE_WAIT_MS,",
  ]);

  // Exactly the four finalize-path handlers use the finalize wrapper.
  for (const kind of [
    "guided_setup_toggle_patch",
    "write_env_file",
    "upsert_runtime_secret",
    "generate_mcp_config",
  ]) {
    const acquire = `releaseMutation = await acquireGuidedSetupFinalizeLease({\n        kind: "${kind}",`;
    assert.notEqual(
      source.indexOf(acquire),
      -1,
      `expected ${kind} to acquire via the bounded-wait helper`,
    );
  }
  assert.equal(
    (source.match(/acquireGuidedSetupFinalizeLease\(\{/g) || []).length,
    4,
    "exactly four handlers may use the finalize bounded-wait acquire",
  );

  // Single-server start/stop absorb the post-OAuth recovery holder with the
  // longer ceiling instead of failing busy (see section comment above).
  for (const kind of ["stop_single_mcp_server", "start_single_mcp_server"]) {
    const start = source.indexOf(`kind: "${kind}"`);
    assert.notEqual(start, -1);
    const before = source.slice(Math.max(0, start - 200), start);
    assert.match(
      before,
      /await acquireMcpMutationLeaseWithWait\(/,
      `${kind} must acquire via the bounded-wait helper`,
    );
    const after = source.slice(start, start + 250);
    assert.match(
      after,
      /\{ waitMs: SINGLE_SERVER_LEASE_WAIT_MS \}/,
      `${kind} must wait out the post-OAuth recovery ceiling`,
    );
  }
});

test("the oauth start paths preserve the busy code across renderer re-wraps", () => {
  // The start-single-server handler resolves { success:false, errorCode } —
  // each renderer re-wrap has to carry that code forward or the busy branch
  // in showWizardTestingError can never fire.
  const wizard = readRepoFile(
    "electron-app/src/renderer/components/oauth-wizard-modal.js",
  );
  assert.match(wizard, /startError\.code = startResult\.errorCode \|\| null/);
  assert.match(wizard, /errorCode: error\?\.code \|\| null/);
  assert.match(
    wizard,
    /const isMcpBusy = options\.errorCode === 'MCP_OPERATION_BUSY'/,
  );

  const screenOauth = readRepoFile(
    "electron-app/src/renderer/screens/guided-setup/screen-oauth.js",
  );
  assert.match(
    screenOauth,
    /startError\.code = startResult\.errorCode \|\| startResult\.code \|\| null/,
  );
});

test("the oauth screen tears down the single server before advancing on both success paths", () => {
  const source = readRepoFile(
    "electron-app/src/renderer/screens/guided-setup/screen-oauth.js",
  );

  // Fast path (already authorized) and main poll path both stop-then-advance.
  const fastPathStart = source.indexOf("// Check if already authorized");
  assert.notEqual(fastPathStart, -1);
  assertContainsInOrder(source.slice(fastPathStart), [
    "await handleOAuthVerification(",
    "await stopSingleServerBeforeAdvance();",
    "markCurrentAsDoneNoRestart(setupState, callbacks);",
    "return;",
  ]);

  const mainPathStart = source.indexOf("// Handle token verification");
  assert.notEqual(mainPathStart, -1);
  assertContainsInOrder(source.slice(mainPathStart), [
    "await handleOAuthVerification(",
    "await stopSingleServerBeforeAdvance();",
    "markCurrentAsDoneNoRestart(setupState, callbacks);",
  ]);

  // Verification itself must no longer advance.
  const verificationStart = source.indexOf("async function handleOAuthVerification(");
  assert.notEqual(verificationStart, -1);
  const verification = source.slice(
    verificationStart,
    source.indexOf("\n}", verificationStart),
  );
  assert.doesNotMatch(verification, /markCurrentAsDoneNoRestart\(/);
});
