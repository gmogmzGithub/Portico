// Batch 4: agent-card identity chips, capability-picker badges/filters, and the
// OWUI scheduled-tasks / composer / hero changes. Behavioral where the module
// is pure; source-pin where it is DOM/Svelte/Python.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repo = (rel) => fs.readFileSync(path.join(__dirname, "..", "..", "..", rel), "utf8");
const app = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

const agentsSource = app("renderer/components/agents.js");
const modelPicker = require("../renderer/components/agent-model-picker");
const reasoningSlider = require("../renderer/components/agent-reasoning-slider");

// ---- Reusable helpers (behavioral) ------------------------------------------

test("buildModelIdentityHtml renders logo + name + tier sparkle", () => {
  const html = modelPicker.buildModelIdentityHtml(
    {
      id: "gpt-5.6-sol",
      display_name: "GPT-5.6 Sol",
      picker_provider: "openai",
      picker_tier: "premium",
    },
    { withTier: true },
  );
  assert.match(html, /agent-model-identity/);
  assert.match(html, /agent-model-logo/);
  assert.match(html, /GPT-5\.6 Sol/);
  assert.match(html, /agent-model-tier/);
  // Empty model → empty string (no crash).
  assert.equal(modelPicker.buildModelIdentityHtml(null), "");
});

test("buildReasoningBadgeHtml renders bolt + label; max/ultra get the purple variant", () => {
  const medium = reasoningSlider.buildReasoningBadgeHtml("medium");
  assert.match(medium, /agent-reasoning-badge/);
  assert.match(medium, /agent-reasoning-badge-bolt/);
  assert.match(medium, /Medium/);
  assert.doesNotMatch(medium, /data-effort-max/);
  assert.match(reasoningSlider.buildReasoningBadgeHtml("max"), /data-effort-max="true"/);
  assert.match(reasoningSlider.buildReasoningBadgeHtml("ultra"), /data-effort-max="true"/);
  // Empty effort → no chip.
  assert.equal(reasoningSlider.buildReasoningBadgeHtml(""), "");
});

// ---- Agent cards (source pins) ----------------------------------------------

test("agent cards render model chip, reasoning chip, author badge, and a Chat button", () => {
  assert.match(agentsSource, /function agentModelChipHtml\(agent, catalogs = state\.catalogs\)/);
  assert.match(agentsSource, /function agentReasoningChipHtml\(agent\)/);
  assert.match(agentsSource, /function agentAuthorBadgeHtml\(agent\)/);
  assert.match(agentsSource, /buildModelIdentityHtml\(model, \{ withTier: true \}\)/);
  assert.match(agentsSource, /buildReasoningBadgeHtml\(agent\.reasoning_effort\)/);
  assert.match(agentsSource, /\$\{agentModelChipHtml\(agent\)\}/);
  // "Chat" button with a launch icon (not the old "Use from chat" text).
  assert.match(agentsSource, /class="btn-primary agent-use-btn"[\s\S]{0,600}?Chat\s*<\/button>/);
  assert.doesNotMatch(agentsSource, /Use from chat\s*<\/button>/);
  assert.doesNotMatch(agentsSource, /<strong>Base model:<\/strong>/);
});

// ---- Capability pickers (source pins) ---------------------------------------

test("MCP option carries a source (core/user/host) derived from deploymentType", () => {
  assert.match(agentsSource, /deploymentType === "host"\) source = "host"/);
  assert.match(agentsSource, /else if \(isCore\) source = "core"/);
  assert.match(agentsSource, /else if \(userInstalled\) source = "user"/);
  assert.match(agentsSource, /source,\n\s*\};/); // included in the returned object
});

