// "Used by N agents" badges on skill cards — one fail-open usage IPC per
// loadSkills cycle feeds a leaf-matched badge row (+ names tooltip via the
// shared InfoTooltips trigger) on the local tabs and Discover counterpart
// cards. Failures and pure remote listings render badge-free; nothing toasts.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  flushAsync,
  loadAgentSkillsHarness,
} = require("./agent-skills-harness");

const USER_NOTES = Object.freeze({
  name: "notes",
  display_name: "Notes",
  source: "user",
  skill_path: "skills-user/notes",
  description: "My notes skill",
  created_by_email: "dsantiago@example.invalid",
  version: "2.0",
});

// Installed git-marketplace copy: the catalog name is the FQN — the badge
// must match agents by LEAF, exactly like the round-11 uninstall guard.
const INSTALLED_DIGEST = Object.freeze({
  name: "kwp/enterprise-search/digest",
  display_name: "Digest",
  source: "marketplace",
  skill_path: "skills-marketplace/kwp/enterprise-search/digest",
  marketplace_id: "kwp",
  marketplace_name: "Knowledge Work Plugins",
  plugin_name: "enterprise-search",
  description: "Digest things",
  version: "1.0",
});

const ORPHAN = Object.freeze({
  name: "orphan",
  display_name: "Orphan",
  source: "user",
  skill_path: "skills-user/orphan",
  description: "Nobody uses this",
  created_by_email: "dsantiago@example.invalid",
  version: "1.0",
});

function seedInfoTooltips(h) {
  h.window.InfoTooltips = {
    triggerHtml: (text) =>
      `<span class="info-tooltip-trigger" data-info-tooltip="${text}"></span>`,
    // Marker-attribute fake: consumers must hand the RICH list spec (title +
    // items + icon) to the shared helper, not a comma-joined sentence — and
    // the badge chip rides INSIDE the trigger (one hover surface).
    listTriggerHtml: (spec, innerHtml = "") =>
      `<span class="info-tooltip-trigger" data-list-title="${spec.title}" data-list-items="${(spec.items || []).join("; ")}" data-list-icon="${spec.icon || ""}">${innerHtml}</span>`,
  };
}

function cardSlice(html, skillName) {
  const start = html.indexOf(`data-skill-name="${skillName}"`);
  assert.ok(start >= 0, `card for ${skillName} rendered`);
  const next = html.indexOf("mcp-server-card skill-card", start);
  return html.slice(start, next === -1 ? undefined : next);
}

