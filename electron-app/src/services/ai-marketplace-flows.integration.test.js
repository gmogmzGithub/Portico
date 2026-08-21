// Integration suite: the REAL marketplace stack (renderer planners via the
// vm bridge + operations + install + marketplace-service + link registries +
// HTTP client) exercised against a mock marketplace server and temp roots.
// Two simulated machines belonging to the same user: "publisher" authors and
// publishes; "laptop" installs, updates, and reclaims. Run with:
//   npm run test:marketplace-flows   (electron-app/)
const test = require("node:test");
const assert = require("node:assert/strict");
const { before, after } = require("node:test");
const fsp = require("node:fs/promises");
const path = require("node:path");

const {
  startMockMarketplace,
  loadRealMarketplaceStack,
  createMachine,
  setActiveMachine,
  seedSkill,
  installGitFetchRouter,
  loadAgentsRendererBridge,
} = require("./ai-marketplace-integration-fixture");

const VIEWER = "dsantiago@example.invalid";
const PROMPT_MARKER = "MARKER-ITEST-PROMPT-77f0";
const DESC_MARKER = "MARKER-ITEST-DESC-31c9";
const GIT_MARKETPLACE = "fixture-agent-skills";
// Round 9: the add-gate allowlist applies to agent-install auto-adds too, so
// the fixture's git marketplace must live at an approved repo.
const GIT_REPO = "anthropics/skills";
const DISALLOWED_GIT_REPO = "fixtureorg/skills";

let market;
let stack;
let publisher;
let laptop;
let bridge; // renderer planners bound to whichever machine is active
let restoreFetch;
const consoleLines = [];
const consoleOriginals = {};

// World state threaded across scenarios (tests in a file run serially).
const world = {
  agentListingId: null,
  notesListingId: null,
  laptopAgentId: null,
};

before(async () => {
  for (const level of ["log", "warn", "error", "info"]) {
    consoleOriginals[level] = console[level];
    console[level] = (...args) =>
      consoleLines.push(
        args
          .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
          .join(" "),
      );
  }

  market = await startMockMarketplace();
  restoreFetch = installGitFetchRouter({
    [GIT_REPO]: {
      ref: "main",
      marketplaceName: GIT_MARKETPLACE,
      skills: {
        "algorithmic-art": {
          "SKILL.md":
            '---\nname: algorithmic-art\ndescription: fixture art skill\nversion: "1.0"\n---\n\n# algorithmic-art\n',
        },
      },
    },
    // Second allowlisted repo: the bundle source for the git-referenced
    // listing scenarios (backend cannot serve those bundles; the app
    // materializes them from git).
    "anthropics/knowledge-work-plugins": {
      ref: "main",
      marketplaceName: "kwp-fixture",
      skills: {
        "indexed-jobs": {
          "SKILL.md":
            '---\nname: indexed-jobs\ndescription: fixture ops skill\nversion: "1.0"\n---\n\n# indexed-jobs\n',
          "runbook.md": "fixture runbook reference",
        },
      },
    },
  });

  publisher = await createMachine("publisher", { viewerEmail: VIEWER });
  laptop = await createMachine("laptop", { viewerEmail: VIEWER });
  setActiveMachine(publisher);
  stack = loadRealMarketplaceStack({ baseUrl: market.baseUrl });
  bridge = loadAgentsRendererBridge(stack);
});

after(async () => {
  try {
    await market?.close();
    restoreFetch?.();
  } finally {
    for (const [level, original] of Object.entries(consoleOriginals)) {
      console[level] = original;
    }
  }
});

