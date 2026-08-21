use super::*;
use core_mcp_shared::{
    derive_skill_name, format_skill_display_name, parse_skill_file, resolve_skill_resource_path,
    SkillResourcePathError,
};
use std::path::Component;

fn skill_display_name(skill_name: &str) -> String {
    match find_skill(skill_name) {
        Ok(Some(skill)) => skill.effective_display_name(),
        _ => format_skill_display_name(skill_name.rsplit('/').next().unwrap_or(skill_name)),
    }
}

async fn proxy_user_skill_mutation(path: &str, payload: Value) -> Result<Value> {
    let response = electron_http_client()
        .post(format!("{}{}", electron_api_base(), path))
        .timeout(std::time::Duration::from_secs_f64(30.0))
        .json(&payload)
        .send()
        .await
        .with_context(|| format!("failed POST {}", path))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .with_context(|| format!("failed to read POST {} response", path))?;
    if let Ok(parsed) = serde_json::from_str::<Value>(&body) {
        return success_text(parsed);
    }
    bail!(
        "POST {} returned {} with a non-JSON response: {}",
        path,
        status,
        body
    )
}

// References and scripts are part of the published bundle, but their
// mutations are filesystem writes made HERE (never proxied through
// /api/user-skills/update, which is what marks the published link dirty for
// SKILL.md edits). Report each successful bundle-content change so a
// published skill's has_unpublished_changes stays truthful. Best-effort by
// design: the local mutation already succeeded, markLinkDirty no-ops for
// unlinked skills, and older app builds without the route only lose the
// dirty marker they never had. Memory-redis test mode skips the call for
// hermetic unit tests (same policy as skill_provenance_snapshot).
async fn mark_user_skill_dirty(skill_name: &str) {
    if env::var("CORE_MCP_TEST_REDIS").ok().as_deref() == Some("memory") {
        return;
    }
    if let Err(error) = electron_post_json(
        "/api/user-skills/mark-dirty",
        &json!({ "skill_name": skill_name }),
        10.0,
    )
    .await
    {
        warn!("could not mark skill '{skill_name}' dirty after a bundle-content change: {error:#}");
    }
}

fn read_only_skill_mutation_failure(skill_name: &str) -> Result<Option<Value>> {
    let Some(skill) = find_skill(skill_name)? else {
        return Ok(None);
    };
    if skill.source == "marketplace" {
        return Ok(Some(json!({
            "success": false,
            "code": "installed_copy_read_only",
            "error": format!("Skill '{}' is an installed read-only Marketplace copy", skill_name),
            "remediation": "If the current viewer authored this skill's Marketplace listing, convert it in place with reclaim_skill; otherwise create an editable user copy with copy_skill, then modify that copy.",
        })));
    }
    if skill.source == "system" {
        return Ok(Some(json!({
            "success": false,
            "code": "system_skill_read_only",
            "error": format!("Skill '{}' is a read-only system skill", skill_name),
            "remediation": "Create an editable user copy, then modify that copy.",
        })));
    }
    Ok(None)
}

async fn skill_provenance_snapshot() -> Option<Value> {
    if env::var("CORE_MCP_TEST_REDIS").ok().as_deref() == Some("memory") {
        return None;
    }
    let response = electron_post_json("/api/ai-marketplace/skill-provenance", &json!({}), 10.0)
        .await
        .ok()?;
    if response.get("success").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    response.get("data").cloned()
}

