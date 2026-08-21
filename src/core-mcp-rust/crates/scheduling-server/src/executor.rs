//! Long-lived run executor owned by the scheduling daemon.
//!
//! Responsibilities:
//!   * On startup: reconcile orphaned in-flight runs (re-attach polling for
//!     any task whose `current_run` is set on disk).
//!   * Forever: wait on a Redis BRPOP for `Start`/`Cancel` signals from the
//!     scheduling-server, plus run a periodic sweep for newly-due scheduled
//!     tasks and any orphans that slip past the signal path.
//!
//! All authoritative "is this run in flight?" state lives in
//! `ScheduledTask.current_run` on disk. The in-memory `active` set is a
//! purely local optimization that prevents double-spawning awaits inside
//! one daemon process. Crash recovery does not depend on it.

use anyhow::Result;
use chrono::{DateTime, Utc};
use core_mcp_shared::{redis_get_string, redis_setex_string};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::model::{
    format_utc_timestamp, CurrentRun, LastRunStatus, LastRunTrigger, ScheduledTask,
};
use crate::preflight::{
    any_auth_failure, check_scheduler_bridge_readiness_from_env, check_tool_servers_available,
    render_missing_integration_message, SchedulerBridgeReadiness,
};
use crate::runtime::{
    advance_schedule_or_disable, claim_and_start_run, classify_task, forget_remembered_run_token,
    forget_scheduled_run_verdict, get_remembered_run_token, mark_once_task_missed,
    record_stale_missed_and_rearm, ClaimRunOutcome, ScheduleDecision, ScheduledRunVerdictStatus,
    TaskRunner,
};
use crate::signals::{next_run_signal, RunSignal};
use crate::storage::{ClearCurrentRunOutcome, TaskFileStore, TerminalRunResult};

/// TTL on the per-run cancellation marker. Long enough to survive daemon
/// restarts during the cancel propagation window.
const CANCEL_MARKER_TTL_SECONDS: u64 = 600;

/// TTL on the upstream subagent cancel flag, mirroring existing usage in
/// `subagents-server`.
const SUBAGENT_CANCEL_TTL_SECONDS: u64 = 300;

/// Redis key prefix for "this scheduling run was cancelled" markers.
/// Distinct from `subagent_cancel:<chat_id>` (which is consumed and
/// deleted by the subagent poll loop). The scheduling-side marker lets the
/// executor's terminal-status logic distinguish cancellation from
/// upstream failure.
pub const SCHEDULING_RUN_CANCELLED_KEY_PREFIX: &str = "scheduling_run_cancelled:";

/// Minimum wait between BRPOP iterations on transient errors so the daemon
/// does not busy-loop when Redis is unavailable.
const BRPOP_BACKOFF_AFTER_ERROR: Duration = Duration::from_secs(1);

/// Maximum catch-up (late) scheduled runs launched per sweep tick. Bounds
/// the wake-from-sleep thundering herd: N tasks that all came due while
/// the machine was asleep drain one per sweep (~30s apart), most-overdue
/// first, instead of all at once against a just-woken stack. On-time runs
/// are not throttled.
const CATCH_UP_LAUNCHES_PER_SWEEP: usize = 1;

/// Build the per-run cancellation marker key.
pub fn run_cancelled_marker_key(run_id: &str) -> String {
    format!("{SCHEDULING_RUN_CANCELLED_KEY_PREFIX}{run_id}")
}

/// Set the per-run cancellation marker. Called by the cancel-run tool
/// handler before signaling the daemon.
pub fn mark_run_cancelled(run_id: &str) -> Result<()> {
    redis_setex_string(
        &run_cancelled_marker_key(run_id),
        "true",
        CANCEL_MARKER_TTL_SECONDS,
    )
}

/// Set the upstream subagent cancel flag observed by `poll_subagent_completion`.
pub fn signal_subagent_cancel(chat_id: &str) -> Result<()> {
    redis_setex_string(
        &format!("subagent_cancel:{chat_id}"),
        "true",
        SUBAGENT_CANCEL_TTL_SECONDS,
    )
}

fn was_run_cancelled(run_id: &str) -> bool {
    redis_get_string(&run_cancelled_marker_key(run_id))
        .ok()
        .flatten()
        .is_some()
}

/// The scheduling daemon's run loop. Generic over a `TaskRunner` so unit
/// tests can plug in fakes.
pub struct Executor<R: TaskRunner + 'static> {
    store: Arc<TaskFileStore>,
    runner: Arc<R>,
    daemon_started_at: DateTime<Utc>,
    poll_interval: Duration,
    active: Arc<Mutex<HashSet<String>>>,
}

