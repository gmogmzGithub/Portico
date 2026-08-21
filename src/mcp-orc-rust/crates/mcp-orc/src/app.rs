use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fmt;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use anyhow::{anyhow, Context, Result};
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{header::CONTENT_TYPE, header::RETRY_AFTER, HeaderMap, HeaderValue, StatusCode};
use axum::response::{Html, IntoResponse};
use axum::{routing::get, routing::post, Json, Router};
use log::{info, warn};
use rand::Rng;
use rmcp::model::{CallToolRequestParams, Tool};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use tokio::net::TcpListener;
use tokio::sync::{Mutex, Notify, RwLock};
use tower_http::cors::CorsLayer;

use crate::app_oauth_probe::{discovered_oauth_config, probe_server_for_oauth_discovery};
use crate::app_support::{
    forwarded_header_meta, normalize_tool_rename_mapping, sanitize_tool_name, server_display_name,
    supports_native_oauth,
};
use crate::app_tool_oauth::{
    extract_authorization_url, is_probable_oauth_error_text, status_from_tool_error,
    strip_authorization_url, trigger_restart_hook,
};
use crate::config::{normalize_server_type, McpConfig, ServerConfig};
use crate::oauth::{
    discover_from_auth_challenge, OAuthBinding, OAuthBrokerSeedOutcome, OAuthCoordinator,
    OAuthRefreshOutcome, OAuthState,
};
use crate::openapi::{build_root_openapi, build_server_openapi, swagger_ui_html};
use crate::overflow::maybe_spill_large_tool_response;
use crate::response::{call_tool_response, extract_error_message_from_value, json_error};
use crate::session::{
    connect_server, streamable_http_auth_challenge_from_connect_error, McpSession,
    ProviderReadiness,
};

const OAUTH_CALLBACK_TEMPLATE: &str = include_str!("oauth_callback.html");
const CHAT_ID_HEADER: &str = "x-openwebui-chat-id";
const MESSAGE_ID_HEADER: &str = "x-openwebui-message-id";
const SESSION_ID_HEADER: &str = "x-openwebui-session-id";
const TOOL_CALL_ID_HEADER: &str = "x-openwebui-tool-call-id";
const OAUTH_STREAMABLE_HTTP_IDLE_RECONNECT_THRESHOLD: Duration = Duration::from_secs(300);
const RECOVERY_FAILURE_WINDOW: Duration = Duration::from_secs(300);
const RECOVERY_FAILURE_THRESHOLD: usize = 3;
const RECOVERY_RETRY_AFTER_SECONDS: u64 = 15;
const OAUTH_REFRESH_TIMEOUT: Duration = Duration::from_secs(10);
static TOOL_CALL_LOG_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FailureCategory {
    AuthRequired,
    Permission,
    Timeout,
    Transport,
    Validation,
    Cancellation,
    Conflict,
    RateLimited,
    Other,
}

