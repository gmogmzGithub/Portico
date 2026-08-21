use crate::executor::{mark_run_cancelled, signal_subagent_cancel};
use crate::model::{format_utc_timestamp, LastRunTrigger, ScheduledTask, TaskSchedule};
use crate::runtime::{
    claim_and_start_run, remember_scheduled_run_verdict, ClaimRunOutcome, ScheduledRunVerdict,
    ScheduledRunVerdictStatus, SubagentTaskRunner,
};
use crate::schedule::{initial_next_run_at, validate_schedule};
use crate::signals::{enqueue_cancel_signal, enqueue_start_signal};
use crate::storage::TaskFileStore;
use anyhow::{anyhow, bail, Context, Result};
use chrono::Utc;
use core_mcp_shared::{array_strings, bool_arg, string_arg, success_text};
use serde_json::{json, Map, Value};
use uuid::Uuid;

const MAX_TASK_NAME_CHARS: usize = 80;

fn normalized_task_name(raw: &str) -> Result<String> {
    let normalized = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        bail!("name must not be empty");
    }
    Ok(normalized.chars().take(MAX_TASK_NAME_CHARS).collect())
}

pub(super) async fn handle_create_task(arguments: &Map<String, Value>) -> Result<Value> {
    let name = normalized_task_name(&string_arg(arguments, "name")?)?;
    let prompt = string_arg(arguments, "prompt")?;
    let model_id = string_arg(arguments, "model_id")?;
    let schedule = schedule_arg(arguments, "schedule")?;
    validate_schedule(&schedule)?;
    let enabled = bool_arg(arguments, "enabled", true);
    let now = Utc::now();

    let mut task = ScheduledTask {
        id: format!("scheduled-task-{}", Uuid::new_v4().simple()),
        name,
        prompt,
        model_id,
        schedule,
        skill_ids: normalized_unique_strings(&array_strings(arguments.get("skill_ids"))),
        tool_server_ids: normalized_unique_strings(&array_strings(
            arguments.get("tool_server_ids"),
        )),
        enabled,
        created_at: format_utc_timestamp(now),
        updated_at: format_utc_timestamp(now),
        next_run_at: None,
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
    };
    if task.enabled {
        task.set_next_run_at_utc(initial_next_run_at(&task.schedule, now)?);
    }

    TaskFileStore::new().save_task(&task)?;
    success_text(json!(task))
}

pub(super) async fn handle_get_task(arguments: &Map<String, Value>) -> Result<Value> {
    let task_id = string_arg(arguments, "task_id")?;
    success_text(json!(TaskFileStore::new().get_task(&task_id)?))
}

pub(super) async fn handle_list_tasks(arguments: &Map<String, Value>) -> Result<Value> {
    let include_disabled = bool_arg(arguments, "include_disabled", true);
    let mut tasks = TaskFileStore::new().list_tasks()?;
    if !include_disabled {
        tasks.retain(|task| task.enabled);
    }
    success_text(json!({
        "tasks": tasks,
        "count": tasks.len(),
    }))
}

pub(super) async fn handle_update_task(arguments: &Map<String, Value>) -> Result<Value> {
    let task_id = string_arg(arguments, "task_id")?;
    let store = TaskFileStore::new();
    let mut task = store.get_task(&task_id)?;
    let now = Utc::now();
    let mut schedule_changed = false;

    if let Some(name) = optional_trimmed_string(arguments, "name") {
        task.name = normalized_task_name(&name)?;
    }
    if let Some(prompt) = optional_trimmed_string(arguments, "prompt") {
        task.prompt = prompt;
    }
    if let Some(model_id) = optional_trimmed_string(arguments, "model_id") {
        task.model_id = model_id;
    }
    if let Some(schedule_value) = arguments.get("schedule") {
        task.schedule = serde_json::from_value::<TaskSchedule>(schedule_value.clone())
            .context("schedule must be a valid scheduling object")?;
        validate_schedule(&task.schedule)?;
        schedule_changed = true;
    }
    if arguments.get("skill_ids").is_some() {
        task.skill_ids = normalized_unique_strings(&array_strings(arguments.get("skill_ids")));
    }
    if arguments.get("tool_server_ids").is_some() {
        task.tool_server_ids =
            normalized_unique_strings(&array_strings(arguments.get("tool_server_ids")));
    }

    let enabled_supplied = arguments.get("enabled").and_then(Value::as_bool);
    if let Some(enabled) = enabled_supplied {
        task.enabled = enabled;
    }

    if schedule_changed || enabled_supplied.is_some() {
        if task.enabled {
            task.set_next_run_at_utc(initial_next_run_at(&task.schedule, now)?);
        } else {
            task.set_next_run_at_utc(None);
        }
    }

    task.set_updated_at_utc(now);
    store.save_task(&task)?;
    success_text(json!(task))
}

