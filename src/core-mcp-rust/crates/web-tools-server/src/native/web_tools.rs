use super::*;

#[derive(Clone, Debug, PartialEq, Eq)]
struct WebToolsConfig {
    openai_model: String,
    proxy_url: String,
    api_key: String,
    user_id: String,
    redact_allow: String,
    build_track: String,
    // OpenAI fast mode for the search helper. Empty or "off" = standard
    // processing; "priority" is the recommended opt-in value.
    service_tier: String,
}

impl WebToolsConfig {
    fn from_env() -> Self {
        Self {
            openai_model: env::var("WEB_TOOLS_OPENAI_MODEL")
                .unwrap_or_else(|_| "gpt-5.6-sol".to_string()),
            proxy_url: env::var("WEB_TOOLS_PROXY_URL")
                .unwrap_or_else(|_| "https://api.openai.com/v1".to_string()),
            api_key: env_var_with_file_fallback("PORTICO_LLM_API_KEY").unwrap_or_default(),
            user_id: env::var("PORTICO_USER_ID").unwrap_or_default(),
            redact_allow: env::var("PORTICO_REDACT_ALLOW").unwrap_or_else(|_| "*".to_string()),
            build_track: env::var("PORTICO_BUILD_TRACK").unwrap_or_else(|_| "sandbox".to_string()),
            service_tier: env::var("WEB_TOOLS_SERVICE_TIER").unwrap_or_default(),
        }
    }

    fn effective_service_tier(&self) -> Option<&str> {
        let trimmed = self.service_tier.trim();
        if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("off") {
            None
        } else {
            Some(trimmed)
        }
    }
}

/// Resolve a secret env var, falling back to `<NAME>_FILE` when the plain
/// variable is empty. Managed Docker runtimes inject `PORTICO_LLM_API_KEY` as a
/// mounted secret via `PORTICO_LLM_API_KEY_FILE=/run/secrets/...`, matching the
/// Bifrost bridge convention (`env_optional_with_file`). Without this fallback
/// the web-tools server sends unauthenticated requests to the LLM proxy, which
/// returns an error.
fn env_var_with_file_fallback(name: &str) -> Option<String> {
    if let Ok(value) = env::var(name) {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    let path = env::var(format!("{name}_FILE")).ok()?;
    let trimmed_path = path.trim();
    if trimmed_path.is_empty() {
        return None;
    }
    let contents = std::fs::read_to_string(trimmed_path).ok()?;
    let trimmed = contents.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn config_store() -> &'static std::sync::Mutex<Option<WebToolsConfig>> {
    static CONFIG: std::sync::OnceLock<std::sync::Mutex<Option<WebToolsConfig>>> =
        std::sync::OnceLock::new();
    CONFIG.get_or_init(|| std::sync::Mutex::new(None))
}

fn web_tools_config() -> WebToolsConfig {
    let mut config = config_store()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    if let Some(existing) = config.as_ref() {
        return existing.clone();
    }
    let loaded = WebToolsConfig::from_env();
    *config = Some(loaded.clone());
    loaded
}

#[cfg(test)]
pub(super) fn reset_web_tools_config() {
    *config_store()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner()) = None;
}

fn web_tools_request_timeout_seconds() -> f64 {
    300.0
}

fn web_tools_openai_model() -> String {
    web_tools_config().openai_model
}

fn web_tools_proxy_url() -> String {
    web_tools_config().proxy_url
}

fn web_search_error(
    tool_name: &str,
    error_type: &str,
    error: impl std::fmt::Display,
) -> Result<Value> {
    success_text(json!({
        "error": error.to_string(),
        "error_type": error_type,
        "tool": tool_name,
        "success": false,
    }))
}

fn has_non_empty_array_argument(arguments: &Map<String, Value>, key: &str) -> bool {
    arguments
        .get(key)
        .and_then(Value::as_array)
        .map(|items| !items.is_empty())
        .unwrap_or(false)
}

