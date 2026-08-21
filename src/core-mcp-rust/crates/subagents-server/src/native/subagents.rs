use super::*;
use std::cmp::Ordering;
use std::sync::{Mutex, OnceLock};

const POLL_INTERVAL_SECONDS: u64 = 5;
const SUBAGENT_RUN_TIMEOUT_SECONDS: u64 = 7_200;
const SUBAGENT_TOOL_CALL_TTL_SECONDS: u64 = 86_400;
const SUBAGENT_EXPLICIT_SKILLS_KEY_PREFIX: &str = "subagent_explicit_skills:";
const OWUI_AUTH_BRIDGE_SECRET_ENV: &str = "OWUI_AUTH_BRIDGE_SECRET";
const OWUI_AUTH_BRIDGE_SECRET_FILE_ENV: &str = "OWUI_AUTH_BRIDGE_SECRET_FILE";
const TRANSIENT_SUBAGENT_COMPLETION_MAX_ATTEMPTS: u32 = 3;
const TRANSIENT_SUBAGENT_COMPLETION_RETRY_DELAY_MS: u64 = 750;
const LIST_AGENTS_MODELS_RETRY_ATTEMPTS: u32 = 3;
const LIST_AGENTS_MODELS_RETRY_DELAY_MS: u64 = 350;
const SUBAGENT_TOOL_SERVER_IDS_META_KEY: &str = "subagent_tool_server_ids";
const SUBAGENT_SKILL_IDS_META_KEY: &str = "subagent_skill_ids";
const SUBAGENT_REASONING_EFFORT_META_KEY: &str = "subagent_reasoning_effort";
const SUBAGENT_CREATED_BY_EMAIL_META_KEY: &str = "subagent_created_by_email";
const SUBAGENT_CREATION_SOURCE_META_KEY: &str = "subagent_creation_source";
const SUBAGENT_MARKETPLACE_RELATIONSHIP_META_KEY: &str = "subagent_marketplace_relationship";
const SUBAGENT_MARKETPLACE_SOLUTION_ID_META_KEY: &str = "subagent_marketplace_solution_id";
const SUBAGENT_FOLDER_LOCK_TTL_SECONDS: u64 = 45;
const SUBAGENT_FOLDER_LOCK_WAIT_SECONDS: f64 = 35.0;
const SUBAGENT_FOLDER_LOCK_POLL_INTERVAL_MILLIS: u64 = 100;
const LEGACY_TOOL_IDS_META_KEY: &str = "toolIds";
const DEFAULT_REASONING_EFFORT: &str = "medium";
const REASONING_EFFORT_OPTIONS: [&str; 4] = ["low", "medium", "high", "max"];
const MAX_SUBAGENT_IMAGE_URLS: usize = 20;
const LM_STUDIO_CONFIG_FILE_NAME: &str = "lm-studio.json";
const LM_STUDIO_DEFAULT_PORT: u16 = 1234;
const LM_STUDIO_DISABLED_REASON: &str =
    "LM Studio is not running. Start LM Studio and enable the local server.";
