// Content-free diagnostic logging for the AI-Marketplace publish/install
// pipeline. Production support needs the full decision trail (ids,
// provenance, sync status, error codes) but the log files ship in bug
// reports, so nothing content-bearing may pass: no system prompts, no skill
// contents, no descriptions, no bundle payloads, no email lists. Call sites
// pass only safe fields; safeMeta() is the belt that enforces it anyway.
//
// Dependency-free on purpose: requireable from any main-process module
// (including the link registries) without cycle risk, and console.* is
// already captured to the app log files by services/logger.js.

"use strict";

// Exact-key (case-insensitive) drop list. Exact matching matters: safe
// derived keys like `hasSystemPrompt` or `bodyCode` must survive.
const FORBIDDEN_META_KEYS = new Set(
  [
    "description",
    "system_prompt",
    "systemPrompt",
    "prompt",
    "bundle",
    "payload",
    "solutionInput",
    "content",
    "contents",
    "text",
    "body",
    "triggers",
    "allowed_emails",
    "allowedEmails",
  ].map((key) => key.toLowerCase()),
);

const MAX_STRING_LENGTH = 200;
const MAX_ARRAY_ENTRIES = 20;
const MAX_OBJECT_DEPTH = 4;
const MAX_ERROR_MESSAGE_LENGTH = 300;
const MAX_STACK_FRAMES = 5;

// Minimal secret scrub for free-text error messages (server-supplied text
// could echo submitted fields or credentials).
const MESSAGE_SCRUB_PATTERNS = [
  [/Bearer\s+[A-Za-z0-9\-_.~+/]+=*/gi, "Bearer [REDACTED]"],
  [/(api[-_]?key|token|secret|password|credential)\s*[:=]\s*\S+/gi, "$1=[REDACTED]"],
  [/eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/g, "[REDACTED_JWT]"],
];

function truncateString(value, max = MAX_STRING_LENGTH) {
  const text = String(value);
  return text.length > max ? `${text.slice(0, max)}…(+${text.length - max})` : text;
}

function scrubMessage(value) {
  let text = truncateString(value, MAX_ERROR_MESSAGE_LENGTH);
  for (const [pattern, replacement] of MESSAGE_SCRUB_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

// Belt-level sanitizer. Objects consume depth; array wrappers do not, so a
// `plans: [{skillId, action, provenance}]` shape survives the budget.
function safeMeta(meta, depth = 0) {
  if (meta === null || meta === undefined) return meta;
  const kind = typeof meta;
  if (kind === "number" || kind === "boolean") return meta;
  if (kind === "string") return truncateString(meta);
  if (kind !== "object") return String(meta);
  if (Array.isArray(meta)) {
    const capped = meta.slice(0, MAX_ARRAY_ENTRIES).map((entry) => safeMeta(entry, depth));
    if (meta.length > MAX_ARRAY_ENTRIES) {
      capped.push(`…+${meta.length - MAX_ARRAY_ENTRIES} more`);
    }
    return capped;
  }
  if (depth >= MAX_OBJECT_DEPTH) return "[max-depth]";
  const out = {};
  for (const [key, value] of Object.entries(meta)) {
    if (FORBIDDEN_META_KEYS.has(String(key).toLowerCase())) {
      if (Array.isArray(value)) out[`${key}Count`] = value.length;
      continue;
    }
    out[key] = safeMeta(value, depth + 1);
  }
  return out;
}

// Error projection for logs: message (scrubbed + capped), codes, statuses,
// the failedSkills id list from local install errors, and a short stack
// (paths/line numbers only) — never the raw HTTP body.
function safeErrorMeta(error) {
  const failedSkills = Array.isArray(error?.body?.failedSkills)
    ? error.body.failedSkills.slice(0, MAX_ARRAY_ENTRIES).map((entry) => ({
        skillId: entry?.skill_id ?? null,
        solutionId: entry?.solution_id ?? null,
      }))
    : undefined;
  const stack =
    typeof error?.stack === "string"
      ? error.stack.split("\n").slice(0, MAX_STACK_FRAMES + 1).join("\n")
      : undefined;
  const meta = {
    errorMessage: scrubMessage(error?.message ?? error ?? "unknown error"),
    errorCode: error?.code ?? null,
    errorStatus: error?.status ?? null,
    bodyCode: error?.body?.code ?? null,
  };
  if (failedSkills) meta.failedSkills = failedSkills;
  if (stack) meta.errorStack = stack;
  return meta;
}

// One diagnostic line: "[Marketplace][<flow>] <event> {json}". Failure
// events should pass level "error" so logger.js routes them to error-*.log.
function logMarketplaceDiag(flow, event, meta = {}, level = "info") {
  const sink =
    level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : console.log;
  try {
    sink(`[Marketplace][${flow}] ${event}`, JSON.stringify(safeMeta(meta)));
  } catch {
    sink(`[Marketplace][${flow}] ${event}`, "[unserializable-meta]");
  }
}

// Shape-only summary of MCP tool inputs for the generic tool-invocation log:
// keys plus per-key type/size, never values (agent create/update args carry
// system prompts and descriptions).
function summarizeToolInputs(inputs) {
  if (!inputs || typeof inputs !== "object") {
    return { keys: [], perKey: {} };
  }
  const keys = Object.keys(inputs);
  const perKey = {};
  for (const key of keys.slice(0, 40)) {
    const value = inputs[key];
    if (typeof value === "string") perKey[key] = `string(${value.length})`;
    else if (Array.isArray(value)) perKey[key] = `array(${value.length})`;
    else if (value && typeof value === "object") {
      perKey[key] = `object(${Object.keys(value).slice(0, 10).join(",")})`;
    } else perKey[key] = typeof value;
  }
  return { keys, perKey };
}

module.exports = {
  safeMeta,
  safeErrorMeta,
  logMarketplaceDiag,
  summarizeToolInputs,
};
