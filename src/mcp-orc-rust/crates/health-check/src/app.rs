use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use chrono::{Local, SecondsFormat, TimeZone, Utc};
use fs2::FileExt;
use log::{debug, error, info, warn};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use regex::Regex;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::task::JoinSet;
use tokio::time::sleep;

const OAUTH_PATHS: [&str; 4] = [
    "/oauth/status",
    "/oauth/current",
    "/oauth/pending",
    "/oauth/callback",
];
const REQUIRED_CORE_IDS: [&str; 4] = [
    "server:mcp-assistant",
    "server:subagents",
    "server:skills",
    "server:agent-vm",
];
const TOOL_ID_MIGRATION_THRESHOLD: f64 = 0.60;
const OPENWEBUI_TOKEN_KEY: &str = "openwebui:api_token";
const OWUI_AUTH_BRIDGE_SECRET_ENV: &str = "OWUI_AUTH_BRIDGE_SECRET";
const OWUI_AUTH_BRIDGE_SECRET_FILE_ENV: &str = "OWUI_AUTH_BRIDGE_SECRET_FILE";
const FILTER_PREFIX: &str = "portico_core_";
const REQUIRED_FILTER_ID: &str = "portico_core_unified_context";
const AGENT_PREFIX: &str = "portico_agent_";
// Retain the legacy env name so existing unlock state and operator overrides
// continue to work while the gated catalog entry moves to GPT-5.6 Sol Pro.
const KONAMI_UNLOCK_ENV_FLAG: &str = "PORTICO_KONAMI_UNLOCK_GPT54_PRO";
const KONAMI_UNLOCK_MODEL_ID: &str = "GPT-5.6 Sol Pro";
pub(crate) const MODEL_SYNC_MARKER_VERSION: u8 = 2;
pub(crate) const MODEL_SYNC_POLICY_VERSION: &str = "gpt-5.6-retire-v2";
const MODEL_SYNC_EPOCH_KEY: &str = "portico:model-sync:epoch";
const MODEL_SYNC_LEASE_KEY: &str = "portico:model-sync:lease";
const MODEL_SYNC_LEASE_TTL_MS: u64 = 15 * 60 * 1000;
const MODEL_SYNC_EPOCH_HEADER: &str = "x-portico-model-sync-epoch";
const MODEL_SYNC_OWNER_HEADER: &str = "x-portico-model-sync-owner";
const LM_STUDIO_CONFIG_FILE_NAME: &str = "lm-studio.json";
const LM_STUDIO_DEFAULT_PORT: u16 = 1234;
pub const LM_STUDIO_DISABLED_REASON: &str =
    "LM Studio is not running. Start LM Studio and enable the local server.";
const LM_STUDIO_PROVIDER_ID: &str = "lm_studio";
const LM_STUDIO_LOCAL_PREFIX: &str = "local/";
const LM_STUDIO_TAG_NAME: &str = "Local Models";
const LM_STUDIO_DEFAULT_CONTEXT_TOKENS: i64 = 131_072;
const STATUS_PROBE_CONCURRENCY: usize = 8;
const MCP_TOGGLE_SNAPSHOT_FILE_ENV: &str = "MCP_TOGGLE_SNAPSHOT_FILE";
pub(crate) const MCP_OPERATION_PUBLICATION_MARKER_FILE: &str = "mcp_operation_publication.json";
const HEALTH_STATUS_LOCK_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) struct HealthStatusWriteLock {
    file: fs::File,
    path: PathBuf,
}

impl Drop for HealthStatusWriteLock {
    fn drop(&mut self) {
        // Cross-language constraint: Electron main (mcp-readiness-publisher.js)
        // coordinates on this same `.lock` path with lockfile-EXISTENCE
        // semantics (O_EXCL create, content "<pid> <ts>\n") and never flocks —
        // a leftover flock file reads as "held" there. Our flock-based lock
        // file is always empty, so best-effort unlink it before unlocking, but
        // ONLY when it is empty and the path still refers to our inode: Node's
        // non-empty lock files (and any recreated lock) must survive.
        let empty = self.file.metadata().map(|m| m.len() == 0).unwrap_or(false);
        if empty && path_matches_inode(&self.path, &self.file) {
            let _ = fs::remove_file(&self.path);
        }
        let _ = FileExt::unlock(&self.file);
    }
}

fn path_matches_inode(path: &Path, file: &fs::File) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (file.metadata(), fs::metadata(path)) {
        (Ok(held), Ok(on_disk)) => held.ino() == on_disk.ino(),
        _ => false,
    }
}

pub(crate) fn acquire_health_status_write_lock(
    health_path: &Path,
) -> Result<HealthStatusWriteLock> {
    let lock_path = PathBuf::from(format!("{}.lock", health_path.display()));
    let started_at = Instant::now();
    loop {
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(&lock_path)
            .with_context(|| {
                format!(
                    "failed to open health status write lock {}",
                    lock_path.display()
                )
            })?;
        match file.try_lock_exclusive() {
            Ok(()) => {
                // Another actor (our Drop above, or Electron main's stale-lock
                // reclaim) may have unlinked and recreated the lock path while
                // we held an open handle to the old inode. A flock on an
                // orphaned inode provides no exclusion, so only accept the
                // lock when the path still refers to the file we locked;
                // otherwise drop this handle and retry through the bounded
                // loop below.
                if path_matches_inode(&lock_path, &file) {
                    return Ok(HealthStatusWriteLock {
                        file,
                        path: lock_path,
                    });
                }
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => {}
            Err(error) => {
                return Err(error).with_context(|| {
                    format!(
                        "failed to acquire health status write lock {}",
                        lock_path.display()
                    )
                });
            }
        }
        if started_at.elapsed() >= HEALTH_STATUS_LOCK_TIMEOUT {
            return Err(anyhow!(
                "timed out acquiring health status write lock {}",
                lock_path.display()
            ));
        }
        thread::sleep(Duration::from_millis(25));
    }
}

pub(crate) fn read_operation_publication_marker(health_status_dir: &Path) -> Option<String> {
    fs::read_to_string(health_status_dir.join(MCP_OPERATION_PUBLICATION_MARKER_FILE)).ok()
}

pub(crate) fn operation_publication_blocks_periodic_write(
    health_status_dir: &Path,
    marker_at_run_start: &Option<String>,
) -> bool {
    let current_marker = read_operation_publication_marker(health_status_dir);
    if current_marker != *marker_at_run_start {
        return true;
    }
    let Some(raw_marker) = current_marker else {
        return false;
    };
    match serde_json::from_str::<Value>(&raw_marker) {
        Ok(marker) => marker.get("status").and_then(Value::as_str) == Some("active"),
        Err(_) => true,
    }
}

pub(crate) fn write_health_status_atomically(
    health_path: &Path,
    payload: &[u8],
    marker_at_run_start: &Option<String>,
) -> Result<bool> {
    let _lock = acquire_health_status_write_lock(health_path)?;
    let health_status_dir = health_path.parent().unwrap_or_else(|| Path::new("."));
    if operation_publication_blocks_periodic_write(health_status_dir, marker_at_run_start) {
        return Ok(false);
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp_path = PathBuf::from(format!(
        "{}.{}.{}.tmp",
        health_path.display(),
        std::process::id(),
        nonce
    ));
    if let Err(error) = fs::write(&temp_path, payload) {
        let _ = fs::remove_file(&temp_path);
        return Err(error).with_context(|| {
            format!(
                "failed to write temporary health status {}",
                temp_path.display()
            )
        });
    }
    if let Err(error) = fs::rename(&temp_path, health_path) {
        let _ = fs::remove_file(&temp_path);
        return Err(error).with_context(|| {
            format!(
                "failed to atomically replace health status {}",
                health_path.display()
            )
        });
    }
    Ok(true)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HealthCheckMode {
    Full,
    Light,
    StartupCore,
}

impl HealthCheckMode {
    pub(crate) fn from_str(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "full" => Some(Self::Full),
            "light" => Some(Self::Light),
            "startup-core" => Some(Self::StartupCore),
            _ => None,
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::Light => "light",
            Self::StartupCore => "startup-core",
        }
    }
}

#[derive(Debug, Clone)]
pub struct RetryConfig {
    pub main_retries: usize,
    pub main_delay: Duration,
    pub redis_retries: usize,
    pub redis_delay: Duration,
    pub auth_retries: usize,
    pub auth_delay: Duration,
    pub discovery_retries: usize,
    pub discovery_delay: Duration,
    pub request_timeout: Duration,
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            main_retries: 50,
            main_delay: Duration::from_secs(5),
            redis_retries: 5,
            redis_delay: Duration::from_secs(2),
            auth_retries: 5,
            auth_delay: Duration::from_secs(2),
            discovery_retries: 20,
            discovery_delay: Duration::from_secs(5),
            request_timeout: Duration::from_secs(20),
        }
    }
}

impl RetryConfig {
    fn capped_attempts(&self, cap: usize) -> usize {
        self.discovery_retries.max(1).min(cap.max(1))
    }

    fn capped_delay(&self, cap: Duration) -> Duration {
        if self.discovery_delay.is_zero() {
            Duration::ZERO
        } else {
            self.discovery_delay.min(cap)
        }
    }

    fn discovery_attempts_for(&self, mode: HealthCheckMode, optional: bool) -> usize {
        match mode {
            // Light mode runs during user-facing toggle flows and health heartbeats.
            // Keep the retry budget tight so a slow/down control-plane does not stall
            // the entire renderer for minutes.
            HealthCheckMode::Light => {
                if optional {
                    self.capped_attempts(1)
                } else {
                    self.capped_attempts(2)
                }
            }
            // Startup-core still needs some patience for the grouped core stack to boot,
            // but it should not burn the full full-sync retry budget either.
            HealthCheckMode::StartupCore => {
                if optional {
                    self.capped_attempts(2)
                } else {
                    self.capped_attempts(4)
                }
            }
            HealthCheckMode::Full => self.discovery_retries.max(1),
        }
    }

    fn discovery_delay_for(&self, mode: HealthCheckMode) -> Duration {
        match mode {
            HealthCheckMode::Light => self.capped_delay(Duration::from_secs(1)),
            HealthCheckMode::StartupCore => self.capped_delay(Duration::from_secs(2)),
            HealthCheckMode::Full => self.discovery_delay,
        }
    }

    fn discovery_request_timeout_for(&self, mode: HealthCheckMode) -> Duration {
        match mode {
            HealthCheckMode::Light => self.request_timeout.min(Duration::from_secs(2)),
            HealthCheckMode::StartupCore => self.request_timeout.min(Duration::from_secs(3)),
            HealthCheckMode::Full => self.request_timeout.min(Duration::from_secs(5)),
        }
    }
}

#[derive(Debug, Clone)]
pub struct AppPaths {
    pub app_root: PathBuf,
    pub src_root: PathBuf,
    pub app_support_dir: PathBuf,
    pub filters_dir: PathBuf,
    pub agents_dir: PathBuf,
    pub health_status_dir: PathBuf,
    pub backup_dir: PathBuf,
    pub mcp_configs_dir: PathBuf,
    pub mcp_configs_user_dir: PathBuf,
    pub mcpo_configs_generated_dir: PathBuf,
    pub runtime_file_status_file: PathBuf,
    pub server_config_status_file: PathBuf,
    pub oauth_tokens_dir: PathBuf,
    pub host_mode_file: PathBuf,
    pub mcp_toggles_file: PathBuf,
    pub user_env_file: PathBuf,
    pub model_catalog_file: PathBuf,
    pub atlas_icon_file: PathBuf,
    pub gpt_icon_file: PathBuf,
    pub gemini_icon_file: PathBuf,
    pub sol_icon_file: PathBuf,
    pub terra_icon_file: PathBuf,
    pub luna_icon_file: PathBuf,
    pub agent_icon_file: PathBuf,
    pub health_check_mode_file: PathBuf,
    pub health_sync_session_id_file: PathBuf,
    pub health_sync_run_id_file: PathBuf,
    pub health_sync_reason_file: PathBuf,
    pub health_sync_timeout_budget_ms_file: PathBuf,
    pub model_sync_completed_session_file: PathBuf,
    pub konami_unlock_flag_file: PathBuf,
    pub lm_studio_config_file: PathBuf,
    pub api_log_dir: PathBuf,
}

