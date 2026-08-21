use super::*;
use chrono::Local;

pub(super) fn generate_variables() -> Map<String, Value> {
    let now = Local::now();
    Map::from_iter([
        (
            "{{USER_NAME}}".to_string(),
            Value::String("Sub-Agent".to_string()),
        ),
        (
            "{{USER_LOCATION}}".to_string(),
            Value::String("Unknown".to_string()),
        ),
        (
            "{{CURRENT_DATETIME}}".to_string(),
            Value::String(now.format("%Y-%m-%d %H:%M:%S").to_string()),
        ),
        (
            "{{CURRENT_DATE}}".to_string(),
            Value::String(now.format("%Y-%m-%d").to_string()),
        ),
        (
            "{{CURRENT_TIME}}".to_string(),
            Value::String(now.format("%H:%M:%S").to_string()),
        ),
        (
            "{{CURRENT_WEEKDAY}}".to_string(),
            Value::String(now.format("%A").to_string()),
        ),
        (
            "{{CURRENT_TIMEZONE}}".to_string(),
            Value::String("America/New_York".to_string()),
        ),
        (
            "{{USER_LANGUAGE}}".to_string(),
            Value::String("en-US".to_string()),
        ),
    ])
}

pub(super) fn extract_last_sentence(content: &str) -> String {
    Regex::new(r"(?s)<details.*?</details>\s*")
        .map(|pattern| pattern.replace_all(content, "").into_owned())
        .unwrap_or_else(|_| content.to_string())
}

fn markdown_report_anchor(content: &str) -> Option<usize> {
    let mut anchors = Vec::new();
    for marker in ["\n## ", "\n### ", "\n# ", "## ", "### ", "# "] {
        if let Some(idx) = content.find(marker) {
            anchors.push(idx + usize::from(marker.starts_with('\n')));
        }
    }
    for marker in ["Executive summary", "Executive Summary"] {
        if let Some(idx) = content.find(marker) {
            anchors.push(idx);
        }
    }
    anchors.into_iter().min()
}

fn looks_like_tool_transcript(content: &str) -> bool {
    let lowered = content.to_ascii_lowercase();
    lowered.contains("to=functions.")
        || lowered.contains("to=agent_vm_")
        || lowered.contains("to=vm_")
        || lowered.contains("tool_call_id=")
        || lowered.contains("\"vm_id\":")
}

fn sanitize_parent_facing_text(content: &str) -> String {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    if looks_like_tool_transcript(trimmed) {
        if let Some(anchor) = markdown_report_anchor(trimmed) {
            let anchored = trimmed[anchor..].trim();
            if !anchored.is_empty() {
                return anchored.to_string();
            }
        }
    }

    trimmed.to_string()
}

pub(super) fn extract_parent_facing_response(message: &Value) -> String {
    if let Some(content_blocks) = message.get("contentBlocks").and_then(Value::as_array) {
        for block in content_blocks.iter().rev() {
            if block.get("type").and_then(Value::as_str) != Some("text") {
                continue;
            }
            let candidate = sanitize_parent_facing_text(
                block
                    .get("content")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            );
            if !candidate.is_empty() {
                return candidate;
            }
        }
    }

    sanitize_parent_facing_text(&extract_last_sentence(
        message
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    ))
}

fn browser_facing_workspace_url(url: &str) -> String {
    let trimmed = url.trim();
    trimmed
        .strip_prefix("http://host.docker.internal:9876/workspace/")
        .map(|path| format!("http://localhost:9876/workspace/{path}"))
        .unwrap_or(trimmed.to_string())
}

