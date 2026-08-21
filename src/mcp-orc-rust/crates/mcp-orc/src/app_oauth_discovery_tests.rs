use super::{RecoveryRuntime, ServerConnectionState, ServerRuntime};
use crate::config::ServerConfig;
use crate::oauth::{OAuthCoordinator, OAuthState};
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderValue, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use reqwest::Url;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::SystemTime;
use tempfile::tempdir;
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex, RwLock};

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

#[derive(Clone, Copy)]
struct DiscoveryHarnessOptions {
    advertised_resource_path: &'static str,
    challenge_scope: Option<&'static str>,
    protected_resource_scopes: &'static [&'static str],
    authorization_metadata_scopes: Option<&'static [&'static str]>,
    reject_registration_scope: bool,
}

impl Default for DiscoveryHarnessOptions {
    fn default() -> Self {
        Self {
            advertised_resource_path: "/mcp/",
            challenge_scope: Some("read:data write:data"),
            protected_resource_scopes: &["offline_access"],
            authorization_metadata_scopes: None,
            reject_registration_scope: false,
        }
    }
}

#[derive(Clone)]
struct DiscoveryState {
    challenge: String,
    protected_resource_metadata: Value,
    authorization_metadata: Value,
    registration_requests: Arc<StdMutex<Vec<Value>>>,
    reject_registration_scope: bool,
}

async fn auth_required(State(state): State<DiscoveryState>) -> impl IntoResponse {
    (
        StatusCode::UNAUTHORIZED,
        [(
            "WWW-Authenticate",
            HeaderValue::from_str(&state.challenge).unwrap(),
        )],
        "auth required",
    )
}

async fn protected_resource_metadata(State(state): State<DiscoveryState>) -> Json<Value> {
    Json(state.protected_resource_metadata.clone())
}

async fn authorization_metadata(State(state): State<DiscoveryState>) -> Json<Value> {
    Json(state.authorization_metadata.clone())
}

async fn register_client(
    State(state): State<DiscoveryState>,
    body: Bytes,
) -> (StatusCode, Json<Value>) {
    let payload: Value = serde_json::from_slice(&body).unwrap();
    state
        .registration_requests
        .lock()
        .unwrap()
        .push(payload.clone());
    if state.reject_registration_scope && payload.get("scope").is_some() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "invalid_client_metadata",
                "error_description": "Requested scopes are invalid or not supported"
            })),
        );
    }

    (
        StatusCode::OK,
        Json(json!({
            "client_id": "dynamic-client",
            "redirect_uris": ["http://localhost:3834/callback"],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none"
        })),
    )
}

struct DiscoveryHarness {
    base_url: String,
    shutdown: Option<oneshot::Sender<()>>,
    registration_requests: Arc<StdMutex<Vec<Value>>>,
}

