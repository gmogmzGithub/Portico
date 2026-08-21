"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  buildNotificationSubtitle,
  createChatNativeNotificationService,
  normalizeChatNotification,
  resolveModelIconKey,
} = require("./chat-native-notifications");

class FakeNotification {
  static supported = true;
  static instances = [];
  static rejectIcons = false;

  static isSupported() {
    return FakeNotification.supported;
  }

  constructor(options) {
    if (FakeNotification.rejectIcons && options.icon) {
      throw new Error("icon could not be loaded");
    }
    this.options = options;
    this.listeners = new Map();
    this.shown = false;
    FakeNotification.instances.push(this);
  }

  on(name, callback) {
    this.listeners.set(name, callback);
  }

  once(name, callback) {
    this.listeners.set(name, callback);
  }

  show() {
    this.shown = true;
  }

  emit(name, ...args) {
    this.listeners.get(name)?.(...args);
  }
}

test.beforeEach(() => {
  FakeNotification.supported = true;
  FakeNotification.instances.length = 0;
  FakeNotification.rejectIcons = false;
});

test("normalizes chat titles and compatibility aliases", () => {
  assert.deepEqual(
    normalizeChatNotification({
      type: "completed",
      chatId: " chat-1 ",
      chatTitle: " Weekly update ",
    }),
    {
      type: "completed",
      chatId: "chat-1",
      chatTitle: "Weekly update",
      notificationKey: "",
      itemCount: 1,
      serverId: "",
      serverDisplayName: "",
      forceAuth: false,
      configurationReason: "",
      modelIdentity: null,
      subtitle: "Work has completed.",
    },
  );
  assert.equal(
    normalizeChatNotification({ type: "question", chatId: "chat-2" }).type,
    "user-question",
  );
  assert.equal(
    normalizeChatNotification({ type: "question", chatId: "chat-2" }).chatTitle,
    "New Chat",
  );
  assert.equal(normalizeChatNotification({ type: "other", chatId: "chat-4" }), null);
  assert.equal(normalizeChatNotification({ type: "completed" }), null);
  assert.equal(
    normalizeChatNotification({
      type: "attention",
      chatId: "chat-5\n",
      chatTitle: "Unsafe\n\t title",
      modelIdentity: { id: "gpt-5.5\u0000" },
    }).chatTitle,
    "Unsafe title",
  );
});

test("renders fixed, privacy-safe subtitles for every notification type", () => {
  const subtitle = (type, extra = {}) =>
    buildNotificationSubtitle({ type, itemCount: 1, ...extra });

  assert.equal(subtitle("completed"), "Work has completed.");
  assert.equal(subtitle("user-question"), "Please answer 1 question.");
  assert.equal(
    subtitle("user-question", { itemCount: 3 }),
    "Please answer 3 questions.",
  );
  assert.equal(
    subtitle("mcp-oauth", { serverDisplayName: "Glean" }),
    "Please authorize the Glean integration.",
  );
  assert.equal(
    subtitle("mcp-oauth", { serverDisplayName: "Glean", forceAuth: true }),
    "Please reauthorize the Glean integration.",
  );
  assert.equal(
    subtitle("mcp-configuration", { serverDisplayName: "GitLab" }),
    "Please configure the GitLab integration.",
  );
  assert.equal(
    subtitle("mcp-configuration", {
      serverDisplayName: "GitLab",
      configurationReason: "credentials_invalid",
    }),
    "Please reconfigure the GitLab integration.",
  );
  assert.equal(
    subtitle("sensitive-info", { prompt: "secret value" }),
    "Please provide the requested sensitive information.",
  );
  assert.equal(
    subtitle("workspace-consent", { displayPath: "/private/work" }),
    "Please approve the requested chat workspace.",
  );
  assert.equal(subtitle("tool-confirmation"), "Please review 1 tool action.");
  assert.equal(
    subtitle("tool-confirmation", { itemCount: 4 }),
    "Please review 4 tool actions.",
  );
  assert.equal(subtitle("clarification"), "Please choose how to continue.");
  assert.equal(
    subtitle("clarification", { itemCount: 2 }),
    "Please respond to 2 clarifications.",
  );
  assert.equal(subtitle("confirmation"), "Please confirm to continue.");
  assert.equal(
    subtitle("input", { message: "untrusted request contents" }),
    "Please provide the requested information.",
  );
  assert.equal(subtitle("attention"), "Your attention is required.");
});

