use super::{
    apply_sensitive_env_file_ingress, best_effort_zeroize_and_remove,
    call_tool_result_from_mcp_error, connect_server, connect_sse, connect_stdio,
    connect_streamable_http, find_auth_required_error, find_unexpected_unauthorized_error,
    http_subprocess_mcp_url, http_subprocess_readiness_url, oauth_token_cache_dir, parse_headers,
    provider_readiness_from_status, ready_body_sync_narration, sanitize_headers_for_oauth_transport,
    scrub_slack_plaintext_token_env, should_retry_http_subprocess_after_oauth_refresh,
    streamable_http_auth_challenge_from_connect_error, write_oauth_token_file,
    HttpSubprocessConfig, ProviderReadiness,
};
use crate::config::ServerConfig;
use crate::oauth::{
    CompatClientInfo, CompatTokenFile, CompatTokenStore, OAuthBinding, OAuthCoordinator,
    OAuthState, OAuthTransportError,
};
use crate::streamable_http_reqwest_compat::CompatibleReqwestStreamableHttpClient;
use crate::test_support::EchoServer;
use axum::response::Redirect;
use axum::routing::{any, post};
use axum::{extract::State, http::HeaderMap, response::IntoResponse, Router};
use http::HeaderName;
use rmcp::model::{
    CallToolResult, ErrorCode, Implementation, ListToolsResult, RequestId, ServerCapabilities,
    ServerJsonRpcMessage, ServerResult, Tool,
};
use rmcp::service::ClientInitializeError;
use rmcp::transport::streamable_http_client::{
    AuthRequiredError, StreamableHttpClientTransport, StreamableHttpError,
};
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, tower::StreamableHttpService,
};
use rmcp::transport::StreamableHttpServerConfig;
use serde_json::json;
use serial_test::serial;
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tempfile::tempdir;
use tokio::net::TcpListener;
use tokio::process::Command;
use tokio::sync::oneshot;

enum WorkingSlashVariant {
    TrailingSlash,
    NoTrailingSlash,
}

#[test]
fn provider_readiness_statuses_fail_closed() {
    assert_eq!(
        provider_readiness_from_status(http::StatusCode::OK),
        ProviderReadiness::Ready
    );
    assert_eq!(
        provider_readiness_from_status(http::StatusCode::NO_CONTENT),
        ProviderReadiness::Ready
    );
    assert_eq!(
        provider_readiness_from_status(http::StatusCode::SERVICE_UNAVAILABLE),
        ProviderReadiness::Starting
    );
    assert_eq!(
        provider_readiness_from_status(http::StatusCode::NOT_FOUND),
        ProviderReadiness::Unsupported
    );
    assert_eq!(
        provider_readiness_from_status(http::StatusCode::METHOD_NOT_ALLOWED),
        ProviderReadiness::Unsupported
    );
    for status in [
        http::StatusCode::UNAUTHORIZED,
        http::StatusCode::INTERNAL_SERVER_ERROR,
    ] {
        assert_eq!(
            provider_readiness_from_status(status),
            ProviderReadiness::ProbeFailed
        );
    }
}

#[test]
fn ready_body_sync_narration_keeps_only_live_sync_payloads() {
    // Never-block provider narrating a background sync: keep the payload
    // (and, at the call site, skip the ready latch so probes continue).
    let narration = ready_body_sync_narration(Some(json!({
        "ready": true,
        "syncing": true,
        "phase": "users",
        "elapsed_seconds": 1680,
        "progress_percent": 9
    })));
    assert_eq!(
        narration
            .as_ref()
            .and_then(|p| p.get("progress_percent"))
            .and_then(serde_json::Value::as_i64),
        Some(9)
    );

    // Sync finished, legacy shapes, or non-JSON bodies all latch ready.
    assert_eq!(
        ready_body_sync_narration(Some(json!({"ready": true, "syncing": false}))),
        None
    );
    assert_eq!(ready_body_sync_narration(Some(json!({"ready": true}))), None);
    assert_eq!(
        ready_body_sync_narration(Some(json!({"syncing": "yes"}))),
        None,
        "non-boolean syncing must not be trusted"
    );
    assert_eq!(ready_body_sync_narration(None), None);
}

#[test]
fn slack_readiness_endpoint_is_explicit_and_backward_compatible() {
    let default_config: HttpSubprocessConfig = serde_json::from_value(json!({})).unwrap();
    assert_eq!(
        http_subprocess_readiness_url("slack", &default_config).as_deref(),
        Some("http://127.0.0.1:8080/health")
    );
    assert_eq!(
        http_subprocess_readiness_url("other", &default_config),
        None
    );

    let explicit: HttpSubprocessConfig =
        serde_json::from_value(json!({"readiness_endpoint": "ready"})).unwrap();
    assert_eq!(
        http_subprocess_readiness_url("other", &explicit).as_deref(),
        Some("http://127.0.0.1:8080/ready")
    );
}

struct StreamableHttpSlashFallbackHarness {
    base_url: String,
    shutdown: Option<oneshot::Sender<()>>,
}

#[derive(Clone)]
struct EmptyNotificationCompatState {
    session_id: Arc<str>,
}

#[derive(Clone)]
struct OAuthSlashCompatibilityState {
    compat: EmptyNotificationCompatState,
    working_hits: Arc<AtomicUsize>,
    refresh_hits: Arc<AtomicUsize>,
    required_access_token: Arc<str>,
    include_challenge: bool,
    reject_all_tokens: bool,
}

