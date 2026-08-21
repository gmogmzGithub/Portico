use crate::config::{canonicalize_streamable_http_resource_url, ServerConfig};
use anyhow::{anyhow, bail, Context, Result};
use futures::stream::BoxStream;
use http::{HeaderName, HeaderValue};
use log::{info, warn};
use regex::Regex;
use rmcp::transport::auth::{
    AuthorizationManager, AuthorizationMetadata, OAuthClientConfig, StateStore,
};
use rmcp::transport::streamable_http_client::{
    AuthRequiredError, StreamableHttpClient, StreamableHttpError, StreamableHttpPostResponse,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use sse_stream::{Error as SseError, Sse};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::future::Future;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use super::binding_support::{
    build_client_info_from_credentials, joined_scope, map_streamable_error, resolve_redirect_uri,
};
use super::config::OAuthConfig;
use super::coordinator::OAuthCoordinator;
use super::discover_metadata_from_authorization_server;
use super::discovery::{discover_from_auth_challenge, discover_from_base_url, OAuthDiscovery};
use super::logging::{oauth_error, oauth_info, oauth_warn};
use super::storage::{
    decode_jwt_audiences, has_url_like_audience_mismatch, parse_token_response, token_scopes,
    CompatClientInfo, CompatStateStore, CompatTokenFile, CompatTokenStore, TokenStatus,
};

const HTTP_SUBPROCESS_MCP_URL: &str = "http://127.0.0.1:8080/mcp";
const TOKEN_ENDPOINT_TIMEOUT: Duration = Duration::from_secs(30);
const REFRESH_BODY_SNIPPET_MAX_BYTES: usize = 512;
const REFRESH_AUDIENCE_MISMATCH_ERROR: &str =
    "token refresh returned an access token whose audience does not match the configured OAuth resource";
const REQUEST_ONLY_TOKEN_SCOPES: &[&str] = &[
    "openid",
    "profile",
    "email",
    "offline_access",
    "address",
    "phone",
];
const SAFE_REFRESH_RESPONSE_HEADERS: &[&str] = &[
    "content-type",
    "content-length",
    "location",
    "server",
    "via",
    "www-authenticate",
    "portico-request-id",
    "portico-tracking-key",
    "x-request-id",
    "x-correlation-id",
    "traceparent",
];
const OAUTH_BROKER_URL_ENV: &str = "portico_OAUTH_ACCESS_TOKEN_BROKER_URL";
const OAUTH_BROKER_SERVER_ID_ENV: &str = "portico_OAUTH_ACCESS_TOKEN_SERVER_ID";
const OAUTH_BROKER_TOKEN_ENV: &str = "portico_OAUTH_ACCESS_TOKEN_BROKER_TOKEN";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OAuthBrokerSeedOutcome {
    NotConfigured,
    Seeded,
    AuthorizationRequired(String),
}

#[derive(Debug, Clone)]
struct OAuthAccessTokenBrokerConfig {
    url: String,
    server_id: String,
    bearer_token: String,
}

#[derive(Debug, Deserialize)]
struct OAuthAccessTokenBrokerResponse {
    #[serde(default)]
    server_id: Option<String>,
    access_token: String,
    #[serde(default)]
    token_type: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
    #[serde(default)]
    expires_at: Option<serde_json::Value>,
}

pub(crate) fn oauth_access_token_sha256(access_token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(access_token.as_bytes());
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
fn oauth_test_env_lock() -> std::sync::MutexGuard<'static, ()> {
    crate::test_env_lock()
}

fn refresh_json_redaction_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(
            r#"(?i)("(?:access_token|refresh_token|id_token|client_secret|client_assertion|authorization|code_verifier|cookie|set-cookie)"\s*:\s*")([^"]*)(")"#,
        )
        .expect("valid JSON secret redaction regex")
    })
}

fn refresh_form_redaction_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(
            r#"(?i)((?:^|[?&\s])(?:access_token|refresh_token|id_token|client_secret|client_assertion|authorization|code_verifier|cookie|set-cookie)=)([^&\s]*)"#,
        )
        .expect("valid form secret redaction regex")
    })
}

fn refresh_header_redaction_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r#"(?im)^((?:authorization|cookie|set-cookie)\s*:\s*)(.+)$"#)
            .expect("valid header secret redaction regex")
    })
}

fn refresh_inline_header_redaction_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(
            r#"(?i)((?:^|[\s;,])(?:authorization|cookie|set-cookie)\s*:\s*)([^\s;,]+(?:\s+[^\s;,]+)?)"#,
        )
        .expect("valid inline header secret redaction regex")
    })
}

fn summarize_refresh_response_headers(headers: &reqwest::header::HeaderMap) -> String {
    let mut parts = Vec::new();
    for header_name in SAFE_REFRESH_RESPONSE_HEADERS {
        if let Some(value) = headers.get(*header_name) {
            let rendered = value.to_str().unwrap_or("<non-utf8>");
            parts.push(format!("{header_name}={rendered}"));
        }
    }
    if parts.is_empty() {
        "<none>".to_string()
    } else {
        parts.join(", ")
    }
}

fn redact_refresh_body_snippet(raw: &str) -> String {
    let output = refresh_json_redaction_regex()
        .replace_all(raw, "$1<redacted>$3")
        .to_string();
    let output = refresh_form_redaction_regex()
        .replace_all(&output, "$1<redacted>")
        .to_string();
    let output = refresh_header_redaction_regex()
        .replace_all(&output, "$1<redacted>")
        .to_string();
    refresh_inline_header_redaction_regex()
        .replace_all(&output, "$1<redacted>")
        .to_string()
}

fn escape_refresh_log_value(raw: &str) -> String {
    raw.chars().flat_map(|ch| ch.escape_default()).collect()
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn oauth_access_token_broker_fully_configured() -> bool {
    non_empty_env(OAUTH_BROKER_URL_ENV).is_some() && non_empty_env(OAUTH_BROKER_TOKEN_ENV).is_some()
}

fn oauth_access_token_broker_config(
    server_name: &str,
) -> Result<Option<OAuthAccessTokenBrokerConfig>> {
    let url = non_empty_env(OAUTH_BROKER_URL_ENV);
    let server_id = non_empty_env(OAUTH_BROKER_SERVER_ID_ENV);
    let bearer_token = non_empty_env(OAUTH_BROKER_TOKEN_ENV);

    if server_id.is_none() && bearer_token.is_none() {
        return Ok(None);
    }

    let url = url.context("OAuth access-token broker URL is not configured")?;
    let server_id = server_id.unwrap_or_else(|| server_name.to_string());
    if server_id != server_name {
        bail!(
            "OAuth access-token broker server_id mismatch: runtime server is '{server_name}' but broker scope is '{server_id}'"
        );
    }
    let bearer_token = bearer_token.context("OAuth access-token broker token is not configured")?;

    Ok(Some(OAuthAccessTokenBrokerConfig {
        url,
        server_id,
        bearer_token,
    }))
}

fn broker_response_is_auth_required(status: u16, body: &str) -> bool {
    if matches!(status, 401 | 404 | 428 | 503) {
        return true;
    }
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("auth_required")
                .and_then(serde_json::Value::as_bool)
        })
        .unwrap_or(false)
}

fn broker_auth_required_message(body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .or_else(|| value.get("message"))
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "host-side OAuth record is unavailable".to_string())
}

fn summarize_refresh_response_body_snippet(body: &[u8]) -> String {
    let truncated = body.len() > REFRESH_BODY_SNIPPET_MAX_BYTES;
    let snippet = String::from_utf8_lossy(&body[..body.len().min(REFRESH_BODY_SNIPPET_MAX_BYTES)])
        .into_owned();
    let snippet = escape_refresh_log_value(&redact_refresh_body_snippet(&snippet));
    if truncated {
        format!("{snippet}...[truncated]")
    } else {
        snippet
    }
}

fn is_refresh_invalid_json_error(error: &anyhow::Error) -> bool {
    error
        .to_string()
        .contains("token refresh returned invalid JSON")
}

fn token_endpoint_oauth_error_details(body: &[u8]) -> Option<(String, Option<String>)> {
    let payload: serde_json::Value = serde_json::from_slice(body).ok()?;
    if let Some(error) = payload
        .get("error")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let description = payload
            .get("error_description")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        return Some((error.to_string(), description));
    }

    let errors = payload
        .get("errors")
        .and_then(serde_json::Value::as_array)?;
    errors.iter().find_map(oauth_error_details_from_error_item)
}

