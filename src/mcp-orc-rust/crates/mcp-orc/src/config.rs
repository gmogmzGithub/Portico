use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs;
use std::path::Path;
use url::{Position, Url};

use crate::managed_node::{is_managed_node_sentinel, is_package_manager_command};

#[derive(Debug)]
pub struct ConfigError {
    message: String,
}

impl ConfigError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for ConfigError {}

#[derive(Debug, Clone, Deserialize)]
pub struct McpConfig {
    #[serde(rename = "mcpServers", default)]
    pub mcp_servers: BTreeMap<String, ServerConfig>,
}

impl McpConfig {
    pub fn load(path: &Path) -> Result<Self, ConfigError> {
        let raw = fs::read_to_string(path)
            .map_err(|err| ConfigError::new(format!("failed to read {}: {err}", path.display())))?;
        let parsed: Self = serde_json::from_str(&raw).map_err(|err| {
            ConfigError::new(format!("invalid JSON in {}: {err}", path.display()))
        })?;
        parsed.validate()?;
        Ok(parsed)
    }

    pub fn load_from_path(path: &Path) -> Result<Self, ConfigError> {
        Self::load(path)
    }

    pub fn validate(&self) -> Result<(), ConfigError> {
        for (name, server) in &self.mcp_servers {
            server.validate(name)?;
        }
        Ok(())
    }

