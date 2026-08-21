// Round-9 regressions, behavioral edition: the AI Marketplace publish
// confirmation is an app-styled, minimizable renderer modal
// (marketplace_publish native-input flow) that shows the real Agents-tab /
// skill card — the native dialog survives only as the degraded-environment
// fallback. Every layer is driven for real:
//   - shared-state.js flow registration (plain require, real state maps)
//   - api.js routes over real HTTP (Express app + Module._load stubs; real
//     shared-state + real marketplace-publish-confirm-flows underneath)
//   - ipc.js completion/reopen handlers (Module._load harness, real state)
//   - preload.js channel plumbing (contextBridge capture)
//   - ai-marketplace-publish-modal.js in a vm DOM harness fed the REAL
//     modal .html (ids extracted as fixtures, so the markup↔lookup contract
//     is exercised)
//   - backend-modal-listeners.js routing in a vm harness
//
// Left to live visual QA / markup review (not pinned as source text): the
// eyeball SVG art, the "AI Marketplace" eyebrow styling, the publish-modal
// containers + script tags in index.html / conversation-window.html, and the
// styles.css token scoping for .ai-marketplace-publish-modal and
// .agents-publish-card-preview.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");

const SERVICES_DIR = __dirname;
const COMPONENTS_DIR = path.join(__dirname, "..", "renderer", "components");

const state = require("./shared-state");
const flows = require("./marketplace-publish-confirm-flows");

