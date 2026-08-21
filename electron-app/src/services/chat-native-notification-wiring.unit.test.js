"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const read = (...parts) => fs.readFileSync(path.join(repoRoot, ...parts), "utf8");

test("chat completion transitions use native notifications and preserve click-through routing", () => {
  const ipc = read("electron-app", "src", "services", "ipc.js");
  const views = read("electron-app", "src", "services", "owui-views.js");
  const preload = read("electron-app", "src", "services", "preload.js");

  assert.match(
    views,
    /chatRuntimeTransitionListener\(\{[\s\S]*previousState,[\s\S]*nextState,[\s\S]*payload/,
  );
  assert.match(
    ipc,
    /previousState\?\.busy === true && nextState\?\.busy !== true[\s\S]*type: "completed"[\s\S]*chatTitle:[\s\S]*modelIdentity:/,
  );
  assert.match(
    ipc,
    /createChatNativeNotificationService\(\{[\s\S]*app,[\s\S]*activateChatConversation\(\{ chatId, title \}\)[\s\S]*resolveMcpServerDisplayName[\s\S]*isChatActive/,
  );
  assert.match(
    ipc,
    /function isChatActiveInFocusedWindow\(chatId\)[\s\S]*getOpenConversationTabs\(\)[\s\S]*getActiveViewKeyForWindow\(ownerWindow\.id\)[\s\S]*ownerWindow\?\.isFocused\(\)[\s\S]*tab\.visible !== false \|\| activeViewKey === tab\.viewKey/,
  );
  // A later activity report carries the real chat title, which fires any
  // completion notification deferred at busy→idle (new chats start "New Chat").
  assert.match(
    ipc,
    /owui-tab-activity[\s\S]*resolveTitle\(payload\.chatId, payload\.title\)/,
  );
  assert.match(
    preload,
    /notifyChatStatus: \(payload\) =>[\s\S]*ipcRenderer\.invoke\('show-chat-native-notification', payload\)/,
  );
});

test("backend blockers emit semantic notifications independently of tab attention", () => {
  const chatTab = read(
    "electron-app",
    "src",
    "renderer",
    "components",
    "chat-tab.js",
  );
  const modalListeners = read(
    "electron-app",
    "src",
    "renderer",
    "components",
    "backend-modal-listeners.js",
  );

  assert.match(modalListeners, /async function notifyBackendModalAttention/);
  // Each kind declares its semantic notification type on its own registry
  // record ([^}]*? keeps the match inside one object literal, so a kind can't
  // borrow a neighbour's type), and the wiring loop notifies every record that
  // declares one.
  for (const [kind, type] of [
    ["oauth", "mcp-oauth"],
    ["guided-setup", "mcp-configuration"],
    ["user-question", "user-question"],
    ["sensitive-info", "sensitive-info"],
    ["chat-workspace-consent", "workspace-consent"],
  ]) {
    assert.match(
      modalListeners,
      new RegExp(`kind: "${kind}",[^}]*?notificationType: "${type}",`),
    );
  }
  assert.match(
    modalListeners,
    /for \(const spec of BACKEND_MODAL_KINDS\)[\s\S]*?notifyBackendModalAttention\(spec\.kind, payload\)/,
  );
  assert.match(
    modalListeners,
    /resolveBackendNotificationContext[\s\S]*chatTitle:[\s\S]*modelIdentity:/,
  );
  assert.match(modalListeners, /itemCount:[\s\S]*payload\.questions\.length/);
  assert.match(modalListeners, /serverDisplayName,[\s\S]*forceAuth:[\s\S]*configurationReason:/);

  const attentionFunction = chatTab.match(
    /function setTabAttentionRequiredState\([\s\S]*?\n}\n/,
  )?.[0];
  assert.ok(attentionFunction, "generic attention state function should exist");
  assert.doesNotMatch(attentionFunction, /notifyChatStatus|notifyNativeChatStatus/);
});

test("OWUI blockers use the safe notification bridge and model-aware batching", () => {
  const chat = read(
    "src",
    "patches",
    "frontend",
    "src",
    "lib",
    "components",
    "chat",
    "Chat.svelte",
  );
  const webviewPreload = read(
    "electron-app",
    "src",
    "services",
    "chat-webview-preload.js",
  );

  assert.match(webviewPreload, /function notifyChatStatus\(payload = \{\}\)/);
  assert.match(
    webviewPreload,
    /ipcRenderer\.invoke\('show-chat-native-notification',[\s\S]*type:[\s\S]*chatId:[\s\S]*chatTitle:[\s\S]*notificationKey:[\s\S]*itemCount:[\s\S]*modelIdentity:/,
  );
  assert.doesNotMatch(
    webviewPreload.match(/function notifyChatStatus\([\s\S]*?\n}\n/)?.[0] || "",
    /prompt|workspacePath|toolArgs|secret|placeholder/,
  );

  assert.match(chat, /schedulePendingChipNotifications/);
  assert.match(chat, /setTimeout\([\s\S]*}, 150\)/);
  assert.match(chat, /\['tool_confirmation', 'clarification'\]/);
  assert.match(chat, /pending\.length/);
  assert.match(chat, /stableNotificationDigest\(signature\)/);
  assert.match(chat, /notifyNativeChatStatus\('confirmation'/);
  assert.match(chat, /notifyNativeChatStatus\('input'/);
  assert.match(chat, /getChatNotificationModelIdentity/);
});

test("foreground and background completion carry the latest active-branch model", () => {
  const chat = read(
    "src",
    "patches",
    "frontend",
    "src",
    "lib",
    "components",
    "chat",
    "Chat.svelte",
  );
  const runtime = read(
    "src",
    "patches",
    "frontend",
    "src",
    "lib",
    "stores",
    "chatRuntimeState.ts",
  );
  const modelResolver = read(
    "src",
    "patches",
    "frontend",
    "src",
    "lib",
    "utils",
    "chatNotificationModel.ts",
  );

  assert.match(chat, /reportTabActivity[\s\S]*modelIdentity/);
  assert.match(runtime, /getChatById\(token, chatId\)[\s\S]*resolveChatNotificationModelIdentity[\s\S]*reconcileChatRuntime\(\{[\s\S]*modelIdentity/);
  assert.match(modelResolver, /resolveSidebarChatModelId\(chatRow\)/);
  assert.match(modelResolver, /base_model_id/);
});

test("Electron suppresses only the legacy chat completion toast", () => {
  const appCss = read("src", "patches", "frontend", "src", "app.css");
  const toast = read(
    "src",
    "patches",
    "frontend",
    "src",
    "lib",
    "components",
    "NotificationToast.svelte",
  );
  const webviewPreload = read(
    "electron-app",
    "src",
    "services",
    "chat-webview-preload.js",
  );

  assert.match(toast, /portico-chat-completion-toast/);
  assert.match(appCss, /html\.portico-electron-shell[\s\S]*portico-chat-completion-toast/);
  assert.match(
    webviewPreload,
    /document\.documentElement\?\.classList\.add\('portico-electron-shell'\)/,
  );
});

test("non-interactive scheduled runs remain in-app only", () => {
  const sidebar = read(
    "src",
    "patches",
    "frontend",
    "src",
    "lib",
    "components",
    "layout",
    "Sidebar.svelte",
  );
  const scheduledNotificationFunction = sidebar.match(
    /const notifyScheduledTaskRun =[\s\S]*?\n\t};/,
  )?.[0];
  assert.ok(scheduledNotificationFunction);
  assert.match(scheduledNotificationFunction, /toast\.(?:warning|success)/);
  assert.doesNotMatch(scheduledNotificationFunction, /new Notification/);
});