test("maps latest and underlying model identities to allowlisted icon keys", () => {
  const cases = [
    [{ id: "anthropic/claude-opus-4.8" }, "claude"],
    [{ id: "vertex_ai/gemini-3.5-pro" }, "gemini"],
    [{ id: "openai/responses/gpt-5.5" }, "gpt"],
    [{ id: "openai/responses/gpt-5.6-sol:latest" }, "sol"],
    [{ id: "GPT-5.6-Sol-Pro" }, "sol"],
    [{ id: "gpt-5.6-terra" }, "terra"],
    [{ id: "gpt_5.6_luna" }, "luna"],
    [
      {
        id: "custom-agent",
        name: "Recruiting agent",
        baseModelId: "anthropic/claude-sonnet-4.7",
      },
      "claude",
    ],
    [
      {
        id: "custom-agent",
        baseModelId: "opaque-base",
        baseModelOwnedBy: "google",
      },
      "gemini",
    ],
    [
      {
        id: "custom-agent",
        name: "GPT recruiting assistant",
        ownedBy: "openai",
        baseModelId: "unknown-local-base",
      },
      null,
    ],
    [{ id: "ollama/gpt-oss", ownedBy: "local" }, null],
    [{ id: "unknown-model" }, null],
  ];

  for (const [identity, expected] of cases) {
    assert.equal(resolveModelIconKey(identity), expected, JSON.stringify(identity));
  }
});

test("shows macOS title, subtitle, model icon, and exact-chat click routing", async () => {
  const navigations = [];
  const appPath = path.join("", "Applications", "Portico.app", "app.asar");
  const service = createChatNativeNotificationService({
    Notification: FakeNotification,
    app: { getAppPath: () => appPath },
    platform: "darwin",
    existsSync: (candidate) => candidate.endsWith(path.join("assets", "sol.png")),
    navigateToChat: (payload) => navigations.push(payload),
  });

  assert.deepEqual(
    service.show({
      type: "user-question",
      chatId: "chat-42",
      chatTitle: "Hiring plan",
      itemCount: 2,
      notificationKey: "user-question:flow-1",
      modelIdentity: { id: "gpt-5.6-sol" },
    }),
    { shown: true, type: "user-question", chatId: "chat-42" },
  );

  const notification = FakeNotification.instances[0];
  assert.equal(notification.shown, true);
  assert.deepEqual(notification.options, {
    title: "Hiring plan",
    silent: false,
    subtitle: "Please answer 2 questions.",
    icon: path.join(appPath, "assets", "sol.png"),
  });

  notification.emit("click");
  await Promise.resolve();
  assert.deepEqual(navigations, [{ chatId: "chat-42", title: "Hiring plan" }]);
});

test("uses body on non-macOS and omits missing or unknown model icons", () => {
  const service = createChatNativeNotificationService({
    Notification: FakeNotification,
    app: { getAppPath: () => "/app" },
    platform: "win32",
    existsSync: () => false,
    navigateToChat: () => {},
  });

  assert.equal(
    service.show({
      type: "completed",
      chatId: "chat-1",
      chatTitle: "Weekly update",
      modelIdentity: { id: "unknown" },
    }).shown,
    true,
  );
  assert.deepEqual(FakeNotification.instances[0].options, {
    title: "Weekly update",
    silent: false,
    body: "Work has completed.",
    timeoutType: "default",
  });

  assert.equal(
    service.show({
      type: "attention",
      chatId: "chat-2",
      chatTitle: "Research",
      modelIdentity: { id: "anthropic/claude-opus-4.8" },
    }).shown,
    true,
  );
  assert.equal("icon" in FakeNotification.instances[1].options, false);
});