impl DiscoveryHarness {
    async fn spawn(options: DiscoveryHarnessOptions) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let base_url = format!("http://{address}");
        let challenge = match options.challenge_scope {
            Some(scope) => {
                format!(r#"Bearer resource_metadata="{base_url}/prm", scope="{scope}""#)
            }
            None => format!(r#"Bearer resource_metadata="{base_url}/prm""#),
        };
        let mut authorization_metadata_body = json!({
            "authorization_endpoint": format!("{base_url}/authorize"),
            "token_endpoint": format!("{base_url}/token"),
            "registration_endpoint": format!("{base_url}/register")
        });
        if let Some(scopes) = options.authorization_metadata_scopes {
            authorization_metadata_body
                .as_object_mut()
                .unwrap()
                .insert("scopes_supported".to_string(), json!(scopes));
        }
        let registration_requests = Arc::new(StdMutex::new(Vec::new()));
        let state = DiscoveryState {
            challenge,
            protected_resource_metadata: json!({
                "authorization_servers": [base_url.clone()],
                "resource": format!("{base_url}{}", options.advertised_resource_path),
                "scopes_supported": options.protected_resource_scopes
            }),
            authorization_metadata: authorization_metadata_body,
            registration_requests: registration_requests.clone(),
            reject_registration_scope: options.reject_registration_scope,
        };
        let router = Router::new()
            .route("/mcp", get(auth_required))
            .route("/mcp/", get(auth_required))
            .route("/prm", get(protected_resource_metadata))
            .route(
                "/.well-known/oauth-authorization-server",
                get(authorization_metadata),
            )
            .route(
                "/.well-known/openid-configuration",
                get(authorization_metadata),
            )
            .route(
                "/authorize",
                get(|| async { (StatusCode::OK, "authorize") }),
            )
            .route("/register", post(register_client))
            .route(
                "/token",
                post(|| async { Json(json!({"access_token": "fresh-token"})) }),
            )
            .with_state(state);
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        tokio::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        Self {
            base_url,
            shutdown: Some(shutdown_tx),
            registration_requests,
        }
    }

    fn last_registration_request(&self) -> Option<Value> {
        self.registration_requests.lock().unwrap().last().cloned()
    }
}

impl Drop for DiscoveryHarness {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

fn discovered_server_config(base_url: &str, mcp_path: &str) -> ServerConfig {
    ServerConfig {
        server_type: Some("streamable-http".to_string()),
        url: Some(format!("{base_url}{mcp_path}")),
        command: None,
        args: Vec::new(),
        env: BTreeMap::new(),
        sensitive_env_vars: Vec::new(),
        oauth: None,
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
async fn runtime_discovers_oauth_for_server_without_explicit_oauth_config() {
    let _env_lock = crate::test_env_lock();
    let temp_home = tempdir().unwrap();
    let _env = EnvGuard::set(&[("HOME", temp_home.path().to_string_lossy().into_owned())]);

    let harness = DiscoveryHarness::spawn(DiscoveryHarnessOptions::default()).await;
    let coordinator = Arc::new(OAuthCoordinator::new());
    let runtime = ServerRuntime::new(
        "dynamic_discovery_runtime".to_string(),
        discovered_server_config(&harness.base_url, "/mcp/"),
        coordinator.clone(),
    )
    .await
    .unwrap();

    assert!(runtime.oauth_runtime().await.is_none());

    let error = runtime.ensure_connected().await.unwrap_err().to_string();
    assert!(error.contains("OAuth authorization required"));
    assert!(error.contains("authorization_url="));
    assert!(runtime.state.read().await.session.is_none());

    let oauth = runtime
        .oauth_runtime()
        .await
        .expect("runtime should cache discovered OAuth binding");
    assert_eq!(
        oauth.oauth_config().server_url.as_deref(),
        Some(format!("{}/mcp/", harness.base_url).as_str())
    );
    assert_eq!(
        oauth.oauth_config().configured_resource().as_deref(),
        Some(format!("{}/mcp/", harness.base_url).as_str())
    );

    let handshake = coordinator
        .get_handshake("dynamic_discovery_runtime")
        .await
        .unwrap();
    assert_eq!(handshake.state, OAuthState::Active);
    assert!(handshake.authorization_url.is_some());
}

#[tokio::test]
async fn runtime_uses_metadata_scopes_without_sending_scope_in_dynamic_registration() {
    let _env_lock = crate::test_env_lock();
    let temp_home = tempdir().unwrap();
    let _env = EnvGuard::set(&[("HOME", temp_home.path().to_string_lossy().into_owned())]);

    let harness = DiscoveryHarness::spawn(DiscoveryHarnessOptions {
        challenge_scope: None,
        protected_resource_scopes: &[],
        authorization_metadata_scopes: Some(&[
            "offline_access",
            "job_seeker.profile.read",
            "job_seeker.company.details.read",
            "job_seeker.jobs.search",
        ]),
        reject_registration_scope: true,
        ..DiscoveryHarnessOptions::default()
    })
    .await;
    let coordinator = Arc::new(OAuthCoordinator::new());
    let runtime = ServerRuntime::new(
        "dynamic_discovery_metadata_scope_runtime".to_string(),
        discovered_server_config(&harness.base_url, "/mcp/"),
        coordinator.clone(),
    )
    .await
    .unwrap();

    let error = runtime.ensure_connected().await.unwrap_err().to_string();
    assert!(error.contains("OAuth authorization required"));
    assert!(error.contains("authorization_url="));

    let oauth = runtime
        .oauth_runtime()
        .await
        .expect("runtime should cache discovered OAuth binding");
    assert!(oauth.oauth_config().configured_scopes().is_empty());

    let registration_request = harness
        .last_registration_request()
        .expect("dynamic registration should be attempted");
    assert!(registration_request.get("scope").is_none());

    let handshake = coordinator
        .get_handshake("dynamic_discovery_metadata_scope_runtime")
        .await
        .unwrap();
    assert_eq!(handshake.state, OAuthState::Active);
    let authorization_url = handshake.authorization_url.unwrap();
    let parsed = Url::parse(&authorization_url).unwrap();
    let scope = parsed
        .query_pairs()
        .find_map(|(key, value)| (key == "scope").then(|| value.into_owned()));
    assert_eq!(
        scope.as_deref(),
        Some(
            "offline_access job_seeker.profile.read job_seeker.company.details.read job_seeker.jobs.search"
        )
    );
}

#[tokio::test]
async fn discovery_runtime_state_helper_can_construct_without_session() {
    let runtime = Arc::new(ServerRuntime {
        id: "noop".to_string(),
        config: discovered_server_config("http://127.0.0.1:9", "/mcp"),
        oauth: RwLock::new(None),
        oauth_coordinator: Arc::new(OAuthCoordinator::new()),
        connect_lock: Mutex::new(()),
        recovery: RecoveryRuntime::default(),
        state: RwLock::new(ServerConnectionState {
            session: None,
            tools: BTreeMap::new(),
            openapi: json!({"openapi": "3.1.0"}),
            title: "noop".to_string(),
            version: None,
            error: None,
            last_activity_at: Some(SystemTime::now()),
        }),
    });
    assert!(runtime.oauth_runtime().await.is_none());
}