fn enrich_skill_provenance(
    skill: &core_mcp_shared::SkillMetadata,
    mut metadata: Value,
    snapshot: Option<&Value>,
) -> Value {
    let mut relationship = Value::Null;
    let mut solution_id = Value::Null;
    let mut has_unpublished_changes = Value::Null;
    let mut has_update = Value::Null;
    let mut installed_version = Value::Null;
    let is_read_only = skill.source != "user";

    if skill.source == "user" {
        if let Some(link) = snapshot
            .and_then(|value| value.get("skill_links"))
            .and_then(|value| value.get(&skill.name))
        {
            if let Some(id) = link.get("solutionId").and_then(Value::as_str) {
                relationship = json!("published");
                solution_id = json!(id);
                // Event-driven "unpublished changes" marker from the skill-link
                // sidecar: set when the local copy is edited after publish,
                // cleared on (re)publish.
                has_unpublished_changes =
                    json!(link.get("hasLocalChanges").and_then(Value::as_bool) == Some(true));
            }
        }
    } else if skill.source == "marketplace" {
        relationship = json!("unknown");
        let relative_path = app_root()
            .ok()
            .and_then(|root| {
                Path::new(&skill.path)
                    .strip_prefix(root)
                    .ok()
                    .map(Path::to_path_buf)
            })
            .map(|path| path.to_string_lossy().replace('\\', "/"));
        let installed = snapshot
            .and_then(|value| value.get("installed_skills"))
            .and_then(Value::as_array)
            .and_then(|entries| {
                entries.iter().find(|entry| {
                    let local_path = entry
                        .get("local_path")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    relative_path.as_deref() == Some(local_path)
                })
            });
        if let Some(installed) = installed {
            relationship = json!("installed");
            solution_id = installed
                .get("marketplace_solution_id")
                .cloned()
                .unwrap_or(Value::Null);
            // Freshness as of the last sweep/sync (persisted flag, no probe).
            has_update =
                json!(installed.get("has_update").and_then(Value::as_bool) == Some(true));
            if let Some(version) = installed.get("installed_version").and_then(Value::as_str) {
                installed_version = json!(version);
            }
        }
    }

    if let Some(object) = metadata.as_object_mut() {
        object.insert("source".to_string(), json!(skill.source));
        object.insert(
            "created_by_email".to_string(),
            skill
                .created_by_email
                .clone()
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
        object.insert("marketplace_relationship".to_string(), relationship);
        object.insert("marketplace_solution_id".to_string(), solution_id);
        object.insert("is_read_only".to_string(), json!(is_read_only));
        if !has_unpublished_changes.is_null() {
            object.insert(
                "has_unpublished_changes".to_string(),
                has_unpublished_changes,
            );
        }
        if !has_update.is_null() {
            object.insert("has_update".to_string(), has_update);
        }
        if !installed_version.is_null() {
            object.insert("installed_version".to_string(), installed_version);
        }
    }
    metadata
}

pub(super) fn clamped_wait_seconds(arguments: &Map<String, Value>) -> u64 {
    arguments
        .get("seconds")
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .clamp(1, 300)
}

pub(super) async fn handle_wait(arguments: &Map<String, Value>) -> Result<Value> {
    let seconds = clamped_wait_seconds(arguments);
    tokio::time::sleep(std::time::Duration::from_secs(seconds)).await;
    success_text(json!({ "waited_seconds": seconds }))
}

pub(super) async fn handle_list_skills(arguments: &Map<String, Value>) -> Result<Value> {
    let include_content = arguments
        .get("include_content")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let filter_source = arguments
        .get("filter_source")
        .and_then(Value::as_str)
        .unwrap_or("all");

    let mut skills = discover_skills()?;
    if filter_source != "all" {
        skills.retain(|skill| skill.source == filter_source);
    }

    let provenance = skill_provenance_snapshot().await;
    let skills_json = skills
        .iter()
        .map(|skill| {
            enrich_skill_provenance(skill, skill.to_json(include_content), provenance.as_ref())
        })
        .collect::<Vec<_>>();

    success_text(json!({
        "success": true,
        "skills": skills_json,
        "total": skills.len(),
        "filter": filter_source,
    }))
}

pub(super) async fn handle_create_skill(arguments: &Map<String, Value>) -> Result<Value> {
    let skill_name = string_arg(arguments, "skill_name")?;
    let skill_content = string_arg(arguments, "skill_content")?;
    let skill_path = validate_skill_path(&skill_name, None)?;
    if skill_path.exists() {
        return success_text(json!({
            "success": false,
            "code": "skill_already_exists",
            "error": format!("Skill '{}' already exists", skill_name),
            "remediation": "Choose a unique skill name.",
        }));
    }
    if let Some(existing) = find_skill(&skill_name)? {
        return success_text(json!({
            "success": false,
            "code": "skill_already_exists",
            "error": format!("Cannot create user skill '{}' because a {} skill with that name already exists", skill_name, existing.source),
            "remediation": "Choose a unique skill name.",
        }));
    }
    // Deliberately ignore any legacy `author` argument. Electron resolves the
    // authenticated creator and owns canonical filesystem mutation.
    proxy_user_skill_mutation(
        "/api/user-skills/create",
        json!({
            "skill_name": skill_name,
            "skill_content": skill_content,
        }),
    )
    .await
}

pub(super) async fn handle_copy_skill(arguments: &Map<String, Value>) -> Result<Value> {
    let source_skill_id = string_arg(arguments, "source_skill_id")?;
    let new_skill_name = string_arg(arguments, "new_skill_name")?;
    if find_skill(&source_skill_id)?.is_none() {
        return success_text(json!({
            "success": false,
            "code": "skill_not_found",
            "error": format!("Skill '{}' was not found locally", source_skill_id),
            "remediation": "Use list_skills and choose an existing local skill id.",
        }));
    }
    if let Some(existing) = find_skill(&new_skill_name)? {
        return success_text(json!({
            "success": false,
            "code": "skill_already_exists",
            "error": format!("Cannot create user skill '{}' because a {} skill with that name already exists", new_skill_name, existing.source),
            "remediation": "Choose a unique skill name.",
        }));
    }
    proxy_user_skill_mutation(
        "/api/user-skills/copy",
        json!({
            "source_skill_id": source_skill_id,
            "new_skill_name": new_skill_name,
        }),
    )
    .await
}

pub(super) async fn handle_rename_skill(arguments: &Map<String, Value>) -> Result<Value> {
    let skill_name = string_arg(arguments, "skill_name")?;
    let new_skill_name = string_arg(arguments, "new_skill_name")?;
    // Same read-only gates as every other user-skill mutation: system skills
    // and installed marketplace copies keep their names (the install record
    // and catalog identity are keyed by them).
    if let Some(failure) = read_only_skill_mutation_failure(&skill_name)? {
        return success_text(failure);
    }
    if find_skill(&skill_name)?.is_none() {
        return success_text(json!({
            "success": false,
            "code": "skill_not_found",
            "error": format!("Skill '{}' was not found locally", skill_name),
            "remediation": "Use list_skills and choose an existing editable user skill id.",
        }));
    }
    if let Some(existing) = find_skill(&new_skill_name)? {
        return success_text(json!({
            "success": false,
            "code": "skill_already_exists",
            "error": format!("Cannot rename to '{}' because a {} skill with that name already exists", new_skill_name, existing.source),
            "remediation": "Choose a unique skill name.",
        }));
    }
    // Electron owns canonical filesystem mutation (directory move, frontmatter
    // rewrite, published-link follow, agent-usage guard).
    proxy_user_skill_mutation(
        "/api/user-skills/rename",
        json!({
            "skill_name": skill_name,
            "new_skill_name": new_skill_name,
        }),
    )
    .await
}

pub(super) async fn handle_read_skill(arguments: &Map<String, Value>) -> Result<Value> {
    let skill_name = string_arg(arguments, "skill_name")?;
    let Some(skill) = find_skill(&skill_name)? else {
        return success_text(
            json!({ "success": false, "error": format!("Skill '{}' not found", skill_name) }),
        );
    };
    let provenance = skill_provenance_snapshot().await;
    let metadata = enrich_skill_provenance(&skill, skill.to_json(false), provenance.as_ref());
    success_text(json!({
        "success": true,
        "skill_name": skill_name,
        "display_name": skill.effective_display_name(),
        "source": metadata.get("source").cloned().unwrap_or(Value::Null),
        "created_by_email": metadata.get("created_by_email").cloned().unwrap_or(Value::Null),
        "marketplace_relationship": metadata.get("marketplace_relationship").cloned().unwrap_or(Value::Null),
        "marketplace_solution_id": metadata.get("marketplace_solution_id").cloned().unwrap_or(Value::Null),
        "is_read_only": metadata.get("is_read_only").cloned().unwrap_or(json!(true)),
        "metadata": metadata,
        "content": read_skill_markdown(&skill)?,
    }))
}

fn skill_bundle_file_entry(skill_dir: &Path, file_path: &Path) -> Result<(String, Value)> {
    let relative_path = path_to_unix_string(skill_dir, file_path)
        .with_context(|| format!("failed to derive bundle path for {}", file_path.display()))?;
    let bytes =
        fs::read(file_path).with_context(|| format!("failed to read {}", file_path.display()))?;
    let entry = match String::from_utf8(bytes.clone()) {
        Ok(text) => json!({
            "path": relative_path,
            "encoding": "utf8",
            "content": text,
        }),
        Err(_) => json!({
            "path": relative_path,
            "encoding": "base64",
            "content": BASE64_STANDARD.encode(bytes),
        }),
    };
    Ok((relative_path, entry))
}

pub(super) async fn handle_export_skill_bundle(arguments: &Map<String, Value>) -> Result<Value> {
    let skill_name = string_arg(arguments, "skill_name")?;
    let Some(skill) = find_skill(&skill_name)? else {
        return success_text(
            json!({ "success": false, "error": format!("Skill '{}' not found", skill_name) }),
        );
    };

    let skill_dir = PathBuf::from(&skill.path);
    let mut bundle_files = WalkDir::new(&skill_dir)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.path().to_path_buf())
        .collect::<Vec<_>>();
    bundle_files.sort();

    let mut file_entries = Vec::new();
    let mut files_by_path = BTreeMap::new();
    for file_path in bundle_files {
        let (relative_path, entry) = skill_bundle_file_entry(&skill_dir, &file_path)?;
        files_by_path.insert(relative_path.clone(), entry.clone());
        file_entries.push(entry);
    }

    let references = skill
        .references
        .iter()
        .filter_map(|relative_path| files_by_path.get(relative_path).cloned())
        .collect::<Vec<_>>();
    let scripts = skill
        .scripts
        .iter()
        .filter_map(|relative_path| files_by_path.get(relative_path).cloned())
        .collect::<Vec<_>>();
    let source = skill.source.clone();
    let skill_path = skill.path.clone();
    let provenance = skill_provenance_snapshot().await;
    let metadata = enrich_skill_provenance(&skill, skill.to_json(false), provenance.as_ref());

    success_text(json!({
        "success": true,
        "skill_name": skill_name,
        "display_name": skill.effective_display_name(),
        "source": metadata.get("source").cloned().unwrap_or(json!(source)),
        "created_by_email": metadata.get("created_by_email").cloned().unwrap_or(Value::Null),
        "marketplace_relationship": metadata.get("marketplace_relationship").cloned().unwrap_or(Value::Null),
        "marketplace_solution_id": metadata.get("marketplace_solution_id").cloned().unwrap_or(Value::Null),
        "is_read_only": metadata.get("is_read_only").cloned().unwrap_or(json!(true)),
        "skill_path": skill_path,
        "metadata": metadata,
        "files": file_entries,
        "references": references,
        "scripts": scripts,
    }))
}

