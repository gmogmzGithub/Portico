// Marketplace-installed skills on the Agent Skills browse grid and inline
// page offer UNINSTALL (the real registry-pruning lifecycle) instead of the
// legacy Delete path, whose managed-install bookkeeping was partial (depth-2
// only). User skills keep Delete. Confirm-first, IPC carries the identity
// triple (marketplaceId, bareSkillId, pluginName) derived from the FQN.
const test = require("node:test");
const assert = require("node:assert/strict");

const { flushAsync, loadAgentSkillsHarness } = require("./agent-skills-harness");

const PLUGIN_SKILL = Object.freeze({
  name: "kwp/enterprise-search/digest",
  display_name: "Digest",
  source: "marketplace",
  skill_path: "skills-marketplace/kwp/enterprise-search/digest",
  marketplace_id: "kwp",
  marketplace_name: "Knowledge Work Plugins",
  plugin_name: "enterprise-search",
  description: "Digest skill",
  version: "1.0",
});

const FLAT_SKILL = Object.freeze({
  name: "ai-marketplace/notes",
  display_name: "Notes",
  source: "marketplace",
  skill_path: "skills-marketplace/ai-marketplace/notes",
  marketplace_id: "ai-marketplace",
  marketplace_name: "AI Marketplace",
  description: "Installed notes skill",
  version: "1.0",
});

const USER_SKILL = Object.freeze({
  name: "my-notes",
  display_name: "My Notes",
  source: "user",
  skill_path: "skills-user/my-notes",
  description: "Mine",
  version: "1.0",
});

test("kebab menus offer Uninstall (not Delete) for marketplace installs; user skills keep Delete", async () => {
  const h = loadAgentSkillsHarness({
    skills: [PLUGIN_SKILL, FLAT_SKILL, USER_SKILL],
  });
  await h.window.loadSkills();
  await flushAsync();

  // The user's surface: the Installed chip on the browse grid (its filter
  // value is "marketplace" — installed local copies).
  h.window.AgentSkillsHooks.applySkillsActiveFilter("marketplace");
  await flushAsync();
  const html = h.getElementById("skills-list").innerHTML;
  assert.match(
    html,
    /skill-uninstall-menu-btn delete-action" data-skill-name="kwp\/enterprise-search\/digest"/,
  );
  assert.match(
    html,
    /skill-uninstall-menu-btn delete-action" data-skill-name="ai-marketplace\/notes"/,
  );
  assert.doesNotMatch(
    html,
    /skill-delete-menu-btn[^>]*data-skill-name="kwp\/enterprise-search\/digest"/,
    "managed installs never see the legacy delete",
  );
  assert.doesNotMatch(
    html,
    /skill-delete-menu-btn[^>]*data-skill-name="ai-marketplace\/notes"/,
  );

  h.window.AgentSkillsHooks.applySkillsActiveFilter("user");
  await flushAsync();
  const userHtml = h.getElementById("skills-list").innerHTML;
  assert.match(
    userHtml,
    /skill-delete-menu-btn delete-action" data-skill-name="my-notes"/,
  );
  assert.doesNotMatch(
    userHtml,
    /skill-uninstall-menu-btn[^>]*data-skill-name="my-notes"/,
    "user skills keep Delete, not Uninstall",
  );
});

test("uninstall confirms first, then fires the real IPC with the FQN-derived identity triple", async () => {
  const skills = [PLUGIN_SKILL, USER_SKILL];
  const uninstallCalls = [];
  const h = loadAgentSkillsHarness({
    skills,
    electronAPI: {
      uninstallMarketplaceSkill: async (marketplaceId, skillId, pluginName = null) => {
        uninstallCalls.push([marketplaceId, skillId, pluginName]);
        const index = skills.findIndex((s) => s.name === PLUGIN_SKILL.name);
        if (index >= 0) skills.splice(index, 1);
        return { success: true };
      },
    },
  });
  await h.window.loadSkills();
  await flushAsync();

  h.window.AgentSkillsHooks.confirmUninstallMarketplaceSkill(PLUGIN_SKILL);
  assert.equal(h.confirmCalls.length, 1, "the confirm modal opens");
  assert.equal(h.confirmCalls[0].title, "Uninstall skill?");
  assert.match(h.confirmCalls[0].message, /Digest/);
  assert.match(h.confirmCalls[0].message, /Knowledge Work Plugins/);
  assert.equal(h.confirmCalls[0].danger, true);
  assert.equal(uninstallCalls.length, 0, "no IPC before the user confirms");

  await h.confirmCalls[0].onConfirm();
  await flushAsync();
  assert.deepEqual(uninstallCalls, [["kwp", "digest", "enterprise-search"]]);
  assert.ok(
    h.notifications.some(
      ([kind, message]) => kind === "success" && /uninstalled/.test(message),
    ),
  );
  assert.doesNotMatch(
    h.getElementById("skills-list").innerHTML,
    /data-skill-name="kwp\/enterprise-search\/digest"/,
    "the card is gone after the refresh",
  );
});