const LM_STUDIO_PROVIDER_ID: &str = "lm_studio";
const LM_STUDIO_LOCAL_PREFIX: &str = "local/";
const LM_STUDIO_TAG_NAME: &str = "Local Models";
const LM_STUDIO_DEFAULT_CONTEXT_TOKENS: i64 = 131_072;
const CHAT_WORKSPACES_SETTINGS_FILE: &str = "chat-workspaces.json";
pub const DEFAULT_SUBAGENT_FOLDER_NAME: &str = "Sub-agents";

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct LmStudioConfig {
    pub enabled: Option<bool>,
    pub port: Option<u16>,
    pub host_base_url: Option<String>,
    pub docker_base_url: Option<String>,
    pub api_key: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct LmStudioResolvedConfig {
    port: u16,
    host_base_url: String,
    docker_base_url: String,
    api_key: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct LmStudioDiscoveredModel {
    id: String,
    loaded_context_tokens: Option<i64>,
    max_context_tokens: Option<i64>,
}

impl LmStudioDiscoveredModel {
    fn context_tokens(&self) -> Option<i64> {
        self.loaded_context_tokens.or(self.max_context_tokens)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunSubagentRequest {
    pub model: Option<String>,
    pub prompt: String,
    /// Optional hidden system instruction sent to the model but not saved as
    /// the visible child-chat user message.
    pub system_prompt: Option<String>,
    pub image_urls: Vec<String>,
    pub tool_server_ids: Vec<String>,
    pub skill_ids: Vec<String>,
    pub include_core_tools: bool,
    pub reasoning_effort: Option<String>,
    pub parent_tool_call_id: Option<String>,
    pub parent_chat_id: Option<String>,
    pub folder_name: Option<String>,
    /// Extra opaque metadata to attach to the OWUI chat under
    /// ``chat.meta``. Used by the scheduling daemon to stamp
    /// ``run_origin: "scheduled"`` + ``task_id`` / ``run_id`` /
    /// ``approved_scope`` so the confirmation gate can recognise a
    /// scheduled-run sub-agent chat and bypass chips for in-scope
    /// tools (Phase 1 of the chip rework). Trusted callers only —
    /// the model cannot influence this.
    pub metadata: Option<Value>,
}

impl Default for RunSubagentRequest {
    fn default() -> Self {
        Self {
            model: None,
            prompt: String::new(),
            system_prompt: None,
            image_urls: Vec::new(),
            tool_server_ids: Vec::new(),
            skill_ids: Vec::new(),
            include_core_tools: true,
            reasoning_effort: None,
            parent_tool_call_id: None,
            parent_chat_id: None,
            folder_name: None,
            metadata: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct WorkspaceInheritance {
    parent_chat_id: String,
    root_parent_chat_id: String,
    root_workspace_host_path: PathBuf,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RunSubagentResult {
    pub model: String,
    pub response: String,
    pub response_char_count: usize,
    pub response_truncated: bool,
    pub chat_id: String,
    pub session_id: String,
    pub task_id: String,
    pub tool_call_count: i64,
    pub usage_tokens: i64,
    pub context_tokens: i64,
    pub max_context_tokens: i64,
    pub success: bool,
    pub error: Option<Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct SavedSubagentDefaults {
    tool_server_ids: Vec<String>,
    skill_ids: Vec<String>,
    reasoning_effort: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ReasoningCapabilities {
    supports_reasoning: bool,
    allowed_values: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ModelPickerMetadata {
    provider: String,
    tier: String,
}

#[path = "subagents_chat.rs"]
mod subagents_chat;

#[path = "subagents_cross_chat.rs"]
mod subagents_cross_chat;

pub(crate) use subagents_cross_chat::{
    handle_get_chat_status, handle_list_chats, handle_send_message_to_chat, handle_start_chat,
};

use subagents_chat::{
    align_messages, display_content_for_chat, extract_error_message,
    extract_parent_facing_response, extract_tool_call_count_from_chat, extract_usage_from_chat,
    generate_variables, is_context_window_error, message_is_complete, save_chat_state,
};

fn max_context_tokens_for_model(model: &str) -> i64 {
    let normalized = model.to_ascii_lowercase();
    if normalized.contains("gpt-5.6") || normalized.contains("gpt 5.6") {
        1_050_000
    } else if normalized.contains("sonnet 5")
        || normalized.contains("sonnet 4.6")
        || normalized.contains("opus 5")
        || normalized.contains("opus-5")
        || normalized.contains("opus 4.8")
        || normalized.contains("opus 4.7")
        || normalized.contains("opus 4.6")
    {
        1_000_000
    } else {
        200_000
    }
}

fn normalize_context_tokens_for_window(context_tokens: i64, max_context_tokens: i64) -> i64 {
    let bounded = context_tokens.max(0);
    if max_context_tokens > 0 {
        bounded.min(max_context_tokens)
    } else {
        bounded
    }
}

fn full_subagent_response(content: &str) -> (String, usize, bool) {
    let normalized = content.trim().to_string();
    let total_chars = normalized.chars().count();
    (normalized, total_chars, false)
}

fn parent_facing_response_from_chat_data(chat_data: &Value) -> String {
    let history_messages = chat_data
        .get("chat")
        .and_then(|value| value.get("history"))
        .and_then(|value| value.get("messages"))
        .and_then(Value::as_object);
    if let Some(history_messages) = history_messages {
        if let Some((_, assistant)) = history_messages
            .iter()
            .find(|(_, message)| message_is_complete(message))
        {
            let response = extract_parent_facing_response(assistant);
            if !response.is_empty() {
                return response;
            }
        }
    }

    let messages = chat_data
        .get("chat")
        .and_then(|value| value.get("messages"))
        .and_then(Value::as_array);
    if let Some(messages) = messages {
        if let Some(assistant) = messages
            .iter()
            .rev()
            .find(|message| message_is_complete(message))
        {
            let response = extract_parent_facing_response(assistant);
            if !response.is_empty() {
                return response;
            }
        }
    }

    String::new()
}

fn is_transient_upstream_model_failure(message: &str) -> bool {
    let normalized = message.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return false;
    }

    normalized.contains("upstream model provider stream failed")
        || normalized.contains("upstream model provider stream timed out")
        || normalized.contains("upstream model provider returned invalid stream data")
        || normalized.contains("upstream model provider returned an invalid stream response")
        || normalized.contains("unable to reach the upstream model provider")
        || normalized.contains("upstream model provider is temporarily unavailable")
        || normalized.contains("upstream model provider is temporarily rate limited")
}

fn merge_subagent_tool_ids(
    requested_tool_ids: &[String],
    required_tool_ids: &[String],
    include_core_tools: bool,
) -> Vec<String> {
    let core_tool_ids = [
        "server:mcp-assistant".to_string(),
        "server:subagents".to_string(),
        "server:skills".to_string(),
        "server:agent-vm".to_string(),
    ];
    let mut merged = Vec::new();

    for tool_id in requested_tool_ids {
        if !merged.contains(tool_id) {
            merged.push(tool_id.clone());
        }
    }

    let core_iter = if include_core_tools {
        core_tool_ids.as_slice()
    } else {
        &[]
    };
    for tool_id in core_iter.iter().chain(required_tool_ids.iter()) {
        if !merged.contains(tool_id) {
            merged.push(tool_id.clone());
        }
    }

    merged
}

pub(super) async fn handle_list_agents(arguments: &Map<String, Value>) -> Result<Value> {
    let filter_type = arguments
        .get("filter_type")
        .and_then(Value::as_str)
        .unwrap_or("derived");
    let token = get_openwebui_token().await?;
    let models_json = fetch_models_for_agent_listing(&token)
        .await
        .context("Open WebUI models request failed")?;

    let tools_map = match openwebui_get_json_retry("/api/v1/tools/", &token).await {
        Ok(tools_json) => build_tools_map(&tools_json)?,
        Err(error) => {
            warn!("failed to fetch Open WebUI tools for list_agents: {error}");
            HashMap::new()
        }
    };
    let models = extract_models(&models_json)?;

    let mut filtered = models
        .into_iter()
        .filter(|model| match filter_type {
            "base" => !has_base_model_id(model),
            "derived" => has_base_model_id(model),
            _ => true,
        })
        .map(|model| filter_agent_data(model, &tools_map))
        .collect::<Result<Vec<_>>>()?;

    // Lifecycle enrichment from the agent-link sidecar (base models have no
    // links, so a base-only listing skips the fetch entirely).
    if filter_type != "base" {
        let link_state = agent_link_state_map().await;
        for agent in filtered.iter_mut() {
            enrich_agent_with_link_state(agent, link_state.as_ref());
        }
    }

    success_text(Value::Array(filtered))
}

async fn fetch_models_for_agent_listing(token: &str) -> Result<Value> {
    let mut last_error = None;

    for attempt in 0..LIST_AGENTS_MODELS_RETRY_ATTEMPTS {
        match openwebui_get_json_retry("/api/models", token).await {
            Ok(value) => return Ok(value),
            Err(error) => {
                if attempt + 1 >= LIST_AGENTS_MODELS_RETRY_ATTEMPTS {
                    last_error = Some(error);
                    break;
                }
                warn!(
                    attempt = attempt + 1,
                    error = %error,
                    "Open WebUI models listing failed; retrying agent catalog load"
                );
                last_error = Some(error);
                tokio::time::sleep(Duration::from_millis(
                    LIST_AGENTS_MODELS_RETRY_DELAY_MS * u64::from(attempt + 1),
                ))
                .await;
            }
        }
    }

    if let Some(error) = last_error {
        Err(error)
    } else {
        bail!("Open WebUI models listing was not attempted")
    }
}

fn build_tools_map(tools_json: &Value) -> Result<HashMap<String, Value>> {
    let tools = tools_json
        .as_array()
        .context("tools response is not an array")?;
    let mut result = HashMap::new();
    for tool in tools {
        let Some(tool_id) = tool.get("id").and_then(Value::as_str) else {
            continue;
        };

        let description = load_mcp_server_description(tool_id);
        let mut entry = json!({
            "id": tool_id,
            "name": tool.get("name").cloned().unwrap_or(Value::Null),
        });
        if let Some(description) = description {
            if let Some(object) = entry.as_object_mut() {
                object.insert("description".to_string(), Value::String(description));
            }
        }
        result.insert(tool_id.to_string(), entry);
    }
    Ok(result)
}

fn load_mcp_server_description(tool_id: &str) -> Option<String> {
    let server_id = tool_id.strip_prefix("server:").unwrap_or(tool_id);
    let candidates = [
        mcp_configs_dir()
            .ok()?
            .join(server_id)
            .join(format!("{server_id}.yaml")),
        mcp_configs_user_dir()
            .ok()?
            .join(server_id)
            .join(format!("{server_id}.yaml")),
    ];

    for yaml_path in candidates {
        if !yaml_path.exists() {
            continue;
        }
        let yaml = match yaml_map(&yaml_path) {
            Ok(yaml) => yaml,
            Err(_) => continue,
        };

        let description = yaml_string(&yaml, "description").unwrap_or_default();
        let use_cases = yaml_array_strings(&yaml, "use_cases");
        if description.is_empty() && use_cases.is_empty() {
            return None;
        }
        if use_cases.is_empty() {
            return Some(description);
        }
        if description.is_empty() {
            return Some(use_cases.join(", "));
        }
        return Some(format!("{description}. {}", use_cases.join(", ")));
    }

    None
}

fn extract_models(models_json: &Value) -> Result<Vec<&Value>> {
    if let Some(data) = models_json.get("data").and_then(Value::as_array) {
        return Ok(data.iter().collect());
    }
    models_json
        .as_array()
        .map(|items| items.iter().collect())
        .context("models response is neither {data: []} nor []")
}

fn has_base_model_id(model: &Value) -> bool {
    model
        .get("info")
        .and_then(|value| value.get("base_model_id"))
        .or_else(|| model.get("base_model_id"))
        .and_then(Value::as_str)
        .map(|value| !value.is_empty())
        .unwrap_or(false)
}

fn model_id(model: &Value) -> Option<&str> {
    model.get("id").and_then(Value::as_str)
}

fn model_display_name(model: &Value) -> &str {
    model
        .get("name")
        .and_then(Value::as_str)
        .or_else(|| model_id(model))
        .unwrap_or("model")
}

fn model_base_model_id(model: &Value) -> Option<&str> {
    model
        .get("info")
        .and_then(|value| value.get("base_model_id"))
        .or_else(|| model.get("base_model_id"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
}

fn model_meta_value<'a>(model: &'a Value, key: &str) -> Option<&'a Value> {
    model
        .get("meta")
        .and_then(|value| value.get(key))
        .or_else(|| {
            model
                .get("info")
                .and_then(|value| value.get("meta"))
                .and_then(|value| value.get(key))
        })
}

fn merge_unique_strings(sources: &[&[String]]) -> Vec<String> {
    let mut merged = Vec::new();
    for source in sources {
        for value in *source {
            if !merged.contains(value) {
                merged.push(value.clone());
            }
        }
    }
    merged
}

fn model_meta_array_strings(model: &Value, key: &str) -> Vec<String> {
    model_meta_value(model, key)
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn subagent_tool_server_ids_from_model(model: &Value) -> Vec<String> {
    let stored = model_meta_array_strings(model, SUBAGENT_TOOL_SERVER_IDS_META_KEY);
    if !stored.is_empty() {
        return stored;
    }
    model_meta_array_strings(model, LEGACY_TOOL_IDS_META_KEY)
}

fn subagent_skill_ids_from_model(model: &Value) -> Vec<String> {
    model_meta_array_strings(model, SUBAGENT_SKILL_IDS_META_KEY)
}

fn subagent_reasoning_effort_from_model(model: &Value) -> Option<String> {
    model_meta_value(model, SUBAGENT_REASONING_EFFORT_META_KEY)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn subagent_defaults_from_model(model: &Value) -> SavedSubagentDefaults {
    SavedSubagentDefaults {
        tool_server_ids: subagent_tool_server_ids_from_model(model),
        skill_ids: subagent_skill_ids_from_model(model),
        reasoning_effort: subagent_reasoning_effort_from_model(model),
    }
}

fn model_lookup_names(model: &Value) -> Vec<String> {
    let mut names = Vec::new();
    for candidate in [
        model
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        model_id(model).map(str::to_string),
    ]
    .into_iter()
    .flatten()
    {
        if !names.contains(&candidate) {
            names.push(candidate);
        }
    }
    names
}

fn resolve_reasoning_model_name(model: &Value, models: &[Value]) -> Result<String> {
    let (base_model, resolved_base_model_id) = resolve_base_model_for_reasoning(model, models)?;
    let lookup_names = model_lookup_names(base_model);
    for candidate in &lookup_names {
        if model_catalog_reasoning_capabilities(candidate)?.is_some() {
            return Ok(candidate.clone());
        }
    }
    Ok(lookup_names
        .into_iter()
        .find(|value| !value.trim().is_empty())
        .unwrap_or(resolved_base_model_id))
}

fn resolve_base_model_for_reasoning<'a>(
    model: &'a Value,
    models: &'a [Value],
) -> Result<(&'a Value, String)> {
    if let Some(base_model_id) = model_base_model_id(model) {
        let base_model = find_model_by_id(models, base_model_id).with_context(|| {
            format!(
                "Base model '{}' not found in available models",
                base_model_id
            )
        })?;
        return Ok((base_model, base_model_id.to_string()));
    }

    let model_name = model_id(model)
        .or_else(|| model.get("name").and_then(Value::as_str))
        .unwrap_or("model")
        .to_string();
    Ok((model, model_name))
}

fn model_catalog_model_list() -> Result<Vec<serde_yaml::Value>> {
    let config_path = app_root()?.join("model_catalog.yaml");
    if !config_path.exists() {
        return Ok(Vec::new());
    }

    let raw = fs::read_to_string(&config_path)
        .with_context(|| format!("failed to read {}", config_path.display()))?;
    let parsed: serde_yaml::Value = serde_yaml::from_str(&raw)
        .with_context(|| format!("failed to parse {}", config_path.display()))?;
    Ok(parsed
        .get("model_list")
        .and_then(serde_yaml::Value::as_sequence)
        .cloned()
        .unwrap_or_default())
}

fn model_catalog_entry_matches(entry: &serde_yaml::Value, model_name: &str) -> bool {
    let Some(entry_name) = entry
        .get("model_name")
        .and_then(serde_yaml::Value::as_str)
        .map(str::trim)
    else {
        return false;
    };
    let normalized_targets = [
        model_name.trim().to_string(),
        model_name.trim().trim_end_matches(":latest").to_string(),
    ];
    normalized_targets
        .iter()
        .filter(|value| !value.is_empty())
        .any(|target| {
            target.eq_ignore_ascii_case(entry_name)
                || format!("{target}:latest").eq_ignore_ascii_case(entry_name)
        })
}

fn model_catalog_reasoning_capabilities(model_name: &str) -> Result<Option<ReasoningCapabilities>> {
    for entry in model_catalog_model_list()? {
        if !model_catalog_entry_matches(&entry, model_name) {
            continue;
        }

        let model_info = entry
            .get("model_info")
            .and_then(serde_yaml::Value::as_mapping);
        let supports_reasoning = model_info
            .and_then(|info| info.get(serde_yaml::Value::String("supports_reasoning".to_string())))
            .and_then(serde_yaml::Value::as_bool)
            .unwrap_or(false);
        let mut allowed_values = model_info
            .and_then(|info| {
                info.get(serde_yaml::Value::String(
                    "reasoning_effort_options".to_string(),
                ))
            })
            .and_then(serde_yaml::Value::as_sequence)
            .map(|values| {
                values
                    .iter()
                    .filter_map(serde_yaml::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if supports_reasoning && allowed_values.is_empty() {
            allowed_values = REASONING_EFFORT_OPTIONS
                .iter()
                .map(|value| value.to_string())
                .collect();
        }
        return Ok(Some(ReasoningCapabilities {
            supports_reasoning,
            allowed_values,
        }));
    }

    Ok(None)
}

fn model_catalog_picker_metadata(model_name: &str) -> Result<Option<ModelPickerMetadata>> {
    for entry in model_catalog_model_list()? {
        if !model_catalog_entry_matches(&entry, model_name) {
            continue;
        }
        let Some(picker) = entry.get("picker").and_then(serde_yaml::Value::as_mapping) else {
            return Ok(None);
        };
        let provider = picker
            .get(serde_yaml::Value::String("provider".to_string()))
            .and_then(serde_yaml::Value::as_str)
            .map(str::trim)
            .filter(|value| matches!(*value, "anthropic" | "openai" | "google"))
            .with_context(|| format!("Model '{model_name}' has invalid picker.provider"))?;
        let tier = picker
            .get(serde_yaml::Value::String("tier".to_string()))
            .and_then(serde_yaml::Value::as_str)
            .map(str::trim)
            .filter(|value| matches!(*value, "general" | "heavy" | "premium" | "lightweight"))
            .with_context(|| format!("Model '{model_name}' has invalid picker.tier"))?;
        return Ok(Some(ModelPickerMetadata {
            provider: provider.to_string(),
            tier: tier.to_string(),
        }));
    }
    Ok(None)
}

fn picker_metadata_for_model(model: &Value) -> Result<Option<ModelPickerMetadata>> {
    for candidate in model_lookup_names(model) {
        if let Some(metadata) = model_catalog_picker_metadata(&candidate)? {
            return Ok(Some(metadata));
        }
    }
    Ok(None)
}

fn reasoning_capabilities_for_model(model: &Value) -> Result<Option<ReasoningCapabilities>> {
    for candidate in model_lookup_names(model) {
        if let Some(capabilities) = model_catalog_reasoning_capabilities(&candidate)? {
            return Ok(Some(capabilities));
        }
    }
    Ok(None)
}

fn validate_reasoning_effort_for_base_model(
    base_model_name: &str,
    requested_effort: Option<&str>,
) -> Result<Option<String>> {
    let capabilities = model_catalog_reasoning_capabilities(base_model_name)?;
    let requested_effort = requested_effort
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let Some(capabilities) = capabilities else {
        if let Some(requested_effort) = requested_effort {
            bail!(
                "Could not determine reasoning capabilities for model '{}'. Remove reasoning_effort='{}' or select a model present in model_catalog.yaml.",
                base_model_name,
                requested_effort
            );
        }
        return Ok(None);
    };

    if !capabilities.supports_reasoning {
        if let Some(requested_effort) = requested_effort {
            bail!(
                "Model '{}' does not support reasoning_effort. Remove reasoning_effort='{}' or choose a reasoning-capable model.",
                base_model_name,
                requested_effort
            );
        }
        return Ok(None);
    }

    if let Some(requested_effort) = requested_effort {
        if !capabilities
            .allowed_values
            .iter()
            .any(|value| value == requested_effort)
        {
            bail!(
                "Requested reasoning_effort '{}' is not available for model '{}'. Allowed values: {}.",
                requested_effort,
                base_model_name,
                capabilities.allowed_values.join(", ")
            );
        }
        return Ok(Some(requested_effort.to_string()));
    }

    Ok(Some(DEFAULT_REASONING_EFFORT.to_string()))
}

fn validate_reasoning_effort_for_model(
    model: &Value,
    models: &[Value],
    requested_effort: Option<&str>,
) -> Result<Option<String>> {
    let model_name = resolve_reasoning_model_name(model, models)?;
    validate_reasoning_effort_for_base_model(&model_name, requested_effort)
}

fn resolve_saved_reasoning_effort_for_base_model(
    base_model_name: &str,
    saved_effort: Option<&str>,
) -> Result<Option<String>> {
    let saved_effort = saved_effort
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(saved_effort) = saved_effort else {
        return Ok(None);
    };

    let Some(capabilities) = model_catalog_reasoning_capabilities(base_model_name)? else {
        return Ok(Some(saved_effort.to_string()));
    };

    if !capabilities.supports_reasoning {
        return Ok(None);
    }

    if capabilities
        .allowed_values
        .iter()
        .any(|value| value == saved_effort)
    {
        return Ok(Some(saved_effort.to_string()));
    }

    bail!(
        "Saved reasoning_effort '{}' is not available for model '{}'. Allowed values: {}.",
        saved_effort,
        base_model_name,
        capabilities.allowed_values.join(", ")
    );
}

fn resolve_saved_reasoning_effort_for_model(
    model: &Value,
    models: &[Value],
    saved_effort: Option<&str>,
) -> Result<Option<String>> {
    let model_name = resolve_reasoning_model_name(model, models)?;
    resolve_saved_reasoning_effort_for_base_model(&model_name, saved_effort)
}

fn resolve_runtime_reasoning_effort(
    model: &Value,
    models: &[Value],
    requested_effort: Option<&str>,
    saved_effort: Option<&str>,
) -> Result<Option<String>> {
    if requested_effort.is_some() {
        return validate_reasoning_effort_for_model(model, models, requested_effort);
    }

    if let Some(saved_effort) = saved_effort {
        let model_name = resolve_reasoning_model_name(model, models)?;
        return resolve_saved_reasoning_effort_for_base_model(&model_name, Some(saved_effort));
    }

    validate_reasoning_effort_for_model(model, models, None)
}

fn reject_legacy_tool_ids_argument(arguments: &Map<String, Value>) -> Result<()> {
    if arguments.get("tool_ids").is_some() {
        bail!(
            "The Subagents MCP tools no longer accept 'tool_ids'. Use 'tool_server_ids' instead."
        );
    }
    Ok(())
}

fn model_disabled_reason(model: &Value) -> Option<String> {
    model_meta_value(model, "disabled_reason")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
        .map(ToOwned::to_owned)
}

fn is_model_directly_disabled(model: &Value) -> bool {
    model_meta_value(model, "disabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || model_disabled_reason(model).is_some()
}

fn find_model_by_id<'a>(models: &'a [Value], requested_model_id: &str) -> Option<&'a Value> {
    models.iter().find(|item| {
        model_id(item)
            .map(|item_id| {
                item_id == requested_model_id || item_id == format!("{requested_model_id}:latest")
            })
            .unwrap_or(false)
    })
}

fn resolve_model_disabled_reason(
    model: &Value,
    models: &[Value],
    visited_model_ids: &mut Vec<String>,
) -> Option<String> {
    if is_model_directly_disabled(model) {
        return Some(
            model_disabled_reason(model).unwrap_or_else(|| "Temporarily unavailable".to_string()),
        );
    }

    let Some(base_model_id) = model_base_model_id(model) else {
        return None;
    };

    let current_model_id = model_id(model).unwrap_or_default().to_string();
    if visited_model_ids
        .iter()
        .any(|visited| visited == base_model_id)
        || (!current_model_id.is_empty()
            && visited_model_ids
                .iter()
                .any(|visited| visited == &current_model_id))
    {
        return None;
    }

    if !current_model_id.is_empty() {
        visited_model_ids.push(current_model_id);
    }
    visited_model_ids.push(base_model_id.to_string());

    find_model_by_id(models, base_model_id)
        .and_then(|base_model| resolve_model_disabled_reason(base_model, models, visited_model_ids))
}

fn validate_model_is_enabled(model: &Value, models: &[Value]) -> Result<()> {
    if let Some(reason) = resolve_model_disabled_reason(model, models, &mut Vec::new()) {
        let model_name = model_id(model).unwrap_or_else(|| model_display_name(model));
        bail!("Model '{}' is disabled: {}", model_name, reason);
    }
    Ok(())
}

fn resolve_subagent_model(models: &[Value], requested_model: Option<&str>) -> Result<String> {
    if let Some(requested_model) = requested_model {
        let model = find_model_by_id(models, requested_model).with_context(|| {
            format!("Model '{}' not found in available models", requested_model)
        })?;
        validate_model_is_enabled(model, models)?;
        return Ok(requested_model.to_string());
    }

    models
        .iter()
        .find(|model| {
            model.get("is_default").and_then(Value::as_bool) == Some(true)
                && validate_model_is_enabled(model, models).is_ok()
        })
        .or_else(|| {
            models
                .iter()
                .find(|model| validate_model_is_enabled(model, models).is_ok())
        })
        .and_then(|model| model_id(model))
        .map(str::to_string)
        .context("No model specified and no default model available")
}

async fn fetch_validated_base_model(base_model_id: &str) -> Result<(Vec<Value>, Value)> {
    let models = fetch_all_models().await?;
    let model = find_model_by_id(&models, base_model_id)
        .with_context(|| {
            format!(
                "Base model '{}' not found in available models",
                base_model_id
            )
        })?
        .clone();
    if has_base_model_id(&model) {
        bail!("Model '{}' is not a base model", base_model_id);
    }
    if let Some(reason) = resolve_model_disabled_reason(&model, &models, &mut Vec::new()) {
        bail!("Base model '{}' is disabled: {}", base_model_id, reason);
    }
    Ok((models, model))
}

fn filter_agent_data(model: &Value, tools_map: &HashMap<String, Value>) -> Result<Value> {
    let base_model_id = model
        .get("info")
        .and_then(|value| value.get("base_model_id"))
        .or_else(|| model.get("base_model_id"))
        .cloned()
        .unwrap_or(Value::Null);

    let tool_server_ids = subagent_tool_server_ids_from_model(model);
    let skill_ids = subagent_skill_ids_from_model(model);
    let reasoning_effort = subagent_reasoning_effort_from_model(model);
    let is_base_model = !has_base_model_id(model);
    let is_local = is_base_model && is_lm_studio_model(model);
    let picker_metadata = if is_base_model && !is_local {
        picker_metadata_for_model(model)?
    } else {
        None
    };
    let picker_provider = if is_local {
        Value::String("local".to_string())
    } else {
        picker_metadata
            .as_ref()
            .map(|metadata| Value::String(metadata.provider.clone()))
            .unwrap_or(Value::Null)
    };
    let picker_tier = picker_metadata
        .as_ref()
        .map(|metadata| Value::String(metadata.tier.clone()))
        .unwrap_or(Value::Null);
    let hidden = model_meta_value(model, "hidden")
        .or_else(|| model.get("hidden"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || (is_base_model && !is_local && picker_metadata.is_none());
    let reasoning_capabilities = if is_base_model {
        reasoning_capabilities_for_model(model)?
    } else {
        None
    };
    let supports_reasoning = reasoning_capabilities
        .as_ref()
        .map(|capabilities| Value::Bool(capabilities.supports_reasoning))
        .unwrap_or(Value::Null);
    let reasoning_effort_options = reasoning_capabilities
        .as_ref()
        .map(|capabilities| json!(capabilities.allowed_values))
        .unwrap_or(Value::Null);

    let tools = tool_server_ids
        .iter()
        .filter_map(|tool_id| tools_map.get(tool_id).cloned())
        .collect::<Vec<_>>();

    Ok(json!({
        "id": model.get("id").cloned().unwrap_or(Value::Null),
        "name": model.get("name").cloned().unwrap_or(Value::Null),
        "base_model_id": base_model_id,
        "description": model_meta_value(model, "description").cloned().unwrap_or(Value::Null),
        "disabled": is_model_directly_disabled(model),
        "disabled_reason": model_disabled_reason(model),
        "picker_provider": picker_provider,
        "picker_tier": picker_tier,
        "is_local": is_local,
        "hidden": hidden,
        "tool_server_ids": tool_server_ids,
        "skill_ids": skill_ids,
        "reasoning_effort": reasoning_effort,
        "supports_reasoning": supports_reasoning,
        "reasoning_effort_options": reasoning_effort_options,
        "tools": tools,
        "is_active": model.get("is_active").cloned().unwrap_or(Value::Bool(true)),
        "created_by_email": model_meta_value(model, SUBAGENT_CREATED_BY_EMAIL_META_KEY)
            .cloned()
            .unwrap_or(Value::Null),
        "creation_source": agent_creation_source(model),
        "marketplace_relationship": agent_marketplace_relationship(model),
        "marketplace_solution_id": agent_marketplace_solution_id(model),
        "is_read_only": agent_is_read_only(model),
    }))
}

async fn get_openwebui_token() -> Result<String> {
    if let Some(token) = get_cached_openwebui_token() {
        return Ok(token);
    }

    if let Ok(token) = env::var("OPENWEBUI_API_TOKEN") {
        let trimmed = token.trim();
        if !trimmed.is_empty() {
            set_cached_openwebui_token(trimmed.to_string());
            return Ok(trimmed.to_string());
        }
    }

    let token = redis_get_string(OPENWEBUI_TOKEN_KEY)?
        .filter(|token| !token.trim().is_empty())
        .context("Open WebUI API token not available in Redis")?;
    set_cached_openwebui_token(token.clone());
    Ok(token)
}

fn openwebui_token_cache() -> &'static Mutex<Option<String>> {
    static CACHE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn get_cached_openwebui_token() -> Option<String> {
    openwebui_token_cache()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone()
}

fn set_cached_openwebui_token(token: String) {
    *openwebui_token_cache()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner()) = Some(token);
}

#[cfg(test)]
fn clear_cached_openwebui_token() {
    *openwebui_token_cache()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner()) = None;
}

fn read_owui_auth_bridge_secret() -> Result<String> {
    if let Ok(file_path) = env::var(OWUI_AUTH_BRIDGE_SECRET_FILE_ENV) {
        let trimmed_path = file_path.trim();
        if !trimmed_path.is_empty() {
            let value = fs::read_to_string(trimmed_path)
                .with_context(|| format!("failed to read {OWUI_AUTH_BRIDGE_SECRET_FILE_ENV}"))?
                .trim()
                .to_string();
            if !value.is_empty() {
                return Ok(value);
            }
        }
    }

    let value = env::var(OWUI_AUTH_BRIDGE_SECRET_ENV)
        .unwrap_or_default()
        .trim()
        .to_string();
    if value.is_empty() {
        #[cfg(test)]
        {
            return Ok("bridge-test-secret".to_string());
        }
        #[cfg(not(test))]
        {
            bail!(
                "{OWUI_AUTH_BRIDGE_SECRET_ENV} or {OWUI_AUTH_BRIDGE_SECRET_FILE_ENV} is required"
            );
        }
    }
    Ok(value)
}

async fn refresh_openwebui_service_token() -> Result<String> {
    let bridge_secret = read_owui_auth_bridge_secret()?;
    let payload = json!({
        "reason": "subagents-refresh",
    });
    let value = openwebui_post_json(
        "/api/v1/portico/auth/service-token",
        &bridge_secret,
        &payload,
        30.0,
    )
    .await?;
    let token = value
        .get("token")
        .and_then(Value::as_str)
        .or_else(|| value.get("access_token").and_then(Value::as_str))
        .filter(|token| !token.trim().is_empty())
        .context("Open WebUI service-token bridge succeeded but no token was returned")?
        .to_string();
    redis_set_string(OPENWEBUI_TOKEN_KEY, &token)?;
    let _ = redis_delete(OPENWEBUI_USER_KEY);
    set_cached_openwebui_token(token.clone());
    Ok(token)
}

fn is_openwebui_auth_error(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        let text = cause.to_string().to_ascii_lowercase();
        text.contains("401")
            || text.contains("403")
            || text.contains("unauthorized")
            || text.contains("forbidden")
    })
}

async fn openwebui_get_json_retry(path: &str, token: &str) -> Result<Value> {
    match openwebui_get_json(path, token).await {
        Ok(value) => Ok(value),
        Err(error) if is_openwebui_auth_error(&error) => {
            warn!("Open WebUI GET auth failed for {path}; refreshing service token");
            let fresh_token = refresh_openwebui_service_token().await?;
            openwebui_get_json(path, &fresh_token).await
        }
        Err(error) => Err(error),
    }
}

async fn openwebui_post_json_retry(
    path: &str,
    token: &str,
    payload: &Value,
    timeout_seconds: f64,
) -> Result<Value> {
    match openwebui_post_json(path, token, payload, timeout_seconds).await {
        Ok(value) => Ok(value),
        Err(error) if is_openwebui_auth_error(&error) => {
            warn!("Open WebUI POST auth failed for {path}; refreshing service token");
            let fresh_token = refresh_openwebui_service_token().await?;
            openwebui_post_json(path, &fresh_token, payload, timeout_seconds).await
        }
        Err(error) => Err(error),
    }
}

/// Status+body POST with the same one-shot token-refresh retry as
/// `openwebui_post_json_retry`. 4xx responses come back as `Ok((status,
/// body))` so callers can read structured policy codes without retry noise.
async fn openwebui_post_json_status_retry(
    path: &str,
    token: &str,
    payload: &Value,
    timeout_seconds: f64,
) -> Result<(u16, Value)> {
    let (status, body) = openwebui_post_json_status(path, token, payload, timeout_seconds).await?;
    if status == 401 || status == 403 {
        warn!("Open WebUI POST auth failed ({status}) for {path}; refreshing service token");
        let fresh_token = refresh_openwebui_service_token().await?;
        return openwebui_post_json_status(path, &fresh_token, payload, timeout_seconds).await;
    }
    Ok((status, body))
}

async fn openwebui_delete_json_retry(
    path: &str,
    token: &str,
    payload: Option<&Value>,
) -> Result<Value> {
    match openwebui_delete_json(path, token, payload).await {
        Ok(value) => Ok(value),
        Err(error) if is_openwebui_auth_error(&error) => {
            warn!("Open WebUI DELETE auth failed for {path}; refreshing service token");
            let fresh_token = refresh_openwebui_service_token().await?;
            openwebui_delete_json(path, &fresh_token, payload).await
        }
        Err(error) => Err(error),
    }
}

// --- Open WebUI writer-lease guard (model mutations) ------------------------
//
// The Open WebUI fork serializes ALL model mutations behind a single global
// Redis writer lease: POST /api/v1/models/create, /api/v1/models/model/update,
// /api/v1/models/model/delete, and /api/v1/users/user/settings/update must
// NX-acquire the lease, and a holder conflict returns HTTP 409. Two
// cooperating layers keep parallel tool calls from surfacing raw 409s in
// chats:
//   1. an in-process async mutex, so parallel tool calls from THIS server
//      take the lease one at a time instead of racing each other; and
//   2. a bounded backoff retry, to ride out ANOTHER process holding the
//      lease (per-request holders clear in well under a second; a reconcile
//      pass can hold it for minutes, in which case the retries give up and
//      the final error explains the busy state instead of a bare 409).
// Read paths are deliberately NOT guarded — the lease only covers writes.
// Total worst-case added wait is the delay sum (~2.7s); no unbounded loops.
const OPENWEBUI_MODEL_MUTATION_RETRY_DELAYS_MS: [u64; 5] = [100, 200, 400, 800, 1200];
const OPENWEBUI_WRITER_BUSY_ERROR: &str = "Open WebUI is busy with another agent mutation (model reconciliation in progress). Retry in a moment.";

fn openwebui_model_mutation_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// True when the error chain carries the Open WebUI global writer-lease
/// conflict. `error_for_status()` discards the 409 response body, so the
/// status line rendered by reqwest ("HTTP status client error (409 Conflict)
/// for url (…)") is the only reliable signal. Matching the "409 Conflict"
/// pair (rather than a bare "409") keeps ids or byte counts containing "409"
/// from reading as lease conflicts.
fn is_openwebui_writer_lease_conflict(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .to_string()
            .to_ascii_lowercase()
            .contains("409 conflict")
    })
}

async fn openwebui_model_mutation_request<F, Fut>(path: &str, send: F) -> Result<Value>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<Value>>,
{
    // (1) In-process serialization. Deliberately held across the backoff
    // below: queued sibling calls must not pile onto a lease that another
    // process is holding. Non-conflict errors return immediately, so the
    // lock is only held for long when OWUI itself is busy.
    let _guard = openwebui_model_mutation_lock().lock().await;
    let mut delays = OPENWEBUI_MODEL_MUTATION_RETRY_DELAYS_MS.iter().copied();
    loop {
        match send().await {
            Ok(value) => return Ok(value),
            Err(error) if is_openwebui_writer_lease_conflict(&error) => match delays.next() {
                Some(delay_ms) => {
                    warn!("Open WebUI writer lease busy for {path}; retrying in {delay_ms}ms");
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                }
                None => {
                    warn!("Open WebUI writer lease stayed busy for {path}; giving up: {error:#}");
                    return Err(error.context(OPENWEBUI_WRITER_BUSY_ERROR));
                }
            },
            Err(error) => return Err(error),
        }
    }
}

/// Every POST this crate makes to a writer-lease-guarded Open WebUI
/// model-mutation path goes through here. Composes with
/// [`openwebui_post_json_retry`], so the existing auth-refresh retry is
/// preserved inside each lease attempt.
async fn openwebui_model_mutation_post(
    path: &str,
    token: &str,
    payload: &Value,
    timeout_seconds: f64,
) -> Result<Value> {
    openwebui_model_mutation_request(path, || {
        openwebui_post_json_retry(path, token, payload, timeout_seconds)
    })
    .await
}

/// DELETE-verb counterpart of [`openwebui_model_mutation_post`].
async fn openwebui_model_mutation_delete(
    path: &str,
    token: &str,
    payload: Option<&Value>,
) -> Result<Value> {
    openwebui_model_mutation_request(path, || openwebui_delete_json_retry(path, token, payload))
        .await
}

async fn get_openwebui_user_id() -> Result<String> {
    if let Some(user_id) = redis_get_string(OPENWEBUI_USER_KEY)? {
        if !user_id.trim().is_empty() {
            return Ok(user_id);
        }
    }
    let token = get_openwebui_token().await?;
    let value = openwebui_get_json_retry("/api/v1/auths/", &token).await?;
    let user_id = value
        .get("id")
        .and_then(Value::as_str)
        .context("user ID not found in auth response")?
        .to_string();
    let _ = redis_setex_string(OPENWEBUI_USER_KEY, &user_id, 3600);
    Ok(user_id)
}

async fn fetch_all_models() -> Result<Vec<Value>> {
    let token = get_openwebui_token().await?;
    let value = openwebui_get_json_retry("/api/models?", &token).await?;
    Ok(value
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

async fn fetch_model_by_id(model_id: &str) -> Result<Value> {
    let token = get_openwebui_token().await?;
    let encoded = utf8_percent_encode(model_id, NON_ALPHANUMERIC).to_string();
    let attempts = [
        format!("/api/v1/models/model?id={}", model_id),
        format!("/api/models/{}", encoded),
        format!("/api/v1/models/{}", encoded),
    ];
    for attempt in attempts {
        if let Ok(value) = openwebui_get_json_retry(&attempt, &token).await {
            return Ok(value);
        }
    }
    bail!("Could not fetch model {}", model_id)
}

/// OWUI's model lookup can "succeed" with a null or id-less body for unknown
/// ids — and `is_base_model` reads such a body as a base model. A body with a
/// real id is the only proof the agent exists.
fn model_body_has_real_id(model: &Value) -> bool {
    model
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.trim().is_empty())
}

/// Resolve a model id to a body that provably exists, treating a failed fetch
/// and a null/id-less body as the same domain fact: the agent does not exist
/// locally.
async fn fetch_existing_model_by_id(model_id: &str) -> Option<Value> {
    fetch_model_by_id(model_id)
        .await
        .ok()
        .filter(model_body_has_real_id)
}

/// Shared not-found envelope so get_agent, get_agent_system_prompt,
/// copy_agent, and delete_agent report unknown ids identically.
fn agent_not_found_envelope(model_id: &str) -> Result<Value> {
    success_text(json!({
        "success": false,
        "code": "agent_not_found",
        "error": format!("Agent '{}' was not found locally", model_id),
        "remediation": "Use list_agents and choose an existing agent id.",
    }))
}

fn tool_server_ids_from_agent(agent: &Value) -> Vec<String> {
    subagent_tool_server_ids_from_model(agent)
}

fn is_base_model(agent: &Value) -> bool {
    agent
        .get("info")
        .and_then(|value| value.get("base_model_id"))
        .or_else(|| agent.get("base_model_id"))
        .and_then(Value::as_str)
        .map(|value| value.is_empty())
        .unwrap_or(true)
}

fn is_system_agent(model_id: &str) -> bool {
    model_id.starts_with("portico_agent_")
}

fn agent_creation_source(model: &Value) -> Value {
    let model_id = model.get("id").and_then(Value::as_str).unwrap_or("");
    if is_system_agent(model_id) {
        return Value::String("system".to_string());
    }
    model_meta_value(model, SUBAGENT_CREATION_SOURCE_META_KEY)
        .cloned()
        .unwrap_or(Value::Null)
}

fn agent_marketplace_relationship(model: &Value) -> Value {
    model_meta_value(model, SUBAGENT_MARKETPLACE_RELATIONSHIP_META_KEY)
        .cloned()
        .unwrap_or(Value::Null)
}

fn agent_marketplace_solution_id(model: &Value) -> Value {
    model_meta_value(model, SUBAGENT_MARKETPLACE_SOLUTION_ID_META_KEY)
        .cloned()
        .unwrap_or(Value::Null)
}

fn agent_is_read_only(model: &Value) -> bool {
    let model_id = model.get("id").and_then(Value::as_str).unwrap_or("");
    if is_system_agent(model_id) || is_base_model(model) {
        return true;
    }
    let source_value = agent_creation_source(model);
    let source = source_value
        .as_str()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let relationship_value = agent_marketplace_relationship(model);
    let relationship = relationship_value
        .as_str()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let solution_id_value = agent_marketplace_solution_id(model);
    let linked = solution_id_value
        .as_str()
        .map(str::trim)
        .is_some_and(|value| !value.is_empty());
    source == "marketplace"
        || relationship == "installed"
        || relationship == "unknown"
        || (linked && relationship != "published")
        || (source != "local" && relationship != "published")
}

fn load_agent_icon_data_url() -> String {
    let icon_path = app_root()
        .unwrap_or_else(|_| PathBuf::from("/app"))
        .join("assets")
        .join("agent-icon.png");
    match fs::read(icon_path) {
        Ok(bytes) => format!("data:image/png;base64,{}", BASE64_STANDARD.encode(bytes)),
        Err(_) => "/static/favicon.png".to_string(),
    }
}

async fn list_available_tools_filtered() -> Result<Vec<Value>> {
    let token = get_openwebui_token().await?;
    let tools = openwebui_get_json_retry("/api/v1/tools/", &token).await?;
    Ok(tools
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|tool| {
            let tool_id = tool.get("id").and_then(Value::as_str).unwrap_or_default();
            let mut value = json!({
                "id": tool_id,
                "name": tool.get("name").cloned().unwrap_or(Value::Null),
            });
            if let Some(description) = load_mcp_server_description(tool_id) {
                if let Some(object) = value.as_object_mut() {
                    object.insert("description".to_string(), Value::String(description));
                }
            }
            value
        })
        .collect())
}

async fn tools_map_for_subagents() -> Result<HashMap<String, Value>> {
    Ok(list_available_tools_filtered()
        .await
        .unwrap_or_else(|error| {
            warn!("failed to list tools for subagents agent enrichment: {error}");
            Vec::new()
        })
        .into_iter()
        .filter_map(|tool| {
            tool.get("id")
                .and_then(Value::as_str)
                .map(|id| (id.to_string(), tool.clone()))
        })
        .collect())
}

fn filter_agent_value(
    model: &Value,
    include_system_prompt: bool,
    tools_map: &HashMap<String, Value>,
) -> Value {
    let base_model_id = model
        .get("info")
        .and_then(|value| value.get("base_model_id"))
        .or_else(|| model.get("base_model_id"))
        .cloned()
        .unwrap_or(Value::Null);
    let tool_server_ids = tool_server_ids_from_agent(model);
    let skill_ids = subagent_skill_ids_from_model(model);
    let reasoning_effort = subagent_reasoning_effort_from_model(model);
    let tools = tool_server_ids
        .into_iter()
        .filter_map(|tool_id| tools_map.get(&tool_id).cloned())
        .collect::<Vec<_>>();
    let mut filtered = json!({
        "id": model.get("id").cloned().unwrap_or(Value::Null),
        "name": model.get("name").cloned().unwrap_or(Value::Null),
        "base_model_id": base_model_id,
        "description": model_meta_value(model, "description").cloned().unwrap_or(Value::Null),
        "tool_server_ids": subagent_tool_server_ids_from_model(model),
        "skill_ids": skill_ids,
        "reasoning_effort": reasoning_effort,
        "tools": tools,
        "is_active": model.get("is_active").cloned().unwrap_or(Value::Bool(true)),
        "created_by_email": model_meta_value(model, SUBAGENT_CREATED_BY_EMAIL_META_KEY)
            .cloned()
            .unwrap_or(Value::Null),
        "creation_source": agent_creation_source(model),
        "marketplace_relationship": agent_marketplace_relationship(model),
        "marketplace_solution_id": agent_marketplace_solution_id(model),
        "is_read_only": agent_is_read_only(model),
    });
    filtered
        .as_object_mut()
        .filter(|_| include_system_prompt)
        .map(|object| {
            object.insert(
                "system_prompt".to_string(),
                model
                    .get("params")
                    .and_then(|value| value.get("system"))
                    .cloned()
                    .unwrap_or(Value::String(String::new())),
            )
        });
    filtered
}

pub(super) async fn handle_list_available_tools(_arguments: &Map<String, Value>) -> Result<Value> {
    success_text(Value::Array(list_available_tools_filtered().await?))
}

fn normalize_lm_studio_base_url(value: &str) -> String {
    let trimmed = value.trim().trim_end_matches('/');
    let without_models = trimmed.strip_suffix("/models").unwrap_or(trimmed);
    if without_models.ends_with("/v1") {
        without_models.to_string()
    } else {
        format!("{without_models}/v1")
    }
}

fn resolve_lm_studio_config(config: Option<&LmStudioConfig>) -> LmStudioResolvedConfig {
    let port = config
        .and_then(|value| value.port)
        .unwrap_or(LM_STUDIO_DEFAULT_PORT);
    let host_base_url = config
        .and_then(|value| value.host_base_url.as_deref())
        .map(normalize_lm_studio_base_url)
        .unwrap_or_else(|| format!("http://127.0.0.1:{port}/v1"));
    let docker_base_url = config
        .and_then(|value| value.docker_base_url.as_deref())
        .map(normalize_lm_studio_base_url)
        .unwrap_or_else(|| format!("http://host.docker.internal:{port}/v1"));
    let api_key = config
        .and_then(|value| value.api_key.as_deref())
        .unwrap_or("")
        .to_string();
    LmStudioResolvedConfig {
        port,
        host_base_url,
        docker_base_url,
        api_key,
    }
}

fn lm_studio_config_path() -> Result<PathBuf> {
    Ok(app_support_dir()?.join(LM_STUDIO_CONFIG_FILE_NAME))
}

fn load_lm_studio_config() -> Result<Option<LmStudioConfig>> {
    let path = lm_studio_config_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)
        .with_context(|| format!("failed to read LM Studio config {}", path.display()))?;
    let config = serde_json::from_str::<LmStudioConfig>(&raw)
        .with_context(|| format!("failed to parse LM Studio config {}", path.display()))?;
    if config.enabled == Some(false) {
        return Ok(None);
    }
    Ok(Some(config))
}

fn write_lm_studio_config(config: &LmStudioConfig) -> Result<PathBuf> {
    let path = lm_studio_config_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    fs::write(&path, serde_json::to_vec_pretty(config)?)
        .with_context(|| format!("failed to write LM Studio config {}", path.display()))?;
    Ok(path)
}

async fn probe_lm_studio_models(
    resolved: &LmStudioResolvedConfig,
) -> Result<Vec<LmStudioDiscoveredModel>> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .context("failed to build LM Studio HTTP client")?;
    let native_base_url = lm_studio_native_base_url(&resolved.docker_base_url);
    let native_probe = fetch_lm_studio_native_models(&client, &native_base_url).await;
    match native_probe {
        Ok((models, saw_native_entries)) if saw_native_entries || !models.is_empty() => Ok(models),
        Ok(_) | Err(_) => fetch_lm_studio_openai_models(&client, &resolved.docker_base_url).await,
    }
}

fn lm_studio_native_base_url(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    let without_models = trimmed.strip_suffix("/models").unwrap_or(trimmed);
    let without_v1 = without_models.strip_suffix("/v1").unwrap_or(without_models);
    let without_api_v1 = without_v1.strip_suffix("/api/v1").unwrap_or(without_v1);
    format!("{without_api_v1}/api/v1")
}

async fn fetch_lm_studio_native_models(
    client: &reqwest::Client,
    native_base_url: &str,
) -> Result<(Vec<LmStudioDiscoveredModel>, bool)> {
    let payload = client
        .get(format!("{}/models", native_base_url.trim_end_matches('/')))
        .send()
        .await
        .with_context(|| format!("failed to reach LM Studio at {native_base_url}"))?
        .error_for_status()
        .with_context(|| format!("LM Studio native /api/v1/models failed at {native_base_url}"))?
        .json::<Value>()
        .await
        .context("failed to decode LM Studio native /api/v1/models response")?;
    let entries = lm_studio_model_entries(&payload);
    let saw_native_entries = !entries.is_empty();
    let mut seen = HashSet::new();
    let mut models = Vec::new();
    for model in entries {
        let Some(id) = lm_studio_model_entry_id(model) else {
            continue;
        };
        if is_lm_studio_embedding_model_entry(model) || !lm_studio_native_model_is_loaded(model) {
            continue;
        }
        if seen.insert(id.clone()) {
            models.push(LmStudioDiscoveredModel {
                id,
                loaded_context_tokens: lm_studio_loaded_context_tokens(model),
                max_context_tokens: lm_studio_max_context_tokens(model),
            });
        }
    }
    Ok((models, saw_native_entries))
}

async fn fetch_lm_studio_openai_models(
    client: &reqwest::Client,
    openai_base_url: &str,
) -> Result<Vec<LmStudioDiscoveredModel>> {
    let payload = client
        .get(format!("{}/models", openai_base_url.trim_end_matches('/')))
        .send()
        .await
        .with_context(|| format!("failed to reach LM Studio at {openai_base_url}"))?
        .error_for_status()
        .with_context(|| format!("LM Studio /models failed at {openai_base_url}"))?
        .json::<Value>()
        .await
        .context("failed to decode LM Studio /models response")?;
    let mut seen = HashSet::new();
    let mut models = Vec::new();
    for model in lm_studio_model_entries(&payload) {
        let Some(id) = lm_studio_model_entry_id(model) else {
            continue;
        };
        if !is_lm_studio_embedding_model_entry(model) && seen.insert(id.clone()) {
            models.push(LmStudioDiscoveredModel {
                id,
                loaded_context_tokens: None,
                max_context_tokens: None,
            });
        }
    }
    Ok(models)
}

fn lm_studio_model_entries(payload: &Value) -> Vec<&Value> {
    if let Some(models) = payload.as_array() {
        return models.iter().collect();
    }
    for key in ["data", "models", "items"] {
        if let Some(models) = payload.get(key).and_then(Value::as_array) {
            return models.iter().collect();
        }
    }
    Vec::new()
}

fn lm_studio_model_entry_id(model: &Value) -> Option<String> {
    for key in ["id", "model_key", "key", "name", "path"] {
        let Some(value) = model.get(key).and_then(Value::as_str) else {
            continue;
        };
        let value = value.trim();
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

fn value_i64_at(value: &Value, path: &[&str]) -> Option<i64> {
    let mut current = value;
    for segment in path {
        current = current.get(*segment)?;
    }
    current
        .as_i64()
        .or_else(|| current.as_u64().and_then(|value| i64::try_from(value).ok()))
        .or_else(|| current.as_str()?.trim().parse::<i64>().ok())
        .filter(|value| *value > 0)
}

fn lm_studio_loaded_instances(model: &Value) -> Vec<&Value> {
    for key in ["loaded_instances", "instances"] {
        if let Some(instances) = model.get(key).and_then(Value::as_array) {
            return instances.iter().collect();
        }
    }
    if model.get("loaded").and_then(Value::as_bool) == Some(true)
        || model
            .get("state")
            .and_then(Value::as_str)
            .map(|state| state.eq_ignore_ascii_case("loaded"))
            .unwrap_or(false)
    {
        return vec![model];
    }
    Vec::new()
}

fn lm_studio_native_model_is_loaded(model: &Value) -> bool {
    !lm_studio_loaded_instances(model).is_empty()
}

fn lm_studio_loaded_context_tokens(model: &Value) -> Option<i64> {
    for instance in lm_studio_loaded_instances(model) {
        for path in [
            &["config", "context_length"][..],
            &["config", "contextLength"],
            &["load_config", "context_length"],
            &["context_length"],
        ] {
            if let Some(value) = value_i64_at(instance, path) {
                return Some(value);
            }
        }
    }
    None
}

fn lm_studio_max_context_tokens(model: &Value) -> Option<i64> {
    for path in [
        &["max_context_length"][..],
        &["max_context_tokens"],
        &["context_length"],
        &["metadata", "max_context_length"],
        &["metadata", "max_context_tokens"],
    ] {
        if let Some(value) = value_i64_at(model, path) {
            return Some(value);
        }
    }
    None
}

fn is_lm_studio_embedding_model_entry(model: &Value) -> bool {
    let mut values = Vec::new();
    for path in [
        &["id"][..],
        &["name"],
        &["type"],
        &["object"],
        &["model_type"],
        &["task"],
        &["pipeline_tag"],
        &["capabilities", "type"],
        &["metadata", "type"],
        &["metadata", "model_type"],
    ] {
        if let Some(value) = json_string_at(model, path) {
            values.push(value.to_ascii_lowercase());
        }
    }
    let haystack = values.join(" ");
    haystack.contains("embedding")
        || haystack.contains("text-embedding")
        || haystack.contains("embed")
        || haystack.contains("rerank")
        || haystack.contains("ranker")
}

fn json_string_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut current = value;
    for segment in path {
        current = current.get(*segment)?;
    }
    current.as_str()
}

fn is_lm_studio_model(model: &Value) -> bool {
    let candidates = [
        json_string_at(model, &["meta", "local_provider"]),
        json_string_at(model, &["info", "meta", "local_provider"]),
        json_string_at(model, &["owned_by"]),
        json_string_at(model, &["openai", "owned_by"]),
        json_string_at(model, &["connection_type"]),
        json_string_at(model, &["openai", "connection_type"]),
    ];
    if candidates.iter().flatten().any(|value| {
        let normalized = value.trim().to_ascii_lowercase().replace('-', "_");
        normalized == LM_STUDIO_PROVIDER_ID || normalized == "local"
    }) {
        return true;
    }
    model
        .get("tags")
        .and_then(Value::as_array)
        .map(|tags| {
            tags.iter().any(|tag| {
                tag.get("name")
                    .and_then(Value::as_str)
                    .map(|name| name.eq_ignore_ascii_case(LM_STUDIO_TAG_NAME))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn lm_studio_raw_model_id(model: &Value) -> Option<String> {
    json_string_at(model, &["meta", "local_model_id"])
        .or_else(|| json_string_at(model, &["info", "meta", "local_model_id"]))
        .or_else(|| model.get("id").and_then(Value::as_str))
        .map(str::to_string)
}

fn lm_studio_internal_model_id(raw_id: &str, existing_models: &[Value]) -> String {
    let collides_with_non_local = existing_models.iter().any(|model| {
        model.get("id").and_then(Value::as_str) == Some(raw_id) && !is_lm_studio_model(model)
    });
    if collides_with_non_local {
        format!("{LM_STUDIO_LOCAL_PREFIX}{raw_id}")
    } else {
        raw_id.to_string()
    }
}

fn existing_lm_studio_internal_ids(existing_models: &[Value]) -> Vec<String> {
    existing_models
        .iter()
        .filter(|model| is_lm_studio_model(model))
        .filter_map(|model| model.get("id").and_then(Value::as_str).map(str::to_string))
        .collect()
}

fn existing_model_id_set(existing_models: &[Value]) -> HashSet<String> {
    existing_models
        .iter()
        .filter_map(|model| model.get("id").and_then(Value::as_str).map(str::to_string))
        .collect()
}

fn local_model_capabilities() -> Value {
    json!({
        "vision": false,
        "file_upload": false,
        "web_search": false,
        "image_generation": false,
        "code_interpreter": false,
        "citations": false,
    })
}

fn ensure_json_object_field<'a>(value: &'a mut Value, key: &str) -> &'a mut Map<String, Value> {
    let object = value
        .as_object_mut()
        .expect("LM Studio model payload must be an object");
    let entry = object
        .entry(key.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !entry.is_object() {
        *entry = Value::Object(Map::new());
    }
    entry.as_object_mut().expect("field must be an object")
}

fn update_lm_studio_model_metadata(
    model: &mut Value,
    internal_id: &str,
    raw_id: &str,
    reachable: bool,
    context_tokens: Option<i64>,
    max_context_tokens: Option<i64>,
) {
    let context_tokens = context_tokens.unwrap_or(LM_STUDIO_DEFAULT_CONTEXT_TOKENS);
    let meta = ensure_json_object_field(model, "meta");
    meta.insert("local_provider".to_string(), json!(LM_STUDIO_PROVIDER_ID));
    meta.insert("local_model_id".to_string(), json!(raw_id));
    meta.insert("toolIds".to_string(), json!([]));
    meta.insert("disabled".to_string(), json!(!reachable));
    meta.insert("max_context_tokens".to_string(), json!(context_tokens));
    if let Some(max_context_tokens) = max_context_tokens {
        meta.insert(
            "lm_studio_max_context_tokens".to_string(),
            json!(max_context_tokens),
        );
    }
    meta.insert("capabilities".to_string(), local_model_capabilities());
    meta.insert("tags".to_string(), json!([{ "name": LM_STUDIO_TAG_NAME }]));
    if reachable {
        meta.remove("disabled_reason");
    } else {
        meta.insert(
            "disabled_reason".to_string(),
            json!(LM_STUDIO_DISABLED_REASON),
        );
    }

    let info = ensure_json_object_field(model, "info");
    info.insert("base_model_id".to_string(), Value::Null);
    let info_meta = info
        .entry("meta".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !info_meta.is_object() {
        *info_meta = Value::Object(Map::new());
    }
    if let Some(info_meta) = info_meta.as_object_mut() {
        info_meta.insert("local_provider".to_string(), json!(LM_STUDIO_PROVIDER_ID));
        info_meta.insert("local_model_id".to_string(), json!(raw_id));
        info_meta.insert("disabled".to_string(), json!(!reachable));
        info_meta.insert("max_context_tokens".to_string(), json!(context_tokens));
        if let Some(max_context_tokens) = max_context_tokens {
            info_meta.insert(
                "lm_studio_max_context_tokens".to_string(),
                json!(max_context_tokens),
            );
        }
        if reachable {
            info_meta.remove("disabled_reason");
        } else {
            info_meta.insert(
                "disabled_reason".to_string(),
                json!(LM_STUDIO_DISABLED_REASON),
            );
        }
    }

    if let Some(object) = model.as_object_mut() {
        object.insert("id".to_string(), json!(internal_id));
        object.insert("name".to_string(), json!(raw_id));
        object.insert("base_model_id".to_string(), Value::Null);
        object.insert("owned_by".to_string(), json!("lm-studio"));
        object.insert("connection_type".to_string(), json!("local"));
        object.insert("tags".to_string(), json!([{ "name": LM_STUDIO_TAG_NAME }]));
        object.insert("is_active".to_string(), json!(true));
    }
}

fn build_lm_studio_model_payload(
    internal_id: &str,
    raw_id: &str,
    reachable: bool,
    context_tokens: Option<i64>,
    max_context_tokens: Option<i64>,
) -> Value {
    let context_tokens = context_tokens.unwrap_or(LM_STUDIO_DEFAULT_CONTEXT_TOKENS);
    let mut payload = json!({
        "id": internal_id,
        "base_model_id": Value::Null,
        "name": raw_id,
        "meta": {
            "description": "Local model served by LM Studio.",
            "capabilities": local_model_capabilities(),
            "suggestion_prompts": Value::Null,
            "tags": [{ "name": LM_STUDIO_TAG_NAME }],
            "toolIds": [],
            "disabled": !reachable,
            "local_provider": LM_STUDIO_PROVIDER_ID,
            "local_model_id": raw_id,
            "max_context_tokens": context_tokens,
        },
        "info": {
            "base_model_id": Value::Null,
            "meta": {
                "disabled": !reachable,
                "local_provider": LM_STUDIO_PROVIDER_ID,
                "local_model_id": raw_id,
                "max_context_tokens": context_tokens,
            }
        },
        "params": {},
        "object": "model",
        "created": 1677610602,
        "owned_by": "lm-studio",
        "connection_type": "local",
        "openai": {
            "id": internal_id,
            "object": "model",
            "created": 1677610602,
            "owned_by": "lm-studio",
            "connection_type": "local"
        },
        "tags": [{ "name": LM_STUDIO_TAG_NAME }],
        "access_control": {
            "read": { "group_ids": [], "user_ids": [] },
            "write": { "group_ids": [], "user_ids": [] }
        },
        "is_active": true,
        "is_default": false
    });
    if !reachable {
        payload["meta"]["disabled_reason"] = json!(LM_STUDIO_DISABLED_REASON);
        payload["info"]["meta"]["disabled_reason"] = json!(LM_STUDIO_DISABLED_REASON);
    }
    if let Some(max_context_tokens) = max_context_tokens {
        payload["meta"]["lm_studio_max_context_tokens"] = json!(max_context_tokens);
        payload["info"]["meta"]["lm_studio_max_context_tokens"] = json!(max_context_tokens);
    }
    payload
}

fn sanitize_lm_studio_model_for_update(mut model: Value, user_id: &str) -> Value {
    if let Some(object) = model.as_object_mut() {
        object.insert("user_id".to_string(), json!(user_id));
        object.remove("info");
        object.remove("user");
    }
    model
}

async fn fetch_model_optional_by_id(model_id: &str, token: &str) -> Result<Option<Value>> {
    let encoded = utf8_percent_encode(model_id, NON_ALPHANUMERIC).to_string();
    match openwebui_get_json_retry(&format!("/api/v1/models/model?id={encoded}"), token).await {
        Ok(value) if value.is_null() => Ok(None),
        Ok(value) if value.is_object() => Ok(Some(value)),
        Ok(_) => Ok(None),
        Err(error) => {
            let message = error.to_string();
            if is_missing_model_lookup_error_message(&message) {
                Ok(None)
            } else {
                Err(error)
            }
        }
    }
}

fn is_missing_model_lookup_error_message(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    normalized.contains("404")
        || ((normalized.contains("400") || normalized.contains("422"))
            && (normalized.contains("not found")
                || normalized.contains("missing")
                || normalized.contains("does not exist")
                || normalized.contains("returned error")))
}

async fn upsert_lm_studio_model_wrappers(
    token: &str,
    user_id: &str,
    discovered: &[(String, LmStudioDiscoveredModel)],
    existing_models: &[Value],
    reachable: bool,
) -> Result<(usize, usize)> {
    let mut updated = 0;
    let mut created = 0;
    let existing_ids = existing_model_id_set(existing_models);
    for (internal_id, discovered_model) in discovered {
        let raw_id = discovered_model.id.as_str();
        let existing_model = if existing_ids.contains(internal_id) {
            fetch_model_optional_by_id(internal_id, token).await?
        } else {
            None
        };
        if let Some(mut existing) = existing_model {
            update_lm_studio_model_metadata(
                &mut existing,
                internal_id,
                raw_id,
                reachable,
                discovered_model.context_tokens(),
                discovered_model.max_context_tokens,
            );
            let payload = sanitize_lm_studio_model_for_update(existing, user_id);
            openwebui_model_mutation_post(
                &format!(
                    "/api/v1/models/model/update?id={}",
                    utf8_percent_encode(internal_id, NON_ALPHANUMERIC)
                ),
                token,
                &payload,
                60.0,
            )
            .await?;
            updated += 1;
        } else {
            let payload = build_lm_studio_model_payload(
                internal_id,
                raw_id,
                reachable,
                discovered_model.context_tokens(),
                discovered_model.max_context_tokens,
            );
            openwebui_model_mutation_post("/api/v1/models/create", token, &payload, 60.0).await?;
            created += 1;
        }
    }
    Ok((updated, created))
}

async fn disable_existing_lm_studio_models(
    token: &str,
    user_id: &str,
    existing_models: &[Value],
) -> Result<usize> {
    let mut disabled = 0;
    for model in existing_models
        .iter()
        .filter(|model| is_lm_studio_model(model))
    {
        let Some(model_id) = model.get("id").and_then(Value::as_str) else {
            continue;
        };
        let raw_id = lm_studio_raw_model_id(model).unwrap_or_else(|| model_id.to_string());
        let mut full_model = fetch_model_optional_by_id(model_id, token)
            .await?
            .unwrap_or_else(|| model.clone());
        update_lm_studio_model_metadata(&mut full_model, model_id, &raw_id, false, None, None);
        let payload = sanitize_lm_studio_model_for_update(full_model, user_id);
        openwebui_model_mutation_post(
            &format!(
                "/api/v1/models/model/update?id={}",
                utf8_percent_encode(model_id, NON_ALPHANUMERIC)
            ),
            token,
            &payload,
            60.0,
        )
        .await?;
        disabled += 1;
    }
    Ok(disabled)
}

fn merge_lm_studio_openai_config(
    existing: Value,
    resolved: &LmStudioResolvedConfig,
    reachable: bool,
    internal_model_ids: &[String],
    aliases: &BTreeMap<String, String>,
) -> Value {
    let mut base_urls = existing
        .get("OPENAI_API_BASE_URLS")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut api_keys = existing
        .get("OPENAI_API_KEYS")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut api_configs = existing
        .get("OPENAI_API_CONFIGS")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let mut target_index = base_urls
        .iter()
        .position(|url| url.as_str() == Some(resolved.docker_base_url.as_str()));
    if target_index.is_none() {
        target_index = api_configs.iter().find_map(|(key, value)| {
            let provider = value
                .get("portico_provider")
                .or_else(|| value.get("local_provider"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if provider == LM_STUDIO_PROVIDER_ID {
                key.parse::<usize>().ok()
            } else {
                None
            }
        });
    }

    let index = target_index.unwrap_or(base_urls.len());
    while base_urls.len() <= index {
        base_urls.push(json!(""));
    }
    while api_keys.len() <= index {
        api_keys.push(json!(""));
    }
    base_urls[index] = json!(resolved.docker_base_url);
    api_keys[index] = json!(resolved.api_key);
    api_configs.insert(
        index.to_string(),
        json!({
            "enable": reachable,
            "connection_type": "local",
            "portico_provider": LM_STUDIO_PROVIDER_ID,
            "local_provider": LM_STUDIO_PROVIDER_ID,
            "model_ids": internal_model_ids,
            "model_aliases": aliases,
            "lm_studio_model_aliases": aliases,
            "tags": [{ "name": LM_STUDIO_TAG_NAME }],
        }),
    );

    json!({
        "ENABLE_OPENAI_API": existing
            .get("ENABLE_OPENAI_API")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        "OPENAI_API_BASE_URLS": base_urls,
        "OPENAI_API_KEYS": api_keys,
        "OPENAI_API_CONFIGS": api_configs,
    })
}

async fn sync_lm_studio_openai_connection(
    token: &str,
    resolved: &LmStudioResolvedConfig,
    reachable: bool,
    internal_model_ids: &[String],
    aliases: &BTreeMap<String, String>,
) -> Result<()> {
    let current_config = openwebui_get_json_retry("/openai/config", token)
        .await
        .unwrap_or_else(|error| {
            warn!("failed to read OpenWebUI OpenAI config for LM Studio: {error:#}");
            json!({})
        });
    let payload = merge_lm_studio_openai_config(
        current_config,
        resolved,
        reachable,
        internal_model_ids,
        aliases,
    );
    openwebui_post_json_retry("/openai/config/update", token, &payload, 60.0).await?;
    Ok(())
}

async fn request_owui_model_refresh() -> bool {
    match electron_post_json(
        "/api/owui/request-model-refresh",
        &json!({ "reason": "lm-studio-configured" }),
        5.0,
    )
    .await
    {
        Ok(_) => true,
        Err(error) => {
            warn!("failed to request OWUI model refresh after LM Studio setup: {error:#}");
            false
        }
    }
}

async fn sync_lm_studio_models_from_config(
    token: &str,
    user_id: &str,
    resolved: &LmStudioResolvedConfig,
) -> Result<Value> {
    let existing_models = fetch_all_models().await?;
    let fetched_models = probe_lm_studio_models(resolved).await;
    match fetched_models {
        Ok(models) => {
            let model_ids = models
                .iter()
                .map(|model| model.id.clone())
                .collect::<Vec<_>>();
            let discovered = models
                .iter()
                .map(|model| {
                    (
                        lm_studio_internal_model_id(&model.id, &existing_models),
                        model.clone(),
                    )
                })
                .collect::<Vec<_>>();
            let internal_model_ids = discovered
                .iter()
                .map(|(internal_id, _)| internal_id.clone())
                .collect::<Vec<_>>();
            let aliases = discovered
                .iter()
                .map(|(internal_id, model)| (internal_id.clone(), model.id.clone()))
                .collect::<BTreeMap<_, _>>();
            let model_metadata = models
                .iter()
                .map(|model| {
                    json!({
                        "id": model.id.clone(),
                        "loaded_context_tokens": model.loaded_context_tokens,
                        "max_context_tokens": model.max_context_tokens,
                    })
                })
                .collect::<Vec<_>>();
            sync_lm_studio_openai_connection(token, resolved, true, &internal_model_ids, &aliases)
                .await?;
            let (updated, created) = upsert_lm_studio_model_wrappers(
                token,
                user_id,
                &discovered,
                &existing_models,
                true,
            )
            .await?;
            let ui_refresh_requested = request_owui_model_refresh().await;
            Ok(json!({
                "configured": true,
                "reachable": true,
                "port": resolved.port,
                "host_base_url": resolved.host_base_url,
                "docker_base_url": resolved.docker_base_url,
                "model_ids": model_ids,
                "models": model_metadata,
                "internal_model_ids": internal_model_ids,
                "created": created,
                "updated": updated,
                "disabled": 0,
                "ui_refresh_requested": ui_refresh_requested,
            }))
        }
        Err(error) => {
            let existing_local_ids = existing_lm_studio_internal_ids(&existing_models);
            let aliases = existing_models
                .iter()
                .filter(|model| is_lm_studio_model(model))
                .filter_map(|model| {
                    let internal_id = model.get("id").and_then(Value::as_str)?;
                    let raw_id = lm_studio_raw_model_id(model)?;
                    Some((internal_id.to_string(), raw_id))
                })
                .collect::<BTreeMap<_, _>>();
            sync_lm_studio_openai_connection(token, resolved, false, &existing_local_ids, &aliases)
                .await?;
            let disabled =
                disable_existing_lm_studio_models(token, user_id, &existing_models).await?;
            let ui_refresh_requested = request_owui_model_refresh().await;
            Ok(json!({
                "configured": true,
                "reachable": false,
                "port": resolved.port,
                "host_base_url": resolved.host_base_url,
                "docker_base_url": resolved.docker_base_url,
                "model_ids": [],
                "internal_model_ids": existing_local_ids,
                "created": 0,
                "updated": 0,
                "disabled": disabled,
                "disabled_reason": LM_STUDIO_DISABLED_REASON,
                "error": error.to_string(),
                "ui_refresh_requested": ui_refresh_requested,
            }))
        }
    }
}

pub(super) async fn handle_get_lm_studio_status(arguments: &Map<String, Value>) -> Result<Value> {
    let config = load_lm_studio_config()?;
    let mut resolved = resolve_lm_studio_config(config.as_ref());
    if let Some(port) = arguments
        .get("port")
        .and_then(Value::as_u64)
        .and_then(|value| u16::try_from(value).ok())
    {
        resolved = resolve_lm_studio_config(Some(&LmStudioConfig {
            enabled: Some(true),
            port: Some(port),
            host_base_url: None,
            docker_base_url: None,
            api_key: config.as_ref().and_then(|value| value.api_key.clone()),
        }));
    }
    let probe = probe_lm_studio_models(&resolved).await;
    let (reachable, model_ids, models, error) = match probe {
        Ok(models) => {
            let ids = models
                .iter()
                .map(|model| model.id.clone())
                .collect::<Vec<_>>();
            let model_metadata = models
                .iter()
                .map(|model| {
                    json!({
                        "id": model.id.clone(),
                        "loaded_context_tokens": model.loaded_context_tokens,
                        "max_context_tokens": model.max_context_tokens,
                    })
                })
                .collect::<Vec<_>>();
            (true, ids, model_metadata, Value::Null)
        }
        Err(error) => (
            false,
            Vec::new(),
            Vec::new(),
            Value::String(error.to_string()),
        ),
    };
    success_text(json!({
        "configured": config.is_some(),
        "reachable": reachable,
        "port": resolved.port,
        "host_base_url": resolved.host_base_url,
        "docker_base_url": resolved.docker_base_url,
        "model_ids": model_ids,
        "models": models,
        "disabled_reason": if reachable { Value::Null } else { Value::String(LM_STUDIO_DISABLED_REASON.to_string()) },
        "error": error,
        "config_path": lm_studio_config_path()?.display().to_string(),
    }))
}

pub(super) async fn handle_get_system_information(
    _arguments: &Map<String, Value>,
) -> Result<Value> {
    let response = electron_get_json("/api/system-information", 10.0).await?;
    success_text(response)
}

pub(super) async fn handle_configure_lm_studio(arguments: &Map<String, Value>) -> Result<Value> {
    let port = arguments
        .get("port")
        .and_then(Value::as_u64)
        .and_then(|value| u16::try_from(value).ok())
        .unwrap_or(LM_STUDIO_DEFAULT_PORT);
    let host_base_url = arguments
        .get("host_base_url")
        .and_then(Value::as_str)
        .map(normalize_lm_studio_base_url)
        .unwrap_or_else(|| format!("http://127.0.0.1:{port}/v1"));
    let docker_base_url = arguments
        .get("docker_base_url")
        .and_then(Value::as_str)
        .map(normalize_lm_studio_base_url)
        .unwrap_or_else(|| format!("http://host.docker.internal:{port}/v1"));
    let api_key = arguments
        .get("api_key")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let config = LmStudioConfig {
        enabled: Some(true),
        port: Some(port),
        host_base_url: Some(host_base_url),
        docker_base_url: Some(docker_base_url),
        api_key: Some(api_key),
    };
    let config_path = write_lm_studio_config(&config)?;
    let resolved = resolve_lm_studio_config(Some(&config));
    let token = get_openwebui_token().await?;
    let user_id = get_openwebui_user_id().await?;
    let mut result = sync_lm_studio_models_from_config(&token, &user_id, &resolved).await?;
    if let Some(object) = result.as_object_mut() {
        object.insert(
            "config_path".to_string(),
            Value::String(config_path.display().to_string()),
        );
    }
    success_text(result)
}

pub(super) async fn handle_get_agent(arguments: &Map<String, Value>) -> Result<Value> {
    let model_id = string_arg(arguments, "model_id")?;
    let Some(model) = fetch_existing_model_by_id(&model_id).await else {
        return agent_not_found_envelope(&model_id);
    };
    let tools_map = tools_map_for_subagents().await.unwrap_or_default();
    let mut agent = filter_agent_value(&model, false, &tools_map);
    enrich_agent_with_link_state(&mut agent, agent_link_state_map().await.as_ref());
    success_text(agent)
}

pub(super) async fn handle_get_agent_system_prompt(
    arguments: &Map<String, Value>,
) -> Result<Value> {
    let model_id = string_arg(arguments, "model_id")?;
    let Some(model) = fetch_existing_model_by_id(&model_id).await else {
        return agent_not_found_envelope(&model_id);
    };
    success_text(json!({
        "model_id": model_id,
        "system_prompt": model.get("params").and_then(|value| value.get("system")).cloned().unwrap_or(Value::String(String::new())),
    }))
}

async fn authoritative_creator_email() -> Result<String> {
    let response = electron_get_json("/api/agent-attribution/current-user", 10.0).await?;
    response
        .get("email")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.contains('@'))
        .map(str::to_string)
        .context("authenticated user email is unavailable for agent creation")
}

fn non_empty_meta_string(model: &Value, key: &str) -> Option<String> {
    model_meta_value(model, key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Mirror of the renderer's normalizeMarketplaceOwnerIdentity: ownership is
/// compared as a lowercased bare handle because created-by values may be full
/// emails or bare LDAP handles depending on how they were captured.
fn normalize_owner_identity(value: &str) -> String {
    let normalized = value.trim().to_lowercase();
    match normalized.find('@') {
        Some(at) => normalized[..at].to_string(),
        None => normalized,
    }
}

/// Best-effort link-sidecar snapshot for lifecycle enrichment: the `links`
/// map from /api/agent-attribution/context, keyed by model id. None on any
/// failure — enrichment is additive and must never fail a listing.
async fn agent_link_state_map() -> Option<Map<String, Value>> {
    let context = electron_get_json("/api/agent-attribution/context", 10.0)
        .await
        .ok()?;
    context.get("links").and_then(Value::as_object).cloned()
}

/// Lifecycle states from the agent-link sidecar: `has_unpublished_changes`
/// (local edits since publish/install) and `marketplace_remote_updated_at`
/// (the listing's updated_timestamp baselined at install/publish — compare
/// against get_marketplace_agent's live updated_timestamp to decide "update
/// available"; `has_update` below is only as fresh as the last sweep).
fn enrich_agent_with_link_state(agent: &mut Value, links: Option<&Map<String, Value>>) {
    let Some(links) = links else { return };
    let Some(id) = agent
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return;
    };
    let Some(link) = links.get(&id) else { return };
    if let Some(object) = agent.as_object_mut() {
        object.insert(
            "has_unpublished_changes".to_string(),
            json!(link.get("hasLocalChanges").and_then(Value::as_bool) == Some(true)),
        );
        object.insert(
            "marketplace_remote_updated_at".to_string(),
            link.get("remoteUpdatedAt").cloned().unwrap_or(Value::Null),
        );
        // Persisted verdict from the agent update-check sweep
        // (check_marketplace_skill_updates' agent leg): the linked listing
        // moved past the installed baseline.
        object.insert(
            "has_update".to_string(),
            json!(link.get("hasRemoteUpdate").and_then(Value::as_bool) == Some(true)),
        );
    }
}

/// Adoption double-check: flipping a stranded Marketplace copy back to local
/// is only safe if the agent is still absent from the link registry at write
/// time. Any fetch or shape error fails closed at the call site.
async fn agent_still_unlinked_in_registry(model_id: &str) -> Result<bool> {
    let context = electron_get_json("/api/agent-attribution/context", 10.0).await?;
    let links = context
        .get("links")
        .and_then(Value::as_object)
        .context("agent attribution context is missing a links object")?;
    Ok(!links.contains_key(model_id))
}

fn set_meta_string(meta: &mut Map<String, Value>, key: &str, value: &str) -> bool {
    if meta.get(key).and_then(Value::as_str) == Some(value) {
        return false;
    }
    meta.insert(key.to_string(), Value::String(value.to_string()));
    true
}

fn remove_meta_value(meta: &mut Map<String, Value>, key: &str) -> bool {
    meta.remove(key).is_some()
}

async fn persist_agent_attribution_model(
    model_id: &str,
    mut model: Value,
    user_id: &str,
    creator: Option<&str>,
    source: Option<&str>,
    marketplace_relationship: Option<&str>,
    marketplace_solution_id: Option<&str>,
) -> Result<bool> {
    let object = model
        .as_object_mut()
        .context("existing model payload is not an object")?;
    object.insert("user_id".to_string(), Value::String(user_id.to_string()));
    object
        .entry("meta".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let meta = object
        .get_mut("meta")
        .and_then(Value::as_object_mut)
        .context("existing model metadata is not an object")?;
    let mut changed = false;
    if let Some(creator) = creator {
        changed |= set_meta_string(meta, SUBAGENT_CREATED_BY_EMAIL_META_KEY, creator);
    }
    if let Some(source) = source {
        changed |= set_meta_string(meta, SUBAGENT_CREATION_SOURCE_META_KEY, source);
    }
    match marketplace_relationship {
        Some(value) => {
            changed |= set_meta_string(meta, SUBAGENT_MARKETPLACE_RELATIONSHIP_META_KEY, value)
        }
        None => changed |= remove_meta_value(meta, SUBAGENT_MARKETPLACE_RELATIONSHIP_META_KEY),
    }
    match marketplace_solution_id {
        Some(value) => {
            changed |= set_meta_string(meta, SUBAGENT_MARKETPLACE_SOLUTION_ID_META_KEY, value)
        }
        None => changed |= remove_meta_value(meta, SUBAGENT_MARKETPLACE_SOLUTION_ID_META_KEY),
    }
    if !changed {
        return Ok(false);
    }
    object.remove("info");
    object.remove("user");
    object.remove("access_control");
    let token = get_openwebui_token().await?;
    openwebui_model_mutation_post(
        &format!(
            "/api/v1/models/model/update?id={}",
            utf8_percent_encode(model_id, NON_ALPHANUMERIC)
        ),
        &token,
        &model,
        60.0,
    )
    .await?;
    Ok(true)
}

pub(super) async fn handle_reconcile_agent_attribution(
    _arguments: &Map<String, Value>,
) -> Result<Value> {
    // Fetch the complete, strict context before making any model writes. A
    // malformed link registry therefore fails closed instead of looking empty.
    let context = electron_get_json("/api/agent-attribution/context", 10.0).await?;
    let current_email = context
        .get("email")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.contains('@'))
        .context("authenticated user email is unavailable for attribution reconciliation")?
        .to_string();
    let links = context
        .get("links")
        .and_then(Value::as_object)
        .context("agent attribution context is missing a links object")?;
    let models = fetch_all_models().await?;
    let user_id = get_openwebui_user_id().await?;
    let mut repaired_ids = Vec::new();
    let mut creator_backfilled_ids = Vec::new();
    let mut source_backfilled_ids = Vec::new();
    let mut marketplace_attributed_ids = Vec::new();
    let mut marketplace_adopted_ids = Vec::new();
    let mut published_source_normalized_ids = Vec::new();
    let mut finalized_pending_ids = Vec::new();
    let mut skipped_base_ids = Vec::new();
    let mut skipped_system_ids = Vec::new();
    let mut skipped_linked_ids = Vec::new();
    let mut missing_creator_linked_ids = Vec::new();
    let mut unchanged_ids = Vec::new();
    let mut failures = Vec::new();
    let mut seen_model_ids = HashSet::new();
    let mut checked = 0usize;

    for listing in models {
        let Some(model_id) = listing.get("id").and_then(Value::as_str).map(str::trim) else {
            continue;
        };
        if model_id.is_empty() {
            continue;
        }
        seen_model_ids.insert(model_id.to_string());
        checked += 1;
        if is_system_agent(model_id) {
            skipped_system_ids.push(model_id.to_string());
            continue;
        }
        if is_base_model(&listing) {
            skipped_base_ids.push(model_id.to_string());
            continue;
        }
        let full_model = match fetch_model_by_id(model_id).await {
            Ok(model) => model,
            Err(error) => {
                failures.push(json!({ "id": model_id, "error": error.to_string() }));
                continue;
            }
        };
        let existing_creator =
            non_empty_meta_string(&full_model, SUBAGENT_CREATED_BY_EMAIL_META_KEY);
        let existing_source = non_empty_meta_string(&full_model, SUBAGENT_CREATION_SOURCE_META_KEY);
        let link = links.get(model_id).and_then(Value::as_object);

        let mut desired_creator: Option<String> = None;
        let mut desired_source: Option<String> = None;
        let mut desired_relationship: Option<String> = None;
        let mut desired_solution_id: Option<String> = None;
        let mut pending_install = false;
        let mut marketplace_attribution = false;
        let mut local_creator_backfill = false;
        let mut local_source_backfill = false;
        let mut marketplace_adoption = false;
        let mut published_source_normalization = false;

        if let Some(link) = link {
            let relationship = link
                .get("relationship")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| matches!(*value, "published" | "installed" | "unknown"))
                .unwrap_or("unknown")
                .to_string();
            desired_relationship = Some(relationship.clone());
            desired_solution_id = link
                .get("solutionId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            pending_install = relationship == "installed"
                && link
                    .get("attributionPending")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
            match relationship.as_str() {
                "installed" => {
                    if !pending_install && existing_creator.is_none() {
                        missing_creator_linked_ids.push(model_id.to_string());
                        skipped_linked_ids.push(model_id.to_string());
                        continue;
                    }
                    let author = link
                        .get("authorIdentity")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty());
                    let Some(author) = author else {
                        failures.push(json!({
                            "id": model_id,
                            "error": "installed Marketplace link is missing authorIdentity"
                        }));
                        continue;
                    };
                    if pending_install {
                        desired_creator = Some(author.to_string());
                        marketplace_attribution = true;
                    }
                    if existing_source.is_none() || pending_install {
                        desired_source = Some("marketplace".to_string());
                    }
                }
                "published" => {
                    if existing_creator.is_none() {
                        missing_creator_linked_ids.push(model_id.to_string());
                        skipped_linked_ids.push(model_id.to_string());
                        continue;
                    }
                    match existing_source.as_deref() {
                        None => desired_source = Some("local".to_string()),
                        // Reclaim (an installed→published link flip) leaves the
                        // copy's source stamped "marketplace" until this pass.
                        // A published link plus a self-authored creator is
                        // authoritative author-side provenance, so normalize to
                        // editable. A third-party creator under a published
                        // link is contradictory state: fail closed and leave it
                        // read-only. Other populated sources ("system", junk)
                        // are out of scope.
                        Some(source) if source.eq_ignore_ascii_case("marketplace") => {
                            let creator = existing_creator.as_deref().unwrap_or("");
                            let owner = normalize_owner_identity(creator);
                            if !owner.is_empty()
                                && owner == normalize_owner_identity(&current_email)
                            {
                                desired_source = Some("local".to_string());
                                published_source_normalization = true;
                            }
                        }
                        _ => {}
                    }
                }
                _ => {
                    if existing_creator.is_none() {
                        missing_creator_linked_ids.push(model_id.to_string());
                    }
                    skipped_linked_ids.push(model_id.to_string());
                    continue;
                }
            }
        } else {
            // Foreign INSTALLED copies keep their marketplace provenance metas
            // while unlinked: meta is the durable replica the sidecar link can
            // be rebuilt from (2026-08-14 Smart Slides incident: a pruned link
            // made the None-arm scrub below destroy the only surviving copy of
            // the solution id, leaving nothing to self-heal from once the
            // listing itself was deleted). Owner-side clears (unpublish,
            // reclaim) flow through the linked branch or self-authored arms
            // and keep their existing semantics.
            let existing_relationship =
                non_empty_meta_string(&full_model, SUBAGENT_MARKETPLACE_RELATIONSHIP_META_KEY);
            let foreign_creator = existing_creator
                .as_deref()
                .map(normalize_owner_identity)
                .filter(|owner| {
                    !owner.is_empty() && *owner != normalize_owner_identity(&current_email)
                })
                .is_some();
            if existing_relationship.as_deref() == Some("installed") && foreign_creator {
                desired_relationship = existing_relationship;
                desired_solution_id = non_empty_meta_string(
                    &full_model,
                    SUBAGENT_MARKETPLACE_SOLUTION_ID_META_KEY,
                );
            }
            match (existing_creator.as_deref(), existing_source.as_deref()) {
                // No provenance at all: adopt as the current user's local
                // agent (also overwrites a stray source value).
                (None, _) => {
                    desired_creator = Some(current_email.clone());
                    desired_source = Some("local".to_string());
                    local_creator_backfill = true;
                }
                // Pre-provenance agent: a creator was recorded but the source
                // classification never was. Backfill the source only.
                (Some(_), None) => {
                    desired_source = Some("local".to_string());
                    local_source_backfill = true;
                }
                // Stranded installed copy (its link record was lost). Adopt it
                // only when self-authored AND provably unlinked: a finalized
                // install always carries relationship/solution metas, and a
                // fresh registry read closes the stale-snapshot race.
                (Some(creator), Some(source)) if source.eq_ignore_ascii_case("marketplace") => {
                    let has_marketplace_metas = non_empty_meta_string(
                        &full_model,
                        SUBAGENT_MARKETPLACE_RELATIONSHIP_META_KEY,
                    )
                    .is_some()
                        || non_empty_meta_string(
                            &full_model,
                            SUBAGENT_MARKETPLACE_SOLUTION_ID_META_KEY,
                        )
                        .is_some();
                    let owner = normalize_owner_identity(creator);
                    let self_authored =
                        !owner.is_empty() && owner == normalize_owner_identity(&current_email);
                    if self_authored && !has_marketplace_metas {
                        match agent_still_unlinked_in_registry(model_id).await {
                            Ok(true) => {
                                desired_source = Some("local".to_string());
                                marketplace_adoption = true;
                            }
                            // Relinked mid-pass: leave it; the linked branch
                            // owns it on the next reconcile.
                            Ok(false) => {}
                            Err(error) => {
                                failures.push(json!({
                                    "id": model_id,
                                    "error": format!(
                                        "stranded marketplace copy adoption re-check failed: {error}"
                                    ),
                                }));
                                continue;
                            }
                        }
                    }
                }
                // Any other populated source ("system", junk) is out of scope.
                _ => {}
            }
        }

        match persist_agent_attribution_model(
            model_id,
            full_model,
            &user_id,
            desired_creator.as_deref(),
            desired_source.as_deref(),
            desired_relationship.as_deref(),
            desired_solution_id.as_deref(),
        )
        .await
        {
            Ok(changed) => {
                if changed {
                    repaired_ids.push(model_id.to_string());
                } else {
                    unchanged_ids.push(model_id.to_string());
                }
                if local_creator_backfill {
                    creator_backfilled_ids.push(model_id.to_string());
                }
                if local_source_backfill {
                    source_backfilled_ids.push(model_id.to_string());
                }
                if marketplace_attribution {
                    marketplace_attributed_ids.push(model_id.to_string());
                }
                if marketplace_adoption {
                    marketplace_adopted_ids.push(model_id.to_string());
                }
                if published_source_normalization {
                    published_source_normalized_ids.push(model_id.to_string());
                }
                if pending_install {
                    finalized_pending_ids.push(model_id.to_string());
                }
            }
            Err(error) => {
                failures.push(json!({ "id": model_id, "error": error.to_string() }));
            }
        }
    }

    // A pending install is not complete until its reserved local model exists.
    // Keep the reconciliation retryable instead of clearing the sidecar bit if
    // a crash happened after the pending record but before model creation.
    for (model_id, link) in links {
        if seen_model_ids.contains(model_id) {
            continue;
        }
        let pending_install = link
            .get("relationship")
            .and_then(Value::as_str)
            .map(str::trim)
            == Some("installed")
            && link
                .get("attributionPending")
                .and_then(Value::as_bool)
                .unwrap_or(false);
        if pending_install {
            failures.push(json!({
                "id": model_id,
                "error": "pending Marketplace install model is not present"
            }));
        }
    }

    repaired_ids.sort();
    creator_backfilled_ids.sort();
    source_backfilled_ids.sort();
    marketplace_attributed_ids.sort();
    marketplace_adopted_ids.sort();
    published_source_normalized_ids.sort();
    finalized_pending_ids.sort();
    skipped_base_ids.sort();
    skipped_system_ids.sort();
    skipped_linked_ids.sort();
    missing_creator_linked_ids.sort();
    unchanged_ids.sort();
    let mut skipped_ids = skipped_base_ids
        .iter()
        .chain(skipped_system_ids.iter())
        .chain(skipped_linked_ids.iter())
        .chain(unchanged_ids.iter())
        .cloned()
        .collect::<Vec<_>>();
    skipped_ids.sort();
    skipped_ids.dedup();
    success_text(json!({
        "checked": checked,
        "repaired": repaired_ids.len(),
        "repaired_ids": repaired_ids,
        "creator_backfilled_ids": creator_backfilled_ids,
        "source_backfilled_ids": source_backfilled_ids,
        "marketplace_attributed_ids": marketplace_attributed_ids,
        "marketplace_adopted_ids": marketplace_adopted_ids,
        "published_source_normalized_ids": published_source_normalized_ids,
        "finalized_pending_ids": finalized_pending_ids,
        "skipped_ids": skipped_ids,
        "skipped_base_ids": skipped_base_ids,
        "skipped_system_ids": skipped_system_ids,
        "skipped_linked_ids": skipped_linked_ids,
        "missing_creator_linked_ids": missing_creator_linked_ids,
        "unchanged_ids": unchanged_ids,
        "failures": failures,
    }))
}

// Provenance gate for agent skill ADDITIONS: ids already on the agent (or on
// the copy source) are grandfathered — keep-allowed, add-blocked. Only the
// added ids are sent to the Electron validate-attachable route; when there is
// nothing to add, no request is made. A transport failure fails CLOSED for
// additions ("could not verify provenance"), never for keeps/removals.
async fn validate_agent_skill_additions(
    requested: &[String],
    existing: &[String],
) -> std::result::Result<(), Value> {
    let existing_set: HashSet<&str> = existing.iter().map(String::as_str).collect();
    let additions: Vec<String> = requested
        .iter()
        .filter(|id| !existing_set.contains(id.as_str()))
        .cloned()
        .collect();
    if additions.is_empty() {
        return Ok(());
    }

    // Local-existence gate BEFORE provenance: an agent may only link skills
    // that actually resolve on this machine (system, user, or installed
    // marketplace copies). Phantom ids pass the allowlist as "inert" and then
    // degrade silently at run time (run_subagent drops unknown skills), so
    // fail closed here with the missing ids named.
    let mut missing: Vec<String> = Vec::new();
    for skill_id in &additions {
        match find_skill(skill_id) {
            Ok(Some(_)) => {}
            Ok(None) => missing.push(skill_id.clone()),
            Err(error) => {
                warn!("could not resolve local skill '{skill_id}' for agent additions: {error:#}");
                missing.push(skill_id.clone());
            }
        }
    }
    if !missing.is_empty() {
        return Err(json!({
            "success": false,
            "code": "skill_not_installed_locally",
            "error": format!(
                "These skills are not installed locally and cannot be linked to an agent: {}",
                missing.join(", ")
            ),
            "missing_skills": missing,
            "remediation": "Install each skill first (install_marketplace_skill for git marketplaces, install_marketplace_solution for the Solutions Marketplace), or use list_skills to pick an existing local skill id.",
        }));
    }

    match electron_post_json(
        "/api/agent-skills/validate-attachable",
        &json!({ "skill_ids": additions }),
        15.0,
    )
    .await
    {
        Ok(response) => {
            let rejected = response
                .get("rejected")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if rejected.is_empty() {
                return Ok(());
            }
            let ids: Vec<String> = rejected
                .iter()
                .filter_map(|entry| entry.get("id").and_then(Value::as_str))
                .map(str::to_string)
                .collect();
            Err(json!({
                "success": false,
                "code": "skill_not_attachable",
                "error": format!(
                    "These skills come from marketplaces that are not approved for agent use: {}",
                    ids.join(", ")
                ),
                "rejected_skills": rejected,
                "remediation": "Remove those skills, or use skills from approved sources: built-in, your own user skills, the AI Solutions Marketplace, or approved git marketplaces.",
            }))
        }
        Err(error) => {
            warn!("could not verify skill provenance for agent additions: {error:#}");
            Err(json!({
                "success": false,
                "code": "skill_provenance_unverified",
                "error": "Could not verify the provenance of the skills being added (the app's local API is unreachable), so the additions were blocked.",
                "remediation": "Ensure Portico is running, then retry.",
            }))
        }
    }
}

pub(super) async fn handle_create_agent(arguments: &Map<String, Value>) -> Result<Value> {
    create_agent_with_grandfathered_skills(arguments, &[]).await
}

async fn create_agent_with_grandfathered_skills(
    arguments: &Map<String, Value>,
    grandfathered_skill_ids: &[String],
) -> Result<Value> {
    reject_legacy_tool_ids_argument(arguments)?;
    let name = string_arg(arguments, "name")?;
    let base_model_id = string_arg(arguments, "base_model_id")?;
    let system_prompt = arguments
        .get("system_prompt")
        .and_then(Value::as_str)
        .unwrap_or("");
    let description = arguments
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("");
    let (models, base_model) = fetch_validated_base_model(&base_model_id).await?;
    let tool_server_ids = array_strings(arguments.get("tool_server_ids"));
    let skill_ids = array_strings(arguments.get("skill_ids"));
    if let Err(envelope) =
        validate_agent_skill_additions(&skill_ids, grandfathered_skill_ids).await
    {
        return success_text(envelope);
    }
    let reasoning_effort = validate_reasoning_effort_for_model(
        &base_model,
        &models,
        arguments.get("reasoning_effort").and_then(Value::as_str),
    )?;
    let token = get_openwebui_token().await?;
    let agent_id = arguments
        .get("model_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| name.to_lowercase().replace(' ', "-"));
    if is_system_agent(&agent_id) {
        bail!("Cannot create system-delivered agent '{}'", agent_id);
    }
    if models
        .iter()
        .any(|model| model_id(model) == Some(agent_id.as_str()))
    {
        return success_text(json!({
            "success": false,
            "code": "agent_already_exists",
            "error": format!("Agent '{}' already exists", agent_id),
            "remediation": "Choose a unique local agent id.",
        }));
    }
    // Attribution is resolved by the application at execution time. Any
    // legacy caller-supplied created_by_email value is deliberately ignored.
    let created_by_email = authoritative_creator_email().await?;
    let mut payload = json!({
        "id": agent_id,
        "base_model_id": base_model_id,
        "name": name,
        "meta": {
            "profile_image_url": load_agent_icon_data_url(),
            "description": description,
            "capabilities": {
                "vision": true,
                "file_upload": true,
                "web_search": true,
                "image_generation": true,
                "code_interpreter": true,
                "citations": true
            }
        },
        "params": { "system": system_prompt },
    });
    if let Some(meta) = payload.get_mut("meta").and_then(Value::as_object_mut) {
        meta.insert(
            SUBAGENT_TOOL_SERVER_IDS_META_KEY.to_string(),
            Value::Array(tool_server_ids.into_iter().map(Value::String).collect()),
        );
        meta.insert(
            SUBAGENT_SKILL_IDS_META_KEY.to_string(),
            Value::Array(skill_ids.into_iter().map(Value::String).collect()),
        );
        meta.insert(
            SUBAGENT_CREATED_BY_EMAIL_META_KEY.to_string(),
            Value::String(created_by_email),
        );
        meta.insert(
            SUBAGENT_CREATION_SOURCE_META_KEY.to_string(),
            Value::String("local".to_string()),
        );
        if let Some(reasoning_effort) = reasoning_effort {
            meta.insert(
                SUBAGENT_REASONING_EFFORT_META_KEY.to_string(),
                Value::String(reasoning_effort),
            );
        }
    }
    let created =
        openwebui_model_mutation_post("/api/v1/models/create", &token, &payload, 60.0).await?;
    let tools_map = tools_map_for_subagents().await.unwrap_or_default();
    success_text(filter_agent_value(&created, false, &tools_map))
}

pub(super) async fn handle_copy_agent(arguments: &Map<String, Value>) -> Result<Value> {
    let source_agent_id = string_arg(arguments, "source_agent_id")?;
    let new_agent_id = string_arg(arguments, "new_agent_id")?;
    if is_system_agent(&source_agent_id) {
        return success_text(json!({
            "success": false,
            "code": "system_agent_read_only",
            "error": format!("System-delivered agent '{}' cannot be copied", source_agent_id),
            "remediation": "Choose a user-created or installed Marketplace agent.",
        }));
    }
    let Some(source) = fetch_existing_model_by_id(&source_agent_id).await else {
        return agent_not_found_envelope(&source_agent_id);
    };
    if is_base_model(&source) {
        return success_text(json!({
            "success": false,
            "code": "base_model_not_copyable",
            "error": format!("Base model '{}' is not an agent copy source", source_agent_id),
            "remediation": "Choose a user-created or installed Marketplace agent.",
        }));
    }
    let Some(base_model_id) = model_base_model_id(&source).map(str::to_string) else {
        return success_text(json!({
            "success": false,
            "code": "invalid_agent_configuration",
            "error": format!("Agent '{}' is missing its base model id", source_agent_id),
            "remediation": "Repair the source agent configuration before copying it.",
        }));
    };

    let mut create_arguments = Map::new();
    create_arguments.insert(
        "name".to_string(),
        Value::String(
            arguments
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("{} Copy", model_display_name(&source))),
        ),
    );
    create_arguments.insert("model_id".to_string(), Value::String(new_agent_id));
    create_arguments.insert("base_model_id".to_string(), Value::String(base_model_id));
    create_arguments.insert(
        "system_prompt".to_string(),
        source
            .get("params")
            .and_then(|value| value.get("system"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .map(Value::String)
            .unwrap_or_else(|| Value::String(String::new())),
    );
    create_arguments.insert(
        "description".to_string(),
        model_meta_value(&source, "description")
            .and_then(Value::as_str)
            .map(str::to_string)
            .map(Value::String)
            .unwrap_or_else(|| Value::String(String::new())),
    );
    create_arguments.insert(
        "tool_server_ids".to_string(),
        Value::Array(
            subagent_tool_server_ids_from_model(&source)
                .into_iter()
                .map(Value::String)
                .collect(),
        ),
    );
    let source_skill_ids = subagent_skill_ids_from_model(&source);
    create_arguments.insert(
        "skill_ids".to_string(),
        Value::Array(
            source_skill_ids
                .iter()
                .cloned()
                .map(Value::String)
                .collect(),
        ),
    );
    if let Some(reasoning_effort) = subagent_reasoning_effort_from_model(&source) {
        create_arguments.insert(
            "reasoning_effort".to_string(),
            Value::String(reasoning_effort),
        );
    }

    // The source agent's skills are grandfathered onto the copy — copying
    // never spreads anything new onto this machine.
    create_agent_with_grandfathered_skills(&create_arguments, &source_skill_ids).await
}

// Gate for the installed-copy refresh path: the requested content must MATCH
// the linked marketplace listing's bundle (fetched fresh through Electron).
// This is what makes `marketplace_refresh` safe to expose at the tool layer —
// a caller can only fast-forward an installed copy to marketplace truth, not
// smuggle edits past the read-only guard. skill_ids/tool_server_ids are
// exempt from the comparison because the install flow legitimately remaps
// them to local ids. Fails closed on any transport or shape problem.
async fn verify_marketplace_refresh_payload(
    existing: &Value,
    arguments: &Map<String, Value>,
) -> std::result::Result<(), Value> {
    let refresh_denied = |code: &str, error: String| {
        json!({
            "success": false,
            "code": code,
            "error": error,
            "remediation": "Refresh installed agents from their own marketplace listing (install_agent with existing_agent_id, or the app's update action).",
        })
    };
    let Some(solution_id) = model_meta_value(existing, SUBAGENT_MARKETPLACE_SOLUTION_ID_META_KEY)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
    else {
        return Err(refresh_denied(
            "marketplace_refresh_unlinked",
            "This installed agent has no marketplace solution link to refresh from.".to_string(),
        ));
    };
    let response = match electron_post_json(
        "/api/ai-marketplace/get-bundle",
        &json!({ "id": solution_id, "expected_type": "portico-agents" }),
        30.0,
    )
    .await
    {
        Ok(response) => response,
        Err(error) => {
            return Err(refresh_denied(
                "marketplace_refresh_unverified",
                format!("Could not verify the refresh against the marketplace listing: {error}"),
            ));
        }
    };
    let payload = response
        .get("data")
        .and_then(|data| data.get("payload"))
        .or_else(|| response.get("payload"))
        .cloned()
        .unwrap_or(Value::Null);
    if !payload.is_object() {
        return Err(refresh_denied(
            "marketplace_refresh_unverified",
            "The marketplace listing has no readable agent bundle to verify against.".to_string(),
        ));
    }
    for (argument_key, bundle_key) in [
        ("system_prompt", "system_prompt"),
        ("name", "name"),
        ("description", "description"),
        ("base_model_id", "base_model_id"),
    ] {
        let Some(requested) = arguments.get(argument_key).and_then(Value::as_str) else {
            continue;
        };
        let bundled = payload
            .get(bundle_key)
            .and_then(Value::as_str)
            .unwrap_or("");
        if requested != bundled {
            return Err(refresh_denied(
                "marketplace_refresh_mismatch",
                format!(
                    "The requested {argument_key} does not match the linked marketplace listing; installed copies only accept their own listing's content."
                ),
            ));
        }
    }
    Ok(())
}

pub(super) async fn handle_update_agent(arguments: &Map<String, Value>) -> Result<Value> {
    reject_legacy_tool_ids_argument(arguments)?;
    let model_id = string_arg(arguments, "model_id")?;
    if is_system_agent(&model_id) {
        bail!("Cannot update system-delivered agent '{}'", model_id);
    }
    let token = get_openwebui_token().await?;
    let user_id = get_openwebui_user_id().await?;
    let mut existing = fetch_model_by_id(&model_id).await?;
    if is_base_model(&existing) {
        bail!("Cannot update base model '{}'", model_id);
    }
    // True only when the read-only refresh gate below ran AND the payload
    // matched the linked listing. The dirty-marking exemption further down is
    // earned by that verification — a raw marketplace_refresh flag on an
    // EDITABLE agent is just a normal edit and must still mark the link dirty.
    let mut verified_refresh = false;
    if agent_is_read_only(&existing) {
        // Sanctioned marketplace refresh: the install/refresh flow re-applies
        // the LINKED listing's own bundle to an installed copy. The payload is
        // verified against the marketplace bundle before the guard opens, so
        // this path can only sync content, never inject edits.
        if !bool_arg(arguments, "marketplace_refresh", false) {
            return success_text(json!({
                "success": false,
                "code": "installed_copy_read_only",
                "error": format!("Agent '{}' is an installed read-only Marketplace copy", model_id),
                "remediation": "If the current viewer authored this agent's Marketplace listing, convert it in place with reclaim_agent; otherwise create an editable user copy with copy_agent, then update that copy.",
            }));
        }
        if let Err(envelope) = verify_marketplace_refresh_payload(&existing, arguments).await {
            return success_text(envelope);
        }
        verified_refresh = true;
    }
    if arguments.get("skill_ids").is_some() {
        // Keep-allowed / add-blocked: the agent's current skills are the
        // grandfathered baseline; only NEW ids must pass the provenance gate.
        let requested = array_strings(arguments.get("skill_ids"));
        let current = subagent_skill_ids_from_model(&existing);
        if let Err(envelope) = validate_agent_skill_additions(&requested, &current).await {
            return success_text(envelope);
        }
    }
    let existing_base_model_id = model_base_model_id(&existing)
        .map(str::to_string)
        .context("Existing agent is missing base_model_id")?;
    let effective_base_model_id = arguments
        .get("base_model_id")
        .and_then(Value::as_str)
        .unwrap_or(&existing_base_model_id);
    let next_reasoning_effort = if arguments.get("reasoning_effort").is_some() {
        let (models, effective_base_model) =
            fetch_validated_base_model(effective_base_model_id).await?;
        validate_reasoning_effort_for_model(
            &effective_base_model,
            &models,
            arguments.get("reasoning_effort").and_then(Value::as_str),
        )?
    } else if arguments.get("base_model_id").is_some() {
        let (models, effective_base_model) =
            fetch_validated_base_model(effective_base_model_id).await?;
        resolve_saved_reasoning_effort_for_model(
            &effective_base_model,
            &models,
            subagent_reasoning_effort_from_model(&existing).as_deref(),
        )?
    } else {
        resolve_saved_reasoning_effort_for_base_model(
            effective_base_model_id,
            subagent_reasoning_effort_from_model(&existing).as_deref(),
        )?
    };
    let object = existing
        .as_object_mut()
        .context("existing model payload is not an object")?;
    object.insert("user_id".to_string(), Value::String(user_id));
    object
        .entry("meta".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    object
        .get_mut("meta")
        .and_then(Value::as_object_mut)
        .map(|meta| {
            meta.insert(
                "profile_image_url".to_string(),
                Value::String(load_agent_icon_data_url()),
            );
            if let Some(name) = arguments.get("description").and_then(Value::as_str) {
                meta.insert("description".to_string(), Value::String(name.to_string()));
            }
            if arguments.get("tool_server_ids").is_some() {
                meta.insert(
                    SUBAGENT_TOOL_SERVER_IDS_META_KEY.to_string(),
                    Value::Array(
                        array_strings(arguments.get("tool_server_ids"))
                            .into_iter()
                            .map(Value::String)
                            .collect(),
                    ),
                );
                meta.remove(LEGACY_TOOL_IDS_META_KEY);
            }
            if arguments.get("skill_ids").is_some() {
                meta.insert(
                    SUBAGENT_SKILL_IDS_META_KEY.to_string(),
                    Value::Array(
                        array_strings(arguments.get("skill_ids"))
                            .into_iter()
                            .map(Value::String)
                            .collect(),
                    ),
                );
            }
            if let Some(reasoning_effort) = next_reasoning_effort.as_deref() {
                meta.insert(
                    SUBAGENT_REASONING_EFFORT_META_KEY.to_string(),
                    Value::String(reasoning_effort.to_string()),
                );
            } else {
                meta.remove(SUBAGENT_REASONING_EFFORT_META_KEY);
            }
        });
    if let Some(name) = arguments.get("name").and_then(Value::as_str) {
        object.insert("name".to_string(), Value::String(name.to_string()));
    }
    if let Some(base_model_id) = arguments.get("base_model_id").and_then(Value::as_str) {
        object.insert(
            "base_model_id".to_string(),
            Value::String(base_model_id.to_string()),
        );
    }
    if let Some(params) = object.get_mut("params").and_then(Value::as_object_mut) {
        if let Some(system_prompt) = arguments.get("system_prompt").and_then(Value::as_str) {
            params.insert(
                "system".to_string(),
                Value::String(system_prompt.to_string()),
            );
        }
    } else if let Some(system_prompt) = arguments.get("system_prompt").and_then(Value::as_str) {
        object.insert("params".to_string(), json!({ "system": system_prompt }));
    }
    object.remove("info");
    object.remove("user");
    object.remove("access_control");
    let updated = openwebui_model_mutation_post(
        &format!(
            "/api/v1/models/model/update?id={}",
            utf8_percent_encode(&model_id, NON_ALPHANUMERIC)
        ),
        &token,
        &existing,
        60.0,
    )
    .await?;
    // Agentic edits bypass the renderer's save path (which is what marks a
    // published agent's link dirty in the GUI), so report the successful edit
    // to Electron here. Best-effort: markLinkDirty no-ops for unlinked
    // agents, and older app builds without the route only miss a marker they
    // never kept. VERIFIED marketplace refreshes are exempt — they sync the
    // local copy TO the listing, which is the definition of clean. The raw
    // flag is never enough: on editable agents it would let content diverge
    // from the listing while has_unpublished_changes stayed false.
    if !verified_refresh {
        if let Err(error) = electron_post_json(
            "/api/ai-marketplace/mark-agent-link-dirty",
            &json!({ "agent_id": model_id }),
            10.0,
        )
        .await
        {
            warn!("could not mark agent '{model_id}' link dirty after an agentic edit: {error:#}");
        }
    }
    let tools_map = tools_map_for_subagents().await.unwrap_or_default();
    success_text(filter_agent_value(&updated, false, &tools_map))
}

pub(super) async fn handle_delete_agent(arguments: &Map<String, Value>) -> Result<Value> {
    let model_id = string_arg(arguments, "model_id")?;
    if is_system_agent(&model_id) {
        bail!("Cannot delete system-delivered agent '{}'", model_id);
    }
    // Same model-side gate as skills_delete_skill: destructive, so the model
    // must echo explicit user intent before any lookup or delete runs.
    if !bool_arg(arguments, "confirm", false) {
        return success_text(
            json!({ "success": false, "error": "Set confirm=true to delete the agent" }),
        );
    }
    // A lookup that "succeeds" with a null/id-less body is OWUI saying the id
    // is unknown (is_base_model would misread that body as a base model), so
    // it fails closed before any delete attempt. A failed lookup, by
    // contrast, must not block deletion: the delete endpoints below stay
    // authoritative when the lookup route itself is down.
    let existing = fetch_model_by_id(&model_id).await;
    if let Ok(existing) = existing.as_ref() {
        if !model_body_has_real_id(existing) {
            return agent_not_found_envelope(&model_id);
        }
        if is_base_model(existing) {
            bail!("Cannot delete base model '{}'", model_id);
        }
    }
    let token = get_openwebui_token().await?;
    let encoded = utf8_percent_encode(&model_id, NON_ALPHANUMERIC).to_string();
    let attempts = [
        (
            "post",
            "/api/v1/models/model/delete".to_string(),
            Some(json!({ "id": model_id.clone() })),
        ),
        (
            "delete",
            format!("/api/v1/models/model/delete?id={}", encoded),
            None,
        ),
        ("delete", format!("/api/v1/models/{}/delete", encoded), None),
    ];
    let mut success = false;
    let mut writer_busy_error: Option<String> = None;
    for (method, path, payload) in attempts {
        let response = if method == "post" {
            openwebui_model_mutation_post(&path, &token, payload.as_ref().unwrap(), 30.0).await
        } else {
            openwebui_model_mutation_delete(&path, &token, payload.as_ref()).await
        };
        match response {
            Ok(_) => {
                success = true;
                break;
            }
            Err(error) if is_openwebui_writer_lease_conflict(&error) => {
                // A lease conflict means Open WebUI understood the request
                // and is busy — the legacy fallback routes contend for the
                // same global writer lease, so trying them would only
                // multiply the bounded backoff. Not-found/legacy-route
                // errors still fall through to the next attempt unchanged.
                writer_busy_error = Some(error.to_string());
                break;
            }
            Err(_) => {}
        }
    }
    if success {
        let cleanup = electron_post_json(
            "/api/ai-marketplace/clear-deleted-agent-link",
            &json!({ "agent_id": model_id.clone() }),
            30.0,
        )
        .await?;
        if cleanup.get("success").and_then(Value::as_bool) == Some(false) {
            return success_text(json!({
                "success": false,
                "code": cleanup.get("code").cloned().unwrap_or(json!("local_link_cleanup_failed")),
                "error": cleanup.get("error").cloned().unwrap_or(json!("Agent was deleted, but its local Marketplace link could not be cleared")),
                "remediation": cleanup.get("remediation").cloned().unwrap_or(Value::Null),
                "model_id": model_id,
                "local_deleted": true,
                "remote_solution_deleted": false,
            }));
        }
    }
    if success {
        return success_text(json!({
            "success": true,
            "model_id": model_id,
            "local_deleted": true,
            "remote_solution_deleted": false,
            "message": "Agent deleted locally; any Marketplace solution remains published",
        }));
    }
    let (code, error, remediation) = if let Some(busy_error) = writer_busy_error {
        (
            "openwebui_writer_busy",
            busy_error,
            "Retry the delete in a moment.",
        )
    } else if existing.is_err() {
        (
            "agent_not_found",
            format!("Agent '{}' was not found locally", model_id),
            "Use list_agents and choose an existing agent id.",
        )
    } else {
        (
            "agent_delete_failed",
            format!("Failed to delete local agent '{}'", model_id),
            "Retry after checking the local agent service.",
        )
    };
    success_text(json!({
        "success": false,
        "code": code,
        "error": error.clone(),
        "message": error,
        "remediation": remediation,
        "model_id": model_id,
        "local_deleted": false,
        "remote_solution_deleted": false,
    }))
}

pub(super) async fn handle_run_subagent(arguments: &Map<String, Value>) -> Result<Value> {
    reject_legacy_tool_ids_argument(arguments)?;
    let request = RunSubagentRequest {
        model: arguments
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_string),
        prompt: string_arg(arguments, "prompt")?,
        system_prompt: None,
        image_urls: subagent_image_urls_arg(arguments)?,
        tool_server_ids: array_strings(arguments.get("tool_server_ids")),
        skill_ids: array_strings(arguments.get("skill_ids")),
        include_core_tools: arguments
            .get("include_core_tools")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        reasoning_effort: arguments
            .get("reasoning_effort")
            .and_then(Value::as_str)
            .map(str::to_string),
        parent_tool_call_id: arguments
            .get("parent_tool_call_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        parent_chat_id: arguments
            .get("parent_chat_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        folder_name: arguments
            .get("folder_name")
            .and_then(Value::as_str)
            .map(str::to_string),
        // The user-facing ``run_subagent`` MCP tool intentionally does
        // not expose the chat metadata field — only the scheduling
        // daemon (a privileged caller) stamps scheduled-run bindings.
        // Letting model-driven sub-agent calls supply arbitrary chat
        // metadata would let a model self-grant scheduled-run scope
        // bypass on its own children, which is exactly what N-012
        // prevents.
        metadata: None,
    };
    success_text(run_subagent_result_payload(&run_subagent(request).await?))
}

fn run_subagent_result_payload(result: &RunSubagentResult) -> Value {
    json!({
        "model": &result.model,
        "response": &result.response,
        "response_char_count": result.response_char_count,
        "response_truncated": result.response_truncated,
        "chat_id": &result.chat_id,
        "session_id": &result.session_id,
        "task_id": &result.task_id,
        "tool_call_count": result.tool_call_count,
        "usage_tokens": result.usage_tokens,
        "context_tokens": result.context_tokens,
        "max_context_tokens": result.max_context_tokens,
        "success": result.success,
        "error": result.error.clone().unwrap_or(Value::Null),
    })
}

fn normalize_subagent_image_url(url: &str) -> String {
    let trimmed = url.trim();
    trimmed
        .strip_prefix("http://localhost:9876/workspace/")
        .map(|path| format!("http://host.docker.internal:9876/workspace/{path}"))
        .or_else(|| {
            trimmed
                .strip_prefix("http://127.0.0.1:9876/workspace/")
                .map(|path| format!("http://host.docker.internal:9876/workspace/{path}"))
        })
        .unwrap_or(trimmed.to_string())
}

fn subagent_image_urls_arg(arguments: &Map<String, Value>) -> Result<Vec<String>> {
    let image_urls = array_strings(arguments.get("image_urls"));
    if image_urls.len() > MAX_SUBAGENT_IMAGE_URLS {
        bail!("image_urls supports at most {MAX_SUBAGENT_IMAGE_URLS} images per run_subagent call");
    }
    Ok(image_urls
        .iter()
        .map(|url| normalize_subagent_image_url(url))
        .collect())
}

fn subagent_user_content(prompt: &str, image_urls: &[String]) -> Value {
    if image_urls.is_empty() {
        return Value::String(prompt.to_string());
    }

    let mut content = vec![json!({ "type": "text", "text": prompt })];
    content.extend(image_urls.iter().map(|url| {
        json!({
            "type": "image_url",
            "image_url": { "url": url },
        })
    }));
    Value::Array(content)
}

fn effective_subagent_folder_name(folder_name: Option<&str>) -> String {
    folder_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_SUBAGENT_FOLDER_NAME)
        .to_string()
}

fn chat_workspace_settings_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn chat_workspace_settings_path() -> Result<PathBuf> {
    Ok(workspace_cfg_dir()?.join(CHAT_WORKSPACES_SETTINGS_FILE))
}

fn validate_workspace_chat_id(chat_id: &str) -> Result<String> {
    let normalized = chat_id.trim();
    if normalized.is_empty()
        || normalized.contains('/')
        || normalized.contains('\\')
        || normalized.contains('\0')
        || normalized.starts_with('.')
    {
        bail!("Invalid chat id for workspace inheritance");
    }
    Ok(normalized.to_string())
}

fn read_chat_workspace_settings_value(path: &Path) -> Result<Value> {
    if !path.exists() {
        return Ok(json!({ "chats": {} }));
    }
    let raw = fs::read_to_string(path)
        .with_context(|| format!("failed to read chat workspace settings {}", path.display()))?;
    let parsed = serde_json::from_str::<Value>(&raw)
        .with_context(|| format!("failed to parse chat workspace settings {}", path.display()))?;
    if parsed.is_object() {
        Ok(parsed)
    } else {
        Ok(json!({ "chats": {} }))
    }
}

fn chat_workspace_entry_host_path(settings: &Value, chat_id: &str) -> Option<PathBuf> {
    let entry = settings
        .get("chats")
        .and_then(Value::as_object)
        .and_then(|chats| chats.get(chat_id))
        .and_then(Value::as_object)?;
    if entry.get("source").and_then(Value::as_str) != Some("custom") {
        return None;
    }
    let host_path = PathBuf::from(entry.get("host_path").and_then(Value::as_str)?.trim());
    host_path.is_absolute().then_some(host_path)
}

/// A started chat whose entry carries `linked_workspace: true` FOLLOWS its
/// root chat's current workspace at read time (the entry's own host_path is
/// only a fallback snapshot). Returns the validated root id for such entries.
fn linked_root_from_settings_entry(settings: &Value, chat_id: &str) -> Option<String> {
    let entry = settings
        .get("chats")
        .and_then(Value::as_object)
        .and_then(|chats| chats.get(chat_id))
        .and_then(Value::as_object)?;
    if entry.get("linked_workspace").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let root = entry
        .get("root_parent_chat_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let root = validate_workspace_chat_id(root).ok()?;
    (root != chat_id).then_some(root)
}

fn effective_chat_workspace_host_path(chat_id: &str, settings: &Value) -> Result<PathBuf> {
    let normalized_chat_id = validate_workspace_chat_id(chat_id)?;
    if let Some(root_chat_id) = linked_root_from_settings_entry(settings, &normalized_chat_id) {
        // One hop only: a root that is itself linked is an anomaly, so fall
        // through to the child's own snapshot host_path below.
        if linked_root_from_settings_entry(settings, &root_chat_id).is_none() {
            if let Some(host_path) = chat_workspace_entry_host_path(settings, &root_chat_id) {
                return Ok(host_path);
            }
            return Ok(host_workspaces_dir()?.join(root_chat_id));
        }
    }
    if let Some(host_path) = chat_workspace_entry_host_path(settings, &normalized_chat_id) {
        return Ok(host_path);
    }
    Ok(host_workspaces_dir()?.join(normalized_chat_id))
}

fn subagent_reverse_metadata(chat_id: &str) -> Result<Option<Value>> {
    let Some(raw) = redis_get_string(&format!("subagent_chat:{chat_id}"))? else {
        return Ok(None);
    };
    Ok(serde_json::from_str::<Value>(&raw).ok())
}

fn resolve_workspace_inheritance(
    parent_chat_id: &str,
    settings: &Value,
) -> Result<WorkspaceInheritance> {
    let parent_chat_id = validate_workspace_chat_id(parent_chat_id)?;
    let parent_metadata = subagent_reverse_metadata(&parent_chat_id)?;
    let root_parent_chat_id = match parent_metadata
        .as_ref()
        .and_then(|value| value.get("root_parent_chat_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(validate_workspace_chat_id)
        .transpose()?
    {
        Some(root) => root,
        // A subagent spawned FROM a workspace-linked started chat chains to
        // the link's true root, so its snapshot tracks the root's CURRENT dir.
        None => linked_root_from_settings_entry(settings, &parent_chat_id)
            .unwrap_or_else(|| parent_chat_id.clone()),
    };
    let root_workspace_host_path = if let Some(path) = parent_metadata
        .as_ref()
        .and_then(|value| value.get("root_workspace_host_path"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
    {
        path
    } else {
        effective_chat_workspace_host_path(&root_parent_chat_id, settings)?
    };

    Ok(WorkspaceInheritance {
        parent_chat_id,
        root_parent_chat_id,
        root_workspace_host_path,
    })
}

fn persist_subagent_workspace_inheritance(
    parent_chat_id: Option<&str>,
    child_chat_id: &str,
) -> Result<Option<WorkspaceInheritance>> {
    let inheritance = resolve_subagent_workspace_inheritance(parent_chat_id)?;
    persist_resolved_subagent_workspace_inheritance(inheritance, child_chat_id)
}

fn resolve_subagent_workspace_inheritance(
    parent_chat_id: Option<&str>,
) -> Result<Option<WorkspaceInheritance>> {
    let Some(parent_chat_id) = parent_chat_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let _guard = chat_workspace_settings_lock()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let settings_path = chat_workspace_settings_path()?;
    let settings = read_chat_workspace_settings_value(&settings_path)?;
    Ok(Some(resolve_workspace_inheritance(
        parent_chat_id,
        &settings,
    )?))
}

fn persist_resolved_subagent_workspace_inheritance(
    inheritance: Option<WorkspaceInheritance>,
    child_chat_id: &str,
) -> Result<Option<WorkspaceInheritance>> {
    let Some(inheritance) = inheritance else {
        return Ok(None);
    };
    let child_chat_id = validate_workspace_chat_id(child_chat_id)?;
    let _guard = chat_workspace_settings_lock()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let settings_path = chat_workspace_settings_path()?;
    let mut settings = read_chat_workspace_settings_value(&settings_path)?;

    let chats = settings_chats_object_mut(&mut settings)?;
    chats.insert(
        child_chat_id.to_string(),
        json!({
            "source": "custom",
            "host_path": inheritance.root_workspace_host_path.to_string_lossy().to_string(),
            "selected_at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "inherited_workspace": true,
            "inherited_from_chat_id": inheritance.parent_chat_id.clone(),
            "root_parent_chat_id": inheritance.root_parent_chat_id.clone(),
        }),
    );

    write_chat_workspace_settings(&settings_path, &settings)?;
    Ok(Some(inheritance))
}

fn settings_chats_object_mut(settings: &mut Value) -> Result<&mut Map<String, Value>> {
    let settings_object = settings
        .as_object_mut()
        .context("chat workspace settings root must be an object")?;
    if !settings_object
        .get("chats")
        .and_then(Value::as_object)
        .is_some()
    {
        settings_object.insert("chats".to_string(), Value::Object(Map::new()));
    }
    settings_object
        .get_mut("chats")
        .and_then(Value::as_object_mut)
        .context("chat workspace settings chats must be an object")
}

fn write_chat_workspace_settings(settings_path: &Path, settings: &Value) -> Result<()> {
    if let Some(parent) = settings_path.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!(
                "failed to create chat workspace settings directory {}",
                parent.display()
            )
        })?;
    }
    let rendered = serde_json::to_string_pretty(settings)?;
    fs::write(settings_path, format!("{rendered}\n")).with_context(|| {
        format!(
            "failed to write chat workspace settings {}",
            settings_path.display()
        )
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct LinkedChatWorkspace {
    pub(super) root_parent_chat_id: String,
    pub(super) host_path: PathBuf,
}

/// Registers `child_chat_id` (a chat created by start_chat) as sharing its
/// root chat's workspace. Unlike subagent inheritance, the entry is a LIVE
/// LINK: `linked_workspace: true` tells binding resolvers to re-derive the
/// path through `root_parent_chat_id` on every read, so the child follows the
/// root's workspace whenever it changes; `host_path` is only a fallback
/// snapshot for link-unaware readers (and is refreshed by the Electron
/// fan-out on root changes).
pub(super) fn persist_linked_chat_workspace(
    child_chat_id: &str,
    source_chat_id: &str,
) -> Result<LinkedChatWorkspace> {
    let child_chat_id = validate_workspace_chat_id(child_chat_id)?;
    let source_chat_id = validate_workspace_chat_id(source_chat_id)?;
    if child_chat_id == source_chat_id {
        bail!("a chat cannot share a workspace with itself");
    }
    let _guard = chat_workspace_settings_lock()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let settings_path = chat_workspace_settings_path()?;
    let mut settings = read_chat_workspace_settings_value(&settings_path)?;

    // Flatten: a source that is itself linked (a started chat) or inherited
    // (a subagent child) already knows the true root, so chains never form.
    let root_parent_chat_id = settings
        .get("chats")
        .and_then(Value::as_object)
        .and_then(|chats| chats.get(&source_chat_id))
        .and_then(Value::as_object)
        .filter(|entry| {
            entry.get("linked_workspace").and_then(Value::as_bool) == Some(true)
                || entry.get("inherited_workspace").and_then(Value::as_bool) == Some(true)
        })
        .and_then(|entry| entry.get("root_parent_chat_id").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(validate_workspace_chat_id)
        .transpose()?
        .unwrap_or_else(|| source_chat_id.clone());
    if root_parent_chat_id == child_chat_id {
        bail!("a chat cannot share a workspace with itself");
    }

    let host_path = match chat_workspace_entry_host_path(&settings, &root_parent_chat_id) {
        Some(path) => path,
        None => host_workspaces_dir()?.join(&root_parent_chat_id),
    };

    let chats = settings_chats_object_mut(&mut settings)?;
    chats.insert(
        child_chat_id.to_string(),
        json!({
            "source": "custom",
            "host_path": host_path.to_string_lossy().to_string(),
            "selected_at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "linked_workspace": true,
            "inherited_from_chat_id": source_chat_id,
            "root_parent_chat_id": root_parent_chat_id.clone(),
        }),
    );

    write_chat_workspace_settings(&settings_path, &settings)?;
    Ok(LinkedChatWorkspace {
        root_parent_chat_id,
        host_path,
    })
}

fn trimmed_non_empty_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn subagent_chat_metadata(
    base: Option<&Value>,
    parent_chat_id: Option<&str>,
    parent_tool_call_id: Option<&str>,
    workspace_inheritance: Option<&WorkspaceInheritance>,
) -> Option<Value> {
    let parent_chat_id = workspace_inheritance
        .map(|inheritance| inheritance.parent_chat_id.clone())
        .or_else(|| trimmed_non_empty_string(parent_chat_id));
    let root_parent_chat_id = workspace_inheritance
        .map(|inheritance| inheritance.root_parent_chat_id.clone())
        .or_else(|| parent_chat_id.clone());
    let parent_tool_call_id = trimmed_non_empty_string(parent_tool_call_id);

    if parent_chat_id.is_none() && root_parent_chat_id.is_none() && parent_tool_call_id.is_none() {
        return base.cloned();
    }

    let mut metadata = base
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_else(Map::new);
    let mut subagent = metadata
        .remove("subagent")
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_else(Map::new);

    if let Some(parent_chat_id) = parent_chat_id {
        subagent.insert("parent_chat_id".to_string(), Value::String(parent_chat_id));
    }
    if let Some(root_parent_chat_id) = root_parent_chat_id {
        subagent.insert(
            "root_parent_chat_id".to_string(),
            Value::String(root_parent_chat_id),
        );
    }
    if let Some(parent_tool_call_id) = parent_tool_call_id {
        subagent.insert(
            "parent_tool_call_id".to_string(),
            Value::String(parent_tool_call_id),
        );
    }

    metadata.insert("subagent".to_string(), Value::Object(subagent));
    Some(Value::Object(metadata))
}

/// Resolved request inputs that are stable across retry attempts:
/// model, folder, skills, tool ids, effort, and an OWUI token.
pub struct PreparedSubagentRequest {
    pub request: RunSubagentRequest,
    pub model: String,
    pub model_item: Value,
    pub folder_id: String,
    pub effective_skill_ids: Vec<String>,
    pub activatable_skill_ids: Vec<String>,
    pub merged_tool_ids: Vec<String>,
    pub effective_reasoning_effort: Option<String>,
    pub token: String,
}

/// In-flight subagent run handle: enough state to resume polling after a
/// process restart given persisted `chat_id` + `model` + `reasoning_effort`.
#[derive(Clone, Debug)]
pub struct StartedSubagentRun {
    pub chat_id: String,
    pub session_id: String,
    pub task_id: String,
    pub model: String,
    pub reasoning_effort: Option<String>,
    pub token: String,
}

/// Outcome of `await_subagent_completion`. The transient variant carries the
/// chat handle so callers (e.g., the `run_subagent` wrapper) can decide
/// whether to retry with a fresh chat.
pub enum AwaitOutcome {
    Done(RunSubagentResult),
    TransientUpstreamFailure {
        chat_id: String,
        session_id: String,
        task_id: String,
        model: String,
        error_message: String,
    },
}

/// One-shot setup for a subagent run. Resolves the model, folder, and merged
/// skill/tool ids, and fetches an OWUI auth token. The result is reusable
/// across retry attempts that create a fresh child chat each time.
pub async fn prepare_subagent_request(
    request: RunSubagentRequest,
) -> Result<PreparedSubagentRequest> {
    prepare_subagent_request_impl(request, true).await
}

/// start_chat variant: chat ownership and folder placement live on the human
/// side (the chats router creates the human-owned folder), so the
/// service-principal folder ensure — and the user-id lookup that only feeds
/// it — are skipped entirely. `folder_id` is empty in the returned struct;
/// callers of this variant must not use it.
pub(crate) async fn prepare_subagent_request_without_folder(
    request: RunSubagentRequest,
) -> Result<PreparedSubagentRequest> {
    prepare_subagent_request_impl(request, false).await
}

async fn prepare_subagent_request_impl(
    mut request: RunSubagentRequest,
    ensure_folder: bool,
) -> Result<PreparedSubagentRequest> {
    if request.image_urls.len() > MAX_SUBAGENT_IMAGE_URLS {
        bail!("image_urls supports at most {MAX_SUBAGENT_IMAGE_URLS} images per run_subagent call");
    }
    request.image_urls = request
        .image_urls
        .iter()
        .map(|url| normalize_subagent_image_url(url))
        .collect();

    let token = get_openwebui_token().await?;
    let models = fetch_all_models().await?;
    let model = resolve_subagent_model(&models, request.model.as_deref())?;
    let model_item = find_model_by_id(&models, model.as_str())
        .context("model item not found in available models")?;
    let saved_defaults = if has_base_model_id(model_item) {
        subagent_defaults_from_model(model_item)
    } else {
        SavedSubagentDefaults::default()
    };
    let effective_skill_ids =
        merge_unique_strings(&[&saved_defaults.skill_ids, &request.skill_ids]);
    let effective_tool_server_ids =
        merge_unique_strings(&[&saved_defaults.tool_server_ids, &request.tool_server_ids]);
    let effective_reasoning_effort = resolve_runtime_reasoning_effort(
        model_item,
        &models,
        request.reasoning_effort.as_deref(),
        saved_defaults.reasoning_effort.as_deref(),
    )?;
    let model_item = model_item.clone();
    let folder_id = if ensure_folder {
        let user_id = get_openwebui_user_id().await?;
        let folder_name = effective_subagent_folder_name(request.folder_name.as_deref());
        ensure_named_folder_for_user(&token, &user_id, &folder_name).await?
    } else {
        String::new()
    };
    let mut required_tool_ids = Vec::new();
    let mut activatable_skill_ids = Vec::new();
    for skill_id in &effective_skill_ids {
        if let Some(skill) = find_skill(skill_id)? {
            for server_id in skill.required_mcp_servers {
                if !required_tool_ids.contains(&server_id) {
                    required_tool_ids.push(server_id);
                }
            }
            if !activatable_skill_ids.contains(skill_id) {
                activatable_skill_ids.push(skill_id.clone());
            }
        }
    }
    let merged_tool_ids = merge_subagent_tool_ids(
        &effective_tool_server_ids,
        &required_tool_ids,
        request.include_core_tools,
    );

    Ok(PreparedSubagentRequest {
        request,
        model,
        model_item,
        folder_id,
        effective_skill_ids,
        activatable_skill_ids,
        merged_tool_ids,
        effective_reasoning_effort,
        token,
    })
}

/// Single-attempt: create a fresh child chat, write Redis capability keys,
/// post `/api/chat/completions`, and return immediately with the chat handle.
/// Polling for completion is the caller's responsibility.
fn build_subagent_completion_messages(system_prompt: Option<&str>, user_content: Value) -> Value {
    let mut messages = Vec::new();
    if let Some(system_prompt) = system_prompt
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        messages.push(json!({
            "role": "system",
            "content": system_prompt,
        }));
    }
    messages.push(json!({
        "role": "user",
        "content": user_content,
    }));
    Value::Array(messages)
}

/// Seeds the per-chat capability keys (`chat_skills:`, `subagent_explicit_skills:`,
/// `chat_tools:`) that drive skill activation, mid-turn tool discovery, the
/// active-capabilities UI, and later-turn tool backfill. Deliberately does NOT
/// write `subagent_chat:<id>` — that key marks a chat as delegated (main.py
/// confirmation gating) and belongs only to run_subagent's parent-tool-call /
/// workspace-inheritance path.
pub(crate) fn seed_subagent_chat_capability_keys(
    chat_id: &str,
    prepared: &PreparedSubagentRequest,
) -> Result<()> {
    let mut activated_skills = redis_get_string(&format!("chat_skills:{chat_id}"))?
        .map(|raw| serde_json::from_str::<Vec<String>>(&raw).unwrap_or_default())
        .unwrap_or_default();
    for skill_id in &prepared.activatable_skill_ids {
        if activated_skills.contains(skill_id) {
            continue;
        }
        activated_skills.push(skill_id.clone());
    }
    if !activated_skills.is_empty() {
        let redis_key = format!("chat_skills:{chat_id}");
        let encoded_skills = serde_json::to_string(&activated_skills)?;
        redis_setex_string(&redis_key, &encoded_skills, SKILL_TTL_SECONDS)?;
    }
    if !prepared.effective_skill_ids.is_empty() {
        let explicit_skills_key = format!("{SUBAGENT_EXPLICIT_SKILLS_KEY_PREFIX}{chat_id}");
        let encoded_explicit_skills = serde_json::to_string(&prepared.effective_skill_ids)?;
        redis_setex_string(
            &explicit_skills_key,
            &encoded_explicit_skills,
            SKILL_TTL_SECONDS,
        )?;
    }

    let tools_key = format!("chat_tools:{chat_id}");
    let encoded_tools = serde_json::to_string(&prepared.merged_tool_ids)?;
    redis_setex_string(&tools_key, &encoded_tools, SKILL_TTL_SECONDS)?;
    Ok(())
}

pub async fn start_subagent_run(prepared: &PreparedSubagentRequest) -> Result<StartedSubagentRun> {
    let user_content =
        subagent_user_content(&prepared.request.prompt, &prepared.request.image_urls);
    let workspace_inheritance =
        resolve_subagent_workspace_inheritance(prepared.request.parent_chat_id.as_deref())?;
    let chat_metadata = subagent_chat_metadata(
        prepared.request.metadata.as_ref(),
        prepared.request.parent_chat_id.as_deref(),
        prepared.request.parent_tool_call_id.as_deref(),
        workspace_inheritance.as_ref(),
    );
    let (chat_id, _user_message_id, timestamp) = create_subagent_chat(
        &prepared.token,
        &prepared.model,
        &user_content,
        &prepared.folder_id,
        chat_metadata.as_ref(),
        prepared.effective_reasoning_effort.as_deref(),
    )
    .await?;

    let workspace_inheritance =
        persist_resolved_subagent_workspace_inheritance(workspace_inheritance, &chat_id)?;

    seed_subagent_chat_capability_keys(&chat_id, prepared)?;

    // NB: the subagent's reasoning effort is persisted into the chat RECORD's
    // params by create_subagent_chat above — that is what the delegated view reads
    // to show the effort (chat-state is service-owned and unreadable by the human).
    // We deliberately do NOT PUT chat-state here: it would add an awaited
    // chat-state-api round-trip to the subagent-startup hot path for no display
    // benefit. Chat-state is still persisted post-completion (save_chat_state in
    // the completion path) for context-token accounting.

    if let Some(parent_tool_call_id) = prepared.request.parent_tool_call_id.as_deref() {
        let redis_key = format!("subagent_tool_call:{parent_tool_call_id}");
        let payload = json!({ "chat_id": chat_id, "created_at": now_epoch_seconds() }).to_string();
        redis_setex_string(&redis_key, &payload, SUBAGENT_TOOL_CALL_TTL_SECONDS)?;
    }

    if prepared.request.parent_tool_call_id.is_some() || workspace_inheritance.is_some() {
        let reverse_key = format!("subagent_chat:{chat_id}");
        let mut reverse_payload = json!({
            "created_at": now_epoch_seconds(),
            "allowed_tool_server_ids": prepared.merged_tool_ids.clone(),
            "explicit_skill_ids": prepared.effective_skill_ids.clone(),
        });
        if let Some(object) = reverse_payload.as_object_mut() {
            if let Some(parent_tool_call_id) = prepared.request.parent_tool_call_id.as_deref() {
                object.insert(
                    "parent_tool_call_id".to_string(),
                    Value::String(parent_tool_call_id.to_string()),
                );
            }
            if let Some(inheritance) = &workspace_inheritance {
                object.insert(
                    "parent_chat_id".to_string(),
                    Value::String(inheritance.parent_chat_id.clone()),
                );
                object.insert(
                    "root_parent_chat_id".to_string(),
                    Value::String(inheritance.root_parent_chat_id.clone()),
                );
                object.insert(
                    "root_workspace_host_path".to_string(),
                    Value::String(
                        inheritance
                            .root_workspace_host_path
                            .to_string_lossy()
                            .to_string(),
                    ),
                );
            }
        }
        let reverse_payload = reverse_payload.to_string();
        redis_setex_string(
            &reverse_key,
            &reverse_payload,
            SUBAGENT_TOOL_CALL_TTL_SECONDS,
        )?;
    }

    let session_id = Uuid::new_v4().to_string();
    let mut completion_payload = json!({
        "stream": true,
        "model": prepared.model,
        "messages": build_subagent_completion_messages(
            prepared.request.system_prompt.as_deref(),
            user_content.clone(),
        ),
        "params": { "function_calling": "native" },
        "tool_ids": prepared.merged_tool_ids.clone(),
        "tool_servers": [],
        "features": {
            "image_generation": false,
            "code_interpreter": false,
            "web_search": false
        },
        "variables": Value::Object({
            let mut variables = generate_variables();
            variables.insert("timestamp".to_string(), Value::String(timestamp.to_string()));
            variables
        }),
        "model_item": prepared.model_item.clone(),
        "session_id": session_id,
        "chat_id": chat_id,
        "id": Uuid::new_v4().to_string(),
        "background_tasks": {
            "title_generation": true,
            "tags_generation": true,
            "follow_up_generation": true
        }
    });
    if let Some(reasoning_effort) = prepared.effective_reasoning_effort.as_deref() {
        if let Some(object) = completion_payload.as_object_mut() {
            object.insert(
                "reasoning_effort".to_string(),
                Value::String(reasoning_effort.to_string()),
            );
        }
    }
    let completion = openwebui_post_json_retry(
        "/api/chat/completions",
        &prepared.token,
        &completion_payload,
        30.0,
    )
    .await?;
    let task_id = completion
        .get("task_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    Ok(StartedSubagentRun {
        chat_id,
        session_id,
        task_id,
        model: prepared.model.clone(),
        reasoning_effort: prepared.effective_reasoning_effort.clone(),
        token: prepared.token.clone(),
    })
}

/// Poll an in-flight subagent chat to terminal state. Returns
/// `AwaitOutcome::TransientUpstreamFailure` when the upstream provider
/// reports a transient error so callers can decide whether to retry.
pub async fn await_subagent_completion(handle: StartedSubagentRun) -> Result<AwaitOutcome> {
    let StartedSubagentRun {
        chat_id,
        session_id,
        task_id,
        model,
        reasoning_effort,
        token,
    } = handle;

    let completion_result = poll_subagent_completion(
        &token,
        &chat_id,
        model.as_str(),
        reasoning_effort.as_deref(),
    )
    .await?;
    let transient_upstream_failure = completion_result
        .get("transient_upstream_failure")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if transient_upstream_failure {
        let error_message = completion_result
            .get("error")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string();
        return Ok(AwaitOutcome::TransientUpstreamFailure {
            chat_id,
            session_id,
            task_id,
            model,
            error_message,
        });
    }

    let mut tool_call_count = 0_i64;
    let mut usage_tokens = 0_i64;
    let mut context_tokens = 0_i64;
    let max_context_tokens = max_context_tokens_for_model(model.as_str());
    if let Some(chat_data) = completion_result.get("chat_data") {
        let _ = align_messages(&token, &chat_id, model.as_str(), chat_data).await;
        tool_call_count = extract_tool_call_count_from_chat(chat_data);
        usage_tokens = extract_usage_from_chat(chat_data);
        context_tokens = normalize_context_tokens_for_window(usage_tokens, max_context_tokens);
        save_chat_state(
            &chat_id,
            context_tokens,
            max_context_tokens,
            reasoning_effort.as_deref(),
            Some(model.as_str()),
            &token,
        )
        .await;
    }
    let response = completion_result
        .get("chat_data")
        .map(parent_facing_response_from_chat_data)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            completion_result
                .get("response")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
        })
        .unwrap_or_default();
    let (response_body, response_char_count, response_truncated) =
        full_subagent_response(&response);
    Ok(AwaitOutcome::Done(RunSubagentResult {
        model: completion_result
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or(model.as_str())
            .to_string(),
        response: response_body,
        response_char_count,
        response_truncated,
        chat_id,
        session_id,
        task_id,
        tool_call_count,
        usage_tokens,
        context_tokens,
        max_context_tokens,
        success: completion_result
            .get("success")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        error: completion_result
            .get("error")
            .cloned()
            .filter(|value| !value.is_null()),
    }))
}

/// Backwards-compatible wrapper that prepares the request once, starts a
/// child chat, and polls for completion. Retries on transient upstream
/// failures by creating a fresh child chat. The timeout encloses preparation,
/// every attempt, and retry backoff so the complete tool call has one budget.
pub async fn run_subagent(request: RunSubagentRequest) -> Result<RunSubagentResult> {
    run_subagent_with_timeout(
        request,
        std::time::Duration::from_secs(SUBAGENT_RUN_TIMEOUT_SECONDS),
    )
    .await
}

async fn run_subagent_with_timeout(
    request: RunSubagentRequest,
    timeout: std::time::Duration,
) -> Result<RunSubagentResult> {
    match tokio::time::timeout(timeout, run_subagent_until_complete(request)).await {
        Ok(result) => result,
        // Dropping the local wait does not set the child cancellation key or
        // otherwise terminate the already-running Open WebUI chat.
        Err(_) => bail!("Chat did not complete within {:?}", timeout),
    }
}

async fn run_subagent_until_complete(request: RunSubagentRequest) -> Result<RunSubagentResult> {
    let prepared = prepare_subagent_request(request).await?;
    for attempt in 0..TRANSIENT_SUBAGENT_COMPLETION_MAX_ATTEMPTS {
        let started = start_subagent_run(&prepared).await?;
        match await_subagent_completion(started).await? {
            AwaitOutcome::Done(result) => return Ok(result),
            AwaitOutcome::TransientUpstreamFailure {
                chat_id,
                session_id,
                task_id,
                model,
                error_message,
            } => {
                if attempt + 1 < TRANSIENT_SUBAGENT_COMPLETION_MAX_ATTEMPTS {
                    warn!(
                        attempt = attempt + 1,
                        max_attempts = TRANSIENT_SUBAGENT_COMPLETION_MAX_ATTEMPTS,
                        chat_id = %chat_id,
                        session_id = %session_id,
                        task_id = %task_id,
                        model = %model,
                        error = %error_message,
                        "Transient upstream subagent failure; retrying with a fresh child chat",
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(
                        TRANSIENT_SUBAGENT_COMPLETION_RETRY_DELAY_MS * (attempt as u64 + 1),
                    ))
                    .await;
                    continue;
                }
                return Ok(RunSubagentResult {
                    model: model.clone(),
                    response: String::new(),
                    response_char_count: 0,
                    response_truncated: false,
                    chat_id,
                    session_id,
                    task_id,
                    tool_call_count: 0,
                    usage_tokens: 0,
                    context_tokens: 0,
                    max_context_tokens: max_context_tokens_for_model(model.as_str()),
                    success: false,
                    error: Some(Value::String(error_message)),
                });
            }
        }
    }

    unreachable!("subagent completion loop exited without returning");
}

async fn ensure_subagents_folder(token: &str) -> Result<String> {
    ensure_named_folder(token, DEFAULT_SUBAGENT_FOLDER_NAME).await
}

#[derive(Clone, Copy)]
struct SubagentsFolderCandidate<'a> {
    id: &'a str,
    is_root_level: bool,
    created_at: Option<f64>,
}

async fn ensure_named_folder(token: &str, folder_name: &str) -> Result<String> {
    let user_id = get_openwebui_user_id().await?;
    ensure_named_folder_for_user(token, &user_id, folder_name).await
}

fn subagent_folder_lock_key(user_id: &str, folder_name: &str) -> String {
    format!(
        "subagents_folder_lock:{user_id}:{}",
        URL_SAFE_NO_PAD.encode(folder_name.as_bytes())
    )
}

struct SubagentFolderLockGuard {
    key: String,
    token: String,
    released: bool,
}

impl SubagentFolderLockGuard {
    async fn acquire(user_id: &str, folder_name: &str) -> Result<Self> {
        let key = subagent_folder_lock_key(user_id, folder_name);
        let token = Uuid::new_v4().to_string();
        let started_at = now_epoch_seconds();
        loop {
            if redis_set_nx_ex_string(&key, &token, SUBAGENT_FOLDER_LOCK_TTL_SECONDS)? {
                return Ok(Self {
                    key,
                    token,
                    released: false,
                });
            }
            if (now_epoch_seconds() - started_at).max(0.0) >= SUBAGENT_FOLDER_LOCK_WAIT_SECONDS {
                bail!(
                    "timed out acquiring subagent folder lock for user {} and folder '{}'",
                    user_id,
                    folder_name
                );
            }
            tokio::time::sleep(std::time::Duration::from_millis(
                SUBAGENT_FOLDER_LOCK_POLL_INTERVAL_MILLIS,
            ))
            .await;
        }
    }

    fn release(&mut self) {
        if self.released {
            return;
        }
        let _ = redis_compare_delete(&self.key, &self.token);
        self.released = true;
    }
}

impl Drop for SubagentFolderLockGuard {
    fn drop(&mut self) {
        self.release();
    }
}

async fn with_subagent_folder_lock<F, Fut, T>(
    user_id: &str,
    folder_name: &str,
    operation: F,
) -> Result<T>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    let _guard = SubagentFolderLockGuard::acquire(user_id, folder_name).await?;
    operation().await
}

async fn ensure_named_folder_for_user(
    token: &str,
    user_id: &str,
    folder_name: &str,
) -> Result<String> {
    let folder_name = effective_subagent_folder_name(Some(folder_name));
    with_subagent_folder_lock(user_id, &folder_name, || async {
        ensure_named_folder_locked(token, &folder_name).await
    })
    .await
    .with_context(|| format!("failed to ensure subagent folder '{folder_name}'"))
}

async fn ensure_named_folder_locked(token: &str, folder_name: &str) -> Result<String> {
    let folders = openwebui_get_json_retry("/api/v1/folders/", token).await?;
    if let Some(existing) = canonical_named_folder_id(&folders, folder_name) {
        return Ok(existing);
    }
    match openwebui_post_json_retry(
        "/api/v1/folders/",
        token,
        &json!({
            "name": folder_name,
            "data": { "system_prompt": "", "files": [] }
        }),
        30.0,
    )
    .await
    {
        Ok(created) => created
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .with_context(|| format!("{folder_name} folder creation response missing id")),
        Err(create_error) => {
            let folders = openwebui_get_json_retry("/api/v1/folders/", token)
                .await
                .with_context(|| {
                    format!("failed to list folders after create attempt for '{folder_name}'")
                })?;
            if let Some(existing) = canonical_named_folder_id(&folders, folder_name) {
                return Ok(existing);
            }
            Err(create_error)
        }
    }
}

fn canonical_subagents_folder_id(folders: &Value) -> Option<String> {
    canonical_named_folder_id(folders, DEFAULT_SUBAGENT_FOLDER_NAME)
}

fn canonical_named_folder_id(folders: &Value, folder_name: &str) -> Option<String> {
    let mut candidates: Vec<_> = folders
        .as_array()?
        .iter()
        .filter_map(|folder| named_folder_candidate(folder, folder_name))
        .collect();
    candidates.sort_by(compare_named_folder_candidates);
    candidates.first().map(|candidate| candidate.id.to_string())
}

fn subagents_folder_candidate(folder: &Value) -> Option<SubagentsFolderCandidate<'_>> {
    named_folder_candidate(folder, DEFAULT_SUBAGENT_FOLDER_NAME)
}

fn named_folder_candidate<'a>(
    folder: &'a Value,
    folder_name: &str,
) -> Option<SubagentsFolderCandidate<'a>> {
    if folder.get("name").and_then(Value::as_str) != Some(folder_name) {
        return None;
    }

    Some(SubagentsFolderCandidate {
        id: folder.get("id").and_then(Value::as_str)?,
        is_root_level: subagents_folder_is_root_level(folder),
        created_at: folder.get("created_at").and_then(parse_folder_created_at),
    })
}

fn subagents_folder_is_root_level(folder: &Value) -> bool {
    match folder.get("parent_id") {
        None | Some(Value::Null) => true,
        Some(Value::String(parent_id)) => parent_id.trim().is_empty(),
        Some(_) => false,
    }
}

fn parse_folder_created_at(value: &Value) -> Option<f64> {
    value.as_f64().or_else(|| {
        value
            .as_str()
            .and_then(|timestamp| timestamp.parse::<f64>().ok())
    })
}

fn compare_subagents_folder_candidates(
    left: &SubagentsFolderCandidate<'_>,
    right: &SubagentsFolderCandidate<'_>,
) -> Ordering {
    compare_named_folder_candidates(left, right)
}

fn compare_named_folder_candidates(
    left: &SubagentsFolderCandidate<'_>,
    right: &SubagentsFolderCandidate<'_>,
) -> Ordering {
    match (left.is_root_level, right.is_root_level) {
        (true, false) => return Ordering::Less,
        (false, true) => return Ordering::Greater,
        _ => {}
    }

    if let (Some(left_created_at), Some(right_created_at)) = (left.created_at, right.created_at) {
        let ordering = left_created_at.total_cmp(&right_created_at);
        if ordering != Ordering::Equal {
            return ordering;
        }
    }

    left.id.cmp(right.id)
}

async fn create_subagent_chat(
    token: &str,
    model: &str,
    content: &Value,
    folder_id: &str,
    chat_metadata: Option<&Value>,
    reasoning_effort: Option<&str>,
) -> Result<(String, String, i64)> {
    let user_message_id = Uuid::new_v4().to_string();
    let timestamp = now_epoch_seconds() as i64;
    let display_content = display_content_for_chat(content);
    // Persist the effort on the chat's own params so a delegated view (which
    // loads the chat object) can show the effort the subagent used, even when
    // the chat-state-api read is blocked by service ownership.
    let params = match reasoning_effort {
        Some(effort) if !effort.trim().is_empty() => json!({ "reasoning_effort": effort }),
        _ => json!({}),
    };
    // ``chat.meta`` is the OWUI-side bag of opaque trust-boundary
    // metadata. The scheduling daemon stamps it with run_origin /
    // task_id / run_id / approved_scope so the per-action confirmation
    // gate (N-012) can recognise a scheduled-run sub-agent chat and
    // bypass chips for in-scope tools. Other callers may leave it
    // empty (``None``); the chat then has no scheduled-run binding
    // and behaves like an ordinary user-driven chat.
    let mut chat_object = json!({
        "id": "",
        "title": "Sub-Agent Task",
        "models": [model],
        "params": params,
        "history": {
            "messages": {
                user_message_id.clone(): {
                    "id": user_message_id.clone(),
                    "parentId": Value::Null,
                    "childrenIds": [],
                    "role": "user",
                    "content": display_content.clone(),
                    "timestamp": timestamp,
                    "models": [model]
                }
            },
            "currentId": user_message_id.clone()
        },
        "messages": [{
            "id": user_message_id.clone(),
            "parentId": Value::Null,
            "childrenIds": [],
            "role": "user",
            "content": display_content,
            "timestamp": timestamp,
            "models": [model]
        }],
        "tags": [],
        "timestamp": timestamp * 1000
    });
    if let Some(metadata) = chat_metadata {
        if let Some(map) = chat_object.as_object_mut() {
            map.insert("meta".to_string(), metadata.clone());
        }
    }
    let payload = json!({
        "chat": chat_object,
        "folder_id": folder_id
    });
    let chat = openwebui_post_json_retry("/api/v1/chats/new", token, &payload, 30.0).await?;
    Ok((
        chat.get("id")
            .and_then(Value::as_str)
            .context("chat creation response missing id")?
            .to_string(),
        user_message_id,
        timestamp,
    ))
}

fn completed_message_payload(chat_data: &Value, message: Option<&Value>) -> Option<Value> {
    let last = message.filter(|item| message_is_complete(item))?;
    Some(json!({
        "model": chat_data
            .get("chat")
            .and_then(|value| value.get("models"))
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .cloned()
            .unwrap_or(Value::Null),
        "response": last
            .get("lastSentence")
            .or_else(|| last.get("content"))
            .cloned()
            .unwrap_or(Value::String(String::new())),
        "success": true,
        "chat_data": chat_data,
    }))
}

async fn poll_subagent_completion(
    token: &str,
    chat_id: &str,
    model: &str,
    reasoning_effort: Option<&str>,
) -> Result<Value> {
    poll_subagent_completion_with_timeout(
        token,
        chat_id,
        model,
        reasoning_effort,
        std::time::Duration::from_secs(SUBAGENT_RUN_TIMEOUT_SECONDS),
        std::time::Duration::from_secs(POLL_INTERVAL_SECONDS),
    )
    .await
}

async fn poll_subagent_completion_with_timeout(
    token: &str,
    chat_id: &str,
    model: &str,
    reasoning_effort: Option<&str>,
    timeout: std::time::Duration,
    poll_interval: std::time::Duration,
) -> Result<Value> {
    let started = std::time::Instant::now();
    loop {
        if redis_get_string(&format!("subagent_cancel:{chat_id}"))?.is_some() {
            redis_delete(&format!("subagent_cancel:{chat_id}"))?;
            bail!("Parent task cancelled");
        }
        let chat_data = match openwebui_get_json(&format!("/api/v1/chats/{chat_id}"), token).await {
            Ok(value) => value,
            Err(error) => {
                if started.elapsed() >= timeout {
                    return Err(error);
                }
                warn!(
                    chat_id = %chat_id,
                    error = %error,
                    "Subagent chat poll read failed; retrying until completion timeout",
                );
                tokio::time::sleep(poll_interval).await;
                continue;
            }
        };
        let history_messages = chat_data
            .get("chat")
            .and_then(|value| value.get("history"))
            .and_then(|value| value.get("messages"))
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let max_context_tokens = max_context_tokens_for_model(model);
        let context_tokens = normalize_context_tokens_for_window(
            extract_usage_from_chat(&chat_data),
            max_context_tokens,
        );
        if !cfg!(test) {
            save_chat_state(
                chat_id,
                context_tokens,
                max_context_tokens,
                reasoning_effort,
                Some(model),
                token,
            )
            .await;
        }
        for message in history_messages.values() {
            let Some(error_data) = message.get("error") else {
                continue;
            };
            let error_message = extract_error_message(error_data);
            if is_context_window_error(&error_message) {
                return Ok(json!({
                    "model": chat_data
                        .get("chat")
                        .and_then(|value| value.get("models"))
                        .and_then(Value::as_array)
                        .and_then(|items| items.first())
                        .cloned()
                        .unwrap_or(Value::Null),
                    "response": message.get("content").cloned().unwrap_or(Value::String(String::new())),
                    "success": false,
                    "error": "Sub-agent exceeded its context window but generated a partial response.",
                    "chat_data": chat_data,
                }));
            }
            if is_transient_upstream_model_failure(&error_message) {
                return Ok(json!({
                    "model": chat_data
                        .get("chat")
                        .and_then(|value| value.get("models"))
                        .and_then(Value::as_array)
                        .and_then(|items| items.first())
                        .cloned()
                        .unwrap_or(Value::Null),
                    "response": message.get("content").cloned().unwrap_or(Value::String(String::new())),
                    "success": false,
                    "error": format!("Transient sub-agent completion failure: {error_message}"),
                    "transient_upstream_failure": true,
                    "chat_data": chat_data,
                }));
            }
            bail!("Chat completion failed: {}", error_message);
        }
        if let Some((_, assistant)) = history_messages
            .iter()
            .find(|(_, message)| message_is_complete(message))
        {
            return Ok(json!({
                "model": chat_data
                    .get("chat")
                    .and_then(|value| value.get("models"))
                    .and_then(Value::as_array)
                    .and_then(|items| items.first())
                    .cloned()
                    .unwrap_or(Value::Null),
                "response": assistant
                    .get("lastSentence")
                    .or_else(|| assistant.get("content"))
                    .cloned()
                    .unwrap_or(Value::String(String::new())),
                "success": true,
                "chat_data": chat_data,
            }));
        }
        let messages = chat_data
            .get("chat")
            .and_then(|value| value.get("messages"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if let Some(payload) = completed_message_payload(&chat_data, messages.last()) {
            return Ok(payload);
        }
        if started.elapsed() >= timeout {
            bail!("Chat did not complete within {:?}", timeout);
        }
        tokio::time::sleep(poll_interval).await;
    }
}

#[cfg(test)]
#[path = "subagents_tests.rs"]
mod tests;
