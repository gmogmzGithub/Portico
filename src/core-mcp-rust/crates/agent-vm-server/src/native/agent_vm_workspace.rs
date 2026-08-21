use super::*;
use bollard::query_parameters::UploadToContainerOptionsBuilder;
use core_mcp_shared::app_support_dir;
use mime_guess::MimeGuess;
use regex::Regex;
use std::collections::{BTreeMap, HashSet};

const DEFAULT_FILE_MATCH_CONTEXT_CHARS: usize = 100;
const MAX_FILE_MATCH_CONTEXT_CHARS: usize = 1_000;
const DEFAULT_FILE_MATCHES_PER_PATTERN: usize = 25;
const MAX_FILE_MATCHES_PER_PATTERN: usize = 100;
const MAX_SKILL_ENV_FILE_BYTES: u64 = 64 * 1024;
const MAX_EXPLICIT_FILE_REQUESTS: usize = 20;
const SKILL_ENV_FILENAME: &str = "execute-skill-script.env";
const RESERVED_SKILL_ENV_KEYS: [&str; 3] = ["CHAT_ID", "VM_ID", "SKILL_NAME"];

fn resolve_skill_dir(skill_name: &str) -> Result<(std::path::PathBuf, String)> {
    if let Some(skill) = find_skill(skill_name)? {
        let canonical_skill_id = skill.name.clone();
        return Ok((std::path::PathBuf::from(skill.path), canonical_skill_id));
    }

    validate_skill_env_id(skill_name)
        .map_err(|_| anyhow::anyhow!("Skill directory not found: {skill_name}"))?;
    let requested = std::path::Path::new(skill_name);
    if requested.is_absolute()
        || requested
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        anyhow::bail!("Skill directory not found: {skill_name}");
    }

    let root = app_root()?;
    [
        root.join("skills").join(requested),
        root.join("skills-user").join(requested),
        root.join("skills-marketplace").join(requested),
    ]
    .into_iter()
    .find(|path| path.is_dir())
    .map(|path| (path, skill_name.to_string()))
    .ok_or_else(|| anyhow::anyhow!("Skill directory not found: {skill_name}"))
}

pub(crate) fn validate_skill_env_id(skill_id: &str) -> Result<Vec<String>> {
    if skill_id.is_empty()
        || skill_id.starts_with('/')
        || skill_id.contains('\\')
        || skill_id.contains("//")
    {
        anyhow::bail!("invalid skill id");
    }

    let mut segments = Vec::new();
    for segment in skill_id.split('/') {
        if segment.is_empty()
            || segment == "."
            || segment == ".."
            || segment.starts_with('.')
            || segment.starts_with('_')
            || !segment
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
        {
            anyhow::bail!("invalid skill id");
        }
        segments.push(segment.to_string());
    }
    Ok(segments)
}

pub(crate) fn scoped_skill_env_path(skill_id: &str) -> Result<std::path::PathBuf> {
    let mut path = app_support_dir()?.join("skill-env");
    for segment in validate_skill_env_id(skill_id)? {
        path.push(segment);
    }
    Ok(path.join(SKILL_ENV_FILENAME))
}

fn validate_skill_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    matches!(chars.next(), Some(ch) if ch == '_' || ch.is_ascii_alphabetic())
        && chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

fn parse_skill_env_value(line_number: usize, raw_value: &str) -> Result<String> {
    let value = raw_value.trim();
    if value.is_empty() {
        return Ok(String::new());
    }
    if value.as_bytes().contains(&0) {
        anyhow::bail!("invalid dotenv value on line {line_number}: NUL bytes are not allowed");
    }
    let Some(first) = value.chars().next() else {
        return Ok(String::new());
    };
    if first == '\'' || first == '"' {
        if !value.ends_with(first) || value.len() < 2 {
            anyhow::bail!("invalid quoted dotenv value on line {line_number}");
        }
        return Ok(value[1..value.len() - 1].to_string());
    }
    Ok(value.to_string())
}

pub(crate) fn parse_skill_env_contents(contents: &str) -> Result<Vec<(String, String)>> {
    let mut values = BTreeMap::new();
    for (index, line) in contents.lines().enumerate() {
        let line_number = index + 1;
        let mut trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("export ") {
            trimmed = rest.trim_start();
        }
        let Some((raw_key, raw_value)) = trimmed.split_once('=') else {
            anyhow::bail!("invalid dotenv entry on line {line_number}: expected KEY=VALUE");
        };
        let key = raw_key.trim();
        if !validate_skill_env_key(key) {
            anyhow::bail!("invalid dotenv key on line {line_number}: {key}");
        }
        if RESERVED_SKILL_ENV_KEYS
            .iter()
            .any(|reserved| reserved == &key)
        {
            continue;
        }
        values.insert(
            key.to_string(),
            parse_skill_env_value(line_number, raw_value)?,
        );
    }
    Ok(values.into_iter().collect())
}

pub(crate) fn load_scoped_skill_env(skill_id: &str) -> Result<Vec<(String, String)>> {
    let mut path = scoped_skill_env_path(skill_id)?;
    if !path.exists() {
        // Plugin-layout skills carry 3-segment ids ({mp}/{plugin}/{leaf});
        // env files saved before the layout migration live under the legacy
        // 2-segment scope ({mp}/{leaf}). Read that as a fallback so existing
        // configuration keeps applying after the id gains its plugin segment.
        let segments = validate_skill_env_id(skill_id)?;
        if segments.len() != 3 {
            return Ok(Vec::new());
        }
        let legacy_id = format!("{}/{}", segments[0], segments[2]);
        let legacy_path = scoped_skill_env_path(&legacy_id)?;
        if !legacy_path.exists() {
            return Ok(Vec::new());
        }
        path = legacy_path;
    }
    let metadata = fs::metadata(&path)
        .with_context(|| format!("failed to read skill env metadata: {}", path.display()))?;
    if !metadata.is_file() {
        anyhow::bail!("skill env path must be a regular file: {}", path.display());
    }
    if metadata.len() > MAX_SKILL_ENV_FILE_BYTES {
        anyhow::bail!(
            "skill env file is too large: {} exceeds {} bytes",
            path.display(),
            MAX_SKILL_ENV_FILE_BYTES
        );
    }
    let contents = fs::read_to_string(&path)
        .with_context(|| format!("failed to read skill env file: {}", path.display()))?;
    parse_skill_env_contents(&contents)
}

