use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use http::{HeaderName, HeaderValue};
use log::{debug, info, warn};
use reqwest::StatusCode;
use rmcp::model::{CallToolRequestParams, CallToolResult, Content, ErrorData, ServerInfo, Tool};
use rmcp::service::{ClientInitializeError, Peer, RunningService, Service, ServiceError};
use rmcp::transport::{
    streamable_http_client::{StreamableHttpClientTransport, StreamableHttpClientTransportConfig},
    TokioChildProcess,
};
use rmcp::{RoleClient, ServiceExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio::time::{sleep, Instant};

use crate::classic_sse::{
    classic_sse_transport_with_client, ClassicSseClientConfig, ClassicSseTransportError,
};
use crate::config::{normalize_server_type, streamable_http_transport_candidates, ServerConfig};
use crate::managed_node::{
    prepared_managed_node_command, scrub_package_manager_env, scrub_package_manager_env_key,
    ManagedNodePackageConfig, MANAGED_NODE_PACKAGE_KEY,
};
use crate::oauth::{OAuthBinding, OAuthStreamableHttpClient};
use crate::streamable_http_reqwest_compat::CompatibleReqwestStreamableHttpClient;

const INTERNAL_HTTP_PORT: u16 = 8080;
const DEFAULT_HTTP_SUBPROCESS_HEALTH_ENDPOINT: &str = "/mcp/";
const DEFAULT_HTTP_SUBPROCESS_STARTUP_TIMEOUT_SECS: u64 = 30;
const DEFAULT_HTTP_SUBPROCESS_SHUTDOWN_TIMEOUT_SECS: u64 = 10;
const SLACK_PLAINTEXT_TOKEN_ENV_KEYS: &[&str] = &[
    "SLACK_MCP_XOXP_TOKEN",
    "SLACK_MCP_XOXB_TOKEN",
    "SLACK_MCP_XOXC_TOKEN",
    "SLACK_MCP_XOXD_TOKEN",
];

fn scrub_slack_plaintext_token_env(process: &mut Command, server_id: &str) {
    if server_id != "slack" {
        return;
    }
    for key in SLACK_PLAINTEXT_TOKEN_ENV_KEYS {
        process.env_remove(key);
    }
}

fn apply_sensitive_env_file_ingress(process: &mut Command, config: &ServerConfig) -> Result<()> {
    for env_name in &config.sensitive_env_vars {
        let env_name = env_name.trim();
        if env_name.is_empty() {
            continue;
        }
        let file_env_name = format!("{env_name}_FILE");
        let file_path = config
            .env
            .get(&file_env_name)
            .cloned()
            .or_else(|| std::env::var(&file_env_name).ok())
            .unwrap_or_default();
        let file_path = file_path.trim();
        if file_path.is_empty() {
            continue;
        }
        let value = fs::read_to_string(file_path).with_context(|| {
            format!("failed to read {file_env_name} for sensitive env '{env_name}'")
        })?;
        let value = value.trim().to_string();
        if value.is_empty() {
            continue;
        }
        process.env(env_name, value);
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderReadiness {
    NotRequired,
    Starting,
    Ready,
    Unsupported,
    ProbeFailed,
}

impl ProviderReadiness {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotRequired => "not_required",
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::Unsupported => "unsupported",
            Self::ProbeFailed => "probe_failed",
        }
    }

    pub fn allows_tool_ready(self) -> bool {
        matches!(self, Self::NotRequired | Self::Ready)
    }
}

/// Decides what a 200 readiness body means for the ready latch. A JSON
/// body with `syncing:true` is a never-block provider narrating a live
/// background directory sync — keep it as the warmup snapshot and skip
/// the latch so later probes refresh the narration. Anything else
/// (legacy plain-text "ready", JSON without syncing, syncing:false)
/// latches ready permanently, exactly the pre-never-block behavior.
fn ready_body_sync_narration(payload: Option<Value>) -> Option<Value> {
    payload.filter(|body| {
        body.get("syncing")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    })
}

fn provider_readiness_from_status(status: StatusCode) -> ProviderReadiness {
    if status.is_success() {
        ProviderReadiness::Ready
    } else if status == StatusCode::SERVICE_UNAVAILABLE {
        ProviderReadiness::Starting
    } else if status == StatusCode::NOT_FOUND || status == StatusCode::METHOD_NOT_ALLOWED {
        ProviderReadiness::Unsupported
    } else {
        ProviderReadiness::ProbeFailed
    }
}

#[async_trait]
pub trait McpSession: Send + Sync {
    async fn list_tools(&self) -> Result<Vec<Tool>>;
    async fn call_tool(&self, request: CallToolRequestParams) -> Result<CallToolResult>;
    async fn close(&self) -> Result<()>;
    async fn provider_readiness(&self) -> ProviderReadiness {
        ProviderReadiness::NotRequired
    }
    /// Latest structured warmup snapshot captured from a not-ready
    /// readiness probe (None once ready or for providers without a
    /// readiness contract).
    fn provider_warmup(&self) -> Option<Value> {
        None
    }
    fn peer_info(&self) -> Option<ServerInfo>;
    fn is_closed(&self) -> bool;
}

struct RmcpSession<S>
where
    S: Service<RoleClient> + Send + Sync + 'static,
{
    peer: Peer<RoleClient>,
    peer_info: Option<ServerInfo>,
    running: Mutex<Option<RunningService<RoleClient, S>>>,
}

impl<S> RmcpSession<S>
where
    S: Service<RoleClient> + Send + Sync + 'static,
{
    fn new(running: RunningService<RoleClient, S>) -> Self {
        let peer = running.peer().clone();
        let peer_info = peer.peer_info().cloned();
        Self {
            peer,
            peer_info,
            running: Mutex::new(Some(running)),
        }
    }
}

#[async_trait]
impl<S> McpSession for RmcpSession<S>
where
    S: Service<RoleClient> + Send + Sync + 'static,
{
    async fn list_tools(&self) -> Result<Vec<Tool>> {
        self.peer
            .list_all_tools()
            .await
            .context("failed to list tools")
    }

    async fn call_tool(&self, request: CallToolRequestParams) -> Result<CallToolResult> {
        match self.peer.call_tool(request).await {
            Ok(result) => Ok(result),
            Err(ServiceError::McpError(error)) => Ok(call_tool_result_from_mcp_error(error)),
            Err(error) => Err(anyhow!("tool call failed: {error}")),
        }
    }

    async fn close(&self) -> Result<()> {
        let mut guard = self.running.lock().await;
        if let Some(running) = guard.take() {
            running
                .cancel()
                .await
                .context("failed to close rmcp session")?;
        }
        Ok(())
    }

    fn peer_info(&self) -> Option<ServerInfo> {
        self.peer_info.clone()
    }

    fn is_closed(&self) -> bool {
        self.peer.is_transport_closed()
    }
}

fn call_tool_result_from_mcp_error(error: ErrorData) -> CallToolResult {
    let message = error.message.to_string();
    let structured_content = match error.data {
        Some(Value::Object(mut object)) => {
            object
                .entry("message".to_string())
                .or_insert(Value::String(message.clone()));
            object
                .entry("code".to_string())
                .or_insert(json!(error.code.0));
            Some(Value::Object(object))
        }
        Some(data) => Some(json!({
            "message": message,
            "code": error.code.0,
            "data": data,
        })),
        None => None,
    };

    let mut result = match structured_content {
        Some(structured) => CallToolResult::structured_error(structured),
        None => CallToolResult::error(vec![Content::text(message.clone())]),
    };

    if result.content.is_empty() {
        result.content.push(Content::text(message));
    } else {
        result.content = vec![Content::text(message)];
    }
    result
}

fn is_oauth_conflicting_header(name: &HeaderName) -> bool {
    matches!(
        name.as_str().to_ascii_lowercase().as_str(),
        "authorization" | "proxy-authorization" | "x-api-key" | "api-key" | "x-auth-token"
    )
}

fn sanitize_headers_for_oauth_transport(
    server_id: &str,
    mut headers: HashMap<HeaderName, HeaderValue>,
) -> HashMap<HeaderName, HeaderValue> {
    let suppressed = headers
        .keys()
        .filter(|name| is_oauth_conflicting_header(name))
        .cloned()
        .collect::<Vec<_>>();
    if suppressed.is_empty() {
        return headers;
    }

    for header_name in &suppressed {
        headers.remove(header_name);
    }

    info!(
        "[{}] suppressing static auth headers while OAuth transport is active: {}",
        server_id,
        suppressed
            .iter()
            .map(|name| name.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    );
    headers
}

async fn mark_persistent_oauth_unauthorized_failure(
    oauth_binding: &Arc<OAuthBinding>,
    transport: &str,
    attempts: usize,
    repeated_challenge: bool,
    auth_header: Option<&str>,
) {
    oauth_binding
        .mark_persistent_unauthorized_failure(
            &format!(
                "persistent unauthorized response from {transport} after {attempts} connection attempts (repeated_challenge={repeated_challenge})"
            ),
            auth_header,
        )
        .await;
}

struct HttpSubprocessSession {
    server_name: String,
    inner: Arc<dyn McpSession>,
    child: Mutex<Option<Child>>,
    shutdown_timeout: Duration,
    readiness_url: Option<String>,
    readiness_ready: AtomicBool,
    /// Last structured warmup payload from a 503 readiness probe (the
    /// provider's WarmupStatus JSON: phase, elapsed_seconds,
    /// progress_percent, ...). Cleared once the provider reports ready.
    /// std::sync::Mutex because reads are sync (status assembly) and the
    /// critical sections never hold the lock across an await.
    warmup_status: std::sync::Mutex<Option<Value>>,
    /// Runtime-secret files (0600) that were materialized for this session,
    /// currently only the OAuth access-token ingress file when the server is
    /// configured with `oauth_access_token_file_env`. Wiped in `close()` and
    /// by `Drop` so a crashed worker never leaves the plaintext token in tmpfs
    /// for longer than the session that owned it.
    ///
    /// Uses a std::sync::Mutex (not tokio's) so `Drop` — which cannot await —
    /// can still reap the files on abort / panic paths without deadlocking.
    /// The lock is never held across an `.await`; the critical sections are
    /// a single `drain(..)` each.
    ephemeral_secret_files: std::sync::Mutex<Vec<PathBuf>>,
}

impl HttpSubprocessSession {
    fn new(
        server_name: impl Into<String>,
        inner: Arc<dyn McpSession>,
        child: Child,
        shutdown_timeout: Duration,
        readiness_url: Option<String>,
        ephemeral_secret_files: Vec<PathBuf>,
    ) -> Self {
        Self {
            server_name: server_name.into(),
            inner,
            child: Mutex::new(Some(child)),
            shutdown_timeout,
            readiness_url,
            readiness_ready: AtomicBool::new(false),
            warmup_status: std::sync::Mutex::new(None),
            ephemeral_secret_files: std::sync::Mutex::new(ephemeral_secret_files),
        }
    }

    fn store_warmup_status(&self, value: Option<Value>) {
        if let Ok(mut guard) = self.warmup_status.lock() {
            *guard = value;
        }
    }
}

impl Drop for HttpSubprocessSession {
    fn drop(&mut self) {
        // Best-effort synchronous wipe — captures abort / panic paths where
        // `close()` never ran. A normal shutdown already drained the vec so
        // this is a no-op.
        if let Ok(mut files) = self.ephemeral_secret_files.lock() {
            for path in files.drain(..) {
                let _ = best_effort_zeroize_and_remove(&path);
            }
        }
    }
}

#[async_trait]
impl McpSession for HttpSubprocessSession {
    async fn list_tools(&self) -> Result<Vec<Tool>> {
        self.inner.list_tools().await
    }

    async fn call_tool(&self, request: CallToolRequestParams) -> Result<CallToolResult> {
        self.inner.call_tool(request).await
    }

    async fn provider_readiness(&self) -> ProviderReadiness {
        let Some(readiness_url) = self.readiness_url.as_ref() else {
            return ProviderReadiness::NotRequired;
        };
        if self.readiness_ready.load(Ordering::Acquire) {
            return ProviderReadiness::Ready;
        }

        match reqwest::Client::new()
            .get(readiness_url)
            .timeout(Duration::from_millis(750))
            .send()
            .await
        {
            Ok(response)
                if provider_readiness_from_status(response.status())
                    == ProviderReadiness::Ready =>
            {
                // Never-block providers (slack fork r8+) return 200 from
                // second one and narrate any background directory sync in
                // the body ({"ready":true,"syncing":true,"phase":...,
                // "elapsed_seconds":...,"progress_percent":...} — the same
                // field names as the 503 WarmupStatus). While the body says
                // syncing, keep the snapshot for status assembly and skip
                // the latch so later probes refresh the narration; this
                // costs one loopback GET per status query only until the
                // sync completes, then latches exactly as before. Legacy
                // plain-text "ready" bodies fail the JSON parse and latch
                // immediately.
                match ready_body_sync_narration(response.json::<Value>().await.ok()) {
                    Some(payload) => self.store_warmup_status(Some(payload)),
                    None => {
                        self.readiness_ready.store(true, Ordering::Release);
                        self.store_warmup_status(None);
                    }
                }
                ProviderReadiness::Ready
            }
            Ok(response) => {
                let readiness = provider_readiness_from_status(response.status());
                if readiness == ProviderReadiness::Starting {
                    // The 503 body is the provider's structured WarmupStatus
                    // (phase, elapsed, progress). Keep the latest snapshot for
                    // status assembly; ignore non-JSON bodies from providers
                    // that only speak plain "warming_up".
                    if let Ok(payload) = response.json::<Value>().await {
                        self.store_warmup_status(Some(payload));
                    }
                }
                readiness
            }
            Err(_) => ProviderReadiness::ProbeFailed,
        }
    }

    fn provider_warmup(&self) -> Option<Value> {
        self.warmup_status
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
    }

    async fn close(&self) -> Result<()> {
        let inner_result = self.inner.close().await;
        let mut child_guard = self.child.lock().await;
        let child_result =
            stop_child_process(&self.server_name, &mut *child_guard, self.shutdown_timeout).await;
        drop(child_guard);
        // Only wipe the ephemeral files AFTER the child has exited. If we
        // unlinked the token file while the subprocess was still reading it
        // at startup we could leave Slack/etc. stuck reconnecting against a
        // non-existent path.
        let to_wipe: Vec<PathBuf> = match self.ephemeral_secret_files.lock() {
            Ok(mut files) => files.drain(..).collect(),
            Err(poisoned) => poisoned.into_inner().drain(..).collect(),
        };
        for path in to_wipe {
            if let Err(error) = best_effort_zeroize_and_remove(&path) {
                warn!(
                    "[{}] failed to wipe ephemeral secret file '{}': {}",
                    self.server_name,
                    path.display(),
                    error
                );
            }
        }
        inner_result?;
        child_result
    }

    fn peer_info(&self) -> Option<ServerInfo> {
        self.inner.peer_info()
    }

    fn is_closed(&self) -> bool {
        self.inner.is_closed()
    }
}

#[derive(Debug, Clone, Deserialize)]
struct HttpSubprocessConfig {
    #[serde(default = "default_http_subprocess_enabled")]
    enabled: bool,
    #[serde(default = "default_http_subprocess_health_endpoint")]
    health_endpoint: String,
    #[serde(default)]
    readiness_endpoint: Option<String>,
    #[serde(default = "default_http_subprocess_startup_timeout_secs")]
    startup_timeout: u64,
    #[serde(default = "default_http_subprocess_shutdown_timeout_secs")]
    shutdown_timeout: u64,
    /// Back-compat ingress: inject the stored OAuth access token directly
    /// into this env var before spawning the subprocess. This leaves the
    /// plaintext token visible in the child's `/proc/<pid>/environ`, `ps eww`,
    /// and any further subprocess it spawns. Prefer
    /// `oauth_access_token_file_env`; product configs must not use this path
    /// for Slack.
    #[serde(default)]
    oauth_access_token_env: Option<String>,
    /// Preferred ingress for servers that support a `<VAR>_FILE`-style
    /// contract: write the broker-vended OAuth access token to a 0600 tmpfs
    /// file and export the path via this env var. The file is wiped when
    /// the session closes (and best-effort on Drop for abort paths).
    /// Mirrors the PORTICO-68 `_FILE` pattern used for `PORTICO_LLM_API_KEY_FILE`
    /// etc. — the plaintext value never crosses the container env boundary
    /// and never appears in `ps eww` / `/proc/<pid>/environ`.
    #[serde(default)]
    oauth_access_token_file_env: Option<String>,
}

fn default_http_subprocess_enabled() -> bool {
    true
}

/// Resolve the container-internal tmpfs directory for ephemeral OAuth token
/// files written by `oauth_access_token_file_env`.
///
/// Resolution order:
/// 1. `PORTICO_OAUTH_TOKEN_CACHE_DIR` override (test harness / custom ops).
/// 2. `PORTICO_RUNTIME_SECRET_CACHE_DIR/oauth-tokens` when configured.
/// 3. `/dev/shm/portico-oauth-tokens` when available (Docker tmpfs).
/// 4. Linux/other fallback under `$XDG_RUNTIME_DIR`, then `$HOME/.local/state`.
fn oauth_token_cache_dir() -> Result<PathBuf> {
    if let Ok(override_dir) = std::env::var("PORTICO_OAUTH_TOKEN_CACHE_DIR") {
        let trimmed = override_dir.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    if let Ok(runtime_secret_cache_dir) = std::env::var("PORTICO_RUNTIME_SECRET_CACHE_DIR") {
        let trimmed = runtime_secret_cache_dir.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed).join("oauth-tokens"));
        }
    }
    let dev_shm = PathBuf::from("/dev/shm");
    if dev_shm.is_dir() {
        return Ok(dev_shm.join("portico-oauth-tokens"));
    }
    if let Ok(xdg_runtime_dir) = std::env::var("XDG_RUNTIME_DIR") {
        let trimmed = xdg_runtime_dir.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed)
                .join("portico")
                .join("oauth-tokens"));
        }
    }
    let home = std::env::var("HOME").context("$HOME is not set — cannot resolve cache dir")?;
    let xdg = std::env::var("XDG_STATE_HOME")
        .ok()
        .and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(PathBuf::from(trimmed))
            }
        })
        .unwrap_or_else(|| PathBuf::from(home).join(".local").join("state"));
    Ok(xdg.join("portico").join("oauth-tokens"))
}

