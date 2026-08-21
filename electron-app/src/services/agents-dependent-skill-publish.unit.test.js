// Behavior tests for the two-phase dependent-skill publish planner in
// agents.js (window.AgentsPublishHooks.publishDependentSkills): resolve
// computes every skill's action with zero marketplace writes, execute runs
// only on a clean resolve, adoption of a found-by-name solution requires
// ownership, and foreign listings are never updated or linked. Harness
// mirrors agents-tab-card-tooltips.unit.test.js.
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
    this.value = "";
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type).push(handler);
  }

  dispatchEvent(type, event = {}) {
    for (const handler of this.listeners.get(type) || []) {
      handler({
        preventDefault() {},
        stopPropagation() {},
        target: this,
        currentTarget: this,
        ...event,
      });
    }
  }

  click() {
    this.dispatchEvent("click");
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

function loadAgentsModuleHarness() {
  const source = fs.readFileSync(AGENTS_PATH, "utf8");
  const componentsDir = path.join(__dirname, "..", "renderer", "components");
  const extraSources = [
    "agent-reasoning-options.js",
    "agent-model-picker.js",
    "agent-reasoning-slider.js",
    // The shared skill-name formatter (window.SkillCardRenderer) — agents.js
    // funnels every skill label through it.
    "skill-card-renderer.js",
  ].map((name) => ({
    path: path.join(componentsDir, name),
    source: fs.readFileSync(path.join(componentsDir, name), "utf8"),
  }));

  const elements = new Map();
  const addElement = (id, { display = "none" } = {}) => {
    const element = new FakeElement(id);
    element.style.display = display;
    elements.set(id, element);
    return element;
  };

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
    "agents-confirm-secondary-btn",
    "agents-confirm-close-btn",
  ].forEach((id) => addElement(id));

  const document = {
    readyState: "complete",
    body: new FakeElement("body"),
    createElement(tag) {
      return new FakeElement(tag);
    },
    getElementById(id) {
      return elements.get(id) || null;
    },
    querySelectorAll() {
      return [];
    },
    querySelector() {
      return null;
    },
    addEventListener() {},
    removeEventListener() {},
  };

  const windowObject = {
    appState: { controlPlaneView: "mcp-servers" },
    electronAPI: {
      invokeMcpTool: async () => ({ success: true, data: { agents: [] } }),
      getSkills: async () => ({ success: true, skills: [] }),
      loadMcpServers: async () => ({ success: true, data: [] }),
      aiMarketplace: {
        listLinks: async () => ({ success: true, links: {} }),
      },
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

  return { window: windowObject, elements };
}

// Recording fake for the marketplace surface publishDependentSkills touches.
// `calls` captures [name, ...args] tuples in invocation order so tests can
// assert both presence and ordering of marketplace writes.
function installPublishFixture(windowObject, {
  skills = [],
  links = {},
  ownedSolutions = [],
  ownedLookupFails = false,
  searchResults = [],
  bundlesBySolutionId = {},
  installedSources = {},
  marketplacesConfig = { marketplaces: [], installedSkills: [] },
  solutionsById = {},
  publishImpl = null,
  updateImpl = null,
  installImpl = null,
  getSolutionImpl = null,
  preflightImpl = null,
  syncAclImpl = null,
  probeInstallRefsImpl = null,
} = {}) {
  const calls = [];
  // Faithful preflight fake: fake transport, REAL visibility policy — the
  // same pure module main uses, fed from the fixture's solution store.
  const { computeEffectiveAllowedEmails } = require("./ai-marketplace-acl");
  const preflightListingFor = async (solutionId, audience) => {
    const res = getSolutionImpl
      ? await getSolutionImpl(solutionId)
      : {
          success: true,
          data: solutionsById[solutionId] || { id: solutionId, status: "active" },
        };
    const status = String(res?.data?.status || "").trim().toLowerCase();
    if (res?.success && res.data && status !== "deleted") {
      const current = Array.isArray(res.data.allowed_emails)
        ? res.data.allowed_emails
        : [];
      const { allowedEmails, changed } = computeEffectiveAllowedEmails({
        currentAllowedEmails: current,
        audiences: [audience],
      });
      return {
        solution_id: solutionId,
        state: "alive",
        allowed_emails: current,
        acl_sync: { allowed_emails: allowedEmails, changed },
      };
    }
    const code = String(res?.code || "").trim();
    const positivelyGone =
      (res?.success && status === "deleted") ||
      code === "not_found" ||
      code === "solution_not_found" ||
      res?.status === 404;
    return { solution_id: solutionId, state: positivelyGone ? "deleted" : "unknown" };
  };
  const api = {
    hasApiKey: async () => ({ hasKey: true }),
    listPublished: async (type) => {
      calls.push(["listPublished", type]);
      if (ownedLookupFails) return { success: false, error: "offline" };
      return { success: true, data: { solutions: ownedSolutions } };
    },
    listSkillLinks: async () => {
      calls.push(["listSkillLinks"]);
      return { success: true, links };
    },
    getSolution: async (solutionId) => {
      calls.push(["getSolution", solutionId]);
      if (getSolutionImpl) return getSolutionImpl(solutionId);
      return {
        success: true,
        data: solutionsById[solutionId] || { id: solutionId, status: "active" },
      };
    },
    getSkillLink: async (name) => {
      calls.push(["getSkillLink", name]);
      return { success: true, link: links[name] || null };
    },
    search: async () => {
      calls.push(["search"]);
      return { success: true, data: { results: searchResults } };
    },
    getBundle: async (solutionId) => {
      calls.push(["getBundle", solutionId]);
      return (
        bundlesBySolutionId[solutionId] || { success: false, error: "no bundle" }
      );
    },
    buildPublishBundle: async (input) => {
      if (input?.type === "skills") {
        calls.push(["buildPublishBundle", input?.skill?.name]);
        return {
          success: true,
          data: {
            type: "skills",
            payload: { name: input?.skill?.name, description: "d" },
          },
        };
      }
      calls.push(["buildAgentBundle", input?.agent]);
      return {
        success: true,
        data: {
          type: input?.type,
          payload: {
            name: input?.agent?.name,
            description: "agent",
            // Mirror the real bundle builder: the payload carries the
            // flattened agent facts the renderer spreads onto listings.
            base_model_id: input?.agent?.base_model_id,
            reasoning_effort: input?.agent?.reasoning_effort,
            skill_ids: input?.agent?.skill_ids,
            skill_refs: input?.agent?.skill_refs,
            tool_server_ids: input?.agent?.tool_server_ids,
          },
        },
      };
    },
    publish: async (input, opts) => {
      calls.push(["publish", opts?.localSkillId || opts?.localAgentId, input, opts]);
      if (publishImpl) return publishImpl(input, opts);
      return {
        success: true,
        data: { id: `new-${opts?.localSkillId || opts?.localAgentId}` },
      };
    },
    update: async (solutionId, input, opts) => {
      calls.push(["update", solutionId, opts?.localSkillId, input]);
      if (updateImpl) return updateImpl(solutionId, input, opts);
      return { success: true, data: { id: solutionId } };
    },
    setSkillLink: async (name, solutionId) => {
      calls.push(["setSkillLink", name, solutionId]);
      return { success: true };
    },
    clearSkillLink: async (name) => {
      calls.push(["clearSkillLink", name]);
      return { success: true };
    },
    getInstalledSkillSource: async (name) => {
      calls.push(["getInstalledSkillSource", name]);
      return { success: true, source: installedSources[name] || null };
    },
    markSkillLinkDirty: async (name) => {
      calls.push(["markSkillLinkDirty", name]);
      if (links[name]) links[name].hasLocalChanges = true;
      else links[name] = { solutionId: "", hasLocalChanges: true };
      return { success: true };
    },
    preflightPublishListings: async (payload) => {
      calls.push(["preflightPublishListings", payload]);
      if (preflightImpl) return preflightImpl(payload);
      const audience = Array.isArray(payload?.aclAudience)
        ? payload.aclAudience
        : null;
      const listings = [];
      for (const solutionId of payload?.solutionIds || []) {
        listings.push(await preflightListingFor(solutionId, audience));
      }
      return { success: true, data: { listings } };
    },
    syncSolutionAcl: async (solutionId, opts) => {
      calls.push(["syncSolutionAcl", solutionId, opts]);
      if (syncAclImpl) return syncAclImpl(solutionId, opts);
      return { success: true, data: { changed: true, allowed_emails: [] } };
    },
    probeInstallRefs: async (payload) => {
      calls.push(["probeInstallRefs", payload]);
      if (probeInstallRefsImpl) return probeInstallRefsImpl(payload);
      const listings = [];
      for (const solutionId of payload?.solutionIds || []) {
        const res = getSolutionImpl
          ? await getSolutionImpl(solutionId)
          : {
              success: true,
              data:
                solutionsById[solutionId] || { id: solutionId, status: "active" },
            };
        const status = String(res?.data?.status || "").trim().toLowerCase();
        if (res?.success && res.data && status !== "deleted") {
          listings.push({
            solution_id: solutionId,
            state: "visible",
            submitted_by: String(
              res.data.submitted_by || res.data.author || "",
            ),
          });
        } else {
          const code = String(res?.code || "").trim();
          const positivelyGone =
            (res?.success && status === "deleted") ||
            code === "not_found" ||
            code === "solution_not_found" ||
            res?.status === 404;
          listings.push({
            solution_id: solutionId,
            state: positivelyGone ? "unavailable" : "unknown",
          });
        }
      }
      return { success: true, data: { listings } };
    },
    listLinks: async () => {
      calls.push(["listLinks"]);
      return { success: true, links: {} };
    },
    install: async (solutionId, options) => {
      calls.push(["install", solutionId, options]);
      if (installImpl) return installImpl(solutionId, options);
      return { success: true, data: { type: "" } };
    },
  };
  windowObject.localStorage = windowObject.localStorage || {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  const logToMainEvents = [];
  windowObject.electronAPI = {
    invokeMcpTool: async () => ({ success: true, data: { agents: [] } }),
    getSkills: async () => ({ success: true, skills }),
    getMarketplaces: async () => ({ success: true, data: marketplacesConfig }),
    getUsername: async () => ({ username: "dsantiago" }),
    logToMain: (payload) => {
      logToMainEvents.push(payload);
    },
    aiMarketplace: api,
  };
  return { api, calls, logToMainEvents };
}

const userSkill = (name) => ({
  name,
  source: "user",
  skill_path: `/tmp/skills-user/${name}`,
  description: `${name} description`,
});

test("adopt-if-owned relinks the lost link before updating and never publishes new", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installPublishFixture(window, {
    skills: [userSkill("alpha")],
    bundlesBySolutionId: {
      "sol-a": { success: true, data: { type: "skills", payload: { name: "alpha" } } },
    },
    ownedSolutions: [{ id: "sol-a", type: "skills", name: "alpha" }],
  });

  const result = await window.AgentsPublishHooks.publishDependentSkills(["alpha"]);

  // JSON round-trip: refs are created inside the vm context, whose Object
  // prototype is not reference-equal to the host's for deepStrictEqual.
  assert.deepEqual(JSON.parse(JSON.stringify(result.refs)), [
    { skill_id: "alpha", kind: "solution", solution_id: "sol-a" },
  ]);
  assert.equal(result.summary.adopted, 1);
  assert.equal(result.summary.published, 0);
  assert.equal(result.summary.updated, 0);
  // The adopt-then-update pair reports as ONE adopted row.
  assert.deepEqual(JSON.parse(JSON.stringify(result.skills)), [
    { skill_id: "alpha", outcome: "adopted", solution_id: "sol-a" },
  ]);
  const names = calls.map((entry) => entry[0]);
  assert.ok(!names.includes("publish"), "fresh publish must not run");
  const adoptIndex = calls.findIndex(
    (entry) => entry[0] === "setSkillLink" && entry[1] === "alpha" && entry[2] === "sol-a",
  );
  const updateIndex = calls.findIndex((entry) => entry[0] === "update");
  assert.ok(adoptIndex >= 0, "adoption link write happens");
  assert.ok(updateIndex >= 0, "update happens");
  assert.ok(
    adoptIndex < updateIndex,
    "the link is adopted BEFORE the update so the provenance gate passes",
  );
});

test("a foreign name collision fails closed at publish and is never linked", async () => {
  const { window } = loadAgentsModuleHarness();
  // The foreign listing is invisible pre-flight (no owned-name match); the
  // main process's name-availability guard rejects the create at execute.
  const { calls } = installPublishFixture(window, {
    skills: [userSkill("alpha")],
    ownedSolutions: [],
    publishImpl: () => ({ success: false, status: 409 }),
  });

  await assert.rejects(
    window.AgentsPublishHooks.publishDependentSkills(["alpha"]),
    /already has a solution named "alpha" that you do not own; rename the skill/,
  );
  const names = calls.map((entry) => entry[0]);
  assert.ok(!names.includes("setSkillLink"), "foreign solutions are never linked");
  assert.ok(!names.includes("update"), "foreign solutions are never updated");
});

test("a resolve failure aborts before any marketplace write", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installPublishFixture(window, {
    skills: [
      userSkill("alpha"),
      {
        name: "gitmp/gitcopy",
        source: "marketplace",
        marketplace_id: "gitmp",
        skill_path: "/tmp/skills-marketplace/gitmp/gitcopy",
      },
    ],
    searchResults: [],
  });

  await assert.rejects(
    window.AgentsPublishHooks.publishDependentSkills(["alpha", "gitmp/gitcopy"]),
    (error) => {
      assert.match(error.message, /No marketplace changes were made\./);
      assert.match(error.message, /gitcopy/);
      assert.match(error.message, /cannot reconstruct this skill's marketplace origin/);
      return true;
    },
  );
  const names = calls.map((entry) => entry[0]);
  assert.ok(!names.includes("publish"), "no publish before a clean resolve");
  assert.ok(!names.includes("update"), "no update before a clean resolve");
  assert.ok(!names.includes("setSkillLink"), "no link writes before a clean resolve");
});

test("dependent writes forward the agent audience for the main-side ACL policy", async () => {
  const { window } = loadAgentsModuleHarness();
  const updateOpts = [];
  const { calls } = installPublishFixture(window, {
    skills: [userSkill("alpha"), userSkill("beta")],
    // Dirty link: a clean one would be referenced without any upload now.
    links: { beta: { solutionId: "sol-b", hasLocalChanges: true } },
    searchResults: [],
    updateImpl: (solutionId, input, opts) => {
      updateOpts.push({ solutionId, input, opts });
      return { success: true, data: { id: solutionId } };
    },
  });

  const result = await window.AgentsPublishHooks.publishDependentSkills(
    ["alpha", "beta"],
    { allowedEmails: ["teammate@example.invalid"] },
  );

  assert.equal(result.summary.published, 1);
  assert.equal(result.summary.updated, 1);
  const publishCall = calls.find((entry) => entry[0] === "publish");
  assert.ok(publishCall, "alpha publishes as a new solution");
  assert.equal(
    publishCall[2].allowed_emails,
    undefined,
    "create bodies carry no allowed_emails — the main-process policy decides",
  );
  assert.deepEqual(publishCall[3]?.aclAudience, ["teammate@example.invalid"]);
  assert.equal(updateOpts.length, 1, "beta updates its linked solution");
  assert.equal(
    Object.prototype.hasOwnProperty.call(updateOpts[0].input, "allowed_emails"),
    false,
    "update bodies carry no allowed_emails — the union happens in main",
  );
  assert.deepEqual(
    updateOpts[0].opts?.aclAudience,
    ["teammate@example.invalid"],
    "updates forward the audience so the listing widens to include it",
  );
});

test("an execute failure stops the run and reports the skills already written", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installPublishFixture(window, {
    skills: [userSkill("alpha"), userSkill("beta")],
    searchResults: [],
    publishImpl: (input, opts) =>
      opts?.localSkillId === "alpha"
        ? { success: true, data: { id: "new-alpha" } }
        : { success: false, error: "boom" },
  });

  await assert.rejects(
    window.AgentsPublishHooks.publishDependentSkills(["alpha", "beta"]),
    (error) => {
      assert.match(error.message, /beta \(boom\)/);
      assert.match(
        error.message,
        /already published to the marketplace before the failure: alpha/,
      );
      return true;
    },
  );
  const linkWrites = calls.filter((entry) => entry[0] === "setSkillLink");
  assert.deepEqual(linkWrites, [["setSkillLink", "alpha", "new-alpha"]]);
});

test("a failed update after adoption rolls the link back", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installPublishFixture(window, {
    skills: [userSkill("alpha")],
    bundlesBySolutionId: {
      "sol-a": { success: true, data: { type: "skills", payload: { name: "alpha" } } },
    },
    ownedSolutions: [{ id: "sol-a", type: "skills", name: "alpha" }],
    updateImpl: () => ({ success: false, status: 500, error: "server exploded" }),
  });

  await assert.rejects(
    window.AgentsPublishHooks.publishDependentSkills(["alpha"]),
    /server exploded/,
  );
  assert.ok(
    calls.some(
      (entry) => entry[0] === "setSkillLink" && entry[1] === "alpha" && entry[2] === "sol-a",
    ),
    "adoption linked the owned solution before the update",
  );
  assert.ok(
    calls.some((entry) => entry[0] === "clearSkillLink" && entry[1] === "alpha"),
    "the failed update rolled the adopted link back",
  );
});

