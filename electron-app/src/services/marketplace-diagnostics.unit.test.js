// Behavior tests for the content-free marketplace diagnostics belt: what the
// sanitizer drops, what survives, and that nothing content-bearing can pass
// through any of the log surfaces.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  safeMeta,
  safeErrorMeta,
  logMarketplaceDiag,
  summarizeToolInputs,
} = require("./marketplace-diagnostics");

test("safeMeta drops forbidden content keys at any depth, exact-match only", () => {
  const out = safeMeta({
    agentId: "agent-1",
    description: "SECRET DESCRIPTION",
    system_prompt: "SECRET PROMPT",
    hasSystemPrompt: true,
    nested: {
      solutionId: "sol-1",
      bundle: { payload: { name: "x" } },
      bodyCode: "not_found",
    },
    allowed_emails: ["a@example.invalid", "b@example.invalid"],
  });

  assert.equal(out.agentId, "agent-1");
  assert.ok(!("description" in out), "description dropped");
  assert.ok(!("system_prompt" in out), "system_prompt dropped");
  assert.equal(out.hasSystemPrompt, true, "derived booleans survive exact-match");
  assert.ok(!("bundle" in out.nested), "nested bundle dropped");
  assert.equal(out.nested.bodyCode, "not_found", "bodyCode survives exact-match");
  assert.ok(!("allowed_emails" in out));
  assert.equal(out.allowed_emailsCount, 2, "email lists become counts");
  assert.ok(!JSON.stringify(out).includes("SECRET"), "no content survives");
});

test("safeMeta truncates long strings and caps arrays with a marker", () => {
  const out = safeMeta({
    long: "x".repeat(500),
    ids: Array.from({ length: 30 }, (_u, i) => `id-${i}`),
  });
  assert.ok(out.long.length < 250);
  assert.match(out.long, /…\(\+300\)$/);
  assert.equal(out.ids.length, 21);
  assert.equal(out.ids[20], "…+10 more");
});

test("the plans array-of-objects shape survives the depth budget", () => {
  const out = safeMeta({
    plans: [
      { skillId: "alpha", action: "reference", provenance: "user-linked-clean", solutionId: "sol-a" },
    ],
    errors: [{ skillId: "beta", errorMessage: "boom" }],
  });
  assert.deepEqual(out.plans[0], {
    skillId: "alpha",
    action: "reference",
    provenance: "user-linked-clean",
    solutionId: "sol-a",
  });
  assert.equal(out.errors[0].errorMessage, "boom");
});

test("safeErrorMeta projects codes and ids, never the raw body", () => {
  const error = Object.assign(new Error("update rejected"), {
    code: "agent_dependency_install_failed",
    status: 422,
    body: {
      code: "validation",
      description: "FULL SECRET ECHO",
      failedSkills: [
        { skill_id: "alpha", solution_id: "sol-a", error: "boom" },
        { skill_id: "beta", solution_id: null, error: "bang" },
      ],
    },
  });

  const meta = safeErrorMeta(error);
  assert.equal(meta.errorCode, "agent_dependency_install_failed");
  assert.equal(meta.errorStatus, 422);
  assert.equal(meta.bodyCode, "validation");
  assert.deepEqual(meta.failedSkills, [
    { skillId: "alpha", solutionId: "sol-a" },
    { skillId: "beta", solutionId: null },
  ]);
  assert.ok(!("body" in meta), "raw body never emitted");
  assert.ok(!JSON.stringify(meta).includes("SECRET"));
  assert.ok(meta.errorStack.split("\n").length <= 6, "stack capped");
});

test("safeErrorMeta scrubs credential-shaped text from messages", () => {
  const meta = safeErrorMeta(
    new Error("request failed: Bearer abc.def.ghi with api_key=supersecret123"),
  );
  assert.ok(!meta.errorMessage.includes("supersecret123"));
  assert.match(meta.errorMessage, /\[REDACTED\]/);
});

test("logMarketplaceDiag routes failure events to console.error", () => {
  const captured = { log: [], error: [] };
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => captured.log.push(args.join(" "));
  console.error = (...args) => captured.error.push(args.join(" "));
  try {
    logMarketplaceDiag("install", "request", { solutionId: "sol-1" });
    logMarketplaceDiag("install", "failure", { errorCode: "boom" }, "error");
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.equal(captured.log.length, 1);
  assert.match(captured.log[0], /\[Marketplace\]\[install\] request .*sol-1/);
  assert.equal(captured.error.length, 1);
  assert.match(captured.error[0], /\[Marketplace\]\[install\] failure .*boom/);
});

test("summarizeToolInputs emits keys and shapes, never values", () => {
  const summary = summarizeToolInputs({
    agent_id: "agent-1",
    system_prompt: "TOP SECRET PROMPT CONTENT",
    description: "SECRET DESCRIPTION",
    skill_ids: ["a", "b", "c"],
    config: { nested: true, deep: { x: 1 } },
    flag: true,
  });
  const text = JSON.stringify(summary);
  assert.ok(!text.includes("SECRET"), "values never appear");
  assert.equal(summary.perKey.system_prompt, "string(25)");
  assert.equal(summary.perKey.skill_ids, "array(3)");
  assert.match(summary.perKey.config, /^object\(nested,deep\)$/);
  assert.equal(summary.perKey.flag, "boolean");
  assert.deepEqual(summary.keys.slice(0, 2), ["agent_id", "system_prompt"]);
});