async fn compatible_streamable_http_handler(
    State(state): State<EmptyNotificationCompatState>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<serde_json::Value>,
) -> impl IntoResponse {
    let method = body
        .get("method")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();

    match method {
        "initialize" => {
            let id = body
                .get("id")
                .cloned()
                .and_then(|value| serde_json::from_value::<RequestId>(value).ok())
                .unwrap_or(RequestId::Number(1));
            let response = serde_json::to_string(&ServerJsonRpcMessage::response(
                ServerResult::InitializeResult(
                    rmcp::model::InitializeResult::new(ServerCapabilities::default())
                        .with_server_info(Implementation::new("compat-streamable-http", "1.0.0")),
                ),
                id,
            ))
            .unwrap();
            let mut response_headers = HeaderMap::new();
            response_headers.insert(
                "content-type",
                http::HeaderValue::from_static("application/json"),
            );
            response_headers.insert(
                "mcp-session-id",
                http::HeaderValue::from_str(state.session_id.as_ref()).unwrap(),
            );
            (http::StatusCode::OK, response_headers, response).into_response()
        }
        "notifications/initialized" => {
            assert_eq!(
                headers
                    .get("mcp-session-id")
                    .and_then(|value| value.to_str().ok()),
                Some(state.session_id.as_ref())
            );
            (http::StatusCode::OK, HeaderMap::new(), String::new()).into_response()
        }
        "tools/list" => {
            let id = body
                .get("id")
                .cloned()
                .and_then(|value| serde_json::from_value::<RequestId>(value).ok())
                .unwrap_or(RequestId::Number(1));
            let response = serde_json::to_string(&ServerJsonRpcMessage::response(
                ServerResult::ListToolsResult(ListToolsResult {
                    meta: None,
                    next_cursor: None,
                    tools: vec![Tool::new(
                        "echo",
                        "Echo",
                        std::sync::Arc::new(serde_json::Map::new()),
                    )],
                }),
                id,
            ))
            .unwrap();
            let mut response_headers = HeaderMap::new();
            response_headers.insert(
                "content-type",
                http::HeaderValue::from_static("application/json"),
            );
            response_headers.insert(
                "mcp-session-id",
                http::HeaderValue::from_str(state.session_id.as_ref()).unwrap(),
            );
            (http::StatusCode::OK, response_headers, response).into_response()
        }
        _ => (
            http::StatusCode::BAD_REQUEST,
            HeaderMap::new(),
            "unknown method".to_string(),
        )
            .into_response(),
    }
}

fn oauth_unauthorized_response(include_challenge: bool) -> axum::response::Response {
    let mut headers = HeaderMap::new();
    headers.insert(
        "content-type",
        http::HeaderValue::from_static("application/json"),
    );
    if include_challenge {
        headers.insert(
            "www-authenticate",
            http::HeaderValue::from_static("Bearer realm=\"compat\""),
        );
    }
    (
        http::StatusCode::UNAUTHORIZED,
        headers,
        r#"{"errors":["Unauthorized"]}"#,
    )
        .into_response()
}

async fn oauth_incompatible_candidate_handler(
    State(state): State<OAuthSlashCompatibilityState>,
) -> axum::response::Response {
    oauth_unauthorized_response(state.include_challenge)
}

async fn oauth_compatible_candidate_handler(
    State(state): State<OAuthSlashCompatibilityState>,
    headers: HeaderMap,
    body: axum::Json<serde_json::Value>,
) -> axum::response::Response {
    state.working_hits.fetch_add(1, Ordering::SeqCst);
    let expected = format!("Bearer {}", state.required_access_token);
    let authorized = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value == expected);
    if state.reject_all_tokens || !authorized {
        return oauth_unauthorized_response(state.include_challenge);
    }
    compatible_streamable_http_handler(State(state.compat), headers, body)
        .await
        .into_response()
}

async fn oauth_refresh_token_handler(
    State(state): State<OAuthSlashCompatibilityState>,
) -> impl IntoResponse {
    state.refresh_hits.fetch_add(1, Ordering::SeqCst);
    axum::Json(json!({
        "access_token": "refreshed-token",
        "token_type": "Bearer",
        "expires_in": 3600,
        "refresh_token": "rotated-refresh-token"
    }))
}

struct EmptyNotificationCompatHarness {
    base_url: String,
    shutdown: Option<oneshot::Sender<()>>,
}

struct OAuthSlashCompatibilityHarness {
    base_url: String,
    working_hits: Arc<AtomicUsize>,
    refresh_hits: Arc<AtomicUsize>,
    shutdown: Option<oneshot::Sender<()>>,
}

impl EmptyNotificationCompatHarness {
    async fn spawn() -> Self {
        let state = EmptyNotificationCompatState {
            session_id: Arc::<str>::from("compat-session"),
        };
        let router = Router::new()
            .route("/", post(compatible_streamable_http_handler))
            .with_state(state);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        tokio::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        Self {
            base_url: format!("http://{address}/"),
            shutdown: Some(shutdown_tx),
        }
    }
}

