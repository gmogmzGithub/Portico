// Agent-link adoption sweep (State & Persistence): restores LOST sidecar
// links for installed foreign-owned agents. Matching is deliberately narrow —
// exact display name + author local-part + exactly one live listing — because
// a false relink is worse than staying unlinked (Deck Personalizer 2.0 must
// NOT be adopted as Smart Slides 2.0's successor).
const test = require("node:test");
const assert = require("node:assert/strict");

const { runAgentLinkAdoptionSweep } = require("./ai-marketplace-agent-adoption");

function fakeLinkStore(initial = {}) {
  const links = { ...initial };
  const writes = [];
  return {
    links,
    writes,
    store: {
      listLinks: async () => ({ ...links }),
      setInstalledLink: async (agentId, solutionId, authorIdentity) => {
        writes.push(["setInstalledLink", agentId, solutionId, authorIdentity]);
        links[agentId] = { solutionId, relationship: "installed", authorIdentity };
        return links[agentId];
      },
      setLinkRemoteUpdatedAt: async (agentId, stamp) => {
        writes.push(["setLinkRemoteUpdatedAt", agentId, stamp]);
        return links[agentId] || null;
      },
    },
  };
}

function fixtureDeps({
  agents = [],
  listings = [],
  initialLinks = {},
  viewerEmail = "dsantiago@example.invalid",
  backupSolutionIds = {},
} = {}) {
  const { links, writes, store } = fakeLinkStore(initialLinks);
  const searchCalls = [];
  const reconcileCalls = [];
  const backupReadCalls = [];
  return {
    links,
    writes,
    searchCalls,
    reconcileCalls,
    backupReadCalls,
    deps: {
      listAgents: async () => agents,
      searchSolutions: async (params) => {
        searchCalls.push(params);
        const page = params.page || 1;
        const size = params.pageSize || 100;
        return { solutions: listings.slice((page - 1) * size, page * size) };
      },
      links: store,
      reconcile: async () => {
        reconcileCalls.push(true);
      },
      resolveViewerEmail: async () => viewerEmail,
      readBackupSolutionIds: async (ids) => {
        backupReadCalls.push([...ids]);
        return backupSolutionIds;
      },
      logger: { log() {}, warn() {} },
    },
  };
}

const RESEARCH_AGENT = {
  id: "research-assistant---narrative-builder",
  name: "Research Assistant - Narrative Builder",
  readOnly: true,
  createdByEmail: "zstevens",
  skillIds: [],
};

const RESEARCH_LISTING = {
  id: "4bf17271-research",
  display_name: "Research Assistant - Narrative Builder",
  author: "zstevens@example.invalid",
  updated_timestamp: "2026-08-07T18:00:00Z",
};

test("adopts on an unambiguous name+author match and reconciles attribution", async () => {
  const fx = fixtureDeps({
    agents: [RESEARCH_AGENT],
    listings: [
      RESEARCH_LISTING,
      { id: "other", display_name: "Deck Personalizer 2.0", author: "zstevens@example.invalid" },
    ],
  });
  const summary = await runAgentLinkAdoptionSweep(fx.deps);
  assert.equal(summary.completed, true);
  assert.equal(summary.candidates, 1);
  assert.deepEqual(summary.adopted, [
    { agentId: RESEARCH_AGENT.id, solutionId: "4bf17271-research", via: "listing-match" },
  ]);
  assert.deepEqual(fx.writes, [
    ["setInstalledLink", RESEARCH_AGENT.id, "4bf17271-research", "zstevens@example.invalid"],
    ["setLinkRemoteUpdatedAt", RESEARCH_AGENT.id, "2026-08-07T18:00:00Z"],
  ]);
  assert.equal(fx.reconcileCalls.length, 1);
});

test("agents carry bare ldap while listings carry full emails — local-parts match", async () => {
  const fx = fixtureDeps({
    agents: [{ ...RESEARCH_AGENT, createdByEmail: "ZStevens" }],
    listings: [{ ...RESEARCH_LISTING, author: "zstevens@example.invalid" }],
  });
  const summary = await runAgentLinkAdoptionSweep(fx.deps);
  assert.equal(summary.adopted.length, 1);
});

test("no matching listing stays unlinked with an honest skip (Smart Slides case)", async () => {
  const fx = fixtureDeps({
    agents: [
      { id: "smart-slides-2.0", name: "Smart Slides 2.0", readOnly: true, createdByEmail: "zstevens" },
    ],
    listings: [
      // The apparent successor exists but under a different name — never assumed.
      { id: "cdc3cfa0", display_name: "Deck Personalizer 2.0", author: "zstevens@example.invalid" },
    ],
  });
  const summary = await runAgentLinkAdoptionSweep(fx.deps);
  assert.deepEqual(summary.adopted, []);
  assert.deepEqual(summary.skipped, [
    { agentId: "smart-slides-2.0", reason: "no_unambiguous_listing" },
  ]);
  assert.equal(fx.writes.length, 0);
  assert.equal(fx.reconcileCalls.length, 0);
});

