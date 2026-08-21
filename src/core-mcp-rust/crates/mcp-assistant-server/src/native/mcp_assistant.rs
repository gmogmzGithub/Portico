use super::*;
use futures_util::future::join_all;
#[path = "mcp_assistant_guidance.rs"]
mod guidance;
use guidance::{
    authorize_integration_guidance, guided_setup_guidance, single_server_restart_guidance,
    toggle_integration_next_steps, toggle_not_configured_guidance,
    toggle_saved_secret_unavailable_guidance,
};

const TOGGLE_ENABLE_WAIT_SECONDS: f64 = 30.0;
const TOGGLE_ENABLE_POLL_INTERVAL_SECONDS: f64 = ACTIVATION_POLL_INTERVAL_SECONDS;

fn core_chat_tool_ids() -> Vec<String> {
    vec![
        "server:mcp-assistant".to_string(),
        "server:subagents".to_string(),
    ]
}

fn is_core_chat_tool_id(tool_id: &str) -> bool {
    matches!(tool_id, "server:mcp-assistant" | "server:subagents")
}

fn dedupe_tool_server_ids<I>(tool_ids: I) -> Vec<String>
where
    I: IntoIterator<Item = String>,
{
    let mut seen = HashSet::new();
    let mut deduped = Vec::new();
    for tool_id in tool_ids {
        if seen.insert(tool_id.clone()) {
            deduped.push(tool_id);
        }
    }
    deduped
}

fn sanitize_chat_specific_tool_ids(tool_ids: Vec<String>) -> Vec<String> {
    dedupe_tool_server_ids(
        tool_ids
            .into_iter()
            .filter(|tool_id| !is_core_chat_tool_id(tool_id)),
    )
}

pub(super) async fn handle_list_mcp_servers(arguments: &Map<String, Value>) -> Result<Value> {
    let filter_type = arguments
        .get("filter")
        .and_then(Value::as_str)
        .unwrap_or("all");
    let include_disabled = arguments
        .get("include_disabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let mut servers = Vec::new();

    if matches!(filter_type, "all" | "system") {
        servers.extend(read_mcp_servers(false)?);
    }
    if matches!(filter_type, "all" | "user") {
        servers.extend(read_mcp_servers(true)?);
    }

    // PORTICO-410: hard-disabled servers are opaque to the model — omitted
    // unconditionally, regardless of the include_disabled flag.
    servers.retain(|server| {
        server
            .get("id")
            .and_then(Value::as_str)
            .map(|id| !is_server_hard_disabled(id))
            .unwrap_or(true)
    });

    if !include_disabled {
        servers.retain(|server| {
            server
                .get("id")
                .and_then(Value::as_str)
                .map(assistant_tool_server_enabled)
                .unwrap_or(false)
        });
    }

    let summary = json!({
        "total": servers.len(),
        "system": servers.iter().filter(|server| !server.get("user_installed").and_then(Value::as_bool).unwrap_or(false)).count(),
        "user": servers.iter().filter(|server| server.get("user_installed").and_then(Value::as_bool).unwrap_or(false)).count(),
        "core": servers.iter().filter(|server| server.get("is_core").and_then(Value::as_bool).unwrap_or(false)).count(),
    });

    success_text(json!({
        "servers": servers,
        "summary": summary,
    }))
}

fn read_mcp_servers(user_installed: bool) -> Result<Vec<Value>> {
    let base_dir = if user_installed {
        mcp_configs_user_dir()?
    } else {
        mcp_configs_dir()?
    };
    let system_base_dir = if user_installed {
        Some(mcp_configs_dir()?)
    } else {
        None
    };

    if !base_dir.exists() {
        return Ok(Vec::new());
    }

    let mut server_ids = fs::read_dir(&base_dir)
        .with_context(|| format!("failed to list {}", base_dir.display()))?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            entry
                .file_type()
                .ok()
                .filter(|kind| kind.is_dir())
                .map(|_| entry.file_name().to_string_lossy().to_string())
        })
        .collect::<Vec<_>>();
    server_ids.sort();

    let mut servers = Vec::new();
    for server_id in server_ids {
        if let Some(system_dir) = &system_base_dir {
            if system_dir.join(&server_id).is_dir() {
                warn!(
                    "ignoring user MCP config {} because the bundled namespace is reserved",
                    server_id
                );
                continue;
            }
        }
        let yaml_path = base_dir.join(&server_id).join(format!("{server_id}.yaml"));
        if !yaml_path.exists() {
            continue;
        }

        let yaml = match yaml_map(&yaml_path) {
            Ok(value) => value,
            Err(_) => {
                warn!("failed to read MCP config {}", yaml_path.display());
                continue;
            }
        };

        let oauth = yaml
            .get(&serde_yaml::Value::String("oauth".to_string()))
            .map(yaml_value_to_json)
            .unwrap_or(Value::Null);

        servers.push(json!({
            "id": server_id,
            "name": yaml_string(&yaml, "name").unwrap_or_else(|| server_id.clone()),
            "display_name": yaml_string(&yaml, "display_name").unwrap_or_else(|| server_id.clone()),
            "deployment_type": yaml_string(&yaml, "deployment_type").unwrap_or_else(|| "docker".to_string()),
            "is_core": yaml_bool(&yaml, "is_core").unwrap_or(false),
            "user_installed": user_installed,
            "description": yaml_string(&yaml, "description").unwrap_or_default(),
            "oauth": oauth,
        }));
    }

    Ok(servers)
}

fn ensure_system_server_id_immutable(server_id: &str, action: &str) -> Result<()> {
    let system_dir = system_server_path(server_id)?;
    if system_dir.exists() {
        bail!(
            "System-delivered MCP server '{}' is immutable and cannot be {} via MCP Assistant.",
            server_id,
            action
        );
    }
    Ok(())
}

pub(super) async fn handle_get_system_mcp_config(arguments: &Map<String, Value>) -> Result<Value> {
    let server_id = string_arg(arguments, "server_id")?;
    if is_server_hard_disabled(&server_id) {
        // PORTICO-410: truthful refusal for direct lookups of a hard-disabled
        // server — no config details, no enable guidance.
        bail!(
            "Integration '{}' was hard-disabled by the user and is unavailable. Do not attempt to enable it; only the user can re-enable it from the Control Plane.",
            server_id
        );
    }
    let yaml_path = system_server_path(&server_id)?.join(format!("{server_id}.yaml"));
    let yaml = read_json_compatible_yaml(&yaml_path)?;
    let fragment =
        read_json_file(&system_server_path(&server_id)?.join(format!("{server_id}.fragment")))?;
    success_text(json!({
        "server_id": server_id,
        "yaml_config": yaml,
        "fragment": fragment,
        "readonly": true,
        "note": "This is a system-delivered server and cannot be modified via MCP Assistant",
    }))
}

fn read_json_compatible_yaml(path: &Path) -> Result<Value> {
    let raw = fs::read_to_string(path)
        .with_context(|| format!("failed to read YAML file {}", path.display()))?;
    let yaml: serde_yaml::Value = serde_yaml::from_str(&raw)
        .with_context(|| format!("failed to parse YAML file {}", path.display()))?;
    serde_json::to_value(yaml).context("failed to convert YAML to JSON")
}

fn assistant_tool_server_enabled(server_id: &str) -> bool {
    let bare_id = bare_server_id(server_id);
    load_mcp_toggles().get(bare_id).copied().unwrap_or(true)
}

struct ElectronJsonResponse {
    status: reqwest::StatusCode,
    json: Option<Value>,
    body_text: String,
}