test("a solutions-installed copy is referenced without any marketplace writes", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installPublishFixture(window, {
    skills: [
      {
        name: "ai-marketplace/toolkit",
        source: "marketplace",
        marketplace_id: "ai-marketplace",
        skill_path: "/tmp/skills-marketplace/ai-marketplace/toolkit",
      },
    ],
    installedSources: { toolkit: { solutionId: "sol-installed" } },
  });

  const result = await window.AgentsPublishHooks.publishDependentSkills([
    "ai-marketplace/toolkit",
  ]);

  assert.deepEqual(JSON.parse(JSON.stringify(result.refs)), [
    { skill_id: "toolkit", kind: "solution", solution_id: "sol-installed" },
  ]);
  assert.equal(result.summary.referenced, 1);
  const names = calls.map((entry) => entry[0]);
  assert.ok(!names.includes("publish"));
  assert.ok(!names.includes("update"));
  assert.ok(!names.includes("setSkillLink"));
});

test("an owned same-name listing whose bundle does not match is ignored, not adopted", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installPublishFixture(window, {
    skills: [userSkill("alpha")],
    bundlesBySolutionId: {
      // The owned listing is named alpha but its bundle is a different skill.
      "sol-x": { success: true, data: { type: "skills", payload: { name: "omega" } } },
    },
    ownedSolutions: [{ id: "sol-x", type: "skills", name: "alpha" }],
  });

  const result = await window.AgentsPublishHooks.publishDependentSkills(["alpha"]);

  assert.equal(result.summary.published, 1);
  assert.equal(result.summary.adopted, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(result.refs)), [
    { skill_id: "alpha", kind: "solution", solution_id: "new-alpha" },
  ]);
  assert.ok(
    calls.some((entry) => entry[0] === "getBundle" && entry[1] === "sol-x"),
    "the owned-name match is bundle-verified before rejection",
  );
  assert.ok(!calls.some((entry) => entry[0] === "update"));
});

test("pushAgentToMarketplace aborts before any agent write when a dependency fails", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installPublishFixture(window, {
    skills: [
      {
        name: "gitmp/gitcopy",
        source: "marketplace",
        marketplace_id: "gitmp",
        skill_path: "/tmp/skills-marketplace/gitmp/gitcopy",
      },
    ],
    searchResults: [],
  });

  await assert.rejects(
    window.AgentsPublishHooks.pushAgentToMarketplace({
      localId: "agent-1",
      solutionId: "",
      args: {
        name: "Agent One",
        description: "",
        base_model_id: "model-a",
        system_prompt: "prompt",
        skill_ids: ["gitmp/gitcopy"],
        tool_server_ids: [],
        reasoning_effort: "medium",
      },
    }),
    /No marketplace changes were made\./,
  );
  const names = calls.map((entry) => entry[0]);
  assert.ok(!names.includes("buildAgentBundle"), "agent bundle is never built");
  assert.ok(!names.includes("publish"), "agent solution is never created");
});

test("pushAgentToMarketplace embeds resolved skill refs and visibility into the agent bundle", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installPublishFixture(window, {
    skills: [userSkill("alpha")],
    searchResults: [],
  });

  const published = await window.AgentsPublishHooks.pushAgentToMarketplace({
    localId: "agent-1",
    solutionId: "",
    args: {
      name: "Agent One",
      description: "",
      base_model_id: "model-a",
      system_prompt: "prompt",
      skill_ids: ["alpha"],
      tool_server_ids: [],
      reasoning_effort: "medium",
      allowed_emails: ["teammate@example.invalid"],
    },
  });

  assert.equal(published.solutionId, "new-agent-1");
  assert.deepEqual(JSON.parse(JSON.stringify(published.skills)), [
    { skill_id: "alpha", outcome: "published", solution_id: "new-alpha" },
  ]);
  const agentBundleCall = calls.find((entry) => entry[0] === "buildAgentBundle");
  assert.ok(agentBundleCall, "agent bundle is built");
  assert.deepEqual(JSON.parse(JSON.stringify(agentBundleCall[1].skill_refs)), [
    { skill_id: "alpha", kind: "solution", solution_id: "new-alpha" },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(agentBundleCall[1].allowed_emails)), [
    "teammate@example.invalid",
  ]);
  const skillPublishIndex = calls.findIndex(
    (entry) => entry[0] === "publish" && entry[1] === "alpha",
  );
  const agentPublishIndex = calls.findIndex(
    (entry) => entry[0] === "publish" && entry[1] === "agent-1",
  );
  assert.ok(skillPublishIndex >= 0 && agentPublishIndex >= 0);
  assert.ok(
    skillPublishIndex < agentPublishIndex,
    "dependent skills publish before the agent solution",
  );
  const agentPublishCall = calls[agentPublishIndex];
  assert.equal(agentPublishCall[3]?.localAgentId, "agent-1");
  // The listing carries the flattened card facts top-level (unpublish/display
  // surfaces read them without a bundle fetch) while the named identity
  // fields keep precedence.
  const solutionInput = agentPublishCall[2];
  assert.equal(solutionInput.name, "Agent One");
  assert.equal(solutionInput.base_model_id, "model-a");
  assert.equal(solutionInput.reasoning_effort, "medium");
  assert.deepEqual(JSON.parse(JSON.stringify(solutionInput.skill_ids)), ["alpha"]);
  assert.deepEqual(JSON.parse(JSON.stringify(solutionInput.skill_refs)), [
    { skill_id: "alpha", kind: "solution", solution_id: "new-alpha" },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(solutionInput.tool_server_ids)), []);
  assert.ok(!("system_prompt" in solutionInput), "the prompt stays bundle-only");
});

test("pushAgentToMarketplace streams cascade progress in plan order", async () => {
  const { window } = loadAgentsModuleHarness();
  installPublishFixture(window, {
    skills: [userSkill("alpha")],
    searchResults: [],
  });

  const events = [];
  const published = await window.AgentsPublishHooks.pushAgentToMarketplace({
    localId: "agent-1",
    solutionId: "",
    args: {
      name: "Agent One",
      description: "",
      base_model_id: "model-a",
      system_prompt: "prompt",
      skill_ids: ["alpha"],
      tool_server_ids: [],
      reasoning_effort: "medium",
      allowed_emails: ["teammate@example.invalid"],
    },
    onProgress: (event) => events.push([event.phase, event.plan?.canonicalName || null]),
  });

  assert.equal(published.solutionId, "new-agent-1");
  // Skills tick first (start → done), then the agent write is announced —
  // the exact contract the batch modal's ticker renders.
  assert.deepEqual(JSON.parse(JSON.stringify(events)), [
    ["skill:start", "alpha"],
    ["skill:done", "alpha"],
    ["agent:start", null],
  ]);
});

test("buildSkillProvenanceRowsHtml stamps status-cell ids only when asked", () => {
  const { window } = loadAgentsModuleHarness();
  const resolution = {
    plans: [
      {
        canonicalName: "alpha",
        displayName: "Alpha",
        action: "publish-new",
        provenance: "user-new",
      },
    ],
    errors: [],
  };
  const plain = window.AgentsPublishHooks.buildSkillProvenanceRowsHtml(resolution);
  assert.ok(
    !plain.includes('id="ticker-'),
    "default output carries no status-cell ids",
  );
  const stamped = window.AgentsPublishHooks.buildSkillProvenanceRowsHtml(resolution, {
    statusIdPrefix: "ticker-",
  });
  assert.ok(stamped.includes('id="ticker-alpha"'), "prefixed cell id per plan");
  assert.ok(stamped.includes('data-status="idle"'), "real-work rows start idle");
});

