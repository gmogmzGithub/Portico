use crate::model::{format_utc_timestamp, CurrentRun, LastRunStatus, ScheduledTask};
use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use core_mcp_shared::{
    read_json_file, redis_compare_delete, redis_set_nx_ex_string, safe_path_component,
    scheduled_tasks_dir, write_json_atomic,
};
use std::fs;
use std::path::PathBuf;
use std::time::Duration;
use tracing::warn;
use uuid::Uuid;

// TTL is intentionally generous because callers may hold the lock across an
// async `start_run` call that posts to upstream OWUI (`/api/chat/completions`),
// which routinely takes several seconds.
const RUN_CLAIM_LOCK_TTL_SECONDS: u64 = 60;
const RUN_CLAIM_LOCK_WAIT_MS: u64 = 5_000;
const RUN_CLAIM_LOCK_POLL_MS: u64 = 25;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SetCurrentRunOutcome {
    Claimed,
    AlreadyClaimedSame { existing: CurrentRun },
    Conflict { existing: CurrentRun },
    TaskNotFound,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClearCurrentRunOutcome {
    Cleared,
    AlreadyCleared,
    RunIdMismatch { existing: CurrentRun },
    TaskNotFound,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerminalRunResult {
    pub status: LastRunStatus,
    pub chat_id: Option<String>,
    pub error: Option<String>,
    pub response_preview: Option<String>,
    pub consume_schedule: bool,
}

#[derive(Clone, Debug, Default)]
pub struct TaskFileStore;

impl TaskFileStore {
    pub fn new() -> Self {
        Self
    }

    pub fn list_tasks(&self) -> Result<Vec<ScheduledTask>> {
        let dir = self.tasks_dir()?;
        let mut tasks = Vec::new();

        let mut entries = fs::read_dir(&dir)
            .with_context(|| format!("failed to list {}", dir.display()))?
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| {
                entry
                    .file_type()
                    .ok()
                    .filter(|kind| kind.is_file())
                    .map(|_| entry.path())
            })
            .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
            .collect::<Vec<_>>();
        entries.sort();

        for path in entries {
            match read_json_file(&path).and_then(|value| {
                serde_json::from_value::<ScheduledTask>(value).map_err(Into::into)
            }) {
                Ok(task) => tasks.push(task),
                Err(error) => warn!(
                    "Skipping invalid scheduled task file {}: {error}",
                    path.display()
                ),
            }
        }

        tasks.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(tasks)
    }

    pub fn get_task(&self, task_id: &str) -> Result<ScheduledTask> {
        let path = self.task_path(task_id)?;
        let value = read_json_file(&path)?;
        serde_json::from_value(value)
            .with_context(|| format!("failed to decode scheduled task {}", path.display()))
    }

    pub fn save_task(&self, task: &ScheduledTask) -> Result<()> {
        let path = self.task_path(&task.id)?;
        let value = serde_json::to_value(task).context("failed to encode scheduled task JSON")?;
        write_json_atomic(&path, &value)
    }

    pub fn delete_task(&self, task_id: &str) -> Result<()> {
        let path = self.task_path(task_id)?;
        if !path.exists() {
            bail!("Scheduled task '{}' not found", task_id);
        }
        fs::remove_file(&path)
            .with_context(|| format!("failed to delete scheduled task {}", path.display()))
    }

    fn tasks_dir(&self) -> Result<PathBuf> {
        let dir = scheduled_tasks_dir()?;
        fs::create_dir_all(&dir)
            .with_context(|| format!("failed to create scheduled tasks dir {}", dir.display()))?;
        Ok(dir)
    }

    fn task_path(&self, task_id: &str) -> Result<PathBuf> {
        let normalized = validate_task_id(task_id)?;
        Ok(self.tasks_dir()?.join(format!("{normalized}.json")))
    }

    /// Atomically claim `current_run` for `task_id`.
    ///
    /// Idempotent: if the same `run_id` is already claimed, returns
    /// `AlreadyClaimedSame` so the caller can return the existing handle.
    /// Conflict: a different run is in flight; the caller must abort.
    pub async fn try_set_current_run(
        &self,
        task_id: &str,
        candidate: CurrentRun,
        now: DateTime<Utc>,
    ) -> Result<SetCurrentRunOutcome> {
        let _guard = TaskClaimLockGuard::acquire(task_id).await?;
        let mut task = match self.get_task(task_id) {
            Ok(task) => task,
            Err(_) => return Ok(SetCurrentRunOutcome::TaskNotFound),
        };
        if let Some(existing) = task.current_run.clone() {
            if existing.run_id == candidate.run_id {
                return Ok(SetCurrentRunOutcome::AlreadyClaimedSame { existing });
            }
            return Ok(SetCurrentRunOutcome::Conflict { existing });
        }
        task.record_started_run(&candidate);
        task.current_run = Some(candidate);
        task.set_updated_at_utc(now);
        self.save_task(&task)?;
        Ok(SetCurrentRunOutcome::Claimed)
    }

    /// Clear `current_run` and record the terminal `last_run_*` fields.
    ///
    /// Only clears if the persisted run_id matches `expected_run_id`.
    /// Optionally advances the schedule (cron) or disables the task (once)
    /// when `result.consume_schedule` is true.
    pub async fn clear_current_run_and_record_result(
        &self,
        task_id: &str,
        expected_run_id: &str,
        result: TerminalRunResult,
        now: DateTime<Utc>,
    ) -> Result<ClearCurrentRunOutcome> {
        let _guard = TaskClaimLockGuard::acquire(task_id).await?;
        let mut task = match self.get_task(task_id) {
            Ok(task) => task,
            Err(_) => return Ok(ClearCurrentRunOutcome::TaskNotFound),
        };
        let current_run = match task.current_run.clone() {
            Some(existing) if existing.run_id == expected_run_id => existing,
            Some(other) => return Ok(ClearCurrentRunOutcome::RunIdMismatch { existing: other }),
            None => return Ok(ClearCurrentRunOutcome::AlreadyCleared),
        };
        let trigger = current_run.trigger.clone();

        task.set_last_run_at_utc(Some(now));
        let final_status = result.status.clone();
        let chat_id = result.chat_id.clone();
        let error = result.error.clone();
        let response_preview = result.response_preview.clone();
        task.last_run_status = Some(result.status);
        task.last_run_chat_id = result.chat_id.clone();
        task.last_run_error = result.error.clone();
        task.last_run_response_preview = result.response_preview.clone();
        task.last_run_trigger = Some(trigger.clone());
        task.current_run = None;
        task.set_updated_at_utc(now);

        let attention_reason = match final_status {
            LastRunStatus::Success | LastRunStatus::Cancelled => {
                task.needs_attention = false;
                task.needs_attention_reason = None;
                task.needs_attention_since = None;
                None
            }
            LastRunStatus::AuthRequired => {
                task.needs_attention = true;
                task.needs_attention_reason = Some("auth_required".to_string());
                if task.needs_attention_since.is_none() {
                    task.needs_attention_since = Some(format_utc_timestamp(now));
                }
                Some("auth_required".to_string())
            }
            LastRunStatus::MissingIntegration => {
                task.needs_attention = true;
                task.needs_attention_reason = Some("missing_integration".to_string());
                if task.needs_attention_since.is_none() {
                    task.needs_attention_since = Some(format_utc_timestamp(now));
                }
                Some("missing_integration".to_string())
            }
            LastRunStatus::Failed | LastRunStatus::Missed | LastRunStatus::Interrupted => {
                task.needs_attention = true;
                task.needs_attention_reason = Some("run_failed".to_string());
                if task.needs_attention_since.is_none() {
                    task.needs_attention_since = Some(format_utc_timestamp(now));
                }
                Some("run_failed".to_string())
            }
        };
        task.record_terminal_run(
            expected_run_id,
            Some(current_run.started_at),
            now,
            trigger,
            final_status,
            chat_id,
            error,
            response_preview,
            attention_reason,
        );

        if result.consume_schedule {
            crate::runtime::advance_schedule_or_disable(&mut task, now);
        }

        self.save_task(&task)?;
        Ok(ClearCurrentRunOutcome::Cleared)
    }

    /// Round 4 / Issue 7 — clear the sticky ``needs_attention`` flag.
    /// Idempotent: a no-op if the flag is already cleared. Called
    /// when the user opens the task's last-run chat (the UI emits a
    /// "saw it" hook) or when a subsequent successful run wraps up.
    /// Returns ``true`` if the on-disk task was actually mutated.
    pub fn clear_needs_attention(&self, task_id: &str) -> Result<bool> {
        let mut task = self.get_task(task_id)?;
        if !task.needs_attention
            && task.needs_attention_reason.is_none()
            && task.needs_attention_since.is_none()
        {
            return Ok(false);
        }
        task.needs_attention = false;
        task.needs_attention_reason = None;
        task.needs_attention_since = None;
        self.save_task(&task)?;
        Ok(true)
    }
}

fn run_claim_lock_key(task_id: &str) -> String {
    format!("scheduling_run_claim:{task_id}")
}

struct TaskClaimLockGuard {
    key: String,
    token: String,
    released: bool,
}

impl TaskClaimLockGuard {
    async fn acquire(task_id: &str) -> Result<Self> {
        let key = run_claim_lock_key(task_id);
        let token = Uuid::new_v4().to_string();
        let started = std::time::Instant::now();
        loop {
            if redis_set_nx_ex_string(&key, &token, RUN_CLAIM_LOCK_TTL_SECONDS)? {
                return Ok(Self {
                    key,
                    token,
                    released: false,
                });
            }
            if started.elapsed() >= Duration::from_millis(RUN_CLAIM_LOCK_WAIT_MS) {
                bail!("timed out acquiring scheduling run claim lock for {task_id}");
            }
            tokio::time::sleep(Duration::from_millis(RUN_CLAIM_LOCK_POLL_MS)).await;
        }
    }
}

impl Drop for TaskClaimLockGuard {
    fn drop(&mut self) {
        if self.released {
            return;
        }
        let _ = redis_compare_delete(&self.key, &self.token);
        self.released = true;
    }
}

/// Mint a new `CurrentRun` from the supplied chat id and trigger.
pub fn make_current_run(
    chat_id: impl Into<String>,
    trigger: crate::model::LastRunTrigger,
    now: DateTime<Utc>,
) -> CurrentRun {
    CurrentRun {
        run_id: Uuid::new_v4().to_string(),
        chat_id: chat_id.into(),
        started_at: format_utc_timestamp(now),
        trigger,
    }
}

/// Run `operation` while holding the per-task scheduling run-claim lock.
/// The lock serializes `current_run` writes across the scheduling-server
/// (manual `run_task_now`) and scheduling-daemon (scheduled sweeps).
///
/// Production callers may hold the lock across long async work (e.g.,
/// `start_run` posts to OWUI). The lock TTL is sized generously and
/// re-acquired on retry.
pub async fn with_task_claim_lock<F, Fut, T>(task_id: &str, operation: F) -> Result<T>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    let _guard = TaskClaimLockGuard::acquire(task_id).await?;
    operation().await
}

