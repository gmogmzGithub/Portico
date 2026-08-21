//! Privacy-safe LogRepo telemetry for externally invoked Host MCP Bridge tools.
//!
//! The Electron process supplies identity and build metadata through the child
//! environment. Each authenticated `tools/call` produces one best-effort CLIP
//! event. Telemetry never contains tool arguments, results, URLs, paths,
//! bearer tokens, or raw error text, and delivery failures never affect calls.

use std::time::Duration;

use chrono::{SecondsFormat, Utc};
use log::debug;

const BRIDGE_LOGREPO_TYPE: &str = "porticoAiChatBridgeEvent";
const BRIDGE_LOGREPO_SCHEMA_VERSION: &str = "1";
const LOGREPO_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_TOKEN_LEN: usize = 96;

#[derive(Debug, Clone)]
pub(crate) struct BridgeTelemetry {
    enabled: bool,
    url: String,
    ldap: String,
    app_version: String,
    build_channel: String,
    machine_hash: String,
    http: reqwest::Client,
}

#[derive(Debug, Clone)]
pub(crate) struct BridgeToolCallEvent {
    pub client_id: String,
    pub server_id: String,
    pub tool: String,
    /// `meta` or `expose_all` on the current bridge surface.
    pub surface: &'static str,
    /// `success` or `failed`.
    pub outcome: &'static str,
    pub error_category: &'static str,
    pub elapsed_ms: u128,
}

impl BridgeTelemetry {
    pub(crate) fn from_env() -> Self {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    #[cfg(test)]
    pub(crate) fn disabled() -> Self {
        Self {
            enabled: false,
            url: String::new(),
            ldap: String::new(),
            app_version: String::new(),
            build_channel: String::new(),
            machine_hash: String::new(),
            http: reqwest::Client::new(),
        }
    }

    fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Self {
        let non_empty = |name: &str| {
            lookup(name)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        };
        let truthy = |value: String| value == "1" || value.eq_ignore_ascii_case("true");
        // Opt-IN. LogRepo is an organization analytics integration and the
        // payload carries user identity (ldap, machine_hash), so it stays off
        // unless an operator both enables it and names an endpoint — no
        // default destination. AGENTS.md: integrations are "configurable and
        // opt-in", "not as hard-coded defaults".
        let requested = non_empty("PORTICO_MCP_BRIDGE_LOGREPO_ENABLED")
            .or_else(|| non_empty("portico_MCP_BRIDGE_LOGREPO_ENABLED"))
            .map(truthy)
            .unwrap_or(false);
        // Legacy kill switch: deployments that set it stay off even if the
        // enable flag is also present.
        let disabled = non_empty("portico_MCP_BRIDGE_LOGREPO_DISABLED")
            .map(truthy)
            .unwrap_or(false);
        let url = non_empty("portico_MCP_BRIDGE_LOGREPO_URL")
            .or_else(|| non_empty("portico_MCP_LOGREPO_URL"))
            .unwrap_or_default();
        Self {
            enabled: requested && !disabled && !url.is_empty(),
            url,
            ldap: non_empty("portico_LDAP")
                .or_else(|| non_empty("PORTICO_USER_ID"))
                .or_else(|| non_empty("LDAP"))
                .or_else(|| non_empty("USER"))
                .unwrap_or_else(|| "unknown".to_string()),
            app_version: non_empty("portico_APP_VERSION").unwrap_or_else(|| "unknown".to_string()),
            build_channel: non_empty("portico_BUILD_CHANNEL").unwrap_or_else(|| "unknown".to_string()),
            machine_hash: non_empty("portico_MACHINE_HASH").unwrap_or_else(|| "unknown".to_string()),
            http: reqwest::Client::builder()
                .timeout(LOGREPO_TIMEOUT)
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
        }
    }

    /// Fire and forget. A missing runtime, network error, or non-2xx response
    /// must never change the MCP result returned to the external client.
    pub(crate) fn emit_tool_call(&self, event: BridgeToolCallEvent) {
        if !self.enabled {
            return;
        }
        let body = self.tool_call_form_body(&event);
        let http = self.http.clone();
        let url = self.url.clone();
        tokio::spawn(async move {
            match http
                .post(&url)
                .header("Content-Type", "application/x-www-form-urlencoded")
                .body(body)
                .send()
                .await
            {
                Ok(response) if !response.status().is_success() => {
                    debug!(
                        "Host MCP Bridge LogRepo telemetry returned HTTP {}",
                        response.status()
                    );
                }
                Err(error) => debug!("Host MCP Bridge LogRepo telemetry failed: {error}"),
                Ok(_) => {}
            }
        });
    }

    fn tool_call_form_body(&self, event: &BridgeToolCallEvent) -> String {
        let client_id = normalize_token(&event.client_id, "unknown");
        let server_id = normalize_token(&event.server_id, "unknown");
        let tool = normalize_token(&event.tool, "unknown");
        let elapsed_ms = event.elapsed_ms.to_string();
        let tool_call_id = format!("{:032x}", rand::random::<u128>());
        let pairs: Vec<(&str, String)> = vec![
            ("type", BRIDGE_LOGREPO_TYPE.to_string()),
            ("schema_version", BRIDGE_LOGREPO_SCHEMA_VERSION.to_string()),
            ("event_name", "bridge_tool_call".to_string()),
            ("event_scope", "tool_call".to_string()),
            ("runtime_path", "portico_bridge".to_string()),
            ("request_source", "external_client".to_string()),
            ("caller", client_id.clone()),
            ("outcome", normalize_token(event.outcome, "unknown")),
            (
                "error_category",
                normalize_token(event.error_category, "unknown"),
            ),
            ("tool_call_id", tool_call_id),
            ("client", client_id.clone()),
            ("client_id", client_id),
            ("mcp_server", server_id.clone()),
            ("server_id", server_id),
            ("mcp_tool", tool.clone()),
            ("tool", tool),
            ("surface", normalize_token(event.surface, "unknown")),
            ("latency_ms", elapsed_ms.clone()),
            ("elapsed_ms", elapsed_ms),
            ("appinstance", "portico".to_string()),
            ("app_version", self.app_version.clone()),
            (
                "build_channel",
                normalize_token(&self.build_channel, "unknown"),
            ),
            ("platform", platform_token().to_string()),
            ("arch", arch_token().to_string()),
            ("ldap", normalize_token(&self.ldap, "unknown")),
            ("machine_hash", self.machine_hash.clone()),
            (
                "ts",
                Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            ),
        ];
        build_clip_form_body(&pairs)
    }

    #[cfg(test)]
    pub(crate) fn for_test(url: String) -> Self {
        Self::from_lookup(|name| match name {
            "portico_LDAP" => Some("test-user".to_string()),
            "portico_APP_VERSION" => Some("1.2.3".to_string()),
            "portico_BUILD_CHANNEL" => Some("beta".to_string()),
            "portico_MACHINE_HASH" => Some("abcdef0123456789".to_string()),
            "portico_MCP_BRIDGE_LOGREPO_URL" => Some(url.clone()),
            "PORTICO_MCP_BRIDGE_LOGREPO_ENABLED" => Some("1".to_string()),
            _ => None,
        })
    }
}

fn build_clip_form_body(pairs: &[(&str, String)]) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in pairs {
        if !value.is_empty() {
            serializer.append_pair(key, value);
        }
    }
    format!("{}&&", serializer.finish())
}

