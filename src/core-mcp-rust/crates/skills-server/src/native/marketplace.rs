use super::*;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};

const MARKETPLACE_READ_TIMEOUT_SECONDS: f64 = 30.0;
const MARKETPLACE_MUTATION_TIMEOUT_SECONDS: f64 = 120.0;
const MARKETPLACE_SYNC_ALL_TIMEOUT_SECONDS: f64 = 180.0;
#[cfg(unix)]
const CROSS_DEVICE_RENAME_ERROR_CODE: i32 = 18;
#[cfg(windows)]
const CROSS_DEVICE_RENAME_ERROR_CODE: i32 = 17;
#[cfg(not(any(unix, windows)))]
const CROSS_DEVICE_RENAME_ERROR_CODE: i32 = -1;

struct ElectronJsonResponse {
    status: reqwest::StatusCode,
    json: Option<Value>,
    body_text: String,
}

async fn electron_marketplace_get(
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

async fn electron_marketplace_post(
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

fn electron_marketplace_transport_failure(action: &str, error: &reqwest::Error) -> Value {
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
        "error": error_message,
    })
}

fn normalize_marketplace_response(action: &str, response: ElectronJsonResponse) -> Value {
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
                payload["http_status"] = json!(status.as_u16());
            }
            payload
        }
        None => json!({
            "success": false,
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

async fn marketplace_get_payload(action: &str, path: &str, timeout_seconds: f64) -> Value {
    match electron_marketplace_get(path, timeout_seconds).await {
        Ok(response) => normalize_marketplace_response(action, response),
        Err(error) => electron_marketplace_transport_failure(action, &error),
    }
}

async fn marketplace_post_payload(
    action: &str,
    path: &str,
    payload: &Value,
    timeout_seconds: f64,
) -> Value {
    match electron_marketplace_post(path, payload, timeout_seconds).await {
        Ok(response) => normalize_marketplace_response(action, response),
        Err(error) => electron_marketplace_transport_failure(action, &error),
    }
}

fn archive_relative_path(path: &Path) -> Result<String> {
    let root = app_root()?;
    Ok(path_to_unix_string(&root, path).unwrap_or_else(|| path.to_string_lossy().to_string()))
}

fn next_skill_archive_path(skill_name: &str) -> Result<PathBuf> {
    let archive_root = app_root()?.join("skills-archive");
    fs::create_dir_all(&archive_root).with_context(|| {
        format!(
            "failed to create archive directory {}",
            archive_root.display()
        )
    })?;
    let safe_skill_name = safe_path_component(skill_name);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    Ok(archive_root.join(format!(
        "{timestamp}-{safe_skill_name}-{}",
        Uuid::new_v4().simple()
    )))
}

fn is_cross_device_rename_error(error: &std::io::Error) -> bool {
    error.raw_os_error() == Some(CROSS_DEVICE_RENAME_ERROR_CODE)
}

fn next_archive_staging_path(destination: &Path) -> PathBuf {
    destination.with_file_name(format!(
        ".{}.staging-{}",
        destination
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("archive"),
        Uuid::new_v4().simple()
    ))
}

fn copy_directory_recursive(source: &Path, destination: &Path) -> Result<()> {
    for entry in WalkDir::new(source) {
        let entry = entry.with_context(|| format!("failed to read {}", source.display()))?;
        let relative = entry.path().strip_prefix(source).with_context(|| {
            format!("failed to derive relative path under {}", source.display())
        })?;
        let target = if relative.as_os_str().is_empty() {
            destination.to_path_buf()
        } else {
            destination.join(relative)
        };

        if entry.file_type().is_dir() {
            fs::create_dir_all(&target)
                .with_context(|| format!("failed to create {}", target.display()))?;
            continue;
        }

        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }
        fs::copy(entry.path(), &target).with_context(|| {
            format!(
                "failed to copy {} to {}",
                entry.path().display(),
                target.display()
            )
        })?;
    }

    Ok(())
}

fn copy_directory_with_staging(source: &Path, destination: &Path) -> Result<()> {
    let staging_path = next_archive_staging_path(destination);
    let copy_result = (|| -> Result<()> {
        fs::create_dir_all(&staging_path)
            .with_context(|| format!("failed to create {}", staging_path.display()))?;
        copy_directory_recursive(source, &staging_path)?;
        fs::rename(&staging_path, destination).with_context(|| {
            format!(
                "failed to promote staged archive {} to {}",
                staging_path.display(),
                destination.display()
            )
        })?;

        if let Err(remove_error) = fs::remove_dir_all(source) {
            return match fs::remove_dir_all(destination) {
                Ok(()) => Err(remove_error).with_context(|| {
                    format!(
                        "failed to remove original skill directory {} after copying archive",
                        source.display()
                    )
                }),
                Err(cleanup_error) => Err(anyhow::anyhow!(
                    "failed to remove original skill directory {} after copying archive: {}; also failed to remove staged archive {}: {}",
                    source.display(),
                    remove_error,
                    destination.display(),
                    cleanup_error
                )),
            };
        }

        Ok(())
    })();

    if copy_result.is_err() && staging_path.exists() {
        let _ = fs::remove_dir_all(&staging_path);
    }

    copy_result
}

fn move_directory_with_fallback<F>(
    source: &Path,
    destination: &Path,
    initial_rename: F,
) -> Result<()>
where
    F: FnOnce(&Path, &Path) -> std::io::Result<()>,
{
    match initial_rename(source, destination) {
        Ok(()) => Ok(()),
        Err(error) if is_cross_device_rename_error(&error) => {
            copy_directory_with_staging(source, destination)
        }
        Err(error) => Err(error.into()),
    }
}

fn archive_skill_directory(source: &Path, skill_name: &str) -> Result<PathBuf> {
    let archive_path = next_skill_archive_path(skill_name)?;
    if let Some(parent) = archive_path.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!(
                "failed to create archive parent directory {}",
                parent.display()
            )
        })?;
    }
    move_directory_with_fallback(source, &archive_path, |from, to| fs::rename(from, to))?;
    Ok(archive_path)
}

