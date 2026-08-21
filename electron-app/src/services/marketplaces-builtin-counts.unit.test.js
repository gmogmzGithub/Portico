// Built-in (OOTB seed) gating on marketplace skill cards + the shared
// installed/parked counting rule (2026-08-14: Using Teamworks/Algorithmic Art
// offered an Uninstall that the service always refuses; list card said 5
// INSTALLED vs 4 in the drilldown header vs 1 under the Installed filter).
// Drives the real marketplaces.js in a vm harness via MarketplaceRenderHooks.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const MARKETPLACES_PATH = path.join(
  __dirname,
  "..",
  "renderer",
  "components",
  "marketplaces.js",
);

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.innerHTML = "";
    this.textContent = "";
    this.value = "";
    this.classList = {
      add() {},
      remove() {},
      toggle() {},
      contains: () => false,
    };
  }

  addEventListener() {}

  removeEventListener() {}

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }

  appendChild(child) {
    return child;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  closest() {
    return null;
  }
}

function loadMarketplacesHarness() {
  const source = fs.readFileSync(MARKETPLACES_PATH, "utf8");
  const elements = new Map();
  const documentObject = {
    readyState: "complete",
    body: new FakeElement("body"),
    createElement: () => new FakeElement(""),
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, new FakeElement(id));
      return elements.get(id);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  const windowObject = {
    appState: {},
    electronAPI: {},
    addEventListener() {},
    removeEventListener() {},
  };
  const context = {
    window: windowObject,
    document: documentObject,
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    Math,
    Date,
    Promise,
    JSON,
    Map,
    Set,
    HTMLElement: FakeElement,
    CustomEvent: class CustomEvent {},
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: MARKETPLACES_PATH });
  return { window: windowObject };
}

const baseSkill = (overrides = {}) => ({
  id: "using-teamworks",
  name: "Using Teamworks",
  description: "Role-agnostic skills.",
  skillPath: "./global/skills/using-teamworks",
  skillSource: null,
  pluginName: "portico-global",
  installed: true,
  seeded: false,
  hasUpdate: false,
  hasConflict: false,
  isDirty: false,
  available: true,
  ...overrides,
});

test("seeded installed cards render Built-in and never offer Uninstall", () => {
  const { window } = loadMarketplacesHarness();
  const hooks = window.MarketplaceRenderHooks;

  const seededHtml = hooks.renderMarketplaceSkillCard(baseSkill({ seeded: true }));
  assert.match(seededHtml, /badge-builtin/);
  assert.match(seededHtml, /marketplace-skill-builtin-btn/);
  assert.match(seededHtml, /marketplace-skill-menu-builtin-btn/);
  assert.doesNotMatch(seededHtml, /marketplace-skill-menu-uninstall-btn/);
  assert.doesNotMatch(seededHtml, /marketplace-skill-installed-btn/);

  const normalHtml = hooks.renderMarketplaceSkillCard(baseSkill());
  assert.match(normalHtml, /marketplace-skill-menu-uninstall-btn/);
  assert.match(normalHtml, /marketplace-skill-installed-btn/);
  assert.doesNotMatch(normalHtml, /badge-builtin/);
});

test("seeded dirty installs do not offer Detach (the service refuses it)", () => {
  const { window } = loadMarketplacesHarness();
  const hooks = window.MarketplaceRenderHooks;
  const seededDirty = hooks.renderMarketplaceSkillCard(
    baseSkill({ seeded: true, isDirty: true }),
  );
  assert.doesNotMatch(seededDirty, /marketplace-skill-detach-btn/);
  const normalDirty = hooks.renderMarketplaceSkillCard(baseSkill({ isDirty: true }));
  assert.match(normalDirty, /marketplace-skill-detach-btn/);
});

test("marketplace badges: INSTALLED counts live records; parked records get their own chip", () => {
  const { window } = loadMarketplacesHarness();
  const hooks = window.MarketplaceRenderHooks;
  const badges = hooks
    .buildMarketplaceBadges(
      {
        id: "portico-ai-marketplace",
        installedCount: 1,
        parkedCount: 4,
        hasUpdates: false,
        dirtyCount: 0,
        conflictCount: 0,
      },
      { includeInstallState: true },
    )
    .join("");
  assert.match(badges, /1 INSTALLED/);
  assert.match(badges, /4 PARKED/);
});

test("drilldown header counts only entries the page can render (available !== false)", () => {
  const { window } = loadMarketplacesHarness();
  const hooks = window.MarketplaceRenderHooks;
  hooks.setMarketplaceSkillsCacheForTests("portico-ai-marketplace", [
    baseSkill(),
    baseSkill({ id: "ghost-1", available: false, installed: true }),
    baseSkill({ id: "ghost-2", available: false, installed: true }),
    baseSkill({ id: "not-installed", installed: false }),
  ]);
  const derived = hooks.withCatalogDerivedBadgeCounts({
    id: "portico-ai-marketplace",
    installedCount: 99,
  });
  assert.equal(derived.installedCount, 1);
});
