const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const source = fs.readFileSync(
  path.join(
    repoRoot,
    "electron-app",
    "src",
    "renderer",
    "components",
    "backend-modal-listeners.js",
  ),
  "utf8",
);

function createHarness({
  activeTab = "conversation-tab-b",
  withTabBar = true,
  holdSensitiveInfo = false,
  holdWorkspaceConsent = false,
  useSharedAttention = false,
  notificationContext = null,
  initialCommittedUrls = {},
} = {}) {
  const callbacks = {};
  const launched = [];
  const attentionEvents = [];
  const notifications = [];
  const notificationContextRequests = [];
  const eventListeners = {};
  const committedUrls = {
    "tab-a": initialCommittedUrls["tab-a"] ?? "http://localhost:3789/c/chat-a",
    "tab-b": initialCommittedUrls["tab-b"] ?? "http://localhost:3789/c/chat-b",
  };
  let completeHeldSensitiveInfo = null;
  const heldSensitiveInfo = holdSensitiveInfo
    ? new Promise((resolve) => {
        completeHeldSensitiveInfo = resolve;
      })
    : null;
  let completeHeldWorkspaceConsent = null;
  const heldWorkspaceConsent = holdWorkspaceConsent
    ? new Promise((resolve) => {
        completeHeldWorkspaceConsent = resolve;
      })
    : null;
  const oauthReconciliations = [];
  const elements = new Map([
    ["tab-strip", {}],
    [
      "conversation-webview-tab-a",
      {
        getCommittedURL: () => committedUrls["tab-a"],
        getURL: () => "http://localhost:3789/c/chat-a",
        getAttribute: () => "http://localhost:3789/c/chat-a",
      },
    ],
    [
      "conversation-webview-tab-b",
      {
        getCommittedURL: () => committedUrls["tab-b"],
        getURL: () => "http://localhost:3789/c/chat-b",
        getAttribute: () => "http://localhost:3789/c/chat-b",
      },
    ],
  ]);
  const window = {
    addEventListener: (name, callback) => {
      eventListeners[name] = callback;
    },
    appState: {
      activeTab,
      servers: [{ id: "server-g", name: "Server G", display_name: "Glean" }],
      toggles: {},
      tabOrder: ["chat", "tab-a", "tab-b"],
      conversationTabs: {
        "tab-a": { url: "http://localhost:3789/c/chat-a" },
        "tab-b": { url: "http://localhost:3789/c/chat-b" },
      },
      tabMeta: {
        chat: { title: "Chat", type: "permanent" },
        "tab-a": {
          title: "Tab A",
          type: "chat",
          url: "http://localhost:3789/c/chat-a",
        },
        "tab-b": {
          title: "Tab B",
          type: "chat",
          url: "http://localhost:3789/c/chat-b",
        },
      },
    },
    electronAPI: {
      onOAuthFlowRequested: (callback) => {
        callbacks.oauth = callback;
      },
      onOAuthFlowCompleted: (callback) => {
        callbacks.oauthCompleted = callback;
      },
      onUserQuestionRequested: (callback) => {
        callbacks.userQuestion = callback;
      },
      onSensitiveInfoRequested: (callback) => {
        callbacks.sensitiveInfo = callback;
      },
      onChatWorkspaceConsentRequested: (callback) => {
        callbacks.chatWorkspaceConsent = callback;
      },
      onGuidedSetupRequested: (callback) => {
        callbacks.guidedSetup = callback;
      },
      onNativeInputTerminal: (callback) => {
        callbacks.nativeInputTerminal = callback;
      },
      notifyChatStatus: async (payload) => {
        notifications.push(payload);
        return { shown: true };
      },
      ...(notificationContext
        ? {
            owui: {
              listViews: async () => [{ viewKey: "main" }],
              executeJavaScript: async (viewKey, script) => {
                notificationContextRequests.push({ viewKey, script });
                return { success: true, ...notificationContext };
              },
            },
          }
        : {}),
    },
    runOAuthFlowForServer: async (serverId, options) => {
      launched.push({ kind: "oauth", serverId, options });
    },
    runSensitiveInfoModal: async (payload) => {
      launched.push({ kind: "sensitive-info", payload });
      if (heldSensitiveInfo) {
        await heldSensitiveInfo;
      }
    },
    runChatWorkspaceConsentModal: async (payload) => {
      launched.push({ kind: "chat-workspace-consent", payload });
      if (heldWorkspaceConsent) {
        await heldWorkspaceConsent;
      }
    },
    openMcpConfigModal: async (serverId, _event, options) => {
      launched.push({ kind: "guided-setup", serverId, options });
    },
    McpOperationOverlayController: {
      async reconcileOAuthCompletion(serverId) {
        oauthReconciliations.push(serverId);
      },
    },
  };
  if (withTabBar) {
    window.tabBar = {
      setAttentionRequired: (tabId, required) => {
        attentionEvents.push({ tabId, required });
      },
    };
    if (useSharedAttention) {
      window.setChatTabAttentionRequired = (tabId, required, details) => {
        attentionEvents.push({ tabId, required, details });
      };
    }
  }

  const context = {
    window,
    document: {
      getElementById: (id) => elements.get(id) || null,
    },
    console,
    URL,
    Map,
    Promise,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  window.setupBackendModalListeners({ label: "Unit Test" });
  return {
    callbacks,
    launched,
    attentionEvents,
    notifications,
    notificationContextRequests,
    oauthReconciliations,
    eventListeners,
    committedUrls,
    elements,
    window,
    completeHeldSensitiveInfo,
    completeHeldWorkspaceConsent,
  };
}

async function flushPromises() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("backend blockers emit privacy-safe semantic notifications with exact chat context", async () => {
  const harness = createHarness({
    notificationContext: {
      chatTitle: "Persisted hiring plan",
      modelIdentity: {
        id: "recruiting-agent",
        baseModelId: "anthropic/claude-opus-4.8",
      },
    },
  });

  harness.callbacks.userQuestion({
    flow_id: "questions-1",
    chat_id: "chat-a",
    questions: [{ id: "q1" }, { id: "q2" }],
  });
  harness.callbacks.oauth({
    flow_id: "oauth-1",
    server_id: "server-g",
    chat_id: "chat-unopened",
    force_auth: true,
  });
  harness.callbacks.guidedSetup({
    flow_id: "config-1",
    server_id: "server-g",
    chat_id: "chat-unopened",
    reason: "credentials_invalid",
  });
  harness.callbacks.sensitiveInfo({
    flow_id: "sensitive-1",
    chat_id: "chat-unopened",
    prompt: "PRIVATE PROMPT",
    label: "PRIVATE LABEL",
    placeholder: "PRIVATE PLACEHOLDER",
  });
  harness.callbacks.chatWorkspaceConsent({
    flow_id: "workspace-1",
    chat_id: "chat-unopened",
    host_path: "/Users/private/secret-workspace",
    display_path: "~/secret-workspace",
  });
  await flushPromises();
  await flushPromises();

  assert.equal(harness.notifications.length, 5);
  const byType = new Map(harness.notifications.map((item) => [item.type, item]));
  assert.deepEqual(JSON.parse(JSON.stringify(byType.get("user-question"))), {
    type: "user-question",
    chatId: "chat-a",
    chatTitle: "Tab A",
    modelIdentity: {
      id: "recruiting-agent",
      baseModelId: "anthropic/claude-opus-4.8",
    },
    itemCount: 2,
    serverId: null,
    serverDisplayName: null,
    forceAuth: false,
    configurationReason: null,
    notificationKey: "user-question:questions-1",
  });
  assert.equal(byType.get("mcp-oauth").chatTitle, "Persisted hiring plan");
  assert.equal(byType.get("mcp-oauth").serverDisplayName, "Glean");
  assert.equal(byType.get("mcp-oauth").forceAuth, true);
  assert.equal(byType.get("mcp-configuration").configurationReason, "credentials_invalid");
  assert.equal(byType.get("sensitive-info").notificationKey, "sensitive-info:sensitive-1");
  assert.equal(byType.get("workspace-consent").notificationKey, "chat-workspace-consent:workspace-1");
  assert.doesNotMatch(
    JSON.stringify(harness.notifications),
    /PRIVATE|secret-workspace|prompt|label|placeholder|host_path|display_path/,
  );
  assert.ok(
    harness.notificationContextRequests.every(({ script }) =>
      script.includes('/api/v1/chats/${encodeURIComponent(CHAT_ID)}'),
    ),
  );
  assert.ok(
    harness.notificationContextRequests.every(({ script }) =>
      script.includes("history?.currentId"),
    ),
  );

  const resolvedContext = await vm.runInNewContext(
    harness.notificationContextRequests[0].script,
    {
      URL,
      Set,
      encodeURIComponent,
      window: {
        localStorage: {
          token: "unit-token",
          getItem: (key) => (key === "token" ? "unit-token" : null),
        },
        location: { origin: "http://localhost:3789" },
      },
      fetch: async (url) => {
        const parsed = new URL(url, "http://localhost:3789");
        if (parsed.pathname === "/api/v1/chats/chat-a") {
          return {
            ok: true,
            json: async () => ({
              title: "Persisted hiring plan",
              chat: {
                history: {
                  currentId: "active-user",
                  messages: {
                    "old-assistant": {
                      role: "assistant",
                      model: "gpt-5.6-terra",
                    },
                    "active-assistant": {
                      role: "assistant",
                      model: "recruiting-agent",
                      parentId: "old-assistant",
                    },
                    "active-user": {
                      role: "user",
                      parentId: "active-assistant",
                    },
                    "inactive-assistant": {
                      role: "assistant",
                      model: "gpt-5.6-luna",
                    },
                  },
                },
                models: ["gpt-5.6-terra"],
              },
            }),
          };
        }
        const modelId = parsed.searchParams.get("id");
        return {
          ok: true,
          json: async () =>
            modelId === "recruiting-agent"
              ? {
                  id: modelId,
                  name: "Recruiting Agent",
                  owned_by: "openai",
                  base_model_id: "anthropic/claude-opus-4.8",
                }
              : {
                  id: modelId,
                  name: "Claude Opus 4.8",
                  owned_by: "anthropic",
                },
        };
      },
    },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(resolvedContext)), {
    success: true,
    chatTitle: "Persisted hiring plan",
    modelIdentity: {
      id: "recruiting-agent",
      name: "Recruiting Agent",
      ownedBy: "openai",
      baseModelId: "anthropic/claude-opus-4.8",
      baseModelName: "Claude Opus 4.8",
      baseModelOwnedBy: "anthropic",
    },
  });
});