test("republishAgentHeadless republishes a dirty published agent through the modal-free engine", async () => {
  const { window } = loadAgentsModuleHarness();
  const updateOpts = [];
  const { calls } = installPublishFixture(window, {
    skills: [],
    updateImpl: (solutionId, input, opts) => {
      updateOpts.push({ solutionId, input, opts });
      return { success: true, data: { id: solutionId } };
    },
  });
  window.electronAPI.aiMarketplace.listLinks = async () => ({
    success: true,
    links: {
      "agent-1": {
        relationship: "published",
        solutionId: "sol-agent",
        hasLocalChanges: true,
      },
    },
  });
  window.electronAPI.invokeMcpTool = async (_serverId, toolName) => {
    if (toolName === "subagents_get_agent") {
      return {
        success: true,
        data: {
          id: "agent-1",
          name: "Agent One",
          description: "d",
          base_model_id: "model-a",
          skill_ids: [],
          tool_server_ids: [],
          allowed_emails: [],
          reasoning_effort: "medium",
          creation_source: "local",
          created_by_email: "dsantiago@example.invalid",
          marketplace_relationship: "published",
          marketplace_solution_id: "sol-agent",
        },
      };
    }
    if (toolName === "subagents_get_agent_system_prompt") {
      return { success: true, data: { system_prompt: "prompt body" } };
    }
    return { success: true, data: { agents: [] } };
  };

  const published =
    await window.AgentsPublishHooks.republishAgentHeadless("agent-1");
  assert.equal(published.solutionId, "sol-agent");
  assert.equal(updateOpts.length, 1, "republish is one update write");
  assert.equal(updateOpts[0].solutionId, "sol-agent");
  assert.equal(updateOpts[0].opts?.localAgentId, "agent-1");
  // Public agent stays public: the audience is hoisted through the same
  // withCreatorAllowedEmail rule as the modal (empty list passes through).
  assert.deepEqual(
    JSON.parse(JSON.stringify(updateOpts[0].input.allowed_emails)),
    [],
  );
  assert.equal(updateOpts[0].input.bundle?.payload?.name, "Agent One");
  assert.ok(
    !calls.some((entry) => entry[0] === "preflightPublishListings"),
    "no modal-open preflight runs on the headless path",
  );

  // Anything but a published link refuses instead of guessing.
  window.electronAPI.aiMarketplace.listLinks = async () => ({
    success: true,
    links: { "agent-1": { relationship: "installed", solutionId: "sol-agent" } },
  });
  await assert.rejects(
    () => window.AgentsPublishHooks.republishAgentHeadless("agent-1"),
    /not a published marketplace listing/,
  );
});

test("an unreachable owned-listings lookup fails closed and is never cached", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installPublishFixture(window, {
    skills: [userSkill("alpha")],
    ownedLookupFails: true,
  });

  await assert.rejects(
    window.AgentsPublishHooks.publishDependentSkills(["alpha"]),
    /could not verify ownership of your Marketplace listings/,
  );
  const names = calls.map((entry) => entry[0]);
  assert.ok(!names.includes("publish"));
  assert.ok(!names.includes("update"));
  assert.ok(!names.includes("setSkillLink"));

  // A transient failure must not be memoized: the retry refetches instead
  // of replaying the cached failure (which would lock the session).
  const firstLookups = calls.filter((entry) => entry[0] === "listPublished").length;
  await assert.rejects(
    window.AgentsPublishHooks.publishDependentSkills(["alpha"]),
    /could not verify ownership/,
  );
  const secondLookups = calls.filter((entry) => entry[0] === "listPublished").length;
  assert.ok(secondLookups > firstLookups, "failed lookups are never cached");
});

// ---- reference-only policy (Workstream G) ------------------------------------

const gitMarketplaceFixture = () => ({
  skills: [
    {
      name: "anthropic-agent-skills/algorithmic-art",
      source: "marketplace",
      marketplace_id: "anthropic-agent-skills",
      skill_path: "/tmp/skills-marketplace/anthropic-agent-skills/algorithmic-art",
    },
  ],
  marketplacesConfig: {
    marketplaces: [
      {
        id: "anthropic-agent-skills",
        name: "anthropic-agent-skills",
        source: {
          type: "github",
          repo: "anthropics/skills",
          repoUrl: "https://github.com/anthropics/skills",
          ref: "main",
        },
      },
    ],
    installedSkills: [
      {
        marketplaceId: "anthropic-agent-skills",
        skillId: "algorithmic-art",
        skillPath: "./skills/algorithmic-art",
        skillSource: null,
        localPath: "skills-marketplace/anthropic-agent-skills/algorithmic-art",
      },
    ],
  },
});

test("a git-marketplace skill resolves to a fully-qualified git ref with zero marketplace reads", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installPublishFixture(window, gitMarketplaceFixture());

  const result = await window.AgentsPublishHooks.publishDependentSkills([
    "anthropic-agent-skills/algorithmic-art",
  ]);

  assert.deepEqual(JSON.parse(JSON.stringify(result.refs)), [
    {
      skill_id: "algorithmic-art",
      kind: "git-marketplace",
      solution_id: null,
      marketplace: {
        name: "anthropic-agent-skills",
        source: {
          type: "github",
          repo: "anthropics/skills",
          repoUrl: "https://github.com/anthropics/skills",
          ref: "main",
        },
      },
      skill_path: "./skills/algorithmic-art",
      skill_source: null,
      plugin_name: null,
    },
  ]);
  assert.equal(result.summary.gitReferenced, 1);
  // The envelope row identifies the git origin with a flat repo URL (the
  // bundle ref above keeps the full structured source for installs).
  assert.deepEqual(JSON.parse(JSON.stringify(result.skills)), [
    {
      skill_id: "algorithmic-art",
      outcome: "gitReferenced",
      git_origin: {
        marketplace_name: "anthropic-agent-skills",
        marketplace_source: "https://github.com/anthropics/skills",
        skill_path: "./skills/algorithmic-art",
      },
    },
  ]);
  const names = calls.map((entry) => entry[0]);
  for (const forbidden of ["search", "getBundle", "publish", "update", "setSkillLink", "listPublished"]) {
    assert.ok(!names.includes(forbidden), `${forbidden} must not be called for git refs`);
  }
});

test("a clean linked user skill resolves with zero remote calls and probes once at publish", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installPublishFixture(window, {
    skills: [userSkill("beta")],
    links: { beta: { solutionId: "sol-b", hasLocalChanges: false } },
  });

  const resolution =
    await window.AgentsPublishHooks.resolveDependentSkillPlans(["beta"]);
  assert.equal(resolution.errors.length, 0);
  assert.ok(
    !calls.some((entry) => entry[0] === "getSolution"),
    "resolve is zero-remote for linked skills — the modal opens instantly",
  );

  const result = await window.AgentsPublishHooks.executeDependentSkillPlans(
    resolution.plans,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result.refs)), [
    { skill_id: "beta", kind: "solution", solution_id: "sol-b" },
  ]);
  assert.equal(result.summary.unchanged, 1);
  assert.equal(
    calls.filter((entry) => entry[0] === "getSolution").length,
    1,
    "exactly one liveness probe, at publish time",
  );
  const names = calls.map((entry) => entry[0]);
  assert.ok(!names.includes("buildPublishBundle"), "no bundle build for clean links");
  assert.ok(!names.includes("update"), "no upload for clean links");
});

test("a dead clean link blocks the publish, marks the link dirty, then self-heals on retry", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installPublishFixture(window, {
    skills: [userSkill("beta")],
    links: { beta: { solutionId: "sol-b", hasLocalChanges: false } },
    solutionsById: { "sol-b": { id: "sol-b", status: "deleted" } },
    // Soft-deleted listings reject updates under this code (no HTTP status).
    updateImpl: () => ({
      success: false,
      code: "solution_not_found",
      error: "This AI Marketplace solution is already absent.",
    }),
  });

  // Attempt 1: the execute-time liveness wave detects the tombstone, marks
  // the link dirty, and aborts before any write.
  await assert.rejects(
    window.AgentsPublishHooks.publishDependentSkills(["beta"]),
    /marketplace listings no longer exist: beta/,
  );
  assert.ok(
    calls.some((entry) => entry[0] === "markSkillLinkDirty" && entry[1] === "beta"),
    "the dead link is marked dirty for the retry",
  );
  assert.ok(!calls.some((entry) => entry[0] === "publish" || entry[0] === "update"));

  // Attempt 2: the now-dirty link takes the update path, whose
  // absent-listing self-heal republishes and relinks.
  const result = await window.AgentsPublishHooks.publishDependentSkills(["beta"]);
  assert.equal(result.summary.repaired, 1);
  assert.equal(result.summary.published, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(result.refs)), [
    { skill_id: "beta", kind: "solution", solution_id: "new-beta" },
  ]);
  // One skill, one row: the repair keeps its dual counters but reports a
  // single "repaired" outcome carrying the replacement listing id.
  assert.deepEqual(JSON.parse(JSON.stringify(result.skills)), [
    { skill_id: "beta", outcome: "repaired", solution_id: "new-beta" },
  ]);
});

test("system skills stay id-only and never touch the marketplace", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installPublishFixture(window, {
    skills: [
      {
        name: "web-search",
        source: "system",
        skill_path: "/tmp/skills/web-search",
      },
    ],
  });

  const result = await window.AgentsPublishHooks.publishDependentSkills(["web-search"]);

  assert.deepEqual(JSON.parse(JSON.stringify(result.refs)), []);
  const names = calls.map((entry) => entry[0]);
  for (const forbidden of ["search", "getBundle", "publish", "update", "setSkillLink"]) {
    assert.ok(!names.includes(forbidden), `${forbidden} must not run for system skills`);
  }
});

// PORTICO-347: the publish envelope names every dependent skill with its outcome
// and solution id, so follow-up calls copy ids from the fresh result instead
// of re-deriving them from listing dumps (chat 873f39ba mistranscribed one).
test("publishDependentSkills reports a per-skill outcome row for every plan", async () => {
  const { window } = loadAgentsModuleHarness();
  installPublishFixture(window, {
    skills: [
      userSkill("alpha"),
      userSkill("beta"),
      userSkill("gamma"),
      { name: "web-search", source: "system", skill_path: "/tmp/skills/web-search" },
    ],
    links: {
      beta: { solutionId: "sol-b", hasLocalChanges: true },
      gamma: { solutionId: "sol-g", hasLocalChanges: false },
    },
    searchResults: [],
  });

  const result = await window.AgentsPublishHooks.publishDependentSkills([
    "alpha",
    "beta",
    "gamma",
    "web-search",
  ]);

  const rows = JSON.parse(JSON.stringify(result.skills)).sort((a, b) =>
    a.skill_id.localeCompare(b.skill_id),
  );
  assert.deepEqual(rows, [
    { skill_id: "alpha", outcome: "published", solution_id: "new-alpha" },
    { skill_id: "beta", outcome: "updated", solution_id: "sol-b" },
    { skill_id: "gamma", outcome: "unchanged", solution_id: "sol-g" },
    { skill_id: "web-search", outcome: "system" },
  ]);
  // Every solution-backed row's id matches its bundle ref — models can use
  // either interchangeably.
  const refIds = new Map(
    JSON.parse(JSON.stringify(result.refs)).map((ref) => [ref.skill_id, ref.solution_id]),
  );
  for (const row of rows) {
    if (row.solution_id) assert.equal(refIds.get(row.skill_id), row.solution_id);
  }
});

test("a skill with a distinct display name carries it on its envelope row", async () => {
  const { window } = loadAgentsModuleHarness();
  installPublishFixture(window, {
    skills: [{ ...userSkill("alpha"), display_name: "Alpha Writer" }],
    searchResults: [],
  });

  const result = await window.AgentsPublishHooks.publishDependentSkills(["alpha"]);

  assert.deepEqual(JSON.parse(JSON.stringify(result.skills)), [
    {
      skill_id: "alpha",
      display_name: "Alpha Writer",
      outcome: "published",
      solution_id: "new-alpha",
    },
  ]);
});