pub(super) async fn handle_delete_task(arguments: &Map<String, Value>) -> Result<Value> {
    let task_id = string_arg(arguments, "task_id")?;
    TaskFileStore::new().delete_task(&task_id)?;
    success_text(json!({
        "success": true,
        "task_id": task_id,
    }))
}

/// Manual `run_task_now`: kick off a run immediately and return a handle
/// (run_id + chat_id) without waiting for it to finish. The actual
/// completion polling is performed by the scheduling daemon's executor;
/// callers can poll `get_task` or check `last_run_*` fields.
///
/// Idempotent: if a run is already in flight for the task, the existing
/// handle is returned with `status = "already_running"`. There is no way
/// to start a second concurrent run for the same task.
pub(super) async fn handle_run_task_now(arguments: &Map<String, Value>) -> Result<Value> {
    let task_id = string_arg(arguments, "task_id")?;
    let store = TaskFileStore::new();
    let now = Utc::now();

    // Phase 2 guardrail: integrations must be installed + enabled
    // BEFORE we claim a run slot. The model is supposed to do this at
    // task-creation time (see skills/scheduled-tasks/SKILL.md), but
    // for run-now we treat the moment-of-execution as the source of
    // truth — the user might have toggled an integration off since
    // creation. Failing here gives them an actionable message
    // instead of a silent bad chat.
    let task_for_preflight = store.get_task(&task_id)?;
    let offline =
        crate::preflight::check_tool_servers_available(&task_for_preflight.tool_server_ids)?;
    if !offline.is_empty() {
        let error_message = crate::preflight::render_missing_integration_message(&offline);
        // Persist the terminal state so ``last_run_*`` reflects the
        // failed attempt, mirroring what the daemon's scheduled path
        // does. For manual runs we don't advance ``next_run_at`` —
        // the user explicitly asked to run NOW, not to skip the
        // scheduled occurrence.
        //
        // Round 4 / Issue 5a — auth-only failures get the dedicated
        // ``AuthRequired`` status so the user knows whether to
        // re-install or just re-authorize.
        let terminal_status = if crate::preflight::any_auth_failure(&offline) {
            crate::model::LastRunStatus::AuthRequired
        } else {
            crate::model::LastRunStatus::MissingIntegration
        };
        let mut updated = task_for_preflight.clone();
        updated.set_last_run_at_utc(Some(now));
        updated.last_run_status = Some(terminal_status.clone());
        updated.last_run_chat_id = None;
        updated.last_run_response_preview = None;
        updated.last_run_trigger = Some(LastRunTrigger::Manual);
        updated.last_run_error = Some(error_message.clone());
        updated.set_updated_at_utc(now);
        // Round 4 / Issue 7 — manual runs that fail pre-flight also
        // mark the task as needing attention; the user just clicked
        // "run now" so they're definitely watching.
        let attention_reason = match &terminal_status {
            crate::model::LastRunStatus::AuthRequired => "auth_required",
            crate::model::LastRunStatus::MissingIntegration => "missing_integration",
            _ => "preflight_failed",
        };
        updated.needs_attention = true;
        updated.needs_attention_reason = Some(attention_reason.to_string());
        if updated.needs_attention_since.is_none() {
            updated.needs_attention_since = Some(crate::model::format_utc_timestamp(now));
        }
        updated.record_terminal_run(
            Uuid::new_v4().to_string(),
            None,
            now,
            LastRunTrigger::Manual,
            terminal_status,
            None,
            updated.last_run_error.clone(),
            None,
            Some(attention_reason.to_string()),
        );
        store.save_task(&updated)?;
        bail!("{}", error_message);
    }

    let outcome = claim_and_start_run(
        &store,
        &SubagentTaskRunner,
        &task_id,
        LastRunTrigger::Manual,
        now,
    )
    .await?;

    match outcome {
        ClaimRunOutcome::Claimed { run } => {
            // Best-effort wake the daemon. If signaling fails, the daemon's
            // periodic reconciliation will still pick up the in-flight run.
            if let Err(error) = enqueue_start_signal(&task_id, &run.run_id) {
                tracing::warn!(
                    task_id = %task_id,
                    run_id = %run.run_id,
                    ?error,
                    "Failed to enqueue start-signal; daemon will pick up via sweep",
                );
            }
            success_text(json!({
                "task_id": task_id,
                "run_id": run.run_id,
                "chat_id": run.chat_id,
                "started_at": run.started_at,
                "trigger": "manual",
                "status": "running",
            }))
        }
        ClaimRunOutcome::AlreadyClaimed { existing } => success_text(json!({
            "task_id": task_id,
            "run_id": existing.run_id,
            "chat_id": existing.chat_id,
            "started_at": existing.started_at,
            "trigger": match existing.trigger {
                LastRunTrigger::Manual => "manual",
                LastRunTrigger::Scheduled => "scheduled",
            },
            "status": "already_running",
        })),
        ClaimRunOutcome::TaskNotFound => {
            bail!("Scheduled task '{}' not found", task_id);
        }
    }
}