test("backend modal listener defers background chat modals until the matching tab is drained", async () => {
  const { callbacks, launched, attentionEvents, window } = createHarness();

  callbacks.userQuestion({
    flow_id: "flow-a",
    chat_id: "chat-a",
    questions: [{ id: "q1" }],
  });
  callbacks.userQuestion({
    flow_id: "flow-b",
    chat_id: "chat-a",
    questions: [{ id: "q2" }],
  });
  callbacks.oauth({
    server_id: "server-o",
    chat_id: "chat-a",
    force_auth: true,
  });
  callbacks.sensitiveInfo({
    flow_id: "sensitive-a",
    chat_id: "chat-a",
    prompt: "Need a key",
  });
  callbacks.chatWorkspaceConsent({
    flow_id: "workspace-a",
    chat_id: "chat-a",
    host_path: "/Users/dsantiago/Projects/example",
    display_path: "~/Projects/example",
  });
  callbacks.oauth({
    server_id: "server-o2",
    chat_id: "chat-a",
    force_auth: true,
  });
  callbacks.guidedSetup({
    server_id: "server-g",
    chat_id: "chat-a",
    flow_id: "guided-a",
  });
  callbacks.guidedSetup({
    server_id: "server-g2",
    chat_id: "chat-a",
    flow_id: "guided-b",
  });
  await flushPromises();

  assert.deepEqual(launched, []);
  assert.equal(window.backendModalAttention.getPendingCountForTab("tab-a"), 6);
  assert.ok(
    attentionEvents.some(
      (event) => event.tabId === "tab-a" && event.required === true,
    ),
  );

  window.appState.activeTab = "conversation-tab-a";
  assert.equal(window.backendModalAttention.drainForTab("tab-a"), true);
  await flushPromises();

  assert.deepEqual(
    launched.map((entry) => entry.kind),
    [
      "oauth",
      "sensitive-info",
      "chat-workspace-consent",
      "oauth",
      "guided-setup",
      "guided-setup",
    ],
  );
  assert.equal(window.backendModalAttention.getPendingCountForTab("tab-a"), 0);
  assert.deepEqual(attentionEvents.at(-1), {
    tabId: "tab-a",
    required: false,
  });
});