fn oauth_error_details_from_error_item(
    item: &serde_json::Value,
) -> Option<(String, Option<String>)> {
    if let Some(message) = item.as_str() {
        return oauth_error_details_from_message(message);
    }

    let object = item.as_object()?;
    if let Some(error) = object
        .get("error")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let description = object
            .get("error_description")
            .or_else(|| object.get("message"))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        return Some((error.to_string(), description));
    }

    object
        .get("message")
        .and_then(serde_json::Value::as_str)
        .and_then(oauth_error_details_from_message)
}

fn oauth_error_details_from_message(message: &str) -> Option<(String, Option<String>)> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return None;
    }

    let normalized = trimmed.to_ascii_lowercase();
    let error_start = normalized.find("invalid_grant")?;
    let error_end = error_start + "invalid_grant".len();
    let description = trimmed
        .get(error_end..)
        .map(|value| value.trim_start_matches([' ', '-', ':']))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Some(("invalid_grant".to_string(), description))
}

fn token_endpoint_oauth_error_suffix(body: &[u8]) -> String {
    match token_endpoint_oauth_error_details(body) {
        Some((error, Some(description))) => {
            format!(" (oauth_error={error}, error_description={description})")
        }
        Some((error, None)) => format!(" (oauth_error={error})"),
        None => String::new(),
    }
}

fn terminal_refresh_failure_reason(error: &anyhow::Error) -> Option<String> {
    if is_refresh_invalid_json_error(error) {
        return Some("token refresh returned invalid JSON".to_string());
    }

    let message = error.to_string();
    let normalized = message.to_ascii_lowercase();
    if normalized.contains(&REFRESH_AUDIENCE_MISMATCH_ERROR.to_ascii_lowercase()) {
        return Some(REFRESH_AUDIENCE_MISMATCH_ERROR.to_string());
    }
    if normalized.contains("oauth_error=invalid_client")
        || normalized.contains("error=invalid_client")
    {
        return Some("token refresh returned invalid_client".to_string());
    }
    if normalized.contains("oauth_error=invalid_grant")
        || normalized.contains("error=invalid_grant")
    {
        if normalized.contains("token has expired") {
            return Some("token refresh returned invalid_grant (Token has expired)".to_string());
        }
        return Some("token refresh returned invalid_grant".to_string());
    }

    None
}

fn rename_scope_parameter(url: &str, new_name: &str) -> String {
    match url::Url::parse(url) {
        Ok(mut parsed) => {
            let pairs: Vec<(String, String)> = parsed
                .query_pairs()
                .map(|(key, value)| {
                    if key == "scope" {
                        (new_name.to_string(), value.into_owned())
                    } else {
                        (key.into_owned(), value.into_owned())
                    }
                })
                .collect();
            parsed.query_pairs_mut().clear();
            for (key, value) in &pairs {
                parsed.query_pairs_mut().append_pair(key, value);
            }
            parsed.to_string()
        }
        Err(_) => url.to_string(),
    }
}

fn token_endpoint_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(TOKEN_ENDPOINT_TIMEOUT)
        .build()
        .context("failed to build OAuth token endpoint client")
}

fn rewrite_authorization_url_resource(
    authorization_url: &str,
    resource: Option<&str>,
) -> Result<String> {
    let Some(resource) = resource.filter(|value| !value.trim().is_empty()) else {
        return Ok(authorization_url.to_string());
    };
    reqwest::Url::parse(authorization_url)
        .context("generated OAuth authorization URL is invalid")?;

    let encoded_resource = {
        let mut serializer = url::form_urlencoded::Serializer::new(String::new());
        serializer.append_pair("resource", resource);
        serializer
            .finish()
            .strip_prefix("resource=")
            .unwrap_or_default()
            .to_string()
    };

    let (url_without_fragment, fragment) = authorization_url
        .split_once('#')
        .map(|(url, fragment)| (url, format!("#{fragment}")))
        .unwrap_or((authorization_url, String::new()));
    let Some((prefix, query)) = url_without_fragment.split_once('?') else {
        return Ok(format!(
            "{url_without_fragment}?resource={encoded_resource}{fragment}"
        ));
    };

    let mut saw_resource = false;
    let mut rewritten_query = String::with_capacity(query.len() + encoded_resource.len());
    for (index, param) in query.split('&').enumerate() {
        if index > 0 {
            rewritten_query.push('&');
        }
        let key = param.split_once('=').map(|(key, _)| key).unwrap_or(param);
        if key == "resource" {
            saw_resource = true;
            rewritten_query.push_str("resource=");
            rewritten_query.push_str(&encoded_resource);
        } else {
            rewritten_query.push_str(param);
        }
    }
    if !saw_resource {
        if !rewritten_query.is_empty() {
            rewritten_query.push('&');
        }
        rewritten_query.push_str("resource=");
        rewritten_query.push_str(&encoded_resource);
    }

    Ok(format!("{prefix}?{rewritten_query}{fragment}"))
}

