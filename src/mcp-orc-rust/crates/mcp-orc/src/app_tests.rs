use super::*;
use crate::app_tool_oauth::{extract_authorization_url, strip_authorization_url};
use crate::oauth::{CompatClientInfo, CompatTokenFile, CompatTokenStore};
use crate::test_support::TestMcpServerHandle;
use axum::body::to_bytes;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::sse::Event;
use axum::response::{Response, Sse};
use axum::{routing::get, routing::post, Json, Router};
use core_mcp_shared::{redis_get_string, redis_setex_string};
use futures::{stream, StreamExt};
use rmcp::model::{
    CallToolResult, Content, Implementation, JsonRpcMessage, ListToolsResult, RequestId,
    ServerCapabilities, ServerInfo, ServerJsonRpcMessage, ServerResult, Tool,
};
use serde_json::json;
use std::borrow::Cow;
use std::convert::Infallible;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tempfile::tempdir;
use tokio::sync::{broadcast, oneshot, Mutex as AsyncMutex};

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

struct TestServer {
    base_url: String,
    shutdown: Option<oneshot::Sender<()>>,
}

impl TestServer {
    async fn token_server(token_response: Value) -> Self {
        let router = Router::new()
            .route(
                "/authorize",
                get(|| async { (StatusCode::OK, "authorize") }),
            )
            .route(
                "/token",
                post({
                    let token_response = token_response.clone();
                    move || {
                        let token_response = token_response.clone();
                        async move { (StatusCode::OK, Json(token_response)) }
                    }
                }),
            )
            .route("/mcp", get(|| async { (StatusCode::NOT_FOUND, "missing") }));
        Self::spawn(router).await
    }

    async fn spawn(router: Router) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        tokio::spawn(async move {
            let server = axum::serve(listener, router).with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            });
            let _ = server.await;
        });
        Self {
            base_url: format!("http://{}", address),
            shutdown: Some(shutdown_tx),
        }
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

#[derive(Clone)]
struct RuntimeOAuthChallengeState {
    initialize_hits: Arc<AtomicUsize>,
}

fn request_origin(headers: &HeaderMap) -> String {
    let host = headers
        .get("host")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("127.0.0.1");
    format!("http://{host}")
}

async fn streamable_http_initialize_requires_oauth(
    State(state): State<RuntimeOAuthChallengeState>,
    headers: HeaderMap,
    Json(_body): Json<Value>,
) -> impl IntoResponse {
    state.initialize_hits.fetch_add(1, Ordering::SeqCst);
    let origin = request_origin(&headers);
    let challenge =
        format!(r#"Bearer resource_metadata="{origin}/.well-known/oauth-protected-resource""#);
    let mut response_headers = HeaderMap::new();
    response_headers.insert(
        "www-authenticate",
        HeaderValue::from_str(&challenge).unwrap(),
    );
    (
        StatusCode::UNAUTHORIZED,
        response_headers,
        Json(json!({"error": "authorization required"})),
    )
}

async fn runtime_oauth_protected_resource_metadata(headers: HeaderMap) -> impl IntoResponse {
    let origin = request_origin(&headers);
    Json(json!({
        "resource": origin,
        "scopes_supported": [
            "workforce.trust_and_safety.read",
            "offline_access"
        ],
        "authorization_servers": [origin]
    }))
}

async fn runtime_oauth_authorization_metadata(headers: HeaderMap) -> impl IntoResponse {
    let origin = request_origin(&headers);
    Json(json!({
        "authorization_endpoint": format!("{origin}/authorize"),
        "token_endpoint": format!("{origin}/token"),
        "registration_endpoint": format!("{origin}/register")
    }))
}

async fn runtime_oauth_register_client() -> impl IntoResponse {
    Json(json!({
        "client_id": "dynamic-client",
        "redirect_uris": ["http://localhost:3834/callback"],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none"
    }))
}

#[derive(Clone)]
struct ClassicSseTimeoutHarnessState {
    events: broadcast::Sender<String>,
}

struct ClassicSseTimeoutHarness {
    base_url: String,
    shutdown: Option<oneshot::Sender<()>>,
}

impl ClassicSseTimeoutHarness {
    async fn spawn() -> Self {
        let (events, _) = broadcast::channel(32);
        let state = ClassicSseTimeoutHarnessState { events };
        let router = Router::new()
            .route("/sse", get(handle_timeout_test_sse))
            .route("/messages", post(handle_timeout_test_message))
            .with_state(state);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        tokio::spawn(async move {
            let server = axum::serve(listener, router).with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            });
            let _ = server.await;
        });
        Self {
            base_url: format!("http://{}", address),
            shutdown: Some(shutdown_tx),
        }
    }

    fn sse_url(&self) -> String {
        format!("{}/sse", self.base_url)
    }
}

