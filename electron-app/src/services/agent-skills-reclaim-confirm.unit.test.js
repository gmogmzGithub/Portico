// Behavior tests for the Skills tab's "Convert to editable copy" confirm
// gate: the reclaim IPC must fire only after the user confirms, and
// failures must surface as a throw so the shared confirm modal renders the
// inline error under its busy spinner.
//
// Harness: agent-skills.js is an ES module (imports marked), so it is
// esbuild-bundled to an IIFE in a temp dir, then evaluated in a vm context
// with a FakeElement DOM — the agent-skills twin of the agents.js harness
// in agents-dependent-skill-publish.unit.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const esbuild = require("esbuild");

const AGENT_SKILLS_PATH = path.join(
  __dirname,
  "..",
  "renderer",
  "components",
  "agent-skills.js",
);

let bundledSource = null;
function bundleAgentSkills() {
  if (bundledSource) return bundledSource;
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-skills-harness-"));
  const outfile = path.join(outDir, "agent-skills.bundle.js");
  esbuild.buildSync({
    entryPoints: [AGENT_SKILLS_PATH],
    bundle: true,
    outfile,
    format: "iife",
    platform: "browser",
    logLevel: "silent",
  });
  bundledSource = fs.readFileSync(outfile, "utf8");
  return bundledSource;
}

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
    const target = force ?? !this.classes.has(name);
    if (target) this.classes.add(name);
    else this.classes.delete(name);
    return target;
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
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  removeEventListener() {}
  setAttribute() {}
  removeAttribute() {}
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
  focus() {}
}

function loadAgentSkillsHarness({ reclaimImpl } = {}) {
  const source = bundleAgentSkills();
  const elements = new Map();
  const documentObject = {
    readyState: "complete",
    body: new FakeElement("body"),
    createElement: (tag) => new FakeElement(tag),
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, new FakeElement(id));
      return elements.get(id);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };

  const reclaimCalls = [];
  const confirmCalls = [];
  const notifications = [];
  const windowObject = {
    appState: {},
    electronAPI: {
      getSkills: async () => ({ success: true, skills: [] }),
      aiMarketplace: {
        reclaimSkill: async (name) => {
          reclaimCalls.push(name);
          if (reclaimImpl) return reclaimImpl(name);
          return { success: true, data: { local_skill_id: name } };
        },
        listPublished: async () => ({ success: true, data: { solutions: [] } }),
        listSkillLinks: async () => ({ success: true, links: {} }),
      },
      logToMain: () => {},
    },
    showNotification: (message, kind) => notifications.push([kind, message]),
    // Recording confirm-modal fake: captures options; the test decides when
    // (and whether) to run onConfirm.
    showAgentsConfirmModal: (options) => {
      confirmCalls.push(options);
    },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  };
  windowObject.window = windowObject;

  const context = {
    window: windowObject,
    document: documentObject,
    console,
    setTimeout,
    clearTimeout,
    Promise,
    Math,
    Date,
    URL,
    HTMLElement: FakeElement,
    navigator: { clipboard: { writeText: async () => {} } },
    // agent-skills.js references some window globals as bare identifiers;
    // in a vm context those resolve against the context object.
    showNotification: windowObject.showNotification,
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: AGENT_SKILLS_PATH });

  return { window: windowObject, reclaimCalls, confirmCalls, notifications };
}

test("reclaim asks for confirmation and fires the IPC only after confirm", async () => {
  const { window, reclaimCalls, confirmCalls } = loadAgentSkillsHarness();
  const skill = {
    name: "ai-marketplace/notes",
    display_name: "Notes",
    source: "marketplace",
    marketplace_id: "ai-marketplace",
    marketplace_solution_id: "sol-notes",
  };

  window.AgentSkillsHooks.confirmReclaimInstalledSkillCopy(skill);

  assert.equal(confirmCalls.length, 1, "the confirm modal opens");
  assert.equal(confirmCalls[0].title, "Convert to editable copy?");
  assert.match(confirmCalls[0].message, /Notes/);
  // The solution id renders as the modal's meta chip (with copy button), not
  // inline in the sentence — same shape as the unpublish confirms.
  assert.equal(confirmCalls[0].meta?.badge, "sol-notes");
  assert.doesNotMatch(confirmCalls[0].message, /sol-notes/);
  assert.equal(confirmCalls[0].confirmLabel, "Convert");
  assert.equal(
    reclaimCalls.length,
    0,
    "the reclaim IPC must not fire before the user confirms",
  );

  await confirmCalls[0].onConfirm();
  assert.deepEqual(reclaimCalls, ["ai-marketplace/notes"]);
});

test("a failed reclaim throws so the confirm modal shows the inline error", async () => {
  const { window, confirmCalls } = loadAgentSkillsHarness({
    reclaimImpl: async () => ({ success: false, error: "listing is foreign" }),
  });

  window.AgentSkillsHooks.confirmReclaimInstalledSkillCopy({
    name: "ai-marketplace/notes",
    display_name: "Notes",
    marketplace_solution_id: "sol-notes",
  });
  await assert.rejects(confirmCalls[0].onConfirm(), /listing is foreign/);
});

test("a successful reclaim notifies with the final editable name", async () => {
  const { window, confirmCalls, notifications } = loadAgentSkillsHarness({
    reclaimImpl: async () => ({
      success: true,
      data: { local_skill_id: "notes-2" },
    }),
  });

  window.AgentSkillsHooks.confirmReclaimInstalledSkillCopy({
    name: "ai-marketplace/notes",
    display_name: "Notes",
    marketplace_solution_id: "sol-notes",
  });
  await confirmCalls[0].onConfirm();

  const success = notifications.find(([kind]) => kind === "success");
  assert.ok(success, "success toast fires");
  assert.match(success[1], /notes-2/);
});
