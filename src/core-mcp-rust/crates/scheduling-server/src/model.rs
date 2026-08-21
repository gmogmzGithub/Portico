use anyhow::{Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use std::str::FromStr;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScheduleKind {
    Cron,
    Once,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct TaskSchedule {
    pub kind: ScheduleKind,
    #[serde(default)]
    pub cron_expression: Option<String>,
    #[serde(default)]
    pub run_at: Option<String>,
    pub timezone: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LastRunStatus {
    Success,
    Failed,
    Missed,
    Cancelled,
    Interrupted,
    /// Phase 2 of the chip rework: the executor's pre-flight guard
    /// detected that one of the task's required ``tool_server_ids`` is
    /// not currently installed/enabled. The run is aborted BEFORE a
    /// sub-agent chat is created so we don't burn an LLM completion on
    /// a guaranteed-broken setup.
    MissingIntegration,
    /// Round 4 / Issue 5a — the integration is installed and enabled,
    /// but auth is missing or expired. Distinct from
    /// ``MissingIntegration`` so the user knows whether to re-install
    /// (uninstalled / disabled) or just re-authorize (no token).
    /// Also raised by Issue 5b when a sub-agent run aborts mid-flight
    /// after a tool returns an OAuth-required signal — sub-agents
    /// must NOT initiate OAuth flows since no human is watching, so
    /// the run terminates with this status and the user
    /// re-authenticates from the main app.
    AuthRequired,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LastRunTrigger {
    Scheduled,
    Manual,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct CurrentRun {
    pub run_id: String,
    pub chat_id: String,
    pub started_at: String,
    pub trigger: LastRunTrigger,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScheduledTaskRun {
    pub run_id: String,
    #[serde(default)]
    pub chat_id: Option<String>,
    pub started_at: String,
    #[serde(default)]
    pub finished_at: Option<String>,
    #[serde(default)]
    pub status: Option<LastRunStatus>,
    pub trigger: LastRunTrigger,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub response_preview: Option<String>,
    #[serde(default)]
    pub needs_attention: bool,
    #[serde(default)]
    pub needs_attention_reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScheduledTask {
    pub id: String,
    /// Concise model-generated display name. Legacy task records predate this
    /// field, so they deserialize with an empty name and the UI derives a
    /// temporary prompt summary until the task is recreated.
    #[serde(default)]
    pub name: String,
    pub prompt: String,
    pub model_id: String,
    pub schedule: TaskSchedule,
    #[serde(default)]
    pub skill_ids: Vec<String>,
    #[serde(default)]
    pub tool_server_ids: Vec<String>,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub next_run_at: Option<String>,
    #[serde(default)]
    pub last_run_at: Option<String>,
    #[serde(default)]
    pub last_run_status: Option<LastRunStatus>,
    #[serde(default)]
    pub last_run_chat_id: Option<String>,
    #[serde(default)]
    pub last_run_error: Option<String>,
    #[serde(default)]
    pub last_run_response_preview: Option<String>,
    #[serde(default)]
    pub last_run_trigger: Option<LastRunTrigger>,
    #[serde(default)]
    pub current_run: Option<CurrentRun>,
    /// Round 4 / Issue 7 — sticky "needs attention" flag the
    /// frontend renders as an amber dot on the scheduled task row.
    /// Set whenever the daemon records a terminal that the user
    /// should look at (auth_required / missing_integration) or
    /// whenever the middleware surfaces an out-of-scope clarification
    /// chip inside a sub-agent chat. Cleared when the user opens the
    /// task's chat OR when a subsequent run completes successfully.
    #[serde(default)]
    pub needs_attention: bool,
    /// Human-readable reason for the attention flag (e.g.
    /// ``"auth_required"``, ``"missing_integration"``,
    /// ``"out_of_scope_chip_pending"``). Surfaced in the tooltip on
    /// the amber dot so the user knows what to fix without opening
    /// the chat.
    #[serde(default)]
    pub needs_attention_reason: Option<String>,
    /// RFC3339 timestamp of when the attention flag was first set
    /// during the current "attention period". Lets the UI sort by
    /// stale-ness and lets ops dashboards alert on tasks that have
    /// been in this state for a long time.
    #[serde(default)]
    pub needs_attention_since: Option<String>,
    #[serde(default)]
    pub runs: Vec<ScheduledTaskRun>,
}

pub fn format_utc_timestamp(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn format_readable_timestamp(value: DateTime<Utc>, timezone: &str) -> String {
    let trimmed_timezone = timezone.trim();
    let timezone = Tz::from_str(trimmed_timezone).unwrap_or(chrono_tz::UTC);
    let timezone_label = if trimmed_timezone.is_empty() {
        "UTC"
    } else {
        trimmed_timezone
    };
    format!(
        "{} {}",
        value.with_timezone(&timezone).format("%Y-%m-%d %H:%M"),
        timezone_label,
    )
}

/// Missed-row message for cron occurrences that were superseded by a newer
/// occurrence before the scheduler could catch them up. Only the most
/// recent occurrence runs after downtime; the older ones get this row.
pub fn missed_superseded_message(
    first_missed: DateTime<Utc>,
    skipped_count: usize,
    count_capped: bool,
    timezone: &str,
) -> String {
    let first = format_readable_timestamp(first_missed, timezone);
    if skipped_count <= 1 {
        format!(
            "Skipped a scheduled run at {first}: the app was not running at the time and a newer \
             occurrence superseded it. Only the most recent occurrence runs after downtime.",
        )
    } else {
        let count = if count_capped {
            format!("{skipped_count}+")
        } else {
            skipped_count.to_string()
        };
        format!(
            "Skipped {count} scheduled runs starting at {first}: the app was not running at those \
             times and newer occurrences superseded them. Only the most recent occurrence runs \
             after downtime.",
        )
    }
}

/// Missed-row message for a one-off task whose `run_at` passed more than
/// the catch-up window ago while the scheduler was down.
pub fn missed_once_expired_message(
    scheduled_at: DateTime<Utc>,
    catch_up_window_hours: i64,
    timezone: &str,
) -> String {
    format!(
        "Skipped because the app was not running at the scheduled time ({}) and the {}-hour \
         catch-up window had already passed when it came back.",
        format_readable_timestamp(scheduled_at, timezone),
        catch_up_window_hours,
    )
}

pub fn parse_rfc3339_to_utc(raw: &str, field_name: &str) -> Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .with_context(|| format!("Invalid RFC3339 timestamp for {field_name}: {raw}"))
        .map(|value| value.with_timezone(&Utc))
}

impl TaskSchedule {
    pub fn run_at_utc(&self) -> Result<Option<DateTime<Utc>>> {
        self.run_at
            .as_deref()
            .map(|raw| parse_rfc3339_to_utc(raw, "schedule.run_at"))
            .transpose()
    }
}

impl ScheduledTask {
    const MAX_RUN_HISTORY: usize = 50;

    pub fn next_run_at_utc(&self) -> Result<Option<DateTime<Utc>>> {
        self.next_run_at
            .as_deref()
            .map(|raw| parse_rfc3339_to_utc(raw, "next_run_at"))
            .transpose()
    }

    pub fn set_next_run_at_utc(&mut self, value: Option<DateTime<Utc>>) {
        self.next_run_at = value.map(format_utc_timestamp);
    }

    pub fn set_last_run_at_utc(&mut self, value: Option<DateTime<Utc>>) {
        self.last_run_at = value.map(format_utc_timestamp);
    }

    pub fn set_updated_at_utc(&mut self, value: DateTime<Utc>) {
        self.updated_at = format_utc_timestamp(value);
    }

    pub fn record_started_run(&mut self, run: &CurrentRun) {
        self.runs.retain(|item| item.run_id != run.run_id);
        self.runs.push(ScheduledTaskRun {
            run_id: run.run_id.clone(),
            chat_id: Some(run.chat_id.clone()),
            started_at: run.started_at.clone(),
            finished_at: None,
            status: None,
            trigger: run.trigger.clone(),
            error: None,
            response_preview: None,
            needs_attention: false,
            needs_attention_reason: None,
        });
        self.trim_run_history();
    }

    pub fn record_terminal_run(
        &mut self,
        run_id: impl Into<String>,
        started_at: Option<String>,
        finished_at: DateTime<Utc>,
        trigger: LastRunTrigger,
        status: LastRunStatus,
        chat_id: Option<String>,
        error: Option<String>,
        response_preview: Option<String>,
        attention_reason: Option<String>,
    ) {
        let run_id = run_id.into();
        let finished_at = format_utc_timestamp(finished_at);
        let needs_attention = attention_reason.is_some();
        match self.runs.iter_mut().find(|item| item.run_id == run_id) {
            Some(run) => {
                if let Some(started_at) = started_at {
                    run.started_at = started_at;
                }
                run.finished_at = Some(finished_at);
                run.status = Some(status);
                if chat_id.is_some() {
                    run.chat_id = chat_id;
                }
                run.error = error;
                run.response_preview = response_preview;
                run.trigger = trigger;
                run.needs_attention = needs_attention;
                run.needs_attention_reason = attention_reason;
            }
            None => {
                self.runs.push(ScheduledTaskRun {
                    run_id,
                    chat_id,
                    started_at: started_at.unwrap_or_else(|| finished_at.clone()),
                    finished_at: Some(finished_at),
                    status: Some(status),
                    trigger,
                    error,
                    response_preview,
                    needs_attention,
                    needs_attention_reason: attention_reason,
                });
            }
        }
        self.trim_run_history();
    }

    fn trim_run_history(&mut self) {
        if self.runs.len() > Self::MAX_RUN_HISTORY {
            let excess = self.runs.len() - Self::MAX_RUN_HISTORY;
            self.runs.drain(0..excess);
        }
    }
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;
    use serde_json::json;

    use super::*;

    #[test]
    fn missed_superseded_message_formats_times_counts_and_caps_in_task_timezone() {
        let first = Utc.with_ymd_and_hms(2026, 7, 1, 6, 0, 0).unwrap();

        let singular = missed_superseded_message(first, 1, false, "Europe/Kyiv");
        assert_eq!(
            singular,
            "Skipped a scheduled run at 2026-07-01 09:00 Europe/Kyiv: the app was not running at \
             the time and a newer occurrence superseded it. Only the most recent occurrence runs \
             after downtime."
        );

        let plural = missed_superseded_message(first, 5, false, "Europe/Kyiv");
        assert!(
            plural.starts_with("Skipped 5 scheduled runs starting at 2026-07-01 09:00 Europe/Kyiv")
        );

        let capped = missed_superseded_message(first, 1000, true, "Europe/Kyiv");
        assert!(capped.starts_with("Skipped 1000+ scheduled runs"));
    }

    #[test]
    fn missed_once_expired_message_formats_time_and_window_in_task_timezone() {
        let message = missed_once_expired_message(
            Utc.with_ymd_and_hms(2026, 7, 1, 6, 0, 0).unwrap(),
            24,
            "Europe/Kyiv",
        );

        assert_eq!(
            message,
            "Skipped because the app was not running at the scheduled time (2026-07-01 09:00 Europe/Kyiv) and the 24-hour catch-up window had already passed when it came back."
        );
    }

    #[test]
    fn scheduled_task_deserializes_legacy_records_without_run_history() {
        let task: ScheduledTask = serde_json::from_value(json!({
            "id": "scheduled-task-legacy",
            "prompt": "Check calendar",
            "model_id": "Claude Sonnet",
            "schedule": {
                "kind": "once",
                "run_at": "2030-01-01T12:00:00Z",
                "timezone": "UTC"
            },
            "enabled": true,
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z",
            "next_run_at": "2030-01-01T12:00:00Z"
        }))
        .expect("legacy task should deserialize");

        assert!(task.name.is_empty());
        assert!(task.runs.is_empty());
        assert!(!task.needs_attention);
    }

    #[test]
    fn terminal_run_keeps_existing_chat_when_result_omits_chat_id() {
        let mut task: ScheduledTask = serde_json::from_value(json!({
            "id": "scheduled-task-chat",
            "prompt": "Check calendar",
            "model_id": "Claude Sonnet",
            "schedule": {
                "kind": "once",
                "run_at": "2030-01-01T12:00:00Z",
                "timezone": "UTC"
            },
            "enabled": true,
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z"
        }))
        .expect("task should deserialize");

        task.record_started_run(&CurrentRun {
            run_id: "run-1".to_string(),
            chat_id: "chat-1".to_string(),
            started_at: "2026-01-01T01:00:00Z".to_string(),
            trigger: LastRunTrigger::Manual,
        });
        task.record_terminal_run(
            "run-1",
            None,
            Utc.with_ymd_and_hms(2026, 1, 1, 1, 1, 0).unwrap(),
            LastRunTrigger::Manual,
            LastRunStatus::Success,
            None,
            None,
            Some("done".to_string()),
            None,
        );

        assert_eq!(task.runs[0].chat_id.as_deref(), Some("chat-1"));
        assert_eq!(task.runs[0].status, Some(LastRunStatus::Success));
    }
}
