use super::{OAuthBinding, OAuthCoordinator};
use crate::config::ServerConfig;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

#[derive(Clone)]
struct TestState {
    base_url: String,
    auth_base_url: String,
    issuer_base_url: String,
    requests: Arc<Mutex<Vec<String>>>,
}

struct TestServer {
    base_url: String,
    requests: Arc<Mutex<Vec<String>>>,
    task: JoinHandle<()>,
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl TestServer {
    async fn spawn() -> Self {
        async fn handler(
            State(state): State<TestState>,
            uri: axum::http::Uri,
        ) -> (StatusCode, Json<Value>) {
            let path = uri.path().to_string();
            state.requests.lock().unwrap().push(path.clone());
            let body = match path.as_str() {
                "/.well-known/oauth-protected-resource" => json!({
                    "authorization_servers": [state.auth_base_url],
                    "resource": format!("{}/mcp", state.base_url),
                    "scopes_supported": ["offline_access", "scope-a"]
                }),
                "/.well-known/oauth-authorization-server/auth" => json!({"error":"missing"}),
                "/auth/.well-known/openid-configuration" => json!({"error":"missing"}),
                "/.well-known/oauth-authorization-server" => json!({"error":"missing"}),
                "/auth/.well-known/oauth-protected-resource" => json!({
                    "authorization_servers": [state.issuer_base_url]
                }),
                "/issuer/.well-known/openid-configuration" => json!({
                    "authorization_endpoint": format!("{}/authorize", state.issuer_base_url),
                    "token_endpoint": format!("{}/token", state.issuer_base_url),
                    "registration_endpoint": format!("{}/register", state.issuer_base_url)
                }),
                _ => json!({"error":"missing"}),
            };
            let status = if body.get("error").is_some() {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::OK
            };
            (status, Json(body))
        }

        async fn registration_handler(
            State(state): State<TestState>,
            uri: axum::http::Uri,
        ) -> (StatusCode, Json<Value>) {
            state.requests.lock().unwrap().push(uri.path().to_string());
            (
                StatusCode::OK,
                Json(json!({
                    "client_id": "test-client-id",
                    "token_endpoint_auth_method": "none",
                    "redirect_uris": [format!("{}/callback", state.base_url)],
                    "grant_types": ["authorization_code", "refresh_token"],
                    "response_types": ["code"]
                })),
            )
        }

        let requests = Arc::new(Mutex::new(Vec::new()));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let base_url = format!("http://{}", address);
        let auth_base_url = format!("{}/auth", base_url);
        let issuer_base_url = format!("{}/issuer", base_url);
        let router = Router::new()
            .route("/mcp", get(handler))
            .route("/.well-known/oauth-protected-resource", get(handler))
            .route("/.well-known/oauth-authorization-server", get(handler))
            .route("/.well-known/oauth-authorization-server/auth", get(handler))
            .route("/auth/.well-known/openid-configuration", get(handler))
            .route("/auth/.well-known/oauth-protected-resource", get(handler))
            .route("/issuer/.well-known/openid-configuration", get(handler))
            .route("/issuer/register", post(registration_handler))
            .with_state(TestState {
                base_url: base_url.clone(),
                auth_base_url,
                issuer_base_url,
                requests: requests.clone(),
            });
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self {
            base_url,
            requests,
            task,
        }
    }
}

fn base_config(base_url: &str) -> ServerConfig {
    ServerConfig {
        server_type: Some("streamable-http".to_string()),
        url: Some(format!("{base_url}/mcp")),
        command: None,
        args: Vec::new(),
        env: BTreeMap::new(),
        sensitive_env_vars: Vec::new(),
        oauth: Some(json!({
            "server_url": base_url,
            "resource": format!("{base_url}/mcp"),
            "client_metadata": {
                "client_name": "Portico",
                "token_endpoint_auth_method": "none",
                "scope": "offline_access scope-a"
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
async fn ensure_authorization_url_retries_with_discovered_authorization_server() {
    let _env_lock = crate::test_env_lock();
    let server = TestServer::spawn().await;
    let coordinator = Arc::new(OAuthCoordinator::new());
    let binding = OAuthBinding::new("data-plat-mcp", &base_config(&server.base_url), coordinator)
        .await
        .unwrap();

    let authorization_url = binding.ensure_authorization_url(false).await.unwrap();

    assert!(authorization_url.contains("/issuer/authorize"));
    let requests = server.requests.lock().unwrap().clone();
    assert!(requests.contains(&"/.well-known/oauth-protected-resource".to_string()));
    assert!(requests.contains(&"/auth/.well-known/oauth-protected-resource".to_string()));
    assert!(requests.contains(&"/issuer/.well-known/openid-configuration".to_string()));
}
