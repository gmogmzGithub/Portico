const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  extractChatIdFromOwuiUrl,
  extractDisplayedChatIdFromView,
  findOwuiViewForChatId,
  resolveModalTargetWindow,
  sendModalRequestToChatWindow,
} = require("./chat-modal-routing");

const repoRoot = path.resolve(__dirname, "..", "..", "..");

function createFakeWindow(id) {
  const windowRef = {
    id,
    sent: [],
    showCount: 0,
    focusCount: 0,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    show() {
      this.showCount += 1;
    },
    focus() {
      this.focusCount += 1;
    },
  };
  windowRef.webContents = {
    send(channel, payload) {
      windowRef.sent.push({ channel, payload });
    },
  };
  return windowRef;
}

function createBrowserWindowStub(windows) {
  const byId = new Map(windows.map((windowRef) => [windowRef.id, windowRef]));
  return {
    fromId(id) {
      return byId.get(id) || null;
    },
    getAllWindows() {
      return windows;
    },
  };
}

test("chat modal routing extracts chat ids from OWUI conversation URLs", () => {
  assert.equal(
    extractChatIdFromOwuiUrl("http://localhost:3789/c/chat-123"),
    "chat-123",
  );
  assert.equal(extractChatIdFromOwuiUrl("/c/chat-456"), "chat-456");
  assert.equal(
    extractChatIdFromOwuiUrl("http://localhost:3789/c/chat-789/"),
    "chat-789",
  );
  assert.equal(extractChatIdFromOwuiUrl("http://localhost:3789/"), null);
  assert.equal(extractChatIdFromOwuiUrl("about:blank"), null);
});

test("chat modal routing trusts only a view's committed chat URL", () => {
  const staleView = {
    currentUrl: "http://localhost:3789/c/chat-b",
    requestedUrl: "http://localhost:3789/c/chat-a",
  };
  const loadingView = {
    currentUrl: "",
    requestedUrl: "http://localhost:3789/c/chat-a",
  };
  const activeView = {
    currentUrl: "http://localhost:3789/c/chat-a",
    requestedUrl: "http://localhost:3789/c/chat-b",
  };

  assert.equal(extractDisplayedChatIdFromView(staleView), "chat-b");
  assert.equal(extractDisplayedChatIdFromView(loadingView), null);
  assert.equal(extractDisplayedChatIdFromView(activeView), "chat-a");
  assert.equal(findOwuiViewForChatId("chat-a", [staleView, loadingView]), null);
  assert.equal(findOwuiViewForChatId("chat-a", [staleView, activeView]), activeView);
});

test("chat modal resolver maps chat_id to the OWUI view owner window", () => {
  const mainWindow = createFakeWindow(1);
  const ownerWindow = createFakeWindow(2);
  const attachedWindow = createFakeWindow(3);
  const BrowserWindow = createBrowserWindowStub([
    mainWindow,
    ownerWindow,
    attachedWindow,
  ]);

  const result = resolveModalTargetWindow({
    chatId: "target-chat",
    BrowserWindow,
    mainWindow,
    owuiViews: {
      listViews() {
        return [
          {
            viewKey: "main",
            ownerWindowId: mainWindow.id,
            attachedWindowId: mainWindow.id,
            currentUrl: "http://localhost:3789/",
            requestedUrl: "",
          },
          {
            viewKey: "detached-chat:target-chat",
            ownerWindowId: ownerWindow.id,
            attachedWindowId: attachedWindow.id,
            currentUrl: "http://localhost:3789/c/target-chat",
            requestedUrl: "http://localhost:3789/c/target-chat",
          },
        ];
      },
    },
  });

  assert.equal(result.window, ownerWindow);
  assert.equal(result.reason, "chat-window");
  assert.equal(result.matchedView.viewKey, "detached-chat:target-chat");
});