pub struct OAuthBinding {
    server_name: String,
    mcp_url: String,
    oauth_config: OAuthConfig,
    coordinator: Arc<OAuthCoordinator>,
    state_store: CompatStateStore,
    token_store: CompatTokenStore,
    manager: tokio::sync::Mutex<AuthorizationManager>,
    refresh_lock: tokio::sync::Mutex<()>,
    metadata: tokio::sync::RwLock<Option<AuthorizationMetadata>>,
    discovered_resource: tokio::sync::RwLock<Option<String>>,
    challenge_scopes: tokio::sync::RwLock<Vec<String>>,
    protected_resource_scopes: tokio::sync::RwLock<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OAuthRefreshOutcome {
    Refreshed,
    AuthorizationRequired(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum OAuthSecureRecordRefreshOutcome {
    Refreshed,
    AuthorizationRequired,
}

impl OAuthBinding {
    pub async fn new(
        server_name: &str,
        config: &ServerConfig,
        coordinator: Arc<OAuthCoordinator>,
    ) -> Result<Arc<Self>> {
        let oauth_raw = config
            .oauth
            .as_ref()
            .ok_or_else(|| anyhow!("server '{server_name}' is missing oauth config"))?;
        let mcp_url = config
            .url
            .clone()
            .or_else(|| {
                config
                    .http_subprocess
                    .as_ref()
                    .map(|_| HTTP_SUBPROCESS_MCP_URL.to_string())
            })
            .ok_or_else(|| {
                anyhow!("oauth server '{server_name}' requires a streamable-http url")
            })?;
        let normalized_mcp_url = canonicalize_streamable_http_resource_url(&mcp_url);
        if normalized_mcp_url != mcp_url {
            warn!(
                "[{}] canonicalized OAuth resource base from MCP URL: {} -> {}",
                server_name, mcp_url, normalized_mcp_url
            );
            oauth_warn(format!(
                "[{server_name}] canonicalized OAuth resource base from MCP URL: {mcp_url} -> {normalized_mcp_url}"
            ));
        }
        let mcp_url = normalized_mcp_url;
        let oauth_config = OAuthConfig::from_value(oauth_raw)?;
        let storage_type = if oauth_access_token_broker_config(server_name)?.is_some() {
            Some("memory".to_string())
        } else {
            oauth_config.storage_type.clone()
        };
        let state_store = CompatStateStore::new();
        let resource_base = oauth_config.resource_url(&mcp_url);
        let mut manager = AuthorizationManager::new(resource_base)
            .await
            .context("failed to create OAuth authorization manager")?;
        manager.set_state_store(state_store.clone());

        Ok(Arc::new(Self {
            server_name: server_name.to_string(),
            mcp_url,
            oauth_config,
            coordinator,
            state_store,
            token_store: CompatTokenStore::with_storage_type(server_name, storage_type.as_deref())?,
            manager: tokio::sync::Mutex::new(manager),
            refresh_lock: tokio::sync::Mutex::new(()),
            metadata: tokio::sync::RwLock::new(None),
            discovered_resource: tokio::sync::RwLock::new(None),
            challenge_scopes: tokio::sync::RwLock::new(Vec::new()),
            protected_resource_scopes: tokio::sync::RwLock::new(Vec::new()),
        }))
    }

    pub async fn initialize_startup_state(&self) -> Result<()> {
        self.coordinator.register_handshake(&self.server_name).await;
        if let Err(error) = self.ensure_metadata().await {
            warn!(
                "[{}] OAuth metadata discovery during startup state initialization failed: {error:#}",
                self.server_name
            );
            oauth_warn(format!(
                "[{}] OAuth metadata discovery during startup state initialization failed: {error:#}",
                self.server_name
            ));
        }
        let oauth_config = self.effective_oauth_config().await;
        let required_scopes = self.token_required_scopes();
        if self
            .token_store
            .has_usable_tokens(&oauth_config, &required_scopes)?
        {
            self.coordinator.mark_checking(&self.server_name).await;
            oauth_info(format!(
                "[{}] stored OAuth tokens look usable; startup state set to checking",
                self.server_name
            ));
        }
        Ok(())
    }

    pub async fn has_usable_tokens(&self) -> Result<bool> {
        let oauth_config = self.effective_oauth_config().await;
        let required_scopes = self.token_required_scopes();
        self.token_store
            .has_usable_tokens(&oauth_config, &required_scopes)
    }

    pub async fn oauth_record_requires_refresh(&self) -> Result<bool> {
        let oauth_config = self.effective_oauth_config().await;
        let required_scopes = self.token_required_scopes();
        let Some(status) = self
            .token_store
            .load_status(&oauth_config, &required_scopes)?
        else {
            return Ok(true);
        };
        Ok(status.is_expired || status.scope_mismatch || status.audience_mismatch)
    }

    pub(crate) async fn refresh_secure_oauth_record(
        &self,
    ) -> Result<OAuthSecureRecordRefreshOutcome> {
        let oauth_config = self.effective_oauth_config().await;
        let required_scopes = self.token_required_scopes();
        let Some(status) = self
            .token_store
            .load_status(&oauth_config, &required_scopes)?
        else {
            return Ok(OAuthSecureRecordRefreshOutcome::AuthorizationRequired);
        };
        if !status.can_refresh {
            return Ok(OAuthSecureRecordRefreshOutcome::AuthorizationRequired);
        }

        match self.refresh_access_token(&status).await {
            Ok(_) => Ok(OAuthSecureRecordRefreshOutcome::Refreshed),
            Err(error) if terminal_refresh_failure_reason(&error).is_some() => {
                Ok(OAuthSecureRecordRefreshOutcome::AuthorizationRequired)
            }
            Err(error) => Err(error).context("OAuth secure-record refresh failed"),
        }
    }

    pub fn seed_oauth_record(
        &self,
        token: &CompatTokenFile,
        client_info: &CompatClientInfo,
    ) -> Result<()> {
        self.token_store.clear_tokens()?;
        self.token_store.save_client_info(client_info)?;
        self.token_store.save_token_file(token)
    }

    pub async fn configured_non_dcr_client_id(&self) -> Result<Option<String>> {
        if !self.oauth_config.is_non_dcr() {
            return Ok(None);
        }
        let source = self
            .oauth_config
            .credentials_source
            .as_ref()
            .ok_or_else(|| {
                anyhow!(
                    "OAuth type 'non-dcr' requires credentials_source with a pre-registered client"
                )
            })?;
        Ok(Some(source.load().await?.client_id))
    }

    pub fn uses_access_token_broker(&self) -> bool {
        oauth_access_token_broker_fully_configured()
    }

    fn access_token_broker_configured(&self) -> Result<bool> {
        oauth_access_token_broker_config(&self.server_name).map(|config| config.is_some())
    }

    pub async fn seed_access_token_from_broker(
        &self,
        force_refresh: bool,
    ) -> Result<OAuthBrokerSeedOutcome> {
        self.request_access_token_from_broker(force_refresh, false)
            .await
    }

    async fn request_access_token_from_broker(
        &self,
        force_refresh: bool,
        invalidate_rejected: bool,
    ) -> Result<OAuthBrokerSeedOutcome> {
        let Some(config) = oauth_access_token_broker_config(&self.server_name)? else {
            return Ok(OAuthBrokerSeedOutcome::NotConfigured);
        };

        let mut payload = serde_json::json!({ "server_id": config.server_id });
        if force_refresh || invalidate_rejected {
            payload["force_refresh"] = serde_json::Value::Bool(true);
            if invalidate_rejected {
                payload["invalidate_rejected"] = serde_json::Value::Bool(true);
            }
            if let Some(token) = self.token_store.load_token_file()? {
                if !token.access_token.trim().is_empty() {
                    payload["rejected_access_token_sha256"] = serde_json::Value::String(
                        oauth_access_token_sha256(token.access_token.trim()),
                    );
                }
            }
        }

        let response = reqwest::Client::new()
            .post(&config.url)
            .bearer_auth(&config.bearer_token)
            .json(&payload)
            .send()
            .await
            .with_context(|| {
                format!(
                    "[{}] failed to contact OAuth access-token broker",
                    self.server_name
                )
            })?;
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            if broker_response_is_auth_required(status.as_u16(), &body) {
                let message = broker_auth_required_message(&body);
                self.coordinator
                    .mark_authorization_required(&self.server_name, message.clone())
                    .await;
                return Ok(OAuthBrokerSeedOutcome::AuthorizationRequired(message));
            }
            bail!(
                "[{}] OAuth access-token broker returned HTTP {}",
                self.server_name,
                status
            );
        }

        let broker_response: OAuthAccessTokenBrokerResponse = serde_json::from_str(&body)
            .context("OAuth access-token broker returned invalid JSON")?;
        if broker_response
            .server_id
            .as_deref()
            .is_some_and(|server_id| server_id != self.server_name)
        {
            bail!(
                "[{}] OAuth access-token broker returned a mismatched server_id",
                self.server_name
            );
        }
        if broker_response.access_token.trim().is_empty() {
            bail!(
                "[{}] OAuth access-token broker returned an empty access token",
                self.server_name
            );
        }

        let mut token = CompatTokenFile {
            access_token: broker_response.access_token,
            token_type: broker_response
                .token_type
                .or_else(|| Some("Bearer".to_string())),
            expires_in: broker_response.expires_in,
            refresh_token: None,
            scope: None,
            extra: BTreeMap::new(),
        };
        if let Some(expires_at) = broker_response.expires_at {
            token.extra.insert("expires_at".to_string(), expires_at);
        }
        let client_info = CompatClientInfo {
            client_id: "host-mcp-bridge-oauth-access-token-broker".to_string(),
            token_endpoint_auth_method: Some("none".to_string()),
            ..Default::default()
        };
        self.seed_oauth_record(&token, &client_info)?;
        // Broker vending is token maintenance, not connection validation. Startup,
        // callback, and explicit reload flows own the checking -> completed lifecycle.
        Ok(OAuthBrokerSeedOutcome::Seeded)
    }

    pub fn export_oauth_record(&self) -> Result<Option<(CompatTokenFile, CompatClientInfo)>> {
        let Some(token) = self.token_store.load_token_file()? else {
            return Ok(None);
        };
        let Some(client_info) = self.token_store.load_client_info()? else {
            return Ok(None);
        };
        Ok(Some((token, client_info)))
    }

    pub async fn finalize_post_connect_state(&self) -> Result<()> {
        if self.has_usable_tokens().await? {
            self.mark_connected().await;
            return Ok(());
        }

        if self.oauth_config.credentials_source.is_some() {
            info!(
                "[{}] non-DCR OAuth server connected without usable tokens; generating authorization URL",
                self.server_name
            );
            oauth_info(format!(
                "[{}] non-DCR OAuth server connected without usable tokens; generating authorization URL",
                self.server_name
            ));
            let _ = self.ensure_authorization_url(false).await?;
        }

        Ok(())
    }

    pub async fn access_token(&self) -> Result<Option<String>> {
        let oauth_config = self.effective_oauth_config().await;
        let required_scopes = self.token_required_scopes();
        let initial_status = self
            .token_store
            .load_status(&oauth_config, &required_scopes)?;
        if initial_status
            .as_ref()
            .is_some_and(Self::status_has_usable_access_token)
        {
            return Ok(initial_status.map(|status| status.token.access_token));
        }

        let _refresh_guard = self.refresh_lock.lock().await;
        let Some(status) = self
            .token_store
            .load_status(&oauth_config, &required_scopes)?
        else {
            if self.access_token_broker_configured()? {
                return self.access_token_from_broker(false).await;
            }
            return Ok(None);
        };
        if Self::status_has_usable_access_token(&status) {
            return Ok(Some(status.token.access_token.clone()));
        }
        if self.access_token_broker_configured()? {
            return self.access_token_from_broker(true).await;
        }
        if !status.can_refresh {
            if !status.scope_mismatch
                && !status.audience_mismatch
                && !status.token.access_token.is_empty()
            {
                info!(
                    "[{}] using stored OAuth access token without refresh (expired_or_mismatch={} {} {})",
                    self.server_name,
                    status.is_expired,
                    if status.scope_mismatch {
                        "scope_mismatch"
                    } else {
                        "scope_ok"
                    },
                    if status.audience_mismatch {
                        "audience_mismatch"
                    } else {
                        "audience_ok"
                    }
                );
                return Ok(Some(status.token.access_token.clone()));
            }
            return Ok(None);
        }
        match self.refresh_access_token(&status).await {
            Ok(token) => Ok(Some(token.access_token)),
            Err(error) => {
                warn!(
                    "failed to refresh OAuth token for '{}': {error:#}",
                    self.server_name
                );
                if let Some(reason) = terminal_refresh_failure_reason(&error) {
                    let authorization_url = self
                        .restart_authorization_after_terminal_refresh_failure(&reason)
                        .await?;
                    return Err(anyhow!(
                        "OAuth re-authorization required for server '{}'; authorization_url={authorization_url}",
                        self.server_name
                    ));
                }
                if !status.scope_mismatch
                    && !status.audience_mismatch
                    && !status.token.access_token.is_empty()
                {
                    warn!(
                        "[{}] falling back to stored OAuth access token after refresh failure",
                        self.server_name
                    );
                    Ok(Some(status.token.access_token.clone()))
                } else {
                    Ok(None)
                }
            }
        }
    }

    async fn access_token_from_broker(&self, force_refresh: bool) -> Result<Option<String>> {
        match self.seed_access_token_from_broker(force_refresh).await? {
            OAuthBrokerSeedOutcome::Seeded => {}
            OAuthBrokerSeedOutcome::AuthorizationRequired(message) => {
                bail!(
                    "OAuth authorization required for server '{}': {message}",
                    self.server_name
                );
            }
            OAuthBrokerSeedOutcome::NotConfigured => return Ok(None),
        }

        let oauth_config = self.effective_oauth_config().await;
        let required_scopes = self.token_required_scopes();
        let Some(status) = self
            .token_store
            .load_status(&oauth_config, &required_scopes)?
        else {
            bail!(
                "[{}] OAuth access-token broker did not provide a token record",
                self.server_name
            );
        };
        if Self::status_has_usable_access_token(&status) {
            if force_refresh {
                info!(
                    "[{}] refreshed OAuth access token through host broker before downstream request",
                    self.server_name
                );
            }
            return Ok(Some(status.token.access_token.clone()));
        }

        bail!(
            "[{}] OAuth access-token broker returned an unusable access token (expired={} {} {})",
            self.server_name,
            status.is_expired,
            if status.scope_mismatch {
                "scope_mismatch"
            } else {
                "scope_ok"
            },
            if status.audience_mismatch {
                "audience_mismatch"
            } else {
                "audience_ok"
            }
        );
    }

    fn status_has_usable_access_token(status: &TokenStatus) -> bool {
        !status.audience_mismatch && !status.scope_mismatch && !status.is_expired
    }

    async fn restart_authorization_after_terminal_refresh_failure(
        &self,
        reason: &str,
    ) -> Result<String> {
        self.token_store.clear_tokens()?;
        info!(
            "[{}] cleared persisted OAuth token state after terminal refresh failure",
            self.server_name
        );
        oauth_warn(format!(
            "[{}] cleared persisted OAuth token state after terminal refresh failure",
            self.server_name
        ));
        self.restart_authorization_after_refresh_failure(reason)
            .await
    }

    pub async fn restart_authorization_after_transport_unauthorized(
        &self,
        reason: &str,
    ) -> Result<String> {
        self.token_store.clear_tokens()?;
        info!(
            "[{}] cleared persisted OAuth token state after authenticated transport unauthorized response",
            self.server_name
        );
        oauth_warn(format!(
            "[{}] cleared persisted OAuth token state after authenticated transport unauthorized response",
            self.server_name
        ));
        self.restart_authorization_after_refresh_failure(reason)
            .await
    }

    async fn restart_authorization_after_refresh_failure(&self, reason: &str) -> Result<String> {
        info!(
            "[{}] OAuth refresh failed terminally ({}); restarting authorization flow",
            self.server_name, reason
        );
        self.coordinator.restart_oauth_flow(&self.server_name).await;
        oauth_warn(format!(
            "[{}] OAuth refresh failed terminally ({}); restarting authorization flow",
            self.server_name, reason
        ));
        self.ensure_authorization_url(true).await
    }

    pub async fn ensure_authorization_url(&self, force: bool) -> Result<String> {
        if !force {
            if let Some(current) = self.coordinator.get_handshake(&self.server_name).await {
                if let Some(url) = current.authorization_url {
                    if matches!(
                        current.state,
                        super::OAuthState::Active | super::OAuthState::WaitingCallback
                    ) {
                        return Ok(url);
                    }
                }
            }
        }

        let metadata = self.ensure_metadata().await?;
        let client_info = self.ensure_client_info(&metadata).await?;
        self.configure_manager(&metadata, &client_info).await?;
        let scopes = self.request_scopes(&metadata, &client_info);
        let scope_refs = scopes.iter().map(String::as_str).collect::<Vec<_>>();
        let auth_url = {
            let manager = self.manager.lock().await;
            let url = manager
                .get_authorization_url(&scope_refs)
                .await
                .context("failed to generate OAuth authorization URL")?;
            if let Some(param_name) = self.oauth_config.scope_parameter_name() {
                rename_scope_parameter(&url, param_name)
            } else {
                url
            }
        };
        let effective_resource = self.effective_resource().await;
        let auth_url =
            rewrite_authorization_url_resource(&auth_url, effective_resource.as_deref())?;
        self.coordinator
            .set_authorization_url(&self.server_name, auth_url.clone(), true)
            .await;
        Ok(auth_url)
    }

    pub async fn handle_callback(&self, code: &str, state_param: &str) -> Result<()> {
        let metadata = self.ensure_metadata().await?;
        let client_info = self.ensure_client_info(&metadata).await?;
        let stored_state = self
            .state_store
            .load(state_param)
            .await
            .context("failed to load OAuth authorization state")?
            .ok_or_else(|| anyhow!("authorization state not found"))?;
        self.state_store
            .delete(state_param)
            .await
            .context("failed to delete OAuth authorization state")?;
        self.coordinator
            .mark_waiting_callback(&self.server_name)
            .await;

        let pkce_verifier = stored_state.into_pkce_verifier().secret().to_string();
        let redirect_uri = resolve_redirect_uri(&self.oauth_config, &client_info);
        let token = self
            .exchange_code_for_tokens(&metadata, &client_info, code, &pkce_verifier, &redirect_uri)
            .await?;
        self.token_store.save_token_file(&token)?;
        self.coordinator.mark_checking(&self.server_name).await;
        Ok(())
    }

    pub async fn refresh_or_reauthorize(&self) -> Result<OAuthRefreshOutcome> {
        self.handle_unauthorized_header(None).await
    }

    pub async fn handle_unauthorized_header(
        &self,
        www_authenticate_header: Option<&str>,
    ) -> Result<OAuthRefreshOutcome> {
        info!(
            "[{}] handling OAuth unauthorized response (challenge_present={})",
            self.server_name,
            www_authenticate_header
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false)
        );
        if let Some(header) = www_authenticate_header.filter(|value| !value.trim().is_empty()) {
            let _ = self.discover_auth_challenge_header(header).await?;
        }

        if self.access_token_broker_configured()?
            && self.access_token_from_broker(true).await?.is_some()
        {
            info!(
                "[{}] refreshed OAuth access token through host broker after unauthorized response",
                self.server_name
            );
            self.coordinator.mark_completed(&self.server_name).await;
            return Ok(OAuthRefreshOutcome::Refreshed);
        }

        if let Some(handshake) = self.coordinator.get_handshake(&self.server_name).await {
            if let Some(authorization_url) = handshake.authorization_url {
                if handshake.state != super::OAuthState::Completed {
                    info!(
                        "[{}] reusing active OAuth authorization URL",
                        self.server_name
                    );
                    return Ok(OAuthRefreshOutcome::AuthorizationRequired(
                        authorization_url,
                    ));
                }
            }
        }

        let oauth_config = self.effective_oauth_config().await;
        let required_scopes = self.challenge_required_scopes();
        let initial_status = self
            .token_store
            .load_status(&oauth_config, &required_scopes)?;
        let _refresh_guard = self.refresh_lock.lock().await;
        if let Some(status) = self
            .token_store
            .load_status(&oauth_config, &required_scopes)?
        {
            let token_changed = initial_status.as_ref().is_none_or(|initial| {
                initial.token.access_token != status.token.access_token
                    || initial.token.refresh_token != status.token.refresh_token
            });
            if token_changed && Self::status_has_usable_access_token(&status) {
                info!(
                    "[{}] OAuth token was refreshed by another caller after unauthorized response",
                    self.server_name
                );
                return Ok(OAuthRefreshOutcome::Refreshed);
            }
            if status.can_refresh {
                info!(
                    "[{}] attempting OAuth token refresh after unauthorized response",
                    self.server_name
                );
                match self.refresh_access_token(&status).await {
                    Ok(_) => {
                        info!(
                            "[{}] OAuth token refresh succeeded after unauthorized response",
                            self.server_name
                        );
                        return Ok(OAuthRefreshOutcome::Refreshed);
                    }
                    Err(error) => {
                        warn!(
                            "[{}] OAuth token refresh failed after unauthorized response: {error:#}",
                            self.server_name
                        );
                        oauth_warn(format!(
                            "[{}] OAuth token refresh failed after unauthorized response: {error:#}",
                            self.server_name
                        ));
                        if let Some(reason) = terminal_refresh_failure_reason(&error) {
                            let authorization_url = self
                                .restart_authorization_after_terminal_refresh_failure(&reason)
                                .await?;
                            return Ok(OAuthRefreshOutcome::AuthorizationRequired(
                                authorization_url,
                            ));
                        }
                    }
                }
            }
        }
        info!(
            "[{}] OAuth refresh unavailable or failed; generating authorization URL",
            self.server_name
        );
        self.coordinator.restart_oauth_flow(&self.server_name).await;
        oauth_warn(format!(
            "[{}] OAuth refresh unavailable or failed; restarting authorization flow",
            self.server_name
        ));
        self.ensure_authorization_url(true)
            .await
            .map(OAuthRefreshOutcome::AuthorizationRequired)
    }

    pub async fn mark_persistent_unauthorized_failure(
        &self,
        reason: &str,
        auth_header: Option<&str>,
    ) {
        let discovered_resource = self
            .discovered_resource
            .read()
            .await
            .clone()
            .unwrap_or_else(|| "<none>".to_string());
        let effective_resource = self
            .effective_resource()
            .await
            .unwrap_or_else(|| "<none>".to_string());
        let token_aud = {
            let oauth_config = self.effective_oauth_config().await;
            let required_scopes = self.challenge_required_scopes();
            match self
                .token_store
                .load_status(&oauth_config, &required_scopes)
            {
                Ok(Some(status)) => decode_jwt_audiences(&status.token.access_token)
                    .filter(|values| !values.is_empty())
                    .map(|values| values.join(", "))
                    .unwrap_or_else(|| "<opaque-or-missing-aud>".to_string()),
                Ok(None) => "<no-token-status>".to_string(),
                Err(error) => format!("<token-status-error:{error}>"),
            }
        };
        let challenge = auth_header
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("<none>");
        let message = format!(
            "{reason} (mcp_url={}; discovered_resource={}; effective_resource={}; token_aud={}; challenge={})",
            self.mcp_url, discovered_resource, effective_resource, token_aud, challenge
        );

        if self.uses_access_token_broker() {
            match self.request_access_token_from_broker(false, true).await {
                Ok(OAuthBrokerSeedOutcome::AuthorizationRequired(_)) => {
                    if let Err(error) = self.token_store.clear_tokens() {
                        oauth_error(format!(
                            "[{}] failed to clear broker-rejected OAuth token: {error:#}",
                            self.server_name
                        ));
                    }
                    oauth_error(format!(
                        "[{}] secure OAuth record invalidated after persistent downstream unauthorized response: {}",
                        self.server_name, message
                    ));
                    return;
                }
                Ok(OAuthBrokerSeedOutcome::Seeded) => {
                    oauth_warn(format!(
                        "[{}] preserved a newer secure OAuth record while processing an older rejected token",
                        self.server_name
                    ));
                    return;
                }
                Ok(OAuthBrokerSeedOutcome::NotConfigured) => {}
                Err(error) => {
                    oauth_error(format!(
                        "[{}] failed to invalidate persistent downstream OAuth rejection through host broker: {error:#}",
                        self.server_name
                    ));
                }
            }
        }

        match self.token_store.clear_tokens() {
            Ok(()) => {
                oauth_warn(format!(
                    "[{}] cleared persisted OAuth token after repeated unauthorized responses",
                    self.server_name
                ));
            }
            Err(error) => {
                oauth_error(format!(
                    "[{}] failed to clear rejected OAuth token: {error:#}",
                    self.server_name
                ));
            }
        }
        self.coordinator
            .mark_failed(&self.server_name, message.clone())
            .await;
        oauth_error(format!(
            "[{}] persistent OAuth unauthorized failure: {}",
            self.server_name, message
        ));
    }

    pub async fn mark_connected(&self) {
        self.coordinator.mark_connected(&self.server_name).await;
    }

    pub async fn handle_auth_required(&self, error: &AuthRequiredError) -> Result<Option<String>> {
        info!(
            "OAuth authorization required for '{}': {}",
            self.server_name, error.www_authenticate_header
        );
        match self
            .handle_unauthorized_header(Some(&error.www_authenticate_header))
            .await?
        {
            OAuthRefreshOutcome::Refreshed => Ok(None),
            OAuthRefreshOutcome::AuthorizationRequired(url) => Ok(Some(url)),
        }
    }

    pub fn oauth_config(&self) -> &OAuthConfig {
        &self.oauth_config
    }

    pub async fn handshake(&self) -> Option<super::OAuthHandshake> {
        self.coordinator.get_handshake(&self.server_name).await
    }

    async fn effective_oauth_config(&self) -> OAuthConfig {
        let mut config = self.oauth_config.clone();
        if config.configured_resource().is_none() {
            config.resource = self.effective_resource().await;
        }
        config
    }

    fn canonicalize_discovered_resource(&self, resource: &str) -> String {
        resource.trim().to_string()
    }

    async fn effective_resource(&self) -> Option<String> {
        if let Some(resource) = self.oauth_config.configured_resource() {
            return Some(resource);
        }
        if let Some(resource) = self.discovered_resource.read().await.clone() {
            return Some(resource);
        }
        self.oauth_config
            .infer_resource_from_url()
            .then(|| self.mcp_url.clone())
    }

    async fn discover_auth_challenge_header(&self, header: &str) -> Result<bool> {
        let discovery = discover_from_auth_challenge(
            &reqwest::Client::new(),
            &self.server_name,
            header,
            &self.mcp_url,
        )
        .await?;
        match discovery {
            Some(discovery) => self.apply_discovery(discovery).await,
            None => Ok(false),
        }
    }

    pub(crate) async fn apply_discovery(&self, discovery: OAuthDiscovery) -> Result<bool> {
        let mut changed = false;

        if let Some(resource) = discovery.resource {
            let trimmed = resource.trim().to_string();
            if !trimmed.is_empty() {
                let canonical = self.canonicalize_discovered_resource(&trimmed);
                if canonical != trimmed {
                    info!(
                        "[{}] canonicalized discovered OAuth resource to normalized MCP URL: {} -> {}",
                        self.server_name, trimmed, canonical
                    );
                    oauth_info(format!(
                        "[{}] canonicalized discovered OAuth resource to normalized MCP URL: {} -> {}",
                        self.server_name, trimmed, canonical
                    ));
                }
                let mut guard = self.discovered_resource.write().await;
                if guard.as_deref() != Some(canonical.as_str()) {
                    info!(
                        "[{}] caching discovered OAuth resource '{}'",
                        self.server_name, canonical
                    );
                    *guard = Some(canonical);
                    changed = true;
                }
            }
        }

        if let Some(metadata) = discovery.metadata {
            let next_fingerprint =
                serde_json::to_string(&metadata).context("failed to fingerprint OAuth metadata")?;
            let mut guard = self.metadata.write().await;
            let current_fingerprint = guard
                .as_ref()
                .and_then(|current| serde_json::to_string(current).ok());
            if current_fingerprint.as_deref() != Some(next_fingerprint.as_str()) {
                info!(
                    "[{}] caching discovered OAuth authorization metadata",
                    self.server_name
                );
                *guard = Some(metadata.clone());
                self.manager.lock().await.set_metadata(metadata);
                changed = true;
            }
        }

        if !discovery.challenge_scopes.is_empty() {
            let mut guard = self.challenge_scopes.write().await;
            if *guard != discovery.challenge_scopes {
                info!(
                    "[{}] caching OAuth challenge scopes {:?}",
                    self.server_name, discovery.challenge_scopes
                );
                *guard = discovery.challenge_scopes;
                changed = true;
            }
        }

        if !discovery.protected_resource_scopes.is_empty() {
            let mut guard = self.protected_resource_scopes.write().await;
            if *guard != discovery.protected_resource_scopes {
                info!(
                    "[{}] caching OAuth protected-resource scopes {:?}",
                    self.server_name, discovery.protected_resource_scopes
                );
                *guard = discovery.protected_resource_scopes;
                changed = true;
            }
        }

        Ok(changed)
    }

    async fn ensure_metadata(&self) -> Result<AuthorizationMetadata> {
        if let Some(metadata) = self.metadata.read().await.clone() {
            return Ok(metadata);
        }

        let metadata = if self.oauth_config.authorization_endpoint.is_some()
            && self.oauth_config.token_endpoint.is_some()
        {
            AuthorizationMetadata {
                authorization_endpoint: self.oauth_config.authorization_endpoint.clone().unwrap(),
                token_endpoint: self.oauth_config.token_endpoint.clone().unwrap(),
                registration_endpoint: self.oauth_config.registration_endpoint.clone(),
                issuer: None,
                jwks_uri: None,
                scopes_supported: if self.oauth_config.configured_scopes().is_empty() {
                    None
                } else {
                    Some(self.oauth_config.configured_scopes())
                },
                response_types_supported: None,
                code_challenge_methods_supported: Some(vec!["S256".to_string()]),
                additional_fields: HashMap::new(),
            }
        } else {
            match self.discover_metadata().await {
                Ok(metadata) => metadata,
                Err(error) => {
                    if let Some(metadata) = self.fallback_metadata() {
                        warn!(
                            "[{}] OAuth metadata discovery failed; using static provider fallback: {error:#}",
                            self.server_name
                        );
                        metadata
                    } else {
                        return Err(error);
                    }
                }
            }
        };

        {
            let mut guard = self.metadata.write().await;
            *guard = Some(metadata.clone());
        }
        {
            let mut manager = self.manager.lock().await;
            manager.set_metadata(metadata.clone());
        }
        Ok(metadata)
    }

    async fn discover_metadata(&self) -> Result<AuthorizationMetadata> {
        if let Some(discovery) = discover_from_base_url(
            &reqwest::Client::new(),
            &self.server_name,
            &self.oauth_config.resource_url(&self.mcp_url),
        )
        .await?
        {
            let metadata = discovery.metadata.clone();
            let authorization_server = discovery.authorization_servers.first().cloned();
            let _ = self.apply_discovery(discovery).await?;
            if let Some(metadata) = metadata {
                return Ok(metadata);
            }
            if let Some(metadata) = discover_metadata_from_authorization_server(
                &self.server_name,
                authorization_server.as_deref(),
            )
            .await?
            {
                return Ok(metadata);
            }
        }

        let discovery_base = self.oauth_config.discovery_base(&self.mcp_url);
        let temp_manager = AuthorizationManager::new(discovery_base.clone())
            .await
            .with_context(|| format!("failed to create discovery manager for {discovery_base}"))?;
        temp_manager
            .discover_metadata()
            .await
            .with_context(|| format!("failed to discover OAuth metadata from {discovery_base}"))
    }

    fn fallback_metadata(&self) -> Option<AuthorizationMetadata> {
        let (authorization_endpoint, token_endpoint) =
            self.oauth_config.fallback_authorization_endpoints()?;
        Some(AuthorizationMetadata {
            authorization_endpoint: authorization_endpoint.to_string(),
            token_endpoint: token_endpoint.to_string(),
            registration_endpoint: None,
            issuer: None,
            jwks_uri: None,
            scopes_supported: if self.oauth_config.configured_scopes().is_empty() {
                None
            } else {
                Some(self.oauth_config.configured_scopes())
            },
            response_types_supported: None,
            code_challenge_methods_supported: Some(vec!["S256".to_string()]),
            additional_fields: HashMap::new(),
        })
    }

    async fn ensure_client_info(
        &self,
        metadata: &AuthorizationMetadata,
    ) -> Result<CompatClientInfo> {
        if self.oauth_config.is_non_dcr() {
            let source = self.oauth_config.credentials_source.as_ref().ok_or_else(|| {
                anyhow!(
                    "OAuth type 'non-dcr' requires credentials_source with a pre-registered client. Add credentials_source with client_id and include client_secret if the client is confidential."
                )
            })?;
            let credentials = source.load().await?;
            let client_info = build_client_info_from_credentials(&self.oauth_config, credentials);
            if let Some(stored) = self.token_store.load_client_info()? {
                if non_dcr_client_info_matches_config(&stored, &client_info) {
                    return Ok(stored);
                }
                oauth_warn(format!(
                    "[{}] stored OAuth client metadata no longer matches non-DCR config; replacing client metadata and clearing stale tokens",
                    self.server_name
                ));
                self.token_store.clear_tokens()?;
            }
            self.token_store.save_client_info(&client_info)?;
            return Ok(client_info);
        }

        if let Some(client_info) = self.token_store.load_client_info()? {
            return Ok(client_info);
        }

        if let Some(source) = self.oauth_config.credentials_source.as_ref() {
            let credentials = source.load().await?;
            let client_info = build_client_info_from_credentials(&self.oauth_config, credentials);
            self.token_store.save_client_info(&client_info)?;
            return Ok(client_info);
        }

        self.dynamic_client_register(metadata).await
    }

    async fn dynamic_client_register(
        &self,
        metadata: &AuthorizationMetadata,
    ) -> Result<CompatClientInfo> {
        let registration_endpoint = metadata
            .registration_endpoint
            .clone()
            .ok_or_else(|| anyhow!("authorization server does not support dynamic registration"))?;
        let request = self.dynamic_registration_request(false);
        let client = reqwest::Client::new();
        let mut response = client
            .post(&registration_endpoint)
            .json(&request)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .with_context(|| format!("failed to POST {registration_endpoint}"))?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            if self.should_retry_registration_without_scope(&body) {
                warn!(
                    "[{}] dynamic client registration rejected OAuth scope metadata; retrying once without scope",
                    self.server_name
                );
                oauth_warn(format!(
                    "[{}] dynamic client registration rejected OAuth scope metadata; retrying once without scope",
                    self.server_name
                ));
                response = client
                    .post(&registration_endpoint)
                    .json(&self.dynamic_registration_request(true))
                    .timeout(Duration::from_secs(30))
                    .send()
                    .await
                    .with_context(|| format!("failed to POST {registration_endpoint}"))?;
                if !response.status().is_success() {
                    let retry_status = response.status();
                    let retry_body = response.text().await.unwrap_or_default();
                    oauth_error(format!(
                        "[{}] dynamic client registration failed after retry with HTTP {}: {}",
                        self.server_name, retry_status, retry_body
                    ));
                    bail!(
                        "dynamic client registration failed with HTTP {retry_status}: {retry_body}"
                    );
                }
            } else {
                oauth_error(format!(
                    "[{}] dynamic client registration failed with HTTP {}: {}",
                    self.server_name, status, body
                ));
                bail!("dynamic client registration failed with HTTP {status}: {body}");
            }
        }
        let body: serde_json::Value = response
            .json()
            .await
            .context("dynamic client registration returned invalid JSON")?;
        let mut client_info: CompatClientInfo = serde_json::from_value(body.clone())
            .context("dynamic client registration response is invalid")?;
        if client_info.redirect_uris.is_empty() {
            client_info.redirect_uris = self.oauth_config.redirect_uris();
        }
        if client_info.grant_types.is_empty() {
            client_info.grant_types = self.oauth_config.grant_types();
        }
        if client_info.response_types.is_empty() {
            client_info.response_types = self.oauth_config.response_types();
        }
        if client_info.token_endpoint_auth_method.is_none() {
            client_info.token_endpoint_auth_method = Some("none".to_string());
        }
        if client_info.client_name.is_none() {
            client_info.client_name = Some(self.oauth_config.client_name());
        }
        if client_info.scope.is_none() {
            client_info.scope = joined_scope(self.oauth_config.configured_scopes());
        }
        self.token_store.save_client_info(&client_info)?;
        Ok(client_info)
    }

