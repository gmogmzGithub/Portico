// Round 9 provenance gating in the agents UI: the skills picker hides
// non-attachable skills (unapproved marketplace provenance) unless already
// selected — where they render as removable "Blocked" rows — publish buttons
// disable with a tooltip enumerating blocked skills, and the edit form's save
// path rewrites legacy 2-segment ids to their unique fully-qualified form.
// Harness mirrors agents-dependent-skill-publish.unit.test.js.
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

const ATTACHABLE = Object.freeze({
  id: "corp-skills/planner",
  display_name: "Planner",
  description: "Approved marketplace skill",
  source: "marketplace",
  marketplace_id: "corp-skills",
  marketplace_name: "Corp Skills",
  agent_attachable: true,
});

const BLOCKED = Object.freeze({
  id: "shady-skills/exfil",
  display_name: "Exfil Tool",
  description: "Unapproved marketplace skill",
  source: "marketplace",
  marketplace_id: "shady-skills",
  marketplace_name: "Shady Skills",
  agent_attachable: false,
});

test("the picker hides non-attachable skills unless selected, then shows a removable Blocked row", () => {
  const { window } = loadAgentsHarness();
  const hooks = window.AgentsTabRenderHooks;

  // Not selected: the blocked skill is invisible (cannot be added).
  const hidden = hooks.renderCapabilityRows(
    [ATTACHABLE, BLOCKED],
    [],
    "",
    "No skills",
    "skills",
  );
  assert.match(hidden, /Planner/);
  assert.doesNotMatch(hidden, /Exfil Tool/);

  // Selected (grandfathered): visible with a Blocked badge and marked row.
  const shown = hooks.renderCapabilityRows(
    [ATTACHABLE, BLOCKED],
    [BLOCKED.id],
    "",
    "No skills",
    "skills",
  );
  assert.match(shown, /Exfil Tool/);
  assert.match(shown, /badge-blocked"[^>]*>Blocked</);
  assert.match(shown, /agent-capability-row-blocked/);
  assert.match(shown, /unapproved marketplace &quot;Shady Skills&quot;/);
  // The attachable row never carries the badge.
  assert.doesNotMatch(
    shown.split("Exfil Tool")[0],
    /badge-blocked/,
    "only the blocked row is badged",
  );

  // Searching never resurfaces an unselected blocked skill.
  const searched = hooks.renderCapabilityRows(
    [ATTACHABLE, BLOCKED],
    [],
    "exfil",
    "No skills",
    "skills",
  );
  assert.doesNotMatch(searched, /Exfil Tool/);
});

test("picker rows read plugin skills as Plugin → Skill and match plugin searches", () => {
  const { window } = loadAgentsHarness();
  const hooks = window.AgentsTabRenderHooks;
  const pluginSkill = {
    id: "kwp/plugin-a/android",
    display_name: "Android A",
    source: "marketplace",
    marketplace_id: "kwp",
    marketplace_name: "kwp",
    plugin_name: "plugin-a",
  };

  const rows = hooks.renderCapabilityRows(
    [ATTACHABLE, pluginSkill],
    [],
    "",
    "No skills",
    "skills",
  );
  assert.match(rows, /agent-capability-row-name">Plugin A → Android A</);
  assert.match(rows, /agent-capability-row-name">Planner</, "plugin-less rows stay plain");

  // The plugin name is part of the search haystack.
  const searched = hooks.renderCapabilityRows(
    [ATTACHABLE, pluginSkill],
    [],
    "plugin-a",
    "No skills",
    "skills",
  );
  assert.match(searched, /Android A/);
  assert.doesNotMatch(searched, /Planner/);
});

test("normalizeSkill carries agent_attachable (default true) and plugin_name", () => {
  const { window } = loadAgentsHarness();
  const hooks = window.AgentsTabRenderHooks;

  const blocked = hooks.normalizeSkill({
    name: "shady-skills/exfil",
    source: "marketplace",
    agent_attachable: false,
    plugin_name: "tools",
  });
  assert.equal(blocked.agent_attachable, false);
  assert.equal(blocked.plugin_name, "tools");

  // Older catalog payloads without the flag stay attachable.
  const legacy = hooks.normalizeSkill({ name: "notes", source: "user" });
  assert.equal(legacy.agent_attachable, true);
  assert.equal(legacy.plugin_name, null);
});

test("publish buttons disable with a tooltip enumerating blocked skills", () => {
  const { window } = loadAgentsHarness();
  const hooks = window.AgentsTabRenderHooks;
  hooks.setCatalogSkillsForTests([ATTACHABLE, BLOCKED]);

  const agent = {
    id: "my-agent",
    name: "My Agent",
    skill_ids: ["corp-skills/planner", "shady-skills/exfil"],
  };
  const blockedNames = hooks.agentBlockedSkillNames(agent);
  assert.deepEqual(JSON.parse(JSON.stringify(blockedNames)), ["Exfil Tool"]);
  const tooltip = hooks.blockedPublishTooltip(blockedNames);
  assert.match(tooltip, /Publishing is blocked/);
  assert.match(tooltip, /Exfil Tool/);
  assert.match(tooltip, /unapproved marketplace/);
  assert.match(tooltip, /Remove it to publish/);

  const actions = hooks.buildAgentPageActionsHtml(agent, "edit");
  assert.match(actions, /agent-publish-btn[^>]*disabled/);
  assert.match(actions, /Publishing is blocked/);

  // A clean agent's publish button stays enabled.
  const cleanActions = hooks.buildAgentPageActionsHtml(
    { id: "clean-agent", name: "Clean", skill_ids: ["corp-skills/planner"] },
    "edit",
  );
  assert.doesNotMatch(cleanActions, /agent-publish-btn[^>]*disabled/);

  // Legacy 2-segment ids resolve through the unique-leaf fallback too.
  const legacyAgent = {
    id: "legacy-agent",
    name: "Legacy",
    skill_ids: ["shady-skills/exfil"],
  };
  hooks.setCatalogSkillsForTests([
    { ...BLOCKED, id: "shady-skills/tools/exfil" },
  ]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(hooks.agentBlockedSkillNames(legacyAgent))),
    ["Exfil Tool"],
  );
});

test("saving the edit form rewrites legacy 2-segment ids to their unique FQN (ambiguous ids untouched)", () => {
  const { window } = loadAgentsHarness();
  const hooks = window.AgentsTabRenderHooks;
  hooks.setCatalogSkillsForTests([
    { ...ATTACHABLE, id: "kwp/document-skills/pdf", display_name: "PDF" },
    { ...ATTACHABLE, id: "kwp/plugin-a/android", display_name: "Android A" },
    { ...ATTACHABLE, id: "kwp/plugin-b/android", display_name: "Android B" },
    { ...ATTACHABLE, id: "kwp/solo", display_name: "Solo" },
  ]);

  assert.deepEqual(
    JSON.parse(JSON.stringify(hooks.normalizeSelectedSkillIds([
      "kwp/pdf", // legacy → unique FQN
      "kwp/android", // ambiguous → untouched
      "kwp/solo", // exact flat id → untouched
      "kwp/document-skills/pdf", // already FQN → untouched
      "web-search", // bare local id → untouched
    ]))),
    [
      "kwp/document-skills/pdf",
      "kwp/android",
      "kwp/solo",
      "kwp/document-skills/pdf",
      "web-search",
    ],
  );
});
