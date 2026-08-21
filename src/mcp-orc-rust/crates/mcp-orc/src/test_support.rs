use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::{routing::get, routing::post, Json, Router};
use rmcp::handler::server::{router::tool::ToolRouter, wrapper::Parameters};
use rmcp::model::{Implementation, ServerCapabilities, ServerInfo};
use rmcp::schemars;
use rmcp::schemars::JsonSchema;
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, tower::StreamableHttpService,
};
use rmcp::transport::StreamableHttpServerConfig;
use rmcp::{tool, tool_handler, tool_router, Json as McpJson, ServerHandler};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex};

#[derive(Debug, Deserialize, Serialize, Clone, JsonSchema)]
pub struct EchoRequest {
    pub value: String,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq, JsonSchema)]
pub struct EchoResponse {
    pub echoed: String,
}

#[derive(Debug, Clone)]
pub struct EchoServer {
    tool_router: ToolRouter<Self>,
}

impl Default for EchoServer {
    fn default() -> Self {
        Self::new()
    }
}

impl EchoServer {
    pub fn new() -> Self {
        Self {
            tool_router: Self::tool_router(),
        }
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for EchoServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("echo-test-server", "1.0.0"))
    }
}

#[tool_router(router = tool_router)]
impl EchoServer {
    #[tool(name = "echo", description = "Echo a string value")]
    async fn echo(&self, params: Parameters<EchoRequest>) -> McpJson<EchoResponse> {
        McpJson(EchoResponse {
            echoed: params.0.value,
        })
    }
}

pub struct TestMcpServerHandle {
    pub url: String,
    shutdown: Option<oneshot::Sender<()>>,
    join: Option<tokio::task::JoinHandle<()>>,
}

impl TestMcpServerHandle {
    pub async fn spawn() -> anyhow::Result<Self> {
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
        let router = Router::new().nest_service("/mcp", service);
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let join = tokio::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        Ok(Self {
            url: format!("http://{addr}/mcp"),
            shutdown: Some(shutdown_tx),
            join: Some(join),
        })
    }

    pub async fn shutdown(mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(join) = self.join.take() {
            let _ = join.await;
        }
    }
}

impl Drop for TestMcpServerHandle {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(join) = self.join.take() {
            join.abort();
        }
    }
}

#[derive(Debug, Clone)]
pub struct CapturedOAuthRequest {
    pub path: String,
    pub authorization: Option<String>,
    pub body: String,
}

#[derive(Debug, Clone)]
pub struct QueuedOAuthResponse {
    pub status: StatusCode,
    pub body: Value,
}

#[derive(Debug, Default)]
struct OAuthServerState {
    registration_response: Option<QueuedOAuthResponse>,
    token_responses: VecDeque<QueuedOAuthResponse>,
    requests: Vec<CapturedOAuthRequest>,
}

#[derive(Clone)]
struct OAuthAppState {
    base_url: String,
    state: Arc<Mutex<OAuthServerState>>,
}

pub struct TestOAuthServerHandle {
    pub base_url: String,
    state: Arc<Mutex<OAuthServerState>>,
    shutdown: Option<oneshot::Sender<()>>,
    join: Option<tokio::task::JoinHandle<()>>,
}

impl TestOAuthServerHandle {
    pub async fn spawn() -> anyhow::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr: SocketAddr = listener.local_addr()?;
        let base_url = format!("http://{addr}");
        let state = Arc::new(Mutex::new(OAuthServerState::default()));
        let router = Router::new()
            .route(
                "/.well-known/oauth-authorization-server",
                get(oauth_metadata),
            )
            .route("/.well-known/openid-configuration", get(oauth_metadata))
            .route("/register", post(oauth_register))
            .route("/token", post(oauth_token))
            .route("/authorize", get(oauth_authorize))
            .with_state(OAuthAppState {
                base_url: base_url.clone(),
                state: state.clone(),
            });
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let join = tokio::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        Ok(Self {
            base_url,
            state,
            shutdown: Some(shutdown_tx),
            join: Some(join),
        })
    }

    pub async fn queue_token_response(&self, status: StatusCode, body: Value) {
        self.state
            .lock()
            .await
            .token_responses
            .push_back(QueuedOAuthResponse { status, body });
    }

    pub async fn set_registration_response(&self, status: StatusCode, body: Value) {
        self.state.lock().await.registration_response = Some(QueuedOAuthResponse { status, body });
    }

    pub async fn captured_requests(&self) -> Vec<CapturedOAuthRequest> {
        self.state.lock().await.requests.clone()
    }

    pub async fn shutdown(mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(join) = self.join.take() {
            let _ = join.await;
        }
    }
}

impl Drop for TestOAuthServerHandle {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(join) = self.join.take() {
            join.abort();
        }
    }
}

async fn oauth_authorize() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

async fn oauth_metadata(State(state): State<OAuthAppState>) -> Json<Value> {
    Json(json!({
        "authorization_endpoint": format!("{}/authorize", state.base_url),
        "token_endpoint": format!("{}/token", state.base_url),
        "registration_endpoint": format!("{}/register", state.base_url),
        "scopes_supported": ["openid", "offline_access"]
    }))
}

async fn oauth_register(
    State(state): State<OAuthAppState>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    record_oauth_request(&state, "/register", &headers, &body).await;
    let response = state
        .state
        .lock()
        .await
        .registration_response
        .clone()
        .unwrap_or(QueuedOAuthResponse {
            status: StatusCode::OK,
            body: json!({
                "client_id": "dcr-client",
                "redirect_uris": [format!("{}/callback", "http://localhost:3834")],
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "token_endpoint_auth_method": "none",
                "scope": "openid offline_access"
            }),
        });
    (response.status, Json(response.body))
}

async fn oauth_token(
    State(state): State<OAuthAppState>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    record_oauth_request(&state, "/token", &headers, &body).await;
    let response = state
        .state
        .lock()
        .await
        .token_responses
        .pop_front()
        .unwrap_or(QueuedOAuthResponse {
            status: StatusCode::OK,
            body: json!({
                "access_token": "fresh-access-token",
                "token_type": "Bearer",
                "expires_in": 3600,
                "refresh_token": "fresh-refresh-token",
                "scope": "openid offline_access"
            }),
        });
    (response.status, Json(response.body))
}

async fn record_oauth_request(state: &OAuthAppState, path: &str, headers: &HeaderMap, body: &[u8]) {
    state
        .state
        .lock()
        .await
        .requests
        .push(CapturedOAuthRequest {
            path: path.to_string(),
            authorization: headers
                .get(axum::http::header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string),
            body: String::from_utf8_lossy(body).into_owned(),
        });
}