function clearFlowTimers() {
  for (const map of [
    state.marketplacePublishFlowResults,
    state.userQuestionFlowResults,
  ]) {
    for (const [key, entry] of map.entries()) {
      if (entry?.timeoutHandle) clearTimeout(entry.timeoutHandle);
      if (entry?.cleanupHandle) clearTimeout(entry.cleanupHandle);
      map.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// shared-state: the marketplace_publish native-input flow kind
// ---------------------------------------------------------------------------

test("shared-state registers marketplace_publish across the native-input plumbing", (t) => {
  t.after(clearFlowTimers);
  assert.equal(state.NATIVE_INPUT_FLOW_KINDS.MARKETPLACE_PUBLISH, "marketplace_publish");

  const entry = state.startMarketplacePublishFlow({
    flowId: "ss-flow-1",
    status: "in_progress",
    chatId: null,
    mode: "publish-agent",
    startedAt: 111,
    ownerWindowId: 4,
    presentation: "visible",
    timeoutHandle: null,
    cleanupHandle: null,
  });
  assert.throws(() => state.startMarketplacePublishFlow({}), /requires an entry with flowId/);

  // The generic flow map resolves the kind — this wiring alone is what gives
  // the modal minimize + reopen via the shared native-input handlers.
  assert.equal(state.getNativeInputFlow("marketplace_publish", "ss-flow-1"), entry);
  assert.equal(
    state.setNativeInputFlowPresentation("marketplace_publish", "ss-flow-1", "hidden", 4),
    entry,
  );
  assert.equal(entry.presentation, "hidden");
  // A non-owning window may not change the presentation.
  assert.equal(
    state.setNativeInputFlowPresentation("marketplace_publish", "ss-flow-1", "visible", 9),
    null,
  );

  // The presentation snapshot enumerates the kind alongside the other
  // native-input flows.
  const snapshot = state.buildNativeInputPresentationSnapshot(4);
  assert.deepEqual(snapshot.flows, [
    {
      kind: "marketplace_publish",
      flow_id: "ss-flow-1",
      chat_id: null,
      presentation: "hidden",
      item_count: 1,
    },
  ]);

  // Completion stamps the terminal result and stops tracking the flow as
  // in-progress.
  const completed = state.completeMarketplacePublishFlow("ss-flow-1", {
    status: "approved",
    success: true,
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.result.status, "approved");
  assert.equal(state.buildNativeInputPresentationSnapshot(4).flows.length, 0);
  assert.equal(state.completeMarketplacePublishFlow("missing-flow", {}), null);
});

// ---------------------------------------------------------------------------
// api.js routes over real HTTP
// ---------------------------------------------------------------------------

const API_PATH = path.join(SERVICES_DIR, "api.js");
const REAL_API_RELATIVE = new Set(["./shared-state", "./marketplace-publish-confirm-flows"]);

async function loadApiHarness({
  getAgentForPublishImpl = null,
  assertUnpublishableImpl = null,
  reclaimAgentImpl = null,
  getOwnedSolutionImpl = null,
  getSolutionImpl = null,
  getBundleImpl = null,
  listPublishedImpl = null,
  skillLinksImpl = null,
} = {}) {
  const originalLoad = Module._load;
  const opsCalls = [];
  const broadcasts = [];
  const dialogCalls = [];
  const ownerBroadcasts = [];
  const control = { deliverySent: true, autoApprove: false };

  const opsFake = {
    async search() {
      opsCalls.push(["search"]);
      return { results: [] };
    },
    async getSolution(id) {
      opsCalls.push(["getSolution", id]);
      if (typeof getSolutionImpl === "function") return getSolutionImpl(id);
      return { id };
    },
    async getBundle(id) {
      opsCalls.push(["getBundle", id]);
      if (typeof getBundleImpl === "function") return getBundleImpl(id);
      return { payload: {} };
    },
    async listPublished(query) {
      opsCalls.push(["listPublished", query]);
      if (typeof listPublishedImpl === "function") return listPublishedImpl(query);
      return { solutions: [] };
    },
    async getSkillProvenanceSnapshot() {
      return {};
    },
    async deleteLocalSkill() {
      return {};
    },
    async clearDeletedAgentLink() {
      return {};
    },
    async install(id) {
      opsCalls.push(["install", id]);
      return { id };
    },
    async reclaimInstalledAgent(agentId) {
      opsCalls.push(["reclaimInstalledAgent", agentId]);
      if (typeof reclaimAgentImpl === "function") return reclaimAgentImpl(agentId);
      return {
        local_agent_id: agentId,
        solution_id: "sol-1",
        link: { relationship: "published" },
      };
    },
    async reclaimInstalledSkill(skillId) {
      opsCalls.push(["reclaimInstalledSkill", skillId]);
      return {
        local_skill_id: "example-skill-2",
        solution_id: "sol-1",
        previous_local_path: null,
      };
    },
    async getAgentForPublish(agentId, opts) {
      opsCalls.push(["getAgentForPublish", agentId, opts]);
      if (getAgentForPublishImpl) return getAgentForPublishImpl(agentId, opts);
      return {
        agent: {
          id: agentId,
          name: "Agent One",
          description: "publish fixture",
          skill_ids: ["alpha"],
          tool_server_ids: [],
        },
        systemPrompt: "prompt-body-".repeat(60),
      };
    },
    async getSkillForPublish(skillId, opts) {
      opsCalls.push(["getSkillForPublish", skillId, opts]);
      return {
        skill: { name: skillId, description: "skill fixture", source: "user", version: "1.0" },
      };
    },
    async getOwnedSolutionForWrite(id, opts) {
      opsCalls.push(["getOwnedSolutionForWrite", id, opts]);
      if (typeof getOwnedSolutionImpl === "function") {
        return await getOwnedSolutionImpl(id, opts);
      }
      return {
        id,
        name: "Owned Skill",
        type: "skills",
        description: "owned skill fixture",
        version: "2.0",
        author: "dsantiago",
        submitted_by: "dsantiago",
      };
    },
    async buildAndPublishAgent(args) {
      opsCalls.push(["buildAndPublishAgent", args]);
      return { id: "new-sol" };
    },
    // Mirrors the real ops contract: legacy {data, publishStatus} plus the
    // identity keys the flat chat envelope is composed from.
    async buildAndPublishSkill(args) {
      opsCalls.push(["buildAndPublishSkill", args]);
      return {
        data: { id: "new-skill-sol" },
        publishStatus: { id: "new-skill-sol", status: "active", has_bundle: true },
        skill_id: String(args?.skillId || ""),
        solution_id: "new-skill-sol",
        action: args?.existingSolutionId ? "updated" : "created",
      };
    },
    async deletePublishedSolution(id, opts) {
      opsCalls.push(["deletePublishedSolution", id, opts]);
      return {
        data: { deleted: true },
        clearedAgentIds: ["local-agent-1"],
        clearedSkillLinks: ["owned-skill"],
      };
    },
    // The unpublish route's pre-confirmation dependency fast-fail. Clean by
    // default; tests inject assertUnpublishableImpl to simulate a skill some
    // published agent still references.
    async assertSolutionUnpublishableOnMarketplace(id, solutionType) {
      opsCalls.push(["assertSolutionUnpublishableOnMarketplace", id, solutionType]);
      if (typeof assertUnpublishableImpl === "function") {
        return await assertUnpublishableImpl(id, solutionType);
      }
      return undefined;
    },
    async updatePublishedSolution(id, patch, opts) {
      opsCalls.push(["updatePublishedSolution", id, patch, opts]);
      return { id };
    },
  };

  // The chat-modal-routing stub reports windowId 7; flow entries adopt it as
  // ownerWindowId, so owner-targeted pushes (terminals, publish outcomes) land
  // here and are capturable. getAllWindows stays empty so fallback paths
  // (native dialog window pick, all-window broadcasts) keep their shapes.
  const windowSends = [];
  const fakeOwnerWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (channel, payload) => windowSends.push([channel, payload]),
    },
  };
  const electronStub = {
    app: { getPath: () => "/tmp", getVersion: () => "0.0.0-test", isPackaged: false },
    BrowserWindow: {
      getFocusedWindow: () => null,
      getAllWindows: () => [],
      fromId: (id) => (Number(id) === 7 ? fakeOwnerWindow : null),
      fromWebContents: () => null,
    },
    dialog: {
      async showMessageBox(...args) {
        dialogCalls.push(args);
        return { response: 1 };
      },
    },
  };

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return electronStub;
    if (
      parent?.filename === API_PATH &&
      (request.startsWith("./") || request.startsWith("../"))
    ) {
      if (REAL_API_RELATIVE.has(request)) {
        return originalLoad.apply(this, [request, parent, isMain]);
      }
      if (request === "./ai-marketplace-operations") return opsFake;
      if (request === "./ai-marketplace-skill-links") {
        return (
          skillLinksImpl || {
            canonicalSkillName: (value) =>
              String(value || "").split("/").filter(Boolean).at(-1) || "",
            getLink: async () => null,
          }
        );
      }
      if (request === "./chat-modal-routing") {
        return {
          sendModalRequestToChatWindow({ channel, payload }) {
            broadcasts.push([channel, payload]);
            return control.deliverySent
              ? { sent: true, windowId: 7, reason: "test", matchedViewKey: "main" }
              : { sent: false, reason: "no-window" };
          },
          findOwuiViewForChatId() {
            return null;
          },
        };
      }
      if (request === "./workspace-file-serving") {
        return { registerWorkspaceFileRoute() {} };
      }
      if (request === "./marketplace-auto-approve") {
        return {
          // Honors api.js's isDevBuild computation so tests can prove the
          // non-dev clamp by flipping state.buildInfo.buildNumber.
          resolveMarketplaceAutoApprove: ({ isDevBuild }) =>
            isDevBuild === true && control.autoApprove === true,
        };
      }
      if (request === "./bootstrap") {
        return {
          PROJECT_ROOT: "/tmp",
          sendInitLog() {},
          killProcessOnPort: async () => {},
        };
      }
      if (request === "./owui-views") {
        return {
          broadcastToOwnerViews(windowId, channel, payload) {
            ownerBroadcasts.push([windowId, channel, payload]);
          },
          broadcastToViews() {},
          getViewKeyForContents() {
            return null;
          },
          getViewState() {
            return null;
          },
        };
      }
      return {};
    }
    return originalLoad.apply(this, [request, parent, isMain]);
  };

  const previousApi = require.cache[API_PATH];
  delete require.cache[API_PATH];
  let api;
  try {
    api = require(API_PATH);
  } finally {
    Module._load = originalLoad;
    delete require.cache[API_PATH];
    if (previousApi) require.cache[API_PATH] = previousApi;
  }

  const app = api.createApiServer();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;

  return {
    opsCalls,
    broadcasts,
    dialogCalls,
    ownerBroadcasts,
    windowSends,
    control,
    async post(route, body) {
      const res = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      return { status: res.status, body: await res.json() };
    },
    async get(route) {
      const res = await fetch(`http://127.0.0.1:${port}${route}`);
      return { status: res.status, body: await res.json() };
    },
    // Poll the flow-status endpoint (the polling MCP proxy's contract) until
    // the route outcome lands.
    async waitForFlowOutcome(flowId, { attempts = 200 } = {}) {
      for (let i = 0; i < attempts; i += 1) {
        const res = await fetch(
          `http://127.0.0.1:${port}/api/ai-marketplace/publish-flow-status/${flowId}`,
        );
        const body = await res.json();
        if (body.status === "completed") return body;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`publish flow ${flowId} never completed`);
    },
    async waitForFlowEntry() {
      // Real-time wait: prefetch fixtures may take over a second.
      for (let i = 0; i < 500; i += 1) {
        const entry = [...state.marketplacePublishFlowResults.values()].find(
          (candidate) => candidate.status === "in_progress",
        );
        if (entry) return entry;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("no in-progress marketplace publish flow appeared");
    },
    completeFlow(entry, approved) {
      // The exact sequence the ipc completion handler performs.
      const result = approved
        ? flows.buildMarketplacePublishApprovedResult(entry)
        : flows.buildMarketplacePublishDeniedResult(entry);
      state.completeMarketplacePublishFlow(entry.flowId, result);
      entry.resolveDecision?.(flows.marketplacePublishDecisionFromResult(result));
    },
    completeFlowWith(entry, result) {
      // Terminal completion with a pre-built flow result (published /
      // publish_failed / …) — same sequence as the ipc handler.
      state.completeMarketplacePublishFlow(entry.flowId, result);
      entry.resolveDecision?.(flows.marketplacePublishDecisionFromResult(result));
    },
    close() {
      clearFlowTimers();
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

test("every marketplace route responds through the success/error envelope", async (t) => {
  const harness = await loadApiHarness();
  t.after(() => harness.close());

  // Read/install routes answer without any confirmation gate.
  for (const [route, body] of [
    ["/api/ai-marketplace/search", {}],
    ["/api/ai-marketplace/get-solution", { id: "sol-1" }],
    ["/api/ai-marketplace/get-bundle", { id: "sol-1" }],
    ["/api/ai-marketplace/list-published", { type: "agents" }],
    ["/api/ai-marketplace/install", { id: "sol-1" }],
    ["/api/ai-marketplace/reclaim-agent", { agent_id: "zzz-copy" }],
    ["/api/ai-marketplace/reclaim-skill", { skill_id: "ai-marketplace/example-skill" }],
    ["/api/ai-marketplace/update", { id: "sol-1", patch: {} }],
  ]) {
    const res = await harness.post(route, body);
    assert.equal(res.status, 200, route);
    assert.equal(res.body.success, true, route);
  }
  assert.ok(!harness.broadcasts.length, "reads/installs never open the confirm modal");
  assert.ok(!harness.dialogCalls.length, "reads/installs never open the native dialog");

  // Errors come back as HTTP 200 with a { success:false } envelope so the MCP
  // proxy reads the structured error instead of an HTTP throw.
  harness.opsCalls.length = 0;
  const failing = await loadApiHarness({
    getAgentForPublishImpl: async () => {
      const error = new Error("agent is unreadable");
      error.code = "agent_unreadable";
      throw error;
    },
  });
  t.after(() => failing.close());
  const errorRes = await failing.post("/api/ai-marketplace/publish-agent", {
    agent_id: "agent-broken",
  });
  assert.equal(errorRes.status, 200);
  assert.equal(errorRes.body.success, false);
  assert.equal(errorRes.body.code, "agent_unreadable");
  assert.match(errorRes.body.error, /agent is unreadable/);
  // Fetch-before-confirm: the failure surfaced with NO confirmation UI.
  assert.equal(failing.broadcasts.length, 0);
  assert.equal(failing.dialogCalls.length, 0);
});

test("reclaim routes convert in place with no confirmation flow", async (t) => {
  const harness = await loadApiHarness();
  t.after(() => harness.close());

  const agentRes = await harness.post("/api/ai-marketplace/reclaim-agent", {
    agent_id: "zzz-copy",
  });
  assert.equal(agentRes.status, 200);
  assert.deepEqual(agentRes.body, {
    success: true,
    data: {
      local_agent_id: "zzz-copy",
      solution_id: "sol-1",
      link: { relationship: "published" },
    },
  });
  // camelCase body form is accepted like the sibling routes.
  await harness.post("/api/ai-marketplace/reclaim-agent", { agentId: "zzz-copy-2" });
  assert.deepEqual(
    harness.opsCalls
      .filter(([name]) => name === "reclaimInstalledAgent")
      .map(([, id]) => id),
    ["zzz-copy", "zzz-copy-2"],
  );

  const skillRes = await harness.post("/api/ai-marketplace/reclaim-skill", {
    skill_id: "ai-marketplace/example-skill",
  });
  assert.equal(skillRes.body.success, true);
  assert.equal(
    skillRes.body.data.local_skill_id,
    "example-skill-2",
    "the (possibly collision-suffixed) final skill id passes through",
  );

  // Local-only conversion: no confirm modal, no native dialog.
  assert.equal(harness.broadcasts.length, 0);
  assert.equal(harness.dialogCalls.length, 0);

  // Tagged failures keep the HTTP-200 structured envelope the MCP proxy
  // depends on (code/remediation/body survive).
  const failing = await loadApiHarness({
    reclaimAgentImpl: async () => {
      const error = new Error('Agent "zzz-copy" is not an installed Marketplace copy.');
      error.code = "marketplace_relationship_mismatch";
      error.remediation =
        "Only an installed Marketplace copy of a listing you authored can be converted to an editable copy.";
      error.body = { local_agent_id: "zzz-copy", relationship: "published" };
      throw error;
    },
  });
  t.after(() => failing.close());
  const errRes = await failing.post("/api/ai-marketplace/reclaim-agent", {
    agent_id: "zzz-copy",
  });
  assert.equal(errRes.status, 200);
  assert.equal(errRes.body.success, false);
  assert.equal(errRes.body.code, "marketplace_relationship_mismatch");
  assert.match(errRes.body.remediation, /installed Marketplace copy/);
  assert.equal(errRes.body.body.relationship, "published");
});

test("publish-agent prefetches, confirms via the modal flow, and publishes only on approval", async (t) => {
  const harness = await loadApiHarness();
  t.after(() => harness.close());

  // Flow-status polling contract (same as ask_user_question): the START call
  // answers immediately with the pending flow id — no HTTP call blocks on
  // the user.
  const startRes = await harness.post("/api/ai-marketplace/publish-agent", {
    agent_id: "agent-1",
    allowed_emails: ["teammate@example.invalid"],
  });
  assert.equal(startRes.body.success, true);
  assert.equal(startRes.body.status, "pending");
  assert.ok(startRes.body.flow_id, "the START response carries the flow id");
  const entry = state.marketplacePublishFlowResults.get(startRes.body.flow_id);
  assert.ok(entry, "the flow is registered before the START response");

  // The agent was fetched BEFORE the confirmation broadcast, and the modal
  // payload carries the real (display-only) agent + bounded prompt preview.
  assert.equal(harness.opsCalls[0][0], "getAgentForPublish");
  assert.equal(harness.broadcasts.length, 1);
  const [channel, payload] = harness.broadcasts[0];
  assert.equal(channel, "ai-marketplace-publish-confirm-requested");
  assert.equal(payload.mode, "publish-agent");
  assert.equal(payload.flow_id, entry.flowId);
  assert.equal(payload.agent.id, "agent-1");
  assert.equal(payload.agent.system_prompt_preview.length, 400);
  assert.ok(payload.agent.system_prompt_length > 400);
  assert.deepEqual(payload.allowed_emails, ["teammate@example.invalid"]);
  assert.equal(payload.republish, false);
  // The full five-minute decision window, wired to auto-deny.
  assert.ok(payload.timeout_seconds >= 30 && payload.timeout_seconds <= 300);
  assert.ok(entry.timeoutHandle, "flow carries the auto-deny timeout");
  assert.equal(entry.ownerWindowId, 7, "flow is bound to the delivery window");
  // The owning window got a native-input presentation snapshot with the kind.
  const snapshotBroadcast = harness.ownerBroadcasts.find(
    ([, snapshotChannel]) => snapshotChannel === "owui-native-input-presentation-snapshot",
  );
  assert.ok(snapshotBroadcast);
  assert.equal(snapshotBroadcast[2].flows[0].kind, "marketplace_publish");

  // The status endpoint reports in_progress and no write has happened while
  // the flow waits on the user.
  const pending = await harness.get(
    `/api/ai-marketplace/publish-flow-status/${entry.flowId}`,
  );
  assert.equal(pending.body.status, "in_progress");
  assert.ok(!harness.opsCalls.some(([name]) => name === "buildAndPublishAgent"));

  harness.completeFlow(entry, true);
  const outcome = await harness.waitForFlowOutcome(entry.flowId);
  assert.deepEqual(outcome.result, { success: true, data: { id: "new-sol" } });
  const publishCall = harness.opsCalls.find(([name]) => name === "buildAndPublishAgent");
  assert.ok(publishCall, "approval releases the real publish");
  assert.equal(publishCall[1].agentId, "agent-1");
  assert.ok(publishCall[1].prefetched, "the prefetched agent is reused, not refetched");

  // Denial: the outcome resolves { success:false, denied:true } and never writes.
  const denyStart = await harness.post("/api/ai-marketplace/publish-agent", {
    agent_id: "agent-2",
  });
  assert.equal(denyStart.body.status, "pending");
  const denyEntry = state.marketplacePublishFlowResults.get(denyStart.body.flow_id);
  harness.completeFlow(denyEntry, false);
  const denyOutcome = await harness.waitForFlowOutcome(denyEntry.flowId);
  assert.equal(denyOutcome.result.success, false);
  assert.equal(denyOutcome.result.denied, true);
  assert.equal(
    harness.opsCalls.filter(([name]) => name === "buildAndPublishAgent").length,
    1,
    "denied publishes never reach the marketplace",
  );

  // Unknown flows 404 through the status endpoint.
  const missing = await harness.get("/api/ai-marketplace/publish-flow-status/nope");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.success, false);
});

// Round 8 (modal consolidation): approving in the app runs the FULL publish
// pipeline in the renderer (dependent skills + skill_refs); the route learns
// the outcome through the two-phase completion contract instead of publishing
// main-side.
test("renderer-executed publish resolves the flow outcome with no main-side publish", async (t) => {
  const harness = await loadApiHarness();
  t.after(() => harness.close());

  const startRes = await harness.post("/api/ai-marketplace/publish-agent", {
    agent_id: "agent-1",
  });
  assert.equal(startRes.body.status, "pending");
  const entry = state.marketplacePublishFlowResults.get(startRes.body.flow_id);

  // Phase 1: the renderer signals "publishing" — the confirm deny-timer is
  // swapped one-shot for the publish budget and the flow stays open.
  const denyTimer = entry.timeoutHandle;
  assert.equal(typeof entry.onPublishing, "function");
  assert.equal(entry.onPublishing(), true);
  assert.equal(entry.phase, "publishing");
  assert.ok(entry.timeoutHandle, "a publish-budget timer replaced the deny timer");
  assert.notEqual(entry.timeoutHandle, denyTimer);
  assert.equal(entry.status, "in_progress", "publishing is non-terminal");
  assert.equal(entry.onPublishing(), false, "the phase transition is one-shot");

  // Phase 2: the renderer reports the publish result; the flow outcome
  // carries it verbatim (sanitized) and never calls the main-side publisher.
  harness.completeFlowWith(
    entry,
    flows.buildMarketplacePublishPublishedResult(entry, {
      result: {
        solution_id: "sol-renderer",
        status: "active",
        has_bundle: true,
        action: "updated",
        name: "Helper",
        local_agent_id: "agent-1",
        dependent_skills: { published: 1, updated: 0, adopted: 0, referenced: 2, unchanged: 0, gitReferenced: 1, repaired: 0 },
        skills: [
          {
            skill_id: "loupe",
            outcome: "published",
            solution_id: "sol-skill-loupe",
            rogue: "dropped",
          },
        ],
        message: "Marketplace copy updated (solution sol-renderer). Skills: 1 skill published.",
      },
    }),
  );
  const outcome = await harness.waitForFlowOutcome(entry.flowId);
  assert.equal(outcome.result.success, true);
  assert.equal(outcome.result.data.solution_id, "sol-renderer");
  assert.equal(outcome.result.data.publishStatus.id, "sol-renderer");
  assert.equal(outcome.result.data.dependent_skills.published, 1);
  // The per-skill rows survive sanitization onto the exact surface the chat
  // proxy polls, with unknown keys stripped.
  assert.deepEqual(JSON.parse(JSON.stringify(outcome.result.data.skills)), [
    { skill_id: "loupe", outcome: "published", solution_id: "sol-skill-loupe" },
  ]);
  assert.ok(
    !harness.opsCalls.some(([name]) => name === "buildAndPublishAgent"),
    "renderer-published flows never reach the main-side publisher",
  );
});

test("renderer publish failures and unknown outcomes resolve structured envelopes", async (t) => {
  const harness = await loadApiHarness();
  t.after(() => harness.close());

  // publish_failed → structured failure with code + remediation.
  const failStart = await harness.post("/api/ai-marketplace/publish-agent", {
    agent_id: "agent-1",
  });
  const failEntry = state.marketplacePublishFlowResults.get(failStart.body.flow_id);
  failEntry.onPublishing();
  harness.completeFlowWith(
    failEntry,
    flows.buildMarketplacePublishFailedResult(failEntry, {
      error: "Failed to publish dependent skill solutions: loupe (boom).",
      code: "dependent_skill_publish_failed",
    }),
  );
  const failOutcome = await harness.waitForFlowOutcome(failEntry.flowId);
  assert.equal(failOutcome.result.success, false);
  assert.equal(failOutcome.result.code, "dependent_skill_publish_failed");
  assert.match(failOutcome.result.error, /loupe/);
  assert.match(failOutcome.result.remediation, /retry it from the Agents tab/);
  assert.ok(!harness.opsCalls.some(([name]) => name === "buildAndPublishAgent"));

  // publish-budget expiry → publish_outcome_unknown envelope.
  const hangStart = await harness.post("/api/ai-marketplace/publish-agent", {
    agent_id: "agent-2",
  });
  const hangEntry = state.marketplacePublishFlowResults.get(hangStart.body.flow_id);
  hangEntry.onPublishing();
  harness.completeFlowWith(
    hangEntry,
    flows.buildMarketplacePublishUnknownOutcomeResult(hangEntry),
  );
  const hangOutcome = await harness.waitForFlowOutcome(hangEntry.flowId);
  assert.equal(hangOutcome.result.success, false);
  assert.equal(hangOutcome.result.code, "publish_outcome_unknown");
  assert.match(hangOutcome.result.error, /Agents tab/);
});

test("the cancel endpoint dismisses a pending publish flow (proxy abandonment hook)", async (t) => {
  const harness = await loadApiHarness();
  t.after(() => harness.close());

  const startRes = await harness.post("/api/ai-marketplace/publish-agent", {
    agent_id: "agent-1",
  });
  const flowId = startRes.body.flow_id;
  const cancelled = await harness.post("/api/ai-marketplace/cancel-publish-flow", {
    flow_id: flowId,
    reason: "tool_timeout",
  });
  assert.equal(cancelled.body.status, "cancelled");
  // The cancellation terminates the flow; the continuation resolves an
  // HONEST cancelled envelope (not a fake user denial) so a late poll still
  // reads a settled outcome the model can act on.
  const outcome = await harness.waitForFlowOutcome(flowId);
  assert.equal(outcome.result.success, false);
  assert.equal(outcome.result.code, "approval_cancelled");
  assert.ok(!outcome.result.denied, "cancellation is not a user denial");
  // Idempotent: a second cancel reports already_completed.
  const again = await harness.post("/api/ai-marketplace/cancel-publish-flow", {
    flow_id: flowId,
  });
  assert.equal(again.body.status, "already_completed");
  assert.ok(!harness.opsCalls.some(([name]) => name === "buildAndPublishAgent"));
});

test("a slow prefetch shaves the modal budget below the confirm ceiling", async (t) => {
  const harness = await loadApiHarness({
    getAgentForPublishImpl: async (agentId) => {
      await new Promise((resolve) => setTimeout(resolve, 1100));
      return {
        agent: { id: agentId, name: "Slow Agent", description: "", skill_ids: [], tool_server_ids: [] },
        systemPrompt: "p",
      };
    },
  });
  t.after(() => harness.close());

  const publishPromise = harness.post("/api/ai-marketplace/publish-agent", {
    agent_id: "agent-slow",
  });
  const entry = await harness.waitForFlowEntry();
  const [, payload] = harness.broadcasts[0];
  assert.ok(
    payload.timeout_seconds < 300 && payload.timeout_seconds >= 30,
    `prefetch time is deducted from the modal budget (got ${payload.timeout_seconds})`,
  );
  harness.completeFlow(entry, false);
  await publishPromise;
});

test("a failed modal delivery falls back to the native confirmation dialog", async (t) => {
  const harness = await loadApiHarness();
  t.after(() => harness.close());
  harness.control.deliverySent = false;

  const res = await harness.post("/api/ai-marketplace/publish-agent", { agent_id: "agent-1" });
  // The native dialog approved (fixture returns the confirm button) so the
  // publish still went through — via the fallback, not the modal flow.
  assert.equal(res.body.success, true);
  assert.equal(harness.dialogCalls.length, 1);
  const options = harness.dialogCalls[0][0];
  assert.match(options.message, /Publish agent "agent-1" to the AI Marketplace\?/);
  assert.deepEqual(options.buttons.slice(0, 1), ["Cancel"]);
  // The failed flow was terminated rather than leaking as in-progress.
  const leaked = [...state.marketplacePublishFlowResults.values()].filter(
    (entry) => entry.status === "in_progress",
  );
  assert.equal(leaked.length, 0);
});

test("publish-skill and unpublish flows carry the display-only skill card payload", async (t) => {
  const harness = await loadApiHarness();
  t.after(() => harness.close());

  // publish-skill: skill prefetch happens BEFORE the confirmation, and a
  // republish forwards the published flag so the card shows its real state.
  const skillStart = await harness.post("/api/ai-marketplace/publish-skill", {
    skill_id: "my-skill",
    existing_solution_id: "sol-existing",
  });
  assert.equal(skillStart.body.status, "pending");
  const skillEntry = state.marketplacePublishFlowResults.get(skillStart.body.flow_id);
  assert.equal(harness.opsCalls[0][0], "getSkillForPublish");
  const [, skillPayload] = harness.broadcasts[0];
  assert.equal(skillPayload.mode, "publish-skill");
  assert.equal(skillPayload.republish, true);
  assert.equal(skillPayload.confirm_label, "Republish");
  assert.equal(skillPayload.skill.name, "my-skill");
  assert.equal(skillPayload.skill.published, true);
  assert.ok(skillPayload.timeout_seconds <= 300);
  assert.ok(!harness.opsCalls.some(([name]) => name === "buildAndPublishSkill"));
  harness.completeFlow(skillEntry, true);
  const skillOutcome = await harness.waitForFlowOutcome(skillEntry.flowId);
  assert.equal(skillOutcome.result.success, true);
  assert.ok(harness.opsCalls.some(([name]) => name === "buildAndPublishSkill"));
  // Flat identity envelope (publish-agent parity): the chat model reads the
  // id, action, and message straight off the result — no raw marketplace echo.
  assert.equal(skillOutcome.result.data.solution_id, "new-skill-sol");
  assert.equal(skillOutcome.result.data.skill_id, "my-skill");
  assert.equal(skillOutcome.result.data.action, "updated");
  assert.match(
    skillOutcome.result.data.message,
    /Skill "my-skill" marketplace copy updated \(solution new-skill-sol\)/,
  );
  assert.deepEqual(skillOutcome.result.data.data, {
    id: "new-skill-sol",
    status: "active",
    has_bundle: true,
  });

  // unpublish: ownership + type are proven BEFORE any confirmation UI, the
  // human-named skill card replaces the bare solution id, and approval passes
  // ownershipChecked to the delete.
  harness.broadcasts.length = 0;
  const unpublishStart = await harness.post("/api/ai-marketplace/unpublish", {
    id: "sol-owned",
    expected_type: "skills",
  });
  assert.equal(unpublishStart.body.status, "pending");
  const unpublishEntry = state.marketplacePublishFlowResults.get(
    unpublishStart.body.flow_id,
  );
  const ownershipIndex = harness.opsCalls.findIndex(
    ([name]) => name === "getOwnedSolutionForWrite",
  );
  assert.ok(ownershipIndex >= 0, "ownership is proven via the owned-solution read");
  // The published-agent dependency fast-fail runs after ownership but before
  // the confirmation modal ever shows.
  const dependencyIndex = harness.opsCalls.findIndex(
    ([name]) => name === "assertSolutionUnpublishableOnMarketplace",
  );
  assert.ok(
    dependencyIndex > ownershipIndex,
    "dependency check runs pre-confirmation on the proven skill target",
  );
  const [, unpublishPayload] = harness.broadcasts[0];
  assert.equal(unpublishPayload.mode, "unpublish");
  assert.match(unpublishPayload.title, /Remove "Owned Skill" from the AI Marketplace/);
  assert.equal(unpublishPayload.skill.name, "Owned Skill");
  assert.equal(unpublishPayload.skill.published, true);
  assert.equal(unpublishPayload.skill.version, "2.0");
  // USER-source cards render the owner badge from the authenticated creator;
  // the listing's submitted_by feeds it (author alone renders "Unknown").
  assert.equal(unpublishPayload.skill.created_by_email, "dsantiago");
  // The approval item identifies its target: id badge + type chip data.
  assert.equal(unpublishPayload.solution_id, "sol-owned");
  assert.equal(unpublishPayload.solution_type, "skills");
  assert.equal(unpublishPayload.agent, null, "skill targets never grow an agent card");
  harness.completeFlow(unpublishEntry, true);
  const unpublishOutcome = await harness.waitForFlowOutcome(unpublishEntry.flowId);
  assert.equal(unpublishOutcome.result.success, true);
  // Identity envelope: what was removed plus the local links it cleared.
  assert.equal(unpublishOutcome.result.data.action, "unpublished");
  assert.equal(unpublishOutcome.result.data.solution_id, "sol-owned");
  assert.equal(unpublishOutcome.result.data.name, "Owned Skill");
  assert.match(
    unpublishOutcome.result.data.message,
    /"Owned Skill" \(solution sol-owned\) removed from the AI Marketplace/,
  );
  assert.deepEqual(unpublishOutcome.result.data.skill_links_cleared, ["owned-skill"]);
  assert.ok(
    !("dependent_skill_listings" in unpublishOutcome.result.data),
    "skill targets carry no dependent-listing hint",
  );
  const deleteCall = harness.opsCalls.find(([name]) => name === "deletePublishedSolution");
  assert.ok(deleteCall);
  assert.equal(deleteCall[1], "sol-owned");
  assert.deepEqual(deleteCall[2], {
    expectedType: "skills",
    ownershipChecked: true,
    // The route's ownership preflight threads the proven type through so the
    // referential-integrity unpublish guard never re-fetches it.
    ownedSolutionType: "skills",
  });
});

test("agent-type unpublish carries a synthesized agent card payload and skips the skill dependency check", async (t) => {
  const harness = await loadApiHarness({
    getOwnedSolutionImpl: async (id) => ({
      id,
      name: "dsantiago Awesome Agent",
      type: "portico-agents",
      description: "writing assistant",
      submitted_by: "dsantiago",
      // The publish flow spreads the bundle payload top-level onto the
      // listing — these flattened facts feed the display-only agent card.
      base_model_id: "GPT-5.6 Sol",
      reasoning_effort: "max",
      skill_ids: ["architecture-diagrams", "release-notes-sample"],
      tool_server_ids: ["server:datadog"],
    }),
  });
  t.after(() => harness.close());

  const start = await harness.post("/api/ai-marketplace/unpublish", {
    id: "sol-agent",
    expected_type: "portico-agents",
  });
  assert.equal(start.body.status, "pending");
  const entry = state.marketplacePublishFlowResults.get(start.body.flow_id);

  const [, payload] = harness.broadcasts[0];
  assert.equal(payload.mode, "unpublish");
  assert.equal(payload.solution_id, "sol-agent");
  assert.equal(payload.solution_type, "agents");
  assert.equal(payload.skill, null);
  assert.equal(payload.agent.id, "sol-agent", "display id doubles as the solution id");
  assert.equal(payload.agent.name, "dsantiago Awesome Agent");
  assert.equal(payload.agent.base_model_id, "GPT-5.6 Sol");
  assert.deepEqual(payload.agent.skill_ids, [
    "architecture-diagrams",
    "release-notes-sample",
  ]);
  // The published-agent dependency rule guards SKILL listings only.
  assert.ok(
    !harness.opsCalls.some(([name]) => name === "assertSolutionUnpublishableOnMarketplace"),
    "agent targets skip the skill dependency sweep",
  );
  // Flattened listings never need the bundle recovery fetch.
  assert.ok(
    !harness.opsCalls.some(([name]) => name === "getBundle"),
    "flattened card fields skip the bundle fetch",
  );
  harness.completeFlow(entry, false);
  const outcome = await harness.waitForFlowOutcome(entry.flowId);
  assert.equal(outcome.result.denied, true, "a real user denial stays denied:true");
});

// Renderer-published listings historically carried NO flattened card fields —
// the card facts live only in the published bundle payload. The unpublish
// route recovers them (one bundle fetch, reused for dependent listings) so
// the confirmation card shows the model/effort/skills/tools.
test("agent-type unpublish recovers card facts from the bundle for trimmed listings", async (t) => {
  const harness = await loadApiHarness({
    getOwnedSolutionImpl: async (id) => ({
      id,
      name: "Renderer Published Agent",
      type: "portico-agents",
      description: "",
      submitted_by: "dsantiago",
      has_bundle: true,
    }),
    getBundleImpl: async () => ({
      payload: {
        name: "Renderer Published Agent",
        description: "recovered description",
        base_model_id: "Claude Opus 5",
        reasoning_effort: "high",
        skill_ids: ["architecture-diagrams"],
        tool_server_ids: ["server:glean"],
        skill_refs: [
          {
            skill_id: "architecture-diagrams",
            kind: "solution",
            solution_id: "sol-skill-9",
          },
        ],
      },
    }),
  });
  t.after(() => harness.close());

  const start = await harness.post("/api/ai-marketplace/unpublish", {
    id: "sol-agent",
    expected_type: "portico-agents",
  });
  assert.equal(start.body.status, "pending");
  const entry = state.marketplacePublishFlowResults.get(start.body.flow_id);

  const [, payload] = harness.broadcasts[0];
  assert.equal(payload.agent.base_model_id, "Claude Opus 5");
  assert.equal(payload.agent.reasoning_effort, "high");
  assert.deepEqual(payload.agent.skill_ids, ["architecture-diagrams"]);
  assert.deepEqual(payload.agent.tool_server_ids, ["server:glean"]);
  assert.equal(payload.agent.description, "recovered description");
  assert.equal(
    harness.opsCalls.filter(([name]) => name === "getBundle").length,
    1,
    "one recovery fetch",
  );

  harness.completeFlow(entry, true);
  const outcome = await harness.waitForFlowOutcome(entry.flowId);
  assert.deepEqual(
    outcome.result.data.dependent_skill_listings,
    [{ skill_id: "architecture-diagrams", solution_id: "sol-skill-9" }],
    "the recovered payload feeds dependent listings",
  );
  assert.equal(
    harness.opsCalls.filter(([name]) => name === "getBundle").length,
    1,
    "no second bundle fetch at execution time",
  );
});

// The batch modal keeps approved main-side items busy until this push: after
// a route continuation stashes its final envelope for the polling proxy, the
// SAME outcome goes to the owner window, flow-keyed.
test("route continuations push a flow-keyed outcome to the owner window after stashing", async (t) => {
  const harness = await loadApiHarness();
  t.after(() => harness.close());

  const start = await harness.post("/api/ai-marketplace/unpublish", {
    id: "sol-skill",
    expected_type: "skills",
  });
  const entry = state.marketplacePublishFlowResults.get(start.body.flow_id);
  harness.completeFlow(entry, true);
  await harness.waitForFlowOutcome(entry.flowId);
  const outcomes = harness.windowSends.filter(
    ([channel]) => channel === "ai-marketplace-publish-outcome",
  );
  assert.equal(outcomes.length, 1, "one push per settled flow");
  assert.equal(outcomes[0][1].flow_id, entry.flowId);
  assert.equal(outcomes[0][1].ok, true);
  assert.match(outcomes[0][1].message, /removed from the AI Marketplace/);

  // A denial pushes ok:false with the failure message.
  const denied = await harness.post("/api/ai-marketplace/unpublish", {
    id: "sol-skill-2",
    expected_type: "skills",
  });
  const deniedEntry = state.marketplacePublishFlowResults.get(denied.body.flow_id);
  harness.completeFlow(deniedEntry, false);
  await harness.waitForFlowOutcome(deniedEntry.flowId);
  const deniedOutcome = harness.windowSends
    .filter(([channel]) => channel === "ai-marketplace-publish-outcome")
    .at(-1);
  assert.equal(deniedOutcome[1].flow_id, deniedEntry.flowId);
  assert.equal(deniedOutcome[1].ok, false);
  assert.match(deniedOutcome[1].message, /not confirmed/);
});

// PORTICO-347: an approved agent unpublish reports what it touched — the local
// agents it unlinked and the dependent skill LISTINGS that remain published,
// whose ids feed the natural next unpublish without a listing round-trip.
test("agent unpublish reports dependent skill listings that remain published", async (t) => {
  const harness = await loadApiHarness({
    getOwnedSolutionImpl: async (id) => ({
      id,
      name: "Toolchain Agent",
      type: "portico-agents",
      submitted_by: "dsantiago",
      skill_ids: ["synthetic-skill", "git-skill"],
      // The publish flow spreads the bundle payload top-level onto the
      // listing; solution-kind refs carry the ids, git refs do not.
      skill_refs: [
        { skill_id: "synthetic-skill", kind: "solution", solution_id: "sol-skill-1" },
        { skill_id: "git-skill", kind: "git-marketplace", solution_id: null },
        { skill_id: "synthetic-skill", kind: "solution", solution_id: "sol-skill-1" },
      ],
    }),
  });
  t.after(() => harness.close());

  const start = await harness.post("/api/ai-marketplace/unpublish", {
    id: "sol-agent",
    expected_type: "portico-agents",
  });
  const entry = state.marketplacePublishFlowResults.get(start.body.flow_id);
  harness.completeFlow(entry, true);
  const outcome = await harness.waitForFlowOutcome(entry.flowId);
  assert.equal(outcome.result.success, true);
  const data = outcome.result.data;
  assert.equal(data.action, "unpublished");
  assert.equal(data.solution_id, "sol-agent");
  assert.equal(data.name, "Toolchain Agent");
  assert.deepEqual(data.local_agent_ids_unlinked, ["local-agent-1"]);
  assert.deepEqual(
    data.dependent_skill_listings,
    [{ skill_id: "synthetic-skill", solution_id: "sol-skill-1" }],
    "solution-kind refs only, deduped; git refs have no listing to unpublish",
  );
  assert.ok(!("skill_links_cleared" in data), "agent targets report agent links");
});

test("agent unpublish falls back to the skill-links registry when the listing has no refs", async (t) => {
  const harness = await loadApiHarness({
    getOwnedSolutionImpl: async (id) => ({
      id,
      name: "Legacy Agent",
      type: "portico-agents",
      submitted_by: "dsantiago",
      skill_ids: ["plugin/legacy-skill", "unlinked-skill"],
    }),
    skillLinksImpl: {
      canonicalSkillName: (value) =>
        String(value || "").split("/").filter(Boolean).at(-1) || "",
      getLink: async (name) =>
        name === "legacy-skill" ? { solutionId: "sol-legacy" } : null,
    },
  });
  t.after(() => harness.close());

  const start = await harness.post("/api/ai-marketplace/unpublish", {
    id: "sol-agent-legacy",
    expected_type: "portico-agents",
  });
  const entry = state.marketplacePublishFlowResults.get(start.body.flow_id);
  harness.completeFlow(entry, true);
  const outcome = await harness.waitForFlowOutcome(entry.flowId);
  assert.deepEqual(outcome.result.data.dependent_skill_listings, [
    { skill_id: "legacy-skill", solution_id: "sol-legacy" },
  ]);
});

// PORTICO-347: the chat-facing list-published surface is a whitelist projection.
// The raw payload's full SKILL.md body plus *_semantic duplicates (~24 KB per
// skill) are the haystack a chat model mistranscribed a UUID out of; identity,
// status, and dependency facts survive, blobs do not. UI/IPC consumers keep
// the untrimmed payload on their own channel.
test("list-published projects chat payloads down to whitelisted fields", async (t) => {
  const harness = await loadApiHarness({
    listPublishedImpl: async () => ({
      solutions: [
        {
          id: "sol-1",
          name: "synthetic-skill",
          display_name: "Synthetic Skill",
          type: "skills",
          status: "active",
          publication_state: "discoverable",
          submitted_by: "dsantiago",
          used_by_published_agents: [{ id: "sol-agent", name: "Agent" }],
          comment: "# Full SKILL.md body\n".repeat(200),
          comment_semantic: "semantic dupe ".repeat(200),
          description_semantic: "semantic dupe",
          name_semantic: "synthetic-skill",
          version_history: [{ version_id: "v1" }],
          bundle: { payload: { skill_md: "huge" } },
          previous_values: { name: "old" },
        },
      ],
    }),
  });
  t.after(() => harness.close());

  const res = await harness.post("/api/ai-marketplace/list-published", {
    type: "skills",
  });
  assert.equal(res.body.success, true);
  assert.deepEqual(res.body.data.solutions, [
    {
      id: "sol-1",
      name: "synthetic-skill",
      display_name: "Synthetic Skill",
      type: "skills",
      status: "active",
      publication_state: "discoverable",
      submitted_by: "dsantiago",
      used_by_published_agents: [{ id: "sol-agent", name: "Agent" }],
    },
  ]);
});

// K1: the get-solution agent surface (get_marketplace_solution AND
// get_marketplace_agent ride this one route) must never forward full bundle
// content into LLM context, REGARDLESS of the remote's shape — sandbox
// deployments inline `bundle`, git-backed listings inline
// `resolved_bundle_cache`, and the publish flow's payload spread can echo
// skill_md / system_prompt / references / scripts as plain envelope fields.
// The documented envelope (metadata + has_bundle + dependency facts)
// survives; full content stays behind get-bundle.
test("get-solution strips inline bundle content while keeping the documented envelope", async (t) => {
  let remoteEnvelope = {
    id: "sol-1",
    name: "synthetic-skill",
    display_name: "Synthetic Skill",
    description: "envelope fixture",
    type: "skills",
    status: "active",
    author: "Jane Doe",
    submitted_by: "dsantiago",
    detail_url: "/api/solutions/sol-1/bundle",
    version: "1.2",
    tags: ["docs"],
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-02T00:00:00Z",
    allowed_emails: [],
    required_mcp_servers: ["server:glean"],
    skill_ids: ["synthetic-skill"],
    skill_refs: [
      {
        kind: "solution",
        skill_id: "alpha",
        solution_id: "sol-skill-1",
        comment: "ref-level body blob",
      },
    ],
    // Every observed full-content leak vector at once:
    comment: "# Full SKILL.md body\n".repeat(200),
    comment_semantic: "semantic dupe",
    skill_md: "# Full SKILL.md body",
    system_prompt: "the complete agent prompt",
    references: [{ path: "references/notes.md", content_b64: "aGk=" }],
    scripts: [{ path: "scripts/run.sh", content_b64: "aGk=" }],
    bundle: { type: "skills", payload: { skill_md: "# Full SKILL.md body" } },
    resolved_bundle_cache: {
      bundle: { type: "skills", payload: { skill_md: "resolved body" } },
    },
  };
  const harness = await loadApiHarness({ getSolutionImpl: async () => remoteEnvelope });
  t.after(() => harness.close());

  const res = await harness.post("/api/ai-marketplace/get-solution", { id: "sol-1" });
  assert.equal(res.body.success, true);
  const data = res.body.data;
  for (const key of [
    "bundle",
    "resolved_bundle_cache",
    "comment",
    "comment_semantic",
    "skill_md",
    "system_prompt",
    "references",
    "scripts",
  ]) {
    assert.ok(!(key in data), `${key} never reaches the agent surface`);
  }
  // The remote sent no has_bundle — the dropped inline bundle answers it.
  assert.equal(data.has_bundle, true);
  // Documented metadata and dependency facts survive untouched.
  assert.equal(data.id, "sol-1");
  assert.equal(data.name, "synthetic-skill");
  assert.equal(data.display_name, "Synthetic Skill");
  assert.equal(data.description, "envelope fixture");
  assert.equal(data.type, "skills");
  assert.equal(data.status, "active");
  assert.equal(data.author, "Jane Doe");
  assert.equal(data.submitted_by, "dsantiago");
  assert.equal(data.detail_url, "/api/solutions/sol-1/bundle");
  assert.equal(data.version, "1.2");
  assert.deepEqual(data.tags, ["docs"]);
  assert.deepEqual(data.required_mcp_servers, ["server:glean"]);
  assert.deepEqual(data.skill_ids, ["synthetic-skill"]);
  assert.deepEqual(
    data.skill_refs,
    [{ kind: "solution", skill_id: "alpha", solution_id: "sol-skill-1" }],
    "dependency refs survive; body blobs are stripped at every depth",
  );

  // An explicit remote has_bundle is authoritative — never overwritten, even
  // against a contradictory inline bundle.
  remoteEnvelope = {
    id: "sol-2",
    type: "skills",
    status: "deleted",
    has_bundle: false,
    bundle: { type: "skills", payload: { skill_md: "stale copy" } },
  };
  const tombstone = await harness.post("/api/ai-marketplace/get-solution", { id: "sol-2" });
  assert.equal(tombstone.body.data.has_bundle, false);
  assert.ok(!("bundle" in tombstone.body.data));

  // No bundle anywhere → has_bundle is not invented.
  remoteEnvelope = { id: "sol-3", type: "skills", status: "active" };
  const bundleless = await harness.post("/api/ai-marketplace/get-solution", { id: "sol-3" });
  assert.ok(!("has_bundle" in bundleless.body.data));
});

// K1 caller fix: spec-shaped envelopes (metadata + has_bundle only) carry no
// skill_refs at all, so the agent unpublish resolves them through the
// sanctioned bundle route — and does so BEFORE the delete, while the listing
// still serves its bundle.
test("agent unpublish resolves dependent skill listings via the bundle route for spec-shaped envelopes", async (t) => {
  const harness = await loadApiHarness({
    getOwnedSolutionImpl: async (id) => ({
      id,
      name: "Spec Agent",
      type: "portico-agents",
      submitted_by: "dsantiago",
      has_bundle: true,
    }),
    getBundleImpl: async () => ({
      type: "portico-agents",
      payload: {
        skill_refs: [
          { skill_id: "alpha", kind: "solution", solution_id: "sol-skill-1" },
          { skill_id: "beta", kind: "git-marketplace", solution_id: null },
        ],
      },
    }),
  });
  t.after(() => harness.close());

  const start = await harness.post("/api/ai-marketplace/unpublish", {
    id: "sol-agent-spec",
    expected_type: "portico-agents",
  });
  const entry = state.marketplacePublishFlowResults.get(start.body.flow_id);
  harness.completeFlow(entry, true);
  const outcome = await harness.waitForFlowOutcome(entry.flowId);
  assert.equal(outcome.result.success, true);
  assert.deepEqual(outcome.result.data.dependent_skill_listings, [
    { skill_id: "alpha", solution_id: "sol-skill-1" },
  ]);
  const bundleIndex = harness.opsCalls.findIndex(([name]) => name === "getBundle");
  const deleteIndex = harness.opsCalls.findIndex(
    ([name]) => name === "deletePublishedSolution",
  );
  assert.ok(bundleIndex >= 0, "the refs come from the sanctioned bundle route");
  assert.equal(harness.opsCalls[bundleIndex][1], "sol-agent-spec");
  assert.ok(
    bundleIndex < deleteIndex,
    "the bundle is read before the delete removes it from the marketplace",
  );

  // has_bundle:false says there is nothing to fetch: no bundle round-trip,
  // registry fallback only.
  const flagged = await loadApiHarness({
    getOwnedSolutionImpl: async (id) => ({
      id,
      name: "Bundle-less Agent",
      type: "portico-agents",
      submitted_by: "dsantiago",
      has_bundle: false,
    }),
  });
  t.after(() => flagged.close());
  const flaggedStart = await flagged.post("/api/ai-marketplace/unpublish", {
    id: "sol-agent-flat",
    expected_type: "portico-agents",
  });
  const flaggedEntry = state.marketplacePublishFlowResults.get(flaggedStart.body.flow_id);
  flagged.completeFlow(flaggedEntry, true);
  const flaggedOutcome = await flagged.waitForFlowOutcome(flaggedEntry.flowId);
  assert.deepEqual(flaggedOutcome.result.data.dependent_skill_listings, []);
  assert.ok(
    !flagged.opsCalls.some(([name]) => name === "getBundle"),
    "no bundle fetch when the envelope says there is no bundle",
  );
});

test("dev auto-approve stamps agentic broadcasts only when the dev toggle resolves on", async (t) => {
  const harness = await loadApiHarness();
  t.after(() => harness.close());
  const settleFlow = (startRes) => {
    const entry = state.marketplacePublishFlowResults.get(startRes.body.flow_id);
    harness.completeFlow(entry, false);
  };

  // Toggle off (default): the key is entirely ABSENT — payloads are unchanged.
  const offStart = await harness.post("/api/ai-marketplace/publish-agent", {
    agent_id: "agent-1",
  });
  assert.equal(offStart.body.status, "pending");
  assert.equal("auto_approve" in harness.broadcasts.at(-1)[1], false);
  settleFlow(offStart);

  // Toggle on + dev build: every agentic confirm route carries the flag.
  harness.control.autoApprove = true;
  const onAgent = await harness.post("/api/ai-marketplace/publish-agent", {
    agent_id: "agent-2",
  });
  assert.equal(harness.broadcasts.at(-1)[1].mode, "publish-agent");
  assert.equal(harness.broadcasts.at(-1)[1].auto_approve, true);
  settleFlow(onAgent);

  const onSkill = await harness.post("/api/ai-marketplace/publish-skill", {
    skill_id: "my-skill",
  });
  assert.equal(harness.broadcasts.at(-1)[1].mode, "publish-skill");
  assert.equal(harness.broadcasts.at(-1)[1].auto_approve, true);
  settleFlow(onSkill);

  const onUnpublish = await harness.post("/api/ai-marketplace/unpublish", {
    id: "sol-owned",
    expected_type: "skills",
  });
  assert.equal(harness.broadcasts.at(-1)[1].mode, "unpublish");
  assert.equal(harness.broadcasts.at(-1)[1].auto_approve, true);
  settleFlow(onUnpublish);

  // Toggle on + NON-dev build: the stamp clamps off — the flag cannot exist
  // outside dev builds no matter what the preference file says.
  const previousBuildNumber = state.buildInfo.buildNumber;
  t.after(() => {
    state.buildInfo.buildNumber = previousBuildNumber;
  });
  state.buildInfo.buildNumber = "20260731.42";
  const prodStart = await harness.post("/api/ai-marketplace/publish-agent", {
    agent_id: "agent-3",
  });
  assert.equal(prodStart.body.status, "pending");
  assert.equal("auto_approve" in harness.broadcasts.at(-1)[1], false);
  settleFlow(prodStart);
  state.buildInfo.buildNumber = previousBuildNumber;
});

test("timeouts and renderer-busy errors return honest retryable envelopes, not fake denials", async (t) => {
  const harness = await loadApiHarness();
  t.after(() => harness.close());

  // Unpublish timeout: the user never decided — approval_timed_out, NOT denied.
  const unpub = await harness.post("/api/ai-marketplace/unpublish", {
    id: "sol-owned",
    expected_type: "skills",
  });
  const unpubEntry = state.marketplacePublishFlowResults.get(unpub.body.flow_id);
  harness.completeFlowWith(unpubEntry, flows.buildMarketplacePublishTimeoutResult(unpubEntry));
  const unpubOutcome = await harness.waitForFlowOutcome(unpubEntry.flowId);
  assert.equal(unpubOutcome.result.success, false);
  assert.equal(unpubOutcome.result.code, "approval_timed_out");
  assert.ok(!unpubOutcome.result.denied, "timeout is not a user denial");
  assert.match(unpubOutcome.result.error, /nothing was unpublished/);
  assert.match(unpubOutcome.result.remediation, /Retry the call/);

  // publish-skill busy rejection: the structured code + a retry remediation
  // survive to the tool instead of being flattened into a denial.
  const skill = await harness.post("/api/ai-marketplace/publish-skill", {
    skill_id: "my-skill",
  });
  const skillEntry = state.marketplacePublishFlowResults.get(skill.body.flow_id);
  harness.completeFlowWith(
    skillEntry,
    flows.buildMarketplacePublishErrorResult(
      skillEntry,
      "Another Agents dialog is open in the app; finish or close it, then retry.",
      "publish_ui_busy",
    ),
  );
  const skillOutcome = await harness.waitForFlowOutcome(skillEntry.flowId);
  assert.equal(skillOutcome.result.code, "publish_ui_busy");
  assert.ok(!skillOutcome.result.denied);
  assert.match(skillOutcome.result.remediation, /retry after the user finishes/i);

  // publish-agent timeout takes the same honest path through its richer ladder.
  const agent = await harness.post("/api/ai-marketplace/publish-agent", {
    agent_id: "agent-1",
  });
  const agentEntry = state.marketplacePublishFlowResults.get(agent.body.flow_id);
  harness.completeFlowWith(agentEntry, flows.buildMarketplacePublishTimeoutResult(agentEntry));
  const agentOutcome = await harness.waitForFlowOutcome(agentEntry.flowId);
  assert.equal(agentOutcome.result.code, "approval_timed_out");
  assert.ok(!agentOutcome.result.denied);
  assert.match(agentOutcome.result.error, /nothing was published/);
  assert.ok(!harness.opsCalls.some(([name]) => name === "buildAndPublishAgent"));
});

test("unpublish fast-fails before any confirmation when a published agent references the skill", async (t) => {
  const guardError = Object.assign(
    new Error(
      'Published agent on the AI Marketplace uses this skill\'s listing: "Research Buddy". Unpublish that agent first, then unpublish this skill.',
    ),
    {
      code: "skill_dependency_of_published_agents",
      body: {
        solution_id: "sol-owned",
        agents: [{ id: "agent-1", name: "Research Buddy", submitted_by: "other" }],
      },
    },
  );
  const harness = await loadApiHarness({
    assertUnpublishableImpl: () => {
      throw guardError;
    },
  });
  t.after(() => harness.close());

  const res = await harness.post("/api/ai-marketplace/unpublish", {
    id: "sol-owned",
    expected_type: "skills",
  });
  assert.equal(res.body.success, false);
  assert.equal(res.body.code, "skill_dependency_of_published_agents");
  assert.match(res.body.error, /Unpublish that agent first, then unpublish this skill/);
  assert.deepEqual(
    res.body.body.agents.map((a) => a.name),
    ["Research Buddy"],
  );
  // The user never sees a doomed confirmation: no modal broadcast, no flow
  // entry, and the delete never ran.
  assert.equal(harness.broadcasts.length, 0);
  assert.ok(!harness.opsCalls.some(([name]) => name === "deletePublishedSolution"));
});

// ---------------------------------------------------------------------------
// ipc.js: completion resolves the blocked route; reopen is chat-agnostic for
// marketplace_publish
// ---------------------------------------------------------------------------

const IPC_PATH = path.join(SERVICES_DIR, "ipc.js");

function loadIpcHandlers() {
  const originalLoad = Module._load;
  const handlers = new Map();
  const onHandlers = new Map();
  const windowSends = [];
  const ownerWindow = {
    id: 7,
    isDestroyed: () => false,
    webContents: {
      send(channel, payload) {
        windowSends.push([channel, payload]);
      },
    },
  };
  const electronStub = {
    app: { getPath: () => "/tmp", getVersion: () => "0.0.0-test" },
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
      on(channel, handler) {
        onHandlers.set(channel, handler);
      },
    },
    shell: {
      async openExternal() {},
      async openPath() {
        return "";
      },
    },
    clipboard: { writeText() {} },
    BrowserWindow: {
      fromWebContents(sender) {
        return sender?.__windowId === 7 ? ownerWindow : null;
      },
      fromId(id) {
        return Number(id) === 7 ? ownerWindow : null;
      },
      getAllWindows() {
        return [ownerWindow];
      },
      getFocusedWindow() {
        return null;
      },
    },
    Notification: function Notification() {},
    dialog: {
      async showMessageBox() {
        return { response: 0 };
      },
    },
  };
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return electronStub;
    if (
      parent?.filename === IPC_PATH &&
      (request.startsWith("./") || request.startsWith("../"))
    ) {
      if (request === "./shared-state" || request === "./marketplace-publish-confirm-flows") {
        return originalLoad.apply(this, [request, parent, isMain]);
      }
      if (request === "./owui-views") {
        return {
          broadcastToOwnerViews() {},
          broadcastToViews() {},
          getViewKeyForContents() {
            return null;
          },
          getViewState() {
            return null;
          },
          setChatRuntimeTransitionListener() {},
        };
      }
      return {};
    }
    return originalLoad.apply(this, [request, parent, isMain]);
  };
  const previousIpc = require.cache[IPC_PATH];
  delete require.cache[IPC_PATH];
  let ipc;
  try {
    ipc = require(IPC_PATH);
    ipc.registerOAuthHandlers();
    ipc.registerOwuiHandlers();
  } finally {
    Module._load = originalLoad;
    delete require.cache[IPC_PATH];
    if (previousIpc) require.cache[IPC_PATH] = previousIpc;
  }
  return { handlers, onHandlers, windowSends };
}

function startPublishFlowEntry(overrides = {}) {
  let resolvedWith = null;
  const entry = state.startMarketplacePublishFlow({
    flowId: overrides.flowId || `ipc-flow-${Math.random().toString(36).slice(2, 8)}`,
    status: "in_progress",
    chatId: null,
    mode: "publish-agent",
    result: null,
    startedAt: Date.now(),
    completedAt: null,
    timeoutHandle: null,
    cleanupHandle: null,
    ownerWindowId: 7,
    matchedViewKey: "main",
    presentation: "visible",
    phase: "confirm",
    resolveDecision: (decision) => {
      resolvedWith = decision;
    },
    onPublishing: null,
    ...overrides,
  });
  return { entry, resolvedWith: () => resolvedWith };
}

test("ipc completion resolves the blocked flow with owner-window and status guards", (t) => {
  t.after(clearFlowTimers);
  const { onHandlers, windowSends } = loadIpcHandlers();
  const completed = onHandlers.get("ai-marketplace-publish-confirm-completed");
  assert.equal(typeof completed, "function");

  const { entry, resolvedWith } = startPublishFlowEntry({ flowId: "ipc-flow-approve" });

  // Completions from a non-owning window are ignored.
  completed({ sender: { __windowId: 3 } }, { flow_id: "ipc-flow-approve", action: "approved" });
  assert.equal(entry.status, "in_progress");
  assert.equal(resolvedWith(), null);

  // Missing/unknown flows are ignored without throwing.
  completed({ sender: { __windowId: 7 } }, { flow_id: "", action: "approved" });
  completed({ sender: { __windowId: 7 } }, { flow_id: "nope", action: "approved" });

  // The owning window approves: the flow completes, the route waiter resolves
  // the approved decision, and the renderer gets the kind-scoped terminal
  // notification.
  completed({ sender: { __windowId: 7 } }, { flow_id: "ipc-flow-approve", action: "approved" });
  assert.equal(entry.status, "completed");
  assert.equal(entry.result.status, "approved");
  assert.equal(resolvedWith()?.kind, "approved");
  const terminal = windowSends.find(([channel]) => channel === "native-input-terminal");
  assert.deepEqual(terminal[1], {
    kind: "marketplace_publish",
    flow_id: "ipc-flow-approve",
    status: "approved",
  });

  // Late duplicate completions on a settled flow are ignored.
  completed({ sender: { __windowId: 7 } }, { flow_id: "ipc-flow-approve", action: "denied" });
  assert.equal(entry.result.status, "approved");

  // denied / dismissed → denied result; unknown action → error result.
  const denied = startPublishFlowEntry({ flowId: "ipc-flow-deny" });
  completed({ sender: { __windowId: 7 } }, { flow_id: "ipc-flow-deny", action: "dismissed" });
  assert.equal(denied.entry.result.status, "denied");
  assert.equal(denied.resolvedWith()?.kind, "denied");

  const errored = startPublishFlowEntry({ flowId: "ipc-flow-error" });
  completed({ sender: { __windowId: 7 } }, { flow_id: "ipc-flow-error", action: "explode" });
  assert.equal(errored.entry.result.status, "error");
  assert.match(errored.entry.result.message || errored.entry.result.error || "", /explode/);
});

test("ipc treats 'publishing' as a non-terminal phase marker and maps the new terminals", (t) => {
  t.after(clearFlowTimers);
  const { onHandlers, windowSends } = loadIpcHandlers();
  const completed = onHandlers.get("ai-marketplace-publish-confirm-completed");

  // "publishing": invokes entry.onPublishing, no completion, no terminal
  // notify, waiter untouched — and the owner-window guard still applies.
  let publishingCalls = 0;
  const { entry, resolvedWith } = startPublishFlowEntry({
    flowId: "ipc-flow-publishing",
    onPublishing: () => {
      publishingCalls += 1;
      return true;
    },
  });
  windowSends.length = 0;
  completed({ sender: { __windowId: 3 } }, { flow_id: "ipc-flow-publishing", action: "publishing" });
  assert.equal(publishingCalls, 0, "non-owning windows cannot flip the phase");
  completed({ sender: { __windowId: 7 } }, { flow_id: "ipc-flow-publishing", action: "publishing" });
  assert.equal(publishingCalls, 1);
  assert.equal(entry.status, "in_progress");
  assert.equal(resolvedWith(), null, "the route keeps waiting");
  assert.ok(
    !windowSends.some(([channel]) => channel === "native-input-terminal"),
    "no terminal notification for a phase marker",
  );

  // "published" terminal: sanitized result + published decision.
  completed(
    { sender: { __windowId: 7 } },
    {
      flow_id: "ipc-flow-publishing",
      action: "published",
      result: { solution_id: "sol-ipc", action: "updated", status: "active" },
    },
  );
  assert.equal(entry.status, "completed");
  assert.equal(entry.result.status, "published");
  assert.equal(resolvedWith()?.kind, "published");
  assert.equal(resolvedWith()?.result?.solution_id, "sol-ipc");
  const publishedTerminal = windowSends.find(
    ([channel]) => channel === "native-input-terminal",
  );
  assert.equal(publishedTerminal[1].status, "published");

  // "publish_failed" terminal: bounded error + code survive to the decision.
  const failed = startPublishFlowEntry({ flowId: "ipc-flow-publish-failed" });
  completed(
    { sender: { __windowId: 7 } },
    {
      flow_id: "ipc-flow-publish-failed",
      action: "publish_failed",
      error: "dependent skill exploded",
      code: "dependent_skill_publish_failed",
    },
  );
  assert.equal(failed.entry.result.status, "publish_failed");
  assert.deepEqual(failed.resolvedWith(), {
    kind: "publish_failed",
    error: "dependent skill exploded",
    code: "dependent_skill_publish_failed",
  });

  // Error completions carry the agent-actionable code through.
  const coded = startPublishFlowEntry({ flowId: "ipc-flow-coded-error" });
  completed(
    { sender: { __windowId: 7 } },
    {
      flow_id: "ipc-flow-coded-error",
      action: "error",
      error: "The AI Marketplace API key is not set.",
      code: "marketplace_api_key_missing",
    },
  );
  assert.equal(coded.entry.result.status, "error");
  assert.equal(coded.resolvedWith()?.code, "marketplace_api_key_missing");
});

test("reopen is chat-agnostic for marketplace_publish but chat-scoped for chat-bound flows", async (t) => {
  t.after(clearFlowTimers);
  const { handlers, windowSends } = loadIpcHandlers();
  const reopen = handlers.get("owui-reopen-native-input");
  assert.equal(typeof reopen, "function");

  // marketplace_publish carries no chat binding (the Rust proxy has no chat
  // id) → it reopens from ANY chat in the owning window.
  const { entry } = startPublishFlowEntry({
    flowId: "ipc-flow-reopen",
    presentation: "hidden",
    resolveDecision: null,
  });
  const res = await reopen(
    { sender: { __windowId: 7 } },
    { kind: "marketplace_publish", flow_id: "ipc-flow-reopen", chat_id: "any-chat-at-all" },
  );
  assert.equal(res.success, true);
  assert.equal(entry.presentation, "visible");
  const reopenSend = windowSends.find(([channel]) => channel === "native-input-reopen-requested");
  assert.deepEqual(reopenSend[1], {
    kind: "marketplace_publish",
    flow_id: "ipc-flow-reopen",
    chat_id: null,
  });

  // Non-owning windows are rejected.
  entry.presentation = "hidden";
  const foreign = await reopen(
    { sender: { __windowId: 3 } },
    { kind: "marketplace_publish", flow_id: "ipc-flow-reopen", chat_id: "" },
  );
  assert.equal(foreign.success, false);

  // A chat-scoped flow (user question) still requires its own chat.
  state.startUserQuestionFlow({
    flowId: "uq-flow",
    status: "in_progress",
    chatId: "chat-9",
    questions: [{}],
    presentation: "hidden",
    ownerWindowId: 7,
  });
  const wrongChat = await reopen(
    { sender: { __windowId: 7 } },
    { kind: "user_question", flow_id: "uq-flow", chat_id: "chat-OTHER" },
  );
  assert.equal(wrongChat.success, false);
  const rightChat = await reopen(
    { sender: { __windowId: 7 } },
    { kind: "user_question", flow_id: "uq-flow", chat_id: "chat-9" },
  );
  assert.equal(rightChat.success, true);
});

test("native-input-set-presentation applies a flow_ids batch with one snapshot broadcast", async (t) => {
  t.after(clearFlowTimers);
  const { handlers } = loadIpcHandlers();
  const setPresentation = handlers.get("native-input-set-presentation");
  assert.equal(typeof setPresentation, "function");

  const { entry: first } = startPublishFlowEntry({
    flowId: "ipc-batch-a",
    presentation: "visible",
    resolveDecision: null,
  });
  const { entry: second } = startPublishFlowEntry({
    flowId: "ipc-batch-b",
    presentation: "visible",
    resolveDecision: null,
  });

  // One call parks the whole batch (the modal's eyeball-hide path).
  const res = await setPresentation(
    { sender: { __windowId: 7 } },
    {
      kind: "marketplace_publish",
      flow_ids: ["ipc-batch-a", "ipc-batch-b", "not-a-flow"],
      presentation: "hidden",
    },
  );
  assert.equal(res.success, true);
  assert.equal(first.presentation, "hidden");
  assert.equal(second.presentation, "hidden");

  // Legacy single flow_id form keeps working.
  const single = await setPresentation(
    { sender: { __windowId: 7 } },
    { kind: "marketplace_publish", flow_id: "ipc-batch-a", presentation: "visible" },
  );
  assert.equal(single.success, true);
  assert.equal(first.presentation, "visible");
  assert.equal(second.presentation, "hidden");

  // No resolvable flow at all → failure envelope.
  const none = await setPresentation(
    { sender: { __windowId: 7 } },
    { kind: "marketplace_publish", flow_ids: ["ghost"], presentation: "hidden" },
  );
  assert.equal(none.success, false);
});

// ---------------------------------------------------------------------------
// preload.js: request/completion channel plumbing
// ---------------------------------------------------------------------------

test("preload exposes the publish confirm request/completion channels", (t) => {
  const preloadPath = require.resolve("./preload");
  const originalLoad = Module._load;
  const previous = require.cache[preloadPath];
  const exposed = {};
  const rendererListeners = new Map();
  const sent = [];
  const invoked = [];
  const electronStub = {
    contextBridge: {
      exposeInMainWorld(name, api) {
        exposed[name] = api;
      },
    },
    ipcRenderer: {
      invoke(channel, ...args) {
        invoked.push([channel, ...args]);
        return Promise.resolve({ success: true });
      },
      send(channel, ...args) {
        sent.push([channel, ...args]);
      },
      on(channel, listener) {
        if (!rendererListeners.has(channel)) rendererListeners.set(channel, []);
        rendererListeners.get(channel).push(listener);
      },
      removeListener() {},
      removeAllListeners() {},
    },
  };
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return electronStub;
    return originalLoad.apply(this, [request, parent, isMain]);
  };
  delete require.cache[preloadPath];
  try {
    require("./preload");
  } finally {
    Module._load = originalLoad;
    delete require.cache[preloadPath];
    if (previous) require.cache[preloadPath] = previous;
  }
  const api = exposed.electronAPI;
  assert.ok(api, "preload exposes electronAPI");

  // Request events arrive on the dedicated channel and relay the raw payload.
  const received = [];
  api.onAiMarketplacePublishConfirmRequested((payload) => received.push(payload));
  const requestListeners = rendererListeners.get("ai-marketplace-publish-confirm-requested");
  assert.equal(requestListeners?.length, 1);
  requestListeners[0]({}, { flow_id: "pf-1", mode: "publish-agent" });
  assert.deepEqual(received, [{ flow_id: "pf-1", mode: "publish-agent" }]);

  // Completions go out on the paired send channel.
  api.notifyAiMarketplacePublishConfirmCompleted({ flow_id: "pf-1", action: "approved" });
  assert.deepEqual(sent.at(-1), [
    "ai-marketplace-publish-confirm-completed",
    { flow_id: "pf-1", action: "approved" },
  ]);

  // Flow-keyed outcome pushes relay on their dedicated channel.
  const outcomes = [];
  api.onAiMarketplacePublishOutcome((payload) => outcomes.push(payload));
  const outcomeListeners = rendererListeners.get("ai-marketplace-publish-outcome");
  assert.equal(outcomeListeners?.length, 1);
  outcomeListeners[0]({}, { flow_id: "pf-1", ok: true });
  assert.deepEqual(outcomes, [{ flow_id: "pf-1", ok: true }]);

  // The eyeball-hide path rides the shared native-input presentation invoke.
  api.setNativeInputPresentation({
    kind: "marketplace_publish",
    flow_id: "pf-1",
    presentation: "hidden",
  });
  assert.deepEqual(invoked.at(-1), [
    "native-input-set-presentation",
    { kind: "marketplace_publish", flow_id: "pf-1", presentation: "hidden" },
  ]);
});

// ---------------------------------------------------------------------------
// ai-marketplace-publish-modal.js: the renderer component in a vm DOM
// harness fed the REAL template (ids extracted from the .html file so the
// markup↔getElementById contract is exercised)
// ---------------------------------------------------------------------------

const MODAL_JS_PATH = path.join(COMPONENTS_DIR, "ai-marketplace-publish-modal.js");
const MODAL_HTML_PATH = path.join(COMPONENTS_DIR, "ai-marketplace-publish-modal.html");

class ModalFakeElement {
  // Every element scans innerHTML writes for id="..." and registers fakes in
  // the shared registry — the batch modal builds per-item DOM (cards, badges,
  // checkboxes) as HTML strings, so getElementById must resolve those ids the
  // same way a real DOM would.
  constructor(id = "", registry = null) {
    this.id = id;
    this._registry = registry;
    this.classList = {
      classes: new Set(),
      add: (name) => this.classList.classes.add(name),
      remove: (name) => this.classList.classes.delete(name),
      contains: (name) => this.classList.classes.has(name),
      toggle: (name, force) => {
        const target = force ?? !this.classList.classes.has(name);
        if (target) this.classList.classes.add(name);
        else this.classList.classes.delete(name);
        return target;
      },
    };
    this.attributes = {};
    this._innerHTML = "";
    this.textContent = "";
    this.hidden = false;
    this.onclick = null;
    this.onkeydown = null;
    this.focusCalls = 0;
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = String(value ?? "");
    if (!this._registry) return;
    for (const match of this._innerHTML.matchAll(/id="([^"]+)"/g)) {
      if (!this._registry.has(match[1])) {
        this._registry.set(match[1], new ModalFakeElement(match[1], this._registry));
      }
    }
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
      ? this.attributes[name]
      : null;
  }

  focus() {
    this.focusCalls += 1;
  }
}

