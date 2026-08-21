const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MARKETPLACE_PUBLISH_MODES,
  MARKETPLACE_PUBLISH_TIMEOUT_SECONDS,
  MARKETPLACE_PUBLISH_MIN_TIMEOUT_SECONDS,
  MARKETPLACE_PUBLISH_PREFETCH_TIMEOUT_SECONDS,
  MARKETPLACE_PUBLISH_TOTAL_BUDGET_SECONDS,
  MARKETPLACE_PUBLISH_MIN_EXECUTE_SECONDS,
  marketplacePublishDecisionFromResult,
  normalizeMarketplacePublishConfirmRequest,
  sanitizeMarketplacePublishRendererResult,
  buildMarketplacePublishApprovedResult,
  buildMarketplacePublishCancelledResult,
  buildMarketplacePublishDeniedResult,
  buildMarketplacePublishErrorResult,
  buildMarketplacePublishFailedResult,
  buildMarketplacePublishPublishedResult,
  buildMarketplacePublishTimeoutResult,
  buildMarketplacePublishUnknownOutcomeResult,
  buildMarketplacePublishOutcomeBroadcast,
} = require("./marketplace-publish-confirm-flows");

const FLOW_ENTRY = { flowId: "marketplace-publish-1", mode: "publish-agent" };

test("publish confirm timeout budget gives the user a real decision window", () => {
  // The flow-status polling contract removed the single blocking HTTP call,
  // so the decision window is bounded only by the flow's own timers: the
  // user gets a full five minutes to read the plan and decide.
  assert.equal(MARKETPLACE_PUBLISH_TIMEOUT_SECONDS, 300);
  assert.ok(MARKETPLACE_PUBLISH_TIMEOUT_SECONDS >= 60);
  // Prefetch + decision must fit inside the total flow budget the Rust
  // poller waits out, with room left for the publish-execution phase.
  assert.ok(
    MARKETPLACE_PUBLISH_PREFETCH_TIMEOUT_SECONDS +
      MARKETPLACE_PUBLISH_TIMEOUT_SECONDS +
      MARKETPLACE_PUBLISH_MIN_EXECUTE_SECONDS <=
      MARKETPLACE_PUBLISH_TOTAL_BUDGET_SECONDS,
  );
  assert.ok(MARKETPLACE_PUBLISH_MIN_TIMEOUT_SECONDS >= 15);
});

test("publish-agent requests require the agent payload and bound the prompt preview", () => {
  const request = normalizeMarketplacePublishConfirmRequest({
    mode: "publish-agent",
    title: "  Publish agent  ",
    confirmLabel: "Publish",
    summary: "Shares name, description, prompt.",
    allowedEmails: ["a@x.com", "  ", 42, "b@x.com"],
    republish: false,
    agent: {
      id: "research-pro",
      name: "Research Pro",
      description: "A research agent",
      base_model_id: "gpt-5.6-sol",
      reasoning_effort: "medium",
      created_by_email: "me@example.invalid",
      skill_ids: ["web-search", "", 7, "x".repeat(5000)],
      tool_server_ids: ["data-platform", "y".repeat(201)],
    },
    systemPrompt: "p".repeat(1000),
  });

  assert.equal(request.mode, "publish-agent");
  assert.equal(request.title, "Publish agent");
  assert.equal(request.confirmLabel, "Publish");
  assert.deepEqual(request.allowedEmails, ["a@x.com", "b@x.com"]);
  assert.equal(request.agent.id, "research-pro");
  assert.equal(request.agent.base_model_id, "gpt-5.6-sol");
  assert.deepEqual(request.agent.skill_ids, ["web-search"]);
  assert.deepEqual(request.agent.tool_server_ids, ["data-platform"]);
  // The payload carries a bounded preview + the true length — never the full
  // prompt (the modal is display-only).
  assert.equal(request.agent.system_prompt_preview.length, 400);
  assert.equal(request.agent.system_prompt_length, 1000);

  assert.throws(
    () =>
      normalizeMarketplacePublishConfirmRequest({
        mode: "publish-agent",
        title: "Publish agent",
        confirmLabel: "Publish",
      }),
    /agent is required/,
  );
});