async fn electron_post_json_preserving_error_body(
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

async fn electron_get_json_preserving_error_body(
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

const HOST_MCP_BRIDGE_CALLER: &str = "portico_chat";
const HOST_MCP_BRIDGE_CLIENT_IDS: &[&str] =
    &["atlas-code", "atlas-desktop", "workbench", "cursor", "amp"];

fn optional_int_arg(arguments: &Map<String, Value>, keys: &[&str]) -> Option<i64> {
    for key in keys {
        if let Some(value) = arguments.get(*key) {
            if let Some(number) = value.as_i64() {
                return Some(number);
            }
            if let Some(text) = value.as_str().and_then(|text| text.trim().parse().ok()) {
                return Some(text);
            }
        }
    }
    None
}

fn bridge_timeout_seconds(arguments: &Map<String, Value>, default_ms: i64) -> f64 {
    let timeout_ms = optional_int_arg(arguments, &["timeout_ms", "timeoutMs"])
        .unwrap_or(default_ms)
        .clamp(1_000, 120_000);
    timeout_ms as f64 / 1000.0
}

fn requested_host_mcp_bridge_client_ids(arguments: &Map<String, Value>) -> Result<Vec<String>> {
    let mut client_ids = array_strings(arguments.get("client_ids"));
    if client_ids.is_empty() {
        client_ids = array_strings(arguments.get("clientIds"));
    }
    if client_ids.is_empty() {
        bail!(
            "client_ids is required. Call get_host_mcp_bridge_status first, confirm the exact supported client(s) with the user, then pass those client ids."
        );
    }

    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for client_id in client_ids {
        if !HOST_MCP_BRIDGE_CLIENT_IDS.contains(&client_id.as_str()) {
            bail!(
                "Unsupported Host MCP Bridge client '{}'. Supported clients are: {}",
                client_id,
                HOST_MCP_BRIDGE_CLIENT_IDS.join(", ")
            );
        }
        if seen.insert(client_id.clone()) {
            normalized.push(client_id);
        }
    }
    Ok(normalized)
}

fn bridge_api_transport_payload(action: &str, error: &reqwest::Error) -> Value {
    let error_message = if error.is_connect() {
        format!("Cannot connect to Electron app at {}", electron_api_base())
    } else if error.is_timeout() {
        format!("Host MCP Bridge {action} request timed out")
    } else {
        format!("Host MCP Bridge {action} request failed: {error}")
    };
    json!({
        "success": false,
        "bridgeReady": false,
        "scriptAction": "fallback_toolhive",
        "error": error_message,
        "next_steps": [
            "Make sure Portico is running, then retry.",
            "Rerun setup-community/run-mcp-servers to fall back or reselect the active MCP path."
        ],
    })
}

fn bridge_api_response_payload(response: ElectronJsonResponse, default_error: &str) -> Value {
    let mut payload = response.json.unwrap_or_else(|| {
        let body = response.body_text.trim();
        json!({
            "success": false,
            "error": if body.is_empty() {
                default_error.to_string()
            } else {
                body.to_string()
            },
        })
    });
    if let Some(object) = payload.as_object_mut() {
        object.insert(
            "httpStatus".to_string(),
            Value::from(response.status.as_u16()),
        );
        if !response.status.is_success() {
            object
                .entry("success".to_string())
                .or_insert(Value::Bool(false));
        }
        object
            .entry("caller".to_string())
            .or_insert(Value::String(HOST_MCP_BRIDGE_CALLER.to_string()));
    }
    payload
}

pub(super) async fn handle_get_host_mcp_bridge_status(
    arguments: &Map<String, Value>,
) -> Result<Value> {
    let response = electron_get_json_preserving_error_body(
        "/api/mcp/bridge/clients?caller=portico_chat",
        bridge_timeout_seconds(arguments, 10_000),
    )
    .await;

    let payload = match response {
        Ok(response) => {
            bridge_api_response_payload(response, "Host MCP Bridge status request failed")
        }
        Err(error) => bridge_api_transport_payload("status", &error),
    };
    success_text(payload)
}

pub(super) async fn handle_configure_host_mcp_bridge_clients(
    arguments: &Map<String, Value>,
) -> Result<Value> {
    if !bool_arg(arguments, "confirm", false) {
        bail!(
            "Confirmation required. Ask the user to confirm the client(s), then set confirm: true."
        );
    }

    let client_ids = requested_host_mcp_bridge_client_ids(arguments)?;
    let timeout_ms = optional_int_arg(arguments, &["timeout_ms", "timeoutMs"])
        .unwrap_or(30_000)
        .clamp(1_000, 120_000);
    let mut payload = json!({
        "caller": HOST_MCP_BRIDGE_CALLER,
        "timeout_ms": timeout_ms,
    });
    if !client_ids.is_empty() {
        payload["client_ids"] = Value::Array(client_ids.into_iter().map(Value::String).collect());
    }

    let response = electron_http_client()
        .post(format!(
            "{}{}",
            electron_api_base(),
            "/api/mcp/bridge/enable"
        ))
        .timeout(std::time::Duration::from_millis(timeout_ms as u64))
        .header("X-PORTICO-Programmatic-Bridge", "1")
        .header("X-PORTICO-Bridge-Caller", HOST_MCP_BRIDGE_CALLER)
        .json(&payload)
        .send()
        .await;

    let payload = match response {
        Ok(response) => {
            let status = response.status();
            let body_text = response.text().await?;
            let json = serde_json::from_str::<Value>(&body_text).ok();
            bridge_api_response_payload(
                ElectronJsonResponse {
                    status,
                    json,
                    body_text,
                },
                "Host MCP Bridge configuration request failed",
            )
        }
        Err(error) => bridge_api_transport_payload("configuration", &error),
    };
    success_text(payload)
}

#[cfg(test)]
fn persist_toggle_transport_error(server_id: &str, error: &reqwest::Error) -> anyhow::Error {
    let message = if error.is_connect() {
        format!(
            "Failed to persist toggle state for {server_id}: cannot connect to Electron app at {}",
            electron_api_base()
        )
    } else if error.is_timeout() {
        format!("Failed to persist toggle state for {server_id}: Electron API request timed out")
    } else {
        format!("Failed to persist toggle state for {server_id}: {error}")
    };
    anyhow::anyhow!(message)
}

#[cfg(test)]
async fn persist_mcp_toggle(server_id: &str, enabled: bool) -> Result<()> {
    let response = electron_post_json_preserving_error_body(
        "/api/persist-mcp-toggle",
        &json!({ "server_id": server_id, "enabled": enabled }),
        10.0,
    )
    .await
    .map_err(|error| persist_toggle_transport_error(server_id, &error))?;

    let result = response.json.as_ref();
    let persisted = response.status.is_success()
        && result
            .and_then(|body| body.get("success"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
    if !persisted {
        let error_msg = result
            .and_then(|body| body.get("error").and_then(Value::as_str))
            .or_else(|| result.and_then(|body| body.get("message").and_then(Value::as_str)))
            .map(str::to_string)
            .or_else(|| {
                let trimmed = response.body_text.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            })
            .unwrap_or_else(|| format!("HTTP {}", response.status.as_u16()));
        bail!("Failed to persist toggle state for {server_id}: {error_msg}");
    }

    let mut toggles = load_mcp_toggles();
    toggles.insert(server_id.to_string(), enabled);
    if let Err(error) = save_mcp_toggles(&toggles) {
        warn!(
            "persisted toggle via Electron API for {} but failed to update local toggle mirror: {error}",
            server_id
        );
    }
    Ok(())
}

fn clamp_log_lines(lines: i64) -> u64 {
    lines.clamp(1, 1000) as u64
}

fn mcp_server_logs_server_known(server_id: &str) -> bool {
    configured_server_ids()
        .map(|ids| ids.contains(bare_server_id(server_id)))
        .unwrap_or(true)
}

fn mcp_server_logs_not_found_payload(server_id: &str, lines: u64) -> Value {
    json!({
        "success": false,
        "code": "server_not_found",
        "server_id": bare_server_id(server_id),
        "lines": lines,
        "logs": "",
        "log_source": Value::Null,
        "container_name": Value::Null,
        "error": "MCP server not found.",
    })
}

fn mcp_server_logs_fetch_failed_payload(server_id: &str, lines: u64) -> Value {
    json!({
        "success": false,
        "code": "log_fetch_failed",
        "server_id": bare_server_id(server_id),
        "lines": lines,
        "logs": "",
        "log_source": Value::Null,
        "container_name": Value::Null,
        "error": "Unable to fetch MCP server logs.",
    })
}

fn single_server_restart_transport_result(server_id: &str, error: &anyhow::Error) -> Value {
    if error
        .downcast_ref::<reqwest::Error>()
        .is_some_and(reqwest::Error::is_timeout)
    {
        json!({
            "success": false,
            "mode": "single_server",
            "server_id": server_id,
            "error": format!("Single server restart timed out after 2 minutes for {server_id}"),
            "message": "The operation took too long and timed out",
        })
    } else if error
        .downcast_ref::<reqwest::Error>()
        .is_some_and(reqwest::Error::is_connect)
    {
        json!({
            "success": false,
            "mode": "single_server",
            "server_id": server_id,
            "error": "Could not connect to Electron app REST API on port 9876 (host.docker.internal)",
            "message": "The Electron app may not be running or the REST API is not available.",
        })
    } else {
        json!({
            "success": false,
            "mode": "single_server",
            "server_id": server_id,
            "error": format!("Unexpected error during single server restart: {error}"),
            "message": "An unexpected error occurred",
        })
    }
}

fn full_restart_transport_result(error: &anyhow::Error) -> Value {
    if error
        .downcast_ref::<reqwest::Error>()
        .is_some_and(reqwest::Error::is_timeout)
    {
        json!({
            "success": false,
            "mode": "full_restart",
            "error": "Restart operation timed out after 10 minutes",
            "message": "The operation took too long and timed out",
            "logs": "",
        })
    } else if error
        .downcast_ref::<reqwest::Error>()
        .is_some_and(reqwest::Error::is_connect)
    {
        json!({
            "success": false,
            "mode": "full_restart",
            "error": "Could not connect to Electron app REST API on port 9876 (host.docker.internal)",
            "message": "The Electron app may not be running or the REST API is not available. Ensure the Electron app is running.",
            "logs": "",
        })
    } else {
        json!({
            "success": false,
            "mode": "full_restart",
            "error": format!("Unexpected error during restart: {error}"),
            "message": "An unexpected error occurred",
            "logs": "",
        })
    }
}

fn rollback_user_server_create(paths: &[&Path]) -> Result<()> {
    let mut first_error = None;
    for path in paths {
        if !path.exists() {
            continue;
        }
        let result = if path.is_dir() {
            fs::remove_dir_all(path)
        } else {
            fs::remove_file(path)
        };
        if let Err(error) = result {
            first_error.get_or_insert_with(|| anyhow::Error::new(error));
        }
    }
    if let Some(error) = first_error {
        return Err(error);
    }
    Ok(())
}

pub(super) async fn handle_create_user_mcp_server(arguments: &Map<String, Value>) -> Result<Value> {
    let server_id = string_arg(arguments, "server_id")?;
    let mut yaml_config = map_arg(arguments, "yaml_config")?;
    let fragment = map_arg(arguments, "fragment")?;
    let icon_base64 = arguments.get("icon_base64").and_then(Value::as_str);

    check_user_server_limit()?;
    yaml_config.insert("user_installed".to_string(), Value::Bool(true));
    yaml_config.insert("is_core".to_string(), Value::Bool(false));
    yaml_config.insert("id".to_string(), Value::String(server_id.clone()));
    // Preserve caller-supplied required_env_vars (normalized to the bundled
    // object form); keep the key present so the written yaml shape is stable.
    normalize_required_env_vars(&mut yaml_config);
    yaml_config
        .entry("required_env_vars".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    validate_user_yaml_config(&yaml_config)?;
    let (normalized_fragment, mut warnings) = normalize_remote_public_oauth_fragment(&fragment)?;
    warnings.extend(validate_fragment(&normalized_fragment)?);
    // Every $VAR / ${VAR} the fragment references must be declared, otherwise
    // envsubst expands it to an empty string at server start (PORTICO-224).
    validate_fragment_env_references(&normalized_fragment, &yaml_config)?;

    let server_dir = user_server_path(&server_id)?;
    fs::create_dir_all(&server_dir)
        .with_context(|| format!("failed to create {}", server_dir.display()))?;
    let yaml_path = server_dir.join(format!("{server_id}.yaml"));
    let fragment_path = server_dir.join(format!("{server_id}.fragment"));
    let icon_path = server_dir.join(format!("{server_id}.png"));

    let yaml_value = Value::Object(yaml_config.clone());
    if serde_yaml::to_string(&yaml_value)?.len() > MAX_YAML_SIZE {
        bail!("YAML file too large (max {} bytes)", MAX_YAML_SIZE);
    }
    if serde_json::to_string_pretty(&normalized_fragment)?.len() > MAX_FRAGMENT_SIZE {
        bail!("Fragment file too large (max {} bytes)", MAX_FRAGMENT_SIZE);
    }

    let create_result = async {
        write_yaml_atomic(&yaml_path, &yaml_value)?;
        write_json_atomic(&fragment_path, &Value::Object(normalized_fragment.clone()))?;
        if let Some(icon_base64) = icon_base64 {
            let icon = BASE64_STANDARD
                .decode(icon_base64)
                .context("invalid base64 icon data")?;
            if icon.len() > MAX_ICON_SIZE {
                bail!("Icon too large (max {} bytes)", MAX_ICON_SIZE);
            }
            if !icon.starts_with(b"\x89PNG\r\n\x1a\n") {
                bail!("Icon must be a PNG image");
            }
            fs::write(&icon_path, icon)
                .with_context(|| format!("failed to write {}", icon_path.display()))?;
        } else {
            let default_icon = app_root()?.join("assets").join("agent-icon.png");
            if default_icon.exists() {
                let _ = fs::copy(default_icon, &icon_path);
            }
        }
        Ok::<(), anyhow::Error>(())
    }
    .await;
    if let Err(error) = create_result {
        rollback_user_server_create(&[&icon_path, &fragment_path, &yaml_path, &server_dir])
            .with_context(|| format!("failed to roll back partial create for {}", server_id))?;
        return Err(error);
    }
    let files_created = [yaml_path, fragment_path, icon_path]
        .into_iter()
        .filter(|path| path.exists())
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();

    let create_chat_id = arguments
        .get("chat_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|chat_id| !chat_id.is_empty())
        .map(String::from);
    let enable_result = toggle_integration_with_wait_result(
        &server_id,
        true,
        create_chat_id.as_deref(),
        TOGGLE_ENABLE_WAIT_SECONDS,
        TOGGLE_ENABLE_POLL_INTERVAL_SECONDS,
    )
    .await;
    let auto_enabled = enable_result
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let enabled = auto_enabled
        && enable_result
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true);
    let healthy = enable_result
        .get("healthy")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let readiness_phase = enable_result
        .get("readiness_phase")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();

    let mut next_steps = if auto_enabled {
        enable_result
            .get("next_steps")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_else(|| {
                vec![Value::String(
                    "activate(chat_id, [\"server:ID\"]) to add to current chat".to_string(),
                )]
            })
    } else {
        vec![
            Value::String(format!(
                "Inspect get_mcp_server_logs(server_id=\"{}\") for startup details.",
                server_id
            )),
            Value::String(format!(
                "Call toggle_integration(server_id=\"{}\", enabled=true) after fixing the startup issue.",
                server_id
            )),
        ]
    };
    if !auto_enabled {
        if let Some(existing) = enable_result.get("next_steps").and_then(Value::as_array) {
            next_steps.extend(existing.iter().cloned());
        }
    }

    let mut payload = json!({
        "success": true,
        "server_id": server_id,
        "files_created": files_created,
        "warnings": warnings,
        "enabled": enabled,
        "auto_enabled": auto_enabled,
        "healthy": healthy,
        "readiness_phase": readiness_phase,
        "next_steps": next_steps,
    });
    let object = payload.as_object_mut().expect("create payload object");
    if auto_enabled {
        // Mirror the update handler's NOT_CONFIGURED contract: enabled but
        // awaiting configuration is not a plain success message.
        if enable_result.get("errorCode").and_then(Value::as_str) == Some("NOT_CONFIGURED") {
            let (guidance, _) = toggle_not_configured_guidance(&server_id);
            object.insert(
                "message".to_string(),
                Value::String(format!(
                    "User-installed MCP server '{}' created and enabled; it needs configuration before it can start. {}",
                    server_id, guidance
                )),
            );
            object.insert(
                "errorCode".to_string(),
                Value::String("NOT_CONFIGURED".to_string()),
            );
            object.insert("requiresConfiguration".to_string(), Value::Bool(true));
        } else {
            object.insert(
                "message".to_string(),
                Value::String(format!(
                    "User-installed MCP server '{}' created and enabled",
                    server_id
                )),
            );
        }
    } else {
        object.insert(
            "message".to_string(),
            Value::String(format!(
                "User-installed MCP server '{}' created, but auto-enable failed",
                server_id
            )),
        );
        object.insert("enable_result".to_string(), enable_result.clone());
        object.insert(
            "error".to_string(),
            enable_result.get("error").cloned().unwrap_or(Value::Null),
        );
        object.insert(
            "errorCode".to_string(),
            enable_result
                .get("errorCode")
                .cloned()
                .unwrap_or(Value::Null),
        );
    }

    success_text(payload)
}

pub(super) async fn handle_read_user_mcp_server(arguments: &Map<String, Value>) -> Result<Value> {
    let server_id = string_arg(arguments, "server_id")?;
    let yaml_path = user_server_path(&server_id)?.join(format!("{server_id}.yaml"));
    let yaml = read_json_compatible_yaml(&yaml_path)?;
    let fragment_value =
        read_json_file(&user_server_path(&server_id)?.join(format!("{server_id}.fragment")))?;
    let fragment = fragment_value.as_object().cloned().unwrap_or_default();
    success_text(json!({
        "server_id": server_id,
        "yaml_config": yaml,
        "fragment": Value::Object(sanitize_fragment_for_display(&fragment)),
        "readonly": false,
        "note": "This is a user-installed server and can be modified",
    }))
}

pub(super) async fn handle_update_user_mcp_server(arguments: &Map<String, Value>) -> Result<Value> {
    let server_id = string_arg(arguments, "server_id")?;
    ensure_system_server_id_immutable(&server_id, "modified")?;
    let is_modifiable_system = false;
    let mut files_modified = Vec::new();
    let mut warnings = Vec::new();

    if is_modifiable_system {
        if arguments.get("yaml_config").is_some() {
            bail!(
                "Cannot modify YAML for system server '{}'. Only fragment updates are allowed.",
                server_id
            );
        }
        if arguments.get("icon_base64").is_some() {
            bail!(
                "Cannot modify icon for system server '{}'. Only fragment updates are allowed.",
                server_id
            );
        }
        let fragment = map_arg(arguments, "fragment")?;
        warnings.extend(validate_fragment(&fragment)?);
        let fragment_path = system_server_path(&server_id)?.join(format!("{server_id}.fragment"));
        write_json_atomic(&fragment_path, &Value::Object(fragment.clone()))?;
        files_modified.push(fragment_path.to_string_lossy().to_string());
        let restart_result = electron_post_json(
            &format!("/api/restart-mcp-server/{}", server_id),
            &json!({}),
            30.0,
        )
        .await;
        let (restart_ok, restart_phase) = match &restart_result {
            Ok(val) => (
                val.get("healthy").and_then(Value::as_bool).unwrap_or(false),
                readiness_phase(val),
            ),
            Err(_) => (false, "unknown".to_string()),
        };
        return success_text(json!({
            "success": true,
            "server_id": server_id,
            "server_type": "system (allowlisted for modification)",
            "message": format!("System server '{}' fragment updated and restarted", server_id),
            "files_modified": files_modified,
            "warnings": warnings,
            "allowed_modifications": ["fragment"],
            "healthy": restart_ok,
            "readiness_phase": restart_phase,
        }));
    }

    let server_dir = user_server_path(&server_id)?;
    let yaml_path = server_dir.join(format!("{server_id}.yaml"));

    // PORTICO-276: never let an update leave a user server without its <id>.yaml.
    // Writing a fragment/icon into a directory that lacks the yaml produces a
    // fragment-only server, which fails packaged-runtime preflight and blocks
    // app startup (PORTICO-261). Refuse fragment/icon-only updates when the yaml does
    // not yet exist; an update that supplies a full yaml_config still upserts
    // normally (the yaml is written, so no fragment-only state can result).
    let provides_yaml_config = arguments
        .get("yaml_config")
        .and_then(Value::as_object)
        .is_some();
    if !yaml_path.is_file() && !provides_yaml_config {
        bail!(
            "Cannot update user-installed MCP server '{server_id}': {server_id}.yaml does not exist. \
             Provide a full yaml_config, or create it with create_user_mcp_server first, before updating its fragment or icon."
        );
    }

    fs::create_dir_all(&server_dir)
        .with_context(|| format!("failed to create {}", server_dir.display()))?;

    let fragment_path = server_dir.join(format!("{server_id}.fragment"));

    // Validate the EFFECTIVE post-update pair (provided part + on-disk
    // counterpart) before writing anything: an update must not leave a
    // fragment referencing env vars the yaml no longer declares (PORTICO-224 —
    // that combination silently starts the server with blank values).
    let new_yaml_config = match arguments.get("yaml_config").and_then(Value::as_object) {
        Some(yaml_config) => {
            let mut yaml_config = yaml_config.clone();
            yaml_config.insert("user_installed".to_string(), Value::Bool(true));
            yaml_config.insert("is_core".to_string(), Value::Bool(false));
            yaml_config.insert("id".to_string(), Value::String(server_id.clone()));
            // Preserve caller-supplied required_env_vars (normalized to the
            // bundled object form). yaml_config replaces the whole file, so
            // an omitted key intentionally writes an empty list.
            normalize_required_env_vars(&mut yaml_config);
            yaml_config
                .entry("required_env_vars".to_string())
                .or_insert_with(|| Value::Array(Vec::new()));
            validate_user_yaml_config(&yaml_config)?;
            Some(yaml_config)
        }
        None => None,
    };

    let new_fragment = match arguments.get("fragment").and_then(Value::as_object) {
        Some(fragment) => {
            let (fragment, normalization_warnings) =
                normalize_remote_public_oauth_fragment(fragment)?;
            warnings.extend(normalization_warnings);
            warnings.extend(validate_fragment(&fragment)?);
            Some(fragment)
        }
        None => None,
    };

    if new_yaml_config.is_some() || new_fragment.is_some() {
        let effective_yaml = match &new_yaml_config {
            Some(yaml_config) => yaml_config.clone(),
            None => read_json_compatible_yaml(&yaml_path)
                .ok()
                .and_then(|value| value.as_object().cloned())
                .unwrap_or_default(),
        };
        let effective_fragment = match &new_fragment {
            Some(fragment) => fragment.clone(),
            None => fs::read_to_string(&fragment_path)
                .ok()
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                .and_then(|value| value.as_object().cloned())
                .unwrap_or_default(),
        };
        validate_fragment_env_references(&effective_fragment, &effective_yaml)?;
    }

    if let Some(yaml_config) = new_yaml_config {
        write_yaml_atomic(&yaml_path, &Value::Object(yaml_config))?;
        files_modified.push(yaml_path.to_string_lossy().to_string());
    }

    if let Some(fragment) = new_fragment {
        write_json_atomic(&fragment_path, &Value::Object(fragment))?;
        files_modified.push(fragment_path.to_string_lossy().to_string());
    }

    if let Some(icon_base64) = arguments.get("icon_base64").and_then(Value::as_str) {
        let icon = BASE64_STANDARD
            .decode(icon_base64)
            .context("invalid base64 icon data")?;
        if icon.len() > MAX_ICON_SIZE {
            bail!("Icon too large (max {} bytes)", MAX_ICON_SIZE);
        }
        if !icon.starts_with(b"\x89PNG\r\n\x1a\n") {
            bail!("Icon must be a PNG image");
        }
        let icon_path = server_dir.join(format!("{server_id}.png"));
        fs::write(&icon_path, icon)
            .with_context(|| format!("failed to write {}", icon_path.display()))?;
        files_modified.push(icon_path.to_string_lossy().to_string());
    }

    let restart_result = electron_post_json(
        &format!("/api/restart-mcp-server/{}", server_id),
        &json!({}),
        30.0,
    )
    .await;
    let (restart_ok, restart_phase, restart_error_code) = match &restart_result {
        Ok(val) => (
            val.get("healthy").and_then(Value::as_bool).unwrap_or(false),
            readiness_phase(val),
            val.get("errorCode")
                .and_then(Value::as_str)
                .map(str::to_string),
        ),
        Err(_) => (false, "unknown".to_string(), None),
    };

    let mut payload = json!({
        "success": true,
        "server_id": server_id,
        "server_type": "user-installed",
        "message": format!("User-installed MCP server '{}' updated and restarted", server_id),
        "files_modified": files_modified,
        "warnings": warnings,
        "healthy": restart_ok,
        "readiness_phase": restart_phase,
    });
    if restart_error_code.as_deref() == Some("NOT_CONFIGURED") {
        let (message, next_steps) = toggle_not_configured_guidance(&server_id);
        let object = payload.as_object_mut().expect("update payload object");
        object.insert(
            "message".to_string(),
            Value::String(format!(
                "User-installed MCP server '{}' updated; it needs configuration before it can start. {}",
                server_id, message
            )),
        );
        object.insert(
            "errorCode".to_string(),
            Value::String("NOT_CONFIGURED".to_string()),
        );
        object.insert("requiresConfiguration".to_string(), Value::Bool(true));
        object.insert(
            "next_steps".to_string(),
            Value::Array(next_steps.into_iter().map(Value::String).collect()),
        );
    }
    success_text(payload)
}

pub(super) async fn handle_delete_user_mcp_server(arguments: &Map<String, Value>) -> Result<Value> {
    let server_id = string_arg(arguments, "server_id")?;
    ensure_system_server_id_immutable(&server_id, "deleted")?;
    if !bool_arg(arguments, "confirm", false) {
        bail!("Confirmation required. Set 'confirm: true' to delete the server.");
    }
    let response = electron_post_json_preserving_error_body(
        &format!("/api/delete-mcp-server/{}", server_id),
        &json!({}),
        120.0,
    )
    .await
    .map_err(|error| {
        if error.is_connect() {
            anyhow::anyhow!(
                "Failed to delete MCP server {server_id}: cannot connect to Electron app at {}",
                electron_api_base()
            )
        } else if error.is_timeout() {
            anyhow::anyhow!(
                "Failed to delete MCP server {server_id}: Electron API request timed out"
            )
        } else {
            anyhow::anyhow!("Failed to delete MCP server {server_id}: {error}")
        }
    })?;

    let payload = response.json.unwrap_or_else(|| {
        let trimmed = response.body_text.trim();
        json!({
            "success": false,
            "server_id": server_id,
            "error": if trimmed.is_empty() {
                format!("HTTP {}", response.status.as_u16())
            } else {
                trimmed.to_string()
            }
        })
    });

    let deleted = response.status.is_success()
        && payload
            .get("success")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    if !deleted {
        let error_msg = payload
            .get("error")
            .and_then(Value::as_str)
            .or_else(|| payload.get("message").and_then(Value::as_str))
            .map(str::to_string)
            .or_else(|| {
                let trimmed = response.body_text.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            })
            .unwrap_or_else(|| format!("HTTP {}", response.status.as_u16()));
        bail!("Failed to delete MCP server {server_id}: {error_msg}");
    }

    success_text(payload)
}

pub(super) async fn handle_validate_mcp_fragment(arguments: &Map<String, Value>) -> Result<Value> {
    let fragment = map_arg(arguments, "fragment")?;
    let warnings = validate_fragment(&fragment)?;
    success_text(json!({ "valid": true, "errors": [], "warnings": warnings }))
}

async fn wait_for_server_tool_ready_with_poll(
    server_id: &str,
    timeout_seconds: f64,
    poll_interval_seconds: f64,
) -> Value {
    let started_at = now_epoch_seconds();
    let bare = bare_server_id(server_id).to_string();
    let mut readiness = get_server_readiness(&bare).await;

    loop {
        let waited = (now_epoch_seconds() - started_at).max(0.0);
        let phase = readiness_phase(&readiness);
        let healthy = readiness
            .get("healthy")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if let Some(object) = readiness.as_object_mut() {
            object.insert("server_id".to_string(), Value::String(bare.clone()));
            object.insert("healthy".to_string(), Value::Bool(healthy));
            object.insert("readiness_phase".to_string(), Value::String(phase.clone()));
            object.insert(
                "waited_seconds".to_string(),
                Value::from((waited * 10.0).round() / 10.0),
            );
        }
        if healthy && phase == READINESS_PHASE_TOOL_READY {
            return readiness;
        }
        if waited >= timeout_seconds || !should_wait_for_tool_ready(&readiness) {
            return readiness;
        }

        let remaining = timeout_seconds - waited;
        let sleep_seconds = poll_interval_seconds.max(0.01).min(remaining.max(0.01));
        tokio::time::sleep(std::time::Duration::from_secs_f64(sleep_seconds)).await;
        readiness = get_server_readiness(&bare).await;
    }
}

fn remaining_post_auth_wait_seconds(already_waited_seconds: f64) -> f64 {
    (AUTHORIZE_POST_AUTH_WAIT_SECONDS - already_waited_seconds).max(0.0)
}

async fn wait_for_post_auth_readiness_with_poll(
    server_id: &str,
    readiness_result: &Value,
    poll_interval_seconds: f64,
) -> Value {
    let mut readiness = readiness_result.clone();
    let bare = bare_server_id(server_id).to_string();
    let healthy = readiness
        .get("healthy")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let readiness_phase = readiness_phase(&readiness);
    let already_waited_seconds = readiness
        .get("waited_seconds")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);

    if let Some(object) = readiness.as_object_mut() {
        object.insert("server_id".to_string(), Value::String(bare.clone()));
        object.insert("healthy".to_string(), Value::Bool(healthy));
        object.insert(
            "readiness_phase".to_string(),
            Value::String(readiness_phase.clone()),
        );
        object.insert(
            "waited_seconds".to_string(),
            Value::from((already_waited_seconds * 10.0).round() / 10.0),
        );
    }

    if healthy || !should_wait_for_tool_ready(&readiness) {
        return readiness;
    }

    let remaining_wait_seconds = remaining_post_auth_wait_seconds(already_waited_seconds);
    if remaining_wait_seconds <= 0.0 {
        return readiness;
    }

    let mut waited =
        wait_for_server_tool_ready_with_poll(&bare, remaining_wait_seconds, poll_interval_seconds)
            .await;
    let total_waited_seconds = already_waited_seconds
        + waited
            .get("waited_seconds")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
    if let Some(object) = waited.as_object_mut() {
        object.insert("server_id".to_string(), Value::String(bare));
        object.insert(
            "waited_seconds".to_string(),
            Value::from((total_waited_seconds * 10.0).round() / 10.0),
        );
    }
    waited
}

async fn wait_for_post_auth_readiness(server_id: &str, readiness_result: &Value) -> Value {
    wait_for_post_auth_readiness_with_poll(
        server_id,
        readiness_result,
        ACTIVATION_POLL_INTERVAL_SECONDS,
    )
    .await
}

fn toggle_success_message(
    server_id: &str,
    enabled: bool,
    phase: &str,
    healthy: bool,
    source_message: Option<&str>,
    preserve_source_message: bool,
) -> String {
    if !enabled {
        if preserve_source_message {
            if let Some(message) = source_message {
                return message.to_string();
            }
        }
        return format!("Server {server_id} disabled successfully");
    }

    if preserve_source_message {
        if let Some(message) = source_message {
            return message.to_string();
        }
    }

    if healthy && phase == READINESS_PHASE_TOOL_READY {
        format!("Server {server_id} enabled successfully and its tools are ready.")
    } else if phase == READINESS_PHASE_CHECKING_TOKENS {
        format!("Server {server_id} enabled successfully and is checking existing OAuth tokens.")
    } else if matches!(
        phase,
        READINESS_PHASE_NEEDS_OAUTH | READINESS_PHASE_WAITING_CALLBACK
    ) {
        format!("Server {server_id} enabled successfully and is ready for OAuth authorization.")
    } else {
        format!("Server {server_id} enabled successfully but is still starting.")
    }
}

fn is_toggle_transport_error(error_str: &str) -> bool {
    error_str.contains("Server disconnected")
        || error_str.contains("nginx")
        || error_str.contains("502 Bad Gateway")
        || error_str.contains("500 Internal Server Error")
        || error_str.contains("Expected HTTP/")
        || error_str.contains("RTSP/")
        || error_str.contains("error sending request")
        || error_str.contains("connection closed")
        || error_str.contains("Connection reset")
        || error_str.contains("channel closed")
        || error_str.contains("Toggle request timed out")
}

fn is_toggle_waitable_error(error_code: &str, error_str: &str) -> bool {
    error_code == "FLOW_IN_PROGRESS" || is_toggle_transport_error(error_str)
}

fn is_authorize_transport_error(error_str: &str) -> bool {
    is_toggle_transport_error(error_str)
}

fn is_actionable_toggle_phase(phase: &str, healthy: bool) -> bool {
    healthy
        || matches!(
            phase,
            READINESS_PHASE_CHECKING_TOKENS
                | READINESS_PHASE_NEEDS_OAUTH
                | READINESS_PHASE_WAITING_CALLBACK
                | READINESS_PHASE_TOOL_READY
        )
}

fn is_toggle_pending_phase(phase: &str) -> bool {
    matches!(
        phase,
        READINESS_PHASE_STARTING
            | "queued"
            | "running"
            | "preflight"
            | "persisting_toggles"
            | "regenerating_config"
            | "resolving_runtime_targets"
            | "restarting_host"
            | "restarting_docker"
            | "reloading_routes"
            | "runtime_started"
            | "waiting_readiness"
    )
}

async fn wait_for_toggle_readiness(
    server_id: &str,
    enabled: bool,
    timeout_seconds: f64,
    poll_interval_seconds: f64,
) -> Value {
    let started_at = now_epoch_seconds();
    let bare = bare_server_id(server_id).to_string();
    let mut readiness = get_server_readiness(&bare).await;

    loop {
        let waited = (now_epoch_seconds() - started_at).max(0.0);
        let healthy = readiness
            .get("healthy")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let phase = readiness_phase(&readiness);
        if let Some(object) = readiness.as_object_mut() {
            object.insert("server_id".to_string(), Value::String(bare.clone()));
            object.insert("healthy".to_string(), Value::Bool(healthy));
            object.insert("readiness_phase".to_string(), Value::String(phase.clone()));
            object.insert(
                "waited_seconds".to_string(),
                Value::from((waited * 10.0).round() / 10.0),
            );
        }

        if enabled && healthy && phase == READINESS_PHASE_TOOL_READY {
            return readiness;
        }
        if !enabled && phase == READINESS_PHASE_DISABLED {
            return readiness;
        }
        if !is_toggle_pending_phase(&phase) || waited >= timeout_seconds {
            return readiness;
        }

        let remaining = timeout_seconds - waited;
        let sleep_seconds = poll_interval_seconds.max(0.01).min(remaining.max(0.01));
        tokio::time::sleep(std::time::Duration::from_secs_f64(sleep_seconds)).await;
        readiness = get_server_readiness(&bare).await;
    }
}

async fn recover_authorize_transport_error(
    server_id: &str,
    chat_id: Option<&str>,
    poll_interval_seconds: f64,
) -> Option<Value> {
    let readiness = get_server_readiness(server_id).await;
    let post_auth =
        wait_for_post_auth_readiness_with_poll(server_id, &readiness, poll_interval_seconds).await;
    let phase = readiness_phase(&post_auth);
    let healthy = post_auth
        .get("healthy")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if phase != READINESS_PHASE_TOOL_READY || !healthy {
        return None;
    }

    let waited_seconds = post_auth
        .get("waited_seconds")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let mut auto_activated = false;
    let mut activation_error: Option<String> = None;
    if let Some(cid) = chat_id {
        match try_activate_for_chat(cid, server_id).await {
            Ok(true) => auto_activated = true,
            Ok(false) => {}
            Err(error) => activation_error = Some(error.to_string()),
        }
    }

    let (message, next_steps) =
        authorize_integration_guidance(server_id, false, &phase, waited_seconds, auto_activated);
    Some(json!({
        "success": true,
        "completed": true,
        "healthy": healthy,
        "readiness_phase": phase,
        "already_authorized": false,
        "auto_activated": auto_activated,
        "activation_error": activation_error,
        "server_id": server_id,
        "waited_seconds": post_auth.get("waited_seconds").cloned().unwrap_or(Value::from(0.0)),
        "message": message,
        "next_steps": next_steps,
    }))
}

async fn handle_toggle_integration_with_wait(
    arguments: &Map<String, Value>,
    toggle_wait_seconds: f64,
    toggle_poll_interval_seconds: f64,
) -> Result<Value> {
    let server_id = string_arg(arguments, "server_id")?;
    let enabled = arguments
        .get("enabled")
        .and_then(Value::as_bool)
        .context("enabled must be a boolean")?;
    let chat_id = arguments
        .get("chat_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|chat_id| !chat_id.is_empty())
        .map(String::from);
    success_text(
        toggle_integration_with_wait_result(
            &server_id,
            enabled,
            chat_id.as_deref(),
            toggle_wait_seconds,
            toggle_poll_interval_seconds,
        )
        .await,
    )
}

async fn toggle_integration_with_wait_result(
    server_id: &str,
    enabled: bool,
    chat_id: Option<&str>,
    toggle_wait_seconds: f64,
    toggle_poll_interval_seconds: f64,
) -> Value {
    let toggle_started_at = std::time::Instant::now();
    let mut toggle_payload = json!({ "server_id": server_id, "enabled": enabled });
    if let Some(cid) = chat_id {
        toggle_payload["chat_id"] = Value::String(cid.to_string());
    }
    let result = match electron_post_json_preserving_error_body(
        "/api/toggle-mcp-server",
        &toggle_payload,
        15.0,
    )
    .await
    {
        Ok(response) => response.json.unwrap_or_else(|| {
            let trimmed = response.body_text.trim();
            json!({
                "success": false,
                "error": if trimmed.is_empty() {
                    format!("HTTP {}", response.status.as_u16())
                } else {
                    trimmed.to_string()
                }
            })
        }),
        Err(error) => json!({
            "success": false,
            "error": if error.is_connect() {
                "Cannot connect to Electron app on host.docker.internal:9876".to_string()
            } else if error.is_timeout() {
                format!("Toggle request timed out for {server_id}")
            } else {
                format!("Unexpected error toggling {server_id}: {error}")
            }
        }),
    };
    let mut success = result
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let initial_phase = readiness_phase(&result);
    let initial_healthy = result
        .get("healthy")
        .and_then(Value::as_bool)
        .unwrap_or(!enabled);
    let mut final_phase = initial_phase.clone();
    let mut final_healthy = initial_healthy;
    let error_code = result
        .get("errorCode")
        .and_then(Value::as_str)
        .unwrap_or("");
    let error_str = result.get("error").and_then(Value::as_str).unwrap_or("");
    let is_transport_error = is_toggle_transport_error(error_str);
    let is_waitable_error = is_toggle_waitable_error(error_code, error_str);

    if success && initial_phase == READINESS_PHASE_STARTING {
        let remaining_wait_seconds =
            (toggle_wait_seconds - toggle_started_at.elapsed().as_secs_f64()).max(0.0);
        if remaining_wait_seconds > 0.0 {
            let waited = wait_for_toggle_readiness(
                server_id,
                enabled,
                remaining_wait_seconds,
                toggle_poll_interval_seconds,
            )
            .await;
            final_phase = readiness_phase(&waited);
            final_healthy = waited
                .get("healthy")
                .and_then(Value::as_bool)
                .unwrap_or(false);
        }
    } else if enabled && is_waitable_error {
        let remaining_wait_seconds =
            (toggle_wait_seconds - toggle_started_at.elapsed().as_secs_f64()).max(0.0);
        if remaining_wait_seconds > 0.0 {
            let waited = wait_for_toggle_readiness(
                server_id,
                true,
                remaining_wait_seconds,
                toggle_poll_interval_seconds,
            )
            .await;
            let waited_phase = readiness_phase(&waited);
            let waited_healthy = waited
                .get("healthy")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if is_actionable_toggle_phase(waited_phase.as_str(), waited_healthy) {
                success = true;
                final_phase = waited_phase;
                final_healthy = waited_healthy;
            }
        }
    }
    if success && !enabled && final_phase != READINESS_PHASE_DISABLED {
        success = false;
    }
    let preserve_source_message = final_phase == initial_phase && final_healthy == initial_healthy;

    let mut payload = json!({
        "success": success,
        "server_id": server_id,
    });
    if success {
        // PORTICO-224: a successful enable can leave the server awaiting
        // configuration (Electron preflight returns success +
        // errorCode NOT_CONFIGURED). Direct the caller to the Configure
        // flow instead of telling it to wait for readiness.
        let not_configured = result.get("errorCode").and_then(Value::as_str)
            == Some("NOT_CONFIGURED")
            || final_phase == READINESS_PHASE_NOT_CONFIGURED;
        let object = payload.as_object_mut().expect("toggle payload object");
        object.insert("enabled".to_string(), Value::Bool(enabled));
        object.insert("healthy".to_string(), Value::Bool(final_healthy));
        object.insert(
            "readiness_phase".to_string(),
            Value::String(final_phase.clone()),
        );
        if enabled && not_configured {
            let (message, next_steps) = toggle_not_configured_guidance(server_id);
            object.insert("message".to_string(), Value::String(message));
            object.insert(
                "errorCode".to_string(),
                Value::String("NOT_CONFIGURED".to_string()),
            );
            object.insert("requiresConfiguration".to_string(), Value::Bool(true));
            object.insert(
                "next_steps".to_string(),
                Value::Array(next_steps.into_iter().map(Value::String).collect()),
            );
        } else {
            object.insert(
                "message".to_string(),
                Value::String(toggle_success_message(
                    server_id,
                    enabled,
                    final_phase.as_str(),
                    final_healthy,
                    result.get("message").and_then(Value::as_str),
                    preserve_source_message,
                )),
            );
            object.insert(
                "next_steps".to_string(),
                Value::Array(
                    toggle_integration_next_steps(enabled, final_phase.as_str())
                        .into_iter()
                        .map(Value::String)
                        .collect(),
                ),
            );
        }
    } else {
        let object = payload.as_object_mut().expect("toggle payload object");
        object.insert(
            "error".to_string(),
            result
                .get("error")
                .cloned()
                .filter(|value| !value.is_null())
                .unwrap_or_else(|| {
                    Value::String(if enabled {
                        format!("Server {server_id} did not reach an actionable readiness state")
                    } else {
                        format!("Server {server_id} did not reach disabled state")
                    })
                }),
        );
        object.insert(
            "errorCode".to_string(),
            result.get("errorCode").cloned().unwrap_or(Value::Null),
        );
        let saved_secret_unavailable = result.get("errorCode").and_then(Value::as_str)
            == Some("SAVED_SECRET_UNAVAILABLE")
            || result.get("configurationIssue").and_then(Value::as_str)
                == Some("saved_secret_unavailable");
        if saved_secret_unavailable {
            let (message, next_steps) = toggle_saved_secret_unavailable_guidance(server_id);
            object.insert("message".to_string(), Value::String(message));
            object.insert(
                "errorCode".to_string(),
                Value::String("SAVED_SECRET_UNAVAILABLE".to_string()),
            );
            object.insert(
                "configurationIssue".to_string(),
                Value::String("saved_secret_unavailable".to_string()),
            );
            object.insert("requiresConfiguration".to_string(), Value::Bool(true));
            object.insert("requiresSecretReplacement".to_string(), Value::Bool(true));
            object.insert(
                "requiredAction".to_string(),
                Value::String("replace_saved_secret".to_string()),
            );
            for field in ["recoveryPrompt", "recoveryLabel", "severity"] {
                if let Some(value) = result.get(field).cloned() {
                    object.insert(field.to_string(), value);
                }
            }
            object.insert(
                "next_steps".to_string(),
                Value::Array(next_steps.into_iter().map(Value::String).collect()),
            );
        } else if matches!(
            result.get("errorCode").and_then(Value::as_str),
            Some("INTEGRATION_HARD_DISABLED")
        ) {
            // PORTICO-410: firm refusal — the user hard-disabled this server.
            object.insert(
                "readiness_phase".to_string(),
                Value::String("disabled".to_string()),
            );
            object.insert(
                "note".to_string(),
                Value::String(
                    "STOP. This integration was hard-disabled by the user. Do NOT retry toggle, and do NOT attempt authorize, activate, guided_setup, or any other enable path. It can only be re-enabled by the user from the Control Plane."
                        .to_string(),
                ),
            );
            object.insert(
                "next_steps".to_string(),
                Value::Array(vec![
                    Value::String(
                        "Tell the user this integration is hard-disabled and can only be re-enabled from the Control Plane.".to_string(),
                    ),
                    Value::String(
                        "Continue the task without this integration.".to_string(),
                    ),
                ]),
            );
        } else if is_transport_error && enabled {
            object.insert("toggle_likely_succeeded".to_string(), Value::Bool(true));
            object.insert(
                "message".to_string(),
                Value::String(format!(
                    "Toggle for {server_id} likely succeeded but the infrastructure restart broke the \
                     communication channel. Proceed to the next step: for OAuth integrations call \
                     authorize(server_id, chat_id); for token-based call guided_setup if needed, \
                     then activate. Do NOT retry toggle, do NOT call list_mcp_servers."
                )),
            );
            object.insert(
                "next_steps".to_string(),
                Value::Array(vec![
                    Value::String(
                        "The toggle almost certainly succeeded — the restart broke the transport, not the operation.".to_string(),
                    ),
                    Value::String(
                        "For OAuth integrations: call mcp_assistant_authorize_integration(server_id, chat_id) next.".to_string(),
                    ),
                    Value::String(
                        "For token integrations: call mcp_assistant_trigger_guided_setup if NOT_CONFIGURED, else mcp_assistant_activate_integration.".to_string(),
                    ),
                ]),
            );
        } else if matches!(
            result.get("errorCode").and_then(Value::as_str),
            Some("MAX_RETRIES_EXCEEDED")
        ) {
            object.insert(
                "readiness_phase".to_string(),
                Value::String("circuit_breaker".to_string()),
            );
            object.insert(
                "note".to_string(),
                Value::String(
                    "STOP. Circuit breaker tripped — do NOT retry. Inform the user and move on."
                        .to_string(),
                ),
            );
        } else if matches!(
            result.get("errorCode").and_then(Value::as_str),
            Some("NOT_CONFIGURED" | "SERVICE_NOT_FOUND")
        ) {
            let (message, next_steps) = toggle_not_configured_guidance(server_id);
            object.insert("message".to_string(), Value::String(message));
            object.insert(
                "next_steps".to_string(),
                Value::Array(next_steps.into_iter().map(Value::String).collect()),
            );
        }
    }
    payload
}

pub(super) async fn handle_restart_mcp_infrastructure(
    arguments: &Map<String, Value>,
) -> Result<Value> {
    if let Some(server_id) = arguments.get("server_id").and_then(Value::as_str) {
        let result = electron_post_json(
            &format!("/api/restart-mcp-server/{}", server_id),
            &json!({}),
            30.0,
        )
        .await
        .unwrap_or_else(|error| single_server_restart_transport_result(server_id, &error));
        let healthy = result
            .get("healthy")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let phase = readiness_phase(&result);
        let success = result
            .get("success")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mut payload = json!({
            "success": success,
            "mode": "single_server",
            "server_id": server_id,
            "message": result.get("message").cloned().unwrap_or(Value::String(
                if success && healthy {
                    format!("Server {} restarted successfully", server_id)
                } else if success {
                    format!("Server {} restarted successfully, but it is still starting.", server_id)
                } else {
                    format!("Failed to restart server {}", server_id)
                }
            )),
            "error": result.get("error").cloned().unwrap_or(Value::Null),
        });
        if success {
            let not_configured =
                result.get("errorCode").and_then(Value::as_str) == Some("NOT_CONFIGURED");
            let (summary, next_steps) = if not_configured {
                toggle_not_configured_guidance(server_id)
            } else {
                single_server_restart_guidance(server_id, phase.as_str())
            };
            let object = payload.as_object_mut().expect("restart payload object");
            object.insert(
                "restart_mode".to_string(),
                result
                    .get("mode")
                    .cloned()
                    .unwrap_or(Value::String("docker".to_string())),
            );
            object.insert("healthy".to_string(), Value::Bool(healthy));
            object.insert("readiness_phase".to_string(), Value::String(phase.clone()));
            object.insert("summary".to_string(), Value::String(summary));
            object.insert(
                "next_steps".to_string(),
                Value::Array(next_steps.into_iter().map(Value::String).collect()),
            );
            if not_configured {
                object.insert(
                    "errorCode".to_string(),
                    Value::String("NOT_CONFIGURED".to_string()),
                );
            }
        }
        return success_text(payload);
    }

    let result = electron_post_json("/api/restart-mcp", &json!({}), 120.0)
        .await
        .unwrap_or_else(|error| full_restart_transport_result(&error));
    let logs = result
        .get("logs")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    success_text(json!({
        "success": result.get("success").and_then(Value::as_bool).unwrap_or(false),
        "mode": "full_restart",
        "message": result.get("message").cloned().unwrap_or(Value::String(
            if result.get("success").and_then(Value::as_bool).unwrap_or(false) {
                "MCP infrastructure restarted successfully".to_string()
            } else {
                "MCP infrastructure restart failed".to_string()
            }
        )),
        "health_check_passed": result.get("healthCheckPassed").cloned().unwrap_or(Value::Bool(false)),
        "error": result.get("error").cloned().unwrap_or(Value::Null),
        "logs": logs,
        "summary": result.get("summary").cloned().unwrap_or(Value::String(
            if result.get("success").and_then(Value::as_bool).unwrap_or(false) {
                "All services have been restarted and are healthy".to_string()
            } else {
                "Restart failed - see logs for details".to_string()
            }
        )),
    }))
}

pub(super) async fn handle_restart_mcp_server(arguments: &Map<String, Value>) -> Result<Value> {
    let server_id = string_arg(arguments, "server_id")?;
    handle_restart_mcp_infrastructure(&Map::from_iter([(
        "server_id".to_string(),
        Value::String(server_id),
    )]))
    .await
}

pub(super) async fn handle_toggle_integration(arguments: &Map<String, Value>) -> Result<Value> {
    handle_toggle_integration_with_wait(
        arguments,
        TOGGLE_ENABLE_WAIT_SECONDS,
        TOGGLE_ENABLE_POLL_INTERVAL_SECONDS,
    )
    .await
}

pub(super) async fn handle_activate_integration(arguments: &Map<String, Value>) -> Result<Value> {
    let chat_id = string_arg(arguments, "chat_id")?;
    let mut tool_server_ids = array_strings(arguments.get("tool_server_ids"));
    if tool_server_ids.is_empty() {
        tool_server_ids = array_strings(arguments.get("tool_ids"));
    }
    if tool_server_ids.is_empty() {
        if let Some(raw) = arguments
            .get("server_id")
            .or_else(|| arguments.get("server"))
            .and_then(Value::as_str)
        {
            let normalized = if raw.starts_with("server:") {
                raw.to_string()
            } else {
                format!("server:{raw}")
            };
            tool_server_ids = vec![normalized];
        }
    }
    if tool_server_ids.is_empty() {
        bail!("tool_server_ids is required (pass [\"server:<id>\"] or set server_id)");
    }

    for tool_id in &tool_server_ids {
        if !tool_id.starts_with("server:") {
            bail!(
                "Invalid tool server ID format: {}. Must start with 'server:'",
                tool_id
            );
        }
    }
    with_chat_capabilities_lock(&chat_id, || {
        let chat_id = chat_id.clone();
        let tool_server_ids = tool_server_ids.clone();
        async move {
            let redis_key = format!("chat_tools:{chat_id}");
            let existing_tools_raw = redis_get_string(&redis_key)?
                .map(|raw| serde_json::from_str::<Vec<String>>(&raw).unwrap_or_default())
                .unwrap_or_default();
            let existing_tools = sanitize_chat_specific_tool_ids(existing_tools_raw.clone());
            let existing_set = existing_tools.iter().cloned().collect::<HashSet<_>>();
            let requested_tool_server_ids = dedupe_tool_server_ids(tool_server_ids.clone());
            let already_enabled = requested_tool_server_ids
                .iter()
                .filter(|tool| is_core_chat_tool_id(tool) || existing_set.contains(*tool))
                .cloned()
                .collect::<Vec<_>>();
            let newly_added = requested_tool_server_ids
                .iter()
                .filter(|tool| !is_core_chat_tool_id(tool) && !existing_set.contains(*tool))
                .cloned()
                .collect::<Vec<_>>();
            if let Some(allowed_tools) = delegated_subagent_allowed_tool_server_ids(&chat_id)? {
                let blocked = newly_added
                    .iter()
                    .filter(|tool| !allowed_tools.contains(*tool))
                    .cloned()
                    .collect::<Vec<_>>();
                if !blocked.is_empty() {
                    return success_text(json!({
                        "success": false,
                        "chat_id": chat_id,
                        "enabled_tools": existing_tools,
                        "newly_added": [],
                        "already_enabled": already_enabled,
                        "blocked_integrations": blocked.iter().map(|tool| json!({
                            "server_id": tool.trim_start_matches("server:"),
                            "tool_server_id": tool,
                            "healthy": false,
                            "readiness_phase": "subagent_scope_locked",
                            "error": "delegated_subagent_scope_locked",
                            "message": "Delegated subagent tool surface is fixed by the parent task.",
                        })).collect::<Vec<_>>(),
                        "message": "Delegated subagent tool surface is fixed by the parent task. Synthesize with the tools already attached instead of activating new integrations.",
                        "next_steps": [
                            "Use the current delegated tools and reduced artifacts to finish the task.",
                            "If a different integration is truly required, the parent chat must spawn a new subagent with that integration in scope."
                        ],
                    }));
                }
            }

            // PORTICO-410: hard-disabled servers are blocked from activation even
            // if a stale toggle map claims they are enabled.
            let ready_to_probe = newly_added
                .iter()
                .filter(|tool| {
                    !is_server_hard_disabled(tool) && assistant_tool_server_enabled(tool)
                })
                .cloned()
                .collect::<Vec<_>>();
            let disabled = newly_added
                .iter()
                .filter(|tool| {
                    is_server_hard_disabled(tool) || !assistant_tool_server_enabled(tool)
                })
                .cloned()
                .collect::<Vec<_>>();

            let mut blocked_integrations = disabled
                .iter()
                .map(|tool| {
                    let error_code = if is_server_hard_disabled(tool) {
                        "integration_hard_disabled"
                    } else {
                        "integration_disabled"
                    };
                    blocked_integration(
                        tool,
                        &json!({
                            "healthy": false,
                            "readiness_phase": READINESS_PHASE_DISABLED,
                            "error": error_code,
                        }),
                    )
                })
                .collect::<Vec<_>>();

            let readiness_results =
                join_all(ready_to_probe.iter().cloned().map(|tool| async move {
                    let readiness = wait_for_server_tool_ready(&tool, ACTIVATION_WAIT_SECONDS).await;
                    (tool, readiness)
                }))
                .await;

            for (tool, readiness) in readiness_results {
                let blocked = blocked_integration(&tool, &readiness);
                if blocked.get("readiness_phase").and_then(Value::as_str)
                    != Some(READINESS_PHASE_TOOL_READY)
                    || blocked.get("healthy").and_then(Value::as_bool) != Some(true)
                {
                    blocked_integrations.push(blocked);
                }
            }

            if !blocked_integrations.is_empty() {
                return success_text(json!({
                    "success": false,
                    "chat_id": chat_id,
                    "enabled_tools": existing_tools,
                    "newly_added": [],
                    "already_enabled": already_enabled,
                    "blocked_integrations": blocked_integrations,
                    "message": activation_failure_message(&blocked_integrations, false),
                    "next_steps": activation_next_steps(&blocked_integrations, false),
                }));
            }

            let mut all_tools = existing_tools.clone();
            for tool in &newly_added {
                if !all_tools.contains(tool) {
                    all_tools.push(tool.clone());
                }
            }
            let encoded_tools = serde_json::to_string(&all_tools)?;
            redis_setex_string(&redis_key, &encoded_tools, SKILL_TTL_SECONDS)?;
            let tools_changed = !newly_added.is_empty() || existing_tools_raw != existing_tools;
            let _ = maybe_notify_chat_tools(&chat_id, &all_tools, tools_changed).await;
            let ready_tool_server_ids = dedupe_tool_server_ids(
                already_enabled
                    .iter()
                    .cloned()
                    .chain(newly_added.iter().cloned()),
            );
            let message = if newly_added.is_empty() && !already_enabled.is_empty() {
                "Requested tool server(s) are already active for this chat. Use their loaded tools directly; do not call activate_integration or restart_mcp_server again unless a tool call fails.".to_string()
            } else {
                format!("Enabled {} new tool server(s) for this chat session. Use the loaded tools directly.", newly_added.len())
            };
            success_text(json!({
                "success": true,
                "chat_id": chat_id,
                "enabled_tools": all_tools,
                "newly_added": newly_added,
                "already_enabled": already_enabled,
                "ready_tool_server_ids": ready_tool_server_ids,
                "ttl_seconds": SKILL_TTL_SECONDS,
                "ttl_days": 7,
                "message": message,
            }))
        }
    })
    .await
}

#[rustfmt::skip]
async fn maybe_notify_chat_tools(chat_id: &str, all_tools: &[String], should_notify: bool) -> Result<()> {
    if should_notify { notify_capabilities_changed(chat_id, "tools", all_tools).await; }
    Ok(())
}

fn delegated_subagent_allowed_tool_server_ids(chat_id: &str) -> Result<Option<HashSet<String>>> {
    let redis_key = format!("subagent_chat:{chat_id}");
    let Some(raw) = redis_get_string(&redis_key)? else {
        return Ok(None);
    };
    let payload: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    let explicit_skill_count = payload
        .get("explicit_skill_ids")
        .and_then(Value::as_array)
        .map(|skills| skills.len())
        .unwrap_or(0);
    if explicit_skill_count == 0 {
        return Ok(None);
    }
    let allowed = payload
        .get("allowed_tool_server_ids")
        .and_then(Value::as_array)
        .map(|servers| {
            servers
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<HashSet<_>>()
        })
        .unwrap_or_default();
    if allowed.is_empty() {
        return Ok(None);
    }
    Ok(Some(allowed))
}

pub(super) async fn handle_get_chat_tools(arguments: &Map<String, Value>) -> Result<Value> {
    #[rustfmt::skip]
    let chat_id = string_arg(arguments, "chat_id")?;
    let redis_key = format!("chat_tools:{chat_id}");
    let mut chat_tools = sanitize_chat_specific_tool_ids(
        redis_get_string(&redis_key)?
            .map(|raw| serde_json::from_str::<Vec<String>>(&raw).unwrap_or_default())
            .unwrap_or_default(),
    );
    // PORTICO-410: a hard-disabled server may linger in the Redis attachment list
    // until its TTL expires — never report it back to the model.
    chat_tools.retain(|tool_id| !is_server_hard_disabled(tool_id));
    let ttl = redis_ttl(&redis_key).ok().filter(|ttl| *ttl > 0);
    let core_tools = core_chat_tool_ids();
    let all_enabled_tools =
        dedupe_tool_server_ids(core_tools.iter().cloned().chain(chat_tools.iter().cloned()));
    success_text(json!({
        "success": true,
        "chat_id": chat_id,
        "core_tools": core_tools,
        "chat_specific_tools": chat_tools,
        "all_enabled_tools": all_enabled_tools.clone(),
        "total_enabled": all_enabled_tools.len(),
        "ttl_seconds": ttl,
        "message": format!("Chat has {} tool servers enabled. These are chat-attached tool servers; if the required server is listed, use its loaded tools directly instead of activating or restarting it.", all_enabled_tools.len()),
    }))
}

const OAUTH_FLOW_POLL_INTERVAL_SECONDS: f64 = 2.0;
const OAUTH_FLOW_POLL_TIMEOUT_SECONDS: f64 = 600.0;

pub(super) async fn handle_authorize_integration(arguments: &Map<String, Value>) -> Result<Value> {
    let server_id = string_arg(arguments, "server_id")?
        .trim_start_matches("server:")
        .to_string();
    if server_id.is_empty() {
        bail!("server_id is required");
    }
    let force_auth = arguments
        .get("force_auth")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let chat_id = arguments
        .get("chat_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|chat_id| !chat_id.is_empty())
        .map(String::from);

    let mut trigger_payload = json!({
        "server_id": server_id,
        "force_auth": force_auth,
        "async": true,
    });
    if let Some(cid) = chat_id.as_deref() {
        trigger_payload["chat_id"] = Value::String(cid.to_string());
    }

    // Non-blocking: start the OAuth flow and get a flow_id back immediately
    let trigger_result = electron_post_json("/api/trigger-oauth-flow", &trigger_payload, 15.0)
        .await
        .unwrap_or_else(|error| json!({ "success": false, "error": error.to_string() }));

    // Synchronous fast-paths: already_authorized, errors, circuit breaker, etc.
    if trigger_result.get("success").and_then(Value::as_bool) == Some(true)
        && trigger_result.get("completed").and_then(Value::as_bool) == Some(true)
    {
        return handle_authorize_sync_success(&server_id, &trigger_result, chat_id.as_deref())
            .await;
    }

    // If the async flow was started, poll for completion
    if trigger_result.get("started").and_then(Value::as_bool) == Some(true) {
        let flow_id = trigger_result
            .get("flow_id")
            .and_then(Value::as_str)
            .unwrap_or("");
        if !flow_id.is_empty() {
            return poll_oauth_flow_status(&server_id, flow_id, chat_id.as_deref()).await;
        }
    }

    // Not started — synchronous error response (circuit breaker, contractor denied, etc.)
    handle_authorize_error(&server_id, &trigger_result, chat_id.as_deref()).await
}

async fn handle_authorize_sync_success(
    server_id: &str,
    result: &Value,
    chat_id: Option<&str>,
) -> Result<Value> {
    let already_authorized = result
        .get("already_authorized")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let post_auth = wait_for_post_auth_readiness(server_id, result).await;
    let phase = readiness_phase(&post_auth);
    let healthy = post_auth
        .get("healthy")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let waited_seconds = post_auth
        .get("waited_seconds")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);

    let mut auto_activated = false;
    let mut activation_error: Option<String> = None;
    if phase == READINESS_PHASE_TOOL_READY {
        if let Some(cid) = chat_id {
            match try_activate_for_chat(cid, server_id).await {
                Ok(true) => auto_activated = true,
                Ok(false) => {}
                Err(e) => activation_error = Some(e.to_string()),
            }
        }
    }

    let (message, next_steps) = authorize_integration_guidance(
        server_id,
        already_authorized,
        &phase,
        waited_seconds,
        auto_activated,
    );
    success_text(json!({
        "success": true,
        "completed": true,
        "healthy": healthy,
        "readiness_phase": phase,
        "already_authorized": already_authorized,
        "auto_activated": auto_activated,
        "activation_error": activation_error,
        "server_id": server_id,
        "waited_seconds": post_auth.get("waited_seconds").cloned().unwrap_or(Value::from(0.0)),
        "message": message,
        "next_steps": next_steps,
    }))
}

async fn poll_oauth_flow_status(
    server_id: &str,
    flow_id: &str,
    chat_id: Option<&str>,
) -> Result<Value> {
    let started = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs_f64(OAUTH_FLOW_POLL_TIMEOUT_SECONDS);
    let interval = std::time::Duration::from_secs_f64(OAUTH_FLOW_POLL_INTERVAL_SECONDS);

    loop {
        if started.elapsed() > timeout {
            return success_text(json!({
                "success": false,
                "completed": false,
                "server_id": server_id,
                "error": "OAuth flow timed out waiting for user interaction",
                "note": "User may have dismissed the dialog or OAuth failed.",
            }));
        }

        tokio::time::sleep(interval).await;

        let status = electron_get_json(&format!("/api/oauth-flow-status/{}", flow_id), 5.0)
            .await
            .unwrap_or_else(|e| json!({ "status": "error", "error": e.to_string() }));

        let flow_status = status
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown");

        if flow_status == "in_progress" {
            continue;
        }

        if flow_status == "completed" {
            let result = status.get("result").cloned().unwrap_or(json!({}));
            if result.get("success").and_then(Value::as_bool) == Some(true)
                && result.get("completed").and_then(Value::as_bool) == Some(true)
            {
                return handle_authorize_sync_success(server_id, &result, chat_id).await;
            }
            return handle_authorize_error(server_id, &result, chat_id).await;
        }

        return success_text(json!({
            "success": false,
            "completed": false,
            "server_id": server_id,
            "error": format!("Unexpected flow status: {}", flow_status),
            "note": "User may have dismissed the dialog or OAuth failed.",
        }));
    }
}

async fn handle_authorize_error(
    server_id: &str,
    result: &Value,
    chat_id: Option<&str>,
) -> Result<Value> {
    let phase = result
        .get("readiness_phase")
        .and_then(Value::as_str)
        .unwrap_or("");
    let error_code = result
        .get("errorCode")
        .and_then(Value::as_str)
        .unwrap_or("");
    let error_str = result.get("error").and_then(Value::as_str).unwrap_or("");
    if is_authorize_transport_error(error_str) {
        if let Some(recovered) =
            recover_authorize_transport_error(server_id, chat_id, ACTIVATION_POLL_INTERVAL_SECONDS)
                .await
        {
            return success_text(recovered);
        }
    }
    let is_disabled = phase == "disabled";
    let is_hard_disabled =
        error_code == "INTEGRATION_HARD_DISABLED" || is_server_hard_disabled(server_id);
    let is_circuit_breaker = error_code == "MAX_RETRIES_EXCEEDED";
    let is_contractor_denied = error_code == "CONTRACTOR_PERMISSIONS_DENIED";
    let is_transport_error = is_authorize_transport_error(error_str);

    let note = if is_circuit_breaker {
        "STOP. Circuit breaker tripped — do NOT retry. Inform the user and move on to other tasks."
    } else if is_contractor_denied {
        "Contractor permissions issue. Inform the user about the permissions request process. The integration remains enabled — do NOT toggle it off and on."
    } else if is_hard_disabled {
        "STOP. This integration was hard-disabled by the user. Do NOT call toggle_integration or retry authorize — only the user can re-enable it from the Control Plane."
    } else if is_disabled {
        "Server is DISABLED. Call mcp_assistant_toggle_integration first, then retry authorize."
    } else if is_transport_error {
        "Transient infrastructure error. The server is still starting. Wait a few seconds and call authorize_integration again."
    } else {
        "User may have dismissed the dialog or OAuth failed."
    };

    success_text(json!({
        "success": false,
        "completed": result.get("completed").cloned().unwrap_or(Value::Bool(false)),
        "dismissed": result.get("dismissed").cloned().unwrap_or(Value::Bool(false)),
        "server_id": server_id,
        "readiness_phase": if is_circuit_breaker { "circuit_breaker" } else { phase },
        "errorCode": error_code,
        "transient_error": is_transport_error,
        "error": result.get("error").cloned().unwrap_or(Value::String("OAuth flow failed".to_string())),
        "message": if is_transport_error {
            Value::String(format!(
                "Authorization for {} failed due to a transient infrastructure restart. Wait a few seconds and retry.",
                server_id
            ))
        } else {
            result.get("message").cloned().unwrap_or(Value::String("OAuth authorization was not completed.".to_string()))
        },
        "note": note,
    }))
}

async fn try_activate_for_chat(chat_id: &str, server_id: &str) -> Result<bool> {
    let tool_id = format!("server:{}", server_id.trim_start_matches("server:"));
    with_chat_capabilities_lock(chat_id, || {
        let chat_id = chat_id.to_string();
        let tool_id = tool_id.clone();
        async move {
            let redis_key = format!("chat_tools:{chat_id}");
            let existing_tools = redis_get_string(&redis_key)?
                .map(|raw| serde_json::from_str::<Vec<String>>(&raw).unwrap_or_default())
                .unwrap_or_default();
            if existing_tools.contains(&tool_id) {
                return Ok(true);
            }
            let mut all_tools = existing_tools;
            all_tools.push(tool_id);
            let encoded = serde_json::to_string(&all_tools)?;
            redis_setex_string(&redis_key, &encoded, SKILL_TTL_SECONDS)?;
            let _ = maybe_notify_chat_tools(&chat_id, &all_tools, true).await;
            Ok(true)
        }
    })
    .await
}

pub(super) async fn handle_trigger_guided_setup(arguments: &Map<String, Value>) -> Result<Value> {
    let server_id = string_arg(arguments, "server_id")?;
    let mut payload = Map::new();
    payload.insert("server_id".to_string(), Value::String(server_id.clone()));
    if let Some(chat_id) = arguments
        .get("chat_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|chat_id| !chat_id.is_empty())
    {
        payload.insert("chat_id".to_string(), Value::String(chat_id.to_string()));
    }
    if let Some(reason) = arguments.get("reason").cloned() {
        payload.insert("reason".to_string(), reason);
    }
    let result = electron_post_json("/api/trigger-guided-setup", &Value::Object(payload), 120.0)
        .await
        .unwrap_or_else(|error| json!({ "success": false, "error": error.to_string() }));
    let success = result
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let completed = result
        .get("completed")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let phase = readiness_phase(&result);
    let mut payload = json!({
        "success": success,
        "completed": completed,
        "healthy": result.get("healthy").and_then(Value::as_bool).unwrap_or(false),
        "readiness_phase": phase,
        "server_id": server_id,
        "outcome": result.get("outcome").cloned().unwrap_or(Value::Null),
        "dismissed": result.get("dismissed").cloned().unwrap_or(Value::Bool(false)),
        "test_failed": result.get("test_failed").cloned().unwrap_or(Value::Bool(false)),
        "redirected_to_chat": result.get("redirected_to_chat").cloned().unwrap_or(Value::Bool(false)),
        "errorCode": result.get("errorCode").cloned().unwrap_or(Value::Null),
        "configurationIssue": result.get("configurationIssue").cloned().unwrap_or(Value::Null),
        "requiredAction": result.get("requiredAction").cloned().unwrap_or(Value::Null),
        "recoveryPrompt": result.get("recoveryPrompt").cloned().unwrap_or(Value::Null),
        "recoveryLabel": result.get("recoveryLabel").cloned().unwrap_or(Value::Null),
        "error": result.get("error").cloned().unwrap_or(Value::Null),
        "message": result.get("message").cloned().unwrap_or(Value::String("Guided setup finished".to_string())),
    });
    if success && completed {
        let (message, next_steps) = guided_setup_guidance(
            &server_id,
            payload["readiness_phase"].as_str().unwrap_or(""),
        );
        let object = payload.as_object_mut().expect("guided payload object");
        object.insert("message".to_string(), Value::String(message));
        object.insert(
            "next_steps".to_string(),
            Value::Array(next_steps.into_iter().map(Value::String).collect()),
        );
    } else if payload.get("redirected_to_chat").and_then(Value::as_bool) == Some(true) {
        let object = payload.as_object_mut().expect("guided payload object");
        object.insert(
            "message".to_string(),
            Value::String(format!(
                "The user chose to continue {} setup in a new chat. This form was not dismissed and setup was not completed here.",
                server_id
            )),
        );
    } else if payload.get("test_failed").and_then(Value::as_bool) == Some(true) {
        let object = payload.as_object_mut().expect("guided payload object");
        object.insert(
            "message".to_string(),
            result.get("message").cloned().unwrap_or_else(|| {
                Value::String(format!(
                    "The configuration test failed for {}. The user did not dismiss the form.",
                    server_id
                ))
            }),
        );
        object.insert(
            "note".to_string(),
            Value::String(
                "Treat this as a test failure, not a user dismissal. Follow the returned safe recovery fields and do not infer raw credential values."
                    .to_string(),
            ),
        );
    } else if payload.get("dismissed").and_then(Value::as_bool) == Some(true) {
        let object = payload.as_object_mut().expect("guided payload object");
        object.insert(
            "message".to_string(),
            Value::String(format!(
                "User dismissed the configuration form for {}. The server remains unconfigured.",
                server_id
            )),
        );
        object.insert(
            "note".to_string(),
            Value::String(
                "The user can configure it later via Control Plane → Integrations, or ask you to try again."
                    .to_string(),
            ),
        );
    } else if !success {
        let error_code = result
            .get("errorCode")
            .and_then(Value::as_str)
            .unwrap_or("");
        let error_str = result.get("error").and_then(Value::as_str).unwrap_or("");
        let object = payload.as_object_mut().expect("guided payload object");
        if error_code == "MAX_RETRIES_EXCEEDED" {
            object.insert(
                "readiness_phase".to_string(),
                Value::String("circuit_breaker".to_string()),
            );
            object.insert(
                "errorCode".to_string(),
                Value::String(error_code.to_string()),
            );
            object.insert(
                "note".to_string(),
                Value::String(
                    "STOP. Circuit breaker tripped — do NOT retry. Inform the user and move on."
                        .to_string(),
                ),
            );
        }
        let is_transport_error = error_str.contains("Server disconnected")
            || error_str.contains("Expected HTTP/")
            || error_str.contains("RTSP/")
            || error_str.contains("nginx")
            || error_str.contains("502 Bad Gateway")
            || error_str.contains("500 Internal Server Error");
        if is_transport_error {
            object.insert(
                "message".to_string(),
                Value::String(format!(
                    "Guided setup for {} failed due to a transient infrastructure restart. \
                     Wait a few seconds and retry once.",
                    server_id
                )),
            );
            object.insert("transient_error".to_string(), Value::Bool(true));
        } else {
            object.insert(
                "message".to_string(),
                Value::String(format!("Guided setup was not completed for {}", server_id)),
            );
        }
    }
    success_text(payload)
}

pub(super) async fn handle_get_mcp_server_logs(arguments: &Map<String, Value>) -> Result<Value> {
    let requested_server_id = string_arg(arguments, "server_id")?;
    let server_id = bare_server_id(&requested_server_id).to_string();
    let lines = clamp_log_lines(int_arg(arguments, "lines", 200));
    if !mcp_server_logs_server_known(&server_id) {
        return success_text(mcp_server_logs_not_found_payload(&server_id, lines));
    }

    let result = electron_get_json_preserving_error_body(
        &format!("/api/mcp-server-logs/{}?lines={lines}", server_id),
        15.0,
    )
    .await
    .map(|response| {
        if response.status.is_success() {
            response.json.unwrap_or_else(|| {
                json!({
                    "success": false,
                    "server_id": server_id,
                    "error": format!("Failed to decode GET /api/mcp-server-logs/{}?lines={} response", server_id, lines),
                })
            })
        } else {
            let error_code = response
                .json
                .as_ref()
                .and_then(|body| body.get("code").and_then(Value::as_str));
            if response.status.as_u16() == 404 || error_code == Some("server_not_found") {
                mcp_server_logs_not_found_payload(&server_id, lines)
            } else {
                mcp_server_logs_fetch_failed_payload(&server_id, lines)
            }
        }
    })
    .unwrap_or_else(|error| {
        let message = if error.is_connect() {
            "Cannot connect to the local app service.".to_string()
        } else if error.is_timeout() {
            format!("Timed out fetching logs for {server_id}.")
        } else {
            "Unable to fetch MCP server logs.".to_string()
        };
        json!({
            "success": false,
            "code": "log_fetch_failed",
            "server_id": server_id,
            "logs": "",
            "log_source": Value::Null,
            "container_name": Value::Null,
            "error": message,
        })
    });

    let success = result
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let code = result.get("code").and_then(Value::as_str).unwrap_or("");
    let error = if success {
        result.get("error").cloned().unwrap_or(Value::Null)
    } else if code == "server_not_found" {
        Value::String("MCP server not found.".to_string())
    } else if code == "container_not_created" {
        result.get("error").cloned().unwrap_or_else(|| {
            Value::String(
                "The container was not created. Review the earlier startup failure for the primary cause."
                    .to_string(),
            )
        })
    } else {
        Value::String("Unable to fetch MCP server logs.".to_string())
    };
    let logs = if success {
        result
            .get("logs")
            .cloned()
            .unwrap_or(Value::String(String::new()))
    } else {
        Value::String(String::new())
    };

    success_text(json!({
        "success": success,
        "code": result.get("code").cloned().unwrap_or(Value::Null),
        "server_id": server_id,
        "lines": lines,
        "logs": logs,
        "log_source": result.get("log_source").cloned().unwrap_or(Value::Null),
        "container_name": result.get("container_name").cloned().unwrap_or(Value::Null),
        "error": error,
    }))
}

#[cfg(test)]
#[path = "mcp_assistant_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "mcp_assistant_parity_tests.rs"]
mod parity_tests;

#[cfg(test)]
#[path = "mcp_assistant_coverage_tests.rs"]
mod coverage_tests;
