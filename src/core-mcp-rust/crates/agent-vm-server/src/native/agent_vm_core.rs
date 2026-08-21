use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use bollard::container::LogOutput;
use bollard::exec::{CreateExecOptions, StartExecResults};
use bollard::models::{ContainerCreateBody, HostConfig};
use bollard::query_parameters::{
    CreateContainerOptions, CreateImageOptions, InspectContainerOptions,
    ListContainersOptionsBuilder, RemoveContainerOptions, StartContainerOptions,
};
use bollard::Docker;
use futures_util::{StreamExt, TryStreamExt};
use serde_json::{json, Value};
use tokio::process::Command;
use tracing::{info, warn};
use uuid::Uuid;

use super::*;

const AGENT_VM_IMAGE_NAME: &str = "agent-vm:latest";
const AGENT_VM_IMAGE_ENV: &str = "CORE_MCP_AGENT_VM_IMAGE";
const AGENT_VM_NETWORK_ENV: &str = "CORE_MCP_AGENT_VM_NETWORK";
const AGENT_VM_DEFAULT_TIMEOUT_HOURS_ENV: &str = "CORE_MCP_AGENT_VM_DEFAULT_TIMEOUT_HOURS";
const AGENT_VM_CLEANUP_INTERVAL_SECONDS_ENV: &str = "AGENT_VM_CLEANUP_INTERVAL_SECONDS";
const VM_RECOVERY_ALIAS_PREFIX: &str = "agent_vm_recovery_alias:";
const VM_DESTROYED_TOMBSTONE_PREFIX: &str = "agent_vm_destroyed:";
const VM_CHAT_RESOLUTION_LOCK_PREFIX: &str = "agent_vm_resolution_lock:";
const VM_DESTROYED_TOMBSTONE_TTL_SECONDS: u64 = 7 * 24 * 60 * 60;
const VM_CHAT_RESOLUTION_LOCK_TTL_SECONDS: u64 = 120;
const VM_CHAT_RESOLUTION_LOCK_WAIT: Duration = Duration::from_secs(125);
const VM_CHAT_RESOLUTION_LOCK_POLL_INTERVAL: Duration = Duration::from_millis(25);
const DEFAULT_AGENT_VM_CLEANUP_INTERVAL_SECONDS: f64 = 60.0;
const ARTIFACT_CONTAINER_PREFIX: &str = "agent-vm-artifact-";
const VM_STARTUP_WAIT_TIMEOUT: Duration = Duration::from_secs(5);
const VM_STARTUP_POLL_INTERVAL: Duration = Duration::from_millis(100);
pub(crate) const AGENT_VM_IMAGE_LABEL_KEY: &str = "com.portico.ai-chat.image-role";
pub(crate) const AGENT_VM_IMAGE_LABEL_VALUE: &str = "agent-vm";
const AGENT_VM_REQUIRED_RUNTIME_BINARIES: [&str; 4] = ["bash", "python3", "node", "jq"];
/// The published Agent VM release image repository. Only refs in exactly this
/// repo (with an explicit tag) may be pulled automatically — the same repo
/// gate the Python managers apply via HARBOR_REGISTRY (agent_vm_manager.py,
/// script_executor.py), narrowed to this image's repo.
///
/// The recovery pull sends no registry credentials: the Docker daemon runs
/// Harbor's anonymous bearer-token flow itself. Verified 2026-07-09: the
/// Harbor token endpoint issues pull-scoped tokens for this repository
/// without authentication (the same property install_v2.sh relies on when it
/// pulls this image without a docker login).
const AGENT_VM_HARBOR_IMAGE_REPO: &str = "harbor.example.invalid/portico/agent-vm";
/// Upper bound for the synchronous recovery pull inside VM creation. The
/// first create_vm after an image prune blocks for the pull duration (up to
/// this cap) — a visible delay, preferred over today's unrecoverable
/// failure; progress is logged, and a timeout still yields an actionable
/// error.
const AGENT_VM_IMAGE_PULL_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone)]
pub(crate) struct VmInfo {
    pub(crate) vm_id: String,
    pub(crate) container_id: String,
    pub(crate) chat_id: String,
    pub(crate) created_at: f64,
    pub(crate) last_activity: f64,
    pub(crate) timeout_hours: f64,
    pub(crate) status: String,
    pub(crate) sharing_key: Option<String>,
    pub(crate) network_enabled: bool,
    pub(crate) port_mappings: BTreeMap<String, u16>,
    /// Set from the /work bind-mount source; never recompute from chat_id/vm_id.
    pub(crate) work_bind_source: Option<String>,
    /// True only when work_bind_source came from the actual /work bind source.
    pub(crate) work_bind_source_verified: bool,
}

#[derive(Debug)]
pub(crate) struct ExecResult {
    pub(crate) exit_code: i64,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
}

#[derive(Debug, Clone)]
struct FakeVmState {
    status: String,
    name: String,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct VmCleanupReport {
    pub(crate) expired: usize,
    pub(crate) stale_metadata: usize,
    pub(crate) orphaned: usize,
}

#[derive(Debug, Clone)]
pub(crate) struct ResolvedVmRequest {
    pub(crate) requested_vm_id: String,
    pub(crate) effective_vm: VmInfo,
}

impl ResolvedVmRequest {
    pub(crate) fn vm_id_changed(&self) -> bool {
        self.requested_vm_id != self.effective_vm.vm_id
    }
}

pub(crate) struct ChatVmResolutionLockGuard {
    key: String,
    token: String,
    released: bool,
}

impl ChatVmResolutionLockGuard {
    pub(crate) async fn acquire(chat_id: &str) -> Result<Self> {
        let key = format!("{VM_CHAT_RESOLUTION_LOCK_PREFIX}{chat_id}");
        let token = Uuid::new_v4().to_string();
        let deadline = Instant::now() + VM_CHAT_RESOLUTION_LOCK_WAIT;

        loop {
            if redis_set_nx_ex_string(&key, &token, VM_CHAT_RESOLUTION_LOCK_TTL_SECONDS)? {
                return Ok(Self {
                    key,
                    token,
                    released: false,
                });
            }
            if Instant::now() >= deadline {
                bail!("timed out acquiring Agent VM resolution lock for chat {chat_id}");
            }
            tokio::time::sleep(VM_CHAT_RESOLUTION_LOCK_POLL_INTERVAL).await;
        }
    }

