// Validation for user-supplied skill names (used by the Duplicate-skill flow).
// The chosen name is sanitized into a directory name that becomes the skill id,
// so it must be non-empty, within length limits, and unique among existing user
// skills. `sanitizeSkillDirectoryName` mirrors marketplace-service.js's
// `sanitizeUserSkillDirectoryName` so the renderer's uniqueness check matches
// the directory the main process will actually create.

const MAX_SKILL_NAME_LENGTH = 100;
const CONTROL_CHAR_REGEX = new RegExp("[\\u0000-\\u001f\\u007f]");

function sanitizeSkillDirectoryName(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/[\\/]/g, "-")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^\.+/, "")
    .replace(/^-+|-+$/g, "");
  return normalized || "skill";
}

function validateSkillName(value, { existingSkillNames = [] } = {}) {
  const trimmed = String(value || "").trim();

  if (!trimmed) {
    return { valid: false, value: "", sanitized: "", error: "Name is required" };
  }

  if (trimmed.length > MAX_SKILL_NAME_LENGTH) {
    return {
      valid: false,
      value: trimmed,
      sanitized: "",
      error: `Name must be ${MAX_SKILL_NAME_LENGTH} characters or fewer`,
    };
  }

  if (CONTROL_CHAR_REGEX.test(trimmed)) {
    return {
      valid: false,
      value: trimmed,
      sanitized: "",
      error: "Name contains unsupported control characters",
    };
  }

  // Reject names that have no usable directory characters (letters/numbers).
  if (!/[a-zA-Z0-9]/.test(trimmed)) {
    return {
      valid: false,
      value: trimmed,
      sanitized: "",
      error: "Name must contain letters or numbers",
    };
  }

  // Compare against ALL skill names (system + user + marketplace): get-skills
  // dedups by source precedence, so a user copy that collides with a core or
  // marketplace skill is silently shadowed (invisible in the list). Block it.
  const sanitized = sanitizeSkillDirectoryName(trimmed);
  const existingSanitized = new Set(
    (existingSkillNames || [])
      .map((name) => sanitizeSkillDirectoryName(name).toLowerCase())
      .filter(Boolean),
  );
  if (existingSanitized.has(sanitized.toLowerCase())) {
    return {
      valid: false,
      value: trimmed,
      sanitized,
      error: "A skill with this name already exists",
    };
  }

  return { valid: true, value: trimmed, sanitized, error: "" };
}

module.exports = {
  MAX_SKILL_NAME_LENGTH,
  sanitizeSkillDirectoryName,
  validateSkillName,
};
