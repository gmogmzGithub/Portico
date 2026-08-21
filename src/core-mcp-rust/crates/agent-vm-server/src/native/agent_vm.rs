use std::fs;
use std::fs::OpenOptions;
use std::time::SystemTime;

use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use glob::Pattern;
use serde_json::{json, Map, Value};
use tokio::process::Command;
use walkdir::WalkDir;

use super::shared::{
    app_root, array_strings, bool_arg, container_workspaces_dir, find_skill, host_workspaces_dir,
    int_arg, now_epoch_seconds, plain_text, redis_compare_delete, redis_delete, redis_get_string,
    redis_persist, redis_sadd, redis_set_nx_ex_string, redis_set_string, redis_setex_string,
    redis_sismember, string_arg, success_text,
};

#[path = "agent_vm_chat_workspace.rs"]
mod agent_vm_chat_workspace;
#[path = "agent_vm_core.rs"]
mod agent_vm_core;
#[path = "agent_vm_fs.rs"]
mod agent_vm_fs;
#[path = "agent_vm_sensitive.rs"]
mod agent_vm_sensitive;
#[path = "agent_vm_workspace.rs"]
mod agent_vm_workspace;

pub(crate) use agent_vm_chat_workspace::*;
pub(crate) use agent_vm_core::*;
pub(crate) use agent_vm_fs::*;
pub(crate) use agent_vm_sensitive::*;
pub(crate) use agent_vm_workspace::*;

const MAX_VM_TIMEOUT_HOURS: f64 = 24.0;
const VM_INFO_PREFIX: &str = "agent_vm_info:";
const FILE_READS_PREFIX: &str = "agent_vm_file_reads:";
const CONTAINER_PREFIX: &str = "agent-vm-";
const VM_MEMORY_LIMIT_BYTES: i64 = 1_073_741_824;
const VM_CPU_PERIOD: i64 = 100_000;
const VM_CPU_QUOTA: i64 = 200_000;
const MAX_INLINE_IMAGE_SIZE: u64 = 5 * 1024 * 1024;
const DEFAULT_FILE_CHUNK_MAX_CHARS: usize = 1_500;
const MAX_FILE_CHUNK_MAX_CHARS: usize = 2_000;

fn failure_response(error: impl Into<String>) -> Result<Value> {
    success_text(json!({"success": false, "error": error.into()}))
}

fn workspace_root_for_ids(chat_id: &str, _vm_id: &str) -> Result<std::path::PathBuf> {
    container_chat_workspace_root(chat_id)
}

fn batch_message(
    success_count: usize,
    total: usize,
    success_text_value: &str,
    partial_prefix: &str,
) -> String {
    if success_count == total {
        success_text_value.to_string()
    } else {
        format!(
            "{partial_prefix} {success_count}/{total}. {} failed.",
            total.saturating_sub(success_count)
        )
    }
}

pub async fn handle_create(arguments: &Map<String, Value>) -> Result<Value> {
    let Some(chat_id) = arguments.get("chat_id").and_then(Value::as_str) else {
        return Ok(plain_text("Error: chat_id is required"));
    };
    let timeout_hours = arguments
        .get("timeout_hours")
        .and_then(Value::as_f64)
        .unwrap_or_else(default_vm_timeout_hours)
        .min(MAX_VM_TIMEOUT_HOURS);

    let _guard = ChatVmResolutionLockGuard::acquire(chat_id).await?;
    if let Some(vm_info) = load_usable_default_vm_for_chat(chat_id).await? {
        return success_text(json!({
            "success": true,
            "created": false,
            "reused": true,
            "vm_id": vm_info.vm_id,
            "container_id": short_container_id(&vm_info.container_id),
            "status": vm_info.status,
            "timeout_hours": vm_info.timeout_hours,
            "working_directory": "/work",
            "workspace_mode": workspace_mode_for_vm(&vm_info),
            "workspace": workspace_display_metadata(&vm_info),
            "message": format!("Existing Agent VM reused. Use vm_id '{}' for all subsequent VM operations.", vm_info.vm_id),
        }));
    }

    let vm_info = create_vm(chat_id, timeout_hours, None).await?;
    store_default_vm_mapping(&vm_info)?;
    success_text(json!({
        "success": true,
        "created": true,
        "reused": false,
        "vm_id": vm_info.vm_id,
        "container_id": short_container_id(&vm_info.container_id),
        "status": vm_info.status,
        "timeout_hours": vm_info.timeout_hours,
        "working_directory": "/work",
        "workspace_mode": workspace_mode_for_vm(&vm_info),
        "workspace": workspace_display_metadata(&vm_info),
        "message": format!("Agent VM created successfully. Use vm_id '{}' for all subsequent VM operations.", vm_info.vm_id),
    }))
}

