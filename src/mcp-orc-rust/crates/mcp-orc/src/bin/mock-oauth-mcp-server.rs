use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::extract::{Query, State};
use axum::http::header::{AUTHORIZATION, WWW_AUTHENTICATE};
use axum::http::{HeaderValue, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{any_service, get, post};
use axum::{Json, Router};
use chrono::Utc;
use log::info;
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};
use rmcp::{
    handler::server::router::tool::ToolRouter,
    model::{ServerCapabilities, ServerInfo},
    schemars, tool, tool_handler, tool_router, Json as McpJson, ServerHandler,
};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use url::Url;

#[derive(Debug, Clone)]
struct AppState {
    public_base_url: String,
    resource: String,
    challenge: String,
    valid_access_token: String,
    refresh_token: String,
    authorization_code: String,
}

impl AppState {
    fn new(public_base_url: String) -> Self {
        let resource = format!("{public_base_url}/mcp");
        let challenge = format!(
            r#"Bearer resource_metadata="{public_base_url}/.well-known/oauth-protected-resource", scope="mock.read""#
        );
        Self {
            public_base_url,
            resource,
            challenge,
            valid_access_token: "fresh-access-token".to_string(),
            refresh_token: "mock-refresh-token".to_string(),
            authorization_code: "mock-code".to_string(),
        }
    }

    fn auth_metadata(&self) -> serde_json::Value {
        serde_json::json!({
            "authorization_endpoint": format!("{}/authorize", self.public_base_url),
            "token_endpoint": format!("{}/token", self.public_base_url),
            "registration_endpoint": format!("{}/register", self.public_base_url),
            "scopes_supported": ["mock.read"],
            "response_types_supported": ["code"],
            "code_challenge_methods_supported": ["S256"]
        })
    }

    fn protected_resource_metadata(&self) -> serde_json::Value {
        serde_json::json!({
            "authorization_servers": [self.public_base_url],
            "resource": self.resource,
            "scopes_supported": ["mock.read"]
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
struct MockTimeResponse {
    mock_time: String,
    timezone: String,
    source: String,
}

#[derive(Debug, Clone)]
struct MockOAuthMcpServer {
    tool_router: ToolRouter<Self>,
}

impl MockOAuthMcpServer {
    fn new() -> Self {
        Self {
            tool_router: Self::tool_router(),
        }
    }
}

#[tool_router(router = tool_router)]
impl MockOAuthMcpServer {
    #[tool(
        name = "get_current_time",
        description = "Get the current mock UTC time"
    )]
    pub async fn get_current_time(&self) -> Result<McpJson<MockTimeResponse>, String> {
        Ok(McpJson(MockTimeResponse {
            mock_time: Utc::now().to_rfc3339(),
            timezone: "UTC".to_string(),
            source: "mock_oauth_mcp_server".to_string(),
        }))
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for MockOAuthMcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions("Mock OAuth-protected MCP server for Rust orchestrator e2e tests")
    }
}

#[derive(Debug, Deserialize)]
struct TokenRequest {
    grant_type: String,
    #[serde(default)]
    refresh_token: String,
    #[serde(default)]
    code: String,
    #[serde(default)]
    resource: String,
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({"ok": true}))
}

async fn authorize(
    State(state): State<Arc<AppState>>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let Some(redirect_uri) = query.get("redirect_uri") else {
        return (StatusCode::BAD_REQUEST, "redirect_uri is required").into_response();
    };
    let Some(state_param) = query.get("state") else {
        return (StatusCode::BAD_REQUEST, "state is required").into_response();
    };
    let Ok(mut redirect) = Url::parse(redirect_uri) else {
        return (StatusCode::BAD_REQUEST, "invalid redirect_uri").into_response();
    };
    redirect
        .query_pairs_mut()
        .append_pair("code", &state.authorization_code)
        .append_pair("state", state_param);
    info!("authorizing mock OAuth request and redirecting to {redirect}");
    Redirect::temporary(redirect.as_str()).into_response()
}

async fn register(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "client_id": "dynamic-mock-client",
        "redirect_uris": ["http://localhost:3834/callback"],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
        "scope": "mock.read",
        "client_name": "Mock OAuth MCP Test Client",
        "resource": state.resource
    }))
}