pub(super) fn display_content_for_chat(content: &Value) -> Value {
    match content {
        Value::String(value) => Value::String(value.clone()),
        Value::Null => Value::String(String::new()),
        Value::Array(blocks) => {
            let mut text_parts = Vec::new();
            let mut image_urls = Vec::new();
            let mut image_count = 0_usize;

            for block in blocks {
                let Some(block) = block.as_object() else {
                    continue;
                };
                match block.get("type").and_then(Value::as_str) {
                    Some("text") | Some("input_text") => {
                        if let Some(text) = block.get("text").and_then(Value::as_str) {
                            let text = text.trim();
                            if !text.is_empty() {
                                text_parts.push(text.to_string());
                            }
                        }
                    }
                    Some("image_url") => {
                        image_count += 1;
                        if let Some(url) = block
                            .get("image_url")
                            .and_then(Value::as_object)
                            .and_then(|image_url| image_url.get("url"))
                            .and_then(Value::as_str)
                            .filter(|url| {
                                let url = url.trim();
                                !url.is_empty() && !url.starts_with("data:image/")
                            })
                        {
                            image_urls.push(browser_facing_workspace_url(url));
                        }
                    }
                    Some("image") => {
                        image_count += 1;
                    }
                    _ => {}
                }
            }

            let mut display = text_parts.join("\n\n");
            if image_count > 0 {
                if !display.is_empty() {
                    display.push_str("\n\n");
                }
                display.push_str("Image inputs attached for model analysis:");
                for (idx, url) in image_urls.iter().enumerate() {
                    display.push_str(&format!("\n{}. {}", idx + 1, url));
                }
                if image_urls.len() < image_count {
                    display.push_str(&format!(
                        "\n{} image input(s) were attached without displayable URLs.",
                        image_count - image_urls.len()
                    ));
                }
            }

            Value::String(display)
        }
        _ => Value::String(serde_json::to_string(content).unwrap_or_default()),
    }
}

pub(super) fn extract_error_message(error_data: &Value) -> String {
    if let Some(message) = error_data.as_str() {
        return message.to_string();
    }
    if let Some(object) = error_data.as_object() {
        if let Some(content) = object.get("content") {
            if let Some(message) = content.as_str() {
                return message.to_string();
            }
            if let Some(content_object) = content.as_object() {
                for key in ["message", "content", "error"] {
                    if let Some(message) = content_object.get(key).and_then(Value::as_str) {
                        return message.to_string();
                    }
                }
            }
        }
        for key in ["message", "error", "detail"] {
            if let Some(message) = object.get(key).and_then(Value::as_str) {
                return message.to_string();
            }
        }
    }
    error_data.to_string()
}

pub(super) fn is_context_window_error(message: &str) -> bool {
    let normalized = message.to_lowercase();
    normalized.contains("context window")
        || normalized.contains("context budget")
        || normalized.contains("context length")
        || normalized.contains("max context")
        || (normalized.contains("exceeded") && normalized.contains("context"))
}

fn is_message_done(value: Option<&Value>) -> bool {
    match value {
        Some(Value::String(value)) => value.eq_ignore_ascii_case("true"),
        Some(Value::Bool(true)) => true,
        _ => false,
    }
}

fn normalize_reason(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_lowercase())
        .unwrap_or_default()
}

pub(super) fn has_pending_tool_calls(message: &Value) -> bool {
    if let Some(content_blocks) = message.get("contentBlocks").and_then(Value::as_array) {
        for block in content_blocks {
            if block.get("type").and_then(Value::as_str) != Some("tool_calls") {
                continue;
            }
            let content = block.get("content").and_then(Value::as_array);
            let results = block.get("results").and_then(Value::as_array);
            let Some(content) = content else {
                return true;
            };
            let Some(results) = results else {
                return true;
            };
            if results.len() < content.len() || block.get("ended_at").is_none() {
                return true;
            }
        }
        return false;
    }

    if message
        .get("content")
        .and_then(Value::as_str)
        .map(|content| content.contains("<details type=\"tool_calls\" done=\"false\""))
        .unwrap_or(false)
    {
        return true;
    }

    message.get("tool_calls").is_some() && message.get("tool_results").is_none()
}

