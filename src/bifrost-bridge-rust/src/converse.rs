use crate::provider_headers::ResolvedProviderHeaders;
use anyhow::{anyhow, Result};
use base64::{engine::general_purpose, Engine as _};
use reqwest::header::{HeaderMap, HeaderValue};
use serde_json::{json, Map, Value};
use tracing::warn;
use uuid::Uuid;

pub const ANTHROPIC_API_VERSION: &str = "2023-06-01";

fn message_id() -> String {
    format!("msg_{}", Uuid::new_v4().simple())
}

fn coerce_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(value) => value.clone(),
        _ => serde_json::to_string(value).unwrap_or_default(),
    }
}

fn has_cache_control(value: &Value) -> bool {
    value
        .get("cache_control")
        .and_then(Value::as_object)
        .is_some()
}

fn cache_control_ttl(value: &Value) -> Option<&str> {
    value
        .get("cache_control")
        .and_then(Value::as_object)
        .and_then(|cache_control| cache_control.get("ttl"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|ttl| !ttl.is_empty())
}

fn bedrock_cache_point_block(ttl: Option<&str>) -> Value {
    let mut cache_point = Map::new();
    cache_point.insert("type".to_string(), Value::String("default".to_string()));
    if let Some(ttl) = ttl {
        cache_point.insert("ttl".to_string(), Value::String(ttl.to_string()));
    }
    let mut block = Map::new();
    block.insert("cachePoint".to_string(), Value::Object(cache_point));
    Value::Object(block)
}

fn bedrock_cache_point_block_for(value: &Value) -> Value {
    bedrock_cache_point_block(cache_control_ttl(value))
}

fn is_bedrock_cache_point_block(value: &Value) -> bool {
    value.get("cachePoint").and_then(Value::as_object).is_some()
}

fn append_cache_point_if_missing(blocks: &mut Vec<Value>, cache_point: Value) {
    if !blocks
        .last()
        .map(is_bedrock_cache_point_block)
        .unwrap_or(false)
    {
        blocks.push(cache_point);
    }
}

fn apply_request_level_cache_control(payload: &mut Map<String, Value>, cache_point: Value) {
    if let Some(message_blocks) = payload
        .get_mut("messages")
        .and_then(Value::as_array_mut)
        .and_then(|messages| messages.last_mut())
        .and_then(Value::as_object_mut)
        .and_then(|message| message.get_mut("content"))
        .and_then(Value::as_array_mut)
    {
        append_cache_point_if_missing(message_blocks, cache_point);
        return;
    }

    if let Some(system_blocks) = payload.get_mut("system").and_then(Value::as_array_mut) {
        append_cache_point_if_missing(system_blocks, cache_point);
        return;
    }

    if let Some(tool_blocks) = payload
        .get_mut("toolConfig")
        .and_then(Value::as_object_mut)
        .and_then(|tool_config| tool_config.get_mut("tools"))
        .and_then(Value::as_array_mut)
    {
        append_cache_point_if_missing(tool_blocks, cache_point);
    }
}

fn anthropic_system_to_bedrock(system: &Value) -> Result<Vec<Value>> {
    if system.is_null() {
        return Ok(Vec::new());
    }
    if let Some(text) = system.as_str() {
        return Ok(vec![json!({"text": text})]);
    }
    let Some(items) = system.as_array() else {
        return Err(anyhow!("Unsupported Anthropic system content"));
    };
    let mut blocks = Vec::new();
    for item in items {
        if item.get("type").and_then(Value::as_str) == Some("text") {
            let Some(text) = item.get("text").and_then(Value::as_str) else {
                continue;
            };
            blocks.push(json!({"text": text}));
            if has_cache_control(item) {
                blocks.push(bedrock_cache_point_block_for(item));
            }
        }
    }
    Ok(blocks)
}

fn anthropic_tool_result_content_to_bedrock(content: &Value) -> Vec<Value> {
    if content.is_null() {
        return vec![json!({"text": ""})];
    }
    if let Some(text) = content.as_str() {
        return vec![json!({"text": text})];
    }
    if content.is_object() {
        return vec![json!({"json": content})];
    }
    if let Some(items) = content.as_array() {
        let mut blocks = Vec::new();
        for item in items {
            if let Some(text) = item.as_str() {
                blocks.push(json!({"text": text}));
                continue;
            }
            if let Some(kind) = item.get("type").and_then(Value::as_str) {
                if kind == "text" {
                    blocks.push(json!({"text": item.get("text").and_then(Value::as_str).unwrap_or_default()}));
                } else {
                    blocks.push(json!({"json": item}));
                }
                continue;
            }
            blocks.push(json!({"text": coerce_text(item)}));
        }
        if blocks.is_empty() {
            return vec![json!({"text": ""})];
        }
        return blocks;
    }
    vec![json!({"text": coerce_text(content)})]
}

fn compact_base64_image_data(data: &str, field_name: &str) -> Result<String> {
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

fn decode_base64_image_bytes(data: &str, field_name: &str) -> Result<(String, Vec<u8>)> {
    let compact = compact_base64_image_data(data, field_name)?;
    let bytes = general_purpose::STANDARD
        .decode(compact.as_bytes())
        .or_else(|_| general_purpose::URL_SAFE.decode(compact.as_bytes()))
        .map_err(|error| anyhow!("{field_name} contains invalid base64 data: {error}"))?;
    if bytes.is_empty() {
        return Err(anyhow!("{field_name} decoded to empty image bytes"));
    }
    Ok((compact, bytes))
}

fn sniff_image_format(bytes: &[u8], field_name: &str) -> Result<(&'static str, &'static str)> {
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Ok(("jpeg", "image/jpeg"));
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Ok(("png", "image/png"));
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Ok(("gif", "image/gif"));
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Ok(("webp", "image/webp"));
    }
    Err(anyhow!(
        "{field_name} contains unsupported image bytes; expected JPEG, PNG, GIF, or WebP"
    ))
}

fn normalize_base64_image_data(
    data: &str,
    field_name: &str,
) -> Result<(String, &'static str, &'static str)> {
    let (compact, bytes) = decode_base64_image_bytes(data, field_name)?;
    let (format, media_type) = sniff_image_format(&bytes, field_name)?;
    Ok((compact, format, media_type))
}

pub(crate) fn normalize_image_data_url(data_url: &str, field_name: &str) -> Result<String> {
    let (header, data) = parse_image_data_url_parts(data_url, field_name)?;
    let _ = header;
    let (data, _format, media_type) =
        normalize_base64_image_data(data, &format!("{field_name} base64 data"))?;
    Ok(format!("data:{media_type};base64,{data}"))
}

fn parse_image_data_url_parts<'a>(
    data_url: &'a str,
    field_name: &str,
) -> Result<(&'a str, &'a str)> {
    if data_url.starts_with("http://") || data_url.starts_with("https://") {
        return Err(anyhow!(
            "{field_name} must be converted to a data:image/...;base64,... URL before Bedrock dispatch; got an unresolved http(s) URL"
        ));
    }

    let (header, data) = data_url
        .split_once(',')
        .ok_or_else(|| anyhow!("{field_name} must be a data:image/...;base64,... URL"))?;
    let media_type = header
        .strip_prefix("data:")
        .and_then(|value| value.split(';').next())
        .ok_or_else(|| anyhow!("{field_name} must start with data:image/"))?;
    if !media_type.starts_with("image/") {
        return Err(anyhow!("{field_name} must contain an image media type"));
    }
    if !header
        .split(';')
        .any(|part| part.eq_ignore_ascii_case("base64"))
    {
        return Err(anyhow!("{field_name} must use base64 image data"));
    }
    Ok((header, data))
}

fn parse_image_data_url(data_url: &str) -> Result<(String, String)> {
    let (_header, data) = parse_image_data_url_parts(data_url, "image_url.url")?;
    let (data, format, _media_type) =
        normalize_base64_image_data(data, "image_url.url base64 data")?;
    Ok((format.to_string(), data))
}

fn anthropic_image_source_to_bedrock(source: &Map<String, Value>) -> Result<Value> {
    match source.get("type").and_then(Value::as_str) {
        Some("base64") | None => {}
        Some(other) => {
            return Err(anyhow!(
                "Anthropic image source.type must be base64 before Bedrock dispatch, got {other}"
            ));
        }
    }
    let data = source
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("Anthropic image source.data is missing"))?;
    let media_type = source
        .get("media_type")
        .and_then(Value::as_str)
        .unwrap_or("image/png");
    if !media_type.starts_with("image/") {
        return Err(anyhow!(
            "Anthropic image source.media_type must be an image type"
        ));
    }
    let (data, format, _actual_media_type) =
        normalize_base64_image_data(data, "Anthropic image source.data")?;
    Ok(json!({
        "image": {
            "format": format,
            "source": {
                "bytes": data
            }
        }
    }))
}

fn openai_image_url_to_bedrock(image_url: &str) -> Result<Value> {
    let (format, data) = parse_image_data_url(image_url)?;
    Ok(json!({
        "image": {
            "format": format,
            "source": {
                "bytes": data
            }
        }
    }))
}

fn anthropic_content_to_bedrock(content: &Value) -> Result<Vec<Value>> {
    if content.is_null() {
        return Ok(Vec::new());
    }
    if let Some(text) = content.as_str() {
        return Ok(vec![json!({"text": text})]);
    }
    let Some(items) = content.as_array() else {
        return Err(anyhow!(
            "Anthropic message content must be a string or array"
        ));
    };
    let mut blocks = Vec::new();
    for block in items {
        let kind = block
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("Anthropic content block type is missing"))?;
        match kind {
            "text" => blocks.push(json!({"text": block.get("text").and_then(Value::as_str).unwrap_or_default()})),
            "tool_use" => blocks.push(json!({
                "toolUse": {
                    "toolUseId": block.get("id").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("toolu_{}", Uuid::new_v4().simple())),
                    "name": block.get("name").and_then(Value::as_str).unwrap_or_default(),
                    "input": block.get("input").cloned().unwrap_or_else(|| json!({}))
                }
            })),
            "tool_result" | "mcp_tool_result" => blocks.push(json!({
                "toolResult": {
                    "toolUseId": block.get("tool_use_id").and_then(Value::as_str).unwrap_or_default(),
                    "content": anthropic_tool_result_content_to_bedrock(block.get("content").unwrap_or(&Value::Null)),
                    "status": if block.get("is_error").and_then(Value::as_bool).unwrap_or(false) { "error" } else { "success" }
                }
            })),
            "thinking" => {
                let mut reasoning_text = Map::new();
                if let Some(text) = block.get("thinking").and_then(Value::as_str) {
                    reasoning_text.insert("text".to_string(), Value::String(text.to_string()));
                }
                if let Some(signature) = block.get("signature").and_then(Value::as_str) {
                    reasoning_text.insert("signature".to_string(), Value::String(signature.to_string()));
                }
                blocks.push(json!({
                    "reasoningContent": {
                        "reasoningText": Value::Object(reasoning_text)
                    }
                }));
            }
            // Anthropic's thinking contract requires clients to echo
            // redacted_thinking blocks back alongside tool_use; rejecting them
            // breaks compliant native clients mid tool loop.
            "redacted_thinking" => {
                blocks.push(json!({
                    "reasoningContent": {
                        "redactedContent": block.get("data").cloned().unwrap_or(Value::Null)
                    }
                }));
            }
            "image" => {
                let source = block.get("source").and_then(Value::as_object).ok_or_else(|| anyhow!("Anthropic image source is missing"))?;
                blocks.push(anthropic_image_source_to_bedrock(source)?);
            }
            "image_url" => {
                let image_url = block
                    .get("image_url")
                    .and_then(Value::as_object)
                    .and_then(|image_url| image_url.get("url"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("image_url.url is missing"))?;
                blocks.push(openai_image_url_to_bedrock(image_url)?);
            }
            "document" => {
                let source = block.get("source").and_then(Value::as_object).ok_or_else(|| anyhow!("Anthropic document source is missing"))?;
                let media_type = source.get("media_type").and_then(Value::as_str).unwrap_or("text/plain");
                let mut source_payload = Map::new();
                match source.get("type").and_then(Value::as_str) {
                    Some("base64") => {
                        source_payload.insert("bytes".to_string(), source.get("data").cloned().unwrap_or(Value::Null));
                    }
                    Some("text") => {
                        source_payload.insert("text".to_string(), source.get("data").cloned().unwrap_or(Value::Null));
                    }
                    _ => {}
                }
                let format = if media_type == "application/pdf" {
                    "pdf".to_string()
                } else {
                    media_type.split('/').next_back().unwrap_or("plain").to_string()
                };
                blocks.push(json!({
                    "document": {
                        "format": format,
                        "name": block.get("title").and_then(Value::as_str).unwrap_or("document"),
                        "source": Value::Object(source_payload)
                    }
                }));
            }
            _ => return Err(anyhow!("Unsupported Anthropic content block type: {kind}")),
        }

        if has_cache_control(block) {
            blocks.push(bedrock_cache_point_block_for(block));
        }
    }
    Ok(blocks)
}

