// Inline Agent Skill page regressions: page shell, editing guardrails,
// publish parity, duplication, menu positioning, and the IPC/preload surface.
//
// Behavioral suite (no source pins): renderer flows run agent-skills.js in the
// vm FakeElement harness (agent-skills-harness.js — same pattern as
// agent-skills-reclaim-confirm.unit.test.js), and the main-process handlers
// run for real via the Module._load ipc-capture pattern from
// terminal-command-ipc.unit.test.js against temp skills roots.
//
// Former static-markup pins were removed rather than converted: the
// #agent-skills-browser / #agent-skills-editor split and the
// renderer/components/skill-card-renderer.js <script> tags (in BOTH
// electron-app/src/renderer/views/index.html and conversation-window.html) are
// declarative markup with no runtime to exercise in Node; the JS behavior on
// top of them (hide/show takeover, shared-renderer delegation, window export)
// is asserted below.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");

const skillLinks = require("./ai-marketplace-skill-links");
const {
  FakeElement,
  flushAsync,
  loadAgentSkillsHarness,
} = require("./agent-skills-harness");

function tmpDeps() {
  return { userDataPath: fs.mkdtempSync(path.join(os.tmpdir(), "skill-links-")) };
}

const USER_SKILL = Object.freeze({
  name: "my-skill",
  source: "user",
  skill_path: "skills-user/my-skill",
  description: "Mine",
  created_by_email: "dsantiago@example.invalid",
  version: "2.0",
});

const MARKETPLACE_SKILL = Object.freeze({
  name: "ai-marketplace/notes",
  source: "marketplace",
  skill_path: "skills-marketplace/ai-marketplace/notes",
  marketplace_id: "ai-marketplace",
  marketplace_name: "AI Marketplace",
  marketplace_solution_id: "sol-notes",
  description: "Installed notes skill",
  version: "1.0",
});

// Page-action helper: the header actions use one delegated click listener that
// resolves the button via event.target.closest("button").
function clickPageAction(harness, actionClass) {
  const host = harness.getElementById("agent-skills-editor");
  const button = new FakeElement("page-action");
  button.classList.add(actionClass);
  host
    .querySelector("[data-skill-page-actions]")
    .dispatch("click", {
      target: { closest: (sel) => (sel === "button" ? button : null) },
    });
  return button;
}

test("skill links carry an event-driven unpublished-changes flag", async () => {
  const deps = tmpDeps();
  assert.equal(await skillLinks.markLinkDirty("my-skill", deps), null);
  const created = await skillLinks.setLink("my-skill", "sol-1", deps);
  assert.equal(created.hasLocalChanges, false);
  const dirty = await skillLinks.markLinkDirty("my-skill", deps);
  assert.equal(dirty.hasLocalChanges, true);
  // Marketplace-style names canonicalize to the same key.
  const viaMarketplaceName = await skillLinks.getLink("mk-1/my-skill", deps);
  assert.equal(viaMarketplaceName.hasLocalChanges, true);
  const republished = await skillLinks.setLink("my-skill", "sol-1", deps);
  assert.equal(republished.hasLocalChanges, false);
});

test("legacy skill link records normalize to clean", () => {
  const normalized = skillLinks.normalizeState({
    links: { "old-skill": { solutionId: "sol-9", publishedAt: 5 } },
  });
  assert.equal(normalized.links["old-skill"].hasLocalChanges, false);
});

test("skills dropdown anchors left of the trigger with measured width", async () => {
  const harness = loadAgentSkillsHarness({
    skills: [USER_SKILL],
    innerWidth: 1200,
    innerHeight: 800,
  });
  const skillsList = harness.getElementById("skills-list");
  const makeTrigger = (left) => {
    const trigger = new FakeElement("trigger");
    trigger.dataset.menuSkillName = "my-skill";
    trigger.rect = { left, right: left + 24, top: 100, bottom: 120, width: 24, height: 20 };
    const dropdown = new FakeElement("dropdown");
    dropdown.offsetWidth = 240; // measured, NOT a hardcoded 180
    dropdown.offsetHeight = 200;
    const wrapper = new FakeElement("wrapper");
    wrapper.children.set(".mcp-card-dropdown", dropdown);
    trigger.parentElement = wrapper;
    dropdown.parentElement = wrapper;
    return { trigger, dropdown };
  };
  const centered = makeTrigger(300);
  const nearRightEdge = makeTrigger(1100);
  skillsList.qsaResults.set(".mcp-card-menu-trigger", [
    centered.trigger,
    nearRightEdge.trigger,
  ]);

  await harness.window.loadSkills();

  // Opens below the ellipsis, anchored at the trigger's LEFT edge.
  centered.trigger.click();
  assert.equal(centered.dropdown.style.left, "300px");
  assert.equal(centered.dropdown.style.top, "124px"); // bottom(120) + 4
  assert.equal(centered.dropdown.classList.contains("visible"), true);

  // Near the right edge the menu clamps using its MEASURED offsetWidth:
  // 1200 - 240 - 8 = 952. (A hardcoded 180px menu would clamp to 1012.)
  nearRightEdge.trigger.click();
  assert.equal(nearRightEdge.dropdown.style.left, "952px");
});