pub(super) async fn handle_update_skill(arguments: &Map<String, Value>) -> Result<Value> {
    let skill_name = string_arg(arguments, "skill_name")?;
    let skill_content = string_arg(arguments, "skill_content")?;
    if let Some(failure) = read_only_skill_mutation_failure(&skill_name)? {
        return success_text(failure);
    }
    if !validate_skill_path(&skill_name, Some("SKILL.md"))?.exists() {
        return success_text(
            json!({ "success": false, "error": format!("Skill '{}' not found in skills-user", skill_name) }),
        );
    }
    proxy_user_skill_mutation(
        "/api/user-skills/update",
        json!({
            "skill_name": skill_name,
            "skill_content": skill_content,
        }),
    )
    .await
}

pub(super) async fn handle_delete_skill(arguments: &Map<String, Value>) -> Result<Value> {
    let skill_name = string_arg(arguments, "skill_name")?;
    if !bool_arg(arguments, "confirm", false) {
        return success_text(
            json!({ "success": false, "error": "Set confirm=true to delete the skill" }),
        );
    }
    let Some(skill) = find_skill(&skill_name)? else {
        return success_text(json!({
            "success": false,
            "code": "skill_not_found",
            "error": format!("Skill '{}' was not found locally", skill_name),
            "remediation": "List skills and choose an existing local skill id.",
        }));
    };
    if skill.source == "system" {
        return success_text(json!({
            "success": false,
            "code": "system_skill_read_only",
            "error": format!("System skill '{}' cannot be deleted", skill_name),
            "remediation": "System skills are managed by the application.",
        }));
    }
    if env::var("CORE_MCP_TEST_REDIS").ok().as_deref() == Some("memory") && skill.source == "user" {
        fs::remove_dir_all(&skill.path)?;
        return success_text(json!({
            "success": true,
            "skill_name": skill_name,
            "display_name": skill.effective_display_name(),
            "source": "user",
            "local_deleted": true,
            "remote_solution_deleted": false,
            "message": format!("Skill '{}' deleted locally", skill_name),
        }));
    }
    let response = electron_post_json(
        "/api/ai-marketplace/delete-local-skill",
        &json!({ "skill_id": skill_name }),
        30.0,
    )
    .await?;
    if response.get("success").and_then(Value::as_bool) == Some(false) {
        return success_text(response);
    }
    let mut data = response.get("data").cloned().unwrap_or(response);
    if let Some(object) = data.as_object_mut() {
        // Electron's envelope wins; the or_insert covers version skew where
        // the app predates display_name-bearing envelopes.
        object
            .entry("display_name")
            .or_insert_with(|| json!(skill.effective_display_name()));
        object.insert("local_deleted".to_string(), json!(true));
        object.insert("remote_solution_deleted".to_string(), json!(false));
    }
    success_text(data)
}

