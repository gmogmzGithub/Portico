const test = require("node:test");
const assert = require("node:assert/strict");

const { buildAutoHealRestartGroups } = require("./auto-heal-planner");

test("buildAutoHealRestartGroups batches host servers into a single restart", () => {
  const groups = buildAutoHealRestartGroups([
    {
      serverId: "chrome-devtools",
      serverInfo: { deployment: "host" },
      nextAttempt: 1,
    },
    {
      serverId: "local-shell",
      serverInfo: { deployment: "host" },
      nextAttempt: 1,
    },
    {
      serverId: "datadog",
      serverInfo: { deployment: "docker" },
      nextAttempt: 1,
    },
  ]);

  assert.equal(groups.length, 2);
  assert.equal(groups[0].kind, "host");
  assert.deepEqual(groups[0].serverIds, ["chrome-devtools", "local-shell"]);
  assert.equal(groups[1].kind, "server");
  assert.deepEqual(groups[1].serverIds, ["datadog"]);
});

test("buildAutoHealRestartGroups ignores malformed candidates", () => {
  const groups = buildAutoHealRestartGroups([
    null,
    {},
    { serverInfo: { deployment: "host" } },
    { serverId: "time", serverInfo: { deployment: "docker" } },
  ]);

  assert.deepEqual(groups, [
    {
      kind: "server",
      candidates: [{ serverId: "time", serverInfo: { deployment: "docker" } }],
      serverIds: ["time"],
    },
  ]);
});