function loadPublishModalHarness({
  buildAgentCardHtml = (agent) => `<div class="real-agent-card">${agent.name || agent.id}</div>`,
  buildSkillCardHtml = (skill) => `<div class="real-skill-card">${skill.name}</div>`,
  ensureImpl = async () => {},
  setPresentationImpl = null,
  // Opt-in seams for the rich agentic parity paths: without them the modal
  // keeps its legacy contracts (skills "unavailable", instant main-side
  // settle), which is exactly what older hosts get.
  publishHooks = null,
  outcomeChannel = false,
} = {}) {
  const html = fs.readFileSync(MODAL_HTML_PATH, "utf8");
  const source = fs.readFileSync(MODAL_JS_PATH, "utf8");

  const elements = new Map();
  // Applying the fetched template (and every later per-item innerHTML write)
  // registers an element for each id the markup declares —
  // getAiMarketplacePublishElements() and the per-item wiring then resolve
  // against the actual markup contract.
  const container = new ModalFakeElement("ai-marketplace-publish-container", elements);
  elements.set(container.id, container);
  let fetched = 0;

  const calls = {
    ensure: 0,
    agentCard: [],
    skillCard: [],
    completed: [],
    presentations: [],
    suppressed: [],
    copied: [],
  };
  const listeners = { reopen: [], terminal: [], outcome: [] };

  const windowObject = {
    electronAPI: {
      setNativeInputPresentation: async (payload) => {
        calls.presentations.push(payload);
        if (setPresentationImpl) return setPresentationImpl(payload);
        return { success: true };
      },
      notifyAiMarketplacePublishConfirmCompleted: (payload) => {
        calls.completed.push(payload);
      },
      copyToClipboard: (value) => {
        calls.copied.push(value);
      },
      onNativeInputReopenRequested: (callback) => {
        listeners.reopen.push(callback);
      },
      onNativeInputTerminal: (callback) => {
        listeners.terminal.push(callback);
      },
      ...(outcomeChannel
        ? {
            onAiMarketplacePublishOutcome: (callback) => {
              listeners.outcome.push(callback);
            },
          }
        : {}),
    },
    ...(publishHooks ? { AgentsPublishHooks: publishHooks } : {}),
    AgentCapabilityCatalog: {
      ensure: async (opts) => {
        calls.ensure += 1;
        return ensureImpl(opts);
      },
    },
    AgentCardRenderer: {
      buildAgentCardHtml: (agent, opts) => {
        calls.agentCard.push([agent, opts]);
        return buildAgentCardHtml(agent, opts);
      },
    },
    SkillCardRenderer: {
      buildSkillCardHtml: (skill, opts) => {
        calls.skillCard.push([skill, opts]);
        return buildSkillCardHtml(skill, opts);
      },
    },
    setOwuiInteractionSuppressed: (key, suppressed) => {
      calls.suppressed.push([key, suppressed]);
    },
  };

  const documentObject = {
    getElementById(id) {
      return elements.get(id) || null;
    },
  };

  const context = {
    window: windowObject,
    document: documentObject,
    console,
    setTimeout,
    clearTimeout,
    Promise,
    JSON,
    fetch: async (url) => {
      fetched += 1;
      assert.match(String(url), /ai-marketplace-publish-modal\.html$/);
      return { text: async () => html };
    },
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: MODAL_JS_PATH });

  return {
    window: windowObject,
    elements,
    calls,
    listeners,
    fetchedCount: () => fetched,
    el: (suffix) => elements.get(`ai-marketplace-publish-${suffix}`),
    emitOutcome: (payload) => {
      for (const callback of listeners.outcome) callback(payload);
    },
  };
}