fn resolve_script_relative(script_name: &str) -> Result<std::path::PathBuf> {
    let script_relative = std::path::Path::new(script_name);
    if script_relative.is_absolute()
        || script_relative
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        anyhow::bail!("invalid script path");
    }

    if script_relative
        .components()
        .next()
        .and_then(|component| component.as_os_str().to_str())
        == Some("scripts")
    {
        Ok(script_relative.to_path_buf())
    } else {
        Ok(std::path::PathBuf::from("scripts").join(script_relative))
    }
}

async fn stage_skill_into_vm(
    vm: &VmInfo,
    skill_name: &str,
    skill_dir: &std::path::Path,
) -> Result<(String, std::path::PathBuf)> {
    let runtime_name = skill_name.replace('/', "__").replace('\\', "__");
    let staged_vm_dir = format!("/work/.skill_runtime/{runtime_name}");
    if fake_docker_enabled() {
        let host_runtime_root = vm_host_path(vm, &staged_vm_dir)?;
        if host_runtime_root.exists() {
            fs::remove_dir_all(&host_runtime_root)?;
        }
        copy_path(skill_dir, &host_runtime_root)?;
        return Ok((staged_vm_dir, host_runtime_root));
    }

    exec_argv_in_vm(
        vm,
        &[
            "sh".to_string(),
            "-lc".to_string(),
            format!(
                "mkdir -p /work/.skill_runtime && rm -rf {}",
                shell_quote(&staged_vm_dir)
            ),
        ],
    )
    .await?;
    upload_directory_to_vm(vm, skill_dir, "/work/.skill_runtime", &runtime_name).await?;
    Ok((staged_vm_dir, std::path::PathBuf::from(skill_dir)))
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

async fn upload_directory_to_vm(
    vm: &VmInfo,
    source_dir: &std::path::Path,
    container_parent: &str,
    archive_root_name: &str,
) -> Result<()> {
    let mut archive = Vec::new();
    {
        let mut builder = tar::Builder::new(&mut archive);
        builder.append_dir_all(archive_root_name, source_dir)?;
        builder.finish()?;
    }
    let docker = docker_client()?;
    let options = UploadToContainerOptionsBuilder::default()
        .path(container_parent)
        .build();
    docker
        .upload_to_container(
            &vm.container_id,
            Some(options),
            bollard::body_full(archive.into()),
        )
        .await
        .context("failed to upload skill runtime into Agent VM")?;
    Ok(())
}

async fn ensure_staged_script_visible(
    vm: &VmInfo,
    staged_vm_script: &str,
    host_staged_script: &std::path::Path,
) -> Result<()> {
    if !host_staged_script.exists() {
        anyhow::bail!(
            "staged skill script missing on workspace path: {}",
            host_staged_script.display()
        );
    }
    if fake_docker_enabled() {
        return Ok(());
    }
    for _ in 0..3 {
        let probe = exec_argv_in_vm(
            vm,
            &[
                "bash".to_string(),
                "-lc".to_string(),
                format!("test -f {staged_vm_script}"),
            ],
        )
        .await?;
        if probe.exit_code == 0 {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    anyhow::bail!("staged skill script not visible in VM at {staged_vm_script}");
}

pub async fn handle_copy_from_workspace(arguments: &Map<String, Value>) -> Result<Value> {
    let Some(vm_id) = arguments.get("vm_id").and_then(Value::as_str) else {
        return failure_response("vm_id and workspace_path are required");
    };
    let Some(workspace_path) = arguments.get("workspace_path").and_then(Value::as_str) else {
        return failure_response("vm_id and workspace_path are required");
    };
    let Some(vm) = load_vm_info(vm_id)? else {
        return success_text(json!({
            "success": false,
            "workspace_path": workspace_path,
            "vm_path": arguments.get("vm_path").and_then(Value::as_str).unwrap_or(workspace_path),
            "message": format!("Failed to copy {workspace_path} to VM"),
        }));
    };
    let source = match workspace_relative_path(&vm, &workspace_path) {
        Ok(source) => source,
        Err(error)
            if error
                .to_string()
                .starts_with("path points to a private VM workspace:") =>
        {
            return success_text(json!({
                "success": false,
                "workspace_path": workspace_path,
                "vm_path": arguments.get("vm_path").and_then(Value::as_str).unwrap_or(workspace_path),
                "error": error.to_string(),
            }))
        }
        Err(error) => return Err(error),
    };
    let vm_path = arguments
        .get("vm_path")
        .and_then(Value::as_str)
        .unwrap_or(workspace_path);
    if copy_path(&source, &vm_host_path(&vm, vm_path)?).is_err() {
        return success_text(json!({
            "success": false,
            "workspace_path": workspace_path,
            "vm_path": vm_path,
            "message": format!("Failed to copy {workspace_path} to VM"),
        }));
    }
    let _ = touch_vm_activity(vm.vm_id.as_str());
    success_text(
        json!({"success": true, "workspace_path": workspace_path, "vm_path": vm_path, "message": format!("Copied {workspace_path} to VM at {vm_path}")}),
    )
}

pub async fn handle_copy_to_workspace(arguments: &Map<String, Value>) -> Result<Value> {
    let Some(vm_id) = arguments.get("vm_id").and_then(Value::as_str) else {
        return failure_response("vm_id, vm_path, and workspace_path are required");
    };
    let Some(vm_path) = arguments.get("vm_path").and_then(Value::as_str) else {
        return failure_response("vm_id, vm_path, and workspace_path are required");
    };
    let Some(workspace_path) = arguments.get("workspace_path").and_then(Value::as_str) else {
        return failure_response("vm_id, vm_path, and workspace_path are required");
    };
    let Some(vm) = load_vm_info(vm_id)? else {
        return success_text(json!({
            "success": false,
            "error": format!("VM {vm_id} not found"),
        }));
    };
    let copied = match (
        vm_host_path(&vm, &vm_path),
        workspace_relative_path(&vm, &workspace_path),
    ) {
        (Ok(source), Ok(dest)) => copy_path(&source, &dest).is_ok(),
        (_, Err(error))
            if error
                .to_string()
                .starts_with("path points to a private VM workspace:") =>
        {
            return success_text(json!({
                "success": false,
                "vm_path": vm_path,
                "workspace_path": workspace_path,
                "error": error.to_string(),
            }));
        }
        _ => false,
    };
    if !copied {
        return success_text(json!({
            "success": false,
            "vm_path": vm_path,
            "workspace_path": workspace_path,
            "message": format!("Failed to copy {vm_path} from VM"),
        }));
    }
    let full_path = workspace_root_for_ids(&vm.chat_id, &vm.vm_id)?
        .join(sanitize_workspace_relative(workspace_path, false)?);
    if !full_path.exists() {
        return success_text(json!({
            "success": true,
            "vm_path": vm_path,
            "workspace_path": workspace_path,
            "message": format!("Copied {vm_path} but file not found at expected path"),
            "warning": "File may have been copied to a different location",
        }));
    }
    let _ = touch_vm_activity(vm.vm_id.as_str());
    workspace_file_payload(
        &vm,
        &workspace_path,
        &format!("Copied {vm_path} from VM to workspace."),
        Some(vm_path),
    )
}

pub async fn handle_list_workspace_files(arguments: &Map<String, Value>) -> Result<Value> {
    let Some(chat_id) = arguments.get("chat_id").and_then(Value::as_str) else {
        return failure_response("chat_id is required");
    };
    let path = arguments.get("path").and_then(Value::as_str).unwrap_or("");
    let recursive = bool_arg(arguments, "recursive", true);
    let relative = sanitize_workspace_relative(path, true)?;
    if private_workspace_root_segment(chat_id, &relative)?.is_some() {
        return success_text(
            json!({"success": true, "chat_id": chat_id, "path": relative, "recursive": recursive, "files": [], "count": 0}),
        );
    }
    let root = workspace_root_for_ids(chat_id, "")?;
    let target = if relative.is_empty() {
        root.clone()
    } else {
        let target = root.join(&relative);
        ensure_within(&root, &target)?;
        target
    };
    if !target.exists() {
        return success_text(
            json!({"success": true, "chat_id": chat_id, "path": relative, "recursive": recursive, "files": [], "count": 0}),
        );
    }
    let mut files = Vec::new();
    let private_vm_roots = live_vm_roots_for_chat(chat_id)?;
    if target.is_file() {
        let metadata = target.metadata()?;
        let file_name = target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_string();
        files.push(json!({
            "name": file_name,
            "path": relative,
            "kind": "file",
            "size": metadata.len(),
            "modified_time": metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs_f64())
                .unwrap_or(0.0),
            "size_formatted": if metadata.len() < 1024 {
                format!("{} bytes", metadata.len())
            } else {
                format!("{:.1} KB", metadata.len() as f64 / 1024.0)
            },
        }));
    } else {
        let walker = if recursive {
            WalkDir::new(&target).min_depth(1)
        } else {
            WalkDir::new(&target).min_depth(1).max_depth(1)
        };
        for entry in walker.into_iter().filter_map(|entry| entry.ok()) {
            let relative_path = entry
                .path()
                .strip_prefix(&root)
                .unwrap_or_else(|_| entry.path())
                .to_string_lossy()
                .replace(std::path::MAIN_SEPARATOR, "/");
            let first_segment = relative_path.split('/').next().unwrap_or_default();
            if relative_path.is_empty() || private_vm_roots.contains(first_segment) {
                continue;
            }
            let metadata = entry.metadata().ok();
            let size = metadata.as_ref().map(|meta| meta.len()).unwrap_or(0);
            let kind = if entry.file_type().is_dir() {
                "directory"
            } else {
                "file"
            };
            files.push(json!({
                "name": entry.file_name().to_string_lossy(),
                "path": relative_path,
                "kind": kind,
                "size": size,
                "modified_time": metadata
                    .as_ref()
                    .and_then(|meta| meta.modified().ok())
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| duration.as_secs_f64())
                    .unwrap_or(0.0),
                "size_formatted": if size < 1024 {
                    format!("{size} bytes")
                } else {
                    format!("{:.1} KB", size as f64 / 1024.0)
                },
            }));
        }
    }
    success_text(
        json!({"success": true, "chat_id": chat_id, "path": relative, "recursive": recursive, "files": files, "count": files.len()}),
    )
}

pub async fn handle_write_to_workspace(arguments: &Map<String, Value>) -> Result<Value> {
    let Some(chat_id) = arguments.get("chat_id").and_then(Value::as_str) else {
        return failure_response("chat_id is required");
    };
    let Some(path) = arguments.get("path").and_then(Value::as_str) else {
        return failure_response("path is required");
    };
    let relative_path = sanitize_workspace_relative(path, false)?;
    if let Some(vm_id) = private_workspace_root_segment(chat_id, &relative_path)? {
        return success_text(json!({
            "success": false,
            "error": format!("path points to a private VM workspace: {vm_id}"),
        }));
    }
    let file_path = workspace_root_for_ids(chat_id, "")?.join(&relative_path);
    fs::create_dir_all(
        file_path
            .parent()
            .context("workspace file missing parent")?,
    )?;
    let content = arguments
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let bytes = if bool_arg(arguments, "is_base64", false) {
        match BASE64_STANDARD.decode(content.as_bytes()) {
            Ok(bytes) => bytes,
            Err(error) => {
                return success_text(json!({
                    "success": false,
                    "error": format!("Invalid base64 content: {error}"),
                }))
            }
        }
    } else {
        content.into_bytes()
    };
    fs::write(&file_path, &bytes)?;
    success_text(json!({
        "success": true,
        "path": relative_path,
        "size": bytes.len(),
        "size_formatted": if bytes.len() < 1024 {
            format!("{} bytes", bytes.len())
        } else {
            format!("{:.1} KB", bytes.len() as f64 / 1024.0)
        },
        "chat_id": chat_id,
        "message": "File written successfully."
    }))
}

pub async fn handle_execute_skill_script(arguments: &Map<String, Value>) -> Result<Value> {
    let Some(skill_name) = arguments.get("skill_name").and_then(Value::as_str) else {
        return failure_response("skill_name and script_name are required");
    };
    let Some(script_name) = arguments.get("script_name").and_then(Value::as_str) else {
        return failure_response("skill_name and script_name are required");
    };
    let requested_chat_id = arguments.get("chat_id").and_then(Value::as_str);
    let requested_vm_id = arguments.get("vm_id").and_then(Value::as_str);
    let vm = if let Some(vm_id) = requested_vm_id {
        let Some(vm) = load_vm_info(vm_id)? else {
            return success_text(json!({
                "success": false,
                "exit_code": -1,
                "stdout": "",
                "stderr": "",
                "execution_time": 0.0,
                "skill_name": skill_name,
                "script_name": script_name,
                "vm_id": vm_id,
                "chat_id": requested_chat_id,
                "error": format!("No VM found with vm_id={vm_id}."),
            }));
        };
        if let Some(chat_id) = requested_chat_id {
            if vm.chat_id != chat_id {
                return success_text(json!({
                    "success": false,
                    "exit_code": -1,
                    "stdout": "",
                    "stderr": "",
                    "execution_time": 0.0,
                    "skill_name": skill_name,
                    "script_name": script_name,
                    "vm_id": vm.vm_id,
                    "chat_id": chat_id,
                    "error": format!("VM {} belongs to chat {}, not {}", vm.vm_id, vm.chat_id, chat_id),
                }));
            }
        }
        vm
    } else if let Some(chat_id) = requested_chat_id {
        let Some(vm) = load_default_vm_for_chat(chat_id)? else {
            return success_text(json!({
                "success": false,
                "exit_code": -1,
                "stdout": "",
                "stderr": "",
                "execution_time": 0.0,
                "skill_name": skill_name,
                "script_name": script_name,
                "chat_id": chat_id,
                "error": format!("No default Agent VM found for chat_id={chat_id}. Pass vm_id explicitly or create one first with agent_vm_create."),
            }));
        };
        vm
    } else {
        return failure_response("vm_id or chat_id is required");
    };
    let args = array_strings(arguments.get("args"));
    let timeout_seconds = int_arg(arguments, "timeout_seconds", 300).clamp(1, 600) as u64;
    let (skill_dir, canonical_skill_id) = match resolve_skill_dir(skill_name) {
        Ok(resolved) => resolved,
        Err(_) => {
            return success_text(json!({
                "success": false,
                "exit_code": -1,
                "stdout": "",
                "stderr": "",
                "execution_time": 0.0,
                "skill_name": skill_name,
                "script_name": script_name,
                "vm_id": vm.vm_id,
                "chat_id": vm.chat_id,
                "error": format!("Skill directory not found: {skill_name}"),
            }));
        }
    };
    let scoped_env = match load_scoped_skill_env(&canonical_skill_id) {
        Ok(values) => values,
        Err(error) => {
            return success_text(json!({
                "success": false,
                "exit_code": -1,
                "stdout": "",
                "stderr": "",
                "execution_time": 0.0,
                "skill_name": skill_name,
                "script_name": script_name,
                "vm_id": vm.vm_id,
                "chat_id": vm.chat_id,
                "error": format!("Failed to load skill env for {canonical_skill_id}: {error}"),
            }));
        }
    };
    let script_relative = match resolve_script_relative(script_name) {
        Ok(path) => path,
        Err(_) => {
            return success_text(json!({
                "success": false,
                "exit_code": -1,
                "stdout": "",
                "stderr": "",
                "execution_time": 0.0,
                "skill_name": skill_name,
                "script_name": script_name,
                "vm_id": vm.vm_id,
                "chat_id": vm.chat_id,
                "error": format!("Script not found: {skill_name}/{script_name}"),
            }));
        }
    };
    let script_path = skill_dir.join(&script_relative);
    if !script_path.exists() {
        return success_text(json!({
            "success": false,
            "exit_code": -1,
            "stdout": "",
            "stderr": "",
            "execution_time": 0.0,
            "skill_name": skill_name,
            "script_name": script_name,
            "vm_id": vm.vm_id,
            "chat_id": vm.chat_id,
            "error": format!("Script not found: {skill_name}/{script_name}"),
        }));
    }
    let script_relative_display = script_relative
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/");
    let (staged_vm_dir, host_runtime_root) =
        stage_skill_into_vm(&vm, skill_name, &skill_dir).await?;
    let staged_vm_script = format!("{staged_vm_dir}/{script_relative_display}");
    let host_staged_script = host_runtime_root.join(&script_relative);
    if let Err(error) =
        ensure_staged_script_visible(&vm, &staged_vm_script, &host_staged_script).await
    {
        return success_text(json!({
            "success": false,
            "exit_code": -1,
            "stdout": "",
            "stderr": "",
            "execution_time": 0.0,
            "skill_name": skill_name,
            "script_name": script_name,
            "vm_id": vm.vm_id,
            "chat_id": vm.chat_id,
            "error": format!("Failed to stage skill script: {error}"),
        }));
    }
    let mut command = vec!["env".to_string()];
    command.extend(
        scoped_env
            .into_iter()
            .map(|(key, value)| format!("{key}={value}")),
    );
    command.extend([
        format!("CHAT_ID={}", vm.chat_id),
        format!("VM_ID={}", vm.vm_id),
        format!("SKILL_NAME={canonical_skill_id}"),
        "python3".to_string(),
        staged_vm_script,
    ]);
    command.extend(args.clone());
    let started = std::time::Instant::now();
    let output = match tokio::time::timeout(
        std::time::Duration::from_secs(timeout_seconds),
        exec_argv_in_vm(&vm, &command),
    )
    .await
    {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            return success_text(json!({
                "success": false,
                "exit_code": -1,
                "stdout": "",
                "stderr": "",
                "execution_time": (started.elapsed().as_secs_f64() * 100.0).round() / 100.0,
                "skill_name": skill_name,
                "script_name": script_name,
                "vm_id": vm.vm_id,
                "chat_id": vm.chat_id,
                "error": format!("Execution failed: {error}"),
            }))
        }
        Err(_) => {
            return success_text(json!({
                "success": false,
                "exit_code": -1,
                "stdout": "",
                "stderr": "",
                "execution_time": (started.elapsed().as_secs_f64() * 100.0).round() / 100.0,
                "skill_name": skill_name,
                "script_name": script_name,
                "vm_id": vm.vm_id,
                "chat_id": vm.chat_id,
                "error": "Execution failed: timed out",
            }))
        }
    };
    let exit_code = output.exit_code;
    let stdout = output.stdout;
    let stderr = output.stderr;
    let mut response = json!({
        "success": exit_code == 0,
        "exit_code": exit_code,
        "stdout": stdout,
        "stderr": stderr,
        "execution_time": (started.elapsed().as_secs_f64() * 100.0).round() / 100.0,
        "skill_name": skill_name,
        "script_name": script_name,
        "vm_id": vm.vm_id,
        "chat_id": vm.chat_id,
    });
    if exit_code != 0 {
        response["error"] =
            Value::String(response["stderr"].as_str().unwrap_or_default().to_string());
    }
    let _ = touch_vm_activity(vm.vm_id.as_str());
    success_text(response)
}