test("publisher: agent with mixed deps publishes reference-only skill_refs", async () => {
  setActiveMachine(publisher);
  await seedSkill(publisher.projectRoot, "system", "web-search");
  await seedSkill(publisher.projectRoot, "user", "notes", { createdByEmail: VIEWER });
  // Install the git-marketplace skill on the publisher (its origin for refs).
  // Round 9: the fixture manifest is a plugin with a skills array, so the
  // install lands plugin-scoped and returns the fully-qualified local id —
  // the same id production writes into the agent's skill_ids.
  const gitDep = await stack.ops.installGitMarketplaceSkillDependency({
    ref: {
      skill_id: "algorithmic-art",
      kind: "git-marketplace",
      solution_id: null,
      marketplace: {
        name: GIT_MARKETPLACE,
        source: { type: "github", repo: GIT_REPO, ref: "main" },
      },
      skill_path: "./skills/algorithmic-art",
      skill_source: null,
    },
    interactiveAuth: false,
  });
  world.gitSkillLocalId = gitDep.localSkillId;
  assert.equal(
    world.gitSkillLocalId,
    `${GIT_MARKETPLACE}/${GIT_MARKETPLACE}/algorithmic-art`,
    "plugin-scoped install returns the FQN",
  );

  const skillIds = ["web-search", "notes", world.gitSkillLocalId];
  // Seed the local agent record (what the OWUI store would hold).
  publisher.subagents.agents.set("fixture-agent", {
    id: "fixture-agent",
    name: "Fixture Agent",
    base_model_id: "Claude Haiku 4.5",
    system_prompt: PROMPT_MARKER,
    description: DESC_MARKER,
    skill_ids: skillIds,
    tool_server_ids: [],
    reasoning_effort: "medium",
    creation_source: "local",
    created_by_email: VIEWER,
  });

  const resolution =
    await bridge.window.AgentsPublishHooks.resolveDependentSkillPlans(skillIds);
  assert.equal(resolution.errors.length, 0, JSON.stringify(resolution.errors));
  assert.deepEqual(
    JSON.parse(JSON.stringify(resolution.plans)).map((plan) => plan.provenance),
    ["system", "user-new", "installed-git"],
  );

  const published = await bridge.window.AgentsPublishHooks.pushAgentToMarketplace({
    localId: "fixture-agent",
    solutionId: "",
    args: {
      name: "Fixture Agent",
      description: DESC_MARKER,
      base_model_id: "Claude Haiku 4.5",
      system_prompt: PROMPT_MARKER,
      skill_ids: skillIds,
      tool_server_ids: [],
      reasoning_effort: "medium",
      allowed_emails: null,
    },
    resolvedSkillPlan: resolution.plans,
  });

  world.agentListingId = published.solutionId;
  assert.ok(world.agentListingId, "agent listing created");
  assert.equal(published.skillPublishSummary.published, 1, "notes published");
  assert.equal(published.skillPublishSummary.gitReferenced, 1);

  const notesListing = market.findByName("notes");
  assert.ok(notesListing, "notes listing exists on the marketplace");
  world.notesListingId = notesListing.id;

  const agentListing = market.solutions.get(world.agentListingId);
  const payload = agentListing.bundle.payload;
  const refs = payload.skill_refs;
  assert.equal(refs.length, 2, "system skills carry no ref");
  const notesRef = refs.find((ref) => ref.skill_id === "notes");
  assert.equal(notesRef.kind, "solution");
  assert.equal(notesRef.solution_id, world.notesListingId);
  const gitRef = refs.find((ref) => ref.skill_id === "algorithmic-art");
  assert.equal(gitRef.kind, "git-marketplace");
  assert.equal(gitRef.marketplace.source.repo, GIT_REPO);

  const link = await stack.skillLinks.getLink("notes");
  assert.equal(link.solutionId, world.notesListingId);
  assert.equal(link.hasLocalChanges, false);
});