    fn dynamic_registration_request(&self, omit_scope: bool) -> serde_json::Value {
        let mut request = serde_json::Map::new();
        request.insert(
            "client_name".to_string(),
            serde_json::Value::String(self.oauth_config.client_name()),
        );
        request.insert(
            "redirect_uris".to_string(),
            serde_json::json!(self.oauth_config.redirect_uris()),
        );
        request.insert(
            "grant_types".to_string(),
            serde_json::json!(self.oauth_config.grant_types()),
        );
        request.insert(
            "token_endpoint_auth_method".to_string(),
            serde_json::Value::String("none".to_string()),
        );
        request.insert(
            "response_types".to_string(),
            serde_json::json!(self.oauth_config.response_types()),
        );
        if !omit_scope {
            if let Some(scope) = joined_scope(self.oauth_config.configured_scopes()) {
                request.insert("scope".to_string(), serde_json::Value::String(scope));
            }
        }
        serde_json::Value::Object(request)
    }

    fn should_retry_registration_without_scope(&self, body: &str) -> bool {
        let normalized = body.to_ascii_lowercase();
        normalized.contains("requested scopes are invalid or not supported")
            || (normalized.contains("invalid_client_metadata") && normalized.contains("scope"))
            || (normalized.contains("oauthregistrationerror") && normalized.contains("scope"))
    }

