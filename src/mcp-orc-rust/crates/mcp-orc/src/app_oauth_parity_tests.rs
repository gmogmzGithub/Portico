use super::{RecoveryRuntime, ServerConnectionState, ServerRuntime};
use crate::config::ServerConfig;
use crate::oauth::{OAuthCoordinator, OAuthState};
use serde_json::json;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::SystemTime;
use tokio::sync::{Mutex, RwLock};

fn non_dcr_config() -> ServerConfig {
    ServerConfig {
        server_type: Some("streamable-http".to_string()),
        url: Some("http://127.0.0.1:9/mcp".to_string()),
        command: None,
        args: Vec::new(),
        env: BTreeMap::new(),
        sensitive_env_vars: Vec::new(),
        oauth: Some(json!({
            "type": "non-dcr",
            "authorization_endpoint": "https://accounts.google.com/o/oauth2/v2/auth",
            "token_endpoint": "https://oauth2.googleapis.com/token",
            "credentials_source": {
                "type": "inline",
                "client_id": "client-id",
                "client_secret": "client-secret"
            }
        })),
        headers: None,
        disabled_tools: Vec::new(),
        tool_rename_mapping: BTreeMap::new(),
        tool_call_timeout: None,
        client_header_forwarding: None,
        http_subprocess: None,
        extra: BTreeMap::new(),
    }
}

#[tokio::test]
async fn non_dcr_servers_require_authorization_before_connecting() {
    let coordinator = Arc::new(OAuthCoordinator::new());
    let runtime = ServerRuntime::new(
        "google_workspace".to_string(),
        non_dcr_config(),
        coordinator.clone(),
    )
    .await
    .unwrap();

    let error = runtime.ensure_connected().await.unwrap_err().to_string();
    assert!(error.contains("OAuth authorization required"));
    assert!(error.contains("authorization_url="));

    let handshake = coordinator.get_handshake("google_workspace").await.unwrap();
    assert_eq!(handshake.state, OAuthState::Active);
    assert!(handshake.authorization_url.is_some());
}

#[tokio::test]
async fn preconnect_auth_gate_keeps_runtime_disconnected() {
    let coordinator = Arc::new(OAuthCoordinator::new());
    let runtime = Arc::new(ServerRuntime {
        id: "google_workspace".to_string(),
        config: non_dcr_config(),
        oauth: RwLock::new(Some(
            crate::oauth::OAuthBinding::new(
                "google_workspace",
                &non_dcr_config(),
                coordinator.clone(),
            )
            .await
            .unwrap(),
        )),
        oauth_coordinator: coordinator,
        connect_lock: Mutex::new(()),
        recovery: RecoveryRuntime::default(),
        state: RwLock::new(ServerConnectionState {
            session: None,
            tools: BTreeMap::new(),
            openapi: json!({"openapi": "3.1.0"}),
            title: "google_workspace".to_string(),
            version: None,
            error: None,
            last_activity_at: Some(SystemTime::now()),
        }),
    });

    let error = runtime.ensure_connected().await.unwrap_err().to_string();
    assert!(error.contains("authorization_url="));
    assert!(runtime.state.read().await.session.is_none());
}