impl AppPaths {
    pub fn from_env() -> Self {
        let app_root = app_root_override().unwrap_or_else(|| PathBuf::from("/app"));
        let src_root = app_root.join("src");
        let health_status_dir = app_root.join("health-status");
        let app_support_dir = std::env::var("PORTICO_APP_SUPPORT_DIR")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| app_root.join("app-support"));
        Self {
            app_root: app_root.clone(),
            src_root: src_root.clone(),
            app_support_dir: app_support_dir.clone(),
            filters_dir: src_root.join("filters"),
            agents_dir: app_root.join("agents"),
            health_status_dir: health_status_dir.clone(),
            backup_dir: app_root.join("backup"),
            mcp_configs_dir: app_root.join("mcp-configs"),
            mcp_configs_user_dir: app_root.join("mcp-configs-user"),
            mcpo_configs_generated_dir: app_root.join("mcpo-configs-generated"),
            runtime_file_status_file: app_root
                .join("mcpo-configs-generated")
                .join("runtime-file-status.json"),
            server_config_status_file: app_root
                .join("mcpo-configs-generated")
                .join("server-config-status.json"),
            oauth_tokens_dir: app_root.join("mcpo-oauth-tokens"),
            host_mode_file: app_root.join("HOST_MODE"),
            mcp_toggles_file: app_root.join("mcp_toggles.json"),
            user_env_file: app_root.join("user.env"),
            model_catalog_file: app_root.join("model_catalog.yaml"),
            atlas_icon_file: app_root.join("atlas.png"),
            gpt_icon_file: app_root.join("gpt.png"),
            gemini_icon_file: app_root.join("gemini.png"),
            sol_icon_file: app_root.join("sol.png"),
            terra_icon_file: app_root.join("terra.png"),
            luna_icon_file: app_root.join("luna.png"),
            agent_icon_file: app_root.join("assets/agent-icon.png"),
            health_check_mode_file: health_status_dir.join("health_check_mode"),
            health_sync_session_id_file: health_status_dir.join("health_sync_session_id"),
            health_sync_run_id_file: health_status_dir.join("health_sync_run_id"),
            health_sync_reason_file: health_status_dir.join("health_sync_reason"),
            health_sync_timeout_budget_ms_file: health_status_dir
                .join("health_sync_timeout_budget_ms"),
            model_sync_completed_session_file: health_status_dir
                .join("model_sync_completed_session_id"),
            konami_unlock_flag_file: health_status_dir.join("KONAMI"),
            lm_studio_config_file: app_support_dir.join(LM_STUDIO_CONFIG_FILE_NAME),
            api_log_dir: health_status_dir.join("api-logs"),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct LmStudioConfig {
    pub enabled: Option<bool>,
    pub port: Option<u16>,
    pub host_base_url: Option<String>,
    pub docker_base_url: Option<String>,
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LmStudioResolvedConfig {
    pub port: u16,
    pub host_base_url: String,
    pub docker_base_url: String,
    pub api_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LmStudioDiscoveredModel {
    pub id: String,
    pub loaded_context_tokens: Option<i64>,
    pub max_context_tokens: Option<i64>,
}

impl LmStudioDiscoveredModel {
    fn context_tokens(&self) -> Option<i64> {
        self.loaded_context_tokens.or(self.max_context_tokens)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LmStudioSyncResult {
    pub configured: bool,
    pub reachable: bool,
    pub model_ids: Vec<String>,
    pub internal_model_ids: Vec<String>,
    pub created: usize,
    pub updated: usize,
    pub disabled: usize,
}

#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    pub openwebui_base_url: String,
    pub mcpo_regular_host: String,
    pub mcpo_regular_base_url: String,
    pub mcpo_core_host: String,
    pub mcpo_core_base_url: String,
    pub host_mcpo_host: String,
    pub host_mcpo_base_url: String,
    pub mcpo_regular_localhost_port: String,
    pub mcpo_core_localhost_port: String,
    pub host_mcpo_localhost_port: String,
    pub mode: HealthCheckMode,
    pub sync_enabled: bool,
    pub core_only_sync: bool,
    pub health_sync_session_id: String,
    pub health_sync_run_id: String,
    pub health_sync_reason: String,
    pub health_sync_timeout_budget_ms: Option<u64>,
    pub write_api_logs: bool,
    pub oauth_token_max_age_seconds: u64,
}

impl RuntimeConfig {
    pub fn load(paths: &AppPaths) -> Self {
        let mcpo_regular_host =
            std::env::var("MCPO_REGULAR_HOST").unwrap_or_else(|_| "mcpo".to_string());
        let mcpo_regular_base_url = std::env::var("MCPO_REGULAR_BASE_URL")
            .unwrap_or_else(|_| format!("http://{mcpo_regular_host}"))
            .trim_end_matches('/')
            .to_string();
        let mcpo_core_host =
            std::env::var("MCPO_CORE_HOST").unwrap_or_else(|_| "mcpo-core:8081".to_string());
        let mcpo_core_base_url = std::env::var("MCPO_CORE_BASE_URL")
            .unwrap_or_else(|_| format!("http://{mcpo_core_host}"))
            .trim_end_matches('/')
            .to_string();
        let host_mcpo_host = std::env::var("HOST_MCPO_HOST")
            .unwrap_or_else(|_| "host.docker.internal:8890".to_string());
        let host_mcpo_base_url = std::env::var("HOST_MCPO_BASE_URL")
            .unwrap_or_else(|_| format!("http://{host_mcpo_host}"))
            .trim_end_matches('/')
            .to_string();
        let mode = get_health_check_mode(paths);

        Self {
            openwebui_base_url: "http://open-webui:8080".to_string(),
            mcpo_regular_host,
            mcpo_regular_base_url,
            mcpo_core_host,
            mcpo_core_base_url,
            host_mcpo_host,
            host_mcpo_base_url,
            mcpo_regular_localhost_port: std::env::var("MCPO_REGULAR_LOCALHOST_PORT")
                .unwrap_or_else(|_| "8765".to_string()),
            mcpo_core_localhost_port: std::env::var("MCPO_CORE_LOCALHOST_PORT")
                .unwrap_or_else(|_| "8766".to_string()),
            host_mcpo_localhost_port: std::env::var("HOST_MCPO_LOCALHOST_PORT")
                .unwrap_or_else(|_| "8890".to_string()),
            mode,
            sync_enabled: mode != HealthCheckMode::Light,
            core_only_sync: mode == HealthCheckMode::StartupCore,
            health_sync_session_id: get_health_sync_session_id(paths),
            health_sync_run_id: get_health_sync_run_id(paths),
            health_sync_reason: get_health_sync_reason(paths),
            health_sync_timeout_budget_ms: get_health_sync_timeout_budget_ms(paths),
            write_api_logs: matches!(
                std::env::var("WRITE_API_LOGS"),
                Ok(value) if value.trim().eq_ignore_ascii_case("true")
            ),
            oauth_token_max_age_seconds: 7 * 24 * 60 * 60,
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct StartupReadinessConfig {
    pub(crate) llm_gateway_health_url: String,
    pub(crate) openwebui_base_url: String,
    pub(crate) require_bifrost_ready: bool,
    pub(crate) max_attempts: usize,
    pub(crate) bootstrapping: bool,
    pub(crate) request_timeout: Duration,
    pub(crate) retry_delay: Duration,
}

impl StartupReadinessConfig {
    pub(crate) fn from_env() -> Self {
        Self {
            llm_gateway_health_url: std::env::var("LLM_GATEWAY_HEALTH_URL")
                .unwrap_or_else(|_| "http://llm-gateway:4000/health".to_string()),
            openwebui_base_url: std::env::var("OPENWEBUI_BASE_URL")
                .unwrap_or_else(|_| "http://open-webui:8080".to_string())
                .trim_end_matches('/')
                .to_string(),
            require_bifrost_ready: std::env::var("REQUIRE_BIFROST_READY")
                .ok()
                .map(|value| is_truthy(&value))
                .unwrap_or(false),
            max_attempts: parse_startup_readiness_attempts(
                std::env::var("OWUI_MAX_ATTEMPTS").ok().as_deref(),
            ),
            bootstrapping: std::env::var("OWUI_BOOTSTRAPPING")
                .ok()
                .map(|value| is_truthy(&value))
                .unwrap_or(false),
            request_timeout: Duration::from_secs(15),
            retry_delay: Duration::from_secs(5),
        }
    }
}

fn parse_startup_readiness_attempts(value: Option<&str>) -> usize {
    value
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .filter(|attempts| *attempts > 0)
        .unwrap_or(20)
}

pub async fn run_startup_readiness_from_env() -> Result<bool> {
    run_startup_readiness(StartupReadinessConfig::from_env()).await
}

pub(crate) async fn run_startup_readiness(config: StartupReadinessConfig) -> Result<bool> {
    let client = Client::new();

    for attempt in 1..=config.max_attempts {
        if config.bootstrapping && attempt % 6 == 1 {
            let elapsed = (attempt - 1) as u64 * config.retry_delay.as_secs();
            println!("⏳ First-run setup in progress... ({elapsed}s elapsed)");
        }
        println!(
            "Attempt {attempt}/{}: Checking Open WebUI readiness...",
            config.max_attempts
        );

        match check_startup_readiness_once(&client, &config).await {
            Ok(()) => {
                println!("✅ Open WebUI is healthy and serving the frontend!");
                return Ok(true);
            }
            Err(error) => {
                let err_str = truncate_startup_readiness_message(&format!("{error:#}"), 120);
                if !(config.bootstrapping && err_str.contains("Connection refused")) {
                    println!("❌ Not ready: {err_str}");
                }
                if attempt < config.max_attempts {
                    sleep(config.retry_delay).await;
                }
            }
        }
    }

    if config.bootstrapping {
        println!("❌ First-run setup did not complete in time. Check container logs:");
        println!("   docker logs portico-open-webui");
    }
    Ok(false)
}

async fn check_startup_readiness_once(
    client: &Client,
    config: &StartupReadinessConfig,
) -> Result<()> {
    if config.require_bifrost_ready {
        let gateway_body = get_success_text(
            client,
            &config.llm_gateway_health_url,
            config.request_timeout,
            "LLM gateway health",
        )
        .await?;
        let gateway: Value = serde_json::from_str(&gateway_body).with_context(|| {
            format!(
                "LLM gateway returned invalid JSON: {}",
                truncate_startup_readiness_message(&gateway_body, 120)
            )
        })?;
        if gateway.get("status").and_then(Value::as_str) != Some("ok")
            || gateway.get("bifrost_ready").and_then(Value::as_bool) != Some(true)
        {
            return Err(anyhow!(
                "LLM gateway is not ready yet: {}",
                truncate_startup_readiness_message(&gateway_body, 120)
            ));
        }
    }

    let health_body = get_success_text(
        client,
        &startup_readiness_url(&config.openwebui_base_url, "/health"),
        config.request_timeout,
        "Open WebUI health",
    )
    .await?;
    let health: Value = serde_json::from_str(&health_body).with_context(|| {
        format!(
            "Open WebUI /health returned invalid JSON: {}",
            truncate_startup_readiness_message(&health_body, 120)
        )
    })?;
    if !json_value_is_truthy(health.get("status")) {
        return Err(anyhow!(
            "/health returned unhealthy payload: {}",
            truncate_startup_readiness_message(&health_body, 120)
        ));
    }

    let (html, content_type) = get_success_text_with_content_type(
        client,
        &startup_readiness_url(&config.openwebui_base_url, "/"),
        config.request_timeout,
        "Open WebUI frontend",
    )
    .await?;
    if !content_type.to_ascii_lowercase().contains("text/html") {
        return Err(anyhow!("Unexpected content type from /: {content_type}"));
    }

    let lowered = html.to_ascii_lowercase();
    if !lowered.contains("<!doctype html")
        || !lowered.contains("<body")
        || (!html.contains("/_app/immutable/")
            && !html.contains("__sveltekit_")
            && !html.contains("loader.js"))
    {
        return Err(anyhow!("Frontend document is not ready yet"));
    }

    Ok(())
}

async fn get_success_text(
    client: &Client,
    url: &str,
    timeout: Duration,
    label: &str,
) -> Result<String> {
    let (text, _) = get_success_text_with_content_type(client, url, timeout, label).await?;
    Ok(text)
}

async fn get_success_text_with_content_type(
    client: &Client,
    url: &str,
    timeout: Duration,
    label: &str,
) -> Result<(String, String)> {
    let response = client
        .get(url)
        .timeout(timeout)
        .send()
        .await
        .with_context(|| format!("{label} request failed: {url}"))?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let body = response
        .text()
        .await
        .with_context(|| format!("{label} response body could not be read: {url}"))?;

    if !status.is_success() {
        return Err(anyhow!(
            "{label} returned HTTP {}: {}",
            status.as_u16(),
            truncate_startup_readiness_message(&body, 120)
        ));
    }

    Ok((body, content_type))
}

fn startup_readiness_url(base_url: &str, path: &str) -> String {
    if path == "/" {
        format!("{}/", base_url.trim_end_matches('/'))
    } else {
        format!(
            "{}/{}",
            base_url.trim_end_matches('/'),
            path.trim_start_matches('/')
        )
    }
}

fn json_value_is_truthy(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(number)) => number.as_f64().map(|value| value != 0.0).unwrap_or(true),
        Some(Value::String(value)) => !value.is_empty(),
        Some(Value::Array(value)) => !value.is_empty(),
        Some(Value::Object(value)) => !value.is_empty(),
        Some(Value::Null) | None => false,
    }
}

fn truncate_startup_readiness_message(raw: &str, max_chars: usize) -> String {
    let mut normalized = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = normalized.chars();
    let truncated = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        normalized = format!("{truncated}...");
    }
    normalized
}

#[derive(Debug, Clone)]
pub struct FilterFile {
    pub file_path: PathBuf,
    pub filter_id: String,
    pub name: String,
    pub description: String,
    pub code: String,
    pub valves: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct AgentFile {
    pub agent_id: String,
    pub name: String,
    pub base_model_id: Option<String>,
    pub system_prompt: String,
    pub tools_mode: String,
    pub tools_list: Vec<String>,
    pub description: String,
    pub hidden: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerMetadata {
    pub id: String,
    pub name: String,
    pub deployment_type: String,
    pub is_core: bool,
    pub has_oauth: bool,
    pub user_installed: bool,
    pub is_configured: bool,
    pub config_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredTool {
    pub host: String,
    pub port: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct OAuthStatusPayload {
    pub current: Option<Value>,
    pub active: Vec<Value>,
    pub pending: Vec<Value>,
    pub checking: Vec<Value>,
    pub waiting_callback: Vec<Value>,
    pub completed: Vec<Value>,
    pub failed: Vec<Value>,
    pub timeout: Vec<Value>,
}

#[derive(Debug, Clone)]
pub struct RawResponse {
    pub ok: bool,
    pub status: Option<u16>,
    pub content_type: String,
    pub text: String,
    pub method: String,
    pub path: String,
    pub duration_ms: u128,
    pub response_bytes: usize,
}

#[derive(Debug, Error)]
#[error("{message}")]
pub struct OpenWebUiApiError {
    message: String,
    pub status: Option<u16>,
    pub response_text: String,
}

impl OpenWebUiApiError {
    fn new(
        message: impl Into<String>,
        status: Option<u16>,
        response_text: impl Into<String>,
    ) -> Self {
        Self {
            message: message.into(),
            status,
            response_text: response_text.into(),
        }
    }
}

#[derive(Clone)]
struct HealthSyncEventSink {
    paths: AppPaths,
    config: RuntimeConfig,
}

impl HealthSyncEventSink {
    fn new(paths: &AppPaths, config: &RuntimeConfig) -> Self {
        Self {
            paths: paths.clone(),
            config: config.clone(),
        }
    }

    fn record(&self, event: &str, details: Value) {
        if let Err(error) = log_health_sync_event(&self.paths, &self.config, event, details) {
            warn!("Failed to write health sync event {event}: {error:#}");
        }
    }
}

#[derive(Debug, Clone)]
pub struct ModelSyncMarkerStatus {
    pub marker_file_exists: bool,
    pub expected_marker: String,
    pub stored_marker: Option<String>,
    pub matches: bool,
    pub legacy_marker: bool,
    pub stored_epoch: Option<u64>,
    pub stored_state: Option<String>,
    pub fingerprint: ModelSyncFingerprintMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct ModelSyncMarkerV2 {
    pub(crate) version: u8,
    pub(crate) state: String,
    pub(crate) fingerprint: String,
    pub(crate) epoch: u64,
    pub(crate) owner: String,
    pub(crate) policy_version: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ModelSyncFingerprintMetadata {
    pub session_id_present: bool,
    pub base_system_prompt_exists: bool,
    pub base_system_prompt_bytes: u64,
    pub model_catalog_exists: bool,
    pub model_catalog_bytes: u64,
    pub model_icon_resolver_version: String,
    pub atlas_icon_exists: bool,
    pub atlas_icon_bytes: u64,
    pub gpt_icon_exists: bool,
    pub gpt_icon_bytes: u64,
    pub gemini_icon_exists: bool,
    pub gemini_icon_bytes: u64,
    pub sol_icon_exists: bool,
    pub sol_icon_bytes: u64,
    pub terra_icon_exists: bool,
    pub terra_icon_bytes: u64,
    pub luna_icon_exists: bool,
    pub luna_icon_bytes: u64,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct OwuiModelInventory {
    pub(crate) picker_model_count: usize,
    pub(crate) wrapper_model_count: usize,
    pub(crate) base_model_count: usize,
    pub(crate) lm_studio_model_count: usize,
    pub(crate) disabled_model_count: usize,
    pub(crate) deprecated_reference_count: usize,
    pub(crate) accessible_model_ids: BTreeSet<String>,
    pub(crate) missing_configured_model_ids: Vec<String>,
    pub(crate) configured_model_ids_missing_from_picker_base_models: Vec<String>,
    pub(crate) existing_base_model_ids: Vec<String>,
}

pub trait TokenStore: Send + Sync {
    fn set(&self, key: &str, value: &str) -> Result<()>;

    fn begin_model_sync_epoch(
        &self,
        _owner: &str,
        _ttl_ms: u64,
        minimum_epoch: u64,
    ) -> Result<u64> {
        Ok(minimum_epoch.saturating_add(1))
    }

    fn verify_model_sync_epoch(&self, _owner: &str, _epoch: u64) -> Result<()> {
        Ok(())
    }

    fn release_model_sync_epoch(&self, _owner: &str, _epoch: u64) -> Result<bool> {
        Ok(true)
    }
}

pub trait ContainerLogInspector: Send + Sync {
    fn has_errors(&self, container_name: &str, lines: usize) -> bool;
}

pub struct RedisTokenStore {
    connection: Mutex<redis::Connection>,
}

impl RedisTokenStore {
    pub(crate) fn connect_once() -> Result<Self> {
        let redis_url = redis_url_override().unwrap_or_else(|| "redis://redis:6379/".to_string());
        let client = redis::Client::open(redis_url.as_str())
            .context("failed to create redis client for health check")?;
        let connection = client
            .get_connection()
            .context("failed to open redis connection for health check")?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }
}

impl TokenStore for RedisTokenStore {
    fn set(&self, key: &str, value: &str) -> Result<()> {
        let mut guard = self
            .connection
            .lock()
            .map_err(|_| anyhow!("redis connection mutex poisoned"))?;
        redis::cmd("SET")
            .arg(key)
            .arg(value)
            .query::<()>(&mut *guard)
            .context("failed to write token to redis")
    }

    fn begin_model_sync_epoch(&self, owner: &str, ttl_ms: u64, minimum_epoch: u64) -> Result<u64> {
        let mut guard = self
            .connection
            .lock()
            .map_err(|_| anyhow!("redis connection mutex poisoned"))?;
        let script = r#"
if redis.call('EXISTS', KEYS[2]) == 1 then
  return -1
end
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local minimum = tonumber(ARGV[3]) or 0
if current < minimum then
  current = minimum
end
local epoch = current + 1
redis.call('SET', KEYS[1], tostring(epoch))
redis.call('SET', KEYS[2], tostring(epoch) .. ':' .. ARGV[1], 'PX', ARGV[2])
return epoch
"#;
        let epoch = redis::cmd("EVAL")
            .arg(script)
            .arg(2)
            .arg(MODEL_SYNC_EPOCH_KEY)
            .arg(MODEL_SYNC_LEASE_KEY)
            .arg(owner)
            .arg(ttl_ms)
            .arg(minimum_epoch)
            .query::<i64>(&mut *guard)
            .context("failed to acquire model sync epoch")?;
        if epoch < 0 {
            return Err(anyhow!("another model sync lease is still active"));
        }
        Ok(epoch as u64)
    }

    fn verify_model_sync_epoch(&self, owner: &str, epoch: u64) -> Result<()> {
        let mut guard = self
            .connection
            .lock()
            .map_err(|_| anyhow!("redis connection mutex poisoned"))?;
        let expected = format!("{epoch}:{owner}");
        let script = r#"
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
"#;
        let matches = redis::cmd("EVAL")
            .arg(script)
            .arg(1)
            .arg(MODEL_SYNC_LEASE_KEY)
            .arg(expected)
            .arg(MODEL_SYNC_LEASE_TTL_MS)
            .query::<u8>(&mut *guard)
            .context("failed to verify model sync epoch")?;
        if matches != 1 {
            return Err(anyhow!("model sync epoch lease expired or was superseded"));
        }
        Ok(())
    }

    fn release_model_sync_epoch(&self, owner: &str, epoch: u64) -> Result<bool> {
        let mut guard = self
            .connection
            .lock()
            .map_err(|_| anyhow!("redis connection mutex poisoned"))?;
        let expected = format!("{epoch}:{owner}");
        let script = r#"
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
"#;
        let released = redis::cmd("EVAL")
            .arg(script)
            .arg(1)
            .arg(MODEL_SYNC_LEASE_KEY)
            .arg(expected)
            .query::<u8>(&mut *guard)
            .context("failed to release model sync epoch")?;
        Ok(released == 1)
    }
}

pub struct DockerCliLogInspector;

impl ContainerLogInspector for DockerCliLogInspector {
    fn has_errors(&self, container_name: &str, lines: usize) -> bool {
        let mut child = match Command::new("docker")
            .arg("logs")
            .arg("--tail")
            .arg(lines.to_string())
            .arg(container_name)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(child) => child,
            Err(error) => {
                debug!("docker CLI unavailable while checking logs for {container_name}: {error}");
                return false;
            }
        };

        let started = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if started.elapsed() < Duration::from_secs(5) => {
                    thread::sleep(Duration::from_millis(50));
                }
                Ok(None) => {
                    warn!("Timeout checking logs for {container_name}");
                    let _ = child.kill();
                    let _ = child.wait();
                    return false;
                }
                Err(error) => {
                    warn!("Could not check logs for {container_name}: {error}");
                    let _ = child.kill();
                    let _ = child.wait();
                    return false;
                }
            }
        }

        let output = match child.wait_with_output() {
            Ok(output) => output,
            Err(error) => {
                warn!("Could not collect logs for {container_name}: {error}");
                return false;
            }
        };

        let mut combined = String::new();
        combined.push_str(&String::from_utf8_lossy(&output.stdout));
        combined.push_str(&String::from_utf8_lossy(&output.stderr));

        [
            "Traceback (most recent call last):",
            "Error:",
            "Exception:",
            "CRITICAL",
            "FATAL",
            "ModuleNotFoundError",
            "ImportError",
            "ConnectionRefusedError",
            "FileNotFoundError",
            "PermissionError",
            "OSError:",
            "RuntimeError:",
        ]
        .iter()
        .any(|pattern| combined.contains(pattern))
    }
}

#[derive(Clone)]
pub struct OpenWebUiClient {
    http_client: Client,
    base_url: String,
    timeout: Duration,
    token: String,
    model_sync_fence: Option<(u64, String)>,
    health_sync_events: Option<HealthSyncEventSink>,
}

impl OpenWebUiClient {
    pub fn new(http_client: Client, base_url: impl Into<String>, timeout: Duration) -> Self {
        Self {
            http_client,
            base_url: base_url.into().trim_end_matches('/').to_string(),
            timeout,
            token: String::new(),
            model_sync_fence: None,
            health_sync_events: None,
        }
    }

    pub fn set_token(&mut self, token: impl Into<String>) {
        self.token = token.into();
    }

    fn set_model_sync_fence(&mut self, epoch: u64, owner: impl Into<String>) {
        self.model_sync_fence = Some((epoch, owner.into()));
    }

    fn with_health_sync_events(mut self, paths: &AppPaths, config: &RuntimeConfig) -> Self {
        self.health_sync_events = Some(HealthSyncEventSink::new(paths, config));
        self
    }

    fn build_url(&self, path: &str, params: Option<&[(&str, String)]>) -> String {
        let mut url = if path.starts_with("http://") || path.starts_with("https://") {
            path.to_string()
        } else {
            format!("{}{}", self.base_url, path)
        };

        if let Some(params) = params {
            let mut serializer = url::form_urlencoded::Serializer::new(String::new());
            for (key, value) in params {
                if !value.is_empty() {
                    serializer.append_pair(key, value);
                }
            }
            let query = serializer.finish();
            if !query.is_empty() {
                let separator = if url.contains('?') { "&" } else { "?" };
                url.push_str(separator);
                url.push_str(&query);
            }
        }

        url
    }

    pub async fn request(
        &self,
        method: Method,
        path: &str,
        payload: Option<&Value>,
        params: Option<&[(&str, String)]>,
        include_auth: bool,
    ) -> Result<RawResponse, OpenWebUiApiError> {
        let method_name = method.as_str().to_string();
        let sanitized_path = sanitize_health_sync_http_path(path);
        let url = self.build_url(path, params);
        let started = Instant::now();
        let mut request = self
            .http_client
            .request(method, url)
            .timeout(self.timeout)
            .header(CONTENT_TYPE, "application/json");

        if include_auth && !self.token.is_empty() {
            request = request.header(AUTHORIZATION, format!("Bearer {}", self.token));
        }
        if let Some((epoch, owner)) = self.model_sync_fence.as_ref() {
            request = request
                .header(MODEL_SYNC_EPOCH_HEADER, epoch.to_string())
                .header(MODEL_SYNC_OWNER_HEADER, owner);
        }

        if let Some(payload) = payload {
            request = request.json(payload);
        }

        let response = request.send().await.map_err(|error| {
            let status = error.status().map(|status| status.as_u16());
            let duration_ms = started.elapsed().as_millis();
            self.record_http_telemetry(json!({
                "method": method_name,
                "path": sanitized_path,
                "status": status,
                "ok": false,
                "duration_ms": duration_ms,
                "response_bytes": 0,
                "error_class": reqwest_error_class(&error),
            }));
            OpenWebUiApiError::new(error.to_string(), status, "")
        })?;

        let status = response.status();
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        let text = response.text().await.unwrap_or_default();
        let duration_ms = started.elapsed().as_millis();
        let response_bytes = text.len();
        self.record_http_telemetry(json!({
            "method": method_name,
            "path": sanitized_path,
            "status": status.as_u16(),
            "ok": status.is_success(),
            "content_type": summarize_content_type(&content_type),
            "duration_ms": duration_ms,
            "response_bytes": response_bytes,
            "json_shape": summarize_json_shape(&text),
        }));

        Ok(RawResponse {
            ok: status.is_success(),
            status: Some(status.as_u16()),
            content_type,
            text,
            method: method_name,
            path: sanitized_path,
            duration_ms,
            response_bytes,
        })
    }

    pub async fn get_json(
        &self,
        path: &str,
        params: Option<&[(&str, String)]>,
    ) -> Result<Value, OpenWebUiApiError> {
        let response = self.request(Method::GET, path, None, params, true).await?;
        if !response.ok {
            return Err(OpenWebUiApiError::new(
                build_http_error_message(response.status, &response.text),
                response.status,
                response.text,
            ));
        }
        match parse_json_response(path, &response) {
            Ok(value) => Ok(value),
            Err(error) => {
                self.record_json_parse_error(&response, &error);
                Err(error)
            }
        }
    }

    pub async fn post_json(
        &self,
        path: &str,
        payload: Option<&Value>,
        params: Option<&[(&str, String)]>,
    ) -> Result<Value, OpenWebUiApiError> {
        let response = self
            .request(Method::POST, path, payload, params, true)
            .await?;
        if !response.ok {
            return Err(OpenWebUiApiError::new(
                build_http_error_message(response.status, &response.text),
                response.status,
                response.text,
            ));
        }
        match parse_json_response(path, &response) {
            Ok(value) => Ok(value),
            Err(error) => {
                self.record_json_parse_error(&response, &error);
                Err(error)
            }
        }
    }

    pub async fn put_json(
        &self,
        path: &str,
        payload: Option<&Value>,
        params: Option<&[(&str, String)]>,
    ) -> Result<Value, OpenWebUiApiError> {
        let response = self
            .request(Method::PUT, path, payload, params, true)
            .await?;
        if !response.ok {
            return Err(OpenWebUiApiError::new(
                build_http_error_message(response.status, &response.text),
                response.status,
                response.text,
            ));
        }
        match parse_json_response(path, &response) {
            Ok(value) => Ok(value),
            Err(error) => {
                self.record_json_parse_error(&response, &error);
                Err(error)
            }
        }
    }

    pub async fn post_text(
        &self,
        path: &str,
        payload: Option<&Value>,
        params: Option<&[(&str, String)]>,
    ) -> Result<String, OpenWebUiApiError> {
        let response = self
            .request(Method::POST, path, payload, params, true)
            .await?;
        if !response.ok {
            return Err(OpenWebUiApiError::new(
                build_http_error_message(response.status, &response.text),
                response.status,
                response.text,
            ));
        }
        Ok(response.text)
    }

    pub async fn delete(
        &self,
        path: &str,
        params: Option<&[(&str, String)]>,
    ) -> Result<(), OpenWebUiApiError> {
        let response = self
            .request(Method::DELETE, path, None, params, true)
            .await?;
        if !response.ok {
            return Err(OpenWebUiApiError::new(
                build_http_error_message(response.status, &response.text),
                response.status,
                response.text,
            ));
        }
        Ok(())
    }

    pub async fn service_token(
        &mut self,
        bridge_secret: &str,
    ) -> Result<String, OpenWebUiApiError> {
        self.set_token(bridge_secret.trim().to_string());
        let payload = json!({ "reason": "health-check-sync" });
        let response = self
            .request(
                Method::POST,
                "/api/v1/portico/auth/service-token",
                Some(&payload),
                None,
                true,
            )
            .await?;
        if !response.ok {
            return Err(OpenWebUiApiError::new(
                build_http_error_message(response.status, &response.text),
                response.status,
                response.text,
            ));
        }
        let data = parse_json_response("/api/v1/portico/auth/service-token", &response)?;
        let token = data
            .get("token")
            .and_then(Value::as_str)
            .or_else(|| data.get("access_token").and_then(Value::as_str))
            .unwrap_or("")
            .to_string();
        if token.is_empty() {
            return Err(OpenWebUiApiError::new(
                "Service token bridge succeeded but no token was returned",
                response.status,
                response.text,
            ));
        }
        self.set_token(token.clone());
        Ok(token)
    }

    fn record_http_telemetry(&self, details: Value) {
        if let Some(events) = &self.health_sync_events {
            events.record("owui_http_request", details);
        }
    }

    fn record_json_parse_error(&self, response: &RawResponse, error: &OpenWebUiApiError) {
        if let Some(events) = &self.health_sync_events {
            events.record(
                "owui_json_parse_error",
                json!({
                    "method": response.method,
                    "path": response.path,
                    "status": response.status,
                    "content_type": summarize_content_type(&response.content_type),
                    "duration_ms": response.duration_ms,
                    "response_bytes": response.response_bytes,
                    "error": truncate_safe_error_message(&error.message),
                }),
            );
        }
    }
}

fn read_owui_auth_bridge_secret() -> Result<String> {
    if let Ok(file_path) = std::env::var(OWUI_AUTH_BRIDGE_SECRET_FILE_ENV) {
        let trimmed_path = file_path.trim();
        if !trimmed_path.is_empty() {
            let value = fs::read_to_string(trimmed_path)
                .with_context(|| format!("failed to read {OWUI_AUTH_BRIDGE_SECRET_FILE_ENV}"))?
                .trim()
                .to_string();
            if !value.is_empty() {
                return Ok(value);
            }
        }
    }

    let value = std::env::var(OWUI_AUTH_BRIDGE_SECRET_ENV)
        .unwrap_or_default()
        .trim()
        .to_string();
    if value.is_empty() {
        #[cfg(test)]
        {
            return Ok("bridge-test-secret".to_string());
        }
        #[cfg(not(test))]
        {
            return Err(anyhow!(
                "{OWUI_AUTH_BRIDGE_SECRET_ENV} or {OWUI_AUTH_BRIDGE_SECRET_FILE_ENV} is required"
            ));
        }
    }
    Ok(value)
}

pub struct HealthCheckApp {
    pub paths: AppPaths,
    pub config: RuntimeConfig,
    pub retries: RetryConfig,
    pub http_client: Client,
    pub token_store: Option<Arc<dyn TokenStore>>,
    pub log_inspector: Arc<dyn ContainerLogInspector>,
}

impl HealthCheckApp {
    pub fn new(
        paths: AppPaths,
        config: RuntimeConfig,
        retries: RetryConfig,
        token_store: Option<Arc<dyn TokenStore>>,
        log_inspector: Arc<dyn ContainerLogInspector>,
    ) -> Self {
        Self {
            paths,
            config,
            retries,
            http_client: Client::new(),
            token_store,
            log_inspector,
        }
    }

    fn record_health_sync_event(&self, event: &str, details: Value) {
        if let Err(error) = log_health_sync_event(&self.paths, &self.config, event, details) {
            warn!("Failed to write health sync event {event}: {error:#}");
        }
    }

    fn release_model_sync_lease_best_effort(&self, owner: &str, epoch: u64) {
        let Some(store) = self.token_store.as_deref() else {
            return;
        };
        match store.release_model_sync_epoch(owner, epoch) {
            Ok(true) => self.record_health_sync_event(
                "model_sync_lease_released",
                json!({
                    "owner": owner,
                    "epoch": epoch,
                }),
            ),
            Ok(false) => {
                warn!(
                    "Model sync lease was not released because ownership changed (owner={owner}, epoch={epoch})"
                );
                self.record_health_sync_event(
                    "model_sync_lease_release_skipped",
                    json!({
                        "owner": owner,
                        "epoch": epoch,
                        "reason": "ownership_changed",
                    }),
                );
            }
            Err(error) => {
                warn!(
                    "Failed to release model sync lease without masking reconciliation outcome: {error:#}"
                );
                self.record_health_sync_event(
                    "model_sync_lease_release_error",
                    json!({
                        "owner": owner,
                        "epoch": epoch,
                        "error": truncate_safe_error_message(&format!("{error:#}")),
                    }),
                );
            }
        }
    }

    pub async fn run(&self) -> Result<bool> {
        info!(
            "Health check mode: {} (sync_enabled={}, core_only_sync={})",
            self.config.mode.as_str(),
            self.config.sync_enabled,
            self.config.core_only_sync
        );
        let run_started = Instant::now();
        self.record_health_sync_event(
            "health_sync_start",
            json!({
                "mode": self.config.mode.as_str(),
                "sync_enabled": self.config.sync_enabled,
                "core_only_sync": self.config.core_only_sync,
                "main_retries": self.retries.main_retries,
                "request_timeout_ms": self.retries.request_timeout.as_millis(),
                "timeout_budget_ms": self.config.health_sync_timeout_budget_ms,
                "health_sync_session_id_present": !self.config.health_sync_session_id.is_empty(),
            }),
        );
        if self.paths.health_check_mode_file.exists() {
            info!(
                "Health check mode source: {}",
                self.paths.health_check_mode_file.display()
            );
        } else if std::env::var("HEALTH_CHECK_MODE").is_ok() {
            info!("Health check mode source: HEALTH_CHECK_MODE env");
        } else {
            info!("Health check mode source: default");
        }

        if self.config.health_sync_session_id.is_empty() {
            warn!("Health sync session id not found; model reconciliation will run on every sync");
        } else {
            info!(
                "Health sync session id: {}",
                self.config.health_sync_session_id
            );
        }

        let bridge_secret = match read_owui_auth_bridge_secret() {
            Ok(value) => value,
            Err(error) => {
                error!("Open WebUI auth bridge secret is unavailable: {error:#}");
                self.record_health_sync_event(
                    "health_sync_failure",
                    json!({
                        "stage": "openwebui_auth",
                        "reason": "bridge_secret_unavailable",
                        "error": truncate_safe_error_message(&format!("{error:#}")),
                        "elapsed_ms": run_started.elapsed().as_millis(),
                    }),
                );
                return Ok(false);
            }
        };

        for attempt in 1..=self.retries.main_retries {
            info!(
                "Attempt {attempt}/{}: Checking {}",
                self.retries.main_retries, self.config.openwebui_base_url
            );
            let mut client = OpenWebUiClient::new(
                self.http_client.clone(),
                &self.config.openwebui_base_url,
                self.retries.request_timeout,
            )
            .with_health_sync_events(&self.paths, &self.config);

            self.record_health_sync_event(
                "health_sync_phase_start",
                json!({
                    "phase": "openwebui_auth",
                    "attempt": attempt,
                }),
            );
            match client.service_token(&bridge_secret).await {
                Ok(token) => {
                    info!("Authenticated against Open WebUI on attempt {attempt}");
                    self.record_health_sync_event(
                        "openwebui_auth_success",
                        json!({
                            "attempt": attempt,
                            "elapsed_ms": run_started.elapsed().as_millis(),
                        }),
                    );
                    if let Some(token_store) = &self.token_store {
                        if let Err(error) = token_store.set(OPENWEBUI_TOKEN_KEY, &token) {
                            error!("Failed to store token in Redis: {error:#}");
                            self.record_health_sync_event(
                                "health_sync_failure",
                                json!({
                                    "stage": "token_store",
                                    "error": truncate_safe_error_message(&format!("{error:#}")),
                                }),
                            );
                            return Ok(false);
                        }
                    }

                    match self.run_authenticated(client).await {
                        Ok(result) => {
                            if !result {
                                self.record_health_sync_event(
                                    "health_sync_failure",
                                    json!({
                                        "stage": "authenticated_sync",
                                        "reason": "returned_false",
                                        "elapsed_ms": run_started.elapsed().as_millis(),
                                    }),
                                );
                            }
                            self.record_health_sync_event(
                                "health_sync_complete",
                                json!({
                                    "success": result,
                                    "attempt": attempt,
                                    "elapsed_ms": run_started.elapsed().as_millis(),
                                }),
                            );
                            return Ok(result);
                        }
                        Err(error) => {
                            self.record_health_sync_event(
                                "health_sync_retry",
                                json!({
                                    "stage": "authenticated_sync",
                                    "attempt": attempt,
                                    "elapsed_ms": run_started.elapsed().as_millis(),
                                    "error": truncate_safe_error_message(&format!("{error:#}")),
                                }),
                            );
                            warn!("Open WebUI API not ready yet: {error:#}");
                        }
                    }
                }
                Err(error) => {
                    self.record_health_sync_event(
                        "openwebui_auth_failure",
                        json!({
                            "attempt": attempt,
                            "status": error.status,
                            "elapsed_ms": run_started.elapsed().as_millis(),
                            "message": truncate_safe_error_message(&error.message),
                        }),
                    );
                    warn!("Open WebUI service-token auth failed: {error}");
                }
            }

            if attempt < self.retries.main_retries {
                info!(
                    "Waiting {} seconds before retry...",
                    self.retries.main_delay.as_secs()
                );
                sleep(self.retries.main_delay).await;
            }
        }

        error!("Failed after {} attempts", self.retries.main_retries);
        self.record_health_sync_event(
            "health_sync_failure",
            json!({
                "stage": "startup",
                "reason": "attempts_exhausted",
                "attempts": self.retries.main_retries,
                "elapsed_ms": run_started.elapsed().as_millis(),
            }),
        );
        Ok(false)
    }

    pub(crate) async fn run_authenticated(&self, mut client: OpenWebUiClient) -> Result<bool> {
        if self.config.mode == HealthCheckMode::Full
            && !install_all_filters(&self.paths, &client).await?
        {
            return Ok(false);
        }

        let (configured_servers, ignored_user_collisions) = scan_configured_servers(&self.paths)?;
        let mcp_toggles = load_mcp_toggles(&self.paths)?;

        let host_servers_list = configured_servers
            .iter()
            .filter(|(_, metadata)| metadata.deployment_type == "host")
            .map(|(server_id, metadata)| (server_id.clone(), metadata.name.clone()))
            .collect::<Vec<_>>();
        let host_servers_enabled_list = host_servers_list
            .iter()
            .filter(|(server_id, _)| {
                get_server_enablement_state(
                    server_id,
                    configured_servers
                        .get(server_id)
                        .expect("server metadata must exist"),
                    &mcp_toggles,
                    &self.paths,
                    self.config.oauth_token_max_age_seconds,
                )
                .0
            })
            .cloned()
            .collect::<Vec<_>>();

        let should_check_host_mcpo = is_host_mode_supported(&self.paths)
            && !host_servers_list.is_empty()
            && !host_servers_enabled_list.is_empty();

        let (mut core_tools_dict, mut regular_tools_dict, mut servers_without_tools) =
            discover_mcp_servers(
                &self.http_client,
                &self.config,
                &self.retries,
                should_check_host_mcpo,
            )
            .await?;
        let mut status_probe_details = BTreeMap::new();
        reconcile_missing_configured_servers_from_status(
            &self.http_client,
            &self.config,
            &self.retries,
            &configured_servers,
            &mcp_toggles,
            &self.paths,
            &mut core_tools_dict,
            &mut regular_tools_dict,
            &mut servers_without_tools,
            &mut status_probe_details,
        )
        .await?;
        let discovered_tool_host_map = merge_tool_maps(&core_tools_dict, &regular_tools_dict);
        let tool_host_map = if self.config.core_only_sync {
            core_tools_dict.clone()
        } else {
            discovered_tool_host_map.clone()
        };

        if core_tools_dict.is_empty() {
            error!("No core MCP tools found");
            return Ok(false);
        }

        if !self.config.sync_enabled {
            if load_lm_studio_config(&self.paths)?.is_some() {
                match get_openwebui_user_id(&client, &self.retries).await? {
                    Some(user_id) => {
                        match sync_lm_studio_models(
                            &self.paths,
                            &self.http_client,
                            &client,
                            &user_id,
                            self.retries.request_timeout,
                        )
                        .await
                        {
                            Ok(result) => self.record_health_sync_event(
                                "lm_studio_sync",
                                json!({
                                    "configured": result.configured,
                                    "reachable": result.reachable,
                                    "model_count": result.model_ids.len(),
                                    "internal_model_count": result.internal_model_ids.len(),
                                    "created": result.created,
                                    "updated": result.updated,
                                    "disabled": result.disabled,
                                }),
                            ),
                            Err(error) => {
                                self.record_health_sync_event(
                                    "lm_studio_sync_error",
                                    json!({
                                        "error": truncate_safe_error_message(&format!("{error:#}")),
                                    }),
                                );
                                warn!("LM Studio sync failed during light health check: {error:#}");
                            }
                        }
                    }
                    None => {
                        warn!("Skipping LM Studio sync because OpenWebUI user ID is unavailable")
                    }
                }
            }
            let preserved_server_ids = BTreeSet::new();
            return generate_health_status(
                &self.paths,
                &self.config,
                &configured_servers,
                &mcp_toggles,
                &discovered_tool_host_map,
                &servers_without_tools,
                &status_probe_details,
                &preserved_server_ids,
                &ignored_user_collisions,
                self.log_inspector.as_ref(),
                &self.http_client,
            )
            .await;
        }

        let (migration_mapping, mut migration_data) =
            build_migration_mapping(&client, &discovered_tool_host_map).await?;
        let oauth_status = fetch_combined_oauth_status(&self.http_client, &self.config).await?;
        let preserved_server_ids = compute_preserved_server_ids(
            &self.paths,
            &self.config,
            &configured_servers,
            &mcp_toggles,
            &tool_host_map,
            &servers_without_tools,
            &status_probe_details,
            &oauth_status,
            self.log_inspector.as_ref(),
        );
        let existing_tool_server_connections = if preserved_server_ids.is_empty() {
            Vec::new()
        } else {
            fetch_existing_tool_server_connections(&client).await?
        };
        let tool_server_connections = build_tool_server_connections(
            &self.config,
            &tool_host_map,
            &existing_tool_server_connections,
            &preserved_server_ids,
        );
        self.record_health_sync_event(
            "health_sync_phase_start",
            json!({
                "phase": "tool_server_sync",
                "tool_server_connection_count": tool_server_connections.len(),
            }),
        );
        let configure_tools_response = client
            .request(
                Method::POST,
                "/api/v1/configs/tool_servers",
                Some(&json!({ "TOOL_SERVER_CONNECTIONS": tool_server_connections })),
                None,
                true,
            )
            .await?;
        log_api_call(
            &self.paths,
            self.config.write_api_logs,
            "configure_tool_servers",
            Some(json!({
                "url": "/api/v1/configs/tool_servers",
                "method": "POST",
                "body": { "TOOL_SERVER_CONNECTIONS": tool_server_connections.clone() },
                "tool_count": tool_server_connections.len(),
            })),
            Some(json!({
                "status": configure_tools_response.status,
                "ok": configure_tools_response.ok,
                "data": configure_tools_response.text,
            })),
            None,
        )?;
        if !configure_tools_response.ok {
            error!("Failed to configure tool servers");
            return Ok(false);
        }
        self.record_health_sync_event(
            "tool_server_sync_complete",
            json!({
                "status": configure_tools_response.status,
                "tool_server_connection_count": tool_server_connections.len(),
            }),
        );

        let user_id = match get_openwebui_user_id(&client, &self.retries).await? {
            Some(user_id) => user_id,
            None => return Ok(false),
        };

        let tool_list_payload = client.get_json("/api/v1/tools/", None).await?;
        let tool_list = unwrap_models_response(&tool_list_payload);
        let tool_ids = tool_list
            .iter()
            .filter_map(|tool| {
                tool.get("id")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
            })
            .collect::<Vec<_>>();
        let core_tool_ids = tool_ids
            .iter()
            .filter(|tool_id| REQUIRED_CORE_IDS.iter().any(|required| tool_id == required))
            .cloned()
            .collect::<Vec<_>>();
        if core_tool_ids.len() != REQUIRED_CORE_IDS.len() {
            error!("Failed to identify required core tool server IDs");
            return Ok(false);
        }

        self.record_health_sync_event(
            "health_sync_phase_start",
            json!({ "phase": "lm_studio_sync" }),
        );
        let lm_studio_sync = match sync_lm_studio_models(
            &self.paths,
            &self.http_client,
            &client,
            &user_id,
            self.retries.request_timeout,
        )
        .await
        {
            Ok(result) => {
                self.record_health_sync_event(
                    "lm_studio_sync",
                    json!({
                        "configured": result.configured,
                        "reachable": result.reachable,
                        "model_count": result.model_ids.len(),
                        "internal_model_count": result.internal_model_ids.len(),
                        "created": result.created,
                        "updated": result.updated,
                        "disabled": result.disabled,
                    }),
                );
                result
            }
            Err(error) => {
                self.record_health_sync_event(
                    "lm_studio_sync_error",
                    json!({
                        "error": truncate_safe_error_message(&format!("{error:#}")),
                    }),
                );
                warn!("LM Studio sync failed: {error:#}");
                LmStudioSyncResult::default()
            }
        };

        if !install_all_agents(&self.paths, &client, &core_tool_ids, &tool_ids).await? {
            return Ok(false);
        }

        let marker_status =
            model_sync_marker_status(&self.paths, &self.config.health_sync_session_id)?;
        let model_sync_already_completed = marker_status.matches;
        let mut model_sync_required = !model_sync_already_completed;
        self.record_health_sync_event(
            "model_sync_marker_decision",
            json!({
                "already_completed": model_sync_already_completed,
                "required": model_sync_required,
                "marker_file_exists": marker_status.marker_file_exists,
                "expected_marker": short_marker(&marker_status.expected_marker),
                "stored_marker": marker_status.stored_marker.as_deref().map(short_marker),
                "marker_matches": marker_status.matches,
                "fingerprint": marker_status.fingerprint.clone(),
                "health_sync_session_id_present": !self.config.health_sync_session_id.is_empty(),
            }),
        );
        let mut models_from_config: Vec<ConfiguredBaseModel> = Vec::new();
        match load_models_from_model_catalog(&self.paths) {
            Ok(models) => {
                self.record_health_sync_event(
                    "model_catalog_loaded",
                    json!({
                        "model_config_count": models.len(),
                        "model_ids": configured_model_ids(&models),
                    }),
                );
                models_from_config = models;
            }
            Err(error) => {
                self.record_health_sync_event(
                    "model_catalog_error",
                    json!({
                        "error": truncate_safe_error_message(&format!("{error:#}")),
                    }),
                );
                warn!(
                    "Skipping model sync to avoid destructive reconciliation without model config: {error:#}"
                );
                model_sync_required = false;
            }
        }
        let configured_model_ids = configured_model_ids(&models_from_config);

        self.record_health_sync_event(
            "health_sync_phase_start",
            json!({ "phase": "owui_model_inventory" }),
        );
        let mut model_sync_degraded = false;
        let mut model_sync_degradation_reason: Option<String> = None;
        let mut model_sync_degradation_stage: Option<&'static str> = None;
        let mut model_inventory =
            match load_owui_model_inventory(&client, &configured_model_ids).await {
                Ok(inventory) => inventory,
                Err(error) => {
                    let safe_error = truncate_safe_error_message(&format!("{error:#}"));
                    self.record_health_sync_event(
                        "owui_model_inventory_error",
                        json!({
                            "error": safe_error,
                        }),
                    );
                    warn!(
                    "Model inventory sync failed; continuing with degraded model sync: {error:#}"
                );
                    model_sync_degraded = true;
                    model_sync_degradation_stage = Some("owui_model_inventory");
                    model_sync_degradation_reason = Some(safe_error);
                    model_sync_required = false;
                    OwuiModelInventory::default()
                }
            };

        let mut user_settings = if model_sync_degraded {
            json!({})
        } else {
            client
                .get_json("/api/v1/users/user/settings", None)
                .await
                .map_err(|error| {
                    anyhow!("failed to load user settings before model sync: {error}")
                })?
        };
        let mut current_default_model = current_default_model_from_settings(&user_settings);

        self.record_health_sync_event(
            "owui_model_inventory_loaded",
            json!({
                "picker_model_count": model_inventory.picker_model_count,
                "wrapper_model_count": model_inventory.wrapper_model_count,
                "base_model_count": model_inventory.base_model_count,
                "lm_studio_model_count": model_inventory.lm_studio_model_count,
                "disabled_model_count": model_inventory.disabled_model_count,
                "configured_model_count": configured_model_ids.len(),
                "missing_configured_model_ids": model_inventory.missing_configured_model_ids.clone(),
                "configured_model_ids_missing_from_picker_base_models": model_inventory.configured_model_ids_missing_from_picker_base_models.clone(),
                "current_default_model": current_default_model.as_deref().unwrap_or(""),
            }),
        );

        if !model_sync_degraded
            && model_sync_already_completed
            && !models_from_config.is_empty()
            && (model_inventory.picker_model_count == 0
                || !model_inventory.missing_configured_model_ids.is_empty()
                || !model_inventory
                    .configured_model_ids_missing_from_picker_base_models
                    .is_empty())
        {
            self.record_health_sync_event(
                "model_sync_marker_invalidated",
                json!({
                    "reason": if model_inventory.picker_model_count == 0 {
                        "empty_picker_inventory"
                    } else if !model_inventory.missing_configured_model_ids.is_empty() {
                        "missing_configured_models"
                    } else {
                        "configured_models_not_visible_as_base_models"
                    },
                    "picker_model_count": model_inventory.picker_model_count,
                    "wrapper_model_count": model_inventory.wrapper_model_count,
                    "missing_configured_model_ids": model_inventory.missing_configured_model_ids.clone(),
                    "configured_model_ids_missing_from_picker_base_models": model_inventory.configured_model_ids_missing_from_picker_base_models.clone(),
                    "stored_marker": marker_status.stored_marker.as_deref().map(short_marker),
                }),
            );
            model_sync_required = true;
        }

        if !model_sync_degraded && model_sync_already_completed {
            let stale_default = current_default_model
                .as_deref()
                .and_then(retired_model_migration_target)
                .is_some();
            let stale_tasks = match scheduled_tasks_need_model_migration(&self.paths) {
                Ok(stale) => stale,
                Err(error) => {
                    self.record_health_sync_event(
                        "scheduled_task_inventory_error",
                        json!({
                            "error": truncate_safe_error_message(&format!("{error:#}")),
                        }),
                    );
                    true
                }
            };
            if model_inventory.deprecated_reference_count > 0 || stale_default || stale_tasks {
                self.record_health_sync_event(
                    "model_sync_marker_invalidated",
                    json!({
                        "reason": "deprecated_model_reference",
                        "derived_model_references": model_inventory.deprecated_reference_count,
                        "stale_default": stale_default,
                        "stale_scheduled_task": stale_tasks,
                    }),
                );
                model_sync_required = true;
            }
        }

        let model_sync_owner = if !self.config.health_sync_run_id.trim().is_empty() {
            self.config.health_sync_run_id.clone()
        } else if !self.config.health_sync_session_id.trim().is_empty() {
            self.config.health_sync_session_id.clone()
        } else {
            format!("health-check-{}", std::process::id())
        };
        let mut model_sync_epoch = marker_status.stored_epoch.unwrap_or(0);
        let mut model_sync_lease_acquired = false;
        if model_sync_required {
            model_sync_epoch = if let Some(store) = self.token_store.as_deref() {
                let epoch = store.begin_model_sync_epoch(
                    &model_sync_owner,
                    MODEL_SYNC_LEASE_TTL_MS,
                    marker_status.stored_epoch.unwrap_or(0),
                )?;
                model_sync_lease_acquired = true;
                epoch
            } else {
                model_sync_epoch.saturating_add(1)
            };
            client.set_model_sync_fence(model_sync_epoch, model_sync_owner.clone());
            if let Err(error) = mark_model_sync_pending_for_epoch(
                &self.paths,
                &self.config.health_sync_session_id,
                model_sync_epoch,
                &model_sync_owner,
                self.token_store.as_deref(),
            ) {
                if model_sync_lease_acquired {
                    self.release_model_sync_lease_best_effort(&model_sync_owner, model_sync_epoch);
                }
                return Err(error);
            }

            model_inventory = match load_owui_model_inventory(&client, &configured_model_ids).await
            {
                Ok(inventory) => inventory,
                Err(error) => {
                    if model_sync_lease_acquired {
                        self.release_model_sync_lease_best_effort(
                            &model_sync_owner,
                            model_sync_epoch,
                        );
                    }
                    return Err(error.context(
                        "failed to reload authoritative model inventory after acquiring sync lease",
                    ));
                }
            };
            user_settings = match client.get_json("/api/v1/users/user/settings", None).await {
                Ok(settings) => settings,
                Err(error) => {
                    if model_sync_lease_acquired {
                        self.release_model_sync_lease_best_effort(
                            &model_sync_owner,
                            model_sync_epoch,
                        );
                    }
                    return Err(anyhow!(
                        "failed to reload authoritative user settings after acquiring sync lease: {error}"
                    ));
                }
            };
            current_default_model = current_default_model_from_settings(&user_settings);
            self.record_health_sync_event(
                "model_sync_authoritative_snapshot_loaded",
                json!({
                    "epoch": model_sync_epoch,
                    "picker_model_count": model_inventory.picker_model_count,
                    "wrapper_model_count": model_inventory.wrapper_model_count,
                    "current_default_model": current_default_model.as_deref().unwrap_or(""),
                }),
            );
        } else if marker_status.legacy_marker {
            mark_model_sync_completed_for_session(
                &self.paths,
                &self.config.health_sync_session_id,
            )?;
        }

        let existing_base_model_ids = if model_sync_required {
            model_inventory.existing_base_model_ids.clone()
        } else {
            Vec::new()
        };

        let models_to_delete = if model_sync_required {
            existing_base_model_ids
                .iter()
                .filter(|model_id| is_obsolete_managed_model_id(model_id))
                .cloned()
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };

        let mut system_prompts_backed_up = 0;
        let mut base_system_prompt = String::new();
        if model_sync_required {
            match backup_system_prompts(&self.paths, &client, &models_to_delete).await {
                Ok(count) => system_prompts_backed_up = count,
                Err(error) => {
                    let safe_error = truncate_safe_error_message(&format!("{error:#}"));
                    self.record_health_sync_event(
                        "model_sync_degraded",
                        json!({
                            "stage": "system_prompt_backup",
                            "error": safe_error,
                        }),
                    );
                    warn!("System prompt backup failed; continuing with degraded model sync: {error:#}");
                    model_sync_degraded = true;
                    model_sync_degradation_stage = Some("system_prompt_backup");
                    model_sync_degradation_reason = Some(safe_error);
                    model_sync_required = false;
                }
            }
        }

        if model_sync_required {
            match get_base_system_prompt(&self.paths) {
                Ok(prompt) => {
                    match update_base_models_system_prompt(&client, &prompt, &models_to_delete)
                        .await
                    {
                        Ok(true) => base_system_prompt = prompt,
                        Ok(false) => {
                            self.record_health_sync_event(
                                "model_sync_degraded",
                                json!({
                                    "stage": "base_system_prompt_update",
                                    "error": "Open WebUI rejected one or more base model system prompt updates",
                                }),
                            );
                            warn!(
                                "Base model system prompt update failed; continuing with degraded model sync"
                            );
                            model_sync_degraded = true;
                            model_sync_degradation_stage = Some("base_system_prompt_update");
                            model_sync_degradation_reason = Some(
                                "Open WebUI rejected one or more base model system prompt updates"
                                    .to_string(),
                            );
                            model_sync_required = false;
                        }
                        Err(error) => {
                            let safe_error = truncate_safe_error_message(&format!("{error:#}"));
                            self.record_health_sync_event(
                                "model_sync_degraded",
                                json!({
                                    "stage": "base_system_prompt_update",
                                    "error": safe_error,
                                }),
                            );
                            warn!("Base model system prompt update failed; continuing with degraded model sync: {error:#}");
                            model_sync_degraded = true;
                            model_sync_degradation_stage = Some("base_system_prompt_update");
                            model_sync_degradation_reason = Some(safe_error);
                            model_sync_required = false;
                        }
                    }
                }
                Err(error) => {
                    let safe_error = truncate_safe_error_message(&format!("{error:#}"));
                    self.record_health_sync_event(
                        "model_sync_degraded",
                        json!({
                            "stage": "base_system_prompt_load",
                            "error": safe_error,
                        }),
                    );
                    warn!("Base system prompt load failed; continuing with degraded model sync: {error:#}");
                    model_sync_degraded = true;
                    model_sync_degradation_stage = Some("base_system_prompt_load");
                    model_sync_degradation_reason = Some(safe_error);
                    model_sync_required = false;
                }
            }
        }

        let target_default_model = resolve_target_default_model_with_accessible(
            current_default_model,
            &models_from_config,
            model_sync_required,
            &model_inventory.accessible_model_ids,
        );
        let base_model_sync_counts = if model_sync_required {
            match configure_base_models(
                &self.paths,
                &client,
                &user_id,
                &models_from_config,
                &existing_base_model_ids,
                &base_system_prompt,
                &core_tool_ids,
                &target_default_model,
            )
            .await
            {
                Ok(counts) => counts,
                Err(error) => {
                    let safe_error = truncate_safe_error_message(&format!("{error:#}"));
                    self.record_health_sync_event(
                        "model_sync_degraded",
                        json!({
                            "stage": "base_model_configure",
                            "error": safe_error,
                        }),
                    );
                    warn!("Base model configuration failed; continuing with degraded model sync: {error:#}");
                    model_sync_degraded = true;
                    model_sync_degradation_stage = Some("base_model_configure");
                    model_sync_degradation_reason = Some(safe_error);
                    model_sync_required = false;
                    BaseModelSyncCounts::default()
                }
            }
        } else {
            BaseModelSyncCounts::default()
        };
        let base_models_updated = base_model_sync_counts.updated;
        let base_models_created = base_model_sync_counts.created;
        let base_models_unchanged = base_model_sync_counts.unchanged;
        self.record_health_sync_event(
            "base_model_sync_complete",
            json!({
                "model_sync_required": model_sync_required,
                "configured_model_count": models_from_config.len(),
                "configured_model_ids": configured_model_ids.clone(),
                "base_models_updated": base_models_updated,
                "base_models_created": base_models_created,
                "base_models_unchanged": base_models_unchanged,
                "target_default_model": &target_default_model,
                "degraded": model_sync_degraded,
            }),
        );

        // Model migrations are one-time per catalog change: they run only when
        // the model sync fingerprint requires it (PORTICO-213), mirroring the
        // default-model bump and tool-id migration gating. This keeps still-
        // available models (e.g. Atlas Sonnet 4.6) re-pinnable afterwards.
        let user_models_migrated = if model_sync_degraded || !model_sync_required {
            0
        } else {
            match migrate_user_models(&client, &user_id).await {
                Ok(count) => count,
                Err(error) => {
                    let safe_error = truncate_safe_error_message(&format!("{error:#}"));
                    self.record_health_sync_event(
                        "model_sync_degraded",
                        json!({
                            "stage": "user_model_migration",
                            "error": safe_error,
                        }),
                    );
                    warn!("User model migration failed; continuing with degraded model sync: {error:#}");
                    model_sync_degraded = true;
                    model_sync_degradation_stage = Some("user_model_migration");
                    model_sync_degradation_reason = Some(safe_error);
                    0
                }
            }
        };
        self.record_health_sync_event(
            "user_model_migration_complete",
            json!({
                "user_models_migrated": user_models_migrated,
                "model_sync_required": model_sync_required,
                "degraded": model_sync_degraded,
            }),
        );
        let scheduled_tasks_migrated = if model_sync_degraded || !model_sync_required {
            0
        } else {
            match migrate_scheduled_task_models(&self.paths) {
                Ok(count) => count,
                Err(error) => {
                    let safe_error = truncate_safe_error_message(&format!("{error:#}"));
                    self.record_health_sync_event(
                        "model_sync_degraded",
                        json!({
                            "stage": "scheduled_task_model_migration",
                            "error": safe_error,
                        }),
                    );
                    warn!(
                        "Scheduled task model migration failed; continuing with degraded model sync: {error:#}"
                    );
                    model_sync_degraded = true;
                    model_sync_degradation_stage = Some("scheduled_task_model_migration");
                    model_sync_degradation_reason = Some(safe_error);
                    0
                }
            }
        };
        self.record_health_sync_event(
            "scheduled_task_model_migration_complete",
            json!({
                "scheduled_tasks_migrated": scheduled_tasks_migrated,
                "model_sync_required": model_sync_required,
                "degraded": model_sync_degraded,
            }),
        );

        let models_migrated_count = if !model_sync_degraded
            && model_sync_required
            && !migration_mapping.is_empty()
        {
            match apply_tool_id_migration(
                &self.paths,
                &client,
                &user_id,
                &migration_mapping,
                &mut migration_data,
            )
            .await
            {
                Ok(count) => count,
                Err(error) => {
                    let safe_error = truncate_safe_error_message(&format!("{error:#}"));
                    self.record_health_sync_event(
                        "model_sync_degraded",
                        json!({
                            "stage": "tool_id_model_migration",
                            "error": safe_error,
                        }),
                    );
                    warn!(
                            "Tool id model migration failed; continuing with degraded model sync: {error:#}"
                        );
                    model_sync_degraded = true;
                    model_sync_degradation_stage = Some("tool_id_model_migration");
                    model_sync_degradation_reason = Some(safe_error);
                    0
                }
            }
        } else {
            0
        };
        self.record_health_sync_event(
            "tool_id_model_migration_complete",
            json!({
                "models_migrated": models_migrated_count,
                "degraded": model_sync_degraded,
            }),
        );

        let mut models_deleted = 0;
        let settings_payload = build_user_settings_payload(&user_settings, &target_default_model);
        self.record_health_sync_event(
            "health_sync_phase_start",
            json!({
                "phase": "user_settings_update",
                "target_default_model": &target_default_model,
            }),
        );
        if model_sync_degraded {
            self.record_health_sync_event(
                "user_settings_update_skipped",
                json!({
                    "reason": "model_sync_degraded",
                    "target_default_model": &target_default_model,
                }),
            );
        } else {
            match client
                .request(
                    Method::POST,
                    "/api/v1/users/user/settings/update",
                    Some(&settings_payload),
                    None,
                    true,
                )
                .await
            {
                Ok(settings_response) if settings_response.ok => {
                    self.record_health_sync_event(
                        "user_settings_update_complete",
                        json!({
                            "status": settings_response.status,
                            "target_default_model": &target_default_model,
                        }),
                    );
                }
                Ok(settings_response) => {
                    error!("Failed to update user settings");
                    self.record_health_sync_event(
                        "user_settings_update_failed",
                        json!({
                            "status": settings_response.status,
                            "content_type": settings_response.content_type,
                        }),
                    );
                    model_sync_degraded = true;
                    model_sync_degradation_stage = Some("user_settings_update");
                    model_sync_degradation_reason =
                        Some(format!("HTTP {:?}", settings_response.status));
                }
                Err(error) => {
                    let safe_error = truncate_safe_error_message(&format!("{error:#}"));
                    self.record_health_sync_event(
                        "user_settings_update_failed",
                        json!({
                            "error": safe_error,
                        }),
                    );
                    warn!("User settings update failed; continuing with degraded model sync: {error:#}");
                    model_sync_degraded = true;
                    model_sync_degradation_stage = Some("user_settings_update");
                    model_sync_degradation_reason = Some(safe_error);
                }
            }
        }

        if !model_sync_degraded && model_sync_required {
            if let Some(store) = self.token_store.as_deref() {
                if let Err(error) =
                    store.verify_model_sync_epoch(&model_sync_owner, model_sync_epoch)
                {
                    if model_sync_lease_acquired {
                        self.release_model_sync_lease_best_effort(
                            &model_sync_owner,
                            model_sync_epoch,
                        );
                    }
                    return Err(error);
                }
            }
            match disable_obsolete_models(&client, &user_id, &models_to_delete).await {
                Ok(count) => models_deleted = count,
                Err(error) => {
                    let safe_error = truncate_safe_error_message(&format!("{error:#}"));
                    self.record_health_sync_event(
                        "model_sync_degraded",
                        json!({
                            "stage": "obsolete_model_retire",
                            "error": safe_error,
                        }),
                    );
                    warn!(
                        "Obsolete model retirement failed; model sync remains pending: {error:#}"
                    );
                    model_sync_degraded = true;
                    model_sync_degradation_stage = Some("obsolete_model_retire");
                    model_sync_degradation_reason = Some(safe_error);
                }
            }
        }
        self.record_health_sync_event(
            "obsolete_model_retire_complete",
            json!({
                "models_retired": models_deleted,
                "degraded": model_sync_degraded,
            }),
        );
        if model_sync_required && !model_sync_degraded {
            match audit_model_sync_referential_integrity(
                &client,
                &self.paths,
                &configured_model_ids,
                &models_to_delete,
                &target_default_model,
            )
            .await
            {
                Ok(()) => {
                    self.record_health_sync_event(
                        "model_sync_referential_audit_complete",
                        json!({
                            "configured_model_count": configured_model_ids.len(),
                            "retired_model_count": models_to_delete.len(),
                            "target_default_model": &target_default_model,
                        }),
                    );
                }
                Err(error) => {
                    let safe_error = truncate_safe_error_message(&format!("{error:#}"));
                    self.record_health_sync_event(
                        "model_sync_degraded",
                        json!({
                            "stage": "referential_integrity_audit",
                            "error": safe_error,
                        }),
                    );
                    warn!(
                        "Model referential integrity audit failed; model sync remains pending: {error:#}"
                    );
                    model_sync_degraded = true;
                    model_sync_degradation_stage = Some("referential_integrity_audit");
                    model_sync_degradation_reason = Some(safe_error);
                }
            }
        }

        if model_sync_required && !model_sync_degraded {
            if let Some(store) = self.token_store.as_deref() {
                if let Err(error) =
                    store.verify_model_sync_epoch(&model_sync_owner, model_sync_epoch)
                {
                    if model_sync_lease_acquired {
                        self.release_model_sync_lease_best_effort(
                            &model_sync_owner,
                            model_sync_epoch,
                        );
                    }
                    return Err(error);
                }
            }
            if let Err(error) = mark_model_sync_completed_for_epoch(
                &self.paths,
                &self.config.health_sync_session_id,
                model_sync_epoch,
                &model_sync_owner,
                self.token_store.as_deref(),
            ) {
                if model_sync_lease_acquired {
                    self.release_model_sync_lease_best_effort(&model_sync_owner, model_sync_epoch);
                }
                return Err(error);
            }
            if model_sync_lease_acquired {
                self.release_model_sync_lease_best_effort(&model_sync_owner, model_sync_epoch);
                model_sync_lease_acquired = false;
            }
            let marker_status =
                model_sync_marker_status(&self.paths, &self.config.health_sync_session_id)?;
            self.record_health_sync_event(
                "model_sync_marker_written",
                json!({
                    "stored_marker": marker_status.stored_marker.as_deref().map(short_marker),
                    "expected_marker": short_marker(&marker_status.expected_marker),
                    "marker_matches": marker_status.matches,
                }),
            );
        }

        if model_sync_lease_acquired {
            self.release_model_sync_lease_best_effort(&model_sync_owner, model_sync_epoch);
        }

        let model_sync_status = if model_sync_degraded {
            "degraded"
        } else if model_sync_required {
            "complete"
        } else {
            "skipped"
        };

        self.record_health_sync_event(
            "health_sync_summary",
            json!({
                "tool_server_connection_count": tool_server_connections.len(),
                "base_models_updated": base_models_updated,
                "base_models_created": base_models_created,
                "base_models_unchanged": base_models_unchanged,
                "user_models_migrated": user_models_migrated,
                "scheduled_tasks_migrated": scheduled_tasks_migrated,
                "models_migrated": models_migrated_count,
                "models_deleted": models_deleted,
                "system_prompt_backups": system_prompts_backed_up,
                "model_sync_status": model_sync_status,
                "model_sync_degraded": model_sync_degraded,
                "model_sync_degradation_stage": model_sync_degradation_stage,
                "model_sync_degradation_reason": model_sync_degradation_reason,
                "lm_studio_configured": lm_studio_sync.configured,
                "lm_studio_reachable": lm_studio_sync.reachable,
                "lm_studio_created": lm_studio_sync.created,
                "lm_studio_updated": lm_studio_sync.updated,
                "lm_studio_disabled": lm_studio_sync.disabled,
            }),
        );

        info!(
            "Health check summary: tools={}, base_models_updated={}, base_models_created={}, base_models_unchanged={}, user_models_migrated={}, scheduled_tasks_migrated={}, models_migrated={}, models_deleted={}, backups={}, model_sync_status={}, lm_studio_configured={}, lm_studio_reachable={}, lm_studio_created={}, lm_studio_updated={}, lm_studio_disabled={}",
            tool_server_connections.len(),
            base_models_updated,
            base_models_created,
            base_models_unchanged,
            user_models_migrated,
            scheduled_tasks_migrated,
            models_migrated_count,
            models_deleted,
            system_prompts_backed_up,
            model_sync_status,
            lm_studio_sync.configured,
            lm_studio_sync.reachable,
            lm_studio_sync.created,
            lm_studio_sync.updated,
            lm_studio_sync.disabled
        );

        generate_health_status(
            &self.paths,
            &self.config,
            &configured_servers,
            &mcp_toggles,
            &discovered_tool_host_map,
            &servers_without_tools,
            &status_probe_details,
            &preserved_server_ids,
            &ignored_user_collisions,
            self.log_inspector.as_ref(),
            &self.http_client,
        )
        .await
    }
}

pub async fn run_default() -> Result<bool> {
    let paths = AppPaths::from_env();
    let config = RuntimeConfig::load(&paths);
    let retries = RetryConfig::default();
    let skip_redis = skip_redis_override();
    let token_store = if skip_redis {
        None
    } else {
        connect_redis_token_store(&retries).await?
    };
    if token_store.is_none() && !skip_redis {
        return Ok(false);
    }
    let app = HealthCheckApp::new(
        paths,
        config,
        retries,
        token_store.map(|store| Arc::new(store) as Arc<dyn TokenStore>),
        Arc::new(DockerCliLogInspector),
    );
    app.run().await
}

pub(crate) async fn connect_redis_token_store(
    retries: &RetryConfig,
) -> Result<Option<RedisTokenStore>> {
    for attempt in 1..=retries.redis_retries {
        match RedisTokenStore::connect_once() {
            Ok(store) => return Ok(Some(store)),
            Err(error) => {
                warn!(
                    "Redis connection attempt {attempt}/{} failed: {error:#}",
                    retries.redis_retries
                );
                if attempt < retries.redis_retries {
                    sleep(retries.redis_delay).await;
                }
            }
        }
    }
    error!(
        "Failed to connect to Redis after {} attempts",
        retries.redis_retries
    );
    Ok(None)
}

pub fn build_http_error_message(status: Option<u16>, response_text: &str) -> String {
    match status {
        Some(status) if response_text.trim().is_empty() => format!("HTTP {status}"),
        Some(status) => format!(
            "HTTP {status}: {}",
            response_text.trim().chars().take(200).collect::<String>()
        ),
        None if response_text.trim().is_empty() => "Unknown error".to_string(),
        None => response_text.to_string(),
    }
}

pub(crate) fn parse_json_response(
    path: &str,
    response: &RawResponse,
) -> Result<Value, OpenWebUiApiError> {
    if response.text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&response.text).map_err(|error| {
        OpenWebUiApiError::new(
            format!(
                "Expected JSON response from {path} (content-type={}): {}. Body preview: {}",
                if response.content_type.is_empty() {
                    "unknown"
                } else {
                    &response.content_type
                },
                error,
                response
                    .text
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .chars()
                    .take(200)
                    .collect::<String>()
            ),
            response.status,
            response.text.clone(),
        )
    })
}

pub fn get_health_check_mode(paths: &AppPaths) -> HealthCheckMode {
    let candidate = std::env::var("HEALTH_CHECK_MODE")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            if !paths.health_check_mode_file.exists() {
                return None;
            }
            match read_trimmed_file(&paths.health_check_mode_file) {
                Ok(mode) => Some(mode),
                Err(error) => {
                    warn!("Failed to read health check mode file: {error}");
                    None
                }
            }
        })
        .unwrap_or_else(|| "full".to_string());
    match HealthCheckMode::from_str(&candidate) {
        Some(mode) => mode,
        None => {
            if !candidate.trim().is_empty() {
                warn!("Unknown health check mode '{candidate}', defaulting to full");
            }
            HealthCheckMode::Full
        }
    }
}

pub fn get_health_sync_session_id(paths: &AppPaths) -> String {
    if let Some(session_id) = std::env::var("HEALTH_SYNC_SESSION_ID")
        .ok()
        .filter(|value| !value.trim().is_empty())
    {
        return session_id;
    }

    if !paths.health_sync_session_id_file.exists() {
        return String::new();
    }

    match read_trimmed_file(&paths.health_sync_session_id_file) {
        Ok(session_id) => session_id,
        Err(error) => {
            warn!("Failed to read health sync session file: {error}");
            String::new()
        }
    }
}

pub fn get_health_sync_run_id(paths: &AppPaths) -> String {
    if let Some(run_id) = std::env::var("HEALTH_SYNC_RUN_ID")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        return run_id;
    }

    if let Some(run_id) =
        read_optional_health_sync_metadata_file(&paths.health_sync_run_id_file, "run id")
    {
        return run_id;
    }

    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("{millis}-{}", std::process::id())
}

pub fn get_health_sync_reason(paths: &AppPaths) -> String {
    if let Some(reason) = std::env::var("HEALTH_SYNC_REASON")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        return reason;
    }

    read_optional_health_sync_metadata_file(&paths.health_sync_reason_file, "reason")
        .unwrap_or_else(|| "unspecified".to_string())
}

pub fn get_health_sync_timeout_budget_ms(paths: &AppPaths) -> Option<u64> {
    if let Some(timeout) = std::env::var("HEALTH_SYNC_TIMEOUT_BUDGET_MS")
        .ok()
        .and_then(|value| parse_health_sync_timeout_budget_ms("env", &value))
    {
        return Some(timeout);
    }

    read_optional_health_sync_metadata_file(
        &paths.health_sync_timeout_budget_ms_file,
        "timeout budget",
    )
    .and_then(|value| parse_health_sync_timeout_budget_ms("file", &value))
}

fn read_optional_health_sync_metadata_file(path: &Path, label: &str) -> Option<String> {
    if !path.exists() {
        return None;
    }

    match read_trimmed_file(path) {
        Ok(value) if !value.is_empty() => Some(value),
        Ok(_) => None,
        Err(error) => {
            warn!("Failed to read health sync {label} file: {error}");
            None
        }
    }
}

fn parse_health_sync_timeout_budget_ms(source: &str, value: &str) -> Option<u64> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    match trimmed.parse::<u64>() {
        Ok(timeout) if timeout > 0 => Some(timeout),
        _ => {
            warn!("Ignoring invalid health sync timeout budget from {source}: {trimmed}");
            None
        }
    }
}

pub(crate) const MODEL_ICON_RESOLVER_VERSION: &str = "model-icon-resolver-v3";

pub(crate) fn compute_legacy_model_sync_completion_marker(
    paths: &AppPaths,
    session_id: &str,
) -> Result<String> {
    if session_id.trim().is_empty() {
        return Ok(String::new());
    }
    let mut fingerprint_input = Vec::new();
    fingerprint_input.extend_from_slice(session_id.as_bytes());
    fingerprint_input.push(0);
    fingerprint_input.extend_from_slice(
        &fs::read(paths.agents_dir.join("base_system_prompt.md"))
            .context("failed to read legacy model sync base prompt")?,
    );
    fingerprint_input.push(0);
    fingerprint_input.extend_from_slice(
        &fs::read(&paths.model_catalog_file).context("failed to read legacy model sync catalog")?,
    );
    fingerprint_input.push(0);
    fingerprint_input.extend_from_slice(MODEL_ICON_RESOLVER_VERSION.as_bytes());
    fingerprint_input.push(0);
    for icon_file in [
        &paths.atlas_icon_file,
        &paths.gpt_icon_file,
        &paths.gemini_icon_file,
        &paths.sol_icon_file,
        &paths.terra_icon_file,
        &paths.luna_icon_file,
    ] {
        fingerprint_input.extend_from_slice(&fs::read(icon_file)?);
        fingerprint_input.push(0);
    }
    Ok(format!("{:x}", md5::compute(fingerprint_input)))
}

pub fn compute_model_sync_completion_marker(paths: &AppPaths, session_id: &str) -> Result<String> {
    if session_id.trim().is_empty() {
        return Ok(String::new());
    }

    let mut fingerprint_input = Vec::new();
    fingerprint_input.extend_from_slice(session_id.as_bytes());
    fingerprint_input.push(0);
    fingerprint_input.extend_from_slice(
        &fs::read(paths.agents_dir.join("base_system_prompt.md"))
            .context("failed to read base system prompt for model sync fingerprint")?,
    );
    fingerprint_input.push(0);
    fingerprint_input.extend_from_slice(
        &fs::read(&paths.model_catalog_file)
            .context("failed to read model catalog for model sync fingerprint")?,
    );
    fingerprint_input.push(0);
    fingerprint_input.extend_from_slice(MODEL_ICON_RESOLVER_VERSION.as_bytes());
    fingerprint_input.push(0);
    for icon_file in [
        &paths.atlas_icon_file,
        &paths.gpt_icon_file,
        &paths.gemini_icon_file,
        &paths.sol_icon_file,
        &paths.terra_icon_file,
        &paths.luna_icon_file,
    ] {
        fingerprint_input.extend_from_slice(&fs::read(icon_file).with_context(|| {
            format!(
                "failed to read model icon {} for sync fingerprint",
                icon_file.display()
            )
        })?);
        fingerprint_input.push(0);
    }
    fingerprint_input.extend_from_slice(MODEL_SYNC_POLICY_VERSION.as_bytes());
    fingerprint_input.push(0);
    fingerprint_input.extend_from_slice(
        serde_json::to_string(&deprecated_base_model_migration_map())?.as_bytes(),
    );
    fingerprint_input.push(0);
    fingerprint_input.extend_from_slice(if is_konami_unlock_enabled(paths) {
        b"konami-enabled"
    } else {
        b"konami-disabled"
    });

    Ok(format!("{:x}", md5::compute(fingerprint_input)))
}

fn file_exists_and_bytes(path: &Path) -> (bool, u64) {
    fs::metadata(path)
        .map(|metadata| (true, metadata.len()))
        .unwrap_or((false, 0))
}

pub fn model_sync_fingerprint_metadata(
    paths: &AppPaths,
    session_id: &str,
) -> ModelSyncFingerprintMetadata {
    let base_system_prompt = paths.agents_dir.join("base_system_prompt.md");
    let base_system_prompt_metadata = fs::metadata(&base_system_prompt).ok();
    let model_catalog_metadata = fs::metadata(&paths.model_catalog_file).ok();
    let (atlas_icon_exists, atlas_icon_bytes) = file_exists_and_bytes(&paths.atlas_icon_file);
    let (gpt_icon_exists, gpt_icon_bytes) = file_exists_and_bytes(&paths.gpt_icon_file);
    let (gemini_icon_exists, gemini_icon_bytes) = file_exists_and_bytes(&paths.gemini_icon_file);
    let (sol_icon_exists, sol_icon_bytes) = file_exists_and_bytes(&paths.sol_icon_file);
    let (terra_icon_exists, terra_icon_bytes) = file_exists_and_bytes(&paths.terra_icon_file);
    let (luna_icon_exists, luna_icon_bytes) = file_exists_and_bytes(&paths.luna_icon_file);

    ModelSyncFingerprintMetadata {
        session_id_present: !session_id.trim().is_empty(),
        base_system_prompt_exists: base_system_prompt_metadata.is_some(),
        base_system_prompt_bytes: base_system_prompt_metadata
            .map(|metadata| metadata.len())
            .unwrap_or(0),
        model_catalog_exists: model_catalog_metadata.is_some(),
        model_catalog_bytes: model_catalog_metadata
            .map(|metadata| metadata.len())
            .unwrap_or(0),
        model_icon_resolver_version: MODEL_ICON_RESOLVER_VERSION.to_string(),
        atlas_icon_exists,
        atlas_icon_bytes,
        gpt_icon_exists,
        gpt_icon_bytes,
        gemini_icon_exists,
        gemini_icon_bytes,
        sol_icon_exists,
        sol_icon_bytes,
        terra_icon_exists,
        terra_icon_bytes,
        luna_icon_exists,
        luna_icon_bytes,
    }
}

pub fn short_marker(marker: &str) -> String {
    marker.chars().take(12).collect()
}

fn is_legacy_model_sync_marker_format(raw: &str) -> bool {
    raw.len() == 32 && raw.chars().all(|character| character.is_ascii_hexdigit())
}

fn is_legacy_model_sync_session_marker_format(raw: &str) -> bool {
    let mut parts = raw.split('-');
    let Some(timestamp) = parts.next() else {
        return false;
    };
    let Some(process_id) = parts.next() else {
        return false;
    };
    let Some(nonce) = parts.next() else {
        return false;
    };

    parts.next().is_none()
        && !timestamp.is_empty()
        && timestamp
            .chars()
            .all(|character| character.is_ascii_digit())
        && !process_id.is_empty()
        && process_id
            .chars()
            .all(|character| character.is_ascii_digit())
        && nonce.len() == 12
        && nonce.chars().all(|character| character.is_ascii_hexdigit())
}

fn parse_model_sync_marker_v2(raw: &str) -> Result<Option<ModelSyncMarkerV2>> {
    match serde_json::from_str::<ModelSyncMarkerV2>(raw) {
        Ok(marker) => {
            if marker.version != MODEL_SYNC_MARKER_VERSION {
                return Err(anyhow!(
                    "unsupported model sync marker version {}",
                    marker.version
                ));
            }
            if !matches!(marker.state.as_str(), "pending" | "complete")
                || !is_legacy_model_sync_marker_format(&marker.fingerprint)
                || marker.owner.trim().is_empty()
                || marker.policy_version.trim().is_empty()
            {
                return Err(anyhow!("invalid model sync marker record"));
            }
            Ok(Some(marker))
        }
        Err(_)
            if is_legacy_model_sync_marker_format(raw)
                || is_legacy_model_sync_session_marker_format(raw) =>
        {
            Ok(None)
        }
        Err(error) => Err(anyhow!("invalid model sync marker: {error}")),
    }
}

pub fn model_sync_marker_status(
    paths: &AppPaths,
    session_id: &str,
) -> Result<ModelSyncMarkerStatus> {
    let marker_file_exists = paths.model_sync_completed_session_file.exists();
    if !marker_file_exists
        && (!paths.agents_dir.join("base_system_prompt.md").exists()
            || !paths.model_catalog_file.exists())
    {
        return Ok(ModelSyncMarkerStatus {
            marker_file_exists: false,
            expected_marker: String::new(),
            stored_marker: None,
            matches: false,
            legacy_marker: false,
            stored_epoch: None,
            stored_state: None,
            fingerprint: model_sync_fingerprint_metadata(paths, session_id),
        });
    }
    let expected_marker = compute_model_sync_completion_marker(paths, session_id)?;
    let stored_marker = if marker_file_exists {
        Some(
            read_trimmed_file(&paths.model_sync_completed_session_file).with_context(|| {
                format!(
                    "failed to read model sync marker {}",
                    paths.model_sync_completed_session_file.display()
                )
            })?,
        )
    } else {
        None
    };
    let parsed = stored_marker
        .as_deref()
        .map(parse_model_sync_marker_v2)
        .transpose()?
        .flatten();
    let legacy_fingerprint = compute_legacy_model_sync_completion_marker(paths, session_id)?;
    let legacy_marker = parsed.is_none()
        && stored_marker
            .as_deref()
            .is_some_and(|stored| stored == legacy_fingerprint);
    let matches = !expected_marker.trim().is_empty()
        && (legacy_marker
            || parsed.as_ref().is_some_and(|record| {
                record.version == MODEL_SYNC_MARKER_VERSION
                    && record.state == "complete"
                    && record.fingerprint == expected_marker
                    && record.policy_version == MODEL_SYNC_POLICY_VERSION
            }));

    Ok(ModelSyncMarkerStatus {
        marker_file_exists,
        expected_marker,
        stored_marker,
        matches,
        legacy_marker,
        stored_epoch: parsed.as_ref().map(|record| record.epoch),
        stored_state: parsed.as_ref().map(|record| record.state.clone()),
        fingerprint: model_sync_fingerprint_metadata(paths, session_id),
    })
}

pub fn has_model_sync_completed_for_session(paths: &AppPaths, session_id: &str) -> Result<bool> {
    Ok(model_sync_marker_status(paths, session_id)?.matches)
}

pub fn mark_model_sync_completed_for_session(paths: &AppPaths, session_id: &str) -> Result<()> {
    if session_id.trim().is_empty() {
        return Ok(());
    }
    let status = model_sync_marker_status(paths, session_id)?;
    if status.matches && !status.legacy_marker {
        return Ok(());
    }
    let epoch = status
        .stored_epoch
        .map(|epoch| epoch.saturating_add(1))
        .unwrap_or(0);
    mark_model_sync_pending_for_epoch(paths, session_id, epoch, "legacy-upgrade", None)?;
    mark_model_sync_completed_for_epoch(paths, session_id, epoch, "legacy-upgrade", None)
}

pub(crate) fn validate_model_sync_marker_transition(
    existing: Option<&ModelSyncMarkerV2>,
    next: &ModelSyncMarkerV2,
) -> Result<()> {
    let Some(existing) = existing else {
        return (next.state == "pending")
            .then_some(())
            .ok_or_else(|| anyhow!("model sync completion requires a pending marker"));
    };
    if next.epoch < existing.epoch {
        return Err(anyhow!(
            "refusing to overwrite newer model sync epoch {} with {}",
            existing.epoch,
            next.epoch
        ));
    }
    if next.epoch > existing.epoch {
        return (next.state == "pending")
            .then_some(())
            .ok_or_else(|| anyhow!("a new model sync epoch must start pending"));
    }
    if existing == next {
        return Ok(());
    }
    if existing.state != "pending" || next.state != "complete" {
        return Err(anyhow!("invalid same-epoch model sync state transition"));
    }
    if existing.owner != next.owner {
        return Err(anyhow!("model sync owner changed during reconciliation"));
    }
    if existing.policy_version != next.policy_version {
        return Err(anyhow!("model sync policy changed during reconciliation"));
    }
    if existing.fingerprint != next.fingerprint {
        return Err(anyhow!(
            "model sync fingerprint changed during reconciliation"
        ));
    }
    if existing.version != next.version {
        return Err(anyhow!(
            "model sync marker version changed during reconciliation"
        ));
    }
    Ok(())
}

fn write_model_sync_marker_atomic(
    paths: &AppPaths,
    marker: &ModelSyncMarkerV2,
    fence: Option<(&dyn TokenStore, &str, u64)>,
) -> Result<()> {
    write_model_sync_marker_atomic_with_hook(paths, marker, fence, || {})
}

pub(crate) fn write_model_sync_marker_atomic_with_hook<F>(
    paths: &AppPaths,
    marker: &ModelSyncMarkerV2,
    fence: Option<(&dyn TokenStore, &str, u64)>,
    before_publish: F,
) -> Result<()>
where
    F: FnOnce(),
{
    let Some(parent) = paths.model_sync_completed_session_file.parent() else {
        return Err(anyhow!("model sync marker has no parent directory"));
    };
    fs::create_dir_all(parent).context("failed to create model sync marker directory")?;
    let _lock = acquire_health_status_write_lock(&paths.model_sync_completed_session_file)?;
    let existing = if paths.model_sync_completed_session_file.exists() {
        let raw = read_trimmed_file(&paths.model_sync_completed_session_file)?;
        parse_model_sync_marker_v2(&raw)?
    } else {
        None
    };
    validate_model_sync_marker_transition(existing.as_ref(), marker)?;
    let temporary = parent.join(format!(
        ".model-sync-marker.{}.{}.tmp",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let payload = serde_json::to_vec(marker).context("failed to encode model sync marker")?;
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .context("failed to create model sync marker temporary file")?;
    file.write_all(&payload)
        .context("failed to write model sync marker temporary file")?;
    file.sync_all()
        .context("failed to sync model sync marker temporary file")?;
    if let Some((store, owner, epoch)) = fence {
        if let Err(error) = store.verify_model_sync_epoch(owner, epoch) {
            let _ = fs::remove_file(&temporary);
            return Err(error.context("model sync lease lost before marker publish"));
        }
    }
    before_publish();
    if let Some((store, owner, epoch)) = fence {
        if let Err(error) = store.verify_model_sync_epoch(owner, epoch) {
            let _ = fs::remove_file(&temporary);
            return Err(error.context("model sync lease lost at marker publish"));
        }
    }
    fs::rename(&temporary, &paths.model_sync_completed_session_file)
        .context("failed to publish model sync marker")?;
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .context("failed to sync model sync marker directory")?;
    Ok(())
}

pub(crate) fn mark_model_sync_pending_for_epoch(
    paths: &AppPaths,
    session_id: &str,
    epoch: u64,
    owner: &str,
    store: Option<&dyn TokenStore>,
) -> Result<()> {
    let fingerprint = compute_model_sync_completion_marker(paths, session_id)?;
    if fingerprint.trim().is_empty() {
        return Err(anyhow!("model sync session ID is required"));
    }
    write_model_sync_marker_atomic(
        paths,
        &ModelSyncMarkerV2 {
            version: MODEL_SYNC_MARKER_VERSION,
            state: "pending".to_string(),
            fingerprint,
            epoch,
            owner: owner.to_string(),
            policy_version: MODEL_SYNC_POLICY_VERSION.to_string(),
        },
        store.map(|store| (store, owner, epoch)),
    )
}

pub(crate) fn mark_model_sync_completed_for_epoch(
    paths: &AppPaths,
    session_id: &str,
    epoch: u64,
    owner: &str,
    store: Option<&dyn TokenStore>,
) -> Result<()> {
    let fingerprint = compute_model_sync_completion_marker(paths, session_id)?;
    if fingerprint.trim().is_empty() {
        warn!("Model sync session ID missing, skipping completion marker write");
        return Ok(());
    }
    write_model_sync_marker_atomic(
        paths,
        &ModelSyncMarkerV2 {
            version: MODEL_SYNC_MARKER_VERSION,
            state: "complete".to_string(),
            fingerprint,
            epoch,
            owner: owner.to_string(),
            policy_version: MODEL_SYNC_POLICY_VERSION.to_string(),
        },
        store.map(|store| (store, owner, epoch)),
    )
}

pub fn log_api_call(
    paths: &AppPaths,
    enabled: bool,
    operation: &str,
    request_data: Option<Value>,
    response_data: Option<Value>,
    error: Option<&str>,
) -> Result<()> {
    if !enabled {
        return Ok(());
    }
    if let Err(error) = fs::create_dir_all(&paths.api_log_dir) {
        warn!(
            "Failed to create API log directory {}: {error}",
            paths.api_log_dir.display()
        );
        return Ok(());
    }
    let timestamp = unix_timestamp();
    let file_path = paths
        .api_log_dir
        .join(format!("{timestamp}_{operation}.json"));
    let entry = json!({
        "timestamp": timestamp,
        "timestamp_iso": format!("{}Z", Utc::now().format("%Y-%m-%dT%H:%M:%S%.6f")),
        "operation": operation,
        "request": request_data.unwrap_or(Value::Object(Map::new())),
        "response": response_data.unwrap_or(Value::Object(Map::new())),
        "error": error,
        "success": error.is_none(),
    });
    let payload = match serde_json::to_vec_pretty(&entry) {
        Ok(payload) => payload,
        Err(error) => {
            warn!("Failed to encode API log payload for {operation}: {error}");
            return Ok(());
        }
    };
    if let Err(error) = fs::write(&file_path, payload) {
        warn!("Failed to write API log {}: {error}", file_path.display());
    }
    Ok(())
}

pub fn health_sync_log_file_path(paths: &AppPaths) -> PathBuf {
    paths.app_support_dir.join("logs").join(format!(
        "health-sync-{}.log",
        Local::now().format("%Y-%m-%d")
    ))
}

pub fn log_health_sync_event(
    paths: &AppPaths,
    config: &RuntimeConfig,
    event: &str,
    details: Value,
) -> Result<()> {
    let log_path = health_sync_log_file_path(paths);
    let Some(log_dir) = log_path.parent() else {
        return Err(anyhow!("health sync log path has no parent directory"));
    };
    fs::create_dir_all(log_dir).with_context(|| {
        format!(
            "failed to create health sync log directory {}",
            log_dir.display()
        )
    })?;

    let entry = json!({
        "timestamp": Utc::now().to_rfc3339_opts(SecondsFormat::Micros, true),
        "event": event,
        "run_id": &config.health_sync_run_id,
        "reason": &config.health_sync_reason,
        "mode": config.mode.as_str(),
        "sync_enabled": config.sync_enabled,
        "core_only_sync": config.core_only_sync,
        "timeout_budget_ms": config.health_sync_timeout_budget_ms,
        "health_sync_session_id": &config.health_sync_session_id,
        "details": sanitize_health_sync_value(details),
    });
    let text_payload = format!("{}\n", format_health_sync_text_entry(&entry));
    remove_legacy_json_health_sync_lines(&log_path).with_context(|| {
        format!(
            "failed to remove legacy JSON health sync lines from {}",
            log_path.display()
        )
    })?;

    let mut text_file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .with_context(|| format!("failed to open health sync text log {}", log_path.display()))?;
    text_file
        .write_all(text_payload.as_bytes())
        .with_context(|| {
            format!(
                "failed to write health sync text log {}",
                log_path.display()
            )
        })?;
    Ok(())
}

fn remove_legacy_json_health_sync_lines(log_path: &Path) -> Result<()> {
    if !log_path.exists() {
        return Ok(());
    }

    let contents = fs::read_to_string(log_path)
        .with_context(|| format!("failed to read {}", log_path.display()))?;
    if !contents.lines().any(is_legacy_json_health_sync_line) {
        return Ok(());
    }

    let retained = contents
        .lines()
        .filter(|line| !is_legacy_json_health_sync_line(line))
        .collect::<Vec<_>>();
    let rewritten = if retained.is_empty() {
        String::new()
    } else {
        format!("{}\n", retained.join("\n"))
    };
    fs::write(log_path, rewritten)
        .with_context(|| format!("failed to rewrite {}", log_path.display()))?;
    Ok(())
}

fn is_legacy_json_health_sync_line(line: &str) -> bool {
    line.trim_start().starts_with('{')
}

fn format_health_sync_text_entry(entry: &Value) -> String {
    let timestamp = text_field(entry, "timestamp");
    let event = text_field(entry, "event");
    let mode = text_field(entry, "mode");
    let run_id = text_field(entry, "run_id");
    let reason = text_field(entry, "reason");
    let timeout = entry
        .get("timeout_budget_ms")
        .and_then(format_health_sync_scalar)
        .unwrap_or_else(|| "n/a".to_string());
    let details = entry.get("details").unwrap_or(&Value::Null);
    let summary = format_health_sync_detail_summary(&event, details);

    if summary.is_empty() {
        format!("{timestamp} | {mode} | {event} | run={run_id} | reason={reason} | timeout_ms={timeout}")
    } else {
        format!("{timestamp} | {mode} | {event} | run={run_id} | reason={reason} | timeout_ms={timeout} | {summary}")
    }
}

fn format_health_sync_detail_summary(event: &str, details: &Value) -> String {
    match event {
        "owui_http_request" => format!(
            "{} {} -> {} ok={} content_type={} bytes={} duration_ms={} json_shape={}",
            detail(details, "method"),
            detail(details, "path"),
            detail(details, "status"),
            detail(details, "ok"),
            detail(details, "content_type"),
            detail(details, "response_bytes"),
            detail(details, "duration_ms"),
            details
                .get("json_shape")
                .map(format_health_sync_json_shape)
                .unwrap_or_else(|| detail(details, "error_class")),
        ),
        "model_sync_marker_decision" => format!(
            "already_completed={} required={} marker_exists={} marker_matches={} expected={} stored={} session_present={} prompt_bytes={} model_catalog_bytes={} icon_resolver={} atlas_icon_bytes={} gpt_icon_bytes={} gemini_icon_bytes={} sol_icon_bytes={} terra_icon_bytes={} luna_icon_bytes={}",
            detail(details, "already_completed"),
            detail(details, "required"),
            detail(details, "marker_file_exists"),
            detail(details, "marker_matches"),
            detail(details, "expected_marker"),
            detail(details, "stored_marker"),
            nested_detail(details, "fingerprint", "session_id_present"),
            nested_detail(details, "fingerprint", "base_system_prompt_bytes"),
            nested_detail(details, "fingerprint", "model_catalog_bytes"),
            nested_detail(details, "fingerprint", "model_icon_resolver_version"),
            nested_detail(details, "fingerprint", "atlas_icon_bytes"),
            nested_detail(details, "fingerprint", "gpt_icon_bytes"),
            nested_detail(details, "fingerprint", "gemini_icon_bytes"),
            nested_detail(details, "fingerprint", "sol_icon_bytes"),
            nested_detail(details, "fingerprint", "terra_icon_bytes"),
            nested_detail(details, "fingerprint", "luna_icon_bytes"),
        ),
        "owui_model_inventory_loaded" => format!(
            "picker={} wrapper={} base={} lm_studio={} disabled={} configured={} missing={} not_picker_base={} default={}",
            detail(details, "picker_model_count"),
            detail(details, "wrapper_model_count"),
            detail(details, "base_model_count"),
            detail(details, "lm_studio_model_count"),
            detail(details, "disabled_model_count"),
            detail(details, "configured_model_count"),
            detail(details, "missing_configured_model_ids"),
            detail(
                details,
                "configured_model_ids_missing_from_picker_base_models"
            ),
            detail(details, "current_default_model"),
        ),
        "model_sync_marker_invalidated" => format!(
            "reason={} picker={} missing={} not_picker_base={}",
            detail(details, "reason"),
            detail(details, "picker_model_count"),
            detail(details, "missing_configured_model_ids"),
            detail(
                details,
                "configured_model_ids_missing_from_picker_base_models"
            ),
        ),
        "base_model_sync_complete" => format!(
            "required={} created={} updated={} configured={} default={}",
            detail(details, "model_sync_required"),
            detail(details, "base_models_created"),
            detail(details, "base_models_updated"),
            detail(details, "configured_model_count"),
            detail(details, "target_default_model"),
        ),
        "lm_studio_sync" => format!(
            "configured={} reachable={} models={} internal={} created={} updated={} disabled={}",
            detail(details, "configured"),
            detail(details, "reachable"),
            detail(details, "model_count"),
            detail(details, "internal_model_count"),
            detail(details, "created"),
            detail(details, "updated"),
            detail(details, "disabled"),
        ),
        "health_sync_start" => format!(
            "sync_enabled={} core_only={} retries={} request_timeout_ms={} session_present={}",
            detail(details, "sync_enabled"),
            detail(details, "core_only_sync"),
            detail(details, "main_retries"),
            detail(details, "request_timeout_ms"),
            detail(details, "health_sync_session_id_present"),
        ),
        "health_sync_phase_start" => format_health_sync_default_details(details),
        "health_sync_complete" => format!(
            "success={} attempt={} elapsed_ms={}",
            detail(details, "success"),
            detail(details, "attempt"),
            detail(details, "elapsed_ms"),
        ),
        "health_sync_summary" => format_health_sync_default_details(details),
        "model_catalog_loaded" => format!(
            "model_config_count={} model_ids={}",
            detail(details, "model_config_count"),
            detail(details, "model_ids"),
        ),
        "tool_server_sync_complete" => format!(
            "status={} tool_server_connections={}",
            detail(details, "status"),
            detail(details, "tool_server_connection_count"),
        ),
        "user_settings_update_complete" => format!(
            "status={} default={}",
            detail(details, "status"),
            detail(details, "target_default_model"),
        ),
        _ => format_health_sync_default_details(details),
    }
}

fn text_field(entry: &Value, key: &str) -> String {
    entry
        .get(key)
        .and_then(format_health_sync_scalar)
        .unwrap_or_else(|| "n/a".to_string())
}

fn detail(details: &Value, key: &str) -> String {
    details
        .get(key)
        .and_then(format_health_sync_scalar)
        .unwrap_or_else(|| "n/a".to_string())
}

fn nested_detail(details: &Value, parent: &str, key: &str) -> String {
    details
        .get(parent)
        .and_then(|value| value.get(key))
        .and_then(format_health_sync_scalar)
        .unwrap_or_else(|| "n/a".to_string())
}

fn format_health_sync_scalar(value: &Value) -> Option<String> {
    match value {
        Value::Null => Some("n/a".to_string()),
        Value::Bool(value) => Some(value.to_string()),
        Value::Number(value) => Some(value.to_string()),
        Value::String(value) => Some(value.clone()),
        Value::Array(values) => {
            let rendered = values
                .iter()
                .filter_map(format_health_sync_scalar)
                .take(8)
                .collect::<Vec<_>>();
            if values.len() > rendered.len() {
                Some(format!(
                    "[{}; +{} more]",
                    rendered.join(", "),
                    values.len() - rendered.len()
                ))
            } else {
                Some(format!("[{}]", rendered.join(", ")))
            }
        }
        Value::Object(_) => None,
    }
}

fn format_health_sync_json_shape(value: &Value) -> String {
    let Some(object) = value.as_object() else {
        return "n/a".to_string();
    };
    match object
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
    {
        "array" => format!("array len={}", detail(value, "len")),
        "object" => format!(
            "object keys={} key_count={}",
            detail(value, "keys"),
            detail(value, "key_count")
        ),
        kind => kind.to_string(),
    }
}

fn format_health_sync_default_details(details: &Value) -> String {
    let Some(object) = details.as_object() else {
        return String::new();
    };
    object
        .iter()
        .filter_map(|(key, value)| {
            format_health_sync_scalar(value).map(|rendered| format!("{key}={rendered}"))
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn sanitize_health_sync_value(value: Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut sanitized = Map::new();
            for (key, value) in object {
                let sanitized_value = if is_sensitive_health_sync_key(&key) {
                    Value::String("[redacted]".to_string())
                } else if is_health_sync_error_summary_key(&key) {
                    sanitize_health_sync_error_value(value)
                } else {
                    sanitize_health_sync_value(value)
                };
                sanitized.insert(key, sanitized_value);
            }
            Value::Object(sanitized)
        }
        Value::Array(values) => {
            Value::Array(values.into_iter().map(sanitize_health_sync_value).collect())
        }
        other => other,
    }
}

fn sanitize_health_sync_http_path(path: &str) -> String {
    let path = if path.starts_with("http://") || path.starts_with("https://") {
        match url::Url::parse(path) {
            Ok(parsed) => {
                let mut normalized = parsed.path().to_string();
                if parsed.query().is_some() {
                    normalized.push('?');
                    normalized.push_str(parsed.query().unwrap_or(""));
                }
                normalized
            }
            Err(_) => path.to_string(),
        }
    } else {
        path.to_string()
    };

    let Some((base, query)) = path.split_once('?') else {
        return path;
    };
    if query.is_empty() {
        return format!("{base}?");
    }
    let redacted_query = query
        .split('&')
        .filter(|part| !part.trim().is_empty())
        .map(|part| {
            let key = part.split_once('=').map(|(key, _)| key).unwrap_or(part);
            if key.is_empty() {
                "<redacted>".to_string()
            } else {
                format!("{key}=<redacted>")
            }
        })
        .collect::<Vec<_>>()
        .join("&");
    format!("{base}?{redacted_query}")
}

fn summarize_content_type(content_type: &str) -> String {
    content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

fn summarize_json_shape(text: &str) -> Value {
    if text.trim().is_empty() {
        return json!({ "kind": "empty" });
    }
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Array(values)) => json!({
            "kind": "array",
            "len": values.len(),
        }),
        Ok(Value::Object(object)) => {
            let keys = object.keys().take(8).cloned().collect::<Vec<_>>();
            json!({
                "kind": "object",
                "keys": keys,
                "key_count": object.len(),
            })
        }
        Ok(Value::Null) => json!({ "kind": "null" }),
        Ok(Value::Bool(_)) => json!({ "kind": "bool" }),
        Ok(Value::Number(_)) => json!({ "kind": "number" }),
        Ok(Value::String(_)) => json!({ "kind": "string" }),
        Err(_) => json!({ "kind": "non_json" }),
    }
}

fn reqwest_error_class(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connect"
    } else if error.is_body() {
        "body"
    } else if error.is_decode() {
        "decode"
    } else if error.is_status() {
        "status"
    } else {
        "unknown"
    }
}

fn is_sensitive_health_sync_key(key: &str) -> bool {
    let normalized = key.trim().to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "request"
            | "response"
            | "payload"
            | "raw_payload"
            | "raw_response"
            | "body"
            | "messages"
            | "content"
            | "arguments"
            | "tool_args"
            | "tool_arguments"
    ) || normalized.contains("token")
        || normalized.contains("secret")
        || normalized.contains("password")
        || normalized.contains("credential")
        || normalized.contains("authorization")
        || normalized.contains("api_key")
}

fn is_health_sync_error_summary_key(key: &str) -> bool {
    matches!(
        key.trim().to_ascii_lowercase().as_str(),
        "error" | "error_message" | "message"
    )
}

fn sanitize_health_sync_error_value(value: Value) -> Value {
    match value {
        Value::String(raw) => Value::String(sanitize_health_sync_error_string(&raw)),
        other => sanitize_health_sync_value(other),
    }
}

fn sanitize_health_sync_error_string(raw: &str) -> String {
    let normalized = raw.replace(['\r', '\n'], " ");
    let without_body_preview = if let Some(index) = normalized.find("Body preview:") {
        format!("{}Body preview: [redacted]", &normalized[..index])
    } else {
        normalized
    };

    if let Some(redacted) = redact_http_status_body(&without_body_preview) {
        return redacted;
    }

    without_body_preview
}

fn redact_http_status_body(text: &str) -> Option<String> {
    let start = text.find("HTTP ")?;
    let after_http = &text[start + "HTTP ".len()..];
    let digit_count = after_http
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .count();
    if digit_count == 0 || !after_http[digit_count..].starts_with(':') {
        return None;
    }
    let prefix = &text[..start];
    let status = &after_http[..digit_count];
    Some(format!("{prefix}HTTP {status}: [response body redacted]"))
}

fn truncate_safe_error_message(raw: &str) -> String {
    const MAX_CHARS: usize = 300;
    let safe = sanitize_health_sync_error_string(raw);
    let mut chars = safe.chars();
    let mut truncated = chars.by_ref().take(MAX_CHARS).collect::<String>();
    if chars.next().is_some() {
        truncated.push_str("...");
    }
    truncated
}

pub fn is_host_mode_supported(paths: &AppPaths) -> bool {
    read_trimmed_file(&paths.host_mode_file)
        .map(|value| parse_host_mode_value(&value))
        .unwrap_or(false)
}

pub fn parse_host_mode_value(value: &str) -> bool {
    value.trim().eq_ignore_ascii_case("true")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpToggleSnapshot {
    pub toggles: HashMap<String, bool>,
    pub revision: String,
    pub source: PathBuf,
}

pub fn compute_mcp_toggle_revision(toggles: &HashMap<String, bool>) -> Result<String> {
    let canonical = toggles
        .iter()
        .map(|(server_id, enabled)| (server_id.clone(), *enabled))
        .collect::<BTreeMap<_, _>>();
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(&canonical)?);
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

fn configured_mcp_toggle_snapshot_path(paths: &AppPaths) -> (PathBuf, bool) {
    let configured = std::env::var(MCP_TOGGLE_SNAPSHOT_FILE_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    match configured {
        Some(value) => (PathBuf::from(value), true),
        None => (
            paths.health_status_dir.join("mcp_toggles_snapshot.json"),
            false,
        ),
    }
}

fn parse_mcp_toggle_payload(contents: &str) -> Result<(HashMap<String, bool>, Option<String>)> {
    let parsed = serde_json::from_str::<Value>(contents)?;
    let (toggle_value, declared_revision) = if parsed.get("toggles").is_some() {
        let revision = parsed
            .get("revision")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        (parsed.get("toggles").expect("toggles checked"), revision)
    } else {
        (&parsed, None)
    };
    let object = toggle_value
        .as_object()
        .ok_or_else(|| anyhow!("MCP toggle payload must be a JSON object"))?;
    let mut toggles = HashMap::with_capacity(object.len());
    for (key, value) in object {
        if key.trim().is_empty() {
            return Err(anyhow!("MCP toggle server id must be non-empty"));
        }
        let enabled = value
            .as_bool()
            .ok_or_else(|| anyhow!("MCP toggle value for {key} must be boolean"))?;
        toggles.insert(key.clone(), enabled);
    }
    Ok((toggles, declared_revision))
}

pub fn load_mcp_toggle_snapshot(paths: &AppPaths) -> Result<McpToggleSnapshot> {
    let (snapshot_path, snapshot_required) = configured_mcp_toggle_snapshot_path(paths);
    if snapshot_path.exists() {
        let contents = fs::read_to_string(&snapshot_path).with_context(|| {
            format!(
                "failed to read MCP toggle snapshot {}",
                snapshot_path.display()
            )
        })?;
        let (toggles, declared_revision) =
            parse_mcp_toggle_payload(&contents).with_context(|| {
                format!(
                    "failed to parse MCP toggle snapshot {}",
                    snapshot_path.display()
                )
            })?;
        let revision = compute_mcp_toggle_revision(&toggles)?;
        if declared_revision
            .as_deref()
            .is_some_and(|declared| declared != revision)
        {
            return Err(anyhow!(
                "MCP toggle snapshot revision mismatch at {}",
                snapshot_path.display()
            ));
        }
        return Ok(McpToggleSnapshot {
            toggles,
            revision,
            source: snapshot_path,
        });
    }

    if snapshot_required {
        return Err(anyhow!(
            "configured MCP toggle snapshot is missing: {}",
            snapshot_path.display()
        ));
    }

    if !paths.mcp_toggles_file.exists() {
        return Err(anyhow!(
            "MCP toggle source is missing: {}",
            paths.mcp_toggles_file.display()
        ));
    }
    let contents = fs::read_to_string(&paths.mcp_toggles_file).with_context(|| {
        format!(
            "failed to read MCP toggle source {}",
            paths.mcp_toggles_file.display()
        )
    })?;
    let (toggles, _) = parse_mcp_toggle_payload(&contents).with_context(|| {
        format!(
            "failed to parse MCP toggle source {}",
            paths.mcp_toggles_file.display()
        )
    })?;
    Ok(McpToggleSnapshot {
        revision: compute_mcp_toggle_revision(&toggles)?,
        toggles,
        source: paths.mcp_toggles_file.clone(),
    })
}

pub fn load_mcp_toggles(paths: &AppPaths) -> Result<HashMap<String, bool>> {
    load_mcp_toggle_snapshot(paths).map(|snapshot| snapshot.toggles)
}

pub fn has_recent_oauth_tokens(paths: &AppPaths, server_id: &str, max_age_seconds: u64) -> bool {
    let tokens_dir = paths.oauth_tokens_dir.join(server_id).join("tokens");
    if !tokens_dir.exists() {
        return false;
    }
    let cutoff = SystemTime::now()
        .checked_sub(Duration::from_secs(max_age_seconds))
        .unwrap_or(UNIX_EPOCH);
    match fs::read_dir(tokens_dir) {
        Ok(entries) => entries
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .map(|name| name.ends_with("_tokens.json"))
                    .unwrap_or(false)
            })
            .any(|entry| {
                entry
                    .metadata()
                    .ok()
                    .and_then(|metadata| metadata.modified().ok())
                    .map(|modified| modified >= cutoff)
                    .unwrap_or(false)
            }),
        Err(_) => false,
    }
}

pub fn get_server_enablement_state(
    server_id: &str,
    server_metadata: &ServerMetadata,
    mcp_toggles: &HashMap<String, bool>,
    paths: &AppPaths,
    max_age_seconds: u64,
) -> (bool, String) {
    if server_metadata.is_core {
        return (true, "core".to_string());
    }
    match mcp_toggles.get(server_id) {
        Some(false) => return (false, "explicit_false".to_string()),
        Some(true) => return (true, "explicit_true".to_string()),
        None => {}
    }
    if has_recent_oauth_tokens(paths, server_id, max_age_seconds) {
        return (true, "oauth_recent_tokens".to_string());
    }
    (false, "default_disabled".to_string())
}

pub fn load_env_file(path: &Path) -> Result<HashMap<String, String>> {
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) => {
            warn!("Failed to load env file {}: {error}", path.display());
            return Ok(HashMap::new());
        }
    };
    let env = contents
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#') && line.contains('='))
        .filter_map(|line| {
            let (key, value) = line.split_once('=')?;
            Some((key.trim().to_string(), value.trim().to_string()))
        })
        .collect();
    Ok(env)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RequiredEnvEntry {
    name: String,
    sensitive: bool,
}

fn required_env_entries(yaml_content: &serde_yaml::Value) -> Vec<RequiredEnvEntry> {
    let required = yaml_content
        .get("required_env_vars")
        .and_then(serde_yaml::Value::as_sequence)
        .cloned()
        .unwrap_or_default();

    required
        .into_iter()
        .filter_map(|item| {
            let (name, sensitive) = if let Some(name) = item.as_str() {
                (name.to_string(), false)
            } else if let Some(map) = item.as_mapping() {
                let name = map
                    .iter()
                    .find_map(|(key, value)| {
                        if key.as_str() == Some("name") {
                            value.as_str().map(ToOwned::to_owned)
                        } else {
                            None
                        }
                    })
                    .unwrap_or_default();
                let sensitive = map
                    .iter()
                    .find_map(|(key, value)| {
                        if key.as_str() == Some("sensitive") {
                            value.as_bool()
                        } else {
                            None
                        }
                    })
                    .unwrap_or(false);
                (name, sensitive)
            } else {
                (String::new(), false)
            };

            if name.is_empty() {
                None
            } else {
                Some(RequiredEnvEntry { name, sensitive })
            }
        })
        .collect()
}

fn is_missing_required_env_value(value: &str) -> bool {
    value.is_empty()
        || value.contains("your_")
        || value.contains("your-")
        || value == "placeholder"
        || value == "example"
}

fn required_env_entries_configured(
    server_id: &str,
    entries: &[RequiredEnvEntry],
    user_env: &HashMap<String, String>,
    include_sensitive: bool,
) -> bool {
    for entry in entries {
        if entry.sensitive && !include_sensitive {
            continue;
        }
        let value = user_env
            .get(&entry.name)
            .map(|value| value.trim().to_string())
            .unwrap_or_default();
        if is_missing_required_env_value(&value) {
            debug!("{server_id}: {} is empty or placeholder", entry.name);
            return false;
        }
    }

    true
}

pub fn is_server_configured(
    server_id: &str,
    yaml_content: &serde_yaml::Value,
    user_env: &HashMap<String, String>,
) -> bool {
    let required = required_env_entries(yaml_content);
    required.is_empty() || required_env_entries_configured(server_id, &required, user_env, true)
}

fn fallback_server_configuration_status(
    server_id: &str,
    yaml_content: &serde_yaml::Value,
    user_env: &HashMap<String, String>,
    has_generated_server_config_status: bool,
) -> ServerConfigurationStatus {
    let required = required_env_entries(yaml_content);

    if required.is_empty() {
        return ServerConfigurationStatus {
            is_configured: true,
            error: None,
        };
    }

    let has_sensitive_required_env = required.iter().any(|entry| entry.sensitive);
    let include_sensitive = !has_sensitive_required_env || has_generated_server_config_status;
    if !required_env_entries_configured(server_id, &required, user_env, include_sensitive) {
        return ServerConfigurationStatus {
            is_configured: false,
            error: Some(
                "Server not configured (missing or placeholder environment variables)".to_string(),
            ),
        };
    }

    ServerConfigurationStatus {
        is_configured: true,
        error: None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ServerConfigurationStatus {
    is_configured: bool,
    error: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
struct GeneratedRuntimeFileStatusPayload {
    #[serde(default)]
    servers: HashMap<String, GeneratedRuntimeFileStatus>,
}

type GeneratedServerConfigStatusPayload = GeneratedRuntimeFileStatusPayload;
type GeneratedServerConfigStatus = GeneratedRuntimeFileStatus;

#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
struct GeneratedRuntimeFileStatus {
    configured: Option<bool>,
    status: Option<String>,
    error: Option<String>,
}

fn server_configuration_status(
    server_id: &str,
    yaml_content: &serde_yaml::Value,
    user_env: &HashMap<String, String>,
    runtime_file_statuses: &HashMap<String, GeneratedRuntimeFileStatus>,
    server_config_statuses: &HashMap<String, GeneratedServerConfigStatus>,
) -> ServerConfigurationStatus {
    let generated_server_config_status = server_config_statuses.get(server_id);
    if let Some(status) = generated_server_config_status {
        if status.configured == Some(false)
            || status
                .status
                .as_deref()
                .map(|value| value.eq_ignore_ascii_case("not_configured"))
                .unwrap_or(false)
        {
            let error = status
                .error
                .clone()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| {
                    "Server not configured (missing or placeholder environment variables)"
                        .to_string()
                });
            debug!("{server_id}: {error}");
            return ServerConfigurationStatus {
                is_configured: false,
                error: Some(error),
            };
        }
        if status.configured == Some(true) {
            return ServerConfigurationStatus {
                is_configured: true,
                error: None,
            };
        }
    } else if let Some(status) = runtime_file_statuses.get(server_id) {
        let is_not_configured_status = status
            .status
            .as_deref()
            .map(|value| value.eq_ignore_ascii_case("not_configured"))
            .unwrap_or(false);
        if status.configured == Some(false) || is_not_configured_status {
            let error = status
                .error
                .clone()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "Missing runtime file".to_string());
            debug!("{server_id}: {error}");
            return ServerConfigurationStatus {
                is_configured: false,
                error: Some(error),
            };
        }
    }

    fallback_server_configuration_status(
        server_id,
        yaml_content,
        user_env,
        generated_server_config_status.is_some(),
    )
}

fn load_generated_runtime_file_statuses(
    path: &Path,
) -> HashMap<String, GeneratedRuntimeFileStatus> {
    if !path.is_file() {
        return HashMap::new();
    }
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) => {
            warn!(
                "Failed to read generated runtime file status {}: {error}",
                path.display()
            );
            return HashMap::new();
        }
    };
    match serde_json::from_str::<GeneratedRuntimeFileStatusPayload>(&contents) {
        Ok(payload) => payload.servers,
        Err(error) => {
            warn!(
                "Failed to parse generated runtime file status {}: {error}",
                path.display()
            );
            HashMap::new()
        }
    }
}

fn load_generated_server_config_statuses(
    path: &Path,
) -> HashMap<String, GeneratedServerConfigStatus> {
    if !path.is_file() {
        return HashMap::new();
    }
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) => {
            warn!(
                "Failed to read generated server config status {}: {error}",
                path.display()
            );
            return HashMap::new();
        }
    };
    match serde_json::from_str::<GeneratedServerConfigStatusPayload>(&contents) {
        Ok(payload) => payload.servers,
        Err(error) => {
            warn!(
                "Failed to parse generated server config status {}: {error}",
                path.display()
            );
            HashMap::new()
        }
    }
}