impl FailureCategory {
    fn as_str(self) -> &'static str {
        match self {
            Self::AuthRequired => "authorization_required",
            Self::Permission => "permission_denied",
            Self::Timeout => "timeout",
            Self::Transport => "transport",
            Self::Validation => "validation",
            Self::Cancellation => "cancelled",
            Self::Conflict => "conflict",
            Self::RateLimited => "rate_limited",
            Self::Other => "tool_error",
        }
    }

    fn is_recovery_eligible(self) -> bool {
        matches!(self, Self::Timeout | Self::Transport)
    }

    fn status(self) -> StatusCode {
        match self {
            Self::AuthRequired => StatusCode::UNAUTHORIZED,
            Self::Permission => StatusCode::FORBIDDEN,
            Self::Timeout => StatusCode::GATEWAY_TIMEOUT,
            Self::Validation => StatusCode::UNPROCESSABLE_ENTITY,
            Self::Cancellation => StatusCode::from_u16(499).unwrap_or(StatusCode::BAD_REQUEST),
            Self::Conflict => StatusCode::CONFLICT,
            Self::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            Self::Transport => StatusCode::BAD_GATEWAY,
            Self::Other => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

fn classify_tool_failure(message: &str) -> FailureCategory {
    let normalized = message.to_ascii_lowercase();
    if is_probable_oauth_error_text(&normalized)
        || normalized.contains("authorization required")
        || normalized.contains("authorization_url=")
        || normalized.contains("status 401")
        || normalized.contains("http 401")
    {
        return FailureCategory::AuthRequired;
    }
    if normalized.contains("status 403")
        || normalized.contains("http 403")
        || normalized.contains("forbidden")
        || normalized.contains("permission denied")
    {
        return FailureCategory::Permission;
    }
    if normalized.contains("tool call exceeded configured timeout")
        || normalized.contains("status 408")
        || normalized.contains("http 408")
        || normalized.contains("request timeout")
        || normalized.contains("timed out")
    {
        return FailureCategory::Timeout;
    }
    if normalized.contains("status 429")
        || normalized.contains("http 429")
        || normalized.contains("too many requests")
    {
        return FailureCategory::RateLimited;
    }
    if normalized.contains("status 409") || normalized.contains("http 409") {
        return FailureCategory::Conflict;
    }
    if normalized.contains("status 422")
        || normalized.contains("http 422")
        || normalized.contains("status 400")
        || normalized.contains("http 400")
        || normalized.contains("validation")
        || normalized.contains("invalid input")
        || normalized.contains("invalid argument")
    {
        return FailureCategory::Validation;
    }
    if normalized.contains("cancelled") || normalized.contains("canceled") {
        return FailureCategory::Cancellation;
    }
    if [
        "status 502",
        "status 503",
        "status 504",
        "http 502",
        "http 503",
        "http 504",
        "connection reset",
        "connection closed",
        "connection aborted",
        "connection refused",
        "connection error",
        "broken pipe",
        "error sending request",
        "early eof",
        "not connected",
        "failed to connect",
        "transport error",
        "channel closed",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
    {
        return FailureCategory::Transport;
    }
    FailureCategory::Other
}

fn value_requires_interactive_authorization(value: &Value) -> bool {
    match value {
        Value::Object(object) => {
            object
                .get("authorization_url")
                .and_then(Value::as_str)
                .is_some_and(|url| !url.trim().is_empty())
                || object
                    .get("oauth_recovery_required")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                || object
                    .values()
                    .any(value_requires_interactive_authorization)
        }
        Value::Array(values) => values.iter().any(value_requires_interactive_authorization),
        Value::String(message) => message.contains("authorization_url="),
        _ => false,
    }
}

fn value_authorization_url(value: &Value) -> Option<String> {
    match value {
        Value::Object(object) => object
            .get("authorization_url")
            .and_then(Value::as_str)
            .filter(|url| !url.trim().is_empty())
            .map(ToOwned::to_owned)
            .or_else(|| object.values().find_map(value_authorization_url)),
        Value::Array(values) => values.iter().find_map(value_authorization_url),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RecoveryPhase {
    Healthy,
    RetryLeader,
    CircuitOpen,
    Reconnecting,
    RestartPending,
    AuthRequired,
}

impl RecoveryPhase {
    fn as_str(self) -> &'static str {
        match self {
            Self::Healthy => "healthy",
            Self::RetryLeader => "retrying",
            Self::CircuitOpen => "circuit_open_draining",
            Self::Reconnecting => "reconnecting",
            Self::RestartPending => "restart_pending",
            Self::AuthRequired => "auth_required",
        }
    }

    fn rejects_new_calls(self) -> bool {
        matches!(
            self,
            Self::CircuitOpen | Self::Reconnecting | Self::RestartPending | Self::AuthRequired
        )
    }
}

#[derive(Debug)]
struct FailureEvidence {
    call_id: String,
    occurred_at: Instant,
    category: FailureCategory,
}

#[derive(Debug)]
struct RecoveryControl {
    phase: RecoveryPhase,
    failures: VecDeque<FailureEvidence>,
    pending_failures: BTreeMap<String, FailureCategory>,
    last_failure_category: Option<FailureCategory>,
    unknown_policy_entries: Vec<String>,
    recovery_started: bool,
}

impl Default for RecoveryControl {
    fn default() -> Self {
        Self {
            phase: RecoveryPhase::Healthy,
            failures: VecDeque::new(),
            pending_failures: BTreeMap::new(),
            last_failure_category: None,
            unknown_policy_entries: Vec::new(),
            recovery_started: false,
        }
    }
}

struct RecoveryRuntime {
    control: Mutex<RecoveryControl>,
    in_flight: AtomicUsize,
    drained: Notify,
    now: fn() -> Instant,
    retry_delay: fn() -> Duration,
    #[cfg(test)]
    reconnect_outcome: Mutex<Option<std::result::Result<(), String>>>,
}

fn recovery_now() -> Instant {
    Instant::now()
}

fn retry_jitter_delay() -> Duration {
    Duration::from_millis(rand::thread_rng().gen_range(500..=2_000))
}

impl Default for RecoveryRuntime {
    fn default() -> Self {
        Self {
            control: Mutex::new(RecoveryControl::default()),
            in_flight: AtomicUsize::new(0),
            drained: Notify::new(),
            now: recovery_now,
            retry_delay: retry_jitter_delay,
            #[cfg(test)]
            reconnect_outcome: Mutex::new(None),
        }
    }
}

#[derive(Debug)]
struct ToolRuntimeError {
    message: String,
    category: FailureCategory,
    retry_attempted: bool,
    recovery_state: RecoveryPhase,
    retry_after_seconds: Option<u64>,
}

impl fmt::Display for ToolRuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ToolRuntimeError {}

struct InFlightGuard {
    server: Arc<ServerRuntime>,
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        if self
            .server
            .recovery
            .in_flight
            .fetch_sub(1, Ordering::SeqCst)
            == 1
        {
            self.server.recovery.drained.notify_waiters();
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ToolRoute {
    pub route_name: String,
    pub original_name: String,
    pub display_name: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub input_schema: Value,
    pub output_schema: Option<Value>,
}

#[derive(Clone)]
pub struct AppState {
    servers: BTreeMap<String, Arc<ServerRuntime>>,
    oauth_coordinator: Arc<OAuthCoordinator>,
}

impl AppState {
    fn new(
        servers: BTreeMap<String, Arc<ServerRuntime>>,
        oauth_coordinator: Arc<OAuthCoordinator>,
    ) -> Self {
        Self {
            servers,
            oauth_coordinator,
        }
    }

    fn server(&self, server_id: &str) -> Option<Arc<ServerRuntime>> {
        self.servers.get(server_id).cloned()
    }

    fn oauth_coordinator(&self) -> Arc<OAuthCoordinator> {
        self.oauth_coordinator.clone()
    }
}

struct ServerConnectionState {
    session: Option<Arc<dyn McpSession>>,
    tools: BTreeMap<String, ToolRoute>,
    openapi: Value,
    title: String,
    version: Option<String>,
    error: Option<String>,
    last_activity_at: Option<SystemTime>,
}

pub struct ServerRuntime {
    id: String,
    config: ServerConfig,
    oauth: RwLock<Option<Arc<OAuthBinding>>>,
    oauth_coordinator: Arc<OAuthCoordinator>,
    connect_lock: Mutex<()>,
    recovery: RecoveryRuntime,
    state: RwLock<ServerConnectionState>,
}

fn header_log_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

fn resolve_tool_call_log_id(server_id: &str, headers: &HeaderMap) -> String {
    header_log_value(headers, TOOL_CALL_ID_HEADER).unwrap_or_else(|| {
        format!(
            "{server_id}-{}",
            TOOL_CALL_LOG_COUNTER.fetch_add(1, Ordering::Relaxed)
        )
    })
}

impl ServerRuntime {
    async fn new(
        id: String,
        config: ServerConfig,
        oauth_coordinator: Arc<OAuthCoordinator>,
    ) -> Result<Arc<Self>> {
        let oauth = if config.oauth.is_some() && supports_native_oauth(&config) {
            Some(OAuthBinding::new(&id, &config, oauth_coordinator.clone()).await?)
        } else {
            None
        };
        Ok(Arc::new(Self {
            state: RwLock::new(ServerConnectionState {
                session: None,
                tools: BTreeMap::new(),
                openapi: build_server_openapi(&id, &id, None, &BTreeMap::new()),
                title: id.clone(),
                version: None,
                error: None,
                last_activity_at: None,
            }),
            id,
            config,
            oauth: RwLock::new(oauth),
            oauth_coordinator,
            connect_lock: Mutex::new(()),
            recovery: RecoveryRuntime::default(),
        }))
    }

    async fn ensure_connected(&self) -> Result<()> {
        {
            let state = self.state.read().await;
            if let Some(session) = state.session.as_ref() {
                if !session.is_closed() && state.error.is_none() {
                    return Ok(());
                }
            }
        }

        let _guard = self.connect_lock.lock().await;
        {
            let state = self.state.read().await;
            if let Some(session) = state.session.as_ref() {
                if !session.is_closed() && state.error.is_none() {
                    return Ok(());
                }
            }
        }

        match self.connect_fresh().await {
            Ok(()) => Ok(()),
            Err(error) => {
                let mut state = self.state.write().await;
                state.error = Some(error.to_string());
                Err(error)
            }
        }
    }

    async fn connect_fresh(&self) -> Result<()> {
        let mut oauth = self.ensure_oauth_runtime().await?;
        self.ensure_preconnect_oauth_ready(oauth.as_ref()).await?;
        let new_session = match connect_server(&self.id, &self.config, oauth.clone()).await {
            Ok(session) => session,
            Err(error) => {
                if oauth.is_some() {
                    return Err(error);
                }
                let Some(challenge) = streamable_http_auth_challenge_from_connect_error(&error)
                else {
                    return Err(error);
                };
                let Some(discovered_oauth) = self
                    .ensure_oauth_runtime_from_auth_challenge(&challenge)
                    .await?
                else {
                    return Err(error);
                };
                oauth = Some(discovered_oauth);
                self.ensure_preconnect_oauth_ready(oauth.as_ref()).await?;
                connect_server(&self.id, &self.config, oauth.clone()).await?
            }
        };
        let tools = new_session
            .list_tools()
            .await
            .with_context(|| format!("failed to list tools for '{}'", self.id))?;
        let tool_routes = build_tool_routes(&self.id, &self.config, &tools);
        self.update_unknown_policy_entries(&tool_routes).await;
        let peer_info = new_session.peer_info();
        let title = peer_info
            .as_ref()
            .map(server_display_name)
            .unwrap_or_else(|| self.id.clone());
        let version = peer_info
            .as_ref()
            .map(|info| info.server_info.version.clone());
        let openapi = build_server_openapi(&self.id, &title, version.as_deref(), &tool_routes);

        let previous_session = {
            let mut state = self.state.write().await;
            let previous = state.session.replace(new_session);
            state.tools = tool_routes;
            state.openapi = openapi;
            state.title = title;
            state.version = version;
            state.error = None;
            state.last_activity_at = Some(SystemTime::now());
            previous
        };

        if let Some(session) = previous_session {
            if let Err(error) = session.close().await {
                warn!(
                    "failed to close previous session for '{}': {error:#}",
                    self.id
                );
            }
        }

        if let Some(oauth) = oauth.as_ref() {
            if let Err(error) = oauth.finalize_post_connect_state().await {
                warn!(
                    "failed to finalize native OAuth post-connect state for '{}': {error:#}",
                    self.id
                );
            }
        }

        info!("Connected native MCP server '{}'", self.id);
        Ok(())
    }

    async fn update_unknown_policy_entries(&self, routes: &BTreeMap<String, ToolRoute>) {
        let known = routes
            .values()
            .map(|route| route.original_name.as_str())
            .collect::<BTreeSet<_>>();
        let unknown = self
            .config
            .retryable_tools()
            .into_iter()
            .filter(|configured| !known.contains(configured.as_str()))
            .collect::<Vec<_>>();
        if !unknown.is_empty() {
            warn!(
                "[{}] retry policy contains unknown original MCP tool names; entries remain non-retryable: {:?}",
                self.id, unknown
            );
        }
        self.recovery.control.lock().await.unknown_policy_entries = unknown;
    }

    fn uses_oauth_streamable_http(&self) -> bool {
        self.config.oauth.is_some()
            && normalize_server_type(self.config.server_type.as_deref()).as_deref()
                == Some("streamable-http")
    }

    async fn maybe_reconnect_idle_streamable_http_session(&self) -> Result<()> {
        if !self.uses_oauth_streamable_http() {
            return Ok(());
        }

        let stale_elapsed = {
            let state = self.state.read().await;
            let Some(session) = state.session.as_ref() else {
                return Ok(());
            };
            if session.is_closed() || state.error.is_some() {
                return Ok(());
            }
            state
                .last_activity_at
                .and_then(|last_activity_at| {
                    SystemTime::now().duration_since(last_activity_at).ok()
                })
                .filter(|elapsed| *elapsed >= OAUTH_STREAMABLE_HTTP_IDLE_RECONNECT_THRESHOLD)
        };

        let Some(stale_elapsed) = stale_elapsed else {
            return Ok(());
        };

        let _guard = self.connect_lock.lock().await;
        let previous_session = {
            let mut state = self.state.write().await;
            let Some(session) = state.session.as_ref() else {
                return Ok(());
            };
            let Some(last_activity_at) = state.last_activity_at else {
                return Ok(());
            };
            let Ok(elapsed) = SystemTime::now().duration_since(last_activity_at) else {
                return Ok(());
            };
            if session.is_closed()
                || state.error.is_some()
                || elapsed < OAUTH_STREAMABLE_HTTP_IDLE_RECONNECT_THRESHOLD
            {
                return Ok(());
            }
            info!(
                "[{}] proactively reconnecting stale OAuth streamable-http session after {:?} of inactivity",
                self.id, stale_elapsed
            );
            state.error = None;
            state.last_activity_at = None;
            state.session.take()
        };

        if let Some(session) = previous_session {
            if let Err(error) = session.close().await {
                warn!(
                    "[{}] failed to close stale MCP session before idle reconnect: {error:#}",
                    self.id
                );
            }
        }

        match self.connect_fresh().await {
            Ok(()) => Ok(()),
            Err(error) => {
                let mut state = self.state.write().await;
                state.error = Some(error.to_string());
                Err(error)
            }
        }
    }

    async fn ensure_oauth_runtime(&self) -> Result<Option<Arc<OAuthBinding>>> {
        if let Some(oauth) = self.oauth.read().await.clone() {
            return Ok(Some(oauth));
        }
        if self.config.oauth.is_some() || !supports_native_oauth(&self.config) {
            return Ok(None);
        }

        let Some(discovery) = probe_server_for_oauth_discovery(&self.id, &self.config).await?
        else {
            return Ok(None);
        };

        let mut discovered_config = self.config.clone();
        let server_url = self
            .config
            .url
            .as_deref()
            .context("discovered OAuth runtime is missing MCP url")?;
        discovered_config.oauth = Some(discovered_oauth_config(server_url, discovery.clone()));
        let oauth =
            OAuthBinding::new(&self.id, &discovered_config, self.oauth_coordinator.clone()).await?;
        let _ = oauth.apply_discovery(discovery).await?;
        oauth.initialize_startup_state().await?;

        let mut guard = self.oauth.write().await;
        if let Some(existing) = guard.as_ref() {
            return Ok(Some(existing.clone()));
        }
        *guard = Some(oauth.clone());
        Ok(Some(oauth))
    }

    async fn ensure_oauth_runtime_from_auth_challenge(
        &self,
        auth_header: &str,
    ) -> Result<Option<Arc<OAuthBinding>>> {
        if let Some(oauth) = self.oauth.read().await.clone() {
            return Ok(Some(oauth));
        }
        if self.config.oauth.is_some() || !supports_native_oauth(&self.config) {
            return Ok(None);
        }

        let Some(server_url) = self.config.url.as_deref() else {
            return Ok(None);
        };

        info!(
            "[{}] discovered OAuth requirement from streamable-http initialize challenge",
            self.id
        );
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::limited(10))
            .build()
            .context("failed to build OAuth challenge discovery client")?;
        let Some(discovery) =
            discover_from_auth_challenge(&client, &self.id, auth_header, server_url).await?
        else {
            warn!(
                "[{}] streamable-http initialize challenge did not yield OAuth metadata",
                self.id
            );
            return Ok(None);
        };

        let mut discovered_config = self.config.clone();
        discovered_config.oauth = Some(discovered_oauth_config(server_url, discovery.clone()));
        let oauth =
            OAuthBinding::new(&self.id, &discovered_config, self.oauth_coordinator.clone()).await?;
        let _ = oauth.apply_discovery(discovery).await?;
        oauth.initialize_startup_state().await?;

        let mut guard = self.oauth.write().await;
        if let Some(existing) = guard.as_ref() {
            return Ok(Some(existing.clone()));
        }
        *guard = Some(oauth.clone());
        Ok(Some(oauth))
    }

    async fn ensure_preconnect_oauth_ready(&self, oauth: Option<&Arc<OAuthBinding>>) -> Result<()> {
        let Some(oauth) = oauth else {
            return Ok(());
        };
        if let Some(handshake) = self.oauth_coordinator.get_handshake(&self.id).await {
            if handshake.state == OAuthState::Failed {
                let message = handshake
                    .error_message
                    .unwrap_or_else(|| "previous OAuth authorization failed".to_string());
                return Err(anyhow!(
                    "OAuth authorization failed for server '{}': {message}",
                    self.id
                ));
            }
        }
        match oauth.seed_access_token_from_broker(false).await {
            Ok(OAuthBrokerSeedOutcome::Seeded) => {
                if oauth.has_usable_tokens().await? {
                    return Ok(());
                }
            }
            Ok(OAuthBrokerSeedOutcome::AuthorizationRequired(message)) => {
                return Err(anyhow!(
                    "OAuth authorization required for server '{}': {message}",
                    self.id
                ));
            }
            Ok(OAuthBrokerSeedOutcome::NotConfigured) => {}
            Err(error) if oauth.uses_access_token_broker() => {
                self.oauth_coordinator
                    .mark_authorization_required(
                        &self.id,
                        format!("OAuth access-token broker is unavailable: {error:#}"),
                    )
                    .await;
                return Err(anyhow!(
                    "OAuth authorization required for server '{}': host-side OAuth broker unavailable",
                    self.id
                ));
            }
            Err(error) => return Err(error),
        }
        if oauth.has_usable_tokens().await? {
            return Ok(());
        }

        if oauth.uses_access_token_broker() {
            self.oauth_coordinator
                .mark_authorization_required(
                    &self.id,
                    "host-side OAuth broker did not provide a usable access token",
                )
                .await;
            return Err(anyhow!(
                "OAuth authorization required for server '{}': host-side OAuth record unavailable",
                self.id
            ));
        }

        info!(
            "[{}] native OAuth preconnect gate detected missing/invalid tokens; generating authorization URL",
            self.id
        );
        let authorization_url = oauth.ensure_authorization_url(false).await?;
        Err(anyhow!(
            "OAuth authorization required for server '{}'; authorization_url={authorization_url}",
            self.id
        ))
    }

    async fn openapi(&self) -> Value {
        self.state.read().await.openapi.clone()
    }

    async fn provider_readiness(&self) -> ProviderReadiness {
        let session = self.state.read().await.session.clone();
        match session {
            Some(session) if !session.is_closed() => session.provider_readiness().await,
            _ => ProviderReadiness::NotRequired,
        }
    }

    async fn status_json(&self) -> Value {
        let (session, tools_count, total_paths, error, title, version) = {
            let state = self.state.read().await;
            (
                state.session.clone(),
                state.tools.len(),
                state
                    .openapi
                    .get("paths")
                    .and_then(Value::as_object)
                    .map(|paths| paths.len())
                    .unwrap_or(state.tools.len()),
                state.error.clone(),
                state.title.clone(),
                state.version.clone(),
            )
        };
        let session_connected = session.as_ref().is_some_and(|session| !session.is_closed());
        let (provider_readiness, provider_warmup) = match session {
            Some(session) if !session.is_closed() => {
                let readiness = session.provider_readiness().await;
                // Starting carries the 503 WarmupStatus; Ready may carry a
                // never-block provider's background-sync narration (200 body
                // with syncing:true) — the session holds None once the sync
                // finishes, so a healthy-and-done server attaches nothing.
                let warmup = match readiness {
                    ProviderReadiness::Starting | ProviderReadiness::Ready => {
                        session.provider_warmup()
                    }
                    _ => None,
                };
                (readiness, warmup)
            }
            _ => (ProviderReadiness::NotRequired, None),
        };
        let oauth_handshake = if let Some(oauth) = self.oauth_runtime().await {
            oauth.handshake().await
        } else {
            None
        };
        let oauth_state = oauth_handshake
            .as_ref()
            .map(|handshake| handshake.state.as_str().to_string());
        let authorization_url_available = oauth_handshake
            .as_ref()
            .and_then(|handshake| handshake.authorization_url.as_ref())
            .is_some();
        let (recovery_phase, consecutive_failures, last_failure_category, unknown_policy_entries) = {
            let control = self.recovery.control.lock().await;
            (
                control.phase,
                control.failures.len() + control.pending_failures.len(),
                control
                    .last_failure_category
                    .or_else(|| control.failures.back().map(|entry| entry.category))
                    .map(FailureCategory::as_str),
                control.unknown_policy_entries.clone(),
            )
        };
        let recovery_allows_health = matches!(
            recovery_phase,
            RecoveryPhase::Healthy | RecoveryPhase::RetryLeader
        );
        let healthy = session_connected
            && error.is_none()
            && tools_count > 0
            && recovery_allows_health
            && provider_readiness.allows_tool_ready();
        let readiness_phase = if !recovery_allows_health {
            recovery_phase.as_str()
        } else if oauth_state.as_deref() == Some(OAuthState::Active.as_str()) {
            "needs_oauth"
        } else if oauth_state.as_deref() == Some(OAuthState::WaitingCallback.as_str()) {
            "waiting_callback"
        } else if oauth_state.as_deref() == Some(OAuthState::Checking.as_str()) {
            "checking_tokens"
        } else if !provider_readiness.allows_tool_ready() && session_connected && error.is_none() {
            "starting"
        } else if healthy {
            "tool_ready"
        } else if session_connected && error.is_none() {
            "connected_no_tools"
        } else if error.is_some() {
            "failed"
        } else {
            "not_connected"
        };
        json!({
            "server_id": self.id.clone(),
            "status": if healthy { "healthy" } else { readiness_phase },
            "readiness_phase": readiness_phase,
            "provider_readiness": provider_readiness.as_str(),
            "provider_warmup": provider_warmup,
            "healthy": healthy,
            "tools_count": tools_count,
            "total_paths": total_paths,
            "authorization_url_available": authorization_url_available,
            "oauth_state": oauth_state,
            "error": error.map(|message| strip_authorization_url(&message)),
            "title": title,
            "version": version,
            "recovery_state": recovery_phase.as_str(),
            "logical_in_flight_count": self.recovery.in_flight.load(Ordering::SeqCst),
            "consecutive_failure_count": consecutive_failures,
            "last_safe_failure_category": last_failure_category,
            "configured_retryable_tool_count": self.config.retryable_tools().len(),
            "unknown_retry_policy_entries": unknown_policy_entries,
        })
    }

    async fn tool_route(&self, route_name: &str) -> Option<ToolRoute> {
        self.state.read().await.tools.get(route_name).cloned()
    }

    async fn oauth_runtime(&self) -> Option<Arc<OAuthBinding>> {
        self.oauth.read().await.clone()
    }

    async fn begin_logical_call(self: &Arc<Self>) -> Result<InFlightGuard> {
        let control = self.recovery.control.lock().await;
        let phase = control.phase;
        if phase.rejects_new_calls() {
            let category = if phase == RecoveryPhase::AuthRequired {
                FailureCategory::AuthRequired
            } else {
                FailureCategory::Transport
            };
            return Err(ToolRuntimeError {
                message: if phase == RecoveryPhase::AuthRequired {
                    format!("OAuth authorization required for server '{}'", self.id)
                } else {
                    format!("MCP server '{}' recovery is in progress", self.id)
                },
                category,
                retry_attempted: false,
                recovery_state: phase,
                retry_after_seconds: (phase != RecoveryPhase::AuthRequired)
                    .then_some(RECOVERY_RETRY_AFTER_SECONDS),
            }
            .into());
        }
        self.recovery.in_flight.fetch_add(1, Ordering::SeqCst);
        drop(control);
        Ok(InFlightGuard {
            server: self.clone(),
        })
    }

    async fn record_success(&self, retry_leader_success: bool) {
        let mut control = self.recovery.control.lock().await;
        control.failures.clear();
        control.pending_failures.clear();
        control.last_failure_category = None;
        if retry_leader_success && control.phase == RecoveryPhase::RetryLeader {
            control.phase = RecoveryPhase::Healthy;
        }
    }

    async fn try_claim_retry_leader(
        &self,
        call_id: &str,
        category: FailureCategory,
    ) -> Result<bool, ToolRuntimeError> {
        let mut control = self.recovery.control.lock().await;
        if control.phase == RecoveryPhase::RetryLeader {
            control
                .pending_failures
                .insert(call_id.to_string(), category);
            control.last_failure_category = Some(category);
            return Err(ToolRuntimeError {
                message: format!("MCP server '{}' retry recovery is in progress", self.id),
                category,
                retry_attempted: false,
                recovery_state: RecoveryPhase::RetryLeader,
                retry_after_seconds: Some(RECOVERY_RETRY_AFTER_SECONDS),
            });
        }
        if control.phase.rejects_new_calls() {
            return Err(ToolRuntimeError {
                message: format!("MCP server '{}' recovery is in progress", self.id),
                category,
                retry_attempted: false,
                recovery_state: control.phase,
                retry_after_seconds: Some(RECOVERY_RETRY_AFTER_SECONDS),
            });
        }
        control.phase = RecoveryPhase::RetryLeader;
        Ok(true)
    }

    async fn final_failure(
        self: &Arc<Self>,
        call_id: &str,
        message: String,
        category: FailureCategory,
        retry_attempted: bool,
        was_retry_leader: bool,
    ) -> ToolRuntimeError {
        let now = (self.recovery.now)();
        let mut should_start_recovery = false;
        let phase;
        {
            let mut control = self.recovery.control.lock().await;
            if control.phase == RecoveryPhase::RetryLeader && !was_retry_leader {
                control
                    .pending_failures
                    .insert(call_id.to_string(), category);
                control.last_failure_category = Some(category);
                return ToolRuntimeError {
                    message: format!("MCP server '{}' retry recovery is in progress", self.id),
                    category,
                    retry_attempted,
                    recovery_state: RecoveryPhase::RetryLeader,
                    retry_after_seconds: Some(RECOVERY_RETRY_AFTER_SECONDS),
                };
            }

            if was_retry_leader && control.phase == RecoveryPhase::RetryLeader {
                control.phase = RecoveryPhase::Healthy;
            }
            control
                .failures
                .retain(|entry| now.duration_since(entry.occurred_at) <= RECOVERY_FAILURE_WINDOW);

            let mut evidence = std::mem::take(&mut control.pending_failures);
            evidence.insert(call_id.to_string(), category);
            for (evidence_call_id, evidence_category) in evidence {
                if !control
                    .failures
                    .iter()
                    .any(|entry| entry.call_id == evidence_call_id)
                {
                    control.failures.push_back(FailureEvidence {
                        call_id: evidence_call_id,
                        occurred_at: now,
                        category: evidence_category,
                    });
                }
            }
            control.last_failure_category = Some(category);

            if control.failures.len() >= RECOVERY_FAILURE_THRESHOLD {
                control.phase = RecoveryPhase::CircuitOpen;
                if !control.recovery_started {
                    control.recovery_started = true;
                    should_start_recovery = true;
                }
            }
            phase = control.phase;
        }

        if should_start_recovery {
            let server = self.clone();
            tokio::spawn(async move {
                server.recover_after_drain().await;
            });
        }

        ToolRuntimeError {
            message,
            category,
            retry_attempted,
            recovery_state: phase,
            retry_after_seconds: phase
                .rejects_new_calls()
                .then_some(RECOVERY_RETRY_AFTER_SECONDS),
        }
    }

    fn configured_retryable(&self, original_name: &str) -> bool {
        self.config
            .retryable_tools()
            .iter()
            .any(|configured| configured == original_name)
    }

    async fn call_tool(
        self: &Arc<Self>,
        route: &ToolRoute,
        arguments: Map<String, Value>,
        headers: &HeaderMap,
    ) -> Result<Value> {
        let _in_flight = self.begin_logical_call().await?;
        self.ensure_connected().await?;
        self.maybe_reconnect_idle_streamable_http_session().await?;
        let timeout = self.config.tool_call_timeout.map(Duration::from_secs_f64);
        let call_id = resolve_tool_call_log_id(&self.id, headers);
        let chat_id = header_log_value(headers, CHAT_ID_HEADER);
        let message_id = header_log_value(headers, MESSAGE_ID_HEADER);
        let session_id = header_log_value(headers, SESSION_ID_HEADER);
        let mut retry_attempted = false;

        let mut result = self
            .invoke_tool(&call_id, 1, route, arguments.clone(), timeout, headers)
            .await;

        let auth_payload_message = result.as_ref().ok().and_then(|value| {
            extract_error_message_from_value(value)
                .filter(|message| is_probable_oauth_error_text(message))
        });
        let auth_error = result.as_ref().err().is_some_and(|error| {
            classify_tool_failure(&error.to_string()) == FailureCategory::AuthRequired
        });
        let interactive_auth_known = result
            .as_ref()
            .ok()
            .is_some_and(value_requires_interactive_authorization)
            || result
                .as_ref()
                .err()
                .is_some_and(|error| error.to_string().contains("authorization_url="));
        let interactive_authorization_url = result.as_ref().ok().and_then(value_authorization_url);

        if interactive_auth_known && result.is_ok() {
            let message = auth_payload_message
                .clone()
                .unwrap_or_else(|| "OAuth authorization required".to_string());
            result = Err(match interactive_authorization_url {
                Some(authorization_url) => {
                    anyhow!("{message}; authorization_url={authorization_url}")
                }
                None => anyhow!(message),
            });
        } else if self.oauth_runtime().await.is_some()
            && (auth_payload_message.is_some() || auth_error)
        {
            let reason = if auth_payload_message.is_some() {
                "tool_call_error_payload"
            } else {
                "tool_call_failure"
            };
            warn!(
                "[{}] first auth-like tool outcome; attempting bounded OAuth refresh/reconnect call_id={} route={} original_tool={}",
                self.id, call_id, route.route_name, route.original_name
            );
            if self
                .best_effort_refresh_after_first_oauth_outcome(reason)
                .await
            {
                retry_attempted = true;
                result = self
                    .invoke_tool(&call_id, 2, route, arguments.clone(), timeout, headers)
                    .await;
            } else if let Some(message) = auth_payload_message {
                result = Err(anyhow!(message));
            }
        }

        if let Ok(value) = result {
            self.record_success(false).await;
            info!(
                "[{}] tool call completed call_id={} route={} original_tool={} retry_attempted={}",
                self.id, call_id, route.route_name, route.original_name, retry_attempted
            );
            return Ok(value);
        }

        let first_error = result.expect_err("tool result was checked above");
        let mut message = first_error.to_string();
        let mut category = classify_tool_failure(&message);

        if category == FailureCategory::AuthRequired {
            let mut control = self.recovery.control.lock().await;
            control.phase = RecoveryPhase::AuthRequired;
            control.failures.clear();
            control.pending_failures.clear();
            control.last_failure_category = None;
            return Err(ToolRuntimeError {
                message,
                category,
                retry_attempted,
                recovery_state: RecoveryPhase::AuthRequired,
                retry_after_seconds: None,
            }
            .into());
        }

        let mut was_retry_leader = false;
        if category.is_recovery_eligible()
            && self.configured_retryable(&route.original_name)
            && !retry_attempted
        {
            match self.try_claim_retry_leader(&call_id, category).await {
                Ok(true) => {
                    was_retry_leader = true;
                    retry_attempted = true;
                    let delay = (self.recovery.retry_delay)();
                    info!(
                        "[{}] retrying allowlisted MCP tool call_id={} original_tool={} delay_ms={}",
                        self.id,
                        call_id,
                        route.original_name,
                        delay.as_millis()
                    );
                    tokio::time::sleep(delay).await;
                    match self
                        .invoke_tool(&call_id, 2, route, arguments, timeout, headers)
                        .await
                    {
                        Ok(value) => {
                            self.record_success(true).await;
                            info!(
                                "[{}] retry recovered tool call call_id={} route={} original_tool={}",
                                self.id, call_id, route.route_name, route.original_name
                            );
                            return Ok(value);
                        }
                        Err(error) => {
                            message = error.to_string();
                            category = classify_tool_failure(&message);
                        }
                    }
                }
                Ok(false) => unreachable!("retry leader claim is boolean for future policy use"),
                Err(error) => return Err(error.into()),
            }
        }

        warn!(
            "[{}] tool call failed call_id={} route={} original_tool={} chat_id={:?} message_id={:?} session_id={:?} retry_attempted={} category={} error={}",
            self.id,
            call_id,
            route.route_name,
            route.original_name,
            chat_id,
            message_id,
            session_id,
            retry_attempted,
            category.as_str(),
            message
        );

        if category.is_recovery_eligible() {
            return Err(self
                .final_failure(
                    &call_id,
                    message,
                    category,
                    retry_attempted,
                    was_retry_leader,
                )
                .await
                .into());
        }

        if was_retry_leader {
            let mut control = self.recovery.control.lock().await;
            if control.phase == RecoveryPhase::RetryLeader {
                control.phase = RecoveryPhase::Healthy;
                control.pending_failures.clear();
            }
        }
        Err(ToolRuntimeError {
            message,
            category,
            retry_attempted,
            recovery_state: self.recovery.control.lock().await.phase,
            retry_after_seconds: None,
        }
        .into())
    }

    async fn invoke_tool(
        &self,
        call_id: &str,
        attempt: usize,
        route: &ToolRoute,
        arguments: Map<String, Value>,
        timeout: Option<Duration>,
        headers: &HeaderMap,
    ) -> Result<Value> {
        let session = {
            let state = self.state.read().await;
            state
                .session
                .clone()
                .ok_or_else(|| anyhow!("server '{}' is not connected", self.id))?
        };

        let mut request = CallToolRequestParams::new(route.original_name.clone());
        request.arguments = Some(arguments);
        request.meta = Some(forwarded_header_meta(headers, &self.config));
        let chat_id = header_log_value(headers, CHAT_ID_HEADER);
        let message_id = header_log_value(headers, MESSAGE_ID_HEADER);
        let session_id = header_log_value(headers, SESSION_ID_HEADER);
        let started_at = std::time::Instant::now();

        info!(
            "[{}] tool call start call_id={} attempt={} route={} original_tool={} timeout_seconds={:?} chat_id={:?} message_id={:?} session_id={:?}",
            self.id,
            call_id,
            attempt,
            route.route_name,
            route.original_name,
            timeout.map(|value| value.as_secs_f64()),
            chat_id,
            message_id,
            session_id
        );

        let result = match timeout {
            Some(timeout) => {
                match tokio::time::timeout(timeout, session.call_tool(request)).await {
                    Ok(result) => result?,
                    Err(_) => {
                        warn!(
                            "[{}] tool call timeout call_id={} attempt={} route={} original_tool={} elapsed_ms={} timeout_seconds={}",
                            self.id,
                            call_id,
                            attempt,
                            route.route_name,
                            route.original_name,
                            started_at.elapsed().as_millis(),
                            timeout.as_secs_f64()
                        );
                        return Err(anyhow!(
                            "tool call exceeded configured timeout ({:?})",
                            timeout
                        ));
                    }
                }
            }
            None => session.call_tool(request).await?,
        };

        info!(
            "[{}] tool call response call_id={} attempt={} route={} original_tool={} elapsed_ms={}",
            self.id,
            call_id,
            attempt,
            route.route_name,
            route.original_name,
            started_at.elapsed().as_millis()
        );
        let response = call_tool_response(result);
        {
            let mut state = self.state.write().await;
            state.last_activity_at = Some(SystemTime::now());
            state.error = None;
        }
        Ok(maybe_spill_large_tool_response(&self.id, &route.route_name, headers, response).await)
    }

    async fn best_effort_refresh_after_first_oauth_outcome(&self, reason: &str) -> bool {
        if self.oauth_runtime().await.is_none() {
            return false;
        }
        match tokio::time::timeout(
            OAUTH_REFRESH_TIMEOUT,
            self.reconnect_after_oauth_failure(reason),
        )
        .await
        {
            Ok(Ok(())) => true,
            Ok(Err(error)) => {
                warn!(
                    "[{}] best-effort OAuth/session recovery after {} failed: {error:#}",
                    self.id, reason
                );
                false
            }
            Err(_) => {
                warn!(
                    "[{}] bounded OAuth/session recovery after {} exceeded {} seconds",
                    self.id,
                    reason,
                    OAUTH_REFRESH_TIMEOUT.as_secs()
                );
                false
            }
        }
    }

    async fn reconnect_after_oauth_failure(&self, reason: &str) -> Result<()> {
        let Some(oauth) = self.oauth_runtime().await else {
            return self.ensure_connected().await;
        };

        match oauth.refresh_or_reauthorize().await? {
            OAuthRefreshOutcome::Refreshed => {
                info!(
                    "[{}] OAuth refresh succeeded during {}; reconnecting MCP session",
                    self.id, reason
                );
            }
            OAuthRefreshOutcome::AuthorizationRequired(authorization_url) => {
                return Err(anyhow!(
                    "OAuth re-authorization required for server '{}'; authorization_url={authorization_url}",
                    self.id
                ));
            }
        }

        let _guard = self.connect_lock.lock().await;
        let previous_session = {
            let mut state = self.state.write().await;
            state.error = None;
            state.session.take()
        };

        if let Some(session) = previous_session {
            if let Err(error) = session.close().await {
                warn!(
                    "[{}] failed to close stale MCP session before reconnect: {error:#}",
                    self.id
                );
            }
        }

        self.connect_fresh().await
    }

    async fn reload_oauth_tokens(&self) -> Result<bool> {
        let Some(oauth) = self.oauth_runtime().await else {
            return Ok(false);
        };

        if !oauth.has_usable_tokens().await? {
            return Ok(false);
        }

        self.oauth_coordinator.mark_checking(&self.id).await;
        info!(
            "[{}] OAuth tokens reloaded from disk; forcing MCP reconnect",
            self.id
        );

        {
            let _guard = self.connect_lock.lock().await;
            let previous_session = {
                let mut state = self.state.write().await;
                state.error = None;
                state.session.take()
            };
            if let Some(session) = previous_session {
                let _ = session.close().await;
            }
        }

        self.connect_fresh().await?;
        self.reset_recovery_after_connection().await;
        Ok(true)
    }

    async fn reset_recovery_after_connection(&self) {
        let mut control = self.recovery.control.lock().await;
        control.phase = RecoveryPhase::Healthy;
        control.failures.clear();
        control.pending_failures.clear();
        control.last_failure_category = None;
        control.recovery_started = false;
    }

    async fn reconnect_for_recovery(&self) -> Result<()> {
        #[cfg(test)]
        if let Some(outcome) = self.recovery.reconnect_outcome.lock().await.take() {
            return outcome.map_err(|message| anyhow!(message));
        }
        let _guard = self.connect_lock.lock().await;
        let previous_session = {
            let mut state = self.state.write().await;
            state.error = None;
            state.last_activity_at = None;
            state.session.take()
        };
        if let Some(session) = previous_session {
            if let Err(error) = session.close().await {
                warn!(
                    "[{}] failed to close MCP session during circuit recovery: {error:#}",
                    self.id
                );
            }
        }
        self.connect_fresh().await
    }

    async fn recover_after_drain(self: Arc<Self>) {
        loop {
            let notified = self.recovery.drained.notified();
            if self.recovery.in_flight.load(Ordering::SeqCst) == 0 {
                break;
            }
            notified.await;
        }

        {
            let mut control = self.recovery.control.lock().await;
            if control.phase != RecoveryPhase::CircuitOpen {
                return;
            }
            control.phase = RecoveryPhase::Reconnecting;
        }

        info!(
            "[{}] circuit drained; reconnecting MCP session before considering container restart",
            self.id
        );
        match self.reconnect_for_recovery().await {
            Ok(()) => {
                info!(
                    "[{}] MCP session recovery succeeded; container restart avoided",
                    self.id
                );
                self.reset_recovery_after_connection().await;
            }
            Err(error) => {
                let message = error.to_string();
                let category = classify_tool_failure(&message);
                if category == FailureCategory::AuthRequired {
                    warn!(
                        "[{}] MCP session recovery requires interactive authorization; restart suppressed",
                        self.id
                    );
                    let mut control = self.recovery.control.lock().await;
                    control.phase = RecoveryPhase::AuthRequired;
                    control.failures.clear();
                    control.pending_failures.clear();
                    control.last_failure_category = None;
                    control.recovery_started = false;
                    return;
                }

                warn!(
                    "[{}] MCP session recovery failed; requesting one coordinated targeted restart: {error:#}",
                    self.id
                );
                {
                    let mut control = self.recovery.control.lock().await;
                    control.phase = RecoveryPhase::RestartPending;
                    control.last_failure_category = Some(category);
                }
                trigger_restart_hook(&self.id, "automatic_timeout_recovery").await;
            }
        }
    }
}

fn build_tool_routes(
    server_id: &str,
    config: &ServerConfig,
    tools: &[Tool],
) -> BTreeMap<String, ToolRoute> {
    let disabled = config
        .disabled_tools
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    let rename_mapping = normalize_tool_rename_mapping(&config.tool_rename_mapping);
    let normalized_server_id = server_id.replace('-', "_");
    let mut seen = BTreeSet::new();
    let mut routes = BTreeMap::new();

    for tool in tools {
        let original_name = tool.name.to_string();
        if disabled.contains(&original_name) {
            continue;
        }

        let renamed_label = rename_mapping.get(&original_name).cloned().or_else(|| {
            rename_mapping
                .get(&original_name.to_ascii_lowercase())
                .cloned()
        });
        let sanitized = renamed_label
            .as_deref()
            .map(sanitize_tool_name)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| original_name.clone());

        let mut route_name = format!("{normalized_server_id}_{sanitized}");
        if seen.contains(&route_name) && renamed_label.is_some() {
            route_name = format!("{normalized_server_id}_{original_name}");
        }
        seen.insert(route_name.clone());

        routes.insert(
            route_name.clone(),
            ToolRoute {
                route_name,
                original_name,
                display_name: renamed_label,
                title: tool.title.clone(),
                description: tool.description.as_ref().map(|value| value.to_string()),
                input_schema: Value::Object((*tool.input_schema).clone()),
                output_schema: tool
                    .output_schema
                    .as_ref()
                    .map(|schema| Value::Object((**schema).clone())),
            },
        );
    }

    routes
}

async fn handle_health() -> impl IntoResponse {
    (StatusCode::OK, "healthy")
}

async fn handle_root_openapi(State(state): State<AppState>) -> Json<Value> {
    let server_ids = state.servers.keys().cloned().collect::<Vec<_>>();
    Json(build_root_openapi(&server_ids))
}

async fn handle_servers(State(state): State<AppState>) -> Json<Value> {
    let server_ids = state.servers.keys().cloned().collect::<Vec<_>>();
    let mut statuses = Map::new();
    for (server_id, server) in &state.servers {
        statuses.insert(server_id.clone(), server.status_json().await);
    }
    Json(json!({
        "count": server_ids.len(),
        "servers": server_ids,
        "server_statuses": statuses,
    }))
}

async fn handle_server_status(
    State(state): State<AppState>,
    Path(server_id): Path<String>,
) -> impl IntoResponse {
    let Some(server) = state.server(&server_id) else {
        return json_error(
            StatusCode::NOT_FOUND,
            format!("unknown server '{server_id}'"),
        )
        .into_response();
    };
    Json(server.status_json().await).into_response()
}

async fn handle_server_openapi(
    State(state): State<AppState>,
    Path(server_id): Path<String>,
) -> impl IntoResponse {
    let Some(server) = state.server(&server_id) else {
        return json_error(
            StatusCode::NOT_FOUND,
            format!("unknown server '{server_id}'"),
        )
        .into_response();
    };

    if let Err(error) = server.ensure_connected().await {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "message": error.to_string()
            })),
        )
            .into_response();
    }

    let provider_readiness = server.provider_readiness().await;
    if !provider_readiness.allows_tool_ready() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "message": "provider is still initializing",
                "provider_readiness": provider_readiness.as_str(),
            })),
        )
            .into_response();
    }

    Json(server.openapi().await).into_response()
}

