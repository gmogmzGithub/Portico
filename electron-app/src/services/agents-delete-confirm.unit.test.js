// Behavior tests for the GUI agent delete/uninstall flows against the
// round-26 subagents delete_agent confirm gate: every GUI-initiated delete
// must carry confirm:true (the GUI's own confirm modals are the user
// consent), and {success:false} tool envelopes must surface their reason
// (`message` OR `error` — the gate and agent_not_found report via `error`).
// Harness mirrors agents-reclaim-conversion.unit.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const AGENTS_PATH = path.join(__dirname, "..", "renderer", "components", "agents.js");

const TOOL_DELETE = "subagents_delete_agent";

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

  toggle(name, force) {
    if (force === undefined) {
      if (this.classes.has(name)) this.classes.delete(name);
      else this.classes.add(name);
      return this.classes.has(name);
    }
    if (force) this.classes.add(name);
    else this.classes.delete(name);
    return Boolean(force);
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
    this.disabled = false;
    this.children = [];
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type).push(handler);
  }

  removeAttribute() {}

  setAttribute() {}

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
    this.children.push(child);
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
    "agents-confirm-meta",
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

  // Every core-MCP call the flows make, captured as [serverId, toolName, args].
  const mcpCalls = [];
  const notifications = [];

  const windowObject = {
    appState: { controlPlaneView: "mcp-servers" },
    electronAPI: {
      invokeMcpTool: async (serverId, toolName, args) => {
        mcpCalls.push([serverId, toolName, args]);
        if (toolName === TOOL_DELETE) {
          return { success: true, data: { success: true, id: args.model_id } };
        }
        return { success: true, data: { agents: [] } };
      },
      getSkills: async () => ({ success: true, skills: [] }),
      loadMcpServers: async () => ({ success: true, data: [] }),
      getUsername: async () => ({ username: "dsantiago" }),
      aiMarketplace: {
        listLinks: async () => ({ success: true, links: {} }),
        clearLink: async () => ({ success: true }),
      },
    },
    showNotification(message, kind) {
      notifications.push({ message: String(message), kind });
    },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
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
    navigator: {
      clipboard: { writeText: async () => {} },
    },
  };
  context.globalThis = context;

  for (const extra of extraSources) {
    vm.runInNewContext(extra.source, context, { filename: extra.path });
  }
  vm.runInNewContext(source, context, { filename: AGENTS_PATH });

  return { window: windowObject, elements, mcpCalls, notifications };
}

// The modal confirm handler and the perform* flows hop through several
// awaits; drain macrotasks so the whole chain settles.
async function flushAsync(rounds = 40) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function deleteCalls(mcpCalls) {
  return mcpCalls.filter(([, toolName]) => toolName === TOOL_DELETE);
}

test("performDeleteAgent invokes the delete tool with confirm:true", async () => {
  const { window, mcpCalls, notifications } = loadAgentsModuleHarness();

  await window.AgentsPublishHooks.performDeleteAgent("agent-x");

  const deletes = deleteCalls(mcpCalls);
  assert.equal(deletes.length, 1, "exactly one delete tool call");
  const [serverId, , args] = deletes[0];
  assert.equal(serverId, "subagents");
  // Spread: vm-realm objects fail strict deepEqual on prototype identity.
  assert.deepEqual({ ...args }, { model_id: "agent-x", confirm: true });
  assert.ok(
    notifications.some(
      (n) => n.kind === "success" && n.message === "Agent deleted.",
    ),
    "the success notification fires after the gated delete succeeds",
  );
});

test("uninstalling via the confirm modal deletes with confirm:true and notifies", async () => {
  const { window, elements, mcpCalls, notifications } = loadAgentsModuleHarness();
  window.electronAPI.aiMarketplace.listLinks = async () => ({
    success: true,
    links: { "agent-x": { relationship: "installed", solutionId: "sol-9" } },
  });

  await window.AgentsPublishHooks.uninstallSolution("sol-9");

  const modal = elements.get("agents-confirm-modal");
  assert.ok(modal.classList.contains("visible"), "the uninstall confirm opens");
  assert.equal(elements.get("agents-confirm-title").textContent, "Uninstall agent?");
  assert.equal(deleteCalls(mcpCalls).length, 0, "nothing deleted before consent");

  elements.get("agents-confirm-btn").click();
  await flushAsync();

  const deletes = deleteCalls(mcpCalls);
  assert.equal(deletes.length, 1, "exactly one delete tool call after consent");
  assert.deepEqual({ ...deletes[0][2] }, { model_id: "agent-x", confirm: true });
  assert.ok(
    notifications.some(
      (n) =>
        n.kind === "success" &&
        n.message === "Uninstalled. The marketplace listing was kept.",
    ),
    "the uninstall success notification fires",
  );
  assert.equal(modal.classList.contains("visible"), false, "the modal closes");
});

test("delete-tool failure envelopes surface message, then error, then a fallback", async () => {
  const { window } = loadAgentsModuleHarness();
  const respondWith = (envelope) => {
    window.electronAPI.invokeMcpTool = async (serverId, toolName, args) => {
      if (toolName === TOOL_DELETE) {
        return { success: true, data: envelope };
      }
      void serverId;
      void args;
      return { success: true, data: { agents: [] } };
    };
  };

  // The round-26 confirm gate (and agent_not_found) report via `error`.
  respondWith({ success: false, error: "Set confirm=true to delete the agent" });
  await assert.rejects(
    window.AgentsPublishHooks.performDeleteAgent("agent-x"),
    /Set confirm=true to delete the agent/,
  );

  respondWith({
    success: false,
    code: "agent_not_found",
    error: 'No agent found with id "agent-x".',
  });
  await assert.rejects(
    window.AgentsPublishHooks.performUninstallSolution("sol-9", "agent-x"),
    /No agent found with id "agent-x"\./,
  );

  // `message` keeps precedence when both are present.
  respondWith({ success: false, message: "message wins", error: "error loses" });
  await assert.rejects(
    window.AgentsPublishHooks.performDeleteAgent("agent-x"),
    /message wins/,
  );

  // Neither field: the generic fallback names the agent.
  respondWith({ success: false });
  await assert.rejects(
    window.AgentsPublishHooks.performDeleteAgent("agent-x"),
    /Failed to delete agent "agent-x"\./,
  );
});

