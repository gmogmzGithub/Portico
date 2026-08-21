use super::*;
use chrono::DateTime;

// Cross-chat messaging tools: list the user's chats and deliver a prompt into
// another chat via the Open WebUI queued-prompts pipeline. Delivery is
// fire-and-forget — the queued item dispatches through the existing
// pending-chat-work drain, so a busy target chat picks it up when its current
// turn finishes; no polling happens here.

const DEFAULT_LIST_CHATS_DAYS: i64 = 7;
const MAX_LIST_CHATS_DAYS: i64 = 365;
// The Open WebUI list route pages at a fixed 60 rows; ten pages bounds the
// sweep at 600 chats so a huge history cannot turn one tool call into an
// unbounded request storm.
const LIST_CHATS_PAGE_SIZE: usize = 60;
const MAX_LIST_CHATS_PAGES: usize = 10;
// Fixed admin service principal minted by the auth bridge
// (portico_auth_bridge.py SERVICE_USER_ID). This server's token belongs to it,
// so an injected owner id equal to it means "a subagent chat is calling" and
// the human owner must be resolved instead.
const OPENWEBUI_SERVICE_USER_ID: &str = "portico-service";

pub(crate) async fn handle_list_chats(arguments: &Map<String, Value>) -> Result<Value> {
    let days = int_arg(arguments, "days", DEFAULT_LIST_CHATS_DAYS).clamp(1, MAX_LIST_CHATS_DAYS);
    let now_epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before the unix epoch")?
        .as_secs() as i64;
    let cutoff = now_epoch - days * 86_400;

    let token = get_openwebui_token().await?;
    let owner_user_id = resolve_listing_owner_user_id(arguments, &token).await?;
    let encoded_owner = utf8_percent_encode(&owner_user_id, NON_ALPHANUMERIC).to_string();

    let mut rows: Vec<Value> = Vec::new();
    let mut truncated = false;
    for page in 1..=MAX_LIST_CHATS_PAGES {
        let path = format!(
            "/api/v1/chats/list/user/{encoded_owner}?page={page}&order_by=created_at&direction=desc"
        );
        let value = openwebui_get_json_retry(&path, &token).await?;
        let page_rows = value
            .as_array()
            .cloned()
            .with_context(|| format!("chat list response for page {page} is not an array"))?;
        let page_len = page_rows.len();
        // Rows arrive newest-created first, so the first stale row ends the
        // whole sweep, not just the page.
        let mut reached_cutoff = false;
        for row in page_rows {
            let created_at = row.get("created_at").and_then(Value::as_i64).unwrap_or(0);
            if created_at < cutoff {
                reached_cutoff = true;
                break;
            }
            rows.push(row);
        }
        if reached_cutoff || page_len < LIST_CHATS_PAGE_SIZE {
            break;
        }
        if page == MAX_LIST_CHATS_PAGES {
            truncated = true;
        }
    }

    // Enrichment is best-effort: a models outage should degrade driver names
    // to ids, not hide the chat list.
    let model_index = match openwebui_get_json_retry("/api/models?", &token).await {
        Ok(models_json) => match extract_models(&models_json) {
            Ok(models) => build_model_display_index(&models),
            Err(error) => {
                warn!("list_chats got an unexpected models response shape: {error:#}");
                HashMap::new()
            }
        },
        Err(error) => {
            warn!("list_chats could not fetch models for driver enrichment: {error:#}");
            HashMap::new()
        }
    };

    let chats: Vec<Value> = rows
        .iter()
        .map(|row| chat_listing(row, &model_index))
        .collect();

    success_text(json!({
        "chats": chats,
        "days": days,
        "count": chats.len(),
        "truncated": truncated,
    }))
}

