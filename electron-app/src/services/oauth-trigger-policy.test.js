const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getOAuthTriggerDisposition,
  runtimeReadinessIndicatesOAuth,
  serverUsesOAuthConfig,
} = require("./oauth-trigger-policy");

test("serverUsesOAuthConfig accepts parsed oauth metadata", () => {
  const result = serverUsesOAuthConfig("portico-taxonomy", {
    findServerYaml() {
      return "/tmp/portico-taxonomy.yaml";
    },
    readFileSync() {
      return "id: portico-taxonomy\noauth:\n  server_url: https://example.test\n";
    },
    parseYaml() {
      return {
        id: "portico-taxonomy",
        oauth: {
          server_url: "https://example.test",
        },
      };
    },
    logger: { warn() {} },
  });

  assert.equal(result, true);
});

test("serverUsesOAuthConfig accepts OAuth metadata from sibling fragment", () => {
  const result = serverUsesOAuthConfig("slack-official", {
    findServerYaml() {
      return "/tmp/slack-official/slack-official.yaml";
    },
    readFileSync(filePath) {
      if (filePath.endsWith(".yaml")) {
        return "id: slack-official\nname: Slack Official\n";
      }
      return JSON.stringify({
        type: "streamable-http",
        url: "https://mcp.slack.com/mcp",
        oauth: {
          server_url: "https://mcp.slack.com",
          client_id: "2317524819.11152506261415",
        },
      });
    },
    existsSync(filePath) {
      return filePath === "/tmp/slack-official/slack-official.fragment";
    },
    getFragmentPathForServerYaml(yamlPath, serverId) {
      assert.equal(yamlPath, "/tmp/slack-official/slack-official.yaml");
      assert.equal(serverId, "slack-official");
      return "/tmp/slack-official/slack-official.fragment";
    },
    parseYaml() {
      return {
        id: "slack-official",
      };
    },
    logger: { warn() {} },
  });

  assert.equal(result, true);
});

test("runtimeReadinessIndicatesOAuth trusts canonical readiness for dynamic OAuth servers", () => {
  assert.equal(
    runtimeReadinessIndicatesOAuth({
      readinessPhase: "needs_oauth",
      authorizationUrlAvailable: true,
      oauthState: "active",
    }),
    true,
  );
});

test("getOAuthTriggerDisposition allows OAuth when runtime readiness requires it", () => {
  const result = getOAuthTriggerDisposition({
    hasStaticOAuthConfig: false,
    readinessStatus: {
      readinessPhase: "needs_oauth",
      authorizationUrlAvailable: true,
      oauthState: "active",
    },
    forceAuth: false,
  });

  assert.deepEqual(result, {
    type: "allowed",
    readinessPhase: "needs_oauth",
  });
});

test("getOAuthTriggerDisposition rejects token-only servers without OAuth signals", () => {
  const result = getOAuthTriggerDisposition({
    hasStaticOAuthConfig: false,
    readinessStatus: {
      readinessPhase: "starting",
      authorizationUrlAvailable: false,
      oauthState: null,
    },
    forceAuth: false,
  });

  assert.deepEqual(result, {
    type: "not_oauth",
    readinessPhase: "starting",
  });
});

test("getOAuthTriggerDisposition short-circuits tool-ready servers when forceAuth is false", () => {
  const result = getOAuthTriggerDisposition({
    hasStaticOAuthConfig: true,
    readinessStatus: {
      readinessPhase: "tool_ready",
      healthy: true,
    },
    forceAuth: false,
    hasUsablePersistedOAuthTokens: true,
  });

  assert.deepEqual(result, {
    type: "already_authorized",
    readinessPhase: "tool_ready",
  });
});

test("getOAuthTriggerDisposition allows OAuth when tool-ready server lacks usable persisted tokens", () => {
  const result = getOAuthTriggerDisposition({
    hasStaticOAuthConfig: true,
    readinessStatus: {
      readinessPhase: "tool_ready",
      healthy: true,
    },
    forceAuth: false,
    hasUsablePersistedOAuthTokens: false,
  });

  assert.deepEqual(result, {
    type: "allowed",
    readinessPhase: "tool_ready",
  });
});

test("getOAuthTriggerDisposition treats the legacy healthy phase as already authorized", () => {
  const result = getOAuthTriggerDisposition({
    hasStaticOAuthConfig: true,
    readinessStatus: {
      readinessPhase: "healthy",
      healthy: true,
    },
    forceAuth: false,
  });

  assert.deepEqual(result, {
    type: "already_authorized",
    readinessPhase: "tool_ready",
  });
});

test("getOAuthTriggerDisposition still rejects disabled servers before OAuth checks", () => {
  const result = getOAuthTriggerDisposition({
    hasStaticOAuthConfig: true,
    readinessStatus: {
      readinessPhase: "disabled",
      healthy: false,
    },
    forceAuth: true,
  });

  assert.deepEqual(result, {
    type: "disabled",
    readinessPhase: "disabled",
  });
});