fn bedrock_content_block_has_provider_payload(block: &Value) -> bool {
    let Some(object) = block.as_object() else {
        return true;
    };

    if is_bedrock_cache_point_block(block) {
        return false;
    }

    if object.contains_key("toolUse")
        || object.contains_key("toolResult")
        || object.contains_key("reasoningContent")
        || object.contains_key("image")
        || object.contains_key("document")
        || object.contains_key("json")
    {
        return true;
    }

    if let Some(text) = object.get("text").and_then(Value::as_str) {
        return !text.trim().is_empty();
    }

    object.keys().any(|key| key != "cachePoint")
}

fn bedrock_content_blocks_are_empty(blocks: &[Value]) -> bool {
    !blocks
        .iter()
        .any(bedrock_content_block_has_provider_payload)
}

fn anthropic_tools_to_bedrock(
    tools: Option<&Vec<Value>>,
    tool_choice: Option<&Value>,
) -> Option<Value> {
    let tools = tools?;
    let mut bedrock_tools = Vec::new();
    for tool in tools {
        let Some(tool_object) = tool.as_object() else {
            continue;
        };
        let mut spec = Map::new();
        spec.insert(
            "name".to_string(),
            Value::String(
                tool_object
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            ),
        );
        spec.insert(
            "inputSchema".to_string(),
            json!({"json": tool_object.get("input_schema").cloned().unwrap_or_else(|| json!({"type":"object"}))}),
        );
        if let Some(description) = tool_object.get("description").and_then(Value::as_str) {
            spec.insert(
                "description".to_string(),
                Value::String(description.to_string()),
            );
        }
        bedrock_tools.push(json!({"toolSpec": Value::Object(spec)}));
        if has_cache_control(tool) {
            bedrock_tools.push(bedrock_cache_point_block_for(tool));
        }
    }
    if bedrock_tools.is_empty() {
        return None;
    }

    let mut tool_config = Map::new();
    tool_config.insert("tools".to_string(), Value::Array(bedrock_tools));
    if let Some(choice) = tool_choice.and_then(Value::as_object) {
        match choice.get("type").and_then(Value::as_str) {
            Some("auto") => {
                tool_config.insert("toolChoice".to_string(), json!({"auto": {}}));
            }
            Some("any") => {
                tool_config.insert("toolChoice".to_string(), json!({"any": {}}));
            }
            Some("tool") => {
                if let Some(name) = choice.get("name").and_then(Value::as_str) {
                    tool_config.insert("toolChoice".to_string(), json!({"tool": {"name": name}}));
                }
            }
            _ => {}
        }
    }
    Some(Value::Object(tool_config))
}

pub fn anthropic_request_to_bedrock(request: &Value) -> Result<Value> {
    let request_object = request
        .as_object()
        .ok_or_else(|| anyhow!("Anthropic request must be an object"))?;
    let model = request_object
        .get("model")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("Anthropic request is missing model"))?;
    let messages = request_object
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("Anthropic request is missing messages"))?;

    let mut bedrock_messages = Vec::new();
    let mut dropped_empty_assistant_message_indexes = Vec::new();
    for (idx, message) in messages.iter().enumerate() {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("Anthropic role is missing"))?;
        if !matches!(role, "user" | "assistant") {
            return Err(anyhow!("Unsupported Anthropic role: {role}"));
        }
        let content = anthropic_content_to_bedrock(message.get("content").unwrap_or(&Value::Null))?;
        if bedrock_content_blocks_are_empty(&content) {
            if role == "assistant" {
                dropped_empty_assistant_message_indexes.push(idx);
                continue;
            }
            warn!(
                message_index = idx,
                role = role,
                "rejecting empty Bedrock Converse message before upstream dispatch"
            );
            return Err(anyhow!(
                "Anthropic user message at messages.{idx} has empty content"
            ));
        }
        bedrock_messages.push(json!({
            "role": role,
            "content": content
        }));
    }
    if !dropped_empty_assistant_message_indexes.is_empty() {
        warn!(
            dropped_count = dropped_empty_assistant_message_indexes.len(),
            dropped_indexes = ?dropped_empty_assistant_message_indexes,
            dropped_roles = "assistant",
            "dropped empty assistant message(s) before Bedrock Converse dispatch"
        );
    }

    let mut payload = Map::new();
    payload.insert("modelId".to_string(), Value::String(model.to_string()));
    payload.insert("messages".to_string(), Value::Array(bedrock_messages));

    let system_blocks =
        anthropic_system_to_bedrock(request_object.get("system").unwrap_or(&Value::Null))?;
    if !system_blocks.is_empty() {
        payload.insert("system".to_string(), Value::Array(system_blocks));
    }

    let mut inference = Map::new();
    if let Some(value) = request_object.get("max_tokens") {
        inference.insert("maxTokens".to_string(), value.clone());
    }
    if let Some(value) = request_object.get("temperature") {
        inference.insert("temperature".to_string(), value.clone());
    }
    if let Some(value) = request_object.get("top_p") {
        inference.insert("topP".to_string(), value.clone());
    }
    if let Some(value) = request_object.get("stop_sequences") {
        inference.insert("stopSequences".to_string(), value.clone());
    }
    if !inference.is_empty() {
        payload.insert("inferenceConfig".to_string(), Value::Object(inference));
    }

    if let Some(tool_config) = anthropic_tools_to_bedrock(
        request_object.get("tools").and_then(Value::as_array),
        request_object.get("tool_choice"),
    ) {
        payload.insert("toolConfig".to_string(), tool_config);
    }

    let mut additional_fields = Map::new();
    for key in [
        "thinking",
        "top_k",
        "metadata",
        "output_config",
        "output_format",
        "context_management",
        "mcp_servers",
        "inference_geo",
    ] {
        if let Some(value) = request_object.get(key) {
            additional_fields.insert(key.to_string(), value.clone());
        }
    }
    if !additional_fields.is_empty() {
        payload.insert(
            "additionalModelRequestFields".to_string(),
            Value::Object(additional_fields),
        );
    }

    if let Some(service_tier) = request_object.get("service_tier").and_then(Value::as_str) {
        payload.insert("serviceTier".to_string(), json!({"type": service_tier}));
    }
    if let Some(user_id) = request_object
        .get("metadata")
        .and_then(Value::as_object)
        .and_then(|value| value.get("user_id"))
        .and_then(Value::as_str)
    {
        payload.insert("requestMetadata".to_string(), json!({"user_id": user_id}));
    }
    if request_object
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        payload.insert("stream".to_string(), Value::Bool(true));
    }
    if has_cache_control(request) {
        apply_request_level_cache_control(&mut payload, bedrock_cache_point_block_for(request));
    }

    Ok(Value::Object(payload))
}

fn map_stop_reason(reason: Option<&str>) -> Option<String> {
    reason.map(str::to_string)
}

pub const BEDROCK_MALFORMED_TOOL_USE_ERROR_KIND: &str = "bedrock_malformed_tool_use";
pub const BEDROCK_MALFORMED_TOOL_USE_STOP_REASON: &str = "malformed_tool_use";

fn malformed_tool_use_stream_error() -> String {
    format!(
        "Bedrock Converse {BEDROCK_MALFORMED_TOOL_USE_ERROR_KIND}: stopReason=tool_use was emitted without a toolUse content block"
    )
}

fn bedrock_reasoning_content_to_anthropic(reasoning_content: &Map<String, Value>) -> Option<Value> {
    // Signed reasoningText wins when both are present; redacted-only blocks
    // surface as redacted_thinking so compliant clients can echo them back.
    if reasoning_content
        .get("reasoningText")
        .and_then(Value::as_object)
        .is_none()
    {
        if let Some(redacted) = reasoning_content.get("redactedContent") {
            if !redacted.is_null() {
                return Some(json!({
                    "type": "redacted_thinking",
                    "data": redacted.clone()
                }));
            }
        }
    }
    let reasoning = reasoning_content
        .get("reasoningText")
        .and_then(Value::as_object)?;
    let mut thinking = Map::new();
    thinking.insert("type".to_string(), Value::String("thinking".to_string()));
    if let Some(text) = reasoning.get("text").and_then(Value::as_str) {
        thinking.insert("thinking".to_string(), Value::String(text.to_string()));
    }
    if let Some(signature) = reasoning.get("signature").and_then(Value::as_str) {
        thinking.insert(
            "signature".to_string(),
            Value::String(signature.to_string()),
        );
    }
    Some(Value::Object(thinking))
}

fn redacted_reasoning_len(value: &Value) -> usize {
    match value {
        Value::String(value) => value.len(),
        _ => serde_json::to_string(value)
            .map(|value| value.len())
            .unwrap_or_default(),
    }
}

fn ensure_thinking_block_start(
    state: &mut StreamTranslationState,
    index: u64,
    events: &mut Vec<(String, Value)>,
) {
    if state.content_block_types.get(&index).map(String::as_str) == Some("thinking") {
        return;
    }
    state
        .content_block_types
        .insert(index, "thinking".to_string());
    events.push((
        "content_block_start".to_string(),
        json!({
            "type": "content_block_start",
            "index": index,
            "content_block": { "type": "thinking", "thinking": "" }
        }),
    ));
}

fn reasoning_text_delta(
    state: &mut StreamTranslationState,
    index: u64,
    incoming_text: &str,
) -> Option<String> {
    let emitted = state
        .emitted_reasoning_text_by_block
        .entry(index)
        .or_default();
    let extends_emitted = incoming_text.starts_with(emitted.as_str());
    let delta = if extends_emitted {
        incoming_text[emitted.len()..].to_string()
    } else {
        incoming_text.to_string()
    };

    if delta.is_empty() {
        return None;
    }

    if extends_emitted {
        *emitted = incoming_text.to_string();
    } else {
        emitted.push_str(&delta);
    }
    Some(delta)
}

pub fn bedrock_response_to_anthropic(response: &Value, requested_model: &str) -> Value {
    let mut content = Vec::new();
    let blocks = response
        .get("output")
        .and_then(Value::as_object)
        .and_then(|output| output.get("message"))
        .and_then(Value::as_object)
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for block in blocks {
        if let Some(text) = block.get("text").and_then(Value::as_str) {
            content.push(json!({"type":"text","text": text}));
            continue;
        }
        if let Some(tool_use) = block.get("toolUse").and_then(Value::as_object) {
            content.push(json!({
                "type": "tool_use",
                "id": tool_use.get("toolUseId").and_then(Value::as_str).unwrap_or_default(),
                "name": tool_use.get("name").and_then(Value::as_str).unwrap_or_default(),
                "input": tool_use.get("input").cloned().unwrap_or(json!({}))
            }));
            continue;
        }
        if let Some(reasoning_content) = block.get("reasoningContent").and_then(Value::as_object) {
            if let Some(thinking) = bedrock_reasoning_content_to_anthropic(reasoning_content) {
                content.push(thinking);
            }
            continue;
        }
    }

    let usage = response
        .get("usage")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut anthropic_usage = Map::new();
    anthropic_usage.insert(
        "input_tokens".to_string(),
        usage
            .get("inputTokens")
            .cloned()
            .unwrap_or_else(|| json!(0)),
    );
    anthropic_usage.insert(
        "output_tokens".to_string(),
        usage
            .get("outputTokens")
            .cloned()
            .unwrap_or_else(|| json!(0)),
    );
    if let Some(value) = usage.get("cacheReadInputTokens") {
        anthropic_usage.insert("cache_read_input_tokens".to_string(), value.clone());
    }
    if let Some(value) = usage.get("cacheWriteInputTokens") {
        anthropic_usage.insert("cache_creation_input_tokens".to_string(), value.clone());
    }

    json!({
        "id": message_id(),
        "type": "message",
        "role": "assistant",
        "model": requested_model,
        "content": content,
        "stop_reason": map_stop_reason(response.get("stopReason").and_then(Value::as_str)),
        "usage": Value::Object(anthropic_usage)
    })
}

