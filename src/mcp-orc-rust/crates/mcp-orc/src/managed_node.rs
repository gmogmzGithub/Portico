use std::collections::BTreeMap;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;

use anyhow::{anyhow, bail, Context, Result};
use chrono::Utc;
pub use core_mcp_shared::is_package_manager_command;
use core_mcp_shared::parse_managed_node_recipe;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio::process::Command as TokioCommand;

pub const MANAGED_NODE_SENTINEL_COMMAND: &str = "__portico_managed_node_package__";
pub const MANAGED_NODE_PACKAGE_KEY: &str = "managed_node_package";

const INTERNAL_NPM_REGISTRY_HOSTS: &[&str] = &["npm.artifacts.example.invalid"];
const INTERNAL_NPM_ARTIFACT_HOSTS: &[&str] = &["dl.artifacts.example.invalid"];
const INTERNAL_NPM_HARBOR_PATH: &str = "/harbor";
const INTERNAL_NPM_PROXY_PATH: &str = "/npm";
const INTERNAL_NPM_HARBOR_AUTH_PREFIX: &str = "//npm.artifacts.example.invalid/harbor/";
const INTERNAL_NPM_PROXY_AUTH_PREFIX: &str = "//npm.artifacts.example.invalid/npm/";

#[derive(Debug, Serialize)]
struct ManagedNodePreparationStatus {
    version: u8,
    updated_at: String,
    best_effort: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    deployment_type: Option<String>,
    prepared: Vec<ManagedNodePreparedPackage>,
    failures: BTreeMap<String, ManagedNodePreparationFailure>,
}

#[derive(Debug, Clone, Serialize)]
struct ManagedNodePreparedPackage {
    server_id: String,
    package_spec: String,
    package_name: String,
    timestamp: String,
}

#[derive(Debug, Clone, Serialize)]
struct ManagedNodePreparationFailure {
    server_id: String,
    package_spec: String,
    package_name: String,
    error: String,
    timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    deployment_type: Option<String>,
}

const RUNTIME_ENV_DENY_KEYS: &[&str] = &[
    "NODE_AUTH_TOKEN",
    "NPM_AUTH_TOKEN",
    "NPM_TOKEN",
    "NPM_CONFIG_USERCONFIG",
    "npm_config_userconfig",
    "NPM_CONFIG_GLOBALCONFIG",
    "npm_config_globalconfig",
    "NVM_NODEJS_ORG_MIRROR",
    "YARN_NPM_AUTH_TOKEN",
    "YARN_NPM_AUTH_IDENT",
    "COREPACK_NPM_TOKEN",
    "COREPACK_NPM_USERNAME",
    "COREPACK_NPM_PASSWORD",
    "BUN_AUTH_TOKEN",
];
const RUNTIME_ENV_DENY_PREFIXES: &[&str] = &[
    "npm_config_",
    "NPM_CONFIG_",
    "YARN_NPM_",
    "COREPACK_NPM_",
    "BUN_CONFIG_",
];

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct ManagedNodePackageConfig {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    pub server_id: String,
    #[serde(default = "default_package_manager")]
    pub package_manager: String,
    pub requested_spec: String,
    pub package_name: String,
    pub requested_range: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_integrity: Option<String>,
    #[serde(default)]
    pub runtime_args: Vec<String>,
    #[serde(default)]
    pub bin: Option<String>,
    #[serde(default)]
    pub install_dir: Option<String>,
    #[serde(default)]
    pub source: ManagedNodePackageSource,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct ManagedNodePackageSource {
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
}

fn default_schema_version() -> u32 {
    1
}

fn default_package_manager() -> String {
    "npm".to_string()
}

pub fn is_managed_node_sentinel(command: &str) -> bool {
    command == MANAGED_NODE_SENTINEL_COMMAND
}

pub fn normalize_fragment_for_managed_node(
    server_id: &str,
    fragment: &mut Value,
) -> Result<Option<ManagedNodePackageConfig>> {
    let object = fragment
        .as_object_mut()
        .ok_or_else(|| anyhow!("fragment must be a JSON object"))?;

    if object
        .get(MANAGED_NODE_PACKAGE_KEY)
        .and_then(Value::as_object)
        .is_some()
    {
        object.insert(
            "command".to_string(),
            Value::String(MANAGED_NODE_SENTINEL_COMMAND.to_string()),
        );
        object.insert("args".to_string(), Value::Array(Vec::new()));
        let config: ManagedNodePackageConfig = serde_json::from_value(
            object
                .get(MANAGED_NODE_PACKAGE_KEY)
                .cloned()
                .ok_or_else(|| anyhow!("managed_node_package is missing"))?,
        )
        .context("invalid managed_node_package config")?;
        return Ok(Some(config));
    }

    let command = object
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !is_package_manager_command(command) {
        return Ok(None);
    }

    let args = object
        .get("args")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let parsed = parse_managed_node_recipe(command, &args)?;
    let metadata = ManagedNodePackageConfig {
        schema_version: 1,
        server_id: server_id.to_string(),
        package_manager: "npm".to_string(),
        requested_spec: parsed.package_spec,
        package_name: parsed.package_name,
        requested_range: parsed.requested_range,
        resolved_version: None,
        resolved_integrity: None,
        runtime_args: parsed.runtime_args,
        bin: None,
        install_dir: None,
        source: ManagedNodePackageSource {
            command: parsed.command,
            args: parsed.args,
        },
    };

    object.insert(
        "command".to_string(),
        Value::String(MANAGED_NODE_SENTINEL_COMMAND.to_string()),
    );
    object.insert("args".to_string(), Value::Array(Vec::new()));
    object.insert(
        MANAGED_NODE_PACKAGE_KEY.to_string(),
        serde_json::to_value(&metadata)?,
    );

    Ok(Some(metadata))
}

pub fn prepared_managed_node_command(
    server_id: &str,
    config: &ManagedNodePackageConfig,
) -> Result<(String, Vec<String>)> {
    if config.schema_version != 1 {
        bail!(
            "package_prepare_failed: server '{server_id}' has unsupported managed Node package schema {}",
            config.schema_version
        );
    }
    if config.server_id != server_id {
        bail!(
            "package_prepare_failed: managed Node package metadata server mismatch: expected '{server_id}', got '{}'",
            config.server_id
        );
    }

    let store_root = managed_package_store_root();
    let install_root = config
        .install_dir
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            store_root
                .join(sanitize_server_id(server_id))
                .join("package")
        });
    let package_dir = package_dir(&install_root, &config.package_name);
    let package_json_path = package_dir.join("package.json");
    let package_json: Value = serde_json::from_str(
        &fs::read_to_string(&package_json_path).with_context(|| {
            format!(
                "package_prepare_failed: managed Node package for '{server_id}' is not prepared; missing {}",
                package_json_path.display()
            )
        })?,
    )
    .with_context(|| format!("invalid package.json at {}", package_json_path.display()))?;

    if let Some(name) = package_json.get("name").and_then(Value::as_str) {
        if name != config.package_name {
            bail!(
                "package_prepare_failed: installed package mismatch for '{server_id}': expected '{}', got '{name}'",
                config.package_name
            );
        }
    }

    let bin_path = resolve_package_bin(&package_json, &package_dir, config.bin.as_deref())?;
    let node = env::var("HOST_NODE_PATH")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| env::var("portico_NODE_BINARY").ok())
        .unwrap_or_else(|| "node".to_string());

    let mut args = vec![bin_path.to_string_lossy().to_string()];
    args.extend(config.runtime_args.clone());
    Ok((node, args))
}

pub fn scrub_package_manager_env(process: &mut TokioCommand) {
    for key in RUNTIME_ENV_DENY_KEYS {
        process.env_remove(key);
    }
    for (key, _) in env::vars() {
        if is_package_manager_runtime_env_key(&key) {
            process.env_remove(key);
        }
    }
}

pub fn scrub_package_manager_env_key(process: &mut TokioCommand, key: &str) {
    if is_package_manager_runtime_env_key(key) {
        process.env_remove(key);
    }
}

pub fn is_package_manager_runtime_env_key(key: &str) -> bool {
    RUNTIME_ENV_DENY_KEYS.contains(&key)
        || RUNTIME_ENV_DENY_PREFIXES
            .iter()
            .any(|prefix| key.starts_with(prefix))
}

pub fn managed_package_store_root() -> PathBuf {
    env::var("portico_MANAGED_NODE_MCP_PACKAGES_DIR")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join("open-webui-data")
                .join("managed-node-mcp-packages")
        })
}

fn managed_package_acquisition_root(project_root: &Path) -> PathBuf {
    env::var("portico_MANAGED_NODE_MCP_ACQUISITION_DIR")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            project_root
                .join("open-webui-data")
                .join("managed-node-mcp-package-acquisition")
        })
}

fn user_config_collides_with_system(
    project_root: &Path,
    config_dir_name: &str,
    server_id: &str,
) -> bool {
    config_dir_name == "mcp-configs-user"
        && project_root.join("mcp-configs").join(server_id).is_dir()
}

pub fn run_prepare_managed_node_packages(
    project_root: &Path,
    server_id_filter: Option<&str>,
    enabled_only: bool,
    deployment_type_filter: Option<&str>,
    best_effort: bool,
    status_file: Option<&Path>,
) -> Result<()> {
    let mut prepared = Vec::new();
    let mut failures = BTreeMap::new();
    let mut matched_server = false;
    for config_dir_name in ["mcp-configs", "mcp-configs-user"] {
        let config_dir = project_root.join(config_dir_name);
        if !config_dir.is_dir() {
            continue;
        }
        let mut server_dirs = fs::read_dir(&config_dir)
            .with_context(|| format!("failed to read {}", config_dir.display()))?
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
            .collect::<Vec<_>>();
        server_dirs.sort_by_key(|entry| entry.file_name());

        for entry in server_dirs {
            let server_id = entry.file_name().to_string_lossy().to_string();
            if user_config_collides_with_system(project_root, config_dir_name, &server_id) {
                continue;
            }
            if server_id_filter
                .map(|expected| expected != server_id)
                .unwrap_or(false)
            {
                continue;
            }
            let yaml_path = entry.path().join(format!("{server_id}.yaml"));
            let fragment_path = entry.path().join(format!("{server_id}.fragment"));
            if !yaml_path.is_file() && !fragment_path.is_file() {
                // Catalog directories may intentionally contain only an icon
                // (for example the tracked composio placeholder). They are not
                // server definitions and must not be subjected to enabled/core
                // checks that require a canonical YAML file.
                continue;
            }
            matched_server = true;
            if server_id_filter.is_none()
                && enabled_only
                && !should_prepare_enabled_server(
                    project_root,
                    &server_id,
                    &yaml_path,
                    config_dir_name == "mcp-configs-user",
                )?
            {
                // Toggle intent is authoritative for optional servers.
                // Do not inspect their fragment, YAML, or package recipe while
                // disabled; a broken dormant recipe must not affect startup.
                continue;
            }
            if !fragment_path.is_file() {
                continue;
            }
            if server_id_filter.is_none() {
                if let Some(expected_deployment_type) = deployment_type_filter {
                    let actual_deployment_type = yaml_deployment_type(&yaml_path)?;
                    if actual_deployment_type != expected_deployment_type {
                        continue;
                    }
                }
            }
            let mut failure_metadata: Option<ManagedNodePackageConfig> = None;
            let server_prepare_result = (|| -> Result<
                Option<(ManagedNodePreparedPackage, ManagedNodePackageConfig, Value)>,
            > {
                let mut fragment: Value = serde_json::from_str(
                    &fs::read_to_string(&fragment_path)
                        .with_context(|| format!("failed to read {}", fragment_path.display()))?,
                )
                .with_context(|| format!("invalid JSON in {}", fragment_path.display()))?;
                let original = fragment.clone();
                let mut metadata = normalize_fragment_for_managed_node(&server_id, &mut fragment)
                    .with_context(|| {
                    format!("failed to normalize managed Node package fragment for {server_id}")
                })?;
                let Some(ref mut metadata) = metadata else {
                    return Ok(None);
                };
                failure_metadata = Some(metadata.clone());

                if config_dir_name != "mcp-configs-user" && fragment != original {
                    bail!(
                        "package_prepare_failed: system server '{server_id}' uses a raw package-manager fragment; migrate it to managed metadata in the repo"
                    );
                }

                prepare_package(project_root, metadata)
                    .with_context(|| format!("package_prepare_failed:{server_id}"))?;

                if config_dir_name == "mcp-configs-user" {
                    if let Some(object) = fragment.as_object_mut() {
                        object.insert(
                            MANAGED_NODE_PACKAGE_KEY.to_string(),
                            serde_json::to_value(&metadata)?,
                        );
                    }
                }
                Ok(Some((
                    ManagedNodePreparedPackage {
                        server_id: server_id.clone(),
                        package_spec: metadata.requested_spec.clone(),
                        package_name: metadata.package_name.clone(),
                        timestamp: managed_node_status_timestamp(),
                    },
                    metadata.clone(),
                    fragment,
                )))
            })();

            match server_prepare_result {
                Ok(Some((prepared_entry, metadata, fragment))) => {
                    if config_dir_name == "mcp-configs-user" {
                        // Persisting app-owned fragment metadata is not a
                        // per-server acquisition failure. If these writes
                        // fail, startup must fail closed rather than claim the
                        // package was safely quarantined.
                        let metadata_path = entry.path().join("managed-package.json");
                        write_private_json(&metadata_path, &serde_json::to_value(&metadata)?)?;
                        write_private_json(&fragment_path, &fragment)?;
                    }
                    prepared.push(prepared_entry);
                }
                Ok(None) => {}
                Err(error) if best_effort => {
                    let failure = managed_node_preparation_failure(
                        &server_id,
                        failure_metadata.as_ref(),
                        error,
                        deployment_type_filter,
                    );
                    eprintln!(
                        "Managed Node package preparation failed for {}; continuing because --best-effort is enabled: {}",
                        server_id, failure.error
                    );
                    failures.insert(server_id.clone(), failure);
                }
                Err(error) => return Err(error),
            }
        }
    }

    if let Some(server_id) = server_id_filter {
        if !matched_server {
            bail!("package_prepare_failed: MCP server '{server_id}' was not found");
        }
    }

    write_managed_node_preparation_status(
        status_file,
        best_effort,
        deployment_type_filter,
        prepared.clone(),
        failures.clone(),
    )?;

    eprintln!(
        "Prepared {} managed Node MCP package(s){}",
        prepared.len(),
        if failures.is_empty() {
            String::new()
        } else {
            format!("; {} failed", failures.len())
        }
    );
    Ok(())
}

