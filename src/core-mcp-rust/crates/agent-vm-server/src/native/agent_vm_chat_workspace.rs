use super::*;
use std::path::Path;
use tokio::time::{sleep, Duration};

const CHAT_WORKSPACE_CONSENT_TRIGGER_TIMEOUT_SECONDS: f64 = 10.0;
const CHAT_WORKSPACE_CONSENT_STATUS_TIMEOUT_SECONDS: f64 = 5.0;
const CHAT_WORKSPACE_CONSENT_POLL_INTERVAL_MILLIS: u64 = 500;
const CHAT_WORKSPACE_CONSENT_DEFAULT_TIMEOUT_SECONDS: u64 = 60 * 60;
const CHAT_WORKSPACE_CONSENT_MIN_TIMEOUT_SECONDS: u64 = 30;
const CHAT_WORKSPACE_CONSENT_MAX_TIMEOUT_SECONDS: u64 = 60 * 60;

fn required_limited_string(value: &Value, field_name: &str, max_length: usize) -> Result<String> {
    let raw = value
        .as_str()
        .with_context(|| format!("{field_name} must be a string"))?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        bail!("{field_name} is required");
    }
    if trimmed.len() > max_length {
        bail!("{field_name} must be {max_length} characters or fewer");
    }
    Ok(trimmed.to_string())
}

fn optional_limited_string(
    value: Option<&Value>,
    field_name: &str,
    max_length: usize,
) -> Result<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let raw = value
        .as_str()
        .with_context(|| format!("{field_name} must be a string"))?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.len() > max_length {
        bail!("{field_name} must be {max_length} characters or fewer");
    }
    Ok(Some(trimmed.to_string()))
}

fn validate_timeout_seconds(arguments: &Map<String, Value>) -> Result<u64> {
    let Some(value) = arguments.get("timeout_seconds") else {
        return Ok(CHAT_WORKSPACE_CONSENT_DEFAULT_TIMEOUT_SECONDS);
    };
    let timeout_seconds = value
        .as_u64()
        .context("timeout_seconds must be a positive integer")?;
    if !(CHAT_WORKSPACE_CONSENT_MIN_TIMEOUT_SECONDS..=CHAT_WORKSPACE_CONSENT_MAX_TIMEOUT_SECONDS)
        .contains(&timeout_seconds)
    {
        bail!(
            "timeout_seconds must be between {CHAT_WORKSPACE_CONSENT_MIN_TIMEOUT_SECONDS} and {CHAT_WORKSPACE_CONSENT_MAX_TIMEOUT_SECONDS}"
        );
    }
    Ok(timeout_seconds)
}

fn is_internal_container_path(raw_host_path: &str) -> bool {
    let normalized = raw_host_path.replace('\\', "/");
    normalized == "/app/mcpo-runtime-homes" || normalized.starts_with("/app/mcpo-runtime-homes/")
}

fn validate_host_path_shape(raw_host_path: &str) -> Result<String> {
    if raw_host_path == "~" || raw_host_path.starts_with("~/") {
        return Ok(raw_host_path.to_string());
    }
    if raw_host_path.starts_with('~') {
        bail!("host_path uses unsupported '~user' expansion");
    }
    if is_internal_container_path(raw_host_path) {
        bail!("host_path points to an internal container path");
    }
    if !Path::new(raw_host_path).is_absolute() {
        bail!("host_path must be an absolute path");
    }
    Ok(raw_host_path.to_string())
}

/// Best-effort: tells the Electron API to dismiss the consent modal, clear the
/// waiting bar, and unlock the composer when this tool call ends without a
/// user response. Failures are ignored — the flow-level timeout in Electron
/// remains the backstop.
async fn cancel_chat_workspace_consent_flow(flow_id: &str, reason: &str) {
    let _ = core_mcp_shared::electron_post_json(
        "/api/cancel-chat-workspace-consent-flow",
        &json!({ "flow_id": flow_id, "reason": reason }),
        CHAT_WORKSPACE_CONSENT_STATUS_TIMEOUT_SECONDS,
    )
    .await;
}

