// Agent Skills inline Discover mode (round 6): the Discover tab renders
// Solutions Marketplace skill listings as real skill cards with local-state
// badges (User/Published/Installed parity with the other tabs), and the Git
// tab keeps the old marketplaces-browse behavior byte-identical.
//
// Behavioral suite (no source pins): agent-skills.js runs bundled in the vm
// FakeElement harness (agent-skills-harness.js) with the real shared
// skill-card-renderer.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  FakeElement,
  flushAsync,
  loadAgentSkillsHarness,
} = require("./agent-skills-harness");

const USER_NOTES = Object.freeze({
  name: "notes",
  display_name: "Notes",
  source: "user",
  skill_path: "skills-user/notes",
  description: "My published notes skill",
  created_by_email: "dsantiago@example.invalid",
  version: "2.0",
});

const INSTALLED_ART = Object.freeze({
  name: "ai-marketplace/algorithmic-art",
  display_name: "Algorithmic Art",
  source: "marketplace",
  skill_path: "skills-marketplace/ai-marketplace/algorithmic-art",
  marketplace_id: "ai-marketplace",
  marketplace_name: "AI Marketplace",
  marketplace_solution_id: "sol-art",
  description: "Installed art skill",
  version: "1.0",
});

const LISTING_LLM = Object.freeze({
  id: "sol-llm",
  name: "llm-proxy-analytics",
  description: "Query Portico's LLM Proxy logging data.",
  author: "jdoe@example.invalid",
  submitted_by: "jdoe@example.invalid",
  type: "skills",
  has_bundle: true,
});

function discoverHarness({ skills = [], links = {}, publishedSolutionIds = [], results = [], agentUsage = [], searchImpl = null, installImpl = null, getBundleImpl = null } = {}) {
  const searchCalls = [];
  const installCalls = [];
  const getBundleCalls = [];
  const harness = loadAgentSkillsHarness({
    skills,
    links,
    publishedSolutionIds,
    agentUsage,
    marketplace: {
      search: async (params) => {
        searchCalls.push(JSON.parse(JSON.stringify(params)));
        if (searchImpl) return searchImpl(params);
        return { success: true, data: { results } };
      },
      install: async (solutionId, opts) => {
        installCalls.push([solutionId, opts]);
        if (installImpl) return installImpl(solutionId, opts);
        return { success: true };
      },
      getBundle: async (solutionId) => {
        getBundleCalls.push(solutionId);
        if (getBundleImpl) return getBundleImpl(solutionId);
        return {
          success: true,
          data: {
            type: "skills",
            payload: { name: String(solutionId), skill_md: "# default\n" },
          },
        };
      },
    },
  });
  return { ...harness, searchCalls, installCalls, getBundleCalls };
}

async function activateDiscover(harness) {
  harness.window.AgentSkillsHooks.applySkillsActiveFilter("discover");
  await flushAsync();
}

test("Discover fetches Solutions listings once per TTL and renders Title-cased cards without source chips or menus", async () => {
  const h = discoverHarness({ results: [LISTING_LLM] });
  await h.window.loadSkills();
  await activateDiscover(h);

  assert.deepEqual(h.searchCalls, [
    { query: "", filters: { type: ["skills"] }, page: 1, pageSize: 100 },
  ]);

  const list = h.getElementById("skills-list");
  // Human display name from the shared renderer, not the slug.
  assert.match(list.innerHTML, /Llm Proxy Analytics/);
  assert.match(
    list.innerHTML,
    /skill-discover-install-btn" data-solution-id="sol-llm">Install Skill</,
  );
  // Remote listing: no local-source chip, author from LDAP; round 12 added
  // a kebab menu for parity with the local tabs.
  assert.doesNotMatch(list.innerHTML, />User</);
  assert.doesNotMatch(list.innerHTML, />Core</);
  assert.match(list.innerHTML, /mcp-card-menu-trigger/);
  assert.match(list.innerHTML, />jdoe</);
  // The skills panel + skills search stay active (no marketplaces swap).
  assert.equal(h.getElementById("skills-browse-panel").style.display, "");
  assert.equal(h.getElementById("marketplaces-view").style.display, "none");
  assert.equal(h.getElementById("skills-search-wrapper").style.display, "");

  // Re-activating within the TTL serves the cache — no second search.
  h.window.AgentSkillsHooks.applySkillsActiveFilter("user");
  await activateDiscover(h);
  assert.equal(h.searchCalls.length, 1);
});