pub(crate) async fn handle_send_message_to_chat(arguments: &Map<String, Value>) -> Result<Value> {
    let target_chat_id = string_arg(arguments, "target_chat_id")?.trim().to_string();
    if target_chat_id.is_empty() {
        bail!("target_chat_id is required");
    }
    let message = string_arg(arguments, "message")?.trim().to_string();
    if message.is_empty() {
        return success_text(json!({
            "success": false,
            "code": "empty_message",
            "error": "message must be non-empty",
            "remediation": "Provide the text to deliver to the target chat.",
        }));
    }

    let source_chat_id = trimmed_string_arg(arguments, "source_chat_id");
    let source_model_name = trimmed_string_arg(arguments, "source_model_name");
    let source_is_agent = bool_arg(arguments, "source_is_agent", false);

    if source_chat_id.as_deref() == Some(target_chat_id.as_str()) {
        return success_text(json!({
            "success": false,
            "code": "self_send",
            "error": "target_chat_id must differ from the current chat",
            "remediation": "Use subagents_list_chats to pick another chat id.",
        }));
    }

    let prefix = cross_chat_prefix(
        source_chat_id.as_deref(),
        trimmed_string_arg(arguments, "source_display_name").as_deref(),
        source_model_name.as_deref(),
        trimmed_string_arg(arguments, "source_model_id").as_deref(),
        source_is_agent,
    );
    let prompt = format!("{prefix}\n\n{message}");
    let item_id = Uuid::new_v4().to_string();

    let token = get_openwebui_token().await?;
    let payload = json!({
        "id": item_id,
        "prompt": prompt,
        "files": [],
        // Left empty on purpose: the queued-prompts service branch fills
        // selected_model_ids from the TARGET chat, so the reply always comes
        // from the model driving that chat, never the sender's.
        "request_context": {},
    });
    let path = format!("/api/v1/chats/{target_chat_id}/queued-prompts");
    let state = match openwebui_post_json_retry(&path, &token, &payload, 30.0).await {
        Ok(state) => state,
        Err(error) if error_is_not_found(&error) => {
            return success_text(json!({
                "success": false,
                "code": "target_chat_not_found",
                "error": format!("Target chat '{target_chat_id}' was not found"),
                "target_chat_id": target_chat_id,
                "remediation": "Use subagents_list_chats and choose an existing chat id.",
            }));
        }
        Err(error) => return Err(error),
    };

    let queued_prompts = state
        .get("queued_prompts")
        .and_then(Value::as_array)
        .map(|items| items.len())
        .unwrap_or(0);
    success_text(json!({
        "success": true,
        "status": "queued",
        "target_chat_id": target_chat_id,
        "item_id": item_id,
        "queued_prompts": queued_prompts,
        "note": "Fire-and-forget delivery: the target chat dispatches this prompt as soon as it is idle, and the reply stays in that chat.",
    }))
}

pub(crate) async fn handle_get_chat_status(arguments: &Map<String, Value>) -> Result<Value> {
    let chat_id = string_arg(arguments, "chat_id")?.trim().to_string();
    if chat_id.is_empty() {
        bail!("chat_id is required");
    }

    let token = get_openwebui_token().await?;
    let path = format!("/api/v1/chats/{chat_id}/status");
    let status = match openwebui_get_json_retry(&path, &token).await {
        Ok(status) => status,
        Err(error) if error_is_not_found(&error) => {
            return success_text(json!({
                "success": false,
                "code": "chat_not_found",
                "error": format!("Chat '{chat_id}' was not found"),
                "chat_id": chat_id,
                "remediation": "Use subagents_list_chats and choose an existing chat id.",
            }));
        }
        Err(error) => return Err(error),
    };

    let busy = status.get("busy").and_then(Value::as_bool).unwrap_or(false);
    success_text(json!({
        "success": true,
        "chat_id": chat_id,
        "busy": busy,
        "state": if busy { "busy" } else { "idle" },
        "active_turn": status.get("active_turn").and_then(Value::as_bool).unwrap_or(false),
        "task_count": status.get("task_count").and_then(Value::as_i64).unwrap_or(0),
        "queued_prompt_count": status.get("queued_prompt_count").and_then(Value::as_i64).unwrap_or(0),
        "has_pending_steer": status.get("has_pending_steer").and_then(Value::as_bool).unwrap_or(false),
        "title": status.get("title").cloned().unwrap_or(Value::Null),
        "model_id": status.get("model_id").cloned().unwrap_or(Value::Null),
        "updated_at": status.get("updated_at").cloned().unwrap_or(Value::Null),
        "note": if busy {
            "The chat is mid-turn. Do NOT wait or poll for it — its reply arrives automatically as a new prompt in your chat; end your turn."
        } else {
            "The chat is idle. If you expected a reply that never arrived, it is safe to send ONE follow-up via subagents_send_message_to_chat."
        },
    }))
}

