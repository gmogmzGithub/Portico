const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const {
  SUBAGENTS_TOOL_CREATE,
  SUBAGENTS_TOOL_UPDATE,
  TYPE_PORTICO_AGENTS,
  TYPE_MCP_SERVERS,
  TYPE_SKILLS,
  buildPublishBundle,
  install,
} = require("./ai-marketplace-install");
const {
  getInstalledAiMarketplaceSkillSource,
} = require("./marketplace-service");

async function makeTempProjectRoot() {
  return await fs.mkdtemp(
    path.join(os.tmpdir(), "portico-ai-marketplace-install-"),
  );
}

function agentInstallDeps(projectRoot, overrides = {}) {
  return {
    projectRoot,
    knownAgentIds: new Set(),
    knownSkillIds: new Set(),
    knownToolServerIds: new Set(),
    solutionId: "solution-agent",
    solution: { submitted_by: "publisher@example.invalid" },
    setInstalledAgentLink: async () => ({}),
    clearAgentLink: async () => true,
    finalizeAgentAttribution: async () => {},
    reconcileAgentAttribution: async (localAgentId) => ({
      success: true,
      data: { failures: [], finalized_pending_ids: [localAgentId] },
    }),
    ...overrides,
  };
}

// Marketplace MCP-server installs are feature-gated off by default until the
// pipeline is tested end-to-end; these tests opt in to pin the enabled path.
function enableMcpServerInstalls(t) {
  process.env.portico_ENABLE_MCP_SERVER_INSTALLS = "1";
  t.after(() => {
    delete process.env.portico_ENABLE_MCP_SERVER_INSTALLS;
  });
}

test("buildPublishBundle stores skill bundle names as bare slugs", async () => {
  const projectRoot = await makeTempProjectRoot();
  const skillDir = path.join(projectRoot, "skills", "using-deepsearch");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Using Deepsearch\n", "utf8");

  const bundle = await buildPublishBundle({
    type: TYPE_SKILLS,
    projectRoot,
    skill: {
      name: "portico-ai-marketplace/using-deepsearch",
      path: path.join("skills", "using-deepsearch"),
    },
  });

  assert.equal(bundle.type, TYPE_SKILLS);
  assert.equal(bundle.payload.name, "using-deepsearch");
  // Plain-markdown skill → the payload persists a derived human title.
  assert.equal(bundle.payload.display_name, "Using Deepsearch");
});

test("buildPublishBundle persists authored titles and derives past kebab restatements", async () => {
  const projectRoot = await makeTempProjectRoot();

  const authoredDir = path.join(projectRoot, "skills-user", "mcp-log-reader");
  await fs.mkdir(authoredDir, { recursive: true });
  await fs.writeFile(
    path.join(authoredDir, "SKILL.md"),
    "---\nname: mcp-log-reader\ndescription: Reads logs.\ndisplay_name: Log Reader Pro\n---\nBody\n",
    "utf8",
  );
  const authored = await buildPublishBundle({
    type: TYPE_SKILLS,
    projectRoot,
    skill: { name: "mcp-log-reader", path: path.join("skills-user", "mcp-log-reader") },
  });
  assert.equal(authored.payload.display_name, "Log Reader Pro");

  const restatedDir = path.join(projectRoot, "skills-user", "plain-title");
  await fs.mkdir(restatedDir, { recursive: true });
  await fs.writeFile(
    path.join(restatedDir, "SKILL.md"),
    "---\nname: plain-title\ndescription: Plain.\ndisplay_name: plain-title\n---\nBody\n",
    "utf8",
  );
  const restated = await buildPublishBundle({
    type: TYPE_SKILLS,
    projectRoot,
    skill: { name: "plain-title", path: path.join("skills-user", "plain-title") },
  });
  assert.equal(restated.payload.display_name, "Plain Title");
});

test("install writes prefixed skill bundles under the bare slug", async () => {
  const projectRoot = await makeTempProjectRoot();

  const result = await install({
    bundle: {
      type: TYPE_SKILLS,
      payload: {
        name: "ai-marketplace/using-deepsearch",
        description: "Deep Sourcegraph research helper",
        skill_md: "# Using Deepsearch\n",
      },
    },
    deps: {
      projectRoot,
      // Live backend field name — the sidecar freshness baseline must stamp
      // from updated_timestamp (2026-08-04: reading only legacy updated_at
      // left baselines empty and update detection dead).
      solution: { id: "sol-deepsearch", updated_timestamp: "2026-08-04T12:00:00Z" },
    },
  });

  assert.equal(result.type, TYPE_SKILLS);
  assert.equal(result.id, "using-deepsearch");
  // No payload/solution title on this legacy bundle → derived from the slug.
  assert.equal(result.display_name, "Using Deepsearch");
  assert.equal(
    result.installedPath,
    path.join("skills-marketplace", "ai-marketplace", "using-deepsearch"),
  );
  assert.equal(
    await fs.readFile(
      path.join(projectRoot, result.installedPath, "SKILL.md"),
      "utf8",
    ),
    "# Using Deepsearch\n",
  );
  assert.equal(
    await fs.readFile(
      path.join(projectRoot, result.installedPath, "using-deepsearch.yaml"),
      "utf8",
    ),
    [
      'skill_name: "using-deepsearch"',
      'description: "Deep Sourcegraph research helper"',
      'display_name: "ai-marketplace/using-deepsearch"',
      "",
    ].join("\n"),
  );

  const marketplacesConfig = JSON.parse(
    await fs.readFile(path.join(projectRoot, "marketplaces.json"), "utf8"),
  );
  assert.ok(Array.isArray(marketplacesConfig.installedSkills));
  assert.deepEqual(
    marketplacesConfig.installedSkills.map((entry) => ({
      marketplaceId: entry.marketplaceId,
      skillId: entry.skillId,
      skillPath: entry.skillPath,
      localPath: entry.localPath,
      sourceType: entry.skillSource?.type || null,
      remoteUpdatedAt: entry.remoteUpdatedAt,
    })),
    [
      {
        marketplaceId: "ai-marketplace",
        skillId: "using-deepsearch",
        skillPath: "./",
        localPath: path.join(
          "skills-marketplace",
          "ai-marketplace",
          "using-deepsearch",
        ),
        sourceType: "ai-marketplace-solution",
        remoteUpdatedAt: "2026-08-04T12:00:00Z",
      },
    ],
  );
});

test("skill install carries the payload display_name into the result and sidecar", async () => {
  const projectRoot = await makeTempProjectRoot();
  const result = await install({
    bundle: {
      type: TYPE_SKILLS,
      payload: {
        name: "log-reader",
        display_name: "Log Reader Pro",
        description: "Reads logs",
        skill_md: "# Log Reader\n",
      },
    },
    deps: { projectRoot },
  });
  assert.equal(result.display_name, "Log Reader Pro");
  const sidecar = await fs.readFile(
    path.join(projectRoot, result.installedPath, "log-reader.yaml"),
    "utf8",
  );
  assert.match(sidecar, /display_name: "Log Reader Pro"/);
});