    pub fn server_names(&self) -> Vec<String> {
        self.mcp_servers.keys().cloned().collect()
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ServerConfig {
    #[serde(rename = "type")]
    pub server_type: Option<String>,
    pub url: Option<String>,
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub sensitive_env_vars: Vec<String>,
    pub oauth: Option<Value>,
    pub headers: Option<Value>,
    #[serde(default)]
    pub disabled_tools: Vec<String>,
    #[serde(default)]
    pub tool_rename_mapping: BTreeMap<String, String>,
    pub tool_call_timeout: Option<f64>,
    pub client_header_forwarding: Option<Value>,
    pub http_subprocess: Option<Value>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl ServerConfig {
    pub fn retryable_tools(&self) -> Vec<String> {
        self.extra
            .get("retryable_tools")
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ToOwned::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn validate(&self, server_name: &str) -> Result<(), ConfigError> {
        let normalized_type = normalize_server_type(self.server_type.as_deref());

        match normalized_type.as_deref() {
            Some("sse") | Some("streamable-http") => {
                if self.url.as_deref().unwrap_or("").is_empty() {
                    return Err(ConfigError::new(format!(
                        "server '{server_name}' of type '{}' requires a url",
                        normalized_type.unwrap()
                    )));
                }
            }
            _ if self.command.is_some() => {}
            _ if self.url.is_some() && self.server_type.is_none() => {}
            _ => {
                return Err(ConfigError::new(format!(
                    "server '{server_name}' must define command or type+url"
                )));
            }
        }

        if let Some(command) = self.command.as_deref() {
            if is_package_manager_command(command) {
                return Err(ConfigError::new(format!(
                    "server '{server_name}' uses raw package-manager command '{command}'; run managed Node package preparation before launch"
                )));
            }
            if is_managed_node_sentinel(command) && !self.extra.contains_key("managed_node_package")
            {
                return Err(ConfigError::new(format!(
                    "server '{server_name}' uses managed Node package sentinel without managed_node_package metadata"
                )));
            }
        }

        if let Some(timeout) = self.tool_call_timeout {
            if timeout <= 0.0 {
                return Err(ConfigError::new(format!(
                    "server '{server_name}' tool_call_timeout must be > 0"
                )));
            }
        }

        if let Some(retryable_tools) = self.extra.get("retryable_tools") {
            let entries = retryable_tools.as_array().ok_or_else(|| {
                ConfigError::new(format!(
                    "server '{server_name}' retryable_tools must be an array"
                ))
            })?;
            let mut seen = BTreeSet::new();
            for entry in entries {
                let Some(tool_name) = entry.as_str() else {
                    return Err(ConfigError::new(format!(
                        "server '{server_name}' retryable_tools entries must be strings"
                    )));
                };
                if tool_name.trim().is_empty() {
                    return Err(ConfigError::new(format!(
                        "server '{server_name}' retryable_tools entries must not be empty"
                    )));
                }
                if !seen.insert(tool_name) {
                    return Err(ConfigError::new(format!(
                        "server '{server_name}' retryable_tools contains duplicate '{tool_name}'"
                    )));
                }
            }
        }

        Ok(())
    }
}

pub fn normalize_server_type(server_type: Option<&str>) -> Option<String> {
    match server_type.map(str::trim).filter(|value| !value.is_empty()) {
        Some("streamable_http") | Some("streamablehttp") | Some("streamable-http") => {
            Some("streamable-http".to_string())
        }
        Some(other) => Some(other.to_string()),
        None => None,
    }
}

fn rewrite_url_path(parsed: &Url, path: &str) -> String {
    format!(
        "{}{}{}",
        &parsed[..Position::BeforePath],
        path,
        &parsed[Position::AfterPath..]
    )
}

pub fn canonicalize_streamable_http_resource_url(url: &str) -> String {
    let trimmed = url.trim();
    let Ok(parsed) = Url::parse(trimmed) else {
        return trimmed.to_string();
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return trimmed.to_string();
    }
    let path = parsed.path().to_string();
    if path == "/" || !path.ends_with('/') {
        return trimmed.to_string();
    }
    let normalized_path = path.trim_end_matches('/').to_string();
    if normalized_path.is_empty() {
        return trimmed.to_string();
    }
    rewrite_url_path(&parsed, &normalized_path)
}

pub fn streamable_http_transport_candidates(url: &str) -> Vec<String> {
    let trimmed = url.trim();
    let Ok(parsed) = Url::parse(trimmed) else {
        return vec![trimmed.to_string()];
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return vec![trimmed.to_string()];
    }

    let path = parsed.path().to_string();
    if path == "/" {
        return vec![trimmed.to_string()];
    }

    let slashless_path = path.trim_end_matches('/');
    if slashless_path.is_empty() {
        return vec![trimmed.to_string()];
    }

    let mut candidates = Vec::with_capacity(3);
    candidates.push(rewrite_url_path(&parsed, slashless_path));
    let slash_candidate = rewrite_url_path(&parsed, &format!("{slashless_path}/"));
    if !candidates.contains(&slash_candidate) {
        candidates.push(slash_candidate);
    }
    if !candidates.iter().any(|candidate| candidate == trimmed) {
        candidates.push(trimmed.to_string());
    }
    candidates
}

#[cfg(test)]
mod tests {
    use super::{
        canonicalize_streamable_http_resource_url, normalize_server_type,
        streamable_http_transport_candidates, McpConfig,
    };
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn parses_and_validates_streamable_http_server() {
        let raw = r#"{
            "mcpServers": {
                "demo": {
                    "type": "streamable_http",
                    "url": "http://example.test/mcp",
                    "tool_call_timeout": 30
                }
            }
        }"#;
        let parsed: McpConfig = serde_json::from_str(raw).expect("config should parse");
        parsed.validate().expect("config should validate");
        assert_eq!(parsed.server_names(), vec!["demo".to_string()]);
    }

    #[test]
    fn rejects_invalid_tool_timeout() {
        let raw = r#"{
            "mcpServers": {
                "demo": {
                    "command": "uv",
                    "tool_call_timeout": 0
                }
            }
        }"#;
        let parsed: McpConfig = serde_json::from_str(raw).expect("config should parse");
        let error = parsed.validate().expect_err("config should fail");
        assert!(error.to_string().contains("tool_call_timeout"));
    }

    #[test]
    fn retryable_tools_default_empty_and_validate_strictly() {
        let absent: McpConfig =
            serde_json::from_str(r#"{"mcpServers":{"demo":{"command":"uv"}}}"#).unwrap();
        absent.validate().unwrap();
        assert!(absent.mcp_servers["demo"].retryable_tools().is_empty());

        let configured: McpConfig = serde_json::from_str(
            r#"{"mcpServers":{"demo":{"command":"uv","retryable_tools":["read"]}}}"#,
        )
        .unwrap();
        configured.validate().unwrap();
        assert_eq!(configured.mcp_servers["demo"].retryable_tools(), ["read"]);

        for raw in [
            r#"{"mcpServers":{"demo":{"command":"uv","retryable_tools":"read"}}}"#,
            r#"{"mcpServers":{"demo":{"command":"uv","retryable_tools":[""]}}}"#,
            r#"{"mcpServers":{"demo":{"command":"uv","retryable_tools":["read","read"]}}}"#,
        ] {
            let parsed: McpConfig = serde_json::from_str(raw).unwrap();
            assert!(
                parsed.validate().is_err(),
                "configuration should fail: {raw}"
            );
        }
    }

    #[test]
    fn normalizes_streamable_http_aliases() {
        assert_eq!(
            normalize_server_type(Some("streamable_http")),
            Some("streamable-http".to_string())
        );
        assert_eq!(
            normalize_server_type(Some("streamablehttp")),
            Some("streamable-http".to_string())
        );
        assert_eq!(
            normalize_server_type(Some(" streamable-http ")),
            Some("streamable-http".to_string())
        );
        assert_eq!(normalize_server_type(Some("")), None);
        assert_eq!(normalize_server_type(None), None);
    }

    #[test]
    fn canonicalizes_streamable_http_resource_urls() {
        assert_eq!(
            canonicalize_streamable_http_resource_url("http://example.test/v1/tools/"),
            "http://example.test/v1/tools"
        );
        assert_eq!(
            canonicalize_streamable_http_resource_url("https://example.test/v1/tools///?mode=all"),
            "https://example.test/v1/tools?mode=all"
        );
        assert_eq!(
            canonicalize_streamable_http_resource_url(
                "https://example.test/v1/encoded%2Fsegment/?mode=all"
            ),
            "https://example.test/v1/encoded%2Fsegment?mode=all"
        );
        assert_eq!(
            canonicalize_streamable_http_resource_url("https://example.test/v1/tools"),
            "https://example.test/v1/tools"
        );
        assert_eq!(
            canonicalize_streamable_http_resource_url("https://example.test/"),
            "https://example.test/"
        );
        assert_eq!(
            canonicalize_streamable_http_resource_url("stdio://example.test/v1/tools/"),
            "stdio://example.test/v1/tools/"
        );
    }

    #[test]
    fn derives_streamable_http_transport_candidates() {
        assert_eq!(
            streamable_http_transport_candidates("https://example.test/v1/tools"),
            vec![
                "https://example.test/v1/tools".to_string(),
                "https://example.test/v1/tools/".to_string()
            ]
        );
        assert_eq!(
            streamable_http_transport_candidates("https://example.test/v1/tools/"),
            vec![
                "https://example.test/v1/tools".to_string(),
                "https://example.test/v1/tools/".to_string()
            ]
        );
        assert_eq!(
            streamable_http_transport_candidates(
                "https://example.test/v1/tools///?mode=all#section"
            ),
            vec![
                "https://example.test/v1/tools?mode=all#section".to_string(),
                "https://example.test/v1/tools/?mode=all#section".to_string(),
                "https://example.test/v1/tools///?mode=all#section".to_string()
            ]
        );
        assert_eq!(
            streamable_http_transport_candidates(
                "https://example.test/v1/encoded%2Fsegment/?mode=all"
            ),
            vec![
                "https://example.test/v1/encoded%2Fsegment?mode=all".to_string(),
                "https://example.test/v1/encoded%2Fsegment/?mode=all".to_string()
            ]
        );
        assert_eq!(
            streamable_http_transport_candidates("https://example.test/"),
            vec!["https://example.test/".to_string()]
        );
        assert_eq!(
            streamable_http_transport_candidates("stdio://example.test/v1/tools/"),
            vec!["stdio://example.test/v1/tools/".to_string()]
        );
    }

    #[test]
    fn loads_config_from_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        fs::write(
            &path,
            r#"{
                "mcpServers": {
                    "demo": {
                        "command": "uvx"
                    }
                }
            }"#,
        )
        .unwrap();
        let parsed = McpConfig::load(&path).unwrap();
        assert_eq!(parsed.server_names(), vec!["demo".to_string()]);
        let parsed_via_alias = McpConfig::load_from_path(&path).unwrap();
        assert_eq!(parsed_via_alias.server_names(), vec!["demo".to_string()]);
    }

    #[test]
    fn reports_read_errors_with_path_context() {
        let missing = tempdir().unwrap().path().join("missing.json");
        let error = McpConfig::load(&missing).expect_err("missing file should fail");
        assert!(error.to_string().contains("failed to read"));
        assert!(error.to_string().contains("missing.json"));
    }

    #[test]
    fn reports_invalid_json_with_path_context() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("broken.json");
        fs::write(&path, "{not-json").unwrap();
        let error = McpConfig::load(&path).expect_err("invalid JSON should fail");
        assert!(error.to_string().contains("invalid JSON"));
        assert!(error.to_string().contains("broken.json"));
    }

    #[test]
    fn rejects_streaming_server_without_url() {
        let raw = r#"{
            "mcpServers": {
                "demo": {
                    "type": "streamable-http"
                }
            }
        }"#;
        let parsed: McpConfig = serde_json::from_str(raw).unwrap();
        let error = parsed.validate().expect_err("missing url should fail");
        assert!(error.to_string().contains("requires a url"));
    }

    #[test]
    fn accepts_url_only_server_without_explicit_type() {
        let raw = r#"{
            "mcpServers": {
                "demo": {
                    "url": "http://example.test/mcp"
                }
            }
        }"#;
        let parsed: McpConfig = serde_json::from_str(raw).unwrap();
        parsed.validate().unwrap();
    }

    #[test]
    fn rejects_server_without_command_or_url() {
        let raw = r#"{
            "mcpServers": {
                "demo": {}
            }
        }"#;
        let parsed: McpConfig = serde_json::from_str(raw).unwrap();
        let error = parsed
            .validate()
            .expect_err("missing command/url should fail");
        assert!(error
            .to_string()
            .contains("must define command or type+url"));
    }
}
