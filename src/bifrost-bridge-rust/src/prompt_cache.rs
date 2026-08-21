use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

use crate::catalog::{ModelEntry, ProviderKind};

const CLAUDE_SONNET_BUDGET: [(&str, i64); 4] = [
    ("low", 1024),
    ("medium", 10000),
    ("high", 20000),
    ("max", 31999),
];

const CLAUDE_OPUS_BUDGET: [(&str, i64); 4] = [
    ("low", 1024),
    ("medium", 10000),
    ("high", 20000),
    ("max", 31999),
];

const CLAUDE_HAIKU_BUDGET: [(&str, i64); 4] = [
    ("low", 1024),
    ("medium", 10000),
    ("high", 20000),
    ("max", 31999),
];

const CLAUDE_DEFAULT_BUDGET: [(&str, i64); 4] = [
    ("low", 1024),
    ("medium", 10000),
    ("high", 16000),
    ("max", 28000),
];

// Temporary carryovers from the Bifrost Claude path until the Bifrost
// parity audit decides whether Bedrock still needs either beta on this route.
const CLAUDE_CARRIED_FORWARD_BETA_FLAGS: [&str; 2] = [
    "fine-grained-tool-streaming-2025-05-14",
    "interleaved-thinking-2025-05-14",
];

fn sha256_hex(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    hex::encode(hasher.finalize())
}

fn cache_key_model_slug(model: &str) -> String {
    let normalized: String = model
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(|ch| ch.to_lowercase())
        .collect();
    let slug = normalized.chars().take(12).collect::<String>();
    if slug.is_empty() {
        "model".to_string()
    } else {
        slug
    }
}

fn message_text_content(message: &Value) -> Option<String> {
    let content = message.get("content")?;
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    let mut combined = String::new();
    if let Some(blocks) = content.as_array() {
        for block in blocks {
            if let Some(text) = block.get("text").and_then(Value::as_str) {
                combined.push_str(text);
            } else if let Some(thinking) = block.get("thinking").and_then(Value::as_str) {
                combined.push_str(thinking);
            }
        }
    }
    if combined.is_empty() {
        None
    } else {
        Some(combined)
    }
}

fn message_contains_marker(message: &Value, marker: &str) -> bool {
    message_text_content(message)
        .map(|text| text.contains(marker))
        .unwrap_or(false)
}

fn is_dynamic_context_message(message: &Value) -> bool {
    message_contains_marker(message, "<dynamic_context>")
}

fn is_static_context_message(message: &Value) -> bool {
    message_contains_marker(message, "<static_context>")
}

fn is_cacheable_claude_system_message(message: &Value) -> bool {
    message.get("role").and_then(Value::as_str) == Some("system")
        && !is_dynamic_context_message(message)
}

fn shape_openai_messages_for_prompt_caching(messages: &[Value]) -> Vec<Value> {
    messages.to_vec()
}

fn shape_claude_messages_for_prompt_caching(messages: &[Value]) -> Vec<Value> {
    let leading_system_count = messages
        .iter()
        .take_while(|message| message.get("role").and_then(Value::as_str) == Some("system"))
        .count();
    if leading_system_count <= 1 {
        return messages.to_vec();
    }

    let mut ordered = Vec::with_capacity(messages.len());
    let mut dynamic_system_messages = Vec::new();
    let mut middle_system_messages = Vec::new();

    for message in messages.iter().take(leading_system_count) {
        if is_static_context_message(message) {
            ordered.push(message.clone());
        } else if is_dynamic_context_message(message) {
            dynamic_system_messages.push(message.clone());
        } else {
            middle_system_messages.push(message.clone());
        }
    }

    ordered.extend(middle_system_messages);
    ordered.extend(dynamic_system_messages);
    ordered.extend_from_slice(&messages[leading_system_count..]);
    ordered
}

fn stable_openai_cache_messages(messages: &[Value]) -> Vec<Value> {
    let mut stable: Vec<Value> = messages
        .iter()
        .filter(|message| !is_dynamic_context_message(message))
        .cloned()
        .collect();
    if stable.len() > 1 {
        stable.pop();
    }
    stable
}

fn canonicalize_value(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let ordered: BTreeMap<String, Value> = map
                .iter()
                .map(|(key, value)| (key.clone(), canonicalize_value(value)))
                .collect();
            let mut object = Map::new();
            for (key, value) in ordered {
                object.insert(key, value);
            }
            Value::Object(object)
        }
        Value::Array(items) => Value::Array(items.iter().map(canonicalize_value).collect()),
        _ => value.clone(),
    }
}

fn stable_json_dumps(value: &Value) -> String {
    serde_json::to_string(&canonicalize_value(value))
        .expect("serializing serde_json::Value should be infallible")
}

fn normalize_prompt_cache_affinity(value: &Value) -> Option<String> {
    let raw = value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string());
    let normalized = raw.trim().to_lowercase();
    if normalized.is_empty() {
        return None;
    }
    if normalized
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, ':' | '_' | '-'))
        && normalized.len() <= 96
    {
        return Some(normalized);
    }
    Some(sha256_hex(&normalized)[..40].to_string())
}

pub(crate) fn extract_prompt_cache_affinity(body: &Value) -> Option<String> {
    for key in ["chat_id", "conversation_id", "thread_id", "session_id"] {
        if let Some(value) = body.get(key).and_then(normalize_prompt_cache_affinity) {
            return Some(value);
        }
    }
    if let Some(metadata) = body.get("metadata").and_then(Value::as_object) {
        for key in ["chat_id", "conversation_id", "thread_id", "session_id"] {
            if let Some(value) = metadata.get(key).and_then(normalize_prompt_cache_affinity) {
                return Some(value);
            }
        }
        if let Some(params) = metadata.get("params").and_then(Value::as_object) {
            for key in ["chat_id", "conversation_id", "thread_id", "session_id"] {
                if let Some(value) = params.get(key).and_then(normalize_prompt_cache_affinity) {
                    return Some(value);
                }
            }
        }
    }
    None
}

fn is_openai_prompt_caching_model(model: &str) -> bool {
    let model = model.to_lowercase();
    model.starts_with("gpt-5") || model.starts_with("gpt-4.1")
}

fn is_gpt_56_model(model: &str) -> bool {
    model.to_lowercase().contains("gpt-5.6")
}

fn is_gpt_56_sol_pro_model(model: &str) -> bool {
    let lower = model.to_lowercase();
    lower.contains("gpt-5.6-sol-pro") || lower.contains("gpt-5.6 sol pro")
}

fn supports_openai_reasoning_model(model: &str) -> bool {
    let model = model.to_lowercase();
    model.starts_with("gpt-5")
}

fn supports_gemini_reasoning_model(model: &str) -> bool {
    model.to_lowercase().starts_with("gemini-")
}

fn budget_for_model(model: &str, effort: &str) -> i64 {
    let lower = model.to_lowercase();
    let table = if lower.contains("opus") {
        &CLAUDE_OPUS_BUDGET
    } else if lower.contains("haiku") {
        &CLAUDE_HAIKU_BUDGET
    } else if lower.contains("sonnet") || lower.contains("claude") {
        &CLAUDE_SONNET_BUDGET
    } else {
        &CLAUDE_DEFAULT_BUDGET
    };
    table
        .iter()
        .find(|(key, _)| *key == effort)
        .map(|(_, value)| *value)
        .unwrap_or(10000)
}

const REJECTED_GPT_EFFORT: &str = "__portico_rejected_reasoning_effort__";

fn map_gpt_effort(model: &str, effort: &str) -> Option<&'static str> {
    let lower = model.to_lowercase();
    if lower.contains("gpt-5.6") {
        return match effort {
            "none" => Some("none"),
            "low" => Some("low"),
            "medium" => Some("medium"),
            "high" => Some("high"),
            "xhigh" => Some("xhigh"),
            "max" => Some("max"),
            // Ultra is a distinct server-side Multi-agent protocol. It must
            // be intercepted before this ordinary Responses transform.
            "ultra" => None,
            _ => None,
        };
    }
    if lower.contains("gpt-5.4-pro") {
        return match effort {
            "low" | "medium" => Some("medium"),
            "high" => Some("high"),
            "max" => Some("xhigh"),
            _ => None,
        };
    }
    if lower.contains("gpt-5.5") || lower.contains("gpt-5.4") || lower.contains("gpt-5.2") {
        return match effort {
            "low" => Some("low"),
            "medium" => Some("medium"),
            "high" => Some("high"),
            "max" => Some("xhigh"),
            _ => None,
        };
    }
    if lower.contains("gpt-5-mini")
        || lower.contains("gpt-5-nano")
        || lower.contains("gpt-5.1")
        || lower.contains("gpt-5")
    {
        return match effort {
            "low" => Some("low"),
            "medium" => Some("medium"),
            "high" | "max" => Some("high"),
            _ => None,
        };
    }
    None
}

fn map_gemini_effort(effort: &str) -> &'static str {
    match effort {
        "low" => "low",
        "medium" => "medium",
        "high" | "max" | "xhigh" => "high",
        _ => "medium",
    }
}

fn is_claude_adaptive_opus_model(model: &str) -> bool {
    let lower = model.to_lowercase();
    lower.contains("opus-4-8")
        || lower.contains("opus-4.8")
        || lower.contains("opus 4.8")
        || lower.contains("opus-4-7")
        || lower.contains("opus-4.7")
        || lower.contains("opus 4.7")
        || lower.contains("opus-4-6")
        || lower.contains("opus-4.6")
        || lower.contains("opus 4.6")
}

fn is_claude_opus_summarized_adaptive_model(model: &str) -> bool {
    let lower = model.to_lowercase();
    lower.contains("opus-4-8")
        || lower.contains("opus-4.8")
        || lower.contains("opus 4.8")
        || lower.contains("opus-4-7")
        || lower.contains("opus-4.7")
        || lower.contains("opus 4.7")
}

fn is_claude_sonnet_46_model(model: &str) -> bool {
    let lower = model.to_lowercase();
    lower.contains("claude-sonnet-4-6")
        || lower.contains("claude-sonnet-4.6")
        || lower.contains("claude sonnet 4.6")
}

// Matches Claude Sonnet 5 only ("claude-sonnet-4-5"/"claude sonnet 4.5" do not
// contain either needle). Sonnet 5 is adaptive-thinking-only: budget_tokens is
// rejected with a 400, thinking display defaults to "omitted", and it supports
// the full effort range including xhigh.
fn is_claude_sonnet_5_model(model: &str) -> bool {
    let lower = model.to_lowercase();
    lower.contains("claude-sonnet-5") || lower.contains("claude sonnet 5")
}

// Matches Claude Opus 5 only ("claude-opus-4-5"/"claude opus 4.5" do not
// contain either needle). Opus 5 is adaptive-thinking-only: budget_tokens is
// rejected with a 400, thinking display defaults to "omitted", and it supports
// the full effort range including xhigh.
fn is_claude_opus_5_model(model: &str) -> bool {
    let lower = model.to_lowercase();
    lower.contains("claude-opus-5") || lower.contains("claude opus 5")
}

fn is_claude_adaptive_thinking_model(model: &str) -> bool {
    is_claude_adaptive_opus_model(model)
        || is_claude_opus_5_model(model)
        || is_claude_sonnet_5_model(model)
}

fn is_claude_summarized_adaptive_model(model: &str) -> bool {
    is_claude_opus_summarized_adaptive_model(model)
        || is_claude_opus_5_model(model)
        || is_claude_sonnet_5_model(model)
}

/// Models with the 4.7+ API surface reject temperature/top_p/top_k with a 400.
fn is_claude_sampling_params_rejected_model(model: &str) -> bool {
    is_claude_summarized_adaptive_model(model)
}

// Gates CLAUDE_CARRIED_FORWARD_BETA_FLAGS (fine-grained tool streaming +
// interleaved thinking) — legacy carryovers kept for the pre-Sonnet-5 Claude
// models. Intentionally excludes Claude Sonnet 5 and Claude Opus 5, which
// start with a clean request body: fine-grained tool streaming is GA on 4.6+
// and interleaved thinking is automatic under adaptive thinking. This has no
// effect on the context window (the 1M window comes from model_info.max_tokens
// in the catalog, not from these flags).
fn is_claude_carried_forward_beta_model(model: &str) -> bool {
    is_claude_sonnet_46_model(model) || is_claude_adaptive_opus_model(model)
}

fn map_claude_adaptive_effort(model: &str, effort: &str) -> &'static str {
    if is_claude_summarized_adaptive_model(model) {
        match effort {
            "low" => "low",
            "medium" => "medium",
            "high" => "high",
            "xhigh" => "xhigh",
            "max" => "max",
            _ => "medium",
        }
    } else {
        match effort {
            "low" => "low",
            "medium" => "medium",
            "high" => "high",
            "max" => "max",
            _ => "medium",
        }
    }
}

fn default_claude_reasoning_effort() -> String {
    // WS4 knob: the bridge historically downgraded unset effort to "medium"
    // while the Anthropic API default is "high". Unset preserves the
    // historical behavior; set BRIDGE_CLAUDE_DEFAULT_EFFORT to change the
    // default for requests that don't specify an effort. Cost note: raising
    // this raises thinking/output token spend on every unset-effort request.
    match std::env::var("BRIDGE_CLAUDE_DEFAULT_EFFORT") {
        Ok(value) => {
            let normalized = value.trim().to_ascii_lowercase();
            match normalized.as_str() {
                "low" | "medium" | "high" | "xhigh" | "max" => normalized,
                _ => "medium".to_string(),
            }
        }
        Err(_) => "medium".to_string(),
    }
}