test("legacy skill installs use the solution's enriched display_name for the sidecar", async () => {
  const projectRoot = await makeTempProjectRoot();
  const result = await install({
    bundle: {
      type: TYPE_SKILLS,
      payload: {
        name: "epic-voice-booster",
        description: "Elevates text",
        skill_md: "# Epic\n",
      },
    },
    deps: {
      projectRoot,
      solution: {
        name: "epic-voice-booster",
        display_name: "Epic Voice Booster",
        submitted_by: "author@example.invalid",
      },
    },
  });
  assert.equal(result.display_name, "Epic Voice Booster");
  const sidecar = await fs.readFile(
    path.join(projectRoot, result.installedPath, "epic-voice-booster.yaml"),
    "utf8",
  );
  assert.match(sidecar, /display_name: "Epic Voice Booster"/);
});

test("install preserves the Solutions Marketplace title as fallback display metadata", async () => {
  const projectRoot = await makeTempProjectRoot();

  const result = await install({
    bundle: {
      type: TYPE_SKILLS,
      payload: {
        name: "n8nkit",
        description: "Workflow quality coach",
        skill_md: [
          "---",
          "name: n8nkit",
          "description: Workflow quality coach",
          "---",
          "# n8nkit",
          "",
        ].join("\n"),
      },
    },
    deps: {
      projectRoot,
      solution: { name: "n8nkit Runtime Surface" },
      solutionId: "skill::n8nkit",
    },
  });

  assert.equal(
    await fs.readFile(
      path.join(projectRoot, result.installedPath, "n8nkit.yaml"),
      "utf8",
    ),
    [
      'skill_name: "n8nkit"',
      'description: "Workflow quality coach"',
      'display_name: "n8nkit Runtime Surface"',
      "",
    ].join("\n"),
  );

  const marketplacesConfig = JSON.parse(
    await fs.readFile(path.join(projectRoot, "marketplaces.json"), "utf8"),
  );
  assert.deepEqual(
    marketplacesConfig.installedSkills.map((entry) => entry.skillSource?.solutionName || null),
    ["n8nkit Runtime Surface"],
  );
});

test("installed Solutions Marketplace skill source resolves by local slug", async () => {
  const projectRoot = await makeTempProjectRoot();

  const result = await install({
    bundle: {
      type: TYPE_SKILLS,
      payload: {
        name: "chief-of-staff",
        description: "Coordinates runtime workflows",
        skill_md: "# Chief of Staff\n",
      },
    },
    deps: {
      projectRoot,
      solution: { name: "Chief of Staff Runtime Service" },
      solutionId: "skill::chief-of-staff-runtime-service",
    },
  });

  assert.equal(result.id, "chief-of-staff");
  assert.equal(
    result.installedPath,
    path.join("skills-marketplace", "ai-marketplace", "chief-of-staff"),
  );

  const source = await getInstalledAiMarketplaceSkillSource({
    projectRoot,
    skillId: "ai-marketplace/chief-of-staff",
  });

  assert.deepEqual(source, {
    marketplaceId: "ai-marketplace",
    skillId: "chief-of-staff",
    solutionId: "skill::chief-of-staff-runtime-service",
    solutionName: "Chief of Staff Runtime Service",
    detailUrl: null,
  });
});

test("install writes marketplace MCP server bundles into mcp-configs-user", async (t) => {
  enableMcpServerInstalls(t);
  const projectRoot = await makeTempProjectRoot();
  const iconBase64 = Buffer.from("fake-png").toString("base64");
  const bundle = {
    type: TYPE_MCP_SERVERS,
    payload: {
      id: "ProductKit MCP",
      yaml: "id: productkit-mcp\ndisplay_name: ProductKit MCP\n",
      fragment: '{\"productkit-mcp\":{\"url\":\"https://example.test/mcp\"}}',
      setup_markdown: "# ProductKit MCP\n",
      icon_png_b64: iconBase64,
    },
  };

  const result = await install({
    bundle,
    deps: { projectRoot },
  });

  assert.equal(result.type, TYPE_MCP_SERVERS);
  assert.equal(result.id, "productkit-mcp");
  assert.equal(
    result.installedPath,
    path.join("mcp-configs-user", "productkit-mcp"),
  );

  const serverDir = path.join(projectRoot, result.installedPath);
  assert.equal(
    await fs.readFile(path.join(serverDir, "productkit-mcp.yaml"), "utf8"),
    bundle.payload.yaml,
  );
  assert.equal(
    await fs.readFile(path.join(serverDir, "productkit-mcp.fragment"), "utf8"),
    bundle.payload.fragment,
  );
  assert.equal(
    await fs.readFile(path.join(serverDir, "productkit-mcp.md"), "utf8"),
    bundle.payload.setup_markdown,
  );
  assert.deepEqual(
    await fs.readFile(path.join(serverDir, "productkit-mcp.png")),
    Buffer.from("fake-png"),
  );
});

test("buildPublishBundle uploads only a redacted MCP server fragment", async () => {
  const projectRoot = await makeTempProjectRoot();
  const serverDir = path.join(projectRoot, "mcp-configs-user", "a11y-mcp");
  await fs.mkdir(serverDir, { recursive: true });
  await fs.writeFile(
    path.join(serverDir, "a11y-mcp.yaml"),
    "id: a11y-mcp\ndisplay_name: A11y MCP\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(serverDir, "a11y-mcp.fragment"),
    JSON.stringify({
      command: "docker",
      args: ["run", "-e", "A11Y_API_KEY", "-e", "TOKEN=actual-token"],
      env: {
        A11Y_API_KEY: "actual-api-key",
        PUBLIC_URL: "https://a11y.example.test/mcp",
      },
      headers: {
        Authorization: "Bearer actual-bearer-token",
      },
    }),
    "utf8",
  );
  await fs.writeFile(
    path.join(serverDir, "a11y-mcp.md"),
    "# A11y MCP\n",
    "utf8",
  );
  await fs.writeFile(path.join(serverDir, "a11y-mcp.png"), Buffer.from("png"));

  const bundle = await buildPublishBundle({
    type: TYPE_MCP_SERVERS,
    projectRoot,
    server: {
      id: "server:a11y-mcp",
      name: "A11y MCP",
      description: "Accessibility integration",
      path: path.join("mcp-configs-user", "a11y-mcp"),
    },
  });

  assert.equal(bundle.type, TYPE_MCP_SERVERS);
  assert.equal(bundle.payload.id, "server:a11y-mcp");
  assert.equal(bundle.payload.folder_id, "a11y-mcp");
  assert.equal(bundle.payload.name, "A11y MCP");
  assert.equal(bundle.payload.description, "Accessibility integration");
  assert.equal(bundle.payload.yaml, undefined);
  assert.equal(bundle.payload.setup_markdown, undefined);
  assert.equal(bundle.payload.icon_png_b64, undefined);

  const fragment = JSON.parse(bundle.payload.fragment);
  assert.deepEqual(fragment.args, [
    "run",
    "-e",
    "A11Y_API_KEY",
    "-e",
    "TOKEN=[REDACTED]",
  ]);
  assert.equal(fragment.env.A11Y_API_KEY, "[REDACTED]");
  assert.equal(fragment.env.PUBLIC_URL, "https://a11y.example.test/mcp");
  assert.equal(fragment.headers.Authorization, "[REDACTED]");
});