fn managed_node_status_timestamp() -> String {
    Utc::now().to_rfc3339()
}

fn managed_node_preparation_failure(
    server_id: &str,
    metadata: Option<&ManagedNodePackageConfig>,
    error: anyhow::Error,
    deployment_type: Option<&str>,
) -> ManagedNodePreparationFailure {
    ManagedNodePreparationFailure {
        server_id: server_id.to_string(),
        package_spec: metadata
            .map(|value| value.requested_spec.clone())
            .unwrap_or_else(|| "unknown".to_string()),
        package_name: metadata
            .map(|value| value.package_name.clone())
            .unwrap_or_else(|| "unknown".to_string()),
        error: sanitize_managed_node_status_error(&format!("{error:#}")),
        timestamp: managed_node_status_timestamp(),
        deployment_type: deployment_type.map(|value| value.to_string()),
    }
}

fn sanitize_managed_node_status_error(error: &str) -> String {
    let mut sanitized = error
        .replace('\n', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if sanitized.len() > 1000 {
        sanitized.truncate(1000);
        sanitized.push_str("...");
    }
    sanitized
}

fn write_managed_node_preparation_status(
    status_file: Option<&Path>,
    best_effort: bool,
    deployment_type: Option<&str>,
    prepared: Vec<ManagedNodePreparedPackage>,
    failures: BTreeMap<String, ManagedNodePreparationFailure>,
) -> Result<()> {
    let Some(status_file) = status_file else {
        return Ok(());
    };
    let status = ManagedNodePreparationStatus {
        version: 1,
        updated_at: managed_node_status_timestamp(),
        best_effort,
        deployment_type: deployment_type.map(|value| value.to_string()),
        prepared,
        failures,
    };
    write_private_json(status_file, &serde_json::to_value(status)?)
}

fn should_prepare_enabled_server(
    project_root: &Path,
    server_id: &str,
    yaml_path: &Path,
    is_user_server: bool,
) -> Result<bool> {
    let toggles_path = project_root.join("mcp_toggles.json");
    if let Ok(content) = fs::read_to_string(&toggles_path) {
        if let Ok(Value::Object(toggles)) = serde_json::from_str::<Value>(&content) {
            if let Some(value) = toggles.get(server_id).and_then(Value::as_bool) {
                return Ok(value);
            }
        }
    }

    if !is_user_server && yaml_declares_core_server(yaml_path)? {
        return Ok(true);
    }

    Ok(false)
}

fn yaml_declares_core_server(yaml_path: &Path) -> Result<bool> {
    let content = fs::read_to_string(yaml_path)
        .with_context(|| format!("failed to read {}", yaml_path.display()))?;
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(value) = trimmed.strip_prefix("is_core:") {
            return Ok(matches!(
                value
                    .trim()
                    .trim_matches('"')
                    .trim_matches('\'')
                    .to_ascii_lowercase()
                    .as_str(),
                "true" | "1" | "yes" | "on"
            ));
        }
    }
    Ok(false)
}

fn yaml_deployment_type(yaml_path: &Path) -> Result<String> {
    let Ok(content) = fs::read_to_string(yaml_path) else {
        return Ok("docker".to_string());
    };
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(value) = trimmed.strip_prefix("deployment_type:") {
            let deployment_type = value
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .to_ascii_lowercase();
            return Ok(if deployment_type.is_empty() {
                "docker".to_string()
            } else {
                deployment_type
            });
        }
    }
    Ok("docker".to_string())
}

fn prepare_package(project_root: &Path, config: &mut ManagedNodePackageConfig) -> Result<()> {
    let store_root = env::var("portico_MANAGED_NODE_MCP_PACKAGES_DIR")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            project_root
                .join("open-webui-data")
                .join("managed-node-mcp-packages")
        });
    let runtime_server_root = store_root.join(sanitize_server_id(&config.server_id));
    cleanup_runtime_visible_install_scratch(&runtime_server_root)?;
    let install_root = config
        .install_dir
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| runtime_server_root.join("package"));
    let package_json = package_dir(&install_root, &config.package_name).join("package.json");
    if package_json.is_file() {
        let allowed_domains = managed_package_internal_domains();
        if let Some(disallowed_host) =
            first_disallowed_package_lock_host(&install_root, &allowed_domains)
        {
            let error = anyhow!(
                "cached managed Node package for {} has package-lock URL host '{disallowed_host}' outside managed install allowlist",
                config.requested_spec
            );
            return Err(cleanup_failed_managed_node_install(&install_root, error));
        }
        pin_metadata_to_installed_package(config, &install_root)?;
        return Ok(());
    }

    let direct_npm = env::var("portico_MANAGED_NODE_DIRECT_NPM")
        .ok()
        .map(|value| matches!(value.trim(), "1" | "true" | "TRUE" | "yes" | "YES"))
        .unwrap_or(false);
    let sandbox_cli = env::var("portico_MANAGED_NODE_SRT_CLI")
        .or_else(|_| env::var("SRT_CLI_PATH"))
        .ok();
    let sandbox_cli_js = env::var("portico_MANAGED_NODE_SRT_CLI_JS")
        .or_else(|_| env::var("HOST_MCP_SRT_CLI_JS"))
        .ok();
    let sandbox_runner_js = env::var("portico_MANAGED_NODE_SRT_RUNNER_JS")
        .or_else(|_| env::var("HOST_MCP_SRT_RUNNER_JS"))
        .ok()
        .or_else(|| {
            let candidate = project_root.join("src/scripts/srt-sandbox-runner.mjs");
            candidate
                .is_file()
                .then(|| candidate.to_string_lossy().to_string())
        });
    if !direct_npm && sandbox_cli.is_none() && sandbox_cli_js.is_none() {
        bail!("sandbox runtime CLI is required for managed Node package preparation");
    }
    let npm_bin_raw = env::var("portico_MANAGED_NODE_NPM_BIN").unwrap_or_else(|_| "npm".to_string());
    let node_for_srt_raw = env::var("HOST_NODE_PATH")
        .or_else(|_| env::var("portico_NODE_BINARY"))
        .ok();
    let (node_for_srt, npm_bin) = if direct_npm {
        let npm_path = resolve_managed_node_direct_npm_bin(&npm_bin_raw)?;
        let node_path =
            resolve_managed_node_direct_node_path(node_for_srt_raw.as_deref(), &npm_path)?;
        (
            node_path.to_string_lossy().to_string(),
            npm_path.to_string_lossy().to_string(),
        )
    } else {
        (
            node_for_srt_raw.unwrap_or_else(|| "node".to_string()),
            npm_bin_raw,
        )
    };
    let acquisition_root = managed_package_acquisition_root(project_root);
    if acquisition_root == store_root || acquisition_root.starts_with(&store_root) {
        bail!(
            "managed Node package acquisition directory must not live inside the runtime package store: {}",
            acquisition_root.display()
        );
    }
    let acquisition_server_root = acquisition_root.join(sanitize_server_id(&config.server_id));
    let cache_dir = acquisition_server_root.join("npm-cache");
    let home_dir = acquisition_server_root.join("home");
    let tmp_dir = acquisition_server_root.join("tmp");
    fs::create_dir_all(&install_root)?;
    fs::create_dir_all(&cache_dir)?;
    fs::create_dir_all(&home_dir)?;
    fs::create_dir_all(&tmp_dir)?;

    let npmrc_guard = TempNpmrc::new(write_temp_npmrc(
        project_root,
        &tmp_dir,
        &config.package_name,
    )?);
    let npmrc_path = npmrc_guard.path().to_path_buf();
    validate_internal_npm_registries(&npmrc_path)?;
    let npm_registry = effective_npm_registry(&npmrc_path, &config.package_name)?;
    let replace_registry_host = replace_registry_host_mode(&npm_registry);
    let allowed_domains = managed_package_allowed_domains(&npmrc_path)?;
    let node_path_shim_dir = create_managed_node_path_shim(&tmp_dir, &node_for_srt)?;
    let settings_path = tmp_dir.join("managed-node-install-srt-settings.json");
    write_private_json(
        &settings_path,
        &managed_package_install_sandbox_settings(
            project_root,
            &install_root,
            &cache_dir,
            &tmp_dir,
            &npmrc_path,
            &node_for_srt,
        )?,
    )?;

    let mut command = if direct_npm {
        let mut command = StdCommand::new(&npm_bin);
        append_npm_install_args(
            &mut command,
            &install_root,
            &cache_dir,
            &npmrc_path,
            &npm_registry,
            replace_registry_host,
            config,
        );
        command
    } else if cfg!(target_os = "macos") {
        let profile_path = tmp_dir.join("managed-node-install-no-keychain.sb");
        write_private_text(
            &profile_path,
            &managed_node_install_seatbelt_profile(project_root)?,
        )?;
        let runner_js = sandbox_runner_js.ok_or_else(|| {
            anyhow!("macOS managed Node package preparation requires srt-sandbox-runner.mjs")
        })?;
        let cli_js = sandbox_cli_js.as_ref().ok_or_else(|| {
            anyhow!("macOS managed Node package preparation requires HOST_MCP_SRT_CLI_JS")
        })?;
        let mut command = StdCommand::new(&node_for_srt);
        command
            .arg(runner_js)
            .arg("--settings")
            .arg(&settings_path)
            .arg("--srt-cli-js")
            .arg(cli_js)
            .arg("--append-profile")
            .arg(profile_path)
            .arg("--")
            .arg(&npm_bin);
        append_npm_install_args(
            &mut command,
            &install_root,
            &cache_dir,
            &npmrc_path,
            &npm_registry,
            replace_registry_host,
            config,
        );
        command
    } else {
        let sandbox_program;
        let mut sandbox_args: Vec<OsString> = Vec::new();
        if let Some(cli) = sandbox_cli {
            sandbox_program = OsString::from(cli);
        } else {
            sandbox_program = OsString::from(node_for_srt);
            sandbox_args.push(OsString::from(sandbox_cli_js.expect("checked above")));
        }
        sandbox_args.push(OsString::from("--settings"));
        sandbox_args.push(settings_path.as_os_str().to_os_string());
        sandbox_args.push(OsString::from(npm_bin));
        append_npm_install_os_args(
            &mut sandbox_args,
            &install_root,
            &cache_dir,
            &npmrc_path,
            &npm_registry,
            replace_registry_host,
            config,
        );
        let mut command = StdCommand::new(&sandbox_program);
        command.args(&sandbox_args);
        command
    };
    command
        .env_clear()
        .env("HOME", &home_dir)
        .env("TMPDIR", &tmp_dir)
        .env("NPM_CONFIG_USERCONFIG", &npmrc_path);
    let install_path = build_managed_node_install_path(node_path_shim_dir.as_deref());
    command.env("PATH", install_path);

    let install_result = (|| -> Result<()> {
        let status = command.status().with_context(|| {
            format!(
                "failed to run sandboxed npm install for {}",
                config.requested_spec
            )
        })?;
        if !status.success() {
            if let Some(disallowed_host) =
                first_disallowed_npm_log_host(&cache_dir, &allowed_domains)
            {
                bail!(
                    "sandboxed npm install for {} attempted disallowed host '{disallowed_host}' outside managed install allowlist",
                    config.requested_spec
                );
            }
            bail!(
                "sandboxed npm install failed for {} with status {status}",
                config.requested_spec
            );
        }
        if !package_json.is_file() {
            bail!(
                "sandboxed npm install completed but package is missing: {}",
                package_json.display()
            );
        }
        if let Some(disallowed_host) = first_disallowed_npm_log_host(&cache_dir, &allowed_domains) {
            bail!(
                "sandboxed npm install for {} attempted disallowed host '{disallowed_host}' outside managed install allowlist",
                config.requested_spec
            );
        }
        if let Some(disallowed_host) =
            first_disallowed_package_lock_host(&install_root, &allowed_domains)
        {
            bail!(
                "sandboxed npm install for {} wrote package-lock URL host '{disallowed_host}' outside managed install allowlist",
                config.requested_spec
            );
        }
        pin_metadata_to_installed_package(config, &install_root)?;
        Ok(())
    })();

    if let Err(error) = install_result {
        return Err(cleanup_failed_managed_node_install(&install_root, error));
    }
    Ok(())
}

