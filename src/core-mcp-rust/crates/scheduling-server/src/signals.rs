//! Cross-process run signals between the scheduling-server (producer of
//! `run_task_now` and `cancel_run` requests) and the scheduling-daemon
//! (single-writer executor of in-flight task runs).
//!
//! The signal queue is a Redis list. Producers `LPUSH` a JSON envelope, the
//! daemon `BRPOP`s with a short timeout. The envelope is intentionally small
//! and idempotent: it carries only the `task_id` and a kind discriminator.
//! All authoritative state lives in `ScheduledTask.current_run` on disk and
//! ephemeral cancellation flags in Redis. Lost or duplicate signals are
//! recovered on the daemon's periodic reconciliation sweep.
//!
//! Production callers go through Redis. Tests using
//! `CORE_MCP_TEST_REDIS=memory` exercise the in-memory list stub; the
//! blocking BRPOP path falls back to a non-blocking RPOP under tests so
//! suites cannot hang.

use anyhow::{Context, Result};
use core_mcp_shared::{redis_brpop_blocking, redis_lpush};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Redis list key used to wake the scheduling daemon for newly-started or
/// cancelled runs. The list is shared across all task ids — payload carries
/// the discriminator.
pub const SCHEDULING_RUN_SIGNAL_KEY: &str = "scheduling_run_signal";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum RunSignal {
    /// A new run has been started by the scheduling-server (manual
    /// `run_task_now`). The daemon should attach to its `current_run` and
    /// poll for completion.
    Start { task_id: String, run_id: String },
    /// A cancellation request was issued for a run. The daemon should write
    /// the upstream `subagent_cancel:<chat_id>` flag if it hasn't already
    /// and observe the polling loop terminating.
    Cancel { task_id: String, run_id: String },
}

impl RunSignal {
    pub fn task_id(&self) -> &str {
        match self {
            RunSignal::Start { task_id, .. } | RunSignal::Cancel { task_id, .. } => task_id,
        }
    }
}

/// Producer side: push a `Start` envelope so the daemon picks the run up
/// instantly. Best-effort: callers must NOT depend on delivery — the daemon
/// also reconciles via a periodic sweep over `current_run`.
pub fn enqueue_start_signal(task_id: &str, run_id: &str) -> Result<()> {
    enqueue_signal(&RunSignal::Start {
        task_id: task_id.to_string(),
        run_id: run_id.to_string(),
    })
}

/// Producer side: push a `Cancel` envelope so the daemon notices the
/// in-flight run should abort. The actual stop happens via the existing
/// `subagent_cancel:<chat_id>` Redis key, observed by the polling loop.
pub fn enqueue_cancel_signal(task_id: &str, run_id: &str) -> Result<()> {
    enqueue_signal(&RunSignal::Cancel {
        task_id: task_id.to_string(),
        run_id: run_id.to_string(),
    })
}

fn enqueue_signal(signal: &RunSignal) -> Result<()> {
    let payload = serde_json::to_string(signal).context("failed to encode run signal")?;
    redis_lpush(SCHEDULING_RUN_SIGNAL_KEY, &payload)
}

/// Consumer side: block on BRPOP for up to `timeout`. Returns
/// `Ok(Some(signal))` on a signal, `Ok(None)` on timeout, or `Err` on a
/// transport-level failure. Must be invoked from a `spawn_blocking` task in
/// async contexts. Malformed envelopes are dropped with a warning.
pub fn next_run_signal_blocking(timeout: Duration) -> Result<Option<RunSignal>> {
    let timeout_secs = timeout.as_secs().max(1);
    let raw = redis_brpop_blocking(SCHEDULING_RUN_SIGNAL_KEY, timeout_secs)?;
    let Some(raw) = raw else {
        return Ok(None);
    };
    match serde_json::from_str::<RunSignal>(&raw) {
        Ok(signal) => Ok(Some(signal)),
        Err(error) => {
            tracing::warn!(
                error = %error,
                payload = %raw,
                "Discarding malformed run-signal envelope",
            );
            Ok(None)
        }
    }
}

/// Convenience async wrapper around `next_run_signal_blocking` that runs on
/// the blocking thread pool.
pub async fn next_run_signal(timeout: Duration) -> Result<Option<RunSignal>> {
    tokio::task::spawn_blocking(move || next_run_signal_blocking(timeout))
        .await
        .context("BRPOP task panicked")?
}

#[cfg(test)]
mod tests {
    use super::*;
    use core_mcp_shared::{reset_test_redis_state, test_redis_list_snapshot, TEST_ENV_LOCK};
    use std::env;

    struct EnvGuard {
        _guard: std::sync::MutexGuard<'static, ()>,
        previous: Option<String>,
    }

    impl EnvGuard {
        fn new() -> Self {
            let guard = TEST_ENV_LOCK
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            let previous = env::var("CORE_MCP_TEST_REDIS").ok();
            env::set_var("CORE_MCP_TEST_REDIS", "memory");
            reset_test_redis_state();
            Self {
                _guard: guard,
                previous,
            }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            if let Some(value) = &self.previous {
                env::set_var("CORE_MCP_TEST_REDIS", value);
            } else {
                env::remove_var("CORE_MCP_TEST_REDIS");
            }
            reset_test_redis_state();
        }
    }

    #[test]
    fn enqueue_start_signal_pushes_envelope_and_consumer_receives_it_in_lifo_order() {
        let _env = EnvGuard::new();
        enqueue_start_signal("task-a", "run-1").unwrap();
        enqueue_cancel_signal("task-b", "run-9").unwrap();

        let snapshot = test_redis_list_snapshot(SCHEDULING_RUN_SIGNAL_KEY).unwrap();
        assert_eq!(snapshot.len(), 2);

        // BRPOP returns from the right (oldest first under LPUSH).
        let first = next_run_signal_blocking(Duration::from_secs(1))
            .unwrap()
            .unwrap();
        assert_eq!(
            first,
            RunSignal::Start {
                task_id: "task-a".to_string(),
                run_id: "run-1".to_string()
            }
        );

        let second = next_run_signal_blocking(Duration::from_secs(1))
            .unwrap()
            .unwrap();
        assert_eq!(
            second,
            RunSignal::Cancel {
                task_id: "task-b".to_string(),
                run_id: "run-9".to_string()
            }
        );

        let drained = next_run_signal_blocking(Duration::from_secs(1)).unwrap();
        assert!(drained.is_none());
    }

    #[test]
    fn run_signal_task_id_returns_the_task_id_regardless_of_kind() {
        let start = RunSignal::Start {
            task_id: "task-x".to_string(),
            run_id: "r1".to_string(),
        };
        let cancel = RunSignal::Cancel {
            task_id: "task-y".to_string(),
            run_id: "r2".to_string(),
        };
        assert_eq!(start.task_id(), "task-x");
        assert_eq!(cancel.task_id(), "task-y");
    }
}
