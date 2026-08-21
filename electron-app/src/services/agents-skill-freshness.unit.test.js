// Behavior tests for the per-agent skills-freshness layer in agents.js
// (window.AgentsTabRenderHooks): one shared headless snapshot behind the
// card "Update available" badges, the per-card spinner chip, the 5-minute
// attempt TTL (failures back off too), and the read-only agent view's
// Status | Skill | Source table. Harness mirrors
// agents-dependent-skill-publish.unit.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const AGENTS_PATH = path.join(__dirname, "..", "renderer", "components", "agents.js");

class FakeClassList {
  constructor() {
    this.classes = new Set();
  }

  add(...names) {
    names.filter(Boolean).forEach((name) => this.classes.add(name));
  }

  remove(...names) {
    names.filter(Boolean).forEach((name) => this.classes.delete(name));
  }

  contains(name) {
    return this.classes.has(name);
  }
}

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.style = { display: "none" };
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.innerHTML = "";
    this.textContent = "";
    this.dataset = {};
    this.attributes = {};
    this.value = "";
  }

  addEventListener() {}

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  closest() {
    return null;
  }

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }

  appendChild(child) {
    return child;
  }
}

function loadFreshnessHarness({ startNow = 10_000_000 } = {}) {
  const source = fs.readFileSync(AGENTS_PATH, "utf8");
  const componentsDir = path.join(__dirname, "..", "renderer", "components");
  const extraSources = [
    "agent-reasoning-options.js",
    "agent-model-picker.js",
    "agent-reasoning-slider.js",
    "skill-card-renderer.js",
  ].map((name) => ({
    path: path.join(componentsDir, name),
    source: fs.readFileSync(path.join(componentsDir, name), "utf8"),
  }));

  const elements = new Map();
  [
    "view-mcp-servers-btn",
    "view-agent-skills-btn",
    "view-cost-dashboard-btn",
    "view-agents-tab-btn",
    "mcp-servers-view",
    "agent-skills-view",
    "cost-dashboard-view",
    "agents-tab-view",
    "mcp-header-actions",
    "skills-header-actions",
    "cost-dashboard-header-actions",
    "agents-tab-header-actions",
    "agents-tab-list",
    "agents-tab-new-agent-btn",
    "agents-tab-settings-btn",
    "agents-tab-search-input",
    "agents-tab-mode-tabs",
    "agents-confirm-modal",
    "agents-confirm-title",
    "agents-confirm-message",
    "agents-confirm-error",
    "agents-confirm-btn",
    "agents-confirm-cancel-btn",
    "agents-confirm-close-btn",
  ].forEach((id) => {
    elements.set(id, new FakeElement(id));
  });

  const document = {
    readyState: "complete",
    body: new FakeElement("body"),
    createElement: (tag) => new FakeElement(tag),
    getElementById: (id) => elements.get(id) || null,
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
  };

  const calls = [];
  const clock = { now: startNow };
  const fixture = {
    // One installed skill with an update, one clean installed skill, one
    // system skill, one user skill — the provenance matrix the status rules
    // discriminate on.
    skills: [
      { name: "web-search", display_name: "Web Search", source: "system" },
      { name: "my-notes", display_name: "My Notes", source: "user" },
      {
        name: "anthropic-agent-skills/algorithmic-art",
        display_name: "Algorithmic Art",
        source: "marketplace",
        marketplace_id: "anthropic-agent-skills",
        marketplace_name: "anthropic-agent-skills",
        has_update: true,
        has_conflict: false,
      },
      {
        name: "data-plat-skills/trino-query-writing",
        display_name: "Trino Query Writing",
        source: "marketplace",
        marketplace_id: "data-plat-skills",
        marketplace_name: "data-plat-skills",
        has_update: false,
        has_conflict: false,
      },
    ],
    checkImpl: async () => ({ success: true, updates: [], hasUpdates: false }),
    getSkillsImpl: null,
    // Skill-link map + the viewer's published skill listings (verified-
    // published semantics for the tables' Published chips).
    skillLinks: {},
    publishedSkillSolutions: [],
    listPublishedImpl: null,
  };

  const windowObject = {
    appState: { controlPlaneView: "mcp-servers" },
    electronAPI: {
      invokeMcpTool: async () => ({ success: true, data: { agents: [] } }),
      getSkills: async () => {
        calls.push(["getSkills"]);
        if (fixture.getSkillsImpl) return fixture.getSkillsImpl();
        return { success: true, skills: fixture.skills };
      },
      checkSkillUpdates: async (options) => {
        calls.push(["checkSkillUpdates", options]);
        return fixture.checkImpl();
      },
      loadMcpServers: async () => ({ success: true, data: [] }),
      aiMarketplace: {
        listLinks: async () => ({ success: true, links: {} }),
        listSkillLinks: async () => {
          calls.push(["listSkillLinks"]);
          return { success: true, links: fixture.skillLinks };
        },
        listPublished: async (type) => {
          calls.push(["listPublished", type]);
          if (fixture.listPublishedImpl) return fixture.listPublishedImpl();
          return {
            success: true,
            data: { solutions: fixture.publishedSkillSolutions },
          };
        },
      },
    },
    showNotification() {},
  };

  class TestDate extends Date {
    static now() {
      return clock.now;
    }
  }

  const context = {
    window: windowObject,
    document,
    console,
    setTimeout,
    clearTimeout,
    Math,
    Date: TestDate,
    Promise,
    HTMLElement: FakeElement,
  };
  context.globalThis = context;

  for (const extra of extraSources) {
    vm.runInNewContext(extra.source, context, { filename: extra.path });
  }
  vm.runInNewContext(source, context, { filename: AGENTS_PATH });

  return { window: windowObject, elements, calls, clock, fixture };
}

const FIVE_MINUTES = 5 * 60_000;