pub async fn handle_get_workspace_file_link(arguments: &Map<String, Value>) -> Result<Value> {
    let Some(vm_id) = arguments.get("vm_id").and_then(Value::as_str) else {
        return failure_response("vm_id and file_path are required");
    };
    let Some(file_path) = arguments.get("file_path").and_then(Value::as_str) else {
        return failure_response("vm_id and file_path are required");
    };
    let Some(vm) = load_vm_info(vm_id)? else {
        return failure_response(format!("No VM found with vm_id={vm_id}"));
    };
    let normalized = normalize_vm_path(file_path);
    if !(normalized == "/work" || normalized.starts_with("/work/")) {
        return failure_response("file_path must be within /work");
    }
    let relative = normalized
        .trim_start_matches("/work")
        .trim_start_matches('/');
    if is_sensitive_workspace_relative_path(relative) {
        return failure_response("Sensitive workspace files cannot be linked or displayed directly. Use code execution to consume the file without printing its contents.");
    }
    let stat = match vm_stat(&vm, &normalized).await {
        Ok(stat) => stat,
        Err(_) => return not_found_workspace_file_payload(&vm.chat_id, relative),
    };
    if !stat.get("exists").and_then(Value::as_bool).unwrap_or(false) {
        return not_found_workspace_file_payload(&vm.chat_id, relative);
    }
    if stat.get("is_dir").and_then(Value::as_bool).unwrap_or(false) {
        return directory_workspace_file_payload(relative);
    }
    workspace_link_payload_from_stat(&vm.chat_id, &vm.vm_id, relative, &stat)
}