test("depth-2 (flat) installs pass a null plugin name", async () => {
  const h = loadAgentSkillsHarness({ skills: [FLAT_SKILL] });
  await h.window.loadSkills();
  await flushAsync();

  h.window.AgentSkillsHooks.confirmUninstallMarketplaceSkill(FLAT_SKILL);
  await h.confirmCalls[0].onConfirm();
  await flushAsync();
  assert.deepEqual(h.calls.uninstallMarketplaceSkill, [
    ["ai-marketplace", "notes", null],
  ]);
});

test("a failed uninstall throws so the confirm modal shows the inline error", async () => {
  const h = loadAgentSkillsHarness({
    skills: [PLUGIN_SKILL],
    electronAPI: {
      uninstallMarketplaceSkill: async () => ({ success: false, error: "boom" }),
    },
  });
  await h.window.loadSkills();
  await flushAsync();

  h.window.AgentSkillsHooks.confirmUninstallMarketplaceSkill(PLUGIN_SKILL);
  await assert.rejects(h.confirmCalls[0].onConfirm(), /boom/);
});

test("a guard-blocked uninstall swaps to the blocking modal naming the agents, mutating nothing", async () => {
  const h = loadAgentSkillsHarness({
    skills: [PLUGIN_SKILL],
    electronAPI: {
      uninstallMarketplaceSkill: async () => ({
        success: false,
        error:
          'Skill "digest" is attached to agents: "Research Buddy". Remove it from that agent first, then try again.',
        errorCode: "skill_in_use_by_agents",
        body: { skill_id: "digest", agents: [{ id: "a1", name: "Research Buddy" }] },
      }),
    },
  });
  await h.window.loadSkills();
  await flushAsync();
  h.window.AgentSkillsHooks.applySkillsActiveFilter("marketplace");
  await flushAsync();

  h.window.AgentSkillsHooks.confirmUninstallMarketplaceSkill(PLUGIN_SKILL);
  await h.confirmCalls[0].onConfirm();
  await flushAsync();

  assert.equal(h.confirmCalls.length, 2, "the blocking modal replaced the confirm");
  assert.equal(h.confirmCalls[1].confirmLabel, "Close");
  assert.match(h.confirmCalls[1].message, /Research Buddy/);
  assert.match(
    h.getElementById("skills-list").innerHTML,
    /data-skill-name="kwp\/enterprise-search\/digest"/,
    "the card survives — nothing was uninstalled",
  );
});

test("a guard-blocked DELETE of a user skill shows the blocking modal instead of the toast", async () => {
  const h = loadAgentSkillsHarness({
    skills: [USER_SKILL],
    electronAPI: {
      deleteSkill: async () => ({
        success: false,
        error:
          'Skill "my-notes" is attached to agents: "Research Buddy". Remove it from that agent first, then try again.',
        errorCode: "skill_in_use_by_agents",
        body: { skill_id: "my-notes", agents: [{ id: "a1", name: "Research Buddy" }] },
      }),
    },
  });
  const skillsList = h.getElementById("skills-list");
  const deleteBtn = new (require("./agent-skills-harness").FakeElement)("del");
  deleteBtn.dataset.skillName = "my-notes";
  skillsList.qsaResults.set(".skill-delete-menu-btn", [deleteBtn]);
  await h.window.loadSkills();
  await flushAsync();

  deleteBtn.click({ stopPropagation() {} });
  h.getElementById("delete-skill-confirm-btn").click();
  await flushAsync(12);

  assert.equal(h.confirmCalls.length, 1, "the blocking modal opened");
  assert.equal(h.confirmCalls[0].confirmLabel, "Close");
  assert.match(h.confirmCalls[0].message, /Research Buddy/);
  assert.ok(
    !h.notifications.some(([, message]) => /Failed to delete skill/.test(message)),
    "no generic failure toast alongside the modal",
  );
  assert.match(
    skillsList.innerHTML,
    /data-skill-name="my-notes"/,
    "the card survives — nothing was deleted",
  );
});

