// Round-12 read-only page for git-marketplace skills: opened via the
// AgentSkillsHooks bridge, it SUSPENDS the marketplace details page (Back
// resumes it — the browser restore is skipped), renders the materialized
// bundle through the shared virtual-file machinery, installs IN PLACE (no
// navigation), and caches remote bundles per session while installed copies
// always re-read from disk.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  FakeElement,
  flushAsync,
  loadAgentSkillsHarness,
} = require("./agent-skills-harness");

const SKILL_MD =
  '---\nname: digest\ndescription: fixture digest skill\nversion: "1.0"\n---\n\n# digest body\n';

function record(overrides = {}) {
  return {
    marketplaceId: "kwp",
    marketplaceName: "Knowledge Work Plugins",
    skillId: "digest",
    pluginName: "enterprise-search",
    skillPath: "./enterprise-search/skills/digest",
    skillSource: { source: "github", repo: "anthropics/knowledge-work-plugins" },
    installed: false,
    installedVersion: null,
    displayName: "Digest",
    description: "Digest things",
    ...overrides,
  };
}

function gitPageHarness({ bundleImpl = null } = {}) {
  const h = loadAgentSkillsHarness({
    electronAPI: bundleImpl ? { getMarketplaceSkillBundle: bundleImpl } : {},
  });
  const suspendCalls = [];
  const resumeCalls = [];
  const closeCalls = [];
  h.window.suspendMarketplaceDetailsPage = () => {
    suspendCalls.push(1);
    return true;
  };
  // Tests flip this to model the page having been closed meanwhile.
  h.resumeResult = true;
  h.window.resumeMarketplaceDetailsPage = () => {
    resumeCalls.push(1);
    return h.resumeResult;
  };
  h.window.closeMarketplaceDetailsPage = () => closeCalls.push(1);
  return { h, suspendCalls, resumeCalls, closeCalls };
}

function successBundle(skillId, { installed = false } = {}) {
  return {
    success: true,
    installed,
    bundle: {
      type: "skills",
      id: skillId,
      payload: {
        name: String(skillId),
        skill_md: SKILL_MD,
        references: [
          { path: "references/how.md", content_b64: Buffer.from("how body").toString("base64") },
        ],
        scripts: [],
      },
    },
  };
}

test("opening a git-marketplace skill suspends the details page and renders the read-only bundle", async () => {
  const { h, suspendCalls, closeCalls } = gitPageHarness({
    bundleImpl: async (...args) => {
      bundleCalls.push(args);
      return successBundle("digest");
    },
  });
  const bundleCalls = [];
  await h.window.AgentSkillsHooks.openGitMarketplaceSkillPage(record());
  await flushAsync(12);

  assert.equal(suspendCalls.length, 1, "the details page suspended once");
  assert.equal(closeCalls.length, 0, "never force-closed on this path");
  assert.deepEqual(bundleCalls, [["kwp", "digest", "enterprise-search"]]);

  const host = h.getElementById("agent-skills-editor");
  assert.match(
    host.innerHTML,
    /This skill is from the .Knowledge Work Plugins. marketplace\. Install it to use it in chats\./,
  );
  assert.match(host.innerHTML, /skill-page-git-install-btn/);
  assert.doesNotMatch(host.innerHTML, /btn-all-installed/);
  assert.match(host.innerHTML, /badge-marketplace-name/);
  assert.doesNotMatch(host.innerHTML, />Installed</);

  const fileTree = h.getElementById("skill-file-tree");
  assert.match(
    fileTree.innerHTML,
    /data-path="git-marketplace-listing:\/\/kwp\/enterprise-search\/digest\/SKILL\.md"/,
  );
  assert.match(fileTree.innerHTML, /how\.md/);
  // SKILL.md auto-opened from the in-memory bundle: frontmatter pane, no
  // filesystem IPC, no edit affordance on a read-only source.
  const contentArea = h.getElementById("skill-content-area");
  assert.match(contentArea.innerHTML, /md-frontmatter/);
  assert.match(contentArea.innerHTML, /digest body/);
  assert.doesNotMatch(contentArea.innerHTML, /skill-file-edit-btn/);
  assert.equal(h.calls.getSkillFiles.length, 0);
  assert.equal(h.calls.readSkillFile.length, 0);
});

test("Back resumes the suspended details page and skips the browser restore; a dead page falls back", async () => {
  const { h, resumeCalls } = gitPageHarness();
  await h.window.AgentSkillsHooks.openGitMarketplaceSkillPage(record());
  await flushAsync(12);
  const host = h.getElementById("agent-skills-editor");
  const browser = h.getElementById("agent-skills-browser");
  assert.equal(browser.style.display, "none");

  host.querySelector(".agent-editor-back-btn").click();
  await flushAsync();
  assert.equal(resumeCalls.length, 1, "resume handed the subview back");
  assert.equal(host.innerHTML, "", "page torn down");
  assert.equal(
    browser.style.display,
    "none",
    "browser restore skipped — the details page owns the subview",
  );

  // Resume failing (the page was closed meanwhile) falls through to the
  // normal browser restore.
  await h.window.AgentSkillsHooks.openGitMarketplaceSkillPage(record());
  await flushAsync(12);
  h.resumeResult = false;
  host.querySelector(".agent-editor-back-btn").click();
  await flushAsync();
  assert.equal(resumeCalls.length, 2);
  assert.equal(browser.style.display, "", "fallback restored the browser");
});