fn requested_workspace_file_paths(arguments: &Map<String, Value>) -> Result<Vec<String>> {
    let Some(file_paths) = arguments.get("file_paths").and_then(Value::as_array) else {
        anyhow::bail!("vm_id and file_paths are required");
    };
    if file_paths.is_empty() {
        anyhow::bail!("file_paths must contain at least one path");
    }
    if file_paths.len() > MAX_EXPLICIT_FILE_REQUESTS {
        anyhow::bail!(
            "file_paths may contain at most {} paths",
            MAX_EXPLICIT_FILE_REQUESTS
        );
    }

    file_paths
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| anyhow::anyhow!("file_paths must contain only strings"))
        })
        .collect()
}

async fn workspace_file_record(
    vm: &VmInfo,
    requested_path: &str,
    require_inline_image: bool,
) -> Result<Value> {
    let normalized = normalize_vm_path(requested_path);
    if !(normalized.starts_with("/work/")) {
        anyhow::bail!("file_paths must be within /work");
    }
    let relative = normalized
        .trim_start_matches("/work")
        .trim_start_matches('/');
    if relative.is_empty() {
        anyhow::bail!("file_paths must reference files under /work");
    }
    if is_sensitive_workspace_relative_path(relative) {
        anyhow::bail!("Sensitive workspace files cannot be linked or displayed directly. Use code execution to consume the file without printing its contents.");
    }

    let stat = vm_stat(vm, &normalized).await.with_context(|| {
        format!(
            "file does not exist: {}",
            if requested_path.is_empty() {
                normalized.as_str()
            } else {
                requested_path
            }
        )
    })?;
    if !stat.get("exists").and_then(Value::as_bool).unwrap_or(false) {
        anyhow::bail!("file does not exist: {requested_path}");
    }
    if stat.get("is_dir").and_then(Value::as_bool).unwrap_or(false) {
        anyhow::bail!("path is a directory, not a file: {requested_path}");
    }

    let file_name = std::path::Path::new(relative)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(relative)
        .to_string();
    let file_size = stat.get("size").and_then(Value::as_u64).unwrap_or(0);
    let mime_type = MimeGuess::from_path(relative)
        .first_raw()
        .unwrap_or("application/octet-stream")
        .to_string();
    let is_image = mime_type.starts_with("image/");
    if require_inline_image {
        if !is_image {
            anyhow::bail!("request_images only accepts image files: {requested_path}");
        }
        if file_size > MAX_INLINE_IMAGE_SIZE {
            anyhow::bail!(
                "image file is too large for model input: {requested_path} exceeds {} bytes",
                MAX_INLINE_IMAGE_SIZE
            );
        }
    }

    let download_url = workspace_download_url(&vm.chat_id, relative)?;
    let browser_url = workspace_browser_url(&vm.chat_id, relative, is_image)?;
    let model_image_url = if require_inline_image {
        Some(workspace_model_image_url(&vm.chat_id, relative)?)
    } else {
        None
    };
    Ok(json!({
        "file_name": file_name,
        "file_path": relative,
        "vm_path": format!("/work/{relative}"),
        "file_size": file_size,
        "file_size_formatted": format_bytes(file_size),
        "chat_id": vm.chat_id,
        "vm_id": vm.vm_id,
        "mime_type": mime_type,
        "is_image": is_image,
        "download_url": download_url,
        "browser_url": browser_url,
        "url": browser_url,
        "model_image_url": model_image_url.map(Value::String).unwrap_or(Value::Null),
    }))
}