impl<R: TaskRunner + 'static> Executor<R> {
    pub fn new(store: TaskFileStore, runner: R, poll_interval: Duration) -> Arc<Self> {
        Arc::new(Self {
            store: Arc::new(store),
            runner: Arc::new(runner),
            daemon_started_at: Utc::now(),
            poll_interval,
            active: Arc::new(Mutex::new(HashSet::new())),
        })
    }

    pub fn with_started_at(
        store: TaskFileStore,
        runner: R,
        poll_interval: Duration,
        daemon_started_at: DateTime<Utc>,
    ) -> Arc<Self> {
        Arc::new(Self {
            store: Arc::new(store),
            runner: Arc::new(runner),
            daemon_started_at,
            poll_interval,
            active: Arc::new(Mutex::new(HashSet::new())),
        })
    }

    pub fn daemon_started_at(&self) -> DateTime<Utc> {
        self.daemon_started_at
    }

    /// Run the executor forever. Reconciles orphans + processes due tasks
    /// on every iteration so a missed/late signal cannot strand a run.
    pub async fn run_forever(self: Arc<Self>) -> Result<()> {
        info!(
            daemon_started_at = %self.daemon_started_at,
            poll_interval_seconds = self.poll_interval.as_secs(),
            "Scheduling executor: starting run loop",
        );

        if let Err(error) = self.reconcile_orphans().await {
            error!(?error, "Reconciliation sweep failed at startup");
        }
        if let Err(error) = self.scheduled_sweep(Utc::now()).await {
            error!(?error, "Scheduled sweep failed at startup");
        }

        loop {
            match next_run_signal(self.poll_interval).await {
                Ok(Some(signal)) => {
                    if let Err(error) = self.handle_signal(signal).await {
                        error!(?error, "Failed to handle run signal");
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    error!(?error, "BRPOP run-signal failed; backing off");
                    tokio::time::sleep(BRPOP_BACKOFF_AFTER_ERROR).await;
                }
            }
            if let Err(error) = self.reconcile_orphans().await {
                error!(?error, "Reconciliation sweep failed");
            }
            if let Err(error) = self.scheduled_sweep(Utc::now()).await {
                error!(?error, "Scheduled sweep failed");
            }
        }
    }

    /// Find tasks whose `current_run` is set on disk but for which we
    /// have no in-memory await running, and spawn await for each.
    /// Used at startup and on every sweep iteration.
    pub async fn reconcile_orphans(self: &Arc<Self>) -> Result<()> {
        let tasks = self.store.list_tasks()?;
        for task in tasks {
            let Some(current_run) = task.current_run.clone() else {
                continue;
            };
            if !self.try_mark_active(&task.id).await {
                continue;
            }
            self.spawn_await(task.id.clone(), current_run);
        }
        Ok(())
    }

    /// Process scheduled-due tasks: start runs for `Due` tasks (including
    /// catch-up runs for occurrences that came due while the scheduler was
    /// down), record superseded occurrences as missed, and expire stale
    /// one-off tasks. Catch-up launches are throttled to
    /// `CATCH_UP_LAUNCHES_PER_SWEEP` per tick; tasks are processed
    /// most-overdue first, so a backlog drains oldest-first.
    pub async fn scheduled_sweep(self: &Arc<Self>, now: DateTime<Utc>) -> Result<()> {
        let mut tasks = self.store.list_tasks()?;
        tasks.sort_by(|left, right| {
            left.next_run_at
                .cmp(&right.next_run_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        let mut bridge_readiness: Option<SchedulerBridgeReadiness> = None;
        let mut catch_up_launches = 0usize;
        for mut task in tasks {
            // An in-flight run (e.g. re-attached by reconcile_orphans after
            // a daemon restart) owns this task: its terminal advances the
            // schedule. Stamping missed rows or starting another run
            // underneath it would double-consume occurrences.
            if task.current_run.is_some() {
                continue;
            }
            // Contain per-task classification failures (e.g. a stored
            // schedule whose timezone no longer parses): one broken task
            // must not abort the sweep for every other task.
            let decision = match classify_task(&task, now) {
                Ok(decision) => decision,
                Err(classify_error) => {
                    error!(
                        task_id = %task.id,
                        ?classify_error,
                        "Failed to classify scheduled task; skipping it this sweep",
                    );
                    continue;
                }
            };
            match decision {
                ScheduleDecision::Due {
                    scheduled_at,
                    catch_up,
                    stale,
                } => {
                    if let Some(stale) = stale.as_ref() {
                        record_stale_missed_and_rearm(&mut task, stale, now);
                        warn!(
                            task_id = %task.id,
                            skipped = stale.count,
                            first_missed = %stale.first,
                            catching_up_with = %stale.current,
                            "Recorded superseded scheduled occurrences as missed; catching up with the most recent",
                        );
                        if let Err(save_error) = self.store.save_task(&task) {
                            error!(
                                task_id = %task.id,
                                ?save_error,
                                "Failed to persist superseded-occurrence bookkeeping; skipping task this sweep",
                            );
                            continue;
                        }
                    }
                    if catch_up && catch_up_launches >= CATCH_UP_LAUNCHES_PER_SWEEP {
                        info!(
                            task_id = %task.id,
                            scheduled_at = %scheduled_at,
                            "Deferring catch-up run to a later sweep (per-sweep catch-up limit reached)",
                        );
                        continue;
                    }
                    if !self.try_mark_active(&task.id).await {
                        continue;
                    }
                    match self
                        .start_scheduled(&task, now, &mut bridge_readiness)
                        .await
                    {
                        Ok(true) => {
                            if catch_up {
                                catch_up_launches += 1;
                            }
                        }
                        Ok(false) => {}
                        Err(error) => {
                            error!(task_id = %task.id, ?error, "Scheduled start failed");
                            self.unmark_active(&task.id).await;
                        }
                    }
                }
                ScheduleDecision::MissedOnce => {
                    if let Err(error) = self.handle_missed_once(task, now).await {
                        error!(?error, "Failed to record missed task");
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// Handle a single inbound run signal.
    pub async fn handle_signal(self: &Arc<Self>, signal: RunSignal) -> Result<()> {
        match signal {
            RunSignal::Start { task_id, run_id } => {
                let task = match self.store.get_task(&task_id) {
                    Ok(task) => task,
                    Err(_) => return Ok(()),
                };
                let Some(current_run) = task.current_run.clone() else {
                    return Ok(());
                };
                if current_run.run_id != run_id {
                    // The signal references a stale run; the on-disk state
                    // is the source of truth, ignore.
                    return Ok(());
                }
                if !self.try_mark_active(&task_id).await {
                    return Ok(());
                }
                self.spawn_await(task_id, current_run);
            }
            RunSignal::Cancel { task_id, run_id } => {
                let task = match self.store.get_task(&task_id) {
                    Ok(task) => task,
                    Err(_) => return Ok(()),
                };
                let Some(current_run) = task.current_run.clone() else {
                    return Ok(());
                };
                if current_run.run_id != run_id {
                    return Ok(());
                }
                let _ = mark_run_cancelled(&run_id);
                let _ = signal_subagent_cancel(&current_run.chat_id);
                info!(
                    task_id = %task_id,
                    run_id = %run_id,
                    chat_id = %current_run.chat_id,
                    "Cancellation signaled to upstream subagent",
                );
            }
        }
        Ok(())
    }

    async fn try_mark_active(&self, task_id: &str) -> bool {
        let mut active = self.active.lock().await;
        if active.contains(task_id) {
            return false;
        }
        active.insert(task_id.to_string());
        true
    }

    async fn unmark_active(&self, task_id: &str) {
        let mut active = self.active.lock().await;
        active.remove(task_id);
    }

    /// Attempt to start a scheduled run. Returns `Ok(true)` when a run was
    /// claimed (or re-attached), `Ok(false)` when the task was deferred
    /// (host bridge not ready) or aborted by the integration preflight.
    async fn start_scheduled(
        self: &Arc<Self>,
        task: &ScheduledTask,
        now: DateTime<Utc>,
        bridge_readiness: &mut Option<SchedulerBridgeReadiness>,
    ) -> Result<bool> {
        let readiness = match bridge_readiness {
            Some(value) => value.clone(),
            None => {
                let value = check_scheduler_bridge_readiness_from_env().await;
                if !value.ready {
                    // One line per sweep (the readiness result is cached
                    // for the remaining tasks), not one per task.
                    warn!(
                        reason = %value.reason,
                        "Scheduler bridge not ready; deferring due scheduled runs to a later sweep",
                    );
                }
                *bridge_readiness = Some(value.clone());
                value
            }
        };
        if !readiness.ready {
            // Defer, don't burn: leave `next_run_at` untouched so the next
            // sweep (~30s) retries. The occurrence stays runnable until a
            // newer occurrence supersedes it, at which point the sweep
            // records it as missed. A transient 1s bridge hiccup at the
            // fire minute no longer costs the whole occurrence.
            self.unmark_active(&task.id).await;
            return Ok(false);
        }

        // Phase 2 guardrail: verify every tool_server_id this task
        // depends on is installed AND enabled BEFORE we burn a chat
        // slot on it. The skill instructs the model to do this at
        // creation time; we double-check here in case an integration
        // was uninstalled / toggled off between creation and the
        // scheduled trigger fire.
        if let Some(error_message) = self
            .preflight_or_record_missing_integration(task, now)
            .await?
        {
            // ``preflight_or_record_missing_integration`` already
            // wrote the terminal status; just log and bail without
            // reaching the runner.
            warn!(
                task_id = %task.id,
                reason = %error_message,
                "Skipping scheduled run: pre-flight guardrail tripped",
            );
            self.unmark_active(&task.id).await;
            return Ok(false);
        }

        let outcome = claim_and_start_run(
            &self.store,
            self.runner.as_ref(),
            &task.id,
            LastRunTrigger::Scheduled,
            now,
        )
        .await?;
        match outcome {
            ClaimRunOutcome::Claimed { run } => {
                info!(
                    task_id = %task.id,
                    run_id = %run.run_id,
                    chat_id = %run.chat_id,
                    "Scheduled run started",
                );
                self.spawn_await(task.id.clone(), run);
                Ok(true)
            }
            ClaimRunOutcome::AlreadyClaimed { existing } => {
                self.spawn_await(task.id.clone(), existing);
                Ok(true)
            }
            ClaimRunOutcome::TaskNotFound => {
                self.unmark_active(&task.id).await;
                Ok(false)
            }
        }
    }

    /// Run the integration pre-flight against ``task.tool_server_ids``.
    /// On success, returns ``Ok(None)`` and the caller proceeds.
    ///
    /// On failure, writes a terminal row to the task — either
    /// ``MissingIntegration`` (server not installed / disabled) or
    /// ``AuthRequired`` (round 4 / Issue 5a — auth missing or expired)
    /// — advancing the cron schedule like any other terminal, and
    /// returns ``Ok(Some(message))`` so the caller can log + bail
    /// without dispatching a sub-agent chat.
    ///
    /// Filesystem errors during enumeration are FAIL-CLOSED: if we
    /// can't decisively say "everything is installed", we treat the
    /// run as missing-integration. This is the conservative choice
    /// for a security/safety guardrail.
    async fn preflight_or_record_missing_integration(
        self: &Arc<Self>,
        task: &ScheduledTask,
        now: DateTime<Utc>,
    ) -> Result<Option<String>> {
        let preflight_result = check_tool_servers_available(&task.tool_server_ids);
        let offline = match preflight_result {
            Ok(list) => list,
            Err(error) => {
                // FAIL-CLOSED: an enumeration error is recorded as a
                // missing-integration outcome. The error text goes
                // into ``last_run_error`` so an operator can see
                // exactly what filesystem op failed.
                let message = format!(
                    "Aborting run: pre-flight integration health check failed: {error}. \
                     Verify the MCP configs directory is readable."
                );
                self.record_preflight_terminal(
                    task,
                    now,
                    message.clone(),
                    LastRunStatus::MissingIntegration,
                )
                .await?;
                return Ok(Some(message));
            }
        };
        if offline.is_empty() {
            return Ok(None);
        }
        let message = render_missing_integration_message(&offline);
        // Round 4 / Issue 5a — auth-only failures get the dedicated
        // ``AuthRequired`` status so the user knows whether to
        // re-install or just re-authorize.
        let terminal_status = if any_auth_failure(&offline) {
            LastRunStatus::AuthRequired
        } else {
            LastRunStatus::MissingIntegration
        };
        self.record_preflight_terminal(task, now, message.clone(), terminal_status)
            .await?;
        Ok(Some(message))
    }

    /// Stamp a terminal preflight-failure row on the task. Cron tasks
    /// advance ``next_run_at``; once-tasks become disabled. Caller
    /// supplies whichever ``LastRunStatus`` matches the failure mode
    /// (``MissingIntegration`` for install/disable, ``AuthRequired``
    /// for auth-state failures). Mirrors the bookkeeping in
    /// ``handle_missed`` so the user-facing state machine stays
    /// uniform across all terminal outcomes.
    async fn record_preflight_terminal(
        self: &Arc<Self>,
        task: &ScheduledTask,
        now: DateTime<Utc>,
        error_message: String,
        terminal_status: LastRunStatus,
    ) -> Result<()> {
        let mut updated = task.clone();
        updated.set_last_run_at_utc(Some(now));
        updated.last_run_status = Some(terminal_status.clone());
        updated.last_run_chat_id = None;
        updated.last_run_response_preview = None;
        updated.last_run_trigger = Some(LastRunTrigger::Scheduled);
        updated.last_run_error = Some(error_message);
        updated.set_updated_at_utc(now);
        // Round 4 / Issue 7 — pre-flight terminals are exactly the
        // failure modes the user needs to act on, so mark the task as
        // needing attention. The reason matches the terminal status
        // so the UI tooltip can render an actionable hint.
        let reason_label = match &terminal_status {
            LastRunStatus::AuthRequired => "auth_required",
            LastRunStatus::MissingIntegration => "missing_integration",
            _ => "preflight_failed",
        };
        updated.needs_attention = true;
        updated.needs_attention_reason = Some(reason_label.to_string());
        if updated.needs_attention_since.is_none() {
            updated.needs_attention_since = Some(format_utc_timestamp(now));
        }
        updated.record_terminal_run(
            Uuid::new_v4().to_string(),
            None,
            now,
            LastRunTrigger::Scheduled,
            terminal_status,
            None,
            updated.last_run_error.clone(),
            None,
            Some(reason_label.to_string()),
        );
        advance_schedule_or_disable(&mut updated, now);
        self.store.save_task(&updated)
    }

    /// A one-off task whose `run_at` expired beyond the catch-up window:
    /// record a missed terminal (with attention) and disable it.
    async fn handle_missed_once(
        self: &Arc<Self>,
        mut task: ScheduledTask,
        now: DateTime<Utc>,
    ) -> Result<()> {
        mark_once_task_missed(&mut task, now)?;
        warn!(
            task_id = %task.id,
            scheduled_at = ?task.last_run_at,
            "One-off scheduled task expired unrun; recording missed and disabling",
        );
        self.store.save_task(&task)
    }

    fn spawn_await(self: &Arc<Self>, task_id: String, run: CurrentRun) -> JoinHandle<()> {
        let executor = Arc::clone(self);
        tokio::spawn(async move {
            if let Err(error) = executor.run_to_completion(&task_id, &run).await {
                error!(task_id = %task_id, ?error, "Run completion handling failed");
            }
            executor.unmark_active(&task_id).await;
        })
    }

    async fn run_to_completion(self: &Arc<Self>, task_id: &str, run: &CurrentRun) -> Result<()> {
        let task = match self.store.get_task(task_id) {
            Ok(task) => task,
            Err(error) => {
                warn!(task_id = %task_id, ?error, "Task vanished before await; treating run as Failed");
                let now = Utc::now();
                let _ = self
                    .store
                    .clear_current_run_and_record_result(
                        task_id,
                        &run.run_id,
                        TerminalRunResult {
                            status: LastRunStatus::Failed,
                            chat_id: Some(run.chat_id.clone()),
                            error: Some(error.to_string()),
                            response_preview: None,
                            consume_schedule: matches!(run.trigger, LastRunTrigger::Scheduled),
                        },
                        now,
                    )
                    .await;
                return Ok(());
            }
        };
        let remembered_token = get_remembered_run_token(&run.run_id);
        let result = self
            .runner
            .await_completion(&task, &run.chat_id, remembered_token.as_deref())
            .await;
        let now = Utc::now();
        let cancelled = was_run_cancelled(&run.run_id);
        let consume_schedule = matches!(run.trigger, LastRunTrigger::Scheduled);

        let terminal = match result {
            Ok(execution) => TerminalRunResult {
                status: classify_terminal_status(&execution, cancelled),
                chat_id: if execution.chat_id.is_empty() {
                    Some(run.chat_id.clone())
                } else {
                    Some(execution.chat_id)
                },
                error: execution.error,
                response_preview: if execution.response_preview.is_empty() {
                    None
                } else {
                    Some(execution.response_preview)
                },
                consume_schedule,
            },
            Err(error) => TerminalRunResult {
                status: if cancelled {
                    LastRunStatus::Cancelled
                } else {
                    LastRunStatus::Failed
                },
                chat_id: Some(run.chat_id.clone()),
                error: Some(error.to_string()),
                response_preview: None,
                consume_schedule,
            },
        };

        let terminal_status = terminal.status.clone();
        let terminal_error = terminal.error.clone();
        match self
            .store
            .clear_current_run_and_record_result(task_id, &run.run_id, terminal, now)
            .await?
        {
            ClearCurrentRunOutcome::Cleared => match terminal_status {
                LastRunStatus::Success => {
                    info!(
                        task_id = %task_id,
                        run_id = %run.run_id,
                        chat_id = %run.chat_id,
                        "Scheduled run finished: success",
                    );
                }
                status => {
                    warn!(
                        task_id = %task_id,
                        run_id = %run.run_id,
                        chat_id = %run.chat_id,
                        status = ?status,
                        error = ?terminal_error,
                        "Scheduled run finished with non-success status",
                    );
                }
            },
            ClearCurrentRunOutcome::AlreadyCleared
            | ClearCurrentRunOutcome::RunIdMismatch { .. }
            | ClearCurrentRunOutcome::TaskNotFound => {
                warn!(
                    task_id = %task_id,
                    run_id = %run.run_id,
                    "clear_current_run_and_record_result returned a non-cleared outcome",
                );
            }
        }
        forget_remembered_run_token(&run.run_id);
        forget_scheduled_run_verdict(&run.run_id);
        Ok(())
    }
}

fn classify_terminal_status(
    execution: &crate::runtime::TaskExecutionResult,
    cancelled_marker: bool,
) -> LastRunStatus {
    if execution.finalizer_required {
        if cancelled_marker {
            return LastRunStatus::Cancelled;
        }
        return match execution.verdict.as_ref().map(|verdict| &verdict.status) {
            Some(ScheduledRunVerdictStatus::Success) if execution.success => LastRunStatus::Success,
            _ => LastRunStatus::Failed,
        };
    }
    if execution.success {
        return LastRunStatus::Success;
    }
    if cancelled_marker {
        return LastRunStatus::Cancelled;
    }
    if execution
        .error
        .as_deref()
        .map(|message| {
            let lowered = message.to_ascii_lowercase();
            lowered.contains("cancel")
        })
        .unwrap_or(false)
    {
        return LastRunStatus::Cancelled;
    }
    LastRunStatus::Failed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ScheduleKind, ScheduledTask, TaskSchedule};
    use crate::runtime::{
        ScheduledRunVerdict, ScheduledRunVerdictStatus, StartedRunHandle, TaskExecutionResult,
    };
    use crate::storage::{make_current_run, TaskFileStore};
    use core_mcp_shared::{reset_test_redis_state, TEST_ENV_LOCK};
    use std::env;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex, MutexGuard};
    use tokio::time::sleep;

    struct EnvGuard {
        _guard: MutexGuard<'static, ()>,
        root: PathBuf,
        previous_app_support_dir: Option<String>,
        previous_test_redis: Option<String>,
        previous_scheduler_bridge_status_url: Option<String>,
        previous_scheduler_bridge_status_token: Option<String>,
    }

    impl EnvGuard {
        fn new(name: &str) -> Self {
            let guard = TEST_ENV_LOCK
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            let root = env::temp_dir().join(format!(
                "scheduling-executor-{name}-{}",
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&root).unwrap();
            let previous_app_support_dir = env::var("PORTICO_APP_SUPPORT_DIR").ok();
            let previous_test_redis = env::var("CORE_MCP_TEST_REDIS").ok();
            let previous_scheduler_bridge_status_url =
                env::var("portico_SCHEDULER_BRIDGE_STATUS_URL").ok();
            let previous_scheduler_bridge_status_token =
                env::var("portico_SCHEDULER_BRIDGE_STATUS_TOKEN").ok();
            env::remove_var("portico_SCHEDULER_BRIDGE_STATUS_URL");
            env::remove_var("portico_SCHEDULER_BRIDGE_STATUS_TOKEN");
            env::set_var("PORTICO_APP_SUPPORT_DIR", root.join("app-support"));
            env::set_var("CORE_MCP_TEST_REDIS", "memory");
            reset_test_redis_state();
            Self {
                _guard: guard,
                root,
                previous_app_support_dir,
                previous_test_redis,
                previous_scheduler_bridge_status_url,
                previous_scheduler_bridge_status_token,
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
            if let Some(value) = &self.previous_scheduler_bridge_status_url {
                env::set_var("portico_SCHEDULER_BRIDGE_STATUS_URL", value);
            } else {
                env::remove_var("portico_SCHEDULER_BRIDGE_STATUS_URL");
            }
            if let Some(value) = &self.previous_scheduler_bridge_status_token {
                env::set_var("portico_SCHEDULER_BRIDGE_STATUS_TOKEN", value);
            } else {
                env::remove_var("portico_SCHEDULER_BRIDGE_STATUS_TOKEN");
            }
            reset_test_redis_state();
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn cron_task(id: &str, next_run_at: &str) -> ScheduledTask {
        ScheduledTask {
            id: id.to_string(),
            name: "Scheduled work".to_string(),
            prompt: "do work".to_string(),
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

    #[derive(Clone, Default)]
    struct ScriptedRunner {
        outcomes: Arc<Mutex<std::collections::HashMap<String, TaskExecutionResult>>>,
        await_calls: Arc<Mutex<Vec<(String, String, Option<String>)>>>,
        start_calls: Arc<Mutex<Vec<String>>>,
        await_delay: Duration,
    }

    impl ScriptedRunner {
        fn with_outcome(task_id: &str, chat_id: &str, response: &str, success: bool) -> Self {
            let runner = Self::default();
            runner.outcomes.lock().unwrap().insert(
                task_id.to_string(),
                TaskExecutionResult {
                    chat_id: chat_id.to_string(),
                    response_preview: response.to_string(),
                    success,
                    error: None,
                    finalizer_required: false,
                    verdict: None,
                },
            );
            runner
        }

        fn await_calls(&self) -> Vec<(String, String, Option<String>)> {
            self.await_calls.lock().unwrap().clone()
        }
    }

    #[async_trait::async_trait]
    impl TaskRunner for ScriptedRunner {
        async fn start_run(&self, task: &ScheduledTask) -> Result<StartedRunHandle> {
            self.start_calls.lock().unwrap().push(task.id.clone());
            let outcome = self
                .outcomes
                .lock()
                .unwrap()
                .get(&task.id)
                .cloned()
                .unwrap_or(TaskExecutionResult {
                    chat_id: format!("chat-{}", task.id),
                    response_preview: format!("response-{}", task.id),
                    success: true,
                    error: None,
                    finalizer_required: false,
                    verdict: None,
                });
            Ok(StartedRunHandle {
                chat_id: outcome.chat_id,
                token: format!("token-{}", task.id),
            })
        }

        async fn await_completion(
            &self,
            task: &ScheduledTask,
            chat_id: &str,
            run_token: Option<&str>,
        ) -> Result<TaskExecutionResult> {
            self.await_calls.lock().unwrap().push((
                task.id.clone(),
                chat_id.to_string(),
                run_token.map(str::to_string),
            ));
            if !self.await_delay.is_zero() {
                sleep(self.await_delay).await;
            }
            let outcome = self
                .outcomes
                .lock()
                .unwrap()
                .get(&task.id)
                .cloned()
                .unwrap_or(TaskExecutionResult {
                    chat_id: chat_id.to_string(),
                    response_preview: format!("response-{}", task.id),
                    success: true,
                    error: None,
                    finalizer_required: false,
                    verdict: None,
                });
            Ok(outcome)
        }
    }

    fn now_at(raw: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(raw)
            .unwrap()
            .with_timezone(&Utc)
    }

    fn finalized_execution(
        status: Option<ScheduledRunVerdictStatus>,
        success: bool,
    ) -> TaskExecutionResult {
        TaskExecutionResult {
            chat_id: "chat-finalized".to_string(),
            response_preview: "done".to_string(),
            success,
            error: None,
            finalizer_required: true,
            verdict: status.map(|status| ScheduledRunVerdict {
                task_id: "task-finalized".to_string(),
                run_id: "run-finalized".to_string(),
                chat_id: "chat-finalized".to_string(),
                status,
                summary: "summary".to_string(),
                reason: None,
                finalized_at: "2026-04-01T12:00:00Z".to_string(),
            }),
        }
    }

    #[test]
    fn terminal_status_requires_success_finalizer_verdict() {
        assert_eq!(
            classify_terminal_status(
                &finalized_execution(Some(ScheduledRunVerdictStatus::Success), true),
                false,
            ),
            LastRunStatus::Success,
        );
        assert_eq!(
            classify_terminal_status(&finalized_execution(None, true), false),
            LastRunStatus::Failed,
        );
        assert_eq!(
            classify_terminal_status(
                &finalized_execution(Some(ScheduledRunVerdictStatus::Failed), true),
                false,
            ),
            LastRunStatus::Failed,
        );
        assert_eq!(
            classify_terminal_status(
                &finalized_execution(Some(ScheduledRunVerdictStatus::Success), false),
                false,
            ),
            LastRunStatus::Failed,
        );
    }

    #[tokio::test]
    async fn reconcile_orphans_re_attaches_an_in_flight_run_after_a_simulated_restart() {
        let _env = EnvGuard::new("reconcile-orphan");
        let store = TaskFileStore::new();
        let mut task = cron_task("orphan", "2026-04-01T11:00:00Z");
        task.current_run = Some(make_current_run(
            "chat-orphan",
            LastRunTrigger::Scheduled,
            now_at("2026-04-01T10:30:00Z"),
        ));
        store.save_task(&task).unwrap();

        let runner = ScriptedRunner::with_outcome("orphan", "chat-orphan", "done", true);
        let executor = Executor::with_started_at(
            TaskFileStore::new(),
            runner.clone(),
            Duration::from_millis(50),
            now_at("2026-04-01T10:30:00Z"),
        );
        executor.reconcile_orphans().await.unwrap();
        // Wait for the spawned await to settle.
        for _ in 0..50 {
            let updated = TaskFileStore::new().get_task("orphan").unwrap();
            if updated.current_run.is_none() {
                break;
            }
            sleep(Duration::from_millis(20)).await;
        }
        let updated = TaskFileStore::new().get_task("orphan").unwrap();
        assert!(updated.current_run.is_none());
        assert_eq!(updated.last_run_status, Some(LastRunStatus::Success));
        assert_eq!(updated.last_run_chat_id.as_deref(), Some("chat-orphan"));
        assert!(runner
            .await_calls()
            .iter()
            .any(|(task_id, chat_id, _)| task_id == "orphan" && chat_id == "chat-orphan"));
    }

    #[tokio::test]
    async fn handle_signal_start_spawns_await_only_when_run_id_matches_disk_state() {
        let _env = EnvGuard::new("signal-start");
        let store = TaskFileStore::new();
        let mut task = cron_task("signal-task", "2026-04-01T11:00:00Z");
        let claim = make_current_run(
            "chat-signal",
            LastRunTrigger::Manual,
            now_at("2026-04-01T10:30:00Z"),
        );
        task.current_run = Some(claim.clone());
        store.save_task(&task).unwrap();

        let runner = ScriptedRunner::with_outcome("signal-task", "chat-signal", "done", true);
        let executor = Executor::with_started_at(
            TaskFileStore::new(),
            runner.clone(),
            Duration::from_millis(50),
            now_at("2026-04-01T10:30:00Z"),
        );

        executor
            .handle_signal(RunSignal::Start {
                task_id: "signal-task".to_string(),
                run_id: "stale-run".to_string(),
            })
            .await
            .unwrap();
        sleep(Duration::from_millis(20)).await;
        assert!(
            runner.await_calls().is_empty(),
            "stale run id must not spawn"
        );

        executor
            .handle_signal(RunSignal::Start {
                task_id: "signal-task".to_string(),
                run_id: claim.run_id.clone(),
            })
            .await
            .unwrap();
        for _ in 0..50 {
            if !runner.await_calls().is_empty() {
                break;
            }
            sleep(Duration::from_millis(20)).await;
        }
        for _ in 0..50 {
            let updated = TaskFileStore::new().get_task("signal-task").unwrap();
            if updated.current_run.is_none() {
                break;
            }
            sleep(Duration::from_millis(20)).await;
        }
        let updated = TaskFileStore::new().get_task("signal-task").unwrap();
        assert!(updated.current_run.is_none());
        assert_eq!(updated.last_run_status, Some(LastRunStatus::Success));
    }

    #[tokio::test]
    async fn handle_signal_cancel_marks_cancellation_and_terminal_status_becomes_cancelled() {
        let _env = EnvGuard::new("signal-cancel");
        let store = TaskFileStore::new();
        let mut task = cron_task("cancel-task", "2026-04-01T11:00:00Z");
        let claim = make_current_run(
            "chat-cancel",
            LastRunTrigger::Manual,
            now_at("2026-04-01T10:30:00Z"),
        );
        task.current_run = Some(claim.clone());
        store.save_task(&task).unwrap();

        let runner = ScriptedRunner::with_outcome("cancel-task", "chat-cancel", "", false);
        runner
            .outcomes
            .lock()
            .unwrap()
            .get_mut("cancel-task")
            .unwrap()
            .error = Some("polling cancelled by user".to_string());

        let executor = Executor::with_started_at(
            TaskFileStore::new(),
            runner.clone(),
            Duration::from_millis(50),
            now_at("2026-04-01T10:30:00Z"),
        );
        executor
            .handle_signal(RunSignal::Cancel {
                task_id: "cancel-task".to_string(),
                run_id: claim.run_id.clone(),
            })
            .await
            .unwrap();
        assert!(was_run_cancelled(&claim.run_id));

        executor.reconcile_orphans().await.unwrap();
        for _ in 0..50 {
            let updated = TaskFileStore::new().get_task("cancel-task").unwrap();
            if updated.current_run.is_none() {
                break;
            }
            sleep(Duration::from_millis(20)).await;
        }
        let updated = TaskFileStore::new().get_task("cancel-task").unwrap();
        assert_eq!(updated.last_run_status, Some(LastRunStatus::Cancelled));
        assert!(updated.current_run.is_none());
    }

    #[tokio::test]
    async fn scheduled_sweep_starts_due_task_and_records_success_when_polling_completes() {
        let _env = EnvGuard::new("sweep-due");
        let store = TaskFileStore::new();
        store
            .save_task(&cron_task("scheduled-task", "2026-04-01T11:00:00Z"))
            .unwrap();

        let runner =
            ScriptedRunner::with_outcome("scheduled-task", "chat-scheduled", "all done", true);
        let executor = Executor::with_started_at(
            TaskFileStore::new(),
            runner.clone(),
            Duration::from_millis(50),
            now_at("2026-04-01T10:00:00Z"),
        );
        executor
            .scheduled_sweep(now_at("2026-04-01T12:00:00Z"))
            .await
            .unwrap();
        for _ in 0..50 {
            let updated = TaskFileStore::new().get_task("scheduled-task").unwrap();
            if updated.last_run_status.is_some() && updated.current_run.is_none() {
                break;
            }
            sleep(Duration::from_millis(20)).await;
        }
        let updated = TaskFileStore::new().get_task("scheduled-task").unwrap();
        assert_eq!(updated.last_run_status, Some(LastRunStatus::Success));
        assert_eq!(updated.last_run_chat_id.as_deref(), Some("chat-scheduled"));
        assert!(runner
            .await_calls()
            .iter()
            .any(|(task_id, chat_id, token)| task_id == "scheduled-task"
                && chat_id == "chat-scheduled"
                && token.as_deref() == Some("token-scheduled-task")));
        // Schedule was consumed: cron next_run_at moved forward from the
        // original "2026-04-01T11:00:00Z" anchor (specific value depends on
        // the wall clock observed by `run_to_completion`).
        assert!(updated.next_run_at.is_some());
        assert_ne!(updated.next_run_at.as_deref(), Some("2026-04-01T11:00:00Z"));
        assert!(updated.current_run.is_none());
    }

    // -----------------------------------------------------------------------
    // Phase 2: pre-flight integration guardrail.
    //
    // The full preflight reads from the workspace's real mcp-configs
    // directory (via app_root()) — fine for these tests because we
    // pick id values guaranteed NOT to exist in any reasonable
    // checkout (UUID-based names). The skill-side instruction to
    // healthcheck before scheduling_create_task is verified
    // structurally in tests/test_skills_scheduled_tasks_skill.py.
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn scheduled_sweep_aborts_run_with_missing_integration_when_tool_server_id_is_offline() {
        let _env = EnvGuard::new("preflight-missing");
        let store = TaskFileStore::new();
        let mut task = cron_task("preflight-task", "2026-04-01T11:00:00Z");
        // Use a UUID-tagged id so the preflight definitely won't find
        // a real config dir matching it.
        task.tool_server_ids = vec![format!("nonexistent-{}", uuid::Uuid::new_v4().simple())];
        store.save_task(&task).unwrap();

        let runner = ScriptedRunner::with_outcome(
            "preflight-task",
            "chat-preflight",
            "should never run",
            true,
        );
        let executor = Executor::with_started_at(
            TaskFileStore::new(),
            runner.clone(),
            Duration::from_millis(50),
            now_at("2026-04-01T10:00:00Z"),
        );
        executor
            .scheduled_sweep(now_at("2026-04-01T12:00:00Z"))
            .await
            .unwrap();
        for _ in 0..50 {
            let updated = TaskFileStore::new().get_task("preflight-task").unwrap();
            if updated.last_run_status.is_some() {
                break;
            }
            sleep(Duration::from_millis(20)).await;
        }
        let updated = TaskFileStore::new().get_task("preflight-task").unwrap();
        // Terminal status MUST be MissingIntegration, NOT Failed —
        // the user/operator UI distinguishes them so they can act on
        // a missing integration without re-debugging a "regular"
        // failure.
        assert_eq!(
            updated.last_run_status,
            Some(LastRunStatus::MissingIntegration)
        );
        // Runner MUST NOT have been called: the preflight guards
        // happen BEFORE claim_and_start_run reaches start_run.
        assert!(
            runner.start_calls.lock().unwrap().is_empty(),
            "preflight must short-circuit before starting a chat",
        );
        assert!(updated.current_run.is_none());
        // Cron schedule advanced past the missed occurrence so we
        // don't immediately retry on the next sweep.
        assert!(updated.next_run_at.is_some());
        assert_ne!(updated.next_run_at.as_deref(), Some("2026-04-01T11:00:00Z"));
        // Error message names the offending integration so the user
        // can act on it.
        let error = updated.last_run_error.expect("error message recorded");
        assert!(error.contains("nonexistent-"));
        assert!(error.contains("not installed"));
    }

    #[tokio::test]
    async fn scheduled_sweep_defers_run_without_burning_occurrence_when_bridge_is_not_ready() {
        let _env = EnvGuard::new("bridge-not-ready");
        env::set_var(
            "portico_SCHEDULER_BRIDGE_STATUS_URL",
            "http://127.0.0.1:9/bridge/status",
        );
        env::set_var("portico_SCHEDULER_BRIDGE_STATUS_TOKEN", "status-token");
        let store = TaskFileStore::new();
        let task = cron_task("bridge-task", "2026-04-01T11:00:00Z");
        store.save_task(&task).unwrap();

        let runner =
            ScriptedRunner::with_outcome("bridge-task", "chat-bridge", "runs after recovery", true);
        let executor = Executor::with_started_at(
            TaskFileStore::new(),
            runner.clone(),
            Duration::from_millis(50),
            now_at("2026-04-01T10:00:00Z"),
        );

        // Two sweeps with the bridge down: the occurrence is deferred, not
        // recorded as a missed terminal, and next_run_at stays armed.
        for _ in 0..2 {
            executor
                .scheduled_sweep(now_at("2026-04-01T12:00:00Z"))
                .await
                .unwrap();
            let updated = TaskFileStore::new().get_task("bridge-task").unwrap();
            assert_eq!(updated.last_run_status, None);
            assert!(updated.last_run_error.is_none());
            assert!(updated.current_run.is_none());
            assert!(!updated.needs_attention);
            assert_eq!(updated.next_run_at.as_deref(), Some("2026-04-01T11:00:00Z"));
            assert!(
                runner.start_calls.lock().unwrap().is_empty(),
                "bridge readiness must short-circuit before starting a chat",
            );
        }

        // Bridge recovers (test default readiness is ready when the env
        // knobs are absent): the deferred occurrence now runs.
        env::remove_var("portico_SCHEDULER_BRIDGE_STATUS_URL");
        env::remove_var("portico_SCHEDULER_BRIDGE_STATUS_TOKEN");
        executor
            .scheduled_sweep(now_at("2026-04-01T12:00:30Z"))
            .await
            .unwrap();
        for _ in 0..50 {
            let updated = TaskFileStore::new().get_task("bridge-task").unwrap();
            if updated.last_run_status.is_some() && updated.current_run.is_none() {
                break;
            }
            sleep(Duration::from_millis(20)).await;
        }
        let updated = TaskFileStore::new().get_task("bridge-task").unwrap();
        assert_eq!(updated.last_run_status, Some(LastRunStatus::Success));
        assert_eq!(updated.last_run_chat_id.as_deref(), Some("chat-bridge"));
        assert_ne!(updated.next_run_at.as_deref(), Some("2026-04-01T11:00:00Z"));
    }

    #[tokio::test]
    async fn scheduled_sweep_catches_up_superseded_task_with_one_run_and_missed_history() {
        let _env = EnvGuard::new("sweep-catch-up");
        let store = TaskFileStore::new();
        // Armed three days before the sweep: two occurrences superseded,
        // the most recent (today 09:00) runs.
        store
            .save_task(&cron_task("catch-up-task", "2026-03-30T09:00:00Z"))
            .unwrap();

        let runner = ScriptedRunner::with_outcome("catch-up-task", "chat-catch-up", "done", true);
        let executor = Executor::with_started_at(
            TaskFileStore::new(),
            runner.clone(),
            Duration::from_millis(50),
            now_at("2026-04-01T11:55:00Z"),
        );
        executor
            .scheduled_sweep(now_at("2026-04-01T12:00:00Z"))
            .await
            .unwrap();
        for _ in 0..50 {
            let updated = TaskFileStore::new().get_task("catch-up-task").unwrap();
            if updated.last_run_status == Some(LastRunStatus::Success)
                && updated.current_run.is_none()
            {
                break;
            }
            sleep(Duration::from_millis(20)).await;
        }
        let updated = TaskFileStore::new().get_task("catch-up-task").unwrap();
        assert_eq!(updated.last_run_status, Some(LastRunStatus::Success));
        assert!(!updated.needs_attention, "success clears attention");
        assert!(runner
            .await_calls()
            .iter()
            .any(|(task_id, chat_id, _)| task_id == "catch-up-task" && chat_id == "chat-catch-up"));
        let missed_row = updated
            .runs
            .iter()
            .find(|run| run.status == Some(LastRunStatus::Missed))
            .expect("superseded occurrences recorded in run history");
        assert!(missed_row
            .error
            .as_deref()
            .unwrap_or_default()
            .starts_with("Skipped 2 scheduled runs starting at 2026-03-30 09:00 UTC"));
        // Cron advanced past the sweep instant after the catch-up run.
        assert!(updated.next_run_at.as_deref() > Some("2026-04-01T12:00:00Z"));
    }

    #[tokio::test]
    async fn scheduled_sweep_throttles_catch_up_launches_to_one_per_sweep() {
        let _env = EnvGuard::new("catch-up-throttle");
        let store = TaskFileStore::new();
        // Three tasks all overdue (came due while the daemon was down).
        for id in ["throttle-a", "throttle-b", "throttle-c"] {
            store
                .save_task(&cron_task(id, "2026-04-01T09:00:00Z"))
                .unwrap();
        }

        let runner = ScriptedRunner::default();
        let executor = Executor::with_started_at(
            TaskFileStore::new(),
            runner.clone(),
            Duration::from_millis(50),
            now_at("2026-04-01T11:55:00Z"),
        );

        executor
            .scheduled_sweep(now_at("2026-04-01T12:00:00Z"))
            .await
            .unwrap();
        for _ in 0..50 {
            if TaskFileStore::new()
                .get_task("throttle-a")
                .unwrap()
                .current_run
                .is_none()
                && !runner.start_calls.lock().unwrap().is_empty()
            {
                break;
            }
            sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(
            runner.start_calls.lock().unwrap().clone(),
            vec!["throttle-a".to_string()],
            "only one catch-up run may launch per sweep",
        );

        // Subsequent sweeps drain the backlog one task per tick.
        executor
            .scheduled_sweep(now_at("2026-04-01T12:00:30Z"))
            .await
            .unwrap();
        for _ in 0..50 {
            if runner.start_calls.lock().unwrap().len() >= 2 {
                break;
            }
            sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(
            runner.start_calls.lock().unwrap().clone(),
            vec!["throttle-a".to_string(), "throttle-b".to_string()],
        );
    }

    #[tokio::test]
    async fn scheduled_sweep_leaves_tasks_with_in_flight_runs_untouched() {
        let _env = EnvGuard::new("in-flight-guard");
        let store = TaskFileStore::new();
        // Task looks superseded on disk, but a run is in flight (e.g.
        // re-attached after a daemon restart). The sweep must not stamp
        // missed rows, re-arm, or double-start underneath it.
        let mut task = cron_task("in-flight", "2026-03-30T09:00:00Z");
        task.current_run = Some(make_current_run(
            "chat-in-flight",
            LastRunTrigger::Scheduled,
            now_at("2026-03-30T09:00:10Z"),
        ));
        store.save_task(&task).unwrap();

        let runner = ScriptedRunner::default();
        let executor = Executor::with_started_at(
            TaskFileStore::new(),
            runner.clone(),
            Duration::from_millis(50),
            now_at("2026-04-01T11:55:00Z"),
        );
        executor
            .scheduled_sweep(now_at("2026-04-01T12:00:00Z"))
            .await
            .unwrap();

        let updated = TaskFileStore::new().get_task("in-flight").unwrap();
        assert!(runner.start_calls.lock().unwrap().is_empty());
        assert_eq!(updated.last_run_status, None);
        assert!(updated.runs.iter().all(|run| run.status.is_none()));
        assert_eq!(updated.next_run_at.as_deref(), Some("2026-03-30T09:00:00Z"));
        assert!(updated.current_run.is_some());
    }

    #[tokio::test]
    async fn scheduled_sweep_contains_classification_failures_to_the_broken_task() {
        let _env = EnvGuard::new("classify-contained");
        let store = TaskFileStore::new();
        let mut broken = cron_task("broken-tz", "2026-04-01T09:00:00Z");
        broken.schedule.timezone = "Mars/Olympus".to_string();
        store.save_task(&broken).unwrap();
        store
            .save_task(&cron_task("healthy-task", "2026-04-01T11:00:00Z"))
            .unwrap();

        let runner = ScriptedRunner::with_outcome("healthy-task", "chat-healthy", "done", true);
        let executor = Executor::with_started_at(
            TaskFileStore::new(),
            runner.clone(),
            Duration::from_millis(50),
            now_at("2026-04-01T10:00:00Z"),
        );
        executor
            .scheduled_sweep(now_at("2026-04-01T12:00:00Z"))
            .await
            .unwrap();
        for _ in 0..50 {
            let updated = TaskFileStore::new().get_task("healthy-task").unwrap();
            if updated.last_run_status.is_some() && updated.current_run.is_none() {
                break;
            }
            sleep(Duration::from_millis(20)).await;
        }
        // The healthy task still ran despite the broken sibling.
        let healthy = TaskFileStore::new().get_task("healthy-task").unwrap();
        assert_eq!(healthy.last_run_status, Some(LastRunStatus::Success));
        // The broken task was skipped, not terminalized.
        let broken = TaskFileStore::new().get_task("broken-tz").unwrap();
        assert_eq!(broken.last_run_status, None);
    }
}