/// Cancel an in-flight run for `task_id`. Sets the per-run cancel marker
/// and the upstream `subagent_cancel:<chat_id>` flag, then signals the
/// daemon to observe the cancellation. Returns immediately; the run
/// terminates asynchronously and `last_run_status` becomes
/// `LastRunStatus::Cancelled`.
pub(super) async fn handle_cancel_run(arguments: &Map<String, Value>) -> Result<Value> {
    let task_id = string_arg(arguments, "task_id")?;
    let supplied_run_id = arguments
        .get("run_id")
        .and_then(Value::as_str)
        .map(str::to_string);
    let task = TaskFileStore::new().get_task(&task_id)?;
    let Some(current_run) = task.current_run.clone() else {
        return success_text(json!({
            "task_id": task_id,
            "status": "no_run_in_flight",
        }));
    };
    if let Some(run_id) = supplied_run_id.as_deref() {
        if run_id != current_run.run_id {
            return Err(anyhow!(
                "run_id mismatch: requested {} but task '{}' has run_id {}",
                run_id,
                task_id,
                current_run.run_id
            ));
        }
    }
    if let Err(error) = mark_run_cancelled(&current_run.run_id) {
        tracing::warn!(
            task_id = %task_id,
            run_id = %current_run.run_id,
            ?error,
            "Failed to set scheduling cancel marker",
        );
    }
    if let Err(error) = signal_subagent_cancel(&current_run.chat_id) {
        tracing::warn!(
            task_id = %task_id,
            chat_id = %current_run.chat_id,
            ?error,
            "Failed to set upstream subagent_cancel flag",
        );
    }
    if let Err(error) = enqueue_cancel_signal(&task_id, &current_run.run_id) {
        tracing::warn!(
            task_id = %task_id,
            run_id = %current_run.run_id,
            ?error,
            "Failed to enqueue cancel-signal; daemon will pick up via sweep",
        );
    }
    success_text(json!({
        "task_id": task_id,
        "run_id": current_run.run_id,
        "chat_id": current_run.chat_id,
        "status": "cancelling",
    }))
}

pub(super) async fn handle_finalize_run(arguments: &Map<String, Value>) -> Result<Value> {
    let task_id = string_arg(arguments, "task_id")?;
    let status = string_arg(arguments, "status")?;
    let summary = string_arg(arguments, "summary")?;
    let reason = optional_trimmed_string(arguments, "reason");
    let task = TaskFileStore::new().get_task(&task_id)?;
    let current_run = task
        .current_run
        .clone()
        .with_context(|| format!("Scheduled task '{}' has no run in flight", task_id))?;
    let verdict_status = match status.as_str() {
        "success" => ScheduledRunVerdictStatus::Success,
        "failed" => ScheduledRunVerdictStatus::Failed,
        "needs_attention" => ScheduledRunVerdictStatus::NeedsAttention,
        other => bail!(
            "Invalid scheduled run finalizer status '{}'; expected success, failed, or needs_attention",
            other
        ),
    };
    let finalized_at = Utc::now();
    let verdict = ScheduledRunVerdict {
        task_id: task_id.clone(),
        run_id: current_run.run_id.clone(),
        chat_id: current_run.chat_id.clone(),
        status: verdict_status,
        summary,
        reason,
        finalized_at: format_utc_timestamp(finalized_at),
    };
    remember_scheduled_run_verdict(&verdict)?;
    success_text(json!({
        "success": true,
        "task_id": task_id,
        "run_id": current_run.run_id,
        "chat_id": current_run.chat_id,
        "message": "Scheduled run verdict recorded.",
    }))
}

fn schedule_arg(arguments: &Map<String, Value>, key: &str) -> Result<TaskSchedule> {
    let value = arguments
        .get(key)
        .cloned()
        .with_context(|| format!("{key} is required"))?;
    serde_json::from_value(value)
        .with_context(|| format!("{key} must be a valid scheduling object"))
}

fn optional_trimmed_string(arguments: &Map<String, Value>, key: &str) -> Option<String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn normalized_unique_strings(values: &[String]) -> Vec<String> {
    let mut normalized = Vec::new();
    for value in values {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            continue;
        }
        if normalized.iter().any(|existing| existing == trimmed) {
            continue;
        }
        normalized.push(trimmed.to_string());
    }
    normalized
}

#[cfg(test)]
mod name_tests {
    use super::{normalized_task_name, MAX_TASK_NAME_CHARS};

    #[test]
    fn task_name_collapses_whitespace_and_caps_length() {
        assert_eq!(
            normalized_task_name("  Weekly\n  wins   summary ").unwrap(),
            "Weekly wins summary"
        );
        assert_eq!(
            normalized_task_name(&"x".repeat(MAX_TASK_NAME_CHARS + 10))
                .unwrap()
                .chars()
                .count(),
            MAX_TASK_NAME_CHARS
        );
    }

    #[test]
    fn task_name_rejects_whitespace_only_values() {
        assert!(normalized_task_name(" \n\t ").is_err());
    }
}