const flushMicrotasks = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  // The modal parks its default-focus in setTimeout(0), which Node clamps to
  // 1ms — on an idle machine all the immediate rounds finish before the
  // timers phase ever sees it fire. One real timer round covers macrotasks
  // deterministically (expiry order runs the component's timer first).
  await new Promise((resolve) => setTimeout(resolve, 1));
};

// vm-created objects carry the vm context's Object prototype, which is not
// reference-equal to the host's for deepStrictEqual — round-trip first.
const roundTrip = (value) => JSON.parse(JSON.stringify(value));

test("publish modal loads the real template, focuses Cancel, and completes approve/deny", async () => {
  const harness = loadPublishModalHarness();
  const resultPromise = harness.window.runAiMarketplacePublishModal({
    flow_id: "flow-a",
    mode: "publish-agent",
    title: "Publish agent",
    confirm_label: "Publish",
    summary: "This shares the agent.",
    solution_id: "sol-a1",
    solution_type: "agents",
    agent: {
      id: "agent-1",
      name: "Agent One",
      system_prompt_preview: "preview-text",
      system_prompt_length: 5000,
    },
  });
  await flushMicrotasks();

  // The REAL template supplied every element the component looks up.
  assert.equal(harness.fetchedCount(), 1, "template fetched once");
  const modal = harness.el("modal");
  assert.ok(modal, "template declares the modal root id");
  assert.ok(harness.el("approve-btn") && harness.el("cancel-btn") && harness.el("hide-btn"));
  assert.ok(modal.classList.contains("visible"));
  assert.equal(modal.getAttribute("aria-hidden"), "false");
  // Single-item batch keeps today's shape: the item's own title/summary/label.
  assert.equal(harness.el("title").textContent, "Publish agent");
  assert.equal(harness.el("summary").textContent, "This shares the agent.");
  assert.equal(harness.el("approve-btn").textContent, "Publish");

  // Focus lands on CANCEL, never the approve button: a buffered Enter/Space
  // in a force-activated window must not approve an LLM-initiated write.
  assert.ok(harness.el("cancel-btn").focusCalls >= 1);
  assert.equal(harness.el("approve-btn").focusCalls, 0);

  // Prompt preview: shown with a truncation ellipsis when the real prompt is
  // longer than the preview.
  assert.match(harness.el("items").innerHTML, /preview-text\.\.\./);

  // The solution id renders as a copyable badge; the self-wired copy button
  // works in every window (no delegated control-plane handler needed).
  assert.match(harness.el("items").innerHTML, /sol-a1/);
  harness.el("item-copy-flow-a").onclick();
  assert.deepEqual(harness.calls.copied, ["sol-a1"]);

  // The real Agents-tab card renders after the capability catalogs resolve,
  // via the shared renderer in presentation-only mode.
  assert.equal(harness.calls.ensure, 1);
  assert.deepEqual(roundTrip(harness.calls.agentCard[0][1]), { interactive: false });
  assert.match(harness.el("item-card-flow-a").innerHTML, /real-agent-card/);

  // Approve → completion on the dedicated channel + the flow promise settles.
  harness.el("approve-btn").onclick();
  assert.deepEqual(roundTrip(harness.calls.completed), [{ flow_id: "flow-a", action: "approved" }]);
  assert.deepEqual(roundTrip(await resultPromise), { action: "approved" });
  assert.ok(!modal.classList.contains("visible"));

  // A second flow can run after the first settles; Cancel denies it.
  const denyPromise = harness.window.runAiMarketplacePublishModal({
    flow_id: "flow-b",
    mode: "unpublish",
    title: "Remove listing",
    confirm_label: "Unpublish",
  });
  await flushMicrotasks();
  harness.el("cancel-btn").onclick();
  assert.deepEqual(roundTrip(harness.calls.completed.at(-1)), { flow_id: "flow-b", action: "denied" });
  assert.deepEqual(roundTrip(await denyPromise), { action: "denied" });
});