test("laptop: installing the agent provisions solution and git deps for real", async () => {
  setActiveMachine(laptop);
  await seedSkill(laptop.projectRoot, "system", "web-search");

  const result = await stack.ops.install(world.agentListingId, {
    interactiveAuth: false,
  });

  world.laptopAgentId = result.created.id;
  assert.equal(result.mutation, "created");
  assert.equal(result.created.marketplace_relationship, "installed");
  assert.deepEqual(
    result.created.skill_ids.slice().sort(),
    [
      "ai-marketplace/notes",
      world.gitSkillLocalId,
      "web-search",
    ].sort(),
    "skill ids remapped to local installed copies (plugin-scoped FQN)",
  );
  assert.deepEqual(
    (result.addedMarketplaces || []).map((entry) => entry.id),
    [GIT_MARKETPLACE],
    "the git marketplace was auto-added",
  );

  const notesFile = path.join(
    laptop.projectRoot,
    "skills-marketplace",
    "ai-marketplace",
    "notes",
    "SKILL.md",
  );
  const artFile = path.join(
    laptop.projectRoot,
    "skills-marketplace",
    GIT_MARKETPLACE,
    GIT_MARKETPLACE,
    "algorithmic-art",
    "SKILL.md",
  );
  assert.ok(
    (await fsp.readFile(notesFile, "utf8")).includes("notes"),
    "solution dep content on disk",
  );
  assert.ok(
    (await fsp.readFile(artFile, "utf8")).includes("algorithmic-art"),
    "git dep content on disk",
  );

  const link = await stack.agentLinks.getLink(world.laptopAgentId);
  assert.equal(link.relationship, "installed");
  assert.equal(link.solutionId, world.agentListingId);
  assert.equal(link.attributionPending, false);
});

test("laptop: reclaiming the installed agent flips its link to published", async () => {
  setActiveMachine(laptop);
  const result = await stack.ops.reclaimInstalledAgent(world.laptopAgentId);
  assert.equal(result.solution_id, world.agentListingId);
  const link = await stack.agentLinks.getLink(world.laptopAgentId);
  assert.equal(link.relationship, "published");
});

test("laptop: reclaiming the installed notes copy detaches and relinks it", async () => {
  setActiveMachine(laptop);
  const result = await stack.ops.reclaimInstalledSkill("ai-marketplace/notes");
  assert.equal(result.solution_id, world.notesListingId);
  const userCopy = path.join(
    laptop.projectRoot,
    "skills-user",
    result.local_skill_id,
    "SKILL.md",
  );
  assert.ok((await fsp.readFile(userCopy, "utf8")).includes("notes"));
  const link = await stack.skillLinks.getLink(result.local_skill_id);
  assert.equal(link.solutionId, world.notesListingId);
});

test("laptop: a lost skill link is adopted back via owned-name matching", async () => {
  setActiveMachine(laptop);
  await stack.skillLinks.clearLink("notes");

  const resolution =
    await bridge.window.AgentsPublishHooks.resolveDependentSkillPlans(["notes"]);
  assert.equal(resolution.errors.length, 0, JSON.stringify(resolution.errors));
  assert.equal(resolution.plans[0].provenance, "user-adopt");
  assert.equal(resolution.plans[0].solutionId, world.notesListingId);

  const result = await bridge.window.AgentsPublishHooks.executeDependentSkillPlans(
    resolution.plans,
  );
  assert.equal(result.summary.adopted, 1);
  const link = await stack.skillLinks.getLink("notes");
  assert.equal(link.solutionId, world.notesListingId);
  assert.equal(link.hasLocalChanges, false);
});

test("a foreign name collision fails closed at publish with rename guidance", async () => {
  setActiveMachine(publisher);
  market.solutions.set("sol-foreign-clash", {
    id: "sol-foreign-clash",
    type: "skills",
    name: "clash",
    status: "active",
    submitted_by: "someone-else@example.invalid",
    updated_at: new Date().toISOString(),
    bundle: { type: "skills", payload: { name: "clash" } },
  });
  await seedSkill(publisher.projectRoot, "user", "clash", { createdByEmail: VIEWER });

  await assert.rejects(
    bridge.window.AgentsPublishHooks.publishDependentSkills(["clash"]),
    /already has a solution named "clash" that you do not own/,
  );
  assert.equal(
    await stack.skillLinks.getLink("clash"),
    null,
    "foreign listings are never linked",
  );
});

