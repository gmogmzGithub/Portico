const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPOSITORY_ROOT = path.resolve(__dirname, "../../..");
const SYSTEM_SKILLS_ROOT = path.join(REPOSITORY_ROOT, "skills");
const OOTB_MARKETPLACE_ROOT = path.join(
  REPOSITORY_ROOT,
  "marketplaces-ootb",
);
const SKILL_ID = "using-zoom";

function readSkill(skillId) {
  return fs.readFileSync(
    path.join(SYSTEM_SKILLS_ROOT, skillId, "SKILL.md"),
    "utf8",
  );
}

test("Zoom is a built-in Glean-backed PORTICO skill", () => {
  const skillMarkdown = readSkill(SKILL_ID);
  const bridgeHeading = "## Using from the MCP bridge";
  const bridgeHeadingIndex = skillMarkdown.indexOf(bridgeHeading);

  assert.match(skillMarkdown, new RegExp(`^name: ${SKILL_ID}$`, "m"));
  assert.match(skillMarkdown, /^license: Proprietary$/m);
  assert.match(skillMarkdown, /^compatibility: Portico$/m);
  assert.match(skillMarkdown, /priority: high/);
  assert.match(skillMarkdown, /required_mcp_servers:\n  - "server:glean"/);
  assert.match(skillMarkdown, /requires the Glean MCP server/);
  assert.ok(skillMarkdown.includes("glean_zoom_mcp_*"));
  assert.ok(bridgeHeadingIndex > 0);
  assert.ok(
    skillMarkdown.indexOf("glean_zoom_mcp_*") < bridgeHeadingIndex,
    "using-zoom must present direct PORTICO tools before bridge guidance",
  );
  assert.ok(
    skillMarkdown.slice(bridgeHeadingIndex).includes("glean__zoom_mcp_*"),
  );
  assert.ok(
    !skillMarkdown.slice(0, bridgeHeadingIndex).includes("find_relevant_tools"),
    "using-zoom must not make Host MCP Bridge discovery the primary workflow",
  );
});

test("built-in Zoom guidance covers meeting-to-recording workflows", () => {
  const zoom = readSkill("using-zoom");

  for (const expected of [
    "glean_zoom_mcp_search_meetings",
    "glean_zoom_mcp_get_meeting_assets",
    "glean_zoom_mcp_get_recording_resource",
    "meeting_uuid",
    "transcript",
    "summary",
    "nextStep",
    "play_time",
  ]) {
    assert.ok(zoom.includes(expected), `Zoom skill must include ${expected}`);
  }
});

test("only the system Zoom integration skill remains shipped", () => {
  const marketplaceConfig = fs.readFileSync(
    path.join(OOTB_MARKETPLACE_ROOT, "marketplaces.json"),
    "utf8",
  );

  for (const skillId of ["using-zoom", "using-asana"]) {
    assert.ok(!marketplaceConfig.includes(skillId));
  }
  assert.equal(
    fs.existsSync(path.join(SYSTEM_SKILLS_ROOT, "using-asana", "SKILL.md")),
    false,
  );
});
