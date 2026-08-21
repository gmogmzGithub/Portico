use std::collections::{BTreeMap, BTreeSet};

use axum::http::HeaderMap;
use rmcp::model::{Meta, ServerInfo};
use serde_json::{Map, Value};

use crate::config::{normalize_server_type, ServerConfig};

pub(crate) fn supports_native_oauth(config: &ServerConfig) -> bool {
    matches!(
        normalize_server_type(config.server_type.as_deref()).as_deref(),
        Some("streamable-http") | Some("sse")
    ) || config.http_subprocess.is_some()
}

pub(crate) fn server_display_name(info: &ServerInfo) -> String {
    if !info.server_info.name.is_empty() {
        info.server_info.name.clone()
    } else {
        "MCP Server".to_string()
    }
}

pub(crate) fn forwarded_header_meta(headers: &HeaderMap, config: &ServerConfig) -> Meta {
    let mut meta = Map::new();
    let forwarding = config
        .client_header_forwarding
        .as_ref()
        .and_then(Value::as_object);
    let Some(forwarding) = forwarding else {
        return Meta(meta);
    };
    let enabled = forwarding
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !enabled {
        return Meta(meta);
    }

    let allowed: Option<BTreeSet<String>> = forwarding
        .get("allowed_headers")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|value| value.to_ascii_lowercase())
                .collect()
        });

    let mut forwarded = Map::new();
    for (name, value) in headers {
        let header_name = name.as_str().to_ascii_lowercase();
        if let Some(allowed) = allowed.as_ref() {
            if !allowed.contains(&header_name) {
                continue;
            }
        }
        if let Ok(value) = value.to_str() {
            forwarded.insert(name.to_string(), Value::String(value.to_string()));
        }
    }

    if !forwarded.is_empty() {
        meta.insert("headers".to_string(), Value::Object(forwarded));
    }

    Meta(meta)
}

pub(crate) fn normalize_tool_rename_mapping(
    mapping: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut normalized = BTreeMap::new();
    for (key, value) in mapping {
        normalized.insert(key.clone(), value.clone());
        normalized
            .entry(key.to_ascii_lowercase())
            .or_insert_with(|| value.clone());
    }
    normalized
}

pub(crate) fn sanitize_tool_name(name: &str) -> String {
    let mut output = String::new();
    let mut last_was_underscore = false;

    for character in name.trim().chars() {
        let valid = character.is_ascii_alphanumeric() || character == '_';
        let next = if valid { character } else { '_' };
        if next == '_' {
            if last_was_underscore {
                continue;
            }
            last_was_underscore = true;
        } else {
            last_was_underscore = false;
        }
        output.push(next);
    }

    output.trim_matches('_').to_string()
}