/// Write an OAuth access token to a 0600 tmpfs file and return the path. The
/// directory is created with 0700 perms on first use.
fn write_oauth_token_file(server_id: &str, token: &str) -> Result<PathBuf> {
    let dir = oauth_token_cache_dir()?;
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("failed to create OAuth token cache dir '{}'", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }

    // Filename: <server_id>.token. server_id values are operator-provided
    // config keys (already constrained to [A-Za-z0-9_-] elsewhere), but
    // sanitise defensively to keep the path inside the cache dir.
    let sanitized: String = server_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let path = dir.join(format!("{sanitized}.token"));

    // Write → fsync → chmod 0600. On unix we also open with mode 0600 up
    // front via OpenOptions so the file is never 0644-readable even for a
    // single scheduler tick under umask 022.
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)
            .with_context(|| format!("failed to open OAuth token file '{}'", path.display()))?;
        file.write_all(token.as_bytes())
            .with_context(|| format!("failed to write OAuth token file '{}'", path.display()))?;
        file.sync_all().ok();
    }
    #[cfg(not(unix))]
    {
        std::fs::write(&path, token.as_bytes())
            .with_context(|| format!("failed to write OAuth token file '{}'", path.display()))?;
    }
    Ok(path)
}

/// Overwrite the file with zeros (best effort) and then remove it. The
/// zeroize step makes the plaintext unrecoverable from the block a moment
/// after the unlink even if the FS reuses inodes lazily.
fn best_effort_zeroize_and_remove(path: &Path) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    if let Ok(metadata) = std::fs::metadata(path) {
        let len = metadata.len();
        if len > 0 && len < 64 * 1024 {
            // Only zeroize for small files (access tokens are well under 64KB).
            // Large files likely aren't secrets we wrote.
            let zeros = vec![0u8; len as usize];
            let _ = std::fs::write(path, &zeros);
        }
    }
    std::fs::remove_file(path)
        .with_context(|| format!("failed to remove secret file '{}'", path.display()))
}

