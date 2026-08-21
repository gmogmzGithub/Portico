// Verifies the OWUI frontend's skillInitials/cleanSkillName (TS) agree with the
// Electron implementation (skill-initials.js). Both pickers must derive the
// same two-letter logo + clean name, so we transpile the real TS module with
// esbuild and cross-check it against the JS one on the same inputs.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const { skillInitials: jsInitials } = require("./skill-initials");

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
  "skillInitials.ts",
);

function loadOwui() {
  const tsSource = fs.readFileSync(SRC, "utf8");
  const { code } = esbuild.transformSync(tsSource, { loader: "ts", format: "cjs" });
  const module = { exports: {} };
  const factory = new Function("module", "exports", "require", code);
  factory(module, module.exports, require);
  return module.exports;
}

const CASES = [
  "MCP Bridge Setup",
  "Algorithmic Art",
  "Artifacts",
  "Anthropic Agent Skills/Algorithmic Art",
  "mcp-bridge-setup",
  "web_search",
  "",
];

test("OWUI skillInitials matches the user's stated examples", () => {
  const { skillInitials } = loadOwui();
  assert.equal(skillInitials("MCP Bridge Setup"), "MS");
  assert.equal(skillInitials("Algorithmic Art"), "AA");
  assert.equal(skillInitials("Artifacts"), "AR");
});

test("OWUI skillInitials agrees with the Electron implementation", () => {
  const { skillInitials } = loadOwui();
  for (const name of CASES) {
    assert.equal(
      skillInitials(name),
      jsInitials(name),
      `initials disagree for ${JSON.stringify(name)}`,
    );
  }
});

test("OWUI cleanSkillName strips the marketplace path prefix and prettifies", () => {
  const { cleanSkillName } = loadOwui();
  assert.equal(cleanSkillName("Anthropic Agent Skills/algorithmic-art"), "Algorithmic Art");
  assert.equal(cleanSkillName("Artifacts"), "Artifacts");
});

test("OWUI cleanSkillName uppercases acronyms to match the agents side", () => {
  const { cleanSkillName } = loadOwui();
  // Matches electron-app applySkillDisplayAcronyms (Mcp/Api/Url/Ui/Ai/Id/Lm).
  assert.equal(cleanSkillName("mcp_bridge_setup"), "MCP Bridge Setup");
  assert.equal(cleanSkillName("api-gateway"), "API Gateway");
  assert.equal(cleanSkillName("ui-review"), "UI Review");
});
