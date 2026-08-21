const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { runAgentSkillRelinkSweep } = require("./agent-skill-relink");
const agentFlags = require("./agent-local-flags");

function flagDeps() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-relink-test-"));
  return { dir, deps: { userDataPath: dir } };
}

// Flags module bound to a temp store so sweeps observe/write real flag state.
function boundFlags(deps) {
  return {
    setSkillsNotFoundFlags: (entries) => agentFlags.setSkillsNotFoundFlags(entries, deps),
    reconcileSkillsNotFoundFlags: (input) =>
      agentFlags.reconcileSkillsNotFoundFlags(input, deps),
    listFlags: () => agentFlags.listFlags(deps),
  };
}

const LEAF_RENAME = {
  from: { marketplaceId: "mp", pluginName: "ux", skillId: "old-leaf" },
  to: { marketplaceId: "mp", pluginName: "ux", skillId: "new-leaf" },
};
const PLUGIN_ONLY = {
  from: { marketplaceId: "mp", pluginName: "ux-beta", skillId: "same-leaf" },
  to: { marketplaceId: "mp", pluginName: "ux", skillId: "same-leaf" },
};

function toolsWith(agents, { failUpdate = false } = {}) {
  const updates = [];
  return {
    updates,
    listAgents: async () => agents,
    updateAgentSkillIds: async (agentId, skillIds) => {
      if (failUpdate) throw new Error("update rejected");
      updates.push({ agentId, skillIds });
    },
  };
}

const installed = (leaves) =>
  async () => leaves.map((skillId) => ({ marketplaceId: "mp", skillId }));

