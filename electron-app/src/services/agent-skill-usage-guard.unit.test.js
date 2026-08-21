// Behavioral tests for the referential-integrity guards: leaf-canonical
// matching across every skill_ids shape, fail-CLOSED inventory outages, and
// the published-agent dependency check for unpublishes (skill-links reverse
// lookup with zero MCP calls when nothing is linked). Transport and the
// agent-links registry are injected; skill-links runs REAL against a temp
// userData dir.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const skillLinks = require("./ai-marketplace-skill-links");
const {
  assertSkillDeletable,
  assertSolutionUnpublishable,
} = require("./agent-skill-usage-guard");

function transportFor(agents) {
  const calls = [];
  return {
    calls,
    invokeMcpTool: async (server, tool, args, port) => {
      calls.push({ server, tool, args, port });
      return { success: true, data: { agents } };
    },
  };
}

function tmpDeps() {
  return { userDataPath: fs.mkdtempSync(path.join(os.tmpdir(), "usage-guard-")) };
}

test("deletion blocks on any agent referencing the leaf, across id shapes, naming the agents", async () => {
  const { invokeMcpTool } = transportFor([
    { id: "a1", name: "Research Buddy", skill_ids: ["digest"] },
    {
      id: "a2",
      name: "Ops Helper",
      skill_ids: ["kwp/enterprise-search/digest", "pdf"],
    },
    { id: "a3", name: "Bystander", skill_ids: ["ai-marketplace/notes"] },
  ]);

  await assert.rejects(
    assertSkillDeletable({ leafName: "digest", invokeMcpTool }),
    (error) => {
      assert.equal(error.code, "skill_in_use_by_agents");
      assert.equal(error.status, 409);
      assert.match(error.message, /Research Buddy/);
      assert.match(error.message, /Ops Helper/);
      assert.deepEqual(error.body, {
        skill_id: "digest",
        agents: [
          { id: "a1", name: "Research Buddy" },
          { id: "a2", name: "Ops Helper" },
        ],
      });
      return true;
    },
  );

  // FQN input canonicalizes to the same leaf.
  await assert.rejects(
    assertSkillDeletable({
      leafName: "kwp/enterprise-search/digest",
      invokeMcpTool,
    }),
    (error) => error.code === "skill_in_use_by_agents",
  );

  // An unreferenced leaf passes.
  await assertSkillDeletable({ leafName: "unrelated", invokeMcpTool });
});

test("inventory outages fail CLOSED with a dedicated code", async () => {
  await assert.rejects(
    assertSkillDeletable({
      leafName: "digest",
      invokeMcpTool: async () => {
        throw new Error("docker down");
      },
    }),
    (error) => {
      assert.equal(error.code, "agent_inventory_unavailable");
      assert.match(error.message, /docker down/);
      return true;
    },
  );
  await assert.rejects(
    assertSkillDeletable({
      leafName: "digest",
      invokeMcpTool: async () => ({ success: false, error: "broker offline" }),
    }),
    (error) => error.code === "agent_inventory_unavailable",
  );
  await assert.rejects(
    assertSkillDeletable({
      leafName: "digest",
      invokeMcpTool: async () => ({ success: true, data: { nonsense: true } }),
    }),
    (error) => error.code === "agent_inventory_unavailable",
  );
});

