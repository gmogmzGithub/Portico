use super::*;

pub async fn notify_capabilities_changed(chat_id: &str, cap_type: &str, items: &[String]) {
    let formatted = if cap_type == "tools" {
        items
            .iter()
            .map(|item| {
                let server_id = bare_server_id(item).to_string();
                let display_name = server_id
                    .split(|ch| ch == '-' || ch == '_')
                    .map(|word| {
                        let lower = word.to_lowercase();
                        if matches!(
                            lower.as_str(),
                            "mcp" | "vm" | "api" | "pdf" | "oauth" | "ai"
                        ) {
                            lower.to_uppercase()
                        } else {
                            let mut chars = word.chars();
                            match chars.next() {
                                Some(first) => {
                                    first.to_uppercase().collect::<String>() + chars.as_str()
                                }
                                None => String::new(),
                            }
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(" ");
                json!({
                    "server_id": server_id,
                    "display_name": display_name,
                    "icon_url": format!("/api/v1/chats/mcp/servers/{}/icon", bare_server_id(item)),
                })
            })
            .collect::<Vec<_>>()
    } else {
        items
            .iter()
            .map(|item| {
                json!({
                    "name": item,
                    "display_name": item
                        .split('/')
                        .map(|part| part.replace('-', " "))
                        .collect::<Vec<_>>()
                        .join(" / "),
                })
            })
            .collect::<Vec<_>>()
    };

    let _ = post_capabilities_changed(chat_id, cap_type, &formatted).await;
}

async fn post_capabilities_changed(
    chat_id: &str,
    cap_type: &str,
    formatted: &[Value],
) -> Result<()> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .context("failed to build capabilities client")?;
    client
        .post(format!(
            "{}/api/v1/chats/{}/capabilities-changed",
            openwebui_base_url(),
            chat_id
        ))
        .json(&json!({ cap_type: formatted }))
        .send()
        .await
        .context("failed to POST capabilities change")?;
    Ok(())
}

pub fn validate_server_id(server_id: &str, check_collision: bool) -> Result<()> {
    let valid = server_id
        .chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-' || ch == '_');
    if !valid {
        bail!(
            "Invalid server ID: {}. Only lowercase letters, numbers, hyphens, and underscores are allowed.",
            server_id
        );
    }
    if !(3..=50).contains(&server_id.len()) {
        bail!(
            "Server ID must be between 3 and 50 characters (got {})",
            server_id.len()
        );
    }
    if check_collision {
        let system_path = mcp_configs_dir()?.join(server_id);
        if system_path.exists() {
            bail!(
                "Server ID '{}' collides with existing system-delivered server. Please choose a different name.",
                server_id
            );
        }
    }
    Ok(())
}

pub fn user_server_path(server_id: &str) -> Result<PathBuf> {
    validate_server_id(server_id, true)?;
    let base = mcp_configs_user_dir()?;
    Ok(base.join(server_id))
}

pub fn system_server_path(server_id: &str) -> Result<PathBuf> {
    validate_server_id(server_id, false)?;
    Ok(mcp_configs_dir()?.join(server_id))
}

fn configured_server_ids_in_dir(base_dir: &Path, ids: &mut HashSet<String>) -> Result<()> {
    if !base_dir.exists() {
        return Ok(());
    }

    for entry in
        fs::read_dir(base_dir).with_context(|| format!("failed to list {}", base_dir.display()))?
    {
        let entry = match entry {
            Ok(value) => value,
            Err(_) => continue,
        };
        let is_dir = entry
            .file_type()
            .ok()
            .map(|kind| kind.is_dir())
            .unwrap_or(false);
        if !is_dir {
            continue;
        }
        let server_id = entry.file_name().to_string_lossy().to_string();
        let yaml_path = entry.path().join(format!("{server_id}.yaml"));
        if yaml_path.exists() {
            ids.insert(server_id);
        }
    }

    Ok(())
}

pub fn configured_server_ids() -> Result<HashSet<String>> {
    let mut ids = HashSet::new();
    configured_server_ids_in_dir(&mcp_configs_dir()?, &mut ids)?;
    configured_server_ids_in_dir(&mcp_configs_user_dir()?, &mut ids)?;
    Ok(ids)
}

pub fn sensitive_warnings(env_map: Option<&Map<String, Value>>) -> Vec<String> {
    let mut warnings = Vec::new();
    for key in env_map.into_iter().flat_map(|map| map.keys()) {
        let lower = key.to_lowercase();
        if ["token", "key", "secret", "password", "credential"]
            .iter()
            .any(|term| lower.contains(term))
        {
            warnings.push(format!(
                "Environment variable '{}' appears to be sensitive. Ensure the value is correct and secure.",
                key
            ));
        }
    }
    warnings
}

pub fn normalize_remote_public_oauth_fragment(
    fragment: &Map<String, Value>,
) -> Result<(Map<String, Value>, Vec<String>)> {
    let command = fragment
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let args = fragment
        .get("args")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    if !matches!(command.as_str(), "npx" | "pnpm" | "bunx" | "yarn") {
        return Ok((fragment.clone(), Vec::new()));
    }

    let remote_index = args.iter().position(|value| {
        value
            .as_str()
            .map(|value| value.contains("mcp-remote"))
            .unwrap_or(false)
    });
    let Some(remote_index) = remote_index else {
        return Ok((fragment.clone(), Vec::new()));
    };

    let remote_url = args
        .iter()
        .skip(remote_index + 1)
        .filter_map(Value::as_str)
        .find(|value| value.starts_with("http://") || value.starts_with("https://"))
        .map(str::to_string);
    let Some(remote_url) = remote_url else {
        return Ok((fragment.clone(), Vec::new()));
    };

    let metadata_index = args
        .iter()
        .position(|value| value.as_str() == Some("--static-oauth-client-metadata"));
    let Some(metadata_index) = metadata_index else {
        return Ok((fragment.clone(), Vec::new()));
    };
    let metadata_arg = args
        .get(metadata_index + 1)
        .and_then(Value::as_str)
        .unwrap_or("");
    if metadata_arg.is_empty() || metadata_arg.starts_with('@') {
        return Ok((fragment.clone(), Vec::new()));
    }

    let client_metadata: Value = serde_json::from_str(metadata_arg)
        .context("failed to decode static OAuth client metadata")?;
    let mut client_metadata = client_metadata
        .as_object()
        .cloned()
        .context("OAuth client metadata must be an object")?;
    client_metadata
        .entry("client_name".to_string())
        .or_insert_with(|| Value::String(DEFAULT_OAUTH_CLIENT_NAME.to_string()));
    client_metadata
        .entry("token_endpoint_auth_method".to_string())
        .or_insert_with(|| Value::String("none".to_string()));

    let parsed = reqwest::Url::parse(&remote_url).context("failed to parse remote URL")?;
    let server_url = format!(
        "{}://{}",
        parsed.scheme(),
        parsed.host_str().unwrap_or_default()
    );

    let mut normalized = Map::new();
    normalized.insert(
        "type".to_string(),
        Value::String("streamable-http".to_string()),
    );
    normalized.insert("url".to_string(), Value::String(remote_url.clone()));
    normalized.insert(
        "oauth".to_string(),
        json!({
            "server_url": server_url,
            "resource": remote_url,
            "client_metadata": Value::Object(client_metadata),
        }),
    );
    if let Some(env_map) = fragment.get("env").and_then(Value::as_object).cloned() {
        if !env_map.is_empty() {
            normalized.insert("env".to_string(), Value::Object(env_map));
        }
    }

    Ok((
        normalized,
        vec![
            "Normalized mcp-remote OAuth fragment to native streamable-http configuration"
                .to_string(),
        ],
    ))
}

fn runtime_file_target_from_config(
    source: &str,
    filename: Option<&str>,
    target: Option<&str>,
) -> Result<String> {
    if let Some(target) = target.map(str::trim).filter(|value| !value.is_empty()) {
        if filename
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some()
        {
            bail!("runtime_files target cannot be combined with filename");
        }
        return validate_runtime_file_target(target);
    }

    let filename = filename
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            std::path::Path::new(source)
                .file_name()
                .and_then(|value| value.to_str())
                .map(str::to_string)
        })
        .unwrap_or_default();
    if filename.is_empty()
        || filename == "."
        || filename == ".."
        || filename.contains('/')
        || filename.contains('\\')
    {
        bail!("runtime_files filename must be a simple filename");
    }

    Ok(format!("/app/runtime/{filename}"))
}

