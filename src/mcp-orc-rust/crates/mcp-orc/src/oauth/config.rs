use std::collections::BTreeMap;
use std::env;
use std::path::PathBuf;

use anyhow::{anyhow, bail, Context, Result};
use log::{debug, info};
use serde::Deserialize;
use serde_json::{Map, Value};
use tokio::fs;
use url::Url;

const DEFAULT_CLIENT_NAME: &str = "Portico";
pub(crate) const DEFAULT_CALLBACK_PORT: u16 = 3834;
pub(crate) const COMPAT_CALLBACK_PORT: u16 = 3836;
const GOOGLE_AUTHORIZATION_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";

pub(crate) fn is_supported_callback_port(port: u16) -> bool {
    matches!(port, DEFAULT_CALLBACK_PORT | COMPAT_CALLBACK_PORT)
}

/// Read an OAuth credential from an environment variable, transparently
/// falling back to a `<NAME>_FILE` path (matching the PORTICO-68 Docker-secret
/// ingress contract used by runtime secret files). Returns the trimmed first
/// line of the file when the direct env var is unset/empty. The raw value is never
/// logged; callers redact on their own.
fn read_env_with_file_fallback(var_name: &str) -> Result<String> {
    if let Ok(value) = env::var(var_name) {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }

    let file_var = format!("{var_name}_FILE");
    if let Ok(path_value) = env::var(&file_var) {
        let trimmed_path = path_value.trim();
        if !trimmed_path.is_empty() {
            let raw = std::fs::read_to_string(trimmed_path).with_context(|| {
                format!("failed to read '{var_name}' credential file '{trimmed_path}'")
            })?;
            let first_line = raw.lines().next().map(str::trim).unwrap_or("").to_string();
            if !first_line.is_empty() {
                return Ok(first_line);
            }
        }
    }

    bail!(
        "missing environment variable '{var_name}' (neither '{var_name}' nor '{var_name}_FILE' produced a non-empty value)"
    )
}

fn parse_localhost_callback_port(uri: &str) -> Option<u16> {
    let port = uri
        .strip_prefix("http://localhost:")?
        .strip_suffix("/callback")?;
    port.parse::<u16>().ok()
}

pub(crate) fn sanitize_localhost_redirect_uris(redirect_uris: &[String]) -> Vec<String> {
    let mut sanitized = Vec::new();
    for uri in redirect_uris {
        let uri = uri.trim();
        if uri.is_empty() {
            continue;
        }
        if let Some(port) = parse_localhost_callback_port(uri) {
            if !is_supported_callback_port(port) {
                continue;
            }
        }
        if !sanitized.iter().any(|existing| existing == uri) {
            sanitized.push(uri.to_string());
        }
    }
    sanitized
}

