const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { build } = require("../electron-app/node_modules/esbuild");

const REPO_ROOT = path.resolve(__dirname, "..");

let tempDir;
let registryUtils;

const bundleModule = async (entryPath, outFile) => {
  await build({
    entryPoints: [path.join(REPO_ROOT, entryPath)],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: ["node20"],
    logLevel: "silent",
    outfile: outFile,
  });

  return require(outFile);
};

before(async () => {
  tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "mcp-server-id-registry-tests-"),
  );
  registryUtils = await bundleModule(
    "src/patches/frontend/src/lib/utils/mcpServerIdRegistry.ts",
    path.join(tempDir, "mcpServerIdRegistry.cjs"),
  );
});

after(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("formatToolDisplayName strips the MCP server prefix once the server id is known", () => {
  assert.equal(
    registryUtils.formatToolDisplayName(
      "portico_incident_data_search_incidents",
      "portico-incident-data",
    ),
    "Search Incidents",
  );
});

test("formatToolDisplayName preserves LM Studio acronym casing", () => {
  assert.equal(
    registryUtils.formatToolDisplayName("subagents_get_lm_studio_status", "subagents"),
    "Get LM Studio Status",
  );
  assert.equal(
    registryUtils.formatToolDisplayName("subagents_configure_lm_studio", "subagents"),
    "Configure LM Studio",
  );
});

test("Electron tool config formatter preserves LM Studio acronym casing", async () => {
  const source = await fs.readFile(
    path.join(REPO_ROOT, "electron-app/src/renderer/components/tool-config-modal.js"),
    "utf8",
  );

  assert.match(source, /const FULL_CAPS_WORDS = \[[\s\S]*"lm"[\s\S]*\]/);
});

test("extractServerIdFromToolName prefers the longest matching MCP server prefix", () => {
  assert.equal(
    registryUtils.extractServerIdFromToolName("agent_vm_bash", [
      "agent",
      "agent-vm",
    ]),
    "agent-vm",
  );
});

test("catalog normalization preserves display names while the legacy ID view stays stable", () => {
  const catalog = registryUtils.normalizeServerCatalog([
    { id: "google_workspace", display_name: "Google Workspace" },
    { id: "mcp-atlassian", display_name: "Atlassian" },
  ]);

  assert.deepEqual(catalog, [
    { id: "google_workspace", display_name: "Google Workspace" },
    { id: "mcp-atlassian", display_name: "Atlassian" },
  ]);
  assert.deepEqual(registryUtils.normalizeServerIds(catalog), [
    "google_workspace",
    "mcp-atlassian",
  ]);
});

test("registry publishes catalog metadata without changing refresh return values", async () => {
  const registry = registryUtils.createMcpServerIdRegistry(async () => [
    { id: "google_workspace", display_name: "Google Workspace" },
  ]);
  let observedCatalog = [];
  const unsubscribe = registry.subscribeCatalog((catalog) => {
    observedCatalog = catalog;
  });

  assert.deepEqual(await registry.refresh(), ["google_workspace"]);
  assert.deepEqual(registry.getSnapshot(), ["google_workspace"]);
  assert.deepEqual(registry.getCatalogSnapshot(), [
    { id: "google_workspace", display_name: "Google Workspace" },
  ]);
  assert.deepEqual(observedCatalog, registry.getCatalogSnapshot());
  unsubscribe();
});

test("registry refreshes when a new MCP server appears after the first snapshot", async () => {
  let callCount = 0;
  const registry = registryUtils.createMcpServerIdRegistry(async () => {
    callCount += 1;
    if (callCount === 1) {
      return ["agent-vm"];
    }
    return ["agent-vm", "portico-incident-data"];
  });

  assert.deepEqual(await registry.refresh(), ["agent-vm"]);
  assert.equal(
    registryUtils.extractServerIdFromToolName(
      "portico_incident_data_search_incidents",
      registry.getSnapshot(),
    ),
    null,
  );

  await registry.ensureForToolName("portico_incident_data_search_incidents");

  assert.equal(callCount, 2);
  assert.equal(
    registryUtils.extractServerIdFromToolName(
      "portico_incident_data_search_incidents",
      registry.getSnapshot(),
    ),
    "portico-incident-data",
  );
});

test("registry refreshes when a required MCP server id is missing from cache", async () => {
  let callCount = 0;
  const registry = registryUtils.createMcpServerIdRegistry(async () => {
    callCount += 1;
    return callCount === 1
      ? ["web-tools"]
      : ["web-tools", "portico-incident-data"];
  });

  await registry.refresh();
  await registry.ensureKnownServerIds(["portico-incident-data"]);

  assert.equal(callCount, 2);
  assert.deepEqual(registry.getSnapshot(), [
    "web-tools",
    "portico-incident-data",
  ]);
});
