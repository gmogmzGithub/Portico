// Batch 8 (item 6): the OOTB publishing skill and the base system prompt must
// default to the native AI Marketplace (no GitLab) and only fall back to the
// git/GitLab marketplace on explicit request. These pins lock that guidance so a
// future edit can't silently revert to the GitLab-first flow.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..", "..", "..");
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

test("skill-publishing SKILL.md prefers the AI Marketplace and drops the hard GitLab requirement", () => {
  const skill = read("skills/skill-publishing/SKILL.md");
  // No hard gitlab-mcp requirement (the AI Marketplace path needs no server activation).
  assert.match(skill, /required_mcp_servers:\s*\[\]/);
  assert.doesNotMatch(skill, /required_mcp_servers:\s*\n\s*-\s*["']?server:gitlab-mcp/);
  // Leads with the AI Marketplace as the default, GitLab as an explicit fallback.
  assert.match(skill, /Default:\s*the native AI Marketplace/i);
  assert.match(skill, /Fallback:\s*GitLab-backed marketplace \(only on explicit request\)/i);
  // Documents the new native tools for both skills and agents.
  for (const tool of [
    "publish_skill",
    "install_marketplace_solution",
    "search_marketplace_solutions",
    "publish_agent",
    "install_agent",
  ]) {
    assert.match(skill, new RegExp(`\\b${tool}\\b`), `skill mentions ${tool}`);
  }
  // Explicitly tells the model not to raise GitLab by default.
  assert.match(skill, /Do \*\*not\*\* bring up GitLab.*unless/s);
});

test("base_system_prompt.md routes publishing/pulling to the AI Marketplace by default", () => {
  const prompt = read("agents/base_system_prompt.md");
  assert.match(prompt, /prefer the AI Marketplace/i);
  assert.match(prompt, /subagents_publish_agent/);
  assert.match(prompt, /skills_publish_skill/);
  assert.match(prompt, /Do \*\*not\*\* bring up GitLab.*unless the user explicitly asks/s);
});

// PORTICO-347: concurrent confirmed marketplace writes aggregate into ONE batch
// approval dialog — every guidance surface must tell models parallel calls
// are fine (chat ef7c937c fired 15 and got fake denials under the old
// single-modal race).
test("sharing guidance teaches the batch approval dialog for concurrent writes", () => {
  const aggregation = /aggregate into (a single|ONE) (in-app )?approval dialog/i;
  assert.match(read("skills/skill-publishing/SKILL.md"), aggregation);
  assert.match(read("agents/base_system_prompt.md"), aggregation);
  for (const spec of [
    "src/core-mcp-rust/crates/subagents-server/tool_spec.json",
    "src/core-mcp-rust/crates/skills-server/tool_spec.json",
  ]) {
    const tools = JSON.parse(read(spec));
    for (const name of spec.includes("subagents")
      ? ["publish_agent", "unpublish_agent"]
      : ["publish_skill", "unpublish_skill"]) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, `${spec} declares ${name}`);
      assert.match(tool.description, aggregation, `${name} teaches batch approvals`);
      assert.match(tool.description, /parallel calls are fine/);
    }
  }
  // Retryable-vs-denied semantics ride the same surfaces.
  assert.match(read("skills/skill-publishing/SKILL.md"), /approval_timed_out/);
  assert.match(read("agents/base_system_prompt.md"), /approval_timed_out/);
});

// PORTICO-347: "make this installed copy editable" must route owners to the
// in-place reclaim tools, not to copy_* (which forks a duplicate with reset
// provenance — the bug behind the zzz-dsantiago-editable duplicate).
test("sharing guidance teaches owner-reclaim before copy for installed artifacts", () => {
  const skill = read("skills/skill-publishing/SKILL.md");
  assert.match(skill, /\breclaim_skill\b/);
  assert.match(skill, /\breclaim_agent\b/);
  assert.match(skill, /Workflow D — Make an installed copy editable \(reclaim vs copy\)/);
  // Owner → in-place conversion; copy is the third-party / explicit-fork path.
  assert.match(skill, /\*\*Viewer owns the listing\*\* → convert in place/);
  assert.match(skill, /Reclaim it in place when the viewer authored\s+the listing/);

  const prompt = read("agents/base_system_prompt.md");
  assert.match(prompt, /subagents_reclaim_agent/);
  assert.match(prompt, /skills_reclaim_skill/);
  assert.match(prompt, /convert the installed copy in place/);
  assert.match(prompt, /only for third-party listings or an explicitly\s+requested fork/);
});

