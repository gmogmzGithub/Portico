use super::{
    classic_sse_transport_with_client, join_endpoint_url, ClassicSseClientConfig,
    ClassicSseTransportError,
};
use crate::config::ServerConfig;
use crate::oauth::{
    CompatClientInfo, CompatTokenFile, CompatTokenStore, OAuthBinding, OAuthCoordinator,
};
use crate::session::connect_server;
use axum::extract::State;
use axum::http::{header::WWW_AUTHENTICATE, HeaderMap, HeaderValue, StatusCode};
use axum::response::sse::Event;
use axum::response::Sse;
use axum::{routing::get, routing::post, Json, Router};
use futures::{stream, StreamExt};
use rmcp::model::{
    CallToolRequestParams, CallToolResult, Implementation, JsonRpcMessage, ListToolsResult,
    RequestId, ServerCapabilities, ServerJsonRpcMessage, ServerResult, Tool,
};
use serde_json::{json, Map, Value};
use serial_test::serial;
use std::borrow::Cow;
use std::collections::BTreeMap;
use std::convert::Infallible;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::{broadcast, oneshot, Mutex};

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

#[derive(Clone)]
struct HarnessState {
    events: broadcast::Sender<String>,
    expected_auth: Option<String>,
    reject_tool_calls: Arc<AtomicBool>,
    drop_tool_call_responses: Arc<AtomicBool>,
    token_response: Option<Value>,
    last_authorization: Arc<Mutex<Vec<String>>>,
}

struct ClassicSseHarness {
    base_url: String,
    shutdown: Option<oneshot::Sender<()>>,
    state: HarnessState,
}

impl ClassicSseHarness {
    async fn spawn(
        expected_auth: Option<&str>,
        reject_tool_calls: bool,
        drop_tool_call_responses: bool,
        token_response: Option<Value>,
    ) -> Self {
        let (events, _) = broadcast::channel(32);
        let state = HarnessState {
            events,
            expected_auth: expected_auth.map(str::to_string),
            reject_tool_calls: Arc::new(AtomicBool::new(reject_tool_calls)),
            drop_tool_call_responses: Arc::new(AtomicBool::new(drop_tool_call_responses)),
            token_response,
            last_authorization: Arc::new(Mutex::new(Vec::new())),
        };
        let router = Router::new()
            .route("/sse", get(handle_sse))
            .route("/messages", post(handle_post_message))
            .route(
                "/authorize",
                get(|| async { (StatusCode::OK, "authorize") }),
            )
            .route("/token", post(handle_token))
            .with_state(state.clone());
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
            state,
        }
    }

    fn sse_url(&self) -> String {
        format!("{}/sse", self.base_url)
    }

    async fn authorizations(&self) -> Vec<String> {
        self.state.last_authorization.lock().await.clone()
    }
}

