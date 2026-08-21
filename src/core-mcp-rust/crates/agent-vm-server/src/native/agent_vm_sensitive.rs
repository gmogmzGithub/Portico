use super::*;
use bollard::query_parameters::UploadToContainerOptionsBuilder;
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use tokio::time::{sleep, Duration};
use uuid::Uuid;

const SENSITIVE_INFO_TRIGGER_TIMEOUT_SECONDS: f64 = 10.0;
const SENSITIVE_INFO_STATUS_TIMEOUT_SECONDS: f64 = 5.0;
const SENSITIVE_INFO_POLL_INTERVAL_MILLIS: u64 = 500;
const SENSITIVE_INFO_DEFAULT_TIMEOUT_SECONDS: u64 = 60 * 60;
const SENSITIVE_INFO_MIN_TIMEOUT_SECONDS: u64 = 30;
const SENSITIVE_INFO_MAX_TIMEOUT_SECONDS: u64 = 60 * 60;
const SENSITIVE_INFO_TTL_SECONDS: u64 = 15 * 60;
const SENSITIVE_INFO_DIR: &str = ".sensitive";
const SENSITIVE_INFO_METADATA_DIR: &str = "agent-vm-sensitive-info";
const SENSITIVE_INFO_REDACTION: &str = "[REDACTED SENSITIVE INFORMATION]";

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

fn validate_sensitive_timeout_seconds(arguments: &Map<String, Value>) -> Result<u64> {
    let Some(value) = arguments.get("timeout_seconds") else {
        return Ok(SENSITIVE_INFO_DEFAULT_TIMEOUT_SECONDS);
    };
    let timeout_seconds = value
        .as_u64()
        .context("timeout_seconds must be a positive integer")?;
    if !(SENSITIVE_INFO_MIN_TIMEOUT_SECONDS..=SENSITIVE_INFO_MAX_TIMEOUT_SECONDS)
        .contains(&timeout_seconds)
    {
        bail!(
            "timeout_seconds must be between {SENSITIVE_INFO_MIN_TIMEOUT_SECONDS} and {SENSITIVE_INFO_MAX_TIMEOUT_SECONDS}"
        );
    }
    Ok(timeout_seconds)
}

const SENSITIVE_INFO_MAX_VISUAL_AIDS: usize = 8;
const SENSITIVE_INFO_MAX_VISUAL_AID_STEP: u64 = 20;
const SENSITIVE_INFO_MAX_VISUAL_AID_URL_LENGTH: usize = 500;
// Visual-aid images may only come from the chat workspace served by the
// Electron API (skills_get_skill_assets download URLs) — never remote hosts.
const SENSITIVE_INFO_VISUAL_AID_URL_PREFIXES: &[&str] = &[
    "http://localhost:9876/workspace/",
    "http://127.0.0.1:9876/workspace/",
];

fn validate_visual_aids(arguments: &Map<String, Value>) -> Result<Value> {
    let Some(value) = arguments.get("visual_aids") else {
        return Ok(Value::Null);
    };
    if value.is_null() {
        return Ok(Value::Null);
    }
    let items = value
        .as_array()
        .context("visual_aids must be an array of {step, image_url, alt?} objects")?;
    if items.is_empty() {
        return Ok(Value::Null);
    }
    if items.len() > SENSITIVE_INFO_MAX_VISUAL_AIDS {
        bail!("visual_aids must include {SENSITIVE_INFO_MAX_VISUAL_AIDS} entries or fewer");
    }

    let mut validated = Vec::with_capacity(items.len());
    for item in items {
        let entry = item
            .as_object()
            .context("visual_aids entries must be objects")?;
        let step = entry
            .get("step")
            .and_then(Value::as_u64)
            .context("visual_aids entries require an integer step")?;
        if !(1..=SENSITIVE_INFO_MAX_VISUAL_AID_STEP).contains(&step) {
            bail!(
                "visual_aids step must be between 1 and {SENSITIVE_INFO_MAX_VISUAL_AID_STEP}"
            );
        }
        let image_url = required_limited_string(
            entry
                .get("image_url")
                .context("visual_aids entries require image_url")?,
            "visual_aids image_url",
            SENSITIVE_INFO_MAX_VISUAL_AID_URL_LENGTH,
        )?;
        if !SENSITIVE_INFO_VISUAL_AID_URL_PREFIXES
            .iter()
            .any(|prefix| image_url.starts_with(prefix))
        {
            bail!(
                "visual_aids image_url must be a chat-workspace download URL from skills_get_skill_assets"
            );
        }
        let alt = optional_limited_string(entry.get("alt"), "visual_aids alt", 200)?;
        validated.push(json!({
            "step": step,
            "image_url": image_url,
            "alt": alt,
        }));
    }
    Ok(Value::Array(validated))
}