/// Group a completed assistant turn's thinking/redacted_thinking blocks by
/// the tool_use id each group precedes (Anthropic-format `content` array).
/// Used to stash non-streaming responses; the streaming path assembles the
/// same shape incrementally in `StreamTranslationState::turn_tool_stash`.
pub fn collect_turn_thinking_stash_from_anthropic_content(
    content: &Value,
) -> Vec<(String, Vec<Value>)> {
    let Some(blocks) = content.as_array() else {
        return Vec::new();
    };
    let mut groups: Vec<(String, Vec<Value>)> = Vec::new();
    let mut pending: Vec<Value> = Vec::new();
    for block in blocks {
        match block.get("type").and_then(Value::as_str) {
            Some("thinking") | Some("redacted_thinking") => {
                pending.push(block.clone());
            }
            Some("tool_use") => {
                if let Some(id) = block.get("id").and_then(Value::as_str) {
                    groups.push((id.to_string(), std::mem::take(&mut pending)));
                }
            }
            _ => {}
        }
    }
    groups
}

/// Splice cached thinking blocks back into an Anthropic-format request whose
/// assistant tool_use turns arrived without them (the OWUI OpenAI-format hop
/// has no channel for signed thinking). Blocks are inserted byte-exact, in
/// their original order, immediately before the tool_use they preceded.
/// Never touches messages that already carry thinking (native clients supply
/// their own) and never splices across models. Returns the number of blocks
/// spliced.
pub fn splice_cached_thinking_into_anthropic_request(
    request: &mut Value,
    cache: &crate::thinking_cache::ThinkingCache,
    requested_model: &str,
) -> usize {
    let Some(messages) = request.get_mut("messages").and_then(Value::as_array_mut) else {
        return 0;
    };
    let mut spliced = 0usize;
    for message in messages.iter_mut() {
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(content) = message.get_mut("content").and_then(Value::as_array_mut) else {
            continue;
        };
        let has_thinking = content.iter().any(|block| {
            matches!(
                block.get("type").and_then(Value::as_str),
                Some("thinking") | Some("redacted_thinking")
            )
        });
        if has_thinking {
            continue;
        }
        // OWUI replays one loop round per assistant message, so at most one
        // tool_use group per message carries a non-empty stash. The blocks
        // are restored at the FRONT of the message — matching generation
        // order (thinking..., then narration text, then tool_use blocks).
        let mut restored: Vec<Value> = Vec::new();
        for block in content.iter() {
            if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                continue;
            }
            if let Some(tool_use_id) = block.get("id").and_then(Value::as_str) {
                if let Some(cached_blocks) = cache.lookup(tool_use_id, requested_model) {
                    restored.extend(cached_blocks);
                }
            }
        }
        if !restored.is_empty() {
            spliced += restored.len();
            restored.append(content);
            *content = restored;
        }
    }
    spliced
}

pub fn proxy_headers(api_key: &str, provider_headers: &ResolvedProviderHeaders) -> Result<HeaderMap> {
    provider_headers.upstream_headers(api_key)
}

pub fn response_headers_from_upstream(headers: &HeaderMap) -> HeaderMap {
    let mut output = HeaderMap::new();
    output.insert(
        "anthropic-version",
        HeaderValue::from_static(ANTHROPIC_API_VERSION),
    );
    for header_name in [
        "x-portico-cost-usd",
        "x-request-id",
        "x-amzn-requestid",
        "retry-after",
    ] {
        if let Some(value) = headers.get(header_name) {
            output.insert(header_name, value.clone());
        }
    }
    output
}

#[derive(Default)]
pub struct StreamTranslationState {
    pub model: String,
    pub message_id: String,
    pub saw_message_start: bool,
    pub content_block_types: std::collections::HashMap<u64, String>,
    pub stopped_content_block_indices: std::collections::HashSet<u64>,
    pub emitted_reasoning_text_by_block: std::collections::HashMap<u64, String>,
    pub pending_reasoning_signatures: std::collections::HashMap<u64, String>,
    pub pending_stop_reason: Option<String>,
    pub raw_chunk_count: usize,
    pub text_delta_events: usize,
    pub text_delta_chars: usize,
    pub thinking_delta_events: usize,
    pub thinking_delta_chars: usize,
    pub redacted_reasoning_events: usize,
    pub redacted_reasoning_chars: usize,
    pub tool_use_blocks: usize,
    pub tool_input_delta_events: usize,
    pub final_stop_reason: Option<String>,
    pub final_usage: Option<Value>,
    pub stream_error_message: Option<String>,
    pub message_stop_observed: bool,
    pub raw_stop_reason: Option<String>,
    pub message_stop_emitted: bool,
    // Turn-scoped thinking stash inputs (see crate::thinking_cache): the
    // signature/redacted payloads per block index while streaming, plus the
    // finalized (tool_use_id -> preceding thinking blocks) groups assembled at
    // contentBlockStop for cache insertion after the stream completes.
    pub tool_use_id_by_block: std::collections::HashMap<u64, String>,
    pub stash_reasoning_signature_by_block: std::collections::HashMap<u64, String>,
    pub stash_redacted_data_by_block: std::collections::HashMap<u64, String>,
    pub pending_stash_thinking: Vec<Value>,
    pub turn_tool_stash: Vec<(String, Vec<Value>)>,
}

impl StreamTranslationState {
    pub fn new(model: String) -> Self {
        Self {
            model,
            message_id: message_id(),
            saw_message_start: false,
            content_block_types: std::collections::HashMap::new(),
            stopped_content_block_indices: std::collections::HashSet::new(),
            emitted_reasoning_text_by_block: std::collections::HashMap::new(),
            pending_reasoning_signatures: std::collections::HashMap::new(),
            pending_stop_reason: None,
            raw_chunk_count: 0,
            text_delta_events: 0,
            text_delta_chars: 0,
            thinking_delta_events: 0,
            thinking_delta_chars: 0,
            redacted_reasoning_events: 0,
            redacted_reasoning_chars: 0,
            tool_use_blocks: 0,
            tool_input_delta_events: 0,
            final_stop_reason: None,
            final_usage: None,
            stream_error_message: None,
            message_stop_observed: false,
            raw_stop_reason: None,
            message_stop_emitted: false,
            tool_use_id_by_block: std::collections::HashMap::new(),
            stash_reasoning_signature_by_block: std::collections::HashMap::new(),
            stash_redacted_data_by_block: std::collections::HashMap::new(),
            pending_stash_thinking: Vec::new(),
            turn_tool_stash: Vec::new(),
        }
    }
}

fn ensure_message_start(state: &mut StreamTranslationState, role: &str) -> Vec<(String, Value)> {
    if state.saw_message_start {
        return Vec::new();
    }
    state.saw_message_start = true;
    vec![(
        "message_start".to_string(),
        json!({
            "type": "message_start",
            "message": {
                "id": state.message_id,
                "type": "message",
                "role": role,
                "model": state.model,
                "content": []
            }
        }),
    )]
}

fn ensure_tool_use_block_start(
    state: &mut StreamTranslationState,
    index: u64,
    tool_use: &Map<String, Value>,
    events: &mut Vec<(String, Value)>,
) {
    if state.content_block_types.get(&index).map(String::as_str) == Some("tool_use") {
        return;
    }

    state
        .content_block_types
        .insert(index, "tool_use".to_string());
    state.tool_use_blocks += 1;

    let tool_use_id = tool_use
        .get("toolUseId")
        .or_else(|| tool_use.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("toolu_{}", Uuid::new_v4().simple()));
    state
        .tool_use_id_by_block
        .insert(index, tool_use_id.clone());
    let name = tool_use
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if name.is_empty() {
        warn!(
            content_block_index = index,
            "Synthesizing Anthropic tool_use block start from toolUse delta without tool name",
        );
    }

    events.push((
        "content_block_start".to_string(),
        json!({
            "type": "content_block_start",
            "index": index,
            "content_block": {
                "type": "tool_use",
                "id": tool_use_id,
                "name": name,
                "input": {}
            }
        }),
    ));
}

