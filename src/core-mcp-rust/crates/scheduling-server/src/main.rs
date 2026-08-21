use anyhow::Result;

#[tokio::main]
async fn main() -> Result<()> {
    core_mcp_shared::init_logging();
    scheduling_server::serve_stdio().await
}
