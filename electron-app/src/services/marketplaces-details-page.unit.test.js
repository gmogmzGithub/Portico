// Marketplace details INLINE PAGE behavior — page chrome/takeover, plugin
// drill-in, and install state actions. Also the behavioral home for two
// former control-plane-render-regressions source pins: "marketplace details
// surface dirty and conflict actions for installed marketplace skills" and
// "marketplace details modal exposes copy-url and view-repo actions before
// sync" (now the page-chrome/copy-url/contribution-notice tests below).
//
// Views under test: opening a marketplace renders an .agent-editor-page into
// the #marketplace-details-page host and hides the browse chrome, exactly
// like the inline skill page. "all" renders plugin folder cards + root
// skills as direct grid children under full-width section titles; folder
// click drills into that plugin's skills behind a back row; search (or a
// non-"all" filter) renders the flat list with plugin subtitles. External
// (unavailable) plugins and skills are hidden entirely — no install path
// means no card, on any view including search. Install-all runs
// sequentially, carries plugin_name, and accumulates errors. The
// dirty/conflict actions dispatch the real IPC calls with plugin_name
// threading. Installs never flip the underlying skills tab.
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
  marketplaceVersion: "1.0.0",
  cachedManifest: {
    name: "kwp",
    plugins: [
      {
        name: "productivity",
        description: "Productivity tools",
        category: "work",
        skills: ["./productivity/skills/planner", "./productivity/skills/tracker"],
      },
      {
        name: "sales-plugin",
        description: "External sales tools",
        source: { source: "github", repo: "third-party/sales" },
        unavailable: true,
        unavailableReason: "source_not_allowed",
      },
      { name: "solo", description: "Single-skill plugin", source: "./solo" },
    ],
  },
});

function catalogSkills() {
  return [
    {
      id: "planner",
      name: "planner",
      displayName: "Planner",
      description: "Plan your day",
      skillPath: "./productivity/skills/planner",
      pluginName: "productivity",
      installed: true,
      installedVersion: "1.0",
      isDirty: true,
      hasUpdate: true,
      hasConflict: true,
      available: true,
    },
    {
      id: "tracker",
      name: "tracker",
      displayName: "Tracker",
      description: "Track tasks",
      skillPath: "./productivity/skills/tracker",
      pluginName: "productivity",
      installed: false,
      available: true,
    },
    {
      id: "sales-plugin",
      name: "sales-plugin",
      displayName: "Sales Plugin",
      description: "External sales tools",
      skillPath: "./",
      pluginName: null,
      installed: false,
      available: false,
      unavailableReason: "source_not_allowed",
    },
    {
      id: "solo",
      name: "solo",
      displayName: "Solo",
      description: "Installed root skill with local edits",
      skillPath: "./solo",
      pluginName: null,
      installed: true,
      installedVersion: "1.0",
      isDirty: true,
      available: true,
    },
  ];
}

function detailsHarness(overrides = {}) {
  return loadMarketplacesHarness({
    electronAPI: {
      getMarketplaceSkills: async (marketplaceId) => ({
        success: true,
        skills: catalogSkills(),
        marketplace: { ...MARKETPLACE, id: marketplaceId },
      }),
      ...overrides,
    },
  });
}