impl Drop for ClassicSseTimeoutHarness {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

async fn handle_timeout_test_sse(
    State(state): State<ClassicSseTimeoutHarnessState>,
) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
    let initial = stream::once(async {
        Ok::<_, Infallible>(
            Event::default()
                .event("endpoint")
                .data("/messages?sessionId=timeout-test"),
        )
    });
    let messages = stream::unfold(state.events.subscribe(), |mut receiver| async move {
        loop {
            match receiver.recv().await {
                Ok(message) => {
                    let event = Event::default().event("message").data(message);
                    return Some((Ok::<_, Infallible>(event), receiver));
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    });
    Sse::new(initial.chain(messages))
}

async fn handle_timeout_test_message(
    State(state): State<ClassicSseTimeoutHarnessState>,
    Json(body): Json<Value>,
) -> (StatusCode, HeaderMap, String) {
    let id = body
        .get("id")
        .cloned()
        .and_then(|value| serde_json::from_value::<RequestId>(value).ok())
        .unwrap_or(RequestId::Number(1));
    let method = body
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();

    match method {
        "initialize" => {
            let _ = state.events.send(timeout_test_initialize_response(id));
        }
        "notifications/initialized" => {}
        "tools/list" => {
            let _ = state.events.send(timeout_test_list_tools_response(id));
        }
        "tools/call" => {}
        _ => {
            let _ = state
                .events
                .send(timeout_test_error_response(id, "unknown method"));
        }
    }

    (StatusCode::ACCEPTED, HeaderMap::new(), String::new())
}

fn timeout_test_initialize_response(id: RequestId) -> String {
    serde_json::to_string(&ServerJsonRpcMessage::response(
        ServerResult::InitializeResult(
            rmcp::model::InitializeResult::new(ServerCapabilities::default())
                .with_server_info(Implementation::new("classic-sse-timeout", "1.0.0")),
        ),
        id,
    ))
    .unwrap()
}

fn timeout_test_list_tools_response(id: RequestId) -> String {
    serde_json::to_string(&ServerJsonRpcMessage::response(
        ServerResult::ListToolsResult(ListToolsResult {
            tools: vec![sample_tool("echo")],
            ..Default::default()
        }),
        id,
    ))
    .unwrap()
}

fn timeout_test_error_response(id: RequestId, message: &str) -> String {
    serde_json::to_string(&JsonRpcMessage::<Value, Value, Value>::error(
        rmcp::model::ErrorData::internal_error(message.to_string(), None),
        id,
    ))
    .unwrap()
}

#[derive(Clone, Default)]
struct OverflowCoreState {
    create_calls: Arc<AsyncMutex<Vec<Value>>>,
    status_calls: Arc<AsyncMutex<Vec<Value>>>,
    file_calls: Arc<AsyncMutex<Vec<Value>>>,
}

impl OverflowCoreState {
    async fn create_calls(&self) -> Vec<Value> {
        self.create_calls.lock().await.clone()
    }

    async fn status_calls(&self) -> Vec<Value> {
        self.status_calls.lock().await.clone()
    }

    async fn file_calls(&self) -> Vec<Value> {
        self.file_calls.lock().await.clone()
    }
}

async fn spawn_overflow_core_server(vm_id: &str) -> (TestServer, OverflowCoreState) {
    spawn_overflow_core_server_with_behavior(vm_id, None, None).await
}

async fn spawn_overflow_core_server_with_limit(
    vm_id: &str,
    max_file_content_len: Option<usize>,
) -> (TestServer, OverflowCoreState) {
    spawn_overflow_core_server_with_behavior(vm_id, max_file_content_len, None).await
}

async fn spawn_overflow_core_server_with_file_response(
    vm_id: &str,
    max_file_content_len: Option<usize>,
    create_delay_ms: Option<u64>,
    file_response: Value,
) -> (TestServer, OverflowCoreState) {
    spawn_overflow_core_server_internal(
        vm_id,
        max_file_content_len,
        create_delay_ms,
        Some(file_response),
    )
    .await
}

async fn spawn_overflow_core_server_with_behavior(
    vm_id: &str,
    max_file_content_len: Option<usize>,
    create_delay_ms: Option<u64>,
) -> (TestServer, OverflowCoreState) {
    spawn_overflow_core_server_internal(vm_id, max_file_content_len, create_delay_ms, None).await
}

async fn spawn_overflow_core_server_internal(
    vm_id: &str,
    max_file_content_len: Option<usize>,
    create_delay_ms: Option<u64>,
    file_response: Option<Value>,
) -> (TestServer, OverflowCoreState) {
    let state = OverflowCoreState::default();
    let vm_id = vm_id.to_string();
    let router = Router::new()
        .route(
            "/agent-vm/agent_vm_create",
            post({
                let state = state.clone();
                let vm_id = vm_id.clone();
                let create_delay_ms = create_delay_ms;
                move |Json(payload): Json<Value>| {
                    let state = state.clone();
                    let vm_id = vm_id.clone();
                    let create_delay_ms = create_delay_ms;
                    async move {
                        state.create_calls.lock().await.push(payload);
                        if let Some(delay_ms) = create_delay_ms {
                            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                        }
                        (
                            StatusCode::OK,
                            Json(json!({
                                "success": true,
                                "vm_id": vm_id,
                                "status": "running",
                            })),
                        )
                    }
                }
            }),
        )
        .route(
            "/agent-vm/agent_vm_get_status",
            post({
                let state = state.clone();
                move |Json(payload): Json<Value>| {
                    let state = state.clone();
                    async move {
                        state.status_calls.lock().await.push(payload);
                        (
                            StatusCode::OK,
                            Json(json!({"success": true, "status": "running"})),
                        )
                    }
                }
            }),
        )
        .route(
            "/agent-vm/agent_vm_create_file",
            post({
                let state = state.clone();
                let max_file_content_len = max_file_content_len;
                let file_response = file_response.clone();
                move |Json(payload): Json<Value>| {
                    let state = state.clone();
                    let max_file_content_len = max_file_content_len;
                    let file_response = file_response.clone();
                    async move {
                        state.file_calls.lock().await.push(payload);
                        let last_payload = state.file_calls.lock().await.last().cloned();
                        if let (Some(limit), Some(last_payload)) =
                            (max_file_content_len, last_payload)
                        {
                            let content_len = last_payload
                                .get("content")
                                .and_then(Value::as_str)
                                .map(str::len)
                                .unwrap_or(0);
                            if content_len > limit {
                                return (
                                    StatusCode::PAYLOAD_TOO_LARGE,
                                    Json(json!({"success": false, "error": "Payload Too Large"})),
                                );
                            }
                        }
                        (
                            StatusCode::OK,
                            Json(file_response.unwrap_or_else(|| json!({"success": true}))),
                        )
                    }
                }
            }),
        );
    (TestServer::spawn(router).await, state)
}

fn unique_test_suffix() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos()
        .to_string()
}

struct MockSession {
    tools: Vec<Tool>,
    call_result: AsyncMutex<anyhow::Result<CallToolResult>>,
    persistent_error: Option<String>,
    call_delay: Option<Duration>,
    last_request_meta: AsyncMutex<Option<Value>>,
    requests: AsyncMutex<Vec<Value>>,
    call_count: AtomicUsize,
    closed: AtomicBool,
    close_error: Option<String>,
    provider_readiness: ProviderReadiness,
}

impl MockSession {
    fn new(call_result: anyhow::Result<CallToolResult>) -> Self {
        Self {
            tools: Vec::new(),
            call_result: AsyncMutex::new(call_result),
            persistent_error: None,
            call_delay: None,
            last_request_meta: AsyncMutex::new(None),
            requests: AsyncMutex::new(Vec::new()),
            call_count: AtomicUsize::new(0),
            closed: AtomicBool::new(false),
            close_error: None,
            provider_readiness: ProviderReadiness::NotRequired,
        }
    }

    fn delayed(call_result: anyhow::Result<CallToolResult>, call_delay: Duration) -> Self {
        Self {
            call_delay: Some(call_delay),
            ..Self::new(call_result)
        }
    }

    fn always_fails(message: &str) -> Self {
        Self {
            persistent_error: Some(message.to_string()),
            ..Self::new(Err(anyhow!(message.to_string())))
        }
    }

    fn with_provider_readiness(mut self, provider_readiness: ProviderReadiness) -> Self {
        self.provider_readiness = provider_readiness;
        self
    }
}

#[async_trait::async_trait]
impl McpSession for MockSession {
    async fn list_tools(&self) -> Result<Vec<Tool>> {
        Ok(self.tools.clone())
    }

    async fn call_tool(&self, request: CallToolRequestParams) -> Result<CallToolResult> {
        self.call_count.fetch_add(1, Ordering::SeqCst);
        if let Some(delay) = self.call_delay {
            tokio::time::sleep(delay).await;
        }
        *self.last_request_meta.lock().await =
            Some(serde_json::to_value(&request.meta).unwrap_or(Value::Null));
        self.requests
            .lock()
            .await
            .push(serde_json::to_value(&request).unwrap_or(Value::Null));
        if let Some(error) = self.persistent_error.as_ref() {
            return Err(anyhow!(error.clone()));
        }
        let mut guard = self.call_result.lock().await;
        std::mem::replace(&mut *guard, Ok(CallToolResult::success(vec![])))
    }

    async fn close(&self) -> Result<()> {
        self.closed.store(true, Ordering::SeqCst);
        match &self.close_error {
            Some(error) => Err(anyhow!(error.clone())),
            None => Ok(()),
        }
    }

    async fn provider_readiness(&self) -> ProviderReadiness {
        self.provider_readiness
    }

    fn peer_info(&self) -> Option<ServerInfo> {
        None
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }
}

impl MockSession {
    fn call_count(&self) -> usize {
        self.call_count.load(Ordering::SeqCst)
    }

    async fn requests(&self) -> Vec<Value> {
        self.requests.lock().await.clone()
    }
}

fn base_config() -> ServerConfig {
    ServerConfig {
        server_type: Some("stdio".to_string()),
        url: None,
        command: Some("uvx".to_string()),
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

fn config_with_retryable_tool(tool_name: &str) -> ServerConfig {
    let mut config = base_config();
    config
        .extra
        .insert("retryable_tools".to_string(), json!([tool_name]));
    config
}

fn zero_retry_delay() -> Duration {
    Duration::ZERO
}

fn slow_test_retry_delay() -> Duration {
    Duration::from_millis(100)
}

static FIXED_RECOVERY_TEST_NOW: OnceLock<Instant> = OnceLock::new();

fn fixed_recovery_test_now() -> Instant {
    *FIXED_RECOVERY_TEST_NOW.get_or_init(Instant::now)
}

fn classic_sse_config(url: String) -> ServerConfig {
    ServerConfig {
        server_type: Some("sse".to_string()),
        url: Some(url),
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

fn oauth_config(base_url: &str) -> Value {
    json!({
        "authorization_endpoint": format!("{base_url}/authorize"),
        "token_endpoint": format!("{base_url}/token"),
        "credentials_source": {
            "type": "inline",
            "client_id": "client",
            "client_secret": "secret"
        }
    })
}

fn sample_tool(name: &str) -> Tool {
    let mut tool = Tool::default();
    tool.name = Cow::Owned(name.to_string());
    tool.description = Some(Cow::Borrowed("demo"));
    tool.input_schema = Arc::new(Map::new());
    tool.output_schema = Some(Arc::new(Map::new()));
    tool
}

fn sample_route() -> ToolRoute {
    ToolRoute {
        route_name: "demo_echo".to_string(),
        original_name: "echo".to_string(),
        display_name: None,
        title: Some("Echo".to_string()),
        description: Some("Demo echo".to_string()),
        input_schema: json!({"type": "object"}),
        output_schema: None,
    }
}

fn runtime_with_state(
    id: &str,
    config: ServerConfig,
    session: Option<Arc<dyn McpSession>>,
    tools: BTreeMap<String, ToolRoute>,
    oauth: Option<Arc<OAuthBinding>>,
    error: Option<String>,
) -> Arc<ServerRuntime> {
    Arc::new(ServerRuntime {
        id: id.to_string(),
        config,
        oauth: RwLock::new(oauth),
        oauth_coordinator: Arc::new(OAuthCoordinator::new()),
        connect_lock: Mutex::new(()),
        recovery: RecoveryRuntime::default(),
        state: RwLock::new(ServerConnectionState {
            session,
            tools,
            openapi: json!({"openapi": "3.1.0"}),
            title: id.to_string(),
            version: None,
            error,
            last_activity_at: Some(SystemTime::now()),
        }),
    })
}

fn app_state(
    server_id: &str,
    server: Arc<ServerRuntime>,
    coordinator: Arc<OAuthCoordinator>,
) -> AppState {
    let mut servers = BTreeMap::new();
    servers.insert(server_id.to_string(), server);
    AppState::new(servers, coordinator)
}

async fn response_json(response: Response) -> Value {
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).to_string()))
}

async fn response_text(response: Response) -> String {
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    String::from_utf8(bytes.to_vec()).unwrap()
}

#[test]
fn sanitizes_tool_names_like_python() {
    assert_eq!(sanitize_tool_name("Some Tool!!!"), "Some_Tool");
    assert_eq!(sanitize_tool_name("__demo__"), "demo");
}

#[test]
fn retry_failure_classification_is_conservative() {
    for message in [
        "HTTP 408 Request Timeout",
        "HTTP 502 Bad Gateway",
        "HTTP 503 Service Unavailable",
        "HTTP 504 Gateway Timeout",
        "connection reset by peer",
        "connection closed",
        "connection aborted",
        "broken pipe",
    ] {
        assert!(
            classify_tool_failure(message).is_recovery_eligible(),
            "should be retry eligible: {message}"
        );
    }
    for message in [
        "HTTP 401 Unauthorized",
        "HTTP 403 Forbidden",
        "HTTP 409 Conflict",
        "HTTP 422 Unprocessable Entity",
        "HTTP 429 Too Many Requests",
        "validation failed",
        "request cancelled",
    ] {
        assert!(
            !classify_tool_failure(message).is_recovery_eligible(),
            "must not be retry eligible: {message}"
        );
    }
}

#[test]
fn retry_jitter_stays_within_fixed_v1_bounds() {
    for _ in 0..128 {
        let delay = retry_jitter_delay();
        assert!(delay >= Duration::from_millis(500));
        assert!(delay <= Duration::from_millis(2_000));
    }
}

#[test]
fn builds_tool_routes_with_prefix_renames_and_disabled_tools() {
    let mut renamed = base_config();
    renamed
        .tool_rename_mapping
        .insert("get_time".to_string(), "Current Time".to_string());
    let routes = build_tool_routes("time-server", &renamed, &[sample_tool("get_time")]);
    assert!(routes.contains_key("time_server_Current_Time"));

    let mut disabled = base_config();
    disabled.disabled_tools.push("get_time".to_string());
    assert!(build_tool_routes("time", &disabled, &[sample_tool("get_time")]).is_empty());

    let mut colliding = base_config();
    colliding
        .tool_rename_mapping
        .insert("first".to_string(), "same".to_string());
    colliding
        .tool_rename_mapping
        .insert("second".to_string(), "same".to_string());
    let routes = build_tool_routes(
        "time",
        &colliding,
        &[sample_tool("first"), sample_tool("second")],
    );
    assert!(routes.contains_key("time_same"));
    assert!(routes.contains_key("time_second"));
}

#[test]
fn merges_and_validates_callback_payloads() {
    let mut headers = HeaderMap::new();
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/x-www-form-urlencoded"),
    );
    let merged = merge_callback_request(
        OAuthCallbackQuery {
            code: None,
            state: Some("query-state".to_string()),
            server_name: None,
            error: None,
            error_description: None,
        },
        &headers,
        b"code=auth-code&server_name=glean",
    )
    .unwrap();
    assert_eq!(merged.code.as_deref(), Some("auth-code"));
    assert_eq!(merged.state.as_deref(), Some("query-state"));
    assert_eq!(merged.server_name.as_deref(), Some("glean"));

    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    let parsed = merge_callback_request(
        OAuthCallbackQuery::default(),
        &headers,
        br#"{"code":"json-code","state":"json-state"}"#,
    )
    .unwrap();
    assert_eq!(parsed.code.as_deref(), Some("json-code"));
    assert_eq!(parsed.state.as_deref(), Some("json-state"));
    assert!(merge_callback_request(OAuthCallbackQuery::default(), &headers, b"{").is_err());
}

#[test]
fn forwarded_headers_and_authorization_url_helpers_cover_edge_cases() {
    let mut config = base_config();
    config.client_header_forwarding = Some(json!({
        "enabled": true,
        "allowed_headers": ["x-keep"]
    }));
    let mut headers = HeaderMap::new();
    headers.insert("x-keep", HeaderValue::from_static("yes"));
    headers.insert("x-drop", HeaderValue::from_static("no"));
    let meta = forwarded_header_meta(&headers, &config);
    assert_eq!(
        serde_json::to_value(meta).unwrap(),
        json!({"headers": {"x-keep": "yes"}})
    );

    let message = "boom; authorization_url=https://example.test/auth";
    assert_eq!(
        extract_authorization_url(message).as_deref(),
        Some("https://example.test/auth")
    );
    assert_eq!(strip_authorization_url(message), "boom");
}

#[tokio::test]
async fn basic_handlers_return_expected_payloads() {
    let coordinator = Arc::new(OAuthCoordinator::new());
    coordinator.register_handshake("glean").await;
    let runtime = runtime_with_state("glean", base_config(), None, BTreeMap::new(), None, None);
    let state = app_state("glean", runtime, coordinator.clone());

    let health = handle_health().await.into_response();
    assert_eq!(health.status(), StatusCode::OK);
    assert_eq!(response_text(health).await, "healthy");

    let root_openapi = handle_root_openapi(State(state.clone())).await.0;
    assert!(root_openapi["paths"]["/oauth/status"].is_object());
    assert!(root_openapi["paths"]["/glean/openapi.json"]["get"].is_object());
    assert!(root_openapi["info"]["description"]
        .as_str()
        .unwrap()
        .contains("[glean]"));

    let servers = handle_servers(State(state.clone())).await.0;
    assert_eq!(servers["count"], json!(1));
    assert_eq!(servers["servers"], json!(["glean"]));
    assert_eq!(
        servers["server_statuses"]["glean"]["recovery_state"],
        "healthy"
    );
    assert_eq!(
        servers["server_statuses"]["glean"]["logical_in_flight_count"],
        0
    );

    let docs = handle_server_docs(Path("glean".to_string()))
        .await
        .into_response();
    assert_eq!(docs.status(), StatusCode::OK);
    assert!(response_text(docs).await.contains("/glean/openapi.json"));

    assert!(handle_oauth_status(State(state.clone())).await.0["pending"].is_array());
    assert!(handle_oauth_current(State(state.clone())).await.0["current"].is_null());
    assert!(handle_oauth_pending(State(state)).await.0["pending"].is_array());
}

#[tokio::test]
async fn server_openapi_covers_not_found_failure_and_success() {
    let missing = handle_server_openapi(
        State(AppState::new(
            BTreeMap::new(),
            Arc::new(OAuthCoordinator::new()),
        )),
        Path("missing".to_string()),
    )
    .await
    .into_response();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);

    let failing = runtime_with_state(
        "demo",
        ServerConfig {
            command: Some("definitely-not-a-command".to_string()),
            ..base_config()
        },
        None,
        BTreeMap::new(),
        None,
        None,
    );
    let response = handle_server_openapi(
        State(app_state(
            "demo",
            failing,
            Arc::new(OAuthCoordinator::new()),
        )),
        Path("demo".to_string()),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);

    let healthy = runtime_with_state(
        "demo",
        base_config(),
        Some(Arc::new(MockSession::new(Ok(CallToolResult::success(
            vec![],
        ))))),
        BTreeMap::new(),
        None,
        None,
    );
    {
        let mut guard = healthy.state.write().await;
        guard.openapi = json!({"demo": true});
    }
    let response = handle_server_openapi(
        State(app_state(
            "demo",
            healthy,
            Arc::new(OAuthCoordinator::new()),
        )),
        Path("demo".to_string()),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response_json(response).await, json!({"demo": true}));
}

#[tokio::test]
async fn provider_warmup_gates_discovery_but_preserves_direct_tool_semantics() {
    let route = sample_route();
    let mut tools = BTreeMap::new();
    tools.insert(route.route_name.clone(), route.clone());
    let session = Arc::new(
        MockSession::new(Ok(CallToolResult::structured(json!({"messages": []}))))
            .with_provider_readiness(ProviderReadiness::Starting),
    );
    let runtime = runtime_with_state(
        "slack",
        base_config(),
        Some(session.clone()),
        tools.clone(),
        None,
        None,
    );
    let state = app_state("slack", runtime.clone(), Arc::new(OAuthCoordinator::new()));

    let status = runtime.status_json().await;
    assert_eq!(status["healthy"], json!(false));
    assert_eq!(status["readiness_phase"], json!("starting"));
    assert_eq!(status["provider_readiness"], json!("starting"));

    let openapi = handle_server_openapi(State(state.clone()), Path("slack".to_string()))
        .await
        .into_response();
    assert_eq!(openapi.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        response_json(openapi).await["provider_readiness"],
        json!("starting")
    );

    let direct = handle_tool_call(
        State(state),
        Path(("slack".to_string(), route.route_name.clone())),
        HeaderMap::new(),
        Bytes::from_static(br#"{"channel_id":"C123"}"#),
    )
    .await
    .into_response();
    assert_eq!(direct.status(), StatusCode::OK);
    assert_eq!(response_json(direct).await, json!({"messages": []}));
    assert_eq!(session.call_count(), 1);

    let upstream_message = "channels cache is not ready yet, sync process is still running";
    let failing_session = Arc::new(
        MockSession::always_fails(upstream_message)
            .with_provider_readiness(ProviderReadiness::Starting),
    );
    let failing_state = app_state(
        "slack",
        runtime_with_state(
            "slack",
            base_config(),
            Some(failing_session.clone()),
            tools,
            None,
            None,
        ),
        Arc::new(OAuthCoordinator::new()),
    );
    let direct = handle_tool_call(
        State(failing_state),
        Path(("slack".to_string(), route.route_name)),
        HeaderMap::new(),
        Bytes::new(),
    )
    .await
    .into_response();
    assert_eq!(direct.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        response_json(direct).await["message"],
        json!(upstream_message)
    );
    assert_eq!(failing_session.call_count(), 1);
}

#[tokio::test]
async fn server_status_reports_cached_readiness_without_openapi_connect() {
    let missing = handle_server_status(
        State(AppState::new(
            BTreeMap::new(),
            Arc::new(OAuthCoordinator::new()),
        )),
        Path("missing".to_string()),
    )
    .await
    .into_response();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);

    let failing = runtime_with_state(
        "demo",
        base_config(),
        None,
        BTreeMap::new(),
        None,
        Some("failed to connect stdio server 'demo'".to_string()),
    );
    let response = handle_server_status(
        State(app_state(
            "demo",
            failing,
            Arc::new(OAuthCoordinator::new()),
        )),
        Path("demo".to_string()),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::OK);
    let payload = response_json(response).await;
    assert_eq!(payload["server_id"], json!("demo"));
    assert_eq!(payload["healthy"], json!(false));
    assert_eq!(payload["readiness_phase"], json!("failed"));
    assert_eq!(
        payload["error"],
        json!("failed to connect stdio server 'demo'")
    );

    let route = sample_route();
    let mut tools = BTreeMap::new();
    tools.insert(route.route_name.clone(), route);
    let healthy = runtime_with_state(
        "demo",
        base_config(),
        Some(Arc::new(MockSession::new(Ok(CallToolResult::success(
            vec![],
        ))))),
        tools,
        None,
        None,
    );
    let response = handle_server_status(
        State(app_state(
            "demo",
            healthy,
            Arc::new(OAuthCoordinator::new()),
        )),
        Path("demo".to_string()),
    )
    .await
    .into_response();
    let payload = response_json(response).await;
    assert_eq!(payload["healthy"], json!(true));
    assert_eq!(payload["readiness_phase"], json!("tool_ready"));
    assert_eq!(payload["tools_count"], json!(1));
}

#[tokio::test]
async fn server_status_reports_active_oauth_as_needs_oauth() {
    let _env_lock = crate::test_env_lock();
    let temp_home = tempdir().unwrap();
    let _env = EnvGuard::set(&[("HOME", temp_home.path().to_string_lossy().into_owned())]);
    let token_server = TestServer::token_server(json!({
        "access_token": "fresh-token",
        "token_type": "Bearer",
        "expires_in": 3600,
    }))
    .await;
    let coordinator = Arc::new(OAuthCoordinator::new());
    let config = ServerConfig {
        server_type: Some("streamable-http".to_string()),
        url: Some(format!("{}/mcp", token_server.base_url)),
        oauth: Some(oauth_config(&token_server.base_url)),
        command: None,
        ..base_config()
    };
    let oauth = OAuthBinding::new("demo", &config, coordinator)
        .await
        .unwrap();
    let authorization_url = oauth.ensure_authorization_url(true).await.unwrap();
    assert!(authorization_url.contains("/authorize"));

    let runtime = runtime_with_state(
        "demo",
        config,
        None,
        BTreeMap::new(),
        Some(oauth),
        Some("OAuth authorization required for server 'demo'".to_string()),
    );
    let response = handle_server_status(
        State(app_state(
            "demo",
            runtime,
            Arc::new(OAuthCoordinator::new()),
        )),
        Path("demo".to_string()),
    )
    .await
    .into_response();
    let payload = response_json(response).await;
    assert_eq!(payload["healthy"], json!(false));
    assert_eq!(payload["readiness_phase"], json!("needs_oauth"));
    assert_eq!(payload["status"], json!("needs_oauth"));
    assert_eq!(payload["oauth_state"], json!("active"));
    assert_eq!(payload["authorization_url_available"], json!(true));
    assert_eq!(
        payload["error"],
        json!("OAuth authorization required for server 'demo'")
    );
}

#[tokio::test]
async fn tool_call_handler_covers_validation_and_status_mapping() {
    let route = sample_route();
    let mut tools = BTreeMap::new();
    tools.insert(route.route_name.clone(), route.clone());
    let state = app_state(
        "demo",
        runtime_with_state(
            "demo",
            base_config(),
            Some(Arc::new(MockSession::new(Ok(CallToolResult::structured(
                json!({"ok": true}),
            ))))),
            tools.clone(),
            None,
            None,
        ),
        Arc::new(OAuthCoordinator::new()),
    );

    let response = handle_tool_call(
        State(state.clone()),
        Path(("missing".to_string(), "route".to_string())),
        HeaderMap::new(),
        Bytes::new(),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    let response = handle_tool_call(
        State(state.clone()),
        Path(("demo".to_string(), "missing".to_string())),
        HeaderMap::new(),
        Bytes::new(),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    let response = handle_tool_call(
        State(state.clone()),
        Path(("demo".to_string(), route.route_name.clone())),
        HeaderMap::new(),
        Bytes::from_static(b"{"),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let response = handle_tool_call(
        State(state.clone()),
        Path(("demo".to_string(), route.route_name.clone())),
        HeaderMap::new(),
        Bytes::from_static(br#""bad""#),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let response = handle_tool_call(
        State(state),
        Path(("demo".to_string(), route.route_name.clone())),
        HeaderMap::new(),
        Bytes::new(),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response_json(response).await, json!({"ok": true}));

    let timeout = app_state(
        "demo",
        runtime_with_state(
            "demo",
            ServerConfig {
                tool_call_timeout: Some(0.001),
                ..base_config()
            },
            Some(Arc::new(MockSession::delayed(
                Ok(CallToolResult::success(vec![Content::text("late")])),
                Duration::from_millis(50),
            ))),
            tools.clone(),
            None,
            None,
        ),
        Arc::new(OAuthCoordinator::new()),
    );
    let response = handle_tool_call(
        State(timeout),
        Path(("demo".to_string(), route.route_name.clone())),
        HeaderMap::new(),
        Bytes::new(),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::GATEWAY_TIMEOUT);

    let harness = ClassicSseTimeoutHarness::spawn().await;
    let mut classic_sse_timeout_config = classic_sse_config(harness.sse_url());
    classic_sse_timeout_config.tool_call_timeout = Some(0.05);
    let session = connect_server("demo", &classic_sse_timeout_config, None)
        .await
        .unwrap();
    let classic_sse_timeout = app_state(
        "demo",
        runtime_with_state(
            "demo",
            classic_sse_timeout_config,
            Some(session),
            tools.clone(),
            None,
            None,
        ),
        Arc::new(OAuthCoordinator::new()),
    );
    let response = handle_tool_call(
        State(classic_sse_timeout),
        Path(("demo".to_string(), route.route_name.clone())),
        HeaderMap::new(),
        Bytes::new(),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::GATEWAY_TIMEOUT);

    let auth_required = app_state(
        "demo",
        runtime_with_state(
            "demo",
            base_config(),
            Some(Arc::new(MockSession::new(Err(anyhow!(
                "need auth; authorization_url=https://example.test/auth"
            ))))),
            tools.clone(),
            None,
            None,
        ),
        Arc::new(OAuthCoordinator::new()),
    );
    let response = handle_tool_call(
        State(auth_required),
        Path(("demo".to_string(), route.route_name.clone())),
        HeaderMap::new(),
        Bytes::new(),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        response_json(response).await["authorization_url"],
        "https://example.test/auth"
    );

    let gateway = app_state(
        "demo",
        runtime_with_state(
            "demo",
            base_config(),
            Some(Arc::new(MockSession::new(Err(anyhow!(
                "failed to connect upstream"
            ))))),
            tools.clone(),
            None,
            None,
        ),
        Arc::new(OAuthCoordinator::new()),
    );
    let response = handle_tool_call(
        State(gateway),
        Path(("demo".to_string(), route.route_name.clone())),
        HeaderMap::new(),
        Bytes::new(),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);

    let internal = app_state(
        "demo",
        runtime_with_state(
            "demo",
            base_config(),
            Some(Arc::new(MockSession::new(Ok(CallToolResult::error(vec![
                Content::text("boom"),
            ]))))),
            tools,
            None,
            None,
        ),
        Arc::new(OAuthCoordinator::new()),
    );
    let response = handle_tool_call(
        State(internal),
        Path(("demo".to_string(), "demo_echo".to_string())),
        HeaderMap::new(),
        Bytes::new(),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response_json(response).await,
        json!({
            "is_error": true,
            "message": "boom",
            "content": "boom"
        })
    );
}

#[tokio::test]
async fn opt_in_retry_preserves_request_and_unlisted_tools_do_not_retry() {
    let route = sample_route();
    let mut tools = BTreeMap::new();
    tools.insert(route.route_name.clone(), route.clone());
    let session = Arc::new(MockSession::new(Err(anyhow!("connection reset by peer"))));
    let mut runtime = runtime_with_state(
        "demo",
        config_with_retryable_tool(&route.original_name),
        Some(session.clone()),
        tools.clone(),
        None,
        None,
    );
    Arc::get_mut(&mut runtime).unwrap().recovery.retry_delay = zero_retry_delay;
    let mut headers = HeaderMap::new();
    headers.insert(TOOL_CALL_ID_HEADER, HeaderValue::from_static("call-stable"));
    let response = handle_tool_call(
        State(app_state(
            "demo",
            runtime,
            Arc::new(OAuthCoordinator::new()),
        )),
        Path(("demo".to_string(), route.route_name.clone())),
        headers,
        Bytes::from_static(br#"{"value":"same"}"#),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(session.call_count(), 2);
    let requests = session.requests().await;
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0], requests[1]);

    let unlisted_session = Arc::new(MockSession::always_fails("connection reset by peer"));
    let unlisted_runtime = runtime_with_state(
        "demo",
        base_config(),
        Some(unlisted_session.clone()),
        tools,
        None,
        None,
    );
    let response = handle_tool_call(
        State(app_state(
            "demo",
            unlisted_runtime.clone(),
            Arc::new(OAuthCoordinator::new()),
        )),
        Path(("demo".to_string(), route.route_name)),
        HeaderMap::new(),
        Bytes::new(),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    let payload = response_json(response).await;
    assert_eq!(payload["retry_policy_owner"], "mcp-orc");
    assert_eq!(payload["retry_attempted"], false);
    assert_eq!(unlisted_session.call_count(), 1);
    assert_eq!(
        unlisted_runtime
            .recovery
            .control
            .lock()
            .await
            .failures
            .len(),
        1
    );
}

#[tokio::test]
async fn concurrent_transient_failures_have_one_retry_leader() {
    let route = sample_route();
    let mut tools = BTreeMap::new();
    tools.insert(route.route_name.clone(), route.clone());
    let session = Arc::new(MockSession::always_fails("broken pipe"));
    let mut runtime = runtime_with_state(
        "demo",
        config_with_retryable_tool(&route.original_name),
        Some(session.clone()),
        tools,
        None,
        None,
    );
    Arc::get_mut(&mut runtime).unwrap().recovery.retry_delay = slow_test_retry_delay;
    let state = app_state("demo", runtime.clone(), Arc::new(OAuthCoordinator::new()));
    let first_state = state.clone();
    let first_route = route.route_name.clone();
    let first = tokio::spawn(async move {
        handle_tool_call(
            State(first_state),
            Path(("demo".to_string(), first_route)),
            HeaderMap::new(),
            Bytes::new(),
        )
        .await
        .into_response()
    });

    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if runtime.recovery.control.lock().await.phase == RecoveryPhase::RetryLeader {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();

    let follower = handle_tool_call(
        State(state),
        Path(("demo".to_string(), route.route_name)),
        HeaderMap::new(),
        Bytes::new(),
    )
    .await
    .into_response();
    assert_eq!(follower.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        follower.headers().get("retry-after").unwrap(),
        &HeaderValue::from_static("15")
    );
    let follower_payload = response_json(follower).await;
    assert_eq!(follower_payload["recovery_state"], "retrying");

    let leader = first.await.unwrap();
    assert_eq!(leader.status(), StatusCode::BAD_GATEWAY);
    assert_eq!(session.call_count(), 3);
    assert_eq!(runtime.recovery.control.lock().await.failures.len(), 2);
}

#[tokio::test]
async fn success_resets_failure_window_and_permission_errors_never_count() {
    let route = sample_route();
    let mut tools = BTreeMap::new();
    tools.insert(route.route_name.clone(), route.clone());
    let session = Arc::new(MockSession::new(Err(anyhow!("connection closed"))));
    let runtime = runtime_with_state(
        "demo",
        base_config(),
        Some(session),
        tools.clone(),
        None,
        None,
    );
    let state = app_state("demo", runtime.clone(), Arc::new(OAuthCoordinator::new()));
    let first = handle_tool_call(
        State(state.clone()),
        Path(("demo".to_string(), route.route_name.clone())),
        HeaderMap::new(),
        Bytes::new(),
    )
    .await
    .into_response();
    assert_eq!(first.status(), StatusCode::BAD_GATEWAY);
    assert_eq!(runtime.recovery.control.lock().await.failures.len(), 1);
    let second = handle_tool_call(
        State(state),
        Path(("demo".to_string(), route.route_name.clone())),
        HeaderMap::new(),
        Bytes::new(),
    )
    .await
    .into_response();
    assert_eq!(second.status(), StatusCode::OK);
    assert!(runtime.recovery.control.lock().await.failures.is_empty());

    let permission_session = Arc::new(MockSession::always_fails("HTTP 403 Forbidden"));
    let permission_runtime = runtime_with_state(
        "demo",
        config_with_retryable_tool(&route.original_name),
        Some(permission_session.clone()),
        tools,
        None,
        None,
    );
    let permission = handle_tool_call(
        State(app_state(
            "demo",
            permission_runtime.clone(),
            Arc::new(OAuthCoordinator::new()),
        )),
        Path(("demo".to_string(), route.route_name)),
        HeaderMap::new(),
        Bytes::new(),
    )
    .await
    .into_response();
    assert_eq!(permission.status(), StatusCode::FORBIDDEN);
    assert_eq!(permission_session.call_count(), 1);
    assert!(permission_runtime
        .recovery
        .control
        .lock()
        .await
        .failures
        .is_empty());
}

#[tokio::test]
async fn third_distinct_failure_opens_circuit_but_waits_for_active_calls_to_drain() {
    let route = sample_route();
    let mut tools = BTreeMap::new();
    tools.insert(route.route_name.clone(), route.clone());
    let session = Arc::new(MockSession::always_fails("transport error: channel closed"));
    let runtime = runtime_with_state("demo", base_config(), Some(session), tools, None, None);
    // Represent another active logical call so the recovery task cannot close
    // the mock session during these assertions.
    runtime.recovery.in_flight.fetch_add(1, Ordering::SeqCst);
    let state = app_state("demo", runtime.clone(), Arc::new(OAuthCoordinator::new()));
    for expected_status in [
        StatusCode::BAD_GATEWAY,
        StatusCode::BAD_GATEWAY,
        StatusCode::SERVICE_UNAVAILABLE,
    ] {
        let response = handle_tool_call(
            State(state.clone()),
            Path(("demo".to_string(), route.route_name.clone())),
            HeaderMap::new(),
            Bytes::new(),
        )
        .await
        .into_response();
        assert_eq!(response.status(), expected_status);
    }
    let control = runtime.recovery.control.lock().await;
    assert_eq!(control.phase, RecoveryPhase::CircuitOpen);
    assert_eq!(control.failures.len(), 3);
    drop(control);
    assert_eq!(runtime.recovery.in_flight.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn failure_counter_uses_five_minute_rolling_window_without_waiting() {
    let mut runtime = runtime_with_state(
        "demo",
        base_config(),
        Some(Arc::new(MockSession::new(Ok(CallToolResult::success(
            vec![],
        ))))),
        BTreeMap::new(),
        None,
        None,
    );
    Arc::get_mut(&mut runtime).unwrap().recovery.now = fixed_recovery_test_now;
    let now = fixed_recovery_test_now();
    {
        let mut control = runtime.recovery.control.lock().await;
        for call_id in ["old-1", "old-2"] {
            control.failures.push_back(FailureEvidence {
                call_id: call_id.to_string(),
                occurred_at: now - RECOVERY_FAILURE_WINDOW - Duration::from_millis(1),
                category: FailureCategory::Transport,
            });
        }
    }

    let error = runtime
        .final_failure(
            "fresh",
            "connection reset".to_string(),
            FailureCategory::Transport,
            false,
            false,
        )
        .await;
    assert_eq!(error.recovery_state, RecoveryPhase::Healthy);
    let control = runtime.recovery.control.lock().await;
    assert_eq!(control.failures.len(), 1);
    assert_eq!(control.failures[0].call_id, "fresh");
}

#[tokio::test]
async fn status_exposes_safe_retry_policy_and_unknown_original_names() {
    let route = sample_route();
    let mut tools = BTreeMap::new();
    tools.insert(route.route_name.clone(), route);
    let runtime = runtime_with_state(
        "demo",
        config_with_retryable_tool("missingOriginalName"),
        Some(Arc::new(MockSession::new(Ok(CallToolResult::success(
            vec![],
        ))))),
        tools.clone(),
        None,
        None,
    );
    runtime.update_unknown_policy_entries(&tools).await;
    let status = runtime.status_json().await;
    assert_eq!(status["configured_retryable_tool_count"], 1);
    assert_eq!(
        status["unknown_retry_policy_entries"],
        json!(["missingOriginalName"])
    );
    assert_eq!(status["logical_in_flight_count"], 0);
    assert_eq!(status["recovery_state"], "healthy");
    assert!(status.get("arguments").is_none());
}

#[tokio::test(flavor = "current_thread")]
async fn recovery_reconnect_success_and_auth_required_both_avoid_restart() {
    let runtime = runtime_with_state(
        "demo",
        base_config(),
        Some(Arc::new(MockSession::new(Ok(CallToolResult::success(
            vec![],
        ))))),
        BTreeMap::new(),
        None,
        None,
    );
    {
        let mut control = runtime.recovery.control.lock().await;
        control.phase = RecoveryPhase::CircuitOpen;
        control.recovery_started = true;
    }
    *runtime.recovery.reconnect_outcome.lock().await = Some(Ok(()));
    runtime.clone().recover_after_drain().await;
    assert_eq!(
        runtime.recovery.control.lock().await.phase,
        RecoveryPhase::Healthy
    );

    {
        let mut control = runtime.recovery.control.lock().await;
        control.phase = RecoveryPhase::CircuitOpen;
        control.recovery_started = true;
    }
    *runtime.recovery.reconnect_outcome.lock().await = Some(Err(
        "OAuth authorization required; authorization_url=https://example.test/auth".to_string(),
    ));
    runtime.clone().recover_after_drain().await;
    assert_eq!(
        runtime.recovery.control.lock().await.phase,
        RecoveryPhase::AuthRequired
    );
}

#[tokio::test(flavor = "current_thread")]
async fn persistent_reconnect_failure_requests_exactly_one_coordinated_restart() {
    let _lock = crate::test_env_lock();
    let hits = Arc::new(AtomicUsize::new(0));
    let restart_server = TestServer::spawn(Router::new().route(
        "/demo",
        post({
            let hits = hits.clone();
            move || {
                let hits = hits.clone();
                async move {
                    hits.fetch_add(1, Ordering::SeqCst);
                    (StatusCode::OK, Json(json!({"success": true})))
                }
            }
        }),
    ))
    .await;
    let _env = EnvGuard::set(&[(
        "MCPO_RESTART_ENDPOINT_PREFIX",
        format!("{}/", restart_server.base_url),
    )]);
    let runtime = runtime_with_state(
        "demo",
        base_config(),
        Some(Arc::new(MockSession::new(Ok(CallToolResult::success(
            vec![],
        ))))),
        BTreeMap::new(),
        None,
        None,
    );
    {
        let mut control = runtime.recovery.control.lock().await;
        control.phase = RecoveryPhase::CircuitOpen;
        control.recovery_started = true;
    }
    *runtime.recovery.reconnect_outcome.lock().await =
        Some(Err("transport error: connection refused".to_string()));
    runtime.clone().recover_after_drain().await;
    assert_eq!(hits.load(Ordering::SeqCst), 1);
    assert_eq!(
        runtime.recovery.control.lock().await.phase,
        RecoveryPhase::RestartPending
    );

    runtime.clone().recover_after_drain().await;
    assert_eq!(hits.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn oauth_streamable_http_idle_sessions_reconnect_before_next_tool_call() {
    let _lock = crate::test_env_lock();
    let temp_root =
        std::env::temp_dir().join(format!("mcp-orc-idle-reconnect-{}", unique_test_suffix()));
    std::fs::create_dir_all(&temp_root).unwrap();
    let _env = EnvGuard::set(&[
        ("MCPO_TOKEN_STORAGE_DIR", temp_root.display().to_string()),
        ("MCPO_OAUTH_CALLBACK_PORT", "3834".to_string()),
    ]);

    let token_server = TestServer::token_server(json!({
        "access_token": "fresh-token",
        "token_type": "Bearer",
        "expires_in": 3600,
        "refresh_token": "refresh-token"
    }))
    .await;
    let mcp_server = TestMcpServerHandle::spawn().await.unwrap();
    let coordinator = Arc::new(OAuthCoordinator::new());
    let server_id = "demo";
    let route = sample_route();
    let mut tools = BTreeMap::new();
    tools.insert(route.route_name.clone(), route.clone());

    let config = ServerConfig {
        server_type: Some("streamable-http".to_string()),
        url: Some(mcp_server.url.clone()),
        oauth: Some(oauth_config(&token_server.base_url)),
        command: None,
        ..base_config()
    };

    let store = CompatTokenStore::new(server_id).unwrap();
    store
        .save_client_info(&CompatClientInfo {
            client_id: "client".to_string(),
            client_secret: Some("secret".to_string()),
            token_endpoint_auth_method: Some("client_secret_post".to_string()),
            ..Default::default()
        })
        .unwrap();
    store
        .save_token_file(&CompatTokenFile {
            access_token: "live-token".to_string(),
            refresh_token: Some("refresh-token".to_string()),
            token_type: Some("Bearer".to_string()),
            expires_in: Some(3600),
            scope: None,
            extra: Default::default(),
        })
        .unwrap();

    let oauth = OAuthBinding::new(server_id, &config, coordinator.clone())
        .await
        .unwrap();
    let session = connect_server(server_id, &config, Some(oauth.clone()))
        .await
        .unwrap();
    let stale_session = session.clone();

    let runtime = Arc::new(ServerRuntime {
        id: server_id.to_string(),
        config,
        oauth: RwLock::new(Some(oauth)),
        oauth_coordinator: coordinator.clone(),
        connect_lock: Mutex::new(()),
        recovery: RecoveryRuntime::default(),
        state: RwLock::new(ServerConnectionState {
            session: Some(session),
            tools,
            openapi: json!({"openapi": "3.1.0"}),
            title: server_id.to_string(),
            version: None,
            error: None,
            last_activity_at: Some(
                SystemTime::now()
                    - OAUTH_STREAMABLE_HTTP_IDLE_RECONNECT_THRESHOLD
                    - Duration::from_secs(1),
            ),
        }),
    });

    let response = handle_tool_call(
        State(app_state(server_id, runtime.clone(), coordinator)),
        Path((server_id.to_string(), route.route_name)),
        HeaderMap::new(),
        Bytes::from_static(br#"{"value":"hello"}"#),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response_json(response).await["echoed"], json!("hello"));
    assert!(stale_session.is_closed());

    let state = runtime.state.read().await;
    let refreshed_session = state.session.clone().unwrap();
    assert!(!Arc::ptr_eq(&stale_session, &refreshed_session));
    let idle_elapsed = SystemTime::now()
        .duration_since(state.last_activity_at.unwrap())
        .unwrap();
    assert!(idle_elapsed < Duration::from_secs(5));
}

#[tokio::test]
async fn oauth_streamable_http_recent_activity_uses_existing_session() {
    let route = sample_route();
    let mut tools = BTreeMap::new();
    tools.insert(route.route_name.clone(), route.clone());

    let config = ServerConfig {
        server_type: Some("streamable-http".to_string()),
        url: Some("http://example.test/mcp".to_string()),
        oauth: Some(json!({})),
        command: None,
        ..base_config()
    };
    let session = Arc::new(MockSession::new(Ok(CallToolResult::structured(
        json!({"ok": true}),
    ))));
    let runtime = runtime_with_state("demo", config, Some(session.clone()), tools, None, None);
    let response = handle_tool_call(
        State(app_state(
            "demo",
            runtime.clone(),
            Arc::new(OAuthCoordinator::new()),
        )),
        Path(("demo".to_string(), route.route_name)),
        HeaderMap::new(),
        Bytes::new(),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response_json(response).await, json!({"ok": true}));
    assert!(!session.is_closed());
    let state = runtime.state.read().await;
    assert!(state.session.is_some());
}

#[tokio::test]
async fn first_oauth_transport_failure_keeps_session_and_contributes_recovery_evidence() {
    let route = sample_route();
    let mut tools = BTreeMap::new();
    tools.insert(route.route_name.clone(), route.clone());

    let config = ServerConfig {
        server_type: Some("streamable-http".to_string()),
        url: Some("http://example.test/mcp".to_string()),
        oauth: Some(json!({})),
        command: None,
        ..base_config()
    };
    let session = Arc::new(MockSession::new(Err(anyhow!("failed to connect upstream"))));
    let runtime = runtime_with_state("demo", config, Some(session.clone()), tools, None, None);
    let response = handle_tool_call(
        State(app_state(
            "demo",
            runtime.clone(),
            Arc::new(OAuthCoordinator::new()),
        )),
        Path(("demo".to_string(), route.route_name)),
        HeaderMap::new(),
        Bytes::new(),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    assert!(!session.is_closed());

    let state = runtime.state.read().await;
    assert!(state.session.is_some());
    assert!(state.error.is_none());
    drop(state);
    assert_eq!(runtime.recovery.control.lock().await.failures.len(), 1);
}

#[tokio::test]
async fn non_oauth_tool_failures_keep_cached_session_unchanged() {
    let route = sample_route();
    let mut tools = BTreeMap::new();
    tools.insert(route.route_name.clone(), route.clone());

    let session = Arc::new(MockSession::new(Err(anyhow!("failed to connect upstream"))));
    let runtime = runtime_with_state(
        "demo",
        base_config(),
        Some(session.clone()),
        tools,
        None,
        None,
    );
    let response = handle_tool_call(
        State(app_state(
            "demo",
            runtime.clone(),
            Arc::new(OAuthCoordinator::new()),
        )),
        Path(("demo".to_string(), route.route_name)),
        HeaderMap::new(),
        Bytes::new(),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    assert!(!session.is_closed());

    let state = runtime.state.read().await;
    assert!(state.session.is_some());
    assert!(state.error.is_none());
}

#[tokio::test(flavor = "current_thread")]
async fn tool_call_handler_turns_clear_auth_failures_into_reauthorization() {
    let _lock = crate::test_env_lock();
    let temp_root =
        std::env::temp_dir().join(format!("mcp-orc-tool-auth-{}", unique_test_suffix()));
    std::fs::create_dir_all(&temp_root).unwrap();
    let _env = EnvGuard::set(&[
        ("MCPO_TOKEN_STORAGE_DIR", temp_root.display().to_string()),
        ("MCPO_OAUTH_CALLBACK_PORT", "3834".to_string()),
    ]);

    let token_server = TestServer::token_server(json!({
        "access_token": "fresh-token",
        "token_type": "Bearer",
        "expires_in": 3600
    }))
    .await;
    let coordinator = Arc::new(OAuthCoordinator::new());
    let server_id = format!("auth-demo-{}", unique_test_suffix());
    let route = sample_route();
    let mut tools = BTreeMap::new();
    tools.insert(route.route_name.clone(), route.clone());

    let mut oauth_value = oauth_config(&token_server.base_url);
    oauth_value["storage_type"] = json!("memory");
    let config = ServerConfig {
        server_type: Some("streamable-http".to_string()),
        url: Some(format!("{}/mcp", token_server.base_url)),
        oauth: Some(oauth_value),
        command: None,
        ..base_config()
    };
    let oauth = OAuthBinding::new(&server_id, &config, coordinator.clone())
        .await
        .unwrap();
    let session = Arc::new(MockSession::new(Err(anyhow!(
        "tool call failed: Authentication failed. Please re-authenticate with a valid token."
    ))));
    let runtime = Arc::new(ServerRuntime {
        id: server_id.clone(),
        config,
        oauth: RwLock::new(Some(oauth)),
        oauth_coordinator: coordinator.clone(),
        connect_lock: Mutex::new(()),
        recovery: RecoveryRuntime::default(),
        state: RwLock::new(ServerConnectionState {
            session: Some(session.clone()),
            tools,
            openapi: json!({"openapi": "3.1.0"}),
            title: server_id.clone(),
            version: None,
            error: None,
            last_activity_at: Some(SystemTime::now()),
        }),
    });

    let response = handle_tool_call(
        State(app_state(&server_id, runtime, coordinator)),
        Path((server_id.clone(), route.route_name)),
        HeaderMap::new(),
        Bytes::new(),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    let payload = response_json(response).await;
    assert_eq!(payload["message"], json!("OAuth re-authorization required"));
    assert_eq!(payload["server_id"], json!(server_id));
    assert_eq!(payload["oauth_recovery_required"], json!(true));
    assert_eq!(payload["force_auth_recommended"], json!(true));
    assert!(payload["authorization_url"]
        .as_str()
        .unwrap_or_default()
        .contains("/authorize?"));
    assert_eq!(session.call_count(), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn tool_call_handler_retries_in_band_token_expired_after_refresh_reconnect() {
    let _lock = crate::test_env_lock();
    let temp_root =
        std::env::temp_dir().join(format!("mcp-orc-tool-auth-retry-{}", unique_test_suffix()));
    std::fs::create_dir_all(&temp_root).unwrap();
    let _env = EnvGuard::set(&[
        ("MCPO_TOKEN_STORAGE_DIR", temp_root.display().to_string()),
        ("MCPO_OAUTH_CALLBACK_PORT", "3834".to_string()),
    ]);

    let token_server = TestServer::token_server(json!({
        "access_token": "fresh-token",
        "token_type": "Bearer",
        "expires_in": 3600
    }))
    .await;
    let mcp_server = TestMcpServerHandle::spawn().await.unwrap();
    let coordinator = Arc::new(OAuthCoordinator::new());
    let server_id = format!("auth-retry-demo-{}", unique_test_suffix());
    let route = sample_route();
    let mut tools = BTreeMap::new();
    tools.insert(route.route_name.clone(), route.clone());

    let config = ServerConfig {
        server_type: Some("streamable-http".to_string()),
        url: Some(mcp_server.url.clone()),
        oauth: Some(oauth_config(&token_server.base_url)),
        command: None,
        ..base_config()
    };
    let store = CompatTokenStore::new(&server_id).unwrap();
    store
        .save_client_info(&CompatClientInfo {
            client_id: "client".to_string(),
            client_secret: Some("secret".to_string()),
            token_endpoint_auth_method: Some("client_secret_post".to_string()),
            ..Default::default()
        })
        .unwrap();
    store
        .save_token_file(&CompatTokenFile {
            access_token: "stale-token".to_string(),
            refresh_token: Some("refresh-token".to_string()),
            token_type: Some("Bearer".to_string()),
            expires_in: Some(1),
            scope: None,
            extra: Default::default(),
        })
        .unwrap();

    let oauth = OAuthBinding::new(&server_id, &config, coordinator.clone())
        .await
        .unwrap();
    let session = Arc::new(MockSession::new(Ok(CallToolResult::structured_error(
        json!({
            "message": "token_expired",
        }),
    ))));
    let runtime = Arc::new(ServerRuntime {
        id: server_id.clone(),
        config,
        oauth: RwLock::new(Some(oauth)),
        oauth_coordinator: coordinator.clone(),
        connect_lock: Mutex::new(()),
        recovery: RecoveryRuntime::default(),
        state: RwLock::new(ServerConnectionState {
            session: Some(session.clone()),
            tools,
            openapi: json!({"openapi": "3.1.0"}),
            title: server_id.clone(),
            version: None,
            error: None,
            last_activity_at: Some(SystemTime::now()),
        }),
    });

    let response = handle_tool_call(
        State(app_state(&server_id, runtime, coordinator)),
        Path((server_id.clone(), route.route_name)),
        HeaderMap::new(),
        Bytes::from_static(br#"{"value":"hello"}"#),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::OK);

    let payload = response_json(response).await;
    assert_eq!(payload["echoed"], json!("hello"));
    assert_eq!(session.call_count(), 1);
    assert!(session.is_closed());
    let refreshed = store.load_token_file().unwrap().unwrap();
    assert_eq!(refreshed.access_token, "fresh-token");
}

#[tokio::test(flavor = "current_thread")]
async fn tool_call_handler_retries_google_refresh_credentials_payload() {
    let _lock = crate::test_env_lock();
    let temp_root = std::env::temp_dir().join(format!(
        "mcp-orc-tool-google-auth-retry-{}",
        unique_test_suffix()
    ));
    std::fs::create_dir_all(&temp_root).unwrap();
    let _env = EnvGuard::set(&[
        ("MCPO_TOKEN_STORAGE_DIR", temp_root.display().to_string()),
        ("MCPO_OAUTH_CALLBACK_PORT", "3834".to_string()),
    ]);

    let token_server = TestServer::token_server(json!({
        "access_token": "fresh-token",
        "token_type": "Bearer",
        "expires_in": 3600
    }))
    .await;
    let mcp_server = TestMcpServerHandle::spawn().await.unwrap();
    let coordinator = Arc::new(OAuthCoordinator::new());
    let server_id = format!("google-auth-retry-demo-{}", unique_test_suffix());
    let route = sample_route();
    let mut tools = BTreeMap::new();
    tools.insert(route.route_name.clone(), route.clone());

    let config = ServerConfig {
        server_type: Some("streamable-http".to_string()),
        url: Some(mcp_server.url.clone()),
        oauth: Some(oauth_config(&token_server.base_url)),
        command: None,
        ..base_config()
    };
    let store = CompatTokenStore::new(&server_id).unwrap();
    store
        .save_client_info(&CompatClientInfo {
            client_id: "client".to_string(),
            client_secret: Some("secret".to_string()),
            token_endpoint_auth_method: Some("client_secret_post".to_string()),
            ..Default::default()
        })
        .unwrap();
    store
        .save_token_file(&CompatTokenFile {
            access_token: "stale-token".to_string(),
            refresh_token: Some("refresh-token".to_string()),
            token_type: Some("Bearer".to_string()),
            expires_in: Some(1),
            scope: None,
            extra: Default::default(),
        })
        .unwrap();

    let oauth = OAuthBinding::new(&server_id, &config, coordinator.clone())
        .await
        .unwrap();
    let google_error = serde_json::to_string(&json!({
        "success": false,
        "operations_completed": 0,
        "total_operations": 11,
        "message": "Failed to fetch document: The credentials do not contain the necessary fields need to refresh the access token. You must specify refresh_token, token_uri, client_id, and client_secret.",
        "document_link": null
    }))
    .unwrap();
    let session = Arc::new(MockSession::new(Ok(CallToolResult::structured(json!({
        "result": google_error,
    })))));
    let runtime = Arc::new(ServerRuntime {
        id: server_id.clone(),
        config,
        oauth: RwLock::new(Some(oauth)),
        oauth_coordinator: coordinator.clone(),
        connect_lock: Mutex::new(()),
        recovery: RecoveryRuntime::default(),
        state: RwLock::new(ServerConnectionState {
            session: Some(session.clone()),
            tools,
            openapi: json!({"openapi": "3.1.0"}),
            title: server_id.clone(),
            version: None,
            error: None,
            last_activity_at: Some(SystemTime::now()),
        }),
    });

    let response = handle_tool_call(
        State(app_state(&server_id, runtime, coordinator)),
        Path((server_id.clone(), route.route_name)),
        HeaderMap::new(),
        Bytes::from_static(br#"{"value":"hello"}"#),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::OK);

    let payload = response_json(response).await;
    assert_eq!(payload["echoed"], json!("hello"));
    assert_eq!(session.call_count(), 1);
    assert!(session.is_closed());
    let refreshed = store.load_token_file().unwrap().unwrap();
    assert_eq!(refreshed.access_token, "fresh-token");
}

#[tokio::test(flavor = "current_thread")]
async fn tool_call_handler_does_not_retry_in_band_auth_error_when_reauth_required() {
    let _lock = crate::test_env_lock();
    let temp_root = std::env::temp_dir().join(format!(
        "mcp-orc-tool-auth-no-retry-{}",
        unique_test_suffix()
    ));
    std::fs::create_dir_all(&temp_root).unwrap();
    let _env = EnvGuard::set(&[
        ("MCPO_TOKEN_STORAGE_DIR", temp_root.display().to_string()),
        ("MCPO_OAUTH_CALLBACK_PORT", "3834".to_string()),
    ]);

    let token_server = TestServer::token_server(json!({
        "access_token": "fresh-token",
        "token_type": "Bearer",
        "expires_in": 3600
    }))
    .await;
    let coordinator = Arc::new(OAuthCoordinator::new());
    let server_id = format!("auth-no-retry-demo-{}", unique_test_suffix());
    let route = sample_route();
    let mut tools = BTreeMap::new();
    tools.insert(route.route_name.clone(), route.clone());

    let config = ServerConfig {
        server_type: Some("streamable-http".to_string()),
        url: Some(format!("{}/mcp", token_server.base_url)),
        oauth: Some(oauth_config(&token_server.base_url)),
        command: None,
        ..base_config()
    };
    let oauth = OAuthBinding::new(&server_id, &config, coordinator.clone())
        .await
        .unwrap();
    let session = Arc::new(MockSession::new(Ok(CallToolResult::structured_error(
        json!({
            "message": "token_expired",
        }),
    ))));
    let runtime = Arc::new(ServerRuntime {
        id: server_id.clone(),
        config,
        oauth: RwLock::new(Some(oauth)),
        oauth_coordinator: coordinator.clone(),
        connect_lock: Mutex::new(()),
        recovery: RecoveryRuntime::default(),
        state: RwLock::new(ServerConnectionState {
            session: Some(session.clone()),
            tools,
            openapi: json!({"openapi": "3.1.0"}),
            title: server_id.clone(),
            version: None,
            error: None,
            last_activity_at: Some(SystemTime::now()),
        }),
    });

    let response = handle_tool_call(
        State(app_state(&server_id, runtime, coordinator)),
        Path((server_id.clone(), route.route_name)),
        HeaderMap::new(),
        Bytes::new(),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    let payload = response_json(response).await;
    assert_eq!(payload["error_type"], json!("authorization_required"));
    assert_eq!(payload["retry_policy_owner"], json!("mcp-orc"));
    assert_eq!(session.call_count(), 1);
    assert!(!session.is_closed());
}

#[tokio::test(flavor = "current_thread")]
async fn tool_call_handler_surfaces_empty_oauth_payload_without_retry() {
    let _lock = crate::test_env_lock();
    let temp_root = std::env::temp_dir().join(format!(
        "mcp-orc-tool-empty-payload-{}",
        unique_test_suffix()
    ));
    std::fs::create_dir_all(&temp_root).unwrap();
    let _env = EnvGuard::set(&[
        ("MCPO_TOKEN_STORAGE_DIR", temp_root.display().to_string()),
        ("MCPO_OAUTH_CALLBACK_PORT", "3834".to_string()),
    ]);

    let token_server = TestServer::token_server(json!({
        "access_token": "fresh-token",
        "token_type": "Bearer",
        "expires_in": 3600
    }))
    .await;
    let coordinator = Arc::new(OAuthCoordinator::new());
    let server_id = format!("empty-payload-demo-{}", unique_test_suffix());
    let route = sample_route();
    let mut tools = BTreeMap::new();
    tools.insert(route.route_name.clone(), route.clone());

    let mut oauth_value = oauth_config(&token_server.base_url);
    oauth_value["storage_type"] = json!("memory");
    let config = ServerConfig {
        server_type: Some("streamable-http".to_string()),
        url: Some(format!("{}/mcp", token_server.base_url)),
        oauth: Some(oauth_value),
        command: None,
        ..base_config()
    };
    let oauth = OAuthBinding::new(&server_id, &config, coordinator.clone())
        .await
        .unwrap();
    let session = Arc::new(MockSession::new(Ok(CallToolResult::success(vec![]))));
    let runtime = Arc::new(ServerRuntime {
        id: server_id.clone(),
        config,
        oauth: RwLock::new(Some(oauth)),
        oauth_coordinator: coordinator.clone(),
        connect_lock: Mutex::new(()),
        recovery: RecoveryRuntime::default(),
        state: RwLock::new(ServerConnectionState {
            session: Some(session.clone()),
            tools,
            openapi: json!({"openapi": "3.1.0"}),
            title: server_id.clone(),
            version: None,
            error: None,
            last_activity_at: Some(SystemTime::now()),
        }),
    });

    let response = handle_tool_call(
        State(app_state(&server_id, runtime, coordinator)),
        Path((server_id.clone(), route.route_name)),
        HeaderMap::new(),
        Bytes::new(),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response_json(response).await, Value::Null);
    assert_eq!(session.call_count(), 1);
}

#[tokio::test]
async fn tool_call_handler_forwards_request_headers_to_mcp_session_meta() {
    let route = sample_route();
    let mut tools = BTreeMap::new();
    tools.insert(route.route_name.clone(), route.clone());

    let mut config = base_config();
    config.client_header_forwarding = Some(json!({
        "enabled": true,
        "allowed_headers": ["x-keep"],
    }));
    let session = Arc::new(MockSession::new(Ok(CallToolResult::structured(
        json!({"ok": true}),
    ))));
    let state = app_state(
        "demo",
        runtime_with_state("demo", config, Some(session.clone()), tools, None, None),
        Arc::new(OAuthCoordinator::new()),
    );

    let mut headers = HeaderMap::new();
    headers.insert("x-keep", HeaderValue::from_static("yes"));
    headers.insert("x-drop", HeaderValue::from_static("no"));

    let response = handle_tool_call(
        State(state),
        Path(("demo".to_string(), route.route_name.clone())),
        headers,
        Bytes::new(),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response_json(response).await, json!({"ok": true}));

    assert_eq!(
        session.last_request_meta.lock().await.clone().unwrap(),
        json!({
            "headers": {
                "x-keep": "yes",
            }
        })
    );
}

#[tokio::test(flavor = "current_thread")]
async fn tool_call_handler_spills_large_results_to_agent_vm_and_enables_tool() {
    let _lock = crate::test_env_lock();
    let chat_id = format!("chat-overflow-{}", unique_test_suffix());
    let vm_id = format!("vm-overflow-{}", unique_test_suffix());
    let (core_server, core_state) = spawn_overflow_core_server(&vm_id).await;
    let _env = EnvGuard::set(&[
        ("CORE_MCP_TEST_REDIS", "memory".to_string()),
        ("MCPO_CORE_PROXY_BASE_URL", core_server.base_url.clone()),
        ("MCP_TOOL_RESULT_MAX_CHARS", "10".to_string()),
    ]);

    let route = sample_route();
    let mut tools = BTreeMap::new();
    tools.insert(route.route_name.clone(), route.clone());
    let state = app_state(
        "demo",
        runtime_with_state(
            "demo",
            base_config(),
            Some(Arc::new(MockSession::new(Ok(CallToolResult::structured(
                json!({"payload": "x".repeat(256)}),
            ))))),
            tools.clone(),
            None,
            None,
        ),
        Arc::new(OAuthCoordinator::new()),
    );

    let mut headers = HeaderMap::new();
    headers.insert(
        "x-openwebui-chat-id",
        HeaderValue::from_str(&chat_id).unwrap(),
    );

    let response = handle_tool_call(
        State(state),
        Path(("demo".to_string(), route.route_name.clone())),
        headers,
        Bytes::new(),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::OK);

    let payload = response_json(response).await;
    assert_eq!(payload["overflow_file"], json!(true));
    assert_eq!(payload["tool_name"], json!("demo_echo"));
    assert_eq!(payload["vm_id"], json!(vm_id));
    assert_eq!(payload["format"], json!("json"));
    assert!(payload["char_count"].as_u64().unwrap() > 10);
    assert!(payload["path"]
        .as_str()
        .unwrap()
        .starts_with("/work/.mcp-overflow/"));
    assert!(payload["read_hint"]
        .as_str()
        .unwrap()
        .contains("Do not dump the raw overflow file"));
    assert!(payload["read_hint"].as_str().unwrap().contains("grep_file"));
    assert!(payload["read_hint"]
        .as_str()
        .unwrap()
        .contains("read_fragment"));
    assert!(payload["read_hint"]
        .as_str()
        .unwrap()
        .contains("under 2,000 chars"));

    let create_calls = core_state.create_calls().await;
    assert_eq!(create_calls.len(), 1);
    assert_eq!(create_calls[0]["chat_id"], json!(chat_id));

    let status_calls = core_state.status_calls().await;
    assert!(status_calls.is_empty());

    let file_calls = core_state.file_calls().await;
    assert!(!file_calls.is_empty());
    assert_eq!(file_calls[0]["vm_id"], json!(vm_id));
    assert_eq!(file_calls[0]["path"], payload["path"]);
    assert_eq!(file_calls[0]["append"], json!(false));
    let combined_content = file_calls
        .iter()
        .map(|call| call["content"].as_str().unwrap_or_default())
        .collect::<String>();
    assert!(combined_content.contains("\"payload\""));
    for call in file_calls.iter().skip(1) {
        assert_eq!(call["append"], json!(true));
    }

    assert_eq!(
        redis_get_string(&format!("agent_vm:{chat_id}"))
            .unwrap()
            .as_deref(),
        Some(vm_id.as_str())
    );
    let enabled_tools: Vec<String> = serde_json::from_str(
        &redis_get_string(&format!("chat_tools:{chat_id}"))
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert!(enabled_tools.iter().any(|tool| tool == "server:agent-vm"));
}

#[tokio::test(flavor = "current_thread")]
async fn tool_call_handler_keeps_core_non_web_results_inline_without_spilling() {
    let _lock = crate::test_env_lock();
    let chat_id = format!("chat-core-inline-{}", unique_test_suffix());
    let (core_server, core_state) = spawn_overflow_core_server("vm-unused").await;
    let _env = EnvGuard::set(&[
        ("CORE_MCP_TEST_REDIS", "memory".to_string()),
        ("MCPO_CORE_PROXY_BASE_URL", core_server.base_url.clone()),
        ("MCP_TOOL_RESULT_MAX_CHARS", "10".to_string()),
    ]);

    let route = sample_route();
    let mut tools = BTreeMap::new();
    tools.insert(route.route_name.clone(), route.clone());
    let state = app_state(
        "skills",
        runtime_with_state(
            "skills",
            base_config(),
            Some(Arc::new(MockSession::new(Ok(CallToolResult::structured(
                json!({"payload": "x".repeat(256)}),
            ))))),
            tools,
            None,
            None,
        ),
        Arc::new(OAuthCoordinator::new()),
    );

    let mut headers = HeaderMap::new();
    headers.insert(
        "x-openwebui-chat-id",
        HeaderValue::from_str(&chat_id).unwrap(),
    );

    let response = handle_tool_call(
        State(state),
        Path(("skills".to_string(), route.route_name.clone())),
        headers,
        Bytes::new(),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response_json(response).await,
        json!({"payload": "x".repeat(256)})
    );
    assert!(core_state.create_calls().await.is_empty());
    assert!(core_state.status_calls().await.is_empty());
    assert!(core_state.file_calls().await.is_empty());
}

#[tokio::test(flavor = "current_thread")]
async fn tool_call_handler_still_spills_large_results_for_web_tools() {
    let _lock = crate::test_env_lock();
    let chat_id = format!("chat-web-tools-overflow-{}", unique_test_suffix());
    let vm_id = format!("vm-web-tools-overflow-{}", unique_test_suffix());
    let (core_server, core_state) = spawn_overflow_core_server(&vm_id).await;
    let _env = EnvGuard::set(&[
        ("CORE_MCP_TEST_REDIS", "memory".to_string()),
        ("MCPO_CORE_PROXY_BASE_URL", core_server.base_url.clone()),
        ("MCP_TOOL_RESULT_MAX_CHARS", "10".to_string()),
    ]);

    let route = sample_route();
    let mut tools = BTreeMap::new();
    tools.insert(route.route_name.clone(), route.clone());
    let state = app_state(
        "web-tools",
        runtime_with_state(
            "web-tools",
            base_config(),
            Some(Arc::new(MockSession::new(Ok(CallToolResult::structured(
                json!({"payload": "x".repeat(256)}),
            ))))),
            tools,
            None,
            None,
        ),
        Arc::new(OAuthCoordinator::new()),
    );

    let mut headers = HeaderMap::new();
    headers.insert(
        "x-openwebui-chat-id",
        HeaderValue::from_str(&chat_id).unwrap(),
    );

    let response = handle_tool_call(
        State(state),
        Path(("web-tools".to_string(), route.route_name.clone())),
        headers,
        Bytes::new(),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::OK);

    let payload = response_json(response).await;
    assert_eq!(payload["overflow_file"], json!(true));
    assert_eq!(payload["vm_id"], json!(vm_id));
    assert_eq!(payload["tool_name"], json!("demo_echo"));
    assert!(!core_state.create_calls().await.is_empty());
    assert!(core_state.file_calls().await.len() >= 1);
}

#[tokio::test(flavor = "current_thread")]
async fn tool_call_handler_chunks_spill_writes_when_core_route_has_small_limit() {
    let _lock = crate::test_env_lock();
    let chat_id = format!("chat-overflow-chunked-{}", unique_test_suffix());
    let vm_id = format!("vm-overflow-chunked-{}", unique_test_suffix());
    let (core_server, core_state) = spawn_overflow_core_server_with_limit(&vm_id, Some(64)).await;
    let _env = EnvGuard::set(&[
        ("CORE_MCP_TEST_REDIS", "memory".to_string()),
        ("MCPO_CORE_PROXY_BASE_URL", core_server.base_url.clone()),
        ("MCP_TOOL_RESULT_MAX_CHARS", "10".to_string()),
        ("MCP_OVERFLOW_WRITE_CHUNK_BYTES", "32".to_string()),
    ]);

    let route = sample_route();
    let mut tools = BTreeMap::new();
    tools.insert(route.route_name.clone(), route.clone());
    let state = app_state(
        "demo",
        runtime_with_state(
            "demo",
            base_config(),
            Some(Arc::new(MockSession::new(Ok(CallToolResult::structured(
                json!({"payload": "x".repeat(256)}),
            ))))),
            tools.clone(),
            None,
            None,
        ),
        Arc::new(OAuthCoordinator::new()),
    );

    let mut headers = HeaderMap::new();
    headers.insert(
        "x-openwebui-chat-id",
        HeaderValue::from_str(&chat_id).unwrap(),
    );

    let response = handle_tool_call(
        State(state),
        Path(("demo".to_string(), route.route_name.clone())),
        headers,
        Bytes::new(),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::OK);

    let payload = response_json(response).await;
    assert_eq!(payload["overflow_file"], json!(true));

    let file_calls = core_state.file_calls().await;
    assert!(file_calls.len() > 1);
    assert_eq!(file_calls[0]["append"], json!(false));
    for call in &file_calls {
        assert!(call["content"].as_str().unwrap_or_default().len() <= 32);
    }
    for call in file_calls.iter().skip(1) {
        assert_eq!(call["append"], json!(true));
    }
}

#[tokio::test(flavor = "current_thread")]
async fn tool_call_handler_rebuilds_overflow_pointer_from_replacement_vm_and_path() {
    let _lock = crate::test_env_lock();
    let chat_id = format!("chat-overflow-replacement-{}", unique_test_suffix());
    let requested_vm_id = format!("vm-overflow-requested-{}", unique_test_suffix());
    let effective_vm_id = format!("vm-overflow-effective-{}", unique_test_suffix());
    let effective_path = "/work/.mcp-overflow/recovered.json";
    let (core_server, core_state) = spawn_overflow_core_server_with_file_response(
        &requested_vm_id,
        None,
        None,
        json!({
            "success": true,
            "vm_id": effective_vm_id,
            "path": effective_path,
        }),
    )
    .await;
    let _env = EnvGuard::set(&[
        ("CORE_MCP_TEST_REDIS", "memory".to_string()),
        ("MCPO_CORE_PROXY_BASE_URL", core_server.base_url.clone()),
        ("MCP_TOOL_RESULT_MAX_CHARS", "10".to_string()),
        ("MCP_OVERFLOW_WRITE_CHUNK_BYTES", "32".to_string()),
    ]);

    let route = sample_route();
    let mut tools = BTreeMap::new();
    tools.insert(route.route_name.clone(), route.clone());
    let state = app_state(
        "demo",
        runtime_with_state(
            "demo",
            base_config(),
            Some(Arc::new(MockSession::new(Ok(CallToolResult::structured(
                json!({"payload": "x".repeat(256)}),
            ))))),
            tools.clone(),
            None,
            None,
        ),
        Arc::new(OAuthCoordinator::new()),
    );

    let mut headers = HeaderMap::new();
    headers.insert(
        "x-openwebui-chat-id",
        HeaderValue::from_str(&chat_id).unwrap(),
    );

    let response = handle_tool_call(
        State(state),
        Path(("demo".to_string(), route.route_name.clone())),
        headers,
        Bytes::new(),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::OK);

    let payload = response_json(response).await;
    assert_eq!(payload["overflow_file"], json!(true));
    assert_eq!(payload["vm_id"], json!(effective_vm_id));
    assert_eq!(payload["path"], json!(effective_path));

    let file_calls = core_state.file_calls().await;
    assert!(file_calls.len() > 1);
    assert_eq!(file_calls[0]["vm_id"], json!(requested_vm_id));
    assert_ne!(file_calls[0]["path"], json!(effective_path));
    assert_eq!(file_calls[0]["append"], json!(false));
    for call in file_calls.iter().skip(1) {
        assert_eq!(call["vm_id"], json!(effective_vm_id));
        assert_eq!(call["path"], json!(effective_path));
        assert_eq!(call["append"], json!(true));
    }
}

#[tokio::test(flavor = "current_thread")]
async fn tool_call_handler_keeps_large_results_inline_without_chat_header() {
    let _lock = crate::test_env_lock();
    let (core_server, core_state) = spawn_overflow_core_server("vm-unused").await;
    let _env = EnvGuard::set(&[
        ("CORE_MCP_TEST_REDIS", "memory".to_string()),
        ("MCPO_CORE_PROXY_BASE_URL", core_server.base_url.clone()),
        ("MCP_TOOL_RESULT_MAX_CHARS", "10".to_string()),
    ]);

    let route = sample_route();
    let mut tools = BTreeMap::new();
    tools.insert(route.route_name.clone(), route.clone());
    let state = app_state(
        "demo",
        runtime_with_state(
            "demo",
            base_config(),
            Some(Arc::new(MockSession::new(Ok(CallToolResult::structured(
                json!({"payload": "x".repeat(256)}),
            ))))),
            tools.clone(),
            None,
            None,
        ),
        Arc::new(OAuthCoordinator::new()),
    );

    let response = handle_tool_call(
        State(state),
        Path(("demo".to_string(), route.route_name.clone())),
        HeaderMap::new(),
        Bytes::new(),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response_json(response).await,
        json!({"payload": "x".repeat(256)})
    );
    assert!(core_state.create_calls().await.is_empty());
    assert!(core_state.status_calls().await.is_empty());
    assert!(core_state.file_calls().await.is_empty());
}

#[tokio::test(flavor = "current_thread")]
async fn tool_call_handler_reuses_existing_chat_vm_for_large_results() {
    let _lock = crate::test_env_lock();
    let chat_id = format!("chat-overflow-reuse-{}", unique_test_suffix());
    let vm_id = format!("vm-overflow-reuse-{}", unique_test_suffix());
    let (core_server, core_state) = spawn_overflow_core_server(&vm_id).await;
    let _env = EnvGuard::set(&[
        ("CORE_MCP_TEST_REDIS", "memory".to_string()),
        ("MCPO_CORE_PROXY_BASE_URL", core_server.base_url.clone()),
        ("MCP_TOOL_RESULT_MAX_CHARS", "10".to_string()),
    ]);
    redis_setex_string(&format!("agent_vm:{chat_id}"), &vm_id, 3600).unwrap();

    let route = sample_route();
    let mut tools = BTreeMap::new();
    tools.insert(route.route_name.clone(), route.clone());
    let state = app_state(
        "demo",
        runtime_with_state(
            "demo",
            base_config(),
            Some(Arc::new(MockSession::new(Ok(CallToolResult::structured(
                json!({"payload": "x".repeat(256)}),
            ))))),
            tools.clone(),
            None,
            None,
        ),
        Arc::new(OAuthCoordinator::new()),
    );

    let mut headers = HeaderMap::new();
    headers.insert(
        "x-openwebui-chat-id",
        HeaderValue::from_str(&chat_id).unwrap(),
    );

    let response = handle_tool_call(
        State(state),
        Path(("demo".to_string(), route.route_name.clone())),
        headers,
        Bytes::new(),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response_json(response).await["vm_id"], json!(vm_id));
    assert!(core_state.create_calls().await.is_empty());
    assert_eq!(core_state.status_calls().await.len(), 1);
    assert_eq!(core_state.file_calls().await.len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tool_call_handler_reuses_one_overflow_vm_when_parallel_calls_race() {
    let _lock = crate::test_env_lock();
    let chat_id = format!("chat-overflow-race-{}", unique_test_suffix());
    let vm_id = format!("vm-overflow-race-{}", unique_test_suffix());
    let (core_server, core_state) =
        spawn_overflow_core_server_with_behavior(&vm_id, None, Some(50)).await;
    let _env = EnvGuard::set(&[
        ("CORE_MCP_TEST_REDIS", "memory".to_string()),
        ("MCPO_CORE_PROXY_BASE_URL", core_server.base_url.clone()),
        ("MCP_TOOL_RESULT_MAX_CHARS", "10".to_string()),
    ]);

    let route = sample_route();
    let mut tools = BTreeMap::new();
    tools.insert(route.route_name.clone(), route.clone());
    let state_a = app_state(
        "demo",
        runtime_with_state(
            "demo",
            base_config(),
            Some(Arc::new(MockSession::new(Ok(CallToolResult::structured(
                json!({"payload": "x".repeat(256)}),
            ))))),
            tools.clone(),
            None,
            None,
        ),
        Arc::new(OAuthCoordinator::new()),
    );
    let state_b = app_state(
        "demo",
        runtime_with_state(
            "demo",
            base_config(),
            Some(Arc::new(MockSession::new(Ok(CallToolResult::structured(
                json!({"payload": "x".repeat(256)}),
            ))))),
            tools,
            None,
            None,
        ),
        Arc::new(OAuthCoordinator::new()),
    );

    let mut headers = HeaderMap::new();
    headers.insert(
        "x-openwebui-chat-id",
        HeaderValue::from_str(&chat_id).unwrap(),
    );

    let headers_a = headers.clone();
    let headers_b = headers.clone();

    let (response_a, response_b) = tokio::join!(
        async {
            handle_tool_call(
                State(state_a),
                Path(("demo".to_string(), route.route_name.clone())),
                headers_a,
                Bytes::new(),
            )
            .await
            .into_response()
        },
        async {
            handle_tool_call(
                State(state_b),
                Path(("demo".to_string(), route.route_name.clone())),
                headers_b,
                Bytes::new(),
            )
            .await
            .into_response()
        }
    );

    assert_eq!(response_a.status(), StatusCode::OK);
    assert_eq!(response_b.status(), StatusCode::OK);
    let payload_a = response_json(response_a).await;
    let payload_b = response_json(response_b).await;
    assert_eq!(core_state.create_calls().await.len(), 1);
    assert_eq!(payload_a["vm_id"], json!(vm_id), "payload_a={payload_a}");
    assert_eq!(payload_b["vm_id"], json!(vm_id), "payload_b={payload_b}");
}

#[tokio::test]
async fn oauth_refresh_handler_covers_not_found_bad_request_and_internal_error() {
    let coordinator = Arc::new(OAuthCoordinator::new());
    let missing = handle_oauth_refresh(
        State(AppState::new(BTreeMap::new(), coordinator.clone())),
        Path("missing".to_string()),
    )
    .await
    .into_response();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);

    let non_oauth = runtime_with_state("demo", base_config(), None, BTreeMap::new(), None, None);
    let response = handle_oauth_refresh(
        State(app_state("demo", non_oauth, coordinator.clone())),
        Path("demo".to_string()),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let config = ServerConfig {
        server_type: Some("streamable-http".to_string()),
        url: Some("http://127.0.0.1:1/mcp".to_string()),
        oauth: Some(json!({})),
        command: None,
        ..base_config()
    };
    let oauth = OAuthBinding::new("demo", &config, coordinator.clone())
        .await
        .unwrap();
    let response = handle_oauth_refresh(
        State(app_state(
            "demo",
            runtime_with_state("demo", config, None, BTreeMap::new(), Some(oauth), None),
            coordinator,
        )),
        Path("demo".to_string()),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
}

#[tokio::test]
async fn ensure_connected_short_circuits_after_failed_oauth_handshake() {
    let coordinator = Arc::new(OAuthCoordinator::new());
    let config = ServerConfig {
        server_type: Some("streamable-http".to_string()),
        url: Some("http://127.0.0.1:1/mcp".to_string()),
        oauth: Some(json!({})),
        command: None,
        ..base_config()
    };
    let oauth = OAuthBinding::new("demo", &config, coordinator.clone())
        .await
        .unwrap();
    let runtime = Arc::new(ServerRuntime {
        id: "demo".to_string(),
        config: config.clone(),
        oauth: RwLock::new(Some(oauth)),
        oauth_coordinator: coordinator.clone(),
        connect_lock: Mutex::new(()),
        recovery: RecoveryRuntime::default(),
        state: RwLock::new(ServerConnectionState {
            session: None,
            tools: BTreeMap::new(),
            openapi: json!({"openapi": "3.1.0"}),
            title: "demo".to_string(),
            version: None,
            error: None,
            last_activity_at: Some(SystemTime::now()),
        }),
    });

    coordinator
        .mark_failed("demo", "persisted OAuth auth failure".to_string())
        .await;
    let error = runtime.ensure_connected().await.err().unwrap();
    assert!(error
        .to_string()
        .contains("OAuth authorization failed for server 'demo'"));
    assert!(error.to_string().contains("persisted OAuth auth failure"));
}

#[tokio::test(flavor = "current_thread")]
async fn streamable_http_initialize_challenge_discovers_oauth_after_get_probe_405() {
    let _lock = crate::test_env_lock();
    let temp_root =
        std::env::temp_dir().join(format!("mcp-orc-runtime-oauth-{}", unique_test_suffix()));
    std::fs::create_dir_all(&temp_root).unwrap();
    let _env = EnvGuard::set(&[
        ("MCPO_TOKEN_STORAGE_DIR", temp_root.display().to_string()),
        ("MCPO_OAUTH_CALLBACK_PORT", "3834".to_string()),
    ]);

    let initialize_hits = Arc::new(AtomicUsize::new(0));
    let router = Router::new()
        .route(
            "/mcp",
            get(|| async { (StatusCode::METHOD_NOT_ALLOWED, "method not allowed") })
                .post(streamable_http_initialize_requires_oauth),
        )
        .route(
            "/.well-known/oauth-protected-resource",
            get(runtime_oauth_protected_resource_metadata),
        )
        .route(
            "/.well-known/oauth-authorization-server",
            get(runtime_oauth_authorization_metadata),
        )
        .route(
            "/authorize",
            get(|| async { (StatusCode::OK, "authorize") }),
        )
        .route("/register", post(runtime_oauth_register_client))
        .route(
            "/token",
            post(|| async { Json(json!({"access_token": "unused"})) }),
        )
        .with_state(RuntimeOAuthChallengeState {
            initialize_hits: initialize_hits.clone(),
        });
    let server = TestServer::spawn(router).await;
    let server_id = "runtime-post-oauth";
    let coordinator = Arc::new(OAuthCoordinator::new());
    let runtime = ServerRuntime::new(
        server_id.to_string(),
        ServerConfig {
            server_type: Some("streamable-http".to_string()),
            url: Some(format!("{}/mcp", server.base_url)),
            command: None,
            oauth: None,
            ..base_config()
        },
        coordinator.clone(),
    )
    .await
    .unwrap();

    let error = runtime.ensure_connected().await.err().unwrap();

    assert!(error
        .to_string()
        .contains("OAuth authorization required for server 'runtime-post-oauth'"));
    assert!(initialize_hits.load(Ordering::SeqCst) >= 1);
    assert!(runtime.oauth_runtime().await.is_some());

    let handshake = coordinator.get_handshake(server_id).await.unwrap();
    assert_eq!(handshake.state, OAuthState::Active);
    let authorization_url = handshake.authorization_url.as_deref().unwrap();
    assert!(authorization_url.starts_with(&format!("{}/authorize?", server.base_url)));
    let parsed = reqwest::Url::parse(authorization_url).unwrap();
    let requested_scope = parsed
        .query_pairs()
        .find_map(|(key, value)| (key == "scope").then(|| value.into_owned()))
        .unwrap();
    assert_eq!(
        requested_scope,
        "workforce.trust_and_safety.read offline_access"
    );
    let requested_resource = parsed
        .query_pairs()
        .find_map(|(key, value)| (key == "resource").then(|| value.into_owned()))
        .unwrap();
    assert_eq!(requested_resource, server.base_url);
    assert!(!requested_resource.ends_with('/'));

    let state = runtime.state.read().await;
    assert!(state.session.is_none());
    assert!(state
        .error
        .as_deref()
        .unwrap_or_default()
        .contains("OAuth authorization required"));
}

#[tokio::test(flavor = "current_thread")]
async fn oauth_refresh_handler_covers_authorization_url_and_refresh_success() {
    let _lock = crate::test_env_lock();
    let temp_root = std::env::temp_dir().join(format!("mcp-orc-app-oauth-{}", std::process::id()));
    std::fs::create_dir_all(&temp_root).unwrap();
    let _env = EnvGuard::set(&[
        ("MCPO_TOKEN_STORAGE_DIR", temp_root.display().to_string()),
        ("MCPO_OAUTH_CALLBACK_PORT", "3834".to_string()),
    ]);

    let token_server = TestServer::token_server(json!({
        "access_token": "fresh-token",
        "token_type": "Bearer",
        "expires_in": 3600
    }))
    .await;
    let coordinator = Arc::new(OAuthCoordinator::new());

    let auth_config = ServerConfig {
        server_type: Some("streamable-http".to_string()),
        url: Some(format!("{}/mcp", token_server.base_url)),
        oauth: Some(oauth_config(&token_server.base_url)),
        command: None,
        ..base_config()
    };
    let auth_binding = OAuthBinding::new("auth", &auth_config, coordinator.clone())
        .await
        .unwrap();
    let response = handle_oauth_refresh(
        State(app_state(
            "auth",
            runtime_with_state(
                "auth",
                auth_config.clone(),
                None,
                BTreeMap::new(),
                Some(auth_binding),
                None,
            ),
            coordinator.clone(),
        )),
        Path("auth".to_string()),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response_json(response).await["status"], "active");

    let store = CompatTokenStore::new("refresh").unwrap();
    store
        .save_client_info(&CompatClientInfo {
            client_id: "client".to_string(),
            client_secret: Some("secret".to_string()),
            token_endpoint_auth_method: Some("client_secret_post".to_string()),
            ..Default::default()
        })
        .unwrap();
    store
        .save_token_file(&CompatTokenFile {
            access_token: "old".to_string(),
            token_type: Some("Bearer".to_string()),
            expires_in: Some(-1),
            refresh_token: Some("refresh-token".to_string()),
            scope: None,
            extra: Default::default(),
        })
        .unwrap();

    let refresh_config = ServerConfig {
        server_type: Some("streamable-http".to_string()),
        url: Some(format!("{}/mcp", token_server.base_url)),
        oauth: Some(oauth_config(&token_server.base_url)),
        command: None,
        ..base_config()
    };
    let refresh_binding = OAuthBinding::new("refresh", &refresh_config, coordinator.clone())
        .await
        .unwrap();
    let response = handle_oauth_refresh(
        State(app_state(
            "refresh",
            runtime_with_state(
                "refresh",
                refresh_config,
                None,
                BTreeMap::new(),
                Some(refresh_binding),
                None,
            ),
            coordinator,
        )),
        Path("refresh".to_string()),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response_json(response).await["status"], "checking");
}

#[tokio::test(flavor = "current_thread")]
async fn oauth_callback_handler_covers_error_and_success_branches() {
    let _lock = crate::test_env_lock();
    let temp_root =
        std::env::temp_dir().join(format!("mcp-orc-app-callback-{}", std::process::id()));
    std::fs::create_dir_all(&temp_root).unwrap();
    let _env = EnvGuard::set(&[
        ("MCPO_TOKEN_STORAGE_DIR", temp_root.display().to_string()),
        ("MCPO_OAUTH_CALLBACK_PORT", "3834".to_string()),
    ]);

    let token_server = TestServer::token_server(json!({
        "access_token": "callback-token",
        "token_type": "Bearer",
        "expires_in": 3600,
        "refresh_token": "callback-refresh"
    }))
    .await;
    let coordinator = Arc::new(OAuthCoordinator::new());

    let response = handle_oauth_callback(
        State(AppState::new(BTreeMap::new(), coordinator.clone())),
        Query(OAuthCallbackQuery::default()),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(response_text(response)
        .await
        .contains("Authorization Failed"));

    let response = handle_oauth_callback(
        State(AppState::new(BTreeMap::new(), coordinator.clone())),
        Query(OAuthCallbackQuery {
            state: Some("missing".to_string()),
            ..Default::default()
        }),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert!(response_text(response)
        .await
        .contains("Authorization Failed"));

    coordinator.register_handshake("glean").await;
    let response = handle_oauth_callback(
        State(AppState::new(BTreeMap::new(), coordinator.clone())),
        Query(OAuthCallbackQuery {
            server_name: Some("glean".to_string()),
            error: Some("access_denied".to_string()),
            error_description: Some("nope".to_string()),
            ..Default::default()
        }),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(response_text(response)
        .await
        .contains("Authorization Failed"));

    let non_oauth = runtime_with_state("glean", base_config(), None, BTreeMap::new(), None, None);
    let response = handle_oauth_callback(
        State(app_state("glean", non_oauth, coordinator.clone())),
        Query(OAuthCallbackQuery {
            server_name: Some("glean".to_string()),
            state: Some("state".to_string()),
            code: Some("code".to_string()),
            ..Default::default()
        }),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(response_text(response)
        .await
        .contains("Authorization Failed"));

    let config = ServerConfig {
        server_type: Some("streamable-http".to_string()),
        url: Some(format!("{}/mcp", token_server.base_url)),
        oauth: Some(oauth_config(&token_server.base_url)),
        command: None,
        ..base_config()
    };
    let oauth = OAuthBinding::new("glean", &config, coordinator.clone())
        .await
        .unwrap();
    let authorization_url = oauth.ensure_authorization_url(true).await.unwrap();
    let state_param = authorization_url
        .split("state=")
        .nth(1)
        .unwrap()
        .split('&')
        .next()
        .unwrap()
        .to_string();

    let response = handle_oauth_callback(
        State(AppState::new(BTreeMap::new(), coordinator.clone())),
        Query(OAuthCallbackQuery {
            server_name: Some("missing".to_string()),
            state: Some(state_param.clone()),
            code: Some("code".to_string()),
            ..Default::default()
        }),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert!(response_text(response)
        .await
        .contains("Authorization Failed"));

    let response = handle_oauth_callback(
        State(app_state(
            "glean",
            runtime_with_state(
                "glean",
                config.clone(),
                None,
                BTreeMap::new(),
                Some(oauth.clone()),
                None,
            ),
            coordinator.clone(),
        )),
        Query(OAuthCallbackQuery {
            server_name: Some("glean".to_string()),
            state: Some(state_param.clone()),
            ..Default::default()
        }),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(response_text(response)
        .await
        .contains("Authorization Failed"));

    let response = handle_oauth_callback(
        State(app_state(
            "glean",
            runtime_with_state(
                "glean",
                config.clone(),
                None,
                BTreeMap::new(),
                Some(oauth),
                None,
            ),
            coordinator.clone(),
        )),
        Query(OAuthCallbackQuery {
            server_name: Some("glean".to_string()),
            code: Some("code".to_string()),
            ..Default::default()
        }),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_text(response).await;
    assert!(body.contains("Authorization Successful!"));
    assert!(body.contains("OAuth authorization completed"));
    assert!(body.contains("Portico"));
    assert!(body.contains("Portico Sans"));
    assert!(!body.contains("Urbanist"));

    let live_oauth = OAuthBinding::new("live", &config, coordinator.clone())
        .await
        .unwrap();
    let authorization_url = live_oauth.ensure_authorization_url(true).await.unwrap();
    let state_param = authorization_url
        .split("state=")
        .nth(1)
        .unwrap()
        .split('&')
        .next()
        .unwrap()
        .to_string();
    let live_session = Arc::new(MockSession::new(Ok(CallToolResult::success(vec![]))));
    let response = handle_oauth_callback(
        State(app_state(
            "live",
            runtime_with_state(
                "live",
                config,
                Some(live_session),
                BTreeMap::new(),
                Some(live_oauth),
                None,
            ),
            coordinator,
        )),
        Query(OAuthCallbackQuery {
            server_name: Some("live".to_string()),
            state: Some(state_param),
            code: Some("code".to_string()),
            ..Default::default()
        }),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_text(response).await;
    assert!(body.contains("Authorization Successful!"));
    assert!(body.contains("OAuth authorization completed"));
    assert!(body.contains("Switch back to the app. This browser step is already complete."));
    assert!(body.contains("Portico Sans"));
    assert!(!body.contains("Urbanist"));
    assert!(!body.contains("Next Step"));
    assert!(!body.contains("Please return to Portico"));

    let post_coordinator = Arc::new(OAuthCoordinator::new());
    post_coordinator.register_handshake("glean").await;
    let response = handle_oauth_callback_post(
        State(AppState::new(BTreeMap::new(), post_coordinator)),
        HeaderMap::new(),
        Query(OAuthCallbackQuery {
            server_name: Some("glean".to_string()),
            error: Some("access_denied".to_string()),
            error_description: Some("nope".to_string()),
            ..Default::default()
        }),
        Bytes::new(),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        response_json(response).await["message"],
        "OAuth callback returned access_denied: nope"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn oauth_callback_returns_success_before_transport_validation_finishes() {
    let _lock = crate::test_env_lock();
    let temp_root = std::env::temp_dir().join(format!(
        "mcp-orc-callback-validation-{}",
        unique_test_suffix()
    ));
    std::fs::create_dir_all(&temp_root).unwrap();
    let _env = EnvGuard::set(&[
        ("MCPO_TOKEN_STORAGE_DIR", temp_root.display().to_string()),
        ("MCPO_OAUTH_CALLBACK_PORT", "3834".to_string()),
    ]);

    let validation_server = TestServer::spawn(
        Router::new()
            .route(
                "/authorize",
                get(|| async { (StatusCode::OK, "authorize") }),
            )
            .route(
                "/token",
                post(|| async {
                    (
                        StatusCode::OK,
                        Json(json!({
                            "access_token": "callback-token",
                            "token_type": "Bearer",
                            "expires_in": 3600,
                            "refresh_token": "callback-refresh"
                        })),
                    )
                }),
            )
            .route(
                "/mcp",
                post(|| async {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    (StatusCode::SERVICE_UNAVAILABLE, "still validating")
                }),
            ),
    )
    .await;
    let coordinator = Arc::new(OAuthCoordinator::new());
    let config = ServerConfig {
        server_type: Some("streamable-http".to_string()),
        url: Some(format!("{}/mcp", validation_server.base_url)),
        oauth: Some(oauth_config(&validation_server.base_url)),
        command: None,
        ..base_config()
    };
    let oauth = OAuthBinding::new("slow", &config, coordinator.clone())
        .await
        .unwrap();
    let authorization_url = oauth.ensure_authorization_url(true).await.unwrap();
    let state_param = reqwest::Url::parse(&authorization_url)
        .unwrap()
        .query_pairs()
        .find_map(|(key, value)| (key == "state").then(|| value.into_owned()))
        .unwrap();

    let response = tokio::time::timeout(
        Duration::from_secs(1),
        handle_oauth_callback(
            State(app_state(
                "slow",
                runtime_with_state("slow", config, None, BTreeMap::new(), Some(oauth), None),
                coordinator.clone(),
            )),
            Query(OAuthCallbackQuery {
                server_name: Some("slow".to_string()),
                state: Some(state_param),
                code: Some("code".to_string()),
                ..Default::default()
            }),
        ),
    )
    .await
    .expect("callback response should not wait for MCP validation")
    .into_response();

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_text(response).await;
    assert!(body.contains("Authorization Successful!"));
    assert!(body.contains("OAuth authorization completed"));
    assert_eq!(
        coordinator.get_handshake("slow").await.unwrap().state,
        OAuthState::Checking
    );
}

#[tokio::test(flavor = "current_thread")]
async fn oauth_callback_completes_only_after_transport_and_tool_discovery_succeed() {
    let _lock = crate::test_env_lock();
    let temp_root = std::env::temp_dir().join(format!(
        "mcp-orc-callback-complete-{}",
        unique_test_suffix()
    ));
    std::fs::create_dir_all(&temp_root).unwrap();
    let _env = EnvGuard::set(&[
        ("MCPO_TOKEN_STORAGE_DIR", temp_root.display().to_string()),
        ("MCPO_OAUTH_CALLBACK_PORT", "3834".to_string()),
    ]);

    let token_server = TestServer::token_server(json!({
        "access_token": "callback-token",
        "token_type": "Bearer",
        "expires_in": 3600,
        "refresh_token": "callback-refresh"
    }))
    .await;
    let mcp_server = TestMcpServerHandle::spawn().await.unwrap();
    let coordinator = Arc::new(OAuthCoordinator::new());
    let config = ServerConfig {
        server_type: Some("streamable-http".to_string()),
        url: Some(mcp_server.url.clone()),
        oauth: Some(oauth_config(&token_server.base_url)),
        command: None,
        ..base_config()
    };
    let oauth = OAuthBinding::new("validated", &config, coordinator.clone())
        .await
        .unwrap();
    let authorization_url = oauth.ensure_authorization_url(true).await.unwrap();
    let state_param = reqwest::Url::parse(&authorization_url)
        .unwrap()
        .query_pairs()
        .find_map(|(key, value)| (key == "state").then(|| value.into_owned()))
        .unwrap();

    let response = handle_oauth_callback(
        State(app_state(
            "validated",
            runtime_with_state(
                "validated",
                config,
                None,
                BTreeMap::new(),
                Some(oauth),
                None,
            ),
            coordinator.clone(),
        )),
        Query(OAuthCallbackQuery {
            server_name: Some("validated".to_string()),
            state: Some(state_param),
            code: Some("code".to_string()),
            ..Default::default()
        }),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::OK);

    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if coordinator
                .get_handshake("validated")
                .await
                .is_some_and(|handshake| handshake.state == OAuthState::Completed)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("OAuth validation should complete after tool discovery");
}

#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
async fn serve_shuts_down_after_sigterm() {
    let task = tokio::spawn(async {
        serve(
            McpConfig {
                mcp_servers: BTreeMap::new(),
            },
            "127.0.0.1",
            0,
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    let status = tokio::process::Command::new("kill")
        .arg("-TERM")
        .arg(std::process::id().to_string())
        .status()
        .await
        .unwrap();
    assert!(status.success());
    let result = tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap();
    assert!(result.is_ok());
}

#[test]
fn build_router_constructs() {
    let _router = build_router(AppState::new(
        BTreeMap::new(),
        Arc::new(OAuthCoordinator::new()),
    ));
}

#[test]
fn constant_time_eq_matches_only_identical_bytes() {
    assert!(constant_time_eq(b"super-secret", b"super-secret"));
    assert!(!constant_time_eq(b"super-secret", b"super-secreX"));
    assert!(!constant_time_eq(b"short", b"longer-value"));
    assert!(constant_time_eq(b"", b""));
}

#[test]
fn normalize_bootstrap_token_expiry_adds_absolute_expiry_from_expires_in() {
    let token = CompatTokenFile {
        access_token: "abc".to_string(),
        token_type: Some("Bearer".to_string()),
        expires_in: Some(3600),
        refresh_token: Some("refresh".to_string()),
        scope: Some("read".to_string()),
        extra: BTreeMap::new(),
    };
    let before = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let value = normalize_bootstrap_token_expiry(token).unwrap();
    let expires_at = value
        .get("expires_at")
        .and_then(|v| v.as_i64())
        .expect("expires_at should be populated");
    assert!(expires_at >= before + 3600);
    // Refresh token and scope must survive so the broker can refresh later.
    assert_eq!(
        value.get("refresh_token").and_then(|v| v.as_str()),
        Some("refresh")
    );
    assert_eq!(value.get("scope").and_then(|v| v.as_str()), Some("read"));
}

#[test]
fn normalize_bootstrap_token_expiry_preserves_existing_absolute_expiry() {
    let mut extra = BTreeMap::new();
    extra.insert("expires_at".to_string(), json!(1_000_000_000_i64));
    let token = CompatTokenFile {
        access_token: "abc".to_string(),
        token_type: Some("Bearer".to_string()),
        expires_in: Some(3600),
        refresh_token: None,
        scope: None,
        extra,
    };
    let value = normalize_bootstrap_token_expiry(token).unwrap();
    assert_eq!(
        value.get("expires_at").and_then(|v| v.as_i64()),
        Some(1_000_000_000)
    );
}

#[test]
fn normalize_bootstrap_token_expiry_skips_when_no_expiry_info() {
    let token = CompatTokenFile {
        access_token: "abc".to_string(),
        token_type: Some("Bearer".to_string()),
        expires_in: None,
        refresh_token: None,
        scope: None,
        extra: BTreeMap::new(),
    };
    let value = normalize_bootstrap_token_expiry(token).unwrap();
    assert!(value.get("expires_at").is_none());
}
