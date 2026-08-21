// Headless host for the REAL Electron main-process HTTP API (api.js) under
// plain Node — the linchpin of the agentic MCP harness. Every marketplace /
// skills / agents MCP tool in the Rust core servers proxies to these routes,
// so running the real route handlers (operations, install, marketplace-service,
// link registries, user-skill-service) against the mock Solutions Marketplace
// gives full-fidelity behavior without Electron, Docker, or OWUI.
//
// Stub strategy mirrors ai-marketplace-integration-fixture.js: a Module._load
// hook for "electron" plus require.cache stubs for bootstrap / docker-mcp /
// current-user / owui-views. docker-mcp.invokeMcpTool is routed to the REAL
// Rust MCP servers through the harness broker (mcp-broker.js) so tool-in-tool
// paths (publish-agent -> subagents_get_agent, delete guards ->
// subagents_list_agents, ...) exercise the real binaries end to end.
//
// Publish/unpublish confirmations run the REAL pending+poll flow contract:
// a fake main window "receives" the ai-marketplace-publish-confirm-requested
// broadcast; when the payload carries auto_approve:true (driven by the
// dev-build marketplace-auto-approve.json preference, which this host writes
// when portico_AGENTIC_AUTO_APPROVE=1), the host completes the flow exactly as
// ipc.js's ai-marketplace-publish-confirm-completed handler would with
// action:"approved" — the route then executes the write main-side and the
// Rust proxy's flow-status polling observes the real outcome.
//
// Env contract (all required unless noted):
//   portico_HARNESS_PROJECT_ROOT   sandboxed project root (skills/, skills-user/, ...)
//   portico_HARNESS_USER_DATA      sandboxed Electron userData dir
//   portico_HARNESS_VIEWER_EMAIL   authenticated viewer identity (mutable at runtime)
//   portico_HARNESS_PORT           port to listen on (default: ephemeral)
//   portico_HARNESS_BROKER_URL     mcp-broker base URL (optional; MCP-dependent
//                              routes fail structurally without it)
//   AI_MARKETPLACE_BASE_URL    mock Solutions Marketplace base URL
//   AI_MARKETPLACE_API_KEY     API key handed to the marketplace client
//   portico_AGENTIC_AUTO_APPROVE   "1" -> write the dev-build auto-approve pref
//
// Admin surface (mounted on the same express app):
//   GET  /__harness/state       {viewerEmail, broadcasts, autoApprove}
//   POST /__harness/viewer      {"email": "..."} -> switch active viewer
//   POST /__harness/reset-links clears broadcast log

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const PROJECT_ROOT_ENV = process.env.portico_HARNESS_PROJECT_ROOT;
const USER_DATA = process.env.portico_HARNESS_USER_DATA;
if (!PROJECT_ROOT_ENV || !USER_DATA) {
  console.error("portico_HARNESS_PROJECT_ROOT and portico_HARNESS_USER_DATA are required");
  process.exit(1);
}

const SERVICES_DIR = path.join(__dirname, "..", "..", "electron-app", "src", "services");
const BROKER_URL = process.env.portico_HARNESS_BROKER_URL || "";

const hostState = {
  viewerEmail: process.env.portico_HARNESS_VIEWER_EMAIL || "tester@example.invalid",
  broadcasts: [],
};

process.env.PORTICO_RUNTIME_DISABLE_KEYCHAIN = "1";