fn canonical_redirect_uris(active_port: u16) -> Vec<String> {
    let mut uris = Vec::new();
    for port in [active_port, DEFAULT_CALLBACK_PORT, COMPAT_CALLBACK_PORT] {
        if !is_supported_callback_port(port) {
            continue;
        }
        let uri = format!("http://localhost:{port}/callback");
        if !uris.contains(&uri) {
            uris.push(uri);
        }
    }
    uris
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct OAuthClientMetadataConfig {
    pub client_name: Option<String>,
    #[serde(default)]
    pub redirect_uris: Vec<String>,
    #[serde(default)]
    pub grant_types: Vec<String>,
    #[serde(default)]
    pub response_types: Vec<String>,
    pub scope: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CredentialSourceConfig {
    #[serde(rename = "type")]
    pub kind: String,
    pub module_path: Option<PathBuf>,
    pub function_name: Option<String>,
    pub path: Option<PathBuf>,
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub client_id_var: Option<String>,
    pub client_secret_var: Option<String>,
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadedCredentials {
    pub client_id: String,
    pub client_secret: Option<String>,
    pub scopes: Vec<String>,
}

impl CredentialSourceConfig {
    pub async fn load(&self) -> Result<LoadedCredentials> {
        debug!("loading OAuth credentials from source type '{}'", self.kind);
        match self.kind.as_str() {
            "inline" => self.load_inline(),
            "env" => self.load_env(),
            "file" => self.load_file(),
            "bundled" => self.load_bundled().await,
            other => bail!("unsupported OAuth credentials_source type '{other}'"),
        }
    }

    fn load_inline(&self) -> Result<LoadedCredentials> {
        let client_id = self
            .client_id
            .clone()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow!("inline credentials_source requires client_id"))?;
        info!("loaded inline OAuth credentials");
        Ok(LoadedCredentials {
            client_id,
            client_secret: self.client_secret.clone().filter(|value| !value.is_empty()),
            scopes: self.scopes.clone(),
        })
    }

    fn load_env(&self) -> Result<LoadedCredentials> {
        let client_id_var = self
            .client_id_var
            .clone()
            .unwrap_or_else(|| "OAUTH_CLIENT_ID".to_string());
        let client_secret_var = self
            .client_secret_var
            .clone()
            .unwrap_or_else(|| "OAUTH_CLIENT_SECRET".to_string());
        let client_id = read_env_with_file_fallback(&client_id_var)?;
        let client_secret = read_env_with_file_fallback(&client_secret_var)?;
        info!(
            "loaded OAuth credentials from environment '{}'/'{}' (with optional '_FILE' fallback)",
            client_id_var, client_secret_var
        );
        Ok(LoadedCredentials {
            client_id,
            client_secret: Some(client_secret),
            scopes: self.scopes.clone(),
        })
    }

    fn load_file(&self) -> Result<LoadedCredentials> {
        #[derive(Deserialize)]
        struct FileCredentials {
            client_id: String,
            client_secret: Option<String>,
            #[serde(default)]
            scopes: Vec<String>,
        }

        let path = self
            .path
            .as_ref()
            .ok_or_else(|| anyhow!("file credentials_source requires path"))?;
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("failed to read credentials file {}", path.display()))?;
        let parsed: FileCredentials = serde_json::from_str(&raw)
            .with_context(|| format!("invalid JSON in {}", path.display()))?;
        info!("loaded OAuth credentials from file '{}'", path.display());
        Ok(LoadedCredentials {
            client_id: parsed.client_id,
            client_secret: parsed.client_secret,
            scopes: if self.scopes.is_empty() {
                parsed.scopes
            } else {
                self.scopes.clone()
            },
        })
    }

    async fn load_bundled(&self) -> Result<LoadedCredentials> {
        let module_path = self
            .module_path
            .as_ref()
            .ok_or_else(|| anyhow!("bundled credentials_source requires module_path"))?;
        let function_name = self
            .function_name
            .clone()
            .unwrap_or_else(|| "get_bundled_credentials".to_string());
        info!(
            "loading bundled OAuth credentials from '{}' using native parser function '{}'",
            module_path.display(),
            function_name
        );
        let source = fs::read_to_string(module_path).await.with_context(|| {
            format!(
                "failed to read bundled credentials module {}",
                module_path.display()
            )
        })?;
        load_bundled_python_source(&source, &function_name, self.scopes.clone()).map_err(|error| {
            anyhow!(
                "failed to load bundled credentials from {}: {error:#}",
                module_path.display()
            )
        })
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct OAuthConfig {
    pub server_url: Option<String>,
    pub authorization_server: Option<String>,
    pub authorization_endpoint: Option<String>,
    pub token_endpoint: Option<String>,
    pub registration_endpoint: Option<String>,
    pub resource: Option<String>,
    #[serde(rename = "type")]
    pub oauth_type: Option<String>,
    pub scope: Option<String>,
    #[serde(default)]
    pub scopes: Vec<String>,
    pub storage_type: Option<String>,
    pub callback_port: Option<u16>,
    pub scope_parameter_name: Option<String>,
    #[serde(default)]
    pub client_metadata: OAuthClientMetadataConfig,
    pub credentials_source: Option<CredentialSourceConfig>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl OAuthConfig {
    pub fn from_value(value: &Value) -> Result<Self> {
        let config: Self = serde_json::from_value(normalize_oauth_config_value(value))
            .context("invalid oauth config")?;
        Ok(config)
    }

    pub fn callback_port(&self) -> u16 {
        let port = self
            .callback_port
            .or_else(|| {
                env::var("MCPO_OAUTH_CALLBACK_PORT")
                    .ok()
                    .and_then(|raw| raw.parse::<u16>().ok())
            })
            .or_else(|| {
                env::var("OAUTH_CALLBACK_PORT")
                    .ok()
                    .and_then(|raw| raw.parse::<u16>().ok())
            })
            .unwrap_or(DEFAULT_CALLBACK_PORT);
        if is_supported_callback_port(port) {
            port
        } else {
            DEFAULT_CALLBACK_PORT
        }
    }

    pub fn scope_parameter_name(&self) -> Option<&str> {
        self.scope_parameter_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
    }

    pub fn active_redirect_uri(&self) -> String {
        if !self.client_metadata.redirect_uris.is_empty() {
            let sanitized = sanitize_localhost_redirect_uris(&self.client_metadata.redirect_uris);
            if let Some(first) = sanitized.first() {
                return first.clone();
            }
        }
        format!("http://localhost:{}/callback", self.callback_port())
    }

    pub fn redirect_uris(&self) -> Vec<String> {
        if !self.client_metadata.redirect_uris.is_empty() {
            let sanitized = sanitize_localhost_redirect_uris(&self.client_metadata.redirect_uris);
            if !sanitized.is_empty() {
                return sanitized;
            }
        }

        let mut uris = canonical_redirect_uris(self.callback_port());

        let compat_ports =
            env::var("MCPO_OAUTH_COMPAT_CALLBACK_PORTS").unwrap_or_else(|_| "3836".to_string());
        for raw in compat_ports.split(',') {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(port) = trimmed.parse::<u16>() else {
                continue;
            };
            if !is_supported_callback_port(port) {
                continue;
            }
            let uri = format!("http://localhost:{port}/callback");
            if !uris.contains(&uri) {
                uris.push(uri);
            }
        }

        uris
    }

    pub fn client_name(&self) -> String {
        self.client_metadata
            .client_name
            .clone()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| DEFAULT_CLIENT_NAME.to_string())
    }

    pub fn configured_scopes(&self) -> Vec<String> {
        if let Some(scope) = self
            .client_metadata
            .scope
            .as_ref()
            .filter(|value| !value.is_empty())
        {
            return split_scope_string(scope);
        }
        if !self.scopes.is_empty() {
            return self.scopes.clone();
        }
        if let Some(scope) = self.scope.as_ref().filter(|value| !value.is_empty()) {
            return split_scope_string(scope);
        }
        Vec::new()
    }

    pub(crate) fn persisted_discovered_challenge_scopes(&self) -> Vec<String> {
        if !self
            .extra
            .get("discovered")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return Vec::new();
        }
        self.configured_scopes()
    }

    pub fn oauth_type(&self) -> Option<&str> {
        self.oauth_type
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
    }

    pub fn is_non_dcr(&self) -> bool {
        self.oauth_type()
            .is_some_and(|value| value.eq_ignore_ascii_case("non-dcr"))
    }

    pub fn grant_types(&self) -> Vec<String> {
        if self.client_metadata.grant_types.is_empty() {
            vec![
                "authorization_code".to_string(),
                "refresh_token".to_string(),
            ]
        } else {
            self.client_metadata.grant_types.clone()
        }
    }

    pub fn response_types(&self) -> Vec<String> {
        if self.client_metadata.response_types.is_empty() {
            vec!["code".to_string()]
        } else {
            self.client_metadata.response_types.clone()
        }
    }

    pub fn discovery_base(&self, mcp_url: &str) -> String {
        self.authorization_server
            .clone()
            .or_else(|| self.server_url.clone())
            .unwrap_or_else(|| mcp_url.to_string())
    }

    pub fn configured_resource(&self) -> Option<String> {
        self.resource
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    }

    pub fn infer_resource_from_url(&self) -> bool {
        self.extra
            .get("infer_resource_from_url")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    pub fn resource_url(&self, mcp_url: &str) -> String {
        self.configured_resource()
            .unwrap_or_else(|| mcp_url.to_string())
    }

    pub fn fallback_authorization_endpoints(&self) -> Option<(&'static str, &'static str)> {
        let discovery_base = self
            .authorization_server
            .as_deref()
            .or(self.server_url.as_deref())?;
        let Ok(parsed) = Url::parse(discovery_base) else {
            return None;
        };
        let host = parsed.host_str()?.trim().to_ascii_lowercase();
        if host == "accounts.google.com" {
            Some((GOOGLE_AUTHORIZATION_ENDPOINT, GOOGLE_TOKEN_ENDPOINT))
        } else {
            None
        }
    }
}

fn normalize_oauth_config_value(value: &Value) -> Value {
    let Value::Object(config) = value else {
        return value.clone();
    };
    if config.get("credentials_source").is_some() {
        return value.clone();
    }
    let Some(client_id) = config
        .get("client_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|client_id| !client_id.is_empty())
    else {
        return value.clone();
    };

    let mut normalized = config.clone();
    let mut credentials_source = Map::new();
    credentials_source.insert("type".to_string(), Value::String("inline".to_string()));
    credentials_source.insert(
        "client_id".to_string(),
        Value::String(client_id.to_string()),
    );
    if let Some(client_secret) = config
        .get("client_secret")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|client_secret| !client_secret.is_empty())
    {
        credentials_source.insert(
            "client_secret".to_string(),
            Value::String(client_secret.to_string()),
        );
    }
    normalized.insert(
        "credentials_source".to_string(),
        Value::Object(credentials_source),
    );
    if normalized
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|oauth_type| !oauth_type.is_empty())
        .is_none()
    {
        normalized.insert("type".to_string(), Value::String("non-dcr".to_string()));
    }
    Value::Object(normalized)
}

fn split_scope_string(raw: &str) -> Vec<String> {
    raw.split_whitespace()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

fn load_bundled_python_source(
    source: &str,
    function_name: &str,
    scopes: Vec<String>,
) -> Result<LoadedCredentials> {
    let assignments = parse_python_string_assignments(source)?;
    let return_expr = extract_bundled_return_expression(source, function_name)?;
    let parsed = PythonExprParser::new(&return_expr)
        .parse_expression()
        .context("failed to parse bundled credential return expression")?;
    let resolved = parsed.resolve(&assignments)?;

    let (client_id, client_secret) = match resolved {
        ResolvedBundledValue::Tuple(values) => {
            if values.len() < 2 {
                bail!("Unsupported bundled credential return type");
            }
            (
                required_non_empty(&values[0], "client_id")?,
                values
                    .get(1)
                    .and_then(|value| optional_non_empty(value.as_str())),
            )
        }
        ResolvedBundledValue::Dict(values) => {
            let client_id = values
                .get("client_id")
                .and_then(|value| optional_non_empty(value.as_str()))
                .ok_or_else(|| anyhow!("bundled credentials missing client_id"))?;
            let client_secret = values
                .get("client_secret")
                .and_then(|value| optional_non_empty(value.as_str()));
            (client_id, client_secret)
        }
        ResolvedBundledValue::String(_) => {
            bail!("Unsupported bundled credential return type");
        }
    };

    info!(
        "loaded bundled OAuth credentials via native parser (client_id prefix '{}')",
        redact_prefix(&client_id)
    );
    Ok(LoadedCredentials {
        client_id,
        client_secret,
        scopes,
    })
}

fn parse_python_string_assignments(source: &str) -> Result<BTreeMap<String, String>> {
    let lines = source.lines().collect::<Vec<_>>();
    let mut assignments = BTreeMap::new();
    let mut index = 0usize;

    while index < lines.len() {
        let line = lines[index];
        let trimmed = line.trim();
        if is_indented(line) || trimmed.is_empty() || trimmed.starts_with('#') {
            index += 1;
            continue;
        }
        if let Some((name, rhs)) = split_top_level_assignment(line) {
            let (expr, consumed) = collect_expression_lines(&lines, index, rhs);
            let value = PythonExprParser::new(&expr)
                .parse_expression()
                .with_context(|| format!("failed to parse bundled assignment for '{name}'"))?;
            let resolved = value.resolve(&assignments)?;
            if let ResolvedBundledValue::String(string_value) = resolved {
                assignments.insert(name.to_string(), string_value);
            }
            index = consumed;
            continue;
        }
        index += 1;
    }

    Ok(assignments)
}

fn split_top_level_assignment(line: &str) -> Option<(&str, &str)> {
    let (lhs, rhs) = line.split_once('=')?;
    let name = lhs.trim();
    if name.is_empty()
        || !name
            .chars()
            .all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
    {
        return None;
    }
    if name == "return" || name == "if" || name == "elif" || name == "else" {
        return None;
    }
    Some((name, rhs.trim_start()))
}

fn extract_bundled_return_expression(source: &str, function_name: &str) -> Result<String> {
    let lines = source.lines().collect::<Vec<_>>();
    let target = format!("def {function_name}(");
    let mut index = 0usize;

    while index < lines.len() {
        let line = lines[index];
        if !is_indented(line) && line.trim_start().starts_with(&target) {
            let mut body_index = index + 1;
            while body_index < lines.len() {
                let body_line = lines[body_index];
                let trimmed = body_line.trim();
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    body_index += 1;
                    continue;
                }
                if !is_indented(body_line) {
                    break;
                }
                if let Some(return_expr) = body_line.trim_start().strip_prefix("return ") {
                    let (expr, _) = collect_expression_lines(&lines, body_index, return_expr);
                    return Ok(expr);
                }
                body_index += 1;
            }
            bail!("bundled credentials function '{function_name}' does not return credentials");
        }
        index += 1;
    }

    bail!("function '{function_name}' not found in bundled credentials module")
}

fn collect_expression_lines(lines: &[&str], start_index: usize, initial: &str) -> (String, usize) {
    let mut expr = initial.trim().to_string();
    let mut index = start_index + 1;
    let mut balance = delimiter_balance(&expr);

    while balance > 0 && index < lines.len() {
        expr.push('\n');
        expr.push_str(lines[index].trim());
        balance = delimiter_balance(&expr);
        index += 1;
    }

    (expr, index)
}

fn delimiter_balance(input: &str) -> i32 {
    let mut balance = 0i32;
    let mut quote = None;
    let mut escaped = false;

    for ch in input.chars() {
        if let Some(active_quote) = quote {
            if escaped {
                escaped = false;
                continue;
            }
            if ch == '\\' {
                escaped = true;
            } else if ch == active_quote {
                quote = None;
            }
            continue;
        }

        match ch {
            '\'' | '"' => quote = Some(ch),
            '(' | '{' | '[' => balance += 1,
            ')' | '}' | ']' => balance -= 1,
            '#' => break,
            _ => {}
        }
    }

    balance
}

fn required_non_empty(value: &str, field_name: &str) -> Result<String> {
    optional_non_empty(value).ok_or_else(|| anyhow!("bundled credentials missing {field_name}"))
}

fn optional_non_empty(value: &str) -> Option<String> {
    Some(value)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn redact_prefix(value: &str) -> String {
    value.chars().take(10).collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PythonExpr {
    String(String),
    Identifier(String),
    Tuple(Vec<PythonExpr>),
    Dict(BTreeMap<String, PythonExpr>),
}

impl PythonExpr {
    fn resolve(&self, assignments: &BTreeMap<String, String>) -> Result<ResolvedBundledValue> {
        match self {
            Self::String(value) => Ok(ResolvedBundledValue::String(value.clone())),
            Self::Identifier(name) => assignments
                .get(name)
                .cloned()
                .map(ResolvedBundledValue::String)
                .ok_or_else(|| anyhow!("unsupported bundled credential identifier '{name}'")),
            Self::Tuple(values) => {
                let mut resolved = Vec::with_capacity(values.len());
                for value in values {
                    match value.resolve(assignments)? {
                        ResolvedBundledValue::String(string_value) => resolved.push(string_value),
                        _ => bail!("Unsupported bundled credential return type"),
                    }
                }
                Ok(ResolvedBundledValue::Tuple(resolved))
            }
            Self::Dict(values) => {
                let mut resolved = BTreeMap::new();
                for (key, value) in values {
                    match value.resolve(assignments)? {
                        ResolvedBundledValue::String(string_value) => {
                            resolved.insert(key.clone(), string_value);
                        }
                        _ => bail!("Unsupported bundled credential return type"),
                    }
                }
                Ok(ResolvedBundledValue::Dict(resolved))
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ResolvedBundledValue {
    String(String),
    Tuple(Vec<String>),
    Dict(BTreeMap<String, String>),
}

struct PythonExprParser<'a> {
    input: &'a str,
    position: usize,
}

impl<'a> PythonExprParser<'a> {
    fn new(input: &'a str) -> Self {
        Self { input, position: 0 }
    }

    fn parse_expression(mut self) -> Result<PythonExpr> {
        let expr = self.parse_tuple_like_expression()?;
        self.skip_ws_and_comments();
        if self.position != self.input.len() {
            bail!(
                "unexpected trailing bundled credential syntax near '{}'",
                &self.input[self.position..]
                    .chars()
                    .take(16)
                    .collect::<String>()
            );
        }
        Ok(expr)
    }

    fn parse_tuple_like_expression(&mut self) -> Result<PythonExpr> {
        let first = self.parse_primary()?;
        self.skip_ws_and_comments();
        if !self.consume_if(',') {
            return Ok(first);
        }

        let mut values = vec![first];
        loop {
            self.skip_ws_and_comments();
            if self.position >= self.input.len() || self.peek_char() == Some(')') {
                break;
            }
            values.push(self.parse_primary()?);
            self.skip_ws_and_comments();
            if !self.consume_if(',') {
                break;
            }
        }
        Ok(PythonExpr::Tuple(values))
    }

    fn parse_primary(&mut self) -> Result<PythonExpr> {
        self.skip_ws_and_comments();
        match self.peek_char() {
            Some('\'') | Some('"') => self.parse_string().map(PythonExpr::String),
            Some('{') => self.parse_dict(),
            Some('(') => self.parse_parenthesized(),
            Some(ch) if is_identifier_start(ch) => {
                self.parse_identifier().map(PythonExpr::Identifier)
            }
            _ => bail!("Unsupported bundled credential return type"),
        }
    }

    fn parse_parenthesized(&mut self) -> Result<PythonExpr> {
        self.expect('(')?;
        let value = self.parse_tuple_like_expression()?;
        self.skip_ws_and_comments();
        self.expect(')')?;
        Ok(value)
    }

    fn parse_dict(&mut self) -> Result<PythonExpr> {
        self.expect('{')?;
        let mut values = BTreeMap::new();
        loop {
            self.skip_ws_and_comments();
            if self.consume_if('}') {
                break;
            }
            let key = self.parse_string()?;
            self.skip_ws_and_comments();
            self.expect(':')?;
            let value = self.parse_primary()?;
            values.insert(key, value);
            self.skip_ws_and_comments();
            if self.consume_if('}') {
                break;
            }
            self.expect(',')?;
        }
        Ok(PythonExpr::Dict(values))
    }

    fn parse_string(&mut self) -> Result<String> {
        let quote = self
            .next_char()
            .ok_or_else(|| anyhow!("expected string literal"))?;
        let mut value = String::new();
        let mut escaped = false;
        while let Some(ch) = self.next_char() {
            if escaped {
                let resolved = match ch {
                    'n' => '\n',
                    'r' => '\r',
                    't' => '\t',
                    '\\' => '\\',
                    '\'' => '\'',
                    '"' => '"',
                    other => other,
                };
                value.push(resolved);
                escaped = false;
                continue;
            }
            if ch == '\\' {
                escaped = true;
                continue;
            }
            if ch == quote {
                return Ok(value);
            }
            value.push(ch);
        }
        bail!("unterminated bundled credential string literal")
    }

    fn parse_identifier(&mut self) -> Result<String> {
        let start = self.position;
        self.next_char();
        while let Some(ch) = self.peek_char() {
            if ch == '_' || ch.is_ascii_alphanumeric() {
                self.next_char();
            } else {
                break;
            }
        }
        Ok(self.input[start..self.position].to_string())
    }

    fn skip_ws_and_comments(&mut self) {
        loop {
            while matches!(self.peek_char(), Some(ch) if ch.is_whitespace()) {
                self.next_char();
            }
            if self.peek_char() == Some('#') {
                while let Some(ch) = self.next_char() {
                    if ch == '\n' {
                        break;
                    }
                }
                continue;
            }
            break;
        }
    }

    fn expect(&mut self, expected: char) -> Result<()> {
        match self.next_char() {
            Some(ch) if ch == expected => Ok(()),
            _ => bail!("Unsupported bundled credential return type"),
        }
    }

    fn consume_if(&mut self, expected: char) -> bool {
        if self.peek_char() == Some(expected) {
            self.next_char();
            true
        } else {
            false
        }
    }

    fn peek_char(&self) -> Option<char> {
        self.input[self.position..].chars().next()
    }

    fn next_char(&mut self) -> Option<char> {
        let next = self.peek_char()?;
        self.position += next.len_utf8();
        Some(next)
    }
}

fn is_identifier_start(ch: char) -> bool {
    ch == '_' || ch.is_ascii_alphabetic()
}

fn is_indented(line: &str) -> bool {
    matches!(line.as_bytes().first(), Some(b' ' | b'\t'))
}

#[cfg(test)]
struct EnvGuard(Vec<(String, Option<String>)>);

#[cfg(test)]
impl EnvGuard {
    fn capture(keys: &[&str]) -> Self {
        Self(
            keys.iter()
                .map(|key| ((*key).to_string(), std::env::var(key).ok()))
                .collect(),
        )
    }
}

#[cfg(test)]
impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (key, value) in self.0.drain(..) {
            match value {
                Some(value) => std::env::set_var(&key, value),
                None => std::env::remove_var(&key),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{CredentialSourceConfig, EnvGuard, OAuthConfig};
    use serde_json::json;
    use serial_test::serial;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    #[serial]
    fn builds_compat_redirect_uris() {
        let _env = EnvGuard::capture(&[
            "MCPO_OAUTH_COMPAT_CALLBACK_PORTS",
            "MCPO_OAUTH_CALLBACK_PORT",
            "OAUTH_CALLBACK_PORT",
        ]);
        std::env::remove_var("MCPO_OAUTH_COMPAT_CALLBACK_PORTS");
        std::env::remove_var("MCPO_OAUTH_CALLBACK_PORT");
        std::env::remove_var("OAUTH_CALLBACK_PORT");
        let config = OAuthConfig::from_value(&json!({})).unwrap();
        let redirect_uris = config.redirect_uris();
        assert!(redirect_uris.contains(&"http://localhost:3834/callback".to_string()));
        assert!(redirect_uris.contains(&"http://localhost:3836/callback".to_string()));
    }

    #[test]
    fn prefers_client_metadata_scope() {
        let config = OAuthConfig::from_value(&json!({
            "scope": "legacy",
            "scopes": ["fallback"],
            "client_metadata": {
                "scope": "openid offline_access"
            }
        }))
        .unwrap();
        assert_eq!(
            config.configured_scopes(),
            vec!["openid".to_string(), "offline_access".to_string()]
        );
    }

    #[test]
    fn prefers_scopes_over_singular_scope() {
        let config = OAuthConfig::from_value(&json!({
            "scope": "legacy-scope",
            "scopes": ["openid", "offline_access"]
        }))
        .unwrap();
        assert_eq!(
            config.configured_scopes(),
            vec!["openid".to_string(), "offline_access".to_string()]
        );
    }

    #[test]
    fn supports_singular_scope_for_cursor_compatible_fragments() {
        let config = OAuthConfig::from_value(&json!({
            "scope": "  openid \n email  "
        }))
        .unwrap();
        assert_eq!(
            config.configured_scopes(),
            vec!["openid".to_string(), "email".to_string()]
        );
    }

    #[test]
    fn supports_non_dcr_compat_type_for_cursor_compatible_fragments() {
        let config = OAuthConfig::from_value(&json!({
            "type": " non-dcr "
        }))
        .unwrap();
        assert_eq!(config.oauth_type(), Some("non-dcr"));
        assert!(config.is_non_dcr());
    }

    #[test]
    fn direct_client_id_normalizes_to_inline_non_dcr_credentials() {
        let config = OAuthConfig::from_value(&json!({
            "server_url": "https://mcp.example.test",
            "authorization_endpoint": "https://auth.example.test/authorize",
            "token_endpoint": "https://auth.example.test/token",
            "resource": "https://mcp.example.test",
            "client_id": " public-client ",
            "client_secret": " optional-secret ",
            "scopes": ["channels:read"],
            "discovered": true
        }))
        .unwrap();

        assert_eq!(config.oauth_type(), Some("non-dcr"));
        assert!(config.is_non_dcr());
        assert_eq!(
            config.configured_resource().as_deref(),
            Some("https://mcp.example.test")
        );
        assert_eq!(
            config.configured_scopes(),
            vec!["channels:read".to_string()]
        );
        assert_eq!(config.extra.get("discovered"), Some(&json!(true)));
        let source = config
            .credentials_source
            .as_ref()
            .expect("credentials source");
        assert_eq!(source.kind, "inline");
        assert_eq!(source.client_id.as_deref(), Some("public-client"));
        assert_eq!(source.client_secret.as_deref(), Some("optional-secret"));
    }

    #[tokio::test]
    async fn loads_inline_credentials() {
        let config: CredentialSourceConfig = serde_json::from_value(json!({
            "type": "inline",
            "client_id": "abc",
            "client_secret": "def"
        }))
        .unwrap();
        let loaded = config.load().await.unwrap();
        assert_eq!(loaded.client_id, "abc");
        assert_eq!(loaded.client_secret.as_deref(), Some("def"));
    }

    #[test]
    #[serial]
    fn callback_port_prefers_config_then_env() {
        let _env = EnvGuard::capture(&["MCPO_OAUTH_CALLBACK_PORT", "OAUTH_CALLBACK_PORT"]);
        std::env::set_var("MCPO_OAUTH_CALLBACK_PORT", "4001");
        std::env::set_var("OAUTH_CALLBACK_PORT", "4002");
        let config = OAuthConfig::from_value(&json!({"callback_port": 4999})).unwrap();
        assert_eq!(config.callback_port(), 3834);

        let env_only = OAuthConfig::from_value(&json!({})).unwrap();
        assert_eq!(env_only.callback_port(), 3834);

        std::env::remove_var("MCPO_OAUTH_CALLBACK_PORT");
        assert_eq!(env_only.callback_port(), 3834);
    }

    #[test]
    #[serial]
    fn redirect_uris_respect_metadata_and_compat_env() {
        let _env = EnvGuard::capture(&["MCPO_OAUTH_COMPAT_CALLBACK_PORTS"]);
        std::env::set_var(
            "MCPO_OAUTH_COMPAT_CALLBACK_PORTS",
            "3836, 4010, invalid, , 4010",
        );
        let config = OAuthConfig::from_value(&json!({"callback_port": 3900})).unwrap();
        let redirect_uris = config.redirect_uris();
        assert!(redirect_uris.contains(&"http://localhost:3834/callback".to_string()));
        assert!(redirect_uris.contains(&"http://localhost:3836/callback".to_string()));
        assert_eq!(redirect_uris.len(), 2);

        let metadata = OAuthConfig::from_value(&json!({
            "client_metadata": {
                "redirect_uris": [
                    "https://example.test/callback",
                    "http://localhost:3996/callback",
                    "http://localhost:3836/callback"
                ]
            }
        }))
        .unwrap();
        assert_eq!(
            metadata.redirect_uris(),
            vec![
                "https://example.test/callback".to_string(),
                "http://localhost:3836/callback".to_string(),
            ]
        );
    }

    #[test]
    #[serial]
    fn non_dcr_credentials_source_uses_http_loopback_redirects() {
        let _env = EnvGuard::capture(&[
            "MCPO_OAUTH_COMPAT_CALLBACK_PORTS",
            "MCPO_OAUTH_CALLBACK_PORT",
            "OAUTH_CALLBACK_PORT",
        ]);
        std::env::remove_var("MCPO_OAUTH_COMPAT_CALLBACK_PORTS");
        std::env::remove_var("MCPO_OAUTH_CALLBACK_PORT");
        std::env::remove_var("OAUTH_CALLBACK_PORT");

        let config = OAuthConfig::from_value(&json!({
            "type": "non-dcr",
            "callback_port": 3836,
            "credentials_source": {
                "type": "inline",
                "client_id": "2317524819.11152506261415"
            }
        }))
        .unwrap();

        assert_eq!(
            config.active_redirect_uri(),
            "http://localhost:3836/callback"
        );
        assert_eq!(
            config.redirect_uris(),
            vec![
                "http://localhost:3836/callback".to_string(),
                "http://localhost:3834/callback".to_string(),
            ]
        );
        assert!(
            config
                .redirect_uris()
                .iter()
                .all(|uri| uri.starts_with("http://localhost:")),
            "native-app OAuth redirects must remain HTTP loopback URIs"
        );
    }

    #[test]
    fn computes_defaults_and_overrides() {
        let config = OAuthConfig::from_value(&json!({
            "authorization_server": "https://issuer.example",
            "resource": "https://resource.example",
            "client_metadata": {
                "client_name": "Demo App",
                "grant_types": ["authorization_code"],
                "response_types": ["code id_token"]
            }
        }))
        .unwrap();
        assert_eq!(config.client_name(), "Demo App");
        assert_eq!(config.grant_types(), vec!["authorization_code".to_string()]);
        assert_eq!(config.response_types(), vec!["code id_token".to_string()]);
        assert_eq!(
            config.discovery_base("https://fallback"),
            "https://issuer.example"
        );
        assert_eq!(
            config.resource_url("https://fallback"),
            "https://resource.example"
        );

        let defaults =
            OAuthConfig::from_value(&json!({"server_url": "https://server.example"})).unwrap();
        assert_eq!(defaults.client_name(), "Portico");
        assert_eq!(
            defaults.grant_types(),
            vec![
                "authorization_code".to_string(),
                "refresh_token".to_string()
            ]
        );
        assert_eq!(defaults.response_types(), vec!["code".to_string()]);
        assert_eq!(
            defaults.discovery_base("https://fallback"),
            "https://server.example"
        );
        assert_eq!(
            defaults.resource_url("https://fallback"),
            "https://fallback"
        );
    }

    #[tokio::test]
    #[serial]
    async fn loads_env_file_and_bundled_credentials() {
        let _env = EnvGuard::capture(&["CLIENT_ID_VAR", "CLIENT_SECRET_VAR"]);
        std::env::set_var("CLIENT_ID_VAR", "env-client");
        std::env::set_var("CLIENT_SECRET_VAR", "env-secret");
        let env_source: CredentialSourceConfig = serde_json::from_value(json!({
            "type": "env",
            "client_id_var": "CLIENT_ID_VAR",
            "client_secret_var": "CLIENT_SECRET_VAR",
            "scopes": ["openid"]
        }))
        .unwrap();
        let env_loaded = env_source.load().await.unwrap();
        assert_eq!(env_loaded.client_id, "env-client");
        assert_eq!(env_loaded.client_secret.as_deref(), Some("env-secret"));

        let dir = tempdir().unwrap();
        let file_path = dir.path().join("creds.json");
        fs::write(
            &file_path,
            r#"{"client_id":"file-client","client_secret":"file-secret","scopes":["offline_access"]}"#,
        )
        .unwrap();
        let file_source: CredentialSourceConfig = serde_json::from_value(json!({
            "type": "file",
            "path": file_path
        }))
        .unwrap();
        let file_loaded = file_source.load().await.unwrap();
        assert_eq!(file_loaded.client_id, "file-client");
        assert_eq!(file_loaded.client_secret.as_deref(), Some("file-secret"));
        assert_eq!(file_loaded.scopes, vec!["offline_access".to_string()]);

        let module_path = dir.path().join("bundled.py");
        fs::write(
            &module_path,
            "def get_bundled_credentials():\n    return {'client_id': 'bundled-client', 'client_secret': 'bundled-secret'}\n",
        )
        .unwrap();
        let bundled_source: CredentialSourceConfig = serde_json::from_value(json!({
            "type": "bundled",
            "module_path": module_path
        }))
        .unwrap();
        let bundled_loaded = bundled_source.load().await.unwrap();
        assert_eq!(bundled_loaded.client_id, "bundled-client");
        assert_eq!(
            bundled_loaded.client_secret.as_deref(),
            Some("bundled-secret")
        );
    }

    #[tokio::test]
    async fn reports_credential_source_errors() {
        let unsupported: CredentialSourceConfig =
            serde_json::from_value(json!({"type": "weird"})).unwrap();
        assert!(unsupported.load().await.is_err());

        let inline_missing: CredentialSourceConfig =
            serde_json::from_value(json!({"type": "inline"})).unwrap();
        assert!(inline_missing.load().await.is_err());

        let file_missing: CredentialSourceConfig =
            serde_json::from_value(json!({"type": "file"})).unwrap();
        assert!(file_missing.load().await.is_err());

        let bundled_missing: CredentialSourceConfig =
            serde_json::from_value(json!({"type": "bundled"})).unwrap();
        assert!(bundled_missing.load().await.is_err());
    }

    #[tokio::test]
    #[serial]
    async fn env_credentials_prefer_direct_env_over_file() {
        let _env = EnvGuard::capture(&[
            "TEST_OAUTH_CLIENT_ID",
            "TEST_OAUTH_CLIENT_ID_FILE",
            "TEST_OAUTH_CLIENT_SECRET",
            "TEST_OAUTH_CLIENT_SECRET_FILE",
        ]);
        std::env::set_var("TEST_OAUTH_CLIENT_ID", "cid-direct");
        std::env::set_var("TEST_OAUTH_CLIENT_SECRET", "sec-direct");
        std::env::remove_var("TEST_OAUTH_CLIENT_ID_FILE");
        std::env::remove_var("TEST_OAUTH_CLIENT_SECRET_FILE");

        let cfg: CredentialSourceConfig = serde_json::from_value(json!({
            "type": "env",
            "client_id_var": "TEST_OAUTH_CLIENT_ID",
            "client_secret_var": "TEST_OAUTH_CLIENT_SECRET"
        }))
        .unwrap();
        let loaded = cfg.load().await.expect("env ingress succeeds");
        assert_eq!(loaded.client_id, "cid-direct");
        assert_eq!(loaded.client_secret.as_deref(), Some("sec-direct"));
    }

    #[tokio::test]
    #[serial]
    async fn env_credentials_fallback_to_file_when_env_unset() {
        let tmp = tempdir().unwrap();
        let id_path = tmp.path().join("oauth_client_id");
        let secret_path = tmp.path().join("oauth_client_secret");
        fs::write(&id_path, "cid-from-file\n").unwrap();
        fs::write(&secret_path, "sec-from-file\n").unwrap();

        let _env = EnvGuard::capture(&[
            "TEST_OAUTH_CLIENT_ID",
            "TEST_OAUTH_CLIENT_ID_FILE",
            "TEST_OAUTH_CLIENT_SECRET",
            "TEST_OAUTH_CLIENT_SECRET_FILE",
        ]);
        std::env::remove_var("TEST_OAUTH_CLIENT_ID");
        std::env::remove_var("TEST_OAUTH_CLIENT_SECRET");
        std::env::set_var("TEST_OAUTH_CLIENT_ID_FILE", &id_path);
        std::env::set_var("TEST_OAUTH_CLIENT_SECRET_FILE", &secret_path);

        let cfg: CredentialSourceConfig = serde_json::from_value(json!({
            "type": "env",
            "client_id_var": "TEST_OAUTH_CLIENT_ID",
            "client_secret_var": "TEST_OAUTH_CLIENT_SECRET"
        }))
        .unwrap();
        let loaded = cfg.load().await.expect("file fallback succeeds");
        assert_eq!(loaded.client_id, "cid-from-file");
        assert_eq!(loaded.client_secret.as_deref(), Some("sec-from-file"));
    }

    #[tokio::test]
    #[serial]
    async fn env_credentials_fail_when_neither_env_nor_file_populated() {
        let _env = EnvGuard::capture(&[
            "TEST_OAUTH_CLIENT_ID",
            "TEST_OAUTH_CLIENT_ID_FILE",
            "TEST_OAUTH_CLIENT_SECRET",
            "TEST_OAUTH_CLIENT_SECRET_FILE",
        ]);
        std::env::remove_var("TEST_OAUTH_CLIENT_ID");
        std::env::remove_var("TEST_OAUTH_CLIENT_ID_FILE");
        std::env::remove_var("TEST_OAUTH_CLIENT_SECRET");
        std::env::remove_var("TEST_OAUTH_CLIENT_SECRET_FILE");

        let cfg: CredentialSourceConfig = serde_json::from_value(json!({
            "type": "env",
            "client_id_var": "TEST_OAUTH_CLIENT_ID",
            "client_secret_var": "TEST_OAUTH_CLIENT_SECRET"
        }))
        .unwrap();
        assert!(cfg.load().await.is_err());
    }

    #[tokio::test]
    #[serial]
    async fn env_credentials_fall_back_to_file_when_env_empty_string() {
        let tmp = tempdir().unwrap();
        let id_path = tmp.path().join("oauth_client_id");
        let secret_path = tmp.path().join("oauth_client_secret");
        fs::write(&id_path, "cid-from-file\n").unwrap();
        fs::write(&secret_path, "sec-from-file\n").unwrap();

        let _env = EnvGuard::capture(&[
            "TEST_OAUTH_CLIENT_ID",
            "TEST_OAUTH_CLIENT_ID_FILE",
            "TEST_OAUTH_CLIENT_SECRET",
            "TEST_OAUTH_CLIENT_SECRET_FILE",
        ]);
        std::env::set_var("TEST_OAUTH_CLIENT_ID", "");
        std::env::set_var("TEST_OAUTH_CLIENT_SECRET", "   ");
        std::env::set_var("TEST_OAUTH_CLIENT_ID_FILE", &id_path);
        std::env::set_var("TEST_OAUTH_CLIENT_SECRET_FILE", &secret_path);

        let cfg: CredentialSourceConfig = serde_json::from_value(json!({
            "type": "env",
            "client_id_var": "TEST_OAUTH_CLIENT_ID",
            "client_secret_var": "TEST_OAUTH_CLIENT_SECRET"
        }))
        .unwrap();
        let loaded = cfg.load().await.expect("empty env falls back to file");
        assert_eq!(loaded.client_id, "cid-from-file");
        assert_eq!(loaded.client_secret.as_deref(), Some("sec-from-file"));
    }
}

#[cfg(test)]
#[path = "config_extra_tests.rs"]
mod extra_tests;
