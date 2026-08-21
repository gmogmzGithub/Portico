use std::env;

use anyhow::{Context, Result};
use axum::http::HeaderMap;
use chrono::Utc;
use core_mcp_shared::{
    bare_server_id, build_overflow_artifact, is_core_server_config, overflow_enabled_from_env,
    overflow_max_chars_from_env, redis_compare_delete, redis_delete, redis_get_string,
    redis_set_nx_ex_string, redis_set_string, redis_setex_string, render_tool_result_text,
    utf8_chunks, DEFAULT_MCP_TOOL_RESULT_MAX_CHARS, SKILL_TTL_SECONDS,
};
use log::{info, warn};
use serde_json::{json, Value};

const CHAT_ID_HEADER: &str = "x-openwebui-chat-id";
const DEFAULT_CORE_PROXY_BASE_URL: &str = "http://mcpo-core:8081";
const DEFAULT_AGENT_VM_TIMEOUT_HOURS: f64 = 4.0;
const OVERFLOW_VM_LOCK_TTL_SECONDS: u64 = 30;
const OVERFLOW_VM_LOCK_WAIT_SECONDS: f64 = 10.0;
const OVERFLOW_VM_LOCK_POLL_MILLIS: u64 = 100;

pub async fn maybe_spill_large_tool_response(
    server_id: &str,
    route_name: &str,
    headers: &HeaderMap,
    value: Value,
) -> Value {
    if !overflow_enabled() {
        return value;
    }

    if overflow_exempt_for_server(server_id) {
        return value;
    }

    let rendered = match render_tool_result_text(&value) {
        Ok(rendered) => rendered,
        Err(error) => {
            warn!(
                "[{server_id}] failed to render tool result for overflow detection on '{route_name}': {error:#}"
            );
            return value;
        }
    };

    if rendered.chars().count() <= overflow_max_chars() {
        return value;
    }

    let Some(chat_id) = header_string(headers, CHAT_ID_HEADER) else {
        warn!(
            "[{server_id}] oversized tool result for '{route_name}' could not be spilled because {CHAT_ID_HEADER} was missing"
        );
        return value;
    };

    if chat_id.trim().is_empty() || chat_id.starts_with("local:") {
        return value;
    }

    match spill_large_tool_response(chat_id.as_str(), route_name, rendered.as_str()).await {
        Ok(pointer) => pointer,
        Err(error) => {
            warn!(
                "[{server_id}] failed to spill oversized tool result for '{route_name}': {error:#}"
            );
            value
        }
    }
}

fn overflow_exempt_for_server(server_id: &str) -> bool {
    let bare_id = bare_server_id(server_id);
    bare_id != "web-tools" && is_core_server_config(bare_id)
}

async fn spill_large_tool_response(
    chat_id: &str,
    route_name: &str,
    rendered: &str,
) -> Result<Value> {
    let vm_id = ensure_chat_agent_vm(chat_id).await?;
    let artifact = build_overflow_artifact(route_name, rendered);
    let spill_target = write_spill_file(&vm_id, &artifact.path, rendered).await?;
    ensure_agent_vm_enabled(chat_id)?;

    info!(
        "[overflow] spilled oversized MCP response for chat {chat_id} to {} ({}) chars",
        artifact.path, artifact.char_count
    );

    let mut pointer = artifact.pointer_payload(route_name, &spill_target.vm_id);
    if let Some(object) = pointer.as_object_mut() {
        object.insert("vm_id".to_string(), Value::String(spill_target.vm_id));
        object.insert("path".to_string(), Value::String(spill_target.path));
    }
    Ok(pointer)
}

async fn ensure_chat_agent_vm(chat_id: &str) -> Result<String> {
    let redis_key = format!("agent_vm:{chat_id}");
    if let Some(vm_id) = read_running_chat_vm(&redis_key).await? {
        return Ok(vm_id);
    }

    let lock_key = format!("overflow_agent_vm_lock:{chat_id}");
    let lock_token = format!(
        "{}-{}",
        std::process::id(),
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    );
    let started_at = std::time::Instant::now();

    loop {
        if let Some(vm_id) = read_running_chat_vm(&redis_key).await? {
            return Ok(vm_id);
        }

        if redis_set_nx_ex_string(&lock_key, &lock_token, OVERFLOW_VM_LOCK_TTL_SECONDS)? {
            let result = async {
                if let Some(vm_id) = read_running_chat_vm(&redis_key).await? {
                    return Ok(vm_id);
                }

                let vm_id = create_chat_agent_vm(chat_id).await?;
                redis_set_string(&redis_key, vm_id.as_str())?;
                Ok(vm_id)
            }
            .await;
            let _ = redis_compare_delete(&lock_key, &lock_token);
            return result;
        }

        if started_at.elapsed().as_secs_f64() >= OVERFLOW_VM_LOCK_WAIT_SECONDS {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(
            OVERFLOW_VM_LOCK_POLL_MILLIS,
        ))
        .await;
    }

    create_chat_agent_vm(chat_id).await
}

