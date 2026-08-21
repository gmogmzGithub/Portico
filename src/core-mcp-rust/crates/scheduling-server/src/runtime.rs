use crate::model::{
    format_utc_timestamp, missed_once_expired_message, missed_superseded_message, CurrentRun,
    LastRunStatus, LastRunTrigger, ScheduleKind, ScheduledTask,
};
use crate::schedule::{
    count_occurrences_between, most_recent_run_at_or_before, next_future_run_at,
};
use crate::storage::{make_current_run, with_task_claim_lock, TaskFileStore};
use anyhow::{Context, Result};
use chrono::{DateTime, Duration, Utc};
use core_mcp_shared::{redis_delete, redis_get_string, redis_setex_string};
use serde::{Deserialize, Serialize};
use subagents_server::{
    await_subagent_completion, prepare_subagent_request, start_subagent_run, AwaitOutcome,
    RunSubagentRequest, StartedSubagentRun,
};
use tracing::error;
use uuid::Uuid;

pub const SCHEDULED_TASKS_FOLDER_NAME: &str = "Scheduled Tasks";
const MAX_SCHEDULED_TASK_FOLDER_NAME_CHARS: usize = 72;

/// Metadata key the scheduling daemon stamps onto OWUI sub-agent chats so
/// the per-action confirmation gate can recognise a scheduled-run chat.
/// Kept in sync with ``src/patches/backend/open_webui/utils/middleware.py``
/// (Phase 1 of the chip rework).
pub const CHAT_META_RUN_ORIGIN_KEY: &str = "run_origin";
pub const CHAT_META_RUN_ORIGIN_VALUE_SCHEDULED: &str = "scheduled";
pub const CHAT_META_TASK_ID_KEY: &str = "scheduled_task_id";
pub const CHAT_META_APPROVED_SCOPE_KEY: &str = "scheduled_approved_scope";
pub const SCHEDULED_FINALIZER_TOOL_NAME: &str = "scheduling_finalize_run";
pub const SCHEDULING_TOOL_SERVER_ID: &str = "server:scheduling";
const SCHEDULING_RUN_TOKEN_TTL_SECONDS: u64 = 24 * 60 * 60;
const SCHEDULING_RUN_TOKEN_KEY_PREFIX: &str = "scheduling_run_token:";
const SCHEDULING_RUN_VERDICT_TTL_SECONDS: u64 = 24 * 60 * 60;
const SCHEDULING_RUN_VERDICT_KEY_PREFIX: &str = "scheduling_run_verdict:";

fn scheduling_run_token_key(run_id: &str) -> String {
    format!("{SCHEDULING_RUN_TOKEN_KEY_PREFIX}{run_id}")
}

fn remember_run_token(run_id: &str, token: &str) -> Result<()> {
    if token.trim().is_empty() {
        return Ok(());
    }
    redis_setex_string(
        &scheduling_run_token_key(run_id),
        token,
        SCHEDULING_RUN_TOKEN_TTL_SECONDS,
    )
}

pub fn get_remembered_run_token(run_id: &str) -> Option<String> {
    redis_get_string(&scheduling_run_token_key(run_id))
        .ok()
        .flatten()
}

pub fn forget_remembered_run_token(run_id: &str) {
    let _ = redis_delete(&scheduling_run_token_key(run_id));
}