pub(crate) async fn handle_start_chat(arguments: &Map<String, Value>) -> Result<Value> {
    reject_legacy_tool_ids_argument(arguments)?;
    let prompt = string_arg(arguments, "prompt")?.trim().to_string();
    if prompt.is_empty() {
        return success_text(json!({
            "success": false,
            "code": "empty_prompt",
            "error": "prompt must be non-empty",
            "remediation": "Provide the message that should start the new chat.",
        }));
    }
    // Started chats file under the same sidebar folder as delegated subagent
    // chats by default; an explicit folder_name still overrides.
    let folder_name = Some(
        trimmed_string_arg(arguments, "folder_name")
            .unwrap_or_else(|| DEFAULT_SUBAGENT_FOLDER_NAME.to_string()),
    );

    let display_name = match trimmed_string_arg(arguments, "display_name") {
        Some(name) if is_valid_pane_display_name(&name) => name,
        provided => {
            return success_text(json!({
                "success": false,
                "code": "invalid_display_name",
                "error": match provided {
                    Some(name) => format!("display_name '{name}' is not a valid pane label"),
                    None => "display_name is required".to_string(),
                },
                "remediation": "Provide a single word of 1-24 letters, digits, hyphens, or underscores (e.g. 'Reviewer'). 'Orchestrator' is reserved for the root chat.",
            }));
        }
    };

    let request = RunSubagentRequest {
        model: trimmed_string_arg(arguments, "model"),
        prompt: prompt.clone(),
        system_prompt: None,
        image_urls: subagent_image_urls_arg(arguments)?,
        tool_server_ids: array_strings(arguments.get("tool_server_ids")),
        skill_ids: array_strings(arguments.get("skill_ids")),
        include_core_tools: bool_arg(arguments, "include_core_tools", true),
        reasoning_effort: trimmed_string_arg(arguments, "reasoning_effort"),
        parent_tool_call_id: None,
        parent_chat_id: None,
        folder_name: None,
        metadata: None,
    };
    // Preparation errors (unknown/disabled model, invalid reasoning effort,
    // too many images) propagate as tool errors — the same surface
    // subagents_run_subagent presents for the same inputs.
    let prepared = prepare_subagent_request_without_folder(request).await?;

    let source_chat_id = trimmed_string_arg(arguments, "source_chat_id");
    let share_workspace = bool_arg(arguments, "share_workspace", true);
    let prefix = cross_chat_prefix(
        source_chat_id.as_deref(),
        trimmed_string_arg(arguments, "source_display_name").as_deref(),
        trimmed_string_arg(arguments, "source_model_name").as_deref(),
        trimmed_string_arg(arguments, "source_model_id").as_deref(),
        bool_arg(arguments, "source_is_agent", false),
    );
    let delivered_prompt = format!("{prefix}\n\n{prompt}");

    let (chat_id, owner_user_id) = match create_human_owned_chat(
        &prepared,
        folder_name.as_deref(),
        source_chat_id.as_deref(),
        &display_name,
    )
    .await?
    {
        HumanChatCreation::Created {
            chat_id,
            owner_user_id,
        } => (chat_id, owner_user_id),
        HumanChatCreation::Rejected { code, message } => {
            let remediation = match code.as_str() {
                "child_chat_cannot_start_chats" => {
                    "Only the orchestrator (root) chat starts new chats. Reply to your peer with subagents_send_message_to_chat instead."
                }
                "multi_chat_tiles_full" => {
                    "The tile grid is full. Coordinate with the already-started chats via subagents_send_message_to_chat."
                }
                "invalid_display_name" => {
                    "Provide a single word of 1-24 letters, digits, hyphens, or underscores that is not 'Orchestrator'."
                }
                _ => "Verify the source chat still exists, then retry.",
            };
            return success_text(json!({
                "success": false,
                "code": code,
                "error": message,
                "remediation": remediation,
            }));
        }
    };

    // Workspace sharing is best-effort: the chat already exists, so a link
    // failure downgrades to an independent workspace instead of failing the
    // whole call.
    let mut linked_workspace = None;
    if share_workspace {
        if let Some(source_chat_id) = source_chat_id.as_deref() {
            match persist_linked_chat_workspace(&chat_id, source_chat_id) {
                Ok(linked) => linked_workspace = Some(linked),
                Err(error) => {
                    warn!("start_chat could not link the new chat's workspace: {error:#}");
                }
            }
        }
    }

    if let Err(error) = seed_and_queue_first_prompt(&prepared, &chat_id, &delivered_prompt).await {
        return success_text(json!({
            "success": false,
            "code": "first_prompt_failed",
            "chat_id": chat_id,
            "error": format!("{error:#}"),
            "remediation": "The chat was created but the first message did not queue. Retry with subagents_send_message_to_chat using this chat_id.",
        }));
    }

    success_text(json!({
        "success": true,
        "status": "started",
        "chat_id": chat_id,
        "owner_user_id": owner_user_id,
        "display_name": display_name,
        "model": prepared.model,
        "reasoning_effort": prepared.effective_reasoning_effort,
        "folder_name": folder_name,
        "activated_skill_ids": prepared.activatable_skill_ids,
        "workspace_shared": linked_workspace.is_some(),
        "workspace_root_chat_id": linked_workspace
            .as_ref()
            .map(|linked| Value::String(linked.root_parent_chat_id.clone()))
            .unwrap_or(Value::Null),
        "workspace_host_path": linked_workspace
            .as_ref()
            .map(|linked| Value::String(linked.host_path.to_string_lossy().to_string()))
            .unwrap_or(Value::Null),
        "note": "Fire-and-forget: the new chat is in the user's sidebar; the reply and generated title land there. Use subagents_send_message_to_chat to follow up.",
    }))
}