fn validate_runtime_file_target(target: &str) -> Result<String> {
    let target = target.trim();
    if target.is_empty() || !target.starts_with('/') {
        bail!("runtime_files target must be an absolute container file path");
    }
    if target.contains('\\') || target.contains(':') {
        bail!("runtime_files target contains unsupported characters");
    }

    let path = std::path::Path::new(target);
    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        bail!("runtime_files target must not contain '..'");
    }

    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if target.ends_with('/') || filename.is_empty() || filename == "." || filename == ".." {
        bail!("runtime_files target must include a file name");
    }

    Ok(target.to_string())
}

pub fn validate_user_yaml_config(yaml_config: &Map<String, Value>) -> Result<()> {
    let required = [
        "name",
        "id",
        "display_name",
        "deployment_type",
        "description",
    ];
    for key in required {
        let value = yaml_config
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        if value.is_empty() {
            bail!("YAML validation failed: '{}' is required", key);
        }
    }

    let deployment_type = yaml_config
        .get("deployment_type")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !matches!(deployment_type, "docker" | "host") {
        bail!("YAML validation failed: deployment_type must be 'docker' or 'host'");
    }

    let display_name = yaml_config
        .get("display_name")
        .and_then(Value::as_str)
        .unwrap_or("");
    if display_name
        .chars()
        .any(|ch| !(ch.is_ascii_alphanumeric() || ch == ' ' || ch == '-'))
    {
        bail!("YAML validation failed: display_name may only contain letters, numbers, spaces, and hyphens");
    }

    if yaml_config.get("user_installed").and_then(Value::as_bool) != Some(true) {
        bail!("user_installed must be true for user-installed servers");
    }
    if yaml_config.get("is_core").and_then(Value::as_bool) == Some(true) {
        bail!("User-installed servers cannot be core servers");
    }
    validate_required_env_vars(yaml_config)?;
    if let Some(runtime_files) = yaml_config.get("runtime_files").and_then(Value::as_array) {
        if !runtime_files.is_empty() {
            if deployment_type != "docker" {
                bail!("runtime_files are only supported for docker deployment");
            }
            let mut seen_targets = std::collections::BTreeSet::new();
            for entry in runtime_files {
                let Some(entry) = entry.as_object() else {
                    bail!("runtime_files entries must be objects");
                };
                if let Some(value) = entry.get("sensitive") {
                    if !value.is_boolean() {
                        bail!("runtime_files sensitive must be true or false");
                    }
                }
                let source = entry
                    .get("source")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .unwrap_or("");
                if source.is_empty() {
                    bail!("runtime_files source is required");
                }
                let target = runtime_file_target_from_config(
                    source,
                    entry.get("filename").and_then(Value::as_str),
                    entry.get("target").and_then(Value::as_str),
                )?;
                if !seen_targets.insert(target.clone()) {
                    bail!("Duplicate runtime_files target: {target}");
                }
            }
        }
    }
    Ok(())
}