fn scheduling_run_verdict_key(run_id: &str) -> String {
    format!("{SCHEDULING_RUN_VERDICT_KEY_PREFIX}{run_id}")
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScheduledRunVerdictStatus {
    Success,
    Failed,
    NeedsAttention,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScheduledRunVerdict {
    pub task_id: String,
    pub run_id: String,
    pub chat_id: String,
    pub status: ScheduledRunVerdictStatus,
    pub summary: String,
    #[serde(default)]
    pub reason: Option<String>,
    pub finalized_at: String,
}

pub fn remember_scheduled_run_verdict(verdict: &ScheduledRunVerdict) -> Result<()> {
    redis_setex_string(
        &scheduling_run_verdict_key(&verdict.run_id),
        &serde_json::to_string(verdict).context("failed to encode scheduled run verdict")?,
        SCHEDULING_RUN_VERDICT_TTL_SECONDS,
    )
}

pub fn get_scheduled_run_verdict(run_id: &str) -> Result<Option<ScheduledRunVerdict>> {
    redis_get_string(&scheduling_run_verdict_key(run_id))?
        .map(|raw| serde_json::from_str(&raw).context("failed to decode scheduled run verdict"))
        .transpose()
}

pub fn forget_scheduled_run_verdict(run_id: &str) {
    let _ = redis_delete(&scheduling_run_verdict_key(run_id));
}

/// Build the ``chat.meta`` payload for a scheduled-run sub-agent chat.
///
/// The gate reads this metadata to decide whether a destructive tool call
/// is in scope for the originating task. A subtle but important property:
/// the metadata is only TRUSTED if the gate can verify it came from the
/// scheduling daemon (and not a model-supplied edit). Today that
/// verification is by ownership: only the daemon's OWUI service token can
/// write ``chat.meta`` on a freshly-created chat at /chats/new, and the
/// gate trusts whatever it reads back. If the trust boundary changes
/// (e.g. user-editable chat metadata is ever exposed), the gate must
/// fall back to scheduling-server-side lookup of ``current_run`` keyed
/// on chat_id.
pub fn build_scheduled_run_chat_metadata(task: &ScheduledTask) -> serde_json::Value {
    serde_json::json!({
        CHAT_META_RUN_ORIGIN_KEY: CHAT_META_RUN_ORIGIN_VALUE_SCHEDULED,
        CHAT_META_TASK_ID_KEY: task.id,
        // approved_scope is the snapshot of tool_server_ids the user
        // selected at task-creation time. Phase 1's runtime "widen
        // scope" path mutates ``ScheduledTask.tool_server_ids``
        // directly via the scheduling_update_task tool, so future
        // runs of the same task pick up the wider scope automatically.
        CHAT_META_APPROVED_SCOPE_KEY: task.tool_server_ids.clone(),
    })
}

fn scheduled_run_system_prompt(task: &ScheduledTask) -> String {
    format!(
        r#"<portico_context>
You are executing an unattended scheduled task.

Task interpretation contract:
- Treat the scheduled task content as a job specification from the task owner, not as casual conversation, a completed result, or advice addressed to you.
- Carry out the requested action now on behalf of the user. Words such as "me", "my", and "I" in the task content refer to the task owner, not to you.
- If the task content reads like a reminder or notification (for example, "Time to take a break"), deliver that reminder to the user. Never respond that you are an AI and do not personally need the reminder.
- Resolve relative time phrases such as "today", "currently", and "the last 24 hours" from this run's execution time.
- Do not invent results or claim that an external action succeeded unless the relevant tool confirms it. If the task is conditional and the condition is not met, report that outcome plainly.
- Return the useful user-facing result of the run; do not merely acknowledge, praise, or discuss the task instructions.

Unattended execution contract:
- No one is watching this run. You MUST NOT ask the user questions, request clarification, confirmation, choices, or approval, or pause waiting for user input in any form. A question asked here is never answered; it silently strands the run.
- Make reasonable decisions yourself from the task content, prior context, and available tools. Prefer a sensible documented default over asking.
- If the run genuinely cannot proceed without user input (missing information, a choice only the task owner can make, an integration that must be set up or re-authenticated), do NOT attempt the blocked action and do NOT ask a question. Instead call `{finalizer}` with `status="needs_attention"` (or `status="failed"` if the run produced no useful work), then write a final response that plainly states: (1) what blocked this run, and (2) exactly what the user should change — task settings, integration setup or authentication, or the task's prompt wording — so future runs succeed.
- That explanation IS the run's result. The task owner will read it later when they open this chat, so make it self-contained and actionable.

Completion contract:
- When you have determined the task outcome, you MUST call `{finalizer}` exactly once before writing the user-visible response.
- Do not write any user-visible text before or alongside the finalizer call. After the finalizer returns, write exactly one final response and end the run.
- Call `{finalizer}` with `status="success"` only if the scheduled task's requested work was completed.
- Call `{finalizer}` with `status="failed"` if you could not complete the requested work.
- Call `{finalizer}` with `status="needs_attention"` if the user must authenticate, configure an integration, clarify scope, or otherwise intervene.
- The finalizer call is internal bookkeeping and will not be shown to the user. Do not mention it in your visible response.
- A normal assistant response does not mark the scheduled task successful; only the finalizer verdict does.
- Use `task_id={task_id}` when calling `{finalizer}`.

Visible response contract:
- Return only the useful result requested by the task. Do not add a preamble, explanation of what you are doing, acknowledgement, completion status, or follow-up confirmation.
- Never mention that this is a scheduled task or reminder, that you are executing or delivering it, or that the task was completed.
- For a reminder, write the reminder itself once and stop. Do not add process narration or a line such as "Reminder delivered", "Done", or "Task complete".
- Exception: for a blocked or failed run, the final response is the blocked-run explanation described in the unattended execution contract — never a question, a partial answer that hides the blocker, or a bare apology.
</portico_context>
"#,
        finalizer = SCHEDULED_FINALIZER_TOOL_NAME,
        task_id = task.id,
    )
}

pub fn scheduled_task_folder_name(task: &ScheduledTask) -> String {
    let generated_name = !task.name.trim().is_empty();
    let source = if generated_name {
        &task.name
    } else {
        &task.prompt
    };
    let summary = source.split_whitespace().collect::<Vec<_>>().join(" ");
    let summary = summary.trim();
    if summary.is_empty() {
        return SCHEDULED_TASKS_FOLDER_NAME.to_string();
    }

    let task_suffix = if generated_name {
        let short_id = task
            .id
            .strip_prefix("scheduled-task-")
            .unwrap_or(&task.id)
            .chars()
            .take(8)
            .collect::<String>();
        if short_id.is_empty() {
            String::new()
        } else {
            format!(" · {short_id}")
        }
    } else {
        String::new()
    };
    let available_summary_chars =
        MAX_SCHEDULED_TASK_FOLDER_NAME_CHARS.saturating_sub(task_suffix.chars().count());
    let summary_chars = summary.chars().count();
    let truncate_at = if summary_chars > available_summary_chars {
        available_summary_chars.saturating_sub(3)
    } else {
        available_summary_chars
    };
    let mut shortened = summary.chars().take(truncate_at).collect::<String>();
    if summary_chars > available_summary_chars {
        shortened.push_str("...");
    }
    format!("{shortened}{task_suffix}")
}

/// An occurrence that fires more than this long after its scheduled
/// instant is a catch-up run: the daemon was down (or the bridge deferred
/// it) at fire time. The executor throttles catch-up launches so a
/// wake-from-sleep backlog drains gradually instead of thundering.
pub const CATCH_UP_LATENESS_THRESHOLD_MINUTES: i64 = 5;

/// One-off tasks catch up only when their `run_at` is at most this many
/// hours in the past (env-tunable). Cron tasks need no fixed window: an
/// occurrence stays runnable until the next occurrence supersedes it.
const ONCE_CATCH_UP_WINDOW_HOURS_ENV: &str = "SCHEDULING_ONCE_CATCH_UP_WINDOW_HOURS";
const DEFAULT_ONCE_CATCH_UP_WINDOW_HOURS: i64 = 24;

/// Cap on enumerating superseded occurrences for the missed-row message.
const STALE_OCCURRENCE_COUNT_CAP: usize = 1000;

pub fn once_catch_up_window_hours() -> i64 {
    std::env::var(ONCE_CATCH_UP_WINDOW_HOURS_ENV)
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_ONCE_CATCH_UP_WINDOW_HOURS)
}

fn is_catch_up(now: DateTime<Utc>, scheduled_at: DateTime<Utc>) -> bool {
    now - scheduled_at > Duration::minutes(CATCH_UP_LATENESS_THRESHOLD_MINUTES)
}

/// Cron occurrences that came due while the scheduler was down and were
/// then superseded by a newer occurrence. They are recorded as missed
/// (never executed); only `current` — the most recent occurrence — runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StaleOccurrences {
    /// The earliest superseded occurrence (the task's stored `next_run_at`).
    pub first: DateTime<Utc>,
    /// Number of superseded occurrences in `[first, current)`, capped.
    pub count: usize,
    pub count_capped: bool,
    /// The most recent occurrence at or before now — the one to arm and run.
    pub current: DateTime<Utc>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ScheduleDecision {
    Disabled,
    MissingNextRunAt,
    PendingFuture,
    /// Run `scheduled_at` now. `catch_up` marks a late fire (throttled by
    /// the executor); `stale` carries superseded occurrences to record as
    /// missed before running.
    Due {
        scheduled_at: DateTime<Utc>,
        catch_up: bool,
        stale: Option<StaleOccurrences>,
    },
    /// A one-off task whose `run_at` passed more than the catch-up window
    /// ago: record missed and disable, never execute.
    MissedOnce,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DaemonCycleReport {
    pub scanned: usize,
    pub ran: usize,
    pub missed: usize,
    pub pending: usize,
    pub disabled: usize,
    pub missing_next_run_at: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskExecutionResult {
    pub chat_id: String,
    pub response_preview: String,
    pub success: bool,
    pub error: Option<String>,
    pub finalizer_required: bool,
    pub verdict: Option<ScheduledRunVerdict>,
}

impl TaskExecutionResult {
    fn failed(message: impl Into<String>) -> Self {
        Self {
            chat_id: String::new(),
            response_preview: String::new(),
            success: false,
            error: Some(message.into()),
            finalizer_required: false,
            verdict: None,
        }
    }
}

fn finalize_execution_result(mut execution: TaskExecutionResult) -> TaskExecutionResult {
    if !execution.finalizer_required {
        return execution;
    }

    let Some(verdict) = execution.verdict.as_ref() else {
        execution.success = false;
        if execution.error.is_none() {
            execution.error = Some(format!(
                "Scheduled run did not call {SCHEDULED_FINALIZER_TOOL_NAME}; treating run as failed."
            ));
        }
        return execution;
    };

    match verdict.status {
        ScheduledRunVerdictStatus::Success => {
            if execution.success {
                execution.error = None;
            }
        }
        ScheduledRunVerdictStatus::Failed | ScheduledRunVerdictStatus::NeedsAttention => {
            execution.success = false;
            if execution.error.is_none() {
                execution.error = verdict
                    .reason
                    .clone()
                    .or_else(|| Some(verdict.summary.clone()));
            }
        }
    }

    execution
}

/// Stable handle returned by `TaskRunner::start_run` and recorded in
/// `ScheduledTask.current_run.chat_id`. The executor persists the chat id
/// so a daemon restart can re-attach via `await_completion`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StartedRunHandle {
    pub chat_id: String,
    /// OWUI token that created the chat. This is intentionally not persisted
    /// in the task file; `claim_and_start_run` stores it in Redis keyed by the
    /// generated run id so the daemon can poll the human-owned chat.
    pub token: String,
}

/// Two-phase task runner contract used by both the manual `run_task_now`
/// MCP handler and the scheduling daemon's executor.
///
/// `start_run` is fast: it kicks off upstream work and returns the handle
/// the caller should record in `current_run`. `await_completion` is slow
/// and resumable: it polls the upstream chat until it terminates and is
/// re-entrant for the same `chat_id` (used on daemon restart re-attach).
#[async_trait::async_trait]
pub trait TaskRunner: Send + Sync {
    async fn start_run(&self, task: &ScheduledTask) -> Result<StartedRunHandle>;

    async fn await_completion(
        &self,
        task: &ScheduledTask,
        chat_id: &str,
        run_token: Option<&str>,
    ) -> Result<TaskExecutionResult>;
}

/// Convenience: run a task end-to-end on the current task by chaining
/// `start_run` and `await_completion`. Used by `process_due_tasks_once`
/// (legacy daemon sweep) until the executor takes over.
pub async fn run_task_inline<R: TaskRunner + ?Sized>(
    runner: &R,
    task: &ScheduledTask,
) -> Result<TaskExecutionResult> {
    let handle = runner.start_run(task).await?;
    runner
        .await_completion(task, &handle.chat_id, Some(&handle.token))
        .await
}

/// Outcome of `claim_and_start_run`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClaimRunOutcome {
    /// A fresh run was started and `current_run` was set on disk.
    Claimed { run: CurrentRun },
    /// Another run is already in flight for this task.
    AlreadyClaimed { existing: CurrentRun },
    /// The task does not exist in the store.
    TaskNotFound,
}

/// Atomically claim a new run for `task_id`: under the per-task
/// scheduling lock, verify no `current_run` is set, call
/// `runner.start_run`, then write `current_run` with the returned chat id.
///
/// The lock is held across `start_run` so concurrent callers (manual
/// `run_task_now` and scheduled sweep) cannot both create a chat for the
/// same task. Manual triggers bypass `enabled` (mirrors legacy behavior).
pub async fn claim_and_start_run<R: TaskRunner + ?Sized>(
    store: &TaskFileStore,
    runner: &R,
    task_id: &str,
    trigger: LastRunTrigger,
    now: DateTime<Utc>,
) -> Result<ClaimRunOutcome> {
    with_task_claim_lock(task_id, || async {
        let mut task = match store.get_task(task_id) {
            Ok(task) => task,
            Err(_) => return Ok(ClaimRunOutcome::TaskNotFound),
        };
        if let Some(existing) = task.current_run.clone() {
            return Ok(ClaimRunOutcome::AlreadyClaimed { existing });
        }
        let handle = runner.start_run(&task).await?;
        let run = make_current_run(handle.chat_id, trigger, now);
        remember_run_token(&run.run_id, &handle.token)?;
        task.current_run = Some(run.clone());
        task.record_started_run(&run);
        task.set_updated_at_utc(now);
        store.save_task(&task)?;
        Ok(ClaimRunOutcome::Claimed { run })
    })
    .await
}

#[derive(Clone, Debug, Default)]
pub struct SubagentTaskRunner;

impl SubagentTaskRunner {
    fn build_request(task: &ScheduledTask) -> RunSubagentRequest {
        let mut tool_server_ids = task.tool_server_ids.clone();
        if !tool_server_ids
            .iter()
            .any(|id| id == SCHEDULING_TOOL_SERVER_ID || id == "scheduling")
        {
            tool_server_ids.push(SCHEDULING_TOOL_SERVER_ID.to_string());
        }
        RunSubagentRequest {
            model: Some(task.model_id.clone()),
            prompt: task.prompt.clone(),
            system_prompt: Some(scheduled_run_system_prompt(task)),
            image_urls: Vec::new(),
            tool_server_ids,
            skill_ids: task.skill_ids.clone(),
            include_core_tools: true,
            reasoning_effort: None,
            parent_tool_call_id: None,
            parent_chat_id: None,
            folder_name: Some(scheduled_task_folder_name(task)),
            // Stamp the chat with scheduled-run binding so the
            // per-action confirmation gate (N-012) can auto-dispatch
            // tools whose mcp is in this task's pre-approved scope.
            // Only the daemon stamps this; user-driven sub-agent
            // chats and ad-hoc subagents leave it None.
            metadata: Some(build_scheduled_run_chat_metadata(task)),
        }
    }
}

#[async_trait::async_trait]
impl TaskRunner for SubagentTaskRunner {
    async fn start_run(&self, task: &ScheduledTask) -> Result<StartedRunHandle> {
        let prepared = prepare_subagent_request(Self::build_request(task)).await?;
        let started = start_subagent_run(&prepared).await?;
        Ok(StartedRunHandle {
            chat_id: started.chat_id,
            token: started.token,
        })
    }

    async fn await_completion(
        &self,
        task: &ScheduledTask,
        chat_id: &str,
        run_token: Option<&str>,
    ) -> Result<TaskExecutionResult> {
        let prepared = prepare_subagent_request(Self::build_request(task)).await?;
        let token = run_token
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(prepared.token.as_str())
            .to_string();
        let handle = StartedSubagentRun {
            chat_id: chat_id.to_string(),
            session_id: String::new(),
            task_id: String::new(),
            model: prepared.model.clone(),
            reasoning_effort: prepared.effective_reasoning_effort.clone(),
            token,
        };
        match await_subagent_completion(handle).await? {
            AwaitOutcome::Done(result) => {
                let verdict = TaskFileStore::new()
                    .get_task(&task.id)
                    .ok()
                    .and_then(|stored| stored.current_run)
                    .filter(|run| run.chat_id == chat_id)
                    .and_then(|run| get_scheduled_run_verdict(&run.run_id).ok().flatten());
                Ok(finalize_execution_result(TaskExecutionResult {
                    chat_id: result.chat_id,
                    response_preview: result.response,
                    success: result.success,
                    error: result.error.map(|value| match value {
                        serde_json::Value::String(message) => message,
                        other => other.to_string(),
                    }),
                    finalizer_required: true,
                    verdict,
                }))
            }
            AwaitOutcome::TransientUpstreamFailure { error_message, .. } => {
                Ok(TaskExecutionResult {
                    chat_id: chat_id.to_string(),
                    response_preview: String::new(),
                    success: false,
                    error: Some(error_message),
                    finalizer_required: true,
                    verdict: None,
                })
            }
        }
    }
}

/// Decide what to do with a task at `now`.
///
/// Catch-up semantics ("current-period catch-up"): an overdue occurrence
/// stays runnable until its NEXT occurrence arrives, no matter when the
/// daemon (re)started. A daily 7am digest missed while the laptop was
/// asleep or the app was updating runs as soon as the scheduler is back —
/// any time that day. When several occurrences were missed, only the most
/// recent one runs; the older ones are reported via `stale` and recorded
/// as missed. One-off tasks catch up within a bounded window instead
/// (they have no next occurrence to supersede them).
pub fn classify_task(task: &ScheduledTask, now: DateTime<Utc>) -> Result<ScheduleDecision> {
    if !task.enabled {
        return Ok(ScheduleDecision::Disabled);
    }

    let Some(next_run_at) = task.next_run_at_utc()? else {
        return Ok(ScheduleDecision::MissingNextRunAt);
    };

    if next_run_at > now {
        return Ok(ScheduleDecision::PendingFuture);
    }

    match task.schedule.kind {
        ScheduleKind::Once => {
            if now - next_run_at > Duration::hours(once_catch_up_window_hours()) {
                return Ok(ScheduleDecision::MissedOnce);
            }
            Ok(ScheduleDecision::Due {
                scheduled_at: next_run_at,
                catch_up: is_catch_up(now, next_run_at),
                stale: None,
            })
        }
        ScheduleKind::Cron => {
            let current = most_recent_run_at_or_before(&task.schedule, now)?
                .filter(|current| *current >= next_run_at)
                .unwrap_or(next_run_at);
            let stale = if current > next_run_at {
                let (count, count_capped) = count_occurrences_between(
                    &task.schedule,
                    next_run_at,
                    current,
                    STALE_OCCURRENCE_COUNT_CAP,
                )?;
                (count > 0).then_some(StaleOccurrences {
                    first: next_run_at,
                    count,
                    count_capped,
                    current,
                })
            } else {
                None
            };
            Ok(ScheduleDecision::Due {
                scheduled_at: current,
                catch_up: is_catch_up(now, current),
                stale,
            })
        }
    }
}

/// Record superseded occurrences as one missed row and re-arm
/// `next_run_at` at the current (most recent) occurrence so the task
/// converges even if the catch-up run itself is deferred. Mutates the
/// task in place; the caller persists it.
pub fn record_stale_missed_and_rearm(
    task: &mut ScheduledTask,
    stale: &StaleOccurrences,
    now: DateTime<Utc>,
) {
    task.set_last_run_at_utc(Some(stale.first));
    task.last_run_status = Some(LastRunStatus::Missed);
    task.last_run_chat_id = None;
    task.last_run_response_preview = None;
    task.last_run_trigger = Some(LastRunTrigger::Scheduled);
    task.last_run_error = Some(missed_superseded_message(
        stale.first,
        stale.count,
        stale.count_capped,
        &task.schedule.timezone,
    ));
    task.needs_attention = true;
    task.needs_attention_reason = Some("missed_run".to_string());
    if task.needs_attention_since.is_none() {
        task.needs_attention_since = Some(format_utc_timestamp(now));
    }
    task.record_terminal_run(
        Uuid::new_v4().to_string(),
        Some(format_utc_timestamp(stale.first)),
        now,
        LastRunTrigger::Scheduled,
        LastRunStatus::Missed,
        None,
        task.last_run_error.clone(),
        None,
        Some("missed_run".to_string()),
    );
    task.set_next_run_at_utc(Some(stale.current));
    task.set_updated_at_utc(now);
}

/// Terminal bookkeeping for a one-off task that expired unrun: record a
/// missed row with attention and disable the task. Mutates in place; the
/// caller persists it.
pub fn mark_once_task_missed(task: &mut ScheduledTask, now: DateTime<Utc>) -> Result<()> {
    let missed_at = task
        .next_run_at_utc()?
        .ok_or_else(|| anyhow::anyhow!("Missing next_run_at for missed task {}", task.id))?;

    task.set_last_run_at_utc(Some(missed_at));
    task.last_run_status = Some(LastRunStatus::Missed);
    task.last_run_chat_id = None;
    task.last_run_response_preview = None;
    task.last_run_trigger = Some(LastRunTrigger::Scheduled);
    task.last_run_error = Some(missed_once_expired_message(
        missed_at,
        once_catch_up_window_hours(),
        &task.schedule.timezone,
    ));
    task.needs_attention = true;
    task.needs_attention_reason = Some("missed_run".to_string());
    if task.needs_attention_since.is_none() {
        task.needs_attention_since = Some(format_utc_timestamp(now));
    }
    task.record_terminal_run(
        Uuid::new_v4().to_string(),
        Some(format_utc_timestamp(missed_at)),
        now,
        LastRunTrigger::Scheduled,
        LastRunStatus::Missed,
        None,
        task.last_run_error.clone(),
        None,
        Some("missed_run".to_string()),
    );
    task.enabled = false;
    task.set_next_run_at_utc(None);
    task.set_updated_at_utc(now);
    Ok(())
}

pub async fn run_task_now<R: TaskRunner + ?Sized>(
    store: &TaskFileStore,
    task_id: &str,
    runner: &R,
    now: DateTime<Utc>,
) -> Result<(ScheduledTask, TaskExecutionResult)> {
    let mut task = store.get_task(task_id)?;
    let execution = execute_task(&mut task, runner, LastRunTrigger::Manual, now, false).await;
    store.save_task(&task)?;
    Ok((task, execution))
}

pub async fn process_due_tasks_once<R: TaskRunner + ?Sized>(
    store: &TaskFileStore,
    runner: &R,
    now: DateTime<Utc>,
) -> Result<DaemonCycleReport> {
    let mut tasks = store.list_tasks()?;
    tasks.sort_by(|left, right| {
        left.next_run_at
            .cmp(&right.next_run_at)
            .then_with(|| left.id.cmp(&right.id))
    });

    let mut report = DaemonCycleReport::default();
    for mut task in tasks {
        report.scanned += 1;
        match classify_task(&task, now)? {
            ScheduleDecision::Disabled => report.disabled += 1,
            ScheduleDecision::MissingNextRunAt => report.missing_next_run_at += 1,
            ScheduleDecision::PendingFuture => report.pending += 1,
            ScheduleDecision::Due { stale, .. } => {
                // This legacy inline path executes serially, so no
                // per-sweep catch-up throttle is needed here; the
                // executor's sweep is the throttled production path.
                if let Some(stale) = stale.as_ref() {
                    record_stale_missed_and_rearm(&mut task, stale, now);
                    report.missed += 1;
                }
                let _ = execute_task(&mut task, runner, LastRunTrigger::Scheduled, now, true).await;
                report.ran += 1;
                store.save_task(&task)?;
            }
            ScheduleDecision::MissedOnce => {
                mark_once_task_missed(&mut task, now)?;
                report.missed += 1;
                store.save_task(&task)?;
            }
        }
    }
    Ok(report)
}

async fn execute_task<R: TaskRunner + ?Sized>(
    task: &mut ScheduledTask,
    runner: &R,
    trigger: LastRunTrigger,
    now: DateTime<Utc>,
    consume_schedule: bool,
) -> TaskExecutionResult {
    let execution = match run_task_inline(runner, task).await {
        Ok(result) => result,
        Err(error) => TaskExecutionResult::failed(error.to_string()),
    };
    let execution = finalize_execution_result(execution);

    task.set_last_run_at_utc(Some(now));
    task.last_run_status = Some(if execution.success {
        LastRunStatus::Success
    } else {
        LastRunStatus::Failed
    });
    task.last_run_chat_id = if execution.chat_id.is_empty() {
        None
    } else {
        Some(execution.chat_id.clone())
    };
    task.last_run_error = execution.error.clone();
    task.last_run_response_preview = if execution.response_preview.is_empty() {
        None
    } else {
        Some(execution.response_preview.clone())
    };
    task.last_run_trigger = Some(trigger);
    task.set_updated_at_utc(now);
    // Round 4 / Issue 7 — keep the inline run_to_completion path's
    // attention bookkeeping in sync with the storage-level
    // ``clear_current_run_and_record_result`` path. Inline runs go
    // through this helper instead of TerminalRunResult, so we mirror
    // the same set/clear logic here.
    if execution.success {
        task.needs_attention = false;
        task.needs_attention_reason = None;
        task.needs_attention_since = None;
    } else {
        task.needs_attention = true;
        task.needs_attention_reason = Some("run_failed".to_string());
        if task.needs_attention_since.is_none() {
            task.needs_attention_since = Some(format_utc_timestamp(now));
        }
    }

    if consume_schedule {
        advance_schedule_or_disable(task, now);
    }

    execution
}

/// Advance a cron task's `next_run_at` past `now`, or disable a one-off
/// task. When the advance itself fails (unrecognized timezone after a
/// chrono-tz upgrade, unparseable stored cron), disable the task with
/// attention instead of silently leaving `next_run_at` unset — a task
/// with no `next_run_at` would otherwise never fire again with no trace.
pub(crate) fn advance_schedule_or_disable(task: &mut ScheduledTask, now: DateTime<Utc>) {
    match task.schedule.kind {
        ScheduleKind::Cron => match next_future_run_at(&task.schedule, now) {
            Ok(next) => task.set_next_run_at_utc(next),
            Err(schedule_error) => {
                error!(
                    task_id = %task.id,
                    ?schedule_error,
                    "Failed to advance cron schedule after run; disabling task",
                );
                task.enabled = false;
                task.set_next_run_at_utc(None);
                task.needs_attention = true;
                task.needs_attention_reason = Some("schedule_error".to_string());
                if task.needs_attention_since.is_none() {
                    task.needs_attention_since = Some(format_utc_timestamp(now));
                }
            }
        },
        ScheduleKind::Once => {
            task.enabled = false;
            task.set_next_run_at_utc(None);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ScheduleKind, ScheduledTask, TaskSchedule};
    use crate::schedule::initial_next_run_at;
    use core_mcp_shared::{reset_test_redis_state, TEST_ENV_LOCK};
    use std::collections::HashMap;
    use std::env;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex, MutexGuard};
    use uuid::Uuid;

    fn utc(raw: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(raw)
            .unwrap()
            .with_timezone(&Utc)
    }

    struct EnvGuard {
        _guard: MutexGuard<'static, ()>,
        root: PathBuf,
        previous_app_support_dir: Option<String>,
        previous_test_redis: Option<String>,
    }

    impl EnvGuard {
        fn new(name: &str) -> Self {
            let guard = TEST_ENV_LOCK
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            let root = env::temp_dir().join(format!(
                "scheduling-runtime-{name}-{}",
                Uuid::new_v4().simple()
            ));
            fs::create_dir_all(&root).unwrap();
            let previous_app_support_dir = env::var("PORTICO_APP_SUPPORT_DIR").ok();
            let previous_test_redis = env::var("CORE_MCP_TEST_REDIS").ok();
            env::set_var("PORTICO_APP_SUPPORT_DIR", root.join("app-support"));
            env::set_var("CORE_MCP_TEST_REDIS", "memory");
            reset_test_redis_state();
            Self {
                _guard: guard,
                root,
                previous_app_support_dir,
                previous_test_redis,
            }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            if let Some(value) = &self.previous_app_support_dir {
                env::set_var("PORTICO_APP_SUPPORT_DIR", value);
            } else {
                env::remove_var("PORTICO_APP_SUPPORT_DIR");
            }
            if let Some(value) = &self.previous_test_redis {
                env::set_var("CORE_MCP_TEST_REDIS", value);
            } else {
                env::remove_var("CORE_MCP_TEST_REDIS");
            }
            reset_test_redis_state();
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[derive(Clone, Default)]
    struct FakeRunner {
        calls: Arc<Mutex<Vec<String>>>,
        outcomes: Arc<Mutex<HashMap<String, std::result::Result<TaskExecutionResult, String>>>>,
    }

    impl FakeRunner {
        fn with_success(task_id: &str, chat_id: &str, response: &str) -> Self {
            let runner = Self::default();
            runner.outcomes.lock().unwrap().insert(
                task_id.to_string(),
                Ok(TaskExecutionResult {
                    chat_id: chat_id.to_string(),
                    response_preview: response.to_string(),
                    success: true,
                    error: None,
                    finalizer_required: false,
                    verdict: None,
                }),
            );
            runner
        }

        fn with_error(task_id: &str, message: &str) -> Self {
            let runner = Self::default();
            runner
                .outcomes
                .lock()
                .unwrap()
                .insert(task_id.to_string(), Err(message.to_string()));
            runner
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl FakeRunner {
        fn outcome(
            &self,
            task: &ScheduledTask,
        ) -> std::result::Result<TaskExecutionResult, String> {
            self.outcomes
                .lock()
                .unwrap()
                .get(&task.id)
                .cloned()
                .unwrap_or_else(|| {
                    Ok(TaskExecutionResult {
                        chat_id: format!("chat-{}", task.id),
                        response_preview: format!("response-{}", task.id),
                        success: true,
                        error: None,
                        finalizer_required: false,
                        verdict: None,
                    })
                })
        }
    }

    #[async_trait::async_trait]
    impl TaskRunner for FakeRunner {
        async fn start_run(&self, task: &ScheduledTask) -> Result<StartedRunHandle> {
            self.calls.lock().unwrap().push(task.id.clone());
            match self.outcome(task) {
                Ok(result) => Ok(StartedRunHandle {
                    chat_id: result.chat_id,
                    token: format!("token-{}", task.id),
                }),
                Err(message) => Err(anyhow::anyhow!(message)),
            }
        }

        async fn await_completion(
            &self,
            task: &ScheduledTask,
            chat_id: &str,
            _run_token: Option<&str>,
        ) -> Result<TaskExecutionResult> {
            match self.outcome(task) {
                Ok(mut result) => {
                    if !chat_id.is_empty() {
                        result.chat_id = chat_id.to_string();
                    }
                    Ok(result)
                }
                Err(message) => Err(anyhow::anyhow!(message)),
            }
        }
    }

    fn cron_task(id: &str, next_run_at: &str) -> ScheduledTask {
        ScheduledTask {
            id: id.to_string(),
            name: format!("Task {id}"),
            prompt: format!("prompt for {id}"),
            model_id: "GPT-5.4".to_string(),
            schedule: TaskSchedule {
                kind: ScheduleKind::Cron,
                cron_expression: Some("0 9 * * *".to_string()),
                run_at: None,
                timezone: "UTC".to_string(),
            },
            skill_ids: Vec::new(),
            tool_server_ids: Vec::new(),
            enabled: true,
            created_at: "2026-04-01T00:00:00Z".to_string(),
            updated_at: "2026-04-01T00:00:00Z".to_string(),
            next_run_at: Some(next_run_at.to_string()),
            last_run_at: None,
            last_run_status: None,
            last_run_chat_id: None,
            last_run_error: None,
            last_run_response_preview: None,
            last_run_trigger: None,
            current_run: None,
            needs_attention: false,
            needs_attention_reason: None,
            needs_attention_since: None,
            runs: Vec::new(),
        }
    }

    fn once_task(id: &str, run_at: &str, enabled: bool) -> ScheduledTask {
        ScheduledTask {
            id: id.to_string(),
            name: format!("Task {id}"),
            prompt: format!("prompt for {id}"),
            model_id: "GPT-5.4".to_string(),
            schedule: TaskSchedule {
                kind: ScheduleKind::Once,
                cron_expression: None,
                run_at: Some(run_at.to_string()),
                timezone: "UTC".to_string(),
            },
            skill_ids: Vec::new(),
            tool_server_ids: Vec::new(),
            enabled,
            created_at: "2026-04-01T00:00:00Z".to_string(),
            updated_at: "2026-04-01T00:00:00Z".to_string(),
            next_run_at: Some(run_at.to_string()),
            last_run_at: None,
            last_run_status: None,
            last_run_chat_id: None,
            last_run_error: None,
            last_run_response_preview: None,
            last_run_trigger: None,
            current_run: None,
            needs_attention: false,
            needs_attention_reason: None,
            needs_attention_since: None,
            runs: Vec::new(),
        }
    }

    #[test]
    fn classify_task_covers_disabled_missing_pending_on_time_and_catch_up() {
        let now = utc("2026-04-01T12:00:00Z");

        let mut disabled = cron_task("disabled", "2026-04-01T09:00:00Z");
        disabled.enabled = false;
        assert_eq!(
            classify_task(&disabled, now).unwrap(),
            ScheduleDecision::Disabled
        );

        let mut missing = cron_task("missing", "2026-04-01T09:00:00Z");
        missing.next_run_at = None;
        assert_eq!(
            classify_task(&missing, now).unwrap(),
            ScheduleDecision::MissingNextRunAt
        );

        let future = cron_task("future", "2026-04-01T13:00:00Z");
        assert_eq!(
            classify_task(&future, now).unwrap(),
            ScheduleDecision::PendingFuture
        );

        // On-time fire: armed exactly at `now`.
        let due_equal = cron_task("due-equal", "2026-04-01T12:00:00Z");
        assert_eq!(
            classify_task(&due_equal, now).unwrap(),
            ScheduleDecision::Due {
                scheduled_at: now,
                catch_up: false,
                stale: None,
            }
        );

        // Overdue by hours but still the current occurrence (next daily
        // fire is tomorrow 09:00): catch-up, nothing superseded.
        let overdue_current = cron_task("overdue-current", "2026-04-01T09:00:00Z");
        assert_eq!(
            classify_task(&overdue_current, now).unwrap(),
            ScheduleDecision::Due {
                scheduled_at: utc("2026-04-01T09:00:00Z"),
                catch_up: true,
                stale: None,
            }
        );

        // Overdue by days: the two oldest occurrences are superseded and
        // only today's 09:00 occurrence runs.
        let superseded = cron_task("superseded", "2026-03-30T09:00:00Z");
        assert_eq!(
            classify_task(&superseded, now).unwrap(),
            ScheduleDecision::Due {
                scheduled_at: utc("2026-04-01T09:00:00Z"),
                catch_up: true,
                stale: Some(StaleOccurrences {
                    first: utc("2026-03-30T09:00:00Z"),
                    count: 2,
                    count_capped: false,
                    current: utc("2026-04-01T09:00:00Z"),
                }),
            }
        );

        // One-off within the catch-up window: runs late.
        let due_once = once_task("due-once", "2026-04-01T11:00:00Z", true);
        assert_eq!(
            classify_task(&due_once, now).unwrap(),
            ScheduleDecision::Due {
                scheduled_at: utc("2026-04-01T11:00:00Z"),
                catch_up: true,
                stale: None,
            }
        );

        // One-off beyond the 24h window: expired, never runs.
        let expired_once = once_task("expired-once", "2026-03-30T09:30:00Z", true);
        assert_eq!(
            classify_task(&expired_once, now).unwrap(),
            ScheduleDecision::MissedOnce
        );
    }

    #[test]
    fn advance_schedule_or_disable_disables_with_attention_when_schedule_is_unparseable() {
        let now = utc("2026-04-01T12:00:00Z");
        let mut task = cron_task("bad-tz", "2026-04-01T09:00:00Z");
        task.schedule.timezone = "Mars/Olympus".to_string();

        advance_schedule_or_disable(&mut task, now);

        assert!(!task.enabled);
        assert_eq!(task.next_run_at, None);
        assert!(task.needs_attention);
        assert_eq!(
            task.needs_attention_reason.as_deref(),
            Some("schedule_error")
        );
        assert!(task.needs_attention_since.is_some());
    }

    #[tokio::test]
    async fn run_task_now_bypasses_schedule_and_preserves_next_run_at() {
        let _env = EnvGuard::new("manual-run");
        let store = TaskFileStore::new();
        let mut task = cron_task("manual", "2026-04-01T09:00:00Z");
        task.enabled = false;
        let original_next_run_at = task.next_run_at.clone();
        store.save_task(&task).unwrap();

        let runner = FakeRunner::with_success("manual", "chat-manual", "manual response");
        let (updated_task, execution) =
            run_task_now(&store, "manual", &runner, utc("2026-04-01T12:00:00Z"))
                .await
                .unwrap();

        assert_eq!(execution.chat_id, "chat-manual");
        assert_eq!(updated_task.next_run_at, original_next_run_at);
        assert_eq!(updated_task.last_run_trigger, Some(LastRunTrigger::Manual));
        assert_eq!(updated_task.last_run_status, Some(LastRunStatus::Success));
        assert_eq!(runner.calls(), vec!["manual".to_string()]);
    }

    #[tokio::test]
    async fn daemon_runs_overdue_recurring_task_late_instead_of_skipping_it() {
        let _env = EnvGuard::new("catch-up-current");
        let store = TaskFileStore::new();
        // Fired at 09:00, daemon only back at 12:00 — still the current
        // occurrence, so it runs (late) with no missed bookkeeping.
        let task = cron_task("cron-late", "2026-04-01T09:00:00Z");
        store.save_task(&task).unwrap();

        let runner = FakeRunner::with_success("cron-late", "chat-late", "done late");
        let report = process_due_tasks_once(&store, &runner, utc("2026-04-01T12:00:00Z"))
            .await
            .unwrap();

        let updated = store.get_task("cron-late").unwrap();
        assert_eq!(report.ran, 1);
        assert_eq!(report.missed, 0);
        assert_eq!(runner.calls(), vec!["cron-late".to_string()]);
        assert_eq!(updated.last_run_status, Some(LastRunStatus::Success));
        assert!(!updated.needs_attention);
        assert_eq!(
            updated.next_run_at,
            Some("2026-04-02T09:00:00Z".to_string())
        );
        assert!(updated.enabled);
    }

    #[tokio::test]
    async fn daemon_catches_up_superseded_recurring_task_with_one_run_and_a_missed_row() {
        let _env = EnvGuard::new("catch-up-superseded");
        let store = TaskFileStore::new();
        // Last armed 2026-03-30 09:00; the daemon comes back 2026-04-01
        // 12:00. The 03-30 and 03-31 occurrences are superseded (one
        // missed row, never executed); only today's 09:00 occurrence runs.
        let task = cron_task("cron-superseded", "2026-03-30T09:00:00Z");
        store.save_task(&task).unwrap();

        let runner = FakeRunner::with_success("cron-superseded", "chat-superseded", "done");
        let report = process_due_tasks_once(&store, &runner, utc("2026-04-01T12:00:00Z"))
            .await
            .unwrap();

        let updated = store.get_task("cron-superseded").unwrap();
        assert_eq!(report.ran, 1);
        assert_eq!(report.missed, 1);
        assert_eq!(runner.calls(), vec!["cron-superseded".to_string()]);
        // The catch-up run's success is the task-level terminal state...
        assert_eq!(updated.last_run_status, Some(LastRunStatus::Success));
        assert!(!updated.needs_attention, "success clears attention");
        assert_eq!(
            updated.next_run_at,
            Some("2026-04-02T09:00:00Z".to_string())
        );
        // ...and the superseded occurrences remain visible in run history.
        let missed_row = updated
            .runs
            .iter()
            .find(|run| run.status == Some(LastRunStatus::Missed))
            .expect("superseded occurrences recorded as a missed run row");
        let error = missed_row.error.as_deref().unwrap_or_default();
        assert!(
            error.starts_with("Skipped 2 scheduled runs starting at 2026-03-30 09:00 UTC"),
            "unexpected missed message: {error}"
        );
        assert!(missed_row.needs_attention);
        assert_eq!(
            missed_row.needs_attention_reason.as_deref(),
            Some("missed_run")
        );
    }

    #[tokio::test]
    async fn daemon_catches_up_once_task_within_window() {
        let _env = EnvGuard::new("once-catch-up");
        let store = TaskFileStore::new();
        store
            .save_task(&once_task("once-late", "2026-04-01T09:30:00Z", true))
            .unwrap();

        let runner = FakeRunner::with_success("once-late", "chat-once-late", "done");
        let report = process_due_tasks_once(&store, &runner, utc("2026-04-01T12:00:00Z"))
            .await
            .unwrap();

        let updated = store.get_task("once-late").unwrap();
        assert_eq!(report.ran, 1);
        assert_eq!(report.missed, 0);
        assert_eq!(runner.calls(), vec!["once-late".to_string()]);
        assert_eq!(updated.last_run_status, Some(LastRunStatus::Success));
        assert_eq!(updated.next_run_at, None);
        assert!(!updated.enabled, "once tasks disable after running");
    }

    #[tokio::test]
    async fn daemon_marks_expired_once_task_missed_and_disables_without_execution() {
        let _env = EnvGuard::new("once-expired");
        let store = TaskFileStore::new();
        // run_at is more than 24h before `now`: beyond the catch-up window.
        store
            .save_task(&once_task("once-expired", "2026-03-30T09:30:00Z", true))
            .unwrap();

        let runner = FakeRunner::default();
        let report = process_due_tasks_once(&store, &runner, utc("2026-04-01T12:00:00Z"))
            .await
            .unwrap();

        let updated = store.get_task("once-expired").unwrap();
        assert_eq!(report.missed, 1);
        assert!(runner.calls().is_empty());
        assert_eq!(updated.last_run_status, Some(LastRunStatus::Missed));
        assert_eq!(
            updated.last_run_at,
            Some("2026-03-30T09:30:00Z".to_string())
        );
        assert_eq!(
            updated.last_run_error,
            Some(
                "Skipped because the app was not running at the scheduled time (2026-03-30 09:30 UTC) and the 24-hour catch-up window had already passed when it came back."
                    .to_string()
            )
        );
        assert!(updated.needs_attention);
        assert_eq!(
            updated.needs_attention_reason.as_deref(),
            Some("missed_run")
        );
        assert!(updated.needs_attention_since.is_some());
        assert_eq!(updated.next_run_at, None);
        assert!(!updated.enabled);
    }

    #[tokio::test]
    async fn daemon_runs_due_task_once_and_does_not_double_run_after_restart() {
        let _env = EnvGuard::new("due-run-once");
        let store = TaskFileStore::new();
        store
            .save_task(&cron_task("cron-due", "2026-04-01T11:00:00Z"))
            .unwrap();

        let runner = FakeRunner::with_success("cron-due", "chat-due", "done");
        process_due_tasks_once(&store, &runner, utc("2026-04-01T12:00:00Z"))
            .await
            .unwrap();
        process_due_tasks_once(&store, &runner, utc("2026-04-01T12:00:00Z"))
            .await
            .unwrap();

        let updated = store.get_task("cron-due").unwrap();
        assert_eq!(runner.calls(), vec!["cron-due".to_string()]);
        assert_eq!(updated.last_run_status, Some(LastRunStatus::Success));
        assert_eq!(updated.last_run_chat_id, Some("chat-due".to_string()));
        assert_eq!(
            updated.next_run_at,
            Some("2026-04-02T09:00:00Z".to_string())
        );
    }

    #[tokio::test]
    async fn expired_once_task_is_not_reprocessed_on_next_poll() {
        let _env = EnvGuard::new("missed-repeat");
        let store = TaskFileStore::new();
        store
            .save_task(&once_task("once-repeat", "2026-03-30T09:30:00Z", true))
            .unwrap();

        let runner = FakeRunner::default();
        process_due_tasks_once(&store, &runner, utc("2026-04-01T12:00:00Z"))
            .await
            .unwrap();
        let after_first = store.get_task("once-repeat").unwrap();

        process_due_tasks_once(&store, &runner, utc("2026-04-01T12:05:00Z"))
            .await
            .unwrap();
        let after_second = store.get_task("once-repeat").unwrap();

        assert_eq!(after_first, after_second);
        assert!(runner.calls().is_empty());
    }

    #[tokio::test]
    async fn process_due_tasks_once_orders_tasks_deterministically() {
        let _env = EnvGuard::new("ordering");
        let store = TaskFileStore::new();
        store
            .save_task(&cron_task("task-b", "2026-04-01T11:00:00Z"))
            .unwrap();
        store
            .save_task(&cron_task("task-a", "2026-04-01T11:00:00Z"))
            .unwrap();

        let runner = FakeRunner::default();
        process_due_tasks_once(&store, &runner, utc("2026-04-01T12:00:00Z"))
            .await
            .unwrap();

        assert_eq!(
            runner.calls(),
            vec!["task-a".to_string(), "task-b".to_string()]
        );
    }

    #[tokio::test]
    async fn execution_failure_updates_metadata_and_keeps_future_schedule_semantics() {
        let _env = EnvGuard::new("failure");
        let store = TaskFileStore::new();
        store
            .save_task(&cron_task("task-fail", "2026-04-01T11:00:00Z"))
            .unwrap();

        let runner = FakeRunner::with_error("task-fail", "upstream exploded");
        process_due_tasks_once(&store, &runner, utc("2026-04-01T12:00:00Z"))
            .await
            .unwrap();

        let updated = store.get_task("task-fail").unwrap();
        assert_eq!(updated.last_run_status, Some(LastRunStatus::Failed));
        assert_eq!(
            updated.last_run_error,
            Some("upstream exploded".to_string())
        );
        assert_eq!(
            updated.next_run_at,
            Some("2026-04-02T09:00:00Z".to_string())
        );
    }

    #[tokio::test]
    async fn once_task_failure_disables_after_attempt_to_prevent_repeat_loops() {
        let _env = EnvGuard::new("once-failure");
        let store = TaskFileStore::new();
        store
            .save_task(&once_task("once-fail", "2026-04-01T11:00:00Z", true))
            .unwrap();

        let runner = FakeRunner::with_error("once-fail", "transient failure");
        process_due_tasks_once(&store, &runner, utc("2026-04-01T12:00:00Z"))
            .await
            .unwrap();

        let updated = store.get_task("once-fail").unwrap();
        assert_eq!(updated.last_run_status, Some(LastRunStatus::Failed));
        assert_eq!(updated.next_run_at, None);
        assert!(!updated.enabled);
    }

    #[test]
    fn cron_initial_next_run_helper_is_stable_for_runtime_expectations() {
        let next = initial_next_run_at(
            &TaskSchedule {
                kind: ScheduleKind::Cron,
                cron_expression: Some("0 9 * * *".to_string()),
                run_at: None,
                timezone: "UTC".to_string(),
            },
            utc("2026-04-01T08:59:00Z"),
        )
        .unwrap()
        .unwrap();
        assert_eq!(next, utc("2026-04-01T09:00:00Z"));
    }

    #[tokio::test]
    async fn claim_and_start_run_writes_current_run_when_unclaimed() {
        let _env = EnvGuard::new("claim-fresh");
        let store = TaskFileStore::new();
        store
            .save_task(&cron_task("fresh", "2026-04-01T11:00:00Z"))
            .unwrap();

        let runner = FakeRunner::with_success("fresh", "chat-fresh", "ok");
        let outcome = claim_and_start_run(
            &store,
            &runner,
            "fresh",
            LastRunTrigger::Manual,
            utc("2026-04-01T12:00:00Z"),
        )
        .await
        .unwrap();
        match outcome {
            ClaimRunOutcome::Claimed { run } => {
                assert_eq!(run.chat_id, "chat-fresh");
                assert_eq!(run.trigger, LastRunTrigger::Manual);
            }
            other => panic!("expected Claimed, got {other:?}"),
        }
        let stored = store.get_task("fresh").unwrap();
        assert_eq!(stored.current_run.as_ref().unwrap().chat_id, "chat-fresh");
        assert_eq!(runner.calls(), vec!["fresh".to_string()]);
    }

    #[tokio::test]
    async fn claim_and_start_run_returns_already_claimed_when_run_in_flight() {
        let _env = EnvGuard::new("claim-already");
        let store = TaskFileStore::new();
        let mut task = cron_task("busy", "2026-04-01T11:00:00Z");
        task.current_run = Some(crate::storage::make_current_run(
            "chat-existing",
            LastRunTrigger::Manual,
            utc("2026-04-01T11:30:00Z"),
        ));
        store.save_task(&task).unwrap();

        let runner = FakeRunner::with_success("busy", "chat-busy", "ok");
        let outcome = claim_and_start_run(
            &store,
            &runner,
            "busy",
            LastRunTrigger::Manual,
            utc("2026-04-01T12:00:00Z"),
        )
        .await
        .unwrap();
        match outcome {
            ClaimRunOutcome::AlreadyClaimed { existing } => {
                assert_eq!(existing.chat_id, "chat-existing");
            }
            other => panic!("expected AlreadyClaimed, got {other:?}"),
        }
        // Runner.start_run must NOT have been called - no fresh chat.
        assert!(runner.calls().is_empty());
    }

    #[tokio::test]
    async fn claim_and_start_run_returns_task_not_found_for_unknown_id() {
        let _env = EnvGuard::new("claim-missing");
        let store = TaskFileStore::new();
        let runner = FakeRunner::default();
        let outcome = claim_and_start_run(
            &store,
            &runner,
            "ghost",
            LastRunTrigger::Manual,
            utc("2026-04-01T12:00:00Z"),
        )
        .await
        .unwrap();
        assert!(matches!(outcome, ClaimRunOutcome::TaskNotFound));
        assert!(runner.calls().is_empty());
    }

    // -----------------------------------------------------------------------
    // Phase 1: scheduled-run chat metadata builder. The gate trusts this
    // payload to decide auto-dispatch / out-of-scope chip routing, so the
    // shape MUST stay stable. These tests pin the schema.
    // -----------------------------------------------------------------------

    #[test]
    fn build_scheduled_run_chat_metadata_emits_run_origin_task_id_and_approved_scope() {
        let mut task = cron_task("task-with-scope", "2026-04-01T11:00:00Z");
        task.tool_server_ids = vec!["server:slack".to_string(), "server:gmail".to_string()];
        let metadata = build_scheduled_run_chat_metadata(&task);
        assert_eq!(
            metadata
                .get(CHAT_META_RUN_ORIGIN_KEY)
                .and_then(|v| v.as_str()),
            Some(CHAT_META_RUN_ORIGIN_VALUE_SCHEDULED),
        );
        assert_eq!(
            metadata.get(CHAT_META_TASK_ID_KEY).and_then(|v| v.as_str()),
            Some("task-with-scope"),
        );
        let scope = metadata
            .get(CHAT_META_APPROVED_SCOPE_KEY)
            .and_then(|v| v.as_array())
            .expect("approved_scope must be an array");
        let scope_strings: Vec<&str> = scope.iter().filter_map(|v| v.as_str()).collect();
        assert_eq!(scope_strings, vec!["server:slack", "server:gmail"]);
    }

    #[test]
    fn scheduled_task_folder_name_uses_generated_name() {
        let mut task = cron_task("folder-name", "2026-04-01T11:00:00Z");
        task.name = "Afternoon break reminder".to_string();
        task.prompt = "  Break Reminder\n\nTell the user to take a break.  ".to_string();
        assert_eq!(
            scheduled_task_folder_name(&task),
            "Afternoon break reminder · folder-n"
        );
    }

    #[test]
    fn scheduled_task_folder_name_distinguishes_duplicate_generated_names() {
        let mut first = cron_task("scheduled-task-a1b2c3d4-one", "2026-04-01T11:00:00Z");
        first.name = "Weekly status summary".to_string();
        let mut second = first.clone();
        second.id = "scheduled-task-e5f6a7b8-two".to_string();

        assert_eq!(
            scheduled_task_folder_name(&first),
            "Weekly status summary · a1b2c3d4"
        );
        assert_eq!(
            scheduled_task_folder_name(&second),
            "Weekly status summary · e5f6a7b8"
        );
    }

    #[test]
    fn scheduled_task_folder_name_falls_back_for_legacy_records() {
        let mut task = cron_task("folder-empty", "2026-04-01T11:00:00Z");
        task.name = String::new();
        task.prompt = "  Check the release dashboard  ".to_string();
        assert_eq!(
            scheduled_task_folder_name(&task),
            "Check the release dashboard"
        );

        task.prompt = "  ".to_string();
        assert_eq!(
            scheduled_task_folder_name(&task),
            SCHEDULED_TASKS_FOLDER_NAME
        );
    }

    #[test]
    fn build_scheduled_run_chat_metadata_handles_empty_scope() {
        // A task with no tool_server_ids is legal (only core tools);
        // metadata still carries an empty array so the gate's
        // membership check sees a defined-but-empty scope rather than
        // a missing key (which it would interpret as "non-scheduled").
        let task = cron_task("task-no-scope", "2026-04-01T11:00:00Z");
        let metadata = build_scheduled_run_chat_metadata(&task);
        let scope = metadata
            .get(CHAT_META_APPROVED_SCOPE_KEY)
            .and_then(|v| v.as_array())
            .expect("approved_scope key must exist even when empty");
        assert!(scope.is_empty());
    }

    #[test]
    fn subagent_task_runner_populates_metadata_on_request_for_scheduled_runs() {
        // Belt-and-braces: SubagentTaskRunner::build_request must
        // attach the chat-metadata bundle so the daemon-driven path
        // sets ``run_origin: "scheduled"`` on every chat it creates.
        // A regression here means the gate sees the chat as
        // user-driven and never auto-dispatches in-scope tools.
        let mut task = cron_task("rt-task", "2026-04-01T11:00:00Z");
        task.tool_server_ids = vec!["server:slack".to_string()];
        let request = SubagentTaskRunner::build_request(&task);
        let metadata = request
            .metadata
            .as_ref()
            .expect("scheduled runs must always supply chat metadata");
        assert_eq!(
            metadata
                .get(CHAT_META_RUN_ORIGIN_KEY)
                .and_then(|v| v.as_str()),
            Some(CHAT_META_RUN_ORIGIN_VALUE_SCHEDULED),
        );
        assert_eq!(
            metadata.get(CHAT_META_TASK_ID_KEY).and_then(|v| v.as_str()),
            Some("rt-task"),
        );
    }

    #[test]
    fn scheduled_run_system_prompt_forbids_questions_and_requires_block_and_explain() {
        let task = cron_task("unattended-contract", "2026-04-01T11:00:00Z");
        let request = SubagentTaskRunner::build_request(&task);
        let system_prompt = request
            .system_prompt
            .as_deref()
            .expect("scheduled runs must include their unattended contract");

        // Never ask, never wait.
        assert!(system_prompt.contains("MUST NOT ask the user questions"));
        assert!(system_prompt.contains("pause waiting for user input"));
        assert!(system_prompt.contains("silently strands the run"));
        assert!(system_prompt.contains("sensible documented default over asking"));
        // Block-and-explain instead.
        assert!(system_prompt.contains("do NOT attempt the blocked action and do NOT ask"));
        assert!(system_prompt.contains(r#"`status="needs_attention"`"#));
        assert!(system_prompt.contains("what blocked this run"));
        assert!(system_prompt.contains("so future runs succeed"));
        assert!(system_prompt.contains("The task owner will read it later when they open this chat"));
        // The explanation survives the terse visible-response contract.
        assert!(system_prompt.contains("Exception: for a blocked or failed run"));
        assert!(system_prompt.contains("never a question"));
    }

    #[test]
    fn scheduled_run_system_prompt_treats_message_like_content_as_a_user_job() {
        let mut task = cron_task("reminder-contract", "2026-04-01T11:00:00Z");
        task.prompt =
            "Time to take a short break from work. Step away from your screen.".to_string();

        let request = SubagentTaskRunner::build_request(&task);
        let system_prompt = request
            .system_prompt
            .as_deref()
            .expect("scheduled runs must include their interpretation contract");

        assert!(system_prompt.contains("job specification from the task owner"));
        assert!(system_prompt.contains("deliver that reminder to the user"));
        assert!(system_prompt.contains("do not personally need the reminder"));
        assert!(system_prompt.contains("from this run's execution time"));
        assert!(system_prompt.contains("unless the relevant tool confirms it"));
        assert!(system_prompt.contains("do not merely acknowledge, praise, or discuss"));
        assert!(system_prompt.contains("before writing the user-visible response"));
        assert!(system_prompt.contains("Do not write any user-visible text before or alongside"));
        assert!(system_prompt.contains("write exactly one final response and end the run"));
        assert!(system_prompt.contains("Return only the useful result requested by the task"));
        assert!(system_prompt.contains("Do not add a preamble"));
        assert!(system_prompt.contains("For a reminder, write the reminder itself once and stop"));
        assert!(system_prompt.contains("Reminder delivered"));
        assert_eq!(request.prompt, task.prompt);
    }
}