// Round 11: publish-skill (and skill unpublish) flows can carry a display-only
// skill payload so the modal shows the real control-plane card.
test("publish-skill requests normalize the optional skill card payload", () => {
  const request = normalizeMarketplacePublishConfirmRequest({
    mode: "publish-skill",
    title: 'Publish skill "architecture-diagrams"',
    confirmLabel: "Publish",
    summary: "Shares SKILL.md, references, scripts.",
    skill: {
      name: "architecture-diagrams",
      description: "d".repeat(5000),
      source: "user",
      version: "1.1.0",
      author: "Employer Job Search (EJS)",
      created_by_email: "me@example.invalid",
      required_mcp_servers: ["server:time", "", 7, "x".repeat(500)],
      published: true,
    },
  });
  assert.equal(request.skill.name, "architecture-diagrams");
  assert.equal(request.skill.source, "user");
  assert.equal(request.skill.version, "1.1.0");
  assert.equal(request.skill.created_by_email, "me@example.invalid");
  assert.equal(request.skill.published, true);
  assert.deepEqual(request.skill.required_mcp_servers, ["server:time"]);
  assert.equal(request.agent, null);

  // The payload is optional — text-only summaries remain valid…
  const bare = normalizeMarketplacePublishConfirmRequest({
    mode: "publish-skill",
    title: "Publish skill",
    confirmLabel: "Publish",
  });
  assert.equal(bare.skill, null);
  // …and a malformed card payload (e.g. an oversized name) degrades to the
  // text-only summary instead of failing the modal into the native dialog.
  const malformed = normalizeMarketplacePublishConfirmRequest({
    mode: "publish-skill",
    title: "x",
    confirmLabel: "x",
    skill: { name: "n".repeat(500) },
  });
  assert.equal(malformed.skill, null);
});

test("skill and unpublish requests need no agent; unknown modes are rejected", () => {
  const request = normalizeMarketplacePublishConfirmRequest({
    mode: "unpublish",
    title: 'Remove "sol-1" from the AI Marketplace',
    confirmLabel: "Unpublish",
    summary: "This unpublishes it for everyone.",
  });
  assert.equal(request.agent, null);
  assert.equal(request.republish, false);

  for (const mode of MARKETPLACE_PUBLISH_MODES) {
    assert.ok(["publish-agent", "publish-skill", "unpublish"].includes(mode));
  }
  assert.throws(
    () =>
      normalizeMarketplacePublishConfirmRequest({
        mode: "delete-everything",
        title: "x",
        confirmLabel: "x",
      }),
    /mode must be one of/,
  );
  assert.throws(
    () => normalizeMarketplacePublishConfirmRequest({ mode: "unpublish" }),
    /title is required/,
  );
});

test("approval items carry a bounded solution id/type and unpublish accepts an agent card payload", () => {
  // Agent-type unpublish: the route synthesizes a display-only agent payload
  // from the owned listing envelope so the batch modal renders the real card.
  const agentUnpublish = normalizeMarketplacePublishConfirmRequest({
    mode: "unpublish",
    title: 'Remove "dsantiago Awesome Agent" from the AI Marketplace',
    confirmLabel: "Unpublish",
    summary: "This unpublishes it for everyone.",
    solutionId: "  6bd7e9b3-9815-4c58-a67c-2360b087f6cd  ",
    solutionType: "portico-agents",
    agent: {
      id: "6bd7e9b3-9815-4c58-a67c-2360b087f6cd",
      name: "dsantiago Awesome Agent",
      base_model_id: "GPT-5.6 Sol",
      skill_ids: ["architecture-diagrams"],
      tool_server_ids: [],
    },
  });
  assert.equal(agentUnpublish.solutionId, "6bd7e9b3-9815-4c58-a67c-2360b087f6cd");
  assert.equal(agentUnpublish.solutionType, "agents");
  assert.equal(agentUnpublish.agent.name, "dsantiago Awesome Agent");
  assert.equal(agentUnpublish.agent.base_model_id, "GPT-5.6 Sol");
  assert.equal(agentUnpublish.skill, null);

  // A malformed agent payload degrades to text-only, never derails the modal.
  const degraded = normalizeMarketplacePublishConfirmRequest({
    mode: "unpublish",
    title: "x",
    confirmLabel: "x",
    agent: { name: "missing id" },
  });
  assert.equal(degraded.agent, null);

  // A skill-type unpublish keeps the skill card and never grows an agent one.
  const skillUnpublish = normalizeMarketplacePublishConfirmRequest({
    mode: "unpublish",
    title: "x",
    confirmLabel: "x",
    solutionType: "skills",
    skill: { name: "epic-voice-booster", published: true },
    agent: { id: "should-be-ignored" },
  });
  assert.equal(skillUnpublish.solutionType, "skills");
  assert.equal(skillUnpublish.skill.name, "epic-voice-booster");
  assert.equal(skillUnpublish.agent, null);

  // Bounds: oversized ids throw (whitelist rebuild), junk types normalize null.
  assert.throws(
    () =>
      normalizeMarketplacePublishConfirmRequest({
        mode: "unpublish",
        title: "x",
        confirmLabel: "x",
        solutionId: "i".repeat(300),
      }),
    /solutionId/,
  );
  const junkType = normalizeMarketplacePublishConfirmRequest({
    mode: "unpublish",
    title: "x",
    confirmLabel: "x",
    solutionType: "mystery-meat",
  });
  assert.equal(junkType.solutionType, null);
});