fn default_http_subprocess_health_endpoint() -> String {
    DEFAULT_HTTP_SUBPROCESS_HEALTH_ENDPOINT.to_string()
}

fn default_http_subprocess_startup_timeout_secs() -> u64 {
    DEFAULT_HTTP_SUBPROCESS_STARTUP_TIMEOUT_SECS
}

fn default_http_subprocess_shutdown_timeout_secs() -> u64 {
    DEFAULT_HTTP_SUBPROCESS_SHUTDOWN_TIMEOUT_SECS
}

pub async fn connect_server(
    server_id: &str,
    config: &ServerConfig,
    oauth: Option<Arc<OAuthBinding>>,
) -> Result<Arc<dyn McpSession>> {
    if let Some(http_subprocess_value) = config.http_subprocess.as_ref() {
        let http_subprocess: HttpSubprocessConfig =
            serde_json::from_value(http_subprocess_value.clone()).with_context(|| {
                format!("invalid http_subprocess config for server '{server_id}'")
            })?;
        if http_subprocess.enabled {
            return connect_http_subprocess(server_id, config, oauth, &http_subprocess).await;
        }
    }

    match normalize_server_type(config.server_type.as_deref()).as_deref() {
        Some("streamable-http") => connect_streamable_http(server_id, config, oauth).await,
        Some("sse") => connect_sse(server_id, config, oauth).await,
        _ => connect_stdio(server_id, config).await,
    }
}

