// Marketplace provenance on skill cards and the inline skill page. The card
// shell is exercised through the REAL shared SkillCardRenderer (vm-executed);
// list/page flows run agent-skills.js in the vm FakeElement harness
// (agent-skills-harness.js) — no source pins.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const {
  FakeElement,
  flushAsync,
  loadAgentSkillsHarness,
} = require("./agent-skills-harness");

const rendererPath = path.join(
  __dirname,
  "..",
  "renderer",
  "components",
  "skill-card-renderer.js",
);
const rendererSource = fs.readFileSync(rendererPath, "utf8");

function loadRenderer() {
  const window = {};
  const context = {
    window,
    URL,
    console,
  };
  context.globalThis = context;
  vm.runInNewContext(rendererSource, context, { filename: rendererPath });
  return window.SkillCardRenderer;
}

const INSTALLED_SKILL = Object.freeze({
  name: "ai-marketplace/docx",
  display_name: "Docx",
  source: "marketplace",
  skill_path: "skills-marketplace/ai-marketplace/docx",
  marketplace_id: "ai-marketplace",
  marketplace_name: "AI Marketplace",
  marketplace_solution_id: "sol-docx",
  description: "Creates Word documents.",
  version: "1.2.3",
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

test("installed skill cards use the blue Installed badge and preserve provider, author, and version", () => {
  const renderer = loadRenderer();
  const html = renderer.buildSkillCardHtml({
    name: "ai-marketplace/docx",
    display_name: "Docx",
    description: "Creates Word documents.",
    source: "marketplace",
    marketplace_name: "anthropic-agent-skills",
    author: "Keith Lazuka",
    version: "1.2.3",
  });

  assert.match(html, /badge-installed">Installed</);
  assert.match(
    html,
    /badge-marketplace-name[^>]*>anthropic-agent-skills</,
  );
  // Version chips were dropped from skill cards (Round 12): the author now
  // rides the first badge row and the separate meta row is gone entirely.
  assert.doesNotMatch(html, /badge-version/);
  assert.doesNotMatch(html, /skill-meta-badges/);
  assert.match(html, /badge-author">Keith Lazuka</);
  assert.doesNotMatch(html, />(MARKETPLACE|Marketplace)</);
  assert.doesNotMatch(html, /READ-ONLY COPY/);
  assert.doesNotMatch(html, />EDITABLE</);
  // No plugin → no plugin chip.
  assert.doesNotMatch(html, /badge-plugin/);
});

test("plugin skills carry a quiet plugin chip on the card badge row", () => {
  const renderer = loadRenderer();
  const html = renderer.buildSkillCardHtml({
    name: "portico-ai-marketplace/a11y/fixing-jira-a11y-in-bulk",
    display_name: "Fixing Jira A11y In Bulk",
    description: "Bulk Jira accessibility remediation.",
    source: "marketplace",
    marketplace_id: "portico-ai-marketplace",
    marketplace_name: "portico-ai-marketplace",
    plugin_name: "a11y",
    author: "mkestner",
  });

  assert.match(html, /badge-plugin"[^>]*title="From plugin A11y"[^>]*>A11y</);
  // Provenance order: Installed → marketplace name → plugin.
  assert.match(
    html,
    /badge-marketplace-name[^>]*>portico-ai-marketplace<\/span><span class="mcp-card-badge badge-plugin"/,
  );
});

test("user skill cards retain the authenticated User identity and published state independently", () => {
  const renderer = loadRenderer();
  const html = renderer.buildSkillCardHtml(
    {
      name: "owned-skill",
      description: "Owned skill.",
      source: "user",
      created_by_email: "DSANTIAGO@example.invalid",
      author: "Spoofed frontmatter author",
      version: "2.0",
    },
    {
      link: {
        solutionId: "owned-solution",
        hasLocalChanges: true,
      },
    },
  );

  assert.match(html, /badge-user">User</);
  // EDITABLE was removed for consistency with agent cards: it fired on
  // exactly the same condition as USER and carried no extra information.
  assert.doesNotMatch(html, />EDITABLE</);
  assert.match(html, /badge-author">DSANTIAGO</);
  assert.doesNotMatch(html, /Spoofed frontmatter author/);
  assert.match(html, /badge-published[^>]*>Published</);
  assert.match(html, /badge-unpublished[^>]*>Unpublished changes</);
  // Dirty published skills also tint the whole card.
  assert.match(html, /mcp-server-card skill-card has-unpublished-changes/);
  assert.doesNotMatch(html, /badge-installed/);
});

test("outdated installed skill cards show the update or conflict state", () => {
  const renderer = loadRenderer();
  const base = {
    name: "ai-marketplace/docx",
    display_name: "Docx",
    description: "Creates Word documents.",
    source: "marketplace",
    marketplace_name: "Solutions Marketplace",
    version: "1.0",
  };

  const outdated = renderer.buildSkillCardHtml(base, { updateAvailable: true });
  assert.match(outdated, /badge-has-updates[^>]*>Update available</);
  assert.match(outdated, /mcp-server-card skill-card update-available/);

  const conflicted = renderer.buildSkillCardHtml(base, {
    updateAvailable: true,
    conflict: true,
  });
  assert.match(conflicted, /badge-conflict[^>]*>Conflict</);
  assert.doesNotMatch(conflicted, /badge-has-updates/);

  const current = renderer.buildSkillCardHtml(base, {});
  assert.doesNotMatch(current, /update-available/);
});

test("clean published skill cards carry no dirty tint", () => {
  const renderer = loadRenderer();
  const html = renderer.buildSkillCardHtml(
    {
      name: "owned-skill",
      description: "Owned skill.",
      source: "user",
      created_by_email: "dsantiago@example.invalid",
      version: "2.0",
    },
    { link: { solutionId: "owned-solution", hasLocalChanges: false } },
  );
  assert.doesNotMatch(html, /has-unpublished-changes/);
  assert.match(html, /badge-published[^>]*>Published</);
});

test("installed skill menus and details remain read-only while exposing safe lifecycle actions", async () => {
  // Card ellipsis menu: no Publish (or Open-Folder) for installed copies —
  // Details/Export/Duplicate remain, and the destructive action is the REAL
  // Uninstall lifecycle (round 11), never the legacy Delete.
  const harness = loadAgentSkillsHarness({
    skills: [INSTALLED_SKILL],
    publishedSolutionIds: ["sol-docx"],
  });
  await harness.window.loadSkills();
  harness.window.clearSkillsFilters(); // installed cards live outside the default User facet
  const listHtml = harness.getElementById("skills-list").innerHTML;
  assert.match(listHtml, /skill-details-menu-btn/);
  assert.match(listHtml, /skill-export-menu-btn/);
  assert.match(listHtml, /skill-duplicate-menu-btn/);
  assert.match(listHtml, /skill-uninstall-menu-btn/);
  assert.doesNotMatch(listHtml, /skill-delete-menu-btn/);
  assert.doesNotMatch(listHtml, /skill-publish-ai-marketplace-menu-btn/);
  assert.doesNotMatch(listHtml, /skill-open-folder-menu-btn/);

  // Page actions for a viewer-owned installed copy: Unpublish, Duplicate,
  // Export, Uninstall (in that order) — never Publish, Open-Folder, or the
  // legacy Delete.
  await harness.window.openSkillDetailsModal(INSTALLED_SKILL);
  await flushAsync();
  const pageHtml = harness.getElementById("agent-skills-editor").innerHTML;
  assert.doesNotMatch(pageHtml, /skill-page-publish-btn/);
  assert.doesNotMatch(pageHtml, /skill-page-open-folder-btn/);
  assert.doesNotMatch(pageHtml, /skill-page-delete-btn/);
  const order = [
    "skill-page-unpublish-btn",
    "skill-page-duplicate-btn",
    "skill-page-export-btn",
    "skill-page-uninstall-btn",
  ].map((cls) => pageHtml.indexOf(cls));
  assert.ok(order.every((idx) => idx >= 0), "all lifecycle actions render");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "action order is stable");

  // A NON-owned installed copy loses Unpublish too (remote ownership is an
  // independent fact) but keeps the safe local actions.
  const foreign = loadAgentSkillsHarness({ skills: [INSTALLED_SKILL] });
  await foreign.window.openSkillDetailsModal(INSTALLED_SKILL);
  await flushAsync();
  const foreignHtml = foreign.getElementById("agent-skills-editor").innerHTML;
  assert.doesNotMatch(foreignHtml, /skill-page-unpublish-btn/);
  assert.doesNotMatch(foreignHtml, /skill-page-publish-btn/);
  assert.match(foreignHtml, /skill-page-duplicate-btn/);
  assert.match(foreignHtml, /skill-page-export-btn/);
  assert.match(foreignHtml, /skill-page-uninstall-btn/);
});

test("installed skill page chips use Installed instead of Marketplace", async () => {
  const harness = loadAgentSkillsHarness({ skills: [INSTALLED_SKILL] });
  await harness.window.openSkillDetailsModal(INSTALLED_SKILL);
  await flushAsync();
  const pageHtml = harness.getElementById("agent-skills-editor").innerHTML;
  // Source chip is the shared app badge with the INSTALLED label, plus the
  // marketplace-name chip; the retired READ-ONLY COPY wording never renders.
  assert.match(pageHtml, /class="mcp-card-badge badge-installed">Installed</);
  assert.match(pageHtml, /badge-marketplace-name[^>]*>AI Marketplace</);
  assert.doesNotMatch(pageHtml, /READ-ONLY COPY/);
  assert.doesNotMatch(pageHtml, />(MARKETPLACE|Marketplace)</);
  // The read-only explainer pane replaces editing affordances.
  assert.match(pageHtml, /marketplace-readonly-pane/);
});

test("installed Published state is resolved by exact viewer-owned solution id", async () => {
  const userSkill = {
    name: "owned-skill",
    source: "user",
    skill_path: "skills-user/owned-skill",
    description: "Owned",
    created_by_email: "dsantiago@example.invalid",
  };

  // A local link whose solution id is NOT in the viewer's listPublished set
  // is unverified: no Published chip and publish state fails closed (no
  // Publish/Unpublish actions), even though the raw link exists.
  const unverified = loadAgentSkillsHarness({
    skills: [userSkill],
    links: { "owned-skill": { solutionId: "sol-stale", hasLocalChanges: false } },
    publishedSolutionIds: [],
  });
  await unverified.window.loadSkills();
  assert.deepEqual(
    unverified.calls.listPublished,
    ["skills"],
    "publish state loads from the ownership-authoritative listPublished(skills)",
  );
  assert.doesNotMatch(
    unverified.getElementById("skills-list").innerHTML,
    /badge-published/,
  );
  await unverified.window.openSkillDetailsModal(userSkill);
  await flushAsync();
  const unverifiedPage = unverified.getElementById("agent-skills-editor").innerHTML;
  assert.doesNotMatch(unverifiedPage, /badge-published/);
  assert.doesNotMatch(unverifiedPage, /skill-page-publish-btn/);
  assert.doesNotMatch(unverifiedPage, /skill-page-unpublish-btn/);

  // The SAME link becomes Published once the exact id is viewer-owned.
  const verified = loadAgentSkillsHarness({
    skills: [userSkill],
    links: { "owned-skill": { solutionId: "sol-stale", hasLocalChanges: false } },
    publishedSolutionIds: ["sol-stale"],
  });
  await verified.window.loadSkills();
  assert.match(
    verified.getElementById("skills-list").innerHTML,
    /class="mcp-card-badge badge-published"/,
  );

  // Installed copies resolve by their own marketplace_solution_id: a
  // viewer-owned installed copy shows Published AND can be unpublished, but
  // unpublishing an INSTALLED copy never clears a local skill link
  // (clearLocalLink applies to user-source skills only).
  const installedOwned = loadAgentSkillsHarness({
    skills: [INSTALLED_SKILL],
    publishedSolutionIds: ["sol-docx"],
  });
  await installedOwned.window.loadSkills();
  await installedOwned.window.openSkillDetailsModal(INSTALLED_SKILL);
  await flushAsync();
  assert.match(
    installedOwned.getElementById("agent-skills-editor").innerHTML,
    /class="mcp-card-badge badge-published"/,
  );
  clickPageAction(installedOwned, "skill-page-unpublish-btn");
  await flushAsync();
  assert.equal(installedOwned.confirmCalls.length, 1);
  installedOwned.confirmCalls[0].onConfirm();
  await flushAsync();
  assert.deepEqual(installedOwned.calls.delete, ["sol-docx"]);
  assert.deepEqual(
    installedOwned.calls.clearSkillLink,
    [],
    "installed-copy unpublish must not clear any local user-skill link",
  );
});

// ---------------------------------------------------------------------------
// Round-6 renderer options for remote marketplace listings (Discover tab)
// ---------------------------------------------------------------------------

test("hideSourceBadge omits only the source chip; Published and author survive", () => {
  const renderer = loadRenderer();
  const listing = {
    name: "llm-proxy-analytics",
    description: "Query LLM Proxy logging data.",
    source: "user",
    created_by_email: "jdoe@example.invalid",
  };

  const withChip = renderer.buildSkillCardHtml(listing, { interactive: false });
  assert.match(withChip, />User</);

  const hidden = renderer.buildSkillCardHtml(listing, {
    interactive: false,
    hideSourceBadge: true,
    published: true,
  });
  assert.doesNotMatch(hidden, />User</);
  assert.doesNotMatch(hidden, />Core</);
  assert.match(hidden, />Published</);
  assert.doesNotMatch(hidden, /badge-version/);
  assert.match(hidden, />jdoe</);
  // Title-cased name still renders from the slug.
  assert.match(hidden, /Llm Proxy Analytics/);
});

test("footerHtml renders an action strip; default cards stay footer-free", () => {
  const renderer = loadRenderer();
  const listing = {
    name: "tool-x",
    description: "A tool.",
    source: "user",
  };

  const plain = renderer.buildSkillCardHtml(listing, { interactive: false });
  assert.doesNotMatch(plain, /mcp-card-footer skill-card-actions/);

  const withFooter = renderer.buildSkillCardHtml(listing, {
    interactive: false,
    footerHtml: '<button class="btn-primary">Install Skill</button>',
  });
  assert.match(
    withFooter,
    /<div class="mcp-card-footer skill-card-actions"><button class="btn-primary">Install Skill<\/button><\/div>/,
  );
});
