use std::collections::{HashMap, HashSet};
use std::fs;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use axum::extract::{Json, Request, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use core_mcp_shared::{
    discover_skills, list_skill_resources, read_skill_markdown, resolve_skill_resource_path,
    skill_resource_metadata, SkillMetadata, SkillResourcePathError,
};
use log::{info, warn};
use rmcp::model::{
    AnnotateAble, CallToolRequestParams, CallToolResult, Content, ErrorData, Implementation,
    JsonObject, ListToolsResult, PaginatedRequestParams, RawAudioContent, RawContent,
    ResourceContents, ServerCapabilities, ServerInfo, Tool, ToolAnnotations,
};
use rmcp::service::RequestContext;
use rmcp::transport::streamable_http_client::{
    StreamableHttpClientTransport, StreamableHttpClientTransportConfig,
};
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, tower::StreamableHttpService,
};
use rmcp::transport::{stdio, StreamableHttpServerConfig};
use rmcp::{RoleServer, ServerHandler, ServiceExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::net::TcpListener;

use crate::bridge_telemetry::{BridgeTelemetry, BridgeToolCallEvent};
use crate::cli::BridgeArgs;
use crate::config::ServerConfig;
use crate::oauth::{
    oauth_access_token_sha256, CompatClientInfo, CompatTokenFile, OAuthBinding, OAuthCoordinator,
    OAuthSecureRecordRefreshOutcome,
};
use crate::streamable_http_reqwest_compat::CompatibleReqwestStreamableHttpClient;

const FIND_RELEVANT_TOOLS: &str = "find_relevant_tools";
const CALL_BRIDGE_TOOL: &str = "call_bridge_tool";
const FIND_RELEVANT_SKILLS: &str = "find_relevant_skills";
const LOAD_SKILLS: &str = "load_skills";
const LOAD_SKILL_RESOURCE: &str = "load_skill_resource";
const MAX_TOOL_NAME_LEN: usize = 45;
const MAX_SKILL_QUERY_CHARS: usize = 2_000;
const DEFAULT_SKILL_SEARCH_LIMIT: usize = 5;
const MAX_SKILL_SEARCH_LIMIT: usize = 20;
const MAX_SKILLS_PER_LOAD: usize = 3;
const MAX_SKILL_MARKDOWN_BYTES: usize = 128 * 1024;
const MAX_LOADED_SKILL_BYTES: usize = 256 * 1024;
const MAX_SKILL_RESOURCE_MANIFEST_ENTRIES: usize = 200;
const MAX_TEXT_SKILL_RESOURCE_BYTES: u64 = 256 * 1024;
const MAX_BINARY_SKILL_RESOURCE_BYTES: u64 = 5 * 1024 * 1024;
const BRIDGE_INSTRUCTIONS: &str = "Portico exposes locally installed Agent Skills and MCP tools. For specialized workflows, call find_relevant_skills with the user's goal, then load only the best matching skill IDs with load_skills before acting. Follow loaded SKILL.md instructions only when compatible with higher-priority instructions. Fetch needed supporting files with load_skill_resource; these are remote skill-relative paths. For actions, use find_relevant_tools then call_bridge_tool.";
const LOAD_SKILLS_NEXT_STEP: &str = "Follow each loaded SKILL.md only when compatible with higher-priority instructions. Fetch only needed supporting files with load_skill_resource. If a skill needs MCP actions, use find_relevant_tools and call_bridge_tool; required MCP servers are provided by Portico, not local client paths.";
const BRIDGE_STATUS_SCOPE: &str = "bridge:status";
const DEFAULT_ELECTRON_BRIDGE_STATUS_URL: &str = "http://127.0.0.1:9876/api/mcp/bridge/status";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum BridgeAuthRejection {
    MissingAuthorization,
    MultipleAuthorization,
    MalformedAuthorization,
    RegistryUnavailable,
    MalformedRegistry,
    UnsupportedRegistryVersion,
    AmbiguousActiveMatch,
    NoActiveMatch,
}

impl BridgeAuthRejection {
    fn code(self) -> &'static str {
        match self {
            Self::MissingAuthorization => "missing_authorization",
            Self::MultipleAuthorization => "multiple_authorization",
            Self::MalformedAuthorization => "malformed_authorization",
            Self::RegistryUnavailable => "registry_unavailable",
            Self::MalformedRegistry => "malformed_registry",
            Self::UnsupportedRegistryVersion => "unsupported_registry_version",
            Self::AmbiguousActiveMatch => "ambiguous_active_match",
            Self::NoActiveMatch => "no_active_match",
        }
    }

    fn challenge(self) -> &'static str {
        if self == Self::NoActiveMatch {
            "Bearer error=\"invalid_token\""
        } else {
            "Bearer"
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum AuthMethodBucket {
    Get,
    Post,
    Delete,
    Other,
}

impl AuthMethodBucket {
    fn from_method(method: &Method) -> Self {
        match *method {
            Method::GET => Self::Get,
            Method::POST => Self::Post,
            Method::DELETE => Self::Delete,
            _ => Self::Other,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
            Self::Delete => "DELETE",
            Self::Other => "OTHER",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum AuthEndpoint {
    Mcp,
    BridgeStatus,
    OAuthSecret,
    StaticSecret,
}

impl AuthEndpoint {
    fn as_str(self) -> &'static str {
        match self {
            Self::Mcp => "/mcp",
            Self::BridgeStatus => "/bridge/status",
            Self::OAuthSecret => "/secrets/oauth/access-token",
            Self::StaticSecret => "/secrets/static-secret",
        }
    }
}

type AuthRejectionKey = (BridgeAuthRejection, AuthMethodBucket, AuthEndpoint);

#[derive(Debug, Clone)]
struct BridgeAuth {
    registry_path: Option<PathBuf>,
    rejection_counts: Arc<StdMutex<HashMap<AuthRejectionKey, u64>>>,
}

#[derive(Debug, Deserialize)]
struct BridgeAuthRegistry {
    version: u64,
    tokens: Vec<BridgeAuthTokenRecord>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeAuthTokenRecord {
    client_id: String,
    token_hash: String,
    revoked: bool,
    #[serde(default)]
    scopes: Vec<String>,
}

impl BridgeAuth {
    fn new(registry_path: Option<PathBuf>) -> Self {
        Self {
            registry_path,
            rejection_counts: Arc::new(StdMutex::new(HashMap::new())),
        }
    }

    fn authenticate_headers(
        &self,
        headers: &HeaderMap,
    ) -> std::result::Result<AuthenticatedBridgeToken, BridgeAuthRejection> {
        let token = bearer_token_from_headers(headers)?;
        self.authenticate_token(token)
    }

    fn authenticate_token(
        &self,
        token: &str,
    ) -> std::result::Result<AuthenticatedBridgeToken, BridgeAuthRejection> {
        let path = self
            .registry_path
            .as_ref()
            .ok_or(BridgeAuthRejection::RegistryUnavailable)?;
        let raw = fs::read_to_string(path).map_err(|_| BridgeAuthRejection::RegistryUnavailable)?;
        let registry = serde_json::from_str::<BridgeAuthRegistry>(&raw)
            .map_err(|_| BridgeAuthRejection::MalformedRegistry)?;
        validate_bridge_auth_registry(&registry)?;

        let mut matches = registry
            .tokens
            .iter()
            .filter(|record| !record.revoked && verify_token_hash(token, &record.token_hash));
        let record = matches.next().ok_or(BridgeAuthRejection::NoActiveMatch)?;
        if matches.next().is_some() {
            return Err(BridgeAuthRejection::AmbiguousActiveMatch);
        }
        Ok(AuthenticatedBridgeToken {
            client_id: record.client_id.clone(),
            scopes: record.scopes.clone(),
        })
    }

    fn next_rejection_log_occurrence(
        &self,
        rejection: BridgeAuthRejection,
        method: AuthMethodBucket,
        endpoint: AuthEndpoint,
    ) -> Option<u64> {
        let Ok(mut counts) = self.rejection_counts.lock() else {
            return None;
        };
        let count = counts.entry((rejection, method, endpoint)).or_insert(0);
        *count = count.saturating_add(1);
        count.is_power_of_two().then_some(*count)
    }

    fn log_rejection(
        &self,
        rejection: BridgeAuthRejection,
        method: AuthMethodBucket,
        endpoint: AuthEndpoint,
    ) {
        let Some(occurrence) = self.next_rejection_log_occurrence(rejection, method, endpoint)
        else {
            return;
        };
        let _ = std::panic::catch_unwind(|| {
            warn!(
                "Host MCP Bridge auth rejected request: reason={} method={} endpoint={} occurrence={occurrence}",
                rejection.code(),
                method.as_str(),
                endpoint.as_str(),
            );
        });
    }
}

#[derive(Debug, Clone)]
struct AuthenticatedBridgeToken {
    client_id: String,
    scopes: Vec<String>,
}

/// Client identity attached by HTTP auth and propagated by rmcp in the
/// request-parts extension. It is the app-owned registry ID, never token data.
#[derive(Debug, Clone)]
struct AuthenticatedBridgeClient {
    client_id: String,
}

fn client_id_from_context(context: &RequestContext<RoleServer>) -> String {
    context
        .extensions
        .get::<axum::http::request::Parts>()
        .and_then(|parts| parts.extensions.get::<AuthenticatedBridgeClient>())
        .map(|client| client.client_id.clone())
        .unwrap_or_else(|| "unknown".to_string())
}

impl AuthenticatedBridgeToken {
    fn has_scope(&self, scope: &str) -> bool {
        self.scopes.iter().any(|candidate| candidate == scope)
    }
}

#[derive(Debug, Clone)]
struct SecretBrokerState {
    auth: BridgeAuth,
    electron_bridge_status_url: Option<String>,
    electron_broker_url: Option<String>,
    electron_broker_update_url: Option<String>,
    electron_broker_invalidate_url: Option<String>,
    electron_static_secret_broker_url: Option<String>,
    electron_broker_token: Option<String>,
    oauth_refresh_locks: Arc<tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    http: reqwest::Client,
}

fn bearer_token_from_headers(
    headers: &HeaderMap,
) -> std::result::Result<&str, BridgeAuthRejection> {
    let values = headers.get_all(header::AUTHORIZATION);
    let mut values = values.iter();
    let value = values
        .next()
        .ok_or(BridgeAuthRejection::MissingAuthorization)?;
    if values.next().is_some() {
        return Err(BridgeAuthRejection::MultipleAuthorization);
    }
    let value = value
        .to_str()
        .map_err(|_| BridgeAuthRejection::MalformedAuthorization)?
        .trim_matches([' ', '\t']);
    let separator = value
        .find(' ')
        .ok_or(BridgeAuthRejection::MalformedAuthorization)?;
    let (scheme, credentials) = value.split_at(separator);
    if !scheme.eq_ignore_ascii_case("Bearer") {
        return Err(BridgeAuthRejection::MalformedAuthorization);
    }
    let token = credentials.trim_start_matches(' ');
    if !valid_b64token(token) {
        return Err(BridgeAuthRejection::MalformedAuthorization);
    }
    Ok(token)
}

fn valid_b64token(token: &str) -> bool {
    let mut core_len = 0usize;
    let mut saw_padding = false;
    for byte in token.bytes() {
        if byte == b'=' {
            saw_padding = true;
            continue;
        }
        if saw_padding
            || !matches!(
                byte,
                b'A'..=b'Z'
                    | b'a'..=b'z'
                    | b'0'..=b'9'
                    | b'-'
                    | b'.'
                    | b'_'
                    | b'~'
                    | b'+'
                    | b'/'
            )
        {
            return false;
        }
        core_len += 1;
    }
    core_len > 0
}

fn valid_registry_client_id(client_id: &str) -> bool {
    client_id.trim() == client_id
        && client_id.chars().any(|ch| ch.is_ascii_alphanumeric())
        && client_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
        && !client_id.starts_with('-')
        && !client_id.ends_with('-')
}

fn valid_token_hash_format(token_hash: &str) -> bool {
    let Some(rest) = token_hash.strip_prefix("sha256:") else {
        return false;
    };
    let Some((salt, digest)) = rest.split_once(':') else {
        return false;
    };
    salt.len() == 32
        && digest.len() == 64
        && salt
            .bytes()
            .chain(digest.bytes())
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn validate_bridge_auth_registry(
    registry: &BridgeAuthRegistry,
) -> std::result::Result<(), BridgeAuthRejection> {
    if registry.version != 1 {
        return Err(BridgeAuthRejection::UnsupportedRegistryVersion);
    }
    let mut client_ids = HashSet::new();
    for record in &registry.tokens {
        if !valid_registry_client_id(&record.client_id)
            || !valid_token_hash_format(&record.token_hash)
            || record.scopes.iter().any(|scope| {
                scope.is_empty()
                    || scope.trim() != scope
                    || !scope.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
            })
            || record.scopes.windows(2).any(|pair| pair[0] >= pair[1])
            || !client_ids.insert(record.client_id.to_ascii_lowercase())
        {
            return Err(BridgeAuthRejection::MalformedRegistry);
        }
    }
    Ok(())
}

fn verify_token_hash(token: &str, token_hash: &str) -> bool {
    if !valid_token_hash_format(token_hash) {
        return false;
    }
    let mut parts = token_hash.split(':');
    let algorithm = parts.next().expect("validated token hash algorithm");
    let salt = parts.next().expect("validated token hash salt");
    let expected = parts.next().expect("validated token hash digest");
    debug_assert_eq!(algorithm, "sha256");

    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(salt.as_bytes());
    hasher.update(b":");
    hasher.update(token.as_bytes());
    let candidate = format!("{:x}", hasher.finalize());
    constant_time_eq(candidate.as_bytes(), expected.as_bytes())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (left_byte, right_byte) in left.iter().zip(right.iter()) {
        diff |= left_byte ^ right_byte;
    }
    diff == 0
}

fn bridge_auth_failure_response(rejection: BridgeAuthRejection, message: &'static str) -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(header::WWW_AUTHENTICATE, rejection.challenge())],
        message,
    )
        .into_response()
}

async fn oauth_not_supported() -> (StatusCode, Json<Value>) {
    (
        StatusCode::NOT_FOUND,
        Json(json!({
            "error": "oauth_not_supported",
            "error_description": "Host MCP Bridge uses app-managed per-client credentials. Configure this client from Portico."
        })),
    )
}

async fn require_bridge_auth(
    State(auth): State<BridgeAuth>,
    mut request: Request,
    next: Next,
) -> Response {
    let method = AuthMethodBucket::from_method(request.method());
    match auth.authenticate_headers(request.headers()) {
        Ok(token) => {
            request.extensions_mut().insert(AuthenticatedBridgeClient {
                client_id: token.client_id,
            });
        }
        Err(rejection) => {
            auth.log_rejection(rejection, method, AuthEndpoint::Mcp);
            return bridge_auth_failure_response(
                rejection,
                "Host MCP Bridge requires a bearer token",
            );
        }
    }
    next.run(request).await
}

fn bridge_status_unavailable(
    error_code: &'static str,
    reason: &'static str,
) -> (StatusCode, Json<BridgeStatusResponse>) {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(BridgeStatusResponse {
            success: false,
            bridge_ready: false,
            bridge_enabled: false,
            broker_auth_ready: false,
            error_code: Some(error_code),
            reason: Some(reason),
        }),
    )
}

async fn bridge_status(State(state): State<SecretBrokerState>, headers: HeaderMap) -> Response {
    let token = match state.auth.authenticate_headers(&headers) {
        Ok(token) => token,
        Err(rejection) => {
            state
                .auth
                .log_rejection(rejection, AuthMethodBucket::Get, AuthEndpoint::BridgeStatus);
            return bridge_auth_failure_response(
                rejection,
                "Host MCP Bridge status requires a bearer token",
            );
        }
    };
    if !token.has_scope(BRIDGE_STATUS_SCOPE) {
        return (
            StatusCode::FORBIDDEN,
            "Host MCP Bridge status token is missing the bridge:status scope",
        )
            .into_response();
    }

    let Some(electron_token) = state.electron_broker_token.as_deref() else {
        return bridge_status_unavailable("missing_broker_token", "broker token is not configured")
            .into_response();
    };
    let Some(url) = state.electron_bridge_status_url.as_deref() else {
        return bridge_status_unavailable(
            "missing_electron_status_url",
            "Electron bridge status URL is not configured",
        )
        .into_response();
    };

    let response = match state.http.get(url).bearer_auth(electron_token).send().await {
        Ok(response) => response,
        Err(_) => {
            return bridge_status_unavailable(
                "electron_unreachable",
                "Electron bridge status endpoint is unreachable",
            )
            .into_response();
        }
    };
    if !response.status().is_success() {
        let error_code = if response.status() == StatusCode::UNAUTHORIZED {
            "broker_auth_rejected"
        } else {
            "electron_status_rejected"
        };
        return bridge_status_unavailable(error_code, "Electron bridge status check failed")
            .into_response();
    }
    let Ok(payload) = response.json::<ElectronBridgeStatusResponse>().await else {
        return bridge_status_unavailable(
            "invalid_electron_status",
            "Electron returned invalid status JSON",
        )
        .into_response();
    };
    // Readiness deliberately ignores `bridge_enabled`: that flag reflects the
    // optional external-client bridge preference, while this endpoint gates the
    // mandatory OAuth secret broker shared by all MCP runtime containers
    // (PORTICO-200). The flag is still reported below for status consumers.
    let ready = payload.success && payload.bridge_ready && payload.broker_auth_ready;
    let body = BridgeStatusResponse {
        success: ready,
        bridge_ready: payload.bridge_ready,
        bridge_enabled: payload.bridge_enabled,
        broker_auth_ready: payload.broker_auth_ready,
        error_code: if ready { None } else { Some("not_ready") },
        reason: if ready {
            None
        } else {
            Some("Electron reported bridge channel not ready")
        },
    };
    let status = if ready {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (status, Json(body)).into_response()
}

#[derive(Debug, Deserialize)]
struct OAuthAccessTokenRequest {
    server_id: String,
    #[serde(default)]
    force_refresh: bool,
    #[serde(default)]
    invalidate_rejected: bool,
    #[serde(default)]
    rejected_access_token_sha256: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StaticSecretRequest {
    server_id: String,
    secret_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ElectronBridgeStatusResponse {
    #[serde(default)]
    success: bool,
    #[serde(default)]
    bridge_ready: bool,
    #[serde(default)]
    bridge_enabled: bool,
    #[serde(default)]
    broker_auth_ready: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeStatusResponse {
    success: bool,
    bridge_ready: bool,
    bridge_enabled: bool,
    broker_auth_ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
}

#[derive(Debug, Deserialize)]
struct ElectronOAuthRecordResponse {
    #[serde(default)]
    server_id: Option<String>,
    token: CompatTokenFile,
    client_info: CompatClientInfo,
    server_config: ServerConfig,
}

#[derive(Debug, Serialize)]
struct ElectronOAuthRecordUpdate<'a> {
    server_id: &'a str,
    token: &'a CompatTokenFile,
    client_info: &'a CompatClientInfo,
}

#[derive(Debug, Serialize)]
struct ElectronOAuthRecordInvalidate<'a> {
    server_id: &'a str,
    error_class: &'a str,
}

#[derive(Debug)]
struct OAuthAccessTokenVendResult {
    access_token: String,
    token: CompatTokenFile,
    client_info: CompatClientInfo,
    record_changed: bool,
}

#[derive(Debug)]
enum OAuthAccessTokenVendOutcome {
    Token(OAuthAccessTokenVendResult),
    AuthorizationRequired { error_class: &'static str },
}

#[derive(Debug, Deserialize)]
struct ElectronStaticSecretResponse {
    #[serde(default)]
    server_id: Option<String>,
    #[serde(default)]
    secret_name: Option<String>,
    value_base64: String,
}

fn valid_scoped_server_id(server_id: &str) -> bool {
    let value = server_id.trim();
    !value.is_empty()
        && !value.contains("..")
        && !value.contains('/')
        && !value.contains('\\')
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
}

fn oauth_access_token_scope(server_id: &str) -> String {
    format!("oauth:access-token:{server_id}")
}

fn valid_scoped_secret_name(secret_name: &str) -> bool {
    let value = secret_name.trim();
    !value.is_empty()
        && !value.contains("..")
        && !value.contains('/')
        && !value.contains('\\')
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
}

fn static_secret_scope(server_id: &str, secret_name: &str) -> String {
    format!("static-secret:{server_id}:{secret_name}")
}

fn oauth_access_token_auth_required_response(
    server_id: &str,
    error: impl Into<String>,
) -> Response {
    (
        StatusCode::PRECONDITION_REQUIRED,
        Json(json!({
            "success": false,
            "server_id": server_id,
            "auth_required": true,
            "error": error.into(),
        })),
    )
        .into_response()
}

fn valid_access_token_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn new_oauth_refresh_locks() -> Arc<tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>
{
    Arc::new(tokio::sync::Mutex::new(HashMap::new()))
}

async fn oauth_refresh_lock(
    state: &SecretBrokerState,
    server_id: &str,
) -> Arc<tokio::sync::Mutex<()>> {
    let mut locks = state.oauth_refresh_locks.lock().await;
    Arc::clone(
        locks
            .entry(server_id.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
    )
}

async fn vend_oauth_access_token(
    State(state): State<SecretBrokerState>,
    headers: HeaderMap,
    Json(payload): Json<OAuthAccessTokenRequest>,
) -> Response {
    let server_id = payload.server_id.trim();
    if !valid_scoped_server_id(server_id) {
        return (StatusCode::BAD_REQUEST, "invalid server_id").into_response();
    }
    let rejected_access_token_sha256 = payload
        .rejected_access_token_sha256
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase);
    if rejected_access_token_sha256
        .as_deref()
        .is_some_and(|value| !valid_access_token_sha256(value))
    {
        return (
            StatusCode::BAD_REQUEST,
            "invalid rejected_access_token_sha256",
        )
            .into_response();
    }
    if payload.invalidate_rejected && rejected_access_token_sha256.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            "invalidate_rejected requires rejected_access_token_sha256",
        )
            .into_response();
    }

    let token = match state.auth.authenticate_headers(&headers) {
        Ok(token) => token,
        Err(rejection) => {
            state
                .auth
                .log_rejection(rejection, AuthMethodBucket::Post, AuthEndpoint::OAuthSecret);
            return bridge_auth_failure_response(
                rejection,
                "Host MCP Bridge requires a bearer token",
            );
        }
    };
    let scope = oauth_access_token_scope(server_id);
    if !token.has_scope(&scope) {
        return (
            StatusCode::FORBIDDEN,
            "bridge token is not scoped for this OAuth server",
        )
            .into_response();
    }

    let Some(url) = state.electron_broker_url.as_deref() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "Electron OAuth broker is not configured",
        )
            .into_response();
    };

    let refresh_lock = oauth_refresh_lock(&state, server_id).await;
    let _refresh_guard = refresh_lock.lock().await;
    let mut request = state
        .http
        .post(url)
        .json(&json!({ "server_id": server_id }));
    if let Some(token) = state.electron_broker_token.as_deref() {
        request = request.bearer_auth(token);
    }

    match request.send().await {
        Ok(response) => {
            let status = response.status();
            let body = response.text().await.unwrap_or_else(|_| "{}".to_string());
            if !status.is_success() {
                if matches!(
                    status,
                    StatusCode::NOT_FOUND
                        | StatusCode::PRECONDITION_REQUIRED
                        | StatusCode::SERVICE_UNAVAILABLE
                ) {
                    let message = serde_json::from_str::<Value>(&body)
                        .ok()
                        .and_then(|value| {
                            value
                                .get("error")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                                .or_else(|| {
                                    value
                                        .get("message")
                                        .and_then(Value::as_str)
                                        .map(str::to_string)
                                })
                        })
                        .unwrap_or_else(|| "secure OAuth record is unavailable".to_string());
                    return oauth_access_token_auth_required_response(server_id, message);
                }
                return (status, [(header::CONTENT_TYPE, "application/json")], body)
                    .into_response();
            }

            let record = match serde_json::from_str::<ElectronOAuthRecordResponse>(&body) {
                Ok(record) => record,
                Err(_) => {
                    return (
                        StatusCode::BAD_GATEWAY,
                        "Electron OAuth broker returned an invalid record",
                    )
                        .into_response();
                }
            };
            if record
                .server_id
                .as_deref()
                .is_some_and(|record_server_id| record_server_id != server_id)
            {
                return (
                    StatusCode::BAD_GATEWAY,
                    "Electron OAuth broker returned a mismatched server_id",
                )
                    .into_response();
            }

            if payload.invalidate_rejected {
                let rejected = rejected_access_token_sha256
                    .as_deref()
                    .expect("validated rejected token hash");
                let current = oauth_access_token_sha256(record.token.access_token.trim());
                if current.eq_ignore_ascii_case(rejected) {
                    if let Err(error) = invalidate_electron_oauth_record(
                        &state,
                        server_id,
                        "oauth_persistent_downstream_unauthorized",
                    )
                    .await
                    {
                        warn!(
                            "[{server_id}] failed to invalidate persistently rejected OAuth record: {error:#}"
                        );
                        return (
                            StatusCode::BAD_GATEWAY,
                            "failed to invalidate persistently rejected OAuth record",
                        )
                            .into_response();
                    }
                    return oauth_access_token_auth_required_response(
                        server_id,
                        "OAuth authorization required",
                    );
                }
                info!(
                    "[{server_id}] preserved newer secure OAuth record while invalidating an older rejected token"
                );
            }

            let force_refresh = if payload.invalidate_rejected {
                false
            } else if payload.force_refresh {
                rejected_access_token_sha256.as_deref().is_none_or(|rejected| {
                    let current = oauth_access_token_sha256(record.token.access_token.trim());
                    if current.eq_ignore_ascii_case(rejected) {
                        true
                    } else {
                        info!(
                            "[{server_id}] coalesced OAuth refresh because secure storage already contains a newer access token"
                        );
                        false
                    }
                })
            } else {
                false
            };

            let outcome =
                match vend_oauth_access_token_from_record(server_id, record, force_refresh).await {
                    Ok(outcome) => outcome,
                    Err(error) => {
                        warn!("[{server_id}] OAuth access-token vending failed: {error:#}");
                        return (StatusCode::BAD_GATEWAY, "OAuth access-token vending failed")
                            .into_response();
                    }
                };
            let result = match outcome {
                OAuthAccessTokenVendOutcome::Token(result) => result,
                OAuthAccessTokenVendOutcome::AuthorizationRequired { error_class } => {
                    if let Err(error) =
                        invalidate_electron_oauth_record(&state, server_id, error_class).await
                    {
                        warn!(
                            "[{server_id}] failed to invalidate terminal OAuth broker record: {error:#}"
                        );
                        return (
                            StatusCode::BAD_GATEWAY,
                            "failed to invalidate terminal OAuth record",
                        )
                            .into_response();
                    }
                    return oauth_access_token_auth_required_response(
                        server_id,
                        "OAuth authorization required",
                    );
                }
            };
            if result.record_changed {
                if let Err(error) = persist_electron_oauth_record(&state, server_id, &result).await
                {
                    warn!("[{server_id}] failed to persist updated OAuth broker record: {error:#}");
                    return (
                        StatusCode::BAD_GATEWAY,
                        "failed to persist updated OAuth record",
                    )
                        .into_response();
                }
            }

            let response = json!({
                "server_id": server_id,
                "access_token": result.access_token,
                "token_type": result.token.token_type.as_deref().unwrap_or("Bearer"),
                "expires_in": result.token.expires_in,
                "expires_at": result.token.extra.get("expires_at").cloned().unwrap_or(Value::Null),
            });
            (StatusCode::OK, Json(response)).into_response()
        }
        Err(_) => (
            StatusCode::BAD_GATEWAY,
            "Electron OAuth broker request failed",
        )
            .into_response(),
    }
}

async fn vend_static_secret(
    State(state): State<SecretBrokerState>,
    headers: HeaderMap,
    Json(payload): Json<StaticSecretRequest>,
) -> Response {
    let server_id = payload.server_id.trim();
    let secret_name = payload.secret_name.trim();
    if !valid_scoped_server_id(server_id) {
        return (StatusCode::BAD_REQUEST, "invalid server_id").into_response();
    }
    if !valid_scoped_secret_name(secret_name) {
        return (StatusCode::BAD_REQUEST, "invalid secret_name").into_response();
    }

    let token = match state.auth.authenticate_headers(&headers) {
        Ok(token) => token,
        Err(rejection) => {
            state.auth.log_rejection(
                rejection,
                AuthMethodBucket::Post,
                AuthEndpoint::StaticSecret,
            );
            return bridge_auth_failure_response(
                rejection,
                "Host MCP Bridge requires a bearer token",
            );
        }
    };
    let scope = static_secret_scope(server_id, secret_name);
    if !token.has_scope(&scope) {
        return (
            StatusCode::FORBIDDEN,
            "bridge token is not scoped for this static secret",
        )
            .into_response();
    }

    let Some(url) = state.electron_static_secret_broker_url.as_deref() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "Electron static secret broker is not configured",
        )
            .into_response();
    };

    let mut request = state
        .http
        .post(url)
        .json(&json!({ "server_id": server_id, "secret_name": secret_name }));
    if let Some(token) = state.electron_broker_token.as_deref() {
        request = request.bearer_auth(token);
    }

    match request.send().await {
        Ok(response) => {
            let status = response.status();
            let body = response.text().await.unwrap_or_else(|_| "{}".to_string());
            if !status.is_success() {
                return (status, [(header::CONTENT_TYPE, "application/json")], body)
                    .into_response();
            }

            let record = match serde_json::from_str::<ElectronStaticSecretResponse>(&body) {
                Ok(record) => record,
                Err(_) => {
                    return (
                        StatusCode::BAD_GATEWAY,
                        "Electron static secret broker returned an invalid record",
                    )
                        .into_response();
                }
            };
            if record
                .server_id
                .as_deref()
                .is_some_and(|record_server_id| record_server_id != server_id)
            {
                return (
                    StatusCode::BAD_GATEWAY,
                    "Electron static secret broker returned a mismatched server_id",
                )
                    .into_response();
            }
            if record
                .secret_name
                .as_deref()
                .is_some_and(|record_secret_name| record_secret_name != secret_name)
            {
                return (
                    StatusCode::BAD_GATEWAY,
                    "Electron static secret broker returned a mismatched secret_name",
                )
                    .into_response();
            }
            if record.value_base64.trim().is_empty() {
                return (
                    StatusCode::BAD_GATEWAY,
                    "Electron static secret broker returned an empty secret",
                )
                    .into_response();
            }

            let response = json!({
                "server_id": server_id,
                "secret_name": secret_name,
                "value_base64": record.value_base64,
            });
            (StatusCode::OK, Json(response)).into_response()
        }
        Err(_) => (
            StatusCode::BAD_GATEWAY,
            "Electron static secret broker request failed",
        )
            .into_response(),
    }
}

async fn vend_oauth_access_token_from_record(
    server_id: &str,
    record: ElectronOAuthRecordResponse,
    force_refresh: bool,
) -> Result<OAuthAccessTokenVendOutcome> {
    let server_config = server_config_with_memory_oauth(record.server_config)?;
    let coordinator = Arc::new(OAuthCoordinator::new());
    let binding = OAuthBinding::new(server_id, &server_config, coordinator).await?;
    if binding
        .configured_non_dcr_client_id()
        .await?
        .is_some_and(|configured_client_id| {
            configured_client_id.trim() != record.client_info.client_id.trim()
        })
    {
        warn!(
            "[{server_id}] stored OAuth client identity no longer matches the fixed non-DCR client"
        );
        return Ok(OAuthAccessTokenVendOutcome::AuthorizationRequired {
            error_class: "oauth_client_identity_mismatch",
        });
    }
    binding.seed_oauth_record(&record.token, &record.client_info)?;
    let should_refresh = force_refresh || binding.oauth_record_requires_refresh().await?;
    let mut record_changed = false;
    if should_refresh {
        match binding.refresh_secure_oauth_record().await? {
            OAuthSecureRecordRefreshOutcome::Refreshed => {
                record_changed = true;
            }
            OAuthSecureRecordRefreshOutcome::AuthorizationRequired => {
                return Ok(OAuthAccessTokenVendOutcome::AuthorizationRequired {
                    error_class: "oauth_terminal_refresh_failure",
                });
            }
        }
    }
    let access_token = binding
        .access_token()
        .await?
        .ok_or_else(|| anyhow!("OAuth access token is unavailable"))?;
    let Some((mut token, client_info)) = binding.export_oauth_record()? else {
        return Err(anyhow!(
            "OAuth refresh engine did not return an updated record"
        ));
    };
    ensure_token_expires_at(&mut token);
    Ok(OAuthAccessTokenVendOutcome::Token(
        OAuthAccessTokenVendResult {
            access_token,
            token,
            client_info,
            record_changed,
        },
    ))
}

fn server_config_with_memory_oauth(mut config: ServerConfig) -> Result<ServerConfig> {
    let Some(oauth) = config.oauth.as_mut() else {
        return Err(anyhow!("server config is missing OAuth metadata"));
    };
    let Some(object) = oauth.as_object_mut() else {
        return Err(anyhow!("server OAuth metadata must be an object"));
    };
    object.insert(
        "storage_type".to_string(),
        Value::String("memory".to_string()),
    );
    let has_resource = object
        .get("resource")
        .and_then(Value::as_str)
        .is_some_and(|resource| !resource.trim().is_empty());
    if !has_resource && !object.contains_key("infer_resource_from_url") {
        object.insert("infer_resource_from_url".to_string(), Value::Bool(true));
    }
    Ok(config)
}

fn ensure_token_expires_at(token: &mut CompatTokenFile) {
    if token.extra.contains_key("expires_at") {
        return;
    }
    let Some(expires_in) = token.expires_in else {
        return;
    };
    let Ok(now) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) else {
        return;
    };
    let expires_at = now.as_secs() as i64 + expires_in;
    token
        .extra
        .insert("expires_at".to_string(), Value::Number(expires_at.into()));
}

