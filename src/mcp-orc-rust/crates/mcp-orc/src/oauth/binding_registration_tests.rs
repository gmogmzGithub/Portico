use super::OAuthBinding;
use crate::config::ServerConfig;
use crate::oauth::OAuthCoordinator;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use tempfile::tempdir;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

#[derive(Clone)]
struct RegistrationState {
    requests: Arc<Mutex<Vec<Value>>>,
}

struct RegistrationServer {
    base_url: String,
    requests: Arc<Mutex<Vec<Value>>>,
    task: JoinHandle<()>,
}

impl Drop for RegistrationServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl RegistrationServer {
    async fn spawn() -> Self {
        async fn register_handler(
            State(state): State<RegistrationState>,
            body: Bytes,
        ) -> (StatusCode, Json<Value>) {
            let payload: Value = serde_json::from_slice(&body).unwrap();
            state.requests.lock().unwrap().push(payload);
            (
                StatusCode::OK,
                Json(json!({
                    "client_id": "registered-client",
                    "redirect_uris": ["http://localhost:3834/callback"],
                    "grant_types": ["authorization_code", "refresh_token"],
                    "response_types": ["code"],
                    "token_endpoint_auth_method": "none"
                })),
            )
        }

        let requests = Arc::new(Mutex::new(Vec::new()));
        let router = Router::new()
            .route("/register", post(register_handler))
            .with_state(RegistrationState {
                requests: requests.clone(),
            });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });

        Self {
            base_url: format!("http://{}", address),
            requests,
            task,
        }
    }

    fn last_request(&self) -> Value {
        self.requests.lock().unwrap().last().cloned().unwrap()
    }
}

fn server_config(oauth: Value) -> ServerConfig {
    ServerConfig {
        server_type: Some("streamable-http".to_string()),
        url: Some("http://example.test/mcp".to_string()),
        command: None,
        args: Vec::new(),
        env: BTreeMap::new(),
        sensitive_env_vars: Vec::new(),
        oauth: Some(oauth),
        headers: None,
        disabled_tools: Vec::new(),
        tool_rename_mapping: BTreeMap::new(),
        tool_call_timeout: None,
        client_header_forwarding: None,
        http_subprocess: None,
        extra: BTreeMap::new(),
    }
}

#[derive(Debug)]
struct EnvGuard {
    previous: Vec<(String, Option<String>)>,
}

impl EnvGuard {
    fn set(entries: &[(&str, String)]) -> Self {
        let mut previous = Vec::new();
        for (key, value) in entries {
            previous.push(((*key).to_string(), std::env::var(key).ok()));
            std::env::set_var(key, value);
        }
        Self { previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (key, value) in self.previous.drain(..) {
            if let Some(value) = value {
                std::env::set_var(key, value);
            } else {
                std::env::remove_var(key);
            }
        }
    }
}

#[tokio::test]
async fn dynamic_registration_omits_scope_when_not_configured() {
    let _env_lock = crate::test_env_lock();
    let temp_home = tempdir().unwrap();
    let _env = EnvGuard::set(&[("HOME", temp_home.path().to_string_lossy().into_owned())]);
    let server = RegistrationServer::spawn().await;
    let config = server_config(json!({
        "authorization_endpoint": format!("{}/authorize", server.base_url),
        "token_endpoint": format!("{}/token", server.base_url),
        "registration_endpoint": format!("{}/register", server.base_url)
    }));
    let binding = OAuthBinding::new(
        "binding-registration-no-scope",
        &config,
        Arc::new(OAuthCoordinator::new()),
    )
    .await
    .unwrap();

    let auth_url = binding.ensure_authorization_url(true).await.unwrap();
    assert!(auth_url.starts_with(&format!("{}/authorize?", server.base_url)));

    let request = server.last_request();
    assert!(request.get("scope").is_none());
    assert_eq!(request["client_name"], "Portico");
    assert_eq!(request["token_endpoint_auth_method"], "none");
}

#[tokio::test]
async fn dynamic_registration_includes_explicit_scope_configuration() {
    let _env_lock = crate::test_env_lock();
    let temp_home = tempdir().unwrap();
    let _env = EnvGuard::set(&[("HOME", temp_home.path().to_string_lossy().into_owned())]);
    let server = RegistrationServer::spawn().await;
    let config = server_config(json!({
        "authorization_endpoint": format!("{}/authorize", server.base_url),
        "token_endpoint": format!("{}/token", server.base_url),
        "registration_endpoint": format!("{}/register", server.base_url),
        "scopes": ["scope.one", "scope.two"]
    }));
    let binding = OAuthBinding::new(
        "binding-registration-explicit",
        &config,
        Arc::new(OAuthCoordinator::new()),
    )
    .await
    .unwrap();

    binding.ensure_authorization_url(true).await.unwrap();

    let request = server.last_request();
    assert_eq!(request["scope"], "scope.one scope.two");
}
