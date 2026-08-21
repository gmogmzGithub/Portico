---
name: scheduled-tasks
description: Create and manage scheduled tasks that run prompts later or on recurring cron schedules. Use when the user asks to schedule work, run something every day or week, or send recurring summaries through existing skills and integrations.
license: Proprietary
compatibility: Portico
metadata:
  author: Portico Team
  version: "1.0"
  priority: high
  triggers:
    - "schedule"
    - "scheduled task"
    - "every day"
    - "every week"
    - "every month"
    - "once a week"
    - "tomorrow morning"
    - "do this every day"
    - "email me a pdf"
    - "slack me"
    - "remind me every"
required_mcp_servers:
  - "server:scheduling"
---

# Scheduled Tasks Skill

Use this skill when the user wants work to happen later or on a recurring schedule.

## Task Specification

Collect or infer the smallest complete task specification. Do not turn implementation details into questions for the user.

1. **Outcome:** what the future agent must actually do on each run.
2. **Schedule:** a one-off timestamp or recurring 5-field crontab expression.
3. **Generated name:** infer a concise 3-5 word task name from the instructions. Do not ask the user to name it.
4. **Target model or agent:** use the current model/agent unless the user names another target or the current target cannot run scheduled tasks.
5. **Integrations:** include only MCP servers needed to perform the requested action. These are pre-approved capabilities for unattended execution and require the pre-flight below.

### Skills activate at run time

- Do not ask the user to choose skills. Scheduled subagents have the core Skills server and can activate relevant skills ad hoc from the task instructions.
- Leave `skill_ids` empty by default. Use explicit `skill_ids` only when the user explicitly asks to pin a skill for every run; a saved agent's configured skills are inherited automatically.
- Skill activation does not grant new unattended integration permission. If the requested outcome requires Slack, Jira, Google Workspace, or another MCP server, include that server in `tool_server_ids` and complete the integration pre-flight.

## Clarifying Questions

- Ask only when a missing choice would materially change the outcome, recipient, side effect, or schedule. Prefer safe defaults for model, local timezone, formatting, and wording.
- If the user gives a natural-language schedule like "every weekday morning" or "once a week on Monday", convert it into a concrete schedule. Confirm the user-facing day and time when ambiguous; do not make the user review cron syntax.
- If the user says "email me a pdf", "slack me weekly", or similar delivery instructions, treat that as part of the prompt plus any required skills or integrations rather than inventing a separate transport schema.
- If a genuinely material timezone ambiguity remains, state the assumption before creating the task.

## Write an Action-Oriented Run Prompt

The stored `prompt` is a job specification for a future unattended agent. It is not the expected answer, a sample notification, or conversational text addressed to that agent.

Write the prompt in imperative form and make the actor, action, inputs, recipient, and completion condition explicit when they matter. Preserve the user's intent without inventing facts or assuming the result in advance.

Rules:

- Start with an action verb such as "Remind", "Check", "Summarize", "Create", "Send", or "Post".
- Treat "me", "my", and "I" in the user's request as referring to the task owner. Make the recipient explicit for reminders and deliveries.
- Write references to the task owner in first person: use "me", "my", and "I" rather than "the user". For example, write "Remind me to take a break", not "Remind the user to take a break".
- Do not put the schedule into the prompt unless timing changes the work itself. The scheduler already controls when the prompt runs.
- Resolve relative periods at execution time: "today", "currently", and "the last 24 hours" refer to the run time, not task-creation time.
- For external side effects, identify the destination and required content. Tell the agent not to claim success unless the integration confirms the action.
- For conditional monitoring, state both branches: what to do when the condition matches and what result to record when it does not.
- Do not pre-write or fabricate a report, reminder response, search result, or success message. Instruct the future agent to produce it from information available at run time.
- **Scheduled runs are unattended — the future agent cannot ask the task owner anything mid-run.** Resolve every material choice (recipients, channels, formats, thresholds, scope) NOW, at creation time, and encode it in the prompt. If the user's request leaves such a choice open, ask the user before creating the task; never write a prompt that depends on mid-run input. At run time the agent is instructed to block instead of ask: it finalizes the run as `needs_attention`/`failed` and leaves an explanation of what to fix as its final chat message.