test("retries with the normal app icon when Electron rejects a model icon", () => {
  const warnings = [];
  FakeNotification.rejectIcons = true;
  const service = createChatNativeNotificationService({
    Notification: FakeNotification,
    app: { getAppPath: () => "/app" },
    platform: "darwin",
    existsSync: () => true,
    navigateToChat: () => {},
    logger: { warn: (...parts) => warnings.push(parts.join(" ")) },
  });

  assert.equal(
    service.show({
      type: "completed",
      chatId: "chat-1",
      chatTitle: "Hiring plan",
      modelIdentity: { id: "anthropic/claude-opus-4.8" },
    }).shown,
    true,
  );
  assert.equal(FakeNotification.instances.length, 1);
  assert.deepEqual(FakeNotification.instances[0].options, {
    title: "Hiring plan",
    silent: false,
    subtitle: "Work has completed.",
  });
  assert.equal(warnings.length, 1);
});

test("resolves MCP display names in the service when callers only have an ID", () => {
  const service = createChatNativeNotificationService({
    Notification: FakeNotification,
    platform: "darwin",
    navigateToChat: () => {},
    resolveMcpServerDisplayName: (serverId) =>
      serverId === "mcp-glean" ? "Glean" : serverId,
  });

  assert.equal(
    service.show({
      type: "mcp-oauth",
      chatId: "chat-1",
      chatTitle: "Research",
      serverId: "mcp-glean",
      serverDisplayName: "Stale Glean Name",
    }).shown,
    true,
  );
  assert.equal(
    FakeNotification.instances[0].options.subtitle,
    "Please authorize the Glean integration.",
  );
});

test("deduplicates replayed events briefly without suppressing later completions", () => {
  let currentTime = 1_000;
  const service = createChatNativeNotificationService({
    Notification: FakeNotification,
    platform: "darwin",
    navigateToChat: () => {},
    now: () => currentTime,
  });
  const payload = {
    type: "completed",
    chatId: "chat-1",
    chatTitle: "Chat one",
  };

  assert.equal(service.show(payload).shown, true);
  assert.equal(service.show(payload).duplicate, true);
  currentTime += 1_501;
  assert.equal(service.show(payload).shown, true);
});

test("suppresses notifications when the originating chat is active", () => {
  const info = [];
  const service = createChatNativeNotificationService({
    Notification: FakeNotification,
    platform: "darwin",
    navigateToChat: () => {},
    isChatActive: (chatId) => chatId === "chat-active",
    logger: {
      info: (message, context) => info.push({ message, context }),
      warn: () => {},
    },
  });

  assert.deepEqual(
    service.show({
      type: "completed",
      chatId: "chat-active",
      chatTitle: "Focused work",
    }),
    { shown: false, suppressed: true, reason: "chat-active" },
  );
  assert.equal(FakeNotification.instances.length, 0);
  assert.deepEqual(info, [
    {
      message: "[Chat Notifications] Native notification suppressed",
      context: {
        type: "completed",
        chatId: "chat-active",
        reason: "chat-active",
      },
    },
  ]);

  assert.equal(
    service.show({
      type: "completed",
      chatId: "chat-background",
      chatTitle: "Background work",
    }).shown,
    true,
  );
  assert.equal(FakeNotification.instances.length, 1);
});