test("unpublish blocks only when a PUBLISHED agent references a leaf linked to the solution", async () => {
  const deps = tmpDeps();
  await skillLinks.setLink("dep-skill", "sol-dep", deps);

  const agents = [
    // Published via the registry.
    { id: "pub-1", name: "Pub Agent", skill_ids: ["dep-skill"] },
    // Published via the model meta mirror only.
    {
      id: "pub-2",
      name: "Meta Agent",
      skill_ids: ["mp/plug/dep-skill"],
      marketplace_relationship: "published",
    },
    // Installed copy — never blocks.
    {
      id: "inst-1",
      name: "Installed Agent",
      skill_ids: ["dep-skill"],
      marketplace_relationship: "installed",
    },
  ];
  const { invokeMcpTool } = transportFor(agents);
  const registries = {
    skillLinks,
    agentLinks: {
      readState: async () => ({
        links: { "pub-1": { solutionId: "sol-agent", relationship: "published" } },
      }),
    },
  };

  await assert.rejects(
    assertSolutionUnpublishable({
      solutionId: "sol-dep",
      solutionType: "skills",
      invokeMcpTool,
      registries,
      deps,
    }),
    (error) => {
      assert.equal(error.code, "skill_dependency_of_published_agents");
      assert.match(error.message, /Pub Agent/);
      assert.match(error.message, /Meta Agent/);
      assert.doesNotMatch(error.message, /Installed Agent/);
      assert.deepEqual(
        error.body.agents.map((a) => a.id),
        ["pub-1", "pub-2"],
      );
      return true;
    },
  );

  // Installed-only referencing agents never block.
  const installedOnly = transportFor([agents[2]]);
  await assertSolutionUnpublishable({
    solutionId: "sol-dep",
    solutionType: "skills",
    invokeMcpTool: installedOnly.invokeMcpTool,
    registries: { skillLinks, agentLinks: { readState: async () => ({ links: {} }) } },
    deps,
  });
});

test("unpublish guard skips agent solutions and makes zero MCP calls when nothing is linked", async () => {
  const deps = tmpDeps();
  const transport = transportFor([
    { id: "a1", name: "Any", skill_ids: ["dep-skill"], marketplace_relationship: "published" },
  ]);
  const registries = {
    skillLinks,
    agentLinks: { readState: async () => ({ links: {} }) },
  };

  // Agent-type solutions are never guarded.
  await assertSolutionUnpublishable({
    solutionId: "sol-agent",
    solutionType: "portico-agents",
    invokeMcpTool: transport.invokeMcpTool,
    registries,
    deps,
  });
  assert.equal(transport.calls.length, 0);

  // A skill solution with no local link: reverse-lookup empties out before
  // any inventory read.
  await assertSolutionUnpublishable({
    solutionId: "sol-unknown",
    solutionType: "skills",
    invokeMcpTool: transport.invokeMcpTool,
    registries,
    deps,
  });
  assert.equal(transport.calls.length, 0, "no inventory read without linked leaves");
});

// ---------------------------------------------------------------------------
// Round 19: marketplace-wide sweep — assertSolutionUnpublishableOnMarketplace
// blocks unpublishing a skill listing referenced by ANY published agent on
// the Solutions Marketplace (fully injected: search + bundle reader).
// ---------------------------------------------------------------------------

const {
  assertSolutionUnpublishableOnMarketplace,
} = require("./agent-skill-usage-guard");

function agentSolution(id, refs, { inline = true, name = id } = {}) {
  const bundle = { type: "portico-agents", payload: { base_model_id: "gpt", skill_refs: refs } };
  return inline ? { id, name, bundle } : { id, name };
}

test("marketplace sweep: agent-type solutions never pay for the sweep", async () => {
  let searched = 0;
  await assertSolutionUnpublishableOnMarketplace({
    solutionId: "sol-agent",
    solutionType: "portico-agents",
    searchSolutions: async () => {
      searched += 1;
      return { results: [] };
    },
  });
  assert.equal(searched, 0);
});

test("marketplace sweep: inline envelope refs block with the agents named", async () => {
  await assert.rejects(
    assertSolutionUnpublishableOnMarketplace({
      solutionId: "sol-skill",
      solutionType: "skills",
      searchSolutions: async () => ({
        results: [
          agentSolution("agent-1", [{ skill_id: "notes", solution_id: "sol-skill" }], { name: "Research Buddy" }),
          agentSolution("agent-2", [{ skill_id: "other", solution_id: "sol-other" }]),
        ],
      }),
    }),
    (error) => {
      assert.equal(error.code, "skill_dependency_of_published_agents");
      assert.match(error.message, /"Research Buddy"/);
      assert.match(error.message, /Unpublish that agent first, then unpublish this skill\./);
      assert.deepEqual(error.body.agents.map((a) => a.id), ["agent-1"]);
      return true;
    },
  );
});