test("result builders carry flow id, mode, and an unambiguous status", () => {
  const approved = buildMarketplacePublishApprovedResult(FLOW_ENTRY);
  assert.equal(approved.success, true);
  assert.equal(approved.status, "approved");
  assert.equal(approved.flow_id, "marketplace-publish-1");
  assert.equal(approved.mode, "publish-agent");

  const denied = buildMarketplacePublishDeniedResult(FLOW_ENTRY);
  assert.equal(denied.success, false);
  assert.equal(denied.status, "denied");
  assert.match(denied.message, /nothing was published/);

  const timeout = buildMarketplacePublishTimeoutResult(FLOW_ENTRY);
  assert.equal(timeout.success, false);
  assert.equal(timeout.status, "timeout");
  assert.match(timeout.message, /timed out/);

  const cancelled = buildMarketplacePublishCancelledResult(FLOW_ENTRY, "no_window_available");
  assert.equal(cancelled.status, "cancelled");
  assert.match(cancelled.error, /no_window_available/);

  const error = buildMarketplacePublishErrorResult(FLOW_ENTRY, new Error("boom"));
  assert.equal(error.status, "error");
  assert.equal(error.error, "boom");

  // Optional agent-actionable code (e.g. marketplace_api_key_missing) rides
  // along, bounded.
  const coded = buildMarketplacePublishErrorResult(
    FLOW_ENTRY,
    "no key",
    "marketplace_api_key_missing",
  );
  assert.equal(coded.code, "marketplace_api_key_missing");
  assert.ok(!("code" in error), "no code key when none was supplied");
});

// Round 8: the consolidated agent-publish modal executes the publish in the
// renderer and reports the outcome; these terminals sanitize that payload
// main-side and the decision mapper resolves the blocked route.
test("published results whitelist-copy the renderer payload with bounds", () => {
  const published = buildMarketplacePublishPublishedResult(FLOW_ENTRY, {
    result: {
      solution_id: `  sol-1${"x".repeat(400)}  `,
      status: "active",
      has_bundle: true,
      action: "created",
      name: "My Agent",
      local_agent_id: "agent-1",
      dependent_skills: {
        published: 2,
        updated: "3",
        adopted: -1,
        referenced: 1.7,
        unchanged: Number.NaN,
        gitReferenced: 1,
        repaired: 0,
        rogueKey: 99,
      },
      message: "Agent published.",
      __proto__pollution: "dropped",
      extra_unknown: "dropped",
    },
  });
  assert.equal(published.success, true);
  assert.equal(published.status, "published");
  assert.equal(published.result.solution_id.length, 200, "ids are bounded");
  assert.equal(published.result.action, "created");
  assert.equal(published.result.name, "My Agent");
  assert.equal(published.result.local_agent_id, "agent-1");
  // Counts: coerced, floored, non-negative; unknown keys dropped.
  assert.deepEqual(published.result.dependent_skills, {
    published: 2,
    updated: 3,
    adopted: 0,
    referenced: 1,
    unchanged: 0,
    gitReferenced: 1,
    repaired: 0,
    visibilityUpdated: 0,
  });
  assert.ok(!("rogueKey" in published.result.dependent_skills));
  assert.ok(!("extra_unknown" in published.result));
  // Legacy compatibility: data + publishStatus mirror the ops return shape.
  assert.equal(published.result.publishStatus.status, "active");
  assert.equal(published.result.data.has_bundle, true);
  assert.equal(published.message, "Agent published.");

  // Garbage in → safe defaults out.
  const empty = sanitizeMarketplacePublishRendererResult(null);
  assert.equal(empty.solution_id, null);
  assert.equal(empty.action, "updated");
  assert.equal(empty.dependent_skills.published, 0);
  assert.deepEqual(empty.skills, []);
});