test("clicking a skill card opens the inline page that replaced the details modal", async () => {
  const harness = loadAgentSkillsHarness({ skills: [USER_SKILL] });
  harness.window.appState.controlPlaneView = "agent-skills";

  // The old modal entry points now alias the page open/teardown functions.
  assert.equal(typeof harness.window.openSkillDetailsModal, "function");
  assert.equal(typeof harness.window.closeSkillDetailsModal, "function");

  const skillsList = harness.getElementById("skills-list");
  const card = new FakeElement("card");
  card.dataset.skillName = "my-skill";
  skillsList.qsaResults.set(".skill-card", [card]);
  await harness.window.loadSkills();

  card.click();
  await flushAsync();

  const host = harness.getElementById("agent-skills-editor");
  const browser = harness.getElementById("agent-skills-browser");
  const headerActions = harness.getElementById("skills-header-actions");
  // The page reuses the shared editor chrome and takes over the subview.
  assert.match(host.innerHTML, /class="agent-editor-page"/);
  assert.match(host.innerHTML, /class="agent-editor-back-btn"/);
  assert.match(host.innerHTML, /class="skill-details-body"/);
  assert.equal(host.style.display, "");
  assert.equal(browser.style.display, "none");
  assert.equal(headerActions.style.display, "none");

  // Back button closes cleanly when there are no edits: browser + header
  // actions come back and the editor host is emptied.
  host.querySelector(".agent-editor-back-btn").click();
  assert.equal(host.innerHTML, "");
  assert.equal(host.style.display, "none");
  assert.equal(browser.style.display, "");
  assert.equal(headerActions.style.display, "");

  // The alias teardown is the same teardown.
  await harness.window.openSkillDetailsModal(USER_SKILL);
  assert.notEqual(host.innerHTML, "");
  harness.window.closeSkillDetailsModal();
  assert.equal(host.innerHTML, "");
});

test("unsaved skill edits route the close through the shared discard modal", async () => {
  const harness = loadAgentSkillsHarness({ skills: [USER_SKILL] });
  await harness.window.openSkillDetailsModal(USER_SKILL);
  await flushAsync();

  const host = harness.getElementById("agent-skills-editor");
  const contentArea = harness.getElementById("skill-content-area");
  contentArea.querySelector(".skill-file-edit-btn").click();
  const editor = contentArea.querySelector(".skill-file-editor");
  editor.value = "unsaved draft";
  editor.dispatch("input");

  host.querySelector(".agent-editor-back-btn").click();
  assert.equal(harness.discardCalls.length, 1, "discard modal opens");
  assert.equal(harness.discardCalls[0].subject, "My Skill");
  assert.notEqual(host.innerHTML, "", "the page stays open until the user decides");

  harness.discardCalls[0].onDiscard();
  assert.equal(host.innerHTML, "", "discard tears the page down");

  // Without edits the same close path skips the modal entirely.
  await harness.window.openSkillDetailsModal(USER_SKILL);
  await flushAsync();
  host.querySelector(".agent-editor-back-btn").click();
  assert.equal(harness.discardCalls.length, 1, "no second discard prompt");
  assert.equal(host.innerHTML, "");
});

test("entering Edit lands at the top of the file, not the bottom", async () => {
  const harness = loadAgentSkillsHarness({ skills: [USER_SKILL] });
  await harness.window.openSkillDetailsModal(USER_SKILL);
  await flushAsync();

  const contentArea = harness.getElementById("skill-content-area");
  contentArea.querySelector(".skill-file-edit-btn").click();
  const editor = contentArea.querySelector(".skill-file-editor");

  // Value assignment parks the caret at the end; a bare focus() would scroll
  // the editor to it (the harness focus mirrors that with a 999 sentinel).
  assert.equal(editor.selectionStart, 0, "caret starts at the top");
  assert.equal(editor.selectionEnd, 0);
  assert.equal(editor.scrollTop, 0, "editor stays scrolled to the top");
  assert.equal(editor.focusCalls?.length, 1, "editor still receives focus");
  assert.equal(editor.focusCalls[0]?.preventScroll, true);
});