async fn poll_chat_workspace_consent_flow_status(
    flow_id: &str,
    timeout_seconds: u64,
) -> Result<Value> {
    let max_wait = Duration::from_secs(timeout_seconds.saturating_add(30));
    let start = std::time::Instant::now();

    while start.elapsed() <= max_wait {
        let status_payload = match core_mcp_shared::electron_get_json(
            &format!("/api/chat-workspace-consent-flow-status/{flow_id}"),
            CHAT_WORKSPACE_CONSENT_STATUS_TIMEOUT_SECONDS,
        )
        .await
        {
            Ok(payload) => payload,
            Err(error) => {
                cancel_chat_workspace_consent_flow(flow_id, "poll_error").await;
                return success_text(json!({
                    "success": false,
                    "status": "error",
                    "error": format!("Failed to poll the chat-workspace consent flow: {error}"),
                }))
            }
        };

        if !status_payload
            .get("success")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            cancel_chat_workspace_consent_flow(flow_id, "status_error").await;
            return success_text(status_payload);
        }

        match status_payload.get("status").and_then(Value::as_str) {
            Some("completed") => {
                return success_text(status_payload.get("result").cloned().unwrap_or_else(|| {
                    json!({
                        "success": false,
                        "status": "error",
                        "error": "Electron API returned a completed chat-workspace consent flow without a result",
                    })
                }));
            }
            Some("in_progress") => {
                sleep(Duration::from_millis(
                    CHAT_WORKSPACE_CONSENT_POLL_INTERVAL_MILLIS,
                ))
                .await;
            }
            other => {
                let other = other.unwrap_or("missing").to_string();
                cancel_chat_workspace_consent_flow(flow_id, "unexpected_status").await;
                return success_text(json!({
                    "success": false,
                    "status": "error",
                    "flow_id": flow_id,
                    "error": format!(
                        "Unexpected chat-workspace consent flow status from Electron API: {other}"
                    ),
                }));
            }
        }
    }

    cancel_chat_workspace_consent_flow(flow_id, "tool_timeout").await;
    success_text(json!({
        "success": false,
        "status": "timeout",
        "flow_id": flow_id,
        "error": "Timed out waiting for the chat-workspace consent flow to complete",
    }))
}

pub async fn handle_set_chat_workspace(arguments: &Map<String, Value>) -> Result<Value> {
    let chat_id = required_limited_string(
        arguments.get("chat_id").context("chat_id is required")?,
        "chat_id",
        120,
    )?;
    let raw_host_path = required_limited_string(
        arguments
            .get("host_path")
            .context("host_path is required")?,
        "host_path",
        4096,
    )?;
    let host_path = validate_host_path_shape(&raw_host_path)?;
    let preamble = optional_limited_string(arguments.get("preamble"), "preamble", 4000)?;
    let timeout_seconds = validate_timeout_seconds(arguments)?;

    let trigger_payload = match core_mcp_shared::electron_post_json(
        "/api/trigger-chat-workspace-consent-flow",
        &json!({
            "chat_id": chat_id,
            "host_path": host_path,
            "preamble": preamble,
            "timeout_seconds": timeout_seconds,
        }),
        CHAT_WORKSPACE_CONSENT_TRIGGER_TIMEOUT_SECONDS,
    )
    .await
    {
        Ok(payload) => payload,
        Err(error) => {
            return success_text(json!({
                "success": false,
                "status": "error",
                "error": format!("Failed to start the chat-workspace consent flow: {error}"),
            }))
        }
    };

    if !trigger_payload
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return success_text(trigger_payload);
    }

    let flow_id = trigger_payload
        .get("flow_id")
        .and_then(Value::as_str)
        .context("Electron API did not return flow_id for set_chat_workspace")?;

    poll_chat_workspace_consent_flow_status(flow_id, timeout_seconds).await
}
