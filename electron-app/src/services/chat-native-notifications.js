"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CHAT_NOTIFICATION_TYPES = new Set([
  "completed",
  "user-question",
  "mcp-oauth",
  "mcp-configuration",
  "sensitive-info",
  "workspace-consent",
  "tool-confirmation",
  "clarification",
  "confirmation",
  "input",
  "attention",
]);
const CHAT_NOTIFICATION_TYPE_ALIASES = Object.freeze({
  question: "user-question",
});
const MODEL_ICON_ASSETS = Object.freeze({
  claude: "claude.png",
  gemini: "gemini.png",
  gpt: "gpt.png",
  sol: "sol.png",
  terra: "terra.png",
  luna: "luna.png",
});
const MAX_CHAT_ID_LENGTH = 256;
const MAX_TITLE_LENGTH = 160;
const MAX_SUBTITLE_LENGTH = 240;
const MAX_NOTIFICATION_KEY_LENGTH = 256;
const MAX_MODEL_VALUE_LENGTH = 256;
const RECENT_NOTIFICATION_TTL_MS = 1_500;
// New chats carry the placeholder title until OWUI's auto-title generation runs
// (which arrives after the busy→idle completion). Completion notifications with a
// placeholder title are deferred until the real title arrives, or this timeout.
const DEFERRED_TITLE_TIMEOUT_MS = 5_000;
const PLACEHOLDER_CHAT_TITLES = new Set(["", "New Chat"]);
// Interactive attention types can't wait for the real title (the response —
// and with it auto-titling — is blocked on the user), so instead of deferring
// they present immediately under a purposeful display title.
const PLACEHOLDER_TYPE_TITLES = Object.freeze({
  "user-question": "We need your input",
});

function normalizeText(value, maxLength) {
  return typeof value === "string"
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxLength)
    : "";
}

function normalizeCount(value, fallback = 1) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count > 0
    ? Math.min(count, 999)
    : fallback;
}

function normalizeModelIdentity(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const identity = {
    id: normalizeText(source.id, MAX_MODEL_VALUE_LENGTH),
    name: normalizeText(source.name, MAX_MODEL_VALUE_LENGTH),
    ownedBy: normalizeText(source.ownedBy, MAX_MODEL_VALUE_LENGTH),
    baseModelId: normalizeText(source.baseModelId, MAX_MODEL_VALUE_LENGTH),
    baseModelName: normalizeText(source.baseModelName, MAX_MODEL_VALUE_LENGTH),
    baseModelOwnedBy: normalizeText(
      source.baseModelOwnedBy,
      MAX_MODEL_VALUE_LENGTH,
    ),
  };
  return Object.values(identity).some(Boolean) ? identity : null;
}

function normalizeModelRoute(value) {
  const normalized = normalizeText(value, MAX_MODEL_VALUE_LENGTH)
    .toLowerCase()
    .replace(/:latest$/i, "");
  const routedId = normalized.split("/").filter(Boolean).at(-1) || "";
  return routedId.replace(/[\s_]+/g, "-").replace(/-+/g, "-");
}

function resolveModelIconKey(modelIdentity = null) {
  const identity = normalizeModelIdentity(modelIdentity);
  if (!identity) {
    return null;
  }

  const hasBaseModel = Boolean(identity.baseModelId);
  const baseValues = [
    identity.baseModelId,
    identity.baseModelName,
    identity.baseModelOwnedBy,
  ].filter(Boolean);
  const directValues = [identity.id, identity.name, identity.ownedBy].filter(Boolean);
  const candidates = hasBaseModel ? [baseValues] : [directValues];

  for (const values of candidates) {
    const haystack = values.join(" ").toLowerCase();
    if (!haystack) {
      continue;
    }
    if (/(?:^|[\s/_-])(local|ollama|lm[\s_-]?studio)(?:$|[\s/_-])/.test(haystack)) {
      return null;
    }

    const routes = values.map(normalizeModelRoute);
    if (routes.includes("gpt-5.6-sol") || routes.includes("gpt-5.6-sol-pro")) {
      return "sol";
    }
    if (routes.includes("gpt-5.6-terra")) {
      return "terra";
    }
    if (routes.includes("gpt-5.6-luna")) {
      return "luna";
    }
    if (/\b(?:claude|anthropic)\b/.test(haystack)) {
      return "claude";
    }
    if (/\b(?:gemini|google|vertex(?:[\s_-]?ai)?)\b/.test(haystack)) {
      return "gemini";
    }
    if (
      /\b(?:openai|chatgpt|gpt)[\w.-]*\b/.test(haystack) ||
      /(?:^|[\s/_-])o[134](?:$|[\s/_-])/.test(haystack)
    ) {
      return "gpt";
    }
  }

  return null;
}