async fn workspace_file_records(
    arguments: &Map<String, Value>,
    require_inline_image: bool,
) -> Result<(VmInfo, Vec<Value>)> {
    let Some(vm_id) = arguments.get("vm_id").and_then(Value::as_str) else {
        anyhow::bail!("vm_id and file_paths are required");
    };
    let Some(vm) = load_vm_info(vm_id)? else {
        anyhow::bail!("No VM found with vm_id={vm_id}");
    };
    let paths = requested_workspace_file_paths(arguments)?;
    let mut records = Vec::with_capacity(paths.len());
    for path in paths {
        records.push(workspace_file_record(&vm, &path, require_inline_image).await?);
    }
    Ok((vm, records))
}

pub async fn handle_display_files(arguments: &Map<String, Value>) -> Result<Value> {
    match workspace_file_records(arguments, false).await {
        Ok((vm, files)) => {
            let _ = touch_vm_activity(vm.vm_id.as_str());
            success_text(json!({
                "success": true,
                "display_files": true,
                "chat_id": vm.chat_id,
                "vm_id": vm.vm_id,
                "files": files,
                "message": "Files are ready for inline display in the chat."
            }))
        }
        Err(error) => failure_response(error.to_string()),
    }
}

pub async fn handle_request_images(arguments: &Map<String, Value>) -> Result<Value> {
    match workspace_file_records(arguments, true).await {
        Ok((vm, images)) => {
            let _ = touch_vm_activity(vm.vm_id.as_str());
            success_text(json!({
                "success": true,
                "request_images": true,
                "chat_id": vm.chat_id,
                "vm_id": vm.vm_id,
                "images": images,
                "message": "Image URLs are ready to attach to the immediate next model request. This tool does not display files to the user."
            }))
        }
        Err(error) => failure_response(error.to_string()),
    }
}

