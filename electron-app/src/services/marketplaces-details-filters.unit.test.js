// Marketplace details filter tabs — the Installed/Available/Has Updates tabs
// keep the plugin-folder hierarchy (folders narrow to matching skills, with
// count badges following, and vanish at zero matches) instead of flattening
// to loose skill cards. Only SEARCH flattens. Drill-in respects the active
// tab, tab switches while drilled-in stay drilled-in, and empty states are
// filter-aware. Behavioral home for the item-4 round-11 redesign.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  FakeElement,
  flushAsync,
  loadMarketplacesHarness,
} = require("./marketplaces-harness");

const MARKETPLACE = Object.freeze({
  id: "hier",
  name: "Hierarchy Test",
  source: { type: "github", repo: "anthropics/hier" },
  owner: { name: "Anthropic" },
  cachedManifest: {
    name: "hier",
    plugins: [
      {
        name: "productivity",
        description: "Productivity tools",
        skills: ["./p/skills/planner", "./p/skills/tracker"],
      },
      {
        name: "research",
        description: "Research tools",
        skills: ["./r/skills/reader"],
      },
      {
        name: "ext-plugin",
        description: "External tools",
        source: { source: "github", repo: "third-party/ext" },
        unavailable: true,
        unavailableReason: "source_not_allowed",
      },
    ],
  },
});

function catalogSkills({ withUpdate = true } = {}) {
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
      hasUpdate: withUpdate,
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
      id: "reader",
      name: "reader",
      displayName: "Reader",
      description: "Read things",
      skillPath: "./r/skills/reader",
      pluginName: "research",
      installed: false,
      available: true,
    },
    {
      id: "ext-plugin",
      name: "ext-plugin",
      displayName: "Ext Plugin",
      description: "External placeholder",
      skillPath: "./",
      pluginName: null,
      installed: false,
      available: false,
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
      id: "loner",
      name: "loner",
      displayName: "Loner",
      description: "Uninstalled root skill",
      skillPath: "./loner",
      pluginName: null,
      installed: false,
      available: true,
    },
  ];
}

// Opens the details page with the four filter tabs (and optionally a folder
// card) seeded into the harness DOM so the per-open wiring pass attaches to
// them. Returns { h, list, tabs } where tabs is keyed by filter name.
async function openWithTabs({ skills = catalogSkills(), seedFolder = null } = {}) {
  const h = loadMarketplacesHarness({
    electronAPI: {
      getMarketplaceSkills: async (marketplaceId) => ({
        success: true,
        skills,
        marketplace: { ...MARKETPLACE, id: marketplaceId },
      }),
    },
  });
  const tabs = {};
  for (const filter of ["all", "installed", "available", "updates"]) {
    const tab = new FakeElement(`tab-${filter}`);
    tab.dataset.filter = filter;
    tabs[filter] = tab;
  }
  h.docQsaResults.set(
    "#marketplace-skills-filter-tabs .mcp-filter-tab",
    Object.values(tabs),
  );
  const list = h.getElementById("marketplace-skills-list");
  let folderCard = null;
  if (seedFolder) {
    folderCard = new FakeElement(`folder-${seedFolder}`);
    folderCard.dataset.pluginName = seedFolder;
    folderCard.dataset.drillable = "true";
    list.qsaResults.set(".marketplace-plugin-folder-card", [folderCard]);
  }
  await h.window.openMarketplaceDetailsPage(MARKETPLACE);
  await flushAsync();
  return { h, list, tabs, folderCard };
}