async fn persist_electron_oauth_record(
    state: &SecretBrokerState,
    server_id: &str,
    result: &OAuthAccessTokenVendResult,
) -> Result<()> {
    let Some(update_url) = state.electron_broker_update_url.as_deref() else {
        return Err(anyhow!(
            "Electron OAuth broker update URL is not configured"
        ));
    };
    let mut request = state
        .http
        .post(update_url)
        .json(&ElectronOAuthRecordUpdate {
            server_id,
            token: &result.token,
            client_info: &result.client_info,
        });
    if let Some(token) = state.electron_broker_token.as_deref() {
        request = request.bearer_auth(token);
    }
    let response = request
        .send()
        .await
        .context("Electron update request failed")?;
    if response.status().is_success() {
        return Ok(());
    }
    Err(anyhow!(
        "Electron OAuth broker update failed with HTTP {}",
        response.status()
    ))
}

async fn invalidate_electron_oauth_record(
    state: &SecretBrokerState,
    server_id: &str,
    error_class: &str,
) -> Result<()> {
    let Some(invalidate_url) = state.electron_broker_invalidate_url.as_deref() else {
        return Err(anyhow!(
            "Electron OAuth broker invalidation URL is not configured"
        ));
    };
    let mut request = state
        .http
        .post(invalidate_url)
        .json(&ElectronOAuthRecordInvalidate {
            server_id,
            error_class,
        });
    if let Some(token) = state.electron_broker_token.as_deref() {
        request = request.bearer_auth(token);
    }
    let response = request
        .send()
        .await
        .context("Electron invalidation request failed")?;
    if response.status().is_success() {
        return Ok(());
    }
    Err(anyhow!(
        "Electron OAuth broker invalidation failed with HTTP {}",
        response.status()
    ))
}

#[derive(Debug, Clone)]
struct SourceEndpoint {
    name: &'static str,
    base_url: String,
}

#[derive(Debug, Clone)]
struct BridgeTool {
    bridge_name: String,
    source_name: String,
    base_url: String,
    server_id: String,
    route_name: String,
    display_name: Option<String>,
    description: Option<String>,
    input_schema: Value,
}

impl BridgeTool {
    fn searchable_text(&self) -> String {
        [
            self.bridge_name.as_str(),
            self.server_id.as_str(),
            self.route_name.as_str(),
            self.display_name.as_deref().unwrap_or_default(),
            self.description.as_deref().unwrap_or_default(),
        ]
        .join(" ")
        .to_lowercase()
    }

    fn as_summary(&self) -> Value {
        json!({
            "name": self.bridge_name,
            "server_id": self.server_id,
            "route_name": self.route_name,
            "source": self.source_name,
            "display_name": self.display_name,
            "description": self.description,
            "input_schema": self.input_schema,
        })
    }

    fn as_mcp_tool(&self) -> Tool {
        let mut tool = Tool::new_with_raw(
            self.bridge_name.clone(),
            self.description.clone().map(Into::into),
            schema_object(self.input_schema.clone()),
        );
        if let Some(title) = self.display_name.clone() {
            tool = tool.with_title(title);
        }
        tool
    }
}

// Tool invocations may legitimately run for minutes: Slack unread scans
// measured 56s, and reads queued behind a background directory sync ran
// 4m09s during the PORTICO-273 incident testing. The nginx layer beneath allows
// 3660s. Worse, a bridge-side timeout ABANDONS a request the downstream
// server keeps executing, so premature 20s failures multiplied server load.
// Discovery calls keep the short client-level timeout.
const BRIDGE_TOOL_INVOKE_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug, Clone)]
struct BridgeClient {
    http: reqwest::Client,
    sources: Vec<SourceEndpoint>,
}

impl BridgeClient {
    fn new(args: &BridgeArgs) -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
            sources: vec![
                SourceEndpoint {
                    name: "core",
                    base_url: trim_url(&args.core_url),
                },
                SourceEndpoint {
                    name: "regular",
                    base_url: trim_url(&args.regular_url),
                },
                SourceEndpoint {
                    name: "host",
                    base_url: trim_url(&args.host_url),
                },
            ],
        }
    }

    async fn discover_tools(&self) -> Vec<BridgeTool> {
        let mut discovered = Vec::new();
        for source in &self.sources {
            match self.discover_source_tools(source).await {
                Ok(mut tools) => discovered.append(&mut tools),
                Err(error) => warn!(
                    "Host MCP bridge could not discover {} tools from {}: {error:#}",
                    source.name, source.base_url
                ),
            }
        }
        assign_bridge_names(discovered)
    }

    async fn discover_source_tools(&self, source: &SourceEndpoint) -> Result<Vec<BridgeTool>> {
        let mut server_ids = self
            .fetch_servers(&source.base_url)
            .await
            .unwrap_or_default();
        if server_ids.is_empty() {
            server_ids = self
                .fetch_servers_from_root_openapi(&source.base_url)
                .await?;
        }

        let mut tools = Vec::new();
        for server_id in server_ids {
            match self
                .fetch_server_openapi(&source.base_url, &server_id)
                .await
            {
                Ok(spec) => {
                    tools.extend(parse_server_openapi(source, &server_id, &spec));
                }
                Err(error) => warn!(
                    "Host MCP bridge could not fetch OpenAPI for {}:{}: {error:#}",
                    source.name, server_id
                ),
            }
        }
        Ok(tools)
    }

    async fn fetch_servers(&self, base_url: &str) -> Result<Vec<String>> {
        let payload = self.get_json(&format!("{base_url}/servers")).await?;
        let Some(servers) = payload.get("servers").and_then(Value::as_array) else {
            return Ok(Vec::new());
        };

        let mut ids = Vec::new();
        for server in servers {
            if let Some(id) = server.as_str() {
                ids.push(id.to_string());
            } else if let Some(id) = server.get("id").and_then(Value::as_str) {
                ids.push(id.to_string());
            } else if let Some(id) = server.get("server_id").and_then(Value::as_str) {
                ids.push(id.to_string());
            }
        }
        ids.sort();
        ids.dedup();
        Ok(ids)
    }

    async fn fetch_servers_from_root_openapi(&self, base_url: &str) -> Result<Vec<String>> {
        let payload = self.get_json(&format!("{base_url}/openapi.json")).await?;
        let mut ids = HashSet::new();
        if let Some(description) = payload
            .get("info")
            .and_then(|info| info.get("description"))
            .and_then(Value::as_str)
        {
            ids.extend(parse_server_ids_from_description(description));
        }

        if let Some(paths) = payload.get("paths").and_then(Value::as_object) {
            for path in paths.keys() {
                if let Some((server_id, _route_name)) = split_root_path(path) {
                    if !server_id.starts_with("oauth") && server_id != "servers" {
                        ids.insert(server_id.to_string());
                    }
                }
            }
        }

        let mut ids: Vec<String> = ids.into_iter().collect();
        ids.sort();
        Ok(ids)
    }

    async fn fetch_server_openapi(&self, base_url: &str, server_id: &str) -> Result<Value> {
        self.get_json(&format!("{base_url}/{server_id}/openapi.json"))
            .await
    }

    async fn call_bridge_tool(&self, tool_name: &str, arguments: Map<String, Value>) -> Value {
        let tools = self.discover_tools().await;
        let Some(tool) = tools
            .iter()
            .find(|candidate| candidate.bridge_name == tool_name)
        else {
            return json!({
                "success": false,
                "error": format!("unknown bridge tool: {tool_name}"),
                "tool_name": tool_name,
            });
        };

        let url = format!("{}/{}/{}", tool.base_url, tool.server_id, tool.route_name);
        match self
            .http
            .post(&url)
            .timeout(BRIDGE_TOOL_INVOKE_TIMEOUT)
            .json(&arguments)
            .send()
            .await
        {
            Ok(response) => {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                let parsed = serde_json::from_str::<Value>(&body)
                    .unwrap_or_else(|_| Value::String(body.clone()));
                if status.is_success() {
                    json!({
                        "success": true,
                        "tool_name": tool.bridge_name,
                        "server_id": tool.server_id,
                        "source": tool.source_name,
                        "result": parsed,
                    })
                } else {
                    json!({
                        "success": false,
                        "tool_name": tool.bridge_name,
                        "server_id": tool.server_id,
                        "source": tool.source_name,
                        "status": status.as_u16(),
                        "error": parsed,
                    })
                }
            }
            Err(error) => json!({
                "success": false,
                "tool_name": tool.bridge_name,
                "server_id": tool.server_id,
                "source": tool.source_name,
                "error": error.to_string(),
            }),
        }
    }

    async fn get_json(&self, url: &str) -> Result<Value> {
        let response = self
            .http
            .get(url)
            .send()
            .await
            .with_context(|| format!("GET {url} failed"))?;
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(anyhow!("GET {url} returned HTTP {status}: {body}"));
        }
        serde_json::from_str(&body).with_context(|| format!("GET {url} did not return JSON"))
    }
}

#[derive(Debug, Clone)]
struct BridgeServer {
    client: Arc<BridgeClient>,
    expose_all_tools: bool,
    telemetry: BridgeTelemetry,
}

impl BridgeServer {
    #[cfg(test)]
    fn new(args: &BridgeArgs) -> Self {
        Self::with_telemetry(args, BridgeTelemetry::disabled())
    }

    fn with_telemetry(args: &BridgeArgs, telemetry: BridgeTelemetry) -> Self {
        Self {
            client: Arc::new(BridgeClient::new(args)),
            expose_all_tools: args.expose_all_tools,
            telemetry,
        }
    }

    fn meta_tools(&self) -> Vec<Tool> {
        vec![
            find_relevant_tools_spec(),
            call_bridge_tool_spec(),
            find_relevant_skills_spec(),
            load_skills_spec(),
            load_skill_resource_spec(),
        ]
    }

    async fn list_tools_impl(&self) -> ListToolsResult {
        if self.expose_all_tools {
            let mut tools = self.meta_tools();
            tools.extend(
                self.client
                    .discover_tools()
                    .await
                    .into_iter()
                    .map(|tool| tool.as_mcp_tool()),
            );
            ListToolsResult::with_all_items(tools)
        } else {
            ListToolsResult::with_all_items(self.meta_tools())
        }
    }

    async fn call_tool_impl(
        &self,
        request: CallToolRequestParams,
        client_id: &str,
    ) -> Result<CallToolResult, ErrorData> {
        let tool_name = request.name.to_string();
        let arguments = request.arguments.unwrap_or_default();
        let started = Instant::now();
        let mut server_id = "bridge".to_string();
        let mut telemetry_tool = tool_name.clone();
        let mut surface = "meta";
        let dispatch = match tool_name.as_str() {
            FIND_RELEVANT_TOOLS => Ok(CallToolResult::structured(
                self.find_relevant_tools(arguments).await,
            )),
            CALL_BRIDGE_TOOL => {
                let payload = self.call_named_bridge_tool(arguments).await;
                server_id = payload
                    .get("server_id")
                    .and_then(Value::as_str)
                    .unwrap_or("bridge")
                    .to_string();
                telemetry_tool = payload
                    .get("tool_name")
                    .and_then(Value::as_str)
                    .unwrap_or(CALL_BRIDGE_TOOL)
                    .to_string();
                Ok(result_from_bridge_payload(payload))
            }
            FIND_RELEVANT_SKILLS => self.find_relevant_skills(arguments).await,
            LOAD_SKILLS => self.load_skills(arguments).await,
            LOAD_SKILL_RESOURCE => self.load_skill_resource(arguments).await,
            exposed_tool if self.expose_all_tools => {
                surface = "expose_all";
                let payload = self.client.call_bridge_tool(exposed_tool, arguments).await;
                server_id = payload
                    .get("server_id")
                    .and_then(Value::as_str)
                    .unwrap_or("bridge")
                    .to_string();
                Ok(result_from_bridge_payload(payload))
            }
            other => Err(ErrorData::invalid_params(
                format!("unknown Host MCP bridge tool: {other}"),
                None,
            )),
        };

        let outcome = match &dispatch {
            Err(_) => "failed",
            Ok(result) if result.is_error == Some(true) => "failed",
            Ok(_) => "success",
        };
        let error_category = if outcome == "success" {
            "none"
        } else {
            bridge_tool_error_category(&tool_name, &dispatch)
        };
        self.telemetry.emit_tool_call(BridgeToolCallEvent {
            client_id: client_id.to_string(),
            server_id,
            tool: telemetry_tool,
            surface,
            outcome,
            error_category,
            elapsed_ms: started.elapsed().as_millis(),
        });
        dispatch
    }