pub(super) async fn handle_list_marketplaces(_arguments: &Map<String, Value>) -> Result<Value> {
    success_text(
        marketplace_get_payload(
            "list marketplaces",
            "/api/marketplaces",
            MARKETPLACE_READ_TIMEOUT_SECONDS,
        )
        .await,
    )
}

pub(super) async fn handle_add_marketplace(arguments: &Map<String, Value>) -> Result<Value> {
    let source_input = string_arg(arguments, "source_input")?;
    success_text(
        marketplace_post_payload(
            "add marketplace",
            "/api/marketplaces",
            &json!({ "source_input": source_input }),
            MARKETPLACE_MUTATION_TIMEOUT_SECONDS,
        )
        .await,
    )
}

pub(super) async fn handle_remove_marketplace(arguments: &Map<String, Value>) -> Result<Value> {
    let marketplace_id = string_arg(arguments, "marketplace_id")?;
    let remove_installed_skills = bool_arg(arguments, "remove_installed_skills", false);
    success_text(
        marketplace_post_payload(
            "remove marketplace",
            "/api/marketplaces/remove",
            &json!({
                "marketplace_id": marketplace_id,
                "remove_installed_skills": remove_installed_skills,
            }),
            MARKETPLACE_MUTATION_TIMEOUT_SECONDS,
        )
        .await,
    )
}

pub(super) async fn handle_sync_marketplace(arguments: &Map<String, Value>) -> Result<Value> {
    let marketplace_id = string_arg(arguments, "marketplace_id")?;
    success_text(
        marketplace_post_payload(
            "sync marketplace",
            "/api/marketplaces/sync",
            &json!({ "marketplace_id": marketplace_id }),
            MARKETPLACE_MUTATION_TIMEOUT_SECONDS,
        )
        .await,
    )
}

pub(super) async fn handle_sync_all_marketplaces(_arguments: &Map<String, Value>) -> Result<Value> {
    success_text(
        marketplace_post_payload(
            "sync all marketplaces",
            "/api/marketplaces/sync-all",
            &json!({}),
            MARKETPLACE_SYNC_ALL_TIMEOUT_SECONDS,
        )
        .await,
    )
}

// Second phase of the destructive sync. A sync response's pendingRemovals
// lists installed skills that no longer exist upstream AND are still used by
// agents; applying the removals unlinks editable agents and deletes the
// skills, so it is gated on the same confirm contract as delete_agent /
// delete_skill: the model must relay the pending list to the user and only
// pass confirm=true after an explicit go-ahead.
pub(super) async fn handle_apply_marketplace_sync_removals(
    arguments: &Map<String, Value>,
) -> Result<Value> {
    let marketplace_id = string_arg(arguments, "marketplace_id")?;
    let removals = arguments
        .get("removals")
        .cloned()
        .unwrap_or_else(|| json!([]));
    if !bool_arg(arguments, "confirm", false) {
        return success_text(json!({
            "success": false,
            "error": "Set confirm=true to apply the removals — only after the user explicitly approved removing these skills and unlinking them from their agents",
        }));
    }
    success_text(
        marketplace_post_payload(
            "apply marketplace sync removals",
            "/api/marketplaces/apply-sync-removals",
            &json!({
                "marketplace_id": marketplace_id,
                "removals": removals,
            }),
            MARKETPLACE_MUTATION_TIMEOUT_SECONDS,
        )
        .await,
    )
}

