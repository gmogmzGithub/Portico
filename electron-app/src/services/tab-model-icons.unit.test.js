// Round-12 pins: chat tabs show the last responding model's logo (stacked
// PORTICO + base-model pair for agent chats), synced from the existing
// owui-tab-activity signal, persisted across restarts; and the OWUI rail
// renders the same stacked treatment for agent chats.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..", "..", "..");
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

test("modelIdentity flows ipc → owui-host → chat-tab without being dropped", () => {
  const ipc = read("electron-app/src/services/ipc.js");
  // The per-response activity event forwards the identity to the shell.
  assert.match(
    ipc,
    /emitEventForView\(viewKey, "tab-activity-changed", \{[\s\S]{0,600}?modelIdentity:/,
  );

  const host = read("electron-app/src/renderer/components/owui-host.js");
  assert.match(
    host,
    /case "tab-activity-changed":[\s\S]{0,500}?props\.modelIdentity =/,
  );

  const chatTab = read("electron-app/src/renderer/components/chat-tab.js");
  assert.match(chatTab, /function setTabModelIdentity\(tabId, identity\)/);
  // Change-gated: unchanged identities skip DOM + persistence work.
  assert.match(chatTab, /tabModelIdentityKey\(meta\.modelIdentity\) === tabModelIdentityKey\(identity\)/);
  assert.match(chatTab, /window\.tabBar\?\.setModelIdentity\?\.\(tabId, meta\.modelIdentity\)/);
  assert.match(chatTab, /window\.persistTabState\?\.\(\);/);
  // Wired from the activity event, guarded against stale-chat events.
  assert.match(
    chatTab,
    /if \(!isStaleChatEvent && event\?\.modelIdentity\) \{\s*setTabModelIdentity\(tabId, event\.modelIdentity\);/,
  );
});

test("tab-bar renders model logos, stacked icons for agents, and falls back to the bubble", () => {
  const tabBar = read("electron-app/src/renderer/components/tab-bar.js");
  assert.match(tabBar, /function resolveTabModelIconKey\(modelIdentity\)/);
  // Agent identities resolve from the BASE model fields.
  assert.match(tabBar, /identity\.baseModelId, identity\.baseModelName, identity\.baseModelOwnedBy/);
  // Celestial + brand mapping mirrors chat-native-notifications.
  for (const key of ["sol", "terra", "luna", "atlas", "gemini", "gpt"]) {
    assert.match(tabBar, new RegExp(`${key}: '\\.\\./assets/${key}\\.png'`));
  }
  assert.match(tabBar, /TAB_portico_ICON_SRC = '\.\.\/assets\/icon_raw\.png'/);
  // Stacked pair: base behind, PORTICO in front.
  assert.match(
    tabBar,
    /tab-icon-stack"><img class="tab-icon-stack-base\$\{badged\}"[\s\S]{0,200}?<img class="tab-icon-stack-front" src="\$\{TAB_portico_ICON_SRC\}"/,
  );
  // No identity → the generic chat/subagent SVG stays.
  assert.match(
    tabBar,
    /return type === 'subagent' \? SUBAGENT_ICON_SVG : CHAT_ICON_SVG;/,
  );
  // Public API + creation-time render from persisted identity.
  assert.match(tabBar, /function setModelIdentity\(tabId, modelIdentity\)/);
  assert.match(tabBar, /setModelIdentity,/);
  assert.match(tabBar, /const icon = tabIconMarkup\(persistedIdentity, type\);/);
  // Busy blocks stay inside the icon span after a swap.
  assert.match(tabBar, /const next = `\$\{markup\}\$\{TAB_BUSY_BLOCKS_HTML\}`;/);

  const styles = read("electron-app/src/styles.css");
  assert.match(styles, /\.tab-icon-stack-front \{[^}]*z-index: 1;/s);
  // Round 13: NO halo/ring on the stacked front icons — the transparent "ai"
  // mark floats bare on both surfaces (light halo / dark box regression).
  assert.doesNotMatch(styles, /\.tab-icon-stack-front \{[^}]*box-shadow/s);
  assert.doesNotMatch(
    read("src/patches/frontend/src/lib/components/layout/Sidebar/SidebarModelLogo.svelte"),
    /box-shadow/,
  );
  // Busy blocks hide BOTH icon shapes (single logo and stacked pair).
  assert.match(
    styles,
    /\.tab-btn\.busy \.tab-icon > svg,\s*\.tab-btn\.busy \.tab-icon > \.tab-model-logo,\s*\.tab-btn\.busy \.tab-icon > \.tab-icon-stack \{/,
  );
  // The white gpt glyph gets a dark chip in light mode (modelBranding parity).
  assert.match(tabBar, /key === 'gpt' \? ' tab-model-logo--badged' : ''/);
  assert.match(
    styles,
    /\[data-theme="light"\] \.tab-model-logo--badged \{[^}]*background: #000;/s,
  );
});

test("resolveTabModelIconKey behaves like the notification resolver (table test)", () => {
  const vm = require("node:vm");
  const tabBar = read("electron-app/src/renderer/components/tab-bar.js");
  const start = tabBar.indexOf("function normalizeTabModelRoute");
  const end = tabBar.indexOf("// The icon fragment");
  assert.ok(start !== -1 && end > start, "resolver functions must be extractable");
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    `${tabBar.slice(start, end)}; resolved = resolveTabModelIconKey;`,
    context,
  );
  const resolve = context.resolved;
  const cases = [
    // Mirrors chat-native-notifications.unit.test.js + this app's real
    // display-name ids (agents carry base_model_id like "GPT-5.6 Sol").
    [{ id: "anthropic/atlas-opus-4.8" }, "atlas"],
    [{ id: "Atlas Sonnet 5" }, "atlas"],
    [{ id: "vertex_ai/gemini-3.5-pro" }, "gemini"],
    [{ id: "openai/responses/gpt-5.5" }, "gpt"],
    [{ id: "openai/responses/gpt-5.6-sol:latest" }, "sol"],
    [{ id: "GPT-5.6 Sol" }, "sol"],
    [{ id: "GPT-5.6-Sol-Pro" }, "sol"],
    [{ id: "GPT-5.6 Terra" }, "terra"],
    [{ id: "gpt_5.6_luna" }, "luna"],
    [{ id: "chuckles", baseModelId: "GPT-5.6 Sol" }, "sol"],
    [{ id: "custom-agent", name: "Recruiting agent", baseModelId: "anthropic/atlas-sonnet-4.7" }, "atlas"],
    [{ id: "custom-agent", baseModelId: "opaque-base", baseModelOwnedBy: "google" }, "gemini"],
    [{ id: "custom-agent", name: "GPT recruiting assistant", ownedBy: "openai", baseModelId: "unknown-local-base" }, null],
    [{ id: "ollama/gpt-oss", ownedBy: "local" }, null],
    [{ id: "unknown-model" }, null],
    [null, null],
  ];
  for (const [identity, expected] of cases) {
    assert.equal(resolve(identity), expected, JSON.stringify(identity));
  }
});

test("tab model identity persists across restarts", () => {
  const state = read("electron-app/src/renderer/state.js");
  assert.match(state, /modelIdentity:\s*meta\.modelIdentity && typeof meta\.modelIdentity === 'object'/);

  const index = read("electron-app/src/renderer/views/index.js");
  // Both the permanent Chat tab and restored conversation tabs re-apply it.
  assert.equal(
    (index.match(/setModelIdentity\?\.\(/g) || []).length >= 2,
    true,
    "restore paths must re-apply persisted identities",
  );
});

test("the OWUI rail stacks the PORTICO logo over the base-model logo for agent chats", () => {
  const branding = read("src/patches/frontend/src/lib/utils/modelBranding.ts");
  assert.match(branding, /export const isDerivedModelCandidate/);

  const logo = read(
    "src/patches/frontend/src/lib/components/layout/Sidebar/SidebarModelLogo.svelte",
  );
  assert.match(logo, /isDerivedModelCandidate,\s*resolveBaseModelRecord/);
  assert.match(logo, /resolveBaseModelRecord\(model, \$models\)/);
  assert.match(logo, /sidebar-model-logo-stack-base/);
  assert.match(logo, /sidebar-model-logo-stack-front/);
  // The front (PORTICO/agent) icon is the agent's own logo sources; the base logo
  // renders behind it. Non-agent models keep the original single-logo path.
  assert.match(logo, /\{#if isAgentModel && baseLogoSources\}/);
  assert.match(logo, /\{:else\}[\s\S]*presentation\.wrapperClassName/);
  // Dark-variant base logos (local models) keep both variants…
  assert.match(logo, /\{#if baseLogoSources\.dark\}[\s\S]{0,400}?hidden dark:block/);
  // …and white-glyph bases (plain gpt) get the light-mode dark chip.
  assert.match(logo, /usesDarkLogoBadgeInLightMode\(baseModel\)/);
  assert.match(logo, /bg-black p-\[2px\] dark:bg-transparent dark:p-0/);
});

test("the links-changed refresh respects open menus and preserves list scroll", () => {
  const index = read("electron-app/src/renderer/views/index.js");
  assert.match(index, /\.mcp-card-dropdown\.visible/);
  assert.match(index, /preserveScroll\('#skills-list'/);
  assert.match(index, /preserveScroll\('#agents-tab-list'/);
  assert.match(index, /restored\.scrollTop = scrollTop;/);
});

test("marketplace-links-changed keeps visible publish badges fresh", () => {
  const api = read("electron-app/src/services/api.js");
  assert.match(api, /function broadcastMarketplaceLinksChanged\(kind\)/);
  // All four write routes broadcast on success.
  assert.match(api, /broadcastMarketplaceLinksChanged\("agent"\);/);
  assert.match(api, /broadcastMarketplaceLinksChanged\("skill"\);/);
  assert.match(api, /broadcastMarketplaceLinksChanged\(targetIsSkill \? "skill" : "unknown"\);/);
  assert.match(api, /broadcastMarketplaceLinksChanged\("unknown"\);/);

  const preload = read("electron-app/src/services/preload.js");
  assert.match(preload, /onMarketplaceLinksChanged: \(callback\) => \{\s*ipcRenderer\.on\('marketplace-links-changed'/);

  const index = read("electron-app/src/renderer/views/index.js");
  assert.match(index, /function setupMarketplaceLinksChangedListener\(\)/);
  // Refresh only the VISIBLE view; hidden views refresh on navigation anyway.
  assert.match(index, /state\.activeTab !== 'control'/);
  assert.match(index, /controlPlaneView === 'agent-skills'/);
  assert.match(index, /showAgentSkillsView\?\.\(\{ refresh: true \}\)/);
  assert.match(index, /controlPlaneView === 'agents-tab'/);
  assert.match(index, /AgentsTabModule\?\.show\?\.\(\)/);
  assert.match(index, /setupMarketplaceLinksChangedListener\(\);/);
});