// PORTICO-347: publish/unpublish envelopes now carry the solution ids they
// touched (per-skill rows, dependent listings). Every guidance surface must
// point models at those ids and demand exact copies — chat 873f39ba
// mistranscribed a UUID it had to fish out of a 298 KB listing dump.
test("sharing guidance teaches envelope-carried solution ids and exact copying", () => {
  const skill = read("skills/skill-publishing/SKILL.md");
  assert.match(skill, /`skills` array names every dependent skill/);
  assert.match(skill, /copy them exactly for\s+follow-up calls/);
  assert.match(skill, /Never fabricate or retype a solution id/);
  assert.match(skill, /dependent_skill_listings/);

  const prompt = read("agents/base_system_prompt.md");
  assert.match(prompt, /Publish\/unpublish results carry the solution ids they touched/);
  assert.match(prompt, /never retype an id from memory/);

  const subagents = JSON.parse(
    read("src/core-mcp-rust/crates/subagents-server/tool_spec.json"),
  );
  const skillsSpec = JSON.parse(
    read("src/core-mcp-rust/crates/skills-server/tool_spec.json"),
  );
  const description = (tools, name) => {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `spec declares ${name}`);
    return tool.description;
  };
  assert.match(
    description(subagents, "publish_agent"),
    /skills array naming every dependent skill/,
  );
  assert.match(description(subagents, "publish_agent"), /copy those ids exactly/);
  assert.match(description(subagents, "unpublish_agent"), /dependent_skill_listings/);
  assert.match(description(skillsSpec, "publish_skill"), /flat solution_id, skill_id, and action/);
  assert.match(description(skillsSpec, "unpublish_skill"), /copy ids exactly, never retype them/);
  assert.match(description(skillsSpec, "unpublish_skill"), /skill_links_cleared/);
});

// Chat c9c0a23c: asked about "the solutions marketplace", the model fanned out
// list_marketplaces + get_marketplace_skills across ALL four git catalogs
// (~181k tokens of payload) because no surface equated "solutions marketplace"
// with the native AI Marketplace or told it git catalogs are separate. These
// pins lock the terminology, the no-fan-out rule, and the agentic
// freshness/sync recipes onto every guidance surface.
test("sharing guidance defines the solutions marketplace, forbids catalog fan-out, and teaches sync", () => {
  const prompt = read("agents/base_system_prompt.md");
  assert.match(prompt, /also called \*\*the solutions marketplace\*\*/);
  assert.match(prompt, /canonical default catalog/i);
  assert.match(prompt, /never needs syncing/i);
  assert.match(prompt, /Never fan out list\+get across every configured\s+marketplace/i);
  assert.match(prompt, /skills_check_marketplace_skill_updates/);
  assert.match(prompt, /skills_sync_marketplace/);
  assert.match(prompt, /skills_sync_all_marketplaces/);
  assert.match(prompt, /marketplace_remote_updated_at/);

  const skill = read("skills/skill-publishing/SKILL.md");
  assert.match(skill, /also called \*\*the solutions marketplace\*\*/);
  assert.match(skill, /never fan out across every configured marketplace/i);
});

// GPT models flatten every tool description to its first 240
// whitespace-normalized characters (middleware _trim_openai_tool_description),
// so the git-vs-solutions scope hint must survive inside that window — not
// trail at the end of a long paragraph.
test("git-marketplace tool descriptions lead with their scope inside the GPT 240-char window", () => {
  const gptTrim = (value) => {
    const normalized = value.split(/\s+/).join(" ").trim();
    return normalized.length <= 240
      ? normalized
      : `${normalized.slice(0, 237).trimEnd()}...`;
  };
  const skillsSpec = JSON.parse(
    read("src/core-mcp-rust/crates/skills-server/tool_spec.json"),
  );
  const description = (name) => {
    const tool = skillsSpec.find((t) => t.name === name);
    assert.ok(tool, `skills spec declares ${name}`);
    return gptTrim(tool.description);
  };
  assert.match(description("list_marketplaces"), /Git skill catalogs ONLY/);
  assert.match(description("list_marketplaces"), /NOT the native AI Marketplace/);
  assert.match(description("get_marketplace_skills"), /^Git catalogs only:/);
  assert.match(description("sync_marketplace"), /^Git catalogs only:/);
  assert.match(description("sync_all_marketplaces"), /^Git catalogs only:/);
  assert.match(description("install_marketplace_skill"), /^Git catalogs only:/);
  assert.match(
    description("search_marketplace_solutions"),
    /THE solutions marketplace/,
  );
  // Chat 96399731: the browse tool must hand GPT models the install step and
  // the native-marketplace installer must keep its git back-pointer inside
  // the same trimmed window.
  assert.match(
    description("get_marketplace_skills"),
    /install one with install_marketplace_skill/,
  );
  assert.match(
    description("install_marketplace_solution"),
    /install_marketplace_skill/,
  );
  // agent_vm bash/python are the escape hatch the incident model took — their
  // steering must fit the GPT window whole.
  const agentVmSpec = JSON.parse(
    read("src/core-mcp-rust/crates/agent-vm-server/tool_spec.json"),
  );
  for (const name of ["bash", "python"]) {
    const tool = agentVmSpec.find((t) => t.name === name);
    assert.ok(tool, `agent-vm spec declares ${name}`);
    const normalized = tool.description.split(/\s+/).join(" ").trim();
    assert.ok(
      normalized.length <= 240,
      `agent_vm ${name} description must fit the GPT window whole (${normalized.length} chars)`,
    );
    assert.match(normalized, /skills_\*\/subagents_\* tools/);
  }
  assert.match(
    agentVmSpec.find((t) => t.name === "bash").description,
    /no `atlas` CLI/,
  );
});