pub async fn handle_get_status(arguments: &Map<String, Value>) -> Result<Value> {
    let Some(vm_id) = arguments.get("vm_id").and_then(Value::as_str) else {
        return Ok(plain_text("Error: vm_id is required"));
    };
    let Some(mut vm_info) = load_vm_info(vm_id)? else {
        return success_text(
            json!({"success": false, "vm_id": vm_id, "error": format!("No Agent VM found with vm_id: {vm_id}")}),
        );
    };
    match inspect_vm_container_status(&vm_info).await? {
        Some(status) => {
            vm_info.status = status.clone();
            store_vm_info(&vm_info)?;
            let elapsed = now_epoch_seconds() - vm_info.last_activity;
            let remaining = ((vm_info.timeout_hours * 3600.0) - elapsed).max(0.0) / 3600.0;
            success_text(json!({
                "success": true,
                "vm_id": vm_info.vm_id,
                "status": status,
                "container_id": short_container_id(&vm_info.container_id),
                "owner_chat_id": vm_info.chat_id,
                "timeout_hours": vm_info.timeout_hours,
                "hours_remaining": (remaining * 10.0).round() / 10.0,
                "workspace": workspace_display_metadata(&vm_info),
            }))
        }
        None => {
            delete_vm_info(vm_id)?;
            success_text(
                json!({"success": false, "vm_id": vm_id, "error": format!("No Agent VM found with vm_id: {vm_id}")}),
            )
        }
    }
}

pub async fn handle_destroy(arguments: &Map<String, Value>) -> Result<Value> {
    let Some(vm_id) = arguments.get("vm_id").and_then(Value::as_str) else {
        return Ok(plain_text(
            "Error: vm_id and requester_chat_id are required",
        ));
    };
    let Some(requester_chat_id) = arguments.get("requester_chat_id").and_then(Value::as_str) else {
        return Ok(plain_text(
            "Error: vm_id and requester_chat_id are required",
        ));
    };
    let Some(vm_info) = load_vm_info(vm_id)? else {
        return success_text(
            json!({"success": false, "vm_id": vm_id, "error": "VM not found or unauthorized"}),
        );
    };
    if vm_info.chat_id != requester_chat_id {
        return success_text(
            json!({"success": false, "vm_id": vm_id, "error": "VM not found or unauthorized"}),
        );
    }
    remove_vm_container(&vm_info).await?;
    delete_vm_info(vm_id)?;
    clear_default_vm_mapping_if_matches(&vm_info.chat_id, vm_id)?;
    mark_vm_destroyed(vm_id, &vm_info.chat_id)?;
    Ok(success_json_message(
        vm_id,
        format!("Agent VM {vm_id} destroyed successfully."),
    ))
}

pub async fn handle_bash(arguments: &Map<String, Value>) -> Result<Value> {
    let Some(vm_id) = arguments.get("vm_id").and_then(Value::as_str) else {
        return Ok(plain_text("Error: vm_id and command are required"));
    };
    let Some(command) = arguments.get("command").and_then(Value::as_str) else {
        return Ok(plain_text("Error: vm_id and command are required"));
    };
    let Some(vm) = load_vm_info(vm_id)? else {
        return success_text(json!({
            "success": false,
            "exit_code": -1,
            "stdout": "",
            "stderr": "",
            "error": format!("No VM found with vm_id={vm_id}. Create one first with agent_vm_create."),
        }));
    };
    let result = match exec_in_vm(&vm, command).await {
        Ok(result) => result,
        Err(error) => {
            return success_text(json!({
                "success": false,
                "exit_code": -1,
                "stdout": "",
                "stderr": "",
                "error": format!("Execution failed: {error}"),
            }))
        }
    };
    let _ = touch_vm_activity(vm_id);
    success_text(
        json!({"success": result.exit_code == 0, "exit_code": result.exit_code, "stdout": result.stdout, "stderr": result.stderr}),
    )
}

