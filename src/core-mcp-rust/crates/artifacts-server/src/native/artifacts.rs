use super::*;
use std::io::Write;

const STATUS_RUNNING: &str = "running";
const STATUS_STOPPED: &str = "stopped";
const ARTIFACT_PORT_START: i64 = 10_000;
const ARTIFACT_PORT_RANGE: i64 = 10_000;
const BROWSER_UNSAFE_PORTS: &[u16] = &[10080];
const MAX_VERSION_NOTE_LEN: usize = 50;
const DISK_STATE_DIR: &str = "_native_state";
const CHAT_INDEX_DIR: &str = "chat_index";
const ARTIFACT_WORKSPACES_DIR: &str = "_workspaces";
const ARTIFACT_VERSION_WORKSPACES_DIR: &str = "_version_workspaces";
const ARTIFACT_CONTAINER_PREFIX: &str = "agent-vm-artifact-";
const AGENT_VM_INFO_PREFIX: &str = "agent_vm_info:";
const AGENT_VM_IMAGE_NAME: &str = "agent-vm:latest";
const AGENT_VM_IMAGE_ENV: &str = "CORE_MCP_AGENT_VM_IMAGE";
const AGENT_VM_NETWORK_ENV: &str = "CORE_MCP_AGENT_VM_NETWORK";
const DEFAULT_VM_NETWORK: &str = "portico-agent-vm-network";
const STATUS_ERROR: &str = "error";
const STARTUP_ATTEMPTS: usize = 20;
const STARTUP_POLL_MILLIS: u64 = 250;

#[derive(Debug, Clone)]
struct VmMetadata {
    container_id: String,
    chat_id: String,
    work_bind_source: Option<String>,
    work_bind_source_verified: bool,
}