async fn connect_http_subprocess(
    server_id: &str,
    config: &ServerConfig,
    oauth: Option<Arc<OAuthBinding>>,
    http_subprocess: &HttpSubprocessConfig,
) -> Result<Arc<dyn McpSession>> {
    let mut retried_after_oauth_refresh = false;
    loop {
        match connect_http_subprocess_once(server_id, config, oauth.clone(), http_subprocess).await
        {
            Ok(session) => return Ok(session),
            Err(error)
                if !retried_after_oauth_refresh
                    && oauth.is_some()
                    && should_retry_http_subprocess_after_oauth_refresh(&error) =>
            {
                let binding = oauth.as_ref().expect("checked oauth.is_some()");
                warn!(
                    "[{}] OAuth-backed http_subprocess exited before readiness; attempting one token refresh before retry: {error:#}",
                    server_id
                );
                match binding.refresh_or_reauthorize().await {
                    Ok(crate::oauth::OAuthRefreshOutcome::Refreshed) => {
                        retried_after_oauth_refresh = true;
                        info!(
                            "[{}] OAuth refresh succeeded after http_subprocess startup failure; retrying startup",
                            server_id
                        );
                    }
                    Ok(crate::oauth::OAuthRefreshOutcome::AuthorizationRequired(
                        authorization_url,
                    )) => {
                        let authorization_url = match binding
                            .restart_authorization_after_transport_unauthorized(
                                "http_subprocess_startup_failure",
                            )
                            .await
                        {
                            Ok(url) => url,
                            Err(clear_error) => {
                                return Err(error).with_context(|| {
                                    format!(
                                        "[{server_id}] OAuth re-authorization required after http_subprocess startup failure, but failed to clear stale token state: {clear_error:#}; previous_authorization_url={authorization_url}"
                                    )
                                });
                            }
                        };
                        return Err(error).with_context(|| {
                            format!(
                                "[{server_id}] OAuth re-authorization required after http_subprocess startup failure; authorization_url={authorization_url}"
                            )
                        });
                    }
                    Err(refresh_error) => {
                        return Err(error).with_context(|| {
                            format!(
                                "[{server_id}] OAuth refresh failed after http_subprocess startup failure: {refresh_error:#}"
                            )
                        });
                    }
                }
            }
            Err(error) => return Err(error),
        }
    }
}

fn should_retry_http_subprocess_after_oauth_refresh(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.to_string().contains("exited before ready"))
}