pub async fn handle_python(arguments: &Map<String, Value>) -> Result<Value> {
    let Some(vm_id) = arguments.get("vm_id").and_then(Value::as_str) else {
        return failure_response("vm_id and script are required");
    };
    let Some(script) = arguments.get("script").and_then(Value::as_str) else {
        return failure_response("vm_id and script are required");
    };
    let Some(vm) = load_vm_info(vm_id)? else {
        return success_text(json!({
            "success": false,
            "exit_code": -1,
            "stdout": "",
            "stderr": "",
            "error": format!("No VM found with vm_id={vm_id}. Create one first with agent_vm_create."),
        }));
    };
    let encoded = BASE64_STANDARD.encode(script.as_bytes());
    let command = format!("python3 -c \"import base64; exec(compile(base64.b64decode('{encoded}').decode('utf-8'), '<mcp>', 'exec'))\"");
    let result = match exec_in_vm(&vm, &command).await {
        Ok(result) => result,
        Err(error) => {
            return success_text(json!({
                "success": false,
                "exit_code": -1,
                "stdout": "",
                "stderr": "",
                "error": format!("Execution failed: {error}"),
            }))
        }
    };
    let _ = touch_vm_activity(vm_id);
    success_text(
        json!({"success": result.exit_code == 0, "exit_code": result.exit_code, "stdout": result.stdout, "stderr": result.stderr}),
    )
}

pub async fn handle_create_file(arguments: &Map<String, Value>) -> Result<Value> {
    let Some(vm_id) = arguments.get("vm_id").and_then(Value::as_str) else {
        return failure_response("vm_id, path, and content are required");
    };
    let Some(requested_path) = arguments.get("path").and_then(Value::as_str) else {
        return failure_response("vm_id, path, and content are required");
    };
    let Some(content) = arguments.get("content").and_then(Value::as_str) else {
        return failure_response("vm_id, path, and content are required");
    };
    let append = arguments
        .get("append")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let Some(vm) = load_vm_info(vm_id)? else {
        return success_text(json!({
            "success": false,
            "path": requested_path,
            "message": format!("Failed to create file: {requested_path}"),
        }));
    };
    if vm_write_bytes(&vm, requested_path, content.as_bytes(), append)
        .await
        .is_err()
    {
        return success_text(json!({
            "success": false,
            "path": requested_path,
            "message": format!("Failed to create file: {requested_path}"),
        }));
    }
    let _ = touch_vm_activity(vm.vm_id.as_str());
    success_text(json!({
        "success": true,
        "path": requested_path,
        "message": if append {
            format!("File appended: {requested_path}")
        } else {
            format!("File created: {requested_path}")
        },
    }))
}