## Tool Workflow

- Generate a short, plain-language `name` from the instructions, then use `scheduling_create_task` after the task specification is complete.
- Use `scheduling_list_tasks`, `scheduling_get_task`, `scheduling_update_task`, and `scheduling_delete_task` when the user wants to inspect or manage existing tasks.
- Use `scheduling_run_task_now` when the user wants to execute a saved task immediately without waiting for its schedule.
- Use `scheduling_cancel_run` when the user wants to abort a run that is currently in flight.

### Main-chat Confirmation Chip (Round 4 / Issue 3c)

`scheduling_create_task`, `scheduling_update_task`, `scheduling_delete_task`, and `scheduling_run_task_now` are classified as destructive tools. The first time you call any of them in a conversation, the per-action confirmation gate will surface a chip in the main chat asking the user to approve the task lifecycle change. This is by design:

- It pulls confirmation forward from sub-agent runtime (where the user was being re-prompted "should I send this message?" once per occurrence) to the moment the schedule is actually being committed.
- It gives the user a chance to cancel or modify the prompt / schedule / scope BEFORE the daemon takes ownership of the run.
- After approval, the same task can be re-run via `scheduling_run_task_now` without re-prompting on subsequent calls (the gate's hash binding tracks the user's per-call consent within the chat).

When the chip appears, do NOT retry the call until the user resolves it. A `CANCELLED` resolution means the user does not want the task created/changed — acknowledge in plain text and offer alternatives (different schedule, different scope, different integration). An `APPROVED` resolution means the model should re-emit the same call with byte-identical args.

## Pre-flight Checks (REQUIRED before `scheduling_create_task`)

Before calling `scheduling_create_task`, you MUST verify that every integration the task depends on is currently configured **AND authenticated**. A task whose `tool_server_ids` reference an offline OR unauthenticated integration cannot run cleanly — the daemon will abort it at execution time with `last_run_status: "missing_integration"` (install/disable failure) or `last_run_status: "auth_required"` (auth missing/expired), leaving the user with a silently broken schedule.

The required pre-flight sequence is:

1. **Enumerate available servers.** Call `mcp_assistant_list_mcp_servers` once. The response gives you `id`, `is_running`, `is_configured`, and `auth_state` for every MCP server the user has installed.
2. **Diff against the proposed `tool_server_ids`.** For each id you intend to pass to `scheduling_create_task`, confirm it appears in the response AND has `is_running: true` (or `is_configured: true` for servers the user can launch on demand) AND `auth_state` is either `authenticated` or `not_applicable`. Anything else (`not_authenticated`, `expired`) means the integration cannot run unattended.
3. **If any required id is offline OR unauthenticated:**
   - Tell the user which integration needs attention in plain language (e.g. "Your Slack MCP server is not running. Should I start it?" or "Your Slack token has expired. Please re-authenticate before scheduling this task.").
   - For install/start issues, if the user agrees, attempt activation via the appropriate `mcp_assistant_*` tool (e.g. `mcp_assistant_activate_integration` or `mcp_assistant_start_server`) and re-check.
   - **For authentication issues (Round 4 / Issue 5c)**, ALWAYS surface a clarification chip with options: "Open auth flow" (the user authenticates from the main app) or "Cancel task creation". Do NOT proceed with task creation until the user explicitly authenticates or cancels. Do NOT call `mcp_assistant_authorize_integration` directly from the main chat without first surfacing the chip — this preserves user agency, prevents surprise OAuth popups, and gives the user a chance to switch to a different integration.
   - If the user declines or activation/auth fails, **REFUSE to create the task**. State explicitly that the task would fail at run time and offer a concrete next step (install / configure / re-authenticate / pick a different integration). Do NOT call `scheduling_create_task` with an unhealthy scope just to "save the user's intent" — a half-broken task is worse than no task.
4. Only after every entry in `tool_server_ids` is BOTH healthy AND authenticated, call `scheduling_create_task`.