fn managed_node_install_seatbelt_profile(project_root: &Path) -> Result<String> {
    let home = env::var("HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from);
    let mut lines = vec![
        "(deny mach-lookup (global-name \"com.apple.SecurityServer\"))".to_string(),
        "(deny mach-lookup (global-name \"com.apple.securityd.xpc\"))".to_string(),
        "(deny mach-lookup (global-name \"com.apple.securityd\"))".to_string(),
        "(deny process-exec (literal \"/usr/bin/security\"))".to_string(),
    ];

    let mut deny_read_subpaths = vec![
        project_root.join("mcpo-oauth-tokens"),
        project_root.join("open-webui-data").join("runtime-secrets"),
    ];
    let mut deny_read_literals = vec![
        project_root.join(".env"),
        project_root.join(".env.runtime"),
        project_root.join(".env.local"),
        project_root.join(".npmrc"),
    ];
    if let Some(home) = home {
        deny_read_subpaths.extend([
            home.join(".ssh"),
            home.join(".aws"),
            home.join(".config"),
            home.join("Library").join("Keychains"),
            home.join("Library")
                .join("Caches")
                .join("portico")
                .join("runtime-secrets"),
        ]);
        deny_read_literals.push(home.join(".npmrc"));
    }

    for path in deny_read_subpaths {
        lines.push(format!(
            "(deny file-read* (subpath {}))",
            seatbelt_string(&path)
        ));
        lines.push(format!(
            "(deny file-write* (subpath {}))",
            seatbelt_string(&path)
        ));
    }
    for path in deny_read_literals {
        lines.push(format!(
            "(deny file-read* (literal {}))",
            seatbelt_string(&path)
        ));
        lines.push(format!(
            "(deny file-write* (literal {}))",
            seatbelt_string(&path)
        ));
    }
    lines.push(String::new());
    Ok(lines.join("\n"))
}

fn build_managed_node_install_path(node_path_shim_dir: Option<&Path>) -> String {
    let base_path = "/usr/bin:/bin:/usr/sbin:/sbin";
    node_path_shim_dir
        .map(|dir| format!("{}:{base_path}", dir.to_string_lossy()))
        .unwrap_or_else(|| base_path.to_string())
}

fn resolve_managed_node_direct_npm_bin(configured: &str) -> Result<PathBuf> {
    let trimmed = configured.trim();
    if trimmed.is_empty() {
        bail!(
            "managed Node direct npm preparation requires an executable npm path; set portico_MANAGED_NODE_NPM_BIN"
        );
    }
    let configured_path = PathBuf::from(trimmed);
    if configured_path.is_absolute() {
        return ensure_managed_node_direct_executable(
            "npm",
            &configured_path,
            "portico_MANAGED_NODE_NPM_BIN",
        );
    }
    if trimmed != "npm" {
        bail!(
            "managed Node direct npm preparation requires an absolute executable npm path; got '{trimmed}' from portico_MANAGED_NODE_NPM_BIN"
        );
    }
    for candidate in ["/usr/local/bin/npm", "/usr/bin/npm", "/bin/npm"] {
        let candidate_path = PathBuf::from(candidate);
        if is_executable_file(&candidate_path) {
            return Ok(candidate_path);
        }
    }
    bail!(
        "managed Node direct npm preparation could not find executable npm at /usr/local/bin/npm, /usr/bin/npm, or /bin/npm; set portico_MANAGED_NODE_NPM_BIN"
    );
}

fn resolve_managed_node_direct_node_path(
    configured: Option<&str>,
    npm_path: &Path,
) -> Result<PathBuf> {
    if let Some(configured) = configured {
        let trimmed = configured.trim();
        if !trimmed.is_empty() {
            let configured_path = PathBuf::from(trimmed);
            if configured_path.is_absolute() {
                return ensure_managed_node_direct_executable(
                    "node",
                    &configured_path,
                    "HOST_NODE_PATH",
                );
            }
            if trimmed != "node" {
                bail!(
                    "managed Node direct npm preparation requires an absolute executable node path; got '{trimmed}' from HOST_NODE_PATH/portico_NODE_BINARY"
                );
            }
        }
    }

    let mut candidates = Vec::new();
    if let Some(parent) = npm_path.parent() {
        candidates.push(parent.join("node"));
    }
    candidates.extend(
        ["/usr/local/bin/node", "/usr/bin/node", "/bin/node"]
            .into_iter()
            .map(PathBuf::from),
    );
    for candidate in candidates {
        if is_executable_file(&candidate) {
            return Ok(candidate);
        }
    }
    bail!(
        "managed Node direct npm preparation could not find executable node next to {} or at /usr/local/bin/node, /usr/bin/node, or /bin/node; set HOST_NODE_PATH",
        npm_path.display()
    );
}

fn ensure_managed_node_direct_executable(
    label: &str,
    path: &Path,
    env_name: &str,
) -> Result<PathBuf> {
    if is_executable_file(path) {
        return Ok(path.to_path_buf());
    }
    bail!(
        "managed Node direct npm preparation requires executable {label} at {}; check {env_name}",
        path.display()
    );
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn create_managed_node_path_shim(tmp_dir: &Path, node_for_srt: &str) -> Result<Option<PathBuf>> {
    let trimmed = node_for_srt.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let node_path = PathBuf::from(trimmed);
    if !node_path.is_absolute() {
        return Ok(None);
    }

    let shim_dir = tmp_dir.join("bin");
    fs::create_dir_all(&shim_dir).with_context(|| {
        format!(
            "failed to create managed Node PATH shim directory {}",
            shim_dir.display()
        )
    })?;
    let shim_path = shim_dir.join("node");
    if shim_path.exists() {
        fs::remove_file(&shim_path).with_context(|| {
            format!(
                "failed to replace managed Node PATH shim {}",
                shim_path.display()
            )
        })?;
    }

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&node_path, &shim_path).with_context(|| {
            format!(
                "failed to create managed Node PATH shim {} -> {}",
                shim_path.display(),
                node_path.display()
            )
        })?;
    }

    #[cfg(not(unix))]
    {
        fs::copy(&node_path, &shim_path).with_context(|| {
            format!(
                "failed to copy managed Node PATH shim {} -> {}",
                node_path.display(),
                shim_path.display()
            )
        })?;
    }

    Ok(Some(shim_dir))
}

struct TempNpmrc {
    path: PathBuf,
}

impl TempNpmrc {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempNpmrc {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn cleanup_runtime_visible_install_scratch(server_runtime_root: &Path) -> Result<()> {
    for name in ["npm-cache", "home", "tmp"] {
        let path = server_runtime_root.join(name);
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        let file_type = metadata.file_type();
        if file_type.is_dir() && !file_type.is_symlink() {
            fs::remove_dir_all(&path).with_context(|| {
                format!(
                    "failed to remove runtime-visible managed Node acquisition directory {}",
                    path.display()
                )
            })?;
        } else {
            fs::remove_file(&path).with_context(|| {
                format!(
                    "failed to remove runtime-visible managed Node acquisition file {}",
                    path.display()
                )
            })?;
        }
    }
    for file_name in [
        "managed-node-install.npmrc",
        "managed-node-install-srt-settings.json",
        "managed-node-install-no-keychain.sb",
    ] {
        let path = server_runtime_root.join(file_name);
        if fs::symlink_metadata(&path).is_ok() {
            fs::remove_file(&path).with_context(|| {
                format!(
                    "failed to remove runtime-visible managed Node acquisition file {}",
                    path.display()
                )
            })?;
        }
    }
    Ok(())
}

fn cleanup_failed_managed_node_install(install_root: &Path, error: anyhow::Error) -> anyhow::Error {
    match fs::symlink_metadata(install_root) {
        Ok(metadata) => {
            let cleanup_result =
                if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() {
                    fs::remove_dir_all(install_root)
                } else {
                    fs::remove_file(install_root)
                };
            match cleanup_result {
                Ok(()) => error,
                Err(cleanup_error) => error.context(format!(
                    "failed to remove managed Node install {} after preparation error: {cleanup_error}",
                    install_root.display()
                )),
            }
        }
        Err(cleanup_error) if cleanup_error.kind() == std::io::ErrorKind::NotFound => error,
        Err(cleanup_error) => error.context(format!(
            "failed to inspect managed Node install {} after preparation error: {cleanup_error}",
            install_root.display()
        )),
    }
}

fn append_npm_install_args(
    command: &mut StdCommand,
    install_root: &Path,
    cache_dir: &Path,
    npmrc_path: &Path,
    registry: &str,
    replace_registry_host: &str,
    config: &ManagedNodePackageConfig,
) {
    command
        .arg("install")
        .arg("--prefix")
        .arg(install_root)
        .arg("--userconfig")
        .arg(npmrc_path)
        .arg("--registry")
        .arg(registry)
        .arg("--ignore-scripts")
        .arg("--omit=dev")
        .arg("--no-audit")
        .arg("--no-fund")
        .arg(format!("--replace-registry-host={replace_registry_host}"))
        .arg("--cache")
        .arg(cache_dir)
        .arg(package_install_spec(config));
}

fn append_npm_install_os_args(
    args: &mut Vec<OsString>,
    install_root: &Path,
    cache_dir: &Path,
    npmrc_path: &Path,
    registry: &str,
    replace_registry_host: &str,
    config: &ManagedNodePackageConfig,
) {
    args.push(OsString::from("install"));
    args.push(OsString::from("--prefix"));
    args.push(install_root.as_os_str().to_os_string());
    args.push(OsString::from("--userconfig"));
    args.push(npmrc_path.as_os_str().to_os_string());
    args.push(OsString::from("--registry"));
    args.push(OsString::from(registry));
    args.push(OsString::from("--ignore-scripts"));
    args.push(OsString::from("--omit=dev"));
    args.push(OsString::from("--no-audit"));
    args.push(OsString::from("--no-fund"));
    args.push(OsString::from(format!(
        "--replace-registry-host={replace_registry_host}"
    )));
    args.push(OsString::from("--cache"));
    args.push(cache_dir.as_os_str().to_os_string());
    args.push(OsString::from(package_install_spec(config)));
}

fn seatbelt_string(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let escaped = raw.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

fn package_install_spec(config: &ManagedNodePackageConfig) -> String {
    config
        .resolved_version
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .map(|version| format!("{}@{}", config.package_name, version))
        .unwrap_or_else(|| config.requested_spec.clone())
}

fn pin_metadata_to_installed_package(
    config: &mut ManagedNodePackageConfig,
    install_root: &Path,
) -> Result<()> {
    let package_json_path = package_dir(install_root, &config.package_name).join("package.json");
    let package_json: Value = serde_json::from_str(
        &fs::read_to_string(&package_json_path)
            .with_context(|| format!("failed to read {}", package_json_path.display()))?,
    )
    .with_context(|| format!("invalid package.json at {}", package_json_path.display()))?;
    if let Some(version) = package_json.get("version").and_then(Value::as_str) {
        if !version.trim().is_empty() {
            config.resolved_version = Some(version.to_string());
        }
    }

    let package_lock_path = install_root.join("package-lock.json");
    if let Ok(package_lock_content) = fs::read_to_string(&package_lock_path) {
        if let Ok(package_lock) = serde_json::from_str::<Value>(&package_lock_content) {
            let lock_key = format!("node_modules/{}", config.package_name);
            if let Some(integrity) = package_lock
                .get("packages")
                .and_then(|packages| packages.get(&lock_key))
                .and_then(|entry| entry.get("integrity"))
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
            {
                config.resolved_integrity = Some(integrity.to_string());
            }
        }
    }
    Ok(())
}

fn write_temp_npmrc(project_root: &Path, tmp_dir: &Path, package_name: &str) -> Result<PathBuf> {
    let explicit_source = env::var("portico_MANAGED_NODE_NPMRC")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from);
    let target = tmp_dir.join("managed-node-install.npmrc");
    let sources = if let Some(source) = explicit_source {
        vec![source]
    } else {
        npm_config_source_paths(project_root)
    };
    let mut content = String::new();
    for source in sources {
        if !source.is_file() {
            continue;
        }
        let source_content = fs::read_to_string(&source)
            .with_context(|| format!("failed to read npm config template {}", source.display()))?;
        if !content.is_empty() && !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str(&source_content);
        if !content.ends_with('\n') {
            content.push('\n');
        }
    }
    content = normalize_managed_npmrc(&content);
    let replace_registry_host = configured_npm_registry(&content, package_name)
        .as_deref()
        .map(replace_registry_host_mode)
        .unwrap_or("always");
    set_npm_config_line(
        &mut content,
        &format!("replace-registry-host={replace_registry_host}"),
    );
    write_private_text(&target, &content)?;
    Ok(target)
}

fn npm_config_source_paths(project_root: &Path) -> Vec<PathBuf> {
    let project_npmrc = project_root.join(".npmrc");
    let packaged_npmrc = project_root.join("electron-app").join(".npmrc");
    let mut sources = vec![if project_npmrc.is_file() {
        project_npmrc
    } else {
        packaged_npmrc
    }];
    for key in ["NPM_CONFIG_GLOBALCONFIG", "npm_config_globalconfig"] {
        if let Ok(value) = env::var(key) {
            if !value.trim().is_empty() {
                sources.push(PathBuf::from(value));
            }
        }
    }
    sources
}

fn effective_npm_registry(npmrc_path: &Path, package_name: &str) -> Result<String> {
    let content = fs::read_to_string(npmrc_path).unwrap_or_default();
    let registry = configured_npm_registry(&content, package_name)
        .ok_or_else(|| anyhow!("managed Node package preparation requires an npm registry"))?;
    let parsed = url::Url::parse(&registry)
        .with_context(|| format!("invalid npm registry URL '{registry}'"))?;
    if parsed.scheme() != "https" || parsed.host_str().is_none() {
        bail!("invalid npm registry URL '{registry}'");
    }
    validate_internal_npm_registry(&registry)?;
    Ok(registry)
}

fn configured_npm_registry(content: &str, package_name: &str) -> Option<String> {
    let package_scope = package_name
        .strip_prefix('@')
        .and_then(|value| value.split_once('/'))
        .map(|(scope, _)| format!("@{scope}:registry"));
    let mut default_registry = None;
    let mut scoped_registry = None;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            continue;
        }
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        if package_scope.as_deref() == Some(key) {
            scoped_registry = Some(value.to_string());
        } else if key == "registry" {
            default_registry = Some(value.to_string());
        }
    }
    scoped_registry.or(default_registry)
}