fn slugify_sensitive_label(label: Option<&str>) -> String {
    let source = label.unwrap_or("secret");
    let mut slug = String::new();
    let mut previous_separator = false;
    for ch in source.chars().flat_map(char::to_lowercase) {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            previous_separator = false;
        } else if matches!(ch, '-' | '_' | ' ' | '\t') && !previous_separator && !slug.is_empty() {
            slug.push('-');
            previous_separator = true;
        }
        if slug.len() >= 40 {
            break;
        }
    }
    let trimmed = slug.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "secret".to_string()
    } else {
        trimmed
    }
}

pub(crate) fn is_sensitive_workspace_relative_path(path: &str) -> bool {
    let cleaned = path.trim().trim_start_matches('/').replace('\\', "/");
    cleaned == SENSITIVE_INFO_DIR || cleaned.starts_with(&format!("{SENSITIVE_INFO_DIR}/"))
}

pub(crate) fn is_sensitive_vm_path(path: &str) -> bool {
    let normalized = normalize_vm_path(path);
    normalized == format!("/work/{SENSITIVE_INFO_DIR}")
        || normalized.starts_with(&format!("/work/{SENSITIVE_INFO_DIR}/"))
}

fn sensitive_metadata_dir() -> Result<PathBuf> {
    Ok(core_mcp_shared::app_support_dir()?.join(SENSITIVE_INFO_METADATA_DIR))
}

fn sensitive_metadata_path(request_id: &str) -> Result<PathBuf> {
    Ok(sensitive_metadata_dir()?.join(format!("{request_id}.json")))
}

fn write_file_private(path: &Path, bytes: &[u8]) -> Result<()> {
    fs::create_dir_all(path.parent().context("sensitive file missing parent")?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        use std::os::unix::fs::PermissionsExt;
        if let Some(parent) = path.parent() {
            let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
        }
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        options.mode(0o600);
        let mut file = options
            .open(path)
            .with_context(|| format!("failed to create sensitive file {}", path.display()))?;
        file.write_all(bytes)
            .with_context(|| format!("failed to write sensitive file {}", path.display()))?;
    }
    #[cfg(not(unix))]
    {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .with_context(|| format!("failed to create sensitive file {}", path.display()))?;
        file.write_all(bytes)
            .with_context(|| format!("failed to write sensitive file {}", path.display()))?;
    }
    Ok(())
}

fn vm_sensitive_host_path_for_fake(vm: &VmInfo, vm_path: &str) -> Result<PathBuf> {
    let normalized = normalize_vm_path(vm_path);
    if !(normalized == "/work" || normalized.starts_with("/work/")) {
        bail!("sensitive file path must be within /work");
    }
    let root = resolve_work_bind_source(vm)?;
    let relative = normalized
        .trim_start_matches("/work")
        .trim_start_matches('/');
    let path = root.join(relative);
    ensure_within(&root, &path)?;
    Ok(path)
}

async fn write_sensitive_file_in_vm(vm: &VmInfo, vm_path: &str, bytes: &[u8]) -> Result<()> {
    if fake_docker_enabled() {
        let host_path = vm_sensitive_host_path_for_fake(vm, vm_path)?;
        write_file_private(&host_path, bytes)?;
        return Ok(());
    }

    let normalized = normalize_vm_path(vm_path);
    if !normalized.starts_with(&format!("/work/{SENSITIVE_INFO_DIR}/")) {
        bail!("sensitive file path must be within /work/{SENSITIVE_INFO_DIR}");
    }
    let relative_path = normalized
        .trim_start_matches("/work")
        .trim_start_matches('/');

    let mut archive = Vec::new();
    {
        let mut builder = tar::Builder::new(&mut archive);

        let mut dir_header = tar::Header::new_gnu();
        dir_header.set_entry_type(tar::EntryType::Directory);
        dir_header.set_size(0);
        dir_header.set_mode(0o700);
        dir_header.set_cksum();
        builder.append_data(&mut dir_header, SENSITIVE_INFO_DIR, Cursor::new(Vec::new()))?;

        let mut file_header = tar::Header::new_gnu();
        file_header.set_size(bytes.len() as u64);
        file_header.set_mode(0o600);
        file_header.set_cksum();
        builder.append_data(&mut file_header, relative_path, Cursor::new(bytes))?;
        builder.finish()?;
    }

    let docker = docker_client()?;
    let options = UploadToContainerOptionsBuilder::default()
        .path("/work")
        .build();
    docker
        .upload_to_container(
            &vm.container_id,
            Some(options),
            bollard::body_full(archive.into()),
        )
        .await
        .context("failed to store sensitive file in Agent VM")?;
    Ok(())
}

