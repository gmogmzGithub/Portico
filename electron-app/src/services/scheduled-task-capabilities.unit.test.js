// Behavioral tests for the scheduled-tasks "Reload from Agent" merge helper.
// The helper is a TS module in the OWUI frontend; we transpile it with esbuild
// (already a dev dependency) and exercise the real logic.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const SRC = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "src",
  "patches",
  "frontend",
  "src",
  "lib",
  "utils",
  "scheduledTaskCapabilities.ts",
);

function loadMerge() {
  const tsSource = fs.readFileSync(SRC, "utf8");
  const { code } = esbuild.transformSync(tsSource, {
    loader: "ts",
    format: "cjs",
  });
  // Run in the current realm so returned arrays share this module's Array
  // prototype (assert/strict deepEqual checks prototype identity).
  const module = { exports: {} };
  const factory = new Function("module", "exports", "require", code);
  factory(module, module.exports, require);
  return module.exports.mergeAgentCapabilities;
}

test("mergeAgentCapabilities adds missing agent ids, preserving order + user extras", () => {
  const mergeAgentCapabilities = loadMerge();
  const current = ["user-extra", "shared-skill"];
  const agent = ["shared-skill", "agent-only-a", "agent-only-b"];
  assert.deepEqual(mergeAgentCapabilities(current, agent), [
    "user-extra",
    "shared-skill",
    "agent-only-a",
    "agent-only-b",
  ]);
});

test("mergeAgentCapabilities never introduces duplicates", () => {
  const mergeAgentCapabilities = loadMerge();
  assert.deepEqual(
    mergeAgentCapabilities(["a", "a", "b"], ["b", "b", "c"]),
    ["a", "b", "c"],
  );
});

test("mergeAgentCapabilities trims and drops empties", () => {
  const mergeAgentCapabilities = loadMerge();
  assert.deepEqual(
    mergeAgentCapabilities([" a ", "", "  "], ["b", " a "]),
    ["a", "b"],
  );
});

test("mergeAgentCapabilities handles empty inputs", () => {
  const mergeAgentCapabilities = loadMerge();
  assert.deepEqual(mergeAgentCapabilities([], ["x"]), ["x"]);
  assert.deepEqual(mergeAgentCapabilities(["x"], []), ["x"]);
  assert.deepEqual(mergeAgentCapabilities(), []);
});