    fn release(&mut self) {
        if self.released {
            return;
        }
        let _ = redis_compare_delete(&self.key, &self.token);
        self.released = true;
    }
}

impl Drop for ChatVmResolutionLockGuard {
    fn drop(&mut self) {
        self.release();
    }
}

impl VmCleanupReport {
    pub(crate) fn total(self) -> usize {
        self.expired + self.stale_metadata + self.orphaned
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ManagedVmContainer {
    pub(crate) container_id: String,
    pub(crate) name: String,
}

#[cfg(test)]
static WORK_BIND_SOURCE_LOOKUPS: OnceLock<Mutex<HashMap<String, usize>>> = OnceLock::new();
#[cfg(test)]
static WORK_BIND_SOURCE_INSPECTS: OnceLock<Mutex<HashMap<String, usize>>> = OnceLock::new();
#[cfg(test)]
static FAKE_WORK_BIND_SOURCE_INSPECTS: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();

const TEST_DOCKER_ENV: &str = "CORE_MCP_TEST_DOCKER";

impl VmInfo {
    pub(crate) fn to_json(&self) -> Value {
        json!({
            "vm_id": self.vm_id,
            "container_id": self.container_id,
            "chat_id": self.chat_id,
            "created_at": self.created_at,
            "last_activity": self.last_activity,
            "timeout_hours": self.timeout_hours,
            "status": self.status,
            "sharing_key": self.sharing_key,
            "network_enabled": self.network_enabled,
            "port_mappings": self.port_mappings,
            "work_bind_source": self.work_bind_source,
            "work_bind_source_verified": self.work_bind_source_verified,
        })
    }

    pub(crate) fn from_json(value: &Value) -> Result<Self> {
        let object = value.as_object().context("VM info is not an object")?;
        let port_mappings = object
            .get("port_mappings")
            .and_then(Value::as_object)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|(key, value)| {
                        value.as_u64().map(|port| (key.clone(), port as u16))
                    })
                    .collect::<BTreeMap<_, _>>()
            })
            .unwrap_or_default();
        Ok(Self {
            vm_id: object
                .get("vm_id")
                .and_then(Value::as_str)
                .context("missing vm_id")?
                .to_string(),
            container_id: object
                .get("container_id")
                .and_then(Value::as_str)
                .context("missing container_id")?
                .to_string(),
            chat_id: object
                .get("chat_id")
                .and_then(Value::as_str)
                .context("missing chat_id")?
                .to_string(),
            created_at: object
                .get("created_at")
                .and_then(Value::as_f64)
                .context("missing created_at")?,
            last_activity: object
                .get("last_activity")
                .and_then(Value::as_f64)
                .context("missing last_activity")?,
            timeout_hours: object
                .get("timeout_hours")
                .and_then(Value::as_f64)
                .context("missing timeout_hours")?,
            status: object
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("running")
                .to_string(),
            sharing_key: object
                .get("sharing_key")
                .and_then(Value::as_str)
                .map(str::to_string),
            network_enabled: object
                .get("network_enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            port_mappings,
            work_bind_source: object
                .get("work_bind_source")
                .and_then(Value::as_str)
                .map(str::to_string),
            work_bind_source_verified: object
                .get("work_bind_source_verified")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
    }
}

pub(crate) fn success_json_message(vm_id: &str, message: String) -> Value {
    json!({"content": [{"type": "text", "text": serde_json::to_string_pretty(&json!({"success": true, "vm_id": vm_id, "message": message})).unwrap_or_else(|_| "{\"success\":true}".to_string())}], "structuredContent": Value::Null, "isError": false})
}

pub(crate) async fn create_vm(
    chat_id: &str,
    timeout_hours: f64,
    sharing_key: Option<String>,
) -> Result<VmInfo> {
    let vm_id = Uuid::new_v4().to_string();
    create_vm_with_id(&vm_id, chat_id, timeout_hours, sharing_key).await
}

pub(crate) async fn create_vm_with_id(
    vm_id: &str,
    chat_id: &str,
    timeout_hours: f64,
    sharing_key: Option<String>,
) -> Result<VmInfo> {
    let now = now_epoch_seconds();
    let vm_info = if fake_docker_enabled() {
        let workspace_path = prepare_workspace(chat_id, vm_id)?;
        let container_name = format!("{CONTAINER_PREFIX}{vm_id}");
        let vm_info = VmInfo {
            vm_id: vm_id.to_string(),
            container_id: format!("fake-{vm_id}"),
            chat_id: chat_id.to_string(),
            created_at: now,
            last_activity: now,
            timeout_hours,
            status: "running".to_string(),
            sharing_key,
            network_enabled: true,
            port_mappings: BTreeMap::new(),
            work_bind_source: Some(workspace_path.display().to_string()),
            work_bind_source_verified: true,
        };
        fake_vm_registry()
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .insert(
                vm_info.container_id.clone(),
                FakeVmState {
                    status: "running".to_string(),
                    name: container_name,
                },
            );
        vm_info
    } else {
        let workspace_path = prepare_workspace(chat_id, vm_id)?;
        let container_name = format!("{CONTAINER_PREFIX}{vm_id}");
        let docker = docker_client()?;
        validate_agent_vm_image(&docker).await?;
        let config = ContainerCreateBody {
            image: Some(agent_vm_image_name()),
            cmd: Some(vec![
                "sh".to_string(),
                "-lc".to_string(),
                "rm -rf /workspace 2>/dev/null || true; ln -s /work /workspace 2>/dev/null || true; tail -f /dev/null".to_string(),
            ]),
            working_dir: Some("/work".to_string()),
            host_config: Some(HostConfig {
                binds: Some(vec![format!("{}:/work:rw", workspace_path.display())]),
                network_mode: Some(agent_vm_network_name()),
                memory: Some(VM_MEMORY_LIMIT_BYTES),
                cpu_period: Some(VM_CPU_PERIOD),
                cpu_quota: Some(VM_CPU_QUOTA),
                ..Default::default()
            }),
            ..Default::default()
        };
        docker
            .create_container(
                Some(CreateContainerOptions {
                    name: Some(container_name.clone()),
                    platform: String::new(),
                }),
                config,
            )
            .await
            .with_context(|| format!("failed to create VM container {container_name}"))?;
        docker
            .start_container(&container_name, None::<StartContainerOptions>)
            .await?;
        let inspect = docker
            .inspect_container(&container_name, None::<InspectContainerOptions>)
            .await?;
        let vm_info = VmInfo {
            vm_id: vm_id.to_string(),
            container_id: inspect.id.context("VM inspect response missing id")?,
            chat_id: chat_id.to_string(),
            created_at: now,
            last_activity: now,
            timeout_hours,
            status: "running".to_string(),
            sharing_key,
            network_enabled: true,
            port_mappings: BTreeMap::new(),
            work_bind_source: Some(workspace_path.display().to_string()),
            work_bind_source_verified: true,
        };

        wait_for_vm_container_running(&vm_info).await?;

        if let Err(error) = validate_vm_runtime_prereqs(&vm_info).await {
            let _ = docker
                .remove_container(
                    &container_name,
                    Some(bollard::query_parameters::RemoveContainerOptions {
                        force: true,
                        ..Default::default()
                    }),
                )
                .await;
            return Err(error);
        }

        vm_info
    };
    store_vm_info(&vm_info)?;
    Ok(vm_info)
}

pub(crate) fn agent_vm_cleanup_interval() -> Option<Duration> {
    let seconds = std::env::var(AGENT_VM_CLEANUP_INTERVAL_SECONDS_ENV)
        .ok()
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .unwrap_or(DEFAULT_AGENT_VM_CLEANUP_INTERVAL_SECONDS);
    (seconds > 0.0).then(|| Duration::from_secs_f64(seconds))
}

fn vm_is_expired(vm_info: &VmInfo, now: f64) -> bool {
    (now - vm_info.last_activity).max(0.0) > (vm_info.timeout_hours * 3600.0)
}

fn clear_file_reads(vm_id: &str) -> Result<()> {
    redis_delete(&format!("{FILE_READS_PREFIX}{vm_id}"))
}

fn cleanup_vm_metadata(vm_info: &VmInfo) -> Result<()> {
    // Preserve host workspace files; Agent VM cleanup only removes container
    // metadata and leaves the chat workspace untouched.
    clear_file_reads(&vm_info.vm_id)?;
    clear_default_vm_mapping_if_matches(&vm_info.chat_id, &vm_info.vm_id)?;
    delete_vm_info(&vm_info.vm_id)?;
    Ok(())
}

pub(crate) fn list_managed_vm_infos() -> Result<Vec<VmInfo>> {
    let mut infos = Vec::new();
    for key in crate::native::shared::redis_scan_keys(&format!("{VM_INFO_PREFIX}*"))? {
        let Some(raw) = redis_get_string(&key)? else {
            continue;
        };

        match serde_json::from_str::<Value>(&raw)
            .map_err(anyhow::Error::from)
            .and_then(|value| VmInfo::from_json(&value))
        {
            Ok(vm_info) => infos.push(vm_info),
            Err(error) => {
                warn!("ignoring invalid Agent VM metadata at {key}: {error:#}");
                let _ = redis_delete(&key);
            }
        }
    }
    Ok(infos)
}

fn vm_id_from_container_name(name: &str) -> Option<String> {
    let name = name.trim_start_matches('/');
    if name.starts_with(ARTIFACT_CONTAINER_PREFIX) {
        return None;
    }
    name.strip_prefix(CONTAINER_PREFIX).map(str::to_string)
}

fn vm_container_status_is_active(status: &str) -> bool {
    matches!(status, "created" | "restarting" | "running" | "paused")
}

pub(crate) fn load_matching_vm_info_for_container(
    container: &ManagedVmContainer,
) -> Result<Option<VmInfo>> {
    let Some(vm_id) = vm_id_from_container_name(&container.name) else {
        return Ok(None);
    };
    Ok(load_vm_info(&vm_id)?.filter(|vm_info| vm_info.container_id == container.container_id))
}

async fn list_managed_vm_containers() -> Result<Vec<ManagedVmContainer>> {
    if fake_docker_enabled() {
        return Ok(fake_vm_registry()
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .iter()
            .filter_map(|(container_id, state)| {
                vm_id_from_container_name(&state.name).map(|_| ManagedVmContainer {
                    container_id: container_id.clone(),
                    name: state.name.clone(),
                })
            })
            .collect());
    }

    let docker = docker_client()?;
    let filters = HashMap::from([(String::from("name"), vec![CONTAINER_PREFIX.to_string()])]);
    let containers = docker
        .list_containers(Some(
            ListContainersOptionsBuilder::default()
                .all(true)
                .filters(&filters)
                .build(),
        ))
        .await
        .context("failed to list Agent VM containers")?;

    Ok(containers
        .into_iter()
        .filter_map(|container| {
            let container_id = container.id?;
            let name = container
                .names
                .and_then(|names| {
                    names
                        .into_iter()
                        .find(|name| name.trim_start_matches('/').starts_with(CONTAINER_PREFIX))
                })
                .unwrap_or_default();
            (!name.is_empty()
                && !name
                    .trim_start_matches('/')
                    .starts_with(ARTIFACT_CONTAINER_PREFIX))
            .then_some(ManagedVmContainer { container_id, name })
        })
        .collect())
}

pub(crate) async fn remove_vm_container_by_id(container_id: &str) -> Result<()> {
    if fake_docker_enabled() {
        fake_vm_registry()
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .remove(container_id);
        return Ok(());
    }

    let docker = docker_client()?;
    let _ = docker
        .remove_container(
            container_id,
            Some(RemoveContainerOptions {
                force: true,
                ..Default::default()
            }),
        )
        .await;
    Ok(())
}

pub(crate) async fn cleanup_agent_vms_once() -> Result<VmCleanupReport> {
    let mut report = VmCleanupReport::default();
    let _ = cleanup_expired_sensitive_info_files_once().await;
    let now = now_epoch_seconds();
    let vm_infos = list_managed_vm_infos()?;
    let mut managed_container_ids = HashSet::new();

    for vm_info in vm_infos {
        managed_container_ids.insert(vm_info.container_id.clone());

        if vm_is_expired(&vm_info, now) {
            info!(
                vm_id = %vm_info.vm_id,
                timeout_hours = vm_info.timeout_hours,
                "cleaning up expired Agent VM"
            );
            remove_vm_container(&vm_info).await?;
            cleanup_vm_metadata(&vm_info)?;
            report.expired += 1;
            continue;
        }

        match inspect_vm_container_status(&vm_info).await? {
            Some(status) if vm_container_status_is_active(&status) => {
                persist_vm_state(&vm_info)?;
            }
            Some(status) => {
                info!(
                    vm_id = %vm_info.vm_id,
                    status = %status,
                    "cleaning up stale Agent VM metadata for non-running container"
                );
                remove_vm_container(&vm_info).await?;
                cleanup_vm_metadata(&vm_info)?;
                report.stale_metadata += 1;
            }
            None => {
                info!(
                    vm_id = %vm_info.vm_id,
                    "cleaning up stale Agent VM metadata for missing container"
                );
                cleanup_vm_metadata(&vm_info)?;
                report.stale_metadata += 1;
            }
        }
    }

    for container in list_managed_vm_containers().await? {
        if managed_container_ids.contains(&container.container_id) {
            continue;
        }

        // A container can be created after the SCAN above. Re-read its exact
        // metadata key immediately before removal so a concurrent create is
        // not mistaken for an orphan.
        if let Some(vm_info) = load_matching_vm_info_for_container(&container)? {
            persist_vm_state(&vm_info)?;
            continue;
        }

        info!(
            container_id = %container.container_id,
            container_name = %container.name,
            "cleaning up orphaned Agent VM container without Redis metadata"
        );
        remove_vm_container_by_id(&container.container_id).await?;
        if let Some(vm_id) = vm_id_from_container_name(&container.name) {
            let _ = clear_file_reads(&vm_id);
            let _ = delete_vm_info(&vm_id);
        }
        report.orphaned += 1;
    }

    if report.total() > 0 {
        info!(
            expired = report.expired,
            stale_metadata = report.stale_metadata,
            orphaned = report.orphaned,
            "Agent VM cleanup sweep completed"
        );
    }

    Ok(report)
}

#[rustfmt::skip]
pub(crate) async fn exec_in_vm(vm: &VmInfo, command: &str) -> Result<ExecResult> {
    exec_argv_in_vm(
        vm,
        &[
            "bash".to_string(),
            "-lc".to_string(),
            command.to_string(),
        ],
    )
    .await
}

#[rustfmt::skip]
pub(crate) async fn exec_argv_in_vm(vm: &VmInfo, argv: &[String]) -> Result<ExecResult> {
    if argv.is_empty() {
        bail!("command must not be empty");
    }
    if fake_docker_enabled() {
        let mut command = Command::new(if argv[0].starts_with("/work/") || argv[0].starts_with("/tmp/") {
            vm_host_path(vm, &argv[0])?
        } else {
            PathBuf::from(&argv[0])
        });
        for arg in &argv[1..] {
            if arg.starts_with("/work/") || arg.starts_with("/tmp/") {
                command.arg(vm_host_path(vm, arg)?);
            } else {
                command.arg(arg);
            }
        }
        let output = command
            .current_dir(vm_workspace_root(vm))
            .output()
            .await
            .context("failed to execute fake VM command")?;
        return Ok(ExecResult {
            exit_code: output.status.code().unwrap_or_default() as i64,
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }
    let docker = docker_client()?;
    let exec = docker
        .create_exec(
            &vm.container_id,
            CreateExecOptions {
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                cmd: Some(argv.to_vec()),
                working_dir: Some("/work".to_string()),
                ..Default::default()
            },
        )
        .await?;
    let mut stdout = String::new();
    let mut stderr = String::new();
    let start_exec_result = docker.start_exec(&exec.id, None).await?;
    if let StartExecResults::Attached { mut output, .. } = start_exec_result { while let Some(chunk) = output.next().await { let chunk = chunk?; if let LogOutput::StdOut { message } = &chunk { stdout.push_str(&String::from_utf8_lossy(message)); } if let LogOutput::StdErr { message } = &chunk { stderr.push_str(&String::from_utf8_lossy(message)); } } }
    let inspect = docker.inspect_exec(&exec.id).await?;
    Ok(ExecResult { exit_code: inspect.exit_code.unwrap_or_default(), stdout, stderr })
}

pub(crate) fn load_vm(vm_id: &str) -> Result<VmInfo> {
    let Some(raw) = redis_get_string(&format!("{VM_INFO_PREFIX}{vm_id}"))? else {
        bail!("No Agent VM found with vm_id: {vm_id}");
    };
    VmInfo::from_json(&serde_json::from_str(&raw)?)
}

pub(crate) fn load_vm_info(vm_id: &str) -> Result<Option<VmInfo>> {
    match load_vm(vm_id) {
        Ok(info) => Ok(Some(info)),
        Err(error) if error.to_string().contains("No Agent VM found") => Ok(None),
        Err(error) => Err(error),
    }
}

pub(crate) fn store_vm_info(vm_info: &VmInfo) -> Result<()> {
    redis_set_string(
        &format!("{VM_INFO_PREFIX}{}", vm_info.vm_id),
        &serde_json::to_string(&vm_info.to_json())?,
    )
}

fn persist_vm_state(vm_info: &VmInfo) -> Result<()> {
    redis_persist(&format!("{VM_INFO_PREFIX}{}", vm_info.vm_id))?;
    let mapping_key = default_vm_key(&vm_info.chat_id);
    if redis_get_string(&mapping_key)?.as_deref() == Some(vm_info.vm_id.as_str()) {
        redis_persist(&mapping_key)?;
    }
    Ok(())
}

pub(crate) fn delete_vm_info(vm_id: &str) -> Result<()> {
    redis_delete(&format!("{VM_INFO_PREFIX}{vm_id}"))
}

pub(crate) fn touch_vm_activity(vm_id: &str) -> Result<()> {
    if let Some(mut vm_info) = load_vm_info(vm_id)? {
        vm_info.last_activity = now_epoch_seconds();
        store_vm_info(&vm_info)?;
        refresh_default_vm_mapping_if_current(&vm_info)?;
    }
    Ok(())
}

pub(crate) fn default_vm_key(chat_id: &str) -> String {
    format!("agent_vm:{chat_id}")
}

fn recovery_alias_key(vm_id: &str) -> String {
    format!("{VM_RECOVERY_ALIAS_PREFIX}{vm_id}")
}

fn destroyed_vm_tombstone_key(vm_id: &str) -> String {
    format!("{VM_DESTROYED_TOMBSTONE_PREFIX}{vm_id}")
}

fn vm_mapping_ttl(vm_info: &VmInfo) -> u64 {
    ((vm_info.timeout_hours + 1.0) * 3600.0).round().max(1.0) as u64
}

pub(crate) fn store_default_vm_mapping(vm_info: &VmInfo) -> Result<()> {
    redis_set_string(&default_vm_key(&vm_info.chat_id), &vm_info.vm_id)
}

pub(crate) fn refresh_default_vm_mapping_if_current(vm_info: &VmInfo) -> Result<()> {
    let key = default_vm_key(&vm_info.chat_id);
    if redis_get_string(&key)?.as_deref() == Some(vm_info.vm_id.as_str()) {
        redis_set_string(&key, &vm_info.vm_id)?;
    }
    Ok(())
}

pub(crate) fn clear_default_vm_mapping_if_matches(chat_id: &str, vm_id: &str) -> Result<()> {
    let key = default_vm_key(chat_id);
    if redis_get_string(&key)?.as_deref() == Some(vm_id) {
        redis_delete(&key)?;
    }
    Ok(())
}

pub(crate) fn load_default_vm_for_chat(chat_id: &str) -> Result<Option<VmInfo>> {
    let key = default_vm_key(chat_id);
    let Some(vm_id) = redis_get_string(&key)? else {
        return Ok(None);
    };
    match load_vm_info(&vm_id)? {
        Some(vm_info) if vm_info.chat_id == chat_id => Ok(Some(vm_info)),
        Some(vm_info) => {
            warn!(
                mapping_chat_id = %chat_id,
                vm_id = %vm_info.vm_id,
                owner_chat_id = %vm_info.chat_id,
                "removed cross-chat default Agent VM mapping"
            );
            redis_delete(&key)?;
            Ok(None)
        }
        None => {
            redis_delete(&key)?;
            Ok(None)
        }
    }
}

pub(crate) fn store_vm_recovery_alias(source_vm_id: &str, vm_info: &VmInfo) -> Result<()> {
    if source_vm_id == vm_info.vm_id {
        return Ok(());
    }
    redis_setex_string(
        &recovery_alias_key(source_vm_id),
        &vm_info.vm_id,
        vm_mapping_ttl(vm_info),
    )
}

pub(crate) fn mark_vm_destroyed(vm_id: &str, owner_chat_id: &str) -> Result<()> {
    redis_setex_string(
        &destroyed_vm_tombstone_key(vm_id),
        owner_chat_id,
        VM_DESTROYED_TOMBSTONE_TTL_SECONDS,
    )
}

fn load_vm_recovery_alias_target(vm_id: &str) -> Result<Option<String>> {
    let key = recovery_alias_key(vm_id);
    let Some(target_vm_id) = redis_get_string(&key)? else {
        return Ok(None);
    };
    if target_vm_id == vm_id {
        redis_delete(&key)?;
        return Ok(None);
    }
    Ok(Some(target_vm_id))
}

pub(crate) fn is_usable_container_status(status: &str) -> bool {
    matches!(status, "created" | "restarting" | "running" | "paused")
}

fn resolve_vm_alias_chain(requested_vm_id: &str) -> Result<String> {
    let mut current_vm_id = requested_vm_id.to_string();
    let mut seen = HashSet::new();

    while seen.insert(current_vm_id.clone()) {
        let Some(next_vm_id) = load_vm_recovery_alias_target(&current_vm_id)? else {
            break;
        };
        current_vm_id = next_vm_id;
    }

    Ok(current_vm_id)
}

fn locate_recoverable_workspace(
    vm_id: &str,
    preferred_chat_id: Option<&str>,
) -> Result<Option<(String, PathBuf)>> {
    let root = local_workspace_path(&host_workspaces_dir()?)?;

    if let Some(chat_id) = preferred_chat_id {
        let candidate = root.join(chat_id).join(vm_id);
        if candidate.is_dir() {
            return Ok(Some((chat_id.to_string(), candidate)));
        }
        let chat_root = root.join(chat_id);
        if chat_root.is_dir() {
            return Ok(Some((chat_id.to_string(), chat_root)));
        }
    }

    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };

    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let chat_id = entry.file_name().to_string_lossy().to_string();
        let candidate = entry.path().join(vm_id);
        if candidate.is_dir() {
            return Ok(Some((chat_id, candidate)));
        }
    }

    Ok(None)
}

async fn recover_vm_from_workspace(
    source_vm_id: &str,
    preferred_chat_id: Option<&str>,
    timeout_hours: Option<f64>,
) -> Result<Option<VmInfo>> {
    let Some((chat_id, source_workspace_root)) =
        locate_recoverable_workspace(source_vm_id, preferred_chat_id)?
    else {
        return Ok(None);
    };

    let timeout_hours = timeout_hours.unwrap_or_else(default_vm_timeout_hours);
    let recovered_vm = create_vm(&chat_id, timeout_hours, None).await?;
    // Legacy-content salvage only applies to canonical (generated) workspaces.
    // A custom-workspace chat binds /work to the user's own directory, which
    // persisted independently of the dead VM and is not mounted into this
    // process — recovery must rebind it as-is, not bail on the copy.
    if chat_workspace_binding(&chat_id)?.canonical {
        let recovered_workspace_root = local_vm_workspace_root(&chat_id, &recovered_vm.vm_id)?;
        copy_path_preserving_conflicts(
            &source_workspace_root,
            &recovered_workspace_root,
            &format!("legacy-{source_vm_id}"),
        )?;
    }
    store_default_vm_mapping(&recovered_vm)?;
    store_vm_recovery_alias(source_vm_id, &recovered_vm)?;
    Ok(Some(recovered_vm))
}

pub(crate) async fn load_usable_default_vm_for_chat(chat_id: &str) -> Result<Option<VmInfo>> {
    let Some(vm_info) = load_default_vm_for_chat(chat_id)? else {
        return Ok(None);
    };

    match inspect_vm_container_status(&vm_info).await? {
        Some(status) if is_usable_container_status(status.as_str()) => Ok(Some(vm_info)),
        _ => {
            let _ = remove_vm_container(&vm_info).await;
            let _ = cleanup_vm_metadata(&vm_info);
            Ok(None)
        }
    }
}

async fn resolve_or_create_default_vm_for_chat(chat_id: &str) -> Result<VmInfo> {
    if let Some(vm_info) = load_usable_default_vm_for_chat(chat_id).await? {
        return Ok(vm_info);
    }

    let _guard = ChatVmResolutionLockGuard::acquire(chat_id).await?;
    if let Some(vm_info) = load_usable_default_vm_for_chat(chat_id).await? {
        return Ok(vm_info);
    }

    let vm_info = create_vm(chat_id, default_vm_timeout_hours(), None).await?;
    store_default_vm_mapping(&vm_info)?;
    Ok(vm_info)
}

async fn resolve_or_recover_default_vm_for_chat(
    chat_id: &str,
    source_vm_id: &str,
    timeout_hours: Option<f64>,
) -> Result<VmInfo> {
    if let Some(vm_info) = load_usable_default_vm_for_chat(chat_id).await? {
        return Ok(vm_info);
    }

    let _guard = ChatVmResolutionLockGuard::acquire(chat_id).await?;
    if let Some(vm_info) = load_usable_default_vm_for_chat(chat_id).await? {
        return Ok(vm_info);
    }

    if let Some(vm_info) =
        recover_vm_from_workspace(source_vm_id, Some(chat_id), timeout_hours).await?
    {
        return Ok(vm_info);
    }

    let vm_info = create_vm(
        chat_id,
        timeout_hours.unwrap_or_else(default_vm_timeout_hours),
        None,
    )
    .await?;
    store_default_vm_mapping(&vm_info)?;
    Ok(vm_info)
}

pub(crate) async fn resolve_vm_for_request(
    requested_vm_id: &str,
    preferred_chat_id: Option<&str>,
) -> Result<Option<ResolvedVmRequest>> {
    let preferred_chat_id = preferred_chat_id
        .map(str::trim)
        .filter(|chat_id| !chat_id.is_empty());
    let resolved_vm_id = resolve_vm_alias_chain(requested_vm_id)?;
    let destroyed_tombstone = redis_get_string(&destroyed_vm_tombstone_key(&resolved_vm_id))?;
    if let Some(destroyed_owner_chat_id) = destroyed_tombstone {
        if let Some(chat_id) = preferred_chat_id {
            if destroyed_owner_chat_id != "1" && destroyed_owner_chat_id != chat_id {
                let current_chat_vm = resolve_or_create_default_vm_for_chat(chat_id).await?;
                return Ok(Some(ResolvedVmRequest {
                    requested_vm_id: requested_vm_id.to_string(),
                    effective_vm: current_chat_vm,
                }));
            }
            if let Some(vm_info) = load_usable_default_vm_for_chat(chat_id).await? {
                return Ok(Some(ResolvedVmRequest {
                    requested_vm_id: requested_vm_id.to_string(),
                    effective_vm: vm_info,
                }));
            }
        }
        return Ok(None);
    }

    if let Some(vm_info) = load_vm_info(&resolved_vm_id)? {
        if preferred_chat_id.is_some_and(|chat_id| vm_info.chat_id != chat_id) {
            let current_chat_vm =
                resolve_or_create_default_vm_for_chat(preferred_chat_id.unwrap()).await?;
            return Ok(Some(ResolvedVmRequest {
                requested_vm_id: requested_vm_id.to_string(),
                effective_vm: current_chat_vm,
            }));
        }

        match inspect_vm_container_status(&vm_info).await? {
            Some(status) if is_usable_container_status(status.as_str()) => {
                if requested_vm_id != vm_info.vm_id {
                    store_vm_recovery_alias(requested_vm_id, &vm_info)?;
                }
                return Ok(Some(ResolvedVmRequest {
                    requested_vm_id: requested_vm_id.to_string(),
                    effective_vm: vm_info,
                }));
            }
            _ => {
                let _ = remove_vm_container(&vm_info).await;
                let _ = cleanup_vm_metadata(&vm_info);

                let recovered_vm = resolve_or_recover_default_vm_for_chat(
                    &vm_info.chat_id,
                    &resolved_vm_id,
                    Some(vm_info.timeout_hours),
                )
                .await?;
                if requested_vm_id != recovered_vm.vm_id {
                    store_vm_recovery_alias(requested_vm_id, &recovered_vm)?;
                }
                return Ok(Some(ResolvedVmRequest {
                    requested_vm_id: requested_vm_id.to_string(),
                    effective_vm: recovered_vm,
                }));
            }
        }
    }

    if let Some(chat_id) = preferred_chat_id {
        let current_chat_vm = resolve_or_create_default_vm_for_chat(chat_id).await?;
        return Ok(Some(ResolvedVmRequest {
            requested_vm_id: requested_vm_id.to_string(),
            effective_vm: current_chat_vm,
        }));
    }

    let Some(recovered_vm) = recover_vm_from_workspace(&resolved_vm_id, None, None).await? else {
        return Ok(None);
    };
    if requested_vm_id != recovered_vm.vm_id {
        store_vm_recovery_alias(requested_vm_id, &recovered_vm)?;
    }
    Ok(Some(ResolvedVmRequest {
        requested_vm_id: requested_vm_id.to_string(),
        effective_vm: recovered_vm,
    }))
}

pub(crate) fn register_file_read(vm_id: &str, path: &str) -> Result<()> {
    let key = format!("{FILE_READS_PREFIX}{vm_id}");
    let member = normalize_vm_path(path);
    redis_sadd(&key, &member)?;
    Ok(())
}

pub(crate) fn has_file_been_read(vm_id: &str, path: &str) -> Result<bool> {
    redis_sismember(
        &format!("{FILE_READS_PREFIX}{vm_id}"),
        &normalize_vm_path(path),
    )
}

pub(crate) fn docker_client() -> Result<Docker> {
    core_mcp_shared::connect_docker_client()
}

pub(crate) async fn inspect_vm_container_status(vm: &VmInfo) -> Result<Option<String>> {
    if fake_docker_enabled() {
        let status = fake_vm_registry()
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .get(&vm.container_id)
            .map(|state| state.status.clone());
        return Ok(status);
    }

    let docker = docker_client()?;
    let inspect = match docker
        .inspect_container(
            vm.container_id.as_str(),
            None::<bollard::query_parameters::InspectContainerOptions>,
        )
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

pub(crate) async fn remove_vm_container(vm: &VmInfo) -> Result<()> {
    remove_vm_container_by_id(&vm.container_id).await
}

#[derive(Debug, Clone)]
pub(crate) struct ChatWorkspaceBinding {
    pub(crate) host_path: PathBuf,
    pub(crate) canonical: bool,
}

fn collapse_home_path(path: &Path) -> String {
    let resolved = path.to_string_lossy().to_string();
    let Ok(home) = std::env::var("HOME") else {
        return resolved;
    };
    let home_path = PathBuf::from(home);
    if home_path.as_os_str().is_empty() || home_path == Path::new("/") {
        return resolved;
    }
    if path == home_path {
        return "~".to_string();
    }
    if let Ok(relative) = path.strip_prefix(&home_path) {
        return format!("~/{}", relative.to_string_lossy().replace('\\', "/"));
    }
    resolved
}

pub(crate) fn workspace_display_metadata(vm: &VmInfo) -> Value {
    let bind_source = vm
        .work_bind_source
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            host_workspaces_dir()
                .unwrap_or_else(|_| PathBuf::from("workspaces"))
                .join(&vm.chat_id)
        });
    let canonical_source = host_workspaces_dir()
        .map(|root| root.join(&vm.chat_id))
        .unwrap_or_else(|_| PathBuf::from("workspaces").join(&vm.chat_id));
    let is_custom = bind_source != canonical_source;
    let display_path = is_custom.then(|| collapse_home_path(&bind_source));
    json!({
        "source": if is_custom { "custom" } else { "canonical" },
        "internal_path": "/work",
        "display_path": display_path.clone().unwrap_or_default(),
        "message": if let Some(display_path) = display_path {
            format!("{display_path} is mounted inside the Agent VM at /work")
        } else {
            "Generated chat workspace is mounted inside the Agent VM at /work".to_string()
        },
    })
}

pub(crate) fn workspace_mode_for_vm(vm: &VmInfo) -> String {
    workspace_display_metadata(vm)
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("Generated chat workspace is mounted inside the Agent VM at /work")
        .to_string()
}

pub(crate) fn chat_workspace_binding(chat_id: &str) -> Result<ChatWorkspaceBinding> {
    let binding = core_mcp_shared::resolve_chat_workspace_binding(chat_id)?;
    Ok(ChatWorkspaceBinding {
        host_path: binding.host_path,
        canonical: binding.canonical,
    })
}

pub(crate) fn prepare_workspace(chat_id: &str, _vm_id: &str) -> Result<PathBuf> {
    let binding = chat_workspace_binding(chat_id)?;
    if binding.canonical {
        fs::create_dir_all(local_workspace_path(&binding.host_path)?)?;
    }
    Ok(binding.host_path)
}

pub(crate) fn host_chat_workspace_root(chat_id: &str) -> Result<PathBuf> {
    Ok(chat_workspace_binding(chat_id)?.host_path)
}

pub(crate) fn container_chat_workspace_root(chat_id: &str) -> Result<PathBuf> {
    Ok(container_workspaces_dir()?.join(chat_id))
}

pub(crate) fn host_vm_workspace_root(chat_id: &str, _vm_id: &str) -> Result<PathBuf> {
    host_chat_workspace_root(chat_id)
}

pub(crate) fn container_vm_workspace_root(chat_id: &str, _vm_id: &str) -> Result<PathBuf> {
    container_chat_workspace_root(chat_id)
}

pub(crate) fn local_workspace_path(path: &Path) -> Result<PathBuf> {
    core_mcp_shared::resolve_local_workspace_path(path)
}

pub(crate) fn local_chat_workspace_root(chat_id: &str) -> Result<PathBuf> {
    local_workspace_path(&host_chat_workspace_root(chat_id)?)
}

pub(crate) fn local_vm_workspace_root(chat_id: &str, vm_id: &str) -> Result<PathBuf> {
    local_workspace_path(&host_vm_workspace_root(chat_id, vm_id)?)
}

pub(crate) fn vm_workspace_root(vm: &VmInfo) -> PathBuf {
    resolve_local_work_bind_source(vm)
        .or_else(|_| local_vm_workspace_root(&vm.chat_id, &vm.vm_id))
        .unwrap_or_else(|_| PathBuf::from("."))
}

pub(crate) fn vm_shared_workspace_root(vm: &VmInfo) -> PathBuf {
    local_chat_workspace_root(&vm.chat_id).unwrap_or_else(|_| PathBuf::from("."))
}

pub(crate) fn agent_vm_image_name() -> String {
    std::env::var(AGENT_VM_IMAGE_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| AGENT_VM_IMAGE_NAME.to_string())
}

pub(crate) fn agent_vm_network_name() -> String {
    std::env::var(AGENT_VM_NETWORK_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| crate::native::DEFAULT_VM_NETWORK.to_string())
}

pub(crate) fn default_vm_timeout_hours() -> f64 {
    std::env::var(AGENT_VM_DEFAULT_TIMEOUT_HOURS_ENV)
        .ok()
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(crate::native::DEFAULT_VM_TIMEOUT_HOURS)
        .min(crate::native::MAX_VM_TIMEOUT_HOURS)
}

#[cfg(test)]
fn record_work_bind_source_lookup(vm_id: &str) {
    let mut counts = WORK_BIND_SOURCE_LOOKUPS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    *counts.entry(vm_id.to_string()).or_insert(0) += 1;
}

#[cfg(not(test))]
fn record_work_bind_source_lookup(_vm_id: &str) {}

#[cfg(test)]
fn record_work_bind_source_inspect(vm_id: &str) {
    let mut counts = WORK_BIND_SOURCE_INSPECTS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    *counts.entry(vm_id.to_string()).or_insert(0) += 1;
}

#[cfg(not(test))]
fn record_work_bind_source_inspect(_vm_id: &str) {}

#[cfg(test)]
pub(crate) fn work_bind_source_lookup_count(vm_id: &str) -> usize {
    WORK_BIND_SOURCE_LOOKUPS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .get(vm_id)
        .copied()
        .unwrap_or(0)
}

#[cfg(test)]
pub(crate) fn work_bind_source_inspect_count(vm_id: &str) -> usize {
    WORK_BIND_SOURCE_INSPECTS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .get(vm_id)
        .copied()
        .unwrap_or(0)
}

#[cfg(test)]
pub(crate) fn reset_work_bind_source_test_state() {
    WORK_BIND_SOURCE_LOOKUPS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clear();
    WORK_BIND_SOURCE_INSPECTS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clear();
    FAKE_WORK_BIND_SOURCE_INSPECTS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clear();
}

#[cfg(test)]
pub(crate) fn seed_fake_work_bind_source_inspect(vm_id: &str, path: PathBuf) {
    FAKE_WORK_BIND_SOURCE_INSPECTS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .insert(vm_id.to_string(), path);
}

fn inspect_work_bind_source_sync(vm: &VmInfo) -> Result<Option<PathBuf>> {
    record_work_bind_source_inspect(&vm.vm_id);

    if fake_docker_enabled() {
        #[cfg(test)]
        {
            return Ok(FAKE_WORK_BIND_SOURCE_INSPECTS
                .get_or_init(|| Mutex::new(HashMap::new()))
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .get(&vm.vm_id)
                .cloned());
        }
        #[cfg(not(test))]
        {
            return Ok(None);
        }
    }

    let vm = vm.clone();
    std::thread::spawn(move || -> Result<Option<PathBuf>> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .context("failed to build runtime for Agent VM mount inspection")?;
        runtime.block_on(async move {
            let docker = docker_client()?;
            let inspect = docker
                .inspect_container(
                    vm.container_id.as_str(),
                    None::<bollard::query_parameters::InspectContainerOptions>,
                )
                .await
                .with_context(|| {
                    format!(
                        "failed to inspect Agent VM container {} for /work bind source",
                        vm.container_id
                    )
                })?;
            Ok(inspect
                .mounts
                .unwrap_or_default()
                .into_iter()
                .find(|mount| mount.destination.as_deref() == Some("/work"))
                .and_then(|mount| mount.source)
                .map(PathBuf::from))
        })
    })
    .join()
    .map_err(|_| anyhow::anyhow!("failed to join Agent VM mount inspection thread"))?
}

pub(crate) fn resolve_work_bind_source(vm: &VmInfo) -> Result<PathBuf> {
    record_work_bind_source_lookup(&vm.vm_id);

    if vm.work_bind_source_verified {
        if let Some(source) = vm.work_bind_source.as_deref() {
            return Ok(PathBuf::from(source));
        }
    }

    let stored_vm = load_vm_info(&vm.vm_id)?;
    if let Some(stored_vm) = stored_vm.as_ref() {
        if stored_vm.work_bind_source_verified {
            if let Some(source) = stored_vm.work_bind_source.as_deref() {
                return Ok(PathBuf::from(source));
            }
        }
    }

    let recovered_source = inspect_work_bind_source_sync(vm)?.ok_or_else(|| {
        anyhow::anyhow!("Agent VM metadata missing verified /work bind source and Docker inspect could not recover it")
    })?;

    let stale_source = vm
        .work_bind_source
        .as_deref()
        .or_else(|| {
            stored_vm
                .as_ref()
                .and_then(|stored| stored.work_bind_source.as_deref())
        })
        .map(PathBuf::from);
    if let Some(stale_source) = stale_source {
        if stale_source != recovered_source {
            warn!(
                vm_id = %vm.vm_id,
                previous = %stale_source.display(),
                recovered = %recovered_source.display(),
                "reconciled stale Agent VM /work bind source metadata"
            );
        }
    }

    let mut updated_vm = stored_vm.unwrap_or_else(|| vm.clone());
    updated_vm.work_bind_source = Some(recovered_source.display().to_string());
    updated_vm.work_bind_source_verified = true;
    store_vm_info(&updated_vm)?;
    Ok(recovered_source)
}

pub(crate) fn resolve_local_work_bind_source(vm: &VmInfo) -> Result<PathBuf> {
    local_workspace_path(&resolve_work_bind_source(vm)?)
}

pub(crate) fn agent_vm_image_label_value(inspect: &bollard::models::ImageInspect) -> Option<&str> {
    inspect
        .config
        .as_ref()
        .and_then(|config| config.labels.as_ref())
        .and_then(|labels| labels.get(AGENT_VM_IMAGE_LABEL_KEY))
        .map(String::as_str)
}

pub(crate) fn inspect_error_indicates_missing_image(err: &bollard::errors::Error) -> bool {
    matches!(
        err,
        bollard::errors::Error::DockerResponseServerError {
            status_code: 404,
            ..
        }
    )
}

/// Whether an Agent VM image ref may be pulled automatically: exactly the
/// published Harbor release repo with an explicit, non-empty tag. Everything
/// else (legacy `agent-vm:latest`, docker-hub-implied refs, other
/// registries/repos, digest-only refs) is local-only.
pub(crate) fn image_ref_is_harbor_pullable(image_ref: &str) -> bool {
    let Some(rest) = image_ref.strip_prefix(AGENT_VM_HARBOR_IMAGE_REPO) else {
        return false;
    };
    let Some(tag) = rest.strip_prefix(':') else {
        // No tag, a digest-only ref, or a repo-name extension
        // (e.g. ".../agent-vm-extra:tag").
        return false;
    };
    !tag.is_empty()
}

pub(crate) fn missing_agent_vm_image_help(image_name: &str) -> String {
    if image_ref_is_harbor_pullable(image_name) {
        format!(
            "Agent VM image '{image_name}' is not available locally. Recover with: docker pull {image_name} — or restart Portico."
        )
    } else {
        format!(
            "Agent VM image '{image_name}' is not available locally. Restart Portico to restore it; for local dev builds, rebuild it with: docker build -f Dockerfile.agent-vm -t agent-vm:latest ."
        )
    }
}

async fn pull_agent_vm_image(docker: &Docker, image_name: &str) -> Result<()> {
    let pull = docker
        .create_image(
            Some(CreateImageOptions {
                from_image: Some(image_name.to_string()),
                ..Default::default()
            }),
            None,
            None,
        )
        .try_collect::<Vec<_>>();

    match tokio::time::timeout(AGENT_VM_IMAGE_PULL_TIMEOUT, pull).await {
        Ok(Ok(_)) => {
            info!("pulled Agent VM image {image_name}");
            Ok(())
        }
        Ok(Err(err)) => Err(err).with_context(|| {
            format!(
                "failed to pull Agent VM image {image_name}. {}",
                missing_agent_vm_image_help(image_name)
            )
        }),
        Err(_elapsed) => bail!(
            "timed out pulling Agent VM image {image_name} after {}s. {}",
            AGENT_VM_IMAGE_PULL_TIMEOUT.as_secs(),
            missing_agent_vm_image_help(image_name)
        ),
    }
}

async fn validate_agent_vm_image(docker: &Docker) -> Result<()> {
    let image_name = agent_vm_image_name();
    let inspect = match docker.inspect_image(&image_name).await {
        Ok(inspect) => inspect,
        Err(err) if inspect_error_indicates_missing_image(&err) => {
            if !image_ref_is_harbor_pullable(&image_name) {
                bail!("{}", missing_agent_vm_image_help(&image_name));
            }
            warn!("Agent VM image {image_name} not found locally; attempting Harbor pull");
            pull_agent_vm_image(docker, &image_name).await?;
            docker.inspect_image(&image_name).await.with_context(|| {
                format!("failed to inspect Agent VM image {image_name} after pull")
            })?
        }
        Err(err) => {
            return Err(err)
                .with_context(|| format!("failed to inspect Agent VM image {image_name}"))
        }
    };

    let Some(label_value) = agent_vm_image_label_value(&inspect) else {
        bail!(
            "Agent VM image '{}' is missing required '{}' label; rebuild it from Dockerfile.agent-vm",
            image_name,
            AGENT_VM_IMAGE_LABEL_KEY
        );
    };

    if label_value != AGENT_VM_IMAGE_LABEL_VALUE {
        bail!(
            "Agent VM image '{}' has invalid '{}' label value '{}'; expected '{}'",
            image_name,
            AGENT_VM_IMAGE_LABEL_KEY,
            label_value,
            AGENT_VM_IMAGE_LABEL_VALUE
        );
    }

    Ok(())
}

async fn validate_vm_runtime_prereqs(vm: &VmInfo) -> Result<()> {
    let image_name = agent_vm_image_name();
    let command = AGENT_VM_REQUIRED_RUNTIME_BINARIES
        .iter()
        .map(|binary| format!("command -v {binary} >/dev/null"))
        .collect::<Vec<_>>()
        .join(" && ");
    let result = exec_argv_in_vm(vm, &["bash".to_string(), "-lc".to_string(), command])
        .await
        .with_context(|| {
            format!("failed to validate runtime tools for Agent VM image {image_name}")
        })?;

    if result.exit_code != 0 {
        bail!(
            "Agent VM image '{}' is missing required runtime tools ({}). Rebuild it from Dockerfile.agent-vm. stdout: {} stderr: {}",
            image_name,
            AGENT_VM_REQUIRED_RUNTIME_BINARIES.join(", "),
            result.stdout.trim(),
            result.stderr.trim()
        );
    }

    Ok(())
}

pub(crate) async fn wait_for_vm_container_running(vm: &VmInfo) -> Result<()> {
    let deadline = Instant::now() + VM_STARTUP_WAIT_TIMEOUT;
    let mut last_status = "unknown".to_string();

    loop {
        match inspect_vm_container_status(vm).await? {
            Some(status) if matches!(status.as_str(), "running" | "paused") => return Ok(()),
            Some(status) if matches!(status.as_str(), "created" | "restarting") => {
                last_status = status;
            }
            Some(status) => {
                bail!(
                    "Agent VM container {} entered non-running state '{}' before startup completed",
                    short_container_id(&vm.container_id),
                    status
                );
            }
            None => {
                bail!(
                    "Agent VM container {} disappeared before startup completed",
                    short_container_id(&vm.container_id)
                );
            }
        }

        if Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(VM_STARTUP_POLL_INTERVAL).await;
    }

    bail!(
        "Agent VM container {} did not reach running state before startup completed (last status: {})",
        short_container_id(&vm.container_id),
        last_status
    );
}

pub(crate) fn short_container_id(container_id: &str) -> String {
    container_id.chars().take(12).collect()
}

pub(crate) fn format_bytes(size: u64) -> String {
    match size {
        0..=1023 => format!("{size} bytes"),
        1024..=1_048_575 => format!("{:.1} KB", size as f64 / 1024.0),
        _ => format!("{:.1} MB", size as f64 / (1024.0 * 1024.0)),
    }
}

pub(crate) fn fake_docker_enabled() -> bool {
    std::env::var(TEST_DOCKER_ENV).ok().as_deref() == Some("memory")
}

fn fake_vm_registry() -> &'static Mutex<BTreeMap<String, FakeVmState>> {
    static REGISTRY: OnceLock<Mutex<BTreeMap<String, FakeVmState>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(BTreeMap::new()))
}

#[cfg(test)]
pub(crate) fn seed_fake_vm_container(container_id: &str, name: &str, status: &str) {
    fake_vm_registry()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .insert(
            container_id.to_string(),
            FakeVmState {
                status: status.to_string(),
                name: name.to_string(),
            },
        );
}

#[cfg(test)]
pub(crate) fn reset_fake_vm_registry() {
    fake_vm_registry()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clear();
}