test("concurrent flows batch into one modal with per-item decisions", async () => {
  const harness = loadPublishModalHarness();
  const first = harness.window.runAiMarketplacePublishModal({
    flow_id: "flow-1",
    mode: "unpublish",
    title: 'Remove "Agent One" from the AI Marketplace',
    confirm_label: "Unpublish",
    solution_id: "sol-1",
    solution_type: "agents",
    agent: { id: "sol-1", name: "Agent One" },
  });
  await flushMicrotasks();
  const second = harness.window.runAiMarketplacePublishModal({
    flow_id: "flow-2",
    mode: "unpublish",
    title: 'Remove "epic-voice-booster" from the AI Marketplace',
    confirm_label: "Unpublish",
    solution_id: "sol-2",
    solution_type: "skills",
    skill: { name: "epic-voice-booster", published: true },
  });
  await flushMicrotasks();

  // One modal, one template fetch, two items.
  assert.equal(harness.fetchedCount(), 1, "the second flow joins the open batch");
  assert.equal(harness.el("title").textContent, "Marketplace approvals (2)");
  assert.match(harness.el("summary").textContent, /Unchecked requests will be denied/);
  assert.equal(harness.el("approve-btn").textContent, "Approve 2");
  // Item headers carry the action + type chips and both cards render.
  assert.match(harness.el("items").innerHTML, /AGENT/);
  assert.match(harness.el("items").innerHTML, /SKILL/);
  assert.match(harness.el("item-card-flow-1").innerHTML, /real-agent-card/);
  assert.match(harness.el("item-card-flow-2").innerHTML, /real-skill-card/);

  // A duplicate flow id is a genuine error, not a second item.
  await assert.rejects(
    harness.window.runAiMarketplacePublishModal({ flow_id: "flow-2", title: "dupe" }),
    /already pending/,
  );

  // Uncheck item 2 → the confirm button reflects the checked count, and the
  // single decisive confirm approves checked + denies unchecked per flow.
  harness.el("item-check-flow-2").onclick();
  assert.equal(harness.el("approve-btn").textContent, "Approve 1");
  harness.el("approve-btn").onclick();
  assert.deepEqual(roundTrip(harness.calls.completed), [
    { flow_id: "flow-1", action: "approved" },
    { flow_id: "flow-2", action: "denied" },
  ]);
  assert.deepEqual(roundTrip(await first), { action: "approved" });
  assert.deepEqual(roundTrip(await second), { action: "denied" });
  assert.ok(!harness.el("modal").classList.contains("visible"));

  // Escape denies EVERY remaining request in the batch.
  const third = harness.window.runAiMarketplacePublishModal({
    flow_id: "flow-3",
    title: "Three",
    confirm_label: "Publish",
  });
  await flushMicrotasks();
  const fourth = harness.window.runAiMarketplacePublishModal({
    flow_id: "flow-4",
    title: "Four",
    confirm_label: "Publish",
  });
  await flushMicrotasks();
  harness.el("modal").onkeydown({ key: "Escape", preventDefault() {} });
  assert.deepEqual(roundTrip(harness.calls.completed.slice(-2)), [
    { flow_id: "flow-3", action: "denied" },
    { flow_id: "flow-4", action: "denied" },
  ]);
  assert.deepEqual(roundTrip(await third), { action: "denied" });
  assert.deepEqual(roundTrip(await fourth), { action: "denied" });
});

