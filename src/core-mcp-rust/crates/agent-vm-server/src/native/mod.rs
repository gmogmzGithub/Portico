use std::collections::{BTreeMap, HashMap, HashSet};
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use bollard::container::LogOutput;
use bollard::exec::{CreateExecOptions, StartExecOptions, StartExecResults};
use bollard::models::{ContainerCreateBody, HostConfig};
use bollard::query_parameters::{
    CreateContainerOptions, DownloadFromContainerOptionsBuilder, InspectContainerOptions,
    RemoveContainerOptions, StartContainerOptions, UploadToContainerOptionsBuilder,
};
use bollard::Docker;
use futures_util::StreamExt;
use glob::Pattern;
use mime_guess::MimeGuess;
use regex::Regex;
use serde_json::{json, Map, Value};
use uuid::Uuid;
use walkdir::WalkDir;
use zip::ZipArchive;

use core_mcp_shared::*;

pub(crate) use core_mcp_shared::TEST_ENV_LOCK;

pub(crate) mod shared {
    pub use core_mcp_shared::*;
}

mod agent_vm;

pub(crate) use agent_vm::*;

const DEFAULT_VM_TIMEOUT_HOURS: f64 = 24.0;
const MAX_VM_TIMEOUT_HOURS: f64 = 24.0;
const DEFAULT_VM_NETWORK: &str = "portico-network";
const VM_INFO_PREFIX: &str = "agent_vm_info:";
const FILE_READS_PREFIX: &str = "agent_vm_file_reads:";
const CONTAINER_PREFIX: &str = "agent-vm-";
const VM_MEMORY_LIMIT_BYTES: i64 = 1_073_741_824;
const VM_CPU_PERIOD: i64 = 100_000;
const VM_CPU_QUOTA: i64 = 200_000;
const MAX_INLINE_IMAGE_SIZE: u64 = 5 * 1024 * 1024;
const AGENT_VM_TOOL_RESULT_OVERFLOW_ENABLED_ENV: &str = "AGENT_VM_TOOL_RESULT_OVERFLOW_ENABLED";
const AGENT_VM_TOOL_RESULT_MAX_CHARS_ENV: &str = "AGENT_VM_TOOL_RESULT_MAX_CHARS";

pub(crate) struct Dispatcher;

#[derive(Debug, Clone)]
struct VmDispatchContext {
    requested_vm_id: String,
    effective_vm_id: String,
    effective_chat_id: Option<String>,
}

impl VmDispatchContext {
    fn vm_id_changed(&self) -> bool {
        self.requested_vm_id != self.effective_vm_id
    }
}

fn tool_supports_silent_vm_recovery(tool_name: &str) -> bool {
    matches!(
        tool_name,
        "get_status"
            | "bash"
            | "python"
            | "create_file"
            | "create_files"
            | "edit_file"
            | "edit_files"
            | "read_file"
            | "read_fragment"
            | "read_files"
            | "delete_file"
            | "list_files"
            | "copy_from_workspace"
            | "copy_to_workspace"
            | "list_workspace_files"
            | "write_to_workspace"
            | "get_workspace_file_link"
            | "display_files"
            | "request_images"
            | "request_sensitive_information"
            | "unzip_file"
            | "find_files"
            | "grep"
            | "grep_file"
            | "execute_skill_script"
    )
}

async fn resolve_vm_dispatch(
    tool_name: &str,
    arguments: &Map<String, Value>,
) -> Result<(Map<String, Value>, Option<VmDispatchContext>)> {
    if !tool_supports_silent_vm_recovery(tool_name) {
        return Ok((arguments.clone(), None));
    }

    let Some(requested_vm_id) = arguments.get("vm_id").and_then(Value::as_str) else {
        return Ok((arguments.clone(), None));
    };

    let Some(resolved_vm) = resolve_vm_for_request(
        requested_vm_id,
        arguments.get("chat_id").and_then(Value::as_str),
    )
    .await?
    else {
        return Ok((arguments.clone(), None));
    };

    let mut effective_arguments = arguments.clone();
    effective_arguments.insert(
        "vm_id".to_string(),
        Value::String(resolved_vm.effective_vm.vm_id.clone()),
    );
    if resolved_vm.vm_id_changed() {
        if arguments.contains_key("chat_id") {
            effective_arguments.insert(
                "chat_id".to_string(),
                Value::String(resolved_vm.effective_vm.chat_id.clone()),
            );
        }
    }

    Ok((
        effective_arguments,
        Some(VmDispatchContext {
            requested_vm_id: resolved_vm.requested_vm_id,
            effective_vm_id: resolved_vm.effective_vm.vm_id,
            effective_chat_id: Some(resolved_vm.effective_vm.chat_id),
        }),
    ))
}