test("skill file editing is wired for user skills only", async () => {
  const harness = loadAgentSkillsHarness({
    skills: [USER_SKILL],
    links: { "my-skill": { solutionId: "sol-1", hasLocalChanges: false } },
    publishedSolutionIds: ["sol-1"],
  });
  await harness.window.loadSkills();
  await harness.window.openSkillDetailsModal(USER_SKILL);
  await flushAsync();

  const contentArea = harness.getElementById("skill-content-area");
  assert.match(
    contentArea.innerHTML,
    /skill-file-edit-btn/,
    "user skills expose the Edit toolbar",
  );

  // Edit -> change -> Save: the save writes through window.electronAPI and
  // flags the marketplace link dirty (Unpublished changes chip appears).
  contentArea.querySelector(".skill-file-edit-btn").click();
  const editor = contentArea.querySelector(".skill-file-editor");
  editor.value = "changed body";
  editor.dispatch("input");
  const saveBtn = contentArea.querySelector(".skill-file-save-btn");
  saveBtn.dispatch("click", { currentTarget: saveBtn });
  await flushAsync();

  assert.deepEqual(harness.calls.writeSkillFile, [
    ["/skills/my-skill/SKILL.md", "changed body"],
  ]);
  assert.deepEqual(harness.calls.markSkillLinkDirty, ["my-skill"]);
  const chips = harness.document.querySelector("[data-skill-page-chips]");
  assert.match(chips.innerHTML, /class="mcp-card-badge badge-unpublished"/);
  assert.match(chips.innerHTML, /Unpublished changes/);

  // Marketplace-installed copies are read-only: no Edit toolbar at all.
  const readOnly = loadAgentSkillsHarness({ skills: [MARKETPLACE_SKILL] });
  await readOnly.window.openSkillDetailsModal(MARKETPLACE_SKILL);
  await flushAsync();
  const readOnlyContent = readOnly.getElementById("skill-content-area");
  assert.notEqual(readOnlyContent.innerHTML, "");
  assert.doesNotMatch(readOnlyContent.innerHTML, /skill-file-edit-btn/);
});

test("plugin skills show the plugin chip in the detail-page header", async () => {
  const pluginSkill = {
    ...MARKETPLACE_SKILL,
    name: "portico-ai-marketplace/a11y/fixing-jira-a11y-in-bulk",
    display_name: "Fixing Jira A11y In Bulk",
    marketplace_id: "portico-ai-marketplace",
    marketplace_name: "portico-ai-marketplace",
    plugin_name: "a11y",
  };
  const harness = loadAgentSkillsHarness({ skills: [pluginSkill] });
  await harness.window.openSkillDetailsModal(pluginSkill);
  await flushAsync();
  const host = harness.getElementById("agent-skills-editor").innerHTML;
  assert.match(
    host,
    /data-skill-page-chips>[^]*badge-plugin" title="From plugin A11y">A11y</,
  );

  // Plugin-less copies never grow the chip.
  const plain = loadAgentSkillsHarness({ skills: [MARKETPLACE_SKILL] });
  await plain.window.openSkillDetailsModal(MARKETPLACE_SKILL);
  await flushAsync();
  const plainHost = plain.getElementById("agent-skills-editor").innerHTML;
  assert.doesNotMatch(plainHost, /badge-plugin/);
});

test("performPublishSkillToAiMarketplace runs modal-free for bulk callers (Updates tab)", async () => {
  const harness = loadAgentSkillsHarness({
    skills: [USER_SKILL],
    links: { "my-skill": { solutionId: "sol-1", hasLocalChanges: true } },
    publishedSolutionIds: ["sol-1"],
  });
  await harness.window.loadSkills();

  assert.equal(
    typeof harness.window.AgentSkillsHooks.performPublishSkillToAiMarketplace,
    "function",
    "the modal-free worker is exported for the Updates tab",
  );
  await harness.window.AgentSkillsHooks.performPublishSkillToAiMarketplace(
    USER_SKILL,
    null,
  );
  await flushAsync();

  assert.equal(harness.confirmCalls.length, 0, "no confirm modal opens");
  assert.equal(harness.calls.buildPublishBundle.length, 1);
  assert.equal(harness.calls.update.length, 1, "linked skill republish is an update");
  assert.equal(harness.calls.update[0][0], "sol-1");
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.calls.setSkillLink)),
    [["my-skill", "sol-1"]],
    "publish success re-links (clearing hasLocalChanges)",
  );
});

