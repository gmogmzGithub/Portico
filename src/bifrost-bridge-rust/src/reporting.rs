use anyhow::Result;
use axum::http::HeaderMap;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::fs;

const CHAT_ID_HEADER: &str = "x-openwebui-chat-id";
const SESSION_ID_HEADER: &str = "x-openwebui-session-id";
const MESSAGE_ID_HEADER: &str = "x-openwebui-message-id";
const DEBUG_REQUEST_ID_HEADER: &str = "x-openwebui-debug-request-id";
const UPSTREAM_REQUEST_ID_HEADER: &str = "x-openwebui-upstream-request-id";
const PROMPT_SUBMITTED_AT_MS_HEADER: &str = "x-openwebui-prompt-submitted-at-ms";
const REQUEST_PHASE_HEADER: &str = "x-openwebui-request-phase";
const FOLLOWUP_INDEX_HEADER: &str = "x-openwebui-followup-index";
const OUTER_MESSAGE_ID_HEADER: &str = "x-openwebui-outer-message-id";
const TRIGGER_MESSAGE_ID_HEADER: &str = "x-openwebui-trigger-message-id";
const TRANSCRIPT_ANCHOR_KIND_HEADER: &str = "x-openwebui-transcript-anchor-kind";
const TRANSCRIPT_ANCHOR_MESSAGE_ID_HEADER: &str = "x-openwebui-transcript-anchor-message-id";
const TRANSCRIPT_ANCHOR_TOOL_BLOCK_INDEX_HEADER: &str =
    "x-openwebui-transcript-anchor-tool-block-index";
const FORWARDED_REPORTING_HEADER_PREFIX: &str = "x-bf-eh-x-openwebui-";
const TRACEPARENT_HEADER: &str = "traceparent";
const TRACESTATE_HEADER: &str = "tracestate";
const BAGGAGE_HEADER: &str = "baggage";
const SAFE_UPSTREAM_RESPONSE_HEADERS: &[&str] = &[
    "content-type",
    "content-length",
    "transfer-encoding",
    "content-encoding",
    "server",
    "via",
    "x-request-id",
    "x-amzn-requestid",
    "retry-after",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReportingContext {
    pub chat_id: String,
    pub session_id: Option<String>,
    pub message_id: String,
    pub nested_provider_forwarded: bool,
    pub debug_request_id: Option<String>,
    pub upstream_request_id: Option<String>,
    pub prompt_submitted_at_ms: Option<u64>,
    pub request_phase: Option<String>,
    pub followup_index: Option<i64>,
    pub outer_message_id: Option<String>,
    pub trigger_message_id: Option<String>,
    pub transcript_anchor_kind: Option<String>,
    pub transcript_anchor_message_id: Option<String>,
    pub transcript_anchor_tool_block_index: Option<i64>,
    pub traceparent: Option<String>,
    pub tracestate: Option<String>,
    pub baggage: Option<String>,
}

impl ReportingContext {
    pub fn turn_id(&self) -> String {
        format!("{}:{}", self.chat_id, self.message_id)
    }

    pub fn tracestate_present(&self) -> bool {
        self.tracestate.is_some()
    }

    pub fn baggage_present(&self) -> bool {
        self.baggage.is_some()
    }

    pub fn is_forwarded_nested_provider_request(&self) -> bool {
        self.nested_provider_forwarded
    }
}

fn header_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn has_forwarded_reporting_headers(headers: &HeaderMap) -> bool {
    headers
        .keys()
        .any(|name| name.as_str().starts_with(FORWARDED_REPORTING_HEADER_PREFIX))
}

fn metadata_value(payload: &Value, key: &str) -> Option<String> {
    payload
        .get("metadata")
        .and_then(Value::as_object)
        .and_then(|metadata| metadata.get(key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn metadata_i64_value(payload: &Value, key: &str) -> Option<i64> {
    payload
        .get("metadata")
        .and_then(Value::as_object)
        .and_then(|metadata| metadata.get(key))
        .and_then(|value| {
            value.as_i64().or_else(|| {
                value
                    .as_str()
                    .and_then(|text| text.trim().parse::<i64>().ok())
            })
        })
}

fn metadata_u64_value(payload: &Value, key: &str) -> Option<u64> {
    payload
        .get("metadata")
        .and_then(Value::as_object)
        .and_then(|metadata| metadata.get(key))
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_i64().and_then(|number| u64::try_from(number).ok()))
                .or_else(|| {
                    value
                        .as_str()
                        .and_then(|text| text.trim().parse::<u64>().ok())
                })
        })
}

fn current_time_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn atomic_temp_path(file_path: &Path) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let file_name = format!(
        ".{}.{}.tmp",
        file_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("report"),
        nanos
    );
    file_path.with_file_name(file_name)
}

