// Round-12 drill-in navigation: marketplace skill cards open the read-only
// skill page via the AgentSkillsHooks bridge with the FULL catalog record
// (skillSource never rides DOM attributes); the details page SUSPENDS —
// hidden with state/DOM intact — and resumes on Back; closing while an
// inline skill page owns the subview never restores the browse chrome
// underneath the editor.
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

const PLANNER_SOURCE = Object.freeze({
  source: "github",
  repo: "anthropics/knowledge-work-plugins",
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
      installed: false,
      available: true,
      skillSource: { ...PLANNER_SOURCE },
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
  ];
}

function navHarness() {
  const h = loadMarketplacesHarness({
    electronAPI: {
      getMarketplaceSkills: async (marketplaceId) => ({
        success: true,
        skills: catalogSkills(),
        marketplace: { ...MARKETPLACE, id: marketplaceId },
      }),
    },
  });
  const hookCalls = [];
  h.window.AgentSkillsHooks = {
    openGitMarketplaceSkillPage: (record) => hookCalls.push(record),
    updateSkillsHeaderActions: () => {},
  };
  return { h, hookCalls };
}

test("card-body click sends the full catalog record through the hook; button/trigger clicks never do", async () => {
  const { h, hookCalls } = navHarness();
  const list = h.getElementById("marketplace-skills-list");
  const soloCard = new FakeElement("card-solo");
  soloCard.dataset.skillId = "solo";
  list.qsaResults.set(".marketplace-skill-card", [soloCard]);
  await h.window.openMarketplaceDetailsPage(MARKETPLACE);
  await flushAsync();

  // Footer buttons, tooltip triggers, and menu containers act on their own.
  for (const guarded of [
    "button",
    ".skill-card-actions",
    ".info-tooltip-trigger",
    ".mcp-card-menu-wrapper",
    ".mcp-card-dropdown",
  ]) {
    soloCard.click({ target: { closest: (sel) => (sel === guarded ? {} : null) } });
  }
  assert.equal(hookCalls.length, 0, "guarded targets never open the page");

  soloCard.click({ target: { closest: () => null } });
  assert.equal(hookCalls.length, 1);
  // JSON round-trip: the record object was created inside the vm realm, and
  // strict deepEqual rejects cross-realm prototypes.
  assert.deepEqual(JSON.parse(JSON.stringify(hookCalls[0])), {
    marketplaceId: "kwp",
    marketplaceName: "Knowledge Work Plugins",
    skillId: "solo",
    pluginName: null,
    skillPath: "./solo",
    skillSource: null,
    installed: true,
    installedVersion: "1.0",
    displayName: "Solo",
    description: "Installed root skill",
  });
});

test("drill-in cards thread pluginName and the raw skillSource object through the hook", async () => {
  const { h, hookCalls } = navHarness();
  const list = h.getElementById("marketplace-skills-list");
  const folderCard = new FakeElement("folder-productivity");
  folderCard.dataset.pluginName = "productivity";
  folderCard.dataset.drillable = "true";
  list.qsaResults.set(".marketplace-plugin-folder-card", [folderCard]);
  const plannerCard = new FakeElement("card-planner");
  plannerCard.dataset.skillId = "planner";
  plannerCard.dataset.pluginName = "productivity";
  list.qsaResults.set(".marketplace-skill-card", [plannerCard]);
  await h.window.openMarketplaceDetailsPage(MARKETPLACE);
  await flushAsync();

  folderCard.click({ target: { closest: () => null } });
  await flushAsync();
  plannerCard.click({ target: { closest: () => null } });

  assert.equal(hookCalls.length, 1);
  assert.equal(hookCalls[0].skillId, "planner");
  assert.equal(hookCalls[0].pluginName, "productivity");
  assert.equal(hookCalls[0].skillPath, "./p/skills/planner");
  assert.deepEqual(
    hookCalls[0].skillSource,
    PLANNER_SOURCE,
    "the record's skillSource object rides the hook untouched",
  );
});

test("folder cards never wire the drill-in-to-skill-page click; a missing hook degrades to a no-op", async () => {
  const { h, hookCalls } = navHarness();
  const list = h.getElementById("marketplace-skills-list");
  const folderish = new FakeElement("folderish");
  folderish.classList.add("marketplace-plugin-folder-card");
  folderish.dataset.skillId = "not-a-skill";
  const soloCard = new FakeElement("card-solo");
  soloCard.dataset.skillId = "solo";
  list.qsaResults.set(".marketplace-skill-card", [folderish, soloCard]);
  await h.window.openMarketplaceDetailsPage(MARKETPLACE);
  await flushAsync();

  folderish.click({ target: { closest: () => null } });
  assert.equal(hookCalls.length, 0, "folder cards are skipped at wiring time");

  // Older bundles without the hook: the click is a silent no-op, no throw.
  h.window.AgentSkillsHooks = {};
  soloCard.click({ target: { closest: () => null } });
  assert.equal(hookCalls.length, 0);
});

test("suspend hides the page without teardown; resume re-shows it with the browse chrome still hidden", async () => {
  const { h } = navHarness();
  // Nothing open yet: suspend/resume both report failure.
  assert.equal(h.window.suspendMarketplaceDetailsPage(), false);
  assert.equal(h.window.resumeMarketplaceDetailsPage(), false);

  const list = h.getElementById("marketplace-skills-list");
  const folderCard = new FakeElement("folder-productivity");
  folderCard.dataset.pluginName = "productivity";
  folderCard.dataset.drillable = "true";
  list.qsaResults.set(".marketplace-plugin-folder-card", [folderCard]);
  await h.window.openMarketplaceDetailsPage(MARKETPLACE);
  await flushAsync();
  // Drill in so resume can prove it preserves more than the default view.
  folderCard.click({ target: { closest: () => null } });
  await flushAsync();
  assert.match(list.innerHTML, /marketplace-plugin-back-btn/, "drilled in");

  const host = h.getElementById("marketplace-details-page");
  const browser = h.getElementById("agent-skills-browser");
  const headerActions = h.getElementById("skills-header-actions");
  const gridBefore = list.innerHTML;

  assert.equal(h.window.suspendMarketplaceDetailsPage(), true);
  assert.equal(host.style.display, "none");
  assert.equal(h.window.isMarketplaceDetailsPageOpen(), true, "state stays live");

  assert.equal(h.window.resumeMarketplaceDetailsPage(), true);
  assert.equal(host.style.display, "");
  assert.equal(browser.style.display, "none", "browse grid stays hidden");
  assert.equal(headerActions.style.display, "none", "header actions stay hidden");
  assert.equal(list.innerHTML, gridBefore, "drill-in state survived untouched");
});

test("closing while an inline skill page owns the subview skips the browse-chrome restore", async () => {
  const { h } = navHarness();
  await h.window.openMarketplaceDetailsPage(MARKETPLACE);
  await flushAsync();
  const browser = h.getElementById("agent-skills-browser");
  assert.equal(browser.style.display, "none", "page owns the subview");

  h.window.isInlineSkillPageOpen = () => true;
  h.window.closeMarketplaceDetailsPage();
  assert.equal(
    browser.style.display,
    "none",
    "browser never surfaces underneath the open editor",
  );
  assert.equal(h.window.isMarketplaceDetailsPageOpen(), false, "state torn down");

  // Without an inline page the close restores the browser as always.
  await h.window.openMarketplaceDetailsPage(MARKETPLACE);
  await flushAsync();
  h.window.isInlineSkillPageOpen = () => false;
  h.window.closeMarketplaceDetailsPage();
  assert.equal(browser.style.display, "");
});