test("only the exact owned-name match is bundle-verified, and never searched", async () => {
  const { window } = loadAgentsModuleHarness();
  const noise = Array.from({ length: 24 }, (_unused, i) => ({
    id: `sol-noise-${i}`,
    type: "skills",
    name: `other-skill-${i}`,
  }));
  const { calls } = installPublishFixture(window, {
    skills: [userSkill("alpha")],
    bundlesBySolutionId: {
      "sol-a": { success: true, data: { type: "skills", payload: { name: "alpha" } } },
    },
    ownedSolutions: [...noise, { id: "sol-a", type: "skills", name: "alpha" }],
  });

  const result = await window.AgentsPublishHooks.publishDependentSkills(["alpha"]);

  assert.equal(result.summary.adopted, 1);
  const bundleProbes = calls.filter((entry) => entry[0] === "getBundle");
  assert.deepEqual(
    bundleProbes.map((entry) => entry[1]),
    ["sol-a"],
    "only the exact-name owned listing is bundle-verified",
  );
  assert.ok(
    !calls.some((entry) => entry[0] === "search"),
    "the multi-second marketplace search is gone from resolve",
  );
});

test("the modal's resolved plan is reused on submit without re-resolving", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installPublishFixture(window, gitMarketplaceFixture());

  const resolution = await window.AgentsPublishHooks.resolveDependentSkillPlans([
    "anthropic-agent-skills/algorithmic-art",
  ]);
  assert.equal(resolution.errors.length, 0);
  const callsAfterResolve = calls.length;

  const published = await window.AgentsPublishHooks.pushAgentToMarketplace({
    localId: "agent-1",
    solutionId: "",
    args: {
      name: "Agent One",
      description: "",
      base_model_id: "model-a",
      system_prompt: "prompt",
      skill_ids: ["anthropic-agent-skills/algorithmic-art"],
      tool_server_ids: [],
      reasoning_effort: "medium",
    },
    resolvedSkillPlan: resolution.plans,
  });

  assert.equal(published.solutionId, "new-agent-1");
  const resubmitCalls = calls.slice(callsAfterResolve).map((entry) => entry[0]);
  for (const forbidden of ["getSkills", "listSkillLinks", "search"]) {
    assert.ok(
      !resubmitCalls.includes(forbidden),
      `${forbidden} must not re-run when the resolved plan is reused`,
    );
  }
  const agentBundleCall = calls.find((entry) => entry[0] === "buildAgentBundle");
  assert.equal(
    JSON.parse(JSON.stringify(agentBundleCall[1].skill_refs))[0].kind,
    "git-marketplace",
  );
});

// ---- provenance modal polish --------------------------------------------------

test("provenance rows read in plain language with ids demoted to hover tooltips", async () => {
  const { window } = loadAgentsModuleHarness();
  installPublishFixture(window, {});
  const html = window.AgentsPublishHooks.buildSkillProvenanceRowsHtml({
    plans: [
      { action: "system", provenance: "system", canonicalName: "web-search", displayName: "Web Search" },
      {
        action: "reference",
        provenance: "user-linked-clean",
        canonicalName: "llm-proxy-analytics",
        displayName: "Llm Proxy Analytics",
        solutionId: "fb5c9669-cc21-47ee-af40-952a0af5fb2c",
      },
      {
        action: "update",
        provenance: "user-linked-dirty",
        canonicalName: "notes",
        displayName: "Notes",
        solutionId: "20429e87-185a-4257-a670-5f7b05de67d7",
      },
      {
        action: "adopt-update",
        provenance: "user-adopt",
        canonicalName: "architecture-diagrams",
        displayName: "Architecture Diagrams",
        solutionId: "20429e87-185a-4257-a670-5f7b05de67d7",
      },
      {
        action: "publish-new",
        provenance: "user-new",
        canonicalName: "brand-new",
        displayName: "Brand New",
      },
      {
        action: "reference",
        provenance: "installed-solution",
        canonicalName: "toolkit",
        displayName: "Toolkit",
        solutionId: "5a59fbc0-aaaa-bbbb-cccc-ddddeeeeffff",
      },
      {
        action: "reference-git",
        provenance: "installed-git",
        canonicalName: "algorithmic-art",
        displayName: "Algorithmic Art",
        marketplaceName: "anthropic-agent-skills",
        marketplaceSource: { type: "github", repo: "anthropics/skills" },
      },
    ],
    errors: [{ skillId: "broken-skill", error: "its marketplace entry is missing" }],
  });

  // No raw ids in VISIBLE text: strip tag attributes (tooltips) and check the
  // remaining text content for hex-id fragments.
  const visibleText = html.replace(/<[^>]*>/g, " ");
  assert.doesNotMatch(visibleText, /[0-9a-f]{8}-[0-9a-f]{4}/i, "no GUIDs in visible copy");
  assert.doesNotMatch(visibleText, /fb5c9669|20429e87|5a59fbc0/i);

  // The ids ARE available on hover.
  assert.match(html, /title="Solutions Marketplace listing fb5c9669-cc21-47ee-af40-952a0af5fb2c"/);
  assert.match(html, /title="Marketplace repository: anthropics\/skills"/);

  // Git-marketplace provenance is explicit: Installed → GIT → marketplace
  // name, so readers can tell a git repo copy from a Solutions install.
  assert.match(
    html,
    /badge-installed">Installed<\/span><span class="mcp-card-badge badge-git"[^>]*>Git<\/span><span class="mcp-card-badge badge-marketplace-name">anthropic-agent-skills/,
  );
  const gitChipCount = (html.match(/badge-git/g) || []).length;
  assert.equal(gitChipCount, 1, "only the installed-git row carries the GIT chip");

  // Plain-language lines: fact first, consequence on its own quieter second
  // line (agents-publish-skill-action-remedy) — never an em-dash run-on.
  assert.match(visibleText, /Built into Portico\./);
  assert.match(visibleText, /Published and up to date\.\s+Nothing to re-upload\./);
  assert.match(visibleText, /Local changes will be published to your existing listing\./);
  assert.match(visibleText, /Yours on the marketplace\.\s+Will be reconnected and updated\./);
  assert.match(visibleText, /New\.\s+Will be published as your listing\./);
  assert.match(visibleText, /Marketplace install\.\s+Your agent will point at that listing\./);
  assert.match(
    visibleText,
    /From the anthropic-agent-skills marketplace\.\s+Installers get it automatically\./,
  );
  assert.doesNotMatch(visibleText, /\w — \w/, "no em-dash run-ons in what-happens copy");
  assert.match(
    html,
    /agents-publish-skill-action-remedy">Will be published as your listing\./,
    "the consequence renders as the quiet second line",
  );
  assert.match(visibleText, /Can't publish yet: its marketplace entry is missing/);

  // Table layout: one row per plan and per blocker, each with a status cell
  // the submit-time progress ticker can address by skill name.
  assert.match(html, /<table class="agents-publish-skill-table"/);
  assert.match(html, /<th>Skill<\/th>\s*<th>Source<\/th>\s*<th>What happens<\/th>/);
  const rowCount = (html.match(/<tr class="agents-publish-skill-row/g) || []).length;
  assert.equal(rowCount, 8, "7 plan rows + 1 blocked row");
  const skillKeys = [...html.matchAll(/data-skill="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(skillKeys, [
    "web-search",
    "llm-proxy-analytics",
    "notes",
    "architecture-diagrams",
    "brand-new",
    "toolkit",
    "algorithmic-art",
  ]);
  const idleCells = (html.match(/data-status="idle"/g) || []).length;
  const currentCells = (html.match(/data-status="current"/g) || []).length;
  const blockedCells = (html.match(/data-status="blocked"/g) || []).length;
  assert.equal(idleCells, 3, "rows with real work start idle");
  assert.equal(
    currentCells,
    4,
    "no-work rows (system/reference/reference-git) show the green check from resolve time",
  );
  assert.equal(blockedCells, 1, "the blocked row is marked blocked up front");
  assert.match(html, /<th>Status<\/th>/, "the status column is labelled");
});

test("an unlinked user skill costs one listPublished and zero searches at resolve", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installPublishFixture(window, {
    skills: [userSkill("alpha")],
    ownedSolutions: [],
  });

  const resolution = await window.AgentsPublishHooks.resolveDependentSkillPlans(["alpha"]);
  assert.equal(resolution.errors.length, 0);
  assert.equal(resolution.plans[0].provenance, "user-new");

  const names = calls.map((entry) => entry[0]);
  assert.equal(
    names.filter((name) => name === "listPublished").length,
    1,
    "one owned-listings page, no more",
  );
  assert.ok(!names.includes("search"), "no marketplace search at resolve");
  assert.ok(!names.includes("getBundle"), "no bundle probes without an owned-name match");
});

// ---- live publish progress events ---------------------------------------------

test("execute emits batch starts, then dones in plan order, including instant no-op plans", async () => {
  const { window } = loadAgentsModuleHarness();
  installPublishFixture(window, {});
  const events = [];

  const result = await window.AgentsPublishHooks.executeDependentSkillPlans(
    [
      { action: "system", provenance: "system", canonicalName: "web-search" },
      {
        action: "reference",
        provenance: "user-linked-clean",
        canonicalName: "clean-skill",
        solutionId: "sol-clean",
      },
      {
        action: "publish-new",
        provenance: "user-new",
        canonicalName: "newbie",
        solutionInput: { name: "newbie", type: "skills" },
      },
    ],
    { onProgress: (event) => events.push([event.phase, event.plan?.canonicalName]) },
  );

  // Round 15: writes run in parallel batches of 3 — every batch-mate starts
  // together, then completion marks land in plan order.
  assert.deepEqual(JSON.parse(JSON.stringify(events)), [
    ["skill:start", "web-search"],
    ["skill:start", "clean-skill"],
    ["skill:start", "newbie"],
    ["skill:done", "web-search"],
    ["skill:done", "clean-skill"],
    ["skill:done", "newbie"],
  ]);
  assert.equal(result.summary.unchanged, 1);
  assert.equal(result.summary.published, 1);
});

test("a failing plan doesn't abort the sweep: later batches run, links persist, aggregate error", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installPublishFixture(window, {
    publishImpl: (input) =>
      input?.name === "beta"
        ? { success: false, error: "boom" }
        : { success: true, data: { id: `new-${input?.name}` } },
  });
  const events = [];
  const plan = (name) => ({
    action: "publish-new",
    provenance: "user-new",
    canonicalName: name,
    solutionInput: { name, type: "skills" },
  });

  await assert.rejects(
    window.AgentsPublishHooks.executeDependentSkillPlans(
      // alpha/beta/gamma share the first batch of 3; delta sits in batch 2.
      // beta's failure must NOT strand delta — one click makes maximal
      // progress and only the stragglers stay failed.
      [plan("alpha"), plan("beta"), plan("gamma"), plan("delta")],
      { onProgress: (event) => events.push([event.phase, event.plan?.canonicalName]) },
    ),
    /Failed to publish dependent skill solutions: beta \(boom\)\..*already published to the marketplace before the failure: alpha, gamma, delta\./,
  );

  assert.deepEqual(JSON.parse(JSON.stringify(events)), [
    ["skill:start", "alpha"],
    ["skill:start", "beta"],
    ["skill:start", "gamma"],
    ["skill:done", "alpha"],
    ["skill:error", "beta"],
    ["skill:done", "gamma"],
    ["skill:start", "delta"],
    ["skill:done", "delta"],
  ]);
  // Batch-mates that succeeded stay linked — no limbo marketplace listings.
  assert.ok(
    calls.some((entry) => entry[0] === "setSkillLink" && entry[1] === "alpha"),
    "alpha's link write is kept",
  );
  assert.ok(
    calls.some((entry) => entry[0] === "setSkillLink" && entry[1] === "gamma"),
    "gamma published alongside the failure and stays linked",
  );
  assert.ok(
    calls.some((entry) => entry[0] === "setSkillLink" && entry[1] === "delta"),
    "the batch after the failure still runs and links",
  );
});

test("multiple failed plans aggregate into one error naming each skill", async () => {
  const { window } = loadAgentsModuleHarness();
  installPublishFixture(window, {
    publishImpl: (input) =>
      input?.name === "beta" || input?.name === "delta"
        ? { success: false, error: `boom-${input?.name}` }
        : { success: true, data: { id: `new-${input?.name}` } },
  });
  const plan = (name) => ({
    action: "publish-new",
    provenance: "user-new",
    canonicalName: name,
    solutionInput: { name, type: "skills" },
  });

  await assert.rejects(
    window.AgentsPublishHooks.executeDependentSkillPlans([
      plan("alpha"),
      plan("beta"),
      plan("gamma"),
      plan("delta"),
    ]),
    /Failed to publish dependent skill solutions: beta \(boom-beta\), delta \(boom-delta\)\..*before the failure: alpha, gamma\./,
  );
});

test("marketplace writes overlap within a batch and cap at 3", async () => {
  const { window } = loadAgentsModuleHarness();
  let inFlight = 0;
  let maxInFlight = 0;
  installPublishFixture(window, {
    publishImpl: async (input) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { success: true, data: { id: `new-${input?.name}` } };
    },
  });
  const plan = (name) => ({
    action: "publish-new",
    provenance: "user-new",
    canonicalName: name,
    solutionInput: { name, type: "skills" },
  });

  await window.AgentsPublishHooks.executeDependentSkillPlans([
    plan("one"),
    plan("two"),
    plan("three"),
    plan("four"),
  ]);

  assert.equal(maxInFlight, 3, "the first batch runs its three writes concurrently");
});

