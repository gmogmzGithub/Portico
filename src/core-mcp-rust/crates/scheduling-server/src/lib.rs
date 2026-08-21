mod executor;
mod model;
mod native;
mod preflight;
mod runtime;
mod schedule;
mod signals;
mod storage;

use anyhow::Result;

pub use executor::{
    mark_run_cancelled, run_cancelled_marker_key, signal_subagent_cancel, Executor,
    SCHEDULING_RUN_CANCELLED_KEY_PREFIX,
};
pub use model::{
    format_utc_timestamp, CurrentRun, LastRunStatus, LastRunTrigger, ScheduleKind, ScheduledTask,
    TaskSchedule,
};
pub use preflight::{
    any_auth_failure, check_tool_servers_against, check_tool_servers_available,
    check_tool_servers_with_auth, render_missing_integration_message, AuthState, OfflineReason,
    OfflineToolServer,
};
pub use runtime::{
    claim_and_start_run, classify_task, forget_scheduled_run_verdict, get_scheduled_run_verdict,
    mark_once_task_missed, once_catch_up_window_hours, process_due_tasks_once,
    record_stale_missed_and_rearm, remember_scheduled_run_verdict, run_task_inline, run_task_now,
    ClaimRunOutcome, DaemonCycleReport, ScheduleDecision, ScheduledRunVerdict,
    ScheduledRunVerdictStatus, StaleOccurrences, StartedRunHandle, SubagentTaskRunner,
    TaskExecutionResult, TaskRunner, CATCH_UP_LATENESS_THRESHOLD_MINUTES,
    SCHEDULED_FINALIZER_TOOL_NAME, SCHEDULED_TASKS_FOLDER_NAME, SCHEDULING_TOOL_SERVER_ID,
};
pub use schedule::{
    count_occurrences_between, initial_next_run_at, most_recent_run_at_or_before,
    next_future_run_at, validate_schedule,
};
pub use signals::{
    enqueue_cancel_signal, enqueue_start_signal, next_run_signal, next_run_signal_blocking,
    RunSignal, SCHEDULING_RUN_SIGNAL_KEY,
};
pub use storage::{
    make_current_run, ClearCurrentRunOutcome, SetCurrentRunOutcome, TaskFileStore,
    TerminalRunResult,
};

pub async fn serve_stdio() -> Result<()> {
    core_mcp_shared::serve_stdio_server(
        "scheduling",
        include_str!("../tool_spec.json"),
        native::Dispatcher,
    )
    .await
}
