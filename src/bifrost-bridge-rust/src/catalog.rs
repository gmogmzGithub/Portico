use crate::provider_headers::{
    bifrost_logging_headers_json, bifrost_required_headers_json, ProviderHeaderTemplate,
};
use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use serde_yaml::{Mapping, Value as YamlValue};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

const DEFAULT_PROVIDER_REQUEST_TIMEOUT_SECONDS: u64 = 900;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProviderKind {
    OpenAI,
    AnthropicConverse,
    GeminiVertex,
}

#[derive(Clone, Debug)]
pub struct ModelEntry {
    pub alias: String,
    pub base_model: String,
    pub provider_model: String,
    pub bifrost_model: String,
    pub provider_kind: ProviderKind,
    pub uses_responses_api: bool,
    pub max_output_tokens: Option<i64>,
    pub prompt_cache_retention: Option<String>,
    pub claude_prompt_cache_ttl: Option<String>,
    /// Per-alias opt-in for bridge-side tool-spec slimming (Claude/Gemini).
    /// `BRIDGE_TOOL_SLIMMING` overrides fleet-wide; default false (dark).
    pub tool_slimming: bool,
}

#[derive(Clone, Debug)]
pub struct Catalog {
    pub entries: HashMap<String, ModelEntry>,
    pub ordered_entries: Vec<ModelEntry>,
    pub bifrost_config: JsonValue,
    pub provider_headers: ProviderHeaderTemplate,
}

#[derive(Debug, Serialize)]
struct ModelKey {
    name: String,
    value: String,
    models: Vec<String>,
    weight: f64,
}

fn yaml_str<'a>(mapping: &'a Mapping, key: &str) -> Option<&'a str> {
    mapping
        .get(YamlValue::String(key.to_string()))
        .and_then(YamlValue::as_str)
}

fn yaml_mapping<'a>(mapping: &'a Mapping, key: &str) -> Option<&'a Mapping> {
    mapping
        .get(YamlValue::String(key.to_string()))
        .and_then(YamlValue::as_mapping)
}

fn yaml_sequence<'a>(mapping: &'a Mapping, key: &str) -> Option<&'a Vec<YamlValue>> {
    mapping
        .get(YamlValue::String(key.to_string()))
        .and_then(YamlValue::as_sequence)
}

fn yaml_bool(mapping: &Mapping, key: &str) -> Option<bool> {
    mapping
        .get(YamlValue::String(key.to_string()))
        .and_then(YamlValue::as_bool)
}

#[cfg(test)]
fn resolve_env_string(value: &str) -> String {
    if let Some(stripped) = value.strip_prefix("os.environ/") {
        return format!("env.{stripped}");
    }
    value.to_string()
}

fn normalize_openai_base_url(value: &str) -> String {
    value
        .trim_end_matches('/')
        .trim_end_matches("/v1")
        .trim_end_matches('/')
        .to_string()
}

fn push_unique_model(models: &mut Vec<String>, model: String) {
    if !models.contains(&model) {
        models.push(model);
    }
}

#[cfg(test)]
fn yaml_mapping_to_json(mapping: &Mapping) -> JsonValue {
    JsonValue::Object(
        mapping
            .iter()
            .filter_map(|(key, value)| {
                key.as_str()
                    .map(|key_str| (key_str.to_string(), yaml_value_to_json(value)))
            })
            .collect(),
    )
}

#[cfg(test)]
fn yaml_value_to_json(value: &YamlValue) -> JsonValue {
    match value {
        YamlValue::Bool(v) => JsonValue::Bool(*v),
        YamlValue::Number(v) => serde_json::to_value(v).unwrap_or(JsonValue::Null),
        YamlValue::String(v) => JsonValue::String(resolve_env_string(v)),
        YamlValue::Sequence(items) => {
            JsonValue::Array(items.iter().map(yaml_value_to_json).collect())
        }
        YamlValue::Mapping(mapping) => yaml_mapping_to_json(mapping),
        _ => JsonValue::Null,
    }
}