pub fn translate_bedrock_stream_chunk(
    raw_chunk: &Value,
    state: &mut StreamTranslationState,
) -> Vec<(String, Value)> {
    if state.final_stop_reason.as_deref() == Some(BEDROCK_MALFORMED_TOOL_USE_STOP_REASON) {
        return Vec::new();
    }

    state.raw_chunk_count += 1;
    let mut events = Vec::new();

    if let Some(message_start) = raw_chunk.get("messageStart").and_then(Value::as_object) {
        let role = message_start
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("assistant");
        events.extend(ensure_message_start(state, role));
        return events;
    }

    if let Some(block_start) = raw_chunk
        .get("contentBlockStart")
        .and_then(Value::as_object)
    {
        events.extend(ensure_message_start(state, "assistant"));
        let index = block_start
            .get("contentBlockIndex")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if let Some(tool_use) = block_start
            .get("start")
            .and_then(Value::as_object)
            .and_then(|start| start.get("toolUse"))
            .and_then(Value::as_object)
        {
            ensure_tool_use_block_start(state, index, tool_use, &mut events);
        }
        return events;
    }

    if let Some(block_delta) = raw_chunk
        .get("contentBlockDelta")
        .and_then(Value::as_object)
    {
        events.extend(ensure_message_start(state, "assistant"));
        let index = block_delta
            .get("contentBlockIndex")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let delta = block_delta
            .get("delta")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();

        if let Some(text) = delta.get("text").and_then(Value::as_str) {
            if !state.content_block_types.contains_key(&index) {
                state.content_block_types.insert(index, "text".to_string());
                events.push((
                    "content_block_start".to_string(),
                    json!({
                        "type": "content_block_start",
                        "index": index,
                        "content_block": { "type": "text", "text": "" }
                    }),
                ));
            }
            if !text.is_empty() {
                state.text_delta_events += 1;
                state.text_delta_chars += text.chars().count();
                events.push((
                    "content_block_delta".to_string(),
                    json!({
                        "type": "content_block_delta",
                        "index": index,
                        "delta": { "type": "text_delta", "text": text }
                    }),
                ));
            }
            return events;
        }

        if let Some(tool_use) = delta.get("toolUse").and_then(Value::as_object) {
            ensure_tool_use_block_start(state, index, tool_use, &mut events);
            if let Some(input_delta) = tool_use
                .get("input")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
            {
                state.tool_input_delta_events += 1;
                events.push((
                    "content_block_delta".to_string(),
                    json!({
                        "type": "content_block_delta",
                        "index": index,
                        "delta": { "type": "input_json_delta", "partial_json": input_delta }
                    }),
                ));
            }
            return events;
        }

        if let Some(reasoning) = delta.get("reasoningContent").and_then(Value::as_object) {
            if let Some(redacted_content) = reasoning.get("redactedContent") {
                state.redacted_reasoning_events += 1;
                state.redacted_reasoning_chars += redacted_reasoning_len(redacted_content);
                let redacted_text = match redacted_content {
                    Value::String(value) => value.clone(),
                    other => serde_json::to_string(other).unwrap_or_default(),
                };
                state
                    .stash_redacted_data_by_block
                    .entry(index)
                    .or_default()
                    .push_str(&redacted_text);
            }

            let text = reasoning
                .get("text")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty());
            let signature = reasoning
                .get("signature")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty());
            if let Some(signature) = signature {
                // Retained past emission for the thinking stash — the block
                // must round-trip byte-exact on follow-up requests.
                state
                    .stash_reasoning_signature_by_block
                    .insert(index, signature.to_string());
            }
            let has_visible_thinking =
                state.content_block_types.get(&index).map(String::as_str) == Some("thinking");

            if text.is_none() && signature.is_none() {
                return events;
            }

            if text.is_none() && !has_visible_thinking {
                if let Some(signature) = signature {
                    state
                        .pending_reasoning_signatures
                        .insert(index, signature.to_string());
                }
                return events;
            }

            if let Some(text) = text {
                if let Some(thinking_delta) = reasoning_text_delta(state, index, text) {
                    ensure_thinking_block_start(state, index, &mut events);
                    state.thinking_delta_events += 1;
                    state.thinking_delta_chars += thinking_delta.chars().count();
                    events.push((
                        "content_block_delta".to_string(),
                        json!({
                            "type": "content_block_delta",
                            "index": index,
                            "delta": { "type": "thinking_delta", "thinking": thinking_delta }
                        }),
                    ));
                }
            }

            let signature_to_emit = if let Some(signature) = signature {
                state.pending_reasoning_signatures.remove(&index);
                Some(signature.to_string())
            } else if text.is_some() {
                state.pending_reasoning_signatures.remove(&index)
            } else {
                None
            };

            if let Some(signature) = signature_to_emit {
                events.push((
                    "content_block_delta".to_string(),
                    json!({
                        "type": "content_block_delta",
                        "index": index,
                        "delta": { "type": "signature_delta", "signature": signature }
                    }),
                ));
            }
            return events;
        }

        return events;
    }

    if let Some(block_stop) = raw_chunk.get("contentBlockStop").and_then(Value::as_object) {
        let index = block_stop
            .get("contentBlockIndex")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let emitted_reasoning_text = state.emitted_reasoning_text_by_block.remove(&index);
        let stash_signature = state.stash_reasoning_signature_by_block.remove(&index);
        let redacted_data = state.stash_redacted_data_by_block.remove(&index);
        let block_type = state.content_block_types.get(&index).cloned();
        state.pending_reasoning_signatures.remove(&index);

        if let Some(redacted_data) = redacted_data.filter(|data| !data.is_empty()) {
            let redacted_block = json!({
                "type": "redacted_thinking",
                "data": redacted_data
            });
            // Redacted reasoning has no visible deltas; surface it to native
            // Anthropic clients as a complete block so they can echo it back.
            if block_type.is_none() {
                state
                    .content_block_types
                    .insert(index, "redacted_thinking".to_string());
                events.push((
                    "content_block_start".to_string(),
                    json!({
                        "type": "content_block_start",
                        "index": index,
                        "content_block": redacted_block.clone()
                    }),
                ));
            }
            state.pending_stash_thinking.push(redacted_block);
        } else if block_type.as_deref() == Some("thinking")
            || stash_signature.is_some()
            || emitted_reasoning_text
                .as_deref()
                .is_some_and(|text| !text.is_empty())
        {
            let mut thinking_block = Map::new();
            thinking_block.insert("type".to_string(), Value::String("thinking".to_string()));
            thinking_block.insert(
                "thinking".to_string(),
                Value::String(emitted_reasoning_text.unwrap_or_default()),
            );
            if let Some(signature) = stash_signature {
                thinking_block.insert("signature".to_string(), Value::String(signature));
            }
            state
                .pending_stash_thinking
                .push(Value::Object(thinking_block));
        } else if block_type.as_deref() == Some("tool_use") {
            if let Some(tool_use_id) = state.tool_use_id_by_block.get(&index).cloned() {
                let group = std::mem::take(&mut state.pending_stash_thinking);
                state.turn_tool_stash.push((tool_use_id, group));
            }
        }

        if state.content_block_types.contains_key(&index) {
            state.stopped_content_block_indices.insert(index);
            events.push((
                "content_block_stop".to_string(),
                json!({
                    "type": "content_block_stop",
                    "index": index
                }),
            ));
        }
        return events;
    }

    if let Some(message_stop) = raw_chunk.get("messageStop").and_then(Value::as_object) {
        let stop_reason = map_stop_reason(message_stop.get("stopReason").and_then(Value::as_str));
        state.message_stop_observed = true;
        state.raw_stop_reason = stop_reason.clone();
        if stop_reason.as_deref() == Some("tool_use") && state.tool_use_blocks == 0 {
            let message = malformed_tool_use_stream_error();
            state.pending_stop_reason = None;
            state.final_stop_reason = Some(BEDROCK_MALFORMED_TOOL_USE_STOP_REASON.to_string());
            state.stream_error_message = Some(message.clone());
            events.push((
                "error".to_string(),
                json!({
                    "type": "error",
                    "error": {
                        "type": "api_error",
                        "code": BEDROCK_MALFORMED_TOOL_USE_ERROR_KIND,
                        "message": message,
                    }
                }),
            ));
            return events;
        }

        state.pending_stop_reason = stop_reason;
        state.final_stop_reason = state.pending_stop_reason.clone();
        if let Some(reason) = &state.pending_stop_reason {
            events.push((
                "message_delta".to_string(),
                json!({
                    "type": "message_delta",
                    "delta": { "stop_reason": reason }
                }),
            ));
        }
        return events;
    }

    if let Some(metadata) = raw_chunk.get("metadata").and_then(Value::as_object) {
        if let Some(usage) = metadata.get("usage").and_then(Value::as_object) {
            let mut payload = Map::new();
            payload.insert(
                "input_tokens".to_string(),
                usage
                    .get("inputTokens")
                    .cloned()
                    .unwrap_or_else(|| json!(0)),
            );
            payload.insert(
                "output_tokens".to_string(),
                usage
                    .get("outputTokens")
                    .cloned()
                    .unwrap_or_else(|| json!(0)),
            );
            if let Some(value) = usage.get("cacheReadInputTokens") {
                payload.insert("cache_read_input_tokens".to_string(), value.clone());
            }
            if let Some(value) = usage.get("cacheWriteInputTokens") {
                payload.insert("cache_creation_input_tokens".to_string(), value.clone());
            }
            state.final_usage = Some(Value::Object(payload.clone()));
            events.push((
                "message_delta".to_string(),
                json!({
                    "type": "message_delta",
                    "usage": Value::Object(payload)
                }),
            ));
        }
        if state.pending_stop_reason.take().is_some() {
            state.message_stop_emitted = true;
            events.push(("message_stop".to_string(), json!({"type":"message_stop"})));
        }
        return events;
    }

    for exception_key in [
        "internalServerException",
        "validationException",
        "serviceUnavailableException",
        "throttlingException",
        "modelStreamErrorException",
    ] {
        if let Some(exception) = raw_chunk.get(exception_key) {
            let message = exception
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| coerce_text(exception));
            state.stream_error_message = Some(message.clone());
            events.push((
                "error".to_string(),
                json!({
                    "type": "error",
                    "error": { "type": "api_error", "message": message }
                }),
            ));
            return events;
        }
    }

    events
}

pub fn flush_bedrock_stream_state(state: &mut StreamTranslationState) -> Vec<(String, Value)> {
    if state.pending_stop_reason.take().is_some() {
        state.message_stop_emitted = true;
        return vec![("message_stop".to_string(), json!({"type":"message_stop"}))];
    }
    Vec::new()
}

pub fn synthesize_bedrock_stream_eof(state: &mut StreamTranslationState) -> Vec<(String, Value)> {
    if state.message_stop_emitted || state.stream_error_message.is_some() {
        return Vec::new();
    }

    let has_visible_output = state.text_delta_events > 0
        || state.tool_use_blocks > 0
        || state.tool_input_delta_events > 0;
    if !has_visible_output && state.final_usage.is_none() {
        let message = format!(
            "Bedrock Converse stream ended without message_stop, visible output, tool use, or usage after {} chunks (thinking_delta_events={}, thinking_delta_chars={}); treating as incomplete_stream",
            state.raw_chunk_count, state.thinking_delta_events, state.thinking_delta_chars
        );
        state.final_stop_reason = Some("incomplete_stream".to_string());
        state.stream_error_message = Some(message.clone());
        return vec![(
            "error".to_string(),
            json!({
                "type": "error",
                "error": {
                    "type": "api_error",
                    "message": message
                }
            }),
        )];
    }

    let mut events = Vec::new();
    let mut block_indices: Vec<u64> = state.content_block_types.keys().copied().collect();
    block_indices.sort_unstable();
    for index in block_indices {
        if state.stopped_content_block_indices.insert(index) {
            events.push((
                "content_block_stop".to_string(),
                json!({
                    "type": "content_block_stop",
                    "index": index
                }),
            ));
        }
    }

    state.final_stop_reason = Some("incomplete_stream".to_string());
    state.message_stop_emitted = true;
    events.push((
        "message_delta".to_string(),
        json!({
            "type": "message_delta",
            "delta": { "stop_reason": "incomplete_stream" }
        }),
    ));
    events.push(("message_stop".to_string(), json!({"type":"message_stop"})));
    events
}

#[cfg(test)]
mod tests {
    use super::*;

    const JPEG_BASE64: &str = "/9j/2Q==";
    const PNG_BASE64: &str = "iVBORw0KGgo=";

    #[test]
    fn basic_helpers_cover_text_and_cache_control_paths() {
        let generated = message_id();
        assert!(generated.starts_with("msg_"));
        assert_eq!(coerce_text(&Value::Null), "");
        assert_eq!(coerce_text(&json!("abc")), "abc");
        assert_eq!(coerce_text(&json!({"a":1})), r#"{"a":1}"#);
        assert!(has_cache_control(
            &json!({"cache_control":{"type":"ephemeral"}})
        ));
        assert!(!has_cache_control(&json!({"foo":"bar"})));
        assert_eq!(
            cache_control_ttl(&json!({"cache_control":{"ttl":" 1h "}})),
            Some("1h")
        );
        assert_eq!(
            cache_control_ttl(&json!({"cache_control":{"ttl":" "}})),
            None
        );
        assert_eq!(
            bedrock_cache_point_block(None),
            json!({"cachePoint":{"type":"default"}})
        );
        assert_eq!(
            bedrock_cache_point_block(Some("1h")),
            json!({"cachePoint":{"type":"default","ttl":"1h"}})
        );
        assert_eq!(
            bedrock_cache_point_block_for(
                &json!({"cache_control":{"type":"ephemeral","ttl":"1h"}})
            ),
            json!({"cachePoint":{"type":"default","ttl":"1h"}})
        );
        assert!(is_bedrock_cache_point_block(&bedrock_cache_point_block(
            None
        )));
        assert!(!is_bedrock_cache_point_block(&json!({"text":"hello"})));
    }

    #[test]
    fn system_and_tool_result_content_conversion_cover_variants() {
        assert_eq!(
            anthropic_system_to_bedrock(&Value::Null).unwrap(),
            Vec::<Value>::new()
        );
        assert_eq!(
            anthropic_system_to_bedrock(&json!("hello")).unwrap(),
            vec![json!({"text":"hello"})]
        );
        assert_eq!(
            anthropic_system_to_bedrock(&json!([
                {"type":"text","text":"one","cache_control":{"type":"ephemeral"}},
                {"type":"text","text":"two","cache_control":{"type":"ephemeral","ttl":"1h"}},
                {"type":"ignored","text":"skip"}
            ]))
            .unwrap(),
            vec![
                json!({"text":"one"}),
                json!({"cachePoint":{"type":"default"}}),
                json!({"text":"two"}),
                json!({"cachePoint":{"type":"default","ttl":"1h"}})
            ]
        );
        assert!(anthropic_system_to_bedrock(&json!(7)).is_err());

        assert_eq!(
            anthropic_tool_result_content_to_bedrock(&Value::Null),
            vec![json!({"text":""})]
        );
        assert_eq!(
            anthropic_tool_result_content_to_bedrock(&json!("text")),
            vec![json!({"text":"text"})]
        );
        assert_eq!(
            anthropic_tool_result_content_to_bedrock(&json!({"ok":true})),
            vec![json!({"json":{"ok":true}})]
        );
        assert_eq!(
            anthropic_tool_result_content_to_bedrock(&json!([
                "hi",
                {"type":"text","text":"there"},
                {"type":"other","value":1},
                7
            ])),
            vec![
                json!({"text":"hi"}),
                json!({"text":"there"}),
                json!({"json":{"type":"other","value":1}}),
                json!({"text":"7"})
            ]
        );
        assert_eq!(
            anthropic_system_to_bedrock(&json!([{"type":"text","text":"plain"}])).unwrap(),
            vec![json!({"text":"plain"})]
        );
        assert_eq!(
            anthropic_system_to_bedrock(&json!([{"type":"text"}])).unwrap(),
            Vec::<Value>::new()
        );
        assert_eq!(
            anthropic_tool_result_content_to_bedrock(&json!([])),
            vec![json!({"text":""})]
        );
        assert_eq!(
            anthropic_tool_result_content_to_bedrock(&json!(9)),
            vec![json!({"text":"9"})]
        );
    }

    #[test]
    fn anthropic_content_to_bedrock_covers_supported_block_types() {
        let content = json!([
            {"type":"text","text":"hello","cache_control":{"type":"ephemeral","ttl":"1h"}},
            {"type":"tool_use","id":"toolu_1","name":"lookup","input":{"q":"rust"}},
            {"type":"tool_result","tool_use_id":"toolu_1","content":"done","is_error":true},
            {"type":"thinking","thinking":"trace","signature":"sig"},
            {"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":JPEG_BASE64}},
            {"type":"document","title":"doc","source":{"type":"text","media_type":"text/plain","data":"body"}}
        ]);
        let blocks = anthropic_content_to_bedrock(&content).unwrap();
        assert_eq!(blocks[0], json!({"text":"hello"}));
        assert_eq!(
            blocks[1],
            json!({"cachePoint":{"type":"default","ttl":"1h"}})
        );
        assert_eq!(blocks[2]["toolUse"]["toolUseId"], json!("toolu_1"));
        assert_eq!(blocks[3]["toolResult"]["status"], json!("error"));
        assert_eq!(
            blocks[4]["reasoningContent"]["reasoningText"]["signature"],
            json!("sig")
        );
        assert_eq!(blocks[5]["image"]["format"], json!("jpeg"));
        assert_eq!(blocks[6]["document"]["source"]["text"], json!("body"));

        let defaults = anthropic_content_to_bedrock(&json!([
            {"type":"tool_use","name":"lookup"},
            {"type":"mcp_tool_result","tool_use_id":"toolu_2","content":{"ok":true}},
            {"type":"thinking"}
        ]))
        .unwrap();
        assert!(defaults[0]["toolUse"]["toolUseId"]
            .as_str()
            .unwrap()
            .starts_with("toolu_"));
        assert_eq!(defaults[0]["toolUse"]["input"], json!({}));
        assert_eq!(defaults[1]["toolResult"]["status"], json!("success"));
        assert_eq!(defaults[2]["reasoningContent"]["reasoningText"], json!({}));
    }

