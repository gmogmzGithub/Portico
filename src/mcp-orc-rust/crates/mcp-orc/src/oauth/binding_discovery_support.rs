use anyhow::{Context, Result};
use log::info;
use rmcp::transport::auth::{AuthorizationManager, AuthorizationMetadata};

pub async fn discover_metadata_from_authorization_server(
    server_name: &str,
    authorization_server: Option<&str>,
) -> Result<Option<AuthorizationMetadata>> {
    let Some(discovery_base) = authorization_server
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };

    info!(
        "[{}] retrying OAuth metadata discovery using authorization server {}",
        server_name, discovery_base
    );

    let temp_manager = AuthorizationManager::new(discovery_base.to_string())
        .await
        .with_context(|| format!("failed to create discovery manager for {discovery_base}"))?;
    let metadata = temp_manager
        .discover_metadata()
        .await
        .with_context(|| format!("failed to discover OAuth metadata from {discovery_base}"))?;
    Ok(Some(metadata))
}