fn has_meaningful_usage(usage: &Value) -> bool {
    usage.as_object().is_some_and(|object| {
        for key in [
            "prompt_tokens",
            "completion_tokens",
            "total_tokens",
            "cached_tokens",
            "cachedContentTokenCount",
            "cached_content_token_count",
            "cache_read_input_tokens",
            "cache_creation_input_tokens",
            "cache_write_input_tokens",
            "input_tokens",
            "output_tokens",
            "cost",
        ] {
            if object.get(key).and_then(Value::as_i64).unwrap_or_default() > 0 {
                return true;
            }
            if object.get(key).and_then(Value::as_f64).unwrap_or_default() > 0.0 {
                return true;
            }
        }
        false
    })
}

fn serialize_headers(headers: &HeaderMap) -> BTreeMap<String, String> {
    headers
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| (name.as_str().to_ascii_lowercase(), value.to_string()))
        })
        .collect()
}

pub fn serialize_upstream_response_headers(headers: &HeaderMap) -> BTreeMap<String, String> {
    let serialized = serialize_headers(headers);
    SAFE_UPSTREAM_RESPONSE_HEADERS
        .iter()
        .filter_map(|name| {
            serialized
                .get(*name)
                .map(|value| ((*name).to_string(), value.clone()))
        })
        .collect()
}

pub fn extract_reporting_context(
    headers: &HeaderMap,
    payload: Option<&Value>,
) -> Option<ReportingContext> {
    let chat_id = header_value(headers, CHAT_ID_HEADER)
        .or_else(|| payload.and_then(|value| metadata_value(value, "chat_id")))?;
    let message_id = header_value(headers, MESSAGE_ID_HEADER)
        .or_else(|| payload.and_then(|value| metadata_value(value, "message_id")))?;
    let nested_provider_forwarded = has_forwarded_reporting_headers(headers);
    let session_id = header_value(headers, SESSION_ID_HEADER)
        .or_else(|| payload.and_then(|value| metadata_value(value, "session_id")));
    let debug_request_id = header_value(headers, DEBUG_REQUEST_ID_HEADER)
        .or_else(|| payload.and_then(|value| metadata_value(value, "debug_request_id")));
    let upstream_request_id = header_value(headers, UPSTREAM_REQUEST_ID_HEADER)
        .or_else(|| payload.and_then(|value| metadata_value(value, "upstream_request_id")));
    let prompt_submitted_at_ms = header_value(headers, PROMPT_SUBMITTED_AT_MS_HEADER)
        .and_then(|value| value.parse::<u64>().ok())
        .or_else(|| payload.and_then(|value| metadata_u64_value(value, "prompt_submitted_at_ms")));
    let request_phase = header_value(headers, REQUEST_PHASE_HEADER)
        .or_else(|| payload.and_then(|value| metadata_value(value, "request_phase")));
    let followup_index = header_value(headers, FOLLOWUP_INDEX_HEADER)
        .and_then(|value| value.parse::<i64>().ok())
        .or_else(|| payload.and_then(|value| metadata_i64_value(value, "followup_index")));
    let outer_message_id = header_value(headers, OUTER_MESSAGE_ID_HEADER)
        .or_else(|| payload.and_then(|value| metadata_value(value, "outer_message_id")));
    let trigger_message_id = header_value(headers, TRIGGER_MESSAGE_ID_HEADER)
        .or_else(|| payload.and_then(|value| metadata_value(value, "trigger_message_id")));
    let transcript_anchor_kind = header_value(headers, TRANSCRIPT_ANCHOR_KIND_HEADER)
        .or_else(|| payload.and_then(|value| metadata_value(value, "transcript_anchor_kind")));
    let transcript_anchor_message_id = header_value(headers, TRANSCRIPT_ANCHOR_MESSAGE_ID_HEADER)
        .or_else(|| {
            payload.and_then(|value| metadata_value(value, "transcript_anchor_message_id"))
        });
    let transcript_anchor_tool_block_index =
        header_value(headers, TRANSCRIPT_ANCHOR_TOOL_BLOCK_INDEX_HEADER)
            .and_then(|value| value.parse::<i64>().ok())
            .or_else(|| {
                payload.and_then(|value| {
                    metadata_i64_value(value, "transcript_anchor_tool_block_index")
                })
            });
    let traceparent = header_value(headers, TRACEPARENT_HEADER);
    let tracestate = header_value(headers, TRACESTATE_HEADER);
    let baggage = header_value(headers, BAGGAGE_HEADER);

    Some(ReportingContext {
        chat_id,
        session_id,
        message_id,
        nested_provider_forwarded,
        debug_request_id,
        upstream_request_id,
        prompt_submitted_at_ms,
        request_phase,
        followup_index,
        outer_message_id,
        trigger_message_id,
        transcript_anchor_kind,
        transcript_anchor_message_id,
        transcript_anchor_tool_block_index,
        traceparent,
        tracestate,
        baggage,
    })
}

