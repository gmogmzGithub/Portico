// Shared behavioral-test harness for the renderer's marketplaces.js (the Git
// marketplaces browse + modals component).
//
// marketplaces.js is plain script (no ES imports), so it evaluates directly in
// a vm context with the FakeElement DOM and a recording window.electronAPI —
// the same pattern as agent-skills-harness.js. Module init runs at eval time
// (document.readyState is "complete"), wiring the add/remove/details modal
// listeners onto auto-vivified elements.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { FakeElement, flushAsync } = require("./agent-skills-harness");

const MARKETPLACES_PATH = path.join(
  __dirname,
  "..",
  "renderer",
  "components",
  "marketplaces.js",
);
// The real shared card renderer evaluates first (same as index.html load
// order) so marketplaces.js exercises the genuine SkillCardRenderer —
// including the shared kebab-menu behavior — instead of a stub.
const SKILL_CARD_RENDERER_PATH = path.join(
  __dirname,
  "..",
  "renderer",
  "components",
  "skill-card-renderer.js",
);

// The vm context has no require(), so marketplaces.js resolves its URL
// helper via globalThis.marketplaceSourceUrl — inject the real module.
const marketplaceSourceUrl = require("../renderer/components/marketplace-source-url");

/**
 * options:
 *   config:      getMarketplaces() `data` payload ({marketplaces, installedSkills})
 *   electronAPI: shallow overrides merged over the recording API
 *   marketplace: shallow overrides merged over api.aiMarketplace
 */
function loadMarketplacesHarness(options = {}) {
  const {
    config = { version: "1.0", marketplaces: [], installedSkills: [] },
    electronAPI: electronApiOverrides = {},
    marketplace: marketplaceOverrides = {},
  } = options;

  const source = fs.readFileSync(MARKETPLACES_PATH, "utf8");
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
    getMarketplaces: 0,
    listAgentSkillUsage: 0,
    addMarketplace: [],
    removeMarketplace: [],
    syncMarketplace: [],
    syncAllMarketplaces: 0,
    checkSkillUpdates: 0,
    getMarketplaceSkills: [],
    getMarketplaceSkillsCached: [],
    installMarketplaceSkill: [],
    uninstallMarketplaceSkill: [],
    updateMarketplaceSkill: [],
    detachMarketplaceSkillToUserSkill: [],
    copyToClipboard: [],
    openExternal: [],
    aiMarketplaceInstall: [],
    windowConfirm: [],
  };
  const notifications = [];
  const confirmCalls = [];

  const aiMarketplace = {
    install: async (solutionId, opts) => {
      calls.aiMarketplaceInstall.push([solutionId, opts]);
      return { success: true };
    },
    ...marketplaceOverrides,
  };

  const electronAPI = {
    getMarketplaces: async () => {
      calls.getMarketplaces += 1;
      return { success: true, data: config };
    },
    listAgentSkillUsage: async () => {
      calls.listAgentSkillUsage += 1;
      return { success: true, agents: [] };
    },
    addMarketplace: async (sourceInput) => {
      calls.addMarketplace.push(sourceInput);
      return {
        success: true,
        marketplace: { id: "added", name: "Added Marketplace" },
      };
    },
    removeMarketplace: async (marketplaceId, removeSkills) => {
      calls.removeMarketplace.push([marketplaceId, removeSkills]);
      return { success: true };
    },
    syncMarketplace: async (marketplaceId) => {
      calls.syncMarketplace.push(marketplaceId);
      return { success: true, marketplace: { marketplaceVersion: "1.0.0" } };
    },
    syncAllMarketplaces: async () => {
      calls.syncAllMarketplaces += 1;
      return { success: true, results: [] };
    },
    checkSkillUpdates: async () => {
      calls.checkSkillUpdates += 1;
      return { success: true, updates: [], hasUpdates: false };
    },
    getMarketplaceSkills: async (marketplaceId) => {
      calls.getMarketplaceSkills.push(marketplaceId);
      return { success: true, skills: [], marketplace: null };
    },
    getMarketplaceSkillsCached: async (marketplaceId) => {
      calls.getMarketplaceSkillsCached.push(marketplaceId);
      return { success: false, error: "no cached manifest" };
    },
    installMarketplaceSkill: async (...args) => {
      calls.installMarketplaceSkill.push(args);
      return { success: true, localPath: "", version: "1.0" };
    },
    uninstallMarketplaceSkill: async (...args) => {
      calls.uninstallMarketplaceSkill.push(args);
      return { success: true };
    },
    updateMarketplaceSkill: async (...args) => {
      calls.updateMarketplaceSkill.push(args);
      return { success: true, version: "1.1" };
    },
    detachMarketplaceSkillToUserSkill: async (...args) => {
      calls.detachMarketplaceSkillToUserSkill.push(args);
      return { success: true, skillName: "detached" };
    },
    copyToClipboard: async (text) => {
      calls.copyToClipboard.push(text);
      return { success: true };
    },
    openExternal: async (url) => {
      calls.openExternal.push(url);
      return { success: true };
    },
    aiMarketplace,
    ...electronApiOverrides,
  };

  const windowObject = {
    appState: {},
    electronAPI,
    showNotification: (message, kind) => notifications.push([kind, message]),
    // Recording modal fake (same pattern as agent-skills-harness): capture
    // options; the TEST decides when (and whether) to run onConfirm.
    showAgentsConfirmModal: (opts) => {
      confirmCalls.push(opts);
    },
    // Native confirm must never be reached by app-styled flows; record + deny.
    confirm: (message) => {
      calls.windowConfirm.push(message);
      return false;
    },
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
    Date,
    Math,
    URL,
    marketplaceSourceUrl,
  };
  context.globalThis = context;

  vm.runInNewContext(rendererSource, context, {
    filename: SKILL_CARD_RENDERER_PATH,
  });
  vm.runInNewContext(source, context, { filename: MARKETPLACES_PATH });

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
    // The vm sandbox itself: marketplaces.js top-level functions that are
    // never assigned onto window (syncMarketplace, render helpers, ...) are
    // reachable only here.
    context,
  };
}

module.exports = {
  FakeElement,
  flushAsync,
  loadMarketplacesHarness,
};