fn unsafe_archive_path_response(error: &UnsafeArchivePathError) -> Result<Value> {
    success_text(json!({
        "success": false,
        "error_code": UNSAFE_ARCHIVE_PATH_ERROR_CODE,
        "unsafe_member": error.member(),
        "error": "Archive contains an unsafe member path.",
    }))
}

pub async fn handle_unzip_file(arguments: &Map<String, Value>) -> Result<Value> {
    let Some(vm_id) = arguments.get("vm_id").and_then(Value::as_str) else {
        return failure_response("vm_id and zip_path are required");
    };
    let Some(zip_path_arg) = arguments.get("zip_path").and_then(Value::as_str) else {
        return failure_response("vm_id and zip_path are required");
    };
    let Some(vm) = load_vm_info(vm_id)? else {
        return failure_response(format!("No VM found with vm_id={vm_id}"));
    };
    let dest = arguments
        .get("dest_path")
        .and_then(Value::as_str)
        .unwrap_or("/work");
    let strip_components = int_arg(arguments, "strip_components", 0).max(0) as usize;
    let extracted = match unzip_file_in_vm(&vm, zip_path_arg, dest, strip_components).await {
        Ok(value) => value,
        Err(error) => {
            if let Some(unsafe_path) = error.downcast_ref::<UnsafeArchivePathError>() {
                return unsafe_archive_path_response(unsafe_path);
            }
            return failure_response(format!("Extraction failed: {error}"));
        }
    };
    let files_extracted = extracted
        .get("files_extracted")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let zip_path = extracted
        .get("zip_path")
        .and_then(Value::as_str)
        .unwrap_or(zip_path_arg);
    let dest_path = extracted
        .get("dest_path")
        .and_then(Value::as_str)
        .unwrap_or(dest);
    let _ = touch_vm_activity(vm_id);
    success_text(json!({
        "success": true,
        "zip_path": zip_path,
        "dest_path": dest_path,
        "files_extracted": files_extracted.to_string(),
        "top_level_files": extracted.get("top_level_files").cloned().unwrap_or_else(|| json!([])),
        "top_level_directories": extracted.get("top_level_directories").cloned().unwrap_or_else(|| json!([])),
        "message": format!(
            "Successfully extracted {files_extracted} files to {}",
            dest_path
        ),
    }))
}

pub async fn handle_find_files(arguments: &Map<String, Value>) -> Result<Value> {
    let Some(vm_id) = arguments.get("vm_id").and_then(Value::as_str) else {
        return failure_response("vm_id and pattern are required");
    };
    let Some(pattern_raw) = arguments.get("pattern").and_then(Value::as_str) else {
        return failure_response("vm_id and pattern are required");
    };
    let Some(vm) = load_vm_info(vm_id)? else {
        return failure_response(format!("No VM found with vm_id={vm_id}"));
    };
    if let Err(error) = Pattern::new(pattern_raw) {
        return failure_response(error.to_string());
    }
    let search_root = arguments
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or("/work");
    let normalized_root = normalize_vm_path(search_root);
    let max_results = int_arg(arguments, "max_results", 100).max(1) as usize;
    if !fake_docker_enabled() {
        let found = match find_files_in_vm(&vm, pattern_raw, &normalized_root, max_results).await {
            Ok(value) => value,
            Err(error) => return failure_response(error.to_string()),
        };
        let files = found
            .get("files")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let count = files.len();
        let truncated = found
            .get("truncated")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let _ = touch_vm_activity(vm_id);
        return success_text(
            json!({"success": true, "pattern": pattern_raw, "path": normalized_root, "files": files, "count": count, "truncated": truncated }),
        );
    }
    let pattern = Pattern::new(pattern_raw).unwrap();
    let root = match vm_host_path(&vm, normalized_root.as_str()) {
        Ok(path) => path,
        Err(error) => return failure_response(error.to_string()),
    };
    let mut matches = WalkDir::new(&root)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
        .filter(|entry| pattern.matches_path(entry.path()))
        .map(|entry| entry.path().to_path_buf())
        .collect::<Vec<_>>();
    matches.sort_by_key(|path| {
        path.metadata()
            .and_then(|meta| meta.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH)
    });
    matches.reverse();
    let truncated = matches.len() >= max_results;
    let files = matches
        .into_iter()
        .take(max_results)
        .filter_map(|path| vm_path_string(&vm, &path).ok())
        .collect::<Vec<_>>();
    let _ = touch_vm_activity(vm_id);
    success_text(
        json!({"success": true, "pattern": pattern.as_str(), "path": normalized_root, "files": files.clone(), "count": files.len(), "truncated": truncated }),
    )
}