#[async_trait::async_trait]
impl ToolDispatcher for Dispatcher {
    async fn call(&self, tool_name: &str, arguments: &Map<String, Value>) -> Result<Option<Value>> {
        let (effective_arguments, vm_dispatch) = resolve_vm_dispatch(tool_name, arguments).await?;

        let result = match tool_name {
            "create" => Some(handle_create(&effective_arguments).await?),
            "get_status" => Some(handle_get_status(&effective_arguments).await?),
            "destroy" => Some(handle_destroy(&effective_arguments).await?),
            "bash" => Some(handle_bash(&effective_arguments).await?),
            "python" => Some(handle_python(&effective_arguments).await?),
            "create_file" => Some(handle_create_file(&effective_arguments).await?),
            "create_files" => Some(handle_create_files(&effective_arguments).await?),
            "edit_file" => Some(handle_edit_file(&effective_arguments).await?),
            "edit_files" => Some(handle_edit_files(&effective_arguments).await?),
            "read_file" => Some(handle_read_file(&effective_arguments).await?),
            "read_fragment" => Some(handle_read_fragment(&effective_arguments).await?),
            "read_files" => Some(handle_read_files(&effective_arguments).await?),
            "delete_file" => Some(handle_delete_file(&effective_arguments).await?),
            "list_files" => Some(handle_list_files(&effective_arguments).await?),
            "copy_from_workspace" => Some(handle_copy_from_workspace(&effective_arguments).await?),
            "copy_to_workspace" => Some(handle_copy_to_workspace(&effective_arguments).await?),
            "list_workspace_files" => {
                Some(handle_list_workspace_files(&effective_arguments).await?)
            }
            "write_to_workspace" => Some(handle_write_to_workspace(&effective_arguments).await?),
            "execute_skill_script" => {
                Some(handle_execute_skill_script(&effective_arguments).await?)
            }
            "get_workspace_file_link" => {
                Some(handle_get_workspace_file_link(&effective_arguments).await?)
            }
            "display_files" => Some(handle_display_files(&effective_arguments).await?),
            "request_images" => Some(handle_request_images(&effective_arguments).await?),
            "request_sensitive_information" => {
                Some(handle_request_sensitive_information(&effective_arguments).await?)
            }
            "set_chat_workspace" => Some(handle_set_chat_workspace(&effective_arguments).await?),
            "unzip_file" => Some(handle_unzip_file(&effective_arguments).await?),
            "find_files" => Some(handle_find_files(&effective_arguments).await?),
            "grep" => Some(handle_grep(&effective_arguments).await?),
            "grep_file" => Some(handle_grep_file(&effective_arguments).await?),
            _ => None,
        };

        match result {
            Some(value) => {
                let value = redact_agent_vm_sensitive_values(&effective_arguments, value).await?;
                let value =
                    maybe_spill_agent_vm_tool_result(tool_name, &effective_arguments, value)
                        .await?;
                Ok(Some(annotate_vm_dispatch_response(
                    value,
                    vm_dispatch.as_ref(),
                )?))
            }
            None => Ok(None),
        }
    }
}

struct AgentVmOverflowTarget {
    chat_id: String,
    vm_id: String,
    sink: AgentVmOverflowSink,
}

enum AgentVmOverflowSink {
    /// Workspace root reachable from this process — write with plain fs.
    LocalRoot(PathBuf),
    /// Custom workspace outside this process's mounts (e.g. a user folder
    /// under ~/Documents) — only the VM container can reach it, so the
    /// spill file is written through the VM instead.
    Vm(VmInfo),
}

async fn maybe_spill_agent_vm_tool_result(
    tool_name: &str,
    arguments: &Map<String, Value>,
    value: Value,
) -> Result<Value> {
    if !overflow_enabled_from_env(AGENT_VM_TOOL_RESULT_OVERFLOW_ENABLED_ENV, true) {
        return Ok(value);
    }

    let Some(rendered) = extract_single_text_tool_response_text(&value).map(str::to_string) else {
        return Ok(value);
    };
    if serde_json::from_str::<Value>(&rendered)
        .ok()
        .and_then(|payload| payload.get("success").and_then(Value::as_bool))
        == Some(false)
    {
        return Ok(value);
    }
    if rendered.chars().count()
        <= overflow_max_chars_from_env(
            AGENT_VM_TOOL_RESULT_MAX_CHARS_ENV,
            DEFAULT_AGENT_VM_TOOL_RESULT_MAX_CHARS,
        )
    {
        return Ok(value);
    }

    let Some(target) = resolve_agent_vm_overflow_target(arguments, rendered.as_str())? else {
        return Ok(value);
    };

    match spill_agent_vm_tool_result(tool_name, &target, rendered.as_str()).await {
        Ok(pointer) => success_text(pointer),
        Err(error) => {
            tracing::warn!(
                "failed to spill oversized Agent VM tool result for '{}': {error:#}",
                tool_name
            );
            Ok(value)
        }
    }
}