fn write_sensitive_metadata(metadata: &Value) -> Result<()> {
    let request_id = metadata
        .get("request_id")
        .and_then(Value::as_str)
        .context("sensitive metadata missing request_id")?;
    let path = sensitive_metadata_path(request_id)?;
    fs::create_dir_all(path.parent().context("metadata path missing parent")?)?;
    fs::write(
        &path,
        format!("{}\n", serde_json::to_string_pretty(metadata)?),
    )
    .with_context(|| format!("failed to write sensitive metadata {}", path.display()))
}

fn sensitive_metadata_entries() -> Result<Vec<(PathBuf, Value)>> {
    let dir = sensitive_metadata_dir()?;
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };
    let mut records = Vec::new();
    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        match fs::read_to_string(entry.path())
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        {
            Some(value) => records.push((entry.path(), value)),
            None => {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    Ok(records)
}

enum SensitiveFileReference {
    Vm { vm: VmInfo, vm_path: String },
    Local { path: PathBuf },
}

enum SensitiveWorkspaceTarget {
    Vm(VmInfo),
    Local { root: PathBuf, path: PathBuf },
}

fn sensitive_file_reference_from_metadata(metadata: &Value) -> Result<SensitiveFileReference> {
    let chat_id = metadata
        .get("chat_id")
        .and_then(Value::as_str)
        .context("sensitive metadata missing chat_id")?;
    let relative_path = metadata
        .get("relative_path")
        .and_then(Value::as_str)
        .context("sensitive metadata missing relative_path")?;
    let vm_path = metadata
        .get("vm_path")
        .and_then(Value::as_str)
        .unwrap_or("/work/.sensitive/secret.txt");
    if let Some(vm_id) = metadata.get("vm_id").and_then(Value::as_str) {
        if let Some(vm) = load_vm_info(vm_id)? {
            return Ok(SensitiveFileReference::Vm {
                vm,
                vm_path: vm_path.to_string(),
            });
        }
    }
    let root = local_chat_workspace_root(chat_id)?;
    let path = root.join(relative_path);
    ensure_within(&root, &path)?;
    Ok(SensitiveFileReference::Local { path })
}

async fn read_sensitive_value_from_reference(reference: SensitiveFileReference) -> Result<String> {
    match reference {
        SensitiveFileReference::Vm { vm, vm_path } => {
            let bytes = if fake_docker_enabled() {
                fs::read(vm_sensitive_host_path_for_fake(&vm, &vm_path)?)?
            } else {
                vm_read_bytes(&vm, &vm_path).await?.1
            };
            String::from_utf8(bytes).context("sensitive file is not valid UTF-8")
        }
        SensitiveFileReference::Local { path } => fs::read_to_string(path).map_err(Into::into),
    }
}

async fn delete_sensitive_file_from_reference(reference: SensitiveFileReference) -> Result<()> {
    match reference {
        SensitiveFileReference::Vm { vm, vm_path } => {
            if fake_docker_enabled() {
                let file_path = vm_sensitive_host_path_for_fake(&vm, &vm_path)?;
                if file_path.is_file() {
                    let _ = fs::remove_file(file_path);
                }
            } else {
                let _ = vm_delete_regular_file(&vm, &vm_path).await;
            }
        }
        SensitiveFileReference::Local { path } => {
            if path.exists() {
                let _ = fs::remove_file(path);
            }
        }
    }
    Ok(())
}

pub(crate) async fn cleanup_expired_sensitive_info_files_once() -> Result<usize> {
    let now = now_epoch_seconds();
    let mut removed = 0;
    for (metadata_path, metadata) in sensitive_metadata_entries()? {
        let expires_at = metadata
            .get("expires_at")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        if expires_at > now {
            continue;
        }
        if let Ok(reference) = sensitive_file_reference_from_metadata(&metadata) {
            let _ = delete_sensitive_file_from_reference(reference).await;
        }
        let _ = fs::remove_file(metadata_path);
        removed += 1;
    }
    Ok(removed)
}

fn schedule_sensitive_info_cleanup() {
    tokio::spawn(async move {
        sleep(Duration::from_secs(
            SENSITIVE_INFO_TTL_SECONDS.saturating_add(1),
        ))
        .await;
        if let Err(error) = cleanup_expired_sensitive_info_files_once().await {
            tracing::warn!("sensitive information cleanup sweep failed: {error:#}");
        }
    });
}

fn resolve_sensitive_workspace_target(
    chat_id: &str,
    vm_id: Option<&str>,
    relative_path: &str,
) -> Result<SensitiveWorkspaceTarget> {
    if let Some(vm_id) = vm_id {
        let Some(vm) = load_vm_info(vm_id)? else {
            bail!("No VM found with vm_id={vm_id}");
        };
        if vm.chat_id != chat_id {
            bail!("VM {vm_id} belongs to chat {}, not {chat_id}", vm.chat_id);
        }
        return Ok(SensitiveWorkspaceTarget::Vm(vm));
    }

    if let Some(vm) = load_default_vm_for_chat(chat_id)? {
        return Ok(SensitiveWorkspaceTarget::Vm(vm));
    }

    let root = local_chat_workspace_root(chat_id).with_context(|| {
        format!(
            "No Agent VM was available for chat_id={chat_id}, and the configured chat workspace is not accessible from this process. Pass vm_id explicitly or create an Agent VM before requesting sensitive information."
        )
    })?;
    let path = root.join(relative_path);
    ensure_within(&root, &path)?;
    Ok(SensitiveWorkspaceTarget::Local { root, path })
}

async fn write_sensitive_value_to_target(
    target: &SensitiveWorkspaceTarget,
    vm_path: &str,
    bytes: &[u8],
) -> Result<()> {
    match target {
        SensitiveWorkspaceTarget::Vm(vm) => write_sensitive_file_in_vm(vm, vm_path, bytes).await,
        SensitiveWorkspaceTarget::Local { root, path } => {
            ensure_within(root, path)?;
            write_file_private(path, bytes)
        }
    }
}

fn target_vm_id(target: &SensitiveWorkspaceTarget) -> Option<String> {
    match target {
        SensitiveWorkspaceTarget::Vm(vm) => Some(vm.vm_id.clone()),
        SensitiveWorkspaceTarget::Local { .. } => None,
    }
}

fn strip_sensitive_value(mut value: Value) -> Value {
    match &mut value {
        Value::Object(object) => {
            object.remove("sensitive_value");
            for nested in object.values_mut() {
                *nested = strip_sensitive_value(std::mem::take(nested));
            }
        }
        Value::Array(items) => {
            for item in items {
                *item = strip_sensitive_value(std::mem::take(item));
            }
        }
        _ => {}
    }
    value
}

/// Best-effort: tells the Electron API to dismiss the secure prompt, clear the
/// waiting bar, and unlock the composer when this tool call ends without a
/// user response. Failures are ignored — the flow-level timeout in Electron
/// remains the backstop.
async fn cancel_sensitive_info_flow(flow_id: &str, reason: &str) {
    let _ = core_mcp_shared::electron_post_json(
        "/api/cancel-sensitive-info-flow",
        &json!({ "flow_id": flow_id, "reason": reason }),
        SENSITIVE_INFO_STATUS_TIMEOUT_SECONDS,
    )
    .await;
}

async fn poll_sensitive_info_flow_status(
    flow_id: &str,
    timeout_seconds: u64,
    chat_id: &str,
    vm_id: Option<&str>,
    label: Option<&str>,
) -> Result<Value> {
    let max_wait = Duration::from_secs(timeout_seconds.saturating_add(30));
    let start = std::time::Instant::now();

    while start.elapsed() <= max_wait {
        let status_payload = match core_mcp_shared::electron_get_json(
            &format!("/api/sensitive-info-flow-status/{flow_id}"),
            SENSITIVE_INFO_STATUS_TIMEOUT_SECONDS,
        )
        .await
        {
            Ok(payload) => payload,
            Err(error) => {
                cancel_sensitive_info_flow(flow_id, "poll_error").await;
                return success_text(json!({
                    "success": false,
                    "status": "error",
                    "error": format!("Failed to poll the sensitive-info flow: {error}"),
                }))
            }
        };

        if !status_payload
            .get("success")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            cancel_sensitive_info_flow(flow_id, "status_error").await;
            return success_text(strip_sensitive_value(status_payload));
        }

        match status_payload.get("status").and_then(Value::as_str) {
            Some("completed") => {
                let result = status_payload
                    .get("result")
                    .cloned()
                    .unwrap_or_else(|| json!({"success": false, "status": "error", "error": "Electron API returned a completed sensitive-info flow without a result"}));
                if !result
                    .get("success")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    return success_text(strip_sensitive_value(result));
                }

                let Some(sensitive_value) = result.get("sensitive_value").and_then(Value::as_str)
                else {
                    return success_text(json!({
                        "success": false,
                        "status": "error",
                        "error": "Electron API returned a submitted sensitive-info flow without sensitive_value",
                    }));
                };

                let request_id = Uuid::new_v4().to_string();
                let slug = slugify_sensitive_label(label);
                let relative_path = format!("{SENSITIVE_INFO_DIR}/{slug}-{request_id}.txt");
                let vm_path = format!("/work/{relative_path}");
                let target =
                    match resolve_sensitive_workspace_target(chat_id, vm_id, &relative_path) {
                        Ok(target) => target,
                        Err(error) => {
                            return success_text(json!({
                                "success": false,
                                "status": "error",
                                "error": error.to_string(),
                            }))
                        }
                    };
                if let Err(error) =
                    write_sensitive_value_to_target(&target, &vm_path, sensitive_value.as_bytes())
                        .await
                {
                    return success_text(json!({
                        "success": false,
                        "status": "error",
                        "error": format!("Failed to store sensitive information: {error}"),
                    }));
                }

                let created_at = now_epoch_seconds();
                let expires_at = created_at + SENSITIVE_INFO_TTL_SECONDS as f64;
                let effective_vm_id = target_vm_id(&target);
                write_sensitive_metadata(&json!({
                    "request_id": request_id,
                    "chat_id": chat_id,
                    "vm_id": effective_vm_id,
                    "relative_path": relative_path,
                    "vm_path": vm_path,
                    "created_at": created_at,
                    "expires_at": expires_at,
                    "ttl_seconds": SENSITIVE_INFO_TTL_SECONDS,
                }))?;
                schedule_sensitive_info_cleanup();
                if let SensitiveWorkspaceTarget::Vm(vm) = &target {
                    let _ = touch_vm_activity(vm.vm_id.as_str());
                }

                return success_text(json!({
                    "success": true,
                    "status": "stored",
                    "chat_id": chat_id,
                    "vm_id": effective_vm_id,
                    "relative_path": relative_path,
                    "workspace_path": relative_path,
                    "vm_path": vm_path,
                    "expires_at": expires_at,
                    "ttl_seconds": SENSITIVE_INFO_TTL_SECONDS,
                    "message": "Sensitive information was saved to the workspace file. Use the file path from code execution when needed, but do not read, print, echo, or summarize the file contents.",
                }));
            }
            Some("in_progress") => {
                sleep(Duration::from_millis(SENSITIVE_INFO_POLL_INTERVAL_MILLIS)).await;
            }
            other => {
                let other = other.unwrap_or("missing").to_string();
                cancel_sensitive_info_flow(flow_id, "unexpected_status").await;
                return success_text(json!({
                    "success": false,
                    "status": "error",
                    "flow_id": flow_id,
                    "error": format!(
                        "Unexpected sensitive-info flow status from Electron API: {other}"
                    ),
                }));
            }
        }
    }

    cancel_sensitive_info_flow(flow_id, "tool_timeout").await;
    success_text(json!({
        "success": false,
        "status": "timeout",
        "flow_id": flow_id,
        "error": "Timed out waiting for the sensitive-info flow to complete",
    }))
}

