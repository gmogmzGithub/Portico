mod catalog;
mod converse;
mod costs;
mod provider_headers;
mod prompt_cache;
mod reporting;
mod thinking_cache;
mod ultra_multi_agent;

use anyhow::{anyhow, Context, Result};
use async_stream::try_stream;
use axum::body::{to_bytes, Body, Bytes};
use axum::extract::{DefaultBodyLimit, Path, Request, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Response, StatusCode};
use axum::middleware::{self, Next};
use axum::response::IntoResponse;
use axum::routing::{any, get, post};
use axum::{Json, Router};
use catalog::{load_catalog, Catalog, ModelEntry, ProviderKind};
use converse::{
    anthropic_request_to_bedrock, bedrock_response_to_anthropic,
    collect_turn_thinking_stash_from_anthropic_content, flush_bedrock_stream_state,
    splice_cached_thinking_into_anthropic_request,
    normalize_image_data_url, proxy_headers, response_headers_from_upstream,
    synthesize_bedrock_stream_eof, translate_bedrock_stream_chunk, StreamTranslationState,
    ANTHROPIC_API_VERSION, BEDROCK_MALFORMED_TOOL_USE_ERROR_KIND,
    BEDROCK_MALFORMED_TOOL_USE_STOP_REASON,
};
use costs::compute_usage_cost;
use futures_util::{StreamExt, TryStreamExt};
use provider_headers::ResolvedProviderHeaders;
use prompt_cache::{
    apply_openai_service_tier, apply_prompt_cache_and_reasoning,
    extract_prompt_cache_affinity as extract_payload_prompt_cache_affinity, extract_service_tier,
    tool_slimming_enabled_for,
};
use reporting::{
    build_stream_failure_event, build_usage_event, clamped_context_estimate,
    extract_reporting_context, extract_usage_from_sse_bytes,
    inject_context_tokens_into_sse_usage, serialize_upstream_response_headers,
    write_stream_failure_event,
    write_usage_event, ReportingContext,
};
use reqwest::{Client, RequestBuilder};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::env;
use std::error::Error as StdError;
use std::fs as std_fs;
use std::io::Error as IoError;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::fs;
use tokio::time::Instant;
use tracing::{info, warn};
use ultra_multi_agent::{
    now_epoch_seconds, parse_buffered_sse, verify_request as verify_ultra_request, BufferedOutcome,
    OpaqueRoundState, OrderedBatchAdmission, UltraToolCall, BETA_HEADER_NAME, BETA_HEADER_VALUE,
};
use uuid::Uuid;

const DEFAULT_UPSTREAM_RETRY_MAX_ATTEMPTS: u32 = 5;
const DEFAULT_UPSTREAM_RETRY_BASE_DELAY_MS: u64 = 1_000;
const DEFAULT_UPSTREAM_RETRY_MAX_DELAY_MS: u64 = 5_000;
const DEFAULT_MAX_REQUEST_BODY_BYTES: usize = 0;
const DEFAULT_NON_STREAM_REQUEST_TIMEOUT_SECONDS: u64 = 360;
const DEFAULT_STREAM_IDLE_TIMEOUT_SECONDS: u64 = 300;
const DEFAULT_STREAM_TOTAL_TIMEOUT_SECONDS: u64 = 0;
const BEDROCK_CONVERSE_PROVIDER_NAME: &str = "anthropic";
const GEMINI_VERTEX_PROVIDER_NAME: &str = "gemini";
const GEMINI_VERTEX_MAX_FUNCTION_DECLARATIONS: usize = 512;
const MIN_BEDROCK_CONVERSE_TIMEOUT_SECONDS: u64 = 300;
const GPT_OPENAI_ROUTE_MODE_ENV: &str = "GPT_OPENAI_ROUTE_MODE";
const GPT_SERVICE_TIER_ENV: &str = "GPT_SERVICE_TIER";
const TRACEPARENT_HEADER: &str = "traceparent";
const TRACESTATE_HEADER: &str = "tracestate";
const BAGGAGE_HEADER: &str = "baggage";
const ULTRA_MAX_INITIAL_BODY_BYTES: usize = 2 * 1024 * 1024;
const ULTRA_MAX_CALLS_PER_BATCH: usize = 64;
const ULTRA_MAX_RESIDENT_BATCHES: usize = 1024;
const ULTRA_MAX_RESIDENT_BYTES: usize = 64 * 1024 * 1024;
const ULTRA_MAX_TOTAL_CALLS: u64 = 256;
const ULTRA_MAX_CONTINUATIONS: u64 = 32;
const ULTRA_MAX_TRANSCRIPT_BYTES: usize = 16 * 1024 * 1024;
const ULTRA_MAX_WALL_TIME: Duration = Duration::from_secs(30 * 60);
const ULTRA_MAX_CUMULATIVE_TOKENS: u64 = 10_000_000;
const ULTRA_MAX_COST_MICROUSD: u64 = 100_000_000;
const ULTRA_HOSTED_AGENT_INSTRUCTIONS: &str = "\
PORTICO Ultra uses OpenAI hosted server-side multi-agent mode. Across this user \
turn, use at least one hosted child agent. A previous_response_id continuation \
is part of the same turn and does not require a new child solely to satisfy this \
instruction. Do not substitute developer function tools whose names begin with \
subagents_. Hosted child output is private. Hosted children must never emit \
developer function calls because an active multi-agent response cannot accept \
their local results. Only the root may emit developer function calls. When the \
root emits one, end the current response with that call so PORTICO can return its \
local result in a previous_response_id continuation.";
const CLAUDE_SYSTEM_MESSAGES_PASSTHROUGH_KEY: &str = "__owui_claude_system_messages";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GptOpenAIRouteMode {
    Direct,
    Bifrost,
}

impl GptOpenAIRouteMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Direct => "direct",
            Self::Bifrost => "bifrost",
        }
    }
}

#[derive(Clone)]
struct AppState {
    catalog: Arc<Catalog>,
    client: Client,
    bifrost_base_url: String,
    llm_proxy_base_url: String,
    config_output_path: PathBuf,
    portico_api_key: String,
    ultra_multi_agent_signing_secret: String,
    local_bearer_auth_enabled: bool,
    ultra_run_claims: Arc<tokio::sync::Mutex<HashMap<String, Instant>>>,
    ultra_batches: Arc<tokio::sync::Mutex<HashMap<String, UltraStoredBatch>>>,
    provider_headers: ResolvedProviderHeaders,
    prompt_cache_claude_enabled: bool,
    gpt_openai_route_mode: GptOpenAIRouteMode,
    gpt_openai_route_mode_source: String,
    gpt_service_tier: Option<String>,
    gpt_service_tier_source: String,
    bedrock_converse_timeout_seconds: u64,
    stream_timeout_config: StreamTimeoutConfig,
    reporting_dir: Option<PathBuf>,
    thinking_cache: Arc<thinking_cache::ThinkingCache>,
    claude_thinking_splice_enabled: bool,
}

#[derive(Clone, Debug, Default)]
struct UltraAudit {
    child_agent_count: u64,
    tool_call_count: u64,
    child_tool_call_count: u64,
    tool_result_count: u64,
    continuation_count: u64,
}

struct UltraStoredBatch {
    started_at: Instant,
    expires_at: Instant,
    entry: ModelEntry,
    responses_payload: Value,
    round_state: OpaqueRoundState,
    calls: Vec<UltraToolCall>,
    admission: OrderedBatchAdmission,
    claimed: bool,
    audit: UltraAudit,
    reporting_context: Option<ReportingContext>,
    reporting_call_id: String,
}

#[derive(Deserialize)]
struct UltraDispatchMarker {
    call_id: String,
    payload_digest: String,
}

#[derive(Deserialize)]
struct UltraToolResult {
    call_id: String,
    payload_digest: String,
    output: Value,
}

#[derive(Deserialize)]
struct UltraToolResults {
    results: Vec<UltraToolResult>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct StreamTimeoutConfig {
    idle_timeout: Duration,
    total_timeout: Option<Duration>,
}

#[derive(Clone, Copy, Debug)]
struct BridgeRequestTiming {
    bridge_received_at: Instant,
    bridge_received_at_ms: u64,
    prompt_submitted_at_ms: Option<u64>,
}

impl BridgeRequestTiming {
    fn new(context: Option<&ReportingContext>) -> Self {
        Self {
            bridge_received_at: Instant::now(),
            bridge_received_at_ms: current_time_millis(),
            prompt_submitted_at_ms: context.and_then(|ctx| ctx.prompt_submitted_at_ms),
        }
    }

    fn submit_to_bridge_receive_ms(self) -> Option<u64> {
        self.prompt_submitted_at_ms
            .map(|submitted_at_ms| self.bridge_received_at_ms.saturating_sub(submitted_at_ms))
    }

    fn bridge_receive_to_now_ms(self) -> u64 {
        self.bridge_received_at.elapsed().as_millis() as u64
    }

    fn submit_to_epoch_ms(self, now_ms: u64) -> Option<u64> {
        self.prompt_submitted_at_ms
            .map(|submitted_at_ms| now_ms.saturating_sub(submitted_at_ms))
    }
}

#[derive(Clone, Copy, Debug)]
struct UpstreamRequestMeta {
    dispatch_started_at: Instant,
    dispatch_started_at_ms: u64,
    attempt: u32,
    max_attempts: u32,
}

struct UpstreamResponse {
    response: reqwest::Response,
    meta: UpstreamRequestMeta,
}

impl StreamTimeoutConfig {
    fn from_env() -> Self {
        let idle_timeout_seconds = env_u64(
            "BIFROST_BRIDGE_STREAM_IDLE_TIMEOUT_SECONDS",
            DEFAULT_STREAM_IDLE_TIMEOUT_SECONDS,
        );
        let total_timeout_seconds = env_optional_u64_allow_zero(
            "BIFROST_BRIDGE_STREAM_TOTAL_TIMEOUT_SECONDS",
            DEFAULT_STREAM_TOTAL_TIMEOUT_SECONDS,
        )
        .map(|seconds| seconds.max(idle_timeout_seconds));
        Self {
            idle_timeout: Duration::from_secs(idle_timeout_seconds),
            total_timeout: total_timeout_seconds.map(Duration::from_secs),
        }
    }

    fn idle_timeout_seconds(self) -> u64 {
        self.idle_timeout.as_secs()
    }

    fn total_timeout_seconds(self) -> Option<u64> {
        self.total_timeout.map(|timeout| timeout.as_secs())
    }

    fn total_timeout_enabled(self) -> bool {
        self.total_timeout.is_some()
    }

    fn total_timeout_label(self) -> String {
        self.total_timeout_seconds()
            .map(|seconds| seconds.to_string())
            .unwrap_or_else(|| "disabled".to_string())
    }

    #[cfg(test)]
    fn new(idle_timeout: Duration, total_timeout: Option<Duration>) -> Self {
        Self {
            idle_timeout,
            total_timeout: total_timeout.map(|timeout| timeout.max(idle_timeout)),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StreamTimeoutLayer {
    Idle,
    Total,
}

impl StreamTimeoutLayer {
    fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "bridge_stream_idle_timeout",
            Self::Total => "bridge_stream_total_timeout",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StreamProgressPhase {
    BeforeProgress,
    AfterProgress,
}

impl StreamProgressPhase {
    fn as_str(self) -> &'static str {
        match self {
            Self::BeforeProgress => "before_progress",
            Self::AfterProgress => "after_progress",
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct StreamReadTimeout {
    layer: StreamTimeoutLayer,
    timeout: Duration,
    elapsed: Duration,
    progress_phase: StreamProgressPhase,
    effective_idle_timeout: Duration,
}

impl StreamReadTimeout {
    fn idle(timeout: Duration, elapsed: Duration, progress_phase: StreamProgressPhase) -> Self {
        Self {
            layer: StreamTimeoutLayer::Idle,
            timeout,
            elapsed,
            progress_phase,
            effective_idle_timeout: timeout,
        }
    }

    fn total(
        timeout: Duration,
        elapsed: Duration,
        progress_phase: StreamProgressPhase,
        effective_idle_timeout: Duration,
    ) -> Self {
        Self {
            layer: StreamTimeoutLayer::Total,
            timeout,
            elapsed,
            progress_phase,
            effective_idle_timeout,
        }
    }

    fn raw_error(self) -> String {
        match self.layer {
            StreamTimeoutLayer::Idle => format!(
                "bridge stream idle timeout after {} seconds without upstream data",
                self.timeout.as_secs()
            ),
            StreamTimeoutLayer::Total => format!(
                "bridge stream total timeout after {} seconds",
                self.timeout.as_secs()
            ),
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let reporting_dir = env::var("PORTICO_COST_REPORTING_DIR")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    if let Some(reporting_dir) = reporting_dir.as_ref() {
        if reporting::remove_legacy_request_payloads(reporting_dir)
            .await
            .is_err()
        {
            warn!("Failed to remove legacy request payload artifacts");
        }
    }

    let config_path = PathBuf::from(env_or("MODEL_CATALOG_PATH", "/app/model_catalog.yaml"));
    let config_output_path = PathBuf::from(env_or(
        "BIFROST_CONFIG_OUTPUT",
        "/app/bifrost-data/config.json",
    ));
    let bind_addr = env_or("BIFROST_BRIDGE_BIND", "0.0.0.0:4000");
    let bifrost_base_url = env_or("BIFROST_BASE_URL", "http://bifrost:8080");
    let llm_proxy_base_url = env_or("LLM_PROXY_BASE_URL", "https://api.openai.com/v1")
        .trim_end_matches('/')
        .to_string();
    let prompt_cache_claude_enabled = env_bool("PROMPT_CACHE_CLAUDE_ENABLED", true);
    let stream_timeout_config = StreamTimeoutConfig::from_env();
    let (gpt_openai_route_mode, gpt_openai_route_mode_source) = load_gpt_openai_route_mode();
    info!(
        env = GPT_OPENAI_ROUTE_MODE_ENV,
        mode = gpt_openai_route_mode.as_str(),
        source = gpt_openai_route_mode_source,
        "Configured GPT OpenAI route mode"
    );
    let (gpt_service_tier, gpt_service_tier_source) = load_gpt_service_tier();
    info!(
        env = GPT_SERVICE_TIER_ENV,
        tier = gpt_service_tier.as_deref().unwrap_or("-"),
        source = gpt_service_tier_source,
        "Configured GPT service tier default (fast mode)"
    );
    info!(
        idle_timeout_seconds = stream_timeout_config.idle_timeout_seconds(),
        total_timeout_enabled = stream_timeout_config.total_timeout_enabled(),
        total_timeout = %stream_timeout_config.total_timeout_label(),
        total_timeout_seconds = stream_timeout_config.total_timeout_seconds().unwrap_or_default(),
        "Configured bridge stream timeout budgets"
    );
    let max_request_body_bytes = bridge_max_request_body_bytes();
    info!(
        chat_request_body_limit_enabled = max_request_body_bytes.is_some(),
        chat_request_body_limit_bytes = max_request_body_bytes.unwrap_or_default(),
        "Configured bridge chat request body limit"
    );

    let bridge_base_url = format!(
        "http://{}",
        env_or("BIFROST_BRIDGE_ADVERTISED_HOST", "llm-gateway:4000")
    );
    let catalog = load_catalog(&config_path, &bridge_base_url)?;
    let bedrock_converse_timeout_seconds = provider_timeout_seconds(
        &catalog.bifrost_config,
        BEDROCK_CONVERSE_PROVIDER_NAME,
    )
    .ok_or_else(|| {
        anyhow!(
            "Missing default_request_timeout_in_seconds for provider {BEDROCK_CONVERSE_PROVIDER_NAME}"
        )
    })?;
    if bedrock_converse_timeout_seconds < MIN_BEDROCK_CONVERSE_TIMEOUT_SECONDS {
        return Err(anyhow!(
            "Configured timeout for provider {BEDROCK_CONVERSE_PROVIDER_NAME} is {}s, below the enforced minimum of {}s",
            bedrock_converse_timeout_seconds,
            MIN_BEDROCK_CONVERSE_TIMEOUT_SECONDS
        ));
    }
    info!(
        provider = BEDROCK_CONVERSE_PROVIDER_NAME,
        timeout_seconds = bedrock_converse_timeout_seconds,
        "Loaded effective provider timeout"
    );
    let portico_api_key = required_env("PORTICO_LLM_API_KEY")?;
    let bridge_local_api_key = required_env("BIFROST_BRIDGE_LOCAL_API_KEY")?;
    let ultra_multi_agent_signing_secret = required_env("ULTRA_MULTI_AGENT_SIGNING_SECRET")?;
    ultra_multi_agent::validate_signing_secret(&ultra_multi_agent_signing_secret)
        .map_err(|error| anyhow!("Invalid ULTRA_MULTI_AGENT_SIGNING_SECRET: {error}"))?;
    if ultra_multi_agent_signing_secret == bridge_local_api_key
        || ultra_multi_agent_signing_secret == portico_api_key
    {
        return Err(anyhow!(
            "ULTRA_MULTI_AGENT_SIGNING_SECRET must be distinct from bearer credentials"
        ));
    }
    let provider_headers = catalog.provider_headers.resolve()?;
    write_bifrost_config(&config_output_path, &catalog).await?;
    let client = Client::builder()
        .use_rustls_tls()
        .connect_timeout(Duration::from_secs(30))
        .build()
        .context("failed to build reqwest client")?;

    let state = AppState {
        catalog: Arc::new(catalog),
        client,
        bifrost_base_url: bifrost_base_url.trim_end_matches('/').to_string(),
        llm_proxy_base_url,
        config_output_path,
        portico_api_key,
        ultra_multi_agent_signing_secret,
        local_bearer_auth_enabled: true,
        ultra_run_claims: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        ultra_batches: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        provider_headers,
        prompt_cache_claude_enabled,
        gpt_openai_route_mode,
        gpt_openai_route_mode_source: gpt_openai_route_mode_source.to_string(),
        gpt_service_tier,
        gpt_service_tier_source: gpt_service_tier_source.to_string(),
        bedrock_converse_timeout_seconds,
        stream_timeout_config,
        reporting_dir,
        thinking_cache: Arc::new(thinking_cache::ThinkingCache::from_env()),
        claude_thinking_splice_enabled: std::env::var("BRIDGE_CLAUDE_THINKING_SPLICE")
            .map(|value| {
                !matches!(
                    value.trim().to_ascii_lowercase().as_str(),
                    "off" | "0" | "false" | "no"
                )
            })
            .unwrap_or(true),
    };

    let app =
        build_app_with_local_api_key(state, max_request_body_bytes, Some(bridge_local_api_key));

    let addr: SocketAddr = bind_addr
        .parse()
        .context("invalid BIFROST_BRIDGE_BIND address")?;
    info!("starting bifrost bridge on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("axum server exited unexpectedly")?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        let mut signal =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap();
        signal.recv().await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}

fn env_bool(name: &str, default: bool) -> bool {
    match env::var(name) {
        Ok(value) => matches!(
            value.to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        Err(_) => default,
    }
}

fn env_or(name: &str, default: &str) -> String {
    env::var(name).unwrap_or_else(|_| default.to_string())
}

fn openai_responses_url(base_url: &str) -> String {
    let base_url = base_url.trim_end_matches('/');
    if base_url.ends_with("/v1") {
        format!("{base_url}/responses")
    } else {
        format!("{base_url}/openai/v1/responses")
    }
}

fn read_secret_from_file(path: &str) -> Option<String> {
    let trimmed_path = path.trim();
    if trimmed_path.is_empty() {
        return None;
    }
    let value = std_fs::read_to_string(trimmed_path).ok()?;
    let trimmed_value = value.trim().to_string();
    if trimmed_value.is_empty() {
        None
    } else {
        Some(trimmed_value)
    }
}

fn env_optional_with_file(name: &str) -> Option<String> {
    let file_env_name = format!("{name}_FILE");
    if let Ok(path) = env::var(&file_env_name) {
        if let Some(secret) = read_secret_from_file(&path) {
            return Some(secret);
        }
    }
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn load_gpt_openai_route_mode() -> (GptOpenAIRouteMode, &'static str) {
    match env::var(GPT_OPENAI_ROUTE_MODE_ENV) {
        Ok(value) => match value.trim().to_ascii_lowercase().as_str() {
            "" | "direct" => (GptOpenAIRouteMode::Direct, "env"),
            "bifrost" => (GptOpenAIRouteMode::Bifrost, "env"),
            other => {
                warn!(
                    env = GPT_OPENAI_ROUTE_MODE_ENV,
                    value = other,
                    fallback = GptOpenAIRouteMode::Direct.as_str(),
                    "Invalid GPT route mode; falling back to direct"
                );
                (GptOpenAIRouteMode::Direct, "invalid_env_fallback")
            }
        },
        Err(_) => (GptOpenAIRouteMode::Direct, "default"),
    }
}

fn load_gpt_service_tier() -> (Option<String>, &'static str) {
    match env::var(GPT_SERVICE_TIER_ENV) {
        Ok(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("off") {
                (None, "disabled_env")
            } else {
                (Some(trimmed.to_string()), "env")
            }
        }
        Err(_) => (None, "default"),
    }
}

fn env_u32(name: &str, default: u32) -> u32 {
    env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

fn env_u64(name: &str, default: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

fn env_optional_usize_allow_zero(name: &str, default: usize) -> Option<usize> {
    match env::var(name) {
        Ok(value) => match value.trim().parse::<usize>() {
            Ok(0) => None,
            Ok(value) => Some(value),
            Err(_) => (default > 0).then_some(default),
        },
        Err(_) => (default > 0).then_some(default),
    }
}

fn bridge_max_request_body_bytes() -> Option<usize> {
    env_optional_usize_allow_zero(
        "BIFROST_BRIDGE_MAX_REQUEST_BODY_BYTES",
        DEFAULT_MAX_REQUEST_BODY_BYTES,
    )
}

#[cfg(test)]
fn build_app(state: AppState, max_request_body_bytes: Option<usize>) -> Router {
    let local_api_key = env_optional_with_file("BIFROST_BRIDGE_LOCAL_API_KEY");
    build_app_with_local_api_key(state, max_request_body_bytes, local_api_key)
}

fn build_app_with_local_api_key(
    state: AppState,
    max_request_body_bytes: Option<usize>,
    local_api_key: Option<String>,
) -> Router {
    let chat_completions_route = match max_request_body_bytes {
        Some(limit) => post(chat_completions).layer(DefaultBodyLimit::max(limit)),
        None => post(chat_completions).layer(DefaultBodyLimit::disable()),
    };
    let anthropic_messages_route = match max_request_body_bytes {
        Some(limit) => post(anthropic_messages).layer(DefaultBodyLimit::max(limit)),
        None => post(anthropic_messages).layer(DefaultBodyLimit::disable()),
    };

    let protected_routes = Router::new()
        .route("/v1/models", get(list_models))
        .route("/v1/chat/completions", chat_completions_route)
        .route(
            "/internal/ultra/batches/:token/claim",
            post(ultra_batch_claim),
        )
        .route(
            "/internal/ultra/batches/:token/dispatch-start",
            post(ultra_batch_dispatch_start),
        )
        .route(
            "/internal/ultra/batches/:token/heartbeat",
            post(ultra_batch_heartbeat),
        )
        .route(
            "/internal/ultra/batches/:token/results",
            post(ultra_batch_results),
        )
        .route("/v1/embeddings", post(embeddings));
    let internal_routes = Router::new()
        .route("/internal/anthropic/v1/messages", anthropic_messages_route)
        .route("/internal/gemini/*path", any(gemini_vertex_proxy));

    let protected_routes = match local_api_key {
        Some(local_api_key) => {
            info!(
                local_api_key_length = local_api_key.len(),
                "Bifrost inbound bearer auth enabled for protected bridge routes"
            );
            protected_routes.route_layer(middleware::from_fn_with_state(
                local_api_key,
                require_bridge_local_bearer_auth,
            ))
        }
        None => {
            warn!(
                "Bifrost inbound bearer auth disabled because BIFROST_BRIDGE_LOCAL_API_KEY is not set"
            );
            protected_routes
        }
    };

    Router::new()
        .route("/health", get(health))
        .merge(protected_routes)
        .merge(internal_routes)
        .with_state(state)
}

fn env_optional_u64_allow_zero(name: &str, default: u64) -> Option<u64> {
    match env::var(name) {
        Ok(value) => match value.trim().parse::<u64>() {
            Ok(0) => None,
            Ok(value) => Some(value),
            Err(_) => (default > 0).then_some(default),
        },
        Err(_) => (default > 0).then_some(default),
    }
}

fn bridge_non_stream_request_timeout_seconds() -> u64 {
    env_u64(
        "BIFROST_BRIDGE_NON_STREAM_REQUEST_TIMEOUT_SECONDS",
        DEFAULT_NON_STREAM_REQUEST_TIMEOUT_SECONDS,
    )
}

fn request_builder_with_timeout(
    request: reqwest::RequestBuilder,
    timeout_seconds: Option<u64>,
) -> reqwest::RequestBuilder {
    if let Some(timeout_seconds) = timeout_seconds {
        request.timeout(Duration::from_secs(timeout_seconds))
    } else {
        request
    }
}

fn required_env(name: &str) -> Result<String> {
    env_optional_with_file(name)
        .ok_or_else(|| anyhow!("Missing required environment variable: {name}"))
}

fn log_outbound_portico_header_audit(
    destination: &str,
    endpoint: &str,
    route: &str,
    model: &str,
    provider_headers: &ResolvedProviderHeaders,
    bifrost_audit_headers_emitted: bool,
    reporting_context: Option<&ReportingContext>,
) {
    let audit = provider_headers.audit_summary();
    info!(
        destination,
        endpoint,
        route,
        model,
        included_all_provider_headers = true,
        portico_header_count = 7,
        portico_app_id = %provider_headers.app_id,
        portico_track = %provider_headers.track,
        portico_log_request = %provider_headers.log_request,
        portico_log_response = %provider_headers.log_response,
        portico_content_type = %provider_headers.content_type,
        portico_userid_present = audit.user_id_present,
        portico_userid_fingerprint = %audit.user_id_fingerprint,
        portico_redact_allow_present = audit.redact_allow_present,
        portico_redact_allow_fingerprint = %audit.redact_allow_fingerprint,
        bifrost_audit_headers_emitted,
        chat_id = reporting_chat_id(reporting_context),
        message_id = reporting_message_id(reporting_context),
        session_id = reporting_session_id(reporting_context),
        "Applied outbound provider header contract",
    );
}

fn upstream_retry_max_attempts() -> u32 {
    env_u32(
        "BIFROST_BRIDGE_UPSTREAM_RETRY_MAX_ATTEMPTS",
        DEFAULT_UPSTREAM_RETRY_MAX_ATTEMPTS,
    )
}

fn upstream_retry_base_delay_ms() -> u64 {
    env_u64(
        "BIFROST_BRIDGE_UPSTREAM_RETRY_BASE_DELAY_MS",
        DEFAULT_UPSTREAM_RETRY_BASE_DELAY_MS,
    )
}

fn upstream_retry_max_delay_ms() -> u64 {
    env_u64(
        "BIFROST_BRIDGE_UPSTREAM_RETRY_MAX_DELAY_MS",
        DEFAULT_UPSTREAM_RETRY_MAX_DELAY_MS,
    )
}

fn provider_timeout_seconds(config: &Value, provider_name: &str) -> Option<u64> {
    config
        .get("providers")
        .and_then(|providers| providers.get(provider_name))
        .and_then(|provider| provider.get("network_config"))
        .and_then(|network| network.get("default_request_timeout_in_seconds"))
        .and_then(Value::as_u64)
}

fn extract_timeout_seconds_from_message(message: &str) -> Option<u64> {
    let lower = message.to_ascii_lowercase();
    let marker = "default is ";
    let start = lower.find(marker)? + marker.len();
    let digits: String = lower[start..]
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .collect();
    if digits.is_empty() {
        None
    } else {
        digits.parse::<u64>().ok()
    }
}

fn warn_if_timeout_message_mismatch(
    endpoint_label: &str,
    model_label: &str,
    message: &str,
    effective_timeout_seconds: Option<u64>,
) {
    let Some(effective_timeout_seconds) = effective_timeout_seconds else {
        return;
    };
    let Some(reported_timeout_seconds) = extract_timeout_seconds_from_message(message) else {
        return;
    };
    if reported_timeout_seconds == effective_timeout_seconds {
        return;
    }

    warn!(
        endpoint = endpoint_label,
        model = model_label,
        reported_timeout_seconds,
        effective_timeout_seconds,
        message = message,
        "Observed timeout message does not match loaded provider timeout"
    );
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct StreamReadFailureDetails {
    raw_error: String,
    error_chain: Vec<String>,
    is_timeout: bool,
    is_decode: bool,
    is_connect: bool,
    is_body: bool,
    is_request: bool,
    status: Option<StatusCode>,
}

impl StreamReadFailureDetails {
    fn from_reqwest(error: &reqwest::Error) -> Self {
        Self {
            raw_error: error.to_string(),
            error_chain: error_chain_messages(error),
            is_timeout: error.is_timeout(),
            is_decode: error.is_decode(),
            is_connect: error.is_connect(),
            is_body: error.is_body(),
            is_request: error.is_request(),
            status: error.status(),
        }
    }

    fn error_chain_text(&self) -> String {
        if self.error_chain.is_empty() {
            self.raw_error.clone()
        } else {
            self.error_chain.join(" | caused by: ")
        }
    }

    fn status_text(&self) -> String {
        self.status
            .map(|status| status.to_string())
            .unwrap_or_else(|| "-".to_string())
    }

    fn as_json(&self) -> Value {
        json!({
            "rawError": self.raw_error,
            "errorChain": self.error_chain,
            "isTimeout": self.is_timeout,
            "isDecode": self.is_decode,
            "isConnect": self.is_connect,
            "isBody": self.is_body,
            "isRequest": self.is_request,
            "status": self.status.map(|status| status.as_u16()),
        })
    }
}

fn error_chain_messages(error: &(dyn StdError + 'static)) -> Vec<String> {
    let mut output = Vec::new();
    let mut current = Some(error);
    while let Some(err) = current {
        let message = err.to_string();
        if output.last() != Some(&message) {
            output.push(message);
        }
        current = err.source();
    }
    output
}

fn anthropic_stream_stage(
    saw_upstream_progress: bool,
    state: &StreamTranslationState,
    upstream_body_chunk_count: usize,
) -> &'static str {
    if !saw_upstream_progress || upstream_body_chunk_count == 0 {
        return "before_first_body_chunk";
    }
    if state.tool_input_delta_events > 0 {
        return "after_tool_input_started";
    }
    if state.tool_use_blocks > 0 {
        return "after_tool_use_started";
    }
    if state.message_stop_emitted {
        return "after_message_stop";
    }
    if state.thinking_delta_events > 0 || state.text_delta_events > 0 {
        return "mid_stream_after_content";
    }
    if state.redacted_reasoning_events > 0 {
        return "after_redacted_reasoning";
    }
    "after_first_body_chunk_before_translated_content"
}

fn anthropic_stream_progress_snapshot(
    state: &StreamTranslationState,
    saw_upstream_progress: bool,
    upstream_body_chunk_count: usize,
    first_upstream_body_chunk_elapsed_ms: Option<u64>,
    last_upstream_body_chunk_elapsed_ms: Option<u64>,
    failure_elapsed_ms: u64,
) -> Value {
    json!({
        "streamStage": anthropic_stream_stage(
            saw_upstream_progress,
            state,
            upstream_body_chunk_count,
        ),
        "sawUpstreamProgress": saw_upstream_progress,
        "upstreamBodyChunkCount": upstream_body_chunk_count,
        "firstUpstreamBodyChunkElapsedMs": first_upstream_body_chunk_elapsed_ms,
        "lastUpstreamBodyChunkElapsedMs": last_upstream_body_chunk_elapsed_ms,
        "timeSinceLastUpstreamBodyChunkMs": last_upstream_body_chunk_elapsed_ms
            .map(|last| failure_elapsed_ms.saturating_sub(last)),
        "rawChunkCount": state.raw_chunk_count,
        "textDeltaEvents": state.text_delta_events,
        "textDeltaChars": state.text_delta_chars,
        "thinkingDeltaEvents": state.thinking_delta_events,
        "thinkingDeltaChars": state.thinking_delta_chars,
        "redactedReasoningEvents": state.redacted_reasoning_events,
        "redactedReasoningChars": state.redacted_reasoning_chars,
        "toolUseBlocks": state.tool_use_blocks,
        "toolInputDeltaEvents": state.tool_input_delta_events,
        "messageStopObserved": state.message_stop_observed,
        "rawStopReason": state.raw_stop_reason.as_deref(),
        "messageStopEmitted": state.message_stop_emitted,
    })
}

fn sanitized_bedrock_request_shape(payload: &Value) -> Value {
    let messages = payload
        .get("messages")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let system_blocks = payload
        .get("system")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let tool_specs = payload
        .get("toolConfig")
        .and_then(|value| value.get("tools"))
        .and_then(Value::as_array)
        .map(|tools| {
            tools
                .iter()
                .filter(|tool| tool.get("toolSpec").is_some())
                .count()
        })
        .unwrap_or(0);

    let mut tool_use_blocks = 0usize;
    let mut tool_result_blocks = 0usize;
    let mut reasoning_blocks = 0usize;
    let mut reasoning_signatures = 0usize;
    for block in messages
        .iter()
        .filter_map(|message| message.get("content").and_then(Value::as_array))
        .flatten()
    {
        if block.get("toolUse").is_some() {
            tool_use_blocks += 1;
        }
        if block.get("toolResult").is_some() {
            tool_result_blocks += 1;
        }
        if let Some(reasoning) = block.get("reasoningContent") {
            reasoning_blocks += 1;
            let signature = reasoning
                .get("reasoningText")
                .and_then(|value| value.get("signature"))
                .or_else(|| reasoning.get("signature"))
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default();
            if !signature.is_empty() {
                reasoning_signatures += 1;
            }
        }
    }

    json!({
        "messageCount": messages.len(),
        "systemBlockCount": system_blocks.len(),
        "toolSpecCount": tool_specs,
        "toolUseBlockCount": tool_use_blocks,
        "toolResultBlockCount": tool_result_blocks,
        "reasoningBlockCount": reasoning_blocks,
        "reasoningSignatureCount": reasoning_signatures,
    })
}

fn stream_progress_phase(saw_upstream_progress: bool) -> StreamProgressPhase {
    if saw_upstream_progress {
        StreamProgressPhase::AfterProgress
    } else {
        StreamProgressPhase::BeforeProgress
    }
}

fn effective_stream_idle_timeout(
    timeout_config: StreamTimeoutConfig,
    saw_upstream_progress: bool,
    post_progress_idle_timeout: Option<Duration>,
) -> Duration {
    if saw_upstream_progress {
        post_progress_idle_timeout.unwrap_or(timeout_config.idle_timeout)
    } else {
        timeout_config.idle_timeout
    }
}

async fn next_stream_item_with_timeouts<S>(
    mut stream: std::pin::Pin<&mut S>,
    started_at: Instant,
    timeout_config: StreamTimeoutConfig,
    saw_upstream_progress: bool,
    post_progress_idle_timeout: Option<Duration>,
) -> std::result::Result<Option<S::Item>, StreamReadTimeout>
where
    S: futures_util::Stream + ?Sized,
{
    let progress_phase = stream_progress_phase(saw_upstream_progress);
    let effective_idle_timeout = effective_stream_idle_timeout(
        timeout_config,
        saw_upstream_progress,
        post_progress_idle_timeout,
    );
    let elapsed = started_at.elapsed();
    let wait_timeout = if let Some(total_timeout) = timeout_config.total_timeout {
        if elapsed >= total_timeout {
            return Err(StreamReadTimeout::total(
                total_timeout,
                elapsed,
                progress_phase,
                effective_idle_timeout,
            ));
        }
        effective_idle_timeout.min(total_timeout.saturating_sub(elapsed))
    } else {
        effective_idle_timeout
    };

    match tokio::time::timeout(wait_timeout, stream.next()).await {
        Ok(item) => Ok(item),
        Err(_) => {
            let elapsed = started_at.elapsed();
            if let Some(total_timeout) = timeout_config.total_timeout {
                if elapsed >= total_timeout {
                    return Err(StreamReadTimeout::total(
                        total_timeout,
                        elapsed,
                        progress_phase,
                        effective_idle_timeout,
                    ));
                }
            }
            Err(StreamReadTimeout::idle(
                effective_idle_timeout,
                elapsed,
                progress_phase,
            ))
        }
    }
}

#[cfg(test)]
fn body_stream_error(error: anyhow::Error) -> IoError {
    IoError::other(error.to_string())
}

#[derive(Debug)]
struct UpstreamRequestError {
    status: StatusCode,
    message: String,
    headers: reqwest::header::HeaderMap,
}

async fn write_bifrost_config(output_path: &PathBuf, catalog: &Catalog) -> Result<()> {
    let parent = output_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("."));
    fs::create_dir_all(parent).await?;
    let payload = serde_json::to_vec_pretty(&catalog.bifrost_config)?;
    fs::write(output_path, payload).await?;
    Ok(())
}

fn json_error(status: StatusCode, message: impl Into<String>) -> Response<Body> {
    let payload = json!({
        "error": {
            "message": message.into()
        }
    });
    (status, Json(payload)).into_response()
}

fn authorization_matches_bearer(auth_header: &str, expected_key: &str) -> bool {
    let trimmed = auth_header.trim();
    if !trimmed
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("Bearer "))
    {
        return false;
    }

    let token = trimmed[7..].trim();
    if token.is_empty() {
        return false;
    }

    // Constant-time equality check to avoid leaking the expected bearer token
    // via response-time differences: Rust's `==` on `str`/`[u8]` short-circuits
    // on the first mismatching byte, which is a well-known timing side channel
    // for secret-equality checks. `subtle::ConstantTimeEq` mirrors the posture
    // the Python debug monitor already uses via `hmac.compare_digest`.
    use subtle::ConstantTimeEq;
    token.as_bytes().ct_eq(expected_key.as_bytes()).into()
}

async fn require_bridge_local_bearer_auth(
    State(expected_key): State<String>,
    request: Request,
    next: Next,
) -> Response<Body> {
    let auth_header = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");

    if authorization_matches_bearer(auth_header, &expected_key) {
        return next.run(request).await;
    }

    json_error(
        StatusCode::UNAUTHORIZED,
        "Authorization header must include a Bearer token",
    )
}

async fn health(State(state): State<AppState>) -> Response<Body> {
    let bifrost_ok = state
        .client
        .get(format!("{}/health", state.bifrost_base_url))
        .send()
        .await
        .map(|response| response.status().is_success())
        .unwrap_or(false);

    let payload = json!({
        "status": "ok",
        "bifrost_ready": bifrost_ok,
        "config_path": state.config_output_path,
        "model_count": state.catalog.ordered_entries.len()
    });
    Json(payload).into_response()
}

async fn list_models(State(state): State<AppState>) -> Response<Body> {
    let data: Vec<Value> = state
        .catalog
        .ordered_entries
        .iter()
        .map(|entry| {
            json!({
                "id": entry.alias,
                "object": "model",
                "created": 0,
                "owned_by": match entry.provider_kind {
                    ProviderKind::OpenAI => "openai",
                    ProviderKind::AnthropicConverse => "anthropic",
                    ProviderKind::GeminiVertex => GEMINI_VERTEX_PROVIDER_NAME
                }
            })
        })
        .collect();
    Json(json!({"object": "list", "data": data})).into_response()
}

async fn chat_completions(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response<Body> {
    let reporting_call_id = format!("call_{}", Uuid::new_v4().simple());
    let mut payload: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(error) => {
            return json_error(
                StatusCode::BAD_REQUEST,
                format!("Invalid JSON body: {error}"),
            );
        }
    };

    let model_alias = match payload.get("model").and_then(Value::as_str) {
        Some(value) => value.to_string(),
        None => return json_error(StatusCode::BAD_REQUEST, "Request body is missing model"),
    };

    let Some(entry) = state.catalog.entries.get(&model_alias).cloned() else {
        return json_error(
            StatusCode::NOT_FOUND,
            format!("Unknown model: {model_alias}"),
        );
    };

    let prompt_cache_affinity = extract_openwebui_prompt_cache_affinity(&headers);
    let reporting_context = extract_reporting_context(&headers, Some(&payload));
    let ultra_requested = ultra_request_requested(&payload);
    if !ultra_requested && ultra_reserved_controls_present(&payload) {
        return json_error(
            StatusCode::BAD_REQUEST,
            "multi_agent is reserved for authenticated Ultra requests",
        );
    }
    if ultra_requested {
        return chat_completions_via_ultra(
            state,
            headers,
            body,
            payload,
            entry,
            reporting_context,
            reporting_call_id,
        )
        .await;
    }

    let is_responses_route = should_use_responses_api(&entry);
    let bridge_timing = BridgeRequestTiming::new(reporting_context.as_ref());
    let route_label = if is_responses_route {
        "responses_api"
    } else {
        "chat_completions"
    };
    let endpoint_label = if is_responses_route {
        match state.gpt_openai_route_mode {
            GptOpenAIRouteMode::Direct => "openai responses",
            GptOpenAIRouteMode::Bifrost => "bifrost responses",
        }
    } else {
        "bifrost chat completions"
    };
    let is_stream = payload
        .get("stream")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    log_bridge_request_received(
        route_label,
        endpoint_label,
        &entry.alias,
        is_stream,
        reporting_context.as_ref(),
        bridge_timing,
    );
    info!(
        route = route_label,
        model_alias = %entry.alias,
        provider_model = %entry.provider_model,
        provider_kind = ?entry.provider_kind,
        stream = is_stream,
        message_count = json_array_len(payload.get("messages")),
        tool_count = json_array_len(payload.get("tools")),
        tools_bytes = tools_json_bytes(payload.get("tools")),
        prompt_cache_affinity_present = prompt_cache_affinity.is_some(),
        prompt_cache_affinity_len = prompt_cache_affinity.as_ref().map(|value| value.len()).unwrap_or(0),
        gpt_route_mode = state.gpt_openai_route_mode.as_str(),
        gpt_route_mode_source = %state.gpt_openai_route_mode_source,
        chat_id = reporting_chat_id(reporting_context.as_ref()),
        message_id = reporting_message_id(reporting_context.as_ref()),
        session_id = reporting_session_id(reporting_context.as_ref()),
        debug_request_id = reporting_debug_request_id(reporting_context.as_ref()),
        upstream_request_id = reporting_upstream_request_id(reporting_context.as_ref()),
        request_phase = reporting_request_phase(reporting_context.as_ref()),
        followup_index = ?reporting_followup_index(reporting_context.as_ref()),
        outer_message_id = reporting_outer_message_id(reporting_context.as_ref()),
        trigger_message_id = reporting_trigger_message_id(reporting_context.as_ref()),
        transcript_anchor_kind = reporting_transcript_anchor_kind(reporting_context.as_ref()),
        transcript_anchor_message_id = reporting_transcript_anchor_message_id(reporting_context.as_ref()),
        transcript_anchor_tool_block_index = ?reporting_transcript_anchor_tool_block_index(reporting_context.as_ref()),
        prompt_submitted_at_ms = ?reporting_prompt_submitted_at_ms(reporting_context.as_ref()),
        traceparent = reporting_traceparent(reporting_context.as_ref()),
        tracestate_present = reporting_tracestate_present(reporting_context.as_ref()),
        baggage_present = reporting_baggage_present(reporting_context.as_ref()),
        submit_to_bridge_receive_ms = ?bridge_timing.submit_to_bridge_receive_ms(),
        "Routing chat completion request",
    );

    if is_responses_route {
        return chat_completions_via_responses(
            state,
            payload,
            entry,
            prompt_cache_affinity,
            reporting_context,
            reporting_call_id,
            bridge_timing,
        )
        .await;
    }

    let sanitize_openwebui_openai_chat_metadata =
        entry.provider_kind == ProviderKind::OpenAI && has_openwebui_reporting_headers(&headers);
    let chat_completions_prompt_cache_affinity = if sanitize_openwebui_openai_chat_metadata {
        prompt_cache_affinity
            .clone()
            .or_else(|| extract_payload_prompt_cache_affinity(&payload))
    } else {
        prompt_cache_affinity.clone()
    };

    if let Some(object) = payload.as_object_mut() {
        if object.remove("_tool_namespaces").is_some() {
            info!(
                route = "chat_completions",
                model_alias = %entry.alias,
                gpt_route_mode = state.gpt_openai_route_mode.as_str(),
                chat_id = reporting_chat_id(reporting_context.as_ref()),
                message_id = reporting_message_id(reporting_context.as_ref()),
                session_id = reporting_session_id(reporting_context.as_ref()),
                "Stripped GPT namespace metadata before forwarding request to Bifrost chat completions",
            );
        }
    }

    if sanitize_openwebui_openai_chat_metadata {
        if let Some(object) = payload.as_object_mut() {
            if object.remove("metadata").is_some() {
                info!(
                    route = "chat_completions",
                    model_alias = %entry.alias,
                    gpt_route_mode = state.gpt_openai_route_mode.as_str(),
                    chat_id = reporting_chat_id(reporting_context.as_ref()),
                    message_id = reporting_message_id(reporting_context.as_ref()),
                    session_id = reporting_session_id(reporting_context.as_ref()),
                    "Stripped Open WebUI metadata before forwarding OpenAI chat completions",
                );
            }
        }
    } else {
        inject_reporting_context_into_payload(&mut payload, reporting_context.as_ref());
    }

    normalize_chat_payload_for_provider(
        &mut payload,
        &entry,
        state.prompt_cache_claude_enabled,
        chat_completions_prompt_cache_affinity.as_deref(),
        state.gpt_service_tier.as_deref(),
        reporting_context.as_ref(),
        "chat_completions",
    );
    inject_claude_system_messages_passthrough(&mut payload, entry.provider_kind.clone());
    if let Some(object) = payload.as_object_mut() {
        object.insert(
            "model".to_string(),
            Value::String(entry.bifrost_model.clone()),
        );
    }

    let chat_completions_url = format!("{}/v1/chat/completions", state.bifrost_base_url);
    let bifrost_headers = match state
        .provider_headers
        .bifrost_headers_with_auth(&state.portico_api_key)
    {
        Ok(value) => value,
        Err(error) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to build Bifrost request headers: {error}"),
            );
        }
    };
    log_outbound_portico_header_audit(
        "bifrost",
        "bifrost chat completions",
        "chat_completions",
        &entry.alias,
        &state.provider_headers,
        true,
        reporting_context.as_ref(),
    );
    let request_timeout_seconds =
        (!is_stream).then_some(bridge_non_stream_request_timeout_seconds());
    let upstream_response = match send_upstream_request_with_retry(
        &state.client,
        "chat_completions",
        "bifrost chat completions",
        &model_alias,
        is_stream,
        request_timeout_seconds,
        reporting_context.as_ref(),
        bridge_timing,
        |client| {
            let request = client
                .post(chat_completions_url.clone())
                .headers(bifrost_headers.clone())
                .header("x-bf-passthrough-extra-params", "true");
            let request = apply_reporting_headers(request, reporting_context.as_ref(), true);
            request_builder_with_timeout(request, request_timeout_seconds).json(&payload)
        },
    )
    .await
    {
        Ok(response) => response,
        Err(error) => {
            return json_error_with_headers(
                error.status,
                error.message,
                passthrough_cost_headers(&error.headers),
            );
        }
    };

    let upstream_meta = upstream_response.meta;
    let cost_hint = extract_cost_hint(upstream_response.response.headers());
    let passthrough_headers = passthrough_cost_headers(upstream_response.response.headers());
    info!(
        endpoint = "bifrost chat completions",
        route = "chat_completions",
        model_alias = %entry.alias,
        provider_model = %entry.provider_model,
        stream = is_stream,
        status = %upstream_response.response.status(),
        upstream_request_id = upstream_response
            .response
            .headers()
            .get("x-request-id")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("-"),
        cost_hint = cost_hint.unwrap_or_default(),
        gpt_route_mode = state.gpt_openai_route_mode.as_str(),
        gpt_route_mode_source = %state.gpt_openai_route_mode_source,
        chat_id = reporting_chat_id(reporting_context.as_ref()),
        message_id = reporting_message_id(reporting_context.as_ref()),
        session_id = reporting_session_id(reporting_context.as_ref()),
        "Received upstream response from Bifrost chat completions",
    );

    if !is_stream {
        let status = upstream_response.response.status();
        let mut body = match upstream_response.response.json::<Value>().await {
            Ok(value) => value,
            Err(error) => {
                return json_error(
                    StatusCode::BAD_GATEWAY,
                    format!("Invalid Bifrost JSON response: {error}"),
                );
            }
        };
        rewrite_chat_completion_value(&mut body, &entry, cost_hint);
        let finish_reason = body
            .pointer("/choices/0/finish_reason")
            .and_then(Value::as_str)
            .unwrap_or("-");
        let usage_summary = body
            .get("usage")
            .map(summarize_usage_for_log)
            .unwrap_or_else(|| "none".to_string());
        info!(
            endpoint = "bifrost chat completions",
            model = %entry.alias,
            finish_reason,
            usage = %usage_summary,
            chat_id = reporting_chat_id(reporting_context.as_ref()),
            message_id = reporting_message_id(reporting_context.as_ref()),
            session_id = reporting_session_id(reporting_context.as_ref()),
            "Translated upstream chat completion payload from Bifrost",
        );
        if let Some(usage) = body.get("usage") {
            maybe_report_usage_event(
                &state,
                reporting_context.as_ref(),
                &reporting_call_id,
                &entry.alias,
                &entry.alias,
                usage,
                context_tokens_from_billed_usage(usage),
            )
            .await;
        }
        log_bridge_upstream_response_complete(
            "chat_completions",
            "bifrost chat completions",
            &entry.alias,
            reporting_context.as_ref(),
            bridge_timing,
            upstream_meta,
            status,
        );
        let mut http_response = (status, Json(body)).into_response();
        merge_response_headers(&mut http_response, &passthrough_headers);
        return http_response;
    }

    let stream = upstream_response.response.bytes_stream();
    let endpoint_label = "bifrost chat completions";
    let stream_model = model_alias.clone();
    let stream_timeout_config = state.stream_timeout_config;
    let post_progress_idle_timeout = matches!(entry.provider_kind, ProviderKind::AnthropicConverse)
        .then_some(Duration::from_secs(state.bedrock_converse_timeout_seconds));
    let stream_started_at = Instant::now();
    let body_stream = try_stream! {
        info!(
            endpoint = endpoint_label,
            model = %stream_model,
            chat_id = reporting_chat_id(reporting_context.as_ref()),
            message_id = reporting_message_id(reporting_context.as_ref()),
            session_id = reporting_session_id(reporting_context.as_ref()),
            "Starting upstream chat completions stream passthrough",
        );
        let mut pending = Utf8LineBuffer::default();
        let mut emitted_stream_error = false;
        let mut saw_upstream_progress = false;
        let mut saw_done_sentinel = false;
        let mut saw_terminal_reason = false;
        let mut logged_first_client_token = false;
        futures_util::pin_mut!(stream);
        loop {
            let chunk = match next_stream_item_with_timeouts(
                stream.as_mut(),
                stream_started_at,
                stream_timeout_config,
                saw_upstream_progress,
                post_progress_idle_timeout,
            )
            .await
            {
                Ok(Some(chunk)) => chunk,
                Ok(None) => break,
                Err(error) => {
                    let raw_error = error.raw_error();
                    warn!(
                        endpoint = endpoint_label,
                        model = %stream_model,
                        timeout_layer = error.layer.as_str(),
                        progress_phase = error.progress_phase.as_str(),
                        timeout_seconds = error.timeout.as_secs(),
                        effective_idle_timeout_seconds = error.effective_idle_timeout.as_secs(),
                        elapsed_ms = error.elapsed.as_millis() as u64,
                        error = %raw_error,
                        chat_id = reporting_chat_id(reporting_context.as_ref()),
                        message_id = reporting_message_id(reporting_context.as_ref()),
                        session_id = reporting_session_id(reporting_context.as_ref()),
                        "Emitting synthetic OpenAI stream error after upstream stream timeout",
                    );
                    for output in openai_stream_error_chunks(&raw_error) {
                        yield output;
                    }
                    emitted_stream_error = true;
                    break;
                }
            };
            let chunk = match chunk {
                Ok(chunk) => {
                    if !saw_upstream_progress {
                        log_bridge_upstream_first_chunk(
                            "chat_completions",
                            endpoint_label,
                            &stream_model,
                            reporting_context.as_ref(),
                            bridge_timing,
                            upstream_meta,
                            chunk.len(),
                        );
                    }
                    saw_upstream_progress = true;
                    chunk
                }
                Err(error) => {
                    let raw_error = error.to_string();
                    warn!(
                        endpoint = endpoint_label,
                        model = %stream_model,
                        error = %raw_error,
                        "Emitting synthetic OpenAI stream error after upstream stream read failure",
                    );
                    for output in openai_stream_error_chunks(&raw_error) {
                        yield output;
                    }
                    emitted_stream_error = true;
                    break;
                }
            };
            pending.push_chunk(chunk.as_ref());
            let lines = match pending.drain_complete_lines() {
                Ok(lines) => lines,
                Err(error) => {
                    let raw_error = format!("Bifrost stream contained invalid UTF-8: {error}");
                    warn!(
                        endpoint = endpoint_label,
                        model = %stream_model,
                        error = %raw_error,
                        "Emitting synthetic OpenAI stream error after invalid upstream stream bytes",
                    );
                    for output in openai_stream_error_chunks(&raw_error) {
                        yield output;
                    }
                    emitted_stream_error = true;
                    break;
                }
            };
            for line in lines {
                let output = match transform_bifrost_sse_line(&line, &entry, cost_hint) {
                    Ok(output) => output,
                    Err(error) => {
                        let raw_error = error.to_string();
                        warn!(
                            endpoint = endpoint_label,
                            model = %stream_model,
                            error = %raw_error,
                            "Emitting synthetic OpenAI stream error after stream translation failure",
                        );
                        for output in openai_stream_error_chunks(&raw_error) {
                            yield output;
                        }
                        emitted_stream_error = true;
                        break;
                    }
                };
                if line.trim() == "data: [DONE]" {
                    saw_done_sentinel = true;
                }
                if openai_stream_chunk_has_terminal_reason(output.as_ref()) {
                    saw_terminal_reason = true;
                }
                if let Some(usage) = extract_usage_from_sse_bytes(output.as_ref()) {
                    maybe_report_usage_event(
                        &state,
                        reporting_context.as_ref(),
                        &reporting_call_id,
                        &entry.alias,
                        &entry.alias,
                        &usage,
                        context_tokens_from_billed_usage(&usage),
                    )
                    .await;
                }
                if !logged_first_client_token && should_log_client_token_chunk(output.as_ref()) {
                    logged_first_client_token = true;
                    log_bridge_first_client_token(
                        "chat_completions",
                        endpoint_label,
                        &stream_model,
                        reporting_context.as_ref(),
                        bridge_timing,
                        upstream_meta,
                    );
                }
                yield output;
            }

            if emitted_stream_error {
                break;
            }
        }

        if !emitted_stream_error {
            match pending.finish() {
                Ok(Some(line)) => match transform_bifrost_sse_line(&line, &entry, cost_hint) {
                    Ok(output) => {
                        if line.trim() == "data: [DONE]" {
                            saw_done_sentinel = true;
                        }
                        if openai_stream_chunk_has_terminal_reason(output.as_ref()) {
                            saw_terminal_reason = true;
                        }
                        if let Some(usage) = extract_usage_from_sse_bytes(output.as_ref()) {
                            maybe_report_usage_event(
                                &state,
                                reporting_context.as_ref(),
                                &reporting_call_id,
                                &entry.alias,
                                &entry.alias,
                                &usage,
                                context_tokens_from_billed_usage(&usage),
                            )
                            .await;
                        }
                        if !logged_first_client_token
                            && should_log_client_token_chunk(output.as_ref())
                        {
                            log_bridge_first_client_token(
                                "chat_completions",
                                endpoint_label,
                                &stream_model,
                                reporting_context.as_ref(),
                                bridge_timing,
                                upstream_meta,
                            );
                        }
                        yield output
                    },
                    Err(error) => {
                        let raw_error = error.to_string();
                        warn!(
                            endpoint = endpoint_label,
                            model = %stream_model,
                            error = %raw_error,
                            "Emitting synthetic OpenAI stream error after trailing stream translation failure",
                        );
                        for output in openai_stream_error_chunks(&raw_error) {
                            yield output;
                        }
                        emitted_stream_error = true;
                    }
                },
                Ok(None) => {}
                Err(error) => {
                    let raw_error = format!("Bifrost stream contained invalid UTF-8: {error}");
                    warn!(
                        endpoint = endpoint_label,
                        model = %stream_model,
                        error = %raw_error,
                        "Emitting synthetic OpenAI stream error after invalid trailing upstream stream bytes",
                    );
                    for output in openai_stream_error_chunks(&raw_error) {
                        yield output;
                    }
                    emitted_stream_error = true;
                }
            }
        }
        if !emitted_stream_error
            && matches!(entry.provider_kind, ProviderKind::AnthropicConverse)
            && !saw_done_sentinel
        {
            if saw_terminal_reason {
                warn!(
                    endpoint = endpoint_label,
                    model = %stream_model,
                    chat_id = reporting_chat_id(reporting_context.as_ref()),
                    message_id = reporting_message_id(reporting_context.as_ref()),
                    session_id = reporting_session_id(reporting_context.as_ref()),
                    "Synthesizing OpenAI [DONE] after Anthropic Converse chat-completions stream ended without done sentinel",
                );
                yield sse_done_bytes();
            } else {
                let raw_error = "Bedrock Converse chat-completions stream ended without a terminal event; treating as incomplete_stream";
                warn!(
                    endpoint = endpoint_label,
                    model = %stream_model,
                    elapsed_ms = stream_started_at.elapsed().as_millis() as u64,
                    chat_id = reporting_chat_id(reporting_context.as_ref()),
                    message_id = reporting_message_id(reporting_context.as_ref()),
                    session_id = reporting_session_id(reporting_context.as_ref()),
                    "Emitting synthetic OpenAI stream error after Anthropic Converse chat-completions EOF without terminal event",
                );
                for output in openai_stream_error_chunks(raw_error) {
                    yield output;
                }
            }
        }
    }
    .map_err(|error: IoError| error);
    let body = Body::from_stream(body_stream);

    let mut response = Response::new(body);
    *response.status_mut() = StatusCode::OK;
    *response.headers_mut() = passthrough_headers;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
        .headers_mut()
        .insert(header::CONNECTION, HeaderValue::from_static("keep-alive"));
    response
}

/// Serialized byte size of the request's tools array (0 when absent).
/// Numeric metadata only — never log spec bodies or payload fragments.
fn tools_json_bytes(tools: Option<&Value>) -> usize {
    tools
        .and_then(|value| serde_json::to_string(value).ok())
        .map(|serialized| serialized.len())
        .unwrap_or(0)
}

fn normalize_chat_payload_for_provider(
    payload: &mut Value,
    entry: &ModelEntry,
    prompt_cache_claude_enabled: bool,
    prompt_cache_affinity_override: Option<&str>,
    service_tier_env_default: Option<&str>,
    reporting_context: Option<&ReportingContext>,
    route: &'static str,
) {
    let had_internal_params = payload.get("params").is_some();
    let tool_slimming_active = tool_slimming_enabled_for(entry)
        && payload
            .get("tools")
            .and_then(Value::as_array)
            .is_some_and(|tools| !tools.is_empty());
    let tools_bytes_preslim = if tool_slimming_active {
        tools_json_bytes(payload.get("tools"))
    } else {
        0
    };
    let chat_service_tier = extract_service_tier(payload);
    apply_prompt_cache_and_reasoning(
        payload,
        entry,
        prompt_cache_claude_enabled,
        prompt_cache_affinity_override,
    );
    if tool_slimming_active {
        info!(
            route,
            model_alias = %entry.alias,
            provider_kind = ?entry.provider_kind,
            tool_count = json_array_len(payload.get("tools")),
            tools_bytes_preslim,
            tools_bytes = tools_json_bytes(payload.get("tools")),
            chat_id = reporting_chat_id(reporting_context),
            message_id = reporting_message_id(reporting_context),
            session_id = reporting_session_id(reporting_context),
            debug_request_id = reporting_debug_request_id(reporting_context),
            upstream_request_id = reporting_upstream_request_id(reporting_context),
            "Applied tool-spec slimming before provider dispatch",
        );
    }
    apply_openai_service_tier(
        payload,
        entry,
        chat_service_tier.as_deref(),
        service_tier_env_default,
    );
    if had_internal_params {
        warn!(
            route,
            chat_id = reporting_chat_id(reporting_context),
            message_id = reporting_message_id(reporting_context),
            session_id = reporting_session_id(reporting_context),
            debug_request_id = reporting_debug_request_id(reporting_context),
            upstream_request_id = reporting_upstream_request_id(reporting_context),
            "Consumed and stripped Open WebUI internal params before provider dispatch",
        );
    }
}

fn ultra_request_requested(payload: &Value) -> bool {
    payload.get("reasoning_effort").and_then(Value::as_str) == Some("ultra")
        || payload
            .pointer("/params/reasoning_effort")
            .and_then(Value::as_str)
            == Some("ultra")
}

fn ultra_reserved_controls_present(payload: &Value) -> bool {
    payload.get("multi_agent").is_some() || payload.pointer("/params/multi_agent").is_some()
}

async fn claim_ultra_initial_run(
    state: &AppState,
    origin: &ultra_multi_agent::TrustedInteractiveOrigin,
) -> bool {
    if !state.local_bearer_auth_enabled {
        return false;
    }
    const CLAIM_TTL: Duration = ULTRA_MAX_WALL_TIME;
    const MAX_CLAIMS: usize = 4096;
    let now = Instant::now();
    let key = format!("{}:{}", origin.context_digest, origin.fingerprint);
    let mut claims = state.ultra_run_claims.lock().await;
    claims.retain(|_, expires_at| *expires_at > now);
    if claims.contains_key(&key) || claims.len() >= MAX_CLAIMS {
        return false;
    }
    claims.insert(key, now + CLAIM_TTL);
    true
}

fn ultra_prompt_cache_key(origin: &ultra_multi_agent::TrustedInteractiveOrigin) -> String {
    // The verified run fingerprint is already a high-entropy, request-specific
    // digest and fits the Responses API's 64-character prompt-cache key limit.
    origin.fingerprint.clone()
}

fn strip_ultra_local_subagent_tools(responses_object: &mut Map<String, Value>) {
    let Some(tools) = responses_object
        .get_mut("tools")
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    tools.retain(|tool| {
        let tool_type = tool.get("type").and_then(Value::as_str).unwrap_or("");
        let name = tool.get("name").and_then(Value::as_str).unwrap_or("");
        !((tool_type == "function" && name.starts_with("subagents_"))
            || (tool_type == "namespace" && name == "subagents"))
    });
}

fn prepare_ultra_responses_payload(
    mut payload: Value,
    entry: &ModelEntry,
    cache_key: &str,
    service_tier_env_default: Option<&str>,
) -> Result<Value> {
    let chat_service_tier = extract_service_tier(&payload);
    let object = payload
        .as_object_mut()
        .ok_or_else(|| anyhow!("chat completion request must be a JSON object"))?;
    object.remove("reasoning_effort");
    object.remove("reasoning");
    object.remove("params");
    object.remove("metadata");
    object.remove("previous_response_id");

    let mut responses_payload = chat_completion_to_responses_payload(&payload, entry)?;
    let responses_object = responses_payload
        .as_object_mut()
        .ok_or_else(|| anyhow!("translated Ultra request must be a JSON object"))?;
    responses_object.retain(|key, _| {
        matches!(
            key.as_str(),
            "model"
                | "input"
                | "instructions"
                | "tools"
                | "tool_choice"
                | "stream"
                | "max_output_tokens"
                | "parallel_tool_calls"
                | "truncation"
                | "text"
        )
    });
    strip_ultra_local_subagent_tools(responses_object);
    responses_object.insert(
        "model".to_string(),
        Value::String(entry.provider_model.clone()),
    );
    responses_object.insert("store".to_string(), Value::Bool(true));
    responses_object.insert("stream".to_string(), Value::Bool(true));
    let existing_instructions = responses_object
        .get("instructions")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let ultra_instructions = if existing_instructions.is_empty() {
        ULTRA_HOSTED_AGENT_INSTRUCTIONS.to_string()
    } else {
        format!("{existing_instructions}\n\n{ULTRA_HOSTED_AGENT_INSTRUCTIONS}")
    };
    responses_object.insert(
        "instructions".to_string(),
        Value::String(ultra_instructions),
    );
    responses_object.insert(
        "multi_agent".to_string(),
        json!({"enabled": true, "max_concurrent_subagents": 4}),
    );
    responses_object.insert("reasoning".to_string(), json!({"effort": "max"}));
    responses_object.insert(
        "prompt_cache_key".to_string(),
        Value::String(cache_key.to_string()),
    );
    responses_object.insert(
        "prompt_cache_retention".to_string(),
        Value::String("24h".to_string()),
    );
    responses_object.remove("reasoning_effort");
    responses_object.remove("previous_response_id");
    // Inserted after the retain allowlist on purpose: only the bridge-chosen
    // tier (chat value or fleet default) reaches the hosted Ultra run.
    apply_openai_service_tier(
        &mut responses_payload,
        entry,
        chat_service_tier.as_deref(),
        service_tier_env_default,
    );
    Ok(responses_payload)
}

fn ultra_root_response(
    entry: &ModelEntry,
    response_id: String,
    text: String,
    usage: Value,
    child_agent_count: u64,
) -> Response<Body> {
    let chat_usage = ultra_chat_usage_with_cost(entry, &usage);
    let created = now_epoch_seconds() as i64;
    let audit = UltraAudit {
        child_agent_count,
        ..UltraAudit::default()
    };
    let root_chunk = json!({
        "id": response_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": &entry.alias,
        "choices": [{
            "index": 0,
            "delta": {"role": "assistant", "content": text},
            "finish_reason": "stop",
        }],
        "usage": chat_usage,
        "ultra_audit": ultra_audit_value(&audit),
    });
    let chunks = [sse_data_bytes(&root_chunk), sse_done_bytes()];
    let total_len = chunks.iter().map(Bytes::len).sum();
    let mut wire = Vec::with_capacity(total_len);
    for chunk in chunks {
        wire.extend_from_slice(&chunk);
    }
    let mut response = Response::new(Body::from(wire));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    if let Ok(value) = HeaderValue::from_str(&child_agent_count.to_string()) {
        response
            .headers_mut()
            .insert(HeaderName::from_static("x-portico-ultra-child-count"), value);
    }
    response
}

fn ultra_chat_usage_with_cost(entry: &ModelEntry, usage: &Value) -> Value {
    let mut chat_usage = response_usage_to_chat_usage(usage);
    let cost = chat_usage
        .as_object()
        .and_then(|usage_object| compute_usage_cost(entry, usage_object));
    if let (Some(usage_object), Some(cost)) = (chat_usage.as_object_mut(), cost) {
        usage_object.insert("cost".to_string(), json!(cost));
    }
    chat_usage
}

async fn report_ultra_round_usage(
    state: &AppState,
    reporting_context: Option<&ReportingContext>,
    reporting_call_id: &str,
    round: u64,
    entry: &ModelEntry,
    usage: &Value,
) {
    let chat_usage = ultra_chat_usage_with_cost(entry, usage);
    let round_call_id = format!("{reporting_call_id}:ultra:{round}");
    maybe_report_usage_event(
        state,
        reporting_context,
        &round_call_id,
        &entry.alias,
        &entry.alias,
        &chat_usage,
        context_tokens_from_billed_usage(&chat_usage),
    )
    .await;
}

fn ultra_private_batch_response(token: &str) -> Response<Body> {
    let control = json!({"__portico_ultra_private_batch": {"token": token}});
    let wire = format!(
        "data: {}\n\ndata: [DONE]\n\n",
        serde_json::to_string(&control).expect("private Ultra control serialization")
    );
    let mut response = Response::new(Body::from(wire));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
}

fn ultra_child_agent_count(output: &[Value]) -> u64 {
    output
        .iter()
        .filter_map(|item| {
            item.pointer("/agent/agent_name")
                .and_then(Value::as_str)
                .or_else(|| item.get("agent_name").and_then(Value::as_str))
        })
        .filter(|agent_name| agent_name.starts_with("/root/"))
        .collect::<BTreeSet<_>>()
        .len() as u64
}

fn ultra_child_tool_call_count(calls: &[UltraToolCall]) -> u64 {
    calls
        .iter()
        .filter(|call| call.agent_name.starts_with("/root/"))
        .count() as u64
}

fn ultra_audit_value(audit: &UltraAudit) -> Value {
    json!({
        "child_agent_count": audit.child_agent_count,
        "tool_call_count": audit.tool_call_count,
        "child_tool_call_count": audit.child_tool_call_count,
        "tool_result_count": audit.tool_result_count,
        "continuation_count": audit.continuation_count,
        "arguments_logged": false,
        "results_logged": false,
    })
}

fn validate_ultra_turn_limits(
    round_state: &OpaqueRoundState,
    audit: &UltraAudit,
    started_at: Instant,
) -> Result<()> {
    let transcript_bytes = serde_json::to_vec(&round_state.transcript)
        .context("serialize Ultra transcript for bounded-state validation")?
        .len();
    if transcript_bytes > ULTRA_MAX_TRANSCRIPT_BYTES
        || audit.tool_call_count > ULTRA_MAX_TOTAL_CALLS
        || audit.continuation_count > ULTRA_MAX_CONTINUATIONS
        || round_state.cumulative_usage.total_tokens > ULTRA_MAX_CUMULATIVE_TOKENS
        || round_state.cumulative_usage.cost_microusd > ULTRA_MAX_COST_MICROUSD
        || started_at.elapsed() > ULTRA_MAX_WALL_TIME
    {
        return Err(anyhow!("Ultra turn exceeded a bounded resource limit"));
    }
    Ok(())
}

fn validate_ultra_batch_call_count(calls: &[UltraToolCall]) -> Result<()> {
    if calls.is_empty() || calls.len() > ULTRA_MAX_CALLS_PER_BATCH {
        return Err(anyhow!("Ultra tool batch exceeded its call-count limit"));
    }
    Ok(())
}

fn ultra_remaining_wall_time(started_at: Instant) -> Option<Duration> {
    ULTRA_MAX_WALL_TIME
        .checked_sub(started_at.elapsed())
        .filter(|remaining| !remaining.is_zero())
}

fn ultra_batch_expiry(started_at: Instant, now: Instant) -> Instant {
    (now + Duration::from_secs(15 * 60)).min(started_at + ULTRA_MAX_WALL_TIME)
}

fn ultra_batch_is_expired(batch: &UltraStoredBatch, now: Instant) -> bool {
    batch.expires_at <= now || batch.started_at.elapsed() >= ULTRA_MAX_WALL_TIME
}

fn ultra_batch_resident_bytes(batch: &UltraStoredBatch) -> Result<usize> {
    let payload_bytes = serde_json::to_vec(&batch.responses_payload)
        .context("serialize Ultra resident request state")?
        .len();
    let round_bytes = serde_json::to_vec(&batch.round_state)
        .context("serialize Ultra resident round state")?
        .len();
    let call_bytes = serde_json::to_vec(&batch.calls)
        .context("serialize Ultra resident call state")?
        .len();
    payload_bytes
        .checked_add(round_bytes)
        .and_then(|total| total.checked_add(call_bytes))
        .and_then(|total| total.checked_add(4096))
        .ok_or_else(|| anyhow!("Ultra resident state size overflow"))
}

fn ultra_resident_capacity_available(resident_bytes: usize, candidate_bytes: usize) -> bool {
    candidate_bytes <= ULTRA_MAX_RESIDENT_BYTES
        && resident_bytes
            .checked_add(candidate_bytes)
            .is_some_and(|total| total <= ULTRA_MAX_RESIDENT_BYTES)
}

fn insert_ultra_batch(
    batches: &mut HashMap<String, UltraStoredBatch>,
    token: String,
    batch: UltraStoredBatch,
) -> Result<()> {
    let now = Instant::now();
    batches.retain(|_, resident| !ultra_batch_is_expired(resident, now));
    if batches.len() >= ULTRA_MAX_RESIDENT_BATCHES {
        return Err(anyhow!("Ultra batch capacity is unavailable"));
    }
    let candidate_bytes = ultra_batch_resident_bytes(&batch)?;
    let resident_bytes = batches.values().try_fold(0usize, |total, resident| {
        total
            .checked_add(ultra_batch_resident_bytes(resident)?)
            .ok_or_else(|| anyhow!("Ultra resident state size overflow"))
    })?;
    if !ultra_resident_capacity_available(resident_bytes, candidate_bytes) {
        return Err(anyhow!("Ultra resident byte capacity is unavailable"));
    }
    batches.insert(token, batch);
    Ok(())
}

fn ultra_batch_error(status: StatusCode, message: &'static str) -> Response<Body> {
    json_error(status, message)
}

fn expired_ultra_batch_error(batch: &mut UltraStoredBatch) -> Response<Body> {
    batch.admission.expire();
    match batch.admission.poll() {
        ultra_multi_agent::DispatchPoll::ExpiredAmbiguous => ultra_batch_error(
            StatusCode::CONFLICT,
            "Ultra tool dispatch outcome is ambiguous; automatic retry is forbidden",
        ),
        _ => ultra_batch_error(StatusCode::GONE, "Ultra tool batch expired before dispatch"),
    }
}

async fn ultra_batch_claim(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Response<Body> {
    let now = Instant::now();
    let mut batches = state.ultra_batches.lock().await;
    let expired = batches
        .get(&token)
        .map(|batch| ultra_batch_is_expired(batch, now))
        .unwrap_or(false);
    if expired {
        let mut batch = batches.remove(&token).expect("checked Ultra batch");
        return expired_ultra_batch_error(&mut batch);
    }
    let Some(batch) = batches.get_mut(&token) else {
        return ultra_batch_error(StatusCode::NOT_FOUND, "Ultra tool batch is unavailable");
    };
    if batch.claimed {
        return ultra_batch_error(
            StatusCode::CONFLICT,
            "Ultra tool batch was already claimed by a worker",
        );
    }
    batch.claimed = true;
    let calls = batch
        .calls
        .iter()
        .map(|call| {
            json!({
                "call_id": call.call_id,
                "name": call.registered_name,
                "arguments": call.arguments,
                "payload_digest": call.payload_digest,
                "output_index": call.output_index,
            })
        })
        .collect::<Vec<_>>();
    Json(json!({
        "calls": calls,
        "ultra_audit": ultra_audit_value(&batch.audit),
    }))
    .into_response()
}

async fn ultra_batch_dispatch_start(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Json(marker): Json<UltraDispatchMarker>,
) -> Response<Body> {
    let now = Instant::now();
    let mut batches = state.ultra_batches.lock().await;
    let expired = batches
        .get(&token)
        .map(|batch| ultra_batch_is_expired(batch, now))
        .unwrap_or(false);
    if expired {
        let mut batch = batches.remove(&token).expect("checked Ultra batch");
        return expired_ultra_batch_error(&mut batch);
    }
    let Some(batch) = batches.get_mut(&token) else {
        return ultra_batch_error(StatusCode::NOT_FOUND, "Ultra tool batch is unavailable");
    };
    if !batch.claimed {
        return ultra_batch_error(
            StatusCode::CONFLICT,
            "Ultra tool batch must be claimed before dispatch",
        );
    }
    let marker_matches = batch
        .calls
        .iter()
        .any(|call| call.call_id == marker.call_id && call.payload_digest == marker.payload_digest);
    if !marker_matches {
        batches.remove(&token);
        return ultra_batch_error(
            StatusCode::CONFLICT,
            "Ultra tool dispatch identity validation failed",
        );
    }
    if batch
        .admission
        .start_dispatch(&marker.call_id, now_epoch_seconds())
        .is_err()
    {
        batches.remove(&token);
        return ultra_batch_error(
            StatusCode::CONFLICT,
            "Ultra tool dispatch was already started or is out of order",
        );
    }
    StatusCode::NO_CONTENT.into_response()
}

async fn ultra_batch_heartbeat(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Json(marker): Json<UltraDispatchMarker>,
) -> Response<Body> {
    let now = Instant::now();
    let mut batches = state.ultra_batches.lock().await;
    let expired = batches
        .get(&token)
        .map(|batch| ultra_batch_is_expired(batch, now))
        .unwrap_or(false);
    if expired {
        let mut batch = batches.remove(&token).expect("checked Ultra batch");
        return expired_ultra_batch_error(&mut batch);
    }
    let Some(batch) = batches.get_mut(&token) else {
        return ultra_batch_error(StatusCode::NOT_FOUND, "Ultra tool batch is unavailable");
    };
    let marker_matches = batch
        .calls
        .iter()
        .any(|call| call.call_id == marker.call_id && call.payload_digest == marker.payload_digest);
    if !marker_matches
        || batch
            .admission
            .heartbeat(&marker.call_id, now_epoch_seconds())
            .is_err()
    {
        batches.remove(&token);
        return ultra_batch_error(
            StatusCode::CONFLICT,
            "Ultra tool dispatch heartbeat validation failed",
        );
    }
    batch.expires_at = ultra_batch_expiry(batch.started_at, now);
    StatusCode::NO_CONTENT.into_response()
}

fn bounded_ultra_tool_output(output: Value) -> Result<String> {
    const MAX_RESULT_BYTES: usize = 256 * 1024;
    let serialized = match output {
        Value::String(text) => text,
        other => serde_json::to_string(&other).context("serialize Ultra tool result")?,
    };
    if serialized.len() > MAX_RESULT_BYTES {
        return Err(anyhow!("Ultra tool result exceeds the per-result limit"));
    }
    Ok(serialized)
}

async fn dispatch_ultra_continuation(
    state: &AppState,
    responses_payload: &Value,
    upstream_timeout: Duration,
) -> Result<BufferedOutcome> {
    let mut upstream_headers = proxy_headers(&state.portico_api_key, &state.provider_headers)
        .context("prepare Ultra continuation authentication")?;
    upstream_headers.insert(
        HeaderName::from_static(BETA_HEADER_NAME),
        HeaderValue::from_static(BETA_HEADER_VALUE),
    );
    let responses_url = openai_responses_url(&state.llm_proxy_base_url);
    let upstream = state
        .client
        .post(responses_url)
        .headers(upstream_headers)
        .timeout(upstream_timeout)
        .json(responses_payload)
        .send()
        .await
        .context("Ultra continuation request failed")?;
    if !upstream.status().is_success() {
        return Err(anyhow!("Ultra continuation was rejected"));
    }
    if !upstream
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.contains("text/event-stream"))
        .unwrap_or(false)
    {
        return Err(anyhow!(
            "Ultra continuation returned an invalid response type"
        ));
    }

    const MAX_BUFFERED_ULTRA_BYTES: usize = 32 * 1024 * 1024;
    let mut stream = upstream.bytes_stream();
    let mut buffered = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("Ultra continuation stream ended unexpectedly")?;
        if buffered.len().saturating_add(chunk.len()) > MAX_BUFFERED_ULTRA_BYTES {
            return Err(anyhow!("Ultra continuation exceeded the safe buffer limit"));
        }
        buffered.extend_from_slice(&chunk);
    }
    parse_buffered_sse(&buffered).map_err(|error| anyhow!("{error}"))
}

async fn store_continuation_ultra_batch(
    state: &AppState,
    mut previous: UltraStoredBatch,
    responses_payload: Value,
    response_id: String,
    mut calls: Vec<UltraToolCall>,
    usage: Value,
    output: Vec<Value>,
) -> Result<String> {
    validate_ultra_batch_call_count(&calls)?;
    let token = Uuid::new_v4().simple().to_string();
    let tool_snapshot = responses_payload
        .get("tools")
        .ok_or_else(|| anyhow!("Ultra request tool snapshot is missing"))?;
    for call in &mut calls {
        call.bind_to_tool_snapshot(tool_snapshot)
            .map_err(|error| anyhow!("{error}"))?;
    }
    previous.audit.child_agent_count = previous
        .audit
        .child_agent_count
        .max(ultra_child_agent_count(&output));
    previous.round_state.transcript.extend(output);
    previous
        .round_state
        .add_unique_calls(&calls)
        .map_err(|error| anyhow!("{error}"))?;
    let chat_usage = ultra_chat_usage_with_cost(&previous.entry, &usage);
    if !previous
        .round_state
        .cumulative_usage
        .observe(&response_id, &chat_usage)
    {
        return Err(anyhow!("Ultra response ID was already observed"));
    }
    let mut next_payload = responses_payload;
    next_payload["input"] = Value::Array(Vec::new());
    next_payload["store"] = Value::Bool(true);
    next_payload["previous_response_id"] = Value::String(response_id.clone());

    let mut admission =
        OrderedBatchAdmission::reserve_batch(token.clone(), calls.len(), now_epoch_seconds())
            .map_err(|error| anyhow!("{error}"))?;
    admission
        .claim_stable_response_id(&response_id)
        .map_err(|error| anyhow!("{error}"))?;
    for (position, call) in calls.iter().enumerate() {
        admission
            .reserve_call(position, &call.call_id, &call.payload_digest)
            .map_err(|error| anyhow!("{error}"))?;
    }
    previous.audit.tool_call_count = previous
        .audit
        .tool_call_count
        .saturating_add(calls.len() as u64);
    previous.audit.child_tool_call_count = previous
        .audit
        .child_tool_call_count
        .saturating_add(ultra_child_tool_call_count(&calls));
    validate_ultra_turn_limits(&previous.round_state, &previous.audit, previous.started_at)?;
    previous.expires_at = ultra_batch_expiry(previous.started_at, Instant::now());
    previous.responses_payload = next_payload;
    previous.calls = calls;
    previous.admission = admission;
    previous.claimed = false;

    let mut batches = state.ultra_batches.lock().await;
    insert_ultra_batch(&mut batches, token.clone(), previous)?;
    Ok(token)
}

async fn ultra_batch_results(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Json(submitted): Json<UltraToolResults>,
) -> Response<Body> {
    let mut batch = {
        let mut batches = state.ultra_batches.lock().await;
        let Some(batch) = batches.remove(&token) else {
            return ultra_batch_error(
                StatusCode::NOT_FOUND,
                "Ultra tool batch state is unavailable; dispatch outcome may be ambiguous",
            );
        };
        batch
    };
    if batch.expires_at <= Instant::now() {
        return expired_ultra_batch_error(&mut batch);
    }
    if batch.started_at.elapsed() > ULTRA_MAX_WALL_TIME
        || batch.audit.continuation_count >= ULTRA_MAX_CONTINUATIONS
    {
        return ultra_batch_error(
            StatusCode::CONFLICT,
            "Ultra turn exceeded its continuation or wall-clock limit",
        );
    }
    if !batch.claimed || submitted.results.len() != batch.calls.len() {
        return ultra_batch_error(
            StatusCode::CONFLICT,
            "Ultra tool results do not match the claimed batch",
        );
    }
    let Some(previous_response_id) = batch.admission.stable_response_id().map(str::to_string)
    else {
        return ultra_batch_error(
            StatusCode::CONFLICT,
            "Ultra tool batch lost its provider response identity",
        );
    };

    const MAX_BATCH_RESULT_BYTES: usize = 1024 * 1024;
    let mut total_bytes = 0usize;
    let mut function_outputs = Vec::with_capacity(submitted.results.len());
    for (call, result) in batch.calls.iter().zip(submitted.results) {
        if call.call_id != result.call_id || call.payload_digest != result.payload_digest {
            return ultra_batch_error(
                StatusCode::CONFLICT,
                "Ultra tool result identity or ordering validation failed",
            );
        }
        let output = match bounded_ultra_tool_output(result.output) {
            Ok(output) => output,
            Err(_) => {
                return ultra_batch_error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Ultra tool result exceeded the safe output limit",
                )
            }
        };
        total_bytes = total_bytes.saturating_add(output.len());
        if total_bytes > MAX_BATCH_RESULT_BYTES {
            return ultra_batch_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Ultra tool result batch exceeded the safe output limit",
            );
        }
        if batch
            .admission
            .complete(&call.call_id, now_epoch_seconds())
            .is_err()
        {
            return ultra_batch_error(
                StatusCode::CONFLICT,
                "Ultra tool result was submitted without one dispatch",
            );
        }
        function_outputs.push(json!({
            "type": "function_call_output",
            "call_id": call.call_id,
            "output": output,
        }));
    }

    batch.audit.tool_result_count = batch
        .audit
        .tool_result_count
        .saturating_add(function_outputs.len() as u64);
    batch.audit.continuation_count = batch.audit.continuation_count.saturating_add(1);
    batch
        .round_state
        .transcript
        .extend(function_outputs.iter().cloned());
    if validate_ultra_turn_limits(&batch.round_state, &batch.audit, batch.started_at).is_err() {
        return ultra_batch_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Ultra turn exceeded a bounded resource limit",
        );
    }
    let mut responses_payload = batch.responses_payload.clone();
    responses_payload["input"] = Value::Array(function_outputs);
    responses_payload["store"] = Value::Bool(true);
    responses_payload["stream"] = Value::Bool(true);
    responses_payload["previous_response_id"] = Value::String(previous_response_id);

    let Some(upstream_timeout) = ultra_remaining_wall_time(batch.started_at) else {
        return ultra_batch_error(
            StatusCode::CONFLICT,
            "Ultra turn exceeded its continuation or wall-clock limit",
        );
    };
    let outcome =
        match dispatch_ultra_continuation(&state, &responses_payload, upstream_timeout).await {
            Ok(outcome) => outcome,
            Err(_) => {
                return ultra_batch_error(
                    StatusCode::BAD_GATEWAY,
                    "Ultra continuation failed after dispatch; automatic retry is forbidden",
                )
            }
        };
    match outcome {
        BufferedOutcome::RootFinal {
            response_id,
            text,
            usage,
            output,
        } => {
            report_ultra_round_usage(
                &state,
                batch.reporting_context.as_ref(),
                &batch.reporting_call_id,
                batch.audit.continuation_count,
                &batch.entry,
                &usage,
            )
            .await;
            let chat_usage = ultra_chat_usage_with_cost(&batch.entry, &usage);
            if !batch
                .round_state
                .cumulative_usage
                .observe(&response_id, &chat_usage)
            {
                return ultra_batch_error(
                    StatusCode::CONFLICT,
                    "Ultra continuation reused a response identity",
                );
            }
            batch.audit.child_agent_count = batch
                .audit
                .child_agent_count
                .max(ultra_child_agent_count(&output));
            batch.round_state.transcript.extend(output);
            if validate_ultra_turn_limits(&batch.round_state, &batch.audit, batch.started_at)
                .is_err()
            {
                return ultra_batch_error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Ultra turn exceeded a bounded resource limit",
                );
            }
            if batch.audit.child_agent_count == 0 {
                return ultra_batch_error(
                    StatusCode::BAD_GATEWAY,
                    "Ultra upstream did not use a hosted child agent",
                );
            }
            Json(json!({
                "kind": "final",
                "content": text,
                "usage": batch.round_state.cumulative_usage.as_chat_usage(),
                "ultra_audit": ultra_audit_value(&batch.audit),
            }))
            .into_response()
        }
        BufferedOutcome::ToolBatch {
            response_id,
            calls,
            usage,
            output,
        } => {
            report_ultra_round_usage(
                &state,
                batch.reporting_context.as_ref(),
                &batch.reporting_call_id,
                batch.audit.continuation_count,
                &batch.entry,
                &usage,
            )
            .await;
            match store_continuation_ultra_batch(
                &state,
                batch,
                responses_payload,
                response_id,
                calls,
                usage,
                output,
            )
            .await
            {
                Ok(token) => Json(json!({
                    "kind": "batch",
                    "token": token,
                }))
                .into_response(),
                Err(_) => ultra_batch_error(
                    StatusCode::CONFLICT,
                    "Ultra continuation batch could not be safely reserved",
                ),
            }
        }
    }
}

async fn store_initial_ultra_batch(
    state: &AppState,
    origin: &ultra_multi_agent::TrustedInteractiveOrigin,
    started_at: Instant,
    entry: ModelEntry,
    mut responses_payload: Value,
    response_id: String,
    mut calls: Vec<UltraToolCall>,
    usage: Value,
    output: Vec<Value>,
    reporting_context: Option<ReportingContext>,
    reporting_call_id: String,
) -> Result<String> {
    validate_ultra_batch_call_count(&calls)?;
    let token = Uuid::new_v4().simple().to_string();
    let tool_snapshot = responses_payload
        .get("tools")
        .ok_or_else(|| anyhow!("Ultra request tool snapshot is missing"))?;
    for call in &mut calls {
        call.bind_to_tool_snapshot(tool_snapshot)
            .map_err(|error| anyhow!("{error}"))?;
    }
    let child_agent_count = ultra_child_agent_count(&output);
    let mut transcript = responses_payload
        .get("input")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| anyhow!("Ultra replay input is missing"))?;
    transcript.extend(output);
    responses_payload["input"] = Value::Array(Vec::new());
    responses_payload["store"] = Value::Bool(true);
    responses_payload["previous_response_id"] = Value::String(response_id.clone());

    let mut round_state = OpaqueRoundState::new(origin.fingerprint.clone(), transcript);
    round_state
        .add_unique_calls(&calls)
        .map_err(|error| anyhow!("{error}"))?;
    let chat_usage = ultra_chat_usage_with_cost(&entry, &usage);
    if !round_state
        .cumulative_usage
        .observe(&response_id, &chat_usage)
    {
        return Err(anyhow!("Ultra response ID was already observed"));
    }

    let mut admission =
        OrderedBatchAdmission::reserve_batch(token.clone(), calls.len(), now_epoch_seconds())
            .map_err(|error| anyhow!("{error}"))?;
    admission
        .claim_stable_response_id(&response_id)
        .map_err(|error| anyhow!("{error}"))?;
    for (position, call) in calls.iter().enumerate() {
        admission
            .reserve_call(position, &call.call_id, &call.payload_digest)
            .map_err(|error| anyhow!("{error}"))?;
    }

    let audit = UltraAudit {
        child_agent_count,
        tool_call_count: calls.len() as u64,
        child_tool_call_count: ultra_child_tool_call_count(&calls),
        ..UltraAudit::default()
    };
    validate_ultra_turn_limits(&round_state, &audit, started_at)?;
    let batch = UltraStoredBatch {
        started_at,
        expires_at: ultra_batch_expiry(started_at, Instant::now()),
        entry,
        responses_payload,
        round_state,
        calls,
        admission,
        claimed: false,
        audit,
        reporting_context,
        reporting_call_id,
    };
    let mut batches = state.ultra_batches.lock().await;
    insert_ultra_batch(&mut batches, token.clone(), batch)?;
    Ok(token)
}

async fn chat_completions_via_ultra(
    state: AppState,
    headers: HeaderMap,
    exact_body: Bytes,
    payload: Value,
    entry: ModelEntry,
    reporting_context: Option<ReportingContext>,
    reporting_call_id: String,
) -> Response<Body> {
    let started_at = Instant::now();
    if exact_body.len() > ULTRA_MAX_INITIAL_BODY_BYTES {
        return json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Ultra request exceeded the private body limit",
        );
    }
    if entry.base_model != "gpt-5.6-sol" {
        return json_error(
            StatusCode::BAD_REQUEST,
            "Ultra multi-agent mode is supported only by GPT-5.6 Sol",
        );
    }
    if payload.get("stream").and_then(Value::as_bool) != Some(true) {
        return json_error(
            StatusCode::BAD_REQUEST,
            "Ultra multi-agent mode requires stream=true",
        );
    }
    let origin = match verify_ultra_request(
        &state.ultra_multi_agent_signing_secret,
        &headers,
        &exact_body,
        now_epoch_seconds(),
    ) {
        Ok(origin) => origin,
        Err(_) => {
            return json_error(
                StatusCode::UNAUTHORIZED,
                "Authenticated Ultra interactive admission failed",
            )
        }
    };

    if !claim_ultra_initial_run(&state, &origin).await {
        return json_error(
            StatusCode::CONFLICT,
            "Ultra run is already admitted or unavailable",
        );
    }

    let ultra_cache_key = ultra_prompt_cache_key(&origin);
    let responses_payload = match prepare_ultra_responses_payload(
        payload,
        &entry,
        &ultra_cache_key,
        state.gpt_service_tier.as_deref(),
    ) {
        Ok(value) => value,
        Err(_) => {
            return json_error(
                StatusCode::BAD_REQUEST,
                "Ultra request could not be translated safely",
            )
        }
    };
    let Some(upstream_timeout) = ultra_remaining_wall_time(started_at) else {
        return json_error(
            StatusCode::CONFLICT,
            "Ultra turn exceeded its wall-clock limit",
        );
    };
    let mut upstream_headers = match proxy_headers(&state.portico_api_key, &state.provider_headers) {
        Ok(headers) => headers,
        Err(_) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Ultra upstream authentication could not be prepared",
            )
        }
    };
    upstream_headers.insert(
        HeaderName::from_static(BETA_HEADER_NAME),
        HeaderValue::from_static(BETA_HEADER_VALUE),
    );
    let responses_url = openai_responses_url(&state.llm_proxy_base_url);
    let upstream = match state
        .client
        .post(responses_url)
        .headers(upstream_headers)
        .timeout(upstream_timeout)
        .json(&responses_payload)
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => {
            return json_error(
                StatusCode::BAD_GATEWAY,
                "Ultra upstream request did not complete",
            )
        }
    };
    let upstream_status = upstream.status();
    if !upstream_status.is_success() {
        let upstream_request_id = upstream
            .headers()
            .get("x-request-id")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("-")
            .to_string();
        let upstream_message = upstream
            .text()
            .await
            .map(|body| normalize_upstream_error_message(&body, upstream_status))
            .unwrap_or_else(|_| format!("Upstream returned HTTP {upstream_status}"));
        warn!(
            route = "ultra_multi_agent",
            model = %entry.alias,
            status = %upstream_status,
            upstream_request_id,
            upstream_message = %upstream_message,
            "Ultra upstream request was rejected",
        );
        return json_error(
            StatusCode::BAD_GATEWAY,
            "Ultra upstream request was rejected",
        );
    }
    if !upstream
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.contains("text/event-stream"))
        .unwrap_or(false)
    {
        return json_error(
            StatusCode::BAD_GATEWAY,
            "Ultra upstream returned an invalid response type",
        );
    }

    const MAX_BUFFERED_ULTRA_BYTES: usize = 32 * 1024 * 1024;
    let mut stream = upstream.bytes_stream();
    let mut buffered = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(_) => {
                return json_error(
                    StatusCode::BAD_GATEWAY,
                    "Ultra upstream stream ended unexpectedly",
                )
            }
        };
        if buffered.len().saturating_add(chunk.len()) > MAX_BUFFERED_ULTRA_BYTES {
            return json_error(
                StatusCode::BAD_GATEWAY,
                "Ultra upstream response exceeded the safe buffer limit",
            );
        }
        buffered.extend_from_slice(&chunk);
    }

    match parse_buffered_sse(&buffered) {
        Ok(BufferedOutcome::RootFinal {
            response_id,
            text,
            usage,
            output,
        }) => {
            let Some(mut transcript) = responses_payload
                .get("input")
                .and_then(Value::as_array)
                .cloned()
            else {
                return json_error(
                    StatusCode::BAD_GATEWAY,
                    "Ultra terminal replay input was unavailable",
                );
            };
            let child_agent_count = ultra_child_agent_count(&output);
            transcript.extend(output);
            let chat_usage = ultra_chat_usage_with_cost(&entry, &usage);
            let mut round_state = OpaqueRoundState::new(origin.fingerprint.clone(), transcript);
            if !round_state
                .cumulative_usage
                .observe(&response_id, &chat_usage)
                || validate_ultra_turn_limits(&round_state, &UltraAudit::default(), started_at)
                    .is_err()
            {
                return json_error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Ultra terminal response exceeded a bounded resource limit",
                );
            }
            report_ultra_round_usage(
                &state,
                reporting_context.as_ref(),
                &reporting_call_id,
                0,
                &entry,
                &usage,
            )
            .await;
            if child_agent_count == 0 {
                return json_error(
                    StatusCode::BAD_GATEWAY,
                    "Ultra upstream did not use a hosted child agent",
                );
            }
            ultra_root_response(&entry, response_id, text, usage, child_agent_count)
        }
        Ok(BufferedOutcome::ToolBatch {
            response_id,
            calls,
            usage,
            output,
        }) => {
            report_ultra_round_usage(
                &state,
                reporting_context.as_ref(),
                &reporting_call_id,
                0,
                &entry,
                &usage,
            )
            .await;
            match store_initial_ultra_batch(
                &state,
                &origin,
                started_at,
                entry,
                responses_payload,
                response_id,
                calls,
                usage,
                output,
                reporting_context,
                reporting_call_id,
            )
            .await
            {
                Ok(token) => ultra_private_batch_response(&token),
                Err(_) => json_error(
                    StatusCode::CONFLICT,
                    "Ultra tool batch could not be safely reserved",
                ),
            }
        }
        Err(_) => json_error(
            StatusCode::BAD_GATEWAY,
            "Ultra upstream response failed private projection validation",
        ),
    }
}

async fn chat_completions_via_responses(
    state: AppState,
    mut payload: Value,
    entry: ModelEntry,
    prompt_cache_affinity: Option<String>,
    reporting_context: Option<ReportingContext>,
    reporting_call_id: String,
    bridge_timing: BridgeRequestTiming,
) -> Response<Body> {
    normalize_chat_payload_for_provider(
        &mut payload,
        &entry,
        state.prompt_cache_claude_enabled,
        prompt_cache_affinity.as_deref(),
        state.gpt_service_tier.as_deref(),
        reporting_context.as_ref(),
        "responses_api",
    );

    let namespace_summary = summarize_namespace_metadata(payload.get("_tool_namespaces"));
    let mut responses_payload = match chat_completion_to_responses_payload(&payload, &entry) {
        Ok(value) => value,
        Err(error) => return json_error(StatusCode::BAD_REQUEST, error.to_string()),
    };

    let is_stream = responses_payload
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let request_summary = summarize_responses_request(&responses_payload);
    let reasoning_indicator_enabled = matches!(
        request_summary.reasoning_effort.as_deref(),
        Some(effort) if !effort.eq_ignore_ascii_case("none")
    );
    let responses_context_tokens_estimate = estimate_responses_context_tokens(&responses_payload);
    let (
        endpoint_label,
        responses_url,
        upstream_headers,
        dispatch_message,
        response_message,
        bifrost_audit_headers_emitted,
    ) = match state.gpt_openai_route_mode {
        GptOpenAIRouteMode::Direct => {
            let headers = match proxy_headers(&state.portico_api_key, &state.provider_headers) {
                Ok(h) => h,
                Err(error) => {
                    return json_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("Failed to build LLM proxy headers: {error}"),
                    );
                }
            };
            (
                "openai responses",
                openai_responses_url(&state.llm_proxy_base_url),
                headers,
                "Dispatching translated Responses API request to Provider API proxy",
                "Received upstream response from Provider API proxy",
                false,
            )
        }
        GptOpenAIRouteMode::Bifrost => {
            let headers = match state
                .provider_headers
                .bifrost_headers_with_auth(&state.portico_api_key)
            {
                Ok(value) => value,
                Err(error) => {
                    return json_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("Failed to build Bifrost request headers: {error}"),
                    );
                }
            };
            (
                "bifrost responses",
                format!("{}/openai/v1/responses", state.bifrost_base_url),
                headers,
                "Dispatching translated Responses API request to Bifrost",
                "Received upstream response from Bifrost",
                true,
            )
        }
    };

    if let Some(object) = responses_payload.as_object_mut() {
        object.insert(
            "model".to_string(),
            Value::String(match state.gpt_openai_route_mode {
                GptOpenAIRouteMode::Direct => entry.provider_model.clone(),
                GptOpenAIRouteMode::Bifrost => entry.bifrost_model.clone(),
            }),
        );
    }
    info!(
        endpoint = endpoint_label,
        route = "responses_api",
        model_alias = %entry.alias,
        provider_model = %entry.provider_model,
        stream = is_stream,
        input_items = request_summary.input_items,
        top_level_tool_entries = request_summary.top_level_tool_entries,
        namespace_metadata_entries = namespace_summary.total_entries,
        core_namespace_entries = namespace_summary.core_entries,
        non_core_namespace_entries = namespace_summary.non_core_entries,
        deferred_namespace_entries = request_summary.namespace_entries,
        function_tools = request_summary.function_tools,
        eager_function_tools = request_summary.eager_function_tools,
        deferred_function_tools = request_summary.deferred_function_tools,
        tool_search_entries = request_summary.tool_search_entries,
        tool_search_enabled = request_summary.tool_search_entries > 0,
        instructions_chars = request_summary.instructions_chars,
        max_output_tokens = request_summary.max_output_tokens.unwrap_or_default(),
        prompt_cache_key_present = request_summary.prompt_cache_key_present,
        prompt_cache_key_len = request_summary.prompt_cache_key_len,
        prompt_cache_retention = request_summary.prompt_cache_retention.as_deref().unwrap_or("-"),
        reasoning_effort = request_summary.reasoning_effort.as_deref().unwrap_or("-"),
        service_tier = request_summary.service_tier.as_deref().unwrap_or("-"),
        gpt_service_tier_source = %state.gpt_service_tier_source,
        gpt_route_mode = state.gpt_openai_route_mode.as_str(),
        gpt_route_mode_source = %state.gpt_openai_route_mode_source,
        chat_id = reporting_chat_id(reporting_context.as_ref()),
        message_id = reporting_message_id(reporting_context.as_ref()),
        session_id = reporting_session_id(reporting_context.as_ref()),
        "{dispatch_message}",
    );
    log_outbound_portico_header_audit(
        if bifrost_audit_headers_emitted {
            "bifrost"
        } else {
            "llm_proxy"
        },
        endpoint_label,
        "responses_api",
        &entry.alias,
        &state.provider_headers,
        bifrost_audit_headers_emitted,
        reporting_context.as_ref(),
    );
    let request_timeout_seconds =
        (!is_stream).then_some(bridge_non_stream_request_timeout_seconds());
    let upstream_response = match send_upstream_request_with_retry(
        &state.client,
        "responses_api",
        endpoint_label,
        &entry.alias,
        is_stream,
        request_timeout_seconds,
        reporting_context.as_ref(),
        bridge_timing,
        |client| {
            let request = client
                .post(responses_url.clone())
                .headers(upstream_headers.clone());
            let request = if bifrost_audit_headers_emitted {
                apply_reporting_headers(request, reporting_context.as_ref(), true)
            } else {
                request
            };
            request_builder_with_timeout(request, request_timeout_seconds).json(&responses_payload)
        },
    )
    .await
    {
        Ok(response) => response,
        Err(error) => {
            return json_error_with_headers(
                error.status,
                error.message,
                passthrough_cost_headers(&error.headers),
            );
        }
    };

    let upstream_meta = upstream_response.meta;
    let cost_hint = extract_cost_hint(upstream_response.response.headers());
    let passthrough_headers = passthrough_cost_headers(upstream_response.response.headers());
    info!(
        endpoint = endpoint_label,
        model = %entry.alias,
        stream = is_stream,
        status = %upstream_response.response.status(),
        upstream_request_id = upstream_response
            .response
            .headers()
            .get("x-request-id")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("-"),
        cost_hint = cost_hint.unwrap_or_default(),
        gpt_route_mode = state.gpt_openai_route_mode.as_str(),
        gpt_route_mode_source = %state.gpt_openai_route_mode_source,
        chat_id = reporting_chat_id(reporting_context.as_ref()),
        message_id = reporting_message_id(reporting_context.as_ref()),
        "{response_message}",
    );

    if !is_stream {
        let status = upstream_response.response.status();
        let mut body = match upstream_response.response.json::<Value>().await {
            Ok(value) => responses_value_to_chat_completion(value, &entry, cost_hint),
            Err(error) => {
                return json_error(
                    StatusCode::BAD_GATEWAY,
                    format!("Invalid {endpoint_label} JSON: {error}"),
                );
            }
        };
        let response_id = body
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("resp_unknown");
        let finish_reason = body
            .pointer("/choices/0/finish_reason")
            .and_then(Value::as_str)
            .unwrap_or("-");
        let served_service_tier = body
            .pointer("/usage/service_tier")
            .and_then(Value::as_str)
            .unwrap_or("-");
        info!(
            endpoint = endpoint_label,
            model = %entry.alias,
            response_id,
            finish_reason,
            served_service_tier,
            usage = %body
                .get("usage")
                .map(summarize_usage_for_log)
                .unwrap_or_else(|| "none".to_string()),
            "Translated non-stream Responses API response to chat completion payload",
        );
        // Live occupancy for the client: billed prompt_tokens aggregates
        // hidden passes on pro-mode reasoning models, so the usage payload
        // carries the clamped request-side estimate alongside it.
        if let Some(estimate) = responses_context_tokens_estimate.filter(|value| *value > 0) {
            let clamped = body.get("usage").map(|usage| clamped_context_estimate(usage, estimate));
            if let (Some(clamped), Some(usage_object)) =
                (clamped, body.get_mut("usage").and_then(Value::as_object_mut))
            {
                usage_object.insert("context_tokens".to_string(), json!(clamped));
            }
        }
        if let Some(usage) = body.get("usage") {
            maybe_report_usage_event(
                &state,
                reporting_context.as_ref(),
                &reporting_call_id,
                &entry.alias,
                &entry.alias,
                usage,
                responses_context_tokens_estimate,
            )
            .await;
        }
        log_bridge_upstream_response_complete(
            "responses_api",
            endpoint_label,
            &entry.alias,
            reporting_context.as_ref(),
            bridge_timing,
            upstream_meta,
            status,
        );
        let mut http_response = (status, Json(body)).into_response();
        merge_response_headers(&mut http_response, &passthrough_headers);
        return http_response;
    }

    let stream = upstream_response.response.bytes_stream();
    let stream_model = entry.alias.clone();
    let stream_timeout_config = state.stream_timeout_config;
    let stream_started_at = Instant::now();
    let body_stream = try_stream! {
        let mut pending = Utf8LineBuffer::default();
        let mut current_event_name: Option<String> = None;
        let mut stream_state = ResponsesStreamState::default();
        stream_state.reasoning_indicator_enabled = reasoning_indicator_enabled;
        let mut emitted_stream_error = false;
        let mut saw_upstream_progress = false;
        let mut logged_first_client_token = false;
        info!(
            endpoint = endpoint_label,
            model = %stream_model,
            chat_id = reporting_chat_id(reporting_context.as_ref()),
            message_id = reporting_message_id(reporting_context.as_ref()),
            "Starting translated Responses stream handling",
        );
        futures_util::pin_mut!(stream);

        loop {
            let chunk = match next_stream_item_with_timeouts(
                stream.as_mut(),
                stream_started_at,
                stream_timeout_config,
                saw_upstream_progress,
                None,
            )
            .await
            {
                Ok(Some(chunk)) => chunk,
                Ok(None) => break,
                Err(error) => {
                    let raw_error = error.raw_error();
                    warn!(
                        endpoint = endpoint_label,
                        model = %stream_model,
                        timeout_layer = error.layer.as_str(),
                        progress_phase = error.progress_phase.as_str(),
                        timeout_seconds = error.timeout.as_secs(),
                        effective_idle_timeout_seconds = error.effective_idle_timeout.as_secs(),
                        elapsed_ms = error.elapsed.as_millis() as u64,
                        error = %raw_error,
                        response_id = stream_state.response_id.as_deref().unwrap_or("resp_unknown"),
                        event_count = stream_state.event_count,
                        last_event = stream_state.last_event_name.as_deref().unwrap_or("-"),
                        chat_id = reporting_chat_id(reporting_context.as_ref()),
                        message_id = reporting_message_id(reporting_context.as_ref()),
                        session_id = reporting_session_id(reporting_context.as_ref()),
                        "Emitting synthetic OpenAI stream error after responses stream timeout",
                    );
                    for output in openai_stream_error_chunks(&raw_error) {
                        yield output;
                    }
                    break;
                }
            };
            let chunk = match chunk {
                Ok(chunk) => {
                    if !saw_upstream_progress {
                        log_bridge_upstream_first_chunk(
                            "responses_api",
                            endpoint_label,
                            &stream_model,
                            reporting_context.as_ref(),
                            bridge_timing,
                            upstream_meta,
                            chunk.len(),
                        );
                    }
                    saw_upstream_progress = true;
                    chunk
                }
                Err(error) => {
                    let raw_error = error.to_string();
                    warn!(
                        endpoint = endpoint_label,
                        model = %stream_model,
                        error = %raw_error,
                        response_id = stream_state.response_id.as_deref().unwrap_or("resp_unknown"),
                        event_count = stream_state.event_count,
                        last_event = stream_state.last_event_name.as_deref().unwrap_or("-"),
                        "Emitting synthetic OpenAI stream error after responses stream read failure",
                    );
                    for output in openai_stream_error_chunks(&raw_error) {
                        yield output;
                    }
                    break;
                }
            };
            pending.push_chunk(chunk.as_ref());
            let lines = match pending.drain_complete_lines() {
                Ok(lines) => lines,
                Err(error) => {
                    let raw_error =
                        format!("LLM proxy responses stream contained invalid UTF-8: {error}");
                    warn!(
                        endpoint = endpoint_label,
                        model = %stream_model,
                        error = %raw_error,
                        response_id = stream_state.response_id.as_deref().unwrap_or("resp_unknown"),
                        event_count = stream_state.event_count,
                        last_event = stream_state.last_event_name.as_deref().unwrap_or("-"),
                        "Emitting synthetic OpenAI stream error after invalid responses bytes",
                    );
                    for output in openai_stream_error_chunks(&raw_error) {
                        yield output;
                    }
                    break;
                }
            };
            for line in lines {
                let outputs = match transform_bifrost_responses_sse_line(
                    &line,
                    &mut current_event_name,
                    &entry,
                    cost_hint,
                    &mut stream_state,
                ) {
                    Ok(outputs) => outputs,
                    Err(error) => {
                        let raw_error = error.to_string();
                        warn!(
                            endpoint = endpoint_label,
                            model = %stream_model,
                            error = %raw_error,
                            response_id = stream_state.response_id.as_deref().unwrap_or("resp_unknown"),
                            event_count = stream_state.event_count,
                            last_event = stream_state.last_event_name.as_deref().unwrap_or("-"),
                            "Emitting synthetic OpenAI stream error after responses SSE translation failure",
                        );
                        for output in openai_stream_error_chunks(&raw_error) {
                            yield output;
                        }
                        emitted_stream_error = true;
                        break;
                    }
                };
                for output in outputs {
                    // Usage chunks gain context_tokens (clamped occupancy)
                    // so the live pill never renders pro-mode billed totals.
                    let output = match inject_context_tokens_into_sse_usage(
                        output.as_ref(),
                        responses_context_tokens_estimate,
                    ) {
                        Some(rewritten) => Bytes::from(rewritten),
                        None => output,
                    };
                    if let Some(usage) = extract_usage_from_sse_bytes(output.as_ref()) {
                        log_responses_usage_chunk(&mut stream_state, &entry.alias, &usage);
                        maybe_report_usage_event(
                            &state,
                            reporting_context.as_ref(),
                            &reporting_call_id,
                            &entry.alias,
                            &entry.alias,
                            &usage,
                            responses_context_tokens_estimate,
                        )
                        .await;
                    }
                    if !logged_first_client_token && should_log_client_token_chunk(output.as_ref()) {
                        logged_first_client_token = true;
                        log_bridge_first_client_token(
                            "responses_api",
                            endpoint_label,
                            &stream_model,
                            reporting_context.as_ref(),
                            bridge_timing,
                            upstream_meta,
                        );
                    }
                    yield output;
                }
            }

            if emitted_stream_error {
                break;
            }
        }

        if !emitted_stream_error {
            match pending.finish() {
                Ok(Some(line)) => {
                    let outputs = match transform_bifrost_responses_sse_line(
                        &line,
                        &mut current_event_name,
                        &entry,
                        cost_hint,
                        &mut stream_state,
                    ) {
                        Ok(outputs) => outputs,
                        Err(error) => {
                            let raw_error = error.to_string();
                            warn!(
                                endpoint = endpoint_label,
                                model = %stream_model,
                                error = %raw_error,
                                response_id = stream_state.response_id.as_deref().unwrap_or("resp_unknown"),
                                event_count = stream_state.event_count,
                                last_event = stream_state.last_event_name.as_deref().unwrap_or("-"),
                                "Emitting synthetic OpenAI stream error after trailing responses SSE translation failure",
                            );
                            for output in openai_stream_error_chunks(&raw_error) {
                                yield output;
                            }
                            Vec::new()
                        }
                    };
                    for output in outputs {
                        let output = match inject_context_tokens_into_sse_usage(
                            output.as_ref(),
                            responses_context_tokens_estimate,
                        ) {
                            Some(rewritten) => Bytes::from(rewritten),
                            None => output,
                        };
                        if let Some(usage) = extract_usage_from_sse_bytes(output.as_ref()) {
                            log_responses_usage_chunk(&mut stream_state, &entry.alias, &usage);
                            maybe_report_usage_event(
                                &state,
                                reporting_context.as_ref(),
                                &reporting_call_id,
                                &entry.alias,
                                &entry.alias,
                                &usage,
                                responses_context_tokens_estimate,
                            )
                            .await;
                        }
                        if !logged_first_client_token
                            && should_log_client_token_chunk(output.as_ref())
                        {
                            logged_first_client_token = true;
                            log_bridge_first_client_token(
                                "responses_api",
                                endpoint_label,
                                &stream_model,
                                reporting_context.as_ref(),
                                bridge_timing,
                                upstream_meta,
                            );
                        }
                        yield output;
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    let raw_error =
                        format!("LLM proxy responses stream contained invalid UTF-8: {error}");
                    warn!(
                        endpoint = endpoint_label,
                        model = %stream_model,
                        error = %raw_error,
                        response_id = stream_state.response_id.as_deref().unwrap_or("resp_unknown"),
                        event_count = stream_state.event_count,
                        last_event = stream_state.last_event_name.as_deref().unwrap_or("-"),
                        "Emitting synthetic OpenAI stream error after invalid trailing responses bytes",
                    );
                    for output in openai_stream_error_chunks(&raw_error) {
                        yield output;
                    }
                }
            }

            if !stream_state.terminal_chunk_sent {
                let outputs = response_incomplete_eof_chunks(
                    &mut stream_state,
                    &entry,
                    "incomplete_stream",
                );
                if !outputs.is_empty() {
                    warn!(
                        endpoint = endpoint_label,
                        model = %stream_model,
                        response_id = stream_state.response_id.as_deref().unwrap_or("resp_unknown"),
                        event_count = stream_state.event_count,
                        last_event = stream_state.last_event_name.as_deref().unwrap_or("-"),
                        "LLM proxy Responses stream ended without a terminal event; emitting incomplete_stream",
                    );
                    for output in outputs {
                        yield output;
                    }
                }
            }
        }
    }
    .map_err(|error: IoError| error);
    let body = Body::from_stream(body_stream);

    let mut response = Response::new(body);
    *response.status_mut() = StatusCode::OK;
    *response.headers_mut() = passthrough_headers;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
        .headers_mut()
        .insert(header::CONNECTION, HeaderValue::from_static("keep-alive"));
    response
}

async fn embeddings(State(state): State<AppState>, body: Bytes) -> Response<Body> {
    let mut payload: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(error) => {
            return json_error(
                StatusCode::BAD_REQUEST,
                format!("Invalid JSON body: {error}"),
            );
        }
    };

    let model_alias = match payload.get("model").and_then(Value::as_str) {
        Some(value) => value.to_string(),
        None => return json_error(StatusCode::BAD_REQUEST, "Request body is missing model"),
    };
    let Some(entry) = state.catalog.entries.get(&model_alias).cloned() else {
        return json_error(
            StatusCode::NOT_FOUND,
            format!("Unknown model: {model_alias}"),
        );
    };
    if let Some(object) = payload.as_object_mut() {
        object.insert(
            "model".to_string(),
            Value::String(entry.bifrost_model.clone()),
        );
    }
    let bifrost_headers = match state
        .provider_headers
        .bifrost_headers_with_auth(&state.portico_api_key)
    {
        Ok(value) => value,
        Err(error) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to build Bifrost request headers: {error}"),
            );
        }
    };
    log_outbound_portico_header_audit(
        "bifrost",
        "bifrost embeddings",
        "embeddings",
        &entry.alias,
        &state.provider_headers,
        true,
        None,
    );

    let response = match state
        .client
        .post(format!("{}/v1/embeddings", state.bifrost_base_url))
        .headers(bifrost_headers)
        .json(&payload)
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            return json_error(
                StatusCode::BAD_GATEWAY,
                format!("Failed to reach Bifrost embeddings endpoint: {error}"),
            );
        }
    };

    if !response.status().is_success() {
        return upstream_error_response(response).await;
    }

    let status = response.status();
    let cost_hint = extract_cost_hint(response.headers());
    let passthrough_headers = passthrough_cost_headers(response.headers());
    let mut body = match response.json::<Value>().await {
        Ok(value) => value,
        Err(error) => {
            return json_error(
                StatusCode::BAD_GATEWAY,
                format!("Invalid embeddings response: {error}"),
            );
        }
    };
    if let Some(object) = body.as_object_mut() {
        object.insert("model".to_string(), Value::String(model_alias));
        inject_usage_cost(object, cost_hint);
    }
    let mut http_response = (status, Json(body)).into_response();
    merge_response_headers(&mut http_response, &passthrough_headers);
    http_response
}

async fn anthropic_messages(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response<Body> {
    let reporting_call_id = format!("call_{}", Uuid::new_v4().simple());
    let mut request_body: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(error) => {
            return anthropic_error(
                StatusCode::BAD_REQUEST,
                "invalid_request_error",
                format!("Invalid JSON body: {error}"),
            );
        }
    };
    restore_claude_system_messages_from_passthrough(&mut request_body);

    // Re-attach this turn's cached thinking blocks to assistant tool_use
    // messages that arrived without them (OWUI's OpenAI-format hop cannot
    // carry signed thinking). Anthropic contract: within a tool-use turn,
    // thinking blocks must ride back with the tool results.
    let splice_model = request_body
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let reasoning_spliced_count = if state.claude_thinking_splice_enabled {
        splice_cached_thinking_into_anthropic_request(
            &mut request_body,
            &state.thinking_cache,
            &splice_model,
        )
    } else {
        0
    };

    let bedrock_payload = match anthropic_request_to_bedrock(&request_body) {
        Ok(value) => value,
        Err(error) => {
            return anthropic_error(
                StatusCode::BAD_REQUEST,
                "invalid_request_error",
                error.to_string(),
            );
        }
    };
    let request_shape = sanitized_bedrock_request_shape(&bedrock_payload);
    let reporting_context = extract_reporting_context(&headers, Some(&request_body));
    let bridge_timing = BridgeRequestTiming::new(reporting_context.as_ref());

    let headers = match proxy_headers(&state.portico_api_key, &state.provider_headers) {
        Ok(value) => value,
        Err(error) => {
            return anthropic_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "api_error",
                error.to_string(),
            );
        }
    };

    let is_stream = request_body
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let requested_model = request_body
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let request_summary = summarize_anthropic_request(&request_body);
    log_bridge_request_received(
        "anthropic_messages",
        "bedrock converse",
        &requested_model,
        is_stream,
        reporting_context.as_ref(),
        bridge_timing,
    );
    info!(
        endpoint = "bedrock converse",
        route = "anthropic_messages",
        model = %requested_model,
        stream = is_stream,
        messages = request_summary.message_count,
        system_blocks = request_summary.system_blocks,
        tools = request_summary.tool_count,
        tool_choice = request_summary.tool_choice.as_deref().unwrap_or("-"),
        max_tokens = request_summary.max_tokens.unwrap_or_default(),
        thinking_enabled = request_summary.thinking_enabled,
        thinking_type = request_summary.thinking_type.as_deref().unwrap_or("-"),
        thinking_display = request_summary.thinking_display.as_deref().unwrap_or("-"),
        reasoning_spliced = reasoning_spliced_count,
        output_config_effort = request_summary.output_config_effort.as_deref().unwrap_or("-"),
        mcp_server_count = request_summary.mcp_server_count,
        cache_control_blocks = request_summary.cache_control_blocks,
        cache_control_ttls = %request_summary.cache_control_ttls.join(","),
        chat_id = reporting_chat_id(reporting_context.as_ref()),
        message_id = reporting_message_id(reporting_context.as_ref()),
        session_id = reporting_session_id(reporting_context.as_ref()),
        "Dispatching translated Anthropic request to Provider API proxy Bedrock converse",
    );
    log_outbound_portico_header_audit(
        "llm_proxy",
        "bedrock converse",
        "anthropic_messages",
        &requested_model,
        &state.provider_headers,
        false,
        reporting_context.as_ref(),
    );
    let bedrock_converse_url = format!("{}/bedrock/converse", state.llm_proxy_base_url);
    let request_timeout_seconds = (!is_stream).then_some(state.bedrock_converse_timeout_seconds);
    let upstream_response = match send_upstream_request_with_retry(
        &state.client,
        "anthropic_messages",
        "bedrock converse",
        &requested_model,
        is_stream,
        request_timeout_seconds,
        reporting_context.as_ref(),
        bridge_timing,
        |client| {
            request_builder_with_timeout(
                client
                    .post(bedrock_converse_url.clone())
                    .headers(headers.clone()),
                request_timeout_seconds,
            )
            .json(&bedrock_payload)
        },
    )
    .await
    {
        Ok(response) => response,
        Err(error) => {
            return anthropic_error_with_headers(
                error.status,
                "api_error",
                error.message,
                response_headers_from_upstream(&error.headers),
            );
        }
    };

    let upstream_meta = upstream_response.meta;
    let passthrough_headers = response_headers_from_upstream(upstream_response.response.headers());
    let upstream_response_headers =
        serialize_upstream_response_headers(upstream_response.response.headers());
    info!(
        endpoint = "bedrock converse",
        model = %requested_model,
        stream = is_stream,
        status = %upstream_response.response.status(),
        upstream_request_id = upstream_response
            .response
            .headers()
            .get("x-request-id")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("-"),
        upstream_amzn_request_id = upstream_response
            .response
            .headers()
            .get("x-amzn-requestid")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("-"),
        upstream_content_type = upstream_response_headers
            .get("content-type")
            .map(String::as_str)
            .unwrap_or("-"),
        upstream_content_length = upstream_response_headers
            .get("content-length")
            .map(String::as_str)
            .unwrap_or("-"),
        upstream_transfer_encoding = upstream_response_headers
            .get("transfer-encoding")
            .map(String::as_str)
            .unwrap_or("-"),
        upstream_content_encoding = upstream_response_headers
            .get("content-encoding")
            .map(String::as_str)
            .unwrap_or("-"),
        upstream_server = upstream_response_headers
            .get("server")
            .map(String::as_str)
            .unwrap_or("-"),
        upstream_via = upstream_response_headers
            .get("via")
            .map(String::as_str)
            .unwrap_or("-"),
        chat_id = reporting_chat_id(reporting_context.as_ref()),
        message_id = reporting_message_id(reporting_context.as_ref()),
        session_id = reporting_session_id(reporting_context.as_ref()),
        "Received upstream response from Provider API proxy Bedrock converse",
    );

    if !is_stream {
        let body = match upstream_response.response.json::<Value>().await {
            Ok(value) => value,
            Err(error) => {
                return anthropic_error(StatusCode::BAD_GATEWAY, "api_error", error.to_string());
            }
        };
        let payload = bedrock_response_to_anthropic(&body, &requested_model);
        if state.claude_thinking_splice_enabled {
            let stash_groups = collect_turn_thinking_stash_from_anthropic_content(
                payload.get("content").unwrap_or(&Value::Null),
            );
            if !stash_groups.is_empty() {
                state
                    .thinking_cache
                    .insert_turn(&requested_model, stash_groups);
            }
        }
        let response_summary = summarize_anthropic_response(&payload);
        info!(
            endpoint = "bedrock converse",
            model = %requested_model,
            anthropic_message_id = payload
                .get("id")
                .and_then(|value| value.as_str())
                .unwrap_or("msg_unknown"),
            stop_reason = response_summary.stop_reason.as_deref().unwrap_or("-"),
            content_blocks = response_summary.content_blocks,
            text_blocks = response_summary.text_blocks,
            thinking_blocks = response_summary.thinking_blocks,
            tool_use_blocks = response_summary.tool_use_blocks,
            usage = %response_summary
                .usage
                .as_ref()
                .map(summarize_usage_for_log)
                .unwrap_or_else(|| "none".to_string()),
            "Translated non-stream Bedrock converse response to Anthropic payload",
        );
        if let Some(usage) = payload.get("usage") {
            maybe_report_usage_event(
                &state,
                reporting_context.as_ref(),
                &reporting_call_id,
                &requested_model,
                &requested_model,
                usage,
                context_tokens_from_billed_usage(usage),
            )
            .await;
        }
        log_bridge_upstream_response_complete(
            "anthropic_messages",
            "bedrock converse",
            &requested_model,
            reporting_context.as_ref(),
            bridge_timing,
            upstream_meta,
            StatusCode::OK,
        );
        let mut http_response = Json(payload).into_response();
        merge_response_headers(&mut http_response, &passthrough_headers);
        return http_response;
    }

    let stream = upstream_response.response.bytes_stream();
    let endpoint_label = "bedrock converse";
    let stream_model = requested_model.clone();
    let stream_timeout_config = state.stream_timeout_config;
    let post_progress_idle_timeout =
        Some(Duration::from_secs(state.bedrock_converse_timeout_seconds));
    let stream_started_at = Instant::now();
    let body_stream = try_stream! {
        let mut pending = Utf8LineBuffer::default();
        let mut translation_state = StreamTranslationState::new(requested_model.clone());
        let mut emitted_stream_error = false;
        let mut saw_upstream_progress = false;
        let mut logged_first_client_token = false;
        let mut upstream_body_chunk_count = 0usize;
        let mut first_upstream_body_chunk_elapsed_ms: Option<u64> = None;
        let mut last_upstream_body_chunk_elapsed_ms: Option<u64> = None;
        futures_util::pin_mut!(stream);
        loop {
            let chunk = match next_stream_item_with_timeouts(
                stream.as_mut(),
                stream_started_at,
                stream_timeout_config,
                saw_upstream_progress,
                post_progress_idle_timeout,
            )
            .await
            {
                Ok(Some(chunk)) => chunk,
                Ok(None) => break,
                Err(error) => {
                    let raw_error = error.raw_error();
                    translation_state.stream_error_message = Some(raw_error.clone());
                    warn!(
                        endpoint = endpoint_label,
                        model = %stream_model,
                        timeout_layer = error.layer.as_str(),
                        progress_phase = error.progress_phase.as_str(),
                        timeout_seconds = error.timeout.as_secs(),
                        effective_idle_timeout_seconds = error.effective_idle_timeout.as_secs(),
                        elapsed_ms = error.elapsed.as_millis() as u64,
                        error = %raw_error,
                        chat_id = reporting_chat_id(reporting_context.as_ref()),
                        message_id = reporting_message_id(reporting_context.as_ref()),
                        session_id = reporting_session_id(reporting_context.as_ref()),
                        "Emitting synthetic Anthropic stream error after converse stream timeout",
                    );
                    for output in anthropic_stream_error_chunks(&raw_error) {
                        yield output;
                    }
                    break;
                }
            };
            let chunk = match chunk {
                Ok(chunk) => {
                    let elapsed_ms = stream_started_at.elapsed().as_millis() as u64;
                    upstream_body_chunk_count += 1;
                    if first_upstream_body_chunk_elapsed_ms.is_none() {
                        first_upstream_body_chunk_elapsed_ms = Some(elapsed_ms);
                        log_bridge_upstream_first_chunk(
                            "anthropic_messages",
                            endpoint_label,
                            &stream_model,
                            reporting_context.as_ref(),
                            bridge_timing,
                            upstream_meta,
                            chunk.len(),
                        );
                        info!(
                            endpoint = endpoint_label,
                            model = %stream_model,
                            body_chunk_bytes = chunk.len(),
                            upstream_body_chunk_count,
                            elapsed_ms,
                            chat_id = reporting_chat_id(reporting_context.as_ref()),
                            message_id = reporting_message_id(reporting_context.as_ref()),
                            session_id = reporting_session_id(reporting_context.as_ref()),
                            "Observed first upstream response body chunk from converse stream",
                        );
                    }
                    last_upstream_body_chunk_elapsed_ms = Some(elapsed_ms);
                    saw_upstream_progress = true;
                    chunk
                }
                Err(error) => {
                    let failure = StreamReadFailureDetails::from_reqwest(&error);
                    let raw_error = failure.raw_error.clone();
                    let failure_elapsed_ms = stream_started_at.elapsed().as_millis() as u64;
                    let stream_stage = anthropic_stream_stage(
                        saw_upstream_progress,
                        &translation_state,
                        upstream_body_chunk_count,
                    );
                    let time_since_last_upstream_body_chunk_ms = last_upstream_body_chunk_elapsed_ms
                        .map(|last| failure_elapsed_ms.saturating_sub(last))
                        .unwrap_or_default();
                    translation_state.stream_error_message = Some(raw_error.clone());
                    warn_if_timeout_message_mismatch(
                        endpoint_label,
                        &stream_model,
                        &raw_error,
                        Some(state.bedrock_converse_timeout_seconds),
                    );
                    warn!(
                        endpoint = endpoint_label,
                        model = %stream_model,
                        error = %raw_error,
                        error_chain = %failure.error_chain_text(),
                        reqwest_is_timeout = failure.is_timeout,
                        reqwest_is_decode = failure.is_decode,
                        reqwest_is_connect = failure.is_connect,
                        reqwest_is_body = failure.is_body,
                        reqwest_is_request = failure.is_request,
                        reqwest_status = %failure.status_text(),
                        stream_stage,
                        saw_upstream_progress,
                        upstream_body_chunk_count,
                        first_upstream_body_chunk_elapsed_ms = first_upstream_body_chunk_elapsed_ms.unwrap_or_default(),
                        first_upstream_body_chunk_seen = first_upstream_body_chunk_elapsed_ms.is_some(),
                        last_upstream_body_chunk_elapsed_ms = last_upstream_body_chunk_elapsed_ms.unwrap_or_default(),
                        last_upstream_body_chunk_seen = last_upstream_body_chunk_elapsed_ms.is_some(),
                        time_since_last_upstream_body_chunk_ms,
                        upstream_response_headers = ?upstream_response_headers,
                        raw_chunk_count = translation_state.raw_chunk_count,
                        text_delta_events = translation_state.text_delta_events,
                        text_delta_chars = translation_state.text_delta_chars,
                        thinking_delta_events = translation_state.thinking_delta_events,
                        thinking_delta_chars = translation_state.thinking_delta_chars,
                        redacted_reasoning_events = translation_state.redacted_reasoning_events,
                        redacted_reasoning_chars = translation_state.redacted_reasoning_chars,
                        tool_use_blocks = translation_state.tool_use_blocks,
                        tool_input_delta_events = translation_state.tool_input_delta_events,
                        message_stop_emitted = translation_state.message_stop_emitted,
                        "Emitting synthetic Anthropic stream error after converse stream read failure",
                    );
                    maybe_report_stream_failure_event(
                        &state,
                        reporting_context.as_ref(),
                        &reporting_call_id,
                        "bedrock-converse",
                        &stream_model,
                        &upstream_response_headers,
                        &failure.as_json(),
                        &request_shape,
                        &anthropic_stream_progress_snapshot(
                            &translation_state,
                            saw_upstream_progress,
                            upstream_body_chunk_count,
                            first_upstream_body_chunk_elapsed_ms,
                            last_upstream_body_chunk_elapsed_ms,
                            failure_elapsed_ms,
                        ),
                    )
                    .await;
                    for output in anthropic_stream_error_chunks(&raw_error) {
                        yield output;
                    }
                    break;
                }
            };
            pending.push_chunk(chunk.as_ref());
            let lines = match pending.drain_complete_lines() {
                Ok(lines) => lines,
                Err(error) => {
                    let raw_error = format!("Converse stream contained invalid UTF-8: {error}");
                    translation_state.stream_error_message = Some(raw_error.clone());
                    warn!(
                        endpoint = endpoint_label,
                        model = %stream_model,
                        error = %raw_error,
                        "Emitting synthetic Anthropic stream error after invalid converse bytes",
                    );
                    for output in anthropic_stream_error_chunks(&raw_error) {
                        yield output;
                    }
                    break;
                }
            };
            for line in lines {
                let saw_text_before = translation_state.text_delta_events > 0;
                let saw_thinking_before = translation_state.thinking_delta_events > 0;
                let saw_redacted_before = translation_state.redacted_reasoning_events > 0;
                let saw_tool_use_before = translation_state.tool_use_blocks > 0;
                let outputs = match transform_converse_sse_line(&line, &mut translation_state) {
                    Ok(outputs) => outputs,
                    Err(error) => {
                        let raw_error = error.to_string();
                        translation_state.stream_error_message = Some(raw_error.clone());
                        warn!(
                            endpoint = endpoint_label,
                            model = %stream_model,
                            error = %raw_error,
                            "Emitting synthetic Anthropic stream error after converse SSE translation failure",
                        );
                        for output in anthropic_stream_error_chunks(&raw_error) {
                            yield output;
                        }
                        emitted_stream_error = true;
                        break;
                    }
                };
                log_anthropic_stream_progress(
                    &translation_state,
                    &stream_model,
                    reporting_context.as_ref(),
                    bridge_timing,
                    upstream_meta,
                    &mut logged_first_client_token,
                    saw_text_before,
                    saw_thinking_before,
                    saw_redacted_before,
                    saw_tool_use_before,
                );
                for output in outputs {
                    if let Some(usage) = extract_usage_from_sse_bytes(output.as_ref()) {
                        maybe_report_usage_event(
                            &state,
                            reporting_context.as_ref(),
                            &reporting_call_id,
                            &requested_model,
                            &requested_model,
                            &usage,
                            context_tokens_from_billed_usage(&usage),
                        )
                        .await;
                    }
                    yield output;
                }
                if translation_state.final_stop_reason.as_deref()
                    == Some(BEDROCK_MALFORMED_TOOL_USE_STOP_REASON)
                {
                    let failure_elapsed_ms = stream_started_at.elapsed().as_millis() as u64;
                    let error_message = translation_state
                        .stream_error_message
                        .as_deref()
                        .unwrap_or(BEDROCK_MALFORMED_TOOL_USE_ERROR_KIND);
                    warn!(
                        endpoint = endpoint_label,
                        model = %stream_model,
                        error_kind = BEDROCK_MALFORMED_TOOL_USE_ERROR_KIND,
                        raw_chunk_count = translation_state.raw_chunk_count,
                        thinking_delta_events = translation_state.thinking_delta_events,
                        thinking_delta_chars = translation_state.thinking_delta_chars,
                        tool_use_blocks = translation_state.tool_use_blocks,
                        tool_input_delta_events = translation_state.tool_input_delta_events,
                        chat_id = reporting_chat_id(reporting_context.as_ref()),
                        message_id = reporting_message_id(reporting_context.as_ref()),
                        session_id = reporting_session_id(reporting_context.as_ref()),
                        "Rejected malformed Bedrock tool-use terminal event",
                    );
                    maybe_report_stream_failure_event(
                        &state,
                        reporting_context.as_ref(),
                        &reporting_call_id,
                        "bedrock-converse",
                        &stream_model,
                        &upstream_response_headers,
                        &json!({
                            "kind": "malformed_tool_use",
                            "code": BEDROCK_MALFORMED_TOOL_USE_ERROR_KIND,
                            "message": error_message,
                            "origin": "upstream_event_sequence",
                            "rawStopReason": translation_state.raw_stop_reason.as_deref(),
                        }),
                        &request_shape,
                        &anthropic_stream_progress_snapshot(
                            &translation_state,
                            saw_upstream_progress,
                            upstream_body_chunk_count,
                            first_upstream_body_chunk_elapsed_ms,
                            last_upstream_body_chunk_elapsed_ms,
                            failure_elapsed_ms,
                        ),
                    )
                    .await;
                    emitted_stream_error = true;
                    break;
                }
            }

            if emitted_stream_error {
                break;
            }
        }

        if !emitted_stream_error {
            match pending.finish() {
                Ok(Some(line)) => {
                    let saw_text_before = translation_state.text_delta_events > 0;
                    let saw_thinking_before = translation_state.thinking_delta_events > 0;
                    let saw_redacted_before = translation_state.redacted_reasoning_events > 0;
                    let saw_tool_use_before = translation_state.tool_use_blocks > 0;
                    let outputs = match transform_converse_sse_line(&line, &mut translation_state) {
                        Ok(outputs) => outputs,
                        Err(error) => {
                            let raw_error = error.to_string();
                            translation_state.stream_error_message = Some(raw_error.clone());
                            warn!(
                                endpoint = endpoint_label,
                                model = %stream_model,
                                error = %raw_error,
                                "Emitting synthetic Anthropic stream error after trailing converse SSE translation failure",
                            );
                            for output in anthropic_stream_error_chunks(&raw_error) {
                                yield output;
                            }
                            emitted_stream_error = true;
                            Vec::new()
                        }
                    };
                    log_anthropic_stream_progress(
                        &translation_state,
                        &stream_model,
                        reporting_context.as_ref(),
                        bridge_timing,
                        upstream_meta,
                        &mut logged_first_client_token,
                        saw_text_before,
                        saw_thinking_before,
                        saw_redacted_before,
                        saw_tool_use_before,
                    );
                    for output in outputs {
                        if let Some(usage) = extract_usage_from_sse_bytes(output.as_ref()) {
                            maybe_report_usage_event(
                                &state,
                                reporting_context.as_ref(),
                                &reporting_call_id,
                                &requested_model,
                                &requested_model,
                                &usage,
                                context_tokens_from_billed_usage(&usage),
                            )
                            .await;
                        }
                        yield output;
                    }
                    if translation_state.final_stop_reason.as_deref()
                        == Some(BEDROCK_MALFORMED_TOOL_USE_STOP_REASON)
                    {
                        let failure_elapsed_ms = stream_started_at.elapsed().as_millis() as u64;
                        let error_message = translation_state
                            .stream_error_message
                            .as_deref()
                            .unwrap_or(BEDROCK_MALFORMED_TOOL_USE_ERROR_KIND);
                        warn!(
                            endpoint = endpoint_label,
                            model = %stream_model,
                            error_kind = BEDROCK_MALFORMED_TOOL_USE_ERROR_KIND,
                            raw_chunk_count = translation_state.raw_chunk_count,
                            thinking_delta_events = translation_state.thinking_delta_events,
                            thinking_delta_chars = translation_state.thinking_delta_chars,
                            tool_use_blocks = translation_state.tool_use_blocks,
                            tool_input_delta_events = translation_state.tool_input_delta_events,
                            chat_id = reporting_chat_id(reporting_context.as_ref()),
                            message_id = reporting_message_id(reporting_context.as_ref()),
                            session_id = reporting_session_id(reporting_context.as_ref()),
                            "Rejected malformed Bedrock tool-use terminal event",
                        );
                        maybe_report_stream_failure_event(
                            &state,
                            reporting_context.as_ref(),
                            &reporting_call_id,
                            "bedrock-converse",
                            &stream_model,
                            &upstream_response_headers,
                            &json!({
                                "kind": "malformed_tool_use",
                                "code": BEDROCK_MALFORMED_TOOL_USE_ERROR_KIND,
                                "message": error_message,
                                "origin": "upstream_event_sequence",
                                "rawStopReason": translation_state.raw_stop_reason.as_deref(),
                            }),
                            &request_shape,
                            &anthropic_stream_progress_snapshot(
                                &translation_state,
                                saw_upstream_progress,
                                upstream_body_chunk_count,
                                first_upstream_body_chunk_elapsed_ms,
                                last_upstream_body_chunk_elapsed_ms,
                                failure_elapsed_ms,
                            ),
                        )
                        .await;
                        emitted_stream_error = true;
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    let raw_error = format!("Converse stream contained invalid UTF-8: {error}");
                    translation_state.stream_error_message = Some(raw_error.clone());
                    warn!(
                        endpoint = endpoint_label,
                        model = %stream_model,
                        error = %raw_error,
                        "Emitting synthetic Anthropic stream error after invalid trailing converse bytes",
                    );
                    for output in anthropic_stream_error_chunks(&raw_error) {
                        yield output;
                    }
                    emitted_stream_error = true;
                }
            }
        }

        // Stash this turn's completed (tool_use_id -> thinking blocks) groups
        // so follow-up rounds can re-attach them (see thinking_cache). Rounds
        // that completed before a mid-stream error are still valid.
        if state.claude_thinking_splice_enabled
            && !translation_state.turn_tool_stash.is_empty()
        {
            state.thinking_cache.insert_turn(
                &requested_model,
                std::mem::take(&mut translation_state.turn_tool_stash),
            );
        }

        if !emitted_stream_error {
            for (event_name, event_payload) in
                flush_bedrock_stream_state(&mut translation_state)
            {
                let output = sse_bytes(&event_name, &event_payload);
                if let Some(usage) = extract_usage_from_sse_bytes(output.as_ref()) {
                    maybe_report_usage_event(
                        &state,
                        reporting_context.as_ref(),
                        &reporting_call_id,
                        &requested_model,
                        &requested_model,
                        &usage,
                        context_tokens_from_billed_usage(&usage),
                    )
                    .await;
                }
                yield output;
            }

            let synthesized_events = synthesize_bedrock_stream_eof(&mut translation_state);
            if !synthesized_events.is_empty() {
                let synthesized_terminal_kind = if translation_state.stream_error_message.is_some()
                {
                    "error"
                } else {
                    "incomplete_stream"
                };
                warn!(
                    endpoint = endpoint_label,
                    model = %stream_model,
                    upstream_request_id = upstream_response_headers
                        .get("x-request-id")
                        .map(String::as_str)
                        .unwrap_or("-"),
                    upstream_amzn_request_id = upstream_response_headers
                        .get("x-amzn-requestid")
                        .map(String::as_str)
                        .unwrap_or("-"),
                    elapsed_ms = stream_started_at.elapsed().as_millis() as u64,
                    upstream_body_chunk_count,
                    raw_chunk_count = translation_state.raw_chunk_count,
                    text_delta_events = translation_state.text_delta_events,
                    text_delta_chars = translation_state.text_delta_chars,
                    thinking_delta_events = translation_state.thinking_delta_events,
                    thinking_delta_chars = translation_state.thinking_delta_chars,
                    redacted_reasoning_events = translation_state.redacted_reasoning_events,
                    redacted_reasoning_chars = translation_state.redacted_reasoning_chars,
                    tool_use_blocks = translation_state.tool_use_blocks,
                    tool_input_delta_events = translation_state.tool_input_delta_events,
                    usage_present = translation_state.final_usage.is_some(),
                    message_stop_emitted = translation_state.message_stop_emitted,
                    synthesized_terminal_kind,
                    chat_id = reporting_chat_id(reporting_context.as_ref()),
                    message_id = reporting_message_id(reporting_context.as_ref()),
                    session_id = reporting_session_id(reporting_context.as_ref()),
                    "Synthesizing terminal Anthropic event after Bedrock converse stream EOF without message_stop",
                );
            }
            for (event_name, event_payload) in synthesized_events {
                let output = sse_bytes(&event_name, &event_payload);
                if let Some(usage) = extract_usage_from_sse_bytes(output.as_ref()) {
                    maybe_report_usage_event(
                        &state,
                        reporting_context.as_ref(),
                        &reporting_call_id,
                        &requested_model,
                        &requested_model,
                        &usage,
                        context_tokens_from_billed_usage(&usage),
                    )
                    .await;
                }
                yield output;
            }
        }

        log_anthropic_stream_terminal(
            &translation_state,
            &stream_model,
            reporting_context.as_ref(),
        );
    }
    .map_err(|error: IoError| error);
    let body = Body::from_stream(body_stream);

    let mut response = Response::new(body);
    *response.status_mut() = StatusCode::OK;
    *response.headers_mut() = passthrough_headers;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
        .headers_mut()
        .insert(header::CONNECTION, HeaderValue::from_static("keep-alive"));
    response
}

fn gemini_proxy_path_from_uri(uri: &http::Uri) -> String {
    let raw = uri
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/");
    let stripped = raw.strip_prefix("/internal/gemini").unwrap_or(raw);
    if stripped.starts_with('/') {
        stripped.to_string()
    } else {
        format!("/{stripped}")
    }
}

fn gemini_model_from_proxy_path(path: &str) -> String {
    path.split("/models/")
        .nth(1)
        .and_then(|tail| tail.split(':').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown")
        .to_string()
}

fn gemini_passthrough_headers(upstream_headers: &reqwest::header::HeaderMap) -> HeaderMap {
    let mut output = passthrough_cost_headers(upstream_headers);
    for header_name in [
        header::CONTENT_TYPE,
        header::CACHE_CONTROL,
        header::CONNECTION,
        HeaderName::from_static("x-goog-request-id"),
    ] {
        if let Some(value) = upstream_headers.get(&header_name) {
            output.insert(header_name, value.clone());
        }
    }
    output
}

fn copy_gemini_request_header(output: &mut HeaderMap, input: &HeaderMap, name: HeaderName) {
    if let Some(value) = input.get(&name) {
        output.insert(name, value.clone());
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct GeminiFunctionDeclarationTrim {
    before: usize,
    after: usize,
}

impl GeminiFunctionDeclarationTrim {
    fn trimmed(self) -> bool {
        self.after < self.before
    }
}

fn gemini_function_declaration_name(declaration: &Value) -> String {
    declaration
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn gemini_function_declaration_priority(declaration: &Value) -> u8 {
    let name = gemini_function_declaration_name(declaration);
    if name == "agent_vm_create" {
        0
    } else if matches!(
        name.as_str(),
        "agent_vm_bash" | "agent_vm_python" | "agent_vm_execute_skill_script"
    ) {
        1
    } else if name.starts_with("agent_vm_") {
        2
    } else if name.contains("code") || name.contains("execute") {
        3
    } else if name.starts_with("mcp_assistant_") || name.starts_with("skills_") {
        4
    } else {
        5
    }
}

fn gemini_vertex_limit_function_declarations(payload: &mut Value) -> GeminiFunctionDeclarationTrim {
    let Some(tools) = payload.get_mut("tools").and_then(Value::as_array_mut) else {
        return GeminiFunctionDeclarationTrim::default();
    };

    let mut declarations = Vec::new();
    let mut sequence = 0usize;
    for (tool_index, tool) in tools.iter().enumerate() {
        let Some(object) = tool.as_object() else {
            continue;
        };
        for key in ["function_declarations", "functionDeclarations"] {
            let Some(values) = object.get(key).and_then(Value::as_array) else {
                continue;
            };
            for declaration in values {
                declarations.push((
                    gemini_function_declaration_priority(declaration),
                    sequence,
                    tool_index,
                    key,
                    declaration.clone(),
                ));
                sequence += 1;
            }
        }
    }

    let before = declarations.len();
    if before <= GEMINI_VERTEX_MAX_FUNCTION_DECLARATIONS {
        return GeminiFunctionDeclarationTrim {
            before,
            after: before,
        };
    }

    declarations.sort_by_key(|(priority, sequence, ..)| (*priority, *sequence));
    let mut kept: BTreeMap<(usize, &'static str), Vec<(u8, usize, Value)>> = BTreeMap::new();
    for (priority, sequence, tool_index, key, declaration) in declarations
        .into_iter()
        .take(GEMINI_VERTEX_MAX_FUNCTION_DECLARATIONS)
    {
        kept.entry((tool_index, key))
            .or_default()
            .push((priority, sequence, declaration));
    }

    for (tool_index, tool) in tools.iter_mut().enumerate() {
        let Some(object) = tool.as_object_mut() else {
            continue;
        };
        for key in ["function_declarations", "functionDeclarations"] {
            if !object.contains_key(key) {
                continue;
            }
            let mut selected = kept.remove(&(tool_index, key)).unwrap_or_default();
            selected.sort_by_key(|(priority, sequence, _)| (*priority, *sequence));
            if selected.is_empty() {
                object.remove(key);
            } else {
                object.insert(
                    key.to_string(),
                    Value::Array(
                        selected
                            .into_iter()
                            .map(|(_, _, declaration)| declaration)
                            .collect(),
                    ),
                );
            }
        }
    }
    tools.retain(|tool| tool.as_object().map_or(true, |object| !object.is_empty()));

    GeminiFunctionDeclarationTrim {
        before,
        after: GEMINI_VERTEX_MAX_FUNCTION_DECLARATIONS,
    }
}

fn gemini_schema_enum_type(values: &[Value]) -> Option<&'static str> {
    if values.is_empty() {
        return None;
    }
    if values.iter().all(Value::is_string) {
        Some("string")
    } else if values.iter().all(Value::is_boolean) {
        Some("boolean")
    } else if values.iter().all(Value::is_i64) {
        Some("integer")
    } else if values.iter().all(Value::is_number) {
        Some("number")
    } else {
        None
    }
}

fn gemini_infer_schema_type(object: &Map<String, Value>) -> Option<&'static str> {
    if object
        .get("properties")
        .and_then(Value::as_object)
        .is_some()
        || object.get("required").is_some()
        || object.get("additionalProperties").is_some()
    {
        Some("object")
    } else if object.get("items").is_some() {
        Some("array")
    } else if [
        "minItems",
        "maxItems",
        "uniqueItems",
        "prefixItems",
        "contains",
    ]
    .iter()
    .any(|key| object.contains_key(*key))
    {
        Some("array")
    } else if [
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "multipleOf",
    ]
    .iter()
    .any(|key| object.contains_key(*key))
    {
        Some("number")
    } else if ["minLength", "maxLength", "pattern", "format"]
        .iter()
        .any(|key| object.contains_key(*key))
    {
        Some("string")
    } else if let Some(values) = object.get("enum").and_then(Value::as_array) {
        gemini_schema_enum_type(values)
    } else {
        None
    }
}

fn gemini_sanitize_schema_node(schema: &mut Value) -> bool {
    let Value::Object(object) = schema else {
        return false;
    };

    let mut changed = false;
    if !object.contains_key("type") {
        if let Some(inferred_type) = gemini_infer_schema_type(object) {
            object.insert("type".to_string(), Value::String(inferred_type.to_string()));
            changed = true;
        }
    }

    if object.contains_key("required") {
        let property_names = object
            .get("properties")
            .and_then(Value::as_object)
            .map(|properties| properties.keys().cloned().collect::<BTreeSet<_>>());
        if let Some(required) = object.get_mut("required").and_then(Value::as_array_mut) {
            let before = required.len();
            if let Some(property_names) = property_names {
                required.retain(|name| {
                    name.as_str()
                        .map(|value| property_names.contains(value))
                        .unwrap_or(false)
                });
            } else {
                required.clear();
            }
            changed |= required.len() != before;
        }
        if object
            .get("required")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
        {
            object.remove("required");
            changed = true;
        }
    }

    for key in ["properties", "$defs", "defs", "definitions"] {
        if let Some(children) = object.get_mut(key).and_then(Value::as_object_mut) {
            for child in children.values_mut() {
                changed |= gemini_sanitize_schema_node(child);
            }
        }
    }

    if let Some(items) = object.get_mut("items") {
        changed |= gemini_sanitize_schema_node(items);
    }

    for key in ["anyOf", "oneOf", "allOf"] {
        if let Some(children) = object.get_mut(key).and_then(Value::as_array_mut) {
            for child in children {
                changed |= gemini_sanitize_schema_node(child);
            }
        }
    }

    changed
}

fn gemini_vertex_sanitize_function_declaration_schemas(payload: &mut Value) -> bool {
    let Some(tools) = payload.get_mut("tools").and_then(Value::as_array_mut) else {
        return false;
    };

    let mut changed = false;
    for tool in tools {
        let Some(object) = tool.as_object_mut() else {
            continue;
        };
        for key in ["function_declarations", "functionDeclarations"] {
            let Some(function_declarations) = object.get_mut(key).and_then(Value::as_array_mut)
            else {
                continue;
            };
            for declaration in function_declarations {
                let Some(declaration_object) = declaration.as_object_mut() else {
                    continue;
                };
                for schema_key in ["parameters", "response"] {
                    if let Some(schema) = declaration_object.get_mut(schema_key) {
                        changed |= gemini_sanitize_schema_node(schema);
                    }
                }
            }
        }
    }
    changed
}

fn gemini_vertex_remove_function_part_ids_from_value(value: &mut Value) -> usize {
    match value {
        Value::Object(object) => {
            let mut removed = 0usize;
            for key in [
                "function_call",
                "functionCall",
                "function_response",
                "functionResponse",
            ] {
                if let Some(function_part) = object.get_mut(key).and_then(Value::as_object_mut) {
                    if function_part.remove("id").is_some() {
                        removed += 1;
                    }
                }
            }
            for child in object.values_mut() {
                removed += gemini_vertex_remove_function_part_ids_from_value(child);
            }
            removed
        }
        Value::Array(values) => values
            .iter_mut()
            .map(gemini_vertex_remove_function_part_ids_from_value)
            .sum(),
        _ => 0,
    }
}

fn gemini_vertex_remove_function_part_ids(payload: &mut Value) -> usize {
    let Some(contents) = payload.get_mut("contents") else {
        return 0;
    };
    gemini_vertex_remove_function_part_ids_from_value(contents)
}

fn gemini_vertex_prepare_payload(
    original_body: Bytes,
    request_json: Option<Value>,
) -> (Bytes, Option<Value>, GeminiFunctionDeclarationTrim, bool) {
    let Some(mut payload) = request_json else {
        return (
            original_body,
            None,
            GeminiFunctionDeclarationTrim::default(),
            false,
        );
    };
    let removed_internal_params = payload
        .as_object_mut()
        .is_some_and(|object| object.remove("params").is_some());
    let trim = gemini_vertex_limit_function_declarations(&mut payload);
    let schema_changed = gemini_vertex_sanitize_function_declaration_schemas(&mut payload);
    let removed_function_part_ids = gemini_vertex_remove_function_part_ids(&mut payload);
    if !removed_internal_params
        && !trim.trimmed()
        && !schema_changed
        && removed_function_part_ids == 0
    {
        return (original_body, Some(payload), trim, false);
    }
    match serde_json::to_vec(&payload) {
        Ok(bytes) => (
            Bytes::from(bytes),
            Some(payload),
            trim,
            removed_internal_params,
        ),
        Err(_) => (
            original_body,
            Some(payload),
            GeminiFunctionDeclarationTrim::default(),
            false,
        ),
    }
}

async fn gemini_vertex_proxy(
    State(state): State<AppState>,
    headers: HeaderMap,
    request: Request,
) -> Response<Body> {
    let (parts, body) = request.into_parts();
    let method = parts.method;
    let proxy_path = gemini_proxy_path_from_uri(&parts.uri);
    let model = gemini_model_from_proxy_path(&proxy_path);
    let is_stream = proxy_path.contains(":streamGenerateContent");
    let request_body = match to_bytes(body, usize::MAX).await {
        Ok(value) => value,
        Err(error) => {
            return json_error(
                StatusCode::BAD_REQUEST,
                format!("Invalid Gemini request body: {error}"),
            );
        }
    };
    let request_json = serde_json::from_slice::<Value>(&request_body).ok();
    let (request_body, request_json, tool_trim, removed_internal_params) =
        gemini_vertex_prepare_payload(request_body, request_json);
    let reporting_context = extract_reporting_context(&headers, request_json.as_ref());
    let bridge_timing = BridgeRequestTiming::new(reporting_context.as_ref());
    if removed_internal_params {
        warn!(
            route = "gemini_vertex_proxy",
            chat_id = reporting_chat_id(reporting_context.as_ref()),
            message_id = reporting_message_id(reporting_context.as_ref()),
            session_id = reporting_session_id(reporting_context.as_ref()),
            debug_request_id = reporting_debug_request_id(reporting_context.as_ref()),
            upstream_request_id = reporting_upstream_request_id(reporting_context.as_ref()),
            "Stripped Open WebUI internal params before Gemini provider dispatch",
        );
    }

    let mut upstream_headers = match proxy_headers(&state.portico_api_key, &state.provider_headers) {
        Ok(value) => value,
        Err(error) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to build Gemini LLM proxy headers: {error}"),
            );
        }
    };
    copy_gemini_request_header(&mut upstream_headers, &headers, header::ACCEPT);
    copy_gemini_request_header(
        &mut upstream_headers,
        &headers,
        HeaderName::from_static("x-vertex-ai-llm-request-type"),
    );
    copy_gemini_request_header(
        &mut upstream_headers,
        &headers,
        HeaderName::from_static("x-vertex-ai-llm-shared-request-type"),
    );

    log_bridge_request_received(
        "gemini_vertex_proxy",
        "gemini vertex",
        &model,
        is_stream,
        reporting_context.as_ref(),
        bridge_timing,
    );
    info!(
        endpoint = "gemini vertex",
        route = "gemini_vertex_proxy",
        model = %model,
        method = %method,
        proxy_path = %proxy_path,
        stream = is_stream,
        chat_id = reporting_chat_id(reporting_context.as_ref()),
        message_id = reporting_message_id(reporting_context.as_ref()),
        session_id = reporting_session_id(reporting_context.as_ref()),
        "Forwarding Bifrost Gemini request to Provider API proxy Vertex route",
    );
    if tool_trim.trimmed() {
        info!(
            endpoint = "gemini vertex",
            route = "gemini_vertex_proxy",
            model = %model,
            function_declarations_before = tool_trim.before,
            function_declarations_after = tool_trim.after,
            function_declaration_limit = GEMINI_VERTEX_MAX_FUNCTION_DECLARATIONS,
            chat_id = reporting_chat_id(reporting_context.as_ref()),
            message_id = reporting_message_id(reporting_context.as_ref()),
            session_id = reporting_session_id(reporting_context.as_ref()),
            "Trimmed Gemini function declarations to satisfy Vertex request limits",
        );
    }
    log_outbound_portico_header_audit(
        "llm_proxy",
        "gemini vertex",
        "gemini_vertex_proxy",
        &model,
        &state.provider_headers,
        false,
        reporting_context.as_ref(),
    );

    let upstream_url = format!("{}/gemini{}", state.llm_proxy_base_url, proxy_path);
    let request_timeout_seconds =
        (!is_stream).then_some(bridge_non_stream_request_timeout_seconds());
    let upstream_response = match send_upstream_request_with_retry(
        &state.client,
        "gemini_vertex_proxy",
        "gemini vertex",
        &model,
        is_stream,
        request_timeout_seconds,
        reporting_context.as_ref(),
        bridge_timing,
        |client| {
            let request = client
                .request(method.clone(), upstream_url.clone())
                .headers(upstream_headers.clone())
                .body(request_body.clone());
            request_builder_with_timeout(request, request_timeout_seconds)
        },
    )
    .await
    {
        Ok(response) => response,
        Err(error) => {
            return json_error_with_headers(
                error.status,
                error.message,
                gemini_passthrough_headers(&error.headers),
            );
        }
    };

    let upstream_meta = upstream_response.meta;
    let status = upstream_response.response.status();
    let response_headers =
        serialize_upstream_response_headers(upstream_response.response.headers());
    let passthrough_headers = gemini_passthrough_headers(upstream_response.response.headers());
    info!(
        endpoint = "gemini vertex",
        route = "gemini_vertex_proxy",
        model = %model,
        stream = is_stream,
        status = %status,
        upstream_request_id = upstream_response
            .response
            .headers()
            .get("x-request-id")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("-"),
        upstream_google_request_id = upstream_response
            .response
            .headers()
            .get("x-goog-request-id")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("-"),
        upstream_content_type = response_headers
            .get("content-type")
            .map(String::as_str)
            .unwrap_or("-"),
        chat_id = reporting_chat_id(reporting_context.as_ref()),
        message_id = reporting_message_id(reporting_context.as_ref()),
        session_id = reporting_session_id(reporting_context.as_ref()),
        "Received upstream response from Provider API proxy Gemini Vertex route",
    );

    if !is_stream {
        log_bridge_upstream_response_complete(
            "gemini_vertex_proxy",
            "gemini vertex",
            &model,
            reporting_context.as_ref(),
            bridge_timing,
            upstream_meta,
            status,
        );
    }

    let stream = upstream_response.response.bytes_stream();
    let body_stream = stream.map_err(|error| IoError::other(error.to_string()));
    let mut response = Response::new(Body::from_stream(body_stream));
    *response.status_mut() = status;
    merge_response_headers(&mut response, &passthrough_headers);
    response
}

fn anthropic_error(
    status: StatusCode,
    error_type: &str,
    message: impl Into<String>,
) -> Response<Body> {
    let payload = json!({
        "type": "error",
        "error": {
            "type": error_type,
            "message": message.into()
        }
    });
    let mut response = (status, Json(payload)).into_response();
    response.headers_mut().insert(
        HeaderName::from_static("anthropic-version"),
        HeaderValue::from_static(ANTHROPIC_API_VERSION),
    );
    response
}

fn json_error_with_headers(
    status: StatusCode,
    message: impl Into<String>,
    headers: HeaderMap,
) -> Response<Body> {
    let mut response = json_error(status, message);
    append_headers(response.headers_mut(), headers);
    response
}

fn anthropic_error_with_headers(
    status: StatusCode,
    error_type: &str,
    message: impl Into<String>,
    headers: HeaderMap,
) -> Response<Body> {
    let mut response = anthropic_error(status, error_type, message);
    append_headers(response.headers_mut(), headers);
    response
}

fn append_headers(target: &mut HeaderMap, headers: HeaderMap) {
    for (name, value) in headers {
        if let Some(name) = name {
            target.insert(name, value);
        }
    }
}

async fn upstream_error_response(response: reqwest::Response) -> Response<Body> {
    let status = response.status();
    let text = match response.text().await {
        Ok(text) => text,
        Err(_) => format!("Upstream returned HTTP {status}"),
    };
    json_error(status, text)
}

async fn send_upstream_request_with_retry<F>(
    client: &Client,
    route_label: &str,
    endpoint_label: &str,
    model_label: &str,
    stream: bool,
    effective_timeout_seconds: Option<u64>,
    reporting_context: Option<&ReportingContext>,
    bridge_timing: BridgeRequestTiming,
    mut build_request: F,
) -> std::result::Result<UpstreamResponse, UpstreamRequestError>
where
    F: FnMut(&Client) -> reqwest::RequestBuilder,
{
    let model_label = if model_label.is_empty() {
        "<unknown>"
    } else {
        model_label
    };
    let max_attempts = upstream_retry_max_attempts();

    for attempt in 1..=max_attempts {
        let dispatch_started_at = Instant::now();
        let dispatch_started_at_ms = current_time_millis();
        log_bridge_upstream_dispatch_start(
            route_label,
            endpoint_label,
            model_label,
            stream,
            reporting_context,
            bridge_timing,
            attempt,
            max_attempts,
            dispatch_started_at_ms,
        );
        let response = match build_request(client).send().await {
            Ok(response) => response,
            Err(error) => {
                let raw_error = error.to_string();
                warn_if_timeout_message_mismatch(
                    endpoint_label,
                    model_label,
                    &raw_error,
                    effective_timeout_seconds,
                );
                if attempt < max_attempts {
                    let wait_ms = compute_retry_delay_ms(None, attempt);
                    warn!(
                        route = route_label,
                        endpoint = endpoint_label,
                        model = model_label,
                        stream,
                        attempt,
                        max_attempts,
                        wait_ms,
                        chat_id = reporting_chat_id(reporting_context),
                        message_id = reporting_message_id(reporting_context),
                        session_id = reporting_session_id(reporting_context),
                        debug_request_id = reporting_debug_request_id(reporting_context),
                        upstream_request_id = reporting_upstream_request_id(reporting_context),
                        request_phase = reporting_request_phase(reporting_context),
                        followup_index = ?reporting_followup_index(reporting_context),
                        outer_message_id = reporting_outer_message_id(reporting_context),
                        trigger_message_id = reporting_trigger_message_id(reporting_context),
                        transcript_anchor_kind = reporting_transcript_anchor_kind(reporting_context),
                        transcript_anchor_message_id = reporting_transcript_anchor_message_id(reporting_context),
                        transcript_anchor_tool_block_index = ?reporting_transcript_anchor_tool_block_index(reporting_context),
                        prompt_submitted_at_ms = ?reporting_prompt_submitted_at_ms(reporting_context),
                        traceparent = reporting_traceparent(reporting_context),
                        tracestate_present = reporting_tracestate_present(reporting_context),
                        baggage_present = reporting_baggage_present(reporting_context),
                        submit_to_upstream_dispatch_ms = ?bridge_timing.submit_to_epoch_ms(dispatch_started_at_ms),
                        bridge_receive_to_upstream_dispatch_ms = bridge_timing.bridge_receive_to_now_ms(),
                        error = %error,
                        "Retrying transient upstream transport failure",
                    );
                    sleep_with_backoff(wait_ms).await;
                    continue;
                }

                warn!(
                    route = route_label,
                    endpoint = endpoint_label,
                    model = model_label,
                    stream,
                    attempt,
                    max_attempts,
                    chat_id = reporting_chat_id(reporting_context),
                    message_id = reporting_message_id(reporting_context),
                    session_id = reporting_session_id(reporting_context),
                    debug_request_id = reporting_debug_request_id(reporting_context),
                    upstream_request_id = reporting_upstream_request_id(reporting_context),
                    request_phase = reporting_request_phase(reporting_context),
                    followup_index = ?reporting_followup_index(reporting_context),
                    outer_message_id = reporting_outer_message_id(reporting_context),
                    trigger_message_id = reporting_trigger_message_id(reporting_context),
                    transcript_anchor_kind = reporting_transcript_anchor_kind(reporting_context),
                    transcript_anchor_message_id = reporting_transcript_anchor_message_id(reporting_context),
                    transcript_anchor_tool_block_index = ?reporting_transcript_anchor_tool_block_index(reporting_context),
                    prompt_submitted_at_ms = ?reporting_prompt_submitted_at_ms(reporting_context),
                    traceparent = reporting_traceparent(reporting_context),
                    tracestate_present = reporting_tracestate_present(reporting_context),
                    baggage_present = reporting_baggage_present(reporting_context),
                    submit_to_upstream_dispatch_ms = ?bridge_timing.submit_to_epoch_ms(dispatch_started_at_ms),
                    bridge_receive_to_upstream_dispatch_ms = bridge_timing.bridge_receive_to_now_ms(),
                    error = %error,
                    "Exhausted retries after upstream transport failure",
                );
                return Err(UpstreamRequestError {
                    status: StatusCode::BAD_GATEWAY,
                    message: transport_failure_message(),
                    headers: reqwest::header::HeaderMap::new(),
                });
            }
        };

        if response.status().is_success() {
            let response_meta = UpstreamRequestMeta {
                dispatch_started_at,
                dispatch_started_at_ms,
                attempt,
                max_attempts,
            };
            log_bridge_upstream_response_headers(
                route_label,
                endpoint_label,
                model_label,
                stream,
                reporting_context,
                bridge_timing,
                response_meta,
                response.status(),
                response.headers(),
            );
            if attempt > 1 {
                info!(
                    route = route_label,
                    endpoint = endpoint_label,
                    model = model_label,
                    stream,
                    attempt,
                    max_attempts,
                    chat_id = reporting_chat_id(reporting_context),
                    message_id = reporting_message_id(reporting_context),
                    session_id = reporting_session_id(reporting_context),
                    debug_request_id = reporting_debug_request_id(reporting_context),
                    upstream_request_id = reporting_upstream_request_id(reporting_context),
                    request_phase = reporting_request_phase(reporting_context),
                    followup_index = ?reporting_followup_index(reporting_context),
                    "Upstream request succeeded after retry",
                );
            }
            return Ok(UpstreamResponse {
                response,
                meta: response_meta,
            });
        }

        let status = response.status();
        let headers = response.headers().clone();
        let upstream_http_request_id = headers
            .get("x-request-id")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("-");
        let retry_after_ms = parse_retry_after_ms(&headers);
        let body_text = match response.text().await {
            Ok(text) => text,
            Err(error) => {
                warn!(
                    route = route_label,
                    endpoint = endpoint_label,
                    model = model_label,
                    stream,
                    attempt,
                    max_attempts,
                    status = %status,
                    upstream_http_request_id,
                    chat_id = reporting_chat_id(reporting_context),
                    message_id = reporting_message_id(reporting_context),
                    session_id = reporting_session_id(reporting_context),
                    debug_request_id = reporting_debug_request_id(reporting_context),
                    upstream_request_id = reporting_upstream_request_id(reporting_context),
                    request_phase = reporting_request_phase(reporting_context),
                    followup_index = ?reporting_followup_index(reporting_context),
                    prompt_submitted_at_ms = ?reporting_prompt_submitted_at_ms(reporting_context),
                    traceparent = reporting_traceparent(reporting_context),
                    tracestate_present = reporting_tracestate_present(reporting_context),
                    baggage_present = reporting_baggage_present(reporting_context),
                    upstream_dispatch_to_response_headers_ms = dispatch_started_at.elapsed().as_millis() as u64,
                    error = %error,
                    "Failed to read upstream error response body",
                );
                format!("Upstream returned HTTP {status}")
            }
        };
        let extracted_message = normalize_upstream_error_message(&body_text, status);
        warn_if_timeout_message_mismatch(
            endpoint_label,
            model_label,
            &extracted_message,
            effective_timeout_seconds,
        );
        let retryable = is_retryable_upstream_status(status);

        if retryable && attempt < max_attempts {
            let wait_ms = compute_retry_delay_ms(retry_after_ms, attempt);
            warn!(
                route = route_label,
                endpoint = endpoint_label,
                model = model_label,
                stream,
                attempt,
                max_attempts,
                status = %status,
                wait_ms,
                upstream_http_request_id,
                chat_id = reporting_chat_id(reporting_context),
                message_id = reporting_message_id(reporting_context),
                session_id = reporting_session_id(reporting_context),
                debug_request_id = reporting_debug_request_id(reporting_context),
                upstream_request_id = reporting_upstream_request_id(reporting_context),
                request_phase = reporting_request_phase(reporting_context),
                followup_index = ?reporting_followup_index(reporting_context),
                prompt_submitted_at_ms = ?reporting_prompt_submitted_at_ms(reporting_context),
                traceparent = reporting_traceparent(reporting_context),
                tracestate_present = reporting_tracestate_present(reporting_context),
                baggage_present = reporting_baggage_present(reporting_context),
                upstream_dispatch_to_response_headers_ms = dispatch_started_at.elapsed().as_millis() as u64,
                upstream_message = %extracted_message,
                "Retrying transient upstream response failure",
            );
            sleep_with_backoff(wait_ms).await;
            continue;
        }

        if retryable {
            warn!(
                route = route_label,
                endpoint = endpoint_label,
                model = model_label,
                stream,
                attempt,
                max_attempts,
                status = %status,
                upstream_http_request_id,
                chat_id = reporting_chat_id(reporting_context),
                message_id = reporting_message_id(reporting_context),
                session_id = reporting_session_id(reporting_context),
                debug_request_id = reporting_debug_request_id(reporting_context),
                upstream_request_id = reporting_upstream_request_id(reporting_context),
                request_phase = reporting_request_phase(reporting_context),
                followup_index = ?reporting_followup_index(reporting_context),
                prompt_submitted_at_ms = ?reporting_prompt_submitted_at_ms(reporting_context),
                traceparent = reporting_traceparent(reporting_context),
                tracestate_present = reporting_tracestate_present(reporting_context),
                baggage_present = reporting_baggage_present(reporting_context),
                upstream_dispatch_to_response_headers_ms = dispatch_started_at.elapsed().as_millis() as u64,
                upstream_message = %extracted_message,
                "Exhausted retries after transient upstream response failure",
            );
        } else {
            warn!(
                route = route_label,
                endpoint = endpoint_label,
                model = model_label,
                stream,
                attempt,
                max_attempts,
                status = %status,
                upstream_http_request_id,
                chat_id = reporting_chat_id(reporting_context),
                message_id = reporting_message_id(reporting_context),
                session_id = reporting_session_id(reporting_context),
                debug_request_id = reporting_debug_request_id(reporting_context),
                upstream_request_id = reporting_upstream_request_id(reporting_context),
                request_phase = reporting_request_phase(reporting_context),
                followup_index = ?reporting_followup_index(reporting_context),
                prompt_submitted_at_ms = ?reporting_prompt_submitted_at_ms(reporting_context),
                traceparent = reporting_traceparent(reporting_context),
                tracestate_present = reporting_tracestate_present(reporting_context),
                baggage_present = reporting_baggage_present(reporting_context),
                upstream_dispatch_to_response_headers_ms = dispatch_started_at.elapsed().as_millis() as u64,
                upstream_message = %extracted_message,
                "Returning non-retryable upstream response failure",
            );
        }

        return Err(UpstreamRequestError {
            status,
            message: if retryable {
                transient_failure_message(status)
            } else {
                extracted_message
            },
            headers,
        });
    }

    Err(UpstreamRequestError {
        status: StatusCode::BAD_GATEWAY,
        message: transport_failure_message(),
        headers: reqwest::header::HeaderMap::new(),
    })
}

fn parse_retry_after_ms(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    headers
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<f64>().ok())
        .map(|seconds| ((seconds * 1_000.0).round() as i64).max(0) as u64)
}

fn compute_retry_delay_ms(retry_after_ms: Option<u64>, attempt: u32) -> u64 {
    if let Some(retry_after_ms) = retry_after_ms {
        return retry_after_ms;
    }

    let exponent = attempt.saturating_sub(1).min(10);
    let multiplier = 1_u64 << exponent;
    upstream_retry_base_delay_ms()
        .saturating_mul(multiplier)
        .min(upstream_retry_max_delay_ms())
}

async fn sleep_with_backoff(wait_ms: u64) {
    if wait_ms > 0 {
        tokio::time::sleep(Duration::from_millis(wait_ms)).await;
    }
}

fn is_retryable_upstream_status(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::TOO_MANY_REQUESTS
            | StatusCode::BAD_GATEWAY
            | StatusCode::SERVICE_UNAVAILABLE
            | StatusCode::GATEWAY_TIMEOUT
    )
}

fn extract_error_message_from_json(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Value::Array(items) => items.iter().find_map(extract_error_message_from_json),
        Value::Object(object) => {
            if let Some(error) = object.get("error") {
                if let Some(message) = extract_error_message_from_json(error) {
                    return Some(message);
                }
            }
            for key in ["message", "detail", "content"] {
                if let Some(value) = object.get(key) {
                    if let Some(message) = extract_error_message_from_json(value) {
                        return Some(message);
                    }
                }
            }
            None
        }
        _ => None,
    }
}

fn normalize_upstream_error_message(body_text: &str, status: StatusCode) -> String {
    let trimmed = body_text.trim();
    if trimmed.is_empty() {
        return format!("Upstream returned HTTP {status}");
    }

    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        if let Some(message) = extract_error_message_from_json(&value) {
            return message;
        }
    }

    trimmed.to_string()
}

fn transient_failure_message(status: StatusCode) -> String {
    if status == StatusCode::TOO_MANY_REQUESTS {
        "Upstream model provider is temporarily rate limited. Please retry.".to_string()
    } else {
        "Upstream model provider is temporarily unavailable. Please retry.".to_string()
    }
}

fn transport_failure_message() -> String {
    "Unable to reach the upstream model provider. Please retry.".to_string()
}

fn normalize_stream_failure_message(raw_error: &str) -> String {
    let trimmed = raw_error.trim();
    if trimmed.is_empty() {
        return "Upstream model provider stream failed. Please retry.".to_string();
    }

    let lowered = trimmed.to_ascii_lowercase();
    if lowered.contains("timeout")
        || lowered.contains("timed out")
        || lowered.contains("i/o timeout")
        || lowered.contains("deadline has elapsed")
    {
        return "Upstream model provider stream timed out. Please retry.".to_string();
    }

    if lowered.contains("invalid utf-8") {
        return "Upstream model provider returned invalid stream data. Please retry.".to_string();
    }

    if lowered.contains("invalid")
        || lowered.contains("malformed")
        || lowered.contains("eof while parsing")
    {
        return "Upstream model provider returned an invalid stream response. Please retry."
            .to_string();
    }

    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        let normalized = normalize_upstream_error_message(trimmed, StatusCode::BAD_GATEWAY);
        if normalized != trimmed {
            return normalized;
        }
    }

    "Upstream model provider stream failed. Please retry.".to_string()
}

#[derive(Default)]
struct Utf8LineBuffer {
    pending: Vec<u8>,
}

impl Utf8LineBuffer {
    fn push_chunk(&mut self, chunk: &[u8]) {
        self.pending.extend_from_slice(chunk);
    }

    fn drain_complete_lines(&mut self) -> Result<Vec<String>> {
        let mut lines = Vec::new();
        while let Some(newline_index) = self.pending.iter().position(|byte| *byte == b'\n') {
            let mut line_bytes: Vec<u8> = self.pending.drain(..=newline_index).collect();
            if line_bytes.last() == Some(&b'\n') {
                line_bytes.pop();
            }
            if line_bytes.last() == Some(&b'\r') {
                line_bytes.pop();
            }
            lines.push(
                String::from_utf8(line_bytes)
                    .map_err(|error| anyhow!("Stream line contained invalid UTF-8: {error}"))?,
            );
        }
        Ok(lines)
    }

    fn finish(&mut self) -> Result<Option<String>> {
        if self.pending.is_empty() {
            return Ok(None);
        }

        let mut line_bytes = std::mem::take(&mut self.pending);
        if line_bytes.last() == Some(&b'\r') {
            line_bytes.pop();
        }

        String::from_utf8(line_bytes)
            .map(Some)
            .map_err(|error| anyhow!("Stream ended with invalid UTF-8 data: {error}"))
    }
}

fn openai_stream_error_chunks(raw_error: &str) -> Vec<Bytes> {
    let message = normalize_stream_failure_message(raw_error);
    vec![
        sse_data_bytes(&json!({"error":{"message": message}})),
        sse_done_bytes(),
    ]
}

fn anthropic_stream_error_chunks(raw_error: &str) -> Vec<Bytes> {
    let message = normalize_stream_failure_message(raw_error);
    vec![sse_bytes(
        "error",
        &json!({
            "type": "error",
            "error": {
                "type": "api_error",
                "message": message,
            }
        }),
    )]
}

fn passthrough_cost_headers(headers: &reqwest::header::HeaderMap) -> HeaderMap {
    let mut output = HeaderMap::new();
    for header_name in ["x-portico-cost-usd", "x-request-id", "retry-after"] {
        if let Some(value) = headers.get(header_name) {
            output.insert(
                HeaderName::from_bytes(header_name.as_bytes()).unwrap(),
                value.clone(),
            );
        }
    }
    output
}

fn merge_response_headers(response: &mut Response<Body>, extra_headers: &HeaderMap) {
    for (name, value) in extra_headers.iter() {
        response.headers_mut().insert(name, value.clone());
    }
}

fn extract_cost_hint(headers: &reqwest::header::HeaderMap) -> Option<f64> {
    headers
        .get("x-portico-cost-usd")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<f64>().ok())
}

fn rewrite_chat_completion_value(payload: &mut Value, entry: &ModelEntry, cost_hint: Option<f64>) {
    if let Some(object) = payload.as_object_mut() {
        object.insert("model".to_string(), Value::String(entry.alias.clone()));
        let computed_cost = object
            .get("usage")
            .and_then(Value::as_object)
            .and_then(|usage| compute_usage_cost(entry, usage));
        inject_usage_cost(object, cost_hint.or(computed_cost));
    }
}

fn inject_usage_cost(object: &mut serde_json::Map<String, Value>, cost_hint: Option<f64>) {
    let cost = if let Some(cost_hint) = cost_hint {
        Some(cost_hint)
    } else {
        object
            .get("extra_fields")
            .and_then(Value::as_object)
            .and_then(|extra| extra.get("provider_response_headers"))
            .and_then(Value::as_object)
            .and_then(|headers| headers.get("x-portico-cost-usd"))
            .and_then(Value::as_str)
            .and_then(|value| value.parse::<f64>().ok())
    };

    let Some(cost) = cost else {
        return;
    };

    if !object.contains_key("usage") {
        object.insert("usage".to_string(), Value::Object(Default::default()));
    }
    let usage = object
        .get_mut("usage")
        .expect("usage key should exist after initialization");
    if let Some(usage_object) = usage.as_object_mut() {
        if !usage_object.contains_key("cost") {
            usage_object.insert("cost".to_string(), json!(cost));
        }
    }
}

fn transform_bifrost_sse_line(
    line: &str,
    entry: &ModelEntry,
    cost_hint: Option<f64>,
) -> Result<Bytes> {
    if line.is_empty() {
        return Ok(Bytes::from_static(b"\n"));
    }

    if let Some(payload) = line.strip_prefix("data: ") {
        if payload.trim() == "[DONE]" {
            return Ok(Bytes::from(format!("{line}\n")));
        }
        let mut value: Value = serde_json::from_str(payload)?;
        if let Some(object) = value.as_object_mut() {
            object.insert("model".to_string(), Value::String(entry.alias.clone()));
            let computed_cost = object
                .get("usage")
                .and_then(Value::as_object)
                .and_then(|usage| compute_usage_cost(entry, usage));
            inject_usage_cost(object, cost_hint.or(computed_cost));
        }
        let serialized = serde_json::to_string(&value)
            .expect("serializing serde_json::Value should be infallible");
        return Ok(Bytes::from(format!("data: {serialized}\n")));
    }

    Ok(Bytes::from(format!("{line}\n")))
}

#[derive(Default)]
struct ResponsesStreamState {
    response_id: Option<String>,
    created: Option<i64>,
    role_sent: bool,
    text_emitted: bool,
    reasoning_emitted: bool,
    tool_calls_emitted: bool,
    terminal_chunk_sent: bool,
    done_sent: bool,
    event_count: usize,
    raw_text_delta_events: usize,
    raw_text_delta_chars: usize,
    raw_reasoning_delta_events: usize,
    raw_reasoning_delta_chars: usize,
    observed_tool_call_count: usize,
    usage_chunk_count: usize,
    last_event_name: Option<String>,
    terminal_event_name: Option<String>,
    final_finish_reason: Option<String>,
    final_stop_reason: Option<String>,
    saw_done_sentinel: bool,
    synthesized_text_delta: bool,
    synthesized_reasoning_delta: bool,
    synthesized_tool_call_delta: bool,
    ignored_event_names: BTreeSet<String>,
    reasoning_indicator_enabled: bool,
    reasoning_marker_sent: bool,
    reasoning_started_at_ms: Option<u64>,
    thinking_ended_at_ms: Option<u64>,
}

fn should_use_responses_api(entry: &ModelEntry) -> bool {
    entry.provider_kind == ProviderKind::OpenAI && entry.uses_responses_api
}

fn current_time_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn reporting_chat_id(context: Option<&ReportingContext>) -> &str {
    context.map(|ctx| ctx.chat_id.as_str()).unwrap_or("-")
}

fn reporting_message_id(context: Option<&ReportingContext>) -> &str {
    context.map(|ctx| ctx.message_id.as_str()).unwrap_or("-")
}

fn reporting_session_id(context: Option<&ReportingContext>) -> &str {
    context
        .and_then(|ctx| ctx.session_id.as_deref())
        .unwrap_or("-")
}

fn reporting_debug_request_id(context: Option<&ReportingContext>) -> &str {
    context
        .and_then(|ctx| ctx.debug_request_id.as_deref())
        .unwrap_or("-")
}

fn reporting_upstream_request_id(context: Option<&ReportingContext>) -> &str {
    context
        .and_then(|ctx| ctx.upstream_request_id.as_deref())
        .unwrap_or("-")
}

fn reporting_request_phase(context: Option<&ReportingContext>) -> &str {
    context
        .and_then(|ctx| ctx.request_phase.as_deref())
        .unwrap_or("-")
}

fn reporting_followup_index(context: Option<&ReportingContext>) -> Option<i64> {
    context.and_then(|ctx| ctx.followup_index)
}

fn reporting_outer_message_id(context: Option<&ReportingContext>) -> &str {
    context
        .and_then(|ctx| ctx.outer_message_id.as_deref())
        .unwrap_or("-")
}

fn reporting_trigger_message_id(context: Option<&ReportingContext>) -> &str {
    context
        .and_then(|ctx| ctx.trigger_message_id.as_deref())
        .unwrap_or("-")
}

fn reporting_transcript_anchor_kind(context: Option<&ReportingContext>) -> &str {
    context
        .and_then(|ctx| ctx.transcript_anchor_kind.as_deref())
        .unwrap_or("-")
}

fn reporting_transcript_anchor_message_id(context: Option<&ReportingContext>) -> &str {
    context
        .and_then(|ctx| ctx.transcript_anchor_message_id.as_deref())
        .unwrap_or("-")
}

fn reporting_transcript_anchor_tool_block_index(context: Option<&ReportingContext>) -> Option<i64> {
    context.and_then(|ctx| ctx.transcript_anchor_tool_block_index)
}

fn reporting_prompt_submitted_at_ms(context: Option<&ReportingContext>) -> Option<u64> {
    context.and_then(|ctx| ctx.prompt_submitted_at_ms)
}

fn reporting_traceparent(context: Option<&ReportingContext>) -> &str {
    context
        .and_then(|ctx| ctx.traceparent.as_deref())
        .unwrap_or("-")
}

fn reporting_tracestate_present(context: Option<&ReportingContext>) -> bool {
    context.is_some_and(ReportingContext::tracestate_present)
}

fn reporting_baggage_present(context: Option<&ReportingContext>) -> bool {
    context.is_some_and(ReportingContext::baggage_present)
}

fn should_log_client_token_chunk(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    let mut current_event_name = "";
    for line in text.lines() {
        if let Some(event_name) = line.strip_prefix("event: ") {
            current_event_name = event_name.trim();
            continue;
        }
        let Some(payload_text) = line.strip_prefix("data: ") else {
            continue;
        };
        let trimmed = payload_text.trim();
        if trimmed.is_empty() || trimmed == "[DONE]" {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(payload_text) else {
            return true;
        };
        if extract_usage_from_sse_bytes(bytes).is_some() {
            return false;
        }
        if value
            .pointer("/choices/0/delta")
            .and_then(Value::as_object)
            .is_some_and(|delta| {
                // Role announcements and reasoning-started markers are
                // bookkeeping, not client-visible tokens.
                delta
                    .keys()
                    .any(|key| key != "role" && key != "reasoning_status")
            })
        {
            return true;
        }
        if current_event_name == "content_block_delta"
            || current_event_name == "message_delta"
            || current_event_name == "input_json_delta"
        {
            return true;
        }
    }
    false
}

fn openai_stream_chunk_has_terminal_reason(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    for line in text.lines() {
        let Some(payload_text) = line.strip_prefix("data: ") else {
            continue;
        };
        let trimmed = payload_text.trim();
        if trimmed.is_empty() || trimmed == "[DONE]" {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(payload_text) else {
            continue;
        };
        if value.get("error").is_some() {
            return true;
        }
        if value
            .get("finish_reason")
            .is_some_and(|reason| !reason.is_null())
            || value
                .get("stop_reason")
                .is_some_and(|reason| !reason.is_null())
        {
            return true;
        }
        if let Some(choice) = value.pointer("/choices/0") {
            if choice
                .get("finish_reason")
                .is_some_and(|reason| !reason.is_null())
                || choice
                    .get("stop_reason")
                    .is_some_and(|reason| !reason.is_null())
            {
                return true;
            }
        }
    }
    false
}

fn apply_reporting_header(
    mut request: RequestBuilder,
    header_name: &str,
    header_value: &str,
    forward_to_nested_provider: bool,
) -> RequestBuilder {
    request = request.header(header_name, header_value);
    if forward_to_nested_provider {
        request = request.header(format!("x-bf-eh-{header_name}"), header_value);
    }
    request
}

fn apply_reporting_headers(
    mut request: RequestBuilder,
    context: Option<&ReportingContext>,
    forward_to_nested_provider: bool,
) -> RequestBuilder {
    let Some(context) = context else {
        return request;
    };

    request = apply_reporting_header(
        request,
        "x-openwebui-chat-id",
        context.chat_id.as_str(),
        forward_to_nested_provider,
    );
    request = apply_reporting_header(
        request,
        "x-openwebui-message-id",
        context.message_id.as_str(),
        forward_to_nested_provider,
    );
    if let Some(session_id) = context.session_id.as_deref() {
        request = apply_reporting_header(
            request,
            "x-openwebui-session-id",
            session_id,
            forward_to_nested_provider,
        );
    }
    if let Some(debug_request_id) = context.debug_request_id.as_deref() {
        request = apply_reporting_header(
            request,
            "x-openwebui-debug-request-id",
            debug_request_id,
            forward_to_nested_provider,
        );
    }
    if let Some(upstream_request_id) = context.upstream_request_id.as_deref() {
        request = apply_reporting_header(
            request,
            "x-openwebui-upstream-request-id",
            upstream_request_id,
            forward_to_nested_provider,
        );
    }
    if let Some(prompt_submitted_at_ms) = context.prompt_submitted_at_ms {
        let value = prompt_submitted_at_ms.to_string();
        request = apply_reporting_header(
            request,
            "x-openwebui-prompt-submitted-at-ms",
            value.as_str(),
            forward_to_nested_provider,
        );
    }
    if let Some(request_phase) = context.request_phase.as_deref() {
        request = apply_reporting_header(
            request,
            "x-openwebui-request-phase",
            request_phase,
            forward_to_nested_provider,
        );
    }
    if let Some(followup_index) = context.followup_index {
        let value = followup_index.to_string();
        request = apply_reporting_header(
            request,
            "x-openwebui-followup-index",
            value.as_str(),
            forward_to_nested_provider,
        );
    }
    if let Some(outer_message_id) = context.outer_message_id.as_deref() {
        request = apply_reporting_header(
            request,
            "x-openwebui-outer-message-id",
            outer_message_id,
            forward_to_nested_provider,
        );
    }
    if let Some(trigger_message_id) = context.trigger_message_id.as_deref() {
        request = apply_reporting_header(
            request,
            "x-openwebui-trigger-message-id",
            trigger_message_id,
            forward_to_nested_provider,
        );
    }
    if let Some(transcript_anchor_kind) = context.transcript_anchor_kind.as_deref() {
        request = apply_reporting_header(
            request,
            "x-openwebui-transcript-anchor-kind",
            transcript_anchor_kind,
            forward_to_nested_provider,
        );
    }
    if let Some(transcript_anchor_message_id) = context.transcript_anchor_message_id.as_deref() {
        request = apply_reporting_header(
            request,
            "x-openwebui-transcript-anchor-message-id",
            transcript_anchor_message_id,
            forward_to_nested_provider,
        );
    }
    if let Some(transcript_anchor_tool_block_index) = context.transcript_anchor_tool_block_index {
        let value = transcript_anchor_tool_block_index.to_string();
        request = apply_reporting_header(
            request,
            "x-openwebui-transcript-anchor-tool-block-index",
            value.as_str(),
            forward_to_nested_provider,
        );
    }
    if let Some(traceparent) = context.traceparent.as_deref() {
        request = apply_reporting_header(
            request,
            TRACEPARENT_HEADER,
            traceparent,
            forward_to_nested_provider,
        );
    }
    if let Some(tracestate) = context.tracestate.as_deref() {
        request = apply_reporting_header(
            request,
            TRACESTATE_HEADER,
            tracestate,
            forward_to_nested_provider,
        );
    }
    if let Some(baggage) = context.baggage.as_deref() {
        request =
            apply_reporting_header(request, BAGGAGE_HEADER, baggage, forward_to_nested_provider);
    }

    request
}

fn log_bridge_request_received(
    route: &str,
    endpoint: &str,
    model: &str,
    stream: bool,
    reporting_context: Option<&ReportingContext>,
    timing: BridgeRequestTiming,
) {
    info!(
        event = "bridge_request_received",
        route,
        endpoint,
        model,
        stream,
        chat_id = reporting_chat_id(reporting_context),
        message_id = reporting_message_id(reporting_context),
        session_id = reporting_session_id(reporting_context),
        debug_request_id = reporting_debug_request_id(reporting_context),
        upstream_request_id = reporting_upstream_request_id(reporting_context),
        request_phase = reporting_request_phase(reporting_context),
        followup_index = ?reporting_followup_index(reporting_context),
        outer_message_id = reporting_outer_message_id(reporting_context),
        trigger_message_id = reporting_trigger_message_id(reporting_context),
        transcript_anchor_kind = reporting_transcript_anchor_kind(reporting_context),
        transcript_anchor_message_id = reporting_transcript_anchor_message_id(reporting_context),
        transcript_anchor_tool_block_index = ?reporting_transcript_anchor_tool_block_index(reporting_context),
        prompt_submitted_at_ms = ?reporting_prompt_submitted_at_ms(reporting_context),
        traceparent = reporting_traceparent(reporting_context),
        tracestate_present = reporting_tracestate_present(reporting_context),
        baggage_present = reporting_baggage_present(reporting_context),
        bridge_received_at_ms = timing.bridge_received_at_ms,
        submit_to_bridge_receive_ms = ?timing.submit_to_bridge_receive_ms(),
        "Bridge received chat request",
    );
}

fn log_bridge_upstream_dispatch_start(
    route: &str,
    endpoint: &str,
    model: &str,
    stream: bool,
    reporting_context: Option<&ReportingContext>,
    timing: BridgeRequestTiming,
    attempt: u32,
    max_attempts: u32,
    dispatch_started_at_ms: u64,
) {
    info!(
        event = "bridge_upstream_dispatch_start",
        route,
        endpoint,
        model,
        stream,
        attempt,
        max_attempts,
        chat_id = reporting_chat_id(reporting_context),
        message_id = reporting_message_id(reporting_context),
        session_id = reporting_session_id(reporting_context),
        debug_request_id = reporting_debug_request_id(reporting_context),
        upstream_request_id = reporting_upstream_request_id(reporting_context),
        request_phase = reporting_request_phase(reporting_context),
        followup_index = ?reporting_followup_index(reporting_context),
        outer_message_id = reporting_outer_message_id(reporting_context),
        trigger_message_id = reporting_trigger_message_id(reporting_context),
        transcript_anchor_kind = reporting_transcript_anchor_kind(reporting_context),
        transcript_anchor_message_id = reporting_transcript_anchor_message_id(reporting_context),
        transcript_anchor_tool_block_index = ?reporting_transcript_anchor_tool_block_index(reporting_context),
        prompt_submitted_at_ms = ?reporting_prompt_submitted_at_ms(reporting_context),
        traceparent = reporting_traceparent(reporting_context),
        tracestate_present = reporting_tracestate_present(reporting_context),
        baggage_present = reporting_baggage_present(reporting_context),
        bridge_received_at_ms = timing.bridge_received_at_ms,
        upstream_dispatch_started_at_ms = dispatch_started_at_ms,
        submit_to_upstream_dispatch_ms = ?timing.submit_to_epoch_ms(dispatch_started_at_ms),
        bridge_receive_to_upstream_dispatch_ms = timing.bridge_receive_to_now_ms(),
        "Bridge is dispatching upstream request",
    );
}

fn log_bridge_upstream_response_headers(
    route: &str,
    endpoint: &str,
    model: &str,
    stream: bool,
    reporting_context: Option<&ReportingContext>,
    timing: BridgeRequestTiming,
    upstream_meta: UpstreamRequestMeta,
    status: StatusCode,
    response_headers: &reqwest::header::HeaderMap,
) {
    info!(
        event = "bridge_upstream_response_headers",
        route,
        endpoint,
        model,
        stream,
        attempt = upstream_meta.attempt,
        max_attempts = upstream_meta.max_attempts,
        status = %status,
        upstream_http_request_id = response_headers
            .get("x-request-id")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("-"),
        chat_id = reporting_chat_id(reporting_context),
        message_id = reporting_message_id(reporting_context),
        session_id = reporting_session_id(reporting_context),
        debug_request_id = reporting_debug_request_id(reporting_context),
        upstream_request_id = reporting_upstream_request_id(reporting_context),
        request_phase = reporting_request_phase(reporting_context),
        followup_index = ?reporting_followup_index(reporting_context),
        outer_message_id = reporting_outer_message_id(reporting_context),
        trigger_message_id = reporting_trigger_message_id(reporting_context),
        transcript_anchor_kind = reporting_transcript_anchor_kind(reporting_context),
        transcript_anchor_message_id = reporting_transcript_anchor_message_id(reporting_context),
        transcript_anchor_tool_block_index = ?reporting_transcript_anchor_tool_block_index(reporting_context),
        prompt_submitted_at_ms = ?reporting_prompt_submitted_at_ms(reporting_context),
        traceparent = reporting_traceparent(reporting_context),
        tracestate_present = reporting_tracestate_present(reporting_context),
        baggage_present = reporting_baggage_present(reporting_context),
        bridge_received_at_ms = timing.bridge_received_at_ms,
        upstream_dispatch_started_at_ms = upstream_meta.dispatch_started_at_ms,
        submit_to_upstream_dispatch_ms = ?timing.submit_to_epoch_ms(upstream_meta.dispatch_started_at_ms),
        bridge_receive_to_upstream_dispatch_ms = upstream_meta
            .dispatch_started_at
            .duration_since(timing.bridge_received_at)
            .as_millis() as u64,
        upstream_dispatch_to_response_headers_ms = upstream_meta
            .dispatch_started_at
            .elapsed()
            .as_millis() as u64,
        "Bridge received upstream response headers",
    );
}

fn log_bridge_upstream_first_chunk(
    route: &str,
    endpoint: &str,
    model: &str,
    reporting_context: Option<&ReportingContext>,
    timing: BridgeRequestTiming,
    upstream_meta: UpstreamRequestMeta,
    chunk_bytes: usize,
) {
    info!(
        event = "bridge_upstream_first_chunk",
        route,
        endpoint,
        model,
        attempt = upstream_meta.attempt,
        max_attempts = upstream_meta.max_attempts,
        chunk_bytes,
        chat_id = reporting_chat_id(reporting_context),
        message_id = reporting_message_id(reporting_context),
        session_id = reporting_session_id(reporting_context),
        debug_request_id = reporting_debug_request_id(reporting_context),
        upstream_request_id = reporting_upstream_request_id(reporting_context),
        request_phase = reporting_request_phase(reporting_context),
        followup_index = ?reporting_followup_index(reporting_context),
        outer_message_id = reporting_outer_message_id(reporting_context),
        trigger_message_id = reporting_trigger_message_id(reporting_context),
        transcript_anchor_kind = reporting_transcript_anchor_kind(reporting_context),
        transcript_anchor_message_id = reporting_transcript_anchor_message_id(reporting_context),
        transcript_anchor_tool_block_index = ?reporting_transcript_anchor_tool_block_index(reporting_context),
        prompt_submitted_at_ms = ?reporting_prompt_submitted_at_ms(reporting_context),
        traceparent = reporting_traceparent(reporting_context),
        tracestate_present = reporting_tracestate_present(reporting_context),
        baggage_present = reporting_baggage_present(reporting_context),
        bridge_received_at_ms = timing.bridge_received_at_ms,
        upstream_dispatch_started_at_ms = upstream_meta.dispatch_started_at_ms,
        upstream_dispatch_to_first_upstream_chunk_ms = upstream_meta
            .dispatch_started_at
            .elapsed()
            .as_millis() as u64,
        "Bridge observed first upstream response body chunk",
    );
}

fn log_bridge_first_client_token(
    route: &str,
    endpoint: &str,
    model: &str,
    reporting_context: Option<&ReportingContext>,
    timing: BridgeRequestTiming,
    upstream_meta: UpstreamRequestMeta,
) {
    info!(
        event = "bridge_first_client_token",
        route,
        endpoint,
        model,
        attempt = upstream_meta.attempt,
        max_attempts = upstream_meta.max_attempts,
        chat_id = reporting_chat_id(reporting_context),
        message_id = reporting_message_id(reporting_context),
        session_id = reporting_session_id(reporting_context),
        debug_request_id = reporting_debug_request_id(reporting_context),
        upstream_request_id = reporting_upstream_request_id(reporting_context),
        request_phase = reporting_request_phase(reporting_context),
        followup_index = ?reporting_followup_index(reporting_context),
        outer_message_id = reporting_outer_message_id(reporting_context),
        trigger_message_id = reporting_trigger_message_id(reporting_context),
        transcript_anchor_kind = reporting_transcript_anchor_kind(reporting_context),
        transcript_anchor_message_id = reporting_transcript_anchor_message_id(reporting_context),
        transcript_anchor_tool_block_index = ?reporting_transcript_anchor_tool_block_index(reporting_context),
        prompt_submitted_at_ms = ?reporting_prompt_submitted_at_ms(reporting_context),
        traceparent = reporting_traceparent(reporting_context),
        tracestate_present = reporting_tracestate_present(reporting_context),
        baggage_present = reporting_baggage_present(reporting_context),
        bridge_received_at_ms = timing.bridge_received_at_ms,
        upstream_dispatch_started_at_ms = upstream_meta.dispatch_started_at_ms,
        upstream_dispatch_to_first_client_token_ms = upstream_meta
            .dispatch_started_at
            .elapsed()
            .as_millis() as u64,
        "Bridge emitted first translated client response chunk",
    );
}

fn log_bridge_upstream_response_complete(
    route: &str,
    endpoint: &str,
    model: &str,
    reporting_context: Option<&ReportingContext>,
    timing: BridgeRequestTiming,
    upstream_meta: UpstreamRequestMeta,
    status: StatusCode,
) {
    info!(
        event = "bridge_upstream_response_complete",
        route,
        endpoint,
        model,
        status = %status,
        attempt = upstream_meta.attempt,
        max_attempts = upstream_meta.max_attempts,
        chat_id = reporting_chat_id(reporting_context),
        message_id = reporting_message_id(reporting_context),
        session_id = reporting_session_id(reporting_context),
        debug_request_id = reporting_debug_request_id(reporting_context),
        upstream_request_id = reporting_upstream_request_id(reporting_context),
        request_phase = reporting_request_phase(reporting_context),
        followup_index = ?reporting_followup_index(reporting_context),
        outer_message_id = reporting_outer_message_id(reporting_context),
        trigger_message_id = reporting_trigger_message_id(reporting_context),
        transcript_anchor_kind = reporting_transcript_anchor_kind(reporting_context),
        transcript_anchor_message_id = reporting_transcript_anchor_message_id(reporting_context),
        transcript_anchor_tool_block_index = ?reporting_transcript_anchor_tool_block_index(reporting_context),
        prompt_submitted_at_ms = ?reporting_prompt_submitted_at_ms(reporting_context),
        traceparent = reporting_traceparent(reporting_context),
        tracestate_present = reporting_tracestate_present(reporting_context),
        baggage_present = reporting_baggage_present(reporting_context),
        bridge_received_at_ms = timing.bridge_received_at_ms,
        upstream_dispatch_started_at_ms = upstream_meta.dispatch_started_at_ms,
        upstream_dispatch_to_response_complete_ms = upstream_meta
            .dispatch_started_at
            .elapsed()
            .as_millis() as u64,
        "Bridge completed non-stream upstream request",
    );
}

fn json_array_len(value: Option<&Value>) -> usize {
    value.and_then(Value::as_array).map(Vec::len).unwrap_or(0)
}

#[derive(Default)]
struct ResponsesRequestSummary {
    input_items: usize,
    top_level_tool_entries: usize,
    namespace_entries: usize,
    function_tools: usize,
    eager_function_tools: usize,
    deferred_function_tools: usize,
    tool_search_entries: usize,
    instructions_chars: usize,
    max_output_tokens: Option<i64>,
    prompt_cache_key_present: bool,
    prompt_cache_key_len: usize,
    prompt_cache_retention: Option<String>,
    reasoning_effort: Option<String>,
    service_tier: Option<String>,
}

fn summarize_responses_request(payload: &Value) -> ResponsesRequestSummary {
    let mut summary = ResponsesRequestSummary {
        input_items: json_array_len(payload.get("input")),
        top_level_tool_entries: json_array_len(payload.get("tools")),
        instructions_chars: payload
            .get("instructions")
            .and_then(Value::as_str)
            .map(|text| text.chars().count())
            .unwrap_or(0),
        max_output_tokens: payload.get("max_output_tokens").and_then(Value::as_i64),
        prompt_cache_key_present: payload
            .get("prompt_cache_key")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty()),
        prompt_cache_key_len: payload
            .get("prompt_cache_key")
            .and_then(Value::as_str)
            .map(str::len)
            .unwrap_or(0),
        prompt_cache_retention: payload
            .get("prompt_cache_retention")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        reasoning_effort: payload
            .pointer("/reasoning/effort")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        service_tier: payload
            .get("service_tier")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        ..Default::default()
    };

    if let Some(tools) = payload.get("tools").and_then(Value::as_array) {
        for tool in tools {
            match tool.get("type").and_then(Value::as_str).unwrap_or_default() {
                "namespace" => {
                    summary.namespace_entries += 1;
                    if let Some(namespace_tools) = tool.get("tools").and_then(Value::as_array) {
                        summary.function_tools += namespace_tools.len();
                        summary.deferred_function_tools += namespace_tools
                            .iter()
                            .filter(|tool| {
                                tool.get("defer_loading").and_then(Value::as_bool) == Some(true)
                            })
                            .count();
                    }
                }
                "function" => {
                    summary.function_tools += 1;
                    if tool.get("defer_loading").and_then(Value::as_bool) == Some(true) {
                        summary.deferred_function_tools += 1;
                    }
                }
                "tool_search" => summary.tool_search_entries += 1,
                _ => {}
            }
        }
    }
    summary.eager_function_tools = summary
        .function_tools
        .saturating_sub(summary.deferred_function_tools);

    summary
}

const CONTEXT_ESTIMATE_CHARS_PER_TOKEN: usize = 4;

/// Flat token allowance per base64 data-URL payload (images/files) in the
/// context estimate. Providers bill vision inputs by tile (~85 base +
/// ~170 per 512px tile — a large screenshot lands near 1.1k tokens), while
/// the base64 body can exceed a million characters (~286k "tokens" at
/// chars/4). Slightly generous is safe: the reporting-side
/// min(estimate, billed) clamp trims overshoot, while an undershoot would
/// stick.
const CONTEXT_ESTIMATE_DATA_URL_TOKENS: usize = 1_600;

fn is_base64_data_url(text: &str) -> bool {
    if !text.starts_with("data:") {
        return false;
    }
    // The data:<mediatype>[;params];base64, prefix is short; requiring the
    // marker near the head avoids misclassifying prose that merely quotes a
    // data URL further in.
    text.get(..256).unwrap_or(text).contains(";base64,")
}

/// Chars a serialized JSON value spends on base64 data-URL payloads beyond
/// the flat per-payload allowance. Subtracting this from the serialized
/// length prices each blob at the allowance while leaving everything else
/// at chars/4. Covers input_image image_url strings, input_file file_data,
/// and any other data-URL-bearing string in the tree (base64 bodies contain
/// no JSON-escaped characters, so string length equals serialized length).
fn data_url_excess_chars(value: &Value) -> usize {
    match value {
        Value::String(text) if is_base64_data_url(text) => text
            .len()
            .saturating_sub(CONTEXT_ESTIMATE_DATA_URL_TOKENS * CONTEXT_ESTIMATE_CHARS_PER_TOKEN),
        Value::Array(items) => items.iter().map(data_url_excess_chars).sum(),
        Value::Object(entries) => entries.values().map(data_url_excess_chars).sum(),
        _ => 0,
    }
}

/// Request-side estimate of the true context occupancy of a Responses API
/// call, in tokens. Billed `input_tokens` cannot be used for this: pro-mode
/// reasoning models aggregate hidden internal passes into it. Deferred tool
/// schemas travel on the wire but are excluded from the billed prompt until
/// fetched via tool_search, so they are excluded here too. Base64 data-URL
/// payloads are billed as vision/file tokens, not text — each is priced at
/// a flat allowance instead of chars/4.
fn estimate_responses_context_tokens(payload: &Value) -> Option<i64> {
    let mut chars = payload
        .get("instructions")
        .and_then(Value::as_str)
        .map(str::len)
        .unwrap_or(0);
    if let Some(input) = payload.get("input") {
        let serialized_chars = serde_json::to_string(input)
            .map(|text| text.len())
            .unwrap_or(0);
        chars += serialized_chars.saturating_sub(data_url_excess_chars(input));
    }
    if let Some(tools) = payload.get("tools").and_then(Value::as_array) {
        for tool in tools {
            match tool.get("type").and_then(Value::as_str).unwrap_or_default() {
                "namespace" => {
                    chars += tool
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::len)
                        .unwrap_or(0);
                    chars += tool
                        .get("description")
                        .and_then(Value::as_str)
                        .map(str::len)
                        .unwrap_or(0);
                    if let Some(namespace_tools) = tool.get("tools").and_then(Value::as_array) {
                        for namespace_tool in namespace_tools {
                            if namespace_tool.get("defer_loading").and_then(Value::as_bool)
                                == Some(true)
                            {
                                continue;
                            }
                            chars += serde_json::to_string(namespace_tool)
                                .map(|text| text.len())
                                .unwrap_or(0);
                        }
                    }
                }
                "function" => {
                    if tool.get("defer_loading").and_then(Value::as_bool) == Some(true) {
                        continue;
                    }
                    chars += serde_json::to_string(tool)
                        .map(|text| text.len())
                        .unwrap_or(0);
                }
                _ => {}
            }
        }
    }
    let estimate = (chars / CONTEXT_ESTIMATE_CHARS_PER_TOKEN) as i64;
    (estimate > 0).then_some(estimate)
}

/// Context occupancy from billed usage, for providers where billed tokens
/// faithfully measure the request context (everything except pro-mode
/// Responses calls).
fn context_tokens_from_billed_usage(usage: &Value) -> Option<i64> {
    if let Some(prompt_tokens) =
        first_i64_at_paths(usage, &["/prompt_tokens"]).filter(|tokens| *tokens > 0)
    {
        // OpenAI/Bifrost-translated shapes are inclusive of cached traffic.
        return Some(prompt_tokens);
    }
    // Anthropic-native shape: input_tokens excludes cache reads/writes.
    let input_tokens = first_i64_at_paths(usage, &["/input_tokens"])
        .unwrap_or(0)
        .max(0);
    let cache_read = first_i64_at_paths(usage, &["/cache_read_input_tokens"])
        .unwrap_or(0)
        .max(0);
    let cache_write = first_i64_at_paths(usage, &["/cache_creation_input_tokens"])
        .unwrap_or(0)
        .max(0);
    let total = input_tokens + cache_read + cache_write;
    (total > 0).then_some(total)
}

#[derive(Clone, Debug)]
struct NamespaceMetadata {
    prefix: String,
    description: String,
    _server_id: Option<String>,
    is_core: bool,
}

#[derive(Default)]
struct NamespaceMetadataSummary {
    total_entries: usize,
    core_entries: usize,
    non_core_entries: usize,
}

fn summarize_namespace_metadata(tool_namespaces: Option<&Value>) -> NamespaceMetadataSummary {
    let entries = parse_namespace_map(tool_namespaces);
    NamespaceMetadataSummary {
        total_entries: entries.len(),
        core_entries: entries.iter().filter(|entry| entry.is_core).count(),
        non_core_entries: entries.iter().filter(|entry| !entry.is_core).count(),
    }
}

fn first_i64_at_paths(value: &Value, paths: &[&str]) -> Option<i64> {
    paths.iter().find_map(|path| {
        value.pointer(path).and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
                .or_else(|| value.as_f64().map(|value| value as i64))
        })
    })
}

fn first_f64_at_paths(value: &Value, paths: &[&str]) -> Option<f64> {
    paths.iter().find_map(|path| {
        value.pointer(path).and_then(|value| {
            value
                .as_f64()
                .or_else(|| value.as_i64().map(|value| value as f64))
                .or_else(|| value.as_u64().map(|value| value as f64))
        })
    })
}

fn summarize_usage_for_log(usage: &Value) -> String {
    format!(
        "prompt_tokens={} completion_tokens={} total_tokens={} cached_tokens={} cache_read_tokens={} cache_write_tokens={} reasoning_tokens={} cost={}",
        first_i64_at_paths(usage, &["/prompt_tokens", "/input_tokens"]).unwrap_or(0),
        first_i64_at_paths(usage, &["/completion_tokens", "/output_tokens"]).unwrap_or(0),
        first_i64_at_paths(usage, &["/total_tokens"]).unwrap_or(0),
        first_i64_at_paths(
            usage,
            &[
                "/cached_tokens",
                "/cachedContentTokenCount",
                "/cached_content_token_count",
                "/prompt_tokens_details/cached_tokens",
                "/prompt_tokens_details/cachedContentTokenCount",
                "/prompt_tokens_details/cached_content_token_count",
                "/input_tokens_details/cached_tokens",
                "/input_tokens_details/cached_read_tokens"
            ]
        )
        .unwrap_or(0),
        first_i64_at_paths(
            usage,
            &[
                "/cache_read_input_tokens",
                "/cachedContentTokenCount",
                "/cached_content_token_count",
                "/prompt_tokens_details/cached_read_tokens",
                "/prompt_tokens_details/cache_read_input_tokens",
                "/prompt_tokens_details/cachedContentTokenCount",
                "/prompt_tokens_details/cached_content_token_count",
                "/input_tokens_details/cached_read_tokens"
            ]
        )
        .unwrap_or(0),
        first_i64_at_paths(
            usage,
            &[
                "/cache_write_input_tokens",
                "/cache_creation_input_tokens",
                "/prompt_tokens_details/cached_write_tokens",
                "/prompt_tokens_details/cache_write_tokens",
                "/prompt_tokens_details/cache_creation_input_tokens",
                "/input_tokens_details/cached_write_tokens"
            ]
        )
        .unwrap_or(0),
        first_i64_at_paths(
            usage,
            &[
                "/completion_tokens_details/reasoning_tokens",
                "/output_tokens_details/reasoning_tokens"
            ]
        )
        .unwrap_or(0),
        first_f64_at_paths(usage, &["/cost"])
            .map(|value| format!("{value:.6}"))
            .unwrap_or_else(|| "n/a".to_string()),
    )
}

#[derive(Default)]
struct AnthropicRequestSummary {
    message_count: usize,
    system_blocks: usize,
    tool_count: usize,
    cache_control_blocks: usize,
    cache_control_ttls: Vec<String>,
    mcp_server_count: usize,
    max_tokens: Option<i64>,
    tool_choice: Option<String>,
    thinking_enabled: bool,
    thinking_type: Option<String>,
    thinking_display: Option<String>,
    output_config_effort: Option<String>,
}

#[derive(Default)]
struct AnthropicResponseSummary {
    content_blocks: usize,
    text_blocks: usize,
    thinking_blocks: usize,
    tool_use_blocks: usize,
    stop_reason: Option<String>,
    usage: Option<Value>,
}

fn count_cache_control_blocks(value: &Value) -> usize {
    match value {
        Value::Array(items) => items.iter().map(count_cache_control_blocks).sum(),
        Value::Object(map) => {
            usize::from(map.contains_key("cache_control"))
                + map.values().map(count_cache_control_blocks).sum::<usize>()
        }
        _ => 0,
    }
}

fn collect_cache_control_ttls(value: &Value, ttls: &mut BTreeSet<String>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_cache_control_ttls(item, ttls);
            }
        }
        Value::Object(map) => {
            if let Some(ttl) = map
                .get("cache_control")
                .and_then(Value::as_object)
                .and_then(|cache_control| cache_control.get("ttl"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|ttl| !ttl.is_empty())
            {
                ttls.insert(ttl.to_string());
            }
            for item in map.values() {
                collect_cache_control_ttls(item, ttls);
            }
        }
        _ => {}
    }
}

fn summarize_anthropic_request(request: &Value) -> AnthropicRequestSummary {
    let system_blocks = match request.get("system") {
        Some(Value::Array(items)) => items.len(),
        Some(Value::String(text)) if !text.trim().is_empty() => 1,
        Some(Value::Null) | None => 0,
        Some(_) => 1,
    };
    let tool_choice = request.get("tool_choice").and_then(|value| {
        value
            .get("type")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| value.as_str().map(str::to_string))
    });
    let mcp_server_count = request
        .get("mcp_servers")
        .map(|value| match value {
            Value::Array(items) => items.len(),
            Value::Object(map) => map.len(),
            _ => 1,
        })
        .unwrap_or(0);

    let thinking_type = request
        .pointer("/thinking/type")
        .and_then(Value::as_str)
        .map(str::to_string);
    let thinking_display = request
        .pointer("/thinking/display")
        .and_then(Value::as_str)
        .map(str::to_string);
    let output_config_effort = request
        .pointer("/output_config/effort")
        .and_then(Value::as_str)
        .map(str::to_string);
    let thinking_enabled = match thinking_type.as_deref() {
        Some("disabled") => false,
        Some(_) => true,
        None => request.get("thinking").is_some(),
    };

    AnthropicRequestSummary {
        message_count: json_array_len(request.get("messages")),
        system_blocks,
        tool_count: json_array_len(request.get("tools")),
        cache_control_blocks: count_cache_control_blocks(request),
        cache_control_ttls: {
            let mut ttls = BTreeSet::new();
            collect_cache_control_ttls(request, &mut ttls);
            ttls.into_iter().collect()
        },
        mcp_server_count,
        max_tokens: request.get("max_tokens").and_then(Value::as_i64),
        tool_choice,
        thinking_enabled,
        thinking_type,
        thinking_display,
        output_config_effort,
    }
}

fn summarize_anthropic_response(payload: &Value) -> AnthropicResponseSummary {
    let mut summary = AnthropicResponseSummary {
        content_blocks: json_array_len(payload.get("content")),
        stop_reason: payload
            .get("stop_reason")
            .and_then(Value::as_str)
            .map(str::to_string),
        usage: payload.get("usage").cloned(),
        ..Default::default()
    };

    if let Some(content) = payload.get("content").and_then(Value::as_array) {
        for block in content {
            match block
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
            {
                "text" => summary.text_blocks += 1,
                "thinking" => summary.thinking_blocks += 1,
                "tool_use" => summary.tool_use_blocks += 1,
                _ => {}
            }
        }
    }

    summary
}

fn log_anthropic_stream_progress(
    state: &StreamTranslationState,
    model: &str,
    reporting_context: Option<&ReportingContext>,
    bridge_timing: BridgeRequestTiming,
    upstream_meta: UpstreamRequestMeta,
    logged_first_client_token: &mut bool,
    saw_text_before: bool,
    saw_thinking_before: bool,
    saw_redacted_before: bool,
    saw_tool_use_before: bool,
) {
    if !saw_text_before && state.text_delta_events > 0 {
        if !*logged_first_client_token {
            *logged_first_client_token = true;
            log_bridge_first_client_token(
                "anthropic_messages",
                "bedrock converse",
                model,
                reporting_context,
                bridge_timing,
                upstream_meta,
            );
        }
        info!(
            endpoint = "bedrock converse",
            model,
            anthropic_message_id = %state.message_id,
            delta_chars = state.text_delta_chars,
            chat_id = reporting_chat_id(reporting_context),
            message_id = reporting_message_id(reporting_context),
            session_id = reporting_session_id(reporting_context),
            "Observed first Anthropic text delta from converse stream",
        );
    }

    if !saw_thinking_before && state.thinking_delta_events > 0 {
        if !*logged_first_client_token {
            *logged_first_client_token = true;
            log_bridge_first_client_token(
                "anthropic_messages",
                "bedrock converse",
                model,
                reporting_context,
                bridge_timing,
                upstream_meta,
            );
        }
        info!(
            endpoint = "bedrock converse",
            model,
            anthropic_message_id = %state.message_id,
            delta_chars = state.thinking_delta_chars,
            chat_id = reporting_chat_id(reporting_context),
            message_id = reporting_message_id(reporting_context),
            session_id = reporting_session_id(reporting_context),
            "Observed first Anthropic thinking delta from converse stream",
        );
    }

    if !saw_redacted_before && state.redacted_reasoning_events > 0 {
        info!(
            endpoint = "bedrock converse",
            model,
            anthropic_message_id = %state.message_id,
            redacted_reasoning_events = state.redacted_reasoning_events,
            redacted_reasoning_chars = state.redacted_reasoning_chars,
            chat_id = reporting_chat_id(reporting_context),
            message_id = reporting_message_id(reporting_context),
            session_id = reporting_session_id(reporting_context),
            "Observed redacted Anthropic reasoning payload from converse stream",
        );
    }

    if !saw_tool_use_before && state.tool_use_blocks > 0 {
        if !*logged_first_client_token {
            *logged_first_client_token = true;
            log_bridge_first_client_token(
                "anthropic_messages",
                "bedrock converse",
                model,
                reporting_context,
                bridge_timing,
                upstream_meta,
            );
        }
        info!(
            endpoint = "bedrock converse",
            model,
            anthropic_message_id = %state.message_id,
            tool_use_blocks = state.tool_use_blocks,
            chat_id = reporting_chat_id(reporting_context),
            message_id = reporting_message_id(reporting_context),
            session_id = reporting_session_id(reporting_context),
            "Observed first Anthropic tool use block from converse stream",
        );
    }
}

fn log_anthropic_stream_terminal(
    state: &StreamTranslationState,
    model: &str,
    reporting_context: Option<&ReportingContext>,
) {
    let usage = state
        .final_usage
        .as_ref()
        .map(summarize_usage_for_log)
        .unwrap_or_else(|| "none".to_string());

    if let Some(error) = state.stream_error_message.as_deref() {
        warn!(
            endpoint = "bedrock converse",
            model,
            anthropic_message_id = %state.message_id,
            stop_reason = state.final_stop_reason.as_deref().unwrap_or("-"),
            raw_chunk_count = state.raw_chunk_count,
            text_delta_events = state.text_delta_events,
            text_delta_chars = state.text_delta_chars,
            thinking_delta_events = state.thinking_delta_events,
            thinking_delta_chars = state.thinking_delta_chars,
            redacted_reasoning_events = state.redacted_reasoning_events,
            redacted_reasoning_chars = state.redacted_reasoning_chars,
            tool_use_blocks = state.tool_use_blocks,
            tool_input_delta_events = state.tool_input_delta_events,
            message_stop_emitted = state.message_stop_emitted,
            usage = %usage,
            error,
            chat_id = reporting_chat_id(reporting_context),
            message_id = reporting_message_id(reporting_context),
            session_id = reporting_session_id(reporting_context),
            "Anthropic converse stream ended with an error",
        );
    } else {
        info!(
            endpoint = "bedrock converse",
            model,
            anthropic_message_id = %state.message_id,
            stop_reason = state.final_stop_reason.as_deref().unwrap_or("-"),
            raw_chunk_count = state.raw_chunk_count,
            text_delta_events = state.text_delta_events,
            text_delta_chars = state.text_delta_chars,
            thinking_delta_events = state.thinking_delta_events,
            thinking_delta_chars = state.thinking_delta_chars,
            redacted_reasoning_events = state.redacted_reasoning_events,
            redacted_reasoning_chars = state.redacted_reasoning_chars,
            tool_use_blocks = state.tool_use_blocks,
            tool_input_delta_events = state.tool_input_delta_events,
            message_stop_emitted = state.message_stop_emitted,
            usage = %usage,
            chat_id = reporting_chat_id(reporting_context),
            message_id = reporting_message_id(reporting_context),
            session_id = reporting_session_id(reporting_context),
            "Translated Anthropic converse stream to Anthropic SSE payload",
        );
    }
}

fn extract_openwebui_prompt_cache_affinity(headers: &HeaderMap) -> Option<String> {
    for header_name in ["x-openwebui-chat-id", "x-openwebui-session-id"] {
        if let Some(value) = headers
            .get(header_name)
            .and_then(|value| value.to_str().ok())
        {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn has_openwebui_reporting_headers(headers: &HeaderMap) -> bool {
    ["x-openwebui-chat-id", "x-openwebui-message-id"]
        .iter()
        .all(|header_name| {
            headers
                .get(*header_name)
                .and_then(|value| value.to_str().ok())
                .map(str::trim)
                .is_some_and(|value| !value.is_empty())
        })
}

fn extract_leading_system_messages(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .take_while(|message| message.get("role").and_then(Value::as_str) == Some("system"))
        .cloned()
        .collect()
}

fn inject_claude_system_messages_passthrough(payload: &mut Value, provider_kind: ProviderKind) {
    if provider_kind != ProviderKind::AnthropicConverse {
        return;
    }

    let system_messages = payload
        .get("messages")
        .and_then(Value::as_array)
        .map(|messages| extract_leading_system_messages(messages))
        .unwrap_or_default();
    if system_messages.is_empty() {
        return;
    }

    let Some(object) = payload.as_object_mut() else {
        return;
    };
    object.insert(
        CLAUDE_SYSTEM_MESSAGES_PASSTHROUGH_KEY.to_string(),
        Value::Array(system_messages),
    );
}

fn system_block_from_openai_content_block(block: &Value) -> Option<Value> {
    match block {
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(json!({"type":"text","text":text}))
            }
        }
        Value::Object(object) => {
            let text = object
                .get("text")
                .and_then(Value::as_str)
                .or_else(|| object.get("thinking").and_then(Value::as_str))?;
            if text.trim().is_empty() {
                return None;
            }

            let mut block_object = Map::new();
            block_object.insert("type".to_string(), Value::String("text".to_string()));
            block_object.insert("text".to_string(), Value::String(text.to_string()));
            if let Some(cache_control) = object.get("cache_control") {
                block_object.insert("cache_control".to_string(), cache_control.clone());
            }
            Some(Value::Object(block_object))
        }
        _ => None,
    }
}

fn system_blocks_from_openai_message(message: &Value) -> Vec<Value> {
    if message.get("role").and_then(Value::as_str) != Some("system") {
        return Vec::new();
    }

    match message.get("content") {
        Some(Value::String(text)) if !text.trim().is_empty() => {
            vec![json!({"type":"text","text":text})]
        }
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(system_block_from_openai_content_block)
            .collect(),
        _ => Vec::new(),
    }
}

fn restore_claude_system_messages_from_passthrough(request_body: &mut Value) -> bool {
    let Some(object) = request_body.as_object_mut() else {
        return false;
    };
    let Some(preserved_messages) = object.remove(CLAUDE_SYSTEM_MESSAGES_PASSTHROUGH_KEY) else {
        return false;
    };
    let Some(messages) = preserved_messages.as_array() else {
        return false;
    };

    let system_blocks: Vec<Value> = messages
        .iter()
        .flat_map(system_blocks_from_openai_message)
        .collect();
    if system_blocks.is_empty() {
        object.remove("system");
        return false;
    }

    object.insert("system".to_string(), Value::Array(system_blocks));
    true
}

fn inject_reporting_context_into_payload(
    payload: &mut Value,
    reporting_context: Option<&ReportingContext>,
) {
    let Some(context) = reporting_context else {
        return;
    };
    let Some(object) = payload.as_object_mut() else {
        return;
    };
    let metadata = object
        .entry("metadata".to_string())
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    let Some(metadata_object) = metadata.as_object_mut() else {
        return;
    };

    if !metadata_object.contains_key("chat_id") {
        metadata_object.insert(
            "chat_id".to_string(),
            Value::String(context.chat_id.clone()),
        );
    }
    if !metadata_object.contains_key("message_id") {
        metadata_object.insert(
            "message_id".to_string(),
            Value::String(context.message_id.clone()),
        );
    }
    if !metadata_object.contains_key("session_id") {
        if let Some(session_id) = context.session_id.as_deref() {
            metadata_object.insert(
                "session_id".to_string(),
                Value::String(session_id.to_string()),
            );
        }
    }
    if !metadata_object.contains_key("debug_request_id") {
        if let Some(debug_request_id) = context.debug_request_id.as_deref() {
            metadata_object.insert(
                "debug_request_id".to_string(),
                Value::String(debug_request_id.to_string()),
            );
        }
    }
    if !metadata_object.contains_key("upstream_request_id") {
        if let Some(upstream_request_id) = context.upstream_request_id.as_deref() {
            metadata_object.insert(
                "upstream_request_id".to_string(),
                Value::String(upstream_request_id.to_string()),
            );
        }
    }
    if !metadata_object.contains_key("prompt_submitted_at_ms") {
        if let Some(prompt_submitted_at_ms) = context.prompt_submitted_at_ms {
            metadata_object.insert(
                "prompt_submitted_at_ms".to_string(),
                Value::Number(prompt_submitted_at_ms.into()),
            );
        }
    }
    if !metadata_object.contains_key("request_phase") {
        if let Some(request_phase) = context.request_phase.as_deref() {
            metadata_object.insert(
                "request_phase".to_string(),
                Value::String(request_phase.to_string()),
            );
        }
    }
    if !metadata_object.contains_key("followup_index") {
        if let Some(followup_index) = context.followup_index {
            metadata_object.insert(
                "followup_index".to_string(),
                Value::Number(followup_index.into()),
            );
        }
    }
    if !metadata_object.contains_key("outer_message_id") {
        if let Some(outer_message_id) = context.outer_message_id.as_deref() {
            metadata_object.insert(
                "outer_message_id".to_string(),
                Value::String(outer_message_id.to_string()),
            );
        }
    }
    if !metadata_object.contains_key("trigger_message_id") {
        if let Some(trigger_message_id) = context.trigger_message_id.as_deref() {
            metadata_object.insert(
                "trigger_message_id".to_string(),
                Value::String(trigger_message_id.to_string()),
            );
        }
    }
    if !metadata_object.contains_key("transcript_anchor_kind") {
        if let Some(transcript_anchor_kind) = context.transcript_anchor_kind.as_deref() {
            metadata_object.insert(
                "transcript_anchor_kind".to_string(),
                Value::String(transcript_anchor_kind.to_string()),
            );
        }
    }
    if !metadata_object.contains_key("transcript_anchor_message_id") {
        if let Some(transcript_anchor_message_id) = context.transcript_anchor_message_id.as_deref()
        {
            metadata_object.insert(
                "transcript_anchor_message_id".to_string(),
                Value::String(transcript_anchor_message_id.to_string()),
            );
        }
    }
    if !metadata_object.contains_key("transcript_anchor_tool_block_index") {
        if let Some(transcript_anchor_tool_block_index) = context.transcript_anchor_tool_block_index
        {
            metadata_object.insert(
                "transcript_anchor_tool_block_index".to_string(),
                Value::Number(transcript_anchor_tool_block_index.into()),
            );
        }
    }
}

async fn maybe_report_usage_event(
    state: &AppState,
    context: Option<&ReportingContext>,
    call_id: &str,
    model_id: &str,
    model_name: &str,
    usage: &Value,
    context_tokens_estimate: Option<i64>,
) {
    let Some(reporting_dir) = state.reporting_dir.as_ref() else {
        return;
    };
    let Some(context) = context else {
        return;
    };
    if context.is_forwarded_nested_provider_request() {
        return;
    }
    let Some(event) = build_usage_event(
        context,
        call_id,
        model_id,
        model_name,
        usage,
        context_tokens_estimate,
    ) else {
        return;
    };

    if let Err(error) = write_usage_event(reporting_dir, &event).await {
        warn!(
            chat_id = %context.chat_id,
            message_id = %context.message_id,
            model = %model_id,
            error = %error,
            "Failed to persist backend reporting event",
        );
    }
}

async fn maybe_report_stream_failure_event(
    state: &AppState,
    context: Option<&ReportingContext>,
    call_id: &str,
    endpoint: &str,
    model_name: &str,
    upstream_response_headers: &BTreeMap<String, String>,
    failure: &Value,
    request_shape: &Value,
    stream_progress: &Value,
) {
    let Some(reporting_dir) = state.reporting_dir.as_ref() else {
        return;
    };
    let Some(context) = context else {
        return;
    };

    let event = build_stream_failure_event(
        context,
        call_id,
        endpoint,
        model_name,
        upstream_response_headers,
        failure,
        request_shape,
        stream_progress,
    );

    if let Err(error) = write_stream_failure_event(reporting_dir, &event).await {
        warn!(
            chat_id = %context.chat_id,
            message_id = %context.message_id,
            endpoint,
            model = %model_name,
            error = %error,
            "Failed to persist backend stream failure event",
        );
    }
}

fn chat_completion_to_responses_payload(payload: &Value, entry: &ModelEntry) -> Result<Value> {
    let mut object = payload
        .as_object()
        .cloned()
        .ok_or_else(|| anyhow!("chat completion request must be a JSON object"))?;

    object.insert(
        "model".to_string(),
        Value::String(entry.provider_model.clone()),
    );

    // Extract namespace metadata before message/tool conversion so both paths share it.
    let tool_namespaces = object.remove("_tool_namespaces");
    let ns_map = parse_namespace_map(tool_namespaces.as_ref());

    let messages = object
        .remove("messages")
        .ok_or_else(|| anyhow!("chat completion request is missing messages"))?;
    let (instructions, input) = chat_messages_to_responses_payload_parts(messages, &ns_map)?;
    object.insert("input".to_string(), input);
    if let Some(instructions) = instructions {
        object.insert("instructions".to_string(), Value::String(instructions));
    }

    let max_tokens = object
        .remove("max_output_tokens")
        .or_else(|| object.remove("max_completion_tokens"))
        .or_else(|| object.remove("max_tokens"));
    if let Some(value) = max_tokens {
        object.insert("max_output_tokens".to_string(), value);
    }

    if let Some(tools) = object.remove("tools") {
        object.insert(
            "tools".to_string(),
            chat_tools_to_responses_tools(tools, tool_namespaces),
        );
    }

    if let Some(tool_choice) = object.remove("tool_choice") {
        object.insert(
            "tool_choice".to_string(),
            chat_tool_choice_to_responses_tool_choice(tool_choice),
        );
    }

    object.remove("stream_options");
    object.remove("n");

    Ok(Value::Object(object))
}

fn chat_message_content_to_plain_text(message: &Value) -> Option<String> {
    let content = message.get("content")?;
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }

    let blocks = content.as_array()?;
    let mut combined = String::new();
    for block in blocks {
        if let Some(text) = block.get("text").and_then(Value::as_str) {
            combined.push_str(text);
            continue;
        }
        if let Some(text) = block.get("thinking").and_then(Value::as_str) {
            combined.push_str(text);
            continue;
        }
        return None;
    }

    if combined.is_empty() {
        None
    } else {
        Some(combined)
    }
}

fn split_responses_instructions_and_messages(messages: &[Value]) -> (Option<String>, Vec<Value>) {
    let mut instruction_blocks = Vec::new();
    let mut instruction_count = 0usize;

    for message in messages {
        if message.get("role").and_then(Value::as_str) != Some("system") {
            break;
        }
        let Some(text) = chat_message_content_to_plain_text(message) else {
            break;
        };
        instruction_blocks.push(text);
        instruction_count += 1;
    }

    if instruction_blocks.is_empty() {
        return (None, messages.to_vec());
    }

    let remaining = messages[instruction_count..].to_vec();
    (Some(instruction_blocks.join("\n\n")), remaining)
}

fn chat_messages_to_responses_payload_parts(
    messages: Value,
    ns_map: &[NamespaceMetadata],
) -> Result<(Option<String>, Value)> {
    let Some(items) = messages.as_array() else {
        return Ok((None, messages));
    };

    let (instructions, remaining_messages) = split_responses_instructions_and_messages(items);
    let input = chat_messages_to_responses_input(Value::Array(remaining_messages), ns_map)?;
    Ok((instructions, input))
}

fn chat_messages_to_responses_input(
    messages: Value,
    ns_map: &[NamespaceMetadata],
) -> Result<Value> {
    let Some(items) = messages.as_array() else {
        return Ok(messages);
    };

    let mut input = Vec::new();
    for message in items {
        input.extend(chat_message_to_responses_input_items(message, ns_map)?);
    }

    Ok(Value::Array(input))
}

fn chat_message_to_responses_input_items(
    message: &Value,
    ns_map: &[NamespaceMetadata],
) -> Result<Vec<Value>> {
    let Some(message_object) = message.as_object() else {
        return Ok(vec![message.clone()]);
    };

    match message_object.get("role").and_then(Value::as_str) {
        Some("assistant") => {
            chat_assistant_message_to_responses_input_items(message_object, ns_map)
        }
        Some("tool") => Ok(vec![chat_tool_message_to_responses_input_item(
            message_object,
        )?]),
        _ => Ok(vec![chat_message_to_responses_message(message_object)?]),
    }
}

fn chat_message_to_responses_message(message: &Map<String, Value>) -> Result<Value> {
    let mut converted = strip_chat_message_tool_fields(message);
    if let Some(content) = converted
        .as_object_mut()
        .and_then(|object| object.get_mut("content"))
    {
        *content = chat_content_to_responses_content(content)?;
    }
    Ok(converted)
}

fn chat_content_to_responses_content(content: &Value) -> Result<Value> {
    let Some(blocks) = content.as_array() else {
        return Ok(content.clone());
    };

    let mut converted = Vec::with_capacity(blocks.len());
    for block in blocks {
        let Some(kind) = block.get("type").and_then(Value::as_str) else {
            converted.push(block.clone());
            continue;
        };
        match kind {
            "text" | "input_text" => {
                converted.push(json!({
                    "type": "input_text",
                    "text": block.get("text").and_then(Value::as_str).unwrap_or_default()
                }));
            }
            "image_url" => {
                let image_url = block
                    .get("image_url")
                    .and_then(Value::as_object)
                    .and_then(|image_url| image_url.get("url"))
                    .and_then(Value::as_str)
                    .filter(|url| !url.trim().is_empty())
                    .ok_or_else(|| anyhow!("image_url.url is missing for Responses input"))?;
                let image_url = normalize_responses_image_url(image_url)?;
                converted.push(json!({
                    "type": "input_image",
                    "image_url": image_url
                }));
            }
            "image" => {
                converted.push(json!({
                    "type": "input_image",
                    "image_url": anthropic_image_block_to_responses_image_url(block)?
                }));
            }
            _ => converted.push(block.clone()),
        }
    }

    Ok(Value::Array(converted))
}

fn normalize_responses_image_url(image_url: &str) -> Result<String> {
    let trimmed = image_url.trim();
    if trimmed.starts_with("data:image/") {
        return normalize_image_data_url(trimmed, "image_url.url");
    }
    Ok(trimmed.to_string())
}

fn compact_base64_responses_image_data(data: &str, field_name: &str) -> Result<String> {
    let compact: String = data.chars().filter(|ch| !ch.is_whitespace()).collect();
    if compact.is_empty() {
        return Err(anyhow!("{field_name} must be a non-empty base64 string"));
    }
    if !compact
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '/' | '=' | '-' | '_'))
    {
        return Err(anyhow!("{field_name} contains invalid base64 characters"));
    }
    Ok(compact)
}

fn anthropic_image_block_to_responses_image_url(block: &Value) -> Result<String> {
    let source = block
        .get("source")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("Anthropic image source is missing for Responses input"))?;
    match source.get("type").and_then(Value::as_str) {
        Some("base64") | None => {}
        Some(other) => {
            return Err(anyhow!(
                "Anthropic image source.type must be base64 for Responses input, got {other}"
            ));
        }
    }
    let media_type = source
        .get("media_type")
        .and_then(Value::as_str)
        .unwrap_or("image/png");
    if !media_type.starts_with("image/") {
        return Err(anyhow!("Anthropic image media_type must be an image type"));
    }
    let data = source
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("Anthropic image source.data is missing for Responses input"))?;
    normalize_image_data_url(
        &format!(
            "data:{media_type};base64,{}",
            compact_base64_responses_image_data(data, "Anthropic image source.data")?
        ),
        "Anthropic image source.data",
    )
}

fn chat_assistant_message_to_responses_input_items(
    message: &serde_json::Map<String, Value>,
    ns_map: &[NamespaceMetadata],
) -> Result<Vec<Value>> {
    let mut items = Vec::new();
    let tool_calls = message.get("tool_calls").and_then(Value::as_array);
    let legacy_function_call = message.get("function_call");

    if tool_calls.is_none() && legacy_function_call.is_none() {
        return Ok(vec![strip_chat_message_tool_fields(message)]);
    }

    let assistant_message = strip_chat_message_tool_fields(message);
    if !chat_message_content_is_empty(assistant_message.get("content")) {
        items.push(assistant_message);
    }

    if let Some(tool_calls) = tool_calls {
        for tool_call in tool_calls {
            items.push(chat_tool_call_to_responses_input_item(tool_call, ns_map));
        }
    }

    if let Some(function_call) = legacy_function_call {
        items.push(chat_tool_call_to_responses_input_item(
            function_call,
            ns_map,
        ));
    }

    Ok(items)
}

fn chat_tool_message_to_responses_input_item(
    message: &serde_json::Map<String, Value>,
) -> Result<Value> {
    let call_id = message
        .get("tool_call_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("tool message is missing tool_call_id"))?;

    Ok(json!({
        "type": "function_call_output",
        "call_id": call_id,
        "output": message
            .get("content")
            .map(value_to_json_string)
            .unwrap_or_default()
    }))
}

fn chat_tool_call_to_responses_input_item(
    tool_call: &Value,
    ns_map: &[NamespaceMetadata],
) -> Value {
    let Some(tool_call_object) = tool_call.as_object() else {
        return tool_call.clone();
    };

    let function = tool_call_object.get("function").and_then(Value::as_object);
    let raw_name = function
        .and_then(|f| f.get("name"))
        .or_else(|| tool_call_object.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("");

    let call_id = tool_call_object
        .get("id")
        .cloned()
        .or_else(|| tool_call_object.get("call_id").cloned())
        .unwrap_or(Value::Null);
    let arguments = function
        .and_then(|f| f.get("arguments"))
        .or_else(|| tool_call_object.get("arguments"))
        .map(value_to_json_string)
        .unwrap_or_default();

    if let Some((namespace, stripped)) = match_namespace_prefix(raw_name, ns_map) {
        if namespace.is_core {
            return json!({
                "type": "function_call",
                "call_id": call_id,
                "name": raw_name,
                "arguments": arguments
            });
        }
        json!({
            "type": "function_call",
            "call_id": call_id,
            "name": stripped,
            "namespace": namespace.prefix.as_str(),
            "arguments": arguments
        })
    } else {
        json!({
            "type": "function_call",
            "call_id": call_id,
            "name": raw_name,
            "arguments": arguments
        })
    }
}

fn strip_chat_message_tool_fields(message: &serde_json::Map<String, Value>) -> Value {
    let mut stripped = message.clone();
    stripped.remove("tool_calls");
    stripped.remove("tool_call_id");
    stripped.remove("function_call");
    Value::Object(stripped)
}

fn chat_message_content_is_empty(content: Option<&Value>) -> bool {
    match content {
        None | Some(Value::Null) => true,
        Some(Value::String(text)) => text.trim().is_empty(),
        Some(Value::Array(items)) => items.is_empty(),
        _ => false,
    }
}

fn value_to_json_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

fn chat_tool_to_responses_function(tool: &Value) -> Option<Value> {
    let tool_object = tool.as_object()?;
    if tool_object.get("type").and_then(Value::as_str) != Some("function") {
        return None;
    }
    let function = tool_object.get("function").and_then(Value::as_object)?;
    Some(json!({
        "type": "function",
        "name": function.get("name").cloned().unwrap_or(Value::Null),
        "description": function.get("description").cloned().unwrap_or(Value::Null),
        "parameters": function.get("parameters").cloned().unwrap_or(json!({})),
        "strict": function.get("strict").cloned().unwrap_or(Value::Null)
    }))
}

/// Parse `_tool_namespaces` JSON into a sorted namespace metadata list with
/// longest-prefix-first ordering so ambiguous matches (e.g. `data_plat_mcp`
/// vs `data_plat`) resolve correctly. Supports both the legacy
/// `{prefix: description}` form and the richer
/// `{prefix: {description, server_id, is_core}}` object form.
fn parse_namespace_map(tool_namespaces: Option<&Value>) -> Vec<NamespaceMetadata> {
    tool_namespaces
        .and_then(Value::as_object)
        .map(|map| {
            let mut entries: Vec<NamespaceMetadata> = map
                .iter()
                .filter_map(|(prefix, value)| {
                    if let Some(description) = value.as_str() {
                        return Some(NamespaceMetadata {
                            prefix: prefix.clone(),
                            description: description.to_string(),
                            _server_id: None,
                            is_core: false,
                        });
                    }

                    let object = value.as_object()?;
                    Some(NamespaceMetadata {
                        prefix: prefix.clone(),
                        description: object
                            .get("description")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        _server_id: object
                            .get("server_id")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        is_core: object
                            .get("is_core")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    })
                })
                .collect();
            entries.sort_by(|a, b| {
                b.prefix
                    .len()
                    .cmp(&a.prefix.len())
                    .then_with(|| a.prefix.cmp(&b.prefix))
            });
            entries
        })
        .unwrap_or_default()
}

/// Given a tool name and a namespace map (longest-prefix-first), return the
/// matching namespace metadata and stripped tool name, or `None`.
fn match_namespace_prefix<'a>(
    name: &'a str,
    ns_map: &'a [NamespaceMetadata],
) -> Option<(&'a NamespaceMetadata, &'a str)> {
    for namespace in ns_map {
        let prefix = namespace.prefix.as_str();
        let with_underscore = format!("{prefix}_");
        if name.starts_with(&with_underscore) {
            return Some((namespace, &name[with_underscore.len()..]));
        }
    }
    None
}

fn chat_tools_to_responses_tools(value: Value, tool_namespaces: Option<Value>) -> Value {
    let Some(tools) = value.as_array() else {
        return value;
    };

    // Convert all tools to Responses API function format.
    let converted: Vec<Value> = tools
        .iter()
        .map(|tool| chat_tool_to_responses_function(tool).unwrap_or_else(|| tool.clone()))
        .collect();

    let ns_map = parse_namespace_map(tool_namespaces.as_ref());

    if ns_map.is_empty() {
        return Value::Array(converted);
    }

    // Bucket each tool into its namespace (or "unmatched").
    let mut namespace_tools: std::collections::HashMap<String, Vec<Value>> =
        std::collections::HashMap::new();
    let mut unmatched: Vec<Value> = Vec::new();

    for tool in &converted {
        let name = tool.get("name").and_then(Value::as_str).unwrap_or("");
        if let Some((namespace, stripped)) = match_namespace_prefix(name, &ns_map) {
            if namespace.is_core {
                unmatched.push(tool.clone());
                continue;
            }
            let mut inner_tool = tool.clone();
            inner_tool["name"] = Value::String(stripped.to_string());
            if let Some(obj) = inner_tool.as_object_mut() {
                obj.insert("defer_loading".to_string(), Value::Bool(true));
            }
            namespace_tools
                .entry(namespace.prefix.clone())
                .or_default()
                .push(inner_tool);
        } else {
            unmatched.push(tool.clone());
        }
    }

    let mut result: Vec<Value> = Vec::new();

    // Emit namespace entries (sorted by name for determinism).
    let mut ns_keys: Vec<&String> = namespace_tools.keys().collect();
    ns_keys.sort();
    for prefix in ns_keys {
        let metadata = ns_map.iter().find(|namespace| &namespace.prefix == prefix);
        let tools_in_ns = namespace_tools.get(prefix).cloned().unwrap_or_default();
        result.push(json!({
            "type": "namespace",
            "name": prefix,
            "description": metadata.map(|namespace| namespace.description.as_str()).unwrap_or(""),
            "tools": tools_in_ns
        }));
    }

    // Append any unmatched tools (core tools) as flat functions.
    result.extend(unmatched);

    // tool_search is a tool entry (not a top-level field) required for
    // defer_loading to work and for prompt cache stability (see GPTPromptCaching.md).
    if !namespace_tools.is_empty() {
        result.push(json!({"type": "tool_search"}));
    }

    Value::Array(result)
}

fn chat_tool_choice_to_responses_tool_choice(value: Value) -> Value {
    let Some(object) = value.as_object() else {
        return value;
    };

    if object.get("type").and_then(Value::as_str) != Some("function") {
        return Value::Object(object.clone());
    }

    let Some(function) = object.get("function").and_then(Value::as_object) else {
        return Value::Object(object.clone());
    };

    json!({
        "type": "function",
        "name": function.get("name").cloned().unwrap_or(Value::Null)
    })
}

fn responses_value_to_chat_completion(
    value: Value,
    entry: &ModelEntry,
    cost_hint: Option<f64>,
) -> Value {
    let response = value.as_object().cloned().unwrap_or_default();
    response_to_chat_completion_payload(&response, entry, cost_hint)
}

fn response_to_chat_completion_payload(
    response: &serde_json::Map<String, Value>,
    entry: &ModelEntry,
    cost_hint: Option<f64>,
) -> Value {
    let (content, tool_calls, reasoning_content) = response_message_and_tool_calls(&response);
    let finish_reason = response_finish_reason(&response, &tool_calls);

    let mut message = serde_json::Map::new();
    message.insert("role".to_string(), Value::String("assistant".to_string()));
    if !reasoning_content.is_empty() {
        message.insert(
            "reasoning_content".to_string(),
            Value::String(reasoning_content),
        );
    }
    if tool_calls.is_empty() {
        message.insert("content".to_string(), Value::String(content));
    } else {
        message.insert(
            "content".to_string(),
            if content.is_empty() {
                Value::Null
            } else {
                Value::String(content)
            },
        );
        message.insert("tool_calls".to_string(), Value::Array(tool_calls));
    }

    let mut payload = json!({
        "id": response_id(&response),
        "object": "chat.completion",
        "created": response_created(&response),
        "model": entry.alias,
        "choices": [{
            "index": 0,
            "message": Value::Object(message),
            "finish_reason": finish_reason
        }]
    });

    if let Some((usage, payload_object)) = response.get("usage").zip(payload.as_object_mut()) {
        payload_object.insert("usage".to_string(), response_usage_to_chat_usage(usage));
        if let Some(extra_fields) = response.get("extra_fields") {
            payload_object.insert("extra_fields".to_string(), extra_fields.clone());
        }
        inject_usage_cost(payload_object, cost_hint);
        if let Some((tier, usage_object)) = response
            .get("service_tier")
            .and_then(Value::as_str)
            .zip(
                payload_object
                    .get_mut("usage")
                    .and_then(Value::as_object_mut),
            )
        {
            usage_object.insert("service_tier".to_string(), Value::String(tier.to_string()));
        }
    }
    payload
}

fn response_message_and_tool_calls(
    response: &serde_json::Map<String, Value>,
) -> (String, Vec<Value>, String) {
    let mut content_parts = Vec::new();
    let mut reasoning_parts = Vec::new();
    let mut tool_calls = Vec::new();

    let Some(items) = response.get("output").and_then(Value::as_array) else {
        return (String::new(), tool_calls, String::new());
    };

    for item in items {
        match item.get("type").and_then(Value::as_str) {
            Some("reasoning") => {
                if let Some(summary) = item.get("summary").and_then(Value::as_array) {
                    for part in summary {
                        if let Some(text) = part.get("text").and_then(Value::as_str) {
                            if !text.is_empty() {
                                reasoning_parts.push(text.to_string());
                            }
                        }
                    }
                }
            }
            Some("message") => {
                if let Some(content) = item.get("content").and_then(Value::as_array) {
                    for part in content {
                        match part.get("type").and_then(Value::as_str) {
                            Some("output_text") | Some("text") | Some("input_text") => {
                                if let Some(text) = part.get("text").and_then(Value::as_str) {
                                    if !text.is_empty() {
                                        content_parts.push(text.to_string());
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
            Some("function_call") => {
                let call_id = item
                    .get("call_id")
                    .cloned()
                    .or(item.get("id").cloned())
                    .unwrap_or(Value::String("call_0".to_string()));
                // When the function was inside a namespace, reconstruct the full
                // prefixed name the middleware expects (e.g., namespace="glean",
                // name="search" → "glean_search").
                let raw_name = item.get("name").and_then(Value::as_str).unwrap_or("");
                let namespace = item.get("namespace").and_then(Value::as_str);
                let full_name = match namespace {
                    Some(ns) if !ns.is_empty() => format!("{ns}_{raw_name}"),
                    _ => raw_name.to_string(),
                };
                tool_calls.push(json!({
                    "id": call_id,
                    "type": "function",
                    "function": {
                        "name": full_name,
                        "arguments": match item.get("arguments") {
                            Some(Value::String(text)) => Value::String(text.clone()),
                            Some(other) => Value::String(other.to_string()),
                            None => Value::String(String::new()),
                        }
                    }
                }));
            }
            _ => {}
        }
    }

    (content_parts.join(""), tool_calls, reasoning_parts.join(""))
}

fn response_finish_reason(
    response: &serde_json::Map<String, Value>,
    tool_calls: &[Value],
) -> String {
    if !tool_calls.is_empty() {
        return "tool_calls".to_string();
    }

    if let Some(incomplete_details) = response
        .get("incomplete_details")
        .and_then(Value::as_object)
    {
        if let Some(reason) = incomplete_details.get("reason").and_then(Value::as_str) {
            return match reason {
                "max_output_tokens" | "max_tokens" | "length" => "length".to_string(),
                "tool_calls" => "tool_calls".to_string(),
                "content_filter" => "content_filter".to_string(),
                other => other.to_string(),
            };
        }
    }

    "stop".to_string()
}

fn response_usage_to_chat_usage(usage: &Value) -> Value {
    let usage_object = usage.as_object().cloned().unwrap_or_default();
    let input_details = usage_object
        .get("input_tokens_details")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let output_details = usage_object
        .get("output_tokens_details")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let cached_tokens = input_details
        .get("cached_tokens")
        .cloned()
        .unwrap_or(json!(0));
    let cached_read_tokens = input_details
        .get("cached_read_tokens")
        .cloned()
        .unwrap_or(json!(0));
    let cached_write_tokens = input_details
        .get("cached_write_tokens")
        .cloned()
        .unwrap_or(json!(0));
    let translated_cached_tokens = if input_details.contains_key("cached_read_tokens") {
        cached_read_tokens.clone()
    } else if input_details.contains_key("cached_write_tokens") {
        json!(0)
    } else {
        cached_tokens.clone()
    };

    json!({
        "prompt_tokens": usage_object.get("input_tokens").cloned().unwrap_or(json!(0)),
        "completion_tokens": usage_object.get("output_tokens").cloned().unwrap_or(json!(0)),
        "total_tokens": usage_object.get("total_tokens").cloned().unwrap_or(json!(0)),
        "prompt_tokens_details": {
            "cached_tokens": translated_cached_tokens,
            "cached_read_tokens": cached_read_tokens,
            "cached_write_tokens": cached_write_tokens
        },
        "completion_tokens_details": {
            "reasoning_tokens": output_details
                .get("reasoning_tokens")
                .cloned()
                .unwrap_or(json!(0))
        }
    })
}

fn response_id(response: &serde_json::Map<String, Value>) -> String {
    response
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("resp_unknown")
        .to_string()
}

fn response_created(response: &serde_json::Map<String, Value>) -> i64 {
    response
        .get("created_at")
        .and_then(Value::as_i64)
        .unwrap_or(0)
}

fn responses_stream_usage_with_cost(
    entry: &ModelEntry,
    response: &serde_json::Map<String, Value>,
    cost_hint: Option<f64>,
) -> Option<Value> {
    let mut usage = response.get("usage").map(response_usage_to_chat_usage)?;
    let computed_cost = usage
        .as_object()
        .and_then(|usage_object| compute_usage_cost(entry, usage_object));
    if let Some((cost, usage_object)) = cost_hint.or(computed_cost).zip(usage.as_object_mut()) {
        if !usage_object.contains_key("cost") {
            usage_object.insert("cost".to_string(), json!(cost));
        }
    }
    if let Some((tier, usage_object)) = response
        .get("service_tier")
        .and_then(Value::as_str)
        .zip(usage.as_object_mut())
    {
        usage_object.insert("service_tier".to_string(), Value::String(tier.to_string()));
    }
    Some(usage)
}

fn responses_stream_has_partial_output(state: &ResponsesStreamState) -> bool {
    state.response_id.is_some()
        || state.role_sent
        || state.text_emitted
        || state.reasoning_emitted
        || state.tool_calls_emitted
}

fn log_responses_usage_chunk(state: &mut ResponsesStreamState, model: &str, usage: &Value) {
    state.usage_chunk_count += 1;
    info!(
        model,
        response_id = state.response_id.as_deref().unwrap_or("resp_unknown"),
        usage_chunk_count = state.usage_chunk_count,
        usage = %summarize_usage_for_log(usage),
        "Observed translated usage payload from Responses stream",
    );
}

fn note_responses_text_delta(state: &mut ResponsesStreamState, entry: &ModelEntry, delta: &str) {
    if delta.is_empty() {
        return;
    }

    state.raw_text_delta_events += 1;
    state.raw_text_delta_chars += delta.chars().count();
    if state.raw_text_delta_events == 1 {
        info!(
            model = %entry.alias,
            response_id = state.response_id.as_deref().unwrap_or("resp_unknown"),
            delta_chars = delta.chars().count(),
            "Observed first Responses text delta",
        );
    }
}

fn note_responses_reasoning_delta(
    state: &mut ResponsesStreamState,
    entry: &ModelEntry,
    delta: &str,
) {
    if delta.is_empty() {
        return;
    }

    state.raw_reasoning_delta_events += 1;
    state.raw_reasoning_delta_chars += delta.chars().count();
    if state.raw_reasoning_delta_events == 1 {
        info!(
            model = %entry.alias,
            response_id = state.response_id.as_deref().unwrap_or("resp_unknown"),
            delta_chars = delta.chars().count(),
            "Observed first Responses reasoning delta",
        );
    }
}

fn observe_responses_lifecycle_event(
    state: &mut ResponsesStreamState,
    entry: &ModelEntry,
    event_name: &str,
    response: &serde_json::Map<String, Value>,
) {
    let id = response_id(response);
    let created = response_created(response);
    let first_seen = state.response_id.as_deref() != Some(id.as_str());
    state.response_id = Some(id.clone());
    state.created = Some(created);

    if first_seen || event_name == "response.created" {
        info!(
            model = %entry.alias,
            response_id = %id,
            created,
            event = event_name,
            "Observed Responses lifecycle event",
        );
    }
}

fn log_unmapped_responses_event_once(
    state: &mut ResponsesStreamState,
    entry: &ModelEntry,
    event_name: &str,
) {
    if event_name.is_empty() || !state.ignored_event_names.insert(event_name.to_string()) {
        return;
    }

    info!(
        model = %entry.alias,
        response_id = state.response_id.as_deref().unwrap_or("resp_unknown"),
        event = event_name,
        event_count = state.event_count,
        "Ignoring unmapped Responses SSE event",
    );
}

fn log_responses_terminal_translation(
    state: &mut ResponsesStreamState,
    entry: &ModelEntry,
    event_name: &str,
    response: &serde_json::Map<String, Value>,
    cost_hint: Option<f64>,
) {
    let id = response_id(response);
    let (content, tool_calls, reasoning_content) = response_message_and_tool_calls(response);
    let finish_reason = response_finish_reason(response, &tool_calls);
    let usage = responses_stream_usage_with_cost(entry, response, cost_hint);
    let served_service_tier = response
        .get("service_tier")
        .and_then(Value::as_str)
        .unwrap_or("-");
    let incomplete_reason = response
        .get("incomplete_details")
        .and_then(Value::as_object)
        .and_then(|details| details.get("reason"))
        .and_then(Value::as_str)
        .unwrap_or("-");

    state.response_id = Some(id.clone());
    state.created = Some(response_created(response));
    state.terminal_event_name = Some(event_name.to_string());
    state.final_finish_reason = Some(finish_reason.clone());
    state.observed_tool_call_count = tool_calls.len();
    state.synthesized_reasoning_delta = !state.reasoning_emitted && !reasoning_content.is_empty();
    state.synthesized_text_delta = !state.text_emitted && !content.is_empty();
    state.synthesized_tool_call_delta = !state.tool_calls_emitted && !tool_calls.is_empty();

    if event_name == "response.incomplete" {
        warn!(
            model = %entry.alias,
            response_id = %id,
            event = event_name,
            finish_reason = %finish_reason,
            incomplete_reason,
            content_chars = content.chars().count(),
            reasoning_chars = reasoning_content.chars().count(),
            tool_call_count = tool_calls.len(),
            raw_text_delta_events = state.raw_text_delta_events,
            raw_text_delta_chars = state.raw_text_delta_chars,
            raw_reasoning_delta_events = state.raw_reasoning_delta_events,
            raw_reasoning_delta_chars = state.raw_reasoning_delta_chars,
            synthesized_text_delta = state.synthesized_text_delta,
            synthesized_reasoning_delta = state.synthesized_reasoning_delta,
            synthesized_tool_call_delta = state.synthesized_tool_call_delta,
            served_service_tier,
            usage = %usage
                .as_ref()
                .map(summarize_usage_for_log)
                .unwrap_or_else(|| "none".to_string()),
            "Translating Responses incomplete terminal event",
        );
    } else {
        info!(
            model = %entry.alias,
            response_id = %id,
            event = event_name,
            finish_reason = %finish_reason,
            content_chars = content.chars().count(),
            reasoning_chars = reasoning_content.chars().count(),
            tool_call_count = tool_calls.len(),
            raw_text_delta_events = state.raw_text_delta_events,
            raw_text_delta_chars = state.raw_text_delta_chars,
            raw_reasoning_delta_events = state.raw_reasoning_delta_events,
            raw_reasoning_delta_chars = state.raw_reasoning_delta_chars,
            synthesized_text_delta = state.synthesized_text_delta,
            synthesized_reasoning_delta = state.synthesized_reasoning_delta,
            synthesized_tool_call_delta = state.synthesized_tool_call_delta,
            served_service_tier,
            usage = %usage
                .as_ref()
                .map(summarize_usage_for_log)
                .unwrap_or_else(|| "none".to_string()),
            "Translating Responses completed terminal event",
        );
    }
}

fn note_thinking_phase_ended(state: &mut ResponsesStreamState) {
    if state.thinking_ended_at_ms.is_none() {
        state.thinking_ended_at_ms = Some(current_time_millis());
    }
}

fn response_reasoning_marker_chunks(
    state: &mut ResponsesStreamState,
    entry: &ModelEntry,
) -> Vec<Bytes> {
    if !state.reasoning_indicator_enabled || state.reasoning_marker_sent {
        return Vec::new();
    }
    state.reasoning_marker_sent = true;
    state.reasoning_started_at_ms = Some(current_time_millis());
    let id = state
        .response_id
        .clone()
        .unwrap_or_else(|| "resp_unknown".to_string());
    let created = state.created.unwrap_or_default();
    let mut chunks = Vec::new();
    if !state.role_sent {
        chunks.push(chat_completion_stream_chunk_bytes(
            &id,
            created,
            &entry.alias,
            json!({"role": "assistant"}),
            None,
            None,
            None,
        ));
        state.role_sent = true;
    }
    chunks.push(chat_completion_stream_chunk_bytes(
        &id,
        created,
        &entry.alias,
        json!({"reasoning_status": "started"}),
        None,
        None,
        None,
    ));
    chunks
}

fn response_output_text_delta_chunks(
    state: &mut ResponsesStreamState,
    entry: &ModelEntry,
    delta: &str,
) -> Vec<Bytes> {
    if delta.is_empty() {
        return Vec::new();
    }
    note_thinking_phase_ended(state);

    let id = state
        .response_id
        .clone()
        .unwrap_or_else(|| "resp_unknown".to_string());
    let created = state.created.unwrap_or_default();
    let mut chunks = Vec::new();
    if !state.role_sent {
        chunks.push(chat_completion_stream_chunk_bytes(
            &id,
            created,
            &entry.alias,
            json!({"role": "assistant"}),
            None,
            None,
            None,
        ));
        state.role_sent = true;
    }
    chunks.push(chat_completion_stream_chunk_bytes(
        &id,
        created,
        &entry.alias,
        json!({"content": delta}),
        None,
        None,
        None,
    ));
    state.text_emitted = true;
    chunks
}

fn response_reasoning_text_delta_chunks(
    state: &mut ResponsesStreamState,
    entry: &ModelEntry,
    delta: &str,
) -> Vec<Bytes> {
    if delta.is_empty() {
        return Vec::new();
    }
    note_thinking_phase_ended(state);

    let id = state
        .response_id
        .clone()
        .unwrap_or_else(|| "resp_unknown".to_string());
    let created = state.created.unwrap_or_default();
    let mut chunks = Vec::new();
    if !state.role_sent {
        chunks.push(chat_completion_stream_chunk_bytes(
            &id,
            created,
            &entry.alias,
            json!({"role": "assistant"}),
            None,
            None,
            None,
        ));
        state.role_sent = true;
    }
    // The upstream stream is silent while the model reasons; the summary text
    // only bursts out afterwards. Attach the bridge-measured silent interval
    // to the first reasoning chunk so the client can back-date the block.
    let reasoning_delta = if !state.reasoning_emitted {
        match state.reasoning_started_at_ms {
            Some(started_at_ms) => {
                let thinking_ms = state
                    .thinking_ended_at_ms
                    .unwrap_or_else(current_time_millis)
                    .saturating_sub(started_at_ms);
                json!({"reasoning_content": delta, "reasoning_thinking_ms": thinking_ms})
            }
            None => json!({"reasoning_content": delta}),
        }
    } else {
        json!({"reasoning_content": delta})
    };
    chunks.push(chat_completion_stream_chunk_bytes(
        &id,
        created,
        &entry.alias,
        reasoning_delta,
        None,
        None,
        None,
    ));
    state.reasoning_emitted = true;
    chunks
}

fn response_output_tool_call_delta_chunks(
    state: &mut ResponsesStreamState,
    entry: &ModelEntry,
    tool_calls: &[Value],
) -> Vec<Bytes> {
    if tool_calls.is_empty() {
        return Vec::new();
    }
    note_thinking_phase_ended(state);

    let id = state
        .response_id
        .clone()
        .unwrap_or_else(|| "resp_unknown".to_string());
    let created = state.created.unwrap_or_default();
    let mut chunks = Vec::new();
    if !state.role_sent {
        chunks.push(chat_completion_stream_chunk_bytes(
            &id,
            created,
            &entry.alias,
            json!({"role": "assistant"}),
            None,
            None,
            None,
        ));
        state.role_sent = true;
    }

    let delta_tool_calls: Vec<Value> = tool_calls
        .iter()
        .enumerate()
        .map(|(index, tool_call)| {
            let tool_call_object = tool_call.as_object().cloned().unwrap_or_default();
            let function = tool_call_object
                .get("function")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();

            json!({
                "index": tool_call_object
                    .get("index")
                    .cloned()
                    .unwrap_or_else(|| json!(index)),
                "id": tool_call_object
                    .get("id")
                    .cloned()
                    .unwrap_or_else(|| Value::String(format!("call_{index}"))),
                "type": tool_call_object
                    .get("type")
                    .cloned()
                    .unwrap_or_else(|| Value::String("function".to_string())),
                "function": {
                    "name": function.get("name").cloned().unwrap_or(Value::Null),
                    "arguments": match function.get("arguments") {
                        Some(Value::String(text)) => Value::String(text.clone()),
                        Some(other) => Value::String(other.to_string()),
                        None => Value::String(String::new()),
                    }
                }
            })
        })
        .collect();
    chunks.push(chat_completion_stream_chunk_bytes(
        &id,
        created,
        &entry.alias,
        json!({"tool_calls": delta_tool_calls}),
        None,
        None,
        None,
    ));
    state.tool_calls_emitted = true;
    chunks
}

fn response_completed_chunks(
    state: &mut ResponsesStreamState,
    entry: &ModelEntry,
    response: &serde_json::Map<String, Value>,
    cost_hint: Option<f64>,
) -> Vec<Bytes> {
    let id = response_id(response);
    let created = response_created(response);
    state.response_id = Some(id.clone());
    state.created = Some(created);
    let (content, tool_calls, reasoning_content) = response_message_and_tool_calls(response);
    let finish_reason = response_finish_reason(response, &tool_calls);
    state.final_finish_reason = Some(finish_reason.clone());
    state.final_stop_reason = None;
    let usage = responses_stream_usage_with_cost(entry, response, cost_hint);
    let mut chunks = Vec::new();
    if !state.reasoning_emitted && !reasoning_content.is_empty() {
        info!(
            model = %entry.alias,
            response_id = %id,
            reasoning_len = reasoning_content.len(),
            "Synthesizing missing Responses reasoning delta from response.completed",
        );
        chunks.extend(response_reasoning_text_delta_chunks(
            state,
            entry,
            &reasoning_content,
        ));
    }
    if !state.text_emitted && !content.is_empty() {
        info!(
            model = %entry.alias,
            response_id = %id,
            text_len = content.len(),
            "Synthesizing missing Responses text delta from response.completed",
        );
        chunks.extend(response_output_text_delta_chunks(state, entry, &content));
    }
    if !state.tool_calls_emitted && !tool_calls.is_empty() {
        info!(
            model = %entry.alias,
            response_id = %id,
            tool_call_count = tool_calls.len(),
            "Synthesizing missing Responses tool call delta from response.completed",
        );
        chunks.extend(response_output_tool_call_delta_chunks(
            state,
            entry,
            &tool_calls,
        ));
    }
    chunks.push(chat_completion_stream_chunk_bytes(
        &id,
        created,
        &entry.alias,
        json!({}),
        Some(finish_reason.as_str()),
        None,
        usage.as_ref(),
    ));
    state.terminal_chunk_sent = true;
    if !state.done_sent {
        chunks.push(sse_done_bytes());
        state.done_sent = true;
    }
    chunks
}

fn response_incomplete_eof_chunks(
    state: &mut ResponsesStreamState,
    entry: &ModelEntry,
    stop_reason: &str,
) -> Vec<Bytes> {
    if state.terminal_chunk_sent || !responses_stream_has_partial_output(state) {
        return Vec::new();
    }

    let id = state
        .response_id
        .clone()
        .unwrap_or_else(|| "resp_unknown".to_string());
    let created = state.created.unwrap_or_default();
    state.terminal_event_name = Some("synthetic_eof".to_string());
    state.final_finish_reason = None;
    state.final_stop_reason = Some(stop_reason.to_string());
    warn!(
        model = %entry.alias,
        response_id = %id,
        stop_reason,
        last_event = state.last_event_name.as_deref().unwrap_or("-"),
        event_count = state.event_count,
        raw_text_delta_events = state.raw_text_delta_events,
        raw_text_delta_chars = state.raw_text_delta_chars,
        raw_reasoning_delta_events = state.raw_reasoning_delta_events,
        raw_reasoning_delta_chars = state.raw_reasoning_delta_chars,
        synthesized_text_delta = state.synthesized_text_delta,
        synthesized_reasoning_delta = state.synthesized_reasoning_delta,
        synthesized_tool_call_delta = state.synthesized_tool_call_delta,
        saw_done_sentinel = state.saw_done_sentinel,
        usage_chunk_count = state.usage_chunk_count,
        "Emitting synthetic terminal chunk for incomplete Responses stream",
    );
    let mut chunks = vec![chat_completion_stream_chunk_bytes(
        &id,
        created,
        &entry.alias,
        json!({}),
        None,
        Some(stop_reason),
        None,
    )];
    state.terminal_chunk_sent = true;
    if !state.done_sent {
        chunks.push(sse_done_bytes());
        state.done_sent = true;
    }
    chunks
}

fn extract_responses_event_error_message(payload: &Value, fallback: &str) -> String {
    for candidate in [
        payload.pointer("/error/message"),
        payload.pointer("/response/error/message"),
        payload.pointer("/response/incomplete_details/reason"),
        payload.get("message"),
    ] {
        if let Some(message) = candidate.and_then(Value::as_str) {
            let trimmed = message.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }

    fallback.to_string()
}

fn transform_bifrost_responses_event(
    event_name: &str,
    payload: &Value,
    entry: &ModelEntry,
    cost_hint: Option<f64>,
    state: &mut ResponsesStreamState,
) -> Result<Vec<Bytes>> {
    state.event_count += 1;
    if !event_name.is_empty() {
        state.last_event_name = Some(event_name.to_string());
    }

    match event_name {
        "response.created" | "response.in_progress" => {
            if let Some(response) = payload.get("response").and_then(Value::as_object) {
                observe_responses_lifecycle_event(state, entry, event_name, response);
            }
            Ok(response_reasoning_marker_chunks(state, entry))
        }
        "response.output_text.delta" => {
            let delta = payload
                .get("delta")
                .and_then(Value::as_str)
                .unwrap_or_default();
            note_responses_text_delta(state, entry, delta);
            Ok(response_output_text_delta_chunks(state, entry, delta))
        }
        "response.reasoning_summary_text.delta" => {
            let delta = payload
                .get("delta")
                .and_then(Value::as_str)
                .unwrap_or_default();
            note_responses_reasoning_delta(state, entry, delta);
            Ok(response_reasoning_text_delta_chunks(state, entry, delta))
        }
        "response.reasoning_summary_text.done" => Ok(Vec::new()),
        "response.completed" => {
            let Some(response) = payload.get("response").and_then(Value::as_object) else {
                return Ok(Vec::new());
            };
            log_responses_terminal_translation(state, entry, event_name, response, cost_hint);
            state.terminal_event_name = Some(event_name.to_string());
            Ok(response_completed_chunks(state, entry, response, cost_hint))
        }
        "response.incomplete" => {
            if let Some(response) = payload.get("response").and_then(Value::as_object) {
                log_responses_terminal_translation(state, entry, event_name, response, cost_hint);
                state.terminal_event_name = Some(event_name.to_string());
                return Ok(response_completed_chunks(state, entry, response, cost_hint));
            }

            state.terminal_event_name = Some(event_name.to_string());
            state.final_stop_reason = Some("incomplete_stream".to_string());
            warn!(
                model = %entry.alias,
                response_id = state.response_id.as_deref().unwrap_or("resp_unknown"),
                event = event_name,
                "Responses stream reported incomplete terminal event without embedded response payload",
            );
            Ok(response_incomplete_eof_chunks(
                state,
                entry,
                "incomplete_stream",
            ))
        }
        "response.failed" | "response.error" | "error" => {
            let message = extract_responses_event_error_message(
                payload,
                "LLM proxy Responses stream failed before completion",
            );
            state.terminal_event_name = Some(event_name.to_string());
            state.final_stop_reason = Some("error".to_string());
            warn!(
                model = %entry.alias,
                response_id = state.response_id.as_deref().unwrap_or("resp_unknown"),
                event = event_name,
                error = %message,
                event_count = state.event_count,
                last_event = state.last_event_name.as_deref().unwrap_or("-"),
                "Responses stream reported terminal error event",
            );
            Err(anyhow!("{message}"))
        }
        _ => {
            log_unmapped_responses_event_once(state, entry, event_name);
            Ok(Vec::new())
        }
    }
}

fn transform_bifrost_responses_sse_line(
    line: &str,
    current_event_name: &mut Option<String>,
    entry: &ModelEntry,
    cost_hint: Option<f64>,
    state: &mut ResponsesStreamState,
) -> Result<Vec<Bytes>> {
    if line.is_empty() {
        return Ok(Vec::new());
    }

    if let Some(event_name) = line.strip_prefix("event: ") {
        *current_event_name = Some(event_name.to_string());
        return Ok(Vec::new());
    }

    let Some(payload_text) = line.strip_prefix("data: ") else {
        return Ok(Vec::new());
    };

    if payload_text.trim() == "[DONE]" {
        state.saw_done_sentinel = true;
        if !state.terminal_chunk_sent {
            let outputs = response_incomplete_eof_chunks(state, entry, "incomplete_stream");
            if !outputs.is_empty() {
                return Ok(outputs);
            }
        }
        if state.done_sent {
            return Ok(Vec::new());
        }
        state.done_sent = true;
        return Ok(vec![sse_done_bytes()]);
    }

    if current_event_name.as_deref().unwrap_or_default().is_empty() {
        warn!(
            model = %entry.alias,
            response_id = state.response_id.as_deref().unwrap_or("resp_unknown"),
            data_chars = payload_text.chars().count(),
            "Responses SSE data line arrived without a preceding event name",
        );
    }

    let value: Value = serde_json::from_str(payload_text)
        .map_err(|error| anyhow!("Invalid Bifrost responses SSE JSON: {error}"))?;
    let outputs = transform_bifrost_responses_event(
        current_event_name.as_deref().unwrap_or_default(),
        &value,
        entry,
        cost_hint,
        state,
    )?;
    *current_event_name = None;
    Ok(outputs)
}

fn transform_converse_sse_line(
    line: &str,
    translation_state: &mut StreamTranslationState,
) -> Result<Vec<Bytes>> {
    if line.is_empty() {
        return Ok(vec![Bytes::from_static(b"\n")]);
    }
    if !line.starts_with("data: ") {
        return Ok(Vec::new());
    }

    let payload = line.trim_start_matches("data: ").trim();
    if payload.is_empty() || payload == "[DONE]" {
        return Ok(Vec::new());
    }

    let raw_chunk: Value = serde_json::from_str(payload)
        .map_err(|error| anyhow!("Invalid Converse SSE JSON: {error}"))?;
    Ok(
        translate_bedrock_stream_chunk(&raw_chunk, translation_state)
            .into_iter()
            .map(|(event_name, event_payload)| sse_bytes(&event_name, &event_payload))
            .collect(),
    )
}

fn chat_completion_stream_chunk_bytes(
    id: &str,
    created: i64,
    model: &str,
    delta: Value,
    finish_reason: Option<&str>,
    stop_reason: Option<&str>,
    usage: Option<&Value>,
) -> Bytes {
    let mut object = json!({"id": id, "object": "chat.completion.chunk", "created": created, "model": model, "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}]});
    if let Some(stop_reason) = stop_reason {
        object["choices"][0]["stop_reason"] = Value::String(stop_reason.to_string());
        object
            .as_object_mut()
            .expect("chat completion chunk must be a JSON object")
            .insert(
                "stop_reason".to_string(),
                Value::String(stop_reason.to_string()),
            );
    }
    if let Some(usage) = usage {
        object
            .as_object_mut()
            .expect("chat completion stream chunk must be a JSON object")
            .insert("usage".to_string(), usage.clone());
    }
    sse_data_bytes(&object)
}

fn sse_data_bytes(payload: &Value) -> Bytes {
    Bytes::from(format!(
        "data: {}\n\n",
        serde_json::to_string(payload).expect("serializing serde_json::Value should be infallible")
    ))
}

fn sse_done_bytes() -> Bytes {
    Bytes::from_static(b"data: [DONE]\n\n")
}

fn sse_bytes(event_name: &str, payload: &Value) -> Bytes {
    Bytes::from(format!(
        "event: {event_name}\ndata: {}\n\n",
        serde_json::to_string(payload).expect("serializing serde_json::Value should be infallible")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::http::header::CONTENT_TYPE;
    use axum::routing::any;
    use axum::Router;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    use tempfile::tempdir;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::oneshot;

    const JPEG_BASE64: &str = "/9j/2Q==";
    const PNG_BASE64: &str = "iVBORw0KGgo=";

    #[test]
    fn estimate_responses_context_tokens_prices_data_urls_at_flat_allowance() {
        let blob = format!("data:image/png;base64,{}", "A".repeat(1_144_502));
        let payload = json!({
            "instructions": "i".repeat(8_000),
            "input": [{"role": "user", "content": [
                {"type": "input_text", "text": "what is in this screenshot?"},
                {"type": "input_image", "image_url": blob}
            ]}]
        });
        let estimate = estimate_responses_context_tokens(&payload).unwrap();
        // instructions (~2k tokens) + structure + the flat image allowance —
        // NOT ~288k from pricing the 1.14M-char blob at chars/4.
        assert!(estimate >= 3_000, "estimate={estimate}");
        assert!(estimate < 5_000, "estimate={estimate}");

        // A second image adds one more flat allowance, not its byte size —
        // history images resent every round stay flat.
        let mut two_images = payload.clone();
        two_images["input"][0]["content"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "type": "input_image",
                "image_url": format!("data:image/jpeg;base64,{}", "B".repeat(900_000))
            }));
        let two_image_estimate = estimate_responses_context_tokens(&two_images).unwrap();
        let delta = two_image_estimate - estimate;
        assert!((1_500..=1_700).contains(&delta), "delta={delta}");

        // https-referenced images keep ordinary chars/4 string pricing.
        let mut linked = payload.clone();
        linked["input"][0]["content"][1] =
            json!({"type": "input_image", "image_url": "https://example.com/x.png"});
        let linked_estimate = estimate_responses_context_tokens(&linked).unwrap();
        assert!(linked_estimate < 2_500, "estimate={linked_estimate}");

        // A short data URL is never inflated above its real length.
        let mut tiny = payload.clone();
        tiny["input"][0]["content"][1] = json!({
            "type": "input_image",
            "image_url": format!("data:image/png;base64,{PNG_BASE64}")
        });
        let tiny_estimate = estimate_responses_context_tokens(&tiny).unwrap();
        assert!(tiny_estimate < 2_500, "estimate={tiny_estimate}");

        // Prose that merely quotes "data:" mid-string keeps chars/4 pricing.
        let mut quoted = payload.clone();
        quoted["input"][0]["content"][1] = json!({
            "type": "input_text",
            "text": format!("see data:image/png;base64,{} for details", "C".repeat(50_000))
        });
        let quoted_estimate = estimate_responses_context_tokens(&quoted).unwrap();
        assert!(quoted_estimate > 14_000, "estimate={quoted_estimate}");
    }

    #[test]
    fn estimate_responses_context_tokens_excludes_deferred_tools() {
        let eager_tool = json!({
            "type": "function",
            "name": "core_tool",
            "description": "d".repeat(400),
            "parameters": {"type": "object"}
        });
        let deferred_tool = json!({
            "type": "function",
            "name": "big_tool",
            "description": "x".repeat(4_000),
            "parameters": {"type": "object"},
            "defer_loading": true
        });
        let namespace = json!({
            "type": "namespace",
            "name": "glean",
            "description": "Search tools",
            "tools": [deferred_tool.clone(), deferred_tool.clone()]
        });
        let payload = json!({
            "instructions": "i".repeat(8_000),
            "input": [{"role": "user", "content": "hello there"}],
            "tools": [eager_tool, namespace.clone(), {"type": "tool_search"}]
        });

        let base_estimate = estimate_responses_context_tokens(&payload).unwrap();
        // instructions (8000) dominate; deferred schemas (2×~4000 chars) must
        // not be counted.
        assert!(base_estimate >= 2_000, "estimate={base_estimate}");
        assert!(base_estimate < 3_000, "estimate={base_estimate}");

        // Adding 100 more deferred children barely moves the estimate.
        let mut bloated = payload.clone();
        let tools = bloated["tools"].as_array_mut().unwrap();
        let mut big_namespace = namespace;
        {
            let children = big_namespace["tools"].as_array_mut().unwrap();
            for _ in 0..100 {
                children.push(deferred_tool.clone());
            }
        }
        tools.push(big_namespace);
        let bloated_estimate = estimate_responses_context_tokens(&bloated).unwrap();
        assert!(
            bloated_estimate - base_estimate < 50,
            "base={base_estimate} bloated={bloated_estimate}"
        );

        assert!(estimate_responses_context_tokens(&json!({})).is_none());
    }

    #[test]
    fn context_tokens_from_billed_usage_handles_provider_shapes() {
        // OpenAI/Bifrost-translated shape: prompt_tokens already inclusive.
        assert_eq!(
            context_tokens_from_billed_usage(
                &json!({"prompt_tokens": 210_175, "prompt_tokens_details": {"cached_write_tokens": 210_173}})
            ),
            Some(210_175)
        );
        // Anthropic-native shape: input excludes cache traffic.
        assert_eq!(
            context_tokens_from_billed_usage(&json!({
                "input_tokens": 2,
                "cache_creation_input_tokens": 210_173,
                "cache_read_input_tokens": 0
            })),
            Some(210_175)
        );
        assert_eq!(context_tokens_from_billed_usage(&json!({})), None);
        assert_eq!(
            context_tokens_from_billed_usage(&json!({"prompt_tokens": 0})),
            None
        );
    }

    #[test]
    fn summarize_usage_for_log_reports_anthropic_cache_fields() {
        let summary = summarize_usage_for_log(&json!({
            "prompt_tokens": 2,
            "completion_tokens": 693,
            "cache_creation_input_tokens": 210_173,
            "cache_read_input_tokens": 41
        }));
        assert!(summary.contains("cache_write_tokens=210173"), "{summary}");
        assert!(summary.contains("cache_read_tokens=41"), "{summary}");

        let summary = summarize_usage_for_log(&json!({
            "prompt_tokens": 100,
            "prompt_tokens_details": {
                "cache_creation_input_tokens": 55,
                "cache_read_input_tokens": 45
            }
        }));
        assert!(summary.contains("cache_write_tokens=55"), "{summary}");
        assert!(summary.contains("cache_read_tokens=45"), "{summary}");
    }

    struct TestServer {
        base_url: String,
        shutdown: Option<oneshot::Sender<()>>,
        handle: Option<tokio::task::JoinHandle<()>>,
    }

    impl Drop for TestServer {
        fn drop(&mut self) {
            if let Some(shutdown) = self.shutdown.take() {
                let _ = shutdown.send(());
            }
            if let Some(handle) = self.handle.as_ref() {
                if !handle.is_finished() {
                    handle.abort();
                }
            }
        }
    }

    impl TestServer {
        async fn shutdown(mut self) {
            if let Some(shutdown) = self.shutdown.take() {
                let _ = shutdown.send(());
            }
            let handle = self
                .handle
                .take()
                .expect("test server handle should be present");
            let _ = handle.await;
        }
    }

    fn test_catalog() -> Catalog {
        let entries = vec![
            ModelEntry {
                alias: "GPT-4.1".to_string(),
                base_model: "gpt-4.1".to_string(),
                provider_model: "gpt-4.1".to_string(),
                bifrost_model: "openai/gpt-4.1".to_string(),
                provider_kind: ProviderKind::OpenAI,
                uses_responses_api: false,
                max_output_tokens: Some(32768),
                prompt_cache_retention: Some("24h".to_string()),
                claude_prompt_cache_ttl: None,
                tool_slimming: false,
            },
            ModelEntry {
                alias: "GPT-5.5".to_string(),
                base_model: "gpt-5.5".to_string(),
                provider_model: "gpt-5.5".to_string(),
                bifrost_model: "openai/gpt-5.5".to_string(),
                provider_kind: ProviderKind::OpenAI,
                uses_responses_api: true,
                max_output_tokens: Some(128000),
                prompt_cache_retention: Some("24h".to_string()),
                claude_prompt_cache_ttl: None,
                tool_slimming: false,
            },
            ModelEntry {
                alias: "GPT-5.4".to_string(),
                base_model: "gpt-5.4".to_string(),
                provider_model: "gpt-5.4".to_string(),
                bifrost_model: "openai/gpt-5.4".to_string(),
                provider_kind: ProviderKind::OpenAI,
                uses_responses_api: true,
                max_output_tokens: Some(128000),
                prompt_cache_retention: Some("24h".to_string()),
                claude_prompt_cache_ttl: None,
                tool_slimming: false,
            },
            ModelEntry {
                alias: "GPT-5.4 pro".to_string(),
                base_model: "gpt-5.4-pro".to_string(),
                provider_model: "gpt-5.4-pro-2026-03-05".to_string(),
                bifrost_model: "openai/gpt-5.4-pro-2026-03-05".to_string(),
                provider_kind: ProviderKind::OpenAI,
                uses_responses_api: true,
                max_output_tokens: Some(128000),
                prompt_cache_retention: None,
                claude_prompt_cache_ttl: None,
                tool_slimming: false,
            },
            ModelEntry {
                alias: "Claude Sonnet 4.5".to_string(),
                base_model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0".to_string(),
                provider_model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0".to_string(),
                bifrost_model:
                    "anthropic/us.anthropic.claude-sonnet-4-5-20250929-v1:0"
                        .to_string(),
                provider_kind: ProviderKind::AnthropicConverse,
                uses_responses_api: false,
                max_output_tokens: Some(64000),
                prompt_cache_retention: None,
                claude_prompt_cache_ttl: None,
                tool_slimming: false,
            },
            ModelEntry {
                alias: "Claude Sonnet 4.6".to_string(),
                base_model: "us.anthropic.claude-sonnet-4-6".to_string(),
                provider_model: "us.anthropic.claude-sonnet-4-6".to_string(),
                bifrost_model: "anthropic/us.anthropic.claude-sonnet-4-6".to_string(),
                provider_kind: ProviderKind::AnthropicConverse,
                uses_responses_api: false,
                max_output_tokens: Some(64000),
                prompt_cache_retention: None,
                claude_prompt_cache_ttl: None,
                tool_slimming: false,
            },
            ModelEntry {
                alias: "Gemini 3.5 Flash".to_string(),
                base_model: "gemini-3.5-flash".to_string(),
                provider_model: "gemini-3.5-flash".to_string(),
                bifrost_model: "gemini/gemini-3.5-flash".to_string(),
                provider_kind: ProviderKind::GeminiVertex,
                uses_responses_api: false,
                max_output_tokens: Some(65536),
                prompt_cache_retention: None,
                claude_prompt_cache_ttl: None,
                tool_slimming: false,
            },
            ModelEntry {
                alias: "text-embedding-3-large".to_string(),
                base_model: "text-embedding-3-large".to_string(),
                provider_model: "text-embedding-3-large".to_string(),
                bifrost_model: "openai/text-embedding-3-large".to_string(),
                provider_kind: ProviderKind::OpenAI,
                uses_responses_api: false,
                max_output_tokens: None,
                prompt_cache_retention: None,
                claude_prompt_cache_ttl: None,
                tool_slimming: false,
            },
        ];

        let mut entries_map = std::collections::HashMap::new();
        for entry in &entries {
            entries_map.insert(entry.alias.clone(), entry.clone());
        }

        Catalog {
            entries: entries_map,
            ordered_entries: entries,
            bifrost_config: json!({}),
            provider_headers: provider_headers::ProviderHeaderTemplate {
                user_id: "env.PORTICO_USER_ID".to_string(),
                redact_allow: "env.PORTICO_REDACT_ALLOW".to_string(),
                app_id: "portico".to_string(),
                track: "env.PORTICO_BUILD_TRACK".to_string(),
                log_request: "false".to_string(),
                log_response: "false".to_string(),
                content_type: "application/json".to_string(),
            },
        }
    }

    fn test_state_with_route_mode(
        bifrost_base_url: &str,
        llm_proxy_base_url: &str,
        gpt_openai_route_mode: GptOpenAIRouteMode,
    ) -> AppState {
        AppState {
            catalog: Arc::new(test_catalog()),
            client: Client::builder().use_rustls_tls().build().unwrap(),
            bifrost_base_url: bifrost_base_url.to_string(),
            llm_proxy_base_url: llm_proxy_base_url.to_string(),
            config_output_path: PathBuf::from("/tmp/test-bifrost-config.json"),
            portico_api_key: "key".to_string(),
            ultra_multi_agent_signing_secret:
                "ultra-sign-v1-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"
                    .to_string(),
            local_bearer_auth_enabled: true,
            ultra_run_claims: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            ultra_batches: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            provider_headers: ResolvedProviderHeaders {
                user_id: "user".to_string(),
                redact_allow: "*".to_string(),
                app_id: "portico".to_string(),
                track: "dev-build".to_string(),
                log_request: "false".to_string(),
                log_response: "false".to_string(),
                content_type: "application/json".to_string(),
            },
            prompt_cache_claude_enabled: true,
            gpt_openai_route_mode,
            gpt_openai_route_mode_source: "test".to_string(),
            gpt_service_tier: None,
            gpt_service_tier_source: "test".to_string(),
            bedrock_converse_timeout_seconds: MIN_BEDROCK_CONVERSE_TIMEOUT_SECONDS,
            stream_timeout_config: StreamTimeoutConfig::new(
                Duration::from_secs(DEFAULT_STREAM_IDLE_TIMEOUT_SECONDS),
                None,
            ),
            reporting_dir: None,
            thinking_cache: Arc::new(thinking_cache::ThinkingCache::new(
                64,
                Duration::from_secs(300),
            )),
            claude_thinking_splice_enabled: true,
        }
    }

    fn test_state(bifrost_base_url: &str, llm_proxy_base_url: &str) -> AppState {
        test_state_with_route_mode(
            bifrost_base_url,
            llm_proxy_base_url,
            GptOpenAIRouteMode::Direct,
        )
    }

    fn test_state_with_reporting_dir(
        bifrost_base_url: &str,
        llm_proxy_base_url: &str,
        reporting_dir: PathBuf,
    ) -> AppState {
        let mut state = test_state(bifrost_base_url, llm_proxy_base_url);
        state.reporting_dir = Some(reporting_dir);
        state
    }

    async fn start_server(app: Router) -> TestServer {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let handle = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await
                .unwrap();
        });
        TestServer {
            base_url: format!("http://{}", addr),
            shutdown: Some(shutdown_tx),
            handle: Some(handle),
        }
    }

    async fn response_text(response: Response<Body>) -> String {
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    async fn response_json(response: Response<Body>) -> Value {
        serde_json::from_str(&response_text(response).await).unwrap()
    }

    fn ultra_test_entry() -> ModelEntry {
        ModelEntry {
            alias: "GPT-5.6 Sol Ultra".to_string(),
            base_model: "gpt-5.6-sol".to_string(),
            provider_model: "gpt-5.6-sol".to_string(),
            bifrost_model: "openai/gpt-5.6-sol".to_string(),
            provider_kind: ProviderKind::OpenAI,
            uses_responses_api: true,
            max_output_tokens: Some(128000),
            prompt_cache_retention: Some("24h".to_string()),
            claude_prompt_cache_ttl: None,
            tool_slimming: false,
        }
    }

    #[tokio::test]
    async fn ultra_root_response_exposes_only_sanitized_audit_evidence() {
        let response = ultra_root_response(
            &ultra_test_entry(),
            "resp-root".to_string(),
            "root only".to_string(),
            json!({
                "input_tokens": 10,
                "output_tokens": 2,
                "total_tokens": 12,
            }),
            2,
        );
        assert_eq!(
            response
                .headers()
                .get("x-portico-ultra-child-count")
                .unwrap()
                .to_str()
                .unwrap(),
            "2"
        );

        let wire = response_text(response).await;
        let payload: Value = serde_json::from_str(
            wire.lines()
                .find_map(|line| line.strip_prefix("data: "))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(payload["choices"][0]["delta"]["content"], "root only");
        assert_eq!(
            payload["ultra_audit"],
            json!({
                "child_agent_count": 2,
                "tool_call_count": 0,
                "child_tool_call_count": 0,
                "tool_result_count": 0,
                "continuation_count": 0,
                "arguments_logged": false,
                "results_logged": false,
            })
        );
        assert!(wire.contains("data: [DONE]"));
    }

    fn ultra_test_call(position: usize, call_id: &str) -> UltraToolCall {
        UltraToolCall {
            output_index: position,
            item_id: format!("item-{call_id}"),
            call_id: call_id.to_string(),
            name: "safe_local_read".to_string(),
            namespace: None,
            registered_name: "safe_local_read".to_string(),
            arguments: format!(r#"{{"position":{position}}}"#),
            agent_name: "/root".to_string(),
            payload_digest: ultra_multi_agent::body_sha256(
                format!("payload-{position}-{call_id}").as_bytes(),
            ),
        }
    }

    fn ultra_test_origin() -> ultra_multi_agent::TrustedInteractiveOrigin {
        ultra_multi_agent::TrustedInteractiveOrigin {
            key_version: "v1".to_string(),
            timestamp: now_epoch_seconds(),
            context_digest: ultra_multi_agent::body_sha256(b"test-context"),
            fingerprint: ultra_multi_agent::body_sha256(b"test-fingerprint"),
            body_sha256: ultra_multi_agent::body_sha256(b"test-body"),
        }
    }

    #[test]
    fn ultra_upstream_timeout_uses_only_the_remaining_wall_budget() {
        let fresh = ultra_remaining_wall_time(Instant::now()).unwrap();
        assert!(fresh <= ULTRA_MAX_WALL_TIME);
        assert!(fresh > ULTRA_MAX_WALL_TIME - Duration::from_secs(1));
        let five_minutes_ago = Instant::now()
            .checked_sub(Duration::from_secs(5 * 60))
            .unwrap();
        let partial = ultra_remaining_wall_time(five_minutes_ago).unwrap();
        assert!(partial <= Duration::from_secs(25 * 60));
        assert!(partial > Duration::from_secs(25 * 60 - 1));

        let expired = Instant::now()
            .checked_sub(ULTRA_MAX_WALL_TIME + Duration::from_secs(1))
            .unwrap();
        assert_eq!(ultra_remaining_wall_time(expired), None);
    }

    #[test]
    fn ultra_prompt_cache_key_stays_within_the_provider_limit() {
        let origin = ultra_test_origin();
        let cache_key = ultra_prompt_cache_key(&origin);

        assert_eq!(cache_key, origin.fingerprint.clone());
        assert_eq!(cache_key.len(), 64);
        let payload = prepare_ultra_responses_payload(
            json!({
                "model": "GPT-5.6 Sol",
                "messages": [
                    {"role": "system", "content": "original system instruction"},
                    {"role": "user", "content": "test"}
                ],
                "tools": [
                    {
                        "type": "function",
                        "function": {
                            "name": "subagents_run_subagent",
                            "description": "local delegation",
                            "parameters": {"type": "object"}
                        }
                    },
                    {
                        "type": "function",
                        "function": {
                            "name": "safe_local_read",
                            "description": "safe read",
                            "parameters": {"type": "object"}
                        }
                    }
                ],
                "stream": true,
            }),
            &ultra_test_entry(),
            &cache_key,
            None,
        )
        .unwrap();
        assert_eq!(payload["prompt_cache_key"], json!(origin.fingerprint));
        assert!(payload["instructions"]
            .as_str()
            .unwrap()
            .contains("Across this user turn, use at least one hosted child agent"));
        assert!(payload["instructions"]
            .as_str()
            .unwrap()
            .contains("Hosted children must never emit developer function calls"));
        assert!(payload["instructions"]
            .as_str()
            .unwrap()
            .contains("Only the root may emit developer function calls"));
        assert!(payload["instructions"]
            .as_str()
            .unwrap()
            .starts_with("original system instruction"));
        let tools = payload["tools"].as_array().unwrap();
        assert!(tools.iter().all(|tool| !tool["name"]
            .as_str()
            .unwrap_or("")
            .starts_with("subagents_")));
        assert!(tools
            .iter()
            .any(|tool| tool["name"] == json!("safe_local_read")));
    }

    fn claude_test_entry() -> ModelEntry {
        ModelEntry {
            alias: "Claude Sonnet 4.6".to_string(),
            base_model: "us.anthropic.claude-sonnet-4-6".to_string(),
            provider_model: "us.anthropic.claude-sonnet-4-6".to_string(),
            bifrost_model: "anthropic/us.anthropic.claude-sonnet-4-6".to_string(),
            provider_kind: ProviderKind::AnthropicConverse,
            uses_responses_api: false,
            max_output_tokens: Some(64000),
            prompt_cache_retention: None,
            claude_prompt_cache_ttl: None,
            tool_slimming: false,
        }
    }

    #[test]
    fn normalize_injects_service_tier_for_gpt_responses_models_only() {
        // Per-chat value arrives via the flattened top-level key and survives
        // conversion into the Responses payload.
        let mut payload = json!({
            "model": "GPT-5.6 Sol Ultra",
            "service_tier": "priority",
            "messages": [{"role": "user", "content": "hi"}],
        });
        normalize_chat_payload_for_provider(
            &mut payload,
            &ultra_test_entry(),
            true,
            None,
            None,
            None,
            "test",
        );
        assert_eq!(payload["service_tier"], json!("priority"));
        let responses_payload =
            chat_completion_to_responses_payload(&payload, &ultra_test_entry()).unwrap();
        assert_eq!(responses_payload["service_tier"], json!("priority"));

        // Fleet env default applies when the chat did not choose a tier.
        let mut payload = json!({
            "model": "GPT-5.6 Sol Ultra",
            "messages": [{"role": "user", "content": "hi"}],
        });
        normalize_chat_payload_for_provider(
            &mut payload,
            &ultra_test_entry(),
            true,
            None,
            Some("priority"),
            None,
            "test",
        );
        assert_eq!(payload["service_tier"], json!("priority"));

        // An explicit per-chat "off" suppresses the fleet default.
        let mut payload = json!({
            "model": "GPT-5.6 Sol Ultra",
            "params": {"service_tier": "off"},
            "messages": [{"role": "user", "content": "hi"}],
        });
        normalize_chat_payload_for_provider(
            &mut payload,
            &ultra_test_entry(),
            true,
            None,
            Some("priority"),
            None,
            "test",
        );
        assert!(payload.get("service_tier").is_none());

        // Claude/Bifrost route: the tier is consumed and never forwarded.
        let mut payload = json!({
            "model": "Claude Sonnet 4.6",
            "service_tier": "priority",
            "messages": [{"role": "user", "content": "hi"}],
        });
        normalize_chat_payload_for_provider(
            &mut payload,
            &claude_test_entry(),
            true,
            None,
            Some("priority"),
            None,
            "test",
        );
        assert!(payload.get("service_tier").is_none());
    }

    #[test]
    fn ultra_payload_carries_the_chosen_service_tier() {
        let base_body = json!({
            "model": "GPT-5.6 Sol",
            "messages": [{"role": "user", "content": "t"}],
            "stream": true,
        });

        let mut chat_choice = base_body.clone();
        chat_choice
            .as_object_mut()
            .unwrap()
            .insert("params".to_string(), json!({"service_tier": "priority"}));
        let payload =
            prepare_ultra_responses_payload(chat_choice, &ultra_test_entry(), "cache-key", None)
                .unwrap();
        assert_eq!(payload["service_tier"], json!("priority"));

        let env_payload = prepare_ultra_responses_payload(
            base_body.clone(),
            &ultra_test_entry(),
            "cache-key",
            Some("priority"),
        )
        .unwrap();
        assert_eq!(env_payload["service_tier"], json!("priority"));

        let untiered =
            prepare_ultra_responses_payload(base_body, &ultra_test_entry(), "cache-key", None)
                .unwrap();
        assert!(untiered.get("service_tier").is_none());
    }

    #[test]
    fn translated_usage_carries_served_service_tier_when_upstream_echoes_it() {
        let tiered = json!({
            "id": "resp_tiered",
            "service_tier": "priority",
            "usage": {"input_tokens": 5, "output_tokens": 3, "total_tokens": 8}
        });
        let tiered_map = tiered.as_object().unwrap();
        let usage =
            responses_stream_usage_with_cost(&ultra_test_entry(), tiered_map, Some(0.01)).unwrap();
        assert_eq!(usage["service_tier"], json!("priority"));

        let chat_payload = response_to_chat_completion_payload(
            tiered_map,
            &ultra_test_entry(),
            Some(0.01),
        );
        assert_eq!(
            chat_payload.pointer("/usage/service_tier"),
            Some(&json!("priority"))
        );

        let untiered = json!({
            "id": "resp_untiered",
            "usage": {"input_tokens": 5, "output_tokens": 3, "total_tokens": 8}
        });
        let untiered_map = untiered.as_object().unwrap();
        let usage = responses_stream_usage_with_cost(&ultra_test_entry(), untiered_map, Some(0.01))
            .unwrap();
        assert!(usage.get("service_tier").is_none());
        let chat_payload = response_to_chat_completion_payload(
            untiered_map,
            &ultra_test_entry(),
            Some(0.01),
        );
        assert!(chat_payload
            .pointer("/usage/service_tier")
            .is_none());
    }

    fn ultra_test_reporting_context() -> ReportingContext {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-openwebui-chat-id",
            HeaderValue::from_static("ultra-chat"),
        );
        headers.insert(
            "x-openwebui-message-id",
            HeaderValue::from_static("ultra-message"),
        );
        extract_reporting_context(&headers, None).unwrap()
    }

    async fn seed_ultra_batch(state: &AppState, calls: Vec<UltraToolCall>) -> String {
        let output = calls
            .iter()
            .map(|call| {
                json!({
                    "id": call.item_id,
                    "type": "function_call",
                    "call_id": call.call_id,
                    "name": call.name,
                    "arguments": call.arguments,
                    "agent": {"agent_name": call.agent_name},
                })
            })
            .collect::<Vec<_>>();
        store_initial_ultra_batch(
            state,
            &ultra_test_origin(),
            Instant::now(),
            ultra_test_entry(),
            json!({
                "model": "gpt-5.6-sol",
                "input": [{"role": "user", "content": "test"}],
                "tools": [{
                    "type": "function",
                    "name": "safe_local_read",
                    "description": "Returns local JSON data",
                    "parameters": {"type": "object"}
                }],
                "store": false,
                "stream": true,
                "multi_agent": {"enabled": true, "max_concurrent_subagents": 4},
                "reasoning": {"effort": "max"},
                "prompt_cache_key": ultra_prompt_cache_key(&ultra_test_origin()),
                "prompt_cache_retention": "24h",
            }),
            format!("resp-seed-{}", Uuid::new_v4().simple()),
            calls,
            json!({
                "input_tokens": 10,
                "output_tokens": 2,
                "total_tokens": 12,
                "input_tokens_details": {
                    "cached_tokens": 4,
                    "cached_read_tokens": 4,
                    "cached_write_tokens": 0
                }
            }),
            output,
            Some(ultra_test_reporting_context()),
            "test-ultra-call".to_string(),
        )
        .await
        .unwrap()
    }

    fn ultra_sse(response_id: &str, output: Vec<Value>, usage: Value) -> String {
        let mut wire = String::new();
        for (output_index, item) in output.iter().enumerate() {
            for event_type in ["response.output_item.added", "response.output_item.done"] {
                let event = json!({
                    "type": event_type,
                    "output_index": output_index,
                    "item": item,
                });
                wire.push_str(&format!(
                    "event: {event_type}\ndata: {}\n\n",
                    serde_json::to_string(&event).unwrap()
                ));
            }
        }
        wire.push_str(&format!(
            "event: response.completed\ndata: {}\n\n",
            serde_json::to_string(&json!({
                "type": "response.completed",
                "response": {"id": response_id, "output": output, "usage": usage},
            }))
            .unwrap()
        ));
        wire
    }

    fn ultra_dispatch_marker(call: &UltraToolCall) -> UltraDispatchMarker {
        UltraDispatchMarker {
            call_id: call.call_id.clone(),
            payload_digest: call.payload_digest.clone(),
        }
    }

    fn assert_portico_contract_headers(
        headers: &HeaderMap,
        expect_authorization: bool,
        expect_bifrost_audit_headers: bool,
    ) {
        assert_eq!(headers.get("x-portico-userid").unwrap(), "user");
        assert_eq!(headers.get("x-portico-redact-allow").unwrap(), "*");
        assert_eq!(headers.get("x-portico-appid").unwrap(), "portico");
        assert_eq!(headers.get("x-portico-track").unwrap(), "dev-build");
        assert_eq!(headers.get("x-portico-log-request").unwrap(), "false");
        assert_eq!(headers.get("x-portico-log-response").unwrap(), "false");
        assert_eq!(headers.get(CONTENT_TYPE).unwrap(), "application/json");

        if expect_authorization {
            assert_eq!(headers.get("authorization").unwrap(), "Bearer key");
        } else {
            assert!(headers.get("authorization").is_none());
        }

        if expect_bifrost_audit_headers {
            assert_eq!(
                headers.get("x-bf-lh-portico-userid-present").unwrap(),
                "true"
            );
            assert!(headers.get("x-bf-lh-portico-userid-fingerprint").is_some());
            assert_eq!(
                headers.get("x-bf-lh-portico-redact-allow-present").unwrap(),
                "true"
            );
            assert!(headers
                .get("x-bf-lh-portico-redact-allow-fingerprint")
                .is_some());
        } else {
            assert!(headers.get("x-bf-lh-portico-userid-present").is_none());
            assert!(headers.get("x-bf-lh-portico-userid-fingerprint").is_none());
            assert!(headers.get("x-bf-lh-portico-redact-allow-present").is_none());
            assert!(headers
                .get("x-bf-lh-portico-redact-allow-fingerprint")
                .is_none());
        }
    }

    async fn start_raw_http_server(response_bytes: Vec<u8>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request).await;
            let _ = stream.write_all(&response_bytes).await;
            let _ = stream.shutdown().await;
        });
        format!("http://{}", addr)
    }

    async fn start_chunked_sse_server(body_chunks: Vec<Vec<u8>>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request).await;
            let _ = stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n",
                )
                .await;
            for body_chunk in body_chunks {
                let chunk_len = format!("{:X}\r\n", body_chunk.len());
                let _ = stream.write_all(chunk_len.as_bytes()).await;
                let _ = stream.write_all(&body_chunk).await;
                let _ = stream.write_all(b"\r\n").await;
                let _ = stream.flush().await;
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let _ = stream.write_all(b"0\r\n\r\n").await;
            let _ = stream.shutdown().await;
        });
        format!("http://{}", addr)
    }

    fn raw_chunked_http_response(
        headers: &[(&str, &str)],
        body_chunks: &[Vec<u8>],
        trailing_bytes: &[u8],
    ) -> Vec<u8> {
        let mut response = b"HTTP/1.1 200 OK\r\n".to_vec();
        for (name, value) in headers {
            response.extend_from_slice(format!("{name}: {value}\r\n").as_bytes());
        }
        response.extend_from_slice(b"\r\n");
        for body_chunk in body_chunks {
            response.extend_from_slice(format!("{:X}\r\n", body_chunk.len()).as_bytes());
            response.extend_from_slice(body_chunk);
            response.extend_from_slice(b"\r\n");
        }
        response.extend_from_slice(trailing_bytes);
        response
    }

    fn temp_file_path(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("bifrost-bridge-{name}-{nanos}.json"))
    }

    #[test]
    fn env_helpers_cover_true_false_and_missing_cases() {
        let true_name = "BIFROST_BRIDGE_TEST_BOOL_TRUE";
        std::env::set_var(true_name, "yes");
        assert!(env_bool(true_name, false));

        let false_name = "BIFROST_BRIDGE_TEST_BOOL_FALSE";
        std::env::set_var(false_name, "no");
        assert!(!env_bool(false_name, true));

        let missing_name = "BIFROST_BRIDGE_TEST_BOOL_MISSING";
        std::env::remove_var(missing_name);
        assert!(env_bool(missing_name, true));

        let req_name = "BIFROST_BRIDGE_REQUIRED_ENV";
        std::env::set_var(req_name, "value");
        assert_eq!(required_env(req_name).unwrap(), "value");
        std::env::remove_var(req_name);
        assert!(required_env(req_name).is_err());

        let default_name = "BIFROST_BRIDGE_DEFAULT_ENV";
        std::env::remove_var(default_name);
        assert_eq!(env_or(default_name, "fallback"), "fallback");
        std::env::set_var(default_name, "explicit");
        assert_eq!(env_or(default_name, "fallback"), "explicit");

        let retry_attempts_name = "BIFROST_BRIDGE_TEST_U32_ENV";
        std::env::remove_var(retry_attempts_name);
        assert_eq!(env_u32(retry_attempts_name, 7), 7);
        std::env::set_var(retry_attempts_name, "9");
        assert_eq!(env_u32(retry_attempts_name, 7), 9);
        std::env::set_var(retry_attempts_name, "0");
        assert_eq!(env_u32(retry_attempts_name, 7), 7);

        let retry_delay_name = "BIFROST_BRIDGE_TEST_U64_ENV";
        std::env::remove_var(retry_delay_name);
        assert_eq!(env_u64(retry_delay_name, 11), 11);
        std::env::set_var(retry_delay_name, "13");
        assert_eq!(env_u64(retry_delay_name, 11), 13);
        std::env::set_var(retry_delay_name, "-1");
        assert_eq!(env_u64(retry_delay_name, 11), 11);
        assert_eq!(env_optional_u64_allow_zero(retry_delay_name, 11), Some(11));
        std::env::set_var(retry_delay_name, "0");
        assert_eq!(env_optional_u64_allow_zero(retry_delay_name, 11), None);
        std::env::set_var(retry_delay_name, "17");
        assert_eq!(env_optional_u64_allow_zero(retry_delay_name, 11), Some(17));
        std::env::set_var(retry_delay_name, "invalid");
        assert_eq!(env_optional_u64_allow_zero(retry_delay_name, 11), Some(11));
        std::env::remove_var(retry_delay_name);
        assert_eq!(env_optional_u64_allow_zero(retry_delay_name, 0), None);

        let body_limit_name = "BIFROST_BRIDGE_MAX_REQUEST_BODY_BYTES";
        std::env::remove_var(body_limit_name);
        assert_eq!(bridge_max_request_body_bytes(), None);
        std::env::set_var(body_limit_name, "1048576");
        assert_eq!(bridge_max_request_body_bytes(), Some(1_048_576));
        std::env::set_var(body_limit_name, "0");
        assert_eq!(bridge_max_request_body_bytes(), None);
        std::env::set_var(body_limit_name, "invalid");
        assert_eq!(bridge_max_request_body_bytes(), None);
        std::env::remove_var(body_limit_name);

        let non_stream_timeout_name = "BIFROST_BRIDGE_NON_STREAM_REQUEST_TIMEOUT_SECONDS";
        std::env::remove_var(non_stream_timeout_name);
        assert_eq!(
            bridge_non_stream_request_timeout_seconds(),
            DEFAULT_NON_STREAM_REQUEST_TIMEOUT_SECONDS
        );
        std::env::set_var(non_stream_timeout_name, "420");
        assert_eq!(bridge_non_stream_request_timeout_seconds(), 420);

        let idle_timeout_name = "BIFROST_BRIDGE_STREAM_IDLE_TIMEOUT_SECONDS";
        let total_timeout_name = "BIFROST_BRIDGE_STREAM_TOTAL_TIMEOUT_SECONDS";
        std::env::remove_var(idle_timeout_name);
        std::env::remove_var(total_timeout_name);
        assert_eq!(
            StreamTimeoutConfig::from_env(),
            StreamTimeoutConfig::new(
                Duration::from_secs(DEFAULT_STREAM_IDLE_TIMEOUT_SECONDS),
                None,
            )
        );
        std::env::set_var(idle_timeout_name, "45");
        std::env::set_var(total_timeout_name, "30");
        assert_eq!(
            StreamTimeoutConfig::from_env(),
            StreamTimeoutConfig::new(Duration::from_secs(45), Some(Duration::from_secs(45)))
        );
        std::env::set_var(total_timeout_name, "0");
        assert_eq!(
            StreamTimeoutConfig::from_env(),
            StreamTimeoutConfig::new(Duration::from_secs(45), None)
        );
        std::env::remove_var(idle_timeout_name);
        std::env::remove_var(total_timeout_name);
        std::env::remove_var(non_stream_timeout_name);

        std::env::remove_var(GPT_OPENAI_ROUTE_MODE_ENV);
        assert_eq!(
            load_gpt_openai_route_mode(),
            (GptOpenAIRouteMode::Direct, "default")
        );
        std::env::set_var(GPT_OPENAI_ROUTE_MODE_ENV, "bifrost");
        assert_eq!(
            load_gpt_openai_route_mode(),
            (GptOpenAIRouteMode::Bifrost, "env")
        );
        std::env::set_var(GPT_OPENAI_ROUTE_MODE_ENV, "invalid");
        assert_eq!(
            load_gpt_openai_route_mode(),
            (GptOpenAIRouteMode::Direct, "invalid_env_fallback")
        );
        std::env::remove_var(GPT_OPENAI_ROUTE_MODE_ENV);
    }

    #[test]
    fn authorization_matches_bearer_requires_expected_token() {
        assert!(authorization_matches_bearer(
            "Bearer sk-local-test",
            "sk-local-test",
        ));
        assert!(authorization_matches_bearer(
            "bearer sk-local-test",
            "sk-local-test",
        ));
        assert!(!authorization_matches_bearer(
            "Bearer wrong-token",
            "sk-local-test",
        ));
        assert!(!authorization_matches_bearer("Basic abc", "sk-local-test"));
        assert!(!authorization_matches_bearer("", "sk-local-test"));
        // Regression: prefix of the expected token and same-length-but-diff
        // content must both be rejected. Prefix-only rejection guards against
        // accidental `starts_with` refactors, and same-length coverage
        // exercises the constant-time path where `subtle::ConstantTimeEq`
        // actually does byte-level timing-safe comparison.
        assert!(!authorization_matches_bearer(
            "Bearer sk-local",
            "sk-local-test"
        ));
        assert!(!authorization_matches_bearer(
            "Bearer sk-local-XXXX",
            "sk-local-test",
        ));
    }

    #[tokio::test]
    async fn next_stream_item_with_timeouts_allows_regular_progress_past_idle_budget() {
        let stream = async_stream::stream! {
            tokio::time::sleep(Duration::from_millis(10)).await;
            yield 1;
            tokio::time::sleep(Duration::from_millis(10)).await;
            yield 2;
            tokio::time::sleep(Duration::from_millis(10)).await;
            yield 3;
        };
        futures_util::pin_mut!(stream);

        let timeout_config =
            StreamTimeoutConfig::new(Duration::from_millis(20), Some(Duration::from_millis(100)));
        let started_at = Instant::now();

        assert_eq!(
            next_stream_item_with_timeouts(
                stream.as_mut(),
                started_at,
                timeout_config,
                false,
                None
            )
            .await
            .unwrap(),
            Some(1)
        );
        assert_eq!(
            next_stream_item_with_timeouts(stream.as_mut(), started_at, timeout_config, true, None)
                .await
                .unwrap(),
            Some(2)
        );
        assert_eq!(
            next_stream_item_with_timeouts(stream.as_mut(), started_at, timeout_config, true, None)
                .await
                .unwrap(),
            Some(3)
        );
        assert_eq!(
            next_stream_item_with_timeouts(stream.as_mut(), started_at, timeout_config, true, None)
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn next_stream_item_with_timeouts_reports_idle_timeout_when_stream_stalls() {
        let stream = async_stream::stream! {
            tokio::time::sleep(Duration::from_millis(5)).await;
            yield 1;
            tokio::time::sleep(Duration::from_millis(30)).await;
            yield 2;
        };
        futures_util::pin_mut!(stream);

        let timeout_config =
            StreamTimeoutConfig::new(Duration::from_millis(15), Some(Duration::from_millis(80)));
        let started_at = Instant::now();

        assert_eq!(
            next_stream_item_with_timeouts(
                stream.as_mut(),
                started_at,
                timeout_config,
                false,
                None
            )
            .await
            .unwrap(),
            Some(1)
        );

        let error =
            next_stream_item_with_timeouts(stream.as_mut(), started_at, timeout_config, true, None)
                .await
                .unwrap_err();
        assert_eq!(error.layer, StreamTimeoutLayer::Idle);
        assert_eq!(error.timeout, Duration::from_millis(15));
        assert_eq!(error.progress_phase, StreamProgressPhase::AfterProgress);
        assert_eq!(error.effective_idle_timeout, Duration::from_millis(15));
    }

    #[tokio::test]
    async fn next_stream_item_with_timeouts_keeps_pre_progress_idle_budget_before_first_chunk() {
        let stream = async_stream::stream! {
            tokio::time::sleep(Duration::from_millis(30)).await;
            yield 1;
        };
        futures_util::pin_mut!(stream);

        let timeout_config = StreamTimeoutConfig::new(Duration::from_millis(15), None);
        let started_at = Instant::now();

        let error = next_stream_item_with_timeouts(
            stream.as_mut(),
            started_at,
            timeout_config,
            false,
            Some(Duration::from_millis(60)),
        )
        .await
        .unwrap_err();
        assert_eq!(error.layer, StreamTimeoutLayer::Idle);
        assert_eq!(error.timeout, Duration::from_millis(15));
        assert_eq!(error.progress_phase, StreamProgressPhase::BeforeProgress);
        assert_eq!(error.effective_idle_timeout, Duration::from_millis(15));
    }

    #[tokio::test]
    async fn next_stream_item_with_timeouts_allows_post_progress_stall_with_relaxed_idle_budget() {
        let stream = async_stream::stream! {
            tokio::time::sleep(Duration::from_millis(5)).await;
            yield 1;
            tokio::time::sleep(Duration::from_millis(30)).await;
            yield 2;
        };
        futures_util::pin_mut!(stream);

        let timeout_config = StreamTimeoutConfig::new(Duration::from_millis(15), None);
        let started_at = Instant::now();
        let post_progress_idle_timeout = Some(Duration::from_millis(50));

        assert_eq!(
            next_stream_item_with_timeouts(
                stream.as_mut(),
                started_at,
                timeout_config,
                false,
                post_progress_idle_timeout,
            )
            .await
            .unwrap(),
            Some(1)
        );
        assert_eq!(
            next_stream_item_with_timeouts(
                stream.as_mut(),
                started_at,
                timeout_config,
                true,
                post_progress_idle_timeout,
            )
            .await
            .unwrap(),
            Some(2)
        );
        assert_eq!(
            next_stream_item_with_timeouts(
                stream.as_mut(),
                started_at,
                timeout_config,
                true,
                post_progress_idle_timeout,
            )
            .await
            .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn next_stream_item_with_timeouts_reports_total_timeout_for_long_streams() {
        let stream = async_stream::stream! {
            yield 1;
            tokio::time::sleep(Duration::from_millis(100)).await;
            yield 2;
        };
        futures_util::pin_mut!(stream);

        let timeout_config =
            StreamTimeoutConfig::new(Duration::from_millis(20), Some(Duration::from_millis(45)));
        let started_at = Instant::now() - Duration::from_millis(40);

        assert_eq!(
            next_stream_item_with_timeouts(
                stream.as_mut(),
                started_at,
                timeout_config,
                false,
                Some(Duration::from_millis(100)),
            )
            .await
            .unwrap(),
            Some(1)
        );
        let error = next_stream_item_with_timeouts(
            stream.as_mut(),
            started_at,
            timeout_config,
            true,
            Some(Duration::from_millis(100)),
        )
        .await
        .unwrap_err();
        assert_eq!(error.layer, StreamTimeoutLayer::Total);
        assert_eq!(error.timeout, Duration::from_millis(45));
        assert_eq!(error.progress_phase, StreamProgressPhase::AfterProgress);
        assert_eq!(error.effective_idle_timeout, Duration::from_millis(100));
    }

    #[test]
    fn stream_timeout_config_reports_disabled_total_timeout_for_logs() {
        let timeout_config = StreamTimeoutConfig::new(Duration::from_secs(45), None);
        assert!(!timeout_config.total_timeout_enabled());
        assert_eq!(timeout_config.total_timeout_seconds(), None);
        assert_eq!(timeout_config.total_timeout_label(), "disabled");
    }

    #[tokio::test]
    async fn next_stream_item_with_timeouts_allows_long_streams_when_total_timeout_disabled() {
        let stream = async_stream::stream! {
            tokio::time::sleep(Duration::from_millis(10)).await;
            yield 1;
            tokio::time::sleep(Duration::from_millis(10)).await;
            yield 2;
            tokio::time::sleep(Duration::from_millis(10)).await;
            yield 3;
            tokio::time::sleep(Duration::from_millis(10)).await;
            yield 4;
            tokio::time::sleep(Duration::from_millis(10)).await;
            yield 5;
        };
        futures_util::pin_mut!(stream);

        let timeout_config = StreamTimeoutConfig::new(Duration::from_millis(20), None);
        let started_at = Instant::now();

        assert_eq!(
            next_stream_item_with_timeouts(
                stream.as_mut(),
                started_at,
                timeout_config,
                false,
                None
            )
            .await
            .unwrap(),
            Some(1)
        );
        assert_eq!(
            next_stream_item_with_timeouts(stream.as_mut(), started_at, timeout_config, true, None)
                .await
                .unwrap(),
            Some(2)
        );
        assert_eq!(
            next_stream_item_with_timeouts(stream.as_mut(), started_at, timeout_config, true, None)
                .await
                .unwrap(),
            Some(3)
        );
        assert_eq!(
            next_stream_item_with_timeouts(stream.as_mut(), started_at, timeout_config, true, None)
                .await
                .unwrap(),
            Some(4)
        );
        assert_eq!(
            next_stream_item_with_timeouts(stream.as_mut(), started_at, timeout_config, true, None)
                .await
                .unwrap(),
            Some(5)
        );
        assert_eq!(
            next_stream_item_with_timeouts(stream.as_mut(), started_at, timeout_config, true, None)
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn send_upstream_request_with_retry_survives_transport_failures_until_final_attempt() {
        std::env::remove_var("BIFROST_BRIDGE_UPSTREAM_RETRY_MAX_ATTEMPTS");
        std::env::remove_var("BIFROST_BRIDGE_UPSTREAM_RETRY_BASE_DELAY_MS");
        std::env::remove_var("BIFROST_BRIDGE_UPSTREAM_RETRY_MAX_DELAY_MS");

        let success_server = start_server(Router::new().route(
            "/ok",
            any(|| async {
                let mut response = Response::new(Body::from("ok"));
                response
                    .headers_mut()
                    .insert(CONTENT_TYPE, HeaderValue::from_static("text/plain"));
                response
            }),
        ))
        .await;
        let success_url = format!("{}/ok", success_server.base_url);
        let client = Client::builder().use_rustls_tls().build().unwrap();
        let build_attempts = Arc::new(AtomicUsize::new(0));
        let build_attempts_clone = Arc::clone(&build_attempts);

        let response = send_upstream_request_with_retry(
            &client,
            "test_retry_route",
            "test transport recovery",
            "Claude Sonnet 4.5",
            false,
            None,
            None,
            BridgeRequestTiming::new(None),
            move |client: &Client| {
                let attempt = build_attempts_clone.fetch_add(1, Ordering::SeqCst) + 1;
                if attempt < upstream_retry_max_attempts() as usize {
                    client.get("http://127.0.0.1:9/unreachable")
                } else {
                    client.get(&success_url)
                }
            },
        )
        .await
        .unwrap();

        assert_eq!(response.response.status(), StatusCode::OK);
        assert_eq!(
            build_attempts.load(Ordering::SeqCst),
            upstream_retry_max_attempts() as usize
        );
    }

    #[tokio::test]
    async fn stream_read_failure_details_capture_reqwest_decode_failures() {
        let malformed_stream_base = start_raw_http_server(raw_chunked_http_response(
            &[
                ("Content-Type", "text/event-stream"),
                ("Transfer-Encoding", "chunked"),
                ("X-Request-Id", "req_upstream_1"),
            ],
            &[b"data: {\"messageStart\":{\"role\":\"assistant\"}}\n\n".to_vec()],
            b"ZZ\r\nbad\r\n",
        ))
        .await;
        let response = Client::builder()
            .use_rustls_tls()
            .build()
            .unwrap()
            .get(malformed_stream_base)
            .send()
            .await
            .unwrap();

        let mut stream = response.bytes_stream();
        let first_chunk = stream.next().await.unwrap().unwrap();
        assert!(!first_chunk.is_empty());

        let error = stream.next().await.unwrap().unwrap_err();
        let details = StreamReadFailureDetails::from_reqwest(&error);
        assert!(
            details.raw_error.contains("error decoding response body"),
            "{details:?}"
        );
        assert!(!details.error_chain.is_empty());
        assert!(details.is_body || details.is_decode, "{details:?}");
        assert_eq!(details.status, None);
    }

    #[tokio::test]
    async fn write_config_and_health_and_list_models_work() {
        let path = temp_file_path("config");
        let catalog = test_catalog();
        write_bifrost_config(&path, &catalog).await.unwrap();
        let written: Value =
            serde_json::from_str(&fs::read_to_string(&path).await.unwrap()).unwrap();
        assert_eq!(written, catalog.bifrost_config);
        fs::remove_file(&path).await.ok();

        let health_server = start_server(
            Router::new().route("/health", any(|| async { Json(json!({"ok": true})) })),
        )
        .await;
        let ok_state = test_state(&health_server.base_url, "http://unused");
        let healthy = response_json(health(State(ok_state)).await).await;
        assert_eq!(healthy["bifrost_ready"], json!(true));

        let bad_state = test_state("http://127.0.0.1:9", "http://unused");
        let unhealthy = response_json(health(State(bad_state)).await).await;
        assert_eq!(unhealthy["bifrost_ready"], json!(false));

        let models =
            response_json(list_models(State(test_state("http://unused", "http://unused"))).await)
                .await;
        assert_eq!(models["data"].as_array().unwrap().len(), 8);

        let nested = temp_file_path("nested").join("dir").join("config.json");
        write_bifrost_config(&nested, &catalog).await.unwrap();
        assert!(nested.exists());
        fs::remove_file(&nested).await.ok();
        fs::remove_dir_all(nested.parent().unwrap()).await.ok();

        let bare = PathBuf::from(format!(
            "bifrost-bridge-bare-{}.json",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        write_bifrost_config(&bare, &catalog).await.unwrap();
        assert!(bare.exists());
        fs::remove_file(&bare).await.ok();

        health_server.shutdown().await;
    }

    #[test]
    fn small_response_helpers_cover_error_and_cost_paths() {
        let message = body_stream_error(anyhow!("boom"));
        assert_eq!(message.to_string(), "boom");

        let json_err = json_error(StatusCode::BAD_REQUEST, "bad");
        assert_eq!(json_err.status(), StatusCode::BAD_REQUEST);

        let anthropic = anthropic_error(StatusCode::BAD_GATEWAY, "api_error", "oops");
        assert_eq!(anthropic.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(
            anthropic.headers().get("anthropic-version").unwrap(),
            ANTHROPIC_API_VERSION
        );

        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("x-portico-cost-usd", "0.42".parse().unwrap());
        headers.insert("x-request-id", "req_1".parse().unwrap());
        headers.insert("retry-after", "5".parse().unwrap());
        let passthrough = passthrough_cost_headers(&headers);
        assert_eq!(passthrough.get("x-portico-cost-usd").unwrap(), "0.42");
        assert_eq!(passthrough.get("retry-after").unwrap(), "5");
        assert_eq!(extract_cost_hint(&headers), Some(0.42));
        assert_eq!(extract_cost_hint(&reqwest::header::HeaderMap::new()), None);
        assert_eq!(parse_retry_after_ms(&headers), Some(5_000));
        std::env::remove_var("BIFROST_BRIDGE_UPSTREAM_RETRY_BASE_DELAY_MS");
        std::env::remove_var("BIFROST_BRIDGE_UPSTREAM_RETRY_MAX_DELAY_MS");
        assert_eq!(compute_retry_delay_ms(None, 1), 1_000);
        assert_eq!(compute_retry_delay_ms(None, 2), 2_000);
        assert_eq!(compute_retry_delay_ms(None, 3), 4_000);
        assert_eq!(compute_retry_delay_ms(None, 4), 5_000);
        assert_eq!(compute_retry_delay_ms(Some(0), 1), 0);
        assert_eq!(
            extract_timeout_seconds_from_message("request timed out (default is 30 seconds)."),
            Some(30)
        );
        assert_eq!(
            provider_timeout_seconds(
                &json!({
                    "providers": {
                        "anthropic": {
                            "network_config": {
                                "default_request_timeout_in_seconds": 300
                            }
                        }
                    }
                }),
                BEDROCK_CONVERSE_PROVIDER_NAME,
            ),
            Some(300)
        );
        assert_eq!(
            normalize_upstream_error_message(
                r#"{"status_code":502,"error":{"type":"api_error","message":"error sending request for url (https://internal.example/api)"}}"#,
                StatusCode::BAD_GATEWAY,
            ),
            "error sending request for url (https://internal.example/api)"
        );
        assert_eq!(
            normalize_stream_failure_message("read tcp 1.2.3.4:1->1.2.3.4:4000: i/o timeout"),
            "Upstream model provider stream timed out. Please retry."
        );
        assert_eq!(
            transient_failure_message(StatusCode::BAD_GATEWAY),
            "Upstream model provider is temporarily unavailable. Please retry."
        );
        assert_eq!(
            transient_failure_message(StatusCode::TOO_MANY_REQUESTS),
            "Upstream model provider is temporarily rate limited. Please retry."
        );

        let mut object = serde_json::Map::new();
        object.insert(
            "extra_fields".to_string(),
            json!({"provider_response_headers":{"x-portico-cost-usd":"1.25"}}),
        );
        inject_usage_cost(&mut object, None);
        assert_eq!(object["usage"]["cost"], json!(1.25));

        let mut with_existing_cost = serde_json::Map::new();
        with_existing_cost.insert("usage".to_string(), json!({"cost": 9.99}));
        inject_usage_cost(&mut with_existing_cost, Some(1.0));
        assert_eq!(with_existing_cost["usage"]["cost"], json!(9.99));

        let mut invalid_header_cost = serde_json::Map::new();
        invalid_header_cost.insert(
            "extra_fields".to_string(),
            json!({"provider_response_headers":{"x-portico-cost-usd":"not-a-number"}}),
        );
        inject_usage_cost(&mut invalid_header_cost, None);
        assert!(invalid_header_cost.get("usage").is_none());

        let mut non_object_usage = serde_json::Map::new();
        non_object_usage.insert("usage".to_string(), json!(7));
        inject_usage_cost(&mut non_object_usage, Some(2.0));
        assert_eq!(non_object_usage["usage"], json!(7));

        assert_eq!(
            response_usage_to_chat_usage(&json!({})),
            json!({
                "prompt_tokens":0,
                "completion_tokens":0,
                "total_tokens":0,
                "prompt_tokens_details":{
                    "cached_tokens":0,
                    "cached_read_tokens":0,
                    "cached_write_tokens":0
                },
                "completion_tokens_details":{"reasoning_tokens":0}
            })
        );
        assert!(responses_stream_usage_with_cost(
            &test_catalog().entries["GPT-4.1"],
            json!({}).as_object().unwrap(),
            None,
        )
        .is_none());
        let usage_with_existing_cost = responses_stream_usage_with_cost(
            &test_catalog().entries["GPT-4.1"],
            json!({
                "usage":{
                    "input_tokens":10,
                    "output_tokens":1,
                    "total_tokens":11
                }
            })
            .as_object()
            .unwrap(),
            Some(1.5),
        )
        .unwrap();
        assert_eq!(usage_with_existing_cost["cost"], json!(1.5));
        let unknown_entry = ModelEntry {
            alias: "Unknown".to_string(),
            base_model: "unknown".to_string(),
            provider_model: "unknown".to_string(),
            bifrost_model: "unknown".to_string(),
            provider_kind: ProviderKind::OpenAI,
            uses_responses_api: false,
            max_output_tokens: None,
            prompt_cache_retention: None,
            claude_prompt_cache_ttl: None,
            tool_slimming: false,
        };
        let no_cost_usage = responses_stream_usage_with_cost(
            &unknown_entry,
            json!({
                "usage":{
                    "input_tokens":10,
                    "output_tokens":1,
                    "total_tokens":11
                }
            })
            .as_object()
            .unwrap(),
            None,
        )
        .unwrap();
        assert!(no_cost_usage.get("cost").is_none());
    }

    #[test]
    fn rewrite_and_sse_helpers_cover_alias_and_done_cases() {
        let entry = test_catalog().entries["GPT-4.1"].clone();
        let mut payload = json!({
            "model":"openai/gpt-4.1",
            "usage":{
                "prompt_tokens":1000,
                "completion_tokens":10,
                "prompt_tokens_details":{"cached_read_tokens":800}
            }
        });
        rewrite_chat_completion_value(&mut payload, &entry, None);
        assert_eq!(payload["model"], json!("GPT-4.1"));
        assert_eq!(payload["usage"]["cost"], json!(0.00088));
        let mut non_object = json!(["ignore"]);
        rewrite_chat_completion_value(&mut non_object, &entry, None);
        assert_eq!(non_object, json!(["ignore"]));

        let transformed = transform_bifrost_sse_line(
            r#"data: {"model":"openai/gpt-4.1","usage":{"prompt_tokens":1000,"completion_tokens":10,"prompt_tokens_details":{"cached_read_tokens":800}}}"#,
            &entry,
            Some(0.77),
        )
        .unwrap();
        let transformed_text = String::from_utf8(transformed.to_vec()).unwrap();
        assert!(transformed_text.contains("\"model\":\"GPT-4.1\""));
        assert!(transformed_text.contains("\"cost\":0.77"));
        assert_eq!(
            String::from_utf8(
                transform_bifrost_sse_line("data: [DONE]", &entry, None)
                    .unwrap()
                    .to_vec()
            )
            .unwrap(),
            "data: [DONE]\n"
        );
        assert_eq!(
            String::from_utf8(
                transform_bifrost_sse_line("", &entry, None)
                    .unwrap()
                    .to_vec()
            )
            .unwrap(),
            "\n"
        );
        assert_eq!(
            String::from_utf8(
                transform_bifrost_sse_line(":comment", &entry, None)
                    .unwrap()
                    .to_vec()
            )
            .unwrap(),
            ":comment\n"
        );
        assert!(transform_bifrost_sse_line("data: {", &entry, None).is_err());
        assert_eq!(
            String::from_utf8(
                transform_bifrost_sse_line("data: []", &entry, None)
                    .unwrap()
                    .to_vec()
            )
            .unwrap(),
            "data: []\n"
        );

        assert_eq!(
            String::from_utf8(sse_done_bytes().to_vec()).unwrap(),
            "data: [DONE]\n\n"
        );
        assert!(
            String::from_utf8(sse_data_bytes(&json!({"ok":true})).to_vec())
                .unwrap()
                .contains("\"ok\":true")
        );
        assert!(
            String::from_utf8(sse_bytes("event", &json!({"ok":true})).to_vec())
                .unwrap()
                .contains("event: event")
        );
        assert!(openai_stream_chunk_has_terminal_reason(
            br#"data: {"choices":[{"finish_reason":"stop"}]}"#
        ));
        assert!(openai_stream_chunk_has_terminal_reason(
            br#"data: {"error":{"message":"failed"}}"#
        ));
        assert!(!openai_stream_chunk_has_terminal_reason(
            br#"data: {"choices":[{"finish_reason":null,"delta":{"content":"partial"}}]}"#
        ));
    }

    #[test]
    fn utf8_line_buffer_handles_split_multibyte_and_invalid_eof_cases() {
        let mut buffer = Utf8LineBuffer::default();
        buffer.push_chunk(b"data: {\"delta\":\"caf\xc3");
        assert!(buffer.drain_complete_lines().unwrap().is_empty());

        buffer.push_chunk(b"\xa9\"}\r\n\r\n");
        let lines = buffer.drain_complete_lines().unwrap();
        assert_eq!(
            lines,
            vec![r#"data: {"delta":"café"}"#.to_string(), String::new()]
        );
        assert!(buffer.finish().unwrap().is_none());

        let mut invalid = Utf8LineBuffer::default();
        invalid.push_chunk(b"data: \xff\n");
        assert!(invalid
            .drain_complete_lines()
            .unwrap_err()
            .to_string()
            .contains("invalid UTF-8"));

        let mut incomplete = Utf8LineBuffer::default();
        incomplete.push_chunk(b"data: {\"delta\":\"caf\xc3");
        assert!(incomplete
            .finish()
            .unwrap_err()
            .to_string()
            .contains("invalid UTF-8"));
    }

    #[test]
    fn responses_conversion_helpers_cover_tool_and_usage_variants() {
        let entry = test_catalog().entries["GPT-5.4 pro"].clone();
        assert!(should_use_responses_api(&entry));
        assert!(should_use_responses_api(&test_catalog().entries["GPT-5.5"]));
        assert!(should_use_responses_api(&test_catalog().entries["GPT-5.4"]));
        assert!(!should_use_responses_api(
            &test_catalog().entries["GPT-4.1"]
        ));

        let payload = chat_completion_to_responses_payload(
            &json!({
                "model":"GPT-5.4 pro",
                "messages":[{"role":"user","content":"hello"}],
                "max_tokens":32,
                "tools":[{"type":"function","function":{"name":"lookup","description":"Lookup","parameters":{"type":"object"},"strict":true}}],
                "tool_choice":{"type":"function","function":{"name":"lookup"}},
                "stream_options":{"include_usage":true},
                "n": 2
            }),
            &entry,
        )
        .unwrap();
        assert_eq!(payload["model"], json!("gpt-5.4-pro-2026-03-05"));
        assert!(payload.get("instructions").is_none());
        assert_eq!(payload["input"][0]["content"], json!("hello"));
        assert_eq!(payload["max_output_tokens"], json!(32));
        assert_eq!(payload["tools"][0]["name"], json!("lookup"));
        assert_eq!(payload["tool_choice"]["name"], json!("lookup"));
        assert!(payload.get("stream_options").is_none());
        assert!(payload.get("n").is_none());

        let multimodal_payload = chat_completion_to_responses_payload(
            &json!({
                "model":"GPT-5.4 pro",
                "messages":[{
                    "role":"user",
                    "content":[
                        {"type":"text","text":"Inspect these slides."},
                        {"type":"image_url","image_url":{"url": format!("data:image/png;base64,{JPEG_BASE64}")}},
                        {"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":PNG_BASE64}}
                    ]
                }]
            }),
            &entry,
        )
        .unwrap();
        assert_eq!(
            multimodal_payload["input"],
            json!([{
                "role":"user",
                "content":[
                    {"type":"input_text","text":"Inspect these slides."},
                    {"type":"input_image","image_url": format!("data:image/jpeg;base64,{JPEG_BASE64}")},
                    {"type":"input_image","image_url": format!("data:image/png;base64,{PNG_BASE64}")}
                ]
            }])
        );
        let unsupported_image_error = chat_completion_to_responses_payload(
            &json!({
                "model":"GPT-5.4 pro",
                "messages":[{
                    "role":"user",
                    "content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,YWJj"}}]
                }]
            }),
            &entry,
        )
        .unwrap_err()
        .to_string();
        assert!(unsupported_image_error.contains("unsupported image bytes"));

        let gpt54_entry = test_catalog().entries["GPT-5.4"].clone();
        let mut body = json!({
            "model":"GPT-5.4",
            "messages":[
                {"role":"system","content":"<static_context>Static guidance</static_context>"},
                {"role":"system","content":"<dynamic_context>Now is 12:34</dynamic_context>"},
                {"role":"user","content":"What can you do?"}
            ],
            "chat_id":"chat-123"
        });
        apply_prompt_cache_and_reasoning(&mut body, &gpt54_entry, true, Some("chat-123"));
        let hoisted_payload = chat_completion_to_responses_payload(&body, &gpt54_entry).unwrap();
        assert_eq!(
            hoisted_payload["instructions"],
            json!(
                "<static_context>Static guidance</static_context>\n\n<dynamic_context>Now is 12:34</dynamic_context>"
            )
        );
        assert_eq!(
            hoisted_payload["input"],
            json!([{"role":"user","content":"What can you do?"}])
        );

        let tool_followup_payload = chat_completion_to_responses_payload(
            &json!({
                "model":"GPT-5.4 pro",
                "messages":[
                    {"role":"user","content":"hello"},
                    {
                        "role":"assistant",
                        "content":"Checking calendar",
                        "tool_calls":[
                            {
                                "id":"call_1",
                                "type":"function",
                                "function":{
                                    "name":"lookup",
                                    "arguments":{"q":"rust"}
                                }
                            }
                        ]
                    },
                    {"role":"tool","tool_call_id":"call_1","content":{"ok":true}}
                ]
            }),
            &entry,
        )
        .unwrap();
        assert_eq!(
            tool_followup_payload["input"],
            json!([
                {"role":"user","content":"hello"},
                {"role":"assistant","content":"Checking calendar"},
                {"type":"function_call","call_id":"call_1","name":"lookup","arguments":"{\"q\":\"rust\"}"},
                {"type":"function_call_output","call_id":"call_1","output":"{\"ok\":true}"}
            ])
        );

        let legacy_function_call_payload = chat_completion_to_responses_payload(
            &json!({
                "model":"GPT-5.4 pro",
                "messages":[
                    {
                        "role":"assistant",
                        "content":"Calling lookup",
                        "function_call":{
                            "call_id":"call_legacy",
                            "name":"lookup",
                            "arguments":{"q":"rust"}
                        }
                    }
                ]
            }),
            &entry,
        )
        .unwrap();
        assert_eq!(
            legacy_function_call_payload["input"],
            json!([
                {"role":"assistant","content":"Calling lookup"},
                {"type":"function_call","call_id":"call_legacy","name":"lookup","arguments":"{\"q\":\"rust\"}"}
            ])
        );

        let missing_tool_call_id_error = chat_completion_to_responses_payload(
            &json!({
                "model":"GPT-5.4 pro",
                "messages":[{"role":"tool","content":"missing"}]
            }),
            &entry,
        )
        .unwrap_err();
        assert!(missing_tool_call_id_error
            .to_string()
            .contains("tool_call_id"));

        assert!(chat_completion_to_responses_payload(&json!(null), &entry).is_err());
        assert!(chat_completion_to_responses_payload(&json!({}), &entry).is_err());

        let passthrough_tool = chat_tools_to_responses_tools(json!(["noop"]), None);
        assert_eq!(passthrough_tool, json!(["noop"]));
        assert_eq!(
            chat_tool_choice_to_responses_tool_choice(
                json!({"type":"function","function":{"name":"tool"}})
            ),
            json!({"type":"function","name":"tool"})
        );
        assert_eq!(
            chat_tool_choice_to_responses_tool_choice(json!("auto")),
            json!("auto")
        );
        assert_eq!(
            chat_tools_to_responses_tools(json!({"tools":[] }), None),
            json!({"tools":[] })
        );
        assert_eq!(
            chat_tools_to_responses_tools(json!([{"type":"not-function"}]), None),
            json!([{"type":"not-function"}])
        );
        assert_eq!(
            chat_tools_to_responses_tools(json!([{"type":"function"}]), None),
            json!([{"type":"function"}])
        );
        assert_eq!(
            chat_tools_to_responses_tools(
                json!([{"type":"function","function":{"name":"lookup"}}]),
                None
            ),
            json!([{"type":"function","name":"lookup","description":null,"parameters":{},"strict":null}])
        );
        assert_eq!(
            chat_tool_choice_to_responses_tool_choice(json!({"type":"auto"})),
            json!({"type":"auto"})
        );
        assert_eq!(
            chat_tool_choice_to_responses_tool_choice(json!({"type":"function"})),
            json!({"type":"function"})
        );

        // No namespace metadata — tools pass through as flat functions
        let tools_no_ns = chat_tools_to_responses_tools(
            json!([{"type":"function","function":{"name":"search","description":"Search","parameters":{"type":"object"}}}]),
            None,
        );
        assert_eq!(tools_no_ns.as_array().unwrap().len(), 1);
        assert!(tools_no_ns[0].get("defer_loading").is_none());

        // Namespace metadata — group tools by MCP server prefix
        let tools_ns = chat_tools_to_responses_tools(
            json!([
                {"type":"function","function":{"name":"glean_search","description":"Search KB","parameters":{"type":"object"}}},
                {"type":"function","function":{"name":"glean_chat","description":"Chat with KB","parameters":{"type":"object"}}},
                {"type":"function","function":{"name":"slack_post_message","description":"Post msg","parameters":{"type":"object"}}},
                {"type":"function","function":{"name":"skills_activate","description":"Activate","parameters":{"type":"object"}}}
            ]),
            Some(json!({
                "glean": {"description":"Internal knowledge base","server_id":"glean","is_core":false},
                "skills": {"description":"Skills","server_id":"skills","is_core":true},
                "slack": {"description":"Team messaging","server_id":"slack","is_core":false}
            })),
        );
        let ns_arr = tools_ns.as_array().unwrap();
        // Should have: glean namespace, slack namespace, skills flat (core eager), tool_search
        assert_eq!(ns_arr.len(), 4);
        // glean namespace (no defer_loading on namespace — it goes on individual tools)
        assert_eq!(ns_arr[0]["type"], json!("namespace"));
        assert_eq!(ns_arr[0]["name"], json!("glean"));
        assert!(ns_arr[0].get("defer_loading").is_none());
        assert_eq!(ns_arr[0]["description"], json!("Internal knowledge base"));
        let glean_tools = ns_arr[0]["tools"].as_array().unwrap();
        assert_eq!(glean_tools.len(), 2);
        assert_eq!(glean_tools[0]["name"], json!("search"));
        assert_eq!(glean_tools[0]["defer_loading"], json!(true));
        assert_eq!(glean_tools[1]["name"], json!("chat"));
        assert_eq!(glean_tools[1]["defer_loading"], json!(true));
        // slack namespace
        assert_eq!(ns_arr[1]["type"], json!("namespace"));
        assert_eq!(ns_arr[1]["name"], json!("slack"));
        let slack_tools = ns_arr[1]["tools"].as_array().unwrap();
        assert_eq!(slack_tools.len(), 1);
        assert_eq!(slack_tools[0]["name"], json!("post_message"));
        // skills unmatched — flat function, no defer_loading
        assert_eq!(ns_arr[2]["type"], json!("function"));
        assert_eq!(ns_arr[2]["name"], json!("skills_activate"));
        assert!(ns_arr[2].get("defer_loading").is_none());
        // tool_search entry appended when namespaces are present
        assert_eq!(ns_arr[3]["type"], json!("tool_search"));

        // Prefix ambiguity: longer prefix wins
        let tools_ambig = chat_tools_to_responses_tools(
            json!([
                {"type":"function","function":{"name":"data_plat_mcp_search","description":"Search","parameters":{"type":"object"}}},
                {"type":"function","function":{"name":"data_plat_query","description":"Query","parameters":{"type":"object"}}}
            ]),
            Some(json!({"data_plat_mcp": "Data Platform", "data_plat": "Other"})),
        );
        let ambig_arr = tools_ambig.as_array().unwrap();
        let dpm_ns = ambig_arr
            .iter()
            .find(|t| t["name"] == json!("data_plat_mcp"))
            .unwrap();
        assert_eq!(dpm_ns["tools"][0]["name"], json!("search"));
        let dp_ns = ambig_arr
            .iter()
            .find(|t| t["name"] == json!("data_plat"))
            .unwrap();
        assert_eq!(dp_ns["tools"][0]["name"], json!("query"));

        // Response: namespace name reconstruction
        let ns_response = json!({
            "output":[
                {"type":"function_call","call_id":"call_1","name":"search","namespace":"glean","arguments":"{\"q\":\"test\"}"}
            ]
        });
        let ns_resp_obj = ns_response.as_object().unwrap();
        let (_, ns_tool_calls, _) = response_message_and_tool_calls(ns_resp_obj);
        assert_eq!(ns_tool_calls[0]["function"]["name"], json!("glean_search"));

        // Response: no namespace field — name passes through
        let plain_response = json!({
            "output":[
                {"type":"function_call","call_id":"call_2","name":"skills_activate","arguments":"{}"}
            ]
        });
        let plain_resp_obj = plain_response.as_object().unwrap();
        let (_, plain_tool_calls, _) = response_message_and_tool_calls(plain_resp_obj);
        assert_eq!(
            plain_tool_calls[0]["function"]["name"],
            json!("skills_activate")
        );

        let response_value = json!({
            "id":"resp_1",
            "created_at": 123,
            "output":[
                {"type":"message","content":[{"type":"output_text","text":"hello"}]},
                {"type":"function_call","id":"fc_1","call_id":"call_1","name":"lookup","arguments":"{\"q\":\"rust\"}"}
            ],
            "usage":{
                "input_tokens":100,
                "input_tokens_details":{"cached_read_tokens":80,"cached_write_tokens":4},
                "output_tokens":5,
                "output_tokens_details":{"reasoning_tokens":2},
                "total_tokens":105
            },
            "extra_fields":{"provider":"openai"},
            "incomplete_details":{"reason":"tool_calls"}
        });
        let chat = responses_value_to_chat_completion(response_value, &entry, Some(0.5));
        assert_eq!(chat["model"], json!("GPT-5.4 pro"));
        assert_eq!(chat["choices"][0]["finish_reason"], json!("tool_calls"));
        assert_eq!(
            chat["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
            json!("lookup")
        );
        assert_eq!(chat["usage"]["cost"], json!(0.5));

        let (content, tool_calls, _) = response_message_and_tool_calls(
            json!({
                "output":[
                    {"type":"message","content":[{"type":"output_text","text":"a"},{"type":"text","text":"b"},{"type":"input_text","text":"c"}]}
                ]
            })
            .as_object()
            .unwrap(),
        );
        assert_eq!(content, "abc");
        assert!(tool_calls.is_empty());

        assert_eq!(
            response_finish_reason(
                &json!({"incomplete_details":{"reason":"max_output_tokens"}})
                    .as_object()
                    .unwrap(),
                &[]
            ),
            "length"
        );
        assert_eq!(
            response_finish_reason(
                &json!({"incomplete_details":{"reason":"tool_calls"}})
                    .as_object()
                    .unwrap(),
                &[]
            ),
            "tool_calls"
        );
        assert_eq!(
            response_finish_reason(
                &json!({"incomplete_details":{"reason":"content_filter"}})
                    .as_object()
                    .unwrap(),
                &[]
            ),
            "content_filter"
        );
        assert_eq!(
            response_finish_reason(
                &json!({"incomplete_details":{"reason":"custom"}})
                    .as_object()
                    .unwrap(),
                &[]
            ),
            "custom"
        );
        assert_eq!(
            response_finish_reason(&json!({}).as_object().unwrap(), &[json!({"tool":"x"})]),
            "tool_calls"
        );
        assert_eq!(
            response_usage_to_chat_usage(&json!({
                "input_tokens":10,
                "input_tokens_details":{"cached_tokens":4},
                "output_tokens":5,
                "output_tokens_details":{"reasoning_tokens":2},
                "total_tokens":15
            })),
            json!({
                "prompt_tokens":10,
                "completion_tokens":5,
                "total_tokens":15,
                "prompt_tokens_details":{
                    "cached_tokens":4,
                    "cached_read_tokens":0,
                    "cached_write_tokens":0
                },
                "completion_tokens_details":{"reasoning_tokens":2}
            })
        );
        assert_eq!(
            response_usage_to_chat_usage(&json!({
                "input_tokens":10,
                "input_tokens_details":{"cached_tokens":84,"cached_read_tokens":80,"cached_write_tokens":4},
                "output_tokens":5,
                "output_tokens_details":{"reasoning_tokens":2},
                "total_tokens":15
            })),
            json!({
                "prompt_tokens":10,
                "completion_tokens":5,
                "total_tokens":15,
                "prompt_tokens_details":{
                    "cached_tokens":80,
                    "cached_read_tokens":80,
                    "cached_write_tokens":4
                },
                "completion_tokens_details":{"reasoning_tokens":2}
            })
        );
        assert_eq!(
            response_usage_to_chat_usage(&json!({
                "input_tokens":10,
                "input_tokens_details":{"cached_tokens":4,"cached_write_tokens":4},
                "output_tokens":5,
                "output_tokens_details":{"reasoning_tokens":2},
                "total_tokens":15
            })),
            json!({
                "prompt_tokens":10,
                "completion_tokens":5,
                "total_tokens":15,
                "prompt_tokens_details":{
                    "cached_tokens":0,
                    "cached_read_tokens":0,
                    "cached_write_tokens":4
                },
                "completion_tokens_details":{"reasoning_tokens":2}
            })
        );
        assert_eq!(response_id(&json!({}).as_object().unwrap()), "resp_unknown");
        assert_eq!(response_created(&json!({}).as_object().unwrap()), 0);

        let tool_only = responses_value_to_chat_completion(
            json!({
                "output":[{"type":"function_call","name":"lookup","arguments":{"q":"rust"}}]
            }),
            &entry,
            None,
        );
        assert!(tool_only["choices"][0]["message"]["content"].is_null());

        let no_usage = responses_value_to_chat_completion(json!({"id":"resp_2"}), &entry, None);
        assert!(no_usage.get("usage").is_none());

        let empty = response_message_and_tool_calls(&json!({}).as_object().unwrap().clone());
        assert!(empty.0.is_empty());
        assert!(empty.1.is_empty());
        assert!(empty.2.is_empty());
        let mixed = response_message_and_tool_calls(
            json!({
                "output":[
                    {"type":"message"},
                    {"type":"message","content":[{"type":"output_text"},{"type":"other","text":"skip"}]},
                    {"type":"function_call","name":"lookup","arguments":{"q":"rust"}},
                    {"type":"function_call","name":"lookup"},
                    {"type":"ignored"}
                ]
            })
            .as_object()
            .unwrap(),
        );
        assert_eq!(mixed.1.len(), 2);
        assert_eq!(
            mixed.1[0]["function"]["arguments"],
            json!(r#"{"q":"rust"}"#)
        );
        assert_eq!(mixed.1[1]["function"]["arguments"], json!(""));
        assert_eq!(
            response_finish_reason(&json!({"incomplete_details":{}}).as_object().unwrap(), &[]),
            "stop"
        );

        // Input conversion with namespaces: follow-up turn strips prefix + adds namespace
        let ns_followup = chat_completion_to_responses_payload(
            &json!({
                "model":"GPT-5.4 pro",
                "_tool_namespaces": {
                    "glean": {"description":"KB","server_id":"glean","is_core":false},
                    "slack": {"description":"Messaging","server_id":"slack","is_core":false}
                },
                "messages":[
                    {"role":"user","content":"search KB"},
                    {
                        "role":"assistant",
                        "content":"Searching…",
                        "tool_calls":[{
                            "id":"call_ns1",
                            "type":"function",
                            "function":{"name":"glean_search","arguments":"{\"q\":\"test\"}"}
                        }]
                    },
                    {"role":"tool","tool_call_id":"call_ns1","content":"result"},
                    {"role":"user","content":"now post it"},
                    {
                        "role":"assistant",
                        "content":null,
                        "tool_calls":[{
                            "id":"call_ns2",
                            "type":"function",
                            "function":{"name":"slack_post_message","arguments":"{\"msg\":\"hi\"}"}
                        }]
                    },
                    {"role":"tool","tool_call_id":"call_ns2","content":"sent"}
                ],
                "tools":[
                    {"type":"function","function":{"name":"glean_search","description":"S","parameters":{"type":"object"}}},
                    {"type":"function","function":{"name":"slack_post_message","description":"P","parameters":{"type":"object"}}},
                    {"type":"function","function":{"name":"skills_activate","description":"A","parameters":{"type":"object"}}}
                ]
            }),
            &entry,
        )
        .unwrap();
        // glean_search → name="search", namespace="glean"
        let fc1 = &ns_followup["input"][2];
        assert_eq!(fc1["type"], json!("function_call"));
        assert_eq!(fc1["name"], json!("search"));
        assert_eq!(fc1["namespace"], json!("glean"));
        assert_eq!(fc1["call_id"], json!("call_ns1"));
        // slack_post_message → name="post_message", namespace="slack"
        let fc2 = &ns_followup["input"][5];
        assert_eq!(fc2["type"], json!("function_call"));
        assert_eq!(fc2["name"], json!("post_message"));
        assert_eq!(fc2["namespace"], json!("slack"));
        // Unmatched tool (skills_activate) in tool defs — not in messages here, but
        // verify tools were namespaced correctly too
        let ns_tools = ns_followup["tools"].as_array().unwrap();
        let glean_ns = ns_tools
            .iter()
            .find(|t| t["name"] == json!("glean"))
            .unwrap();
        assert_eq!(glean_ns["tools"][0]["name"], json!("search"));
        assert_eq!(glean_ns["tools"][0]["defer_loading"], json!(true));
        assert!(glean_ns.get("defer_loading").is_none());
        // tool_search is a tools array entry, not a top-level field
        assert!(ns_followup.get("tool_search").is_none());
        assert!(ns_tools.iter().any(|t| t["type"] == json!("tool_search")));

        // No namespaces — function_call items pass through unchanged (no namespace field)
        let no_ns_followup = chat_completion_to_responses_payload(
            &json!({
                "model":"GPT-5.4 pro",
                "messages":[
                    {"role":"user","content":"hi"},
                    {
                        "role":"assistant",
                        "content":null,
                        "tool_calls":[{
                            "id":"call_plain",
                            "type":"function",
                            "function":{"name":"lookup","arguments":"{}"}
                        }]
                    },
                    {"role":"tool","tool_call_id":"call_plain","content":"ok"}
                ]
            }),
            &entry,
        )
        .unwrap();
        let fc_plain = &no_ns_followup["input"][1];
        assert_eq!(fc_plain["name"], json!("lookup"));
        assert!(fc_plain.get("namespace").is_none());
        // No namespaces → no tool_search
        assert!(no_ns_followup.get("tool_search").is_none());

        // Round-trip: response reconstructs prefix, next turn input strips it back
        let turn1_response = json!({
            "output":[
                {"type":"function_call","call_id":"call_rt","name":"search","namespace":"glean","arguments":"{\"q\":\"hi\"}"}
            ]
        });
        let (_, rt_tool_calls, _) =
            response_message_and_tool_calls(turn1_response.as_object().unwrap());
        assert_eq!(rt_tool_calls[0]["function"]["name"], json!("glean_search"));
        // Now feed that reconstructed name back as turn-2 history
        let turn2 = chat_completion_to_responses_payload(
            &json!({
                "model":"GPT-5.4 pro",
                "_tool_namespaces": {"glean": {"description":"KB","server_id":"glean","is_core":false}},
                "messages":[
                    {"role":"user","content":"find info"},
                    {
                        "role":"assistant",
                        "content":null,
                        "tool_calls":[{
                            "id": rt_tool_calls[0]["id"],
                            "type":"function",
                            "function": rt_tool_calls[0]["function"]
                        }]
                    },
                    {"role":"tool","tool_call_id":"call_rt","content":"data"}
                ],
                "tools":[
                    {"type":"function","function":{"name":"glean_search","description":"S","parameters":{"type":"object"}}}
                ]
            }),
            &entry,
        )
        .unwrap();
        let rt_fc = &turn2["input"][1];
        assert_eq!(rt_fc["name"], json!("search"));
        assert_eq!(rt_fc["namespace"], json!("glean"));

        let core_followup = chat_completion_to_responses_payload(
            &json!({
                "model":"GPT-5.4 pro",
                "_tool_namespaces": {
                    "mcp_assistant": {
                        "description":"Core orchestration",
                        "server_id":"mcp-assistant",
                        "is_core": true
                    }
                },
                "messages":[
                    {"role":"user","content":"toggle it"},
                    {
                        "role":"assistant",
                        "content":null,
                        "tool_calls":[{
                            "id":"call_core",
                            "type":"function",
                            "function":{"name":"mcp_assistant_toggle_integration","arguments":"{}"}
                        }]
                    },
                    {"role":"tool","tool_call_id":"call_core","content":"ok"}
                ],
                "tools":[
                    {"type":"function","function":{"name":"mcp_assistant_toggle_integration","description":"Toggle","parameters":{"type":"object"}}}
                ]
            }),
            &entry,
        )
        .unwrap();
        let core_fc = &core_followup["input"][1];
        assert_eq!(core_fc["name"], json!("mcp_assistant_toggle_integration"));
        assert!(core_fc.get("namespace").is_none());
        assert_eq!(
            core_followup["tools"],
            json!([{
                "type":"function",
                "name":"mcp_assistant_toggle_integration",
                "description":"Toggle",
                "parameters":{"type":"object"},
                "strict":null
            }])
        );
    }

    #[tokio::test]
    async fn chat_completion_handler_retries_transient_gateway_errors_before_streaming() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let attempts_clone = Arc::clone(&attempts);
        let bifrost_server = start_server(
            Router::new().route(
                "/v1/chat/completions",
                any(move || {
                    let attempts = Arc::clone(&attempts_clone);
                    async move {
                        let attempt = attempts.fetch_add(1, Ordering::SeqCst) + 1;
                        if attempt < 3 {
                            let mut response = Response::new(Body::from(
                                r#"{"is_bifrost_error":false,"status_code":502,"error":{"type":"api_error","message":"error sending request for url (https://llm-proxysandbox.example.invalid/bedrock/converse)"},"extra_fields":{"provider":"anthropic","model_requested":"us.anthropic.claude-sonnet-4-5-20250929-v1:0","request_type":"chat_completion_stream"}}"#,
                            ));
                            *response.status_mut() = StatusCode::BAD_GATEWAY;
                            response.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
                            response.headers_mut().insert("retry-after", HeaderValue::from_static("0"));
                            return response;
                        }

                        let mut response = Response::new(Body::from(
                            "data: {\"id\":\"chatcmpl_retry\",\"model\":\"anthropic/us.anthropic.claude-sonnet-4-5-20250929-v1:0\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":null}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":2,\"total_tokens\":12}}\n\ndata: [DONE]\n\n",
                        ));
                        response.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
                        response
                    }
                }),
            ),
        )
        .await;

        let response = chat_completions(
            State(test_state(&bifrost_server.base_url, "http://unused")),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"Claude Sonnet 4.5",
                    "messages":[{"role":"user","content":"hi"}],
                    "stream": true
                }))
                .unwrap(),
            ),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_text(response).await;
        assert!(body.contains("\"model\":\"Claude Sonnet 4.5\""));
        assert!(body.contains("data: [DONE]"));
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn chat_completion_handler_preserves_retry_after_on_exhausted_rate_limit() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let attempts_clone = Arc::clone(&attempts);
        let bifrost_server = start_server(Router::new().route(
            "/v1/chat/completions",
            any(move || {
                let attempts = Arc::clone(&attempts_clone);
                async move {
                    attempts.fetch_add(1, Ordering::SeqCst);
                    let mut response = Response::new(Body::from(
                        r#"{"error":{"type":"rate_limit_error","message":"provider rate limit"}}"#,
                    ));
                    *response.status_mut() = StatusCode::TOO_MANY_REQUESTS;
                    response
                        .headers_mut()
                        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
                    response
                        .headers_mut()
                        .insert("retry-after", HeaderValue::from_static("0"));
                    response
                        .headers_mut()
                        .insert("x-request-id", HeaderValue::from_static("req_retry"));
                    response
                }
            }),
        ))
        .await;

        let response = chat_completions(
            State(test_state(&bifrost_server.base_url, "http://unused")),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"Claude Sonnet 4.5",
                    "messages":[{"role":"user","content":"hi"}]
                }))
                .unwrap(),
            ),
        )
        .await;
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.headers().get("retry-after").unwrap(), "0");
        assert_eq!(response.headers().get("x-request-id").unwrap(), "req_retry");
        let body = response_json(response).await;
        assert_eq!(
            body["error"]["message"],
            json!("Upstream model provider is temporarily rate limited. Please retry.")
        );
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            upstream_retry_max_attempts() as usize
        );
    }

    #[tokio::test]
    async fn chat_completion_handler_cleans_retry_exhausted_transient_gateway_errors() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let attempts_clone = Arc::clone(&attempts);
        let bifrost_server = start_server(
            Router::new().route(
                "/v1/chat/completions",
                any(move || {
                    let attempts = Arc::clone(&attempts_clone);
                    async move {
                        attempts.fetch_add(1, Ordering::SeqCst);
                        let mut response = Response::new(Body::from(
                            r#"{"is_bifrost_error":false,"status_code":502,"error":{"type":"api_error","message":"error sending request for url (https://llm-proxysandbox.example.invalid/bedrock/converse)"},"extra_fields":{"provider":"anthropic","model_requested":"us.anthropic.claude-opus-4-6-v1","request_type":"chat_completion_stream"}}"#,
                        ));
                        *response.status_mut() = StatusCode::BAD_GATEWAY;
                        response.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
                        response.headers_mut().insert("retry-after", HeaderValue::from_static("0"));
                        response
                    }
                }),
            ),
        )
        .await;

        let response = chat_completions(
            State(test_state(&bifrost_server.base_url, "http://unused")),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"Claude Sonnet 4.5",
                    "messages":[{"role":"user","content":"hi"}],
                    "stream": true
                }))
                .unwrap(),
            ),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let body = response_json(response).await;
        let message = body["error"]["message"].as_str().unwrap();
        assert_eq!(
            message,
            "Upstream model provider is temporarily unavailable. Please retry."
        );
        assert!(!message.contains("llm-proxy"));
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            upstream_retry_max_attempts() as usize
        );
    }

    #[tokio::test]
    async fn chat_completion_handler_does_not_retry_non_retryable_client_errors() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let attempts_clone = Arc::clone(&attempts);
        let bifrost_server = start_server(Router::new().route(
            "/v1/chat/completions",
            any(move || {
                let attempts = Arc::clone(&attempts_clone);
                async move {
                    attempts.fetch_add(1, Ordering::SeqCst);
                    let mut response =
                        Response::new(Body::from(r#"{"error":{"message":"Bad tool payload"}}"#));
                    *response.status_mut() = StatusCode::BAD_REQUEST;
                    response
                        .headers_mut()
                        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
                    response
                }
            }),
        ))
        .await;

        let response = chat_completions(
            State(test_state(&bifrost_server.base_url, "http://unused")),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"Claude Sonnet 4.5",
                    "messages":[{"role":"user","content":"hi"}]
                }))
                .unwrap(),
            ),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = response_json(response).await;
        assert_eq!(body["error"]["message"], json!("Bad tool payload"));
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn anthropic_messages_handler_retries_transient_bedrock_errors_before_succeeding() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let attempts_clone = Arc::clone(&attempts);
        let llm_proxy = start_server(
            Router::new().route(
                "/bedrock/converse",
                any(move || {
                    let attempts = Arc::clone(&attempts_clone);
                    async move {
                        let attempt = attempts.fetch_add(1, Ordering::SeqCst) + 1;
                        if attempt < 3 {
                            let mut response = Response::new(Body::from(
                                r#"{"error":{"type":"api_error","message":"error sending request for url (https://llm-proxysandbox.example.invalid/bedrock/converse)"}}"#,
                            ));
                            *response.status_mut() = StatusCode::BAD_GATEWAY;
                            response.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
                            response.headers_mut().insert("retry-after", HeaderValue::from_static("0"));
                            return response;
                        }

                        let mut response = Response::new(Body::from(
                            r#"{"output":{"message":{"content":[{"text":"ok"}]}},"usage":{"inputTokens":10,"outputTokens":5},"stopReason":"end_turn"}"#,
                        ));
                        response.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
                        response
                    }
                }),
            ),
        )
        .await;

        let response = anthropic_messages(
            State(test_state("http://unused", &llm_proxy.base_url)),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"Claude Sonnet 4.5",
                    "messages":[{"role":"user","content":"hi"}]
                }))
                .unwrap(),
            ),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["model"], json!("Claude Sonnet 4.5"));
        assert_eq!(body["content"][0]["text"], json!("ok"));
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn responses_reasoning_marker_and_thinking_interval_protocol() {
        let entry = test_catalog().entries["GPT-5.4 pro"].clone();

        // Indicator enabled: response.created emits role + marker chunks once.
        let mut state = ResponsesStreamState {
            reasoning_indicator_enabled: true,
            ..ResponsesStreamState::default()
        };
        let marker_chunks = transform_bifrost_responses_event(
            "response.created",
            &json!({"response":{"id":"resp_1","created_at":123}}),
            &entry,
            None,
            &mut state,
        )
        .unwrap();
        assert_eq!(marker_chunks.len(), 2);
        let marker_text = String::from_utf8(marker_chunks[1].to_vec()).unwrap();
        assert!(
            marker_text.contains("\"reasoning_status\":\"started\""),
            "{marker_text}"
        );
        assert!(state.reasoning_started_at_ms.is_some());

        // Later lifecycle events do not re-emit the marker.
        assert!(transform_bifrost_responses_event(
            "response.in_progress",
            &json!({"response":{"id":"resp_1","created_at":456}}),
            &entry,
            None,
            &mut state,
        )
        .unwrap()
        .is_empty());

        // First reasoning delta carries the measured interval; later ones don't.
        state.reasoning_started_at_ms = Some(state.reasoning_started_at_ms.unwrap() - 1_500);
        let first = transform_bifrost_responses_event(
            "response.reasoning_summary_text.delta",
            &json!({"delta":"pondering"}),
            &entry,
            None,
            &mut state,
        )
        .unwrap();
        assert_eq!(first.len(), 1);
        let first_text = String::from_utf8(first[0].to_vec()).unwrap();
        assert!(first_text.contains("reasoning_thinking_ms"), "{first_text}");
        let parsed: Value =
            serde_json::from_str(first_text.trim_start_matches("data: ").trim()).unwrap();
        let thinking_ms = parsed
            .pointer("/choices/0/delta/reasoning_thinking_ms")
            .and_then(Value::as_u64)
            .unwrap();
        assert!(thinking_ms >= 1_500, "thinking_ms={thinking_ms}");

        let second = transform_bifrost_responses_event(
            "response.reasoning_summary_text.delta",
            &json!({"delta":"more"}),
            &entry,
            None,
            &mut state,
        )
        .unwrap();
        assert!(!String::from_utf8(second[0].to_vec())
            .unwrap()
            .contains("reasoning_thinking_ms"));

        // Indicator disabled (reasoning effort absent/none): no marker, no interval.
        let mut disabled = ResponsesStreamState::default();
        assert!(transform_bifrost_responses_event(
            "response.created",
            &json!({"response":{"id":"resp_2","created_at":1}}),
            &entry,
            None,
            &mut disabled,
        )
        .unwrap()
        .is_empty());
        let plain = transform_bifrost_responses_event(
            "response.reasoning_summary_text.delta",
            &json!({"delta":"quiet"}),
            &entry,
            None,
            &mut disabled,
        )
        .unwrap();
        assert!(!String::from_utf8(plain.last().unwrap().to_vec())
            .unwrap()
            .contains("reasoning_thinking_ms"));

        // Synthesized-at-completion reasoning also carries the interval.
        let mut synth = ResponsesStreamState {
            reasoning_indicator_enabled: true,
            ..ResponsesStreamState::default()
        };
        transform_bifrost_responses_event(
            "response.created",
            &json!({"response":{"id":"resp_3","created_at":9}}),
            &entry,
            None,
            &mut synth,
        )
        .unwrap();
        let completed = transform_bifrost_responses_event(
            "response.completed",
            &json!({
                "response": {
                    "id": "resp_3",
                    "created_at": 9,
                    "output": [
                        {"type":"reasoning","summary":[{"type":"summary_text","text":"synth summary"}]},
                        {"type":"message","content":[{"type":"output_text","text":"answer"}]}
                    ],
                    "usage": {"input_tokens": 5, "output_tokens": 2, "total_tokens": 7}
                }
            }),
            &entry,
            None,
            &mut synth,
        )
        .unwrap();
        let completed_text: String = completed
            .iter()
            .map(|chunk| String::from_utf8(chunk.to_vec()).unwrap())
            .collect();
        assert!(
            completed_text.contains("reasoning_thinking_ms"),
            "{completed_text}"
        );
        assert!(completed_text.contains("synth summary"));
    }

    #[test]
    fn responses_stream_event_transformer_covers_major_branches() {
        let entry = test_catalog().entries["GPT-5.4 pro"].clone();
        let mut state = ResponsesStreamState::default();

        assert!(transform_bifrost_responses_event(
            "response.created",
            &json!({"response":{"id":"resp_1","created_at":123}}),
            &entry,
            None,
            &mut state,
        )
        .unwrap()
        .is_empty());

        assert!(transform_bifrost_responses_event(
            "response.in_progress",
            &json!({"response":{"id":"resp_1","created_at":456}}),
            &entry,
            None,
            &mut state,
        )
        .unwrap()
        .is_empty());
        assert!(transform_bifrost_responses_event(
            "response.created",
            &json!({}),
            &entry,
            None,
            &mut state,
        )
        .unwrap()
        .is_empty());

        let delta_chunks = transform_bifrost_responses_event(
            "response.output_text.delta",
            &json!({"delta":"ok"}),
            &entry,
            None,
            &mut state,
        )
        .unwrap();
        assert_eq!(delta_chunks.len(), 2);
        let repeat_delta = response_output_text_delta_chunks(&mut state, &entry, "again");
        assert_eq!(repeat_delta.len(), 1);
        assert!(String::from_utf8(repeat_delta[0].to_vec())
            .unwrap()
            .contains("again"));

        let fallback_delta = response_output_text_delta_chunks(
            &mut ResponsesStreamState::default(),
            &entry,
            "fallback",
        );
        assert_eq!(fallback_delta.len(), 2);
        assert!(String::from_utf8(fallback_delta[0].to_vec())
            .unwrap()
            .contains("resp_unknown"));

        assert!(transform_bifrost_responses_event(
            "response.output_text.delta",
            &json!({"delta":""}),
            &entry,
            None,
            &mut state,
        )
        .unwrap()
        .is_empty());

        let text_fallback = transform_bifrost_responses_event(
            "response.completed",
            &json!({
                "response":{
                    "id":"resp_text_only",
                    "created_at":124,
                    "output":[{"type":"message","content":[{"type":"output_text","text":"fallback text"}]}],
                    "usage":{
                        "input_tokens":8,
                        "output_tokens":3,
                        "total_tokens":11
                    }
                }
            }),
            &entry,
            None,
            &mut ResponsesStreamState::default(),
        )
        .unwrap();
        assert_eq!(text_fallback.len(), 4);
        assert!(String::from_utf8(text_fallback[0].to_vec())
            .unwrap()
            .contains("\"role\":\"assistant\""));
        assert!(String::from_utf8(text_fallback[1].to_vec())
            .unwrap()
            .contains("\"content\":\"fallback text\""));
        assert!(String::from_utf8(text_fallback[2].to_vec())
            .unwrap()
            .contains("\"finish_reason\":\"stop\""));
        assert_eq!(
            String::from_utf8(text_fallback[3].to_vec()).unwrap(),
            "data: [DONE]\n\n"
        );

        let tool_call_fallback = transform_bifrost_responses_event(
            "response.completed",
            &json!({
                "response":{
                    "id":"resp_tool_only",
                    "created_at":125,
                    "output":[{"type":"function_call","call_id":"call_1","name":"lookup","arguments":"{\"q\":\"rust\"}"}],
                    "incomplete_details":{"reason":"tool_calls"},
                    "usage":{
                        "input_tokens":9,
                        "output_tokens":4,
                        "total_tokens":13
                    }
                }
            }),
            &entry,
            None,
            &mut ResponsesStreamState::default(),
        )
        .unwrap();
        assert_eq!(tool_call_fallback.len(), 4);
        assert!(String::from_utf8(tool_call_fallback[1].to_vec())
            .unwrap()
            .contains("\"tool_calls\""));
        assert!(String::from_utf8(tool_call_fallback[1].to_vec())
            .unwrap()
            .contains("\"name\":\"lookup\""));
        assert!(String::from_utf8(tool_call_fallback[2].to_vec())
            .unwrap()
            .contains("\"finish_reason\":\"tool_calls\""));

        let completed = transform_bifrost_responses_event(
            "response.completed",
            &json!({
                "response":{
                    "id":"resp_1",
                    "created_at":123,
                    "output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}],
                    "usage":{
                        "input_tokens":10,
                        "input_tokens_details":{"cached_read_tokens":0},
                        "output_tokens":5,
                        "output_tokens_details":{"reasoning_tokens":2},
                        "total_tokens":15
                    }
                }
            }),
            &entry,
            Some(0.25),
            &mut state,
        )
        .unwrap();
        assert_eq!(completed.len(), 2);
        assert!(String::from_utf8(completed[0].to_vec())
            .unwrap()
            .contains("\"cost\":0.25"));
        assert_eq!(
            String::from_utf8(completed[1].to_vec()).unwrap(),
            "data: [DONE]\n\n"
        );

        let mut fresh_state = ResponsesStreamState::default();
        let computed_cost = transform_bifrost_responses_event(
            "response.completed",
            &json!({
                "response":{
                    "id":"resp_2",
                    "created_at":321,
                    "usage":{
                        "input_tokens":1000,
                        "input_tokens_details":{"cached_read_tokens":800},
                        "output_tokens":10,
                        "total_tokens":1010
                    }
                }
            }),
            &test_catalog().entries["GPT-4.1"].clone(),
            None,
            &mut fresh_state,
        )
        .unwrap();
        let computed_cost_text = String::from_utf8(computed_cost[0].to_vec()).unwrap();
        assert!(computed_cost_text.contains("\"cost\":0.00088"));

        let repeated_completed = response_completed_chunks(
            &mut ResponsesStreamState {
                done_sent: true,
                ..ResponsesStreamState::default()
            },
            &entry,
            json!({"id":"resp_3","created_at":1}).as_object().unwrap(),
            None,
        );
        assert_eq!(repeated_completed.len(), 1);
        let completed_with_existing_cost = response_completed_chunks(
            &mut ResponsesStreamState::default(),
            &entry,
            json!({
                "id":"resp_4",
                "created_at":2,
                "usage":{
                    "input_tokens":10,
                    "output_tokens":1,
                    "total_tokens":11
                }
            })
            .as_object()
            .unwrap(),
            Some(1.0),
        );
        assert!(String::from_utf8(completed_with_existing_cost[0].to_vec())
            .unwrap()
            .contains("\"cost\":1.0"));

        let empty_completed = transform_bifrost_responses_event(
            "response.completed",
            &json!({}),
            &entry,
            None,
            &mut state,
        )
        .unwrap();
        assert!(empty_completed.is_empty());

        assert!(
            transform_bifrost_responses_event("unknown", &json!({}), &entry, None, &mut state)
                .unwrap()
                .is_empty()
        );

        let chunk = chat_completion_stream_chunk_bytes(
            "resp_1",
            123,
            "GPT-5.4 pro",
            json!({"content":"ok"}),
            Some("stop"),
            None,
            Some(&json!({"total_tokens":1})),
        );
        let chunk_text = String::from_utf8(chunk.to_vec()).unwrap();
        assert!(chunk_text.contains("\"finish_reason\":\"stop\""));
        assert!(chunk_text.contains("\"total_tokens\":1"));

        let incomplete_chunk = chat_completion_stream_chunk_bytes(
            "resp_2",
            456,
            "GPT-5.4",
            json!({}),
            None,
            Some("incomplete_stream"),
            None,
        );
        let incomplete_chunk_text = String::from_utf8(incomplete_chunk.to_vec()).unwrap();
        assert!(incomplete_chunk_text.contains("\"stop_reason\":\"incomplete_stream\""));
    }

    #[tokio::test]
    async fn chat_completions_handler_covers_validation_and_openai_paths() {
        let captured_headers = Arc::new(std::sync::Mutex::new(Vec::<HeaderMap>::new()));
        let captured_headers_clone = Arc::clone(&captured_headers);
        let ok_server = start_server(
            Router::new().route(
                "/v1/chat/completions",
                any(move |headers: HeaderMap| {
                    let captured_headers = Arc::clone(&captured_headers_clone);
                    async move {
                        captured_headers.lock().unwrap().push(headers);
                    let mut response = Response::new(Body::from(
                        r#"{"id":"chatcmpl_1","model":"openai/gpt-4.1","usage":{"prompt_tokens":100,"completion_tokens":5,"prompt_tokens_details":{"cached_read_tokens":80},"total_tokens":105},"choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}"#,
                    ));
                    response.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
                    response.headers_mut().insert("x-portico-cost-usd", HeaderValue::from_static("0.12"));
                    response
                    }
                }),
            ),
        )
        .await;

        let invalid = chat_completions(
            State(test_state(&ok_server.base_url, "http://unused")),
            HeaderMap::new(),
            Bytes::from_static(b"not-json"),
        )
        .await;
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);

        let missing_model = chat_completions(
            State(test_state(&ok_server.base_url, "http://unused")),
            HeaderMap::new(),
            Bytes::from_static(br#"{}"#),
        )
        .await;
        assert_eq!(missing_model.status(), StatusCode::BAD_REQUEST);

        let unknown_model = chat_completions(
            State(test_state(&ok_server.base_url, "http://unused")),
            HeaderMap::new(),
            Bytes::from_static(br#"{"model":"missing"}"#),
        )
        .await;
        assert_eq!(unknown_model.status(), StatusCode::NOT_FOUND);

        let success_response = chat_completions(
            State(test_state(&ok_server.base_url, "http://unused")),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"GPT-4.1",
                    "messages":[{"role":"user","content":"hi"}]
                }))
                .unwrap(),
            ),
        )
        .await;
        assert_eq!(
            success_response.headers().get(CONTENT_TYPE).unwrap(),
            "application/json"
        );
        assert_eq!(
            success_response.headers().get("x-portico-cost-usd").unwrap(),
            "0.12"
        );
        let success = response_json(success_response).await;
        assert_eq!(success["model"], json!("GPT-4.1"));
        assert_eq!(success["usage"]["cost"], json!(0.12));
        let captured_headers = captured_headers.lock().unwrap();
        assert_eq!(captured_headers.len(), 1);
        assert_portico_contract_headers(&captured_headers[0], true, true);
        assert_eq!(
            captured_headers[0]
                .get("x-bf-passthrough-extra-params")
                .unwrap(),
            "true"
        );

        let failing = chat_completions(
            State(test_state("http://127.0.0.1:9", "http://unused")),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"GPT-4.1",
                    "messages":[{"role":"user","content":"hi"}]
                }))
                .unwrap(),
            ),
        )
        .await;
        assert_eq!(failing.status(), StatusCode::BAD_GATEWAY);

        let error_server = start_server(Router::new().route(
            "/v1/chat/completions",
            any(|| async move {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Body::from("upstream bad"),
                )
            }),
        ))
        .await;
        let errored = chat_completions(
            State(test_state(&error_server.base_url, "http://unused")),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"GPT-4.1",
                    "messages":[{"role":"user","content":"hi"}]
                }))
                .unwrap(),
            ),
        )
        .await;
        assert_eq!(errored.status(), StatusCode::INTERNAL_SERVER_ERROR);

        let invalid_json_server = start_server(Router::new().route(
            "/v1/chat/completions",
            any(|| async move {
                let mut response = Response::new(Body::from("{"));
                response
                    .headers_mut()
                    .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
                response
            }),
        ))
        .await;
        let invalid_upstream = chat_completions(
            State(test_state(&invalid_json_server.base_url, "http://unused")),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"GPT-4.1",
                    "messages":[{"role":"user","content":"hi"}]
                }))
                .unwrap(),
            ),
        )
        .await;
        assert_eq!(invalid_upstream.status(), StatusCode::BAD_GATEWAY);

        let malformed_stream_base = start_raw_http_server(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\nZZ\r\nbad\r\n0\r\n\r\n"
                .to_vec(),
        )
        .await;
        let malformed_stream = chat_completions(
            State(test_state(&malformed_stream_base, "http://unused")),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"GPT-4.1",
                    "messages":[{"role":"user","content":"hi"}],
                    "stream": true
                }))
                .unwrap(),
            ),
        )
        .await;
        let malformed_stream_text = response_text(malformed_stream).await;
        assert!(
            malformed_stream_text.contains("Upstream model provider stream failed. Please retry.")
        );
        assert!(malformed_stream_text.contains("data: [DONE]"));

        let invalid_utf8_base = start_raw_http_server(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 3\r\n\r\n\xff\xfe\n"
                .to_vec(),
        )
        .await;
        let invalid_utf8 = chat_completions(
            State(test_state(&invalid_utf8_base, "http://unused")),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"GPT-4.1",
                    "messages":[{"role":"user","content":"hi"}],
                    "stream": true
                }))
                .unwrap(),
            ),
        )
        .await;
        let invalid_utf8_text = response_text(invalid_utf8).await;
        assert!(invalid_utf8_text
            .contains("Upstream model provider returned invalid stream data. Please retry."));
        assert!(invalid_utf8_text.contains("data: [DONE]"));

        let response_created = r#"event: response.created
data: {"response":{"id":"resp_1","created_at":123}}

"#;
        let delta_event = format!(
            "event: response.output_text.delta\ndata: {}\n\n",
            serde_json::to_string(&json!({"delta":"café"})).unwrap()
        );
        let response_completed = r#"event: response.completed
data: {"response":{"id":"resp_1","created_at":123,"output":[{"type":"message","content":[{"type":"output_text","text":"café"}]}],"usage":{"input_tokens":10,"input_tokens_details":{"cached_read_tokens":0,"cached_write_tokens":0},"output_tokens":5,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":15}}}

"#;
        let full_stream = format!("{response_created}{delta_event}{response_completed}");
        let full_stream_bytes = full_stream.as_bytes();
        let split_index = full_stream_bytes
            .windows(2)
            .position(|window| window == [0xC3, 0xA9])
            .unwrap()
            + 1;
        let split_utf8_base = start_chunked_sse_server(vec![
            full_stream_bytes[..split_index].to_vec(),
            full_stream_bytes[split_index..].to_vec(),
        ])
        .await;
        let split_utf8 = chat_completions(
            State(test_state("http://unused", &split_utf8_base)),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"GPT-5.5",
                    "messages":[{"role":"user","content":"hi"}],
                    "stream": true
                }))
                .unwrap(),
            ),
        )
        .await;
        let split_utf8_text = response_text(split_utf8).await;
        assert!(split_utf8_text.contains("\"content\":\"café\""));
        assert!(split_utf8_text.contains("data: [DONE]"));
        assert!(!split_utf8_text.contains("invalid stream data"));
    }

    #[tokio::test]
    async fn build_app_allows_chat_completion_payloads_larger_than_axum_default_limit() {
        let ok_server = start_server(
            Router::new().route(
                "/v1/chat/completions",
                any(|| async move {
                    let mut response = Response::new(Body::from(
                        r#"{"id":"chatcmpl_1","model":"openai/gpt-4.1","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}"#,
                    ));
                    response
                        .headers_mut()
                        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
                    response
                }),
            ),
        )
        .await;
        let app_server = start_server(build_app(
            test_state(&ok_server.base_url, "http://unused"),
            None,
        ))
        .await;

        let mut request = reqwest::Client::new()
            .post(format!("{}/v1/chat/completions", app_server.base_url))
            .json(&json!({
                "model": "GPT-4.1",
                "messages": [{"role": "user", "content": "a".repeat(3_000_000)}],
            }));
        if let Some(local_api_key) = env_optional_with_file("BIFROST_BRIDGE_LOCAL_API_KEY") {
            request = request.bearer_auth(local_api_key);
        }
        let response = request.send().await.unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn build_app_enforces_configured_chat_completion_body_limit() {
        let ok_server = start_server(
            Router::new().route(
                "/v1/chat/completions",
                any(|| async move {
                    let mut response = Response::new(Body::from(
                        r#"{"id":"chatcmpl_1","model":"openai/gpt-4.1","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}"#,
                    ));
                    response
                        .headers_mut()
                        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
                    response
                }),
            ),
        )
        .await;
        let app_server = start_server(build_app(
            test_state(&ok_server.base_url, "http://unused"),
            Some(1_048_576),
        ))
        .await;

        let mut request = reqwest::Client::new()
            .post(format!("{}/v1/chat/completions", app_server.base_url))
            .json(&json!({
                "model": "GPT-4.1",
                "messages": [{"role": "user", "content": "a".repeat(2_000_000)}],
            }));
        if let Some(local_api_key) = env_optional_with_file("BIFROST_BRIDGE_LOCAL_API_KEY") {
            request = request.bearer_auth(local_api_key);
        }
        match request.send().await {
            Ok(response) => assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE),
            // Some HTTP stacks terminate oversized uploads before an explicit 413 payload
            // response can be delivered to the client.
            Err(_error) => {}
        }
    }

    #[tokio::test]
    async fn chat_completions_handler_strips_openwebui_metadata_for_openai_requests() {
        let captured_requests = Arc::new(std::sync::Mutex::new(Vec::<(HeaderMap, Value)>::new()));
        let captured_requests_clone = Arc::clone(&captured_requests);
        let ok_server = start_server(
            Router::new().route(
                "/v1/chat/completions",
                any(move |headers: HeaderMap, body: Bytes| {
                    let captured_requests = Arc::clone(&captured_requests_clone);
                    async move {
                        let body: Value = serde_json::from_slice(&body).unwrap();
                        captured_requests.lock().unwrap().push((headers, body));
                        let mut response = Response::new(Body::from(
                            r#"{"id":"chatcmpl_1","model":"openai/gpt-4.1","usage":{"prompt_tokens":100,"completion_tokens":5,"prompt_tokens_details":{"cached_read_tokens":80},"total_tokens":105},"choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}"#,
                        ));
                        response
                            .headers_mut()
                            .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
                        response
                    }
                }),
            ),
        )
        .await;

        let mut headers = HeaderMap::new();
        headers.insert("x-openwebui-chat-id", HeaderValue::from_static("chat-123"));
        headers.insert(
            "x-openwebui-message-id",
            HeaderValue::from_static("msg-123"),
        );
        headers.insert(
            "x-openwebui-session-id",
            HeaderValue::from_static("session-123"),
        );
        headers.insert(
            "x-openwebui-debug-request-id",
            HeaderValue::from_static("dbg-123"),
        );
        headers.insert(
            "x-openwebui-upstream-request-id",
            HeaderValue::from_static("upstream-123"),
        );
        headers.insert(
            "x-openwebui-prompt-submitted-at-ms",
            HeaderValue::from_static("1740000000123"),
        );
        headers.insert(
            "x-openwebui-request-phase",
            HeaderValue::from_static("tool_followup"),
        );
        headers.insert("x-openwebui-followup-index", HeaderValue::from_static("2"));
        headers.insert(
            "x-openwebui-outer-message-id",
            HeaderValue::from_static("assistant-123"),
        );
        headers.insert(
            "x-openwebui-trigger-message-id",
            HeaderValue::from_static("user-123"),
        );
        headers.insert(
            "x-openwebui-transcript-anchor-kind",
            HeaderValue::from_static("assistant_tool_block"),
        );
        headers.insert(
            "x-openwebui-transcript-anchor-message-id",
            HeaderValue::from_static("msg-anchor-123"),
        );
        headers.insert(
            "x-openwebui-transcript-anchor-tool-block-index",
            HeaderValue::from_static("4"),
        );
        headers.insert(
            TRACEPARENT_HEADER,
            HeaderValue::from_static("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"),
        );
        headers.insert(TRACESTATE_HEADER, HeaderValue::from_static("vendor=value"));
        headers.insert(BAGGAGE_HEADER, HeaderValue::from_static("foo=bar"));

        let response = chat_completions(
            State(test_state(&ok_server.base_url, "http://unused")),
            headers,
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"GPT-4.1",
                    "messages":[{"role":"user","content":"hi"}],
                    "metadata":{
                        "chat_id":"chat-from-body",
                        "message_id":"msg-from-body",
                        "session_id":"session-from-body",
                        "debug_request_id":"dbg-from-body"
                    }
                }))
                .unwrap(),
            ),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let _ = response_json(response).await;

        let captured_requests = captured_requests.lock().unwrap();
        assert_eq!(captured_requests.len(), 1);
        let (captured_headers, captured_body) = &captured_requests[0];
        assert_portico_contract_headers(captured_headers, true, true);
        assert_eq!(
            captured_headers.get("x-openwebui-chat-id").unwrap(),
            "chat-123"
        );
        assert_eq!(
            captured_headers.get("x-bf-eh-x-openwebui-chat-id").unwrap(),
            "chat-123"
        );
        assert_eq!(
            captured_headers.get("x-openwebui-message-id").unwrap(),
            "msg-123"
        );
        assert_eq!(
            captured_headers
                .get("x-bf-eh-x-openwebui-message-id")
                .unwrap(),
            "msg-123"
        );
        assert_eq!(
            captured_headers.get("x-openwebui-session-id").unwrap(),
            "session-123"
        );
        assert_eq!(
            captured_headers
                .get("x-openwebui-debug-request-id")
                .unwrap(),
            "dbg-123"
        );
        assert_eq!(
            captured_headers
                .get("x-openwebui-upstream-request-id")
                .unwrap(),
            "upstream-123"
        );
        assert_eq!(
            captured_headers
                .get("x-openwebui-prompt-submitted-at-ms")
                .unwrap(),
            "1740000000123"
        );
        assert_eq!(
            captured_headers.get("x-openwebui-request-phase").unwrap(),
            "tool_followup"
        );
        assert_eq!(
            captured_headers.get("x-openwebui-followup-index").unwrap(),
            "2"
        );
        assert_eq!(
            captured_headers
                .get("x-openwebui-outer-message-id")
                .unwrap(),
            "assistant-123"
        );
        assert_eq!(
            captured_headers
                .get("x-openwebui-trigger-message-id")
                .unwrap(),
            "user-123"
        );
        assert_eq!(
            captured_headers
                .get("x-openwebui-transcript-anchor-kind")
                .unwrap(),
            "assistant_tool_block"
        );
        assert_eq!(
            captured_headers
                .get("x-openwebui-transcript-anchor-message-id")
                .unwrap(),
            "msg-anchor-123"
        );
        assert_eq!(
            captured_headers
                .get("x-openwebui-transcript-anchor-tool-block-index")
                .unwrap(),
            "4"
        );
        assert_eq!(
            captured_headers.get(TRACEPARENT_HEADER).unwrap(),
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
        );
        assert_eq!(
            captured_headers.get("x-bf-eh-traceparent").unwrap(),
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
        );
        assert_eq!(
            captured_headers.get(TRACESTATE_HEADER).unwrap(),
            "vendor=value"
        );
        assert_eq!(captured_headers.get(BAGGAGE_HEADER).unwrap(), "foo=bar");
        assert_eq!(captured_body["model"], json!("openai/gpt-4.1"));
        assert!(captured_body.get("metadata").is_none());
        assert_eq!(
            captured_body["prompt_cache_key"],
            json!("owui:gpt41:chat-123")
        );
        assert_eq!(captured_body["prompt_cache_retention"], json!("24h"));
    }

    #[tokio::test]
    async fn chat_completions_handler_preserves_metadata_for_non_openwebui_requests() {
        let captured_requests = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let captured_requests_clone = Arc::clone(&captured_requests);
        let ok_server = start_server(
            Router::new().route(
                "/v1/chat/completions",
                any(move |body: Bytes| {
                    let captured_requests = Arc::clone(&captured_requests_clone);
                    async move {
                        let body: Value = serde_json::from_slice(&body).unwrap();
                        captured_requests.lock().unwrap().push(body);
                        let mut response = Response::new(Body::from(
                            r#"{"id":"chatcmpl_1","model":"openai/gpt-4.1","usage":{"prompt_tokens":100,"completion_tokens":5,"prompt_tokens_details":{"cached_read_tokens":80},"total_tokens":105},"choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}"#,
                        ));
                        response
                            .headers_mut()
                            .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
                        response
                    }
                }),
            ),
        )
        .await;

        let response = chat_completions(
            State(test_state(&ok_server.base_url, "http://unused")),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"GPT-4.1",
                    "messages":[{"role":"user","content":"hi"}],
                    "metadata":{
                        "chat_id":"chat-from-body",
                        "message_id":"msg-from-body",
                        "session_id":"session-from-body"
                    }
                }))
                .unwrap(),
            ),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let _ = response_json(response).await;

        let captured_requests = captured_requests.lock().unwrap();
        assert_eq!(captured_requests.len(), 1);
        let captured_body = &captured_requests[0];
        assert_eq!(
            captured_body["metadata"]["chat_id"],
            json!("chat-from-body")
        );
        assert_eq!(
            captured_body["metadata"]["message_id"],
            json!("msg-from-body")
        );
        assert_eq!(
            captured_body["metadata"]["session_id"],
            json!("session-from-body")
        );
        assert_eq!(
            captured_body["prompt_cache_key"],
            json!("owui:gpt41:chat-from-body")
        );
    }

    #[tokio::test]
    async fn chat_completions_handler_preserves_native_claude_system_messages_before_forwarding() {
        let captured_requests = Arc::new(std::sync::Mutex::new(Vec::<(HeaderMap, Value)>::new()));
        let captured_requests_clone = Arc::clone(&captured_requests);
        let ok_server = start_server(
            Router::new().route(
                "/v1/chat/completions",
                any(move |headers: HeaderMap, body: Bytes| {
                    let captured_requests = Arc::clone(&captured_requests_clone);
                    async move {
                        let payload: Value = serde_json::from_slice(&body).unwrap();
                        captured_requests.lock().unwrap().push((headers, payload));
                        let mut response = Response::new(Body::from(
                            r#"{"id":"chatcmpl_claude","model":"anthropic/us.anthropic.claude-sonnet-4-6","usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15},"choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}"#,
                        ));
                        response.headers_mut().insert(
                            CONTENT_TYPE,
                            HeaderValue::from_static("application/json"),
                        );
                        response
                    }
                }),
            ),
        )
        .await;

        let response = chat_completions(
            State(test_state(&ok_server.base_url, "http://unused")),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"Claude Sonnet 4.6",
                    "messages":[
                        {"role":"system","content":"model base system prompt"},
                        {"role":"system","content":"<static_context>stable</static_context>"},
                        {"role":"system","content":"<dynamic_context>Now is 12:34</dynamic_context>"},
                        {"role":"user","content":"hello"}
                    ]
                }))
                .unwrap(),
            ),
        )
        .await;
        let response_json = response_json(response).await;
        assert_eq!(response_json["model"], json!("Claude Sonnet 4.6"));

        let captured_requests = captured_requests.lock().unwrap();
        assert_eq!(captured_requests.len(), 1);
        let (captured_headers, forwarded) = &captured_requests[0];
        assert_eq!(
            captured_headers
                .get("x-bf-passthrough-extra-params")
                .unwrap(),
            "true"
        );
        assert_eq!(
            forwarded["model"],
            json!("anthropic/us.anthropic.claude-sonnet-4-6")
        );
        let messages = forwarded["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 4);
        assert_eq!(
            messages
                .iter()
                .filter(|message| message["role"] == json!("system"))
                .count(),
            3
        );
        assert_eq!(
            messages[0]["content"][0]["text"],
            json!("<static_context>stable</static_context>")
        );
        assert_eq!(
            messages[1]["content"][0]["text"],
            json!("model base system prompt")
        );
        assert_eq!(
            messages[2],
            json!({"role":"system","content":"<dynamic_context>Now is 12:34</dynamic_context>"})
        );
        assert_eq!(messages[3], json!({"role":"user","content":"hello"}));
        assert_eq!(
            forwarded[CLAUDE_SYSTEM_MESSAGES_PASSTHROUGH_KEY],
            json!([
                {"role":"system","content":[{"type":"text","text":"<static_context>stable</static_context>","cache_control":{"type":"ephemeral"}}]},
                {"role":"system","content":[{"type":"text","text":"model base system prompt","cache_control":{"type":"ephemeral"}}]},
                {"role":"system","content":"<dynamic_context>Now is 12:34</dynamic_context>"}
            ])
        );
        assert_eq!(
            forwarded["anthropic_beta"],
            json!([
                "fine-grained-tool-streaming-2025-05-14",
                "interleaved-thinking-2025-05-14"
            ])
        );
        assert_eq!(
            forwarded["additionalModelRequestFields"]["anthropic_beta"],
            forwarded["anthropic_beta"]
        );
    }

    #[test]
    fn restore_claude_system_messages_from_passthrough_replaces_collapsed_system_payload() {
        let mut request_body = json!({
            "model":"us.anthropic.claude-haiku-4-5-20251001-v1:0",
            "system":[{"type":"text","text":"<dynamic_context>collapsed</dynamic_context>","cache_control":{"type":"ephemeral"}}],
            "messages":[{"role":"user","content":[{"type":"text","text":"hello"}]}]
        });
        request_body
            .as_object_mut()
            .unwrap()
            .insert(
                CLAUDE_SYSTEM_MESSAGES_PASSTHROUGH_KEY.to_string(),
                json!([
                    {"role":"system","content":[{"type":"text","text":"<static_context>stable</static_context>","cache_control":{"type":"ephemeral"}}]},
                    {"role":"system","content":[{"type":"text","text":"model prompt","cache_control":{"type":"ephemeral"}}]},
                    {"role":"system","content":"<dynamic_context>today</dynamic_context>"}
                ]),
            );

        assert!(restore_claude_system_messages_from_passthrough(
            &mut request_body
        ));
        assert!(request_body
            .get(CLAUDE_SYSTEM_MESSAGES_PASSTHROUGH_KEY)
            .is_none());
        assert_eq!(
            request_body["system"],
            json!([
                {"type":"text","text":"<static_context>stable</static_context>","cache_control":{"type":"ephemeral"}},
                {"type":"text","text":"model prompt","cache_control":{"type":"ephemeral"}},
                {"type":"text","text":"<dynamic_context>today</dynamic_context>"}
            ])
        );
    }

    #[test]
    fn summarize_anthropic_request_captures_adaptive_thinking_controls() {
        let summary = summarize_anthropic_request(&json!({
            "messages":[{"role":"user","content":"hello"}],
            "thinking":{"type":"adaptive","display":"summarized"},
            "output_config":{"effort":"xhigh"}
        }));

        assert!(summary.thinking_enabled);
        assert_eq!(summary.thinking_type.as_deref(), Some("adaptive"));
        assert_eq!(summary.thinking_display.as_deref(), Some("summarized"));
        assert_eq!(summary.output_config_effort.as_deref(), Some("xhigh"));

        let disabled = summarize_anthropic_request(&json!({
            "messages":[{"role":"user","content":"hello"}],
            "thinking":{"type":"disabled"}
        }));
        assert!(!disabled.thinking_enabled);
        assert_eq!(disabled.thinking_type.as_deref(), Some("disabled"));
        assert_eq!(disabled.thinking_display, None);
        assert_eq!(disabled.output_config_effort, None);
    }

    #[tokio::test]
    async fn ordinary_routes_reject_reserved_multi_agent_controls() {
        let reserved_payloads = [
            json!({
                "model": "GPT-5.5",
                "messages": [{"role": "user", "content": "hello"}],
                "reasoning_effort": "high",
                "multi_agent": {"enabled": true},
            }),
            json!({
                "model": "GPT-5.5",
                "messages": [{"role": "user", "content": "hello"}],
                "reasoning_effort": "high",
                "params": {"multi_agent": {"enabled": true}},
            }),
        ];
        for route_mode in [GptOpenAIRouteMode::Direct, GptOpenAIRouteMode::Bifrost] {
            for payload in &reserved_payloads {
                let response = chat_completions(
                    State(test_state_with_route_mode(
                        "http://127.0.0.1:9",
                        "http://127.0.0.1:9",
                        route_mode,
                    )),
                    HeaderMap::new(),
                    Bytes::from(serde_json::to_vec(payload).unwrap()),
                )
                .await;
                assert_eq!(response.status(), StatusCode::BAD_REQUEST);
                assert_eq!(
                    response_json(response).await["error"]["message"],
                    json!("multi_agent is reserved for authenticated Ultra requests")
                );
            }
        }
        let ultra = json!({
            "reasoning_effort": "ultra",
            "multi_agent": {"enabled": false},
        });
        assert!(ultra_request_requested(&ultra));
        assert!(ultra_reserved_controls_present(&ultra));
    }

    #[tokio::test]
    async fn chat_completion_handler_covers_stream_and_responses_routing() {
        let bifrost_server = start_server(
            Router::new()
                .route(
                    "/v1/chat/completions",
                    any(|| async move {
                        let mut response = Response::new(Body::from(
                            "data: {\"id\":\"chatcmpl_1\",\"model\":\"openai/gpt-4.1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":null}],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":5,\"prompt_tokens_details\":{\"cached_read_tokens\":80},\"total_tokens\":105}}\n\ndata: [DONE]\n\n",
                        ));
                        response.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
                        response.headers_mut().insert("x-portico-cost-usd", HeaderValue::from_static("0.33"));
                        response
                    }),
                )
                .route(
                    "/openai/v1/responses",
                    any(|| async move {
                        let mut response = Response::new(Body::from(
                            "event: response.created\ndata: {\"response\":{\"id\":\"resp_1\",\"created_at\":123}}\n\nevent: response.output_text.delta\ndata: {\"delta\":\"ok\"}\n\nevent: response.completed\ndata: {\"response\":{\"id\":\"resp_1\",\"created_at\":123,\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"ok\"}]}],\"usage\":{\"input_tokens\":10,\"input_tokens_details\":{\"cached_read_tokens\":0,\"cached_write_tokens\":0},\"output_tokens\":5,\"output_tokens_details\":{\"reasoning_tokens\":2},\"total_tokens\":15}}}\n\n",
                        ));
                        response.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
                        response.headers_mut().insert("x-portico-cost-usd", HeaderValue::from_static("0.44"));
                        response
                    }),
                ),
        )
        .await;

        let openai_stream = chat_completions(
            State(test_state(&bifrost_server.base_url, "http://unused")),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"GPT-4.1",
                    "messages":[{"role":"user","content":"hi"}],
                    "stream": true
                }))
                .unwrap(),
            ),
        )
        .await;
        let openai_stream_text = response_text(openai_stream).await;
        assert!(openai_stream_text.contains("\"model\":\"GPT-4.1\""));
        assert!(openai_stream_text.contains("\"cost\":0.33"));

        let converse_no_done_terminal_server = start_server(
            Router::new().route(
                "/v1/chat/completions",
                any(|| async move {
                    let mut response = Response::new(Body::from(
                        "data: {\"id\":\"chatcmpl_done_missing\",\"model\":\"anthropic/us.anthropic.claude-sonnet-4-5-20250929-v1:0\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
                    ));
                    response.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
                    response
                }),
            ),
        )
        .await;
        let converse_no_done_terminal = chat_completions(
            State(test_state(
                &converse_no_done_terminal_server.base_url,
                "http://unused",
            )),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"Claude Sonnet 4.5",
                    "messages":[{"role":"user","content":"hi"}],
                    "stream": true
                }))
                .unwrap(),
            ),
        )
        .await;
        let converse_no_done_terminal_text = response_text(converse_no_done_terminal).await;
        assert!(converse_no_done_terminal_text.contains("\"finish_reason\":\"stop\""));
        assert!(converse_no_done_terminal_text.contains("data: [DONE]"));

        let converse_no_terminal_server = start_server(
            Router::new().route(
                "/v1/chat/completions",
                any(|| async move {
                    let mut response = Response::new(Body::from(
                        "data: {\"id\":\"chatcmpl_terminal_missing\",\"model\":\"anthropic/us.anthropic.claude-sonnet-4-5-20250929-v1:0\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"},\"finish_reason\":null}]}\n\n",
                    ));
                    response.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
                    response
                }),
            ),
        )
        .await;
        let converse_no_terminal = chat_completions(
            State(test_state(
                &converse_no_terminal_server.base_url,
                "http://unused",
            )),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"Claude Sonnet 4.5",
                    "messages":[{"role":"user","content":"hi"}],
                    "stream": true
                }))
                .unwrap(),
            ),
        )
        .await;
        let converse_no_terminal_text = response_text(converse_no_terminal).await;
        assert!(converse_no_terminal_text.contains("\"content\":\"partial\""));
        assert!(converse_no_terminal_text.contains("\"error\""));
        assert!(converse_no_terminal_text.contains("data: [DONE]"));

        let responses_stream = chat_completions(
            State(test_state(&bifrost_server.base_url, &bifrost_server.base_url)),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"GPT-5.4",
                    "messages":[{"role":"user","content":"hi"}],
                    "tools":[{"type":"function","function":{"name":"lookup","description":"Lookup","parameters":{"type":"object"}}}],
                    "reasoning_effort":"medium",
                    "stream": true
                }))
                .unwrap(),
            ),
        )
        .await;
        let responses_text = response_text(responses_stream).await;
        assert!(responses_text.contains("\"model\":\"GPT-5.4\""));
        assert!(responses_text.contains("\"cost\":0.44"));
        assert!(responses_text.contains("data: [DONE]"));

        let responses_stream = chat_completions(
            State(test_state(
                &bifrost_server.base_url,
                &bifrost_server.base_url,
            )),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"GPT-5.4 pro",
                    "messages":[{"role":"user","content":"hi"}],
                    "stream": true
                }))
                .unwrap(),
            ),
        )
        .await;
        let responses_text = response_text(responses_stream).await;
        assert!(responses_text.contains("\"model\":\"GPT-5.4 pro\""));
        assert!(responses_text.contains("\"cost\":0.44"));
        assert!(responses_text.contains("data: [DONE]"));

        let text_fallback_server = start_server(
            Router::new().route(
                "/openai/v1/responses",
                any(|| async move {
                    let mut response = Response::new(Body::from(
                        "event: response.created\ndata: {\"response\":{\"id\":\"resp_text_only\",\"created_at\":123}}\n\nevent: response.completed\ndata: {\"response\":{\"id\":\"resp_text_only\",\"created_at\":123,\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"fallback text\"}]}],\"usage\":{\"input_tokens\":10,\"output_tokens\":5,\"total_tokens\":15}}}\n\n",
                    ));
                    response
                        .headers_mut()
                        .insert(CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
                    response
                }),
            ),
        )
        .await;
        let text_fallback_stream = chat_completions(
            State(test_state("http://unused", &text_fallback_server.base_url)),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"GPT-5.5",
                    "messages":[{"role":"user","content":"hi"}],
                    "stream": true
                }))
                .unwrap(),
            ),
        )
        .await;
        let text_fallback_stream_text = response_text(text_fallback_stream).await;
        assert!(text_fallback_stream_text.contains("\"content\":\"fallback text\""));
        assert!(text_fallback_stream_text.contains("\"finish_reason\":\"stop\""));
        assert!(text_fallback_stream_text.contains("data: [DONE]"));

        let incomplete_stream_server = start_server(
            Router::new().route(
                "/openai/v1/responses",
                any(|| async move {
                    let mut response = Response::new(Body::from(
                        "event: response.created\ndata: {\"response\":{\"id\":\"resp_incomplete\",\"created_at\":126}}\n\nevent: response.output_text.delta\ndata: {\"delta\":\"partial\"}\n\n",
                    ));
                    response
                        .headers_mut()
                        .insert(CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
                    response
                }),
            ),
        )
        .await;
        let incomplete_stream = chat_completions(
            State(test_state(
                "http://unused",
                &incomplete_stream_server.base_url,
            )),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"GPT-5.4",
                    "messages":[{"role":"user","content":"hi"}],
                    "stream": true
                }))
                .unwrap(),
            ),
        )
        .await;
        let incomplete_stream_text = response_text(incomplete_stream).await;
        assert!(incomplete_stream_text.contains("\"content\":\"partial\""));
        assert!(incomplete_stream_text.contains("\"stop_reason\":\"incomplete_stream\""));
        assert!(incomplete_stream_text.contains("data: [DONE]"));

        let tool_call_fallback_server = start_server(
            Router::new().route(
                "/openai/v1/responses",
                any(|| async move {
                    let mut response = Response::new(Body::from(
                        "event: response.created\ndata: {\"response\":{\"id\":\"resp_tool_only\",\"created_at\":123}}\n\nevent: response.completed\ndata: {\"response\":{\"id\":\"resp_tool_only\",\"created_at\":123,\"output\":[{\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"lookup\",\"arguments\":\"{\\\"q\\\":\\\"rust\\\"}\"}],\"incomplete_details\":{\"reason\":\"tool_calls\"},\"usage\":{\"input_tokens\":10,\"output_tokens\":5,\"total_tokens\":15}}}\n\n",
                    ));
                    response
                        .headers_mut()
                        .insert(CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
                    response
                }),
            ),
        )
        .await;
        let tool_call_fallback_stream = chat_completions(
            State(test_state("http://unused", &tool_call_fallback_server.base_url)),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"GPT-5.4",
                    "messages":[{"role":"user","content":"hi"}],
                    "tools":[{"type":"function","function":{"name":"lookup","description":"Lookup","parameters":{"type":"object"}}}],
                    "stream": true
                }))
                .unwrap(),
            ),
        )
        .await;
        let tool_call_fallback_text = response_text(tool_call_fallback_stream).await;
        assert!(tool_call_fallback_text.contains("\"tool_calls\""));
        assert!(tool_call_fallback_text.contains("\"name\":\"lookup\""));
        assert!(tool_call_fallback_text.contains("\"finish_reason\":\"tool_calls\""));
        assert!(tool_call_fallback_text.contains("data: [DONE]"));

        let bifrost_server = start_server(
            Router::new()
                .route(
                    "/openai/v1/responses",
                    any(|| async move {
                        let mut response = Response::new(Body::from(r#"{"id":"resp_9","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}],"usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}}"#));
                        response.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
                        response
                    }),
                ),
        )
        .await;
        let non_stream = chat_completions(
            State(test_state("http://unused", &bifrost_server.base_url)),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"GPT-5.4 pro",
                    "messages":[{"role":"user","content":"hi"}]
                }))
                .unwrap(),
            ),
        )
        .await;
        assert_eq!(
            non_stream.headers().get(CONTENT_TYPE).unwrap(),
            "application/json"
        );
        let non_stream_json = response_json(non_stream).await;
        assert_eq!(non_stream_json["model"], json!("GPT-5.4 pro"));

        let bad_request = chat_completions(
            State(test_state("http://unused", &bifrost_server.base_url)),
            HeaderMap::new(),
            Bytes::from_static(br#"{"model":"GPT-5.4 pro"}"#),
        )
        .await;
        assert_eq!(bad_request.status(), StatusCode::BAD_REQUEST);

        let unreachable = chat_completions(
            State(test_state("http://unused", "http://127.0.0.1:9")),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"GPT-5.4 pro",
                    "messages":[{"role":"user","content":"hi"}]
                }))
                .unwrap(),
            ),
        )
        .await;
        assert_eq!(unreachable.status(), StatusCode::BAD_GATEWAY);

        let error_server = start_server(Router::new().route(
            "/openai/v1/responses",
            any(|| async move { (StatusCode::BAD_GATEWAY, Body::from("responses bad")) }),
        ))
        .await;
        let errored = chat_completions(
            State(test_state("http://unused", &error_server.base_url)),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"GPT-5.4 pro",
                    "messages":[{"role":"user","content":"hi"}]
                }))
                .unwrap(),
            ),
        )
        .await;
        assert_eq!(errored.status(), StatusCode::BAD_GATEWAY);

        let invalid_json_server = start_server(Router::new().route(
            "/openai/v1/responses",
            any(|| async move {
                let mut response = Response::new(Body::from("{"));
                response
                    .headers_mut()
                    .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
                response
            }),
        ))
        .await;
        let invalid_json = chat_completions(
            State(test_state("http://unused", &invalid_json_server.base_url)),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"GPT-5.4 pro",
                    "messages":[{"role":"user","content":"hi"}]
                }))
                .unwrap(),
            ),
        )
        .await;
        assert_eq!(invalid_json.status(), StatusCode::BAD_GATEWAY);

        let invalid_sse_server = start_server(Router::new().route(
            "/openai/v1/responses",
            any(|| async move {
                let mut response =
                    Response::new(Body::from("event: response.output_text.delta\ndata: {\n\n"));
                response
                    .headers_mut()
                    .insert(CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
                response
            }),
        ))
        .await;
        let invalid_sse = chat_completions(
            State(test_state("http://unused", &invalid_sse_server.base_url)),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"GPT-5.4 pro",
                    "messages":[{"role":"user","content":"hi"}],
                    "stream": true
                }))
                .unwrap(),
            ),
        )
        .await;
        let invalid_sse_text = response_text(invalid_sse).await;
        assert!(invalid_sse_text.contains(
            "Upstream model provider returned an invalid stream response. Please retry."
        ));
        assert!(invalid_sse_text.contains("data: [DONE]"));

        let malformed_stream_base = start_raw_http_server(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\nZZ\r\nbad\r\n0\r\n\r\n"
                .to_vec(),
        )
        .await;
        let malformed_stream = chat_completions(
            State(test_state("http://unused", &malformed_stream_base)),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"GPT-5.4 pro",
                    "messages":[{"role":"user","content":"hi"}],
                    "stream": true
                }))
                .unwrap(),
            ),
        )
        .await;
        let malformed_stream_text = response_text(malformed_stream).await;
        assert!(
            malformed_stream_text.contains("Upstream model provider stream failed. Please retry.")
        );
        assert!(malformed_stream_text.contains("data: [DONE]"));

        let invalid_utf8_base = start_raw_http_server(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 3\r\n\r\n\xff\xfe\n"
                .to_vec(),
        )
        .await;
        let invalid_utf8 = chat_completions(
            State(test_state("http://unused", &invalid_utf8_base)),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"GPT-5.4 pro",
                    "messages":[{"role":"user","content":"hi"}],
                    "stream": true
                }))
                .unwrap(),
            ),
        )
        .await;
        let invalid_utf8_text = response_text(invalid_utf8).await;
        assert!(invalid_utf8_text
            .contains("Upstream model provider returned invalid stream data. Please retry."));
        assert!(invalid_utf8_text.contains("data: [DONE]"));
    }

    #[tokio::test]
    async fn chat_completion_handler_routes_gpt_to_bifrost_responses_when_configured() {
        let captured_requests = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let captured_requests_clone = Arc::clone(&captured_requests);
        let captured_headers = Arc::new(std::sync::Mutex::new(Vec::<HeaderMap>::new()));
        let captured_headers_clone = Arc::clone(&captured_headers);
        let bifrost_server = start_server(Router::new().route(
            "/openai/v1/responses",
            any(move |headers: HeaderMap, body: Bytes| {
                let captured_requests = Arc::clone(&captured_requests_clone);
                let captured_headers = Arc::clone(&captured_headers_clone);
                async move {
                    let value: Value = serde_json::from_slice(&body).unwrap();
                    captured_requests.lock().unwrap().push(value);
                    captured_headers.lock().unwrap().push(headers);
                    let mut response = Response::new(Body::from(
                        r#"{"id":"resp_1","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}],"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}"#,
                    ));
                    response
                        .headers_mut()
                        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
                    response
                }
            }),
        ))
        .await;

        let mut headers = HeaderMap::new();
        headers.insert(
            "x-openwebui-chat-id",
            HeaderValue::from_static("chat-resp-1"),
        );
        headers.insert(
            "x-openwebui-message-id",
            HeaderValue::from_static("msg-resp-1"),
        );
        headers.insert(
            "x-openwebui-session-id",
            HeaderValue::from_static("session-resp-1"),
        );
        headers.insert(
            "x-openwebui-debug-request-id",
            HeaderValue::from_static("dbg-resp-1"),
        );
        headers.insert(
            "x-openwebui-upstream-request-id",
            HeaderValue::from_static("upstream-resp-1"),
        );
        headers.insert(
            "x-openwebui-prompt-submitted-at-ms",
            HeaderValue::from_static("1740000000789"),
        );
        headers.insert(
            TRACEPARENT_HEADER,
            HeaderValue::from_static("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"),
        );
        headers.insert(TRACESTATE_HEADER, HeaderValue::from_static("vendor=value"));
        headers.insert(BAGGAGE_HEADER, HeaderValue::from_static("foo=bar"));

        let response = chat_completions(
            State(test_state_with_route_mode(
                &bifrost_server.base_url,
                "http://unused",
                GptOpenAIRouteMode::Bifrost,
            )),
            headers,
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"GPT-5.5",
                    "messages":[{"role":"user","content":"hi"}],
                    "params":{"function_calling":"native","reasoning_effort":"low"},
                    "_tool_namespaces":{"google_workspace":{"description":"Google Workspace","server_id":"google_workspace","is_core":false}},
                    "tools":[{"type":"function","function":{"name":"google_workspace_get_events","description":"Lookup","parameters":{"type":"object"}}}],
                    "stream": false
                }))
                .unwrap(),
            ),
        )
        .await;

        let response_json = response_json(response).await;
        assert_eq!(response_json["model"], json!("GPT-5.5"));

        let captured = captured_requests.lock().unwrap();
        assert_eq!(captured.len(), 1);
        assert_eq!(captured[0]["model"], json!("openai/gpt-5.5"));
        assert!(captured[0].get("_tool_namespaces").is_none());
        assert!(captured[0].get("messages").is_none());
        assert!(captured[0].get("params").is_none());
        assert!(captured[0].get("input").is_some());
        assert_eq!(captured[0]["reasoning"]["effort"], json!("low"));
        let tools = captured[0]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0]["type"], json!("namespace"));
        assert_eq!(tools[0]["name"], json!("google_workspace"));
        assert_eq!(tools[0]["tools"][0]["type"], json!("function"));
        assert_eq!(tools[0]["tools"][0]["name"], json!("get_events"));
        assert_eq!(tools[0]["tools"][0]["defer_loading"], json!(true));
        assert_eq!(tools[1]["type"], json!("tool_search"));
        let captured_headers = captured_headers.lock().unwrap();
        assert_eq!(captured_headers.len(), 1);
        assert_portico_contract_headers(&captured_headers[0], true, true);
        assert_eq!(
            captured_headers[0].get("x-openwebui-chat-id").unwrap(),
            "chat-resp-1"
        );
        assert_eq!(
            captured_headers[0]
                .get("x-bf-eh-x-openwebui-chat-id")
                .unwrap(),
            "chat-resp-1"
        );
        assert_eq!(
            captured_headers[0].get("x-openwebui-message-id").unwrap(),
            "msg-resp-1"
        );
        assert_eq!(
            captured_headers[0]
                .get("x-bf-eh-x-openwebui-message-id")
                .unwrap(),
            "msg-resp-1"
        );
        assert_eq!(
            captured_headers[0].get("x-openwebui-session-id").unwrap(),
            "session-resp-1"
        );
        assert_eq!(
            captured_headers[0]
                .get("x-openwebui-debug-request-id")
                .unwrap(),
            "dbg-resp-1"
        );
        assert_eq!(
            captured_headers[0]
                .get("x-openwebui-upstream-request-id")
                .unwrap(),
            "upstream-resp-1"
        );
        assert_eq!(
            captured_headers[0]
                .get("x-openwebui-prompt-submitted-at-ms")
                .unwrap(),
            "1740000000789"
        );
        assert_eq!(
            captured_headers[0].get(TRACEPARENT_HEADER).unwrap(),
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
        );
        assert_eq!(
            captured_headers[0].get("x-bf-eh-traceparent").unwrap(),
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
        );
        assert_eq!(
            captured_headers[0].get(TRACESTATE_HEADER).unwrap(),
            "vendor=value"
        );
        assert_eq!(captured_headers[0].get(BAGGAGE_HEADER).unwrap(), "foo=bar");
    }

    #[tokio::test]
    async fn chat_completion_handler_translates_tool_followup_messages_for_responses_api() {
        let captured_requests = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let captured_requests_clone = Arc::clone(&captured_requests);
        let captured_headers = Arc::new(std::sync::Mutex::new(Vec::<HeaderMap>::new()));
        let captured_headers_clone = Arc::clone(&captured_headers);
        let bifrost_server = start_server(
            Router::new().route(
                "/openai/v1/responses",
                any(move |headers: HeaderMap, body: Bytes| {
                    let captured_requests = Arc::clone(&captured_requests_clone);
                    let captured_headers = Arc::clone(&captured_headers_clone);
                    async move {
                        let request_body: Value = serde_json::from_slice(&body).unwrap();
                        captured_requests.lock().unwrap().push(request_body);
                        captured_headers.lock().unwrap().push(headers);

                        let mut response = Response::new(Body::from(
                            r#"{"id":"resp_followup","output":[{"type":"message","content":[{"type":"output_text","text":"done"}]}],"usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}}"#,
                        ));
                        response
                            .headers_mut()
                            .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
                        response
                    }
                }),
            ),
        )
        .await;

        let response = chat_completions(
            State(test_state("http://unused", &bifrost_server.base_url)),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"GPT-5.4",
                    "messages":[
                        {"role":"user","content":"What are my meetings?"},
                        {
                            "role":"assistant",
                            "content":"Checking calendar",
                            "tool_calls":[
                                {
                                    "id":"call_1",
                                    "type":"function",
                                    "function":{
                                        "name":"google_workspace_get_events",
                                        "arguments":{"calendar_id":"primary"}
                                    }
                                }
                            ]
                        },
                        {
                            "role":"tool",
                            "tool_call_id":"call_1",
                            "content":"{\"overflow_file\":true}"
                        }
                    ]
                }))
                .unwrap(),
            ),
        )
        .await;

        let body = response_json(response).await;
        assert_eq!(body["choices"][0]["message"]["content"], json!("done"));

        let requests = captured_requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(
            requests[0]["input"],
            json!([
                {"role":"user","content":"What are my meetings?"},
                {"role":"assistant","content":"Checking calendar"},
                {"type":"function_call","call_id":"call_1","name":"google_workspace_get_events","arguments":"{\"calendar_id\":\"primary\"}"},
                {"type":"function_call_output","call_id":"call_1","output":"{\"overflow_file\":true}"}
            ])
        );
        assert!(requests[0]["input"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item.get("role").and_then(Value::as_str) != Some("tool")));
        let captured_headers = captured_headers.lock().unwrap();
        assert_eq!(captured_headers.len(), 1);
        assert_portico_contract_headers(&captured_headers[0], true, false);
    }

    #[test]
    fn responses_helpers_simulate_owui_tool_chat_followup_round_trip() {
        let entry = test_catalog().entries["GPT-5.4"].clone();

        let first_turn_payload = chat_completion_to_responses_payload(
            &json!({
                "stream": true,
                "model":"GPT-5.4",
                "messages":[{"role":"user","content":"What are my most important meetings this week?"}],
                "params":{"function_calling":"native"},
                "tool_ids":["server:google_workspace"],
                "tool_servers":[],
                "features":{"image_generation":false,"code_interpreter":false,"web_search":false},
                "variables":{"{{CURRENT_WEEKDAY}}":"Friday"},
                "model_item":{"id":"GPT-5.4"},
                "session_id":"session_meetings_1",
                "chat_id":"chat_meetings_1",
                "id":"message_meetings_1",
                "background_tasks":{"title_generation":false,"tags_generation":false,"follow_up_generation":false}
            }),
            &entry,
        )
        .unwrap();
        assert_eq!(
            first_turn_payload["input"],
            json!([{"role":"user","content":"What are my most important meetings this week?"}])
        );

        let first_turn_chunks = transform_bifrost_responses_event(
            "response.completed",
            &json!({
                "response":{
                    "id":"resp_meetings_tool",
                    "created_at":123,
                    "output":[
                        {
                            "type":"function_call",
                            "call_id":"call_meetings_1",
                            "name":"google_workspace_get_events",
                            "arguments":"{\"calendar_id\":\"primary\",\"time_min\":\"2026-03-09T00:00:00-04:00\",\"time_max\":\"2026-03-15T23:59:59-04:00\",\"max_results\":300,\"detailed\":true}"
                        }
                    ],
                    "incomplete_details":{"reason":"tool_calls"},
                    "usage":{"input_tokens":20,"output_tokens":6,"total_tokens":26}
                }
            }),
            &entry,
            None,
            &mut ResponsesStreamState::default(),
        )
        .unwrap();
        let first_turn_text = first_turn_chunks
            .iter()
            .map(|chunk| String::from_utf8(chunk.to_vec()).unwrap())
            .collect::<Vec<_>>()
            .join("");
        assert!(first_turn_text.contains("\"tool_calls\""));
        assert!(first_turn_text.contains("\"google_workspace_get_events\""));
        assert!(first_turn_text.contains("\"finish_reason\":\"tool_calls\""));
        assert!(first_turn_text.contains("data: [DONE]"));

        let second_turn_payload = chat_completion_to_responses_payload(
            &json!({
                "stream": true,
                "model":"GPT-5.4",
                "messages":[
                    {"role":"user","content":"What are my most important meetings this week?"},
                    {
                        "role":"assistant",
                        "content":"",
                        "tool_calls":[
                            {
                                "id":"call_meetings_1",
                                "type":"function",
                                "function":{
                                    "name":"google_workspace_get_events",
                                    "arguments":"{\"calendar_id\":\"primary\",\"time_min\":\"2026-03-09T00:00:00-04:00\",\"time_max\":\"2026-03-15T23:59:59-04:00\",\"max_results\":300,\"detailed\":true}"
                                }
                            }
                        ]
                    },
                    {
                        "role":"tool",
                        "tool_call_id":"call_meetings_1",
                        "content":"{\"overflow_file\":true,\"path\":\"/work/.mcp-overflow/events.json\"}"
                    }
                ],
                "params":{"function_calling":"native"},
                "tool_ids":["server:google_workspace"],
                "tool_servers":[],
                "features":{"image_generation":false,"code_interpreter":false,"web_search":false},
                "variables":{"{{CURRENT_WEEKDAY}}":"Friday"},
                "model_item":{"id":"GPT-5.4"},
                "session_id":"session_meetings_1",
                "chat_id":"chat_meetings_1",
                "id":"message_meetings_2",
                "background_tasks":{"title_generation":false,"tags_generation":false,"follow_up_generation":false}
            }),
            &entry,
        )
        .unwrap();
        assert_eq!(
            second_turn_payload["input"],
            json!([
                {"role":"user","content":"What are my most important meetings this week?"},
                {"type":"function_call","call_id":"call_meetings_1","name":"google_workspace_get_events","arguments":"{\"calendar_id\":\"primary\",\"time_min\":\"2026-03-09T00:00:00-04:00\",\"time_max\":\"2026-03-15T23:59:59-04:00\",\"max_results\":300,\"detailed\":true}"},
                {"type":"function_call_output","call_id":"call_meetings_1","output":"{\"overflow_file\":true,\"path\":\"/work/.mcp-overflow/events.json\"}"}
            ])
        );

        let mut second_turn_state = ResponsesStreamState::default();
        let mut second_turn_chunks = transform_bifrost_responses_event(
            "response.output_text.delta",
            &json!({"delta":"Your most important meetings this week are 1:1 with Alex and Staff Sync."}),
            &entry,
            None,
            &mut second_turn_state,
        )
        .unwrap();
        second_turn_chunks.extend(
            transform_bifrost_responses_event(
                "response.completed",
                &json!({
                    "response":{
                        "id":"resp_meetings_answer",
                        "created_at":124,
                        "output":[{"type":"message","content":[{"type":"output_text","text":"Your most important meetings this week are 1:1 with Alex and Staff Sync."}]}],
                        "usage":{"input_tokens":30,"output_tokens":12,"total_tokens":42}
                    }
                }),
                &entry,
                None,
                &mut second_turn_state,
            )
            .unwrap(),
        );
        let second_turn_text = second_turn_chunks
            .iter()
            .map(|chunk| String::from_utf8(chunk.to_vec()).unwrap())
            .collect::<Vec<_>>()
            .join("");
        assert!(second_turn_text
            .contains("Your most important meetings this week are 1:1 with Alex and Staff Sync."));
        assert!(second_turn_text.contains("\"finish_reason\":\"stop\""));
        assert!(second_turn_text.contains("data: [DONE]"));
    }

    #[tokio::test]
    async fn embeddings_handler_covers_success_and_failure_paths() {
        let captured_headers = Arc::new(std::sync::Mutex::new(Vec::<HeaderMap>::new()));
        let captured_headers_clone = Arc::clone(&captured_headers);
        let server = start_server(
            Router::new().route(
                "/v1/embeddings",
                any(move |headers: HeaderMap| {
                    let captured_headers = Arc::clone(&captured_headers_clone);
                    async move {
                    captured_headers.lock().unwrap().push(headers);
                    let mut response = Response::new(Body::from(
                        r#"{"data":[{"embedding":[0.1,0.2],"index":0}],"model":"openai/text-embedding-3-large","usage":{"prompt_tokens":5,"total_tokens":5}}"#,
                    ));
                    response.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
                    response.headers_mut().insert("x-portico-cost-usd", HeaderValue::from_static("0.01"));
                    response
                    }
                }),
            ),
        )
        .await;

        let invalid = embeddings(
            State(test_state(&server.base_url, "http://unused")),
            Bytes::from_static(b"bad"),
        )
        .await;
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);

        let success_response = embeddings(
            State(test_state(&server.base_url, "http://unused")),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"text-embedding-3-large",
                    "input":["hello"]
                }))
                .unwrap(),
            ),
        )
        .await;
        assert_eq!(
            success_response.headers().get(CONTENT_TYPE).unwrap(),
            "application/json"
        );
        assert_eq!(
            success_response.headers().get("x-portico-cost-usd").unwrap(),
            "0.01"
        );
        let success = response_json(success_response).await;
        assert_eq!(success["model"], json!("text-embedding-3-large"));
        assert_eq!(success["usage"]["cost"], json!(0.01));
        let captured_headers = captured_headers.lock().unwrap();
        assert_eq!(captured_headers.len(), 1);
        assert_portico_contract_headers(&captured_headers[0], true, true);

        let missing_model = embeddings(
            State(test_state(&server.base_url, "http://unused")),
            Bytes::from_static(br#"{}"#),
        )
        .await;
        assert_eq!(missing_model.status(), StatusCode::BAD_REQUEST);

        let unknown_model = embeddings(
            State(test_state(&server.base_url, "http://unused")),
            Bytes::from_static(br#"{"model":"unknown"}"#),
        )
        .await;
        assert_eq!(unknown_model.status(), StatusCode::NOT_FOUND);

        let unavailable = embeddings(
            State(test_state("http://127.0.0.1:9", "http://unused")),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"text-embedding-3-large",
                    "input":["hello"]
                }))
                .unwrap(),
            ),
        )
        .await;
        assert_eq!(unavailable.status(), StatusCode::BAD_GATEWAY);

        let bad_status_server = start_server(Router::new().route(
            "/v1/embeddings",
            any(|| async move { (StatusCode::BAD_GATEWAY, Body::from("bad embed")) }),
        ))
        .await;
        let bad_status = embeddings(
            State(test_state(&bad_status_server.base_url, "http://unused")),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"text-embedding-3-large",
                    "input":["hello"]
                }))
                .unwrap(),
            ),
        )
        .await;
        assert_eq!(bad_status.status(), StatusCode::BAD_GATEWAY);

        let invalid_json_server = start_server(Router::new().route(
            "/v1/embeddings",
            any(|| async move {
                let mut response = Response::new(Body::from("{"));
                response
                    .headers_mut()
                    .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
                response
            }),
        ))
        .await;
        let invalid_json = embeddings(
            State(test_state(&invalid_json_server.base_url, "http://unused")),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"text-embedding-3-large",
                    "input":["hello"]
                }))
                .unwrap(),
            ),
        )
        .await;
        assert_eq!(invalid_json.status(), StatusCode::BAD_GATEWAY);

        let array_json_server = start_server(Router::new().route(
            "/v1/embeddings",
            any(|| async move {
                let mut response = Response::new(Body::from(r#"[{"embedding":[0.1]}]"#));
                response
                    .headers_mut()
                    .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
                response
            }),
        ))
        .await;
        let array_json = response_text(
            embeddings(
                State(test_state(&array_json_server.base_url, "http://unused")),
                Bytes::from(
                    serde_json::to_vec(&json!({
                        "model":"text-embedding-3-large",
                        "input":["hello"]
                    }))
                    .unwrap(),
                ),
            )
            .await,
        )
        .await;
        assert!(array_json.starts_with("["));
    }

    #[tokio::test]
    async fn anthropic_messages_handler_covers_success_stream_and_failures() {
        let captured_headers = Arc::new(std::sync::Mutex::new(Vec::<HeaderMap>::new()));
        let captured_headers_clone = Arc::clone(&captured_headers);
        let llm_proxy = start_server(
            Router::new().route(
                "/bedrock/converse",
                any(move |headers: HeaderMap| {
                    let captured_headers = Arc::clone(&captured_headers_clone);
                    async move {
                        captured_headers.lock().unwrap().push(headers);
                        let mut response = Response::new(Body::from(
                            r#"{"output":{"message":{"content":[{"text":"ok"}]}},"usage":{"inputTokens":10,"outputTokens":5},"stopReason":"end_turn"}"#,
                        ));
                        response
                            .headers_mut()
                            .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
                        response
                    }
                }),
            ),
        )
        .await;
        let state = test_state("http://unused", &llm_proxy.base_url);

        let invalid_json = anthropic_messages(
            State(state.clone()),
            HeaderMap::new(),
            Bytes::from_static(b"bad"),
        )
        .await;
        assert_eq!(invalid_json.status(), StatusCode::BAD_REQUEST);

        let invalid_request = anthropic_messages(
            State(state.clone()),
            HeaderMap::new(),
            Bytes::from(serde_json::to_vec(&json!({"messages":[]})).unwrap()),
        )
        .await;
        assert_eq!(invalid_request.status(), StatusCode::BAD_REQUEST);

        let bad_header_state = AppState {
            provider_headers: ResolvedProviderHeaders {
                user_id: "bad\nuser".to_string(),
                ..state.provider_headers.clone()
            },
            ..state.clone()
        };
        let header_failure = anthropic_messages(
            State(bad_header_state),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"Claude Sonnet 4.5",
                    "messages":[{"role":"user","content":"hi"}]
                }))
                .unwrap(),
            ),
        )
        .await;
        assert_eq!(header_failure.status(), StatusCode::INTERNAL_SERVER_ERROR);

        let success_response = anthropic_messages(
            State(state.clone()),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"Claude Sonnet 4.5",
                    "messages":[{"role":"user","content":"hi"}]
                }))
                .unwrap(),
            ),
        )
        .await;
        assert_eq!(
            success_response.headers().get(CONTENT_TYPE).unwrap(),
            "application/json"
        );
        assert_eq!(
            success_response.headers().get("anthropic-version").unwrap(),
            ANTHROPIC_API_VERSION
        );
        let success = response_json(success_response).await;
        assert_eq!(success["model"], json!("Claude Sonnet 4.5"));
        assert_eq!(success["usage"]["input_tokens"], json!(10));
        let captured_headers = captured_headers.lock().unwrap();
        assert_eq!(captured_headers.len(), 1);
        assert_portico_contract_headers(&captured_headers[0], true, false);

        let stream_llm_proxy = start_server(
            Router::new().route(
                "/bedrock/converse",
                any(|| async move {
                    let mut response = Response::new(Body::from(
                        "data: {\"messageStart\":{\"role\":\"assistant\"}}\n\ndata: {\"contentBlockDelta\":{\"contentBlockIndex\":0,\"delta\":{\"text\":\"ok\"}}}\n\ndata: {\"messageStop\":{\"stopReason\":\"end_turn\"}}\n\ndata: {\"metadata\":{\"usage\":{\"inputTokens\":10,\"outputTokens\":5}}}\n\n",
                    ));
                    response.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
                    response
                }),
            ),
        )
        .await;
        let streamed = anthropic_messages(
            State(test_state("http://unused", &stream_llm_proxy.base_url)),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"Claude Sonnet 4.5",
                    "messages":[{"role":"user","content":"hi"}],
                    "stream": true
                }))
                .unwrap(),
            ),
        )
        .await;
        let streamed_text = response_text(streamed).await;
        assert!(streamed_text.contains("event: message_start"));
        assert!(streamed_text.contains("event: message_stop"));

        let reasoning_only_stream_llm_proxy = start_server(
            Router::new().route(
                "/bedrock/converse",
                any(|| async move {
                    let mut response = Response::new(Body::from(
                        "data: {\"contentBlockDelta\":{\"contentBlockIndex\":0,\"delta\":{\"reasoningContent\":{\"text\":\"thinking only\"}}}}\n\n",
                    ));
                    response.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
                    response
                }),
            ),
        )
        .await;
        let reasoning_only_stream = anthropic_messages(
            State(test_state(
                "http://unused",
                &reasoning_only_stream_llm_proxy.base_url,
            )),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"Claude Sonnet 4.5",
                    "messages":[{"role":"user","content":"hi"}],
                    "stream": true
                }))
                .unwrap(),
            ),
        )
        .await;
        let reasoning_only_stream_text = response_text(reasoning_only_stream).await;
        assert!(reasoning_only_stream_text.contains("event: content_block_delta"));
        assert!(reasoning_only_stream_text.contains("event: error"));
        assert!(reasoning_only_stream_text.contains("incomplete_stream"));

        let partial_text_stream_llm_proxy = start_server(
            Router::new().route(
                "/bedrock/converse",
                any(|| async move {
                    let mut response = Response::new(Body::from(
                        "data: {\"contentBlockDelta\":{\"contentBlockIndex\":0,\"delta\":{\"text\":\"partial\"}}}\n\n",
                    ));
                    response.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
                    response
                }),
            ),
        )
        .await;
        let partial_text_stream = anthropic_messages(
            State(test_state(
                "http://unused",
                &partial_text_stream_llm_proxy.base_url,
            )),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"Claude Sonnet 4.5",
                    "messages":[{"role":"user","content":"hi"}],
                    "stream": true
                }))
                .unwrap(),
            ),
        )
        .await;
        let partial_text_stream_text = response_text(partial_text_stream).await;
        assert!(partial_text_stream_text.contains("\"text\":\"partial\""));
        assert!(partial_text_stream_text.contains("event: content_block_stop"));
        assert!(partial_text_stream_text.contains("\"stop_reason\":\"incomplete_stream\""));
        assert!(partial_text_stream_text.contains("event: message_stop"));

        let error_llm_proxy = start_server(Router::new().route(
            "/bedrock/converse",
            any(|| async move { (StatusCode::BAD_GATEWAY, Body::from("proxy bad")) }),
        ))
        .await;
        let errored = anthropic_messages(
            State(test_state("http://unused", &error_llm_proxy.base_url)),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"Claude Sonnet 4.5",
                    "messages":[{"role":"user","content":"hi"}]
                }))
                .unwrap(),
            ),
        )
        .await;
        assert_eq!(errored.status(), StatusCode::BAD_GATEWAY);

        let unavailable = anthropic_messages(
            State(test_state("http://unused", "http://127.0.0.1:9")),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"Claude Sonnet 4.5",
                    "messages":[{"role":"user","content":"hi"}]
                }))
                .unwrap(),
            ),
        )
        .await;
        assert_eq!(unavailable.status(), StatusCode::BAD_GATEWAY);

        let broken_error_proxy = start_raw_http_server(
            b"HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nContent-Length: 20\r\n\r\nshort".to_vec(),
        )
        .await;
        let broken_error = anthropic_messages(
            State(test_state("http://unused", &broken_error_proxy)),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"Claude Sonnet 4.5",
                    "messages":[{"role":"user","content":"hi"}]
                }))
                .unwrap(),
            ),
        )
        .await;
        assert_eq!(broken_error.status(), StatusCode::BAD_GATEWAY);
        let broken_error_body = response_json(broken_error).await;
        assert_eq!(
            broken_error_body["error"]["message"],
            json!("Unable to reach the upstream model provider. Please retry.")
        );

        let invalid_json_llm_proxy = start_server(Router::new().route(
            "/bedrock/converse",
            any(|| async move {
                let mut response = Response::new(Body::from("{"));
                response
                    .headers_mut()
                    .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
                response
            }),
        ))
        .await;
        let invalid_json = anthropic_messages(
            State(test_state(
                "http://unused",
                &invalid_json_llm_proxy.base_url,
            )),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"Claude Sonnet 4.5",
                    "messages":[{"role":"user","content":"hi"}]
                }))
                .unwrap(),
            ),
        )
        .await;
        assert_eq!(invalid_json.status(), StatusCode::BAD_GATEWAY);

        let invalid_stream_llm_proxy = start_server(Router::new().route(
            "/bedrock/converse",
            any(|| async move {
                let mut response = Response::new(Body::from("data: [DONE]\n\ndata: {\n\n"));
                response
                    .headers_mut()
                    .insert(CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
                response
            }),
        ))
        .await;
        let invalid_stream = anthropic_messages(
            State(test_state(
                "http://unused",
                &invalid_stream_llm_proxy.base_url,
            )),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"Claude Sonnet 4.5",
                    "messages":[{"role":"user","content":"hi"}],
                    "stream": true
                }))
                .unwrap(),
            ),
        )
        .await;
        let invalid_stream_text = response_text(invalid_stream).await;
        assert!(invalid_stream_text.contains("event: error"));
        assert!(invalid_stream_text.contains(
            "Upstream model provider returned an invalid stream response. Please retry."
        ));

        let malformed_stream_base = start_raw_http_server(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\nZZ\r\nbad\r\n0\r\n\r\n"
                .to_vec(),
        )
        .await;
        let malformed_stream = anthropic_messages(
            State(test_state("http://unused", &malformed_stream_base)),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"Claude Sonnet 4.5",
                    "messages":[{"role":"user","content":"hi"}],
                    "stream": true
                }))
                .unwrap(),
            ),
        )
        .await;
        let malformed_stream_text = response_text(malformed_stream).await;
        assert!(malformed_stream_text.contains("event: error"));
        assert!(
            malformed_stream_text.contains("Upstream model provider stream failed. Please retry.")
        );

        let invalid_utf8_base = start_raw_http_server(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 3\r\n\r\n\xff\xfe\n"
                .to_vec(),
        )
        .await;
        let invalid_utf8 = anthropic_messages(
            State(test_state("http://unused", &invalid_utf8_base)),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"Claude Sonnet 4.5",
                    "messages":[{"role":"user","content":"hi"}],
                    "stream": true
                }))
                .unwrap(),
            ),
        )
        .await;
        let invalid_utf8_text = response_text(invalid_utf8).await;
        assert!(invalid_utf8_text.contains("event: error"));
        assert!(invalid_utf8_text
            .contains("Upstream model provider returned invalid stream data. Please retry."));
    }

    #[tokio::test]
    async fn anthropic_messages_rejects_tool_use_stop_without_tool_block() {
        let temp = tempdir().unwrap();
        let malformed_tool_use_proxy = start_server(Router::new().route(
            "/bedrock/converse",
            any(|| async move {
                let mut events = vec![json!({"messageStart":{"role":"assistant"}})];
                for index in 0..19 {
                    events.push(json!({
                        "contentBlockDelta": {
                            "contentBlockIndex": 0,
                            "delta": {
                                "reasoningContent": {
                                    "text": format!("thinking-{index}")
                                }
                            }
                        }
                    }));
                }
                events.push(json!({"contentBlockStop":{"contentBlockIndex":0}}));
                events.push(json!({"other":"ignored"}));
                events.push(json!({"messageStop":{"stopReason":"tool_use"}}));
                events.push(json!({
                    "metadata": {
                        "usage": {
                            "inputTokens": 148040,
                            "outputTokens": 302,
                            "totalTokens": 148342
                        }
                    }
                }));
                assert_eq!(events.len(), 24);

                let body = events
                    .into_iter()
                    .map(|event| format!("data: {event}\n\n"))
                    .collect::<String>();
                let mut response = Response::new(Body::from(body));
                response
                    .headers_mut()
                    .insert(CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
                response.headers_mut().insert(
                    "x-request-id",
                    HeaderValue::from_static("proxy-malformed-tool-use"),
                );
                response
            }),
        ))
        .await;
        let state = test_state_with_reporting_dir(
            "http://unused",
            &malformed_tool_use_proxy.base_url,
            temp.path().to_path_buf(),
        );
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-openwebui-chat-id",
            HeaderValue::from_static("chat-malformed-tool-use"),
        );
        headers.insert(
            "x-openwebui-message-id",
            HeaderValue::from_static("msg-malformed-tool-use"),
        );
        headers.insert(
            "x-openwebui-session-id",
            HeaderValue::from_static("session-malformed-tool-use"),
        );
        headers.insert(
            "x-openwebui-upstream-request-id",
            HeaderValue::from_static("owui-malformed-tool-use"),
        );

        let response = anthropic_messages(
            State(state),
            headers,
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"Claude Opus 4.8",
                    "system":"private system instructions",
                    "messages":[
                        {"role":"user","content":"private user prompt"},
                        {"role":"assistant","content":[
                            {
                                "type":"thinking",
                                "thinking":"private reasoning text",
                                "signature":"private reasoning signature"
                            },
                            {
                                "type":"tool_use",
                                "id":"toolu_prior",
                                "name":"lookup",
                                "input":{"private":"argument"}
                            }
                        ]},
                        {"role":"user","content":[{
                            "type":"tool_result",
                            "tool_use_id":"toolu_prior",
                            "content":"private employee result"
                        }]}
                    ],
                    "tools":[{
                        "name":"lookup",
                        "description":"Lookup data",
                        "input_schema":{"type":"object"}
                    }],
                    "stream": true
                }))
                .unwrap(),
            ),
        )
        .await;

        let response_body = response_text(response).await;
        assert!(response_body.contains("event: error"));
        assert!(response_body.contains(BEDROCK_MALFORMED_TOOL_USE_ERROR_KIND));
        assert!(!response_body.contains("\"stop_reason\":\"tool_use\""));
        assert!(!response_body.contains("event: message_stop"));

        let mut entries = fs::read_dir(temp.path().join("errors")).await.unwrap();
        let event_path = entries.next_entry().await.unwrap().unwrap().path();
        assert!(entries.next_entry().await.unwrap().is_none());
        let event_body = fs::read_to_string(event_path).await.unwrap();
        let event: Value = serde_json::from_str(&event_body).unwrap();
        assert_eq!(event["eventType"], json!("llm_stream_failure"));
        assert_eq!(event["chatId"], json!("chat-malformed-tool-use"));
        assert_eq!(event["messageId"], json!("msg-malformed-tool-use"));
        assert_eq!(event["sessionId"], json!("session-malformed-tool-use"));
        assert_eq!(event["upstreamRequestId"], json!("owui-malformed-tool-use"));
        assert_eq!(
            event["upstreamResponseHeaders"]["x-request-id"],
            json!("proxy-malformed-tool-use")
        );
        assert_eq!(event["failure"]["kind"], json!("malformed_tool_use"));
        assert_eq!(
            event["failure"]["code"],
            json!(BEDROCK_MALFORMED_TOOL_USE_ERROR_KIND)
        );
        assert_eq!(event["streamProgress"]["rawChunkCount"], json!(23));
        assert_eq!(event["streamProgress"]["thinkingDeltaEvents"], json!(19));
        assert_eq!(event["streamProgress"]["toolUseBlocks"], json!(0));
        assert_eq!(event["streamProgress"]["messageStopObserved"], json!(true));
        assert_eq!(event["streamProgress"]["rawStopReason"], json!("tool_use"));
        assert_eq!(event["streamProgress"]["messageStopEmitted"], json!(false));
        assert_eq!(event["failure"]["origin"], json!("upstream_event_sequence"));
        assert_eq!(event["failure"]["rawStopReason"], json!("tool_use"));
        assert_eq!(event["requestShape"]["messageCount"], json!(3));
        assert_eq!(event["requestShape"]["systemBlockCount"], json!(1));
        assert_eq!(event["requestShape"]["toolSpecCount"], json!(1));
        assert_eq!(event["requestShape"]["toolUseBlockCount"], json!(1));
        assert_eq!(event["requestShape"]["toolResultBlockCount"], json!(1));
        assert_eq!(event["requestShape"]["reasoningBlockCount"], json!(1));
        assert_eq!(event["requestShape"]["reasoningSignatureCount"], json!(1));
        assert!(!event_body.contains("thinking-"));
        assert!(!event_body.contains("private system instructions"));
        assert!(!event_body.contains("private user prompt"));
        assert!(!event_body.contains("private reasoning text"));
        assert!(!event_body.contains("private reasoning signature"));
        assert!(!event_body.contains("private employee result"));
        assert!(!event_body.contains("\"argument\""));
        assert!(!event_body.contains("\"lookup\""));
    }

    #[tokio::test]
    async fn anthropic_messages_stream_read_failures_write_reporting_event() {
        let temp = tempdir().unwrap();
        let malformed_stream_base = start_raw_http_server(raw_chunked_http_response(
            &[
                ("Content-Type", "text/event-stream"),
                ("Transfer-Encoding", "chunked"),
                ("X-Request-Id", "req_upstream_123"),
                ("Server", "test-nginx"),
                ("Via", "test-proxy"),
                ("Authorization", "Bearer test-gateway-secret"),
                ("X-Portico-Userid", "test-user-id"),
            ],
            &[
                b"data: {\"messageStart\":{\"role\":\"assistant\"}}\n\n".to_vec(),
                b"data: {\"contentBlockStart\":{\"contentBlockIndex\":1,\"start\":{\"toolUse\":{\"toolUseId\":\"toolu_1\",\"name\":\"agent_vm_create_file\"}}}}\n\n".to_vec(),
                b"data: {\"contentBlockDelta\":{\"contentBlockIndex\":1,\"delta\":{\"toolUse\":{\"input\":\"{\\\"path\\\":\\\"out.md\\\"}\"}}}}\n\n".to_vec(),
            ],
            b"ZZ\r\nbad\r\n",
        ))
        .await;
        let state = test_state_with_reporting_dir(
            "http://unused",
            &malformed_stream_base,
            temp.path().to_path_buf(),
        );
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-openwebui-chat-id",
            HeaderValue::from_static("chat-stream-1"),
        );
        headers.insert(
            "x-openwebui-message-id",
            HeaderValue::from_static("msg-stream-1"),
        );
        headers.insert(
            "x-openwebui-session-id",
            HeaderValue::from_static("session-stream-1"),
        );

        let response = anthropic_messages(
            State(state),
            headers,
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"Claude Sonnet 4.5",
                    "messages":[{"role":"user","content":"hi"}],
                    "tools":[
                        {
                            "name":"agent_vm_create_file",
                            "description":"Create a file",
                            "input_schema":{"type":"object"}
                        }
                    ],
                    "stream": true
                }))
                .unwrap(),
            ),
        )
        .await;

        let response_body = response_text(response).await;
        assert!(response_body.contains("event: error"));
        assert!(response_body.contains("Upstream model provider stream failed. Please retry."));

        let mut entries = fs::read_dir(temp.path().join("errors")).await.unwrap();
        let mut event_paths = Vec::new();
        while let Some(entry) = entries.next_entry().await.unwrap() {
            event_paths.push(entry.path());
        }
        assert_eq!(event_paths.len(), 1);

        let event_body = fs::read_to_string(&event_paths[0]).await.unwrap();
        let event: Value = serde_json::from_str(&event_body).unwrap();
        assert_eq!(event["eventType"], json!("llm_stream_failure"));
        assert_eq!(event["chatId"], json!("chat-stream-1"));
        assert_eq!(event["messageId"], json!("msg-stream-1"));
        assert_eq!(event["endpoint"], json!("bedrock-converse"));
        assert_eq!(event["modelName"], json!("Claude Sonnet 4.5"));
        assert_eq!(
            event["upstreamResponseHeaders"]["content-type"],
            json!("text/event-stream")
        );
        assert_eq!(
            event["upstreamResponseHeaders"]["transfer-encoding"],
            json!("chunked")
        );
        assert_eq!(
            event["upstreamResponseHeaders"]["x-request-id"],
            json!("req_upstream_123")
        );
        assert_eq!(
            event["upstreamResponseHeaders"]["server"],
            json!("test-nginx")
        );
        assert_eq!(event["upstreamResponseHeaders"]["via"], json!("test-proxy"));
        assert!(event["upstreamResponseHeaders"]
            .get("authorization")
            .is_none());
        assert!(event["upstreamResponseHeaders"]
            .get("x-portico-userid")
            .is_none());
        assert!(!event_body.contains("test-gateway-secret"));
        assert!(!event_body.contains("test-user-id"));
        assert!(event["failure"]["rawError"]
            .as_str()
            .unwrap()
            .contains("error decoding response body"));
        assert!(event["failure"]["errorChain"]
            .as_array()
            .is_some_and(|items| !items.is_empty()));
        assert!(
            event["failure"]["isBody"].as_bool().unwrap_or(false)
                || event["failure"]["isDecode"].as_bool().unwrap_or(false)
        );
        assert_eq!(event["streamProgress"]["sawUpstreamProgress"], json!(true));
        assert_eq!(
            event["streamProgress"]["streamStage"],
            json!("after_tool_input_started")
        );
        assert_eq!(event["streamProgress"]["rawChunkCount"], json!(3));
        assert_eq!(event["streamProgress"]["toolUseBlocks"], json!(1));
        assert_eq!(event["streamProgress"]["toolInputDeltaEvents"], json!(1));
    }

    #[tokio::test]
    async fn anthropic_messages_direct_requests_persist_usage_events() {
        let temp = tempdir().unwrap();
        let llm_proxy = start_server(
            Router::new().route(
                "/bedrock/converse",
                any(|| async move {
                    let mut response = Response::new(Body::from(
                        r#"{"output":{"message":{"content":[{"text":"ok"}]}},"usage":{"inputTokens":10,"outputTokens":5,"cacheReadInputTokens":4,"cacheWriteInputTokens":2},"stopReason":"end_turn"}"#,
                    ));
                    response
                        .headers_mut()
                        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
                    response
                }),
            ),
        )
        .await;
        let state = test_state_with_reporting_dir(
            "http://unused",
            &llm_proxy.base_url,
            temp.path().to_path_buf(),
        );
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-openwebui-chat-id",
            HeaderValue::from_static("chat-direct-1"),
        );
        headers.insert(
            "x-openwebui-message-id",
            HeaderValue::from_static("msg-direct-1"),
        );

        let response = anthropic_messages(
            State(state),
            headers,
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"Claude Sonnet 4.5",
                    "messages":[{"role":"user","content":"hi"}]
                }))
                .unwrap(),
            ),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let _ = response_json(response).await;

        let mut entries = fs::read_dir(temp.path().join("events")).await.unwrap();
        let mut event_paths = Vec::new();
        while let Some(entry) = entries.next_entry().await.unwrap() {
            event_paths.push(entry.path());
        }
        assert_eq!(event_paths.len(), 1);

        let event_body = fs::read_to_string(&event_paths[0]).await.unwrap();
        let event: Value = serde_json::from_str(&event_body).unwrap();
        assert_eq!(event["chatId"], json!("chat-direct-1"));
        assert_eq!(event["messageId"], json!("msg-direct-1"));
        assert_eq!(event["modelName"], json!("Claude Sonnet 4.5"));
        assert_eq!(event["usage"]["input_tokens"], json!(10));
        assert_eq!(event["usage"]["output_tokens"], json!(5));
        assert_eq!(event["usage"]["cache_creation_input_tokens"], json!(2));
    }

    #[tokio::test]
    async fn anthropic_messages_forwarded_nested_requests_skip_usage_events() {
        let temp = tempdir().unwrap();
        let llm_proxy = start_server(
            Router::new().route(
                "/bedrock/converse",
                any(|| async move {
                    let mut response = Response::new(Body::from(
                        r#"{"output":{"message":{"content":[{"text":"ok"}]}},"usage":{"inputTokens":10,"outputTokens":5,"cacheReadInputTokens":4,"cacheWriteInputTokens":2},"stopReason":"end_turn"}"#,
                    ));
                    response
                        .headers_mut()
                        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
                    response
                }),
            ),
        )
        .await;
        let state = test_state_with_reporting_dir(
            "http://unused",
            &llm_proxy.base_url,
            temp.path().to_path_buf(),
        );
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-openwebui-chat-id",
            HeaderValue::from_static("chat-forwarded-1"),
        );
        headers.insert(
            "x-openwebui-message-id",
            HeaderValue::from_static("msg-forwarded-1"),
        );
        headers.insert(
            "x-bf-eh-x-openwebui-chat-id",
            HeaderValue::from_static("chat-forwarded-1"),
        );
        headers.insert(
            "x-bf-eh-x-openwebui-message-id",
            HeaderValue::from_static("msg-forwarded-1"),
        );

        let response = anthropic_messages(
            State(state),
            headers,
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model":"us.anthropic.claude-sonnet-4-5-20250929-v1:0",
                    "messages":[{"role":"user","content":"hi"}]
                }))
                .unwrap(),
            ),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let _ = response_json(response).await;

        let events_dir = temp.path().join("events");
        assert!(!fs::try_exists(&events_dir).await.unwrap());
    }

    #[tokio::test]
    async fn build_app_allows_anthropic_payloads_larger_than_axum_default_limit() {
        let llm_proxy = start_server(
            Router::new().route(
                "/bedrock/converse",
                any(|| async move {
                    let mut response = Response::new(Body::from(
                        r#"{"output":{"message":{"content":[{"text":"ok"}]}},"usage":{"inputTokens":10,"outputTokens":5},"stopReason":"end_turn"}"#,
                    ));
                    response
                        .headers_mut()
                        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
                    response
                }),
            ),
        )
        .await;
        let app_server = start_server(build_app(
            test_state("http://unused", &llm_proxy.base_url),
            None,
        ))
        .await;

        let response = reqwest::Client::new()
            .post(format!(
                "{}/internal/anthropic/v1/messages",
                app_server.base_url
            ))
            .json(&json!({
                "model": "Claude Sonnet 4.5",
                "messages": [{"role": "user", "content": "a".repeat(3_000_000)}],
            }))
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn gemini_vertex_proxy_forwards_to_llm_proxy_with_portico_auth_and_headers() {
        let (seen_tx, seen_rx) = oneshot::channel::<Value>();
        let seen_tx = Arc::new(std::sync::Mutex::new(Some(seen_tx)));
        let llm_proxy = start_server(Router::new().fallback(any({
            let seen_tx = Arc::clone(&seen_tx);
            move |request: Request| {
                let seen_tx = Arc::clone(&seen_tx);
                async move {
                    let (parts, body) = request.into_parts();
                    let headers = parts.headers;
                    let path = parts
                        .uri
                        .path_and_query()
                        .map(|value| value.as_str().to_string())
                        .unwrap_or_default();
                    let body_bytes = to_bytes(body, usize::MAX).await.unwrap();
                    let payload = serde_json::from_slice::<Value>(&body_bytes).unwrap();

                    if let Some(sender) = seen_tx.lock().unwrap().take() {
                        let _ = sender.send(json!({
                            "path": path,
                            "authorization": headers
                                .get(header::AUTHORIZATION)
                                .and_then(|value| value.to_str().ok())
                                .unwrap_or(""),
                            "accept": headers
                                .get(header::ACCEPT)
                                .and_then(|value| value.to_str().ok())
                                .unwrap_or(""),
                            "vertexRequestType": headers
                                .get("x-vertex-ai-llm-request-type")
                                .and_then(|value| value.to_str().ok())
                                .unwrap_or(""),
                            "vertexSharedRequestType": headers
                                .get("x-vertex-ai-llm-shared-request-type")
                                .and_then(|value| value.to_str().ok())
                                .unwrap_or(""),
                            "xGoogApiKey": headers
                                .get("x-goog-api-key")
                                .and_then(|value| value.to_str().ok()),
                            "user": headers
                                .get("x-portico-userid")
                                .and_then(|value| value.to_str().ok())
                                .unwrap_or(""),
                            "payload": payload
                        }));
                    }

                    let mut response = Response::new(Body::from(
                        r#"{"candidates":[{"content":{"parts":[{"text":"gemini ok"}]}}],"usageMetadata":{"cachedContentTokenCount":12}}"#,
                    ));
                    response
                        .headers_mut()
                        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
                    response.headers_mut().insert(
                        HeaderName::from_static("x-goog-request-id"),
                        HeaderValue::from_static("google-request-1"),
                    );
                    response
                }
            }
        })))
        .await;
        let app_server = start_server(build_app(
            test_state("http://unused", &llm_proxy.base_url),
            None,
        ))
        .await;

        let response = reqwest::Client::new()
            .post(format!(
                "{}/internal/gemini/v1beta1/publishers/google/models/gemini-3.5-flash:generateContent",
                app_server.base_url
            ))
            .header("x-goog-api-key", "bifrost-placeholder")
            .header("Accept", "application/json")
            .header("X-Vertex-AI-LLM-Request-Type", "shared")
            .header("X-Vertex-AI-LLM-Shared-Request-Type", "standard")
            .json(&json!({
                "contents": [
                    {"role": "user", "parts": [{"text": "hello"}]}
                ],
                "params": {"function_calling": "native"}
            }))
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get("x-goog-request-id").unwrap(),
            "google-request-1"
        );
        assert!(response.text().await.unwrap().contains("gemini ok"));

        let seen = seen_rx.await.unwrap();
        assert_eq!(
            seen["path"],
            json!("/gemini/v1beta1/publishers/google/models/gemini-3.5-flash:generateContent")
        );
        assert_eq!(seen["authorization"], json!("Bearer key"));
        assert_eq!(seen["accept"], json!("application/json"));
        assert_eq!(seen["vertexRequestType"], json!("shared"));
        assert_eq!(seen["vertexSharedRequestType"], json!("standard"));
        assert!(seen["xGoogApiKey"].is_null());
        assert_eq!(seen["user"], json!("user"));
        assert!(seen["payload"].get("params").is_none());
        assert_eq!(
            seen["payload"]["contents"][0]["parts"][0]["text"],
            json!("hello")
        );
    }

    #[tokio::test]
    async fn gemini_vertex_proxy_trims_function_declarations_and_preserves_agent_vm_tools() {
        let (seen_tx, seen_rx) = oneshot::channel::<Value>();
        let seen_tx = Arc::new(std::sync::Mutex::new(Some(seen_tx)));
        let llm_proxy = start_server(Router::new().fallback(any({
            let seen_tx = Arc::clone(&seen_tx);
            move |request: Request| {
                let seen_tx = Arc::clone(&seen_tx);
                async move {
                    let body_bytes = to_bytes(request.into_body(), usize::MAX).await.unwrap();
                    let payload = serde_json::from_slice::<Value>(&body_bytes).unwrap();
                    if let Some(sender) = seen_tx.lock().unwrap().take() {
                        let _ = sender.send(payload);
                    }
                    Response::new(Body::from(
                        r#"{"candidates":[{"content":{"parts":[{"text":"gemini ok"}]}}]}"#,
                    ))
                }
            }
        })))
        .await;
        let app_server = start_server(build_app(
            test_state("http://unused", &llm_proxy.base_url),
            None,
        ))
        .await;

        let mut function_declarations = (0..520)
            .map(|index| json!({"name": format!("ordinary_tool_{index}")}))
            .collect::<Vec<_>>();
        function_declarations.push(json!({"name": "agent_vm_bash"}));
        function_declarations.push(json!({"name": "agent_vm_create"}));

        let response = reqwest::Client::new()
            .post(format!(
                "{}/internal/gemini/v1beta1/publishers/google/models/gemini-3.5-flash:generateContent",
                app_server.base_url
            ))
            .json(&json!({
                "contents": [
                    {"role": "user", "parts": [{"text": "hello"}]}
                ],
                "tools": [
                    {"function_declarations": function_declarations}
                ]
            }))
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let seen = seen_rx.await.unwrap();
        let forwarded = seen["tools"][0]["function_declarations"]
            .as_array()
            .unwrap();
        assert_eq!(forwarded.len(), GEMINI_VERTEX_MAX_FUNCTION_DECLARATIONS);
        let names = forwarded
            .iter()
            .filter_map(|value| value.get("name").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert_eq!(names.first(), Some(&"agent_vm_create"));
        assert!(names.contains(&"agent_vm_bash"));
        assert!(!names.contains(&"ordinary_tool_519"));
    }

    #[tokio::test]
    async fn gemini_vertex_proxy_infers_missing_function_schema_types() {
        let (seen_tx, seen_rx) = oneshot::channel::<Value>();
        let seen_tx = Arc::new(std::sync::Mutex::new(Some(seen_tx)));
        let llm_proxy = start_server(Router::new().fallback(any({
            let seen_tx = Arc::clone(&seen_tx);
            move |request: Request| {
                let seen_tx = Arc::clone(&seen_tx);
                async move {
                    let body_bytes = to_bytes(request.into_body(), usize::MAX).await.unwrap();
                    let payload = serde_json::from_slice::<Value>(&body_bytes).unwrap();
                    if let Some(sender) = seen_tx.lock().unwrap().take() {
                        let _ = sender.send(payload);
                    }
                    Response::new(Body::from(
                        r#"{"candidates":[{"content":{"parts":[{"text":"gemini ok"}]}}]}"#,
                    ))
                }
            }
        })))
        .await;
        let app_server = start_server(build_app(
            test_state("http://unused", &llm_proxy.base_url),
            None,
        ))
        .await;

        let response = reqwest::Client::new()
            .post(format!(
                "{}/internal/gemini/v1beta1/publishers/google/models/gemini-3.5-flash:generateContent",
                app_server.base_url
            ))
            .json(&json!({
                "contents": [
                    {"role": "user", "parts": [{"text": "hello"}]}
                ],
                "tools": [
                    {
                        "function_declarations": [
                            {
                                "name": "productkit_mcp_conjure_create_claim",
                                "parameters": {
                                    "properties": {
                                        "review": {
                                            "properties": {
                                                "review_state": {
                                                    "enum": ["APPROVED", "REJECTED"]
                                                },
                                                "priority": {
                                                    "minimum": 0,
                                                    "maximum": 100
                                                },
                                                "yaml_config": {
                                                    "properties": {
                                                        "present": {"type": "string"}
                                                    },
                                                    "required": [
                                                        "missing_a",
                                                        "present",
                                                        "missing_b"
                                                    ]
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        ]
                    }
                ]
            }))
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let seen = seen_rx.await.unwrap();
        assert_eq!(
            seen["tools"][0]["function_declarations"][0]["parameters"]["type"],
            json!("object")
        );
        assert_eq!(
            seen["tools"][0]["function_declarations"][0]["parameters"]["properties"]["review"]
                ["type"],
            json!("object")
        );
        assert_eq!(
            seen["tools"][0]["function_declarations"][0]["parameters"]["properties"]["review"]
                ["properties"]["review_state"]["type"],
            json!("string")
        );
        assert_eq!(
            seen["tools"][0]["function_declarations"][0]["parameters"]["properties"]["review"]
                ["properties"]["priority"]["type"],
            json!("number")
        );
        assert_eq!(
            seen["tools"][0]["function_declarations"][0]["parameters"]["properties"]["review"]
                ["properties"]["yaml_config"]["required"],
            json!(["present"])
        );
    }

    #[tokio::test]
    async fn gemini_vertex_proxy_removes_openai_function_call_ids_from_contents() {
        let (seen_tx, seen_rx) = oneshot::channel::<Value>();
        let seen_tx = Arc::new(std::sync::Mutex::new(Some(seen_tx)));
        let llm_proxy = start_server(Router::new().fallback(any({
            let seen_tx = Arc::clone(&seen_tx);
            move |request: Request| {
                let seen_tx = Arc::clone(&seen_tx);
                async move {
                    let body_bytes = to_bytes(request.into_body(), usize::MAX).await.unwrap();
                    let payload = serde_json::from_slice::<Value>(&body_bytes).unwrap();
                    if let Some(sender) = seen_tx.lock().unwrap().take() {
                        let _ = sender.send(payload);
                    }
                    Response::new(Body::from(
                        r#"{"candidates":[{"content":{"parts":[{"text":"gemini ok"}]}}]}"#,
                    ))
                }
            }
        })))
        .await;
        let app_server = start_server(build_app(
            test_state("http://unused", &llm_proxy.base_url),
            None,
        ))
        .await;

        let response = reqwest::Client::new()
            .post(format!(
                "{}/internal/gemini/v1beta1/publishers/google/models/gemini-3.5-flash:generateContent",
                app_server.base_url
            ))
            .json(&json!({
                "contents": [
                    {"role": "user", "parts": [{"text": "hello"}]},
                    {
                        "role": "model",
                        "parts": [
                            {
                                "function_call": {
                                    "id": "call_1",
                                    "name": "agent_vm_bash",
                                    "args": {"command": "echo hi"}
                                }
                            }
                        ]
                    },
                    {
                        "role": "user",
                        "parts": [
                            {
                                "function_response": {
                                    "id": "call_1",
                                    "name": "agent_vm_bash",
                                    "response": {"result": "hi"}
                                }
                            }
                        ]
                    }
                ]
            }))
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let seen = seen_rx.await.unwrap();
        assert!(seen["contents"][1]["parts"][0]["function_call"]
            .get("id")
            .is_none());
        assert!(seen["contents"][2]["parts"][0]["function_response"]
            .get("id")
            .is_none());
        assert_eq!(
            seen["contents"][1]["parts"][0]["function_call"]["name"],
            json!("agent_vm_bash")
        );
        assert_eq!(
            seen["contents"][2]["parts"][0]["function_response"]["name"],
            json!("agent_vm_bash")
        );
    }

    #[tokio::test]
    async fn gemini_vertex_proxy_preserves_stream_response_body() {
        let llm_proxy = start_server(Router::new().fallback(any(|request: Request| async move {
            assert_eq!(
                request
                    .uri()
                    .path_and_query()
                    .map(|value| value.as_str())
                    .unwrap_or(""),
                "/gemini/v1beta1/publishers/google/models/gemini-3.5-flash:streamGenerateContent"
            );
            assert_eq!(
                request.headers().get(header::AUTHORIZATION).unwrap(),
                "Bearer key"
            );
            assert!(request.headers().get("x-goog-api-key").is_none());

            let mut response = Response::new(Body::from(
                "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"hi\"}]}}]}\n\n",
            ));
            response
                .headers_mut()
                .insert(CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
            response
        })))
        .await;
        let app_server = start_server(build_app(
            test_state("http://unused", &llm_proxy.base_url),
            None,
        ))
        .await;

        let response = reqwest::Client::new()
            .post(format!(
                "{}/internal/gemini/v1beta1/publishers/google/models/gemini-3.5-flash:streamGenerateContent",
                app_server.base_url
            ))
            .json(&json!({
                "contents": [
                    {"role": "user", "parts": [{"text": "hello"}]}
                ]
            }))
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(CONTENT_TYPE).unwrap(),
            "text/event-stream"
        );
        assert_eq!(
            response.text().await.unwrap(),
            "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"hi\"}]}}]}\n\n"
        );
    }

    #[tokio::test]
    async fn ultra_namespaced_claim_returns_only_the_canonical_registered_name() {
        let state = test_state("http://unused", "http://127.0.0.1:9");
        let call = UltraToolCall {
            output_index: 0,
            item_id: "item-glean".to_string(),
            call_id: "call-glean".to_string(),
            name: "search".to_string(),
            namespace: Some("glean".to_string()),
            registered_name: "glean_search".to_string(),
            arguments: "{\"query\":\"rust\"}".to_string(),
            agent_name: "/root".to_string(),
            payload_digest: ultra_multi_agent::body_sha256(b"pre-bind"),
        };
        let token = store_initial_ultra_batch(
            &state,
            &ultra_test_origin(),
            Instant::now(),
            ultra_test_entry(),
            json!({
                "model": "gpt-5.6-sol",
                "input": [{"role": "user", "content": "test"}],
                "tools": [{
                    "type": "namespace",
                    "name": "glean",
                    "tools": [{
                        "type": "function",
                        "name": "search",
                        "parameters": {"type": "object"}
                    }]
                }, {"type": "tool_search"}],
                "store": false,
                "stream": true,
                "multi_agent": {"enabled": true, "max_concurrent_subagents": 4},
                "reasoning": {"effort": "max"},
                "prompt_cache_key": "portico-ultra-v1-test",
                "prompt_cache_retention": "24h"
            }),
            "resp-namespaced".to_string(),
            vec![call],
            json!({"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}),
            vec![json!({
                "id": "item-glean",
                "type": "function_call",
                "call_id": "call-glean",
                "namespace": "glean",
                "name": "search",
                "arguments": "{\"query\":\"rust\"}",
                "agent": {"agent_name": "/root"}
            })],
            None,
            "test-ultra-namespaced".to_string(),
        )
        .await
        .unwrap();
        let claim =
            response_json(ultra_batch_claim(State(state.clone()), Path(token.clone())).await).await;
        assert_eq!(claim["calls"][0]["name"], json!("glean_search"));
        let stored = &state.ultra_batches.lock().await[&token].calls[0];
        assert_eq!(stored.namespace.as_deref(), Some("glean"));
        assert_eq!(stored.registered_name, "glean_search");
    }

    #[tokio::test]
    async fn ultra_batch_routes_require_the_bridge_bearer() {
        let state = test_state("http://unused", "http://127.0.0.1:9");
        let token =
            seed_ultra_batch(&state, vec![ultra_test_call(0, "call-bearer-protected")]).await;
        let server = start_server(build_app_with_local_api_key(
            state.clone(),
            None,
            Some("route-local-bearer".to_string()),
        ))
        .await;
        let url = format!("{}/internal/ultra/batches/{}/claim", server.base_url, token);
        let client = reqwest::Client::new();

        assert_eq!(
            client.post(&url).send().await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            client
                .post(&url)
                .bearer_auth("wrong")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            client
                .post(&url)
                .bearer_auth("route-local-bearer")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }

    #[test]
    fn ultra_resource_caps_fail_closed() {
        let started_at = Instant::now();
        let base = OpaqueRoundState::new("fingerprint".to_string(), Vec::new());
        assert!(validate_ultra_turn_limits(&base, &UltraAudit::default(), started_at).is_ok());

        let mut excessive_calls = UltraAudit::default();
        excessive_calls.tool_call_count = ULTRA_MAX_TOTAL_CALLS + 1;
        assert!(validate_ultra_turn_limits(&base, &excessive_calls, started_at).is_err());

        let mut excessive_rounds = UltraAudit::default();
        excessive_rounds.continuation_count = ULTRA_MAX_CONTINUATIONS + 1;
        assert!(validate_ultra_turn_limits(&base, &excessive_rounds, started_at).is_err());

        let mut excessive_tokens = base.clone();
        excessive_tokens.cumulative_usage.total_tokens = ULTRA_MAX_CUMULATIVE_TOKENS + 1;
        assert!(
            validate_ultra_turn_limits(&excessive_tokens, &UltraAudit::default(), started_at)
                .is_err()
        );

        let mut excessive_cost = base.clone();
        excessive_cost.cumulative_usage.cost_microusd = ULTRA_MAX_COST_MICROUSD + 1;
        assert!(
            validate_ultra_turn_limits(&excessive_cost, &UltraAudit::default(), started_at)
                .is_err()
        );

        let excessive_transcript = OpaqueRoundState::new(
            "fingerprint".to_string(),
            vec![Value::String("x".repeat(ULTRA_MAX_TRANSCRIPT_BYTES + 1))],
        );
        assert!(validate_ultra_turn_limits(
            &excessive_transcript,
            &UltraAudit::default(),
            started_at,
        )
        .is_err());

        let expired_start = Instant::now()
            .checked_sub(ULTRA_MAX_WALL_TIME + Duration::from_secs(1))
            .unwrap();
        assert!(validate_ultra_turn_limits(&base, &UltraAudit::default(), expired_start).is_err());

        let calls = (0..=ULTRA_MAX_CALLS_PER_BATCH)
            .map(|position| ultra_test_call(position, &format!("call-{position}")))
            .collect::<Vec<_>>();
        assert!(validate_ultra_batch_call_count(&calls[..ULTRA_MAX_CALLS_PER_BATCH]).is_ok());
        assert!(validate_ultra_batch_call_count(&calls).is_err());
        assert_eq!(ULTRA_MAX_RESIDENT_BATCHES, 1024);
        assert_eq!(ULTRA_MAX_RESIDENT_BYTES, 64 * 1024 * 1024);
        assert!(ultra_resident_capacity_available(
            ULTRA_MAX_RESIDENT_BYTES - 1,
            1,
        ));
        assert!(!ultra_resident_capacity_available(
            ULTRA_MAX_RESIDENT_BYTES,
            1,
        ));
        assert!(!ultra_resident_capacity_available(
            0,
            ULTRA_MAX_RESIDENT_BYTES + 1,
        ));
        assert_eq!(ULTRA_MAX_INITIAL_BODY_BYTES, 2 * 1024 * 1024);
    }

    #[tokio::test]
    async fn ultra_batch_handlers_fail_closed_and_consume_error_state() {
        let state = test_state("http://unused", "http://127.0.0.1:9");
        let call = ultra_test_call(0, "call-claim-once");
        let token = seed_ultra_batch(&state, vec![call.clone()]).await;
        let call = state.ultra_batches.lock().await[&token].calls[0].clone();

        let first_claim = ultra_batch_claim(State(state.clone()), Path(token.clone())).await;
        assert_eq!(first_claim.status(), StatusCode::OK);
        let second_claim = ultra_batch_claim(State(state.clone()), Path(token.clone())).await;
        assert_eq!(second_claim.status(), StatusCode::CONFLICT);
        assert!(state.ultra_batches.lock().await.contains_key(&token));

        let first_start = ultra_batch_dispatch_start(
            State(state.clone()),
            Path(token.clone()),
            Json(ultra_dispatch_marker(&call)),
        )
        .await;
        assert_eq!(first_start.status(), StatusCode::NO_CONTENT);
        let duplicate_start = ultra_batch_dispatch_start(
            State(state.clone()),
            Path(token.clone()),
            Json(ultra_dispatch_marker(&call)),
        )
        .await;
        assert_eq!(duplicate_start.status(), StatusCode::CONFLICT);
        assert!(!state.ultra_batches.lock().await.contains_key(&token));

        let call = ultra_test_call(0, "call-without-start");
        let token = seed_ultra_batch(&state, vec![call.clone()]).await;
        let call = state.ultra_batches.lock().await[&token].calls[0].clone();
        assert_eq!(
            ultra_batch_claim(State(state.clone()), Path(token.clone()))
                .await
                .status(),
            StatusCode::OK
        );
        let result_without_start = ultra_batch_results(
            State(state.clone()),
            Path(token.clone()),
            Json(UltraToolResults {
                results: vec![UltraToolResult {
                    call_id: call.call_id.clone(),
                    payload_digest: call.payload_digest.clone(),
                    output: json!({"ok": true}),
                }],
            }),
        )
        .await;
        assert_eq!(result_without_start.status(), StatusCode::CONFLICT);
        assert!(!state.ultra_batches.lock().await.contains_key(&token));

        let call = ultra_test_call(0, "call-marker-drift");
        let token = seed_ultra_batch(&state, vec![call.clone()]).await;
        ultra_batch_claim(State(state.clone()), Path(token.clone())).await;
        let marker_drift = ultra_batch_dispatch_start(
            State(state.clone()),
            Path(token.clone()),
            Json(UltraDispatchMarker {
                call_id: call.call_id.clone(),
                payload_digest: ultra_multi_agent::body_sha256(b"drift"),
            }),
        )
        .await;
        assert_eq!(marker_drift.status(), StatusCode::CONFLICT);
        assert!(!state.ultra_batches.lock().await.contains_key(&token));

        let call = ultra_test_call(0, "call-heartbeat");
        let token = seed_ultra_batch(&state, vec![call.clone()]).await;
        let call = state.ultra_batches.lock().await[&token].calls[0].clone();
        ultra_batch_claim(State(state.clone()), Path(token.clone())).await;
        ultra_batch_dispatch_start(
            State(state.clone()),
            Path(token.clone()),
            Json(ultra_dispatch_marker(&call)),
        )
        .await;
        let short_expiry = Instant::now() + Duration::from_secs(1);
        state
            .ultra_batches
            .lock()
            .await
            .get_mut(&token)
            .unwrap()
            .expires_at = short_expiry;
        let heartbeat = ultra_batch_heartbeat(
            State(state.clone()),
            Path(token.clone()),
            Json(ultra_dispatch_marker(&call)),
        )
        .await;
        assert_eq!(heartbeat.status(), StatusCode::NO_CONTENT);
        assert!(
            state.ultra_batches.lock().await[&token].expires_at
                > short_expiry + Duration::from_secs(10 * 60)
        );
        state.ultra_batches.lock().await.remove(&token);

        let token = seed_ultra_batch(&state, vec![ultra_test_call(0, "call-expired-safe")]).await;
        state
            .ultra_batches
            .lock()
            .await
            .get_mut(&token)
            .unwrap()
            .expires_at = Instant::now() - Duration::from_secs(1);
        let expired_safe = ultra_batch_claim(State(state.clone()), Path(token.clone())).await;
        assert_eq!(expired_safe.status(), StatusCode::GONE);
        assert!(!state.ultra_batches.lock().await.contains_key(&token));

        let token = seed_ultra_batch(&state, vec![ultra_test_call(0, "call-wall-expired")]).await;
        {
            let mut batches = state.ultra_batches.lock().await;
            let batch = batches.get_mut(&token).unwrap();
            batch.started_at = Instant::now()
                .checked_sub(ULTRA_MAX_WALL_TIME + Duration::from_secs(1))
                .unwrap();
            batch.expires_at = Instant::now() + Duration::from_secs(60);
        }
        let wall_expired = ultra_batch_claim(State(state.clone()), Path(token.clone())).await;
        assert_eq!(wall_expired.status(), StatusCode::GONE);
        assert!(!state.ultra_batches.lock().await.contains_key(&token));

        let call = ultra_test_call(0, "call-expired-ambiguous");
        let token = seed_ultra_batch(&state, vec![call.clone()]).await;
        let call = state.ultra_batches.lock().await[&token].calls[0].clone();
        ultra_batch_claim(State(state.clone()), Path(token.clone())).await;
        ultra_batch_dispatch_start(
            State(state.clone()),
            Path(token.clone()),
            Json(ultra_dispatch_marker(&call)),
        )
        .await;
        state
            .ultra_batches
            .lock()
            .await
            .get_mut(&token)
            .unwrap()
            .expires_at = Instant::now() - Duration::from_secs(1);
        let expired_ambiguous = ultra_batch_heartbeat(
            State(state.clone()),
            Path(token.clone()),
            Json(ultra_dispatch_marker(&call)),
        )
        .await;
        assert_eq!(expired_ambiguous.status(), StatusCode::CONFLICT);
        assert!(!state.ultra_batches.lock().await.contains_key(&token));

        let call = ultra_test_call(0, "call-oversized");
        let token = seed_ultra_batch(&state, vec![call.clone()]).await;
        let call = state.ultra_batches.lock().await[&token].calls[0].clone();
        ultra_batch_claim(State(state.clone()), Path(token.clone())).await;
        ultra_batch_dispatch_start(
            State(state.clone()),
            Path(token.clone()),
            Json(ultra_dispatch_marker(&call)),
        )
        .await;
        let oversized = ultra_batch_results(
            State(state.clone()),
            Path(token.clone()),
            Json(UltraToolResults {
                results: vec![UltraToolResult {
                    call_id: call.call_id,
                    payload_digest: call.payload_digest,
                    output: Value::String("x".repeat(256 * 1024 + 1)),
                }],
            }),
        )
        .await;
        assert_eq!(oversized.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert!(!state.ultra_batches.lock().await.contains_key(&token));
    }

    #[tokio::test]
    async fn ultra_continuations_rotate_tokens_use_previous_response_ids_and_aggregate_usage() {
        let captured = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let captured_headers = Arc::new(std::sync::Mutex::new(Vec::<HeaderMap>::new()));
        let counter = Arc::new(AtomicUsize::new(0));
        let server = start_server(Router::new().route(
            "/openai/v1/responses",
            post({
                let captured = Arc::clone(&captured);
                let captured_headers = Arc::clone(&captured_headers);
                let counter = Arc::clone(&counter);
                move |headers: HeaderMap, Json(payload): Json<Value>| {
                    let captured = Arc::clone(&captured);
                    let captured_headers = Arc::clone(&captured_headers);
                    let counter = Arc::clone(&counter);
                    async move {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                        captured.lock().unwrap().push(payload);
                        captured_headers.lock().unwrap().push(headers);
                        let body = if counter.fetch_add(1, Ordering::SeqCst) == 0 {
                            ultra_sse(
                                "resp-second-batch",
                                vec![json!({
                                    "id": "item-next",
                                    "type": "function_call",
                                    "call_id": "call-next",
                                    "name": "safe_local_read",
                                    "arguments": "{}",
                                    "agent": {"agent_name": "/root"},
                                })],
                                json!({
                                    "input_tokens": 5,
                                    "output_tokens": 1,
                                    "total_tokens": 6,
                                    "input_tokens_details": {"cached_tokens": 2, "cached_read_tokens": 2}
                                }),
                            )
                        } else {
                            ultra_sse(
                                "resp-final",
                                vec![
                                    json!({
                                        "id": "child-evidence",
                                        "type": "agent_message",
                                        "agent": {"agent_name": "/root/researcher"},
                                        "content": [],
                                    }),
                                    json!({
                                        "id": "item-final",
                                        "type": "message",
                                        "phase": "final_answer",
                                        "agent": {"agent_name": "/root"},
                                        "content": [{"type": "output_text", "text": "final answer"}],
                                    }),
                                ],
                                json!({
                                    "input_tokens": 7,
                                    "output_tokens": 3,
                                    "total_tokens": 10,
                                    "input_tokens_details": {"cached_tokens": 1, "cached_read_tokens": 1}
                                }),
                            )
                        };
                        ([(CONTENT_TYPE, "text/event-stream")], body)
                    }
                }
            }),
        ))
        .await;
        let reporting = tempdir().unwrap();
        let state = test_state_with_reporting_dir(
            "http://unused",
            &server.base_url,
            reporting.path().to_path_buf(),
        );
        let calls = vec![ultra_test_call(0, "call-a"), ultra_test_call(1, "call-b")];
        let token = seed_ultra_batch(&state, calls.clone()).await;
        let (calls, initial_response_id) = {
            let batches = state.ultra_batches.lock().await;
            let batch = &batches[&token];
            (
                batch.calls.clone(),
                batch.admission.stable_response_id().unwrap().to_string(),
            )
        };
        let claim =
            response_json(ultra_batch_claim(State(state.clone()), Path(token.clone())).await).await;
        assert_eq!(claim["calls"][0]["call_id"], json!("call-a"));
        assert_eq!(claim["calls"][1]["call_id"], json!("call-b"));
        for call in &calls {
            assert_eq!(
                ultra_batch_dispatch_start(
                    State(state.clone()),
                    Path(token.clone()),
                    Json(ultra_dispatch_marker(call)),
                )
                .await
                .status(),
                StatusCode::NO_CONTENT
            );
        }
        let next = response_json(
            ultra_batch_results(
                State(state.clone()),
                Path(token.clone()),
                Json(UltraToolResults {
                    results: calls
                        .iter()
                        .map(|call| UltraToolResult {
                            call_id: call.call_id.clone(),
                            payload_digest: call.payload_digest.clone(),
                            output: json!({"value": call.call_id}),
                        })
                        .collect(),
                }),
            )
            .await,
        )
        .await;
        assert_eq!(next["kind"], json!("batch"));
        let next_token = next["token"].as_str().unwrap().to_string();
        assert_ne!(next_token, token);
        assert!(!state.ultra_batches.lock().await.contains_key(&token));

        let next_claim =
            response_json(ultra_batch_claim(State(state.clone()), Path(next_token.clone())).await)
                .await;
        assert_eq!(next_claim["calls"][0]["call_id"], json!("call-next"));
        let next_call = state.ultra_batches.lock().await[&next_token].calls[0].clone();
        ultra_batch_dispatch_start(
            State(state.clone()),
            Path(next_token.clone()),
            Json(ultra_dispatch_marker(&next_call)),
        )
        .await;
        let final_payload = response_json(
            ultra_batch_results(
                State(state.clone()),
                Path(next_token.clone()),
                Json(UltraToolResults {
                    results: vec![UltraToolResult {
                        call_id: next_call.call_id,
                        payload_digest: next_call.payload_digest,
                        output: Value::String("next result".to_string()),
                    }],
                }),
            )
            .await,
        )
        .await;
        assert_eq!(final_payload["kind"], json!("final"));
        assert_eq!(final_payload["content"], json!("final answer"));
        assert_eq!(final_payload["usage"]["prompt_tokens"], json!(22));
        assert_eq!(final_payload["usage"]["completion_tokens"], json!(6));
        assert_eq!(final_payload["usage"]["total_tokens"], json!(28));
        assert_eq!(
            final_payload["usage"]["prompt_tokens_details"]["cached_read_tokens"],
            json!(7)
        );
        assert!(final_payload["usage"]["cost"].as_f64().unwrap() > 0.0);
        assert_eq!(final_payload["ultra_audit"]["tool_call_count"], json!(3));
        assert_eq!(
            final_payload["ultra_audit"]["child_tool_call_count"],
            json!(0)
        );
        assert_eq!(final_payload["ultra_audit"]["tool_result_count"], json!(3));
        assert_eq!(final_payload["ultra_audit"]["continuation_count"], json!(2));
        assert_eq!(
            final_payload["ultra_audit"]["arguments_logged"],
            json!(false)
        );
        assert_eq!(final_payload["ultra_audit"]["results_logged"], json!(false));
        assert!(!state.ultra_batches.lock().await.contains_key(&next_token));

        let captured = captured.lock().unwrap();
        assert_eq!(captured.len(), 2);
        for payload in captured.iter() {
            assert_eq!(payload["store"], json!(true));
            assert_eq!(payload["stream"], json!(true));
            assert_eq!(payload["reasoning"]["effort"], json!("max"));
            assert_eq!(payload["multi_agent"]["max_concurrent_subagents"], json!(4));
            assert_eq!(
                payload["prompt_cache_key"],
                json!(ultra_prompt_cache_key(&ultra_test_origin()))
            );
        }
        assert_eq!(
            captured[0]["previous_response_id"],
            json!(initial_response_id)
        );
        assert_eq!(
            captured[1]["previous_response_id"],
            json!("resp-second-batch")
        );
        for (payload, expected_outputs) in captured.iter().zip([2, 1]) {
            assert_eq!(
                payload["input"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|item| item["type"] == json!("function_call_output"))
                    .count(),
                expected_outputs
            );
        }
        assert!(captured_headers
            .lock()
            .unwrap()
            .iter()
            .all(|headers| { headers.get(BETA_HEADER_NAME).unwrap() == BETA_HEADER_VALUE }));

        let mut usage_events = std_fs::read_dir(reporting.path().join("events"))
            .unwrap()
            .map(|entry| {
                serde_json::from_slice::<Value>(&std_fs::read(entry.unwrap().path()).unwrap())
                    .unwrap()
            })
            .collect::<Vec<_>>();
        usage_events.sort_by_key(|event| event["callId"].as_str().unwrap().to_string());
        assert_eq!(usage_events.len(), 2);
        assert_eq!(usage_events[0]["callId"], json!("test-ultra-call:ultra:1"));
        assert_eq!(usage_events[1]["callId"], json!("test-ultra-call:ultra:2"));
    }

    #[tokio::test]
    async fn upstream_error_response_returns_text_body() {
        let server = start_server(Router::new().route(
            "/error",
            any(|| async move { (StatusCode::IM_A_TEAPOT, Body::from("short and stout")) }),
        ))
        .await;
        let response = Client::builder()
            .use_rustls_tls()
            .build()
            .unwrap()
            .get(format!("{}/error", server.base_url))
            .send()
            .await
            .unwrap();
        let translated = upstream_error_response(response).await;
        assert_eq!(translated.status(), StatusCode::IM_A_TEAPOT);
        let body = response_json(translated).await;
        assert!(body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("short and stout"));

        let broken_base = start_raw_http_server(
            b"HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nContent-Length: 20\r\n\r\nshort".to_vec(),
        )
        .await;
        let broken_response = Client::builder()
            .use_rustls_tls()
            .build()
            .unwrap()
            .get(broken_base)
            .send()
            .await
            .unwrap();
        let translated = upstream_error_response(broken_response).await;
        assert_eq!(translated.status(), StatusCode::BAD_GATEWAY);
        let body = response_json(translated).await;
        assert!(body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("Upstream returned HTTP 502 Bad Gateway"));
    }
}