test("the skill page renders the publish share-tooltip beside Publish as a sibling, never inside the button", async () => {
  const h = loadAgentSkillsHarness({ skills: [USER_SKILL] });
  // The trigger builder ships in agents.js; the bundled skills code consumes
  // the window export at render time.
  h.window.InfoTooltips = {
    triggerHtml: (text) =>
      `<span class="info-tooltip-trigger" data-info-tooltip="${text}"></span>`,
  };
  await h.window.loadSkills();
  await flushAsync();
  await h.window.openSkillDetailsModal(USER_SKILL);
  await flushAsync();

  const html = h.getElementById("agent-skills-editor").innerHTML;
  assert.match(
    html,
    /skill-page-publish-btn[\s\S]*?<\/button><span class="info-tooltip-trigger"/,
    "the trigger is a sibling immediately after the Publish button",
  );
  assert.match(html, /Share this skill with everyone at Portico/);
  // The kebab publish item explains publishing via its native title.
  h.window.AgentSkillsHooks.applySkillsActiveFilter("user");
  await flushAsync();
  assert.match(
    h.getElementById("skills-list").innerHTML,
    /skill-publish-ai-marketplace-menu-btn[^>]*title="Share this skill with everyone at Portico so they can add it to their own AI Chat sessions\."/,
  );
});

test("the inline skill page swaps Delete for Uninstall on marketplace installs", async () => {
  const h = loadAgentSkillsHarness({ skills: [PLUGIN_SKILL, USER_SKILL] });
  await h.window.loadSkills();
  await flushAsync();

  await h.window.openSkillDetailsModal(PLUGIN_SKILL);
  await flushAsync();
  const host = h.getElementById("agent-skills-editor");
  assert.match(host.innerHTML, /skill-page-uninstall-btn/);
  assert.doesNotMatch(host.innerHTML, /skill-page-delete-btn/);

  await h.window.openSkillDetailsModal(USER_SKILL);
  await flushAsync();
  assert.match(host.innerHTML, /skill-page-delete-btn/);
  assert.doesNotMatch(host.innerHTML, /skill-page-uninstall-btn/);
});

// ---------------------------------------------------------------------------
// Round 13: agent-referenced skills grey Delete/Uninstall (aria-disabled +
// right-placed agents tooltip) instead of letting the click reach the guard.
// ---------------------------------------------------------------------------

test("agent-referenced skills grey kebab Delete/Uninstall with the agents tooltip payload", async () => {
  const h = loadAgentSkillsHarness({
    skills: [PLUGIN_SKILL, FLAT_SKILL, USER_SKILL],
    agentUsage: [
      { id: "a1", name: "Research Buddy", leaves: ["digest", "my-notes"] },
      { id: "a2", name: "Planner Bot", leaves: ["digest"] },
    ],
  });
  await h.window.loadSkills();
  await flushAsync();

  h.window.AgentSkillsHooks.applySkillsActiveFilter("marketplace");
  await flushAsync();
  const html = h.getElementById("skills-list").innerHTML;
  // digest (2 agents): the item itself becomes the greyed hover unit.
  assert.match(
    html,
    /skill-uninstall-menu-btn delete-action info-tooltip-trigger" data-skill-name="kwp\/enterprise-search\/digest" aria-disabled="true"/,
  );
  assert.match(html, /data-info-tooltip-placement="right"/);
  assert.match(html, /Used by 2 agents/);
  assert.match(html, /Research Buddy/);
  assert.match(html, /Planner Bot/);
  assert.match(html, /Remove it from these agents first\./);
  // notes (unreferenced): active markup stays byte-identical to today's.
  assert.match(
    html,
    /skill-uninstall-menu-btn delete-action" data-skill-name="ai-marketplace\/notes">/,
  );

  h.window.AgentSkillsHooks.applySkillsActiveFilter("user");
  await flushAsync();
  const userHtml = h.getElementById("skills-list").innerHTML;
  assert.match(
    userHtml,
    /skill-delete-menu-btn delete-action info-tooltip-trigger" data-skill-name="my-notes" aria-disabled="true"/,
  );
  assert.match(userHtml, /Used by 1 agent&quot;/, "singular title for one agent");
});