fn resolve_agent_vm_overflow_target(
    arguments: &Map<String, Value>,
    rendered: &str,
) -> Result<Option<AgentVmOverflowTarget>> {
    let response_payload = serde_json::from_str::<Value>(rendered).ok();
    let vm_id = arguments
        .get("vm_id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            response_payload
                .as_ref()
                .and_then(|payload| payload.get("vm_id"))
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    let chat_id = arguments
        .get("chat_id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            response_payload
                .as_ref()
                .and_then(|payload| payload.get("chat_id"))
                .and_then(Value::as_str)
                .map(str::to_string)
        });

    let Some(vm_id) = vm_id else {
        return Ok(None);
    };

    if let Some(vm) = load_vm_info(&vm_id)? {
        // A custom-workspace /work bind can live outside this process's
        // mounts; that must never fail the (already successful) tool call —
        // route the spill through the VM container instead.
        let sink = match resolve_local_work_bind_source(&vm) {
            Ok(root) => AgentVmOverflowSink::LocalRoot(root),
            Err(_) => AgentVmOverflowSink::Vm(vm.clone()),
        };
        return Ok(Some(AgentVmOverflowTarget {
            chat_id: vm.chat_id.clone(),
            vm_id: vm.vm_id.clone(),
            sink,
        }));
    }

    let Some(chat_id) = chat_id else {
        return Ok(None);
    };

    Ok(Some(AgentVmOverflowTarget {
        sink: AgentVmOverflowSink::LocalRoot(container_vm_workspace_root(&chat_id, &vm_id)?),
        chat_id,
        vm_id,
    }))
}

async fn spill_agent_vm_tool_result(
    tool_name: &str,
    target: &AgentVmOverflowTarget,
    rendered: &str,
) -> Result<Value> {
    let artifact = build_overflow_artifact(tool_name, rendered);
    match &target.sink {
        AgentVmOverflowSink::LocalRoot(local_work_root) => {
            let relative_path = artifact
                .path
                .strip_prefix("/work/")
                .unwrap_or_else(|| artifact.path.trim_start_matches('/'));
            let path = local_work_root.join(relative_path);
            fs::create_dir_all(path.parent().context("overflow file missing parent")?)?;

            let mut wrote_any = false;
            for chunk in utf8_chunks(rendered, overflow_write_chunk_bytes()) {
                write_agent_vm_overflow_chunk(&path, chunk, wrote_any)?;
                wrote_any = true;
            }
            if !wrote_any {
                write_agent_vm_overflow_chunk(&path, "", false)?;
            }
        }
        AgentVmOverflowSink::Vm(vm) => {
            // Same chunking as the host-side writer, but for a different
            // reason: each chunk rides docker exec as ONE base64 argv string,
            // and Linux caps a single argument at ~128KB (MAX_ARG_STRLEN).
            let mut wrote_any = false;
            for chunk in utf8_chunks(rendered, overflow_write_chunk_bytes()) {
                vm_write_bytes(vm, &artifact.path, chunk.as_bytes(), wrote_any).await?;
                wrote_any = true;
            }
            if !wrote_any {
                vm_write_bytes(vm, &artifact.path, b"", false).await?;
            }
        }
    }

    tracing::info!(
        "spilled oversized Agent VM result for chat {} vm {} to {} ({} chars)",
        target.chat_id,
        target.vm_id,
        artifact.path,
        artifact.char_count
    );

    Ok(artifact.pointer_payload(tool_name, &target.vm_id))
}

fn write_agent_vm_overflow_chunk(path: &Path, content: &str, append: bool) -> Result<()> {
    let mut file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append)
        .open(path)
        .with_context(|| format!("failed to open overflow file {}", path.display()))?;
    file.write_all(content.as_bytes())
        .with_context(|| format!("failed to write overflow file {}", path.display()))?;
    Ok(())
}