async fn token(
    State(state): State<Arc<AppState>>,
    axum::extract::Form(form): axum::extract::Form<TokenRequest>,
) -> Response {
    info!(
        "mock token endpoint request grant_type={} resource={}",
        form.grant_type, form.resource
    );

    let resource_ok = form.resource.is_empty() || form.resource == state.resource;
    if !resource_ok {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "invalid_target",
                "error_description": "resource did not match protected resource"
            })),
        )
            .into_response();
    }

    match form.grant_type.as_str() {
        "refresh_token" if form.refresh_token == state.refresh_token => Json(serde_json::json!({
            "access_token": state.valid_access_token,
            "token_type": "Bearer",
            "expires_in": 3600,
            "refresh_token": state.refresh_token,
            "scope": "mock.read"
        }))
        .into_response(),
        "authorization_code" if form.code == state.authorization_code => Json(serde_json::json!({
            "access_token": state.valid_access_token,
            "token_type": "Bearer",
            "expires_in": 3600,
            "refresh_token": state.refresh_token,
            "scope": "mock.read"
        }))
        .into_response(),
        "refresh_token" => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "invalid_grant",
                "error_description": "unknown refresh token"
            })),
        )
            .into_response(),
        "authorization_code" => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "invalid_grant",
                "error_description": "unknown authorization code"
            })),
        )
            .into_response(),
        _ => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "unsupported_grant_type"
            })),
        )
            .into_response(),
    }
}

async fn require_auth(
    State(state): State<Arc<AppState>>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let authorized = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|token| token.trim() == state.valid_access_token);

    if authorized {
        return next.run(request).await;
    }

    (
        StatusCode::UNAUTHORIZED,
        [(
            WWW_AUTHENTICATE,
            HeaderValue::from_str(&state.challenge)
                .unwrap_or_else(|_| HeaderValue::from_static("Bearer")),
        )],
        "OAuth authorization required",
    )
        .into_response()
}

#[tokio::main]
async fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let bind_host =
        std::env::var("MOCK_OAUTH_MCP_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("MOCK_OAUTH_MCP_PORT")
        .ok()
        .and_then(|raw| raw.parse::<u16>().ok())
        .unwrap_or(8791);
    let public_base_url = std::env::var("MOCK_OAUTH_MCP_PUBLIC_BASE_URL")
        .unwrap_or_else(|_| format!("http://127.0.0.1:{port}"));
    let state = Arc::new(AppState::new(public_base_url));

    let cancellation_token = CancellationToken::new();
    let mcp_service = StreamableHttpService::new(
        || Ok(MockOAuthMcpServer::new()),
        Arc::new(LocalSessionManager::default()),
        StreamableHttpServerConfig {
            stateful_mode: true,
            cancellation_token: cancellation_token.child_token(),
            ..Default::default()
        },
    );

    let mcp_router = Router::new()
        .route("/", any_service(mcp_service))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_auth));

    let app = Router::new()
        .route("/health", get(health))
        .route("/authorize", get(authorize))
        .route("/register", post(register))
        .route("/token", post(token))
        .route(
            "/.well-known/oauth-protected-resource",
            get({
                let state = state.clone();
                move || {
                    let state = state.clone();
                    async move { Json(state.protected_resource_metadata()) }
                }
            }),
        )
        .route(
            "/.well-known/oauth-authorization-server",
            get({
                let state = state.clone();
                move || {
                    let state = state.clone();
                    async move { Json(state.auth_metadata()) }
                }
            }),
        )
        .nest("/mcp", mcp_router)
        .with_state(state.clone());

    let address: SocketAddr = format!("{bind_host}:{port}")
        .parse()
        .with_context(|| format!("invalid bind address {bind_host}:{port}"))?;

    info!(
        "starting mock OAuth MCP server on {} (public_base_url={})",
        address, state.public_base_url
    );

    let listener = tokio::net::TcpListener::bind(address)
        .await
        .with_context(|| format!("failed to bind {address}"))?;

    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = tokio::signal::ctrl_c().await;
            cancellation_token.cancel();
        })
        .await
        .context("mock OAuth MCP server exited unexpectedly")
}