pub async fn handle_grep(arguments: &Map<String, Value>) -> Result<Value> {
    let Some(vm_id) = arguments.get("vm_id").and_then(Value::as_str) else {
        return failure_response("vm_id and pattern are required");
    };
    let Some(pattern) = arguments.get("pattern").and_then(Value::as_str) else {
        return failure_response("vm_id and pattern are required");
    };
    let Some(vm) = load_vm_info(vm_id)? else {
        return failure_response(format!("No VM found with vm_id={vm_id}"));
    };
    let regex = match regex::RegexBuilder::new(pattern)
        .case_insensitive(bool_arg(arguments, "case_insensitive", false))
        .build()
    {
        Ok(regex) => regex,
        Err(error) => return failure_response(error.to_string()),
    };
    let search_root = arguments
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or("/work");
    let normalized_root = normalize_vm_path(search_root);
    let file_pattern = arguments
        .get("file_pattern")
        .and_then(Value::as_str)
        .and_then(|pattern| Pattern::new(pattern).ok());
    let max_results = int_arg(arguments, "max_results", 50).max(1) as usize;
    let context_lines = int_arg(arguments, "context_lines", 0).max(0) as usize;
    let output_mode = arguments
        .get("output_mode")
        .and_then(Value::as_str)
        .unwrap_or("content");
    if !fake_docker_enabled() {
        let response = match grep_in_vm(
            &vm,
            pattern,
            &normalized_root,
            arguments.get("file_pattern").and_then(Value::as_str),
            max_results,
            bool_arg(arguments, "case_insensitive", false),
            output_mode,
        )
        .await
        {
            Ok(value) => value,
            Err(error) => return failure_response(error.to_string()),
        };
        let _ = touch_vm_activity(vm_id);
        return success_text(match output_mode {
            "files" => json!({
                "success": true,
                "pattern": regex.as_str(),
                "path": normalized_root,
                "files": response.get("files").cloned().unwrap_or_else(|| json!([])),
                "count": response.get("files").and_then(Value::as_array).map(|items| items.len()).unwrap_or(0),
            }),
            "count" => json!({
                "success": true,
                "pattern": regex.as_str(),
                "counts": response.get("counts").cloned().unwrap_or_else(|| json!({})),
                "total": response.get("total_matches").and_then(Value::as_u64).unwrap_or(0),
            }),
            _ => json!({
                "success": true,
                "pattern": regex.as_str(),
                "path": normalized_root,
                "matches": response.get("matches").cloned().unwrap_or_else(|| json!([])),
                "count": response.get("matches").and_then(Value::as_array).map(|items| items.len()).unwrap_or(0),
                "truncated": response.get("truncated").and_then(Value::as_bool).unwrap_or(false),
            }),
        });
    }
    let root = match vm_host_path(&vm, normalized_root.as_str()) {
        Ok(path) => path,
        Err(error) => return failure_response(error.to_string()),
    };
    let mut matches = Vec::new();
    let mut files = Vec::new();
    let mut counts = Map::new();
    let mut total = 0usize;
    for entry in WalkDir::new(&root)
        .into_iter()
        .filter_map(|entry| entry.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        if let Some(file_pattern) = &file_pattern {
            if !file_pattern.matches_path(entry.path()) {
                continue;
            }
        }
        let Ok(content) = fs::read_to_string(entry.path()) else {
            continue;
        };
        let match_count = regex.find_iter(&content).count();
        if match_count == 0 {
            continue;
        }
        let path = vm_path_string(&vm, entry.path())
            .unwrap_or_else(|_| entry.path().display().to_string());
        total += match_count;
        match output_mode {
            "files" => files.push(path),
            "count" => {
                counts.insert(path, Value::from(match_count as i64));
            }
            _ => {
                let lines = content.lines().collect::<Vec<_>>();
                let mut matched_lines = Vec::new();
                for (index, line) in lines.iter().enumerate() {
                    if !regex.is_match(line) {
                        continue;
                    }
                    let start = index.saturating_sub(context_lines);
                    let end = (index + context_lines + 1).min(lines.len());
                    for line_index in start..end {
                        let separator = if line_index == index { ':' } else { '-' };
                        matched_lines.push(format!(
                            "{path}{separator}{}{separator}{}",
                            line_index + 1,
                            lines[line_index]
                        ));
                    }
                }
                matches.extend(matched_lines);
            }
        }
        if matches.len() >= max_results || files.len() >= max_results {
            break;
        }
    }
    let match_lines = matches
        .iter()
        .take(max_results)
        .cloned()
        .collect::<Vec<_>>();
    let _ = touch_vm_activity(vm_id);
    success_text(match output_mode {
        "files" => {
            json!({"success": true, "pattern": regex.as_str(), "path": normalized_root, "files": files.clone(), "count": files.len()})
        }
        "count" => {
            json!({"success": true, "pattern": regex.as_str(), "counts": counts, "total": total})
        }
        _ => {
            json!({"success": true, "pattern": regex.as_str(), "path": normalized_root, "matches": match_lines.clone(), "count": match_lines.len(), "truncated": matches.len() >= max_results})
        }
    })
}

