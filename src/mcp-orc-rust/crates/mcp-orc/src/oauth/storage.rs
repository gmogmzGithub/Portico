use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use base64::Engine;
use reqwest::Url;
use rmcp::transport::auth::{StateStore, StoredAuthorizationState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::sync::RwLock;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use super::config::{sanitize_localhost_redirect_uris, OAuthConfig};

fn token_endpoint_error_details(value: &Value) -> Option<(String, Option<String>)> {
    let object = value.as_object()?;
    if object.get("ok").and_then(Value::as_bool) != Some(false) {
        return None;
    }
    let error = object
        .get("error")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_string();
    let description = object
        .get("error_description")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Some((error, description))
}

fn normalize_token_endpoint_response(mut value: Value) -> Result<Value> {
    if let Some((error, description)) = token_endpoint_error_details(&value) {
        if let Some(description) = description {
            bail!("token endpoint error: {error} ({description})");
        }
        bail!("token endpoint error: {error}");
    }

    let Some(object) = value.as_object_mut() else {
        return Ok(value);
    };

    let nested_token = object
        .values()
        .filter_map(Value::as_object)
        .find(|candidate| has_non_empty_string_field(candidate, "access_token"))
        .cloned();
    let Some(nested_token) = nested_token else {
        return Ok(value);
    };

    promote_missing_string_field(object, &nested_token, "access_token");
    promote_missing_string_field(object, &nested_token, "scope");
    promote_missing_string_field(object, &nested_token, "token_type");
    promote_missing_string_field(object, &nested_token, "refresh_token");
    promote_missing_i64_field(object, &nested_token, "expires_in");

    Ok(value)
}

fn has_non_empty_string_field(object: &Map<String, Value>, field: &str) -> bool {
    object
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
}

fn promote_missing_string_field(
    target: &mut Map<String, Value>,
    source: &Map<String, Value>,
    field: &str,
) {
    if target.contains_key(field) {
        return;
    }
    if let Some(value) = source
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        target.insert(field.to_string(), Value::String(value.to_string()));
    }
}

