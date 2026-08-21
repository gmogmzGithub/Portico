// AI Marketplace publish-confirmation flow helpers - IPC/Communication layer.
// Normalizes the confirmation request the api.js routes hand to the renderer
// modal and builds the terminal results the routes translate into publish /
// deny responses. Mirrors chat-workspace-consent-flows.js.

// Modes derive from the approval registry — the maintained list of every
// approval-gated operation (see approval-flow-registry.js for the full
// mechanism inventory and enrollment steps).
const { approvalModesForKind } = require("./approval-flow-registry");

const MARKETPLACE_PUBLISH_MODES = Object.freeze(
  approvalModesForKind("marketplace_publish"),
);

// The Rust subagents proxy uses the app's standard long-flow contract
// (mirroring ask_user_question / sensitive-info): a short START call, then
// polling GET /api/ai-marketplace/publish-flow-status/:flowId until the flow
// terminates — so there is no single blocking HTTP call capping the decision
// window. The user gets the full confirm budget below to decide (the route
// still shaves it by however long the agent prefetch actually took), and the
// TOTAL budget bounds decision + publish execution so the poller always
// terminates (the Rust side waits TOTAL + a 30s grace).
const MARKETPLACE_PUBLISH_TIMEOUT_SECONDS = 300;
const MARKETPLACE_PUBLISH_MIN_TIMEOUT_SECONDS = 30;
const MARKETPLACE_PUBLISH_PREFETCH_TIMEOUT_SECONDS = 20;
// Publish-execution phase (agent publishes run in the renderer since the
// modal consolidation): once the user approves, the flow's deny timer is
// REPLACED one-shot by a publish budget that spends whatever remains of the
// total flow budget, never less than the minimum.
const MARKETPLACE_PUBLISH_TOTAL_BUDGET_SECONDS = 420;
const MARKETPLACE_PUBLISH_MIN_EXECUTE_SECONDS = 20;

const MAX_SUMMARY_LENGTH = 4000;
const MAX_LABEL_LENGTH = 200;
const MAX_PROMPT_PREVIEW_LENGTH = 400;
const MAX_ALLOWED_EMAILS = 200;