    async fn find_relevant_tools(&self, arguments: Map<String, Value>) -> Value {
        let query = arguments
            .get("query")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        let limit = arguments
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(20)
            .clamp(1, 100) as usize;
        let tools = self.client.discover_tools().await;
        let mut scored: Vec<(u32, BridgeTool)> = tools
            .into_iter()
            .map(|tool| (score_tool(&tool, &query), tool))
            .filter(|(score, _)| query.is_empty() || *score > 0)
            .collect();
        scored.sort_by(|left, right| {
            right
                .0
                .cmp(&left.0)
                .then_with(|| left.1.bridge_name.cmp(&right.1.bridge_name))
        });

        let items: Vec<Value> = scored
            .into_iter()
            .take(limit)
            .map(|(score, tool)| {
                let mut summary = tool.as_summary();
                if let Some(object) = summary.as_object_mut() {
                    object.insert("score".to_string(), json!(score));
                }
                summary
            })
            .collect();

        json!({
            "query": query,
            "tools": items,
            "count": items.len(),
        })
    }

    async fn find_relevant_skills(
        &self,
        arguments: Map<String, Value>,
    ) -> Result<CallToolResult, ErrorData> {
        let query = required_trimmed_string(&arguments, "query")?;
        if query.chars().count() > MAX_SKILL_QUERY_CHARS {
            return Err(ErrorData::invalid_params(
                format!("query must not exceed {MAX_SKILL_QUERY_CHARS} characters"),
                None,
            ));
        }
        let limit = bounded_usize_argument(
            &arguments,
            "limit",
            DEFAULT_SKILL_SEARCH_LIMIT,
            1,
            MAX_SKILL_SEARCH_LIMIT,
        )?;
        let skills = match discover_skills() {
            Ok(skills) => skills,
            Err(_) => {
                warn!("Host MCP Bridge find_relevant_skills error_category=catalog_unavailable");
                return Ok(skill_tool_error(
                    "catalog_unavailable",
                    "Portico could not discover installed skills",
                    json!({}),
                ));
            }
        };
        let mut scored = skills
            .into_iter()
            .map(|skill| (score_skill(&skill, &query), skill))
            .filter(|(score, _)| *score > 0)
            .collect::<Vec<_>>();
        scored.sort_by(|left, right| {
            right
                .0
                .cmp(&left.0)
                .then_with(|| {
                    priority_rank(&left.1.priority).cmp(&priority_rank(&right.1.priority))
                })
                .then_with(|| left.1.name.cmp(&right.1.name))
        });
        let items = scored
            .into_iter()
            .take(limit)
            .map(|(score, skill)| skill_search_summary(&skill, score))
            .collect::<Vec<_>>();
        info!(
            "Host MCP Bridge find_relevant_skills result_count={}",
            items.len()
        );

        Ok(CallToolResult::structured(json!({
            "success": true,
            "query": query,
            "count": items.len(),
            "skills": items,
            "next_step": "Select only the best matching skill IDs and call load_skills before acting. An empty result means continue without a skill.",
        })))
    }

    async fn load_skills(
        &self,
        arguments: Map<String, Value>,
    ) -> Result<CallToolResult, ErrorData> {
        let skill_ids =
            required_unique_string_array(&arguments, "skill_ids", 1, MAX_SKILLS_PER_LOAD)?;
        let catalog = match discover_skills() {
            Ok(skills) => skills
                .into_iter()
                .map(|skill| (skill.name.clone(), skill))
                .collect::<HashMap<_, _>>(),
            Err(_) => {
                warn!("Host MCP Bridge load_skills error_category=catalog_unavailable");
                return Ok(skill_tool_error(
                    "catalog_unavailable",
                    "Portico could not discover installed skills",
                    json!({}),
                ));
            }
        };

        let mut loaded = Vec::new();
        let mut missing_skill_ids = Vec::new();
        let mut failed_skill_ids = Vec::new();
        let mut total_skill_bytes = 0usize;
        for skill_id in &skill_ids {
            let Some(skill) = catalog.get(skill_id) else {
                missing_skill_ids.push(skill_id.clone());
                continue;
            };
            let skill_md = match read_skill_markdown(skill) {
                Ok(content) => content,
                Err(_) => {
                    failed_skill_ids.push(json!({
                        "skill_id": skill_id,
                        "error": "skill_read_failed",
                    }));
                    continue;
                }
            };
            let skill_size = skill_md.len();
            if skill_size > MAX_SKILL_MARKDOWN_BYTES {
                failed_skill_ids.push(json!({
                    "skill_id": skill_id,
                    "error": "skill_size_limit_exceeded",
                    "actual_size_bytes": skill_size,
                    "limit_bytes": MAX_SKILL_MARKDOWN_BYTES,
                }));
                continue;
            }
            if total_skill_bytes.saturating_add(skill_size) > MAX_LOADED_SKILL_BYTES {
                failed_skill_ids.push(json!({
                    "skill_id": skill_id,
                    "error": "aggregate_size_limit_exceeded",
                    "actual_size_bytes": total_skill_bytes.saturating_add(skill_size),
                    "limit_bytes": MAX_LOADED_SKILL_BYTES,
                }));
                continue;
            }
            let resources = match list_skill_resources(skill) {
                Ok(resources) => resources,
                Err(_) => {
                    failed_skill_ids.push(json!({
                        "skill_id": skill_id,
                        "error": "resource_manifest_failed",
                    }));
                    continue;
                }
            };
            let resources_truncated = resources.len() > MAX_SKILL_RESOURCE_MANIFEST_ENTRIES;
            let resource_manifest = resources
                .into_iter()
                .take(MAX_SKILL_RESOURCE_MANIFEST_ENTRIES)
                .map(|resource| json!(resource))
                .collect::<Vec<_>>();
            total_skill_bytes += skill_size;
            loaded.push(json!({
                "skill_id": skill.name,
                "name": skill.declared_name,
                "display_name": skill.display_name,
                "description": skill.description,
                "source": skill.source,
                "version": skill.version,
                "license": skill.license,
                "compatibility": skill.compatibility,
                "priority": skill.priority,
                "triggers": skill.triggers,
                "author": skill.author,
                "required_mcp_servers": skill.required_mcp_servers,
                "skill_md": skill_md,
                "size_bytes": skill_size,
                "resources": resource_manifest,
                "resources_truncated": resources_truncated,
            }));
        }

        let success =
            !loaded.is_empty() && missing_skill_ids.is_empty() && failed_skill_ids.is_empty();
        let payload = json!({
            "success": success,
            "requested_skill_ids": skill_ids,
            "loaded_count": loaded.len(),
            "total_skill_bytes": total_skill_bytes,
            "skills": loaded,
            "missing_skill_ids": missing_skill_ids,
            "failed_skill_ids": failed_skill_ids,
            "next_step": LOAD_SKILLS_NEXT_STEP,
        });
        info!(
            "Host MCP Bridge load_skills result_count={} byte_size={} error_category={}",
            payload["loaded_count"].as_u64().unwrap_or_default(),
            total_skill_bytes,
            if success {
                "none"
            } else {
                "partial_or_missing"
            }
        );
        if payload["loaded_count"].as_u64().unwrap_or_default() == 0 {
            Ok(CallToolResult::structured_error(payload))
        } else {
            Ok(CallToolResult::structured(payload))
        }
    }

    async fn load_skill_resource(
        &self,
        arguments: Map<String, Value>,
    ) -> Result<CallToolResult, ErrorData> {
        let skill_id = required_trimmed_string(&arguments, "skill_id")?;
        let resource_path = required_trimmed_string(&arguments, "resource_path")?;
        let skill = match discover_skills() {
            Ok(skills) => skills.into_iter().find(|skill| skill.name == skill_id),
            Err(_) => {
                warn!("Host MCP Bridge load_skill_resource error_category=catalog_unavailable");
                return Ok(skill_tool_error(
                    "catalog_unavailable",
                    "Portico could not discover installed skills",
                    json!({ "skill_id": skill_id }),
                ));
            }
        };
        let Some(skill) = skill else {
            info!("Host MCP Bridge load_skill_resource error_category=skill_not_found");
            return Ok(skill_tool_error(
                "skill_not_found",
                "The requested installed skill was not found",
                json!({ "skill_id": skill_id }),
            ));
        };
        let resolved = match resolve_skill_resource_path(&skill, &resource_path) {
            Ok(path) => path,
            Err(SkillResourcePathError::Missing) => {
                info!(
                    "Host MCP Bridge load_skill_resource skill_id={} error_category=resource_not_found",
                    skill_id
                );
                return Ok(skill_tool_error(
                    "resource_not_found",
                    "The requested skill resource was not found",
                    json!({ "skill_id": skill_id }),
                ));
            }
            Err(SkillResourcePathError::Invalid) => {
                info!(
                    "Host MCP Bridge load_skill_resource skill_id={} error_category=invalid_resource_path",
                    skill_id
                );
                return Ok(skill_tool_error(
                    "invalid_resource_path",
                    "The requested skill resource path is not allowed",
                    json!({ "skill_id": skill_id }),
                ));
            }
        };
        let resource = match skill_resource_metadata(&resource_path, &resolved) {
            Ok(resource) => resource,
            Err(_) => {
                return Ok(skill_tool_error(
                    "resource_read_failed",
                    "The requested skill resource could not be inspected",
                    json!({ "skill_id": skill_id }),
                ));
            }
        };
        if resource.size_bytes > MAX_BINARY_SKILL_RESOURCE_BYTES {
            info!(
                "Host MCP Bridge load_skill_resource skill_id={} byte_size={} error_category=binary_size_limit_exceeded",
                skill_id, resource.size_bytes
            );
            return Ok(skill_tool_error(
                "binary_size_limit_exceeded",
                "The requested binary skill resource exceeds the bridge limit",
                json!({
                    "skill_id": skill_id,
                    "actual_size_bytes": resource.size_bytes,
                    "limit_bytes": MAX_BINARY_SKILL_RESOURCE_BYTES,
                }),
            ));
        }
        let bytes = match fs::read(&resolved) {
            Ok(bytes) => bytes,
            Err(_) => {
                return Ok(skill_tool_error(
                    "resource_read_failed",
                    "The requested skill resource could not be read",
                    json!({ "skill_id": skill_id }),
                ));
            }
        };
        let uri = skill_resource_uri(&skill_id, &resource_path);
        let base_payload = json!({
            "success": true,
            "skill_id": skill_id,
            "resource_path": resource_path,
            "kind": resource.kind,
            "mime_type": resource.mime_type,
            "size_bytes": resource.size_bytes,
            "uri": uri,
            "executed": false,
        });

        let result = if resource.mime_type.starts_with("image/") {
            let content =
                Content::image(BASE64_STANDARD.encode(&bytes), resource.mime_type.clone());
            skill_resource_media_result(base_payload, "image", content)
        } else if resource.mime_type.starts_with("audio/") {
            let content = RawContent::Audio(RawAudioContent {
                data: BASE64_STANDARD.encode(&bytes),
                mime_type: resource.mime_type.clone(),
            })
            .no_annotation();
            skill_resource_media_result(base_payload, "audio", content)
        } else if let Ok(text) = String::from_utf8(bytes.clone()) {
            if resource.size_bytes > MAX_TEXT_SKILL_RESOURCE_BYTES {
                info!(
                    "Host MCP Bridge load_skill_resource skill_id={} byte_size={} error_category=text_size_limit_exceeded",
                    skill_id, resource.size_bytes
                );
                return Ok(skill_tool_error(
                    "text_size_limit_exceeded",
                    "The requested text skill resource exceeds the bridge limit",
                    json!({
                        "skill_id": skill_id,
                        "actual_size_bytes": resource.size_bytes,
                        "limit_bytes": MAX_TEXT_SKILL_RESOURCE_BYTES,
                    }),
                ));
            }
            let mut payload = base_payload;
            if let Some(object) = payload.as_object_mut() {
                object.insert("content_type".to_string(), json!("text"));
                object.insert("text".to_string(), Value::String(text));
            }
            CallToolResult::structured(payload)
        } else {
            let contents = ResourceContents::blob(BASE64_STANDARD.encode(&bytes), uri)
                .with_mime_type(resource.mime_type.clone());
            skill_resource_media_result(base_payload, "blob", Content::resource(contents))
        };
        info!(
            "Host MCP Bridge load_skill_resource skill_id={} byte_size={} error_category=none",
            skill_id, resource.size_bytes
        );
        Ok(result)
    }

    async fn call_named_bridge_tool(&self, arguments: Map<String, Value>) -> Value {
        let Some(tool_name) = arguments.get("tool_name").and_then(Value::as_str) else {
            return json!({
                "success": false,
                "error": "call_bridge_tool requires string field 'tool_name'",
            });
        };
        let tool_args = match arguments.get("arguments") {
            Some(Value::Object(map)) => map.clone(),
            Some(Value::Null) | None => Map::new(),
            Some(other) => {
                return json!({
                    "success": false,
                    "tool_name": tool_name,
                    "error": format!("arguments must be a JSON object, got {}", json_type(other)),
                });
            }
        };
        self.client.call_bridge_tool(tool_name, tool_args).await
    }
}

impl ServerHandler for BridgeServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("portico-host-mcp-bridge", "0.1.0"))
            .with_instructions(BRIDGE_INSTRUCTIONS)
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(self.list_tools_impl().await)
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let client_id = client_id_from_context(&context);
        self.call_tool_impl(request, &client_id).await
    }
}

#[derive(Debug, Clone)]
struct RemoteBridgeServer {
    remote_url: String,
    auth_token_file: Option<PathBuf>,
}

impl RemoteBridgeServer {
    fn transport(
        &self,
    ) -> Result<StreamableHttpClientTransport<CompatibleReqwestStreamableHttpClient>> {
        let mut config = StreamableHttpClientTransportConfig::with_uri(self.remote_url.clone());
        if let Some(token_file) = &self.auth_token_file {
            let token = fs::read_to_string(token_file)
                .with_context(|| {
                    format!(
                        "read remote bridge auth token file {}",
                        token_file.display()
                    )
                })?
                .trim()
                .to_string();
            if !token.is_empty() {
                config = config.auth_header(token);
            }
        }
        Ok(StreamableHttpClientTransport::with_client(
            CompatibleReqwestStreamableHttpClient::new(reqwest::Client::new()),
            config,
        ))
    }

    async fn list_remote_tools(&self) -> Result<Vec<Tool>> {
        let transport = self.transport()?;
        let running = ().serve(transport).await.context("connect remote bridge")?;
        let peer = running.peer().clone();
        let result = peer
            .list_all_tools()
            .await
            .context("remote bridge tools/list failed");
        let _ = running.cancel().await;
        result
    }

    async fn call_remote_tool(&self, request: CallToolRequestParams) -> Result<CallToolResult> {
        let transport = self.transport()?;
        let running = ().serve(transport).await.context("connect remote bridge")?;
        let peer = running.peer().clone();
        let result = peer
            .call_tool(request)
            .await
            .map_err(|error| anyhow!("remote bridge tools/call failed: {error}"));
        let _ = running.cancel().await;
        result
    }
}

impl ServerHandler for RemoteBridgeServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("portico-host-mcp-bridge-proxy", "0.1.0"))
            .with_instructions(BRIDGE_INSTRUCTIONS)
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        self.list_remote_tools()
            .await
            .map(ListToolsResult::with_all_items)
            .map_err(internal_error)
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.call_remote_tool(request).await.map_err(internal_error)
    }
}

pub async fn run(args: &BridgeArgs) -> Result<()> {
    if args.stdio_proxy {
        return run_stdio_proxy(args).await;
    }

    let telemetry = BridgeTelemetry::from_env();
    let service: StreamableHttpService<BridgeServer, LocalSessionManager> =
        StreamableHttpService::new(
            {
                let args = args.clone();
                move || Ok(BridgeServer::with_telemetry(&args, telemetry.clone()))
            },
            Arc::new(LocalSessionManager::default()),
            StreamableHttpServerConfig {
                stateful_mode: true,
                ..Default::default()
            },
        );
    let bridge_auth = BridgeAuth::new(args.auth_registry_path.clone());
    let mcp_router = Router::new()
        .nest_service(args.mcp_path.as_str(), service)
        .route_layer(middleware::from_fn_with_state(
            bridge_auth.clone(),
            require_bridge_auth,
        ));
    let secret_broker_state = SecretBrokerState {
        auth: bridge_auth,
        electron_bridge_status_url: std::env::var("HOST_MCP_BRIDGE_ELECTRON_STATUS_URL")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| Some(DEFAULT_ELECTRON_BRIDGE_STATUS_URL.to_string())),
        electron_broker_url: std::env::var("HOST_MCP_BRIDGE_ELECTRON_OAUTH_BROKER_URL")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        electron_broker_update_url: std::env::var("HOST_MCP_BRIDGE_ELECTRON_OAUTH_UPDATE_URL")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        electron_broker_invalidate_url: std::env::var(
            "HOST_MCP_BRIDGE_ELECTRON_OAUTH_INVALIDATE_URL",
        )
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty()),
        electron_static_secret_broker_url: std::env::var(
            "HOST_MCP_BRIDGE_ELECTRON_STATIC_SECRET_BROKER_URL",
        )
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty()),
        electron_broker_token: std::env::var("HOST_MCP_BRIDGE_ELECTRON_BROKER_TOKEN")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        oauth_refresh_locks: new_oauth_refresh_locks(),
        http: reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new()),
    };
    let app = Router::new()
        .route("/health", get(health))
        .route(
            "/.well-known/oauth-protected-resource/mcp",
            get(oauth_not_supported),
        )
        .route(
            "/.well-known/oauth-protected-resource",
            get(oauth_not_supported),
        )
        .route(
            "/.well-known/oauth-authorization-server",
            get(oauth_not_supported),
        )
        .route(
            "/bridge/status",
            get(bridge_status).with_state(secret_broker_state.clone()),
        )
        .route(
            "/secrets/oauth/access-token",
            post(vend_oauth_access_token).with_state(secret_broker_state.clone()),
        )
        .route(
            "/secrets/static-secret",
            post(vend_static_secret).with_state(secret_broker_state),
        )
        .merge(mcp_router);
    let addr: SocketAddr = format!("{}:{}", args.host, args.port)
        .parse()
        .with_context(|| format!("invalid bridge bind address {}:{}", args.host, args.port))?;
    let listener = TcpListener::bind(addr)
        .await
        .with_context(|| format!("failed to bind Host MCP bridge on {addr}"))?;
    info!(
        "Starting Host MCP bridge on http://{}{} (auth registry: {})",
        addr,
        args.mcp_path,
        args.auth_registry_path
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "<missing>".to_string())
    );
    axum::serve(listener, app)
        .await
        .context("Host MCP bridge server failed")
}

async fn run_stdio_proxy(args: &BridgeArgs) -> Result<()> {
    let service = RemoteBridgeServer {
        remote_url: args.remote_url.clone(),
        auth_token_file: args.remote_auth_token_file.clone(),
    }
    .serve(stdio())
    .await
    .context("failed to serve Host MCP bridge stdio proxy")?;
    service
        .waiting()
        .await
        .context("Host MCP bridge stdio proxy join failed")?;
    Ok(())
}

async fn health() -> impl IntoResponse {
    (StatusCode::OK, "healthy")
}

