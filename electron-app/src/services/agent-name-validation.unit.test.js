const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_AGENT_NAME_LENGTH,
  normalizeAgentName,
  validateAgentName,
} = require("./agent-name-validation");

test("normalizeAgentName trims, collapses whitespace, and lowercases", () => {
  assert.equal(normalizeAgentName("  My   Agent  "), "my agent");
});

test("validateAgentName requires a non-empty trimmed name", () => {
  const result = validateAgentName("   ");
  assert.equal(result.valid, false);
  assert.equal(result.error, "Name is required");
});

test("validateAgentName enforces the maximum length", () => {
  const result = validateAgentName("a".repeat(MAX_AGENT_NAME_LENGTH + 1));
  assert.equal(result.valid, false);
  assert.match(result.error, /characters or fewer/);
});

test("validateAgentName rejects control characters", () => {
  const result = validateAgentName("Bad\u0007Name");
  assert.equal(result.valid, false);
  assert.equal(result.error, "Name contains unsupported control characters");
});

test("validateAgentName rejects ampersands", () => {
  const result = validateAgentName("Guillermo & Dionny");
  assert.equal(result.valid, false);
  assert.equal(result.error, 'Name cannot contain "&"');
});

test("validateAgentName rejects case-insensitive duplicates", () => {
  const result = validateAgentName("Lifecycle Agent", {
    existingNames: ["lifecycle   agent", "Other Agent"],
  });
  assert.equal(result.valid, false);
  assert.equal(result.error, "Name must be unique");
});

test("validateAgentName allows keeping the current name during edit", () => {
  const result = validateAgentName("Lifecycle Agent", {
    existingNames: ["Lifecycle Agent"],
    currentName: "lifecycle agent",
  });
  assert.equal(result.valid, true);
  assert.equal(result.value, "Lifecycle Agent");
});

test("validateAgentName returns the trimmed display name when valid", () => {
  const result = validateAgentName("  Lifecycle Agent  ", {
    existingNames: ["Other Agent"],
  });
  assert.equal(result.valid, true);
  assert.equal(result.value, "Lifecycle Agent");
});