pub(super) async fn handle_create_skill_reference(arguments: &Map<String, Value>) -> Result<Value> {
    let skill_name = string_arg(arguments, "skill_name")?;
    if let Some(failure) = read_only_skill_mutation_failure(&skill_name)? {
        return success_text(failure);
    }
    let reference_path = string_arg(arguments, "reference_path")?;
    let content = string_arg(arguments, "content")?;
    let reference_path = if reference_path.starts_with("references/") {
        reference_path
    } else {
        format!("references/{reference_path}")
    };
    if !user_skill_exists(&skill_name)? {
        return success_text(
            json!({ "success": false, "error": format!("Skill '{}' not found in skills-user", skill_name) }),
        );
    }
    let full_path = validate_skill_path(&skill_name, Some(&reference_path))?;
    fs::create_dir_all(full_path.parent().context("reference missing parent")?)?;
    write_text_atomic(&full_path, &content)?;
    mark_user_skill_dirty(&skill_name).await;
    success_text(json!({
        "success": true,
        "skill_name": skill_name,
        "display_name": skill_display_name(&skill_name),
        "reference_path": reference_path,
        "message": format!("Reference '{}' created successfully", reference_path),
    }))
}

pub(super) async fn handle_update_skill_reference(arguments: &Map<String, Value>) -> Result<Value> {
    let skill_name = string_arg(arguments, "skill_name")?;
    if let Some(failure) = read_only_skill_mutation_failure(&skill_name)? {
        return success_text(failure);
    }
    let reference_path = string_arg(arguments, "reference_path")?;
    let content = string_arg(arguments, "content")?;
    let reference_path = if reference_path.starts_with("references/") {
        reference_path
    } else {
        format!("references/{reference_path}")
    };
    let full_path = validate_skill_path(&skill_name, Some(&reference_path))?;
    if !full_path.exists() {
        return success_text(
            json!({ "success": false, "error": format!("Reference '{}' not found", reference_path) }),
        );
    }
    write_text_atomic(&full_path, &content)?;
    mark_user_skill_dirty(&skill_name).await;
    success_text(json!({
        "success": true,
        "skill_name": skill_name,
        "display_name": skill_display_name(&skill_name),
        "reference_path": reference_path,
        "message": format!("Reference '{}' updated successfully", reference_path),
    }))
}

pub(super) async fn handle_delete_skill_reference(arguments: &Map<String, Value>) -> Result<Value> {
    let skill_name = string_arg(arguments, "skill_name")?;
    if let Some(failure) = read_only_skill_mutation_failure(&skill_name)? {
        return success_text(failure);
    }
    let reference_path = string_arg(arguments, "reference_path")?;
    let reference_path = if reference_path.starts_with("references/") {
        reference_path
    } else {
        format!("references/{reference_path}")
    };
    let full_path = validate_skill_path(&skill_name, Some(&reference_path))?;
    if !full_path.exists() {
        return success_text(
            json!({ "success": false, "error": format!("Reference '{}' not found", reference_path) }),
        );
    }
    fs::remove_file(&full_path)?;
    mark_user_skill_dirty(&skill_name).await;
    success_text(json!({
        "success": true,
        "skill_name": skill_name,
        "display_name": skill_display_name(&skill_name),
        "reference_path": reference_path,
        "message": format!("Reference '{}' deleted successfully", reference_path),
    }))
}

pub(super) async fn handle_create_skill_script(arguments: &Map<String, Value>) -> Result<Value> {
    let skill_name = string_arg(arguments, "skill_name")?;
    if let Some(failure) = read_only_skill_mutation_failure(&skill_name)? {
        return success_text(failure);
    }
    let script_path = string_arg(arguments, "script_path")?;
    let content = string_arg(arguments, "content")?;
    let script_path = if script_path.starts_with("scripts/") {
        script_path
    } else {
        format!("scripts/{script_path}")
    };
    if !script_path.ends_with(".py") {
        return success_text(json!({ "success": false, "error": "Script must be a .py file" }));
    }
    if !user_skill_exists(&skill_name)? {
        return success_text(
            json!({ "success": false, "error": format!("Skill '{}' not found in skills-user", skill_name) }),
        );
    }
    let full_path = validate_skill_path(&skill_name, Some(&script_path))?;
    fs::create_dir_all(full_path.parent().context("script missing parent")?)?;
    write_text_atomic(&full_path, &content)?;
    mark_user_skill_dirty(&skill_name).await;
    success_text(json!({
        "success": true,
        "skill_name": skill_name,
        "display_name": skill_display_name(&skill_name),
        "script_path": script_path,
        "message": format!("Script '{}' created successfully", script_path),
    }))
}

pub(super) async fn handle_update_skill_script(arguments: &Map<String, Value>) -> Result<Value> {
    let skill_name = string_arg(arguments, "skill_name")?;
    if let Some(failure) = read_only_skill_mutation_failure(&skill_name)? {
        return success_text(failure);
    }
    let script_path = string_arg(arguments, "script_path")?;
    let content = string_arg(arguments, "content")?;
    let script_path = if script_path.starts_with("scripts/") {
        script_path
    } else {
        format!("scripts/{script_path}")
    };
    let full_path = validate_skill_path(&skill_name, Some(&script_path))?;
    if !full_path.exists() {
        return success_text(
            json!({ "success": false, "error": format!("Script '{}' not found", script_path) }),
        );
    }
    write_text_atomic(&full_path, &content)?;
    mark_user_skill_dirty(&skill_name).await;
    success_text(json!({
        "success": true,
        "skill_name": skill_name,
        "display_name": skill_display_name(&skill_name),
        "script_path": script_path,
        "message": format!("Script '{}' updated successfully", script_path),
    }))
}

