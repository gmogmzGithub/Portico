const test = require("node:test");
const assert = require("node:assert/strict");

const {
  COMPONENT_BRIDGE,
  COMPONENT_HOST_MCPO,
  buildKnownProcessGroups,
  classifyCallbackPortOwners,
  ensureReservedCallbackPortAvailable,
  formatCallbackPortOwners,
  inspectCallbackPortOwners,
  parseListeningProcessIds,
  safeCommandLabel,
} = require("./single-server-callback-port");

test("callback-port inspection parses unique listener PIDs and process groups", async () => {
  assert.deepEqual(parseListeningProcessIds("42\n42\n77\nnot-a-pid\n"), [42, 77]);

  const responses = new Map([
    ["lsof", "42\n"],
    ["pgid", " 40\n"],
    ["command", "/usr/local/bin/mcp-orc bridge --port 8891 --token secret-value\n"],
  ]);
  const owners = await inspectCallbackPortOwners(3836, {
    exec: async (command) => {
      if (command.startsWith("lsof")) return { stdout: responses.get("lsof") };
      if (command.includes("pgid=")) return { stdout: responses.get("pgid") };
      return { stdout: responses.get("command") };
    },
  });

  assert.deepEqual(owners, [
    {
      pid: 42,
      pgid: 40,
      command: "/usr/local/bin/mcp-orc bridge --port 8891 --token secret-value",
    },
  ]);
});

test("callback-port ownership recovers only verified app process groups", () => {
  const groups = buildKnownProcessGroups({
    projectRoot: "/managed/runtime",
    bridgePid: 40,
    hostMcpoPid: 80,
    readFileSync: () => {
      throw new Error("missing");
    },
  });
  const classified = classifyCallbackPortOwners(
    [
      {
        pid: 42,
        pgid: 40,
        command: "/usr/local/bin/mcp-orc bridge --port 8891",
      },
      {
        pid: 81,
        pgid: 80,
        command: "/usr/local/bin/mcp-orc --port 8890 --config mcp_config_host_sideload.json",
      },
      {
        pid: 99,
        pgid: 99,
        command: "/usr/local/bin/mcp-orc bridge --port 9999",
      },
    ],
    groups,
  );

  assert.equal(classified[0].component, COMPONENT_BRIDGE);
  assert.equal(classified[0].recoverable, true);
  assert.equal(classified[1].component, COMPONENT_HOST_MCPO);
  assert.equal(classified[1].recoverable, true);
  assert.equal(classified[2].component, null);
  assert.equal(classified[2].recoverable, false);
});

test("callback-port diagnostics never include command arguments", () => {
  const owner = {
    pid: 42,
    pgid: 40,
    component: COMPONENT_BRIDGE,
    command: "/usr/local/bin/mcp-orc bridge --token top-secret",
    commandLabel: safeCommandLabel(
      "/usr/local/bin/mcp-orc bridge --token top-secret",
    ),
  };
  const message = formatCallbackPortOwners(3836, [owner]);

  assert.match(message, /pid=42/);
  assert.match(message, /command=mcp-orc bridge/);
  assert.doesNotMatch(message, /top-secret|--token/);
});

test("reserved callback port remains available while the bridge is running", async () => {
  let inspected = false;
  let recovered = false;
  const result = await ensureReservedCallbackPortAvailable({
    port: 3836,
    isPortAvailable: async () => true,
    inspectOwners: async () => {
      inspected = true;
      return [];
    },
    recoverComponent: async () => {
      recovered = true;
      return { success: true };
    },
  });

  assert.deepEqual(result, { success: true, recovered: false, owners: [] });
  assert.equal(inspected, false);
  assert.equal(recovered, false);
});

test("reserved callback port recovers a verified stale app-owned bridge", async () => {
  let availableChecks = 0;
  const recovered = [];
  const owners = [
    {
      pid: 42,
      pgid: 40,
      component: COMPONENT_BRIDGE,
      recoverable: true,
      commandLabel: "mcp-orc bridge",
    },
  ];
  const result = await ensureReservedCallbackPortAvailable({
    port: 3836,
    isPortAvailable: async () => ++availableChecks > 1,
    inspectOwners: async () => owners,
    recoverComponent: async (component) => {
      recovered.push(component);
      return { success: true };
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.recovered, true);
  assert.deepEqual(recovered, [COMPONENT_BRIDGE]);
});

test("reserved callback port fails closed for an external listener", async () => {
  let recoveryCalls = 0;
  const result = await ensureReservedCallbackPortAvailable({
    port: 3836,
    isPortAvailable: async () => false,
    inspectOwners: async () => [
      {
        pid: 99,
        pgid: 99,
        component: null,
        recoverable: false,
        commandLabel: "external-server",
      },
    ],
    recoverComponent: async () => {
      recoveryCalls += 1;
      return { success: true };
    },
  });

  assert.equal(result.success, false);
  assert.match(result.error, /did not stop the process/);
  assert.match(result.error, /pid=99/);
  assert.equal(recoveryCalls, 0);
});