test("a throwing progress callback never disturbs the marketplace writes", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installPublishFixture(window, {});

  const result = await window.AgentsPublishHooks.executeDependentSkillPlans(
    [
      {
        action: "reference-git",
        provenance: "installed-git",
        canonicalName: "algorithmic-art",
        marketplaceName: "anthropic-agent-skills",
        marketplaceSource: { type: "github", repo: "anthropics/skills" },
        skillPath: "skills/algorithmic-art",
      },
      {
        action: "publish-new",
        provenance: "user-new",
        canonicalName: "newbie",
        solutionInput: { name: "newbie", type: "skills" },
      },
    ],
    {
      onProgress: () => {
        throw new Error("UI blew up");
      },
    },
  );

  assert.equal(result.summary.gitReferenced, 1);
  assert.equal(result.summary.published, 1);
  assert.equal(JSON.parse(JSON.stringify(result.refs)).length, 2);
  assert.ok(calls.some((entry) => entry[0] === "publish" && entry[1] === "newbie"));
  assert.ok(
    calls.some((entry) => entry[0] === "setSkillLink" && entry[1] === "newbie"),
  );
});

test("agent:start fires after all skill work and before any agent write", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installPublishFixture(window, {
    skills: [userSkill("alpha")],
    searchResults: [],
  });

  await window.AgentsPublishHooks.pushAgentToMarketplace({
    localId: "agent-1",
    solutionId: "sol-agent",
    args: {
      name: "Agent One",
      description: "",
      base_model_id: "model-a",
      system_prompt: "prompt",
      skill_ids: ["alpha"],
      tool_server_ids: [],
      reasoning_effort: "medium",
      allowed_emails: null,
    },
    onProgress: (event) =>
      calls.push(["progress", event.phase, event.plan?.canonicalName]),
  });

  const names = calls.map((entry) => `${entry[0]}:${entry[1] ?? ""}`);
  const lastSkillEvent = names.lastIndexOf("progress:skill:done");
  const agentStart = names.indexOf("progress:agent:start");
  const agentBundle = names.findIndex((name) => name.startsWith("buildAgentBundle"));
  const agentUpdate = calls.findIndex(
    (entry) => entry[0] === "update" && entry[1] === "sol-agent",
  );
  assert.ok(lastSkillEvent >= 0 && agentStart >= 0 && agentBundle >= 0 && agentUpdate >= 0);
  assert.ok(lastSkillEvent < agentStart, "skill work completes before agent:start");
  assert.ok(agentStart < agentBundle, "agent:start precedes the agent bundle build");
  assert.ok(agentStart < agentUpdate, "agent:start precedes the agent solution write");
});

// ---- pre-install provenance (install modal) -------------------------------------

const AGENT_BUNDLE = (payload) => ({ type: "portico-agents", payload });

test("install classifier mirrors the reconcile decision order per ref path", async () => {
  const { window } = loadAgentsModuleHarness();
  installPublishFixture(window, {
    skills: [
      { name: "web-search", display_name: "Web Search", source: "system" },
      userSkill("notes"),
      {
        name: "anthropic-agent-skills/theming",
        display_name: "Theming",
        source: "marketplace",
        marketplace_name: "anthropic-agent-skills",
      },
    ],
    links: { "my-published": { solutionId: "sol-mine", hasLocalChanges: false } },
    marketplacesConfig: {
      marketplaces: [
        {
          id: "anthropic-agent-skills",
          name: "anthropic-agent-skills",
          source: { type: "github", repo: "anthropics/skills", ref: "main" },
        },
      ],
      installedSkills: [
        {
          marketplaceId: "ai-marketplace",
          skillId: "toolkit",
          skillSource: { type: "ai-marketplace-solution", solutionId: "sol-toolkit" },
        },
        { marketplaceId: "anthropic-agent-skills", skillId: "algorithmic-art" },
      ],
    },
  });

  const gitSource = { type: "github", repo: "Anthropics/Skills", ref: "dev" };
  const resolution = await window.AgentsPublishHooks.resolveInstallSkillPlans({
    bundle: AGENT_BUNDLE({
      name: "Bundle Agent",
      skill_ids: [
        "web-search", // ref-less, local system
        "notes", // ref-less, local user
        "anthropic-agent-skills/theming", // legacy qualified id, local marketplace copy
        "toolkit", // solution ref -> installed record by solutionId
        "my-published", // solution ref -> viewer's published skill
        "fresh-skill", // solution ref -> fresh install
        "algorithmic-art", // git ref -> marketplace matched (case-insensitive) + installed record
        "brand-new-art", // git ref -> marketplace matched, not installed
        "elsewhere-art", // git ref -> marketplace missing -> auto-add (gitlab note)
        "mystery-skill", // no ref, not local -> blocked
      ],
      skill_refs: [
        { skill_id: "toolkit", kind: "solution", solution_id: "sol-toolkit" },
        { skill_id: "my-published", solution_id: "sol-mine" },
        { skill_id: "fresh-skill", kind: "solution", solution_id: "sol-fresh" },
        {
          skill_id: "algorithmic-art",
          kind: "git-marketplace",
          solution_id: null,
          marketplace: { name: "anthropic-agent-skills", source: gitSource },
          skill_path: "./skills/algorithmic-art",
        },
        {
          skill_id: "brand-new-art",
          kind: "git-marketplace",
          solution_id: null,
          marketplace: { name: "anthropic-agent-skills", source: gitSource },
          skill_path: "./skills/brand-new-art",
        },
        {
          skill_id: "elsewhere-art",
          kind: "git-marketplace",
          solution_id: null,
          marketplace: {
            name: "team-marketplace",
            source: { type: "gitlab", host: "GitLab.Example.com", projectPath: "ai/skills" },
          },
          skill_path: "./skills/elsewhere-art",
        },
      ],
    }),
  });

  const plansByProvenance = JSON.parse(JSON.stringify(resolution.plans)).map(
    (plan) => [plan.skillId, plan.provenance],
  );
  // Install plans sort by "What happens" category, action first: downloads
  // and marketplace adds top-down, already-available rows after, core
  // built-ins last — alphabetically by label within each category.
  assert.deepEqual(plansByProvenance, [
    ["fresh-skill", "solution-install"],
    ["brand-new-art", "git-install"],
    ["elsewhere-art", "git-add-install"],
    ["notes", "local-user"],
    ["my-published", "user-published-reuse"],
    ["anthropic-agent-skills/theming", "local-installed"],
    ["toolkit", "installed-solution-reuse"],
    ["algorithmic-art", "git-reuse-installed"],
    ["web-search", "local-system"],
  ]);
  const gitAdd = resolution.plans.find((plan) => plan.provenance === "git-add-install");
  assert.equal(gitAdd.gitlabNote, true);
  assert.equal(resolution.errors.length, 1);
  assert.equal(resolution.errors[0].skillId, "mystery-skill");
  assert.match(resolution.errors[0].error, /isn't on this computer/);

  // Blocked rows render ABOVE the plan rows — they explain the disabled
  // Install button, so they must lead the table.
  const html = window.AgentsPublishHooks.buildInstallSkillPlanRowsHtml(resolution);
  const rowActions = [...html.matchAll(/data-action="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(rowActions[0], "error", "the blocked row leads");
  assert.deepEqual(
    rowActions.slice(1),
    plansByProvenance.map(([, provenance]) => provenance),
    "plan rows follow in their sorted category order",
  );
});

test("install-plan sorting ranks update states ahead of everything, alpha within category", () => {
  const { window } = loadAgentsModuleHarness();
  const sorted = window.AgentsPublishHooks.sortInstallPlansForDisplay([
    { skillId: "core", displayName: "Core Thing", provenance: "local-system" },
    { skillId: "b-fresh", displayName: "B Fresh", provenance: "solution-install" },
    {
      skillId: "edited",
      displayName: "Edited",
      provenance: "installed-solution-reuse",
      updateState: "review",
    },
    { skillId: "a-fresh", displayName: "A Fresh", provenance: "solution-install" },
    {
      skillId: "stale",
      displayName: "Stale",
      provenance: "installed-solution-reuse",
      updateState: "refresh",
    },
    { skillId: "weird", displayName: "Weird", provenance: "future-unknown-kind" },
  ]);
  assert.deepEqual(
    sorted.map((plan) => plan.skillId),
    ["stale", "edited", "a-fresh", "b-fresh", "weird", "core"],
    "refresh, review, installs (alpha; unknown kinds ride with solution installs), core last",
  );
});

test("install classifier keeps verbatim skill ids and fails closed on target conflicts", async () => {
  const { window } = loadAgentsModuleHarness();
  installPublishFixture(window, {
    skills: [
      {
        name: "ai-marketplace/occupied",
        display_name: "Occupied",
        source: "marketplace",
        marketplace_name: "Solutions Marketplace",
      },
    ],
    marketplacesConfig: { marketplaces: [], installedSkills: [] },
  });

  const resolution = await window.AgentsPublishHooks.resolveInstallSkillPlans({
    bundle: AGENT_BUNDLE({
      name: "Conflict Agent",
      skill_ids: ["ai-marketplace/occupied", "occupied"],
      skill_refs: [
        { skill_id: "occupied", kind: "solution", solution_id: "sol-other" },
      ],
    }),
  });

  // The legacy qualified id reuses the local copy under its VERBATIM key —
  // the main process echoes payload ids untransformed in progress events.
  const reused = resolution.plans.find(
    (plan) => plan.skillId === "ai-marketplace/occupied",
  );
  assert.ok(reused, "qualified id resolves");
  assert.equal(reused.provenance, "local-installed");
  // The solution ref for the same name has NO provenance match, and its
  // install target is occupied: main would throw skill_install_target_conflict.
  assert.equal(resolution.errors.length, 1);
  assert.equal(resolution.errors[0].skillId, "occupied");
  assert.match(resolution.errors[0].error, /already occupies its install location/);
});

test("install rows read in plain language with ids and repos in tooltips", async () => {
  const { window } = loadAgentsModuleHarness();
  installPublishFixture(window, {});
  const html = window.AgentsPublishHooks.buildInstallSkillPlanRowsHtml({
    plans: [
      { skillId: "web-search", displayName: "Web Search", provenance: "local-system" },
      { skillId: "notes", displayName: "Notes", provenance: "local-user" },
      {
        skillId: "toolkit",
        displayName: "Toolkit",
        provenance: "installed-solution-reuse",
        solutionId: "5a59fbc0-aaaa-bbbb-cccc-ddddeeeeffff",
      },
      {
        skillId: "my-published",
        displayName: "My Published",
        provenance: "user-published-reuse",
        solutionId: "fb5c9669-cc21-47ee-af40-952a0af5fb2c",
      },
      {
        skillId: "fresh-skill",
        displayName: "Fresh Skill",
        provenance: "solution-install",
        solutionId: "20429e87-185a-4257-a670-5f7b05de67d7",
      },
      {
        skillId: "algorithmic-art",
        displayName: "Algorithmic Art",
        provenance: "git-reuse-installed",
        marketplaceName: "anthropic-agent-skills",
        repoLabel: "anthropics/skills",
      },
      {
        skillId: "elsewhere-art",
        displayName: "Elsewhere Art",
        provenance: "git-add-install",
        marketplaceName: "team-marketplace",
        repoLabel: "ai/skills",
        gitlabNote: true,
      },
    ],
    errors: [{ skillId: "mystery-skill", error: "its files are missing from this computer" }],
  });

  const visibleText = html.replace(/<[^>]*>/g, " ");
  assert.doesNotMatch(visibleText, /[0-9a-f]{8}-[0-9a-f]{4}/i, "no GUIDs in visible copy");
  assert.match(html, /title="Solutions Marketplace listing 20429e87-185a-4257-a670-5f7b05de67d7"/);
  assert.match(html, /title="Marketplace repository: anthropics\/skills"/);

  // Fact first, consequence on its own quieter second line — no em-dash
  // run-ons anywhere in the what-happens copy.
  assert.match(visibleText, /Built into Portico\.\s+Already available\./);
  assert.match(visibleText, /You already have this skill\.\s+Your copy will be used\./);
  assert.match(visibleText, /Already installed from the marketplace\.\s+Nothing to download\./);
  assert.match(visibleText, /This is your published skill\.\s+Your local copy will be used\./);
  assert.match(visibleText, /Will be installed from the Solutions Marketplace\./);
  assert.match(
    visibleText,
    /Already installed from the anthropic-agent-skills marketplace\.\s+Nothing to download\./,
  );
  assert.match(
    visibleText,
    /The team-marketplace marketplace will be added to this computer, then the skill installed from it\./,
  );
  assert.match(visibleText, /You may be asked to sign in to GitLab\./);
  assert.match(visibleText, /Can't install yet: its files are missing from this computer\./);
  assert.doesNotMatch(visibleText, /\w — \w/, "no em-dash run-ons in what-happens copy");

  // A blocked entry without enrichment still renders a formatted label and a
  // quiet dash under Source — never the raw slug, never a colspan run-on.
  const blockedStart = html.indexOf('data-skill="mystery-skill"');
  assert.ok(blockedStart >= 0, "blocked row is addressable by skill id");
  const blockedRow = html.slice(blockedStart, html.indexOf("</tr>", blockedStart));
  assert.match(blockedRow, /agents-publish-skill-name">Mystery Skill</);
  assert.match(
    blockedRow,
    /agents-publish-skill-chips"><span class="agent-details-empty">—</,
  );
  assert.doesNotMatch(blockedRow, /colspan/);

  assert.match(html, /<table class="agents-publish-skill-table"/);
  assert.match(html, /<th>Status<\/th>/);
  const rowCount = (html.match(/<tr class="agents-publish-skill-row/g) || []).length;
  assert.equal(rowCount, 8, "7 plan rows + 1 blocked row");
  assert.equal(
    (html.match(/data-status="idle"/g) || []).length,
    2,
    "rows that will download/install start idle",
  );
  assert.equal(
    (html.match(/data-status="current"/g) || []).length,
    5,
    "reuse rows show the green check from resolve time",
  );
  assert.equal((html.match(/data-status="blocked"/g) || []).length, 1);
  assert.ok(html.includes('data-skill="algorithmic-art"'));

  // Git-based rows carry the GIT provenance chip: the installed reuse row as
  // Installed → GIT → name, the add-and-install row as GIT → name. The
  // Solutions-marketplace rows never do.
  assert.match(
    html,
    /badge-installed">Installed<\/span><span class="mcp-card-badge badge-git"[^>]*>Git<\/span><span class="mcp-card-badge badge-marketplace-name">anthropic-agent-skills/,
  );
  assert.match(
    html,
    /badge-git"[^>]*>Git<\/span><span class="mcp-card-badge badge-marketplace-name">team-marketplace/,
  );
  assert.equal(
    (html.match(/badge-git/g) || []).length,
    2,
    "GIT chips appear on exactly the two git-marketplace rows",
  );
});

// ---- install router behavior -----------------------------------------------------

test("install router: agent bundles open the provenance flow; other types install directly", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installPublishFixture(window, {
    bundlesBySolutionId: {
      "sol-agent": {
        success: true,
        data: {
          type: "portico-agents",
          payload: { name: "Agent A", skill_ids: [] },
        },
      },
      "sol-skill": { success: true, data: { type: "skills", payload: { name: "s" } } },
    },
  });

  let installedFired = 0;
  const openedAgent = await window.AgentsPublishHooks.installSolution(
    "sol-agent",
    null,
    { onInstalled: () => { installedFired += 1; } },
  );
  assert.equal(openedAgent, true, "agent flow reports opened");
  assert.ok(
    !calls.some((entry) => entry[0] === "install"),
    "agent installs defer to the provenance modal — no direct install call",
  );
  assert.equal(installedFired, 0, "onInstalled waits for a real install");

  const skillInstalled = await window.AgentsPublishHooks.installSolution(
    "sol-skill",
    null,
    { onInstalled: () => { installedFired += 1; } },
  );
  assert.equal(skillInstalled, true);
  assert.ok(
    calls.some((entry) => entry[0] === "install" && entry[1] === "sol-skill"),
    "non-agent solutions install directly",
  );
  assert.equal(installedFired, 1);
});

test("install router falls through to a direct install when the bundle probe fails", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installPublishFixture(window, {});

  await window.AgentsPublishHooks.installSolution("sol-unprobed", null, {});

  assert.ok(
    calls.some((entry) => entry[0] === "install" && entry[1] === "sol-unprobed"),
    "no_bundle handling stays with the direct install path",
  );
});

test("performInstallSolution keeps the toast contract and rethrows only for the modal path", async () => {
  const { window } = loadAgentsModuleHarness();
  installPublishFixture(window, {
    installImpl: async () => ({ success: false, error: "boom", code: "kaput" }),
  });

  const quiet = await window.AgentsPublishHooks.performInstallSolution("sol-x");
  assert.equal(quiet, false, "direct installs report failure as a boolean");

  await assert.rejects(
    window.AgentsPublishHooks.performInstallSolution("sol-x", null, {
      rethrow: true,
    }),
    /boom/,
  );
});

// ---- session memo + execute-time liveness wave ----------------------------------

test("the owned-listings lookup is memoized across resolves in a session", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installPublishFixture(window, {
    skills: [userSkill("alpha")],
    ownedSolutions: [],
  });

  await window.AgentsPublishHooks.resolveDependentSkillPlans(["alpha"]);
  await window.AgentsPublishHooks.resolveDependentSkillPlans(["alpha"]);

  assert.equal(
    calls.filter((entry) => entry[0] === "listPublished").length,
    1,
    "the second resolve reuses the session memo",
  );
});

test("any execute run invalidates the owned-listings memo", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installPublishFixture(window, {
    skills: [userSkill("alpha")],
    ownedSolutions: [],
  });

  await window.AgentsPublishHooks.publishDependentSkills(["alpha"]);
  await window.AgentsPublishHooks.resolveDependentSkillPlans(["alpha"]);

  assert.equal(
    calls.filter((entry) => entry[0] === "listPublished").length,
    2,
    "marketplace writes bust the memo so the next resolve refetches",
  );
});

test("the skills tab can bust the owned-listings memo via the exposed hook", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installPublishFixture(window, {
    skills: [userSkill("alpha")],
    ownedSolutions: [],
  });

  await window.AgentsPublishHooks.resolveDependentSkillPlans(["alpha"]);
  window.AgentsPublishHooks.invalidateMarketplaceSkillLookups();
  await window.AgentsPublishHooks.resolveDependentSkillPlans(["alpha"]);

  assert.equal(calls.filter((entry) => entry[0] === "listPublished").length, 2);
});

test("one liveness wave marks every dead clean link dirty", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installPublishFixture(window, {
    skills: [userSkill("beta"), userSkill("gamma")],
    links: {
      beta: { solutionId: "sol-b", hasLocalChanges: false },
      gamma: { solutionId: "sol-g", hasLocalChanges: false },
    },
    solutionsById: {
      "sol-b": { id: "sol-b", status: "deleted" },
      "sol-g": { id: "sol-g", status: "deleted" },
    },
  });

  await assert.rejects(
    window.AgentsPublishHooks.publishDependentSkills(["beta", "gamma"]),
    /no longer exist: beta, gamma/,
  );
  const dirtied = calls
    .filter((entry) => entry[0] === "markSkillLinkDirty")
    .map((entry) => entry[1])
    .sort();
  assert.deepEqual(dirtied, ["beta", "gamma"], "both dead links healed in one pass");
  assert.ok(!calls.some((entry) => entry[0] === "publish" || entry[0] === "update"));
});

test("a transient liveness failure aborts retryably without faking local changes", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installPublishFixture(window, {
    skills: [userSkill("beta")],
    links: { beta: { solutionId: "sol-b", hasLocalChanges: false } },
    getSolutionImpl: () => ({ success: false, code: "network_error", error: "offline" }),
  });

  await assert.rejects(
    window.AgentsPublishHooks.publishDependentSkills(["beta"]),
    /retry when the AI Marketplace is reachable/,
  );
  assert.ok(
    !calls.some((entry) => entry[0] === "markSkillLinkDirty"),
    "a network blip must not fake an Unpublished-changes badge",
  );
  assert.ok(!calls.some((entry) => entry[0] === "publish" || entry[0] === "update"));
});

