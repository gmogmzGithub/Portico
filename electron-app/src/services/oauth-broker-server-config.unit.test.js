const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  GENERATED_OAUTH_CONFIG_UNAVAILABLE,
  loadGeneratedMcpServerConfig,
  prepareOAuthBrokerServerConfig,
  supportsChallengeDiscoveredOAuth,
} = require("./oauth-broker-server-config");

function withGeneratedConfig(serverId, serverConfig, callback) {
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "oauth-broker-server-config-"),
  );
  const generatedDir = path.join(projectRoot, "mcpo-configs-generated");
  fs.mkdirSync(generatedDir, { recursive: true });
  const configPath = path.join(generatedDir, `${serverId}.json`);
  fs.writeFileSync(
    configPath,
    JSON.stringify({ mcpServers: { [serverId]: serverConfig } }),
  );
  try {
    return callback({ projectRoot, configPath });
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

test("broker synthesizes memory OAuth metadata for challenge-discovered streamable HTTP", () => {
  const serverId = "productkit-mcp";
  const fragment = {
    type: "streamable-http",
    url: "https://assumeapi.sandbox.example.invalid/mcp/product",
  };

  withGeneratedConfig(serverId, fragment, ({ projectRoot, configPath }) => {
    const prepared = loadGeneratedMcpServerConfig(serverId, projectRoot);

    assert.deepEqual(prepared, {
      ...fragment,
      oauth: {},
    });
    assert.deepEqual(
      JSON.parse(fs.readFileSync(configPath, "utf8")).mcpServers[serverId],
      fragment,
      "broker preparation must not rewrite generated or user configuration",
    );
  });
});

test("broker preserves explicit OAuth metadata", () => {
  const config = {
    type: "streamable-http",
    url: "https://example.test/mcp",
    oauth: { server_url: "https://auth.example.test" },
  };
  assert.equal(prepareOAuthBrokerServerConfig(config), config);
});

test("challenge-discovered OAuth classification mirrors Rust and shell transport aliases", () => {
  for (const config of [
    { type: "streamable-http" },
    { type: "streamable_http" },
    { type: "streamablehttp" },
    { type: "  streamable-http  " },
    { type: "sse" },
    { http_subprocess: {} },
  ]) {
    assert.equal(supportsChallengeDiscoveredOAuth(config), true);
  }

  for (const config of [
    {},
    { type: null, http_subprocess: null },
    { type: 42 },
    { type: "Streamable-HTTP" },
    { type: "stdio" },
  ]) {
    assert.equal(supportsChallengeDiscoveredOAuth(config), false);
  }
});

test("broker still fails closed for configs that cannot use OAuth", () => {
  withGeneratedConfig(
    "plain-stdio",
    { type: "stdio", command: "node", args: ["server.js"] },
    ({ projectRoot }) => {
      assert.throws(
        () => loadGeneratedMcpServerConfig("plain-stdio", projectRoot),
        new RegExp(GENERATED_OAUTH_CONFIG_UNAVAILABLE),
      );
    },
  );
});