test("buildPublishBundle does not require MCP server yaml for marketplace upload", async () => {
  const projectRoot = await makeTempProjectRoot();
  const serverDir = path.join(projectRoot, "mcp-configs-user", "fragment-only-mcp");
  await fs.mkdir(serverDir, { recursive: true });
  await fs.writeFile(
    path.join(serverDir, "fragment-only-mcp.fragment"),
    '{"command":"uvx","args":["fragment-only-mcp"]}',
    "utf8",
  );

  const bundle = await buildPublishBundle({
    type: TYPE_MCP_SERVERS,
    projectRoot,
    server: {
      id: "server:fragment-only-mcp",
      name: "Fragment Only MCP",
      path: path.join("mcp-configs-user", "fragment-only-mcp"),
    },
  });

  assert.equal(bundle.type, TYPE_MCP_SERVERS);
  assert.equal(bundle.payload.name, "Fragment Only MCP");
  assert.equal(
    bundle.payload.fragment,
    '{\n  "command": "uvx",\n  "args": [\n    "fragment-only-mcp"\n  ]\n}\n',
  );
  assert.equal(bundle.payload.yaml, undefined);
});

test("install synthesizes MCP server yaml when marketplace bundle has only a fragment", async (t) => {
  enableMcpServerInstalls(t);
  const projectRoot = await makeTempProjectRoot();
  const bundle = {
    type: TYPE_MCP_SERVERS,
    payload: {
      folder_id: "fragment-only-mcp",
      name: "Fragment Only MCP",
      description: "Fragment-only test integration",
      fragment: '{"command":"uvx","args":["fragment-only-mcp"]}',
    },
  };

  const result = await install({
    bundle,
    deps: { projectRoot },
  });

  const serverDir = path.join(projectRoot, result.installedPath);
  assert.equal(
    await fs.readFile(path.join(serverDir, "fragment-only-mcp.fragment"), "utf8"),
    bundle.payload.fragment,
  );
  assert.equal(
    await fs.readFile(path.join(serverDir, "fragment-only-mcp.yaml"), "utf8"),
    'name: "Fragment Only MCP"\nid: "fragment-only-mcp"\ndisplay_name: "Fragment Only MCP"\ndeployment_type: "docker"\nuser_installed: true\ndescription: "Fragment-only test integration"\n',
  );
});

test("agent install fetches referenced MCP server bundles and wires resolved servers", async (t) => {
  enableMcpServerInstalls(t);
  const projectRoot = await makeTempProjectRoot();
  const serverSolutionId = "sol-productkit-mcp";
  const serverBundle = {
    type: TYPE_MCP_SERVERS,
    payload: {
      folder_id: "productkit-mcp",
      name: "ProductKit MCP",
      fragment: '{"productkit-mcp":{"url":"https://example.test/mcp"}}',
    },
  };
  const fetched = [];
  let createArgs = null;

  const result = await install({
    bundle: {
      type: TYPE_PORTICO_AGENTS,
      payload: {
        name: "ProductKit Agent",
        base_model_id: "base-model",
        system_prompt: "Use ProductKit.",
        tool_server_ids: ["server:productkit-mcp"],
        tool_server_refs: [
          {
            tool_server_id: "server:productkit-mcp",
            solution_id: serverSolutionId,
          },
        ],
      },
    },
    deps: agentInstallDeps(projectRoot, {
      fetchSolutionBundle: async (solutionId) => {
        fetched.push(solutionId);
        return serverBundle;
      },
      invokeMcpTool: async (_serverId, _toolName, args) => {
        createArgs = args;
        return { success: true, data: { id: "productkit-agent", ...args } };
      },
    }),
  });

  assert.deepEqual(fetched, [serverSolutionId]);
  assert.deepEqual(createArgs.tool_server_ids, ["server:productkit-mcp"]);
  assert.deepEqual(result.installedToolServers, [
    {
      tool_server_id: "server:productkit-mcp",
      solution_id: serverSolutionId,
      installed_id: "server:productkit-mcp",
      installedPath: path.join("mcp-configs-user", "productkit-mcp"),
    },
  ]);
  assert.deepEqual(result.failedToolServers, []);
  assert.deepEqual(result.skippedToolServers, []);
  assert.deepEqual(result.unresolved.tool_server_ids, []);

  const serverDir = path.join(
    projectRoot,
    "mcp-configs-user",
    "productkit-mcp",
  );
  assert.equal(
    await fs.readFile(path.join(serverDir, "productkit-mcp.fragment"), "utf8"),
    serverBundle.payload.fragment,
  );
});

test("agent install does not write unavailable referenced MCP server bundles", async (t) => {
  enableMcpServerInstalls(t);
  const projectRoot = await makeTempProjectRoot();
  const serverSolutionId = "deleted-productkit-mcp";
  let createArgs = null;
  const unavailable = Object.assign(new Error("Solution not found"), {
    code: "not_found",
    status: 404,
  });

  const result = await install({
    bundle: {
      type: TYPE_PORTICO_AGENTS,
      payload: {
        name: "ProductKit Agent",
        base_model_id: "base-model",
        system_prompt: "Use ProductKit.",
        tool_server_ids: ["server:productkit-mcp"],
        tool_server_refs: [
          {
            tool_server_id: "server:productkit-mcp",
            solution_id: serverSolutionId,
          },
        ],
      },
    },
    deps: agentInstallDeps(projectRoot, {
      fetchSolutionBundle: async () => {
        throw unavailable;
      },
      invokeMcpTool: async (_serverId, _toolName, args) => {
        createArgs = args;
        return { success: true, data: { id: "productkit-agent", ...args } };
      },
    }),
  });

  assert.deepEqual(createArgs.tool_server_ids, []);
  assert.deepEqual(result.installedToolServers, []);
  assert.deepEqual(result.failedToolServers, [
    {
      tool_server_id: "server:productkit-mcp",
      solution_id: serverSolutionId,
      error: "Solution not found",
    },
  ]);
  assert.deepEqual(result.skippedToolServers, []);
  assert.deepEqual(result.unresolved.tool_server_ids, ["server:productkit-mcp"]);
  await assert.rejects(() =>
    fs.access(path.join(projectRoot, "mcp-configs-user", "productkit-mcp")),
  );
});

