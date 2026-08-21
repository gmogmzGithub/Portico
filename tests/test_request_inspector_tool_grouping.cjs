const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { build } = require("../electron-app/node_modules/esbuild");

const REPO_ROOT = path.resolve(__dirname, "..");

let tempDir;
let toolGrouping;

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
    path.join(os.tmpdir(), "request-inspector-tool-grouping-tests-"),
  );
  toolGrouping = await bundleModule(
    "llm-debug-monitor/src/components/RequestInspector/toolGrouping.ts",
    path.join(tempDir, "toolGrouping.cjs"),
  );
});

after(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("request tool ids group MCP tools under their server even when chat capabilities are stale", () => {
  const groups = toolGrouping.buildToolServerGroups({
    tools: [
      {
        type: "function",
        function: {
          name: "portico_incident_data_search_incidents",
          description: "Search incidents",
          parameters: { type: "object" },
        },
      },
    ],
    activeServers: [],
    requestToolIds: ["server:portico-incident-data"],
  });

  assert.equal(groups.length, 1);
  assert.equal(groups[0].serverId, "portico-incident-data");
  assert.equal(groups[0].displayName, "Portico Incident Data");
  assert.equal(
    groups[0].tools[0].function.name,
    "portico_incident_data_search_incidents",
  );
});

test("namespace metadata groups request tools without falling back to Other Tools", () => {
  const groups = toolGrouping.buildToolServerGroups({
    tools: [
      {
        type: "function",
        function: {
          name: "glean_search",
          description: "Search KB",
          parameters: { type: "object" },
        },
      },
    ],
    activeServers: [],
    rawPayload: {
      _tool_namespaces: {
        glean: {
          server_id: "glean",
          description: "Knowledge Base",
          is_core: false,
        },
      },
    },
  });

  assert.equal(groups.length, 1);
  assert.equal(groups[0].serverId, "glean");
  assert.equal(groups[0].namespaceKey, "glean");
  assert.equal(groups[0].displayName, "Glean");
});

test("request tool ids group google workspace and agent vm tools even when active chat capabilities are stale", () => {
  const groups = toolGrouping.buildToolServerGroups({
    tools: [
      {
        type: "function",
        function: {
          name: "google_workspace_get_events",
          description: "Get events",
          parameters: { type: "object" },
        },
      },
      {
        type: "function",
        function: {
          name: "agent_vm_bash",
          description: "Run bash",
          parameters: { type: "object" },
        },
      },
    ],
    activeServers: [
      {
        server_id: "mcp-assistant",
        display_name: "MCP Assistant",
        icon_url: "/icons/mcp-assistant.png",
        is_core: true,
      },
      {
        server_id: "skills",
        display_name: "Skills",
        icon_url: "/icons/skills.png",
        is_core: true,
      },
      {
        server_id: "subagents",
        display_name: "Subagents",
        icon_url: "/icons/subagents.png",
        is_core: true,
      },
    ],
    requestToolIds: [
      "server:mcp-assistant",
      "server:skills",
      "server:subagents",
      "server:google_workspace",
      "server:agent-vm",
    ],
  });

  assert.equal(groups.map((group) => group.serverId).includes("google_workspace"), true);
  assert.equal(groups.map((group) => group.serverId).includes("agent-vm"), true);
  assert.equal(groups.some((group) => group.displayName === "Other Tools"), false);
});

test("unknown tools still fall back to Other Tools when no request-scoped mapping exists", () => {
  const groups = toolGrouping.buildToolServerGroups({
    tools: [
      {
        type: "function",
        function: {
          name: "totally_unknown_tool_name",
          description: "Mystery tool",
          parameters: { type: "object" },
        },
      },
    ],
    activeServers: [],
    requestToolIds: [],
  });

  assert.equal(groups.length, 1);
  assert.equal(groups[0].serverId, "_unknown");
  assert.equal(groups[0].displayName, "Other Tools");
});
