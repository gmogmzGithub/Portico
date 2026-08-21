use super::{OAuthBinding, OAuthRefreshOutcome};
use crate::config::ServerConfig;
use crate::oauth::{CompatClientInfo, CompatTokenFile, OAuthCoordinator};
use axum::body::Bytes;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use rmcp::transport::streamable_http_client::AuthRequiredError;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::env;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

#[derive(Clone)]
struct ResponseSpec {
    status: axum::http::StatusCode,
    body: Value,
}

impl ResponseSpec {
    fn ok(body: Value) -> Self {
        Self {
            status: axum::http::StatusCode::OK,
            body,
        }
    }
}

#[derive(Clone, Debug)]
struct RequestRecord {
    path: String,
    body: String,
}

#[derive(Clone)]
struct TestState {
    responses: Arc<StdMutex<HashMap<String, ResponseSpec>>>,
    requests: Arc<StdMutex<Vec<RequestRecord>>>,
}

struct OAuthHttpServer {
    base_url: String,
    requests: Arc<StdMutex<Vec<RequestRecord>>>,
    task: JoinHandle<()>,
}

impl Drop for OAuthHttpServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl OAuthHttpServer {
    async fn spawn(responses: HashMap<String, ResponseSpec>) -> Self {
        async fn get_handler(
            State(state): State<TestState>,
            uri: axum::http::Uri,
        ) -> impl IntoResponse {
            render_response(&state, uri.path(), Bytes::new())
        }

        async fn post_handler(
            State(state): State<TestState>,
            uri: axum::http::Uri,
            _headers: HeaderMap,
            body: Bytes,
        ) -> impl IntoResponse {
            render_response(&state, uri.path(), body)
        }

        fn render_response(state: &TestState, path: &str, body: Bytes) -> axum::response::Response {
            state.requests.lock().unwrap().push(RequestRecord {
                path: path.to_string(),
                body: String::from_utf8_lossy(&body).into_owned(),
            });
            let spec = state
                .responses
                .lock()
                .unwrap()
                .get(path)
                .cloned()
                .unwrap_or_else(|| ResponseSpec {
                    status: axum::http::StatusCode::NOT_FOUND,
                    body: json!({"error":"missing"}),
                });
            (spec.status, Json(spec.body)).into_response()
        }

        let requests = Arc::new(StdMutex::new(Vec::new()));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let base_url = format!("http://{}", address);
        let responses = responses
            .into_iter()
            .map(|(path, spec)| {
                (
                    path,
                    ResponseSpec {
                        status: spec.status,
                        body: rewrite_self_urls(spec.body, &base_url),
                    },
                )
            })
            .collect();
        let router = Router::new()
            .route("/mcp", get(get_handler))
            .route("/prm-direct", get(get_handler))
            .route("/token", post(post_handler))
            .route("/register", post(post_handler))
            .route("/.well-known/oauth-authorization-server", get(get_handler))
            .with_state(TestState {
                responses: Arc::new(StdMutex::new(responses)),
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

    fn last_request(&self, path: &str) -> RequestRecord {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|record| record.path == path)
            .cloned()
            .unwrap()
    }
}

fn rewrite_self_urls(value: Value, base_url: &str) -> Value {
    match value {
        Value::String(raw) => Value::String(raw.replace("SELF", base_url)),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| rewrite_self_urls(item, base_url))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| (key, rewrite_self_urls(value, base_url)))
                .collect(),
        ),
        other => other,
    }
}

fn env_lock() -> MutexGuard<'static, ()> {
    super::oauth_test_env_lock()
}

struct TokenEnv {
    _guard: MutexGuard<'static, ()>,
    previous: Option<String>,
    path: PathBuf,
}

impl TokenEnv {
    fn new(test_name: &str) -> Self {
        let guard = env_lock();
        let previous = env::var("MCPO_TOKEN_STORAGE_DIR").ok();
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = env::temp_dir().join(format!("mcp-orc-parity-{test_name}-{unique}"));
        std::fs::create_dir_all(&path).unwrap();
        env::set_var("MCPO_TOKEN_STORAGE_DIR", &path);
        Self {
            _guard: guard,
            previous,
            path,
        }
    }
}

