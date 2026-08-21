use std::future::Future;

use anyhow::Result;
use tracing::error;

async fn run_main<F>(serve: F) -> i32
where
    F: Future<Output = Result<()>>,
{
    core_mcp_shared::init_logging();

    match serve.await {
        Ok(()) => 0,
        Err(error) => {
            error!("{error:#}");
            1
        }
    }
}

fn run_sync_main<F, Fut>(serve: F) -> i32
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("failed to initialize Tokio runtime");
    runtime.block_on(run_main(serve()))
}

#[cfg(not(test))]
fn main() {
    std::process::exit(run_sync_main(subagents_server::serve_stdio));
}

#[cfg(test)]
mod tests {
    use anyhow::anyhow;

    use super::{run_main, run_sync_main};

    #[tokio::test]
    async fn run_main_returns_success_exit_code() {
        assert_eq!(run_main(async { Ok(()) }).await, 0);
    }

    #[tokio::test]
    async fn run_main_returns_failure_exit_code() {
        assert_eq!(run_main(async { Err(anyhow!("boom")) }).await, 1);
    }

    #[test]
    fn run_sync_main_returns_success_exit_code() {
        assert_eq!(run_sync_main(|| async { Ok(()) }), 0);
    }

    #[test]
    fn run_sync_main_returns_failure_exit_code() {
        assert_eq!(run_sync_main(|| async { Err(anyhow!("boom")) }), 1);
    }
}