test("skill publish parity: unpublish flow and page/card badges", async () => {
  const harness = loadAgentSkillsHarness({
    skills: [USER_SKILL],
    links: { "my-skill": { solutionId: "sol-1", hasLocalChanges: false } },
    publishedSolutionIds: ["sol-1"],
  });
  await harness.window.loadSkills();
  // Cards fetch publish state with ONE listSkillLinks call per load.
  assert.equal(harness.calls.listSkillLinks, 1);
  assert.match(
    harness.getElementById("skills-list").innerHTML,
    /class="mcp-card-badge badge-published"/,
  );

  await harness.window.openSkillDetailsModal(USER_SKILL);
  await flushAsync();
  const host = harness.getElementById("agent-skills-editor");
  assert.match(host.innerHTML, /class="mcp-card-badge badge-published"/);
  assert.match(host.innerHTML, /skill-page-unpublish-btn/);
  // Unpublish's arrow points DOWN (the reverse of Publish), not left/back.
  assert.match(host.innerHTML, /skill-page-unpublish-btn[\s\S]*?M12 5v14/);

  // Unpublish asks through the shared app-styled modal (no native confirm)
  // and deletes only after the user confirms.
  clickPageAction(harness, "skill-page-unpublish-btn");
  await flushAsync();
  assert.equal(harness.confirmCalls.length, 1);
  assert.equal(harness.confirmCalls[0].title, "Unpublish?");
  assert.equal(harness.confirmCalls[0].danger, true);
  assert.match(harness.confirmCalls[0].message, /my-skill/);
  // The solution id rides in the meta badge (chip + copy button), not the
  // sentence copy (round 15).
  assert.doesNotMatch(harness.confirmCalls[0].message, /sol-1/);
  assert.equal(harness.confirmCalls[0].meta?.badge, "sol-1");
  // The confirm spinner reads "Checking..." — the published-agent dependency
  // sweep runs inside the confirm (round 19).
  assert.equal(harness.confirmCalls[0].confirmBusyLabel, "Checking...");
  assert.equal(harness.calls.delete.length, 0, "no delete before confirm");
  assert.equal(harness.calls.windowConfirm.length, 0, "native confirm unused");

  harness.confirmCalls[0].onConfirm();
  await flushAsync();
  assert.deepEqual(harness.calls.delete, ["sol-1"]);
  // User-owned local skill keeps editing rights; its local link is cleared.
  assert.deepEqual(harness.calls.clearSkillLink, ["my-skill"]);
  const chips = harness.document.querySelector("[data-skill-page-chips]");
  assert.doesNotMatch(chips.innerHTML, /badge-published/);

  // A dirty link renders the Unpublished-changes chip on the page.
  const dirty = loadAgentSkillsHarness({
    skills: [USER_SKILL],
    links: { "my-skill": { solutionId: "sol-1", hasLocalChanges: true } },
    publishedSolutionIds: ["sol-1"],
  });
  await dirty.window.loadSkills();
  await dirty.window.openSkillDetailsModal(USER_SKILL);
  await flushAsync();
  assert.match(
    dirty.getElementById("agent-skills-editor").innerHTML,
    /class="mcp-card-badge badge-unpublished"/,
  );
});

test("skill publish parity: PUBLISH also uses the app-styled modal (round 11)", async () => {
  const freshSkill = {
    name: "fresh-skill",
    source: "user",
    skill_path: "skills-user/fresh-skill",
    description: "Fresh",
  };
  const harness = loadAgentSkillsHarness({ skills: [freshSkill] });
  await harness.window.loadSkills();
  await harness.window.openSkillDetailsModal(freshSkill);
  await flushAsync();

  clickPageAction(harness, "skill-page-publish-btn");
  await flushAsync();
  assert.equal(harness.confirmCalls.length, 1);
  assert.equal(harness.confirmCalls[0].title, "Publish?");
  assert.equal(harness.confirmCalls[0].confirmLabel, "Publish");
  // Exact copy: one short sentence — the legacy native-alert wording and the
  // round-11 two-sentence share copy are both gone (round-14 "too wordy").
  assert.equal(
    harness.confirmCalls[0].message,
    'Publish "fresh-skill" to the AI Marketplace so everyone at Portico can use it.',
  );
  assert.equal(harness.calls.publish.length, 0, "no publish before confirm");
  assert.equal(harness.calls.windowConfirm.length, 0, "native confirm unused");

  harness.confirmCalls[0].onConfirm();
  await flushAsync();
  assert.equal(harness.calls.buildPublishBundle.length, 1);
  assert.equal(harness.calls.buildPublishBundle[0].type, "skills");
  assert.equal(harness.calls.publish.length, 1);
  assert.deepEqual(harness.calls.setSkillLink, [["fresh-skill", "sol-new"]]);
  const chips = harness.document.querySelector("[data-skill-page-chips]");
  assert.match(chips.innerHTML, /class="mcp-card-badge badge-published"/);

  // Republishing an already-linked skill reuses the existing solution via
  // update() (no duplicate publish) and titles the modal accordingly.
  const republish = loadAgentSkillsHarness({
    skills: [USER_SKILL],
    links: { "my-skill": { solutionId: "sol-1", hasLocalChanges: true } },
    publishedSolutionIds: ["sol-1"],
  });
  await republish.window.loadSkills();
  await republish.window.openSkillDetailsModal(USER_SKILL);
  await flushAsync();
  clickPageAction(republish, "skill-page-publish-btn");
  await flushAsync();
  assert.equal(republish.confirmCalls[0].title, "Republish?");
  assert.equal(republish.confirmCalls[0].confirmLabel, "Republish");
  republish.confirmCalls[0].onConfirm();
  await flushAsync();
  assert.equal(republish.calls.update.length, 1);
  assert.equal(republish.calls.update[0][0], "sol-1");
  assert.equal(republish.calls.publish.length, 0, "no duplicate listing");
});