function buildNotificationSubtitle(detail = {}) {
  const itemCount = normalizeCount(detail.itemCount);
  const serverDisplayName =
    normalizeText(detail.serverDisplayName, 120) ||
    normalizeText(detail.serverId, 120) ||
    "requested";

  switch (detail.type) {
    case "completed":
      return "Work has completed.";
    case "user-question":
      return `Please answer ${itemCount} ${itemCount === 1 ? "question" : "questions"}.`;
    case "mcp-oauth":
      return detail.forceAuth === true
        ? `Please reauthorize the ${serverDisplayName} integration.`
        : `Please authorize the ${serverDisplayName} integration.`;
    case "mcp-configuration":
      return normalizeText(detail.configurationReason, 80).toLowerCase() ===
        "credentials_invalid"
        ? `Please reconfigure the ${serverDisplayName} integration.`
        : `Please configure the ${serverDisplayName} integration.`;
    case "sensitive-info":
      return "Please provide the requested sensitive information.";
    case "workspace-consent":
      return "Please approve the requested chat workspace.";
    case "tool-confirmation":
      return `Please review ${itemCount} tool ${itemCount === 1 ? "action" : "actions"}.`;
    case "clarification":
      return itemCount === 1
        ? "Please choose how to continue."
        : `Please respond to ${itemCount} clarifications.`;
    case "confirmation":
      return "Please confirm to continue.";
    case "input":
      return "Please provide the requested information.";
    case "attention":
      return "Your attention is required.";
    default:
      return "";
  }
}

function normalizeChatNotification(payload = {}) {
  const requestedType = normalizeText(payload.type, 48).toLowerCase();
  const type = CHAT_NOTIFICATION_TYPE_ALIASES[requestedType] || requestedType;
  const chatId = normalizeText(payload.chatId, MAX_CHAT_ID_LENGTH);
  if (!CHAT_NOTIFICATION_TYPES.has(type) || !chatId) {
    return null;
  }

  const detail = {
    type,
    chatId,
    chatTitle: normalizeText(payload.chatTitle, MAX_TITLE_LENGTH) || "New Chat",
    notificationKey: normalizeText(
      payload.notificationKey,
      MAX_NOTIFICATION_KEY_LENGTH,
    ),
    itemCount: normalizeCount(payload.itemCount),
    serverId: normalizeText(payload.serverId, 120),
    serverDisplayName: normalizeText(payload.serverDisplayName, 120),
    forceAuth: payload.forceAuth === true,
    configurationReason: normalizeText(payload.configurationReason, 80),
    modelIdentity: normalizeModelIdentity(payload.modelIdentity),
  };
  detail.subtitle = normalizeText(
    buildNotificationSubtitle(detail),
    MAX_SUBTITLE_LENGTH,
  );
  return detail;
}

