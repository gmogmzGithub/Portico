use super::*;
use tokio::time::{sleep, Duration};

const USER_QUESTION_TRIGGER_TIMEOUT_SECONDS: f64 = 10.0;
const USER_QUESTION_STATUS_TIMEOUT_SECONDS: f64 = 5.0;
const USER_QUESTION_POLL_INTERVAL_MILLIS: u64 = 500;
const USER_QUESTION_DEFAULT_TIMEOUT_SECONDS: u64 = 60 * 60;
const USER_QUESTION_MIN_TIMEOUT_SECONDS: u64 = 30;
const USER_QUESTION_MAX_TIMEOUT_SECONDS: u64 = 60 * 60;
const USER_QUESTION_MAX_COUNT: usize = 5;
const USER_QUESTION_MAX_OPTION_COUNT: usize = 5;
const USER_QUESTION_MAX_COMPONENT_COUNT: usize = 4;
const USER_QUESTION_MAX_COMPONENT_DEFAULT_IDS: usize = 20;
const USER_QUESTION_RESERVED_OPTION_ID: &str = "none_of_the_above";
// Curated in-chat components the app can render inside the Ask User Question
// modal instead of (or alongside) plain options — the app substitutes its real
// capability pickers and translates the selection back into the answer.
const USER_QUESTION_COMPONENT_TYPES: &[&str] = &[
    "skill_picker",
    "mcp_server_picker",
    "model_picker",
    "reasoning_effort_picker",
];

struct ElectronJsonResponse {
    status: reqwest::StatusCode,
    json: Option<Value>,
    body_text: String,
}

async fn electron_questions_post(
    path: &str,
    payload: &Value,
    timeout_seconds: f64,
) -> std::result::Result<ElectronJsonResponse, reqwest::Error> {
    let response = electron_http_client()
        .post(format!("{}{}", electron_api_base(), path))
        .timeout(std::time::Duration::from_secs_f64(timeout_seconds))
        .json(payload)
        .send()
        .await?;
    let status = response.status();
    let body_text = response.text().await?;
    let json = serde_json::from_str::<Value>(&body_text).ok();
    Ok(ElectronJsonResponse {
        status,
        json,
        body_text,
    })
}

async fn electron_questions_get(
    path: &str,
    timeout_seconds: f64,
) -> std::result::Result<ElectronJsonResponse, reqwest::Error> {
    let response = electron_http_client()
        .get(format!("{}{}", electron_api_base(), path))
        .timeout(std::time::Duration::from_secs_f64(timeout_seconds))
        .send()
        .await?;
    let status = response.status();
    let body_text = response.text().await?;
    let json = serde_json::from_str::<Value>(&body_text).ok();
    Ok(ElectronJsonResponse {
        status,
        json,
        body_text,
    })
}

fn user_question_transport_failure(action: &str, error: &reqwest::Error) -> Value {
    let error_message = if error.is_connect() {
        format!(
            "Failed to {action}: cannot connect to Electron app at {}",
            electron_api_base()
        )
    } else if error.is_timeout() {
        format!("Failed to {action}: Electron API request timed out")
    } else {
        format!("Failed to {action}: {error}")
    };

    json!({
        "success": false,
        "status": "error",
        "error": error_message,
    })
}

fn normalize_user_question_response(action: &str, response: ElectronJsonResponse) -> Value {
    let ElectronJsonResponse {
        status,
        json,
        body_text,
    } = response;
    let trimmed_body = body_text.trim();

    match json {
        Some(Value::Object(mut object)) => {
            object.insert("success".to_string(), Value::Bool(status.is_success()));
            if !status.is_success() {
                object
                    .entry("error".to_string())
                    .or_insert_with(|| Value::String(format!("HTTP {}", status.as_u16())));
                object.insert("http_status".to_string(), json!(status.as_u16()));
            }
            Value::Object(object)
        }
        Some(value) => {
            let mut payload = json!({
                "success": status.is_success(),
                "data": value,
            });
            if !status.is_success() {
                payload["error"] = if trimmed_body.is_empty() {
                    Value::String(format!("HTTP {}", status.as_u16()))
                } else {
                    Value::String(trimmed_body.to_string())
                };
                payload["status"] = Value::String("error".to_string());
                payload["http_status"] = json!(status.as_u16());
            }
            payload
        }
        None => json!({
            "success": false,
            "status": "error",
            "error": if status.is_success() {
                format!("Failed to decode {action} response from Electron API")
            } else if trimmed_body.is_empty() {
                format!("HTTP {}", status.as_u16())
            } else {
                trimmed_body.to_string()
            },
            "http_status": status.as_u16(),
        }),
    }
}

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

