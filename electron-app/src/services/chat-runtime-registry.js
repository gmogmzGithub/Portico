"use strict";

const DEFAULT_PHASE = "idle";
const MAX_CHAT_ID_LENGTH = 256;
const MAX_PHASE_LENGTH = 64;

function normalizeChatId(value) {
  return typeof value === "string"
    ? value.trim().slice(0, MAX_CHAT_ID_LENGTH)
    : "";
}

function normalizePhase(value, busy) {
  if (!busy) {
    return DEFAULT_PHASE;
  }
  const phase = typeof value === "string" ? value.trim() : "";
  return (phase || DEFAULT_PHASE).slice(0, MAX_PHASE_LENGTH);
}

function createEmptyChatState(chatId) {
  return {
    chatId,
    busy: false,
    phase: DEFAULT_PHASE,
    unread: false,
    attentionRequired: false,
  };
}

function cloneChatState(state) {
  return {
    chatId: state.chatId,
    busy: state.busy === true,
    phase: state.busy === true ? state.phase || DEFAULT_PHASE : DEFAULT_PHASE,
    unread: state.unread === true,
    attentionRequired: state.attentionRequired === true,
  };
}

function statesEqual(left, right) {
  return (
    left?.chatId === right?.chatId &&
    left?.busy === right?.busy &&
    left?.phase === right?.phase &&
    left?.unread === right?.unread &&
    left?.attentionRequired === right?.attentionRequired
  );
}

function shouldRetainChatState(state) {
  return Boolean(
    state &&
      (state.busy === true ||
        state.unread === true ||
        state.attentionRequired === true),
  );
}

/**
 * Per-chat runtime state for the Electron/OWUI bridge.
 *
 * A view observation and a chat's runtime lifecycle are deliberately separate:
 * navigating a view from chat A to chat B must not imply that A stopped. Only an
 * activity report explicitly naming A may change A's busy state.
 */
function createChatRuntimeRegistry() {
  const chats = new Map();
  const views = new Map();

  function isChatViewed(chatId) {
    const normalizedChatId = normalizeChatId(chatId);
    if (!normalizedChatId) {
      return false;
    }
    for (const view of views.values()) {
      if (view.visible === true && view.chatId === normalizedChatId) {
        return true;
      }
    }
    return false;
  }

  function commitState(chatId, nextState) {
    const previousState = chats.get(chatId) || null;
    if (shouldRetainChatState(nextState)) {
      if (statesEqual(previousState, nextState)) {
        return false;
      }
      chats.set(chatId, nextState);
      return true;
    }
    if (previousState) {
      chats.delete(chatId);
      return true;
    }
    return false;
  }

  function markViewed(chatId) {
    const normalizedChatId = normalizeChatId(chatId);
    if (!normalizedChatId) {
      return false;
    }
    const previousState = chats.get(normalizedChatId);
    if (!previousState?.unread) {
      return false;
    }
    return commitState(normalizedChatId, {
      ...previousState,
      unread: false,
    });
  }

  function setViewState(viewKey, payload = {}) {
    const normalizedViewKey = String(viewKey || "").trim();
    if (!normalizedViewKey) {
      return false;
    }

    const previous = views.get(normalizedViewKey) || {
      chatId: "",
      visible: false,
    };
    const next = {
      chatId:
        Object.prototype.hasOwnProperty.call(payload, "chatId")
          ? normalizeChatId(payload.chatId)
          : previous.chatId,
      visible:
        Object.prototype.hasOwnProperty.call(payload, "visible")
          ? payload.visible !== false
          : previous.visible,
    };

    const observationChanged =
      previous.chatId !== next.chatId || previous.visible !== next.visible;
    views.set(normalizedViewKey, next);

    const acknowledgementChanged =
      next.visible && next.chatId ? markViewed(next.chatId) : false;
    return observationChanged || acknowledgementChanged;
  }

  function removeView(viewKey) {
    const normalizedViewKey = String(viewKey || "").trim();
    if (!normalizedViewKey) {
      return false;
    }
    // Removing an observation must never erase the chat lifecycle. The backend
    // task can outlive its renderer, a detached window, or a navigation.
    return views.delete(normalizedViewKey);
  }

  function reportActivity(payload = {}) {
    const chatId = normalizeChatId(payload.chatId);
    if (!chatId || typeof payload.busy !== "boolean") {
      return false;
    }

    const previousState = chats.get(chatId) || createEmptyChatState(chatId);
    const wasBusy = previousState.busy === true;
    const busy = payload.busy === true;
    const viewed = isChatViewed(chatId);
    const nextState = {
      ...previousState,
      busy,
      phase: normalizePhase(payload.phase, busy),
    };

    if (busy) {
      if (viewed) {
        nextState.unread = false;
      }
    } else if (wasBusy) {
      // Mirror the existing tab behavior at chat granularity: work completing
      // away from the currently viewed chat becomes unread.
      nextState.unread = viewed ? false : true;
    } else if (viewed) {
      nextState.unread = false;
    }

    if (typeof payload.unread === "boolean") {
      nextState.unread = payload.unread;
    }
    if (typeof payload.attentionRequired === "boolean") {
      nextState.attentionRequired = payload.attentionRequired;
    }

    return commitState(chatId, nextState);
  }

  function patchChatState(payload = {}) {
    const chatId = normalizeChatId(payload.chatId);
    if (!chatId) {
      return false;
    }

    const previousState = chats.get(chatId) || createEmptyChatState(chatId);
    const nextState = { ...previousState };
    if (typeof payload.busy === "boolean") {
      nextState.busy = payload.busy;
      nextState.phase = normalizePhase(payload.phase, payload.busy);
    } else if (typeof payload.phase === "string" && nextState.busy) {
      nextState.phase = normalizePhase(payload.phase, true);
    }
    if (typeof payload.unread === "boolean") {
      nextState.unread = payload.unread;
    }
    if (typeof payload.attentionRequired === "boolean") {
      nextState.attentionRequired = payload.attentionRequired;
    }
    return commitState(chatId, nextState);
  }

  function getSnapshot() {
    return {
      version: 2,
      chats: Array.from(chats.values())
        .map(cloneChatState)
        .sort((left, right) => left.chatId.localeCompare(right.chatId)),
    };
  }

  function getChatState(chatId) {
    const normalizedChatId = normalizeChatId(chatId);
    if (!normalizedChatId) {
      return null;
    }
    const state = chats.get(normalizedChatId);
    return state ? cloneChatState(state) : null;
  }

  return {
    getChatState,
    getSnapshot,
    isChatViewed,
    markViewed,
    patchChatState,
    removeView,
    reportActivity,
    setViewState,
  };
}

module.exports = {
  createChatRuntimeRegistry,
  normalizeChatId,
};