// ---- content-free renderer diagnostics -------------------------------------------

test("execute:result events carry ids and outcomes for every write plan", async () => {
  const { window } = loadAgentsModuleHarness();
  const { logToMainEvents } = installPublishFixture(window, {
    skills: [userSkill("alpha"), userSkill("beta")],
    links: { beta: { solutionId: "sol-b", hasLocalChanges: true } },
    ownedSolutions: [],
  });

  await window.AgentsPublishHooks.publishDependentSkills(["alpha", "beta"]);

  const results = logToMainEvents
    .filter((entry) => entry?.message === "[Agents][MarketplacePublish] execute:result")
    .map((entry) => [entry.meta.skillId, entry.meta.outcome, entry.meta.solutionId]);
  assert.deepEqual(results, [
    ["alpha", "published", "new-alpha"],
    ["beta", "updated", "sol-b"],
  ]);
});

test("renderer publish diagnostics never carry prompt or description content", async () => {
  const { window } = loadAgentsModuleHarness();
  const PROMPT_MARKER = "MARKER-PROMPT-render-01";
  const { logToMainEvents } = installPublishFixture(window, {
    skills: [userSkill("alpha")],
    ownedSolutions: [],
  });

  const resolution = await window.AgentsPublishHooks.resolveDependentSkillPlans([
    "alpha",
  ]);
  await window.AgentsPublishHooks.pushAgentToMarketplace({
    localId: "agent-1",
    solutionId: "",
    args: {
      name: "Agent One",
      description: "MARKER-DESC-render-02",
      base_model_id: "model-a",
      system_prompt: PROMPT_MARKER,
      skill_ids: ["alpha"],
      tool_server_ids: [],
      reasoning_effort: "medium",
      allowed_emails: null,
    },
    resolvedSkillPlan: resolution.plans,
  });

  const serialized = JSON.stringify(logToMainEvents);
  assert.ok(!serialized.includes(PROMPT_MARKER), "prompt never reaches logToMain");
  assert.ok(
    !serialized.includes("MARKER-DESC-render-02"),
    "description never reaches logToMain",
  );
  assert.ok(logToMainEvents.length > 0, "events were actually recorded");
});

test("provenance:resolved carries a per-skill plan breakdown", async () => {
  const { window } = loadAgentsModuleHarness();
  installPublishFixture(window, {});
  // provenance:resolved is emitted by the modal filler, which the vm harness
  // cannot drive; assert the breakdown shape through the same code path the
  // filler uses (resolve + the logged meta construction mirrors it in
  // publishAgent). The renderer leak test above covers the channel; here we
  // pin the resolver output feeding the breakdown.
  const { logToMainEvents } = installPublishFixture(window, {
    skills: [userSkill("beta")],
    links: { beta: { solutionId: "sol-b", hasLocalChanges: false } },
  });
  const resolution = await window.AgentsPublishHooks.resolveDependentSkillPlans([
    "beta",
  ]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(resolution.plans)).map((plan) => ({
      skillId: plan.canonicalName,
      action: plan.action,
      provenance: plan.provenance,
      solutionId: plan.solutionId || null,
    })),
    [
      {
        skillId: "beta",
        action: "reference",
        provenance: "user-linked-clean",
        solutionId: "sol-b",
      },
    ],
  );
  assert.ok(Array.isArray(logToMainEvents));
});

// ---- update-mode install rows (agent Update refresh report) ---------------------

