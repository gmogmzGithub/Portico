const MAX_AGENT_NAME_LENGTH = 100;
const CONTROL_CHAR_REGEX = /[\u0000-\u001f\u007f]/;
const UNSUPPORTED_AGENT_NAME_CHAR_REGEX = /&/;

function normalizeAgentName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function validateAgentName(value, { existingNames = [], currentName = "" } = {}) {
  const trimmed = String(value || "").trim();

  if (!trimmed) {
    return { valid: false, value: "", error: "Name is required" };
  }

  if (trimmed.length > MAX_AGENT_NAME_LENGTH) {
    return {
      valid: false,
      value: trimmed,
      error: `Name must be ${MAX_AGENT_NAME_LENGTH} characters or fewer`,
    };
  }

  if (CONTROL_CHAR_REGEX.test(trimmed)) {
    return {
      valid: false,
      value: trimmed,
      error: "Name contains unsupported control characters",
    };
  }

  if (UNSUPPORTED_AGENT_NAME_CHAR_REGEX.test(trimmed)) {
    return {
      valid: false,
      value: trimmed,
      error: 'Name cannot contain "&"',
    };
  }

  const normalized = normalizeAgentName(trimmed);
  const normalizedCurrent = normalizeAgentName(currentName);
  const duplicate = existingNames.some((candidate) => {
    const normalizedCandidate = normalizeAgentName(candidate);
    return normalizedCandidate && normalizedCandidate === normalized;
  });

  if (duplicate && normalized !== normalizedCurrent) {
    return {
      valid: false,
      value: trimmed,
      error: "Name must be unique",
    };
  }

  return { valid: true, value: trimmed, error: "" };
}

module.exports = {
  MAX_AGENT_NAME_LENGTH,
  normalizeAgentName,
  validateAgentName,
};