test("skill cards delegate their shell to the shared SkillCardRenderer (round 11)", async () => {
  const harness = loadAgentSkillsHarness({
    skills: [USER_SKILL],
    links: { "my-skill": { solutionId: "sol-1", hasLocalChanges: true } },
    publishedSolutionIds: ["sol-1"],
  });
  // The REAL renderer script ran in this context and owns the window export.
  assert.equal(
    typeof harness.window.SkillCardRenderer.buildSkillCardHtml,
    "function",
  );

  await harness.window.loadSkills();
  const listHtml = harness.getElementById("skills-list").innerHTML;
  // The card shell markup exists ONLY in skill-card-renderer.js, so its
  // presence proves the list rendered through the shared renderer with the
  // interactive menu layered on top.
  assert.match(listHtml, /mcp-server-card skill-card/);
  assert.match(listHtml, /has-unpublished-changes/);
  assert.match(listHtml, /class="mcp-card-badge badge-published"/);
  // Version chips were dropped from skill cards (Round 12).
  assert.doesNotMatch(listHtml, /badge-version/);
  assert.match(listHtml, /mcp-card-menu-wrapper/);
  assert.match(listHtml, /mcp-card-menu-trigger/);
});

test("skill page header shows the author chip next to the source/publish chips", async () => {
  const harness = loadAgentSkillsHarness({ skills: [USER_SKILL] });
  await harness.window.openSkillDetailsModal(USER_SKILL);
  await flushAsync();
  const host = harness.getElementById("agent-skills-editor").innerHTML;
  // User skills derive the chip from the authenticated creator email (the
  // frontmatter author is spoofable), same as the cards.
  assert.match(host, /data-skill-page-chips>[^]*badge-author">dsantiago</);
  assert.doesNotMatch(host, /badge-version/);

  // Installed copies fall back to the catalog author (Unknown when absent) —
  // byte-parity with the card renderer's derivation.
  const installed = loadAgentSkillsHarness({ skills: [MARKETPLACE_SKILL] });
  await installed.window.openSkillDetailsModal(MARKETPLACE_SKILL);
  await flushAsync();
  const installedHost = installed.getElementById("agent-skills-editor").innerHTML;
  assert.match(
    installedHost,
    /data-skill-page-chips>[^]*badge-author">Unknown</,
  );
});

test("skill cards have no inline action footer (click opens the page; actions live in the ellipsis)", async () => {
  const harness = loadAgentSkillsHarness({ skills: [USER_SKILL] });
  await harness.window.loadSkills();
  const listHtml = harness.getElementById("skills-list").innerHTML;

  // Batch 4: the Details/Edit/Delete footer never renders — the card body is
  // the shared shell plus the ellipsis menu only.
  assert.doesNotMatch(listHtml, /mcp-card-footer skill-card-actions/);
  assert.doesNotMatch(listHtml, /skill-details-btn/);
  assert.doesNotMatch(listHtml, /skill-edit-btn/);
  assert.doesNotMatch(listHtml, /btn-danger skill-delete-btn/);
  // The ellipsis "Edit Local Files" item is gone; per-source actions remain.
  assert.doesNotMatch(listHtml, /skill-edit-menu-btn/);
  assert.match(listHtml, /skill-details-menu-btn/);
  assert.match(listHtml, /skill-export-menu-btn/);
  assert.match(listHtml, /skill-duplicate-menu-btn/);
  assert.match(listHtml, /skill-delete-menu-btn/);
  // Batch 6: the publish item renders with the short "Publish" label.
  assert.match(listHtml, /skill-publish-ai-marketplace-menu-btn/);
  assert.doesNotMatch(listHtml, /Publish to AI Marketplace/);
  assert.doesNotMatch(listHtml, /Publish copy to AI Marketplace/);
});

test("duplicating from the page prompts for a validated name and calls duplicate-skill exact", async () => {
  const harness = loadAgentSkillsHarness({ skills: [USER_SKILL] });
  await harness.window.loadSkills();
  await harness.window.openSkillDetailsModal(USER_SKILL);
  await flushAsync();

  // Capture the name-entry overlay the modal creates.
  const created = [];
  const originalCreate = harness.document.createElement;
  harness.document.createElement = (tag) => {
    const el = originalCreate(tag);
    created.push(el);
    return el;
  };
  clickPageAction(harness, "skill-page-duplicate-btn");
  await flushAsync();
  const overlay = created.find((el) => el.classList.contains("skill-name-modal"));
  assert.ok(overlay, "the app-styled name modal opens");
  assert.equal(overlay.classList.contains("visible"), true);

  const input = overlay.querySelector(".skill-name-modal-input");
  const confirmBtn = overlay.querySelector(".skill-name-modal-confirm");
  const errorEl = overlay.querySelector(".skill-name-modal-error");
  assert.equal(input.value, "My Skill Copy", "prefilled from the display name");

  // Names colliding with ANY existing skill are rejected before the IPC.
  input.value = "my-skill";
  input.dispatch("input");
  assert.equal(errorEl.textContent, "A skill with this name already exists");
  assert.equal(confirmBtn.disabled, true);
  confirmBtn.click();
  await flushAsync();
  assert.equal(harness.calls.duplicateSkill.length, 0);

  input.value = "my-copy";
  input.dispatch("input");
  assert.equal(errorEl.textContent, "");
  confirmBtn.click();
  await flushAsync();
  assert.equal(harness.calls.duplicateSkill.length, 1);
  const [dupPath, dupName, dupOpts] = harness.calls.duplicateSkill[0];
  assert.equal(dupPath, "skills-user/my-skill");
  assert.equal(dupName, "my-copy");
  // Options object originates inside the vm realm — compare by value.
  assert.equal(JSON.stringify(dupOpts), JSON.stringify({ exact: true }));
});

// ────────────────────────────────────────────────────────────────────────────
// agents.js provider side: the skills page borrows window.showAgentsConfirmModal
// and window.showAgentsDiscardModal; agents.js must actually export them.
// Harness recipe mirrors agents-dependent-skill-publish.unit.test.js.
// ────────────────────────────────────────────────────────────────────────────
test("agents.js provides the shared confirm/discard modals the skills page uses", () => {
  const componentsDir = path.join(__dirname, "..", "renderer", "components");
  const agentsPath = path.join(componentsDir, "agents.js");
  const sources = [
    "agent-reasoning-options.js",
    "agent-model-picker.js",
    "agent-reasoning-slider.js",
    "agents.js",
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
    "agents-confirm-secondary-btn",
    "agents-confirm-close-btn",
  ].forEach((id) => elements.set(id, new FakeElement(id)));

  const documentObject = {
    readyState: "complete",
    body: new FakeElement("body"),
    createElement: (tag) => new FakeElement(tag),
    getElementById: (id) => elements.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  const windowObject = {
    appState: { controlPlaneView: "mcp-servers" },
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
    document: documentObject,
    console,
    setTimeout,
    clearTimeout,
    Math,
    Date,
    Promise,
    HTMLElement: FakeElement,
  };
  context.globalThis = context;
  for (const entry of sources) {
    vm.runInNewContext(entry.source, context, { filename: entry.path });
  }

  assert.equal(typeof windowObject.showAgentsDiscardModal, "function");
  assert.equal(typeof windowObject.showAgentsConfirmModal, "function");

  // The exported discard modal actually drives its DOM: it creates/uses the
  // shared overlay and runs onDiscard when the discard button is clicked.
  windowObject.showAgentsDiscardModal({ subject: "My Skill", onDiscard() {} });
  assert.ok(agentsPath); // context.window mutation is the assertion above
});

// ────────────────────────────────────────────────────────────────────────────
// Main-process handlers, exercised for REAL via the Module._load ipc-capture
// pattern (terminal-command-ipc.unit.test.js): stub electron + heavy deps,
// register the real handler groups, invoke handlers against temp roots.
// ────────────────────────────────────────────────────────────────────────────
const ipcModulePath = require.resolve("./ipc");
const originalModuleLoad = Module._load;

function loadSkillsIpcHarness() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skills-ipc-root-"));
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "skills-ipc-data-"));
  const handlers = new Map();
  const previousModule = require.cache[ipcModulePath];

  const electronStub = {
    app: { getPath: () => userDataPath },
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
      on() {},
    },
    shell: {
      async openExternal() {
        return true;
      },
      async openPath() {
        return "";
      },
    },
    clipboard: { writeText() {} },
    BrowserWindow: {
      fromWebContents() {
        return null;
      },
      getAllWindows() {
        return [];
      },
    },
    Notification: function Notification() {},
  };

  const realUserSkillService = require("./user-skill-service");
  const realSkillLinks = require("./ai-marketplace-skill-links");
  const realMarketplaceService = require("./marketplace-service");
  // Real service logic with only the authenticated-identity lookup stubbed
  // (there is no signed-in session in unit tests).
  const userSkillServiceForTest = {
    ...realUserSkillService,
    ...realUserSkillService.createUserSkillService({
      projectRoot,
      resolveIdentity: async () => ({ email: "dsantiago@example.invalid" }),
      markSkillLinkDirty: (name) =>
        realSkillLinks.markLinkDirty(name, { userDataPath }),
    }),
  };

  const moduleMap = new Map([
    ["./bootstrap", { PROJECT_ROOT: projectRoot }],
    ["./user-skill-service", userSkillServiceForTest],
    ["./marketplace-service", realMarketplaceService],
    ["./ai-marketplace-skill-links", realSkillLinks],
    // Registration-time hooks of unrelated MCP machinery in the same
    // registration group: inert stubs.
    [
      "./docker-mcp",
      {
        resetTargetedMcpOperationPublication() {},
        publishTargetedMcpReadiness() {},
        beginTargetedMcpOperationPublication() {},
        endTargetedMcpOperationPublication() {},
      },
    ],
    [
      "./mcp-operation-manager",
      { defaultMcpOperationManager: { onMcpOperationUpdated: () => () => {} } },
    ],
    [
      "./mcp-operation-coordinator",
      { McpOperationCoordinator: class McpOperationCoordinator {} },
    ],
    ["./mcp-operation-service", { registerMcpOperationCoordinator() {} }],
  ]);

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return electronStub;
    if (
      parent?.filename === ipcModulePath &&
      (request.startsWith("./") || request.startsWith("../"))
    ) {
      if (moduleMap.has(request)) return moduleMap.get(request);
      return {};
    }
    return originalModuleLoad.apply(this, [request, parent, isMain]);
  };

  delete require.cache[ipcModulePath];
  const ipc = require("./ipc");

  const writeFixture = (relPath, content) => {
    const filePath = path.join(projectRoot, relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return filePath;
  };

  return {
    ipc,
    handlers,
    projectRoot,
    userDataPath,
    skillLinks: realSkillLinks,
    writeFixture,
    restore() {
      Module._load = originalModuleLoad;
      delete require.cache[ipcModulePath];
      if (previousModule) require.cache[ipcModulePath] = previousModule;
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(userDataPath, { recursive: true, force: true });
    },
  };
}