pub fn load_catalog(config_path: &Path, bridge_base_url: &str) -> Result<Catalog> {
    let raw = fs::read_to_string(config_path)
        .with_context(|| format!("failed to read {}", config_path.display()))?;
    let mut root: YamlValue =
        serde_yaml::from_str(&raw).context("failed to parse model_catalog.yaml")?;
    root.apply_merge()
        .context("failed to resolve YAML merge keys in model_catalog.yaml")?;

    let root_mapping = root
        .as_mapping()
        .ok_or_else(|| anyhow!("model_catalog.yaml root is not a mapping"))?;
    let model_list = yaml_sequence(root_mapping, "model_list")
        .ok_or_else(|| anyhow!("model_catalog.yaml is missing model_list"))?;

    let mut entries = HashMap::new();
    let mut ordered_entries = Vec::new();

    let mut openai_models = Vec::new();
    let mut openai_api_base: Option<String> = None;
    let mut anthropic_models = Vec::new();
    let mut gemini_vertex_models = Vec::new();
    let mut provider_headers: Option<(String, ProviderHeaderTemplate)> = None;

    for item in model_list {
        let item_mapping = item
            .as_mapping()
            .ok_or_else(|| anyhow!("model_list entries must be mappings"))?;
        let alias = yaml_str(item_mapping, "model_name")
            .ok_or_else(|| anyhow!("model entry is missing model_name"))?
            .to_string();
        let params = yaml_mapping(item_mapping, "litellm_params")
            .ok_or_else(|| anyhow!("model {alias} is missing litellm_params"))?;
        let raw_model = yaml_str(params, "model")
            .ok_or_else(|| anyhow!("model {alias} is missing litellm_params.model"))?;

        let uses_responses_api = raw_model.starts_with("openai/responses/");

        let (provider_kind, base_model, provider_name) =
            if let Some(stripped) = raw_model.strip_prefix("bedrock/converse_like/") {
                (
                    ProviderKind::AnthropicConverse,
                    stripped.to_string(),
                    "anthropic".to_string(),
                )
            } else if let Some(stripped) = raw_model.strip_prefix("openai/responses/") {
                (
                    ProviderKind::OpenAI,
                    stripped.to_string(),
                    "openai".to_string(),
                )
            } else if let Some(stripped) = raw_model.strip_prefix("gemini/vertex/") {
                (
                    ProviderKind::GeminiVertex,
                    stripped.to_string(),
                    "gemini".to_string(),
                )
            } else {
                (
                    ProviderKind::OpenAI,
                    raw_model.to_string(),
                    "openai".to_string(),
                )
            };

        let provider_model = match (provider_kind.clone(), base_model.as_str()) {
            (ProviderKind::OpenAI, "gpt-5.6-sol-pro") => "gpt-5.6-sol".to_string(),
            _ => base_model.clone(),
        };
        let bifrost_model = format!("{provider_name}/{provider_model}");
        let prompt_cache_retention = yaml_str(params, "prompt_cache_retention").map(str::to_string);
        let claude_prompt_cache_ttl = yaml_str(params, "claude_prompt_cache_ttl")
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let tool_slimming = yaml_bool(params, "tool_slimming").unwrap_or(false);
        let max_output_tokens = yaml_mapping(item_mapping, "model_info").and_then(|model_info| {
            model_info
                .get(YamlValue::String("max_output_tokens".to_string()))
                .and_then(YamlValue::as_i64)
        });
        let item_headers = yaml_mapping(params, "extra_headers")
            .ok_or_else(|| anyhow!("model {alias} is missing litellm_params.extra_headers"))?;
        let item_headers = ProviderHeaderTemplate::from_yaml_mapping(item_headers)
            .with_context(|| format!("model {alias} has invalid litellm_params.extra_headers"))?;

        if let Some((existing_alias, existing_headers)) = &provider_headers {
            let mismatches = existing_headers.mismatch_fields(&item_headers);
            if !mismatches.is_empty() {
                return Err(anyhow!(
                    "model {alias} has inconsistent litellm_params.extra_headers compared with {existing_alias}: {}",
                    mismatches.join(", ")
                ));
            }
        } else {
            provider_headers = Some((alias.clone(), item_headers.clone()));
        }

        match provider_kind {
            ProviderKind::OpenAI => {
                push_unique_model(&mut openai_models, provider_model.clone());
                if openai_api_base.is_none() {
                    openai_api_base = yaml_str(params, "api_base").map(str::to_string);
                }
            }
            ProviderKind::AnthropicConverse => {
                push_unique_model(&mut anthropic_models, base_model.clone());
            }
            ProviderKind::GeminiVertex => {
                push_unique_model(&mut gemini_vertex_models, provider_model.clone());
            }
        }

        let entry = ModelEntry {
            alias: alias.clone(),
            base_model,
            provider_model,
            bifrost_model,
            provider_kind,
            uses_responses_api,
            max_output_tokens,
            prompt_cache_retention,
            claude_prompt_cache_ttl,
            tool_slimming,
        };
        if entries.insert(alias.clone(), entry.clone()).is_some() {
            return Err(anyhow!(
                "model_catalog.yaml contains duplicate model_name {alias}"
            ));
        }
        ordered_entries.push(entry);
    }

    let openai_api_base = normalize_openai_base_url(
        &openai_api_base
            .unwrap_or_else(|| "https://api.openai.com/v1".to_string()),
    );
    let provider_headers = provider_headers
        .map(|(_, headers)| headers)
        .ok_or_else(|| anyhow!("model_catalog.yaml is missing litellm_params.extra_headers"))?;
    let resolved_provider_headers = provider_headers.resolve()?;
    let bridge_base_url = bridge_base_url.trim_end_matches('/').to_string();

    let bifrost_config = json!({
        "$schema": "https://www.getbifrost.ai/schema",
        "client": {
            "enable_logging": true,
            "disable_content_logging": true,
            "allow_direct_keys": false,
            "required_headers": bifrost_required_headers_json(),
            "logging_headers": bifrost_logging_headers_json()
        },
        "governance": {},
        "config_store": {
            "enabled": true,
            "type": "sqlite",
            "config": {
                "path": "/app/data/config.db"
            }
        },
        "providers": {
            "openai": {
                "keys": [
                    ModelKey {
                        name: "openai-compatible".to_string(),
                        value: "env.PORTICO_LLM_API_KEY".to_string(),
                        models: openai_models,
                        weight: 1.0
                    }
                ],
                "network_config": {
                    "base_url": openai_api_base,
                    "extra_headers": resolved_provider_headers.to_bifrost_json(),
                    "default_request_timeout_in_seconds": 300,
                    "max_retries": 1
                },
                "custom_provider_config": {
                    "base_provider_type": "openai",
                    "allowed_requests": {
                        "list_models": true,
                        "chat_completion": true,
                        "chat_completion_stream": true,
                        "responses": true,
                        "responses_stream": true,
                        "embedding": true
                    }
                }
            },
            "anthropic": {
                "keys": [
                    ModelKey {
                        name: "bedrock-converse-shim".to_string(),
                        value: "shim-not-used".to_string(),
                        models: anthropic_models,
                        weight: 1.0
                    }
                ],
                "network_config": {
                    "base_url": format!("{bridge_base_url}/internal/anthropic"),
                    "default_request_timeout_in_seconds": DEFAULT_PROVIDER_REQUEST_TIMEOUT_SECONDS,
                    "max_retries": 0
                },
                "custom_provider_config": {
                    "base_provider_type": "anthropic",
                    "allowed_requests": {
                        "chat_completion": true,
                        "chat_completion_stream": true
                    }
                }
            },
            "gemini": {
                "keys": [
                    ModelKey {
                        name: "gemini-vertex-shim".to_string(),
                        value: "shim-not-used".to_string(),
                        models: gemini_vertex_models,
                        weight: 1.0
                    }
                ],
                "network_config": {
                    "base_url": format!("{bridge_base_url}/internal/gemini/v1beta1/publishers/google"),
                    "extra_headers": resolved_provider_headers.to_bifrost_json(),
                    "default_request_timeout_in_seconds": DEFAULT_PROVIDER_REQUEST_TIMEOUT_SECONDS,
                    "max_retries": 0
                },
                "custom_provider_config": {
                    "base_provider_type": "gemini",
                    "allowed_requests": {
                        "chat_completion": true,
                        "chat_completion_stream": true
                    }
                }
            }
        }
    });

    Ok(Catalog {
        entries,
        ordered_entries,
        bifrost_config,
        provider_headers,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn with_portico_env(test: impl FnOnce()) {
        let _guard = crate::provider_headers::test_env_lock().lock().unwrap();
        let previous_user_id = std::env::var("PORTICO_USER_ID").ok();
        let previous_redact_allow = std::env::var("PORTICO_REDACT_ALLOW").ok();
        let previous_build_track = std::env::var("PORTICO_BUILD_TRACK").ok();

        std::env::set_var("PORTICO_USER_ID", "user");
        std::env::set_var("PORTICO_REDACT_ALLOW", "*");
        std::env::set_var("PORTICO_BUILD_TRACK", "dev-build");

        test();

        restore_env("PORTICO_USER_ID", previous_user_id);
        restore_env("PORTICO_REDACT_ALLOW", previous_redact_allow);
        restore_env("PORTICO_BUILD_TRACK", previous_build_track);
    }

    fn restore_env(name: &str, previous: Option<String>) {
        if let Some(value) = previous {
            std::env::set_var(name, value);
        } else {
            std::env::remove_var(name);
        }
    }

    fn temp_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("bifrost-bridge-{name}-{}.yaml", Uuid::new_v4()))
    }

    fn write_temp_config(contents: &str) -> std::path::PathBuf {
        let path = temp_path("catalog");
        fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn yaml_helpers_and_env_resolution_work() {
        let mapping: Mapping = serde_yaml::from_str(
            r#"
foo: bar
nested:
  value: baz
items:
  - one
  - two
num: 3
flag: true
env: os.environ/SECRET
"#,
        )
        .unwrap();

        assert_eq!(yaml_str(&mapping, "foo"), Some("bar"));
        assert!(yaml_mapping(&mapping, "nested").is_some());
        assert_eq!(yaml_sequence(&mapping, "items").unwrap().len(), 2);
        assert_eq!(resolve_env_string("os.environ/SECRET"), "env.SECRET");
        assert_eq!(resolve_env_string("literal"), "literal");
        assert_eq!(
            normalize_openai_base_url("https://example.com/openai/v1/"),
            "https://example.com/openai"
        );

        let json_value = yaml_mapping_to_json(&mapping);
        assert_eq!(json_value["num"], json!(3));
        assert_eq!(json_value["flag"], json!(true));
        assert_eq!(json_value["env"], json!("env.SECRET"));

        let mut numeric_key_mapping = Mapping::new();
        numeric_key_mapping.insert(
            YamlValue::Number(1.into()),
            YamlValue::String("skip".to_string()),
        );
        numeric_key_mapping.insert(
            YamlValue::String("keep".to_string()),
            YamlValue::String("value".to_string()),
        );
        assert_eq!(
            yaml_mapping_to_json(&numeric_key_mapping),
            json!({"keep":"value"})
        );
    }

    #[test]
    fn yaml_value_to_json_covers_u64_f64_and_null_variants() {
        let mapping: Mapping = serde_yaml::from_str(
            r#"
big: 18446744073709551615
floaty: 1.5
missing: null
"#,
        )
        .unwrap();

        assert_eq!(
            yaml_value_to_json(mapping.get(YamlValue::String("big".to_string())).unwrap()),
            json!(18446744073709551615_u64)
        );
        assert_eq!(
            yaml_value_to_json(
                mapping
                    .get(YamlValue::String("floaty".to_string()))
                    .unwrap()
            ),
            json!(1.5)
        );
        assert_eq!(
            yaml_value_to_json(
                mapping
                    .get(YamlValue::String("missing".to_string()))
                    .unwrap()
            ),
            JsonValue::Null
        );
    }

    #[test]
    fn load_catalog_builds_expected_provider_configs() {
        with_portico_env(|| {
            let path = write_temp_config(
                r#"
x-headers: &headers
  x-portico-userid: os.environ/PORTICO_USER_ID
  x-portico-redact-allow: os.environ/PORTICO_REDACT_ALLOW
  x-portico-appid: portico
  x-portico-track: dev
  x-portico-log-request: "false"
  x-portico-log-response: "false"
  Content-Type: application/json
model_list:
  - model_name: Claude Sonnet 4.5
    litellm_params:
      model: bedrock/converse_like/us.anthropic.claude-sonnet-4-5-20250929-v1:0
      api_base: https://api.anthropic.com/v1
      extra_headers: *headers
    model_info:
      max_output_tokens: 64000
  - model_name: Claude Opus 4.8
    litellm_params:
      model: bedrock/converse_like/us.anthropic.claude-opus-4-8
      api_base: https://api.anthropic.com/v1
      extra_headers: *headers
      claude_prompt_cache_ttl: 1h
      tool_slimming: true
    model_info:
      max_output_tokens: 128000
  - model_name: GPT-5.6 Sol
    litellm_params:
      model: openai/responses/gpt-5.6-sol
      api_base: https://api.openai.com/v1
      extra_headers: *headers
      prompt_cache_retention: 24h
    model_info:
      max_output_tokens: 128000
  - model_name: GPT-5.6 Sol Pro
    litellm_params:
      model: openai/responses/gpt-5.6-sol-pro
      api_base: https://api.openai.com/v1
      extra_headers: *headers
      prompt_cache_retention: 24h
    model_info:
      max_output_tokens: 128000
  - model_name: Gemini 3.5 Flash
    litellm_params:
      model: gemini/vertex/gemini-3.5-flash
      api_base: https://generativelanguage.googleapis.com/v1beta
      api_key: os.environ/PORTICO_LLM_API_KEY
      extra_headers: *headers
    model_info:
      max_output_tokens: 65536
"#,
            );

            let catalog = load_catalog(&path, "http://llm-gateway:4000").unwrap();
            let claude = catalog.entries.get("Claude Sonnet 4.5").unwrap();
            assert_eq!(claude.provider_kind, ProviderKind::AnthropicConverse);
            assert_eq!(
                claude.bifrost_model,
                "anthropic/us.anthropic.claude-sonnet-4-5-20250929-v1:0"
            );
            assert_eq!(claude.claude_prompt_cache_ttl, None);
            assert!(!claude.tool_slimming, "tool_slimming must default to false");

            let opus_48 = catalog.entries.get("Claude Opus 4.8").unwrap();
            assert_eq!(opus_48.provider_kind, ProviderKind::AnthropicConverse);
            assert_eq!(opus_48.claude_prompt_cache_ttl.as_deref(), Some("1h"));
            assert!(opus_48.tool_slimming, "tool_slimming: true must parse");

            let gpt_sol = catalog.entries.get("GPT-5.6 Sol").unwrap();
            assert_eq!(gpt_sol.base_model, "gpt-5.6-sol");
            assert_eq!(gpt_sol.provider_model, "gpt-5.6-sol");
            assert_eq!(gpt_sol.bifrost_model, "openai/gpt-5.6-sol");

            let gpt = catalog.entries.get("GPT-5.6 Sol Pro").unwrap();
            assert_eq!(gpt.provider_kind, ProviderKind::OpenAI);
            assert_eq!(gpt.base_model, "gpt-5.6-sol-pro");
            assert!(gpt.uses_responses_api);
            assert_eq!(gpt.bifrost_model, "openai/gpt-5.6-sol");
            assert_eq!(gpt.prompt_cache_retention.as_deref(), Some("24h"));
            assert_eq!(gpt.max_output_tokens, Some(128000));

            let gemini = catalog.entries.get("Gemini 3.5 Flash").unwrap();
            assert_eq!(gemini.provider_kind, ProviderKind::GeminiVertex);
            assert_eq!(gemini.base_model, "gemini-3.5-flash");
            assert_eq!(gemini.provider_model, "gemini-3.5-flash");
            assert_eq!(
                gemini.bifrost_model,
                "gemini/gemini-3.5-flash"
            );
            assert!(!gemini.uses_responses_api);
            assert_eq!(gemini.max_output_tokens, Some(65536));

            let config = &catalog.bifrost_config;
            assert_eq!(config["client"]["enable_logging"], json!(true));
            assert_eq!(
                config["client"]["required_headers"],
                bifrost_required_headers_json()
            );
            assert_eq!(
                config["client"]["logging_headers"],
                bifrost_logging_headers_json()
            );
            assert_eq!(
                config["providers"]["openai"]["network_config"]["base_url"],
                json!("https://api.openai.com/v1")
            );
            assert_eq!(
                config["providers"]["anthropic"]["network_config"]["base_url"],
                json!("http://llm-gateway:4000/internal/anthropic")
            );
            assert_eq!(
                config["providers"]["gemini"]["network_config"]["base_url"],
                json!("http://llm-gateway:4000/internal/gemini/v1beta1/publishers/google")
            );
            assert_eq!(
                config["providers"]["gemini"]["custom_provider_config"]
                    ["base_provider_type"],
                json!("gemini")
            );
            assert_eq!(
                config["providers"]["anthropic"]["network_config"]
                    ["default_request_timeout_in_seconds"],
                json!(DEFAULT_PROVIDER_REQUEST_TIMEOUT_SECONDS)
            );
            assert_eq!(config["governance"], json!({}));
            assert_eq!(config["config_store"]["enabled"], json!(true));
            assert_eq!(config["config_store"]["type"], json!("sqlite"));
            assert_eq!(
                config["config_store"]["config"]["path"],
                json!("/app/data/config.db")
            );
            assert_eq!(
                config["providers"]["openai"]["keys"][0]["models"],
                json!(["gpt-5.6-sol"])
            );
            assert_eq!(
                config["providers"]["gemini"]["keys"][0]["models"],
                json!(["gemini-3.5-flash"])
            );
            assert_eq!(
                config["providers"]["gemini"]["keys"][0]["value"],
                json!("shim-not-used")
            );
            assert_ne!(
                config["providers"]["gemini"]["keys"][0]["value"],
                json!("os.environ/PORTICO_LLM_API_KEY")
            );
            assert_eq!(
                config["providers"]["openai"]["network_config"]["extra_headers"]
                    ["x-portico-userid"],
                json!("user")
            );
            assert_eq!(
                config["providers"]["openai"]["network_config"]["extra_headers"]
                    ["x-portico-redact-allow"],
                json!("*")
            );
            assert_eq!(
                config["providers"]["openai"]["network_config"]["extra_headers"]
                    ["x-portico-track"],
                json!("dev")
            );
            assert_eq!(
                config["providers"]["openai"]["network_config"]["extra_headers"]
                    ["content-type"],
                json!("application/json")
            );
            assert_eq!(catalog.provider_headers.app_id, "portico");
            assert_eq!(catalog.entries.len(), 5);
            assert_eq!(catalog.ordered_entries.len(), 5);

            fs::remove_file(path).ok();
        });
    }

    #[test]
    fn load_catalog_supports_plain_openai_models_and_delayed_headers() {
        with_portico_env(|| {
            let path = write_temp_config(
                r#"
x-headers: &headers
  x-portico-userid: os.environ/PORTICO_USER_ID
  x-portico-redact-allow: os.environ/PORTICO_REDACT_ALLOW
  x-portico-appid: portico
  x-portico-track: os.environ/PORTICO_BUILD_TRACK
  x-portico-log-request: "false"
  x-portico-log-response: "false"
  Content-Type: application/json
model_list:
  - model_name: GPT-4.1
    litellm_params:
      model: gpt-4.1
      api_base: https://api.openai.com/v1
      extra_headers: *headers
  - model_name: GPT-5.5
    litellm_params:
      model: openai/responses/gpt-5.5
      api_base: https://api.openai.com/v1
      extra_headers: *headers
  - model_name: GPT-5.4
    litellm_params:
      model: openai/responses/gpt-5.4
      api_base: https://api.openai.com/v1
      extra_headers: *headers
  - model_name: GPT-4.1 mini
    litellm_params:
      model: gpt-4.1-mini
      api_base: https://api.openai.com/v1
      extra_headers: *headers
"#,
            );

            let catalog = load_catalog(&path, "http://llm-gateway:4000").unwrap();
            let gpt = catalog.entries.get("GPT-4.1").unwrap();
            assert_eq!(gpt.provider_kind, ProviderKind::OpenAI);
            assert_eq!(gpt.base_model, "gpt-4.1");
            assert!(!gpt.uses_responses_api);
            assert_eq!(gpt.bifrost_model, "openai/gpt-4.1");
            let gpt55 = catalog.entries.get("GPT-5.5").unwrap();
            assert_eq!(gpt55.base_model, "gpt-5.5");
            assert!(gpt55.uses_responses_api);
            assert_eq!(gpt55.bifrost_model, "openai/gpt-5.5");
            let gpt54 = catalog.entries.get("GPT-5.4").unwrap();
            assert_eq!(gpt54.base_model, "gpt-5.4");
            assert!(gpt54.uses_responses_api);
            assert_eq!(gpt54.bifrost_model, "openai/gpt-5.4");

            assert_eq!(
                catalog.bifrost_config["providers"]["openai"]["network_config"]["base_url"],
                json!("https://api.openai.com/v1")
            );
            assert_eq!(
                catalog.bifrost_config["providers"]["openai"]["network_config"]
                    ["extra_headers"]["x-portico-userid"],
                json!("user")
            );
            assert_eq!(
                catalog.bifrost_config["providers"]["openai"]["network_config"]
                    ["extra_headers"]["x-portico-track"],
                json!("dev-build")
            );
            assert_eq!(
                catalog.bifrost_config["providers"]["openai"]["keys"][0]["models"],
                json!(["gpt-4.1", "gpt-5.5", "gpt-5.4", "gpt-4.1-mini"])
            );

            fs::remove_file(path).ok();
        });
    }

    #[test]
    fn load_catalog_rejects_invalid_shapes() {
        let missing_file = temp_path("missing");
        let err = load_catalog(&missing_file, "http://bridge").unwrap_err();
        assert!(err.to_string().contains("failed to read"));

        let missing_model_list = write_temp_config("foo: bar\n");
        let err = load_catalog(&missing_model_list, "http://bridge").unwrap_err();
        assert!(err.to_string().contains("model_list"));
        fs::remove_file(missing_model_list).ok();

        let bad_entry = write_temp_config(
            r#"
model_list:
  - nope
"#,
        );
        let err = load_catalog(&bad_entry, "http://bridge").unwrap_err();
        assert!(err.to_string().contains("mappings"));
        fs::remove_file(bad_entry).ok();

        let missing_model_name = write_temp_config(
            r#"
model_list:
  - litellm_params:
      model: gpt-4.1
"#,
        );
        let err = load_catalog(&missing_model_name, "http://bridge").unwrap_err();
        assert!(err.to_string().contains("model_name"));
        fs::remove_file(missing_model_name).ok();

        let missing_params = write_temp_config(
            r#"
model_list:
  - model_name: GPT-4.1
"#,
        );
        let err = load_catalog(&missing_params, "http://bridge").unwrap_err();
        assert!(err.to_string().contains("litellm_params"));
        fs::remove_file(missing_params).ok();

        let missing_model = write_temp_config(
            r#"
model_list:
  - model_name: GPT-4.1
    litellm_params: {}
"#,
        );
        let err = load_catalog(&missing_model, "http://bridge").unwrap_err();
        assert!(err.to_string().contains("litellm_params.model"));
        fs::remove_file(missing_model).ok();

        let root_not_mapping = write_temp_config("- item\n");
        let err = load_catalog(&root_not_mapping, "http://bridge").unwrap_err();
        assert!(err.to_string().contains("root is not a mapping"));
        fs::remove_file(root_not_mapping).ok();

        let invalid_yaml = write_temp_config("model_list: [\n");
        let err = load_catalog(&invalid_yaml, "http://bridge").unwrap_err();
        assert!(err.to_string().contains("failed to parse"));
        fs::remove_file(invalid_yaml).ok();
    }

    #[test]
    fn load_catalog_requires_provider_headers_for_every_model() {
        let path = write_temp_config(
            r#"
model_list:
  - model_name: GPT-4.1
    litellm_params:
      model: gpt-4.1
"#,
        );

        let err = load_catalog(&path, "http://bridge").unwrap_err();
        assert!(err
            .to_string()
            .contains("missing litellm_params.extra_headers"));

        fs::remove_file(path).ok();
    }

    #[test]
    fn load_catalog_rejects_inconsistent_provider_headers() {
        let path = write_temp_config(
            r#"
x-headers-a: &headers_a
  x-portico-userid: os.environ/PORTICO_USER_ID
  x-portico-redact-allow: os.environ/PORTICO_REDACT_ALLOW
  x-portico-appid: portico
  x-portico-track: dev-a
  x-portico-log-request: "false"
  x-portico-log-response: "false"
  Content-Type: application/json
x-headers-b: &headers_b
  x-portico-userid: os.environ/PORTICO_USER_ID
  x-portico-redact-allow: os.environ/PORTICO_REDACT_ALLOW
  x-portico-appid: portico
  x-portico-track: dev-b
  x-portico-log-request: "false"
  x-portico-log-response: "false"
  Content-Type: application/json
model_list:
  - model_name: GPT-4.1
    litellm_params:
      model: gpt-4.1
      extra_headers: *headers_a
  - model_name: GPT-4.1 mini
    litellm_params:
      model: gpt-4.1-mini
      extra_headers: *headers_b
"#,
        );

        let err = load_catalog(&path, "http://bridge").unwrap_err();
        assert!(err.to_string().contains("inconsistent"));
        assert!(err.to_string().contains("x-portico-track"));

        fs::remove_file(path).ok();
    }
}