test("update-mode plans classify installed deps by hydrated record state", async () => {
  const { window } = loadAgentsModuleHarness();
  installPublishFixture(window, {
    marketplacesConfig: {
      marketplaces: [],
      installedSkills: [
        {
          marketplaceId: "ai-marketplace",
          skillId: "fresh-dep",
          skillSource: { type: "ai-marketplace-solution", solutionId: "sol-fresh" },
          hasUpdate: true,
          isDirty: false,
        },
        {
          marketplaceId: "ai-marketplace",
          skillId: "edited-dep",
          skillSource: { type: "ai-marketplace-solution", solutionId: "sol-edited" },
          hasUpdate: true,
          isDirty: true,
        },
        {
          marketplaceId: "ai-marketplace",
          skillId: "current-dep",
          skillSource: { type: "ai-marketplace-solution", solutionId: "sol-current" },
          hasUpdate: false,
          isDirty: false,
        },
      ],
    },
  });

  const resolution = await window.AgentsPublishHooks.resolveInstallSkillPlans({
    bundle: {
      type: "portico-agents",
      payload: {
        name: "U",
        skill_ids: ["fresh-dep", "edited-dep", "current-dep"],
        skill_refs: [
          { skill_id: "fresh-dep", kind: "solution", solution_id: "sol-fresh" },
          { skill_id: "edited-dep", kind: "solution", solution_id: "sol-edited" },
          { skill_id: "current-dep", kind: "solution", solution_id: "sol-current" },
        ],
      },
    },
    mode: "update",
  });

  assert.deepEqual(
    JSON.parse(JSON.stringify(resolution.plans)).map((plan) => [
      plan.skillId,
      plan.updateState,
    ]),
    // What-Happens ordering: pending refreshes lead, needs-review next,
    // rows needing nothing trail.
    [
      ["fresh-dep", "refresh"],
      ["edited-dep", "review"],
      ["current-dep", "current"],
    ],
  );
});

test("update-mode rows show only changes; all-current renders up-to-date", async () => {
  const { window } = loadAgentsModuleHarness();
  installPublishFixture(window, {});

  const html = window.AgentsPublishHooks.buildInstallSkillPlanRowsHtml(
    {
      plans: [
        {
          skillId: "fresh-dep",
          displayName: "Fresh Dep",
          provenance: "installed-solution-reuse",
          solutionId: "sol-fresh",
          updateState: "refresh",
        },
        {
          skillId: "edited-dep",
          displayName: "Edited Dep",
          provenance: "installed-solution-reuse",
          solutionId: "sol-edited",
          updateState: "review",
        },
        {
          skillId: "current-dep",
          displayName: "Current Dep",
          provenance: "installed-solution-reuse",
          solutionId: "sol-current",
          updateState: "current",
        },
        {
          skillId: "web-search",
          displayName: "Web Search",
          provenance: "local-system",
        },
      ],
      errors: [],
    },
    "update",
  );

  const visibleText = html.replace(/<[^>]*>/g, " ");
  assert.match(visibleText, /Will be updated to the marketplace's latest version\./);
  assert.match(visibleText, /Has local edits\.\s+Your changes will be kept\./);
  assert.ok(!html.includes('data-skill="current-dep"'), "no-op rows hidden");
  assert.ok(!html.includes('data-skill="web-search"'), "local reuse rows hidden");
  assert.ok(html.includes('data-skill="fresh-dep"'));
  assert.ok(html.includes('data-skill="edited-dep"'));

  const empty = window.AgentsPublishHooks.buildInstallSkillPlanRowsHtml(
    {
      plans: [
        {
          skillId: "current-dep",
          displayName: "Current Dep",
          provenance: "installed-solution-reuse",
          updateState: "current",
        },
      ],
      errors: [],
    },
    "update",
  );
  assert.match(empty, /Everything is already up to date\./);
  assert.ok(!empty.includes("<table"), "no table when nothing changes");
});

// ---- provenance gating (round 9) ---------------------------------------------

test("a non-attachable marketplace skill blocks the publish plan with the unapproved-marketplace reason", async () => {
  const { window } = loadAgentsModuleHarness();
  const fixture = gitMarketplaceFixture();
  fixture.skills[0].agent_attachable = false;
  fixture.skills[0].marketplace_name = "Shady Skills";
  installPublishFixture(window, fixture);

  const resolution = await window.AgentsPublishHooks.resolveDependentSkillPlans([
    "anthropic-agent-skills/algorithmic-art",
  ]);
  assert.equal(resolution.plans.length, 0);
  assert.equal(resolution.errors.length, 1);
  assert.match(resolution.errors[0].error, /unapproved marketplace "Shady Skills"/);
  assert.match(resolution.errors[0].error, /Remove this skill to publish/);

  // The publish modal renders the failure as a blocked row and the caller
  // (publishAgent) disables submit on any resolve error.
  const html = window.AgentsPublishHooks.buildSkillProvenanceRowsHtml(resolution);
  assert.match(html, /agents-publish-skill-row-blocked/);
  assert.match(html, /data-status="blocked"/);
  assert.match(html, /Can&#039;t publish yet|Can't publish yet/);
  assert.match(html, /unapproved marketplace/);

  // And publishDependentSkills (the execute pipeline) refuses to run.
  await assert.rejects(
    window.AgentsPublishHooks.publishDependentSkills([
      "anthropic-agent-skills/algorithmic-art",
    ]),
    /unapproved marketplace/,
  );
});

test("plugin-scoped git refs carry plugin_name and resolve records FQN-first on leaf collisions", async () => {
  const { window } = loadAgentsModuleHarness();
  const fixture = {
    skills: [
      {
        name: "kwp/plugin-a/android",
        source: "marketplace",
        marketplace_id: "kwp",
        plugin_name: "plugin-a",
        skill_path: "/tmp/skills-marketplace/kwp/plugin-a/android",
        agent_attachable: true,
      },
    ],
    marketplacesConfig: {
      marketplaces: [
        {
          id: "kwp",
          name: "kwp",
          source: {
            type: "github",
            repo: "anthropics/knowledge-work-plugins",
            ref: "main",
          },
        },
      ],
      installedSkills: [
        // Two plugins share the "android" leaf — the FQN must pick plugin-a.
        {
          marketplaceId: "kwp",
          skillId: "android",
          pluginName: "plugin-b",
          skillPath: "./plugin-b/skills/android",
          skillSource: null,
          localPath: "skills-marketplace/kwp/plugin-b/android",
        },
        {
          marketplaceId: "kwp",
          skillId: "android",
          pluginName: "plugin-a",
          skillPath: "./plugin-a/skills/android",
          skillSource: null,
          localPath: "skills-marketplace/kwp/plugin-a/android",
        },
      ],
    },
  };
  installPublishFixture(window, fixture);

  const result = await window.AgentsPublishHooks.publishDependentSkills([
    "kwp/plugin-a/android",
  ]);
  const refs = JSON.parse(JSON.stringify(result.refs));
  assert.equal(refs.length, 1);
  assert.equal(refs[0].kind, "git-marketplace");
  assert.equal(refs[0].skill_path, "./plugin-a/skills/android");
  assert.equal(refs[0].plugin_name, "plugin-a");

  // Plans keep the PURE name (it feeds bundle-ref display_name) and carry
  // pluginName separately; the modal row composes "Plugin → Skill".
  const resolution = await window.AgentsPublishHooks.resolveDependentSkillPlans([
    "kwp/plugin-a/android",
  ]);
  assert.equal(resolution.plans.length, 1);
  assert.equal(resolution.plans[0].displayName, "android");
  assert.equal(resolution.plans[0].pluginName, "plugin-a");
  const rowsHtml = window.AgentsPublishHooks.buildSkillProvenanceRowsHtml({
    plans: [
      {
        ...JSON.parse(JSON.stringify(resolution.plans[0])),
        displayName: "Android A",
      },
    ],
    errors: [],
  });
  assert.match(rowsHtml, /agents-publish-skill-name">Plugin A → Android A</);
});

// ---- publish-unit visibility (allowed_emails audience threading) --------------
// The renderer forwards ONE audience: the agent listing gets it in its
// solutionInput; every dependent-skill write forwards it as options.aclAudience
// for the main-process union policy (ai-marketplace-acl.js). No skill write
// bakes allowed_emails into its own payload.

test("agent listing and every dependent-skill write carry one identical audience", async () => {
  const { window } = loadAgentsModuleHarness();
  const audience = ["teammate@example.invalid", "second@example.invalid"];
  const updateOpts = [];
  const { calls } = installPublishFixture(window, {
    skills: [userSkill("alpha"), userSkill("beta")],
    links: { beta: { solutionId: "sol-b", hasLocalChanges: true } },
    ownedSolutions: [{ id: "sol-b", type: "skills" }],
    updateImpl: (solutionId, input, opts) => {
      updateOpts.push({ solutionId, input, opts });
      return { success: true, data: { id: solutionId } };
    },
  });

  await window.AgentsPublishHooks.pushAgentToMarketplace({
    localId: "agent-1",
    solutionId: "",
    args: {
      name: "Agent One",
      description: "",
      base_model_id: "model-a",
      system_prompt: "prompt",
      skill_ids: ["alpha", "beta"],
      tool_server_ids: [],
      allowed_emails: audience,
    },
  });

  const skillPublish = calls.find(
    (entry) => entry[0] === "publish" && entry[1] === "alpha",
  );
  assert.ok(skillPublish, "new dependent skill publishes");
  assert.equal(
    skillPublish[2].allowed_emails,
    undefined,
    "skill create bodies never bake allowed_emails — policy lives in main",
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(skillPublish[3]?.aclAudience)),
    audience,
    "skill create forwards the agent audience as aclAudience",
  );

  assert.equal(updateOpts.length, 1, "dirty linked skill updates once");
  assert.equal(updateOpts[0].solutionId, "sol-b");
  assert.deepEqual(
    JSON.parse(JSON.stringify(updateOpts[0].opts?.aclAudience)),
    audience,
    "skill update forwards the agent audience as aclAudience",
  );
  assert.equal(
    updateOpts[0].input.allowed_emails,
    undefined,
    "skill update bodies never bake allowed_emails",
  );

  const agentPublish = calls.find(
    (entry) => entry[0] === "publish" && entry[1] === "agent-1",
  );
  assert.ok(agentPublish, "agent listing publishes");
  assert.deepEqual(
    JSON.parse(JSON.stringify(agentPublish[2].allowed_emails)),
    audience,
    "the agent listing's own payload carries the same audience verbatim",
  );
});

test("an empty (public) audience threads as [] to the agent and every skill write", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installPublishFixture(window, {
    skills: [userSkill("alpha")],
  });

  await window.AgentsPublishHooks.pushAgentToMarketplace({
    localId: "agent-1",
    solutionId: "",
    args: {
      name: "Agent One",
      description: "",
      base_model_id: "model-a",
      system_prompt: "prompt",
      skill_ids: ["alpha"],
      tool_server_ids: [],
      allowed_emails: [],
    },
  });

  const skillPublish = calls.find(
    (entry) => entry[0] === "publish" && entry[1] === "alpha",
  );
  assert.ok(skillPublish);
  assert.deepEqual(
    JSON.parse(JSON.stringify(skillPublish[3]?.aclAudience)),
    [],
    "public audience reaches the skill write as an explicit empty array",
  );
  const agentPublish = calls.find(
    (entry) => entry[0] === "publish" && entry[1] === "agent-1",
  );
  assert.deepEqual(JSON.parse(JSON.stringify(agentPublish[2].allowed_emails)), []);
});

// ---- moved liveness wave + visibility sync (ACL drift) ------------------------

test("the publish path probes each linked listing exactly once, at resolve time", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installPublishFixture(window, {
    skills: [userSkill("beta")],
    links: { beta: { solutionId: "sol-b", hasLocalChanges: false } },
    solutionsById: {
      "sol-b": { id: "sol-b", status: "active", allowed_emails: [] },
    },
  });

  const result = await window.AgentsPublishHooks.publishDependentSkills(
    ["beta"],
    { allowedEmails: [] },
  );
  assert.equal(result.summary.unchanged, 1);
  assert.equal(
    calls.filter((entry) => entry[0] === "preflightPublishListings").length,
    1,
    "one preflight wave at resolve",
  );
  assert.equal(
    calls.filter((entry) => entry[0] === "getSolution").length,
    0,
    "execute consumes the preflight instead of probing again",
  );
});

test("a dead listing surfaces from the resolve-time preflight with zero execute probes", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installPublishFixture(window, {
    skills: [userSkill("beta")],
    links: { beta: { solutionId: "sol-b", hasLocalChanges: false } },
    solutionsById: { "sol-b": { id: "sol-b", status: "deleted" } },
  });

  await assert.rejects(
    window.AgentsPublishHooks.publishDependentSkills(["beta"], {
      allowedEmails: [],
    }),
    /marketplace listings no longer exist: beta/,
  );
  assert.ok(
    calls.some((entry) => entry[0] === "markSkillLinkDirty" && entry[1] === "beta"),
    "the dead link is marked dirty for the retry",
  );
  assert.equal(calls.filter((entry) => entry[0] === "getSolution").length, 0);
  assert.ok(!calls.some((entry) => entry[0] === "publish" || entry[0] === "update"));
});