fn parse_server_openapi(source: &SourceEndpoint, server_id: &str, spec: &Value) -> Vec<BridgeTool> {
    let Some(paths) = spec.get("paths").and_then(Value::as_object) else {
        return Vec::new();
    };

    let mut tools = Vec::new();
    for (path, path_item) in paths {
        let Some(post) = path_item.get("post").and_then(Value::as_object) else {
            continue;
        };
        let Some(route_name) = route_name_from_server_path(path) else {
            continue;
        };
        let description = post
            .get("description")
            .or_else(|| post.get("summary"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let display_name = post
            .get("summary")
            .and_then(Value::as_str)
            .map(str::to_string);
        let input_schema = post
            .get("requestBody")
            .and_then(|body| body.get("content"))
            .and_then(|content| content.get("application/json"))
            .and_then(|content| content.get("schema"))
            .cloned()
            .unwrap_or_else(empty_object_schema);

        tools.push(BridgeTool {
            bridge_name: String::new(),
            source_name: source.name.to_string(),
            base_url: source.base_url.clone(),
            server_id: server_id.to_string(),
            route_name: route_name.to_string(),
            display_name,
            description,
            input_schema,
        });
    }
    tools
}

fn route_name_from_server_path(path: &str) -> Option<&str> {
    let trimmed = path.trim_matches('/');
    if trimmed.is_empty()
        || trimmed == "health"
        || trimmed == "openapi.json"
        || trimmed == "docs"
        || trimmed.starts_with("oauth/")
        || trimmed.starts_with("servers")
    {
        return None;
    }
    trimmed.split('/').next_back()
}

fn split_root_path(path: &str) -> Option<(&str, &str)> {
    let trimmed = path.trim_matches('/');
    let (server, route) = trimmed.split_once('/')?;
    if server.is_empty() || route.is_empty() {
        None
    } else {
        Some((server, route))
    }
}

fn parse_server_ids_from_description(description: &str) -> Vec<String> {
    let mut ids = Vec::new();
    let mut rest = description;
    while let Some(start) = rest.find('[') {
        rest = &rest[start + 1..];
        let Some(end) = rest.find(']') else {
            break;
        };
        let candidate = rest[..end].trim();
        if !candidate.is_empty()
            && candidate
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        {
            ids.push(candidate.to_string());
        }
        rest = &rest[end + 1..];
    }
    ids.sort();
    ids.dedup();
    ids
}

fn assign_bridge_names(mut tools: Vec<BridgeTool>) -> Vec<BridgeTool> {
    let mut seen = HashMap::<String, usize>::new();
    for tool in &mut tools {
        let base = base_bridge_name(&tool.server_id, &tool.route_name);
        let count = seen.entry(base.clone()).or_insert(0);
        *count += 1;
        tool.bridge_name = if *count == 1 {
            base
        } else {
            bounded_tool_name(&format!("{base}_{}", *count))
        };
    }
    tools
}

fn base_bridge_name(server_id: &str, route_name: &str) -> String {
    let server = sanitize_identifier(server_id);
    let mut route = sanitize_identifier(route_name);
    for prefix in [
        format!("{server}_"),
        format!("{server}__"),
        format!("{}_", server.replace('_', "-")),
    ] {
        if let Some(stripped) = route.strip_prefix(&prefix) {
            route = stripped.to_string();
            break;
        }
    }
    bounded_tool_name(&format!("{server}__{route}"))
}

fn bounded_tool_name(value: &str) -> String {
    if value.len() <= MAX_TOOL_NAME_LEN {
        return value.to_string();
    }
    let digest = format!("{:x}", md5::compute(value));
    let hash = &digest[..6];
    let keep = MAX_TOOL_NAME_LEN.saturating_sub(hash.len() + 1);
    format!("{}_{}", &value[..keep], hash)
}

fn sanitize_identifier(value: &str) -> String {
    let mut output = String::new();
    let mut last_was_underscore = false;
    for ch in value.chars() {
        let next = if ch.is_ascii_alphanumeric() { ch } else { '_' };
        if next == '_' {
            if last_was_underscore {
                continue;
            }
            last_was_underscore = true;
        } else {
            last_was_underscore = false;
        }
        output.push(next.to_ascii_lowercase());
    }
    output.trim_matches('_').to_string()
}

fn score_tool(tool: &BridgeTool, query: &str) -> u32 {
    if query.trim().is_empty() {
        return 1;
    }
    let searchable = tool.searchable_text();
    query
        .to_lowercase()
        .split_whitespace()
        .map(|term| {
            if tool.bridge_name.contains(term) {
                10
            } else if tool.server_id.to_lowercase().contains(term) {
                6
            } else if searchable.contains(term) {
                3
            } else {
                0
            }
        })
        .sum()
}

fn required_trimmed_string(
    arguments: &Map<String, Value>,
    field: &str,
) -> Result<String, ErrorData> {
    let Some(value) = arguments.get(field) else {
        return Err(ErrorData::invalid_params(
            format!("{field} is required"),
            None,
        ));
    };
    let Some(value) = value.as_str() else {
        return Err(ErrorData::invalid_params(
            format!("{field} must be a string"),
            None,
        ));
    };
    let value = value.trim();
    if value.is_empty() {
        return Err(ErrorData::invalid_params(
            format!("{field} must not be empty"),
            None,
        ));
    }
    Ok(value.to_string())
}

fn bounded_usize_argument(
    arguments: &Map<String, Value>,
    field: &str,
    default: usize,
    minimum: usize,
    maximum: usize,
) -> Result<usize, ErrorData> {
    let Some(value) = arguments.get(field) else {
        return Ok(default);
    };
    let Some(value) = value.as_u64().and_then(|value| usize::try_from(value).ok()) else {
        return Err(ErrorData::invalid_params(
            format!("{field} must be an integer"),
            None,
        ));
    };
    if !(minimum..=maximum).contains(&value) {
        return Err(ErrorData::invalid_params(
            format!("{field} must be between {minimum} and {maximum}"),
            None,
        ));
    }
    Ok(value)
}

fn required_unique_string_array(
    arguments: &Map<String, Value>,
    field: &str,
    minimum: usize,
    maximum: usize,
) -> Result<Vec<String>, ErrorData> {
    let Some(values) = arguments.get(field).and_then(Value::as_array) else {
        return Err(ErrorData::invalid_params(
            format!("{field} must be an array of strings"),
            None,
        ));
    };
    if !(minimum..=maximum).contains(&values.len()) {
        return Err(ErrorData::invalid_params(
            format!("{field} must contain between {minimum} and {maximum} items"),
            None,
        ));
    }
    let mut result = Vec::with_capacity(values.len());
    let mut seen = HashSet::new();
    for value in values {
        let Some(value) = value.as_str() else {
            return Err(ErrorData::invalid_params(
                format!("{field} must contain only strings"),
                None,
            ));
        };
        let value = value.trim();
        if value.is_empty() {
            return Err(ErrorData::invalid_params(
                format!("{field} must not contain empty values"),
                None,
            ));
        }
        if !seen.insert(value.to_string()) {
            return Err(ErrorData::invalid_params(
                format!("{field} must contain unique values"),
                None,
            ));
        }
        result.push(value.to_string());
    }
    Ok(result)
}

fn normalize_skill_search_text(value: &str) -> String {
    let mut normalized = String::with_capacity(value.len());
    let mut pending_space = false;
    for character in value.chars().flat_map(char::to_lowercase) {
        if character.is_alphanumeric() {
            if pending_space && !normalized.is_empty() {
                normalized.push(' ');
            }
            normalized.push(character);
            pending_space = false;
        } else {
            pending_space = true;
        }
    }
    normalized
}

fn is_skill_search_stop_word(token: &str) -> bool {
    matches!(
        token,
        "a" | "an"
            | "and"
            | "for"
            | "from"
            | "help"
            | "how"
            | "i"
            | "in"
            | "need"
            | "of"
            | "on"
            | "please"
            | "the"
            | "to"
            | "use"
            | "want"
            | "with"
    )
}

fn score_skill(skill: &SkillMetadata, query: &str) -> u32 {
    let normalized_query = normalize_skill_search_text(query);
    let identifier_text = normalize_skill_search_text(&format!(
        "{} {} {}",
        skill.name,
        skill.declared_name,
        skill.display_name.as_deref().unwrap_or_default()
    ));
    let trigger_text = normalize_skill_search_text(&skill.triggers.join(" "));
    let description_text = normalize_skill_search_text(&skill.description);
    let exact_identifiers = [
        normalize_skill_search_text(&skill.name),
        normalize_skill_search_text(&skill.declared_name),
        normalize_skill_search_text(skill.display_name.as_deref().unwrap_or_default()),
    ];
    let mut score = if exact_identifiers
        .iter()
        .any(|identifier| !identifier.is_empty() && identifier == &normalized_query)
    {
        100
    } else {
        0
    };
    if !normalized_query.is_empty() {
        if identifier_text.contains(&normalized_query) {
            score += 40;
        }
        if trigger_text.contains(&normalized_query) {
            score += 25;
        }
        if description_text.contains(&normalized_query) {
            score += 10;
        }
    }
    let mut seen = HashSet::new();
    for token in normalized_query
        .split_whitespace()
        .filter(|token| !is_skill_search_stop_word(token))
    {
        if !seen.insert(token) {
            continue;
        }
        if identifier_text.contains(token) {
            score += 10;
        }
        if trigger_text.contains(token) {
            score += 8;
        }
        if description_text.contains(token) {
            score += 3;
        }
    }
    score
}

fn priority_rank(priority: &str) -> u8 {
    match priority.to_ascii_lowercase().as_str() {
        "high" => 0,
        "medium" => 1,
        "low" => 2,
        _ => 3,
    }
}

fn skill_search_summary(skill: &SkillMetadata, score: u32) -> Value {
    json!({
        "skill_id": skill.name,
        "name": skill.declared_name,
        "display_name": skill.display_name,
        "description": skill.description,
        "source": skill.source,
        "version": skill.version,
        "score": score,
    })
}

fn skill_resource_uri(skill_id: &str, resource_path: &str) -> String {
    let encode =
        |value: &str| url::form_urlencoded::byte_serialize(value.as_bytes()).collect::<String>();
    let path = resource_path
        .split('/')
        .map(encode)
        .collect::<Vec<_>>()
        .join("/");
    format!("portico-skill://resource/{}/{path}", encode(skill_id))
}

fn skill_tool_error(code: &str, message: &str, details: Value) -> CallToolResult {
    let mut payload = json!({
        "success": false,
        "error": {
            "code": code,
            "message": message,
        },
    });
    if let (Some(payload), Some(details)) = (payload.as_object_mut(), details.as_object()) {
        payload.extend(details.clone());
    }
    CallToolResult::structured_error(payload)
}

fn skill_resource_media_result(
    mut payload: Value,
    content_type: &str,
    content: Content,
) -> CallToolResult {
    if let Some(object) = payload.as_object_mut() {
        object.insert("content_type".to_string(), json!(content_type));
    }
    let mut result = CallToolResult::success(vec![Content::text(payload.to_string()), content]);
    result.structured_content = Some(payload);
    result
}

fn read_only_annotations(title: &str) -> ToolAnnotations {
    ToolAnnotations::with_title(title)
        .read_only(true)
        .destructive(false)
        .idempotent(true)
        .open_world(false)
}

fn find_relevant_tools_spec() -> Tool {
    Tool::new(
        FIND_RELEVANT_TOOLS,
        "Search executable Portico MCP capabilities and return exact bridge tool names. For reusable workflow instructions or domain guidance, use find_relevant_skills instead.",
        schema_object(json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Natural-language description of the capability you need."
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 100,
                    "default": 20
                }
            },
            "required": ["query"]
        })),
    )
    .with_title("Find Relevant Tools")
    .with_raw_output_schema(schema_object(json!({
        "type": "object",
        "properties": {
            "query": {"type": "string"},
            "tools": {"type": "array", "items": {"type": "object"}},
            "count": {"type": "integer", "minimum": 0}
        },
        "required": ["query", "tools", "count"]
    })))
    .with_annotations(read_only_annotations("Find Relevant Tools"))
}

fn call_bridge_tool_spec() -> Tool {
    Tool::new(
        CALL_BRIDGE_TOOL,
        "Call an exact tool name returned by find_relevant_tools using its documented JSON arguments. This generic wrapper may read, mutate, or delete data in external systems depending on the selected tool.",
        schema_object(json!({
            "type": "object",
            "properties": {
                "tool_name": {
                    "type": "string",
                    "description": "Bridge tool name returned by find_relevant_tools."
                },
                "arguments": {
                    "type": "object",
                    "description": "JSON arguments for the target MCP tool.",
                    "additionalProperties": true
                }
            },
            "required": ["tool_name"]
        })),
    )
    .with_title("Call Bridge Tool")
    .with_annotations(
        ToolAnnotations::with_title("Call Bridge Tool")
            .read_only(false)
            .destructive(true)
            .idempotent(false)
            .open_world(true),
    )
}

fn find_relevant_skills_spec() -> Tool {
    Tool::new(
        FIND_RELEVANT_SKILLS,
        "Search metadata for Agent Skills installed in Portico. Call this with the user's goal when specialized workflow or domain guidance may help. Results are not loaded; pass only selected skill_id values to load_skills before acting.",
        schema_object(json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": MAX_SKILL_QUERY_CHARS,
                    "description": "Natural-language description of the user's goal."
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_SKILL_SEARCH_LIMIT,
                    "default": DEFAULT_SKILL_SEARCH_LIMIT
                }
            },
            "required": ["query"],
            "additionalProperties": false
        })),
    )
    .with_title("Find Relevant Skills")
    .with_raw_output_schema(schema_object(json!({
        "type": "object",
        "properties": {
            "success": {"type": "boolean"},
            "query": {"type": "string"},
            "count": {"type": "integer", "minimum": 0},
            "skills": {"type": "array", "items": {"type": "object"}},
            "next_step": {"type": "string"},
            "error": {"type": "object"}
        },
        "required": ["success"]
    })))
    .with_annotations(read_only_annotations("Find Relevant Skills"))
}

fn load_skills_spec() -> Tool {
    Tool::new(
        LOAD_SKILLS,
        "Load the exact SKILL.md instructions for one to three selected Portico skill IDs. Load only relevant matches from find_relevant_skills. Supporting files remain remote; fetch only needed manifest paths with load_skill_resource.",
        schema_object(json!({
            "type": "object",
            "properties": {
                "skill_ids": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": MAX_SKILLS_PER_LOAD,
                    "uniqueItems": true,
                    "items": {"type": "string", "minLength": 1},
                    "description": "Canonical skill_id values returned by find_relevant_skills."
                }
            },
            "required": ["skill_ids"],
            "additionalProperties": false
        })),
    )
    .with_title("Load Skills")
    .with_raw_output_schema(schema_object(json!({
        "type": "object",
        "properties": {
            "success": {"type": "boolean"},
            "requested_skill_ids": {"type": "array", "items": {"type": "string"}},
            "loaded_count": {"type": "integer", "minimum": 0},
            "total_skill_bytes": {"type": "integer", "minimum": 0},
            "skills": {"type": "array", "items": {"type": "object"}},
            "missing_skill_ids": {"type": "array", "items": {"type": "string"}},
            "failed_skill_ids": {"type": "array", "items": {"type": "object"}},
            "next_step": {"type": "string"},
            "error": {"type": "object"}
        },
        "required": ["success"]
    })))
    .with_annotations(read_only_annotations("Load Skills"))
}

fn load_skill_resource_spec() -> Tool {
    Tool::new(
        LOAD_SKILL_RESOURCE,
        "Read one exact supporting file from a loaded Portico skill. Use a skill-relative path from its resource manifest or SKILL.md. Text, images, audio, and other binary assets are returned without executing scripts or treating remote paths as client-local files.",
        schema_object(json!({
            "type": "object",
            "properties": {
                "skill_id": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Canonical skill_id used with load_skills."
                },
                "resource_path": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Exact safe skill-relative resource path."
                }
            },
            "required": ["skill_id", "resource_path"],
            "additionalProperties": false
        })),
    )
    .with_title("Load Skill Resource")
    .with_raw_output_schema(schema_object(json!({
        "type": "object",
        "properties": {
            "success": {"type": "boolean"},
            "skill_id": {"type": "string"},
            "resource_path": {"type": "string"},
            "kind": {"type": "string"},
            "mime_type": {"type": "string"},
            "size_bytes": {"type": "integer", "minimum": 0},
            "uri": {"type": "string"},
            "content_type": {"type": "string", "enum": ["text", "image", "audio", "blob"]},
            "text": {"type": "string"},
            "executed": {"type": "boolean"},
            "error": {"type": "object"}
        },
        "required": ["success"]
    })))
    .with_annotations(read_only_annotations("Load Skill Resource"))
}

fn result_from_bridge_payload(payload: Value) -> CallToolResult {
    if payload
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        CallToolResult::structured(payload)
    } else {
        CallToolResult::structured_error(payload)
    }
}

fn bridge_tool_error_category(
    tool_name: &str,
    dispatch: &Result<CallToolResult, ErrorData>,
) -> &'static str {
    let Ok(result) = dispatch else {
        return "invalid_request";
    };
    let Some(payload) = result.structured_content.as_ref() else {
        return "tool_call_failed";
    };
    if payload
        .get("error")
        .and_then(|error| error.get("code"))
        .and_then(Value::as_str)
        .is_some_and(|code| code == "skill_not_found")
    {
        return "skill_not_found";
    }
    if payload
        .get("error")
        .and_then(|error| error.get("code"))
        .and_then(Value::as_str)
        .is_some_and(|code| code == "resource_not_found")
    {
        return "resource_not_found";
    }
    if let Some(status) = payload.get("status").and_then(Value::as_u64) {
        return match status {
            401 | 403 => "downstream_authorization_failed",
            404 => "downstream_not_found",
            500..=599 => "downstream_unavailable",
            _ => "downstream_http_error",
        };
    }
    if payload
        .get("error")
        .and_then(Value::as_str)
        .is_some_and(|error| error.starts_with("unknown bridge tool:"))
    {
        return "tool_not_found";
    }
    if tool_name == CALL_BRIDGE_TOOL && payload.get("server_id").is_none() {
        return "invalid_request";
    }
    "tool_call_failed"
}

fn internal_error(error: impl std::fmt::Display) -> ErrorData {
    ErrorData::internal_error(error.to_string(), None)
}

fn schema_object(value: Value) -> Arc<JsonObject> {
    match value {
        Value::Object(map) => Arc::new(map),
        _ => Arc::new(empty_object_schema().as_object().unwrap().clone()),
    }
}

fn empty_object_schema() -> Value {
    json!({
        "type": "object",
        "properties": {}
    })
}

