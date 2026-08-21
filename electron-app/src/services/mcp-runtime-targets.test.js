const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeServerIds,
  groupDockerRuntimeTargets,
  buildAggregatorInvalidationScope,
} = require("./mcp-runtime-targets");

test("normalizeServerIds deduplicates and trims valid ids", () => {
  assert.deepEqual(
    normalizeServerIds([
      " slack ",
      "gitlab-mcp",
      "slack",
      "",
      null,
      "gitlab-mcp",
    ]),
    ["slack", "gitlab-mcp"],
  );
});

test("groupDockerRuntimeTargets groups multiple servers that share a container", () => {
  const targets = groupDockerRuntimeTargets(
    ["skills", "subagents", "slack"],
    (serverId) => {
      if (serverId === "slack") {
        return {
          composeService: "mcpo-slack",
          containerName: "mcpo-slack",
          deploymentScope: "docker",
        };
      }

      return {
        composeService: "mcpo-group-core",
        containerName: "mcpo-group-core",
        deploymentScope: "core",
        groupId: "core",
        grouped: true,
      };
    },
  );

  assert.deepEqual(targets, [
    {
      composeService: "mcpo-group-core",
      containerName: "mcpo-group-core",
      deploymentScope: "core",
      groupId: "core",
      grouped: true,
      serverIds: ["skills", "subagents"],
    },
    {
      composeService: "mcpo-slack",
      containerName: "mcpo-slack",
      deploymentScope: "docker",
      groupId: null,
      grouped: false,
      serverIds: ["slack"],
    },
  ]);
});

test("buildAggregatorInvalidationScope separates regular and core targets", () => {
  assert.deepEqual(
    buildAggregatorInvalidationScope([
      { deploymentScope: "docker" },
      { deploymentScope: "core" },
    ]),
    { includeRegular: true, includeCore: true },
  );

  assert.deepEqual(
    buildAggregatorInvalidationScope([{ deploymentScope: "core" }]),
    { includeRegular: false, includeCore: true },
  );

  assert.deepEqual(
    buildAggregatorInvalidationScope([{ deploymentScope: "docker" }]),
    { includeRegular: true, includeCore: false },
  );
});