test("a deleted listing self-heals: dirty-mark, then update-path republish", async () => {
  setActiveMachine(publisher);
  market.deleteListing(world.notesListingId);

  // Attempt 1: clean reference — the execute-time liveness wave finds the
  // tombstone, marks the link dirty, and aborts before any write.
  await assert.rejects(
    bridge.window.AgentsPublishHooks.publishDependentSkills(["notes"]),
    /marketplace listings no longer exist: notes/,
  );
  const dirtied = await stack.skillLinks.getLink("notes");
  assert.equal(dirtied.hasLocalChanges, true, "dead link marked dirty");

  // Attempt 2: dirty path → update → absent listing → self-heal republish.
  const result = await bridge.window.AgentsPublishHooks.publishDependentSkills([
    "notes",
  ]);
  assert.equal(result.summary.repaired, 1);
  assert.equal(result.summary.published, 1);
  const healedLink = await stack.skillLinks.getLink("notes");
  assert.notEqual(healedLink.solutionId, world.notesListingId, "new listing id");
  const healedListing = market.solutions.get(healedLink.solutionId);
  assert.equal(healedListing.status, "active");
  world.notesListingId = healedLink.solutionId;
});

test("freshness: a bumped listing flags the installed copy as updatable", async () => {
  setActiveMachine(laptop);
  // Install a standalone skill listing, then bump it server-side.
  const toolkitListing = market.solutions.set("sol-toolkit", {
    id: "sol-toolkit",
    type: "skills",
    name: "toolkit",
    status: "active",
    submitted_by: VIEWER,
    updated_at: new Date().toISOString(),
    bundle: {
      type: "skills",
      payload: {
        name: "toolkit",
        description: "fixture toolkit",
        skill_md: '---\nname: toolkit\ndescription: fixture toolkit\nversion: "1.0"\n---\n\n# toolkit\n',
      },
    },
  });
  void toolkitListing;
  await stack.ops.install("sol-toolkit", { interactiveAuth: false });

  market.bumpListing("sol-toolkit");
  const { updates } = await stack.marketplaceService.checkSkillUpdates({
    projectRoot: laptop.projectRoot,
    fetchSolution: (id) => stack.ops.getSolution(id),
    logger: console,
  });
  assert.ok(
    updates.some((entry) => entry.skillId === "toolkit"),
    "bumped listing reports an update",
  );
});

test("leak sweep: no prompt or description content in any captured log line", () => {
  const all = consoleLines.join("\n");
  assert.ok(consoleLines.length > 50, "the suite actually logged");
  assert.ok(!all.includes(PROMPT_MARKER), "system prompt content never logged");
  assert.ok(!all.includes(DESC_MARKER), "description content never logged");
});

// ---- W3: agent Update refreshes dependent skill contents -------------------------

let desktop;

test("publisher: republishing the agent points refs at the healed notes listing", async () => {
  setActiveMachine(publisher);
  const resolution =
    await bridge.window.AgentsPublishHooks.resolveDependentSkillPlans([
      "web-search",
      "notes",
      world.gitSkillLocalId,
    ]);
  assert.equal(resolution.errors.length, 0, JSON.stringify(resolution.errors));

  const published = await bridge.window.AgentsPublishHooks.pushAgentToMarketplace({
    localId: "fixture-agent",
    solutionId: world.agentListingId,
    args: {
      name: "Fixture Agent",
      description: DESC_MARKER,
      base_model_id: "Claude Haiku 4.5",
      system_prompt: PROMPT_MARKER,
      skill_ids: ["web-search", "notes", world.gitSkillLocalId],
      tool_server_ids: [],
      reasoning_effort: "medium",
      allowed_emails: null,
    },
    resolvedSkillPlan: resolution.plans,
  });
  assert.equal(published.solutionId, world.agentListingId);

  const refs = market.solutions.get(world.agentListingId).bundle.payload.skill_refs;
  const notesRef = refs.find((ref) => ref.skill_id === "notes");
  assert.equal(
    notesRef.solution_id,
    world.notesListingId,
    "republish carries the healed listing id",
  );
});