test("picker rows drop descriptions, add a source badge, and expose category filters", () => {
  assert.match(agentsSource, /function capabilitySourceBadgeHtml\(source\)/);
  assert.match(agentsSource, /const PICKER_FILTERS = \{/);
  assert.match(agentsSource, /function pickerFilterChipsHtml\(kind, activeFilter\)/);
  assert.match(agentsSource, /agent-capability-row-badge/);
  // No description element in the row template anymore.
  assert.doesNotMatch(agentsSource, /agent-capability-row-desc">\$\{escapeHtml\(opt\.description/);
  // Skills filters map to source values; MCP filters include Host.
  assert.match(agentsSource, /skills: \[[\s\S]*?key: "marketplace"/);
  assert.match(agentsSource, /tool_server_ids: \[[\s\S]*?key: "host"/);
});

// ---- OWUI scheduled tasks (source pins) -------------------------------------

test("scheduled tasks: compact integrations picker, working checkbox, agent prepopulate + reload", () => {
  const page = repo("src/patches/frontend/src/routes/(app)/scheduled-tasks/+page.svelte");
  const api = repo("src/patches/frontend/src/lib/apis/scheduledTasks.ts");
  // The compact modal exposes the shared integration picker instead of the old
  // Advanced Context pane; skills continue to activate from instructions.
  assert.doesNotMatch(page, /Advanced MCP context/);
  assert.doesNotMatch(page, />Advanced Context</);
  assert.match(page, /<McpServerPicker/);
  assert.match(page, /label="Integrations"/);
  assert.match(page, /Skills activate automatically from your instructions/);
  assert.match(page, /const name = await generateTaskName\(\);/);
  assert.match(page, /updateScheduledTask\(localStorage\.token, editingTask\.id, \{ name, \.\.\.sharedInput \}\)/);
  assert.doesNotMatch(page, /scheduled-task-state-dot/);
  // Reload-from-Agent (only when an agent is selected).
  assert.match(page, /Reload from agent/);
  assert.match(page, /const reloadFromAgent = async \(\)/);
  assert.match(page, /mergeAgentCapabilities\(/);
  // Prepopulate on agent selection.
  assert.match(page, /maybePrepopulateFromAgent\(formModelId\)/);
  assert.match(page, /getAgentCapabilities\(localStorage\.token, agentId\)/);
  // Checkbox is default-checked and remains available when editing.
  assert.match(page, /let enabled = true;/);
  assert.match(page, /<input type="checkbox" bind:checked=\{enabled\}/);
  // API client + backend endpoint.
  assert.match(api, /export const getAgentCapabilities/);
  const router = repo("src/patches/backend/open_webui/routers/scheduled_tasks.py");
  assert.match(router, /@router\.get\("\/agent-capabilities\/\{agent_id\}"\)/);
  assert.match(router, /"get_agent",/);
});

// ---- OWUI composer + hero (source pins) -------------------------------------

test("composer controls share one hover/background colour and matched chevrons", () => {
  const css = repo("src/patches/frontend/src/app.css");
  assert.match(css, /--owui-composer-control-bg-light:/);
  assert.match(css, /--owui-composer-control-bg-dark:/);
  // Model picker gains a hover; metrics pill uses the shared bg.
  assert.match(css, /\.composer-model-picker:hover[\s\S]{0,120}?--owui-composer-control-bg-light/);
  assert.match(
    css,
    /\.composer-metrics-row \.capability-pill--readonly \{[\s\S]{0,120}?--owui-composer-control-bg-light/,
  );
});

test("chat hero shows the agent identity (base-model logo + name + description) for agents", () => {
  const ph = repo("src/patches/frontend/src/lib/components/chat/Placeholder.svelte");
  assert.match(ph, /isAgentModel = Boolean\(primaryModel\?\.info\?\.base_model_id\)/);
  assert.match(ph, /agentBaseModel = isAgentModel/);
  // The base-model-else-primary hero routing moved to
  // src/patches/frontend/src/lib/utils/landingHeroModel.ts
  // (resolveLandingHeroModel), covered behaviorally in
  // tests/test_frontend_model_selection.cjs ("shared model logo helper ...").
  assert.match(ph, /portico-landing-agent-name/);
  assert.match(ph, /portico-landing-agent-desc/);
});
