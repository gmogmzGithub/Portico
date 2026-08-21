// Behavioral tests for the reviewer-workflow prompt augmentation (composer
// critic toggle): exact suffix format, empty/files-only passthrough, and
// non-string tolerance.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { build } = require("../electron-app/node_modules/esbuild");

const REPO_ROOT = path.resolve(__dirname, "..");

let tempDir;
let mod;

before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "reviewer-workflow-tests-"));
  const outFile = path.join(tempDir, "reviewerWorkflow.cjs");
  await build({
    entryPoints: [
      path.join(REPO_ROOT, "src/patches/frontend/src/lib/utils/reviewerWorkflow.ts"),
    ],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: ["node20"],
    logLevel: "silent",
    outfile: outFile,
  });
  mod = require(outFile);
});

after(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("augments the prompt with the minimal skill-trigger directive", () => {
  const result = mod.augmentPromptWithReviewerWorkflow("Write a haiku about tiling.");
  assert.equal(result, "Write a haiku about tiling.\n\nUse a basic reviewer workflow.");
});

test("workflows skill carries the full reviewer protocol the directive relies on", async () => {
  // The one-line augmentation only works because the skill (triggered by the
  // "workflow" substring) owns the protocol — assert the contract survives.
  const skill = await fs.readFile(
    path.join(REPO_ROOT, "skills/workflows/SKILL.md"),
    "utf8",
  );
  assert.match(skill, /not even for a one-shot review/);
  assert.match(skill, /`GPT-5\.6 Sol` — never `GPT-5\.6 Sol Pro`/);
  assert.match(skill, /`Claude Opus 5`/);
  assert.match(skill, /reasoning_effort: "xhigh"/);
  assert.match(skill, /complete context of what was asked in addition to the produced output/);
  assert.match(skill, /until the reviewer has APPROVED it/);
  assert.match(skill, /up to 3 review cycles/);
  assert.match(skill, /no thank-you message/);
  assert.match(skill, /Workflows are ASYNCHRONOUS\. Never wait, never poll\./);
  assert.match(skill, /Do NOT call the `wait` tool \(`skills_wait`\)/);
  assert.match(skill, /do NOT send the peer another message/);
  assert.match(skill, /Do NOT respond to the user with the deliverable prematurely/);
  assert.match(skill, /`reasoning_effort: "xhigh"` EXACTLY — never substitute `max`/);
  assert.match(skill, /subagents_get_chat_status/);
  assert.match(skill, /- "reviewer workflow"/);
});

test("empty and whitespace-only prompts pass through untouched", () => {
  assert.equal(mod.augmentPromptWithReviewerWorkflow(""), "");
  assert.equal(mod.augmentPromptWithReviewerWorkflow("   "), "   ");
});

test("non-string input degrades to an empty string", () => {
  assert.equal(mod.augmentPromptWithReviewerWorkflow(undefined), "");
  assert.equal(mod.augmentPromptWithReviewerWorkflow(null), "");
  assert.equal(mod.augmentPromptWithReviewerWorkflow(42), "");
});

test("multiline prompts keep their own formatting", () => {
  const prompt = "line one\nline two";
  const result = mod.augmentPromptWithReviewerWorkflow(prompt);
  assert.ok(result.startsWith("line one\nline two\n\nUse a basic reviewer workflow."));
});

test("per-chat state: armed and OFF before first prompt (no remembered default)", () => {
  assert.deepEqual(
    mod.resolveReviewerWorkflowChatState({
      chatFlag: undefined,
      hasMessages: false,
    }),
    { enabled: false, locked: false },
  );
});

test("per-chat state: persisted flag wins and messages lock the toggle", () => {
  assert.deepEqual(
    mod.resolveReviewerWorkflowChatState({
      chatFlag: true,
      hasMessages: true,
    }),
    { enabled: true, locked: true },
  );
  assert.deepEqual(
    mod.resolveReviewerWorkflowChatState({
      chatFlag: false,
      hasMessages: true,
    }),
    { enabled: false, locked: true },
  );
});

test("per-chat state: pre-feature chats read as locked-off", () => {
  assert.deepEqual(
    mod.resolveReviewerWorkflowChatState({
      chatFlag: undefined,
      hasMessages: true,
    }),
    { enabled: false, locked: true },
  );
});

test("CTA impressions read is graceful in every failure mode", async () => {
  assert.equal(await mod.readReviewerCtaImpressions(null), 0);
  assert.equal(await mod.readReviewerCtaImpressions({}), 0);
  assert.equal(
    await mod.readReviewerCtaImpressions({
      getUiCalloutState: async () => ({ success: false, error: "nope" }),
    }),
    0,
  );
  assert.equal(
    await mod.readReviewerCtaImpressions({
      getUiCalloutState: async () => {
        throw new Error("ipc down");
      },
    }),
    0,
  );
  assert.equal(
    await mod.readReviewerCtaImpressions({
      getUiCalloutState: async (key) => ({
        success: true,
        data: { impressions: key === mod.REVIEWER_WORKFLOW_CTA_KEY ? 2 : 99 },
      }),
    }),
    2,
  );
});

test("CTA bump reports the new count and degrades to null without a host bridge", async () => {
  assert.equal(await mod.bumpReviewerCtaImpressions(null), null);
  assert.equal(await mod.bumpReviewerCtaImpressions({}), null);
  assert.equal(
    await mod.bumpReviewerCtaImpressions({
      incrementUiCalloutImpressions: () => Promise.reject(new Error("ipc down")),
    }),
    null,
  );
  assert.equal(
    await mod.bumpReviewerCtaImpressions({
      incrementUiCalloutImpressions: async () => ({
        success: true,
        data: { impressions: 2 },
      }),
    }),
    2,
  );
});