pub async fn handle_create_files(arguments: &Map<String, Value>) -> Result<Value> {
    let Some(vm_id) = arguments.get("vm_id").and_then(Value::as_str) else {
        return failure_response("vm_id is required");
    };
    let Some(files) = arguments.get("files").and_then(Value::as_array) else {
        return failure_response("files array is required and must not be empty");
    };
    for (index, file) in files.iter().enumerate() {
        let Some(object) = file.as_object() else {
            return failure_response(format!(
                "files[{index}] must be an object with path and content"
            ));
        };
        if !object.contains_key("path") || !object.contains_key("content") {
            return failure_response(format!(
                "files[{index}] must have both 'path' and 'content' properties"
            ));
        }
    }
    let Some(vm) = load_vm_info(vm_id)? else {
        let failed = files
            .iter()
            .map(|file| {
                json!({
                    "path": file.get("path").and_then(Value::as_str).unwrap_or_default(),
                    "error": "VM not found",
                })
            })
            .collect::<Vec<_>>();
        return success_text(json!({
            "success": false,
            "total": files.len(),
            "created_count": 0,
            "created": [],
            "failed_count": failed.len(),
            "failed": failed,
            "message": batch_message(0, files.len(), &format!("All {} files created successfully", files.len()), "Created"),
        }));
    };
    let mut created = Vec::new();
    let mut failed = Vec::new();
    for file in files {
        match create_batch_file_async(&vm, file).await {
            Ok(path) => created.push(json!({"path": path})),
            Err(error) => failed.push(json!({
                "path": file.get("path").and_then(Value::as_str).unwrap_or_default(),
                "error": error.to_string(),
            })),
        }
    }
    let _ = touch_vm_activity(vm.vm_id.as_str());
    let created_count = created.len();
    success_text(json!({
        "success": failed.is_empty(),
        "total": files.len(),
        "created_count": created_count,
        "created": created,
        "failed_count": failed.len(),
        "failed": failed,
        "message": batch_message(
            created_count,
            files.len(),
            &format!("All {} files created successfully", files.len()),
            "Created"
        ),
    }))
}

pub async fn handle_read_file(arguments: &Map<String, Value>) -> Result<Value> {
    let Some(vm_id) = arguments.get("vm_id").and_then(Value::as_str) else {
        return failure_response("vm_id and path are required");
    };
    let Some(requested_path) = arguments.get("path").and_then(Value::as_str) else {
        return failure_response("vm_id and path are required");
    };
    if is_sensitive_vm_path(requested_path) {
        return failure_response("Sensitive workspace files cannot be read directly. Use code execution to consume the file without printing its contents.");
    }
    let Some(vm) = load_vm_info(vm_id)? else {
        return success_text(json!({
            "success": false,
            "path": requested_path,
            "error": format!("Failed to read file or file not found: {requested_path}"),
        }));
    };
    let (vm_path, content) = match vm_read_bytes(&vm, requested_path).await {
        Ok(content) => content,
        Err(_) => {
            return success_text(json!({
                "success": false,
                "path": requested_path,
                "error": format!("Failed to read file or file not found: {requested_path}"),
            }))
        }
    };
    register_file_read(vm.vm_id.as_str(), requested_path)?;
    let _ = touch_vm_activity(vm.vm_id.as_str());
    success_text(
        json!({"success": true, "path": vm_path, "content": String::from_utf8_lossy(&content)}),
    )
}

pub async fn handle_read_fragment(arguments: &Map<String, Value>) -> Result<Value> {
    let Some(vm_id) = arguments.get("vm_id").and_then(Value::as_str) else {
        return failure_response("vm_id and path are required");
    };
    let Some(requested_path) = arguments.get("path").and_then(Value::as_str) else {
        return failure_response("vm_id and path are required");
    };
    if is_sensitive_vm_path(requested_path) {
        return failure_response("Sensitive workspace files cannot be read directly. Use code execution to consume the file without printing its contents.");
    }
    let offset_chars = int_arg(arguments, "offset_chars", 0).max(0) as usize;
    let max_chars = int_arg(arguments, "max_chars", DEFAULT_FILE_CHUNK_MAX_CHARS as i64)
        .max(1)
        .min(MAX_FILE_CHUNK_MAX_CHARS as i64) as usize;

    let Some(vm) = load_vm_info(vm_id)? else {
        return success_text(json!({
            "success": false,
            "path": requested_path,
            "error": format!("Failed to read file or file not found: {requested_path}"),
        }));
    };
    let (vm_path, bytes) = match vm_read_bytes(&vm, requested_path).await {
        Ok(result) => result,
        Err(error) => {
            let error_text = if error.to_string().contains("valid UTF-8") {
                "File appears to be binary or uses unsupported encoding".to_string()
            } else {
                format!("Failed to read file or file not found: {requested_path}")
            };
            return success_text(json!({
                "success": false,
                "path": requested_path,
                "error": error_text,
            }));
        }
    };
    let content = match String::from_utf8(bytes) {
        Ok(content) => content,
        Err(_) => {
            return success_text(json!({
                "success": false,
                "path": requested_path,
                "error": "File appears to be binary or uses unsupported encoding",
            }))
        }
    };

    let total_chars = content.chars().count();
    let safe_offset = offset_chars.min(total_chars);
    let end_chars = safe_offset.saturating_add(max_chars).min(total_chars);
    let chunk = slice_text_chars(&content, safe_offset, end_chars);
    let chars_returned = end_chars.saturating_sub(safe_offset);
    let truncated = end_chars < total_chars;

    register_file_read(vm.vm_id.as_str(), requested_path)?;
    let _ = touch_vm_activity(vm.vm_id.as_str());
    success_text(json!({
        "success": true,
        "path": vm_path,
        "content": chunk,
        "total_chars": total_chars,
        "offset_chars": safe_offset,
        "chars_returned": chars_returned,
        "next_offset_chars": if truncated { Value::from(end_chars) } else { Value::Null },
        "truncated": truncated,
    }))
}