pub const MAX_REQUIRED_ENV_VARS: usize = 32;
pub const MAX_REQUIRED_ENV_VAR_NAME_LEN: usize = 64;
pub const MAX_REQUIRED_ENV_VAR_TEXT_LEN: usize = 256;

fn required_env_var_name_is_sensitive(name: &str) -> bool {
    let normalized = name.trim().to_ascii_lowercase();
    let segments: Vec<&str> = normalized
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|segment| !segment.is_empty())
        .collect();
    let terminal_segment = segments.last().copied().unwrap_or("");
    let credential_hash = terminal_segment == "hash"
        && segments
            .iter()
            .rev()
            .nth(1)
            .is_some_and(|segment| {
                matches!(
                    *segment,
                    "password" | "pass" | "passwd" | "pwd" | "secret" | "token" | "key"
                )
            });
    matches!(
        terminal_segment,
        "token"
            | "key"
            | "secret"
            | "password"
            | "credential"
            | "pat"
            | "pass"
            | "passwd"
            | "pwd"
            | "passphrase"
    )
        || credential_hash
        || normalized.ends_with("apikey")
        || normalized.ends_with("apitoken")
        || normalized.ends_with("token")
        || normalized.ends_with("secret")
        || normalized.ends_with("password")
        || normalized.ends_with("credential")
        || normalized.ends_with("privatekey")
}