pub fn extract_usage_from_sse_bytes(bytes: &[u8]) -> Option<Value> {
    let text = std::str::from_utf8(bytes).ok()?;
    for line in text.lines() {
        let Some(payload_text) = line.strip_prefix("data: ") else {
            continue;
        };
        if payload_text.trim().is_empty() || payload_text.trim() == "[DONE]" {
            continue;
        }
        let value: Value = serde_json::from_str(payload_text).ok()?;
        let Some(usage) = value.get("usage") else {
            continue;
        };
        if has_meaningful_usage(usage) {
            return Some(usage.clone());
        }
    }
    None
}

pub fn build_usage_event(
    context: &ReportingContext,
    call_id: &str,
    model_id: &str,
    model_name: &str,
    usage: &Value,
    context_tokens_estimate: Option<i64>,
) -> Option<Value> {
    if !has_meaningful_usage(usage) {
        return None;
    }

    let turn_id = context.turn_id();

    let mut event = json!({
        "version": 2,
        "source": "bifrost-bridge",
        "eventId": format!("{turn_id}:{call_id}"),
        "turnId": turn_id,
        "callId": call_id,
        "chatId": context.chat_id,
        "sessionId": context.session_id,
        "messageId": context.message_id,
        "debugRequestId": context.debug_request_id,
        "upstreamRequestId": context.upstream_request_id,
        "promptSubmittedAtMs": context.prompt_submitted_at_ms,
        "requestPhase": context.request_phase,
        "followupIndex": context.followup_index,
        "outerMessageId": context.outer_message_id,
        "triggerMessageId": context.trigger_message_id,
        "transcriptAnchorKind": context.transcript_anchor_kind,
        "transcriptAnchorMessageId": context.transcript_anchor_message_id,
        "transcriptAnchorToolBlockIndex": context.transcript_anchor_tool_block_index,
        "traceparent": context.traceparent,
        "tracestatePresent": context.tracestate_present(),
        "baggagePresent": context.baggage_present(),
        "modelId": model_id,
        "modelName": model_name,
        "completedAt": current_time_millis(),
        "usage": usage,
    });
    // True context occupancy of this round-trip. Distinct from billed
    // prompt_tokens, which for pro-mode reasoning models aggregates hidden
    // internal passes. Numeric size only — request payload content must
    // never be persisted here.
    if let (Some(object), Some(estimate)) = (event.as_object_mut(), context_tokens_estimate) {
        if estimate > 0 {
            let clamped = clamped_context_estimate(usage, estimate);
            object.insert("contextTokensEstimate".to_string(), json!(clamped));
        }
    }
    Some(event)
}

/// Clamp a request-side context estimate against the billed prompt tokens
/// in a usage payload. A chars/4 estimate can only overshoot what the
/// provider billed for the prompt (binary payloads inflate character counts
/// past their billed vision tokens); billed above estimate is the
/// legitimate pro-mode hidden-pass case. Usage without billed prompt
/// figures (e.g. a completion-only chunk) keeps the estimate.
pub fn clamped_context_estimate(usage: &Value, estimate: i64) -> i64 {
    let billed = billed_prompt_tokens(usage);
    if billed > 0 {
        estimate.min(billed)
    } else {
        estimate
    }
}

/// Rewrite a single OpenAI-format SSE chunk so its usage object carries
/// `context_tokens` — the clamped occupancy estimate — letting live
/// streaming consumers render true occupancy instead of billed prompt
/// tokens (pro-mode reasoning bills hidden internal passes). Returns None
/// when the chunk is not a lone `data: {json}` frame with meaningful
/// usage; callers keep the original bytes in that case.
pub fn inject_context_tokens_into_sse_usage(bytes: &[u8], estimate: Option<i64>) -> Option<Vec<u8>> {
    let estimate = estimate.filter(|value| *value > 0)?;
    let text = std::str::from_utf8(bytes).ok()?;
    let payload_text = text.strip_prefix("data: ")?.trim_end();
    if payload_text.is_empty() || payload_text == "[DONE]" || payload_text.contains('\n') {
        return None;
    }
    let mut chunk: Value = serde_json::from_str(payload_text).ok()?;
    let usage = chunk.get("usage")?;
    if !has_meaningful_usage(usage) {
        return None;
    }
    let clamped = clamped_context_estimate(usage, estimate);
    chunk
        .get_mut("usage")
        .and_then(Value::as_object_mut)?
        .insert("context_tokens".to_string(), json!(clamped));
    Some(format!("data: {chunk}\n\n").into_bytes())
}