test("inline user questions do not block active-tab native modals", async () => {
  const activeHarness = createHarness({
    activeTab: "conversation-tab-a",
  });
  activeHarness.callbacks.userQuestion({
    flow_id: "flow-active",
    chat_id: "chat-a",
    questions: [{ id: "q1" }],
  });
  await flushPromises();
  assert.deepEqual(
    activeHarness.launched.map((entry) => entry.kind),
    [],
  );

  activeHarness.callbacks.sensitiveInfo({
    flow_id: "sensitive-active",
    chat_id: "chat-a",
    prompt: "Need a key",
  });
  await flushPromises();
  assert.deepEqual(
    activeHarness.launched.map((entry) => entry.kind),
    ["sensitive-info"],
    "an inline question must not occupy the native modal queue",
  );
  assert.deepEqual(activeHarness.attentionEvents.at(-1), {
    tabId: "tab-a",
    required: false,
  });

  const detachedHarness = createHarness({ withTabBar: false });
  detachedHarness.callbacks.oauth({
    server_id: "server-o",
    chat_id: "chat-a",
  });
  await flushPromises();
  assert.deepEqual(
    detachedHarness.launched.map((entry) => entry.kind),
    ["oauth"],
  );
});

test("successful backend OAuth completion reconciles the MCP operation modal", async () => {
  const harness = createHarness();

  harness.callbacks.oauthCompleted({
    server_id: "assumeapi-smart",
    success: true,
  });
  await flushPromises();

  assert.deepEqual(harness.oauthReconciliations, ["assumeapi-smart"]);

  harness.callbacks.oauthCompleted({
    server_id: "other-server",
    success: false,
    reason: "failed",
  });
  await flushPromises();

  assert.deepEqual(harness.oauthReconciliations, ["assumeapi-smart"]);
});

