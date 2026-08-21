const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const servicesDir = __dirname;
const apiSource = fs.readFileSync(path.join(servicesDir, "api.js"), "utf8");

test("api.js exposes marketplace REST routes that delegate to marketplaceService", () => {
  assert.match(apiSource, /apiApp\.get\('\/api\/marketplaces'/);
  assert.match(apiSource, /apiApp\.post\('\/api\/marketplaces'/);
  assert.match(apiSource, /apiApp\.post\('\/api\/marketplaces\/remove'/);
  assert.match(apiSource, /apiApp\.post\('\/api\/marketplaces\/sync'/);
  assert.match(apiSource, /apiApp\.post\('\/api\/marketplaces\/sync-all'/);
  assert.match(apiSource, /apiApp\.get\('\/api\/marketplaces\/:marketplaceId\/skills'/);
  assert.match(apiSource, /apiApp\.post\('\/api\/marketplaces\/skills\/install'/);
  assert.match(apiSource, /apiApp\.post\('\/api\/marketplaces\/skills\/uninstall'/);
  assert.match(apiSource, /apiApp\.post\('\/api\/marketplaces\/skills\/detach'/);
  assert.match(apiSource, /apiApp\.post\('\/api\/marketplaces\/skills\/check-updates'/);
  assert.match(apiSource, /apiApp\.post\('\/api\/marketplaces\/skills\/update'/);

  assert.match(apiSource, /marketplaceService\.loadMarketplacesConfig\(/);
  assert.match(apiSource, /marketplaceService\.addMarketplace\(/);
  assert.match(apiSource, /marketplaceService\.removeMarketplace\(/);
  assert.match(apiSource, /marketplaceService\.syncMarketplace\(/);
  assert.match(apiSource, /marketplaceService\.syncAllMarketplaces\(/);
  assert.match(apiSource, /marketplaceService\.getMarketplaceSkills\(/);
  assert.match(apiSource, /marketplaceService\.installMarketplaceSkill\(/);
  assert.match(apiSource, /marketplaceService\.uninstallMarketplaceSkill\(/);
  assert.match(apiSource, /marketplaceService\.detachMarketplaceSkillToUserSkill\(/);
  assert.match(apiSource, /marketplaceService\.checkSkillUpdates\(/);
  assert.match(apiSource, /marketplaceService\.updateMarketplaceSkill\(/);
  assert.match(apiSource, /function sendMarketplaceError\(res, error\)/);
});

// Behavioral wiring pin (converted from a legacy source-pin per the testing
// rules): load ipc.js with a recording marketplaceService stub, register the
// marketplace handlers, and invoke them — delegation is observed, not
// regexed. Harness pattern: set-mcp-disable-mode.unit.test.js.
function loadIpcWithMarketplaceStubs() {
  const ipcModulePath = require.resolve("./ipc");
  const originalLoad = Module._load;
  const previousIpc = require.cache[ipcModulePath];

  const calls = [];
  const record = (name, payload) => {
    calls.push({ name, ...payload });
  };

  const marketplaceServiceStub = {
    removeMarketplace: async (options) => {
      record("removeMarketplace", { options });
      return { marketplaceId: options.marketplaceId };
    },
    uninstallMarketplaceSkill: async (options) => {
      record("uninstallMarketplaceSkill", { options });
      return { marketplaceId: options.marketplaceId, skillId: options.skillId };
    },
    detachMarketplaceSkillToUserSkill: async (options) => {
      record("detachMarketplaceSkillToUserSkill", { options });
      return { targetSkillName: "detached-skill" };
    },
    syncMarketplace: async (options) => {
      record("syncMarketplace", { options });
      return {
        marketplace: { id: options.marketplaceId, marketplaceVersion: "1.0.0" },
        hasUpdate: false,
        skillsUpdated: [],
        skillsConflicted: [],
        skillsUpToDate: [],
        skillSyncErrors: [],
        skillsRemoved: [{ skillId: "gone-skill", pluginName: null }],
        skillsSourceMissing: [],
        pendingRemovals: [{ skillId: "used-skill", pluginName: null, agents: [] }],
        agentInventoryUnavailable: false,
      };
    },
    applyMarketplaceSyncRemovals: async (options) => {
      record("applyMarketplaceSyncRemovals", { options });
      return {
        removed: [{ skillId: "used-skill", pluginName: null }],
        skipped: [],
        agentsUpdated: [],
        agentsFlagged: [],
        agentsSkipped: [],
      };
    },
  };

  const clearedLinks = [];
  const functionalStubs = {
    "./marketplace-service": marketplaceServiceStub,
    "./marketplace-sync-agent-tools": {
      buildSyncAgentTools: () => ({
        listReferences: async () => [],
        listAgents: async () => [],
        updateAgentSkillIds: async () => {},
        flagAgentsSkillsNotFound: async () => {},
      }),
    },
    "./ai-marketplace-skill-links": {
      clearLink: async (skillId) => {
        clearedLinks.push(skillId);
      },
    },
    "./agent-skill-usage-guard": {
      assertSkillDeletable: async () => {},
      listAgentSkillReferences: async () => [],
    },
  };

  const handlers = new Map();
  const electronStub = {
    app: {
      getPath() {
        return os.tmpdir();
      },
      getVersion() {
        return "0.0.0-test";
      },
      on() {},
    },
    ipcMain: {
      handle(channel, fn) {
        handlers.set(channel, fn);
      },
      on() {},
    },
    shell: {},
    clipboard: {},
    dialog: {},
    BrowserWindow: {
      fromWebContents() {
        return null;
      },
      getAllWindows() {
        return [];
      },
    },
  };
  const bootstrapStub = {
    PROJECT_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), "marketplace-ipc-wiring-")),
    APP_SERVICES: __dirname,
    execPromise: async () => ({ stdout: "", stderr: "" }),
    sendInitLog() {},
    getConfigPath() {},
    getLogPaths() {
      return {};
    },
    clearWebviewCache() {},
    getThemeIcon() {},
    updateWindowMenu() {},
  };

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") {
      return electronStub;
    }
    if ((parent?.filename || "") === ipcModulePath) {
      if (request === "./bootstrap" || request === "../bootstrap") {
        return bootstrapStub;
      }
      if (Object.prototype.hasOwnProperty.call(functionalStubs, request)) {
        return functionalStubs[request];
      }
      if (request.startsWith("./") || request.startsWith("../")) {
        return {};
      }
    }
    return originalLoad.apply(this, [request, parent, isMain]);
  };

  delete require.cache[ipcModulePath];
  const ipc = require("./ipc");

  return {
    ipc,
    handlers,
    calls,
    clearedLinks,
    projectRoot: bootstrapStub.PROJECT_ROOT,
    restore() {
      Module._load = originalLoad;
      delete require.cache[ipcModulePath];
      if (previousIpc) require.cache[ipcModulePath] = previousIpc;
      fs.rmSync(bootstrapStub.PROJECT_ROOT, { recursive: true, force: true });
    },
  };
}

test("ipc marketplace handlers delegate to marketplaceService and carry the destructive-sync envelope", async () => {
  const loaded = loadIpcWithMarketplaceStubs();
  try {
    loaded.ipc.registerMarketplaceHandlers();

    const removeResult = await loaded.handlers.get("remove-marketplace")(
      null,
      "mp-1",
      true,
    );
    assert.equal(removeResult.success, true);
    const removeCall = loaded.calls.find((c) => c.name === "removeMarketplace");
    assert.equal(removeCall.options.marketplaceId, "mp-1");
    assert.equal(removeCall.options.removeInstalledSkills, true);
    assert.equal(removeCall.options.projectRoot, loaded.projectRoot);

    const uninstallResult = await loaded.handlers.get("uninstall-marketplace-skill")(
      null,
      "mp-1",
      "skill-a",
      "plugin-p",
    );
    assert.equal(uninstallResult.success, true);
    const uninstallCall = loaded.calls.find(
      (c) => c.name === "uninstallMarketplaceSkill",
    );
    assert.deepEqual(
      {
        marketplaceId: uninstallCall.options.marketplaceId,
        skillId: uninstallCall.options.skillId,
        pluginName: uninstallCall.options.pluginName,
      },
      { marketplaceId: "mp-1", skillId: "skill-a", pluginName: "plugin-p" },
    );

    const detachResult = await loaded.handlers.get(
      "detach-marketplace-skill-to-user-skill",
    )(null, "mp-1", "skill-a", null, null);
    assert.equal(detachResult.success, true);
    assert.ok(loaded.calls.some((c) => c.name === "detachMarketplaceSkillToUserSkill"));

    const syncResult = await loaded.handlers.get("sync-marketplace")(null, "mp-1");
    assert.equal(syncResult.success, true);
    // The destructive-sync verdicts ride the envelope untouched…
    assert.deepEqual(syncResult.skillsRemoved, [
      { skillId: "gone-skill", pluginName: null },
    ]);
    assert.deepEqual(syncResult.pendingRemovals, [
      { skillId: "used-skill", pluginName: null, agents: [] },
    ]);
    // …the sync received an agent-usage reader, and removed skills got their
    // publish sidecar links cleared.
    const syncCall = loaded.calls.find((c) => c.name === "syncMarketplace");
    assert.equal(typeof syncCall.options.listAgentReferences, "function");
    assert.deepEqual(loaded.clearedLinks, ["gone-skill"]);

    const applyResult = await loaded.handlers.get("apply-marketplace-sync-removals")(
      null,
      "mp-1",
      [{ skillId: "used-skill", pluginName: null }],
    );
    assert.equal(applyResult.success, true);
    assert.deepEqual(applyResult.removed, [{ skillId: "used-skill", pluginName: null }]);
    const applyCall = loaded.calls.find(
      (c) => c.name === "applyMarketplaceSyncRemovals",
    );
    assert.deepEqual(applyCall.options.removals, [
      { skillId: "used-skill", pluginName: null },
    ]);
    assert.equal(typeof applyCall.options.agentTools.listAgents, "function");
    assert.deepEqual(loaded.clearedLinks, ["gone-skill", "used-skill"]);
  } finally {
    loaded.restore();
  }
});
