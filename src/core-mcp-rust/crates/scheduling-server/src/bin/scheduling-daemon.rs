use anyhow::Result;
use scheduling_server::{Executor, SubagentTaskRunner, TaskFileStore};
use std::time::Duration;

const DEFAULT_POLL_INTERVAL_SECONDS: u64 = 30;

fn poll_interval_seconds() -> u64 {
    std::env::var("SCHEDULING_DAEMON_POLL_INTERVAL_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_POLL_INTERVAL_SECONDS)
}

#[tokio::main]
async fn main() -> Result<()> {
    core_mcp_shared::init_logging();

    let store = TaskFileStore::new();
    let runner = SubagentTaskRunner;
    let poll_interval = Duration::from_secs(poll_interval_seconds());
    let executor = Executor::new(store, runner, poll_interval);

    tracing::info!(
        daemon_started_at = %executor.daemon_started_at(),
        poll_interval_seconds = poll_interval.as_secs(),
        "Scheduling daemon started",
    );

    executor.run_forever().await
}
