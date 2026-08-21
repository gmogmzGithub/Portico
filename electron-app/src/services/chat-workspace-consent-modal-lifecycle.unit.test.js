// PORTICO-348: the workspace-permission grant stays a NATIVE modal (consent UI must
// not be spoofable by page content) but is now scoped per chat. Previously a
// single chatWorkspaceConsentState + chatWorkspaceConsentFlowInProgress meant a
// second chat's request was rejected outright and the window stayed
// interaction-suppressed while any request was open.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const source = fs.readFileSync(
  path.join(repoRoot, "electron-app", "src", "renderer", "components", "chat-workspace-consent-modal.js"),
  "utf8",
);

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...n) { n.forEach((v) => this.values.add(v)); }
  remove(...n) { n.forEach((v) => this.values.delete(v)); }
  toggle(n, f) { const on = f === undefined ? !this.values.has(n) : Boolean(f); on ? this.values.add(n) : this.values.delete(n); return on; }
  contains(n) { return this.values.has(n); }
}
class FakeElement {
  constructor(id = "") {
    this.id = id; this.classList = new FakeClassList(); this.dataset = {};
    this.hidden = false; this.disabled = false; this.innerHTML = ""; this.textContent = "";
    this.value = ""; this.style = {}; this.focused = false; this.children = [];
  }
  addEventListener() {}
  removeEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  appendChild() {}
  replaceChildren() {}
  setAttribute(n, v) { this[n] = v; }
  removeAttribute(n) { delete this[n]; }
  getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }; }
  focus() { this.focused = true; }
  remove() {}
}

const elementIds = [
  "chat-workspace-consent-container", "chat-workspace-consent-modal",
  "chat-workspace-consent-title-logo-badge", "chat-workspace-consent-title-logo",
  "chat-workspace-consent-title-logo-fallback", "chat-workspace-consent-preamble",
  "chat-workspace-consent-path", "chat-workspace-consent-error",
  "chat-workspace-consent-open-btn", "chat-workspace-consent-approve-btn",
  "chat-workspace-consent-cancel-btn", "chat-workspace-consent-hide-btn",
  "chat-workspace-consent-close-btn",
];