test("chat modal resolver falls back to the main window when chat_id is missing or not open", () => {
  const mainWindow = createFakeWindow(1);
  const otherWindow = createFakeWindow(2);
  const BrowserWindow = createBrowserWindowStub([mainWindow, otherWindow]);

  for (const chatId of [null, "", "missing-chat"]) {
    const result = resolveModalTargetWindow({
      chatId,
      BrowserWindow,
      mainWindow,
      owuiViews: {
        listViews() {
          return [
            {
              viewKey: "detached-chat:other",
              ownerWindowId: otherWindow.id,
              attachedWindowId: otherWindow.id,
              currentUrl: "http://localhost:3789/c/other-chat",
              requestedUrl: "",
            },
          ];
        },
      },
    });
    assert.equal(result.window, mainWindow);
    assert.equal(result.reason, "fallback-main-window");
  }
});

test("backend modal request channels send only to the resolved chat window", () => {
  const mainWindow = createFakeWindow(1);
  const chatWindow = createFakeWindow(2);
  let bounceCount = 0;
  const BrowserWindow = createBrowserWindowStub([mainWindow, chatWindow]);
  const owuiViews = {
    listViews() {
      return [
        {
          viewKey: "main",
          ownerWindowId: mainWindow.id,
          attachedWindowId: mainWindow.id,
          currentUrl: "http://localhost:3789/",
          requestedUrl: "",
        },
        {
          viewKey: "detached-chat:chat-1",
          ownerWindowId: chatWindow.id,
          attachedWindowId: chatWindow.id,
          currentUrl: "http://localhost:3789/c/chat-1",
          requestedUrl: "",
        },
      ];
    },
  };

  for (const channel of [
    "oauth-flow-requested",
    "guided-setup-requested",
    "user-question-requested",
    "sensitive-info-requested",
    "chat-workspace-consent-requested",
  ]) {
    const result = sendModalRequestToChatWindow({
      channel,
      payload: { chat_id: "chat-1", channel },
      chatId: "chat-1",
      BrowserWindow,
      mainWindow,
      owuiViews,
      app: { dock: { bounce() { bounceCount += 1; } } },
      logger: { warn() {} },
    });

    assert.equal(result.sent, true);
    assert.equal(result.windowId, chatWindow.id);
    assert.equal(result.activatedWindow, false);
  }

  assert.deepEqual(
    chatWindow.sent.map((message) => message.channel),
    [
      "oauth-flow-requested",
      "guided-setup-requested",
      "user-question-requested",
      "sensitive-info-requested",
      "chat-workspace-consent-requested",
    ],
  );
  assert.equal(mainWindow.sent.length, 0);
  assert.equal(chatWindow.showCount, 0);
  assert.equal(chatWindow.focusCount, 0);
  assert.equal(mainWindow.showCount, 0);
  assert.equal(mainWindow.focusCount, 0);
  assert.equal(bounceCount, 0);
  assert.equal(chatWindow.sent[0].payload.__modalTarget.conversationId, null);
  assert.equal(chatWindow.sent[0].payload.__modalTarget.viewKey, "detached-chat:chat-1");
});

test("modal requests with no matched chat still activate the fallback window", () => {
  const mainWindow = createFakeWindow(1);
  const BrowserWindow = createBrowserWindowStub([mainWindow]);
  let bounceCount = 0;

  const result = sendModalRequestToChatWindow({
    channel: "oauth-flow-requested",
    payload: { chat_id: "missing-chat" },
    chatId: "missing-chat",
    BrowserWindow,
    mainWindow,
    owuiViews: { listViews: () => [] },
    app: { dock: { bounce() { bounceCount += 1; } } },
    logger: { warn() {} },
  });

  assert.equal(result.sent, true);
  assert.equal(result.reason, "fallback-main-window");
  assert.equal(result.activatedWindow, true);
  assert.equal(mainWindow.sent.length, 1);
  assert.equal(mainWindow.showCount, 1);
  assert.equal(mainWindow.focusCount, 1);
  assert.equal(bounceCount, process.platform === "darwin" ? 1 : 0);
});