test("write-skill-file IPC is restricted to the skills-user root", async () => {
  const loaded = loadSkillsIpcHarness();
  try {
    loaded.writeFixture(
      "skills/sys-skill/SKILL.md",
      "---\nname: sys-skill\ndescription: sys\n---\nbody\n",
    );
    loaded.writeFixture(
      "skills-user/my-skill/SKILL.md",
      "---\nname: my-skill\ndescription: mine\n---\nbody\n",
    );
    const notesPath = loaded.writeFixture(
      "skills-user/my-skill/references/notes.md",
      "old\n",
    );
    loaded.ipc.registerPerServerMcpoHandlers();
    const write = loaded.handlers.get("write-skill-file");
    assert.equal(typeof write, "function");

    // System/marketplace roots are read-only.
    assert.deepEqual(
      await write(
        null,
        path.join(loaded.projectRoot, "skills/sys-skill/SKILL.md"),
        "x",
      ),
      { success: false, error: "Only user skills are editable" },
    );
    // Traversal out of skills-user resolves and is rejected too.
    assert.deepEqual(
      await write(null, "skills-user/../skills/sys-skill/SKILL.md", "x"),
      { success: false, error: "Only user skills are editable" },
    );
    // Edit-only: the file must already exist.
    assert.deepEqual(
      await write(
        null,
        path.join(loaded.projectRoot, "skills-user/my-skill/new.md"),
        "x",
      ),
      { success: false, error: "File not found" },
    );

    // A real user-skill write lands on disk and flags the published link
    // dirty (event-driven Unpublished-changes marker).
    await loaded.skillLinks.setLink("my-skill", "sol-1", {
      userDataPath: loaded.userDataPath,
    });
    assert.deepEqual(await write(null, notesPath, "new content\n"), {
      success: true,
    });
    assert.equal(fs.readFileSync(notesPath, "utf8"), "new content\n");
    const link = await loaded.skillLinks.getLink("my-skill", {
      userDataPath: loaded.userDataPath,
    });
    assert.equal(link.hasLocalChanges, true);
  } finally {
    loaded.restore();
  }
});