impl Drop for TokenEnv {
    fn drop(&mut self) {
        if let Some(previous) = self.previous.as_ref() {
            env::set_var("MCPO_TOKEN_STORAGE_DIR", previous);
        } else {
            env::remove_var("MCPO_TOKEN_STORAGE_DIR");
        }
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn jwt(payload: Value) -> String {
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(&payload).unwrap());
    format!("eyJhbGciOiJub25lIn0.{encoded}.")
}

fn future_exp() -> i64 {
    (SystemTime::now() + Duration::from_secs(3600))
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn expired_token() -> CompatTokenFile {
    CompatTokenFile {
        access_token: jwt(json!({"exp": 1, "aud": "https://stale.example/token"})),
        token_type: Some("Bearer".to_string()),
        expires_in: Some(-1),
        refresh_token: Some("refresh-token".to_string()),
        scope: None,
        extra: Default::default(),
    }
}

async fn binding_for(
    name: &str,
    config: ServerConfig,
) -> (Arc<OAuthBinding>, Arc<OAuthCoordinator>) {
    let coordinator = Arc::new(OAuthCoordinator::new());
    let binding = OAuthBinding::new(name, &config, coordinator.clone())
        .await
        .unwrap();
    (binding, coordinator)
}

#[tokio::test]
async fn refresh_or_reauthorize_reuses_active_authorization_url() {
    let _env = TokenEnv::new("cached-url");
    let (binding, coordinator) = binding_for(
        "glean",
        ServerConfig {
            server_type: Some("streamable-http".to_string()),
            url: Some("https://glean.example/mcp".to_string()),
            command: None,
            args: Vec::new(),
            env: BTreeMap::new(),
            sensitive_env_vars: Vec::new(),
            oauth: Some(json!({
                "authorization_endpoint": "https://issuer.example/authorize",
                "token_endpoint": "https://issuer.example/token",
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
        },
    )
    .await;
    coordinator
        .set_authorization_url(
            "glean",
            "https://issuer.example/authorize?state=existing".to_string(),
            true,
        )
        .await;

    let outcome = binding.refresh_or_reauthorize().await.unwrap();
    assert_eq!(
        outcome,
        OAuthRefreshOutcome::AuthorizationRequired(
            "https://issuer.example/authorize?state=existing".to_string()
        )
    );
}

#[tokio::test]
async fn auth_required_discovery_caches_resource_and_uses_discovered_metadata() {
    let _env = TokenEnv::new("discovery");
    let server = OAuthHttpServer::spawn(HashMap::from([
        (
            "/prm-direct".to_string(),
            ResponseSpec::ok(json!({
                "authorization_endpoint": "SELF/authorize",
                "token_endpoint": "SELF/token",
                "registration_endpoint": "SELF/register",
                "resource": "https://resource.example/mcp/default",
                "scopes_supported": ["openid", "offline_access"]
            })),
        ),
        (
            "/token".to_string(),
            ResponseSpec::ok(json!({
                "access_token": jwt(json!({"exp": future_exp(), "aud": "https://resource.example/mcp/default"})),
                "token_type": "Bearer",
                "expires_in": 3600
            })),
        ),
    ]))
    .await;
    let (binding, _) = binding_for(
        "glean",
        ServerConfig {
            server_type: Some("streamable-http".to_string()),
            url: Some(format!("{}/mcp", server.base_url)),
            command: None,
            args: Vec::new(),
            env: BTreeMap::new(),
            sensitive_env_vars: Vec::new(),
            oauth: Some(json!({
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
        },
    )
    .await;

    let authorization_url = binding
        .handle_auth_required(&AuthRequiredError {
            www_authenticate_header: format!(
                r#"Bearer resource_metadata="{}/prm-direct""#,
                server.base_url
            ),
        })
        .await
        .unwrap()
        .unwrap();
    assert!(authorization_url.starts_with(&format!("{}/authorize?", server.base_url)));

    binding
        .token_store
        .save_token_file(&expired_token())
        .unwrap();
    let access_token = binding.access_token().await.unwrap().unwrap();
    assert!(access_token.contains('.'));
    let refresh_request = server.last_request("/token");
    assert!(refresh_request
        .body
        .contains("resource=https%3A%2F%2Fresource.example%2Fmcp%2Fdefault"));
}

#[tokio::test]
async fn legacy_infer_resource_from_url_is_used_for_refresh_and_code_exchange() {
    let _env = TokenEnv::new("infer-resource");
    let server = OAuthHttpServer::spawn(HashMap::from([(
        "/token".to_string(),
        ResponseSpec::ok(json!({
            "access_token": jwt(json!({"exp": future_exp(), "aud": "SELF/mcp"})),
            "token_type": "Bearer",
            "expires_in": 3600,
            "refresh_token": "refresh-2"
        })),
    )]))
    .await;
    let mcp_url = format!("{}/mcp", server.base_url);
    let (binding, _) = binding_for(
        "google_workspace",
        ServerConfig {
            server_type: Some("streamable-http".to_string()),
            url: Some(mcp_url.clone()),
            command: None,
            args: Vec::new(),
            env: BTreeMap::new(),
            sensitive_env_vars: Vec::new(),
            oauth: Some(json!({
                "authorization_endpoint": format!("{}/authorize", server.base_url),
                "token_endpoint": format!("{}/token", server.base_url),
                "infer_resource_from_url": true,
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
        },
    )
    .await;

    binding
        .token_store
        .save_client_info(&CompatClientInfo {
            client_id: "client-id".to_string(),
            client_secret: Some("client-secret".to_string()),
            token_endpoint_auth_method: Some("client_secret_post".to_string()),
            ..Default::default()
        })
        .unwrap();
    binding
        .token_store
        .save_token_file(&expired_token())
        .unwrap();
    binding.access_token().await.unwrap();
    let refresh_request = server.last_request("/token");
    assert!(refresh_request.body.contains("resource="));

    let authorization_url = binding.ensure_authorization_url(true).await.unwrap();
    let state = reqwest::Url::parse(&authorization_url)
        .unwrap()
        .query_pairs()
        .find(|(key, _)| key == "state")
        .map(|(_, value)| value.to_string())
        .unwrap();
    binding.handle_callback("auth-code", &state).await.unwrap();
    let exchange_request = server.last_request("/token");
    assert!(
        exchange_request
            .body
            .contains("resource=http%3A%2F%2F127.0.0.1")
            || exchange_request
                .body
                .contains("resource=http%3A%2F%2Flocalhost")
    );
}

#[tokio::test]
async fn auth_required_scope_header_overrides_auth_url_scopes() {
    let _env = TokenEnv::new("challenge-scopes");
    let server = OAuthHttpServer::spawn(HashMap::new()).await;
    let (binding, _) = binding_for(
        "scoped",
        ServerConfig {
            server_type: Some("streamable-http".to_string()),
            url: Some(format!("{}/mcp", server.base_url)),
            command: None,
            args: Vec::new(),
            env: BTreeMap::new(),
            sensitive_env_vars: Vec::new(),
            oauth: Some(json!({
                "authorization_endpoint": format!("{}/authorize", server.base_url),
                "token_endpoint": format!("{}/token", server.base_url),
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
        },
    )
    .await;

    let authorization_url = binding
        .handle_auth_required(&AuthRequiredError {
            www_authenticate_header: r#"Bearer scope="read:data write:data""#.to_string(),
        })
        .await
        .unwrap()
        .unwrap();
    let parsed = reqwest::Url::parse(&authorization_url).unwrap();
    let scope = parsed
        .query_pairs()
        .find(|(key, _)| key == "scope")
        .map(|(_, value)| value.to_string())
        .unwrap();
    assert_eq!(scope, "read:data write:data");
}