fn insert_generated_not_configured_server(
    server_id: &str,
    user_installed: bool,
    server_config_statuses: &HashMap<String, GeneratedServerConfigStatus>,
    configured: &mut BTreeMap<String, ServerMetadata>,
) -> bool {
    let Some(status) = server_config_statuses.get(server_id) else {
        return false;
    };
    let not_configured = status.configured == Some(false)
        || status
            .status
            .as_deref()
            .map(|value| value.eq_ignore_ascii_case("not_configured"))
            .unwrap_or(false);
    if !not_configured {
        return false;
    }

    configured.insert(
        server_id.to_string(),
        ServerMetadata {
            id: server_id.to_string(),
            name: server_id.to_string(),
            deployment_type: "docker".to_string(),
            is_core: false,
            has_oauth: false,
            user_installed,
            is_configured: false,
            config_error: status
                .error
                .clone()
                .filter(|value| !value.trim().is_empty())
                .or_else(|| Some("Server configuration is invalid".to_string())),
        },
    );
    true
}

pub fn scan_configured_servers(
    paths: &AppPaths,
) -> Result<(BTreeMap<String, ServerMetadata>, Vec<String>)> {
    let user_env = HashMap::new();
    let runtime_file_statuses =
        load_generated_runtime_file_statuses(&paths.runtime_file_status_file);
    let server_config_statuses =
        load_generated_server_config_statuses(&paths.server_config_status_file);
    let mut configured = BTreeMap::new();
    let mut ignored_user_collisions = Vec::new();

    scan_server_dir(
        &paths.mcp_configs_dir,
        &paths.app_root,
        false,
        None,
        &user_env,
        &runtime_file_statuses,
        &server_config_statuses,
        &mut configured,
        &mut ignored_user_collisions,
    )?;
    scan_server_dir(
        &paths.mcp_configs_user_dir,
        &paths.app_root,
        true,
        Some(&paths.mcp_configs_dir),
        &user_env,
        &runtime_file_statuses,
        &server_config_statuses,
        &mut configured,
        &mut ignored_user_collisions,
    )?;

    Ok((configured, ignored_user_collisions))
}