test("duplicate-skill IPC copies any valid skill into skills-user", async () => {
  const loaded = loadSkillsIpcHarness();
  try {
    loaded.writeFixture(
      "skills/sys-skill/SKILL.md",
      "---\nname: sys-skill\ndescription: sys\n---\nbody\n",
    );
    loaded.ipc.registerPerServerMcpoHandlers();
    const duplicate = loaded.handlers.get("duplicate-skill");
    assert.equal(typeof duplicate, "function");

    // A system skill duplicates into skills-user with a unique name.
    const first = await duplicate(null, { skillPath: "skills/sys-skill" });
    assert.equal(first.success, true);
    assert.equal(first.skillName, "sys-skill-copy");
    assert.ok(
      fs.existsSync(
        path.join(loaded.projectRoot, "skills-user", first.skillName, "SKILL.md"),
      ),
    );

    // A second copy auto-resolves another unique directory name.
    const second = await duplicate(null, { skillPath: "skills/sys-skill" });
    assert.equal(second.success, true);
    assert.notEqual(second.skillName, first.skillName);
    assert.ok(
      fs.existsSync(
        path.join(loaded.projectRoot, "skills-user", second.skillName, "SKILL.md"),
      ),
    );

    // Exact mode (the Duplicate-with-name modal) rejects collisions so the
    // renderer's uniqueness validation stays authoritative.
    assert.deepEqual(
      await duplicate(null, {
        skillPath: "skills/sys-skill",
        preferredName: first.skillName,
        exact: true,
      }),
      { success: false, error: "A user skill with this name already exists" },
    );

    // Paths outside the skills roots are invalid.
    const outside = await duplicate(null, { skillPath: "/etc" });
    assert.equal(outside.success, false);
    assert.equal(outside.error, "Invalid skill path");
  } finally {
    loaded.restore();
  }
});