pub(super) async fn handle_delete_skill_script(arguments: &Map<String, Value>) -> Result<Value> {
    let skill_name = string_arg(arguments, "skill_name")?;
    if let Some(failure) = read_only_skill_mutation_failure(&skill_name)? {
        return success_text(failure);
    }
    let script_path = string_arg(arguments, "script_path")?;
    let script_path = if script_path.starts_with("scripts/") {
        script_path
    } else {
        format!("scripts/{script_path}")
    };
    let full_path = validate_skill_path(&skill_name, Some(&script_path))?;
    if !full_path.exists() {
        return success_text(
            json!({ "success": false, "error": format!("Script '{}' not found", script_path) }),
        );
    }
    fs::remove_file(&full_path)?;
    mark_user_skill_dirty(&skill_name).await;
    success_text(json!({
        "success": true,
        "skill_name": skill_name,
        "display_name": skill_display_name(&skill_name),
        "script_path": script_path,
        "message": format!("Script '{}' deleted successfully", script_path),
    }))
}

fn get_skill_required_servers(skill_name: &str) -> Result<Vec<String>> {
    Ok(find_skill(skill_name)?
        .map(|skill| skill.required_mcp_servers)
        .unwrap_or_default())
}

fn user_skill_exists(skill_name: &str) -> Result<bool> {
    Ok(validate_skill_path(skill_name, None)?.exists())
}

fn activation_failure_message(blocked_integrations: &[Value]) -> String {
    if blocked_integrations.iter().any(|item| {
        item.get("recovery_hint").and_then(Value::as_str) == Some("integration_missing")
    }) {
        return "One or more MCP servers required by this skill are not installed in this app."
            .to_string();
    }

    if blocked_integrations
        .iter()
        .any(|item| item.get("restart_recommended").and_then(Value::as_bool) == Some(true))
    {
        return "One or more MCP servers required by this skill are not ready yet. At least one blocked dependency is not actively starting, so waiting longer will not fix it by itself.".to_string();
    }

    if blocked_integrations
        .iter()
        .any(|item| item.get("recovery_hint").and_then(Value::as_str) == Some("oauth_required"))
    {
        return "One or more MCP servers required by this skill are not ready yet because OAuth authorization is still required.".to_string();
    }

    if blocked_integrations.iter().any(|item| {
        item.get("recovery_hint").and_then(Value::as_str) == Some("integration_hard_disabled")
    }) {
        return "One or more MCP servers required by this skill were hard-disabled by the user and are unavailable. Do not attempt to enable them; only the user can re-enable them from the Control Plane.".to_string();
    }

    if blocked_integrations.iter().any(|item| {
        item.get("recovery_hint").and_then(Value::as_str) == Some("integration_disabled")
    }) {
        return "One or more MCP servers required by this skill are not ready yet because the dependency is disabled.".to_string();
    }

    format!(
        "One or more MCP servers required by this skill are not ready yet. skills_activate_skill already waited up to {:.0} seconds for visible servers in transitional readiness phases, but at least one dependency is still not tool_ready.",
        ACTIVATION_WAIT_SECONDS
    )
}

fn track_chat_skill_reference(chat_id: &str, cache_key: &str, content: &str) -> Result<()> {
    redis_setex_string(cache_key, content, SKILL_TTL_SECONDS)?;
    let refs_key = format!("chat_skill_refs:{chat_id}");
    let mut refs = redis_get_string(&refs_key)?
        .map(|raw| serde_json::from_str::<Vec<String>>(&raw).unwrap_or_default())
        .unwrap_or_default();
    if !refs.contains(&cache_key.to_string()) {
        refs.push(cache_key.to_string());
        let encoded_refs = serde_json::to_string(&refs)?;
        redis_setex_string(&refs_key, &encoded_refs, SKILL_TTL_SECONDS)?;
    }
    Ok(())
}

