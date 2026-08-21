// Agent marketplace lifecycle integration test.
// Spans the Chat UI, IPC/Communication, MCP Orchestration, Agent Skills, and
// State & Persistence layers without requiring live marketplace or OWUI infra.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  SUBAGENTS_PORT,
  SUBAGENTS_SERVER_ID,
  SUBAGENTS_TOOL_CREATE,
  SUBAGENTS_TOOL_DELETE,
  SUBAGENTS_TOOL_GET,
  SUBAGENTS_TOOL_UPDATE,
  TYPE_PORTICO_AGENTS,
  TYPE_MCP_SERVERS,
  TYPE_SKILLS,
  buildPublishBundle,
  install,
  sanitizeId,
} = require("./ai-marketplace-install");

async function makeTempProjectRoot() {
  return await fs.mkdtemp(
    path.join(os.tmpdir(), "portico-agent-lifecycle-"),
  );
}

function agentInstallDeps(projectRoot, subagents, overrides = {}) {
  return {
    projectRoot,
    invokeMcpTool: subagents.invokeMcpTool.bind(subagents),
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

async function writeLifecycleFixtures(projectRoot) {
  const skillDir = path.join(projectRoot, "skills-user", "lifecycle-skill");
  await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      "name: lifecycle-skill",
      "description: Exercises marketplace lifecycle install",
      "required_mcp_servers:",
      "  - server:lifecycle-mcp",
      "---",
      "# Lifecycle Skill",
      "Use the lifecycle MCP server when relevant.",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(skillDir, "references", "guide.md"),
    "# Lifecycle Guide\n",
    "utf8",
  );

  const serverDir = path.join(projectRoot, "mcp-configs-user", "lifecycle-mcp");
  await fs.mkdir(serverDir, { recursive: true });
  await fs.writeFile(
    path.join(serverDir, "lifecycle-mcp.yaml"),
    "id: lifecycle-mcp\ndisplay_name: Lifecycle MCP\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(serverDir, "lifecycle-mcp.fragment"),
    '{"lifecycle-mcp":{"url":"https://lifecycle.example.test/mcp"}}',
    "utf8",
  );
  await fs.writeFile(
    path.join(serverDir, "lifecycle-mcp.md"),
    "# Lifecycle MCP\n",
    "utf8",
  );
  await fs.writeFile(path.join(serverDir, "lifecycle-mcp.png"), Buffer.from("png"));

  return {
    skill: {
      name: "lifecycle-skill",
      path: path.join("skills-user", "lifecycle-skill"),
      required_mcp_servers: ["server:lifecycle-mcp"],
    },
    server: {
      id: "server:lifecycle-mcp",
      name: "Lifecycle MCP",
      description: "Lifecycle test MCP server",
      path: path.join("mcp-configs-user", "lifecycle-mcp"),
    },
  };
}

async function writeN8nkitFixture(projectRoot) {
  const skillDir = path.join(projectRoot, "skills-user", "n8nkit");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      "name: n8nkit",
      "description: Installs the marketplace n8nkit fixture",
      "---",
      "# n8nkit",
      "Use the n8nkit skill when building workflow automations.",
      "",
    ].join("\n"),
    "utf8",
  );

  return {
    name: "n8nkit",
    path: path.join("skills-user", "n8nkit"),
    required_mcp_servers: [],
  };
}

class FakeMarketplace {
  constructor() {
    this.nextId = 1;
    this.solutions = new Map();
    this.failNextUpdateIds = new Set();
  }

  publish(bundle) {
    const id = `sol-${this.nextId}`;
    this.nextId += 1;
    this.solutions.set(id, structuredClone(bundle));
    return { success: true, data: { id } };
  }

  update(id, bundle) {
    if (this.failNextUpdateIds.has(id)) {
      this.failNextUpdateIds.delete(id);
      return { success: false, code: "not_owner", status: 403 };
    }
    if (!this.solutions.has(id)) {
      return { success: false, code: "not_found", status: 404 };
    }
    this.solutions.set(id, structuredClone(bundle));
    return { success: true, data: { id } };
  }

