# G.5 — Scheduling MCP run lifecycle

Six scenarios validating the event-driven run lifecycle for the scheduling MCP server: `run_task_now` returns immediately, in-flight runs are observable, the scheduling daemon attaches to runs without polling, cancellation propagates end-to-end, a daemon restart re-attaches to runs that were in flight before the restart, and saved task content is interpreted as work for the user rather than conversation directed at the model.

These scenarios replace the previous timeout-based contract for `run_task_now`. The handler now does **not** wait for the run to complete; instead it returns a `{run_id, chat_id, status}` handle and the daemon's executor loop drives the run to terminal state. Callers poll `get_task` to see `last_run_*` once the run terminates.

- Up: [`docs/testing/plan/mcp/README.md`](README.md).
- Implementation: `src/core-mcp-rust/crates/scheduling-server/src/{executor,runtime,signals,storage,native/scheduling}.rs`.
- Skill: [`skills/scheduled-tasks/SKILL.md`](../../../../skills/scheduled-tasks/SKILL.md).

---

## Scenarios

### G-40 — `run_task_now` returns immediately with a run handle and never blocks on completion

**Coverage:** Auto — [`src/core-mcp-rust/crates/scheduling-server/src/runtime.rs::tests::claim_and_start_run_writes_current_run_when_unclaimed`](../../../../src/core-mcp-rust/crates/scheduling-server/src/runtime.rs), [`src/core-mcp-rust/crates/scheduling-server/src/storage.rs::tests::try_set_current_run_claims_when_unclaimed_and_is_idempotent_for_same_run_id`](../../../../src/core-mcp-rust/crates/scheduling-server/src/storage.rs)
**Type:** MCP
**Preconditions:** A scheduled task exists in the store; the scheduling daemon is running.

**Steps (regression-investigation only):**
1. Run `cargo test -p scheduling-server --lib runtime::tests::claim_and_start_run_writes_current_run_when_unclaimed storage::tests::try_set_current_run`.
2. Manual: with the daemon running and an Agent VM-backed task whose prompt sleeps for ~60s, invoke `scheduling_run_task_now {"task_id": "..."}` from the chat. The tool result must come back in under 5 seconds with a JSON body containing `run_id`, `chat_id`, `started_at`, `trigger: "manual"`, `status: "running"`.
3. While the run is in flight, call `scheduling_get_task` and confirm `current_run.run_id` matches the returned `run_id` and `current_run.chat_id` matches the returned `chat_id`.

**Expected:**
- Tool response time: << 5 seconds even for prompts that take minutes upstream.
- The `current_run` field is populated immediately and remains until completion.
- The previous `last_run_*` fields (from any prior run) remain unchanged until this run terminates.

**Fail indicators:**
- The MCP call hangs (>>5 seconds) or returns 502 from the gateway.
- The response payload still embeds the full `response_preview` body (regressed to the old synchronous shape).
- `current_run` is `null` in `get_task` while the run is supposedly in flight.

<!-- @portico:test-status:begin id=G-40 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### G-41 — `run_task_now` is idempotent for an already-running task

**Coverage:** Auto — [`src/core-mcp-rust/crates/scheduling-server/src/runtime.rs::tests::claim_and_start_run_returns_already_claimed_when_run_in_flight`](../../../../src/core-mcp-rust/crates/scheduling-server/src/runtime.rs), [`src/core-mcp-rust/crates/scheduling-server/src/storage.rs::tests::try_set_current_run_reports_conflict_when_a_different_run_holds_claim`](../../../../src/core-mcp-rust/crates/scheduling-server/src/storage.rs)
**Type:** MCP
**Preconditions:** A scheduled task with a long-running prompt; the daemon is running.

**Steps (regression-investigation only):**
1. Run `cargo test -p scheduling-server --lib claim_and_start_run_returns_already_claimed try_set_current_run_reports_conflict`.
2. Manual: invoke `scheduling_run_task_now` for a task whose run will take >30s. Note the returned `run_id` and `chat_id`.
3. Immediately invoke `scheduling_run_task_now` again with the same `task_id`. The response must contain the same `run_id` and `chat_id` and `status: "already_running"`.
4. Confirm via `get_task` that `current_run` was not replaced.

**Expected:**
- No second chat is created for the same in-flight task.
- The runner's `start_run` is invoked exactly once (verified by `runner.calls()` in unit tests).
- Concurrent callers all converge on the same handle.