    async fn configure_manager(
        &self,
        metadata: &AuthorizationMetadata,
        client_info: &CompatClientInfo,
    ) -> Result<()> {
        let scopes = self.request_scopes(metadata, client_info);
        let redirect_uri = resolve_redirect_uri(&self.oauth_config, client_info);
        let config = OAuthClientConfig {
            client_id: client_info.client_id.clone(),
            client_secret: client_info.client_secret.clone(),
            scopes,
            redirect_uri,
        };
        let mut manager = self.manager.lock().await;
        manager.set_metadata(metadata.clone());
        manager
            .configure_client(config)
            .context("failed to configure OAuth client")
    }

    fn challenge_required_scopes(&self) -> Vec<String> {
        if let Ok(guard) = self.challenge_scopes.try_read() {
            if !guard.is_empty() {
                return guard.clone();
            }
        }
        self.oauth_config.persisted_discovered_challenge_scopes()
    }

    fn protected_resource_request_scopes(&self) -> Vec<String> {
        if let Ok(guard) = self.protected_resource_scopes.try_read() {
            return guard.clone();
        }
        Vec::new()
    }

    fn token_required_scopes(&self) -> Vec<String> {
        let mut required: Vec<String> = Vec::new();
        for scope in self.challenge_required_scopes() {
            let trimmed = scope.trim();
            if trimmed.is_empty()
                || REQUEST_ONLY_TOKEN_SCOPES.contains(&trimmed)
                || required.iter().any(|existing| existing.as_str() == trimmed)
            {
                continue;
            }
            required.push(trimmed.to_string());
        }
        required
    }