test("agent install skips marketplace MCP server refs while installs are gated off", async () => {
  const projectRoot = await makeTempProjectRoot();
  const fetched = [];
  let createArgs = null;

  const result = await install({
    bundle: {
      type: TYPE_PORTICO_AGENTS,
      payload: {
        name: "ProductKit Agent",
        base_model_id: "base-model",
        system_prompt: "Use ProductKit.",
        tool_server_ids: ["server:productkit-mcp", "server:already-local"],
        tool_server_refs: [
          {
            tool_server_id: "server:productkit-mcp",
            solution_id: "sol-productkit-mcp",
          },
          {
            tool_server_id: "server:already-local",
            solution_id: "sol-already-local",
          },
        ],
      },
    },
    deps: agentInstallDeps(projectRoot, {
      knownToolServerIds: new Set(["server:already-local"]),
      fetchSolutionBundle: async (solutionId) => {
        fetched.push(solutionId);
        throw new Error("must not fetch marketplace bundles while gated off");
      },
      invokeMcpTool: async (_serverId, _toolName, args) => {
        createArgs = args;
        return { success: true, data: { id: "productkit-agent", ...args } };
      },
    }),
  });

  assert.deepEqual(fetched, []);
  // Servers the user already has still attach; only new marketplace installs stop.
  assert.deepEqual(createArgs.tool_server_ids, ["server:already-local"]);
  assert.deepEqual(result.installedToolServers, []);
  assert.deepEqual(result.failedToolServers, []);
  assert.deepEqual(result.skippedToolServers, [
    {
      tool_server_id: "server:productkit-mcp",
      solution_id: "sol-productkit-mcp",
      reason: "mcp_server_installs_disabled",
    },
  ]);
  assert.deepEqual(result.unresolved.tool_server_ids, ["server:productkit-mcp"]);
  await assert.rejects(() =>
    fs.access(path.join(projectRoot, "mcp-configs-user", "productkit-mcp")),
  );
});

test("direct marketplace MCP server installs are rejected while gated off", async () => {
  const projectRoot = await makeTempProjectRoot();

  await assert.rejects(
    () =>
      install({
        bundle: {
          type: TYPE_MCP_SERVERS,
          payload: {
            id: "productkit-mcp",
            yaml: "id: productkit-mcp\ndisplay_name: ProductKit MCP\n",
          },
        },
        deps: { projectRoot },
      }),
    (error) => {
      assert.equal(error.code, "mcp_server_installs_disabled");
      return true;
    },
  );
  await assert.rejects(() =>
    fs.access(path.join(projectRoot, "mcp-configs-user", "productkit-mcp")),
  );
});

test("agent install chooses a distinct local id when a fork already owns the default id", async () => {
  const projectRoot = await makeTempProjectRoot();
  let createArgs = null;

  const result = await install({
    bundle: {
      type: TYPE_PORTICO_AGENTS,
      payload: {
        name: "New agent",
        base_model_id: "Atlas Haiku 4.5",
        system_prompt: "Original marketplace prompt.",
      },
    },
    deps: agentInstallDeps(projectRoot, {
      knownAgentIds: new Set(["new-agent"]),
      invokeMcpTool: async (_serverId, _toolName, args) => {
        createArgs = args;
        return {
          success: true,
          data: {
            id: args.model_id,
            name: args.name,
            base_model_id: args.base_model_id,
            system_prompt: args.system_prompt,
            skill_ids: args.skill_ids,
            tool_server_ids: args.tool_server_ids,
          },
        };
      },
    }),
  });

  assert.equal(createArgs.model_id, "new-agent-marketplace");
  assert.equal(createArgs.name, "New agent");
  assert.equal(result.created.id, "new-agent-marketplace");
  assert.equal(result.created.name, "New agent");
  assert.equal(result.created.creation_source, "marketplace");
  assert.equal(result.created.marketplace_relationship, "installed");
  assert.equal(result.created.marketplace_solution_id, "solution-agent");
  assert.equal(result.created.created_by_email, "publisher@example.invalid");
  assert.equal(result.created.is_read_only, true);
});

test("fresh agent install also reserves around stale sidecar ids", async () => {
  const projectRoot = await makeTempProjectRoot();
  let createArgs = null;

  await install({
    bundle: {
      type: TYPE_PORTICO_AGENTS,
      payload: {
        name: "New agent",
        base_model_id: "Atlas Haiku 4.5",
        system_prompt: "Original marketplace prompt.",
      },
    },
    deps: agentInstallDeps(projectRoot, {
      readAgentLinksStrict: async () => ({
        schemaVersion: 2,
        links: {
          "new-agent": {
            solutionId: "stale-solution",
            relationship: "installed",
            authorIdentity: "stale-author",
            attributionPending: true,
          },
        },
      }),
      invokeMcpTool: async (_serverId, _toolName, args) => {
        createArgs = args;
        return { success: true, data: { id: args.model_id, ...args } };
      },
    }),
  });

  assert.equal(createArgs.model_id, "new-agent-marketplace");
});

test("fresh agent install reserves a pending publisher link before authoritative creation", async () => {
  const projectRoot = await makeTempProjectRoot();
  let createArgs = null;
  const events = [];

  await install({
    bundle: {
      type: TYPE_PORTICO_AGENTS,
      payload: {
        name: "Marketplace Agent",
        base_model_id: "Atlas Haiku 4.5",
        system_prompt: "Be helpful.",
      },
    },
    deps: agentInstallDeps(projectRoot, {
      // Bare LDAP-style handle, as published by the app's own marketplace
      // publish flow - must be stored verbatim, never upgraded to a guessed email.
      solution: { submitted_by: "dsantiago" },
      solutionId: "solution-dsantiago-agent",
      setInstalledAgentLink: async (link) => {
        events.push({ type: "link", ...link });
      },
      invokeMcpTool: async (_serverId, toolName, args) => {
        assert.equal(toolName, SUBAGENTS_TOOL_CREATE);
        events.push({ type: "create", id: args.model_id });
        createArgs = args;
        return { success: true, data: { id: args.model_id, ...args } };
      },
      reconcileAgentAttribution: async (localAgentId) => {
        events.push({ type: "reconcile", id: localAgentId });
        return {
          success: true,
          data: { failures: [], finalized_pending_ids: [localAgentId] },
        };
      },
      finalizeAgentAttribution: async (localAgentId) => {
        events.push({ type: "finalize", id: localAgentId });
      },
    }),
  });

  assert.equal("created_by_email" in createArgs, false);
  assert.deepEqual(events, [
    {
      type: "link",
      localAgentId: "marketplace-agent",
      solutionId: "solution-dsantiago-agent",
      authorIdentity: "dsantiago",
      attributionPending: true,
    },
    { type: "create", id: "marketplace-agent" },
    { type: "reconcile", id: "marketplace-agent" },
    { type: "finalize", id: "marketplace-agent" },
  ]);
});

test("agent install never overwrites created_by_email when updating an existing agent", async () => {
  const projectRoot = await makeTempProjectRoot();
  let updateArgs = null;

  await install({
    bundle: {
      type: TYPE_PORTICO_AGENTS,
      payload: {
        name: "Marketplace Agent",
        base_model_id: "Atlas Haiku 4.5",
        system_prompt: "Be helpful, updated.",
      },
    },
    deps: agentInstallDeps(projectRoot, {
      existingAgentId: "marketplace-agent",
      solution: { submitted_by: "someone-else@example.invalid" },
      invokeMcpTool: async (_serverId, toolName, args) => {
        assert.equal(toolName, SUBAGENTS_TOOL_UPDATE);
        updateArgs = args;
        return { success: true, data: { id: args.model_id, ...args } };
      },
    }),
  });

  assert.equal(updateArgs.model_id, "marketplace-agent");
  assert.equal("created_by_email" in updateArgs, false);
});