fn scan_server_dir(
    root: &Path,
    _project_root: &Path,
    user_installed: bool,
    system_root: Option<&Path>,
    user_env: &HashMap<String, String>,
    runtime_file_statuses: &HashMap<String, GeneratedRuntimeFileStatus>,
    server_config_statuses: &HashMap<String, GeneratedServerConfigStatus>,
    configured: &mut BTreeMap<String, ServerMetadata>,
    ignored_user_collisions: &mut Vec<String>,
) -> Result<()> {
    if !root.exists() {
        return Ok(());
    }

    for entry in fs::read_dir(root)? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                warn!(
                    "Failed to read directory entry in {}: {error}",
                    root.display()
                );
                continue;
            }
        };
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) => {
                warn!(
                    "Failed to inspect directory entry {}: {error}",
                    entry.path().display()
                );
                continue;
            }
        };
        if !file_type.is_dir() {
            continue;
        }
        let server_id = entry.file_name().to_string_lossy().to_string();
        if let Some(system_root) = system_root {
            if system_root.join(&server_id).is_dir() {
                ignored_user_collisions.push(server_id);
                continue;
            }
        }
        let yaml_path = entry.path().join(format!("{server_id}.yaml"));
        if !yaml_path.exists() {
            if user_installed {
                insert_generated_not_configured_server(
                    &server_id,
                    true,
                    server_config_statuses,
                    configured,
                );
            }
            continue;
        }
        let yaml_text = match fs::read_to_string(&yaml_path) {
            Ok(contents) => contents,
            Err(error) => {
                warn!("Failed to read YAML for {server_id}: {error}");
                if user_installed {
                    insert_generated_not_configured_server(
                        &server_id,
                        true,
                        server_config_statuses,
                        configured,
                    );
                }
                continue;
            }
        };
        let yaml_content: serde_yaml::Value = match serde_yaml::from_str(&yaml_text) {
            Ok(yaml_content) => yaml_content,
            Err(error) => {
                warn!("Failed to parse YAML for {server_id}: {error}");
                if user_installed {
                    insert_generated_not_configured_server(
                        &server_id,
                        true,
                        server_config_statuses,
                        configured,
                    );
                }
                continue;
            }
        };
        let configuration = server_configuration_status(
            &server_id,
            &yaml_content,
            user_env,
            runtime_file_statuses,
            server_config_statuses,
        );
        configured.insert(
            server_id.clone(),
            ServerMetadata {
                id: server_id.clone(),
                name: yaml_content
                    .get("display_name")
                    .and_then(serde_yaml::Value::as_str)
                    .unwrap_or(&server_id)
                    .to_string(),
                deployment_type: yaml_content
                    .get("deployment_type")
                    .and_then(serde_yaml::Value::as_str)
                    .unwrap_or("docker")
                    .to_string(),
                is_core: yaml_content
                    .get("is_core")
                    .and_then(serde_yaml::Value::as_bool)
                    .unwrap_or(false)
                    && !user_installed,
                has_oauth: yaml_truthy(yaml_content.get("oauth")),
                user_installed,
                is_configured: configuration.is_configured,
                config_error: configuration.error,
            },
        );
    }

    Ok(())
}

pub async fn discover_mcp_servers(
    http_client: &Client,
    config: &RuntimeConfig,
    retries: &RetryConfig,
    check_host_mcpo: bool,
) -> Result<(
    BTreeMap<String, DiscoveredTool>,
    BTreeMap<String, DiscoveredTool>,
    BTreeSet<String>,
)> {
    let description_pattern = Regex::new(r"\[([^\]]+)\]")?;
    let mut servers_with_tools = BTreeMap::<String, DiscoveredTool>::new();
    let mut servers_without_tools = BTreeSet::new();

    for (host_name, summary_url, root_openapi_url, port, optional) in [
        (
            config.mcpo_core_host.clone(),
            format!("{}/servers/summary", config.mcpo_core_base_url),
            format!("{}/openapi.json", config.mcpo_core_base_url),
            config.mcpo_core_localhost_port.clone(),
            false,
        ),
        (
            config.mcpo_regular_host.clone(),
            format!("{}/servers/summary", config.mcpo_regular_base_url),
            format!("{}/openapi.json", config.mcpo_regular_base_url),
            config.mcpo_regular_localhost_port.clone(),
            true,
        ),
    ] {
        if let Some(summaries) = discover_servers_from_summary(
            http_client,
            retries,
            config.mode,
            &host_name,
            &summary_url,
            optional,
        )
        .await?
        {
            if summaries.is_empty() && !optional {
                warn!("Failed to discover MCP servers from required host {host_name}");
            }

            for summary in summaries {
                if !summary.reachable {
                    info!(
                        "{} tool endpoint is not reachable yet; leaving server in startup state",
                        summary.id
                    );
                    continue;
                }

                if summary.has_tools {
                    servers_with_tools
                        .entry(summary.id.clone())
                        .or_insert_with(|| DiscoveredTool {
                            host: host_name.clone(),
                            port: port.clone(),
                        });
                } else {
                    servers_without_tools.insert(summary.id);
                }
            }
            continue;
        }

        let discovered = discover_servers_from_root_openapi(
            http_client,
            retries,
            config.mode,
            &host_name,
            &root_openapi_url,
            optional,
            &description_pattern,
        )
        .await?;
        if discovered.is_empty() && !optional {
            warn!("Failed to discover MCP servers from required host {host_name}");
        }

        for tool_name in discovered {
            let host_info = DiscoveredTool {
                host: host_name.clone(),
                port: port.clone(),
            };
            let (has_tools, _) =
                validate_server_has_tools(http_client, config, &host_info.host, &tool_name).await?;
            match has_tools {
                Some(true) => {
                    servers_with_tools.insert(tool_name, host_info);
                }
                Some(false) => {
                    servers_without_tools.insert(tool_name);
                }
                None => {
                    info!(
                        "{tool_name} tool endpoint is not reachable yet; leaving server in startup state"
                    );
                }
            }
        }
    }

    if check_host_mcpo {
        let host_tools = discover_servers_from_root_openapi(
            http_client,
            retries,
            config.mode,
            &config.host_mcpo_host,
            &format!("{}/openapi.json", config.host_mcpo_base_url),
            true,
            &description_pattern,
        )
        .await?;

        for tool_name in &host_tools {
            let host_info = DiscoveredTool {
                host: config.host_mcpo_host.clone(),
                port: config.host_mcpo_localhost_port.clone(),
            };
            let (has_tools, _) =
                validate_server_has_tools(http_client, config, &host_info.host, tool_name).await?;
            match has_tools {
                Some(true) => {
                    servers_with_tools.insert(tool_name.clone(), host_info.clone());
                }
                Some(false) => {
                    servers_without_tools.insert(tool_name.clone());
                }
                None => {
                    info!(
                        "{tool_name} tool endpoint is not reachable yet; leaving server in startup state"
                    );
                }
            }
        }
    }

    let mut core_tools = BTreeMap::new();
    let mut regular_tools = BTreeMap::new();
    for (tool, info) in servers_with_tools {
        if info.host == config.mcpo_core_host {
            core_tools.insert(tool, info);
        } else {
            regular_tools.insert(tool, info);
        }
    }

    Ok((core_tools, regular_tools, servers_without_tools))
}

#[derive(Debug, Deserialize)]
struct ServerSummaryEntry {
    id: String,
    reachable: bool,
    has_tools: bool,
    #[allow(dead_code)]
    tools_count: usize,
}

#[derive(Debug, Deserialize)]
struct ServerSummaryPayload {
    #[allow(dead_code)]
    oauth_status: Option<Value>,
    servers: Vec<ServerSummaryEntry>,
}