/// Normalize `required_env_vars` in place: bare string entries ("FOO") become
/// the canonical object form ({"name": "FOO"}) used by bundled servers, names
/// are trimmed, and credential-shaped names fail closed to sensitive storage.
/// The latter keeps an incomplete model-generated declaration from routing a
/// secret through plaintext environment handling.
pub fn normalize_required_env_vars(yaml_config: &mut Map<String, Value>) {
    if let Some(Value::Array(entries)) = yaml_config.get_mut("required_env_vars") {
        for entry in entries.iter_mut() {
            if let Value::String(name) = entry {
                let mut object = Map::new();
                let name = name.trim().to_string();
                if required_env_var_name_is_sensitive(&name) {
                    object.insert("sensitive".to_string(), Value::Bool(true));
                }
                object.insert("name".to_string(), Value::String(name));
                *entry = Value::Object(object);
            } else if let Value::Object(object) = entry {
                if let Some(Value::String(name)) = object.get("name") {
                    let name = name.trim().to_string();
                    let sensitive = required_env_var_name_is_sensitive(&name);
                    object.insert("name".to_string(), Value::String(name));
                    if sensitive && !object.contains_key("sensitive") {
                        object.insert("sensitive".to_string(), Value::Bool(true));
                    }
                }
            }
        }
    }
}

/// Collect every `$NAME` / `${NAME}` reference from the fragment's string
/// values. envsubst expands both forms from the container environment when
/// the generated config is processed, so each referenced name must be
/// user-supplied (required_env_vars) or preset (preset_env_vars) — anything
/// else silently expands to an empty string at server start.
fn collect_fragment_env_references(value: &Value, names: &mut std::collections::BTreeSet<String>) {
    match value {
        Value::String(text) => {
            let bytes = text.as_bytes();
            let mut index = 0;
            while index < bytes.len() {
                if bytes[index] != b'$' {
                    index += 1;
                    continue;
                }
                let mut cursor = index + 1;
                let braced = cursor < bytes.len() && bytes[cursor] == b'{';
                if braced {
                    cursor += 1;
                }
                let name_start = cursor;
                while cursor < bytes.len()
                    && (bytes[cursor].is_ascii_alphanumeric() || bytes[cursor] == b'_')
                {
                    cursor += 1;
                }
                let name = &text[name_start..cursor];
                let valid_start = name
                    .chars()
                    .next()
                    .is_some_and(|ch| ch.is_ascii_alphabetic() || ch == '_');
                if braced {
                    if valid_start && cursor < bytes.len() && bytes[cursor] == b'}' {
                        names.insert(name.to_string());
                        cursor += 1;
                    }
                } else if valid_start {
                    names.insert(name.to_string());
                }
                index = cursor.max(index + 1);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_fragment_env_references(item, names);
            }
        }
        Value::Object(object) => {
            for item in object.values() {
                collect_fragment_env_references(item, names);
            }
        }
        _ => {}
    }
}

fn declared_env_var_names(yaml_config: &Map<String, Value>) -> std::collections::BTreeSet<String> {
    let mut names = std::collections::BTreeSet::new();
    for key in ["required_env_vars", "preset_env_vars"] {
        if let Some(entries) = yaml_config.get(key).and_then(Value::as_array) {
            for entry in entries {
                let name = entry
                    .get("name")
                    .and_then(Value::as_str)
                    .or_else(|| entry.as_str())
                    .unwrap_or("")
                    .trim();
                if !name.is_empty() {
                    names.insert(name.to_string());
                }
            }
        }
    }
    names
}

/// Enforce the declared-secret contract for user-installed servers: every
/// env-var reference in the fragment must be declared, otherwise envsubst
/// expands it to an empty string at start (PORTICO-224 blank-credential bug).
pub fn validate_fragment_env_references(
    fragment: &Map<String, Value>,
    yaml_config: &Map<String, Value>,
) -> Result<()> {
    let mut referenced = std::collections::BTreeSet::new();
    collect_fragment_env_references(&Value::Object(fragment.clone()), &mut referenced);
    if referenced.is_empty() {
        return Ok(());
    }
    let declared = declared_env_var_names(yaml_config);
    let missing: Vec<String> = referenced.difference(&declared).cloned().collect();
    if !missing.is_empty() {
        bail!(
            "Fragment references undeclared environment variables: {}. Declare each in yaml_config.required_env_vars (objects like {{\"name\": \"{}\", \"sensitive\": true}}) so the user is asked for a value — otherwise it expands to an empty string at server start. On update, yaml_config replaces the whole file: resend the complete required_env_vars list.",
            missing.join(", "),
            missing[0]
        );
    }
    Ok(())
}

fn is_valid_env_var_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() || first == '_' => {}
        _ => return false,
    }
    chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

