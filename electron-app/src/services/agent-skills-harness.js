// Shared behavioral-test harness for the renderer's agent-skills.js.
//
// agent-skills.js is an ES module (imports marked + local helpers), so it is
// esbuild-bundled to an IIFE once per process and evaluated in a vm context
// with a FakeElement DOM, a recording window.electronAPI, and recording
// confirm/discard modal fakes — the same pattern as
// agent-skills-reclaim-confirm.unit.test.js, generalized so the inline-page,
// provenance, and image-viewer suites can drive real flows (loadSkills,
// openSkillPage via window.openSkillDetailsModal, page actions, file tabs).
//
// The REAL skill-card-renderer.js is evaluated into the same context first, so
// list rendering exercises the actual shared card shell.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const esbuild = require("esbuild");

const COMPONENTS_DIR = path.join(__dirname, "..", "renderer", "components");
const AGENT_SKILLS_PATH = path.join(COMPONENTS_DIR, "agent-skills.js");
const SKILL_CARD_RENDERER_PATH = path.join(
  COMPONENTS_DIR,
  "skill-card-renderer.js",
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

function escapeHtmlText(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
    this.style = { display: "" };
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.dataset = {};
    this.attributes = {};
    this.value = "";
    this.disabled = false;
    this.isConnected = true;
    this.parentElement = null;
    this.rect = null;
    this.offsetWidth = 0;
    this.offsetHeight = 0;
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this._innerHTML = "";
    this._textContent = "";
    // querySelector auto-vivifies (and remembers) one child per selector so
    // production code that wires innerHTML-rendered chrome finds something to
    // attach listeners to; querySelectorAll stays test-configured.
    this.children = new Map();
    this.qsaResults = new Map();
  }

  get className() {
    return [...this.classList.classes].join(" ");
  }
  set className(value) {
    this.classList.classes = new Set(String(value ?? "").split(/\s+/).filter(Boolean));
  }
  get innerHTML() {
    return this._innerHTML;
  }
  set innerHTML(html) {
    this._innerHTML = String(html ?? "");
  }
  get textContent() {
    return this._textContent;
  }
  // Mirror the real DOM's escaping so agent-skills.js's escapeHtml() —
  // div.textContent = text; return div.innerHTML — behaves faithfully.
  set textContent(text) {
    this._textContent = String(text ?? "");
    this._innerHTML = escapeHtmlText(text);
  }
  // <template>.content shim for sanitizeRenderedHtml: no scriptable nodes.
  get content() {
    return { querySelectorAll: () => [] };
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  removeEventListener() {}
  // Production re-creates elements via innerHTML on each render; the single
  // auto-vivified stand-in accumulates one listener per render, so dispatch
  // invokes only the MOST RECENT handler (the current render's wiring).
  dispatch(type, event = {}) {
    const handlers = this.listeners.get(type) || [];
    const handler = handlers[handlers.length - 1];
    if (!handler) return;
    handler({
      preventDefault() {},
      stopPropagation() {},
      target: this,
      currentTarget: this,
      ...event,
    });
  }
  click(event = {}) {
    this.dispatch("click", event);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
      ? this.attributes[name]
      : null;
  }
  getBoundingClientRect() {
    return (
      this.rect || { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }
    );
  }
  closest() {
    return null;
  }
  querySelector(selector) {
    if (!this.children.has(selector)) {
      this.children.set(selector, new FakeElement(selector));
    }
    return this.children.get(selector);
  }
  querySelectorAll(selector) {
    return this.qsaResults.get(selector) || [];
  }
  appendChild(child) {
    if (child) child.parentElement = this;
    return child;
  }
  insertAdjacentHTML(_position, html) {
    this._innerHTML += String(html ?? "");
  }
  remove() {}
  // Mirrors the browser: focusing a text control whose caret sits at the end
  // scrolls it to the caret unless preventScroll is passed. Tests can assert
  // scrollTop stayed 0 without the assertion being vacuous.
  focus(options) {
    this.focusCalls = this.focusCalls || [];
    this.focusCalls.push(options);
    if (!options?.preventScroll) this.scrollTop = 999;
  }
  blur() {}
  select() {}
  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  scrollIntoView() {}
}

// Let void-async UI flows (click handlers that fire async work) settle.
async function flushAsync(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Build the vm context, run the REAL skill-card-renderer + the bundled
 * agent-skills.js, and return recording handles.
 *
 * options:
 *   skills:               getSkills() payload (array)
 *   links:                listSkillLinks() links object
 *   publishedSolutionIds: string[] — listPublished("skills") viewer-owned ids
 *   skillFilesByName:     { [skillName]: { files, basePath } } (getSkillFiles)
 *   fileReads:            { [fullPath]: readSkillFile result }
 *   agentUsage:           [{ id, name, leaves: string[] }] —
 *                         listAgentSkillUsage() agents payload
 *   electronAPI:          shallow overrides merged over the recording API
 *   marketplace:          shallow overrides merged over api.aiMarketplace
 *   innerWidth/innerHeight: viewport for dropdown positioning
 */
function loadAgentSkillsHarness(options = {}) {
  const {
    skills = [],
    links = {},
    publishedSolutionIds = [],
    skillFilesByName = {},
    fileReads = {},
    agentUsage = [],
    electronAPI: electronApiOverrides = {},
    marketplace: marketplaceOverrides = {},
    innerWidth = 1400,
    innerHeight = 900,
  } = options;

  const source = bundleAgentSkills();
  const rendererSource = fs.readFileSync(SKILL_CARD_RENDERER_PATH, "utf8");

  const elements = new Map();
  const docSelectorElements = new Map();
  const docQsaResults = new Map();
  const documentObject = {
    readyState: "complete",
    body: new FakeElement("body"),
    createElement: (tag) => new FakeElement(tag),
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, new FakeElement(id));
      return elements.get(id);
    },
    querySelector: (selector) => {
      if (!docSelectorElements.has(selector)) {
        docSelectorElements.set(selector, new FakeElement(selector));
      }
      return docSelectorElements.get(selector);
    },
    querySelectorAll: (selector) => docQsaResults.get(selector) || [],
    addEventListener() {},
    removeEventListener() {},
  };

  const calls = {
    getSkills: 0,
    listAgentSkillUsage: 0,
    listSkillLinks: 0,
    listPublished: [],
    getSkillFiles: [],
    readSkillFile: [],
    writeSkillFile: [],
    markSkillLinkDirty: [],
    duplicateSkill: [],
    deleteSkill: [],
    openSkillFolder: [],
    exportSkill: [],
    openExternal: [],
    buildPublishBundle: [],
    publish: [],
    update: [],
    delete: [],
    getSkillLink: [],
    setSkillLink: [],
    clearSkillLink: [],
    reclaimSkill: [],
    install: [],
    search: [],
    getBundle: [],
    getMarketplaceSkillBundle: [],
    installMarketplaceSkill: [],
    updateMarketplaceSkill: [],
    uninstallMarketplaceSkill: [],
    invalidateMarketplaceSkillLookups: 0,
    windowConfirm: [],
  };
  const notifications = [];
  const confirmCalls = [];
  const discardCalls = [];

  const defaultSkillFilesFor = (skillName) => ({
    success: true,
    basePath: `/skills/${skillName}`,
    files: [
      {
        name: "SKILL.md",
        relativePath: "SKILL.md",
        fullPath: `/skills/${skillName}/SKILL.md`,
        type: "file",
      },
    ],
  });

  const aiMarketplace = {
    listPublished: async (type) => {
      calls.listPublished.push(type);
      return {
        success: true,
        data: { solutions: publishedSolutionIds.map((id) => ({ id })) },
      };
    },
    listSkillLinks: async () => {
      calls.listSkillLinks += 1;
      return { success: true, links };
    },
    markSkillLinkDirty: async (name) => {
      calls.markSkillLinkDirty.push(name);
      return { success: true };
    },
    getSkillLink: async (name) => {
      calls.getSkillLink.push(name);
      return { success: true, link: links[name] || null };
    },
    setSkillLink: async (name, solutionId) => {
      calls.setSkillLink.push([name, solutionId]);
      return { success: true };
    },
    clearSkillLink: async (name) => {
      calls.clearSkillLink.push(name);
      return { success: true };
    },
    buildPublishBundle: async (input) => {
      calls.buildPublishBundle.push(input);
      return {
        success: true,
        data: { type: "skills", payload: { name: input?.skill?.name } },
      };
    },
    publish: async (input, opts) => {
      calls.publish.push([input, opts]);
      return { success: true, data: { id: "sol-new" } };
    },
    update: async (solutionId, input, opts) => {
      calls.update.push([solutionId, input, opts]);
      return { success: true };
    },
    delete: async (solutionId) => {
      calls.delete.push(solutionId);
      return { success: true };
    },
    reclaimSkill: async (name) => {
      calls.reclaimSkill.push(name);
      return { success: true, data: { local_skill_id: name } };
    },
    install: async (solutionId, opts) => {
      calls.install.push([solutionId, opts]);
      return { success: true };
    },
    search: async (params) => {
      calls.search.push(params);
      return { success: true, data: { results: [] } };
    },
    getBundle: async (solutionId) => {
      calls.getBundle.push(solutionId);
      return {
        success: true,
        data: {
          type: "skills",
          payload: { name: String(solutionId), skill_md: "# default\n" },
        },
      };
    },
    ...marketplaceOverrides,
  };

  const electronAPI = {
    platform: "darwin",
    getSkills: async () => {
      calls.getSkills += 1;
      return { success: true, skills, defaultLogo: null };
    },
    listAgentSkillUsage: async () => {
      calls.listAgentSkillUsage += 1;
      return { success: true, agents: agentUsage };
    },
    getSkillFiles: async (skillName) => {
      calls.getSkillFiles.push(skillName);
      return skillFilesByName[skillName] ?? defaultSkillFilesFor(skillName);
    },
    readSkillFile: async (filePath) => {
      calls.readSkillFile.push(filePath);
      return (
        fileReads[filePath] ?? {
          success: true,
          fileKind: "text",
          content: `contents of ${filePath}`,
        }
      );
    },
    writeSkillFile: async (filePath, content) => {
      calls.writeSkillFile.push([filePath, content]);
      return { success: true };
    },
    duplicateSkill: async (skillPath, preferredName, opts) => {
      calls.duplicateSkill.push([skillPath, preferredName, opts]);
      return { success: true, skillName: preferredName };
    },
    deleteSkill: async (skillName, skillPath) => {
      calls.deleteSkill.push([skillName, skillPath]);
      return { success: true };
    },
    openSkillFolder: async (skillPath) => {
      calls.openSkillFolder.push(skillPath);
      return { success: true };
    },
    exportSkill: async (skillPath) => {
      calls.exportSkill.push(skillPath);
      return { success: true, path: "/tmp/export.zip" };
    },
    updateMarketplaceSkill: async (marketplaceId, skillId, opts) => {
      calls.updateMarketplaceSkill.push([marketplaceId, skillId, opts]);
      return { success: true };
    },
    getMarketplaceSkillBundle: async (marketplaceId, skillId, pluginName = null) => {
      calls.getMarketplaceSkillBundle.push([marketplaceId, skillId, pluginName]);
      return {
        success: true,
        installed: false,
        bundle: {
          type: "skills",
          id: skillId,
          payload: {
            name: String(skillId),
            skill_md: `# ${skillId}\n`,
            references: [],
            scripts: [],
          },
        },
      };
    },
    installMarketplaceSkill: async (...args) => {
      calls.installMarketplaceSkill.push(args);
      return { success: true, localPath: "", version: "1.0" };
    },
    uninstallMarketplaceSkill: async (marketplaceId, skillId, pluginName = null) => {
      calls.uninstallMarketplaceSkill.push([marketplaceId, skillId, pluginName]);
      return { success: true };
    },
    getUsername: async () => ({ username: "dsantiago" }),
    openExternal: (url) => {
      calls.openExternal.push(url);
    },
    logToMain: () => {},
    aiMarketplace,
    ...electronApiOverrides,
  };

  const windowObject = {
    appState: {},
    innerWidth,
    innerHeight,
    electronAPI,
    showNotification: (message, kind) => notifications.push([kind, message]),
    // Recording modal fakes: capture options; the TEST decides when (and
    // whether) to run onConfirm/onDiscard.
    showAgentsConfirmModal: (opts) => {
      confirmCalls.push(opts);
    },
    showAgentsDiscardModal: (opts) => {
      discardCalls.push(opts);
    },
    // Native confirm must never be reached by app-styled flows; record + deny.
    confirm: (message) => {
      calls.windowConfirm.push(message);
      return false;
    },
    open: () => {},
    AgentsPublishHooks: {
      invalidateMarketplaceSkillLookups: () => {
        calls.invalidateMarketplaceSkillLookups += 1;
      },
    },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (cb) => {
      cb();
      return 0;
    },
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
    // agent-skills.js references some window globals as bare identifiers; in a
    // vm context those resolve against the context object.
    showNotification: windowObject.showNotification,
    requestAnimationFrame: windowObject.requestAnimationFrame,
    // Remote-bundle previews decode base64 file contents (Node globals; the
    // real renderer has them natively).
    atob,
    btoa,
    TextDecoder,
    TextEncoder,
    Uint8Array,
  };
  context.globalThis = context;

  // Real shared card renderer first (agent-skills delegates its card shell).
  vm.runInNewContext(rendererSource, context, {
    filename: SKILL_CARD_RENDERER_PATH,
  });
  vm.runInNewContext(source, context, { filename: AGENT_SKILLS_PATH });

  return {
    window: windowObject,
    document: documentObject,
    elements,
    docSelectorElements,
    docQsaResults,
    getElementById: documentObject.getElementById,
    calls,
    notifications,
    confirmCalls,
    discardCalls,
  };
}

module.exports = {
  FakeClassList,
  FakeElement,
  bundleAgentSkills,
  flushAsync,
  loadAgentSkillsHarness,
};
