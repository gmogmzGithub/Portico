const test = require("node:test");
const assert = require("node:assert/strict");

const {
  cleanupOrphanedSingleServerStack,
  inferSingleServerId,
  parseContainerNames,
} = require("./single-server-stack-lifecycle");

test("single-server lifecycle parses and identifies the app-owned server container", () => {
  const names = parseContainerNames(
    "mcpo-single-nginx\nmcpo-single-data-plat-mcp\nmcpo-single-nginx\n",
  );

  assert.deepEqual(names, [
    "mcpo-single-nginx",
    "mcpo-single-data-plat-mcp",
  ]);
  assert.equal(
    inferSingleServerId(names, "datadog"),
    "data-plat-mcp",
  );
});

test("single-server lifecycle leaves the runtime untouched when no orphan exists", async () => {
  const commands = [];
  const result = await cleanupOrphanedSingleServerStack({
    exec: async (command) => {
      commands.push(command);
      return { stdout: "" };
    },
    projectRoot: "/managed/runtime",
    scriptPath: "/managed/runtime/src/scripts/start-single-mcp-server.sh",
    requestedServerId: "datadog",
  });

  assert.deepEqual(result, { cleaned: false, containerNames: [] });
  assert.equal(commands.length, 1);
  assert.match(commands[0], /com\.docker\.compose\.project=portico-single/);
});

test("single-server lifecycle removes and verifies an abandoned prior integration stack", async () => {
  const commands = [];
  const snapshots = [
    ["mcpo-single-nginx", "mcpo-single-data-plat-mcp"],
    [],
  ];

  const result = await cleanupOrphanedSingleServerStack({
    exec: async (command) => {
      commands.push(command);
      return { stdout: "" };
    },
    projectRoot: "/managed/runtime",
    scriptPath: "/managed/runtime/src/scripts/start-single-mcp-server.sh",
    requestedServerId: "datadog",
    listContainers: async () => snapshots.shift(),
  });

  assert.equal(result.cleaned, true);
  assert.equal(result.orphanedServerId, "data-plat-mcp");
  assert.equal(commands.length, 1);
  assert.match(commands[0], /data-plat-mcp.*--stop$/);
  assert.doesNotMatch(commands[0], /datadog/);
});

test("single-server lifecycle fails when app-owned containers survive cleanup", async () => {
  const snapshots = [
    ["mcpo-single-nginx", "mcpo-single-data-plat-mcp"],
    ["mcpo-single-nginx"],
  ];

  await assert.rejects(
    cleanupOrphanedSingleServerStack({
      exec: async () => ({ stdout: "" }),
      projectRoot: "/managed/runtime",
      scriptPath: "/managed/runtime/src/scripts/start-single-mcp-server.sh",
      requestedServerId: "datadog",
      listContainers: async () => snapshots.shift(),
    }),
    /Unable to remove the abandoned Portico single-server stack/,
  );
});
