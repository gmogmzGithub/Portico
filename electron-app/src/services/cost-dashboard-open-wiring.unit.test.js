"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..", "..");
const read = (...parts) => fs.readFileSync(path.join(repoRoot, ...parts), "utf8");

test("cost dashboard bar click opens tab-first and focuses an existing window (no double-open)", () => {
  const costDashboard = read("src", "renderer", "components", "cost-dashboard.js");
  const handler =
    costDashboard.match(/if \(isChatPivot\) \{[\s\S]*?\n {6}\}/)?.[0] || "";
  assert.ok(handler, "chat-pivot click handler should exist");

  // Focuses an existing detached window before opening anything.
  assert.match(handler, /focusConversationWindowIfOpen\?\.\(chatId\)/);
  // Opens tab-first when a slot is free / the tab already exists.
  assert.match(handler, /canOpenAdditionalConversationTab/);
  assert.match(handler, /window\.openConversationTab\(url, chatId/);
  // Falls back to a new window only after the tab-first branch.
  assert.match(handler, /detachConversation\?\.\(chatId, url/);
  // Must NOT unconditionally open a window (the old bug).
  assert.doesNotMatch(
    handler,
    /const chatId = bar\.dataset\.chatId;\s*if \(chatId && window\.electronAPI\?\.detachConversation\)/,
  );
});

test("window focus-if-open is plumbed through windows.js, ipc.js, and preload.js", () => {
  const windowsJs = read("src", "services", "windows.js");
  const ipc = read("src", "services", "ipc.js");
  const preload = read("src", "services", "preload.js");
  const chatTab = read("src", "renderer", "components", "chat-tab.js");

  assert.match(windowsJs, /function focusConversationWindowIfOpen\(conversationId\)/);
  assert.match(
    windowsJs,
    /module\.exports = \{[\s\S]*focusConversationWindowIfOpen,/,
  );
  assert.match(
    ipc,
    /ipcMain\.handle\(\s*"conversation-window-focus-if-open",[\s\S]*focusConversationWindowIfOpen\(conversationId\)/,
  );
  assert.match(preload, /focusConversationWindowIfOpen: \(conversationId\) =>/);
  assert.match(
    chatTab,
    /window\.canOpenAdditionalConversationTab = canOpenAdditionalConversationTab;/,
  );
});