  delete(id) {
    return { success: this.solutions.delete(id) };
  }

  getBundle(id) {
    const bundle = this.solutions.get(id);
    if (!bundle) throw new Error(`Missing marketplace bundle: ${id}`);
    return structuredClone(bundle);
  }
}

class FakeSubagents {
  constructor() {
    this.agents = new Map();
    this.createCalls = [];
    this.chatRuns = [];
  }

  async invokeMcpTool(serverId, toolName, args, port) {
    assert.equal(serverId, SUBAGENTS_SERVER_ID);
    assert.equal(port, SUBAGENTS_PORT);

    if (toolName === SUBAGENTS_TOOL_CREATE) return this.createAgent(args);
    if (toolName === SUBAGENTS_TOOL_GET) return this.getAgent(args);
    if (toolName === SUBAGENTS_TOOL_UPDATE) return this.updateAgent(args);
    if (toolName === SUBAGENTS_TOOL_DELETE) return this.deleteAgent(args);
    if (toolName === "subagents_run_subagent") return this.runSubagent(args);
    throw new Error(`Unexpected Subagents MCP tool: ${toolName}`);
  }

  createAgent(args) {
    const id = args.model_id || sanitizeId(args.name);
    const record = {
      id,
      name: args.name,
      base_model_id: args.base_model_id,
      system_prompt: args.system_prompt,
      description: args.description || "",
      skill_ids: [...(args.skill_ids || [])],
      tool_server_ids: [...(args.tool_server_ids || [])],
      reasoning_effort: args.reasoning_effort || null,
    };
    this.agents.set(id, record);
    this.createCalls.push(structuredClone(args));
    return { success: true, data: { id, ...structuredClone(record) } };
  }

  getAgent({ model_id }) {
    const agent = this.agents.get(model_id);
    return agent
      ? { success: true, data: structuredClone(agent) }
      : { success: false, data: { error: "not found" } };
  }

  updateAgent(args) {
    const id = args.model_id;
    const current = this.agents.get(id);
    if (!current) return { success: false, data: { error: "not found" } };
    const next = {
      ...current,
      name: args.name ?? current.name,
      description: args.description ?? current.description,
      system_prompt: args.system_prompt ?? current.system_prompt,
      base_model_id: args.base_model_id ?? current.base_model_id,
      skill_ids: Array.isArray(args.skill_ids)
        ? [...args.skill_ids]
        : current.skill_ids,
      tool_server_ids: Array.isArray(args.tool_server_ids)
        ? [...args.tool_server_ids]
        : current.tool_server_ids,
      reasoning_effort: args.reasoning_effort ?? current.reasoning_effort,
    };
    this.agents.set(id, next);
    return { success: true, data: structuredClone(next) };
  }

  deleteAgent({ model_id }) {
    return { success: this.agents.delete(model_id), data: { id: model_id } };
  }

  runSubagent({ model }) {
    const agent = this.agents.get(model);
    if (!agent) return { success: false, data: { error: "not found" } };
    const chat = {
      chat_id: `chat-${this.chatRuns.length + 1}`,
      chat_skills: [...agent.skill_ids],
      chat_tools: [...agent.tool_server_ids],
    };
    this.chatRuns.push(chat);
    return { success: true, data: structuredClone(chat) };
  }
}

async function publishOwned({ marketplace, currentSolutionId, buildBundle }) {
  const bundle = await buildBundle();
  if (currentSolutionId) {
    const updated = marketplace.update(currentSolutionId, bundle);
    if (updated.success) return updated.data.id;
    const error = new Error(`Marketplace update failed: ${updated.code}`);
    error.code = updated.code;
    error.status = updated.status;
    throw error;
  }
  const created = marketplace.publish(bundle);
  return created.data.id;
}