test("native-input requests can use the fallback window without stealing focus", () => {
  const mainWindow = createFakeWindow(1);
  const BrowserWindow = createBrowserWindowStub([mainWindow]);
  let bounceCount = 0;

  for (const channel of [
    "user-question-requested",
    "sensitive-info-requested",
    "chat-workspace-consent-requested",
  ]) {
    const result = sendModalRequestToChatWindow({
      channel,
      payload: { chat_id: "unopened-chat" },
      chatId: "unopened-chat",
      BrowserWindow,
      mainWindow,
      owuiViews: { listViews: () => [] },
      app: { dock: { bounce() { bounceCount += 1; } } },
      activateFallback: false,
      logger: { warn() {} },
    });

    assert.equal(result.sent, true);
    assert.equal(result.reason, "fallback-main-window");
    assert.equal(result.activatedWindow, false);
  }

  assert.equal(mainWindow.sent.length, 3);
  assert.equal(mainWindow.showCount, 0);
  assert.equal(mainWindow.focusCount, 0);
  assert.equal(bounceCount, 0);
});

test("chat-keyed fallback refuses an unrelated window when the main shell is absent", () => {
  const detachedWindow = createFakeWindow(2);
  const BrowserWindow = createBrowserWindowStub([detachedWindow]);

  const result = sendModalRequestToChatWindow({
    channel: "user-question-requested",
    payload: { chat_id: "missing-chat" },
    chatId: "missing-chat",
    BrowserWindow,
    mainWindow: null,
    owuiViews: { listViews: () => [] },
    activateFallback: false,
    allowAlternateFallback: false,
    logger: { warn() {} },
  });

  assert.equal(result.sent, false);
  assert.equal(result.reason, "no-window");
  assert.equal(detachedWindow.sent.length, 0);
});

test("Electron API modal triggers accept chat_id and use chat-window routing", () => {
  const apiSource = fs.readFileSync(
    path.join(repoRoot, "electron-app", "src", "services", "api.js"),
    "utf8",
  );

  assert.match(apiSource, /require\("\.\/chat-modal-routing"\)/);
  assert.match(apiSource, /function sendBackendModalRequest\(channel,\s*payload = \{\},\s*options = \{\}\) \{[\s\S]*activateFallback:\s*options\.activateFallback !== false/s);
  assert.match(
    apiSource,
    /apiApp\.post\('\/api\/trigger-oauth-flow'[\s\S]*const chatId = normalizeOptionalChatId\(req\.body\?\.chat_id\);[\s\S]*broadcastOAuthFlowRequested\(\{[\s\S]*chat_id:\s*chatId,/s,
  );
  assert.match(
    apiSource,
    /apiApp\.post\('\/api\/trigger-guided-setup'[\s\S]*const chatId = normalizeOptionalChatId\(req\.body\?\.chat_id\);[\s\S]*sendBackendModalRequest\('guided-setup-requested',\s*\{[\s\S]*chat_id:\s*chatId,/s,
  );
  assert.match(
    apiSource,
    /apiApp\.post\('\/api\/trigger-sensitive-info-flow'[\s\S]*broadcastSensitiveInfoRequested\(\{[\s\S]*chat_id:\s*normalizedRequest\.chatId,/s,
  );
  assert.match(
    apiSource,
    /function broadcastUserQuestionRequested\(payload\)[\s\S]*activateFallback:\s*false,[\s\S]*allowAlternateFallback:\s*false/s,
  );
  assert.match(
    apiSource,
    /if \(!delivery\?\.sent\) \{[\s\S]*buildUserQuestionErrorResult[\s\S]*res\.status\(503\)/s,
  );
  assert.match(
    apiSource,
    /function broadcastSensitiveInfoRequested\(payload\)[\s\S]*activateFallback:\s*false/s,
  );
  assert.match(
    apiSource,
    /function broadcastChatWorkspaceConsentRequested\(payload\)[\s\S]*activateFallback:\s*false/s,
  );
});