test("a listing the viewer publishes renders from the local user skill: User + Published, disabled Installed button", async () => {
  const h = discoverHarness({
    skills: [USER_NOTES],
    links: { notes: { solutionId: "sol-notes", hasLocalChanges: false } },
    publishedSolutionIds: ["sol-notes"],
    results: [
      {
        id: "sol-notes",
        name: "notes",
        description: "My published notes skill",
        author: "dsantiago@example.invalid",
        has_bundle: true,
      },
    ],
  });
  await h.window.loadSkills();
  await activateDiscover(h);

  const html = h.getElementById("skills-list").innerHTML;
  assert.match(html, />User</);
  assert.match(html, />Published</);
  assert.match(html, /You publish this skill/);
  assert.match(html, /skill-discover-install-btn btn-all-installed" disabled/);
  assert.doesNotMatch(html, /data-solution-id="sol-notes">Install Skill</);

  // A disabled button never installs, even if something dispatches a click.
  const fakeBtn = new FakeElement("disabled-install");
  fakeBtn.disabled = true;
  h.getElementById("skills-list").qsaResults.set(".skill-discover-install-btn", [fakeBtn]);
  h.window.AgentSkillsHooks.applySkillsActiveFilter("discover");
  await flushAsync();
  fakeBtn.click();
  await flushAsync();
  assert.equal(h.installCalls.length, 0);
});

test("an installed listing renders from the local marketplace copy: Installed + marketplace name, disabled button", async () => {
  const h = discoverHarness({
    skills: [INSTALLED_ART],
    results: [
      {
        id: "sol-art",
        name: "algorithmic-art",
        description: "Installed art skill",
        author: "anthropic",
        has_bundle: true,
      },
    ],
  });
  await h.window.loadSkills();
  await activateDiscover(h);

  const html = h.getElementById("skills-list").innerHTML;
  assert.match(html, />Installed</);
  // The Discover tab IS the Solutions Marketplace — no redundant name chip.
  assert.doesNotMatch(html, /badge-marketplace-name/);
  assert.match(html, /Already installed as Algorithmic Art/);
  // Green checkmark state indicator, still disabled for the install wiring.
  assert.match(html, /skill-discover-install-btn btn-all-installed" disabled/);
  assert.match(html, /polyline points="20 6 9 17 4 12"/);
  assert.match(html, / Installed<\/button>/);
  // Not viewer-published: no Published chip.
  assert.doesNotMatch(html, />Published</);
});

test("installing a plain listing flips the card to Installed in place — no tab jump", async () => {
  const skills = [];
  const h = discoverHarness({
    skills,
    results: [
      {
        id: "sol-tool",
        name: "tool-x",
        description: "A tool",
        author: "someone@example.invalid",
        has_bundle: true,
      },
    ],
    installImpl: async () => {
      // The install lands a local marketplace copy; the next getSkills sees it.
      skills.push({
        name: "ai-marketplace/tool-x",
        display_name: "Tool X",
        source: "marketplace",
        skill_path: "skills-marketplace/ai-marketplace/tool-x",
        marketplace_id: "ai-marketplace",
        marketplace_name: "AI Marketplace",
        marketplace_solution_id: "sol-tool",
        description: "A tool",
        version: "1.0",
      });
      return { success: true };
    },
  });
  await h.window.loadSkills();
  await activateDiscover(h);
  assert.match(
    h.getElementById("skills-list").innerHTML,
    /data-solution-id="sol-tool">Install Skill</,
  );

  // Stage the rendered install button and click it.
  const btn = new FakeElement("install-btn");
  btn.dataset.solutionId = "sol-tool";
  h.getElementById("skills-list").qsaResults.set(".skill-discover-install-btn", [btn]);
  h.window.AgentSkillsHooks.applySkillsActiveFilter("discover");
  await flushAsync();
  btn.click();
  await flushAsync(12);

  assert.deepEqual(h.installCalls, [["sol-tool", undefined]]);
  assert.ok(
    h.notifications.some(
      ([kind, message]) => kind === "success" && /installed successfully/i.test(message),
    ),
  );
  // Still on Discover (no tab jump), and the card now reads Installed —
  // flipped to the green checkmark state in place.
  assert.equal(h.getElementById("marketplaces-view").style.display, "none");
  assert.equal(h.getElementById("skills-search-wrapper").style.display, "");
  const html = h.getElementById("skills-list").innerHTML;
  assert.match(html, />Installed</);
  assert.match(html, /Already installed as Tool X/);
  assert.match(html, /skill-discover-install-btn btn-all-installed" disabled/);
  assert.doesNotMatch(html, /data-solution-id="sol-tool">Install Skill</);
});

test("a listing without a bundle renders a disabled Install with the reason", async () => {
  const h = discoverHarness({
    results: [
      {
        id: "sol-nb",
        name: "no-bundle",
        description: "Not installable",
        author: "someone",
        has_bundle: false,
      },
    ],
  });
  await h.window.loadSkills();
  await activateDiscover(h);

  const html = h.getElementById("skills-list").innerHTML;
  assert.match(html, /skill-discover-install-btn" disabled title="No bundle attached"/);
});

test("the skills search box filters Discover client-side without refetching", async () => {
  const h = discoverHarness({
    results: [
      LISTING_LLM,
      {
        id: "sol-other",
        name: "meeting-scheduler",
        description: "Schedules meetings",
        author: "someone",
        has_bundle: true,
      },
    ],
  });
  await h.window.loadSkills();
  await activateDiscover(h);
  assert.match(h.getElementById("skills-list").innerHTML, /Meeting Scheduler/);

  const searchInput = h.getElementById("skills-search-input");
  searchInput.dispatch("input", { target: { value: "llm" } });
  await flushAsync();

  const html = h.getElementById("skills-list").innerHTML;
  assert.match(html, /Llm Proxy Analytics/);
  assert.doesNotMatch(html, /Meeting Scheduler/);
  assert.equal(h.searchCalls.length, 1, "client-side filtering never refetches");

  // No matches → the standard no-results copy.
  searchInput.dispatch("input", { target: { value: "zzz-nothing" } });
  await flushAsync();
  assert.match(h.getElementById("skills-list").innerHTML, /No skills match your search/);
});

test("a failed listings fetch shows an error state and Retry refetches", async () => {
  let attempts = 0;
  const h = discoverHarness({
    searchImpl: async () => {
      attempts += 1;
      if (attempts === 1) return { success: false, error: "marketplace offline" };
      return {
        success: true,
        data: { results: [LISTING_LLM] },
      };
    },
  });
  await h.window.loadSkills();
  await activateDiscover(h);

  const list = h.getElementById("skills-list");
  assert.match(list.innerHTML, /Couldn't load marketplace skills/);
  assert.match(list.innerHTML, /marketplace offline/);
  assert.match(list.innerHTML, /skill-discover-retry-btn/);

  list.querySelector(".skill-discover-retry-btn").click();
  await flushAsync(12);

  assert.equal(h.searchCalls.length, 2);
  assert.match(list.innerHTML, /Llm Proxy Analytics/);
});

test("a stale link whose local skill was deleted shows Published but stays installable", async () => {
  // The main-process guard verifies SKILL.md on disk, so installing a listing
  // with a dangling link succeeds — the card must not pretend it is local.
  const h = discoverHarness({
    skills: [],
    links: { ghost: { solutionId: "sol-ghost", hasLocalChanges: false } },
    publishedSolutionIds: ["sol-ghost"],
    results: [
      {
        id: "sol-ghost",
        name: "ghost",
        description: "Published but locally deleted",
        author: "dsantiago@example.invalid",
        has_bundle: true,
      },
    ],
  });
  await h.window.loadSkills();
  await activateDiscover(h);

  const html = h.getElementById("skills-list").innerHTML;
  assert.match(html, />Published</);
  assert.doesNotMatch(html, />User</);
  assert.match(html, /data-solution-id="sol-ghost">Install Skill</);
});

test("a viewer-owned listing that is installed as a copy reads Published + Installed from the local copy", async () => {
  const h = discoverHarness({
    skills: [INSTALLED_ART],
    publishedSolutionIds: ["sol-art"],
    results: [
      {
        id: "sol-art",
        name: "algorithmic-art",
        description: "Installed art skill",
        author: "dsantiago@example.invalid",
        has_bundle: true,
      },
    ],
  });
  await h.window.loadSkills();
  await activateDiscover(h);

  const html = h.getElementById("skills-list").innerHTML;
  assert.match(html, />Published</);
  assert.match(html, />Installed</);
  // The Discover tab IS the Solutions Marketplace — no redundant name chip.
  assert.doesNotMatch(html, /badge-marketplace-name/);
  assert.match(html, /skill-discover-install-btn btn-all-installed" disabled/);
});

test("Discover ranks counterpart-installed listings first and click-through follows the ranked order", async () => {
  const h = discoverHarness({
    skills: [INSTALLED_ART, USER_NOTES],
    links: { notes: { solutionId: "sol-notes", hasLocalChanges: false } },
    publishedSolutionIds: ["sol-notes"],
    skillFilesByName: {
      [INSTALLED_ART.name]: { files: [], basePath: "" },
    },
    results: [
      { id: "sol-c", name: "ccc-tool", description: "C", author: "c@example.invalid", has_bundle: true },
      { id: "sol-art", name: "algorithmic-art", description: "Installed art skill", author: "anthropic", has_bundle: true },
      { id: "sol-a", name: "aaa-tool", description: "A", author: "a@example.invalid", has_bundle: true },
      { id: "sol-notes", name: "notes", description: "Published notes", author: "dsantiago@example.invalid", has_bundle: true },
    ],
  });
  await h.window.loadSkills();
  await activateDiscover(h);

  const html = h.getElementById("skills-list").innerHTML;
  // Delivered (relevance) order was C, ART, A, NOTES. Counterpart-backed
  // cards lead, ALPHABETICAL within each group — the backend's opaque
  // relevance order never decides: ART, NOTES, then AAA before CCC despite
  // CCC arriving first.
  const artIdx = html.indexOf("Algorithmic Art");
  const notesIdx = html.indexOf("Notes");
  const aIdx = html.indexOf("Aaa Tool");
  const cIdx = html.indexOf("Ccc Tool");
  assert.ok(artIdx >= 0 && notesIdx >= 0 && aIdx >= 0 && cIdx >= 0, "all four cards rendered");
  assert.ok(
    artIdx < notesIdx && notesIdx < aIdx && aIdx < cIdx,
    `installed-first + alphabetical ranking violated: ${[artIdx, notesIdx, aIdx, cIdx].join(",")}`,
  );

  // Click-through must pair with the RANKED order, not the delivered order:
  // slot 0 is the installed counterpart (opens the exact local page), slot 2
  // is pure listing A (opens the read-only bundle page).
  const cards = [0, 1, 2, 3].map((i) => new FakeElement(`discover-card-${i}`));
  h.getElementById("skills-list").qsaResults.set(".skill-card", cards);
  h.window.AgentSkillsHooks.applySkillsActiveFilter("discover");
  await flushAsync();
  const cardBodyClick = { target: { closest: () => null } };
  cards[0].click(cardBodyClick);
  await flushAsync(12);
  assert.deepEqual(
    h.calls.getSkillFiles,
    [INSTALLED_ART.name],
    "counterpart card opened the local skill page",
  );
  assert.equal(h.getBundleCalls.length, 0, "no bundle fetch for a local counterpart");

  h.window.closeSkillDetailsModal();
  h.window.AgentSkillsHooks.applySkillsActiveFilter("discover");
  await flushAsync();
  cards[2].click(cardBodyClick);
  await flushAsync(12);
  assert.deepEqual(h.getBundleCalls, ["sol-a"], "pure listing card opened its own bundle page");
});

test("the Git tab keeps the marketplaces browse byte-identical: loadMarketplaces + panel swap, no solutions fetch", async () => {
  const h = discoverHarness({ results: [LISTING_LLM] });
  const loadMarketplacesCalls = [];
  h.window.loadMarketplaces = async () => {
    loadMarketplacesCalls.push(true);
  };
  await h.window.loadSkills();

  h.window.AgentSkillsHooks.applySkillsActiveFilter("marketplaces-browse");
  await flushAsync();

  assert.equal(loadMarketplacesCalls.length, 1);
  assert.equal(h.getElementById("skills-browse-panel").style.display, "none");
  assert.equal(h.getElementById("marketplaces-view").style.display, "");
  assert.equal(h.getElementById("skills-search-wrapper").style.display, "none");
  assert.equal(h.getElementById("marketplaces-search-wrapper").style.display, "");
  assert.equal(h.searchCalls.length, 0, "the Git tab never queries remote solutions");
});

test("Sync All lives on the Git tab only; Add Marketplace stays everywhere", async () => {
  const h = discoverHarness({ skills: [USER_NOTES] });
  h.window.loadMarketplaces = async () => {};
  await h.window.loadSkills();

  const syncAll = h.getElementById("check-updates-btn");
  const addMarketplace = h.getElementById("add-marketplace-btn");

  // Entering the subview on the default (user) tab hides Sync All.
  h.window.showAgentSkillsView({ refresh: false });
  assert.equal(syncAll.style.display, "none");
  assert.equal(addMarketplace.style.display, "");

  h.window.AgentSkillsHooks.applySkillsActiveFilter("marketplaces-browse");
  await flushAsync();
  assert.equal(syncAll.style.display, "", "Git tab shows Sync All");
  assert.equal(addMarketplace.style.display, "");

  for (const filter of ["user", "published", "marketplace", "all", "discover"]) {
    h.window.AgentSkillsHooks.applySkillsActiveFilter(filter);
    await flushAsync();
    assert.equal(syncAll.style.display, "none", `${filter} tab hides Sync All`);
    assert.equal(addMarketplace.style.display, "", `${filter} keeps Add Marketplace`);
  }
});

test("closing the inline skill page restores the Sync All state of the active tab", async () => {
  const h = discoverHarness({ skills: [USER_NOTES] });
  h.window.loadMarketplaces = async () => {};
  await h.window.loadSkills();
  h.window.appState.controlPlaneView = "agent-skills";

  const syncAll = h.getElementById("check-updates-btn");

  // Git tab active: a page open/close cycle must land back on visible.
  h.window.AgentSkillsHooks.applySkillsActiveFilter("marketplaces-browse");
  await flushAsync();
  syncAll.style.display = "none"; // as the open page hides header actions
  h.window.closeSkillDetailsModal();
  assert.equal(syncAll.style.display, "");
  assert.equal(h.getElementById("skills-header-actions").style.display, "");

  // Non-Git tab active: the restore keeps Sync All hidden.
  h.window.AgentSkillsHooks.applySkillsActiveFilter("user");
  await flushAsync();
  syncAll.style.display = "";
  h.window.closeSkillDetailsModal();
  assert.equal(syncAll.style.display, "none");
});

test("showAgentSkillsView keeps the browse chrome hidden while the inline marketplace page is open", async () => {
  const h = discoverHarness({ skills: [USER_NOTES] });
  h.window.loadMarketplaces = async () => {};
  await h.window.loadSkills();

  // The marketplace details page owns the subview (marketplaces.js hides the
  // browser on open); a top-tab switch away/back re-runs showAgentSkillsView,
  // which must not resurface the browse chrome underneath the page.
  h.window.isMarketplaceDetailsPageOpen = () => true;
  h.window.showAgentSkillsView({ refresh: false });
  assert.equal(h.getElementById("agent-skills-browser").style.display, "none");
  assert.equal(h.getElementById("skills-header-actions").style.display, "none");

  // updateSkillsHeaderActions is exported so the marketplace page teardown
  // can restore Sync All according to whichever tab is active.
  assert.equal(
    typeof h.window.AgentSkillsHooks.updateSkillsHeaderActions,
    "function",
  );
  const syncAll = h.getElementById("check-updates-btn");
  h.window.AgentSkillsHooks.applySkillsActiveFilter("marketplaces-browse");
  await flushAsync();
  syncAll.style.display = "none";
  h.window.AgentSkillsHooks.updateSkillsHeaderActions();
  assert.equal(syncAll.style.display, "", "Git tab restores Sync All");
  h.window.AgentSkillsHooks.applySkillsActiveFilter("user");
  await flushAsync();
  assert.equal(syncAll.style.display, "none", "other tabs keep Sync All hidden");
});

test("skills search matches title and author only on local tabs and Discover", async () => {
  const h = discoverHarness({
    skills: [USER_NOTES, { ...INSTALLED_ART, author: "anthropic" }],
    results: [
      LISTING_LLM,
      {
        id: "sol-sched",
        name: "meeting-scheduler",
        description: "Schedules meetings automatically",
        author: "someone",
        has_bundle: true,
      },
    ],
  });
  await h.window.loadSkills();
  const list = h.getElementById("skills-list");
  const searchInput = h.getElementById("skills-search-input");

  // Local tabs: description words never match; titles and authors do.
  h.window.AgentSkillsHooks.applySkillsActiveFilter("all");
  searchInput.dispatch("input", { target: { value: "published" } });
  await flushAsync();
  assert.match(list.innerHTML, /No skills match your search/);
  searchInput.dispatch("input", { target: { value: "dsantiago" } });
  await flushAsync();
  assert.match(list.innerHTML, /Notes/);
  assert.doesNotMatch(list.innerHTML, /Algorithmic Art/);
  searchInput.dispatch("input", { target: { value: "anthropic" } });
  await flushAsync();
  assert.match(list.innerHTML, /Algorithmic Art/);
  assert.doesNotMatch(list.innerHTML, /Notes</);

  // Discover: same contract against listing fields.
  searchInput.dispatch("input", { target: { value: "" } });
  await flushAsync();
  await activateDiscover(h);
  searchInput.dispatch("input", { target: { value: "logging" } });
  await flushAsync();
  assert.match(list.innerHTML, /No skills match your search/, "listing descriptions never match");
  searchInput.dispatch("input", { target: { value: "jdoe" } });
  await flushAsync();
  assert.match(list.innerHTML, /Llm Proxy Analytics/, "listing authors match");
  assert.doesNotMatch(list.innerHTML, /Meeting Scheduler/);
});

// ---------------------------------------------------------------------------
// Round 7: Discover card click-through → read-only skill page rendered from
// the marketplace bundle.
// ---------------------------------------------------------------------------

const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

const LISTING_BUNDLE = Object.freeze({
  type: "skills",
  payload: {
    name: "llm-proxy-analytics",
    skill_md: "---\nname: llm-proxy-analytics\n---\n# LLM Proxy body",
    references: [
      { path: "references/notes.md", content_b64: b64("reference body text") },
    ],
  },
});

function stageDiscoverCard(h) {
  const card = new FakeElement("discover-card");
  h.getElementById("skills-list").qsaResults.set(".skill-card", [card]);
  return card;
}

const cardBodyClick = { target: { closest: () => null } };

test("clicking a pure listing opens a read-only page rendered from the bundle", async () => {
  const h = discoverHarness({
    results: [LISTING_LLM],
    getBundleImpl: async () => ({ success: true, data: LISTING_BUNDLE }),
  });
  await h.window.loadSkills();
  const card = stageDiscoverCard(h);
  await activateDiscover(h);
  card.click(cardBodyClick);
  await flushAsync();

  assert.deepEqual(h.getBundleCalls, ["sol-llm"], "the bundle was fetched once");
  assert.equal(h.calls.getSkillFiles.length, 0, "no filesystem file listing");
  assert.equal(h.calls.readSkillFile.length, 0, "no filesystem reads");

  const host = h.getElementById("agent-skills-editor");
  assert.match(host.innerHTML, /agent-editor-page/);
  assert.match(host.innerHTML, /Llm Proxy Analytics/);
  assert.match(host.innerHTML, /marketplace-readonly-pane/);
  assert.match(host.innerHTML, /Install it to use it in chats/);
  assert.doesNotMatch(host.innerHTML, /was installed from/);
  assert.match(host.innerHTML, /skill-page-install-btn/);

  const tree = h.getElementById("skill-file-tree");
  assert.match(tree.innerHTML, /SKILL\.md/);
  assert.match(tree.innerHTML, /references/);
  assert.match(tree.innerHTML, /notes\.md/);
  assert.match(
    tree.innerHTML,
    /data-path="marketplace-listing:\/\/sol-llm\/references\/notes\.md"/,
  );

  // SKILL.md auto-opened from memory: frontmatter split + rendered body.
  const content = h.getElementById("skill-content-area");
  assert.match(content.innerHTML, /LLM Proxy body/);
  assert.match(content.innerHTML, /md-frontmatter/);
  assert.doesNotMatch(content.innerHTML, /skill-file-edit-btn/);
});

test("back restores the browser and reopening serves the bundle cache", async () => {
  const h = discoverHarness({
    results: [LISTING_LLM],
    getBundleImpl: async () => ({ success: true, data: LISTING_BUNDLE }),
  });
  await h.window.loadSkills();
  const card = stageDiscoverCard(h);
  await activateDiscover(h);
  card.click(cardBodyClick);
  await flushAsync();
  assert.equal(h.getBundleCalls.length, 1);

  const host = h.getElementById("agent-skills-editor");
  host.querySelector(".agent-editor-back-btn").click();
  await flushAsync();
  assert.equal(host.innerHTML, "", "page torn down");
  assert.equal(
    h.getElementById("agent-skills-browser").style.display,
    "",
    "browser restored",
  );

  card.click(cardBodyClick);
  await flushAsync();
  assert.equal(h.getBundleCalls.length, 1, "second open used the session cache");
  assert.match(host.innerHTML, /Llm Proxy Analytics/);
});

test("a listing with a local counterpart opens the LOCAL page — no bundle fetch", async () => {
  const h = discoverHarness({
    skills: [INSTALLED_ART],
    results: [
      { id: "sol-art", name: "algorithmic-art", description: "d", has_bundle: true },
    ],
  });
  await h.window.loadSkills();
  const card = stageDiscoverCard(h);
  await activateDiscover(h);
  card.click(cardBodyClick);
  await flushAsync();

  assert.equal(h.getBundleCalls.length, 0, "no bundle fetch for local copies");
  assert.deepEqual(
    h.calls.getSkillFiles.map((c) => (Array.isArray(c) ? c[0] : c)),
    ["ai-marketplace/algorithmic-art"],
  );
  const host = h.getElementById("agent-skills-editor");
  assert.match(host.innerHTML, /was installed from the AI Solutions Marketplace/);
  assert.doesNotMatch(host.innerHTML, /skill-page-install-btn/);
});

test("an inline bundle on the listing skips the getBundle IPC", async () => {
  const h = discoverHarness({
    results: [{ ...LISTING_LLM, bundle: { type: "skills", payload: { skill_md: "# inline body" } } }],
  });
  await h.window.loadSkills();
  const card = stageDiscoverCard(h);
  await activateDiscover(h);
  card.click(cardBodyClick);
  await flushAsync();

  assert.equal(h.getBundleCalls.length, 0);
  assert.match(h.getElementById("skill-content-area").innerHTML, /inline body/);
});

test("JSON-string bundle payloads normalize", async () => {
  const h = discoverHarness({
    results: [LISTING_LLM],
    getBundleImpl: async () => ({
      success: true,
      data: { type: "skills", payload: JSON.stringify({ skill_md: "# stringified body" }) },
    }),
  });
  await h.window.loadSkills();
  const card = stageDiscoverCard(h);
  await activateDiscover(h);
  card.click(cardBodyClick);
  await flushAsync();

  assert.match(h.getElementById("skill-content-area").innerHTML, /stringified body/);
});

test("image references render from validated base64; hostile base64 falls back safely", async () => {
  const pngB64 = b64("fake-png-bytes");
  const h = discoverHarness({
    results: [LISTING_LLM],
    getBundleImpl: async () => ({
      success: true,
      data: {
        type: "skills",
        payload: {
          skill_md: "# with images",
          references: [
            { path: "references/diagram.png", content_b64: pngB64 },
            { path: "references/evil.png", content_b64: '"><script>alert(1)</script>' },
          ],
        },
      },
    }),
  });
  await h.window.loadSkills();
  const card = stageDiscoverCard(h);

  // Pre-stage the tree items the page will wire after rendering.
  const diagramItem = new FakeElement("diagram-item");
  diagramItem.dataset.path = "marketplace-listing://sol-llm/references/diagram.png";
  diagramItem.dataset.name = "diagram.png";
  const evilItem = new FakeElement("evil-item");
  evilItem.dataset.path = "marketplace-listing://sol-llm/references/evil.png";
  evilItem.dataset.name = "evil.png";
  h.getElementById("skill-file-tree").qsaResults.set(".skill-file-item", [
    diagramItem,
    evilItem,
  ]);

  await activateDiscover(h);
  card.click(cardBodyClick);
  await flushAsync();

  // Honest prediction check: those synthetic paths really rendered.
  const tree = h.getElementById("skill-file-tree");
  assert.match(tree.innerHTML, /marketplace-listing:\/\/sol-llm\/references\/diagram\.png/);

  const content = h.getElementById("skill-content-area");
  diagramItem.click({ target: diagramItem });
  await flushAsync();
  assert.match(content.innerHTML, /skill-image-preview/);
  assert.match(content.innerHTML, new RegExp(`src="data:image/png;base64,${pngB64}"`));
  assert.equal(h.calls.readSkillFile.length, 0);

  evilItem.click({ target: evilItem });
  await flushAsync();
  assert.match(content.innerHTML, /Unable to render image preview/);
  assert.ok(!content.innerHTML.includes("<script"), "hostile bytes never reach markup");
});

test("a no-bundle listing opens with an empty preview and a disabled Install", async () => {
  const h = discoverHarness({
    results: [{ ...LISTING_LLM, has_bundle: false }],
  });
  await h.window.loadSkills();
  const card = stageDiscoverCard(h);
  await activateDiscover(h);
  card.click(cardBodyClick);
  await flushAsync();

  assert.equal(h.getBundleCalls.length, 0, "no fetch without a bundle");
  assert.match(
    h.getElementById("skill-file-tree").innerHTML,
    /no bundle to preview/i,
  );
  const host = h.getElementById("agent-skills-editor");
  assert.match(host.innerHTML, /skill-page-install-btn[^>]*disabled/);
  assert.match(host.innerHTML, /No bundle attached/);
});

test("a failed bundle fetch shows an error, is not cached, and no_bundle disables Install", async () => {
  let attempts = 0;
  const h = discoverHarness({
    results: [LISTING_LLM],
    getBundleImpl: async () => {
      attempts += 1;
      if (attempts === 1) return { success: false, error: "boom" };
      return { success: false, code: "no_bundle", error: "gone" };
    },
  });
  await h.window.loadSkills();
  const card = stageDiscoverCard(h);
  await activateDiscover(h);

  card.click(cardBodyClick);
  await flushAsync();
  const tree = h.getElementById("skill-file-tree");
  assert.match(tree.innerHTML, /Couldn't load this skill from the marketplace/);

  // Back + reopen: the failure was NOT cached, so it refetches — and the
  // no_bundle failure flips the page Install to disabled.
  const host = h.getElementById("agent-skills-editor");
  host.querySelector(".agent-editor-back-btn").click();
  await flushAsync();
  card.click(cardBodyClick);
  await flushAsync();
  assert.equal(h.getBundleCalls.length, 2);
  // refreshSkillPageMarketplaceState re-renders through document.querySelector
  // (a separate vivified fake from the host's child in this harness).
  assert.match(
    h.document.querySelector("[data-skill-page-actions]").innerHTML,
    /skill-page-install-btn[^>]*disabled/,
  );
});

test("Install from the remote page lands on the local installed copy", async () => {
  const skills = [];
  const h = discoverHarness({
    skills,
    results: [LISTING_LLM],
    getBundleImpl: async () => ({ success: true, data: LISTING_BUNDLE }),
    installImpl: async () => {
      skills.push({
        name: "ai-marketplace/llm-proxy-analytics",
        display_name: "Llm Proxy Analytics",
        source: "marketplace",
        skill_path: "skills-marketplace/ai-marketplace/llm-proxy-analytics",
        marketplace_id: "ai-marketplace",
        marketplace_name: "AI Marketplace",
        marketplace_solution_id: "sol-llm",
        description: "Installed now",
        version: "1.0",
      });
      return { success: true };
    },
  });
  await h.window.loadSkills();
  const card = stageDiscoverCard(h);
  await activateDiscover(h);
  card.click(cardBodyClick);
  await flushAsync();

  const host = h.getElementById("agent-skills-editor");
  const installBtn = new FakeElement("page-install");
  installBtn.classList.add("skill-page-install-btn");
  host.querySelector("[data-skill-page-actions]").dispatch("click", {
    target: { closest: (sel) => (sel === "button" ? installBtn : null) },
  });
  await flushAsync(14);

  assert.deepEqual(h.installCalls, [["sol-llm", undefined]]);
  assert.ok(
    h.calls.getSkillFiles.some(
      (c) => (Array.isArray(c) ? c[0] : c) === "ai-marketplace/llm-proxy-analytics",
    ),
    "the page reopened on the local installed copy",
  );
  assert.match(host.innerHTML, /was installed from the AI Solutions Marketplace/);
});

test("the remote Published chip is exact-id fail-closed (no name aliasing)", async () => {
  // A local user skill named like the listing is linked to a DIFFERENT
  // solution — the listing page must NOT read as Published.
  const aliased = discoverHarness({
    skills: [{ ...USER_NOTES, name: "llm-proxy-analytics", display_name: "Llm Proxy Analytics" }],
    links: { "llm-proxy-analytics": { solutionId: "sol-other", hasLocalChanges: false } },
    publishedSolutionIds: [],
    results: [LISTING_LLM],
    getBundleImpl: async () => ({ success: true, data: LISTING_BUNDLE }),
  });
  await aliased.window.loadSkills();
  const card = stageDiscoverCard(aliased);
  await activateDiscover(aliased);
  card.click(cardBodyClick);
  await flushAsync();
  assert.doesNotMatch(
    aliased.getElementById("agent-skills-editor").innerHTML,
    /badge-published/,
  );

  // The genuinely-published listing DOES show the chip.
  const owned = discoverHarness({
    publishedSolutionIds: ["sol-llm"],
    results: [LISTING_LLM],
    getBundleImpl: async () => ({ success: true, data: LISTING_BUNDLE }),
  });
  await owned.window.loadSkills();
  const ownedCard = stageDiscoverCard(owned);
  await activateDiscover(owned);
  ownedCard.click(cardBodyClick);
  await flushAsync();
  assert.match(
    owned.getElementById("agent-skills-editor").innerHTML,
    /badge-published/,
  );
});

test("the card's Install button never opens the page", async () => {
  const h = discoverHarness({ results: [LISTING_LLM] });
  await h.window.loadSkills();
  await activateDiscover(h);

  const btn = new FakeElement("card-install");
  btn.dataset.solutionId = "sol-llm";
  h.getElementById("skills-list").qsaResults.set(".skill-discover-install-btn", [btn]);
  h.window.AgentSkillsHooks.applySkillsActiveFilter("discover");
  await flushAsync();
  btn.click();
  await flushAsync(12);

  assert.equal(h.installCalls.length, 1);
  assert.equal(h.getElementById("agent-skills-editor").innerHTML, "", "no page opened");
});

// ---------------------------------------------------------------------------
// Round 16: installed-counterpart cards offer the destructive lifecycle item
// in their kebab — Delete for user copies, Uninstall for managed installs —
// with the same agent-usage blocking as the local tabs and the marketplace
// directory kebabs.
// ---------------------------------------------------------------------------

test("counterpart kebabs carry the destructive item; pure listings never do", async () => {
  const h = discoverHarness({
    skills: [USER_NOTES, INSTALLED_ART],
    links: { notes: { solutionId: "sol-notes", hasLocalChanges: false } },
    publishedSolutionIds: ["sol-notes"],
    results: [
      { id: "sol-notes", name: "notes", description: "x", has_bundle: true },
      { id: "sol-art", name: "algorithmic-art", description: "y", has_bundle: true },
      LISTING_LLM,
    ],
  });
  await h.window.loadSkills();
  await activateDiscover(h);

  const html = h.getElementById("skills-list").innerHTML;
  // User copy: Delete, active markup (byte-parity with the local tabs).
  assert.match(
    html,
    /skill-discover-menu-delete-btn delete-action" data-solution-id="sol-notes" data-skill-name="notes">/,
  );
  // Managed install: Uninstall, never Delete.
  assert.match(
    html,
    /skill-discover-menu-uninstall-btn delete-action" data-solution-id="sol-art" data-skill-name="ai-marketplace\/algorithmic-art">/,
  );
  // The pure listing (no counterpart) offers Details/Install only.
  const llmCard = html.slice(html.indexOf('data-dropdown-solution-id="sol-llm"'));
  assert.doesNotMatch(llmCard, /skill-discover-menu-delete-btn/);
  assert.doesNotMatch(llmCard, /skill-discover-menu-uninstall-btn/);
});

test("agent-referenced counterparts grey the destructive item with the agents tooltip", async () => {
  const h = discoverHarness({
    skills: [USER_NOTES],
    links: { notes: { solutionId: "sol-notes", hasLocalChanges: false } },
    publishedSolutionIds: ["sol-notes"],
    agentUsage: [{ id: "a1", name: "Research Buddy", leaves: ["notes"] }],
    results: [
      { id: "sol-notes", name: "notes", description: "x", has_bundle: true },
    ],
  });
  await h.window.loadSkills();
  await activateDiscover(h);

  const html = h.getElementById("skills-list").innerHTML;
  assert.match(
    html,
    /skill-discover-menu-delete-btn delete-action info-tooltip-trigger" data-solution-id="sol-notes" data-skill-name="notes" aria-disabled="true"/,
  );
  assert.match(html, /data-info-tooltip-placement="right"/);
  assert.match(html, /Used by 1 agent&quot;/);
  assert.match(html, /Remove it from these agents first\./);
});

test("blocked clicks are inert (menu-preserving); active clicks open the delete confirm", async () => {
  const h = discoverHarness({
    skills: [USER_NOTES],
    links: { notes: { solutionId: "sol-notes", hasLocalChanges: false } },
    publishedSolutionIds: ["sol-notes"],
    results: [
      { id: "sol-notes", name: "notes", description: "x", has_bundle: true },
    ],
  });
  const list = h.getElementById("skills-list");
  const item = new FakeElement("discover-delete");
  item.dataset.solutionId = "sol-notes";
  item.dataset.skillName = "notes";
  item.setAttribute("aria-disabled", "true");
  list.qsaResults.set(".skill-discover-menu-delete-btn", [item]);
  await h.window.loadSkills();
  await activateDiscover(h);

  let stopped = 0;
  item.click({ stopPropagation: () => (stopped += 1), target: { closest: () => null } });
  await flushAsync();
  assert.equal(stopped, 1, "blocked click stops propagation (unconditional document closer)");
  assert.ok(
    !h.getElementById("delete-skill-modal").classList.contains("visible"),
    "no confirm while blocked",
  );

  item.removeAttribute("aria-disabled");
  item.click({ stopPropagation() {}, target: { closest: () => null } });
  await flushAsync();
  assert.ok(
    h.getElementById("delete-skill-modal").classList.contains("visible"),
    "the same wiring opens the delete confirm once the block clears",
  );
});

test("viewer-published counterparts offer Unpublish in the kebab; confirm carries the solution badge (round 19)", async () => {
  const h = discoverHarness({
    skills: [USER_NOTES, INSTALLED_ART],
    links: { notes: { solutionId: "sol-notes", hasLocalChanges: false } },
    publishedSolutionIds: ["sol-notes"],
    results: [
      { id: "sol-notes", name: "notes", description: "x", has_bundle: true },
      { id: "sol-art", name: "algorithmic-art", description: "y", has_bundle: true },
    ],
  });
  const list = h.getElementById("skills-list");
  const item = new FakeElement("discover-unpublish");
  item.dataset.solutionId = "sol-notes";
  list.qsaResults.set(".skill-discover-menu-unpublish-btn", [item]);
  await h.window.loadSkills();
  await activateDiscover(h);

  const html = list.innerHTML;
  // Published counterpart (notes): Unpublish renders before the destructive item.
  assert.match(
    html,
    /skill-discover-menu-unpublish-btn" data-solution-id="sol-notes"[\s\S]*?M12 5v14[\s\S]*?skill-discover-menu-delete-btn/,
  );
  // Installed-but-not-published counterpart: no Unpublish. (Cards rank
  // alphabetically, so the art card may precede the notes card — slice
  // strictly between the two markers.)
  const artStart = html.indexOf('data-dropdown-solution-id="sol-art"');
  const notesStart = html.indexOf('data-dropdown-solution-id="sol-notes"');
  const artCard = html.slice(
    artStart,
    notesStart > artStart ? notesStart : undefined,
  );
  assert.doesNotMatch(artCard, /skill-discover-menu-unpublish-btn/);

  item.click({ stopPropagation() {}, target: { closest: () => null } });
  await flushAsync();
  assert.equal(h.confirmCalls.length, 1);
  assert.equal(h.confirmCalls[0].title, "Unpublish?");
  assert.equal(h.confirmCalls[0].confirmBusyLabel, "Checking...");
  assert.equal(h.confirmCalls[0].meta?.badge, "sol-notes");
});