// PORTICO-347: per-skill rows ride the same whitelist so chat models can copy
// dependent-skill solution ids straight from the publish envelope (chat
// 873f39ba mistranscribed a UUID it had to re-fish from a listing dump).
test("published results bound and whitelist the per-skill rows", () => {
  const published = buildMarketplacePublishPublishedResult(FLOW_ENTRY, {
    result: {
      solution_id: "sol-1",
      dependent_skills: {},
      skills: [
        {
          skill_id: `alpha${"x".repeat(400)}`,
          outcome: "published",
          solution_id: `sol-a${"y".repeat(400)}`,
          rogue: "dropped",
          display_name: "",
        },
        // display_name only survives when distinct from skill_id.
        { skill_id: "core-skill", outcome: "system", display_name: "core-skill" },
        {
          skill_id: "git-skill",
          outcome: "gitReferenced",
          git_origin: {
            marketplace_name: "portico-skills",
            marketplace_source: "git@example.invalid:skills.git",
            skill_path: "skills/git-skill",
            rogue_inner: "dropped",
          },
        },
        { skill_id: "bad-outcome", outcome: "exploded" },
        { outcome: "published", solution_id: "sol-orphan" },
        "garbage-entry",
        {
          skill_id: "named",
          outcome: "updated",
          solution_id: "sol-n",
          display_name: "Named Skill",
        },
      ],
    },
  });
  const skills = published.result.skills;
  assert.equal(skills.length, 4, "invalid entries are dropped, not defaulted");
  assert.equal(skills[0].skill_id.length, 200, "skill ids are bounded");
  assert.equal(skills[0].solution_id.length, 200, "solution ids are bounded");
  assert.equal(skills[0].outcome, "published");
  assert.ok(!("rogue" in skills[0]), "unknown row keys are dropped");
  assert.ok(!("display_name" in skills[0]), "empty display names are dropped");
  assert.deepEqual(skills[1], { skill_id: "core-skill", outcome: "system" });
  assert.deepEqual(skills[2], {
    skill_id: "git-skill",
    outcome: "gitReferenced",
    git_origin: {
      marketplace_name: "portico-skills",
      marketplace_source: "git@example.invalid:skills.git",
      skill_path: "skills/git-skill",
    },
  });
  assert.deepEqual(skills[3], {
    skill_id: "named",
    outcome: "updated",
    display_name: "Named Skill",
    solution_id: "sol-n",
  });
  // Counters stay the exact 8-key shape beside the rows.
  assert.deepEqual(Object.keys(published.result.dependent_skills).sort(), [
    "adopted",
    "gitReferenced",
    "published",
    "referenced",
    "repaired",
    "unchanged",
    "updated",
    "visibilityUpdated",
  ]);

  const flood = sanitizeMarketplacePublishRendererResult({
    skills: Array.from({ length: 60 }, (_, i) => ({
      skill_id: `s${i}`,
      outcome: "published",
      solution_id: `sol-${i}`,
    })),
  });
  assert.equal(flood.skills.length, 50, "row count is capped");
  assert.deepEqual(
    sanitizeMarketplacePublishRendererResult({ skills: "garbage" }).skills,
    [],
  );
});

test("publish_failed and unknown-outcome terminals carry actionable copy", () => {
  const failed = buildMarketplacePublishFailedResult(FLOW_ENTRY, {
    error: `boom ${"y".repeat(3000)}`,
    code: "solution_name_conflict",
  });
  assert.equal(failed.success, false);
  assert.equal(failed.status, "publish_failed");
  assert.equal(failed.error.length, 2000, "errors are bounded");
  assert.equal(failed.code, "solution_name_conflict");
  assert.match(failed.message, /retry it from the Agents tab/);

  const bare = buildMarketplacePublishFailedResult(FLOW_ENTRY, {});
  assert.match(bare.error, /failed inside the app/);
  assert.ok(!("code" in bare));

  const unknown = buildMarketplacePublishUnknownOutcomeResult(FLOW_ENTRY);
  assert.equal(unknown.success, false);
  assert.equal(unknown.status, "publish_timeout");
  assert.equal(unknown.code, "publish_outcome_unknown");
  assert.match(unknown.error, /Agents tab/);
});