async fn handle_server_docs(Path(server_id): Path<String>) -> impl IntoResponse {
    Html(swagger_ui_html(&server_id))
}

async fn handle_oauth_status(State(state): State<AppState>) -> Json<Value> {
    Json(state.oauth_coordinator().status_json().await)
}

async fn handle_oauth_current(State(state): State<AppState>) -> Json<Value> {
    Json(state.oauth_coordinator().current_json().await)
}

async fn handle_oauth_pending(State(state): State<AppState>) -> Json<Value> {
    Json(state.oauth_coordinator().pending_json().await)
}

async fn handle_oauth_refresh(
    State(state): State<AppState>,
    Path(server_name): Path<String>,
) -> impl IntoResponse {
    let Some(server) = state.server(&server_name) else {
        return json_error(
            StatusCode::NOT_FOUND,
            format!("unknown server '{server_name}'"),
        )
        .into_response();
    };
    let Some(oauth) = server.oauth_runtime().await else {
        return json_error(
            StatusCode::BAD_REQUEST,
            format!("server '{server_name}' does not use OAuth"),
        )
        .into_response();
    };

    match oauth.refresh_or_reauthorize().await {
        Ok(OAuthRefreshOutcome::Refreshed) => (
            StatusCode::OK,
            Json(json!({
                "success": true,
                "server_name": server_name,
                "authorization_url": null,
                "status": "checking"
            })),
        )
            .into_response(),
        Ok(OAuthRefreshOutcome::AuthorizationRequired(authorization_url)) => (
            StatusCode::OK,
            Json(json!({
                "success": true,
                "server_name": server_name,
                "authorization_url": authorization_url,
                "status": "active"
            })),
        )
            .into_response(),
        Err(error) => {
            json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response()
        }
    }
}