impl Drop for EmptyNotificationCompatHarness {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

impl OAuthSlashCompatibilityHarness {
    async fn spawn(
        include_challenge: bool,
        required_access_token: &str,
        reject_all_tokens: bool,
    ) -> Self {
        let state = OAuthSlashCompatibilityState {
            compat: EmptyNotificationCompatState {
                session_id: Arc::<str>::from("oauth-slash-compat-session"),
            },
            working_hits: Arc::new(AtomicUsize::new(0)),
            refresh_hits: Arc::new(AtomicUsize::new(0)),
            required_access_token: Arc::<str>::from(required_access_token),
            include_challenge,
            reject_all_tokens,
        };
        let router = Router::new()
            .route("/v1/tools", post(oauth_incompatible_candidate_handler))
            .route("/v1/tools/", post(oauth_compatible_candidate_handler))
            .route("/token", post(oauth_refresh_token_handler))
            .with_state(state.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        tokio::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        Self {
            base_url: format!("http://{address}"),
            working_hits: state.working_hits,
            refresh_hits: state.refresh_hits,
            shutdown: Some(shutdown_tx),
        }
    }
}

impl Drop for OAuthSlashCompatibilityHarness {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

impl StreamableHttpSlashFallbackHarness {
    async fn spawn(working_variant: WorkingSlashVariant) -> Self {
        let service: StreamableHttpService<EchoServer, LocalSessionManager> =
            StreamableHttpService::new(
                || Ok(EchoServer::new()),
                Default::default(),
                StreamableHttpServerConfig {
                    stateful_mode: true,
                    sse_keep_alive: None,
                    ..Default::default()
                },
            );

        let bad_redirect_target = match working_variant {
            WorkingSlashVariant::TrailingSlash => "http://127.0.0.1:1/v1/tools/",
            WorkingSlashVariant::NoTrailingSlash => "http://127.0.0.1:1/v1/tools",
        };

        let router = match working_variant {
            WorkingSlashVariant::TrailingSlash => Router::new()
                .route(
                    "/v1/tools",
                    any(move || async move { Redirect::temporary(bad_redirect_target) }),
                )
                .route_service("/v1/tools/", service),
            WorkingSlashVariant::NoTrailingSlash => {
                Router::new().route_service("/v1/tools", service).route(
                    "/v1/tools/",
                    any(move || async move { Redirect::temporary(bad_redirect_target) }),
                )
            }
        };

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        tokio::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        Self {
            base_url: format!("http://{address}"),
            shutdown: Some(shutdown_tx),
        }
    }
}

impl Drop for StreamableHttpSlashFallbackHarness {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

fn base_config() -> ServerConfig {
    ServerConfig {
        server_type: Some("streamable-http".to_string()),
        url: Some("http://example.test/mcp".to_string()),
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

async fn oauth_slash_compat_runtime(
    harness: &OAuthSlashCompatibilityHarness,
    label: &str,
) -> (
    String,
    ServerConfig,
    CompatTokenStore,
    Arc<OAuthBinding>,
    Arc<OAuthCoordinator>,
) {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let server_id = format!("oauth-slash-{label}-{unique}");
    let mut config = base_config();
    config.url = Some(format!("{}/v1/tools/", harness.base_url));
    config.oauth = Some(json!({
        "type": "non-dcr",
        "authorization_endpoint": format!("{}/authorize", harness.base_url),
        "token_endpoint": format!("{}/token", harness.base_url),
        "resource": format!("{}/v1/tools", harness.base_url),
        "storage_type": "memory",
        "credentials_source": {
            "type": "inline",
            "client_id": "client-id"
        }
    }));

    let token_store = CompatTokenStore::with_storage_type(&server_id, Some("memory")).unwrap();
    token_store
        .save_client_info(&CompatClientInfo {
            client_id: "client-id".to_string(),
            token_endpoint_auth_method: Some("none".to_string()),
            ..Default::default()
        })
        .unwrap();
    token_store
        .save_token_file(&CompatTokenFile {
            access_token: "stored-token".to_string(),
            token_type: Some("Bearer".to_string()),
            expires_in: Some(3600),
            refresh_token: Some("refresh-token".to_string()),
            scope: None,
            extra: Default::default(),
        })
        .unwrap();

    let coordinator = Arc::new(OAuthCoordinator::new());
    let oauth = OAuthBinding::new(&server_id, &config, coordinator.clone())
        .await
        .unwrap();
    (server_id, config, token_store, oauth, coordinator)
}

fn test_python_command() -> String {
    std::env::var("MCPO_TEST_PYTHON")
        .ok()
        .map(|candidate| candidate.trim().to_string())
        .filter(|candidate| !candidate.is_empty())
        .or_else(|| {
            let system_python = "/usr/bin/python3";
            if std::path::Path::new(system_python).exists() {
                Some(system_python.to_string())
            } else {
                None
            }
        })
        .unwrap_or_else(|| "python3".to_string())
}

#[tokio::test]
async fn sensitive_env_file_ingress_resolves_only_declared_child_envs() {
    let dir = tempdir().unwrap();
    let secret_path = dir.path().join("child.secret");
    let unrelated_path = dir.path().join("unrelated.secret");
    fs::write(&secret_path, "child-secret\n").unwrap();
    fs::write(&unrelated_path, "unrelated-secret\n").unwrap();

    let mut config = base_config();
    config.env.insert(
        "CHILD_SECRET_FILE".to_string(),
        secret_path.display().to_string(),
    );
    config.env.insert(
        "UNRELATED_SECRET_FILE".to_string(),
        unrelated_path.display().to_string(),
    );
    config.sensitive_env_vars = vec!["CHILD_SECRET".to_string()];

    let mut process = Command::new(test_python_command());
    process.envs(&config.env);
    process.args([
        "-c",
        "import json, os; print(json.dumps({'child': os.environ.get('CHILD_SECRET'), 'child_file': os.environ.get('CHILD_SECRET_FILE'), 'unrelated': os.environ.get('UNRELATED_SECRET')}))",
    ]);
    apply_sensitive_env_file_ingress(&mut process, &config).unwrap();

    let output = process.output().await.unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let observed: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("child should print JSON");
    assert_eq!(observed["child"], "child-secret");
    assert_eq!(observed["child_file"], secret_path.display().to_string());
    assert_eq!(observed["unrelated"], serde_json::Value::Null);
}

#[tokio::test]
async fn slack_plaintext_token_env_is_scrubbed_before_spawn() {
    let mut process = Command::new(test_python_command());
    process.env("SLACK_MCP_XOXP_TOKEN", "raw-token");
    process.args([
        "-c",
        "import json, os; print(json.dumps({'xoxp': os.environ.get('SLACK_MCP_XOXP_TOKEN')}))",
    ]);

    scrub_slack_plaintext_token_env(&mut process, "slack");

    let output = process.output().await.unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let observed: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("child should print JSON");
    assert_eq!(observed["xoxp"], serde_json::Value::Null);
}

#[test]
fn parses_http_headers() {
    let mut config = base_config();
    config.headers = Some(json!({
        "x-test": "value"
    }));
    let headers = parse_headers(&config).unwrap();
    assert_eq!(headers.len(), 1);
}

#[test]
fn parse_headers_normalizes_raw_authorization_values_to_bearer() {
    let mut config = base_config();
    config.headers = Some(json!({
        "Authorization": "raw-token"
    }));
    let headers = parse_headers(&config).unwrap();
    let auth = headers
        .get(&HeaderName::from_static("authorization"))
        .and_then(|value| value.to_str().ok())
        .unwrap();
    assert_eq!(auth, "Bearer raw-token");
}

#[test]
fn parse_headers_preserves_existing_authorization_scheme() {
    let mut config = base_config();
    config.headers = Some(json!({
        "Authorization": "Basic abc123"
    }));
    let headers = parse_headers(&config).unwrap();
    let auth = headers
        .get(&HeaderName::from_static("authorization"))
        .and_then(|value| value.to_str().ok())
        .unwrap();
    assert_eq!(auth, "Basic abc123");
}

#[test]
fn rejects_invalid_headers() {
    let mut config = base_config();
    config.headers = Some(json!({
        "x-test": 1
    }));
    let error = parse_headers(&config).unwrap_err();
    assert!(error.to_string().contains("must be a string"));

    let mut config = base_config();
    config.headers = Some(json!(["bad"]));
    let error = parse_headers(&config).unwrap_err();
    assert!(error.to_string().contains("JSON object"));

    let mut config = base_config();
    config.headers = Some(json!({
        "bad\nname": "value"
    }));
    let error = parse_headers(&config).unwrap_err();
    assert!(error.to_string().contains("invalid header name"));

    let mut config = base_config();
    config.headers = Some(json!({
        "x-test": "bad\nvalue"
    }));
    let error = parse_headers(&config).unwrap_err();
    assert!(error.to_string().contains("invalid header value"));
}

#[test]
fn suppresses_conflicting_static_auth_headers_for_oauth_transport() {
    let mut config = base_config();
    config.headers = Some(json!({
        "Authorization": "Bearer legacy-token",
        "X-Api-Key": "legacy-key",
        "x-auth-token": "legacy-auth-token",
        "x-test": "value"
    }));
    let headers = sanitize_headers_for_oauth_transport("demo", parse_headers(&config).unwrap());

    assert_eq!(headers.len(), 1);
    assert!(headers.contains_key(&HeaderName::from_static("x-test")));
    assert!(!headers.contains_key(&HeaderName::from_static("authorization")));
    assert!(!headers.contains_key(&HeaderName::from_static("x-api-key")));
    assert!(!headers.contains_key(&HeaderName::from_static("x-auth-token")));
}

#[test]
fn keeps_non_auth_headers_for_oauth_transport() {
    let mut config = base_config();
    config.headers = Some(json!({
        "x-test": "value",
        "x-trace-id": "abc123"
    }));
    let headers = sanitize_headers_for_oauth_transport("demo", parse_headers(&config).unwrap());

    assert_eq!(headers.len(), 2);
    assert!(headers.contains_key(&HeaderName::from_static("x-test")));
    assert!(headers.contains_key(&HeaderName::from_static("x-trace-id")));
}

#[test]
fn detects_auth_required_transport_errors() {
    let error = ClientInitializeError::transport::<
        StreamableHttpClientTransport<
            crate::oauth::OAuthStreamableHttpClient<CompatibleReqwestStreamableHttpClient>,
        >,
    >(
        StreamableHttpError::AuthRequired(AuthRequiredError {
            www_authenticate_header: "Bearer realm=test".to_string(),
        }),
        "send initialize request",
    );
    let auth_required = find_auth_required_error(&error).unwrap();
    assert_eq!(auth_required.www_authenticate_header, "Bearer realm=test");
}

#[test]
fn extracts_auth_required_challenge_from_unauthenticated_connect_error() {
    let error = ClientInitializeError::transport::<
        StreamableHttpClientTransport<CompatibleReqwestStreamableHttpClient>,
    >(
        StreamableHttpError::<reqwest::Error>::AuthRequired(AuthRequiredError {
            www_authenticate_header:
                r#"Bearer resource_metadata="https://example.test/.well-known/oauth-protected-resource""#
                    .to_string(),
        }),
        "send initialize request",
    );
    let error =
        anyhow::Error::new(error).context("failed to connect streamable-http server 'demo'");

    assert_eq!(
        streamable_http_auth_challenge_from_connect_error(&error).as_deref(),
        Some(
            r#"Bearer resource_metadata="https://example.test/.well-known/oauth-protected-resource""#
        )
    );
}

#[test]
fn detects_unexpected_unauthorized_transport_errors() {
    let error = ClientInitializeError::transport::<
        StreamableHttpClientTransport<
            crate::oauth::OAuthStreamableHttpClient<CompatibleReqwestStreamableHttpClient>,
        >,
    >(
        StreamableHttpError::UnexpectedServerResponse(
            "HTTP 401 Unauthorized: {\"errors\":[\"Unauthorized\"]}".into(),
        ),
        "send initialize request",
    );
    let unauthorized = find_unexpected_unauthorized_error(&error).unwrap();
    assert!(unauthorized.contains("HTTP 401 Unauthorized"));
}

#[test]
fn ignores_non_auth_transport_errors() {
    let error = ClientInitializeError::transport::<
        StreamableHttpClientTransport<
            crate::oauth::OAuthStreamableHttpClient<CompatibleReqwestStreamableHttpClient>,
        >,
    >(
        StreamableHttpError::Client(OAuthTransportError::Internal("boom".to_string())),
        "send initialize request",
    );
    assert!(find_auth_required_error(&error).is_none());
    let error =
        anyhow::Error::new(error).context("failed to connect streamable-http server 'demo'");
    assert!(streamable_http_auth_challenge_from_connect_error(&error).is_none());
}

#[test]
fn uses_explicit_http_subprocess_mcp_url() {
    assert_eq!(http_subprocess_mcp_url(), "http://127.0.0.1:8080/mcp/");
}

#[test]
fn http_subprocess_startup_exit_is_oauth_refresh_retryable() {
    let startup_exit =
        anyhow::anyhow!("http_subprocess 'slack' exited before ready with status exit status: 1");
    assert!(should_retry_http_subprocess_after_oauth_refresh(
        &startup_exit
    ));

    let connect_failure = anyhow::anyhow!("failed to connect streamable-http server 'slack'");
    assert!(!should_retry_http_subprocess_after_oauth_refresh(
        &connect_failure
    ));
}

#[tokio::test]
async fn connect_server_covers_http_subprocess_validation_and_sse_configuration_errors() {
    let mut config = base_config();
    config.http_subprocess = Some(json!("bad"));
    let error = connect_server("demo", &config, None).await.err().unwrap();
    assert!(error.to_string().contains("invalid http_subprocess config"));

    config.http_subprocess = Some(json!({}));
    config.server_type = None;
    config.url = None;
    config.command = None;
    let error = connect_server("demo", &config, None).await.err().unwrap();
    assert!(error.to_string().contains("missing command"));

    let mut sse_config = base_config();
    sse_config.server_type = Some("sse".to_string());
    sse_config.url = None;
    let error = connect_server("demo", &sse_config, None)
        .await
        .err()
        .unwrap();
    assert!(error.to_string().contains("missing url"));
}

#[tokio::test]
#[serial]
async fn connect_server_http_subprocess_injects_transport_and_env_before_handshake() {
    let dir = tempdir().unwrap();
    let script_path = dir.path().join("probe_http_subprocess.py");
    let record_path = dir.path().join("probe.json");
    fs::write(
        &script_path,
        concat!(
            "import http.server, json, os, socketserver, sys\n",
            "record_path = sys.argv[1]\n",
            "with open(record_path, 'w', encoding='utf-8') as handle:\n",
            "    json.dump({'argv': sys.argv[1:], 'mcp_http_port': os.environ.get('MCP_HTTP_PORT'), 'mcp_transport': os.environ.get('MCP_TRANSPORT')}, handle)\n",
            "class Handler(http.server.BaseHTTPRequestHandler):\n",
            "    def do_GET(self):\n",
            "        if self.path == '/ready':\n",
            "            self.send_response(200)\n",
            "            self.end_headers()\n",
            "            self.wfile.write(b'ready')\n",
            "        else:\n",
            "            self.send_response(404)\n",
            "            self.end_headers()\n",
            "    def log_message(self, format, *args):\n",
            "        return\n",
            "socketserver.TCPServer.allow_reuse_address = True\n",
            "with socketserver.TCPServer(('127.0.0.1', int(os.environ['MCP_HTTP_PORT'])), Handler) as server:\n",
            "    server.serve_forever()\n",
        ),
    )
    .unwrap();

    let mut config = base_config();
    config.server_type = None;
    config.url = None;
    config.command = Some(test_python_command());
    config.args = vec![
        script_path.display().to_string(),
        record_path.display().to_string(),
    ];
    config.http_subprocess = Some(json!({
        "enabled": true,
        "health_endpoint": "ready",
        "startup_timeout": 5,
        "shutdown_timeout": 2
    }));

    let error = connect_server("demo", &config, None).await.err().unwrap();
    assert!(error
        .to_string()
        .contains("failed to connect streamable-http server"));

    let recorded: serde_json::Value =
        serde_json::from_slice(&fs::read(&record_path).unwrap()).unwrap();
    assert_eq!(recorded["mcp_http_port"], "8080");
    assert_eq!(recorded["mcp_transport"], "streamable-http");
    let argv = recorded["argv"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|value| value.as_str())
        .collect::<Vec<_>>();
    let record_path_string = record_path.display().to_string();
    assert!(argv.contains(&record_path_string.as_str()));
    assert!(argv
        .windows(2)
        .any(|window| window == ["--transport", "streamable-http"]));
}

#[tokio::test]
async fn connect_stdio_covers_missing_command_and_failed_handshake() {
    let mut config = base_config();
    config.server_type = Some("stdio".to_string());
    config.url = None;
    config.command = None;
    let error = connect_stdio("demo", &config).await.err().unwrap();
    assert!(error.to_string().contains("missing command"));

    config.command = Some(test_python_command());
    config.args = vec!["-c".to_string(), "import sys; sys.exit(0)".to_string()];
    let error = connect_stdio("demo", &config).await.err().unwrap();
    assert!(error.to_string().contains("failed to connect stdio server"));
}

#[tokio::test]
async fn connect_streamable_http_covers_missing_url_and_connect_failure() {
    let mut config = base_config();
    config.url = None;
    let error = connect_streamable_http("demo", &config, None)
        .await
        .err()
        .unwrap();
    assert!(error.to_string().contains("missing url"));

    let error = connect_streamable_http("demo", &base_config(), None)
        .await
        .err()
        .unwrap();
    assert!(error
        .to_string()
        .contains("failed to connect streamable-http server"));
}

#[tokio::test]
async fn connect_streamable_http_falls_back_to_trailing_slash_candidate() {
    let harness =
        StreamableHttpSlashFallbackHarness::spawn(WorkingSlashVariant::TrailingSlash).await;
    let mut config = base_config();
    config.url = Some(format!("{}/v1/tools", harness.base_url));

    let session = connect_streamable_http("demo", &config, None)
        .await
        .expect("fallback to trailing slash should succeed");
    let tools = session.list_tools().await.unwrap();

    assert!(tools.iter().any(|tool| tool.name == "echo"));
}

#[tokio::test]
async fn connect_streamable_http_falls_back_to_non_slash_candidate() {
    let harness =
        StreamableHttpSlashFallbackHarness::spawn(WorkingSlashVariant::NoTrailingSlash).await;
    let mut config = base_config();
    config.url = Some(format!("{}/v1/tools/", harness.base_url));

    let session = connect_streamable_http("demo", &config, None)
        .await
        .expect("fallback to non-slash candidate should succeed");
    let tools = session.list_tools().await.unwrap();

    assert!(tools.iter().any(|tool| tool.name == "echo"));
}

#[tokio::test]
async fn oauth_streamable_http_tries_every_slash_variant_before_refresh() {
    for include_challenge in [false, true] {
        let harness =
            OAuthSlashCompatibilityHarness::spawn(include_challenge, "stored-token", false).await;
        let (server_id, config, token_store, oauth, _) =
            oauth_slash_compat_runtime(&harness, "no-refresh").await;

        let session = connect_streamable_http(&server_id, &config, Some(oauth))
            .await
            .expect("alternate slash variant should connect without refreshing");
        let tools = session.list_tools().await.unwrap();

        assert!(tools.iter().any(|tool| tool.name == "echo"));
        assert!(harness.working_hits.load(Ordering::SeqCst) > 0);
        assert_eq!(harness.refresh_hits.load(Ordering::SeqCst), 0);
        assert_eq!(
            token_store.load_token_file().unwrap().unwrap().access_token,
            "stored-token"
        );
    }
}

#[tokio::test]
async fn oauth_streamable_http_refreshes_once_after_full_candidate_sweep() {
    let harness = OAuthSlashCompatibilityHarness::spawn(true, "refreshed-token", false).await;
    let (server_id, config, token_store, oauth, _) =
        oauth_slash_compat_runtime(&harness, "single-refresh").await;

    let session = connect_streamable_http(&server_id, &config, Some(oauth))
        .await
        .expect("refreshed token should connect on the compatible slash variant");
    let tools = session.list_tools().await.unwrap();

    assert!(tools.iter().any(|tool| tool.name == "echo"));
    assert_eq!(harness.refresh_hits.load(Ordering::SeqCst), 1);
    assert_eq!(
        token_store.load_token_file().unwrap().unwrap().access_token,
        "refreshed-token"
    );
}

#[tokio::test]
async fn oauth_streamable_http_invalidates_only_after_refreshed_candidate_sweep() {
    let harness = OAuthSlashCompatibilityHarness::spawn(false, "refreshed-token", true).await;
    let (server_id, config, token_store, oauth, coordinator) =
        oauth_slash_compat_runtime(&harness, "persistent-rejection").await;

    let error = match connect_streamable_http(&server_id, &config, Some(oauth)).await {
        Ok(_) => panic!("all candidates should reject both token generations"),
        Err(error) => error,
    };

    assert!(error
        .to_string()
        .contains("after every transport candidate rejected the refreshed OAuth token"));
    assert_eq!(harness.refresh_hits.load(Ordering::SeqCst), 1);
    assert!(token_store.load_token_file().unwrap().is_none());
    assert_eq!(
        coordinator.get_handshake(&server_id).await.unwrap().state,
        OAuthState::Failed
    );
}

#[tokio::test]
async fn connect_streamable_http_accepts_empty_notification_success_without_content_type() {
    let harness = EmptyNotificationCompatHarness::spawn().await;
    let mut config = base_config();
    config.url = Some(harness.base_url.clone());

    let session = connect_streamable_http("demo", &config, None)
        .await
        .expect("empty notification success should be treated as accepted");
    let tools = session.list_tools().await.unwrap();

    assert!(tools.iter().any(|tool| tool.name == "echo"));
}

#[tokio::test]
#[ignore = "requires LIVE_STREAMABLE_HTTP_URL and LIVE_STREAMABLE_HTTP_HEADERS_JSON"]
#[serial]
async fn live_streamable_http_server_connects_with_real_endpoint() {
    let url = env::var("LIVE_STREAMABLE_HTTP_URL")
        .expect("LIVE_STREAMABLE_HTTP_URL must be set for the live test");
    let headers_json = env::var("LIVE_STREAMABLE_HTTP_HEADERS_JSON")
        .expect("LIVE_STREAMABLE_HTTP_HEADERS_JSON must be set for the live test");

    let mut config = base_config();
    config.url = Some(url);
    config.headers = Some(
        serde_json::from_str::<serde_json::Value>(&headers_json)
            .expect("LIVE_STREAMABLE_HTTP_HEADERS_JSON must be valid JSON"),
    );

    let session = connect_streamable_http("live-streamable-http", &config, None)
        .await
        .expect("live streamable-http endpoint should connect");
    let tools = session
        .list_tools()
        .await
        .expect("live tools/list should succeed");

    assert!(
        !tools.is_empty(),
        "live streamable-http endpoint should expose at least one tool"
    );
}

#[tokio::test]
async fn connect_sse_covers_missing_url_and_connect_failure() {
    let mut config = base_config();
    config.server_type = Some("sse".to_string());
    config.url = None;
    let error = connect_sse("demo", &config, None).await.err().unwrap();
    assert!(error.to_string().contains("missing url"));

    let mut config = base_config();
    config.server_type = Some("sse".to_string());
    config.url = Some("http://127.0.0.1:1/sse".to_string());
    let error = connect_sse("demo", &config, None).await.err().unwrap();
    assert!(error.to_string().contains("failed to connect sse server"));
}

#[test]
fn converts_mcp_errors_into_tool_error_results() {
    let result = call_tool_result_from_mcp_error(rmcp::ErrorData::new(
        ErrorCode::INTERNAL_ERROR,
        "users cache is not ready yet",
        None,
    ));

    assert_eq!(
        result,
        CallToolResult::error(vec![rmcp::model::Content::text(
            "users cache is not ready yet"
        )])
    );
}

#[test]
fn preserves_mcp_error_data_when_converting_to_tool_result() {
    let result = call_tool_result_from_mcp_error(rmcp::ErrorData::new(
        ErrorCode::INVALID_PARAMS,
        "try again later",
        Some(json!({
            "retry_after_seconds": 120,
            "detail": "cache warmup in progress"
        })),
    ));

    assert_eq!(result.is_error, Some(true));
    assert_eq!(
        result.structured_content,
        Some(json!({
            "message": "try again later",
            "code": ErrorCode::INVALID_PARAMS.0,
            "retry_after_seconds": 120,
            "detail": "cache warmup in progress"
        }))
    );
    assert_eq!(
        result.content,
        vec![rmcp::model::Content::text("try again later")]
    );
}

// -------------------------------------------------------------------------
// F5 (PORTICO-68 follow-up): file-ingress for OAuth access-token subprocess
// injection. These tests lock down the invariants we care about for the
// security finding:
//   1. The on-disk token file is chmod 0600 and the cache dir is 0700.
//   2. The cache dir path follows the PORTICO_OAUTH_TOKEN_CACHE_DIR /
//      PORTICO_RUNTIME_SECRET_CACHE_DIR / per-OS layout and never falls back
//      to a world-readable /tmp location.
//   3. `best_effort_zeroize_and_remove` overwrites the plaintext before it
//      unlinks the file so subsequent inode reuse cannot leak the token.
// -------------------------------------------------------------------------

#[test]
#[serial]
fn oauth_token_cache_dir_prefers_direct_override() {
    let dir = tempdir().unwrap();
    let override_path = dir.path().join("custom-oauth-tokens");
    let prev_override = env::var("PORTICO_OAUTH_TOKEN_CACHE_DIR").ok();
    let prev_secret_cache = env::var("PORTICO_RUNTIME_SECRET_CACHE_DIR").ok();
    env::set_var("PORTICO_OAUTH_TOKEN_CACHE_DIR", &override_path);
    env::set_var(
        "PORTICO_RUNTIME_SECRET_CACHE_DIR",
        dir.path().join("runtime-secrets"),
    );

    let resolved = oauth_token_cache_dir().expect("cache dir should resolve");
    assert_eq!(resolved, override_path);

    match prev_override {
        Some(value) => env::set_var("PORTICO_OAUTH_TOKEN_CACHE_DIR", value),
        None => env::remove_var("PORTICO_OAUTH_TOKEN_CACHE_DIR"),
    }
    match prev_secret_cache {
        Some(value) => env::set_var("PORTICO_RUNTIME_SECRET_CACHE_DIR", value),
        None => env::remove_var("PORTICO_RUNTIME_SECRET_CACHE_DIR"),
    }
}

#[test]
#[serial]
fn oauth_token_cache_dir_nests_under_runtime_secret_cache_when_set() {
    let dir = tempdir().unwrap();
    let secret_cache = dir.path().join("runtime-secrets");
    let prev_override = env::var("PORTICO_OAUTH_TOKEN_CACHE_DIR").ok();
    let prev_secret_cache = env::var("PORTICO_RUNTIME_SECRET_CACHE_DIR").ok();
    env::remove_var("PORTICO_OAUTH_TOKEN_CACHE_DIR");
    env::set_var("PORTICO_RUNTIME_SECRET_CACHE_DIR", &secret_cache);

    let resolved = oauth_token_cache_dir().expect("cache dir should resolve");
    assert_eq!(resolved, secret_cache.join("oauth-tokens"));

    match prev_override {
        Some(value) => env::set_var("PORTICO_OAUTH_TOKEN_CACHE_DIR", value),
        None => env::remove_var("PORTICO_OAUTH_TOKEN_CACHE_DIR"),
    }
    match prev_secret_cache {
        Some(value) => env::set_var("PORTICO_RUNTIME_SECRET_CACHE_DIR", value),
        None => env::remove_var("PORTICO_RUNTIME_SECRET_CACHE_DIR"),
    }
}

#[test]
#[serial]
#[cfg(unix)]
fn write_oauth_token_file_enforces_0600_and_dir_0700() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempdir().unwrap();
    let cache_dir = dir.path().join("oauth-tokens-under-test");
    let prev_override = env::var("PORTICO_OAUTH_TOKEN_CACHE_DIR").ok();
    env::set_var("PORTICO_OAUTH_TOKEN_CACHE_DIR", &cache_dir);

    // Simulate a loose ambient umask — the real Electron launcher runs
    // under the user's shell umask which is often 022. The helper must
    // still produce a 0600 file.
    let prev_mask = unsafe { libc::umask(0o022) };

    let path = write_oauth_token_file("slack", "xoxp-redacted-test-token")
        .expect("token file should be written");
    assert_eq!(
        path,
        cache_dir.join("slack.token"),
        "filename must be derived from sanitized server_id"
    );
    assert!(path.exists(), "token file should exist on disk");

    let file_mode = fs::metadata(&path).unwrap().permissions().mode() & 0o7777;
    assert_eq!(
        file_mode, 0o600,
        "OAuth token file must be 0600 regardless of ambient umask; got {file_mode:o}"
    );
    let dir_mode = fs::metadata(&cache_dir).unwrap().permissions().mode() & 0o7777;
    assert_eq!(
        dir_mode, 0o700,
        "OAuth token cache dir must be 0700; got {dir_mode:o}"
    );
    let contents = fs::read_to_string(&path).unwrap();
    assert_eq!(contents, "xoxp-redacted-test-token");

    // Cleanup
    unsafe {
        libc::umask(prev_mask);
    }
    let _ = fs::remove_file(&path);
    let _ = fs::remove_dir_all(&cache_dir);
    match prev_override {
        Some(value) => env::set_var("PORTICO_OAUTH_TOKEN_CACHE_DIR", value),
        None => env::remove_var("PORTICO_OAUTH_TOKEN_CACHE_DIR"),
    }
}

#[test]
#[serial]
fn write_oauth_token_file_sanitises_server_id_path_components() {
    let dir = tempdir().unwrap();
    let cache_dir = dir.path().join("sanitise-cache");
    let prev_override = env::var("PORTICO_OAUTH_TOKEN_CACHE_DIR").ok();
    env::set_var("PORTICO_OAUTH_TOKEN_CACHE_DIR", &cache_dir);

    // A pathological server_id must never produce a path outside the cache
    // dir — we rewrite every non-alphanumeric-`-`-`_` char to `_`.
    let path = write_oauth_token_file("../../../etc/passwd", "t").expect("should write");
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    assert_eq!(file_name, "_________etc_passwd.token");
    assert!(
        path.starts_with(&cache_dir),
        "resolved path '{}' escapes cache dir '{}'",
        path.display(),
        cache_dir.display()
    );

    let _ = fs::remove_file(&path);
    let _ = fs::remove_dir_all(&cache_dir);
    match prev_override {
        Some(value) => env::set_var("PORTICO_OAUTH_TOKEN_CACHE_DIR", value),
        None => env::remove_var("PORTICO_OAUTH_TOKEN_CACHE_DIR"),
    }
}

#[test]
#[serial]
fn best_effort_zeroize_and_remove_overwrites_before_unlink() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("sentinel.token");
    fs::write(&path, b"super-secret-token-value").unwrap();

    best_effort_zeroize_and_remove(&path).expect("cleanup should succeed");
    assert!(
        !path.exists(),
        "secret file should be unlinked after cleanup"
    );
}

#[test]
#[serial]
fn best_effort_zeroize_and_remove_tolerates_missing_file() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("never-existed.token");

    // Must be idempotent — a close() after an aborted startup may race
    // Drop, and we do not want the second call to return an error.
    best_effort_zeroize_and_remove(&path).expect("absent file must not error");
}