/// Validate normalized `required_env_vars` entries for user-installed servers.
/// Entries declare env vars the user must supply via the Configure flow; names
/// are written as KEY=value env lines and consumed by envsubst, so the POSIX
/// name rule is load-bearing.
fn validate_required_env_vars(yaml_config: &Map<String, Value>) -> Result<()> {
    let Some(value) = yaml_config.get("required_env_vars") else {
        return Ok(());
    };
    let Some(entries) = value.as_array() else {
        bail!("YAML validation failed: required_env_vars must be a list");
    };
    if entries.len() > MAX_REQUIRED_ENV_VARS {
        bail!(
            "YAML validation failed: required_env_vars supports at most {} entries",
            MAX_REQUIRED_ENV_VARS
        );
    }
    let mut seen_names = std::collections::BTreeSet::new();
    for entry in entries {
        let Some(entry) = entry.as_object() else {
            bail!(
                "YAML validation failed: each required_env_vars entry must be an object like {{\"name\": \"MY_API_KEY\", \"sensitive\": true}}"
            );
        };
        let name = entry
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        if name.is_empty() {
            bail!(
                "YAML validation failed: required_env_vars entries need a non-empty string 'name'"
            );
        }
        if name.len() > MAX_REQUIRED_ENV_VAR_NAME_LEN {
            bail!(
                "YAML validation failed: required_env_vars name '{}' exceeds {} characters",
                name,
                MAX_REQUIRED_ENV_VAR_NAME_LEN
            );
        }
        if !is_valid_env_var_name(name) {
            bail!(
                "YAML validation failed: required_env_vars name '{}' must match [A-Za-z_][A-Za-z0-9_]* (it becomes an environment variable)",
                name
            );
        }
        if !seen_names.insert(name.to_string()) {
            bail!(
                "YAML validation failed: duplicate required_env_vars name '{}'",
                name
            );
        }
        for key in entry.keys() {
            match key.as_str() {
                "name" | "placeholder" | "description" | "sensitive" => {}
                other => bail!(
                    "YAML validation failed: unknown required_env_vars key '{}' (allowed: name, placeholder, description, sensitive)",
                    other
                ),
            }
        }
        for text_key in ["placeholder", "description"] {
            if let Some(text_value) = entry.get(text_key) {
                let Some(text) = text_value.as_str() else {
                    bail!(
                        "YAML validation failed: required_env_vars '{}' must be a string",
                        text_key
                    );
                };
                if text.len() > MAX_REQUIRED_ENV_VAR_TEXT_LEN {
                    bail!(
                        "YAML validation failed: required_env_vars '{}' exceeds {} characters",
                        text_key,
                        MAX_REQUIRED_ENV_VAR_TEXT_LEN
                    );
                }
            }
        }
        if let Some(sensitive) = entry.get("sensitive") {
            if !sensitive.is_boolean() {
                bail!("YAML validation failed: required_env_vars 'sensitive' must be a boolean");
            }
        }
    }
    Ok(())
}

pub fn validate_fragment(fragment: &Map<String, Value>) -> Result<Vec<String>> {
    let is_http = fragment.get("type").and_then(Value::as_str).is_some();
    let is_stdio = fragment.get("command").and_then(Value::as_str).is_some();
    if is_http == is_stdio {
        bail!("Fragment must be either stdio-based (command + args) or HTTP-based (type + url)");
    }

    let mut warnings = sensitive_warnings(fragment.get("env").and_then(Value::as_object));

    if is_stdio {
        let command = fragment
            .get("command")
            .and_then(Value::as_str)
            .context("Fragment validation failed: command is required")?;
        let args = fragment
            .get("args")
            .and_then(Value::as_array)
            .context("Fragment validation failed: args is required for stdio fragments")?;
        if command.chars().any(|ch| [';', '|', '&', '`'].contains(&ch)) {
            bail!("Command contains dangerous characters: {}", command);
        }
        if crate::is_package_manager_command(command) {
            crate::parse_managed_node_recipe(command, args)?;
        }
        return Ok(warnings);
    }

    let fragment_type = fragment
        .get("type")
        .and_then(Value::as_str)
        .context("Fragment validation failed: type is required")?;
    if !matches!(fragment_type, "streamable-http" | "sse") {
        bail!("Fragment validation failed: type must be 'streamable-http' or 'sse'");
    }
    let url = fragment
        .get("url")
        .and_then(Value::as_str)
        .context("Fragment validation failed: url is required")?;
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        bail!("URL must start with http:// or https://");
    }
    fragment
        .get("oauth")
        .and_then(Value::as_object)
        .map(|oauth| validate_oauth_fragment(oauth, &mut warnings))
        .transpose()?;
    Ok(warnings)
}

