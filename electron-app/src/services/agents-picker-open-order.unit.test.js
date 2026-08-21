// Capability-picker popover ordering: rows that are ALREADY selected surface
// at the top when the popover opens, without destabilizing the list while it
// stays open — wirePicker computes orderCapabilityOptionsForOpen ONCE per
// open (from the selection as of open) and renders every subsequent
// search/filter/toggle pass from that frozen order. These tests cover the
// ordering helper and its composition with renderCapabilityRows through the
// window.AgentsTabRenderHooks seam (harness mirrors
// agents-provenance-gating.unit.test.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const AGENTS_PATH = path.join(__dirname, "..", "renderer", "components", "agents.js");

function loadAgentsHarness() {
  const source = fs.readFileSync(AGENTS_PATH, "utf8");
  const componentsDir = path.join(__dirname, "..", "renderer", "components");
  const extraSources = [
    "agent-reasoning-options.js",
    "agent-model-picker.js",
    "agent-reasoning-slider.js",
  ].map((name) => ({
    path: path.join(componentsDir, name),
    source: fs.readFileSync(path.join(componentsDir, name), "utf8"),
  }));

  class FakeElement {
    constructor(id = "") {
      this.id = id;
      this.style = { display: "none" };
      this.classList = { add() {}, remove() {}, contains: () => false, toggle() {} };
      this.dataset = {};
      this.innerHTML = "";
      this.textContent = "";
      this.value = "";
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
    closest() {
      return null;
    }
  }

  const document = {
    readyState: "complete",
    body: new FakeElement("body"),
    createElement: (tag) => new FakeElement(tag),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  const windowObject = {
    appState: {},
    electronAPI: {
      invokeMcpTool: async () => ({ success: true, data: { agents: [] } }),
      getSkills: async () => ({ success: true, skills: [] }),
      loadMcpServers: async () => ({ success: true, data: [] }),
      aiMarketplace: { listLinks: async () => ({ success: true, links: {} }) },
    },
    showNotification() {},
  };
  const context = {
    window: windowObject,
    document,
    console,
    setTimeout,
    clearTimeout,
    Math,
    Date,
    Promise,
    HTMLElement: FakeElement,
  };
  context.globalThis = context;
  for (const extra of extraSources) {
    vm.runInNewContext(extra.source, context, { filename: extra.path });
  }
  vm.runInNewContext(source, context, { filename: AGENTS_PATH });
  return { window: windowObject };
}

// Arrays returned by the vm-realm helpers fail strict deepEqual on
// constructor identity; compare plain JSON clones.
const plain = (value) => JSON.parse(JSON.stringify(value));

const CATALOG = Object.freeze([
  { id: "a11y", display_name: "A11y", source: "marketplace" },
  { id: "account-research", display_name: "Account Research", source: "marketplace" },
  { id: "agent-builder", display_name: "Agent Builder", source: "marketplace" },
  { id: "company-knowledge", display_name: "Company Knowledge", source: "system" },
  { id: "slack", display_name: "Slack", source: "system" },
]);

test("open ordering floats selected rows to the top, keeping catalog order within each group", () => {
  const { window } = loadAgentsHarness();
  const hooks = window.AgentsTabRenderHooks;
  const ordered = hooks.orderCapabilityOptionsForOpen(CATALOG, [
    "slack",
    "company-knowledge",
  ]);
  assert.deepEqual(
    plain(ordered.map((opt) => opt.id)),
    // Selected group keeps CATALOG order (company-knowledge before slack even
    // though the selection listed slack first), then the rest in catalog order.
    ["company-knowledge", "slack", "a11y", "account-research", "agent-builder"],
  );
  // Pure partition: the input array is not mutated.
  assert.deepEqual(
    CATALOG.map((opt) => opt.id),
    ["a11y", "account-research", "agent-builder", "company-knowledge", "slack"],
  );
});

test("open ordering is a no-op without selections or when no selected id matches", () => {
  const { window } = loadAgentsHarness();
  const hooks = window.AgentsTabRenderHooks;
  assert.deepEqual(
    plain(hooks.orderCapabilityOptionsForOpen(CATALOG, []).map((opt) => opt.id)),
    CATALOG.map((opt) => opt.id),
  );
  assert.deepEqual(
    plain(
      hooks
        .orderCapabilityOptionsForOpen(CATALOG, ["ghost-skill", null, ""])
        .map((opt) => opt.id),
    ),
    CATALOG.map((opt) => opt.id),
  );
});

test("rendering the open-ordered list puts every selected row above every unselected row", () => {
  const { window } = loadAgentsHarness();
  const hooks = window.AgentsTabRenderHooks;
  const selected = ["slack", "agent-builder"];
  const html = hooks.renderCapabilityRows(
    hooks.orderCapabilityOptionsForOpen(CATALOG, selected),
    selected,
    "",
    "No skills available",
    "skills",
    "all",
  );
  const rowIndex = (id) => html.indexOf(`data-row-id="${id}"`);
  for (const id of selected) {
    assert.ok(rowIndex(id) >= 0, `${id} renders`);
  }
  const maxSelected = Math.max(...selected.map(rowIndex));
  const minUnselected = Math.min(
    ...CATALOG.filter((opt) => !selected.includes(opt.id)).map((opt) => rowIndex(opt.id)),
  );
  assert.ok(
    maxSelected < minUnselected,
    "all selected rows render before the first unselected row",
  );
});

test("the partition is stable for a fixed selection and re-floats only when recomputed", () => {
  const { window } = loadAgentsHarness();
  const hooks = window.AgentsTabRenderHooks;
  const atOpen = ["company-knowledge"];
  const frozen = hooks.orderCapabilityOptionsForOpen(CATALOG, atOpen);

  // wirePicker renders every pass from the order computed at open — a toggle
  // made WHILE open changes the selection but not the frozen list, so a row
  // selected mid-session stays where it was.
  const afterToggle = hooks.renderCapabilityRows(
    frozen,
    ["company-knowledge", "slack"],
    "",
    "No skills available",
    "skills",
    "all",
  );
  const rowIndex = (id) => afterToggle.indexOf(`data-row-id="${id}"`);
  assert.ok(
    rowIndex("a11y") < rowIndex("slack"),
    "a row toggled while open keeps its frozen (catalog) position",
  );

  // The NEXT open recomputes from the new selection and floats it.
  const reopened = hooks.orderCapabilityOptionsForOpen(CATALOG, [
    "company-knowledge",
    "slack",
  ]);
  assert.deepEqual(plain(reopened.slice(0, 2).map((opt) => opt.id)), [
    "company-knowledge",
    "slack",
  ]);
});