async fn handle_oauth_reload(
    State(state): State<AppState>,
    Path(server_name): Path<String>,
) -> impl IntoResponse {
    let Some(server) = state.server(&server_name) else {
        return json_error(
            StatusCode::NOT_FOUND,
            format!("unknown server '{server_name}'"),
        )
        .into_response();
    };

    match server.reload_oauth_tokens().await {
        Ok(true) => (
            StatusCode::OK,
            Json(json!({
                "success": true,
                "server_name": server_name,
                "reloaded": true,
                "connected": true
            })),
        )
            .into_response(),
        Ok(false) => (
            StatusCode::OK,
            Json(json!({
                "success": false,
                "server_name": server_name,
                "reloaded": false,
                "message": "no usable OAuth tokens found on disk"
            })),
        )
            .into_response(),
        Err(error) => {
            warn!("[{}] OAuth token reload failed: {error:#}", server_name);
            json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response()
        }
    }
}

/// Constant-time byte comparison to avoid leaking the bootstrap export bearer
/// through timing differences.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Serialize a captured OAuth token and ensure it carries an absolute expiry
/// (`expires_at`). Provider token responses frequently include only the
/// relative `expires_in`; without an absolute timestamp the host-side broker
/// cannot reason about expiry correctly once the bootstrap container is gone.
fn normalize_bootstrap_token_expiry(
    token: crate::oauth::CompatTokenFile,
) -> serde_json::Result<Value> {
    let expires_in = token.expires_in;
    let mut value = serde_json::to_value(&token)?;
    if let Value::Object(ref mut map) = value {
        let has_absolute_expiry = ["expires_at", "expiry", "expiresAt"]
            .iter()
            .any(|key| map.get(*key).map(|v| !v.is_null()).unwrap_or(false));
        if !has_absolute_expiry {
            if let Some(expires_in) = expires_in.filter(|seconds| *seconds > 0) {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|elapsed| elapsed.as_secs() as i64)
                    .unwrap_or(0);
                map.insert("expires_at".to_string(), json!(now + expires_in));
            }
        }
    }
    Ok(value)
}