pub async fn handle_read_files(arguments: &Map<String, Value>) -> Result<Value> {
    let Some(vm_id) = arguments.get("vm_id").and_then(Value::as_str) else {
        return failure_response("vm_id is required");
    };
    let Some(paths) = arguments.get("paths").and_then(Value::as_array) else {
        return failure_response("paths array is required and must not be empty");
    };
    if paths.is_empty() {
        return failure_response("paths array is required and must not be empty");
    }
    for (index, path) in paths.iter().enumerate() {
        if path.as_str().map(str::is_empty).unwrap_or(true) {
            return failure_response(format!("paths[{index}] must be a non-empty string"));
        }
        if path.as_str().map(is_sensitive_vm_path).unwrap_or(false) {
            return failure_response("Sensitive workspace files cannot be read directly. Use code execution to consume the file without printing its contents.");
        }
    }
    let Some(vm) = load_vm_info(vm_id)? else {
        let failed = paths
            .iter()
            .filter_map(Value::as_str)
            .map(|path| json!({"path": path, "error": "VM not found"}))
            .collect::<Vec<_>>();
        return success_text(json!({
            "success": false,
            "total": paths.len(),
            "read_count": 0,
            "read": [],
            "failed_count": failed.len(),
            "failed": failed,
            "message": batch_message(0, paths.len(), &format!("All {} files read successfully", paths.len()), "Read"),
        }));
    };
    let mut read = Vec::new();
    let mut failed = Vec::new();
    for path in paths.iter().filter_map(Value::as_str) {
        let normalized_path = normalize_vm_path(path);
        if !(normalized_path.starts_with("/work/") || normalized_path.starts_with("/tmp/")) {
            failed.push(json!({"path": path, "error": "Path must be within /work or /tmp"}));
            continue;
        }
        match vm_stat(&vm, path).await {
            Ok(stat) if stat.get("is_dir").and_then(Value::as_bool).unwrap_or(false) => {
                failed.push(json!({"path": path, "error": "Path is a directory, not a file"}));
            }
            Ok(stat) if stat.get("exists").and_then(Value::as_bool).unwrap_or(false) => {
                match vm_read_bytes(&vm, path).await {
                    Ok((_vm_path, bytes)) => match String::from_utf8(bytes) {
                        Ok(content) => {
                            register_file_read(vm.vm_id.as_str(), normalized_path.as_str())?;
                            read.push(json!({"path": normalized_path, "content": content}));
                        }
                        Err(_) => failed.push(json!({"path": path, "error": "File appears to be binary or uses unsupported encoding"})),
                    },
                    Err(_) => failed.push(json!({"path": path, "error": format!("File not found: {normalized_path}")})),
                }
            }
            _ => failed
                .push(json!({"path": path, "error": format!("File not found: {normalized_path}")})),
        }
    }
    let _ = touch_vm_activity(vm.vm_id.as_str());
    let read_count = read.len();
    success_text(json!({
        "success": failed.is_empty(),
        "total": paths.len(),
        "read_count": read_count,
        "read": read,
        "failed_count": failed.len(),
        "failed": failed,
        "message": batch_message(
            read_count,
            paths.len(),
            &format!("All {} files read successfully", paths.len()),
            "Read"
        ),
    }))
}