test("Install flips the page in place — IPC args from the record, green state, refreshed surfaces, breadcrumb intact", async () => {
  const { h, resumeCalls } = gitPageHarness();
  const refreshCalls = [];
  h.window.refreshMarketplaceSurfaces = async () => {
    refreshCalls.push(1);
  };
  const rec = record();
  await h.window.AgentSkillsHooks.openGitMarketplaceSkillPage(rec);
  await flushAsync(12);

  const host = h.getElementById("agent-skills-editor");
  const actionsEl = host.querySelector("[data-skill-page-actions]");
  const installBtn = new FakeElement("git-install-btn");
  installBtn.classList.add("skill-page-git-install-btn");
  actionsEl.dispatch("click", { target: { closest: () => installBtn } });
  await flushAsync(16);

  assert.deepEqual(h.calls.installMarketplaceSkill, [
    [
      "kwp",
      "digest",
      "./enterprise-search/skills/digest",
      rec.skillSource,
      "enterprise-search",
    ],
  ]);
  assert.ok(
    h.notifications.some(
      ([kind, message]) => kind === "success" && /installed successfully/i.test(message),
    ),
  );
  // The page flipped in place: green state action, Installed chip, banner
  // copy — all without navigating anywhere.
  const refreshedActions = h.document.querySelector("[data-skill-page-actions]");
  assert.match(refreshedActions.innerHTML, /btn-all-installed/);
  assert.doesNotMatch(refreshedActions.innerHTML, /skill-page-git-install-btn/);
  const banner = h.document.querySelector("[data-skill-page-banner]");
  assert.match(
    banner.textContent,
    /installed from the "Knowledge Work Plugins" marketplace/,
  );
  assert.equal(refreshCalls.length, 1, "suspended marketplace grid refreshed");

  // Back still resumes the marketplace page — install never broke the
  // breadcrumb by navigating.
  host.querySelector(".agent-editor-back-btn").click();
  await flushAsync();
  assert.equal(resumeCalls.length, 1);
});

test("installed records render the green state and always re-read from disk (no session cache)", async () => {
  const bundleCalls = [];
  const { h } = gitPageHarness({
    bundleImpl: async (...args) => {
      bundleCalls.push(args);
      return successBundle("digest", { installed: true });
    },
  });
  const rec = record({ installed: true, installedVersion: "1.0" });
  await h.window.AgentSkillsHooks.openGitMarketplaceSkillPage(rec);
  await flushAsync(12);

  const host = h.getElementById("agent-skills-editor");
  assert.match(host.innerHTML, /btn-all-installed/);
  assert.doesNotMatch(host.innerHTML, /skill-page-git-install-btn/);
  assert.match(host.innerHTML, />Installed</);
  assert.match(host.innerHTML, /read only here/);
  assert.equal(bundleCalls.length, 1);

  // Close and re-open: installed copies re-fetch (disk reads are cheap and
  // never stale).
  h.resumeResult = false;
  host.querySelector(".agent-editor-back-btn").click();
  await flushAsync();
  await h.window.AgentSkillsHooks.openGitMarketplaceSkillPage(rec);
  await flushAsync(12);
  assert.equal(bundleCalls.length, 2, "no cache for installed copies");
});

test("remote bundles cache for the session — re-opening an uninstalled skill skips the IPC", async () => {
  const bundleCalls = [];
  const { h } = gitPageHarness({
    bundleImpl: async (...args) => {
      bundleCalls.push(args);
      return successBundle("digest");
    },
  });
  await h.window.AgentSkillsHooks.openGitMarketplaceSkillPage(record());
  await flushAsync(12);
  assert.equal(bundleCalls.length, 1);

  const host = h.getElementById("agent-skills-editor");
  h.resumeResult = false;
  host.querySelector(".agent-editor-back-btn").click();
  await flushAsync();

  await h.window.AgentSkillsHooks.openGitMarketplaceSkillPage(record());
  await flushAsync(12);
  assert.equal(bundleCalls.length, 1, "session cache served the re-open");
  assert.match(
    h.getElementById("skill-file-tree").innerHTML,
    /git-marketplace-listing:\/\/kwp\/enterprise-search\/digest\/SKILL\.md/,
  );
});

test("a failed bundle fetch renders the in-tree error and keeps the page open", async () => {
  const { h } = gitPageHarness({
    bundleImpl: async () => ({ success: false, error: "boom", errorCode: "skill_not_found" }),
  });
  await h.window.AgentSkillsHooks.openGitMarketplaceSkillPage(record());
  await flushAsync(12);

  const fileTree = h.getElementById("skill-file-tree");
  assert.match(
    fileTree.innerHTML,
    /skill-file-error">Couldn't load this skill from the marketplace/,
  );
  const host = h.getElementById("agent-skills-editor");
  assert.match(host.innerHTML, /agent-editor-page/, "page stays up");
});

test("opening a LOCAL skill page keeps the flagless force-close of the details page", async () => {
  const { h, suspendCalls, closeCalls } = gitPageHarness();
  const localSkill = {
    name: "notes",
    display_name: "Notes",
    source: "user",
    skill_path: "skills-user/notes",
    description: "Local skill",
    created_by_email: "dsantiago@example.invalid",
  };
  await h.window.openSkillDetailsModal(localSkill);
  await flushAsync(12);

  assert.equal(closeCalls.length, 1, "local opens still close the details page");
  assert.equal(suspendCalls.length, 0, "suspension is exclusive to the git path");
});