test("agent install blocks a missing Marketplace author before any mutation", async () => {
  const projectRoot = await makeTempProjectRoot();
  let mutationCount = 0;

  await assert.rejects(
    install({
      bundle: {
        type: TYPE_PORTICO_AGENTS,
        payload: {
          name: "Unattributed Agent",
          base_model_id: "Atlas Haiku 4.5",
          system_prompt: "Be helpful.",
        },
      },
      deps: agentInstallDeps(projectRoot, {
        solution: {},
        invokeMcpTool: async () => {
          mutationCount += 1;
          return { success: true, data: {} };
        },
      }),
    }),
    (error) => error?.code === "missing_marketplace_author",
  );

  assert.equal(mutationCount, 0);
});

test("agent install fails before dependencies or model mutation when the link registry is unreadable", async () => {
  const projectRoot = await makeTempProjectRoot();
  let mutationCount = 0;
  let dependencyFetchCount = 0;

  await assert.rejects(
    install({
      bundle: {
        type: TYPE_PORTICO_AGENTS,
        payload: {
          name: "Strict Registry Agent",
          base_model_id: "Atlas Haiku 4.5",
          system_prompt: "Be safe.",
          skill_ids: ["required-skill"],
          skill_refs: [
            { skill_id: "required-skill", solution_id: "solution-skill" },
          ],
        },
      },
      deps: agentInstallDeps(projectRoot, {
        readAgentLinksStrict: async () => {
          throw new SyntaxError("malformed registry");
        },
        fetchSolutionBundle: async () => {
          dependencyFetchCount += 1;
          return {};
        },
        invokeMcpTool: async () => {
          mutationCount += 1;
          return { success: true, data: {} };
        },
      }),
    }),
    /malformed registry/,
  );

  assert.equal(dependencyFetchCount, 0);
  assert.equal(mutationCount, 0);
});

test("fresh agent install rolls back the model and pending link when finalization fails", async () => {
  const projectRoot = await makeTempProjectRoot();
  const events = [];

  await assert.rejects(
    install({
      bundle: {
        type: TYPE_PORTICO_AGENTS,
        payload: {
          name: "Rollback Agent",
          base_model_id: "Atlas Haiku 4.5",
          system_prompt: "Be reversible.",
        },
      },
      deps: agentInstallDeps(projectRoot, {
        setInstalledAgentLink: async (link) => {
          events.push({ type: "link", id: link.localAgentId, pending: link.attributionPending });
        },
        invokeMcpTool: async (_serverId, toolName, args) => {
          if (toolName === SUBAGENTS_TOOL_CREATE) {
            events.push({ type: "create", id: args.model_id });
            return { success: true, data: { id: args.model_id, ...args } };
          }
          if (toolName === "subagents_delete_agent") {
            events.push({ type: "delete", id: args.model_id });
            return { success: true, data: { id: args.model_id } };
          }
          throw new Error(`Unexpected tool: ${toolName}`);
        },
        reconcileAgentAttribution: async () => ({
          success: false,
          error: "reconciliation unavailable",
        }),
        clearAgentLink: async (localAgentId) => {
          events.push({ type: "clear-link", id: localAgentId });
          return true;
        },
      }),
    }),
    (error) => error?.code === "agent_attribution_failed",
  );

  assert.deepEqual(events, [
    { type: "link", id: "rollback-agent", pending: true },
    { type: "create", id: "rollback-agent" },
    { type: "delete", id: "rollback-agent" },
    { type: "clear-link", id: "rollback-agent" },
  ]);
});

test("fresh agent install does not clear pending attribution without target confirmation", async () => {
  const projectRoot = await makeTempProjectRoot();
  const events = [];

  await assert.rejects(
    install({
      bundle: {
        type: TYPE_PORTICO_AGENTS,
        payload: {
          name: "Unconfirmed Agent",
          base_model_id: "Atlas Haiku 4.5",
          system_prompt: "Be fail closed.",
        },
      },
      deps: agentInstallDeps(projectRoot, {
        setInstalledAgentLink: async (link) => {
          events.push({ type: "link", id: link.localAgentId });
        },
        invokeMcpTool: async (_serverId, toolName, args) => {
          if (toolName === SUBAGENTS_TOOL_CREATE) {
            events.push({ type: "create", id: args.model_id });
            return { success: true, data: { id: args.model_id, ...args } };
          }
          if (toolName === "subagents_delete_agent") {
            events.push({ type: "delete", id: args.model_id });
            return { success: true, data: { id: args.model_id } };
          }
          throw new Error(`Unexpected tool: ${toolName}`);
        },
        reconcileAgentAttribution: async () => ({
          success: true,
          data: { failures: [], finalized_pending_ids: [] },
        }),
        finalizeAgentAttribution: async () => {
          events.push({ type: "finalize" });
        },
        clearAgentLink: async (localAgentId) => {
          events.push({ type: "clear-link", id: localAgentId });
          return true;
        },
      }),
    }),
    (error) => error?.code === "agent_attribution_not_finalized",
  );

  assert.deepEqual(events, [
    { type: "link", id: "unconfirmed-agent" },
    { type: "create", id: "unconfirmed-agent" },
    { type: "delete", id: "unconfirmed-agent" },
    { type: "clear-link", id: "unconfirmed-agent" },
  ]);
});


test("skill install rejects dot-segment ids before creating local state", async () => {
  for (const name of [".", ".."]) {
    const projectRoot = await makeTempProjectRoot();
    await assert.rejects(
      () =>
        install({
          bundle: {
            type: TYPE_SKILLS,
            payload: { name, skill_md: "# Unsafe\n" },
          },
          deps: { projectRoot, solutionId: `solution-${name}` },
        }),
      (error) => error?.code === "skill_install_path_invalid",
    );
    await assert.rejects(() => fs.access(path.join(projectRoot, "marketplaces.json")));
    await assert.rejects(() => fs.access(path.join(projectRoot, "skills-marketplace")));
  }
});

test("skill install rejects a symlinked root file without changing its target", async () => {
  const projectRoot = await makeTempProjectRoot();
  const outsideDir = path.join(projectRoot, "outside");
  const outsideFile = path.join(outsideDir, "protected.md");
  const skillDir = path.join(
    projectRoot,
    "skills-marketplace",
    "ai-marketplace",
    "linked-skill",
  );
  await fs.mkdir(outsideDir, { recursive: true });
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(outsideFile, "do not replace\n", "utf8");
  await fs.symlink(outsideFile, path.join(skillDir, "SKILL.md"));

  await assert.rejects(
    () =>
      install({
        bundle: {
          type: TYPE_SKILLS,
          payload: { name: "linked-skill", skill_md: "# Replacement\n" },
        },
        deps: { projectRoot, solutionId: "solution-linked-skill" },
      }),
    (error) => error?.code === "skill_install_symlink",
  );

  assert.equal(await fs.readFile(outsideFile, "utf8"), "do not replace\n");
  await assert.rejects(() => fs.access(path.join(projectRoot, "marketplaces.json")));
});