enum HumanChatCreation {
    Created {
        chat_id: String,
        owner_user_id: String,
    },
    /// The backend refused the creation with a structured policy code
    /// (multi-chat tiling rules) — a tool-error, not a transport failure.
    Rejected {
        code: String,
        message: String,
    },
}

async fn create_human_owned_chat(
    prepared: &PreparedSubagentRequest,
    folder_name: Option<&str>,
    source_chat_id: Option<&str>,
    display_name: &str,
) -> Result<HumanChatCreation> {
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before the unix epoch")?
        .as_millis() as i64;
    let params = match prepared.effective_reasoning_effort.as_deref() {
        Some(effort) => json!({ "reasoning_effort": effort }),
        None => json!({}),
    };
    let mut payload = json!({
        "chat": {
            "id": "",
            "title": "New Chat",
            "models": [prepared.model],
            "params": params,
            "history": { "messages": {}, "currentId": Value::Null },
            "messages": [],
            "tags": [],
            "timestamp": timestamp_ms,
        },
        "service_owner": "primary-human",
        "service_pane_display_name": display_name,
    });
    if let Some(folder_name) = folder_name {
        payload["service_folder_name"] = json!(folder_name);
    }
    if let Some(source_chat_id) = source_chat_id {
        payload["service_started_by_chat_id"] = json!(source_chat_id);
    }
    let (status, value) =
        openwebui_post_json_status_retry("/api/v1/chats/new", &prepared.token, &payload, 30.0)
            .await?;
    if !(200..300).contains(&status) {
        if let Some(code) = value.pointer("/detail/code").and_then(Value::as_str) {
            let message = value
                .pointer("/detail/message")
                .and_then(Value::as_str)
                .unwrap_or("The backend rejected the chat creation.")
                .to_string();
            return Ok(HumanChatCreation::Rejected {
                code: code.to_string(),
                message,
            });
        }
        let body_text: String = value.to_string().chars().take(400).collect();
        bail!("POST /api/v1/chats/new returned {status}: {body_text}");
    }
    let chat_id = value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .context("chat creation response did not include an id")?
        .to_string();
    let owner_user_id = value
        .get("user_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    Ok(HumanChatCreation::Created {
        chat_id,
        owner_user_id,
    })
}