**Fail indicators:**
- Two distinct `chat_id`s come back from the two calls.
- A second chat appears in OWUI's "Scheduled Tasks" folder.
- `current_run` is overwritten with the second call's run_id.

<!-- @portico:test-status:begin id=G-41 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### G-42 — `cancel_run` aborts an in-flight task and `last_run_status` becomes `cancelled`

**Coverage:** Auto — [`src/core-mcp-rust/crates/scheduling-server/src/executor.rs::tests::handle_signal_cancel_marks_cancellation_and_terminal_status_becomes_cancelled`](../../../../src/core-mcp-rust/crates/scheduling-server/src/executor.rs)
**Type:** MCP
**Preconditions:** Daemon running. A long-running task in flight (>=30s remaining).

**Steps (regression-investigation only):**
1. Run `cargo test -p scheduling-server --lib executor::tests::handle_signal_cancel`.
2. Manual: start a long-running task via `scheduling_run_task_now` and capture `run_id` + `chat_id`.
3. Invoke `scheduling_cancel_run {"task_id": "..."}` (or with the explicit `run_id`). The response must be `{status: "cancelling", run_id, chat_id}` and return in under 1 second.
4. Within ~30 seconds, poll `get_task` until `current_run` is null and `last_run_status` is `cancelled`.

**Expected:**
- The upstream subagent polling loop observes `subagent_cancel:<chat_id>` and exits.
- The executor's terminal-status logic sees the per-run `scheduling_run_cancelled:<run_id>` marker and records `LastRunStatus::Cancelled` (not `Failed`).
- Cron tasks: `next_run_at` IS advanced (cancellation is treated like a completed scheduled run for advancement purposes; this matches the legacy "consume_schedule" semantics for scheduled triggers, but for `Manual`-triggered cancels the next_run_at is preserved).
- A subsequent `cancel_run` for the same task with no run in flight returns `status: "no_run_in_flight"` (not an error).

**Fail indicators:**
- Cancellation never propagates and the task continues to completion.
- `last_run_status` becomes `Failed` instead of `Cancelled` (cancellation marker missed).
- Cancel attempted with a stale `run_id` silently overrides the in-flight one.

<!-- @portico:test-status:begin id=G-42 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### G-43 — Daemon restart re-attaches to runs that were in flight before the restart

**Coverage:** Auto — [`src/core-mcp-rust/crates/scheduling-server/src/executor.rs::tests::reconcile_orphans_re_attaches_an_in_flight_run_after_a_simulated_restart`](../../../../src/core-mcp-rust/crates/scheduling-server/src/executor.rs)
**Type:** MCP
**Preconditions:** Daemon running with at least one task whose run is in flight (`current_run` set on disk).

**Steps (regression-investigation only):**
1. Run `cargo test -p scheduling-server --lib executor::tests::reconcile_orphans`.
2. Manual: kick off a long-running task via `run_task_now`. Verify `current_run` is set on disk.
3. While the run is in flight, restart the scheduling-daemon process: `docker compose restart scheduling-daemon` (or kill the process and let supervisor restart it).
4. Within `SCHEDULING_DAEMON_POLL_INTERVAL_SECONDS` (default 30s) of restart, the run should still terminate normally and `current_run` should be cleared.

**Expected:**
- On startup the executor's `reconcile_orphans` finds the on-disk `current_run` and spawns an `await_completion(task, chat_id)`.
- The terminal status is `Success` (or `Failed`/`Cancelled` based on what actually happened upstream) — never left in flight.
- No duplicate chats are created; the original `chat_id` is honored.

**Fail indicators:**
- The run is "stuck" in flight indefinitely after the daemon restart (`current_run` never clears).
- A second chat is started for the same task because `claim_and_start_run` was called instead of `await_completion`.
- `last_run_status` is recorded as `Failed` with a misleading "task vanished" or "lock held" error.

<!-- @portico:test-status:begin id=G-43 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### G-44 — Run-signal queue wakes the daemon within ~1 second of `run_task_now`

**Coverage:** Auto — [`src/core-mcp-rust/crates/scheduling-server/src/signals.rs::tests::enqueue_start_signal_pushes_envelope_and_consumer_receives_it_in_lifo_order`](../../../../src/core-mcp-rust/crates/scheduling-server/src/signals.rs), [`src/core-mcp-rust/crates/scheduling-server/src/executor.rs::tests::handle_signal_start_spawns_await_only_when_run_id_matches_disk_state`](../../../../src/core-mcp-rust/crates/scheduling-server/src/executor.rs)
**Type:** MCP
**Preconditions:** Redis is reachable from both `scheduling-server` and `scheduling-daemon`. Daemon running.