fn validate_oauth_fragment(oauth: &Map<String, Value>, warnings: &mut Vec<String>) -> Result<()> {
    let server_url = oauth
        .get("server_url")
        .and_then(Value::as_str)
        .context("OAuth server_url is required")?;
    if !(server_url.starts_with("http://") || server_url.starts_with("https://")) {
        bail!("OAuth server_url must start with http:// or https://");
    }
    for field in ["scope", "authorization_endpoint", "token_endpoint"] {
        if oauth.contains_key(field) {
            warnings.push(format!(
                "OAuth field '{}' should usually be auto-discovered from server metadata.",
                field
            ));
        }
    }
    Ok(())
}

pub fn sanitize_fragment_for_display(fragment: &Map<String, Value>) -> Map<String, Value> {
    let mut sanitized = fragment.clone();
    if let Some(env_map) = fragment.get("env").and_then(Value::as_object) {
        let redacted = env_map
            .iter()
            .map(|(key, value)| {
                let lower = key.to_lowercase();
                let redacted = if ["token", "key", "secret", "password", "credential"]
                    .iter()
                    .any(|term| lower.contains(term))
                {
                    Value::String("***REDACTED***".to_string())
                } else {
                    value.clone()
                };
                (key.clone(), redacted)
            })
            .collect::<Map<_, _>>();
        sanitized.insert("env".to_string(), Value::Object(redacted));
    }
    sanitized
}

pub fn check_user_server_limit() -> Result<()> {
    let base = mcp_configs_user_dir()?;
    if !base.exists() {
        return Ok(());
    }
    let count = fs::read_dir(base)?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| entry.file_type().ok().map(|kind| kind.is_dir()))
        .filter(|is_dir| *is_dir)
        .count();
    if count >= MAX_USER_MCP_SERVERS {
        bail!(
            "Maximum of {} user-installed servers reached. Delete some servers before creating more.",
            MAX_USER_MCP_SERVERS
        );
    }
    Ok(())
}

pub async fn get_server_readiness(server_id: &str) -> Value {
    match electron_get_json(
        &format!("/api/server-readiness/{}", bare_server_id(server_id)),
        15.0,
    )
    .await
    {
        Ok(mut value) => {
            if let Some(object) = value.as_object_mut() {
                object.insert(
                    "server_id".to_string(),
                    Value::String(bare_server_id(server_id).to_string()),
                );
            }
            value
        }
        Err(error) => json!({
            "success": false,
            "server_id": bare_server_id(server_id),
            "healthy": false,
            "readiness_phase": READINESS_PHASE_STARTING,
            "error": error.to_string(),
        }),
    }
}

pub fn readiness_phase(value: &Value) -> String {
    value
        .get("readiness_phase")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| {
            if value
                .get("healthy")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                READINESS_PHASE_TOOL_READY.to_string()
            } else {
                READINESS_PHASE_STARTING.to_string()
            }
        })
}

pub fn server_visible(readiness: &Value) -> bool {
    readiness.get("deployment_type").and_then(Value::as_str) == Some("host")
        || readiness.get("discovered").and_then(Value::as_bool) == Some(true)
        || readiness.get("openapi_available").and_then(Value::as_bool) == Some(true)
        || readiness
            .get("tools_count")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            > 0
        || readiness
            .get("total_paths")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            > 0
        || [
            "probe_status",
            "proxy_probe_ok",
            "proxy_probe_status",
            "proxy_probe_tool_path",
            "proxy_probe_error",
        ]
        .iter()
        .any(|key| readiness.get(*key).is_some())
}

pub fn should_wait_for_tool_ready(readiness: &Value) -> bool {
    let phase = readiness_phase(readiness);
    matches!(
        phase.as_str(),
        READINESS_PHASE_STARTING | READINESS_PHASE_CHECKING_TOKENS
    ) && server_visible(readiness)
}

pub async fn wait_for_server_tool_ready(server_id: &str, timeout_seconds: f64) -> Value {
    let started_at = now_epoch_seconds();
    let bare = bare_server_id(server_id).to_string();
    let mut readiness = get_server_readiness(&bare).await;
    loop {
        let waited = (now_epoch_seconds() - started_at).max(0.0);
        let phase = readiness_phase(&readiness);
        if let Some(object) = readiness.as_object_mut() {
            object.insert("server_id".to_string(), Value::String(bare.clone()));
            object.insert(
                "waited_seconds".to_string(),
                Value::from((waited * 10.0).round() / 10.0),
            );
            object.insert("readiness_phase".to_string(), Value::String(phase.clone()));
        }
        if readiness
            .get("healthy")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            && phase == READINESS_PHASE_TOOL_READY
        {
            return readiness;
        }
        if waited >= timeout_seconds || !should_wait_for_tool_ready(&readiness) {
            return readiness;
        }
        tokio::time::sleep(std::time::Duration::from_secs_f64(
            ACTIVATION_POLL_INTERVAL_SECONDS.min((timeout_seconds - waited).max(0.1)),
        ))
        .await;
        readiness = get_server_readiness(&bare).await;
    }
}