function createChatNativeNotificationService({
  Notification,
  app,
  navigateToChat,
  platform = process.platform,
  existsSync = fs.existsSync,
  resolveMcpServerDisplayName,
  isChatActive,
  now = () => Date.now(),
  logger = console,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  deferredTitleTimeoutMs = DEFERRED_TITLE_TIMEOUT_MS,
} = {}) {
  const activeNotifications = new Set();
  const recentNotifications = new Map();
  // chatId -> { detail, timer } for completion notifications awaiting the real title.
  const pendingTitleNotifications = new Map();

  function isPlaceholderChatTitle(value) {
    return PLACEHOLDER_CHAT_TITLES.has(normalizeText(value, MAX_TITLE_LENGTH));
  }

  function clearExpiredRecentNotifications(currentTime) {
    for (const [key, timestamp] of recentNotifications) {
      if (currentTime - timestamp >= RECENT_NOTIFICATION_TTL_MS) {
        recentNotifications.delete(key);
      }
    }
  }

  function resolveServerDisplayName(payload = {}) {
    const explicit = normalizeText(payload.serverDisplayName, 120);
    const serverId = normalizeText(payload.serverId, 120);
    if (!serverId || typeof resolveMcpServerDisplayName !== "function") {
      return explicit || serverId;
    }
    try {
      const resolved = normalizeText(resolveMcpServerDisplayName(serverId), 120);
      return resolved && resolved !== serverId
        ? resolved
        : explicit || resolved || serverId;
    } catch (error) {
      logger.warn?.(
        "[Chat Notifications] Failed to resolve MCP display name:",
        error?.message || error,
      );
      return explicit || serverId;
    }
  }

  function resolveIcon(modelIdentity) {
    const iconKey = resolveModelIconKey(modelIdentity);
    const assetName = iconKey ? MODEL_ICON_ASSETS[iconKey] : null;
    if (!assetName || !app || typeof app.getAppPath !== "function") {
      return null;
    }
    try {
      const iconPath = path.join(app.getAppPath(), "assets", assetName);
      return existsSync(iconPath) ? iconPath : null;
    } catch (error) {
      logger.warn?.(
        "[Chat Notifications] Failed to resolve model icon:",
        error?.message || error,
      );
      return null;
    }
  }

  function presentDetail(detail) {
    if (typeof isChatActive === "function") {
      try {
        if (isChatActive(detail.chatId)) {
          logger.info?.("[Chat Notifications] Native notification suppressed", {
            type: detail.type,
            chatId: detail.chatId,
            reason: "chat-active",
          });
          return {
            shown: false,
            suppressed: true,
            reason: "chat-active",
          };
        }
      } catch (error) {
        logger.warn?.(
          "[Chat Notifications] Failed to resolve active chat state:",
          error?.message || error,
        );
      }
    }

    if (!Notification || typeof Notification.isSupported !== "function") {
      logger.info?.("[Chat Notifications] Native notification unavailable", {
        type: detail.type,
        chatId: detail.chatId,
      });
      return { shown: false, error: "Native notifications are unavailable" };
    }
    if (!Notification.isSupported()) {
      logger.info?.("[Chat Notifications] Native notification unsupported", {
        type: detail.type,
        chatId: detail.chatId,
      });
      return { shown: false, error: "Native notifications are unsupported" };
    }

    const currentTime = now();
    clearExpiredRecentNotifications(currentTime);
    const dedupeKey =
      detail.notificationKey || `${detail.type}:${detail.chatId}:${detail.chatTitle}`;
    if (recentNotifications.has(dedupeKey)) {
      logger.info?.("[Chat Notifications] Native notification deduplicated", {
        type: detail.type,
        chatId: detail.chatId,
      });
      return { shown: false, duplicate: true };
    }
    recentNotifications.set(dedupeKey, currentTime);

    const present = (options) => {
      const notification = new Notification(options);
      activeNotifications.add(notification);

      const release = () => activeNotifications.delete(notification);
      notification.once?.("close", release);
      notification.once?.("failed", (_event, error) => {
        release();
        logger.warn?.("[Chat Notifications] Native notification failed", {
          type: detail.type,
          chatId: detail.chatId,
          error: error?.message || String(error || "unknown error"),
        });
      });
      notification.on?.("click", () => {
        release();
        try {
          void Promise.resolve(
            navigateToChat?.({
              chatId: detail.chatId,
              title: detail.chatTitle,
            }),
          ).catch((error) => {
            logger.warn?.(
              "[Chat Notifications] Failed to open notification chat:",
              error?.message || error,
            );
          });
        } catch (error) {
          logger.warn?.(
            "[Chat Notifications] Failed to open notification chat:",
            error?.message || error,
          );
        }
      });
      try {
        notification.show();
      } catch (error) {
        release();
        throw error;
      }
      return notification;
    };

    try {
      // Display-only swap: detail.chatTitle stays intact for the click-to-open
      // tab label and the dedupe key.
      const placeholderTypeTitle =
        isPlaceholderChatTitle(detail.chatTitle) &&
        PLACEHOLDER_TYPE_TITLES[detail.type];
      const options = {
        title: placeholderTypeTitle || detail.chatTitle,
        silent: false,
      };
      if (platform === "darwin") {
        options.subtitle = detail.subtitle;
      } else {
        options.body = detail.subtitle;
        options.timeoutType = "default";
      }
      const icon = resolveIcon(detail.modelIdentity);
      if (icon) {
        options.icon = icon;
      }
      let customIconSubmitted = Boolean(icon);

      try {
        present(options);
      } catch (error) {
        if (!options.icon) {
          throw error;
        }
        logger.warn?.(
          "[Chat Notifications] Model icon failed; retrying with the app icon:",
          error?.message || error,
        );
        const fallbackOptions = { ...options };
        delete fallbackOptions.icon;
        present(fallbackOptions);
        customIconSubmitted = false;
      }
      logger.info?.("[Chat Notifications] Native notification submitted", {
        type: detail.type,
        chatId: detail.chatId,
        platform,
        customIcon: customIconSubmitted,
      });
      return { shown: true, type: detail.type, chatId: detail.chatId };
    } catch (error) {
      logger.warn?.(
        "[Chat Notifications] Failed to show native notification:",
        error?.message || error,
      );
      return { shown: false, error: error?.message || String(error) };
    }
  }

  function show(payload = {}) {
    const detail = normalizeChatNotification({
      ...payload,
      serverDisplayName: resolveServerDisplayName(payload),
    });
    if (!detail) {
      return { shown: false, error: "Invalid chat notification payload" };
    }

    // Defer completion notifications whose title is still the placeholder
    // ("New Chat") until the real, auto-generated title arrives (resolveTitle),
    // or until the timeout fires (so a notification is never lost — e.g. if
    // title generation is disabled).
    if (detail.type === "completed" && isPlaceholderChatTitle(payload.chatTitle)) {
      const existing = pendingTitleNotifications.get(detail.chatId);
      if (existing?.timer) {
        clearTimeoutFn(existing.timer);
      }
      const timer = setTimeoutFn(() => {
        pendingTitleNotifications.delete(detail.chatId);
        presentDetail(detail);
      }, deferredTitleTimeoutMs);
      pendingTitleNotifications.set(detail.chatId, { detail, timer });
      logger.info?.(
        "[Chat Notifications] Deferred completion notification pending real chat title",
        { chatId: detail.chatId },
      );
      return { shown: false, deferred: true };
    }

    // A completed notification we present directly (real title already known)
    // supersedes any placeholder deferral still pending for the same chat —
    // otherwise its stale timer would later fire a duplicate "New Chat" one via
    // a path that never calls resolveTitle (e.g. show-chat-native-notification).
    if (detail.type === "completed") {
      const superseded = pendingTitleNotifications.get(detail.chatId);
      if (superseded) {
        if (superseded.timer) {
          clearTimeoutFn(superseded.timer);
        }
        pendingTitleNotifications.delete(detail.chatId);
      }
    }

    return presentDetail(detail);
  }

  // Called when a chat's real title becomes known (a later activity report). If a
  // completion notification is deferred for that chat, fire it with the real title.
  function resolveTitle(chatId, title) {
    const normalizedChatId = normalizeText(chatId, MAX_CHAT_ID_LENGTH);
    if (!normalizedChatId) {
      return { resolved: false };
    }
    const pending = pendingTitleNotifications.get(normalizedChatId);
    if (!pending) {
      return { resolved: false };
    }
    const realTitle = normalizeText(title, MAX_TITLE_LENGTH);
    if (!realTitle || isPlaceholderChatTitle(realTitle)) {
      return { resolved: false };
    }
    if (pending.timer) {
      clearTimeoutFn(pending.timer);
    }
    pendingTitleNotifications.delete(normalizedChatId);
    presentDetail({ ...pending.detail, chatTitle: realTitle });
    return { resolved: true };
  }

  return {
    show,
    resolveTitle,
    _activeNotifications: activeNotifications,
    _pendingTitleNotifications: pendingTitleNotifications,
  };
}

module.exports = {
  buildNotificationSubtitle,
  createChatNativeNotificationService,
  normalizeChatNotification,
  normalizeModelIdentity,
  resolveModelIconKey,
};