pub(super) async fn handle_activate_skill(arguments: &Map<String, Value>) -> Result<Value> {
    let skill_name = string_arg(arguments, "skill_name")?;
    let chat_id = string_arg(arguments, "chat_id")?;
    let Some(skill) = find_skill(&skill_name)? else {
        return success_text(
            json!({ "success": false, "error": format!("Skill '{}' not found", skill_name) }),
        );
    };
    let mut required_mcp_servers = Vec::new();
    let mut seen_required_mcp_servers = HashSet::new();
    for server_id in &skill.required_mcp_servers {
        if seen_required_mcp_servers.insert(server_id.clone()) {
            required_mcp_servers.push(server_id.clone());
        }
    }
    let activated = redis_get_string(&format!("chat_skills:{chat_id}"))?
        .map(|raw| serde_json::from_str::<Vec<String>>(&raw).unwrap_or_default())
        .unwrap_or_default();
    let known_server_ids = configured_server_ids()?;
    let mut missing_required_servers = Vec::new();
    let mut seen_missing = HashSet::new();
    for server_id in &required_mcp_servers {
        let bare = bare_server_id(server_id).to_string();
        if known_server_ids.contains(&bare) || !seen_missing.insert(bare) {
            continue;
        }
        missing_required_servers.push(server_id.clone());
    }
    if !missing_required_servers.is_empty() {
        let blocked_integrations = missing_required_servers
            .iter()
            .map(|server_id| {
                blocked_integration(
                    server_id,
                    &json!({
                        "healthy": false,
                        "readiness_phase": READINESS_PHASE_SERVICE_NOT_FOUND,
                        "error": "service_not_found",
                    }),
                )
            })
            .collect::<Vec<_>>();
        return success_text(json!({
            "success": false,
            "skill_name": skill_name,
            "display_name": skill.effective_display_name(),
            "chat_id": chat_id,
            "activated_skills": activated,
            "blocked_integrations": blocked_integrations,
            "message": activation_failure_message(&blocked_integrations),
            "next_steps": activation_next_steps(&blocked_integrations, true),
        }));
    }
    with_chat_capabilities_lock(&chat_id, || {
        let chat_id = chat_id.clone();
        let skill_name = skill_name.clone();
        let skill = skill.clone();
        async move {
            let redis_key = format!("chat_skills:{chat_id}");
            let mut activated = redis_get_string(&redis_key)?
                .map(|raw| serde_json::from_str::<Vec<String>>(&raw).unwrap_or_default())
                .unwrap_or_default();
            let already_activated = activated.contains(&skill_name);

            let mut blocked_integrations = Vec::new();
            let mut enabled_tools = redis_get_string(&format!("chat_tools:{chat_id}"))?
                .map(|raw| serde_json::from_str::<Vec<String>>(&raw).unwrap_or_default())
                .unwrap_or_default();
            let mut newly_enabled_mcp_servers = Vec::new();
            let mut already_enabled_mcp_servers = Vec::new();
            let mut ready_to_probe = Vec::new();
            for server_id in &required_mcp_servers {
                // PORTICO-410: hard-disabled dependencies block activation even if
                // a stale toggle map claims they are enabled, and carry their
                // own error so guidance never suggests toggling them back on.
                if is_server_hard_disabled(server_id) {
                    blocked_integrations.push(blocked_integration(
                        server_id,
                        &json!({
                            "healthy": false,
                            "readiness_phase": READINESS_PHASE_DISABLED,
                            "error": "integration_hard_disabled",
                        }),
                    ));
                } else if is_server_enabled_in_toggles(server_id) {
                    ready_to_probe.push(server_id.clone());
                } else {
                    blocked_integrations.push(blocked_integration(
                        server_id,
                        &json!({
                            "healthy": false,
                            "readiness_phase": READINESS_PHASE_DISABLED,
                            "error": "integration_disabled",
                        }),
                    ));
                }
            }

            let mut readiness_tasks = Vec::new();
            for (index, server_id) in ready_to_probe.iter().cloned().enumerate() {
                readiness_tasks.push(tokio::spawn(async move {
                    (
                        index,
                        server_id.clone(),
                        wait_for_server_tool_ready(&server_id, ACTIVATION_WAIT_SECONDS).await,
                    )
                }));
            }

            let mut readiness_results = Vec::new();
            for task in readiness_tasks {
                readiness_results.push(task.await.context("server readiness task failed")?);
            }
            readiness_results.sort_by_key(|(index, _, _)| *index);

            for (_, server_id, readiness) in readiness_results {
                let blocked = blocked_integration(&server_id, &readiness);
                if blocked.get("readiness_phase").and_then(Value::as_str)
                    != Some(READINESS_PHASE_TOOL_READY)
                    || blocked.get("healthy").and_then(Value::as_bool) != Some(true)
                {
                    blocked_integrations.push(blocked);
                    continue;
                }
                if enabled_tools.contains(&server_id) {
                    already_enabled_mcp_servers.push(server_id.clone());
                } else {
                    enabled_tools.push(server_id.clone());
                    newly_enabled_mcp_servers.push(server_id.clone());
                }
            }

            if !blocked_integrations.is_empty() {
                return success_text(json!({
                    "success": false,
                    "skill_name": skill_name,
                    "display_name": skill.effective_display_name(),
                    "chat_id": chat_id,
                    "activated_skills": activated,
                    "blocked_integrations": blocked_integrations,
                    "message": activation_failure_message(&blocked_integrations),
                    "next_steps": activation_next_steps(&blocked_integrations, true),
                }));
            }

            if !already_activated {
                activated.push(skill_name.clone());
                let encoded_skills = serde_json::to_string(&activated)?;
                redis_setex_string(&redis_key, &encoded_skills, SKILL_TTL_SECONDS)?;
                maybe_store_skill_content(&skill_name, skill.content.as_deref())?;
            }
            let tools_key = format!("chat_tools:{chat_id}");
            let encoded_tools = serde_json::to_string(&enabled_tools)?;
            redis_setex_string(&tools_key, &encoded_tools, SKILL_TTL_SECONDS)?;
            if !newly_enabled_mcp_servers.is_empty() {
                notify_capabilities_changed(&chat_id, "tools", &enabled_tools).await;
            }
            if !already_activated {
                notify_capabilities_changed(&chat_id, "skills", &activated).await;
            }

            success_text(json!({
                "success": true,
                "skill_name": skill_name,
                "display_name": skill.effective_display_name(),
                "chat_id": chat_id,
                "message": if already_activated {
                    if skill.required_mcp_servers.is_empty() {
                        format!("Skill '{}' already activated", skill_name)
                    } else {
                        format!("Skill '{}' was already activated and its MCP dependencies are ready", skill_name)
                    }
                } else {
                    format!("Skill '{}' activated successfully", skill_name)
                },
                "skill_info": {
                    "display_name": skill.effective_display_name(),
                    "description": skill.description,
                    "priority": skill.priority,
                    "source": skill.source,
                    "references": skill.references,
                    "scripts": skill.scripts,
                    "required_mcp_servers": skill.required_mcp_servers,
                },
                "activated_skills": activated,
                "enabled_mcp_servers": enabled_tools,
                "newly_enabled_mcp_servers": newly_enabled_mcp_servers,
                "already_enabled_mcp_servers": already_enabled_mcp_servers,
                "total_activated": activated.len(),
            }))
        }
    })
    .await
}

fn store_skill_content(skill_name: &str, content: &str) -> Result<()> {
    let content_key = format!("skill_content:{skill_name}");
    redis_setex_string(&content_key, content, SKILL_TTL_SECONDS)
}

#[rustfmt::skip]
fn maybe_store_skill_content(skill_name: &str, content: Option<&str>) -> Result<()> { if let Some(content) = content { store_skill_content(skill_name, content)?; } Ok(()) }