    // Defect A (A-R6): Anthropic `redacted_thinking` blocks must round-trip
    // to Bedrock `reasoningContent.redactedContent` — clients following the
    // thinking contract echo them back alongside tool_use.
    #[test]
    fn anthropic_content_to_bedrock_round_trips_redacted_thinking() {
        let blocks = anthropic_content_to_bedrock(&json!([
            {"type":"redacted_thinking","data":"b64opaquepayload=="},
            {"type":"tool_use","id":"toolu_r1","name":"lookup","input":{"q":"rust"}}
        ]))
        .expect("redacted_thinking must be accepted alongside tool_use");
        assert_eq!(
            blocks[0]["reasoningContent"]["redactedContent"],
            json!("b64opaquepayload==")
        );
        assert_eq!(blocks[1]["toolUse"]["toolUseId"], json!("toolu_r1"));
    }

    fn feed(state: &mut StreamTranslationState, chunk: Value) -> Vec<(String, Value)> {
        translate_bedrock_stream_chunk(&chunk, state)
    }

    // A-R1 (streaming): the stream translation stashes each round's thinking
    // (text + signature, byte-exact) keyed by the tool_use ids it preceded.
    #[test]
    fn stream_translation_stashes_thinking_groups_by_tool_use_id() {
        let mut state = StreamTranslationState::new("us.anthropic.atlas-opus-5".to_string());
        feed(&mut state, json!({"messageStart":{"role":"assistant"}}));
        feed(
            &mut state,
            json!({"contentBlockDelta":{"contentBlockIndex":0,"delta":{"reasoningContent":{"text":"plan the search"}}}}),
        );
        feed(
            &mut state,
            json!({"contentBlockDelta":{"contentBlockIndex":0,"delta":{"reasoningContent":{"signature":"SIG-A"}}}}),
        );
        feed(&mut state, json!({"contentBlockStop":{"contentBlockIndex":0}}));
        feed(
            &mut state,
            json!({"contentBlockStart":{"contentBlockIndex":1,"start":{"toolUse":{"toolUseId":"toolu_s1","name":"web_search"}}}}),
        );
        feed(
            &mut state,
            json!({"contentBlockDelta":{"contentBlockIndex":1,"delta":{"toolUse":{"input":"{\"q\":1}"}}}}),
        );
        feed(&mut state, json!({"contentBlockStop":{"contentBlockIndex":1}}));
        feed(&mut state, json!({"messageStop":{"stopReason":"tool_use"}}));

        assert_eq!(state.turn_tool_stash.len(), 1);
        let (tool_use_id, blocks) = &state.turn_tool_stash[0];
        assert_eq!(tool_use_id, "toolu_s1");
        assert_eq!(
            blocks,
            &vec![json!({"type":"thinking","thinking":"plan the search","signature":"SIG-A"})]
        );
    }

    // A-R5 (streaming): signature-only reasoning (display omitted) still
    // stashes an empty-text signed block, verbatim.
    #[test]
    fn stream_translation_stashes_signature_only_thinking() {
        let mut state = StreamTranslationState::new("m".to_string());
        feed(&mut state, json!({"messageStart":{"role":"assistant"}}));
        feed(
            &mut state,
            json!({"contentBlockDelta":{"contentBlockIndex":0,"delta":{"reasoningContent":{"signature":"SIG-ONLY"}}}}),
        );
        feed(&mut state, json!({"contentBlockStop":{"contentBlockIndex":0}}));
        feed(
            &mut state,
            json!({"contentBlockStart":{"contentBlockIndex":1,"start":{"toolUse":{"toolUseId":"toolu_sig","name":"t"}}}}),
        );
        feed(&mut state, json!({"contentBlockStop":{"contentBlockIndex":1}}));

        assert_eq!(state.turn_tool_stash.len(), 1);
        assert_eq!(
            state.turn_tool_stash[0].1,
            vec![json!({"type":"thinking","thinking":"","signature":"SIG-ONLY"})]
        );
    }

    // A-R1 (streaming, redacted): redacted reasoning is stashed and emitted
    // as a complete redacted_thinking block for native clients.
    #[test]
    fn stream_translation_stashes_and_emits_redacted_thinking() {
        let mut state = StreamTranslationState::new("m".to_string());
        feed(&mut state, json!({"messageStart":{"role":"assistant"}}));
        feed(
            &mut state,
            json!({"contentBlockDelta":{"contentBlockIndex":0,"delta":{"reasoningContent":{"redactedContent":"b64part1"}}}}),
        );
        let stop_events = feed(&mut state, json!({"contentBlockStop":{"contentBlockIndex":0}}));
        assert!(stop_events.iter().any(|(name, payload)| {
            name == "content_block_start"
                && payload["content_block"]["type"] == json!("redacted_thinking")
                && payload["content_block"]["data"] == json!("b64part1")
        }));
        assert!(stop_events
            .iter()
            .any(|(name, _)| name == "content_block_stop"));
        feed(
            &mut state,
            json!({"contentBlockStart":{"contentBlockIndex":1,"start":{"toolUse":{"toolUseId":"toolu_red","name":"t"}}}}),
        );
        feed(&mut state, json!({"contentBlockStop":{"contentBlockIndex":1}}));
        assert_eq!(
            state.turn_tool_stash[0].1,
            vec![json!({"type":"redacted_thinking","data":"b64part1"})]
        );
    }