// The network phase (headless sweep + published set) continues after the
// snapshot promise resolves local-first; flush microtasks so its effects
// land before counting calls.
const settleBackground = async (rounds = 10) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

test("snapshot fetch is headless, deduped in flight, and honors the 5-minute TTL", async () => {
  const { window, calls, clock } = loadFreshnessHarness();
  const hooks = window.AgentsTabRenderHooks;

  const [a, b] = await Promise.all([
    hooks.loadSkillFreshnessSnapshot(),
    hooks.loadSkillFreshnessSnapshot(),
  ]);
  assert.equal(a, b, "concurrent callers share one snapshot");
  await settleBackground();
  assert.equal(calls.filter(([n]) => n === "checkSkillUpdates").length, 1);
  // Local-first: one getSkills resolves the snapshot, one refreshes after
  // the headless sweep settles.
  assert.equal(calls.filter(([n]) => n === "getSkills").length, 2);
  // vm-realm objects fail cross-realm deepEqual; compare the property.
  assert.equal(
    calls.find(([n]) => n === "checkSkillUpdates")[1]?.interactiveAuth,
    false,
    "the render-path refresh must never pop interactive git auth",
  );

  // Within the TTL: served from cache, zero new IPC.
  clock.now += FIVE_MINUTES - 1_000;
  await hooks.loadSkillFreshnessSnapshot();
  assert.equal(calls.filter(([n]) => n === "checkSkillUpdates").length, 1);

  // Past the TTL: exactly one fresh cycle.
  clock.now += 2_000;
  await hooks.loadSkillFreshnessSnapshot();
  await settleBackground();
  assert.equal(calls.filter(([n]) => n === "checkSkillUpdates").length, 2);
  assert.equal(calls.filter(([n]) => n === "getSkills").length, 4);
});

test("a failed cycle backs off for the TTL instead of hot-retrying", async () => {
  const { window, calls, clock, fixture } = loadFreshnessHarness();
  const hooks = window.AgentsTabRenderHooks;
  fixture.getSkillsImpl = async () => {
    throw new Error("ipc unavailable");
  };

  await assert.rejects(hooks.loadSkillFreshnessSnapshot());
  // Within the TTL the failure is cached (resolves null, no new IPC).
  const cached = await hooks.loadSkillFreshnessSnapshot();
  assert.equal(cached, null);
  assert.equal(calls.filter(([n]) => n === "getSkills").length, 1);

  // After the TTL a retry happens and succeeds.
  fixture.getSkillsImpl = null;
  clock.now += FIVE_MINUTES + 1;
  const snapshot = await hooks.loadSkillFreshnessSnapshot();
  assert.ok(snapshot?.bySkill?.get("algorithmic-art"));
});

test("freshness status rules are provenance-aware", async () => {
  const { window } = loadFreshnessHarness();
  const hooks = window.AgentsTabRenderHooks;
  const snapshot = await hooks.loadSkillFreshnessSnapshot();

  assert.equal(hooks.skillFreshnessStatusFor(snapshot.bySkill.get("web-search")), "current");
  assert.equal(hooks.skillFreshnessStatusFor(snapshot.bySkill.get("my-notes")), "current");
  assert.equal(
    hooks.skillFreshnessStatusFor(snapshot.bySkill.get("algorithmic-art")),
    "update",
  );
  assert.equal(
    hooks.skillFreshnessStatusFor(snapshot.bySkill.get("trino-query-writing")),
    "current",
  );
  assert.equal(
    hooks.skillFreshnessStatusFor({ source: "marketplace", hasUpdate: true, hasConflict: true }),
    "conflict",
  );
  assert.equal(hooks.skillFreshnessStatusFor(null), "idle");
});