test("rechecks active-chat state before a deferred completion is presented", () => {
  const timers = makeControllableTimers();
  let active = false;
  const service = createChatNativeNotificationService({
    Notification: FakeNotification,
    platform: "darwin",
    navigateToChat: () => {},
    isChatActive: () => active,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  assert.equal(
    service.show({
      type: "completed",
      chatId: "chat-1",
      chatTitle: "New Chat",
    }).deferred,
    true,
  );
  active = true;
  timers.flushAll();
  assert.equal(FakeNotification.instances.length, 0);
});

test("fails open when active-chat detection throws", () => {
  const warnings = [];
  const service = createChatNativeNotificationService({
    Notification: FakeNotification,
    platform: "darwin",
    navigateToChat: () => {},
    isChatActive: () => {
      throw new Error("view registry unavailable");
    },
    logger: {
      info: () => {},
      warn: (...parts) => warnings.push(parts.join(" ")),
    },
  });

  assert.equal(
    service.show({
      type: "attention",
      chatId: "chat-1",
      chatTitle: "Research",
    }).shown,
    true,
  );
  assert.equal(FakeNotification.instances.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /view registry unavailable/);
});

test("logs privacy-safe submission and asynchronous delivery failures", () => {
  const info = [];
  const warnings = [];
  const service = createChatNativeNotificationService({
    Notification: FakeNotification,
    platform: "darwin",
    navigateToChat: () => {},
    logger: {
      info: (message, context) => info.push({ message, context }),
      warn: (message, context) => warnings.push({ message, context }),
    },
  });

  assert.equal(
    service.show({
      type: "completed",
      chatId: "chat-logging",
      chatTitle: "Sensitive title that must not be logged",
    }).shown,
    true,
  );
  assert.deepEqual(info, [
    {
      message: "[Chat Notifications] Native notification submitted",
      context: {
        type: "completed",
        chatId: "chat-logging",
        platform: "darwin",
        customIcon: false,
      },
    },
  ]);
  assert.equal(JSON.stringify(info).includes("Sensitive title"), false);

  FakeNotification.instances[0].emit(
    "failed",
    {},
    new Error("notification daemon unavailable"),
  );
  assert.deepEqual(warnings, [
    {
      message: "[Chat Notifications] Native notification failed",
      context: {
        type: "completed",
        chatId: "chat-logging",
        error: "notification daemon unavailable",
      },
    },
  ]);
});

function makeControllableTimers() {
  const timers = new Map();
  let nextId = 0;
  return {
    setTimeoutFn: (fn) => {
      const id = ++nextId;
      timers.set(id, fn);
      return id;
    },
    clearTimeoutFn: (id) => timers.delete(id),
    flushAll: () => {
      for (const [id, fn] of [...timers]) {
        timers.delete(id);
        fn();
      }
    },
    pendingCount: () => timers.size,
  };
}

test("defers completion notifications with a placeholder title until the real title resolves", () => {
  const timers = makeControllableTimers();
  const service = createChatNativeNotificationService({
    Notification: FakeNotification,
    platform: "darwin",
    navigateToChat: () => {},
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  // Busy→idle for a new chat: title still the placeholder → deferred, not shown.
  assert.deepEqual(
    service.show({ type: "completed", chatId: "chat-1", chatTitle: "New Chat" }),
    { shown: false, deferred: true },
  );
  assert.equal(FakeNotification.instances.length, 0);

  // A later activity report with the placeholder is a no-op (stays deferred).
  assert.deepEqual(service.resolveTitle("chat-1", "New Chat"), { resolved: false });
  assert.equal(FakeNotification.instances.length, 0);

  // The real auto-generated title arrives → notification fires with it.
  assert.deepEqual(service.resolveTitle("chat-1", "Q3 hiring plan"), {
    resolved: true,
  });
  assert.equal(FakeNotification.instances.length, 1);
  assert.equal(FakeNotification.instances[0].options.title, "Q3 hiring plan");
  assert.equal(timers.pendingCount(), 0);
});

test("deferred completion fires with the placeholder on timeout if no title arrives", () => {
  const timers = makeControllableTimers();
  const service = createChatNativeNotificationService({
    Notification: FakeNotification,
    platform: "darwin",
    navigateToChat: () => {},
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  service.show({ type: "completed", chatId: "chat-1", chatTitle: "" });
  assert.equal(FakeNotification.instances.length, 0);

  timers.flushAll(); // title generation never happened
  assert.equal(FakeNotification.instances.length, 1);
  assert.equal(FakeNotification.instances[0].options.title, "New Chat");
});

test("completion notifications with a real title show immediately (no deferral)", () => {
  const timers = makeControllableTimers();
  const service = createChatNativeNotificationService({
    Notification: FakeNotification,
    platform: "darwin",
    navigateToChat: () => {},
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  assert.equal(
    service.show({ type: "completed", chatId: "chat-1", chatTitle: "Weekly update" })
      .shown,
    true,
  );
  assert.equal(FakeNotification.instances.length, 1);
  assert.equal(timers.pendingCount(), 0);
  // resolveTitle with no pending entry is a harmless no-op.
  assert.deepEqual(service.resolveTitle("chat-1", "Later title"), { resolved: false });
});

test("a real-title completion supersedes a pending placeholder deferral (no stale double-fire)", () => {
  const timers = makeControllableTimers();
  const service = createChatNativeNotificationService({
    Notification: FakeNotification,
    platform: "darwin",
    navigateToChat: () => {},
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  // First completion for a new chat is deferred (placeholder title).
  service.show({ type: "completed", chatId: "chat-1", chatTitle: "New Chat" });
  assert.equal(FakeNotification.instances.length, 0);
  assert.equal(timers.pendingCount(), 1);

  // A completion with a real title arrives via a path that never calls
  // resolveTitle (e.g. show-chat-native-notification IPC): it presents now AND
  // clears the pending deferral so the stale timer can't fire a duplicate later.
  assert.equal(
    service.show({ type: "completed", chatId: "chat-1", chatTitle: "Q3 hiring plan" })
      .shown,
    true,
  );
  assert.equal(FakeNotification.instances.length, 1);
  assert.equal(FakeNotification.instances[0].options.title, "Q3 hiring plan");
  assert.equal(timers.pendingCount(), 0);

  // The now-cancelled timer must not resurrect a stale "New Chat" notification.
  timers.flushAll();
  assert.equal(FakeNotification.instances.length, 1);
});

test("user-question notifications present immediately with a purposeful title instead of the placeholder", async () => {
  const timers = makeControllableTimers();
  const navigations = [];
  const service = createChatNativeNotificationService({
    Notification: FakeNotification,
    platform: "darwin",
    navigateToChat: (payload) => navigations.push(payload),
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  // Questions arrive before the chat has a real title. Deferring would starve
  // the notification (the response — and thus auto-titling — is blocked on the
  // answer), so it presents NOW under the type's display title.
  assert.deepEqual(
    service.show({
      type: "user-question",
      chatId: "chat-1",
      chatTitle: "New Chat",
      itemCount: 3,
    }),
    { shown: true, type: "user-question", chatId: "chat-1" },
  );
  assert.equal(timers.pendingCount(), 0);
  const notification = FakeNotification.instances[0];
  assert.equal(notification.options.title, "We need your input");
  assert.equal(notification.options.subtitle, "Please answer 3 questions.");

  // Click routing still carries the raw chat title (it becomes the tab label).
  notification.emit("click");
  await Promise.resolve();
  assert.deepEqual(navigations, [{ chatId: "chat-1", title: "New Chat" }]);

  // A real chat title always beats the type title.
  service.show({
    type: "user-question",
    chatId: "chat-2",
    chatTitle: "Hiring plan",
    itemCount: 1,
  });
  assert.equal(FakeNotification.instances[1].options.title, "Hiring plan");

  // Types without a display title keep the placeholder behavior.
  assert.equal(
    service.show({ type: "attention", chatId: "chat-3", chatTitle: "" }).shown,
    true,
  );
  assert.equal(FakeNotification.instances[2].options.title, "New Chat");
});

test("fails closed when native notifications are unavailable", () => {
  FakeNotification.supported = false;
  const service = createChatNativeNotificationService({
    Notification: FakeNotification,
    navigateToChat: () => {},
  });
  assert.equal(
    service.show({ type: "attention", chatId: "chat-1" }).shown,
    false,
  );
  assert.equal(FakeNotification.instances.length, 0);
});