// Marketplace MCP-server installs are feature-gated off by default until the
// pipeline is tested end-to-end; lifecycle tests opt in to keep exercising
// the full publish -> install round trip.
function enableMcpServerInstalls(t) {
  process.env.portico_ENABLE_MCP_SERVER_INSTALLS = "1";
  t.after(() => {
    delete process.env.portico_ENABLE_MCP_SERVER_INSTALLS;
  });
}

test("agent lifecycle publishes skills, downloads agent, runs chat wiring, and deletes", async (t) => {
  enableMcpServerInstalls(t);
  const projectRoot = await makeTempProjectRoot();
  const { skill, server } = await writeLifecycleFixtures(projectRoot);
  const marketplace = new FakeMarketplace();
  const subagents = new FakeSubagents();
  const links = new Map();

  const created = await subagents.invokeMcpTool(
    SUBAGENTS_SERVER_ID,
    SUBAGENTS_TOOL_CREATE,
    {
      name: "Lifecycle Agent",
      base_model_id: "base-model",
      system_prompt: "Be lifecycle aware.",
      description: "Initial lifecycle agent",
      skill_ids: [skill.name],
      tool_server_ids: [server.id],
      reasoning_effort: "medium",
    },
    SUBAGENTS_PORT,
  );
  const localAgentId = created.data.id;
  const fetched = await subagents.invokeMcpTool(
    SUBAGENTS_SERVER_ID,
    SUBAGENTS_TOOL_GET,
    { model_id: localAgentId },
    SUBAGENTS_PORT,
  );
  assert.deepEqual(fetched.data.skill_ids, ["lifecycle-skill"]);
  assert.deepEqual(fetched.data.tool_server_ids, ["server:lifecycle-mcp"]);

  const skillSolutionId = await publishOwned({
    marketplace,
    currentSolutionId: links.get(skill.name),
    buildBundle: () =>
      buildPublishBundle({ type: TYPE_SKILLS, projectRoot, skill }),
  });
  links.set(skill.name, skillSolutionId);

  const mcpBundle = await buildPublishBundle({
    type: TYPE_MCP_SERVERS,
    projectRoot,
    server,
  });
  assert.equal(mcpBundle.payload.folder_id, "lifecycle-mcp");
  const serverSolutionId = marketplace.publish(mcpBundle).data.id;

  const agentSolutionId = await publishOwned({
    marketplace,
    currentSolutionId: links.get(localAgentId),
    buildBundle: () =>
      buildPublishBundle({
        type: TYPE_PORTICO_AGENTS,
        agent: {
          ...fetched.data,
          allowed_emails: ["JDoe@example.invalid", "asmith@example.invalid", "jdoe@example.invalid"],
          skill_refs: [
            { skill_id: skill.name, solution_id: skillSolutionId },
          ],
          tool_server_refs: [
            { tool_server_id: server.id, solution_id: serverSolutionId },
          ],
        },
      }),
  });
  links.set(localAgentId, agentSolutionId);

  const publishedAgentBundle = marketplace.getBundle(agentSolutionId);
  assert.deepEqual(publishedAgentBundle.payload.skill_refs, [
    // Refs carry the discriminant since the reference-only dependency work:
    // solution-backed refs are kind "solution".
    { kind: "solution", skill_id: "lifecycle-skill", solution_id: skillSolutionId },
  ]);
  assert.deepEqual(publishedAgentBundle.payload.allowed_emails, [
    "jdoe@example.invalid",
    "asmith@example.invalid",
  ]);
  assert.deepEqual(publishedAgentBundle.payload.tool_server_ids, [
    "server:lifecycle-mcp",
  ]);
  assert.deepEqual(publishedAgentBundle.payload.tool_server_refs, [
    { tool_server_id: "server:lifecycle-mcp", solution_id: serverSolutionId },
  ]);

  const installed = await install({
    bundle: publishedAgentBundle,
    deps: agentInstallDeps(projectRoot, subagents, {
      solutionId: agentSolutionId,
      fetchSolutionBundle: (solutionId) => marketplace.getBundle(solutionId),
    }),
  });

  assert.equal(installed.created.id, "lifecycle-agent");
  assert.deepEqual(installed.installedSkills, [
    {
      skill_id: "lifecycle-skill",
      solution_id: skillSolutionId,
      installed_id: "ai-marketplace/lifecycle-skill",
      installedPath: path.join(
        "skills-marketplace",
        "ai-marketplace",
        "lifecycle-skill",
      ),
    },
  ]);
  assert.deepEqual(installed.installedToolServers, [
    {
      tool_server_id: "server:lifecycle-mcp",
      solution_id: serverSolutionId,
      installed_id: "server:lifecycle-mcp",
      installedPath: path.join("mcp-configs-user", "lifecycle-mcp"),
    },
  ]);
  assert.deepEqual(installed.failedSkills, []);
  assert.deepEqual(installed.failedToolServers, []);
  assert.deepEqual(installed.unresolved, { skill_ids: [], tool_server_ids: [] });

  const installCreateArgs = subagents.createCalls.at(-1);
  assert.deepEqual(installCreateArgs.skill_ids, [
    "ai-marketplace/lifecycle-skill",
  ]);
  assert.deepEqual(installCreateArgs.tool_server_ids, ["server:lifecycle-mcp"]);
  assert.equal(installCreateArgs.reasoning_effort, "medium");

  const installedSkillMarkdown = await fs.readFile(
    path.join(
      projectRoot,
      "skills-marketplace",
      "ai-marketplace",
      "lifecycle-skill",
      "SKILL.md",
    ),
    "utf8",
  );
  assert.match(installedSkillMarkdown, /# Lifecycle Skill/);

  const chatRun = await subagents.invokeMcpTool(
    SUBAGENTS_SERVER_ID,
    "subagents_run_subagent",
    { model: installed.created.id, prompt: "Use your lifecycle wiring." },
    SUBAGENTS_PORT,
  );
  assert.deepEqual(chatRun.data.chat_skills, ["ai-marketplace/lifecycle-skill"]);
  assert.deepEqual(chatRun.data.chat_tools, ["server:lifecycle-mcp"]);

  const updated = await subagents.invokeMcpTool(
    SUBAGENTS_SERVER_ID,
    SUBAGENTS_TOOL_UPDATE,
    {
      model_id: installed.created.id,
      description: "Updated lifecycle agent",
      system_prompt: "Be updated.",
      skill_ids: ["ai-marketplace/lifecycle-skill"],
      tool_server_ids: ["server:lifecycle-mcp"],
      reasoning_effort: "high",
    },
    SUBAGENTS_PORT,
  );
  assert.equal(updated.data.description, "Updated lifecycle agent");
  assert.equal(updated.data.reasoning_effort, "high");

  assert.equal(marketplace.delete(agentSolutionId).success, true);
  links.delete(localAgentId);
  const deleted = await subagents.invokeMcpTool(
    SUBAGENTS_SERVER_ID,
    SUBAGENTS_TOOL_DELETE,
    { model_id: installed.created.id },
    SUBAGENTS_PORT,
  );
  assert.equal(deleted.success, true);
  assert.equal(subagents.agents.has(installed.created.id), false);
});

test("agent publish lifecycle updates owned solutions and rejects not_owner without forking", async () => {
  const projectRoot = await makeTempProjectRoot();
  const { skill } = await writeLifecycleFixtures(projectRoot);
  const marketplace = new FakeMarketplace();
  const links = new Map();

  const originalSkillId = await publishOwned({
    marketplace,
    currentSolutionId: null,
    buildBundle: () =>
      buildPublishBundle({ type: TYPE_SKILLS, projectRoot, skill }),
  });
  links.set(skill.name, originalSkillId);

  await fs.writeFile(
    path.join(projectRoot, "skills-user", "lifecycle-skill", "SKILL.md"),
    "# Lifecycle Skill\nUpdated content.\n",
    "utf8",
  );
  const updatedSkillId = await publishOwned({
    marketplace,
    currentSolutionId: links.get(skill.name),
    buildBundle: () =>
      buildPublishBundle({ type: TYPE_SKILLS, projectRoot, skill }),
  });
  assert.equal(updatedSkillId, originalSkillId);
  assert.match(marketplace.getBundle(updatedSkillId).payload.skill_md, /Updated/);

  const originalAgentId = await publishOwned({
    marketplace,
    currentSolutionId: null,
    buildBundle: () =>
      buildPublishBundle({
        type: TYPE_PORTICO_AGENTS,
        agent: {
          name: "Lifecycle Agent",
          base_model_id: "base-model",
          system_prompt: "Original.",
          skill_ids: [skill.name],
          skill_refs: [{ skill_id: skill.name, solution_id: updatedSkillId }],
        },
      }),
  });
  links.set("lifecycle-agent", originalAgentId);
  marketplace.failNextUpdateIds.add(originalAgentId);

  await assert.rejects(
    () =>
      publishOwned({
        marketplace,
        currentSolutionId: links.get("lifecycle-agent"),
        buildBundle: () =>
          buildPublishBundle({
            type: TYPE_PORTICO_AGENTS,
            agent: {
              name: "Lifecycle Agent",
              base_model_id: "base-model",
              system_prompt: "Rejected foreign overwrite.",
              skill_ids: [skill.name],
              skill_refs: [
                { skill_id: skill.name, solution_id: updatedSkillId },
              ],
            },
          }),
      }),
    (error) => error?.code === "not_owner" && error?.status === 403,
  );

  assert.equal(marketplace.solutions.size, 2);
  assert.equal(links.get("lifecycle-agent"), originalAgentId);
  assert.equal(marketplace.getBundle(originalAgentId).payload.system_prompt, "Original.");
});

test("n8nkit agent install also installs the marketplace n8nkit skill", async () => {
  const projectRoot = await makeTempProjectRoot();
  const skill = await writeN8nkitFixture(projectRoot);
  const marketplace = new FakeMarketplace();
  const subagents = new FakeSubagents();

  const skillSolutionId = await publishOwned({
    marketplace,
    currentSolutionId: null,
    buildBundle: () =>
      buildPublishBundle({ type: TYPE_SKILLS, projectRoot, skill }),
  });

  const agentBundle = await buildPublishBundle({
    type: TYPE_PORTICO_AGENTS,
    agent: {
      name: "n8nkit agent",
      base_model_id: "base-model",
      system_prompt: "Use n8nkit when needed.",
      skill_ids: ["n8nkit"],
      skill_refs: [{ skill_id: "n8nkit", solution_id: skillSolutionId }],
    },
  });

  const installed = await install({
    bundle: agentBundle,
    deps: agentInstallDeps(projectRoot, subagents, {
      fetchSolutionBundle: (solutionId) => marketplace.getBundle(solutionId),
    }),
  });

  assert.equal(installed.created.id, "n8nkit-agent");
  assert.equal(installed.installedSkills.length, 1);
  assert.equal(installed.installedSkills[0].skill_id, "n8nkit");
  assert.equal(installed.installedSkills[0].installed_id, "ai-marketplace/n8nkit");
  assert.deepEqual(installed.created.skill_ids, ["ai-marketplace/n8nkit"]);

  const installedSkillMarkdown = await fs.readFile(
    path.join(
      projectRoot,
      "skills-marketplace",
      "ai-marketplace",
      "n8nkit",
      "SKILL.md",
    ),
    "utf8",
  );
  assert.match(installedSkillMarkdown, /# n8nkit/);
  const installedSkillMetadata = await fs.readFile(
    path.join(
      projectRoot,
      "skills-marketplace",
      "ai-marketplace",
      "n8nkit",
      "n8nkit.yaml",
    ),
    "utf8",
  );
  assert.match(installedSkillMetadata, /skill_name: "n8nkit"/);
  // The read layer enriches the solution with a derived title before install,
  // so the sidecar carries the human form rather than the kebab name.
  assert.match(installedSkillMetadata, /display_name: "N8nkit"/);
});

test("agent rename keeps the local id stable and republishes the new display name", async () => {
  const projectRoot = await makeTempProjectRoot();
  const { skill, server } = await writeLifecycleFixtures(projectRoot);
  const marketplace = new FakeMarketplace();
  const subagents = new FakeSubagents();
  const links = new Map();

  const created = await subagents.invokeMcpTool(
    SUBAGENTS_SERVER_ID,
    SUBAGENTS_TOOL_CREATE,
    {
      name: "Original Agent",
      base_model_id: "base-model",
      system_prompt: "Original prompt.",
      description: "Original description",
      skill_ids: [skill.name],
      tool_server_ids: [server.id],
    },
    SUBAGENTS_PORT,
  );
  const localAgentId = created.data.id;

  const skillSolutionId = await publishOwned({
    marketplace,
    currentSolutionId: null,
    buildBundle: () =>
      buildPublishBundle({ type: TYPE_SKILLS, projectRoot, skill }),
  });
  const serverSolutionId = await publishOwned({
    marketplace,
    currentSolutionId: null,
    buildBundle: () =>
      buildPublishBundle({ type: TYPE_MCP_SERVERS, projectRoot, server }),
  });

  const originalSolutionId = await publishOwned({
    marketplace,
    currentSolutionId: null,
    buildBundle: async () =>
      buildPublishBundle({
        type: TYPE_PORTICO_AGENTS,
        agent: {
          ...(await subagents.getAgent({ model_id: localAgentId })).data,
          allowed_emails: ["prodlead@example.invalid", "ProdLead@example.invalid"],
          skill_refs: [{ skill_id: skill.name, solution_id: skillSolutionId }],
          tool_server_refs: [{ tool_server_id: server.id, solution_id: serverSolutionId }],
        },
      }),
  });
  links.set(localAgentId, originalSolutionId);

  const renamed = await subagents.invokeMcpTool(
    SUBAGENTS_SERVER_ID,
    SUBAGENTS_TOOL_UPDATE,
    {
      model_id: localAgentId,
      name: "Renamed Agent",
      description: "Original description",
      system_prompt: "Original prompt.",
      base_model_id: "base-model",
      skill_ids: [skill.name],
      tool_server_ids: [server.id],
    },
    SUBAGENTS_PORT,
  );
  assert.equal(renamed.data.id, localAgentId);
  assert.equal(renamed.data.name, "Renamed Agent");

  const reopened = await subagents.invokeMcpTool(
    SUBAGENTS_SERVER_ID,
    SUBAGENTS_TOOL_GET,
    { model_id: localAgentId },
    SUBAGENTS_PORT,
  );
  assert.equal(reopened.data.id, localAgentId);
  assert.equal(reopened.data.name, "Renamed Agent");

  const republishedSolutionId = await publishOwned({
    marketplace,
    currentSolutionId: links.get(localAgentId),
    buildBundle: () =>
      buildPublishBundle({
        type: TYPE_PORTICO_AGENTS,
        agent: {
          ...reopened.data,
          allowed_emails: ["prodlead@example.invalid"],
          skill_refs: [{ skill_id: skill.name, solution_id: skillSolutionId }],
          tool_server_refs: [{ tool_server_id: server.id, solution_id: serverSolutionId }],
        },
      }),
  });

  assert.equal(republishedSolutionId, originalSolutionId);
  assert.equal(links.get(localAgentId), originalSolutionId);
  assert.equal(marketplace.getBundle(republishedSolutionId).payload.name, "Renamed Agent");
  assert.deepEqual(marketplace.getBundle(republishedSolutionId).payload.allowed_emails, [
    "prodlead@example.invalid",
  ]);
});

test("agent bundle normalizes allowed emails", async () => {
  const bundle = await buildPublishBundle({
    type: TYPE_PORTICO_AGENTS,
    agent: {
      name: "Email Agent",
      description: "Checks email normalization.",
      base_model_id: "base-model",
      system_prompt: "Be precise.",
      allowed_emails: [" JDoe@example.invalid ", "asmith@example.invalid", "jdoe@example.invalid", ""],
    },
  });

  assert.deepEqual(bundle.payload.allowed_emails, ["jdoe@example.invalid", "asmith@example.invalid"]);
});

test("agent install guards known refs and fails closed when required skills cannot be installed", async () => {
  const projectRoot = await makeTempProjectRoot();
  const marketplace = new FakeMarketplace();
  const subagents = new FakeSubagents();
  const skillBundle = {
    type: TYPE_SKILLS,
    payload: {
      name: "Lifecycle Skill",
      skill_md: "# Lifecycle Skill\n",
    },
  };
  const skillSolutionId = marketplace.publish(skillBundle).data.id;
  const agentBundle = {
    type: TYPE_PORTICO_AGENTS,
    payload: {
      name: "Lifecycle Agent",
      base_model_id: "base-model",
      system_prompt: "Be lifecycle aware.",
      skill_ids: ["lifecycle-skill"],
      skill_refs: [{ skill_id: "lifecycle-skill", solution_id: skillSolutionId }],
      tool_server_ids: ["server:lifecycle-mcp"],
    },
  };

  let dependencyCalls = 0;
  const knownSkillInstall = await install({
    bundle: agentBundle,
    deps: agentInstallDeps(projectRoot, subagents, {
      installSkillDependency: async ({ expectedSkillId, solutionId }) => {
        dependencyCalls += 1;
        assert.equal(expectedSkillId, "lifecycle-skill");
        assert.equal(solutionId, skillSolutionId);
        return {
          id: "lifecycle-skill",
          localSkillId: "ai-marketplace/lifecycle-skill",
          installedPath: "skills-marketplace/ai-marketplace/lifecycle-skill",
          newlyInstalled: false,
          rollbackOnParentFailure: false,
        };
      },
      knownSkillIds: new Set(["ai-marketplace/lifecycle-skill"]),
      knownToolServerIds: new Set(["server:lifecycle-mcp"]),
    }),
  });

  assert.equal(dependencyCalls, 1);
  assert.deepEqual(subagents.createCalls.at(-1).skill_ids, [
    "ai-marketplace/lifecycle-skill",
  ]);
  assert.deepEqual(knownSkillInstall.installedSkills, []);
  assert.deepEqual(knownSkillInstall.unresolved.skill_ids, []);

  const previousCreateCount = subagents.createCalls.length;
  let failedSkillInstall = null;
  await assert.rejects(async () => {
    try {
      await install({
        bundle: agentBundle,
        deps: agentInstallDeps(projectRoot, subagents, {
          installSkillDependency: async () => {
            throw new Error("marketplace unavailable");
          },
          knownToolServerIds: new Set(["server:lifecycle-mcp"]),
        }),
      });
    } catch (caughtError) {
      failedSkillInstall = caughtError;
      throw caughtError;
    }
  });

  assert.equal(failedSkillInstall.code, "agent_dependency_install_failed");
  assert.equal(failedSkillInstall.body.failedSkills.length, 1);
  assert.equal(failedSkillInstall.body.failedSkills[0].skill_id, "lifecycle-skill");
  assert.equal(subagents.createCalls.length, previousCreateCount);
});