async fn connect_http_subprocess_once(
    server_id: &str,
    config: &ServerConfig,
    oauth: Option<Arc<OAuthBinding>>,
    http_subprocess: &HttpSubprocessConfig,
) -> Result<Arc<dyn McpSession>> {
    let managed_node_package = managed_node_package_config(config)?;
    let (command, args) = if let Some(managed) = managed_node_package.as_ref() {
        prepared_managed_node_command(server_id, managed)?
    } else {
        (
            config
                .command
                .as_ref()
                .ok_or_else(|| anyhow!("http_subprocess server '{server_id}' is missing command"))?
                .clone(),
            http_subprocess_args(config),
        )
    };
    let mut process = Command::new(&command);
    process.args(&args);
    process.envs(config.env.iter().map(|(key, value)| (key, value)));
    apply_sensitive_env_file_ingress(&mut process, config)?;
    scrub_slack_plaintext_token_env(&mut process, server_id);
    if managed_node_package.is_some() {
        for key in config.env.keys() {
            scrub_package_manager_env_key(&mut process, key);
        }
        scrub_package_manager_env(&mut process);
    }
    process.env("MCP_HTTP_PORT", INTERNAL_HTTP_PORT.to_string());
    process.env("MCP_TRANSPORT", "streamable-http");

    // Inject the stored OAuth access token — preferring the file-ingress
    // path when the server supports it, and falling back to the plaintext
    // env var for upstream servers that still only read `$VAR`.
    //
    // Security trade-off: `oauth_access_token_env` leaves the token in the
    // child's `/proc/<pid>/environ` / `ps eww` / every grandchild it spawns.
    // `oauth_access_token_file_env` keeps the plaintext on disk only, gated
    // behind `0600` perms in a user-scoped cache, and the file is wiped
    // when the session closes (see HttpSubprocessSession::close + Drop).
    let mut ephemeral_secret_files: Vec<PathBuf> = Vec::new();
    if let Some(binding) = oauth.as_ref() {
        let token = match binding.access_token().await {
            Ok(Some(token)) => Some(token),
            Ok(None) => None,
            Err(error) => {
                warn!(
                    "[{}] could not load OAuth access token for http_subprocess injection: {}",
                    server_id, error
                );
                None
            }
        };
        if let Some(token) = token {
            if let Some(file_env) = http_subprocess.oauth_access_token_file_env.as_deref() {
                match write_oauth_token_file(server_id, &token) {
                    Ok(path) => {
                        info!(
                            "[{}] injecting OAuth access token via file-ingress env var '{}' -> '{}'",
                            server_id,
                            file_env,
                            path.display()
                        );
                        process.env(file_env, &path);
                        ephemeral_secret_files.push(path);
                    }
                    Err(error) => {
                        // Fail closed on file-ingress errors so we do not
                        // silently downgrade to the plaintext-env path. The
                        // caller knows OAuth is expected and will surface a
                        // clear startup failure.
                        return Err(error).with_context(|| {
                            format!(
                                "[{server_id}] failed to materialise OAuth token file for '{file_env}'"
                            )
                        });
                    }
                }
            } else if let Some(env_name) = http_subprocess.oauth_access_token_env.as_deref() {
                info!(
                    "[{}] injecting OAuth access token via plaintext env var '{}' \
                     (consider migrating the server to '{env_name}_FILE' file-ingress; \
                     see docs/security-hardening-overview.md#F5)",
                    server_id, env_name
                );
                process.env(env_name, token);
            }
        }
    }

    process.stdout(Stdio::inherit());
    process.stderr(Stdio::inherit());
    process.kill_on_drop(true);

    info!(
        "starting native http_subprocess for '{}' with command '{}'",
        server_id, command
    );
    debug!(
        "http_subprocess '{}' args={:?} env_keys={:?}",
        server_id,
        http_subprocess_args(config),
        config.env.keys().collect::<Vec<_>>()
    );

    let mut child = process
        .spawn()
        .with_context(|| format!("failed to spawn http_subprocess for '{server_id}'"))?;

    let health_url = http_subprocess_health_url(&http_subprocess.health_endpoint);
    if let Err(error) = wait_for_http_subprocess_ready(
        server_id,
        &mut child,
        &health_url,
        Duration::from_secs(http_subprocess.startup_timeout),
    )
    .await
    {
        let mut child_slot = Some(child);
        let _ = stop_child_process(
            server_id,
            &mut child_slot,
            Duration::from_secs(http_subprocess.shutdown_timeout),
        )
        .await;
        for path in &ephemeral_secret_files {
            let _ = best_effort_zeroize_and_remove(path);
        }
        return Err(error);
    }

    let mut streamable_config = config.clone();
    streamable_config.server_type = Some("streamable-http".to_string());
    streamable_config.url = Some(http_subprocess_mcp_url());
    streamable_config.http_subprocess = None;

    match connect_streamable_http(server_id, &streamable_config, oauth).await {
        Ok(inner) => Ok(Arc::new(HttpSubprocessSession::new(
            server_id,
            inner,
            child,
            Duration::from_secs(http_subprocess.shutdown_timeout),
            http_subprocess_readiness_url(server_id, http_subprocess),
            ephemeral_secret_files,
        ))),
        Err(error) => {
            let mut child_slot = Some(child);
            let _ = stop_child_process(
                server_id,
                &mut child_slot,
                Duration::from_secs(http_subprocess.shutdown_timeout),
            )
            .await;
            for path in &ephemeral_secret_files {
                let _ = best_effort_zeroize_and_remove(path);
            }
            Err(error)
        }
    }
}

async fn connect_stdio(server_id: &str, config: &ServerConfig) -> Result<Arc<dyn McpSession>> {
    let managed_node_package = managed_node_package_config(config)?;
    let (command, args) = if let Some(managed) = managed_node_package.as_ref() {
        prepared_managed_node_command(server_id, managed)?
    } else {
        (
            config
                .command
                .as_ref()
                .ok_or_else(|| anyhow!("stdio server '{server_id}' is missing command"))?
                .clone(),
            config.args.clone(),
        )
    };

    let mut process = Command::new(&command);
    process.args(&args);
    process.envs(config.env.iter().map(|(key, value)| (key, value)));
    apply_sensitive_env_file_ingress(&mut process, config)?;
    if managed_node_package.is_some() {
        for key in config.env.keys() {
            scrub_package_manager_env_key(&mut process, key);
        }
        scrub_package_manager_env(&mut process);
    }

    let transport = TokioChildProcess::new(process)
        .with_context(|| format!("failed to spawn stdio transport for '{server_id}'"))?;
    let running = ()
        .serve(transport)
        .await
        .with_context(|| format!("failed to connect stdio server '{server_id}'"))?;
    Ok(Arc::new(RmcpSession::new(running)))
}