// Chat 96399731: asked to install a git-marketplace skill shown in a
// screenshot, the model activated a marketplace helper skill written for
// Atlas Code and ran `atlas plugin marketplace update` in an Agent VM
// (exit 127) instead of the native install chain. These pins lock the fix:
// ONE generalized "Skill Management" skill whose always-injected catalog
// description advertises the full lifecycle (that description drives
// activation choice), a native git-install workflow, and environment
// inoculation on every guidance surface.
test("skill management consolidation covers git installs and inoculates against the atlas CLI", () => {
  const skill = read("skills/skill-publishing/SKILL.md");
  assert.match(skill, /display_name: Skill Management/);
  assert.match(skill, /description: Manage skills and agents end to end/);
  assert.match(
    skill,
    /install a skill from the native AI Marketplace OR from a named git marketplace/,
  );
  assert.match(skill, /marketplace UI or a screenshot/);
  assert.match(skill, /## Environment/);
  assert.match(skill, /\*\*not Atlas Code\*\*/);
  assert.match(skill, /Agent VMs return `command not found`/);
  // The incident phrasing ("add this skill to it") and the plain install ask
  // both auto-activate now.
  assert.ok(skill.includes('- "install this skill"'), "trigger: install this skill");
  assert.ok(skill.includes('- "add this skill"'), "trigger: add this skill");
  // Workflow E: resolve the name, browse, install — ids copied, never guessed.
  assert.match(skill, /Workflow E — Install from a named git marketplace/);
  assert.match(
    skill,
    /Resolve the human name to a `marketplace_id` with `list_marketplaces`/,
  );
  assert.match(skill, /never guess ids/);
  assert.match(
    skill,
    /install_marketplace_skill\(marketplace_id, skill_id, skill_path\[, plugin_name\]\)/,
  );
  assert.match(skill, /plugin-layout catalogs fail\s+without it/);
  // Workflow F: attach merges into the agent's existing skill_ids.
  assert.match(skill, /MERGE the new skill id into the EXISTING\s+`skill_ids` list/);
  assert.match(skill, /subagents_update_agent\(agent_id, skill_ids=\[…\]\)/);
  // GitLab mechanics live in the on-demand reference; the stub stays gated.
  assert.match(skill, /references\/gitlab-marketplace-fallback\.md/);
  assert.match(skill, /`get_skill_reference`/);
  const fallback = read(
    "skills/skill-publishing/references/gitlab-marketplace-fallback.md",
  );
  assert.match(fallback, /never create a fork as the\s+contribution path/);
  assert.match(fallback, /Generated by Portico/);
  assert.match(fallback, /\.atlas-plugin\/plugin\.json/);

  const prompt = read("agents/base_system_prompt.md");
  assert.match(prompt, /This app is not Atlas Code/);
  assert.match(prompt, /skills_install_marketplace_skill/);
  assert.match(prompt, /These four servers/);
  assert.match(prompt, /shown to users as \*\*Skill Management\*\*/);
});

// Lifecycle-state flags: list tools must advertise the states the app tracks
// (unpublished local changes, update available) so agentic maintenance flows
// can exist, and delete_agent must carry the same confirm gate as
// delete_skill.
test("list tools advertise lifecycle states and delete_agent is confirm-gated", () => {
  const skillsSpec = JSON.parse(
    read("src/core-mcp-rust/crates/skills-server/tool_spec.json"),
  );
  const subagents = JSON.parse(
    read("src/core-mcp-rust/crates/subagents-server/tool_spec.json"),
  );
  const tool = (spec, name) => {
    const found = spec.find((t) => t.name === name);
    assert.ok(found, `spec declares ${name}`);
    return found;
  };
  assert.match(tool(skillsSpec, "list_skills").description, /has_unpublished_changes/);
  assert.match(tool(skillsSpec, "list_skills").description, /has_update/);
  assert.match(tool(subagents, "list_agents").description, /has_unpublished_changes/);
  assert.match(
    tool(subagents, "list_agents").description,
    /marketplace_remote_updated_at/,
  );
  const deleteAgent = tool(subagents, "delete_agent");
  assert.match(deleteAgent.description, /Requires confirm=true/);
  assert.ok(
    deleteAgent.inputSchema.properties.confirm,
    "delete_agent declares a confirm parameter",
  );
});