test("desktop: agent Update refreshes a stale clean dependency in place", async () => {
  desktop = await createMachine("desktop", { viewerEmail: VIEWER });
  setActiveMachine(desktop);
  await seedSkill(desktop.projectRoot, "system", "web-search");

  const installed = await stack.ops.install(world.agentListingId, {
    interactiveAuth: false,
  });
  const desktopAgentId = installed.created.id;
  world.desktopAgentId = desktopAgentId;

  const notesPath = path.join(
    desktop.projectRoot,
    "skills-marketplace",
    "ai-marketplace",
    "notes",
    "SKILL.md",
  );
  const v1 = await fsp.readFile(notesPath, "utf8");
  assert.ok(!v1.includes("VERSION-TWO"), "starts at v1");

  // The listing moves forward on the marketplace...
  market.bumpListing(world.notesListingId, {
    bundle: {
      type: "skills",
      payload: {
        name: "notes",
        description: "fixture skill",
        skill_md:
          '---\nname: notes\ndescription: fixture skill VERSION-TWO\nversion: "2.0"\ncreated_by_email: ' +
          VIEWER +
          "\n---\n\n# notes VERSION-TWO\n",
      },
    },
  });

  // ...and agent Update (existingAgentId set) refreshes the clean dep.
  const updated = await stack.ops.install(world.agentListingId, {
    interactiveAuth: false,
    existingAgentId: desktopAgentId,
  });
  assert.equal(updated.mutation, "updated");
  assert.deepEqual(
    (updated.refreshedSkills || []).map((entry) => entry.skill_id),
    ["notes"],
    "the stale clean dependency was refreshed",
  );
  const v2 = await fsp.readFile(notesPath, "utf8");
  assert.ok(v2.includes("VERSION-TWO"), "content actually replaced on disk");
});

test("desktop: hand-edited dependency is kept and reported, never overwritten", async () => {
  setActiveMachine(desktop);
  const notesPath = path.join(
    desktop.projectRoot,
    "skills-marketplace",
    "ai-marketplace",
    "notes",
    "SKILL.md",
  );
  const HAND_EDIT = "\n<!-- my precious local tweak -->\n";
  await fsp.appendFile(notesPath, HAND_EDIT);
  market.bumpListing(world.notesListingId, {
    bundle: {
      type: "skills",
      payload: {
        name: "notes",
        description: "fixture skill",
        skill_md:
          '---\nname: notes\ndescription: fixture skill VERSION-THREE\nversion: "3.0"\ncreated_by_email: ' +
          VIEWER +
          "\n---\n\n# notes VERSION-THREE\n",
      },
    },
  });

  const updated = await stack.ops.install(world.agentListingId, {
    interactiveAuth: false,
    existingAgentId: world.desktopAgentId,
  });
  assert.deepEqual(
    (updated.skippedSkillRefreshes || []).map((entry) => [entry.skill_id, entry.reason]),
    [["notes", "dirty"]],
    "the dirty dependency is skipped and reported",
  );
  const content = await fsp.readFile(notesPath, "utf8");
  assert.ok(content.includes("my precious local tweak"), "hand edit preserved");
  assert.ok(!content.includes("VERSION-THREE"), "remote content NOT forced over it");
});

// ---- Round 11: git-referenced listings install via the app-side fallback ----

