// OOTB-seeded (Built-in) installs on the Agent Skills surfaces (2026-08-14:
// "Using Teamworks"/"Algorithmic Art" offered an Uninstall that the service
// always refuses with ootb_skill_immutable). Seeded skills render an inert
// Built-in row/button instead across the installed-tab kebab, the Discover
// counterpart kebab, and the inline skill page; non-seeded installs keep the
// real Uninstall lifecycle.
const test = require("node:test");
const assert = require("node:assert/strict");

const { flushAsync, loadAgentSkillsHarness } = require("./agent-skills-harness");

const SEEDED_SKILL = Object.freeze({
  name: "portico-ai-marketplace/portico-global/using-teamworks",
  display_name: "Using Teamworks",
  source: "marketplace",
  skill_path:
    "skills-marketplace/portico-ai-marketplace/portico-global/using-teamworks",
  marketplace_id: "portico-ai-marketplace",
  marketplace_name: "Portico AI Marketplace",
  plugin_name: "portico-global",
  ootb_seeded: true,
  description: "Role-agnostic Teamworks skills",
  version: "1.0",
});

const NORMAL_SKILL = Object.freeze({
  name: "kwp/enterprise-search/digest",
  display_name: "Digest",
  source: "marketplace",
  skill_path: "skills-marketplace/kwp/enterprise-search/digest",
  marketplace_id: "kwp",
  marketplace_name: "Knowledge Work Plugins",
  plugin_name: "enterprise-search",
  ootb_seeded: false,
  description: "Digest skill",
  version: "1.0",
});

const SEEDED_DISCOVER_LOCAL = Object.freeze({
  name: "ai-marketplace/algorithmic-art",
  display_name: "Algorithmic Art",
  source: "marketplace",
  skill_path: "skills-marketplace/ai-marketplace/algorithmic-art",
  marketplace_id: "ai-marketplace",
  marketplace_name: "AI Marketplace",
  marketplace_solution_id: "sol-art",
  ootb_seeded: true,
  description: "Installed art skill",
  version: "1.0",
});

const NORMAL_DISCOVER_LOCAL = Object.freeze({
  name: "ai-marketplace/notes",
  display_name: "Notes",
  source: "marketplace",
  skill_path: "skills-marketplace/ai-marketplace/notes",
  marketplace_id: "ai-marketplace",
  marketplace_name: "AI Marketplace",
  marketplace_solution_id: "sol-notes",
  ootb_seeded: false,
  description: "Installed notes skill",
  version: "1.0",
});

// One card's slice of the rendered grid, so per-skill assertions cannot match
// a neighboring card's menu items.
function cardSlice(html, marker) {
  const start = html.indexOf(marker);
  assert.ok(start >= 0, `card marker ${marker} rendered`);
  const next = html.indexOf("mcp-server-card skill-card", start);
  return html.slice(start, next === -1 ? undefined : next);
}

test("installed-tab kebab: seeded installs render the inert Built-in row instead of Uninstall", async () => {
  const h = loadAgentSkillsHarness({ skills: [SEEDED_SKILL, NORMAL_SKILL] });
  await h.window.loadSkills();
  await flushAsync();

  h.window.AgentSkillsHooks.applySkillsActiveFilter("marketplace");
  await flushAsync();
  const html = h.getElementById("skills-list").innerHTML;

  const seededCard = cardSlice(
    html,
    'data-dropdown-skill-name="portico-ai-marketplace/portico-global/using-teamworks"',
  );
  assert.match(seededCard, /skill-builtin-menu-btn/);
  assert.match(seededCard, /Built-in — ships with the app/);
  assert.match(
    seededCard,
    /skill-builtin-menu-btn" aria-disabled="true"/,
    "the Built-in row is inert",
  );
  assert.doesNotMatch(seededCard, /skill-uninstall-menu-btn/);
  assert.doesNotMatch(seededCard, /skill-delete-menu-btn/);

  const normalCard = cardSlice(
    html,
    'data-dropdown-skill-name="kwp/enterprise-search/digest"',
  );
  assert.match(normalCard, /skill-uninstall-menu-btn/);
  assert.doesNotMatch(normalCard, /skill-builtin-menu-btn/);
});

test("Discover counterpart kebab: seeded locals swap Uninstall for the Built-in row", async () => {
  const h = loadAgentSkillsHarness({
    skills: [SEEDED_DISCOVER_LOCAL, NORMAL_DISCOVER_LOCAL],
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
              id: "sol-notes",
              name: "notes",
              description: "Installed notes skill",
              author: "someone",
              has_bundle: true,
            },
          ],
        },
      }),
    },
  });
  await h.window.loadSkills();
  await flushAsync();
  h.window.AgentSkillsHooks.applySkillsActiveFilter("discover");
  await flushAsync();

  const html = h.getElementById("skills-list").innerHTML;
  const seededCard = cardSlice(html, 'data-dropdown-solution-id="sol-art"');
  assert.match(seededCard, /skill-builtin-menu-btn/);
  assert.match(seededCard, /aria-disabled="true"/);
  assert.doesNotMatch(seededCard, /skill-discover-menu-uninstall-btn/);

  const normalCard = cardSlice(html, 'data-dropdown-solution-id="sol-notes"');
  assert.match(normalCard, /skill-discover-menu-uninstall-btn/);
  assert.doesNotMatch(normalCard, /skill-builtin-menu-btn/);
});

test("the inline skill page renders a disabled Built-in button instead of Uninstall for seeded installs", async () => {
  const h = loadAgentSkillsHarness({ skills: [SEEDED_SKILL, NORMAL_SKILL] });
  await h.window.loadSkills();
  await flushAsync();

  await h.window.openSkillDetailsModal(SEEDED_SKILL);
  await flushAsync();
  const host = h.getElementById("agent-skills-editor");
  assert.match(host.innerHTML, /skill-page-builtin-btn/);
  assert.match(
    host.innerHTML,
    /skill-page-builtin-btn" type="button" disabled/,
    "the Built-in button is disabled, not clickable",
  );
  assert.doesNotMatch(host.innerHTML, /skill-page-uninstall-btn/);
  assert.doesNotMatch(host.innerHTML, /skill-page-delete-btn/);

  await h.window.openSkillDetailsModal(NORMAL_SKILL);
  await flushAsync();
  assert.match(host.innerHTML, /skill-page-uninstall-btn/);
  assert.doesNotMatch(host.innerHTML, /skill-page-builtin-btn/);
});