test("multiple matching listings skip (ambiguity never relinks)", async () => {
  const fx = fixtureDeps({
    agents: [RESEARCH_AGENT],
    listings: [
      RESEARCH_LISTING,
      { ...RESEARCH_LISTING, id: "duplicate-listing" },
    ],
  });
  const summary = await runAgentLinkAdoptionSweep(fx.deps);
  assert.deepEqual(summary.adopted, []);
  assert.equal(summary.skipped[0].reason, "multiple_matching_listings");
});

test("author mismatch is not a match even when the name is identical", async () => {
  const fx = fixtureDeps({
    agents: [RESEARCH_AGENT],
    listings: [{ ...RESEARCH_LISTING, author: "someoneelse@example.invalid" }],
  });
  const summary = await runAgentLinkAdoptionSweep(fx.deps);
  assert.deepEqual(summary.adopted, []);
  assert.equal(summary.skipped[0].reason, "no_unambiguous_listing");
});

test("tombstoned listings are invisible to adoption", async () => {
  const fx = fixtureDeps({
    agents: [RESEARCH_AGENT],
    listings: [{ ...RESEARCH_LISTING, status: "deleted" }],
  });
  const summary = await runAgentLinkAdoptionSweep(fx.deps);
  assert.deepEqual(summary.adopted, []);
});

test("viewer-owned, writable, or already-linked agents are never candidates; no candidates → no network", async () => {
  const fx = fixtureDeps({
    agents: [
      { id: "mine", name: "Mine", readOnly: true, createdByEmail: "dsantiago" },
      { id: "writable", name: "Writable", readOnly: false, createdByEmail: "zstevens" },
      { id: "linked", name: "Linked", readOnly: true, createdByEmail: "zstevens" },
      { id: "anon", name: "Anon", readOnly: true, createdByEmail: "" },
    ],
    listings: [RESEARCH_LISTING],
    initialLinks: { linked: { solutionId: "sol-x" } },
  });
  const summary = await runAgentLinkAdoptionSweep(fx.deps);
  assert.equal(summary.completed, true);
  assert.equal(summary.candidates, 0);
  assert.equal(fx.searchCalls.length, 0);
});

test("inventory unavailability skips without latching (completed=false) and without searching", async () => {
  const fx = fixtureDeps({ listings: [RESEARCH_LISTING] });
  fx.deps.listAgents = async () => {
    throw new Error("agent services unavailable");
  };
  const summary = await runAgentLinkAdoptionSweep(fx.deps);
  assert.equal(summary.completed, false);
  assert.equal(fx.searchCalls.length, 0);
});

test("an empty inventory is a transient read, not a completed pass", async () => {
  const fx = fixtureDeps({ agents: [], listings: [] });
  const summary = await runAgentLinkAdoptionSweep(fx.deps);
  assert.equal(summary.completed, false);
});

test("listing-sweep failure skips without latching and writes nothing", async () => {
  const fx = fixtureDeps({ agents: [RESEARCH_AGENT] });
  fx.deps.searchSolutions = async () => {
    throw new Error("marketplace down");
  };
  const summary = await runAgentLinkAdoptionSweep(fx.deps);
  assert.equal(summary.completed, false);
  assert.equal(fx.writes.length, 0);
});

test("paginates the listing sweep until a short page", async () => {
  const filler = Array.from({ length: 100 }, (_u, i) => ({
    id: `filler-${i}`,
    display_name: `Filler ${i}`,
    author: "someone@example.invalid",
  }));
  const fx = fixtureDeps({
    agents: [RESEARCH_AGENT],
    listings: [...filler, RESEARCH_LISTING],
  });
  const summary = await runAgentLinkAdoptionSweep(fx.deps);
  assert.equal(fx.searchCalls.length, 2);
  assert.equal(summary.adopted.length, 1);
});

test("a failed link write records the skip but does not block other adoptions", async () => {
  const secondAgent = {
    id: "second-agent",
    name: "Second Agent",
    readOnly: true,
    createdByEmail: "zstevens",
  };
  const fx = fixtureDeps({
    agents: [RESEARCH_AGENT, secondAgent],
    listings: [
      RESEARCH_LISTING,
      { id: "second-listing", display_name: "Second Agent", author: "zstevens@example.invalid" },
    ],
  });
  const realSet = fx.deps.links.setInstalledLink;
  fx.deps.links.setInstalledLink = async (agentId, ...rest) => {
    if (agentId === RESEARCH_AGENT.id) throw new Error("disk full");
    return realSet(agentId, ...rest);
  };
  const summary = await runAgentLinkAdoptionSweep(fx.deps);
  assert.deepEqual(summary.skipped, [
    { agentId: RESEARCH_AGENT.id, reason: "link_write_failed" },
  ]);
  assert.deepEqual(summary.adopted, [
    { agentId: "second-agent", solutionId: "second-listing", via: "listing-match" },
  ]);
  assert.equal(fx.reconcileCalls.length, 1);
});