pub(super) async fn handle_deactivate_skill(arguments: &Map<String, Value>) -> Result<Value> {
    let skill_name = string_arg(arguments, "skill_name")?;
    let chat_id = string_arg(arguments, "chat_id")?;
    with_chat_capabilities_lock(&chat_id, || {
        let chat_id = chat_id.clone();
        let skill_name = skill_name.clone();
        async move {
            let redis_key = format!("chat_skills:{chat_id}");
            let mut activated = redis_get_string(&redis_key)?
                .map(|raw| serde_json::from_str::<Vec<String>>(&raw).unwrap_or_default())
                .unwrap_or_default();
            if !activated.contains(&skill_name) {
                return success_text(json!({
                    "success": false,
                    "skill_name": skill_name,
                    "display_name": skill_display_name(&skill_name),
                    "error": format!("Skill '{}' is not activated", skill_name),
                    "activated_skills": activated,
                }));
            }
            activated.retain(|item| item != &skill_name);
            if activated.is_empty() {
                redis_delete(&redis_key)?;
            } else {
                let encoded_skills = serde_json::to_string(&activated)?;
                redis_setex_string(&redis_key, &encoded_skills, SKILL_TTL_SECONDS)?;
            }
            success_text(json!({
                "success": true,
                "skill_name": skill_name,
                "display_name": skill_display_name(&skill_name),
                "chat_id": chat_id,
                "message": format!("Skill '{}' deactivated", skill_name),
                "remaining_skills": activated,
            }))
        }
    })
    .await
}

fn resolve_skill_reference_path(
    skill: &core_mcp_shared::SkillMetadata,
    reference_path: &str,
) -> Option<PathBuf> {
    match resolve_skill_resource_path(skill, reference_path) {
        Ok(path) => Some(path),
        Err(SkillResourcePathError::Missing) if !reference_path.starts_with("references/") => {
            let fallback_path = format!("references/{reference_path}");
            resolve_skill_resource_path(skill, &fallback_path).ok()
        }
        Err(SkillResourcePathError::Missing | SkillResourcePathError::Invalid) => None,
    }
}

pub(super) async fn handle_get_skill_reference(arguments: &Map<String, Value>) -> Result<Value> {
    let skill_name = string_arg(arguments, "skill_name")?;
    let reference_path = string_arg(arguments, "reference_path")?;
    let Some(skill) = find_skill(&skill_name)? else {
        return success_text(
            json!({ "success": false, "error": format!("Skill '{}' not found", skill_name) }),
        );
    };
    let Some(content_path) = resolve_skill_reference_path(&skill, &reference_path) else {
        return success_text(
            json!({ "success": false, "error": format!("Reference not found: {}", reference_path) }),
        );
    };
    let Ok(content) = fs::read_to_string(&content_path) else {
        return success_text(
            json!({ "success": false, "error": format!("Reference not found: {}", reference_path) }),
        );
    };
    if let Some(chat_id) = arguments
        .get("chat_id")
        .and_then(Value::as_str)
        .filter(|chat_id| !chat_id.is_empty())
    {
        let cache_key = format!("skill_ref_content:{}:{}", skill_name, reference_path);
        track_chat_skill_reference(chat_id, &cache_key, &content)?;
    }
    success_text(json!({
        "success": true,
        "skill_name": skill_name,
        "display_name": skill.effective_display_name(),
        "reference_path": reference_path,
        "content": content,
    }))
}

fn is_skill_activated_for_chat(chat_id: &str, skill_name: &str) -> Result<bool> {
    Ok(redis_get_string(&format!("chat_skills:{chat_id}"))?
        .map(|raw| serde_json::from_str::<Vec<String>>(&raw).unwrap_or_default())
        .unwrap_or_default()
        .iter()
        .any(|active| active == skill_name))
}

fn normalize_asset_relative_path(asset_path: &str) -> Result<PathBuf> {
    let trimmed = asset_path.trim().trim_start_matches("assets/").trim();
    if trimmed.is_empty() {
        bail!("asset_path is required");
    }

    let requested = Path::new(trimmed);
    if requested.is_absolute() {
        bail!("asset_path must be relative to assets/");
    }

    let mut normalized = PathBuf::new();
    for component in requested.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                bail!("asset_path must stay within assets/")
            }
        }
    }

    if normalized.as_os_str().is_empty() {
        bail!("asset_path is required");
    }

    Ok(normalized)
}

fn image_mime_type_for_path(asset_path: &Path) -> Option<&'static str> {
    match asset_path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => Some("image/png"),
        Some("jpg") | Some("jpeg") => Some("image/jpeg"),
        Some("gif") => Some("image/gif"),
        Some("webp") => Some("image/webp"),
        _ => None,
    }
}

fn workspace_safe_segment(value: &str, field: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains('/')
        || trimmed.contains('\\')
    {
        bail!("{field} cannot be used as a workspace path segment");
    }
    Ok(trimmed.to_string())
}

fn encode_workspace_url_segment(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                encoded.push(*byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn workspace_download_url(chat_id: &str, file_path: &str) -> String {
    let encoded_chat_id = encode_workspace_url_segment(chat_id.trim());
    let encoded_path = file_path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(encode_workspace_url_segment)
        .collect::<Vec<_>>()
        .join("/");
    format!("http://localhost:9876/workspace/{encoded_chat_id}/{encoded_path}")
}

fn asset_paths_arg(arguments: &Map<String, Value>) -> Result<Vec<String>> {
    let Some(value) = arguments.get("asset_paths") else {
        bail!("asset_paths is required");
    };
    let paths = match value {
        Value::String(path) => vec![path.trim().to_string()],
        Value::Array(items) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map(|path| path.trim().to_string())
                    .ok_or_else(|| anyhow::anyhow!("asset_paths entries must be strings"))
            })
            .collect::<Result<Vec<_>>>()?,
        _ => bail!("asset_paths must be a string or array of strings"),
    };
    if paths.iter().any(|path| path.is_empty()) {
        bail!("asset_paths entries cannot be empty");
    }
    if paths.is_empty() {
        bail!("asset_paths must include at least one asset path");
    }
    Ok(paths)
}