pub fn blocked_integration(tool_server_id: &str, readiness: &Value) -> Value {
    let phase = readiness_phase(readiness);
    let healthy = readiness
        .get("healthy")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let visible = server_visible(readiness);
    let is_missing = phase == READINESS_PHASE_SERVICE_NOT_FOUND;
    let actively_starting = matches!(
        phase.as_str(),
        READINESS_PHASE_STARTING | READINESS_PHASE_CHECKING_TOKENS
    ) && visible;
    let needs_oauth = matches!(
        phase.as_str(),
        READINESS_PHASE_NEEDS_OAUTH | READINESS_PHASE_WAITING_CALLBACK
    );
    let is_disabled = phase == READINESS_PHASE_DISABLED;
    // PORTICO-410: hard-disabled dependencies get their own recovery hint so
    // downstream guidance never tells the model to toggle them back on.
    let is_hard_disabled =
        readiness.get("error").and_then(Value::as_str) == Some("integration_hard_disabled");
    let restart_recommended =
        !healthy && !actively_starting && !needs_oauth && !is_disabled && !is_missing;
    let recovery_hint = if is_missing {
        "integration_missing"
    } else if needs_oauth {
        "oauth_required"
    } else if is_hard_disabled {
        "integration_hard_disabled"
    } else if is_disabled {
        "integration_disabled"
    } else if actively_starting {
        "still_starting"
    } else if restart_recommended {
        "restart_recommended"
    } else {
        "not_ready"
    };
    json!({
        "tool_server_id": tool_server_id,
        "server_id": bare_server_id(tool_server_id),
        "healthy": healthy,
        "readiness_phase": phase,
        "waited_seconds": readiness.get("waited_seconds").cloned().unwrap_or(Value::from(0.0)),
        "server_visible": visible,
        "actively_starting": actively_starting,
        "restart_recommended": restart_recommended,
        "recovery_hint": recovery_hint,
        "error": readiness.get("error").cloned().unwrap_or(Value::Null),
    })
}

pub fn activation_next_steps(blocked_integrations: &[Value], skill_mode: bool) -> Vec<String> {
    let mut next_steps = if skill_mode {
        vec!["Do NOT rely on this skill's MCP-backed actions yet.".to_string()]
    } else {
        vec!["Do NOT call the integration's tools yet.".to_string()]
    };
    if blocked_integrations.iter().any(|item| {
        item.get("recovery_hint").and_then(Value::as_str) == Some("integration_missing")
    }) {
        next_steps.push(if skill_mode {
            "If a required MCP server reports readiness_phase=service_not_found, do NOT retry activation or wait. Install the missing server first or fix the skill to use an installed dependency.".to_string()
        } else {
            "If a blocked integration reports readiness_phase=service_not_found, do NOT retry activation or wait. Install the missing server first or correct the requested server_id.".to_string()
        });
    }
    if blocked_integrations.iter().any(|item| {
        item.get("recovery_hint").and_then(Value::as_str) == Some("integration_hard_disabled")
    }) {
        next_steps.push(if skill_mode {
            "If a required MCP server is hard-disabled, do NOT call toggle_integration or any other enable path — the user disabled it and only the user can re-enable it from the Control Plane. Continue without this skill or inform the user.".to_string()
        } else {
            "If a blocked integration is hard-disabled, do NOT call toggle_integration or any other enable path — only the user can re-enable it from the Control Plane. Continue the task without it.".to_string()
        });
    }
    if blocked_integrations.iter().any(|item| {
        item.get("recovery_hint").and_then(Value::as_str) == Some("integration_disabled")
    }) {
        next_steps.push(if skill_mode {
            "If a required MCP server is disabled, call mcp_assistant_toggle_integration(server_id=\"<server_id>\", enabled=true) first, then retry this skill activation.".to_string()
        } else {
            "If a blocked integration is disabled, call mcp_assistant_toggle_integration(server_id=\"<server_id>\", enabled=true) first, then retry activation.".to_string()
        });
    }
    if blocked_integrations
        .iter()
        .any(|item| item.get("recovery_hint").and_then(Value::as_str) == Some("oauth_required"))
    {
        next_steps.push(if skill_mode {
            "If a required server is in needs_oauth or waiting_callback, complete that integration's authorization first.".to_string()
        } else {
            "If readiness_phase is needs_oauth or waiting_callback, call mcp_assistant_authorize_integration first.".to_string()
        });
    }
    if blocked_integrations
        .iter()
        .any(|item| item.get("actively_starting").and_then(Value::as_bool) == Some(true))
    {
        next_steps.push(
            "If a blocked server is actively starting, tell the user it is still starting and retry later. Do NOT loop tight retries.".to_string(),
        );
    }
    if blocked_integrations
        .iter()
        .any(|item| item.get("restart_recommended").and_then(Value::as_bool) == Some(true))
    {
        next_steps.push(if skill_mode {
            "If a required server is not actively starting and has restart_recommended=true, use mcp_assistant_restart_mcp_server(server_id) as a last-resort recovery before retrying this skill.".to_string()
        } else {
            "If a blocked integration is not actively starting and has restart_recommended=true, try mcp_assistant_restart_mcp_server(server_id) as a last-resort recovery.".to_string()
        });
    }
    if next_steps.len() == 1 {
        next_steps.push(if skill_mode {
            "Inspect blocked_integrations for recovery_hint and resolve the MCP dependency state before retrying this skill.".to_string()
        } else {
            "Inspect blocked_integrations for recovery_hint and resolve the server state before retrying activation.".to_string()
        });
    }
    next_steps
}