for (const scenario of [
  {
    name: "sensitive information",
    callback: "sensitiveInfo",
    kind: "sensitive-info",
    nativeKind: "sensitive_info",
    flowId: "sensitive-background",
    holdOption: "holdSensitiveInfo",
    completeKey: "completeHeldSensitiveInfo",
    payload: {
      prompt: "PRIVATE PROMPT",
      preamble: "PRIVATE PREAMBLE",
      label: "Secret label",
    },
  },
  {
    name: "workspace consent",
    callback: "chatWorkspaceConsent",
    kind: "chat-workspace-consent",
    nativeKind: "chat_workspace_consent",
    flowId: "workspace-background",
    holdOption: "holdWorkspaceConsent",
    completeKey: "completeHeldWorkspaceConsent",
    payload: {
      host_path: "/Users/private/.snowflake",
      display_path: "~/.snowflake",
      preamble: "PRIVATE WORKSPACE PREAMBLE",
    },
  },
]) {
  test(`background ${scenario.name} keeps tab attention through its terminal lifecycle`, async () => {
    const harness = createHarness({
      activeTab: "conversation-tab-b",
      useSharedAttention: true,
      [scenario.holdOption]: true,
    });

    harness.callbacks[scenario.callback]({
      flow_id: scenario.flowId,
      chat_id: "chat-a",
      ...scenario.payload,
    });
    await flushPromises();

    assert.deepEqual(harness.launched, []);
    assert.equal(harness.window.backendModalAttention.getPendingCountForTab("tab-a"), 1);
    const initialAttention = harness.attentionEvents.at(-1);
    assert.equal(initialAttention.tabId, "tab-a");
    assert.equal(initialAttention.required, true);
    assert.equal(initialAttention.details.kind, scenario.kind);
    assert.equal(initialAttention.details.chatId, "chat-a");
    assert.equal(
      initialAttention.details.notificationKey,
      `${scenario.kind}:${scenario.flowId}`,
    );
    assert.doesNotMatch(
      JSON.stringify(harness.attentionEvents),
      /PRIVATE|snowflake|prompt|preamble|host_path|display_path|label/,
    );

    harness.window.appState.activeTab = "conversation-tab-a";
    assert.equal(harness.window.backendModalAttention.drainForTab("tab-a"), true);
    await flushPromises();
    assert.deepEqual(harness.launched.map((entry) => entry.kind), [scenario.kind]);
    assert.equal(harness.attentionEvents.at(-1).required, true);

    harness.window.appState.activeTab = "conversation-tab-b";
    harness.callbacks.nativeInputTerminal({
      kind: scenario.nativeKind,
      flow_id: scenario.flowId,
      status: "dismissed",
    });
    assert.equal(harness.attentionEvents.at(-1).required, false);

    harness[scenario.completeKey]();
    await flushPromises();
    assert.equal(harness.attentionEvents.at(-1).required, false);
  });
}