/// Prompt-side billed tokens across provider usage shapes: the
/// OpenAI/Bifrost-translated prompt_tokens is inclusive of cache traffic;
/// the Anthropic-native shape splits input from cache reads/writes.
fn billed_prompt_tokens(usage: &Value) -> i64 {
    let read = |key: &str| {
        usage
            .get(key)
            .and_then(|value| {
                value
                    .as_i64()
                    .or_else(|| value.as_f64().map(|value| value as i64))
            })
            .unwrap_or(0)
            .max(0)
    };
    let prompt_tokens = read("prompt_tokens");
    if prompt_tokens > 0 {
        return prompt_tokens;
    }
    read("input_tokens") + read("cache_read_input_tokens") + read("cache_creation_input_tokens")
}

pub async fn write_usage_event(reporting_dir: &Path, event: &Value) -> Result<PathBuf> {
    let events_dir = reporting_dir.join("events");
    fs::create_dir_all(&events_dir).await?;

    let event_id = event
        .get("eventId")
        .and_then(Value::as_str)
        .unwrap_or("unknown-event");
    let digest = hex::encode(Sha256::digest(event_id.as_bytes()));
    let file_path = events_dir.join(format!("{digest}.json"));
    let temp_path = atomic_temp_path(&file_path);
    let body = format!("{}\n", serde_json::to_string_pretty(event)?);

    fs::write(&temp_path, body).await?;
    fs::rename(&temp_path, &file_path).await?;

    Ok(file_path)
}

pub async fn remove_legacy_request_payloads(reporting_dir: &Path) -> Result<()> {
    let payloads_dir = reporting_dir.join("payloads");
    let metadata = match fs::symlink_metadata(&payloads_dir).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };

    if metadata.file_type().is_dir() {
        fs::remove_dir_all(payloads_dir).await?;
    } else {
        fs::remove_file(payloads_dir).await?;
    }
    Ok(())
}

pub fn build_stream_failure_event(
    context: &ReportingContext,
    call_id: &str,
    endpoint: &str,
    model_name: &str,
    upstream_response_headers: &BTreeMap<String, String>,
    failure: &Value,
    request_shape: &Value,
    stream_progress: &Value,
) -> Value {
    let turn_id = context.turn_id();
    json!({
        "version": 2,
        "source": "bifrost-bridge",
        "eventType": "llm_stream_failure",
        "eventId": format!("{turn_id}:{call_id}:{endpoint}:stream-failure"),
        "turnId": turn_id,
        "callId": call_id,
        "chatId": context.chat_id,
        "sessionId": context.session_id,
        "messageId": context.message_id,
        "debugRequestId": context.debug_request_id,
        "upstreamRequestId": context.upstream_request_id,
        "promptSubmittedAtMs": context.prompt_submitted_at_ms,
        "requestPhase": context.request_phase,
        "followupIndex": context.followup_index,
        "outerMessageId": context.outer_message_id,
        "triggerMessageId": context.trigger_message_id,
        "transcriptAnchorKind": context.transcript_anchor_kind,
        "transcriptAnchorMessageId": context.transcript_anchor_message_id,
        "transcriptAnchorToolBlockIndex": context.transcript_anchor_tool_block_index,
        "traceparent": context.traceparent,
        "tracestatePresent": context.tracestate_present(),
        "baggagePresent": context.baggage_present(),
        "modelName": model_name,
        "endpoint": endpoint,
        "timestamp": current_time_millis(),
        "upstreamResponseHeaders": upstream_response_headers,
        "failure": failure,
        "requestShape": request_shape,
        "streamProgress": stream_progress,
    })
}