pub(super) async fn handle_get_marketplace_skills(arguments: &Map<String, Value>) -> Result<Value> {
    let marketplace_id = string_arg(arguments, "marketplace_id")?;
    let mut query = Vec::new();
    for key in ["plugin_name", "search"] {
        if let Some(value) = arguments
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            query.push(format!(
                "{key}={}",
                utf8_percent_encode(value, NON_ALPHANUMERIC)
            ));
        }
    }
    if let Some(limit) = arguments
        .get("limit")
        .and_then(Value::as_u64)
        .filter(|limit| *limit > 0)
    {
        query.push(format!("limit={limit}"));
    }
    let query_string = if query.is_empty() {
        String::new()
    } else {
        format!("?{}", query.join("&"))
    };
    success_text(
        marketplace_get_payload(
            "get marketplace skills",
            &format!(
                "/api/marketplaces/{}/skills{}",
                marketplace_id, query_string
            ),
            MARKETPLACE_READ_TIMEOUT_SECONDS,
        )
        .await,
    )
}

fn optional_plugin_name(arguments: &Map<String, Value>) -> Value {
    arguments
        .get("plugin_name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| Value::String(value.to_string()))
        .unwrap_or(Value::Null)
}

pub(super) async fn handle_install_marketplace_skill(
    arguments: &Map<String, Value>,
) -> Result<Value> {
    let marketplace_id = string_arg(arguments, "marketplace_id")?;
    let skill_id = string_arg(arguments, "skill_id")?;
    let skill_path = string_arg(arguments, "skill_path")?;
    let skill_source = arguments
        .get("skill_source")
        .cloned()
        .unwrap_or(Value::Null);
    let plugin_name = optional_plugin_name(arguments);
    success_text(
        marketplace_post_payload(
            "install marketplace skill",
            "/api/marketplaces/skills/install",
            &json!({
                "marketplace_id": marketplace_id,
                "skill_id": skill_id,
                "skill_path": skill_path,
                "skill_source": skill_source,
                "plugin_name": plugin_name,
            }),
            MARKETPLACE_MUTATION_TIMEOUT_SECONDS,
        )
        .await,
    )
}

pub(super) async fn handle_replace_user_skill_with_marketplace_install(
    arguments: &Map<String, Value>,
) -> Result<Value> {
    let skill_name = string_arg(arguments, "skill_name")?;
    let marketplace_id = string_arg(arguments, "marketplace_id")?;
    let skill_id = string_arg(arguments, "skill_id")?;
    let skill_path = string_arg(arguments, "skill_path")?;
    let skill_source = arguments
        .get("skill_source")
        .cloned()
        .unwrap_or(Value::Null);

    let user_skill_path = validate_skill_path(&skill_name, None)?;
    if !user_skill_path.exists() {
        return success_text(json!({
            "success": false,
            "error": format!("Skill '{}' not found in skills-user", skill_name),
        }));
    }

    let install_payload = marketplace_post_payload(
        "install marketplace skill",
        "/api/marketplaces/skills/install",
        &json!({
            "marketplace_id": marketplace_id,
            "skill_id": skill_id,
            "skill_path": skill_path,
            "skill_source": skill_source,
            "plugin_name": optional_plugin_name(arguments),
        }),
        MARKETPLACE_MUTATION_TIMEOUT_SECONDS,
    )
    .await;

    let install_success = install_payload
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let already_installed =
        install_payload.get("errorCode").and_then(Value::as_str) == Some("skill_already_installed");

    if !install_success && !already_installed {
        return success_text(install_payload);
    }

    let archive_path = match archive_skill_directory(&user_skill_path, &skill_name) {
        Ok(path) => path,
        Err(error) => {
            if !already_installed {
                let _ = marketplace_post_payload(
                    "uninstall marketplace skill",
                    "/api/marketplaces/skills/uninstall",
                    &json!({
                        "marketplace_id": marketplace_id,
                        "skill_id": skill_id,
                    }),
                    MARKETPLACE_MUTATION_TIMEOUT_SECONDS,
                )
                .await;
            }

            return success_text(json!({
                "success": false,
                "error": format!("Failed to archive skill '{}': {}", skill_name, error),
            }));
        }
    };

    success_text(json!({
        "success": true,
        "skill_name": skill_name,
        "display_name": install_payload
            .get("display_name")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| core_mcp_shared::format_skill_display_name(
                skill_id.rsplit('/').next().unwrap_or(&skill_id),
            )),
        "marketplace_id": marketplace_id,
        "skill_id": skill_id,
        "already_installed": already_installed,
        "archived_to": archive_relative_path(&archive_path)?,
        "localPath": install_payload.get("localPath").cloned().unwrap_or(Value::Null),
        "version": install_payload.get("version").cloned().unwrap_or(Value::Null),
    }))
}