pub async fn handle_grep_file(arguments: &Map<String, Value>) -> Result<Value> {
    let Some(vm_id) = arguments.get("vm_id").and_then(Value::as_str) else {
        return failure_response("vm_id, path, and patterns are required");
    };
    let Some(requested_path) = arguments.get("path").and_then(Value::as_str) else {
        return failure_response("vm_id, path, and patterns are required");
    };
    let Some(raw_patterns) = arguments.get("patterns").and_then(Value::as_array) else {
        return failure_response("vm_id, path, and patterns are required");
    };
    if raw_patterns.is_empty() {
        return failure_response("vm_id, path, and patterns are required");
    }

    let mut patterns = Vec::new();
    let mut seen_patterns = HashSet::new();
    for (index, value) in raw_patterns.iter().enumerate() {
        let Some(pattern) = value.as_str() else {
            return failure_response(format!("patterns[{index}] must be a string"));
        };
        if pattern.is_empty() {
            return failure_response(format!("patterns[{index}] must not be empty"));
        }
        if seen_patterns.insert(pattern.to_string()) {
            patterns.push(pattern.to_string());
        }
    }

    let match_mode = arguments
        .get("match_mode")
        .and_then(Value::as_str)
        .unwrap_or("literal");
    if !matches!(match_mode, "literal" | "regex") {
        return failure_response("match_mode must be either 'literal' or 'regex'");
    }

    let case_insensitive = bool_arg(arguments, "case_insensitive", false);
    let before_chars = int_arg(
        arguments,
        "before_chars",
        DEFAULT_FILE_MATCH_CONTEXT_CHARS as i64,
    )
    .max(0)
    .min(MAX_FILE_MATCH_CONTEXT_CHARS as i64) as usize;
    let after_chars = int_arg(
        arguments,
        "after_chars",
        DEFAULT_FILE_MATCH_CONTEXT_CHARS as i64,
    )
    .max(0)
    .min(MAX_FILE_MATCH_CONTEXT_CHARS as i64) as usize;
    let max_results_per_pattern = int_arg(
        arguments,
        "max_results_per_pattern",
        DEFAULT_FILE_MATCHES_PER_PATTERN as i64,
    )
    .max(1)
    .min(MAX_FILE_MATCHES_PER_PATTERN as i64) as usize;

    let Some(vm) = load_vm_info(vm_id)? else {
        return success_text(json!({
            "success": false,
            "path": requested_path,
            "error": format!("Failed to read file or file not found: {requested_path}"),
        }));
    };

    let normalized_path = normalize_vm_path(requested_path);
    let stat = match vm_stat(&vm, normalized_path.as_str()).await {
        Ok(stat) => stat,
        Err(_) => {
            return success_text(json!({
                "success": false,
                "path": requested_path,
                "error": format!("Failed to read file or file not found: {requested_path}"),
            }))
        }
    };
    if !stat.get("exists").and_then(Value::as_bool).unwrap_or(false) {
        return success_text(json!({
            "success": false,
            "path": requested_path,
            "error": format!("Failed to read file or file not found: {requested_path}"),
        }));
    }
    if stat.get("is_dir").and_then(Value::as_bool).unwrap_or(false) {
        return success_text(json!({
            "success": false,
            "path": requested_path,
            "error": format!("Path is a directory, not a file: {}", normalized_path),
        }));
    }

    let compiled_patterns =
        match compile_file_match_patterns(&patterns, match_mode, case_insensitive) {
            Ok(compiled) => compiled,
            Err(error) => return failure_response(error),
        };

    let content = match vm_read_bytes(&vm, normalized_path.as_str()).await {
        Ok((_path, bytes)) => match String::from_utf8(bytes) {
            Ok(content) => content,
            Err(_) => {
                return success_text(json!({
                    "success": false,
                    "path": requested_path,
                    "error": "File appears to be binary or uses unsupported encoding",
                }));
            }
        },
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

    let char_boundaries = char_boundaries(&content);
    let total_chars = char_boundaries.len().saturating_sub(1);
    let mut matched_any = false;
    let mut results_by_pattern = Map::new();

    for (pattern, regex) in compiled_patterns {
        let mut total_matches = 0usize;
        let mut matches = Vec::new();
        for found in regex.find_iter(&content) {
            total_matches += 1;
            if matches.len() >= max_results_per_pattern {
                continue;
            }

            let start_offset_chars = byte_offset_to_char_offset(&char_boundaries, found.start());
            let end_offset_chars = byte_offset_to_char_offset(&char_boundaries, found.end());
            let excerpt_start_offset_chars = start_offset_chars.saturating_sub(before_chars);
            let excerpt_end_offset_chars = end_offset_chars
                .saturating_add(after_chars)
                .min(total_chars);

            matches.push(json!({
                "start_offset_chars": start_offset_chars,
                "end_offset_chars": end_offset_chars,
                "excerpt_start_offset_chars": excerpt_start_offset_chars,
                "excerpt_end_offset_chars": excerpt_end_offset_chars,
                "before": slice_text_from_boundaries(
                    &content,
                    &char_boundaries,
                    excerpt_start_offset_chars,
                    start_offset_chars,
                ),
                "match": slice_text_from_boundaries(
                    &content,
                    &char_boundaries,
                    start_offset_chars,
                    end_offset_chars,
                ),
                "after": slice_text_from_boundaries(
                    &content,
                    &char_boundaries,
                    end_offset_chars,
                    excerpt_end_offset_chars,
                ),
            }));
        }

        if total_matches > 0 {
            matched_any = true;
        }
        results_by_pattern.insert(
            pattern,
            json!({
                "total_matches": total_matches,
                "returned_matches": matches.len(),
                "truncated": total_matches > matches.len(),
                "matches": matches,
            }),
        );
    }

    register_file_read(vm.vm_id.as_str(), normalized_path.as_str())?;
    let _ = touch_vm_activity(vm.vm_id.as_str());
    success_text(json!({
        "success": true,
        "path": normalized_path,
        "total_chars": total_chars,
        "match_mode": match_mode,
        "case_insensitive": case_insensitive,
        "before_chars": before_chars,
        "after_chars": after_chars,
        "max_results_per_pattern": max_results_per_pattern,
        "matched_any": matched_any,
        "results_by_pattern": results_by_pattern,
    }))
}

fn compile_file_match_patterns(
    patterns: &[String],
    match_mode: &str,
    case_insensitive: bool,
) -> std::result::Result<Vec<(String, Regex)>, String> {
    patterns
        .iter()
        .map(|pattern| {
            let source = if match_mode == "literal" {
                regex::escape(pattern)
            } else {
                pattern.clone()
            };
            regex::RegexBuilder::new(source.as_str())
                .case_insensitive(case_insensitive)
                .build()
                .map(|regex| (pattern.clone(), regex))
                .map_err(|error| format!("Invalid {match_mode} pattern '{pattern}': {error}"))
        })
        .collect()
}

fn char_boundaries(content: &str) -> Vec<usize> {
    if content.is_empty() {
        return vec![0];
    }
    let mut boundaries = vec![0];
    for (index, _) in content.char_indices().skip(1) {
        boundaries.push(index);
    }
    boundaries.push(content.len());
    boundaries
}

fn byte_offset_to_char_offset(char_boundaries: &[usize], byte_offset: usize) -> usize {
    char_boundaries
        .binary_search(&byte_offset)
        .unwrap_or_else(|index| index)
}

fn slice_text_from_boundaries<'a>(
    content: &'a str,
    char_boundaries: &[usize],
    start_offset_chars: usize,
    end_offset_chars: usize,
) -> &'a str {
    if start_offset_chars >= end_offset_chars || start_offset_chars >= char_boundaries.len() {
        return "";
    }

    let safe_end = end_offset_chars.min(char_boundaries.len().saturating_sub(1));
    if start_offset_chars >= safe_end {
        return "";
    }

    &content[char_boundaries[start_offset_chars]..char_boundaries[safe_end]]
}

#[cfg(test)]
mod search_file_match_helper_tests {
    use super::*;

    #[test]
    fn helper_functions_handle_unicode_boundaries_and_empty_content() {
        let content = "a😀bé";
        let boundaries = char_boundaries(content);
        assert_eq!(boundaries, vec![0, 1, 5, 6, 8]);
        assert_eq!(byte_offset_to_char_offset(&boundaries, 0), 0);
        assert_eq!(byte_offset_to_char_offset(&boundaries, 1), 1);
        assert_eq!(byte_offset_to_char_offset(&boundaries, 5), 2);
        assert_eq!(byte_offset_to_char_offset(&boundaries, 6), 3);
        assert_eq!(byte_offset_to_char_offset(&boundaries, 8), 4);

        assert_eq!(
            slice_text_from_boundaries(content, &boundaries, 1, 3),
            "😀b"
        );
        assert_eq!(slice_text_from_boundaries(content, &boundaries, 3, 4), "é");
        assert_eq!(slice_text_from_boundaries(content, &boundaries, 4, 4), "");

        let empty_boundaries = char_boundaries("");
        assert_eq!(empty_boundaries, vec![0]);
        assert_eq!(slice_text_from_boundaries("", &empty_boundaries, 0, 1), "");
    }

    #[test]
    fn compile_patterns_distinguishes_literal_and_regex_modes() {
        let patterns = vec!["a.c".to_string()];

        let literal = compile_file_match_patterns(&patterns, "literal", false).unwrap();
        assert_eq!(literal[0].1.find_iter("a.c abc").count(), 1);

        let regex = compile_file_match_patterns(&patterns, "regex", false).unwrap();
        assert_eq!(regex[0].1.find_iter("a.c abc").count(), 2);

        let case_insensitive =
            compile_file_match_patterns(&["beta".to_string()], "literal", true).unwrap();
        assert!(case_insensitive[0].1.is_match("BETA"));
    }
}