    // A-R1 (non-streaming): the same grouping over a full Anthropic content
    // array, including interleaved thinking between tool calls.
    #[test]
    fn collect_turn_thinking_stash_groups_by_position() {
        let content = json!([
            {"type":"thinking","thinking":"t1","signature":"s1"},
            {"type":"tool_use","id":"toolu_1","name":"a","input":{}},
            {"type":"thinking","thinking":"t2","signature":"s2"},
            {"type":"redacted_thinking","data":"r2"},
            {"type":"tool_use","id":"toolu_2","name":"b","input":{}},
            {"type":"text","text":"done"}
        ]);
        let groups = collect_turn_thinking_stash_from_anthropic_content(&content);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].0, "toolu_1");
        assert_eq!(groups[0].1.len(), 1);
        assert_eq!(groups[1].0, "toolu_2");
        assert_eq!(groups[1].1.len(), 2);
        assert_eq!(groups[1].1[1]["type"], json!("redacted_thinking"));
    }

    // A-R2/A-R3/A-R8: splice re-attaches cached blocks byte-exact before the
    // matching tool_use, per assistant message, across rounds; misses degrade
    // silently; returns the spliced-block count.
    #[test]
    fn splice_restores_cached_thinking_before_matching_tool_use() {
        let cache = crate::thinking_cache::ThinkingCache::new(16, std::time::Duration::from_secs(60));
        cache.insert_turn(
            "us.anthropic.atlas-opus-5",
            vec![(
                "toolu_1".to_string(),
                vec![json!({"type":"thinking","thinking":"round1","signature":"S1"})],
            )],
        );
        cache.insert_turn(
            "us.anthropic.atlas-opus-5",
            vec![("toolu_2".to_string(), vec![json!({"type":"thinking","thinking":"round2","signature":"S2"})])],
        );

        let mut request = json!({
            "model": "us.anthropic.atlas-opus-5",
            "messages": [
                {"role":"user","content":"go"},
                {"role":"assistant","content":[
                    {"type":"text","text":"working"},
                    {"type":"tool_use","id":"toolu_1","name":"a","input":{}}
                ]},
                {"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"r1"}]},
                {"role":"assistant","content":[
                    {"type":"tool_use","id":"toolu_2","name":"b","input":{}},
                    {"type":"tool_use","id":"toolu_miss","name":"c","input":{}}
                ]},
                {"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_2","content":"r2"}]}
            ]
        });
        let spliced = splice_cached_thinking_into_anthropic_request(
            &mut request,
            &cache,
            "us.anthropic.atlas-opus-5",
        );
        assert_eq!(spliced, 2);
        let first_assistant = &request["messages"][1]["content"];
        assert_eq!(first_assistant[0]["type"], json!("thinking"));
        assert_eq!(first_assistant[0]["signature"], json!("S1"));
        assert_eq!(first_assistant[1]["type"], json!("text"));
        assert_eq!(first_assistant[2]["type"], json!("tool_use"));
        let second_assistant = &request["messages"][3]["content"];
        assert_eq!(second_assistant[0]["thinking"], json!("round2"));
        assert_eq!(second_assistant[1]["id"], json!("toolu_2"));
        // toolu_miss has no cache entry: silently unspliced, request intact.
        assert_eq!(second_assistant[2]["id"], json!("toolu_miss"));
    }

    // A-R4: never splice when thinking is already present (native clients) or
    // when the cached entry belongs to a different model.
    #[test]
    fn splice_skips_native_thinking_and_model_mismatch() {
        let cache = crate::thinking_cache::ThinkingCache::new(16, std::time::Duration::from_secs(60));
        cache.insert_turn(
            "model-a",
            vec![("toolu_1".to_string(), vec![json!({"type":"thinking","thinking":"x","signature":"s"})])],
        );

        let native = json!([
            {"type":"thinking","thinking":"native","signature":"n"},
            {"type":"tool_use","id":"toolu_1","name":"a","input":{}}
        ]);
        let mut request = json!({"model":"model-a","messages":[
            {"role":"assistant","content": native.clone()}
        ]});
        assert_eq!(
            splice_cached_thinking_into_anthropic_request(&mut request, &cache, "model-a"),
            0
        );
        assert_eq!(request["messages"][0]["content"], native);

        let mut other_model = json!({"model":"model-b","messages":[
            {"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"a","input":{}}]}
        ]});
        assert_eq!(
            splice_cached_thinking_into_anthropic_request(&mut other_model, &cache, "model-b"),
            0
        );
    }

    #[test]
    fn anthropic_content_to_bedrock_accepts_openai_image_url_data_blocks() {
        let blocks = anthropic_content_to_bedrock(&json!([{
            "type":"image_url",
            "image_url":{"url": format!("data:image/png;base64,{JPEG_BASE64}")}
        }]))
        .unwrap();

        assert_eq!(blocks[0]["image"]["format"], json!("jpeg"));
        assert_eq!(blocks[0]["image"]["source"]["bytes"], json!(JPEG_BASE64));

        let anthropic_blocks = anthropic_content_to_bedrock(&json!([{
            "type":"image",
            "source":{"type":"base64","media_type":"image/jpeg","data":PNG_BASE64}
        }]))
        .unwrap();
        assert_eq!(anthropic_blocks[0]["image"]["format"], json!("png"));
        assert_eq!(
            anthropic_blocks[0]["image"]["source"]["bytes"],
            json!(PNG_BASE64)
        );
    }

    #[test]
    fn anthropic_content_to_bedrock_rejects_invalid_blocks() {
        assert_eq!(
            anthropic_content_to_bedrock(&json!("plain")).unwrap(),
            vec![json!({"text":"plain"})]
        );
        let pdf = anthropic_content_to_bedrock(&json!([{
            "type":"document",
            "title":"doc",
            "source":{"type":"base64","media_type":"application/pdf","data":"YWJj"}
        }]))
        .unwrap();
        assert_eq!(pdf[0]["document"]["format"], json!("pdf"));
        assert_eq!(pdf[0]["document"]["source"]["bytes"], json!("YWJj"));

        let unknown_source = anthropic_content_to_bedrock(&json!([{
            "type":"document",
            "title":"doc",
            "source":{"type":"url","media_type":"text/plain","data":"ignored"}
        }]))
        .unwrap();
        assert_eq!(unknown_source[0]["document"]["source"], json!({}));

        assert!(anthropic_content_to_bedrock(&json!(7)).is_err());
        assert!(anthropic_content_to_bedrock(&json!([{"text":"missing type"}])).is_err());
        assert!(anthropic_content_to_bedrock(&json!([{"type":"image"}])).is_err());
        assert!(anthropic_content_to_bedrock(&json!([{
            "type":"image",
            "source":{"type":"base64","media_type":"image/png"}
        }]))
        .unwrap_err()
        .to_string()
        .contains("source.data"));
        assert!(anthropic_content_to_bedrock(&json!([{
            "type":"image",
            "source":{"type":"base64","media_type":"image/png","data":"  "}
        }]))
        .unwrap_err()
        .to_string()
        .contains("non-empty base64"));
        assert!(anthropic_content_to_bedrock(&json!([{
            "type":"image_url",
            "image_url":{"url":"http://host.docker.internal:9876/workspace/chat/slide.png"}
        }]))
        .unwrap_err()
        .to_string()
        .contains("unresolved http(s) URL"));
        assert!(anthropic_content_to_bedrock(&json!([{
            "type":"image_url",
            "image_url":{"url":"data:image/png;base64,%%%" }
        }]))
        .unwrap_err()
        .to_string()
        .contains("invalid base64"));
        assert!(anthropic_content_to_bedrock(&json!([{
            "type":"image_url",
            "image_url":{"url":"data:image/png;base64,YWJj" }
        }]))
        .unwrap_err()
        .to_string()
        .contains("unsupported image bytes"));
        assert!(anthropic_content_to_bedrock(&json!([{"type":"document"}])).is_err());
        assert!(anthropic_content_to_bedrock(&json!([{"type":"unknown"}])).is_err());
    }

    #[test]
    fn tools_and_request_translation_cover_choices_and_metadata() {
        let tools = json!([
            {"name":"lookup","description":"Lookup","input_schema":{"type":"object"},"cache_control":{"type":"ephemeral","ttl":"1h"}},
            "skip-me"
        ]);
        let tool_config = anthropic_tools_to_bedrock(
            tools.as_array(),
            Some(&json!({"type":"tool","name":"lookup"})),
        )
        .unwrap();
        assert_eq!(tool_config["tools"][0]["toolSpec"]["name"], json!("lookup"));
        assert_eq!(
            tool_config["tools"][1],
            json!({"cachePoint":{"type":"default","ttl":"1h"}})
        );
        assert_eq!(tool_config["toolChoice"]["tool"]["name"], json!("lookup"));
        assert!(anthropic_tools_to_bedrock(None, None).is_none());
        assert!(anthropic_tools_to_bedrock(Some(&vec![json!("skip-me")]), None).is_none());
        assert_eq!(
            anthropic_tools_to_bedrock(
                Some(&vec![
                    json!({"name":"lookup","input_schema":{"type":"object"}})
                ]),
                Some(&json!({"type":"any"}))
            )
            .unwrap()["toolChoice"],
            json!({"any": {}})
        );
        assert!(anthropic_tools_to_bedrock(
            Some(&vec![
                json!({"name":"lookup","input_schema":{"type":"object"}})
            ]),
            Some(&json!({"type":"weird"}))
        )
        .unwrap()
        .get("toolChoice")
        .is_none());
        assert!(anthropic_tools_to_bedrock(
            Some(&vec![
                json!({"name":"lookup","input_schema":{"type":"object"}})
            ]),
            Some(&json!("auto"))
        )
        .unwrap()
        .get("toolChoice")
        .is_none());
        let defaults = anthropic_tools_to_bedrock(
            Some(&vec![json!({"name":"lookup"})]),
            Some(&json!({"type":"tool"})),
        )
        .unwrap();
        assert_eq!(
            defaults["tools"][0]["toolSpec"]["inputSchema"]["json"],
            json!({"type":"object"})
        );
        assert!(defaults.get("toolChoice").is_none());

        let request = json!({
            "model":"atlas-model",
            "messages":[
                {"role":"user","content":"hi"},
                {"role":"assistant","content":[{"type":"text","text":"hello"}]}
            ],
            "system":[{"type":"text","text":"sys"}],
            "max_tokens":128,
            "temperature":0.5,
            "top_p":0.9,
            "stop_sequences":["done"],
            "tools":[{"name":"lookup","input_schema":{"type":"object"}}],
            "tool_choice":{"type":"auto"},
            "thinking":{"type":"enabled"},
            "top_k":50,
            "metadata":{"user_id":"u1"},
            "output_config":{"effort":"high"},
            "output_format":{"type":"json"},
            "context_management":{"clear_function_results":true},
            "mcp_servers":["one"],
            "inference_geo":"us",
            "service_tier":"priority",
            "stream":true
        });
        let payload = anthropic_request_to_bedrock(&request).unwrap();
        assert_eq!(payload["modelId"], json!("atlas-model"));
        assert_eq!(payload["inferenceConfig"]["maxTokens"], json!(128));
        assert_eq!(payload["toolConfig"]["toolChoice"]["auto"], json!({}));
        assert_eq!(payload["additionalModelRequestFields"]["top_k"], json!(50));
        assert_eq!(
            payload["additionalModelRequestFields"]["thinking"],
            json!({"type":"enabled"})
        );
        assert_eq!(
            payload["additionalModelRequestFields"]["output_config"]["effort"],
            json!("high")
        );
        assert_eq!(payload["serviceTier"]["type"], json!("priority"));
        assert_eq!(payload["requestMetadata"]["user_id"], json!("u1"));
        assert_eq!(payload["stream"], json!(true));

        let request_level_cache = anthropic_request_to_bedrock(&json!({
            "model":"atlas-model",
            "messages":[
                {"role":"user","content":[{"type":"text","text":"hi"}]},
                {"role":"assistant","content":[{"type":"text","text":"hello"}]}
            ],
            "cache_control":{"type":"ephemeral","ttl":"1h"}
        }))
        .unwrap();
        assert_eq!(
            request_level_cache["messages"][1]["content"],
            json!([
                {"text":"hello"},
                {"cachePoint":{"type":"default","ttl":"1h"}}
            ])
        );

        let system_level_cache = anthropic_request_to_bedrock(&json!({
            "model":"atlas-model",
            "messages":[],
            "system":[{"type":"text","text":"sys"}],
            "cache_control":{"type":"ephemeral","ttl":"1h"}
        }))
        .unwrap();
        assert_eq!(
            system_level_cache["system"],
            json!([
                {"text":"sys"},
                {"cachePoint":{"type":"default","ttl":"1h"}}
            ])
        );

        let tool_level_cache = anthropic_request_to_bedrock(&json!({
            "model":"atlas-model",
            "messages":[],
            "tools":[{"name":"lookup","input_schema":{"type":"object"}}],
            "cache_control":{"type":"ephemeral","ttl":"1h"}
        }))
        .unwrap();
        assert_eq!(
            tool_level_cache["toolConfig"]["tools"],
            json!([
                {"toolSpec":{"name":"lookup","inputSchema":{"json":{"type":"object"}}}},
                {"cachePoint":{"type":"default","ttl":"1h"}}
            ])
        );

        let empty_ttl_cache = anthropic_request_to_bedrock(&json!({
            "model":"atlas-model",
            "messages":[
                {"role":"user","content":[{"type":"text","text":"hi"}]},
                {"role":"assistant","content":[{"type":"text","text":"hello"}]}
            ],
            "cache_control":{"type":"ephemeral","ttl":" "}
        }))
        .unwrap();
        assert_eq!(
            empty_ttl_cache["messages"][1]["content"],
            json!([
                {"text":"hello"},
                {"cachePoint":{"type":"default"}}
            ])
        );
    }

    #[test]
    fn anthropic_request_to_bedrock_skips_empty_assistant_messages() {
        let payload = anthropic_request_to_bedrock(&json!({
            "model":"atlas-model",
            "messages":[
                {"role":"user","content":"first"},
                {"role":"assistant"},
                {"role":"assistant","content":[]},
                {"role":"assistant","content":[{"type":"text","text":"   "}]},
                {"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"lookup","input":{"q":"x"}}]},
                {"role":"user","content":"second"}
            ]
        }))
        .unwrap();
        let messages = payload["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["role"], json!("user"));
        assert_eq!(messages[1]["role"], json!("assistant"));
        assert!(messages[1]["content"][0].get("toolUse").is_some());
        assert_eq!(messages[2]["role"], json!("user"));
        for message in messages {
            assert!(!message["content"].as_array().unwrap().is_empty());
        }
    }

    #[test]
    fn anthropic_request_to_bedrock_rejects_invalid_requests() {
        assert!(anthropic_request_to_bedrock(&json!(null)).is_err());
        assert!(anthropic_request_to_bedrock(&json!({"messages":[]})).is_err());
        assert!(anthropic_request_to_bedrock(&json!({"model":"x"})).is_err());
        assert!(anthropic_request_to_bedrock(&json!({
            "model":"x",
            "messages":[{"role":"system","content":"bad"}]
        }))
        .is_err());
        assert!(anthropic_request_to_bedrock(&json!({
            "model":"x",
            "messages":[{"content":"bad"}]
        }))
        .is_err());
        assert!(anthropic_request_to_bedrock(&json!({
            "model":"x",
            "messages":[{"role":"user"}]
        }))
        .is_err());
        let empty_user_error = anthropic_request_to_bedrock(&json!({
            "model":"x",
            "messages":[{"role":"user","content":[{"type":"text","text":"   "}]}]
        }))
        .unwrap_err()
        .to_string();
        assert!(empty_user_error.contains("Anthropic user message at messages.0 has empty content"));
    }

    #[test]
    fn bedrock_response_to_anthropic_maps_blocks_and_usage() {
        let response = json!({
            "output": {
                "message": {
                    "content": [
                        {"text":"hello"},
                        {"toolUse":{"toolUseId":"toolu_1","name":"lookup","input":{"q":"rust"}}},
                        {"reasoningContent":{"reasoningText":{"text":"trace","signature":"sig"}}}
                    ]
                }
            },
            "usage": {
                "inputTokens": 100,
                "outputTokens": 20,
                "cacheReadInputTokens": 80,
                "cacheWriteInputTokens": 40
            },
            "stopReason": "end_turn"
        });
        let anthropic = bedrock_response_to_anthropic(&response, "Atlas Sonnet 4.5");
        assert_eq!(anthropic["role"], json!("assistant"));
        assert_eq!(anthropic["model"], json!("Atlas Sonnet 4.5"));
        assert_eq!(anthropic["content"][0]["text"], json!("hello"));
        assert_eq!(anthropic["content"][1]["type"], json!("tool_use"));
        assert_eq!(anthropic["content"][2]["signature"], json!("sig"));
        assert_eq!(anthropic["usage"]["cache_read_input_tokens"], json!(80));
        assert_eq!(anthropic["usage"]["cache_creation_input_tokens"], json!(40));
        assert_eq!(anthropic["stop_reason"], json!("end_turn"));

        let minimal = bedrock_response_to_anthropic(
            &json!({
                "output": {
                    "message": {
                        "content": [
                            {"reasoningContent":{"reasoningText":{"text":"trace"}}}
                        ]
                    }
                },
                "usage": {
                    "inputTokens": 1,
                    "outputTokens": 2
                }
            }),
            "Atlas",
        );
        assert_eq!(minimal["content"][0]["thinking"], json!("trace"));
        assert!(minimal["content"][0].get("signature").is_none());
        assert!(minimal["usage"].get("cache_read_input_tokens").is_none());

        let redacted_only = bedrock_response_to_anthropic(
            &json!({
                "output": {
                    "message": {
                        "content": [
                            {"reasoningContent":{"redactedContent":"YWJj"}},
                            {"text":"visible"}
                        ]
                    }
                }
            }),
            "Atlas",
        );
        // Redacted-only reasoning now surfaces as a redacted_thinking block so
        // compliant clients can echo it back (previously it was dropped).
        assert_eq!(
            redacted_only["content"],
            json!([
                {"type":"redacted_thinking","data":"YWJj"},
                {"type":"text","text":"visible"}
            ])
        );

        let mixed_reasoning = bedrock_response_to_anthropic(
            &json!({
                "output": {
                    "message": {
                        "content": [
                            {"reasoningContent":{"reasoningText":{"text":"trace","signature":"sig"},"redactedContent":"YWJj"}}
                        ]
                    }
                }
            }),
            "Atlas",
        );
        assert_eq!(mixed_reasoning["content"][0]["thinking"], json!("trace"));
        assert_eq!(mixed_reasoning["content"][0]["signature"], json!("sig"));

        let empty_reasoning = bedrock_response_to_anthropic(
            &json!({
                "output": {
                    "message": {
                        "content": [
                            {"toolUse":{"toolUseId":"toolu_2","name":"lookup"}},
                            {"reasoningContent":{"reasoningText":{}}}
                        ]
                    }
                }
            }),
            "Atlas",
        );
        assert_eq!(empty_reasoning["content"][0]["type"], json!("tool_use"));
        assert_eq!(empty_reasoning["content"][0]["input"], json!({}));
        assert_eq!(empty_reasoning["content"][1]["type"], json!("thinking"));
    }

    #[test]
    fn proxy_and_response_headers_cover_success_and_failure_paths() {
        let headers = proxy_headers(
            "key",
            &ResolvedProviderHeaders {
                user_id: "user".to_string(),
                redact_allow: "*".to_string(),
                app_id: "app".to_string(),
                track: "dev".to_string(),
                log_request: "false".to_string(),
                log_response: "false".to_string(),
                content_type: "application/json".to_string(),
            },
        )
        .unwrap();
        assert_eq!(headers.get("authorization").unwrap(), "Bearer key");
        assert_eq!(headers.get("x-portico-userid").unwrap(), "user");
        assert!(proxy_headers(
            "bad\nkey",
            &ResolvedProviderHeaders {
                user_id: "user".to_string(),
                redact_allow: "*".to_string(),
                app_id: "app".to_string(),
                track: "dev".to_string(),
                log_request: "false".to_string(),
                log_response: "false".to_string(),
                content_type: "application/json".to_string(),
            }
        )
        .is_err());

        let mut upstream = HeaderMap::new();
        upstream.insert("x-portico-cost-usd", HeaderValue::from_static("0.01"));
        upstream.insert("x-request-id", HeaderValue::from_static("req_1"));
        upstream.insert("retry-after", HeaderValue::from_static("3"));
        upstream.insert("x-amzn-requestid", HeaderValue::from_static("aws-req"));
        let translated = response_headers_from_upstream(&upstream);
        assert_eq!(
            translated.get("anthropic-version").unwrap(),
            ANTHROPIC_API_VERSION
        );
        assert_eq!(translated.get("x-portico-cost-usd").unwrap(), "0.01");
        assert_eq!(translated.get("retry-after").unwrap(), "3");
        assert_eq!(translated.get("x-amzn-requestid").unwrap(), "aws-req");
        assert!(proxy_headers(
            "key",
            &ResolvedProviderHeaders {
                user_id: "user".to_string(),
                redact_allow: "bad\nvalue".to_string(),
                app_id: "app".to_string(),
                track: "dev".to_string(),
                log_request: "false".to_string(),
                log_response: "false".to_string(),
                content_type: "application/json".to_string(),
            }
        )
        .is_err());
        assert!(proxy_headers(
            "key",
            &ResolvedProviderHeaders {
                user_id: "user".to_string(),
                redact_allow: "*".to_string(),
                app_id: "app".to_string(),
                track: "bad\ntrack".to_string(),
                log_request: "false".to_string(),
                log_response: "false".to_string(),
                content_type: "application/json".to_string(),
            }
        )
        .is_err());
        assert!(proxy_headers(
            "key",
            &ResolvedProviderHeaders {
                user_id: "user".to_string(),
                redact_allow: "*".to_string(),
                app_id: "bad\napp".to_string(),
                track: "dev".to_string(),
                log_request: "false".to_string(),
                log_response: "false".to_string(),
                content_type: "application/json".to_string(),
            }
        )
        .is_err());
    }

    #[test]
    fn stream_translation_covers_text_tool_reasoning_metadata_and_exceptions() {
        let mut state = StreamTranslationState::new("atlas-model".to_string());

        let message_start = translate_bedrock_stream_chunk(
            &json!({"messageStart":{"role":"assistant"}}),
            &mut state,
        );
        assert_eq!(message_start[0].0, "message_start");

        let tool_start = translate_bedrock_stream_chunk(
            &json!({"contentBlockStart":{"contentBlockIndex":1,"start":{"toolUse":{"toolUseId":"toolu_1","name":"lookup"}}}}),
            &mut state,
        );
        assert_eq!(tool_start[0].0, "content_block_start");
        assert_eq!(tool_start[0].1["content_block"]["type"], json!("tool_use"));

        let text_delta = translate_bedrock_stream_chunk(
            &json!({"contentBlockDelta":{"contentBlockIndex":0,"delta":{"text":"hi"}}}),
            &mut state,
        );
        assert_eq!(text_delta.len(), 2);
        assert_eq!(text_delta[1].1["delta"]["text"], json!("hi"));
        let empty_text_delta = translate_bedrock_stream_chunk(
            &json!({"contentBlockDelta":{"contentBlockIndex":3,"delta":{"text":""}}}),
            &mut state,
        );
        assert_eq!(empty_text_delta.len(), 1);
        assert_eq!(empty_text_delta[0].0, "content_block_start");

        let tool_delta = translate_bedrock_stream_chunk(
            &json!({"contentBlockDelta":{"contentBlockIndex":1,"delta":{"toolUse":{"input":"{\"q\":\"rust\"}"}}}}),
            &mut state,
        );
        assert_eq!(
            tool_delta[0].1["delta"]["partial_json"],
            json!("{\"q\":\"rust\"}")
        );
        let fresh_tool_delta = translate_bedrock_stream_chunk(
            &json!({"contentBlockDelta":{"contentBlockIndex":8,"delta":{"toolUse":{"toolUseId":"toolu_8","name":"lookup","input":"{\"q\":\"fresh\"}"}}}}),
            &mut StreamTranslationState::new("atlas-model".to_string()),
        );
        assert_eq!(fresh_tool_delta[0].0, "message_start");
        assert_eq!(fresh_tool_delta[1].0, "content_block_start");
        assert_eq!(
            fresh_tool_delta[1].1["content_block"]["type"],
            json!("tool_use")
        );
        assert_eq!(
            fresh_tool_delta[1].1["content_block"]["id"],
            json!("toolu_8")
        );
        assert_eq!(
            fresh_tool_delta[1].1["content_block"]["name"],
            json!("lookup")
        );
        assert_eq!(fresh_tool_delta[2].0, "content_block_delta");
        assert_eq!(
            fresh_tool_delta[2].1["delta"]["partial_json"],
            json!("{\"q\":\"fresh\"}")
        );
        let block_start_without_tool = translate_bedrock_stream_chunk(
            &json!({"contentBlockStart":{"contentBlockIndex":9,"start":{}}}),
            &mut state,
        );
        assert!(block_start_without_tool.is_empty());

        let reasoning_delta = translate_bedrock_stream_chunk(
            &json!({"contentBlockDelta":{"contentBlockIndex":2,"delta":{"reasoningContent":{"text":"trace","signature":"sig"}}}}),
            &mut state,
        );
        assert_eq!(reasoning_delta.len(), 3);
        assert_eq!(reasoning_delta[1].1["delta"]["thinking"], json!("trace"));
        assert_eq!(reasoning_delta[2].1["delta"]["signature"], json!("sig"));

        let block_stop = translate_bedrock_stream_chunk(
            &json!({"contentBlockStop":{"contentBlockIndex":2}}),
            &mut state,
        );
        assert_eq!(block_stop[0].0, "content_block_stop");
        assert!(translate_bedrock_stream_chunk(
            &json!({"contentBlockStop":{"contentBlockIndex":99}}),
            &mut state,
        )
        .is_empty());

        let message_stop = translate_bedrock_stream_chunk(
            &json!({"messageStop":{"stopReason":"max_tokens"}}),
            &mut state,
        );
        assert_eq!(
            message_stop[0].1["delta"]["stop_reason"],
            json!("max_tokens")
        );
        assert!(translate_bedrock_stream_chunk(
            &json!({"messageStop":{}}),
            &mut StreamTranslationState::new("atlas-model".to_string()),
        )
        .is_empty());

        let metadata = translate_bedrock_stream_chunk(
            &json!({"metadata":{"usage":{"inputTokens":10,"outputTokens":4,"cacheReadInputTokens":5,"cacheWriteInputTokens":2}}}),
            &mut state,
        );
        assert_eq!(metadata[0].1["usage"]["cache_read_input_tokens"], json!(5));
        assert_eq!(metadata[1].0, "message_stop");
        assert!(flush_bedrock_stream_state(&mut state).is_empty());
        let metadata_defaults = translate_bedrock_stream_chunk(
            &json!({"metadata":{"usage":{}}}),
            &mut StreamTranslationState::new("atlas-model".to_string()),
        );
        assert_eq!(metadata_defaults.len(), 1);
        assert_eq!(metadata_defaults[0].1["usage"]["input_tokens"], json!(0));
        assert_eq!(metadata_defaults[0].1["usage"]["output_tokens"], json!(0));

        let error = translate_bedrock_stream_chunk(
            &json!({"validationException":{"message":"bad request"}}),
            &mut StreamTranslationState::new("atlas".to_string()),
        );
        assert_eq!(error[0].0, "error");
        assert_eq!(error[0].1["error"]["message"], json!("bad request"));

        let empty_tool_delta = translate_bedrock_stream_chunk(
            &json!({"contentBlockDelta":{"contentBlockIndex":1,"delta":{"toolUse":{"input":""}}}}),
            &mut state,
        );
        assert!(empty_tool_delta.is_empty());

        let empty_reasoning = translate_bedrock_stream_chunk(
            &json!({"contentBlockDelta":{"contentBlockIndex":4,"delta":{"reasoningContent":{}}}}),
            &mut state,
        );
        assert!(empty_reasoning.is_empty());

        let metadata_only_stop = translate_bedrock_stream_chunk(
            &json!({"metadata":{"foo":"bar"}}),
            &mut StreamTranslationState {
                pending_stop_reason: Some("end_turn".to_string()),
                ..StreamTranslationState::new("atlas".to_string())
            },
        );
        assert_eq!(metadata_only_stop[0].0, "message_stop");

        let fallback_error = translate_bedrock_stream_chunk(
            &json!({"internalServerException":{"detail":"broken"}}),
            &mut StreamTranslationState::new("atlas".to_string()),
        );
        assert_eq!(
            fallback_error[0].1["error"]["message"],
            json!(r#"{"detail":"broken"}"#)
        );

        assert!(translate_bedrock_stream_chunk(&json!({"other":"value"}), &mut state).is_empty());
        assert!(translate_bedrock_stream_chunk(
            &json!({"contentBlockDelta":{"contentBlockIndex":4,"delta":{"other":"value"}}}),
            &mut state,
        )
        .is_empty());
    }

    #[test]
    fn stream_translation_rejects_tool_use_stop_without_tool_block() {
        let mut malformed_state = StreamTranslationState::new("atlas-model".to_string());
        let reasoning = translate_bedrock_stream_chunk(
            &json!({"contentBlockDelta":{"contentBlockIndex":0,"delta":{"reasoningContent":{"text":"thinking only"}}}}),
            &mut malformed_state,
        );
        assert!(reasoning
            .iter()
            .any(|(event_name, _)| event_name == "content_block_delta"));

        let malformed_stop = translate_bedrock_stream_chunk(
            &json!({"messageStop":{"stopReason":"tool_use"}}),
            &mut malformed_state,
        );
        assert_eq!(malformed_stop.len(), 1);
        assert_eq!(malformed_stop[0].0, "error");
        assert_eq!(
            malformed_stop[0].1["error"]["code"],
            json!(BEDROCK_MALFORMED_TOOL_USE_ERROR_KIND)
        );
        assert!(malformed_stop[0].1["error"]["message"]
            .as_str()
            .unwrap()
            .contains("stopReason=tool_use"));
        assert_eq!(
            malformed_state.final_stop_reason.as_deref(),
            Some(BEDROCK_MALFORMED_TOOL_USE_STOP_REASON)
        );
        assert!(malformed_state.pending_stop_reason.is_none());
        assert!(malformed_state.stream_error_message.is_some());
        assert!(malformed_state.message_stop_observed);
        assert_eq!(malformed_state.raw_stop_reason.as_deref(), Some("tool_use"));
        assert!(!malformed_state.message_stop_emitted);

        let metadata_after_error = translate_bedrock_stream_chunk(
            &json!({"metadata":{"usage":{"inputTokens":10,"outputTokens":2}}}),
            &mut malformed_state,
        );
        assert!(metadata_after_error.is_empty());
        assert_eq!(malformed_state.raw_chunk_count, 2);

        let mut valid_state = StreamTranslationState::new("atlas-model".to_string());
        translate_bedrock_stream_chunk(
            &json!({"contentBlockStart":{"contentBlockIndex":0,"start":{"toolUse":{"toolUseId":"toolu_1","name":"lookup"}}}}),
            &mut valid_state,
        );
        let valid_stop = translate_bedrock_stream_chunk(
            &json!({"messageStop":{"stopReason":"tool_use"}}),
            &mut valid_state,
        );
        assert_eq!(valid_stop[0].1["delta"]["stop_reason"], json!("tool_use"));
        assert!(valid_state.stream_error_message.is_none());
        assert!(valid_state.message_stop_observed);
        assert_eq!(valid_state.raw_stop_reason.as_deref(), Some("tool_use"));
        let valid_metadata = translate_bedrock_stream_chunk(
            &json!({"metadata":{"usage":{"inputTokens":10,"outputTokens":2}}}),
            &mut valid_state,
        );
        assert!(valid_metadata
            .iter()
            .any(|(event_name, _)| event_name == "message_stop"));
        assert!(valid_state.message_stop_emitted);
    }

    #[test]
    fn interleaved_stream_translation_states_remain_isolated() {
        let mut malformed_state = StreamTranslationState::new("atlas-model".to_string());
        let mut valid_state = StreamTranslationState::new("atlas-model".to_string());

        translate_bedrock_stream_chunk(
            &json!({"contentBlockDelta":{"contentBlockIndex":0,"delta":{"reasoningContent":{"text":"thinking only"}}}}),
            &mut malformed_state,
        );
        translate_bedrock_stream_chunk(
            &json!({"contentBlockStart":{"contentBlockIndex":1,"start":{"toolUse":{"toolUseId":"toolu_valid","name":"lookup"}}}}),
            &mut valid_state,
        );
        translate_bedrock_stream_chunk(
            &json!({"contentBlockDelta":{"contentBlockIndex":1,"delta":{"toolUse":{"input":"{\"q\":\"ok\"}"}}}}),
            &mut valid_state,
        );

        let malformed_stop = translate_bedrock_stream_chunk(
            &json!({"messageStop":{"stopReason":"tool_use"}}),
            &mut malformed_state,
        );
        let valid_stop = translate_bedrock_stream_chunk(
            &json!({"messageStop":{"stopReason":"tool_use"}}),
            &mut valid_state,
        );

        assert_eq!(malformed_stop[0].0, "error");
        assert_eq!(malformed_state.tool_use_blocks, 0);
        assert_eq!(
            malformed_state.final_stop_reason.as_deref(),
            Some(BEDROCK_MALFORMED_TOOL_USE_STOP_REASON)
        );
        assert_eq!(valid_stop[0].0, "message_delta");
        assert_eq!(valid_state.tool_use_blocks, 1);
        assert_eq!(valid_state.tool_input_delta_events, 1);
        assert_eq!(valid_state.final_stop_reason.as_deref(), Some("tool_use"));
        assert!(valid_state.stream_error_message.is_none());
    }

    #[test]
    fn stream_translation_buffers_signature_only_reasoning_and_ignores_redacted_only_blocks() {
        let mut state = StreamTranslationState::new("atlas-model".to_string());

        let signature_only = translate_bedrock_stream_chunk(
            &json!({"contentBlockDelta":{"contentBlockIndex":0,"delta":{"reasoningContent":{"signature":"sig"}}}}),
            &mut state,
        );
        assert_eq!(signature_only.len(), 1);
        assert_eq!(signature_only[0].0, "message_start");
        assert_eq!(
            state
                .pending_reasoning_signatures
                .get(&0)
                .map(String::as_str),
            Some("sig")
        );

        let text_after_signature = translate_bedrock_stream_chunk(
            &json!({"contentBlockDelta":{"contentBlockIndex":0,"delta":{"reasoningContent":{"text":"trace"}}}}),
            &mut state,
        );
        assert_eq!(text_after_signature.len(), 3);
        assert_eq!(text_after_signature[0].0, "content_block_start");
        assert_eq!(
            text_after_signature[1].1["delta"]["thinking"],
            json!("trace")
        );
        assert_eq!(
            text_after_signature[2].1["delta"]["signature"],
            json!("sig")
        );
        assert!(state.pending_reasoning_signatures.get(&0).is_none());

        let redacted_only = translate_bedrock_stream_chunk(
            &json!({"contentBlockDelta":{"contentBlockIndex":1,"delta":{"reasoningContent":{"redactedContent":"YWJj"}}}}),
            &mut state,
        );
        assert!(redacted_only.is_empty());
        assert_eq!(state.redacted_reasoning_events, 1);
        assert_eq!(state.redacted_reasoning_chars, 4);

        let mixed_reasoning = translate_bedrock_stream_chunk(
            &json!({"contentBlockDelta":{"contentBlockIndex":2,"delta":{"reasoningContent":{"redactedContent":"eHl6","text":"visible"}}}}),
            &mut state,
        );
        assert_eq!(mixed_reasoning.len(), 2);
        assert_eq!(mixed_reasoning[0].0, "content_block_start");
        assert_eq!(mixed_reasoning[1].1["delta"]["thinking"], json!("visible"));
        assert_eq!(state.redacted_reasoning_events, 2);
        assert_eq!(state.redacted_reasoning_chars, 8);

        let pending_signature_state = &mut StreamTranslationState::new("atlas-model".to_string());
        let _ = translate_bedrock_stream_chunk(
            &json!({"contentBlockDelta":{"contentBlockIndex":5,"delta":{"reasoningContent":{"signature":"sig-stop"}}}}),
            pending_signature_state,
        );
        assert!(translate_bedrock_stream_chunk(
            &json!({"contentBlockStop":{"contentBlockIndex":5}}),
            pending_signature_state,
        )
        .is_empty());
        assert!(pending_signature_state
            .pending_reasoning_signatures
            .is_empty());
    }

    #[test]
    fn stream_translation_deduplicates_cumulative_reasoning_text() {
        let mut state = StreamTranslationState::new("atlas-model".to_string());

        let first = translate_bedrock_stream_chunk(
            &json!({"contentBlockDelta":{"contentBlockIndex":0,"delta":{"reasoningContent":{"text":"I need"}}}}),
            &mut state,
        );
        assert_eq!(first.len(), 3);
        assert_eq!(first[0].0, "message_start");
        assert_eq!(first[1].0, "content_block_start");
        assert_eq!(first[2].1["delta"]["thinking"], json!("I need"));

        let cumulative = translate_bedrock_stream_chunk(
            &json!({"contentBlockDelta":{"contentBlockIndex":0,"delta":{"reasoningContent":{"text":"I need to review"}}}}),
            &mut state,
        );
        assert_eq!(cumulative.len(), 1);
        assert_eq!(cumulative[0].1["delta"]["thinking"], json!(" to review"));

        let duplicate = translate_bedrock_stream_chunk(
            &json!({"contentBlockDelta":{"contentBlockIndex":0,"delta":{"reasoningContent":{"text":"I need to review"}}}}),
            &mut state,
        );
        assert!(duplicate.is_empty());

        let duplicate_with_signature = translate_bedrock_stream_chunk(
            &json!({"contentBlockDelta":{"contentBlockIndex":0,"delta":{"reasoningContent":{"text":"I need to review","signature":"sig"}}}}),
            &mut state,
        );
        assert_eq!(duplicate_with_signature.len(), 1);
        assert_eq!(
            duplicate_with_signature[0].1["delta"]["signature"],
            json!("sig")
        );

        let true_delta = translate_bedrock_stream_chunk(
            &json!({"contentBlockDelta":{"contentBlockIndex":0,"delta":{"reasoningContent":{"text":" the table"}}}}),
            &mut state,
        );
        assert_eq!(true_delta.len(), 1);
        assert_eq!(true_delta[0].1["delta"]["thinking"], json!(" the table"));

        let cumulative_after_true_delta = translate_bedrock_stream_chunk(
            &json!({"contentBlockDelta":{"contentBlockIndex":0,"delta":{"reasoningContent":{"text":"I need to review the table carefully"}}}}),
            &mut state,
        );
        assert_eq!(cumulative_after_true_delta.len(), 1);
        assert_eq!(
            cumulative_after_true_delta[0].1["delta"]["thinking"],
            json!(" carefully")
        );
        assert_eq!(state.thinking_delta_events, 4);
        assert_eq!(
            state.thinking_delta_chars,
            "I need to review the table carefully".chars().count()
        );

        let block_stop = translate_bedrock_stream_chunk(
            &json!({"contentBlockStop":{"contentBlockIndex":0}}),
            &mut state,
        );
        assert_eq!(block_stop[0].0, "content_block_stop");
        assert!(state.emitted_reasoning_text_by_block.is_empty());
    }

    #[test]
    fn flush_and_stop_reason_helpers_cover_empty_cases() {
        assert_eq!(map_stop_reason(Some("stop")), Some("stop".to_string()));
        assert_eq!(map_stop_reason(None), None);

        let mut state = StreamTranslationState::new("atlas".to_string());
        state.pending_stop_reason = Some("stop".to_string());
        assert_eq!(
            flush_bedrock_stream_state(&mut state),
            vec![("message_stop".to_string(), json!({"type":"message_stop"}))]
        );
        assert!(flush_bedrock_stream_state(&mut state).is_empty());
    }

    #[test]
    fn synthesize_eof_errors_for_reasoning_only_stream_without_terminal_event() {
        let mut state = StreamTranslationState::new("atlas".to_string());
        let _ = translate_bedrock_stream_chunk(
            &json!({"contentBlockDelta":{"contentBlockIndex":0,"delta":{"reasoningContent":{"text":"thinking only"}}}}),
            &mut state,
        );

        let synthesized = synthesize_bedrock_stream_eof(&mut state);

        assert_eq!(synthesized.len(), 1);
        assert_eq!(synthesized[0].0, "error");
        assert_eq!(
            state.final_stop_reason.as_deref(),
            Some("incomplete_stream")
        );
        assert!(state.stream_error_message.is_some());
        assert!(!state.message_stop_emitted);
        assert!(synthesized[0].1["error"]["message"]
            .as_str()
            .unwrap()
            .contains("without message_stop"));
    }

    #[test]
    fn synthesize_eof_preserves_partial_text_with_incomplete_stream_stop() {
        let mut state = StreamTranslationState::new("atlas".to_string());
        let _ = translate_bedrock_stream_chunk(
            &json!({"contentBlockDelta":{"contentBlockIndex":0,"delta":{"text":"partial"}}}),
            &mut state,
        );

        let synthesized = synthesize_bedrock_stream_eof(&mut state);

        assert_eq!(synthesized.len(), 3);
        assert_eq!(synthesized[0].0, "content_block_stop");
        assert_eq!(synthesized[1].0, "message_delta");
        assert_eq!(
            synthesized[1].1["delta"]["stop_reason"],
            json!("incomplete_stream")
        );
        assert_eq!(synthesized[2].0, "message_stop");
        assert_eq!(
            state.final_stop_reason.as_deref(),
            Some("incomplete_stream")
        );
        assert!(state.message_stop_emitted);
    }
}
