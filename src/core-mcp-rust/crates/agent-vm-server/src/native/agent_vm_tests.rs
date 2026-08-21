use super::*;
use crate::native::shared::ToolDispatcher;
use crate::native::shared::{
    redis_get_string, redis_set_string, redis_setex_string, redis_smembers, redis_ttl,
};
use crate::native::TEST_ENV_LOCK;
use anyhow::{bail, Context};
use bollard::models::{ImageConfig, ImageInspect};
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::MutexGuard;
use uuid::Uuid;
use zip::write::SimpleFileOptions;

const TEST_AGENT_VM_IMAGE: &str = "core-mcp-rust-agent-vm-test:latest";
const TEST_AGENT_VM_NETWORK: &str = "core-mcp-rust-agent-vm-test-network";

pub(super) struct TestEnv {
    _guard: MutexGuard<'static, ()>,
    pub(crate) root: PathBuf,
    previous_cwd: PathBuf,
    previous_container_root: Option<String>,
    previous_host_root: Option<String>,
    previous_test_redis: Option<String>,
    previous_test_docker: Option<String>,
    previous_agent_vm_image: Option<String>,
    previous_agent_vm_network: Option<String>,
    previous_agent_vm_timeout: Option<String>,
    previous_agent_vm_cleanup_interval: Option<String>,
}

impl TestEnv {
    pub(super) fn new(name: &str) -> Self {
        let guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let root = env::temp_dir().join(format!(
            "core-mcp-rust-agent-vm-{name}-{}",
            Uuid::new_v4().simple()
        ));
        fs::create_dir_all(root.join("mcp-configs")).expect("create mcp-configs dir");
        fs::create_dir_all(root.join("mcp-configs-user")).expect("create mcp-configs-user dir");
        fs::create_dir_all(root.join("skills-user")).expect("create skills-user dir");
        let previous_cwd = env::current_dir().expect("get current dir");
        let previous_container_root = env::var("CONTAINER_PROJECT_ROOT").ok();
        let previous_host_root = env::var("HOST_PROJECT_ROOT").ok();
        let previous_test_redis = env::var("CORE_MCP_TEST_REDIS").ok();
        let previous_test_docker = env::var("CORE_MCP_TEST_DOCKER").ok();
        let previous_agent_vm_image = env::var("CORE_MCP_AGENT_VM_IMAGE").ok();
        let previous_agent_vm_network = env::var("CORE_MCP_AGENT_VM_NETWORK").ok();
        let previous_agent_vm_timeout = env::var("CORE_MCP_AGENT_VM_DEFAULT_TIMEOUT_HOURS").ok();
        let previous_agent_vm_cleanup_interval = env::var("AGENT_VM_CLEANUP_INTERVAL_SECONDS").ok();
        env::set_current_dir(&root).expect("set current dir");
        env::set_var("CONTAINER_PROJECT_ROOT", &root);
        env::set_var("HOST_PROJECT_ROOT", &root);
        env::set_var("CORE_MCP_TEST_REDIS", "memory");
        env::set_var("CORE_MCP_TEST_DOCKER", "memory");
        crate::native::shared::reset_test_redis_state();
        reset_fake_vm_registry();
        reset_work_bind_source_test_state();
        Self {
            _guard: guard,
            root,
            previous_cwd,
            previous_container_root,
            previous_host_root,
            previous_test_redis,
            previous_test_docker,
            previous_agent_vm_image,
            previous_agent_vm_network,
            previous_agent_vm_timeout,
            previous_agent_vm_cleanup_interval,
        }
    }

    pub(super) fn vm(&self, vm_id: &str, chat_id: &str) -> VmInfo {
        VmInfo {
            vm_id: vm_id.to_string(),
            container_id: "container-1234567890ab".to_string(),
            chat_id: chat_id.to_string(),
            created_at: 1.0,
            last_activity: 2.0,
            timeout_hours: 3.0,
            status: "running".to_string(),
            sharing_key: Some("shared".to_string()),
            network_enabled: true,
            port_mappings: BTreeMap::from([(String::from("3000/tcp"), 3000)]),
            work_bind_source: Some(
                host_vm_workspace_root(chat_id, vm_id)
                    .expect("vm workspace root")
                    .display()
                    .to_string(),
            ),
            work_bind_source_verified: true,
        }
    }

    pub(super) fn seed_vm(&self, vm_id: &str, chat_id: &str) -> VmInfo {
        let vm = self.vm(vm_id, chat_id);
        fs::create_dir_all(vm_workspace_root(&vm)).expect("create vm workspace");
        seed_fake_vm_container(&vm.container_id, &format!("agent-vm-{vm_id}"), "running");
        store_vm_info(&vm).expect("store vm info");
        vm
    }
}

pub(super) struct EnvGuard {
    previous: Vec<(String, Option<String>)>,
}

impl EnvGuard {
    pub(super) fn set(entries: &[(&str, Option<&str>)]) -> Self {
        let mut previous = Vec::new();
        for (key, value) in entries {
            previous.push(((*key).to_string(), env::var(key).ok()));
            match value {
                Some(value) => env::set_var(key, value),
                None => env::remove_var(key),
            }
        }
        Self { previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (key, value) in self.previous.drain(..) {
            match value {
                Some(value) => env::set_var(&key, value),
                None => env::remove_var(&key),
            }
        }
    }
}

struct DockerModeGuard {
    previous: Option<String>,
    previous_network: Option<String>,
}

impl DockerModeGuard {
    fn real() -> Self {
        let previous = env::var("CORE_MCP_TEST_DOCKER").ok();
        let previous_network = env::var("CORE_MCP_AGENT_VM_NETWORK").ok();
        env::remove_var("CORE_MCP_TEST_DOCKER");
        env::set_var("CORE_MCP_AGENT_VM_NETWORK", TEST_AGENT_VM_NETWORK);
        Self {
            previous,
            previous_network,
        }
    }
}

impl Drop for DockerModeGuard {
    fn drop(&mut self) {
        if let Some(value) = &self.previous {
            env::set_var("CORE_MCP_TEST_DOCKER", value);
        } else {
            env::remove_var("CORE_MCP_TEST_DOCKER");
        }
        if let Some(value) = &self.previous_network {
            env::set_var("CORE_MCP_AGENT_VM_NETWORK", value);
        } else {
            env::remove_var("CORE_MCP_AGENT_VM_NETWORK");
        }
    }
}

impl Drop for TestEnv {
    fn drop(&mut self) {
        let _ = env::set_current_dir(&self.previous_cwd);
        if let Some(value) = &self.previous_container_root {
            env::set_var("CONTAINER_PROJECT_ROOT", value);
        } else {
            env::remove_var("CONTAINER_PROJECT_ROOT");
        }
        if let Some(value) = &self.previous_host_root {
            env::set_var("HOST_PROJECT_ROOT", value);
        } else {
            env::remove_var("HOST_PROJECT_ROOT");
        }
        if let Some(value) = &self.previous_test_redis {
            env::set_var("CORE_MCP_TEST_REDIS", value);
        } else {
            env::remove_var("CORE_MCP_TEST_REDIS");
        }
        if let Some(value) = &self.previous_test_docker {
            env::set_var("CORE_MCP_TEST_DOCKER", value);
        } else {
            env::remove_var("CORE_MCP_TEST_DOCKER");
        }
        if let Some(value) = &self.previous_agent_vm_image {
            env::set_var("CORE_MCP_AGENT_VM_IMAGE", value);
        } else {
            env::remove_var("CORE_MCP_AGENT_VM_IMAGE");
        }
        if let Some(value) = &self.previous_agent_vm_network {
            env::set_var("CORE_MCP_AGENT_VM_NETWORK", value);
        } else {
            env::remove_var("CORE_MCP_AGENT_VM_NETWORK");
        }
        if let Some(value) = &self.previous_agent_vm_timeout {
            env::set_var("CORE_MCP_AGENT_VM_DEFAULT_TIMEOUT_HOURS", value);
        } else {
            env::remove_var("CORE_MCP_AGENT_VM_DEFAULT_TIMEOUT_HOURS");
        }
        if let Some(value) = &self.previous_agent_vm_cleanup_interval {
            env::set_var("AGENT_VM_CLEANUP_INTERVAL_SECONDS", value);
        } else {
            env::remove_var("AGENT_VM_CLEANUP_INTERVAL_SECONDS");
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn agent_vm_network_and_timeout_defaults_honor_env_overrides() {
    let _env = TestEnv::new("env-overrides");

    assert_eq!(agent_vm_network_name(), crate::native::DEFAULT_VM_NETWORK);
    assert_eq!(default_vm_timeout_hours(), 24.0);

    env::set_var(
        "CORE_MCP_AGENT_VM_NETWORK",
        "portico-agent-vm-network",
    );
    env::set_var("CORE_MCP_AGENT_VM_DEFAULT_TIMEOUT_HOURS", "1.25");
    assert_eq!(agent_vm_network_name(), "portico-agent-vm-network");
    assert_eq!(default_vm_timeout_hours(), 1.25);

    env::set_var("CORE_MCP_AGENT_VM_DEFAULT_TIMEOUT_HOURS", "99");
    assert_eq!(default_vm_timeout_hours(), MAX_VM_TIMEOUT_HOURS);

    env::set_var("CORE_MCP_AGENT_VM_DEFAULT_TIMEOUT_HOURS", "0");
    assert_eq!(default_vm_timeout_hours(), 24.0);
}

#[test]
fn agent_vm_cleanup_interval_honors_env_overrides() {
    let _env = TestEnv::new("cleanup-interval");

    assert_eq!(
        agent_vm_cleanup_interval(),
        Some(std::time::Duration::from_secs(60))
    );

    env::set_var("AGENT_VM_CLEANUP_INTERVAL_SECONDS", "5");
    assert_eq!(
        agent_vm_cleanup_interval(),
        Some(std::time::Duration::from_secs(5))
    );

    env::set_var("AGENT_VM_CLEANUP_INTERVAL_SECONDS", "0");
    assert_eq!(agent_vm_cleanup_interval(), None);

    env::set_var("AGENT_VM_CLEANUP_INTERVAL_SECONDS", "invalid");
    assert_eq!(
        agent_vm_cleanup_interval(),
        Some(std::time::Duration::from_secs(60))
    );

    env::remove_var("AGENT_VM_CLEANUP_INTERVAL_SECONDS");
}

pub(super) fn args(entries: &[(&str, Value)]) -> Map<String, Value> {
    entries
        .iter()
        .map(|(key, value)| ((*key).to_string(), value.clone()))
        .collect()
}

pub(super) fn response_payload(response: Value) -> Value {
    let text = response["content"]
        .as_array()
        .and_then(|content| {
            content.iter().find_map(|item| {
                (item.get("type").and_then(Value::as_str) == Some("text"))
                    .then(|| item.get("text").and_then(Value::as_str))
                    .flatten()
            })
        })
        .expect("missing response text");
    serde_json::from_str(text).expect("response should contain JSON")
}

pub(super) fn write_zip(path: &Path, files: &[(&str, &[u8])]) {
    let file = fs::File::create(path).expect("create zip file");
    let mut writer = zip::ZipWriter::new(file);
    for (name, contents) in files {
        if name.ends_with('/') {
            writer
                .add_directory(*name, SimpleFileOptions::default())
                .expect("start zip directory");
        } else {
            writer
                .start_file(name, SimpleFileOptions::default())
                .expect("start zip entry");
            writer.write_all(contents).expect("write zip entry");
        }
    }
    writer.finish().expect("finish zip");
}

async fn ensure_docker_prereqs() -> Result<bool> {
    if env::var("CORE_MCP_TEST_DOCKER").ok().as_deref() == Some("memory") {
        return Ok(false);
    }
    if docker_client().is_err() {
        return Ok(false);
    }

    env::set_var("CORE_MCP_AGENT_VM_IMAGE", TEST_AGENT_VM_IMAGE);

    if !image_has_expected_agent_vm_label(TEST_AGENT_VM_IMAGE) {
        let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(4)
            .expect("repo root")
            .to_path_buf();
        let status = std::process::Command::new("docker")
            .args([
                "build",
                "-f",
                "Dockerfile.agent-vm",
                "-t",
                TEST_AGENT_VM_IMAGE,
                ".",
            ])
            .current_dir(&repo_root)
            .status()
            .context("build isolated Agent VM test image")?;
        if !status.success() {
            bail!("failed to build isolated Agent VM test image");
        }
    }

    let docker = docker_client()?;
    let _ = docker
        .create_network(bollard::models::NetworkCreateRequest {
            name: agent_vm_network_name(),
            ..Default::default()
        })
        .await;
    Ok(true)
}

fn image_has_expected_agent_vm_label(image_ref: &str) -> bool {
    let output = match std::process::Command::new("docker")
        .args([
            "image",
            "inspect",
            "--format",
            "{{ index .Config.Labels \"com.portico.ai-chat.image-role\" }}",
            image_ref,
        ])
        .output()
    {
        Ok(output) if output.status.success() => output,
        _ => return false,
    };

    String::from_utf8_lossy(&output.stdout).trim() == AGENT_VM_IMAGE_LABEL_VALUE
}

fn docker_create_blocked(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.to_string().contains("Operation not permitted"))
}

#[test]
fn normalizes_paths_image_names_and_formats() {
    assert_eq!(normalize_vm_path("src/main.py"), "/work/src/main.py");
    assert_eq!(normalize_vm_path("/work/src/main.py"), "/work/src/main.py");
    assert!(sanitize_relative("../secret").is_err());
    assert_eq!(sanitize_relative("nested\\path").unwrap(), "nested/path");
    assert_eq!(agent_vm_image_name(), "agent-vm:latest");
    assert_eq!(short_container_id("1234567890abcdef"), "1234567890ab");
    assert_eq!(format_bytes(100), "100 bytes");
    assert_eq!(format_bytes(2048), "2.0 KB");
    assert_eq!(format_bytes(1_048_576), "1.0 MB");
}

#[test]
fn agent_vm_image_name_prefers_env_override() {
    let _env = TestEnv::new("image-env-override");

    env::set_var(
        "CORE_MCP_AGENT_VM_IMAGE",
        "harbor.example.invalid/portico/agent-vm:03162026-b980177b",
    );

    assert_eq!(
        agent_vm_image_name(),
        "harbor.example.invalid/portico/agent-vm:03162026-b980177b"
    );
}

#[test]
fn agent_vm_image_label_helper_reads_expected_value() {
    let inspect = ImageInspect::default();
    assert_eq!(agent_vm_image_label_value(&inspect), None);

    let inspect = ImageInspect {
        config: Some(ImageConfig {
            labels: Some(
                BTreeMap::from([(
                    AGENT_VM_IMAGE_LABEL_KEY.to_string(),
                    AGENT_VM_IMAGE_LABEL_VALUE.to_string(),
                )])
                .into_iter()
                .collect(),
            ),
            ..Default::default()
        }),
        ..Default::default()
    };
    assert_eq!(
        agent_vm_image_label_value(&inspect),
        Some(AGENT_VM_IMAGE_LABEL_VALUE)
    );
}

#[test]
fn agent_vm_harbor_pullable_ref_classification() {
    // Only the published release repo with an explicit non-empty tag.
    assert!(image_ref_is_harbor_pullable(
        "harbor.example.invalid/portico/agent-vm:07072026-4d073bb9"
    ));

    for local_only in [
        "harbor.example.invalid/portico/agent-vm",
        "harbor.example.invalid/portico/agent-vm:",
        "harbor.example.invalid/other-project/agent-vm:tag",
        "harbor.example.invalid/portico/agent-vm-extra:tag",
        "harbor.example.invalid/portico/agent-vm@sha256:abc",
        "agent-vm:latest",
        "library/agent-vm:latest",
        "localhost:5000/agent-vm:dev",
        "registry.example.com/agent-vm:1",
        "",
    ] {
        assert!(
            !image_ref_is_harbor_pullable(local_only),
            "expected local-only classification for {local_only:?}"
        );
    }
}

#[test]
fn agent_vm_inspect_error_classification() {
    let missing = bollard::errors::Error::DockerResponseServerError {
        status_code: 404,
        message: "no such image".to_string(),
    };
    assert!(inspect_error_indicates_missing_image(&missing));

    let server_error = bollard::errors::Error::DockerResponseServerError {
        status_code: 500,
        message: "boom".to_string(),
    };
    assert!(!inspect_error_indicates_missing_image(&server_error));
}

#[test]
fn missing_agent_vm_image_help_is_variant_aware() {
    let harbor_help = missing_agent_vm_image_help(
        "harbor.example.invalid/portico/agent-vm:07072026-4d073bb9",
    );
    assert!(harbor_help.contains("docker pull harbor.example.invalid/portico/agent-vm:"));

    let local_help = missing_agent_vm_image_help("agent-vm:latest");
    assert!(local_help.contains("Dockerfile.agent-vm"));
    assert!(
        !local_help.contains("docker pull"),
        "local-only refs must not be given a docker pull instruction"
    );
}

#[tokio::test]
async fn fake_memory_backend_covers_registry_status_exec_and_cleanup() {
    let _env = TestEnv::new("fake-backend");

    let vm = create_vm("chat-fake", 2.0, Some("shared-fake".to_string()))
        .await
        .expect("create fake vm");
    assert!(vm.container_id.starts_with("fake-"));

    let status = inspect_vm_container_status(&vm)
        .await
        .expect("inspect fake vm status");
    assert_eq!(status.as_deref(), Some("running"));

    let result = exec_in_vm(&vm, "printf fake-out && >&2 printf fake-err")
        .await
        .expect("execute in fake vm");
    assert_eq!(result.exit_code, 0);
    assert_eq!(result.stdout, "fake-out");
    assert_eq!(result.stderr, "fake-err");

    remove_vm_container(&vm).await.expect("remove fake vm");
    let removed = inspect_vm_container_status(&vm)
        .await
        .expect("inspect removed fake vm");
    assert!(removed.is_none());
}

#[tokio::test]
async fn wait_for_vm_container_running_retries_transient_fake_statuses() {
    let _env = TestEnv::new("wait-running");

    let vm = create_vm("chat-wait", 2.0, None)
        .await
        .expect("create fake vm");
    let container_id = vm.container_id.clone();
    let container_name = format!("agent-vm-{}", vm.vm_id);
    seed_fake_vm_container(&container_id, &container_name, "created");

    let task_container_id = container_id.clone();
    let task_container_name = container_name.clone();
    let transition = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        seed_fake_vm_container(&task_container_id, &task_container_name, "running");
    });