fn slice_text_chars(content: &str, start_chars: usize, end_chars: usize) -> &str {
    if start_chars >= end_chars {
        return "";
    }

    let start_byte = if start_chars == 0 {
        0
    } else {
        content
            .char_indices()
            .nth(start_chars)
            .map(|(index, _)| index)
            .unwrap_or(content.len())
    };
    let end_byte = if end_chars >= content.chars().count() {
        content.len()
    } else {
        content
            .char_indices()
            .nth(end_chars)
            .map(|(index, _)| index)
            .unwrap_or(content.len())
    };
    &content[start_byte..end_byte]
}

pub async fn handle_edit_file(arguments: &Map<String, Value>) -> Result<Value> {
    let Some(vm_id) = arguments.get("vm_id").and_then(Value::as_str) else {
        return failure_response("vm_id, file_path, old_string, and new_string are required");
    };
    let Some(file_path) = arguments.get("file_path").and_then(Value::as_str) else {
        return failure_response("vm_id, file_path, old_string, and new_string are required");
    };
    let Some(old_string) = arguments.get("old_string").and_then(Value::as_str) else {
        return failure_response("vm_id, file_path, old_string, and new_string are required");
    };
    let Some(new_string) = arguments.get("new_string").and_then(Value::as_str) else {
        return failure_response("vm_id, file_path, old_string, and new_string are required");
    };
    if old_string.is_empty() {
        return failure_response(
            "old_string cannot be empty. Use agent_vm_create_file to create/overwrite files.",
        );
    }
    if old_string == new_string {
        return success_text(json!({
            "success": true,
            "file_path": file_path,
            "replacements_made": 0,
            "message": "No changes made - old_string equals new_string",
        }));
    }
    let Some(vm) = load_vm_info(vm_id)? else {
        return failure_response(format!(
            "No VM found with vm_id={vm_id}. Create one first with agent_vm_create."
        ));
    };
    if !has_file_been_read(vm_id, file_path)? {
        return success_text(json!({
            "success": false,
            "error": "File must be read before editing",
            "file_path": file_path,
            "hint": "Use agent_vm_read_file to read the file first. This ensures edits are based on current file content.",
        }));
    }
    let replace_all = bool_arg(arguments, "replace_all", false);
    let updated =
        match edit_file_impl_async(&vm, file_path, old_string, new_string, replace_all).await {
            Ok(updated) => updated,
            Err(error) => return failure_response(error.to_string()),
        };
    let _ = touch_vm_activity(vm.vm_id.as_str());
    success_text(json!({
        "success": true,
        "file_path": normalize_vm_path(file_path),
        "replacements_made": updated,
        "message": format!(
            "Successfully edited file. {}{updated} replacement(s) made.",
            if replace_all { "All " } else { "" }
        ),
    }))
}