test("clicking a blocked kebab Delete/Uninstall is inert", async () => {
  const { FakeElement } = require("./agent-skills-harness");
  const deleteCalls = [];
  const uninstallCalls = [];
  const h = loadAgentSkillsHarness({
    skills: [PLUGIN_SKILL, USER_SKILL],
    agentUsage: [
      { id: "a1", name: "Research Buddy", leaves: ["digest", "my-notes"] },
    ],
    electronAPI: {
      deleteSkill: async (...args) => {
        deleteCalls.push(args);
        return { success: true };
      },
      uninstallMarketplaceSkill: async (...args) => {
        uninstallCalls.push(args);
        return { success: true };
      },
    },
  });
  const skillsList = h.getElementById("skills-list");
  const deleteBtn = new FakeElement("del");
  deleteBtn.dataset.skillName = "my-notes";
  deleteBtn.setAttribute("aria-disabled", "true");
  const uninstallBtn = new FakeElement("unins");
  uninstallBtn.dataset.skillName = "kwp/enterprise-search/digest";
  uninstallBtn.setAttribute("aria-disabled", "true");
  skillsList.qsaResults.set(".skill-delete-menu-btn", [deleteBtn]);
  skillsList.qsaResults.set(".skill-uninstall-menu-btn", [uninstallBtn]);
  await h.window.loadSkills();
  await flushAsync();

  let stopped = 0;
  deleteBtn.click({ stopPropagation: () => (stopped += 1) });
  uninstallBtn.click({ stopPropagation: () => (stopped += 1) });
  await flushAsync();
  assert.equal(
    stopped,
    2,
    "blocked clicks still stopPropagation — mcp-servers' unconditional document closer would close the menu otherwise",
  );
  assert.equal(
    h.getElementById("delete-skill-modal").classList.contains("visible"),
    false,
    "the delete confirm modal never opens",
  );
  assert.equal(h.confirmCalls.length, 0, "no uninstall confirm modal");
  assert.equal(deleteCalls.length, 0);
  assert.equal(uninstallCalls.length, 0);

  // The same wiring still fires once the block clears.
  deleteBtn.removeAttribute("aria-disabled");
  deleteBtn.click({ stopPropagation() {} });
  await flushAsync();
  assert.equal(
    h.getElementById("delete-skill-modal").classList.contains("visible"),
    true,
    "unblocked Delete opens the confirm modal",
  );
});

test("the skill page greys Delete/Uninstall for agent-referenced skills and ignores their clicks", async () => {
  const { FakeElement } = require("./agent-skills-harness");
  const h = loadAgentSkillsHarness({
    skills: [PLUGIN_SKILL, USER_SKILL],
    agentUsage: [
      { id: "a1", name: "Research Buddy", leaves: ["digest", "my-notes"] },
    ],
  });
  await h.window.loadSkills();
  await flushAsync();

  await h.window.openSkillDetailsModal(USER_SKILL);
  await flushAsync();
  const host = h.getElementById("agent-skills-editor");
  assert.match(
    host.innerHTML,
    /skill-page-delete-btn info-tooltip-trigger"[^>]*aria-disabled="true"/,
  );
  assert.match(host.innerHTML, /data-info-tooltip-placement="right"/);
  assert.match(host.innerHTML, /Used by 1 agent&quot;/);

  // A blocked page action is inert through the delegated handler.
  const actions = h.document.querySelector("[data-skill-page-actions]");
  const blockedBtn = new FakeElement("page-del");
  blockedBtn.classList.add("skill-page-delete-btn");
  blockedBtn.setAttribute("aria-disabled", "true");
  blockedBtn.closest = () => blockedBtn;
  actions.dispatch("click", { target: blockedBtn });
  await flushAsync();
  assert.equal(
    h.getElementById("delete-skill-modal").classList.contains("visible"),
    false,
    "blocked page Delete never opens the confirm modal",
  );

  await h.window.openSkillDetailsModal(PLUGIN_SKILL);
  await flushAsync();
  assert.match(
    host.innerHTML,
    /skill-page-uninstall-btn info-tooltip-trigger"[^>]*aria-disabled="true"/,
  );

  // Without agent references the same page renders active controls.
  const clean = loadAgentSkillsHarness({ skills: [USER_SKILL] });
  await clean.window.loadSkills();
  await flushAsync();
  await clean.window.openSkillDetailsModal(USER_SKILL);
  await flushAsync();
  const cleanHtml = clean.getElementById("agent-skills-editor").innerHTML;
  assert.match(cleanHtml, /skill-page-delete-btn/);
  assert.doesNotMatch(cleanHtml, /skill-page-delete-btn info-tooltip-trigger/);
  assert.doesNotMatch(cleanHtml, /aria-disabled="true"[^>]*data-info-tooltip-list/);
});