test("no-tab native input stays chat-keyed until OWUI navigation claims it", async () => {
  const harness = createHarness({
    activeTab: "conversation-tab-b",
    holdSensitiveInfo: true,
    useSharedAttention: true,
  });

  harness.callbacks.sensitiveInfo({
    flow_id: "sensitive-unopened",
    chat_id: "chat-unopened",
    prompt: "PRIVATE PROMPT",
    preamble: "PRIVATE PREAMBLE",
  });
  await flushPromises();

  assert.deepEqual(harness.launched, []);
  assert.equal(harness.window.backendModalAttention.getPendingCountForChat("chat-unopened"), 1);
  assert.equal(harness.attentionEvents.length, 0, "no top tab is created or marked");

  harness.window.appState.activeTab = "conversation-tab-a";
  harness.window.appState.tabMeta["tab-a"].currentChatId = "chat-unopened";
  harness.committedUrls["tab-a"] = "http://localhost:3789/c/chat-unopened";
  assert.equal(
    harness.window.backendModalAttention.claimForChat("chat-unopened", "tab-a"),
    true,
  );
  await flushPromises();

  assert.equal(harness.window.backendModalAttention.getPendingCountForChat("chat-unopened"), 0);
  assert.deepEqual(harness.launched.map((entry) => entry.kind), ["sensitive-info"]);
  const claimedAttention = harness.attentionEvents.at(-1);
  assert.equal(claimedAttention.tabId, "tab-a");
  assert.equal(claimedAttention.required, true);
  assert.equal(claimedAttention.details.kind, null);
  assert.equal(claimedAttention.details.chatId, null);
  assert.equal(claimedAttention.details.notificationKey, "");

  harness.callbacks.nativeInputTerminal({
    kind: "sensitive_info",
    flow_id: "sensitive-unopened",
    status: "dismissed",
  });
  harness.completeHeldSensitiveInfo();
  await flushPromises();
  assert.equal(harness.attentionEvents.at(-1).required, false);
});

test("no-tab workspace consent is claimed by the active chat without replacing a tab", async () => {
  const harness = createHarness({
    activeTab: "conversation-tab-b",
    holdWorkspaceConsent: true,
    useSharedAttention: true,
  });
  harness.callbacks.chatWorkspaceConsent({
    flow_id: "workspace-unopened",
    chat_id: "chat-unopened",
    host_path: "/Users/private/.snowflake",
    display_path: "~/.snowflake",
    preamble: "PRIVATE WORKSPACE PREAMBLE",
  });
  await flushPromises();

  assert.equal(harness.window.backendModalAttention.getPendingCountForChat("chat-unopened"), 1);
  assert.deepEqual(harness.launched, []);
  assert.equal(harness.attentionEvents.length, 0);

  harness.window.appState.activeTab = "conversation-tab-a";
  harness.window.appState.tabMeta["tab-a"].currentChatId = "chat-unopened";
  harness.committedUrls["tab-a"] = "http://localhost:3789/c/chat-unopened";
  assert.equal(
    harness.window.backendModalAttention.claimForChat("chat-unopened", "tab-a"),
    true,
  );
  await flushPromises();
  assert.deepEqual(harness.launched.map((entry) => entry.kind), [
    "chat-workspace-consent",
  ]);

  harness.callbacks.nativeInputTerminal({
    kind: "chat_workspace_consent",
    flow_id: "workspace-unopened",
    status: "dismissed",
  });
  harness.completeHeldWorkspaceConsent();
  await flushPromises();
  assert.equal(harness.attentionEvents.at(-1).required, false);
});

test("terminal cleanup removes only the matching unopened-chat flow", async () => {
  const harness = createHarness({ useSharedAttention: true });
  harness.callbacks.sensitiveInfo({
    flow_id: "sensitive-queued",
    chat_id: "chat-unopened",
    prompt: "PRIVATE PROMPT",
  });
  harness.callbacks.chatWorkspaceConsent({
    flow_id: "workspace-queued",
    chat_id: "chat-unopened",
    host_path: "/Users/private/.snowflake",
  });
  await flushPromises();

  assert.equal(harness.window.backendModalAttention.getPendingCountForChat("chat-unopened"), 2);
  assert.equal(
    harness.window.backendModalAttention.handleNativeInputTerminal({
      kind: "sensitive_info",
      flow_id: "sensitive-queued",
      status: "timed_out",
    }),
    true,
  );
  assert.equal(harness.window.backendModalAttention.getPendingCountForChat("chat-unopened"), 1);
  harness.window.backendModalAttention.handleNativeInputTerminal({
    kind: "chat_workspace_consent",
    flow_id: "workspace-queued",
    status: "dismissed",
  });
  assert.equal(harness.window.backendModalAttention.getPendingCountForChat("chat-unopened"), 0);

  harness.window.appState.activeTab = "conversation-tab-a";
  harness.window.appState.tabMeta["tab-a"].currentChatId = "chat-unopened";
  assert.equal(
    harness.window.backendModalAttention.claimForChat("chat-unopened", "tab-a"),
    false,
  );
  assert.deepEqual(harness.launched, []);
});
