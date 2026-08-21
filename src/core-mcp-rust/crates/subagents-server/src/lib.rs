mod native;

use anyhow::Result;

pub use native::{
    await_subagent_completion, prepare_subagent_request, run_subagent, start_subagent_run,
    AwaitOutcome, PreparedSubagentRequest, RunSubagentRequest, RunSubagentResult,
    StartedSubagentRun, DEFAULT_SUBAGENT_FOLDER_NAME,
};

pub async fn serve_stdio() -> Result<()> {
    core_mcp_shared::serve_stdio_server(
        "subagents",
        include_str!("../tool_spec.json"),
        native::Dispatcher,
    )
    .await
}