fn validate_internal_npm_registries(npmrc_path: &Path) -> Result<()> {
    for (key, registry) in registry_entries_from_npmrc(npmrc_path) {
        validate_internal_npm_registry(&registry)
            .with_context(|| format!("npm config key '{key}' is not allowed"))?;
    }
    Ok(())
}

fn validate_internal_npm_registry(registry: &str) -> Result<()> {
    let parsed = url::Url::parse(registry)
        .with_context(|| format!("invalid npm registry URL '{registry}'"))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| anyhow!("invalid npm registry URL '{registry}'"))?;
    if parsed.scheme() != "https" || !INTERNAL_NPM_REGISTRY_HOSTS.contains(&host) {
        bail!(
            "managed Node package preparation requires Portico npm registry {}; got {registry}",
            INTERNAL_NPM_REGISTRY_HOSTS.join(", ")
        );
    }
    Ok(())
}

fn replace_registry_host_mode(registry: &str) -> &'static str {
    if let Ok(parsed) = url::Url::parse(registry) {
        if parsed.host_str() == Some("npm.artifacts.example.invalid")
            && parsed.path().trim_end_matches('/') == INTERNAL_NPM_PROXY_PATH
        {
            return "npmjs";
        }
    }
    "always"
}

fn normalize_managed_npmrc(content: &str) -> String {
    let had_trailing_newline = content.ends_with('\n');
    let mut normalized = content
        .lines()
        .map(normalize_managed_npmrc_line)
        .collect::<Vec<_>>()
        .join("\n");
    if had_trailing_newline {
        normalized.push('\n');
    }
    normalized
}

fn normalize_managed_npmrc_line(line: &str) -> String {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return line.to_string();
    }
    let Some((raw_key, raw_value)) = line.split_once('=') else {
        return line.to_string();
    };
    let key = raw_key.trim();
    let value = raw_value.trim();

    if key == "registry" || key.ends_with(":registry") {
        if let Ok(mut registry) = url::Url::parse(value) {
            if registry.scheme() == "https"
                && registry.host_str() == Some("npm.artifacts.example.invalid")
                && registry.path().trim_end_matches('/') == INTERNAL_NPM_HARBOR_PATH
            {
                registry.set_path("/npm/");
                return format!("{raw_key}={registry}");
            }
        }
    }

    if let Some(suffix) = key.strip_prefix(INTERNAL_NPM_HARBOR_AUTH_PREFIX) {
        return format!("{INTERNAL_NPM_PROXY_AUTH_PREFIX}{suffix}={raw_value}");
    }

    line.to_string()
}

fn set_npm_config_line(content: &mut String, line: &str) {
    let key = line
        .split_once('=')
        .map(|(key, _)| key.trim())
        .unwrap_or(line)
        .trim();
    if key.is_empty() {
        return;
    }

    let retained = content
        .lines()
        .filter(|existing| {
            let trimmed = existing.trim();
            trimmed.starts_with('#')
                || trimmed
                    .split_once('=')
                    .map(|(existing_key, _)| existing_key.trim() != key)
                    .unwrap_or(true)
        })
        .collect::<Vec<_>>();
    let mut updated = retained.join("\n");
    if !updated.is_empty() {
        updated.push('\n');
    }
    updated.push_str(line);
    updated.push('\n');
    *content = updated;
}

fn managed_package_install_sandbox_settings(
    project_root: &Path,
    install_root: &Path,
    cache_dir: &Path,
    tmp_dir: &Path,
    npmrc_path: &Path,
    node_for_srt: &str,
) -> Result<Value> {
    let allowed_domains = managed_package_allowed_domains(npmrc_path)?;
    let mut allow_read = vec![
        npmrc_path.to_string_lossy().to_string(),
        install_root.to_string_lossy().to_string(),
        cache_dir.to_string_lossy().to_string(),
        tmp_dir.to_string_lossy().to_string(),
        "/usr".to_string(),
        "/opt/homebrew".to_string(),
        "/System/Library".to_string(),
        "/Library".to_string(),
    ];
    let node_path = PathBuf::from(node_for_srt.trim());
    if node_path.is_absolute() {
        allow_read.push(node_path.to_string_lossy().to_string());
        if let Some(parent) = node_path.parent() {
            allow_read.push(parent.to_string_lossy().to_string());
        }
    }
    allow_read.sort();
    allow_read.dedup();

    Ok(serde_json::json!({
        "network": {
            "allowedDomains": allowed_domains,
            "deniedDomains": [],
            "allowUnixSockets": []
        },
        "filesystem": {
            "denyRead": [
                project_root.join(".env").to_string_lossy(),
                project_root.join(".env.runtime").to_string_lossy(),
                project_root.join("mcpo-oauth-tokens").to_string_lossy(),
                project_root.join("open-webui-data/runtime-secrets").to_string_lossy(),
                "~/.ssh",
                "~/.aws",
                "~/.npmrc",
                "~/Library/Keychains"
            ],
            "allowRead": allow_read,
            "denyWrite": [
                project_root.join(".env").to_string_lossy(),
                project_root.join(".env.runtime").to_string_lossy(),
                project_root.join("mcpo-oauth-tokens").to_string_lossy(),
                project_root.join("open-webui-data/runtime-secrets").to_string_lossy(),
                "~/.ssh",
                "~/.aws",
                "~/.npmrc",
                "~/Library/Keychains"
            ],
            "allowWrite": [
                install_root.to_string_lossy(),
                cache_dir.to_string_lossy(),
                tmp_dir.to_string_lossy()
            ]
        }
    }))
}

fn managed_package_allowed_domains(npmrc_path: &Path) -> Result<Vec<String>> {
    validate_internal_npm_registries(npmrc_path)?;
    let mut allowed_domains = registry_domains_from_npmrc(npmrc_path)?;
    allowed_domains.extend(managed_package_internal_domains());
    allowed_domains.sort();
    allowed_domains.dedup();
    Ok(allowed_domains)
}

fn managed_package_internal_domains() -> Vec<String> {
    let mut allowed_domains = INTERNAL_NPM_REGISTRY_HOSTS
        .iter()
        .chain(INTERNAL_NPM_ARTIFACT_HOSTS.iter())
        .map(|domain| (*domain).to_string())
        .collect::<Vec<_>>();
    allowed_domains.sort();
    allowed_domains.dedup();
    allowed_domains
}

fn registry_domains_from_npmrc(npmrc_path: &Path) -> Result<Vec<String>> {
    let mut domains = Vec::new();
    for (_, registry) in registry_entries_from_npmrc(npmrc_path) {
        if let Ok(parsed) = url::Url::parse(&registry) {
            if let Some(host) = parsed.host_str() {
                domains.push(host.to_string());
            }
        }
    }
    domains.sort();
    domains.dedup();
    Ok(domains)
}

fn registry_entries_from_npmrc(npmrc_path: &Path) -> Vec<(String, String)> {
    let content = fs::read_to_string(npmrc_path).unwrap_or_default();
    let mut entries = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            continue;
        }
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key != "registry" && !key.ends_with(":registry") {
            continue;
        }
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        entries.push((key.to_string(), value.to_string()));
    }
    entries
}

fn first_disallowed_npm_log_host(cache_dir: &Path, allowed_domains: &[String]) -> Option<String> {
    let logs_dir = cache_dir.join("_logs");
    let mut logs = fs::read_dir(logs_dir)
        .ok()?
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .path()
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.ends_with("-debug-0.log"))
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    logs.sort_by_key(|entry| entry.file_name());
    logs.reverse();
    let latest_log = logs.first()?;
    let Ok(content) = fs::read_to_string(latest_log.path()) else {
        return None;
    };
    for line in content.lines() {
        if !line.starts_with("http fetch ") && !line.contains(" http fetch ") {
            continue;
        }
        for token in line.split(|ch: char| {
            ch.is_whitespace() || matches!(ch, '"' | '\'' | '<' | '>' | '(' | ')' | ',' | ';')
        }) {
            let candidate = token.trim_matches(|ch: char| {
                matches!(ch, '.' | ':' | ',' | ';' | '"' | '\'' | ')' | '(')
            });
            if !(candidate.starts_with("https://") || candidate.starts_with("http://")) {
                continue;
            }
            let Ok(parsed) = url::Url::parse(candidate) else {
                continue;
            };
            let Some(host) = parsed.host_str() else {
                continue;
            };
            if !allowed_domains.iter().any(|allowed| allowed == host) {
                return Some(host.to_string());
            }
        }
    }
    None
}

fn first_disallowed_package_lock_host(
    install_root: &Path,
    allowed_domains: &[String],
) -> Option<String> {
    let package_lock_path = install_root.join("package-lock.json");
    let content = fs::read_to_string(package_lock_path).ok()?;
    let value: Value = serde_json::from_str(&content).ok()?;
    first_disallowed_url_host_in_json(&value, allowed_domains)
}

fn first_disallowed_url_host_in_json(value: &Value, allowed_domains: &[String]) -> Option<String> {
    match value {
        Value::Array(values) => values
            .iter()
            .find_map(|entry| first_disallowed_url_host_in_json(entry, allowed_domains)),
        Value::Object(map) => map
            .get("resolved")
            .and_then(|entry| disallowed_url_host_in_json_value(entry, allowed_domains))
            .or_else(|| {
                map.values()
                    .find_map(|entry| first_disallowed_url_host_in_json(entry, allowed_domains))
            }),
        _ => None,
    }
}

fn disallowed_url_host_in_json_value(value: &Value, allowed_domains: &[String]) -> Option<String> {
    match value {
        Value::String(text) => {
            let Ok(parsed) = url::Url::parse(text) else {
                return None;
            };
            let host = parsed.host_str()?;
            if allowed_domains.iter().any(|allowed| allowed == host) {
                None
            } else {
                Some(host.to_string())
            }
        }
        Value::Array(values) => values
            .iter()
            .find_map(|entry| disallowed_url_host_in_json_value(entry, allowed_domains)),
        Value::Object(map) => map
            .values()
            .find_map(|entry| disallowed_url_host_in_json_value(entry, allowed_domains)),
        _ => None,
    }
}

fn write_private_json(path: &Path, value: &Value) -> Result<()> {
    write_private_text(path, &format!("{}\n", serde_json::to_string_pretty(value)?))
}

fn write_private_text(path: &Path, content: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, content)?;
    set_owner_only_permissions(&tmp)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(unix)]
fn set_owner_only_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .with_context(|| format!("failed to set 0600 permissions on {}", path.display()))
}

#[cfg(not(unix))]
fn set_owner_only_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

fn resolve_package_bin(
    package_json: &Value,
    package_dir: &Path,
    requested_bin: Option<&str>,
) -> Result<PathBuf> {
    let bin = package_json.get("bin");
    let relative = match (requested_bin, bin) {
        (Some(_), Some(Value::String(value))) => Some(value.clone()),
        (Some(name), Some(Value::Object(map))) => {
            map.get(name).and_then(Value::as_str).map(str::to_string)
        }
        (None, Some(Value::String(value))) => Some(value.clone()),
        (None, Some(Value::Object(map))) => first_bin_value(map),
        _ => None,
    }
    .ok_or_else(|| anyhow!("managed Node package does not expose a runnable bin"))?;

    let bin_path = package_dir.join(relative);
    let canonical_package_dir = package_dir.canonicalize().with_context(|| {
        format!(
            "failed to canonicalize managed package dir {}",
            package_dir.display()
        )
    })?;
    let canonical_bin = bin_path
        .canonicalize()
        .with_context(|| format!("managed package bin is missing: {}", bin_path.display()))?;
    if !canonical_bin.starts_with(&canonical_package_dir) {
        bail!(
            "managed package bin escapes package directory: {}",
            canonical_bin.display()
        );
    }
    Ok(canonical_bin)
}

fn first_bin_value(map: &Map<String, Value>) -> Option<String> {
    let mut entries: BTreeMap<&String, &Value> = BTreeMap::new();
    for (key, value) in map {
        entries.insert(key, value);
    }
    entries
        .values()
        .find_map(|value| value.as_str().map(str::to_string))
}

fn package_dir(install_root: &Path, package_name: &str) -> PathBuf {
    let mut path = install_root.join("node_modules");
    for part in package_name.split('/') {
        path.push(part);
    }
    path
}

