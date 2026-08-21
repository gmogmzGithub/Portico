const DEFAULT_SENSITIVE_INFO_TIMEOUT_SECONDS = 60 * 60;
const MIN_SENSITIVE_INFO_TIMEOUT_SECONDS = 30;
const MAX_SENSITIVE_INFO_TIMEOUT_SECONDS = 60 * 60;
const MAX_SENSITIVE_VALUE_LENGTH = 64 * 1024;
const MAX_SENSITIVE_PREAMBLE_LENGTH = 4000;
const DEFAULT_SENSITIVE_PLACEHOLDER = "Paste the sensitive value";

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

function normalizeTimeoutSeconds(rawTimeoutSeconds) {
  if (rawTimeoutSeconds == null) {
    return DEFAULT_SENSITIVE_INFO_TIMEOUT_SECONDS;
  }
  if (!Number.isInteger(rawTimeoutSeconds)) {
    throw new Error("timeout_seconds must be an integer");
  }
  if (
    rawTimeoutSeconds < MIN_SENSITIVE_INFO_TIMEOUT_SECONDS ||
    rawTimeoutSeconds > MAX_SENSITIVE_INFO_TIMEOUT_SECONDS
  ) {
    throw new Error(
      `timeout_seconds must be between ${MIN_SENSITIVE_INFO_TIMEOUT_SECONDS} and ${MAX_SENSITIVE_INFO_TIMEOUT_SECONDS}`,
    );
  }
  return rawTimeoutSeconds;
}

// Visual-aid images may only come from the chat workspace served by the local
// Electron API (skills_get_skill_assets download URLs) — never remote hosts.
const SENSITIVE_INFO_VISUAL_AID_URL_PREFIXES = [
  "http://localhost:9876/workspace/",
  "http://127.0.0.1:9876/workspace/",
];
const MAX_SENSITIVE_INFO_VISUAL_AIDS = 8;
const MAX_SENSITIVE_INFO_VISUAL_AID_STEP = 20;
const MAX_SENSITIVE_INFO_VISUAL_AID_URL_LENGTH = 500;

function normalizeSensitiveInfoVisualAids(rawList) {
  if (!Array.isArray(rawList)) {
    return null;
  }
  const normalized = [];
  for (const item of rawList) {
    if (normalized.length >= MAX_SENSITIVE_INFO_VISUAL_AIDS) {
      break;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const step = item.step;
    if (
      !Number.isInteger(step) ||
      step < 1 ||
      step > MAX_SENSITIVE_INFO_VISUAL_AID_STEP
    ) {
      continue;
    }
    const imageUrl =
      typeof item.image_url === "string" ? item.image_url.trim() : "";
    if (
      !imageUrl ||
      imageUrl.length > MAX_SENSITIVE_INFO_VISUAL_AID_URL_LENGTH ||
      !SENSITIVE_INFO_VISUAL_AID_URL_PREFIXES.some((prefix) =>
        imageUrl.startsWith(prefix),
      )
    ) {
      continue;
    }
    const alt =
      typeof item.alt === "string" && item.alt.trim()
        ? item.alt.trim().slice(0, 200)
        : null;
    normalized.push({ step, image_url: imageUrl, alt });
  }
  return normalized.length > 0 ? normalized : null;
}

function normalizeSensitiveInfoRequest(payload = {}) {
  const chatId = requireTrimmedString(payload?.chat_id, "chat_id", {
    maxLength: 120,
  });
  const prompt = requireTrimmedString(payload?.prompt, "prompt", {
    maxLength: 1000,
  });
  const preamble = optionalTrimmedString(payload?.preamble, "preamble", {
    maxLength: MAX_SENSITIVE_PREAMBLE_LENGTH,
  });
  const label = optionalTrimmedString(payload?.label, "label", {
    maxLength: 80,
  });
  const placeholder =
    optionalTrimmedString(payload?.placeholder, "placeholder", {
      maxLength: 200,
    }) || DEFAULT_SENSITIVE_PLACEHOLDER;

  return {
    chatId,
    prompt,
    preamble,
    label,
    placeholder,
    timeoutSeconds: normalizeTimeoutSeconds(payload?.timeout_seconds),
    visualAids: normalizeSensitiveInfoVisualAids(payload?.visual_aids),
  };
}

function normalizeSensitiveValue(value) {
  if (typeof value !== "string") {
    throw new Error("sensitive_value must be a string");
  }
  if (!value.length) {
    throw new Error("sensitive_value is required");
  }
  if (value.length > MAX_SENSITIVE_VALUE_LENGTH) {
    throw new Error(
      `sensitive_value must be ${MAX_SENSITIVE_VALUE_LENGTH} characters or fewer`,
    );
  }
  return value;
}

function buildSensitiveInfoSubmittedResult(flowEntry, sensitiveValue) {
  return {
    success: true,
    status: "submitted",
    flow_id: flowEntry?.flowId || null,
    sensitive_value: normalizeSensitiveValue(sensitiveValue),
    message: "Sensitive information submitted.",
  };
}

function buildSensitiveInfoDismissedResult(flowEntry) {
  return {
    success: false,
    status: "dismissed",
    flow_id: flowEntry?.flowId || null,
    error: "User dismissed the sensitive information modal",
    message: "The user dismissed the sensitive information modal without submitting a value.",
  };
}

function buildSensitiveInfoTimeoutResult(flowEntry) {
  return {
    success: false,
    status: "timeout",
    flow_id: flowEntry?.flowId || null,
    error: "User did not submit sensitive information before the modal timed out",
    message: "The sensitive information modal timed out before the user submitted a value.",
  };
}

function buildSensitiveInfoCancelledResult(flowEntry, reason) {
  const detail =
    typeof reason === "string" && reason.trim() ? ` (${reason.trim()})` : "";
  return {
    success: false,
    status: "cancelled",
    flow_id: flowEntry?.flowId || null,
    error: `The sensitive information request was cancelled before the user responded${detail}`,
    message:
      "The requesting tool call ended before the user submitted a value, so the secure prompt was closed.",
  };
}

function buildSensitiveInfoErrorResult(flowEntry, error) {
  const message =
    typeof error === "string" && error.trim()
      ? error.trim()
      : "Sensitive information flow failed";

  return {
    success: false,
    status: "error",
    flow_id: flowEntry?.flowId || null,
    error: message,
    message,
  };
}

function sanitizeSensitiveInfoResultForStorage(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }
  const clone = { ...result };
  if (Object.prototype.hasOwnProperty.call(clone, "sensitive_value")) {
    clone.sensitive_value = null;
    clone.sensitive_value_consumed = true;
  }
  return clone;
}

module.exports = {
  DEFAULT_SENSITIVE_INFO_TIMEOUT_SECONDS,
  DEFAULT_SENSITIVE_PLACEHOLDER,
  MAX_SENSITIVE_PREAMBLE_LENGTH,
  MAX_SENSITIVE_VALUE_LENGTH,
  normalizeSensitiveInfoRequest,
  normalizeSensitiveInfoVisualAids,
  buildSensitiveInfoSubmittedResult,
  buildSensitiveInfoDismissedResult,
  buildSensitiveInfoTimeoutResult,
  buildSensitiveInfoCancelledResult,
  buildSensitiveInfoErrorResult,
  sanitizeSensitiveInfoResultForStorage,
};