function createHarness({ committedUrl = "http://localhost:3789/c/chat-a" } = {}) {
  const presentationCalls = [];
  const suppressionCalls = [];
  const callbacks = {};
  const elements = new Map(elementIds.map((id) => [id, new FakeElement(id)]));
  elements.set("tab-strip", new FakeElement("tab-strip"));
  let currentCommittedUrl = committedUrl;
  const owner = new FakeElement("chat-webview");
  owner.getCommittedURL = () => currentCommittedUrl;
  elements.set("chat-webview", owner);

  const window = {
    appState: { activeTab: "chat", conversationTabs: {}, tabMeta: {} },
    addEventListener() {},
    setOwuiInteractionSuppressed(_source, suppressed) { suppressionCalls.push(Boolean(suppressed)); },
    setNativeOverlayInteractionSuppressed() {},
    electronAPI: {
      setNativeInputPresentation: async (payload) => { presentationCalls.push(payload); return { success: true }; },
      notifyChatWorkspaceConsentCompleted: () => {},
      onNativeInputReopenRequested: (cb) => { callbacks.reopen = cb; },
      onNativeInputTerminal: (cb) => { callbacks.terminal = cb; },
    },
  };
  const document = {
    body: new FakeElement("body"),
    documentElement: { lang: "en" },
    getElementById: (id) => elements.get(id) || null,
    createElement: (tag) => new FakeElement(tag),
    dispatchEvent() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const context = {
    window, document, navigator: { language: "en" }, console, URL,
    Event: class { constructor(t) { this.type = t; } },
    setTimeout, clearTimeout, fetch: async () => ({ text: async () => "" }),
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  vm.runInContext("chatWorkspaceConsentTemplateLoaded = true", context);

  return {
    context, elements, callbacks, presentationCalls, suppressionCalls,
    isSuppressed: () => suppressionCalls.at(-1) === true,
    setCommittedUrl(v) { currentCommittedUrl = v; },
    async switchToChat(chatId) {
      currentCommittedUrl = `http://localhost:3789/c/${chatId}`;
      await context.window.syncChatWorkspaceConsentModalForNavigation();
      await flush();
    },
  };
}

function payload(overrides = {}) {
  return {
    flow_id: "flow-a", chat_id: "chat-a", host_path: "/Users/me/projects/alpha",
    __modalTarget: { viewKey: "main", conversationId: "chat", windowType: "main" },
    ...overrides,
  };
}

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

function start(harness, chatId, flowId) {
  const promise = harness.context.window.runChatWorkspaceConsentModal(
    payload({ flow_id: flowId, chat_id: chatId, host_path: `/work/${chatId}` }),
  );
  let rejection = null;
  void Promise.resolve(promise).catch((e) => { rejection = e; });
  return { promise, rejectionOf: () => rejection };
}

test("a second chat's consent request is accepted while another is pending", async () => {
  const harness = createHarness();
  const a = start(harness, "chat-a", "flow-a");
  await flush();
  const b = start(harness, "chat-b", "flow-b");
  await flush();
  assert.equal(a.rejectionOf(), null);
  assert.equal(b.rejectionOf(), null, "a request in another chat must not reject this one");
});

test("each chat presents its own consent request when activated", async () => {
  const harness = createHarness();
  const modal = harness.elements.get("chat-workspace-consent-modal");
  const pathEl = harness.elements.get("chat-workspace-consent-path");
  start(harness, "chat-a", "flow-a");
  await flush();
  start(harness, "chat-b", "flow-b");
  await flush();

  assert.equal(modal.classList.contains("visible"), true);
  assert.match(pathEl.textContent, /chat-a/);

  await harness.switchToChat("chat-b");
  assert.equal(modal.classList.contains("visible"), true);
  assert.match(pathEl.textContent, /chat-b/, "activating chat-b must show chat-b's request");

  await harness.switchToChat("chat-a");
  assert.match(pathEl.textContent, /chat-a/);
});

test("a consent request pending in another chat does not block the active chat", async () => {
  const harness = createHarness({ committedUrl: "http://localhost:3789/c/chat-a" });
  const modal = harness.elements.get("chat-workspace-consent-modal");
  start(harness, "chat-b", "flow-b");
  await flush();
  assert.equal(modal.classList.contains("visible"), false);
  assert.equal(harness.isSuppressed(), false, "chat-a must stay usable");

  await harness.switchToChat("chat-b");
  assert.equal(modal.classList.contains("visible"), true);
  assert.equal(harness.isSuppressed(), true);

  await harness.switchToChat("chat-a");
  assert.equal(modal.classList.contains("visible"), false);
  assert.equal(harness.isSuppressed(), false, "leaving must release the window");
});

test("Hide keeps the consent request pending and releases the window", async () => {
  const harness = createHarness();
  const a = start(harness, "chat-a", "flow-a");
  await flush();

  let settled = false;
  void a.promise.then(() => { settled = true; });
  await harness.context.window.hideChatWorkspaceConsentModal();
  await flush();

  assert.equal(
    harness.elements.get("chat-workspace-consent-modal").classList.contains("visible"),
    false,
  );
  assert.equal(settled, false, "Hide must not settle the request");
  assert.equal(harness.isSuppressed(), false, "Hide must release the window");
  assert.equal(harness.presentationCalls.at(-1).presentation, "hidden");
});

test("a background chat's terminal settles only that flow", async () => {
  const harness = createHarness();
  const modal = harness.elements.get("chat-workspace-consent-modal");
  const a = start(harness, "chat-a", "flow-a");
  await flush();
  const b = start(harness, "chat-b", "flow-b");
  await flush();

  harness.callbacks.terminal({ kind: "chat_workspace_consent", flow_id: "flow-b", status: "timed_out" });
  await flush();
  assert.equal((await b.promise).status, "timed_out");

  assert.equal(modal.classList.contains("visible"), true, "the visible prompt must survive");
  let aSettled = false;
  void a.promise.then(() => { aSettled = true; });
  await flush();
  assert.equal(aSettled, false);
});