pub async fn handle_request_sensitive_information(arguments: &Map<String, Value>) -> Result<Value> {
    let chat_id = required_limited_string(
        arguments.get("chat_id").context("chat_id is required")?,
        "chat_id",
        120,
    )?;
    let prompt = required_limited_string(
        arguments.get("prompt").context("prompt is required")?,
        "prompt",
        1000,
    )?;
    let preamble = optional_limited_string(arguments.get("preamble"), "preamble", 4000)?;
    let label = optional_limited_string(arguments.get("label"), "label", 80)?;
    let placeholder = optional_limited_string(arguments.get("placeholder"), "placeholder", 200)?;
    let vm_id = optional_limited_string(arguments.get("vm_id"), "vm_id", 120)?;
    let timeout_seconds = validate_sensitive_timeout_seconds(arguments)?;
    let visual_aids = validate_visual_aids(arguments)?;

    if let Some(vm_id) = vm_id.as_deref() {
        let Some(vm) = load_vm_info(vm_id)? else {
            return failure_response(format!("No VM found with vm_id={vm_id}"));
        };
        if vm.chat_id != chat_id {
            return failure_response(format!(
                "VM {vm_id} belongs to chat {}, not {chat_id}",
                vm.chat_id
            ));
        }
    }

    let trigger_payload = match core_mcp_shared::electron_post_json(
        "/api/trigger-sensitive-info-flow",
        &json!({
            "chat_id": chat_id,
            "prompt": prompt,
            "preamble": preamble,
            "label": label,
            "placeholder": placeholder,
            "timeout_seconds": timeout_seconds,
            "visual_aids": visual_aids,
        }),
        SENSITIVE_INFO_TRIGGER_TIMEOUT_SECONDS,
    )
    .await
    {
        Ok(payload) => payload,
        Err(error) => {
            return success_text(json!({
                "success": false,
                "status": "error",
                "error": format!("Failed to start the sensitive-info flow: {error}"),
            }))
        }
    };

    if !trigger_payload
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return success_text(strip_sensitive_value(trigger_payload));
    }

    let flow_id = trigger_payload
        .get("flow_id")
        .and_then(Value::as_str)
        .context("Electron API did not return flow_id for request_sensitive_information")?;

    poll_sensitive_info_flow_status(
        flow_id,
        timeout_seconds,
        &chat_id,
        vm_id.as_deref(),
        label.as_deref(),
    )
    .await
}