fn sanitize_server_id(server_id: &str) -> String {
    server_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn managed_node_user_collision_is_reserved_by_system_directory() {
        let root = tempfile::tempdir().expect("temp dir");
        let system_dir = root.path().join("mcp-configs").join("collision-mcp");
        std::fs::create_dir_all(&system_dir).expect("create system directory");

        assert!(super::user_config_collides_with_system(
            root.path(),
            "mcp-configs-user",
            "collision-mcp",
        ));
        assert!(!super::user_config_collides_with_system(
            root.path(),
            "mcp-configs",
            "collision-mcp",
        ));
        assert!(!super::user_config_collides_with_system(
            root.path(),
            "mcp-configs-user",
            "other-mcp",
        ));
    }
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    #[test]
    fn normalizes_npx_recipe_to_managed_metadata() {
        let mut fragment = json!({
            "command": "npx",
            "args": ["-y", "@scope/demo@1.2.3", "--readonly"],
            "env": {"PUBLIC_FLAG": "1"}
        });

        let metadata = normalize_fragment_for_managed_node("demo", &mut fragment)
            .unwrap()
            .unwrap();

        assert_eq!(fragment["command"], MANAGED_NODE_SENTINEL_COMMAND);
        assert_eq!(fragment["args"], json!([]));
        assert_eq!(fragment["env"]["PUBLIC_FLAG"], "1");
        assert_eq!(metadata.package_name, "@scope/demo");
        assert_eq!(metadata.requested_range, "1.2.3");
        assert_eq!(metadata.runtime_args, vec!["--readonly"]);
        assert_eq!(
            fragment[MANAGED_NODE_PACKAGE_KEY]["requested_spec"],
            "@scope/demo@1.2.3"
        );
    }

    #[test]
    fn rejects_package_manager_config_flags() {
        let mut fragment = json!({
            "command": "npm",
            "args": ["exec", "--registry", "https://evil.invalid", "demo"]
        });

        let error = normalize_fragment_for_managed_node("demo", &mut fragment).unwrap_err();
        assert!(error.to_string().contains("--registry"));
    }

    #[test]
    fn cloudsmith_npm_registry_uses_npmjs_tarball_rewrite_mode() {
        assert_eq!(
            replace_registry_host_mode("https://npm.artifacts.example.invalid/npm/"),
            "npmjs"
        );
        assert_eq!(
            replace_registry_host_mode("https://npm.artifacts.example.invalid/harbor/"),
            "always"
        );
    }

    #[test]
    fn normalizes_harbor_registry_and_auth_scope_for_managed_install() {
        let mut normalized = normalize_managed_npmrc(concat!(
            "registry=https://npm.artifacts.example.invalid/harbor/\n",
            "@demo:registry=https://npm.artifacts.example.invalid/harbor/\n",
            "//npm.artifacts.example.invalid/harbor/:_authToken=fake-token\n",
            "replace-registry-host=always\n"
        ));
        let registry = configured_npm_registry(&normalized, "@demo/server").unwrap();
        set_npm_config_line(
            &mut normalized,
            &format!(
                "replace-registry-host={}",
                replace_registry_host_mode(&registry)
            ),
        );

        assert_eq!(registry, "https://npm.artifacts.example.invalid/npm/");
        assert!(normalized.contains("registry=https://npm.artifacts.example.invalid/npm/\n"));
        assert!(normalized.contains("@demo:registry=https://npm.artifacts.example.invalid/npm/\n"));
        assert!(normalized.contains("//npm.artifacts.example.invalid/npm/:_authToken=fake-token\n"));
        assert!(normalized.contains("replace-registry-host=npmjs\n"));
        assert!(!normalized.contains("npm.artifacts.example.invalid/harbor"));
        assert!(!normalized.contains("replace-registry-host=always"));
    }

    #[test]
    fn npm_config_sources_fall_back_to_packaged_electron_npmrc() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("managed-root");
        let packaged_npmrc = root.join("electron-app").join(".npmrc");
        fs::create_dir_all(packaged_npmrc.parent().unwrap()).unwrap();
        fs::write(
            &packaged_npmrc,
            "registry=https://npm.artifacts.example.invalid/harbor/\n",
        )
        .unwrap();

        let packaged_sources = npm_config_source_paths(&root);
        assert_eq!(packaged_sources.first(), Some(&packaged_npmrc));

        let root_npmrc = root.join(".npmrc");
        fs::write(
            &root_npmrc,
            "registry=https://npm.artifacts.example.invalid/harbor/\n",
        )
        .unwrap();
        let development_sources = npm_config_source_paths(&root);
        assert_eq!(development_sources.first(), Some(&root_npmrc));
    }

    #[test]
    fn rejects_non_portico_npm_registry_config() {
        let temp = tempdir().unwrap();
        let npmrc = temp.path().join(".npmrc");
        fs::write(
            &npmrc,
            concat!(
                "registry=https://npm.artifacts.example.invalid/npm/\n",
                "@evil:registry=https://registry.npmjs.org/\n"
            ),
        )
        .unwrap();

        let error = validate_internal_npm_registries(&npmrc).unwrap_err();
        let error_chain = format!("{error:#}");

        assert!(error_chain.contains("Portico npm registry"));
        assert!(error_chain.contains("@evil:registry"));
    }

    #[test]
    fn effective_registry_rejects_public_npm_fallback() {
        let temp = tempdir().unwrap();
        let npmrc = temp.path().join(".npmrc");
        fs::write(&npmrc, "registry=https://registry.npmjs.org/\n").unwrap();

        let error = effective_npm_registry(&npmrc, "demo-server").unwrap_err();
        let error_chain = format!("{error:#}");

        assert!(error_chain.contains("Portico npm registry"));
    }

    #[test]
    fn classifies_package_manager_runtime_env_keys() {
        assert!(is_package_manager_runtime_env_key("NPM_CONFIG_USERCONFIG"));
        assert!(is_package_manager_runtime_env_key(
            "npm_config_//registry:_authToken"
        ));
        assert!(is_package_manager_runtime_env_key("YARN_NPM_AUTH_IDENT"));
        assert!(is_package_manager_runtime_env_key("COREPACK_NPM_PASSWORD"));
        assert!(is_package_manager_runtime_env_key("BUN_AUTH_TOKEN"));
        assert!(is_package_manager_runtime_env_key("BUN_CONFIG_REGISTRY"));
        assert!(!is_package_manager_runtime_env_key("PUBLIC_FLAG"));
    }

    #[test]
    fn resolves_prepared_package_bin_without_npm() {
        let _guard = crate::test_env_lock();
        let temp = tempdir().unwrap();
        let store = temp.path().join("store");
        let package_dir = store
            .join("demo")
            .join("package")
            .join("node_modules")
            .join("@scope")
            .join("demo");
        fs::create_dir_all(package_dir.join("bin")).unwrap();
        fs::write(
            package_dir.join("package.json"),
            r#"{"name":"@scope/demo","bin":{"demo":"bin/server.js"}}"#,
        )
        .unwrap();
        fs::write(package_dir.join("bin/server.js"), "console.log('ok')").unwrap();
        env::set_var("portico_MANAGED_NODE_MCP_PACKAGES_DIR", &store);
        env::set_var("portico_NODE_BINARY", "/custom/node");

        let config = ManagedNodePackageConfig {
            schema_version: 1,
            server_id: "demo".to_string(),
            package_manager: "npm".to_string(),
            requested_spec: "@scope/demo@1.2.3".to_string(),
            package_name: "@scope/demo".to_string(),
            requested_range: "1.2.3".to_string(),
            resolved_version: None,
            resolved_integrity: None,
            runtime_args: vec!["--readonly".to_string()],
            bin: None,
            install_dir: None,
            source: ManagedNodePackageSource::default(),
        };

        let (command, args) = prepared_managed_node_command("demo", &config).unwrap();
        assert_eq!(command, "/custom/node");
        assert_eq!(args.len(), 2);
        assert!(args[0].ends_with("bin/server.js"));
        assert_eq!(args[1], "--readonly");

        env::remove_var("portico_MANAGED_NODE_MCP_PACKAGES_DIR");
        env::remove_var("portico_NODE_BINARY");
    }

    #[test]
    fn resolves_explicit_bin_for_multi_bin_packages() {
        let _guard = crate::test_env_lock();
        let temp = tempdir().unwrap();
        let store = temp.path().join("store");
        let package_dir = store
            .join("chrome-devtools")
            .join("package")
            .join("node_modules")
            .join("chrome-devtools-mcp");
        fs::create_dir_all(package_dir.join("build/src/bin")).unwrap();
        fs::write(
            package_dir.join("package.json"),
            r#"{"name":"chrome-devtools-mcp","bin":{"chrome-devtools":"build/src/bin/chrome-devtools.js","chrome-devtools-mcp":"build/src/bin/chrome-devtools-mcp.js"}}"#,
        )
        .unwrap();
        fs::write(
            package_dir.join("build/src/bin/chrome-devtools.js"),
            "console.log('daemon cli')",
        )
        .unwrap();
        fs::write(
            package_dir.join("build/src/bin/chrome-devtools-mcp.js"),
            "console.log('stdio mcp')",
        )
        .unwrap();
        env::set_var("portico_MANAGED_NODE_MCP_PACKAGES_DIR", &store);
        env::set_var("portico_NODE_BINARY", "/custom/node");

        let config = ManagedNodePackageConfig {
            schema_version: 1,
            server_id: "chrome-devtools".to_string(),
            package_manager: "npm".to_string(),
            requested_spec: "chrome-devtools-mcp@0.26.0".to_string(),
            package_name: "chrome-devtools-mcp".to_string(),
            requested_range: "0.26.0".to_string(),
            resolved_version: None,
            resolved_integrity: None,
            runtime_args: vec!["--autoConnect".to_string()],
            bin: Some("chrome-devtools-mcp".to_string()),
            install_dir: None,
            source: ManagedNodePackageSource::default(),
        };

        let (command, args) = prepared_managed_node_command("chrome-devtools", &config).unwrap();
        assert_eq!(command, "/custom/node");
        assert_eq!(args.len(), 2);
        assert!(
            args[0].ends_with("build/src/bin/chrome-devtools-mcp.js"),
            "expected stdio MCP bin, got {}",
            args[0]
        );
        assert_eq!(args[1], "--autoConnect");

        env::remove_var("portico_MANAGED_NODE_MCP_PACKAGES_DIR");
        env::remove_var("portico_NODE_BINARY");
    }

    #[test]
    fn prepare_migrates_user_npx_fragment_and_runs_sandboxed_npm_without_scripts() {
        let _guard = crate::test_env_lock();
        let temp = tempdir().unwrap();
        let root = temp.path().join("project");
        let server_id = "user-demo";
        let server_dir = root.join("mcp-configs-user").join(server_id);
        fs::create_dir_all(&server_dir).unwrap();
        fs::write(
            server_dir.join(format!("{server_id}.fragment")),
            r#"{"command":"npx","args":["-y","demo-server@1.0.0","--readonly"]}"#,
        )
        .unwrap();
        fs::write(
            root.join(".npmrc"),
            "registry=https://npm.artifacts.example.invalid/\n",
        )
        .unwrap();

        let bin_dir = temp.path().join("bin");
        fs::create_dir_all(&bin_dir).unwrap();
        let srt = bin_dir.join("srt");
        fs::write(
            &srt,
            r#"#!/bin/sh
shift 2
exec "$@"
"#,
        )
        .unwrap();
        let node = bin_dir.join("node");
        let runner = bin_dir.join("srt-sandbox-runner.mjs");
        let cli_js = bin_dir.join("srt-cli.js");
        fs::write(&runner, "").unwrap();
        fs::write(&cli_js, "").unwrap();
        fs::write(
            &node,
            r#"#!/bin/sh
if [ "${1:-}" = "--version" ]; then
  printf 'v999.0.0\n'
  exit 0
fi
shift
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    exec "$@"
  fi
  shift
done
exit 66
"#,
        )
        .unwrap();
        let npm = bin_dir.join("npm");
        let log = temp.path().join("npm.log");
        let env_log = temp.path().join("npm-env.log");
        let node_path_log = temp.path().join("npm-node-path.log");
        fs::write(
            &npm,
            format!(
                r#"#!/bin/sh
printf '%s\n' "$*" > "{}"
env > "{}"
command -v node > "{}" || exit 32
env node --version >/dev/null || exit 33
case ":${{PATH:-}}:" in
  *":{}:"*) exit 34 ;;
esac
for forbidden in NODE_AUTH_TOKEN NPM_TOKEN NPM_CONFIG_GLOBALCONFIG npm_config_globalconfig YARN_NPM_AUTH_IDENT COREPACK_NPM_PASSWORD BUN_AUTH_TOKEN; do
  if env | grep -q "^${{forbidden}}="; then
    exit 31
  fi
done
	prefix=""
	ignore_scripts=0
	userconfig=""
	registry=""
	while [ "$#" -gt 0 ]; do
	  case "$1" in
	    --prefix) prefix="$2"; shift 2 ;;
	    --userconfig) userconfig="$2"; shift 2 ;;
	    --registry) registry="$2"; shift 2 ;;
	    --ignore-scripts) ignore_scripts=1; shift ;;
	    *) shift ;;
	  esac
	done
	if [ "$ignore_scripts" != "1" ]; then
	  exit 22
	fi
	if [ ! -f "$userconfig" ]; then
	  exit 23
	fi
	grep -q '^replace-registry-host=always$' "$userconfig" || exit 24
	[ "$registry" = "https://npm.artifacts.example.invalid/" ] || exit 25
	mkdir -p "$prefix/node_modules/demo-server/bin"