fn trim_url(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

fn json_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Bytes;
    use axum::extract::State;
    use axum::routing::post;
    use axum::Json;
    use rmcp::transport::streamable_http_client::StreamableHttpClientTransport;
    use serial_test::serial;
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::MutexGuard;
    use tokio::sync::{oneshot, Mutex};

    fn expected_meta_tool_names() -> Vec<&'static str> {
        vec![
            FIND_RELEVANT_TOOLS,
            CALL_BRIDGE_TOOL,
            FIND_RELEVANT_SKILLS,
            LOAD_SKILLS,
            LOAD_SKILL_RESOURCE,
        ]
    }

    #[test]
    fn memory_oauth_infers_resource_without_overriding_explicit_policy() {
        let inferred = server_config_with_memory_oauth(
            serde_json::from_value(json!({
                "type": "streamable-http",
                "url": "https://resource.example.test/api/tenant",
                "oauth": {}
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(inferred.oauth.as_ref().unwrap()["storage_type"], "memory");
        assert_eq!(
            inferred.oauth.as_ref().unwrap()["infer_resource_from_url"],
            true
        );

        let explicit = server_config_with_memory_oauth(
            serde_json::from_value(json!({
                "type": "streamable-http",
                "url": "https://resource.example.test/api/tenant",
                "oauth": {"infer_resource_from_url": false}
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            explicit.oauth.as_ref().unwrap()["infer_resource_from_url"],
            false
        );
    }

    struct BridgeSkillRootGuard {
        _guard: MutexGuard<'static, ()>,
        temp: tempfile::TempDir,
        previous_cwd: PathBuf,
    }

    impl BridgeSkillRootGuard {
        fn new() -> Self {
            let guard = core_mcp_shared::TEST_ENV_LOCK
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            let temp = tempfile::tempdir().expect("create bridge skill root");
            for directory in ["mcp-configs", "skills", "skills-user", "skills-marketplace"] {
                fs::create_dir_all(temp.path().join(directory)).expect("create skill root");
            }
            let previous_cwd = std::env::current_dir().expect("current directory");
            std::env::set_current_dir(temp.path()).expect("set bridge skill root");
            Self {
                _guard: guard,
                temp,
                previous_cwd,
            }
        }

        fn root(&self) -> &Path {
            self.temp.path()
        }

        fn write_skill(&self, relative_dir: &str, frontmatter: &str, body: &str) -> PathBuf {
            let skill_dir = self.root().join(relative_dir);
            fs::create_dir_all(&skill_dir).expect("create skill directory");
            fs::write(
                skill_dir.join("SKILL.md"),
                format!("---\n{frontmatter}\n---\n{body}"),
            )
            .expect("write skill markdown");
            skill_dir
        }
    }

    impl Drop for BridgeSkillRootGuard {
        fn drop(&mut self) {
            let _ = std::env::set_current_dir(&self.previous_cwd);
        }
    }

    #[test]
    fn parses_server_ids_from_root_openapi_description() {
        assert_eq!(
            parse_server_ids_from_description("[google_workspace]\n[chrome-devtools]"),
            vec!["chrome-devtools", "google_workspace"]
        );
    }

    #[test]
    fn normalizes_bridge_tool_names_and_strips_server_prefix() {
        assert_eq!(
            base_bridge_name("google-workspace", "google_workspace_read_document"),
            "google_workspace__read_document"
        );
        assert!(
            base_bridge_name(
                "very-long-server-name",
                "extremely-long-tool-name-that-overflows"
            )
            .len()
                <= MAX_TOOL_NAME_LEN
        );
    }

    #[tokio::test]
    async fn bridge_server_exposes_meta_tools_by_default() {
        let args = BridgeArgs::default();
        let server = BridgeServer::new(&args);
        let result = server.list_tools_impl().await;
        let names: Vec<_> = result
            .tools
            .into_iter()
            .map(|tool| tool.name.to_string())
            .collect();
        assert_eq!(names, expected_meta_tool_names());
    }

    #[test]
    fn bridge_server_guidance_and_tool_contract_are_client_friendly() {
        let server = BridgeServer::new(&BridgeArgs::default());
        let info = server.get_info();
        let instructions = info.instructions.expect("server instructions");
        assert_eq!(instructions, BRIDGE_INSTRUCTIONS);
        assert!(instructions.len() < 2_048);
        let critical_prefix = &instructions[..instructions.len().min(512)];
        assert!(critical_prefix.contains(FIND_RELEVANT_SKILLS));
        assert!(critical_prefix.contains(LOAD_SKILLS));
        assert!(critical_prefix.contains(LOAD_SKILL_RESOURCE));
        let proxy_info = RemoteBridgeServer {
            remote_url: "http://127.0.0.1:9/mcp".to_string(),
            auth_token_file: None,
        }
        .get_info();
        assert_eq!(
            proxy_info.instructions.as_deref(),
            Some(BRIDGE_INSTRUCTIONS)
        );

        let tools = server.meta_tools();
        assert_eq!(tools.len(), 5);
        for tool in &tools {
            assert!(tool.description.as_deref().unwrap_or_default().len() < 2_048);
            assert!(tool.annotations.is_some());
            if tool.name.as_ref() != CALL_BRIDGE_TOOL {
                assert_eq!(
                    tool.annotations
                        .as_ref()
                        .and_then(|annotations| annotations.read_only_hint),
                    Some(true)
                );
                assert!(tool.output_schema.is_some());
            }
        }
        let call_annotations = tools[1].annotations.as_ref().unwrap();
        assert_eq!(call_annotations.read_only_hint, Some(false));
        assert_eq!(call_annotations.destructive_hint, Some(true));
        assert_eq!(call_annotations.open_world_hint, Some(true));
    }

    #[tokio::test(flavor = "current_thread")]
    #[serial]
    async fn system_zoom_skill_ranks_and_loads_with_the_expected_tool_namespaces() {
        let repository_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../..");
        let system_skills_root = repository_root.join("skills");
        let skill_name = "using-zoom";
        let skill_markdown =
            fs::read_to_string(system_skills_root.join(skill_name).join("SKILL.md"))
                .unwrap_or_else(|error| panic!("read system {skill_name} skill: {error}"));

        let root = BridgeSkillRootGuard::new();
        let skill_dir = root.root().join("skills").join(skill_name);
        fs::create_dir_all(&skill_dir).expect("create system skill");
        fs::write(skill_dir.join("SKILL.md"), skill_markdown)
            .expect("copy checked-in system skill");

        let server = BridgeServer::new(&BridgeArgs::default());
        let search = server
            .find_relevant_skills(Map::from_iter([
                (
                    "query".to_string(),
                    json!("Get the recording and transcript from yesterday's Zoom meeting"),
                ),
                ("limit".to_string(), json!(2)),
            ]))
            .await
            .unwrap()
            .structured_content
            .unwrap();
        assert_eq!(search["skills"][0]["skill_id"], "using-zoom");

        let asana_search = server
            .find_relevant_skills(Map::from_iter([
                (
                    "query".to_string(),
                    json!("Find my Asana project and update the task with a comment"),
                ),
                ("limit".to_string(), json!(2)),
            ]))
            .await
            .unwrap()
            .structured_content
            .unwrap();
        assert!(asana_search["skills"]
            .as_array()
            .unwrap()
            .iter()
            .all(|skill| skill["skill_id"] != "using-asana"));

        let loaded = server
            .load_skills(Map::from_iter([(
                "skill_ids".to_string(),
                json!(["using-zoom"]),
            )]))
            .await
            .unwrap()
            .structured_content
            .unwrap();
        assert_eq!(loaded["success"], true);
        assert_eq!(loaded["loaded_count"], 1);

        let zoom_markdown = loaded["skills"][0]["skill_md"].as_str().unwrap();
        assert_eq!(loaded["skills"][0]["source"], "system");
        assert!(zoom_markdown.contains("Glean MCP server"));
        assert_eq!(
            loaded["skills"][0]["required_mcp_servers"],
            json!(["server:glean"])
        );
        assert!(zoom_markdown.contains("glean_zoom_mcp_*"));
        assert!(zoom_markdown.contains("glean_zoom_mcp_search_meetings"));
        assert!(zoom_markdown.contains("glean_zoom_mcp_get_meeting_assets"));
        assert!(zoom_markdown.contains("glean_zoom_mcp_get_recording_resource"));
        assert!(zoom_markdown.contains("## Using from the MCP bridge"));
        assert!(zoom_markdown.contains("glean__zoom_mcp_*"));
        assert!(zoom_markdown.contains("glean__zoom_mcp_search_meetings"));
        assert!(zoom_markdown.contains("glean__zoom_mcp_get_meeting_assets"));
        assert!(zoom_markdown.contains("glean__zoom_mcp_get_recording_resource"));
    }

    #[tokio::test(flavor = "current_thread")]
    #[serial]
    async fn skill_search_and_load_follow_progressive_disclosure_contract() {
        let root = BridgeSkillRootGuard::new();
        let jira_dir = root.write_skill(
            "skills/atlassian-helper",
            concat!(
                "name: jira-workflow\n",
                "display_name: Jira Workflow\n",
                "description: Triage Jira tickets and plan implementations\n",
                "version: 1.2.3\n",
                "metadata:\n",
                "  priority: high\n",
                "  triggers:\n",
                "    - jira\n",
                "    - atlassian\n",
                "  required_mcp_servers:\n",
                "    - atlassian"
            ),
            "# Jira workflow\nUse the guide.\n",
        );
        fs::create_dir_all(jira_dir.join("references")).unwrap();
        fs::create_dir_all(jira_dir.join("scripts")).unwrap();
        fs::write(jira_dir.join("references/guide.md"), "# Guide\n").unwrap();
        fs::write(
            jira_dir.join("scripts/do-not-run.py"),
            "open('executed-marker', 'w').write('bad')\n",
        )
        .unwrap();
        root.write_skill(
            "skills-user/low-builder",
            "name: low-builder\ndescription: Build internal tools\nmetadata:\n  priority: low",
            "# Low\n",
        );
        fs::create_dir_all(root.root().join("skills-marketplace/vendor/high-builder")).unwrap();
        root.write_skill(
            "skills-marketplace/vendor/high-builder",
            "name: high-builder\ndescription: Build internal tools\nmetadata:\n  priority: high",
            "# High\n",
        );

        let server = BridgeServer::new(&BridgeArgs::default());
        let search = server
            .find_relevant_skills(Map::from_iter([
                (
                    "query".to_string(),
                    json!("please help me with a Jira ticket"),
                ),
                ("limit".to_string(), json!(5)),
            ]))
            .await
            .unwrap();
        let search_payload = search.structured_content.unwrap();
        assert_eq!(search_payload["success"], json!(true));
        assert_eq!(search_payload["skills"][0]["skill_id"], "atlassian-helper");
        assert_eq!(search_payload["skills"][0]["name"], "jira-workflow");
        assert_eq!(search_payload["skills"][0]["version"], "1.2.3");

        let priorities = server
            .find_relevant_skills(Map::from_iter([("query".to_string(), json!("build"))]))
            .await
            .unwrap()
            .structured_content
            .unwrap();
        assert_eq!(priorities["skills"][0]["skill_id"], "vendor/high-builder");
        assert_eq!(priorities["skills"][1]["skill_id"], "low-builder");

        let no_match = server
            .find_relevant_skills(Map::from_iter([(
                "query".to_string(),
                json!("quantum-banana-zebra"),
            )]))
            .await
            .unwrap()
            .structured_content
            .unwrap();
        assert_eq!(no_match["count"], 0);

        let loaded_result = server
            .load_skills(Map::from_iter([(
                "skill_ids".to_string(),
                json!(["atlassian-helper", "missing-skill"]),
            )]))
            .await
            .unwrap();
        assert_eq!(loaded_result.is_error, Some(false));
        let loaded = loaded_result.structured_content.unwrap();
        assert_eq!(loaded["success"], json!(false));
        assert_eq!(loaded["loaded_count"], 1);
        assert_eq!(loaded["missing_skill_ids"], json!(["missing-skill"]));
        assert_eq!(loaded["skills"][0]["name"], "jira-workflow");
        assert!(loaded["skills"][0]["skill_md"]
            .as_str()
            .unwrap()
            .starts_with("---\nname: jira-workflow"));
        assert_eq!(
            loaded["skills"][0]["required_mcp_servers"],
            json!(["atlassian"])
        );
        assert_eq!(
            loaded["skills"][0]["resources"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["relative_path"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["references/guide.md", "scripts/do-not-run.py"]
        );
        assert!(!root.root().join("executed-marker").exists());

        let all_missing = server
            .load_skills(Map::from_iter([(
                "skill_ids".to_string(),
                json!(["missing-skill"]),
            )]))
            .await
            .unwrap();
        assert_eq!(all_missing.is_error, Some(true));
        assert!(server
            .load_skills(Map::from_iter([(
                "skill_ids".to_string(),
                json!(["atlassian-helper", "atlassian-helper"]),
            )]))
            .await
            .is_err());
        assert!(server
            .find_relevant_skills(Map::from_iter([("query".to_string(), json!("   "))]))
            .await
            .is_err());
    }

    #[tokio::test(flavor = "current_thread")]
    #[serial]
    async fn skill_resource_loader_returns_text_media_and_blob_without_execution() {
        let root = BridgeSkillRootGuard::new();
        let skill_dir = root.write_skill(
            "skills-user/resource-skill",
            "name: resource-skill\ndescription: Exercise resource types",
            "# Resources\n",
        );
        for directory in ["scripts", "assets", "references"] {
            fs::create_dir_all(skill_dir.join(directory)).unwrap();
        }
        fs::write(
            skill_dir.join("scripts/run.py"),
            "open('executed-marker', 'w').write('bad')\n",
        )
        .unwrap();
        fs::write(skill_dir.join("assets/image.png"), [0x89, b'P', b'N', b'G']).unwrap();
        fs::write(skill_dir.join("assets/sound.mp3"), [0xff, 0xfb, 0x90, 0x64]).unwrap();
        fs::write(skill_dir.join("assets/data.bin"), [0, 159, 146, 150]).unwrap();

        let server = BridgeServer::new(&BridgeArgs::default());
        let load = |path: &str| {
            Map::from_iter([
                ("skill_id".to_string(), json!("resource-skill")),
                ("resource_path".to_string(), json!(path)),
            ])
        };

        let text = server
            .load_skill_resource(load("scripts/run.py"))
            .await
            .unwrap();
        let text_payload = text.structured_content.unwrap();
        assert_eq!(text_payload["content_type"], "text");
        assert_eq!(text_payload["executed"], false);
        assert!(text_payload["text"]
            .as_str()
            .unwrap()
            .contains("executed-marker"));
        assert!(!root.root().join("executed-marker").exists());

        let image = server
            .load_skill_resource(load("assets/image.png"))
            .await
            .unwrap();
        assert_eq!(
            image.structured_content.as_ref().unwrap()["content_type"],
            "image"
        );
        assert!(image
            .content
            .iter()
            .any(|content| matches!(&content.raw, RawContent::Image(_))));

        let audio = server
            .load_skill_resource(load("assets/sound.mp3"))
            .await
            .unwrap();
        assert_eq!(
            audio.structured_content.as_ref().unwrap()["content_type"],
            "audio"
        );
        assert!(audio
            .content
            .iter()
            .any(|content| matches!(&content.raw, RawContent::Audio(_))));

        let blob = server
            .load_skill_resource(load("assets/data.bin"))
            .await
            .unwrap();
        let blob_payload = blob.structured_content.as_ref().unwrap();
        assert_eq!(blob_payload["content_type"], "blob");
        assert!(blob_payload["uri"]
            .as_str()
            .unwrap()
            .starts_with("portico-skill://resource/resource-skill/"));
        assert!(blob
            .content
            .iter()
            .any(|content| matches!(&content.raw, RawContent::Resource(_))));

        for invalid in ["../outside", ".hidden/secret", "SKILL.md", "scripts"] {
            let result = server.load_skill_resource(load(invalid)).await.unwrap();
            assert_eq!(result.is_error, Some(true));
            assert_eq!(
                result.structured_content.unwrap()["error"]["code"],
                "invalid_resource_path"
            );
        }
        let missing = server
            .load_skill_resource(load("references/missing.md"))
            .await
            .unwrap();
        assert_eq!(
            missing.structured_content.unwrap()["error"]["code"],
            "resource_not_found"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    #[serial]
    async fn skill_calls_rescan_catalog_and_enforce_size_limits() {
        let root = BridgeSkillRootGuard::new();
        let server = BridgeServer::new(&BridgeArgs::default());
        let query = Map::from_iter([("query".to_string(), json!("hot reload"))]);
        assert_eq!(
            server
                .find_relevant_skills(query.clone())
                .await
                .unwrap()
                .structured_content
                .unwrap()["count"],
            0
        );
        let skill_dir = root.write_skill(
            "skills-user/hot-skill",
            "name: hot-skill\ndescription: Hot reload workflow",
            "# First version\n",
        );
        assert_eq!(
            server
                .find_relevant_skills(query)
                .await
                .unwrap()
                .structured_content
                .unwrap()["skills"][0]["skill_id"],
            "hot-skill"
        );
        fs::write(
            skill_dir.join("SKILL.md"),
            format!(
                "---\nname: hot-skill\ndescription: Hot reload workflow\n---\n{}",
                "x".repeat(MAX_SKILL_MARKDOWN_BYTES + 1)
            ),
        )
        .unwrap();
        let oversized_skill = server
            .load_skills(Map::from_iter([(
                "skill_ids".to_string(),
                json!(["hot-skill"]),
            )]))
            .await
            .unwrap();
        assert_eq!(oversized_skill.is_error, Some(true));
        assert_eq!(
            oversized_skill.structured_content.unwrap()["failed_skill_ids"][0]["error"],
            "skill_size_limit_exceeded"
        );

        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: hot-skill\ndescription: Hot reload workflow\n---\n# Small\n",
        )
        .unwrap();
        fs::create_dir_all(skill_dir.join("references")).unwrap();
        fs::write(
            skill_dir.join("references/large.txt"),
            vec![b'x'; MAX_TEXT_SKILL_RESOURCE_BYTES as usize + 1],
        )
        .unwrap();
        let oversized_text = server
            .load_skill_resource(Map::from_iter([
                ("skill_id".to_string(), json!("hot-skill")),
                ("resource_path".to_string(), json!("references/large.txt")),
            ]))
            .await
            .unwrap();
        assert_eq!(oversized_text.is_error, Some(true));
        assert_eq!(
            oversized_text.structured_content.unwrap()["error"]["code"],
            "text_size_limit_exceeded"
        );
    }

    #[tokio::test]
    async fn discovers_tools_from_servers_endpoint_and_preserves_http_errors() {
        #[derive(Clone)]
        struct MockState;

        async fn servers() -> Json<Value> {
            Json(json!({"servers": ["google-workspace"]}))
        }

        async fn openapi() -> Json<Value> {
            Json(json!({
                "openapi": "3.1.0",
                "paths": {
                    "/google_workspace_read_document": {
                        "post": {
                            "summary": "Read Document",
                            "description": "Read a Google document",
                            "requestBody": {
                                "content": {
                                    "application/json": {
                                        "schema": {
                                            "type": "object",
                                            "properties": {"document_id": {"type": "string"}}
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }))
        }

        async fn tool(State(_): State<MockState>, body: Bytes) -> impl IntoResponse {
            let payload: Value = serde_json::from_slice(&body).unwrap();
            if payload.get("document_id").and_then(Value::as_str) == Some("boom") {
                (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({"detail": "upstream failed"})),
                )
                    .into_response()
            } else {
                Json(json!({"ok": true, "payload": payload})).into_response()
            }
        }

        let app = Router::new()
            .route("/servers", get(servers))
            .route("/google-workspace/openapi.json", get(openapi))
            .route(
                "/google-workspace/google_workspace_read_document",
                post(tool),
            )
            .with_state(MockState);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let join = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        let mut args = BridgeArgs::default();
        args.core_url = format!("http://{addr}");
        args.regular_url = "http://127.0.0.1:9".to_string();
        args.host_url = "http://127.0.0.1:9".to_string();
        let client = BridgeClient::new(&args);
        let tools = client.discover_tools().await;
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].bridge_name, "google_workspace__read_document");

        let ok = client
            .call_bridge_tool(
                "google_workspace__read_document",
                Map::from_iter([("document_id".to_string(), json!("123"))]),
            )
            .await;
        assert_eq!(ok["success"], json!(true));

        let failed = client
            .call_bridge_tool(
                "google_workspace__read_document",
                Map::from_iter([("document_id".to_string(), json!("boom"))]),
            )
            .await;
        assert_eq!(failed["success"], json!(false));
        assert_eq!(failed["status"], json!(502));
        assert_eq!(failed["error"]["detail"], json!("upstream failed"));

        args.expose_all_tools = true;
        let beta_tools = BridgeServer::new(&args).list_tools_impl().await.tools;
        assert_eq!(beta_tools.len(), expected_meta_tool_names().len() + 1);
        assert_eq!(
            beta_tools
                .iter()
                .take(expected_meta_tool_names().len())
                .map(|tool| tool.name.as_ref())
                .collect::<Vec<_>>(),
            expected_meta_tool_names()
        );
        assert_eq!(
            beta_tools.last().unwrap().name.as_ref(),
            "google_workspace__read_document"
        );

        let _ = shutdown_tx.send(());
        let _ = join.await;
    }

    #[tokio::test]
    async fn streamable_http_bridge_lists_meta_tools() {
        let args = BridgeArgs {
            port: 0,
            ..BridgeArgs::default()
        };
        let service: StreamableHttpService<BridgeServer, LocalSessionManager> =
            StreamableHttpService::new(
                move || Ok(BridgeServer::new(&args)),
                Arc::new(LocalSessionManager::default()),
                StreamableHttpServerConfig {
                    stateful_mode: true,
                    ..Default::default()
                },
            );
        let app = Router::new().nest_service("/mcp", service);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let join = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        let transport = StreamableHttpClientTransport::from_uri(format!("http://{addr}/mcp"));
        let running = ().serve(transport).await.unwrap();
        let tools = running.peer().list_all_tools().await.unwrap();
        let names: Vec<_> = tools
            .into_iter()
            .map(|tool| tool.name.to_string())
            .collect();
        assert_eq!(names, expected_meta_tool_names());
        assert_eq!(
            running
                .peer()
                .peer_info()
                .and_then(|info| info.instructions.as_deref()),
            Some(BRIDGE_INSTRUCTIONS)
        );
        running.cancel().await.unwrap();
        let _ = shutdown_tx.send(());
        let _ = join.await;
    }

    fn test_token_hash(token: &str, salt_label: &str) -> String {
        use sha2::{Digest, Sha256};
        let normalized_salt = format!("{:x}", Sha256::digest(salt_label.as_bytes()));
        let normalized_salt = &normalized_salt[..32];
        let mut hasher = Sha256::new();
        hasher.update(normalized_salt.as_bytes());
        hasher.update(b":");
        hasher.update(token.as_bytes());
        format!("sha256:{normalized_salt}:{:x}", hasher.finalize())
    }

    #[test]
    fn bearer_parser_accepts_rfc_6750_b64token_and_rejects_ambiguous_headers() {
        use axum::http::HeaderValue;

        let mut accepted = HeaderMap::new();
        accepted.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("bEaReR   AZaz09-._~+/=="),
        );
        assert_eq!(bearer_token_from_headers(&accepted), Ok("AZaz09-._~+/=="));

        assert_eq!(
            bearer_token_from_headers(&HeaderMap::new()),
            Err(BridgeAuthRejection::MissingAuthorization)
        );
        for invalid in [
            "Bearer",
            "Basic abc",
            "Bearer\tabc",
            "Bearer abc,def",
            "Bearer abc=def",
            "Bearer =",
            "Bearer abc def",
            "Bearer abc==x",
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(
                header::AUTHORIZATION,
                HeaderValue::from_str(invalid).unwrap(),
            );
            assert_eq!(
                bearer_token_from_headers(&headers),
                Err(BridgeAuthRejection::MalformedAuthorization),
                "unexpected result for {invalid:?}"
            );
        }

        let mut duplicate = HeaderMap::new();
        duplicate.append(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer first"),
        );
        duplicate.append(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer second"),
        );
        assert_eq!(
            bearer_token_from_headers(&duplicate),
            Err(BridgeAuthRejection::MultipleAuthorization)
        );
    }

    #[test]
    fn bridge_auth_accepts_shared_registry_fixtures() {
        let fixture_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../test-fixtures/host-mcp-bridge-auth");
        for (name, token, expected_scope) in [
            (
                "valid-v1-legacy-scopes.json",
                "portico_mcp_fixture_unscoped_AZaz09-._~",
                None,
            ),
            (
                "valid-v1-scoped.json",
                "portico_mcp_fixture_scoped_AZaz09-._~",
                Some(BRIDGE_STATUS_SCOPE),
            ),
        ] {
            let raw = fs::read_to_string(fixture_root.join(name)).unwrap();
            let registry: BridgeAuthRegistry = serde_json::from_str(&raw).unwrap();
            validate_bridge_auth_registry(&registry).unwrap();
            let registry_file = tempfile::NamedTempFile::new().unwrap();
            fs::write(registry_file.path(), raw).unwrap();
            let authenticated = BridgeAuth::new(Some(registry_file.path().to_path_buf()))
                .authenticate_token(token)
                .unwrap();
            assert!(!authenticated.client_id.is_empty());
            assert_eq!(
                expected_scope.map(|scope| authenticated.has_scope(scope)),
                expected_scope.map(|_| true)
            );
            if expected_scope.is_none() {
                assert!(authenticated.scopes.is_empty());
            }
        }
    }

    #[test]
    fn bridge_auth_classifies_registry_failures_and_ambiguous_matches() {
        let token = "portico_mcp_registry_classification";
        let token_hash = test_token_hash(token, "classification");
        let registry_file = tempfile::NamedTempFile::new().unwrap();
        let auth = BridgeAuth::new(Some(registry_file.path().to_path_buf()));
        let write_registry = |value: Value| {
            fs::write(registry_file.path(), value.to_string()).unwrap();
        };
        let entry = |client_id: &str, token_hash: &str, revoked: bool, scopes: Value| {
            json!({
                "clientId": client_id,
                "tokenHash": token_hash,
                "revoked": revoked,
                "scopes": scopes,
            })
        };

        write_registry(json!({"version": 2, "tokens": []}));
        assert_eq!(
            auth.authenticate_token(token).unwrap_err(),
            BridgeAuthRejection::UnsupportedRegistryVersion
        );

        write_registry(json!({"version": 1, "tokens": "not-an-array"}));
        assert_eq!(
            auth.authenticate_token(token).unwrap_err(),
            BridgeAuthRejection::MalformedRegistry
        );

        write_registry(json!({
            "version": 1,
            "tokens": [
                entry("Foo", &token_hash, false, json!([])),
                entry("foo", &test_token_hash("other", "other"), false, json!([])),
            ],
        }));
        assert_eq!(
            auth.authenticate_token(token).unwrap_err(),
            BridgeAuthRejection::MalformedRegistry
        );

        for invalid_scopes in [json!(["z", "a"]), json!(["bridge:status", "é"])] {
            write_registry(json!({
                "version": 1,
                "tokens": [entry("scoped", &token_hash, false, invalid_scopes)],
            }));
            assert_eq!(
                auth.authenticate_token(token).unwrap_err(),
                BridgeAuthRejection::MalformedRegistry
            );
        }

        write_registry(json!({
            "version": 1,
            "tokens": [entry(
                "uppercase-hash",
                &token_hash.to_ascii_uppercase(),
                false,
                json!([]),
            )],
        }));
        assert_eq!(
            auth.authenticate_token(token).unwrap_err(),
            BridgeAuthRejection::MalformedRegistry
        );

        write_registry(json!({
            "version": 1,
            "tokens": [
                entry("first", &token_hash, false, json!([])),
                entry("second", &token_hash, false, json!([])),
            ],
        }));
        assert_eq!(
            auth.authenticate_token(token).unwrap_err(),
            BridgeAuthRejection::AmbiguousActiveMatch
        );

        write_registry(json!({
            "version": 1,
            "tokens": [entry("revoked", &token_hash, true, json!([]))],
        }));
        assert_eq!(
            auth.authenticate_token(token).unwrap_err(),
            BridgeAuthRejection::NoActiveMatch
        );
    }

    #[test]
    fn bridge_auth_rejection_logging_is_sparse_and_bounded() {
        let auth = BridgeAuth::new(None);
        let occurrences: Vec<_> = (0..8)
            .map(|_| {
                auth.next_rejection_log_occurrence(
                    BridgeAuthRejection::NoActiveMatch,
                    AuthMethodBucket::Post,
                    AuthEndpoint::Mcp,
                )
            })
            .collect();
        assert_eq!(
            occurrences,
            vec![Some(1), Some(2), None, Some(4), None, None, None, Some(8)]
        );

        let bounded = BridgeAuth::new(None);
        for rejection in [
            BridgeAuthRejection::MissingAuthorization,
            BridgeAuthRejection::MultipleAuthorization,
            BridgeAuthRejection::MalformedAuthorization,
            BridgeAuthRejection::RegistryUnavailable,
            BridgeAuthRejection::MalformedRegistry,
            BridgeAuthRejection::UnsupportedRegistryVersion,
            BridgeAuthRejection::AmbiguousActiveMatch,
            BridgeAuthRejection::NoActiveMatch,
        ] {
            for method in [
                AuthMethodBucket::Get,
                AuthMethodBucket::Post,
                AuthMethodBucket::Delete,
                AuthMethodBucket::Other,
            ] {
                for endpoint in [
                    AuthEndpoint::Mcp,
                    AuthEndpoint::BridgeStatus,
                    AuthEndpoint::OAuthSecret,
                    AuthEndpoint::StaticSecret,
                ] {
                    let _ = bounded.next_rejection_log_occurrence(rejection, method, endpoint);
                }
            }
        }
        assert_eq!(bounded.rejection_counts.lock().unwrap().len(), 8 * 4 * 4);
    }

    #[tokio::test]
    async fn oauth_discovery_routes_return_unauthenticated_not_supported_json() {
        async fn protected() -> StatusCode {
            StatusCode::OK
        }

        let mcp_router = Router::new().route("/mcp", post(protected)).route_layer(
            middleware::from_fn_with_state(BridgeAuth::new(None), require_bridge_auth),
        );
        let app = Router::new()
            .route(
                "/.well-known/oauth-protected-resource/mcp",
                get(oauth_not_supported),
            )
            .route(
                "/.well-known/oauth-protected-resource",
                get(oauth_not_supported),
            )
            .route(
                "/.well-known/oauth-authorization-server",
                get(oauth_not_supported),
            )
            .merge(mcp_router);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let join = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        let client = reqwest::Client::new();
        let expected = json!({
            "error": "oauth_not_supported",
            "error_description": "Host MCP Bridge uses app-managed per-client credentials. Configure this client from Portico."
        });
        for path in [
            "/.well-known/oauth-protected-resource/mcp",
            "/.well-known/oauth-protected-resource",
            "/.well-known/oauth-authorization-server",
        ] {
            let response = client
                .get(format!("http://{addr}{path}"))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "path: {path}");
            assert_eq!(
                response.headers().get(header::CONTENT_TYPE).unwrap(),
                "application/json",
                "path: {path}"
            );
            assert!(
                response.headers().get(header::WWW_AUTHENTICATE).is_none(),
                "path: {path}"
            );
            assert_eq!(
                response.json::<Value>().await.unwrap(),
                expected,
                "path: {path}"
            );
        }

        let protected_response = client
            .post(format!("http://{addr}/mcp"))
            .send()
            .await
            .unwrap();
        assert_eq!(protected_response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            protected_response
                .headers()
                .get(header::WWW_AUTHENTICATE)
                .unwrap(),
            "Bearer"
        );

        let unknown_response = client
            .get(format!("http://{addr}/.well-known/not-a-bridge-route"))
            .send()
            .await
            .unwrap();
        assert_eq!(unknown_response.status(), StatusCode::NOT_FOUND);
        assert!(
            unknown_response
                .headers()
                .get(header::WWW_AUTHENTICATE)
                .is_none()
        );

        let _ = shutdown_tx.send(());
        let _ = join.await;
    }

    #[tokio::test]
    async fn bridge_auth_rereads_registry_for_each_request() {
        async fn protected() -> StatusCode {
            StatusCode::OK
        }

        let token = "portico_mcp_registry_reread";
        let token_hash = test_token_hash(token, "reread");
        let registry_file = tempfile::NamedTempFile::new().unwrap();
        let registry = |hash: &str| {
            json!({
                "version": 1,
                "tokens": [{
                    "clientId": "reread-client",
                    "tokenHash": hash,
                    "revoked": false,
                }],
            })
            .to_string()
        };
        fs::write(registry_file.path(), registry(&token_hash)).unwrap();

        let app = Router::new().route("/mcp", post(protected)).route_layer(
            middleware::from_fn_with_state(
                BridgeAuth::new(Some(registry_file.path().to_path_buf())),
                require_bridge_auth,
            ),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let join = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        let client = reqwest::Client::new();
        let send = || {
            client
                .post(format!("http://{addr}/mcp"))
                .header(header::AUTHORIZATION, format!("bEaReR   {token}"))
                .send()
        };
        assert_eq!(send().await.unwrap().status(), StatusCode::OK);

        fs::write(
            registry_file.path(),
            registry(&test_token_hash("replacement", "replacement")),
        )
        .unwrap();
        let rejected = send().await.unwrap();
        assert_eq!(rejected.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            rejected
                .headers()
                .get(header::WWW_AUTHENTICATE)
                .unwrap()
                .to_str()
                .unwrap(),
            "Bearer error=\"invalid_token\""
        );

        fs::write(registry_file.path(), registry(&token_hash)).unwrap();
        assert_eq!(send().await.unwrap().status(), StatusCode::OK);

        let _ = shutdown_tx.send(());
        let _ = join.await;
    }

    fn test_secret_broker_state(
        registry_path: PathBuf,
        status_url: String,
        broker_token: &str,
    ) -> SecretBrokerState {
        SecretBrokerState {
            auth: BridgeAuth::new(Some(registry_path)),
            electron_bridge_status_url: Some(status_url),
            electron_broker_url: None,
            electron_broker_update_url: None,
            electron_broker_invalidate_url: None,
            electron_static_secret_broker_url: None,
            electron_broker_token: Some(broker_token.to_string()),
            oauth_refresh_locks: new_oauth_refresh_locks(),
            http: reqwest::Client::new(),
        }
    }

    #[tokio::test]
    async fn bridge_status_requires_exact_status_scope() {
        let status_token = "portico_mcp_status_token";
        let wrong_scope_token = "portico_mcp_wrong_scope";
        let registry_file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(
            registry_file.path(),
            json!({
                "version": 1,
                "tokens": [
                    {
                        "clientId": "scheduling-status",
                        "displayName": "Scheduling status",
                        "tokenHash": test_token_hash(status_token, "status-salt"),
                        "revoked": false,
                        "scopes": [BRIDGE_STATUS_SCOPE],
                    },
                    {
                        "clientId": "oauth-client",
                        "displayName": "OAuth client",
                        "tokenHash": test_token_hash(wrong_scope_token, "wrong-salt"),
                        "revoked": false,
                        "scopes": ["oauth:access-token:slack"],
                    },
                ],
            })
            .to_string(),
        )
        .unwrap();

        async fn electron_status() -> Json<Value> {
            Json(json!({
                "success": true,
                "bridgeReady": true,
                "bridgeEnabled": true,
                "brokerAuthReady": true,
            }))
        }

        let electron_app = Router::new().route("/electron/status", get(electron_status));
        let electron_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let electron_addr = electron_listener.local_addr().unwrap();
        let (electron_shutdown_tx, electron_shutdown_rx) = oneshot::channel::<()>();
        let electron_join = tokio::spawn(async move {
            let _ = axum::serve(electron_listener, electron_app)
                .with_graceful_shutdown(async {
                    let _ = electron_shutdown_rx.await;
                })
                .await;
        });

        let app = Router::new().route(
            "/bridge/status",
            get(bridge_status).with_state(test_secret_broker_state(
                registry_file.path().to_path_buf(),
                format!("http://{electron_addr}/electron/status"),
                "broker-token",
            )),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let join = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        let client = reqwest::Client::new();
        let missing = client
            .get(format!("http://{addr}/bridge/status"))
            .send()
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::UNAUTHORIZED);
        let bogus = client
            .get(format!("http://{addr}/bridge/status"))
            .bearer_auth("bogus")
            .send()
            .await
            .unwrap();
        assert_eq!(bogus.status(), StatusCode::UNAUTHORIZED);
        let wrong_scope = client
            .get(format!("http://{addr}/bridge/status"))
            .bearer_auth(wrong_scope_token)
            .send()
            .await
            .unwrap();
        assert_eq!(wrong_scope.status(), StatusCode::FORBIDDEN);
        let ok = client
            .get(format!("http://{addr}/bridge/status"))
            .bearer_auth(status_token)
            .send()
            .await
            .unwrap();
        assert_eq!(ok.status(), StatusCode::OK);

        let _ = shutdown_tx.send(());
        let _ = electron_shutdown_tx.send(());
        let _ = join.await;
        let _ = electron_join.await;
    }

    #[tokio::test]
    async fn bridge_status_reports_not_ready_when_electron_rejects_broker_token() {
        let status_token = "portico_mcp_status_token";
        let registry_file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(
            registry_file.path(),
            json!({
                "version": 1,
                "tokens": [{
                    "clientId": "scheduling-status",
                    "displayName": "Scheduling status",
                    "tokenHash": test_token_hash(status_token, "status-salt"),
                    "revoked": false,
                    "scopes": [BRIDGE_STATUS_SCOPE],
                }],
            })
            .to_string(),
        )
        .unwrap();

        async fn electron_status(headers: HeaderMap) -> Response {
            if headers
                .get(header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok())
                != Some("Bearer fresh-token")
            {
                return StatusCode::UNAUTHORIZED.into_response();
            }
            Json(json!({
                "success": true,
                "bridgeReady": true,
                "bridgeEnabled": true,
                "brokerAuthReady": true,
            }))
            .into_response()
        }

        let electron_app = Router::new().route("/electron/status", get(electron_status));
        let electron_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let electron_addr = electron_listener.local_addr().unwrap();
        let (electron_shutdown_tx, electron_shutdown_rx) = oneshot::channel::<()>();
        let electron_join = tokio::spawn(async move {
            let _ = axum::serve(electron_listener, electron_app)
                .with_graceful_shutdown(async {
                    let _ = electron_shutdown_rx.await;
                })
                .await;
        });

        let app = Router::new().route(
            "/bridge/status",
            get(bridge_status).with_state(test_secret_broker_state(
                registry_file.path().to_path_buf(),
                format!("http://{electron_addr}/electron/status"),
                "stale-token",
            )),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let join = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        let response = reqwest::Client::new()
            .get(format!("http://{addr}/bridge/status"))
            .bearer_auth(status_token)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let payload: Value = response.json().await.unwrap();
        assert_eq!(payload["success"], json!(false));
        assert_eq!(payload["brokerAuthReady"], json!(false));
        assert_eq!(payload["errorCode"], json!("broker_auth_rejected"));

        let _ = shutdown_tx.send(());
        let _ = electron_shutdown_tx.send(());
        let _ = join.await;
        let _ = electron_join.await;
    }

    #[tokio::test]
    async fn bridge_status_reports_ready_when_external_client_bridge_disabled() {
        // PORTICO-200: the external-client bridge preference must not gate OAuth
        // broker readiness. A disabled preference with a healthy broker path
        // is ready.
        let status_token = "portico_mcp_status_token";
        let registry_file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(
            registry_file.path(),
            json!({
                "version": 1,
                "tokens": [{
                    "clientId": "scheduling-status",
                    "displayName": "Scheduling status",
                    "tokenHash": test_token_hash(status_token, "status-salt"),
                    "revoked": false,
                    "scopes": [BRIDGE_STATUS_SCOPE],
                }],
            })
            .to_string(),
        )
        .unwrap();

        async fn electron_status() -> Json<Value> {
            Json(json!({
                "success": true,
                "bridgeReady": true,
                "bridgeEnabled": false,
                "brokerAuthReady": true,
            }))
        }

        let electron_app = Router::new().route("/electron/status", get(electron_status));
        let electron_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let electron_addr = electron_listener.local_addr().unwrap();
        let (electron_shutdown_tx, electron_shutdown_rx) = oneshot::channel::<()>();
        let electron_join = tokio::spawn(async move {
            let _ = axum::serve(electron_listener, electron_app)
                .with_graceful_shutdown(async {
                    let _ = electron_shutdown_rx.await;
                })
                .await;
        });

        let app = Router::new().route(
            "/bridge/status",
            get(bridge_status).with_state(test_secret_broker_state(
                registry_file.path().to_path_buf(),
                format!("http://{electron_addr}/electron/status"),
                "broker-token",
            )),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let join = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        let response = reqwest::Client::new()
            .get(format!("http://{addr}/bridge/status"))
            .bearer_auth(status_token)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let payload: Value = response.json().await.unwrap();
        assert_eq!(payload["success"], json!(true));
        assert_eq!(payload["bridgeReady"], json!(true));
        assert_eq!(payload["bridgeEnabled"], json!(false));
        assert_eq!(payload["brokerAuthReady"], json!(true));
        assert_eq!(payload.get("errorCode"), None);
        assert_eq!(payload.get("reason"), None);

        let _ = shutdown_tx.send(());
        let _ = electron_shutdown_tx.send(());
        let _ = join.await;
        let _ = electron_join.await;
    }

    #[tokio::test]
    async fn bridge_status_reports_not_ready_when_broker_auth_flag_false() {
        // Isolates the `broker_auth_ready` conjunct: a 200 Electron payload
        // that is otherwise healthy but reports brokerAuthReady:false must
        // stay not-ready even though bridge_enabled no longer gates readiness.
        let status_token = "portico_mcp_status_token";
        let registry_file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(
            registry_file.path(),
            json!({
                "version": 1,
                "tokens": [{
                    "clientId": "scheduling-status",
                    "displayName": "Scheduling status",
                    "tokenHash": test_token_hash(status_token, "status-salt"),
                    "revoked": false,
                    "scopes": [BRIDGE_STATUS_SCOPE],
                }],
            })
            .to_string(),
        )
        .unwrap();

        async fn electron_status() -> Json<Value> {
            Json(json!({
                "success": true,
                "bridgeReady": true,
                "bridgeEnabled": true,
                "brokerAuthReady": false,
            }))
        }

        let electron_app = Router::new().route("/electron/status", get(electron_status));
        let electron_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let electron_addr = electron_listener.local_addr().unwrap();
        let (electron_shutdown_tx, electron_shutdown_rx) = oneshot::channel::<()>();
        let electron_join = tokio::spawn(async move {
            let _ = axum::serve(electron_listener, electron_app)
                .with_graceful_shutdown(async {
                    let _ = electron_shutdown_rx.await;
                })
                .await;
        });

        let app = Router::new().route(
            "/bridge/status",
            get(bridge_status).with_state(test_secret_broker_state(
                registry_file.path().to_path_buf(),
                format!("http://{electron_addr}/electron/status"),
                "broker-token",
            )),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let join = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        let response = reqwest::Client::new()
            .get(format!("http://{addr}/bridge/status"))
            .bearer_auth(status_token)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let payload: Value = response.json().await.unwrap();
        assert_eq!(payload["success"], json!(false));
        assert_eq!(payload["brokerAuthReady"], json!(false));
        assert_eq!(payload["errorCode"], json!("not_ready"));

        let _ = shutdown_tx.send(());
        let _ = electron_shutdown_tx.send(());
        let _ = join.await;
        let _ = electron_join.await;
    }

    #[tokio::test]
    async fn streamable_http_bridge_requires_bearer_auth() {
        async fn collect_telemetry(
            State(sender): State<Arc<StdMutex<Option<oneshot::Sender<String>>>>>,
            body: String,
        ) -> StatusCode {
            if let Some(sender) = sender.lock().unwrap().take() {
                let _ = sender.send(body);
            }
            StatusCode::OK
        }

        let (telemetry_tx, telemetry_rx) = oneshot::channel::<String>();
        let telemetry_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let telemetry_addr = telemetry_listener.local_addr().unwrap();
        let telemetry_app = Router::new()
            .route("/logrepo", post(collect_telemetry))
            .with_state(Arc::new(StdMutex::new(Some(telemetry_tx))));
        let telemetry_join = tokio::spawn(async move {
            let _ = axum::serve(telemetry_listener, telemetry_app).await;
        });

        let token = "portico_mcp_test_token";
        let salt = "0123456789abcdef";
        let registry_file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(
            registry_file.path(),
            json!({
                "version": 1,
                "tokens": [{
                    "clientId": "test-client",
                    "displayName": "Test Client",
                    "tokenHash": test_token_hash(token, salt),
                    "revoked": false,
                }],
            })
            .to_string(),
        )
        .unwrap();

        let args = BridgeArgs {
            port: 0,
            auth_registry_path: Some(registry_file.path().to_path_buf()),
            ..BridgeArgs::default()
        };
        let service: StreamableHttpService<BridgeServer, LocalSessionManager> =
            StreamableHttpService::new(
                move || {
                    Ok(BridgeServer::with_telemetry(
                        &args,
                        BridgeTelemetry::for_test(format!("http://{telemetry_addr}/logrepo")),
                    ))
                },
                Arc::new(LocalSessionManager::default()),
                StreamableHttpServerConfig {
                    stateful_mode: true,
                    ..Default::default()
                },
            );
        let mcp_router = Router::new().nest_service("/mcp", service).route_layer(
            middleware::from_fn_with_state(
                BridgeAuth::new(Some(registry_file.path().to_path_buf())),
                require_bridge_auth,
            ),
        );
        let app = Router::new()
            .route("/health", get(health))
            .merge(mcp_router);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let join = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        let client = reqwest::Client::new();
        let missing = client
            .post(format!("http://{addr}/mcp"))
            .json(&json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}))
            .send()
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            missing
                .headers()
                .get(header::WWW_AUTHENTICATE)
                .unwrap()
                .to_str()
                .unwrap(),
            "Bearer"
        );

        let bogus = client
            .post(format!("http://{addr}/mcp"))
            .bearer_auth("wrong")
            .json(&json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}))
            .send()
            .await
            .unwrap();
        assert_eq!(bogus.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            bogus
                .headers()
                .get(header::WWW_AUTHENTICATE)
                .unwrap()
                .to_str()
                .unwrap(),
            "Bearer error=\"invalid_token\""
        );

        let transport = StreamableHttpClientTransport::with_client(
            CompatibleReqwestStreamableHttpClient::new(reqwest::Client::new()),
            StreamableHttpClientTransportConfig::with_uri(format!("http://{addr}/mcp"))
                .auth_header(token.to_string()),
        );
        let running = ().serve(transport).await.unwrap();
        let tools = running.peer().list_all_tools().await.unwrap();
        let names: Vec<_> = tools
            .into_iter()
            .map(|tool| tool.name.to_string())
            .collect();
        assert_eq!(names, expected_meta_tool_names());
        let mut request = CallToolRequestParams::default();
        request.name = FIND_RELEVANT_TOOLS.to_string().into();
        request.arguments = Some(Map::from_iter([("query".to_string(), json!(""))]));
        running.peer().call_tool(request).await.unwrap();

        let telemetry_body = tokio::time::timeout(Duration::from_secs(2), telemetry_rx)
            .await
            .expect("bridge tool-call telemetry timeout")
            .expect("bridge tool-call telemetry sender dropped");
        let telemetry_fields: HashMap<_, _> =
            url::form_urlencoded::parse(telemetry_body.trim_end_matches("&&").as_bytes())
                .into_owned()
                .collect();
        assert_eq!(telemetry_fields["event_name"], "bridge_tool_call");
        assert_eq!(telemetry_fields["runtime_path"], "portico_bridge");
        assert_eq!(telemetry_fields["client_id"], "test-client");
        assert_eq!(telemetry_fields["tool"], FIND_RELEVANT_TOOLS);
        assert_eq!(telemetry_fields["outcome"], "success");

        running.cancel().await.unwrap();
        let _ = shutdown_tx.send(());
        let _ = join.await;
        telemetry_join.abort();
    }

    #[tokio::test]
    async fn oauth_secret_broker_requires_exact_server_scope() {
        async fn electron_broker(Json(payload): Json<Value>) -> Json<Value> {
            Json(json!({
                "server_id": payload.get("server_id").cloned().unwrap_or(Value::Null),
                "token": {
                    "access_token": "short-lived-access-token",
                    "token_type": "Bearer",
                    "expires_in": 3600,
                    "expires_at": "2999-06-07T12:00:00Z",
                    "refresh_token": "refresh-token"
                },
                "client_info": {
                    "client_id": "client-id",
                    "token_endpoint_auth_method": "none",
                    "redirect_uris": ["http://localhost:3834/callback"]
                },
                "server_config": {
                    "type": "streamable-http",
                    "url": "http://127.0.0.1:8080/mcp",
                    "oauth": {
                        "authorization_endpoint": "http://127.0.0.1:9999/authorize",
                        "token_endpoint": "http://127.0.0.1:9999/token"
                    }
                }
            }))
        }

        async fn electron_update(Json(_payload): Json<Value>) -> Json<Value> {
            Json(json!({"success": true}))
        }

        let broker_app = Router::new()
            .route("/electron/oauth/record", post(electron_broker))
            .route("/electron/oauth/record/update", post(electron_update));
        let broker_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let broker_addr = broker_listener.local_addr().unwrap();
        let (broker_shutdown_tx, broker_shutdown_rx) = oneshot::channel::<()>();
        let broker_join = tokio::spawn(async move {
            let _ = axum::serve(broker_listener, broker_app)
                .with_graceful_shutdown(async {
                    let _ = broker_shutdown_rx.await;
                })
                .await;
        });

        let token = "portico_mcp_slack_scope";
        let salt = "scope-salt";
        let registry_file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(
            registry_file.path(),
            json!({
                "version": 1,
                "tokens": [{
                    "clientId": "mcpo-slack",
                    "displayName": "Slack OAuth runtime",
                    "tokenHash": test_token_hash(token, salt),
                    "revoked": false,
                    "scopes": ["oauth:access-token:slack"],
                }],
            })
            .to_string(),
        )
        .unwrap();

        let app = Router::new().route(
            "/secrets/oauth/access-token",
            post(vend_oauth_access_token).with_state(SecretBrokerState {
                auth: BridgeAuth::new(Some(registry_file.path().to_path_buf())),
                electron_bridge_status_url: None,
                electron_broker_url: Some(format!("http://{broker_addr}/electron/oauth/record")),
                electron_broker_update_url: Some(format!(
                    "http://{broker_addr}/electron/oauth/record/update"
                )),
                electron_broker_invalidate_url: None,
                electron_static_secret_broker_url: None,
                electron_broker_token: None,
                oauth_refresh_locks: new_oauth_refresh_locks(),
                http: reqwest::Client::new(),
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let join = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        let client = reqwest::Client::new();
        let missing = client
            .post(format!("http://{addr}/secrets/oauth/access-token"))
            .json(&json!({"server_id": "slack"}))
            .send()
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::UNAUTHORIZED);

        let cross_server = client
            .post(format!("http://{addr}/secrets/oauth/access-token"))
            .bearer_auth(token)
            .json(&json!({"server_id": "google_workspace"}))
            .send()
            .await
            .unwrap();
        assert_eq!(cross_server.status(), StatusCode::FORBIDDEN);

        let same_server = client
            .post(format!("http://{addr}/secrets/oauth/access-token"))
            .bearer_auth(token)
            .json(&json!({"server_id": "slack"}))
            .send()
            .await
            .unwrap();
        assert_eq!(same_server.status(), StatusCode::OK);
        let body: Value = same_server.json().await.unwrap();
        assert_eq!(body["server_id"], json!("slack"));
        assert_eq!(body["access_token"], json!("short-lived-access-token"));
        assert!(body.get("refresh_token").is_none());
        assert!(body.get("client_secret").is_none());

        let _ = shutdown_tx.send(());
        let _ = join.await;
        let _ = broker_shutdown_tx.send(());
        let _ = broker_join.await;
    }

    #[tokio::test]
    async fn oauth_secret_broker_returns_structured_auth_required_when_record_missing() {
        async fn electron_missing_record(Json(payload): Json<Value>) -> Response {
            let server_id = payload
                .get("server_id")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({
                    "success": false,
                    "server_id": server_id,
                    "error": "secure OAuth record is unavailable"
                })),
            )
                .into_response()
        }

        let broker_app =
            Router::new().route("/electron/oauth/record", post(electron_missing_record));
        let broker_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let broker_addr = broker_listener.local_addr().unwrap();
        let (broker_shutdown_tx, broker_shutdown_rx) = oneshot::channel::<()>();
        let broker_join = tokio::spawn(async move {
            let _ = axum::serve(broker_listener, broker_app)
                .with_graceful_shutdown(async {
                    let _ = broker_shutdown_rx.await;
                })
                .await;
        });

        let token = "portico_mcp_glean_scope";
        let salt = "scope-salt";
        let registry_file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(
            registry_file.path(),
            json!({
                "version": 1,
                "tokens": [{
                    "clientId": "mcpo-glean",
                    "displayName": "Glean OAuth runtime",
                    "tokenHash": test_token_hash(token, salt),
                    "revoked": false,
                    "scopes": ["oauth:access-token:glean"],
                }],
            })
            .to_string(),
        )
        .unwrap();

        let app = Router::new().route(
            "/secrets/oauth/access-token",
            post(vend_oauth_access_token).with_state(SecretBrokerState {
                auth: BridgeAuth::new(Some(registry_file.path().to_path_buf())),
                electron_bridge_status_url: None,
                electron_broker_url: Some(format!("http://{broker_addr}/electron/oauth/record")),
                electron_broker_update_url: None,
                electron_broker_invalidate_url: None,
                electron_static_secret_broker_url: None,
                electron_broker_token: None,
                oauth_refresh_locks: new_oauth_refresh_locks(),
                http: reqwest::Client::new(),
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let join = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        let response = reqwest::Client::new()
            .post(format!("http://{addr}/secrets/oauth/access-token"))
            .bearer_auth(token)
            .json(&json!({"server_id": "glean"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PRECONDITION_REQUIRED);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["server_id"], json!("glean"));
        assert_eq!(body["auth_required"], json!(true));
        assert!(body.get("access_token").is_none());
        assert!(body.get("refresh_token").is_none());
        assert!(body.get("client_secret").is_none());

        let _ = shutdown_tx.send(());
        let _ = join.await;
        let _ = broker_shutdown_tx.send(());
        let _ = broker_join.await;
    }

    #[tokio::test]
    async fn static_secret_broker_requires_exact_server_and_secret_scope() {
        async fn electron_static_secret(Json(payload): Json<Value>) -> Json<Value> {
            Json(json!({
                "server_id": payload.get("server_id").cloned().unwrap_or(Value::Null),
                "secret_name": payload.get("secret_name").cloned().unwrap_or(Value::Null),
                "value_base64": "c3RhdGljLXNlY3JldC12YWx1ZQ=="
            }))
        }

        let broker_app =
            Router::new().route("/electron/static-secret", post(electron_static_secret));
        let broker_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let broker_addr = broker_listener.local_addr().unwrap();
        let (broker_shutdown_tx, broker_shutdown_rx) = oneshot::channel::<()>();
        let broker_join = tokio::spawn(async move {
            let _ = axum::serve(broker_listener, broker_app)
                .with_graceful_shutdown(async {
                    let _ = broker_shutdown_rx.await;
                })
                .await;
        });

        let token = "portico_mcp_static_secret_scope";
        let salt = "scope-salt";
        let registry_file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(
            registry_file.path(),
            json!({
                "version": 1,
                "tokens": [{
                    "clientId": "mcpo-snowflake-connections",
                    "displayName": "Snowflake static secret",
                    "tokenHash": test_token_hash(token, salt),
                    "revoked": false,
                    "scopes": ["static-secret:snowflake:portico_runtime_file_snowflake_connections_toml_deadbeefcafe"],
                }],
            })
            .to_string(),
        )
        .unwrap();

        let app = Router::new().route(
            "/secrets/static-secret",
            post(vend_static_secret).with_state(SecretBrokerState {
                auth: BridgeAuth::new(Some(registry_file.path().to_path_buf())),
                electron_bridge_status_url: None,
                electron_broker_url: None,
                electron_broker_update_url: None,
                electron_broker_invalidate_url: None,
                electron_static_secret_broker_url: Some(format!(
                    "http://{broker_addr}/electron/static-secret"
                )),
                electron_broker_token: None,
                oauth_refresh_locks: new_oauth_refresh_locks(),
                http: reqwest::Client::new(),
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let join = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        let client = reqwest::Client::new();
        let missing = client
            .post(format!("http://{addr}/secrets/static-secret"))
            .json(&json!({
                "server_id": "snowflake",
                "secret_name": "portico_runtime_file_snowflake_connections_toml_deadbeefcafe"
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::UNAUTHORIZED);

        let cross_secret = client
            .post(format!("http://{addr}/secrets/static-secret"))
            .bearer_auth(token)
            .json(&json!({
                "server_id": "snowflake",
                "secret_name": "other_secret"
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(cross_secret.status(), StatusCode::FORBIDDEN);

        let same_secret = client
            .post(format!("http://{addr}/secrets/static-secret"))
            .bearer_auth(token)
            .json(&json!({
                "server_id": "snowflake",
                "secret_name": "portico_runtime_file_snowflake_connections_toml_deadbeefcafe"
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(same_secret.status(), StatusCode::OK);
        let body: Value = same_secret.json().await.unwrap();
        assert_eq!(body["server_id"], json!("snowflake"));
        assert_eq!(
            body["secret_name"],
            json!("portico_runtime_file_snowflake_connections_toml_deadbeefcafe")
        );
        assert_eq!(body["value_base64"], json!("c3RhdGljLXNlY3JldC12YWx1ZQ=="));
        assert!(!body.to_string().contains("static-secret-value"));

        let _ = shutdown_tx.send(());
        let _ = join.await;
        let _ = broker_shutdown_tx.send(());
        let _ = broker_join.await;
    }

    #[derive(Clone)]
    struct OAuthRefreshBrokerTestState {
        record: Arc<Mutex<Value>>,
        update_body: Arc<Mutex<Option<Value>>>,
        invalidate_body: Arc<Mutex<Option<Value>>>,
        update_count: Arc<AtomicUsize>,
        invalidate_count: Arc<AtomicUsize>,
        refresh_count: Arc<AtomicUsize>,
        invalidated: Arc<AtomicBool>,
        refresh_failure: Option<Value>,
        refresh_delay_ms: u64,
    }

    async fn electron_refresh_record_broker(
        State(state): State<OAuthRefreshBrokerTestState>,
        Json(_payload): Json<Value>,
    ) -> Response {
        if state.invalidated.load(Ordering::SeqCst) {
            return (
                StatusCode::PRECONDITION_REQUIRED,
                Json(json!({
                    "success": false,
                    "auth_required": true,
                    "error": "OAuth authorization required"
                })),
            )
                .into_response();
        }
        Json(state.record.lock().await.clone()).into_response()
    }

    async fn electron_refresh_record_update(
        State(state): State<OAuthRefreshBrokerTestState>,
        Json(payload): Json<Value>,
    ) -> Json<Value> {
        state.update_count.fetch_add(1, Ordering::SeqCst);
        *state.update_body.lock().await = Some(payload.clone());
        let mut record = state.record.lock().await;
        record["token"] = payload["token"].clone();
        record["client_info"] = payload["client_info"].clone();
        Json(json!({"success": true}))
    }

    async fn electron_refresh_record_invalidate(
        State(state): State<OAuthRefreshBrokerTestState>,
        Json(payload): Json<Value>,
    ) -> Json<Value> {
        state.invalidate_count.fetch_add(1, Ordering::SeqCst);
        state.invalidated.store(true, Ordering::SeqCst);
        *state.invalidate_body.lock().await = Some(payload);
        Json(json!({"success": true}))
    }

    async fn refresh_token_endpoint(
        State(state): State<OAuthRefreshBrokerTestState>,
        body: Bytes,
    ) -> Response {
        state.refresh_count.fetch_add(1, Ordering::SeqCst);
        let form = String::from_utf8_lossy(&body);
        assert!(form.contains("grant_type=refresh_token"));
        assert!(form.contains("refresh_token=refresh-old"));
        if state.refresh_delay_ms > 0 {
            tokio::time::sleep(Duration::from_millis(state.refresh_delay_ms)).await;
        }
        if let Some(failure) = state.refresh_failure {
            return (StatusCode::BAD_REQUEST, Json(failure)).into_response();
        }
        Json(json!({
            "access_token": "rotated-access-token",
            "token_type": "Bearer",
            "expires_in": 120,
            "refresh_token": "refresh-new"
        }))
        .into_response()
    }

    fn oauth_refresh_test_record(
        server_id: &str,
        token_endpoint: &str,
        access_token: &str,
        expires_at: Value,
    ) -> Value {
        json!({
            "server_id": server_id,
            "token": {
                "access_token": access_token,
                "token_type": "Bearer",
                "expires_in": 3600,
                "expires_at": expires_at,
                "refresh_token": "refresh-old"
            },
            "client_info": {
                "client_id": "client-id",
                "token_endpoint_auth_method": "none",
                "redirect_uris": ["http://localhost:3834/callback"]
            },
            "server_config": {
                "type": "streamable-http",
                "url": "http://127.0.0.1:8080/mcp",
                "oauth": {
                    "authorization_endpoint": "http://127.0.0.1:9999/authorize",
                    "token_endpoint": token_endpoint
                }
            }
        })
    }

    #[derive(Clone)]
    struct GoogleAuthorityDecoyTestState {
        authority_url: String,
        resource_url: Option<String>,
        metadata_count: Arc<AtomicUsize>,
        token_count: Arc<AtomicUsize>,
    }

    async fn google_decoy_protected_resource_metadata(
        State(state): State<GoogleAuthorityDecoyTestState>,
    ) -> Json<Value> {
        state.metadata_count.fetch_add(1, Ordering::SeqCst);
        Json(json!({
            "resource": state.resource_url.expect("decoy resource URL"),
            "authorization_servers": [state.authority_url]
        }))
    }

    async fn google_decoy_authorization_metadata(
        State(state): State<GoogleAuthorityDecoyTestState>,
    ) -> Json<Value> {
        state.metadata_count.fetch_add(1, Ordering::SeqCst);
        Json(json!({
            "issuer": state.authority_url,
            "authorization_endpoint": format!("{}/authorize", state.authority_url),
            "token_endpoint": format!("{}/token", state.authority_url)
        }))
    }

    async fn google_decoy_token_endpoint(
        State(state): State<GoogleAuthorityDecoyTestState>,
        body: Bytes,
    ) -> Response {
        state.token_count.fetch_add(1, Ordering::SeqCst);
        let form = String::from_utf8_lossy(&body);
        assert!(form.contains("grant_type=refresh_token"));
        assert!(form.contains("refresh_token=fake-google-refresh-token"));
        assert!(form.contains("client_id=fake-google-client-id"));
        (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "invalid_request",
                "error_description": "Invalid request - Invalid client_id parameter"
            })),
        )
            .into_response()
    }

    async fn google_trusted_token_endpoint(
        State(state): State<OAuthRefreshBrokerTestState>,
        body: Bytes,
    ) -> Json<Value> {
        state.refresh_count.fetch_add(1, Ordering::SeqCst);
        let form = String::from_utf8_lossy(&body);
        assert!(form.contains("grant_type=refresh_token"));
        assert!(form.contains("refresh_token=fake-google-refresh-token"));
        assert!(form.contains("client_id=fake-google-client-id"));
        Json(json!({
            "access_token": "rotated-access-token",
            "token_type": "Bearer",
            "expires_in": 120,
            "refresh_token": "fake-google-refresh-token"
        }))
    }

    #[tokio::test]
    async fn oauth_secret_broker_google_workspace_hosted_authority_rejects_local_decoy() {
        let _env_lock = crate::test_env_lock();
        let decoy_metadata_count = Arc::new(AtomicUsize::new(0));
        let decoy_token_count = Arc::new(AtomicUsize::new(0));

        let authority_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let authority_addr = authority_listener.local_addr().unwrap();
        let authority_url = format!("http://{authority_addr}");
        let authority_app = Router::new()
            .route(
                "/.well-known/oauth-authorization-server",
                get(google_decoy_authorization_metadata),
            )
            .route("/token", post(google_decoy_token_endpoint))
            .with_state(GoogleAuthorityDecoyTestState {
                authority_url: authority_url.clone(),
                resource_url: None,
                metadata_count: Arc::clone(&decoy_metadata_count),
                token_count: Arc::clone(&decoy_token_count),
            });
        let (authority_shutdown_tx, authority_shutdown_rx) = oneshot::channel::<()>();
        let authority_join = tokio::spawn(async move {
            let _ = axum::serve(authority_listener, authority_app)
                .with_graceful_shutdown(async {
                    let _ = authority_shutdown_rx.await;
                })
                .await;
        });

        let resource_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let resource_addr = resource_listener.local_addr().unwrap();
        let resource_url = format!("http://{resource_addr}/mcp");
        let resource_app = Router::new()
            .route(
                "/.well-known/oauth-protected-resource/mcp",
                get(google_decoy_protected_resource_metadata),
            )
            .with_state(GoogleAuthorityDecoyTestState {
                authority_url,
                resource_url: Some(resource_url.clone()),
                metadata_count: Arc::clone(&decoy_metadata_count),
                token_count: Arc::clone(&decoy_token_count),
            });
        let (resource_shutdown_tx, resource_shutdown_rx) = oneshot::channel::<()>();
        let resource_join = tokio::spawn(async move {
            let _ = axum::serve(resource_listener, resource_app)
                .with_graceful_shutdown(async {
                    let _ = resource_shutdown_rx.await;
                })
                .await;
        });

        let broker_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let broker_addr = broker_listener.local_addr().unwrap();
        let update_body = Arc::new(Mutex::new(None));
        let update_count = Arc::new(AtomicUsize::new(0));
        let provider_token_count = Arc::new(AtomicUsize::new(0));

        let fragment_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../mcp-configs/google_workspace/google_workspace.fragment");
        let mut server_config: Value = serde_json::from_str(
            &std::fs::read_to_string(&fragment_path).unwrap_or_else(|error| {
                panic!(
                    "failed to read bundled Google Workspace fragment {}: {error}",
                    fragment_path.display()
                )
            }),
        )
        .unwrap();
        server_config["url"] = json!(resource_url);
        let oauth = server_config["oauth"].as_object_mut().unwrap();
        oauth.insert(
            "server_url".to_string(),
            json!(format!("http://{broker_addr}")),
        );
        oauth.insert(
            "resource".to_string(),
            json!(format!("http://{broker_addr}/mcp")),
        );
        oauth.insert(
            "authorization_endpoint".to_string(),
            json!(format!("http://{broker_addr}/trusted/authorize")),
        );
        oauth.insert(
            "token_endpoint".to_string(),
            json!(format!("http://{broker_addr}/trusted/token")),
        );

        let server_id = "google_workspace";
        let record = json!({
            "server_id": server_id,
            "token": {
                "access_token": "expired-fake-google-access-token",
                "token_type": "Bearer",
                "expires_in": 3600,
                "expires_at": 1,
                "refresh_token": "fake-google-refresh-token"
            },
            "client_info": {
                "client_id": "fake-google-client-id",
                "token_endpoint_auth_method": "none",
                "redirect_uris": ["http://localhost:3834/callback"]
            },
            "server_config": server_config
        });
        let broker_state = OAuthRefreshBrokerTestState {
            record: Arc::new(Mutex::new(record)),
            update_body: Arc::clone(&update_body),
            invalidate_body: Arc::new(Mutex::new(None)),
            update_count: Arc::clone(&update_count),
            invalidate_count: Arc::new(AtomicUsize::new(0)),
            refresh_count: Arc::clone(&provider_token_count),
            invalidated: Arc::new(AtomicBool::new(false)),
            refresh_failure: None,
            refresh_delay_ms: 0,
        };
        let broker_app = Router::new()
            .route(
                "/electron/oauth/record",
                post(electron_refresh_record_broker),
            )
            .route(
                "/electron/oauth/record/update",
                post(electron_refresh_record_update),
            )
            .route("/trusted/token", post(google_trusted_token_endpoint))
            .with_state(broker_state);
        let (broker_shutdown_tx, broker_shutdown_rx) = oneshot::channel::<()>();
        let broker_join = tokio::spawn(async move {
            let _ = axum::serve(broker_listener, broker_app)
                .with_graceful_shutdown(async {
                    let _ = broker_shutdown_rx.await;
                })
                .await;
        });

        let token = "portico_mcp_google_workspace_authority_scope";
        let registry_file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(
            registry_file.path(),
            json!({
                "version": 1,
                "tokens": [{
                    "clientId": "mcpo-google-workspace",
                    "displayName": "Google Workspace OAuth runtime",
                    "tokenHash": test_token_hash(token, "authority-scope-salt"),
                    "revoked": false,
                    "scopes": ["oauth:access-token:google_workspace"],
                }],
            })
            .to_string(),
        )
        .unwrap();
        let host_app = Router::new().route(
            "/secrets/oauth/access-token",
            post(vend_oauth_access_token).with_state(SecretBrokerState {
                auth: BridgeAuth::new(Some(registry_file.path().to_path_buf())),
                electron_bridge_status_url: None,
                electron_broker_url: Some(format!("http://{broker_addr}/electron/oauth/record")),
                electron_broker_update_url: Some(format!(
                    "http://{broker_addr}/electron/oauth/record/update"
                )),
                electron_broker_invalidate_url: None,
                electron_static_secret_broker_url: None,
                electron_broker_token: None,
                oauth_refresh_locks: new_oauth_refresh_locks(),
                http: reqwest::Client::new(),
            }),
        );
        let host_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let host_addr = host_listener.local_addr().unwrap();
        let (host_shutdown_tx, host_shutdown_rx) = oneshot::channel::<()>();
        let host_join = tokio::spawn(async move {
            let _ = axum::serve(host_listener, host_app)
                .with_graceful_shutdown(async {
                    let _ = host_shutdown_rx.await;
                })
                .await;
        });

        let response = reqwest::Client::new()
            .post(format!("http://{host_addr}/secrets/oauth/access-token"))
            .bearer_auth(token)
            .json(&json!({"server_id": server_id}))
            .send()
            .await
            .unwrap();
        let response_status = response.status();
        let response_body = response.text().await.unwrap();
        println!(
            "[PORTICO-423 trace] status={} decoy_metadata_requests={} decoy_token_requests={} provider_token_requests={}",
            response_status,
            decoy_metadata_count.load(Ordering::SeqCst),
            decoy_token_count.load(Ordering::SeqCst),
            provider_token_count.load(Ordering::SeqCst),
        );

        assert_eq!(response_status, StatusCode::OK, "{response_body}");
        let body: Value = serde_json::from_str(&response_body).unwrap();
        assert_eq!(body["access_token"], json!("rotated-access-token"));
        assert_eq!(decoy_metadata_count.load(Ordering::SeqCst), 0);
        assert_eq!(decoy_token_count.load(Ordering::SeqCst), 0);
        assert_eq!(provider_token_count.load(Ordering::SeqCst), 1);
        assert_eq!(update_count.load(Ordering::SeqCst), 1);
        assert_eq!(
            update_body.lock().await.as_ref().unwrap()["token"]["access_token"],
            json!("rotated-access-token")
        );

        let _ = host_shutdown_tx.send(());
        let _ = host_join.await;
        let _ = broker_shutdown_tx.send(());
        let _ = broker_join.await;
        let _ = resource_shutdown_tx.send(());
        let _ = resource_join.await;
        let _ = authority_shutdown_tx.send(());
        let _ = authority_join.await;
    }

    #[tokio::test]
    async fn oauth_secret_broker_force_refreshes_record_with_rust_engine() {
        let broker_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let broker_addr = broker_listener.local_addr().unwrap();
        let update_body = Arc::new(Mutex::new(None));
        let invalidate_body = Arc::new(Mutex::new(None));
        let update_count = Arc::new(AtomicUsize::new(0));
        let invalidate_count = Arc::new(AtomicUsize::new(0));
        let refresh_count = Arc::new(AtomicUsize::new(0));
        let invalidated = Arc::new(AtomicBool::new(false));
        let broker_state = OAuthRefreshBrokerTestState {
            record: Arc::new(Mutex::new(oauth_refresh_test_record(
                "refresh_slack",
                &format!("http://{broker_addr}/token"),
                "still-valid-access-token",
                json!("2999-01-01T00:00:00Z"),
            ))),
            update_body: Arc::clone(&update_body),
            invalidate_body,
            update_count: Arc::clone(&update_count),
            invalidate_count,
            refresh_count: Arc::clone(&refresh_count),
            invalidated,
            refresh_failure: None,
            refresh_delay_ms: 0,
        };
        let broker_app = Router::new()
            .route(
                "/electron/oauth/record",
                post(electron_refresh_record_broker),
            )
            .route(
                "/electron/oauth/record/update",
                post(electron_refresh_record_update),
            )
            .route(
                "/electron/oauth/record/invalidate",
                post(electron_refresh_record_invalidate),
            )
            .route("/token", post(refresh_token_endpoint))
            .with_state(broker_state);
        let (broker_shutdown_tx, broker_shutdown_rx) = oneshot::channel::<()>();
        let broker_join = tokio::spawn(async move {
            let _ = axum::serve(broker_listener, broker_app)
                .with_graceful_shutdown(async {
                    let _ = broker_shutdown_rx.await;
                })
                .await;
        });

        let server_id = "refresh_slack";
        let token = "portico_mcp_refresh_slack_scope";
        let salt = "scope-salt";
        let registry_file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(
            registry_file.path(),
            json!({
                "version": 1,
                "tokens": [{
                    "clientId": "mcpo-refresh-slack",
                    "displayName": "Slack OAuth runtime",
                    "tokenHash": test_token_hash(token, salt),
                    "revoked": false,
                    "scopes": ["oauth:access-token:refresh_slack"],
                }],
            })
            .to_string(),
        )
        .unwrap();

        let app = Router::new().route(
            "/secrets/oauth/access-token",
            post(vend_oauth_access_token).with_state(SecretBrokerState {
                auth: BridgeAuth::new(Some(registry_file.path().to_path_buf())),
                electron_bridge_status_url: None,
                electron_broker_url: Some(format!("http://{broker_addr}/electron/oauth/record")),
                electron_broker_update_url: Some(format!(
                    "http://{broker_addr}/electron/oauth/record/update"
                )),
                electron_broker_invalidate_url: None,
                electron_static_secret_broker_url: None,
                electron_broker_token: None,
                oauth_refresh_locks: new_oauth_refresh_locks(),
                http: reqwest::Client::new(),
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let join = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        let response = reqwest::Client::new()
            .post(format!("http://{addr}/secrets/oauth/access-token"))
            .bearer_auth(token)
            .json(&json!({"server_id": server_id, "force_refresh": true}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["access_token"], json!("rotated-access-token"));
        assert!(body.get("refresh_token").is_none());
        assert_eq!(refresh_count.load(Ordering::SeqCst), 1);
        assert_eq!(update_count.load(Ordering::SeqCst), 1);

        let update = update_body.lock().await.clone().unwrap();
        assert_eq!(update["server_id"], json!(server_id));
        assert_eq!(
            update["token"]["access_token"],
            json!("rotated-access-token")
        );
        assert_eq!(update["token"]["refresh_token"], json!("refresh-new"));
        assert_eq!(update["client_info"]["client_id"], json!("client-id"));

        let _ = shutdown_tx.send(());
        let _ = join.await;
        let _ = broker_shutdown_tx.send(());
        let _ = broker_join.await;
    }

    #[tokio::test]
    async fn oauth_secret_broker_refreshes_expired_record_without_force() {
        let broker_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let broker_addr = broker_listener.local_addr().unwrap();
        let update_body = Arc::new(Mutex::new(None));
        let invalidate_body = Arc::new(Mutex::new(None));
        let update_count = Arc::new(AtomicUsize::new(0));
        let invalidate_count = Arc::new(AtomicUsize::new(0));
        let refresh_count = Arc::new(AtomicUsize::new(0));
        let invalidated = Arc::new(AtomicBool::new(false));
        let broker_state = OAuthRefreshBrokerTestState {
            record: Arc::new(Mutex::new(oauth_refresh_test_record(
                "refresh_google_workspace",
                &format!("http://{broker_addr}/token"),
                "expired-access-token",
                json!(1),
            ))),
            update_body: Arc::clone(&update_body),
            invalidate_body,
            update_count: Arc::clone(&update_count),
            invalidate_count,
            refresh_count: Arc::clone(&refresh_count),
            invalidated,
            refresh_failure: None,
            refresh_delay_ms: 0,
        };
        let broker_app = Router::new()
            .route(
                "/electron/oauth/record",
                post(electron_refresh_record_broker),
            )
            .route(
                "/electron/oauth/record/update",
                post(electron_refresh_record_update),
            )
            .route(
                "/electron/oauth/record/invalidate",
                post(electron_refresh_record_invalidate),
            )
            .route("/token", post(refresh_token_endpoint))
            .with_state(broker_state);
        let (broker_shutdown_tx, broker_shutdown_rx) = oneshot::channel::<()>();
        let broker_join = tokio::spawn(async move {
            let _ = axum::serve(broker_listener, broker_app)
                .with_graceful_shutdown(async {
                    let _ = broker_shutdown_rx.await;
                })
                .await;
        });

        let server_id = "refresh_google_workspace";
        let token = "portico_mcp_refresh_google_scope";
        let salt = "scope-salt";
        let registry_file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(
            registry_file.path(),
            json!({
                "version": 1,
                "tokens": [{
                    "clientId": "mcpo-refresh-google-workspace",
                    "displayName": "Google Workspace OAuth runtime",
                    "tokenHash": test_token_hash(token, salt),
                    "revoked": false,
                    "scopes": ["oauth:access-token:refresh_google_workspace"],
                }],
            })
            .to_string(),
        )
        .unwrap();

        let app = Router::new().route(
            "/secrets/oauth/access-token",
            post(vend_oauth_access_token).with_state(SecretBrokerState {
                auth: BridgeAuth::new(Some(registry_file.path().to_path_buf())),
                electron_bridge_status_url: None,
                electron_broker_url: Some(format!("http://{broker_addr}/electron/oauth/record")),
                electron_broker_update_url: Some(format!(
                    "http://{broker_addr}/electron/oauth/record/update"
                )),
                electron_broker_invalidate_url: None,
                electron_static_secret_broker_url: None,
                electron_broker_token: None,
                oauth_refresh_locks: new_oauth_refresh_locks(),
                http: reqwest::Client::new(),
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let join = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        let response = reqwest::Client::new()
            .post(format!("http://{addr}/secrets/oauth/access-token"))
            .bearer_auth(token)
            .json(&json!({"server_id": server_id}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["access_token"], json!("rotated-access-token"));
        assert_eq!(refresh_count.load(Ordering::SeqCst), 1);
        assert_eq!(update_count.load(Ordering::SeqCst), 1);

        let update = update_body.lock().await.clone().unwrap();
        assert_eq!(update["server_id"], json!(server_id));
        assert_eq!(
            update["token"]["access_token"],
            json!("rotated-access-token")
        );
        assert_eq!(update["token"]["refresh_token"], json!("refresh-new"));

        let _ = shutdown_tx.send(());
        let _ = join.await;
        let _ = broker_shutdown_tx.send(());
        let _ = broker_join.await;
    }

    #[tokio::test]
    async fn oauth_secret_broker_coalesces_parallel_refreshes_by_rejected_token() {
        let broker_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let broker_addr = broker_listener.local_addr().unwrap();
        let update_body = Arc::new(Mutex::new(None));
        let invalidate_body = Arc::new(Mutex::new(None));
        let update_count = Arc::new(AtomicUsize::new(0));
        let invalidate_count = Arc::new(AtomicUsize::new(0));
        let refresh_count = Arc::new(AtomicUsize::new(0));
        let broker_state = OAuthRefreshBrokerTestState {
            record: Arc::new(Mutex::new(oauth_refresh_test_record(
                "product-pal",
                &format!("http://{broker_addr}/token"),
                "migrated-access-token",
                json!("2999-01-01T00:00:00Z"),
            ))),
            update_body: Arc::clone(&update_body),
            invalidate_body: Arc::clone(&invalidate_body),
            update_count: Arc::clone(&update_count),
            invalidate_count: Arc::clone(&invalidate_count),
            refresh_count: Arc::clone(&refresh_count),
            invalidated: Arc::new(AtomicBool::new(false)),
            refresh_failure: None,
            refresh_delay_ms: 50,
        };
        let broker_app = Router::new()
            .route(
                "/electron/oauth/record",
                post(electron_refresh_record_broker),
            )
            .route(
                "/electron/oauth/record/update",
                post(electron_refresh_record_update),
            )
            .route(
                "/electron/oauth/record/invalidate",
                post(electron_refresh_record_invalidate),
            )
            .route("/token", post(refresh_token_endpoint))
            .with_state(broker_state);
        let (broker_shutdown_tx, broker_shutdown_rx) = oneshot::channel::<()>();
        let broker_join = tokio::spawn(async move {
            let _ = axum::serve(broker_listener, broker_app)
                .with_graceful_shutdown(async {
                    let _ = broker_shutdown_rx.await;
                })
                .await;
        });

        let server_id = "product-pal";
        let token = "portico_mcp_product_pal_scope";
        let registry_file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(
            registry_file.path(),
            json!({
                "version": 1,
                "tokens": [{
                    "clientId": "mcpo-product-pal",
                    "displayName": "Product Pal OAuth runtime",
                    "tokenHash": test_token_hash(token, "scope-salt"),
                    "revoked": false,
                    "scopes": ["oauth:access-token:product-pal"],
                }],
            })
            .to_string(),
        )
        .unwrap();

        let app = Router::new().route(
            "/secrets/oauth/access-token",
            post(vend_oauth_access_token).with_state(SecretBrokerState {
                auth: BridgeAuth::new(Some(registry_file.path().to_path_buf())),
                electron_bridge_status_url: None,
                electron_broker_url: Some(format!("http://{broker_addr}/electron/oauth/record")),
                electron_broker_update_url: Some(format!(
                    "http://{broker_addr}/electron/oauth/record/update"
                )),
                electron_broker_invalidate_url: Some(format!(
                    "http://{broker_addr}/electron/oauth/record/invalidate"
                )),
                electron_static_secret_broker_url: None,
                electron_broker_token: None,
                oauth_refresh_locks: new_oauth_refresh_locks(),
                http: reqwest::Client::new(),
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let join = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        let payload = json!({
            "server_id": server_id,
            "force_refresh": true,
            "rejected_access_token_sha256":
                oauth_access_token_sha256("migrated-access-token"),
        });
        let client = reqwest::Client::new();
        let first = client
            .post(format!("http://{addr}/secrets/oauth/access-token"))
            .bearer_auth(token)
            .json(&payload)
            .send();
        let second = client
            .post(format!("http://{addr}/secrets/oauth/access-token"))
            .bearer_auth(token)
            .json(&payload)
            .send();
        let (first, second) = tokio::join!(first, second);
        let first = first.unwrap();
        let second = second.unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        assert_eq!(second.status(), StatusCode::OK);
        assert_eq!(
            first.json::<Value>().await.unwrap()["access_token"],
            json!("rotated-access-token")
        );
        assert_eq!(
            second.json::<Value>().await.unwrap()["access_token"],
            json!("rotated-access-token")
        );
        assert_eq!(refresh_count.load(Ordering::SeqCst), 1);
        assert_eq!(update_count.load(Ordering::SeqCst), 1);
        assert_eq!(
            update_body.lock().await.as_ref().unwrap()["token"]["refresh_token"],
            json!("refresh-new")
        );

        let stale_invalidation = client
            .post(format!("http://{addr}/secrets/oauth/access-token"))
            .bearer_auth(token)
            .json(&json!({
                "server_id": server_id,
                "invalidate_rejected": true,
                "rejected_access_token_sha256":
                    oauth_access_token_sha256("migrated-access-token"),
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(stale_invalidation.status(), StatusCode::OK);
        assert_eq!(invalidate_count.load(Ordering::SeqCst), 0);

        let matching_invalidation = client
            .post(format!("http://{addr}/secrets/oauth/access-token"))
            .bearer_auth(token)
            .json(&json!({
                "server_id": server_id,
                "invalidate_rejected": true,
                "rejected_access_token_sha256":
                    oauth_access_token_sha256("rotated-access-token"),
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(
            matching_invalidation.status(),
            StatusCode::PRECONDITION_REQUIRED
        );
        assert_eq!(invalidate_count.load(Ordering::SeqCst), 1);
        assert_eq!(
            invalidate_body.lock().await.as_ref().unwrap()["error_class"],
            json!("oauth_persistent_downstream_unauthorized")
        );

        let _ = shutdown_tx.send(());
        let _ = join.await;
        let _ = broker_shutdown_tx.send(());
        let _ = broker_join.await;
    }

    #[tokio::test]
    async fn oauth_secret_broker_invalidates_invalid_client_refresh_once() {
        let broker_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let broker_addr = broker_listener.local_addr().unwrap();
        let invalidate_body = Arc::new(Mutex::new(None));
        let invalidate_count = Arc::new(AtomicUsize::new(0));
        let refresh_count = Arc::new(AtomicUsize::new(0));
        let broker_state = OAuthRefreshBrokerTestState {
            record: Arc::new(Mutex::new(oauth_refresh_test_record(
                "product-pal",
                &format!("http://{broker_addr}/token"),
                "rejected-access-token",
                json!("2999-01-01T00:00:00Z"),
            ))),
            update_body: Arc::new(Mutex::new(None)),
            invalidate_body: Arc::clone(&invalidate_body),
            update_count: Arc::new(AtomicUsize::new(0)),
            invalidate_count: Arc::clone(&invalidate_count),
            refresh_count: Arc::clone(&refresh_count),
            invalidated: Arc::new(AtomicBool::new(false)),
            refresh_failure: Some(json!({
                "error": "invalid_client",
                "error_description": "Invalid client_id"
            })),
            refresh_delay_ms: 0,
        };
        let broker_app = Router::new()
            .route(
                "/electron/oauth/record",
                post(electron_refresh_record_broker),
            )
            .route(
                "/electron/oauth/record/update",
                post(electron_refresh_record_update),
            )
            .route(
                "/electron/oauth/record/invalidate",
                post(electron_refresh_record_invalidate),
            )
            .route("/token", post(refresh_token_endpoint))
            .with_state(broker_state);
        let (broker_shutdown_tx, broker_shutdown_rx) = oneshot::channel::<()>();
        let broker_join = tokio::spawn(async move {
            let _ = axum::serve(broker_listener, broker_app)
                .with_graceful_shutdown(async {
                    let _ = broker_shutdown_rx.await;
                })
                .await;
        });

        let server_id = "product-pal";
        let token = "portico_mcp_product_pal_terminal_scope";
        let registry_file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(
            registry_file.path(),
            json!({
                "version": 1,
                "tokens": [{
                    "clientId": "mcpo-product-pal",
                    "displayName": "Product Pal OAuth runtime",
                    "tokenHash": test_token_hash(token, "scope-salt"),
                    "revoked": false,
                    "scopes": ["oauth:access-token:product-pal"],
                }],
            })
            .to_string(),
        )
        .unwrap();
        let app = Router::new().route(
            "/secrets/oauth/access-token",
            post(vend_oauth_access_token).with_state(SecretBrokerState {
                auth: BridgeAuth::new(Some(registry_file.path().to_path_buf())),
                electron_bridge_status_url: None,
                electron_broker_url: Some(format!("http://{broker_addr}/electron/oauth/record")),
                electron_broker_update_url: Some(format!(
                    "http://{broker_addr}/electron/oauth/record/update"
                )),
                electron_broker_invalidate_url: Some(format!(
                    "http://{broker_addr}/electron/oauth/record/invalidate"
                )),
                electron_static_secret_broker_url: None,
                electron_broker_token: None,
                oauth_refresh_locks: new_oauth_refresh_locks(),
                http: reqwest::Client::new(),
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let join = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        let payload = json!({
            "server_id": server_id,
            "force_refresh": true,
            "rejected_access_token_sha256":
                oauth_access_token_sha256("rejected-access-token"),
        });
        let client = reqwest::Client::new();
        for _ in 0..2 {
            let response = client
                .post(format!("http://{addr}/secrets/oauth/access-token"))
                .bearer_auth(token)
                .json(&payload)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::PRECONDITION_REQUIRED);
        }
        assert_eq!(refresh_count.load(Ordering::SeqCst), 1);
        assert_eq!(invalidate_count.load(Ordering::SeqCst), 1);
        assert_eq!(
            invalidate_body.lock().await.as_ref().unwrap()["error_class"],
            json!("oauth_terminal_refresh_failure")
        );

        let _ = shutdown_tx.send(());
        let _ = join.await;
        let _ = broker_shutdown_tx.send(());
        let _ = broker_join.await;
    }

    #[tokio::test]
    async fn oauth_secret_broker_preserves_record_on_refresh_infrastructure_failure() {
        let broker_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let broker_addr = broker_listener.local_addr().unwrap();
        let invalidate_count = Arc::new(AtomicUsize::new(0));
        let refresh_count = Arc::new(AtomicUsize::new(0));
        let broker_state = OAuthRefreshBrokerTestState {
            record: Arc::new(Mutex::new(oauth_refresh_test_record(
                "product-pal",
                &format!("http://{broker_addr}/token"),
                "temporarily-rejected-access-token",
                json!("2999-01-01T00:00:00Z"),
            ))),
            update_body: Arc::new(Mutex::new(None)),
            invalidate_body: Arc::new(Mutex::new(None)),
            update_count: Arc::new(AtomicUsize::new(0)),
            invalidate_count: Arc::clone(&invalidate_count),
            refresh_count: Arc::clone(&refresh_count),
            invalidated: Arc::new(AtomicBool::new(false)),
            refresh_failure: Some(json!({
                "error": "temporarily_unavailable",
                "error_description": "Provider is unavailable"
            })),
            refresh_delay_ms: 0,
        };
        let broker_app = Router::new()
            .route(
                "/electron/oauth/record",
                post(electron_refresh_record_broker),
            )
            .route(
                "/electron/oauth/record/update",
                post(electron_refresh_record_update),
            )
            .route(
                "/electron/oauth/record/invalidate",
                post(electron_refresh_record_invalidate),
            )
            .route("/token", post(refresh_token_endpoint))
            .with_state(broker_state);
        let (broker_shutdown_tx, broker_shutdown_rx) = oneshot::channel::<()>();
        let broker_join = tokio::spawn(async move {
            let _ = axum::serve(broker_listener, broker_app)
                .with_graceful_shutdown(async {
                    let _ = broker_shutdown_rx.await;
                })
                .await;
        });

        let server_id = "product-pal";
        let token = "portico_mcp_product_pal_infrastructure_scope";
        let registry_file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(
            registry_file.path(),
            json!({
                "version": 1,
                "tokens": [{
                    "clientId": "mcpo-product-pal",
                    "displayName": "Product Pal OAuth runtime",
                    "tokenHash": test_token_hash(token, "scope-salt"),
                    "revoked": false,
                    "scopes": ["oauth:access-token:product-pal"],
                }],
            })
            .to_string(),
        )
        .unwrap();
        let app = Router::new().route(
            "/secrets/oauth/access-token",
            post(vend_oauth_access_token).with_state(SecretBrokerState {
                auth: BridgeAuth::new(Some(registry_file.path().to_path_buf())),
                electron_bridge_status_url: None,
                electron_broker_url: Some(format!("http://{broker_addr}/electron/oauth/record")),
                electron_broker_update_url: Some(format!(
                    "http://{broker_addr}/electron/oauth/record/update"
                )),
                electron_broker_invalidate_url: Some(format!(
                    "http://{broker_addr}/electron/oauth/record/invalidate"
                )),
                electron_static_secret_broker_url: None,
                electron_broker_token: None,
                oauth_refresh_locks: new_oauth_refresh_locks(),
                http: reqwest::Client::new(),
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let join = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        let response = reqwest::Client::new()
            .post(format!("http://{addr}/secrets/oauth/access-token"))
            .bearer_auth(token)
            .json(&json!({
                "server_id": server_id,
                "force_refresh": true,
                "rejected_access_token_sha256":
                    oauth_access_token_sha256("temporarily-rejected-access-token"),
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(refresh_count.load(Ordering::SeqCst), 1);
        assert_eq!(invalidate_count.load(Ordering::SeqCst), 0);

        let _ = shutdown_tx.send(());
        let _ = join.await;
        let _ = broker_shutdown_tx.send(());
        let _ = broker_join.await;
    }

    #[tokio::test]
    async fn oauth_secret_broker_preserves_matching_fixed_client_and_invalidates_mismatch() {
        let server_id = "fixed-slack";
        let broker_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let broker_addr = broker_listener.local_addr().unwrap();
        let record = Arc::new(Mutex::new(json!({
            "server_id": server_id,
            "token": {
                "access_token": "fixed-client-access-token",
                "token_type": "Bearer",
                "expires_in": 3600,
                "expires_at": "2999-01-01T00:00:00Z",
                "refresh_token": "refresh-old"
            },
            "client_info": {
                "client_id": "fixed-client-id",
                "token_endpoint_auth_method": "none",
                "redirect_uris": ["http://localhost:3834/callback"]
            },
            "server_config": {
                "type": "streamable-http",
                "url": "http://127.0.0.1:8080/mcp",
                "oauth": {
                    "type": "non-dcr",
                    "authorization_endpoint": "http://127.0.0.1:9999/authorize",
                    "token_endpoint": "http://127.0.0.1:9999/token",
                    "credentials_source": {
                        "type": "inline",
                        "client_id": "fixed-client-id"
                    }
                }
            }
        })));
        let invalidate_body = Arc::new(Mutex::new(None));
        let invalidate_count = Arc::new(AtomicUsize::new(0));
        let broker_state = OAuthRefreshBrokerTestState {
            record: Arc::clone(&record),
            update_body: Arc::new(Mutex::new(None)),
            invalidate_body: Arc::clone(&invalidate_body),
            update_count: Arc::new(AtomicUsize::new(0)),
            invalidate_count: Arc::clone(&invalidate_count),
            refresh_count: Arc::new(AtomicUsize::new(0)),
            invalidated: Arc::new(AtomicBool::new(false)),
            refresh_failure: None,
            refresh_delay_ms: 0,
        };
        let broker_app = Router::new()
            .route(
                "/electron/oauth/record",
                post(electron_refresh_record_broker),
            )
            .route(
                "/electron/oauth/record/update",
                post(electron_refresh_record_update),
            )
            .route(
                "/electron/oauth/record/invalidate",
                post(electron_refresh_record_invalidate),
            )
            .with_state(broker_state);
        let (broker_shutdown_tx, broker_shutdown_rx) = oneshot::channel::<()>();
        let broker_join = tokio::spawn(async move {
            let _ = axum::serve(broker_listener, broker_app)
                .with_graceful_shutdown(async {
                    let _ = broker_shutdown_rx.await;
                })
                .await;
        });

        let token = "portico_mcp_slack_fixed_scope";
        let registry_file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(
            registry_file.path(),
            json!({
                "version": 1,
                "tokens": [{
                    "clientId": "mcpo-slack",
                    "displayName": "Slack OAuth runtime",
                    "tokenHash": test_token_hash(token, "scope-salt"),
                    "revoked": false,
                    "scopes": ["oauth:access-token:fixed-slack"],
                }],
            })
            .to_string(),
        )
        .unwrap();
        let app = Router::new().route(
            "/secrets/oauth/access-token",
            post(vend_oauth_access_token).with_state(SecretBrokerState {
                auth: BridgeAuth::new(Some(registry_file.path().to_path_buf())),
                electron_bridge_status_url: None,
                electron_broker_url: Some(format!("http://{broker_addr}/electron/oauth/record")),
                electron_broker_update_url: Some(format!(
                    "http://{broker_addr}/electron/oauth/record/update"
                )),
                electron_broker_invalidate_url: Some(format!(
                    "http://{broker_addr}/electron/oauth/record/invalidate"
                )),
                electron_static_secret_broker_url: None,
                electron_broker_token: None,
                oauth_refresh_locks: new_oauth_refresh_locks(),
                http: reqwest::Client::new(),
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let join = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        let client = reqwest::Client::new();
        let matching = client
            .post(format!("http://{addr}/secrets/oauth/access-token"))
            .bearer_auth(token)
            .json(&json!({"server_id": server_id}))
            .send()
            .await
            .unwrap();
        assert_eq!(matching.status(), StatusCode::OK);
        assert_eq!(
            matching.json::<Value>().await.unwrap()["access_token"],
            json!("fixed-client-access-token")
        );

        record.lock().await["client_info"]["client_id"] = json!("custom-client-id");
        let mismatched = client
            .post(format!("http://{addr}/secrets/oauth/access-token"))
            .bearer_auth(token)
            .json(&json!({"server_id": server_id}))
            .send()
            .await
            .unwrap();
        assert_eq!(mismatched.status(), StatusCode::PRECONDITION_REQUIRED);
        assert_eq!(invalidate_count.load(Ordering::SeqCst), 1);
        assert_eq!(
            invalidate_body.lock().await.as_ref().unwrap()["error_class"],
            json!("oauth_client_identity_mismatch")
        );

        let _ = shutdown_tx.send(());
        let _ = join.await;
        let _ = broker_shutdown_tx.send(());
        let _ = broker_join.await;
    }
}