fn managed_node_package_config(config: &ServerConfig) -> Result<Option<ManagedNodePackageConfig>> {
    config
        .extra
        .get(MANAGED_NODE_PACKAGE_KEY)
        .map(|value| {
            serde_json::from_value(value.clone())
                .context("invalid managed_node_package config in MCP server config")
        })
        .transpose()
}

async fn connect_streamable_http(
    server_id: &str,
    config: &ServerConfig,
    oauth: Option<Arc<OAuthBinding>>,
) -> Result<Arc<dyn McpSession>> {
    let url = config
        .url
        .as_ref()
        .ok_or_else(|| anyhow!("streamable-http server '{server_id}' is missing url"))?;
    let transport_candidates = streamable_http_transport_candidates(url);
    let headers = parse_headers(config)?;
    let headers = if oauth.is_some() {
        sanitize_headers_for_oauth_transport(server_id, headers)
    } else {
        headers
    };
    let running = if let Some(oauth_binding) = oauth {
        let mut refreshed_after_unauthorized = false;
        let mut attempts = 0usize;
        let mut last_auth_required_header: Option<String> = None;
        let mut repeated_challenge = false;
        'oauth_connection: loop {
            let mut last_unauthorized_error = None;
            let mut last_connect_error = None;
            let mut sweep_auth_header: Option<String> = None;

            for (candidate_index, transport_url) in transport_candidates.iter().enumerate() {
                attempts += 1;
                let transport = StreamableHttpClientTransport::with_client(
                    OAuthStreamableHttpClient::new(
                        CompatibleReqwestStreamableHttpClient::new(reqwest::Client::new()),
                        oauth_binding.clone(),
                    ),
                    StreamableHttpClientTransportConfig::with_uri(transport_url.clone())
                        .custom_headers(headers.clone()),
                );
                match ().serve(transport).await {
                    Ok(running) => break 'oauth_connection running,
                    Err(error) => {
                        let unauthorized =
                            if let Some(auth_required) = find_auth_required_error(&error) {
                                let challenge = auth_required.www_authenticate_header.clone();
                                repeated_challenge |= last_auth_required_header.as_deref()
                                    == Some(challenge.as_str());
                                last_auth_required_header = Some(challenge.clone());
                                if sweep_auth_header.is_none() {
                                    sweep_auth_header = Some(challenge);
                                }
                                true
                            } else {
                                find_unexpected_unauthorized_error(&error).is_some()
                            };

                        if unauthorized {
                            last_unauthorized_error = Some(error);
                        } else {
                            last_connect_error = Some(error);
                        }

                        if let Some(next_candidate) = transport_candidates.get(candidate_index + 1)
                        {
                            warn!(
                                "[{}] trying alternate streamable-http transport candidate before OAuth refresh: {} -> {}",
                                server_id, transport_url, next_candidate
                            );
                        }
                    }
                }
            }

            let Some(unauthorized_error) = last_unauthorized_error else {
                let error = last_connect_error.expect("transport candidates must produce an error");
                return Err(error).with_context(|| {
                    format!("failed to connect streamable-http server '{server_id}'")
                });
            };

            if refreshed_after_unauthorized {
                mark_persistent_oauth_unauthorized_failure(
                    &oauth_binding,
                    "streamable-http candidate sweep",
                    attempts,
                    repeated_challenge,
                    sweep_auth_header.as_deref(),
                )
                .await;
                return Err(unauthorized_error).with_context(|| {
                    format!(
                        "failed to connect streamable-http server '{server_id}' after every transport candidate rejected the refreshed OAuth token"
                    )
                });
            }

            match oauth_binding
                .handle_unauthorized_header(sweep_auth_header.as_deref())
                .await?
            {
                crate::oauth::OAuthRefreshOutcome::Refreshed => {
                    refreshed_after_unauthorized = true;
                    info!(
                        "[{}] retrying all streamable-http transport candidates after one OAuth refresh",
                        server_id
                    );
                }
                crate::oauth::OAuthRefreshOutcome::AuthorizationRequired(authorization_url) => {
                    return Err(anyhow!(
                        "OAuth authorization required for server '{server_id}'; authorization_url={authorization_url}"
                    ));
                }
            }
        }
    } else {
        let mut last_auth_error = None;
        let mut last_connect_error = None;
        let mut connected = None;
        for (candidate_index, transport_url) in transport_candidates.iter().enumerate() {
            let transport = StreamableHttpClientTransport::with_client(
                CompatibleReqwestStreamableHttpClient::new(reqwest::Client::new()),
                StreamableHttpClientTransportConfig::with_uri(transport_url.clone())
                    .custom_headers(headers.clone()),
            );
            match ().serve(transport).await {
                Ok(running) => {
                    connected = Some(running);
                    break;
                }
                Err(error) => {
                    if find_auth_required_error(&error).is_some()
                        || find_unexpected_unauthorized_error(&error).is_some()
                    {
                        last_auth_error = Some(error);
                    } else {
                        last_connect_error = Some(error);
                    }
                    if let Some(next_candidate) = transport_candidates.get(candidate_index + 1) {
                        warn!(
                            "[{}] switching streamable-http transport candidate after connect failure: {} -> {}",
                            server_id, transport_url, next_candidate
                        );
                    }
                }
            }
        }
        if let Some(running) = connected {
            running
        } else {
            let error = last_auth_error
                .or(last_connect_error)
                .expect("transport candidates must produce an error");
            return Err(error).with_context(|| {
                format!("failed to connect streamable-http server '{server_id}'")
            });
        }
    };
    Ok(Arc::new(RmcpSession::new(running)))
}