async fn seed_and_queue_first_prompt(
    prepared: &PreparedSubagentRequest,
    chat_id: &str,
    delivered_prompt: &str,
) -> Result<Value> {
    // Redis first: if the queue POST fails, a retry via
    // subagents_send_message_to_chat still inherits the chat's tools/skills.
    seed_subagent_chat_capability_keys(chat_id, prepared)?;

    let files: Vec<Value> = prepared
        .request
        .image_urls
        .iter()
        .map(|url| json!({ "type": "image", "url": url }))
        .collect();
    let mut selected_model_items = Map::new();
    selected_model_items.insert(prepared.model.clone(), prepared.model_item.clone());
    let mut request_context = json!({
        "selected_model_ids": [prepared.model],
        "selected_model_items": selected_model_items,
        // Explicit: a fresh chat has no replayed tool history, so the
        // dispatch-time Redis backfill never fires for the first turn.
        "tool_ids": prepared.merged_tool_ids,
        "background_tasks": {
            "title_generation": true,
            "tags_generation": true,
            "follow_up_generation": true,
        },
    });
    if let Some(effort) = prepared.effective_reasoning_effort.as_deref() {
        // Keyed by stringified model index, mirroring the frontend contract.
        request_context["reasoning_effort_by_model"] = json!({ "0": effort });
    }
    let payload = json!({
        "id": Uuid::new_v4().to_string(),
        "prompt": delivered_prompt,
        "files": files,
        "request_context": request_context,
    });
    let path = format!("/api/v1/chats/{chat_id}/queued-prompts");
    openwebui_post_json_retry(&path, &prepared.token, &payload, 30.0).await
}

async fn resolve_listing_owner_user_id(
    arguments: &Map<String, Value>,
    token: &str,
) -> Result<String> {
    if let Some(owner_user_id) = trimmed_string_arg(arguments, "owner_user_id") {
        if owner_user_id != OPENWEBUI_SERVICE_USER_ID {
            return Ok(owner_user_id);
        }
    }

    let value = openwebui_get_json_retry("/api/v1/users/", token).await?;
    let users: Vec<&Value> = value
        .get("users")
        .and_then(Value::as_array)
        .map(|items| items.iter().collect())
        .or_else(|| value.as_array().map(|items| items.iter().collect()))
        .context("users response is neither {users: []} nor []")?;
    let mut humans: Vec<(String, i64)> = users
        .iter()
        .filter_map(|user| {
            let id = user.get("id").and_then(Value::as_str)?.trim();
            if id.is_empty() || id == OPENWEBUI_SERVICE_USER_ID {
                return None;
            }
            let last_active = user
                .get("last_active_at")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            Some((id.to_string(), last_active))
        })
        .collect();
    humans.sort_by_key(|(_, last_active)| std::cmp::Reverse(*last_active));
    humans
        .into_iter()
        .map(|(id, _)| id)
        .next()
        .context("no human user found to list chats for")
}