test("each loadSkills cycle issues exactly one usage IPC and renders leaf-matched badges with a names tooltip", async () => {
  const h = loadAgentSkillsHarness({
    skills: [USER_NOTES, INSTALLED_DIGEST, ORPHAN],
    agentUsage: [
      { id: "a1", name: "Research Buddy", leaves: ["notes"] },
      { id: "a2", name: "Planner Bot", leaves: ["notes", "digest"] },
    ],
  });
  seedInfoTooltips(h);
  await h.window.loadSkills();
  h.window.AgentSkillsHooks.applySkillsActiveFilter("all");
  await flushAsync();

  assert.equal(h.calls.listAgentSkillUsage, 1, "one usage fetch per cycle");
  const html = h.getElementById("skills-list").innerHTML;
  const notesCard = cardSlice(html, "notes");
  assert.match(notesCard, /badge-agents"[^>]*>2 AGENTS</);
  assert.match(
    notesCard,
    /data-list-title="Used by 2 agents" data-list-items="Research Buddy; Planner Bot" data-list-icon="agent"/,
  );
  // The badge chip rides INSIDE the trigger — hovering the badge itself
  // shows the tooltip, with no dead gap to the icon.
  assert.match(
    notesCard,
    /info-tooltip-trigger"[^>]*>\s*<span class="mcp-card-badge badge-agents">2 AGENTS</,
  );
  // FQN-named installed copy matches by leaf.
  const digestCard = cardSlice(html, "kwp/enterprise-search/digest");
  assert.match(digestCard, /badge-agents"[^>]*>1 AGENT</);
  assert.match(
    digestCard,
    /data-list-title="Used by 1 agent" data-list-items="Planner Bot"/,
  );
  // New top sort level: agent-used skills first, usage count descending —
  // notes (2) before digest (1) before orphan (0), overriding alphabetical.
  const notesIdx = html.indexOf('data-skill-name="notes"');
  const digestIdx = html.indexOf('data-skill-name="kwp/enterprise-search/digest"');
  const orphanIdx = html.indexOf('data-skill-name="orphan"');
  assert.ok(notesIdx >= 0 && digestIdx >= 0 && orphanIdx >= 0);
  assert.ok(
    notesIdx < digestIdx && digestIdx < orphanIdx,
    `usage-desc ranking violated: ${[notesIdx, digestIdx, orphanIdx].join(",")}`,
  );
  // Unreferenced skill: no agents row at all.
  const orphanCard = cardSlice(html, "orphan");
  assert.doesNotMatch(orphanCard, /badge-agents/);
  assert.doesNotMatch(orphanCard, /skill-agents-badges/);

  // A second cycle fetches exactly once more — refresh is per user-triggered
  // load, never a poll.
  await h.window.loadSkills();
  assert.equal(h.calls.listAgentSkillUsage, 2);
});

test("a failed usage fetch renders every card badge-free without a toast", async () => {
  const h = loadAgentSkillsHarness({
    skills: [USER_NOTES],
    electronAPI: {
      listAgentSkillUsage: async () => ({
        success: false,
        error: "agent services down",
        errorCode: "agent_inventory_unavailable",
      }),
    },
  });
  seedInfoTooltips(h);
  await h.window.loadSkills();
  await flushAsync();

  const html = h.getElementById("skills-list").innerHTML;
  assert.match(html, /data-skill-name="notes"/, "the list still renders");
  assert.doesNotMatch(html, /badge-agents/);
  assert.equal(h.notifications.length, 0, "fail-open: no error toast");
});

test("a missing listAgentSkillUsage API (older preload) degrades to badge-free rendering", async () => {
  const h = loadAgentSkillsHarness({
    skills: [USER_NOTES],
    electronAPI: { listAgentSkillUsage: undefined },
  });
  seedInfoTooltips(h);
  await h.window.loadSkills();
  await flushAsync();

  const html = h.getElementById("skills-list").innerHTML;
  assert.match(html, /data-skill-name="notes"/);
  assert.doesNotMatch(html, /badge-agents/);
});

test("Discover counterpart cards carry the badge and rank by usage; pure listings never badge — even on a dangling leaf collision", async () => {
  const INSTALLED_ART = {
    name: "ai-marketplace/algorithmic-art",
    display_name: "Algorithmic Art",
    source: "marketplace",
    skill_path: "skills-marketplace/ai-marketplace/algorithmic-art",
    marketplace_id: "ai-marketplace",
    marketplace_name: "AI Marketplace",
    marketplace_solution_id: "sol-art",
    description: "Installed art skill",
    version: "1.0",
  };
  const INSTALLED_BETA = {
    name: "ai-marketplace/beta-tool",
    display_name: "Beta Tool",
    source: "marketplace",
    skill_path: "skills-marketplace/ai-marketplace/beta-tool",
    marketplace_id: "ai-marketplace",
    marketplace_name: "AI Marketplace",
    marketplace_solution_id: "sol-beta",
    description: "Installed beta skill",
    version: "1.0",
  };
  const h = loadAgentSkillsHarness({
    skills: [INSTALLED_ART, INSTALLED_BETA],
    // "aaa-tool" is a dangling agent reference (no local skill) that happens
    // to collide with a pure listing's name — the listing is NOT that skill.
    agentUsage: [
      { id: "a1", name: "Art Bot", leaves: ["algorithmic-art", "aaa-tool"] },
      { id: "a2", name: "Beta Bot", leaves: ["beta-tool"] },
      { id: "a3", name: "Beta Buddy", leaves: ["beta-tool"] },
    ],
    marketplace: {
      search: async () => ({
        success: true,
        data: {
          results: [
            {
              id: "sol-art",
              name: "algorithmic-art",
              description: "Installed art skill",
              author: "anthropic",
              has_bundle: true,
            },
            {
              id: "sol-beta",
              name: "beta-tool",
              description: "Installed beta skill",
              author: "anthropic",
              has_bundle: true,
            },
            {
              id: "sol-x",
              name: "aaa-tool",
              description: "Not installed anywhere",
              author: "someone",
              has_bundle: true,
            },
          ],
        },
      }),
    },
  });
  seedInfoTooltips(h);
  await h.window.loadSkills();
  h.window.AgentSkillsHooks.applySkillsActiveFilter("discover");
  await flushAsync();

  const html = h.getElementById("skills-list").innerHTML;
  const artCard = cardSlice(html, "ai-marketplace/algorithmic-art");
  assert.match(artCard, /badge-agents"[^>]*>1 AGENT</);
  assert.match(artCard, /data-list-title="Used by 1 agent" data-list-items="Art Bot"/);
  const pureCard = cardSlice(html, "aaa-tool");
  assert.doesNotMatch(pureCard, /badge-agents/, "pure listings never badge");
  // Usage-desc outranks the delivered relevance order among counterparts:
  // beta (2 agents) leads art (1) despite arriving second; pure last.
  const betaIdx = html.indexOf('data-skill-name="ai-marketplace/beta-tool"');
  const artIdx = html.indexOf('data-skill-name="ai-marketplace/algorithmic-art"');
  const pureIdx = html.indexOf('data-skill-name="aaa-tool"');
  assert.ok(betaIdx >= 0 && artIdx >= 0 && pureIdx >= 0);
  assert.ok(
    betaIdx < artIdx && artIdx < pureIdx,
    `discover usage ranking violated: ${[betaIdx, artIdx, pureIdx].join(",")}`,
  );
});

test("an older host exposing only triggerHtml falls back to the plain sentence trigger", async () => {
  const h = loadAgentSkillsHarness({
    skills: [USER_NOTES],
    agentUsage: [{ id: "a1", name: "Research Buddy", leaves: ["notes"] }],
  });
  h.window.InfoTooltips = {
    triggerHtml: (text) =>
      `<span class="info-tooltip-trigger" data-info-tooltip="${text}"></span>`,
  };
  await h.window.loadSkills();
  await flushAsync();

  const notesCard = cardSlice(h.getElementById("skills-list").innerHTML, "notes");
  assert.match(notesCard, /badge-agents"[^>]*>1 AGENT</);
  assert.match(notesCard, /data-info-tooltip="Used by: Research Buddy"/);
});
