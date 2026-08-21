mod native;

use anyhow::Result;
use tracing::warn;

pub async fn serve_stdio() -> Result<()> {
    if let Some(interval) = native::agent_vm_cleanup_interval() {
        tokio::spawn(async move {
            loop {
                if let Err(error) = native::cleanup_agent_vms_once().await {
                    warn!("Agent VM cleanup sweep failed: {error:#}");
                }
                tokio::time::sleep(interval).await;
            }
        });
    }

    core_mcp_shared::serve_stdio_server(
        "agent-vm",
        include_str!("../tool_spec.json"),
        native::Dispatcher,
    )
    .await
}