fn normalize_token(value: &str, fallback: &str) -> String {
    let mut normalized = String::with_capacity(value.len().min(MAX_TOKEN_LEN));
    let mut last_was_placeholder = false;
    for ch in value.trim().chars() {
        let lower = ch.to_ascii_lowercase();
        if lower.is_ascii_lowercase() || lower.is_ascii_digit() || matches!(lower, '_' | '.' | '-')
        {
            normalized.push(lower);
            last_was_placeholder = lower == '_';
        } else if !last_was_placeholder {
            normalized.push('_');
            last_was_placeholder = true;
        }
    }
    let trimmed = normalized
        .trim_matches(|ch| matches!(ch, '_' | '-' | '.'))
        .chars()
        .take(MAX_TOKEN_LEN)
        .collect::<String>();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed
    }
}

fn platform_token() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

fn arch_token() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn form_body_has_queryable_runtime_contract_and_no_sensitive_payload_fields() {
        let telemetry = BridgeTelemetry::for_test("http://127.0.0.1:9/logrepo".to_string());
        let body = telemetry.tool_call_form_body(&BridgeToolCallEvent {
            client_id: "Claude Code".to_string(),
            server_id: "google_workspace".to_string(),
            tool: "search_docs".to_string(),
            surface: "meta",
            outcome: "failed",
            error_category: "downstream_failure",
            elapsed_ms: 42,
        });
        let fields: std::collections::HashMap<_, _> =
            url::form_urlencoded::parse(body.trim_end_matches("&&").as_bytes())
                .into_owned()
                .collect();

        assert!(body.ends_with("&&"));
        assert_eq!(fields["type"], BRIDGE_LOGREPO_TYPE);
        assert_eq!(fields["event_name"], "bridge_tool_call");
        assert_eq!(fields["runtime_path"], "portico_bridge");
        assert_eq!(fields["client_id"], "claude_code");
        assert_eq!(fields["client"], "claude_code");
        assert_eq!(fields["server_id"], "google_workspace");
        assert_eq!(fields["mcp_server"], "google_workspace");
        assert_eq!(fields["tool"], "search_docs");
        assert_eq!(fields["mcp_tool"], "search_docs");
        assert_eq!(fields["outcome"], "failed");
        assert_eq!(fields["error_category"], "downstream_failure");
        assert_eq!(fields["elapsed_ms"], "42");
        assert_eq!(fields["latency_ms"], "42");
        assert_eq!(fields["tool_call_id"].len(), 32);
        assert!(!fields.contains_key("arguments"));
        assert!(!fields.contains_key("result"));
        assert!(!fields.contains_key("error"));
        assert!(!body.contains("127.0.0.1"));
    }

    #[test]
    fn disabled_emitter_is_safe_without_an_async_runtime() {
        BridgeTelemetry::disabled().emit_tool_call(BridgeToolCallEvent {
            client_id: "codex".to_string(),
            server_id: "bridge".to_string(),
            tool: "find_relevant_tools".to_string(),
            surface: "meta",
            outcome: "success",
            error_category: "none",
            elapsed_ms: 0,
        });
    }
}