fn validate_task_id(task_id: &str) -> Result<String> {
    let normalized = safe_path_component(task_id);
    if normalized.is_empty() || normalized != task_id {
        bail!("Invalid scheduled task id '{}'", task_id);
    }
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        format_utc_timestamp, LastRunTrigger, ScheduleKind, ScheduledTask, TaskSchedule,
    };
    use chrono::Utc;
    use core_mcp_shared::{reset_test_redis_state, TEST_ENV_LOCK};
    use serde_json::Value;
    use std::env;
    use std::sync::MutexGuard;
    use uuid::Uuid;

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
                "scheduling-storage-{name}-{}",
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

    fn sample_task(id: &str) -> ScheduledTask {
        let now = Utc::now();
        ScheduledTask {
            id: id.to_string(),
            name: "Do the thing".to_string(),
            prompt: "Do the thing".to_string(),
            model_id: "GPT-5.4".to_string(),
            schedule: TaskSchedule {
                kind: ScheduleKind::Cron,
                cron_expression: Some("0 9 * * *".to_string()),
                run_at: None,
                timezone: "UTC".to_string(),
            },
            skill_ids: vec!["code-execution".to_string()],
            tool_server_ids: vec!["server:agent-vm".to_string()],
            enabled: true,
            created_at: format_utc_timestamp(now),
            updated_at: format_utc_timestamp(now),
            next_run_at: Some("2026-04-02T09:00:00Z".to_string()),
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
    fn task_file_store_round_trips_create_list_get_update_and_delete() {
        let _env = EnvGuard::new("round-trip");
        let store = TaskFileStore::new();
        let mut task = sample_task("task-a");

        store.save_task(&task).unwrap();
        assert_eq!(store.list_tasks().unwrap(), vec![task.clone()]);
        assert_eq!(store.get_task("task-a").unwrap(), task);

        task.prompt = "Do the updated thing".to_string();
        task.updated_at = "2026-04-03T00:00:00Z".to_string();
        store.save_task(&task).unwrap();
        assert_eq!(
            store.get_task("task-a").unwrap().prompt,
            "Do the updated thing"
        );

        store.delete_task("task-a").unwrap();
        assert!(store.list_tasks().unwrap().is_empty());
        assert!(store.get_task("task-a").is_err());
    }

    #[test]
    fn task_file_store_isolates_corrupt_json_and_ignores_extra_fields() {
        let _env = EnvGuard::new("corrupt-and-extra");
        let store = TaskFileStore::new();
        store.save_task(&sample_task("task-good")).unwrap();

        let dir = store.tasks_dir().unwrap();
        fs::write(dir.join("broken.json"), "{").unwrap();
        let mut extra = serde_json::to_value(sample_task("task-extra")).unwrap();
        extra.as_object_mut().unwrap().insert(
            "unknown_field".to_string(),
            Value::String("ignored".to_string()),
        );
        write_json_atomic(&dir.join("task-extra.json"), &extra).unwrap();

        let tasks = store.list_tasks().unwrap();
        assert_eq!(tasks.len(), 2);
        assert!(tasks.iter().any(|task| task.id == "task-good"));
        assert!(tasks.iter().any(|task| task.id == "task-extra"));
    }

    #[test]
    fn task_file_store_rejects_invalid_ids() {
        let _env = EnvGuard::new("invalid-id");
        let store = TaskFileStore::new();

        assert!(store.get_task("../escape").is_err());
        assert!(store.delete_task("../escape").is_err());
        assert!(store
            .save_task(&ScheduledTask {
                id: "../escape".to_string(),
                ..sample_task("task-safe")
            })
            .is_err());
    }

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-04-29T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    #[tokio::test]
    async fn try_set_current_run_claims_when_unclaimed_and_is_idempotent_for_same_run_id() {
        let _env = EnvGuard::new("cas-claim");
        let store = TaskFileStore::new();
        store.save_task(&sample_task("cas-task")).unwrap();

        let candidate = make_current_run("chat-1", LastRunTrigger::Manual, now());
        let outcome = store
            .try_set_current_run("cas-task", candidate.clone(), now())
            .await
            .unwrap();
        assert!(matches!(outcome, SetCurrentRunOutcome::Claimed));

        let stored = store.get_task("cas-task").unwrap();
        assert_eq!(stored.current_run.as_ref().unwrap().chat_id, "chat-1");
        assert_eq!(stored.runs.len(), 1);
        assert_eq!(stored.runs[0].run_id, candidate.run_id);
        assert_eq!(stored.runs[0].chat_id.as_deref(), Some("chat-1"));
        assert!(stored.runs[0].status.is_none());

        let again = store
            .try_set_current_run("cas-task", candidate.clone(), now())
            .await
            .unwrap();
        assert!(matches!(
            again,
            SetCurrentRunOutcome::AlreadyClaimedSame { existing } if existing.run_id == candidate.run_id
        ));
    }

    #[tokio::test]
    async fn try_set_current_run_reports_conflict_when_a_different_run_holds_claim() {
        let _env = EnvGuard::new("cas-conflict");
        let store = TaskFileStore::new();
        store.save_task(&sample_task("cas-task")).unwrap();

        let first = make_current_run("chat-1", LastRunTrigger::Manual, now());
        store
            .try_set_current_run("cas-task", first.clone(), now())
            .await
            .unwrap();

        let second = make_current_run("chat-2", LastRunTrigger::Scheduled, now());
        let outcome = store
            .try_set_current_run("cas-task", second, now())
            .await
            .unwrap();
        assert!(matches!(
            outcome,
            SetCurrentRunOutcome::Conflict { existing } if existing.run_id == first.run_id
        ));
    }

    #[tokio::test]
    async fn clear_current_run_records_terminal_status_and_consumes_schedule_for_cron() {
        let _env = EnvGuard::new("clear-cron");
        let store = TaskFileStore::new();
        let mut task = sample_task("cron-clear");
        task.next_run_at = Some("2026-04-29T09:00:00Z".to_string());
        store.save_task(&task).unwrap();

        let candidate = make_current_run("chat-1", LastRunTrigger::Scheduled, now());
        store
            .try_set_current_run("cron-clear", candidate.clone(), now())
            .await
            .unwrap();

        let outcome = store
            .clear_current_run_and_record_result(
                "cron-clear",
                &candidate.run_id,
                TerminalRunResult {
                    status: LastRunStatus::Success,
                    chat_id: Some("chat-1".to_string()),
                    error: None,
                    response_preview: Some("done".to_string()),
                    consume_schedule: true,
                },
                now(),
            )
            .await
            .unwrap();
        assert!(matches!(outcome, ClearCurrentRunOutcome::Cleared));

        let stored = store.get_task("cron-clear").unwrap();
        assert!(stored.current_run.is_none());
        assert_eq!(stored.last_run_status, Some(LastRunStatus::Success));
        assert_eq!(stored.last_run_chat_id.as_deref(), Some("chat-1"));
        assert_eq!(stored.last_run_response_preview.as_deref(), Some("done"));
        assert!(stored.next_run_at.is_some());
        assert_eq!(stored.runs.len(), 1);
        assert_eq!(stored.runs[0].status, Some(LastRunStatus::Success));
        assert_eq!(
            stored.runs[0].finished_at.as_deref(),
            Some("2026-04-29T12:00:00Z")
        );
        assert_eq!(stored.runs[0].response_preview.as_deref(), Some("done"));
    }

    #[tokio::test]
    async fn clear_current_run_with_run_id_mismatch_does_not_clear() {
        let _env = EnvGuard::new("clear-mismatch");
        let store = TaskFileStore::new();
        store.save_task(&sample_task("mismatch")).unwrap();

        let candidate = make_current_run("chat-1", LastRunTrigger::Manual, now());
        store
            .try_set_current_run("mismatch", candidate.clone(), now())
            .await
            .unwrap();

        let outcome = store
            .clear_current_run_and_record_result(
                "mismatch",
                "different-run-id",
                TerminalRunResult {
                    status: LastRunStatus::Success,
                    chat_id: None,
                    error: None,
                    response_preview: None,
                    consume_schedule: false,
                },
                now(),
            )
            .await
            .unwrap();
        assert!(matches!(
            outcome,
            ClearCurrentRunOutcome::RunIdMismatch { existing } if existing.run_id == candidate.run_id
        ));

        let stored = store.get_task("mismatch").unwrap();
        assert!(stored.current_run.is_some());
        assert_eq!(stored.last_run_status, None);
        assert!(stored.runs[0].status.is_none());
    }

    #[tokio::test]
    async fn run_history_retains_latest_fifty_runs() {
        let _env = EnvGuard::new("run-history-retention");
        let store = TaskFileStore::new();
        store.save_task(&sample_task("history")).unwrap();

        for index in 0..55 {
            let run = make_current_run(format!("chat-{index}"), LastRunTrigger::Manual, now());
            store
                .try_set_current_run("history", run.clone(), now())
                .await
                .unwrap();
            store
                .clear_current_run_and_record_result(
                    "history",
                    &run.run_id,
                    TerminalRunResult {
                        status: LastRunStatus::Success,
                        chat_id: Some(format!("chat-{index}")),
                        error: None,
                        response_preview: Some(format!("done {index}")),
                        consume_schedule: false,
                    },
                    now(),
                )
                .await
                .unwrap();
        }

        let stored = store.get_task("history").unwrap();
        assert_eq!(stored.runs.len(), 50);
        assert_eq!(stored.runs[0].chat_id.as_deref(), Some("chat-5"));
        assert_eq!(stored.runs[49].chat_id.as_deref(), Some("chat-54"));
    }

    #[tokio::test]
    async fn clear_current_run_disables_once_task_when_consuming_schedule() {
        let _env = EnvGuard::new("clear-once");
        let store = TaskFileStore::new();
        let mut task = sample_task("once-clear");
        task.schedule = TaskSchedule {
            kind: ScheduleKind::Once,
            cron_expression: None,
            run_at: Some("2026-04-29T09:00:00Z".to_string()),
            timezone: "UTC".to_string(),
        };
        store.save_task(&task).unwrap();

        let candidate = make_current_run("chat-1", LastRunTrigger::Scheduled, now());
        store
            .try_set_current_run("once-clear", candidate.clone(), now())
            .await
            .unwrap();

        store
            .clear_current_run_and_record_result(
                "once-clear",
                &candidate.run_id,
                TerminalRunResult {
                    status: LastRunStatus::Success,
                    chat_id: Some("chat-1".to_string()),
                    error: None,
                    response_preview: None,
                    consume_schedule: true,
                },
                now(),
            )
            .await
            .unwrap();

        let stored = store.get_task("once-clear").unwrap();
        assert!(!stored.enabled);
        assert!(stored.next_run_at.is_none());
    }

    // -----------------------------------------------------------------
    // Round 4 / Issue 7 — needs_attention flag lifecycle
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn clear_current_run_clears_attention_on_success() {
        let _env = EnvGuard::new("attention-success");
        let store = TaskFileStore::new();
        let mut task = sample_task("attn-success");
        // Pre-seed the attention flag — simulates a previous run
        // that ended in auth_required or missing_integration.
        task.needs_attention = true;
        task.needs_attention_reason = Some("auth_required".to_string());
        task.needs_attention_since = Some("2026-04-29T08:00:00Z".to_string());
        store.save_task(&task).unwrap();

        let candidate = make_current_run("chat-1", LastRunTrigger::Scheduled, now());
        store
            .try_set_current_run("attn-success", candidate.clone(), now())
            .await
            .unwrap();
        store
            .clear_current_run_and_record_result(
                "attn-success",
                &candidate.run_id,
                TerminalRunResult {
                    status: LastRunStatus::Success,
                    chat_id: Some("chat-1".to_string()),
                    error: None,
                    response_preview: Some("ok".to_string()),
                    consume_schedule: true,
                },
                now(),
            )
            .await
            .unwrap();

        let stored = store.get_task("attn-success").unwrap();
        // A clean success MUST clear the sticky attention so the
        // amber dot disappears once the user is back in healthy state.
        assert!(!stored.needs_attention);
        assert!(stored.needs_attention_reason.is_none());
        assert!(stored.needs_attention_since.is_none());
    }

    #[tokio::test]
    async fn clear_current_run_sets_attention_on_auth_required() {
        let _env = EnvGuard::new("attention-auth");
        let store = TaskFileStore::new();
        let task = sample_task("attn-auth");
        store.save_task(&task).unwrap();

        let candidate = make_current_run("chat-1", LastRunTrigger::Scheduled, now());
        store
            .try_set_current_run("attn-auth", candidate.clone(), now())
            .await
            .unwrap();
        store
            .clear_current_run_and_record_result(
                "attn-auth",
                &candidate.run_id,
                TerminalRunResult {
                    status: LastRunStatus::AuthRequired,
                    chat_id: Some("chat-1".to_string()),
                    error: Some("token expired".to_string()),
                    response_preview: None,
                    consume_schedule: true,
                },
                now(),
            )
            .await
            .unwrap();

        let stored = store.get_task("attn-auth").unwrap();
        assert!(stored.needs_attention);
        assert_eq!(
            stored.needs_attention_reason.as_deref(),
            Some("auth_required")
        );
        assert!(stored.needs_attention_since.is_some());
    }

    #[tokio::test]
    async fn clear_current_run_sets_attention_on_failed() {
        let _env = EnvGuard::new("attention-failed");
        let store = TaskFileStore::new();
        let task = sample_task("attn-failed");
        store.save_task(&task).unwrap();

        let candidate = make_current_run("chat-1", LastRunTrigger::Scheduled, now());
        store
            .try_set_current_run("attn-failed", candidate.clone(), now())
            .await
            .unwrap();
        store
            .clear_current_run_and_record_result(
                "attn-failed",
                &candidate.run_id,
                TerminalRunResult {
                    status: LastRunStatus::Failed,
                    chat_id: Some("chat-1".to_string()),
                    error: Some("upstream 5xx".to_string()),
                    response_preview: None,
                    consume_schedule: true,
                },
                now(),
            )
            .await
            .unwrap();

        let stored = store.get_task("attn-failed").unwrap();
        assert!(stored.needs_attention);
        assert_eq!(stored.needs_attention_reason.as_deref(), Some("run_failed"));
    }

    #[test]
    fn clear_needs_attention_resets_all_attention_fields() {
        let _env = EnvGuard::new("clear-attn");
        let store = TaskFileStore::new();
        let mut task = sample_task("clear-attn-task");
        task.needs_attention = true;
        task.needs_attention_reason = Some("auth_required".to_string());
        task.needs_attention_since = Some("2026-04-29T08:00:00Z".to_string());
        store.save_task(&task).unwrap();

        let mutated = store.clear_needs_attention("clear-attn-task").unwrap();
        assert!(mutated, "first clear should mutate the on-disk task");
        let stored = store.get_task("clear-attn-task").unwrap();
        assert!(!stored.needs_attention);
        assert!(stored.needs_attention_reason.is_none());
        assert!(stored.needs_attention_since.is_none());
    }

    #[test]
    fn clear_needs_attention_is_idempotent() {
        let _env = EnvGuard::new("clear-attn-idempotent");
        let store = TaskFileStore::new();
        let task = sample_task("idempotent-task");
        store.save_task(&task).unwrap();

        let mutated = store.clear_needs_attention("idempotent-task").unwrap();
        // Already clean: no on-disk write so callers can blanket-call
        // this from the chat-open hook without churning storage.
        assert!(!mutated, "idempotent clear should not write");
    }
}