// ---------------------------------------------------------------------------
// Approved agent items run IN PLACE: the modal stays open with live per-item
// status chips while the renderer executor publishes them sequentially; skill
// items keep the main-side "approved" contract; unchecked items deny.
// ---------------------------------------------------------------------------

test("approve runs agent items sequentially in place with live status chips", async () => {
  const harness = loadPublishModalHarness();
  const notifications = [];
  harness.window.showNotification = (message, kind) => notifications.push([message, kind]);
  const executorCalls = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const loadMyAgentsCalls = [];
  harness.window.AgentsTabModule = {
    loadMyAgents: () => loadMyAgentsCalls.push(1),
    executeBackendAgentPublish: async (args) => {
      executorCalls.push(args);
      if (args.agentId === "agent-1") {
        await firstGate;
        return { solution_id: "sol-1", action: "created", name: "Agent One" };
      }
      const failure = new Error("Cannot publish this agent's dependent skills: loupe (boom).");
      failure.code = "dependent_skill_publish_failed";
      throw failure;
    },
  };

  const flowA1 = harness.window.runAiMarketplacePublishModal({
    flow_id: "flow-a1",
    mode: "publish-agent",
    title: "Publish Agent One",
    confirm_label: "Publish",
    agent: { id: "agent-1", name: "Agent One" },
    allowed_emails: ["dsantiago@example.invalid"],
  });
  await flushMicrotasks();
  const flowA2 = harness.window.runAiMarketplacePublishModal({
    flow_id: "flow-a2",
    mode: "publish-agent",
    title: "Publish Agent Two",
    confirm_label: "Publish",
    agent: { id: "agent-2", name: "Agent Two" },
  });
  await flushMicrotasks();
  const flowSkill = harness.window.runAiMarketplacePublishModal({
    flow_id: "flow-skill",
    mode: "publish-skill",
    title: "Publish a skill",
    confirm_label: "Publish",
    skill: { name: "loupe" },
  });
  await flushMicrotasks();
  const flowDenied = harness.window.runAiMarketplacePublishModal({
    flow_id: "flow-denied",
    mode: "publish-agent",
    title: "Publish Agent Three",
    confirm_label: "Publish",
    agent: { id: "agent-3", name: "Agent Three" },
  });
  await flushMicrotasks();

  harness.el("item-check-flow-denied").onclick(); // uncheck → deny
  harness.el("approve-btn").onclick();
  await flushMicrotasks();

  // Non-agent + unchecked settle immediately; agents flip to "publishing" up
  // front (both deny timers swap to publish budgets before the queue waits).
  assert.deepEqual(roundTrip(harness.calls.completed.slice(0, 4)), [
    { flow_id: "flow-skill", action: "approved" },
    { flow_id: "flow-denied", action: "denied" },
    { flow_id: "flow-a1", action: "publishing" },
    { flow_id: "flow-a2", action: "publishing" },
  ]);
  assert.deepEqual(roundTrip(await flowSkill), { action: "approved" });
  assert.deepEqual(roundTrip(await flowDenied), { action: "denied" });

  // Mid-queue: the modal stays open, chrome locks, agent 2 has NOT started
  // (sequential), rows show live chips.
  assert.ok(harness.el("modal").classList.contains("visible"));
  assert.equal(harness.el("approve-btn").disabled, true);
  assert.equal(harness.el("cancel-btn").disabled, true);
  assert.equal(harness.el("approve-btn").textContent, "Publishing…");
  assert.equal(executorCalls.length, 1, "execution is sequential");
  assert.deepEqual(roundTrip(executorCalls[0]), {
    agentId: "agent-1",
    allowedEmailsOverride: ["dsantiago@example.invalid"],
    // No resolved plan in this harness (no AgentsPublishHooks): the executor
    // self-resolves. onProgress is a function and drops in the round-trip.
    resolvedSkillPlan: null,
  });
  assert.equal(harness.el("item-status-flow-a1").getAttribute("data-status"), null);
  assert.match(harness.el("items").innerHTML, /Publishing…/);
  // Cancel/Escape are inert while the approved queue runs.
  harness.el("cancel-btn").onclick();
  harness.el("modal").onkeydown({ key: "Escape", preventDefault() {} });
  assert.equal(
    harness.calls.completed.filter((c) => c.action === "denied").length,
    1,
    "no new denials mid-run",
  );

  releaseFirst();
  await flushMicrotasks();

  // Terminal completions carry the executor result / structured failure.
  const published = harness.calls.completed.find((c) => c.action === "published");
  assert.equal(published.flow_id, "flow-a1");
  assert.equal(published.result.solution_id, "sol-1");
  const failed = harness.calls.completed.find((c) => c.action === "publish_failed");
  assert.equal(failed.flow_id, "flow-a2");
  assert.equal(failed.code, "dependent_skill_publish_failed");
  assert.match(failed.error, /dependent skills/);
  assert.deepEqual(roundTrip(await flowA1), { action: "published" });
  assert.deepEqual(roundTrip(await flowA2), { action: "publish_failed" });
  assert.equal(executorCalls.length, 2);
  assert.deepEqual(roundTrip(executorCalls[1]), {
    agentId: "agent-2",
    allowedEmailsOverride: null,
    resolvedSkillPlan: null,
  });

  // Live chips reflect the outcomes in place; the failure carries a tooltip.
  assert.equal(harness.el("item-status-flow-a1").getAttribute("data-status"), "published");
  assert.equal(harness.el("item-status-flow-a1").textContent, "✓ Published");
  assert.equal(harness.el("item-status-flow-a2").getAttribute("data-status"), "failed");
  assert.equal(harness.el("item-status-flow-a2").textContent, "✕ Failed");
  assert.match(harness.el("item-status-flow-a2").getAttribute("title"), /dependent skills/);

  // Summary toast + one agents reload; the modal closes after the linger,
  // keeping the final busy label (never "Approve 0") while it does.
  assert.equal(loadMyAgentsCalls.length, 1);
  assert.deepEqual(roundTrip(notifications.at(-1)), [
    "Published 1 of 2 agents. 1 failed — see the chat for details.",
    "error",
  ]);
  assert.equal(harness.el("approve-btn").textContent, "Publishing…");
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.ok(!harness.el("modal").classList.contains("visible"));
  assert.equal(harness.window.AiMarketplacePublishBatch.isActive(), false);
});

test("without the executor seam, approved agent items settle main-side ('approved')", async () => {
  const harness = loadPublishModalHarness();
  const flow = harness.window.runAiMarketplacePublishModal({
    flow_id: "flow-degraded",
    mode: "publish-agent",
    title: "Publish agent",
    confirm_label: "Publish",
    agent: { id: "agent-1", name: "Agent One" },
  });
  await flushMicrotasks();
  harness.el("approve-btn").onclick();
  assert.deepEqual(roundTrip(harness.calls.completed), [
    { flow_id: "flow-degraded", action: "approved" },
  ]);
  assert.deepEqual(roundTrip(await flow), { action: "approved" });
});

test("eyeball hide parks the whole batch, reopen restores it, terminals evict single items", async () => {
  let failPresentation = false;
  const harness = loadPublishModalHarness({
    setPresentationImpl: async () =>
      failPresentation ? { success: false, error: "nope" } : { success: true },
  });
  const flowH = harness.window.runAiMarketplacePublishModal({
    flow_id: "flow-h",
    title: "Hide me",
    confirm_label: "Publish",
    agent: { id: "a" },
  });
  await flushMicrotasks();
  const flowI = harness.window.runAiMarketplacePublishModal({
    flow_id: "flow-i",
    title: "Hide me too",
    confirm_label: "Publish",
  });
  await flushMicrotasks();
  const modal = harness.el("modal");

  // Hide: ONE presentation call parks the whole batch (flow_ids), the modal
  // hides, and interaction suppression is released.
  const hidden = await harness.window.hideAiMarketplacePublishModal();
  assert.equal(hidden, true);
  assert.deepEqual(roundTrip(harness.calls.presentations.at(-1)), {
    kind: "marketplace_publish",
    flow_ids: ["flow-h", "flow-i"],
    presentation: "hidden",
  });
  assert.ok(!modal.classList.contains("visible"));

  // A flow arriving while the batch is hidden joins it HIDDEN (the chat pill
  // count grows) instead of popping a surprise modal.
  const flowJ = harness.window.runAiMarketplacePublishModal({
    flow_id: "flow-j",
    title: "Quiet join",
    confirm_label: "Publish",
  });
  await flushMicrotasks();
  assert.ok(!modal.classList.contains("visible"), "hidden batch stays hidden");
  assert.deepEqual(roundTrip(harness.calls.presentations.at(-1)), {
    kind: "marketplace_publish",
    flow_ids: ["flow-j"],
    presentation: "hidden",
  });

  // Reopen for ONE member restores the whole batch and syncs the siblings'
  // presentation in a single call.
  harness.listeners.reopen.forEach((cb) => cb({ kind: "other_kind", flow_id: "flow-h" }));
  assert.ok(!modal.classList.contains("visible"), "foreign kinds never reopen this modal");
  harness.listeners.reopen.forEach((cb) =>
    cb({ kind: "marketplace_publish", flow_id: "flow-h" }),
  );
  assert.ok(modal.classList.contains("visible"));
  assert.equal(harness.el("title").textContent, "Marketplace approvals (3)");
  assert.deepEqual(roundTrip(harness.calls.presentations.at(-1)), {
    kind: "marketplace_publish",
    flow_ids: ["flow-i", "flow-j"],
    presentation: "visible",
  });

  // A failed hide re-shows the modal instead of stranding the batch invisible.
  failPresentation = true;
  const failed = await harness.window.hideAiMarketplacePublishModal();
  assert.equal(failed, false);
  assert.ok(modal.classList.contains("visible"), "failed hide falls back to visible");
  failPresentation = false;

  // Terminal: foreign kinds/flows are ignored; a member terminal (e.g. its
  // own deny timeout) evicts JUST that item — the rest of the batch stays up.
  harness.listeners.terminal.forEach((cb) => cb({ kind: "user_question", flow_id: "flow-i" }));
  assert.ok(modal.classList.contains("visible"));
  harness.listeners.terminal.forEach((cb) =>
    cb({ kind: "marketplace_publish", flow_id: "flow-i", status: "timeout" }),
  );
  assert.deepEqual(roundTrip(await flowI), {
    success: false,
    status: "timeout",
    flow_id: "flow-i",
  });
  assert.ok(modal.classList.contains("visible"), "surviving items keep the modal open");
  assert.equal(harness.el("title").textContent, "Marketplace approvals (2)");

  // Escape denies whatever remains.
  harness.el("modal").onkeydown({ key: "Escape", preventDefault() {} });
  assert.deepEqual(roundTrip(await flowH), { action: "denied" });
  assert.deepEqual(roundTrip(await flowJ), { action: "denied" });
  assert.ok(!modal.classList.contains("visible"));
});

test("publish modal renders the skill card for skill flows and degrades gracefully", async () => {
  // Skill flows (publish-skill / skill unpublish) use the shared control-plane
  // skill card with the published flag.
  const harness = loadPublishModalHarness();
  const skillFlow = harness.window.runAiMarketplacePublishModal({
    flow_id: "flow-s",
    mode: "publish-skill",
    title: "Publish skill",
    confirm_label: "Publish",
    skill: { name: "my-skill", description: "d", published: true },
  });
  await flushMicrotasks();
  assert.equal(harness.calls.agentCard.length, 0, "no agent card for a skill flow");
  assert.deepEqual(roundTrip(harness.calls.skillCard[0][1]), { interactive: false, published: true });
  assert.match(harness.el("item-card-flow-s").innerHTML, /real-skill-card/);
  harness.el("cancel-btn").onclick();
  await skillFlow;

  // Renderer failure degrades to the inline fallback card, never blocking
  // approval.
  const broken = loadPublishModalHarness({
    buildAgentCardHtml: () => {
      throw new Error("renderer exploded");
    },
  });
  const brokenFlow = broken.window.runAiMarketplacePublishModal({
    flow_id: "flow-f",
    title: "Fallback",
    confirm_label: "Publish",
    agent: { id: "agent-9", name: "Fallback Agent", description: "still visible" },
  });
  await flushMicrotasks();
  assert.match(broken.el("item-card-flow-f").innerHTML, /Fallback Agent/);
  assert.match(broken.el("item-card-flow-f").innerHTML, /still visible/);
  broken.el("approve-btn").onclick();
  await brokenFlow;
});

// ---------------------------------------------------------------------------
// backend-modal-listeners.js: request routing into the modal runner
// ---------------------------------------------------------------------------

const LISTENERS_PATH = path.join(COMPONENTS_DIR, "backend-modal-listeners.js");

function loadBackendModalListenersHarness() {
  const source = fs.readFileSync(LISTENERS_PATH, "utf8");
  const captured = {};
  const completions = [];
  const windowObject = {
    appState: { servers: [], toggles: {}, activeTab: "chat", conversationTabs: {} },
    addEventListener() {},
    electronAPI: {
      onOAuthFlowRequested(cb) {
        captured.oauth = cb;
      },
      onOAuthFlowCompleted() {},
      onUserQuestionRequested() {},
      onSensitiveInfoRequested() {},
      onChatWorkspaceConsentRequested() {},
      onAiMarketplacePublishConfirmRequested(cb) {
        captured.publish = cb;
      },
      onGuidedSetupRequested() {},
      onNativeInputTerminal() {},
      notifyAiMarketplacePublishConfirmCompleted(payload) {
        completions.push(payload);
      },
    },
  };
  const documentObject = {
    getElementById() {
      return null;
    },
  };
  const context = {
    window: windowObject,
    document: documentObject,
    console,
    setTimeout,
    clearTimeout,
    Promise,
    JSON,
    URL,
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: LISTENERS_PATH });
  windowObject.setupBackendModalListeners();
  return { window: windowObject, captured, completions };
}