test("skill link list + mark-dirty are exposed through IPC and preload", async () => {
  const loaded = loadSkillsIpcHarness();
  try {
    loaded.ipc.registerAiMarketplaceHandlers();
    const list = loaded.handlers.get("ai-marketplace-skill-link-list");
    const markDirty = loaded.handlers.get("ai-marketplace-skill-link-mark-dirty");
    assert.equal(typeof list, "function");
    assert.equal(typeof markDirty, "function");

    await loaded.skillLinks.setLink("my-skill", "sol-1", {
      userDataPath: loaded.userDataPath,
    });
    const dirtied = await markDirty(null, "my-skill");
    assert.equal(dirtied.success, true);
    assert.equal(dirtied.link.hasLocalChanges, true);
    const listed = await list(null);
    assert.equal(listed.success, true);
    assert.equal(listed.links["my-skill"].solutionId, "sol-1");
    assert.equal(listed.links["my-skill"].hasLocalChanges, true);
  } finally {
    loaded.restore();
  }

  // Preload bridge: the renderer-facing API maps onto exactly these channels.
  const preloadPath = require.resolve("./preload");
  const previousPreload = require.cache[preloadPath];
  const invocations = [];
  const exposed = {};
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") {
      return {
        contextBridge: {
          exposeInMainWorld(name, api) {
            exposed[name] = api;
          },
        },
        ipcRenderer: {
          invoke(...args) {
            invocations.push(args);
            return Promise.resolve({ success: true });
          },
          send() {},
          on() {},
        },
      };
    }
    return originalModuleLoad.apply(this, [request, parent, isMain]);
  };
  try {
    delete require.cache[preloadPath];
    require("./preload");
    const api = exposed.electronAPI;
    assert.ok(api, "preload exposes electronAPI");

    await api.aiMarketplace.listSkillLinks();
    await api.aiMarketplace.markSkillLinkDirty("my-skill");
    await api.writeSkillFile("/p/SKILL.md", "content");
    await api.duplicateSkill("/p", "copy-name", { exact: true });
    assert.deepEqual(invocations, [
      ["ai-marketplace-skill-link-list"],
      ["ai-marketplace-skill-link-mark-dirty", "my-skill"],
      ["write-skill-file", "/p/SKILL.md", "content"],
      [
        "duplicate-skill",
        { skillPath: "/p", preferredName: "copy-name", exact: true },
      ],
    ]);
  } finally {
    Module._load = originalModuleLoad;
    delete require.cache[preloadPath];
    if (previousPreload) require.cache[preloadPath] = previousPreload;
  }
});

test("unpublish blocked by published agents rejects inline; the local link survives (round 19)", async () => {
  const harness = loadAgentSkillsHarness({
    skills: [USER_SKILL],
    links: { "my-skill": { solutionId: "sol-1", hasLocalChanges: false } },
    publishedSolutionIds: ["sol-1"],
    marketplace: {
      delete: async () => ({
        success: false,
        error:
          'Published agent on the AI Marketplace uses this skill\'s listing: "Research Buddy". Unpublish that agent first, then unpublish this skill.',
        errorCode: "skill_dependency_of_published_agents",
      }),
    },
  });
  await harness.window.loadSkills();
  await harness.window.openSkillDetailsModal(USER_SKILL);
  await flushAsync();

  clickPageAction(harness, "skill-page-unpublish-btn");
  await flushAsync();
  assert.equal(harness.confirmCalls.length, 1);

  // The confirm's promise rejects → the shared modal renders the guard's
  // explanation inline (modal stays open); nothing local mutates.
  await assert.rejects(
    () => harness.confirmCalls[0].onConfirm(),
    /Unpublish that agent first, then unpublish this skill/,
  );
  assert.equal(harness.calls.clearSkillLink.length, 0, "local link untouched");
  assert.match(
    harness.getElementById("agent-skills-editor").innerHTML,
    /badge-published/,
    "the Published badge stays",
  );
});