// Validate an optional list of default-selection ids (a component's
// default_selected, or one value of an option's component_defaults map).
// Absent/null — and, unless keep_empty, an empty list — normalize to None so
// legacy payloads stay byte-identical. keep_empty preserves an explicit []
// where it is meaningful ("reveal this picker empty").
fn validate_default_id_list(
    value: Option<&Value>,
    field_name: &str,
    keep_empty: bool,
) -> Result<Option<Vec<String>>> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let entries = value
        .as_array()
        .with_context(|| format!("{field_name} must be an array of strings"))?;
    if entries.is_empty() {
        return Ok(if keep_empty { Some(Vec::new()) } else { None });
    }
    if entries.len() > USER_QUESTION_MAX_COMPONENT_DEFAULT_IDS {
        bail!(
            "{field_name} must contain at most {USER_QUESTION_MAX_COMPONENT_DEFAULT_IDS} items"
        );
    }
    let mut seen = HashSet::new();
    let mut ids = Vec::with_capacity(entries.len());
    for (entry_index, entry) in entries.iter().enumerate() {
        let id = required_limited_string(entry, &format!("{field_name}[{entry_index}]"), 200)?;
        if !seen.insert(id.clone()) {
            bail!("Duplicate id in {field_name}: {id}");
        }
        ids.push(id);
    }
    Ok(Some(ids))
}

fn validate_question_options(
    question_index: usize,
    options: &[Value],
    component_ids: &HashSet<String>,
) -> Result<Vec<Value>> {
    if options.len() < 2 || options.len() > USER_QUESTION_MAX_OPTION_COUNT {
        bail!(
            "questions[{question_index}].options must contain between 2 and {USER_QUESTION_MAX_OPTION_COUNT} items"
        );
    }

    let mut seen_option_ids = HashSet::new();
    let mut normalized = Vec::with_capacity(options.len());
    for (option_index, option) in options.iter().enumerate() {
        let option_object = option.as_object().with_context(|| {
            format!("questions[{question_index}].options[{option_index}] must be an object")
        })?;

        let option_id = required_limited_string(
            option_object.get("id").with_context(|| {
                format!("questions[{question_index}].options[{option_index}].id is required")
            })?,
            &format!("questions[{question_index}].options[{option_index}].id"),
            120,
        )?;
        if option_id == USER_QUESTION_RESERVED_OPTION_ID {
            bail!(
                "questions[{question_index}].options[{option_index}].id cannot use reserved option id \"{USER_QUESTION_RESERVED_OPTION_ID}\""
            );
        }
        if !seen_option_ids.insert(option_id.clone()) {
            bail!("Duplicate option id for question {question_index}: {option_id}");
        }

        let label = required_limited_string(
            option_object.get("label").with_context(|| {
                format!("questions[{question_index}].options[{option_index}].label is required")
            })?,
            &format!("questions[{question_index}].options[{option_index}].label"),
            120,
        )?;
        let description = optional_limited_string(
            option_object.get("description"),
            &format!("questions[{question_index}].options[{option_index}].description"),
            280,
        )?;

        // Optional per-option picker seeds: choosing this option reveals the
        // question's components prefilled with these ids (the user can still
        // add/remove before submitting). Keys must name declared component ids.
        let component_defaults = match option_object.get("component_defaults") {
            None => None,
            Some(value) if value.is_null() => None,
            Some(value) => {
                let map = value.as_object().with_context(|| {
                    format!(
                        "questions[{question_index}].options[{option_index}].component_defaults must be an object"
                    )
                })?;
                if map.is_empty() {
                    None
                } else {
                    if component_ids.is_empty() {
                        bail!(
                            "questions[{question_index}].options[{option_index}].component_defaults requires components"
                        );
                    }
                    let mut normalized_defaults = Map::new();
                    for (key, ids_value) in map {
                        if !component_ids.contains(key) {
                            bail!(
                                "questions[{question_index}].options[{option_index}].component_defaults key \"{key}\" does not match any component id"
                            );
                        }
                        let ids = validate_default_id_list(
                            Some(ids_value),
                            &format!(
                                "questions[{question_index}].options[{option_index}].component_defaults.{key}"
                            ),
                            true,
                        )?
                        .unwrap_or_default();
                        normalized_defaults.insert(key.clone(), json!(ids));
                    }
                    Some(Value::Object(normalized_defaults))
                }
            }
        };

        normalized.push(json!({
            "id": option_id,
            "label": label,
            "description": description,
            "component_defaults": component_defaults,
        }));
    }

    Ok(normalized)
}