fn extract_reasoning_effort(body: &Value) -> String {
    body.get("reasoning_effort")
        .and_then(Value::as_str)
        .or_else(|| {
            body.get("params")
                .and_then(Value::as_object)
                .and_then(|params| params.get("reasoning_effort"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            body.get("metadata")
                .and_then(Value::as_object)
                .and_then(|metadata| metadata.get("params"))
                .and_then(Value::as_object)
                .and_then(|params| params.get("reasoning_effort"))
                .and_then(Value::as_str)
        })
        .map(str::to_string)
        .unwrap_or_else(default_claude_reasoning_effort)
}

pub fn extract_service_tier(body: &Value) -> Option<String> {
    body.get("service_tier")
        .and_then(Value::as_str)
        .or_else(|| {
            body.get("params")
                .and_then(Value::as_object)
                .and_then(|params| params.get("service_tier"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            body.get("metadata")
                .and_then(Value::as_object)
                .and_then(|metadata| metadata.get("params"))
                .and_then(Value::as_object)
                .and_then(|params| params.get("service_tier"))
                .and_then(Value::as_str)
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Re-inserts the OpenAI service tier (fast mode) for Responses API models
/// after `apply_prompt_cache_and_reasoning` stripped it from the body. The
/// explicit per-request value wins over the fleet `GPT_SERVICE_TIER` default;
/// an explicit "off" suppresses the fleet default. Values pass verbatim —
/// upstream llm-proxy accounting recognizes the literal "priority".
/// Never configure `service_tier` in the OWUI model registry: registry params
/// merge after Open WebUI flattens per-request params and would override the
/// per-chat toggle.
pub fn apply_openai_service_tier(
    body: &mut Value,
    entry: &ModelEntry,
    chat_tier: Option<&str>,
    env_default: Option<&str>,
) {
    if !matches!(entry.provider_kind, ProviderKind::OpenAI) || !entry.uses_responses_api {
        return;
    }
    let chosen = chat_tier
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| env_default.map(str::trim).filter(|value| !value.is_empty()));
    let Some(chosen) = chosen else {
        return;
    };
    if chosen.eq_ignore_ascii_case("off") {
        return;
    }
    let Some(body_object) = body.as_object_mut() else {
        return;
    };
    body_object.insert(
        "service_tier".to_string(),
        Value::String(chosen.to_string()),
    );
}

fn ensure_message_content_blocks(message: &mut Value) -> Option<&mut Vec<Value>> {
    let object = message.as_object_mut()?;
    let existing_content = object.get("content").cloned();
    match existing_content {
        Some(Value::Array(_)) => object.get_mut("content").and_then(Value::as_array_mut),
        Some(Value::String(text)) => {
            object.insert(
                "content".to_string(),
                Value::Array(vec![json!({"type":"text","text": text})]),
            );
            object.get_mut("content").and_then(Value::as_array_mut)
        }
        None => {
            object.insert(
                "content".to_string(),
                Value::Array(vec![json!({"type":"text","text": ""})]),
            );
            object.get_mut("content").and_then(Value::as_array_mut)
        }
        Some(_) => None,
    }
}

fn cache_control_value(ttl: Option<&str>) -> Value {
    let mut object = Map::new();
    object.insert("type".to_string(), Value::String("ephemeral".to_string()));
    if let Some(ttl) = ttl.map(str::trim).filter(|value| !value.is_empty()) {
        object.insert("ttl".to_string(), Value::String(ttl.to_string()));
    }
    Value::Object(object)
}

fn ensure_cache_control(value: &mut Value, ttl: Option<&str>) {
    let normalized_ttl = ttl.map(str::trim).filter(|value| !value.is_empty());
    let cache_control = cache_control_value(normalized_ttl);
    let Some(object) = value.as_object_mut() else {
        return;
    };
    let existing = object
        .entry("cache_control".to_string())
        .or_insert_with(|| cache_control.clone());
    if let Some(ttl) = normalized_ttl {
        if let Some(existing_object) = existing.as_object_mut() {
            existing_object
                .entry("ttl".to_string())
                .or_insert_with(|| Value::String(ttl.to_string()));
        }
    }
}

fn set_cache_control_on_last_block(blocks: &mut [Value], ttl: Option<&str>) -> bool {
    if let Some(last) = blocks.last_mut() {
        if last.is_object() {
            ensure_cache_control(last, ttl);
            return true;
        }
    }
    false
}

fn apply_cache_control_to_message(messages: &mut [Value], index: usize, ttl: Option<&str>) {
    if let Some(blocks) = ensure_message_content_blocks(&mut messages[index]) {
        let _ = set_cache_control_on_last_block(blocks, ttl);
    }
}

fn requested_output_token_limit(body_object: &Map<String, Value>) -> Option<i64> {
    body_object
        .get("max_output_tokens")
        .and_then(Value::as_i64)
        .or_else(|| {
            body_object
                .get("max_completion_tokens")
                .and_then(Value::as_i64)
        })
        .or_else(|| body_object.get("max_tokens").and_then(Value::as_i64))
}

fn apply_configured_output_token_ceiling(
    body_object: &mut Map<String, Value>,
    configured_max_output_tokens: Option<i64>,
) {
    let Some(configured_ceiling) = configured_max_output_tokens else {
        return;
    };

    let effective_limit = requested_output_token_limit(body_object)
        .map(|requested| requested.min(configured_ceiling))
        .unwrap_or(configured_ceiling);

    body_object.remove("max_output_tokens");
    body_object.remove("max_completion_tokens");
    body_object.insert("max_tokens".to_string(), json!(effective_limit));
}

fn sanitize_claude_reasoning_budget(body_object: &Map<String, Value>, budget_tokens: i64) -> i64 {
    let Some(requested_limit) = requested_output_token_limit(body_object) else {
        return budget_tokens;
    };

    let max_safe_budget = requested_limit - 1;
    if max_safe_budget < 1024 {
        return 0;
    }

    budget_tokens.min(max_safe_budget)
}

fn push_unique_string(target: &mut Vec<String>, value: &str) {
    if !target.iter().any(|existing| existing == value) {
        target.push(value.to_string());
    }
}

fn extend_unique_string_values(target: &mut Vec<String>, value: Option<&Value>) {
    let Some(value) = value else {
        return;
    };

    if let Some(single) = value.as_str() {
        push_unique_string(target, single);
        return;
    }

    let Some(items) = value.as_array() else {
        return;
    };

    for item in items {
        if let Some(single) = item.as_str() {
            push_unique_string(target, single);
        }
    }
}

fn merged_claude_beta_values(
    existing_top_level: Option<&Value>,
    existing_nested: Option<&Value>,
    required: &[&str],
) -> Value {
    let mut merged = Vec::new();
    for value in required {
        push_unique_string(&mut merged, value);
    }
    extend_unique_string_values(&mut merged, existing_top_level);
    extend_unique_string_values(&mut merged, existing_nested);

    Value::Array(merged.into_iter().map(Value::String).collect())
}

fn apply_claude_beta_flags(body_object: &mut Map<String, Value>, model: &str) {
    if !is_claude_carried_forward_beta_model(model) {
        return;
    }

    let existing_top_level = body_object.get("anthropic_beta");
    let existing_nested = body_object
        .get("additionalModelRequestFields")
        .and_then(Value::as_object)
        .and_then(|fields| fields.get("anthropic_beta"));
    let merged = merged_claude_beta_values(
        existing_top_level,
        existing_nested,
        &CLAUDE_CARRIED_FORWARD_BETA_FLAGS,
    );

    body_object.insert("anthropic_beta".to_string(), merged.clone());
    let additional_fields = body_object
        .entry("additionalModelRequestFields".to_string())
        .or_insert_with(|| json!({}));
    if !additional_fields.is_object() {
        *additional_fields = json!({});
    }
    additional_fields
        .as_object_mut()
        .expect("additionalModelRequestFields must be an object after normalization")
        .insert("anthropic_beta".to_string(), merged);
}

// ---------------------------------------------------------------------------
// Tool-spec slimming (tool-compaction parity for Claude/Gemini).
//
// Shrinks each tool DEFINITION (240-char description trim + minimal-schema
// strip) before the canonical sort, for providers that otherwise receive the
// verbatim OWUI specs. Semantics mirror Open WebUI's GPT-only
// `_trim_openai_tool_description` / `_compact_openai_parameter_schema` and the
// transform is idempotent, so an accidental future OWUI-side widening cannot
// change the wire shape twice. Names are never touched: policy layers and the
// follow-up name-intersect stay valid by construction.
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolSlimmingMode {
    /// GPT-parity behavior: parameter-level `description` fields are dropped
    /// (the schema itself still fully specifies the arguments).
    Parity,
    /// Fallback if evals show argument-construction regressions: keep
    /// parameter descriptions, trimmed to 120 chars.
    RetainParamDescriptions,
}

const TOOL_DESCRIPTION_MAX_CHARS: usize = 240;
const PARAM_DESCRIPTION_MAX_CHARS: usize = 120;

#[cfg(test)]
thread_local! {
    static TEST_TOOL_SLIMMING_ENV: std::cell::Cell<Option<Option<bool>>> =
        std::cell::Cell::new(None);
    static TEST_TOOL_SLIMMING_MODE: std::cell::Cell<Option<ToolSlimmingMode>> =
        std::cell::Cell::new(None);
}

#[cfg(test)]
pub fn set_tool_slimming_env_override_for_tests(value: Option<Option<bool>>) {
    TEST_TOOL_SLIMMING_ENV.with(|cell| cell.set(value));
}

#[cfg(test)]
pub fn set_tool_slimming_mode_for_tests(value: Option<ToolSlimmingMode>) {
    TEST_TOOL_SLIMMING_MODE.with(|cell| cell.set(value));
}

fn parse_tool_slimming_env(value: Option<&str>) -> Option<bool> {
    match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        Some("on") | Some("true") | Some("1") | Some("enabled") => Some(true),
        Some("off") | Some("false") | Some("0") | Some("disabled") => Some(false),
        _ => None,
    }
}

fn parse_tool_slimming_mode(value: Option<&str>) -> ToolSlimmingMode {
    match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        Some("retain-param-descriptions") | Some("retain_param_descriptions") => {
            ToolSlimmingMode::RetainParamDescriptions
        }
        _ => ToolSlimmingMode::Parity,
    }
}

/// Fleet-level override from `BRIDGE_TOOL_SLIMMING` (on|off|unset->catalog).
/// Tests never read the real environment: they use the thread-local seam so
/// parallel `cargo test` runs stay deterministic.
fn tool_slimming_env_override() -> Option<bool> {
    #[cfg(test)]
    {
        return TEST_TOOL_SLIMMING_ENV.with(|cell| cell.get()).unwrap_or(None);
    }
    #[cfg(not(test))]
    {
        static CELL: std::sync::OnceLock<Option<bool>> = std::sync::OnceLock::new();
        *CELL.get_or_init(|| {
            parse_tool_slimming_env(std::env::var("BRIDGE_TOOL_SLIMMING").ok().as_deref())
        })
    }
}

/// Slimming mode from `BRIDGE_TOOL_SLIMMING_MODE`
/// (parity|retain-param-descriptions; default parity).
pub fn tool_slimming_mode() -> ToolSlimmingMode {
    #[cfg(test)]
    {
        return TEST_TOOL_SLIMMING_MODE
            .with(|cell| cell.get())
            .unwrap_or(ToolSlimmingMode::Parity);
    }
    #[cfg(not(test))]
    {
        static CELL: std::sync::OnceLock<ToolSlimmingMode> = std::sync::OnceLock::new();
        *CELL.get_or_init(|| {
            parse_tool_slimming_mode(std::env::var("BRIDGE_TOOL_SLIMMING_MODE").ok().as_deref())
        })
    }
}

/// Effective per-request decision: provider must be one the bridge owns
/// slimming for (Claude/Gemini — GPT is slimmed OWUI-side), then the env
/// override wins over the per-alias catalog flag.
pub fn tool_slimming_enabled_for(entry: &ModelEntry) -> bool {
    matches!(
        entry.provider_kind,
        ProviderKind::AnthropicConverse | ProviderKind::GeminiVertex
    ) && tool_slimming_env_override().unwrap_or(entry.tool_slimming)
}

fn slim_description_text(value: &str, max_chars: usize) -> Option<String> {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return None;
    }
    if normalized.chars().count() <= max_chars {
        return Some(normalized);
    }
    let truncated: String = normalized
        .chars()
        .take(max_chars.saturating_sub(3))
        .collect();
    Some(format!("{}...", truncated.trim_end()))
}

fn slim_parameter_schema(schema: &Value, retain_param_descriptions: bool) -> Value {
    match schema {
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| slim_parameter_schema(item, retain_param_descriptions))
                .collect(),
        ),
        Value::Object(object) => {
            let mut compact = Map::new();
            match object.get("type") {
                Some(Value::String(type_name)) => {
                    compact.insert("type".to_string(), Value::String(type_name.clone()));
                }
                Some(Value::Array(entries))
                    if !entries.is_empty() && entries.iter().all(Value::is_string) =>
                {
                    compact.insert("type".to_string(), Value::Array(entries.clone()));
                }
                _ => {}
            }
            if let Some(Value::Array(enum_values)) = object.get("enum") {
                if !enum_values.is_empty() {
                    compact.insert("enum".to_string(), Value::Array(enum_values.clone()));
                }
            }
            if let Some(Value::Array(required)) = object.get("required") {
                let mut names: Vec<String> = required
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect();
                if !names.is_empty() {
                    names.sort();
                    compact.insert(
                        "required".to_string(),
                        Value::Array(names.into_iter().map(Value::String).collect()),
                    );
                }
            }
            if retain_param_descriptions {
                if let Some(Value::String(description)) = object.get("description") {
                    if let Some(slimmed) =
                        slim_description_text(description, PARAM_DESCRIPTION_MAX_CHARS)
                    {
                        compact.insert("description".to_string(), Value::String(slimmed));
                    }
                }
            }
            if let Some(Value::Object(properties)) = object.get("properties") {
                if !properties.is_empty() {
                    let compact_properties: Map<String, Value> = properties
                        .iter()
                        .map(|(key, value)| {
                            (
                                key.clone(),
                                slim_parameter_schema(value, retain_param_descriptions),
                            )
                        })
                        .collect();
                    compact.insert("properties".to_string(), Value::Object(compact_properties));
                }
            }
            match object.get("items") {
                None | Some(Value::Null) => {}
                Some(items) => {
                    compact.insert(
                        "items".to_string(),
                        slim_parameter_schema(items, retain_param_descriptions),
                    );
                }
            }
            match object.get("additionalProperties") {
                Some(Value::Bool(flag)) => {
                    compact.insert("additionalProperties".to_string(), Value::Bool(*flag));
                }
                Some(additional @ Value::Object(_)) => {
                    compact.insert(
                        "additionalProperties".to_string(),
                        slim_parameter_schema(additional, retain_param_descriptions),
                    );
                }
                _ => {}
            }
            for union_key in ["oneOf", "anyOf", "allOf"] {
                if let Some(Value::Array(variants)) = object.get(union_key) {
                    if !variants.is_empty() {
                        compact.insert(
                            union_key.to_string(),
                            Value::Array(
                                variants
                                    .iter()
                                    .map(|variant| {
                                        slim_parameter_schema(variant, retain_param_descriptions)
                                    })
                                    .collect(),
                            ),
                        );
                    }
                }
            }
            if compact.get("type").and_then(Value::as_str) == Some("object")
                && !compact.contains_key("properties")
            {
                compact.insert("properties".to_string(), Value::Object(Map::new()));
            }
            Value::Object(compact)
        }
        other => other.clone(),
    }
}

fn slim_single_tool(tool: &mut Value, mode: ToolSlimmingMode) {
    let retain_param_descriptions = mode == ToolSlimmingMode::RetainParamDescriptions;
    let Some(tool_object) = tool.as_object_mut() else {
        return;
    };
    if tool_object.get("type").and_then(Value::as_str) == Some("function") {
        let Some(function_object) = tool_object.get("function").and_then(Value::as_object) else {
            return;
        };
        // Mirror OWUI's compactor: rebuild the function object keeping only
        // name/description/parameters/strict.
        let mut compact_function = Map::new();
        if let Some(name) = function_object
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
        {
            compact_function.insert("name".to_string(), Value::String(name.to_string()));
        }
        if let Some(description) = function_object
            .get("description")
            .and_then(Value::as_str)
            .and_then(|description| {
                slim_description_text(description, TOOL_DESCRIPTION_MAX_CHARS)
            })
        {
            compact_function.insert("description".to_string(), Value::String(description));
        }
        match function_object.get("parameters") {
            None | Some(Value::Null) => {}
            Some(parameters) if parameters.is_object() || parameters.is_array() => {
                compact_function.insert(
                    "parameters".to_string(),
                    slim_parameter_schema(parameters, retain_param_descriptions),
                );
            }
            Some(parameters) => {
                compact_function.insert("parameters".to_string(), parameters.clone());
            }
        }
        if let Some(Value::Bool(strict)) = function_object.get("strict") {
            compact_function.insert("strict".to_string(), Value::Bool(*strict));
        }
        tool_object.retain(|key, _| key == "type");
        tool_object.insert("function".to_string(), Value::Object(compact_function));
    } else {
        // Bare-name shape (same dual lookup the canonical sort uses): slim
        // description and schema in place, preserving unknown keys.
        if let Some(slimmed) = tool_object
            .get("description")
            .and_then(Value::as_str)
            .and_then(|description| slim_description_text(description, TOOL_DESCRIPTION_MAX_CHARS))
        {
            tool_object.insert("description".to_string(), Value::String(slimmed));
        }
        for schema_key in ["parameters", "input_schema"] {
            if let Some(schema) = tool_object.get(schema_key) {
                if schema.is_object() || schema.is_array() {
                    let slimmed = slim_parameter_schema(schema, retain_param_descriptions);
                    tool_object.insert(schema_key.to_string(), slimmed);
                }
            }
        }
    }
}

/// Slim every tool definition in place. Idempotent; never changes tool names.
pub fn slim_tool_definitions(tools: &mut [Value], mode: ToolSlimmingMode) {
    for tool in tools.iter_mut() {
        slim_single_tool(tool, mode);
    }
}

pub fn apply_prompt_cache_and_reasoning(
    body: &mut Value,
    entry: &ModelEntry,
    prompt_cache_claude_enabled: bool,
    prompt_cache_affinity_override: Option<&str>,
) {
    let requested_effort = extract_reasoning_effort(body);
    let prompt_cache_affinity = prompt_cache_affinity_override
        .map(|value| Value::String(value.to_string()))
        .as_ref()
        .and_then(normalize_prompt_cache_affinity)
        .or_else(|| extract_prompt_cache_affinity(body));

    let Some(body_object) = body.as_object_mut() else {
        return;
    };

    body_object.remove("reasoning_effort");
    // `service_tier` is consumed by the caller (extract_service_tier) and
    // re-inserted only for OpenAI Responses models via
    // apply_openai_service_tier, so it never leaks to Bedrock/Gemini upstreams.
    body_object.remove("service_tier");
    // `params` is Open WebUI's internal request-settings envelope. Supported
    // values are consumed above; the wrapper itself is not valid provider JSON.
    body_object.remove("params");
    for key in ["chat_id", "conversation_id", "thread_id", "session_id"] {
        body_object.remove(key);
    }
    apply_configured_output_token_ceiling(body_object, entry.max_output_tokens);

    if let Some(messages) = body_object
        .get_mut("messages")
        .and_then(Value::as_array_mut)
    {
        let reshaped = match entry.provider_kind {
            ProviderKind::OpenAI => shape_openai_messages_for_prompt_caching(messages),
            ProviderKind::AnthropicConverse => shape_claude_messages_for_prompt_caching(messages),
            ProviderKind::GeminiVertex => shape_openai_messages_for_prompt_caching(messages),
        };
        *messages = reshaped;
    }

    match entry.provider_kind {
        ProviderKind::OpenAI => {
            if is_openai_prompt_caching_model(&entry.alias) {
                let cache_namespace =
                    if entry.base_model == "gpt-5.6-sol" && requested_effort == "ultra" {
                        format!("{}-ultra", cache_key_model_slug(&entry.alias))
                    } else {
                        cache_key_model_slug(&entry.alias)
                    };
                let supplied_cache_key = body_object
                    .get("prompt_cache_key")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty());
                let namespaced_supplied_key = if is_gpt_56_model(&entry.base_model) {
                    supplied_cache_key.map(|value| {
                        format!("owui:{cache_namespace}:caller:{}", &sha256_hex(value)[..40])
                    })
                } else {
                    None
                };
                let should_generate_key = !body_object.contains_key("prompt_cache_key")
                    || is_gpt_56_model(&entry.base_model);
                if let Some(messages) = body_object.get("messages").and_then(Value::as_array) {
                    let prompt_cache_key = if !should_generate_key {
                        None
                    } else if let Some(key) = namespaced_supplied_key {
                        Some(key)
                    } else if let Some(affinity) = prompt_cache_affinity.clone() {
                        Some(format!("owui:{cache_namespace}:{affinity}"))
                    } else {
                        let stable_messages = stable_openai_cache_messages(messages);
                        if stable_messages.is_empty() {
                            None
                        } else {
                            let mut payload = Map::new();
                            payload.insert("model".to_string(), Value::String(entry.alias.clone()));
                            payload.insert("messages".to_string(), Value::Array(stable_messages));
                            if let Some(tools) = body_object.get("tools").cloned() {
                                payload.insert("tools".to_string(), tools);
                            }
                            let digest = sha256_hex(&stable_json_dumps(&Value::Object(payload)));
                            Some(format!("owui:{cache_namespace}:{}", &digest[..40]))
                        }
                    };
                    if let Some(prompt_cache_key) = prompt_cache_key {
                        body_object.insert(
                            "prompt_cache_key".to_string(),
                            Value::String(prompt_cache_key),
                        );
                    }
                }
            }

            if let Some(retention) = &entry.prompt_cache_retention {
                if !body_object.contains_key("prompt_cache_retention")
                    || is_gpt_56_model(&entry.base_model)
                {
                    body_object.insert(
                        "prompt_cache_retention".to_string(),
                        Value::String(retention.clone()),
                    );
                }
            }

            if supports_openai_reasoning_model(&entry.base_model) {
                let mapped_effort = map_gpt_effort(&entry.base_model, &requested_effort)
                    .unwrap_or(REJECTED_GPT_EFFORT);
                let mut reasoning = json!({
                    "effort": mapped_effort,
                    "summary": "auto"
                });
                if is_gpt_56_sol_pro_model(&entry.base_model) {
                    reasoning
                        .as_object_mut()
                        .expect("reasoning configuration must be an object")
                        .insert("mode".to_string(), Value::String("pro".to_string()));
                }
                body_object.insert("reasoning".to_string(), reasoning);
            }
        }
        ProviderKind::AnthropicConverse => {
            apply_claude_beta_flags(body_object, &entry.base_model);

            // Tool-spec slimming runs before the canonical sort and before
            // the last-tool cache_control breakpoint, independent of whether
            // prompt caching is enabled (it reduces tokens either way).
            if tool_slimming_enabled_for(entry) {
                if let Some(tools) = body_object.get_mut("tools").and_then(Value::as_array_mut) {
                    slim_tool_definitions(tools, tool_slimming_mode());
                }
            }

            if prompt_cache_claude_enabled {
                let claude_cache_ttl = entry.claude_prompt_cache_ttl.as_deref();
                body_object
                    .entry("cache_control".to_string())
                    .or_insert_with(|| cache_control_value(claude_cache_ttl));
                if let Some(claude_cache_ttl) = claude_cache_ttl
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    if let Some(cache_control) = body_object
                        .get_mut("cache_control")
                        .and_then(Value::as_object_mut)
                    {
                        cache_control
                            .entry("ttl".to_string())
                            .or_insert_with(|| Value::String(claude_cache_ttl.to_string()));
                    }
                }

                body_object
                    .get_mut("messages")
                    .and_then(Value::as_array_mut)
                    .map(|messages| {
                        let static_index = messages
                            .iter()
                            .enumerate()
                            .rev()
                            .find(|(_, value)| {
                                value.get("role").and_then(Value::as_str) == Some("system")
                                    && message_contains_marker(value, "<static_context>")
                            })
                            .map(|(idx, _)| idx)
                            .or_else(|| {
                                messages
                                    .iter()
                                    .enumerate()
                                    .rev()
                                    .find(|(_, value)| is_cacheable_claude_system_message(value))
                                    .map(|(idx, _)| idx)
                            });
                        if let Some(si) = static_index {
                            apply_cache_control_to_message(messages, si, claude_cache_ttl);
                        }

                        // P1: Use the next system breakpoint on the final stable
                        // system instruction block (typically the combined base
                        // model/custom-agent prompt), which now sits after
                        // static_context and before dynamic_context.
                        let model_prompt_index = messages
                            .iter()
                            .enumerate()
                            .rev()
                            .find(|(_, value)| {
                                is_cacheable_claude_system_message(value)
                                    && !is_static_context_message(value)
                            })
                            .map(|(idx, _)| idx)
                            .or_else(|| {
                                messages.iter().position(is_cacheable_claude_system_message)
                            });
                        if let Some(model_index) = model_prompt_index {
                            if Some(model_index) != static_index {
                                apply_cache_control_to_message(
                                    messages,
                                    model_index,
                                    claude_cache_ttl,
                                );
                            }
                        }
                    });

                // P2: Canonically sort tool definitions by name to prevent
                // ordering-induced cache invalidation from async MCP fetches.
                // Tools sit at the top of Anthropic's cache hierarchy, so any
                // reordering invalidates the entire cache.
                if let Some(tools) = body_object.get_mut("tools").and_then(Value::as_array_mut) {
                    tools.sort_by(|a, b| {
                        let name_a = a
                            .get("function")
                            .and_then(|f| f.get("name"))
                            .and_then(Value::as_str)
                            .or_else(|| a.get("name").and_then(Value::as_str))
                            .unwrap_or("");
                        let name_b = b
                            .get("function")
                            .and_then(|f| f.get("name"))
                            .and_then(Value::as_str)
                            .or_else(|| b.get("name").and_then(Value::as_str))
                            .unwrap_or("");
                        name_a.cmp(&name_b)
                    });
                }

                body_object
                    .get_mut("tools")
                    .and_then(Value::as_array_mut)
                    .and_then(|tools| tools.last_mut().and_then(Value::as_object_mut))
                    .map(|last_tool| {
                        let mut tool = Value::Object(last_tool.clone());
                        ensure_cache_control(&mut tool, claude_cache_ttl);
                        if let Value::Object(updated) = tool {
                            *last_tool = updated;
                        }
                    });
            }

            if is_claude_adaptive_thinking_model(&entry.base_model) {
                body_object.insert(
                    "output_config".to_string(),
                    json!({ "effort": map_claude_adaptive_effort(&entry.base_model, &requested_effort) }),
                );
                let thinking = if is_claude_summarized_adaptive_model(&entry.base_model) {
                    json!({ "type": "adaptive", "display": "summarized" })
                } else {
                    json!({ "type": "adaptive" })
                };
                body_object.insert("thinking".to_string(), thinking);
                if is_claude_sampling_params_rejected_model(&entry.base_model) {
                    // These models reject temperature/top_p/top_k with a 400;
                    // strip them here so the Converse translation never
                    // forwards user-configured sampling params upstream.
                    body_object.remove("temperature");
                    body_object.remove("top_p");
                    body_object.remove("top_k");
                }
            } else {
                let configured_budget_tokens = budget_for_model(&entry.alias, &requested_effort);
                let budget_tokens =
                    sanitize_claude_reasoning_budget(body_object, configured_budget_tokens);
                if budget_tokens > 0 {
                    body_object.insert(
                        "reasoning".to_string(),
                        json!({ "max_tokens": budget_tokens }),
                    );
                } else {
                    body_object.remove("reasoning");
                }
            }
        }
        ProviderKind::GeminiVertex => {
            // Slim while tools are still in OpenAI function format — this is
            // BEFORE Bifrost's conversion to Vertex functionDeclarations and
            // therefore before the 512-declaration cap, which then operates
            // on slimmed definitions.
            if tool_slimming_enabled_for(entry) {
                if let Some(tools) = body_object.get_mut("tools").and_then(Value::as_array_mut) {
                    slim_tool_definitions(tools, tool_slimming_mode());
                }
            }

            if supports_gemini_reasoning_model(&entry.base_model) {
                body_object.insert(
                    "reasoning".to_string(),
                    json!({ "effort": map_gemini_effort(&requested_effort) }),
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn openai_entry(alias: &str, base_model: &str, retention: Option<&str>) -> ModelEntry {
        ModelEntry {
            alias: alias.to_string(),
            base_model: base_model.to_string(),
            provider_model: base_model.to_string(),
            bifrost_model: format!("openai/{base_model}"),
            provider_kind: ProviderKind::OpenAI,
            uses_responses_api: false,
            max_output_tokens: Some(128000),
            prompt_cache_retention: retention.map(str::to_string),
            claude_prompt_cache_ttl: None,
            tool_slimming: false,
        }
    }

    fn anthropic_entry(
        alias: &str,
        base_model: &str,
        max_output_tokens: Option<i64>,
    ) -> ModelEntry {
        ModelEntry {
            alias: alias.to_string(),
            base_model: base_model.to_string(),
            provider_model: base_model.to_string(),
            bifrost_model: format!("anthropic/{base_model}"),
            provider_kind: ProviderKind::AnthropicConverse,
            uses_responses_api: false,
            max_output_tokens,
            prompt_cache_retention: None,
            claude_prompt_cache_ttl: None,
            tool_slimming: false,
        }
    }

    fn gemini_entry(alias: &str, base_model: &str) -> ModelEntry {
        ModelEntry {
            alias: alias.to_string(),
            base_model: base_model.to_string(),
            provider_model: base_model.to_string(),
            bifrost_model: format!("gemini/{base_model}"),
            provider_kind: ProviderKind::GeminiVertex,
            uses_responses_api: false,
            max_output_tokens: Some(65536),
            prompt_cache_retention: None,
            claude_prompt_cache_ttl: None,
            tool_slimming: false,
        }
    }

    fn openai_responses_entry(alias: &str, base_model: &str) -> ModelEntry {
        ModelEntry {
            uses_responses_api: true,
            ..openai_entry(alias, base_model, Some("24h"))
        }
    }

    #[test]
    fn extract_service_tier_reads_top_level_params_and_metadata_in_order() {
        assert_eq!(
            extract_service_tier(&json!({"service_tier": "priority"})).as_deref(),
            Some("priority")
        );
        assert_eq!(
            extract_service_tier(&json!({
                "service_tier": "priority",
                "params": {"service_tier": "flex"}
            }))
            .as_deref(),
            Some("priority")
        );
        assert_eq!(
            extract_service_tier(&json!({"params": {"service_tier": "fast"}})).as_deref(),
            Some("fast")
        );
        assert_eq!(
            extract_service_tier(&json!({
                "metadata": {"params": {"service_tier": "priority"}}
            }))
            .as_deref(),
            Some("priority")
        );
        assert_eq!(
            extract_service_tier(&json!({"service_tier": "  priority  "})).as_deref(),
            Some("priority")
        );
        assert_eq!(extract_service_tier(&json!({"service_tier": "   "})), None);
        assert_eq!(extract_service_tier(&json!({"service_tier": 7})), None);
        assert_eq!(extract_service_tier(&json!({})), None);
    }

    #[test]
    fn apply_prompt_cache_and_reasoning_strips_service_tier_for_every_provider() {
        for entry in [
            openai_entry("GPT test", "gpt-5.6-luna", None),
            anthropic_entry("Claude test", "us.anthropic.claude-sonnet-4-6", Some(64000)),
            gemini_entry("Gemini test", "gemini-3.5-flash"),
        ] {
            let mut body = json!({
                "model": entry.alias,
                "service_tier": "priority",
                "messages": [{"role": "user", "content": "hi"}],
            });
            apply_prompt_cache_and_reasoning(&mut body, &entry, true, None);
            assert!(
                body.get("service_tier").is_none(),
                "service_tier must be stripped for {}",
                entry.alias
            );
        }
    }

    #[test]
    fn apply_openai_service_tier_targets_only_openai_responses_models() {
        let responses_entry = openai_responses_entry("GPT-5.6 Luna", "gpt-5.6-luna");

        let mut body = json!({"model": "gpt"});
        apply_openai_service_tier(&mut body, &responses_entry, Some("priority"), None);
        assert_eq!(body["service_tier"], json!("priority"));

        // Values pass verbatim so "fast" can be adopted without a code change.
        let mut body = json!({"model": "gpt"});
        apply_openai_service_tier(&mut body, &responses_entry, Some("fast"), None);
        assert_eq!(body["service_tier"], json!("fast"));

        for entry in [
            openai_entry("embeddings", "text-embedding-3-large", None),
            anthropic_entry("Claude test", "us.anthropic.claude-sonnet-4-6", None),
            gemini_entry("Gemini test", "gemini-3.5-flash"),
        ] {
            let mut body = json!({"model": entry.alias});
            apply_openai_service_tier(&mut body, &entry, Some("priority"), Some("priority"));
            assert!(
                body.get("service_tier").is_none(),
                "tier must not be injected for {}",
                entry.alias
            );
        }
    }

    #[test]
    fn apply_openai_service_tier_precedence_and_off_switch() {
        let entry = openai_responses_entry("GPT-5.6 Luna", "gpt-5.6-luna");

        // Explicit chat value beats the fleet env default.
        let mut body = json!({});
        apply_openai_service_tier(&mut body, &entry, Some("flex"), Some("priority"));
        assert_eq!(body["service_tier"], json!("flex"));

        // Env default fires when the chat did not choose.
        let mut body = json!({});
        apply_openai_service_tier(&mut body, &entry, None, Some("priority"));
        assert_eq!(body["service_tier"], json!("priority"));

        // An explicit "off" suppresses the env default; blanks fall through.
        for chat_value in ["off", "OFF"] {
            let mut body = json!({});
            apply_openai_service_tier(&mut body, &entry, Some(chat_value), Some("priority"));
            assert!(body.get("service_tier").is_none());
        }
        let mut body = json!({});
        apply_openai_service_tier(&mut body, &entry, Some("  "), None);
        assert!(body.get("service_tier").is_none());
        let mut body = json!({});
        apply_openai_service_tier(&mut body, &entry, None, None);
        assert!(body.get("service_tier").is_none());
    }

    #[test]
    fn helpers_cover_message_and_cache_key_utilities() {
        assert_eq!(sha256_hex("abc").len(), 64);
        assert_eq!(cache_key_model_slug("GPT-5.4 pro"), "gpt54pro");
        assert_eq!(cache_key_model_slug("!!!"), "model");

        let message = json!({"content":[{"text":"hello"},{"thinking":"world"}]});
        assert_eq!(
            message_text_content(&message).as_deref(),
            Some("helloworld")
        );
        assert_eq!(message_text_content(&json!({})), None);
        assert_eq!(
            message_text_content(&json!({"content":[{"foo":"bar"}]})),
            None
        );
        assert!(message_contains_marker(
            &json!({"content":"hello <dynamic_context> world"}),
            "<dynamic_context>"
        ));
        assert!(is_dynamic_context_message(
            &json!({"content":"<dynamic_context>"})
        ));
    }

    #[test]
    fn message_shaping_keeps_openai_system_messages_and_reorders_claude_system_prefix() {
        let messages = vec![
            json!({"role":"system","content":"model prompt"}),
            json!({"role":"system","content":"<static_context>stable</static_context>"}),
            json!({"role":"system","content":"<dynamic_context>dyn</dynamic_context>"}),
            json!({"role":"user","content":"question"}),
        ];
        let openai = shape_openai_messages_for_prompt_caching(&messages);
        assert_eq!(openai, messages);

        let claude = shape_claude_messages_for_prompt_caching(&messages);
        assert_eq!(
            claude,
            vec![
                json!({"role":"system","content":"<static_context>stable</static_context>"}),
                json!({"role":"system","content":"model prompt"}),
                json!({"role":"system","content":"<dynamic_context>dyn</dynamic_context>"}),
                json!({"role":"user","content":"question"}),
            ]
        );

        let middle_user = vec![
            json!({"role":"system","content":"model prompt"}),
            json!({"role":"system","content":"<static_context>stable</static_context>"}),
            json!({"role":"system","content":"<dynamic_context>dyn</dynamic_context>"}),
            json!({"role":"user","content":"question"}),
            json!({"role":"assistant","content":"answer"}),
        ];
        let openai = shape_openai_messages_for_prompt_caching(&middle_user);
        assert_eq!(openai, middle_user);

        let claude = shape_claude_messages_for_prompt_caching(&middle_user);
        assert_eq!(
            claude,
            vec![
                json!({"role":"system","content":"<static_context>stable</static_context>"}),
                json!({"role":"system","content":"model prompt"}),
                json!({"role":"system","content":"<dynamic_context>dyn</dynamic_context>"}),
                json!({"role":"user","content":"question"}),
                json!({"role":"assistant","content":"answer"}),
            ]
        );

        let no_user = vec![
            json!({"role":"system","content":"model prompt"}),
            json!({"role":"system","content":"<static_context>stable</static_context>"}),
            json!({"role":"system","content":"<dynamic_context>dyn</dynamic_context>"}),
        ];
        let claude = shape_claude_messages_for_prompt_caching(&no_user);
        assert_eq!(
            claude,
            vec![
                json!({"role":"system","content":"<static_context>stable</static_context>"}),
                json!({"role":"system","content":"model prompt"}),
                json!({"role":"system","content":"<dynamic_context>dyn</dynamic_context>"}),
            ]
        );

        let interleaved = vec![
            json!({"role":"system","content":"model prompt"}),
            json!({"role":"system","content":"<static_context>stable</static_context>"}),
            json!({"role":"system","content":"<dynamic_context>dyn</dynamic_context>"}),
            json!({"role":"user","content":"question"}),
            json!({"role":"system","content":"late system"}),
        ];
        let claude = shape_claude_messages_for_prompt_caching(&interleaved);
        assert_eq!(
            claude,
            vec![
                json!({"role":"system","content":"<static_context>stable</static_context>"}),
                json!({"role":"system","content":"model prompt"}),
                json!({"role":"system","content":"<dynamic_context>dyn</dynamic_context>"}),
                json!({"role":"user","content":"question"}),
                json!({"role":"system","content":"late system"}),
            ]
        );
    }

    #[test]
    fn stable_message_and_json_helpers_remove_dynamic_tail_and_sort_keys() {
        let messages = vec![
            json!({"role":"system","content":"static"}),
            json!({"role":"system","content":"<dynamic_context>skip</dynamic_context>"}),
            json!({"role":"user","content":"question"}),
        ];
        let stable = stable_openai_cache_messages(&messages);
        assert_eq!(stable, vec![json!({"role":"system","content":"static"})]);

        let canonical = canonicalize_value(&json!({"b":1,"a":{"d":4,"c":3}}));
        assert_eq!(
            stable_json_dumps(&canonical),
            r#"{"a":{"c":3,"d":4},"b":1}"#
        );
    }

    #[test]
    fn prompt_cache_affinity_and_reasoning_helpers_cover_fallbacks() {
        assert_eq!(
            normalize_prompt_cache_affinity(&json!(" Session-ID_01 ")).as_deref(),
            Some("session-id_01")
        );
        assert_eq!(normalize_prompt_cache_affinity(&json!("")), None);
        assert_eq!(
            normalize_prompt_cache_affinity(&json!({"complex":true}))
                .unwrap()
                .len(),
            40
        );

        let body = json!({
            "metadata": {
                "params": {
                    "thread_id": "thread-123",
                    "reasoning_effort": "high"
                }
            }
        });
        assert_eq!(
            extract_prompt_cache_affinity(&body).as_deref(),
            Some("thread-123")
        );
        assert_eq!(extract_reasoning_effort(&body), "high");
        assert_eq!(
            extract_prompt_cache_affinity(&json!({"metadata":{"chat_id":"chat-7"}})).as_deref(),
            Some("chat-7")
        );
        assert_eq!(
            extract_prompt_cache_affinity(&json!({"metadata":{"noop":"value"}})),
            None
        );
        assert_eq!(
            extract_reasoning_effort(&json!({"params":{"reasoning_effort":"low"}})),
            "low"
        );
        assert_eq!(
            extract_reasoning_effort(&json!({"metadata":{"params":{"reasoning_effort":"max"}}})),
            "max"
        );
        assert_eq!(extract_reasoning_effort(&json!({})), "medium");
    }

    #[test]
    fn model_support_and_budget_helpers_cover_all_branches() {
        assert!(is_openai_prompt_caching_model("GPT-5.4"));
        assert!(is_openai_prompt_caching_model("gpt-4.1"));
        assert!(is_openai_prompt_caching_model("GPT-5.4 pro"));
        assert!(!is_openai_prompt_caching_model("Claude Sonnet 4.6"));

        assert!(supports_openai_reasoning_model("gpt-5.4"));
        assert!(!supports_openai_reasoning_model("gpt-4.1"));
        assert!(supports_gemini_reasoning_model("gemini-3.5-flash"));
        assert!(!supports_gemini_reasoning_model("gpt-5.5"));

        assert_eq!(budget_for_model("Claude Opus 4.7", "max"), 31999);
        assert_eq!(budget_for_model("Claude Haiku 4.5", "high"), 20000);
        assert_eq!(budget_for_model("Random Claude", "high"), 20000);
        assert_eq!(budget_for_model("Other", "high"), 16000);
        assert_eq!(budget_for_model("Other", "bogus"), 10000);
        assert!(is_claude_sonnet_46_model("us.anthropic.claude-sonnet-4-6"));
        assert!(is_claude_carried_forward_beta_model(
            "us.anthropic.claude-sonnet-4-6"
        ));
        assert!(is_claude_adaptive_opus_model("Claude Opus 4.8"));
        assert!(is_claude_adaptive_opus_model("Claude Opus 4.7"));
        assert!(is_claude_adaptive_opus_model("Claude Opus 4.6"));
        assert!(is_claude_carried_forward_beta_model(
            "us.anthropic.claude-opus-4-8"
        ));
        assert!(is_claude_carried_forward_beta_model(
            "us.anthropic.claude-opus-4-6-v1"
        ));
        assert!(!is_claude_carried_forward_beta_model(
            "us.anthropic.claude-haiku-4-5-20251001-v1:0"
        ));
        assert_eq!(
            map_claude_adaptive_effort("Claude Opus 4.7", "xhigh"),
            "xhigh"
        );
        assert_eq!(
            map_claude_adaptive_effort("Claude Opus 4.8", "xhigh"),
            "xhigh"
        );
        assert_eq!(
            map_claude_adaptive_effort("Claude Opus 4.7", "bogus"),
            "medium"
        );
        assert_eq!(
            map_claude_adaptive_effort("Claude Opus 4.6", "xhigh"),
            "medium"
        );

        assert!(is_claude_sonnet_5_model("Claude Sonnet 5"));
        assert!(is_claude_sonnet_5_model("us.anthropic.claude-sonnet-5"));
        assert!(is_claude_sonnet_5_model(
            "bedrock/converse_like/us.anthropic.claude-sonnet-5"
        ));
        assert!(!is_claude_sonnet_5_model("Claude Sonnet 4.5"));
        assert!(!is_claude_sonnet_5_model(
            "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
        ));
        assert!(!is_claude_sonnet_5_model("us.anthropic.claude-sonnet-4-6"));
        assert!(is_claude_adaptive_thinking_model(
            "us.anthropic.claude-sonnet-5"
        ));
        assert!(is_claude_adaptive_thinking_model("Claude Opus 4.8"));
        assert!(!is_claude_adaptive_thinking_model("Claude Sonnet 4.6"));
        assert!(is_claude_summarized_adaptive_model("Claude Sonnet 5"));
        assert!(!is_claude_summarized_adaptive_model("Claude Opus 4.6"));
        assert!(is_claude_sampling_params_rejected_model(
            "us.anthropic.claude-sonnet-5"
        ));
        assert!(is_claude_sampling_params_rejected_model("Claude Opus 4.8"));
        assert!(!is_claude_sampling_params_rejected_model("Claude Opus 4.6"));
        assert!(!is_claude_sampling_params_rejected_model(
            "Claude Sonnet 4.6"
        ));
        // Sonnet 5 deliberately gets no legacy carried-forward beta flags.
        assert!(!is_claude_carried_forward_beta_model(
            "us.anthropic.claude-sonnet-5"
        ));
        assert_eq!(
            map_claude_adaptive_effort("Claude Sonnet 5", "xhigh"),
            "xhigh"
        );
        assert_eq!(map_claude_adaptive_effort("Claude Sonnet 5", "max"), "max");
        assert_eq!(
            map_claude_adaptive_effort("Claude Sonnet 5", "bogus"),
            "medium"
        );

        assert!(is_claude_opus_5_model("Claude Opus 5"));
        assert!(is_claude_opus_5_model("us.anthropic.claude-opus-5"));
        assert!(is_claude_opus_5_model(
            "bedrock/converse_like/us.anthropic.claude-opus-5"
        ));
        assert!(!is_claude_opus_5_model("Claude Opus 4.5"));
        assert!(!is_claude_opus_5_model(
            "us.anthropic.claude-opus-4-5-20251101-v1:0"
        ));
        assert!(!is_claude_opus_5_model("us.anthropic.claude-opus-4-6-v1"));
        assert!(is_claude_adaptive_thinking_model(
            "us.anthropic.claude-opus-5"
        ));
        assert!(is_claude_summarized_adaptive_model("Claude Opus 5"));
        assert!(is_claude_sampling_params_rejected_model(
            "us.anthropic.claude-opus-5"
        ));
        // Opus 5 deliberately gets no legacy carried-forward beta flags.
        assert!(!is_claude_carried_forward_beta_model(
            "us.anthropic.claude-opus-5"
        ));
        assert_eq!(map_claude_adaptive_effort("Claude Opus 5", "xhigh"), "xhigh");
        assert_eq!(map_claude_adaptive_effort("Claude Opus 5", "max"), "max");
        assert_eq!(
            map_claude_adaptive_effort("Claude Opus 5", "bogus"),
            "medium"
        );

        assert_eq!(map_gpt_effort("gpt-5.6-sol", "none"), Some("none"));
        assert_eq!(map_gpt_effort("gpt-5.6-sol", "xhigh"), Some("xhigh"));
        assert_eq!(map_gpt_effort("gpt-5.6-sol", "max"), Some("max"));
        assert_eq!(map_gpt_effort("gpt-5.6-sol", "ultra"), None);
        assert_eq!(map_gpt_effort("gpt-5.6-terra", "bogus"), None);
        assert_eq!(map_gpt_effort("gpt-5.4-pro", "low"), Some("medium"));
        assert_eq!(map_gpt_effort("gpt-5.4-pro", "high"), Some("high"));
        assert_eq!(map_gpt_effort("gpt-5.4-pro", "max"), Some("xhigh"));
        assert_eq!(map_gpt_effort("gpt-5.4-pro", "bogus"), None);
        assert_eq!(map_gpt_effort("gpt-5.4", "low"), Some("low"));
        assert_eq!(map_gpt_effort("gpt-5.4", "medium"), Some("medium"));
        assert_eq!(map_gpt_effort("gpt-5.4", "high"), Some("high"));
        assert_eq!(map_gpt_effort("gpt-5.4", "max"), Some("xhigh"));
        assert_eq!(map_gpt_effort("gpt-5.4", "weird"), None);
        assert_eq!(map_gpt_effort("gpt-5.5", "max"), Some("xhigh"));
        assert_eq!(map_gpt_effort("gpt-5-mini", "low"), Some("low"));
        assert_eq!(map_gpt_effort("gpt-5-mini", "medium"), Some("medium"));
        assert_eq!(map_gpt_effort("gpt-5-mini", "max"), Some("high"));
        assert_eq!(map_gpt_effort("gpt-5-nano", "unknown"), None);
        assert_eq!(map_gpt_effort("other", "medium"), None);
        assert_eq!(map_gemini_effort("low"), "low");
        assert_eq!(map_gemini_effort("medium"), "medium");
        assert_eq!(map_gemini_effort("high"), "high");
        assert_eq!(map_gemini_effort("max"), "high");
        assert_eq!(map_gemini_effort("xhigh"), "high");
        assert_eq!(map_gemini_effort("bogus"), "medium");
    }

    #[test]
    fn sanitize_claude_reasoning_budget_clamps_or_disables_to_fit_output_limit() {
        let unbounded = Map::new();
        assert_eq!(sanitize_claude_reasoning_budget(&unbounded, 10000), 10000);

        let limited = serde_json::from_value::<Map<String, Value>>(json!({
            "max_completion_tokens": 2048
        }))
        .unwrap();
        assert_eq!(sanitize_claude_reasoning_budget(&limited, 10000), 2047);

        let too_low = serde_json::from_value::<Map<String, Value>>(json!({
            "max_tokens": 1000
        }))
        .unwrap();
        assert_eq!(sanitize_claude_reasoning_budget(&too_low, 10000), 0);
    }

    #[test]
    fn content_block_helpers_cover_variants() {
        let mut message = json!({"content":"hello"});
        let blocks = ensure_message_content_blocks(&mut message).unwrap();
        assert_eq!(blocks.len(), 1);
        assert!(set_cache_control_on_last_block(blocks, None));
        assert_eq!(
            message["content"][0]["cache_control"]["type"],
            json!("ephemeral")
        );
        assert!(message["content"][0]["cache_control"].get("ttl").is_none());

        let mut ttl_message = json!({"content":"hello"});
        let ttl_blocks = ensure_message_content_blocks(&mut ttl_message).unwrap();
        assert!(set_cache_control_on_last_block(ttl_blocks, Some("1h")));
        assert_eq!(
            ttl_message["content"][0]["cache_control"],
            json!({"type":"ephemeral","ttl":"1h"})
        );

        let mut empty_message = json!({});
        assert!(ensure_message_content_blocks(&mut empty_message).is_some());
        let mut array_message = json!({"content":[{"type":"text","text":"ok"}]});
        assert!(ensure_message_content_blocks(&mut array_message).is_some());
        let mut bad_message = json!({"content": 7});
        assert!(ensure_message_content_blocks(&mut bad_message).is_none());
        let mut scalar_message = json!(7);
        assert!(ensure_message_content_blocks(&mut scalar_message).is_none());
        assert!(!set_cache_control_on_last_block(
            &mut [json!(7)],
            Some("1h")
        ));
        assert!(!set_cache_control_on_last_block(&mut [], Some("1h")));
    }

    #[test]
    fn configured_output_token_ceiling_is_config_driven() {
        let mut object = Map::new();
        apply_configured_output_token_ceiling(&mut object, Some(50));
        assert_eq!(object["max_tokens"], json!(50));
        apply_configured_output_token_ceiling(&mut object, Some(100));
        assert_eq!(object["max_tokens"], json!(50));

        object.insert("max_tokens".to_string(), json!(120));
        apply_configured_output_token_ceiling(&mut object, Some(90));
        assert_eq!(object["max_tokens"], json!(90));

        let mut completion_only = Map::new();
        completion_only.insert("max_completion_tokens".to_string(), json!(99));
        apply_configured_output_token_ceiling(&mut completion_only, Some(70));
        assert_eq!(completion_only["max_tokens"], json!(70));
        assert!(completion_only.get("max_completion_tokens").is_none());

        let mut output_only = Map::new();
        output_only.insert("max_output_tokens".to_string(), json!(44));
        apply_configured_output_token_ceiling(&mut output_only, Some(70));
        assert_eq!(output_only["max_tokens"], json!(44));
        assert!(output_only.get("max_output_tokens").is_none());

        let mut no_config = Map::new();
        no_config.insert("max_tokens".to_string(), json!(123));
        apply_configured_output_token_ceiling(&mut no_config, None);
        assert_eq!(no_config["max_tokens"], json!(123));
    }

    #[test]
    fn apply_prompt_cache_and_reasoning_for_openai_builds_cache_key_and_reasoning() {
        let entry = openai_entry("GPT-5.5", "gpt-5.5", Some("24h"));
        let mut body = json!({
            "chat_id": "chat-123",
            "reasoning_effort": "max",
            "messages": [
                {"role":"system","content":"static"},
                {"role":"system","content":"<dynamic_context>dyn</dynamic_context>"},
                {"role":"user","content":"hello"}
            ],
            "tools": [{"name":"lookup"}]
        });

        apply_prompt_cache_and_reasoning(&mut body, &entry, true, None);
        assert_eq!(body["prompt_cache_key"], json!("owui:gpt55:chat-123"));
        assert_eq!(body["prompt_cache_retention"], json!("24h"));
        assert_eq!(body["reasoning"]["effort"], json!("xhigh"));
        assert!(body.get("chat_id").is_none());
        assert!(body.get("reasoning_effort").is_none());
        assert_eq!(
            body["messages"],
            json!([
                {"role":"system","content":"static"},
                {"role":"system","content":"<dynamic_context>dyn</dynamic_context>"},
                {"role":"user","content":"hello"}
            ])
        );

        let mut with_existing_key = json!({
            "prompt_cache_key": "preexisting",
            "prompt_cache_retention": "keep-me",
            "messages": [{"role":"user","content":"hello"}]
        });
        apply_prompt_cache_and_reasoning(&mut with_existing_key, &entry, true, None);
        assert_eq!(with_existing_key["prompt_cache_key"], json!("preexisting"));
        assert_eq!(
            with_existing_key["prompt_cache_retention"],
            json!("keep-me")
        );

        let mut explicit_limits = json!({
            "messages": [{"role":"user","content":"hello"}],
            "reasoning_effort": "high",
            "max_completion_tokens": 200000
        });
        apply_prompt_cache_and_reasoning(&mut explicit_limits, &entry, true, None);
        assert_eq!(explicit_limits["max_tokens"], json!(128000));
        assert!(explicit_limits.get("max_completion_tokens").is_none());
        assert_eq!(explicit_limits["reasoning"]["effort"], json!("high"));

        let mut explicit_lower = json!({
            "messages": [{"role":"user","content":"hello"}],
            "reasoning_effort": "low",
            "max_output_tokens": 4096
        });
        apply_prompt_cache_and_reasoning(&mut explicit_lower, &entry, true, None);
        assert_eq!(explicit_lower["max_tokens"], json!(4096));
        assert!(explicit_lower.get("max_output_tokens").is_none());
        assert_eq!(explicit_lower["reasoning"]["effort"], json!("low"));

        let mut nested_params = json!({
            "messages": [{"role":"user","content":"hello"}],
            "params": {
                "function_calling": "native",
                "reasoning_effort": "max"
            }
        });
        apply_prompt_cache_and_reasoning(&mut nested_params, &entry, true, None);
        assert_eq!(nested_params["reasoning"]["effort"], json!("xhigh"));
        assert!(nested_params.get("params").is_none());
    }

    #[test]
    fn gpt_56_preserves_efforts_namespaces_cache_keys_and_injects_pro_mode() {
        let sol_entry = openai_entry("GPT-5.6 Sol", "gpt-5.6-sol", Some("24h"));
        let mut sol = json!({
            "prompt_cache_key": "caller-controlled-key",
            "prompt_cache_retention": "in_memory",
            "reasoning_effort": "max",
            "messages": [{"role":"user","content":"hello"}]
        });
        apply_prompt_cache_and_reasoning(&mut sol, &sol_entry, true, None);
        assert!(sol["prompt_cache_key"]
            .as_str()
            .unwrap()
            .starts_with("owui:gpt56sol:caller:"));
        assert_eq!(sol["prompt_cache_retention"], json!("24h"));
        assert_eq!(sol["reasoning"], json!({"effort":"max","summary":"auto"}));

        let mut ultra = json!({
            "chat_id": "chat-1",
            "reasoning_effort": "ultra",
            "messages": [{"role":"user","content":"hello"}]
        });
        apply_prompt_cache_and_reasoning(&mut ultra, &sol_entry, true, None);
        assert_eq!(
            ultra["prompt_cache_key"],
            json!("owui:gpt56sol-ultra:chat-1")
        );
        assert_eq!(ultra["reasoning"]["effort"], json!(REJECTED_GPT_EFFORT));

        let pro_entry = openai_entry("GPT-5.6 Sol Pro", "gpt-5.6-sol-pro", Some("24h"));
        let mut pro = json!({
            "chat_id": "chat-1",
            "reasoning_effort": "xhigh",
            "messages": [{"role":"user","content":"hello"}]
        });
        apply_prompt_cache_and_reasoning(&mut pro, &pro_entry, true, None);
        assert_eq!(pro["prompt_cache_key"], json!("owui:gpt56solpro:chat-1"));
        assert_eq!(
            pro["reasoning"],
            json!({"effort":"xhigh","summary":"auto","mode":"pro"})
        );
    }

    #[test]
    fn apply_prompt_cache_and_reasoning_uses_affinity_override_when_body_metadata_is_missing() {
        let entry = openai_entry("GPT-4.1", "gpt-4.1", None);
        let mut body = json!({
            "messages": [
                {"role":"system","content":"static"},
                {"role":"user","content":"hello"}
            ]
        });

        apply_prompt_cache_and_reasoning(&mut body, &entry, true, Some("chat-from-header"));

        assert_eq!(
            body["prompt_cache_key"],
            json!("owui:gpt41:chat-from-header")
        );
        assert!(body.get("metadata").is_none());
    }

    #[test]
    fn openai_prompt_shaping_keeps_system_messages_separate() {
        let entry = openai_entry("GPT-5.4", "gpt-5.4", Some("24h"));
        let mut initial = json!({
            "chat_id": "chat-123",
            "messages": [
                {"role":"system","content":"static"},
                {"role":"system","content":"<dynamic_context>dyn-initial</dynamic_context>"},
                {"role":"user","content":"hello"}
            ]
        });
        let mut followup = json!({
            "chat_id": "chat-123",
            "messages": [
                {"role":"system","content":"static"},
                {"role":"system","content":"<dynamic_context>dyn-followup</dynamic_context>"},
                {"role":"user","content":"hello"},
                {"role":"assistant","content":"","tool_calls":[{"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{}"}}]},
                {"role":"tool","tool_call_id":"call_1","content":"{\"ok\":true}"}
            ]
        });

        apply_prompt_cache_and_reasoning(&mut initial, &entry, true, None);
        apply_prompt_cache_and_reasoning(&mut followup, &entry, true, None);

        assert_eq!(
            initial["messages"],
            json!([
                {"role":"system","content":"static"},
                {"role":"system","content":"<dynamic_context>dyn-initial</dynamic_context>"},
                {"role":"user","content":"hello"}
            ])
        );
        assert_eq!(
            followup["messages"],
            json!([
                {"role":"system","content":"static"},
                {"role":"system","content":"<dynamic_context>dyn-followup</dynamic_context>"},
                {"role":"user","content":"hello"},
                {"role":"assistant","content":"","tool_calls":[{"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{}"}}]},
                {"role":"tool","tool_call_id":"call_1","content":"{\"ok\":true}"}
            ])
        );
    }

    #[test]
    fn apply_prompt_cache_and_reasoning_for_openai_uses_stable_digest_when_no_affinity() {
        let entry = openai_entry("GPT-4.1 mini", "gpt-4.1-mini", None);
        let mut body = json!({
            "messages": [
                {"role":"system","content":"stable"},
                {"role":"system","content":"<dynamic_context>dyn</dynamic_context>"},
                {"role":"user","content":"ask"}
            ],
            "tools": [{"name":"tool-a"}]
        });
        apply_prompt_cache_and_reasoning(&mut body, &entry, true, None);

        let key = body["prompt_cache_key"].as_str().unwrap();
        assert!(key.starts_with("owui:gpt41mini:"));
        assert_eq!(key.len(), "owui:gpt41mini:".len() + 40);
        assert!(body.get("reasoning").is_none());
        assert_eq!(
            body["messages"],
            json!([
                {"role":"system","content":"stable"},
                {"role":"system","content":"<dynamic_context>dyn</dynamic_context>"},
                {"role":"user","content":"ask"}
            ])
        );

        let mut pro = json!({
            "messages": [{"role":"user","content":"hello"}],
            "reasoning_effort": "high"
        });
        let pro_entry = openai_entry("GPT-5.4 pro", "gpt-5.4-pro", None);
        apply_prompt_cache_and_reasoning(&mut pro, &pro_entry, true, None);
        assert!(pro["prompt_cache_key"]
            .as_str()
            .unwrap()
            .starts_with("owui:gpt54pro:"));
        assert_eq!(pro["reasoning"]["effort"], json!("high"));

        let mut empty_stable = json!({
            "messages": [
                {"role":"system","content":"<dynamic_context>dyn</dynamic_context>"}
            ]
        });
        apply_prompt_cache_and_reasoning(&mut empty_stable, &entry, true, None);
        assert!(empty_stable.get("prompt_cache_key").is_none());

        let mut no_messages = json!({});
        apply_prompt_cache_and_reasoning(&mut no_messages, &entry, true, None);
        assert!(no_messages.get("prompt_cache_key").is_none());
    }

    #[test]
    fn apply_prompt_cache_and_reasoning_is_noop_for_non_object_body() {
        let entry = openai_entry("GPT-4.1", "gpt-4.1", None);
        let mut body = json!(["not", "an", "object"]);
        apply_prompt_cache_and_reasoning(&mut body, &entry, true, None);
        assert_eq!(body, json!(["not", "an", "object"]));
    }

    #[test]
    fn apply_prompt_cache_and_reasoning_for_gemini_adds_thinking_without_explicit_cache_lifecycle()
    {
        let entry = gemini_entry("Gemini 3.5 Flash", "gemini-3.5-flash");
        let mut body = json!({
            "chat_id": "chat-123",
            "thread_id": "thread-123",
            "reasoning_effort": "max",
            "messages": [
                {"role":"system","content":"stable"},
                {"role":"system","content":"<dynamic_context>dyn</dynamic_context>"},
                {"role":"user","content":"hello"}
            ],
            "tools": [{"name":"lookup"}],
            "max_output_tokens": 100000
        });

        apply_prompt_cache_and_reasoning(&mut body, &entry, true, Some("chat-from-header"));

        assert_eq!(body["reasoning"], json!({"effort":"high"}));
        assert_eq!(body["max_tokens"], json!(65536));
        assert!(body.get("chat_id").is_none());
        assert!(body.get("thread_id").is_none());
        assert!(body.get("reasoning_effort").is_none());
        assert!(body.get("prompt_cache_key").is_none());
        assert!(body.get("prompt_cache_retention").is_none());
        assert!(body.get("cache_control").is_none());
        assert!(body["tools"][0].get("cache_control").is_none());
        assert_eq!(
            body["messages"],
            json!([
                {"role":"system","content":"stable"},
                {"role":"system","content":"<dynamic_context>dyn</dynamic_context>"},
                {"role":"user","content":"hello"}
            ])
        );

        let mut low = json!({
            "messages": [{"role":"user","content":"hello"}],
            "params": { "reasoning_effort": "low" }
        });
        apply_prompt_cache_and_reasoning(&mut low, &entry, true, None);
        assert_eq!(low["reasoning"], json!({"effort":"low"}));
        assert!(low.get("params").is_none());

        let mut invalid = json!({
            "messages": [{"role":"user","content":"hello"}],
            "reasoning_effort": "invalid"
        });
        apply_prompt_cache_and_reasoning(&mut invalid, &entry, true, None);
        assert_eq!(invalid["reasoning"], json!({"effort":"medium"}));
    }

    #[test]
    fn apply_prompt_cache_and_reasoning_for_claude_enables_cache_points_and_reasoning_budget() {
        let entry = anthropic_entry(
            "Claude Sonnet 4.6",
            "us.anthropic.claude-sonnet-4-6",
            Some(64000),
        );
        let mut body = json!({
            "messages": [
                {"role":"system","content":"model base system prompt"},
                {"role":"system","content":"<static_context>stable</static_context>"},
                {"role":"system","content":"<dynamic_context>dynamic</dynamic_context>"},
                {"role":"user","content":"first"},
                {"role":"assistant","content":"answer"},
                {"role":"user","content":"second"}
            ],
            "tools": [{"name":"tool-a"}],
            "reasoning_effort": "high",
            "params": {"function_calling":"native"}
        });

        apply_prompt_cache_and_reasoning(&mut body, &entry, true, None);
        assert!(body.get("params").is_none());
        assert_eq!(
            body["messages"][0]["content"][0]["cache_control"]["type"],
            json!("ephemeral")
        );
        assert_eq!(
            body["messages"][1]["content"][0]["cache_control"]["type"],
            json!("ephemeral")
        );
        assert_eq!(
            body["messages"][0]["content"][0]["text"],
            json!("<static_context>stable</static_context>")
        );
        assert_eq!(
            body["messages"][1]["content"][0]["text"],
            json!("model base system prompt")
        );
        assert_eq!(body["messages"][2]["role"], json!("system"));
        assert!(body["messages"][2]
            .get("content")
            .and_then(Value::as_array)
            .is_none());
        assert_eq!(
            body["tools"][0]["cache_control"]["type"],
            json!("ephemeral")
        );
        assert_eq!(body["cache_control"]["type"], json!("ephemeral"));
        assert_eq!(body["max_tokens"], json!(64000));
        assert_eq!(body["reasoning"]["max_tokens"], json!(20000));
        assert_eq!(
            body["anthropic_beta"],
            json!([
                "fine-grained-tool-streaming-2025-05-14",
                "interleaved-thinking-2025-05-14"
            ])
        );
        assert_eq!(
            body["additionalModelRequestFields"]["anthropic_beta"],
            body["anthropic_beta"]
        );

        let mut fallback_system = json!({
            "messages": [
                {"role":"system","content":7},
                {"role":"user","content":"first"},
                {"role":"assistant","content":"answer"}
            ],
            "tools": ["not-an-object"]
        });
        apply_prompt_cache_and_reasoning(&mut fallback_system, &entry, true, None);
        assert_eq!(fallback_system["messages"][0]["content"], json!(7));
        assert!(fallback_system["tools"][0].get("cache_control").is_none());

        let mut no_history = json!({
            "messages": [
                {"role":"system","content":"plain"},
                {"role":"assistant","content":"answer"}
            ]
        });
        apply_prompt_cache_and_reasoning(&mut no_history, &entry, true, None);
        assert_eq!(
            no_history["messages"][0]["content"][0]["cache_control"]["type"],
            json!("ephemeral")
        );

        let mut explicit_lower = json!({
            "messages": [{"role":"user","content":"hi"}],
            "reasoning_effort": "medium",
            "max_tokens": 2048
        });
        apply_prompt_cache_and_reasoning(&mut explicit_lower, &entry, false, None);
        assert_eq!(explicit_lower["max_tokens"], json!(2048));
        assert_eq!(explicit_lower["reasoning"]["max_tokens"], json!(2047));

        let mut explicit_higher = json!({
            "messages": [{"role":"user","content":"hi"}],
            "reasoning_effort": "medium",
            "max_completion_tokens": 200000
        });
        apply_prompt_cache_and_reasoning(&mut explicit_higher, &entry, false, None);
        assert_eq!(explicit_higher["max_tokens"], json!(64000));
        assert!(explicit_higher.get("max_completion_tokens").is_none());
        assert_eq!(explicit_higher["reasoning"]["max_tokens"], json!(10000));

        let mut no_system_or_tools = json!({
            "messages": [
                {"role":"assistant","content":"answer"}
            ]
        });
        apply_prompt_cache_and_reasoning(&mut no_system_or_tools, &entry, true, None);
        assert!(no_system_or_tools.get("tools").is_none());

        let no_config_entry =
            anthropic_entry("Claude Sonnet 4.6", "us.anthropic.claude-sonnet-4-6", None);
        let mut no_config = json!({
            "messages": [{"role":"user","content":"hi"}],
            "reasoning_effort": "high"
        });
        apply_prompt_cache_and_reasoning(&mut no_config, &no_config_entry, false, None);
        assert!(no_config.get("max_tokens").is_none());
        assert_eq!(no_config["reasoning"]["max_tokens"], json!(20000));

        let haiku_entry = anthropic_entry(
            "Claude Haiku 4.5",
            "us.anthropic.claude-haiku-4-5-20251001-v1:0",
            Some(64000),
        );
        let mut haiku_low_limit = json!({
            "messages": [{"role":"user","content":"Generate a title"}],
            "max_completion_tokens": 1000
        });
        apply_prompt_cache_and_reasoning(&mut haiku_low_limit, &haiku_entry, false, None);
        assert_eq!(haiku_low_limit["max_tokens"], json!(1000));
        assert!(haiku_low_limit.get("reasoning").is_none());

        let mut haiku_explicit_limit = json!({
            "messages": [{"role":"user","content":"Generate a title"}],
            "max_tokens": 2048
        });
        apply_prompt_cache_and_reasoning(&mut haiku_explicit_limit, &haiku_entry, false, None);
        assert_eq!(haiku_explicit_limit["max_tokens"], json!(2048));
        assert_eq!(haiku_explicit_limit["reasoning"]["max_tokens"], json!(2047));

        let mut haiku_unbounded = json!({
            "messages": [{"role":"user","content":"Generate a title"}]
        });
        apply_prompt_cache_and_reasoning(&mut haiku_unbounded, &haiku_entry, false, None);
        assert_eq!(haiku_unbounded["max_tokens"], json!(64000));
        assert_eq!(haiku_unbounded["reasoning"]["max_tokens"], json!(10000));
    }

    #[test]
    fn apply_prompt_cache_and_reasoning_for_claude_opus_adaptive_models_use_expected_effort() {
        let entry = anthropic_entry(
            "Claude Opus 4.6",
            "us.anthropic.claude-opus-4-6-v1",
            Some(128000),
        );
        let mut body = json!({
            "messages": [{"role":"system","content":"stable"}],
            "reasoning_effort": "low"
        });
        apply_prompt_cache_and_reasoning(&mut body, &entry, false, None);
        assert_eq!(body["max_tokens"], json!(128000));
        assert_eq!(body["thinking"]["type"], json!("adaptive"));
        assert!(body["thinking"].get("display").is_none());
        assert_eq!(body["output_config"]["effort"], json!("low"));
        assert!(body.get("reasoning").is_none());

        let mut explicit_cap = json!({
            "messages": [{"role":"system","content":"stable"}],
            "reasoning_effort": "medium",
            "max_tokens": 2048
        });
        apply_prompt_cache_and_reasoning(&mut explicit_cap, &entry, false, None);
        assert_eq!(explicit_cap["max_tokens"], json!(2048));
        assert_eq!(explicit_cap["thinking"]["type"], json!("adaptive"));
        assert!(explicit_cap["thinking"].get("display").is_none());
        assert_eq!(explicit_cap["output_config"]["effort"], json!("medium"));

        let no_config_entry =
            anthropic_entry("Claude Opus 4.6", "us.anthropic.claude-opus-4-6-v1", None);
        let mut no_config = json!({
            "messages": [{"role":"system","content":"stable"}],
            "reasoning_effort": "high"
        });
        apply_prompt_cache_and_reasoning(&mut no_config, &no_config_entry, false, None);
        assert!(no_config.get("max_tokens").is_none());
        assert_eq!(no_config["thinking"]["type"], json!("adaptive"));
        assert!(no_config["thinking"].get("display").is_none());
        assert_eq!(no_config["output_config"]["effort"], json!("high"));
        assert_eq!(
            no_config["anthropic_beta"],
            json!([
                "fine-grained-tool-streaming-2025-05-14",
                "interleaved-thinking-2025-05-14"
            ])
        );
        assert_eq!(
            no_config["additionalModelRequestFields"]["anthropic_beta"],
            no_config["anthropic_beta"]
        );

        let mut explicit_higher = json!({
            "messages": [{"role":"system","content":"stable"}],
            "reasoning_effort": "high",
            "max_output_tokens": 200000
        });
        apply_prompt_cache_and_reasoning(&mut explicit_higher, &entry, false, None);
        assert_eq!(explicit_higher["max_tokens"], json!(128000));
        assert!(explicit_higher.get("max_output_tokens").is_none());
        assert_eq!(explicit_higher["thinking"]["type"], json!("adaptive"));
        assert!(explicit_higher["thinking"].get("display").is_none());

        let opus_47_entry = anthropic_entry(
            "Claude Opus 4.7",
            "us.anthropic.claude-opus-4-7",
            Some(128000),
        );
        let opus_48_entry = anthropic_entry(
            "Claude Opus 4.8",
            "us.anthropic.claude-opus-4-8",
            Some(128000),
        );
        let mut opus_48_ttl_entry = opus_48_entry.clone();
        opus_48_ttl_entry.claude_prompt_cache_ttl = Some("1h".to_string());
        for entry in [&opus_47_entry, &opus_48_entry] {
            for expected_effort in ["low", "medium", "high", "xhigh", "max"] {
                let mut opus = json!({
                    "messages": [{"role":"system","content":"stable"}],
                    "reasoning_effort": expected_effort
                });
                apply_prompt_cache_and_reasoning(&mut opus, entry, false, None);
                assert_eq!(opus["max_tokens"], json!(128000));
                assert_eq!(opus["thinking"]["type"], json!("adaptive"));
                assert_eq!(opus["thinking"]["display"], json!("summarized"));
                assert_eq!(opus["output_config"]["effort"], json!(expected_effort));
                assert_eq!(
                    opus["anthropic_beta"],
                    json!([
                        "fine-grained-tool-streaming-2025-05-14",
                        "interleaved-thinking-2025-05-14"
                    ])
                );
                assert_eq!(
                    opus["additionalModelRequestFields"]["anthropic_beta"],
                    opus["anthropic_beta"]
                );
            }
        }

        for entry in [&opus_47_entry, &opus_48_entry] {
            let mut opus_invalid = json!({
                "messages": [{"role":"system","content":"stable"}],
                "reasoning_effort": "bogus"
            });
            apply_prompt_cache_and_reasoning(&mut opus_invalid, entry, false, None);
            assert_eq!(opus_invalid["output_config"]["effort"], json!("medium"));
            assert_eq!(opus_invalid["thinking"]["display"], json!("summarized"));
        }

        let mut opus_48_cached = json!({
            "messages": [
                {"role":"system","content":"model prompt"},
                {"role":"system","content":"<static_context>stable</static_context>"},
                {"role":"system","content":"<dynamic_context>dynamic</dynamic_context>"},
                {"role":"user","content":"hi"}
            ],
            "tools": [{"name":"tool-a"}],
            "reasoning_effort": "xhigh"
        });
        apply_prompt_cache_and_reasoning(&mut opus_48_cached, &opus_48_ttl_entry, true, None);
        assert_eq!(
            opus_48_cached["cache_control"],
            json!({"type":"ephemeral","ttl":"1h"})
        );
        assert_eq!(
            opus_48_cached["messages"][0]["content"][0]["cache_control"],
            json!({"type":"ephemeral","ttl":"1h"})
        );
        assert_eq!(
            opus_48_cached["messages"][1]["content"][0]["cache_control"],
            json!({"type":"ephemeral","ttl":"1h"})
        );
        assert_eq!(
            opus_48_cached["tools"][0]["cache_control"],
            json!({"type":"ephemeral","ttl":"1h"})
        );

        let mut sonnet_cached = json!({
            "messages": [
                {"role":"system","content":"model prompt"},
                {"role":"user","content":"hi"}
            ],
            "tools": [{"name":"tool-a"}]
        });
        let sonnet_entry = anthropic_entry(
            "Claude Sonnet 4.6",
            "us.anthropic.claude-sonnet-4-6",
            Some(64000),
        );
        apply_prompt_cache_and_reasoning(&mut sonnet_cached, &sonnet_entry, true, None);
        assert!(sonnet_cached["cache_control"].get("ttl").is_none());
        assert!(sonnet_cached["messages"][0]["content"][0]["cache_control"]
            .get("ttl")
            .is_none());
        assert!(sonnet_cached["tools"][0]["cache_control"]
            .get("ttl")
            .is_none());

        let haiku_entry = anthropic_entry(
            "Claude Haiku 4.5",
            "us.anthropic.claude-haiku-4-5-20251001-v1:0",
            Some(64000),
        );
        let mut haiku = json!({
            "messages": [{"role":"system","content":"stable"}]
        });
        apply_prompt_cache_and_reasoning(&mut haiku, &haiku_entry, false, None);
        assert!(haiku.get("anthropic_beta").is_none());
        assert!(haiku.get("additionalModelRequestFields").is_none());
    }

    #[test]
    fn apply_prompt_cache_and_reasoning_for_claude_sonnet_5_uses_adaptive_thinking() {
        let entry = anthropic_entry(
            "Claude Sonnet 5",
            "us.anthropic.claude-sonnet-5",
            Some(128000),
        );

        for expected_effort in ["low", "medium", "high", "xhigh", "max"] {
            let mut body = json!({
                "messages": [{"role":"system","content":"stable"}],
                "reasoning_effort": expected_effort,
                "temperature": 0.7,
                "top_p": 0.9,
                "top_k": 40
            });
            apply_prompt_cache_and_reasoning(&mut body, &entry, false, None);
            assert_eq!(body["max_tokens"], json!(128000));
            assert_eq!(body["thinking"]["type"], json!("adaptive"));
            assert_eq!(body["thinking"]["display"], json!("summarized"));
            assert_eq!(body["output_config"]["effort"], json!(expected_effort));
            // Sonnet 5 rejects the deprecated budget path with a 400.
            assert!(body.get("reasoning").is_none());
            // Sonnet 5 rejects sampling params with a 400; they must be scrubbed.
            assert!(body.get("temperature").is_none());
            assert!(body.get("top_p").is_none());
            assert!(body.get("top_k").is_none());
            // Sonnet 5 gets no legacy carried-forward beta flags.
            assert!(body.get("anthropic_beta").is_none());
            assert!(body.get("additionalModelRequestFields").is_none());
        }

        let mut invalid_effort = json!({
            "messages": [{"role":"system","content":"stable"}],
            "reasoning_effort": "bogus"
        });
        apply_prompt_cache_and_reasoning(&mut invalid_effort, &entry, false, None);
        assert_eq!(invalid_effort["output_config"]["effort"], json!("medium"));
        assert_eq!(invalid_effort["thinking"]["display"], json!("summarized"));
    }

    #[test]
    fn apply_prompt_cache_and_reasoning_for_claude_opus_5_uses_adaptive_thinking() {
        let mut entry =
            anthropic_entry("Claude Opus 5", "us.anthropic.claude-opus-5", Some(128000));
        entry.claude_prompt_cache_ttl = Some("1h".to_string());

        for expected_effort in ["low", "medium", "high", "xhigh", "max"] {
            let mut body = json!({
                "messages": [{"role":"system","content":"stable"}],
                "reasoning_effort": expected_effort,
                "temperature": 0.7,
                "top_p": 0.9,
                "top_k": 40
            });
            apply_prompt_cache_and_reasoning(&mut body, &entry, false, None);
            assert_eq!(body["max_tokens"], json!(128000));
            assert_eq!(body["thinking"]["type"], json!("adaptive"));
            assert_eq!(body["thinking"]["display"], json!("summarized"));
            assert_eq!(body["output_config"]["effort"], json!(expected_effort));
            // Opus 5 rejects the deprecated budget path with a 400.
            assert!(body.get("reasoning").is_none());
            // Opus 5 rejects sampling params with a 400; they must be scrubbed.
            assert!(body.get("temperature").is_none());
            assert!(body.get("top_p").is_none());
            assert!(body.get("top_k").is_none());
            // Opus 5 gets no legacy carried-forward beta flags.
            assert!(body.get("anthropic_beta").is_none());
            assert!(body.get("additionalModelRequestFields").is_none());
        }

        let mut invalid_effort = json!({
            "messages": [{"role":"system","content":"stable"}],
            "reasoning_effort": "bogus"
        });
        apply_prompt_cache_and_reasoning(&mut invalid_effort, &entry, false, None);
        assert_eq!(invalid_effort["output_config"]["effort"], json!("medium"));
        assert_eq!(invalid_effort["thinking"]["display"], json!("summarized"));

        // Opus 5 carries the 1h prompt-cache TTL on every breakpoint, like
        // Opus 4.8.
        let mut cached = json!({
            "messages": [
                {"role":"system","content":"model prompt"},
                {"role":"system","content":"<static_context>stable</static_context>"},
                {"role":"user","content":"hi"}
            ],
            "tools": [{"name":"tool-a"}],
            "reasoning_effort": "high"
        });
        apply_prompt_cache_and_reasoning(&mut cached, &entry, true, None);
        assert_eq!(
            cached["cache_control"],
            json!({"type":"ephemeral","ttl":"1h"})
        );
        assert_eq!(
            cached["messages"][0]["content"][0]["cache_control"],
            json!({"type":"ephemeral","ttl":"1h"})
        );
        assert_eq!(
            cached["messages"][1]["content"][0]["cache_control"],
            json!({"type":"ephemeral","ttl":"1h"})
        );
        assert_eq!(
            cached["tools"][0]["cache_control"],
            json!({"type":"ephemeral","ttl":"1h"})
        );
    }

    #[test]
    fn apply_prompt_cache_and_reasoning_scrubs_sampling_params_for_adaptive_opus_models() {
        let opus_48_entry = anthropic_entry(
            "Claude Opus 4.8",
            "us.anthropic.claude-opus-4-8",
            Some(128000),
        );
        let mut opus_48 = json!({
            "messages": [{"role":"system","content":"stable"}],
            "reasoning_effort": "high",
            "temperature": 0.5,
            "top_p": 0.8,
            "top_k": 20
        });
        apply_prompt_cache_and_reasoning(&mut opus_48, &opus_48_entry, false, None);
        assert!(opus_48.get("temperature").is_none());
        assert!(opus_48.get("top_p").is_none());
        assert!(opus_48.get("top_k").is_none());

        // Opus 4.6 still accepts sampling params; they must be preserved.
        let opus_46_entry = anthropic_entry(
            "Claude Opus 4.6",
            "us.anthropic.claude-opus-4-6-v1",
            Some(128000),
        );
        let mut opus_46 = json!({
            "messages": [{"role":"system","content":"stable"}],
            "reasoning_effort": "high",
            "temperature": 0.5
        });
        apply_prompt_cache_and_reasoning(&mut opus_46, &opus_46_entry, false, None);
        assert_eq!(opus_46["temperature"], json!(0.5));

        // Sonnet 4.6 (budget path) also keeps sampling params.
        let sonnet_46_entry = anthropic_entry(
            "Claude Sonnet 4.6",
            "us.anthropic.claude-sonnet-4-6",
            Some(64000),
        );
        let mut sonnet_46 = json!({
            "messages": [{"role":"system","content":"stable"}],
            "temperature": 0.5
        });
        apply_prompt_cache_and_reasoning(&mut sonnet_46, &sonnet_46_entry, false, None);
        assert_eq!(sonnet_46["temperature"], json!(0.5));
    }

    #[test]
    fn apply_prompt_cache_and_reasoning_merges_existing_claude_beta_values_without_duplicates() {
        let entry = anthropic_entry(
            "Claude Sonnet 4.6",
            "us.anthropic.claude-sonnet-4-6",
            Some(64000),
        );
        let mut body = json!({
            "messages": [{"role":"user","content":"hi"}],
            "anthropic_beta": ["context-1m-2025-08-07", "existing-top-level"],
            "additionalModelRequestFields": {
                "anthropic_beta": ["existing-nested", "context-1m-2025-08-07"]
            }
        });

        apply_prompt_cache_and_reasoning(&mut body, &entry, false, None);

        assert_eq!(
            body["anthropic_beta"],
            json!([
                "fine-grained-tool-streaming-2025-05-14",
                "interleaved-thinking-2025-05-14",
                "context-1m-2025-08-07",
                "existing-top-level",
                "existing-nested"
            ])
        );
        assert_eq!(
            body["additionalModelRequestFields"]["anthropic_beta"],
            body["anthropic_beta"]
        );
    }

    #[test]
    fn claude_caching_preserves_native_three_system_message_layout() {
        let entry = anthropic_entry(
            "Claude Sonnet 4.6",
            "us.anthropic.claude-sonnet-4-6",
            Some(64000),
        );
        let mut body = json!({
            "messages": [
                {"role":"system","content":"model base system prompt"},
                {"role":"system","content":"<static_context>stable</static_context>"},
                {"role":"system","content":"<dynamic_context>dynamic</dynamic_context>"},
                {"role":"user","content":"first"},
                {"role":"assistant","content":"answer"},
                {"role":"user","content":"second"}
            ],
            "tools": [{"name":"tool-a"}]
        });

        apply_prompt_cache_and_reasoning(&mut body, &entry, true, None);

        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 6);
        assert_eq!(
            messages
                .iter()
                .take(3)
                .map(|message| message["role"].clone())
                .collect::<Vec<_>>(),
            vec![json!("system"), json!("system"), json!("system")]
        );
        assert_eq!(
            message_text_content(&messages[0]).as_deref(),
            Some("<static_context>stable</static_context>")
        );
        assert!(message_text_content(&messages[1])
            .unwrap_or_default()
            .contains("model base system prompt"));
        assert!(message_text_content(&messages[2])
            .unwrap_or_default()
            .contains("<dynamic_context>dynamic</dynamic_context>"));
        assert_eq!(
            body["messages"][0]["content"][0]["cache_control"]["type"],
            json!("ephemeral")
        );
        assert_eq!(
            body["messages"][1]["content"][0]["cache_control"]["type"],
            json!("ephemeral")
        );
        assert!(body["messages"][2]
            .get("content")
            .and_then(Value::as_array)
            .is_none());
        assert_eq!(
            body["tools"][0]["cache_control"]["type"],
            json!("ephemeral")
        );
        assert_eq!(body["cache_control"]["type"], json!("ephemeral"));
        assert!(messages
            .iter()
            .filter(|message| message["role"] == json!("user"))
            .all(|message| {
                !message_text_content(message)
                    .unwrap_or_default()
                    .contains("<dynamic_context>")
            }));
    }

    #[test]
    fn claude_caching_skips_duplicate_system_breakpoint_when_prompt_is_static_context() {
        let entry = anthropic_entry(
            "Claude Sonnet 4.6",
            "us.anthropic.claude-sonnet-4-6",
            Some(64000),
        );
        // Only one system message that IS the static_context
        let mut body = json!({
            "messages": [
                {"role":"system","content":"<static_context>stable</static_context>"},
                {"role":"user","content":"first"},
                {"role":"assistant","content":"answer"},
                {"role":"user","content":"second"}
            ],
            "tools": [{"name":"tool-a"}]
        });

        apply_prompt_cache_and_reasoning(&mut body, &entry, true, None);

        // static_context gets the marker (only one system message, no duplicate)
        assert_eq!(
            body["messages"][0]["content"][0]["cache_control"]["type"],
            json!("ephemeral")
        );
    }

    #[test]
    fn claude_caching_sorts_tools_canonically() {
        let entry = anthropic_entry(
            "Claude Sonnet 4.6",
            "us.anthropic.claude-sonnet-4-6",
            Some(64000),
        );
        // Tools arrive in non-alphabetical order
        let mut body = json!({
            "messages": [
                {"role":"system","content":"<static_context>stable</static_context>"},
                {"role":"user","content":"hi"}
            ],
            "tools": [
                {"name":"zebra"},
                {"name":"alpha"},
                {"name":"mid"}
            ]
        });

        apply_prompt_cache_and_reasoning(&mut body, &entry, true, None);

        // Tools should be sorted alphabetically
        assert_eq!(body["tools"][0]["name"], json!("alpha"));
        assert_eq!(body["tools"][1]["name"], json!("mid"));
        assert_eq!(body["tools"][2]["name"], json!("zebra"));
        // cache_control on the last tool (after sort, that's "zebra")
        assert_eq!(
            body["tools"][2]["cache_control"]["type"],
            json!("ephemeral")
        );
        assert!(body["tools"][0].get("cache_control").is_none());
    }

    #[test]
    fn claude_caching_sorts_tools_in_openai_function_format() {
        let entry = anthropic_entry(
            "Claude Sonnet 4.6",
            "us.anthropic.claude-sonnet-4-6",
            Some(64000),
        );
        let mut body = json!({
            "messages": [
                {"role":"system","content":"<static_context>stable</static_context>"},
                {"role":"user","content":"hi"}
            ],
            "tools": [
                {"type":"function","function":{"name":"zebra","description":"z"}},
                {"type":"function","function":{"name":"alpha","description":"a"}}
            ]
        });

        apply_prompt_cache_and_reasoning(&mut body, &entry, true, None);

        assert_eq!(body["tools"][0]["function"]["name"], json!("alpha"));
        assert_eq!(body["tools"][1]["function"]["name"], json!("zebra"));
        assert_eq!(
            body["tools"][1]["cache_control"]["type"],
            json!("ephemeral")
        );
    }

    // ------------------------------------------------------------------
    // Tool-spec slimming (tool-compaction parity for Claude/Gemini)
    // ------------------------------------------------------------------

    const GOLDEN_MODIFY_DOC_TEXT: &str =
        include_str!("../tests/fixtures/google_workspace_modify_doc_text.json");

    fn function_tool(name: &str, description: &str, parameters: Value) -> Value {
        json!({
            "type": "function",
            "function": {"name": name, "description": description, "parameters": parameters}
        })
    }

    fn slimming_claude_entry() -> ModelEntry {
        let mut entry = anthropic_entry("Claude Opus 5", "us.anthropic.claude-opus-5", Some(64000));
        entry.tool_slimming = true;
        entry
    }

    #[test]
    fn slim_trims_long_descriptions_with_ellipsis() {
        let long = "word ".repeat(100);
        let mut tools = vec![function_tool("t", &long, json!({"type": "object"}))];
        slim_tool_definitions(&mut tools, ToolSlimmingMode::Parity);
        let description = tools[0]["function"]["description"].as_str().unwrap();
        assert!(description.chars().count() <= 240);
        assert!(description.ends_with("..."));
        assert!(!description.contains("  "));
    }

    #[test]
    fn slim_leaves_exactly_240_char_description_untouched() {
        let exact = "a".repeat(240);
        let mut tools = vec![function_tool("t", &exact, json!({"type": "object"}))];
        slim_tool_definitions(&mut tools, ToolSlimmingMode::Parity);
        assert_eq!(tools[0]["function"]["description"].as_str().unwrap(), exact);
    }

    #[test]
    fn slim_collapses_internal_whitespace() {
        let mut tools = vec![function_tool(
            "t",
            "Sends  an\n\temail   using\r\n Gmail",
            json!({"type": "object"}),
        )];
        slim_tool_definitions(&mut tools, ToolSlimmingMode::Parity);
        assert_eq!(
            tools[0]["function"]["description"],
            json!("Sends an email using Gmail")
        );
    }

    #[test]
    fn slim_is_utf8_safe_on_multibyte_descriptions() {
        let multibyte = "é".repeat(300);
        let mut tools = vec![function_tool("t", &multibyte, json!({"type": "object"}))];
        slim_tool_definitions(&mut tools, ToolSlimmingMode::Parity);
        let description = tools[0]["function"]["description"].as_str().unwrap();
        assert_eq!(description.chars().count(), 240);
        assert!(description.ends_with("..."));
        assert!(description.starts_with("ééé"));
    }

    #[test]
    fn slim_drops_empty_or_nonstring_descriptions() {
        let mut tools = vec![
            function_tool("empty", "   \n ", json!({"type": "object"})),
            json!({"type": "function", "function": {"name": "missing", "parameters": {"type": "object"}}}),
            json!({"type": "function", "function": {"name": "numeric", "description": 42, "parameters": {"type": "object"}}}),
        ];
        slim_tool_definitions(&mut tools, ToolSlimmingMode::Parity);
        for tool in &tools {
            assert!(
                tool["function"].get("description").is_none(),
                "description should be absent: {tool}"
            );
            assert!(tool["function"]["name"].is_string());
        }
    }

    #[test]
    fn slim_strips_schema_to_minimal_shape() {
        let mut tools = vec![function_tool(
            "t",
            "d",
            json!({
                "type": "object",
                "title": "Args",
                "default": {},
                "required": ["beta", "alpha"],
                "properties": {
                    "alpha": {
                        "type": "string",
                        "description": "dropped in parity",
                        "title": "Alpha",
                        "enum": ["x", "y"],
                        "default": "x",
                        "examples": ["x"]
                    },
                    "beta": {
                        "anyOf": [
                            {"type": "array", "items": {"type": "object", "properties": {"deep": {"type": "integer", "title": "Deep"}}}},
                            {"type": "null"}
                        ],
                        "default": null
                    },
                    "gamma": {"type": "object"}
                },
                "additionalProperties": {"type": "string", "title": "Extra"}
            }),
        )];
        slim_tool_definitions(&mut tools, ToolSlimmingMode::Parity);
        let parameters = &tools[0]["function"]["parameters"];
        assert!(parameters.get("title").is_none());
        assert!(parameters.get("default").is_none());
        assert_eq!(parameters["required"], json!(["alpha", "beta"]));
        let alpha = &parameters["properties"]["alpha"];
        assert_eq!(alpha["enum"], json!(["x", "y"]));
        assert!(alpha.get("description").is_none());
        assert!(alpha.get("title").is_none());
        assert!(alpha.get("default").is_none());
        assert!(alpha.get("examples").is_none());
        let beta_array = &parameters["properties"]["beta"]["anyOf"][0];
        assert!(beta_array["items"]["properties"]["deep"].get("title").is_none());
        assert_eq!(beta_array["items"]["properties"]["deep"]["type"], json!("integer"));
        // type:object without properties gains an empty properties map.
        assert_eq!(parameters["properties"]["gamma"]["properties"], json!({}));
        assert_eq!(
            parameters["additionalProperties"],
            json!({"type": "string"})
        );
    }

    #[test]
    fn slim_retain_mode_keeps_trimmed_param_descriptions() {
        let long_param_description = "detail ".repeat(60);
        let schema = json!({
            "type": "object",
            "properties": {"a": {"type": "string", "description": long_param_description}}
        });
        let mut parity_tools = vec![function_tool("t", "d", schema.clone())];
        slim_tool_definitions(&mut parity_tools, ToolSlimmingMode::Parity);
        assert!(parity_tools[0]["function"]["parameters"]["properties"]["a"]
            .get("description")
            .is_none());

        let mut retain_tools = vec![function_tool("t", "d", schema)];
        slim_tool_definitions(&mut retain_tools, ToolSlimmingMode::RetainParamDescriptions);
        let kept = retain_tools[0]["function"]["parameters"]["properties"]["a"]["description"]
            .as_str()
            .unwrap();
        assert!(kept.chars().count() <= 120);
        assert!(kept.ends_with("..."));
    }

    #[test]
    fn slim_is_idempotent_in_both_modes() {
        for mode in [
            ToolSlimmingMode::Parity,
            ToolSlimmingMode::RetainParamDescriptions,
        ] {
            let mut once: Vec<Value> = vec![
                serde_json::from_str(GOLDEN_MODIFY_DOC_TEXT).unwrap(),
                function_tool("t", &"word ".repeat(100), json!({"type": "object", "title": "X"})),
                json!({"name": "bare", "description": "short", "input_schema": {"type": "object", "title": "Y"}}),
            ];
            slim_tool_definitions(&mut once, mode);
            let mut twice = once.clone();
            slim_tool_definitions(&mut twice, mode);
            assert_eq!(
                serde_json::to_string(&once).unwrap(),
                serde_json::to_string(&twice).unwrap(),
                "slimming must be idempotent in {mode:?}"
            );
        }
    }

    #[test]
    fn slim_rebuilds_function_tools_dropping_unknown_keys() {
        let mut tools = vec![json!({
            "type": "function",
            "defer_loading": true,
            "function": {
                "name": " padded ",
                "description": "d",
                "parameters": {"type": "object"},
                "strict": true,
                "examples": ["dropped"]
            }
        })];
        slim_tool_definitions(&mut tools, ToolSlimmingMode::Parity);
        assert!(tools[0].get("defer_loading").is_none());
        assert_eq!(tools[0]["function"]["name"], json!("padded"));
        assert_eq!(tools[0]["function"]["strict"], json!(true));
        assert!(tools[0]["function"].get("examples").is_none());
    }

    #[test]
    fn slim_bare_shape_preserves_unknown_keys() {
        let mut tools = vec![json!({
            "name": "bare_tool",
            "description": "word ".repeat(100),
            "input_schema": {"type": "object", "title": "Args", "properties": {"a": {"type": "string", "title": "A"}}},
            "custom_key": 7
        })];
        slim_tool_definitions(&mut tools, ToolSlimmingMode::Parity);
        assert_eq!(tools[0]["custom_key"], json!(7));
        assert_eq!(tools[0]["name"], json!("bare_tool"));
        assert!(tools[0]["description"].as_str().unwrap().ends_with("..."));
        assert!(tools[0]["input_schema"].get("title").is_none());
        assert!(tools[0]["input_schema"]["properties"]["a"].get("title").is_none());
    }

    #[test]
    fn slim_never_panics_on_malformed_tools() {
        let mut tools = vec![
            json!("just a string"),
            json!({"type": "function", "function": 42}),
            json!({"type": "function"}),
            json!(null),
            json!(["nested", "array"]),
        ];
        let before = serde_json::to_string(&tools).unwrap();
        slim_tool_definitions(&mut tools, ToolSlimmingMode::Parity);
        assert_eq!(serde_json::to_string(&tools).unwrap(), before);
    }

    #[test]
    fn slim_preserves_nonobject_parameters() {
        let mut tools = vec![json!({
            "type": "function",
            "function": {"name": "t", "description": "d", "parameters": "weird"}
        })];
        slim_tool_definitions(&mut tools, ToolSlimmingMode::Parity);
        assert_eq!(tools[0]["function"]["parameters"], json!("weird"));
    }

    #[test]
    fn apply_prompt_cache_runs_slimming_before_sort_and_cache_control() {
        let entry = slimming_claude_entry();
        let long = "word ".repeat(100);
        let mut body = json!({
            "messages": [
                {"role": "system", "content": "<static_context>stable</static_context>"},
                {"role": "user", "content": "hi"}
            ],
            "tools": [
                function_tool("zebra", &long, json!({"type": "object", "title": "Z"})),
                function_tool("alpha", &long, json!({"type": "object", "title": "A"}))
            ]
        });
        apply_prompt_cache_and_reasoning(&mut body, &entry, true, None);
        assert_eq!(body["tools"][0]["function"]["name"], json!("alpha"));
        assert_eq!(body["tools"][1]["function"]["name"], json!("zebra"));
        for tool in body["tools"].as_array().unwrap() {
            let description = tool["function"]["description"].as_str().unwrap();
            assert!(description.chars().count() <= 240);
            assert!(tool["function"]["parameters"].get("title").is_none());
        }
        assert_eq!(body["tools"][1]["cache_control"]["type"], json!("ephemeral"));
    }

    #[test]
    fn apply_prompt_cache_skips_slimming_when_knob_off() {
        let entry = anthropic_entry("Claude Opus 5", "us.anthropic.claude-opus-5", Some(64000));
        let long = "word ".repeat(100);
        let mut body = json!({
            "messages": [{"role": "user", "content": "hi"}],
            "tools": [function_tool("t", &long, json!({"type": "object", "title": "kept"}))]
        });
        apply_prompt_cache_and_reasoning(&mut body, &entry, true, None);
        let description = body["tools"][0]["function"]["description"].as_str().unwrap();
        assert!(description.len() > 240);
        assert_eq!(body["tools"][0]["function"]["parameters"]["title"], json!("kept"));
    }

    #[test]
    fn gemini_arm_slims_only_when_enabled() {
        let long = "word ".repeat(100);
        let make_body = || {
            json!({
                "messages": [{"role": "user", "content": "hi"}],
                "tools": [function_tool("t", &long, json!({"type": "object", "title": "T"}))]
            })
        };

        let mut enabled_entry = gemini_entry("Gemini 3.6 Flash", "gemini-3.6-flash");
        enabled_entry.tool_slimming = true;
        let mut enabled_body = make_body();
        apply_prompt_cache_and_reasoning(&mut enabled_body, &enabled_entry, true, None);
        let slimmed = enabled_body["tools"][0]["function"]["description"]
            .as_str()
            .unwrap();
        assert!(slimmed.chars().count() <= 240);
        assert!(enabled_body["tools"][0]["function"]["parameters"].get("title").is_none());

        let disabled_entry = gemini_entry("Gemini 3.6 Flash", "gemini-3.6-flash");
        let mut disabled_body = make_body();
        apply_prompt_cache_and_reasoning(&mut disabled_body, &disabled_entry, true, None);
        assert!(disabled_body["tools"][0]["function"]["description"]
            .as_str()
            .unwrap()
            .len()
            > 240);
    }

    #[test]
    fn tool_slimming_env_override_beats_catalog_flag() {
        let mut claude_on = anthropic_entry("Claude", "us.anthropic.claude-opus-5", None);
        claude_on.tool_slimming = true;
        let claude_off = anthropic_entry("Claude", "us.anthropic.claude-opus-5", None);

        set_tool_slimming_env_override_for_tests(Some(Some(true)));
        assert!(tool_slimming_enabled_for(&claude_off));
        set_tool_slimming_env_override_for_tests(Some(Some(false)));
        assert!(!tool_slimming_enabled_for(&claude_on));
        set_tool_slimming_env_override_for_tests(Some(None));
        assert!(tool_slimming_enabled_for(&claude_on));
        assert!(!tool_slimming_enabled_for(&claude_off));

        // Provider gate: GPT aliases never slim bridge-side, even forced on.
        let mut gpt = openai_entry("GPT-5.6 Sol", "gpt-5.6-sol", None);
        gpt.tool_slimming = true;
        set_tool_slimming_env_override_for_tests(Some(Some(true)));
        assert!(!tool_slimming_enabled_for(&gpt));

        set_tool_slimming_env_override_for_tests(None);
    }

    #[test]
    fn apply_prompt_cache_honors_retain_mode_seam() {
        let entry = slimming_claude_entry();
        let long_param_description = "detail ".repeat(60);
        let mut body = json!({
            "messages": [{"role": "user", "content": "hi"}],
            "tools": [function_tool(
                "t",
                "d",
                json!({"type": "object", "properties": {"a": {"type": "string", "description": long_param_description}}})
            )]
        });
        set_tool_slimming_mode_for_tests(Some(ToolSlimmingMode::RetainParamDescriptions));
        apply_prompt_cache_and_reasoning(&mut body, &entry, true, None);
        set_tool_slimming_mode_for_tests(None);
        let kept = body["tools"][0]["function"]["parameters"]["properties"]["a"]["description"]
            .as_str()
            .unwrap();
        assert!(kept.chars().count() <= 120);
        assert!(kept.ends_with("..."));
    }

    #[test]
    fn parse_tool_slimming_env_and_mode_variants() {
        assert_eq!(parse_tool_slimming_env(Some("on")), Some(true));
        assert_eq!(parse_tool_slimming_env(Some(" TRUE ")), Some(true));
        assert_eq!(parse_tool_slimming_env(Some("1")), Some(true));
        assert_eq!(parse_tool_slimming_env(Some("off")), Some(false));
        assert_eq!(parse_tool_slimming_env(Some("False")), Some(false));
        assert_eq!(parse_tool_slimming_env(Some("0")), Some(false));
        assert_eq!(parse_tool_slimming_env(Some("")), None);
        assert_eq!(parse_tool_slimming_env(Some("bogus")), None);
        assert_eq!(parse_tool_slimming_env(None), None);

        assert_eq!(
            parse_tool_slimming_mode(Some("retain-param-descriptions")),
            ToolSlimmingMode::RetainParamDescriptions
        );
        assert_eq!(
            parse_tool_slimming_mode(Some("RETAIN_PARAM_DESCRIPTIONS")),
            ToolSlimmingMode::RetainParamDescriptions
        );
        assert_eq!(parse_tool_slimming_mode(Some("parity")), ToolSlimmingMode::Parity);
        assert_eq!(parse_tool_slimming_mode(None), ToolSlimmingMode::Parity);
    }

    #[test]
    fn golden_google_workspace_fixture_meets_size_ceiling() {
        let golden: Value = serde_json::from_str(GOLDEN_MODIFY_DOC_TEXT).unwrap();
        let preslim_bytes = serde_json::to_string(&golden).unwrap().len();
        assert!(
            preslim_bytes >= 20_000,
            "golden fixture unexpectedly small: {preslim_bytes}"
        );

        let mut tools = vec![golden];
        slim_tool_definitions(&mut tools, ToolSlimmingMode::Parity);
        let serialized = serde_json::to_string(&tools[0]).unwrap();
        assert!(
            serialized.len() < 4_096,
            "slimmed google_workspace_modify_doc_text should be under 4KB, got {}",
            serialized.len()
        );
        assert_eq!(
            tools[0]["function"]["name"],
            json!("google_workspace_modify_doc_text")
        );
        let description = tools[0]["function"]["description"].as_str().unwrap();
        assert!(description.chars().count() <= 240);
        assert!(description.ends_with("..."));
        // Byte-stable across repeated serialization.
        assert_eq!(serialized, serde_json::to_string(&tools[0]).unwrap());
    }
}