pub fn activation_failure_message(blocked_integrations: &[Value], skill_mode: bool) -> String {
    if blocked_integrations.iter().any(|item| {
        item.get("recovery_hint").and_then(Value::as_str) == Some("integration_missing")
    }) {
        return if skill_mode {
            "One or more MCP servers required by this skill are not installed in this app."
                .to_string()
        } else {
            "One or more requested integrations are not installed in this app.".to_string()
        };
    }

    if blocked_integrations
        .iter()
        .any(|item| item.get("restart_recommended").and_then(Value::as_bool) == Some(true))
    {
        return if skill_mode {
            "One or more MCP servers required by this skill are not ready yet. At least one blocked dependency is not actively starting, so waiting longer will not fix it by itself.".to_string()
        } else {
            "One or more integrations are not ready for chat activation yet. At least one blocked server is not actively starting, so startup waiting will not fix it by itself.".to_string()
        };
    }

    if blocked_integrations
        .iter()
        .any(|item| item.get("recovery_hint").and_then(Value::as_str) == Some("oauth_required"))
    {
        return if skill_mode {
            "One or more MCP servers required by this skill are not ready yet because OAuth authorization is still required.".to_string()
        } else {
            "One or more integrations are not ready for chat activation yet because OAuth authorization is still required.".to_string()
        };
    }

    if blocked_integrations.iter().any(|item| {
        item.get("recovery_hint").and_then(Value::as_str) == Some("integration_hard_disabled")
    }) {
        return if skill_mode {
            "One or more MCP servers required by this skill were hard-disabled by the user and are unavailable. Do not attempt to enable them; only the user can re-enable them from the Control Plane.".to_string()
        } else {
            "One or more requested integrations were hard-disabled by the user and are unavailable. Do not attempt to enable them; only the user can re-enable them from the Control Plane.".to_string()
        };
    }

    if blocked_integrations.iter().any(|item| {
        item.get("recovery_hint").and_then(Value::as_str) == Some("integration_disabled")
    }) {
        return if skill_mode {
            "One or more MCP servers required by this skill are not ready yet because the dependency is disabled.".to_string()
        } else {
            "One or more integrations are not ready for chat activation yet because the server is disabled.".to_string()
        };
    }

    if skill_mode {
        format!(
            "One or more MCP servers required by this skill are not ready yet. skills_activate_skill already waited up to {:.0} seconds for visible servers in transitional readiness phases, but at least one dependency is still not tool_ready.",
            ACTIVATION_WAIT_SECONDS
        )
    } else {
        format!(
            "One or more integrations are not ready for chat activation yet. mcp_assistant_activate_integration already waited up to {:.0} seconds for visible servers in transitional readiness phases, but at least one server is still not tool_ready.",
            ACTIVATION_WAIT_SECONDS
        )
    }
}

#[cfg(test)]
#[path = "integration_tests.rs"]
mod tests;