async fn discover_servers_from_summary(
    http_client: &Client,
    retries: &RetryConfig,
    mode: HealthCheckMode,
    host_name: &str,
    summary_url: &str,
    optional: bool,
) -> Result<Option<Vec<ServerSummaryEntry>>> {
    let discovery_attempts = retries.discovery_attempts_for(mode, optional);
    let discovery_delay = retries.discovery_delay_for(mode);
    let request_timeout = retries.discovery_request_timeout_for(mode);

    for attempt in 1..=discovery_attempts {
        match http_client
            .get(summary_url)
            .timeout(request_timeout)
            .send()
            .await
        {
            Ok(response) => {
                if response.status() == reqwest::StatusCode::NOT_FOUND {
                    info!(
                        "Summary endpoint missing on {host_name}; falling back to root OpenAPI discovery"
                    );
                    return Ok(None);
                }
                if !response.status().is_success() {
                    warn!(
                        "Failed to connect to {host_name}: HTTP {}",
                        response.status()
                    );
                    if attempt < discovery_attempts {
                        sleep(discovery_delay).await;
                    }
                    continue;
                }

                match response.json::<ServerSummaryPayload>().await {
                    Ok(payload) => return Ok(Some(payload.servers)),
                    Err(error) => {
                        warn!("Error fetching from {host_name}: {error}");
                        if attempt < discovery_attempts {
                            sleep(discovery_delay).await;
                        }
                    }
                }
            }
            Err(error) => {
                warn!("Failed to connect to {host_name}: {error}");
                if attempt < discovery_attempts {
                    sleep(discovery_delay).await;
                }
            }
        }
    }

    Ok(Some(Vec::new()))
}

async fn discover_servers_from_root_openapi(
    http_client: &Client,
    retries: &RetryConfig,
    mode: HealthCheckMode,
    host_name: &str,
    host_url: &str,
    optional: bool,
    description_pattern: &Regex,
) -> Result<Vec<String>> {
    let discovery_attempts = retries.discovery_attempts_for(mode, optional);
    let discovery_delay = retries.discovery_delay_for(mode);
    let request_timeout = retries.discovery_request_timeout_for(mode);

    for attempt in 1..=discovery_attempts {
        match http_client
            .get(host_url)
            .timeout(request_timeout)
            .send()
            .await
        {
            Ok(response) => {
                if !response.status().is_success() {
                    warn!(
                        "Failed to connect to {host_name}: HTTP {}",
                        response.status()
                    );
                    if attempt < discovery_attempts {
                        sleep(discovery_delay).await;
                    }
                    continue;
                }

                let body = match response.text().await {
                    Ok(body) => body,
                    Err(error) => {
                        warn!("Error fetching from {host_name}: {error}");
                        if attempt < discovery_attempts {
                            sleep(discovery_delay).await;
                        }
                        continue;
                    }
                };
                let payload: Value = match serde_json::from_str(&body) {
                    Ok(payload) => payload,
                    Err(error) => {
                        warn!("Error fetching from {host_name}: {error}");
                        if attempt < discovery_attempts {
                            sleep(discovery_delay).await;
                        }
                        continue;
                    }
                };
                return Ok(extract_discovered_server_ids(&payload, description_pattern));
            }
            Err(error) => {
                warn!("Failed to connect to {host_name}: {error}");
                if attempt < discovery_attempts {
                    sleep(discovery_delay).await;
                }
            }
        }
    }

    Ok(Vec::new())
}

fn extract_discovered_server_ids(payload: &Value, description_pattern: &Regex) -> Vec<String> {
    let mut discovered = BTreeSet::new();
    let description = payload
        .get("info")
        .and_then(Value::as_object)
        .and_then(|info| info.get("description"))
        .and_then(Value::as_str)
        .unwrap_or("");

    for capture in description_pattern.captures_iter(description) {
        if let Some(group) = capture.get(1) {
            let candidate = group.as_str().trim();
            if !candidate.is_empty() {
                discovered.insert(candidate.to_string());
            }
        }
    }

    if let Some(paths) = payload.get("paths").and_then(Value::as_object) {
        for path in paths.keys() {
            if OAUTH_PATHS.contains(&path.as_str()) || path == "/servers" {
                continue;
            }
            if let Some(server_id) = path.strip_prefix('/').and_then(|value| {
                value
                    .strip_suffix("/openapi.json")
                    .or_else(|| value.strip_suffix("/docs"))
            }) {
                let candidate = server_id.trim();
                if !candidate.is_empty() {
                    discovered.insert(candidate.to_string());
                }
            }
        }
    }

    discovered.into_iter().collect()
}

pub async fn validate_server_has_tools(
    http_client: &Client,
    config: &RuntimeConfig,
    host: &str,
    server_name: &str,
) -> Result<(Option<bool>, usize)> {
    let url = format!(
        "{}/{server_name}/openapi.json",
        get_proxy_base_url_for_host(config, host)
    );
    let response = http_client
        .get(url)
        .timeout(Duration::from_secs(5))
        .send()
        .await;
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            warn!("Failed to validate tools for {server_name}: {error}");
            return Ok((None, 0));
        }
    };
    if !response.status().is_success() {
        warn!(
            "Failed to validate tools for {server_name}: HTTP {}",
            response.status()
        );
        return Ok((None, 0));
    }
    let payload: Value = response.json().await.unwrap_or_else(|_| json!({}));
    let tool_count = payload
        .get("paths")
        .and_then(Value::as_object)
        .map(|paths| {
            paths
                .keys()
                .filter(|path| !OAUTH_PATHS.contains(&path.as_str()))
                .count()
        })
        .unwrap_or(0);
    Ok((Some(tool_count > 0), tool_count))
}