test("the default view renders plugin folders above root skills and hides external plugins entirely", async () => {
  const h = detailsHarness();
  await h.window.openMarketplaceDetailsModal(MARKETPLACE);
  await flushAsync();

  const html = h.getElementById("marketplace-skills-list").innerHTML;
  // Productivity folder: display name, skill count, installed count, and a
  // primary Install All button for its uninstalled skill (same face as the
  // Discover tab's install action). Category chips are gone (round 14).
  assert.match(html, /marketplace-plugin-folder-card/);
  assert.match(html, /Productivity/);
  assert.match(html, /2 skills/);
  assert.match(html, /1 INSTALLED/);
  assert.doesNotMatch(html, /badge-provider">WORK</);
  assert.match(
    html,
    /btn-primary marketplace-plugin-install-all-btn" data-plugin-name="productivity">Install All</,
  );
  // External plugin: unreachable to the user, so no card at all — neither a
  // folder nor its placeholder root entry, and no EXTERNAL badge anywhere.
  assert.doesNotMatch(html, /data-plugin-name="sales-plugin"/);
  assert.doesNotMatch(html, /data-skill-id="sales-plugin"/);
  assert.doesNotMatch(html, /badge-external/);
  // Root skill (single-skill plugin) renders as a plain card below folders.
  assert.match(html, /marketplace-root-skills-title/);
  assert.match(html, /Solo/);
  // Plugin skills do NOT render flat in the overview.
  assert.doesNotMatch(html, /marketplace-skill-card" data-skill-id="planner"/);
  // Folders are direct grid children under full-width section titles — a
  // wrapper div would collapse every folder into a single grid cell.
  assert.match(html, /marketplace-section-title">Plugins</);
  assert.match(html, /marketplace-section-title marketplace-root-skills-title">Skills</);
  assert.doesNotMatch(html, /marketplace-plugin-folders/);
  // Without the InfoTooltips helper on window, cards render zero triggers
  // (the typeof guard), never broken markup.
  assert.doesNotMatch(html, /info-tooltip-trigger/);
});

test("folder click drills into the plugin's skills and back returns to the overview", async () => {
  const h = detailsHarness();
  await h.window.openMarketplaceDetailsModal(MARKETPLACE);
  await flushAsync();

  const list = h.getElementById("marketplace-skills-list");
  const folderCard = new FakeElement("folder-productivity");
  folderCard.dataset.pluginName = "productivity";
  folderCard.dataset.drillable = "true";
  list.qsaResults.set(".marketplace-plugin-folder-card", [folderCard]);
  await h.window.openMarketplaceDetailsModal(MARKETPLACE);
  await flushAsync();

  folderCard.click({ target: { closest: () => null } });
  await flushAsync();

  const html = list.innerHTML;
  assert.match(html, /marketplace-plugin-back-btn/);
  assert.match(html, /marketplace-plugin-drillin-title">Productivity</);
  assert.match(html, /data-skill-id="planner"/);
  assert.match(html, /data-skill-id="tracker"/);
  // Uninstalled skills offer the Discover-consistent primary install action.
  assert.match(
    html,
    /btn-primary marketplace-skill-install-btn[^>]*data-skill-id="tracker"[^>]*>\s*Install Skill\s*</,
  );
  assert.doesNotMatch(html, /marketplace-plugin-folder-card/);
  // The plugin's conflict actions render inside the drill-in.
  assert.match(html, /marketplace-skill-discard-btn/);
  assert.match(html, /Discard Local Changes and Sync/);
  assert.match(html, /badge-conflict">CONFLICT</);

  // Back returns to the folder overview.
  list.querySelector(".marketplace-plugin-back-btn").click();
  await flushAsync();
  assert.match(list.innerHTML, /marketplace-plugin-folder-card/);
});

test("search renders the flat list with plugin badges; external skills never surface, even in search", async () => {
  const h = detailsHarness();
  await h.window.openMarketplaceDetailsModal(MARKETPLACE);
  await flushAsync();

  const searchInput = h.getElementById("marketplace-skills-search-input");
  searchInput.dispatch("input", { target: { value: "s" } });
  await flushAsync();

  const html = h.getElementById("marketplace-skills-list").innerHTML;
  assert.doesNotMatch(html, /marketplace-plugin-folder-card/);
  // Plugin provenance is the app-wide badge chip now, not a subtitle line.
  assert.match(html, /badge-plugin"[^>]*>Productivity</);
  assert.doesNotMatch(html, /marketplace-skill-plugin-subtitle/);
  // The external entry matches the query ("sales-plugin") but is hidden — it
  // has no install path, so search must not resurface it.
  assert.doesNotMatch(html, /data-skill-id="sales-plugin"/);
  assert.doesNotMatch(html, /badge-external/);
  // Dirty root skill still offers uninstall/detach with its warning.
  assert.match(html, /has local edits\. A future update will require/);
});

test("Install all installs each uninstalled plugin skill sequentially with plugin_name and accumulates errors", async () => {
  const installCalls = [];
  const progressTexts = [];
  let progressBtn = null;
  const h = detailsHarness({
    installMarketplaceSkill: async (...args) => {
      installCalls.push(args);
      progressTexts.push(progressBtn?.textContent);
      // First target fails, later ones succeed — the loop must continue.
      if (installCalls.length === 1) {
        return { success: false, error: "boom" };
      }
      return { success: true, localPath: "", version: "1.0" };
    },
    getMarketplaceSkills: async (marketplaceId) => ({
      success: true,
      skills: [
        ...catalogSkills(),
        {
          id: "notes",
          name: "notes",
          displayName: "Notes",
          description: "Second uninstalled skill",
          skillPath: "./productivity/skills/notes",
          pluginName: "productivity",
          installed: false,
          available: true,
        },
      ],
      marketplace: { ...MARKETPLACE, id: marketplaceId },
    }),
  });
  await h.window.openMarketplaceDetailsModal(MARKETPLACE);
  await flushAsync();

  const list = h.getElementById("marketplace-skills-list");
  const installAllBtn = new FakeElement("install-all");
  installAllBtn.dataset.pluginName = "productivity";
  progressBtn = installAllBtn;
  list.qsaResults.set(".marketplace-plugin-install-all-btn", [installAllBtn]);
  await h.window.openMarketplaceDetailsModal(MARKETPLACE);
  await flushAsync();

  installAllBtn.click({ target: installAllBtn, stopPropagation() {} });
  await flushAsync(16);

  // Progress counts plugin COMPLETION over the card's member total — the
  // already-installed planner seeds the numerator (3 members, 1 installed):
  // never "1/2" while the chip says "3 skills".
  assert.deepEqual(progressTexts, ["Installing 2/3…", "Installing 3/3…"]);

  // Both uninstalled productivity skills were attempted (tracker + notes),
  // each carrying the plugin name; installed ones were skipped.
  assert.equal(installCalls.length, 2);
  for (const call of installCalls) {
    assert.equal(call[0], "kwp");
    assert.equal(call[4], "productivity");
  }
  assert.deepEqual(
    installCalls.map((call) => call[1]).sort(),
    ["notes", "tracker"],
  );
  assert.ok(
    h.notifications.some(
      ([kind, message]) =>
        kind === "error" && /Installed 1 of 2/.test(message) && /boom/.test(message),
    ),
    "partial failure notification accumulates errors",
  );
});

test("dirty/conflict actions dispatch the real IPC calls with plugin_name threading", async () => {
  const h = detailsHarness();
  await h.window.openMarketplaceDetailsModal(MARKETPLACE);
  await flushAsync();

  const list = h.getElementById("marketplace-skills-list");
  const discardBtn = new FakeElement("discard");
  discardBtn.dataset.skillId = "planner";
  discardBtn.dataset.pluginName = "productivity";
  discardBtn.classList.add("marketplace-skill-discard-btn");
  const detachBtn = new FakeElement("detach");
  detachBtn.dataset.skillId = "solo";
  list.qsaResults.set(".marketplace-skill-discard-btn", [discardBtn]);
  list.qsaResults.set(".marketplace-skill-detach-btn", [detachBtn]);
  await h.window.openMarketplaceDetailsModal(MARKETPLACE);
  await flushAsync();

  discardBtn.click();
  await flushAsync();
  assert.equal(h.calls.updateMarketplaceSkill.length, 1);
  const [mpId, skillId, options] = h.calls.updateMarketplaceSkill[0];
  assert.equal(mpId, "kwp");
  assert.equal(skillId, "planner");
  assert.equal(options?.forceDiscardLocalChanges, true);
  assert.equal(options?.pluginName, "productivity");

  detachBtn.click();
  await flushAsync();
  assert.equal(h.calls.detachMarketplaceSkillToUserSkill.length, 1);
  const detachArgs = h.calls.detachMarketplaceSkillToUserSkill[0];
  assert.equal(detachArgs[0], "kwp");
  assert.equal(detachArgs[1], "solo");
  assert.equal(detachArgs[3] ?? null, null, "root skills carry no plugin");
});

test("closing and reopening the modal resets the drill-in to the overview", async () => {
  const h = detailsHarness();
  await h.window.openMarketplaceDetailsModal(MARKETPLACE);
  await flushAsync();
  const list = h.getElementById("marketplace-skills-list");
  const folderCard = new FakeElement("folder");
  folderCard.dataset.pluginName = "productivity";
  folderCard.dataset.drillable = "true";
  list.qsaResults.set(".marketplace-plugin-folder-card", [folderCard]);
  await h.window.openMarketplaceDetailsModal(MARKETPLACE);
  await flushAsync();
  folderCard.click({ target: { closest: () => null } });
  await flushAsync();
  assert.match(list.innerHTML, /marketplace-plugin-back-btn/);

  h.window.closeMarketplaceDetailsModal();
  await h.window.openMarketplaceDetailsModal(MARKETPLACE);
  await flushAsync();
  assert.match(list.innerHTML, /marketplace-plugin-folder-card/, "back to overview");
});

test("opening the details page takes over the Agent Skills subview with the standard page chrome", async () => {
  const h = detailsHarness();
  await h.window.openMarketplaceDetailsPage(MARKETPLACE);
  await flushAsync();

  // The whole browse chrome hides, exactly like the inline skill page.
  assert.equal(h.getElementById("agent-skills-browser").style.display, "none");
  assert.equal(h.getElementById("skills-header-actions").style.display, "none");

  const host = h.getElementById("marketplace-details-page");
  assert.equal(host.style.display, "");
  assert.match(host.innerHTML, /agent-editor-page/);
  assert.match(host.innerHTML, /agent-editor-back-btn/);
  assert.match(host.innerHTML, /agent-editor-page-chips/);
  // Header actions render copy-url, then view-repo, then sync, all as
  // standard page-action pills.
  assert.match(
    host.innerHTML,
    /marketplace-details-copy-url-btn[\s\S]*marketplace-details-view-repo-btn[\s\S]*marketplace-details-sync-btn/,
  );
  assert.match(host.innerHTML, /btn-secondary agent-page-action marketplace-copy-url-btn/);
  // The header updater filled the page title from the marketplace.
  assert.equal(
    h.getElementById("marketplace-details-name").textContent,
    "Knowledge Work Plugins",
  );
  assert.equal(h.window.isMarketplaceDetailsPageOpen(), true);
});

test("copy URL and view repo dispatch clipboard/openExternal with the canonical marketplace URL", async () => {
  const h = detailsHarness();
  await h.window.openMarketplaceDetailsPage(MARKETPLACE);
  await flushAsync();

  h.getElementById("marketplace-details-copy-url-btn").click();
  await flushAsync();
  assert.equal(h.calls.copyToClipboard.length, 1);
  assert.match(
    h.calls.copyToClipboard[0],
    /github\.com\/anthropics\/knowledge-work-plugins/,
  );
  assert.ok(
    h.notifications.some(
      ([kind, message]) =>
        kind === "success" && /Marketplace URL copied to clipboard/.test(message),
    ),
  );

  h.getElementById("marketplace-details-view-repo-btn").click();
  await flushAsync();
  assert.equal(h.calls.openExternal.length, 1);
  assert.match(
    h.calls.openExternal[0],
    /github\.com\/anthropics\/knowledge-work-plugins/,
  );
});

test("the contribution notice renders only for the Portico AI marketplace", async () => {
  const h = detailsHarness();
  await h.window.openMarketplaceDetailsPage({
    ...MARKETPLACE,
    id: "portico-ai-marketplace",
    name: "portico-ai-marketplace",
    source: {
      type: "gitlab",
      host: "example.invalid",
      projectPath: "community/portico-ai-marketplace",
      ref: "main",
    },
  });
  await flushAsync();
  const notice = h.getElementById("marketplace-contribution-notice");
  assert.equal(notice.style.display, "flex");
  // The notice content ships in the page shell.
  assert.match(h.getElementById("marketplace-details-page").innerHTML, /role="note"/);
  assert.match(
    h.getElementById("marketplace-details-page").innerHTML,
    /Fork MRs fail[\s\S]*because CI needs internal[\s\S]*variables/,
  );

  h.window.closeMarketplaceDetailsPage();
  await h.window.openMarketplaceDetailsPage(MARKETPLACE);
  await flushAsync();
  assert.equal(notice.style.display, "none");
});

test("Back restores the browse chrome and refreshes Sync All only while the skills subview is active", async () => {
  const h = detailsHarness();
  h.window.appState.controlPlaneView = "agent-skills";
  let headerActionRefreshes = 0;
  h.window.AgentSkillsHooks = {
    updateSkillsHeaderActions: () => {
      headerActionRefreshes += 1;
    },
  };

  await h.window.openMarketplaceDetailsPage(MARKETPLACE);
  await flushAsync();
  h.getElementById("marketplace-details-back-btn").click();
  await flushAsync();

  const host = h.getElementById("marketplace-details-page");
  assert.equal(host.style.display, "none");
  assert.equal(host.innerHTML, "");
  assert.equal(h.getElementById("agent-skills-browser").style.display, "");
  assert.equal(h.getElementById("skills-header-actions").style.display, "");
  assert.equal(headerActionRefreshes, 1);
  assert.equal(h.window.isMarketplaceDetailsPageOpen(), false);

  // With another control-plane view active, closing must NOT resurface the
  // skills header actions (mirrors the inline skill page teardown).
  h.window.appState.controlPlaneView = "agents";
  await h.window.openMarketplaceDetailsPage(MARKETPLACE);
  await flushAsync();
  h.window.closeMarketplaceDetailsPage();
  assert.equal(h.getElementById("agent-skills-browser").style.display, "");
  assert.equal(h.getElementById("skills-header-actions").style.display, "none");
  assert.equal(headerActionRefreshes, 1, "no refresh while another view owns the header");
});

test("a successful install re-renders the open page in place without flipping the skills tab", async () => {
  let skillFetches = 0;
  const h = detailsHarness({
    getMarketplaceSkills: async (marketplaceId) => {
      skillFetches += 1;
      return {
        success: true,
        skills: catalogSkills(),
        marketplace: { ...MARKETPLACE, id: marketplaceId },
      };
    },
  });
  let tabFlips = 0;
  h.window.switchAgentSkillsToInstalledTab = () => {
    tabFlips += 1;
  };

  await h.window.openMarketplaceDetailsPage(MARKETPLACE);
  await flushAsync();

  const list = h.getElementById("marketplace-skills-list");
  const installBtn = new FakeElement("install-tracker");
  installBtn.dataset.skillId = "tracker";
  installBtn.dataset.skillPath = encodeURIComponent("./productivity/skills/tracker");
  installBtn.dataset.pluginName = "productivity";
  list.qsaResults.set(".marketplace-skill-install-btn", [installBtn]);
  await h.window.openMarketplaceDetailsPage(MARKETPLACE);
  await flushAsync();
  const skillFetchesBeforeInstall = skillFetches;

  installBtn.click();
  await flushAsync(16);

  assert.equal(h.calls.installMarketplaceSkill.length, 1);
  assert.equal(h.calls.installMarketplaceSkill[0][1], "tracker");
  assert.equal(tabFlips, 0, "the inline page keeps the user in place");
  assert.ok(
    skillFetches > skillFetchesBeforeInstall,
    "the open page's grid re-rendered from a fresh catalog fetch",
  );
  assert.equal(h.window.isMarketplaceDetailsPageOpen(), true);
});

test("a reopen paints instantly from the session cache even while the refresh hangs", async () => {
  const h = detailsHarness();
  await h.window.openMarketplaceDetailsPage(MARKETPLACE);
  await flushAsync();

  // Second open: the authoritative refresh never resolves — the grid must
  // still paint from the session cache captured on the first open.
  h.window.electronAPI.getMarketplaceSkills = () => new Promise(() => {});
  h.window.closeMarketplaceDetailsPage();
  void h.window.openMarketplaceDetailsPage(MARKETPLACE);
  await flushAsync();

  const html = h.getElementById("marketplace-skills-list").innerHTML;
  assert.match(html, /marketplace-plugin-folder-card/);
  assert.doesNotMatch(html, /Loading skills/);
});

test("a cold open paints from the main-process cached fast path before the refresh lands, then upgrades", async () => {
  let resolveFull;
  const fullPromise = new Promise((resolve) => {
    resolveFull = resolve;
  });
  // The fast path serves the catalog without dirty/conflict facts yet.
  const fastSkills = catalogSkills().map((skill) => ({
    ...skill,
    isDirty: false,
    hasConflict: false,
  }));
  const h = loadMarketplacesHarness({
    electronAPI: {
      getMarketplaceSkillsCached: async (marketplaceId) => ({
        success: true,
        skills: fastSkills,
        marketplace: { ...MARKETPLACE, id: marketplaceId },
      }),
      getMarketplaceSkills: () => fullPromise,
    },
  });

  const openPromise = h.window.openMarketplaceDetailsPage(MARKETPLACE);
  await flushAsync();

  const list = h.getElementById("marketplace-skills-list");
  assert.match(list.innerHTML, /marketplace-plugin-folder-card/, "fast paint rendered");
  assert.doesNotMatch(list.innerHTML, /Loading skills/);
  assert.doesNotMatch(list.innerHTML, /badge-dirty/);

  // The single authoritative refresh upgrades the same grid in place: the
  // dirty root skill now carries its DIRTY badge.
  resolveFull({
    success: true,
    skills: catalogSkills(),
    marketplace: MARKETPLACE,
  });
  await openPromise;
  await flushAsync();
  assert.match(list.innerHTML, /badge-dirty/);
});

test("closing mid-flight discards the late refresh instead of painting a closed page", async () => {
  let resolveFull;
  const fullPromise = new Promise((resolve) => {
    resolveFull = resolve;
  });
  const h = loadMarketplacesHarness({
    electronAPI: {
      getMarketplaceSkills: () => fullPromise,
    },
  });

  const openPromise = h.window.openMarketplaceDetailsPage(MARKETPLACE);
  await flushAsync();
  h.window.closeMarketplaceDetailsPage();

  const list = h.getElementById("marketplace-skills-list");
  list.innerHTML = "SENTINEL";
  resolveFull({
    success: true,
    skills: catalogSkills(),
    marketplace: MARKETPLACE,
  });
  await openPromise;
  await flushAsync();
  assert.equal(list.innerHTML, "SENTINEL", "the stale resolution never repainted");
  assert.equal(h.window.isMarketplaceDetailsPageOpen(), false);
});

test("a painted grid survives a failed refresh with an error toast instead of an error screen", async () => {
  const h = detailsHarness();
  await h.window.openMarketplaceDetailsPage(MARKETPLACE);
  await flushAsync();

  h.window.electronAPI.getMarketplaceSkills = async () => ({
    success: false,
    error: "remote unreachable",
  });
  h.window.closeMarketplaceDetailsPage();
  await h.window.openMarketplaceDetailsPage(MARKETPLACE);
  await flushAsync();

  const html = h.getElementById("marketplace-skills-list").innerHTML;
  assert.match(html, /marketplace-plugin-folder-card/, "session-cached grid kept");
  assert.doesNotMatch(html, /Failed to load skills/);
  assert.ok(
    h.notifications.some(
      ([kind, message]) =>
        kind === "error" && /Failed to refresh skills/.test(message),
    ),
  );
});

test("the details header shows the full list-card badge set derived from the open catalog", async () => {
  const h = detailsHarness();
  await h.window.openMarketplaceDetailsPage(MARKETPLACE);
  await flushAsync();

  // catalogSkills(): planner + solo installed (both dirty), planner carries
  // the update and the conflict — the header derives the same counts the Git
  // tab list card shows, plus provider and version.
  const badges = h.getElementById("marketplace-details-badges").innerHTML;
  assert.match(badges, /badge-provider">GITHUB</);
  assert.match(badges, /badge-installed">2 INSTALLED</);
  assert.match(badges, /badge-has-updates">UPDATES</);
  assert.match(badges, /badge-conflict">1 CONFLICT</);
  assert.match(badges, /badge-dirty">2 DIRTY</);
  assert.match(badges, /badge-version">v1\.0\.0</);
});

test("header badges re-render from the refreshed catalog after an install", async () => {
  let fetches = 0;
  const h = detailsHarness({
    getMarketplaceSkills: async (marketplaceId) => {
      fetches += 1;
      const skills = catalogSkills();
      if (fetches > 2) {
        // After the install-triggered refresh, tracker reads as installed.
        const tracker = skills.find((s) => s.id === "tracker");
        tracker.installed = true;
        tracker.installedVersion = "1.0";
      }
      return {
        success: true,
        skills,
        marketplace: { ...MARKETPLACE, id: marketplaceId },
      };
    },
  });

  await h.window.openMarketplaceDetailsPage(MARKETPLACE);
  await flushAsync();
  assert.match(
    h.getElementById("marketplace-details-badges").innerHTML,
    /badge-installed">2 INSTALLED</,
  );

  const list = h.getElementById("marketplace-skills-list");
  const installBtn = new FakeElement("install-tracker");
  installBtn.dataset.skillId = "tracker";
  installBtn.dataset.skillPath = encodeURIComponent("./productivity/skills/tracker");
  installBtn.dataset.pluginName = "productivity";
  list.qsaResults.set(".marketplace-skill-install-btn", [installBtn]);
  await h.window.openMarketplaceDetailsPage(MARKETPLACE);
  await flushAsync();

  installBtn.click();
  await flushAsync(16);

  assert.match(
    h.getElementById("marketplace-details-badges").innerHTML,
    /badge-installed">3 INSTALLED</,
    "the header badge picked up the refreshed installed count",
  );
});

test("card actions render in a Discover-style bottom footer", async () => {
  const h = detailsHarness();
  await h.window.openMarketplaceDetailsModal(MARKETPLACE);
  await flushAsync();

  let html = h.getElementById("marketplace-skills-list").innerHTML;
  // Folder card: Install All sits inside the footer strip after the main row.
  assert.match(
    html,
    /marketplace-skill-main[\s\S]*?mcp-card-footer skill-card-actions">\s*<button class="btn-primary marketplace-plugin-install-all-btn" data-plugin-name="productivity">Install All</,
  );
  // Dirty root skill: footer holds the green Installed state + Detach as
  // plain siblings — Uninstall lives only in the kebab menu.
  assert.match(
    html,
    /mcp-card-footer skill-card-actions">\s*<button class="btn-primary btn-all-installed marketplace-skill-installed-btn" type="button" disabled>[\s\S]*?marketplace-skill-detach-btn" data-skill-id="solo"/,
  );
  assert.doesNotMatch(html, /marketplace-skill-uninstall-btn info-tooltip/);
  assert.doesNotMatch(html, /btn-secondary marketplace-skill-uninstall-btn/);
  assert.doesNotMatch(html, /marketplace-skill-action-group/);
  assert.doesNotMatch(html, /marketplace-skill-actions"/);

  // Drill in: install/conflict actions render inside footers too.
  const list = h.getElementById("marketplace-skills-list");
  const folderCard = new FakeElement("folder-productivity");
  folderCard.dataset.pluginName = "productivity";
  folderCard.dataset.drillable = "true";
  list.qsaResults.set(".marketplace-plugin-folder-card", [folderCard]);
  await h.window.openMarketplaceDetailsModal(MARKETPLACE);
  await flushAsync();
  folderCard.click({ target: { closest: () => null } });
  await flushAsync();

  html = list.innerHTML;
  assert.match(
    html,
    /mcp-card-footer skill-card-actions">\s*<button class="btn-primary marketplace-skill-install-btn[^>]*data-skill-id="tracker"/,
  );
  assert.match(
    html,
    /mcp-card-footer skill-card-actions">\s*<button class="btn-primary marketplace-skill-discard-btn" data-skill-id="planner"/,
  );
});

test("folder cards show a skills-list icon on the count row and the installed counter on its own row; icon clicks never drill in", async () => {
  const h = detailsHarness();
  h.window.InfoTooltips = {
    triggerHtml: (text) =>
      `<span class="info-tooltip-trigger" data-info-tooltip="${text}"></span>`,
    listTriggerHtml: (spec, innerHtml = "") =>
      `<span class="info-tooltip-trigger" data-list-title="${spec.title}" data-list-items="${(spec.items || []).join("; ")}" data-list-icon="${spec.icon || ""}">${innerHtml}</span>`,
  };
  await h.window.openMarketplaceDetailsModal(MARKETPLACE);
  await flushAsync();

  const list = h.getElementById("marketplace-skills-list");
  const html = list.innerHTML;
  // Row 1: the skill-count chip rides INSIDE a RICH-list trigger naming
  // every skill this card counts — badge and icon are one hover surface.
  assert.match(
    html,
    /<span class="info-tooltip-trigger" data-list-title="2 skills in this plugin" data-list-items="Planner; Tracker" data-list-icon="skill"><span class="mcp-card-badge badge-version">2 skills<\/span><\/span>/,
  );
  // Row 2: the installed counter moved to its own line, its chip inside a
  // trigger naming WHICH skills are installed.
  assert.match(
    html,
    /marketplace-folder-installed-row"><span class="info-tooltip-trigger" data-list-title="Installed from this plugin" data-list-items="Planner" data-list-icon="check"><span class="mcp-card-badge badge-installed">1 INSTALLED<\/span><\/span>/,
  );
  // The count chip never sits inside the installed row.
  assert.doesNotMatch(html, /marketplace-folder-installed-row"[^>]*>[^<]*<span class="mcp-card-badge badge-version"/);

  // Clicking the icon inside a drillable card must not drill in.
  const folderCard = new FakeElement("folder-productivity");
  folderCard.dataset.pluginName = "productivity";
  folderCard.dataset.drillable = "true";
  list.qsaResults.set(".marketplace-plugin-folder-card", [folderCard]);
  await h.window.openMarketplaceDetailsModal(MARKETPLACE);
  await flushAsync();
  folderCard.click({
    target: { closest: (sel) => (sel === ".info-tooltip-trigger" ? {} : null) },
  });
  await flushAsync();
  assert.match(
    list.innerHTML,
    /marketplace-plugin-folder-card/,
    "still on the overview — the icon click was not a drill-in",
  );
  assert.doesNotMatch(list.innerHTML, /marketplace-plugin-back-btn/);
});

test("a fully installed plugin shows the green All Installed indicator; Install All only while skills remain", async () => {
  const marketplace = {
    ...MARKETPLACE,
    id: "green",
    cachedManifest: {
      name: "green",
      plugins: [
        {
          name: "done",
          description: "Everything installed",
          skills: ["./done/skills/d1", "./done/skills/d2"],
        },
        {
          name: "todo",
          description: "Nothing installed",
          skills: ["./todo/skills/t1"],
        },
      ],
    },
  };
  const skill = (id, pluginName, installed) => ({
    id,
    name: id,
    displayName: id.toUpperCase(),
    description: "",
    skillPath: `./${pluginName}/skills/${id}`,
    pluginName,
    installed,
    available: true,
  });
  const h = loadMarketplacesHarness({
    electronAPI: {
      getMarketplaceSkills: async () => ({
        success: true,
        skills: [skill("d1", "done", true), skill("d2", "done", true), skill("t1", "todo", false)],
        marketplace,
      }),
    },
  });
  await h.window.openMarketplaceDetailsPage(marketplace);
  await flushAsync();

  const html = h.getElementById("marketplace-skills-list").innerHTML;
  const doneStart = html.indexOf('data-plugin-name="done"');
  const todoStart = html.indexOf('data-plugin-name="todo"');
  assert.ok(doneStart >= 0 && todoStart >= 0, "both folders rendered");
  assert.ok(doneStart < todoStart, "fully-installed plugin ranks first");
  const doneCard = html.slice(doneStart, todoStart);
  const todoCard = html.slice(todoStart);
  // Fully installed: a disabled green state indicator with a checkmark, in
  // the footer where Install All used to be — and no Install All.
  assert.match(doneCard, /mcp-card-footer skill-card-actions">\s*<button class="btn-primary btn-all-installed" type="button" disabled/);
  assert.match(doneCard, /polyline points="20 6 9 17 4 12"/);
  assert.match(doneCard, /All Installed</);
  assert.match(doneCard, /title="All 2 skills from this plugin are installed"/);
  assert.doesNotMatch(doneCard, /marketplace-plugin-install-all-btn/);
  assert.match(doneCard, /marketplace-folder-installed-row/);
  // Untouched plugin: Install All, no green state, no installed row.
  assert.match(todoCard, /marketplace-plugin-install-all-btn" data-plugin-name="todo"/);
  assert.doesNotMatch(todoCard, /btn-all-installed/);
  assert.doesNotMatch(todoCard, /marketplace-folder-installed-row/);
});

test("a guard-blocked uninstall from the kebab shows the blocking modal, not the failure toast", async () => {
  const h = detailsHarness({
    uninstallMarketplaceSkill: async () => ({
      success: false,
      error:
        'Skill "solo" is attached to agents: "Research Buddy". Remove it from that agent first, then try again.',
      errorCode: "skill_in_use_by_agents",
      body: { skill_id: "solo", agents: [{ id: "a1", name: "Research Buddy" }] },
    }),
  });
  const modalCalls = [];
  h.window.showSkillInUseByAgentsModal = (options) => {
    modalCalls.push(options);
  };
  await h.window.openMarketplaceDetailsModal(MARKETPLACE);
  await flushAsync();

  const list = h.getElementById("marketplace-skills-list");
  const uninstallItem = new FakeElement("menu-uninstall-solo");
  uninstallItem.dataset.skillId = "solo";
  list.qsaResults.set(".marketplace-skill-menu-uninstall-btn", [uninstallItem]);
  await h.window.openMarketplaceDetailsModal(MARKETPLACE);
  await flushAsync();

  // The kebab is confirm-gated (GUI-7); the guard runs behind Confirm.
  uninstallItem.click({ stopPropagation() {}, target: { closest: () => null } });
  await flushAsync(12);
  assert.equal(h.confirmCalls.length, 1, "the confirm modal opened first");
  await h.confirmCalls[0].onConfirm();
  await flushAsync(12);

  assert.equal(modalCalls.length, 1, "the blocking modal opened");
  assert.match(modalCalls[0].message, /Research Buddy/);
  assert.deepEqual(modalCalls[0].agents, [{ id: "a1", name: "Research Buddy" }]);
  assert.ok(
    !h.notifications.some(([, message]) => /Failed to uninstall/.test(message)),
    "no generic failure toast alongside the modal",
  );
});

test("the directory ranks by installed state: plugins by installed count descending, root skills installed-first", async () => {
  const marketplace = {
    ...MARKETPLACE,
    id: "sorted",
    cachedManifest: {
      name: "sorted",
      plugins: [
        {
          name: "alpha",
          description: "A tools",
          skills: ["./alpha/skills/a1", "./alpha/skills/a2"],
        },
        {
          name: "ext-plugin",
          description: "External tools",
          source: { source: "github", repo: "third-party/ext" },
          unavailable: true,
          unavailableReason: "source_not_allowed",
        },
        {
          name: "zeta",
          description: "Z tools",
          skills: ["./zeta/skills/z1", "./zeta/skills/z2"],
        },
        {
          name: "mid",
          description: "M tools",
          skills: ["./mid/skills/m1", "./mid/skills/m2"],
        },
        {
          name: "beta",
          description: "B tools",
          skills: ["./beta/skills/b1"],
        },
      ],
    },
  };
  const pluginSkill = (id, pluginName, installed) => ({
    id,
    name: id,
    displayName: id.toUpperCase(),
    description: "",
    skillPath: `./${pluginName}/skills/${id}`,
    pluginName,
    installed,
    available: true,
  });
  const rootSkill = (id, displayName, extra = {}) => ({
    id,
    name: id,
    displayName,
    description: "",
    skillPath: `./${id}`,
    pluginName: null,
    installed: false,
    available: true,
    ...extra,
  });
  const skills = [
    // zeta: 2/2 installed; mid: 1/2; alpha: 0/2 — manifest order is
    // alpha, ext, zeta, mid, so ranking must actually reorder.
    pluginSkill("a1", "alpha", false),
    pluginSkill("a2", "alpha", false),
    pluginSkill("b1", "beta", false),
    pluginSkill("z1", "zeta", true),
    pluginSkill("z2", "zeta", true),
    pluginSkill("m1", "mid", true),
    pluginSkill("m2", "mid", false),
    rootSkill("ext-plugin", "Ext Plugin", { available: false }),
    rootSkill("zulu", "Zulu", { installed: true }),
    rootSkill("apple", "Apple"),
    rootSkill("mango", "Mango"),
    rootSkill("echo-ext", "Echo Ext", { available: false }),
  ];
  const h = loadMarketplacesHarness({
    electronAPI: {
      getMarketplaceSkills: async () => ({ success: true, skills, marketplace }),
    },
  });
  await h.window.openMarketplaceDetailsPage(marketplace);
  await flushAsync();

  const html = h.getElementById("marketplace-skills-list").innerHTML;
  // Folders: fully-installed Zeta first, partially-installed Mid next,
  // uninstalled Alpha last; the external plugin never renders.
  const zetaIdx = html.indexOf('data-plugin-name="zeta"');
  const midIdx = html.indexOf('data-plugin-name="mid"');
  const alphaIdx = html.indexOf('data-plugin-name="alpha"');
  const betaIdx = html.indexOf('data-plugin-name="beta"');
  assert.ok(
    zetaIdx >= 0 && midIdx >= 0 && alphaIdx >= 0 && betaIdx >= 0,
    "all installable folders rendered",
  );
  assert.ok(zetaIdx < midIdx, "most-installed plugin ranks first");
  assert.ok(midIdx < alphaIdx, "partially-installed plugin outranks uninstalled");
  assert.ok(alphaIdx < betaIdx, "alphabetical within the same installed count");
  assert.doesNotMatch(html, /data-plugin-name="ext-plugin"/);
  // Root skills: installed Zulu first despite sorting last alphabetically,
  // then Apple and Mango alphabetically; externals never render.
  const zuluIdx = html.indexOf('data-skill-id="zulu"');
  const appleIdx = html.indexOf('data-skill-id="apple"');
  const mangoIdx = html.indexOf('data-skill-id="mango"');
  assert.ok(zuluIdx >= 0 && appleIdx >= 0 && mangoIdx >= 0, "all installable root skills rendered");
  assert.ok(zuluIdx < appleIdx, "installed root skills rank first");
  assert.ok(appleIdx < mangoIdx, "alphabetical within the uninstalled group");
  assert.doesNotMatch(html, /data-skill-id="ext-plugin"/);
  assert.doesNotMatch(html, /data-skill-id="echo-ext"/);
});

// ---------------------------------------------------------------------------
// Round 14: search matches PLUGINS too. Name-matching folders render as
// folder cards (decorated with a "N matching" chip + tooltip when member
// skills also match the query, folding those members out of the loose list);
// skills inside non-matching plugins keep rendering flat with subtitles.
// ---------------------------------------------------------------------------

function searchDetails(query) {
  return async () => {
    const h = detailsHarness();
    // Rich-list triggers only render through the shared InfoTooltips builder
    // (agents.js); stub it like the folder-count-chip test above.
    h.window.InfoTooltips = {
      triggerHtml: (text) =>
        `<span class="info-tooltip-trigger" data-info-tooltip="${text}"></span>`,
      listTriggerHtml: (spec, innerHtml = "") =>
        `<span class="info-tooltip-trigger" data-list-title="${spec.title}" data-list-items="${(spec.items || []).join("; ")}" data-list-icon="${spec.icon || ""}">${innerHtml}</span>`,
    };
    await h.window.openMarketplaceDetailsModal(MARKETPLACE);
    await flushAsync();
    const searchInput = h.getElementById("marketplace-skills-search-input");
    searchInput.dispatch("input", { target: { value: query } });
    await flushAsync();
    return h;
  };
}

test("searching a plugin name surfaces its folder card; query-matching members fold into the chip", async () => {
  // "p" matches the plugin name (productivity) AND one member (planner).
  const h = await searchDetails("p")();
  const html = h.getElementById("marketplace-skills-list").innerHTML;

  assert.match(html, /marketplace-plugin-folder-card" data-plugin-name="productivity"/);
  assert.match(html, /badge-installed">1 matching</, "the matching-members chip renders");
  assert.match(
    html,
    /data-list-title="1 matching skill in this plugin" data-list-items="Planner" data-list-icon="skill"/,
    "the chip is a hover unit naming the matching members",
  );
  // The matching member does NOT duplicate as a loose skill card.
  assert.doesNotMatch(html, /marketplace-skill-card" data-skill-id="planner"/);
  // Folder-only results still get the Plugins label (round 15: a lone card
  // class is ambiguous without its section header) — and no empty Skills one.
  assert.match(html, /marketplace-section-title">Plugins</);
  assert.doesNotMatch(html, /marketplace-root-skills-title/);
});

test("a plugin-name-only match renders the folder card without the matching chip", async () => {
  // "productivity" matches no member skill names/descriptions.
  const h = await searchDetails("productivity")();
  const html = h.getElementById("marketplace-skills-list").innerHTML;

  assert.match(html, /marketplace-plugin-folder-card" data-plugin-name="productivity"/);
  assert.doesNotMatch(html, /matching</);
  assert.doesNotMatch(html, /data-list-title="[^"]*matching/);
});

test("skills in non-matching plugins still render flat while matching folders render as cards", async () => {
  // "track" matches the tracker skill only — its plugin name does not match,
  // so today's flat behavior is preserved for it.
  const h = await searchDetails("track")();
  const html = h.getElementById("marketplace-skills-list").innerHTML;

  assert.doesNotMatch(html, /marketplace-plugin-folder-card/);
  assert.match(html, /data-skill-id="tracker"/);
  assert.match(html, /badge-plugin"[^>]*>Productivity</);
  // Skill-only results keep their Skills label; no empty Plugins section.
  assert.match(html, /marketplace-root-skills-title">Skills</);
  assert.doesNotMatch(html, /marketplace-section-title">Plugins</);
});

test("an unavailable plugin whose name matches the query renders nothing", async () => {
  const h = await searchDetails("sales")();
  const html = h.getElementById("marketplace-skills-list").innerHTML;

  assert.doesNotMatch(html, /marketplace-plugin-folder-card/);
  assert.doesNotMatch(html, /data-skill-id="sales-plugin"/);
  assert.match(html, /No plugins or skills match your search/);
});

test("drilling into a plugin from search results clears the query and shows the full plugin", async () => {
  const h = detailsHarness();
  await h.window.openMarketplaceDetailsModal(MARKETPLACE);
  await flushAsync();

  const list = h.getElementById("marketplace-skills-list");
  const folderCard = new FakeElement("folder-productivity");
  folderCard.dataset.pluginName = "productivity";
  folderCard.dataset.drillable = "true";
  list.qsaResults.set(".marketplace-plugin-folder-card", [folderCard]);

  const searchInput = h.getElementById("marketplace-skills-search-input");
  searchInput.dispatch("input", { target: { value: "p" } });
  await flushAsync();

  folderCard.click({ target: { closest: () => null } });
  await flushAsync();

  assert.equal(searchInput.value, "", "the search box empties on drill-in");
  const html = list.innerHTML;
  assert.match(html, /marketplace-plugin-drillin-title">Productivity</);
  assert.match(html, /data-skill-id="planner"/);
  assert.match(html, /data-skill-id="tracker"/, "the full plugin renders, not the query subset");
});

test("the search placeholder mentions plugins only when the marketplace has plugin folders", async () => {
  const h = await searchDetails("p")();
  assert.equal(
    h.getElementById("marketplace-skills-search-input").placeholder,
    "Search plugins and skills...",
  );

  const flat = loadMarketplacesHarness({
    electronAPI: {
      getMarketplaceSkills: async (marketplaceId) => ({
        success: true,
        skills: [catalogSkills().find((skill) => skill.id === "solo")],
        marketplace: {
          ...MARKETPLACE,
          id: marketplaceId,
          cachedManifest: { name: "kwp", plugins: [] },
        },
      }),
    },
  });
  await flat.window.openMarketplaceDetailsModal({
    ...MARKETPLACE,
    cachedManifest: { name: "kwp", plugins: [] },
  });
  await flushAsync();
  assert.equal(
    flat.getElementById("marketplace-skills-search-input").placeholder,
    "Search skills...",
  );
});

// ---------------------------------------------------------------------------
// Round 15: sorting applies only when a view is (re)entered. Action-driven
// refreshes (install/uninstall/update) keep the painted order so the card
// just acted on never teleports; reopening the page re-ranks.
// ---------------------------------------------------------------------------

test("action refreshes keep the painted order; reopening the page re-sorts", async () => {
  const rootSkill = (id, displayName, installed) => ({
    id,
    name: id,
    displayName,
    description: `${displayName} skill`,
    skillPath: `./${id}`,
    pluginName: null,
    installed,
    ...(installed ? { installedVersion: "1.0" } : {}),
    available: true,
  });
  const flatMarketplace = {
    ...MARKETPLACE,
    cachedManifest: { name: "kwp", plugins: [] },
  };
  let call = 0;
  const h = loadMarketplacesHarness({
    electronAPI: {
      getMarketplaceSkills: async (marketplaceId) => {
        call += 1;
        // The action refresh (call 2+) sees Apple installed.
        const appleInstalled = call >= 2;
        return {
          success: true,
          skills: [
            rootSkill("apple", "Apple", appleInstalled),
            rootSkill("zulu", "Zulu", true),
          ],
          marketplace: { ...flatMarketplace, id: marketplaceId },
        };
      },
      installMarketplaceSkill: async () => ({ success: true }),
    },
  });
  const list = h.getElementById("marketplace-skills-list");
  const installBtn = new FakeElement("install-apple");
  installBtn.dataset.skillId = "apple";
  installBtn.dataset.skillPath = "./apple";
  installBtn.dataset.skillSource = "";
  list.qsaResults.set(".marketplace-skill-install-btn", [installBtn]);
  await h.window.openMarketplaceDetailsModal(flatMarketplace);
  await flushAsync();

  // First paint: installed-first ranking puts Zulu above Apple.
  let html = list.innerHTML;
  assert.ok(
    html.indexOf('data-skill-id="zulu"') < html.indexOf('data-skill-id="apple"'),
    "initial paint sorts installed-first",
  );

  installBtn.click();
  await flushAsync(16);
  html = list.innerHTML;
  assert.match(html, /marketplace-skill-installed-btn/, "apple installed in place");
  // Both are installed now — a fresh sort would rank Apple first
  // (alphabetical within the installed group) — but the painted order holds.
  assert.ok(
    html.indexOf('data-skill-id="zulu"') < html.indexOf('data-skill-id="apple"'),
    "the action refresh must not re-rank the grid",
  );

  // Re-entering the view re-applies the sort rules.
  await h.window.openMarketplaceDetailsModal(flatMarketplace);
  await flushAsync();
  html = list.innerHTML;
  assert.ok(
    html.indexOf('data-skill-id="apple"') < html.indexOf('data-skill-id="zulu"'),
    "reopening the page re-sorts",
  );
});

// ── Uninstall All (folder kebab) ───────────────────────────────────────────

function uninstallAllCatalog() {
  // productivity members: planner is dirty+conflict (kept), agentbound is
  // referenced by an agent (kept), tracker + notes are clean installs
  // (targets). One uninstalled member proves non-installed are ignored.
  return [
    {
      id: "planner",
      name: "planner",
      displayName: "Planner",
      description: "Plan your day",
      skillPath: "./productivity/skills/planner",
      pluginName: "productivity",
      installed: true,
      installedVersion: "1.0",
      isDirty: true,
      hasConflict: true,
      available: true,
    },
    {
      id: "tracker",
      name: "tracker",
      displayName: "Tracker",
      description: "Track tasks",
      skillPath: "./productivity/skills/tracker",
      pluginName: "productivity",
      installed: true,
      installedVersion: "1.0",
      available: true,
    },
    {
      id: "notes",
      name: "notes",
      displayName: "Notes",
      description: "Take notes",
      skillPath: "./productivity/skills/notes",
      pluginName: "productivity",
      installed: true,
      installedVersion: "1.0",
      available: true,
    },
    {
      id: "agentbound",
      name: "agentbound",
      displayName: "Agent Bound",
      description: "Referenced by an agent",
      skillPath: "./productivity/skills/agentbound",
      pluginName: "productivity",
      installed: true,
      installedVersion: "1.0",
      available: true,
    },
    {
      id: "fresh",
      name: "fresh",
      displayName: "Fresh",
      description: "Never installed",
      skillPath: "./productivity/skills/fresh",
      pluginName: "productivity",
      installed: false,
      available: true,
    },
  ];
}

function uninstallAllHarness(overrides = {}) {
  return detailsHarness({
    getMarketplaceSkills: async (marketplaceId) => ({
      success: true,
      skills: uninstallAllCatalog(),
      marketplace: { ...MARKETPLACE, id: marketplaceId },
    }),
    listAgentSkillUsage: async () => ({
      success: true,
      agents: [{ id: "a1", name: "Agent One", leaves: ["agentbound"] }],
    }),
    ...overrides,
  });
}

async function clickUninstallAll(h) {
  const list = h.getElementById("marketplace-skills-list");
  const btn = new FakeElement("uninstall-all");
  btn.dataset.pluginName = "productivity";
  list.qsaResults.set(".marketplace-plugin-uninstall-all-btn", [btn]);
  await h.window.openMarketplaceDetailsModal(MARKETPLACE);
  await flushAsync(12);
  btn.click({ target: btn, stopPropagation() {} });
  await flushAsync(12);
  return btn;
}

test("Uninstall All confirms first, then uninstalls only clean installs sequentially with plugin threading", async () => {
  const h = uninstallAllHarness();
  await clickUninstallAll(h);

  // Confirm gate: nothing uninstalled yet; the modal names counts and keeps.
  assert.equal(h.calls.uninstallMarketplaceSkill.length, 0);
  assert.equal(h.confirmCalls.length, 1);
  const opts = h.confirmCalls[0];
  assert.equal(opts.danger, true);
  assert.equal(opts.confirmLabel, "Uninstall All");
  assert.match(opts.message, /Uninstall 2 skills installed from "productivity"/);
  assert.match(opts.message, /1 with local edits will be kept/);
  assert.match(opts.message, /1 used by agents will be kept/);

  await opts.onConfirm();
  await flushAsync(12);

  assert.deepEqual(h.calls.uninstallMarketplaceSkill, [
    ["kwp", "tracker", "productivity"],
    ["kwp", "notes", "productivity"],
  ]);
  assert.ok(
    h.notifications.some(
      ([kind, message]) =>
        kind === "success" &&
        /Uninstalled 2 skills from "productivity"/.test(message) &&
        /kept 1 with local edits/.test(message) &&
        /kept 1 used by agents/.test(message),
    ),
    `summary toast expected, got: ${JSON.stringify(h.notifications)}`,
  );
});

test("cancelling the Uninstall All confirm never dispatches an uninstall", async () => {
  const h = uninstallAllHarness();
  await clickUninstallAll(h);

  assert.equal(h.confirmCalls.length, 1);
  // Modal dismissed: onConfirm never invoked.
  await flushAsync(6);
  assert.equal(h.calls.uninstallMarketplaceSkill.length, 0);
});

test("a mid-loop ootb_skill_immutable keeps the built-in and continues the sweep", async () => {
  const h = uninstallAllHarness({
    uninstallMarketplaceSkill: async (...args) => {
      h.calls.uninstallMarketplaceSkill.push(args);
      if (args[1] === "tracker") {
        return { success: false, errorCode: "ootb_skill_immutable", error: "immutable" };
      }
      return { success: true };
    },
  });
  await clickUninstallAll(h);
  await h.confirmCalls[0].onConfirm();
  await flushAsync(12);

  assert.equal(h.calls.uninstallMarketplaceSkill.length, 2, "loop continues past the immutable member");
  assert.ok(
    h.notifications.some(
      ([kind, message]) =>
        kind === "success" &&
        /Uninstalled 1 skill from "productivity"/.test(message) &&
        /kept 1 built-in/.test(message),
    ),
    `built-in keep expected, got: ${JSON.stringify(h.notifications)}`,
  );
});

test("hard failures accumulate without aborting and surface as an error toast", async () => {
  const h = uninstallAllHarness({
    uninstallMarketplaceSkill: async (...args) => {
      h.calls.uninstallMarketplaceSkill.push(args);
      if (args[1] === "tracker") {
        return { success: false, error: "disk exploded" };
      }
      return { success: true };
    },
  });
  await clickUninstallAll(h);
  await h.confirmCalls[0].onConfirm();
  await flushAsync(12);

  assert.equal(h.calls.uninstallMarketplaceSkill.length, 2);
  assert.ok(
    h.notifications.some(
      ([kind, message]) =>
        kind === "error" &&
        /Uninstalled 1 skill/.test(message) &&
        /failed: tracker: disk exploded/.test(message),
    ),
    `failure toast expected, got: ${JSON.stringify(h.notifications)}`,
  );
});

test("when every installed member is kept, Uninstall All reports instead of confirming", async () => {
  const h = uninstallAllHarness({
    getMarketplaceSkills: async (marketplaceId) => ({
      success: true,
      skills: uninstallAllCatalog().filter((skill) =>
        ["planner", "agentbound", "fresh"].includes(skill.id),
      ),
      marketplace: { ...MARKETPLACE, id: marketplaceId },
    }),
  });
  await clickUninstallAll(h);

  assert.equal(h.confirmCalls.length, 0, "no confirm modal for a no-op");
  assert.equal(h.calls.uninstallMarketplaceSkill.length, 0);
  assert.ok(
    h.notifications.some(
      ([kind, message]) =>
        kind === "info" && /Nothing to uninstall from "productivity"/.test(message),
    ),
    `info toast expected, got: ${JSON.stringify(h.notifications)}`,
  );
});