printf '{{"name":"demo-server","version":"1.0.0","bin":{{"demo-server":"bin/server.js"}}}}\n' > "$prefix/node_modules/demo-server/package.json"
printf 'console.log("ok")\n' > "$prefix/node_modules/demo-server/bin/server.js"
"#,
                log.display(),
                env_log.display(),
                node_path_log.display(),
                bin_dir.display()
            ),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&srt, fs::Permissions::from_mode(0o755)).unwrap();
            fs::set_permissions(&node, fs::Permissions::from_mode(0o755)).unwrap();
            fs::set_permissions(&npm, fs::Permissions::from_mode(0o755)).unwrap();
        }

        env::set_var("portico_MANAGED_NODE_SRT_CLI", &srt);
        env::set_var("portico_MANAGED_NODE_SRT_RUNNER_JS", &runner);
        env::set_var("portico_MANAGED_NODE_SRT_CLI_JS", &cli_js);
        env::set_var("HOST_NODE_PATH", &node);
        env::set_var("portico_MANAGED_NODE_NPM_BIN", &npm);
        env::set_var("portico_MANAGED_NODE_NPMRC", root.join(".npmrc"));
        let store = temp.path().join("store");
        env::set_var("portico_MANAGED_NODE_MCP_PACKAGES_DIR", &store);
        env::set_var("NODE_AUTH_TOKEN", "parent-node-auth-token");
        env::set_var("NPM_TOKEN", "parent-npm-token");
        env::set_var("NPM_CONFIG_GLOBALCONFIG", "/tmp/parent-global-npmrc");
        env::set_var("npm_config_globalconfig", "/tmp/parent-lower-global-npmrc");
        env::set_var("YARN_NPM_AUTH_IDENT", "parent-yarn-auth-ident");
        env::set_var("COREPACK_NPM_PASSWORD", "parent-corepack-password");
        env::set_var("BUN_AUTH_TOKEN", "parent-bun-token");

        run_prepare_managed_node_packages(&root, None, false, None, false, None).unwrap();

        let fragment: Value = serde_json::from_str(
            &fs::read_to_string(server_dir.join(format!("{server_id}.fragment"))).unwrap(),
        )
        .unwrap();
        assert_eq!(fragment["command"], MANAGED_NODE_SENTINEL_COMMAND);
        assert!(server_dir.join("managed-package.json").is_file());
        let metadata: ManagedNodePackageConfig = serde_json::from_str(
            &fs::read_to_string(server_dir.join("managed-package.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(metadata.resolved_version.as_deref(), Some("1.0.0"));
        let npm_args = fs::read_to_string(log).unwrap();
        assert!(npm_args.contains("--ignore-scripts"));
        assert!(npm_args.contains("--userconfig"));
        assert!(npm_args.contains("--registry"));
        assert!(npm_args.contains("--replace-registry-host=always"));
        let npm_node_path = fs::read_to_string(node_path_log).unwrap();
        assert!(
            npm_node_path.contains("managed-node-mcp-package-acquisition"),
            "npm child env node must resolve through the acquisition shim, got {npm_node_path}"
        );
        assert!(
            !npm_node_path.trim().eq(&node.to_string_lossy()),
            "npm child env node must not require the original Node/npm directory on PATH"
        );
        let npm_env = fs::read_to_string(env_log).unwrap();
        for forbidden in [
            "NODE_AUTH_TOKEN=",
            "NPM_TOKEN=",
            "NPM_CONFIG_GLOBALCONFIG=",
            "npm_config_globalconfig=",
            "YARN_NPM_AUTH_IDENT=",
            "COREPACK_NPM_PASSWORD=",
            "BUN_AUTH_TOKEN=",
        ] {
            assert!(
                !npm_env.contains(forbidden),
                "install-time npm process inherited forbidden package-manager credential env {forbidden}: {npm_env}"
            );
        }
        assert!(npm_env.contains("NPM_CONFIG_USERCONFIG="));
        let store_prefix = store.to_string_lossy();
        assert!(
            !npm_args.contains(&format!("--userconfig {store_prefix}")),
            "install-time npmrc must not live under the runtime-mounted package store: {npm_args}"
        );
        assert!(
            !npm_args.contains(&format!("--cache {store_prefix}")),
            "install-time npm cache must not live under the runtime-mounted package store: {npm_args}"
        );
        assert!(npm_args.contains("managed-node-mcp-package-acquisition"));
        let acquisition_server_root = root
            .join("open-webui-data")
            .join("managed-node-mcp-package-acquisition")
            .join(server_id);
        assert!(
            !acquisition_server_root
                .join("tmp")
                .join("managed-node-install.npmrc")
                .exists(),
            "temporary npm credentials must be removed after package acquisition"
        );
        assert!(
            !store.join(server_id).join("tmp").exists(),
            "runtime-mounted package store must not contain install-time temp files"
        );

        env::remove_var("portico_MANAGED_NODE_SRT_CLI");
        env::remove_var("portico_MANAGED_NODE_SRT_RUNNER_JS");
        env::remove_var("portico_MANAGED_NODE_SRT_CLI_JS");
        env::remove_var("HOST_NODE_PATH");
        env::remove_var("portico_MANAGED_NODE_NPM_BIN");
        env::remove_var("portico_MANAGED_NODE_NPMRC");
        env::remove_var("portico_MANAGED_NODE_MCP_PACKAGES_DIR");
        env::remove_var("NODE_AUTH_TOKEN");
        env::remove_var("NPM_TOKEN");
        env::remove_var("NPM_CONFIG_GLOBALCONFIG");
        env::remove_var("npm_config_globalconfig");
        env::remove_var("YARN_NPM_AUTH_IDENT");
        env::remove_var("COREPACK_NPM_PASSWORD");
        env::remove_var("BUN_AUTH_TOKEN");
    }

    #[test]
    fn docker_direct_prepare_runs_without_host_sandbox_and_uses_node_shim() {
        let _guard = crate::test_env_lock();
        let temp = tempdir().unwrap();
        let root = temp.path().join("project");
        let server_id = "docker-demo";
        let server_dir = root.join("mcp-configs-user").join(server_id);
        fs::create_dir_all(&server_dir).unwrap();
        fs::write(
            server_dir.join(format!("{server_id}.fragment")),
            r#"{"command":"npx","args":["-y","demo-server@1.0.0"]}"#,
        )
        .unwrap();
        fs::write(
            server_dir.join(format!("{server_id}.yaml")),
            "name: docker-demo\nid: docker-demo\ndeployment_type: docker\n",
        )
        .unwrap();
        fs::write(root.join("mcp_toggles.json"), r#"{"docker-demo":true}"#).unwrap();
        fs::write(
            root.join(".npmrc"),
            concat!(
                "registry=https://npm.artifacts.example.invalid/harbor/\n",
                "//npm.artifacts.example.invalid/harbor/:_authToken=fake-test-token\n",
                "replace-registry-host=always\n"
            ),
        )
        .unwrap();

        let bin_dir = temp.path().join("bin");
        fs::create_dir_all(&bin_dir).unwrap();
        let node = bin_dir.join("node");
        let npm = bin_dir.join("npm");
        let log = temp.path().join("direct-npm.log");
        let node_path_log = temp.path().join("direct-npm-node-path.log");
        fs::write(&node, "#!/bin/sh\nexit 0\n").unwrap();
        fs::write(
            &npm,
            format!(
                r#"#!/bin/sh
printf '%s\n' "$*" > "{}"
command -v node > "{}"
prefix=""
userconfig=""
registry=""
cache=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) prefix="$2"; shift 2 ;;
    --userconfig) userconfig="$2"; shift 2 ;;
    --registry) registry="$2"; shift 2 ;;
    --cache) cache="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$prefix" ] || exit 20
[ -f "$userconfig" ] || exit 21
	[ -n "$cache" ] || exit 26
	[ "$registry" = "https://npm.artifacts.example.invalid/npm/" ] || exit 22
	grep -q '^registry=https://npm.artifacts.example.invalid/npm/$' "$userconfig" || exit 23
	grep -q '^//npm.artifacts.example.invalid/npm/:_authToken=fake-test-token$' "$userconfig" || exit 24
	grep -q '^replace-registry-host=npmjs$' "$userconfig" || exit 25
	if grep -q 'npm.artifacts.example.invalid/harbor' "$userconfig"; then
	  exit 27
	fi
	mkdir -p "$prefix/node_modules/demo-server/bin"
	mkdir -p "$cache/_logs"
	printf '{{"name":"demo-server","version":"1.0.0","bin":{{"demo-server":"bin/server.js"}}}}\n' > "$prefix/node_modules/demo-server/package.json"
	printf '{{"packages":{{"node_modules/demo-server":{{"resolved":"https://npm.artifacts.example.invalid/npm/demo-server/-/demo-server-1.0.0.tgz"}}}}}}\n' > "$prefix/package-lock.json"
printf '%s\n' \
  '84 http fetch GET 200 https://npm.artifacts.example.invalid/npm/npm 1697ms' \
  '1367 http fetch GET 200 https://dl.artifacts.example.invalid/signed/npm/demo-server-1.0.0.tgz 4045ms' \
  '1541 notice Changelog: https://github.com/npm/cli/releases/tag/v11.16.0' \
  > "$cache/_logs/2026-06-17T01_03_23_996Z-debug-0.log"
"#,
                log.display(),
                node_path_log.display()
            ),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&node, fs::Permissions::from_mode(0o755)).unwrap();
            fs::set_permissions(&npm, fs::Permissions::from_mode(0o755)).unwrap();
        }

        env::set_var("portico_MANAGED_NODE_DIRECT_NPM", "1");
        env::set_var("portico_MANAGED_NODE_NPM_BIN", &npm);
        env::set_var(
            "portico_MANAGED_NODE_MCP_PACKAGES_DIR",
            temp.path().join("store"),
        );
        env::remove_var("portico_MANAGED_NODE_SRT_CLI");
        env::remove_var("portico_MANAGED_NODE_SRT_RUNNER_JS");
        env::remove_var("portico_MANAGED_NODE_SRT_CLI_JS");
        env::remove_var("HOST_MCP_SRT_CLI_JS");
        env::remove_var("HOST_MCP_SRT_RUNNER_JS");
        env::remove_var("HOST_NODE_PATH");
        env::remove_var("portico_NODE_BINARY");

        run_prepare_managed_node_packages(&root, None, true, Some("docker"), false, None).unwrap();

        assert!(log.is_file());
        let npm_args = fs::read_to_string(&log).unwrap();
        assert!(npm_args.contains("--registry https://npm.artifacts.example.invalid/npm/"));
        assert!(npm_args.contains("--replace-registry-host=npmjs"));
        let npm_node_path = fs::read_to_string(&node_path_log).unwrap();
        assert!(
            npm_node_path.contains("managed-node-mcp-package-acquisition"),
            "direct npm child env node must resolve through the acquisition shim, got {npm_node_path}"
        );
        assert_ne!(npm_node_path.trim(), node.to_string_lossy());
        let fragment: Value = serde_json::from_str(
            &fs::read_to_string(server_dir.join(format!("{server_id}.fragment"))).unwrap(),
        )
        .unwrap();
        assert_eq!(fragment["command"], MANAGED_NODE_SENTINEL_COMMAND);

        env::remove_var("portico_MANAGED_NODE_DIRECT_NPM");
        env::remove_var("portico_MANAGED_NODE_NPM_BIN");
        env::remove_var("portico_MANAGED_NODE_MCP_PACKAGES_DIR");
    }

    #[test]
    fn best_effort_prepare_records_failure_and_continues() {
        let _guard = crate::test_env_lock();
        let temp = tempdir().unwrap();
        let root = temp.path().join("project");
        let config_root = root.join("mcp-configs-user");
        for (server_id, package_name) in
            [("bad-node", "bad-package"), ("good-node", "good-package")]
        {
            let server_dir = config_root.join(server_id);
            fs::create_dir_all(&server_dir).unwrap();
            fs::write(
                server_dir.join(format!("{server_id}.fragment")),
                format!(r#"{{"command":"npx","args":["-y","{package_name}@1.0.0"]}}"#),
            )
            .unwrap();
            fs::write(
                server_dir.join(format!("{server_id}.yaml")),
                format!("name: {server_id}\nid: {server_id}\ndeployment_type: docker\n"),
            )
            .unwrap();
        }
        fs::write(
            root.join("mcp_toggles.json"),
            r#"{"bad-node":true,"good-node":true}"#,
        )
        .unwrap();
        fs::write(
            root.join(".npmrc"),
            concat!(
                "registry=https://npm.artifacts.example.invalid/harbor/\n",
                "//npm.artifacts.example.invalid/harbor/:_authToken=fake-test-token\n",
                "replace-registry-host=always\n"
            ),
        )
        .unwrap();

        let bin_dir = temp.path().join("bin");
        fs::create_dir_all(&bin_dir).unwrap();
        let node = bin_dir.join("node");
        let npm = bin_dir.join("npm");
        fs::write(&node, "#!/bin/sh\nexit 0\n").unwrap();
        fs::write(
            &npm,
            r#"#!/bin/sh
prefix=""
cache=""
last=""
while [ "$#" -gt 0 ]; do
  last="$1"
  case "$1" in
    --prefix) prefix="$2"; shift 2 ;;
    --cache) cache="$2"; shift 2 ;;
    *) shift ;;
  esac
done
case "$last" in
  bad-package@1.0.0) exit 42 ;;
