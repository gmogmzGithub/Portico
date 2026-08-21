const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { listMcpServerCatalog } = require("./mcp-server-catalog");

test("MCP service catalog reads configured display names and falls back safely", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-server-catalog-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));

  await fs.mkdir(path.join(projectRoot, "mcp-configs", "google_workspace"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(
      projectRoot,
      "mcp-configs",
      "google_workspace",
      "google_workspace.yaml",
    ),
    'name: "Google Workspace MCP Server"\ndisplay_name: "Google Workspace"\n',
  );
  await fs.mkdir(path.join(projectRoot, "mcp-configs-user", "custom-service"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(
      projectRoot,
      "mcp-configs-user",
      "custom-service",
      "custom-service.fragment",
    ),
    "not: valid: yaml",
  );

  assert.deepEqual(await listMcpServerCatalog(projectRoot), [
    { id: "google_workspace", display_name: "Google Workspace" },
    { id: "custom-service", display_name: "custom-service" },
  ]);
});

test("API keeps the IDs-only route and exposes an additive catalog route", async () => {
  const source = await fs.readFile(path.join(__dirname, "api.js"), "utf8");
  assert.match(source, /apiApp\.get\('\/api\/mcp\/servers'/);
  assert.match(source, /catalog\.map\(\(server\) => server\.id\)/);
  assert.match(source, /apiApp\.get\('\/api\/mcp\/servers\/catalog'/);
  assert.match(source, /listMcpServerCatalog\(bootstrap\.PROJECT_ROOT\)/);
});

test("MCP service catalog never falls through an incomplete system collision", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-server-catalog-collision-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));

  await fs.mkdir(path.join(projectRoot, "mcp-configs", "collision-mcp"), {
    recursive: true,
  });
  await fs.mkdir(path.join(projectRoot, "mcp-configs-user", "collision-mcp"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(
      projectRoot,
      "mcp-configs-user",
      "collision-mcp",
      "collision-mcp.yaml",
    ),
    'display_name: "User must not leak"\n',
  );

  assert.deepEqual(await listMcpServerCatalog(projectRoot), []);
});
