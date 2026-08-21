// Skill-detail polish: published-skills discovery guidance and the canonical
// Jira browse-URL rule for the VERSIONED skills content.
//
// Former source pins removed rather than converted (no runtime to exercise
// them in Node):
// - styles.css pins (back-button pill, light-mode badge tokens, badge casing
//   parity, the #agent-skills-editor flex-fill chain, header-chip geometry)
//   asserted static CSS text; the rules live in electron-app/src/styles.css
//   and the class names' presence in RENDERED markup is covered behaviorally
//   by skills-inline-page.unit.test.js and
//   skill-card-marketplace-provenance.unit.test.js.
// - Rust pins on skills-server (SKILL_SOLUTION_TYPE = "skills",
//   handle_list_published_skills + its dispatcher entry) asserted source
//   text; the behavior is covered by the Rust suite in
//   src/core-mcp-rust/crates/skills-server/src/native/skills_ai_marketplace_tests.rs
//   (list_published_skills round-trip against the mocked marketplace).
//
// The remaining checks assert CONTENT shipped to the model/marketplace
// (SKILL.md guidance and tool_spec.json), not implementation source.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..", "..", "..");
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

test("the skill-publishing skill teaches list_published_skills for ownership questions", () => {
  const skill = read("skills/skill-publishing/SKILL.md");
  assert.match(skill, /`list_published_skills`/);
  assert.match(skill, /"What have I published\?"/);
  assert.match(skill, /Do NOT try to answer ownership questions with/);
});

test("skills-server ships list_published_skills in its tool spec", () => {
  const spec = JSON.parse(read("src/core-mcp-rust/crates/skills-server/tool_spec.json"));
  const names = spec.map((s) => s.name);
  assert.ok(names.includes("list_published_skills"), "tool_spec declares the tool");
});