impl VmMetadata {
    fn from_json(value: &Value) -> Result<Self> {
        Ok(Self {
            container_id: value
                .get("container_id")
                .and_then(Value::as_str)
                .context("missing container_id")?
                .to_string(),
            chat_id: value
                .get("chat_id")
                .and_then(Value::as_str)
                .context("missing chat_id")?
                .to_string(),
            work_bind_source: value
                .get("work_bind_source")
                .and_then(Value::as_str)
                .map(str::to_string),
            work_bind_source_verified: value
                .get("work_bind_source_verified")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
struct ArtifactVersion {
    version: i64,
    created_at: f64,
    snapshot_path: String,
    version_note: String,
}

impl ArtifactVersion {
    fn to_json(&self) -> Value {
        json!({
            "version": self.version,
            "created_at": self.created_at,
            "snapshot_path": self.snapshot_path,
            "version_note": self.version_note,
        })
    }

    fn from_json(value: &Value) -> Result<Self> {
        Ok(Self {
            version: value
                .get("version")
                .and_then(Value::as_i64)
                .context("missing version")?,
            created_at: value
                .get("created_at")
                .and_then(Value::as_f64)
                .context("missing created_at")?,
            snapshot_path: value
                .get("snapshot_path")
                .and_then(Value::as_str)
                .context("missing snapshot_path")?
                .to_string(),
            version_note: value
                .get("version_note")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
struct ArtifactInfo {
    artifact_id: String,
    chat_id: String,
    name: String,
    description: String,
    created_at: f64,
    start_command: String,
    working_directory: String,
    container_port: u16,
    current_version: i64,
    host_port: Option<u16>,
    running_vm_id: Option<String>,
    bound_vm_id: Option<String>,
    status: String,
    error_message: Option<String>,
    versions: Vec<ArtifactVersion>,
}

impl ArtifactInfo {
    fn to_json(&self) -> Value {
        json!({
            "artifact_id": self.artifact_id,
            "chat_id": self.chat_id,
            "name": self.name,
            "description": self.description,
            "created_at": self.created_at,
            "start_command": self.start_command,
            "working_directory": self.working_directory,
            "container_port": self.container_port,
            "current_version": self.current_version,
            "host_port": self.host_port,
            "running_vm_id": self.running_vm_id,
            "bound_vm_id": self.bound_vm_id,
            "status": self.status,
            "error_message": self.error_message,
            "versions": self.versions.iter().map(ArtifactVersion::to_json).collect::<Vec<_>>(),
        })
    }

    fn from_json(value: &Value) -> Result<Self> {
        let versions = value
            .get("versions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(ArtifactVersion::from_json)
            .collect::<Result<Vec<_>>>()?;
        Ok(Self {
            artifact_id: value
                .get("artifact_id")
                .and_then(Value::as_str)
                .context("missing artifact_id")?
                .to_string(),
            chat_id: value
                .get("chat_id")
                .and_then(Value::as_str)
                .context("missing chat_id")?
                .to_string(),
            name: value
                .get("name")
                .and_then(Value::as_str)
                .context("missing name")?
                .to_string(),
            description: value
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            created_at: value
                .get("created_at")
                .and_then(Value::as_f64)
                .context("missing created_at")?,
            start_command: value
                .get("start_command")
                .and_then(Value::as_str)
                .context("missing start_command")?
                .to_string(),
            working_directory: value
                .get("working_directory")
                .and_then(Value::as_str)
                .unwrap_or("/work")
                .to_string(),
            container_port: value
                .get("container_port")
                .and_then(Value::as_u64)
                .unwrap_or(5173) as u16,
            current_version: value
                .get("current_version")
                .and_then(Value::as_i64)
                .unwrap_or(1),
            host_port: value
                .get("host_port")
                .and_then(Value::as_u64)
                .map(|value| value as u16),
            running_vm_id: value
                .get("running_vm_id")
                .and_then(Value::as_str)
                .map(str::to_string),
            bound_vm_id: value
                .get("bound_vm_id")
                .and_then(Value::as_str)
                .map(str::to_string),
            status: value
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or(STATUS_STOPPED)
                .to_string(),
            error_message: value
                .get("error_message")
                .and_then(Value::as_str)
                .map(str::to_string),
            versions,
        })
    }
}

fn artifact_key(artifact_id: &str) -> String {
    format!("{ARTIFACT_PREFIX}{artifact_id}")
}

fn chat_artifacts_key(chat_id: &str) -> String {
    format!("{CHAT_ARTIFACTS_PREFIX}{chat_id}")
}

fn disk_state_root() -> Result<PathBuf> {
    Ok(container_artifact_snapshots_dir()?.join(DISK_STATE_DIR))
}

fn artifact_snapshots_root(artifact_id: &str) -> Result<PathBuf> {
    Ok(container_artifact_snapshots_dir()?.join(artifact_id))
}

fn artifact_metadata_path(artifact_id: &str) -> Result<PathBuf> {
    Ok(artifact_snapshots_root(artifact_id)?.join("metadata.json"))
}

fn chat_index_path(chat_id: &str) -> Result<PathBuf> {
    Ok(disk_state_root()?
        .join(CHAT_INDEX_DIR)
        .join(format!("{}.json", safe_path_component(chat_id))))
}

fn port_counter_path() -> Result<PathBuf> {
    Ok(disk_state_root()?.join("artifact_port_counter.json"))
}

fn current_artifact_workspace(_chat_id: &str, artifact_id: &str) -> Result<PathBuf> {
    Ok(container_artifact_snapshots_dir()?
        .join(ARTIFACT_WORKSPACES_DIR)
        .join(artifact_id))
}

fn version_artifact_workspace(artifact_id: &str, version: i64) -> Result<PathBuf> {
    Ok(container_artifact_snapshots_dir()?
        .join(ARTIFACT_VERSION_WORKSPACES_DIR)
        .join(artifact_id)
        .join(format!("v{version}")))
}

fn host_artifact_workspace(artifact_id: &str) -> Result<PathBuf> {
    Ok(host_artifact_snapshots_dir()?
        .join(ARTIFACT_WORKSPACES_DIR)
        .join(artifact_id))
}

fn version_snapshot_path(artifact_id: &str, version: i64) -> Result<PathBuf> {
    Ok(artifact_snapshots_root(artifact_id)?.join(format!("v{version}.tar.gz")))
}

fn agent_vm_image_name() -> String {
    env::var(AGENT_VM_IMAGE_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| AGENT_VM_IMAGE_NAME.to_string())
}

fn agent_vm_network_name() -> String {
    env::var(AGENT_VM_NETWORK_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_VM_NETWORK.to_string())
}

fn load_vm_metadata(vm_id: &str) -> Result<Option<VmMetadata>> {
    let Some(raw) = redis_get_string(&format!("{AGENT_VM_INFO_PREFIX}{vm_id}")).unwrap_or(None)
    else {
        return Ok(None);
    };
    Ok(Some(VmMetadata::from_json(&serde_json::from_str(&raw)?)?))
}

fn local_workspace_path(path: &Path) -> Result<PathBuf> {
    resolve_local_workspace_path(path)
}

fn chat_workspace_root(chat_id: &str) -> Result<PathBuf> {
    local_workspace_path(&resolve_chat_workspace_binding(chat_id)?.host_path)
}

fn source_workspace(chat_id: &str, source_vm_id: Option<&str>) -> Result<PathBuf> {
    if let Some(vm_id) = source_vm_id {
        if let Some(vm) = load_vm_metadata(vm_id)? {
            if vm.chat_id == chat_id && vm.work_bind_source_verified {
                if let Some(source) = vm.work_bind_source.as_deref() {
                    return local_workspace_path(Path::new(source));
                }
            }
        }
    }
    let root = chat_workspace_root(chat_id)?;
    fs::create_dir_all(&root)
        .with_context(|| format!("failed to create chat workspace {}", root.display()))?;
    Ok(root)
}

fn load_artifact(artifact_id: &str) -> Result<ArtifactInfo> {
    if let Ok(Some(raw)) = redis_get_string(&artifact_key(artifact_id)) {
        let value: Value = serde_json::from_str(&raw).context("failed to decode artifact JSON")?;
        return ArtifactInfo::from_json(&value);
    }

    let metadata_path = artifact_metadata_path(artifact_id)?;
    if metadata_path.exists() {
        return ArtifactInfo::from_json(&read_json_file(&metadata_path)?);
    }

    bail!("artifact not found: {artifact_id}");
}

fn save_artifact(info: &ArtifactInfo) -> Result<()> {
    let value = info.to_json();
    let serialized = serde_json::to_string(&value)?;
    write_json_atomic(&artifact_metadata_path(&info.artifact_id)?, &value)?;
    let _ = redis_set_string(&artifact_key(&info.artifact_id), &serialized);
    Ok(())
}

fn delete_artifact_record(artifact_id: &str) -> Result<()> {
    let _ = redis_delete(&artifact_key(artifact_id));
    let metadata_path = artifact_metadata_path(artifact_id)?;
    if metadata_path.exists() {
        fs::remove_file(&metadata_path)
            .with_context(|| format!("failed to remove {}", metadata_path.display()))?;
    }
    Ok(())
}

fn next_artifact_id() -> String {
    format!("artifact-{}", Uuid::new_v4().simple())
}

fn next_host_port_counter() -> Result<i64> {
    Ok(match redis_incr(ARTIFACT_PORT_COUNTER_KEY) {
        Ok(value) => value,
        Err(_) => {
            let counter_path = port_counter_path()?;
            let current = if counter_path.exists() {
                read_json_file(&counter_path)?
                    .get("counter")
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
            } else {
                0
            };
            let next = current + 1;
            write_json_atomic(&counter_path, &json!({ "counter": next }))?;
            next
        }
    })
}

fn is_browser_unsafe_port(port: u16) -> bool {
    BROWSER_UNSAFE_PORTS.contains(&port)
}

fn next_host_port() -> Result<u16> {
    for _ in 0..ARTIFACT_PORT_RANGE {
        let next_counter = next_host_port_counter()?;
        let offset = (next_counter - 1).rem_euclid(ARTIFACT_PORT_RANGE);
        let port = (ARTIFACT_PORT_START + offset) as u16;
        if !is_browser_unsafe_port(port) {
            return Ok(port);
        }
    }
    bail!("failed to allocate a browser-safe artifact host port")
}

fn browser_safe_host_port(existing: Option<u16>) -> Result<u16> {
    match existing {
        Some(port) if !is_browser_unsafe_port(port) => Ok(port),
        _ => next_host_port(),
    }
}

fn read_chat_index(chat_id: &str) -> Result<Vec<String>> {
    let path = chat_index_path(chat_id)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    Ok(read_json_file(&path)?
        .get("artifact_ids")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_str().map(str::to_string))
        .collect())
}

fn write_chat_index(chat_id: &str, artifact_ids: &[String]) -> Result<()> {
    write_json_atomic(
        &chat_index_path(chat_id)?,
        &json!({ "chat_id": chat_id, "artifact_ids": artifact_ids }),
    )
}

fn add_chat_artifact(chat_id: &str, artifact_id: &str) -> Result<()> {
    let _ = redis_sadd(&chat_artifacts_key(chat_id), artifact_id);
    let mut artifact_ids = read_chat_index(chat_id)?;
    if !artifact_ids.iter().any(|value| value == artifact_id) {
        artifact_ids.push(artifact_id.to_string());
        artifact_ids.sort();
        write_chat_index(chat_id, &artifact_ids)?;
    }
    Ok(())
}

fn remove_chat_artifact(chat_id: &str, artifact_id: &str) -> Result<()> {
    let _ = redis_srem(&chat_artifacts_key(chat_id), artifact_id);
    let mut artifact_ids = read_chat_index(chat_id)?;
    artifact_ids.retain(|value| value != artifact_id);
    write_chat_index(chat_id, &artifact_ids)?;
    Ok(())
}

fn list_chat_artifact_ids(chat_id: &str) -> Result<Vec<String>> {
    let mut ids = BTreeMap::new();
    if let Ok(redis_ids) = redis_smembers(&chat_artifacts_key(chat_id)) {
        for artifact_id in redis_ids {
            ids.insert(artifact_id.clone(), artifact_id);
        }
    }
    for artifact_id in read_chat_index(chat_id)? {
        ids.insert(artifact_id.clone(), artifact_id);
    }
    Ok(ids.into_values().collect())
}

#[rustfmt::skip]
fn ensure_archive_parent(dest_tar_gz: &Path) -> Result<()> { if let Some(parent) = dest_tar_gz.parent() { fs::create_dir_all(parent).with_context(|| format!("failed to create {}", parent.display()))?; } Ok(()) }

#[rustfmt::skip]
fn retain_current_versions(value: &mut Value, current_version: i64) { if let Some(versions) = value.get_mut("versions").and_then(Value::as_array_mut) { versions.retain(|item| item.get("version").and_then(Value::as_i64) == Some(current_version)); } }

fn tar_directory(src_dir: &Path, dest_tar_gz: &Path) -> Result<()> {
    ensure_archive_parent(dest_tar_gz)?;
    let file = fs::File::create(dest_tar_gz)
        .with_context(|| format!("failed to create {}", dest_tar_gz.display()))?;
    let encoder = GzEncoder::new(file, Compression::default());
    let mut tar = tar::Builder::new(encoder);
    tar.follow_symlinks(false);
    tar.append_dir_all(".", src_dir)
        .with_context(|| format!("failed to archive {}", src_dir.display()))?;
    tar.finish().context("failed to finish tar archive")?;
    Ok(())
}

async fn tar_container_workdir(container_id: &str, dest_tar_gz: &Path) -> Result<()> {
    ensure_archive_parent(dest_tar_gz)?;
    if env::var("CORE_MCP_TEST_DOCKER").ok().as_deref() == Some("fake") {
        bail!("fake Docker cannot export container workdir directly");
    }
    let docker = docker_client()?;
    let options = DownloadFromContainerOptionsBuilder::default()
        .path("/work/.")
        .build();
    let mut stream = docker.download_from_container(container_id, Some(options));
    let file = fs::File::create(dest_tar_gz)
        .with_context(|| format!("failed to create {}", dest_tar_gz.display()))?;
    let mut encoder = GzEncoder::new(file, Compression::default());
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("failed to download /work from Agent VM container")?;
        encoder
            .write_all(&chunk)
            .context("failed to write workspace archive")?;
    }
    encoder
        .finish()
        .context("failed to finish workspace archive")?;
    Ok(())
}

async fn snapshot_source_workspace(
    chat_id: &str,
    source_vm_id: Option<&str>,
    snapshot_path: &Path,
) -> Result<()> {
    if let Some(vm_id) = source_vm_id {
        if let Some(vm) = load_vm_metadata(vm_id)? {
            if vm.chat_id == chat_id
                && vm.work_bind_source_verified
                && env::var("CORE_MCP_TEST_DOCKER").ok().as_deref() != Some("fake")
            {
                return tar_container_workdir(&vm.container_id, snapshot_path).await;
            }
        }
    }
    match source_workspace(chat_id, source_vm_id) {
        Ok(source_dir) => tar_directory(&source_dir, snapshot_path),
        Err(error) => {
            let binding = resolve_chat_workspace_binding(chat_id)?;
            if binding.canonical {
                return Err(error);
            }
            tar_host_workspace_with_helper(&binding.host_path, snapshot_path).await
        }
    }
}

fn untar_directory(src_tar_gz: &Path, dest_dir: &Path) -> Result<()> {
    if dest_dir.exists() {
        fs::remove_dir_all(dest_dir)
            .with_context(|| format!("failed to clear {}", dest_dir.display()))?;
    }
    fs::create_dir_all(dest_dir)
        .with_context(|| format!("failed to create {}", dest_dir.display()))?;
    let file = fs::File::open(src_tar_gz)
        .with_context(|| format!("failed to open {}", src_tar_gz.display()))?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    archive
        .unpack(dest_dir)
        .with_context(|| format!("failed to unpack {}", src_tar_gz.display()))?;
    Ok(())
}

fn truncate_version_note(note: &str) -> String {
    if note.chars().count() <= MAX_VERSION_NOTE_LEN {
        return note.to_string();
    }
    note.chars()
        .take(MAX_VERSION_NOTE_LEN - 3)
        .collect::<String>()
        + "..."
}

fn preview_url(status: &str, host_port: Option<u16>) -> Option<String> {
    if status == STATUS_RUNNING {
        return host_port.map(|port| format!("http://localhost:{port}"));
    }
    None
}

fn artifact_container_name(artifact_id: &str) -> String {
    format!("{ARTIFACT_CONTAINER_PREFIX}{artifact_id}")
}

fn docker_client() -> Result<Docker> {
    core_mcp_shared::connect_docker_client()
}

fn fake_docker_enabled() -> bool {
    env::var("CORE_MCP_TEST_DOCKER").ok().as_deref() == Some("fake")
}

async fn inspect_artifact_container_status(container_id: &str) -> Result<Option<String>> {
    if fake_docker_enabled() {
        return Ok(Some(STATUS_RUNNING.to_string()));
    }

    let docker = match docker_client() {
        Ok(client) => client,
        Err(_) => return Ok(None),
    };
    let inspect = match docker
        .inspect_container(container_id, None::<InspectContainerOptions>)
        .await
    {
        Ok(inspect) => inspect,
        Err(_) => return Ok(None),
    };

    Ok(Some(
        inspect
            .state
            .and_then(|state| state.status)
            .map(|status| status.to_string())
            .unwrap_or_else(|| "unknown".to_string()),
    ))
}

async fn refresh_artifact_runtime_state(info: &mut ArtifactInfo) -> Result<bool> {
    if fake_docker_enabled() || info.status != STATUS_RUNNING {
        return Ok(false);
    }

    if info.host_port.is_none() {
        info.running_vm_id = None;
        info.status = STATUS_STOPPED.to_string();
        info.error_message = None;
        return Ok(true);
    }

    let Some(container_id) = info.running_vm_id.as_deref() else {
        info.status = STATUS_STOPPED.to_string();
        info.error_message = None;
        return Ok(true);
    };

    match inspect_artifact_container_status(container_id).await? {
        Some(status) if matches!(status.as_str(), "running" | "paused") => Ok(false),
        _ => {
            info.running_vm_id = None;
            info.status = STATUS_STOPPED.to_string();
            info.error_message = None;
            Ok(true)
        }
    }
}

async fn remove_artifact_container(artifact_id: &str) -> Result<()> {
    if env::var("CORE_MCP_TEST_DOCKER").ok().as_deref() == Some("fake") {
        record_fake_runtime_event("remove", artifact_id);
        return Ok(());
    }
    let docker = docker_client()?;
    let _ = docker
        .remove_container(
            &artifact_container_name(artifact_id),
            Some(RemoveContainerOptions {
                force: true,
                ..Default::default()
            }),
        )
        .await;
    Ok(())
}

async fn exec_in_container(container_id: &str, working_dir: &str, command: &str) -> Result<String> {
    if env::var("CORE_MCP_TEST_DOCKER").ok().as_deref() == Some("fake") {
        return Ok(String::new());
    }
    let docker = docker_client()?;
    let exec = docker
        .create_exec(
            container_id,
            CreateExecOptions {
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                cmd: Some(vec![
                    "bash".to_string(),
                    "-lc".to_string(),
                    command.to_string(),
                ]),
                working_dir: Some(working_dir.to_string()),
                ..Default::default()
            },
        )
        .await?;
    let mut output_text = String::new();
    let start_exec_result = docker
        .start_exec(&exec.id, None::<StartExecOptions>)
        .await?;
    if let StartExecResults::Attached { mut output, .. } = start_exec_result {
        while let Some(chunk) = output.next().await {
            match chunk? {
                LogOutput::StdOut { message } | LogOutput::StdErr { message } => {
                    output_text.push_str(&String::from_utf8_lossy(&message));
                }
                _ => {}
            }
        }
    }
    let inspect = docker.inspect_exec(&exec.id).await?;
    if inspect.exit_code.unwrap_or_default() != 0 {
        bail!(
            "container command failed with exit code {}: {}",
            inspect.exit_code.unwrap_or_default(),
            output_text.trim()
        );
    }
    Ok(output_text)
}

async fn create_artifact_runtime_container(info: &ArtifactInfo) -> Result<String> {
    let workspace_dir = current_artifact_workspace(&info.chat_id, &info.artifact_id)?;
    fs::create_dir_all(&workspace_dir)
        .with_context(|| format!("failed to create {}", workspace_dir.display()))?;
    let host_workspace_dir = host_artifact_workspace(&info.artifact_id)?;
    let host_port = info.host_port.context("artifact host_port is required")?;

    if env::var("CORE_MCP_TEST_DOCKER").ok().as_deref() == Some("fake") {
        record_fake_runtime_event("create", &info.artifact_id);
        return Ok(format!("fake-artifact-{}", info.artifact_id));
    }

    remove_artifact_container(&info.artifact_id).await?;
    let docker = docker_client()?;
    let port_key = format!("{}/tcp", info.container_port);
    let exposed_ports = vec![port_key.clone()];
    let mut port_bindings = HashMap::new();
    port_bindings.insert(
        port_key,
        Some(vec![bollard::models::PortBinding {
            host_ip: Some("127.0.0.1".to_string()),
            host_port: Some(host_port.to_string()),
        }]),
    );
    let config = ContainerCreateBody {
        image: Some(agent_vm_image_name()),
        cmd: Some(vec![
            "sh".to_string(),
            "-lc".to_string(),
            "rm -rf /workspace 2>/dev/null || true; ln -s /work /workspace 2>/dev/null || true; tail -f /dev/null".to_string(),
        ]),
        working_dir: Some("/work".to_string()),
        exposed_ports: Some(exposed_ports),
        host_config: Some(HostConfig {
            binds: Some(vec![format!("{}:/work:rw", host_workspace_dir.display())]),
            port_bindings: Some(port_bindings),
            network_mode: Some(agent_vm_network_name()),
            ..Default::default()
        }),
        ..Default::default()
    };
    let name = artifact_container_name(&info.artifact_id);
    docker
        .create_container(
            Some(CreateContainerOptions {
                name: Some(name.clone()),
                platform: String::new(),
            }),
            config,
        )
        .await
        .with_context(|| format!("failed to create artifact Agent VM container {name}"))?;
    docker
        .start_container(&name, None::<StartContainerOptions>)
        .await
        .with_context(|| format!("failed to start artifact Agent VM container {name}"))?;
    let inspect = docker
        .inspect_container(&name, None::<InspectContainerOptions>)
        .await?;
    inspect
        .id
        .context("artifact container inspect response missing id")
}

async fn create_workspace_helper_container(name: &str, binds: Vec<String>) -> Result<String> {
    if env::var("CORE_MCP_TEST_DOCKER").ok().as_deref() == Some("fake") {
        return Ok(format!("fake-{name}"));
    }

    let docker = docker_client()?;
    let _ = docker
        .remove_container(
            name,
            Some(RemoveContainerOptions {
                force: true,
                ..Default::default()
            }),
        )
        .await;
    let config = ContainerCreateBody {
        image: Some(agent_vm_image_name()),
        cmd: Some(vec![
            "sh".to_string(),
            "-lc".to_string(),
            "tail -f /dev/null".to_string(),
        ]),
        working_dir: Some("/work".to_string()),
        host_config: Some(HostConfig {
            binds: Some(binds),
            network_mode: Some(agent_vm_network_name()),
            ..Default::default()
        }),
        ..Default::default()
    };
    docker
        .create_container(
            Some(CreateContainerOptions {
                name: Some(name.to_string()),
                platform: String::new(),
            }),
            config,
        )
        .await
        .with_context(|| format!("failed to create helper Agent VM container {name}"))?;
    docker
        .start_container(name, None::<StartContainerOptions>)
        .await
        .with_context(|| format!("failed to start helper Agent VM container {name}"))?;
    let inspect = docker
        .inspect_container(name, None::<InspectContainerOptions>)
        .await?;
    inspect
        .id
        .context("helper container inspect response missing id")
}

async fn remove_workspace_helper_container(name: &str) -> Result<()> {
    if env::var("CORE_MCP_TEST_DOCKER").ok().as_deref() == Some("fake") {
        return Ok(());
    }
    let docker = docker_client()?;
    let _ = docker
        .remove_container(
            name,
            Some(RemoveContainerOptions {
                force: true,
                ..Default::default()
            }),
        )
        .await;
    Ok(())
}

async fn tar_host_workspace_with_helper(host_path: &Path, dest_tar_gz: &Path) -> Result<()> {
    if env::var("CORE_MCP_TEST_DOCKER").ok().as_deref() == Some("fake") {
        return tar_directory(host_path, dest_tar_gz);
    }
    let name = format!("agent-vm-artifact-snapshot-{}", Uuid::new_v4().simple());
    let container_id =
        create_workspace_helper_container(&name, vec![format!("{}:/work:ro", host_path.display())])
            .await?;
    let result = tar_container_workdir(&container_id, dest_tar_gz).await;
    remove_workspace_helper_container(&name).await?;
    result
}

async fn copy_snapshot_to_chat_workspace(
    chat_id: &str,
    artifact_id: &str,
    snapshot_path: &Path,
    file_name: &str,
) -> Result<()> {
    let binding = resolve_chat_workspace_binding(chat_id)?;
    if let Ok(local_root) = local_workspace_path(&binding.host_path) {
        let output_dir = local_root.join("output");
        fs::create_dir_all(&output_dir)
            .with_context(|| format!("failed to create {}", output_dir.display()))?;
        fs::copy(snapshot_path, output_dir.join(file_name)).with_context(|| {
            format!("failed to copy to {}", output_dir.join(file_name).display())
        })?;
        return Ok(());
    }

    if env::var("CORE_MCP_TEST_DOCKER").ok().as_deref() == Some("fake") {
        let output_dir = binding.host_path.join("output");
        fs::create_dir_all(&output_dir)
            .with_context(|| format!("failed to create {}", output_dir.display()))?;
        fs::copy(snapshot_path, output_dir.join(file_name)).with_context(|| {
            format!("failed to copy to {}", output_dir.join(file_name).display())
        })?;
        return Ok(());
    }

    let name = format!("agent-vm-artifact-export-{}", Uuid::new_v4().simple());
    let snapshots_root = host_artifact_snapshots_dir()?;
    let container_id = create_workspace_helper_container(
        &name,
        vec![
            format!("{}:/work:rw", binding.host_path.display()),
            format!("{}:/snapshots:ro", snapshots_root.display()),
        ],
    )
    .await?;
    let snapshot_rel = Path::new(artifact_id).join(
        snapshot_path
            .file_name()
            .context("artifact snapshot path missing file name")?,
    );
    let command = format!(
        "mkdir -p /work/output && cp {} {}",
        shell_quote(&format!("/snapshots/{}", snapshot_rel.display())),
        shell_quote(&format!("/work/output/{file_name}")),
    );
    let result = exec_in_container(&container_id, "/work", &command).await;
    remove_workspace_helper_container(&name).await?;
    result.map(|_| ())
}

async fn start_artifact_server(info: &mut ArtifactInfo) -> Result<()> {
    remove_artifact_container(&info.artifact_id).await?;
    let container_id = create_artifact_runtime_container(info).await?;
    info.running_vm_id = Some(container_id.clone());
    let command = format!(
        "nohup {} > /tmp/artifact-server.log 2>&1 & echo $! > /tmp/artifact-server.pid",
        info.start_command
    );
    exec_in_container(&container_id, &info.working_directory, &command).await?;

    if env::var("CORE_MCP_TEST_DOCKER").ok().as_deref() == Some("fake") {
        record_fake_runtime_event("start", &info.artifact_id);
        info.status = STATUS_RUNNING.to_string();
        info.error_message = None;
        return Ok(());
    }

    let probe = format!(
        "python3 - <<'PY'\nimport sys, time, urllib.request\nurl = 'http://127.0.0.1:{}/'\nfor _ in range({STARTUP_ATTEMPTS}):\n    try:\n        with urllib.request.urlopen(url, timeout=2) as response:\n            if response.status < 500:\n                sys.exit(0)\n    except Exception:\n        time.sleep({})\nprint('artifact server did not become ready')\ntry:\n    print(open('/tmp/artifact-server.log', 'r', errors='replace').read()[-4000:])\nexcept FileNotFoundError:\n    pass\nsys.exit(1)\nPY",
        info.container_port,
        STARTUP_POLL_MILLIS as f64 / 1000.0
    );
    match exec_in_container(&container_id, "/work", &probe).await {
        Ok(_) => {
            info.status = STATUS_RUNNING.to_string();
            info.error_message = None;
            Ok(())
        }
        Err(error) => {
            info.status = STATUS_ERROR.to_string();
            info.error_message = Some(error.to_string());
            Err(error)
        }
    }
}

async fn stop_artifact_server(info: &mut ArtifactInfo) -> Result<()> {
    if let Some(container_id) = info.running_vm_id.as_deref() {
        let _ = exec_in_container(
            container_id,
            "/work",
            &format!(
                "if [ -f /tmp/artifact-server.pid ]; then pid=$(cat /tmp/artifact-server.pid); kill \"$pid\" 2>/dev/null || true; rm -f /tmp/artifact-server.pid; fi; pkill -f -- {} 2>/dev/null || true",
                shell_quote(&pkill_regex_for_command(&info.start_command))
            ),
        )
        .await;
    }
    remove_artifact_container(&info.artifact_id).await?;
    info.running_vm_id = None;
    info.status = STATUS_STOPPED.to_string();
    info.error_message = None;
    Ok(())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn pkill_regex_for_command(value: &str) -> String {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return String::new();
    };
    let mut pattern = String::new();
    if first.is_ascii_alphanumeric() {
        pattern.push('[');
        pattern.push(first);
        pattern.push(']');
    } else {
        pattern.push_str(&regex_escape_char(first));
    }
    for ch in chars {
        pattern.push_str(&regex_escape_char(ch));
    }
    pattern
}

fn regex_escape_char(ch: char) -> String {
    match ch {
        '\\' | '.' | '^' | '$' | '*' | '+' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '|'
        | '-' => format!("\\{ch}"),
        _ => ch.to_string(),
    }
}

#[cfg(test)]
fn fake_runtime_events() -> &'static std::sync::Mutex<Vec<String>> {
    static EVENTS: std::sync::OnceLock<std::sync::Mutex<Vec<String>>> = std::sync::OnceLock::new();
    EVENTS.get_or_init(|| std::sync::Mutex::new(Vec::new()))
}

#[cfg(test)]
fn record_fake_runtime_event(action: &str, artifact_id: &str) {
    fake_runtime_events()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .push(format!("{action}:{artifact_id}"));
}

#[cfg(not(test))]
fn record_fake_runtime_event(_action: &str, _artifact_id: &str) {}

fn sanitized_artifact_error_message(message: Option<&str>) -> Value {
    if message.is_some() {
        Value::String(
            "Artifact operation failed. Reopen or recreate the artifact, then try again."
                .to_string(),
        )
    } else {
        Value::Null
    }
}

fn scrub_artifact_versions(value: &mut Value) {
    if let Some(versions) = value.get_mut("versions").and_then(Value::as_array_mut) {
        for version in versions {
            if let Some(object) = version.as_object_mut() {
                object.remove("snapshot_path");
            }
        }
    }
}

fn sanitize_artifact_response(info: &ArtifactInfo, include_all_versions: bool) -> Value {
    let mut value = info.to_json();
    if !include_all_versions {
        retain_current_versions(&mut value, info.current_version);
    }
    scrub_artifact_versions(&mut value);
    if let Some(object) = value.as_object_mut() {
        object.remove("bound_vm_id");
        object.remove("running_vm_id");
        object.remove("working_directory");
        object.insert(
            "error_message".to_string(),
            sanitized_artifact_error_message(info.error_message.as_deref()),
        );
    }
    value
}

fn artifact_tool_error_classification(
    tool_name: &str,
    error: &anyhow::Error,
) -> (&'static str, &'static str) {
    let message = error.to_string().to_ascii_lowercase();
    if message.contains("chat_id is required")
        || message.contains("artifact_id is required")
        || message.contains("name is required")
        || message.contains("start_command is required")
        || message.contains("source_vm_id is required")
    {
        return (
            "missing_required_input",
            "Required artifact input is missing. Check the tool arguments and try again.",
        );
    }
    if message.contains("confirm=true is required") {
        return (
            "confirmation_required",
            "Set confirm to true before deleting the artifact.",
        );
    }
    if message.contains("artifact does not belong to chat_id") {
        return (
            "artifact_chat_mismatch",
            "Artifact does not belong to this chat.",
        );
    }
    if message.contains("artifact version not found") {
        return ("artifact_version_not_found", "Artifact version not found.");
    }
    if message.contains("artifact not found") {
        return ("artifact_not_found", "Artifact not found.");
    }
    if message.contains("failed to archive")
        || message.contains("failed to create seed workspace")
        || ((tool_name == "create_artifact" || tool_name == "create_artifact_version")
            && message.contains("no such file"))
    {
        return (
            "working_directory_not_found",
            "Working directory not found. Recreate or reopen the source workspace, then try again.",
        );
    }
    if tool_name == "list_artifacts" {
        return (
            "artifact_list_failed",
            "Unable to list artifacts for this chat. Try again after reopening the chat.",
        );
    }
    if message.contains("snapshot")
        || message.contains("failed to unpack")
        || message.contains("failed to open")
        || message.contains("failed to copy")
    {
        return (
            "artifact_snapshot_unavailable",
            "Artifact snapshot is unavailable. Recreate the artifact or save a new version.",
        );
    }
    (
        "artifact_tool_failed",
        "Artifact operation failed. Try again or recreate the artifact.",
    )
}

pub(super) fn artifact_tool_error_response(
    tool_name: &str,
    error: &anyhow::Error,
) -> Result<Value> {
    let (code, message) = artifact_tool_error_classification(tool_name, error);
    success_text(json!({
        "success": false,
        "code": code,
        "tool": tool_name,
        "error": message,
        "message": message,
    }))
}

fn select_version(info: &ArtifactInfo, version: Option<i64>) -> Result<ArtifactVersion> {
    let selected = version.unwrap_or(info.current_version);
    info.versions
        .iter()
        .find(|item| item.version == selected)
        .cloned()
        .context(format!("artifact version not found: {selected}"))
}

fn materialize_version(info: &ArtifactInfo, version: i64) -> Result<ArtifactVersion> {
    let selected = select_version(info, Some(version))?;
    let workspace = current_artifact_workspace(&info.chat_id, &info.artifact_id)?;
    untar_directory(Path::new(&selected.snapshot_path), &workspace)?;
    let version_workspace = version_artifact_workspace(&info.artifact_id, selected.version)?;
    untar_directory(Path::new(&selected.snapshot_path), &version_workspace)?;
    Ok(selected)
}

fn running_versions_payload(info: &ArtifactInfo) -> Vec<Value> {
    match preview_url(&info.status, info.host_port) {
        Some(_) => vec![json!({
            "version": info.current_version,
            "host_port": info.host_port,
            "is_current": true,
        })],
        None => Vec::new(),
    }
}

fn artifact_status_payload(info: &ArtifactInfo) -> Value {
    json!({
        "success": true,
        "artifact_id": info.artifact_id,
        "name": info.name,
        "status": info.status,
        "preview_url": preview_url(&info.status, info.host_port),
        "current_version": info.current_version,
        "total_versions": info.versions.len(),
        "host_port": info.host_port,
        "error_message": sanitized_artifact_error_message(info.error_message.as_deref()),
    })
}

fn create_artifact_payload(info: &ArtifactInfo) -> Value {
    json!({
        "success": true,
        "artifact_id": info.artifact_id,
        "name": info.name,
        "host_port": info.host_port,
        "status": info.status,
        "preview_url": preview_url(&info.status, info.host_port),
        "message": format!("Artifact '{}' created. Opening in panel...", info.name),
    })
}

fn create_version_payload(
    info: &ArtifactInfo,
    version: i64,
    created_at: f64,
    version_note: &str,
) -> Value {
    let message = info
        .host_port
        .map(|port| format!("Version {version} created on port {port}."))
        .unwrap_or_else(|| format!("Version {version} created."));
    json!({
        "success": true,
        "version": version,
        "host_port": info.host_port,
        "status": info.status,
        "preview_url": preview_url(&info.status, info.host_port),
        "created_at": created_at,
        "version_note": version_note,
        "evicted_version": Value::Null,
        "message": message,
    })
}

fn switch_version_payload(info: &ArtifactInfo) -> Value {
    json!({
        "success": true,
        "artifact_id": info.artifact_id,
        "version": info.current_version,
        "host_port": info.host_port,
        "preview_url": preview_url(&info.status, info.host_port),
        "from_pool": false,
        "evicted_version": Value::Null,
        "message": format!("Switched artifact to version {}.", info.current_version),
    })
}

fn archive_file_name(name: &str, version: i64) -> String {
    let safe_name = name
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string();
    let base = if safe_name.is_empty() {
        "artifact"
    } else {
        &safe_name
    };
    format!("{base}_v{version}.tar.gz")
}

fn electron_notifications_enabled() -> bool {
    !matches!(
        env::var("DISABLE_ELECTRON_NOTIFICATIONS")
            .ok()
            .as_deref()
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("1" | "true" | "yes")
    )
}

async fn maybe_notify_electron(path: &str, payload: &Value) {
    if !electron_notifications_enabled() {
        return;
    }
    let timeout = env::var("ARTIFACT_ELECTRON_NOTIFY_TIMEOUT_SECS")
        .ok()
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(2.0);
    let _ = electron_post_json(path, payload, timeout).await;
}

async fn notify_open_artifact(info: &ArtifactInfo, detached: bool) {
    maybe_notify_electron(
        "/api/artifact/open",
        &json!({
            "artifact_id": info.artifact_id,
            "chat_id": info.chat_id,
            "preview_url": preview_url(&info.status, info.host_port),
            "name": info.name,
            "version": info.current_version,
            "detached": detached,
        }),
    )
    .await;
}

async fn notify_close_artifact(artifact_id: &str) {
    maybe_notify_electron(
        "/api/artifact/close",
        &json!({ "artifact_id": artifact_id }),
    )
    .await;
}

async fn notify_version_changed(info: &ArtifactInfo) {
    maybe_notify_electron(
        "/api/artifact/version-changed",
        &json!({
            "artifact_id": info.artifact_id,
            "version": info.current_version,
            "preview_url": preview_url(&info.status, info.host_port),
            "host_port": info.host_port,
        }),
    )
    .await;
}

pub(super) async fn handle_create_artifact(arguments: &Map<String, Value>) -> Result<Value> {
    let artifact_id = next_artifact_id();
    let chat_id = string_arg(arguments, "chat_id")?;
    let name = string_arg(arguments, "name")?;
    let start_command = string_arg(arguments, "start_command")?;
    let description = arguments
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let working_directory = arguments
        .get("working_directory")
        .and_then(Value::as_str)
        .unwrap_or("/work")
        .to_string();
    let container_port = int_arg(arguments, "container_port", 5173) as u16;
    let version_note = truncate_version_note(
        arguments
            .get("version_note")
            .and_then(Value::as_str)
            .unwrap_or("Initial version"),
    );
    let source_vm_id = arguments.get("vm_id").and_then(Value::as_str);

    let snapshot_path = version_snapshot_path(&artifact_id, 1)?;
    snapshot_source_workspace(&chat_id, source_vm_id, &snapshot_path).await?;

    let now = now_epoch_seconds();
    let mut info = ArtifactInfo {
        artifact_id: artifact_id.clone(),
        chat_id: chat_id.clone(),
        name,
        description,
        created_at: now,
        start_command,
        working_directory,
        container_port,
        current_version: 1,
        host_port: Some(next_host_port()?),
        running_vm_id: None,
        bound_vm_id: source_vm_id.map(str::to_string),
        status: STATUS_STOPPED.to_string(),
        error_message: None,
        versions: vec![ArtifactVersion {
            version: 1,
            created_at: now,
            snapshot_path: snapshot_path.to_string_lossy().to_string(),
            version_note,
        }],
    };
    materialize_version(&info, 1)?;
    if let Err(error) = start_artifact_server(&mut info).await {
        save_artifact(&info)?;
        add_chat_artifact(&chat_id, &artifact_id)?;
        return success_text(json!({
            "success": false,
            "artifact_id": info.artifact_id,
            "name": info.name,
            "status": info.status,
            "error_message": error.to_string(),
            "message": "Artifact created but failed to start.",
        }));
    }
    save_artifact(&info)?;
    add_chat_artifact(&chat_id, &artifact_id)?;
    notify_open_artifact(&info, false).await;
    success_text(create_artifact_payload(&info))
}

pub(super) async fn handle_create_artifact_version(
    arguments: &Map<String, Value>,
) -> Result<Value> {
    let artifact_id = string_arg(arguments, "artifact_id")?;
    let chat_id = string_arg(arguments, "chat_id")?;
    let source_vm_id = string_arg(arguments, "source_vm_id")?;
    let version_note = truncate_version_note(
        arguments
            .get("version_note")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );

    let mut info = load_artifact(&artifact_id)?;
    if info.chat_id != chat_id {
        bail!("artifact does not belong to chat_id");
    }

    let new_version = info
        .versions
        .iter()
        .map(|item| item.version)
        .max()
        .unwrap_or(0)
        + 1;
    let created_at = now_epoch_seconds();
    let snapshot_path = version_snapshot_path(&artifact_id, new_version)?;
    snapshot_source_workspace(&chat_id, Some(&source_vm_id), &snapshot_path).await?;

    info.versions.push(ArtifactVersion {
        version: new_version,
        created_at,
        snapshot_path: snapshot_path.to_string_lossy().to_string(),
        version_note: version_note.clone(),
    });
    stop_artifact_server(&mut info).await?;
    materialize_version(&info, new_version)?;
    info.current_version = new_version;
    info.host_port = Some(browser_safe_host_port(info.host_port)?);
    if let Err(error) = start_artifact_server(&mut info).await {
        save_artifact(&info)?;
        return success_text(json!({
            "success": false,
            "version": new_version,
            "host_port": info.host_port,
            "created_at": created_at,
            "version_note": version_note,
            "error_message": error.to_string(),
            "message": "Version created but failed to start.",
        }));
    }
    save_artifact(&info)?;
    notify_version_changed(&info).await;
    success_text(create_version_payload(
        &info,
        new_version,
        created_at,
        &version_note,
    ))
}

pub(super) async fn handle_open_artifact(arguments: &Map<String, Value>) -> Result<Value> {
    let artifact_id = string_arg(arguments, "artifact_id")?;
    let detached = bool_arg(arguments, "detached", false);
    let force_restart = bool_arg(arguments, "force_restart", false);
    let mut info = load_artifact(&artifact_id)?;
    let selected = select_version(&info, arguments.get("version").and_then(Value::as_i64))?;
    if refresh_artifact_runtime_state(&mut info).await? {
        save_artifact(&info)?;
    }
    if !force_restart
        && info.status == STATUS_RUNNING
        && info.current_version == selected.version
        && info.host_port.is_some()
        && info.running_vm_id.is_some()
    {
        notify_open_artifact(&info, detached).await;
        return success_text(json!({
            "success": true,
            "preview_url": preview_url(&info.status, info.host_port),
            "status": info.status,
            "reused": true,
            "message": "Artifact opened in panel.",
        }));
    }
    stop_artifact_server(&mut info).await?;
    materialize_version(&info, selected.version)?;
    info.current_version = selected.version;
    info.host_port = Some(browser_safe_host_port(info.host_port)?);
    if let Err(error) = start_artifact_server(&mut info).await {
        save_artifact(&info)?;
        return success_text(json!({
            "success": false,
            "preview_url": Value::Null,
            "status": info.status,
            "error_message": error.to_string(),
            "message": "Artifact failed to open.",
        }));
    }
    save_artifact(&info)?;
    notify_open_artifact(&info, detached).await;
    success_text(json!({
        "success": true,
        "preview_url": preview_url(&info.status, info.host_port),
        "status": info.status,
        "reused": false,
        "message": "Artifact opened in panel.",
    }))
}

pub(super) async fn handle_switch_artifact_version(
    arguments: &Map<String, Value>,
) -> Result<Value> {
    let artifact_id = string_arg(arguments, "artifact_id")?;
    let version = int_arg(arguments, "version", 0);
    let mut info = load_artifact(&artifact_id)?;
    stop_artifact_server(&mut info).await?;
    materialize_version(&info, version)?;
    info.current_version = version;
    info.host_port = Some(browser_safe_host_port(info.host_port)?);
    if let Err(error) = start_artifact_server(&mut info).await {
        save_artifact(&info)?;
        return success_text(json!({
            "success": false,
            "artifact_id": info.artifact_id,
            "version": info.current_version,
            "host_port": info.host_port,
            "preview_url": Value::Null,
            "from_pool": false,
            "evicted_version": Value::Null,
            "error_message": error.to_string(),
            "message": "Artifact version failed to start.",
        }));
    }
    save_artifact(&info)?;
    notify_version_changed(&info).await;
    success_text(switch_version_payload(&info))
}

pub(super) async fn handle_list_artifacts(arguments: &Map<String, Value>) -> Result<Value> {
    let chat_id = string_arg(arguments, "chat_id")?;
    let include_all_versions = bool_arg(arguments, "include_all_versions", false);
    let mut artifacts = Vec::new();
    for artifact_id in list_chat_artifact_ids(&chat_id)? {
        let Ok(mut info) = load_artifact(&artifact_id) else {
            continue;
        };
        if refresh_artifact_runtime_state(&mut info).await? {
            save_artifact(&info)?;
        }
        artifacts.push(sanitize_artifact_response(&info, include_all_versions));
    }
    artifacts.sort_by(|left, right| {
        let right_created = right
            .get("created_at")
            .and_then(Value::as_f64)
            .unwrap_or_default();
        let left_created = left
            .get("created_at")
            .and_then(Value::as_f64)
            .unwrap_or_default();
        right_created
            .partial_cmp(&left_created)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    success_text(json!({
        "success": true,
        "count": artifacts.len(),
        "artifacts": artifacts,
    }))
}

pub(super) async fn handle_get_artifact_status(arguments: &Map<String, Value>) -> Result<Value> {
    let mut info = load_artifact(&string_arg(arguments, "artifact_id")?)?;
    if refresh_artifact_runtime_state(&mut info).await? {
        save_artifact(&info)?;
    }
    success_text(artifact_status_payload(&info))
}

pub(super) async fn handle_close_artifact(arguments: &Map<String, Value>) -> Result<Value> {
    let artifact_id = string_arg(arguments, "artifact_id")?;
    let mut info = load_artifact(&artifact_id)?;
    stop_artifact_server(&mut info).await?;
    save_artifact(&info)?;
    notify_close_artifact(&artifact_id).await;
    success_text(json!({
        "success": true,
        "message": "Artifact closed and server stopped.",
    }))
}

pub(super) async fn handle_delete_artifact(arguments: &Map<String, Value>) -> Result<Value> {
    let artifact_id = string_arg(arguments, "artifact_id")?;
    let chat_id = string_arg(arguments, "chat_id")?;
    if !bool_arg(arguments, "confirm", false) {
        bail!("confirm=true is required");
    }

    let info_result = load_artifact(&artifact_id);
    if let Ok(mut info) = info_result {
        if info.chat_id != chat_id {
            bail!("artifact does not belong to chat_id");
        }
        stop_artifact_server(&mut info).await?;
    } else if !list_chat_artifact_ids(&chat_id)?
        .into_iter()
        .any(|value| value == artifact_id)
    {
        load_artifact(&artifact_id)?;
    }

    let snapshots_dir = artifact_snapshots_root(&artifact_id)?;
    if snapshots_dir.exists() {
        fs::remove_dir_all(&snapshots_dir)
            .with_context(|| format!("failed to remove {}", snapshots_dir.display()))?;
    }
    let workspace_dir = current_artifact_workspace(&chat_id, &artifact_id)?;
    if workspace_dir.exists() {
        fs::remove_dir_all(&workspace_dir)
            .with_context(|| format!("failed to remove {}", workspace_dir.display()))?;
    }
    let version_workspace_dir = container_artifact_snapshots_dir()?
        .join(ARTIFACT_VERSION_WORKSPACES_DIR)
        .join(&artifact_id);
    if version_workspace_dir.exists() {
        fs::remove_dir_all(&version_workspace_dir)
            .with_context(|| format!("failed to remove {}", version_workspace_dir.display()))?;
    }

    remove_chat_artifact(&chat_id, &artifact_id)?;
    delete_artifact_record(&artifact_id)?;
    notify_close_artifact(&artifact_id).await;
    success_text(json!({
        "success": true,
        "message": "Artifact deleted.",
    }))
}

pub(super) async fn handle_restore_artifact_version(
    arguments: &Map<String, Value>,
) -> Result<Value> {
    let artifact_id = string_arg(arguments, "artifact_id")?;
    let version = int_arg(arguments, "version", 0);
    let chat_id = string_arg(arguments, "chat_id")?;
    let mut info = load_artifact(&artifact_id)?;
    if info.chat_id != chat_id {
        bail!("artifact does not belong to chat_id");
    }

    stop_artifact_server(&mut info).await?;
    materialize_version(&info, version)?;
    info.current_version = version;
    info.host_port = Some(browser_safe_host_port(info.host_port)?);
    if let Err(error) = start_artifact_server(&mut info).await {
        save_artifact(&info)?;
        return success_text(json!({
            "success": false,
            "message": format!("Restored to version {version}, but failed to start."),
            "status": info.status,
            "preview_url": Value::Null,
            "error_message": error.to_string(),
        }));
    }
    save_artifact(&info)?;
    notify_version_changed(&info).await;
    success_text(json!({
        "success": true,
        "status": info.status,
        "preview_url": preview_url(&info.status, info.host_port),
        "message": format!("Restored to version {version}."),
    }))
}

pub(super) async fn handle_download_artifact(arguments: &Map<String, Value>) -> Result<Value> {
    let artifact_id = string_arg(arguments, "artifact_id")?;
    let chat_id = string_arg(arguments, "chat_id")?;
    let info = load_artifact(&artifact_id)?;
    if info.chat_id != chat_id {
        bail!("artifact does not belong to chat_id");
    }

    let selected = select_version(&info, arguments.get("version").and_then(Value::as_i64))?;
    let file_name = archive_file_name(&info.name, selected.version);
    copy_snapshot_to_chat_workspace(
        &chat_id,
        &info.artifact_id,
        Path::new(&selected.snapshot_path),
        &file_name,
    )
    .await?;
    let file_path = format!("output/{file_name}");
    success_text(json!({
        "success": true,
        "file_path": file_path,
        "message": format!("Artifact exported to workspace: {file_path}"),
    }))
}

pub(super) async fn handle_get_artifact_running_versions(
    arguments: &Map<String, Value>,
) -> Result<Value> {
    let artifact_id = string_arg(arguments, "artifact_id")?;
    let mut info = load_artifact(&artifact_id)?;
    if refresh_artifact_runtime_state(&mut info).await? {
        save_artifact(&info)?;
    }
    let running_versions = running_versions_payload(&info);
    success_text(json!({
        "success": true,
        "artifact_id": artifact_id,
        "current_version": info.current_version,
        "running_versions": running_versions,
        "all_versions": info.versions.iter().map(|item| item.version).collect::<Vec<_>>(),
        "pool_capacity": 5,
        "pool_used": running_versions.len(),
    }))
}

#[cfg(test)]
#[path = "artifacts_tests.rs"]
mod tests;