    wait_for_vm_container_running(&vm)
        .await
        .expect("wait for fake vm to reach running");
    transition.await.expect("join status transition");
}

#[tokio::test]
async fn wait_for_vm_container_running_rejects_terminal_fake_status() {
    let _env = TestEnv::new("wait-exited");

    let vm = create_vm("chat-wait-terminal", 2.0, None)
        .await
        .expect("create fake vm");
    seed_fake_vm_container(
        &vm.container_id,
        &format!("agent-vm-{}", vm.vm_id),
        "exited",
    );

    let error = wait_for_vm_container_running(&vm)
        .await
        .expect_err("terminal fake status should fail");
    assert!(
        error
            .to_string()
            .contains("entered non-running state 'exited'"),
        "unexpected error: {error:#}"
    );
}

#[tokio::test]
async fn cleanup_agent_vms_removes_expired_fake_vm_and_auxiliary_state() {
    let _env = TestEnv::new("cleanup-expired");

    let mut vm = create_vm("chat-expired", 1.0, None)
        .await
        .expect("create fake vm");
    vm.last_activity = now_epoch_seconds() - 7_200.0;
    vm.timeout_hours = 0.5;
    store_vm_info(&vm).expect("store expired vm");
    store_default_vm_mapping(&vm).expect("store default vm mapping");
    register_file_read(&vm.vm_id, "/work/report.txt").expect("register file read");

    let report = cleanup_agent_vms_once()
        .await
        .expect("cleanup expired agent vm");
    assert_eq!(
        report,
        VmCleanupReport {
            expired: 1,
            stale_metadata: 0,
            orphaned: 0
        }
    );
    assert!(load_vm_info(&vm.vm_id).unwrap().is_none());
    assert!(load_default_vm_for_chat("chat-expired").unwrap().is_none());
    assert!(inspect_vm_container_status(&vm).await.unwrap().is_none());
    assert!(redis_smembers(&format!("{FILE_READS_PREFIX}{}", vm.vm_id))
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn cleanup_agent_vms_removes_orphaned_fake_container_without_metadata() {
    let _env = TestEnv::new("cleanup-orphan");

    seed_fake_vm_container("fake-orphan", "agent-vm-orphan-vm", "running");
    register_file_read("orphan-vm", "/work/log.txt").expect("register orphan file read");
    redis_set_string("agent_vm_info:orphan-vm", "not-json").expect("seed invalid metadata");

    let report = cleanup_agent_vms_once()
        .await
        .expect("cleanup orphaned agent vm");
    assert_eq!(
        report,
        VmCleanupReport {
            expired: 0,
            stale_metadata: 0,
            orphaned: 1
        }
    );
    let orphan_vm = VmInfo {
        vm_id: "orphan-vm".to_string(),
        container_id: "fake-orphan".to_string(),
        chat_id: "chat-orphan".to_string(),
        created_at: 0.0,
        last_activity: 0.0,
        timeout_hours: 1.0,
        status: "running".to_string(),
        sharing_key: None,
        network_enabled: true,
        port_mappings: BTreeMap::new(),
        work_bind_source: None,
        work_bind_source_verified: false,
    };
    assert!(inspect_vm_container_status(&orphan_vm)
        .await
        .unwrap()
        .is_none());
    assert!(redis_smembers(&format!("{FILE_READS_PREFIX}orphan-vm"))
        .unwrap()
        .is_empty());
    assert!(redis_get_string("agent_vm_info:orphan-vm")
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn cleanup_agent_vms_ignores_artifact_runtime_containers() {
    let env = TestEnv::new("cleanup-artifact-runtime");

    seed_fake_vm_container(
        "fake-artifact-preview",
        "agent-vm-artifact-preview-123",
        "running",
    );
    seed_fake_vm_container(
        "fake-artifact-helper",
        "agent-vm-artifact-helper-123",
        "running",
    );

    let report = cleanup_agent_vms_once()
        .await
        .expect("cleanup should ignore artifact runtimes");
    assert_eq!(report.total(), 0);

    let mut preview = env.vm("artifact-preview", "chat-artifact");
    preview.container_id = "fake-artifact-preview".to_string();
    let mut helper = env.vm("artifact-helper", "chat-artifact");
    helper.container_id = "fake-artifact-helper".to_string();
    assert_eq!(
        inspect_vm_container_status(&preview)
            .await
            .unwrap()
            .as_deref(),
        Some("running")
    );
    assert_eq!(
        inspect_vm_container_status(&helper)
            .await
            .unwrap()
            .as_deref(),
        Some("running")
    );
}

#[tokio::test]
async fn cleanup_agent_vms_keeps_active_running_fake_vm() {
    let _env = TestEnv::new("cleanup-active");

    let vm = create_vm("chat-active", 2.0, None)
        .await
        .expect("create active vm");
    register_file_read(&vm.vm_id, "/work/notes.txt").expect("register live file read");

    let report = cleanup_agent_vms_once()
        .await
        .expect("cleanup active agent vm");
    assert_eq!(report.total(), 0);
    assert!(load_vm_info(&vm.vm_id).unwrap().is_some());
    assert_eq!(
        inspect_vm_container_status(&vm).await.unwrap().as_deref(),
        Some("running")
    );
}

#[tokio::test]
async fn vm_cleanup_uses_inactivity_for_one_and_four_hour_vms() {
    let _env = TestEnv::new("cleanup-inactivity-contract");

    let mut direct_vm = create_vm("chat-direct", 1.0, None)
        .await
        .expect("create one-hour vm");
    let mut skill_vm = create_vm("chat-skill", 4.0, None)
        .await
        .expect("create four-hour vm");
    store_default_vm_mapping(&direct_vm).unwrap();
    store_default_vm_mapping(&skill_vm).unwrap();

    assert_eq!(
        redis_ttl(&format!("{VM_INFO_PREFIX}{}", direct_vm.vm_id)).unwrap(),
        -1
    );
    assert_eq!(redis_ttl(&default_vm_key(&direct_vm.chat_id)).unwrap(), -1);
    assert_eq!(
        redis_ttl(&format!("{VM_INFO_PREFIX}{}", skill_vm.vm_id)).unwrap(),
        -1
    );
    assert_eq!(redis_ttl(&default_vm_key(&skill_vm.chat_id)).unwrap(), -1);

    for _ in 0..3 {
        assert_eq!(cleanup_agent_vms_once().await.unwrap().total(), 0);
    }

    direct_vm.last_activity = now_epoch_seconds() - 3_500.0;
    store_vm_info(&direct_vm).unwrap();
    touch_vm_activity(&direct_vm.vm_id).unwrap();
    direct_vm = load_vm(&direct_vm.vm_id).unwrap();
    assert!(direct_vm.last_activity > now_epoch_seconds() - 5.0);

    direct_vm.last_activity = now_epoch_seconds() - 3_601.0;
    store_vm_info(&direct_vm).unwrap();
    skill_vm.last_activity = now_epoch_seconds() - 14_399.0;
    store_vm_info(&skill_vm).unwrap();
    let report = cleanup_agent_vms_once().await.unwrap();
    assert_eq!(report.expired, 1);
    assert!(load_vm_info(&direct_vm.vm_id).unwrap().is_none());
    assert!(load_vm_info(&skill_vm.vm_id).unwrap().is_some());

    skill_vm.last_activity = now_epoch_seconds() - 14_401.0;
    store_vm_info(&skill_vm).unwrap();
    let report = cleanup_agent_vms_once().await.unwrap();
    assert_eq!(report.expired, 1);
    assert!(load_vm_info(&skill_vm.vm_id).unwrap().is_none());
}

#[tokio::test]
async fn cleanup_migrates_legacy_vm_ttls_to_persistent_keys() {
    let _env = TestEnv::new("cleanup-migrate-ttl");

    let vm = create_vm("chat-migrate", 1.0, None)
        .await
        .expect("create vm");
    let info_key = format!("{VM_INFO_PREFIX}{}", vm.vm_id);
    let mapping_key = default_vm_key(&vm.chat_id);
    redis_setex_string(
        &info_key,
        &serde_json::to_string(&vm.to_json()).unwrap(),
        7_200,
    )
    .unwrap();
    redis_setex_string(&mapping_key, &vm.vm_id, 7_200).unwrap();
    redis_setex_string("llm_debug:legacy-event", "large-debug-event", 7_200).unwrap();

    assert!(redis_ttl(&info_key).unwrap() > 0);
    assert!(redis_ttl(&mapping_key).unwrap() > 0);
    assert_eq!(cleanup_agent_vms_once().await.unwrap().total(), 0);
    assert_eq!(redis_ttl(&info_key).unwrap(), -1);
    assert_eq!(redis_ttl(&mapping_key).unwrap(), -1);
    assert!(redis_ttl("llm_debug:legacy-event").unwrap() > 0);
}

#[test]
fn exact_container_metadata_recheck_requires_matching_container_id() {
    let env = TestEnv::new("cleanup-exact-recheck");
    let mut vm = env.vm("vm-race", "chat-race");
    vm.container_id = "container-race".to_string();
    store_vm_info(&vm).unwrap();

    let matching = ManagedVmContainer {
        container_id: "container-race".to_string(),
        name: "/agent-vm-vm-race".to_string(),
    };
    assert_eq!(
        load_matching_vm_info_for_container(&matching)
            .unwrap()
            .map(|info| info.vm_id),
        Some("vm-race".to_string())
    );

    let mismatched = ManagedVmContainer {
        container_id: "container-other".to_string(),
        name: "/agent-vm-vm-race".to_string(),
    };
    assert!(load_matching_vm_info_for_container(&mismatched)
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn cleanup_agent_vms_removes_stale_metadata_for_missing_container() {
    let _env = TestEnv::new("cleanup-stale-metadata");

    let vm = create_vm("chat-stale", 2.0, None)
        .await
        .expect("create fake vm");
    let workspace = vm_workspace_root(&vm);
    fs::write(workspace.join("persist.txt"), "keep workspace").unwrap();
    store_default_vm_mapping(&vm).unwrap();
    register_file_read(&vm.vm_id, "/work/persist.txt").unwrap();
    remove_vm_container(&vm).await.unwrap();

    let report = cleanup_agent_vms_once()
        .await
        .expect("cleanup stale metadata agent vm");
    assert_eq!(
        report,
        VmCleanupReport {
            expired: 0,
            stale_metadata: 1,
            orphaned: 0
        }
    );
    assert!(load_vm_info(&vm.vm_id).unwrap().is_none());
    assert!(load_default_vm_for_chat("chat-stale").unwrap().is_none());
    assert!(redis_smembers(&format!("{FILE_READS_PREFIX}{}", vm.vm_id))
        .unwrap()
        .is_empty());
    assert!(workspace.exists(), "workspace contents should be preserved");
}

#[test]
fn vm_info_and_success_payload_helpers_round_trip() {
    let env = TestEnv::new("vm-info");
    let vm = env.vm("vm-1", "chat-1");
    let encoded = vm.to_json();
    assert_eq!(VmInfo::from_json(&encoded).unwrap().vm_id, "vm-1");
    assert!(encoded.get("profile").is_none());
    assert_eq!(
        VmInfo::from_json(&json!({
            "vm_id": "vm-legacy",
            "container_id": "container-legacy",
            "chat_id": "chat-1",
            "created_at": 1.0,
            "last_activity": 2.0,
            "timeout_hours": 3.0,
            "profile": "browser",
        }))
        .unwrap()
        .vm_id,
        "vm-legacy"
    );
    assert!(VmInfo::from_json(&json!({"vm_id": "vm-1"})).is_err());

    let payload = response_payload(success_json_message("vm-1", "created".to_string()));
    assert_eq!(payload["vm_id"], json!("vm-1"));
    assert_eq!(payload["message"], json!("created"));
}

#[test]
fn workspace_root_helpers_follow_env_overrides() {
    let env = TestEnv::new("roots");
    assert_eq!(
        container_chat_workspace_root("chat-1").unwrap(),
        env.root.join("workspaces/chat-1")
    );
    assert_eq!(
        host_chat_workspace_root("chat-1").unwrap(),
        env.root.join("workspaces/chat-1")
    );
    assert_eq!(
        container_vm_workspace_root("chat-1", "vm-1").unwrap(),
        env.root.join("workspaces/chat-1")
    );
    assert_eq!(
        host_vm_workspace_root("chat-1", "vm-1").unwrap(),
        env.root.join("workspaces/chat-1")
    );

    let bind_source = prepare_workspace("chat-2", "vm-2").unwrap();
    assert_eq!(bind_source, env.root.join("workspaces/chat-2"));
    assert!(env.root.join("workspaces/chat-2").exists());
    assert!(!env.root.join("workspaces/chat-2/vm-2").exists());
}

#[tokio::test]
async fn custom_chat_workspace_settings_bind_exact_selected_folder() {
    let env = TestEnv::new("custom-chat-workspace");
    let workspace_cfg = env.root.join("workspace-cfg");
    let custom = env.root.join("selected workspace");
    fs::create_dir_all(&custom).unwrap();
    fs::create_dir_all(&workspace_cfg).unwrap();
    fs::write(
        workspace_cfg.join("chat-workspaces.json"),
        json!({
            "chats": {
                "chat-custom": {
                    "source": "custom",
                    "host_path": custom.display().to_string()
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    let _guard = EnvGuard::set(&[(
        "PORTICO_WORKSPACE_CFG_DIR",
        Some(workspace_cfg.to_str().unwrap()),
    )]);

    let bind_source = prepare_workspace("chat-custom", "vm-1").unwrap();
    assert_eq!(bind_source, custom);
    assert!(!env.root.join("workspaces/chat-custom").exists());

    let vm = create_vm("chat-custom", 1.0, None).await.unwrap();
    assert_eq!(
        vm.work_bind_source.as_deref(),
        Some(custom.to_str().unwrap())
    );
    assert_eq!(vm_workspace_root(&vm), custom);
    let workspace_metadata = workspace_display_metadata(&vm);
    assert_eq!(workspace_metadata["source"], json!("custom"));
    assert_eq!(workspace_metadata["internal_path"], json!("/work"));
    assert_eq!(
        workspace_metadata["message"],
        json!(format!(
            "{} is mounted inside the Agent VM at /work",
            workspace_metadata["display_path"].as_str().unwrap()
        ))
    );

    let status = response_payload(
        handle_get_status(&args(&[("vm_id", json!(vm.vm_id))]))
            .await
            .unwrap(),
    );
    assert_eq!(status["workspace"]["source"], json!("custom"));
    assert_eq!(status["workspace"]["internal_path"], json!("/work"));
    assert_eq!(
        status["workspace"]["display_path"],
        workspace_metadata["display_path"]
    );
}

#[test]
fn vm_info_storage_and_lookup_use_memory_redis() {
    let env = TestEnv::new("redis-vm");
    let vm = env.seed_vm("vm-1", "chat-1");

    assert_eq!(load_vm("vm-1").unwrap().chat_id, "chat-1");
    assert_eq!(
        load_vm_info("vm-1").unwrap().unwrap().container_id,
        vm.container_id
    );
    assert!(load_vm_info("missing").unwrap().is_none());

    redis_set_string(&format!("{VM_INFO_PREFIX}broken"), "not-json").unwrap();
    assert!(load_vm_info("broken").is_err());

    delete_vm_info("vm-1").unwrap();
    assert!(load_vm_info("vm-1").unwrap().is_none());
}

#[test]
fn default_vm_mapping_helpers_only_mutate_the_current_assignment() {
    let env = TestEnv::new("default-mapping");
    let first = env.seed_vm("vm-first", "chat-1");
    let second = env.seed_vm("vm-second", "chat-1");

    store_default_vm_mapping(&first).unwrap();
    refresh_default_vm_mapping_if_current(&second).unwrap();
    assert_eq!(
        load_default_vm_for_chat("chat-1").unwrap().unwrap().vm_id,
        first.vm_id
    );

    clear_default_vm_mapping_if_matches("chat-1", &second.vm_id).unwrap();
    assert_eq!(
        load_default_vm_for_chat("chat-1").unwrap().unwrap().vm_id,
        first.vm_id
    );

    delete_vm_info(&first.vm_id).unwrap();
    assert!(load_default_vm_for_chat("chat-1").unwrap().is_none());
    assert!(redis_get_string("agent_vm:chat-1").unwrap().is_none());
}

#[tokio::test]
async fn handle_create_reuses_existing_default_vm_for_chat() {
    let _env = TestEnv::new("create-reuses-default");

    let created = response_payload(
        handle_create(&args(&[
            ("chat_id", json!("chat-1")),
            ("timeout_hours", json!(2.0)),
        ]))
        .await
        .unwrap(),
    );
    let reused = response_payload(
        handle_create(&args(&[
            ("chat_id", json!("chat-1")),
            ("timeout_hours", json!(1.0)),
        ]))
        .await
        .unwrap(),
    );

    assert_eq!(created["success"], json!(true));
    assert_eq!(created["created"], json!(true));
    assert_eq!(created["reused"], json!(false));
    assert_eq!(reused["success"], json!(true));
    assert_eq!(reused["created"], json!(false));
    assert_eq!(reused["reused"], json!(true));
    assert_eq!(reused["vm_id"], created["vm_id"]);
    assert_eq!(reused["container_id"], created["container_id"]);
    assert_eq!(reused["timeout_hours"], json!(2.0));
    assert_eq!(list_managed_vm_infos().unwrap().len(), 1);
}

#[tokio::test]
async fn handle_create_concurrently_reuses_single_default_vm_for_chat() {
    let _env = TestEnv::new("create-concurrent-reuses-default");
    let first_args = args(&[("chat_id", json!("chat-1"))]);
    let second_args = args(&[("chat_id", json!("chat-1"))]);

    let (first, second) = tokio::join!(handle_create(&first_args), handle_create(&second_args),);
    let first = response_payload(first.unwrap());
    let second = response_payload(second.unwrap());

    assert_eq!(first["success"], json!(true));
    assert_eq!(second["success"], json!(true));
    assert_eq!(first["vm_id"], second["vm_id"]);
    assert_ne!(first["created"], second["created"]);
    assert_ne!(first["reused"], second["reused"]);
    assert_eq!(list_managed_vm_infos().unwrap().len(), 1);
}

#[tokio::test]
async fn handle_create_replaces_stale_default_vm_mapping() {
    let _env = TestEnv::new("create-replaces-stale-default");
    let vm = create_vm("chat-1", 2.0, None)
        .await
        .expect("create stale default vm");
    store_default_vm_mapping(&vm).expect("store default vm mapping");
    seed_fake_vm_container(
        &vm.container_id,
        &format!("agent-vm-{}", vm.vm_id),
        "exited",
    );

    let response = response_payload(
        handle_create(&args(&[("chat_id", json!("chat-1"))]))
            .await
            .unwrap(),
    );

    assert_eq!(response["success"], json!(true));
    assert_eq!(response["created"], json!(true));
    assert_eq!(response["reused"], json!(false));
    assert_ne!(response["vm_id"], json!(vm.vm_id));
    assert!(load_vm_info(&vm.vm_id).unwrap().is_none());
    assert_eq!(
        load_default_vm_for_chat("chat-1").unwrap().unwrap().vm_id,
        response["vm_id"].as_str().unwrap()
    );
    assert_eq!(list_managed_vm_infos().unwrap().len(), 1);
}

#[test]
fn low_level_file_helpers_cover_success_and_error_paths() {
    let env = TestEnv::new("helpers");
    let vm = env.seed_vm("vm-1", "chat-1");
    let root = vm_workspace_root(&vm);
    let shared_root = workspace_root_for_ids("chat-1", "vm-1").unwrap();
    let nested = root.join("nested");
    fs::create_dir_all(&nested).unwrap();
    fs::write(nested.join("sample.txt"), "hello world").unwrap();

    assert_eq!(
        vm_host_path(&vm, "nested/sample.txt").unwrap(),
        root.join("nested/sample.txt")
    );
    assert_eq!(
        vm_host_path(&vm, "/tmp/outside").unwrap(),
        root.join(".tmp/outside")
    );
    assert!(vm_host_path(&vm, "../../escape").is_err());
    assert_eq!(
        workspace_relative_path(&vm, "output/report.txt").unwrap(),
        shared_root.join("output/report.txt")
    );
    assert_eq!(
        vm_host_path(&vm, "/workspace/output/report.txt").unwrap(),
        shared_root.join("output/report.txt")
    );
    assert!(workspace_relative_path(&vm, "../escape").is_err());
    assert_eq!(vm_path_string(&vm, &root).unwrap(), "/work");
    assert_eq!(
        vm_path_string(&vm, &root.join("nested/sample.txt")).unwrap(),
        "/work/nested/sample.txt"
    );
    assert_eq!(
        vm_path_string(&vm, &shared_root.join("output/report.txt")).unwrap(),
        "/work/output/report.txt"
    );
    assert!(vm_path_string(&vm, &env.root).is_err());
    ensure_within(&root, &root.join("nested")).unwrap();
    assert!(ensure_within(&root, &env.root).is_err());
    assert_eq!(
        read_utf8_file(&vm, "/work/nested/sample.txt").unwrap(),
        "hello world"
    );
    fs::write(root.join("nested/raw.bin"), [0xff, 0x00, 0x10]).unwrap();
    assert!(read_utf8_file(&vm, "/work/nested/raw.bin").is_err());

    let batch_path = create_batch_file(
        &vm,
        &json!({"path": "/work/batch/file.txt", "content": "batch"}),
    )
    .unwrap();
    assert_eq!(batch_path, "/work/batch/file.txt");
    assert!(create_batch_file(&vm, &json!({"path": "/work/missing.txt"})).is_err());

    let copy_source = root.join("copy-src");
    fs::create_dir_all(copy_source.join("sub")).unwrap();
    fs::write(copy_source.join("sub/file.txt"), "copied").unwrap();
    copy_path(&copy_source, &root.join("copy-dest")).unwrap();
    assert_eq!(
        fs::read_to_string(root.join("copy-dest/sub/file.txt")).unwrap(),
        "copied"
    );
    copy_path(
        &root.join("nested/sample.txt"),
        &root.join("single/copied.txt"),
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(root.join("single/copied.txt")).unwrap(),
        "hello world"
    );
    let same_file = root.join("single/same.txt");
    fs::write(&same_file, "preserved").unwrap();
    copy_path(&same_file, &root.join("single/./same.txt")).unwrap();
    assert_eq!(fs::read_to_string(&same_file).unwrap(), "preserved");

    let zip_path = root.join("archive.zip");
    write_zip(
        &zip_path,
        &[
            ("folder/", b""),
            ("folder/keep.txt", b"kept"),
            ("folder/nested/child.txt", b"child"),
        ],
    );
    unzip_into(&zip_path, &root, &root.join("unzipped"), 1).unwrap();
    assert_eq!(
        fs::read_to_string(root.join("unzipped/keep.txt")).unwrap(),
        "kept"
    );
    assert_eq!(
        fs::read_to_string(root.join("unzipped/nested/child.txt")).unwrap(),
        "child"
    );
}

#[tokio::test]
async fn create_vm_and_private_file_ops_use_container_workspace_when_host_root_differs() {
    let env = TestEnv::new("private-container-root-parity");
    let _overflow_env = EnvGuard::set(&[
        ("AGENT_VM_TOOL_RESULT_MAX_CHARS", Some("10")),
        ("AGENT_VM_TOOL_RESULT_OVERFLOW_ENABLED", Some("true")),
    ]);
    let divergent_host_root = env.root.join("host-project-root");
    fs::create_dir_all(&divergent_host_root).unwrap();
    env::set_var("HOST_PROJECT_ROOT", &divergent_host_root);

    let created_vm = create_vm("chat-created", 2.0, None)
        .await
        .expect("create fake vm with divergent host root");
    let created_local_root = vm_workspace_root(&created_vm);
    let created_host_only_root = divergent_host_root.join("workspaces/chat-created");
    assert!(created_local_root.exists());
    assert!(!created_host_only_root.exists());

    let vm = env.seed_vm("vm-1", "chat-1");
    let local_root = vm_workspace_root(&vm);
    let host_only_root = divergent_host_root.join("workspaces/chat-1");

    let created = response_payload(
        handle_create_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("/work/generated.txt")),
            ("content", json!("generated")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(created["success"], json!(true));
    assert_eq!(
        fs::read_to_string(local_root.join("generated.txt")).unwrap(),
        "generated"
    );
    assert!(!host_only_root.join("generated.txt").exists());

    fs::write(local_root.join("notes.txt"), "alpha beta gamma").unwrap();
    let fragment = response_payload(
        handle_read_fragment(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("/work/notes.txt")),
            ("offset_chars", json!(0)),
            ("max_chars", json!(64)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(fragment["success"], json!(true));
    assert_eq!(fragment["content"], json!("alpha beta gamma"));

    let grep = response_payload(
        handle_grep_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("/work/notes.txt")),
            ("patterns", json!(["beta"])),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(grep["success"], json!(true));
    assert_eq!(grep["matched_any"], json!(true));

    let large_json = serde_json::to_string(&json!({"payload": "x".repeat(256)})).unwrap();
    fs::write(local_root.join("large.json"), &large_json).unwrap();
    let overflow = response_payload(
        crate::native::Dispatcher
            .call(
                "read_file",
                &args(&[
                    ("vm_id", json!("vm-1")),
                    ("path", json!("/work/large.json")),
                ]),
            )
            .await
            .unwrap()
            .unwrap(),
    );
    assert_eq!(overflow["overflow_file"], json!(true));
    let overflow_path = overflow["path"].as_str().unwrap().to_string();
    let overflow_relative = overflow_path.trim_start_matches("/work/");
    assert!(local_root.join(overflow_relative).exists());
    assert!(!host_only_root.join(overflow_relative).exists());

    let overflow_grep = response_payload(
        handle_grep_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!(overflow_path)),
            // Match the spilled path value without pinning the JSON
            // serialization style (compact today).
            ("patterns", json!(["/work/large.json"])),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(overflow_grep["success"], json!(true));
    assert_eq!(overflow_grep["matched_any"], json!(true));
}

#[cfg(unix)]
#[test]
fn ensure_within_accepts_nonexistent_descendants_under_symlinked_root() {
    let env = TestEnv::new("symlink-root");
    let real_root = env.root.join("real-workspace");
    fs::create_dir_all(&real_root).unwrap();
    let alias_root = env.root.join("alias-workspace");
    std::os::unix::fs::symlink(&real_root, &alias_root).unwrap();

    ensure_within(&alias_root, &alias_root.join("nested/file.txt")).unwrap();
    assert!(ensure_within(&alias_root, &env.root.join("escape.txt")).is_err());
}

#[tokio::test]
async fn file_handlers_cover_read_edit_batch_list_and_delete() {
    let env = TestEnv::new("handlers");
    let vm = env.seed_vm("vm-1", "chat-1");

    let created = response_payload(
        handle_create_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("/work/src/main.py")),
            ("content", json!("print('hello')\nprint('hello')\n")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(created["path"], json!("/work/src/main.py"));

    let appended = response_payload(
        handle_create_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("/work/src/main.py")),
            ("content", json!("print('goodbye')\n")),
            ("append", json!(true)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(appended["success"], json!(true));
    assert_eq!(
        fs::read_to_string(vm_workspace_root(&vm).join("src/main.py")).unwrap(),
        "print('hello')\nprint('hello')\nprint('goodbye')\n"
    );

    let batch = response_payload(
        handle_create_files(&args(&[
            ("vm_id", json!("vm-1")),
            (
                "files",
                json!([
                    {"path": "/work/docs/readme.md", "content": "docs"},
                    {"path": "/work/bad.txt"}
                ]),
            ),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(batch["success"], json!(false));
    assert_eq!(
        batch["error"],
        json!("files[1] must have both 'path' and 'content' properties")
    );

    let single = response_payload(
        handle_read_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("/work/src/main.py")),
        ]))
        .await
        .unwrap(),
    );
    assert!(single["content"]
        .as_str()
        .unwrap()
        .contains("print('hello')"));
    assert!(has_file_been_read("vm-1", "/work/src/main.py").unwrap());

    fs::write(vm_workspace_root(&vm).join("unicode.txt"), "a😀bc").unwrap();
    let chunked = response_payload(
        handle_read_fragment(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("/work/unicode.txt")),
            ("offset_chars", json!(1)),
            ("max_chars", json!(2)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(chunked["success"], json!(true));
    assert_eq!(chunked["content"], json!("😀b"));
    assert_eq!(chunked["total_chars"], json!(4));
    assert_eq!(chunked["offset_chars"], json!(1));
    assert_eq!(chunked["chars_returned"], json!(2));
    assert_eq!(chunked["next_offset_chars"], json!(3));
    assert_eq!(chunked["truncated"], json!(true));

    let eof_chunk = response_payload(
        handle_read_fragment(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("/work/unicode.txt")),
            ("offset_chars", json!(99)),
            ("max_chars", json!(999_999)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(eof_chunk["success"], json!(true));
    assert_eq!(eof_chunk["content"], json!(""));
    assert_eq!(eof_chunk["offset_chars"], json!(4));
    assert_eq!(eof_chunk["chars_returned"], json!(0));
    assert_eq!(eof_chunk["next_offset_chars"], Value::Null);
    assert_eq!(eof_chunk["truncated"], json!(false));

    fs::write(vm_workspace_root(&vm).join("long.txt"), "x".repeat(5_000)).unwrap();
    let clamped_chunk = response_payload(
        handle_read_fragment(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("/work/long.txt")),
            ("offset_chars", json!(0)),
            ("max_chars", json!(999_999)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(clamped_chunk["success"], json!(true));
    assert_eq!(clamped_chunk["chars_returned"], json!(2_000));
    assert_eq!(clamped_chunk["next_offset_chars"], json!(2_000));
    assert_eq!(clamped_chunk["truncated"], json!(true));

    let batch_read = response_payload(
        handle_read_files(&args(&[
            ("vm_id", json!("vm-1")),
            ("paths", json!(["/work/src/main.py", "/work/missing.txt"])),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(batch_read["success"], json!(false));
    assert_eq!(batch_read["read"].as_array().unwrap().len(), 1);
    assert_eq!(batch_read["failed"].as_array().unwrap().len(), 1);

    let edited = response_payload(
        handle_edit_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("file_path", json!("/work/src/main.py")),
            ("old_string", json!("print('hello')")),
            ("new_string", json!("print('updated')")),
            ("replace_all", json!(true)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(edited["replacements_made"], json!(2));
    assert_eq!(
        fs::read_to_string(vm_workspace_root(&vm).join("src/main.py")).unwrap(),
        "print('updated')\nprint('updated')\nprint('goodbye')\n"
    );

    let batch_edit = response_payload(
        handle_edit_files(&args(&[
            ("vm_id", json!("vm-1")),
            (
                "edits",
                json!([
                    {
                        "file_path": "/work/src/main.py",
                        "old_string": "print('updated')",
                        "new_string": "print('final')",
                        "replace_all": true
                    },
                    {"file_path": "/work/docs/readme.md", "old_string": "", "new_string": "ignored"},
                    "bad-edit"
                ]),
            ),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(batch_edit["success"], json!(false));
    assert_eq!(
        batch_edit["error"],
        json!("edits[1].old_string cannot be empty")
    );

    let listed = response_payload(
        handle_list_files(&args(&[
            ("vm_id", json!("vm-1")),
            ("directory", json!("/work")),
            ("recursive", json!(true)),
        ]))
        .await
        .unwrap(),
    );
    assert!(listed["files"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item == "main.py"));

    fs::create_dir_all(vm_workspace_root(&vm).join("docs")).unwrap();
    fs::write(vm_workspace_root(&vm).join("docs/readme.md"), "docs").unwrap();
    fs::create_dir_all(vm_workspace_root(&vm).join("folder")).unwrap();
    let delete_file = response_payload(
        handle_delete_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("/work/docs/readme.md")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(delete_file["success"], json!(true));
    let delete_dir = response_payload(
        handle_delete_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("/work/folder")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(delete_dir["success"], json!(false));

    let no_files = response_payload(
        handle_create_files(&args(&[("vm_id", json!("vm-1"))]))
            .await
            .unwrap(),
    );
    assert_eq!(no_files["success"], json!(false));
}

#[tokio::test]
async fn execute_skill_script_and_edit_guards_cover_errors() {
    let env = TestEnv::new("script");
    let vm = env.seed_vm("vm-1", "chat-1");
    store_default_vm_mapping(&vm).unwrap();
    let script_dir = env.root.join("skills-user/demo-tool/scripts");
    fs::create_dir_all(&script_dir).unwrap();
    fs::write(
        script_dir.join("echo.py"),
        "import os, sys\nprint(os.environ['CHAT_ID'])\nprint(os.environ.get('VM_ID', '<none>'))\nprint(__file__)\nprint('|'.join(sys.argv[1:]))\n",
    )
    .unwrap();

    let script = response_payload(
        handle_execute_skill_script(&args(&[
            ("skill_name", json!("demo-tool")),
            ("script_name", json!("echo.py")),
            ("vm_id", json!("vm-1")),
            ("args", json!(["one", "two"])),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(script["success"], json!(true));
    assert_eq!(script["vm_id"], json!("vm-1"));
    assert!(script["stdout"].as_str().unwrap().contains("chat-1"));
    assert!(script["stdout"].as_str().unwrap().contains("vm-1"));
    assert!(script["stdout"]
        .as_str()
        .unwrap()
        .contains("/.skill_runtime/demo-tool/scripts/echo.py"));
    assert!(script["stdout"].as_str().unwrap().contains("one|two"));
    assert!(vm_workspace_root(&vm)
        .join(".skill_runtime/demo-tool/scripts/echo.py")
        .exists());

    let fallback_script = response_payload(
        handle_execute_skill_script(&args(&[
            ("skill_name", json!("demo-tool")),
            ("script_name", json!("scripts/echo.py")),
            ("chat_id", json!("chat-1")),
            ("args", json!(["fallback"])),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(fallback_script["success"], json!(true));
    assert_eq!(fallback_script["vm_id"], json!("vm-1"));
    assert!(fallback_script["stdout"]
        .as_str()
        .unwrap()
        .contains("fallback"));
    let scratch_root = env.root.join("workspaces/.scratch");
    assert!(!scratch_root.exists() || fs::read_dir(&scratch_root).unwrap().next().is_none());

    let missing_default = response_payload(
        handle_execute_skill_script(&args(&[
            ("skill_name", json!("demo-tool")),
            ("script_name", json!("scripts/echo.py")),
            ("chat_id", json!("chat-missing")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(missing_default["success"], json!(false));
    assert!(missing_default["error"]
        .as_str()
        .unwrap()
        .contains("No default Agent VM found"));

    let missing_script = response_payload(
        handle_execute_skill_script(&args(&[
            ("skill_name", json!("demo-tool")),
            ("script_name", json!("missing.py")),
            ("vm_id", json!("vm-1")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(missing_script["success"], json!(false));
    assert!(missing_script["error"]
        .as_str()
        .unwrap()
        .contains("Script not found"));

    fs::write(vm_workspace_root(&vm).join("notes.txt"), "alpha\nalpha\n").unwrap();
    assert!(edit_file_impl(&vm, "/work/notes.txt", "", "beta", false).is_err());
    assert!(edit_file_impl(&vm, "/work/notes.txt", "alpha", "beta", false).is_err());
    register_file_read("vm-1", "/work/notes.txt").unwrap();
    assert!(edit_file_impl(&vm, "/work/notes.txt", "missing", "beta", false).is_err());
    assert!(edit_file_impl(&vm, "/work/notes.txt", "alpha", "beta", false).is_err());
    assert_eq!(
        edit_file_impl(&vm, "/work/notes.txt", "alpha", "beta", true).unwrap(),
        2
    );
}

#[tokio::test]
async fn execute_skill_script_uses_vm_work_paths_for_inputs_and_outputs() {
    let env = TestEnv::new("script-work-paths");
    let vm = env.seed_vm("vm-1", "chat-1");
    let script_dir = env.root.join("skills-user/demo-tool/scripts");
    fs::create_dir_all(&script_dir).unwrap();
    fs::write(
        script_dir.join("compact.py"),
        concat!(
            "import argparse, json, pathlib\n",
            "parser = argparse.ArgumentParser()\n",
            "parser.add_argument('--input', required=True)\n",
            "parser.add_argument('--output', required=True)\n",
            "args = parser.parse_args()\n",
            "payload = json.loads(pathlib.Path(args.input).read_text())\n",
            "output_path = pathlib.Path(args.output)\n",
            "output_path.parent.mkdir(parents=True, exist_ok=True)\n",
            "result = {'count': len(payload.get('results', [])), 'source': args.input}\n",
            "output_path.write_text(json.dumps(result))\n",
            "print(f\"compacted {result['count']} results to {args.output}\")\n",
        ),
    )
    .unwrap();
    let overflow_dir = vm_workspace_root(&vm).join(".mcp-overflow");
    fs::create_dir_all(&overflow_dir).unwrap();
    fs::write(
        overflow_dir.join("input.json"),
        serde_json::to_string(&json!({"results": [{"id": 1}, {"id": 2}]})).unwrap(),
    )
    .unwrap();

    let script = response_payload(
        handle_execute_skill_script(&args(&[
            ("skill_name", json!("demo-tool")),
            ("script_name", json!("compact.py")),
            ("vm_id", json!("vm-1")),
            (
                "args",
                json!([
                    "--input",
                    "/work/.mcp-overflow/input.json",
                    "--output",
                    "/work/glean/compact.json",
                ]),
            ),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(script["success"], json!(true));
    assert!(script["stdout"]
        .as_str()
        .unwrap()
        .contains("compacted 2 results to "));
    assert!(script["stdout"].as_str().unwrap().contains("compact.json"));

    let compacted: Value = serde_json::from_str(
        &fs::read_to_string(vm_workspace_root(&vm).join("glean/compact.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(compacted["count"], json!(2));
    assert!(compacted["source"]
        .as_str()
        .unwrap()
        .ends_with(".mcp-overflow/input.json"));
}

#[tokio::test]
async fn docker_backed_handlers_cover_lifecycle_and_exec() {
    let _env = TestEnv::new("docker");
    let _docker_mode = DockerModeGuard::real();
    if !ensure_docker_prereqs().await.unwrap() {
        eprintln!("Skipping real Docker coverage test because no Docker socket is available");
        return;
    }

    let missing_create = handle_create(&args(&[])).await.unwrap();
    assert_eq!(
        missing_create["content"][0]["text"],
        json!("Error: chat_id is required")
    );
    let missing_status = handle_get_status(&args(&[])).await.unwrap();
    assert_eq!(
        missing_status["content"][0]["text"],
        json!("Error: vm_id is required")
    );
    let missing_destroy = handle_destroy(&args(&[])).await.unwrap();
    assert_eq!(
        missing_destroy["content"][0]["text"],
        json!("Error: vm_id and requester_chat_id are required")
    );

    let created_response = match handle_create(&args(&[
        ("chat_id", json!("chat-1")),
        ("timeout_hours", json!(0.1)),
    ]))
    .await
    {
        Ok(response) => response,
        Err(error) if docker_create_blocked(&error) => {
            eprintln!("Skipping real Docker coverage test because container creation is blocked");
            return;
        }
        Err(error) => panic!("failed to create VM via handler: {error:#}"),
    };
    let created = response_payload(created_response);
    let vm_id = created["vm_id"].as_str().unwrap().to_string();
    assert_eq!(created["success"], json!(true));
    assert!(created.get("profile").is_none());

    let status = response_payload(
        handle_get_status(&args(&[("vm_id", json!(vm_id.clone()))]))
            .await
            .unwrap(),
    );
    assert_eq!(status["success"], json!(true));
    assert_eq!(status["owner_chat_id"], json!("chat-1"));

    let bash = response_payload(
        handle_bash(&args(&[
            ("vm_id", json!(vm_id.clone())),
            ("command", json!("printf 'hello from bash'")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(bash["success"], json!(true));
    assert_eq!(bash["stdout"], json!("hello from bash"));

    let python = response_payload(
        handle_python(&args(&[
            ("vm_id", json!(vm_id.clone())),
            ("script", json!("print('hello from python')")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(python["success"], json!(true));
    assert!(python["stdout"]
        .as_str()
        .unwrap()
        .contains("hello from python"));

    let wrong_destroy = response_payload(
        handle_destroy(&args(&[
            ("vm_id", json!(vm_id.clone())),
            ("requester_chat_id", json!("other-chat")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(wrong_destroy["success"], json!(false));

    let destroyed = response_payload(
        handle_destroy(&args(&[
            ("vm_id", json!(vm_id.clone())),
            ("requester_chat_id", json!("chat-1")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(destroyed["success"], json!(true));

    let missing_after_destroy = response_payload(
        handle_get_status(&args(&[("vm_id", json!(vm_id))]))
            .await
            .unwrap(),
    );
    assert_eq!(missing_after_destroy["success"], json!(false));
}

#[tokio::test]
async fn docker_backed_status_and_shared_workspace_branches_are_covered() {
    let env = TestEnv::new("docker-shared");
    let _docker_mode = DockerModeGuard::real();
    if !ensure_docker_prereqs().await.unwrap() {
        eprintln!("Skipping real Docker coverage test because no Docker socket is available");
        return;
    }

    let missing = response_payload(
        handle_get_status(&args(&[("vm_id", json!("missing-vm"))]))
            .await
            .unwrap(),
    );
    assert_eq!(missing["success"], json!(false));

    let ghost = env.seed_vm("ghost-vm", "chat-ghost");
    redis_set_string(
        &format!("{VM_INFO_PREFIX}{}", ghost.vm_id),
        &serde_json::to_string(&json!({
            "vm_id": ghost.vm_id,
            "container_id": "does-not-exist",
            "chat_id": ghost.chat_id,
            "created_at": ghost.created_at,
            "last_activity": ghost.last_activity,
            "timeout_hours": ghost.timeout_hours,
            "status": ghost.status,
            "sharing_key": ghost.sharing_key,
            "network_enabled": ghost.network_enabled,
            "port_mappings": ghost.port_mappings,
            "profile": "docs",
        }))
        .unwrap(),
    )
    .unwrap();
    let ghost_status = response_payload(
        handle_get_status(&args(&[("vm_id", json!("ghost-vm"))]))
            .await
            .unwrap(),
    );
    assert_eq!(ghost_status["success"], json!(false));

    let created_response = match handle_create(&args(&[
        ("chat_id", json!("chat-shared")),
        ("timeout_hours", json!(99.0)),
        ("sharing_key", json!("shared-key")),
    ]))
    .await
    {
        Ok(response) => response,
        Err(error) if docker_create_blocked(&error) => {
            eprintln!("Skipping real Docker coverage test because container creation is blocked");
            return;
        }
        Err(error) => panic!("failed to create shared VM via handler: {error:#}"),
    };
    let created = response_payload(created_response);
    let vm_id = created["vm_id"].as_str().unwrap().to_string();
    assert_eq!(created["timeout_hours"], json!(MAX_VM_TIMEOUT_HOURS));
    assert!(created["workspace_mode"]
        .as_str()
        .unwrap()
        .contains("Generated chat workspace"));
    assert_eq!(created["workspace"]["internal_path"], json!("/work"));
    assert_eq!(created["workspace"]["source"], json!("canonical"));

    let destroyed = response_payload(
        handle_destroy(&args(&[
            ("vm_id", json!(vm_id)),
            ("requester_chat_id", json!("chat-shared")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(destroyed["success"], json!(true));
}

#[tokio::test]
async fn dispatcher_spills_large_read_file_results_to_overflow_files() {
    let env = TestEnv::new("dispatcher-overflow");
    let _overflow_env = EnvGuard::set(&[
        ("AGENT_VM_TOOL_RESULT_MAX_CHARS", Some("10")),
        ("AGENT_VM_TOOL_RESULT_OVERFLOW_ENABLED", Some("true")),
    ]);
    let vm = env.seed_vm("vm-1", "chat-1");
    let contents = "x".repeat(128);
    fs::write(vm_workspace_root(&vm).join("large.txt"), &contents).unwrap();

    let dispatcher = crate::native::Dispatcher;
    let response = dispatcher
        .call(
            "read_file",
            &args(&[("vm_id", json!("vm-1")), ("path", json!("/work/large.txt"))]),
        )
        .await
        .unwrap()
        .unwrap();
    let payload = response_payload(response);
    assert_eq!(payload["overflow_file"], json!(true));
    assert_eq!(payload["tool_name"], json!("read_file"));
    assert_eq!(payload["vm_id"], json!("vm-1"));
    assert_eq!(payload["format"], json!("json"));
    assert!(payload["read_hint"]
        .as_str()
        .unwrap()
        .contains("Do not dump the raw overflow file"));

    let overflow_path = payload["path"]
        .as_str()
        .unwrap()
        .trim_start_matches("/work/");
    let spilled = fs::read_to_string(vm_workspace_root(&vm).join(overflow_path)).unwrap();
    let spilled_payload: Value = serde_json::from_str(&spilled).unwrap();
    assert_eq!(spilled_payload["success"], json!(true));
    assert_eq!(spilled_payload["path"], json!("/work/large.txt"));
    assert_eq!(spilled_payload["content"], json!(contents));
}

#[tokio::test]
async fn work_bind_source_is_consulted_for_normal_file_ops_without_recovery_inspect() {
    let env = TestEnv::new("work-bind-normal-ops");
    let _overflow_env = EnvGuard::set(&[
        ("AGENT_VM_TOOL_RESULT_MAX_CHARS", Some("10")),
        ("AGENT_VM_TOOL_RESULT_OVERFLOW_ENABLED", Some("true")),
    ]);
    let vm = env.seed_vm("vm-1", "chat-1");
    let root = vm_workspace_root(&vm);
    fs::write(root.join("notes.txt"), "alpha beta gamma").unwrap();
    fs::write(
        root.join("large.json"),
        serde_json::to_string(&json!({"payload": "x".repeat(256)})).unwrap(),
    )
    .unwrap();

    let mut lookups = work_bind_source_lookup_count(&vm.vm_id);
    let created = response_payload(
        handle_create_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("/work/generated.txt")),
            ("content", json!("generated")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(created["success"], json!(true));
    let create_lookups = work_bind_source_lookup_count(&vm.vm_id);
    assert!(create_lookups > lookups);
    assert_eq!(work_bind_source_inspect_count(&vm.vm_id), 0);
    lookups = create_lookups;

    let read = response_payload(
        handle_read_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("/work/generated.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(read["success"], json!(true));
    assert_eq!(read["content"], json!("generated"));
    let read_lookups = work_bind_source_lookup_count(&vm.vm_id);
    assert!(read_lookups > lookups);
    assert_eq!(work_bind_source_inspect_count(&vm.vm_id), 0);
    lookups = read_lookups;

    let grep = response_payload(
        handle_grep(&args(&[
            ("vm_id", json!("vm-1")),
            ("pattern", json!("beta")),
            ("path", json!("/work")),
            ("output_mode", json!("files")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(grep["success"], json!(true));
    let grep_lookups = work_bind_source_lookup_count(&vm.vm_id);
    assert!(grep_lookups > lookups);
    assert_eq!(work_bind_source_inspect_count(&vm.vm_id), 0);
    lookups = grep_lookups;

    let dispatcher = crate::native::Dispatcher;
    let overflow = response_payload(
        dispatcher
            .call(
                "read_file",
                &args(&[
                    ("vm_id", json!("vm-1")),
                    ("path", json!("/work/large.json")),
                ]),
            )
            .await
            .unwrap()
            .unwrap(),
    );
    assert_eq!(overflow["overflow_file"], json!(true));
    let spill_lookups = work_bind_source_lookup_count(&vm.vm_id);
    assert!(spill_lookups > lookups);
    assert_eq!(work_bind_source_inspect_count(&vm.vm_id), 0);
}

#[tokio::test]
async fn missing_work_bind_source_recovers_once_persists_and_skips_future_inspects() {
    let env = TestEnv::new("work-bind-recovery");
    let mut vm = env.seed_vm("vm-1", "chat-1");
    let actual_root = vm_workspace_root(&vm);
    fs::write(actual_root.join("notes.txt"), "hello recovered world").unwrap();
    vm.work_bind_source = None;
    vm.work_bind_source_verified = false;
    store_vm_info(&vm).unwrap();
    seed_fake_work_bind_source_inspect(&vm.vm_id, actual_root.clone());

    let first = response_payload(
        handle_read_fragment(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("/work/notes.txt")),
            ("offset_chars", json!(0)),
            ("max_chars", json!(64)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(first["success"], json!(true));
    assert_eq!(first["content"], json!("hello recovered world"));
    assert_eq!(work_bind_source_inspect_count(&vm.vm_id), 1);
    assert!(work_bind_source_lookup_count(&vm.vm_id) >= 1);
    let recovered = load_vm_info(&vm.vm_id).unwrap().unwrap();
    assert_eq!(
        recovered.work_bind_source.as_deref(),
        Some(actual_root.to_string_lossy().as_ref())
    );
    assert!(recovered.work_bind_source_verified);

    let lookups_after_first = work_bind_source_lookup_count(&vm.vm_id);
    let second = response_payload(
        handle_create_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("/work/second.txt")),
            ("content", json!("second")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(second["success"], json!(true));
    assert_eq!(work_bind_source_inspect_count(&vm.vm_id), 1);
    assert!(work_bind_source_lookup_count(&vm.vm_id) > lookups_after_first);
}

#[tokio::test]
async fn stale_present_work_bind_source_recovers_once_persists_and_skips_future_inspects() {
    let env = TestEnv::new("work-bind-stale-present");
    let mut vm = env.seed_vm("vm-1", "chat-1");
    let actual_root = vm_workspace_root(&vm);
    let stale_root = env.root.join("stale-work-root");
    fs::create_dir_all(&stale_root).unwrap();
    fs::write(actual_root.join("notes.txt"), "hello from actual root").unwrap();
    vm.work_bind_source = Some(stale_root.display().to_string());
    vm.work_bind_source_verified = false;
    store_vm_info(&vm).unwrap();
    seed_fake_work_bind_source_inspect(&vm.vm_id, actual_root.clone());

    let first = response_payload(
        handle_read_fragment(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("/work/notes.txt")),
            ("offset_chars", json!(0)),
            ("max_chars", json!(64)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(first["success"], json!(true));
    assert_eq!(first["content"], json!("hello from actual root"));
    assert_eq!(work_bind_source_inspect_count(&vm.vm_id), 1);
    let reconciled = load_vm_info(&vm.vm_id).unwrap().unwrap();
    assert_eq!(
        reconciled.work_bind_source.as_deref(),
        Some(actual_root.to_string_lossy().as_ref())
    );
    assert!(reconciled.work_bind_source_verified);

    let lookups_after_first = work_bind_source_lookup_count(&vm.vm_id);
    let second = response_payload(
        handle_grep(&args(&[
            ("vm_id", json!("vm-1")),
            ("pattern", json!("actual")),
            ("path", json!("/work")),
            ("output_mode", json!("files")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(second["success"], json!(true));
    assert_eq!(work_bind_source_inspect_count(&vm.vm_id), 1);
    assert!(work_bind_source_lookup_count(&vm.vm_id) > lookups_after_first);
}

#[tokio::test]
async fn unrecoverable_work_bind_source_failure_surfaces_as_clean_tool_error() {
    let env = TestEnv::new("work-bind-unrecoverable");
    let mut vm = env.seed_vm("vm-1", "chat-1");
    fs::write(vm_workspace_root(&vm).join("notes.txt"), "hello").unwrap();
    vm.work_bind_source = None;
    vm.work_bind_source_verified = false;
    store_vm_info(&vm).unwrap();

    let payload = response_payload(
        handle_read_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("/work/notes.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(payload["success"], json!(false));
    assert_eq!(
        payload["error"],
        json!("Failed to read file or file not found: /work/notes.txt")
    );
    assert_eq!(work_bind_source_inspect_count(&vm.vm_id), 1);
}

#[tokio::test]
async fn dispatcher_recovers_missing_vm_and_returns_replacement_vm_id() {
    let _env = TestEnv::new("dispatcher-recovery");
    let legacy_workspace = _env.root.join("workspaces/chat-1/vm-legacy");
    fs::create_dir_all(legacy_workspace.join(".mcp-overflow")).unwrap();
    fs::write(legacy_workspace.join("notes.txt"), "legacy contents").unwrap();
    fs::write(
        legacy_workspace.join(".mcp-overflow/context.json"),
        "{\"status\":\"ok\"}",
    )
    .unwrap();

    let dispatcher = crate::native::Dispatcher;
    let first = response_payload(
        dispatcher
            .call(
                "read_file",
                &args(&[
                    ("vm_id", json!("vm-legacy")),
                    ("path", json!("/work/notes.txt")),
                ]),
            )
            .await
            .unwrap()
            .unwrap(),
    );

    let replacement_vm_id = first["vm_id"]
        .as_str()
        .expect("replacement vm_id")
        .to_string();
    assert_ne!(replacement_vm_id, "vm-legacy");
    assert_eq!(first["requested_vm_id"], json!("vm-legacy"));
    assert_eq!(first["recovered_from_vm_id"], json!("vm-legacy"));
    assert_eq!(first["vm_id_changed"], json!(true));
    assert_eq!(first["recovered_automatically"], json!(true));
    assert_eq!(first["content"], json!("legacy contents"));
    assert_eq!(
        redis_get_string("agent_vm_recovery_alias:vm-legacy").unwrap(),
        Some(replacement_vm_id.clone())
    );

    let second = response_payload(
        dispatcher
            .call(
                "read_file",
                &args(&[
                    ("vm_id", json!("vm-legacy")),
                    ("path", json!("/work/.mcp-overflow/context.json")),
                ]),
            )
            .await
            .unwrap()
            .unwrap(),
    );
    assert_eq!(second["vm_id"], json!(replacement_vm_id));
    assert_eq!(second["requested_vm_id"], json!("vm-legacy"));
    assert_eq!(second["vm_id_changed"], json!(true));
    assert_eq!(second["content"], json!("{\"status\":\"ok\"}"));
}

#[tokio::test]
async fn resolve_vm_for_request_follows_alias_chains_and_flattens_requested_aliases() {
    let env = TestEnv::new("resolve-alias-chain");
    let live_vm = env.seed_vm("vm-live", "chat-1");

    redis_set_string("agent_vm_recovery_alias:vm-old", "vm-mid").unwrap();
    store_vm_recovery_alias("vm-mid", &live_vm).unwrap();
    redis_set_string("agent_vm_recovery_alias:vm-self", "vm-self").unwrap();

    let resolved = resolve_vm_for_request("vm-old", Some("chat-1"))
        .await
        .unwrap()
        .expect("resolved live vm");
    assert_eq!(resolved.requested_vm_id, "vm-old");
    assert_eq!(resolved.effective_vm.vm_id, live_vm.vm_id);
    assert!(resolved.vm_id_changed());
    assert_eq!(
        redis_get_string("agent_vm_recovery_alias:vm-old").unwrap(),
        Some(live_vm.vm_id.clone())
    );
    assert_eq!(
        redis_get_string("agent_vm_recovery_alias:vm-mid").unwrap(),
        Some(live_vm.vm_id.clone())
    );

    assert!(resolve_vm_for_request("vm-self", None)
        .await
        .unwrap()
        .is_none());
    assert!(redis_get_string("agent_vm_recovery_alias:vm-self")
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn resolve_vm_for_request_recovers_stale_metadata_using_saved_workspace_and_timeout() {
    let env = TestEnv::new("resolve-stale-metadata");
    let mut stale_vm = env.seed_vm("vm-stale", "chat-1");
    stale_vm.timeout_hours = 9.5;
    store_vm_info(&stale_vm).unwrap();
    fs::write(
        vm_workspace_root(&stale_vm).join("notes.txt"),
        "legacy contents",
    )
    .unwrap();
    seed_fake_vm_container(
        &stale_vm.container_id,
        &format!("agent-vm-{}", stale_vm.vm_id),
        "exited",
    );

    let resolved = resolve_vm_for_request("vm-stale", Some("chat-1"))
        .await
        .unwrap()
        .expect("recovered vm");
    assert!(resolved.vm_id_changed());
    let recovered_vm = resolved.effective_vm;
    assert_ne!(recovered_vm.vm_id, stale_vm.vm_id);
    assert_eq!(recovered_vm.chat_id, stale_vm.chat_id);
    assert_eq!(recovered_vm.timeout_hours, 9.5);
    assert_eq!(resolved.requested_vm_id, "vm-stale");
    assert_eq!(
        load_default_vm_for_chat("chat-1").unwrap().unwrap().vm_id,
        recovered_vm.vm_id
    );
    assert!(load_vm_info("vm-stale").unwrap().is_none());
    assert!(inspect_vm_container_status(&stale_vm)
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        redis_get_string("agent_vm_recovery_alias:vm-stale").unwrap(),
        Some(recovered_vm.vm_id.clone())
    );
    assert_eq!(
        fs::read_to_string(
            host_vm_workspace_root("chat-1", &recovered_vm.vm_id)
                .unwrap()
                .join("notes.txt")
        )
        .unwrap(),
        "legacy contents"
    );
}

#[tokio::test]
async fn dispatcher_routes_copied_foreign_vm_history_to_clone_owned_workspace() {
    let env = TestEnv::new("foreign-vm-clone-routing");
    let original_vm = env.seed_vm("vm-original", "chat-original");
    fs::write(
        vm_workspace_root(&original_vm).join("original-only.txt"),
        "original contents",
    )
    .unwrap();
    redis_set_string(
        "agent_vm_recovery_alias:vm-from-history",
        &original_vm.vm_id,
    )
    .unwrap();
    redis_set_string("agent_vm:chat-clone", &original_vm.vm_id).unwrap();

    let payload = response_payload(
        crate::native::Dispatcher
            .call(
                "create_file",
                &args(&[
                    ("vm_id", json!("vm-from-history")),
                    ("chat_id", json!("chat-clone")),
                    ("path", json!("/work/clone-only.txt")),
                    ("content", json!("clone contents")),
                ]),
            )
            .await
            .unwrap()
            .unwrap(),
    );

    let clone_vm_id = payload["vm_id"].as_str().expect("clone vm id");
    assert_eq!(payload["success"], json!(true));
    assert_eq!(payload["chat_id"], json!("chat-clone"));
    assert_eq!(payload["requested_vm_id"], json!("vm-from-history"));
    assert_ne!(clone_vm_id, original_vm.vm_id);

    let clone_vm = load_vm_info(clone_vm_id)
        .unwrap()
        .expect("clone VM metadata");
    assert_eq!(clone_vm.chat_id, "chat-clone");
    assert_eq!(
        load_default_vm_for_chat("chat-clone")
            .unwrap()
            .unwrap()
            .vm_id,
        clone_vm_id
    );
    assert_eq!(
        redis_get_string("agent_vm_recovery_alias:vm-from-history").unwrap(),
        Some(original_vm.vm_id.clone())
    );
    assert!(load_vm_info(&original_vm.vm_id).unwrap().is_some());
    assert_eq!(
        fs::read_to_string(vm_workspace_root(&clone_vm).join("clone-only.txt")).unwrap(),
        "clone contents"
    );
    assert!(!vm_workspace_root(&clone_vm)
        .join("original-only.txt")
        .exists());
    assert!(!vm_workspace_root(&original_vm)
        .join("clone-only.txt")
        .exists());
}

#[tokio::test]
async fn concurrent_foreign_vm_requests_create_one_clone_owned_vm() {
    let env = TestEnv::new("foreign-vm-concurrent-routing");
    let original_vm = env.seed_vm("vm-original", "chat-original");

    let (first, second) = tokio::join!(
        resolve_vm_for_request(&original_vm.vm_id, Some("chat-clone")),
        resolve_vm_for_request(&original_vm.vm_id, Some("chat-clone")),
    );
    let first = first.unwrap().expect("first clone VM resolution");
    let second = second.unwrap().expect("second clone VM resolution");

    assert_eq!(first.effective_vm.chat_id, "chat-clone");
    assert_eq!(first.effective_vm.vm_id, second.effective_vm.vm_id);
    assert_eq!(
        load_default_vm_for_chat("chat-clone")
            .unwrap()
            .unwrap()
            .vm_id,
        first.effective_vm.vm_id
    );
    assert_ne!(first.effective_vm.vm_id, original_vm.vm_id);
}

#[tokio::test]
async fn destroyed_foreign_vm_id_creates_clone_vm_without_resurrecting_original() {
    let env = TestEnv::new("destroyed-foreign-vm-clone-routing");
    let original_vm = env.seed_vm("vm-original", "chat-original");
    let destroyed = response_payload(
        handle_destroy(&args(&[
            ("vm_id", json!(original_vm.vm_id)),
            ("requester_chat_id", json!("chat-original")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(destroyed["success"], json!(true));

    let clone_resolution = resolve_vm_for_request("vm-original", Some("chat-clone"))
        .await
        .unwrap()
        .expect("clone replacement VM");
    assert_eq!(clone_resolution.effective_vm.chat_id, "chat-clone");
    assert_ne!(clone_resolution.effective_vm.vm_id, "vm-original");
    assert!(load_vm_info("vm-original").unwrap().is_none());
    assert!(resolve_vm_for_request("vm-original", Some("chat-original"))
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn foreign_vm_resolution_uses_clone_custom_workspace_without_copying_original_files() {
    let env = TestEnv::new("foreign-vm-custom-clone-workspace");
    let workspace_cfg = env.root.join("workspace-cfg");
    let original_workspace = env.root.join("original custom workspace");
    let clone_workspace = env.root.join("clone custom workspace");
    fs::create_dir_all(&workspace_cfg).unwrap();
    fs::create_dir_all(&original_workspace).unwrap();
    fs::create_dir_all(&clone_workspace).unwrap();
    fs::write(
        workspace_cfg.join("chat-workspaces.json"),
        json!({
            "chats": {
                "chat-original": {
                    "source": "custom",
                    "host_path": original_workspace.display().to_string()
                },
                "chat-clone": {
                    "source": "custom",
                    "host_path": clone_workspace.display().to_string()
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    let _guard = EnvGuard::set(&[(
        "PORTICO_WORKSPACE_CFG_DIR",
        Some(workspace_cfg.to_str().unwrap()),
    )]);

    let original_vm = create_vm("chat-original", 1.0, None).await.unwrap();
    fs::write(original_workspace.join("original-only.txt"), "original").unwrap();
    let clone_resolution = resolve_vm_for_request(&original_vm.vm_id, Some("chat-clone"))
        .await
        .unwrap()
        .expect("clone VM");

    assert_eq!(clone_resolution.effective_vm.chat_id, "chat-clone");
    assert_eq!(
        clone_resolution.effective_vm.work_bind_source.as_deref(),
        Some(clone_workspace.to_str().unwrap())
    );
    assert!(!clone_workspace.join("original-only.txt").exists());
    assert_eq!(
        fs::read_to_string(original_workspace.join("original-only.txt")).unwrap(),
        "original"
    );
}

#[tokio::test]
async fn inherited_subagent_workspace_keeps_child_owned_vm_identity() {
    let env = TestEnv::new("subagent-inherited-workspace-identity");
    let workspace_cfg = env.root.join("workspace-cfg");
    let inherited_workspace = env.root.join("parent custom workspace");
    fs::create_dir_all(&workspace_cfg).unwrap();
    fs::create_dir_all(&inherited_workspace).unwrap();
    fs::write(
        workspace_cfg.join("chat-workspaces.json"),
        json!({
            "chats": {
                "parent-chat": {
                    "source": "custom",
                    "host_path": inherited_workspace.display().to_string()
                },
                "child-chat": {
                    "source": "custom",
                    "host_path": inherited_workspace.display().to_string(),
                    "inherited_workspace": true,
                    "inherited_from_chat_id": "parent-chat",
                    "root_parent_chat_id": "parent-chat"
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    let _guard = EnvGuard::set(&[(
        "PORTICO_WORKSPACE_CFG_DIR",
        Some(workspace_cfg.to_str().unwrap()),
    )]);

    let parent_vm = create_vm("parent-chat", 1.0, None).await.unwrap();
    let child_resolution = resolve_vm_for_request(&parent_vm.vm_id, Some("child-chat"))
        .await
        .unwrap()
        .expect("child VM");

    assert_eq!(child_resolution.effective_vm.chat_id, "child-chat");
    assert_ne!(child_resolution.effective_vm.vm_id, parent_vm.vm_id);
    assert_eq!(
        child_resolution.effective_vm.work_bind_source,
        parent_vm.work_bind_source
    );
    assert_eq!(
        load_default_vm_for_chat("child-chat")
            .unwrap()
            .unwrap()
            .vm_id,
        child_resolution.effective_vm.vm_id
    );
}

#[test]
fn scoped_skill_env_pathing_and_parser_are_strict() {
    let env = TestEnv::new("skill-env-pathing");
    let _guard = EnvGuard::set(&[(
        "PORTICO_APP_SUPPORT_DIR",
        Some(env.root.join("app-support").to_str().unwrap()),
    )]);

    let marketplace_path = scoped_skill_env_path("foo/bar").unwrap();
    assert!(marketplace_path.ends_with("skill-env/foo/bar/execute-skill-script.env"));
    assert!(scoped_skill_env_path("foo__bar")
        .unwrap()
        .ends_with("skill-env/foo__bar/execute-skill-script.env"));
    assert!(scoped_skill_env_path("../bar").is_err());
    assert!(scoped_skill_env_path("foo//bar").is_err());
    assert!(scoped_skill_env_path("foo\\bar").is_err());
    assert!(scoped_skill_env_path(".hidden/bar").is_err());
    assert!(scoped_skill_env_path("_private/bar").is_err());

    let parsed = parse_skill_env_contents(
        "\n# comment\nexport TOKEN='alpha beta'\nLDAP=user\nCHAT_ID=evil\nEMPTY=\n",
    )
    .unwrap();
    assert_eq!(
        parsed,
        vec![
            ("EMPTY".to_string(), "".to_string()),
            ("LDAP".to_string(), "user".to_string()),
            ("TOKEN".to_string(), "alpha beta".to_string()),
        ]
    );
    let bad = parse_skill_env_contents("TOKEN_WITH_BAD-DASH=value\n").unwrap_err();
    assert!(bad.to_string().contains("invalid dotenv key"));
    let secret_error = parse_skill_env_contents("TOKEN='super-secret\n").unwrap_err();
    assert!(!secret_error.to_string().contains("super-secret"));
}

#[test]
fn scoped_skill_env_falls_back_to_legacy_two_segment_scope_for_plugin_ids() {
    let env = TestEnv::new("skill-env-legacy-fallback");
    let app_support = env.root.join("app-support");
    let _guard = EnvGuard::set(&[(
        "PORTICO_APP_SUPPORT_DIR",
        Some(app_support.to_str().unwrap()),
    )]);

    // Env saved before the plugin layout lives under {mp}/{leaf}; a
    // 3-segment id must read it when its own scope has no file.
    let legacy_dir = app_support.join("skill-env/kwp/pdf");
    std::fs::create_dir_all(&legacy_dir).unwrap();
    std::fs::write(
        legacy_dir.join("execute-skill-script.env"),
        "LEGACY_TOKEN=from-legacy\n",
    )
    .unwrap();

    assert_eq!(
        load_scoped_skill_env("kwp/document-skills/pdf").unwrap(),
        vec![("LEGACY_TOKEN".to_string(), "from-legacy".to_string())]
    );

    // The exact plugin-scoped file wins once it exists.
    let scoped_dir = app_support.join("skill-env/kwp/document-skills/pdf");
    std::fs::create_dir_all(&scoped_dir).unwrap();
    std::fs::write(
        scoped_dir.join("execute-skill-script.env"),
        "SCOPED_TOKEN=from-scope\n",
    )
    .unwrap();
    assert_eq!(
        load_scoped_skill_env("kwp/document-skills/pdf").unwrap(),
        vec![("SCOPED_TOKEN".to_string(), "from-scope".to_string())]
    );

    // 2-segment ids never fall back anywhere else.
    assert_eq!(load_scoped_skill_env("kwp/missing").unwrap(), Vec::new());
}

#[tokio::test]
async fn execute_skill_script_loads_only_exact_scoped_skill_env() {
    let env = TestEnv::new("skill-env-execution");
    let _guard = EnvGuard::set(&[(
        "PORTICO_APP_SUPPORT_DIR",
        Some(env.root.join("app-support").to_str().unwrap()),
    )]);
    let vm = env.seed_vm("vm-1", "chat-1");

    let demo_script_dir = env.root.join("skills-user/demo/scripts");
    fs::create_dir_all(&demo_script_dir).unwrap();
    fs::write(
        demo_script_dir.join("env.py"),
        "import os\nfor key in ['portico_DEMO_TOKEN','portico_MARKET_TOKEN','portico_WRONG_TOKEN','CHAT_ID','VM_ID','SKILL_NAME']:\n    print(f'{key}={os.environ.get(key, \"<missing>\")}')\n",
    )
    .unwrap();
    let marketplace_script_dir = env.root.join("skills-marketplace/foo/bar/scripts");
    fs::create_dir_all(&marketplace_script_dir).unwrap();
    fs::write(
        marketplace_script_dir.join("env.py"),
        "import os\nfor key in ['portico_DEMO_TOKEN','portico_MARKET_TOKEN','portico_WRONG_TOKEN','CHAT_ID','VM_ID','SKILL_NAME']:\n    print(f'{key}={os.environ.get(key, \"<missing>\")}')\n",
    )
    .unwrap();
    let bar_script_dir = env.root.join("skills-user/bar/scripts");
    fs::create_dir_all(&bar_script_dir).unwrap();
    fs::write(
        bar_script_dir.join("env.py"),
        "import os\nfor key in ['portico_DEMO_TOKEN','portico_MARKET_TOKEN','portico_BAR_TOKEN','portico_WRONG_TOKEN','SKILL_NAME']:\n    print(f'{key}={os.environ.get(key, \"<missing>\")}')\n",
    )
    .unwrap();

    let app_support = env.root.join("app-support");
    fs::create_dir_all(app_support.join("skill-env/demo")).unwrap();
    fs::write(
        app_support.join("skill-env/demo/execute-skill-script.env"),
        "portico_DEMO_TOKEN=demo-secret\nCHAT_ID=wrong-chat\nVM_ID=wrong-vm\nSKILL_NAME=wrong-skill\n",
    )
    .unwrap();
    fs::create_dir_all(app_support.join("skill-env/foo/bar")).unwrap();
    fs::write(
        app_support.join("skill-env/foo/bar/execute-skill-script.env"),
        "portico_MARKET_TOKEN=market-secret\n",
    )
    .unwrap();
    fs::create_dir_all(app_support.join("skill-env/bar")).unwrap();
    fs::write(
        app_support.join("skill-env/bar/execute-skill-script.env"),
        "portico_BAR_TOKEN=bar-secret\nportico_MARKET_TOKEN=wrong-market\n",
    )
    .unwrap();
    fs::create_dir_all(app_support.join("skill-env/foo__bar")).unwrap();
    fs::write(
        app_support.join("skill-env/foo__bar/execute-skill-script.env"),
        "portico_WRONG_TOKEN=flattened-secret\n",
    )
    .unwrap();
    fs::create_dir_all(app_support.join("skill-env/foo")).unwrap();
    fs::write(
        app_support.join("skill-env/foo/execute-skill-script.env"),
        "portico_WRONG_TOKEN=parent-secret\n",
    )
    .unwrap();

    let demo = response_payload(
        handle_execute_skill_script(&args(&[
            ("skill_name", json!("demo")),
            ("script_name", json!("env.py")),
            ("vm_id", json!("vm-1")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(demo["success"], json!(true));
    let demo_stdout = demo["stdout"].as_str().unwrap();
    assert!(demo_stdout.contains("portico_DEMO_TOKEN=demo-secret"));
    assert!(demo_stdout.contains("portico_MARKET_TOKEN=<missing>"));
    assert!(demo_stdout.contains("portico_WRONG_TOKEN=<missing>"));
    assert!(demo_stdout.contains("CHAT_ID=chat-1"));
    assert!(demo_stdout.contains("VM_ID=vm-1"));
    assert!(demo_stdout.contains("SKILL_NAME=demo"));

    let marketplace = response_payload(
        handle_execute_skill_script(&args(&[
            ("skill_name", json!("foo/bar")),
            ("script_name", json!("env.py")),
            ("vm_id", json!("vm-1")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(marketplace["success"], json!(true));
    let marketplace_stdout = marketplace["stdout"].as_str().unwrap();
    assert!(marketplace_stdout.contains("portico_MARKET_TOKEN=market-secret"));
    assert!(marketplace_stdout.contains("portico_DEMO_TOKEN=<missing>"));
    assert!(marketplace_stdout.contains("portico_WRONG_TOKEN=<missing>"));
    assert!(marketplace_stdout.contains("SKILL_NAME=foo/bar"));

    let bar = response_payload(
        handle_execute_skill_script(&args(&[
            ("skill_name", json!("bar")),
            ("script_name", json!("env.py")),
            ("vm_id", json!("vm-1")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(bar["success"], json!(true));
    let bar_stdout = bar["stdout"].as_str().unwrap();
    assert!(bar_stdout.contains("portico_BAR_TOKEN=bar-secret"));
    assert!(bar_stdout.contains("portico_MARKET_TOKEN=wrong-market"));
    assert!(bar_stdout.contains("portico_DEMO_TOKEN=<missing>"));
    assert!(bar_stdout.contains("SKILL_NAME=bar"));

    let bash = exec_in_vm(
        &vm,
        "python3 - <<'PY'\nimport os\nprint(os.environ.get('portico_DEMO_TOKEN', '<missing>'))\nPY",
    )
    .await
    .unwrap();
    assert_eq!(bash.stdout.trim(), "<missing>");
}

#[tokio::test]
async fn destroyed_vm_ids_are_not_silently_recovered() {
    let env = TestEnv::new("destroyed-vm-no-recovery");
    let vm = env.seed_vm("vm-destroyed", "chat-1");
    fs::write(
        vm_workspace_root(&vm).join("notes.txt"),
        "do not resurrect after destroy",
    )
    .unwrap();

    let destroyed = response_payload(
        handle_destroy(&args(&[
            ("vm_id", json!("vm-destroyed")),
            ("requester_chat_id", json!("chat-1")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(destroyed["success"], json!(true));
    assert!(resolve_vm_for_request("vm-destroyed", Some("chat-1"))
        .await
        .unwrap()
        .is_none());

    let payload = response_payload(
        crate::native::Dispatcher
            .call(
                "read_file",
                &args(&[
                    ("vm_id", json!("vm-destroyed")),
                    ("path", json!("/work/notes.txt")),
                ]),
            )
            .await
            .unwrap()
            .unwrap(),
    );
    assert_eq!(payload["success"], json!(false));
    assert_eq!(
        payload["error"],
        json!("Failed to read file or file not found: /work/notes.txt")
    );
    assert!(payload.get("vm_id_changed").is_none());
    assert!(redis_get_string("agent_vm_recovery_alias:vm-destroyed")
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn dispatcher_keeps_runtime_chat_id_when_history_points_to_another_workspace() {
    let _env = TestEnv::new("dispatcher-chat-rewrite");
    let legacy_workspace = _env.root.join("workspaces/chat-real/vm-legacy");
    fs::create_dir_all(&legacy_workspace).unwrap();
    let shared_root = host_chat_workspace_root("chat-real").unwrap();
    fs::create_dir_all(shared_root.join("output")).unwrap();
    fs::write(shared_root.join("output/report.txt"), "report").unwrap();

    let payload = response_payload(
        crate::native::Dispatcher
            .call(
                "list_workspace_files",
                &args(&[
                    ("vm_id", json!("vm-legacy")),
                    ("chat_id", json!("wrong-chat")),
                    ("path", json!("output")),
                ]),
            )
            .await
            .unwrap()
            .unwrap(),
    );

    let replacement_vm_id = payload["vm_id"]
        .as_str()
        .expect("replacement vm_id")
        .to_string();
    assert_ne!(replacement_vm_id, "vm-legacy");
    assert_eq!(payload["chat_id"], json!("wrong-chat"));
    assert_eq!(payload["requested_vm_id"], json!("vm-legacy"));
    assert_eq!(payload["recovered_from_vm_id"], json!("vm-legacy"));
    assert_eq!(payload["vm_id_changed"], json!(true));
    assert_eq!(payload["recovered_automatically"], json!(true));
    assert_eq!(payload["count"], json!(0));
    assert_eq!(
        fs::read_to_string(shared_root.join("output/report.txt")).unwrap(),
        "report"
    );
}

#[tokio::test]
async fn direct_vm_helpers_cover_create_exec_and_cleanup() {
    let _env = TestEnv::new("docker-direct");
    let _docker_mode = DockerModeGuard::real();
    if !ensure_docker_prereqs().await.unwrap() {
        eprintln!("Skipping real Docker coverage test because no Docker socket is available");
        return;
    }

    let vm = match create_vm("chat-direct", 5.0, Some("shared-direct".to_string())).await {
        Ok(vm) => vm,
        Err(error) if docker_create_blocked(&error) => {
            eprintln!("Skipping real Docker coverage test because container creation is blocked");
            return;
        }
        Err(error) => panic!("create vm directly: {error:#}"),
    };
    assert_eq!(vm.chat_id, "chat-direct");
    assert_eq!(load_vm(&vm.vm_id).unwrap().container_id, vm.container_id);
    assert_eq!(
        load_vm_info(&vm.vm_id)
            .unwrap()
            .unwrap()
            .sharing_key
            .as_deref(),
        Some("shared-direct")
    );

    let result = exec_in_vm(&vm, "printf direct-run && >&2 printf direct-err")
        .await
        .expect("exec in vm");
    assert_eq!(result.exit_code, 0);
    assert_eq!(result.stdout, "direct-run");
    assert_eq!(result.stderr, "direct-err");

    let runtime_tools = exec_in_vm(
        &vm,
        "jq --version && node --version && python3 --version && bash --version >/dev/null",
    )
    .await
    .expect("validate vm runtime tools");
    assert_eq!(runtime_tools.exit_code, 0);
    assert!(runtime_tools.stdout.contains("jq-"));
    assert!(runtime_tools.stdout.contains("v"));
    assert!(runtime_tools.stdout.contains("Python 3."));

    remove_vm_container(&vm).await.unwrap();
    delete_vm_info(&vm.vm_id).unwrap();
}

#[tokio::test]
async fn docker_backed_overflow_files_are_readable_via_bash_and_read_file() {
    let env = TestEnv::new("docker-overflow-readback");
    let _docker_mode = DockerModeGuard::real();
    let _overflow_env = EnvGuard::set(&[
        ("AGENT_VM_TOOL_RESULT_MAX_CHARS", Some("10")),
        ("AGENT_VM_TOOL_RESULT_OVERFLOW_ENABLED", Some("true")),
    ]);
    if !ensure_docker_prereqs().await.unwrap() {
        eprintln!(
            "Skipping real Docker overflow readback test because no Docker socket is available"
        );
        return;
    }

    let created_response = match handle_create(&args(&[
        ("chat_id", json!("chat-overflow-readback")),
        ("timeout_hours", json!(0.1)),
    ]))
    .await
    {
        Ok(response) => response,
        Err(error) if docker_create_blocked(&error) => {
            eprintln!(
                "Skipping real Docker overflow readback test because container creation is blocked"
            );
            return;
        }
        Err(error) => panic!("failed to create VM via handler: {error:#}"),
    };
    let created = response_payload(created_response);
    let vm_id = created["vm_id"].as_str().unwrap().to_string();

    let large_json = serde_json::to_string(&json!({"payload": "x".repeat(256)})).unwrap();
    let created_file = response_payload(
        handle_create_file(&args(&[
            ("vm_id", json!(vm_id.clone())),
            ("path", json!("/work/large.json")),
            ("content", json!(large_json)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(created_file["success"], json!(true));

    let mut stored_vm = load_vm_info(&vm_id).unwrap().expect("stored vm info");
    let actual_root = vm_workspace_root(&stored_vm);
    let stale_root = env.root.join("stale-docker-work-root");
    fs::create_dir_all(&stale_root).unwrap();
    stored_vm.work_bind_source = Some(stale_root.display().to_string());
    stored_vm.work_bind_source_verified = false;
    store_vm_info(&stored_vm).unwrap();

    let overflow = response_payload(
        crate::native::Dispatcher
            .call(
                "read_file",
                &args(&[
                    ("vm_id", json!(vm_id.clone())),
                    ("path", json!("/work/large.json")),
                ]),
            )
            .await
            .unwrap()
            .unwrap(),
    );
    assert_eq!(overflow["overflow_file"], json!(true));
    let overflow_path = overflow["path"].as_str().unwrap().to_string();
    let reconciled_vm = load_vm_info(&vm_id).unwrap().expect("reconciled vm info");
    assert_eq!(
        reconciled_vm.work_bind_source.as_deref(),
        Some(actual_root.to_string_lossy().as_ref())
    );
    assert!(reconciled_vm.work_bind_source_verified);
    assert_eq!(work_bind_source_inspect_count(&vm_id), 1);

    let bash = response_payload(
        handle_bash(&args(&[
            ("vm_id", json!(vm_id.clone())),
            (
                "command",
                json!(format!(
                    "test -f {overflow_path} && jq -r '.content | fromjson | .payload | length' {overflow_path}"
                )),
            ),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(bash["success"], json!(true));
    assert_eq!(bash["stdout"], json!("256\n"));
    assert_eq!(work_bind_source_inspect_count(&vm_id), 1);

    let read_overflow = response_payload(
        handle_read_file(&args(&[
            ("vm_id", json!(vm_id.clone())),
            ("path", json!(overflow_path.clone())),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(read_overflow["success"], json!(true));
    let spilled_payload: Value =
        serde_json::from_str(read_overflow["content"].as_str().unwrap()).unwrap();
    assert_eq!(spilled_payload["success"], json!(true));
    assert_eq!(spilled_payload["path"], json!("/work/large.json"));
    assert_eq!(
        spilled_payload["content"].as_str().unwrap().len(),
        large_json.len()
    );

    let destroyed = response_payload(
        handle_destroy(&args(&[
            ("vm_id", json!(vm_id)),
            ("requester_chat_id", json!("chat-overflow-readback")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(destroyed["success"], json!(true));
}

#[path = "agent_vm_more_tests.rs"]
mod more_tests;