The same logic applies to `scheduling_update_task` when the user is widening scope (e.g. via the out-of-scope clarification chip's "widen task scope" option) — verify the new `tool_server_id` is healthy AND authenticated before adding it.

> Why this matters: scheduled runs operate without an interactive user. A missing integration or expired auth that would surface as a "click to install" / "click to authenticate" prompt during a manual chat instead becomes a recurring midnight failure with no observer. Sub-agent runs CANNOT initiate OAuth flows — the auth-required guardrail in the gate refuses any auth-initiating tool calls inside a sub-agent chat (Issue 5b). The pre-flight is the user's only safety net before the daemon takes ownership of the run.

## Run-now & Cancellation Contract

`scheduling_run_task_now` is **non-blocking**. It returns immediately (well under a second) with a handle and never embeds the assistant's response in the result:

```json
{
  "task_id": "scheduled-task-...",
  "run_id": "<uuid>",
  "chat_id": "<uuid>",
  "started_at": "2026-04-30T17:20:00Z",
  "trigger": "manual",
  "status": "running"   // or "already_running"
}
```

- Treat the returned `chat_id` as the live conversation handle. The user can open it from the "Scheduled Tasks" folder to watch it stream.
- Do NOT include `response_preview` in your reply — the body of the run isn't ready yet. If the user asks "did it finish?", call `scheduling_get_task` and inspect `current_run`, `last_run_at`, and `last_run_status`.
- The handler is idempotent: a second `scheduling_run_task_now` for the same task while a run is in flight returns the same `run_id` with `status: "already_running"`. Do not loop calling it.
- If the user wants to abort, call `scheduling_cancel_run` with the `task_id` (optionally `run_id` for safety). It returns `status: "cancelling"` and `last_run_status` becomes `cancelled` once the upstream subagent loop observes the cancel flag (typically within a few seconds).
- The scheduling daemon owns the actual completion polling. Even if the chat session is closed mid-run, the daemon drives it to terminal state and updates `last_run_*` on disk.

### Reading run state

To know whether a run finished or is still in flight:

| `current_run` | `last_run_status`     | Meaning |
|---------------|------------------------|---------|
| Set           | (any prior value)      | A run is actively being polled by the daemon. Don't start another. |
| Null          | `success` / `failed` / `cancelled` / `missed` | Terminal. The most recent run's outcome is in `last_run_*`. |

Cron tasks always advance `next_run_at` to the next future occurrence after a terminal status; `once` tasks become `enabled = false` after their single run terminates (regardless of status).

A run that terminated `needs_attention` or `failed` because it required user input leaves an explanation as the final message of its run chat: what blocked it and what to change so future runs succeed. When a user asks why a scheduled task is failing, point them at that chat (via `last_run_chat_id` / the task's run history) before re-deriving the diagnosis.

## Scheduling Rules

- Recurring schedules use standard 5-field cron format.
- One-off schedules use an RFC3339 timestamp in `schedule.run_at`.
- Include the resolved timezone in the `schedule` object for both recurring and one-off tasks. Use the current/injected user timezone by default rather than asking for it.
- Prefer precise schedules over vague wording. Resolve ambiguity before creating or updating the task.
- Standard cron ranges are supported. For example, every hour from 10:00 through 18:00 on weekdays is `0 10-18 * * MON-FRI`. Do not create separate duplicate tasks for each hour when one cron expression can express the schedule.

## Missed Occurrences Catch Up

Scheduled runs only execute while the app is running; there is no cloud-side scheduler. When the app was closed, the laptop was asleep, or an update restart landed exactly on a task's fire time, the scheduler catches up automatically once it is back:

- A cron occurrence stays runnable until its NEXT occurrence arrives. A daily 7am digest missed at 7am runs shortly after the app is back — any time that day. Do not tell the user a missed run is lost while its occurrence is still current.
- If several occurrences were missed (e.g. the laptop was closed for days), only the MOST RECENT one runs; older ones are recorded in run history with `last_run_status: "missed"` and flagged for attention. Catch-up runs never stack or pile up.
- One-off (`once`) tasks catch up only within 24 hours of their `run_at`; beyond that they are recorded as missed and disabled.
- When a user asks why a run shows `missed`, explain that the occurrence was superseded before the app came back, and that the current occurrence ran (or will run) instead. Rescheduling to a time the user's machine is reliably awake avoids the missed rows entirely.