test("cards show the spinner while unknown, then the skill-driven update badge without the update menu action", async () => {
  const { window } = loadFreshnessHarness();
  const hooks = window.AgentsTabRenderHooks;
  const userAgent = {
    id: "agent-user",
    name: "My Agent",
    creation_source: "local",
    created_by_email: "dsantiago@example.invalid",
    skill_ids: ["anthropic-agent-skills/algorithmic-art", "web-search"],
    tool_server_ids: [],
  };

  // Before any snapshot: unknown → subtle spinner, no update badge.
  const pendingHtml = window.AgentCardRenderer.buildAgentCardHtml(userAgent);
  assert.match(pendingHtml, /agent-card-freshness-spinner/);
  assert.doesNotMatch(pendingHtml, /badge-has-updates/);

  await hooks.loadSkillFreshnessSnapshot();

  const readyHtml = window.AgentCardRenderer.buildAgentCardHtml(userAgent);
  assert.doesNotMatch(readyHtml, /agent-card-freshness-spinner/);
  assert.match(readyHtml, /badge-has-updates[^>]*>Update available</);
  assert.match(
    readyHtml,
    /One or more skills used by this agent have marketplace updates available\. Update them from the Skills tab or Sync All\./,
  );
  assert.match(readyHtml, /mcp-server-card agent-card[^"]*update-available/);
  // The badge row lives under the title, above the description.
  assert.match(
    readyHtml,
    /agent-card-badges[\s\S]*agent-card-desc/,
    "badges render before the description",
  );
  // Skill-driven updates never unlock the agent-level update action (that
  // flow is for installed copies whose own listing moved ahead).
  assert.doesNotMatch(readyHtml, /agent-update-btn/);

  // An agent with no skills never shows the spinner.
  const bare = window.AgentCardRenderer.buildAgentCardHtml({
    id: "agent-bare",
    name: "Bare",
    creation_source: "local",
    created_by_email: "dsantiago@example.invalid",
    skill_ids: [],
    tool_server_ids: [],
  });
  assert.doesNotMatch(bare, /agent-card-freshness-spinner/);
});

test("agents whose skills are all current get neither spinner nor badge once resolved", async () => {
  const { window } = loadFreshnessHarness();
  const hooks = window.AgentsTabRenderHooks;
  await hooks.loadSkillFreshnessSnapshot();
  const html = window.AgentCardRenderer.buildAgentCardHtml({
    id: "agent-clean",
    name: "Clean",
    creation_source: "local",
    created_by_email: "dsantiago@example.invalid",
    skill_ids: ["web-search", "data-plat-skills/trino-query-writing"],
    tool_server_ids: [],
  });
  assert.doesNotMatch(html, /agent-card-freshness-spinner/);
  assert.doesNotMatch(html, /badge-has-updates/);
  assert.doesNotMatch(html, /update-available/);
});

test("the read-only view renders the model chip, formatted effort, friendly MCP names, and the status table", async () => {
  const { window } = loadFreshnessHarness();
  const hooks = window.AgentsTabRenderHooks;
  const catalogs = {
    baseModels: [
      {
        id: "gpt-5-6-terra",
        display_name: "GPT-5.6 Terra",
        picker_provider: "openai",
      },
    ],
    skills: [
      { id: "web-search", display_name: "Web Search", source: "system" },
      {
        id: "anthropic-agent-skills/algorithmic-art",
        display_name: "Algorithmic Art",
        source: "marketplace",
        marketplace_id: "anthropic-agent-skills",
        marketplace_name: "anthropic-agent-skills",
      },
    ],
    toolServers: [
      {
        id: "server:mcp-atlassian",
        display_name: "Atlassian",
        icon_url: null,
        source: "core",
      },
    ],
  };
  const html = hooks.buildInstalledAgentViewHtml(
    {
      id: "zzz-agent",
      name: "zzz",
      description: "d",
      base_model_id: "gpt-5-6-terra",
      reasoning_effort: "xhigh",
      created_by_email: "dsantiago",
      allowed_emails: [],
      marketplace_solution_id: "sol-1",
      skill_ids: ["web-search", "anthropic-agent-skills/algorithmic-art"],
      tool_server_ids: ["server:mcp-atlassian"],
      system_prompt: "p",
    },
    catalogs,
  );

  // Marketplace solution id renders as the grey copyable badge.
  assert.match(html, /agents-id-badge[^>]*>sol-1</);
  assert.match(html, /agents-copy-btn" data-copy-value="sol-1"/);

  // Edit-like identity section: Description + Allowed emails as proper
  // fields; Type/Install status/Visibility boxes are gone (badges cover
  // provenance) and only Source / Solution ID / Author remain.
  assert.match(html, /agents-form-label">Description</);
  assert.match(html, /agent-view-textbox">d</);
  assert.match(html, /agents-form-label">Allowed emails</);
  assert.match(html, /Everyone \(public\)/);
  assert.match(html, /<dt>Author<\/dt>/);
  assert.doesNotMatch(html, /<dt>Type<\/dt>/);
  assert.doesNotMatch(html, /<dt>Install status<\/dt>/);
  assert.doesNotMatch(html, /<dt>Visibility<\/dt>/);
  assert.doesNotMatch(html, /<dt>Agent ID<\/dt>/);

  // 4a: model identity chip with the display name, not the raw id.
  assert.match(html, /agent-model-identity/);
  assert.match(html, /GPT-5\.6 Terra/);
  assert.match(html, /Reasoning effort/);
  assert.match(html, /Extra High/);
  assert.doesNotMatch(html, />xhigh</);

  // 4b: friendly MCP server label with the raw id demoted to the tooltip.
  assert.match(html, /title="Atlassian \(server:mcp-atlassian\)"/);
  assert.match(html, /<span>Atlassian<\/span>/);

  // 4c: Status | Skill | Source | Note table (no "What happens" column),
  // spinner cells keyed by canonical skill name until the snapshot resolves.
  assert.match(html, /agent-view-skill-table/);
  assert.match(
    html,
    /<th>Status<\/th>\s*<th>Skill<\/th>\s*<th>Source<\/th>\s*<th>Note<\/th>/,
  );
  assert.doesNotMatch(html, /<th>What happens<\/th>/);
  assert.match(html, /data-skill-status="algorithmic-art"/);
  assert.equal((html.match(/data-status="working"/g) || []).length, 2);
  assert.match(html, /badge-marketplace-name"[^>]*>anthropic-agent-skills</);
  // Git-marketplace provenance is explicit on the read-only page too:
  // GIT → marketplace name, with installed-ness stated in the Note column
  // ("Already installed on this computer.") instead of an Installed chip.
  const artStart = html.indexOf('data-skill="algorithmic-art"');
  assert.ok(artStart >= 0);
  const artRow = html.slice(artStart, html.indexOf("</tr>", artStart));
  assert.match(artRow, /badge-git[\s\S]*badge-marketplace-name/);
  assert.doesNotMatch(artRow, /badge-installed/);
  assert.match(artRow, /agents-publish-skill-note[\s\S]*Already installed on this computer\./);
  // Core rows carry a quiet dash in the Note column.
  const webStart = html.indexOf('data-skill="web-search"');
  const webRow = html.slice(webStart, html.indexOf("</tr>", webStart));
  assert.match(webRow, /agents-publish-skill-note"><span class="agent-details-empty">—</);
});

test("applyAgentViewSkillStatuses stamps table cells from the snapshot and degrades to idle on failure", async () => {
  const { window, fixture } = loadFreshnessHarness();
  const hooks = window.AgentsTabRenderHooks;

  const makeCell = (name) => {
    const cell = new FakeElement("cell");
    cell.attributes["data-skill-status"] = name;
    cell.dataset.status = "working";
    return cell;
  };
  const cells = [
    makeCell("web-search"),
    makeCell("algorithmic-art"),
    makeCell("missing-skill"),
  ];
  const root = {
    querySelectorAll: (selector) =>
      selector.includes("data-skill-status") ? cells : [],
  };

  // state.editor is null in this harness; passing the same value keeps the
  // session guard satisfied.
  await hooks.applyAgentViewSkillStatuses(root, null);
  assert.equal(cells[0].dataset.status, "current");
  assert.equal(cells[1].dataset.status, "update");
  assert.equal(cells[2].dataset.status, "idle");

  // Failure path on a fresh harness: cells fall back to idle, not a spinner.
  const failed = loadFreshnessHarness();
  failed.fixture.getSkillsImpl = async () => {
    throw new Error("nope");
  };
  const failedCells = [makeCell("web-search")];
  const failedRoot = {
    querySelectorAll: () => failedCells,
  };
  await failed.window.AgentsTabRenderHooks.applyAgentViewSkillStatuses(failedRoot, null);
  assert.equal(failedCells[0].dataset.status, "idle");
});

test("a shadowed marketplace copy never flags agents using the winning system copy", async () => {
  const harness = loadFreshnessHarness();
  // Real-world shape from get-skills: the system copy echoes its own name in
  // marketplace_name, and an installed Solutions copy shares the canonical
  // name but loses resolution precedence.
  harness.fixture.skills = [
    {
      name: "ai-marketplace/code-execution",
      display_name: "Code Execution",
      source: "marketplace",
      marketplace_name: "Solutions Marketplace",
      has_update: true,
    },
    {
      name: "code-execution",
      display_name: "Code Execution",
      source: "system",
      marketplace_name: "code-execution",
    },
  ];
  const hooks = harness.window.AgentsTabRenderHooks;
  const snapshot = await hooks.loadSkillFreshnessSnapshot();

  const entry = snapshot.bySkill.get("code-execution");
  assert.equal(entry.source, "system", "the winning copy is kept regardless of catalog order");
  assert.equal(hooks.skillFreshnessStatusFor(entry), "current");

  const rows = hooks.getAgentSkillRowDetails(["code-execution"], {
    skills: [
      {
        id: "ai-marketplace/code-execution",
        display_name: "Code Execution",
        source: "marketplace",
        marketplace_name: "Solutions Marketplace",
      },
      {
        id: "code-execution",
        display_name: "Code Execution",
        source: "system",
        marketplace_name: "code-execution",
      },
    ],
  });
  assert.equal(rows[0].source, "system");
  assert.equal(
    rows[0].marketplaceName,
    "",
    "non-marketplace sources never echo a marketplace name",
  );
});

test("plugin skills read as Plugin → Skill in provenance row labels", () => {
  const { window } = loadFreshnessHarness();
  const hooks = window.AgentsTabRenderHooks;
  const catalogs = {
    skills: [
      {
        id: "kwp/plugin-a/android",
        display_name: "Android A",
        source: "marketplace",
        marketplace_id: "kwp",
        marketplace_name: "kwp",
        plugin_name: "plugin-a",
      },
      {
        id: "kwp/loose-skill",
        display_name: "Loose Skill",
        source: "marketplace",
        marketplace_id: "kwp",
        marketplace_name: "kwp",
        plugin_name: null,
      },
    ],
  };
  const rows = hooks.getAgentSkillRowDetails(
    ["kwp/plugin-a/android", "kwp/loose-skill"],
    catalogs,
  );
  const byName = new Map(rows.map((row) => [row.canonicalName, row]));
  assert.equal(byName.get("android").label, "Plugin A → Android A");
  assert.equal(
    byName.get("loose-skill").label,
    "Loose Skill",
    "plugin-less skills keep their plain label",
  );
});

// ---- Polish round 2: badge ordering, edit-form table, Discover unification --

test("skill card badges follow the facet-filter order: Published before Installed", () => {
  const { window } = loadFreshnessHarness();
  const html = window.SkillCardRenderer.buildSkillCardHtml(
    {
      name: "ai-marketplace/docx",
      display_name: "Docx",
      description: "Creates Word documents.",
      source: "marketplace",
      marketplace_name: "anthropic-agent-skills",
      author: "Keith Lazuka",
      version: "1.2.3",
    },
    { link: { solutionId: "sol-docx" } },
  );
  assert.match(
    html,
    /badge-published[\s\S]*badge-installed[\s\S]*badge-marketplace-name/,
    "marketplace copies render Published, then Installed + marketplace name",
  );
  // User skills keep the source chip first: User, then Published.
  const userHtml = window.SkillCardRenderer.buildSkillCardHtml(
    {
      name: "my-skill",
      display_name: "My Skill",
      description: "Mine",
      source: "user",
      created_by_email: "dsantiago@example.invalid",
    },
    { link: { solutionId: "sol-mine" } },
  );
  assert.match(userHtml, /badge-user[\s\S]*badge-published/);
});

test("the edit form carries the same skill provenance table, live-refreshable", () => {
  const { window } = loadFreshnessHarness();
  const catalogs = {
    baseModels: [],
    skills: [
      {
        id: "anthropic-agent-skills/algorithmic-art",
        display_name: "Algorithmic Art",
        source: "marketplace",
        marketplace_name: "anthropic-agent-skills",
      },
    ],
    toolServers: [],
  };
  catalogs.toolServers = [
    { id: "server:mcp-atlassian", display_name: "Atlassian", icon_url: null, source: "core" },
  ];
  const html = window.AgentsPublishHooks.buildAgentForm(
    {
      id: "agent-1",
      name: "Agent One",
      base_model_id: "",
      skill_ids: ["anthropic-agent-skills/algorithmic-art"],
      tool_server_ids: ["server:mcp-atlassian"],
    },
    catalogs,
  );
  assert.match(html, /Skill provenance/);
  assert.match(html, /data-agent-edit-skill-table/);
  assert.match(html, /agent-view-skill-table/);
  assert.match(html, /Algorithmic Art/);
  // The table sits in a full-width grid row under the two pickers.
  assert.match(html, /agent-editor-grid-span/);
  // The MCP server list mirrors the read-only view: friendly names, raw id
  // demoted to the tooltip.
  assert.match(html, /data-agent-edit-tool-list/);
  assert.match(html, /<span>Atlassian<\/span>/);
  assert.match(html, /title="Atlassian \(server:mcp-atlassian\)"/);
});

test("the Discover detail view renders the installed-view presentation", () => {
  const { window } = loadFreshnessHarness();
  const catalogs = {
    baseModels: [
      { id: "atlas-sonnet-5", display_name: "Atlas Sonnet 5", picker_provider: "anthropic" },
    ],
    skills: [
      { id: "web-search", display_name: "Web Search", source: "system" },
      {
        id: "anthropic-agent-skills/algorithmic-art",
        display_name: "Algorithmic Art",
        source: "marketplace",
        marketplace_id: "anthropic-agent-skills",
        marketplace_name: "anthropic-agent-skills",
      },
    ],
    toolServers: [
      { id: "server:trust-kit-mcp", display_name: "Trust Kit", icon_url: null, source: "core" },
    ],
  };
  const html = window.AgentsTabRenderHooks.buildDiscoverAgentViewHtml(
    {
      id: "sol-waldo",
      type: "portico-agents",
      author: "smurakami",
      description: "desc",
      allowed_emails: ["jdoe@example.invalid", "asmith@example.invalid"],
      bundle: {
        type: "portico-agents",
        payload: {
          name: "Waldo",
          base_model_id: "atlas-sonnet-5",
          reasoning_effort: "medium",
          system_prompt: "p",
          skill_ids: [
            "web-search",
            "missing-skill",
            "gtm-brief-qa",
            "zs-git-skill",
            "anthropic-agent-skills/algorithmic-art",
          ],
          skill_refs: [
            {
              skill_id: "gtm-brief-qa",
              kind: "solution",
              solution_id: "sol-qa",
              display_name: "GTM Brief QA",
            },
            {
              skill_id: "zs-git-skill",
              kind: "git-marketplace",
              display_name: "ZS Git Skill",
              marketplace: {
                name: "zstevens-portico-skills",
                source: { type: "github", repo: "zstevens/portico-skills" },
              },
            },
          ],
          tool_server_ids: ["server:trust-kit-mcp"],
        },
      },
    },
    catalogs,
  );
  const rowHtml = (name) => {
    const start = html.indexOf(`data-skill="${name}"`);
    assert.ok(start >= 0, `table row for ${name} renders`);
    return html.slice(start, html.indexOf("</tr>", start));
  };
  // Model identity chip + formatted effort, not raw ids.
  assert.match(html, /agent-model-identity/);
  assert.match(html, /Atlas Sonnet 5/);
  assert.match(html, /Reasoning effort/);
  assert.match(html, /Medium/);
  // Raw id boxes are gone; the Capabilities table takes their place.
  assert.doesNotMatch(html, /Skill IDs/);
  assert.doesNotMatch(html, /Tool IDs/);
  // Edit-like identity: Description field + the allow list, no Type/Install
  // status/Visibility boxes.
  assert.match(html, /agents-form-label">Description</);
  assert.match(html, /agent-view-textbox">desc</);
  assert.match(html, /agents-form-label">Allowed emails</);
  assert.match(html, /jdoe@example\.invalid\nasmith@example\.invalid/);
  assert.doesNotMatch(html, /<dt>Type<\/dt>/);
  assert.doesNotMatch(html, /<dt>Install status<\/dt>/);
  assert.doesNotMatch(html, /<dt>Visibility<\/dt>/);
  assert.match(html, /agent-view-skill-table/);
  assert.match(
    html,
    /<th>Status<\/th>\s*<th>Skill<\/th>\s*<th>Source<\/th>\s*<th>Note<\/th>/,
  );
  // Locally-missing bundle skills keep provenance badges in Source (from the
  // bundle's skill_refs) and state the caveat in the Note column.
  const qaRow = rowHtml("gtm-brief-qa");
  assert.match(qaRow, />GTM Brief QA</);
  assert.match(qaRow, /badge-marketplace-name">Solutions Marketplace</);
  assert.match(qaRow, /agents-publish-skill-note[\s\S]*Not on this computer/);
  const gitRow = rowHtml("zs-git-skill");
  assert.match(gitRow, />ZS Git Skill</);
  assert.match(
    gitRow,
    /badge-git[\s\S]*badge-marketplace-name"[^>]*>zstevens-portico-skills</,
  );
  assert.match(gitRow, /agents-publish-skill-note[\s\S]*Not on this computer/);
  // A bundle skill with no ref at all has nothing to badge: quiet dash.
  const bareRow = rowHtml("missing-skill");
  assert.match(bareRow, /agents-publish-skill-chips"><span class="agent-details-empty">—</);
  assert.match(bareRow, /agents-publish-skill-note[\s\S]*Not on this computer/);
  // Core rows carry the dash on the Note side instead.
  assert.match(rowHtml("web-search"), /agents-publish-skill-note"><span class="agent-details-empty">—</);
  // Installed git-marketplace skills show GIT → name on Discover too, with
  // installed-ness in the Note column rather than an Installed chip.
  const installedRow = rowHtml("algorithmic-art");
  assert.match(installedRow, /badge-git[\s\S]*badge-marketplace-name/);
  assert.doesNotMatch(installedRow, /badge-installed/);
  assert.match(
    installedRow,
    /agents-publish-skill-note[\s\S]*Already installed on this computer\./,
  );
  // Friendly MCP name with the raw id demoted to the tooltip.
  assert.match(html, /<span>Trust Kit<\/span>/);
});

test("copy helpers: id badge markup + clipboard bridge with feedback", async () => {
  const { window } = loadFreshnessHarness();
  const hooks = window.AgentsTabRenderHooks;

  const badge = hooks.copyableIdBadgeHtml("c1c2fbe2-6b67");
  assert.match(badge, /agents-id-badge[^>]*>c1c2fbe2-6b67</);
  assert.match(badge, /agents-copy-btn" data-copy-value="c1c2fbe2-6b67"/);
  assert.equal(hooks.copyableIdBadgeHtml(""), "—");

  const copies = [];
  const notices = [];
  window.electronAPI.copyToClipboard = async (text) => {
    copies.push(text);
  };
  window.showNotification = (message, kind) => {
    notices.push([message, kind]);
  };
  const ok = await hooks.copyTextToClipboard("abc-123", "Solution id");
  assert.equal(ok, true);
  assert.deepEqual(copies, ["abc-123"]);
  assert.deepEqual(notices, [["Solution id copied to clipboard", "success"]]);

  // Failures surface as an error toast and report false.
  window.electronAPI.copyToClipboard = async () => {
    throw new Error("denied");
  };
  const failed = await hooks.copyTextToClipboard("zzz", "Agent name");
  assert.equal(failed, false);
  assert.equal(notices[1][1], "error");
});

test("invalidateSkillFreshness forces the next call to fetch again", async () => {
  const { window, calls } = loadFreshnessHarness();
  const hooks = window.AgentsTabRenderHooks;
  await hooks.loadSkillFreshnessSnapshot();
  await settleBackground();
  assert.equal(calls.filter(([n]) => n === "getSkills").length, 2);
  hooks.invalidateSkillFreshness();
  await hooks.loadSkillFreshnessSnapshot();
  await settleBackground();
  assert.equal(calls.filter(([n]) => n === "getSkills").length, 4);
});

// ---------------------------------------------------------------------------
// Published chips in the provenance tables (round 5): verified-published
// semantics shared with the skill cards.
// ---------------------------------------------------------------------------

// Table row fake matching buildAgentViewSkillsTableHtml's stamped attributes;
// the chips host is what applyAgentViewSkillStatuses rewrites.
function makeSkillTableRow({
  skill,
  source,
  solution = "",
  marketplaceName = "",
  marketplaceId = "",
}) {
  const chips = new FakeElement("chips");
  const row = new FakeElement("row");
  row.attributes["data-skill"] = skill;
  row.attributes["data-skill-source"] = source;
  row.attributes["data-skill-solution"] = solution;
  row.attributes["data-skill-marketplace-name"] = marketplaceName;
  row.attributes["data-skill-marketplace-id"] = marketplaceId;
  row.querySelector = (selector) =>
    selector === ".agents-publish-skill-chips" ? chips : null;
  return { row, chips };
}

function skillTableRoot(rows, statusCells = []) {
  return {
    querySelectorAll: (selector) => {
      if (selector.includes("agents-publish-skill-row")) return rows.map((r) => r.row);
      if (selector.includes("data-skill-status")) return statusCells;
      return [];
    },
  };
}

test("verified-published skills gain a Published chip in the provenance tables, in facet order", async () => {
  const harness = loadFreshnessHarness();
  const hooks = harness.window.AgentsTabRenderHooks;
  // The user links "my-notes" to sol-notes and owns the listing behind the
  // installed algorithmic-art copy; trino's listing is not viewer-published.
  harness.fixture.skillLinks = {
    "my-notes": { solutionId: "sol-notes", hasLocalChanges: false },
  };
  harness.fixture.publishedSkillSolutions = [{ id: "sol-notes" }, { id: "sol-art" }];

  await hooks.loadSkillFreshnessSnapshot();
  // Published chips are network-phase data; the local-first snapshot fills
  // them in once the background refresh settles. Within the TTL the loader
  // returns the refreshed snapshot.
  await settleBackground();
  const snapshot = await hooks.loadSkillFreshnessSnapshot();
  assert.equal(snapshot.linksByName["my-notes"].solutionId, "sol-notes");
  assert.equal(snapshot.publishedSolutionIds.has("sol-notes"), true);
  assert.equal(snapshot.publishedSolutionIds.has("sol-art"), true);

  const userRow = makeSkillTableRow({ skill: "my-notes", source: "user" });
  const systemRow = makeSkillTableRow({ skill: "web-search", source: "system" });
  const ownedInstalledRow = makeSkillTableRow({
    skill: "algorithmic-art",
    source: "marketplace",
    solution: "sol-art",
    marketplaceName: "anthropic-agent-skills",
    marketplaceId: "anthropic-agent-skills",
  });
  const foreignInstalledRow = makeSkillTableRow({
    skill: "trino-query-writing",
    source: "marketplace",
    solution: "sol-trino",
    marketplaceName: "data-plat-skills",
    marketplaceId: "data-plat-skills",
  });
  const solutionsInstalledRow = makeSkillTableRow({
    skill: "joke-setup-generator",
    source: "marketplace",
    solution: "sol-joke",
    marketplaceName: "Solutions Marketplace",
    marketplaceId: "ai-marketplace",
  });
  const rows = [
    userRow,
    systemRow,
    ownedInstalledRow,
    foreignInstalledRow,
    solutionsInstalledRow,
  ];

  await hooks.applyAgentViewSkillStatuses(skillTableRoot(rows), null);

  // User skill: User chip first, then Published (facet order), with the
  // linked solution id surfaced in the tooltip.
  assert.match(userRow.chips.innerHTML, /badge-user[\s\S]*badge-published/);
  assert.match(userRow.chips.innerHTML, /Linked to AI Marketplace solution sol-notes/);
  // Unlinked system skill: no Published chip.
  assert.doesNotMatch(systemRow.chips.innerHTML, /badge-published/);
  // Owned installed copy from a git marketplace: Published, then GIT, then
  // the marketplace name — the patcher re-render preserves the GIT chip (it
  // reads the stamped data-skill-marketplace-id back off the row) and must
  // not resurrect the Installed chip these tables moved to the Note column.
  assert.match(
    ownedInstalledRow.chips.innerHTML,
    /badge-published[\s\S]*badge-git[\s\S]*badge-marketplace-name/,
  );
  assert.doesNotMatch(ownedInstalledRow.chips.innerHTML, /badge-installed/);
  // Installed copy of someone else's git listing: GIT + name, never
  // Published, and no Installed chip after the patch either.
  assert.doesNotMatch(foreignInstalledRow.chips.innerHTML, /badge-published/);
  assert.match(
    foreignInstalledRow.chips.innerHTML,
    /badge-git[\s\S]*badge-marketplace-name/,
  );
  assert.doesNotMatch(foreignInstalledRow.chips.innerHTML, /badge-installed/);
  // Solutions Marketplace installs are NOT git-based — no GIT chip, just the
  // marketplace name.
  assert.doesNotMatch(solutionsInstalledRow.chips.innerHTML, /badge-git/);
  assert.doesNotMatch(solutionsInstalledRow.chips.innerHTML, /badge-installed/);
  assert.match(
    solutionsInstalledRow.chips.innerHTML,
    /badge-marketplace-name"[^>]*>Solutions Marketplace</,
  );
});

test("a stale link to a dead listing never reads as Published in the tables", async () => {
  const harness = loadFreshnessHarness();
  const hooks = harness.window.AgentsTabRenderHooks;
  // Link present, but the listing is gone from the viewer's published set —
  // the same verification the skill cards apply.
  harness.fixture.skillLinks = {
    "my-notes": { solutionId: "sol-notes", hasLocalChanges: false },
  };
  harness.fixture.publishedSkillSolutions = [];

  const userRow = makeSkillTableRow({ skill: "my-notes", source: "user" });
  await hooks.applyAgentViewSkillStatuses(skillTableRoot([userRow]), null);
  assert.doesNotMatch(userRow.chips.innerHTML, /badge-published/);
  assert.match(userRow.chips.innerHTML, /badge-user/, "the source chip still renders");
});

test("published-listings lookup failures degrade to no Published chips without breaking the snapshot", async () => {
  const harness = loadFreshnessHarness();
  const hooks = harness.window.AgentsTabRenderHooks;
  harness.fixture.skillLinks = {
    "my-notes": { solutionId: "sol-notes", hasLocalChanges: false },
  };
  harness.fixture.listPublishedImpl = async () => {
    throw new Error("marketplace offline");
  };

  const snapshot = await hooks.loadSkillFreshnessSnapshot();
  assert.ok(snapshot, "the freshness snapshot still resolves");
  assert.ok(snapshot.bySkill.get("my-notes"), "status entries are intact");
  assert.equal(snapshot.publishedSolutionIds.size, 0);

  const userRow = makeSkillTableRow({ skill: "my-notes", source: "user" });
  const statusCell = new FakeElement("cell");
  statusCell.attributes["data-skill-status"] = "my-notes";
  statusCell.dataset.status = "working";
  await hooks.applyAgentViewSkillStatuses(skillTableRoot([userRow], [statusCell]), null);
  assert.doesNotMatch(userRow.chips.innerHTML, /badge-published/);
  assert.equal(statusCell.dataset.status, "current", "status stamping is unaffected");
});

test("table rows stamp the provenance attributes the chip patcher reads", () => {
  const { window } = loadFreshnessHarness();
  const hooks = window.AgentsTabRenderHooks;
  const html = hooks.buildAgentViewSkillsTableHtml([
    {
      canonicalName: "my-notes",
      label: "My Notes",
      source: "user",
      marketplaceName: "",
      marketplaceSolutionId: "",
      missing: false,
    },
    {
      canonicalName: "algorithmic-art",
      label: "Algorithmic Art",
      source: "marketplace",
      marketplaceName: "anthropic-agent-skills",
      marketplaceId: "anthropic-agent-skills",
      marketplaceSolutionId: "sol-art",
      missing: false,
    },
    {
      canonicalName: "joke-setup-generator",
      label: "Joke Setup Generator",
      source: "marketplace",
      marketplaceName: "Solutions Marketplace",
      marketplaceId: "ai-marketplace",
      marketplaceSolutionId: "sol-joke",
      missing: false,
    },
    {
      canonicalName: "gone-skill",
      label: "Gone Skill",
      source: "",
      marketplaceName: "",
      marketplaceSolutionId: "",
      missing: true,
    },
    {
      canonicalName: "absent-solution-skill",
      label: "Absent Solution Skill",
      source: "",
      marketplaceName: "",
      marketplaceSolutionId: "",
      missing: true,
      refKind: "solution",
    },
    {
      canonicalName: "absent-git-skill",
      label: "Absent Git Skill",
      source: "",
      marketplaceName: "",
      marketplaceSolutionId: "",
      missing: true,
      refKind: "git-marketplace",
      refMarketplaceName: "team-skills",
    },
  ]);
  assert.match(html, /data-skill="my-notes" data-skill-source="user" data-skill-solution=""/);
  assert.match(
    html,
    /data-skill="algorithmic-art" data-skill-source="marketplace" data-skill-solution="sol-art" data-skill-marketplace-name="anthropic-agent-skills" data-skill-marketplace-id="anthropic-agent-skills"/,
  );
  // Git-marketplace rows carry the GIT chip from first render; Solutions
  // Marketplace installs (marketplace_id "ai-marketplace") never do. The
  // Installed chip stays out of these tables — installed-ness reads from the
  // Note column instead.
  const artRowHtml = html.slice(html.indexOf('data-skill="algorithmic-art"'), html.indexOf('data-skill="joke-setup-generator"'));
  const jokeRowHtml = html.slice(html.indexOf('data-skill="joke-setup-generator"'), html.indexOf('data-skill="gone-skill"'));
  assert.match(artRowHtml, /badge-git[\s\S]*badge-marketplace-name/);
  assert.doesNotMatch(artRowHtml, /badge-installed/);
  assert.match(artRowHtml, /agents-publish-skill-note[\s\S]*Already installed on this computer\./);
  assert.doesNotMatch(jokeRowHtml, /badge-git/);
  assert.doesNotMatch(jokeRowHtml, /badge-installed/);
  assert.match(jokeRowHtml, /agents-publish-skill-note[\s\S]*Already installed on this computer\./);
  // Non-marketplace sources keep the quiet dash note.
  const notesRowHtml = html.slice(html.indexOf('data-skill="my-notes"'), html.indexOf("</tr>", html.indexOf('data-skill="my-notes"')));
  assert.match(notesRowHtml, /agents-publish-skill-note"><span class="agent-details-empty">—</);
  // Missing rows advertise no source so the patcher leaves their
  // ref-derived Source chips and "Not on this computer" note alone.
  assert.match(html, /data-skill="gone-skill" data-skill-source=""/);
  assert.match(html, /Not on this computer/);
  const missingRow = (name) => {
    const start = html.indexOf(`data-skill="${name}"`);
    assert.ok(start >= 0, `row ${name} present`);
    return html.slice(start, html.indexOf("</tr>", start));
  };
  // Ref provenance still badges skills that are not on this computer; the
  // caveat lives in the Note column, and no-ref rows fall back to a dash.
  assert.match(
    missingRow("absent-solution-skill"),
    /badge-marketplace-name">Solutions Marketplace</,
  );
  assert.match(
    missingRow("absent-git-skill"),
    /badge-git[\s\S]*badge-marketplace-name"[^>]*>team-skills</,
  );
  assert.match(
    missingRow("gone-skill"),
    /agents-publish-skill-chips"><span class="agent-details-empty">—</,
  );
  for (const name of ["gone-skill", "absent-solution-skill", "absent-git-skill"]) {
    assert.match(missingRow(name), /agents-publish-skill-note[\s\S]*Not on this computer/);
  }
  // Initial render never shows Published — the chip only appears once the
  // snapshot verifies the listing.
  assert.doesNotMatch(html, /badge-published/);
});

test("duplicate leaves across plugins resolve exact-first: FQN ids read their own copy's state", async () => {
  const { window, fixture, clock } = loadFreshnessHarness();
  fixture.skills = [
    {
      name: "kwp/plugin-a/android",
      display_name: "Android A",
      source: "marketplace",
      marketplace_id: "kwp",
      marketplace_name: "kwp",
      plugin_name: "plugin-a",
      has_update: true,
      has_conflict: false,
    },
    {
      name: "kwp/plugin-b/android",
      display_name: "Android B",
      source: "marketplace",
      marketplace_id: "kwp",
      marketplace_name: "kwp",
      plugin_name: "plugin-b",
      has_update: false,
      has_conflict: false,
    },
  ];
  const hooks = window.AgentsTabRenderHooks;
  await hooks.loadSkillFreshnessSnapshot();

  // The agent pinned to plugin-a's copy sees ITS update...
  const flaggedAgent = { id: "agent-a", skill_ids: ["kwp/plugin-a/android"] };
  const flagged = hooks.agentSkillFreshnessFor(flaggedAgent);
  assert.equal(flagged.status, "ready");
  assert.deepEqual(JSON.parse(JSON.stringify(flagged.updates)), ["android"]);
  assert.equal(hooks.agentHasSkillUpdates(flaggedAgent), true);

  // ...while the agent on plugin-b's copy stays current even though the
  // canonical-leaf map would have collided.
  clock.now += 1; // distinct per-agent cache entries
  const currentAgent = { id: "agent-b", skill_ids: ["kwp/plugin-b/android"] };
  const current = hooks.agentSkillFreshnessFor(currentAgent);
  assert.equal(current.status, "ready");
  assert.deepEqual(JSON.parse(JSON.stringify(current.updates)), []);
  assert.equal(hooks.agentHasSkillUpdates(currentAgent), false);
});

// ---------------------------------------------------------------------------
// Local-first contract (2026-08-14: a marketplace availability blip held the
// status spinners hostage for 19-84s because the snapshot awaited the full
// network sweep before serving persisted flags).
// ---------------------------------------------------------------------------

test("statuses resolve from persisted flags even when the sweep never returns", async () => {
  const { window, calls, fixture } = loadFreshnessHarness();
  const hooks = window.AgentsTabRenderHooks;
  // A sweep stuck mid-marketplace-outage: never resolves.
  fixture.checkImpl = () => new Promise(() => {});

  const snapshot = await hooks.loadSkillFreshnessSnapshot();
  assert.ok(snapshot, "snapshot resolves without waiting for the sweep");
  assert.equal(
    hooks.skillFreshnessStatusFor(snapshot.bySkill.get("algorithmic-art")),
    "update",
    "persisted has_update flags drive statuses immediately",
  );
  assert.equal(calls.filter(([n]) => n === "checkSkillUpdates").length, 1);
  assert.equal(
    calls.filter(([n]) => n === "getSkills").length,
    1,
    "the refresh getSkills waits on the sweep; the local one already served",
  );
});

test("a failing network phase keeps the local snapshot instead of nulling it", async () => {
  const { window, fixture } = loadFreshnessHarness();
  const hooks = window.AgentsTabRenderHooks;
  fixture.checkImpl = async () => {
    throw new Error("marketplace 502");
  };
  fixture.listPublishedImpl = async () => {
    throw new Error("marketplace 502");
  };

  const snapshot = await hooks.loadSkillFreshnessSnapshot();
  await settleBackground();
  const after = await hooks.loadSkillFreshnessSnapshot();
  assert.ok(after, "local snapshot survives a failed network phase");
  assert.equal(
    hooks.skillFreshnessStatusFor(after.bySkill.get("algorithmic-art")),
    "update",
  );
  assert.ok(snapshot.bySkill.size > 0);
});
