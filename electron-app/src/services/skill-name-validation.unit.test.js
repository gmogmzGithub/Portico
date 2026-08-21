// Unit tests for the Duplicate-skill name validator.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_SKILL_NAME_LENGTH,
  sanitizeSkillDirectoryName,
  validateSkillName,
} = require("./skill-name-validation");

test("sanitizeSkillDirectoryName mirrors the backend directory rules", () => {
  assert.equal(sanitizeSkillDirectoryName("Artifacts Copy"), "Artifacts-Copy");
  assert.equal(sanitizeSkillDirectoryName("  My  Skill  "), "My-Skill");
  assert.equal(sanitizeSkillDirectoryName("a/b\\c"), "a-b-c");
  assert.equal(sanitizeSkillDirectoryName("...dots"), "dots");
  assert.equal(sanitizeSkillDirectoryName("--edge--"), "edge");
  // No usable characters falls back to the sentinel.
  assert.equal(sanitizeSkillDirectoryName("@@@"), "skill");
});

test("valid name passes and reports its sanitized directory form", () => {
  const result = validateSkillName("Artifacts Copy", { existingSkillNames: [] });
  assert.equal(result.valid, true);
  assert.equal(result.value, "Artifacts Copy");
  assert.equal(result.sanitized, "Artifacts-Copy");
  assert.equal(result.error, "");
});

test("empty / whitespace name is rejected", () => {
  assert.equal(validateSkillName("", {}).error, "Name is required");
  assert.equal(validateSkillName("   ", {}).error, "Name is required");
});

test("name over the length limit is rejected", () => {
  const tooLong = "a".repeat(MAX_SKILL_NAME_LENGTH + 1);
  const result = validateSkillName(tooLong, {});
  assert.equal(result.valid, false);
  assert.match(result.error, /characters or fewer/);
});

test("names with no letters or numbers are rejected", () => {
  const result = validateSkillName("###", {});
  assert.equal(result.valid, false);
  assert.match(result.error, /letters or numbers/);
});

test("control characters are rejected", () => {
  const result = validateSkillName(`bad${String.fromCharCode(1)}name`, {});
  assert.equal(result.valid, false);
  assert.match(result.error, /control characters/);
});

test("collision against existing user skills is rejected (sanitized, case-insensitive)", () => {
  // Existing user skill dir names are already sanitized; compare on that form.
  const existingSkillNames = ["artifacts-copy", "my-other-skill"];
  const dup = validateSkillName("Artifacts Copy", { existingSkillNames });
  assert.equal(dup.valid, false);
  assert.match(dup.error, /already exists/);

  // Different casing / spacing that sanitizes to the same dir also collides.
  const dup2 = validateSkillName("ARTIFACTS   copy", { existingSkillNames });
  assert.equal(dup2.valid, false);

  // A distinct name is accepted.
  const ok = validateSkillName("Artifacts Copy 2", { existingSkillNames });
  assert.equal(ok.valid, true);
});