esac
name="${last%@*}"
[ -n "$prefix" ] || exit 20
[ -n "$cache" ] || exit 21
mkdir -p "$prefix/node_modules/$name/bin" "$cache/_logs"
printf '{"name":"%s","version":"1.0.0","bin":{"%s":"bin/server.js"}}\n' "$name" "$name" > "$prefix/node_modules/$name/package.json"
printf '{"packages":{"node_modules/%s":{"resolved":"https://npm.artifacts.example.invalid/npm/%s/-/%s-1.0.0.tgz"}}}\n' "$name" "$name" "$name" > "$prefix/package-lock.json"
"#,
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&node, fs::Permissions::from_mode(0o755)).unwrap();
            fs::set_permissions(&npm, fs::Permissions::from_mode(0o755)).unwrap();
        }

        let store = temp.path().join("store");
        let status_file = root
            .join("health-status")
            .join("managed_node_package_preparation.json");
        env::set_var("portico_MANAGED_NODE_DIRECT_NPM", "1");
        env::set_var("portico_MANAGED_NODE_NPM_BIN", &npm);
        env::set_var("HOST_NODE_PATH", &node);
        env::set_var("portico_MANAGED_NODE_MCP_PACKAGES_DIR", &store);

        run_prepare_managed_node_packages(
            &root,
            None,
            true,
            Some("docker"),
            true,
            Some(&status_file),
        )
        .unwrap();

        assert!(store
            .join("good-node")
            .join("package")
            .join("node_modules/good-package/package.json")
            .is_file());
        assert!(!store
            .join("bad-node")
            .join("package")
            .join("node_modules/bad-package/package.json")
            .exists());
        let status: Value =
            serde_json::from_str(&fs::read_to_string(&status_file).unwrap()).unwrap();
        assert_eq!(status["best_effort"], true);
        assert_eq!(status["prepared"][0]["server_id"], "good-node");
        assert_eq!(
            status["failures"]["bad-node"]["package_spec"],
            "bad-package@1.0.0"
        );
        assert!(status["failures"]["bad-node"]["error"]
            .as_str()
            .unwrap()
            .contains("sandboxed npm install failed"));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let good_server_dir = config_root.join("good-node");
            fs::set_permissions(&good_server_dir, fs::Permissions::from_mode(0o500)).unwrap();
            let error = run_prepare_managed_node_packages(
                &root,
                None,
                true,
                Some("docker"),
                true,
                Some(&status_file),
            )
            .unwrap_err();
            fs::set_permissions(&good_server_dir, fs::Permissions::from_mode(0o700)).unwrap();
            assert!(
                format!("{error:#}").contains("Permission denied"),
                "app-owned metadata write failures must remain fatal: {error:#}"
            );
        }

        env::remove_var("portico_MANAGED_NODE_DIRECT_NPM");
        env::remove_var("portico_MANAGED_NODE_NPM_BIN");
        env::remove_var("HOST_NODE_PATH");
        env::remove_var("portico_MANAGED_NODE_MCP_PACKAGES_DIR");
    }

    #[test]
    fn direct_prepare_reports_missing_npm_executable() {
        let _guard = crate::test_env_lock();
        let temp = tempdir().unwrap();
        let root = temp.path().join("project");
        let server_id = "docker-node-demo";
        let server_dir = root.join("mcp-configs-user").join(server_id);
        fs::create_dir_all(&server_dir).unwrap();
        fs::write(
            server_dir.join(format!("{server_id}.fragment")),
            r#"{"command":"npx","args":["-y","demo-server@1.0.0"]}"#,
        )
        .unwrap();
        fs::write(
            server_dir.join(format!("{server_id}.yaml")),
            "name: docker-demo\nid: docker-demo\ndeployment_type: docker\n",
        )
        .unwrap();
        fs::write(
            root.join("mcp_toggles.json"),
            r#"{"docker-node-demo":true}"#,
        )
        .unwrap();
        fs::write(
            root.join(".npmrc"),
            "registry=https://npm.artifacts.example.invalid/harbor/\n",
        )
        .unwrap();
        let missing_npm = temp.path().join("missing").join("npm");
        env::set_var("portico_MANAGED_NODE_DIRECT_NPM", "1");
        env::set_var("portico_MANAGED_NODE_NPM_BIN", &missing_npm);
        env::set_var(
            "portico_MANAGED_NODE_MCP_PACKAGES_DIR",
            temp.path().join("store"),
        );

        let error =
            run_prepare_managed_node_packages(&root, None, true, Some("docker"), false, None)
                .unwrap_err();
        let error_chain = format!("{error:#}");
        assert!(error_chain.contains("package_prepare_failed:docker-node-demo"));
        assert!(error_chain.contains("requires executable npm"));
        assert!(error_chain.contains("portico_MANAGED_NODE_NPM_BIN"));

        env::remove_var("portico_MANAGED_NODE_DIRECT_NPM");
        env::remove_var("portico_MANAGED_NODE_NPM_BIN");
        env::remove_var("portico_MANAGED_NODE_MCP_PACKAGES_DIR");
    }

    #[test]
    fn prepare_rejects_public_package_lock_resolved_host() {
        let _guard = crate::test_env_lock();
        let temp = tempdir().unwrap();
        let root = temp.path().join("project");
        let server_id = "docker-public-lock";
        let server_dir = root.join("mcp-configs-user").join(server_id);
        fs::create_dir_all(&server_dir).unwrap();
        fs::write(
            server_dir.join(format!("{server_id}.fragment")),
            r#"{"command":"npx","args":["-y","demo-server@1.0.0"]}"#,
        )
        .unwrap();
        fs::write(
            server_dir.join(format!("{server_id}.yaml")),
            "name: docker-public-lock\nid: docker-public-lock\ndeployment_type: docker\n",
        )
        .unwrap();
        fs::write(
            root.join("mcp_toggles.json"),
            r#"{"docker-public-lock":true}"#,
        )
        .unwrap();
        fs::write(
            root.join(".npmrc"),
            "registry=https://npm.artifacts.example.invalid/harbor/\n",
        )
        .unwrap();

        let bin_dir = temp.path().join("bin");
        fs::create_dir_all(&bin_dir).unwrap();
        let node = bin_dir.join("node");
        let npm = bin_dir.join("npm");
        let invocation_log = temp.path().join("npm-invocations.log");
        fs::write(&node, "#!/bin/sh\nexit 0\n").unwrap();
        fs::write(
            &npm,
            format!(
                r#"#!/bin/sh
printf 'run\n' >> "{}"
prefix=""
cache=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) prefix="$2"; shift 2 ;;
    --cache) cache="$2"; shift 2 ;;
    *) shift ;;
  esac
done
mkdir -p "$prefix/node_modules/demo-server/bin"
mkdir -p "$cache/_logs"
printf '{{"name":"demo-server","version":"1.0.0","bin":{{"demo-server":"bin/server.js"}}}}\n' > "$prefix/node_modules/demo-server/package.json"
printf '{{"packages":{{"node_modules/demo-server":{{"resolved":"https://registry.npmjs.org/demo-server/-/demo-server-1.0.0.tgz"}}}}}}\n' > "$prefix/package-lock.json"
printf '%s\n' \
  '17 http fetch GET 200 https://npm.artifacts.example.invalid/npm/demo-server 512ms' \
  > "$cache/_logs/2026-06-17T01_03_23_996Z-debug-0.log"
