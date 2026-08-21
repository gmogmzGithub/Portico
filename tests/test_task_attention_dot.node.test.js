// PORTICO PATCH (Round 4 / Issue 7b): smoke tests for the scheduled
// task "needs attention" amber dot component.
//
// The component itself is purely presentational — see
// docs/architecture/scheduled-task-runtime.md "Attention flag" for
// the data lifecycle. These tests pin the structural contract the
// host components (ChatItem.svelte, FolderItem.svelte) rely on:
//   * a stable ``data-test-id="task-attention-dot"`` selector,
//   * the dot is gated on ``needsAttention``,
//   * the tooltip / aria-label maps each known reason to a
//     user-facing string,
//   * the dot collapses (renders nothing) when needsAttention is
//     false — no empty <span> leaking through.

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const REPO_ROOT = path.resolve(__dirname, "..");
const COMPONENT_PATH = path.join(
  REPO_ROOT,
  "src",
  "patches",
  "frontend",
  "src",
  "lib",
  "components",
  "layout",
  "Sidebar",
  "TaskAttentionDot.svelte",
);

const componentSource = fs.readFileSync(COMPONENT_PATH, "utf8");

test("TaskAttentionDot exposes a stable data-test-id for automation", () => {
  assert.match(componentSource, /data-test-id="task-attention-dot"/);
});

test("TaskAttentionDot is gated on needsAttention", () => {
  // The dot must NOT render when the task is healthy. Without the
  // {#if} gate, every chat row would have an invisible amber span
  // permanently in the DOM.
  assert.match(componentSource, /\{#if needsAttention\}/);
});

test("TaskAttentionDot wires reason to a human-readable tooltip", () => {
  // Each known ``needs_attention_reason`` in the Rust model + each
  // chat-level reason emitted by the gate (Round 4 / Issue 7b
  // wiring) has a matching case here so the user gets actionable
  // copy.
  for (const reason of [
    "auth_required",
    "missing_integration",
    "run_failed",
    "missed_run",
    "out_of_scope_chip_pending",
    // Round 4 / Issue 7b — chat-level reasons surfaced by the gate
    // via /api/v1/utils/chat-attention.
    "awaiting_confirmation",
    "awaiting_clarification",
  ]) {
    assert.match(
      componentSource,
      new RegExp(`case ['"\`]${reason}['"\`]`),
      `tooltip case missing for reason=${reason}`,
    );
  }
});

test("TaskAttentionDot supports a folder-rollup count for the parent folder", () => {
  // Issue 7's parent-folder rollup: when N child tasks need
  // attention, the folder row shows ONE dot with a "${N} scheduled
  // tasks need your attention" tooltip.
  assert.match(componentSource, /count\s*:\s*number\s*\|\s*null/);
  assert.match(componentSource, /scheduled tasks need your attention/i);
});

test("TaskAttentionDot uses amber styling consistent with chip-cluster header", () => {
  // The chip-cluster wrapper (Round 4 / Issue 4) also uses amber.
  // Pin the colour so a future restyle can't accidentally diverge —
  // both the dot and the cluster header should read as the same
  // "user attention" affordance.
  assert.match(componentSource, /bg-amber-500/);
});

test("TaskAttentionDot exposes ARIA label for screen readers", () => {
  assert.match(componentSource, /aria-label=\{tooltipText\}/);
  assert.match(componentSource, /role="img"/);
});