fn promote_missing_i64_field(
    target: &mut Map<String, Value>,
    source: &Map<String, Value>,
    field: &str,
) {
    if target.contains_key(field) {
        return;
    }
    if let Some(value) = source.get(field).filter(|value| value.as_i64().is_some()) {
        target.insert(field.to_string(), value.clone());
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CompatTokenFile {
    pub access_token: String,
    pub token_type: Option<String>,
    pub expires_in: Option<i64>,
    pub refresh_token: Option<String>,
    pub scope: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CompatClientInfo {
    #[serde(default)]
    pub redirect_uris: Vec<String>,
    pub token_endpoint_auth_method: Option<String>,
    #[serde(default)]
    pub grant_types: Vec<String>,
    #[serde(default)]
    pub response_types: Vec<String>,
    pub scope: Option<String>,
    pub client_name: Option<String>,
    pub client_uri: Option<String>,
    pub logo_uri: Option<String>,
    pub contacts: Option<Vec<String>>,
    pub tos_uri: Option<String>,
    pub policy_uri: Option<String>,
    pub jwks_uri: Option<String>,
    pub jwks: Option<Value>,
    pub software_id: Option<String>,
    pub software_version: Option<String>,
    pub client_id: String,
    pub client_secret: Option<String>,
    pub client_id_issued_at: Option<i64>,
    pub client_secret_expires_at: Option<i64>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone)]
pub struct TokenStatus {
    pub token: CompatTokenFile,
    pub client_info: CompatClientInfo,
    pub expires_in: Option<i64>,
    pub is_expired: bool,
    pub audience_mismatch: bool,
    pub scope_mismatch: bool,
    pub can_refresh: bool,
}

#[derive(Debug, Clone)]
pub struct CompatTokenStore {
    server_name: String,
    storage_dir: PathBuf,
    backend: TokenStoreBackend,
}

#[derive(Debug, Clone)]
enum TokenStoreBackend {
    File,
    Memory,
}

#[derive(Debug, Clone, Default)]
struct InMemoryTokenEntry {
    token: Option<CompatTokenFile>,
    client_info: Option<CompatClientInfo>,
}

fn read_json_value_from_storage(path: &Path) -> Result<(Value, bool)> {
    let raw =
        fs::read_to_string(path).with_context(|| format!("failed to read {}", path.display()))?;
    let parsed: Value = serde_json::from_str(&raw)
        .with_context(|| format!("invalid JSON in {}", path.display()))?;
    if is_legacy_encrypted_oauth_payload(&parsed) {
        bail!(
            "legacy encrypted OAuth token file {} is unsupported; reauthorize this server",
            path.display()
        );
    }
    Ok((parsed, false))
}

fn is_legacy_encrypted_oauth_payload(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.contains_key("_enc_v")
        && object.contains_key("_enc_alg")
        && object.contains_key("ciphertext")
        && object.contains_key("nonce")
        && object.contains_key("tag")
}

fn write_json_value_to_storage(path: &Path, value: &Value) -> Result<()> {
    let raw = serde_json::to_vec(value).context("failed to serialize oauth payload")?;
    fs::write(path, raw).with_context(|| format!("failed to write {}", path.display()))?;
    set_strict_file_permissions(path);
    Ok(())
}

fn maybe_migrate_plaintext_storage(
    _path: &Path,
    _value: &Value,
    _was_encrypted: bool,
) -> Result<()> {
    Ok(())
}

fn set_strict_dir_permissions(path: &Path) {
    #[cfg(unix)]
    {
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
    }
}

fn set_strict_file_permissions(path: &Path) {
    #[cfg(unix)]
    {
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
}

impl CompatTokenStore {
    pub fn new(server_name: impl Into<String>) -> Result<Self> {
        Self::with_storage_type(server_name, None)
    }

    pub fn with_storage_dir(
        server_name: impl Into<String>,
        storage_dir: impl Into<PathBuf>,
    ) -> Result<Self> {
        Self::with_storage_type_and_dir(server_name, Some(storage_dir.into()), None)
    }

    pub fn with_storage_type(
        server_name: impl Into<String>,
        storage_type: Option<&str>,
    ) -> Result<Self> {
        Self::with_storage_type_and_dir(server_name, None, storage_type)
    }

    fn with_storage_type_and_dir(
        server_name: impl Into<String>,
        storage_dir_override: Option<PathBuf>,
        storage_type: Option<&str>,
    ) -> Result<Self> {
        let server_name = server_name.into();
        let storage_dir = storage_dir_override.unwrap_or_else(|| {
            std::env::var("MCPO_TOKEN_STORAGE_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|_| {
                    let home = std::env::var("HOME").unwrap_or_else(|_| "/root".to_string());
                    Path::new(&home).join(".mcpo").join("tokens")
                })
        });
        let backend = match storage_type.unwrap_or("file").trim() {
            "" | "file" => {
                fs::create_dir_all(&storage_dir)
                    .with_context(|| format!("failed to create {}", storage_dir.display()))?;
                set_strict_dir_permissions(&storage_dir);
                TokenStoreBackend::File
            }
            "memory" => TokenStoreBackend::Memory,
            other => bail!("unsupported oauth storage_type '{other}'"),
        };
        Ok(Self {
            server_name,
            storage_dir,
            backend,
        })
    }

    pub fn token_file(&self) -> PathBuf {
        self.storage_dir.join(format!(
            "{}_tokens.json",
            safe_server_hash(&self.server_name)
        ))
    }

    pub fn client_file(&self) -> PathBuf {
        self.storage_dir.join(format!(
            "{}_client.json",
            safe_server_hash(&self.server_name)
        ))
    }

    pub fn load_client_info(&self) -> Result<Option<CompatClientInfo>> {
        match self.backend {
            TokenStoreBackend::File => {
                let path = self.client_file();
                if !path.exists() {
                    return Ok(None);
                }
                let (raw_value, was_encrypted) = read_json_value_from_storage(&path)?;
                let mut parsed: CompatClientInfo = serde_json::from_value(raw_value)
                    .with_context(|| format!("invalid JSON in {}", path.display()))?;
                let sanitized_redirect_uris =
                    sanitize_localhost_redirect_uris(&parsed.redirect_uris);
                if sanitized_redirect_uris != parsed.redirect_uris {
                    if sanitized_redirect_uris.is_empty() && !parsed.redirect_uris.is_empty() {
                        fs::remove_file(&path)
                            .with_context(|| format!("failed to remove {}", path.display()))?;
                        return Ok(None);
                    }
                    parsed.redirect_uris = sanitized_redirect_uris;
                    let rewritten = serde_json::to_value(&parsed)
                        .context("failed to serialize sanitized client info")?;
                    write_json_value_to_storage(&path, &rewritten)?;
                } else {
                    let current =
                        serde_json::to_value(&parsed).context("failed to serialize client info")?;
                    maybe_migrate_plaintext_storage(&path, &current, was_encrypted)?;
                }
                Ok(Some(parsed))
            }
            TokenStoreBackend::Memory => Ok(memory_entry(&self.server_name)?.client_info),
        }
    }

    pub fn save_client_info(&self, client_info: &CompatClientInfo) -> Result<()> {
        match self.backend {
            TokenStoreBackend::File => {
                self.ensure_file_storage_dir()?;
                let path = self.client_file();
                let value =
                    serde_json::to_value(client_info).context("failed to serialize client info")?;
                write_json_value_to_storage(&path, &value)
            }
            TokenStoreBackend::Memory => {
                let mut guard = memory_entries()
                    .lock()
                    .map_err(|_| anyhow::anyhow!("in-memory token storage mutex poisoned"))?;
                let entry = guard.entry(self.server_name.clone()).or_default();
                entry.client_info = Some(client_info.clone());
                Ok(())
            }
        }
    }

    pub fn load_token_file(&self) -> Result<Option<CompatTokenFile>> {
        match self.backend {
            TokenStoreBackend::File => {
                let path = self.token_file();
                if !path.exists() {
                    return Ok(None);
                }
                let (raw_value, was_encrypted) = read_json_value_from_storage(&path)?;
                let parsed: CompatTokenFile = serde_json::from_value(raw_value)
                    .with_context(|| format!("invalid JSON in {}", path.display()))?;
                let current =
                    serde_json::to_value(&parsed).context("failed to serialize token payload")?;
                maybe_migrate_plaintext_storage(&path, &current, was_encrypted)?;
                Ok(Some(parsed))
            }
            TokenStoreBackend::Memory => Ok(memory_entry(&self.server_name)?.token),
        }
    }

    pub fn save_token_file(&self, token: &CompatTokenFile) -> Result<()> {
        let mut payload = token.clone();
        if payload.refresh_token.is_none() || payload.scope.is_none() {
            if let Some(existing) = self.load_token_file()? {
                if payload.scope.is_none() {
                    payload.scope = existing.scope.clone();
                }
                if payload.refresh_token.is_none() {
                    payload.refresh_token = existing.refresh_token;
                }
            }
        }
        match self.backend {
            TokenStoreBackend::File => {
                self.ensure_file_storage_dir()?;
                let path = self.token_file();
                let value =
                    serde_json::to_value(&payload).context("failed to serialize token file")?;
                write_json_value_to_storage(&path, &value)
            }
            TokenStoreBackend::Memory => {
                let mut guard = memory_entries()
                    .lock()
                    .map_err(|_| anyhow::anyhow!("in-memory token storage mutex poisoned"))?;
                let entry = guard.entry(self.server_name.clone()).or_default();
                entry.token = Some(payload);
                Ok(())
            }
        }
    }

    pub fn clear_tokens(&self) -> Result<()> {
        match self.backend {
            TokenStoreBackend::File => {
                let path = self.token_file();
                if path.exists() {
                    fs::remove_file(&path)
                        .with_context(|| format!("failed to remove {}", path.display()))?;
                }
                Ok(())
            }
            TokenStoreBackend::Memory => {
                let mut guard = memory_entries()
                    .lock()
                    .map_err(|_| anyhow::anyhow!("in-memory token storage mutex poisoned"))?;
                if let Some(entry) = guard.get_mut(&self.server_name) {
                    entry.token = None;
                }
                Ok(())
            }
        }
    }

    pub fn load_status(
        &self,
        oauth_config: &OAuthConfig,
        required_scopes: &[String],
    ) -> Result<Option<TokenStatus>> {
        let token_file = self.token_file();
        let Some(mut token) = self.load_token_file()? else {
            return Ok(None);
        };
        let Some(client_info) = self.load_client_info()? else {
            return Ok(None);
        };

        let expires_in = adjusted_expires_in(&token_file, &mut token);
        let is_expired = expires_in.map(|value| value < 60).unwrap_or(false);
        let is_public_client = client_info.token_endpoint_auth_method.as_deref() == Some("none");
        let has_refresh_token = token.refresh_token.as_deref().is_some();
        let has_client_creds = !client_info.client_id.is_empty()
            && (is_public_client || client_info.client_secret.as_deref().is_some());
        let audience_mismatch = has_url_like_audience_mismatch(&token.access_token, oauth_config);
        let scope_mismatch = has_required_scope_mismatch(&token, required_scopes);

        Ok(Some(TokenStatus {
            token,
            client_info,
            expires_in,
            is_expired,
            audience_mismatch,
            scope_mismatch,
            can_refresh: has_refresh_token && has_client_creds,
        }))
    }

    pub fn has_usable_tokens(
        &self,
        oauth_config: &OAuthConfig,
        required_scopes: &[String],
    ) -> Result<bool> {
        let Some(status) = self.load_status(oauth_config, required_scopes)? else {
            return Ok(false);
        };
        if status.scope_mismatch {
            return Ok(false);
        }
        if status.audience_mismatch {
            return Ok(status.can_refresh);
        }
        if !status.is_expired {
            return Ok(true);
        }
        Ok(status.can_refresh)
    }

    fn ensure_file_storage_dir(&self) -> Result<()> {
        if matches!(self.backend, TokenStoreBackend::File) {
            fs::create_dir_all(&self.storage_dir)
                .with_context(|| format!("failed to create {}", self.storage_dir.display()))?;
            set_strict_dir_permissions(&self.storage_dir);
        }
        Ok(())
    }
}

fn memory_entries() -> &'static Mutex<HashMap<String, InMemoryTokenEntry>> {
    static MEMORY_ENTRIES: OnceLock<Mutex<HashMap<String, InMemoryTokenEntry>>> = OnceLock::new();
    MEMORY_ENTRIES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn memory_entry(server_name: &str) -> Result<InMemoryTokenEntry> {
    let guard = memory_entries()
        .lock()
        .map_err(|_| anyhow::anyhow!("in-memory token storage mutex poisoned"))?;
    Ok(guard.get(server_name).cloned().unwrap_or_default())
}

#[derive(Debug, Clone, Default)]
pub struct CompatStateStore {
    states: std::sync::Arc<RwLock<HashMap<String, StoredAuthorizationState>>>,
}

impl CompatStateStore {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl StateStore for CompatStateStore {
    async fn save(
        &self,
        csrf_token: &str,
        state: StoredAuthorizationState,
    ) -> std::result::Result<(), rmcp::transport::auth::AuthError> {
        self.states
            .write()
            .await
            .insert(csrf_token.to_string(), state);
        Ok(())
    }

    async fn load(
        &self,
        csrf_token: &str,
    ) -> std::result::Result<Option<StoredAuthorizationState>, rmcp::transport::auth::AuthError>
    {
        Ok(self.states.read().await.get(csrf_token).cloned())
    }

    async fn delete(
        &self,
        csrf_token: &str,
    ) -> std::result::Result<(), rmcp::transport::auth::AuthError> {
        self.states.write().await.remove(csrf_token);
        Ok(())
    }
}

pub fn parse_token_response(value: Value) -> Result<CompatTokenFile> {
    let value = normalize_token_endpoint_response(value)?;
    let token: CompatTokenFile =
        serde_json::from_value(value).context("token endpoint response is not a valid token")?;
    if token.access_token.is_empty() {
        bail!("token endpoint response missing access_token");
    }
    Ok(token)
}

pub fn export_legacy_oauth_record_value(
    server_id: &str,
    storage_dir: impl Into<PathBuf>,
) -> Result<Value> {
    let store = CompatTokenStore::with_storage_dir(server_id, storage_dir)?;
    let token = store
        .load_token_file()?
        .ok_or_else(|| anyhow::anyhow!("legacy OAuth token file is unavailable"))?;
    let client_info = store
        .load_client_info()?
        .ok_or_else(|| anyhow::anyhow!("legacy OAuth client file is unavailable"))?;
    Ok(json!({
        "server_id": server_id,
        "token": token,
        "client_info": client_info,
    }))
}

pub(crate) fn split_scope_string(raw: &str) -> Vec<String> {
    raw.split_whitespace()
        .map(str::trim)
        .filter(|scope| !scope.is_empty())
        .map(str::to_string)
        .collect()
}

fn adjusted_expires_in(path: &Path, token: &mut CompatTokenFile) -> Option<i64> {
    if let Some(jwt_exp) = decode_jwt_exp(&token.access_token) {
        let remaining = jwt_exp - now_epoch_seconds() as i64;
        token.expires_in = Some(remaining);
        return Some(remaining);
    }

    if let Some(expires_at) = token_expires_at_epoch(token) {
        let remaining = expires_at - now_epoch_seconds() as i64;
        token.expires_in = Some(remaining);
        return Some(remaining);
    }

    let Some(expires_in) = token.expires_in else {
        return None;
    };
    if is_probable_jwt(&token.access_token) {
        return Some(expires_in);
    }

    let saved_at = path
        .metadata()
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_else(|| now_epoch_seconds() as i64);
    let elapsed = (now_epoch_seconds() as i64 - saved_at).max(0);
    let remaining = expires_in - elapsed;
    token.expires_in = Some(remaining);
    Some(remaining)
}

fn token_expires_at_epoch(token: &CompatTokenFile) -> Option<i64> {
    ["expires_at", "expiry", "expiresAt"]
        .iter()
        .find_map(|key| token.extra.get(*key))
        .and_then(value_to_epoch_seconds)
}

fn value_to_epoch_seconds(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => {
            let raw = number
                .as_i64()
                .or_else(|| number.as_u64().and_then(|v| i64::try_from(v).ok()))?;
            if raw > 10_000_000_000 {
                Some(raw / 1000)
            } else {
                Some(raw)
            }
        }
        Value::String(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return None;
            }
            if let Ok(value) = trimmed.parse::<i64>() {
                return if value > 10_000_000_000 {
                    Some(value / 1000)
                } else {
                    Some(value)
                };
            }
            chrono::DateTime::parse_from_rfc3339(trimmed)
                .ok()
                .map(|value| value.timestamp())
        }
        _ => None,
    }
}

pub(crate) fn has_url_like_audience_mismatch(
    access_token: &str,
    oauth_config: &OAuthConfig,
) -> bool {
    let Some(expected_resource) = oauth_config.resource.as_ref() else {
        return false;
    };
    let expected_norm = normalize_url_like(expected_resource);
    if expected_norm.is_none() {
        return false;
    }

    let Some(aud_values) = decode_jwt_audiences(access_token) else {
        return false;
    };
    let aud_url_values = aud_values
        .iter()
        .map(|aud| normalize_url_like(aud))
        .collect::<Option<Vec<_>>>();
    let Some(aud_url_values) = aud_url_values else {
        // RFC 8707 permits an authorization server to map a resource URI to an
        // abstract audience identifier. The client cannot prove that mapping
        // is wrong from JWT contents, so leave validation to the MCP resource.
        return false;
    };
    if aud_url_values.is_empty() {
        return false;
    }

    let expected_norm = expected_norm.unwrap();
    !aud_url_values
        .iter()
        .any(|audience| resource_audience_matches(audience, &expected_norm))
}

pub(crate) fn token_scopes(token: &CompatTokenFile) -> Option<Vec<String>> {
    if let Some(scope) = token.scope.as_deref() {
        let parsed = split_scope_string(scope);
        if !parsed.is_empty() {
            return Some(parsed);
        }
    }
    decode_jwt_scopes(&token.access_token)
}

fn has_required_scope_mismatch(token: &CompatTokenFile, required_scopes: &[String]) -> bool {
    if required_scopes.is_empty() {
        return false;
    }

    let Some(granted_scopes) = token_scopes(token) else {
        return false;
    };
    let granted = granted_scopes.into_iter().collect::<BTreeSet<_>>();
    required_scopes
        .iter()
        .any(|scope| !granted.contains(scope.as_str()))
}

fn safe_server_hash(server_name: &str) -> String {
    let digest = md5::compute(server_name.as_bytes());
    format!("{:x}", digest)[..8].to_string()
}

fn decode_jwt_exp(access_token: &str) -> Option<i64> {
    let payload = decode_jwt_payload(access_token)?;
    payload.get("exp").and_then(Value::as_i64)
}

fn decode_jwt_scopes(access_token: &str) -> Option<Vec<String>> {
    let payload = decode_jwt_payload(access_token)?;
    let extracted =
        ["scope", "scp", "scopes"]
            .iter()
            .find_map(|field| match payload.get(*field) {
                Some(Value::String(value)) => Some(split_scope_string(value)),
                Some(Value::Array(values)) => Some(
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .flat_map(split_scope_string)
                        .collect::<Vec<_>>(),
                ),
                _ => None,
            })?;
    if extracted.is_empty() {
        None
    } else {
        Some(extracted)
    }
}

pub(crate) fn decode_jwt_audiences(access_token: &str) -> Option<Vec<String>> {
    let payload = decode_jwt_payload(access_token)?;
    match payload.get("aud") {
        Some(Value::String(value)) => Some(vec![value.clone()]),
        Some(Value::Array(values)) => Some(
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect(),
        ),
        _ => None,
    }
}

fn decode_jwt_payload(access_token: &str) -> Option<Value> {
    let parts = access_token.split('.').collect::<Vec<_>>();
    if parts.len() != 3 {
        return None;
    }
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(parts[1])
        .ok()
        .or_else(|| {
            base64::engine::general_purpose::URL_SAFE
                .decode(parts[1])
                .ok()
        })?;
    serde_json::from_slice(&payload).ok()
}

fn is_probable_jwt(access_token: &str) -> bool {
    access_token.split('.').count() == 3
}

pub(crate) fn normalize_url_like(value: &str) -> Option<String> {
    let parsed = Url::parse(value).ok()?;
    Some(format!(
        "{}://{}{}",
        parsed.scheme().to_ascii_lowercase(),
        parsed.host_str()?.to_ascii_lowercase()
            + &parsed
                .port()
                .map(|port| format!(":{port}"))
                .unwrap_or_default(),
        parsed.path().trim_end_matches('/')
    ))
}

fn same_origin(left: &str, right: &str) -> bool {
    let Ok(left_url) = Url::parse(left) else {
        return false;
    };
    let Ok(right_url) = Url::parse(right) else {
        return false;
    };
    left_url.scheme() == right_url.scheme()
        && left_url.host_str() == right_url.host_str()
        && left_url.port_or_known_default() == right_url.port_or_known_default()
}

fn is_path_specific_url(value: &str) -> bool {
    Url::parse(value)
        .ok()
        .map(|url| !url.path().is_empty() && url.path() != "/")
        .unwrap_or(false)
}

fn resource_audience_matches(audience: &str, expected_resource: &str) -> bool {
    if audience == expected_resource {
        return true;
    }
    if !same_origin(audience, expected_resource) {
        return false;
    }
    if !is_path_specific_url(expected_resource) {
        return true;
    }

    let (Ok(audience), Ok(expected_resource)) =
        (Url::parse(audience), Url::parse(expected_resource))
    else {
        return false;
    };
    let audience_path = audience.path().trim_end_matches('/');
    let expected_path = expected_resource.path().trim_end_matches('/');
    audience_path.is_empty()
        || audience_path == "/"
        || expected_path
            .strip_prefix(audience_path)
            .is_some_and(|suffix| suffix.is_empty() || suffix.starts_with('/'))
}

fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::{
        export_legacy_oauth_record_value, parse_token_response, resource_audience_matches,
        CompatClientInfo, CompatStateStore, CompatTokenFile, CompatTokenStore,
    };
    use crate::oauth::config::OAuthConfig;
    use base64::Engine;
    use filetime::{set_file_mtime, FileTime};
    use oauth2::{CsrfToken, PkceCodeVerifier};
    use rmcp::transport::auth::{StateStore, StoredAuthorizationState};
    use serde_json::{json, Value};
    use serial_test::serial;
    use std::fs;
    use std::time::{Duration, SystemTime};

    fn temp_store(name: &str) -> CompatTokenStore {
        let root = std::env::temp_dir().join(format!(
            "mcp-orc-oauth-test-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        CompatTokenStore::with_storage_dir(name, root).unwrap()
    }

    fn jwt(payload: Value) -> String {
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&payload).unwrap());
        format!("eyJhbGciOiJub25lIn0.{encoded}.")
    }

    #[test]
    fn preserves_refresh_token_on_save() {
        let store = temp_store("glean");
        store
            .save_token_file(&CompatTokenFile {
                access_token: "old".to_string(),
                token_type: Some("Bearer".to_string()),
                expires_in: Some(120),
                refresh_token: Some("refresh".to_string()),
                scope: None,
                extra: Default::default(),
            })
            .unwrap();
        store
            .save_token_file(&CompatTokenFile {
                access_token: "new".to_string(),
                token_type: Some("Bearer".to_string()),
                expires_in: Some(120),
                refresh_token: None,
                scope: None,
                extra: Default::default(),
            })
            .unwrap();
        let saved = store.load_token_file().unwrap().unwrap();
        assert_eq!(saved.refresh_token.as_deref(), Some("refresh"));
    }

    #[test]
    fn parses_token_endpoint_response() {
        let token = parse_token_response(json!({
            "access_token": "abc",
            "token_type": "Bearer",
            "expires_in": 3600
        }))
        .unwrap();
        assert_eq!(token.access_token, "abc");
    }

    #[test]
    fn usable_tokens_skip_non_url_audience_mismatch() {
        let store = temp_store("glean");
        store
            .save_client_info(&CompatClientInfo {
                client_id: "client".to_string(),
                token_endpoint_auth_method: Some("none".to_string()),
                ..Default::default()
            })
            .unwrap();
        store
            .save_token_file(&CompatTokenFile {
                access_token:
                    "eyJhbGciOiJub25lIn0.eyJhdWQiOiJnbGVhbi1hcGkiLCJleHAiOjk5OTk5OTk5OTl9."
                        .to_string(),
                token_type: Some("Bearer".to_string()),
                expires_in: Some(604800),
                refresh_token: Some("refresh".to_string()),
                scope: None,
                extra: Default::default(),
            })
            .unwrap();
        let config = OAuthConfig::from_value(&json!({
            "resource": "https://portico-be.glean.com/mcp/default"
        }))
        .unwrap();
        assert!(store.has_usable_tokens(&config, &[]).unwrap());
    }

    #[test]
    fn rejects_missing_access_token_in_token_response() {
        let error = parse_token_response(json!({
            "access_token": "",
            "token_type": "Bearer"
        }))
        .unwrap_err();
        assert!(error.to_string().contains("missing access_token"));
    }

    #[test]
    #[serial]
    fn uses_home_directory_default_storage_path() {
        let home = std::env::temp_dir().join(format!("mcp-orc-home-{}", std::process::id()));
        fs::create_dir_all(&home).unwrap();
        std::env::remove_var("MCPO_TOKEN_STORAGE_DIR");
        std::env::set_var("HOME", &home);
        let store = CompatTokenStore::new("demo").unwrap();
        assert!(store
            .token_file()
            .starts_with(home.join(".mcpo").join("tokens")));
        assert!(store
            .client_file()
            .starts_with(home.join(".mcpo").join("tokens")));
    }

    #[test]
    fn clears_saved_tokens() {
        let store = temp_store("clear");
        store
            .save_token_file(&CompatTokenFile {
                access_token: "abc".to_string(),
                token_type: Some("Bearer".to_string()),
                expires_in: Some(10),
                refresh_token: None,
                scope: None,
                extra: Default::default(),
            })
            .unwrap();
        assert!(store.token_file().exists());
        store.clear_tokens().unwrap();
        assert!(!store.token_file().exists());
    }

    #[test]
    fn exports_plaintext_legacy_oauth_record() {
        let store = temp_store("legacy-export");
        store
            .save_client_info(&CompatClientInfo {
                client_id: "client-id".to_string(),
                client_secret: Some("client-secret".to_string()),
                token_endpoint_auth_method: Some("client_secret_post".to_string()),
                ..Default::default()
            })
            .unwrap();
        store
            .save_token_file(&CompatTokenFile {
                access_token: "access-token".to_string(),
                token_type: Some("Bearer".to_string()),
                expires_in: Some(3600),
                refresh_token: Some("refresh-token".to_string()),
                scope: Some("offline_access search".to_string()),
                extra: Default::default(),
            })
            .unwrap();

        let exported =
            export_legacy_oauth_record_value("legacy-export", store.storage_dir.clone()).unwrap();
        assert_eq!(exported["server_id"], "legacy-export");
        assert_eq!(exported["token"]["access_token"], "access-token");
        assert_eq!(exported["token"]["refresh_token"], "refresh-token");
        assert_eq!(exported["client_info"]["client_secret"], "client-secret");
    }

    #[test]
    fn encrypted_legacy_oauth_payloads_are_unsupported() {
        let store = temp_store("legacy-unsupported");
        fs::write(
            store.token_file(),
            json!({
                "_enc_v": 1,
                "_enc_alg": "retired",
                "nonce": "n",
                "ciphertext": "c",
                "tag": "t"
            })
            .to_string(),
        )
        .unwrap();
        let error = store.load_token_file().unwrap_err();
        assert!(error
            .to_string()
            .contains("legacy encrypted OAuth token file"));
    }

    #[test]
    fn load_status_handles_missing_files_and_refreshability() {
        let config = OAuthConfig::from_value(&json!({})).unwrap();
        let missing_store = temp_store("missing-status");
        assert!(missing_store.load_status(&config, &[]).unwrap().is_none());

        let missing_client = temp_store("missing-client");
        missing_client
            .save_token_file(&CompatTokenFile {
                access_token: "abc".to_string(),
                token_type: Some("Bearer".to_string()),
                expires_in: Some(1),
                refresh_token: Some("refresh".to_string()),
                scope: None,
                extra: Default::default(),
            })
            .unwrap();
        assert!(missing_client.load_status(&config, &[]).unwrap().is_none());

        let refreshable = temp_store("refreshable");
        refreshable
            .save_client_info(&CompatClientInfo {
                client_id: "client".to_string(),
                client_secret: Some("secret".to_string()),
                token_endpoint_auth_method: Some("client_secret_post".to_string()),
                ..Default::default()
            })
            .unwrap();
        refreshable
            .save_token_file(&CompatTokenFile {
                access_token: "opaque-token".to_string(),
                token_type: Some("Bearer".to_string()),
                expires_in: Some(1),
                refresh_token: Some("refresh".to_string()),
                scope: None,
                extra: Default::default(),
            })
            .unwrap();
        let old_time = FileTime::from_system_time(SystemTime::now() - Duration::from_secs(120));
        set_file_mtime(refreshable.token_file(), old_time).unwrap();
        let status = refreshable.load_status(&config, &[]).unwrap().unwrap();
        assert!(status.is_expired);
        assert!(status.can_refresh);
        assert!(refreshable.has_usable_tokens(&config, &[]).unwrap());
    }

    #[test]
    fn accepts_parent_resource_audience_and_rejects_sibling_path() {
        assert!(resource_audience_matches(
            "https://example.test",
            "https://example.test/api/tenant"
        ));
        assert!(resource_audience_matches(
            "https://example.test/api",
            "https://example.test/api/tenant"
        ));
        assert!(!resource_audience_matches(
            "https://example.test/api/other",
            "https://example.test/api/tenant"
        ));
        assert!(!resource_audience_matches(
            "https://other.example.test",
            "https://example.test/api/tenant"
        ));

        let store = temp_store("path-mismatch");
        store
            .save_client_info(&CompatClientInfo {
                client_id: "client".to_string(),
                token_endpoint_auth_method: Some("none".to_string()),
                ..Default::default()
            })
            .unwrap();
        store
            .save_token_file(&CompatTokenFile {
                access_token:
                    "eyJhbGciOiJub25lIn0.eyJhdWQiOiJodHRwczovL2V4YW1wbGUudGVzdC9hcGkiLCJleHAiOjk5OTk5OTk5OTl9."
                        .to_string(),
                token_type: Some("Bearer".to_string()),
                expires_in: Some(604800),
                refresh_token: Some("refresh".to_string()),
                scope: None,
                extra: Default::default(),
            })
            .unwrap();
        let parent_config = OAuthConfig::from_value(&json!({
            "resource": "https://example.test/api/v1"
        }))
        .unwrap();
        let status = store.load_status(&parent_config, &[]).unwrap().unwrap();
        assert!(!status.audience_mismatch);

        let sibling_config = OAuthConfig::from_value(&json!({
            "resource": "https://example.test/mcp/default"
        }))
        .unwrap();
        let status = store.load_status(&sibling_config, &[]).unwrap().unwrap();
        assert!(status.audience_mismatch);
        assert!(store.has_usable_tokens(&sibling_config, &[]).unwrap());
    }

    #[test]
    fn does_not_assume_abstract_audience_mapping_is_a_mismatch() {
        let store = temp_store("abstract-audience-mapping");
        store
            .save_client_info(&CompatClientInfo {
                client_id: "client".to_string(),
                token_endpoint_auth_method: Some("none".to_string()),
                ..Default::default()
            })
            .unwrap();
        store
            .save_token_file(&CompatTokenFile {
                access_token: jwt(json!({
                    "aud": [
                        "https://auth.example.test/tenants/example/resources",
                        "public_api"
                    ],
                    "exp": 9_999_999_999_i64
                })),
                token_type: Some("Bearer".to_string()),
                expires_in: Some(604800),
                refresh_token: Some("refresh".to_string()),
                scope: None,
                extra: Default::default(),
            })
            .unwrap();
        let config = OAuthConfig::from_value(&json!({
            "resource": "https://mcp.example.test/v1/tenants/example"
        }))
        .unwrap();

        let status = store.load_status(&config, &[]).unwrap().unwrap();
        assert!(!status.audience_mismatch);
        assert!(store.has_usable_tokens(&config, &[]).unwrap());
    }

    #[tokio::test]
    async fn state_store_round_trips_and_deletes_values() {
        let store = CompatStateStore::new();
        let verifier = PkceCodeVerifier::new("verifier".to_string());
        let csrf = CsrfToken::new("csrf".to_string());
        let state = StoredAuthorizationState::new(&verifier, &csrf);
        StateStore::save(&store, "csrf", state.clone())
            .await
            .unwrap();
        assert!(StateStore::load(&store, "csrf").await.unwrap().is_some());
        StateStore::delete(&store, "csrf").await.unwrap();
        assert!(StateStore::load(&store, "csrf").await.unwrap().is_none());
    }
}

#[cfg(test)]
#[path = "storage_extra_tests.rs"]
mod extra_tests;

#[cfg(test)]
#[path = "storage_parity_tests.rs"]
mod parity_tests;