fn replace_sensitive_values_in_string(text: &str, sensitive_values: &[String]) -> String {
    let mut redacted = text.to_string();
    for value in sensitive_values {
        if !value.is_empty() {
            redacted = redacted.replace(value, SENSITIVE_INFO_REDACTION);
        }
    }
    redacted
}

fn redact_sensitive_values_in_json(value: &mut Value, sensitive_values: &[String]) {
    match value {
        Value::String(text) => {
            if let Ok(mut parsed) = serde_json::from_str::<Value>(text) {
                redact_sensitive_values_in_json(&mut parsed, sensitive_values);
                if let Ok(rendered) = serde_json::to_string_pretty(&parsed) {
                    *text = rendered;
                    return;
                }
            }
            *text = replace_sensitive_values_in_string(text, sensitive_values);
        }
        Value::Array(items) => {
            for item in items {
                redact_sensitive_values_in_json(item, sensitive_values);
            }
        }
        Value::Object(object) => {
            for nested in object.values_mut() {
                redact_sensitive_values_in_json(nested, sensitive_values);
            }
        }
        _ => {}
    }
}

async fn active_sensitive_values_for_chat(chat_id: &str) -> Result<Vec<String>> {
    let now = now_epoch_seconds();
    let mut values = Vec::new();
    for (_metadata_path, metadata) in sensitive_metadata_entries()? {
        if metadata.get("chat_id").and_then(Value::as_str) != Some(chat_id) {
            continue;
        }
        let expires_at = metadata
            .get("expires_at")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        if expires_at <= now {
            continue;
        }
        let Ok(reference) = sensitive_file_reference_from_metadata(&metadata) else {
            continue;
        };
        let Ok(value) = read_sensitive_value_from_reference(reference).await else {
            continue;
        };
        if !value.is_empty() {
            values.push(value);
        }
    }
    Ok(values)
}

fn redaction_chat_id(arguments: &Map<String, Value>) -> Result<Option<String>> {
    if let Some(chat_id) = arguments.get("chat_id").and_then(Value::as_str) {
        return Ok(Some(chat_id.to_string()));
    }
    if let Some(vm_id) = arguments.get("vm_id").and_then(Value::as_str) {
        return Ok(load_vm_info(vm_id)?.map(|vm| vm.chat_id));
    }
    Ok(None)
}

pub(crate) async fn redact_agent_vm_sensitive_values(
    arguments: &Map<String, Value>,
    mut value: Value,
) -> Result<Value> {
    let Some(chat_id) = redaction_chat_id(arguments)? else {
        return Ok(value);
    };
    let sensitive_values = active_sensitive_values_for_chat(&chat_id).await?;
    if sensitive_values.is_empty() {
        return Ok(value);
    }
    redact_sensitive_values_in_json(&mut value, &sensitive_values);
    Ok(value)
}
