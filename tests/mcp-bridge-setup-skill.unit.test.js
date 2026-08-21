const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SKILL_PATH = path.join(ROOT, "skills", "mcp-bridge-setup", "SKILL.md");

test("MCP bridge setup skill redirects to app-managed auto-config", () => {
  const content = fs.readFileSync(SKILL_PATH, "utf8");

  assert.match(content, /author:\s+Adam Ullrich/);
  assert.match(content, /mcp_assistant_get_host_mcp_bridge_status/);
  assert.match(content, /mcp_assistant_configure_host_mcp_bridge_clients/);
  assert.match(content, /confirm: true/);
  assert.match(content, /Always pass `client_ids`/);
  assert.match(content, /exact detected supported client ids returned by status/);
  assert.match(content, /cog button/);
  assert.match(content, /per-client bearer tokens behind the scenes/);
  assert.match(content, /Atlas Code, Atlas Desktop, Workbench, Cursor, and Amp/);
  assert.match(content, /Windsurf is not supported/);
  assert.match(content, /Operational Questions/);
  assert.match(content, /bridge is healthy/);
  assert.match(content, /enable_bridge/);
  assert.match(content, /which clients are configured/);
  assert.match(content, /rerun `setup-community\/run-mcp-servers`/);
  assert.doesNotMatch(content, /127\.0\.0\.1:8891\/mcp/);
  assert.doesNotMatch(content, /atlas mcp add/i);
  assert.doesNotMatch(content, /"Authorization"/);
  assert.doesNotMatch(content, /portico_mcp_/);
  assert.doesNotMatch(content, /\bwrapper\b/i);
  assert.doesNotMatch(content, /portico-mcp-bridge\.sh/i);
});