fn annotate_vm_dispatch_response(
    mut response: Value,
    vm_dispatch: Option<&VmDispatchContext>,
) -> Result<Value> {
    let Some(vm_dispatch) = vm_dispatch else {
        return Ok(response);
    };

    let Some(content) = response.get_mut("content").and_then(Value::as_array_mut) else {
        return Ok(response);
    };

    for item in content.iter_mut() {
        if item.get("type").and_then(Value::as_str) != Some("text") {
            continue;
        }
        let Some(text_value) = item.get_mut("text") else {
            continue;
        };
        let Some(text) = text_value.as_str() else {
            continue;
        };
        let Ok(mut payload) = serde_json::from_str::<Value>(text) else {
            continue;
        };
        let Some(object) = payload.as_object_mut() else {
            continue;
        };

        object.insert(
            "vm_id".to_string(),
            Value::String(vm_dispatch.effective_vm_id.clone()),
        );
        object.insert(
            "vm_id_changed".to_string(),
            Value::Bool(vm_dispatch.vm_id_changed()),
        );
        if let Some(chat_id) = &vm_dispatch.effective_chat_id {
            object
                .entry("chat_id".to_string())
                .or_insert_with(|| Value::String(chat_id.clone()));
        }
        if vm_dispatch.vm_id_changed() {
            object.insert(
                "requested_vm_id".to_string(),
                Value::String(vm_dispatch.requested_vm_id.clone()),
            );
            object.insert(
                "recovered_from_vm_id".to_string(),
                Value::String(vm_dispatch.requested_vm_id.clone()),
            );
            object.insert("recovered_automatically".to_string(), Value::Bool(true));
            object.insert(
                "vm_id_note".to_string(),
                Value::String(format!(
                    "A replacement Agent VM was used automatically. Use vm_id '{}' for subsequent Agent VM calls.",
                    vm_dispatch.effective_vm_id
                )),
            );
            match object.get("message").and_then(Value::as_str) {
                Some(message) if !message.contains("Use vm_id") => {
                    object.insert(
                        "message".to_string(),
                        Value::String(format!(
                            "{message} Use vm_id '{}' for subsequent Agent VM calls.",
                            vm_dispatch.effective_vm_id
                        )),
                    );
                }
                None => {
                    object.insert(
                        "message".to_string(),
                        Value::String(format!(
                            "Use vm_id '{}' for subsequent Agent VM calls.",
                            vm_dispatch.effective_vm_id
                        )),
                    );
                }
                _ => {}
            }
        } else {
            object.remove("requested_vm_id");
            object.remove("recovered_from_vm_id");
            object.remove("recovered_automatically");
            object.remove("vm_id_note");
        }

        *text_value = Value::String(serde_json::to_string_pretty(&payload)?);
    }

    Ok(response)
}

#[cfg(test)]
mod dispatcher_tests {
    use super::*;

    #[test]
    fn silent_vm_recovery_tool_allowlist_matches_expected_boundaries() {
        assert!(tool_supports_silent_vm_recovery("read_file"));
        assert!(tool_supports_silent_vm_recovery("grep"));
        assert!(tool_supports_silent_vm_recovery("list_workspace_files"));
        assert!(tool_supports_silent_vm_recovery(
            "request_sensitive_information"
        ));
        assert!(tool_supports_silent_vm_recovery("execute_skill_script"));
        assert!(!tool_supports_silent_vm_recovery("create"));
        assert!(!tool_supports_silent_vm_recovery("destroy"));
        assert!(!tool_supports_silent_vm_recovery("__missing_tool__"));
    }

    #[test]
    fn annotate_vm_dispatch_response_adds_recovery_metadata_only_to_json_text_items() {
        let response = json!({
            "content": [
                {"type": "image", "data": "abc", "mimeType": "image/png"},
                {"type": "text", "text": "plain text"},
                {"type": "text", "text": serde_json::to_string(&json!({
                    "success": true,
                    "message": "Recovered file."
                })).unwrap()}
            ],
            "structuredContent": Value::Null,
            "isError": false,
        });
        let context = VmDispatchContext {
            requested_vm_id: "vm-old".to_string(),
            effective_vm_id: "vm-new".to_string(),
            effective_chat_id: Some("chat-1".to_string()),
        };

        let annotated = annotate_vm_dispatch_response(response, Some(&context)).unwrap();
        let content = annotated["content"].as_array().unwrap();
        assert_eq!(content[0]["type"], json!("image"));
        assert_eq!(content[1]["text"], json!("plain text"));

        let payload: Value = serde_json::from_str(content[2]["text"].as_str().unwrap()).unwrap();
        assert_eq!(payload["vm_id"], json!("vm-new"));
        assert_eq!(payload["chat_id"], json!("chat-1"));
        assert_eq!(payload["requested_vm_id"], json!("vm-old"));
        assert_eq!(payload["recovered_from_vm_id"], json!("vm-old"));
        assert_eq!(payload["vm_id_changed"], json!(true));
        assert_eq!(payload["recovered_automatically"], json!(true));
        assert!(payload["vm_id_note"]
            .as_str()
            .unwrap()
            .contains("Use vm_id 'vm-new'"));
        assert!(payload["message"]
            .as_str()
            .unwrap()
            .contains("Use vm_id 'vm-new' for subsequent Agent VM calls."));
    }