fn validate_question_components(
    question_index: usize,
    components: &[Value],
) -> Result<Vec<Value>> {
    if components.is_empty() || components.len() > USER_QUESTION_MAX_COMPONENT_COUNT {
        bail!(
            "questions[{question_index}].components must contain between 1 and {USER_QUESTION_MAX_COMPONENT_COUNT} items"
        );
    }
    let mut seen_ids = HashSet::new();
    let mut normalized = Vec::with_capacity(components.len());
    for (component_index, component) in components.iter().enumerate() {
        let component_object = component.as_object().with_context(|| {
            format!("questions[{question_index}].components[{component_index}] must be an object")
        })?;
        let component_type = required_limited_string(
            component_object.get("type").with_context(|| {
                format!("questions[{question_index}].components[{component_index}].type is required")
            })?,
            &format!("questions[{question_index}].components[{component_index}].type"),
            60,
        )?;
        if !USER_QUESTION_COMPONENT_TYPES.contains(&component_type.as_str()) {
            bail!(
                "questions[{question_index}].components[{component_index}].type \"{component_type}\" is not a supported component (one of: {})",
                USER_QUESTION_COMPONENT_TYPES.join(", ")
            );
        }
        let component_id = required_limited_string(
            component_object.get("id").with_context(|| {
                format!("questions[{question_index}].components[{component_index}].id is required")
            })?,
            &format!("questions[{question_index}].components[{component_index}].id"),
            120,
        )?;
        if !seen_ids.insert(component_id.clone()) {
            bail!("Duplicate component id in questions[{question_index}]: {component_id}");
        }
        let label = optional_limited_string(
            component_object.get("label"),
            &format!("questions[{question_index}].components[{component_index}].label"),
            200,
        )?;
        let multiple = component_object
            .get("multiple")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        // Optional seed applied when the picker is shown ungated (or when the
        // revealing option carries no component_defaults entry for it).
        let default_selected = validate_default_id_list(
            component_object.get("default_selected"),
            &format!(
                "questions[{question_index}].components[{component_index}].default_selected"
            ),
            false,
        )?;
        normalized.push(json!({
            "type": component_type,
            "id": component_id,
            "label": label,
            "multiple": multiple,
            "default_selected": default_selected,
        }));
    }
    Ok(normalized)
}