test("the Installed tab keeps the folder hierarchy with narrowed counts and drops non-matching folders", async () => {
  const { h, list, tabs } = await openWithTabs();

  tabs.installed.click();
  await flushAsync();

  const html = list.innerHTML;
  // Hierarchy kept: folder cards, no flat plugin subtitles.
  assert.match(html, /marketplace-plugin-folder-card/);
  assert.doesNotMatch(html, /marketplace-skill-plugin-subtitle/);
  // Productivity narrows to its one installed skill; the count badges follow.
  assert.match(html, /data-plugin-name="productivity"/);
  assert.match(html, /badge-version">1 skill</);
  assert.match(html, /badge-installed">1 INSTALLED</);
  // Nothing installable remains inside the narrowed folder → no Install All.
  assert.doesNotMatch(html, /marketplace-plugin-install-all-btn/);
  // Folders and roots with zero installed skills vanish; externals too.
  assert.doesNotMatch(html, /data-plugin-name="research"/);
  assert.doesNotMatch(html, /data-plugin-name="ext-plugin"/);
  assert.match(html, /data-skill-id="solo"/);
  assert.doesNotMatch(html, /data-skill-id="loner"/);
});

test("the Installed tab shows green All Installed only for genuinely fully-installed plugins", async () => {
  // Make research 1/1 installed; productivity stays 1/2 — under the Installed
  // tab both narrow to all-installed subsets, but only research may go green.
  const skills = catalogSkills().map((s) =>
    s.id === "reader" ? { ...s, installed: true, installedVersion: "1.0" } : s,
  );
  const { list, tabs } = await openWithTabs({ skills });

  tabs.installed.click();
  await flushAsync();

  const html = list.innerHTML;
  const productivityStart = html.indexOf('data-plugin-name="productivity"');
  const researchStart = html.indexOf('data-plugin-name="research"');
  assert.ok(productivityStart >= 0 && researchStart >= 0, "both folders rendered");
  assert.ok(productivityStart < researchStart, "tie on installed count breaks alphabetically");
  const productivityCard = html.slice(productivityStart, researchStart);
  // Partially installed: the narrowed view must not fake All Installed, and
  // there is nothing installable in the subset either → no footer action.
  assert.doesNotMatch(productivityCard, /btn-all-installed/);
  assert.doesNotMatch(productivityCard, /marketplace-plugin-install-all-btn/);
  // Fully installed: green state survives the narrowing.
  assert.match(html.slice(researchStart), /btn-all-installed/);
});

test("the Available tab narrows folders, keeps Install All, and drill-in shows only the filtered subset", async () => {
  const { list, tabs, folderCard } = await openWithTabs({ seedFolder: "productivity" });

  tabs.available.click();
  await flushAsync();

  let html = list.innerHTML;
  assert.match(html, /data-plugin-name="productivity"/);
  assert.match(html, /data-plugin-name="research"/);
  // The narrowed folder still installs its matching subset.
  assert.match(
    html,
    /marketplace-plugin-install-all-btn" data-plugin-name="productivity"/,
  );
  // Root skills follow the predicate: the uninstalled Loner stays, installed
  // Solo drops. The external plugin's placeholder was consumed into a folder
  // with no installable skills, so it vanishes here too.
  assert.match(html, /data-skill-id="loner"/);
  assert.doesNotMatch(html, /data-plugin-name="ext-plugin"/);
  assert.doesNotMatch(html, /data-skill-id="solo"/);

  folderCard.click({ target: { closest: () => null } });
  await flushAsync();

  html = list.innerHTML;
  assert.match(html, /marketplace-plugin-back-btn/);
  assert.match(html, /data-skill-id="tracker"/, "the available plugin skill renders");
  assert.doesNotMatch(html, /data-skill-id="planner"/, "the installed one is filtered out");
});

test("the Has Updates tab shows only folders containing updates and a filter-aware empty state otherwise", async () => {
  const withUpdates = await openWithTabs();
  withUpdates.tabs.updates.click();
  await flushAsync();
  let html = withUpdates.list.innerHTML;
  assert.match(html, /data-plugin-name="productivity"/);
  assert.match(html, /badge-version">1 skill</);
  assert.doesNotMatch(html, /data-plugin-name="research"/);
  assert.doesNotMatch(html, /data-skill-id="solo"/);

  const noUpdates = await openWithTabs({
    skills: catalogSkills({ withUpdate: false }),
  });
  noUpdates.tabs.updates.click();
  await flushAsync();
  html = noUpdates.list.innerHTML;
  assert.doesNotMatch(html, /marketplace-plugin-folder-card/);
  assert.match(html, /No skills match this filter/);
});

test("search flattens even while a filter tab is active, combining both predicates", async () => {
  const { h, list, tabs } = await openWithTabs();

  tabs.installed.click();
  await flushAsync();
  const searchInput = h.getElementById("marketplace-skills-search-input");
  searchInput.dispatch("input", { target: { value: "l" } });
  await flushAsync();

  const html = list.innerHTML;
  // Flat list (search), restricted to installed matches of "l". Plugin
  // provenance renders as the badge-plugin chip on flattened cards.
  assert.doesNotMatch(html, /marketplace-plugin-folder-card/);
  assert.match(html, /badge-plugin"[^>]*title="From plugin Productivity"[^>]*>Productivity</);
  assert.match(html, /data-skill-id="planner"/);
  assert.match(html, /data-skill-id="solo"/);
  assert.doesNotMatch(html, /data-skill-id="loner"/, "uninstalled search match stays filtered out");

  // Clearing the search returns to the filtered hierarchy.
  searchInput.dispatch("input", { target: { value: "" } });
  await flushAsync();
  assert.match(list.innerHTML, /marketplace-plugin-folder-card/);
});

test("switching tabs while drilled into a plugin re-filters in place and empties filter-aware", async () => {
  const { list, tabs, folderCard } = await openWithTabs({ seedFolder: "research" });

  folderCard.click({ target: { closest: () => null } });
  await flushAsync();
  assert.match(list.innerHTML, /data-skill-id="reader"/);

  tabs.installed.click();
  await flushAsync();
  const html = list.innerHTML;
  assert.match(html, /marketplace-plugin-back-btn/, "still drilled in");
  assert.match(html, /marketplace-plugin-drillin-title">Research</);
  assert.doesNotMatch(html, /data-skill-id="reader"/);
  assert.match(html, /No skills in this plugin match this filter/);
});

test("filter tabs narrow plugin-name search results like the hierarchy view", async () => {
  const { h, list } = await openWithTabs();
  const tabs = {};
  for (const tab of h.docQsaResults.get(
    "#marketplace-skills-filter-tabs .mcp-filter-tab",
  )) {
    tabs[tab.dataset.filter] = tab;
  }

  const searchInput = h.getElementById("marketplace-skills-search-input");
  searchInput.dispatch("input", { target: { value: "p" } });
  await flushAsync();

  // Available tab: productivity narrows to tracker (uninstalled), which does
  // not match "p" — the folder shows for its NAME, without a matching chip.
  tabs.available.click();
  await flushAsync();
  let html = list.innerHTML;
  assert.match(html, /marketplace-plugin-folder-card" data-plugin-name="productivity"/);
  assert.match(html, /badge-version">1 skill</, "folder chip reflects the tab-narrowed member count");
  assert.doesNotMatch(html, /matching</);
  assert.doesNotMatch(html, /data-plugin-name="research"/, "non-matching plugin names stay hidden");

  // Updates tab: only planner (installed + hasUpdate) remains and it matches
  // "p", so the folder carries the matching chip.
  tabs.updates.click();
  await flushAsync();
  html = list.innerHTML;
  assert.match(html, /badge-installed">1 matching</);
});
