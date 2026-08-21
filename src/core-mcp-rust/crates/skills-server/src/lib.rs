mod native;

use anyhow::Result;

pub async fn serve_stdio() -> Result<()> {
    core_mcp_shared::serve_stdio_server(
        "skills",
        include_str!("../tool_spec.json"),
        native::Dispatcher,
    )
    .await
}