    fn authoritative_scopes(&self, metadata: &AuthorizationMetadata) -> Vec<String> {
        let challenge = self.challenge_required_scopes();
        if !challenge.is_empty() {
            return challenge;
        }
        let configured = self.oauth_config.configured_scopes();
        if !configured.is_empty() {
            return configured;
        }
        let protected_resource = self.protected_resource_request_scopes();
        if !protected_resource.is_empty() {
            return protected_resource;
        }
        if let Some(scopes) = metadata
            .scopes_supported
            .as_ref()
            .filter(|scopes| !scopes.is_empty())
        {
            return scopes.clone();
        }
        Vec::new()
    }

    fn request_scopes(
        &self,
        metadata: &AuthorizationMetadata,
        client_info: &CompatClientInfo,
    ) -> Vec<String> {
        let mut scopes = self.authoritative_scopes(metadata);
        if self.should_request_offline_access(metadata, client_info)
            && !scopes.iter().any(|scope| scope.trim() == "offline_access")
        {
            oauth_info(format!(
                "[{}] requesting advertised offline_access for durable OAuth refresh support",
                self.server_name
            ));
            scopes.push("offline_access".to_string());
        }
        scopes
    }

    fn should_request_offline_access(
        &self,
        metadata: &AuthorizationMetadata,
        client_info: &CompatClientInfo,
    ) -> bool {
        self.oauth_config.is_non_dcr()
            && client_info.token_endpoint_auth_method.as_deref() == Some("none")
            && client_info.client_secret.is_none()
            && metadata
                .scopes_supported
                .as_ref()
                .is_some_and(|scopes| scopes.iter().any(|scope| scope.trim() == "offline_access"))
    }