test("a git-referenced listing whose backend bundle fails installs via the app-side git fallback", async () => {
  setActiveMachine(laptop);
  // Seeded as another user's listing published by git reference: has_bundle
  // is true but there is no inline bundle, and the mock's /bundle route
  // cannot serve one — exactly the production failure shape.
  market.solutions.set("skill::indexed-jobs", {
    id: "skill::indexed-jobs",
    type: "skills",
    name: "Indexed Jobs Ops Skill",
    status: "active",
    submitted_by: "dfan",
    has_bundle: true,
    bundle_source_git_url: "https://github.com/anthropics/knowledge-work-plugins.git",
    bundle_source_ref: "main",
    bundle_source_subpath: "skills/indexed-jobs",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  await stack.ops.install("skill::indexed-jobs", { interactiveAuth: false });

  const skillDir = path.join(
    laptop.projectRoot,
    "skills-marketplace",
    "ai-marketplace",
    "indexed-jobs",
  );
  const skillMd = await fsp.readFile(path.join(skillDir, "SKILL.md"), "utf8");
  assert.match(skillMd, /name: indexed-jobs/);
  const runbook = await fsp.readFile(path.join(skillDir, "runbook.md"), "utf8");
  assert.equal(runbook, "fixture runbook reference");

  // Provenance is the normal ai-marketplace install record — the fallback
  // changes only where the bytes came from.
  const config = JSON.parse(
    await fsp.readFile(path.join(laptop.projectRoot, "marketplaces.json"), "utf8"),
  );
  const record = (config.installedSkills || []).find(
    (entry) => entry.marketplaceId === "ai-marketplace" && entry.skillId === "indexed-jobs",
  );
  assert.ok(record, "installed record exists");
  assert.equal(record.skillSource?.type, "ai-marketplace-solution");
  assert.equal(record.skillSource?.solutionId, "skill::indexed-jobs");
});

test("a git-referenced listing pointing outside the approved sources fails closed with the fallback code", async () => {
  setActiveMachine(laptop);
  market.solutions.set("skill::rogue", {
    id: "skill::rogue",
    type: "skills",
    name: "Rogue Skill",
    status: "active",
    submitted_by: "someone",
    has_bundle: true,
    bundle_source_git_url: "https://github.com/evil-org/exfil.git",
    bundle_source_ref: "main",
    bundle_source_subpath: "skills/rogue",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  await assert.rejects(
    stack.ops.install("skill::rogue", { interactiveAuth: false }),
    (error) => {
      assert.equal(error.code, "bundle_fallback_failed");
      assert.match(error.message, /approved marketplace sources/);
      return true;
    },
  );
  const rogueDir = path.join(
    laptop.projectRoot,
    "skills-marketplace",
    "ai-marketplace",
    "rogue",
  );
  await assert.rejects(fsp.access(rogueDir), "nothing was installed");
});

test("a bundle-less listing without a git source still fails like before (no silent success)", async () => {
  setActiveMachine(laptop);
  market.solutions.set("skill::hollow", {
    id: "skill::hollow",
    type: "skills",
    name: "Hollow Skill",
    status: "active",
    submitted_by: "someone",
    has_bundle: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  await assert.rejects(
    stack.ops.install("skill::hollow", { interactiveAuth: false }),
    (error) => error.code === "solution_not_found",
  );
});

// ---- Round 11: referential-integrity guards --------------------------------

test("guards: a skill attached to an agent cannot be deleted until the agent detaches it", async () => {
  setActiveMachine(publisher);
  await seedSkill(publisher.projectRoot, "user", "guarded-notes", {
    createdByEmail: VIEWER,
  });
  stack.machineState.subagents.agents.set("guard-agent", {
    id: "guard-agent",
    name: "Guard Agent",
    base_model_id: "Claude Haiku 4.5",
    system_prompt: "guard",
    description: "",
    skill_ids: ["guarded-notes"],
    tool_server_ids: [],
    reasoning_effort: null,
  });

  try {
    await assert.rejects(stack.ops.deleteLocalSkill("guarded-notes"), (error) => {
      assert.equal(error.code, "skill_in_use_by_agents");
      assert.match(error.message, /Guard Agent/);
      assert.deepEqual(error.body.agents, [
        { id: "guard-agent", name: "Guard Agent" },
      ]);
      return true;
    });
    // Nothing was deleted.
    await fsp.access(
      path.join(publisher.projectRoot, "skills-user", "guarded-notes", "SKILL.md"),
    );

    // Detach the reference → the same delete proceeds.
    stack.machineState.subagents.agents.get("guard-agent").skill_ids = [];
    const result = await stack.ops.deleteLocalSkill("guarded-notes");
    assert.equal(result.success, true);
    await assert.rejects(
      fsp.access(path.join(publisher.projectRoot, "skills-user", "guarded-notes")),
    );
  } finally {
    stack.machineState.subagents.agents.delete("guard-agent");
  }
});

test("guards: unpublishing a skill that a locally-published agent depends on is blocked", async () => {
  setActiveMachine(publisher);
  market.solutions.set("sol-dep-skill", {
    id: "sol-dep-skill",
    type: "skills",
    name: "dep-skill",
    status: "active",
    submitted_by: VIEWER,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    bundle: {
      type: "skills",
      payload: {
        name: "dep-skill",
        skill_md: '---\nname: dep-skill\nversion: "1.0"\n---\n\n# dep-skill\n',
      },
    },
  });
  await stack.skillLinks.setLink("dep-skill", "sol-dep-skill");
  stack.machineState.subagents.agents.set("pub-agent", {
    id: "pub-agent",
    name: "Pub Agent",
    base_model_id: "Claude Haiku 4.5",
    system_prompt: "pub",
    description: "",
    skill_ids: ["dep-skill"],
    tool_server_ids: [],
    reasoning_effort: null,
  });
  await stack.agentLinks.setPublishedLink("pub-agent", "sol-pub-agent", VIEWER);

  try {
    await assert.rejects(
      stack.ops.deletePublishedSolution("sol-dep-skill"),
      (error) => {
        assert.equal(error.code, "skill_dependency_of_published_agents");
        assert.match(error.message, /Pub Agent/);
        return true;
      },
    );
    assert.equal(
      market.solutions.get("sol-dep-skill").status,
      "active",
      "the remote listing was never deleted",
    );

    // Once the agent is no longer published (link flipped to installed), the
    // unpublish proceeds and the listing goes away. The return names the
    // local cleanup so the chat envelope can report what was touched.
    await stack.agentLinks.setInstalledLink("pub-agent", "sol-pub-agent", VIEWER);
    const done = await stack.ops.deletePublishedSolution("sol-dep-skill");
    assert.ok(done.data);
    assert.deepEqual(done.clearedSkillLinks, ["dep-skill"]);
    assert.deepEqual(done.clearedAgentIds, []);
    assert.equal(market.solutions.get("sol-dep-skill").status, "deleted");
  } finally {
    stack.machineState.subagents.agents.delete("pub-agent");
    await stack.agentLinks.clearLink("pub-agent").catch(() => {});
  }
});

test("spread gate: a skill ref from a non-allowlisted repo cannot auto-add its marketplace", async () => {
  setActiveMachine(laptop);
  await assert.rejects(
    stack.ops.installGitMarketplaceSkillDependency({
      ref: {
        skill_id: "algorithmic-art",
        kind: "git-marketplace",
        solution_id: null,
        marketplace: {
          name: "untrusted-skills",
          source: { type: "github", repo: DISALLOWED_GIT_REPO, ref: "main" },
        },
        skill_path: "./skills/algorithmic-art",
        skill_source: null,
      },
      interactiveAuth: false,
    }),
    (error) => error?.code === "marketplace_source_not_allowed",
  );
  // Nothing was added to the laptop's registry.
  const config = await stack.marketplaceService.loadMarketplacesConfig(
    laptop.projectRoot,
    { logger: console },
  );
  assert.equal(
    (config.marketplaces || []).some((m) => m.id === "untrusted-skills"),
    false,
  );
});

// ---------------------------------------------------------------------------
// rename_skill (2026-08-01 sharing-plan): renaming is constrained to
// UNPUBLISHED user skills. A published skill must be unpublished first, then
// renamed, then republished under the new name (a fresh listing, with the
// fresh-publish name-uniqueness check). The uniqueness check also guards
// legacy links whose local name drifted from the listing name.
// ---------------------------------------------------------------------------

test("published skills cannot be renamed; unpublish -> rename -> fresh republish works", async () => {
  setActiveMachine(publisher);
  const userSkillService = require("./user-skill-service");
  await userSkillService.createSkill({
    projectRoot: publisher.projectRoot,
    skillName: "rename-flow-src",
    skillContent: "---\nname: rename-flow-src\ndescription: rename flow\n---\n\n# v1\n",
  });
  const bundle = await stack.installModule.buildPublishBundle({
    type: "skills",
    skill: {
      name: "rename-flow-src",
      description: "rename flow",
      path: "skills-user/rename-flow-src",
    },
    projectRoot: publisher.projectRoot,
  });
  const { publishStatus } = await stack.ops.publishSolution(bundle, {
    localSkillId: "rename-flow-src",
  });
  await stack.skillLinks.setLink("rename-flow-src", publishStatus.id);

  // POLICY: the published skill refuses the rename with unpublish guidance.
  await assert.rejects(
    userSkillService.renameSkill({
      projectRoot: publisher.projectRoot,
      skillName: "rename-flow-src",
      newSkillName: "rename-flow-dst",
    }),
    (error) =>
      error?.code === "published_skill_rename_blocked" &&
      new RegExp(publishStatus.id).test(error.message),
  );

  // Unpublish clears the link; the rename then proceeds.
  await stack.ops.deletePublishedSolution(publishStatus.id);
  const renamed = await userSkillService.renameSkill({
    projectRoot: publisher.projectRoot,
    skillName: "rename-flow-src",
    newSkillName: "rename-flow-dst",
  });
  assert.equal(renamed.skill_name, "rename-flow-dst");
  assert.equal(await stack.skillLinks.getLink("rename-flow-src"), null);
  assert.equal(await stack.skillLinks.getLink("rename-flow-dst"), null);

  // Republish is a FRESH publish under the new name (no adoption).
  const prefetched = await stack.ops.getSkillForPublish("rename-flow-dst", {});
  assert.equal(prefetched.resolvedExistingSolutionId, "");
});

test("republish that would change a listing's name enforces name uniqueness (legacy drifted links)", async () => {
  setActiveMachine(publisher);
  const userSkillService = require("./user-skill-service");
  // Listing published under one name...
  await userSkillService.createSkill({
    projectRoot: publisher.projectRoot,
    skillName: "drift-src",
    skillContent: "---\nname: drift-src\ndescription: drift\n---\n\n# v1\n",
  });
  const bundle = await stack.installModule.buildPublishBundle({
    type: "skills",
    skill: { name: "drift-src", description: "drift", path: "skills-user/drift-src" },
    projectRoot: publisher.projectRoot,
  });
  const { publishStatus } = await stack.ops.publishSolution(bundle, {
    localSkillId: "drift-src",
  });
  // ...but a legacy/drifted registry links it to a DIFFERENT local name whose
  // republish would rename the listing onto a name another author holds.
  await userSkillService.createSkill({
    projectRoot: publisher.projectRoot,
    skillName: "drift-taken",
    skillContent: "---\nname: drift-taken\ndescription: drift\n---\n\n# v1\n",
  });
  await stack.skillLinks.setLink("drift-taken", publishStatus.id);
  market.solutions.set("sol-foreign-drift", {
    id: "sol-foreign-drift",
    name: "drift-taken",
    description: "someone else's listing",
    author: "Rivera Chen",
    submitted_by: "rchen@example.invalid",
    type: "skills",
    status: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  await assert.rejects(
    stack.ops.getSkillForPublish("drift-taken", {}),
    (error) => error?.code === "solution_name_conflict",
  );
});