struct ResolvedSkillAsset {
    relative_asset: PathBuf,
    canonical_asset_path: PathBuf,
    mime_type: &'static str,
}

fn resolve_skill_asset(skill_dir: &Path, asset_path: &str) -> Result<ResolvedSkillAsset> {
    let relative_asset = normalize_asset_relative_path(asset_path)?;
    let assets_dir = skill_dir.join("assets");
    let requested_path = assets_dir.join(&relative_asset);
    let relative_label = path_to_unix_string(&PathBuf::new(), &relative_asset)
        .unwrap_or_else(|| relative_asset.display().to_string());

    let canonical_assets_dir = match fs::canonicalize(&assets_dir) {
        Ok(path) => path,
        Err(_) => bail!("Asset not found: assets/{relative_label}"),
    };
    let canonical_asset_path = match fs::canonicalize(&requested_path) {
        Ok(path) => path,
        Err(_) => bail!("Asset not found: assets/{relative_label}"),
    };

    if !canonical_asset_path.starts_with(&canonical_assets_dir) {
        bail!("asset_path must stay within assets/");
    }

    let Some(mime_type) = image_mime_type_for_path(&canonical_asset_path) else {
        bail!("Only PNG, JPEG, GIF, and WebP skill assets can be returned inline");
    };

    Ok(ResolvedSkillAsset {
        relative_asset,
        canonical_asset_path,
        mime_type,
    })
}

pub(super) async fn handle_get_skill_assets(arguments: &Map<String, Value>) -> Result<Value> {
    let skill_name = string_arg(arguments, "skill_name")?;
    let asset_paths = match asset_paths_arg(arguments) {
        Ok(paths) => paths,
        Err(error) => {
            return success_text(json!({
                "success": false,
                "error": error.to_string(),
            }))
        }
    };
    let chat_id = string_arg(arguments, "chat_id")?;

    if !is_skill_activated_for_chat(&chat_id, &skill_name)? {
        return success_text(json!({
            "success": false,
            "error": format!("Skill '{}' is not activated for chat '{}'", skill_name, chat_id),
        }));
    }

    let Some(skill) = find_skill(&skill_name)? else {
        return success_text(
            json!({ "success": false, "error": format!("Skill '{}' not found", skill_name) }),
        );
    };

    let skill_dir = PathBuf::from(&skill.path);
    let resolved_assets = match asset_paths
        .iter()
        .map(|path| resolve_skill_asset(&skill_dir, path))
        .collect::<Result<Vec<_>>>()
    {
        Ok(assets) => assets,
        Err(error) => {
            return success_text(json!({
                "success": false,
                "error": error.to_string(),
            }))
        }
    };

    let workspace_skill_name = workspace_safe_segment(&skill_name, "skill_name")?;
    let workspace_chat_id = workspace_safe_segment(&chat_id, "chat_id")?;
    let chat_workspace = container_workspaces_dir()?.join(&workspace_chat_id);
    let mut assets = Vec::new();

    for resolved in resolved_assets {
        let relative_asset_path = path_to_unix_string(&PathBuf::new(), &resolved.relative_asset)
            .unwrap_or_else(|| resolved.relative_asset.display().to_string());
        let relative_label = format!("assets/{relative_asset_path}");
        let workspace_path = format!("skill-assets/{workspace_skill_name}/{relative_asset_path}");
        let workspace_asset_path = chat_workspace.join(&workspace_path);
        if let Some(parent) = workspace_asset_path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }
        fs::copy(&resolved.canonical_asset_path, &workspace_asset_path).with_context(|| {
            format!(
                "failed to copy {} to {}",
                resolved.canonical_asset_path.display(),
                workspace_asset_path.display()
            )
        })?;
        let size_bytes = fs::metadata(&workspace_asset_path)
            .with_context(|| format!("failed to stat {}", workspace_asset_path.display()))?
            .len();
        let download_url = workspace_download_url(&chat_id, &workspace_path);
        let file_name = resolved
            .relative_asset
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("skill-asset");

        assets.push(json!({
            "asset_path": relative_label,
            "workspace_path": workspace_path,
            "download_url": download_url,
            "markdown_image": format!("![{}]({})", file_name, download_url),
            "markdown_link": format!("[Download {}]({})", file_name, download_url),
            "mime_type": resolved.mime_type,
            "size_bytes": size_bytes,
        }));
    }

    success_text(json!({
        "success": true,
        "skill_name": skill_name,
        "display_name": skill.effective_display_name(),
        "chat_id": chat_id,
        "assets": assets,
    }))
}

pub(super) async fn handle_get_activated_skills(arguments: &Map<String, Value>) -> Result<Value> {
    let chat_id = string_arg(arguments, "chat_id")?;
    let activated = redis_get_string(&format!("chat_skills:{chat_id}"))?
        .map(|raw| serde_json::from_str::<Vec<String>>(&raw).unwrap_or_default())
        .unwrap_or_default();
    let skills_info = activated
        .iter()
        .map(|name| {
            if let Ok(Some(skill)) = find_skill(name) {
                json!({
                    "name": skill.name,
                    "display_name": skill.effective_display_name(),
                    "description": skill.description,
                    "priority": skill.priority,
                    "source": skill.source,
                    "references": skill.references,
                    "scripts": skill.scripts,
                    "required_mcp_servers": skill.required_mcp_servers,
                })
            } else {
                json!({
                    "name": name,
                    "display_name": skill_display_name(name),
                    "description": "Metadata unavailable",
                })
            }
        })
        .collect::<Vec<_>>();
    success_text(json!({
        "success": true,
        "chat_id": chat_id,
        "activated_skills": skills_info,
        "total": activated.len(),
    }))
}

#[cfg(test)]
#[path = "skills_tests.rs"]
mod tests;