    fn required_token_scopes(
        &self,
        _metadata: &AuthorizationMetadata,
        _client_info: &CompatClientInfo,
    ) -> Vec<String> {
        self.token_required_scopes()
    }

    fn normalize_and_validate_token(
        &self,
        mut token: CompatTokenFile,
        required_scopes: &[String],
        fallback_scope: Option<String>,
    ) -> Result<CompatTokenFile> {
        let current_scope = token.scope.as_ref().map(|value| value.trim()).unwrap_or("");
        if current_scope.is_empty() {
            token.scope = fallback_scope
                .filter(|value| !value.trim().is_empty())
                .or_else(|| joined_scope(required_scopes.to_vec()));
        }

        if required_scopes.is_empty() {
            return Ok(token);
        }

        if let Some(granted_scopes) = token_scopes(&token) {
            let granted = granted_scopes.into_iter().collect::<BTreeSet<_>>();
            let missing = required_scopes
                .iter()
                .filter(|scope| !granted.contains(scope.as_str()))
                .cloned()
                .collect::<Vec<_>>();
            if !missing.is_empty() {
                bail!(
                    "token response missing required scopes: {}",
                    missing.join(", ")
                );
            }
        }

        Ok(token)
    }

    fn validate_refreshed_token_audience(
        &self,
        token: &CompatTokenFile,
        oauth_config: &OAuthConfig,
    ) -> Result<()> {
        if has_url_like_audience_mismatch(&token.access_token, oauth_config) {
            bail!(REFRESH_AUDIENCE_MISMATCH_ERROR);
        }
        Ok(())
    }

    async fn read_token_endpoint_json(
        &self,
        operation: &str,
        token_endpoint: &str,
        response: reqwest::Response,
    ) -> Result<serde_json::Value> {
        let response_status = response.status();
        let response_headers = response.headers().clone();
        let response_body = response
            .bytes()
            .await
            .with_context(|| format!("failed to read {operation} response body"))?;
        let location_suffix = response_headers
            .get("location")
            .and_then(|value| value.to_str().ok())
            .map(|value| format!(" (location={value})"))
            .unwrap_or_default();

        if !response_status.is_success() {
            let oauth_error_suffix = token_endpoint_oauth_error_suffix(&response_body);
            oauth_error(format!(
                "[{}] {} failed from {} (status={}, headers={{{}}}, body_bytes={}, body_snippet=\"{}\")",
                self.server_name,
                operation,
                token_endpoint,
                response_status.as_u16(),
                summarize_refresh_response_headers(&response_headers),
                response_body.len(),
                summarize_refresh_response_body_snippet(&response_body),
            ));
            bail!(
                "{operation} failed with HTTP {response_status}{location_suffix}{oauth_error_suffix}"
            );
        }

        match serde_json::from_slice(&response_body) {
            Ok(body) => Ok(body),
            Err(error) => {
                oauth_error(format!(
                    "[{}] {} returned invalid JSON from {} (status={}, headers={{{}}}, body_bytes={}, body_snippet=\"{}\", parse_error={})",
                    self.server_name,
                    operation,
                    token_endpoint,
                    response_status.as_u16(),
                    summarize_refresh_response_headers(&response_headers),
                    response_body.len(),
                    summarize_refresh_response_body_snippet(&response_body),
                    error
                ));
                Err(error).context(format!("{operation} returned invalid JSON"))
            }
        }
    }

    async fn refresh_access_token(&self, status: &TokenStatus) -> Result<CompatTokenFile> {
        let metadata = self.ensure_metadata().await?;
        let client_info = &status.client_info;
        let refresh_token = status
            .token
            .refresh_token
            .as_ref()
            .ok_or_else(|| anyhow!("refresh_token missing"))?;
        let token_endpoint = metadata.token_endpoint.clone();

        let auth_method = client_info
            .token_endpoint_auth_method
            .as_deref()
            .unwrap_or_else(|| {
                if client_info.client_secret.is_some() {
                    "client_secret_post"
                } else {
                    "none"
                }
            });

        let mut form = vec![
            ("grant_type".to_string(), "refresh_token".to_string()),
            ("refresh_token".to_string(), refresh_token.clone()),
        ];
        let required_scopes = self.required_token_scopes(&metadata, client_info);
        let mut request = token_endpoint_client()?.post(&token_endpoint);
        match auth_method {
            "client_secret_basic" => {
                request = request.basic_auth(
                    client_info.client_id.clone(),
                    client_info.client_secret.clone(),
                );
            }
            "none" => {
                form.push(("client_id".to_string(), client_info.client_id.clone()));
            }
            _ => {
                form.push(("client_id".to_string(), client_info.client_id.clone()));
                if let Some(secret) = client_info.client_secret.as_ref() {
                    form.push(("client_secret".to_string(), secret.clone()));
                }
            }
        }
        if let Some(resource) = self.effective_resource().await {
            form.push(("resource".to_string(), resource));
        }

        let response = request
            .form(&form)
            .send()
            .await
            .with_context(|| format!("failed to POST {token_endpoint}"))?;
        let body = self
            .read_token_endpoint_json("token refresh", &token_endpoint, response)
            .await?;
        let mut token = parse_token_response(body)?;
        if token.refresh_token.is_none() {
            token.refresh_token = status.token.refresh_token.clone();
        }
        let fallback_scope = status
            .token
            .scope
            .clone()
            .filter(|value| !value.trim().is_empty());
        token = self.normalize_and_validate_token(token, &required_scopes, fallback_scope)?;
        let oauth_config = self.effective_oauth_config().await;
        self.validate_refreshed_token_audience(&token, &oauth_config)?;
        self.token_store.save_token_file(&token)?;
        oauth_info(format!(
            "[{}] OAuth access token refreshed successfully",
            self.server_name
        ));
        Ok(token)
    }