#[derive(Debug, Clone)]
struct StatusProbeTarget {
    server_id: String,
    base_url: String,
    host: String,
    port: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum StatusProbeOutcome {
    Healthy {
        server_id: String,
        host: String,
        port: String,
    },
    NotReady {
        server_id: String,
        detail: Option<StatusProbeDetail>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusProbeDetail {
    host: String,
    port: String,
    readiness_phase: String,
    healthy: bool,
    tools_count: u64,
    error: Option<String>,
    /// Structured warmup snapshot (phase, elapsed_seconds,
    /// progress_percent, ...) forwarded from mcp-orc while the provider
    /// is still building its caches; None once ready.
    provider_warmup: Option<Value>,
}

fn status_probe_target_for_server(
    config: &RuntimeConfig,
    metadata: &ServerMetadata,
) -> Option<StatusProbeTarget> {
    let deployment_type = metadata.deployment_type.as_str();
    if metadata.is_core || deployment_type == "core" {
        return Some(StatusProbeTarget {
            server_id: metadata.id.clone(),
            base_url: config.mcpo_core_base_url.clone(),
            host: config.mcpo_core_host.clone(),
            port: config.mcpo_core_localhost_port.clone(),
        });
    }

    if deployment_type == "docker" {
        return Some(StatusProbeTarget {
            server_id: metadata.id.clone(),
            base_url: config.mcpo_regular_base_url.clone(),
            host: config.mcpo_regular_host.clone(),
            port: config.mcpo_regular_localhost_port.clone(),
        });
    }

    if deployment_type == "host" {
        return Some(StatusProbeTarget {
            server_id: metadata.id.clone(),
            base_url: config.host_mcpo_base_url.clone(),
            host: config.host_mcpo_host.clone(),
            port: config.host_mcpo_localhost_port.clone(),
        });
    }

    None
}

fn status_probe_targets_for_missing_configured_servers(
    config: &RuntimeConfig,
    configured_servers: &BTreeMap<String, ServerMetadata>,
    mcp_toggles: &HashMap<String, bool>,
    paths: &AppPaths,
    core_tools: &BTreeMap<String, DiscoveredTool>,
    regular_tools: &BTreeMap<String, DiscoveredTool>,
    servers_without_tools: &BTreeSet<String>,
) -> Vec<StatusProbeTarget> {
    configured_servers
        .iter()
        .filter_map(|(server_id, metadata)| {
            let (enabled, _) = get_server_enablement_state(
                server_id,
                metadata,
                mcp_toggles,
                paths,
                config.oauth_token_max_age_seconds,
            );
            if !enabled || !metadata.is_configured {
                return None;
            }
            if core_tools.contains_key(server_id)
                || regular_tools.contains_key(server_id)
                || servers_without_tools.contains(server_id)
            {
                return None;
            }
            status_probe_target_for_server(config, metadata)
        })
        .collect()
}

async fn probe_server_status(
    http_client: Client,
    target: StatusProbeTarget,
    request_timeout: Duration,
) -> StatusProbeOutcome {
    let url = format!("{}/servers/{}/status", target.base_url, target.server_id);
    let response = http_client.get(url).timeout(request_timeout).send().await;

    let response = match response {
        Ok(response) => response,
        Err(error) => {
            warn!(
                "Failed to probe readiness status for {}: {}",
                target.server_id, error
            );
            return StatusProbeOutcome::NotReady {
                server_id: target.server_id,
                detail: None,
            };
        }
    };

    if !response.status().is_success() {
        warn!(
            "Failed to probe readiness status for {}: HTTP {}",
            target.server_id,
            response.status()
        );
        return StatusProbeOutcome::NotReady {
            server_id: target.server_id,
            detail: None,
        };
    }

    let payload = match response.json::<Value>().await {
        Ok(payload) => payload,
        Err(error) => {
            warn!(
                "Failed to parse readiness status for {}: {error}",
                target.server_id
            );
            return StatusProbeOutcome::NotReady {
                server_id: target.server_id,
                detail: None,
            };
        }
    };

    let readiness_phase = payload
        .get("readiness_phase")
        .or_else(|| payload.get("readinessPhase"))
        .or_else(|| payload.get("status"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let healthy = payload
        .get("healthy")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let tools_count = payload
        .get("tools_count")
        .or_else(|| payload.get("toolsCount"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let error = payload
        .get("error")
        .or_else(|| payload.get("message"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let provider_warmup = payload
        .get("provider_warmup")
        .filter(|value| value.is_object())
        .cloned();

    if (healthy || readiness_phase == "tool_ready") && tools_count > 0 {
        info!(
            "{} was absent from discovery summary but /servers/{}/status is tool_ready; marking healthy",
            target.server_id, target.server_id
        );
        return StatusProbeOutcome::Healthy {
            server_id: target.server_id,
            host: target.host,
            port: target.port,
        };
    }

    StatusProbeOutcome::NotReady {
        server_id: target.server_id,
        detail: Some(StatusProbeDetail {
            host: target.host,
            port: target.port,
            readiness_phase: readiness_phase.to_string(),
            healthy,
            tools_count,
            error,
            provider_warmup,
        }),
    }
}

pub async fn reconcile_missing_configured_servers_from_status(
    http_client: &Client,
    config: &RuntimeConfig,
    retries: &RetryConfig,
    configured_servers: &BTreeMap<String, ServerMetadata>,
    mcp_toggles: &HashMap<String, bool>,
    paths: &AppPaths,
    core_tools: &mut BTreeMap<String, DiscoveredTool>,
    regular_tools: &mut BTreeMap<String, DiscoveredTool>,
    servers_without_tools: &mut BTreeSet<String>,
    status_probe_details: &mut BTreeMap<String, StatusProbeDetail>,
) -> Result<()> {
    let targets = status_probe_targets_for_missing_configured_servers(
        config,
        configured_servers,
        mcp_toggles,
        paths,
        core_tools,
        regular_tools,
        servers_without_tools,
    );
    if targets.is_empty() {
        return Ok(());
    }

    info!(
        "Probing readiness status for {} configured server(s) missing from discovery",
        targets.len()
    );
    let request_timeout = retries.discovery_request_timeout_for(config.mode);
    let mut target_iter = targets.into_iter();
    let mut join_set = JoinSet::new();
    let mut in_flight = 0usize;

    loop {
        while in_flight < STATUS_PROBE_CONCURRENCY {
            let Some(target) = target_iter.next() else {
                break;
            };
            let client = http_client.clone();
            join_set.spawn(probe_server_status(client, target, request_timeout));
            in_flight += 1;
        }

        if in_flight == 0 {
            break;
        }

        let Some(result) = join_set.join_next().await else {
            break;
        };
        in_flight = in_flight.saturating_sub(1);
        let outcome = match result {
            Ok(outcome) => outcome,
            Err(error) => {
                warn!("Readiness status probe task failed: {error}");
                continue;
            }
        };

        match outcome {
            StatusProbeOutcome::Healthy {
                server_id,
                host,
                port,
            } => {
                let discovered = DiscoveredTool { host, port };
                if discovered.host == config.mcpo_core_host {
                    core_tools.insert(server_id.clone(), discovered);
                } else {
                    regular_tools.insert(server_id.clone(), discovered);
                }
                servers_without_tools.remove(&server_id);
            }
            StatusProbeOutcome::NotReady { server_id, detail } => {
                if let Some(detail) = detail {
                    status_probe_details.insert(server_id.clone(), detail);
                }
                debug!("{server_id} is still not ready via status probe");
            }
        }
    }

    Ok(())
}

pub async fn fetch_combined_oauth_status(
    http_client: &Client,
    config: &RuntimeConfig,
) -> Result<OAuthStatusPayload> {
    let mut merged = OAuthStatusPayload::default();
    for base_url in [&config.mcpo_regular_base_url, &config.mcpo_core_base_url] {
        let response = http_client
            .get(format!("{base_url}/oauth/status"))
            .timeout(Duration::from_secs(5))
            .send()
            .await;
        let Ok(response) = response else {
            continue;
        };
        let Ok(payload) = response.json::<Value>().await else {
            continue;
        };
        merge_oauth_status_payload(&mut merged, &payload);
    }
    Ok(merged)
}

pub async fn generate_health_status(
    paths: &AppPaths,
    config: &RuntimeConfig,
    configured_servers: &BTreeMap<String, ServerMetadata>,
    mcp_toggles: &HashMap<String, bool>,
    tool_host_map: &BTreeMap<String, DiscoveredTool>,
    servers_without_tools: &BTreeSet<String>,
    status_probe_details: &BTreeMap<String, StatusProbeDetail>,
    preserved_server_ids: &BTreeSet<String>,
    ignored_user_collisions: &[String],
    log_inspector: &dyn ContainerLogInspector,
    http_client: &Client,
) -> Result<bool> {
    let operation_marker_at_run_start = read_operation_publication_marker(&paths.health_status_dir);
    let result: Result<bool> = async {
        let toggle_revision = compute_mcp_toggle_revision(mcp_toggles)?;
        let oauth_status = fetch_combined_oauth_status(http_client, config).await?;

        let mut servers = Map::<String, Value>::new();
        let mut summary = json!({
            "total": 0,
            "healthy": 0,
            "needs_oauth": 0,
            "timeout": 0,
            "failed": 0,
            "not_running": 0,
            "not_configured": 0,
            "disabled": 0,
            "starting": 0
        });

        for (server_id, metadata) in configured_servers {
            let (enabled, reason) = get_server_enablement_state(
                server_id,
                metadata,
                mcp_toggles,
                paths,
                config.oauth_token_max_age_seconds,
            );

            if !enabled {
                bump_summary(&mut summary, "total");
                bump_summary(&mut summary, "disabled");
                servers.insert(
                    server_id.clone(),
                    json!({
                        "status": "disabled",
                        "deployment": metadata.deployment_type,
                        "is_core": metadata.is_core,
                        "host": Value::Null,
                        "port": Value::Null,
                        "error": Value::Null,
                        "oauth_state": Value::Null,
                        "configured": true,
                        "running": false,
                        "disabled_by_user": reason == "explicit_false",
                        "disabled_reason": reason,
                    }),
                );
                continue;
            }

            let mut server_json = if let Some(detail) = status_probe_details.get(server_id) {
                health_status_for_status_probe_server(server_id, metadata, detail, &oauth_status)
            } else if servers_without_tools.contains(server_id) {
                health_status_for_no_tools_server(server_id, metadata, &oauth_status, log_inspector)
            } else if let Some(host_info) = tool_host_map.get(server_id) {
                health_status_for_running_server(
                    server_id,
                    metadata,
                    host_info,
                    &oauth_status,
                    config,
                )
            } else {
                health_status_for_missing_server(server_id, metadata, &oauth_status, log_inspector)
            };
            server_json["is_core"] = json!(metadata.is_core);

            let status = server_json
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("failed");
            bump_summary(&mut summary, "total");
            match status {
                "healthy" => bump_summary(&mut summary, "healthy"),
                "needs_oauth" => bump_summary(&mut summary, "needs_oauth"),
                "timeout" => bump_summary(&mut summary, "timeout"),
                "failed" => bump_summary(&mut summary, "failed"),
                "not_running" => bump_summary(&mut summary, "not_running"),
                "not_configured" => bump_summary(&mut summary, "not_configured"),
                "starting" => bump_summary(&mut summary, "starting"),
                _ => {}
            }
            servers.insert(server_id.clone(), server_json);
        }

        let enabled_server_ids = configured_servers
            .iter()
            .filter_map(|(server_id, metadata)| {
                let (enabled, _) = get_server_enablement_state(
                    server_id,
                    metadata,
                    mcp_toggles,
                    paths,
                    config.oauth_token_max_age_seconds,
                );
                enabled.then(|| server_id.clone())
            })
            .collect::<Vec<_>>();
        let configured_core_server_ids = configured_servers
            .iter()
            .filter_map(|(server_id, metadata)| metadata.is_core.then(|| server_id.clone()))
            .collect::<Vec<_>>();
        let discovered_server_ids = tool_host_map.keys().cloned().collect::<Vec<_>>();
        let no_tools_server_ids = servers_without_tools.iter().cloned().collect::<Vec<_>>();
        let lagging_server_ids = enabled_server_ids
            .iter()
            .filter(|server_id| {
                !discovered_server_ids.contains(server_id)
                    && !no_tools_server_ids.contains(server_id)
                    && servers
                        .get(*server_id)
                        .and_then(Value::as_object)
                        .and_then(|server| server.get("status"))
                        .and_then(Value::as_str)
                        .map(|status| matches!(status, "starting" | "failed" | "not_running"))
                        .unwrap_or(false)
            })
            .cloned()
            .collect::<Vec<_>>();

        let mut warnings = json!({
            "ignored_user_server_id_collisions": ignored_user_collisions
        });
        if !lagging_server_ids.is_empty() {
            warnings["sync_lag"] = json!(lagging_server_ids.clone());
        }

        let payload = json!({
                "timestamp": SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs_f64(),
                "timestamp_iso": format!("{}Z", Utc::now().format("%Y-%m-%dT%H:%M:%S.000")),
                "servers": servers,
                "warnings": warnings,
                "summary": summary,
                "toggle_revision": toggle_revision,
                "sync_diagnostics": {
                "health_sync_run_id": &config.health_sync_run_id,
                "health_check_mode": config.mode.as_str(),
                "toggle_revision": toggle_revision,
                "configured_enabled_servers": enabled_server_ids.len(),
                "configured_core_server_ids": configured_core_server_ids,
                "discovered_servers": discovered_server_ids.len(),
                "preserved_servers": preserved_server_ids.len(),
                "servers_without_tools": no_tools_server_ids.len(),
                "lagging_servers": lagging_server_ids.len(),
                "preserved_server_ids": preserved_server_ids.iter().cloned().collect::<Vec<_>>(),
                "lagging_server_ids": lagging_server_ids,
                "enabled_server_ids": enabled_server_ids,
                "discovered_server_ids": discovered_server_ids,
            }
        });

        fs::create_dir_all(&paths.health_status_dir)?;
        let health_status_path = paths.health_status_dir.join("health_status.json");
        let wrote_status = write_health_status_atomically(
            &health_status_path,
            &serde_json::to_vec_pretty(&payload)?,
            &operation_marker_at_run_start,
        )?;
        if !wrote_status {
            info!(
                "Skipped periodic health publication because an MCP operation published newer readiness"
            );
        }
        Ok(true)
    }
    .await;

    match result {
        Ok(result) => Ok(result),
        Err(error) => {
            error!("Failed to generate health status: {error:#}");
            Ok(false)
        }
    }
}

pub fn discover_filters(paths: &AppPaths) -> Result<Vec<FilterFile>> {
    if !paths.filters_dir.try_exists().with_context(|| {
        format!(
            "failed to inspect managed filters directory {}",
            paths.filters_dir.display()
        )
    })? {
        return Err(anyhow!(
            "managed filters directory does not exist: {}",
            paths.filters_dir.display()
        ));
    }

    let mut filters = Vec::new();
    for entry in fs::read_dir(&paths.filters_dir)? {
        let entry = entry?;
        let path = entry.path();
        if !entry.file_type()?.is_file() {
            continue;
        }
        if path.extension().and_then(|value| value.to_str()) != Some("py") {
            continue;
        }
        if path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .starts_with('_')
        {
            continue;
        }
        let code = fs::read_to_string(&path)
            .with_context(|| format!("failed to read managed filter {}", path.display()))?;
        let filter_id = format!(
            "{FILTER_PREFIX}{}",
            path.file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
        );
        let valves_path = path.with_extension("valves");
        let valves = if valves_path.try_exists().with_context(|| {
            format!(
                "failed to inspect managed filter valves {}",
                valves_path.display()
            )
        })? {
            let contents = fs::read_to_string(&valves_path).with_context(|| {
                format!(
                    "failed to read managed filter valves {}",
                    valves_path.display()
                )
            })?;
            let valves: Value = serde_json::from_str(&contents).with_context(|| {
                format!(
                    "failed to parse managed filter valves {}",
                    valves_path.display()
                )
            })?;
            if !valves.is_object() {
                return Err(anyhow!(
                    "managed filter valves {} must contain a JSON object",
                    valves_path.display()
                ));
            }
            Some(valves)
        } else {
            None
        };
        filters.push(FilterFile {
            file_path: path,
            filter_id: filter_id.clone(),
            name: filter_id,
            description: extract_filter_description(&code),
            code,
            valves,
        });
    }
    Ok(filters)
}

pub async fn install_all_filters(paths: &AppPaths, client: &OpenWebUiClient) -> Result<bool> {
    let filters = discover_filters(paths)?;
    if !filters
        .iter()
        .any(|filter| filter.filter_id == REQUIRED_FILTER_ID)
    {
        return Err(anyhow!(
            "required managed filter {REQUIRED_FILTER_ID} was not discovered in {}",
            paths.filters_dir.display()
        ));
    }

    let existing_payload = client.get_json("/api/v1/functions/", None).await?;
    let existing = existing_payload
        .as_array()
        .cloned()
        .ok_or_else(|| anyhow!("Expected array response from /api/v1/functions/"))?;
    let existing_ids = existing
        .into_iter()
        .filter_map(|function| {
            function
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| id.starts_with(FILTER_PREFIX))
                .map(ToOwned::to_owned)
        })
        .collect::<BTreeSet<_>>();

    let fs_map = filters
        .into_iter()
        .map(|filter| (filter.filter_id.clone(), filter))
        .collect::<BTreeMap<_, _>>();

    // Finish every read and formatting operation before making any mutation.
    // A timeout is an unknown observation, not evidence that managed state is
    // absent or stale.
    let mut prepared = Vec::with_capacity(fs_map.len());
    for (filter_id, filter) in &fs_map {
        let current = if existing_ids.contains(filter_id) {
            Some(
                get_managed_function(client, filter_id)
                    .await
                    .with_context(|| format!("failed to observe managed filter {filter_id}"))?,
            )
        } else {
            None
        };
        let formatted = format_filter_code(client, &filter.code)
            .await
            .with_context(|| format!("failed to format managed filter {filter_id}"))?;
        prepared.push((filter, formatted, current));
    }

    let mut success = true;
    for (filter, formatted, current) in prepared {
        if current
            .as_ref()
            .is_some_and(|function| managed_filter_state_matches(filter, &formatted, function))
        {
            continue;
        }
        if let Err(error) = upsert_managed_filter(client, filter, &formatted).await {
            error!(
                "Failed to reconcile managed filter {}: {error:#}",
                filter.filter_id
            );
            success = false;
        }
    }

    // Stale deletion is the only destructive operation. Do it only after the
    // complete desired set has been independently read back as canonical.
    if success {
        let stale_ids = existing_ids
            .iter()
            .filter(|function_id| !fs_map.contains_key(*function_id))
            .collect::<Vec<_>>();
        for function_id in &stale_ids {
            if let Err(error) = delete_function(client, function_id).await {
                warn!("Failed to delete legacy function {function_id}: {error:#}");
            }
        }

        if !stale_ids.is_empty() {
            let final_payload = client.get_json("/api/v1/functions/", None).await?;
            let final_ids = final_payload
                .as_array()
                .ok_or_else(|| anyhow!("Expected array response from /api/v1/functions/"))?
                .iter()
                .filter_map(|function| {
                    function
                        .get("id")
                        .and_then(Value::as_str)
                        .filter(|id| id.starts_with(FILTER_PREFIX))
                        .map(ToOwned::to_owned)
                })
                .collect::<BTreeSet<_>>();
            let desired_ids = fs_map.keys().cloned().collect::<BTreeSet<_>>();
            if final_ids != desired_ids {
                error!(
                    "Managed filter inventory failed canonical readback after stale deletion"
                );
                success = false;
            }
        }
    }

    Ok(success)
}

pub fn discover_agents(paths: &AppPaths) -> Result<Vec<AgentFile>> {
    if !paths.agents_dir.exists() {
        return Ok(Vec::new());
    }

    let mut agents = Vec::new();
    for entry in fs::read_dir(&paths.agents_dir)? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                warn!(
                    "Failed to read agent directory entry in {}: {error}",
                    paths.agents_dir.display()
                );
                continue;
            }
        };
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) => {
                warn!("Failed to inspect agent path {}: {error}", path.display());
                continue;
            }
        };
        if !file_type.is_dir() {
            continue;
        }
        if path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .starts_with('_')
        {
            continue;
        }
        let config_path = path.join("config.yaml");
        if !config_path.exists() {
            continue;
        }
        let config_contents = match fs::read_to_string(&config_path) {
            Ok(contents) => contents,
            Err(error) => {
                warn!(
                    "Failed to read agent config {}: {error}",
                    config_path.display()
                );
                continue;
            }
        };
        let config: serde_yaml::Value = match serde_yaml::from_str(&config_contents) {
            Ok(config) => config,
            Err(error) => {
                warn!(
                    "Failed to parse agent config {}: {error}",
                    config_path.display()
                );
                continue;
            }
        };
        let system_prompt = fs::read_to_string(path.join("system_prompt.md")).unwrap_or_default();
        let slug = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        let tools_list = config
            .get("tools_list")
            .and_then(serde_yaml::Value::as_sequence)
            .map(|sequence| {
                sequence
                    .iter()
                    .filter_map(|item| item.as_str().map(ToOwned::to_owned))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        agents.push(AgentFile {
            agent_id: format!("{AGENT_PREFIX}{slug}"),
            name: config
                .get("name")
                .and_then(serde_yaml::Value::as_str)
                .unwrap_or(slug)
                .to_string(),
            base_model_id: config
                .get("base_model_id")
                .and_then(serde_yaml::Value::as_str)
                .map(ToOwned::to_owned),
            system_prompt,
            tools_mode: config
                .get("tools_mode")
                .and_then(serde_yaml::Value::as_str)
                .unwrap_or("core")
                .to_string(),
            tools_list,
            description: config
                .get("description")
                .and_then(serde_yaml::Value::as_str)
                .unwrap_or("")
                .to_string(),
            hidden: config
                .get("hidden")
                .and_then(serde_yaml::Value::as_bool)
                .unwrap_or(false),
        });
    }
    Ok(agents)
}

pub fn get_base_system_prompt(paths: &AppPaths) -> Result<String> {
    Ok(fs::read_to_string(paths.agents_dir.join("base_system_prompt.md")).unwrap_or_default())
}

pub async fn install_all_agents(
    paths: &AppPaths,
    client: &OpenWebUiClient,
    core_tool_ids: &[String],
    all_tool_ids: &[String],
) -> Result<bool> {
    let agents = discover_agents(paths)?;
    let tool_ids_by_mode = HashMap::from([
        ("core".to_string(), core_tool_ids.to_vec()),
        ("all".to_string(), all_tool_ids.to_vec()),
        ("none".to_string(), Vec::new()),
    ]);
    let mut success = true;
    for agent in &agents {
        let tool_ids = match agent.tools_mode.as_str() {
            "all" => tool_ids_by_mode.get("all").cloned().unwrap_or_default(),
            "core" => tool_ids_by_mode.get("core").cloned().unwrap_or_default(),
            "specific" => agent.tools_list.clone(),
            "none" => Vec::new(),
            _ => tool_ids_by_mode.get("core").cloned().unwrap_or_default(),
        };
        let result = match check_agent_exists(client, &agent.agent_id).await {
            Ok(true) => update_agent_via_api(paths, client, agent, &tool_ids).await,
            Ok(false) => create_agent_via_api(paths, client, agent, &tool_ids).await,
            Err(error) => {
                warn!(
                    "Failed to determine whether agent {} exists: {error:#}",
                    agent.agent_id
                );
                success = false;
                continue;
            }
        };
        match result {
            Ok(true) => {}
            Ok(false) => success = false,
            Err(error) => {
                warn!("Failed to install agent {}: {error:#}", agent.agent_id);
                success = false;
            }
        }
    }
    Ok(success)
}

pub async fn update_base_models_system_prompt(
    client: &OpenWebUiClient,
    system_prompt: &str,
    skip_model_ids: &[String],
) -> Result<bool> {
    if system_prompt.is_empty() {
        return Ok(true);
    }

    let auth_data = match client.get_json("/api/v1/auths/", None).await {
        Ok(auth_data) => auth_data,
        Err(error) => {
            error!("Failed to get user ID: {error}");
            return Ok(false);
        }
    };
    let user_id = auth_data
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if user_id.is_empty() {
        return Ok(false);
    }

    let all_models_data = match client.get_json("/api/models?", None).await {
        Ok(all_models_data) => all_models_data,
        Err(error) => {
            error!("Failed to fetch models: {error}");
            return Ok(false);
        }
    };
    let models = if let Some(data) = all_models_data.get("data").and_then(Value::as_array) {
        data.clone()
    } else if let Some(models) = all_models_data.as_array() {
        models.clone()
    } else {
        return Err(anyhow!("Expected array response from /api/models?"));
    };
    let base_models = models
        .into_iter()
        .filter(is_base_model_record)
        .filter(|model| {
            model
                .get("id")
                .and_then(Value::as_str)
                .map(|id| !skip_model_ids.iter().any(|skip| skip == id))
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();

    let total_base_models = base_models.len();
    let mut success_count = 0;
    for model_summary in base_models {
        let model_id = model_summary
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("");
        let full_model = match fetch_full_model(client, model_id).await {
            Ok(model) => model,
            Err(error) => {
                warn!("Failed to fetch full model data for {model_id}: {error:#}");
                continue;
            }
        };
        let Some(mut full_model) = full_model else {
            warn!("Failed to fetch full model data for {model_id}");
            continue;
        };
        let current_sanitized = sanitize_model_for_update(&full_model, &user_id);
        let params = ensure_object_field(&mut full_model, "params");
        params.insert("system".to_string(), json!(system_prompt));
        let target_sanitized = sanitize_model_for_update(&full_model, &user_id);
        if target_sanitized == current_sanitized {
            success_count += 1;
            continue;
        }
        if update_model_by_id(client, model_id, &target_sanitized).await? {
            success_count += 1;
        }
    }

    Ok(success_count == total_base_models)
}

pub async fn build_migration_mapping(
    client: &OpenWebUiClient,
    discovered_mcp_servers: &BTreeMap<String, DiscoveredTool>,
) -> Result<(BTreeMap<String, Vec<String>>, Value)> {
    let existing_tools_payload = match client.get_json("/api/v1/tools/", None).await {
        Ok(payload) => payload,
        Err(_) => return Ok((BTreeMap::new(), json!({}))),
    };
    let existing_tools = existing_tools_payload
        .as_array()
        .cloned()
        .ok_or_else(|| anyhow!("Expected array response from /api/v1/tools/"))?;
    let discovered_names = discovered_mcp_servers.keys().cloned().collect::<Vec<_>>();

    let mut numeric_to_stable = BTreeMap::<String, String>::new();
    let mut unmappable_ids = Map::<String, Value>::new();
    let mut has_numeric_ids = false;

    for tool in &existing_tools {
        let tool_id = tool.get("id").and_then(Value::as_str).unwrap_or("");
        let tool_name = tool.get("name").and_then(Value::as_str).unwrap_or("");
        if !is_numeric_tool_id(tool_id) {
            continue;
        }
        has_numeric_ids = true;
        if tool_name.to_ascii_lowercase().contains("glean") {
            numeric_to_stable.insert(tool_id.to_string(), "server:glean".to_string());
            continue;
        }
        let (best_match, score) =
            find_best_match(tool_name, &discovered_names, TOOL_ID_MIGRATION_THRESHOLD);
        if let Some(best_match) = best_match {
            numeric_to_stable.insert(tool_id.to_string(), format!("server:{best_match}"));
        } else {
            unmappable_ids.insert(
                tool_id.to_string(),
                json!({
                    "name": tool_name,
                    "best_score": score,
                }),
            );
        }
    }

    if !has_numeric_ids {
        return Ok((BTreeMap::new(), json!({})));
    }

    let all_models_payload = match client.get_json("/api/v1/models", None).await {
        Ok(payload) => payload,
        Err(_) => return Ok((BTreeMap::new(), json!({}))),
    };
    let all_models = all_models_payload
        .as_array()
        .cloned()
        .ok_or_else(|| anyhow!("Expected array response from /api/v1/models"))?;
    let mut migration_mapping = BTreeMap::<String, Vec<String>>::new();
    let mut models_with_unmappable = Vec::<Value>::new();

    for model in &all_models {
        let base_model_id = model.get("base_model_id");
        if base_model_id.is_none() || base_model_id.is_some_and(Value::is_null) {
            continue;
        }
        let model_id = model.get("id").and_then(Value::as_str).unwrap_or("");
        let model_name = model
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(model_id);
        let current_tool_ids = model
            .get("meta")
            .and_then(Value::as_object)
            .and_then(|meta| meta.get("toolIds"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if current_tool_ids.is_empty() {
            continue;
        }
        let mut migrated = false;
        let mut skipped_ids = Vec::<String>::new();
        let mut new_tool_ids = Vec::<String>::new();
        for tool_id in current_tool_ids
            .iter()
            .filter_map(Value::as_str)
            .map(ToOwned::to_owned)
        {
            if is_numeric_tool_id(&tool_id) {
                if let Some(new_id) = numeric_to_stable.get(&tool_id) {
                    new_tool_ids.push(new_id.clone());
                    migrated = true;
                } else {
                    skipped_ids.push(tool_id);
                }
            } else {
                new_tool_ids.push(tool_id);
            }
        }
        if !skipped_ids.is_empty() {
            models_with_unmappable.push(json!({
                "model_id": model_id,
                "model_name": model_name,
                "skipped_ids": skipped_ids,
            }));
        }
        if migrated || !skipped_ids.is_empty() {
            migration_mapping.insert(model_id.to_string(), new_tool_ids);
        }
    }

    Ok((
        migration_mapping,
        json!({
            "numeric_to_stable": numeric_to_stable,
            "unmappable_ids": unmappable_ids,
            "models_with_unmappable": models_with_unmappable,
        }),
    ))
}

pub fn is_numeric_tool_id(tool_id: &str) -> bool {
    tool_id.starts_with("server:")
        && tool_id[7..]
            .chars()
            .all(|character| character.is_ascii_digit())
}

pub fn find_best_match(
    target_name: &str,
    candidate_names: &[String],
    threshold: f64,
) -> (Option<String>, f64) {
    if candidate_names.is_empty() {
        return (None, 0.0);
    }

    let target = target_name.trim().to_ascii_lowercase();
    let mut best_match = None;
    let mut best_score = 0.0;

    for candidate in candidate_names {
        let score = sequence_match_ratio(&target, &candidate.trim().to_ascii_lowercase());
        if score > best_score {
            best_score = score;
            best_match = Some(candidate.clone());
        }
    }

    if best_score >= threshold {
        (best_match, best_score)
    } else {
        (None, best_score)
    }
}

pub fn generate_migration_report(paths: &AppPaths, migration_data: &Value) -> Result<PathBuf> {
    fs::create_dir_all(&paths.backup_dir)?;
    let timestamp = unix_timestamp();
    let generated_at = Utc
        .timestamp_opt(timestamp, 0)
        .single()
        .unwrap_or_else(Utc::now)
        .format("%Y-%m-%dT%H:%M:%S")
        .to_string();
    let report_path = paths
        .backup_dir
        .join(format!("migration_report_{timestamp}.txt"));
    let numeric_to_stable = migration_data
        .get("numeric_to_stable")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let unmappable_ids = migration_data
        .get("unmappable_ids")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let models_migrated = migration_data
        .get("models_migrated")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let models_skipped = migration_data
        .get("models_skipped")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let models_with_unmappable = migration_data
        .get("models_with_unmappable")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut report = String::new();
    report.push_str(&format!("{}\n", "=".repeat(80)));
    report.push_str("TOOL SERVER ID MIGRATION REPORT\n");
    report.push_str(&format!("{}\n", "=".repeat(80)));
    report.push_str(&format!("Generated: {generated_at}Z\n"));
    report.push_str(&format!("Timestamp: {timestamp}\n\n"));

    report.push_str(&format!("{}\n", "=".repeat(80)));
    report.push_str("NUMERIC ID → STABLE ID MAPPING\n");
    report.push_str(&format!("{}\n", "=".repeat(80)));
    report.push_str(&format!(
        "Total mappings created: {}\n\n",
        numeric_to_stable.len()
    ));
    if numeric_to_stable.is_empty() {
        report.push_str("  (No numeric IDs found - all tool servers already using stable IDs)\n\n");
    } else {
        for (old_id, new_id) in &numeric_to_stable {
            report.push_str(&format!("  • {old_id} → {new_id}\n"));
        }
        report.push('\n');
    }

    if !unmappable_ids.is_empty() {
        report.push_str(&format!("{}\n", "=".repeat(80)));
        report.push_str("UNMAPPABLE NUMERIC IDS (Skipped)\n");
        report.push_str(&format!("{}\n", "=".repeat(80)));
        report.push_str(&format!(
            "Total unmappable IDs: {}\n\n",
            unmappable_ids.len()
        ));
        report.push_str("These numeric IDs could not be matched to any discovered MCP server.\n");
        report.push_str("Models using these IDs will have them REMOVED from their tool lists.\n\n");
        for (old_id, info) in &unmappable_ids {
            report.push_str(&format!(
                "  • {old_id}\n      Name: {}\n      Best match score: {:.2} (threshold: 0.60)\n      Action: SKIPPED (ID removed from models)\n\n",
                info.get("name").and_then(Value::as_str).unwrap_or(""),
                info.get("best_score").and_then(Value::as_f64).unwrap_or(0.0)
            ));
        }
    }

    report.push_str(&format!("{}\n", "=".repeat(80)));
    report.push_str("MODELS MIGRATED\n");
    report.push_str(&format!("{}\n", "=".repeat(80)));
    report.push_str(&format!(
        "Total models migrated: {}\n\n",
        models_migrated.len()
    ));
    if models_migrated.is_empty() {
        report.push_str("  (No models needed migration)\n\n");
    } else {
        for model in &models_migrated {
            report.push_str(&format!(
                "Model: {} (ID: {})\n  OLD tool IDs: {}\n  NEW tool IDs: {}\n  Status: {}\n\n",
                model
                    .get("model_name")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                model.get("model_id").and_then(Value::as_str).unwrap_or(""),
                format_python_list_repr(model.get("old_ids")),
                format_python_list_repr(model.get("new_ids")),
                model.get("status").and_then(Value::as_str).unwrap_or(""),
            ));
        }
    }

    if !models_with_unmappable.is_empty() {
        report.push_str(&format!("{}\n", "=".repeat(80)));
        report.push_str("MODELS WITH UNMAPPABLE IDS\n");
        report.push_str(&format!("{}\n", "=".repeat(80)));
        report.push_str(&format!(
            "Total models affected: {}\n\n",
            models_with_unmappable.len()
        ));
        report.push_str("These models had numeric IDs that couldn't be matched. The unmappable\n");
        report.push_str("IDs were REMOVED from these models' tool lists.\n\n");
        for model in &models_with_unmappable {
            report.push_str(&format!(
                "Model: {} (ID: {})\n  Skipped IDs: {}\n\n",
                model
                    .get("model_name")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                model.get("model_id").and_then(Value::as_str).unwrap_or(""),
                format_python_list_repr(model.get("skipped_ids"))
            ));
        }
    }

    if !models_skipped.is_empty() {
        report.push_str(&format!("{}\n", "=".repeat(80)));
        report.push_str("MODELS SKIPPED\n");
        report.push_str(&format!("{}\n", "=".repeat(80)));
        report.push_str(&format!(
            "Total models skipped: {}\n\n",
            models_skipped.len()
        ));
        for model in &models_skipped {
            report.push_str(&format!(
                "Model: {} (ID: {})\n  Reason: {}\n\n",
                model
                    .get("model_name")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                model.get("model_id").and_then(Value::as_str).unwrap_or(""),
                model.get("reason").and_then(Value::as_str).unwrap_or(""),
            ));
        }
    }

    report.push_str(&format!("{}\n", "=".repeat(80)));
    report.push_str("MIGRATION SUMMARY\n");
    report.push_str(&format!("{}\n", "=".repeat(80)));
    report.push_str(&format!(
        "  ✅ Numeric IDs successfully mapped: {}\n",
        numeric_to_stable.len()
    ));
    report.push_str(&format!(
        "  ⚠️  Numeric IDs unmappable (skipped): {}\n",
        unmappable_ids.len()
    ));
    report.push_str(&format!(
        "  ✅ Models successfully migrated: {}\n",
        models_migrated
            .iter()
            .filter(|model| model.get("status").and_then(Value::as_str) == Some("SUCCESS"))
            .count()
    ));
    report.push_str(&format!(
        "  ❌ Models failed migration: {}\n",
        models_migrated
            .iter()
            .filter(|model| {
                model
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .starts_with("FAILED")
            })
            .count()
    ));
    report.push_str(&format!(
        "  ⚠️  Models with unmappable IDs: {}\n",
        models_with_unmappable.len()
    ));
    report.push_str(&format!(
        "  ⏭️  Models skipped (other reasons): {}\n\n",
        models_skipped.len()
    ));
    report.push_str("NOTES:\n");
    report.push_str("  • This migration only runs once\n");
    report.push_str("  • Unmappable IDs (similarity < 0.60) were removed from models\n");
    report.push_str("  • Tool server IDs are now stable and based on folder names\n");
    report.push_str("  • Future health check runs will be no-ops for migration\n\n");
    report.push_str(&format!("{}\n", "=".repeat(80)));
    report.push_str("END OF REPORT\n");
    report.push_str(&format!("{}\n", "=".repeat(80)));

    fs::write(&report_path, report)?;
    Ok(report_path)
}

pub fn unwrap_models_response(payload: &Value) -> Vec<Value> {
    if let Some(data) = payload.get("data").and_then(Value::as_array) {
        return data.clone();
    }
    if let Some(array) = payload.as_array() {
        return array.clone();
    }
    Vec::new()
}

pub(crate) async fn load_owui_model_inventory(
    client: &OpenWebUiClient,
    configured_model_ids: &[String],
) -> Result<OwuiModelInventory> {
    let picker_payload = client.get_json("/api/models?", None).await?;
    let picker_models = unwrap_models_response(&picker_payload);
    let wrapper_payload = client.get_json("/api/v1/models", None).await?;
    let wrapper_models = unwrap_models_response(&wrapper_payload);

    let picker_model_ids = model_ids_from_models(&picker_models);
    let wrapper_model_ids = model_ids_from_models(&wrapper_models);
    let existing_lm_studio_model_ids = lm_studio_existing_internal_ids(&picker_models);
    let picker_base_model_ids = picker_models
        .iter()
        .filter(|model| is_base_model_record(model))
        .filter_map(model_id)
        .collect::<BTreeSet<_>>();
    let wrapper_base_model_ids = wrapper_models
        .iter()
        .filter(|model| is_base_model_record(model))
        .filter_map(model_id)
        .collect::<BTreeSet<_>>();
    let existing_base_model_ids = picker_base_model_ids
        .union(&wrapper_base_model_ids)
        .cloned()
        .collect::<Vec<_>>();
    let accessible_model_ids = picker_model_ids
        .union(&wrapper_model_ids)
        .cloned()
        .collect::<BTreeSet<_>>();
    let missing_configured_model_ids = configured_model_ids
        .iter()
        .filter(|model_id| {
            !picker_model_ids.contains(model_id.as_str())
                && !wrapper_model_ids.contains(model_id.as_str())
        })
        .cloned()
        .collect::<Vec<_>>();
    let configured_model_ids_missing_from_picker_base_models = configured_model_ids
        .iter()
        .filter(|model_id| {
            wrapper_model_ids.contains(model_id.as_str())
                && !picker_base_model_ids.contains(model_id.as_str())
        })
        .cloned()
        .collect::<Vec<_>>();
    let mut deprecated_reference_count = 0;
    for model in &wrapper_models {
        if parse_base_model_ref(model)?
            .as_deref()
            .and_then(retired_model_migration_target)
            .is_some()
        {
            deprecated_reference_count += 1;
        }
    }

    Ok(OwuiModelInventory {
        picker_model_count: picker_models.len(),
        wrapper_model_count: wrapper_models.len(),
        base_model_count: picker_base_model_ids.len(),
        lm_studio_model_count: existing_lm_studio_model_ids.len(),
        disabled_model_count: picker_models
            .iter()
            .filter(|model| is_model_disabled(model))
            .count(),
        deprecated_reference_count,
        accessible_model_ids,
        missing_configured_model_ids,
        configured_model_ids_missing_from_picker_base_models,
        existing_base_model_ids,
    })
}

fn model_ids_from_models(models: &[Value]) -> BTreeSet<String> {
    models.iter().filter_map(model_id).collect()
}

fn model_id(model: &Value) -> Option<String> {
    model
        .get("id")
        .and_then(Value::as_str)
        .or_else(|| model.get("name").and_then(Value::as_str))
        .map(ToOwned::to_owned)
}

pub(crate) fn is_base_model_record(model: &Value) -> bool {
    model
        .get("base_model_id")
        .or_else(|| {
            model
                .get("info")
                .and_then(Value::as_object)
                .and_then(|info| info.get("base_model_id"))
        })
        .map(Value::is_null)
        .unwrap_or(false)
}

fn is_model_disabled(model: &Value) -> bool {
    model
        .get("info")
        .and_then(Value::as_object)
        .and_then(|info| info.get("meta"))
        .and_then(Value::as_object)
        .and_then(|meta| meta.get("disabled"))
        .and_then(Value::as_bool)
        .or_else(|| {
            model
                .get("meta")
                .and_then(Value::as_object)
                .and_then(|meta| meta.get("disabled"))
                .and_then(Value::as_bool)
        })
        .unwrap_or(false)
}

fn format_python_list_repr(value: Option<&Value>) -> String {
    match value {
        Some(Value::Array(items)) => {
            let joined = items
                .iter()
                .map(|item| match item {
                    Value::String(item) => format!("'{item}'"),
                    _ => item.to_string(),
                })
                .collect::<Vec<_>>()
                .join(", ");
            format!("[{joined}]")
        }
        Some(value) => value.to_string(),
        None => "null".to_string(),
    }
}

pub fn sanitize_model_for_update(model: &Value, user_id: &str) -> Value {
    let mut model = model.clone();
    if let Some(object) = model.as_object_mut() {
        object.insert("user_id".to_string(), json!(user_id));
        object.remove("user");
        object.remove("info");
    }
    model
}

pub async fn get_openwebui_user_id(
    client: &OpenWebUiClient,
    retries: &RetryConfig,
) -> Result<Option<String>> {
    for attempt in 1..=retries.auth_retries {
        match client.get_json("/api/v1/auths/", None).await {
            Ok(payload) => {
                let user_id = payload.get("id").and_then(Value::as_str).unwrap_or("");
                if !user_id.is_empty() {
                    return Ok(Some(user_id.to_string()));
                }
            }
            Err(error) => warn!("Failed to get user ID: {error}"),
        }
        if attempt < retries.auth_retries {
            sleep(retries.auth_delay).await;
        }
    }
    Ok(None)
}

pub async fn get_model_by_id(client: &OpenWebUiClient, model_id: &str) -> Result<Option<Value>> {
    let params = [("id", model_id.to_string())];
    match client.get_json("/api/v1/models/model", Some(&params)).await {
        Ok(model) if model.is_null() => Ok(None),
        Ok(model) if model.is_object() => Ok(Some(model)),
        Ok(_) => Ok(None),
        Err(error) if is_missing_model_lookup_error(&error) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn is_missing_model_lookup_error(error: &OpenWebUiApiError) -> bool {
    if error.status == Some(404) {
        return true;
    }
    let text = format!("{} {}", error, error.response_text).to_ascii_lowercase();
    if error.status == Some(401) && text.contains("we could not find what you're looking for") {
        return true;
    }
    matches!(error.status, Some(400 | 422))
        && (text.contains("not found")
            || text.contains("missing")
            || text.contains("does not exist")
            || text.contains("returned error"))
}

pub async fn update_model_by_id(
    client: &OpenWebUiClient,
    model_id: &str,
    model: &Value,
) -> Result<bool> {
    let params = [("id", model_id.to_string())];
    match client
        .post_text("/api/v1/models/model/update", Some(model), Some(&params))
        .await
    {
        Ok(_) => Ok(true),
        Err(error) => {
            error!("Failed to update {model_id}: {error}");
            Ok(false)
        }
    }
}

pub async fn create_model(client: &OpenWebUiClient, payload: &Value) -> Result<bool> {
    match client
        .post_text("/api/v1/models/create", Some(payload), None)
        .await
    {
        Ok(_) => Ok(true),
        Err(error) => {
            error!(
                "Failed to create {}: {error}",
                payload
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("<unknown>")
            );
            Ok(false)
        }
    }
}

pub async fn delete_model_with_fallbacks(client: &OpenWebUiClient, model_id: &str) -> Result<bool> {
    if client
        .post_text(
            "/api/v1/models/model/delete",
            Some(&json!({ "id": model_id })),
            None,
        )
        .await
        .is_ok()
    {
        return Ok(true);
    }

    let encoded_id = utf8_percent_encode(model_id, NON_ALPHANUMERIC).to_string();
    let delete1 = client
        .request(
            Method::DELETE,
            &format!("/api/v1/models/{encoded_id}/delete"),
            None,
            None,
            true,
        )
        .await?;
    if delete1.ok {
        return Ok(true);
    }

    let params = [("id", model_id.to_string())];
    let delete2 = client
        .request(
            Method::DELETE,
            "/api/v1/models/model/delete",
            None,
            Some(&params),
            true,
        )
        .await?;
    Ok(delete2.ok)
}

fn read_trimmed_file(path: &Path) -> Result<String> {
    Ok(fs::read_to_string(path)?.trim().to_string())
}

#[cfg(test)]
fn app_root_override() -> Option<PathBuf> {
    std::env::var("portico_HEALTH_CHECK_APP_ROOT")
        .ok()
        .map(PathBuf::from)
}

#[cfg(not(test))]
fn app_root_override() -> Option<PathBuf> {
    None
}

#[cfg(test)]
fn redis_url_override() -> Option<String> {
    std::env::var("HEALTH_CHECK_REDIS_URL").ok()
}

#[cfg(not(test))]
fn redis_url_override() -> Option<String> {
    None
}

#[cfg(test)]
fn skip_redis_override() -> bool {
    std::env::var("portico_HEALTH_CHECK_SKIP_REDIS")
        .ok()
        .map(|value| is_truthy(&value))
        .unwrap_or(false)
}

#[cfg(not(test))]
fn skip_redis_override() -> bool {
    false
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn is_truthy(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

fn is_konami_unlock_enabled(paths: &AppPaths) -> bool {
    std::env::var(KONAMI_UNLOCK_ENV_FLAG)
        .ok()
        .map(|value| is_truthy(&value))
        .unwrap_or(false)
        || paths.konami_unlock_flag_file.exists()
}

fn unix_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

pub(crate) fn yaml_truthy(value: Option<&serde_yaml::Value>) -> bool {
    match value {
        Some(serde_yaml::Value::Bool(value)) => *value,
        Some(serde_yaml::Value::Sequence(sequence)) => !sequence.is_empty(),
        Some(serde_yaml::Value::Mapping(mapping)) => !mapping.is_empty(),
        Some(serde_yaml::Value::String(value)) => !value.is_empty(),
        Some(serde_yaml::Value::Number(_)) => true,
        Some(serde_yaml::Value::Tagged(tagged)) => yaml_truthy(Some(&tagged.value)),
        Some(serde_yaml::Value::Null) | None => false,
    }
}

pub(crate) fn get_proxy_base_url_for_host(config: &RuntimeConfig, host: &str) -> String {
    if host == config.mcpo_core_host {
        return config.mcpo_core_base_url.clone();
    }
    if host == config.mcpo_regular_host {
        return config.mcpo_regular_base_url.clone();
    }
    if host == config.host_mcpo_host {
        return config.host_mcpo_base_url.clone();
    }
    format!("http://{host}")
}

pub(crate) fn merge_oauth_status_payload(target: &mut OAuthStatusPayload, payload: &Value) {
    if target.current.is_none() {
        target.current = payload
            .get("current")
            .cloned()
            .filter(|current| current.is_object());
    }
    extend_oauth_status_list(&mut target.active, payload, "active");
    extend_oauth_status_list(&mut target.pending, payload, "pending");
    extend_oauth_status_list(&mut target.checking, payload, "checking");
    extend_oauth_status_list(&mut target.waiting_callback, payload, "waiting_callback");
    extend_oauth_status_list(&mut target.completed, payload, "completed");
    extend_oauth_status_list(&mut target.failed, payload, "failed");
    extend_oauth_status_list(&mut target.timeout, payload, "timeout");
}

fn extend_oauth_status_list(target: &mut Vec<Value>, payload: &Value, key: &str) {
    if let Some(items) = payload.get(key).and_then(Value::as_array) {
        target.extend(items.clone());
    }
}

fn merge_tool_maps(
    core_tools: &BTreeMap<String, DiscoveredTool>,
    regular_tools: &BTreeMap<String, DiscoveredTool>,
) -> BTreeMap<String, DiscoveredTool> {
    let mut merged = core_tools.clone();
    merged.extend(regular_tools.clone());
    merged
}

fn extract_filter_description(code: &str) -> String {
    Regex::new(r"description:\s*(.+?)(?:\n|$)")
        .ok()
        .and_then(|regex| regex.captures(code))
        .and_then(|captures| {
            captures
                .get(1)
                .map(|group| group.as_str().trim().to_string())
        })
        .unwrap_or_default()
}

fn canonical_filter_content(code: &str) -> String {
    code.replace("\r\n", "\n")
        .trim_end_matches(['\r', '\n'])
        .to_string()
}

pub(crate) fn managed_filter_state_matches(
    filter: &FilterFile,
    formatted: &str,
    function: &Value,
) -> bool {
    if function.get("id").and_then(Value::as_str) != Some(filter.filter_id.as_str())
        || function.get("name").and_then(Value::as_str) != Some(filter.name.as_str())
        || function.get("type").and_then(Value::as_str) != Some("filter")
        || function.get("is_active").and_then(Value::as_bool) != Some(true)
        || function.get("is_global").and_then(Value::as_bool) != Some(true)
    {
        return false;
    }
    let owui_code = function
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or("");
    if canonical_filter_content(formatted) != canonical_filter_content(owui_code) {
        return false;
    }
    if function
        .get("meta")
        .and_then(Value::as_object)
        .and_then(|meta| meta.get("description"))
        .and_then(Value::as_str)
        != Some(filter.description.as_str())
    {
        return false;
    }
    if let Some(valves) = &filter.valves {
        if function.get("valves") != Some(valves) {
            return false;
        }
    } else if function.get("valves") != Some(&Value::Null) {
        return false;
    }
    true
}

async fn format_filter_code(client: &OpenWebUiClient, code: &str) -> Result<String> {
    let payload = client
        .post_json(
            "/api/v1/utils/code/format",
            Some(&json!({ "code": code })),
            None,
        )
        .await?;
    payload
        .get("code")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| anyhow!("formatter response did not include a string code field"))
}

fn managed_function_path(filter_id: &str) -> String {
    format!("/api/v1/portico/managed-functions/id/{filter_id}")
}

pub(crate) async fn get_managed_function(
    client: &OpenWebUiClient,
    filter_id: &str,
) -> Result<Value> {
    Ok(client
        .get_json(&managed_function_path(filter_id), None)
        .await?)
}

async fn upsert_managed_filter(
    client: &OpenWebUiClient,
    filter: &FilterFile,
    formatted: &str,
) -> Result<()> {
    let path = managed_function_path(&filter.filter_id);
    let payload = json!({
        "name": filter.name,
        "meta": { "description": filter.description },
        "content": formatted,
        "valves": filter.valves,
        "is_active": true,
        "is_global": true,
    });
    let mutation_error = client.put_json(&path, Some(&payload), None).await.err();

    // Always use an independent readback. If the PUT response timed out after
    // commit, this converts the ambiguous result into a verified success
    // without repeating or inverting any mutation.
    let readback = get_managed_function(client, &filter.filter_id)
        .await
        .with_context(|| {
            if let Some(error) = mutation_error.as_ref() {
                format!(
                    "managed filter upsert had an ambiguous outcome ({error}) and readback failed"
                )
            } else {
                "managed filter readback failed after upsert".to_string()
            }
        })?;
    if !managed_filter_state_matches(filter, formatted, &readback) {
        return Err(anyhow!(
            "managed filter {} failed canonical readback",
            filter.filter_id
        ));
    }
    if let Some(error) = mutation_error {
        warn!(
            "Managed filter {} PUT returned an error, but canonical readback verified success: {error}",
            filter.filter_id
        );
    }
    Ok(())
}

async fn delete_function(client: &OpenWebUiClient, filter_id: &str) -> Result<()> {
    client
        .delete(&format!("/api/v1/functions/id/{filter_id}/delete"), None)
        .await?;
    Ok(())
}

async fn check_agent_exists(client: &OpenWebUiClient, agent_id: &str) -> Result<bool> {
    let params = [("id", agent_id.to_string())];
    Ok(client
        .get_json("/api/v1/models/model", Some(&params))
        .await
        .is_ok())
}

async fn update_agent_via_api(
    paths: &AppPaths,
    client: &OpenWebUiClient,
    agent: &AgentFile,
    tool_ids: &[String],
) -> Result<bool> {
    let params = [("id", agent.agent_id.clone())];
    let mut existing_agent = client
        .get_json("/api/v1/models/model", Some(&params))
        .await?;
    let auth_data = client.get_json("/api/v1/auths/", None).await?;
    let user_id = auth_data.get("id").and_then(Value::as_str).unwrap_or("");
    if let Some(object) = existing_agent.as_object_mut() {
        object.insert("name".to_string(), json!(agent.name));
        object.insert("base_model_id".to_string(), json!(agent.base_model_id));
    }
    let meta = ensure_object_field(&mut existing_agent, "meta");
    meta.insert(
        "profile_image_url".to_string(),
        json!(get_agent_icon_data_url(paths)),
    );
    meta.insert("description".to_string(), json!(agent.description));
    meta.insert("toolIds".to_string(), json!(tool_ids));
    meta.insert("hidden".to_string(), json!(agent.hidden));
    let params_object = ensure_object_field(&mut existing_agent, "params");
    params_object.insert("system".to_string(), json!(agent.system_prompt));
    if let Some(object) = existing_agent.as_object_mut() {
        object.insert("user_id".to_string(), json!(user_id));
        object.remove("user");
        object.remove("info");
        object.remove("access_control");
    }
    Ok(update_model_by_id(client, &agent.agent_id, &existing_agent).await?)
}

async fn create_agent_via_api(
    paths: &AppPaths,
    client: &OpenWebUiClient,
    agent: &AgentFile,
    tool_ids: &[String],
) -> Result<bool> {
    let payload = json!({
        "id": agent.agent_id,
        "name": agent.name,
        "base_model_id": agent.base_model_id,
        "meta": {
            "profile_image_url": get_agent_icon_data_url(paths),
            "description": agent.description,
            "capabilities": {
                "vision": false,
                "file_upload": false,
                "web_search": false,
                "image_generation": false,
                "code_interpreter": false,
                "citations": false
            },
            "toolIds": tool_ids,
            "hidden": agent.hidden
        },
        "params": {
            "system": agent.system_prompt
        }
    });
    Ok(create_model(client, &payload).await?)
}

fn model_identifier_haystack(model: &ConfiguredBaseModel) -> String {
    [Some(model.id.as_str()), model.source_model_id.as_deref()]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

fn model_identifier_has_o_series_token(haystack: &str) -> bool {
    haystack
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .any(|token| matches!(token, "o1" | "o3" | "o4"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CelestialModelIcon {
    Sol,
    Terra,
    Luna,
}

fn canonical_celestial_model_key(model_id: &str) -> String {
    let mut normalized = model_id.trim().to_ascii_lowercase();
    if let Some(value) = normalized.strip_suffix(":latest") {
        normalized = value.trim_end().to_string();
    }
    let leaf = normalized.rsplit('/').next().unwrap_or(&normalized).trim();

    let mut canonical = String::with_capacity(leaf.len());
    let mut separator_pending = false;
    for character in leaf.chars() {
        if character.is_ascii_whitespace() || character == '_' || character == '-' {
            separator_pending = true;
            continue;
        }
        if separator_pending && !canonical.is_empty() {
            canonical.push('-');
        }
        separator_pending = false;
        canonical.push(character);
    }
    canonical.trim_matches('-').to_string()
}

fn celestial_model_icon(model: &ConfiguredBaseModel) -> Option<CelestialModelIcon> {
    [Some(model.id.as_str()), model.source_model_id.as_deref()]
        .into_iter()
        .flatten()
        .find_map(
            |model_id| match canonical_celestial_model_key(model_id).as_str() {
                "gpt-5.6-sol" | "gpt-5.6-sol-pro" => Some(CelestialModelIcon::Sol),
                "gpt-5.6-terra" => Some(CelestialModelIcon::Terra),
                "gpt-5.6-luna" => Some(CelestialModelIcon::Luna),
                _ => None,
            },
        )
}

fn get_model_icon_data(paths: &AppPaths, model: &ConfiguredBaseModel) -> String {
    let haystack = model_identifier_haystack(model);
    let icon_path = if let Some(celestial_icon) = celestial_model_icon(model) {
        match celestial_icon {
            CelestialModelIcon::Sol => &paths.sol_icon_file,
            CelestialModelIcon::Terra => &paths.terra_icon_file,
            CelestialModelIcon::Luna => &paths.luna_icon_file,
        }
    } else if haystack.contains("gemini") || haystack.contains("google") {
        &paths.gemini_icon_file
    } else if haystack.contains("atlas") || haystack.contains("anthropic") {
        &paths.atlas_icon_file
    } else if haystack.contains("openai")
        || haystack.contains("chatgpt")
        || haystack.contains("gpt")
        || model_identifier_has_o_series_token(&haystack)
    {
        &paths.gpt_icon_file
    } else {
        &paths.gpt_icon_file
    };
    read_icon_data_url(icon_path)
}

fn get_agent_icon_data_url(paths: &AppPaths) -> String {
    read_icon_data_url(&paths.agent_icon_file)
}

fn read_icon_data_url(path: &Path) -> String {
    fs::read(path)
        .map(|bytes| format!("data:image/png;base64,{}", BASE64_STANDARD.encode(bytes)))
        .unwrap_or_else(|_| "/static/favicon.png".to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ConfiguredBaseModel {
    pub id: String,
    pub source_model_id: Option<String>,
    pub disabled: bool,
    pub disabled_reason: Option<String>,
}

pub fn load_lm_studio_config(paths: &AppPaths) -> Result<Option<LmStudioConfig>> {
    if !paths.lm_studio_config_file.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(&paths.lm_studio_config_file).with_context(|| {
        format!(
            "failed to read LM Studio config {}",
            paths.lm_studio_config_file.display()
        )
    })?;
    let config = serde_json::from_str::<LmStudioConfig>(&raw).with_context(|| {
        format!(
            "failed to parse LM Studio config {}",
            paths.lm_studio_config_file.display()
        )
    })?;
    if config.enabled == Some(false) {
        return Ok(None);
    }
    Ok(Some(config))
}

pub fn resolve_lm_studio_config(config: Option<&LmStudioConfig>) -> LmStudioResolvedConfig {
    let port = config
        .and_then(|value| value.port)
        .unwrap_or(LM_STUDIO_DEFAULT_PORT);
    let host_base_url = config
        .and_then(|value| value.host_base_url.as_deref())
        .map(normalize_lm_studio_base_url)
        .unwrap_or_else(|| format!("http://127.0.0.1:{port}/v1"));
    let docker_base_url = config
        .and_then(|value| value.docker_base_url.as_deref())
        .map(normalize_lm_studio_base_url)
        .unwrap_or_else(|| format!("http://host.docker.internal:{port}/v1"));
    let api_key = config
        .and_then(|value| value.api_key.as_deref())
        .unwrap_or("")
        .to_string();

    LmStudioResolvedConfig {
        port,
        host_base_url,
        docker_base_url,
        api_key,
    }
}

pub fn normalize_lm_studio_base_url(value: &str) -> String {
    let trimmed = value.trim().trim_end_matches('/');
    let without_models = trimmed.strip_suffix("/models").unwrap_or(trimmed);
    if without_models.ends_with("/v1") {
        without_models.to_string()
    } else {
        format!("{without_models}/v1")
    }
}

fn lm_studio_native_base_url(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    let without_models = trimmed.strip_suffix("/models").unwrap_or(trimmed);
    let without_v1 = without_models.strip_suffix("/v1").unwrap_or(without_models);
    let without_api_v1 = without_v1.strip_suffix("/api/v1").unwrap_or(without_v1);
    format!("{without_api_v1}/api/v1")
}

pub async fn fetch_lm_studio_model_ids(
    http_client: &Client,
    base_url: &str,
    timeout: Duration,
) -> Result<Vec<String>> {
    Ok(fetch_lm_studio_models(http_client, base_url, timeout)
        .await?
        .into_iter()
        .map(|model| model.id)
        .collect())
}

pub async fn fetch_lm_studio_models(
    http_client: &Client,
    base_url: &str,
    timeout: Duration,
) -> Result<Vec<LmStudioDiscoveredModel>> {
    let native_base_url = lm_studio_native_base_url(base_url);
    match fetch_lm_studio_native_models(http_client, &native_base_url, timeout).await {
        Ok((models, saw_native_entries)) if saw_native_entries || !models.is_empty() => Ok(models),
        Ok(_) | Err(_) => fetch_lm_studio_openai_models(http_client, base_url, timeout).await,
    }
}

async fn fetch_lm_studio_native_models(
    http_client: &Client,
    native_base_url: &str,
    timeout: Duration,
) -> Result<(Vec<LmStudioDiscoveredModel>, bool)> {
    let response = http_client
        .get(format!("{}/models", native_base_url.trim_end_matches('/')))
        .timeout(timeout.min(Duration::from_secs(5)))
        .send()
        .await
        .with_context(|| format!("failed to reach LM Studio at {native_base_url}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(anyhow!(
            "LM Studio native /api/v1/models returned HTTP {status}"
        ));
    }
    let payload = response
        .json::<Value>()
        .await
        .context("failed to parse LM Studio native /api/v1/models response")?;
    let entries = lm_studio_model_entries(&payload);
    let saw_native_entries = !entries.is_empty();
    let mut seen = BTreeSet::new();
    let mut models = Vec::new();
    for model in entries {
        let Some(id) = lm_studio_model_entry_id(model) else {
            continue;
        };
        if is_lm_studio_embedding_model_entry(model) || !lm_studio_native_model_is_loaded(model) {
            continue;
        }
        if seen.insert(id.clone()) {
            models.push(LmStudioDiscoveredModel {
                id,
                loaded_context_tokens: lm_studio_loaded_context_tokens(model),
                max_context_tokens: lm_studio_max_context_tokens(model),
            });
        }
    }
    Ok((models, saw_native_entries))
}

async fn fetch_lm_studio_openai_models(
    http_client: &Client,
    base_url: &str,
    timeout: Duration,
) -> Result<Vec<LmStudioDiscoveredModel>> {
    let response = http_client
        .get(format!("{}/models", base_url.trim_end_matches('/')))
        .timeout(timeout.min(Duration::from_secs(5)))
        .send()
        .await
        .with_context(|| format!("failed to reach LM Studio at {base_url}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(anyhow!("LM Studio /models returned HTTP {status}"));
    }
    let payload = response
        .json::<Value>()
        .await
        .context("failed to parse LM Studio /models response")?;
    let mut seen = BTreeSet::new();
    let mut models = Vec::new();
    for model in lm_studio_model_entries(&payload) {
        let Some(id) = lm_studio_model_entry_id(model) else {
            continue;
        };
        if !is_lm_studio_embedding_model_entry(model) && seen.insert(id.clone()) {
            models.push(LmStudioDiscoveredModel {
                id,
                loaded_context_tokens: None,
                max_context_tokens: None,
            });
        }
    }
    Ok(models)
}

fn lm_studio_model_entries(payload: &Value) -> Vec<&Value> {
    if let Some(models) = payload.as_array() {
        return models.iter().collect();
    }
    for key in ["data", "models", "items"] {
        if let Some(models) = payload.get(key).and_then(Value::as_array) {
            return models.iter().collect();
        }
    }
    Vec::new()
}

fn lm_studio_model_entry_id(model: &Value) -> Option<String> {
    for key in ["id", "model_key", "key", "name", "path"] {
        let Some(value) = model.get(key).and_then(Value::as_str) else {
            continue;
        };
        let value = value.trim();
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

fn value_i64_at(value: &Value, path: &[&str]) -> Option<i64> {
    let mut current = value;
    for segment in path {
        current = current.get(*segment)?;
    }
    current
        .as_i64()
        .or_else(|| current.as_u64().and_then(|value| i64::try_from(value).ok()))
        .or_else(|| current.as_str()?.trim().parse::<i64>().ok())
        .filter(|value| *value > 0)
}

fn lm_studio_loaded_instances(model: &Value) -> Vec<&Value> {
    for key in ["loaded_instances", "instances"] {
        if let Some(instances) = model.get(key).and_then(Value::as_array) {
            return instances.iter().collect();
        }
    }
    if model.get("loaded").and_then(Value::as_bool) == Some(true)
        || model
            .get("state")
            .and_then(Value::as_str)
            .map(|state| state.eq_ignore_ascii_case("loaded"))
            .unwrap_or(false)
    {
        return vec![model];
    }
    Vec::new()
}

fn lm_studio_native_model_is_loaded(model: &Value) -> bool {
    !lm_studio_loaded_instances(model).is_empty()
}

fn lm_studio_loaded_context_tokens(model: &Value) -> Option<i64> {
    for instance in lm_studio_loaded_instances(model) {
        for path in [
            &["config", "context_length"][..],
            &["config", "contextLength"],
            &["load_config", "context_length"],
            &["context_length"],
        ] {
            if let Some(value) = value_i64_at(instance, path) {
                return Some(value);
            }
        }
    }
    None
}

fn lm_studio_max_context_tokens(model: &Value) -> Option<i64> {
    for path in [
        &["max_context_length"][..],
        &["max_context_tokens"],
        &["context_length"],
        &["metadata", "max_context_length"],
        &["metadata", "max_context_tokens"],
    ] {
        if let Some(value) = value_i64_at(model, path) {
            return Some(value);
        }
    }
    None
}

fn is_lm_studio_embedding_model_entry(model: &Value) -> bool {
    let mut values = Vec::new();
    for path in [
        &["id"][..],
        &["name"],
        &["type"],
        &["object"],
        &["model_type"],
        &["task"],
        &["pipeline_tag"],
        &["capabilities", "type"],
        &["metadata", "type"],
        &["metadata", "model_type"],
    ] {
        if let Some(value) = value_string_at(model, path) {
            values.push(value.to_ascii_lowercase());
        }
    }
    let haystack = values.join(" ");
    haystack.contains("embedding")
        || haystack.contains("text-embedding")
        || haystack.contains("embed")
        || haystack.contains("rerank")
        || haystack.contains("ranker")
}

fn value_string_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut current = value;
    for segment in path {
        current = current.get(*segment)?;
    }
    current.as_str()
}

fn is_lm_studio_model(model: &Value) -> bool {
    let candidates = [
        value_string_at(model, &["meta", "local_provider"]),
        value_string_at(model, &["info", "meta", "local_provider"]),
        value_string_at(model, &["owned_by"]),
        value_string_at(model, &["openai", "owned_by"]),
        value_string_at(model, &["connection_type"]),
        value_string_at(model, &["openai", "connection_type"]),
    ];
    if candidates.iter().flatten().any(|value| {
        let normalized = value.trim().to_ascii_lowercase().replace('-', "_");
        normalized == LM_STUDIO_PROVIDER_ID || normalized == "local"
    }) {
        return true;
    }

    model
        .get("tags")
        .and_then(Value::as_array)
        .map(|tags| {
            tags.iter().any(|tag| {
                tag.get("name")
                    .and_then(Value::as_str)
                    .map(|name| name.eq_ignore_ascii_case(LM_STUDIO_TAG_NAME))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn lm_studio_raw_model_id(model: &Value) -> Option<String> {
    value_string_at(model, &["meta", "local_model_id"])
        .or_else(|| value_string_at(model, &["info", "meta", "local_model_id"]))
        .or_else(|| model.get("id").and_then(Value::as_str))
        .map(str::to_string)
}

pub fn lm_studio_internal_model_id(raw_id: &str, existing_models: &[Value]) -> String {
    let raw_id = raw_id.trim();
    let collides_with_non_local = existing_models.iter().any(|model| {
        model.get("id").and_then(Value::as_str) == Some(raw_id) && !is_lm_studio_model(model)
    });
    if collides_with_non_local {
        format!("{LM_STUDIO_LOCAL_PREFIX}{raw_id}")
    } else {
        raw_id.to_string()
    }
}

fn lm_studio_existing_internal_ids(existing_models: &[Value]) -> BTreeSet<String> {
    existing_models
        .iter()
        .filter(|model| is_lm_studio_model(model))
        .filter_map(|model| model.get("id").and_then(Value::as_str).map(str::to_string))
        .collect()
}

fn existing_model_id_set(existing_models: &[Value]) -> BTreeSet<String> {
    existing_models
        .iter()
        .filter_map(|model| model.get("id").and_then(Value::as_str).map(str::to_string))
        .collect()
}

fn merge_lm_studio_openai_config(
    existing: Value,
    resolved: &LmStudioResolvedConfig,
    reachable: bool,
    internal_model_ids: &[String],
    aliases: &BTreeMap<String, String>,
) -> Value {
    let mut base_urls = existing
        .get("OPENAI_API_BASE_URLS")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut api_keys = existing
        .get("OPENAI_API_KEYS")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut api_configs = existing
        .get("OPENAI_API_CONFIGS")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let mut target_index = base_urls
        .iter()
        .position(|url| url.as_str() == Some(resolved.docker_base_url.as_str()));

    if target_index.is_none() {
        target_index = api_configs.iter().find_map(|(key, value)| {
            let provider = value
                .get("portico_provider")
                .or_else(|| value.get("local_provider"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if provider == LM_STUDIO_PROVIDER_ID {
                key.parse::<usize>().ok()
            } else {
                None
            }
        });
    }

    let index = target_index.unwrap_or(base_urls.len());
    while base_urls.len() <= index {
        base_urls.push(Value::String(String::new()));
    }
    while api_keys.len() <= index {
        api_keys.push(Value::String(String::new()));
    }
    base_urls[index] = Value::String(resolved.docker_base_url.clone());
    api_keys[index] = Value::String(resolved.api_key.clone());

    api_configs.insert(
        index.to_string(),
        json!({
            "enable": reachable,
            "connection_type": "local",
            "portico_provider": LM_STUDIO_PROVIDER_ID,
            "local_provider": LM_STUDIO_PROVIDER_ID,
            "model_ids": internal_model_ids,
            "model_aliases": aliases,
            "lm_studio_model_aliases": aliases,
            "tags": [{ "name": LM_STUDIO_TAG_NAME }],
        }),
    );

    json!({
        "ENABLE_OPENAI_API": existing
            .get("ENABLE_OPENAI_API")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        "OPENAI_API_BASE_URLS": base_urls,
        "OPENAI_API_KEYS": api_keys,
        "OPENAI_API_CONFIGS": api_configs,
    })
}

async fn sync_lm_studio_openai_connection(
    client: &OpenWebUiClient,
    resolved: &LmStudioResolvedConfig,
    reachable: bool,
    internal_model_ids: &[String],
    aliases: &BTreeMap<String, String>,
) -> Result<()> {
    let current_config = client
        .get_json("/openai/config", None)
        .await
        .unwrap_or_else(|error| {
            warn!("Could not read OpenWebUI OpenAI config for LM Studio sync: {error:#}");
            json!({})
        });
    let payload = merge_lm_studio_openai_config(
        current_config,
        resolved,
        reachable,
        internal_model_ids,
        aliases,
    );
    let response = client
        .request(
            Method::POST,
            "/openai/config/update",
            Some(&payload),
            None,
            true,
        )
        .await?;
    if !response.ok {
        return Err(anyhow!(
            "failed to update OpenWebUI OpenAI config for LM Studio: HTTP {:?}",
            response.status
        ));
    }
    Ok(())
}

fn local_model_capabilities() -> Value {
    json!({
        "vision": false,
        "file_upload": false,
        "web_search": false,
        "image_generation": false,
        "code_interpreter": false,
        "citations": false,
    })
}

fn update_lm_studio_model_metadata(
    model: &mut Value,
    internal_id: &str,
    raw_id: &str,
    reachable: bool,
    context_tokens: Option<i64>,
    max_context_tokens: Option<i64>,
) {
    let context_tokens = context_tokens.unwrap_or(LM_STUDIO_DEFAULT_CONTEXT_TOKENS);
    let meta = ensure_object_field(model, "meta");
    meta.insert(
        "local_provider".to_string(),
        Value::String(LM_STUDIO_PROVIDER_ID.to_string()),
    );
    meta.insert(
        "local_model_id".to_string(),
        Value::String(raw_id.to_string()),
    );
    meta.insert("toolIds".to_string(), json!([]));
    meta.insert("disabled".to_string(), Value::Bool(!reachable));
    meta.insert(
        "max_context_tokens".to_string(),
        Value::Number(context_tokens.into()),
    );
    if let Some(max_context_tokens) = max_context_tokens {
        meta.insert(
            "lm_studio_max_context_tokens".to_string(),
            Value::Number(max_context_tokens.into()),
        );
    }
    if reachable {
        meta.remove("disabled_reason");
    } else {
        meta.insert(
            "disabled_reason".to_string(),
            Value::String(LM_STUDIO_DISABLED_REASON.to_string()),
        );
    }
    meta.insert("capabilities".to_string(), local_model_capabilities());
    meta.insert("tags".to_string(), json!([{ "name": LM_STUDIO_TAG_NAME }]));

    let info = ensure_object_field(model, "info");
    info.insert("base_model_id".to_string(), Value::Null);
    let info_meta_value = info
        .entry("meta".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !info_meta_value.is_object() {
        *info_meta_value = Value::Object(Map::new());
    }
    if let Some(info_meta) = info_meta_value.as_object_mut() {
        info_meta.insert(
            "local_provider".to_string(),
            Value::String(LM_STUDIO_PROVIDER_ID.to_string()),
        );
        info_meta.insert(
            "local_model_id".to_string(),
            Value::String(raw_id.to_string()),
        );
        info_meta.insert("disabled".to_string(), Value::Bool(!reachable));
        info_meta.insert(
            "max_context_tokens".to_string(),
            Value::Number(context_tokens.into()),
        );
        if let Some(max_context_tokens) = max_context_tokens {
            info_meta.insert(
                "lm_studio_max_context_tokens".to_string(),
                Value::Number(max_context_tokens.into()),
            );
        }
        if reachable {
            info_meta.remove("disabled_reason");
        } else {
            info_meta.insert(
                "disabled_reason".to_string(),
                Value::String(LM_STUDIO_DISABLED_REASON.to_string()),
            );
        }
    }

    if let Some(object) = model.as_object_mut() {
        object.insert("id".to_string(), Value::String(internal_id.to_string()));
        object.insert("name".to_string(), Value::String(raw_id.to_string()));
        object.insert("base_model_id".to_string(), Value::Null);
        object.insert(
            "owned_by".to_string(),
            Value::String("lm-studio".to_string()),
        );
        object.insert(
            "connection_type".to_string(),
            Value::String("local".to_string()),
        );
        object.insert("tags".to_string(), json!([{ "name": LM_STUDIO_TAG_NAME }]));
        object.insert("is_active".to_string(), Value::Bool(true));
    }
}

fn build_lm_studio_model_payload(
    internal_id: &str,
    raw_id: &str,
    reachable: bool,
    context_tokens: Option<i64>,
    max_context_tokens: Option<i64>,
) -> Value {
    let context_tokens = context_tokens.unwrap_or(LM_STUDIO_DEFAULT_CONTEXT_TOKENS);
    let mut payload = json!({
        "id": internal_id,
        "base_model_id": Value::Null,
        "name": raw_id,
        "meta": {
            "description": "Local model served by LM Studio.",
            "capabilities": local_model_capabilities(),
            "suggestion_prompts": Value::Null,
            "tags": [{ "name": LM_STUDIO_TAG_NAME }],
            "toolIds": [],
            "disabled": !reachable,
            "local_provider": LM_STUDIO_PROVIDER_ID,
            "local_model_id": raw_id,
            "max_context_tokens": context_tokens,
        },
        "info": {
            "base_model_id": Value::Null,
            "meta": {
                "disabled": !reachable,
                "local_provider": LM_STUDIO_PROVIDER_ID,
                "local_model_id": raw_id,
                "max_context_tokens": context_tokens,
            }
        },
        "params": {},
        "object": "model",
        "created": 1677610602,
        "owned_by": "lm-studio",
        "connection_type": "local",
        "openai": {
            "id": internal_id,
            "object": "model",
            "created": 1677610602,
            "owned_by": "lm-studio",
            "connection_type": "local"
        },
        "tags": [{ "name": LM_STUDIO_TAG_NAME }],
        "access_control": {
            "read": { "group_ids": [], "user_ids": [] },
            "write": { "group_ids": [], "user_ids": [] }
        },
        "is_active": true,
        "is_default": false
    });
    if !reachable {
        payload["meta"]["disabled_reason"] = Value::String(LM_STUDIO_DISABLED_REASON.to_string());
        payload["info"]["meta"]["disabled_reason"] =
            Value::String(LM_STUDIO_DISABLED_REASON.to_string());
    }
    if let Some(max_context_tokens) = max_context_tokens {
        payload["meta"]["lm_studio_max_context_tokens"] = Value::Number(max_context_tokens.into());
        payload["info"]["meta"]["lm_studio_max_context_tokens"] =
            Value::Number(max_context_tokens.into());
    }
    payload
}

async fn upsert_lm_studio_model_wrappers(
    client: &OpenWebUiClient,
    user_id: &str,
    discovered: &[(String, LmStudioDiscoveredModel)],
    existing_models: &[Value],
    reachable: bool,
) -> Result<(usize, usize)> {
    let mut updated = 0;
    let mut created = 0;
    let existing_ids = existing_model_id_set(existing_models);
    for (internal_id, discovered_model) in discovered {
        let raw_id = discovered_model.id.as_str();
        let existing_model = if existing_ids.contains(internal_id) {
            get_model_by_id(client, internal_id).await?
        } else {
            None
        };
        if let Some(mut existing) = existing_model {
            update_lm_studio_model_metadata(
                &mut existing,
                internal_id,
                raw_id,
                reachable,
                discovered_model.context_tokens(),
                discovered_model.max_context_tokens,
            );
            let sanitized = sanitize_model_for_update(&existing, user_id);
            if update_model_by_id(client, internal_id, &sanitized).await? {
                updated += 1;
            }
        } else {
            let payload = build_lm_studio_model_payload(
                internal_id,
                raw_id,
                reachable,
                discovered_model.context_tokens(),
                discovered_model.max_context_tokens,
            );
            if create_model(client, &payload).await? {
                created += 1;
            }
        }
    }
    Ok((updated, created))
}

async fn disable_existing_lm_studio_models(
    client: &OpenWebUiClient,
    user_id: &str,
    existing_models: &[Value],
) -> Result<usize> {
    let mut disabled = 0;
    for model in existing_models
        .iter()
        .filter(|model| is_lm_studio_model(model))
    {
        let Some(model_id) = model.get("id").and_then(Value::as_str) else {
            continue;
        };
        let raw_id = lm_studio_raw_model_id(model).unwrap_or_else(|| model_id.to_string());
        let mut full_model = get_model_by_id(client, model_id)
            .await?
            .unwrap_or_else(|| model.clone());
        update_lm_studio_model_metadata(&mut full_model, model_id, &raw_id, false, None, None);
        let sanitized = sanitize_model_for_update(&full_model, user_id);
        if update_model_by_id(client, model_id, &sanitized).await? {
            disabled += 1;
        }
    }
    Ok(disabled)
}

pub async fn sync_lm_studio_models(
    paths: &AppPaths,
    http_client: &Client,
    client: &OpenWebUiClient,
    user_id: &str,
    timeout: Duration,
) -> Result<LmStudioSyncResult> {
    let Some(config) = load_lm_studio_config(paths)? else {
        return Ok(LmStudioSyncResult::default());
    };
    let resolved = resolve_lm_studio_config(Some(&config));
    let existing_models_payload = client.get_json("/api/models?", None).await?;
    let existing_models = unwrap_models_response(&existing_models_payload);
    let fetched_models =
        fetch_lm_studio_models(http_client, &resolved.docker_base_url, timeout).await;

    match fetched_models {
        Ok(models) => {
            let model_ids = models
                .iter()
                .map(|model| model.id.clone())
                .collect::<Vec<_>>();
            let discovered = models
                .iter()
                .map(|model| {
                    (
                        lm_studio_internal_model_id(&model.id, &existing_models),
                        model.clone(),
                    )
                })
                .collect::<Vec<_>>();
            let internal_model_ids = discovered
                .iter()
                .map(|(internal_id, _)| internal_id.clone())
                .collect::<Vec<_>>();
            let aliases = discovered
                .iter()
                .map(|(internal_id, model)| (internal_id.clone(), model.id.clone()))
                .collect::<BTreeMap<_, _>>();
            sync_lm_studio_openai_connection(
                client,
                &resolved,
                true,
                &internal_model_ids,
                &aliases,
            )
            .await?;
            let (updated, created) = upsert_lm_studio_model_wrappers(
                client,
                user_id,
                &discovered,
                &existing_models,
                true,
            )
            .await?;
            Ok(LmStudioSyncResult {
                configured: true,
                reachable: true,
                model_ids,
                internal_model_ids,
                created,
                updated,
                disabled: 0,
            })
        }
        Err(error) => {
            warn!("LM Studio local server is not reachable: {error:#}");
            let existing_local_ids = lm_studio_existing_internal_ids(&existing_models)
                .into_iter()
                .collect::<Vec<_>>();
            let aliases = existing_models
                .iter()
                .filter(|model| is_lm_studio_model(model))
                .filter_map(|model| {
                    let internal_id = model.get("id").and_then(Value::as_str)?;
                    let raw_id = lm_studio_raw_model_id(model)?;
                    Some((internal_id.to_string(), raw_id))
                })
                .collect::<BTreeMap<_, _>>();
            sync_lm_studio_openai_connection(
                client,
                &resolved,
                false,
                &existing_local_ids,
                &aliases,
            )
            .await?;
            let disabled =
                disable_existing_lm_studio_models(client, user_id, &existing_models).await?;
            Ok(LmStudioSyncResult {
                configured: true,
                reachable: false,
                model_ids: Vec::new(),
                internal_model_ids: existing_local_ids,
                created: 0,
                updated: 0,
                disabled,
            })
        }
    }
}

#[cfg(test)]
pub(crate) fn resolve_target_default_model(
    current_default_model: Option<String>,
    configured_models: &[ConfiguredBaseModel],
    model_sync_required: bool,
) -> String {
    resolve_target_default_model_with_accessible(
        current_default_model,
        configured_models,
        model_sync_required,
        &BTreeSet::new(),
    )
}

pub(crate) fn resolve_target_default_model_with_accessible(
    current_default_model: Option<String>,
    configured_models: &[ConfiguredBaseModel],
    model_sync_required: bool,
    accessible_model_ids: &BTreeSet<String>,
) -> String {
    let enabled_model_ids = configured_models
        .iter()
        .filter(|model| !model.disabled)
        .map(|model| model.id.as_str())
        .collect::<Vec<_>>();
    let current_default_model = current_default_model
        .map(|model_id| model_id.trim().to_string())
        .filter(|model_id| !model_id.is_empty());

    if let Some(current_default_model) = current_default_model {
        let current_is_retired = is_obsolete_managed_model_id(&current_default_model);
        if model_sync_required {
            if let Some(target) = deprecated_base_model_migration_target(&current_default_model) {
                let target_is_configured = configured_models.iter().any(|model| model.id == target);
                if enabled_model_ids.contains(&target)
                    || (!target_is_configured && accessible_model_ids.contains(target))
                {
                    return target.to_string();
                }
            }
            if !current_is_retired
                && should_use_default_atlas_sonnet(&current_default_model, &enabled_model_ids)
            {
                return DEFAULT_ATLAS_SONNET_MODEL_ID.to_string();
            }
            if !current_is_retired && accessible_model_ids.contains(&current_default_model) {
                return current_default_model;
            }
        }
        if !model_sync_required
            || (!current_is_retired && enabled_model_ids.contains(&current_default_model.as_str()))
        {
            return current_default_model;
        }
    }

    if enabled_model_ids.contains(&DEFAULT_ATLAS_SONNET_MODEL_ID) {
        return DEFAULT_ATLAS_SONNET_MODEL_ID.to_string();
    }

    enabled_model_ids
        .first()
        .map(|model_id| (*model_id).to_string())
        .unwrap_or_else(|| DEFAULT_ATLAS_SONNET_MODEL_ID.to_string())
}

pub(crate) fn load_models_from_model_catalog(paths: &AppPaths) -> Result<Vec<ConfiguredBaseModel>> {
    let unlock_gpt54_pro = is_konami_unlock_enabled(paths);
    let config: serde_yaml::Value =
        serde_yaml::from_str(&fs::read_to_string(&paths.model_catalog_file)?)?;
    let config = config
        .as_mapping()
        .ok_or_else(|| anyhow!("model catalog root must be a mapping"))?;
    let model_list = config
        .get(serde_yaml::Value::from("model_list"))
        .cloned()
        .unwrap_or(serde_yaml::Value::Sequence(Vec::new()));
    let model_list = model_list
        .as_sequence()
        .ok_or_else(|| anyhow!("model catalog model_list must be a sequence"))?;
    let mut models = Vec::new();
    for item in model_list {
        let item = item
            .as_mapping()
            .ok_or_else(|| anyhow!("model catalog model entries must be mappings"))?;
        let Some(model_name) = item
            .get(serde_yaml::Value::from("model_name"))
            .and_then(serde_yaml::Value::as_str)
        else {
            continue;
        };
        if !model_name.to_ascii_lowercase().contains("embedding") {
            let model_info = item
                .get(serde_yaml::Value::from("model_info"))
                .and_then(serde_yaml::Value::as_mapping);
            let disabled = model_info
                .and_then(|info| info.get(serde_yaml::Value::from("disabled")))
                .and_then(serde_yaml::Value::as_bool)
                .unwrap_or(false);
            let disabled_reason = model_info
                .and_then(|info| info.get(serde_yaml::Value::from("disabled_reason")))
                .and_then(serde_yaml::Value::as_str)
                .map(str::trim)
                .filter(|reason| !reason.is_empty())
                .map(str::to_string);
            let source_model_id = model_info
                .and_then(|info| info.get(serde_yaml::Value::from("base_model")))
                .and_then(serde_yaml::Value::as_str)
                .or_else(|| {
                    item.get(serde_yaml::Value::from("litellm_params"))
                        .and_then(serde_yaml::Value::as_mapping)
                        .and_then(|params| params.get(serde_yaml::Value::from("model")))
                        .and_then(serde_yaml::Value::as_str)
                })
                .map(str::trim)
                .filter(|model_id| !model_id.is_empty())
                .map(str::to_string);
            let (disabled, disabled_reason) =
                if model_name == KONAMI_UNLOCK_MODEL_ID && unlock_gpt54_pro {
                    (false, None)
                } else {
                    (disabled, disabled_reason)
                };

            models.push(ConfiguredBaseModel {
                id: model_name.to_string(),
                source_model_id,
                disabled,
                disabled_reason,
            });
        }
    }
    Ok(models)
}

fn configured_model_ids(models: &[ConfiguredBaseModel]) -> Vec<String> {
    models.iter().map(|model| model.id.clone()).collect()
}

const DEFAULT_ATLAS_SONNET_MODEL_ID: &str = "Atlas Sonnet 5";

fn current_default_model_from_settings(user_settings: &Value) -> Option<String> {
    user_settings
        .get("ui")
        .and_then(Value::as_object)
        .and_then(|ui| ui.get("models"))
        .and_then(Value::as_array)
        .and_then(|models| models.first())
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|model_id| !model_id.is_empty())
        .map(ToOwned::to_owned)
}
fn preserved_text_scale(user_settings: &Value) -> Option<Value> {
    user_settings
        .get("ui")
        .and_then(Value::as_object)
        .and_then(|ui| ui.get("textScale"))
        .filter(|value| value.is_number())
        .cloned()
}

pub(crate) fn build_user_settings_payload(
    user_settings: &Value,
    target_default_model: &str,
) -> Value {
    let mut ui = Map::new();
    ui.insert("version".to_string(), json!("0.6.15"));
    ui.insert("toolServers".to_string(), json!([]));
    ui.insert("models".to_string(), json!([target_default_model]));
    ui.insert(
        "params".to_string(),
        json!({
            "function_calling": "native"
        }),
    );
    ui.insert("showChangelog".to_string(), json!(false));
    ui.insert("showUpdateToast".to_string(), json!(false));

    if let Some(text_scale) = preserved_text_scale(user_settings) {
        ui.insert("textScale".to_string(), text_scale);
    }

    Value::Object(
        [("ui".to_string(), Value::Object(ui))]
            .into_iter()
            .collect::<Map<String, Value>>(),
    )
}

fn should_use_default_atlas_sonnet(
    current_default_model: &str,
    enabled_model_ids: &[&str],
) -> bool {
    if !enabled_model_ids.contains(&DEFAULT_ATLAS_SONNET_MODEL_ID) {
        return false;
    }

    matches!(
        current_default_model.trim().to_ascii_lowercase().as_str(),
        "atlas sonnet 5"
            | "atlas sonnet 4.6"
            | "atlas sonnet 4.5"
            | "atlas sonnet 4"
            | "atlas sonnet 3.7"
            | "atlas sonnet 3.5"
            | "atlas-sonnet-4"
            | "atlas-sonnet-4-thinking"
            | "atlas-sonnet-3-7"
            | "atlas-sonnet-3-7-thinking"
            | "atlas-sonnet-4-5-thinking"
    )
}

pub(crate) async fn backup_system_prompts(
    paths: &AppPaths,
    client: &OpenWebUiClient,
    model_ids: &[String],
) -> Result<usize> {
    if !model_ids.is_empty() {
        fs::create_dir_all(&paths.backup_dir).with_context(|| {
            format!(
                "failed to create backup directory {}",
                paths.backup_dir.display()
            )
        })?;
    }
    let mut count = 0;
    for model_id in model_ids {
        let model = get_model_by_id(client, model_id)
            .await?
            .ok_or_else(|| anyhow!("obsolete model {model_id} missing during backup"))?;
        let system_prompt = model
            .get("params")
            .and_then(Value::as_object)
            .and_then(|params| params.get("system"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if system_prompt.trim().is_empty() {
            continue;
        }
        let timestamp = Local::now().format("%Y%m%d_%H%M%S").to_string();
        let file_name = paths
            .backup_dir
            .join(format!("{model_id}_{timestamp}_system_prompt.md"));
        fs::write(
            &file_name,
            format!(
                "# System Prompt Backup for {model_id}\n# Backed up at: {}\n# Model will be retired during migration\n\n{}",
                Local::now().format("%Y-%m-%dT%H:%M:%S%.6f"),
                system_prompt
            ),
        )
        .with_context(|| format!("failed to backup system prompt for {model_id}"))?;
        count += 1;
    }
    Ok(count)
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct BaseModelSyncCounts {
    pub(crate) updated: usize,
    pub(crate) created: usize,
    pub(crate) unchanged: usize,
}

fn json_contains(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (Value::Object(actual), Value::Object(expected)) => expected.iter().all(|(key, value)| {
            actual
                .get(key)
                .is_some_and(|actual| json_contains(actual, value))
        }),
        (Value::Array(actual), Value::Array(expected)) => actual == expected,
        _ => actual == expected,
    }
}

fn durable_model_readback_projection(model: &Value) -> Value {
    const DURABLE_FIELDS: [&str; 7] = [
        "id",
        "base_model_id",
        "name",
        "meta",
        "params",
        "access_control",
        "is_active",
    ];
    let mut projected = Map::new();
    for field in DURABLE_FIELDS {
        if let Some(value) = model.get(field) {
            projected.insert(field.to_string(), value.clone());
        }
    }
    Value::Object(projected)
}

async fn verify_model_payload_readback(
    client: &OpenWebUiClient,
    model_id: &str,
    expected: &Value,
    user_id: &str,
) -> Result<()> {
    let actual = get_model_by_id(client, model_id)
        .await?
        .ok_or_else(|| anyhow!("model {model_id} missing after mutation"))?;
    let actual = sanitize_model_for_update(&actual, user_id);
    let actual = durable_model_readback_projection(&actual);
    let expected = durable_model_readback_projection(expected);
    if !json_contains(&actual, &expected) {
        return Err(anyhow!(
            "model {model_id} mutation failed canonical readback"
        ));
    }
    Ok(())
}

pub(crate) async fn configure_base_models(
    paths: &AppPaths,
    client: &OpenWebUiClient,
    user_id: &str,
    models_from_config: &[ConfiguredBaseModel],
    _existing_base_model_ids: &[String],
    base_system_prompt: &str,
    core_tool_ids: &[String],
    target_default_model: &str,
) -> Result<BaseModelSyncCounts> {
    let mut counts = BaseModelSyncCounts::default();
    for configured_model in models_from_config {
        let model_id = configured_model.id.as_str();
        if let Some(mut model) = get_model_by_id(client, model_id).await? {
            let current_sanitized = sanitize_model_for_update(&model, user_id);
            canonicalize_base_model_payload(
                paths,
                &mut model,
                configured_model,
                base_system_prompt,
                core_tool_ids,
                target_default_model,
            );
            let sanitized = sanitize_model_for_update(&model, user_id);
            if sanitized == current_sanitized {
                counts.unchanged += 1;
                continue;
            }
            if !update_model_by_id(client, model_id, &sanitized).await? {
                return Err(anyhow!(
                    "Open WebUI rejected base model update for {model_id}"
                ));
            }
            verify_model_payload_readback(client, model_id, &sanitized, user_id).await?;
            counts.updated += 1;
            continue;
        }

        let mut payload = json!({});
        canonicalize_base_model_payload(
            paths,
            &mut payload,
            configured_model,
            base_system_prompt,
            core_tool_ids,
            target_default_model,
        );
        if !create_model(client, &payload).await? {
            return Err(anyhow!(
                "Open WebUI rejected base model creation for {model_id}"
            ));
        }
        let expected = sanitize_model_for_update(&payload, user_id);
        verify_model_payload_readback(client, model_id, &expected, user_id).await?;
        counts.created += 1;
    }
    Ok(counts)
}

pub(crate) fn canonicalize_base_model_payload(
    paths: &AppPaths,
    model: &mut Value,
    configured_model: &ConfiguredBaseModel,
    base_system_prompt: &str,
    core_tool_ids: &[String],
    target_default_model: &str,
) {
    if !model.is_object() {
        *model = json!({});
    }
    let model_id = configured_model.id.as_str();
    let meta = ensure_object_field(model, "meta");
    meta.insert(
        "profile_image_url".to_string(),
        json!(get_model_icon_data(paths, configured_model)),
    );
    meta.insert("description".to_string(), Value::Null);
    meta.insert(
        "capabilities".to_string(),
        json!({
            "vision": true,
            "file_upload": true,
            "web_search": true,
            "image_generation": true,
            "code_interpreter": false,
            "citations": true
        }),
    );
    meta.insert("suggestion_prompts".to_string(), Value::Null);
    meta.insert("tags".to_string(), json!([]));
    meta.insert("toolIds".to_string(), json!(core_tool_ids));
    meta.insert(
        "disabled".to_string(),
        Value::Bool(configured_model.disabled),
    );
    if let Some(reason) = configured_model.disabled_reason.as_ref() {
        meta.insert("disabled_reason".to_string(), Value::String(reason.clone()));
    } else {
        meta.remove("disabled_reason");
    }

    let params = ensure_object_field(model, "params");
    params.insert("system".to_string(), json!(base_system_prompt));

    if let Some(object) = model.as_object_mut() {
        object.insert("id".to_string(), json!(model_id));
        object.insert("base_model_id".to_string(), Value::Null);
        object.insert("name".to_string(), json!(model_id));
        object.insert("object".to_string(), json!("model"));
        object.insert("created".to_string(), json!(1677610602));
        object.insert("owned_by".to_string(), json!("openai"));
        object.insert("connection_type".to_string(), json!("external"));
        object.insert(
            "openai".to_string(),
            json!({
                "id": model_id,
                "object": "model",
                "created": 1677610602,
                "owned_by": "openai",
                "connection_type": "external"
            }),
        );
        object.insert("urlIdx".to_string(), json!(0));
        object.insert("access_control".to_string(), Value::Null);
        object.insert("is_active".to_string(), Value::Bool(true));
        object.insert(
            "is_default".to_string(),
            Value::Bool(model_id == target_default_model),
        );
    }
}

fn canonical_model_migration_key(model_id: &str) -> String {
    let mut normalized = model_id.trim().to_ascii_lowercase();
    if let Some(value) = normalized.strip_suffix(":latest") {
        normalized = value.trim_end().to_string();
    }
    for prefix in [
        "openai/responses/",
        "portico-openai/",
        "openai/",
        "responses/",
    ] {
        if let Some(value) = normalized.strip_prefix(prefix) {
            normalized = value.trim_start().to_string();
            break;
        }
    }

    let mut canonical = String::with_capacity(normalized.len());
    let mut separator_pending = false;
    for character in normalized.chars() {
        if character.is_ascii_whitespace() || character == '_' {
            separator_pending = true;
            continue;
        }
        if separator_pending && !canonical.is_empty() && !canonical.ends_with('-') {
            canonical.push('-');
        }
        separator_pending = false;
        canonical.push(character);
    }
    canonical.trim_matches('-').to_string()
}

pub(crate) fn is_obsolete_managed_model_id(model_id: &str) -> bool {
    let normalized = canonical_model_migration_key(model_id);
    obsolete_managed_model_ids()
        .iter()
        .any(|candidate| normalized == canonical_model_migration_key(candidate))
}
pub(crate) fn obsolete_managed_model_ids() -> &'static [&'static str] {
    &[
        "Atlas Opus 4.6",
        "Atlas Opus 4.7",
        "GPT-5.4",
        "GPT-5.4 pro",
        "GPT-4.1",
        "GPT-4.1 mini",
        "GPT-4.1 nano",
    ]
}

fn deprecated_base_model_migration_map() -> BTreeMap<String, &'static str> {
    [
        ("atlas-sonnet-4", "Atlas Sonnet 5"),
        ("atlas-sonnet-4-thinking", "Atlas Sonnet 5"),
        ("atlas-sonnet-3-7", "Atlas Sonnet 5"),
        ("atlas-sonnet-3-7-thinking", "Atlas Sonnet 5"),
        ("atlas-sonnet-4-5-thinking", "Atlas Sonnet 5"),
        ("atlas-opus-4-thinking", "Atlas Opus 5"),
        ("atlas-opus-4", "Atlas Opus 5"),
        ("atlas-haiku-3-5", "Atlas Haiku 4.5"),
        ("atlas-opus-4-1-thinking", "Atlas Opus 5"),
        ("atlas-opus-4-5-thinking", "Atlas Opus 5"),
        ("Atlas Sonnet 3.5", "Atlas Sonnet 5"),
        ("Atlas Sonnet 4.5", "Atlas Sonnet 5"),
        // Sonnet 4.6 remains fully available in the catalog/picker; agents and
        // scheduled tasks pointing at it are auto-upgraded to Sonnet 5 (PORTICO-213).
        ("Atlas Sonnet 4.6", "Atlas Sonnet 5"),
        ("Atlas Haiku 3.5", "Atlas Haiku 4.5"),
        ("Atlas Opus 4.1", "Atlas Opus 5"),
        ("Atlas Opus 4.5", "Atlas Opus 5"),
        // Opus 4.6 and 4.7 are retired from the catalog (Opus 4.8 remains
        // fully available); anything still referencing them migrates to
        // Atlas Opus 5. The dash-slug forms cover internal-id references —
        // canonical_model_migration_key does not fold "4.6" into "4-6".
        ("Atlas Opus 4.6", "Atlas Opus 5"),
        ("Atlas Opus 4.7", "Atlas Opus 5"),
        ("atlas-opus-4-6", "Atlas Opus 5"),
        ("atlas-opus-4-7", "Atlas Opus 5"),
        ("gpt-5", "GPT-5.6 Sol"),
        ("gpt-5.1", "GPT-5.6 Sol"),
        ("gpt-5.2", "GPT-5.6 Sol"),
        ("gpt-5.4", "GPT-5.6 Sol"),
        ("gpt-5-mini", "GPT-5.6 Terra"),
        ("gpt-5-nano", "GPT-5.6 Luna"),
        ("gpt-5-pro", "GPT-5.6 Sol Pro"),
        ("gpt-5.2-pro", "GPT-5.6 Sol Pro"),
        ("gpt-5.4-pro", "GPT-5.6 Sol Pro"),
        ("gpt-4.1", "GPT-5.6 Sol"),
        ("gpt-4.1-mini", "GPT-5.6 Terra"),
        ("gpt-4.1-nano", "GPT-5.6 Luna"),
        ("gpt-4o", "GPT-5.6 Sol"),
        ("gpt-4o-mini", "GPT-5.6 Terra"),
        ("GPT-5", "GPT-5.6 Sol"),
        ("GPT-5.1", "GPT-5.6 Sol"),
        ("GPT-5.2", "GPT-5.6 Sol"),
        ("GPT-5.4", "GPT-5.6 Sol"),
        ("GPT-5 mini", "GPT-5.6 Terra"),
        ("GPT-5 nano", "GPT-5.6 Luna"),
        ("GPT-5 pro", "GPT-5.6 Sol Pro"),
        ("GPT-5.2 pro", "GPT-5.6 Sol Pro"),
        ("GPT-5.4 pro", "GPT-5.6 Sol Pro"),
        ("GPT-4.1", "GPT-5.6 Sol"),
        ("GPT-4.1 mini", "GPT-5.6 Terra"),
        ("GPT-4.1 nano", "GPT-5.6 Luna"),
        ("GPT-4o", "GPT-5.6 Sol"),
        ("GPT-4o mini", "GPT-5.6 Terra"),
        // Gemini 3.5 Flash and Gemini 3.1 Flash-Lite remain fully available
        // in the catalog/picker; agents and scheduled tasks pointing at them
        // are auto-upgraded once to their successors (same migrate-without-
        // retire semantics as Atlas Sonnet 4.6 above, PORTICO-213). No dash-slug
        // entries needed: canonical_model_migration_key keeps version dots,
        // so these display names already canonicalize to "gemini-3.5-flash" /
        // "gemini-3.1-flash-lite" — identical to the internal ids.
        ("Gemini 3.5 Flash", "Gemini 3.6 Flash"),
        ("Gemini 3.1 Flash-Lite", "Gemini 3.5 Flash-Lite"),
    ]
    .into_iter()
    .map(|(source, target)| (canonical_model_migration_key(source), target))
    .collect()
}

pub(crate) fn deprecated_base_model_migration_target(model_id: &str) -> Option<&'static str> {
    let migration_map = deprecated_base_model_migration_map();
    migration_map
        .get(&canonical_model_migration_key(model_id))
        .copied()
}

fn retired_model_migration_target(model_id: &str) -> Option<&'static str> {
    is_obsolete_managed_model_id(model_id)
        .then(|| deprecated_base_model_migration_target(model_id))
        .flatten()
}

pub(crate) fn parse_base_model_ref(model: &Value) -> Result<Option<String>> {
    fn parse_field(value: Option<&Value>, field: &str) -> Result<Option<String>> {
        match value {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(value)) if !value.trim().is_empty() => Ok(Some(value.clone())),
            Some(_) => Err(anyhow!("{field} must be a non-empty string or null")),
        }
    }

    let top = parse_field(model.get("base_model_id"), "base_model_id")?;
    let nested_value = match model.get("info") {
        None | Some(Value::Null) => None,
        Some(Value::Object(info)) => info.get("base_model_id"),
        Some(_) => return Err(anyhow!("info must be an object or null")),
    };
    let nested = parse_field(nested_value, "info.base_model_id")?;
    if let (Some(top), Some(nested)) = (&top, &nested) {
        if canonical_model_migration_key(top) != canonical_model_migration_key(nested) {
            return Err(anyhow!(
                "conflicting base model references: base_model_id={top}, info.base_model_id={nested}"
            ));
        }
    }
    Ok(top.or(nested))
}

pub(crate) async fn migrate_user_models(client: &OpenWebUiClient, user_id: &str) -> Result<usize> {
    let payload = client.get_json("/api/v1/models", None).await?;
    let models = unwrap_models_response(&payload);
    let mut migrations = Vec::new();
    for model in &models {
        let Some(base_model_id) = parse_base_model_ref(model)? else {
            continue;
        };
        let Some(new_base) = deprecated_base_model_migration_target(&base_model_id) else {
            continue;
        };
        let model_id = model
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| anyhow!("derived model with deprecated base is missing id"))?;
        migrations.push((model_id.to_string(), base_model_id, new_base));
    }

    let mut migrated = 0;
    for (model_id, old_base, new_base) in migrations {
        let Some(mut user_model) = get_model_by_id(client, &model_id).await? else {
            return Err(anyhow!(
                "derived model {model_id} disappeared during migration"
            ));
        };
        let full_base = parse_base_model_ref(&user_model)?
            .ok_or_else(|| anyhow!("derived model {model_id} lost its base model reference"))?;
        if canonical_model_migration_key(&full_base) != canonical_model_migration_key(&old_base) {
            return Err(anyhow!(
                "derived model {model_id} changed base during migration ({old_base} -> {full_base})"
            ));
        }
        let object = user_model
            .as_object_mut()
            .ok_or_else(|| anyhow!("derived model {model_id} is not an object"))?;
        object.insert("base_model_id".to_string(), json!(new_base));
        if let Some(Value::Object(info)) = object.get_mut("info") {
            info.insert("base_model_id".to_string(), json!(new_base));
        }
        let sanitized = sanitize_model_for_update(&user_model, user_id);
        if !update_model_by_id(client, &model_id, &sanitized).await? {
            return Err(anyhow!(
                "Open WebUI rejected migration for derived model {model_id}"
            ));
        }
        let Some(updated) = get_model_by_id(client, &model_id).await? else {
            return Err(anyhow!("derived model {model_id} missing after migration"));
        };
        if parse_base_model_ref(&updated)?
            .as_deref()
            .is_none_or(|updated_base| {
                canonical_model_migration_key(updated_base)
                    != canonical_model_migration_key(new_base)
            })
        {
            return Err(anyhow!(
                "derived model {model_id} migration failed readback"
            ));
        }
        migrated += 1;
    }
    Ok(migrated)
}

pub(crate) fn scheduled_tasks_need_model_migration(paths: &AppPaths) -> Result<bool> {
    let tasks_dir = paths.app_support_dir.join("scheduled_tasks");
    if !tasks_dir.exists() {
        return Ok(false);
    }
    for entry in fs::read_dir(&tasks_dir)
        .with_context(|| format!("failed to list {}", tasks_dir.display()))?
    {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json")
            || !entry.file_type()?.is_file()
        {
            continue;
        }
        let task: Value = serde_json::from_slice(&fs::read(&path)?)
            .with_context(|| format!("invalid scheduled task JSON {}", path.display()))?;
        let object = task
            .as_object()
            .ok_or_else(|| anyhow!("scheduled task {} is not an object", path.display()))?;
        if object
            .get("model_id")
            .and_then(Value::as_str)
            .and_then(retired_model_migration_target)
            .is_some()
        {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(crate) fn write_json_atomic_cas(
    path: &Path,
    expected_digest: &[u8],
    value: &Value,
) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("JSON record has no parent directory"))?;
    let _lock = acquire_health_status_write_lock(path)?;
    let current = fs::read(path).with_context(|| format!("failed to read {}", path.display()))?;
    if Sha256::digest(&current).as_slice() != expected_digest {
        return Err(anyhow!(
            "stale scheduled task revision for {}",
            path.display()
        ));
    }
    let temporary = parent.join(format!(
        ".{}.{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("record"),
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let payload = serde_json::to_vec_pretty(value).context("failed to encode JSON record")?;
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .with_context(|| format!("failed to open {}", temporary.display()))?;
    file.write_all(&payload)
        .with_context(|| format!("failed to write {}", temporary.display()))?;
    file.sync_all()
        .with_context(|| format!("failed to sync {}", temporary.display()))?;
    let current =
        fs::read(path).with_context(|| format!("failed to re-read {}", path.display()))?;
    if Sha256::digest(&current).as_slice() != expected_digest {
        let _ = fs::remove_file(&temporary);
        return Err(anyhow!(
            "scheduled task changed before publish: {}",
            path.display()
        ));
    }
    fs::rename(&temporary, path)
        .with_context(|| format!("failed to publish {}", path.display()))?;
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .with_context(|| format!("failed to sync {}", parent.display()))?;
    Ok(())
}

pub(crate) fn migrate_scheduled_task_models(paths: &AppPaths) -> Result<usize> {
    let tasks_dir = paths.app_support_dir.join("scheduled_tasks");
    if !tasks_dir.exists() {
        return Ok(0);
    }

    let mut task_paths = Vec::new();
    for entry in fs::read_dir(&tasks_dir)
        .with_context(|| format!("failed to list {}", tasks_dir.display()))?
    {
        let entry = entry.with_context(|| {
            format!(
                "failed to read scheduled task entry in {}",
                tasks_dir.display()
            )
        })?;
        let path = entry.path();
        let is_json = path.extension().and_then(|value| value.to_str()) == Some("json");
        let is_file = entry
            .file_type()
            .with_context(|| format!("failed to inspect {}", path.display()))?
            .is_file();
        if is_json && is_file {
            task_paths.push(path);
        }
    }
    task_paths.sort();

    let updated_at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let mut migrated = 0;
    for task_path in task_paths {
        let raw = fs::read_to_string(&task_path)
            .with_context(|| format!("failed to read scheduled task {}", task_path.display()))?;
        let expected_digest = Sha256::digest(raw.as_bytes()).to_vec();
        let mut task_json = serde_json::from_str::<Value>(&raw)
            .with_context(|| format!("invalid scheduled task JSON {}", task_path.display()))?;
        let object = task_json.as_object_mut().ok_or_else(|| {
            anyhow!(
                "scheduled task {} is not a JSON object",
                task_path.display()
            )
        })?;
        let Some(model_id) = object.get("model_id").and_then(Value::as_str) else {
            continue;
        };
        let Some(new_model_id) = deprecated_base_model_migration_target(model_id) else {
            continue;
        };

        object.insert("model_id".to_string(), json!(new_model_id));
        object.insert("updated_at".to_string(), json!(updated_at.clone()));
        write_json_atomic_cas(&task_path, &expected_digest, &task_json)?;
        let readback: Value = serde_json::from_slice(&fs::read(&task_path)?)?;
        if readback != task_json {
            return Err(anyhow!(
                "scheduled task migration failed readback for {}",
                task_path.display()
            ));
        }
        migrated += 1;
    }

    Ok(migrated)
}

pub(crate) async fn apply_tool_id_migration(
    paths: &AppPaths,
    client: &OpenWebUiClient,
    user_id: &str,
    migration_mapping: &BTreeMap<String, Vec<String>>,
    migration_data: &mut Value,
) -> Result<usize> {
    let mut migrated = 0;
    let mut details = Vec::<Value>::new();
    for (model_id, new_tool_ids) in migration_mapping {
        let Some(mut model) = get_model_by_id(client, model_id).await? else {
            return Err(anyhow!("tool migration model {model_id} disappeared"));
        };
        let old_tool_ids = model
            .get("meta")
            .and_then(Value::as_object)
            .and_then(|meta| meta.get("toolIds"))
            .cloned()
            .unwrap_or_else(|| json!([]));
        let meta = ensure_object_field(&mut model, "meta");
        meta.insert("toolIds".to_string(), json!(new_tool_ids));
        let sanitized = sanitize_model_for_update(&model, user_id);
        if !update_model_by_id(client, model_id, &sanitized).await? {
            return Err(anyhow!("Open WebUI rejected tool migration for {model_id}"));
        }
        let readback = get_model_by_id(client, model_id)
            .await?
            .ok_or_else(|| anyhow!("tool migration model {model_id} missing after update"))?;
        let readback_tool_ids = readback
            .get("meta")
            .and_then(Value::as_object)
            .and_then(|meta| meta.get("toolIds"));
        if readback_tool_ids != Some(&json!(new_tool_ids)) {
            return Err(anyhow!("tool migration failed readback for {model_id}"));
        }
        migrated += 1;
        details.push(json!({
            "model_id": model_id,
            "model_name": model.get("name").and_then(Value::as_str).unwrap_or(model_id),
            "old_ids": old_tool_ids,
            "new_ids": new_tool_ids,
            "status": "SUCCESS",
        }));
    }
    migration_data["models_migrated"] = json!(details);
    migration_data["models_skipped"] = json!([]);
    if !migration_data["models_migrated"]
        .as_array()
        .unwrap_or(&Vec::new())
        .is_empty()
    {
        let _ = generate_migration_report(paths, migration_data)?;
    }
    Ok(migrated)
}

pub(crate) async fn audit_model_sync_referential_integrity(
    client: &OpenWebUiClient,
    paths: &AppPaths,
    configured_model_ids: &[String],
    retired_model_ids: &[String],
    target_default_model: &str,
) -> Result<()> {
    let inventory = load_owui_model_inventory(client, configured_model_ids).await?;
    if !inventory.missing_configured_model_ids.is_empty() {
        return Err(anyhow!(
            "configured models missing after reconciliation: {}",
            inventory.missing_configured_model_ids.join(", ")
        ));
    }
    if !inventory
        .configured_model_ids_missing_from_picker_base_models
        .is_empty()
    {
        return Err(anyhow!(
            "configured models are not picker-visible base models after reconciliation: {}",
            inventory
                .configured_model_ids_missing_from_picker_base_models
                .join(", ")
        ));
    }
    if inventory.deprecated_reference_count != 0 {
        return Err(anyhow!(
            "{} derived models still reference deprecated bases",
            inventory.deprecated_reference_count
        ));
    }
    if scheduled_tasks_need_model_migration(paths)? {
        return Err(anyhow!(
            "scheduled tasks still reference deprecated model IDs"
        ));
    }

    let settings = client
        .get_json("/api/v1/users/user/settings", None)
        .await
        .context("failed to read back user settings after model reconciliation")?;
    let current_default_model = current_default_model_from_settings(&settings)
        .ok_or_else(|| anyhow!("user settings have no default model after reconciliation"))?;
    if current_default_model != target_default_model {
        return Err(anyhow!(
            "default model failed reconciliation readback (expected {target_default_model}, got {current_default_model})"
        ));
    }

    for model_id in retired_model_ids {
        if !is_obsolete_managed_model_id(model_id) {
            return Err(anyhow!(
                "refusing to audit unmanaged retired model {model_id}"
            ));
        }
        let readback = get_model_by_id(client, model_id)
            .await?
            .ok_or_else(|| anyhow!("retired model {model_id} missing during final audit"))?;
        if !obsolete_model_retirement_matches(&readback) {
            return Err(anyhow!(
                "retired model {model_id} failed final referential audit"
            ));
        }
    }

    Ok(())
}
pub(crate) fn obsolete_model_retirement_matches(model: &Value) -> bool {
    model_id(model)
        .as_deref()
        .is_some_and(is_obsolete_managed_model_id)
        && model
            .get("meta")
            .and_then(Value::as_object)
            .and_then(|meta| meta.get("disabled"))
            .and_then(Value::as_bool)
            == Some(true)
        && model
            .get("meta")
            .and_then(Value::as_object)
            .and_then(|meta| meta.get("hidden"))
            .and_then(Value::as_bool)
            == Some(true)
        && model.get("is_active").and_then(Value::as_bool) == Some(false)
}
pub(crate) async fn disable_obsolete_models(
    client: &OpenWebUiClient,
    user_id: &str,
    model_ids: &[String],
) -> Result<usize> {
    let mut disabled = 0;
    for model_id in model_ids {
        if !is_obsolete_managed_model_id(model_id) {
            return Err(anyhow!("refusing to retire unmanaged model {model_id}"));
        }
        let Some(mut model) = get_model_by_id(client, model_id).await? else {
            return Err(anyhow!(
                "obsolete model {model_id} disappeared before retirement"
            ));
        };
        if !model.is_object() {
            return Err(anyhow!("obsolete model {model_id} is not an object"));
        }
        let disabled_reason = retired_model_migration_target(model_id)
            .map(|target| format!("Replaced by {target}"))
            .unwrap_or_else(|| "This model has been retired".to_string());
        let meta = ensure_object_field(&mut model, "meta");
        meta.insert("disabled".to_string(), Value::Bool(true));
        meta.insert("hidden".to_string(), Value::Bool(true));
        meta.insert(
            "disabled_reason".to_string(),
            Value::String(disabled_reason),
        );
        let object = model
            .as_object_mut()
            .ok_or_else(|| anyhow!("obsolete model {model_id} is not an object"))?;
        object.insert("is_active".to_string(), Value::Bool(false));
        object.insert("is_default".to_string(), Value::Bool(false));
        let sanitized = sanitize_model_for_update(&model, user_id);
        if !update_model_by_id(client, model_id, &sanitized).await? {
            return Err(anyhow!("Open WebUI rejected retirement for {model_id}"));
        }
        let Some(readback) = get_model_by_id(client, model_id).await? else {
            return Err(anyhow!(
                "obsolete model {model_id} missing after retirement"
            ));
        };
        if !obsolete_model_retirement_matches(&readback) {
            return Err(anyhow!(
                "obsolete model {model_id} retirement failed readback"
            ));
        }
        disabled += 1;
    }
    Ok(disabled)
}

#[cfg(test)]
pub(crate) async fn delete_obsolete_models(
    client: &OpenWebUiClient,
    model_ids: &[String],
) -> Result<usize> {
    let mut deleted = 0;
    for model_id in model_ids {
        if delete_model_with_fallbacks(client, model_id).await? {
            deleted += 1;
        }
    }
    Ok(deleted)
}

pub(crate) async fn fetch_full_model(
    client: &OpenWebUiClient,
    model_id: &str,
) -> Result<Option<Value>> {
    let encoded_id = utf8_percent_encode(model_id, NON_ALPHANUMERIC).to_string();
    let endpoints = vec![
        (
            "/api/v1/models/model".to_string(),
            Some(vec![("id", model_id.to_string())]),
        ),
        (format!("/api/models/{encoded_id}"), None),
        (format!("/api/v1/models/{encoded_id}"), None),
    ];
    for (path, params) in endpoints {
        let params = params.as_deref();
        if let Ok(payload) = client.get_json(&path, params).await {
            return Ok(Some(payload));
        }
    }
    Ok(None)
}

pub(crate) fn ensure_object_field<'a>(
    value: &'a mut Value,
    key: &str,
) -> &'a mut Map<String, Value> {
    let object = value
        .as_object_mut()
        .expect("value must be a JSON object for mutation");
    if !object.get(key).is_some_and(Value::is_object) {
        object.insert(key.to_string(), Value::Object(Map::new()));
    }
    object
        .get_mut(key)
        .and_then(Value::as_object_mut)
        .expect("field must be an object")
}

fn load_previous_discovered_server_ids(paths: &AppPaths) -> BTreeSet<String> {
    let payload = match fs::read_to_string(paths.health_status_dir.join("health_status.json")) {
        Ok(payload) => payload,
        Err(_) => return BTreeSet::new(),
    };
    let json = match serde_json::from_str::<Value>(&payload) {
        Ok(json) => json,
        Err(_) => return BTreeSet::new(),
    };
    json.get("sync_diagnostics")
        .and_then(|value| value.get("discovered_server_ids"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(ToOwned::to_owned)
        .collect()
}

fn compute_preserved_server_ids(
    paths: &AppPaths,
    config: &RuntimeConfig,
    configured_servers: &BTreeMap<String, ServerMetadata>,
    mcp_toggles: &HashMap<String, bool>,
    tool_host_map: &BTreeMap<String, DiscoveredTool>,
    servers_without_tools: &BTreeSet<String>,
    status_probe_details: &BTreeMap<String, StatusProbeDetail>,
    oauth_status: &OAuthStatusPayload,
    log_inspector: &dyn ContainerLogInspector,
) -> BTreeSet<String> {
    load_previous_discovered_server_ids(paths)
        .into_iter()
        .filter(|server_id| !tool_host_map.contains_key(server_id))
        .filter(|server_id| !servers_without_tools.contains(server_id))
        .filter(|server_id| {
            let Some(metadata) = configured_servers.get(server_id) else {
                return false;
            };
            let (enabled, _) = get_server_enablement_state(
                server_id,
                metadata,
                mcp_toggles,
                paths,
                config.oauth_token_max_age_seconds,
            );
            if !enabled || !metadata.is_configured {
                return false;
            }
            let status = status_probe_details
                .get(server_id)
                .map(|detail| {
                    health_status_for_status_probe_server(server_id, metadata, detail, oauth_status)
                })
                .unwrap_or_else(|| {
                    health_status_for_missing_server(
                        server_id,
                        metadata,
                        oauth_status,
                        log_inspector,
                    )
                });
            matches!(
                status.get("status").and_then(Value::as_str),
                Some("starting" | "checking" | "needs_oauth")
            )
        })
        .collect()
}

async fn fetch_existing_tool_server_connections(client: &OpenWebUiClient) -> Result<Vec<Value>> {
    let payload = client
        .get_json("/api/v1/configs/tool_servers", None)
        .await
        .context("failed to read current Open WebUI tool server config")?;
    let Some(connections) = payload
        .get("TOOL_SERVER_CONNECTIONS")
        .and_then(Value::as_array)
    else {
        return Err(anyhow!(
            "Open WebUI tool server config response did not include TOOL_SERVER_CONNECTIONS"
        ));
    };
    Ok(connections.clone())
}

fn tool_server_connection_id(connection: &Value) -> Option<String> {
    connection
        .get("info")
        .and_then(Value::as_object)
        .and_then(|info| info.get("id"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn build_discovered_tool_server_connection(
    config: &RuntimeConfig,
    tool_name: &str,
    host_info: &DiscoveredTool,
) -> Value {
    json!({
        "url": format!("{}/{tool_name}", get_proxy_base_url_for_host(config, &host_info.host)),
        "path": "openapi.json",
        "auth_type": "bearer",
        "key": "",
        "config": {
            "enable": true,
            "access_control": Value::Null
        },
        "info": {
            "id": tool_name,
            "name": title_case_tool_name(tool_name),
            "description": ""
        }
    })
}

fn build_tool_server_connections(
    config: &RuntimeConfig,
    tool_host_map: &BTreeMap<String, DiscoveredTool>,
    existing_connections: &[Value],
    preserved_server_ids: &BTreeSet<String>,
) -> Vec<Value> {
    let mut connections = Vec::new();
    let mut seen_ids = BTreeSet::new();

    for (tool_name, host_info) in tool_host_map {
        connections.push(build_discovered_tool_server_connection(
            config, tool_name, host_info,
        ));
        seen_ids.insert(tool_name.clone());
    }

    for connection in existing_connections {
        let Some(server_id) = tool_server_connection_id(connection) else {
            continue;
        };
        if !preserved_server_ids.contains(&server_id) || seen_ids.contains(&server_id) {
            continue;
        }
        connections.push(connection.clone());
        seen_ids.insert(server_id);
    }

    connections
}

pub(crate) fn title_case_tool_name(name: &str) -> String {
    name.replace(['-', '_'], " ")
        .split_whitespace()
        .map(|word| {
            if matches!(
                word.to_ascii_lowercase().as_str(),
                "lm" | "mcp" | "api" | "url" | "ui" | "ai" | "id" | "vm"
            ) {
                return word.to_ascii_uppercase();
            }
            let mut chars = word.chars();
            let first = chars
                .next()
                .expect("split_whitespace only yields non-empty segments");
            format!(
                "{}{}",
                first.to_ascii_uppercase(),
                chars.as_str().to_ascii_lowercase()
            )
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub(crate) fn health_status_for_status_probe_server(
    server_id: &str,
    metadata: &ServerMetadata,
    detail: &StatusProbeDetail,
    oauth_status: &OAuthStatusPayload,
) -> Value {
    let (oauth_state, oauth_error) = lookup_oauth_status_missing(server_id, oauth_status);
    let (status, error) = match oauth_state.as_deref() {
        Some("timeout") => (
            "timeout",
            oauth_error.unwrap_or_else(|| "OAuth authorization timeout".to_string()),
        ),
        Some("pending" | "checking") => ("checking", String::new()),
        Some("active" | "waiting_callback") => (
            "needs_oauth",
            "Server configured but waiting for OAuth authorization".to_string(),
        ),
        Some("failed") => (
            "failed",
            oauth_error.unwrap_or_else(|| "OAuth failed".to_string()),
        ),
        _ if !metadata.is_configured => (
            "not_configured",
            metadata.config_error.clone().unwrap_or_else(|| {
                "Server not configured (missing or placeholder environment variables)".to_string()
            }),
        ),
        _ if detail.healthy && detail.tools_count > 0 => ("healthy", String::new()),
        _ if detail.readiness_phase == "failed" || detail.error.is_some() => (
            "failed",
            detail.error.clone().unwrap_or_else(|| {
                "MCP server failed to initialize after Host MCPO accepted the server".to_string()
            }),
        ),
        _ => ("starting", "Server is still initializing".to_string()),
    };

    json!({
        "status": status,
        "deployment": metadata.deployment_type,
        "host": detail.host.clone(),
        "port": detail.port.clone(),
        "error": if error.is_empty() { Value::Null } else { json!(error) },
        "oauth_state": oauth_state,
        "configured": metadata.is_configured,
        "running": detail.healthy || detail.readiness_phase != "not_connected",
        "readiness_phase": detail.readiness_phase.clone(),
        "tools_count": detail.tools_count,
        "provider_warmup": detail.provider_warmup.clone(),
    })
}

pub(crate) fn health_status_for_no_tools_server(
    server_id: &str,
    metadata: &ServerMetadata,
    oauth_status: &OAuthStatusPayload,
    _log_inspector: &dyn ContainerLogInspector,
) -> Value {
    let (oauth_state, oauth_error) = lookup_oauth_status_no_tools(server_id, oauth_status);
    match oauth_state.as_deref() {
        Some("active" | "waiting_callback" | "pending" | "checking") => json!({
            "status": "needs_oauth",
            "deployment": metadata.deployment_type,
            "host": Value::Null,
            "port": Value::Null,
            "error": "Server waiting for OAuth authorization",
            "oauth_state": oauth_state,
            "configured": true,
            "running": false,
            "no_tools": true,
        }),
        Some("timeout") => json!({
            "status": "timeout",
            "deployment": metadata.deployment_type,
            "host": Value::Null,
            "port": Value::Null,
            "error": oauth_error.unwrap_or_else(|| "OAuth authorization timeout".to_string()),
            "oauth_state": oauth_state,
            "configured": true,
            "running": false,
            "no_tools": true,
        }),
        Some("failed") => json!({
            "status": "failed",
            "deployment": metadata.deployment_type,
            "host": Value::Null,
            "port": Value::Null,
            "error": oauth_error.unwrap_or_else(|| "OAuth authorization failed".to_string()),
            "oauth_state": oauth_state,
            "configured": true,
            "running": false,
            "no_tools": true,
        }),
        _ => {
            let error = if metadata.deployment_type == "host" {
                "Host MCP server started but exposed no tools (MCP server failed to initialize)"
            } else {
                "Server started but exposed no tools (MCP server failed to initialize)"
            };
            json!({
                "status": "failed",
                "deployment": metadata.deployment_type,
                "host": Value::Null,
                "port": Value::Null,
                "error": error,
                "oauth_state": oauth_state,
                "configured": true,
                "running": false,
                "no_tools": true,
            })
        }
    }
}

pub(crate) fn health_status_for_running_server(
    server_id: &str,
    _metadata: &ServerMetadata,
    host_info: &DiscoveredTool,
    oauth_status: &OAuthStatusPayload,
    config: &RuntimeConfig,
) -> Value {
    let (oauth_state, oauth_error) = lookup_oauth_status_running(server_id, oauth_status);
    let status = match oauth_state.as_deref() {
        Some("failed") => "failed",
        Some("timeout") => "timeout",
        Some("pending" | "checking") => "checking",
        Some("active" | "waiting_callback") => "needs_oauth",
        _ => "healthy",
    };
    let error = match status {
        "failed" | "timeout" => oauth_error,
        _ => None,
    };
    let deployment = if host_info.host == config.mcpo_core_host {
        "core"
    } else if host_info.host == config.mcpo_regular_host {
        "docker"
    } else if host_info.host == config.host_mcpo_host {
        "host"
    } else {
        "unknown"
    };
    json!({
        "status": status,
        "deployment": deployment,
        "host": host_info.host,
        "port": host_info.port,
        "error": error,
        "oauth_state": oauth_state,
        "configured": true,
    })
}

pub(crate) fn health_status_for_missing_server(
    server_id: &str,
    metadata: &ServerMetadata,
    oauth_status: &OAuthStatusPayload,
    log_inspector: &dyn ContainerLogInspector,
) -> Value {
    let (oauth_state, oauth_error) = lookup_oauth_status_missing(server_id, oauth_status);
    let (status, error) = match oauth_state.as_deref() {
        Some("timeout") => (
            "timeout",
            oauth_error.unwrap_or_else(|| "OAuth authorization timeout".to_string()),
        ),
        Some("pending" | "checking") => ("checking", String::new()),
        Some("active" | "waiting_callback") => (
            "needs_oauth",
            "Server configured but waiting for OAuth authorization".to_string(),
        ),
        Some("failed") => (
            "failed",
            oauth_error.unwrap_or_else(|| "OAuth failed".to_string()),
        ),
        _ if !metadata.is_configured => (
            "not_configured",
            metadata.config_error.clone().unwrap_or_else(|| {
                "Server not configured (missing or placeholder environment variables)".to_string()
            }),
        ),
        _ if metadata.deployment_type == "host" => (
            "failed",
            "Host MCP server is not running - check Host MCPO logs for startup errors".to_string(),
        ),
        _ => {
            let container_name = format!("mcpo-{server_id}");
            if log_inspector.has_errors(&container_name, 100) {
                (
                    "failed",
                    "Server failed to start - check logs for errors".to_string(),
                )
            } else {
                ("starting", "Server is still initializing".to_string())
            }
        }
    };
    json!({
        "status": status,
        "deployment": metadata.deployment_type,
        "host": Value::Null,
        "port": Value::Null,
        "error": if error.is_empty() { Value::Null } else { json!(error) },
        "oauth_state": oauth_state,
        "configured": metadata.is_configured,
        "running": false,
    })
}

pub(crate) fn lookup_oauth_status_no_tools(
    server_id: &str,
    payload: &OAuthStatusPayload,
) -> (Option<String>, Option<String>) {
    if let Some(current) = payload.current.as_ref() {
        if current
            .get("server_name")
            .and_then(Value::as_str)
            .is_some_and(|name| name == server_id)
        {
            return (
                current
                    .get("state")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                current
                    .get("error_message")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
            );
        }
    }
    for entry in &payload.active {
        if entry
            .get("server_name")
            .and_then(Value::as_str)
            .is_some_and(|name| name == server_id)
        {
            return (
                entry
                    .get("state")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                entry
                    .get("error_message")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
            );
        }
    }
    for entry in &payload.pending {
        if entry
            .get("server_name")
            .and_then(Value::as_str)
            .is_some_and(|name| name == server_id)
        {
            return (Some("pending".to_string()), None);
        }
    }
    for entry in &payload.checking {
        if entry
            .get("server_name")
            .and_then(Value::as_str)
            .is_some_and(|name| name == server_id)
        {
            return (
                Some("checking".to_string()),
                entry
                    .get("error_message")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
            );
        }
    }
    for entry in &payload.waiting_callback {
        if entry
            .get("server_name")
            .and_then(Value::as_str)
            .is_some_and(|name| name == server_id)
        {
            return (Some("waiting_callback".to_string()), None);
        }
    }
    for entry in &payload.timeout {
        if entry
            .get("server_name")
            .and_then(Value::as_str)
            .is_some_and(|name| name == server_id)
        {
            return (
                Some("timeout".to_string()),
                entry
                    .get("error_message")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
            );
        }
    }
    for entry in &payload.failed {
        if entry
            .get("server_name")
            .and_then(Value::as_str)
            .is_some_and(|name| name == server_id)
        {
            return (
                Some("failed".to_string()),
                entry
                    .get("error_message")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
            );
        }
    }
    (None, None)
}

pub(crate) fn lookup_oauth_status_running(
    server_id: &str,
    payload: &OAuthStatusPayload,
) -> (Option<String>, Option<String>) {
    if let Some(current) = payload.current.as_ref() {
        if current
            .get("server_name")
            .and_then(Value::as_str)
            .is_some_and(|name| name == server_id)
        {
            return (
                current
                    .get("state")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                current
                    .get("error_message")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
            );
        }
    }
    for entry in &payload.active {
        if entry
            .get("server_name")
            .and_then(Value::as_str)
            .is_some_and(|name| name == server_id)
        {
            return (
                entry
                    .get("state")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
                    .or_else(|| Some("active".to_string())),
                entry
                    .get("error_message")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
            );
        }
    }
    for entry in &payload.pending {
        if entry
            .get("server_name")
            .and_then(Value::as_str)
            .is_some_and(|name| name == server_id)
        {
            return (Some("pending".to_string()), None);
        }
    }
    for entry in &payload.checking {
        if entry
            .get("server_name")
            .and_then(Value::as_str)
            .is_some_and(|name| name == server_id)
        {
            return (
                Some("checking".to_string()),
                entry
                    .get("error_message")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
            );
        }
    }
    for entry in &payload.waiting_callback {
        if entry
            .get("server_name")
            .and_then(Value::as_str)
            .is_some_and(|name| name == server_id)
        {
            return (Some("waiting_callback".to_string()), None);
        }
    }
    for entry in &payload.timeout {
        if entry
            .get("server_name")
            .and_then(Value::as_str)
            .is_some_and(|name| name == server_id)
        {
            return (
                Some("timeout".to_string()),
                entry
                    .get("error_message")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
            );
        }
    }
    for entry in &payload.completed {
        if entry
            .get("server_name")
            .and_then(Value::as_str)
            .is_some_and(|name| name == server_id)
        {
            return (Some("completed".to_string()), None);
        }
    }
    for entry in &payload.failed {
        if entry
            .get("server_name")
            .and_then(Value::as_str)
            .is_some_and(|name| name == server_id)
        {
            return (
                Some("failed".to_string()),
                entry
                    .get("error_message")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
            );
        }
    }
    (None, None)
}

pub(crate) fn lookup_oauth_status_missing(
    server_id: &str,
    payload: &OAuthStatusPayload,
) -> (Option<String>, Option<String>) {
    if let Some(current) = payload.current.as_ref() {
        if current
            .get("server_name")
            .and_then(Value::as_str)
            .is_some_and(|name| name == server_id)
        {
            return (
                current
                    .get("state")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                current
                    .get("error_message")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
            );
        }
    }
    for entry in &payload.active {
        if entry
            .get("server_name")
            .and_then(Value::as_str)
            .is_some_and(|name| name == server_id)
        {
            return (
                entry
                    .get("state")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
                    .or_else(|| Some("active".to_string())),
                entry
                    .get("error_message")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
            );
        }
    }
    for entry in &payload.pending {
        if entry
            .get("server_name")
            .and_then(Value::as_str)
            .is_some_and(|name| name == server_id)
        {
            return (Some("pending".to_string()), None);
        }
    }
    for entry in &payload.checking {
        if entry
            .get("server_name")
            .and_then(Value::as_str)
            .is_some_and(|name| name == server_id)
        {
            return (
                Some("checking".to_string()),
                entry
                    .get("error_message")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
            );
        }
    }
    for entry in &payload.waiting_callback {
        if entry
            .get("server_name")
            .and_then(Value::as_str)
            .is_some_and(|name| name == server_id)
        {
            return (Some("waiting_callback".to_string()), None);
        }
    }
    for entry in &payload.timeout {
        if entry
            .get("server_name")
            .and_then(Value::as_str)
            .is_some_and(|name| name == server_id)
        {
            return (
                Some("timeout".to_string()),
                entry
                    .get("error_message")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
            );
        }
    }
    for entry in &payload.failed {
        if entry
            .get("server_name")
            .and_then(Value::as_str)
            .is_some_and(|name| name == server_id)
        {
            return (
                Some("failed".to_string()),
                entry
                    .get("error_message")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
            );
        }
    }
    (None, None)
}

fn bump_summary(summary: &mut Value, key: &str) {
    let current = summary.get(key).and_then(Value::as_i64).unwrap_or_default();
    summary[key] = json!(current + 1);
}

pub(crate) fn sequence_match_ratio(left: &str, right: &str) -> f64 {
    if left.is_empty() && right.is_empty() {
        return 1.0;
    }
    let left = left.chars().collect::<Vec<_>>();
    let right = right.chars().collect::<Vec<_>>();
    let matches = matching_blocks_len(&left, 0, left.len(), &right, 0, right.len());
    (2.0 * matches as f64) / (left.len() + right.len()) as f64
}

fn matching_blocks_len(
    left: &[char],
    alo: usize,
    ahi: usize,
    right: &[char],
    blo: usize,
    bhi: usize,
) -> usize {
    let (i, j, size) = longest_match(left, alo, ahi, right, blo, bhi);
    if size == 0 {
        0
    } else {
        size + matching_blocks_len(left, alo, i, right, blo, j)
            + matching_blocks_len(left, i + size, ahi, right, j + size, bhi)
    }
}

fn longest_match(
    left: &[char],
    alo: usize,
    ahi: usize,
    right: &[char],
    blo: usize,
    bhi: usize,
) -> (usize, usize, usize) {
    let mut best_i = alo;
    let mut best_j = blo;
    let mut best_size = 0;
    let mut j2len = HashMap::<usize, usize>::new();

    for i in alo..ahi {
        let mut new_j2len = HashMap::<usize, usize>::new();
        for j in blo..bhi {
            if left[i] == right[j] {
                let size = j2len.get(&(j.saturating_sub(1))).copied().unwrap_or(0) + 1;
                new_j2len.insert(j, size);
                if size > best_size {
                    best_i = i + 1 - size;
                    best_j = j + 1 - size;
                    best_size = size;
                }
            }
        }
        j2len = new_j2len;
    }

    (best_i, best_j, best_size)
}
