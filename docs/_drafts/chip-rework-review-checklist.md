# Chip rework — round 4 follow-up smoke checklist

Saved 2026-05-05 after round-4 follow-ups landed. Use this as the
manual smoke pass before merging the round-4 branch.

The architectural narrative lives in
[`docs/architecture/chat-ui/chip-system.md`](../architecture/chat-ui/chip-system.md)
and
[`docs/architecture/mcp/scheduled-task-runtime.md`](../architecture/mcp/scheduled-task-runtime.md).
This file is purely a "stuff a human should click" checklist.

## Issue 1 — Redispatch TTL (no re-asking on transient retries)

- [ ] In a fresh chat, send a Slack message that takes the slow path
      (cache syncing). Approve the chip. The model retries the
      identical call within ~10 minutes — verify NO second chip
      appears. Audit log should show one `proposed` + one `approved`
      + one or more `redispatch_within_ttl`.
- [ ] Wait > 10 minutes (or set
      `PORTICO_TOOL_CONFIRMATION_REDISPATCH_TTL_SECONDS=5` for a fast
      test) and retry. A fresh chip MUST appear.
- [ ] Cancel a chip; on the next-turn retry the chip MUST reappear
      (cancellation does NOT seed the cache).

## Issue 2 — Per-user allowlist + Settings page

- [ ] Click "Always allow" on a Slack-message chip. Send the same
      tool call again from a fresh chat — verify NO chip appears
      and the audit log shows `dispatched_user_allowlist`.
- [ ] Open Settings → Allowlists. The new entry shows under the
      `slack` section. Toggle it OFF. Send the same call — chip
      reappears. Toggle it ON — silent dispatch resumes.
- [ ] Use the X (delete) button. The toast offers Undo for 5
      seconds. Click Undo — entry stays. Trigger another delete and
      let the timer run out — entry is gone after the timeout.
- [ ] Flip the master toggle to OFF. All silent dispatch should
      stop until the toggle goes back ON.
- [ ] Send a request from an anonymous / un-authed context (if
      reachable in your environment) — allowlist must NOT apply
      (no `user_id` to look up).

## Issue 3 — Scheduled-task scope handling

- [ ] **Alias normalization (3a)**: create a scheduled task with
      `tool_server_ids: ["slack-mcp"]`. Inside the run, a tool from
      `mcp: "slack"` must be in-scope (audit
      `dispatched_scheduled_pre_approved`).
- [ ] **Widen scope (3b)**: cause an out-of-scope tool call inside
      a scheduled-run sub-agent chat. Click "Approve + widen task
      scope". Verify the task's stored `tool_server_ids` contains
      the new id (check via `scheduling_get_task` or the
      scheduled-tasks file). The middleware actuates the widen via
      MCPO, NOT by asking the sub-agent to call
      `scheduling_update_task`.
- [ ] **Task creation confirmation (3c)**: triggering
      `scheduling_create_task` in the main chat MUST surface a
      confirmation chip first. Approve → task is created. Cancel
      → task is NOT created.

## Issue 4 — Bulk approval on chip clusters

- [ ] Trigger 5 destructive Slack-message calls in one turn. Five
      chips render flat, no bulk-action bar.
- [ ] Trigger 6+ identical-shape calls. The cluster collapses into
      a header. Click the header to expand — bulk Approve / Cancel
      buttons appear AND each chip renders below. Bulk Approve
      should resolve all pending chips in the cluster (audit shows
      one `approved` event per hash).
- [ ] Cancel All in an expanded cluster — all chips resolve to
      cancel.

## Issue 5 — Pre-flight + sub-agent OAuth guard

- [ ] **5a — pre-flight auth**: disable Slack auth (revoke token).
      Trigger a scheduled task that needs Slack. Run terminates
      with `last_run_status = AuthRequired`, `last_run_error`
      mentions Slack, no sub-agent chat is created.
- [ ] **5b — sub-agent OAuth guard**: cause a mid-run OAuth signal
      (e.g. token expires while the sub-agent is mid-loop). The
      sub-agent must NOT initiate OAuth. Audit shows
      `subagent_oauth_initiation_blocked` and the run terminates
      with `auth_required`.
- [ ] **5c — main-chat auth chip**: try to create a task that
      needs an un-authed integration. The main chat surfaces an
      auth-required clarification chip; clicking "Re-authenticate"
      runs the OAuth flow in the main app, NOT in the sub-agent.

## Issue 6 — Code-redundancy sweep

- [ ] No callsites pass `decision=` or `modify_payload=` to
      `resolve_via_chip_click` (round-4 KISS prune). `git grep
      "decision=" tests/ src/` should return zero results.
- [ ] `docs/_drafts/chip-rework-review-checklist.md` (this file)
      replaces the older draft.

## Issue 7 — Needs-attention indicator on tasks

- [ ] Cause a scheduled-run terminal failure (e.g. revoke Slack
      auth, run task). The task's `needs_attention` flag flips
      true; reason is `auth_required`. The standalone
      `TaskAttentionDot.svelte` primitive renders an amber dot
      (verify via the structural tests; the host-side wiring into
      `ChatItem.svelte` lands in a follow-up).
- [ ] Trigger a successful run on the same task (after re-auth).
      The flag clears; reason becomes `None`.

## Issue 8 — Documentation

- [ ] [`docs/architecture/chat-ui/chip-system.md`](../architecture/chat-ui/chip-system.md)
      and
      [`docs/architecture/mcp/scheduled-task-runtime.md`](../architecture/mcp/scheduled-task-runtime.md)
      both reflect the round-4 implementation (file-backed
      allowlists, no Alembic migration, `always_allow` option id,
      MCPO widen actuation, attention flag fields).

## Cross-cutting smoke tests

- [ ] `./run-tests.sh --smoke` is green.
- [ ] `cargo test -p scheduling-server --lib` is green (58+ tests).
- [ ] `node --test tests/test_tool_confirmation_chip.node.test.js
      tests/test_task_attention_dot.node.test.js
      tests/test_tool_allowlist_settings.node.test.js` is green.
- [ ] `uv run python -m pytest tests/test_tool_confirmation_gate.py
      tests/test_tool_allowlist.py
      tests/test_scheduled_run_scope.py
      tests/test_skills_scheduled_tasks_skill.py` is green.

## Known follow-ups deliberately deferred

These are tracked as "in plan, not in round 4" so reviewers don't
flag them as missing:

- Per-chat MCP precedence inside the allowlist short-circuit (gate
  currently honours an entry regardless of whether the chat has the
  matching `tool_server_id` enabled). Wiring lives in the chat
  object's `tool_servers` array — reach for it in a follow-up.
- Allowlist prefill on integration auth (Issue 2c). Requires a
  per-integration destructive-tool enumeration step that doesn't
  exist yet.
- Frontend amber-dot mount into `ChatItem.svelte` /
  `FolderItem.svelte`. The standalone primitive ships with tests;
  wiring is a small surgical patch left for a follow-up so we
  don't rebase-collide with upstream OWUI sidebar changes.
- Confirmation-chip TTL during scheduled runs (auto-abort after
  N hours of waiting). Today an unresolved chip blocks the run
  indefinitely.
- Bell-ring the user externally (Slack DM / desktop push) when a
  scheduled-run chip is waiting. Today the user only finds out by
  opening the sub-agent chat OR by noticing the amber dot in the
  sidebar.