    async fn exchange_code_for_tokens(
        &self,
        metadata: &AuthorizationMetadata,
        client_info: &CompatClientInfo,
        code: &str,
        pkce_verifier: &str,
        redirect_uri: &str,
    ) -> Result<CompatTokenFile> {
        let auth_method = client_info
            .token_endpoint_auth_method
            .as_deref()
            .unwrap_or_else(|| {
                if client_info.client_secret.is_some() {
                    "client_secret_post"
                } else {
                    "none"
                }
            });
        let mut form = vec![
            ("grant_type".to_string(), "authorization_code".to_string()),
            ("code".to_string(), code.to_string()),
            ("redirect_uri".to_string(), redirect_uri.to_string()),
            ("code_verifier".to_string(), pkce_verifier.to_string()),
        ];
        let mut request = token_endpoint_client()?.post(&metadata.token_endpoint);
        match auth_method {
            "client_secret_basic" => {
                request = request.basic_auth(
                    client_info.client_id.clone(),
                    client_info.client_secret.clone(),
                );
            }
            "none" => {
                form.push(("client_id".to_string(), client_info.client_id.clone()));
            }
            _ => {
                form.push(("client_id".to_string(), client_info.client_id.clone()));
                if let Some(secret) = client_info.client_secret.as_ref() {
                    form.push(("client_secret".to_string(), secret.clone()));
                }
            }
        }
        if let Some(resource) = self.effective_resource().await {
            form.push(("resource".to_string(), resource));
        }

        let response = request
            .form(&form)
            .send()
            .await
            .with_context(|| format!("failed to POST {}", metadata.token_endpoint))?;
        let body = self
            .read_token_endpoint_json("token exchange", &metadata.token_endpoint, response)
            .await?;
        let token = parse_token_response(body)?;
        let required_scopes = self.required_token_scopes(metadata, client_info);
        self.normalize_and_validate_token(token, &required_scopes, None)
    }
}

fn non_dcr_client_info_matches_config(
    stored: &CompatClientInfo,
    configured: &CompatClientInfo,
) -> bool {
    stored.client_id == configured.client_id
        && stored.client_secret == configured.client_secret
        && stored.token_endpoint_auth_method == configured.token_endpoint_auth_method
        && stored.redirect_uris == configured.redirect_uris
        && stored.grant_types == configured.grant_types
        && stored.response_types == configured.response_types
        && stored.scope == configured.scope
}

#[derive(Clone)]
pub struct OAuthStreamableHttpClient<C> {
    inner: C,
    binding: Arc<OAuthBinding>,
}

impl<C> OAuthStreamableHttpClient<C> {
    pub fn new(inner: C, binding: Arc<OAuthBinding>) -> Self {
        Self { inner, binding }
    }

    fn log_downstream_transport_error(
        &self,
        operation: &str,
        uri: &str,
        has_session_id: bool,
        has_auth: bool,
        error: &StreamableHttpError<OAuthTransportError<C::Error>>,
    ) where
        C: StreamableHttpClient + Clone + Send + Sync,
        C::Error: std::error::Error + Send + Sync + 'static,
    {
        warn!(
            "[{}] downstream OAuth streamable-http {} failed uri={} has_session_id={} has_auth={} error={}",
            self.binding.server_name, operation, uri, has_session_id, has_auth, error
        );
    }
}

#[derive(Debug, thiserror::Error)]
pub enum OAuthTransportError<E: std::error::Error + Send + Sync + 'static> {
    #[error(transparent)]
    Client(#[from] E),
    #[error("{0}")]
    Internal(String),
}

impl<C> StreamableHttpClient for OAuthStreamableHttpClient<C>
where
    C: StreamableHttpClient + Clone + Send + Sync,
{
    type Error = OAuthTransportError<C::Error>;

    fn delete_session(
        &self,
        uri: std::sync::Arc<str>,
        session_id: std::sync::Arc<str>,
        auth_token: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> impl Future<Output = Result<(), StreamableHttpError<Self::Error>>> + Send + '_ {
        async move {
            let auth_token = self.resolve_auth_token(auth_token).await?;
            let has_auth = auth_token.is_some();
            let uri_for_log = uri.to_string();
            let result = self
                .inner
                .delete_session(uri, session_id, auth_token, custom_headers)
                .await
                .map_err(map_streamable_error);
            if let Err(error) = &result {
                self.log_downstream_transport_error(
                    "delete_session",
                    &uri_for_log,
                    true,
                    has_auth,
                    error,
                );
            }
            result
        }
    }

    fn get_stream(
        &self,
        uri: std::sync::Arc<str>,
        session_id: std::sync::Arc<str>,
        last_event_id: Option<String>,
        auth_token: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> impl Future<
        Output = Result<
            BoxStream<'static, Result<Sse, SseError>>,
            StreamableHttpError<Self::Error>,
        >,
    > + Send
           + '_ {
        async move {
            let auth_token = self.resolve_auth_token(auth_token).await?;
            let has_auth = auth_token.is_some();
            let uri_for_log = uri.to_string();
            let result = self
                .inner
                .get_stream(uri, session_id, last_event_id, auth_token, custom_headers)
                .await
                .map_err(map_streamable_error);
            if let Err(error) = &result {
                self.log_downstream_transport_error(
                    "get_stream",
                    &uri_for_log,
                    true,
                    has_auth,
                    error,
                );
            }
            result
        }
    }

    fn post_message(
        &self,
        uri: std::sync::Arc<str>,
        message: rmcp::model::ClientJsonRpcMessage,
        session_id: Option<std::sync::Arc<str>>,
        auth_token: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> impl Future<Output = Result<StreamableHttpPostResponse, StreamableHttpError<Self::Error>>>
           + Send
           + '_ {
        async move {
            let auth_token = self.resolve_auth_token(auth_token).await?;
            let has_auth = auth_token.is_some();
            let has_session_id = session_id.is_some();
            let uri_for_log = uri.to_string();
            let result = self
                .inner
                .post_message(uri, message, session_id, auth_token, custom_headers)
                .await
                .map_err(map_streamable_error);
            if let Err(error) = &result {
                self.log_downstream_transport_error(
                    "post_message",
                    &uri_for_log,
                    has_session_id,
                    has_auth,
                    error,
                );
            }
            result
        }
    }
}

impl<C> OAuthStreamableHttpClient<C>
where
    C: StreamableHttpClient + Clone + Send + Sync,
{
    async fn resolve_auth_token(
        &self,
        auth_token: Option<String>,
    ) -> Result<Option<String>, StreamableHttpError<OAuthTransportError<C::Error>>> {
        if let Some(token) = auth_token {
            info!(
                "[{}] using transport-supplied OAuth bearer token for downstream MCP request",
                self.binding.server_name
            );
            return Ok(Some(token));
        }
        let token = self.binding.access_token().await.map_err(|error| {
            StreamableHttpError::Client(OAuthTransportError::Internal(error.to_string()))
        })?;
        if token.is_some() {
            info!(
                "[{}] attached stored OAuth bearer token to downstream MCP request",
                self.binding.server_name
            );
        } else {
            warn!(
                "[{}] no OAuth bearer token available for downstream MCP request",
                self.binding.server_name
            );
        }
        Ok(token)
    }
}

#[cfg(test)]
#[path = "binding_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "binding_parity_tests.rs"]
mod parity_tests;

#[cfg(test)]
#[path = "binding_registration_tests.rs"]
mod registration_tests;