    #[test]
    fn annotate_vm_dispatch_response_clears_recovery_fields_when_vm_id_is_unchanged() {
        let response = json!({
            "content": [{
                "type": "text",
                "text": serde_json::to_string(&json!({
                    "success": true,
                    "message": "Still current.",
                    "requested_vm_id": "vm-old",
                    "recovered_from_vm_id": "vm-old",
                    "recovered_automatically": true,
                    "vm_id_note": "stale"
                })).unwrap()
            }],
            "structuredContent": Value::Null,
            "isError": false,
        });
        let context = VmDispatchContext {
            requested_vm_id: "vm-1".to_string(),
            effective_vm_id: "vm-1".to_string(),
            effective_chat_id: Some("chat-1".to_string()),
        };

        let annotated = annotate_vm_dispatch_response(response, Some(&context)).unwrap();
        let payload: Value =
            serde_json::from_str(annotated["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(payload["vm_id"], json!("vm-1"));
        assert_eq!(payload["vm_id_changed"], json!(false));
        assert_eq!(payload["chat_id"], json!("chat-1"));
        assert!(payload.get("requested_vm_id").is_none());
        assert!(payload.get("recovered_from_vm_id").is_none());
        assert!(payload.get("recovered_automatically").is_none());
        assert!(payload.get("vm_id_note").is_none());
        assert_eq!(payload["message"], json!("Still current."));
    }

    #[test]
    fn tool_spec_descriptions_reference_prefixed_route_names() {
        let specs: Vec<Value> =
            serde_json::from_str(include_str!("../../tool_spec.json")).expect("tool spec JSON");

        let destroy_vm = specs
            .iter()
            .find(|spec| spec.get("name").and_then(Value::as_str) == Some("destroy"))
            .expect("destroy spec");
        let vm_id_description = destroy_vm["inputSchema"]["properties"]["vm_id"]["description"]
            .as_str()
            .expect("destroy vm_id description");
        assert!(vm_id_description.contains("agent_vm_create"));

        let batch = specs
            .iter()
            .find(|spec| spec.get("name").and_then(Value::as_str) == Some("create_files"))
            .expect("create_files spec");
        let description = batch["description"]
            .as_str()
            .expect("create_files description");
        assert!(description.contains("agent_vm_create_file"));

        let execute_skill_script = specs
            .iter()
            .find(|spec| spec.get("name").and_then(Value::as_str) == Some("execute_skill_script"))
            .expect("execute_skill_script spec");
        let create = specs
            .iter()
            .find(|spec| spec.get("name").and_then(Value::as_str) == Some("create"))
            .expect("create spec");
        let create_description = create["description"].as_str().expect("create description");
        assert!(create_description.contains("mounted writable at /work"));
        let description = execute_skill_script["description"]
            .as_str()
            .expect("execute_skill_script description");
        assert!(description.contains("inside the target Agent VM"));
        let vm_id_description = execute_skill_script["inputSchema"]["properties"]["vm_id"]
            ["description"]
            .as_str()
            .expect("execute_skill_script vm_id description");
        assert!(vm_id_description.contains("explicit Agent VM target"));
    }

    #[tokio::test]
    async fn dispatcher_routes_every_declared_tool() {
        let dispatcher = Dispatcher;
        let specs: Vec<Value> =
            serde_json::from_str(include_str!("../../tool_spec.json")).expect("tool spec JSON");

        for spec in specs {
            let tool_name = spec.get("name").and_then(Value::as_str).expect("tool name");
            let result = dispatcher.call(tool_name, &Map::new()).await;
            assert!(
                !matches!(result, Ok(None)),
                "dispatcher did not route declared tool {tool_name}"
            );
        }

        assert!(matches!(
            dispatcher
                .call("__missing_tool__", &Map::new())
                .await
                .unwrap(),
            None
        ));
    }
}