async fn read_running_chat_vm(redis_key: &str) -> Result<Option<String>> {
    if let Some(vm_id) = redis_get_string(redis_key)? {
        if agent_vm_is_running(&vm_id).await? {
            return Ok(Some(vm_id));
        }
        let _ = redis_delete(redis_key);
    }
    Ok(None)
}

async fn create_chat_agent_vm(chat_id: &str) -> Result<String> {
    let timeout_hours = agent_vm_timeout_hours();
    let response = core_post_json(
        "/agent-vm/agent_vm_create",
        json!({
            "chat_id": chat_id,
            "timeout_hours": timeout_hours,
        }),
    )
    .await?;

    if response.get("success").and_then(Value::as_bool) != Some(true) {
        return Err(anyhow::anyhow!(
            "agent-vm create failed: {}",
            response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown error")
        ));
    }

    response
        .get("vm_id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .context("agent-vm create response missing vm_id")
}

async fn agent_vm_is_running(vm_id: &str) -> Result<bool> {
    let response =
        core_post_json("/agent-vm/agent_vm_get_status", json!({ "vm_id": vm_id })).await?;
    Ok(response.get("status").and_then(Value::as_str) == Some("running"))
}

struct SpillTarget {
    vm_id: String,
    path: String,
}

async fn write_spill_file(vm_id: &str, path: &str, content: &str) -> Result<SpillTarget> {
    let mut wrote_any = false;
    let max_chunk_bytes = overflow_write_chunk_bytes();
    let mut effective_vm_id = vm_id.to_string();
    let mut effective_path = path.to_string();
    for chunk in utf8_chunks(content, max_chunk_bytes) {
        let spill_target =
            write_spill_chunk(&effective_vm_id, &effective_path, chunk, wrote_any).await?;
        effective_vm_id = spill_target.vm_id;
        effective_path = spill_target.path;
        wrote_any = true;
    }

    if !wrote_any {
        let spill_target = write_spill_chunk(&effective_vm_id, &effective_path, "", false).await?;
        effective_vm_id = spill_target.vm_id;
        effective_path = spill_target.path;
    }

    Ok(SpillTarget {
        vm_id: effective_vm_id,
        path: effective_path,
    })
}

async fn write_spill_chunk(
    vm_id: &str,
    path: &str,
    content: &str,
    append: bool,
) -> Result<SpillTarget> {
    let response = core_post_json(
        "/agent-vm/agent_vm_create_file",
        json!({
            "vm_id": vm_id,
            "path": path,
            "content": content,
            "append": append,
        }),
    )
    .await?;
    if response.get("success").and_then(Value::as_bool) == Some(true) {
        return Ok(SpillTarget {
            vm_id: response
                .get("vm_id")
                .and_then(Value::as_str)
                .unwrap_or(vm_id)
                .to_string(),
            path: response
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or(path)
                .to_string(),
        });
    }

    Err(anyhow::anyhow!(
        "agent-vm create_file failed: {}",
        response
            .get("error")
            .or_else(|| response.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("unknown error")
    ))
}

fn ensure_agent_vm_enabled(chat_id: &str) -> Result<()> {
    let redis_key = format!("chat_tools:{chat_id}");
    let mut enabled_tools = redis_get_string(&redis_key)?
        .map(|raw| serde_json::from_str::<Vec<String>>(&raw).unwrap_or_default())
        .unwrap_or_default();
    if !enabled_tools.iter().any(|tool| tool == "server:agent-vm") {
        enabled_tools.push("server:agent-vm".to_string());
    }
    let encoded = serde_json::to_string(&enabled_tools)?;
    redis_setex_string(&redis_key, &encoded, SKILL_TTL_SECONDS)?;
    Ok(())
}

async fn core_post_json(path: &str, payload: Value) -> Result<Value> {
    let url = format!("{}{}", core_proxy_base_url().trim_end_matches('/'), path);
    let response = reqwest::Client::new()
        .post(url.clone())
        .json(&payload)
        .send()
        .await
        .with_context(|| format!("failed to call core MCP route {url}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .with_context(|| format!("failed to read response body from {url}"))?;
    if !status.is_success() {
        return Err(anyhow::anyhow!(
            "core MCP route {url} returned HTTP {status}: {body}"
        ));
    }
    serde_json::from_str::<Value>(&body)
        .with_context(|| format!("core MCP route {url} returned invalid JSON: {body}"))
}

fn header_string(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn overflow_max_chars() -> usize {
    overflow_max_chars_from_env(
        "MCP_TOOL_RESULT_MAX_CHARS",
        DEFAULT_MCP_TOOL_RESULT_MAX_CHARS,
    )
}

fn overflow_enabled() -> bool {
    overflow_enabled_from_env("MCP_TOOL_RESULT_OVERFLOW_ENABLED", true)
}

fn overflow_write_chunk_bytes() -> usize {
    core_mcp_shared::overflow_write_chunk_bytes()
}

#[cfg_attr(not(test), allow(dead_code))]
fn overflow_read_hint(format: &str) -> &'static str {
    core_mcp_shared::overflow_read_hint(format)
}

fn agent_vm_timeout_hours() -> f64 {
    env::var("MCP_OVERFLOW_AGENT_VM_TIMEOUT_HOURS")
        .ok()
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| *value > 0.0)
        .unwrap_or(DEFAULT_AGENT_VM_TIMEOUT_HOURS)
}

fn core_proxy_base_url() -> String {
    env::var("MCPO_CORE_PROXY_BASE_URL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_CORE_PROXY_BASE_URL.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        overflow_enabled, overflow_exempt_for_server, overflow_max_chars, overflow_read_hint,
        utf8_chunks,
    };
    use core_mcp_shared::DEFAULT_MCP_TOOL_RESULT_MAX_CHARS;

    struct EnvGuard {
        previous: Vec<(String, Option<String>)>,
    }

    impl EnvGuard {
        fn set(entries: &[(&str, Option<&str>)]) -> Self {
            let mut previous = Vec::new();
            for (key, value) in entries {
                previous.push(((*key).to_string(), std::env::var(key).ok()));
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
            Self { previous }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (key, value) in self.previous.drain(..) {
                match value {
                    Some(value) => std::env::set_var(&key, value),
                    None => std::env::remove_var(&key),
                }
            }
        }
    }

    #[test]
    fn utf8_chunks_preserves_utf8_boundaries() {
        let chunks = utf8_chunks("a😀bc", 5);
        assert_eq!(chunks, vec!["a😀", "bc"]);
    }

    #[test]
    fn utf8_chunks_handles_single_multibyte_char_larger_than_limit() {
        let chunks = utf8_chunks("😀", 1);
        assert_eq!(chunks, vec!["😀"]);
    }

    #[test]
    fn overflow_max_chars_uses_new_default_and_env_override() {
        let _lock = crate::test_env_lock();
        let _env = EnvGuard::set(&[("MCP_TOOL_RESULT_MAX_CHARS", None)]);
        assert_eq!(overflow_max_chars(), DEFAULT_MCP_TOOL_RESULT_MAX_CHARS);

        let _env = EnvGuard::set(&[("MCP_TOOL_RESULT_MAX_CHARS", Some("4321"))]);
        assert_eq!(overflow_max_chars(), 4321);
    }

    #[test]
    fn overflow_enabled_defaults_true_and_honors_env_override() {
        let _lock = crate::test_env_lock();
        let _env = EnvGuard::set(&[("MCP_TOOL_RESULT_OVERFLOW_ENABLED", None)]);
        assert!(overflow_enabled());

        let _env = EnvGuard::set(&[("MCP_TOOL_RESULT_OVERFLOW_ENABLED", Some("false"))]);
        assert!(!overflow_enabled());
    }

    #[test]
    fn overflow_read_hint_warns_against_dumping_raw_files() {
        let json_hint = overflow_read_hint("json");
        assert!(json_hint.contains("Do not dump the raw overflow file"));
        assert!(json_hint.contains("grep_file"));
        assert!(json_hint.contains("read_fragment"));
        assert!(json_hint.contains("under 2,000 chars"));
        assert!(json_hint.contains("jq"));

        let text_hint = overflow_read_hint("txt");
        assert!(text_hint.contains("Do not dump the raw overflow file"));
        assert!(text_hint.contains("grep_file"));
        assert!(text_hint.contains("read_fragment"));
        assert!(text_hint.contains("under 2,000 chars"));
    }

    #[test]
    fn overflow_exempt_for_core_servers_but_not_web_tools() {
        let _lock = crate::test_env_lock();
        assert!(overflow_exempt_for_server("skills"));
        assert!(overflow_exempt_for_server("server:skills"));
        assert!(!overflow_exempt_for_server("web-tools"));
        assert!(!overflow_exempt_for_server("demo"));
    }
}
