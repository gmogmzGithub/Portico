// Behavioral tests for the destructive-sync consent modal's rendered HTML
// (marketplace-sync-removal-modal.js): seeded (bundled) rows are unlink-only
// and the intro/button must never promise a removal those rows won't get.
// The component is a plain script — evaluated in a vm context; the DOM is
// only touched when the modal actually opens, so buildModalHtml (exposed via
// MarketplaceSyncRemovalModalHooks) is testable with a bare window object.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const MODAL_PATH = path.join(
  __dirname,
  "..",
  "renderer",
  "components",
  "marketplace-sync-removal-modal.js",
);

function loadModalHarness() {
  const windowObject = {};
  windowObject.window = windowObject;
  const context = {
    window: windowObject,
    console,
    Promise,
    Array,
    Object,
    String,
    JSON,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInNewContext(fs.readFileSync(MODAL_PATH, "utf8"), context, {
    filename: MODAL_PATH,
  });
  return windowObject;
}

function removal({ seeded = false, skillId = "gone-skill", agents } = {}) {
  return {
    skillId,
    pluginName: "some-plugin",
    label: `Some Plugin → ${skillId}`,
    seeded,
    agents: agents || [{ id: "agent-1", name: "My Agent", readOnly: false }],
  };
}

function group(removals) {
  return {
    marketplaceId: "team-git",
    marketplaceName: "team-git",
    pendingRemovals: removals,
  };
}

test("all-seeded modal: unlink-only intro, per-row bundled note, 'Unlink from agents' button", () => {
  const w = loadModalHarness();
  const html = w.MarketplaceSyncRemovalModalHooks.buildModalHtml(
    [group([removal({ seeded: true }), removal({ seeded: true, skillId: "gone-2" })])],
    2,
  );
  assert.match(html, /unlinks them from the agents shown below/);
  assert.match(html, /stay installed until an app update resolves them/);
  assert.doesNotMatch(html, /removes these skills/);
  assert.equal(
    (html.match(/sync-removal-skill-note/g) || []).length,
    2,
    "every seeded row carries the bundled note",
  );
  assert.match(html, />Unlink from agents<\/button>/);
  assert.doesNotMatch(html, /Unlink &amp; remove/);
});

test("none-seeded modal keeps the removal wording and count", () => {
  const w = loadModalHarness();
  const html = w.MarketplaceSyncRemovalModalHooks.buildModalHtml(
    [group([removal(), removal({ skillId: "gone-2" })])],
    2,
  );
  assert.match(html, /removes these skills/);
  assert.doesNotMatch(html, /sync-removal-skill-note/);
  assert.match(html, /Unlink &amp; remove 2 skills/);
});

test("mixed modal: counts split honestly and only seeded rows get the note", () => {
  const w = loadModalHarness();
  const html = w.MarketplaceSyncRemovalModalHooks.buildModalHtml(
    [group([removal({ seeded: true }), removal({ skillId: "gone-2" })])],
    2,
  );
  assert.match(html, /removes 1 skill/);
  assert.match(html, /keeps 1 bundled skill installed until an app update resolves it/);
  assert.equal((html.match(/sync-removal-skill-note/g) || []).length, 1);
  assert.match(html, /Unlink &amp; remove 1 skill</);
  // The agents table renders identically for both kinds — seeded changes the
  // skill outcome, never the agent handling.
  assert.equal((html.match(/Agent using this skill/g) || []).length, 2);
});