test("leaf renames rewrite all three reference shapes for editable agents, preserving shape and order", async () => {
  const { dir, deps } = flagDeps();
  try {
    const tools = toolsWith([
      {
        id: "agent-edit",
        name: "Edit Agent",
        relationship: null,
        readOnly: false,
        skillIds: [
          "old-leaf",
          "mp/old-leaf",
          "mp/ux/old-leaf",
          "unrelated-skill",
        ],
      },
    ]);
    const summary = await runAgentSkillRelinkSweep({
      projectRoot: "/nonexistent",
      migrations: [LEAF_RENAME, PLUGIN_ONLY],
      agentTools: tools,
      agentFlags: boundFlags(deps),
      loadInstalledSkills: installed(["new-leaf", "same-leaf"]),
    });

    assert.equal(summary.refsRewritten, 3);
    // Three shapes rewritten in place; the duplicate-producing forms dedupe
    // is not triggered here (distinct shapes stay distinct).
    assert.deepEqual(tools.updates, [
      {
        agentId: "agent-edit",
        skillIds: ["new-leaf", "mp/new-leaf", "mp/ux/new-leaf", "unrelated-skill"],
      },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("plugin-only migrations rewrite nothing (leaf-canonical resolution keeps them working)", async () => {
  const { dir, deps } = flagDeps();
  try {
    const tools = toolsWith([
      {
        id: "agent-edit",
        name: "Edit Agent",
        relationship: null,
        readOnly: false,
        skillIds: ["same-leaf", "mp/ux-beta/same-leaf"],
      },
    ]);
    const summary = await runAgentSkillRelinkSweep({
      projectRoot: "/nonexistent",
      migrations: [PLUGIN_ONLY],
      agentTools: tools,
      agentFlags: boundFlags(deps),
      loadInstalledSkills: installed(["same-leaf"]),
    });
    assert.equal(summary.refsRewritten, 0);
    assert.deepEqual(tools.updates, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("bare-leaf hijack guard: an old leaf still owned by another installed skill blocks the rename", async () => {
  const { dir, deps } = flagDeps();
  try {
    const tools = toolsWith([
      {
        id: "agent-edit",
        name: "Edit Agent",
        relationship: null,
        readOnly: false,
        skillIds: ["old-leaf"],
      },
    ]);
    const summary = await runAgentSkillRelinkSweep({
      projectRoot: "/nonexistent",
      migrations: [LEAF_RENAME],
      agentTools: tools,
      agentFlags: boundFlags(deps),
      // Another skill (any identity) still owns "old-leaf" locally.
      loadInstalledSkills: installed(["old-leaf", "new-leaf"]),
    });
    assert.deepEqual(tools.updates, []);
    assert.deepEqual(summary.skipped, [
      { from: "old-leaf", to: "new-leaf", reason: "old_leaf_still_installed" },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("read-only agents are never written — they get SKILLS_NOT_FOUND flags", async () => {
  const { dir, deps } = flagDeps();
  const flags = boundFlags(deps);
  try {
    const tools = toolsWith([
      {
        id: "agent-ro",
        name: "RO Agent",
        relationship: "installed",
        readOnly: true,
        skillIds: ["old-leaf"],
      },
    ]);
    const summary = await runAgentSkillRelinkSweep({
      projectRoot: "/nonexistent",
      migrations: [LEAF_RENAME],
      agentTools: tools,
      agentFlags: flags,
      loadInstalledSkills: installed(["new-leaf"]),
    });
    assert.deepEqual(tools.updates, []);
    assert.deepEqual(summary.agentsFlagged, [{ id: "agent-ro", name: "RO Agent" }]);
    const stored = await flags.listFlags();
    assert.deepEqual(stored["agent-ro"][0].skills, ["old-leaf"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the sweep is idempotent and its reconcile pass retires resolved flags", async () => {
  const { dir, deps } = flagDeps();
  const flags = boundFlags(deps);
  try {
    // Seed a stale flag: the owner has since republished — the agent no
    // longer references the broken skill.
    await flags.setSkillsNotFoundFlags([
      { agentId: "agent-ro", skills: ["old-leaf"] },
    ]);

    const healedAgents = [
      {
        id: "agent-edit",
        name: "Edit Agent",
        relationship: null,
        readOnly: false,
        skillIds: ["new-leaf"],
      },
      {
        id: "agent-ro",
        name: "RO Agent",
        relationship: "installed",
        readOnly: true,
        skillIds: ["new-leaf"],
      },
    ];
    const tools = toolsWith(healedAgents);
    const summary = await runAgentSkillRelinkSweep({
      projectRoot: "/nonexistent",
      migrations: [LEAF_RENAME],
      agentTools: tools,
      agentFlags: flags,
      loadInstalledSkills: installed(["new-leaf"]),
    });

    assert.deepEqual(tools.updates, [], "healed agents are not rewritten again");
    assert.equal(summary.flagsReconciled, true);
    assert.deepEqual(await flags.listFlags(), {}, "resolved flags retire");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unavailable agent inventory makes the sweep a silent no-op", async () => {
  const { dir, deps } = flagDeps();
  try {
    const summary = await runAgentSkillRelinkSweep({
      projectRoot: "/nonexistent",
      migrations: [LEAF_RENAME],
      agentTools: {
        listAgents: async () => {
          throw new Error("subagents down");
        },
        updateAgentSkillIds: async () => {},
      },
      agentFlags: boundFlags(deps),
      loadInstalledSkills: installed(["new-leaf"]),
      logger: { warn: () => {} },
    });
    assert.deepEqual(summary.agentsUpdated, []);
    assert.equal(summary.flagsReconciled, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed editable update is reported and does not abort the sweep", async () => {
  const { dir, deps } = flagDeps();
  try {
    const tools = toolsWith(
      [
        {
          id: "agent-edit",
          name: "Edit Agent",
          relationship: null,
          readOnly: false,
          skillIds: ["old-leaf"],
        },
      ],
      { failUpdate: true },
    );
    const summary = await runAgentSkillRelinkSweep({
      projectRoot: "/nonexistent",
      migrations: [LEAF_RENAME],
      agentTools: tools,
      agentFlags: boundFlags(deps),
      loadInstalledSkills: installed(["new-leaf"]),
    });
    assert.deepEqual(summary.agentsUpdated, []);
    assert.equal(summary.skipped[0].reason, "agent_update_failed");
    assert.equal(summary.flagsReconciled, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