pub async fn write_stream_failure_event(reporting_dir: &Path, event: &Value) -> Result<PathBuf> {
    let errors_dir = reporting_dir.join("errors");
    fs::create_dir_all(&errors_dir).await?;

    let event_id = event
        .get("eventId")
        .and_then(Value::as_str)
        .unwrap_or("unknown-stream-failure");
    let digest = hex::encode(Sha256::digest(event_id.as_bytes()));
    let file_path = errors_dir.join(format!("{digest}.json"));
    let temp_path = atomic_temp_path(&file_path);
    let body = format!("{}\n", serde_json::to_string_pretty(event)?);

    fs::write(&temp_path, body).await?;
    fs::rename(&temp_path, &file_path).await?;

    Ok(file_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderMap, HeaderValue};
    use tempfile::tempdir;

    fn sample_reporting_context() -> ReportingContext {
        ReportingContext {
            chat_id: "chat-1".to_string(),
            session_id: Some("session-1".to_string()),
            message_id: "msg-1".to_string(),
            nested_provider_forwarded: false,
            debug_request_id: Some("dbg-1".to_string()),
            upstream_request_id: Some("upstream-1".to_string()),
            prompt_submitted_at_ms: Some(1_740_000_000_123),
            request_phase: Some("tool_followup".to_string()),
            followup_index: Some(1),
            outer_message_id: Some("assistant-1".to_string()),
            trigger_message_id: Some("user-1".to_string()),
            transcript_anchor_kind: Some("assistant_tool_block".to_string()),
            transcript_anchor_message_id: Some("msg-1".to_string()),
            transcript_anchor_tool_block_index: Some(1),
            traceparent: Some(
                "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01".to_string(),
            ),
            tracestate: Some("vendor=value".to_string()),
            baggage: Some("foo=bar".to_string()),
        }
    }

    #[test]
    fn extract_reporting_context_prefers_headers_and_requires_chat_and_message_ids() {
        let mut headers = HeaderMap::new();
        headers.insert(CHAT_ID_HEADER, HeaderValue::from_static("chat-123"));
        headers.insert(SESSION_ID_HEADER, HeaderValue::from_static("session-123"));
        headers.insert(MESSAGE_ID_HEADER, HeaderValue::from_static("msg-123"));

        let context = extract_reporting_context(&headers, None).expect("context");
        assert_eq!(
            context,
            ReportingContext {
                chat_id: "chat-123".to_string(),
                session_id: Some("session-123".to_string()),
                message_id: "msg-123".to_string(),
                nested_provider_forwarded: false,
                debug_request_id: None,
                upstream_request_id: None,
                prompt_submitted_at_ms: None,
                request_phase: None,
                followup_index: None,
                outer_message_id: None,
                trigger_message_id: None,
                transcript_anchor_kind: None,
                transcript_anchor_message_id: None,
                transcript_anchor_tool_block_index: None,
                traceparent: None,
                tracestate: None,
                baggage: None,
            }
        );

        let mut missing = HeaderMap::new();
        missing.insert(CHAT_ID_HEADER, HeaderValue::from_static("chat-123"));
        assert!(extract_reporting_context(&missing, None).is_none());
    }

    #[test]
    fn extract_reporting_context_marks_forwarded_nested_provider_requests() {
        let mut headers = HeaderMap::new();
        headers.insert(CHAT_ID_HEADER, HeaderValue::from_static("chat-forwarded"));
        headers.insert(MESSAGE_ID_HEADER, HeaderValue::from_static("msg-forwarded"));
        headers.insert(
            "x-bf-eh-x-openwebui-chat-id",
            HeaderValue::from_static("chat-forwarded"),
        );

        let context = extract_reporting_context(&headers, None).expect("context");
        assert!(context.is_forwarded_nested_provider_request());
    }

    #[test]
    fn extract_reporting_context_falls_back_to_payload_metadata() {
        let payload = json!({
            "metadata": {
                "chat_id": "chat-456",
                "session_id": "session-456",
                "message_id": "msg-456",
                "debug_request_id": "dbg-456",
                "trigger_message_id": "user-456",
                "transcript_anchor_kind": "assistant_tool_block",
                "transcript_anchor_message_id": "msg-456",
                "transcript_anchor_tool_block_index": 2
            }
        });

        let context =
            extract_reporting_context(&HeaderMap::new(), Some(&payload)).expect("context");
        assert_eq!(context.chat_id, "chat-456");
        assert_eq!(context.session_id.as_deref(), Some("session-456"));
        assert_eq!(context.message_id, "msg-456");
        assert_eq!(context.debug_request_id.as_deref(), Some("dbg-456"));
        assert_eq!(context.upstream_request_id, None);
        assert_eq!(context.prompt_submitted_at_ms, None);
        assert_eq!(context.request_phase, None);
        assert_eq!(context.followup_index, None);
        assert_eq!(context.outer_message_id, None);
        assert_eq!(context.trigger_message_id.as_deref(), Some("user-456"));
        assert_eq!(
            context.transcript_anchor_kind.as_deref(),
            Some("assistant_tool_block")
        );
        assert_eq!(
            context.transcript_anchor_message_id.as_deref(),
            Some("msg-456")
        );
        assert_eq!(context.transcript_anchor_tool_block_index, Some(2));
        assert_eq!(context.traceparent, None);
        assert_eq!(context.tracestate, None);
        assert_eq!(context.baggage, None);
    }

    #[test]
    fn extract_reporting_context_reads_prompt_timestamp_and_trace_headers() {
        let mut headers = HeaderMap::new();
        headers.insert(CHAT_ID_HEADER, HeaderValue::from_static("chat-789"));
        headers.insert(MESSAGE_ID_HEADER, HeaderValue::from_static("msg-789"));
        headers.insert(
            PROMPT_SUBMITTED_AT_MS_HEADER,
            HeaderValue::from_static("1740000000456"),
        );
        headers.insert(
            TRACEPARENT_HEADER,
            HeaderValue::from_static("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"),
        );
        headers.insert(TRACESTATE_HEADER, HeaderValue::from_static("vendor=value"));
        headers.insert(BAGGAGE_HEADER, HeaderValue::from_static("foo=bar"));

        let context = extract_reporting_context(&headers, None).expect("context");
        assert_eq!(context.prompt_submitted_at_ms, Some(1_740_000_000_456));
        assert!(context.tracestate_present());
        assert!(context.baggage_present());
        assert_eq!(
            context.traceparent.as_deref(),
            Some("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
        );
    }

    #[test]
    fn extract_usage_from_sse_bytes_reads_openai_and_anthropic_shapes() {
        let openai = b"data: {\"id\":\"chatcmpl_1\",\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":2}}\n\n";
        assert_eq!(
            extract_usage_from_sse_bytes(openai).unwrap(),
            json!({"prompt_tokens":10,"completion_tokens":2})
        );

        let anthropic = b"event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"input_tokens\":12,\"output_tokens\":3}}\n\n";
        assert_eq!(
            extract_usage_from_sse_bytes(anthropic).unwrap(),
            json!({"input_tokens":12,"output_tokens":3})
        );
    }

    #[test]
    fn build_usage_event_includes_turn_and_call_ids() {
        let context = sample_reporting_context();

        let event = build_usage_event(
            &context,
            "call-1",
            "GPT-5.4",
            "GPT-5.4",
            &json!({"prompt_tokens": 10, "completion_tokens": 2}),
            None,
        )
        .expect("event");

        assert_eq!(event["turnId"], json!("chat-1:msg-1"));
        assert_eq!(event["callId"], json!("call-1"));
        assert_eq!(event["eventId"], json!("chat-1:msg-1:call-1"));
        assert_eq!(event["upstreamRequestId"], json!("upstream-1"));
        assert_eq!(event["requestPhase"], json!("tool_followup"));
        assert_eq!(event["followupIndex"], json!(1));
        assert_eq!(event["outerMessageId"], json!("assistant-1"));
        assert_eq!(event["triggerMessageId"], json!("user-1"));
        assert_eq!(event["transcriptAnchorKind"], json!("assistant_tool_block"));
        assert_eq!(event["transcriptAnchorMessageId"], json!("msg-1"));
        assert_eq!(event["transcriptAnchorToolBlockIndex"], json!(1));
        assert_eq!(event["promptSubmittedAtMs"], json!(1_740_000_000_123u64));
        assert_eq!(
            event["traceparent"],
            json!("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
        );
        assert_eq!(event["tracestatePresent"], json!(true));
        assert_eq!(event["baggagePresent"], json!(true));
        assert!(event.get("contextTokensEstimate").is_none());
    }

    #[test]
    fn build_usage_event_carries_context_tokens_estimate_when_positive() {
        let context = sample_reporting_context();
        let usage = json!({"prompt_tokens": 913_410, "completion_tokens": 2});

        let event = build_usage_event(&context, "call-1", "m", "m", &usage, Some(61_234))
            .expect("event");
        assert_eq!(event["contextTokensEstimate"], json!(61_234));

        let event = build_usage_event(&context, "call-1", "m", "m", &usage, Some(0))
            .expect("event");
        assert!(event.get("contextTokensEstimate").is_none());

        let event = build_usage_event(&context, "call-1", "m", "m", &usage, None)
            .expect("event");
        assert!(event.get("contextTokensEstimate").is_none());
    }

    #[test]
    fn build_usage_event_clamps_context_estimate_to_billed_prompt_tokens() {
        let context = sample_reporting_context();

        // Image-inflated estimate: billed prompt is the tighter occupancy.
        let usage = json!({"prompt_tokens": 82_349, "completion_tokens": 2});
        let event = build_usage_event(&context, "call-1", "m", "m", &usage, Some(369_611))
            .expect("event");
        assert_eq!(event["contextTokensEstimate"], json!(82_349));

        // Pro-mode hidden passes: billed above estimate keeps the estimate.
        let usage = json!({"prompt_tokens": 913_410, "completion_tokens": 2});
        let event = build_usage_event(&context, "call-1", "m", "m", &usage, Some(61_234))
            .expect("event");
        assert_eq!(event["contextTokensEstimate"], json!(61_234));

        // Meaningful usage without billed prompt figures keeps the estimate.
        let usage = json!({"completion_tokens": 7});
        let event = build_usage_event(&context, "call-1", "m", "m", &usage, Some(4_321))
            .expect("event");
        assert_eq!(event["contextTokensEstimate"], json!(4_321));

        // Anthropic-native shape clamps on input + cache reads + writes.
        let usage = json!({
            "input_tokens": 2,
            "cache_read_input_tokens": 40_000,
            "cache_creation_input_tokens": 10_000
        });
        let event = build_usage_event(&context, "call-1", "m", "m", &usage, Some(90_000))
            .expect("event");
        assert_eq!(event["contextTokensEstimate"], json!(50_002));
    }

    #[test]
    fn inject_context_tokens_rewrites_meaningful_usage_chunks_only() {
        // Pro-mode: billed above estimate -> estimate rides the usage chunk.
        let chunk = b"data: {\"id\":\"c1\",\"usage\":{\"prompt_tokens\":913410,\"completion_tokens\":2}}\n\n";
        let rewritten = inject_context_tokens_into_sse_usage(chunk, Some(61_234)).expect("rewrite");
        let value: Value =
            serde_json::from_str(std::str::from_utf8(&rewritten).unwrap().strip_prefix("data: ").unwrap().trim_end())
                .unwrap();
        assert_eq!(value["usage"]["context_tokens"], json!(61_234));
        assert_eq!(value["usage"]["prompt_tokens"], json!(913_410));
        assert!(std::str::from_utf8(&rewritten).unwrap().ends_with("\n\n"));

        // Image-inflated estimate clamps to billed.
        let chunk = b"data: {\"usage\":{\"prompt_tokens\":82349,\"completion_tokens\":75}}\n\n";
        let rewritten = inject_context_tokens_into_sse_usage(chunk, Some(369_611)).expect("rewrite");
        assert!(std::str::from_utf8(&rewritten).unwrap().contains("\"context_tokens\":82349"));

        // Non-usage, [DONE], missing estimate, and empty-usage chunks pass through untouched.
        assert!(inject_context_tokens_into_sse_usage(b"data: {\"id\":\"c1\"}\n\n", Some(10)).is_none());
        assert!(inject_context_tokens_into_sse_usage(b"data: [DONE]\n\n", Some(10)).is_none());
        assert!(inject_context_tokens_into_sse_usage(chunk, None).is_none());
        assert!(inject_context_tokens_into_sse_usage(chunk, Some(0)).is_none());
        assert!(
            inject_context_tokens_into_sse_usage(b"data: {\"usage\":{\"prompt_tokens\":0}}\n\n", Some(10))
                .is_none()
        );
    }

    #[tokio::test]
    async fn write_usage_event_writes_deterministic_event_file() {
        let temp = tempdir().unwrap();
        let event = json!({
            "eventId": "chat-1:msg-1:call-1",
            "chatId": "chat-1",
            "messageId": "msg-1",
            "modelId": "Atlas Opus 4.6",
            "usage": { "prompt_tokens": 10 }
        });

        let first_path = write_usage_event(temp.path(), &event).await.unwrap();
        let second_path = write_usage_event(temp.path(), &event).await.unwrap();

        assert_eq!(first_path, second_path);
        let body = fs::read_to_string(first_path).await.unwrap();
        assert!(body.contains("\"eventId\": \"chat-1:msg-1:call-1\""));
    }

    #[tokio::test]
    async fn remove_legacy_request_payloads_deletes_only_payload_artifacts() {
        let temp = tempdir().unwrap();
        fs::create_dir_all(temp.path().join("payloads/nested"))
            .await
            .unwrap();
        fs::write(temp.path().join("payloads/request.json"), b"not-json")
            .await
            .unwrap();
        fs::write(temp.path().join("payloads/.request.tmp"), b"partial")
            .await
            .unwrap();
        fs::write(temp.path().join("payloads/nested/request.json"), b"legacy")
            .await
            .unwrap();
        for stream in ["events", "errors", "snapshots"] {
            fs::create_dir_all(temp.path().join(stream)).await.unwrap();
            fs::write(temp.path().join(stream).join("keep.json"), b"safe")
                .await
                .unwrap();
        }

        remove_legacy_request_payloads(temp.path()).await.unwrap();

        assert!(!temp.path().join("payloads").exists());
        for stream in ["events", "errors", "snapshots"] {
            assert!(temp.path().join(stream).join("keep.json").exists());
        }
        remove_legacy_request_payloads(temp.path()).await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn remove_legacy_request_payloads_unlinks_symlink_without_following_it() {
        use std::os::unix::fs::symlink;

        let temp = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("keep.json"), b"safe")
            .await
            .unwrap();
        symlink(outside.path(), temp.path().join("payloads")).unwrap();

        remove_legacy_request_payloads(temp.path()).await.unwrap();

        assert!(!temp.path().join("payloads").exists());
        assert!(outside.path().join("keep.json").exists());
    }

    #[test]
    fn serialize_upstream_response_headers_only_keeps_safe_subset() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "content-type",
            HeaderValue::from_static("text/event-stream"),
        );
        headers.insert("content-encoding", HeaderValue::from_static("gzip"));
        headers.insert("x-request-id", HeaderValue::from_static("req-123"));
        headers.insert("authorization", HeaderValue::from_static("Bearer secret"));

        let serialized = serialize_upstream_response_headers(&headers);
        assert_eq!(
            serialized.get("content-type"),
            Some(&"text/event-stream".to_string())
        );
        assert_eq!(
            serialized.get("content-encoding"),
            Some(&"gzip".to_string())
        );
        assert_eq!(serialized.get("x-request-id"), Some(&"req-123".to_string()));
        assert!(!serialized.contains_key("authorization"));
    }

    #[tokio::test]
    async fn write_stream_failure_event_persists_header_snapshot_and_failure_details() {
        let temp = tempdir().unwrap();
        let context = sample_reporting_context();
        let event = build_stream_failure_event(
            &context,
            "call-1",
            "bedrock-converse",
            "Atlas Opus 4.6",
            &BTreeMap::from([
                ("content-type".to_string(), "text/event-stream".to_string()),
                ("content-encoding".to_string(), "gzip".to_string()),
            ]),
            &json!({
                "rawError": "error decoding response body",
                "isDecode": true,
                "isBody": true,
            }),
            &json!({
                "messageCount": 3,
                "reasoningSignatureCount": 1,
            }),
            &json!({
                "streamStage": "after_tool_input_started",
                "rawChunkCount": 457,
            }),
        );

        let path = write_stream_failure_event(temp.path(), &event)
            .await
            .unwrap();
        let body = fs::read_to_string(path).await.unwrap();
        let persisted: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(persisted["eventType"], json!("llm_stream_failure"));
        assert_eq!(persisted["upstreamRequestId"], json!("upstream-1"));
        assert_eq!(persisted["requestPhase"], json!("tool_followup"));
        assert_eq!(persisted["followupIndex"], json!(1));
        assert_eq!(persisted["outerMessageId"], json!("assistant-1"));
        assert_eq!(persisted["triggerMessageId"], json!("user-1"));
        assert_eq!(
            persisted["transcriptAnchorKind"],
            json!("assistant_tool_block")
        );
        assert_eq!(persisted["transcriptAnchorMessageId"], json!("msg-1"));
        assert_eq!(persisted["transcriptAnchorToolBlockIndex"], json!(1));
        assert_eq!(
            persisted["upstreamResponseHeaders"]["content-encoding"],
            json!("gzip")
        );
        assert_eq!(persisted["failure"]["isDecode"], json!(true));
        assert_eq!(persisted["requestShape"]["messageCount"], json!(3));
        assert_eq!(
            persisted["requestShape"]["reasoningSignatureCount"],
            json!(1)
        );
        assert_eq!(
            persisted["streamProgress"]["streamStage"],
            json!("after_tool_input_started")
        );
    }

    #[test]
    fn extract_reporting_context_prefers_header_anchor_metadata_over_payload_metadata() {
        let mut headers = HeaderMap::new();
        headers.insert(CHAT_ID_HEADER, HeaderValue::from_static("chat-header"));
        headers.insert(MESSAGE_ID_HEADER, HeaderValue::from_static("msg-header"));
        headers.insert(
            TRIGGER_MESSAGE_ID_HEADER,
            HeaderValue::from_static("user-header"),
        );
        headers.insert(
            TRANSCRIPT_ANCHOR_KIND_HEADER,
            HeaderValue::from_static("user_message"),
        );
        headers.insert(
            TRANSCRIPT_ANCHOR_MESSAGE_ID_HEADER,
            HeaderValue::from_static("user-header"),
        );
        headers.insert(
            TRANSCRIPT_ANCHOR_TOOL_BLOCK_INDEX_HEADER,
            HeaderValue::from_static("7"),
        );

        let payload = json!({
            "metadata": {
                "chat_id": "chat-payload",
                "message_id": "msg-payload",
                "trigger_message_id": "user-payload",
                "transcript_anchor_kind": "assistant_tool_block",
                "transcript_anchor_message_id": "msg-payload",
                "transcript_anchor_tool_block_index": 2
            }
        });

        let context = extract_reporting_context(&headers, Some(&payload)).expect("context");
        assert_eq!(context.chat_id, "chat-header");
        assert_eq!(context.message_id, "msg-header");
        assert_eq!(context.trigger_message_id.as_deref(), Some("user-header"));
        assert_eq!(
            context.transcript_anchor_kind.as_deref(),
            Some("user_message")
        );
        assert_eq!(
            context.transcript_anchor_message_id.as_deref(),
            Some("user-header")
        );
        assert_eq!(context.transcript_anchor_tool_block_index, Some(7));
    }
}
