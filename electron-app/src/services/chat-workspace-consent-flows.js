const os = require("os");
const path = require("path");

const { collapseHomePath } = require("./chat-workspaces");
const { normalizeAbsoluteWorkspacePath } = require("./chat-workspace-application");

const DEFAULT_CHAT_WORKSPACE_CONSENT_TIMEOUT_SECONDS = 60 * 60;
const MIN_CHAT_WORKSPACE_CONSENT_TIMEOUT_SECONDS = 30;
const MAX_CHAT_WORKSPACE_CONSENT_TIMEOUT_SECONDS = 60 * 60;
const MAX_CHAT_WORKSPACE_CONSENT_PREAMBLE_LENGTH = 4000;

function requireTrimmedString(value, fieldName, { maxLength = 1000 } = {}) {
  if (value == null) {
    throw new Error(`${fieldName} is required`);
  }
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} is required`);
  }
  if (trimmed.length > maxLength) {
    throw new Error(`${fieldName} must be ${maxLength} characters or fewer`);
  }
  return trimmed;
}

function optionalTrimmedString(value, fieldName, { maxLength = 1000 } = {}) {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length > maxLength) {
    throw new Error(`${fieldName} must be ${maxLength} characters or fewer`);
  }
  return trimmed;
}

function normalizeChatWorkspaceConsentTimeoutSeconds(rawTimeoutSeconds) {
  if (rawTimeoutSeconds == null) {
    return DEFAULT_CHAT_WORKSPACE_CONSENT_TIMEOUT_SECONDS;
  }
  if (!Number.isInteger(rawTimeoutSeconds)) {
    throw new Error("timeout_seconds must be an integer");
  }
  if (
    rawTimeoutSeconds < MIN_CHAT_WORKSPACE_CONSENT_TIMEOUT_SECONDS ||
    rawTimeoutSeconds > MAX_CHAT_WORKSPACE_CONSENT_TIMEOUT_SECONDS
  ) {
    throw new Error(
      `timeout_seconds must be between ${MIN_CHAT_WORKSPACE_CONSENT_TIMEOUT_SECONDS} and ${MAX_CHAT_WORKSPACE_CONSENT_TIMEOUT_SECONDS}`,
    );
  }
  return rawTimeoutSeconds;
}

function normalizeChatWorkspaceConsentRequest(payload = {}, options = {}) {
  const chatId = requireTrimmedString(payload?.chat_id, "chat_id", {
    maxLength: 120,
  });
  const rawHostPath = requireTrimmedString(payload?.host_path, "host_path", {
    maxLength: 4096,
  });
  const homeDir = options.homeDir || os.homedir();
  let hostPath;
  try {
    hostPath = normalizeAbsoluteWorkspacePath(rawHostPath, {
      fieldName: "host_path",
      homeDir,
    });
  } catch (error) {
    if (String(error?.message || "").includes("absolute path")) {
      throw new Error("host_path must be an absolute path");
    }
    throw error;
  }
  if (!path.isAbsolute(hostPath)) {
    throw new Error("host_path must be an absolute path");
  }

  return {
    chatId,
    hostPath,
    displayPath: collapseHomePath(hostPath, homeDir),
    preamble: optionalTrimmedString(payload?.preamble, "preamble", {
      maxLength: MAX_CHAT_WORKSPACE_CONSENT_PREAMBLE_LENGTH,
    }),
    timeoutSeconds: normalizeChatWorkspaceConsentTimeoutSeconds(payload?.timeout_seconds),
  };
}

function buildChatWorkspaceConsentAppliedResult(flowEntry, applicationResult = {}) {
  return {
    success: true,
    status: "applied",
    flow_id: flowEntry?.flowId || null,
    chat_id: flowEntry?.chatId || null,
    host_path: flowEntry?.hostPath || null,
    display_path: flowEntry?.displayPath || flowEntry?.hostPath || "",
    selection: applicationResult.selection || null,
    rebind: applicationResult.rebind || null,
    message: "Chat workspace was updated.",
  };
}

function buildChatWorkspaceConsentDismissedResult(flowEntry) {
  return {
    success: false,
    status: "dismissed",
    flow_id: flowEntry?.flowId || null,
    chat_id: flowEntry?.chatId || null,
    host_path: flowEntry?.hostPath || null,
    display_path: flowEntry?.displayPath || flowEntry?.hostPath || "",
    error: "User dismissed the chat workspace consent modal",
    message: "The user dismissed the chat workspace consent modal without approving the change.",
  };
}

function buildChatWorkspaceConsentTimeoutResult(flowEntry) {
  return {
    success: false,
    status: "timeout",
    flow_id: flowEntry?.flowId || null,
    chat_id: flowEntry?.chatId || null,
    host_path: flowEntry?.hostPath || null,
    display_path: flowEntry?.displayPath || flowEntry?.hostPath || "",
    error: "User did not approve the workspace change before the modal timed out",
    message: "The chat workspace consent modal timed out before the user approved the change.",
  };
}

function buildChatWorkspaceConsentCancelledResult(flowEntry, reason) {
  const detail =
    typeof reason === "string" && reason.trim() ? ` (${reason.trim()})` : "";
  return {
    success: false,
    status: "cancelled",
    flow_id: flowEntry?.flowId || null,
    chat_id: flowEntry?.chatId || null,
    host_path: flowEntry?.hostPath || null,
    display_path: flowEntry?.displayPath || flowEntry?.hostPath || "",
    error: `The workspace consent request was cancelled before the user responded${detail}`,
    message:
      "The requesting tool call ended before the user responded, so the consent modal was closed.",
  };
}

function buildChatWorkspaceConsentErrorResult(flowEntry, error) {
  const message =
    typeof error === "string" && error.trim()
      ? error.trim()
      : error?.message || "Chat workspace consent flow failed";
  return {
    success: false,
    status: "error",
    flow_id: flowEntry?.flowId || null,
    chat_id: flowEntry?.chatId || null,
    host_path: flowEntry?.hostPath || null,
    display_path: flowEntry?.displayPath || flowEntry?.hostPath || "",
    error: message,
    message,
  };
}

module.exports = {
  MAX_CHAT_WORKSPACE_CONSENT_PREAMBLE_LENGTH,
  DEFAULT_CHAT_WORKSPACE_CONSENT_TIMEOUT_SECONDS,
  buildChatWorkspaceConsentAppliedResult,
  buildChatWorkspaceConsentCancelledResult,
  buildChatWorkspaceConsentDismissedResult,
  buildChatWorkspaceConsentErrorResult,
  buildChatWorkspaceConsentTimeoutResult,
  normalizeChatWorkspaceConsentRequest,
};