pub(super) fn message_is_complete(message: &Value) -> bool {
    if message.get("role").and_then(Value::as_str) != Some("assistant") {
        return false;
    }

    if has_pending_tool_calls(message) {
        return false;
    }
    if is_message_done(message.get("done")) {
        return true;
    }

    let finish_reason = normalize_reason(
        message
            .get("finish_reason")
            .or_else(|| message.get("finishReason")),
    );
    let stop_reason = normalize_reason(
        message
            .get("stop_reason")
            .or_else(|| message.get("stopReason")),
    );
    if [
        "length",
        "max_tokens",
        "max_output_tokens",
        "content_length",
        "tool_calls",
    ]
    .contains(&finish_reason.as_str())
    {
        return false;
    }
    if [
        "length",
        "max_tokens",
        "max_output_tokens",
        "tool_use",
        "tool_calls",
    ]
    .contains(&stop_reason.as_str())
    {
        return false;
    }

    let usage = message
        .get("usage")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    message
        .get("content")
        .and_then(Value::as_str)
        .filter(|content| !content.is_empty())
        .is_some()
        && ["total_tokens", "completion_tokens", "prompt_tokens"]
            .iter()
            .any(|key| usage.get(*key).and_then(Value::as_i64).unwrap_or(0) > 0)
}

pub(super) async fn align_messages(
    token: &str,
    chat_id: &str,
    model: &str,
    chat_data: &Value,
) -> Result<()> {
    let history_messages = chat_data
        .get("chat")
        .and_then(|value| value.get("history"))
        .and_then(|value| value.get("messages"))
        .and_then(Value::as_object)
        .cloned()
        .context("chat history missing messages")?;
    let mut history_messages = history_messages;
    let mut user_entry = None;
    let mut assistant_entry = None;
    for (message_id, message) in &history_messages {
        if message.get("role").and_then(Value::as_str) == Some("user") {
            user_entry = Some((message_id.clone(), message.clone()));
        } else {
            assistant_entry = Some((message_id.clone(), message.clone()));
        }
    }
    let (user_message_id, user_message) = user_entry.context("Could not identify user message")?;
    let (assistant_message_id, assistant_message) =
        assistant_entry.context("Could not identify assistant message")?;
    let assistant_content = assistant_message
        .get("content")
        .cloned()
        .unwrap_or(Value::String(String::new()));
    let last_sentence = extract_parent_facing_response(&assistant_message);
    let align_timestamp = now_epoch_seconds() as i64;

    if let Some(message) = history_messages
        .get_mut(&user_message_id)
        .and_then(Value::as_object_mut)
    {
        message.insert("parentId".to_string(), Value::Null);
        message.insert(
            "content".to_string(),
            display_content_for_chat(user_message.get("content").unwrap_or(&Value::Null)),
        );
        message.insert(
            "childrenIds".to_string(),
            Value::Array(vec![Value::String(assistant_message_id.clone())]),
        );
    }
    if let Some(message) = history_messages
        .get_mut(&assistant_message_id)
        .and_then(Value::as_object_mut)
    {
        message.insert(
            "id".to_string(),
            Value::String(assistant_message_id.clone()),
        );
        message.insert(
            "parentId".to_string(),
            Value::String(user_message_id.clone()),
        );
        message.insert("childrenIds".to_string(), json!([]));
        message.insert("role".to_string(), Value::String("assistant".to_string()));
        message.insert("model".to_string(), Value::String(model.to_string()));
        message.insert("modelName".to_string(), Value::String(model.to_string()));
        message.insert("modelIdx".to_string(), Value::from(0));
        message.insert("timestamp".to_string(), Value::from(align_timestamp));
        message.insert("done".to_string(), Value::Bool(true));
        message.insert(
            "lastSentence".to_string(),
            Value::String(last_sentence.clone()),
        );
    }

    let payload = json!({
        "chat": {
            "models": chat_data.get("chat").and_then(|value| value.get("models")).cloned().unwrap_or_else(|| json!([model])),
            "history": { "messages": history_messages, "currentId": assistant_message_id.clone() },
            "messages": [
                {
                    "id": user_message_id.clone(),
                    "parentId": Value::Null,
                    "childrenIds": [assistant_message_id.clone()],
                    "role": "user",
                    "content": display_content_for_chat(user_message.get("content").unwrap_or(&Value::Null)),
                    "timestamp": user_message.get("timestamp").cloned().unwrap_or(Value::Null),
                    "models": user_message.get("models").cloned().unwrap_or_else(|| json!([model])),
                },
                {
                    "id": assistant_message_id,
                    "parentId": user_message_id,
                    "childrenIds": [],
                    "role": "assistant",
                    "content": assistant_content,
                    "model": model,
                    "modelName": model,
                    "modelIdx": 0,
                    "timestamp": align_timestamp,
                    "done": true,
                    "lastSentence": last_sentence,
                }
            ],
            "params": chat_data.get("chat").and_then(|value| value.get("params")).cloned().unwrap_or_else(|| json!({})),
            "files": chat_data.get("chat").and_then(|value| value.get("files")).cloned().unwrap_or_else(|| json!([])),
        }
    });
    openwebui_post_json(&format!("/api/v1/chats/{chat_id}"), token, &payload, 30.0).await?;
    Ok(())
}