// ---------------------------------------------------------------------------
// Auto-approve preference (the shipped dev-build mechanism)
// ---------------------------------------------------------------------------
const autoApproveEnabled = process.env.portico_AGENTIC_AUTO_APPROVE === "1";
fs.mkdirSync(USER_DATA, { recursive: true });
fs.mkdirSync(PROJECT_ROOT_ENV, { recursive: true });
if (autoApproveEnabled) {
  fs.writeFileSync(
    path.join(USER_DATA, "marketplace-auto-approve.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        autoApprove: true,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

// ---------------------------------------------------------------------------
// Fake main window: receives backend modal broadcasts
// ---------------------------------------------------------------------------
const fakeWindow = {
  id: 1,
  isDestroyed: () => false,
  show() {},
  focus() {},
  webContents: {
    isDestroyed: () => false,
    send(channel, payload) {
      hostState.broadcasts.push({ channel, payload, at: new Date().toISOString() });
      if (channel === "ai-marketplace-publish-confirm-requested") {
        setImmediate(() => handlePublishConfirmRequested(payload));
      }
    },
  },
};

// ---------------------------------------------------------------------------
// Electron stub via Module._load hook (must precede all service requires)
// ---------------------------------------------------------------------------
const electronStub = {
  app: {
    getPath: (kind) => (kind === "userData" ? USER_DATA : USER_DATA),
    isPackaged: false,
    getVersion: () => "0.0.0-agentic-harness",
  },
  BrowserWindow: {
    getAllWindows: () => [fakeWindow],
    getFocusedWindow: () => null,
    fromId: (id) => (Number(id) === fakeWindow.id ? fakeWindow : null),
    fromWebContents: () => fakeWindow,
  },
  dialog: {
    // Deny by default: the native-dialog fallback should never silently
    // approve — scenarios must exercise the real flow contract instead.
    showMessageBox: async () => ({ response: 0 }),
  },
  shell: {},
  ipcMain: { on() {}, handle() {} },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return electronStub;
  return originalLoad.apply(this, arguments);
};

// ---------------------------------------------------------------------------
// require.cache stubs (fixture pattern)
// ---------------------------------------------------------------------------
const resolveDep = (rel) => require.resolve(rel, { paths: [SERVICES_DIR] });

function stripMcpoToolPrefix(serverId, toolName) {
  const prefix = `${String(serverId).replace(/-/g, "_")}_`;
  return toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;
}

async function brokerInvokeMcpTool(serverId, toolName, inputs) {
  if (!BROKER_URL) {
    return { success: false, error: "harness broker not configured" };
  }
  const started = Date.now();
  try {
    const response = await fetch(`${BROKER_URL}/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        server: serverId,
        tool: stripMcpoToolPrefix(serverId, toolName),
        arguments: inputs || {},
      }),
    });
    const outcome = await response.json();
    if (outcome.ok) {
      return {
        success: true,
        status: 200,
        statusText: "OK",
        data: outcome.payload,
        elapsed: Date.now() - started,
      };
    }
    // Faithful to mcp-orc: tool-level protocol errors surface as HTTP 200
    // with an {is_error, message} envelope.
    return {
      success: true,
      status: 200,
      statusText: "OK",
      data: {
        is_error: true,
        message: outcome.error?.message || "tool call failed",
      },
      elapsed: Date.now() - started,
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

const stubs = {
  [resolveDep("./bootstrap")]: {
    get PROJECT_ROOT() {
      return PROJECT_ROOT_ENV;
    },
    killProcessOnPort: async () => {},
    sendInitLog: () => {},
    execPromise: async () => ({ stdout: "", stderr: "" }),
  },
  [resolveDep("./docker-mcp")]: {
    invokeMcpTool: (serverId, toolName, inputs, _port) =>
      brokerInvokeMcpTool(serverId, toolName, inputs),
    isCoreServer: () => true,
    queueFullHealthCheck: () => {},
    broadcastHealthStatusUpdate: () => {},
    checkDockerStatus: async () => ({ running: false }),
    readHostMcpBridgePreferences: () => ({ data: { enabled: false } }),
  },
  [resolveDep("./current-user")]: {
    get: async () => ({
      authenticated: true,
      sessionSummary: { user: { email: hostState.viewerEmail } },
    }),
    onChange: () => () => {},
  },
  [resolveDep("./owui-views")]: {
    broadcastToOwnerViews() {},
    broadcastToViews() {},
    listViews: () => [],
  },
};

for (const [keyPath, exportsObject] of Object.entries(stubs)) {
  require.cache[keyPath] = {
    id: keyPath,
    filename: keyPath,
    loaded: true,
    exports: exportsObject,
  };
}

// Fresh-load the real stack so module-level electron destructures capture the
// stub (nothing should be cached in a fresh process, but keep parity with the
// fixture's caveat).
for (const rel of [
  "./shared-state",
  "./marketplace-publish-confirm-flows",
  "./marketplace-service",
  "./ai-marketplace-client",
  "./ai-marketplace-install",
  "./ai-marketplace-operations",
  "./ai-marketplace-skill-links",
  "./ai-marketplace-agent-links",
  "./user-skill-service",
  "./api",
]) {
  const keyPath = resolveDep(rel);
  if (!stubs[keyPath]) delete require.cache[keyPath];
}

const state = require(resolveDep("./shared-state"));
const confirmFlows = require(resolveDep("./marketplace-publish-confirm-flows"));
const api = require(resolveDep("./api"));

state.windows.main = fakeWindow;

// ---------------------------------------------------------------------------
// Real renderer planners (agents.js) in a vm bridge — the fixture's bridge —
// so agent publishes run the SAME consolidated pipeline production runs
// (dependent-skill plans + reference embedding), not the guarded main-side
// legacy path.
// ---------------------------------------------------------------------------
const fixture = require(resolveDep("./ai-marketplace-integration-fixture"));
const brokerSubagentsAdapter = {
  agents: new Map(),
  invokeMcpTool: (serverId, toolName, args) => brokerInvokeMcpTool(serverId, toolName, args),
};
function syncActiveMachine() {
  fixture.setActiveMachine({
    label: "agentic-harness",
    projectRoot: PROJECT_ROOT_ENV,
    userDataPath: USER_DATA,
    viewerEmail: hostState.viewerEmail,
    subagents: brokerSubagentsAdapter,
  });
}
syncActiveMachine();
const bridge = fixture.loadAgentsRendererBridge({
  ops: require(resolveDep("./ai-marketplace-operations")),
  installModule: require(resolveDep("./ai-marketplace-install")),
  marketplaceService: require(resolveDep("./marketplace-service")),
  client: require(resolveDep("./ai-marketplace-client")),
  skillLinks: require(resolveDep("./ai-marketplace-skill-links")),
  agentLinks: require(resolveDep("./ai-marketplace-agent-links")),
});

// ---------------------------------------------------------------------------
// Renderer mimic: complete publish-confirm flows exactly as ipc.js does
// ---------------------------------------------------------------------------
function completeFlowFromRenderer(flowId, action, payload = {}) {
  const entry = state.marketplacePublishFlowResults.get(flowId);
  if (!entry || entry.status !== "in_progress") return;
  if (action === "publishing") {
    if (typeof entry.onPublishing === "function") entry.onPublishing();
    return;
  }
  let result;
  if (action === "approved") {
    result = confirmFlows.buildMarketplacePublishApprovedResult(entry);
  } else if (action === "published") {
    result = confirmFlows.buildMarketplacePublishPublishedResult(entry, payload);
  } else if (action === "publish_failed") {
    result = confirmFlows.buildMarketplacePublishFailedResult(entry, payload);
  } else if (action === "denied" || action === "dismissed") {
    result = confirmFlows.buildMarketplacePublishDeniedResult(entry);
  } else {
    result = confirmFlows.buildMarketplacePublishErrorResult(
      entry,
      payload.error || `Unknown completion action: ${action}`,
      payload.code,
    );
  }
  state.completeMarketplacePublishFlow(flowId, result);
  if (typeof entry.resolveDecision === "function") {
    entry.resolveDecision(confirmFlows.marketplacePublishDecisionFromResult(result));
  }
}

// The renderer leg for agentic agent publishes: the same two planner hooks
// the consolidated modal drives (see ai-marketplace-flows.integration.test.js
// flow 1), completed with the same result contract agents.js sends
// (agents.js:7114).
async function runRendererAgentPublish(payload) {
  const flowId = payload.flow_id;
  try {
    const agentId = payload.agent && payload.agent.id;
    if (!agentId) {
      return completeFlowFromRenderer(flowId, "publish_failed", {
        error: "Malformed publish confirmation payload (missing agent id).",
      });
    }
    const agentRes = await brokerInvokeMcpTool("subagents", "subagents_get_agent", {
      model_id: agentId,
    });
    const agent = (agentRes && agentRes.data) || {};
    const promptRes = await brokerInvokeMcpTool(
      "subagents",
      "subagents_get_agent_system_prompt",
      { model_id: agentId },
    );
    const systemPrompt = ((promptRes && promptRes.data) || {}).system_prompt || "";
    const skillIds = Array.isArray(agent.skill_ids) ? agent.skill_ids : [];

    const resolution =
      await bridge.window.AgentsPublishHooks.resolveDependentSkillPlans(skillIds);
    if (Array.isArray(resolution.errors) && resolution.errors.length) {
      return completeFlowFromRenderer(flowId, "publish_failed", {
        error: resolution.errors
          .map((e) => (typeof e === "string" ? e : e.error || JSON.stringify(e)))
          .join("; ")
          .slice(0, 500),
        code: "dependent_skill_resolution_failed",
      });
    }
    completeFlowFromRenderer(flowId, "publishing");
    const published = await bridge.window.AgentsPublishHooks.pushAgentToMarketplace({
      localId: agentId,
      solutionId: payload.solution_id || "",
      args: {
        name: agent.name || agentId,
        description: agent.description || "",
        base_model_id: agent.base_model_id || "",
        system_prompt: systemPrompt,
        skill_ids: skillIds,
        tool_server_ids: Array.isArray(agent.tool_server_ids) ? agent.tool_server_ids : [],
        reasoning_effort: agent.reasoning_effort ?? null,
        allowed_emails:
          Array.isArray(payload.allowed_emails) && payload.allowed_emails.length
            ? payload.allowed_emails
            : null,
      },
      resolvedSkillPlan: resolution.plans,
    });
    const summary = published.skillPublishSummary || {};
    completeFlowFromRenderer(flowId, "published", {
      result: {
        solution_id: published.solutionId,
        status: (published.publishStatus && published.publishStatus.status) || "active",
        has_bundle:
          !published.publishStatus || published.publishStatus.has_bundle !== false,
        action: payload.solution_id ? "updated" : "created",
        name: agent.name || agentId,
        local_agent_id: agentId,
        dependent_skills: {
          published: Number(summary.published) || 0,
          updated: Number(summary.updated) || 0,
          adopted: Number(summary.adopted) || 0,
          referenced: Number(summary.referenced) || 0,
          unchanged: Number(summary.unchanged) || 0,
          gitReferenced: Number(summary.gitReferenced) || 0,
          repaired: Number(summary.repaired) || 0,
        },
        skills: Array.isArray(published.skills) ? published.skills : [],
        message: payload.solution_id
          ? `Marketplace copy updated (solution ${published.solutionId}).`
          : `Agent published to the AI Marketplace (solution ${published.solutionId}).`,
      },
    });
  } catch (error) {
    completeFlowFromRenderer(flowId, "publish_failed", {
      error: (error && error.message) || String(error),
      ...(error && error.code ? { code: error.code } : {}),
    });
  }
}

function handlePublishConfirmRequested(payload) {
  const flowId = typeof payload?.flow_id === "string" ? payload.flow_id : "";
  if (!flowId) return;
  const entry = state.marketplacePublishFlowResults.get(flowId);
  if (!entry || entry.status !== "in_progress") return;
  if (payload.auto_approve !== true) {
    // No auto-approve: leave the flow pending (deny timer settles it), the
    // same as a user never answering the modal.
    return;
  }
  if (payload.mode === "publish-agent") {
    // Agent publishes execute in the renderer in production (consolidated
    // modal pipeline); run the same pipeline through the vm bridge.
    void runRendererAgentPublish(payload);
    return;
  }
  // Skill publish / unpublish: the legacy "approved" decision executes the
  // write main-side, which is the complete implementation for these modes.
  completeFlowFromRenderer(flowId, "approved");
}

// ---------------------------------------------------------------------------
// Start the real API app on the harness port + admin surface
// ---------------------------------------------------------------------------
const apiApp = api.createApiServer();

apiApp.get("/__harness/state", (_req, res) => {
  res.json({
    viewerEmail: hostState.viewerEmail,
    autoApprove: autoApproveEnabled,
    broadcasts: hostState.broadcasts,
    projectRoot: PROJECT_ROOT_ENV,
    userData: USER_DATA,
  });
});
apiApp.post("/__harness/viewer", (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  if (!email) return res.status(400).json({ error: "email required" });
  hostState.viewerEmail = email;
  syncActiveMachine();
  res.json({ viewerEmail: hostState.viewerEmail });
});
apiApp.post("/__harness/clear-broadcasts", (_req, res) => {
  hostState.broadcasts.length = 0;
  res.json({ ok: true });
});

const requestedPort = Number(process.env.portico_HARNESS_PORT || 0);
const server = apiApp.listen(requestedPort, "127.0.0.1", () => {
  console.log(
    JSON.stringify({ ready: true, baseUrl: `http://127.0.0.1:${server.address().port}` }),
  );
});