test("marketplace sweep: trimmed envelopes fetch bundles; a match blocks, clean passes", async () => {
  const bundleCalls = [];
  const run = (refsById) =>
    assertSolutionUnpublishableOnMarketplace({
      solutionId: "sol-skill",
      solutionType: "skills",
      searchSolutions: async () => ({
        results: [
          agentSolution("agent-a", null, { inline: false }),
          agentSolution("agent-b", null, { inline: false }),
        ],
      }),
      getSolutionBundle: async (id) => {
        bundleCalls.push(id);
        return { type: "portico-agents", payload: { base_model_id: "gpt", skill_refs: refsById[id] || [] } };
      },
    });

  await run({ "agent-a": [], "agent-b": [] });
  assert.deepEqual(bundleCalls, ["agent-a", "agent-b"]);

  await assert.rejects(
    run({ "agent-b": [{ skill_id: "notes", solution_id: "sol-skill" }] }),
    (error) => {
      assert.equal(error.code, "skill_dependency_of_published_agents");
      assert.deepEqual(error.body.agents.map((a) => a.id), ["agent-b"]);
      return true;
    },
  );
});

test("marketplace sweep: empty inline payloads count as trimmed (bundle decides)", async () => {
  await assert.rejects(
    assertSolutionUnpublishableOnMarketplace({
      solutionId: "sol-skill",
      solutionType: "skills",
      searchSolutions: async () => ({
        results: [{ id: "agent-x", name: "Empty Payload", bundle: { payload: {} } }],
      }),
      getSolutionBundle: async () => ({
        payload: { skill_refs: [{ skill_id: "notes", solution_id: "sol-skill" }] },
      }),
    }),
    (error) => error.code === "skill_dependency_of_published_agents",
  );
});

test("marketplace sweep: fails CLOSED when the sweep cannot complete", async () => {
  await assert.rejects(
    assertSolutionUnpublishableOnMarketplace({
      solutionId: "sol-skill",
      solutionType: "skills",
      searchSolutions: async () => {
        throw new Error("marketplace offline");
      },
    }),
    (error) => {
      assert.equal(error.code, "published_agent_check_unavailable");
      assert.match(error.message, /marketplace offline/);
      return true;
    },
  );

  await assert.rejects(
    assertSolutionUnpublishableOnMarketplace({
      solutionId: "sol-skill",
      solutionType: "skills",
      searchSolutions: async () => ({
        results: [agentSolution("agent-a", null, { inline: false })],
      }),
      getSolutionBundle: async () => {
        throw new Error("bundle read failed");
      },
    }),
    (error) => error.code === "published_agent_check_unavailable",
  );

  // No search collaborator at all: still blocked, never a silent pass.
  await assert.rejects(
    assertSolutionUnpublishableOnMarketplace({
      solutionId: "sol-skill",
      solutionType: "skills",
    }),
    (error) => error.code === "published_agent_check_unavailable",
  );
});

test("marketplace sweep: paginates full pages until the listing drains", async () => {
  const pages = [];
  const fullPage = Array.from({ length: 100 }, (_, i) =>
    agentSolution(`agent-${i}`, [{ skill_id: "x", solution_id: "sol-other" }]),
  );
  await assertSolutionUnpublishableOnMarketplace({
    solutionId: "sol-skill",
    solutionType: "skills",
    searchSolutions: async ({ page }) => {
      pages.push(page);
      return { results: page === 1 ? fullPage : [] };
    },
  });
  assert.deepEqual(pages, [1, 2]);
});

// ---------------------------------------------------------------------------
// collectPublishedAgentSolutionRefs — the sweep's reusable core, consumed by
// listPublished's dependency annotation and the unpublish guards.
// ---------------------------------------------------------------------------

const {
  collectPublishedAgentSolutionRefs,
} = require("./agent-skill-usage-guard");

