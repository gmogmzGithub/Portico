// "Used by N agents" badges on the marketplace details grid — one fail-open
// usage IPC per page open (parallel with the skills paint) and one more per
// action refresh. Leaf-id matched skill cards get the badge row + names
// tooltip; plugin folder cards never do; failures render badge-free.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  FakeElement,
  flushAsync,
  loadMarketplacesHarness,
} = require("./marketplaces-harness");

const MARKETPLACE = Object.freeze({
  id: "kwp",
  name: "Knowledge Work Plugins",
  source: { type: "github", repo: "anthropics/knowledge-work-plugins" },
  owner: { name: "Anthropic" },
  cachedManifest: {
    name: "kwp",
    plugins: [
      {
        name: "productivity",
        description: "Productivity tools",
        skills: ["./p/skills/planner", "./p/skills/tracker"],
      },
    ],
  },
});

function catalogSkills() {
  return [
    {
      id: "planner",
      name: "planner",
      displayName: "Planner",
      description: "Plan things",
      skillPath: "./p/skills/planner",
      pluginName: "productivity",
      installed: true,
      installedVersion: "1.0",
      available: true,
    },
    {
      id: "tracker",
      name: "tracker",
      displayName: "Tracker",
      description: "Track things",
      skillPath: "./p/skills/tracker",
      pluginName: "productivity",
      installed: false,
      available: true,
    },
    {
      id: "solo",
      name: "solo",
      displayName: "Solo",
      description: "Installed root skill",
      skillPath: "./solo",
      pluginName: null,
      installed: true,
      installedVersion: "1.0",
      available: true,
    },
    {
      id: "aardvark",
      name: "aardvark",
      displayName: "Aardvark",
      description: "Installed but unreferenced root skill",
      skillPath: "./aardvark",
      pluginName: null,
      installed: true,
      installedVersion: "1.0",
      available: true,
    },
  ];
}

// The usage inventory deliberately includes a leaf matching the PLUGIN name:
// folder cards must never consult the map, only leaf skill cards do.
const USAGE_AGENTS = [
  { id: "a1", name: "Research Buddy", leaves: ["solo", "productivity"] },
  { id: "a2", name: "Planner Bot", leaves: ["planner", "solo"] },
];

function usageHarness({ agents = USAGE_AGENTS, usageImpl = null } = {}) {
  const h = loadMarketplacesHarness({
    electronAPI: {
      getMarketplaceSkills: async (marketplaceId) => ({
        success: true,
        skills: catalogSkills(),
        marketplace: { ...MARKETPLACE, id: marketplaceId },
      }),
      listAgentSkillUsage: async () => {
        h.calls.listAgentSkillUsage += 1;
        if (usageImpl) return usageImpl();
        return { success: true, agents };
      },
    },
  });
  h.window.InfoTooltips = {
    triggerHtml: (text) =>
      `<span class="info-tooltip-trigger" data-info-tooltip="${text}"></span>`,
    listTriggerHtml: (spec, innerHtml = "") =>
      `<span class="info-tooltip-trigger" data-list-title="${spec.title}" data-list-items="${(spec.items || []).join("; ")}" data-list-icon="${spec.icon || ""}">${innerHtml}</span>`,
  };
  return h;
}

