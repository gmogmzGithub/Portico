const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  buildStartupFailureResult,
  ensureBulkResultsForRequested,
  extractAttributedServerFailure,
  getFragmentPathForServerYaml,
} = require("./mcp-bulk-toggle-results");

test("extractAttributedServerFailure attributes invalid fragment errors by path", () => {
  const projectRoot = "/Users/dsantiago/portico/open-webui-mcp";
  const errorText = [
    "Command failed: mcp-orc generate-docker-compose-override",
    "  x Invalid JSON in fragment for beta-mcp",
    `Error: invalid JSON in ${projectRoot}/mcp-configs-user/beta-mcp/beta-mcp.fragment: trailing comma at line 8 column 3`,
  ].join("\n");

  const attribution = extractAttributedServerFailure(errorText, projectRoot);
  assert.deepEqual(attribution, {
    serverId: "beta-mcp",
    error: errorText,
    configPath: `${projectRoot}/mcp-configs-user/beta-mcp/beta-mcp.fragment`,
  });
});

test("extractAttributedServerFailure attributes direct invalid-fragment text", () => {
  const attribution = extractAttributedServerFailure(
    "Invalid JSON in fragment for beta-mcp: trailing comma at line 8 column 3",
    "/tmp/project",
  );
  assert.equal(attribution.serverId, "beta-mcp");
  assert.equal(attribution.configPath, null);
});

test("ensureBulkResultsForRequested fills missing per-server failures", () => {
  const results = ensureBulkResultsForRequested(
    ["alpha-mcp", "beta-mcp"],
    [{ serverId: "alpha-mcp", success: true, mode: "docker" }],
    {
      error: "Config regeneration failed",
      stage: "config_generation",
      source: "config",
      errorCode: "CONFIG_GENERATION_FAILED",
    },
  );

  assert.equal(results.length, 2);
  assert.deepEqual(results[0], {
    serverId: "alpha-mcp",
    success: true,
    mode: "docker",
  });
  assert.equal(results[1].serverId, "beta-mcp");
  assert.equal(results[1].success, false);
  assert.equal(results[1].stage, "config_generation");
  assert.equal(results[1].source, "config");
  assert.equal(results[1].startupFailure.error, "Config regeneration failed");
});

test("buildStartupFailureResult preserves exact error and metadata", () => {
  const result = buildStartupFailureResult(
    "beta-mcp",
    "Invalid JSON in fragment for beta-mcp: trailing comma at line 8 column 3",
    {
      stage: "config_generation",
      source: "config",
      errorCode: "INVALID_FRAGMENT_JSON",
      configPath: "/tmp/project/mcp-configs-user/beta-mcp/beta-mcp.fragment",
    },
  );

  assert.equal(result.success, false);
  assert.equal(result.errorCode, "INVALID_FRAGMENT_JSON");
  assert.equal(result.error, result.startupFailure.error);
  assert.equal(result.startupFailure.stage, "config_generation");
  assert.equal(result.startupFailure.source, "config");
  assert.equal(
    result.startupFailure.configPath,
    "/tmp/project/mcp-configs-user/beta-mcp/beta-mcp.fragment",
  );
});

test("getFragmentPathForServerYaml uses sibling fragment path", () => {
  assert.equal(
    getFragmentPathForServerYaml(
      path.join("/tmp/project/mcp-configs-user/alpha-mcp", "alpha-mcp.yaml"),
      "alpha-mcp",
    ),
    path.join("/tmp/project/mcp-configs-user/alpha-mcp", "alpha-mcp.fragment"),
  );
});