"#,
                invocation_log.display()
            ),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&node, fs::Permissions::from_mode(0o755)).unwrap();
            fs::set_permissions(&npm, fs::Permissions::from_mode(0o755)).unwrap();
        }

        env::set_var("portico_MANAGED_NODE_DIRECT_NPM", "1");
        env::set_var("portico_MANAGED_NODE_NPM_BIN", &npm);
        let store = temp.path().join("store");
        env::set_var("portico_MANAGED_NODE_MCP_PACKAGES_DIR", &store);

        let error =
            run_prepare_managed_node_packages(&root, None, true, Some("docker"), false, None)
                .unwrap_err();
        let error_chain = format!("{error:#}");

        assert!(
            error_chain.contains("package-lock URL host 'registry.npmjs.org'"),
            "unexpected managed Node preparation failure: {error_chain}"
        );
        let install_root = store.join(server_id).join("package");
        assert!(
            !install_root.exists(),
            "failed package audit must remove the generated install root"
        );
        let acquisition_log = root
            .join("open-webui-data")
            .join("managed-node-mcp-package-acquisition")
            .join(server_id)
            .join("npm-cache")
            .join("_logs")
            .join("2026-06-17T01_03_23_996Z-debug-0.log");
        assert!(
            acquisition_log.is_file(),
            "failed package audit must retain npm acquisition logs"
        );

        let retry_error =
            run_prepare_managed_node_packages(&root, None, true, Some("docker"), false, None)
                .unwrap_err();
        assert!(format!("{retry_error:#}").contains("package-lock URL host 'registry.npmjs.org'"));
        assert_eq!(
            fs::read_to_string(&invocation_log).unwrap().lines().count(),
            2,
            "retry must invoke npm again instead of trusting the rejected install"
        );

        env::remove_var("portico_MANAGED_NODE_DIRECT_NPM");
        env::remove_var("portico_MANAGED_NODE_NPM_BIN");
        env::remove_var("portico_MANAGED_NODE_MCP_PACKAGES_DIR");
    }

    #[test]
    fn prepare_rejects_cached_public_package_lock_resolved_host() {
        let _guard = crate::test_env_lock();
        let temp = tempdir().unwrap();
        let root = temp.path().join("project");
        let server_id = "cached-public-lock";
        let server_dir = root.join("mcp-configs").join(server_id);
        fs::create_dir_all(&server_dir).unwrap();
        fs::write(
            server_dir.join(format!("{server_id}.fragment")),
            json!({
                "command": MANAGED_NODE_SENTINEL_COMMAND,
                "args": [],
                MANAGED_NODE_PACKAGE_KEY: {
                    "schema_version": 1,
                    "server_id": server_id,
                    "package_manager": "npm",
                    "requested_spec": "demo-server@1.0.0",
                    "package_name": "demo-server",
                    "requested_range": "1.0.0",
                    "runtime_args": []
                }
            })
            .to_string(),
        )
        .unwrap();

        let store = temp.path().join("store");
        let install_root = store.join(server_id).join("package");
        let package_dir = install_root.join("node_modules").join("demo-server");
        fs::create_dir_all(&package_dir).unwrap();
        fs::write(
            package_dir.join("package.json"),
            r#"{"name":"demo-server","version":"1.0.0","bin":{"demo-server":"bin/server.js"}}"#,
        )
        .unwrap();
        fs::write(
            install_root.join("package-lock.json"),
            r#"{"packages":{"node_modules/demo-server":{"resolved":"https://registry.npmjs.org/demo-server/-/demo-server-1.0.0.tgz"}}}"#,
        )
        .unwrap();
        env::set_var("portico_MANAGED_NODE_MCP_PACKAGES_DIR", &store);

        let error = run_prepare_managed_node_packages(
            &root,
            Some(server_id),
            true,
            Some("docker"),
            false,
            None,
        )
        .unwrap_err();
        let error_chain = format!("{error:#}");

        assert!(error_chain.contains("cached managed Node package"));
        assert!(error_chain.contains("package-lock URL host 'registry.npmjs.org'"));
        assert!(
            !install_root.exists(),
            "invalid cached package must be removed before retry"
        );

        env::remove_var("portico_MANAGED_NODE_MCP_PACKAGES_DIR");
    }

    #[test]
    fn prepare_removes_legacy_runtime_visible_acquisition_scratch() {
        let _guard = crate::test_env_lock();
        let temp = tempdir().unwrap();
        let root = temp.path().join("project");
        let server_id = "docker-demo";
        let server_dir = root.join("mcp-configs-user").join(server_id);
        fs::create_dir_all(&server_dir).unwrap();
        fs::write(
            server_dir.join(format!("{server_id}.fragment")),
            json!({
                "command": MANAGED_NODE_SENTINEL_COMMAND,
                "args": [],
                MANAGED_NODE_PACKAGE_KEY: {
                    "schema_version": 1,
                    "server_id": server_id,
                    "package_manager": "npm",
                    "requested_spec": "demo-server@1.0.0",
                    "package_name": "demo-server",
                    "requested_range": "1.0.0",
                    "runtime_args": []
                }
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            server_dir.join(format!("{server_id}.yaml")),
            "name: docker-demo\nid: docker-demo\ndeployment_type: docker\n",
        )
        .unwrap();

        let store = root
            .join("open-webui-data")
            .join("managed-node-mcp-packages");
        let runtime_server_root = store.join(server_id);
        let package_dir = runtime_server_root
            .join("package")
            .join("node_modules")
            .join("demo-server");
        fs::create_dir_all(&package_dir).unwrap();
        fs::write(
            package_dir.join("package.json"),
            r#"{"name":"demo-server","version":"1.0.0","bin":{"demo-server":"bin/server.js"}}"#,
        )
        .unwrap();
        for dir in ["npm-cache", "home", "tmp"] {
            let dir_path = runtime_server_root.join(dir);
            fs::create_dir_all(&dir_path).unwrap();
            fs::write(
                dir_path.join(".npmrc"),
                "_authToken=should-not-be-mounted\n",
            )
            .unwrap();
        }
        fs::write(
            runtime_server_root.join("managed-node-install.npmrc"),
            "_authToken=should-not-be-mounted\n",
        )
        .unwrap();
        env::set_var("portico_MANAGED_NODE_MCP_PACKAGES_DIR", &store);

        run_prepare_managed_node_packages(
            &root,
            Some(server_id),
            true,
            Some("docker"),
            false,
            None,
        )
        .unwrap();

        assert!(package_dir.join("package.json").is_file());
        for dir in ["npm-cache", "home", "tmp"] {
            assert!(!runtime_server_root.join(dir).exists());
        }
        assert!(!runtime_server_root
            .join("managed-node-install.npmrc")
            .exists());

        env::remove_var("portico_MANAGED_NODE_MCP_PACKAGES_DIR");
    }

    #[test]
    fn enabled_only_prepare_skips_disabled_managed_recipes_without_sandbox_requirements() {
        let _guard = crate::test_env_lock();
        let temp = tempdir().unwrap();
        let root = temp.path().join("project");
        let server_id = "disabled-demo";
        let server_dir = root.join("mcp-configs-user").join(server_id);
        fs::create_dir_all(&server_dir).unwrap();
        let fragment_path = server_dir.join(format!("{server_id}.fragment"));
        fs::write(
            &fragment_path,
            r#"{"command":"npx","args":["-y","demo-server@1.0.0"]}"#,
        )
        .unwrap();
        fs::write(
            server_dir.join(format!("{server_id}.yaml")),
            "name: disabled-demo\nid: disabled-demo\ndeployment_type: docker\n",
        )
        .unwrap();
        fs::write(root.join("mcp_toggles.json"), r#"{"disabled-demo":false}"#).unwrap();
        env::remove_var("portico_MANAGED_NODE_SRT_CLI");
        env::remove_var("portico_MANAGED_NODE_SRT_RUNNER_JS");
        env::remove_var("portico_MANAGED_NODE_SRT_CLI_JS");
        env::remove_var("HOST_MCP_SRT_CLI_JS");
        env::remove_var("HOST_MCP_SRT_RUNNER_JS");
        env::remove_var("SRT_CLI_PATH");

        let yaml_path = server_dir.join(format!("{server_id}.yaml"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&fragment_path, fs::Permissions::from_mode(0o000)).unwrap();
            fs::set_permissions(&yaml_path, fs::Permissions::from_mode(0o000)).unwrap();
        }

        run_prepare_managed_node_packages(&root, None, true, None, false, None).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&fragment_path, fs::Permissions::from_mode(0o600)).unwrap();
            fs::set_permissions(&yaml_path, fs::Permissions::from_mode(0o600)).unwrap();
        }
        let fragment: Value =
            serde_json::from_str(&fs::read_to_string(fragment_path).unwrap()).unwrap();
        assert_eq!(fragment["command"], "npx");
        assert!(!server_dir.join("managed-package.json").exists());
    }

    #[test]
    fn enabled_only_prepare_skips_asset_only_system_directories() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("project");
        let server_dir = root.join("mcp-configs").join("composio");
        fs::create_dir_all(&server_dir).unwrap();
        fs::write(server_dir.join("composio.png"), b"placeholder icon").unwrap();
        fs::write(root.join("mcp_toggles.json"), "{}\n").unwrap();

        run_prepare_managed_node_packages(&root, None, true, Some("docker"), false, None).unwrap();
    }

    #[test]
    fn deployment_filter_skips_non_matching_enabled_managed_recipes() {
        let _guard = crate::test_env_lock();
        let temp = tempdir().unwrap();
        let root = temp.path().join("project");
        let server_id = "host-demo";
        let server_dir = root.join("mcp-configs-user").join(server_id);
        fs::create_dir_all(&server_dir).unwrap();
        let fragment_path = server_dir.join(format!("{server_id}.fragment"));
        fs::write(
            &fragment_path,
            r#"{"command":"npx","args":["-y","demo-server@1.0.0"]}"#,
        )
        .unwrap();
        fs::write(
            server_dir.join(format!("{server_id}.yaml")),
            "name: host-demo\nid: host-demo\ndeployment_type: host\n",
        )
        .unwrap();
        fs::write(root.join("mcp_toggles.json"), r#"{"host-demo":true}"#).unwrap();
        env::remove_var("portico_MANAGED_NODE_SRT_CLI");
        env::remove_var("portico_MANAGED_NODE_SRT_RUNNER_JS");
        env::remove_var("portico_MANAGED_NODE_SRT_CLI_JS");
        env::remove_var("HOST_MCP_SRT_CLI_JS");
        env::remove_var("HOST_MCP_SRT_RUNNER_JS");
        env::remove_var("SRT_CLI_PATH");

        run_prepare_managed_node_packages(&root, None, true, Some("docker"), false, None).unwrap();

        let fragment: Value =
            serde_json::from_str(&fs::read_to_string(fragment_path).unwrap()).unwrap();
        assert_eq!(fragment["command"], "npx");
        assert!(!server_dir.join("managed-package.json").exists());
    }

    #[test]
    fn docker_deployment_prepare_rejects_public_registry_before_npm_runs() {
        let _guard = crate::test_env_lock();
        let temp = tempdir().unwrap();
        let root = temp.path().join("project");
        let server_id = "docker-node-demo";
        let server_dir = root.join("mcp-configs-user").join(server_id);
        fs::create_dir_all(&server_dir).unwrap();
        fs::write(
            server_dir.join(format!("{server_id}.fragment")),
            r#"{"command":"npx","args":["-y","demo-server@1.0.0"]}"#,
        )
        .unwrap();
        fs::write(
            server_dir.join(format!("{server_id}.yaml")),
            "name: docker-node-demo\nid: docker-node-demo\ndeployment_type: docker\n",
        )
        .unwrap();
        fs::write(
            root.join("mcp_toggles.json"),
            r#"{"docker-node-demo":true}"#,
        )
        .unwrap();
        let public_npmrc = temp.path().join("public.npmrc");
        fs::write(&public_npmrc, "registry=https://registry.npmjs.org/\n").unwrap();

        let bin_dir = temp.path().join("bin");
        fs::create_dir_all(&bin_dir).unwrap();
        let srt = bin_dir.join("srt");
        let node = bin_dir.join("node");
        let runner = bin_dir.join("srt-sandbox-runner.mjs");
        let cli_js = bin_dir.join("srt-cli.js");
        let npm = bin_dir.join("npm");
        let npm_log = temp.path().join("npm-ran.log");
        fs::write(&srt, "#!/bin/sh\nexit 70\n").unwrap();
        fs::write(&node, "#!/bin/sh\nexit 71\n").unwrap();
        fs::write(&runner, "").unwrap();
        fs::write(&cli_js, "").unwrap();
        fs::write(
            &npm,
            format!(
                "#!/bin/sh\nprintf 'npm should not run\\n' > '{}'\nexit 72\n",
                npm_log.display()
            ),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&srt, fs::Permissions::from_mode(0o755)).unwrap();
            fs::set_permissions(&node, fs::Permissions::from_mode(0o755)).unwrap();
            fs::set_permissions(&npm, fs::Permissions::from_mode(0o755)).unwrap();
        }

        env::set_var("portico_MANAGED_NODE_SRT_CLI", &srt);
        env::set_var("portico_MANAGED_NODE_SRT_RUNNER_JS", &runner);
        env::set_var("portico_MANAGED_NODE_SRT_CLI_JS", &cli_js);
        env::set_var("HOST_NODE_PATH", &node);
        env::set_var("portico_MANAGED_NODE_NPM_BIN", &npm);
        env::set_var("portico_MANAGED_NODE_NPMRC", &public_npmrc);
        env::set_var(
            "portico_MANAGED_NODE_MCP_PACKAGES_DIR",
            temp.path().join("store"),
        );

        let error =
            run_prepare_managed_node_packages(&root, None, true, Some("docker"), false, None)
                .unwrap_err();
        let error_chain = format!("{error:#}");

        assert!(error_chain.contains("package_prepare_failed:docker-node-demo"));
        assert!(error_chain.contains("Portico npm registry"));
        assert!(!npm_log.exists());

        env::remove_var("portico_MANAGED_NODE_SRT_CLI");
        env::remove_var("portico_MANAGED_NODE_SRT_RUNNER_JS");
        env::remove_var("portico_MANAGED_NODE_SRT_CLI_JS");
        env::remove_var("HOST_NODE_PATH");
        env::remove_var("portico_MANAGED_NODE_NPM_BIN");
        env::remove_var("portico_MANAGED_NODE_NPMRC");
        env::remove_var("portico_MANAGED_NODE_MCP_PACKAGES_DIR");
    }

    #[test]
    fn explicit_server_filter_ignores_deployment_filter() {
        let _guard = crate::test_env_lock();
        let temp = tempdir().unwrap();
        let root = temp.path().join("project");
        let server_id = "host-demo";
        let server_dir = root.join("mcp-configs-user").join(server_id);
        fs::create_dir_all(&server_dir).unwrap();
        fs::write(
            server_dir.join(format!("{server_id}.fragment")),
            json!({
                "command": MANAGED_NODE_SENTINEL_COMMAND,
                "args": [],
                MANAGED_NODE_PACKAGE_KEY: {
                    "schema_version": 1,
                    "server_id": server_id,
                    "package_manager": "npm",
                    "requested_spec": "demo-server@1.0.0",
                    "package_name": "demo-server",
                    "requested_range": "1.0.0",
                    "runtime_args": []
                }
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            server_dir.join(format!("{server_id}.yaml")),
            "name: host-demo\nid: host-demo\ndeployment_type: host\n",
        )
        .unwrap();
        let package_dir = root
            .join("open-webui-data")
            .join("managed-node-mcp-packages")
            .join(server_id)
            .join("package")
            .join("node_modules")
            .join("demo-server");
        fs::create_dir_all(&package_dir).unwrap();
        fs::write(
            package_dir.join("package.json"),
            r#"{"name":"demo-server","version":"1.0.0","bin":{"demo-server":"bin/server.js"}}"#,
        )
        .unwrap();
        env::set_var(
            "portico_MANAGED_NODE_MCP_PACKAGES_DIR",
            root.join("open-webui-data")
                .join("managed-node-mcp-packages"),
        );

        run_prepare_managed_node_packages(
            &root,
            Some(server_id),
            true,
            Some("docker"),
            false,
            None,
        )
        .unwrap();

        env::remove_var("portico_MANAGED_NODE_MCP_PACKAGES_DIR");
    }

    #[test]
    fn disallowed_host_detection_ignores_stale_npm_logs() {
        let temp = tempdir().unwrap();
        let logs = temp.path().join("_logs");
        fs::create_dir_all(&logs).unwrap();
        let stale = logs.join("2026-01-01T00_00_00_000Z-debug-0.log");
        let latest = logs.join("2026-01-02T00_00_00_000Z-debug-0.log");
        fs::write(
            &stale,
            "17 http fetch GET 200 https://registry.npmjs.com/demo 512ms\n",
        )
        .unwrap();
        fs::write(
            &latest,
            "17 http fetch GET 200 https://npm.artifacts.example.invalid/npm/demo 512ms\n",
        )
        .unwrap();

        assert_eq!(
            first_disallowed_npm_log_host(temp.path(), &["npm.artifacts.example.invalid".to_string()]),
            None
        );
    }

    #[test]
    fn disallowed_host_detection_ignores_npm_update_notice_urls() {
        let temp = tempdir().unwrap();
        let logs = temp.path().join("_logs");
        fs::create_dir_all(&logs).unwrap();
        let latest = logs.join("2026-06-17T01_03_23_996Z-debug-0.log");
        fs::write(
            &latest,
            concat!(
                "84 http fetch GET 200 https://npm.artifacts.example.invalid/npm/npm 1697ms\n",
                "1541 notice New major version of npm available! 10.9.8 -> 11.16.0\n",
                "1541 notice Changelog: https://github.com/npm/cli/releases/tag/v11.16.0\n",
                "1542 verbose exit 0\n"
            ),
        )
        .unwrap();

        assert_eq!(
            first_disallowed_npm_log_host(temp.path(), &["npm.artifacts.example.invalid".to_string()]),
            None
        );
    }

    #[test]
    fn disallowed_host_detection_reports_public_npm_logs() {
        let temp = tempdir().unwrap();
        let logs = temp.path().join("_logs");
        fs::create_dir_all(&logs).unwrap();
        let latest = logs.join("2026-01-02T00_00_00_000Z-debug-0.log");
        fs::write(
            &latest,
            "17 http fetch GET 200 https://registry.npmjs.org/demo 512ms\n",
        )
        .unwrap();

        assert_eq!(
            first_disallowed_npm_log_host(temp.path(), &["npm.artifacts.example.invalid".to_string()]),
            Some("registry.npmjs.org".to_string())
        );
    }

    #[test]
    fn package_lock_host_detection_ignores_metadata_urls() {
        let lock = json!({
            "packages": {
                "node_modules/demo-server": {
                    "resolved": "https://npm.artifacts.example.invalid/harbor/demo-server/-/demo-server-1.0.0.tgz",
                    "funding": {
                        "url": "https://github.com/sponsors/example"
                    },
                    "homepage": "https://github.com/example/demo-server"
                }
            }
        });

        assert_eq!(
            first_disallowed_url_host_in_json(&lock, &["npm.artifacts.example.invalid".to_string()]),
            None
        );
    }

    #[test]
    fn managed_package_allowlist_includes_internal_artifact_download_host() {
        let temp = tempdir().unwrap();
        let npmrc = temp.path().join(".npmrc");
        fs::write(&npmrc, "registry=https://npm.artifacts.example.invalid/npm/\n").unwrap();

        let allowed = managed_package_allowed_domains(&npmrc).unwrap();

        assert!(allowed.contains(&"npm.artifacts.example.invalid".to_string()));
        assert!(allowed.contains(&"dl.artifacts.example.invalid".to_string()));
        assert!(!allowed.contains(&"registry.npmjs.com".to_string()));
    }

    #[test]
    fn managed_package_allowlist_rejects_public_registry_hosts() {
        let temp = tempdir().unwrap();
        let npmrc = temp.path().join(".npmrc");
        fs::write(&npmrc, "registry=https://registry.npmjs.org/\n").unwrap();

        let error = managed_package_allowed_domains(&npmrc).unwrap_err();
        let error_chain = format!("{error:#}");

        assert!(error_chain.contains("Portico npm registry"));
    }
}