test("a tombstoned marketplace copy (solution_not_found) still completes the local delete", async () => {
  const { window, mcpCalls, notifications } = loadAgentsModuleHarness();
  const clearedLinks = [];
  // Ops-layer shape for a soft-deleted listing: getOwnedSolutionForWrite
  // rejects with this code and message, and no HTTP status.
  window.electronAPI.aiMarketplace.delete = async () => ({
    success: false,
    code: "solution_not_found",
    error: "This AI Marketplace solution is already absent.",
  });
  window.electronAPI.aiMarketplace.clearLink = async (agentId) => {
    clearedLinks.push(agentId);
    return { success: true };
  };

  await window.AgentsPublishHooks.performDeleteAgent("agent-x", {
    link: { relationship: "published", solutionId: "sol-9" },
    alsoRemoveFromMarketplace: true,
  });

  const deletes = deleteCalls(mcpCalls);
  assert.equal(deletes.length, 1, "the local delete still runs");
  assert.deepEqual({ ...deletes[0][2] }, { model_id: "agent-x", confirm: true });
  assert.deepEqual(clearedLinks, ["agent-x"], "the stale marketplace link is dropped");
  assert.ok(
    notifications.some(
      (n) => n.kind === "success" && n.message === "Agent deleted.",
    ),
    "the flow ends in the plain local-delete success (marketplace copy was already gone)",
  );
  assert.ok(
    !notifications.some((n) => /not deleted/i.test(n.message)),
    "no dead-end failure notification",
  );
});

test("a genuinely failing marketplace removal aborts the local delete without a double period", async () => {
  const { window, mcpCalls, notifications } = loadAgentsModuleHarness();
  // Different code: a real failure, with an upstream message that already ends
  // in a period — the composed error must not read "….. Local agent not deleted."
  window.electronAPI.aiMarketplace.delete = async () => ({
    success: false,
    code: "backend_unavailable",
    error: "The marketplace backend is unavailable.",
  });

  await assert.rejects(
    window.AgentsPublishHooks.performDeleteAgent("agent-x", {
      link: { relationship: "published", solutionId: "sol-9" },
      alsoRemoveFromMarketplace: true,
    }),
    (error) => {
      assert.equal(
        error.message,
        "Failed to delete marketplace copy: The marketplace backend is unavailable. Local agent not deleted.",
      );
      assert.ok(!error.message.includes(".."), "no double period in the failure text");
      return true;
    },
  );

  assert.equal(deleteCalls(mcpCalls).length, 0, "the local agent survives");
  assert.ok(
    !notifications.some((n) => n.kind === "success"),
    "no success notification on a failed removal",
  );
});

test("a failing uninstall keeps the modal open and shows the tool error inline", async () => {
  const { window, elements, mcpCalls } = loadAgentsModuleHarness();
  window.electronAPI.aiMarketplace.listLinks = async () => ({
    success: true,
    links: { "agent-x": { relationship: "installed", solutionId: "sol-9" } },
  });
  window.electronAPI.invokeMcpTool = async (serverId, toolName, args) => {
    mcpCalls.push([serverId, toolName, args]);
    if (toolName === TOOL_DELETE) {
      return {
        success: true,
        data: { success: false, error: "Set confirm=true to delete the agent" },
      };
    }
    return { success: true, data: { agents: [] } };
  };

  await window.AgentsPublishHooks.uninstallSolution("sol-9");
  elements.get("agents-confirm-btn").click();
  await flushAsync();

  const modal = elements.get("agents-confirm-modal");
  assert.ok(modal.classList.contains("visible"), "the modal stays open on failure");
  const errorEl = elements.get("agents-confirm-error");
  assert.equal(errorEl.hidden, false, "the inline error row is shown");
  assert.match(errorEl.textContent, /Set confirm=true to delete the agent/);
  assert.equal(deleteCalls(mcpCalls).length, 1, "no silent retry");
});

test("the Discover unpublish modal keeps the id out of the copy and offers it as a copyable badge", async () => {
  const { window, elements } = loadAgentsModuleHarness();
  window.electronAPI.aiMarketplace.hasApiKey = async () => ({ hasKey: true });

  await window.AgentsPublishHooks.unpublishSolutionFromDiscover("sol-uuid-1234");
  await flushAsync();

  const modal = elements.get("agents-confirm-modal");
  assert.ok(modal.classList.contains("visible"), "the unpublish confirm opens");
  assert.equal(elements.get("agents-confirm-title").textContent, "Unpublish?");
  const message = elements.get("agents-confirm-message").textContent;
  assert.ok(
    !message.includes("sol-uuid-1234"),
    "the raw solution id stays out of the sentence copy",
  );
  const metaEl = elements.get("agents-confirm-meta");
  assert.equal(metaEl.hidden, false, "the id badge row renders");
  const chip = metaEl.children[0];
  assert.equal(chip.className, "agents-confirm-meta-badge");
  assert.equal(chip.textContent, "sol-uuid-1234");
  const copyBtn = metaEl.children[1];
  assert.equal(copyBtn.className, "agents-confirm-meta-copy");
  // No secondary action was configured — the placeholder button stays hidden.
  assert.equal(elements.get("agents-confirm-secondary-btn").hidden, true);
});