test("skill install rejects symlinked nested paths before changing existing files", async () => {
  const projectRoot = await makeTempProjectRoot();
  const outsideDir = path.join(projectRoot, "outside-references");
  const outsideFile = path.join(outsideDir, "protected.txt");
  const skillDir = path.join(
    projectRoot,
    "skills-marketplace",
    "ai-marketplace",
    "nested-skill",
  );
  await fs.mkdir(outsideDir, { recursive: true });
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(outsideFile, "protected\n", "utf8");
  await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Existing\n", "utf8");
  await fs.symlink(outsideDir, path.join(skillDir, "references"));

  await assert.rejects(
    () =>
      install({
        bundle: {
          type: TYPE_SKILLS,
          payload: {
            name: "nested-skill",
            skill_md: "# Replacement\n",
            references: [
              {
                path: "references/protected.txt",
                content_b64: Buffer.from("replacement\n").toString("base64"),
              },
            ],
          },
        },
        deps: { projectRoot, solutionId: "solution-nested-skill" },
      }),
    (error) => error?.code === "skill_install_symlink",
  );

  assert.equal(await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8"), "# Existing\n");
  assert.equal(await fs.readFile(outsideFile, "utf8"), "protected\n");
  await assert.rejects(() => fs.access(path.join(projectRoot, "marketplaces.json")));
});

// ---- git-marketplace skill refs (reference-only dependency policy) -----------

const GIT_SKILL_REF = {
  skill_id: "algorithmic-art",
  kind: "git-marketplace",
  solution_id: null,
  marketplace: {
    name: "anthropic-agent-skills",
    source: {
      type: "github",
      repo: "anthropics/skills",
      repoUrl: "https://github.com/anthropics/skills",
      ref: "main",
    },
  },
  skill_path: "./skills/algorithmic-art",
  skill_source: null,
};

test("agent install routes git-marketplace refs through the injected installer and remaps skill ids", async () => {
  const projectRoot = await makeTempProjectRoot();
  const gitInstalls = [];
  let createArgs = null;

  const result = await install({
    bundle: {
      type: TYPE_PORTICO_AGENTS,
      payload: {
        name: "Git Dep Agent",
        base_model_id: "Atlas Haiku 4.5",
        system_prompt: "Be artful.",
        skill_ids: ["algorithmic-art"],
        skill_refs: [GIT_SKILL_REF],
      },
    },
    deps: agentInstallDeps(projectRoot, {
      installGitSkillDependency: async ({ ref }) => {
        gitInstalls.push(ref);
        return {
          id: "algorithmic-art",
          localSkillId: "anthropic-agent-skills/algorithmic-art",
          installedPath:
            "skills-marketplace/anthropic-agent-skills/algorithmic-art",
          newlyInstalled: true,
          rollbackOnParentFailure: true,
        };
      },
      invokeMcpTool: async (server, tool, args) => {
        if (tool === "subagents_create_agent") {
          createArgs = args;
          return { success: true, data: { id: "git-dep-agent" } };
        }
        return { success: true, data: {} };
      },
    }),
  });

  assert.equal(gitInstalls.length, 1);
  assert.equal(gitInstalls[0].kind, "git-marketplace");
  assert.equal(gitInstalls[0].marketplace.source.repo, "anthropics/skills");
  assert.equal(gitInstalls[0].skill_path, "./skills/algorithmic-art");
  assert.ok(createArgs, "agent model is created");
  assert.deepEqual(createArgs.skill_ids, [
    "anthropic-agent-skills/algorithmic-art",
  ]);
  assert.equal(result.installedSkills[0].solution_id, null);
  assert.equal(
    result.installedSkills[0].installed_id,
    "anthropic-agent-skills/algorithmic-art",
  );
});

test("a git ref with no injected installer fails that dependency closed before any agent mutation", async () => {
  const projectRoot = await makeTempProjectRoot();
  let mutationCount = 0;

  await assert.rejects(
    install({
      bundle: {
        type: TYPE_PORTICO_AGENTS,
        payload: {
          name: "Git Dep Agent",
          base_model_id: "Atlas Haiku 4.5",
          system_prompt: "Be artful.",
          skill_ids: ["algorithmic-art"],
          skill_refs: [GIT_SKILL_REF],
        },
      },
      deps: agentInstallDeps(projectRoot, {
        invokeMcpTool: async () => {
          mutationCount += 1;
          return { success: true, data: {} };
        },
      }),
    }),
    (error) => {
      assert.equal(error?.code, "agent_dependency_install_failed");
      assert.match(
        JSON.stringify(error?.body?.failedSkills || []),
        /git-marketplace dependency installer/,
      );
      return true;
    },
  );
  assert.equal(mutationCount, 0);
});

test("publishAgentBundle round-trips git refs, normalizes legacy refs, and drops malformed entries", async () => {
  const bundle = await buildPublishBundle({
    type: TYPE_PORTICO_AGENTS,
    agent: {
      name: "Ref Round Trip",
      base_model_id: "Atlas Haiku 4.5",
      system_prompt: "Prompt.",
      skill_ids: ["algorithmic-art", "llm-proxy-analytics"],
      skill_refs: [
        GIT_SKILL_REF,
        { ...GIT_SKILL_REF, skill_id: "plugin-art", plugin_name: "example-skills" },
        { skill_id: "llm-proxy-analytics", solution_id: "fb5c9669" },
        { skill_id: "broken", kind: "git-marketplace", marketplace: { source: { type: "svn" } } },
        { skill_id: "unknown-kind", kind: "carrier-pigeon", solution_id: "x" },
      ],
    },
  });

  assert.deepEqual(bundle.payload.skill_refs, [
    // Round 9: refs carry the plugin identity (null for flat installs).
    { ...GIT_SKILL_REF, plugin_name: null },
    { ...GIT_SKILL_REF, skill_id: "plugin-art", plugin_name: "example-skills" },
    { skill_id: "llm-proxy-analytics", kind: "solution", solution_id: "fb5c9669" },
  ]);
});

// ---- live install progress events ----------------------------------------------

test("agent install emits start/done per dependent skill including reuse paths, then agent:start before the agent write", async () => {
  const projectRoot = await makeTempProjectRoot();
  const log = [];

  await install({
    bundle: {
      type: TYPE_PORTICO_AGENTS,
      payload: {
        name: "Progress Agent",
        base_model_id: "Atlas Haiku 4.5",
        system_prompt: "Be observable.",
        skill_ids: ["already-local", "algorithmic-art"],
        skill_refs: [GIT_SKILL_REF],
      },
    },
    deps: agentInstallDeps(projectRoot, {
      knownSkillIds: new Set(["already-local"]),
      onProgress: (event) => log.push(["progress", event.phase, event.skillId]),
      installGitSkillDependency: async () => ({
        id: "algorithmic-art",
        localSkillId: "anthropic-agent-skills/algorithmic-art",
        installedPath: "skills-marketplace/anthropic-agent-skills/algorithmic-art",
        newlyInstalled: true,
        rollbackOnParentFailure: true,
      }),
      invokeMcpTool: async (server, tool) => {
        if (tool === SUBAGENTS_TOOL_CREATE) {
          log.push(["agent-write"]);
          return { success: true, data: { id: "progress-agent" } };
        }
        return { success: true, data: {} };
      },
    }),
  });

  const progress = log.filter((entry) => entry[0] === "progress");
  assert.deepEqual(progress, [
    ["progress", "skill:start", "already-local"],
    ["progress", "skill:done", "already-local"],
    ["progress", "skill:start", "algorithmic-art"],
    ["progress", "skill:done", "algorithmic-art"],
    ["progress", "agent:start", undefined],
  ]);
  const agentStartIndex = log.findIndex(
    (entry) => entry[0] === "progress" && entry[1] === "agent:start",
  );
  const agentWriteIndex = log.findIndex((entry) => entry[0] === "agent-write");
  assert.ok(agentStartIndex >= 0 && agentWriteIndex >= 0);
  assert.ok(
    agentStartIndex < agentWriteIndex,
    "agent:start precedes the agent model write",
  );
});

test("a failing dependency emits skill:error, later skills still report, and no agent:start fires", async () => {
  const projectRoot = await makeTempProjectRoot();
  const events = [];
  let mutationCount = 0;

  await assert.rejects(
    install({
      bundle: {
        type: TYPE_PORTICO_AGENTS,
        payload: {
          name: "Failing Agent",
          base_model_id: "Atlas Haiku 4.5",
          system_prompt: "Fail one dep.",
          skill_ids: ["broken-art", "already-local"],
          skill_refs: [{ ...GIT_SKILL_REF, skill_id: "broken-art" }],
        },
      },
      deps: agentInstallDeps(projectRoot, {
        knownSkillIds: new Set(["already-local"]),
        onProgress: (event) => events.push([event.phase, event.skillId]),
        installGitSkillDependency: async () => {
          throw new Error("clone failed");
        },
        invokeMcpTool: async () => {
          mutationCount += 1;
          return { success: true, data: {} };
        },
      }),
    }),
    (error) => error?.code === "agent_dependency_install_failed",
  );

  assert.deepEqual(events, [
    ["skill:start", "broken-art"],
    ["skill:error", "broken-art"],
    ["skill:start", "already-local"],
    ["skill:done", "already-local"],
  ]);
  assert.equal(mutationCount, 0, "no agent write after a dependency failure");
});

test("a throwing progress callback never disturbs the install", async () => {
  const projectRoot = await makeTempProjectRoot();
  let created = false;

  const result = await install({
    bundle: {
      type: TYPE_PORTICO_AGENTS,
      payload: {
        name: "Sturdy Agent",
        base_model_id: "Atlas Haiku 4.5",
        system_prompt: "Survive bad UIs.",
        skill_ids: ["already-local"],
      },
    },
    deps: agentInstallDeps(projectRoot, {
      knownSkillIds: new Set(["already-local"]),
      onProgress: () => {
        throw new Error("UI blew up");
      },
      invokeMcpTool: async (server, tool) => {
        if (tool === SUBAGENTS_TOOL_CREATE) {
          created = true;
          return { success: true, data: { id: "sturdy-agent" } };
        }
        return { success: true, data: {} };
      },
    }),
  });

  assert.equal(created, true);
  assert.equal(result.created.id, "sturdy-agent");
});

// ---- content-free diagnostics -----------------------------------------------------

function captureConsole() {
  const lines = [];
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  const record = (...args) =>
    lines.push(
      args
        .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
        .join(" "),
    );
  console.log = record;
  console.warn = record;
  console.error = record;
  return {
    lines,
    restore() {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
    },
  };
}

test("install diagnostics log the decision trail but never prompt or description content", async () => {
  const projectRoot = await makeTempProjectRoot();
  const PROMPT_MARKER = "MARKER-PROMPT-9f3a1c";
  const DESCRIPTION_MARKER = "MARKER-DESC-5b7e2d";
  const capture = captureConsole();
  try {
    await install({
      bundle: {
        type: TYPE_PORTICO_AGENTS,
        payload: {
          name: "Diagnostic Agent",
          description: DESCRIPTION_MARKER,
          base_model_id: "Atlas Haiku 4.5",
          system_prompt: PROMPT_MARKER,
          skill_ids: ["already-local", "algorithmic-art"],
          skill_refs: [GIT_SKILL_REF],
        },
      },
      deps: agentInstallDeps(projectRoot, {
        knownSkillIds: new Set(["already-local"]),
        installGitSkillDependency: async () => ({
          id: "algorithmic-art",
          localSkillId: "anthropic-agent-skills/algorithmic-art",
          installedPath:
            "skills-marketplace/anthropic-agent-skills/algorithmic-art",
          newlyInstalled: true,
          rollbackOnParentFailure: true,
        }),
        invokeMcpTool: async (server, tool) => {
          if (tool === SUBAGENTS_TOOL_CREATE) {
            return { success: true, data: { id: "diagnostic-agent" } };
          }
          return { success: true, data: {} };
        },
      }),
    });
  } finally {
    capture.restore();
  }

  const all = capture.lines.join("\n");
  assert.ok(
    !all.includes(PROMPT_MARKER),
    "system prompt content must never reach the logs",
  );
  assert.ok(
    !all.includes(DESCRIPTION_MARKER),
    "description content must never reach the logs",
  );

  const decisions = capture.lines.filter((line) =>
    line.includes("[Marketplace][install] reconcile:skill"),
  );
  assert.equal(decisions.length, 2, "one decision line per dependency");
  assert.ok(decisions[0].includes('"skillId":"already-local"'));
  assert.ok(decisions[0].includes('"branch":"reuse-local"'));
  assert.ok(decisions[1].includes('"skillId":"algorithmic-art"'));
  assert.ok(decisions[1].includes('"branch":"git-installed"'));
  assert.ok(
    capture.lines.some((line) =>
      line.includes("[Marketplace][install] reconcile:summary"),
    ),
    "reconcile summary logged",
  );
  assert.ok(
    capture.lines.some(
      (line) =>
        line.includes("[Marketplace][install] agent:mutation") &&
        line.includes('"mutation":"created"'),
    ),
    "agent mutation logged",
  );
});

test("a failed dependency logs the failure branch and rollback, still content-free", async () => {
  const projectRoot = await makeTempProjectRoot();
  const PROMPT_MARKER = "MARKER-PROMPT-77aa00";
  const capture = captureConsole();
  try {
    await assert.rejects(
      install({
        bundle: {
          type: TYPE_PORTICO_AGENTS,
          payload: {
            name: "Failing Diagnostic Agent",
            base_model_id: "Atlas Haiku 4.5",
            system_prompt: PROMPT_MARKER,
            skill_ids: ["broken-art"],
            skill_refs: [{ ...GIT_SKILL_REF, skill_id: "broken-art" }],
          },
        },
        deps: agentInstallDeps(projectRoot, {
          installGitSkillDependency: async () => {
            throw new Error("clone failed");
          },
          invokeMcpTool: async () => ({ success: true, data: {} }),
        }),
      }),
      (error) => error?.code === "agent_dependency_install_failed",
    );
  } finally {
    capture.restore();
  }

  const all = capture.lines.join("\n");
  assert.ok(!all.includes(PROMPT_MARKER), "prompt content never logged on failure");
  assert.ok(
    capture.lines.some(
      (line) =>
        line.includes("reconcile:skill") &&
        line.includes('"branch":"git-failed"') &&
        line.includes("clone failed"),
    ),
    "the failing branch carries the capped error message",
  );
  assert.ok(
    capture.lines.some(
      (line) =>
        line.includes("reconcile:summary") &&
        line.includes('"failedSkillIds":["broken-art"]'),
    ),
    "summary lists the failed skill ids",
  );
});

test("skill installs persist the listing author into the sibling yaml as a bare handle", async () => {
  const projectRoot = await makeTempProjectRoot();

  const result = await install({
    bundle: {
      type: TYPE_SKILLS,
      payload: {
        name: "joke-setup-generator",
        description: "Generates joke setups",
        skill_md: "# Joke Setup Generator\n",
      },
    },
    deps: {
      projectRoot,
      solutionId: "sol-jokes",
      solution: { name: "joke-setup-generator", submitted_by: "adamu@example.invalid" },
    },
  });

  const yaml = await fs.readFile(
    path.join(projectRoot, result.installedPath, "joke-setup-generator.yaml"),
    "utf8",
  );
  // The sibling yaml's owner key is what get-skills surfaces as the card
  // author — the original publisher, not the generic marketplace fallback.
  assert.match(yaml, /owner: "adamu"\n/);
  assert.doesNotMatch(yaml, /adamu@portico\.com/);
});

// ---- rollback progress events (full-undo visibility) --------------------------

test("rollback emits skill:rolled-back for each undone dependency, after its skill:done", async () => {
  const projectRoot = await makeTempProjectRoot();
  const events = [];

  await assert.rejects(
    install({
      bundle: {
        type: TYPE_PORTICO_AGENTS,
        payload: {
          name: "Rollback Agent",
          base_model_id: "Atlas Haiku 4.5",
          system_prompt: "Roll back.",
          skill_ids: ["good-skill", "bad-skill"],
          skill_refs: [
            { skill_id: "good-skill", kind: "solution", solution_id: "sol-good" },
            { skill_id: "bad-skill", kind: "solution", solution_id: "sol-bad" },
          ],
        },
      },
      deps: agentInstallDeps(projectRoot, {
        invokeMcpTool: async () => ({ success: true, data: {} }),
        installSkillDependency: async ({ expectedSkillId }) => {
          if (expectedSkillId === "bad-skill") {
            throw new Error("Solution not found");
          }
          return {
            id: "good-skill",
            localSkillId: "ai-marketplace/good-skill",
            installedPath: "skills-marketplace/ai-marketplace/good-skill",
            newlyInstalled: true,
            rollbackOnParentFailure: true,
          };
        },
        onProgress: (event) =>
          events.push([event.phase, event.skillId, event.cleaned]),
      }),
    }),
    (error) => error?.code === "agent_dependency_install_failed",
  );

  assert.deepEqual(events, [
    ["skill:start", "good-skill", undefined],
    ["skill:done", "good-skill", undefined],
    ["skill:start", "bad-skill", undefined],
    ["skill:error", "bad-skill", undefined],
    ["skill:rolled-back", "good-skill", true],
  ]);
});

test("reused dependencies never emit skill:rolled-back on failure", async () => {
  const projectRoot = await makeTempProjectRoot();
  const events = [];

  await assert.rejects(
    install({
      bundle: {
        type: TYPE_PORTICO_AGENTS,
        payload: {
          name: "Reuse Agent",
          base_model_id: "Atlas Haiku 4.5",
          system_prompt: "Keep pre-existing installs.",
          skill_ids: ["kept-skill", "bad-skill"],
          skill_refs: [
            { skill_id: "kept-skill", kind: "solution", solution_id: "sol-kept" },
            { skill_id: "bad-skill", kind: "solution", solution_id: "sol-bad" },
          ],
        },
      },
      deps: agentInstallDeps(projectRoot, {
        invokeMcpTool: async () => ({ success: true, data: {} }),
        installSkillDependency: async ({ expectedSkillId }) => {
          if (expectedSkillId === "bad-skill") {
            throw new Error("Solution not found");
          }
          // Pre-existing install reused: never rolled back (pptx in the
          // 2026-08-03 incident survived exactly this way).
          return {
            id: "kept-skill",
            localSkillId: "ai-marketplace/kept-skill",
            installedPath: "skills-marketplace/ai-marketplace/kept-skill",
            newlyInstalled: false,
            rollbackOnParentFailure: false,
          };
        },
        onProgress: (event) => events.push([event.phase, event.skillId]),
      }),
    }),
    (error) => error?.code === "agent_dependency_install_failed",
  );

  assert.ok(
    !events.some(([phase]) => phase === "skill:rolled-back"),
    "nothing newly installed, nothing rolled back",
  );
});

test("agent-mutation failure also emits skill:rolled-back for installed deps", async () => {
  const projectRoot = await makeTempProjectRoot();
  const events = [];

  await assert.rejects(
    install({
      bundle: {
        type: TYPE_PORTICO_AGENTS,
        payload: {
          name: "Late Failure Agent",
          base_model_id: "Atlas Haiku 4.5",
          system_prompt: "Fail at the agent step.",
          skill_ids: ["good-skill"],
          skill_refs: [
            { skill_id: "good-skill", kind: "solution", solution_id: "sol-good" },
          ],
        },
      },
      deps: agentInstallDeps(projectRoot, {
        installSkillDependency: async () => ({
          id: "good-skill",
          localSkillId: "ai-marketplace/good-skill",
          installedPath: "skills-marketplace/ai-marketplace/good-skill",
          newlyInstalled: true,
          rollbackOnParentFailure: true,
        }),
        invokeMcpTool: async () => {
          throw new Error("agent create exploded");
        },
        onProgress: (event) => events.push([event.phase, event.skillId]),
      }),
    }),
    (error) => Boolean(error),
  );

  assert.ok(
    events.some(
      ([phase, skillId]) =>
        phase === "skill:rolled-back" && skillId === "good-skill",
    ),
    "the agent-step failure branch reports the undone dependency too",
  );
});

// ---- authored display names in skill refs -------------------------------------

test("agent bundles preserve authored ref display names and drop restating ones", async () => {
  const bundle = await buildPublishBundle({
    type: TYPE_PORTICO_AGENTS,
    agent: {
      name: "Named Refs Agent",
      description: "",
      base_model_id: "Atlas Haiku 4.5",
      system_prompt: "Carry names.",
      skill_ids: ["gtm-brief-qa", "plain-skill", "git-skill"],
      skill_refs: [
        {
          skill_id: "gtm-brief-qa",
          kind: "solution",
          solution_id: "sol-1",
          display_name: "GTM Brief QA",
        },
        {
          skill_id: "plain-skill",
          kind: "solution",
          solution_id: "sol-2",
          // Restates the id: dropped so derivation stays authoritative.
          display_name: "plain-skill",
        },
        {
          skill_id: "git-skill",
          kind: "git-marketplace",
          solution_id: null,
          display_name: "Git Skill Deluxe",
          marketplace: {
            name: "some-marketplace",
            source: { type: "github", repo: "org/skills", ref: "main" },
          },
          skill_path: "./skills/git-skill",
        },
      ],
      tool_server_ids: [],
    },
  });

  const refs = bundle.payload.skill_refs;
  assert.equal(refs[0].display_name, "GTM Brief QA");
  assert.equal(refs[1].display_name, undefined);
  assert.equal(refs[2].display_name, "Git Skill Deluxe");
});