// ---------------------------------------------------------------------------
// Meta-first + repair-backup arms (2026-08-14 Smart Slides incident: the
// listing was hard-deleted AND the reconcile had scrubbed the meta — the
// only surviving copy of the solution id was a cold OWUI repair backup).
// ---------------------------------------------------------------------------

test("meta-first: an agent whose meta names the solution id relinks without any search", async () => {
  const fx = fixtureDeps({
    agents: [
      { ...RESEARCH_AGENT, marketplaceSolutionId: "meta-solution-id" },
    ],
    listings: [RESEARCH_LISTING],
  });
  const summary = await runAgentLinkAdoptionSweep(fx.deps);
  assert.deepEqual(summary.adopted, [
    { agentId: RESEARCH_AGENT.id, solutionId: "meta-solution-id", via: "meta" },
  ]);
  assert.equal(fx.searchCalls.length, 0);
  assert.equal(fx.backupReadCalls.length, 0);
  assert.equal(fx.reconcileCalls.length, 1);
});

test("meta-first wins over a live listing with the same name (exact id beats matching)", async () => {
  const fx = fixtureDeps({
    agents: [
      { ...RESEARCH_AGENT, marketplaceSolutionId: "exact-id" },
      { id: "needs-match", name: "Second Agent", readOnly: true, createdByEmail: "zstevens" },
    ],
    listings: [
      { id: "second-listing", display_name: "Second Agent", author: "zstevens@example.invalid" },
    ],
  });
  const summary = await runAgentLinkAdoptionSweep(fx.deps);
  assert.deepEqual(
    summary.adopted.map((entry) => [entry.agentId, entry.solutionId, entry.via]),
    [
      [RESEARCH_AGENT.id, "exact-id", "meta"],
      ["needs-match", "second-listing", "listing-match"],
    ],
  );
});

test("repair-backup harvest relinks an otherwise-unmatchable agent (Smart Slides class)", async () => {
  const fx = fixtureDeps({
    agents: [
      { id: "smart-slides-2.0", name: "Smart Slides 2.0", readOnly: true, createdByEmail: "zstevens" },
    ],
    listings: [
      { id: "cdc3cfa0", display_name: "Deck Personalizer 2.0", author: "zstevens@example.invalid" },
    ],
    backupSolutionIds: { "smart-slides-2.0": "d974115d-recovered" },
  });
  const summary = await runAgentLinkAdoptionSweep(fx.deps);
  assert.deepEqual(summary.adopted, [
    { agentId: "smart-slides-2.0", solutionId: "d974115d-recovered", via: "repair-backup" },
  ]);
  assert.deepEqual(summary.skipped, []);
  assert.deepEqual(fx.backupReadCalls, [["smart-slides-2.0"]]);
  assert.equal(fx.reconcileCalls.length, 1);
});

test("backup-reader failure degrades to the honest skip; sweep still completes", async () => {
  const fx = fixtureDeps({
    agents: [
      { id: "gone-agent", name: "Gone Agent", readOnly: true, createdByEmail: "zstevens" },
    ],
    listings: [],
  });
  fx.deps.readBackupSolutionIds = async () => {
    throw new Error("docker unavailable");
  };
  const summary = await runAgentLinkAdoptionSweep(fx.deps);
  assert.equal(summary.completed, true);
  assert.deepEqual(summary.adopted, []);
  assert.deepEqual(summary.skipped, [
    { agentId: "gone-agent", reason: "no_unambiguous_listing" },
  ]);
});

test("listing-sweep failure after meta adoptions keeps them and still reconciles", async () => {
  const fx = fixtureDeps({
    agents: [
      { ...RESEARCH_AGENT, marketplaceSolutionId: "meta-id" },
      { id: "needs-match", name: "Needs Match", readOnly: true, createdByEmail: "zstevens" },
    ],
  });
  fx.deps.searchSolutions = async () => {
    throw new Error("marketplace down");
  };
  const summary = await runAgentLinkAdoptionSweep(fx.deps);
  assert.equal(summary.completed, false);
  assert.deepEqual(summary.adopted, [
    { agentId: RESEARCH_AGENT.id, solutionId: "meta-id", via: "meta" },
  ]);
  assert.equal(fx.reconcileCalls.length, 1);
});