pub async fn handle_edit_files(arguments: &Map<String, Value>) -> Result<Value> {
    let Some(vm_id) = arguments.get("vm_id").and_then(Value::as_str) else {
        return failure_response("vm_id is required");
    };
    let Some(edits) = arguments.get("edits").and_then(Value::as_array) else {
        return failure_response("edits array is required and must not be empty");
    };
    for (index, edit) in edits.iter().enumerate() {
        let Some(object) = edit.as_object() else {
            return failure_response(format!("edits[{index}] must be an object"));
        };
        if !object.contains_key("file_path") {
            return failure_response(format!("edits[{index}] must have 'file_path'"));
        }
        if !object.contains_key("old_string") {
            return failure_response(format!("edits[{index}] must have 'old_string'"));
        }
        if !object.contains_key("new_string") {
            return failure_response(format!("edits[{index}] must have 'new_string'"));
        }
        if object
            .get("old_string")
            .and_then(Value::as_str)
            .map(str::is_empty)
            .unwrap_or(true)
        {
            return failure_response(format!("edits[{index}].old_string cannot be empty"));
        }
        if object.get("old_string") == object.get("new_string") {
            return failure_response(format!(
                "edits[{index}] has old_string equal to new_string (no-op)"
            ));
        }
    }
    let Some(vm) = load_vm_info(vm_id)? else {
        let failed = edits
            .iter()
            .map(|edit| {
                json!({
                    "path": edit.get("file_path").and_then(Value::as_str).unwrap_or("unknown"),
                    "error": "VM not found",
                })
            })
            .collect::<Vec<_>>();
        return success_text(json!({
            "success": false,
            "total": edits.len(),
            "edited_count": 0,
            "edited": [],
            "failed_count": failed.len(),
            "failed": failed,
            "message": batch_message(0, edits.len(), &format!("All {} edits applied successfully", edits.len()), "Applied"),
        }));
    };
    let mut edited = Vec::new();
    let mut failed = Vec::new();
    for edit in edits {
        let Some(object) = edit.as_object() else {
            continue;
        };
        let file_path = object
            .get("file_path")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match edit_file_impl_async(
            &vm,
            file_path,
            object
                .get("old_string")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            object
                .get("new_string")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            object
                .get("replace_all")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        )
        .await
        {
            Ok(count) => edited.push(json!({
                "path": normalize_vm_path(file_path),
                "replacements_made": count,
            })),
            Err(error) => failed.push(json!({"path": file_path, "error": error.to_string()})),
        }
    }
    let _ = touch_vm_activity(vm.vm_id.as_str());
    let edited_count = edited.len();
    success_text(json!({
        "success": failed.is_empty(),
        "total": edits.len(),
        "edited_count": edited_count,
        "edited": edited,
        "failed_count": failed.len(),
        "failed": failed,
        "message": batch_message(
            edited_count,
            edits.len(),
            &format!("All {} edits applied successfully", edits.len()),
            "Applied"
        ),
    }))
}

pub async fn handle_delete_file(arguments: &Map<String, Value>) -> Result<Value> {
    let Some(vm_id) = arguments.get("vm_id").and_then(Value::as_str) else {
        return failure_response("vm_id and path are required");
    };
    let Some(requested_path) = arguments.get("path").and_then(Value::as_str) else {
        return failure_response("vm_id and path are required");
    };
    let Some(vm) = load_vm_info(vm_id)? else {
        return success_text(json!({
            "success": false,
            "path": requested_path,
            "message": format!("Failed to delete: {requested_path}"),
        }));
    };
    let result = vm_delete_regular_file(&vm, requested_path)
        .await
        .unwrap_or(false);
    let _ = touch_vm_activity(vm_id);
    success_text(
        json!({"success": result, "path": requested_path, "message": if result { format!("Deleted: {requested_path}") } else { format!("Failed to delete: {requested_path}") }}),
    )
}

pub async fn handle_list_files(arguments: &Map<String, Value>) -> Result<Value> {
    let Some(vm_id) = arguments.get("vm_id").and_then(Value::as_str) else {
        return failure_response("vm_id is required");
    };
    let Some(vm) = load_vm_info(vm_id)? else {
        return failure_response(format!("No VM found with vm_id={vm_id}"));
    };
    let directory = arguments
        .get("directory")
        .and_then(Value::as_str)
        .unwrap_or("/work");
    let recursive = bool_arg(arguments, "recursive", false);
    let (files, directories) = match list_vm_directory(&vm, directory, recursive).await {
        Ok(entries) => entries,
        Err(error) => return failure_response(error.to_string()),
    };
    let _ = touch_vm_activity(vm.vm_id.as_str());
    success_text(json!({
        "success": true,
        "directory": normalize_vm_path(directory),
        "files": files,
        "directories": directories,
        "total_count": files.len() + directories.len(),
    }))
}

#[cfg(test)]
#[path = "agent_vm_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "agent_vm_workspace_tests.rs"]
mod workspace_tests;

#[cfg(test)]
#[path = "agent_vm_unzip_tests.rs"]
mod unzip_tests;

#[cfg(test)]
#[path = "agent_vm_branch_tests.rs"]
mod branch_tests;

#[cfg(test)]
#[path = "agent_vm_coverage_tests.rs"]
mod coverage_tests;