impl Drop for ClassicSseHarness {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

async fn handle_sse(
    State(state): State<HarnessState>,
    headers: HeaderMap,
) -> Result<
    Sse<impl futures::Stream<Item = Result<Event, Infallible>>>,
    (StatusCode, HeaderMap, &'static str),
> {
    record_authorization(&state, &headers).await;
    if !authorized(&state, &headers) {
        let mut response_headers = HeaderMap::new();
        response_headers.insert(WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
        return Err((StatusCode::UNAUTHORIZED, response_headers, "unauthorized"));
    }

    let initial = stream::once(async {
        Ok::<_, Infallible>(
            Event::default()
                .event("endpoint")
                .data("/messages?sessionId=test-session"),
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
    Ok(Sse::new(initial.chain(messages)))
}

async fn handle_post_message(
    State(state): State<HarnessState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> (StatusCode, HeaderMap, String) {
    record_authorization(&state, &headers).await;
    let mut response_headers = HeaderMap::new();
    response_headers.insert(WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
    if !authorized(&state, &headers) {
        return (
            StatusCode::UNAUTHORIZED,
            response_headers,
            "unauthorized".to_string(),
        );
    }

    let id = body
        .get("id")
        .cloned()
        .and_then(|value| serde_json::from_value::<RequestId>(value).ok())
        .unwrap_or(RequestId::Number(1));
    let method = body
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();

    if method == "tools/call" && state.reject_tool_calls.load(Ordering::SeqCst) {
        return (
            StatusCode::UNAUTHORIZED,
            response_headers,
            "tool unauthorized".to_string(),
        );
    }

    match method {
        "initialize" => {
            let _ = state.events.send(initialize_response(id));
        }
        "notifications/initialized" => {}
        "tools/list" => {
            let _ = state.events.send(list_tools_response(id));
        }
        "tools/call" => {
            if !state.drop_tool_call_responses.load(Ordering::SeqCst) {
                let _ = state.events.send(call_tool_response(id));
            }
        }
        _ => {
            let _ = state.events.send(error_response(id, "unknown method"));
        }
    }

    (StatusCode::ACCEPTED, HeaderMap::new(), String::new())
}

async fn handle_token(
    State(state): State<HarnessState>,
    headers: HeaderMap,
) -> (StatusCode, Json<Value>) {
    record_authorization(&state, &headers).await;
    (
        StatusCode::OK,
        Json(state.token_response.clone().unwrap_or_else(|| {
            json!({
                "access_token": "fresh-token",
                "refresh_token": "fresh-refresh",
                "token_type": "Bearer",
                "expires_in": 3600
            })
        })),
    )
}

async fn record_authorization(state: &HarnessState, headers: &HeaderMap) {
    if let Some(value) = headers.get(reqwest::header::AUTHORIZATION) {
        if let Ok(value) = value.to_str() {
            state
                .last_authorization
                .lock()
                .await
                .push(value.to_string());
        }
    }
}

fn authorized(state: &HarnessState, headers: &HeaderMap) -> bool {
    let Some(expected_auth) = state.expected_auth.as_ref() else {
        return true;
    };
    headers
        .get(reqwest::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .map(|value| value == format!("Bearer {expected_auth}"))
        .unwrap_or(false)
}

fn initialize_response(id: RequestId) -> String {
    serde_json::to_string(&ServerJsonRpcMessage::response(
        ServerResult::InitializeResult(
            rmcp::model::InitializeResult::new(ServerCapabilities::default())
                .with_server_info(Implementation::new("classic-sse-demo", "1.0.0")),
        ),
        id,
    ))
    .unwrap()
}

fn list_tools_response(id: RequestId) -> String {
    let mut tool = Tool::default();
    tool.name = Cow::Borrowed("echo");
    tool.description = Some(Cow::Borrowed("demo tool"));
    tool.input_schema = Arc::new(Map::new());
    serde_json::to_string(&ServerJsonRpcMessage::response(
        ServerResult::ListToolsResult(ListToolsResult {
            tools: vec![tool],
            ..Default::default()
        }),
        id,
    ))
    .unwrap()
}

fn call_tool_response(id: RequestId) -> String {
    serde_json::to_string(&ServerJsonRpcMessage::response(
        ServerResult::CallToolResult(CallToolResult::structured(json!({"ok": true}))),
        id,
    ))
    .unwrap()
}

fn error_response(id: RequestId, message: &str) -> String {
    serde_json::to_string(&JsonRpcMessage::<Value, Value, Value>::error(
        rmcp::model::ErrorData::internal_error(message.to_string(), None),
        id,
    ))
    .unwrap()
}

fn sse_config(url: String) -> ServerConfig {
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

#[test]
fn endpoint_join_rejects_cross_origin_control_events() {
    let error = join_endpoint_url("https://example.test/sse", "https://attacker.test/messages")
        .unwrap_err();
    assert!(matches!(
        error,
        ClassicSseTransportError::EndpointOriginMismatch(_)
    ));
}

#[tokio::test]
async fn native_classic_sse_transport_connects_lists_tools_and_calls_tool() {
    let harness = ClassicSseHarness::spawn(None, false, false, None).await;
    let config = sse_config(harness.sse_url());

    let session = connect_server("demo", &config, None).await.unwrap();
    let tools = session.list_tools().await.unwrap();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].name.as_ref(), "echo");

    let result = session
        .call_tool(CallToolRequestParams::new("echo"))
        .await
        .unwrap();
    assert_eq!(result.structured_content, Some(json!({"ok": true})));
    session.close().await.unwrap();

    let authorizations = harness.authorizations().await;
    assert!(authorizations.is_empty());
}

#[tokio::test]
async fn native_classic_sse_transport_closes_after_post_401() {
    let harness = ClassicSseHarness::spawn(None, true, false, None).await;
    let config = sse_config(harness.sse_url());
    let session = connect_server("demo", &config, None).await.unwrap();
    let error = session
        .call_tool(CallToolRequestParams::new("echo"))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("tool call failed"));

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(session.is_closed());
}

#[tokio::test]
#[serial]
async fn native_classic_sse_oauth_reuses_stored_tokens_via_refresh_without_reconsent() {
    let _lock = crate::test_env_lock();
    let harness = ClassicSseHarness::spawn(
        Some("fresh-token"),
        false,
        false,
        Some(json!({
            "access_token": "fresh-token",
            "refresh_token": "fresh-refresh",
            "token_type": "Bearer",
            "expires_in": 3600
        })),
    )
    .await;
    let token_root = tempfile::tempdir().unwrap();
    let _env = EnvGuard::set(&[(
        "MCPO_TOKEN_STORAGE_DIR",
        token_root.path().display().to_string(),
    )]);

    let mut config = sse_config(harness.sse_url());
    config.oauth = Some(json!({
        "authorization_endpoint": format!("{}/authorize", harness.base_url),
        "token_endpoint": format!("{}/token", harness.base_url),
        "credentials_source": {
            "type": "inline",
            "client_id": "client",
            "client_secret": "secret"
        }
    }));

    let store = CompatTokenStore::new("demo").unwrap();
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
            expires_in: Some(3600),
            scope: None,
            extra: Default::default(),
        })
        .unwrap();

    let oauth = OAuthBinding::new("demo", &config, Arc::new(OAuthCoordinator::new()))
        .await
        .unwrap();
    let session = connect_server("demo", &config, Some(oauth)).await.unwrap();
    let tools = session.list_tools().await.unwrap();
    assert_eq!(tools.len(), 1);

    let saved_tokens = store.load_token_file().unwrap().unwrap();
    assert_eq!(saved_tokens.access_token, "fresh-token");

    let authorizations = harness.authorizations().await;
    assert!(authorizations
        .iter()
        .any(|value| value == "Bearer stale-token"));
    assert!(authorizations
        .iter()
        .any(|value| value == "Bearer fresh-token"));
    session.close().await.unwrap();
}

#[tokio::test]
async fn native_classic_sse_transport_waits_forever_without_response_event() {
    let harness = ClassicSseHarness::spawn(None, false, true, None).await;
    let config = sse_config(harness.sse_url());

    let session = connect_server("demo", &config, None).await.unwrap();
    let timeout = tokio::time::timeout(
        std::time::Duration::from_millis(150),
        session.call_tool(CallToolRequestParams::new("echo")),
    )
    .await;

    assert!(timeout.is_err());
    session.close().await.unwrap();
}

#[tokio::test]
async fn classic_sse_transport_builder_applies_auth_header() {
    let transport = classic_sse_transport_with_client(
        reqwest::Client::new(),
        ClassicSseClientConfig::with_uri("http://localhost:8000/sse").auth_header("demo-token"),
    );
    drop(transport);
}