fn build_model_display_index(models: &[&Value]) -> HashMap<String, (String, bool)> {
    models
        .iter()
        .filter_map(|model| {
            let id = model_id(model)?;
            Some((
                id.to_string(),
                (
                    model_display_name(model).to_string(),
                    has_base_model_id(model),
                ),
            ))
        })
        .collect()
}

fn chat_listing(row: &Value, model_index: &HashMap<String, (String, bool)>) -> Value {
    let chat_model_id = row
        .get("model_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let (driver_name, driver_kind) = match model_index.get(chat_model_id) {
        Some((name, true)) => (Value::String(name.clone()), "agent"),
        Some((name, false)) => (Value::String(name.clone()), "model"),
        None if !chat_model_id.is_empty() => (Value::String(chat_model_id.to_string()), "unknown"),
        None => (Value::Null, "unknown"),
    };
    let created_at = row.get("created_at").and_then(Value::as_i64).unwrap_or(0);
    let updated_at = row.get("updated_at").and_then(Value::as_i64).unwrap_or(0);
    json!({
        "id": row.get("id").cloned().unwrap_or(Value::Null),
        "title": row.get("title").cloned().unwrap_or(Value::Null),
        "driver": {
            "id": if chat_model_id.is_empty() { Value::Null } else { Value::String(chat_model_id.to_string()) },
            "name": driver_name,
            "kind": driver_kind,
        },
        "created_at": created_at,
        "created_at_iso": epoch_to_iso(created_at),
        "updated_at": updated_at,
        "updated_at_iso": epoch_to_iso(updated_at),
    })
}

pub(crate) const ORCHESTRATOR_DISPLAY_NAME: &str = "Orchestrator";

/// Percent-escape the characters that would break the `[[xchat:a|b|c|d|e]]`
/// token grammar (`%` first so unescaping round-trips).
fn escape_xchat_field(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '%' => out.push_str("%25"),
            '|' => out.push_str("%7C"),
            '[' => out.push_str("%5B"),
            ']' => out.push_str("%5D"),
            _ => out.push(ch),
        }
    }
    out
}

/// One-word pane badge label: 1-24 ASCII letters/digits/hyphens/underscores,
/// and never the reserved root name. Mirrors the backend's authoritative
/// check so obviously-bad values fail fast without a round trip.
fn is_valid_pane_display_name(name: &str) -> bool {
    let length = name.chars().count();
    (1..=24).contains(&length)
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
        && !name.eq_ignore_ascii_case(ORCHESTRATOR_DISPLAY_NAME)
}

/// Provenance prefix for cross-chat prompts. The `[[xchat:...]]` token keeps
/// every field machine-readable (the frontend renders it as a badge row) while
/// the surrounding literal keeps the prompt self-describing for the model AND
/// preserves the "message from another chat" workflows-skill trigger.
fn cross_chat_prefix(
    source_chat_id: Option<&str>,
    source_display_name: Option<&str>,
    source_model_name: Option<&str>,
    source_model_id: Option<&str>,
    source_is_agent: bool,
) -> String {
    let Some(chat_id) = source_chat_id else {
        return "[Message from another chat]".to_string();
    };
    let display_name = source_display_name
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(ORCHESTRATOR_DISPLAY_NAME);
    let kind = if source_is_agent { "agent" } else { "model" };
    format!(
        "[Message from another chat: [[xchat:{}|{}|{}|{}|{}]]]",
        escape_xchat_field(chat_id),
        escape_xchat_field(display_name),
        escape_xchat_field(source_model_name.unwrap_or("")),
        escape_xchat_field(source_model_id.unwrap_or("")),
        kind
    )
}

fn epoch_to_iso(epoch_seconds: i64) -> Value {
    DateTime::from_timestamp(epoch_seconds, 0)
        .map(|value| Value::String(value.to_rfc3339()))
        .unwrap_or(Value::Null)
}

fn trimmed_string_arg(arguments: &Map<String, Value>, key: &str) -> Option<String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn error_is_not_found(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .to_string()
            .to_ascii_lowercase()
            .contains("404 not found")
    })
}