fn validate_questions_argument(arguments: &Map<String, Value>) -> Result<Vec<Value>> {
    let questions = arguments
        .get("questions")
        .and_then(Value::as_array)
        .context("questions must be an array")?;

    if questions.is_empty() || questions.len() > USER_QUESTION_MAX_COUNT {
        bail!("questions must contain between 1 and {USER_QUESTION_MAX_COUNT} items");
    }

    let mut seen_question_ids = HashSet::new();
    let mut normalized = Vec::with_capacity(questions.len());
    for (question_index, question) in questions.iter().enumerate() {
        let question_object = question
            .as_object()
            .with_context(|| format!("questions[{question_index}] must be an object"))?;

        let question_id = required_limited_string(
            question_object
                .get("id")
                .with_context(|| format!("questions[{question_index}].id is required"))?,
            &format!("questions[{question_index}].id"),
            120,
        )?;
        if !seen_question_ids.insert(question_id.clone()) {
            bail!("Duplicate question id: {question_id}");
        }

        let header = required_limited_string(
            question_object
                .get("header")
                .with_context(|| format!("questions[{question_index}].header is required"))?,
            &format!("questions[{question_index}].header"),
            80,
        )?;
        let prompt = required_limited_string(
            question_object
                .get("question")
                .with_context(|| format!("questions[{question_index}].question is required"))?,
            &format!("questions[{question_index}].question"),
            1000,
        )?;

        // A question is driven by plain options OR by curated components (real
        // capability pickers the app renders). At least one is required; options
        // become optional when components are present.
        let components = match question_object.get("components").and_then(Value::as_array) {
            Some(components) => validate_question_components(question_index, components)?,
            None => Vec::new(),
        };
        // Options may seed the components (component_defaults keys are checked
        // against declared component ids), so components validate first.
        let component_ids: HashSet<String> = components
            .iter()
            .filter_map(|component| {
                component
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .collect();
        let options = match question_object.get("options").and_then(Value::as_array) {
            Some(options) => validate_question_options(question_index, options, &component_ids)?,
            None => {
                if components.is_empty() {
                    bail!(
                        "questions[{question_index}] must provide either options (2-{USER_QUESTION_MAX_OPTION_COUNT}) or components"
                    );
                }
                Vec::new()
            }
        };

        // Optional gate: the components stay hidden until the user selects this
        // caller-supplied option. Only validates against caller options — the
        // reserved fallback is appended later by Electron and can never gate.
        let components_gated_by_option_id = optional_limited_string(
            question_object.get("components_gated_by_option_id"),
            &format!("questions[{question_index}].components_gated_by_option_id"),
            120,
        )?;
        if let Some(gate_id) = components_gated_by_option_id.as_deref() {
            if components.is_empty() {
                bail!(
                    "questions[{question_index}].components_gated_by_option_id requires components"
                );
            }
            if options.is_empty() {
                bail!(
                    "questions[{question_index}].components_gated_by_option_id requires options"
                );
            }
            if !options
                .iter()
                .any(|option| option.get("id").and_then(Value::as_str) == Some(gate_id))
            {
                bail!(
                    "questions[{question_index}].components_gated_by_option_id \"{gate_id}\" does not match any option id"
                );
            }
        }

        let freeform_placeholder = optional_limited_string(
            question_object.get("freeform_placeholder"),
            &format!("questions[{question_index}].freeform_placeholder"),
            200,
        )?
        .unwrap_or_else(|| "Add any extra context for this answer (optional).".to_string());

        normalized.push(json!({
            "id": question_id,
            "header": header,
            "question": prompt,
            "freeform_placeholder": freeform_placeholder,
            "options": options,
            "components": components,
            "components_gated_by_option_id": components_gated_by_option_id,
        }));
    }

    Ok(normalized)
}

fn validate_timeout_seconds(arguments: &Map<String, Value>) -> Result<u64> {
    let Some(value) = arguments.get("timeout_seconds") else {
        return Ok(USER_QUESTION_DEFAULT_TIMEOUT_SECONDS);
    };

    let timeout_seconds = value
        .as_u64()
        .context("timeout_seconds must be a positive integer")?;
    if timeout_seconds < USER_QUESTION_MIN_TIMEOUT_SECONDS
        || timeout_seconds > USER_QUESTION_MAX_TIMEOUT_SECONDS
    {
        bail!(
            "timeout_seconds must be between {USER_QUESTION_MIN_TIMEOUT_SECONDS} and {USER_QUESTION_MAX_TIMEOUT_SECONDS}"
        );
    }
    Ok(timeout_seconds)
}

fn validate_chat_id(arguments: &Map<String, Value>) -> Result<String> {
    required_limited_string(
        arguments.get("chat_id").context("chat_id is required")?,
        "chat_id",
        120,
    )
}

pub(super) async fn handle_ask_user_question(arguments: &Map<String, Value>) -> Result<Value> {
    let chat_id = validate_chat_id(arguments)?;
    let questions = validate_questions_argument(arguments)?;
    let timeout_seconds = validate_timeout_seconds(arguments)?;

    let trigger_payload = match electron_questions_post(
        "/api/trigger-user-question-flow",
        &json!({
            "chat_id": chat_id,
            "questions": questions,
            "timeout_seconds": timeout_seconds,
        }),
        USER_QUESTION_TRIGGER_TIMEOUT_SECONDS,
    )
    .await
    {
        Ok(response) => normalize_user_question_response("start the user-question flow", response),
        Err(error) => {
            return success_text(user_question_transport_failure(
                "start the user-question flow",
                &error,
            ))
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
        .context("Electron API did not return flow_id for ask_user_question")?;

    poll_user_question_flow_status(flow_id, timeout_seconds).await
}

/// Best-effort: tells the Electron API to dismiss the question modal, clear
/// the waiting bar, and unlock the composer when this tool call ends without
/// a user response. Failures are ignored — the flow-level timeout in Electron
/// remains the backstop.
async fn cancel_user_question_flow(flow_id: &str, reason: &str) {
    let _ = electron_questions_post(
        "/api/cancel-user-question-flow",
        &json!({ "flow_id": flow_id, "reason": reason }),
        USER_QUESTION_STATUS_TIMEOUT_SECONDS,
    )
    .await;
}

async fn poll_user_question_flow_status(flow_id: &str, timeout_seconds: u64) -> Result<Value> {
    let max_wait = Duration::from_secs(timeout_seconds.saturating_add(30));
    let start = std::time::Instant::now();

    while start.elapsed() <= max_wait {
        let status_payload = match electron_questions_get(
            &format!("/api/user-question-flow-status/{flow_id}"),
            USER_QUESTION_STATUS_TIMEOUT_SECONDS,
        )
        .await
        {
            Ok(response) => {
                normalize_user_question_response("poll the user-question flow", response)
            }
            Err(error) => {
                cancel_user_question_flow(flow_id, "poll_error").await;
                return success_text(user_question_transport_failure(
                    "poll the user-question flow",
                    &error,
                ))
            }
        };

        if !status_payload
            .get("success")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            cancel_user_question_flow(flow_id, "status_error").await;
            return success_text(status_payload);
        }

        match status_payload.get("status").and_then(Value::as_str) {
            Some("completed") => {
                return success_text(
                    status_payload
                        .get("result")
                        .cloned()
                        .unwrap_or_else(|| {
                            json!({
                                "success": false,
                                "status": "error",
                                "error": "Electron API returned a completed user-question flow without a result",
                            })
                        }),
                );
            }
            Some("in_progress") => {
                sleep(Duration::from_millis(USER_QUESTION_POLL_INTERVAL_MILLIS)).await;
            }
            other => {
                let other = other.unwrap_or("missing").to_string();
                cancel_user_question_flow(flow_id, "unexpected_status").await;
                return success_text(json!({
                    "success": false,
                    "status": "error",
                    "flow_id": flow_id,
                    "error": format!(
                        "Unexpected user-question flow status from Electron API: {other}"
                    ),
                }));
            }
        }
    }

    cancel_user_question_flow(flow_id, "tool_timeout").await;
    success_text(json!({
        "success": false,
        "status": "timeout",
        "flow_id": flow_id,
        "error": "Timed out waiting for the user-question flow to complete",
    }))
}