test("opening the details page issues one usage IPC and badges leaf-matched skill cards, never folders", async () => {
  const h = usageHarness();
  await h.window.openMarketplaceDetailsPage(MARKETPLACE);
  await flushAsync();

  assert.equal(h.calls.listAgentSkillUsage, 1, "one usage fetch per open");
  const html = h.getElementById("marketplace-skills-list").innerHTML;
  // Root skill card: two agents reference "solo".
  const soloStart = html.indexOf('data-skill-id="solo"');
  assert.ok(soloStart >= 0, "solo card rendered");
  const soloCard = html.slice(soloStart, html.indexOf('data-skill-id="aardvark"'));
  assert.match(soloCard, /badge-agents"[^>]*>2 AGENTS</);
  assert.match(
    soloCard,
    /data-list-title="Used by 2 agents" data-list-items="Research Buddy; Planner Bot" data-list-icon="agent"/,
  );
  // The badge chip rides INSIDE the trigger — hovering the badge itself
  // shows the tooltip, with no dead gap to the icon.
  assert.match(
    soloCard,
    /info-tooltip-trigger"[^>]*>\s*<span class="mcp-card-badge badge-agents">2 AGENTS</,
  );
  // Folder card: an agent references the leaf "productivity", but plugins are
  // not skills — no agents badge on folder cards.
  const folderStart = html.indexOf('data-plugin-name="productivity"');
  const folderCard = html.slice(folderStart, soloStart);
  assert.doesNotMatch(folderCard, /badge-agents/);
  // Root skills rank agent-used first: Solo (2 agents) leads Aardvark (0)
  // despite alphabetical order and both being installed.
  const aardvarkStart = html.indexOf('data-skill-id="aardvark"');
  assert.ok(aardvarkStart >= 0, "aardvark rendered");
  assert.ok(soloStart < aardvarkStart, "usage-desc outranks alphabetical among roots");
});

test("drilling into a plugin badges its member skills by leaf id", async () => {
  const h = usageHarness();
  const list = h.getElementById("marketplace-skills-list");
  const folderCard = new FakeElement("folder-productivity");
  folderCard.dataset.pluginName = "productivity";
  folderCard.dataset.drillable = "true";
  list.qsaResults.set(".marketplace-plugin-folder-card", [folderCard]);
  await h.window.openMarketplaceDetailsPage(MARKETPLACE);
  await flushAsync();

  folderCard.click({ target: { closest: () => null } });
  await flushAsync();

  const html = list.innerHTML;
  const plannerStart = html.indexOf('data-skill-id="planner"');
  const trackerStart = html.indexOf('data-skill-id="tracker"');
  assert.ok(plannerStart >= 0 && trackerStart >= 0, "both member cards rendered");
  // Ranked installed-first, so planner precedes tracker.
  const plannerCard = html.slice(plannerStart, trackerStart);
  assert.match(plannerCard, /badge-agents"[^>]*>1 AGENT</);
  assert.match(plannerCard, /data-list-title="Used by 1 agent" data-list-items="Planner Bot"/);
  assert.doesNotMatch(html.slice(trackerStart), /badge-agents/);
});

test("an action refresh issues exactly one more usage IPC and the repaint carries fresh data", async () => {
  let agents = USAGE_AGENTS;
  const h = usageHarness({ usageImpl: () => ({ success: true, agents }) });
  await h.window.openMarketplaceDetailsPage(MARKETPLACE);
  await flushAsync();
  assert.equal(h.calls.listAgentSkillUsage, 1);

  // Stage the rendered install button for tracker and click it — the action
  // ends in refreshMarketplaceSurfaces → refreshCurrentMarketplaceDetails.
  agents = [{ id: "a3", name: "New Bot", leaves: ["solo"] }];
  const list = h.getElementById("marketplace-skills-list");
  const installBtn = new FakeElement("install-tracker");
  installBtn.dataset.skillId = "tracker";
  installBtn.dataset.skillPath = "./p/skills/tracker";
  installBtn.dataset.skillSource = "";
  installBtn.dataset.pluginName = "productivity";
  list.qsaResults.set(".marketplace-skill-install-btn", [installBtn]);
  await h.window.openMarketplaceDetailsPage(MARKETPLACE);
  await flushAsync();
  const beforeClick = h.calls.listAgentSkillUsage;

  installBtn.click();
  await flushAsync(16);

  assert.equal(
    h.calls.listAgentSkillUsage,
    beforeClick + 1,
    "exactly one usage fetch per action-refresh cycle",
  );
  const html = list.innerHTML;
  assert.match(html, /data-list-items="New Bot"/);
  assert.doesNotMatch(html, /Planner Bot/);
});

test("a failed usage fetch renders the grid badge-free", async () => {
  const h = usageHarness({
    usageImpl: () => ({ success: false, error: "inventory offline" }),
  });
  await h.window.openMarketplaceDetailsPage(MARKETPLACE);
  await flushAsync();

  const html = h.getElementById("marketplace-skills-list").innerHTML;
  assert.match(html, /data-skill-id="solo"/, "the grid still renders");
  assert.doesNotMatch(html, /badge-agents/);
});

// ---------------------------------------------------------------------------
// Round 13/14: agent-referenced installed skills grey the kebab Uninstall
// (the only uninstall affordance — the footer shows the green Installed
// state) with the right-placed agents tooltip.
// ---------------------------------------------------------------------------

test("installed agent-referenced skills grey the kebab Uninstall with the agents tooltip", async () => {
  const h = usageHarness();
  await h.window.openMarketplaceDetailsPage(MARKETPLACE);
  await flushAsync();

  const html = h.getElementById("marketplace-skills-list").innerHTML;
  const soloStart = html.indexOf('data-skill-id="solo"');
  const aardvarkStart = html.indexOf('data-skill-id="aardvark"');
  const soloCard = html.slice(soloStart, aardvarkStart);
  const aardvarkCard = html.slice(aardvarkStart);
  // Footer: the green Installed state — never a footer Uninstall button.
  assert.match(soloCard, /btn-all-installed marketplace-skill-installed-btn/);
  assert.doesNotMatch(soloCard, /marketplace-skill-uninstall-btn/);
  // Kebab Uninstall: greyed hover unit with the payload.
  assert.match(
    soloCard,
    /marketplace-skill-menu-uninstall-btn delete-action info-tooltip-trigger" data-skill-id="solo" aria-disabled="true"/,
  );
  assert.match(soloCard, /data-info-tooltip-placement="right"/);
  assert.match(soloCard, /Used by 2 agents/);
  assert.match(soloCard, /Remove it from these agents first\./);
  // Unreferenced installed skill: byte-identical active kebab markup and the
  // same green footer state.
  assert.match(
    aardvarkCard,
    /marketplace-skill-menu-uninstall-btn delete-action" data-skill-id="aardvark">/,
  );
  assert.match(aardvarkCard, /btn-all-installed marketplace-skill-installed-btn/);
  assert.doesNotMatch(aardvarkCard, /marketplace-skill-uninstall-btn/);
});

test("a failed usage fetch renders an active kebab uninstall (fail-open)", async () => {
  const h = usageHarness({
    usageImpl: () => ({ success: false, error: "subagents offline" }),
  });
  await h.window.openMarketplaceDetailsPage(MARKETPLACE);
  await flushAsync();
  const html = h.getElementById("marketplace-skills-list").innerHTML;
  assert.doesNotMatch(html, /aria-disabled="true"/);
  assert.match(
    html,
    /marketplace-skill-menu-uninstall-btn delete-action" data-skill-id="solo">/,
  );
});

test("usage arriving after the first paint repaints the grid blocked", async () => {
  let resolveUsage;
  const gate = new Promise((resolve) => {
    resolveUsage = resolve;
  });
  const h = usageHarness({ usageImpl: () => gate });
  await h.window.openMarketplaceDetailsPage(MARKETPLACE);
  await flushAsync();

  const list = h.getElementById("marketplace-skills-list");
  assert.match(list.innerHTML, /data-skill-id="solo"/, "skills painted");
  assert.doesNotMatch(
    list.innerHTML,
    /aria-disabled="true"/,
    "no blocked state before usage resolves",
  );

  resolveUsage({ success: true, agents: USAGE_AGENTS });
  await flushAsync();
  const repainted = list.innerHTML;
  assert.match(
    repainted,
    /marketplace-skill-menu-uninstall-btn delete-action info-tooltip-trigger" data-skill-id="solo" aria-disabled="true"/,
    "the usage-arrival repaint carries the blocked state",
  );
});