async fn connect_sse(
    server_id: &str,
    config: &ServerConfig,
    oauth: Option<Arc<OAuthBinding>>,
) -> Result<Arc<dyn McpSession>> {
    let url = config
        .url
        .as_ref()
        .ok_or_else(|| anyhow!("sse server '{server_id}' is missing url"))?;
    let headers = parse_headers(config)?;
    let headers = if oauth.is_some() {
        sanitize_headers_for_oauth_transport(server_id, headers)
    } else {
        headers
    };

    let running = if let Some(oauth_binding) = oauth {
        let mut attempts = 0usize;
        let mut last_auth_required_header: Option<String> = None;
        let mut refreshed_after_unauthorized = false;
        loop {
            attempts += 1;
            let mut transport_config =
                ClassicSseClientConfig::with_uri(url.clone()).custom_headers(headers.clone());
            let access_token = oauth_binding.access_token().await?;
            let probe = probe_sse_endpoint(url, &headers, access_token.as_deref()).await?;
            if probe.status == StatusCode::UNAUTHORIZED || probe.status == StatusCode::FORBIDDEN {
                let challenge = probe.www_authenticate_header.clone();
                let repeated_challenge = challenge
                    .as_deref()
                    .is_some_and(|value| last_auth_required_header.as_deref() == Some(value));
                if refreshed_after_unauthorized {
                    mark_persistent_oauth_unauthorized_failure(
                        &oauth_binding,
                        "sse probe",
                        attempts,
                        repeated_challenge,
                        challenge.as_deref(),
                    )
                    .await;
                    bail!(
                        "failed to connect sse server '{server_id}' after refreshed OAuth token was rejected"
                    );
                }
                match oauth_binding
                    .handle_unauthorized_header(challenge.as_deref())
                    .await?
                {
                    crate::oauth::OAuthRefreshOutcome::Refreshed => {
                        refreshed_after_unauthorized = true;
                        last_auth_required_header = challenge;
                        info!(
                            "[{}] retried native SSE probe after OAuth refresh",
                            server_id
                        );
                        continue;
                    }
                    crate::oauth::OAuthRefreshOutcome::AuthorizationRequired(authorization_url) => {
                        bail!(
                            "OAuth authorization required for server '{server_id}'; authorization_url={authorization_url}"
                        );
                    }
                }
            }
            if !probe.status.is_success() && !probe.status.is_redirection() {
                bail!(
                    "failed to probe sse server '{server_id}' with HTTP {}",
                    probe.status
                );
            }
            if let Some(access_token) = access_token {
                transport_config = transport_config.auth_header(access_token);
            }

            let transport =
                classic_sse_transport_with_client(reqwest::Client::new(), transport_config);
            match ().serve(transport).await {
                Ok(running) => break running,
                Err(error) => {
                    if let Some(unauthorized) = find_classic_sse_unauthorized_error(&error) {
                        let challenge = unauthorized.www_authenticate_header().map(str::to_string);
                        let repeated_challenge = challenge.as_deref().is_some_and(|value| {
                            last_auth_required_header.as_deref() == Some(value)
                        });
                        if refreshed_after_unauthorized {
                            mark_persistent_oauth_unauthorized_failure(
                                &oauth_binding,
                                "sse connect",
                                attempts,
                                repeated_challenge,
                                challenge.as_deref(),
                            )
                            .await;
                            return Err(error).with_context(|| {
                                format!(
                                    "failed to connect sse server '{server_id}' after refreshed OAuth token was rejected"
                                )
                            });
                        }
                        match oauth_binding
                            .handle_unauthorized_header(challenge.as_deref())
                            .await?
                        {
                            crate::oauth::OAuthRefreshOutcome::Refreshed => {
                                refreshed_after_unauthorized = true;
                                last_auth_required_header = challenge;
                                info!(
                                    "[{}] retried native SSE connection after OAuth refresh",
                                    server_id
                                );
                                continue;
                            }
                            crate::oauth::OAuthRefreshOutcome::AuthorizationRequired(
                                authorization_url,
                            ) => {
                                return Err(anyhow!(
                                    "OAuth authorization required for server '{server_id}'; authorization_url={authorization_url}"
                                ));
                            }
                        }
                    }
                    return Err(error)
                        .with_context(|| format!("failed to connect sse server '{server_id}'"));
                }
            }
        }
    } else {
        let transport = classic_sse_transport_with_client(
            reqwest::Client::new(),
            ClassicSseClientConfig::with_uri(url.clone()).custom_headers(headers),
        );
        ().serve(transport)
            .await
            .with_context(|| format!("failed to connect sse server '{server_id}'"))?
    };

    Ok(Arc::new(RmcpSession::new(running)))
}

fn http_subprocess_args(config: &ServerConfig) -> Vec<String> {
    let mut args = config.args.clone();
    if !args.iter().any(|value| value == "--transport") {
        args.extend(["--transport".to_string(), "streamable-http".to_string()]);
    }
    args
}

fn http_subprocess_health_url(health_endpoint: &str) -> String {
    format!(
        "http://127.0.0.1:{INTERNAL_HTTP_PORT}{}",
        normalize_health_endpoint(health_endpoint)
    )
}

fn http_subprocess_readiness_url(server_id: &str, config: &HttpSubprocessConfig) -> Option<String> {
    let endpoint = config
        .readiness_endpoint
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| (server_id == "slack").then_some("/health"))?;
    Some(http_subprocess_health_url(endpoint))
}

pub(crate) fn http_subprocess_mcp_url() -> String {
    format!("http://127.0.0.1:{INTERNAL_HTTP_PORT}/mcp/")
}

fn normalize_health_endpoint(health_endpoint: &str) -> String {
    if health_endpoint.starts_with('/') {
        health_endpoint.to_string()
    } else {
        format!("/{health_endpoint}")
    }
}

async fn wait_for_http_subprocess_ready(
    server_id: &str,
    child: &mut Child,
    health_url: &str,
    timeout: Duration,
) -> Result<()> {
    info!(
        "waiting for native http_subprocess '{}' to become ready at {} (timeout={}s)",
        server_id,
        health_url,
        timeout.as_secs()
    );
    let client = reqwest::Client::new();
    let deadline = Instant::now() + timeout;
    let mut last_error = "connection refused".to_string();

    while Instant::now() < deadline {
        if let Some(status) = child
            .try_wait()
            .with_context(|| format!("failed to poll http_subprocess '{server_id}'"))?
        {
            bail!("http_subprocess '{server_id}' exited before ready with status {status}");
        }

        match client
            .get(health_url)
            .timeout(Duration::from_secs(2))
            .send()
            .await
        {
            Ok(response) if !response.status().is_server_error() => {
                info!(
                    "native http_subprocess '{}' passed health check with HTTP {}",
                    server_id,
                    response.status()
                );
                return Ok(());
            }
            Ok(response) => {
                last_error = format!("HTTP {}", response.status());
            }
            Err(error) => {
                last_error = error.to_string();
            }
        }

        sleep(Duration::from_millis(500)).await;
    }

    bail!(
        "http_subprocess '{server_id}' did not become ready within {}s (last error: {last_error})",
        timeout.as_secs()
    )
}