test("ref collector aggregates every referenced solution across agents and dedups per agent", async () => {
  const referencedBy = await collectPublishedAgentSolutionRefs({
    searchSolutions: async () => ({
      results: [
        agentSolution(
          "agent-1",
          [
            { skill_id: "notes", solution_id: "sol-notes" },
            { skill_id: "art", solution_id: "sol-art" },
            // Duplicate ref to the same solution: one entry, not two.
            { skill_id: "notes-again", solution_id: "sol-notes" },
          ],
          { name: "Research Buddy" },
        ),
        agentSolution("agent-2", [{ skill_id: "notes", solution_id: "sol-notes" }]),
        agentSolution("agent-3", []),
      ],
    }),
  });

  assert.deepEqual(
    (referencedBy.get("sol-notes") || []).map((a) => a.id),
    ["agent-1", "agent-2"],
  );
  assert.equal(referencedBy.get("sol-notes")[0].name, "Research Buddy");
  assert.deepEqual(
    (referencedBy.get("sol-art") || []).map((a) => a.id),
    ["agent-1"],
  );
  assert.equal(referencedBy.get("sol-missing"), undefined);
});

test("ref collector reads trimmed envelopes through the bundle fetcher", async () => {
  const referencedBy = await collectPublishedAgentSolutionRefs({
    searchSolutions: async () => ({
      results: [
        agentSolution("agent-inline", [{ skill_id: "a", solution_id: "sol-a" }]),
        agentSolution("agent-trimmed", null, { inline: false }),
      ],
    }),
    getSolutionBundle: async (id) => {
      assert.equal(id, "agent-trimmed");
      return {
        type: "portico-agents",
        payload: {
          base_model_id: "gpt",
          skill_refs: [{ skill_id: "b", solution_id: "sol-b" }],
        },
      };
    },
  });

  assert.deepEqual((referencedBy.get("sol-a") || []).map((a) => a.id), ["agent-inline"]);
  assert.deepEqual((referencedBy.get("sol-b") || []).map((a) => a.id), ["agent-trimmed"]);
});

test("ref collector fails CLOSED when a bundle read fails", async () => {
  await assert.rejects(
    collectPublishedAgentSolutionRefs({
      searchSolutions: async () => ({
        results: [agentSolution("agent-trimmed", null, { inline: false })],
      }),
      getSolutionBundle: async () => {
        throw new Error("bundle backend down");
      },
    }),
    (error) => {
      assert.equal(error.code, "published_agent_check_unavailable");
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Search response shape robustness (2026-08-01 agentic sharing run): the
// sweep must accept the `solutions` key (the shape the marketplace client and
// every ai-marketplace-operations reader treat as primary) and must FAIL
// CLOSED on an unrecognized shape — an empty default silently unblocked
// unpublishes of skills that published agents depend on.
// ---------------------------------------------------------------------------

test("marketplace sweep: `solutions` response shape blocks like `results`", async () => {
  await assert.rejects(
    assertSolutionUnpublishableOnMarketplace({
      solutionId: "sol-skill",
      solutionType: "skills",
      searchSolutions: async () => ({
        solutions: [
          agentSolution("agent-1", [{ skill_id: "notes", solution_id: "sol-skill" }], {
            name: "Solutions Shape Agent",
          }),
        ],
      }),
    }),
    (error) => {
      assert.equal(error.code, "skill_dependency_of_published_agents");
      assert.match(error.message, /"Solutions Shape Agent"/);
      return true;
    },
  );
});

test("marketplace sweep: nested data.solutions shape blocks too", async () => {
  await assert.rejects(
    assertSolutionUnpublishableOnMarketplace({
      solutionId: "sol-skill",
      solutionType: "skills",
      searchSolutions: async () => ({
        data: {
          solutions: [
            agentSolution("agent-1", [{ skill_id: "notes", solution_id: "sol-skill" }]),
          ],
        },
      }),
    }),
    (error) => {
      assert.equal(error.code, "skill_dependency_of_published_agents");
      return true;
    },
  );
});

test("marketplace sweep: unrecognized search shape fails CLOSED", async () => {
  await assert.rejects(
    assertSolutionUnpublishableOnMarketplace({
      solutionId: "sol-skill",
      solutionType: "skills",
      searchSolutions: async () => ({ hits: [] }),
    }),
    (error) => {
      assert.equal(error.code, "published_agent_check_unavailable");
      assert.match(error.message, /unrecognized search response shape/);
      return true;
    },
  );
});