pub(super) fn extract_usage_from_chat(chat_data: &Value) -> i64 {
    chat_data
        .get("chat")
        .and_then(|value| value.get("history"))
        .and_then(|value| value.get("messages"))
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .find_map(|(_, message)| {
            if message.get("role").and_then(Value::as_str) != Some("assistant") {
                return None;
            }
            let usage = message.get("usage")?.as_object()?;
            usage
                .get("prompt_tokens")
                .or_else(|| usage.get("input_tokens"))
                .or_else(|| usage.get("inputTokens"))
                .and_then(Value::as_i64)
        })
        .unwrap_or(0)
}

pub(super) fn extract_tool_call_count_from_chat(chat_data: &Value) -> i64 {
    let mut count = 0_i64;
    let messages = chat_data
        .get("chat")
        .and_then(|value| value.get("history"))
        .and_then(|value| value.get("messages"))
        .and_then(Value::as_object);

    for message in messages.into_iter().flat_map(|entries| entries.values()) {
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }

        if let Some(content_blocks) = message.get("contentBlocks").and_then(Value::as_array) {
            for block in content_blocks {
                if block.get("type").and_then(Value::as_str) != Some("tool_calls") {
                    continue;
                }
                match block.get("content") {
                    Some(Value::Array(items)) => count += items.len() as i64,
                    Some(Value::Null) | None => {}
                    Some(_) => count += 1,
                }
            }
            continue;
        }

        match message.get("tool_calls") {
            Some(Value::Array(items)) => count += items.len() as i64,
            Some(Value::Null) | None => {}
            Some(_) => count += 1,
        }
    }

    count
}

pub(super) async fn save_chat_state(
    chat_id: &str,
    context_tokens: i64,
    max_context_tokens: i64,
    reasoning_effort: Option<&str>,
    model_name: Option<&str>,
    token: &str,
) {
    let reasoning_effort_by_model = reasoning_effort
        .map(|value| json!({ "0": value }))
        .unwrap_or_else(|| json!({}));
    let payload = json!({
        "context_tokens": context_tokens,
        "max_context_tokens": max_context_tokens,
        "reasoning_effort": reasoning_effort,
        "reasoning_effort_by_model": reasoning_effort_by_model,
        "model_name": model_name,
    });
    let base_url = std::env::var("CHAT_STATE_API_BASE_URL")
        .unwrap_or_else(|_| "http://chat-state-api:8000".to_string());
    // The chat-state-api requires the OWUI bearer token — without it the PUT is
    // rejected (401) and the subagent chat's state (incl. reasoning effort) is
    // never persisted, so opening it shows the low/medium default.
    let _ = reqwest::Client::new()
        .put(format!("{base_url}/api/v1/chat-state/{chat_id}"))
        .bearer_auth(token)
        .json(&payload)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .and_then(reqwest::Response::error_for_status);
}

#[cfg(test)]
#[path = "subagents_chat_tests.rs"]
mod tests;
