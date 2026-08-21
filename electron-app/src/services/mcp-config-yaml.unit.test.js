const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

const MCP_CONFIG_ROOT = path.resolve(__dirname, "../../../mcp-configs");

function getSystemMcpYamlPaths() {
  return fs
    .readdirSync(MCP_CONFIG_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => path.join(MCP_CONFIG_ROOT, entry.name, `${entry.name}.yaml`))
    .filter((yamlPath) => fs.existsSync(yamlPath))
    .sort();
}

function loadSystemMcpConfig(serverId) {
  const yamlPath = path.join(MCP_CONFIG_ROOT, serverId, `${serverId}.yaml`);
  return yaml.load(fs.readFileSync(yamlPath, "utf8"));
}

function loadSystemMcpFragment(serverId) {
  const fragmentPath = path.join(
    MCP_CONFIG_ROOT,
    serverId,
    `${serverId}.fragment`,
  );
  return JSON.parse(fs.readFileSync(fragmentPath, "utf8"));
}

test("every system MCP YAML configuration parses successfully", () => {
  const yamlPaths = getSystemMcpYamlPaths();
  assert.ok(yamlPaths.length > 0);

  for (const yamlPath of yamlPaths) {
    const relativePath = path.relative(MCP_CONFIG_ROOT, yamlPath);
    const parsed = yaml.load(fs.readFileSync(yamlPath, "utf8"));
    assert.ok(
      parsed && typeof parsed === "object" && !Array.isArray(parsed),
      `${relativePath} must contain a YAML mapping`,
    );
  }
});

test("system MCP metadata supports independent OAuth and configuration requirements", () => {
  const trustKit = loadSystemMcpConfig("trust-kit-mcp");
  assert.equal(trustKit.oauth?.requires_user_authorization, true);
  assert.deepEqual(
    trustKit.required_env_vars.map((entry) => entry.name),
    ["waldoapikey"],
  );

  const productPal = loadSystemMcpConfig("product-pal");
  assert.equal(productPal.oauth?.requires_user_authorization, true);
  assert.deepEqual(productPal.required_env_vars || [], []);

  const n8n = loadSystemMcpConfig("mcp-n8n");
  assert.equal(n8n.oauth?.type, "dcr");
  assert.equal(n8n.oauth?.provider, "n8n");
  assert.equal(n8n.oauth?.requires_user_authorization, true);
  assert.equal(n8n.user_installed, false);
  assert.deepEqual(n8n.required_env_vars || [], []);
  assert.deepEqual(n8n.preset_env_vars || [], []);
  assert.equal(n8n.image_platform, undefined);
});

test("n8n uses the hosted OAuth MCP transport without a nested Docker command", () => {
  const n8n = loadSystemMcpFragment("mcp-n8n");

  assert.deepEqual(n8n, {
    type: "streamable-http",
    url: "https://n8n.example.invalid/mcp-server/http",
    oauth: {
      server_url: "https://n8n.example.invalid",
    },
  });
});

test("proposal builder is bundled default-off with per-user OAuth", () => {
  const proposalBuilder = loadSystemMcpConfig("proposal-builder-mcp");
  assert.deepEqual(
    {
      id: proposalBuilder.id,
      display_name: proposalBuilder.display_name,
      deployment_type: proposalBuilder.deployment_type,
      user_installed: proposalBuilder.user_installed,
      is_core: proposalBuilder.is_core,
      always_enabled: proposalBuilder.always_enabled,
      required_env_vars: proposalBuilder.required_env_vars,
      oauth: proposalBuilder.oauth,
    },
    {
      id: "proposal-builder-mcp",
      display_name: "Proposal Builder",
      deployment_type: "docker",
      user_installed: false,
      is_core: false,
      always_enabled: false,
      required_env_vars: [],
      oauth: {
        type: "dcr",
        provider: "proposal-builder-mcp",
        requires_user_authorization: true,
      },
    },
  );
  assert.deepEqual(loadSystemMcpFragment("proposal-builder-mcp"), {
    oauth: {
      server_url:
        "https://mcp.example.invalid/proposal-builder",
    },
    type: "streamable-http",
    url: "https://mcp.example.invalid/proposal-builder/mcp/",
  });

  const icon = fs.readFileSync(
    path.join(
      MCP_CONFIG_ROOT,
      "proposal-builder-mcp",
      "proposal-builder-mcp.png",
    ),
  );
  assert.equal(icon.readUInt32BE(16), 1024);
  assert.equal(icon.readUInt32BE(20), 1024);
});

test("Google Workspace uses the hosted Marvin OAuth proxy", () => {
  const metadata = loadSystemMcpConfig("google_workspace");
  assert.deepEqual(metadata.oauth, {
    type: "dcr",
    provider: "google",
    requires_user_authorization: true,
  });

  const fragment = loadSystemMcpFragment("google_workspace");
  assert.deepEqual(fragment, {
    type: "streamable-http",
    url: "https://google-workspace-mcp.sandbox.example.invalid/mcp",
    oauth: {
      server_url: "https://google-workspace-mcp.sandbox.example.invalid",
      resource: "https://google-workspace-mcp.sandbox.example.invalid/mcp",
    },
  });
});

test("bundled n8n community fork is deprecated, key-based, and distinct from native", () => {
  const fork = loadSystemMcpConfig("n8n-community-mcp");
  assert.equal(fork.id, "n8n-community-mcp");
  assert.equal(fork.display_name, "n8n (Community Fork)");
  assert.equal(fork.deprecated, true);
  assert.equal(fork.user_installed, false);
  assert.equal(fork.oauth, undefined);
  assert.deepEqual(
    fork.required_env_vars.map((entry) => entry.name),
    ["N8N_API_KEY"],
  );
  assert.equal(fork.required_env_vars[0].sensitive, true);
  assert.deepEqual(
    fork.preset_env_vars.map((entry) => entry.name),
    ["N8N_API_URL", "MCP_MODE", "LOG_LEVEL", "DISABLE_CONSOLE_OUTPUT"],
  );

  const native = loadSystemMcpConfig("mcp-n8n");
  assert.notEqual(fork.display_name, native.display_name);
  assert.notEqual(native.deprecated, true);
});

test("n8n community fork keeps the docker-run stdio transport", () => {
  const fragment = loadSystemMcpFragment("n8n-community-mcp");

  assert.deepEqual(fragment, {
    command: "docker",
    args: [
      "run",
      "-i",
      "--rm",
      "--init",
      "-e", "MCP_MODE",
      "-e", "LOG_LEVEL",
      "-e", "DISABLE_CONSOLE_OUTPUT",
      "-e", "N8N_API_URL",
      "-e", "N8N_API_KEY",
      "harbor.example.invalid/n8n/n8n-mcp:latest",
    ],
  });
});
