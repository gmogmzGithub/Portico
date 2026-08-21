const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  resolveMcpServerDisplayName,
} = require("./mcp-server-display-name");

function writeServerYaml(projectRoot, directory, serverId, content) {
  const serverDirectory = path.join(projectRoot, directory, serverId);
  fs.mkdirSync(serverDirectory, { recursive: true });
  fs.writeFileSync(path.join(serverDirectory, `${serverId}.yaml`), content);
}

test("MCP display names prefer display_name, then name, then the server ID", (t) => {
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "portico-mcp-display-name-"),
  );
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

  writeServerYaml(
    projectRoot,
    "mcp-configs",
    "mcp-atlassian",
    'display_name: "Atlassian"\nname: "Ignored Name"\n',
  );
  writeServerYaml(
    projectRoot,
    "mcp-configs-user",
    "custom-server",
    'name: "Custom Server"\n',
  );

  assert.equal(
    resolveMcpServerDisplayName(projectRoot, "mcp-atlassian"),
    "Atlassian",
  );
  assert.equal(
    resolveMcpServerDisplayName(projectRoot, "custom-server"),
    "Custom Server",
  );
  assert.equal(
    resolveMcpServerDisplayName(projectRoot, "missing-server"),
    "missing-server",
  );
});

test("invalid MCP metadata falls back to the server ID", (t) => {
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "portico-mcp-display-name-invalid-"),
  );
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  writeServerYaml(
    projectRoot,
    "mcp-configs",
    "broken-server",
    "display_name: [unterminated\n",
  );
  const warnings = [];

  assert.equal(
    resolveMcpServerDisplayName(projectRoot, "broken-server", {
      logger: { warn: (message) => warnings.push(message) },
    }),
    "broken-server",
  );
  assert.equal(warnings.length, 1);
});

test("a system MCP directory reserves display-name precedence when incomplete", (t) => {
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "portico-mcp-display-name-collision-"),
  );
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(projectRoot, "mcp-configs", "collision-mcp"), {
    recursive: true,
  });
  writeServerYaml(
    projectRoot,
    "mcp-configs-user",
    "collision-mcp",
    'display_name: "User must not leak"\n',
  );

  assert.equal(
    resolveMcpServerDisplayName(projectRoot, "collision-mcp"),
    "collision-mcp",
  );
});