function requireTrimmedString(value, fieldName, { maxLength = 1000 } = {}) {
  if (value == null) {
    throw new Error(`${fieldName} is required`);
  }
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} is required`);
  }
  if (trimmed.length > maxLength) {
    throw new Error(`${fieldName} must be ${maxLength} characters or fewer`);
  }
  return trimmed;
}

function optionalTrimmedString(value, fieldName, { maxLength = 1000 } = {}) {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length > maxLength) {
    throw new Error(`${fieldName} must be ${maxLength} characters or fewer`);
  }
  return trimmed;
}

function normalizeAllowedEmails(value) {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("allowed_emails must be an array");
  }
  const emails = [];
  for (const raw of value.slice(0, MAX_ALLOWED_EMAILS)) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed) emails.push(trimmed);
  }
  return emails;
}

// The agent payload is display-only: everything the modal's agent card needs,
// nothing it does not (no full system prompt — only a bounded preview).
function normalizeMarketplacePublishAgent(agent, systemPrompt) {
  if (!agent || typeof agent !== "object") {
    return null;
  }
  const id = requireTrimmedString(agent.id, "agent.id", { maxLength: 200 });
  const prompt = typeof systemPrompt === "string" ? systemPrompt : "";
  return {
    id,
    name: optionalTrimmedString(agent.name, "agent.name", { maxLength: MAX_LABEL_LENGTH }) || id,
    description:
      optionalTrimmedString(agent.description, "agent.description", {
        maxLength: 2000,
      }) || "",
    base_model_id:
      optionalTrimmedString(agent.base_model_id, "agent.base_model_id", {
        maxLength: 200,
      }) || "",
    reasoning_effort:
      optionalTrimmedString(agent.reasoning_effort, "agent.reasoning_effort", {
        maxLength: 40,
      }) || null,
    created_by_email:
      optionalTrimmedString(agent.created_by_email, "agent.created_by_email", {
        maxLength: 320,
      }) || null,
    skill_ids: Array.isArray(agent.skill_ids)
      ? agent.skill_ids
          .filter((v) => typeof v === "string" && v.trim() && v.length <= 200)
          .slice(0, 100)
      : [],
    tool_server_ids: Array.isArray(agent.tool_server_ids)
      ? agent.tool_server_ids
          .filter((v) => typeof v === "string" && v.trim() && v.length <= 200)
          .slice(0, 100)
      : [],
    profile_image_url:
      optionalTrimmedString(agent.profile_image_url, "agent.profile_image_url", {
        maxLength: 2000,
      }) || null,
    system_prompt_preview: prompt.slice(0, MAX_PROMPT_PREVIEW_LENGTH),
    system_prompt_length: prompt.length,
  };
}

// The skill payload is display-only: everything the modal's skill card needs
// (the same card the control-plane Agent Skills tab renders), nothing more.
function normalizeMarketplacePublishSkill(skill) {
  if (!skill || typeof skill !== "object") {
    return null;
  }
  const name = requireTrimmedString(skill.name, "skill.name", { maxLength: 200 });
  return {
    name,
    // Display-only (the card truncates at ~120 chars) — slice rather than
    // reject so a long SKILL.md description can never derail the modal.
    description:
      typeof skill.description === "string"
        ? skill.description.trim().slice(0, 2000)
        : "",
    source:
      optionalTrimmedString(skill.source, "skill.source", { maxLength: 40 }) || "user",
    version:
      optionalTrimmedString(skill.version, "skill.version", { maxLength: 40 }) || "1.0",
    author:
      optionalTrimmedString(skill.author, "skill.author", {
        maxLength: MAX_LABEL_LENGTH,
      }) || "",
    created_by_email:
      optionalTrimmedString(skill.created_by_email, "skill.created_by_email", {
        maxLength: 320,
      }) || null,
    required_mcp_servers: Array.isArray(skill.required_mcp_servers)
      ? skill.required_mcp_servers
          .filter((v) => typeof v === "string" && v.trim() && v.length <= 200)
          .slice(0, 100)
      : [],
    // Display-only inline logo (the control-plane default). Bounded and
    // restricted to data:image payloads.
    logo:
      typeof skill.logo === "string" &&
      /^data:image\//i.test(skill.logo.trim()) &&
      skill.logo.length <= 500000
        ? skill.logo.trim()
        : null,
    published: skill.published === true,
  };
}

// Display-only chip value: which card family an approval item belongs to.
function normalizeMarketplaceSolutionTypeLabel(value) {
  const type = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!type) return null;
  if (type === "skill" || type === "skills") return "skills";
  if (type === "agent" || type === "agents" || type === "portico-agents") {
    return "agents";
  }
  return null;
}

function normalizeMarketplacePublishConfirmRequest(payload = {}) {
  const mode = requireTrimmedString(payload?.mode, "mode", { maxLength: 40 });
  if (!MARKETPLACE_PUBLISH_MODES.includes(mode)) {
    throw new Error(`mode must be one of: ${MARKETPLACE_PUBLISH_MODES.join(", ")}`);
  }
  const request = {
    mode,
    title: requireTrimmedString(payload?.title, "title", {
      maxLength: MAX_LABEL_LENGTH,
    }),
    confirmLabel: requireTrimmedString(payload?.confirmLabel, "confirmLabel", {
      maxLength: 60,
    }),
    summary:
      optionalTrimmedString(payload?.summary, "summary", {
        maxLength: MAX_SUMMARY_LENGTH,
      }) || "",
    allowedEmails: normalizeAllowedEmails(payload?.allowedEmails),
    republish: payload?.republish === true,
    // Display-only identifiers for the approval item: the target listing id
    // renders as a copyable badge, the type picks the AGENT/SKILL chip.
    solutionId:
      optionalTrimmedString(payload?.solutionId, "solutionId", {
        maxLength: 200,
      }) || null,
    solutionType: normalizeMarketplaceSolutionTypeLabel(payload?.solutionType),
    agent: null,
    skill: null,
  };
  if (mode === "publish-agent") {
    request.agent = normalizeMarketplacePublishAgent(
      payload?.agent,
      payload?.systemPrompt,
    );
    if (!request.agent) {
      throw new Error("agent is required for publish-agent confirmations");
    }
  } else if (mode === "publish-skill" || mode === "unpublish") {
    // Optional: publish-skill routes send the resolved skill so the modal can
    // show the real card; unpublish may include it when the target solution
    // resolves to a skill. The card is display-only, so a malformed payload
    // degrades to the text summary instead of derailing the whole modal to
    // the legacy native dialog.
    try {
      request.skill = normalizeMarketplacePublishSkill(payload?.skill);
    } catch {
      request.skill = null;
    }
    if (mode === "unpublish" && !request.skill) {
      // Agent-type unpublish: the route synthesizes a display-only agent
      // payload from the owned listing envelope (id = the solution id) so the
      // modal can render the real agent card. Same degrade-to-text policy.
      try {
        request.agent = normalizeMarketplacePublishAgent(payload?.agent, "");
      } catch {
        request.agent = null;
      }
    }
  }
  return request;
}

function buildMarketplacePublishApprovedResult(flowEntry) {
  return {
    success: true,
    status: "approved",
    flow_id: flowEntry?.flowId || null,
    mode: flowEntry?.mode || null,
    message: "The user approved the AI Marketplace write.",
  };
}

function buildMarketplacePublishDeniedResult(flowEntry) {
  return {
    success: false,
    status: "denied",
    flow_id: flowEntry?.flowId || null,
    mode: flowEntry?.mode || null,
    error: "User declined the AI Marketplace write",
    message: "The user declined the confirmation, so nothing was published.",
  };
}

function buildMarketplacePublishTimeoutResult(flowEntry) {
  return {
    success: false,
    status: "timeout",
    flow_id: flowEntry?.flowId || null,
    mode: flowEntry?.mode || null,
    error: "The publish confirmation timed out before the user responded",
    message:
      "The confirmation modal timed out before the user responded, so nothing was published.",
  };
}

function buildMarketplacePublishCancelledResult(flowEntry, reason) {
  const detail =
    typeof reason === "string" && reason.trim() ? ` (${reason.trim()})` : "";
  return {
    success: false,
    status: "cancelled",
    flow_id: flowEntry?.flowId || null,
    mode: flowEntry?.mode || null,
    error: `The publish confirmation was cancelled before the user responded${detail}`,
    message:
      "The confirmation was cancelled before the user responded, so nothing was published.",
  };
}

function buildMarketplacePublishErrorResult(flowEntry, error, code) {
  const message =
    typeof error === "string" && error.trim()
      ? error.trim()
      : error?.message || "AI Marketplace publish confirmation failed";
  const boundedCode =
    typeof code === "string" && code.trim() ? code.trim().slice(0, 60) : null;
  return {
    success: false,
    status: "error",
    flow_id: flowEntry?.flowId || null,
    mode: flowEntry?.mode || null,
    error: message,
    ...(boundedCode ? { code: boundedCode } : {}),
    message,
  };
}

// --- Renderer-executed publish terminals -----------------------------------
// The consolidated agent-publish modal runs the dependent-skill pre-flow and
// the agent publish in the renderer, then reports the outcome over the same
// completion channel. Everything below sanitizes that renderer-supplied
// payload main-side before it reaches the blocked route / the chat agent.

const RENDERER_RESULT_ID_MAX = 200;
const RENDERER_RESULT_ERROR_MAX = 2000;
const DEPENDENT_SKILL_SUMMARY_KEYS = Object.freeze([
  "published",
  "updated",
  "adopted",
  "referenced",
  "unchanged",
  "gitReferenced",
  "repaired",
  "visibilityUpdated",
]);
const DEPENDENT_SKILL_OUTCOMES = Object.freeze(
  // Row outcomes reuse the summary keys, plus "system" rows and the
  // visibility-only reference update's snake_case row outcome.
  new Set([...DEPENDENT_SKILL_SUMMARY_KEYS, "system", "visibility_updated"]),
);
const RENDERER_RESULT_SKILLS_MAX = 50;

function boundedString(value, maxLength) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

// Per-skill rows carry the marketplace solution ids chat models copy into
// follow-up calls (unpublish, get-solution), so they get the same whitelist
// treatment as the counters: known keys only, bounded strings, entries with
// no identity or an unrecognized outcome dropped, list capped.
function sanitizeDependentSkillRows(raw) {
  if (!Array.isArray(raw)) return [];
  const rows = [];
  for (const entry of raw) {
    if (rows.length >= RENDERER_RESULT_SKILLS_MAX) break;
    if (!entry || typeof entry !== "object") continue;
    const skillId = boundedString(entry.skill_id, RENDERER_RESULT_ID_MAX);
    const outcome = typeof entry.outcome === "string" ? entry.outcome : "";
    if (!skillId || !DEPENDENT_SKILL_OUTCOMES.has(outcome)) continue;
    const row = { skill_id: skillId, outcome };
    const displayName = boundedString(entry.display_name, RENDERER_RESULT_ID_MAX);
    if (displayName && displayName !== skillId) row.display_name = displayName;
    const solutionId = boundedString(entry.solution_id, RENDERER_RESULT_ID_MAX);
    if (solutionId) row.solution_id = solutionId;
    if (outcome === "gitReferenced") {
      const origin =
        entry.git_origin && typeof entry.git_origin === "object"
          ? entry.git_origin
          : {};
      row.git_origin = {
        marketplace_name: boundedString(origin.marketplace_name, RENDERER_RESULT_ID_MAX),
        marketplace_source: boundedString(origin.marketplace_source, RENDERER_RESULT_ID_MAX),
        skill_path: boundedString(origin.skill_path, RENDERER_RESULT_ID_MAX),
      };
    }
    rows.push(row);
  }
  return rows;
}

// Whitelist-copy of the renderer's publish result: known keys only, bounded
// strings, finite counts. Shape is a compatible superset of the legacy
// main-side buildAndPublishAgent return ({data, publishStatus}) so the chat
// agent keeps seeing the fields it always has.
function sanitizeMarketplacePublishRendererResult(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const solutionId = boundedString(source.solution_id, RENDERER_RESULT_ID_MAX);
  const status = boundedString(source.status, 60) || "active";
  const publishStatus = {
    id: solutionId || null,
    status,
    has_bundle: source.has_bundle !== false,
  };
  const dependentSkills = {};
  const rawSummary =
    source.dependent_skills && typeof source.dependent_skills === "object"
      ? source.dependent_skills
      : {};
  for (const key of DEPENDENT_SKILL_SUMMARY_KEYS) {
    const value = Number(rawSummary[key]);
    dependentSkills[key] = Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  }
  return {
    data: { ...publishStatus },
    publishStatus,
    solution_id: solutionId || null,
    action: source.action === "created" ? "created" : "updated",
    name: boundedString(source.name, RENDERER_RESULT_ID_MAX) || null,
    local_agent_id: boundedString(source.local_agent_id, RENDERER_RESULT_ID_MAX) || null,
    dependent_skills: dependentSkills,
    skills: sanitizeDependentSkillRows(source.skills),
    message: boundedString(source.message, RENDERER_RESULT_ERROR_MAX) || null,
  };
}

function buildMarketplacePublishPublishedResult(flowEntry, payload) {
  const result = sanitizeMarketplacePublishRendererResult(payload?.result);
  return {
    success: true,
    status: "published",
    flow_id: flowEntry?.flowId || null,
    mode: flowEntry?.mode || null,
    result,
    message:
      result.message ||
      "The user approved the publish and it completed inside the app.",
  };
}

function buildMarketplacePublishFailedResult(flowEntry, payload) {
  const error =
    boundedString(payload?.error, RENDERER_RESULT_ERROR_MAX) ||
    "The publish failed inside the app.";
  const code = boundedString(payload?.code, 60);
  return {
    success: false,
    status: "publish_failed",
    flow_id: flowEntry?.flowId || null,
    mode: flowEntry?.mode || null,
    error,
    ...(code ? { code } : {}),
    message:
      "The user approved the publish but it failed inside the app; they can retry it from the Agents tab.",
  };
}

// Maps a terminal flow result to the decision object the blocked api.js route
// consumes. Lives here so api.js (terminate/timeout paths) and ipc.js
// (renderer completions) resolve waiters identically.
function marketplacePublishDecisionFromResult(result) {
  const status = typeof result?.status === "string" ? result.status : "";
  if (status === "approved") return { kind: "approved" };
  if (status === "published") {
    return { kind: "published", result: result?.result || null };
  }
  if (status === "publish_failed") {
    return {
      kind: "publish_failed",
      error: result?.error || "",
      code: result?.code || null,
    };
  }
  if (status === "publish_timeout") {
    return { kind: "unknown_outcome", result: result || null };
  }
  if (status === "error") {
    return { kind: "error", error: result?.error || "", code: result?.code || null };
  }
  // Timeout and cancellation are NOT user denials: the user never decided.
  // Distinct kinds let the routes emit retryable envelopes instead of the
  // misleading "was not confirmed by the user".
  if (status === "timeout") return { kind: "timeout" };
  if (status === "cancelled") return { kind: "cancelled" };
  return { kind: "denied" };
}

function buildMarketplacePublishUnknownOutcomeResult(flowEntry) {
  return {
    success: false,
    status: "publish_timeout",
    flow_id: flowEntry?.flowId || null,
    mode: flowEntry?.mode || null,
    code: "publish_outcome_unknown",
    error:
      "The publish was approved and is still running in the app; its outcome was not known before this tool call's deadline. Check the Agents tab or call subagents_list_published to confirm.",
    message:
      "The publish was approved and is still running in the app; check the Agents tab for the final outcome.",
  };
}

// Renderer-facing outcome push for a settled publish/unpublish flow: the
// batch modal keeps approved main-side items busy ("Removing…") until this
// arrives, then ticks ✓/✕. Built from the same envelope the route stashes for
// the polling MCP proxy; bounded like every renderer-bound payload.
const OUTCOME_BROADCAST_MESSAGE_MAX = 500;
function buildMarketplacePublishOutcomeBroadcast(flowId, envelope) {
  const id = typeof flowId === "string" ? flowId.trim() : "";
  if (!id) return null;
  const ok = envelope?.success === true;
  const message = boundedString(
    ok
      ? envelope?.data?.message || ""
      : envelope?.error || envelope?.data?.message || "",
    OUTCOME_BROADCAST_MESSAGE_MAX,
  );
  const code = boundedString(ok ? "" : envelope?.code || "", 120);
  return {
    flow_id: id,
    ok,
    ...(message ? { message } : {}),
    ...(code ? { code } : {}),
  };
}

module.exports = {
  MARKETPLACE_PUBLISH_MODES,
  MARKETPLACE_PUBLISH_TIMEOUT_SECONDS,
  MARKETPLACE_PUBLISH_MIN_TIMEOUT_SECONDS,
  MARKETPLACE_PUBLISH_PREFETCH_TIMEOUT_SECONDS,
  MARKETPLACE_PUBLISH_TOTAL_BUDGET_SECONDS,
  MARKETPLACE_PUBLISH_MIN_EXECUTE_SECONDS,
  marketplacePublishDecisionFromResult,
  normalizeMarketplacePublishConfirmRequest,
  normalizeMarketplacePublishSkill,
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
};