async fn execute_web_search(arguments: &Map<String, Value>) -> Result<Value> {
    let query = arguments
        .get("query")
        .and_then(Value::as_str)
        .context("query is required")?;
    let config = web_tools_config();

    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    if !config.api_key.is_empty() {
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", config.api_key))
                .context("invalid API key header")?,
        );
    }

    insert_header(&mut headers, "x-portico-userid", &config.user_id)?;
    insert_header(&mut headers, "x-portico-redact-allow", &config.redact_allow)?;
    insert_header(&mut headers, "x-portico-appid", "portico")?;
    insert_header(&mut headers, "x-portico-track", &config.build_track)?;
    insert_header(&mut headers, "x-portico-log-request", "false")?;
    insert_header(&mut headers, "x-portico-log-response", "false")?;

    let mut web_search_tool = json!({ "type": "web_search" });
    if let Some(allowed_domains) = arguments
        .get("allowed_domains")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
        .cloned()
    {
        if let Some(object) = web_search_tool.as_object_mut() {
            object.insert(
                "filters".to_string(),
                json!({ "allowed_domains": Value::Array(allowed_domains) }),
            );
        }
    } else if let Some(blocked_domains) = arguments
        .get("blocked_domains")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
        .cloned()
    {
        if let Some(object) = web_search_tool.as_object_mut() {
            object.insert(
                "filters".to_string(),
                json!({ "blocked_domains": Value::Array(blocked_domains) }),
            );
        }
    }

    if let Some(user_location) = arguments.get("user_location").and_then(Value::as_object) {
        let mut location = Map::new();
        location.insert("type".to_string(), Value::String("approximate".to_string()));
        for key in ["country", "city", "region", "timezone"] {
            if let Some(value) = user_location.get(key).cloned() {
                location.insert(key.to_string(), value);
            }
        }
        if location.len() > 1 {
            if let Some(object) = web_search_tool.as_object_mut() {
                object.insert("user_location".to_string(), Value::Object(location));
            }
        }
    }

    let responses_url = format!("{}/responses", config.proxy_url.trim_end_matches('/'));
    let mut request_body = json!({
        "model": config.openai_model,
        "tools": [web_search_tool],
        "input": format!(
            "Search the web for: {query}\n\nProvide a comprehensive answer based on the search results."
        ),
    });
    if let Some((tier, body_object)) = config
        .effective_service_tier()
        .zip(request_body.as_object_mut())
    {
        body_object.insert("service_tier".to_string(), Value::String(tier.to_string()));
    }
    let response = reqwest::Client::new()
        .post(responses_url)
        .timeout(std::time::Duration::from_secs_f64(
            web_tools_request_timeout_seconds(),
        ))
        .headers(headers)
        .json(&request_body)
        .send()
        .await
        .context("failed to execute web search")?
        .error_for_status()
        .context("web search proxy returned an error")?;

    let payload: Value = response
        .json()
        .await
        .context("failed to decode web search response")?;
    let mut response_text = String::new();
    let mut citations = Vec::new();
    let mut web_search_calls = 0;

    for output_item in payload
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        match output_item.get("type").and_then(Value::as_str) {
            Some("web_search_call") => web_search_calls += 1,
            Some("message") => {
                for content_block in output_item
                    .get("content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    if content_block.get("type").and_then(Value::as_str) != Some("output_text") {
                        continue;
                    }
                    if let Some(text) = content_block.get("text").and_then(Value::as_str) {
                        response_text.push_str(text);
                    }
                    for annotation in content_block
                        .get("annotations")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                    {
                        if annotation.get("type").and_then(Value::as_str) == Some("url_citation") {
                            citations.push(json!({
                                "url": annotation.get("url").cloned().unwrap_or(Value::Null),
                                "title": annotation.get("title").cloned().unwrap_or(Value::String(String::new())),
                                "start_index": annotation.get("start_index").cloned().unwrap_or(Value::Null),
                                "end_index": annotation.get("end_index").cloned().unwrap_or(Value::Null),
                            }));
                        }
                    }
                }
            }
            _ => {}
        }
    }

    let usage = payload
        .get("usage")
        .and_then(Value::as_object)
        .map(|usage| {
            json!({
                "input_tokens": usage.get("input_tokens").cloned().unwrap_or(Value::from(0)),
                "output_tokens": usage.get("output_tokens").cloned().unwrap_or(Value::from(0)),
                "web_search_calls": web_search_calls,
            })
        })
        .unwrap_or_else(|| json!({}));

    Ok(json!({
        "success": true,
        "query": query,
        "response": response_text,
        "citations": citations,
        "usage": usage,
        "model": config.openai_model,
    }))
}

pub(super) async fn handle_web_search(arguments: &Map<String, Value>) -> Result<Value> {
    if !arguments.contains_key("query") {
        return web_search_error("web_search", "KeyError", "'query'");
    }

    if has_non_empty_array_argument(arguments, "allowed_domains")
        && has_non_empty_array_argument(arguments, "blocked_domains")
    {
        return web_search_error(
            "web_search",
            "ValueError",
            "allowed_domains and blocked_domains cannot be used together",
        );
    }

    match execute_web_search(arguments).await {
        Ok(payload) => success_text(payload),
        Err(error) => web_search_error("web_search", "RuntimeError", error),
    }
}

fn insert_header(headers: &mut HeaderMap, key: &str, value: &str) -> Result<()> {
    let header_name = HeaderName::from_bytes(key.as_bytes())
        .with_context(|| format!("invalid header name {key}"))?;
    headers.insert(
        header_name,
        HeaderValue::from_str(value).with_context(|| format!("invalid header value for {key}"))?,
    );
    Ok(())
}

#[cfg(test)]
#[path = "web_tools_tests.rs"]
mod tests;