async fn stop_child_process(
    server_id: &str,
    child_slot: &mut Option<Child>,
    shutdown_timeout: Duration,
) -> Result<()> {
    let Some(child) = child_slot.as_mut() else {
        return Ok(());
    };

    if let Some(status) = child
        .try_wait()
        .with_context(|| format!("failed to poll http_subprocess '{server_id}' during shutdown"))?
    {
        info!(
            "native http_subprocess '{}' already exited with status {}",
            server_id, status
        );
        *child_slot = None;
        return Ok(());
    }

    warn!("terminating native http_subprocess '{}'", server_id);
    let kill_result = child.kill();
    tokio::time::timeout(shutdown_timeout, kill_result)
        .await
        .with_context(|| format!("timed out killing http_subprocess '{server_id}'"))?
        .with_context(|| format!("failed to kill http_subprocess '{server_id}'"))?;
    let _ = tokio::time::timeout(shutdown_timeout, child.wait()).await;
    *child_slot = None;
    Ok(())
}

fn parse_headers(config: &ServerConfig) -> Result<HashMap<HeaderName, HeaderValue>> {
    let mut parsed = HashMap::new();
    let Some(headers) = config.headers.as_ref() else {
        return Ok(parsed);
    };
    let Some(object) = headers.as_object() else {
        bail!("headers must be a JSON object");
    };

    for (name, value) in object {
        let string_value = value
            .as_str()
            .ok_or_else(|| anyhow!("header '{name}' must be a string"))?;
        let header_name = HeaderName::try_from(name.as_str())
            .with_context(|| format!("invalid header name '{name}'"))?;
        let normalized_value = if header_name.as_str().eq_ignore_ascii_case("authorization") {
            normalize_authorization_header_value(string_value)
        } else {
            string_value.trim().to_string()
        };
        let header_value = HeaderValue::try_from(normalized_value.as_str())
            .with_context(|| format!("invalid header value for '{name}'"))?;
        parsed.insert(header_name, header_value);
    }

    Ok(parsed)
}

fn has_explicit_authorization_scheme(value: &str) -> bool {
    let mut parts = value.split_whitespace();
    let Some(scheme) = parts.next() else {
        return false;
    };
    if parts.next().is_none() {
        return false;
    }

    let mut chars = scheme.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphabetic() {
        return false;
    }
    chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '~' | '+' | '-' | '/'))
}

fn normalize_authorization_header_value(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if matches!(trimmed.to_ascii_lowercase().as_str(), "bearer" | "basic") {
        return trimmed.to_string();
    }
    if has_explicit_authorization_scheme(trimmed) {
        return trimmed.to_string();
    }
    format!("Bearer {trimmed}")
}

pub(crate) fn streamable_http_auth_challenge_from_connect_error(
    error: &anyhow::Error,
) -> Option<String> {
    error.chain().find_map(|source| {
        source
            .downcast_ref::<ClientInitializeError>()
            .and_then(find_auth_required_error)
            .map(|auth_required| auth_required.www_authenticate_header.clone())
    })
}

fn find_auth_required_error(
    error: &ClientInitializeError,
) -> Option<&rmcp::transport::streamable_http_client::AuthRequiredError> {
    let ClientInitializeError::TransportError { error, .. } = error else {
        return None;
    };
    error
        .error
        .downcast_ref::<rmcp::transport::streamable_http_client::StreamableHttpError<
            crate::oauth::OAuthTransportError<reqwest::Error>,
        >>()
        .and_then(auth_required_from_streamable_error)
        .or_else(|| {
            error
                .error
                .downcast_ref::<rmcp::transport::streamable_http_client::StreamableHttpError<
                    reqwest::Error,
                >>()
                .and_then(auth_required_from_streamable_error)
        })
}

fn auth_required_from_streamable_error<E>(
    stream_error: &rmcp::transport::streamable_http_client::StreamableHttpError<E>,
) -> Option<&rmcp::transport::streamable_http_client::AuthRequiredError>
where
    E: std::error::Error + Send + Sync + 'static,
{
    match stream_error {
        rmcp::transport::streamable_http_client::StreamableHttpError::AuthRequired(
            auth_required,
        ) => Some(auth_required),
        _ => None,
    }
}

fn find_unexpected_unauthorized_error(error: &ClientInitializeError) -> Option<&str> {
    let ClientInitializeError::TransportError { error, .. } = error else {
        return None;
    };
    error
        .error
        .downcast_ref::<rmcp::transport::streamable_http_client::StreamableHttpError<
            crate::oauth::OAuthTransportError<reqwest::Error>,
        >>()
        .and_then(|stream_error| {
            match stream_error {
                rmcp::transport::streamable_http_client::StreamableHttpError::UnexpectedServerResponse(
                    message,
                ) if message.contains("HTTP 401 Unauthorized") => Some(message.as_ref()),
                _ => None,
            }
        })
}

fn find_classic_sse_unauthorized_error(
    error: &ClientInitializeError,
) -> Option<&ClassicSseTransportError> {
    let ClientInitializeError::TransportError { error, .. } = error else {
        return None;
    };
    error
        .error
        .downcast_ref::<ClassicSseTransportError>()
        .and_then(|transport_error| match transport_error {
            ClassicSseTransportError::Unauthorized { .. }
            | ClassicSseTransportError::InsufficientScope { .. } => Some(transport_error),
            _ => None,
        })
}

#[derive(Debug)]
struct SseProbeResult {
    status: StatusCode,
    www_authenticate_header: Option<String>,
}

async fn probe_sse_endpoint(
    url: &str,
    headers: &HashMap<HeaderName, HeaderValue>,
    access_token: Option<&str>,
) -> Result<SseProbeResult> {
    let mut request = reqwest::Client::new()
        .get(url)
        .header(reqwest::header::ACCEPT, "text/event-stream");
    if let Some(access_token) = access_token {
        request = request.bearer_auth(access_token);
    }
    for (name, value) in headers {
        request = request.header(name, value);
    }

    let response = request
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .with_context(|| format!("failed to probe sse server '{url}'"))?;
    Ok(SseProbeResult {
        status: response.status(),
        www_authenticate_header: response
            .headers()
            .get(reqwest::header::WWW_AUTHENTICATE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string),
    })
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;