#[cfg(test)]
mod archive_tests {
    use super::*;

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(name: &str) -> Self {
            let path = env::temp_dir().join(format!(
                "skills-server-marketplace-{name}-{}",
                Uuid::new_v4().simple()
            ));
            fs::create_dir_all(&path).expect("create temp dir");
            Self { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn move_directory_with_fallback_copies_when_rename_crosses_devices() {
        let temp = TempDir::new("cross-device-archive");
        let source = temp.path.join("skills-user/writer");
        fs::create_dir_all(source.join("references")).expect("create source");
        fs::write(source.join("SKILL.md"), "# Writer\n").expect("write SKILL");
        fs::write(source.join("references/guide.md"), "guide\n").expect("write reference");

        let destination = temp.path.join("skills-archive/writer");
        fs::create_dir_all(destination.parent().expect("archive parent")).expect("create archive");

        move_directory_with_fallback(&source, &destination, |_from, _to| {
            Err(std::io::Error::from_raw_os_error(
                CROSS_DEVICE_RENAME_ERROR_CODE,
            ))
        })
        .expect("archive with copy fallback");

        assert!(!source.exists());
        assert_eq!(
            fs::read_to_string(destination.join("SKILL.md")).expect("read archived skill"),
            "# Writer\n"
        );
        assert_eq!(
            fs::read_to_string(destination.join("references/guide.md"))
                .expect("read archived reference"),
            "guide\n"
        );
    }
}

pub(super) async fn handle_uninstall_marketplace_skill(
    arguments: &Map<String, Value>,
) -> Result<Value> {
    let marketplace_id = string_arg(arguments, "marketplace_id")?;
    let skill_id = string_arg(arguments, "skill_id")?;
    success_text(
        marketplace_post_payload(
            "uninstall marketplace skill",
            "/api/marketplaces/skills/uninstall",
            &json!({
                "marketplace_id": marketplace_id,
                "skill_id": skill_id,
                "plugin_name": optional_plugin_name(arguments),
            }),
            MARKETPLACE_MUTATION_TIMEOUT_SECONDS,
        )
        .await,
    )
}

pub(super) async fn handle_detach_marketplace_skill_to_user_skill(
    arguments: &Map<String, Value>,
) -> Result<Value> {
    let marketplace_id = string_arg(arguments, "marketplace_id")?;
    let skill_id = string_arg(arguments, "skill_id")?;
    let target_skill_name = arguments
        .get("target_skill_name")
        .cloned()
        .unwrap_or(Value::Null);
    success_text(
        marketplace_post_payload(
            "detach marketplace skill to user skill",
            "/api/marketplaces/skills/detach",
            &json!({
                "marketplace_id": marketplace_id,
                "skill_id": skill_id,
                "target_skill_name": target_skill_name,
                "plugin_name": optional_plugin_name(arguments),
            }),
            MARKETPLACE_MUTATION_TIMEOUT_SECONDS,
        )
        .await,
    )
}

pub(super) async fn handle_check_marketplace_skill_updates(
    _arguments: &Map<String, Value>,
) -> Result<Value> {
    success_text(
        marketplace_post_payload(
            "check marketplace skill updates",
            "/api/marketplaces/skills/check-updates",
            &json!({}),
            MARKETPLACE_MUTATION_TIMEOUT_SECONDS,
        )
        .await,
    )
}

pub(super) async fn handle_update_marketplace_skill(
    arguments: &Map<String, Value>,
) -> Result<Value> {
    let marketplace_id = string_arg(arguments, "marketplace_id")?;
    let skill_id = string_arg(arguments, "skill_id")?;
    let force_discard_local_changes = bool_arg(arguments, "force_discard_local_changes", false);
    success_text(
        marketplace_post_payload(
            "update marketplace skill",
            "/api/marketplaces/skills/update",
            &json!({
                "marketplace_id": marketplace_id,
                "skill_id": skill_id,
                "force_discard_local_changes": force_discard_local_changes,
                "plugin_name": optional_plugin_name(arguments),
            }),
            MARKETPLACE_MUTATION_TIMEOUT_SECONDS,
        )
        .await,
    )
}