/// Export a freshly captured OAuth record from a single-server *bootstrap*
/// stack so Electron can import it into host safeStorage.
///
/// This endpoint only exists while `portico_OAUTH_BOOTSTRAP_EXPORT_TOKEN` is set
/// (single-server OAuth bootstrap mode). It is guarded by that one-time bearer,
/// served only on the 127.0.0.1-bound single-server stack, and never returns
/// anything when the broker-mode/main stack is running.
async fn handle_oauth_bootstrap_record(
    State(state): State<AppState>,
    Path(server_name): Path<String>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let expected_token = std::env::var("portico_OAUTH_BOOTSTRAP_EXPORT_TOKEN")
        .ok()
        .filter(|value| !value.trim().is_empty());
    let Some(expected_token) = expected_token else {
        // Endpoint is disabled outside bootstrap mode; behave as if it does not exist.
        return json_error(StatusCode::NOT_FOUND, "not found").into_response();
    };

    let provided = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(|value| value.trim().to_string())
        .unwrap_or_default();

    if !constant_time_eq(provided.as_bytes(), expected_token.as_bytes()) {
        return json_error(StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }

    let Some(server) = state.server(&server_name) else {
        return json_error(
            StatusCode::NOT_FOUND,
            format!("unknown server '{server_name}'"),
        )
        .into_response();
    };
    let Some(oauth) = server.oauth_runtime().await else {
        return json_error(
            StatusCode::BAD_REQUEST,
            format!("server '{server_name}' does not use OAuth"),
        )
        .into_response();
    };

    match oauth.export_oauth_record() {
        Ok(Some((token, client_info))) => {
            let token_value = match normalize_bootstrap_token_expiry(token) {
                Ok(value) => value,
                Err(error) => {
                    return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
                        .into_response();
                }
            };
            let client_value = match serde_json::to_value(&client_info) {
                Ok(value) => value,
                Err(error) => {
                    return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
                        .into_response();
                }
            };
            (
                StatusCode::OK,
                [(axum::http::header::CACHE_CONTROL, "no-store")],
                Json(json!({
                    "server_id": server_name,
                    "token": token_value,
                    "client_info": client_value,
                })),
            )
                .into_response()
        }
        // Token not captured yet (callback still in flight); caller retries.
        Ok(None) => json_error(
            StatusCode::NOT_FOUND,
            format!("OAuth record for '{server_name}' is not available yet"),
        )
        .into_response(),
        Err(error) => {
            json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response()
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
struct OAuthCallbackQuery {
    code: Option<String>,
    state: Option<String>,
    server_name: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

async fn handle_oauth_callback(
    State(state): State<AppState>,
    Query(query): Query<OAuthCallbackQuery>,
) -> impl IntoResponse {
    match process_oauth_callback(state, query, &HeaderMap::new(), &[]).await {
        Ok(payload) => oauth_callback_html_response(
            StatusCode::OK,
            "success",
            "Authorization Successful!",
            &payload.message,
        ),
        Err(error) => oauth_callback_html_response(
            error.status,
            "error",
            "Authorization Failed",
            &error.message,
        ),
    }
}

async fn handle_oauth_callback_post(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<OAuthCallbackQuery>,
    body: Bytes,
) -> impl IntoResponse {
    match process_oauth_callback(state, query, &headers, &body).await {
        Ok(payload) => (
            StatusCode::OK,
            Json(json!({
                "status": "success",
                "server_name": payload.server_name,
                "connected": payload.connected,
                "message": payload.message,
                "error": payload.error
            })),
        )
            .into_response(),
        Err(error) => json_error(error.status, error.message).into_response(),
    }
}

#[derive(Debug)]
struct OAuthCallbackSuccess {
    server_name: String,
    connected: bool,
    message: String,
    error: Option<String>,
}

#[derive(Debug)]
struct OAuthCallbackError {
    status: StatusCode,
    message: String,
}

async fn process_oauth_callback(
    state: AppState,
    query: OAuthCallbackQuery,
    headers: &HeaderMap,
    body: &[u8],
) -> std::result::Result<OAuthCallbackSuccess, OAuthCallbackError> {
    let callback =
        merge_callback_request(query, headers, body).map_err(|error| OAuthCallbackError {
            status: StatusCode::BAD_REQUEST,
            message: error.to_string(),
        })?;

    let server_name = match callback.server_name.clone() {
        Some(server_name) => server_name,
        None => match callback.state.as_deref() {
            Some(state_param) => match state
                .oauth_coordinator()
                .server_for_state(state_param)
                .await
            {
                Some(server_name) => server_name,
                None => {
                    return Err(OAuthCallbackError {
                        status: StatusCode::NOT_FOUND,
                        message: "could not find OAuth handshake for callback state".to_string(),
                    });
                }
            },
            None => match state.oauth_coordinator().current_server().await {
                Some(server_name) => server_name,
                None => {
                    return Err(OAuthCallbackError {
                        status: StatusCode::BAD_REQUEST,
                        message: "missing server_name and OAuth state".to_string(),
                    });
                }
            },
        },
    };

    if let Some(error_code) = callback.error.as_deref() {
        let description = callback
            .error_description
            .clone()
            .unwrap_or_else(|| error_code.to_string());
        state
            .oauth_coordinator()
            .mark_failed(&server_name, format!("{error_code}: {description}"))
            .await;
        return Err(OAuthCallbackError {
            status: StatusCode::BAD_REQUEST,
            message: format!("OAuth callback returned {error_code}: {description}"),
        });
    }

    let Some(server) = state.server(&server_name) else {
        let msg = format!("unknown server '{server_name}'");
        state
            .oauth_coordinator()
            .mark_failed(&server_name, msg.clone())
            .await;
        return Err(OAuthCallbackError {
            status: StatusCode::NOT_FOUND,
            message: msg,
        });
    };
    let Some(oauth) = server.oauth_runtime().await else {
        let msg = format!("server '{server_name}' does not use OAuth");
        state
            .oauth_coordinator()
            .mark_failed(&server_name, msg.clone())
            .await;
        return Err(OAuthCallbackError {
            status: StatusCode::BAD_REQUEST,
            message: msg,
        });
    };

    let state_param = match callback.state.clone() {
        Some(state_param) => Some(state_param),
        None => state
            .oauth_coordinator()
            .get_handshake(&server_name)
            .await
            .and_then(|handshake| handshake.state_param),
    };
    let Some(state_param) = state_param else {
        let msg = "missing required OAuth state parameter".to_string();
        state
            .oauth_coordinator()
            .mark_failed(&server_name, msg.clone())
            .await;
        return Err(OAuthCallbackError {
            status: StatusCode::BAD_REQUEST,
            message: msg,
        });
    };
    let Some(code) = callback.code.as_deref() else {
        let msg = "missing required OAuth code parameter".to_string();
        state
            .oauth_coordinator()
            .mark_failed(&server_name, msg.clone())
            .await;
        return Err(OAuthCallbackError {
            status: StatusCode::BAD_REQUEST,
            message: msg,
        });
    };

    match oauth.handle_callback(code, &state_param).await {
        Ok(_) => {
            let validation_server = server.clone();
            let validation_coordinator = state.oauth_coordinator();
            let validation_server_name = server_name.clone();
            tokio::spawn(async move {
                match validation_server.reload_oauth_tokens().await {
                    Ok(true) => {
                        info!(
                            "[{}] OAuth token validation completed successfully",
                            validation_server_name
                        );
                    }
                    Ok(false) => {
                        validation_coordinator
                            .mark_validation_failed(
                                &validation_server_name,
                                "OAuth token validation could not find usable persisted tokens",
                            )
                            .await;
                    }
                    Err(error) => {
                        let message = error.to_string();
                        {
                            let mut connection_state = validation_server.state.write().await;
                            connection_state.error = Some(message.clone());
                        }
                        validation_coordinator
                            .mark_validation_failed(&validation_server_name, message)
                            .await;
                    }
                }
            });
            Ok(OAuthCallbackSuccess {
                server_name,
                connected: false,
                message: "OAuth authorization completed".to_string(),
                error: None,
            })
        }
        Err(error) => {
            let msg = error.to_string();
            state
                .oauth_coordinator()
                .mark_failed(&server_name, msg.clone())
                .await;
            Err(OAuthCallbackError {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                message: msg,
            })
        }
    }
}

fn oauth_callback_html_response(
    status: StatusCode,
    page_status: &str,
    heading: &str,
    message: &str,
) -> axum::response::Response {
    let title = match page_status {
        "success" => "Authorization Successful - Portico",
        "error" => "Authorization Failed - Portico",
        _ => "Authorization Received - Portico",
    };
    let body = OAUTH_CALLBACK_TEMPLATE
        .replace("{title}", title)
        .replace("{status_class}", page_status)
        .replace("{heading}", heading)
        .replace("{message}", message)
        // The shared callback template is also rendered by Python with
        // `str.format`, so literal CSS/JS braces are escaped as `{{` / `}}`.
        // Rust does simple token replacement here, so normalize them back.
        .replace("{{", "{")
        .replace("}}", "}");
    (status, Html(body)).into_response()
}

fn merge_callback_request(
    query: OAuthCallbackQuery,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<OAuthCallbackQuery> {
    if body.is_empty() {
        return Ok(query);
    }

    let mut merged = query;
    let content_type = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();

    let body_params = if content_type.contains("application/json") {
        serde_json::from_slice::<OAuthCallbackQuery>(body)
            .context("invalid JSON OAuth callback body")?
    } else {
        parse_callback_form_body(body)
    };

    if merged.code.is_none() {
        merged.code = body_params.code;
    }
    if merged.state.is_none() {
        merged.state = body_params.state;
    }
    if merged.server_name.is_none() {
        merged.server_name = body_params.server_name;
    }
    if merged.error.is_none() {
        merged.error = body_params.error;
    }
    if merged.error_description.is_none() {
        merged.error_description = body_params.error_description;
    }

    Ok(merged)
}

fn parse_callback_form_body(body: &[u8]) -> OAuthCallbackQuery {
    let mut callback = OAuthCallbackQuery::default();
    for (name, value) in url::form_urlencoded::parse(body) {
        match name.as_ref() {
            "code" if callback.code.is_none() => callback.code = Some(value.into_owned()),
            "state" if callback.state.is_none() => callback.state = Some(value.into_owned()),
            "server_name" if callback.server_name.is_none() => {
                callback.server_name = Some(value.into_owned());
            }
            "error" if callback.error.is_none() => callback.error = Some(value.into_owned()),
            "error_description" if callback.error_description.is_none() => {
                callback.error_description = Some(value.into_owned());
            }
            _ => {}
        }
    }
    callback
}

async fn handle_tool_call(
    State(state): State<AppState>,
    Path((server_id, route_name)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    let Some(server) = state.server(&server_id) else {
        return json_error(
            StatusCode::NOT_FOUND,
            format!("unknown server '{server_id}'"),
        )
        .into_response();
    };

    let Some(route) = server.tool_route(&route_name).await else {
        return json_error(
            StatusCode::NOT_FOUND,
            format!("unknown tool '{route_name}' for server '{server_id}'"),
        )
        .into_response();
    };

    let request_payload = if body.is_empty() {
        Value::Object(Map::new())
    } else {
        match serde_json::from_slice::<Value>(&body) {
            Ok(value) => value,
            Err(error) => {
                return json_error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    format!("invalid JSON request body: {error}"),
                )
                .into_response();
            }
        }
    };

    let arguments = match request_payload {
        Value::Null => Map::new(),
        Value::Object(map) => map,
        _ => {
            return json_error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "request body must be a JSON object",
            )
            .into_response();
        }
    };

    match server.call_tool(&route, arguments, &headers).await {
        Ok(value) => (StatusCode::OK, Json(value)).into_response(),
        Err(error) => {
            let runtime_error = error.downcast_ref::<ToolRuntimeError>();
            let message = error.to_string();
            let parsed_authorization_url = extract_authorization_url(&message);
            let clean_message = strip_authorization_url(&message);
            let coordinator_authorization_url = if parsed_authorization_url.is_none()
                && server.oauth_runtime().await.is_some()
                && is_probable_oauth_error_text(&clean_message)
            {
                state
                    .oauth_coordinator()
                    .authorization_url_for(&server_id)
                    .await
            } else {
                None
            };
            let authorization_url = parsed_authorization_url.or(coordinator_authorization_url);
            let response_message =
                if authorization_url.is_some() && is_probable_oauth_error_text(&clean_message) {
                    "OAuth re-authorization required".to_string()
                } else {
                    clean_message
                };
            let status = runtime_error
                .map(|error| {
                    if error.recovery_state == RecoveryPhase::AuthRequired {
                        StatusCode::UNAUTHORIZED
                    } else if error.recovery_state != RecoveryPhase::Healthy {
                        StatusCode::SERVICE_UNAVAILABLE
                    } else {
                        error.category.status()
                    }
                })
                .unwrap_or_else(|| {
                    status_from_tool_error(&response_message, authorization_url.as_deref())
                });
            let oauth_recovery_required = status == StatusCode::UNAUTHORIZED;
            let fallback_category = classify_tool_failure(&response_message);
            let recovery_state = if let Some(error) = runtime_error {
                error.recovery_state
            } else {
                server.recovery.control.lock().await.phase
            };
            let retry_attempted = runtime_error
                .map(|error| error.retry_attempted)
                .unwrap_or(false);
            let retry_after_seconds = runtime_error
                .and_then(|error| error.retry_after_seconds)
                .or_else(|| {
                    (recovery_state != RecoveryPhase::AuthRequired
                        && recovery_state.rejects_new_calls())
                    .then_some(RECOVERY_RETRY_AFTER_SECONDS)
                });
            let mut payload = json!({
                "message": response_message,
                "authorization_url": authorization_url,
                "retry_policy_owner": "mcp-orc",
                "error_type": runtime_error
                    .map(|error| error.category.as_str())
                    .unwrap_or_else(|| fallback_category.as_str()),
                "retry_attempted": retry_attempted,
                "recovery_state": recovery_state.as_str(),
                "retry_after_seconds": retry_after_seconds,
            });
            if oauth_recovery_required {
                payload["server_id"] = json!(server_id);
                payload["oauth_recovery_required"] = json!(true);
                payload["force_auth_recommended"] = json!(true);
            }
            let mut response = (status, Json(payload)).into_response();
            if let Some(retry_after_seconds) = retry_after_seconds {
                if let Ok(value) = HeaderValue::from_str(&retry_after_seconds.to_string()) {
                    response.headers_mut().insert(RETRY_AFTER, value);
                }
            }
            response
        }
    }
}

fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(handle_health))
        .route("/openapi.json", get(handle_root_openapi))
        .route("/servers", get(handle_servers))
        .route("/servers/{server_id}/status", get(handle_server_status))
        .route("/oauth/status", get(handle_oauth_status))
        .route("/oauth/current", get(handle_oauth_current))
        .route("/oauth/pending", get(handle_oauth_pending))
        .route("/oauth/callback", get(handle_oauth_callback))
        .route("/oauth/callback", post(handle_oauth_callback_post))
        .route("/oauth/refresh/{server_name}", post(handle_oauth_refresh))
        .route("/oauth/reload/{server_name}", post(handle_oauth_reload))
        .route(
            "/oauth/bootstrap-record/{server_name}",
            post(handle_oauth_bootstrap_record),
        )
        .route("/{server_id}/openapi.json", get(handle_server_openapi))
        .route("/{server_id}/docs", get(handle_server_docs))
        .route("/{server_id}/{route_name}", post(handle_tool_call))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

pub async fn serve(config: McpConfig, host: &str, port: u16) -> Result<()> {
    let oauth_coordinator = Arc::new(OAuthCoordinator::new());
    let mut servers = BTreeMap::new();
    for (server_id, server_config) in config.mcp_servers {
        let runtime =
            ServerRuntime::new(server_id.clone(), server_config, oauth_coordinator.clone()).await?;
        servers.insert(server_id, runtime);
    }

    for server in servers.values() {
        if let Some(oauth) = server.oauth_runtime().await {
            if let Err(error) = oauth.initialize_startup_state().await {
                warn!(
                    "native OAuth startup state init failed for '{}': {error:#}",
                    server.id
                );
            }
        }
    }

    for server in servers.values() {
        if let Err(error) = server.ensure_connected().await {
            warn!("native MCP startup failed for '{}': {error:#}", server.id);
        }
    }

    let listener = TcpListener::bind(format!("{host}:{port}"))
        .await
        .with_context(|| format!("failed to bind {host}:{port}"))?;
    oauth_coordinator.mark_serving().await;
    info!("Native mcp-orc listening on http://{host}:{port}");

    axum::serve(
        listener,
        build_router(AppState::new(servers, oauth_coordinator)),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await
    .context("axum server exited with error")
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}

#[cfg(test)]
#[path = "app_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "app_oauth_parity_tests.rs"]
mod oauth_parity_tests;

#[cfg(test)]
#[path = "app_oauth_discovery_tests.rs"]
mod oauth_discovery_tests;
