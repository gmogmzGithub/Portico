// Round-12 kebab menus on git-marketplace skill cards: View Details always,
// then the contextual lifecycle action (Install / Uninstall / Update);
// folder cards render a menu (Uninstall All) exactly when members are
// installed. Items dispatch the SAME actions as the footer buttons (plugin
// threading included) and Details routes through the read-only page hook.
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
        skills: ["./p/skills/tracker"],
      },
    ],
  },
});

function rootSkill(id, displayName, extra = {}) {
  return {
    id,
    name: id,
    displayName,
    description: `${displayName} skill`,
    skillPath: `./${id}`,
    pluginName: null,
    installed: false,
    available: true,
    ...extra,
  };
}

function catalogSkills() {
  return [
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
    rootSkill("alpha", "Alpha"),
    rootSkill("beta", "Beta", { installed: true, installedVersion: "1.0" }),
    rootSkill("gamma", "Gamma", {
      installed: true,
      installedVersion: "1.0",
      hasUpdate: true,
    }),
  ];
}

function menusHarness() {
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

function cardSlice(html, marker) {
  const start = html.indexOf(marker);
  assert.ok(start >= 0, `card marker ${marker} rendered`);
  const next = html.indexOf('<div class="marketplace-skill-card', start + 1);
  return html.slice(start, next === -1 ? undefined : next);
}

test("menus are contextual per install state and folder cards without installs render none", async () => {
  const { h } = menusHarness();
  await h.window.openMarketplaceDetailsPage(MARKETPLACE);
  await flushAsync();

  const html = h.getElementById("marketplace-skills-list").innerHTML;
  // Folder card (productivity, zero installed members) renders no kebab —
  // there is nothing to Uninstall All.
  const folderStart = html.indexOf('data-plugin-name="productivity"');
  const folderEnd = html.indexOf('<div class="marketplace-skill-card"', folderStart);
  assert.ok(folderStart >= 0, "folder rendered");
  assert.doesNotMatch(
    html.slice(folderStart, folderEnd === -1 ? undefined : folderEnd),
    /mcp-card-menu-trigger/,
    "folders with no installed members get no menu",
  );
  // Uninstalled root: Details + Install, nothing destructive.
  const alphaCard = cardSlice(html, 'data-dropdown-skill-id="alpha"');
  assert.match(alphaCard, /marketplace-skill-menu-details-btn" data-skill-id="alpha"/);
  assert.match(alphaCard, /marketplace-skill-menu-install-btn" data-skill-id="alpha"/);
  assert.doesNotMatch(alphaCard, /marketplace-skill-menu-uninstall-btn/);
  assert.doesNotMatch(alphaCard, /marketplace-skill-menu-update-btn/);
  // Installed root: Details + Uninstall (destructive styling).
  const betaCard = cardSlice(html, 'data-dropdown-skill-id="beta"');
  assert.match(betaCard, /marketplace-skill-menu-details-btn" data-skill-id="beta"/);
  assert.match(
    betaCard,
    /marketplace-skill-menu-uninstall-btn delete-action" data-skill-id="beta"/,
  );
  assert.doesNotMatch(betaCard, /marketplace-skill-menu-install-btn/);
  assert.doesNotMatch(betaCard, /marketplace-skill-menu-update-btn/);
  // Installed + update available: Details + Update + Uninstall.
  const gammaCard = cardSlice(html, 'data-dropdown-skill-id="gamma"');
  assert.match(gammaCard, /marketplace-skill-menu-update-btn" data-skill-id="gamma"/);
  assert.match(
    gammaCard,
    /marketplace-skill-menu-uninstall-btn delete-action" data-skill-id="gamma"/,
  );
  assert.doesNotMatch(gammaCard, /marketplace-skill-menu-install-btn/);
});

test("menu items dispatch the real lifecycle actions with plugin threading; Details routes through the page hook", async () => {
  const { h, hookCalls } = menusHarness();
  const list = h.getElementById("marketplace-skills-list");

  const installItem = new FakeElement("menu-install");
  installItem.dataset.skillId = "tracker";
  installItem.dataset.skillPath = "./p/skills/tracker";
  installItem.dataset.skillSource = "";
  installItem.dataset.pluginName = "productivity";
  const uninstallItem = new FakeElement("menu-uninstall");
  uninstallItem.dataset.skillId = "beta";
  const updateItem = new FakeElement("menu-update");
  updateItem.dataset.skillId = "gamma";
  const detailsItem = new FakeElement("menu-details");
  detailsItem.dataset.skillId = "beta";
  list.qsaResults.set(".marketplace-skill-menu-install-btn", [installItem]);
  list.qsaResults.set(".marketplace-skill-menu-uninstall-btn", [uninstallItem]);
  list.qsaResults.set(".marketplace-skill-menu-update-btn", [updateItem]);
  list.qsaResults.set(".marketplace-skill-menu-details-btn", [detailsItem]);
  await h.window.openMarketplaceDetailsPage(MARKETPLACE);
  await flushAsync();

  const clickEvent = () => ({ stopPropagation() {}, target: { closest: () => null } });
  installItem.click(clickEvent());
  await flushAsync(12);
  assert.equal(h.calls.installMarketplaceSkill.length, 1);
  assert.deepEqual(h.calls.installMarketplaceSkill[0], [
    "kwp",
    "tracker",
    "./p/skills/tracker",
    null,
    "productivity",
  ]);

  // Uninstall is destructive: the click opens the shared confirm modal, and
  // only confirming dispatches the IPC (full gate coverage lives in the
  // confirm-gate test below).
  uninstallItem.click(clickEvent());
  await flushAsync(12);
  assert.equal(h.calls.uninstallMarketplaceSkill.length, 0);
  assert.equal(h.confirmCalls.length, 1);
  await h.confirmCalls[0].onConfirm();
  await flushAsync(12);
  assert.equal(h.calls.uninstallMarketplaceSkill.length, 1);
  assert.deepEqual(h.calls.uninstallMarketplaceSkill[0].slice(0, 3), [
    "kwp",
    "beta",
    null,
  ]);

  updateItem.click(clickEvent());
  await flushAsync(12);
  assert.equal(h.calls.updateMarketplaceSkill.length, 1);
  assert.equal(h.calls.updateMarketplaceSkill[0][1], "gamma");

  detailsItem.click(clickEvent());
  await flushAsync();
  assert.equal(hookCalls.length, 1);
  assert.equal(hookCalls[0].skillId, "beta");
  assert.equal(hookCalls[0].marketplaceId, "kwp");
  assert.equal(hookCalls[0].installed, true);
});

test("the shared trigger protocol works on the marketplace grid too", async () => {
  const { h } = menusHarness();
  const list = h.getElementById("marketplace-skills-list");
  const wrapper = new FakeElement("menu-wrapper");
  const trigger = new FakeElement("menu-trigger");
  const dropdown = new FakeElement("menu-dropdown");
  trigger.parentElement = wrapper;
  dropdown.parentElement = wrapper;
  wrapper.children.set(".mcp-card-dropdown", dropdown);
  list.qsaResults.set(".mcp-card-menu-trigger", [trigger]);
  await h.window.openMarketplaceDetailsPage(MARKETPLACE);
  await flushAsync();

  trigger.click({ stopPropagation() {}, target: { closest: () => null } });
  assert.ok(dropdown.classList.contains("visible"), "dropdown opened");
  assert.equal(dropdown.parentElement, h.document.body, "body-reparented");

  // Simulate the fixed positioning the open path applies; close must clear it
  // — a hover transform on the card re-bases the hidden fixed box into the
  // card, and stale coords would widen the scroll host (phantom h-scrollbar).
  dropdown.style.top = "123px";
  dropdown.style.left = "456px";
  h.docQsaResults.set(".mcp-card-dropdown.visible", [dropdown]);
  h.window.SkillCardRenderer.closeAllCardMenus();
  assert.ok(!dropdown.classList.contains("visible"));
  assert.equal(dropdown.parentElement, wrapper, "returned to its card");
  assert.equal(dropdown.style.top, "", "stale fixed top cleared on close");
  assert.equal(dropdown.style.left, "", "stale fixed left cleared on close");
});

test("blocked kebab Uninstall never fires the IPC and leaves the menu open; the footer is a green state", async () => {
  const { h } = menusHarness();
  const list = h.getElementById("marketplace-skills-list");

  const menuBtn = new FakeElement("menu-uninstall");
  menuBtn.dataset.skillId = "beta";
  menuBtn.setAttribute("aria-disabled", "true");
  list.qsaResults.set(".marketplace-skill-menu-uninstall-btn", [menuBtn]);
  await h.window.openMarketplaceDetailsPage(MARKETPLACE);
  await flushAsync();

  // Installed card footer: the green Installed state — no footer Uninstall
  // exists anymore (round 14), so the kebab is the only affordance to block.
  const betaCard = cardSlice(list.innerHTML, 'data-dropdown-skill-id="beta"');
  assert.match(betaCard, /btn-all-installed marketplace-skill-installed-btn/);
  assert.doesNotMatch(betaCard, /marketplace-skill-uninstall-btn/);

  let stopped = 0;
  menuBtn.click({ stopPropagation: () => (stopped += 1), target: { closest: () => null } });
  await flushAsync(12);

  assert.equal(h.calls.uninstallMarketplaceSkill.length, 0, "no IPC fires");
  assert.equal(h.confirmCalls.length, 0, "not even the confirm modal opens");
  assert.equal(
    stopped,
    1,
    "the blocked MENU click stops propagation (mcp-servers' unconditional document closer would close the menu)",
  );

  // The same wiring fires once the block clears (through the confirm gate).
  menuBtn.removeAttribute("aria-disabled");
  menuBtn.click({ stopPropagation() {}, target: { closest: () => null } });
  await flushAsync(12);
  assert.equal(h.confirmCalls.length, 1, "unblocked click opens the confirm");
  await h.confirmCalls[0].onConfirm();
  await flushAsync(12);
  assert.equal(h.calls.uninstallMarketplaceSkill.length, 1);
});

// Round-15 (GUI-7): the drill-in kebab Uninstall is confirm-gated like every
// other uninstall surface (Installed facet / Discover kebab) — same modal,
// same wording. Cancel is a no-op; only Confirm reaches the IPC.
test("kebab Uninstall confirms first: cancel never fires the IPC, confirm dispatches the unchanged args", async () => {
  const { h } = menusHarness();
  const list = h.getElementById("marketplace-skills-list");

  const uninstallItem = new FakeElement("menu-uninstall");
  uninstallItem.dataset.skillId = "beta";
  list.qsaResults.set(".marketplace-skill-menu-uninstall-btn", [uninstallItem]);
  await h.window.openMarketplaceDetailsPage(MARKETPLACE);
  await flushAsync();

  const clickEvent = () => ({ stopPropagation() {}, target: { closest: () => null } });

  // (a) The click opens the shared confirm modal — Installed-facet wording —
  // and does NOT touch the uninstall IPC.
  uninstallItem.click(clickEvent());
  await flushAsync(12);
  assert.equal(h.confirmCalls.length, 1, "the confirm modal opens");
  assert.equal(h.confirmCalls[0].title, "Uninstall skill?");
  assert.equal(
    h.confirmCalls[0].message,
    'Uninstall "Beta" (installed from Knowledge Work Plugins)? You can reinstall it from the marketplace anytime.',
  );
  assert.equal(h.confirmCalls[0].confirmLabel, "Uninstall");
  assert.equal(h.confirmCalls[0].danger, true);
  assert.equal(h.calls.uninstallMarketplaceSkill.length, 0, "no IPC before confirm");
  assert.equal(h.calls.windowConfirm.length, 0, "native confirm never reached");

  // (b) Cancel = dismiss without onConfirm (no onCancel side effects exist):
  // zero uninstall calls, and the next click gets a fresh modal.
  assert.equal(h.confirmCalls[0].onCancel, undefined, "cancel is a pure no-op");
  await flushAsync(12);
  assert.equal(h.calls.uninstallMarketplaceSkill.length, 0, "cancel uninstalls nothing");

  // (c) Confirm → the exact pre-gate dispatch (marketplace id, bare skill id,
  // null plugin) and the grid refresh behind it.
  uninstallItem.click(clickEvent());
  await flushAsync(12);
  assert.equal(h.confirmCalls.length, 2, "each click opens its own confirm");
  await h.confirmCalls[1].onConfirm();
  await flushAsync(12);
  assert.equal(h.calls.uninstallMarketplaceSkill.length, 1);
  assert.deepEqual(h.calls.uninstallMarketplaceSkill[0].slice(0, 3), [
    "kwp",
    "beta",
    null,
  ]);
  assert.ok(
    h.notifications.some(
      ([kind, message]) => kind === "success" && /uninstalled/.test(message),
    ),
    "the existing success toast still fires after confirm",
  );
});

test("folder cards with installed members render the Uninstall All kebab", async () => {
  const { h } = menusHarness();
  // Second productivity member, installed — the folder now has something to
  // uninstall (the base fixture's tracker stays uninstalled).
  h.window.electronAPI.getMarketplaceSkills = async (marketplaceId) => ({
    success: true,
    skills: [
      ...catalogSkills(),
      {
        id: "tracker2",
        name: "tracker2",
        displayName: "Tracker Two",
        description: "Installed member",
        skillPath: "./p/skills/tracker2",
        pluginName: "productivity",
        installed: true,
        installedVersion: "1.0",
        available: true,
      },
    ],
    marketplace: { ...MARKETPLACE, id: marketplaceId },
  });
  await h.window.openMarketplaceDetailsPage(MARKETPLACE);
  await flushAsync();

  const html = h.getElementById("marketplace-skills-list").innerHTML;
  const folderStart = html.indexOf("marketplace-plugin-folder-card");
  assert.ok(folderStart >= 0, "folder rendered");
  const folderEnd = html.indexOf('<div class="marketplace-skill-card"', folderStart);
  const folderSlice = html.slice(
    folderStart,
    folderEnd === -1 ? undefined : folderEnd,
  );
  assert.match(
    folderSlice,
    /mcp-card-menu-trigger" data-menu-plugin-name="productivity"/,
    "installed members earn the folder kebab",
  );
  assert.match(
    folderSlice,
    /marketplace-plugin-uninstall-all-btn delete-action" data-plugin-name="productivity"/,
  );
  assert.match(folderSlice, /Uninstall All/);
});
