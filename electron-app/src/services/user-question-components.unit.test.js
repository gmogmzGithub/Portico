const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..", "..", "..");

test("ask_user_question tool spec declares all supported picker components", () => {
  const specs = JSON.parse(
    fs.readFileSync(
      path.join(repoRoot, "src/core-mcp-rust/crates/skills-server/tool_spec.json"),
      "utf8",
    ),
  );
  const questionTool = specs.find((spec) => spec.name === "ask_user_question");
  const question = questionTool.inputSchema.properties.questions.items;

  assert.deepEqual(question.properties.components.items.properties.type.enum, [
    "skill_picker",
    "mcp_server_picker",
    "model_picker",
    "reasoning_effort_picker",
  ]);
  assert.equal(question.properties.components_gated_by_option_id.type, "string");
  assert.equal((question.required || []).includes("options"), false);
  assert.equal(
    (question.required || []).includes("components_gated_by_option_id"),
    false,
  );
});

test("the tool spec and guided-flows skill document picker default seeds", () => {
  const specs = JSON.parse(
    fs.readFileSync(
      path.join(repoRoot, "src/core-mcp-rust/crates/skills-server/tool_spec.json"),
      "utf8",
    ),
  );
  const q = specs.find((s) => s.name === "ask_user_question");
  const item = q.inputSchema.properties.questions.items;

  // Option-level seeds: choosing the option reveals the pickers prefilled.
  const optionProps = item.properties.options.items.properties;
  assert.ok(optionProps.component_defaults, "option items declare `component_defaults`");
  assert.equal(optionProps.component_defaults.type, "object");
  assert.equal(optionProps.component_defaults.additionalProperties.type, "array");
  assert.ok(
    !(item.properties.options.items.required || []).includes("component_defaults"),
  );

  // Component-level seeds for ungated pickers.
  const componentProps = item.properties.components.items.properties;
  assert.ok(componentProps.default_selected, "component items declare `default_selected`");
  assert.equal(componentProps.default_selected.type, "array");
  assert.ok(
    !(item.properties.components.items.required || []).includes("default_selected"),
  );

  // The gate description covers the defaults-driven reveal path too.
  assert.match(
    item.properties.components_gated_by_option_id.description,
    /component_defaults/,
  );

  const skill = fs.readFileSync(
    path.join(repoRoot, "skills/guided-flows/SKILL.md"),
    "utf8",
  );
  assert.match(skill, /`component_defaults`/);
  assert.match(skill, /`default_selected`/);
  assert.match(skill, /Start from the recommended set/);
});
