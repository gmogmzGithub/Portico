// Agent <-> dependent skill bundling.
// Agent Skills + MCP Orchestration layers. Verifies that publishing an agent
// embeds skill_refs in the bundle, and that installing an agent fetches and
// installs the referenced skills, remapping skill_ids to the canonical
// installed ids.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const {
  TYPE_PORTICO_AGENTS,
  TYPE_SKILLS,
  buildPublishBundle,
  install,
} = require("./ai-marketplace-install");

async function makeTempProjectRoot() {
  return await fs.mkdtemp(
    path.join(os.tmpdir(), "portico-agent-skill-deps-"),
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

test("buildPublishBundle embeds skill_refs in the agent bundle", async () => {
  const bundle = await buildPublishBundle({
    type: TYPE_PORTICO_AGENTS,
    agent: {
      name: "Data Analyst",
      base_model_id: "Atlas Opus",
      system_prompt: "Be precise.",
      skill_ids: ["incident-review", "company-knowledge"],
      skill_refs: [
        { skill_id: "incident-review", solution_id: "sol-123" },
        // Malformed refs are dropped.
        { skill_id: "", solution_id: "sol-x" },
        { skill_id: "company-knowledge" },
      ],
      tool_server_ids: ["server:glean"],
      tool_server_refs: [
        { tool_server_id: "server:glean", solution_id: "sol-glean" },
        // Malformed refs are dropped.
        { tool_server_id: "", solution_id: "sol-x" },
        { tool_server_id: "server:slack" },
      ],
    },
  });

  assert.equal(bundle.type, TYPE_PORTICO_AGENTS);
  // Solution refs normalize to the explicit discriminated shape (kind is
  // "solution" when absent) so old and new publishers embed the same union.
  assert.deepEqual(bundle.payload.skill_refs, [
    { kind: "solution", skill_id: "incident-review", solution_id: "sol-123" },
  ]);
  assert.deepEqual(bundle.payload.tool_server_refs, [
    { tool_server_id: "server:glean", solution_id: "sol-glean" },
  ]);
});

test("installAgent fetches+installs referenced skills and remaps skill_ids", async () => {
  const projectRoot = await makeTempProjectRoot();

  const fetched = [];
  const fetchSolutionBundle = async (solutionId) => {
    fetched.push(solutionId);
    return {
      type: TYPE_SKILLS,
      payload: {
        name: "Incident Review",
        skill_md: "# Incident Review\n",
      },
    };
  };

  let createArgs = null;
  const invokeMcpTool = async (_serverId, _tool, args) => {
    createArgs = args;
    return { success: true, data: { id: args.model_id } };
  };

  const bundle = {
    type: TYPE_PORTICO_AGENTS,
    payload: {
      name: "Data Analyst",
      base_model_id: "Atlas Opus",
      system_prompt: "Be precise.",
      skill_ids: ["incident-review"],
      skill_refs: [{ skill_id: "incident-review", solution_id: "sol-123" }],
    },
  };

  const result = await install({
    bundle,
    deps: agentInstallDeps(projectRoot, {
      invokeMcpTool,
      fetchSolutionBundle,
    }),
  });

  assert.deepEqual(fetched, ["sol-123"]);
  // Original id is remapped to the canonical installed id and wired to the agent.
  assert.deepEqual(createArgs.skill_ids, ["ai-marketplace/incident-review"]);
  assert.equal(result.installedSkills.length, 1);
  assert.equal(
    result.installedSkills[0].installed_id,
    "ai-marketplace/incident-review",
  );
  assert.equal(result.mutation, "created");
  assert.deepEqual(result.unresolved.skill_ids, []);

  // Skill content was written to disk under the marketplace skill root.
  const skillMd = await fs.readFile(
    path.join(
      projectRoot,
      "skills-marketplace",
      "ai-marketplace",
      "incident-review",
      "SKILL.md",
    ),
    "utf8",
  );
  assert.equal(skillMd, "# Incident Review\n");
});

test("installAgent does not write unavailable referenced skills", async () => {
  const projectRoot = await makeTempProjectRoot();
  let createCalls = 0;
  const unavailable = Object.assign(new Error("Solution not found"), {
    code: "not_found",
    status: 404,
  });

  const bundle = {
    type: TYPE_PORTICO_AGENTS,
    payload: {
      name: "Data Analyst",
      base_model_id: "Atlas Opus",
      system_prompt: "Be precise.",
      skill_ids: ["incident-review"],
      skill_refs: [{ skill_id: "incident-review", solution_id: "deleted-skill" }],
    },
  };

  await assert.rejects(
    () =>
      install({
        bundle,
        deps: agentInstallDeps(projectRoot, {
          fetchSolutionBundle: async () => {
            throw unavailable;
          },
          invokeMcpTool: async () => {
            createCalls += 1;
            return { success: true, data: { id: "data-analyst" } };
          },
        }),
      }),
    (error) => {
      assert.equal(error.code, "agent_dependency_install_failed");
      assert.equal(error.body.failedSkills.length, 1);
      assert.equal(error.body.failedSkills[0].solution_id, "deleted-skill");
      assert.match(error.body.failedSkills[0].error, /Solution not found/);
      return true;
    },
  );

  assert.equal(createCalls, 0);
  await assert.rejects(() =>
    fs.access(
      path.join(
        projectRoot,
        "skills-marketplace",
        "ai-marketplace",
        "incident-review",
        "SKILL.md",
      ),
    ),
  );
});

test("installAgent skips unreferenced skills already present locally", async () => {
  const projectRoot = await makeTempProjectRoot();

  let fetchCalls = 0;
  const fetchSolutionBundle = async () => {
    fetchCalls += 1;
    throw new Error("should not fetch a known skill");
  };

  let createArgs = null;
  const invokeMcpTool = async (_serverId, _tool, args) => {
    createArgs = args;
    return { success: true, data: { id: args.model_id } };
  };

  const bundle = {
    type: TYPE_PORTICO_AGENTS,
    payload: {
      name: "Data Analyst",
      base_model_id: "Atlas Opus",
      system_prompt: "Be precise.",
      skill_ids: ["incident-review"],
      skill_refs: [],
    },
  };

  const result = await install({
    bundle,
    deps: agentInstallDeps(projectRoot, {
      invokeMcpTool,
      fetchSolutionBundle,
      knownSkillIds: new Set(["ai-marketplace/incident-review"]),
    }),
  });

  assert.equal(fetchCalls, 0);
  assert.deepEqual(createArgs.skill_ids, ["ai-marketplace/incident-review"]);
  assert.equal(result.installedSkills.length, 0);
  assert.deepEqual(result.unresolved.skill_ids, []);
});

test("referenced known skills still pass through the provenance guard", async () => {
  const projectRoot = await makeTempProjectRoot();
  const dependencyCalls = [];
  let createArgs = null;

  const result = await install({
    bundle: {
      type: TYPE_PORTICO_AGENTS,
      payload: {
        name: "Known Guarded Agent",
        base_model_id: "Atlas Opus",
        system_prompt: "Use the referenced skill.",
        skill_ids: ["incident-review"],
        skill_refs: [{ skill_id: "incident-review", solution_id: "sol-123" }],
      },
    },
    deps: agentInstallDeps(projectRoot, {
      knownSkillIds: new Set(["ai-marketplace/incident-review"]),
      installSkillDependency: async (request) => {
        dependencyCalls.push(request);
        return {
          id: "incident-review",
          localSkillId: "ai-marketplace/incident-review",
          installedPath: "skills-marketplace/ai-marketplace/incident-review",
          newlyInstalled: false,
          rollbackOnParentFailure: false,
        };
      },
      invokeMcpTool: async (_serverId, _tool, args) => {
        createArgs = args;
        return { success: true, data: { id: args.model_id } };
      },
    }),
  });

  assert.deepEqual(dependencyCalls, [
    { expectedSkillId: "incident-review", solutionId: "sol-123" },
  ]);
  assert.deepEqual(createArgs.skill_ids, ["ai-marketplace/incident-review"]);
  assert.deepEqual(result.installedSkills, []);
});

test("installAgent aborts and rolls back when a required dependent skill install fails", async () => {
  const projectRoot = await makeTempProjectRoot();

  let createCalls = 0;
  const fetchSolutionBundle = async (solutionId) => {
    if (solutionId === "sol-123") {
      return {
        type: TYPE_SKILLS,
        payload: {
          name: "Incident Review",
          skill_md: "# Incident Review\n",
        },
      };
    }
    throw new Error("network down");
  };

  const invokeMcpTool = async () => {
    createCalls += 1;
    return { success: true, data: { id: "agent-2" } };
  };

  const bundle = {
    type: TYPE_PORTICO_AGENTS,
    payload: {
      name: "Data Analyst",
      base_model_id: "Atlas Opus",
      system_prompt: "Be precise.",
      skill_ids: ["incident-review", "n8nkit"],
      skill_refs: [
        { skill_id: "incident-review", solution_id: "sol-123" },
        { skill_id: "n8nkit", solution_id: "sol-456" },
      ],
    },
  };

  let error = null;
  await assert.rejects(async () => {
    try {
      await install({
        bundle,
        deps: agentInstallDeps(projectRoot, {
          invokeMcpTool,
          fetchSolutionBundle,
        }),
      });
    } catch (caughtError) {
      error = caughtError;
      throw caughtError;
    }
  });

  assert.equal(error.code, "agent_dependency_install_failed");
  assert.equal(createCalls, 0);
  assert.equal(error.body.failedSkills.length, 1);
  assert.equal(error.body.failedSkills[0].skill_id, "n8nkit");
  assert.equal(error.body.rollback.length, 1);
  assert.equal(error.body.rollback[0].cleaned, true);
  await assert.rejects(() =>
    fs.readFile(
      path.join(
        projectRoot,
        "skills-marketplace",
        "ai-marketplace",
        "incident-review",
        "SKILL.md",
      ),
      "utf8",
    ),
  );
});

test("installAgent updates an existing linked agent and installs newly required skills", async () => {
  const projectRoot = await makeTempProjectRoot();

  const fetchSolutionBundle = async () => ({
    type: TYPE_SKILLS,
    payload: {
      name: "n8nkit",
      skill_md: "# n8nkit\n",
    },
  });

  const calls = [];
  const invokeMcpTool = async (_serverId, tool, args) => {
    calls.push({ tool, args });
    return { success: true, data: { id: "agent-1", ...args } };
  };

  const bundle = {
    type: TYPE_PORTICO_AGENTS,
    payload: {
      name: "Automation Agent",
      base_model_id: "Atlas Opus",
      system_prompt: "Automate workflows.",
      skill_ids: ["n8nkit"],
      skill_refs: [{ skill_id: "n8nkit", solution_id: "sol-n8nkit" }],
    },
  };

  const result = await install({
    bundle,
    deps: agentInstallDeps(projectRoot, {
      existingAgentId: "agent-1",
      invokeMcpTool,
      fetchSolutionBundle,
    }),
  });

  assert.equal(result.mutation, "updated");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, "subagents_update_agent");
  assert.equal(calls[0].args.model_id, "agent-1");
  assert.deepEqual(calls[0].args.skill_ids, ["ai-marketplace/n8nkit"]);
});

test("installAgent rolls back newly installed skills when updating the agent fails", async () => {
  const projectRoot = await makeTempProjectRoot();

  const fetchSolutionBundle = async () => ({
    type: TYPE_SKILLS,
    payload: {
      name: "n8nkit",
      skill_md: "# n8nkit\n",
    },
  });

  const invokeMcpTool = async (_serverId, tool) => {
    if (tool === "subagents_update_agent") {
      return { success: false, data: { error: "validation failed" } };
    }
    throw new Error(`Unexpected tool: ${tool}`);
  };

  const bundle = {
    type: TYPE_PORTICO_AGENTS,
    payload: {
      name: "Automation Agent",
      base_model_id: "Atlas Opus",
      system_prompt: "Automate workflows.",
      skill_ids: ["n8nkit"],
      skill_refs: [{ skill_id: "n8nkit", solution_id: "sol-n8nkit" }],
    },
  };

  let error = null;
  await assert.rejects(async () => {
    try {
      await install({
        bundle,
        deps: agentInstallDeps(projectRoot, {
          existingAgentId: "agent-1",
          invokeMcpTool,
          fetchSolutionBundle,
        }),
      });
    } catch (caughtError) {
      error = caughtError;
      throw caughtError;
    }
  });

  assert.equal(error.code, "agent_update_failed");
  assert.equal(error.body.rollback.length, 1);
  assert.equal(error.body.rollback[0].cleaned, true);
  await assert.rejects(() =>
    fs.readFile(
      path.join(
        projectRoot,
        "skills-marketplace",
        "ai-marketplace",
        "n8nkit",
        "SKILL.md",
      ),
      "utf8",
    ),
  );
});


test("guarded dependency reuse remaps the skill without reporting a new install", async () => {
  const projectRoot = await makeTempProjectRoot();
  const dependencyCalls = [];
  let createArgs = null;
  const result = await install({
    bundle: {
      type: TYPE_PORTICO_AGENTS,
      payload: {
        name: "Guarded Agent",
        base_model_id: "Atlas Opus",
        system_prompt: "Use the guarded dependency.",
        skill_ids: ["incident-review"],
        skill_refs: [{ skill_id: "incident-review", solution_id: "sol-123" }],
      },
    },
    deps: agentInstallDeps(projectRoot, {
      installSkillDependency: async (request) => {
        dependencyCalls.push(request);
        return {
          id: "incident-review",
          localSkillId: "ai-marketplace/incident-review",
          installedPath: "skills-marketplace/ai-marketplace/incident-review",
          newlyInstalled: false,
          rollbackOnParentFailure: false,
        };
      },
      invokeMcpTool: async (_serverId, _tool, args) => {
        createArgs = args;
        return { success: true, data: { id: args.model_id, ...args } };
      },
    }),
  });

  assert.deepEqual(dependencyCalls, [
    { expectedSkillId: "incident-review", solutionId: "sol-123" },
  ]);
  assert.deepEqual(createArgs.skill_ids, ["ai-marketplace/incident-review"]);
  assert.deepEqual(result.installedSkills, []);
});

test("a later agent failure rolls back a freshly installed guarded dependency", async () => {
  const projectRoot = await makeTempProjectRoot();
  const installedPath = "skills-marketplace/ai-marketplace/incident-review";
  const skillFile = path.join(projectRoot, installedPath, "SKILL.md");
  await fs.mkdir(path.dirname(skillFile), { recursive: true });
  await fs.writeFile(skillFile, "# Fresh dependency\n", "utf8");
  await fs.writeFile(
    path.join(projectRoot, "marketplaces.json"),
    JSON.stringify({
      marketplaces: [],
      installedSkills: [
        {
          marketplaceId: "ai-marketplace",
          skillId: "incident-review",
          localPath: installedPath,
        },
      ],
    }),
    "utf8",
  );

  let caught = null;
  await assert.rejects(
    async () => {
      try {
        await install({
          bundle: {
            type: TYPE_PORTICO_AGENTS,
            payload: {
              name: "Failing Fresh Agent",
              base_model_id: "Atlas Opus",
              system_prompt: "Fail after dependency resolution.",
              skill_ids: ["incident-review"],
              skill_refs: [
                { skill_id: "incident-review", solution_id: "sol-123" },
              ],
            },
          },
          deps: agentInstallDeps(projectRoot, {
            installSkillDependency: async () => ({
              id: "incident-review",
              localSkillId: "ai-marketplace/incident-review",
              installedPath,
              newlyInstalled: true,
              rollbackOnParentFailure: true,
            }),
            invokeMcpTool: async (_serverId, tool) => {
              if (tool === "subagents_create_agent") {
                return { success: false, data: { error: "agent validation failed" } };
              }
              if (tool === "subagents_delete_agent") {
                return { success: true, data: {} };
              }
              throw new Error("Unexpected tool: " + tool);
            },
          }),
        });
      } catch (error) {
        caught = error;
        throw error;
      }
    },
    /agent validation failed/,
  );

  assert.equal(caught.body.rollback[0].cleaned, true);
  await assert.rejects(() => fs.access(skillFile));
  const config = JSON.parse(
    await fs.readFile(path.join(projectRoot, "marketplaces.json"), "utf8"),
  );
  assert.deepEqual(config.installedSkills, []);
});

test("a later agent failure never removes a dependency reused by the guarded path", async () => {
  const projectRoot = await makeTempProjectRoot();
  const installedPath = "skills-marketplace/ai-marketplace/incident-review";
  const skillFile = path.join(projectRoot, installedPath, "SKILL.md");
  await fs.mkdir(path.dirname(skillFile), { recursive: true });
  await fs.writeFile(skillFile, "# Existing dependency\n", "utf8");

  await assert.rejects(
    () =>
      install({
        bundle: {
          type: TYPE_PORTICO_AGENTS,
          payload: {
            name: "Failing Guarded Agent",
            base_model_id: "Atlas Opus",
            system_prompt: "Fail after dependency resolution.",
            skill_ids: ["incident-review"],
            skill_refs: [
              { skill_id: "incident-review", solution_id: "sol-123" },
            ],
          },
        },
        deps: agentInstallDeps(projectRoot, {
          installSkillDependency: async () => ({
            id: "incident-review",
            localSkillId: "ai-marketplace/incident-review",
            installedPath,
            newlyInstalled: false,
            rollbackOnParentFailure: false,
          }),
          invokeMcpTool: async (_serverId, tool) => {
            if (tool === "subagents_create_agent") {
              return { success: false, data: { error: "agent validation failed" } };
            }
            if (tool === "subagents_delete_agent") {
              return { success: true, data: {} };
            }
            throw new Error(`Unexpected tool: ${tool}`);
          },
        }),
      }),
    /agent validation failed/,
  );

  assert.equal(await fs.readFile(skillFile, "utf8"), "# Existing dependency\n");
});