test("the decision mapper resolves every terminal to the route's contract", () => {
  assert.deepEqual(
    marketplacePublishDecisionFromResult(buildMarketplacePublishApprovedResult(FLOW_ENTRY)),
    { kind: "approved" },
  );
  assert.equal(
    marketplacePublishDecisionFromResult(buildMarketplacePublishDeniedResult(FLOW_ENTRY)).kind,
    "denied",
  );
  // Timeout and cancellation are NOT user denials — they map to their own
  // kinds so the routes can emit retryable envelopes instead of the
  // misleading "was not confirmed by the user".
  assert.equal(
    marketplacePublishDecisionFromResult(buildMarketplacePublishTimeoutResult(FLOW_ENTRY)).kind,
    "timeout",
  );
  assert.equal(
    marketplacePublishDecisionFromResult(
      buildMarketplacePublishCancelledResult(FLOW_ENTRY, "no_window_available"),
    ).kind,
    "cancelled",
  );
  const published = marketplacePublishDecisionFromResult(
    buildMarketplacePublishPublishedResult(FLOW_ENTRY, {
      result: { solution_id: "sol-9", action: "updated" },
    }),
  );
  assert.equal(published.kind, "published");
  assert.equal(published.result.solution_id, "sol-9");
  const failed = marketplacePublishDecisionFromResult(
    buildMarketplacePublishFailedResult(FLOW_ENTRY, { error: "nope", code: "c1" }),
  );
  assert.deepEqual(failed, { kind: "publish_failed", error: "nope", code: "c1" });
  const unknown = marketplacePublishDecisionFromResult(
    buildMarketplacePublishUnknownOutcomeResult(FLOW_ENTRY),
  );
  assert.equal(unknown.kind, "unknown_outcome");
  const errored = marketplacePublishDecisionFromResult(
    buildMarketplacePublishErrorResult(FLOW_ENTRY, "no key", "marketplace_api_key_missing"),
  );
  assert.deepEqual(errored, {
    kind: "error",
    error: "no key",
    code: "marketplace_api_key_missing",
  });
  assert.deepEqual(marketplacePublishDecisionFromResult(null), { kind: "denied" });
});

test("the publish budget bounds the whole flow so the polling proxy always terminates", () => {
  // The Rust poller waits TOTAL + 30s grace (core-mcp-shared
  // electron_marketplace_confirmed_write); the flow's own timers must settle
  // everything inside TOTAL.
  assert.equal(MARKETPLACE_PUBLISH_TOTAL_BUDGET_SECONDS, 420);
  assert.ok(
    MARKETPLACE_PUBLISH_TOTAL_BUDGET_SECONDS >
      MARKETPLACE_PUBLISH_TIMEOUT_SECONDS,
    "the publish phase can outlive the confirm budget",
  );
  assert.ok(MARKETPLACE_PUBLISH_MIN_EXECUTE_SECONDS >= 10);
});

test("buildMarketplacePublishOutcomeBroadcast reduces route envelopes to the push payload", () => {
  const ok = buildMarketplacePublishOutcomeBroadcast("flow-1", {
    success: true,
    data: { message: '"X" removed from the AI Marketplace.' },
  });
  assert.deepEqual(ok, {
    flow_id: "flow-1",
    ok: true,
    message: '"X" removed from the AI Marketplace.',
  });

  const failed = buildMarketplacePublishOutcomeBroadcast("flow-2", {
    success: false,
    error: "boom",
    code: "solution_not_found",
  });
  assert.deepEqual(failed, {
    flow_id: "flow-2",
    ok: false,
    message: "boom",
    code: "solution_not_found",
  });

  // No flow id → no push; empty messages/codes are omitted, long ones bounded.
  assert.equal(buildMarketplacePublishOutcomeBroadcast("", { success: true }), null);
  assert.deepEqual(buildMarketplacePublishOutcomeBroadcast("flow-3", { success: true }), {
    flow_id: "flow-3",
    ok: true,
  });
  const bounded = buildMarketplacePublishOutcomeBroadcast("flow-4", {
    success: false,
    error: "x".repeat(1000),
  });
  assert.equal(bounded.message.length, 500);
});