test("backend modal listener routes publish confirmations into the modal runner", async () => {
  const { window, captured, completions } = loadBackendModalListenersHarness();
  assert.equal(typeof captured.publish, "function", "publish request listener registered");

  // Without the modal runner available the flow completes with an error so
  // the blocked route never hangs on a dead renderer.
  captured.publish({ flow_id: "bm-flow-0", mode: "publish-agent" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completions.length, 1);
  assert.equal(completions[0].flow_id, "bm-flow-0");
  assert.equal(completions[0].action, "error");

  // With the runner present, the payload is handed through (no tab shell in
  // this harness → the modal runs immediately).
  const ran = [];
  window.runAiMarketplacePublishModal = async (payload) => {
    ran.push(payload);
    return { action: "approved" };
  };
  captured.publish({ flow_id: "bm-flow-1", mode: "publish-agent", title: "T" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ran.length, 1);
  assert.equal(ran[0].flow_id, "bm-flow-1");
  assert.equal(ran[0].launchSource, "backend-requested");

  // A runner crash also fails the flow closed via the completion channel.
  window.runAiMarketplacePublishModal = async () => {
    throw new Error("modal exploded");
  };
  captured.publish({ flow_id: "bm-flow-2" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completions.at(-1).flow_id, "bm-flow-2");
  assert.equal(completions.at(-1).action, "error");
  assert.match(completions.at(-1).error, /modal exploded/);
});

// Agent publishes batch with everything else: ALL modes route into the
// batching modal so a parallel burst of publish_agent tool calls aggregates
// into ONE dialog instead of the losers fast-failing publish_ui_busy. The
// consolidated agents.js flow survives only as the degraded fallback for
// hosts where the batch runner is missing.
test("agent publishes route into the batching modal; the consolidated flow is the fallback", async () => {
  const { window, captured, completions } = loadBackendModalListenersHarness();
  const routed = [];
  window.AgentsTabModule = {
    publishAgentFromBackendRequest: async (payload) => {
      routed.push(payload);
    },
  };
  const batchRan = [];
  window.runAiMarketplacePublishModal = async (payload) => {
    batchRan.push(payload);
    return { action: "approved" };
  };

  // publish-agent with the batch runner present → batching modal; the
  // consolidated seam is untouched.
  captured.publish({
    flow_id: "bm-flow-agent",
    mode: "publish-agent",
    agent: { id: "agent-1", name: "Agent One" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(batchRan.length, 1);
  assert.equal(batchRan[0].flow_id, "bm-flow-agent");
  assert.equal(batchRan[0].agent.id, "agent-1");
  assert.equal(batchRan[0].launchSource, "backend-requested");
  assert.equal(routed.length, 0, "the consolidated seam stays cold");

  // A parallel burst all lands in the same runner — nothing busy-fails.
  captured.publish({
    flow_id: "bm-flow-agent-2",
    mode: "publish-agent",
    agent: { id: "agent-2", name: "Agent Two" },
  });
  captured.publish({
    flow_id: "bm-flow-agent-3",
    mode: "publish-agent",
    agent: { id: "agent-3", name: "Agent Three" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(batchRan.length, 3);
  assert.equal(
    completions.filter((c) => c.action === "error").length,
    0,
    "no publish_ui_busy style rejections",
  );

  // Skill publishes keep the same batching component.
  captured.publish({
    flow_id: "bm-flow-skill",
    mode: "publish-skill",
    skill: { name: "s" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(batchRan.length, 4);
  assert.equal(routed.length, 0);

  // Batch runner missing → publish-agent degrades to the consolidated flow.
  window.runAiMarketplacePublishModal = undefined;
  captured.publish({
    flow_id: "bm-flow-fallback",
    mode: "publish-agent",
    agent: { id: "agent-1", name: "Agent One" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(routed.length, 1);
  assert.equal(routed[0].flow_id, "bm-flow-fallback");
  assert.equal(routed[0].launchSource, "backend-requested");

  // A fallback-seam crash fails the flow closed on the completion channel.
  window.AgentsTabModule.publishAgentFromBackendRequest = async () => {
    throw new Error("consolidated flow exploded");
  };
  captured.publish({
    flow_id: "bm-flow-crash",
    mode: "publish-agent",
    agent: { id: "agent-1" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completions.at(-1).flow_id, "bm-flow-crash");
  assert.equal(completions.at(-1).action, "error");
  assert.match(completions.at(-1).error, /consolidated flow exploded/);
});

// ---------------------------------------------------------------------------
// Dev-only auto-approve: flagged agentic flows self-approve ~1s after the
// modal is visibly presented, without ever moving focus off Cancel. Manual
// flows carry no flag (the stamp lives on the agentic broadcast only).
// ---------------------------------------------------------------------------

const AUTO_APPROVE_RACE_MS = 8000;
const raceAutoApprove = (promise, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} never settled`)), AUTO_APPROVE_RACE_MS),
    ),
  ]);

test("an auto_approve flow self-approves ~1s after showing and keeps focus on Cancel", async () => {
  const harness = loadPublishModalHarness();
  const resultPromise = harness.window.runAiMarketplacePublishModal({
    flow_id: "flow-auto",
    mode: "publish-skill",
    title: "Publish skill",
    confirm_label: "Publish",
    summary: "This shares the skill.",
    solution_type: "skills",
    skill: { name: "My Skill" },
    auto_approve: true,
  });
  await flushMicrotasks();
  assert.ok(harness.el("modal").classList.contains("visible"));

  // Well inside the 1s window nothing has completed yet.
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(harness.calls.completed.length, 0, "no approval before the 1s delay");

  const result = roundTrip(await raceAutoApprove(resultPromise, "auto-approve"));
  assert.deepEqual(result, { action: "approved" });
  assert.deepEqual(roundTrip(harness.calls.completed), [
    { flow_id: "flow-auto", action: "approved" },
  ]);
  // The focus-on-Cancel safety invariant survives the auto-click.
  assert.equal(harness.el("approve-btn").focusCalls, 0);
  assert.ok(harness.el("cancel-btn").focusCalls >= 1);
  assert.equal(harness.window.AiMarketplacePublishBatch.isActive(), false);
});

test("unflagged flows never self-approve", async () => {
  const harness = loadPublishModalHarness();
  const resultPromise = harness.window.runAiMarketplacePublishModal({
    flow_id: "flow-manual",
    mode: "unpublish",
    title: "Unpublish skill",
    confirm_label: "Unpublish",
    summary: "Removes the listing.",
    solution_id: "sol-1",
    solution_type: "skills",
    skill: { name: "My Skill" },
  });
  await flushMicrotasks();

  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.equal(harness.calls.completed.length, 0, "still waiting on the user");
  assert.ok(harness.el("modal").classList.contains("visible"));

  harness.el("cancel-btn").onclick();
  const result = roundTrip(await resultPromise);
  assert.deepEqual(result, { action: "denied" });
});

test("a flagged newcomer arms the batch and one timer approves every checked item", async () => {
  const harness = loadPublishModalHarness();
  // First flow is UNFLAGGED (e.g. requested before the dev toggle flipped):
  // showing it arms nothing.
  const firstPromise = harness.window.runAiMarketplacePublishModal({
    flow_id: "flow-b1",
    mode: "unpublish",
    title: "Unpublish skill",
    confirm_label: "Unpublish",
    summary: "Removes the listing.",
    solution_type: "skills",
    skill: { name: "Skill One" },
  });
  await flushMicrotasks();
  // A flagged flow live-appends into the open modal and arms the timer; the
  // single decisive approve covers the whole checked batch.
  const secondPromise = harness.window.runAiMarketplacePublishModal({
    flow_id: "flow-b2",
    mode: "publish-skill",
    title: "Publish skill",
    confirm_label: "Publish",
    summary: "This shares the skill.",
    solution_type: "skills",
    skill: { name: "Skill Two" },
    auto_approve: true,
  });
  await flushMicrotasks();

  const [first, second] = roundTrip(
    await raceAutoApprove(Promise.all([firstPromise, secondPromise]), "batch auto-approve"),
  );
  assert.deepEqual(first, { action: "approved" });
  assert.deepEqual(second, { action: "approved" });
  assert.deepEqual(roundTrip(harness.calls.completed), [
    { flow_id: "flow-b1", action: "approved" },
    { flow_id: "flow-b2", action: "approved" },
  ]);
});

test("hiding cancels the pending auto-approve; reopen re-arms it", async () => {
  const harness = loadPublishModalHarness();
  const resultPromise = harness.window.runAiMarketplacePublishModal({
    flow_id: "flow-hide",
    mode: "publish-skill",
    title: "Publish skill",
    confirm_label: "Publish",
    summary: "This shares the skill.",
    solution_type: "skills",
    skill: { name: "My Skill" },
    auto_approve: true,
  });
  await flushMicrotasks();

  // Park it behind the chat pill before the timer fires.
  await harness.window.hideAiMarketplacePublishModal();
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.equal(harness.calls.completed.length, 0, "parked batches never self-approve");

  // Reopen shows the modal again and re-arms the 1s window.
  for (const callback of harness.listeners.reopen) {
    callback({ kind: "marketplace_publish", flow_id: "flow-hide" });
  }
  await flushMicrotasks();
  const result = roundTrip(await raceAutoApprove(resultPromise, "reopen auto-approve"));
  assert.deepEqual(result, { action: "approved" });
});

test("a user cancel inside the window denies and no late auto-approve fires", async () => {
  const harness = loadPublishModalHarness();
  const resultPromise = harness.window.runAiMarketplacePublishModal({
    flow_id: "flow-cancel",
    mode: "publish-skill",
    title: "Publish skill",
    confirm_label: "Publish",
    summary: "This shares the skill.",
    solution_type: "skills",
    skill: { name: "My Skill" },
    auto_approve: true,
  });
  await flushMicrotasks();

  await new Promise((resolve) => setTimeout(resolve, 300));
  harness.el("cancel-btn").onclick();
  const result = roundTrip(await resultPromise);
  assert.deepEqual(result, { action: "denied" });

  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.deepEqual(
    roundTrip(harness.calls.completed),
    [{ flow_id: "flow-cancel", action: "denied" }],
    "the cleared timer never sends a late approval",
  );
});

// Round-26 batch redesign: approvals group by (mode, exact shared summary) —
// the backend boilerplate renders ONCE per group above a responsive grid, the
// dialog widens via the modal-level `batch` class, and every per-item
// automation id survives grouping.
test("batch groups render the shared boilerplate once above a grid of items", async () => {
  const harness = loadPublishModalHarness();
  const skillBoilerplate =
    "This shares the skill with everyone at Portico so they can add it to their own AI Chat sessions (its SKILL.md, references, and scripts become visible on the AI Marketplace).";
  const settled = [
    harness.window.runAiMarketplacePublishModal({
      flow_id: "flow-s1",
      mode: "publish-skill",
      title: 'Publish skill "alpha"',
      confirm_label: "Publish",
      summary: skillBoilerplate,
      solution_type: "skills",
      skill: { name: "alpha" },
    }),
  ];
  await flushMicrotasks();
  settled.push(
    harness.window.runAiMarketplacePublishModal({
      flow_id: "flow-s2",
      mode: "publish-skill",
      title: 'Publish skill "beta"',
      confirm_label: "Publish",
      summary: skillBoilerplate,
      solution_type: "skills",
      skill: { name: "beta" },
    }),
  );
  await flushMicrotasks();
  settled.push(
    harness.window.runAiMarketplacePublishModal({
      flow_id: "flow-u1",
      mode: "unpublish",
      title: 'Remove "gamma" from the AI Marketplace',
      confirm_label: "Unpublish",
      summary: "This unpublishes it for everyone. Installed copies are not affected.",
      solution_id: "sol-g",
      solution_type: "skills",
      skill: { name: "gamma", published: true },
    }),
  );
  await flushMicrotasks();

  const itemsHtml = harness.el("items").innerHTML;
  assert.equal(
    itemsHtml.split(skillBoilerplate).length,
    2,
    "the shared publish-skill boilerplate renders exactly once (group level)",
  );
  assert.match(itemsHtml, /Publish · Skills \(2\)/);
  assert.match(itemsHtml, /Unpublish \(1\)/);
  assert.match(itemsHtml, /ai-marketplace-publish-group-grid/);
  assert.ok(
    harness.el("modal").classList.contains("batch"),
    "batch mode widens the dialog via the batch class",
  );
  for (const suffix of [
    "item-check-flow-s1",
    "item-check-flow-s2",
    "item-check-flow-u1",
    "item-card-flow-s1",
    "item-badge-flow-u1",
  ]) {
    assert.ok(harness.el(suffix), `${suffix} still resolves after grouping`);
  }

  harness.el("modal").onkeydown({ key: "Escape", preventDefault() {} });
  await Promise.all(settled);
  assert.ok(!harness.el("modal").classList.contains("visible"));
});

// Differing publish-agent visibility suffixes are part of the summary string,
// so they intentionally split into separate groups; prompt previews collapse
// to <details> inside batch grids; and a live-append re-render must keep an
// item the user already unchecked visually unchecked (the old builder
// hardcoded checked/aria-checked="true").
test("visibility variants split agent groups and re-renders keep unchecked state", async () => {
  const harness = loadPublishModalHarness();
  const agentBase =
    "This shares the agent's name, description, system prompt, and configured skills/tools with everyone who can see it on the AI Marketplace.";
  const restrictedSummary = `${agentBase}\n\nVisible to: a@example.invalid`;
  const discoverableSummary = `${agentBase}\n\nVisibility: discoverable per your marketplace's default rules.`;
  const one = harness.window.runAiMarketplacePublishModal({
    flow_id: "flow-a1",
    mode: "publish-agent",
    title: "Publish agent",
    confirm_label: "Publish",
    summary: restrictedSummary,
    solution_type: "agents",
    agent: { id: "agent-1", name: "Agent One", system_prompt_preview: "prompt-one" },
  });
  await flushMicrotasks();
  const two = harness.window.runAiMarketplacePublishModal({
    flow_id: "flow-a2",
    mode: "publish-agent",
    title: "Publish agent",
    confirm_label: "Publish",
    summary: discoverableSummary,
    solution_type: "agents",
    agent: { id: "agent-2", name: "Agent Two", system_prompt_preview: "prompt-two" },
  });
  await flushMicrotasks();

  // Rendered markup HTML-escapes the summary ("agent's" -> "agent&#39;s"),
  // so occurrence counting must use the escaped form.
  const escapedAgentBase = agentBase.replace(/'/g, "&#39;");
  let itemsHtml = harness.el("items").innerHTML;
  assert.equal(
    itemsHtml.split(escapedAgentBase).length,
    3,
    "different visibility suffixes form two groups (base boilerplate once per group)",
  );
  assert.match(itemsHtml, /Visible to: a@portico\.com/);
  assert.match(itemsHtml, /discoverable per your marketplace/);
  const agentGroupHeaders = itemsHtml.match(/Publish · Agents \(1\)/g) || [];
  assert.equal(agentGroupHeaders.length, 2);
  // Prompt preview is a collapsed <details> in batch mode (no `open`).
  assert.match(itemsHtml, /<details class="ai-marketplace-publish-prompt-block">/);
  assert.match(itemsHtml, /System prompt preview/);
  assert.ok(harness.el("item-prompt-flow-a1"));

  // Uncheck flow-a1, then live-append a third flow: the rebuilt markup keeps
  // flow-a1 unchecked and the approve count reflects reality.
  harness.el("item-check-flow-a1").onclick();
  assert.equal(harness.el("approve-btn").textContent, "Approve 1");
  const three = harness.window.runAiMarketplacePublishModal({
    flow_id: "flow-a3",
    mode: "publish-agent",
    title: "Publish agent",
    confirm_label: "Publish",
    summary: discoverableSummary,
    solution_type: "agents",
    agent: { id: "agent-3", name: "Agent Three" },
  });
  await flushMicrotasks();
  assert.equal(harness.el("approve-btn").textContent, "Approve 2");
  itemsHtml = harness.el("items").innerHTML;
  assert.match(
    itemsHtml,
    /class="ai-marketplace-publish-item-check"[\s\S]{0,200}?id="ai-marketplace-publish-item-check-flow-a1"[\s\S]{0,200}?aria-checked="false"/,
    "re-render preserves the unchecked presentation for flow-a1",
  );
  assert.match(
    itemsHtml,
    /class="ai-marketplace-publish-item-check checked"[\s\S]{0,200}?id="ai-marketplace-publish-item-check-flow-a2"/,
  );

  harness.el("approve-btn").onclick();
  assert.deepEqual(roundTrip(harness.calls.completed), [
    { flow_id: "flow-a1", action: "denied" },
    { flow_id: "flow-a2", action: "approved" },
    { flow_id: "flow-a3", action: "approved" },
  ]);
  assert.deepEqual(roundTrip(await one), { action: "denied" });
  assert.deepEqual(roundTrip(await two), { action: "approved" });
  assert.deepEqual(roundTrip(await three), { action: "approved" });
});

// Evicting down to one item reverts to the narrow single presentation: batch
// class off, per-item header gone, the surviving item's summary back in the
// header slot, and the prompt preview expanded again.
test("terminal eviction down to one item reverts to the single presentation", async () => {
  const harness = loadPublishModalHarness();
  const first = harness.window.runAiMarketplacePublishModal({
    flow_id: "flow-e1",
    mode: "publish-agent",
    title: "Publish agent",
    confirm_label: "Publish",
    summary: "Agent summary.",
    solution_type: "agents",
    agent: { id: "agent-e1", name: "Agent E1", system_prompt_preview: "preview-e1" },
  });
  await flushMicrotasks();
  const second = harness.window.runAiMarketplacePublishModal({
    flow_id: "flow-e2",
    mode: "publish-skill",
    title: 'Publish skill "epsilon"',
    confirm_label: "Publish",
    summary: "Skill summary.",
    solution_type: "skills",
    skill: { name: "epsilon" },
  });
  await flushMicrotasks();
  assert.ok(harness.el("modal").classList.contains("batch"));

  for (const listener of harness.listeners.terminal) {
    listener({ kind: "marketplace_publish", flow_id: "flow-e2", status: "denied" });
  }
  await flushMicrotasks();
  assert.ok(
    !harness.el("modal").classList.contains("batch"),
    "single survivor drops the batch presentation",
  );
  assert.equal(harness.el("title").textContent, "Publish agent");
  assert.equal(harness.el("summary").textContent, "Agent summary.");
  assert.match(
    harness.el("items").innerHTML,
    /<details class="ai-marketplace-publish-prompt-block" open>/,
    "single presentation expands the prompt preview",
  );
  assert.deepEqual(roundTrip(await second), {
    success: false,
    status: "denied",
    flow_id: "flow-e2",
  });

  harness.el("cancel-btn").onclick();
  assert.deepEqual(roundTrip(await first), { action: "denied" });
});

// ---------------------------------------------------------------------------
// Agentic parity: dependent-skill provenance table + cascade ticker
// (publish-agent items) and busy-until-outcome (main-side items)
// ---------------------------------------------------------------------------

function publishHooksFixture(resolveCalls = []) {
  return {
    resolveBackendAgentPublishSkillPlan: async (args) => {
      resolveCalls.push(args);
      return {
        plans: [
          {
            canonicalName: "alpha",
            displayName: "Alpha",
            action: "publish-new",
            provenance: "user-new",
            hasMarketplaceWork: true,
          },
          {
            canonicalName: "beta",
            displayName: "Beta",
            action: "system",
            provenance: "system",
            hasMarketplaceWork: false,
          },
        ],
        errors: [],
      };
    },
    buildSkillProvenanceRowsHtml: (resolution, { statusIdPrefix = "" } = {}) =>
      resolution.plans
        .map(
          (plan) =>
            `<span id="${statusIdPrefix}${plan.canonicalName}" data-status="${
              plan.hasMarketplaceWork ? "idle" : "current"
            }"></span>`,
        )
        .join("") || '<div class="no-plans"></div>',
  };
}

test("publish-agent items resolve the skill plan once and render provenance rows", async () => {
  const resolveCalls = [];
  const harness = loadPublishModalHarness({
    publishHooks: publishHooksFixture(resolveCalls),
  });
  const flow = harness.window.runAiMarketplacePublishModal({
    flow_id: "flow-plan",
    mode: "publish-agent",
    title: "Publish Agent One",
    confirm_label: "Publish",
    agent: { id: "agent-1", name: "Agent One", skill_ids: ["alpha", "beta"] },
    allowed_emails: ["dsantiago@example.invalid"],
  });
  await flushMicrotasks();

  // The resolver ran once with the executor's exact audience inputs.
  assert.deepEqual(roundTrip(resolveCalls), [
    { agentId: "agent-1", allowedEmailsOverride: ["dsantiago@example.invalid"] },
  ]);
  // Rows landed in the stable per-item container; the label counts skill ids.
  const rows = harness.elements.get(
    "ai-marketplace-publish-item-skillrows-flow-plan",
  );
  assert.match(rows.innerHTML, /flow-plan-alpha/);
  assert.match(harness.el("items").innerHTML, /Skills \(2\)/);

  // A live-append re-render rebuilds the section from cache — no re-resolve.
  const flowSkill = harness.window.runAiMarketplacePublishModal({
    flow_id: "flow-extra",
    mode: "publish-skill",
    title: "Publish a skill",
    confirm_label: "Publish",
    skill: { name: "loupe" },
  });
  await flushMicrotasks();
  assert.equal(resolveCalls.length, 1, "plan resolved once per item");
  assert.match(harness.el("items").innerHTML, /Skills \(2\)/);

  harness.el("cancel-btn").onclick();
  assert.deepEqual(roundTrip(await flow), { action: "denied" });
  assert.deepEqual(roundTrip(await flowSkill), { action: "denied" });
});

test("a blocked skill plan fails that item closed: unchecked, disabled, denied on approve", async () => {
  const harness = loadPublishModalHarness({
    publishHooks: {
      resolveBackendAgentPublishSkillPlan: async () => ({
        plans: [],
        errors: [{ skillId: "ghost-skill", error: "not attachable" }],
      }),
      buildSkillProvenanceRowsHtml: () => '<div class="blocked-rows"></div>',
    },
  });
  const flowBlocked = harness.window.runAiMarketplacePublishModal({
    flow_id: "flow-blocked",
    mode: "publish-agent",
    title: "Publish Agent X",
    confirm_label: "Publish",
    agent: { id: "agent-x", name: "Agent X", skill_ids: ["ghost-skill"] },
  });
  const flowOk = harness.window.runAiMarketplacePublishModal({
    flow_id: "flow-ok",
    mode: "publish-skill",
    title: "Publish a skill",
    confirm_label: "Publish",
    skill: { name: "loupe" },
  });
  await flushMicrotasks();

  const check = harness.elements.get(
    "ai-marketplace-publish-item-check-flow-blocked",
  );
  assert.equal(check.disabled, true, "blocked items cannot be re-checked");
  assert.equal(check.getAttribute("aria-checked"), "false");
  assert.match(
    harness.elements
      .get("ai-marketplace-publish-item-skillrows-flow-blocked")
      .innerHTML.toString(),
    /blocked-rows/,
  );

  harness.el("approve-btn").onclick();
  await flushMicrotasks();
  // The blocked item denies; the healthy skill item keeps the legacy
  // instant-approve contract (no outcome channel in this harness).
  assert.deepEqual(roundTrip(await flowBlocked), { action: "denied" });
  assert.deepEqual(roundTrip(await flowOk), { action: "approved" });
});

test("skill-plan loading renders a table skeleton and gates approve until resolution", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const harness = loadPublishModalHarness({
    publishHooks: {
      resolveBackendAgentPublishSkillPlan: async () => {
        await gate;
        return {
          plans: [
            {
              canonicalName: "alpha",
              displayName: "Alpha",
              action: "publish-new",
              provenance: "user-new",
              hasMarketplaceWork: true,
            },
          ],
          errors: [],
        };
      },
      buildSkillProvenanceRowsHtml: () =>
        '<table class="agents-publish-skill-table"></table>',
    },
  });
  const flow = harness.window.runAiMarketplacePublishModal({
    flow_id: "flow-skel",
    mode: "publish-agent",
    title: "Publish Agent One",
    confirm_label: "Publish",
    agent: { id: "agent-1", name: "Agent One", skill_ids: ["a", "b", "c"] },
  });
  await flushMicrotasks();

  // Loading state: a table-shaped skeleton (one shimmer row per skill id)
  // holds the section, and the primary button is gated.
  const itemsHtml = harness.el("items").innerHTML.toString();
  assert.match(itemsHtml, /ai-marketplace-publish-skills-skeleton/);
  assert.equal(
    itemsHtml.split("ai-marketplace-publish-skills-skeleton-row").length - 1,
    3,
    "one shimmer row per skill id",
  );
  assert.equal(
    harness.el("approve-btn").disabled,
    true,
    "approve is gated while the plan resolves",
  );

  release();
  await flushMicrotasks();
  assert.match(
    harness.elements
      .get("ai-marketplace-publish-item-skillrows-flow-skel")
      .innerHTML.toString(),
    /agents-publish-skill-table/,
    "resolved rows replace the skeleton",
  );
  assert.equal(
    harness.el("approve-btn").disabled,
    false,
    "approve releases once resolution lands",
  );

  harness.el("cancel-btn").onclick();
  assert.deepEqual(roundTrip(await flow), { action: "denied" });
});

test("hook-less hosts land unavailable immediately and never gate approve", async () => {
  const harness = loadPublishModalHarness();
  const flow = harness.window.runAiMarketplacePublishModal({
    flow_id: "flow-nohooks",
    mode: "publish-agent",
    title: "Publish Agent One",
    confirm_label: "Publish",
    agent: { id: "agent-1", name: "Agent One", skill_ids: ["a"] },
  });
  await flushMicrotasks();
  assert.equal(harness.el("approve-btn").disabled, false);
  harness.el("cancel-btn").onclick();
  assert.deepEqual(roundTrip(await flow), { action: "denied" });
});

test("the queue executes the displayed plan and ticks provenance rows through the cascade", async () => {
  const resolveCalls = [];
  const harness = loadPublishModalHarness({
    publishHooks: publishHooksFixture(resolveCalls),
  });
  const phases = [];
  harness.window.AgentsTabModule = {
    loadMyAgents: () => {},
    executeBackendAgentPublish: async (args) => {
      const cell = harness.elements.get(
        "ai-marketplace-publish-item-skillstatus-flow-plan-alpha",
      );
      const chip = harness.elements.get(
        "ai-marketplace-publish-item-status-flow-plan",
      );
      phases.push(["queued", cell.getAttribute("data-status")]);
      args.onProgress({ phase: "skill:start", plan: { canonicalName: "alpha" } });
      phases.push([
        "skill:start",
        cell.getAttribute("data-status"),
        chip.textContent,
      ]);
      args.onProgress({ phase: "skill:done", plan: { canonicalName: "alpha" } });
      phases.push(["skill:done", cell.getAttribute("data-status")]);
      args.onProgress({ phase: "agent:start" });
      phases.push(["agent:start", chip.textContent]);
      return {
        solution_id: "sol-1",
        plan: roundTrip(args.resolvedSkillPlan),
      };
    },
  };

  const flow = harness.window.runAiMarketplacePublishModal({
    flow_id: "flow-plan",
    mode: "publish-agent",
    title: "Publish Agent One",
    confirm_label: "Publish",
    agent: { id: "agent-1", name: "Agent One", skill_ids: ["alpha", "beta"] },
  });
  await flushMicrotasks();
  harness.el("approve-btn").onclick();
  await flushMicrotasks();

  assert.deepEqual(roundTrip(await flow), { action: "published" });
  // The executor received the SAME plan the table displayed.
  const published = harness.calls.completed.find((c) => c.action === "published");
  assert.equal(published.result.plan.length, 2);
  assert.equal(published.result.plan[0].canonicalName, "alpha");
  // Rows ticked: real-work row was pre-flipped to Waiting before the queue,
  // then walked working → done; the chip narrated the skill sub-step.
  assert.deepEqual(roundTrip(phases), [
    ["queued", "pending"],
    ["skill:start", "working", "Publishing skills…"],
    ["skill:done", "done"],
    ["agent:start", "Publishing…"],
  ]);
});

test("approved unpublish holds a busy chip until the outcome push, then closes", async () => {
  const harness = loadPublishModalHarness({ outcomeChannel: true });
  const flow = harness.window.runAiMarketplacePublishModal({
    flow_id: "flow-unpub",
    mode: "unpublish",
    title: 'Remove "X" from the AI Marketplace',
    confirm_label: "Unpublish",
    solution_id: "sol-1",
    solution_type: "portico-agents",
    agent: { id: "sol-1", name: "X" },
  });
  await flushMicrotasks();
  harness.el("approve-btn").onclick();
  await flushMicrotasks();

  // publishing → approved sent up front; the modal stays busy.
  assert.deepEqual(roundTrip(harness.calls.completed), [
    { flow_id: "flow-unpub", action: "publishing" },
    { flow_id: "flow-unpub", action: "approved" },
  ]);
  assert.ok(harness.el("modal").classList.contains("visible"));
  assert.equal(harness.el("approve-btn").textContent, "Removing…");
  assert.equal(harness.el("cancel-btn").disabled, true);
  assert.equal(harness.el("hide-btn").disabled, true, "completed flows cannot re-park");
  assert.match(harness.el("items").innerHTML, /Removing…/);

  harness.emitOutcome({ flow_id: "flow-unpub", ok: true, message: "removed" });
  await flushMicrotasks();
  const chip = harness.elements.get("ai-marketplace-publish-item-status-flow-unpub");
  assert.equal(chip.getAttribute("data-status"), "published");
  assert.equal(chip.textContent, "✓ Removed");
  assert.deepEqual(roundTrip(await flow), { action: "approved" });
  // Post-run linger: the button keeps its final busy label (and stays
  // disabled) instead of flashing "Approve 0" while the chrome closes.
  assert.equal(harness.el("approve-btn").textContent, "Removing…");
  assert.equal(harness.el("approve-btn").disabled, true);
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.ok(!harness.el("modal").classList.contains("visible"));
  assert.equal(harness.window.AiMarketplacePublishBatch.isActive(), false);
});

test("an unpublish outcome failure keeps the modal open with the inline error", async () => {
  const harness = loadPublishModalHarness({ outcomeChannel: true });
  const flow = harness.window.runAiMarketplacePublishModal({
    flow_id: "flow-unpub-fail",
    mode: "unpublish",
    title: 'Remove "X" from the AI Marketplace',
    confirm_label: "Unpublish",
    solution_id: "sol-1",
    solution_type: "portico-agents",
    agent: { id: "sol-1", name: "X" },
  });
  await flushMicrotasks();
  harness.el("approve-btn").onclick();
  await flushMicrotasks();

  harness.emitOutcome({ flow_id: "flow-unpub-fail", ok: false, message: "boom" });
  await flushMicrotasks();
  assert.deepEqual(roundTrip(await flow), { action: "approved" });
  const chip = harness.elements.get(
    "ai-marketplace-publish-item-status-flow-unpub-fail",
  );
  assert.equal(chip.getAttribute("data-status"), "failed");
  assert.equal(chip.textContent, "✕ Failed");
  const errorEl = harness.elements.get(
    "ai-marketplace-publish-item-error-flow-unpub-fail",
  );
  assert.equal(errorEl.textContent, "boom");
  assert.equal(errorEl.hidden, false);
  // The modal stays open for the user to read; chrome unlocks and the
  // approve button honestly says what a click now does.
  assert.ok(harness.el("modal").classList.contains("visible"));
  assert.equal(harness.el("cancel-btn").disabled, false);
  assert.equal(harness.el("hide-btn").disabled, false);
  assert.equal(harness.el("approve-btn").textContent, "Dismiss");
  assert.equal(harness.el("approve-btn").disabled, false);

  // Dismissing sends NO second completion for the already-settled flow.
  const completionsBefore = harness.calls.completed.length;
  harness.el("cancel-btn").onclick();
  assert.equal(harness.calls.completed.length, completionsBefore);
  assert.ok(!harness.el("modal").classList.contains("visible"));
  assert.equal(harness.window.AiMarketplacePublishBatch.isActive(), false);
});

test("a lost outcome push settles via the one-shot fallback and late pushes are ignored", async () => {
  const harness = loadPublishModalHarness({ outcomeChannel: true });
  harness.window.AiMarketplacePublishBatch._setOutcomeFallbackMsForTests(50);
  const flow = harness.window.runAiMarketplacePublishModal({
    flow_id: "flow-lost",
    mode: "unpublish",
    title: 'Remove "X" from the AI Marketplace',
    confirm_label: "Unpublish",
    solution_id: "sol-1",
    solution_type: "portico-agents",
    agent: { id: "sol-1", name: "X" },
  });
  await flushMicrotasks();
  harness.el("approve-btn").onclick();
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.deepEqual(roundTrip(await flow), { action: "approved" });
  const chip = harness.elements.get("ai-marketplace-publish-item-status-flow-lost");
  assert.equal(chip.textContent, "✓ Requested");
  assert.match(chip.getAttribute("title"), /Still finishing/);

  // A late push finds no registered wait and changes nothing.
  harness.emitOutcome({ flow_id: "flow-lost", ok: false, message: "late" });
  await flushMicrotasks();
  assert.equal(chip.textContent, "✓ Requested");
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.ok(!harness.el("modal").classList.contains("visible"));
  harness.window.AiMarketplacePublishBatch._setOutcomeFallbackMsForTests(30000);
});