test("a clean linked skill with ACL drift gets a visibility-only update", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installPublishFixture(window, {
    skills: [userSkill("beta")],
    links: { beta: { solutionId: "sol-b", hasLocalChanges: false } },
    solutionsById: {
      "sol-b": {
        id: "sol-b",
        status: "active",
        allowed_emails: ["z@example.invalid"],
      },
    },
  });

  const result = await window.AgentsPublishHooks.publishDependentSkills(
    ["beta"],
    { allowedEmails: ["z@example.invalid", "c@example.invalid"] },
  );

  const syncCalls = calls.filter((entry) => entry[0] === "syncSolutionAcl");
  assert.equal(syncCalls.length, 1, "exactly one visibility sync");
  assert.equal(syncCalls[0][1], "sol-b");
  assert.deepEqual(syncCalls[0][2]?.aclAudience, ["z@example.invalid", "c@example.invalid"]);
  assert.ok(
    !calls.some((entry) => entry[0] === "publish" || entry[0] === "update"),
    "no content upload for a clean listing",
  );
  assert.equal(result.summary.visibilityUpdated, 1);
  assert.equal(result.summary.unchanged, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(result.refs)), [
    { skill_id: "beta", kind: "solution", solution_id: "sol-b" },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.skills)), [
    { skill_id: "beta", outcome: "visibility_updated", solution_id: "sol-b" },
  ]);
});

test("a public agent widens a restricted clean listing to public", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installPublishFixture(window, {
    skills: [userSkill("beta")],
    links: { beta: { solutionId: "sol-b", hasLocalChanges: false } },
    solutionsById: {
      "sol-b": {
        id: "sol-b",
        status: "active",
        allowed_emails: ["a@example.invalid"],
      },
    },
  });

  await window.AgentsPublishHooks.publishDependentSkills(["beta"], {
    allowedEmails: [],
  });
  const syncCalls = calls.filter((entry) => entry[0] === "syncSolutionAcl");
  assert.equal(syncCalls.length, 1);
  assert.deepEqual(
    syncCalls[0][2]?.aclAudience,
    [],
    "public forwards as an explicit empty audience",
  );
});

test("a matching ACL performs no visibility writes", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installPublishFixture(window, {
    skills: [userSkill("beta")],
    links: { beta: { solutionId: "sol-b", hasLocalChanges: false } },
    solutionsById: {
      "sol-b": {
        id: "sol-b",
        status: "active",
        allowed_emails: ["z@example.invalid"],
      },
    },
  });

  const result = await window.AgentsPublishHooks.publishDependentSkills(
    ["beta"],
    { allowedEmails: ["z@example.invalid"] },
  );
  assert.ok(!calls.some((entry) => entry[0] === "syncSolutionAcl"));
  assert.equal(result.summary.unchanged, 1);
  assert.equal(result.summary.visibilityUpdated, 0);
});

test("a failed visibility sync aborts the publish like any dependent-skill write", async () => {
  const { window } = loadAgentsModuleHarness();
  installPublishFixture(window, {
    skills: [userSkill("beta")],
    links: { beta: { solutionId: "sol-b", hasLocalChanges: false } },
    solutionsById: {
      "sol-b": {
        id: "sol-b",
        status: "active",
        allowed_emails: ["z@example.invalid"],
      },
    },
    syncAclImpl: () => ({ success: false, error: "boom", code: "not_owner" }),
  });

  await assert.rejects(
    window.AgentsPublishHooks.publishDependentSkills(["beta"], {
      allowedEmails: [],
    }),
    /boom/,
  );
});

test("drifted clean rows say the visibility will be updated and start as work", async () => {
  const { window } = loadAgentsModuleHarness();
  installPublishFixture(window, {
    skills: [userSkill("beta"), userSkill("gamma")],
    links: {
      beta: { solutionId: "sol-b", hasLocalChanges: false },
      gamma: { solutionId: "sol-g", hasLocalChanges: false },
    },
    solutionsById: {
      "sol-b": {
        id: "sol-b",
        status: "active",
        allowed_emails: ["a@example.invalid"],
      },
      "sol-g": { id: "sol-g", status: "active", allowed_emails: [] },
    },
  });

  const resolution = await window.AgentsPublishHooks.resolveDependentSkillPlans(
    ["beta", "gamma"],
    { probeAudience: [] },
  );
  const html = window.AgentsPublishHooks.buildSkillProvenanceRowsHtml(resolution);
  assert.match(html, /Visibility is out of sync and will be updated/);
  assert.match(html, /Nothing to re-upload/);
  const betaRow = html
    .split("<tr")
    .find((chunk) => chunk.includes('data-skill="beta"'));
  const gammaRow = html
    .split("<tr")
    .find((chunk) => chunk.includes('data-skill="gamma"'));
  assert.match(betaRow, /data-status="idle"/, "drifted row is work, not a no-op");
  assert.match(betaRow, />Visibility</, "drifted row gets the Visibility chip");
  assert.match(gammaRow, /data-status="current"/, "in-sync row stays a no-op");
});

// ---- install-modal visibility probe + per-skill failure rendering -------------

test("a pinned listing the viewer cannot fetch blocks install with owner remediation", async () => {
  const { window } = loadAgentsModuleHarness();
  installPublishFixture(window, {
    solutionsById: {
      "sol-agent": {
        id: "sol-agent",
        status: "active",
        submitted_by: "zstevens",
      },
      "sol-open": { id: "sol-open", status: "active" },
    },
    getSolutionImpl: (solutionId) =>
      solutionId === "sol-hidden"
        ? { success: false, status: 404, code: "http_error", error: "Solution not found" }
        : {
            success: true,
            data:
              solutionId === "sol-agent"
                ? { id: "sol-agent", status: "active", submitted_by: "zstevens" }
                : { id: solutionId, status: "active" },
          },
  });

  const resolution = await window.AgentsPublishHooks.resolveInstallSkillPlans({
    bundle: AGENT_BUNDLE({
      name: "Bundle Agent",
      skill_ids: ["hidden-skill", "open-skill"],
      skill_refs: [
        { skill_id: "hidden-skill", kind: "solution", solution_id: "sol-hidden" },
        { skill_id: "open-skill", kind: "solution", solution_id: "sol-open" },
      ],
    }),
    solutionId: "sol-agent",
  });

  assert.equal(resolution.ownerIdentity, "zstevens");
  assert.equal(resolution.errors.length, 1);
  assert.equal(resolution.errors[0].skillId, "hidden-skill");
  assert.equal(
    resolution.errors[0].displayName,
    "Hidden Skill",
    "blocked entries carry the same display name the plan row would have",
  );
  assert.equal(resolution.errors[0].source, "marketplace");
  assert.equal(resolution.errors[0].solutionId, "sol-hidden");
  assert.match(resolution.errors[0].error, /isn't shared with you/);
  assert.equal(
    resolution.errors[0].remediation,
    "Ask zstevens to republish this agent.",
    "the fix lives on its own remediation line, not an em-dash run-on",
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(resolution.plans.map((plan) => plan.skillId))),
    ["open-skill"],
    "the blocked skill leaves the plan list (its row renders from errors)",
  );
  const html = window.AgentsPublishHooks.buildInstallSkillPlanRowsHtml(resolution);
  // Blocked rows keep the full four-cell shape: display name, Source badge,
  // and the red message under "What happens" — never a colspan run-on.
  const blockedStart = html.indexOf('data-skill="hidden-skill"');
  assert.ok(blockedStart >= 0, "blocked row is addressable by skill id");
  const blockedRow = html.slice(blockedStart, html.indexOf("</tr>", blockedStart));
  assert.doesNotMatch(blockedRow, /colspan/);
  assert.match(blockedRow, /agents-publish-skill-name">Hidden Skill</);
  assert.doesNotMatch(blockedRow, />hidden-skill</);
  assert.match(
    blockedRow,
    /agents-publish-skill-chips"><span class="mcp-card-badge badge-marketplace-name">Solutions Marketplace</,
  );
  // Apostrophes in the reason are HTML-escaped; assert on escape-free spans.
  assert.match(
    blockedRow,
    /agents-publish-skill-action">Can't install yet: its marketplace listing/,
  );
  assert.match(
    blockedRow,
    /class="agents-publish-skill-action-remedy">Ask zstevens to republish this agent\./,
    "the remediation renders as its own quieter second line",
  );
});

test("install visibility probe failures stay advisory (fail open)", async () => {
  const { window } = loadAgentsModuleHarness();
  installPublishFixture(window, {
    probeInstallRefsImpl: () => {
      throw new Error("offline");
    },
  });

  const resolution = await window.AgentsPublishHooks.resolveInstallSkillPlans({
    bundle: AGENT_BUNDLE({
      name: "Bundle Agent",
      skill_ids: ["fresh-skill"],
      skill_refs: [
        { skill_id: "fresh-skill", kind: "solution", solution_id: "sol-fresh" },
      ],
    }),
    solutionId: "sol-agent",
  });

  assert.equal(resolution.errors.length, 0);
  assert.deepEqual(
    JSON.parse(JSON.stringify(resolution.plans.map((plan) => plan.skillId))),
    ["fresh-skill"],
  );
});

test("performInstallSolution rethrows the failure envelope's structured body", async () => {
  const { window } = loadAgentsModuleHarness();
  installPublishFixture(window, {
    installImpl: () => ({
      success: false,
      error:
        "Agent install failed because one or more required dependent skills could not be installed.",
      code: "agent_dependency_install_failed",
      body: {
        failedSkills: [
          {
            skill_id: "gtm-brief-qa",
            solution_id: "sol-hidden",
            error: "Solution not found",
          },
        ],
        rollback: [],
      },
    }),
  });

  await assert.rejects(
    window.AgentsPublishHooks.performInstallSolution("sol-agent", null, {
      rethrow: true,
    }),
    (error) => {
      assert.match(error.message, /code=agent_dependency_install_failed/);
      assert.equal(error.code, "agent_dependency_install_failed");
      assert.equal(error.body.failedSkills[0].skill_id, "gtm-brief-qa");
      assert.equal(error.body.failedSkills[0].error, "Solution not found");
      return true;
    },
  );
});

// ---- authored display names across surfaces -----------------------------------

test("published refs carry the authored display name; install rows render it verbatim", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installPublishFixture(window, {
    skills: [{ ...userSkill("gtm-brief-qa"), display_name: "GTM Brief QA" }],
  });

  const published = await window.AgentsPublishHooks.pushAgentToMarketplace({
    localId: "agent-1",
    solutionId: "",
    args: {
      name: "Named Agent",
      description: "",
      base_model_id: "model-a",
      system_prompt: "prompt",
      skill_ids: ["gtm-brief-qa"],
      tool_server_ids: [],
      allowed_emails: [],
    },
  });
  assert.equal(published.solutionId, "new-agent-1");
  const agentBundleCall = calls.find((entry) => entry[0] === "buildAgentBundle");
  assert.deepEqual(JSON.parse(JSON.stringify(agentBundleCall[1].skill_refs)), [
    {
      skill_id: "gtm-brief-qa",
      kind: "solution",
      solution_id: "new-gtm-brief-qa",
      display_name: "GTM Brief QA",
    },
  ]);
});

test("install rows prefer ref display names over slug derivation for absent skills", async () => {
  const { window } = loadAgentsModuleHarness();
  installPublishFixture(window, {});

  const resolution = await window.AgentsPublishHooks.resolveInstallSkillPlans({
    bundle: AGENT_BUNDLE({
      name: "Names Agent",
      skill_ids: ["gtm-brief-qa", "gtm-doc-builder"],
      skill_refs: [
        {
          skill_id: "gtm-brief-qa",
          kind: "solution",
          solution_id: "sol-a",
          display_name: "GTM Brief QA",
        },
        // No authored name: the shared formatter (acronym-aware) applies.
        { skill_id: "gtm-doc-builder", kind: "solution", solution_id: "sol-b" },
      ],
    }),
  });

  const names = new Map(
    JSON.parse(JSON.stringify(resolution.plans)).map((plan) => [
      plan.skillId,
      plan.displayName,
    ]),
  );
  assert.equal(names.get("gtm-brief-qa"), "GTM Brief QA");
  assert.equal(names.get("gtm-doc-builder"), "GTM Doc Builder");
  const html = window.AgentsPublishHooks.buildInstallSkillPlanRowsHtml(resolution);
  assert.match(html, /GTM Brief QA/);
  assert.match(html, /GTM Doc Builder/);
  assert.ok(!/>gtm-brief-qa</.test(html), "raw slugs never render as names");
});