**Steps (regression-investigation only):**
1. Run `cargo test -p scheduling-server --lib signals::tests::enqueue_start_signal executor::tests::handle_signal_start_spawns_await`.
2. Manual: temporarily set `SCHEDULING_DAEMON_POLL_INTERVAL_SECONDS=120` so the periodic sweep is effectively suspended.
3. Restart the daemon with the high poll interval. Confirm via logs that `next_run_signal` is the active wait.
4. Invoke `scheduling_run_task_now` for a quick task. The daemon log should show "Scheduling executor: starting run loop" startup, then within ~1s of the LPUSH, an `await` should be spawned and the run should begin.
5. Restore the default poll interval.

**Expected:**
- The BRPOP path delivers the signal end-to-end in well under the periodic poll interval.
- Stale signals (whose `run_id` no longer matches `current_run.run_id`) are dropped silently — no duplicate await.
- A daemon that misses a signal entirely (Redis dropped, BRPOP error) still discovers the run via the periodic reconciliation sweep, just delayed.

**Fail indicators:**
- The run does not start until the periodic sweep window expires (signaling regressed to polling).
- The daemon spawns multiple awaits for one run because the in-memory `active` set was bypassed.
- A `Cancel` signal whose `run_id` is stale flips a different in-flight run to cancelled.

<!-- @portico:test-status:begin id=G-44 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### G-45 — Message-like task content is executed as a user job

**Coverage:** Auto — [`src/core-mcp-rust/crates/scheduling-server/src/runtime.rs::tests::scheduled_run_system_prompt_treats_message_like_content_as_a_user_job`](../../../../src/core-mcp-rust/crates/scheduling-server/src/runtime.rs), [`tests/test_skills_scheduled_tasks_skill.py`](../../../../tests/test_skills_scheduled_tasks_skill.py)
**Type:** MCP + live UI
**Preconditions:** A model is available and the scheduling daemon is running.

**Steps:**
1. Create a task whose saved content is deliberately message-like: `Time to take a short break from work. Step away from your screen for a few minutes.`
2. Run it immediately from Scheduled Tasks and open the resulting chat.
3. Repeat with an action-oriented prompt produced through the scheduling skill: `Remind me to take a short break from work. Keep the reminder brief and direct.`
4. For broader regression coverage, exercise a current-data summary, a conditional alert with a no-match branch, and an external delivery that requires tool-confirmed success.

**Expected:**
- The reminder is addressed to the user. The assistant never says it does not need breaks or treats the copy as advice to itself.
- Relative time is evaluated from the run, not task creation.
- Conditional tasks report the no-match outcome rather than fabricating an alert.
- External actions are not reported as successful without a successful integration call.
- Each run calls `scheduling_finalize_run` exactly once with a verdict matching the actual outcome.

**Fail indicators:**
- The assistant acknowledges or praises the prompt instead of performing it.
- The assistant replies that it is an AI and does not personally need the reminder.
- The output assumes current data, a condition match, or delivery success without checking.

<!-- @portico:test-status:begin id=G-45 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-07-22
- Build: `workbench/scheduled-task-prompt-logic` (source build)
- Executor: Workbench
- Notes: Created a weekday reminder through chat without timezone or skill clarification; the model defaulted to `Europe/Kyiv`, selected no integrations, and persisted the first-person instruction `Remind me to take a short break from work.` The task list, expanded details, and edit modal all showed the expected content. Earlier live execution checks proved both this action-oriented prompt and the legacy message-like reminder address the task owner instead of the model. Automated prompt-contract tests cover relative-time evaluation, conditional no-match reporting, and tool-confirmed external success. Screenshots: `/private/tmp/scheduled-first-person-04-working.png`, `/private/tmp/scheduled-first-person-05-task-list.png`, `/private/tmp/scheduled-first-person-06-task-expanded.png`, `/private/tmp/scheduled-first-person-07-editor.png`, `/private/tmp/scheduled-first-person-11-clean.png`, `/private/tmp/scheduled-logic-09-clean-run-chat.png`, `/private/tmp/scheduled-logic-20-legacy-run-chat.png`. The temporary task was paused and deleted after verification.
<!-- @portico:test-status:end -->
