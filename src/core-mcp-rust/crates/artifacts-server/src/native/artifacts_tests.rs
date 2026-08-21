#[rustfmt::skip]
use super::*;
use crate::native::TEST_ENV_LOCK;
use std::sync::MutexGuard;

struct EnvVarGuard {
    key: &'static str,
    previous: Option<String>,
}

impl EnvVarGuard {
    fn set(key: &'static str, value: &str) -> Self {
        let previous = env::var(key).ok();
        env::set_var(key, value);
        Self { key, previous }
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        if let Some(value) = &self.previous {
            env::set_var(self.key, value);
        } else {
            env::remove_var(self.key);
        }
    }
}

struct TestRoot {
    _guard: MutexGuard<'static, ()>,
    path: PathBuf,
    previous_container_root: Option<String>,
    previous_host_root: Option<String>,
    previous_test_redis: Option<String>,
    previous_test_docker: Option<String>,
    previous_notify_disable: Option<String>,
}

impl TestRoot {
    fn new(name: &str) -> Self {
        let guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let path = env::temp_dir().join(format!(
            "core-mcp-rust-artifacts-{name}-{}",
            Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&path).expect("failed to create temp root");
        let previous_container_root = env::var("CONTAINER_PROJECT_ROOT").ok();
        let previous_host_root = env::var("HOST_PROJECT_ROOT").ok();
        let previous_test_redis = env::var("CORE_MCP_TEST_REDIS").ok();
        let previous_test_docker = env::var("CORE_MCP_TEST_DOCKER").ok();
        let previous_notify_disable = env::var("DISABLE_ELECTRON_NOTIFICATIONS").ok();
        env::set_var("CONTAINER_PROJECT_ROOT", &path);
        env::set_var("HOST_PROJECT_ROOT", &path);
        env::remove_var("CORE_MCP_TEST_REDIS");
        env::set_var("CORE_MCP_TEST_DOCKER", "fake");
        env::set_var("DISABLE_ELECTRON_NOTIFICATIONS", "1");
        fake_runtime_events()
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clear();
        Self {
            _guard: guard,
            path,
            previous_container_root,
            previous_host_root,
            previous_test_redis,
            previous_test_docker,
            previous_notify_disable,
        }
    }

    fn artifact_file(&self, _chat_id: &str, artifact_id: &str, relative_path: &str) -> PathBuf {
        self.path
            .join("artifact-snapshots")
            .join("_workspaces")
            .join(artifact_id)
            .join(relative_path)
    }

    fn version_artifact_file(
        &self,
        artifact_id: &str,
        version: i64,
        relative_path: &str,
    ) -> PathBuf {
        self.path
            .join("artifact-snapshots")
            .join("_version_workspaces")
            .join(artifact_id)
            .join(format!("v{version}"))
            .join(relative_path)
    }

    fn write_source_file(&self, chat_id: &str, _vm_id: &str, relative_path: &str, contents: &str) {
        let path = self
            .path
            .join("workspaces")
            .join(chat_id)
            .join(relative_path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("failed to create source parent");
        }
        fs::write(&path, contents).expect("failed to write source file");
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
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
        if let Some(value) = &self.previous_notify_disable {
            env::set_var("DISABLE_ELECTRON_NOTIFICATIONS", value);
        } else {
            env::remove_var("DISABLE_ELECTRON_NOTIFICATIONS");
        }
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn response_payload(response: Value) -> Value {
    serde_json::from_str(
        response["content"][0]["text"]
            .as_str()
            .expect("missing response text"),
    )
    .expect("invalid JSON payload")
}

fn args(entries: &[(&str, Value)]) -> Map<String, Value> {
    entries
        .iter()
        .map(|(key, value)| ((*key).to_string(), value.clone()))
        .collect()
}

fn version(version: i64, snapshot_path: &str) -> ArtifactVersion {
    ArtifactVersion {
        version,
        created_at: version as f64,
        snapshot_path: snapshot_path.to_string(),
        version_note: format!("v{version}"),
    }
}

fn sample_info() -> ArtifactInfo {
    ArtifactInfo {
        artifact_id: "artifact-1".to_string(),
        chat_id: "chat-1".to_string(),
        name: "Calculator App!".to_string(),
        description: "demo".to_string(),
        created_at: 1.0,
        start_command: "npm run dev".to_string(),
        working_directory: "/work".to_string(),
        container_port: 5173,
        current_version: 2,
        host_port: Some(10042),
        running_vm_id: Some("vm-1".to_string()),
        bound_vm_id: Some("vm-1".to_string()),
        status: STATUS_RUNNING.to_string(),
        error_message: None,
        versions: vec![version(1, "one.tar.gz"), version(2, "two.tar.gz")],
    }
}

macro_rules! call {
    ($handler:ident, $arguments:expr) => {{
        let arguments = $arguments;
        response_payload($handler(&arguments).await.unwrap())
    }};
}

#[test]
fn pure_helpers_cover_serialization_and_contract_views() {
    let info = sample_info();
    assert_eq!(
        ArtifactVersion::from_json(&version(2, "/tmp/v2.tar.gz").to_json())
            .unwrap()
            .version,
        2
    );
    assert_eq!(ArtifactInfo::from_json(&info.to_json()).unwrap(), info);
    assert_eq!(
        preview_url(STATUS_RUNNING, Some(10123)).as_deref(),
        Some("http://localhost:10123")
    );
    assert_eq!(preview_url(STATUS_STOPPED, Some(10123)), None);
    assert_eq!(preview_url("error", Some(10123)), None);
    let filtered = sanitize_artifact_response(&info, false);
    assert_eq!(filtered["versions"].as_array().unwrap().len(), 1);
    assert_eq!(filtered["versions"][0]["version"], json!(2));
    assert!(filtered["versions"][0].get("snapshot_path").is_none());
    assert!(filtered.get("running_vm_id").is_none());
    assert!(filtered.get("bound_vm_id").is_none());
    assert!(filtered.get("working_directory").is_none());
    assert_eq!(select_version(&info, None).unwrap().version, 2);
    assert_eq!(select_version(&info, Some(1)).unwrap().version, 1);
    assert!(select_version(&info, Some(99)).is_err());
    assert_eq!(
        truncate_version_note("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")
            .chars()
            .count(),
        MAX_VERSION_NOTE_LEN
    );
    assert_eq!(truncate_version_note("short"), "short");
    assert_eq!(
        archive_file_name("Calculator App!", 3),
        "Calculator_App_v3.tar.gz"
    );
    assert_eq!(archive_file_name("***", 1), "artifact_v1.tar.gz");
    assert_eq!(running_versions_payload(&info).len(), 1);
    assert_eq!(
        artifact_status_payload(&info)["preview_url"],
        json!("http://localhost:10042")
    );
    let mut stopped = info;
    stopped.status = STATUS_STOPPED.to_string();
    assert!(running_versions_payload(&stopped).is_empty());

    let mut leaking = sample_info();
    leaking.working_directory = "/app/workspaces/chat-1/dev-vm".to_string();
    leaking.error_message =
        Some("failed to unpack /app/artifact-snapshots/artifact-1/v2.tar.gz".to_string());
    leaking.versions[0].snapshot_path = "/app/artifact-snapshots/artifact-1/v1.tar.gz".to_string();
    let sanitized = sanitize_artifact_response(&leaking, true);
    let sanitized_text = serde_json::to_string(&sanitized).unwrap();
    assert!(!sanitized_text.contains("/app/"));
    assert!(!sanitized_text.contains("artifact-snapshots"));
    assert!(sanitized.get("working_directory").is_none());
    assert_eq!(
        sanitized["error_message"],
        json!("Artifact operation failed. Reopen or recreate the artifact, then try again.")
    );
    assert_eq!(
        artifact_status_payload(&leaking)["error_message"],
        json!("Artifact operation failed. Reopen or recreate the artifact, then try again.")
    );
}

#[tokio::test]
async fn helper_and_handler_happy_path_without_redis() {
    let root = TestRoot::new("handlers");
    let source = root.path.join("source");
    fs::create_dir_all(source.join("nested")).unwrap();
    fs::write(source.join("nested/file.txt"), "hello").unwrap();
    tar_directory(&source, &root.path.join("archive.tar.gz")).unwrap();
    untar_directory(
        &root.path.join("archive.tar.gz"),
        &root.path.join("unpacked"),
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(root.path.join("unpacked/nested/file.txt")).unwrap(),
        "hello"
    );
    assert!(source_workspace("chat-seed", None).unwrap().exists());

    root.write_source_file("chat-1", "dev-vm", "index.html", "v1");
    let create = call!(
        handle_create_artifact,
        args(&[
            ("chat_id", json!("chat-1")),
            ("name", json!("Calculator App!")),
            ("start_command", json!("npm run dev")),
            ("vm_id", json!("dev-vm"))
        ])
    );
    let artifact_id = create["artifact_id"].as_str().unwrap().to_string();
    assert_eq!(create["success"], json!(true));
    assert_eq!(create["status"], json!(STATUS_RUNNING));
    assert!(create["host_port"].as_u64().unwrap() >= ARTIFACT_PORT_START as u64);
    assert_eq!(
        fs::read_to_string(root.artifact_file("chat-1", &artifact_id, "index.html")).unwrap(),
        "v1"
    );
    assert_eq!(
        fs::read_to_string(root.version_artifact_file(&artifact_id, 1, "index.html")).unwrap(),
        "v1"
    );

    let runtime_events_before_reopen = fake_runtime_events()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone();
    let reopened = call!(
        handle_open_artifact,
        args(&[("artifact_id", json!(artifact_id.clone()))])
    );
    assert_eq!(reopened["success"], json!(true));
    assert_eq!(reopened["reused"], json!(true));
    assert_eq!(
        *fake_runtime_events()
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()),
        runtime_events_before_reopen
    );

    let restarted = call!(
        handle_open_artifact,
        args(&[
            ("artifact_id", json!(artifact_id.clone())),
            ("force_restart", json!(true))
        ])
    );
    assert_eq!(restarted["success"], json!(true));
    assert_eq!(restarted["reused"], json!(false));
    let runtime_events_after_restart = fake_runtime_events()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone();
    assert_eq!(
        runtime_events_after_restart[runtime_events_after_restart.len() - 3..],
        [
            format!("remove:{artifact_id}"),
            format!("create:{artifact_id}"),
            format!("start:{artifact_id}"),
        ]
    );

    let listed = call!(
        handle_list_artifacts,
        args(&[
            ("chat_id", json!("chat-1")),
            ("include_all_versions", json!(false))
        ])
    );
    assert_eq!(listed["count"], json!(1));
    assert_eq!(
        listed["artifacts"][0]["versions"].as_array().unwrap().len(),
        1
    );

    root.write_source_file("chat-1", "dev-vm", "index.html", "v2");
    let created_version = call!(
        handle_create_artifact_version,
        args(&[
            ("artifact_id", json!(artifact_id)),
            ("chat_id", json!("chat-1")),
            ("source_vm_id", json!("dev-vm")),
            (
                "version_note",
                json!(
                    "This is an intentionally long version note that should be truncated cleanly."
                )
            )
        ])
    );
    assert_eq!(created_version["version"], json!(2));
    assert!(created_version["version_note"]
        .as_str()
        .unwrap()
        .ends_with("..."));
    assert_eq!(
        fs::read_to_string(root.artifact_file("chat-1", &artifact_id, "index.html")).unwrap(),
        "v2"
    );
    assert_eq!(
        fs::read_to_string(root.version_artifact_file(&artifact_id, 2, "index.html")).unwrap(),
        "v2"
    );
    assert_eq!(
        fs::read_to_string(root.version_artifact_file(&artifact_id, 1, "index.html")).unwrap(),
        "v1"
    );

    let running = call!(
        handle_get_artifact_running_versions,
        args(&[("artifact_id", json!(artifact_id))])
    );
    assert_eq!(running["current_version"], json!(2));
    assert_eq!(running["running_versions"].as_array().unwrap().len(), 1);

    let opened = call!(
        handle_open_artifact,
        args(&[
            ("artifact_id", json!(artifact_id)),
            ("version", json!(1)),
            ("detached", json!(true))
        ])
    );
    assert_eq!(opened["status"], json!(STATUS_RUNNING));
    assert_eq!(
        fs::read_to_string(root.artifact_file("chat-1", &artifact_id, "index.html")).unwrap(),
        "v1"
    );
    assert_eq!(
        fs::read_to_string(root.version_artifact_file(&artifact_id, 1, "index.html")).unwrap(),
        "v1"
    );

    let switched = call!(
        handle_switch_artifact_version,
        args(&[("artifact_id", json!(artifact_id)), ("version", json!(2))])
    );
    assert_eq!(switched["version"], json!(2));
    assert_eq!(switched["from_pool"], json!(false));
    assert_eq!(
        fs::read_to_string(root.artifact_file("chat-1", &artifact_id, "index.html")).unwrap(),
        "v2"
    );
    assert_eq!(
        fs::read_to_string(root.version_artifact_file(&artifact_id, 2, "index.html")).unwrap(),
        "v2"
    );

    let status = call!(
        handle_get_artifact_status,
        args(&[("artifact_id", json!(artifact_id))])
    );
    assert_eq!(status["status"], json!(STATUS_RUNNING));
    assert_eq!(status["current_version"], json!(2));

    let downloaded = call!(
        handle_download_artifact,
        args(&[
            ("artifact_id", json!(artifact_id)),
            ("chat_id", json!("chat-1")),
            ("version", json!(1))
        ])
    );
    assert_eq!(
        downloaded["file_path"],
        json!("output/Calculator_App_v1.tar.gz")
    );
    assert!(root
        .path
        .join("workspaces/chat-1/output/Calculator_App_v1.tar.gz")
        .exists());

    let restored = call!(
        handle_restore_artifact_version,
        args(&[
            ("artifact_id", json!(artifact_id)),
            ("version", json!(1)),
            ("chat_id", json!("chat-1"))
        ])
    );
    assert_eq!(restored["message"], json!("Restored to version 1."));
    assert_eq!(restored["status"], json!(STATUS_RUNNING));
    assert!(restored["preview_url"].as_str().is_some());
    assert_eq!(
        fs::read_to_string(root.artifact_file("chat-1", &artifact_id, "index.html")).unwrap(),
        "v1"
    );
    assert_eq!(
        fs::read_to_string(root.version_artifact_file(&artifact_id, 1, "index.html")).unwrap(),
        "v1"
    );

    let closed = call!(
        handle_close_artifact,
        args(&[("artifact_id", json!(artifact_id))])
    );
    assert_eq!(
        closed["message"],
        json!("Artifact closed and server stopped.")
    );
    let stopped = call!(
        handle_get_artifact_status,
        args(&[("artifact_id", json!(artifact_id))])
    );
    assert_eq!(stopped["status"], json!(STATUS_STOPPED));
    assert_eq!(stopped["preview_url"], Value::Null);

    let deleted = call!(
        handle_delete_artifact,
        args(&[
            ("artifact_id", json!(artifact_id)),
            ("chat_id", json!("chat-1")),
            ("confirm", json!(true))
        ])
    );
    assert_eq!(deleted["message"], json!("Artifact deleted."));
    assert_eq!(
        call!(
            handle_list_artifacts,
            args(&[
                ("chat_id", json!("chat-1")),
                ("include_all_versions", json!(true))
            ])
        )["count"],
        json!(0)
    );
    let events = fake_runtime_events()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone();
    assert!(events
        .iter()
        .any(|event| event == &format!("create:{artifact_id}")));
    assert!(events
        .iter()
        .any(|event| event == &format!("start:{artifact_id}")));
    assert!(events
        .iter()
        .any(|event| event == &format!("remove:{artifact_id}")));
}

#[tokio::test]
async fn download_artifact_rejects_mismatched_chat_id() {
    let root = TestRoot::new("download-mismatch");
    root.write_source_file("chat-1", "dev-vm", "index.html", "v1");

    let created = call!(
        handle_create_artifact,
        args(&[
            ("chat_id", json!("chat-1")),
            ("name", json!("Calculator App!")),
            ("start_command", json!("npm run dev")),
            ("vm_id", json!("dev-vm"))
        ])
    );
    let artifact_id = created["artifact_id"].as_str().unwrap().to_string();

    let error = handle_download_artifact(&args(&[
        ("artifact_id", json!(artifact_id)),
        ("chat_id", json!("chat-2")),
        ("version", json!(1)),
    ]))
    .await
    .unwrap_err();

    assert!(error
        .to_string()
        .contains("artifact does not belong to chat_id"));
}

#[tokio::test]
async fn custom_workspace_roots_are_used_for_snapshot_and_download() {
    let root = TestRoot::new("custom-workspace");
    let custom_root = root.path.join("custom-chat-root");
    fs::create_dir_all(&custom_root).unwrap();
    fs::write(custom_root.join("index.html"), "custom").unwrap();
    let cfg_dir = root.path.join("workspace-cfg");
    fs::create_dir_all(&cfg_dir).unwrap();
    fs::write(
        cfg_dir.join(CHAT_WORKSPACES_SETTINGS_FILE_NAME),
        json!({
            "chats": {
                "chat-custom": {
                    "source": "custom",
                    "host_path": custom_root
                }
            }
        })
        .to_string(),
    )
    .unwrap();

    let created = call!(
        handle_create_artifact,
        args(&[
            ("chat_id", json!("chat-custom")),
            ("name", json!("Custom Workspace")),
            ("start_command", json!("python -m http.server 5173"))
        ])
    );
    let artifact_id = created["artifact_id"].as_str().unwrap().to_string();
    assert_eq!(
        fs::read_to_string(root.artifact_file("chat-custom", &artifact_id, "index.html")).unwrap(),
        "custom"
    );
    assert_eq!(
        fs::read_to_string(root.version_artifact_file(&artifact_id, 1, "index.html")).unwrap(),
        "custom"
    );
    assert!(!custom_root.join("artifacts").exists());
    assert!(!custom_root.join("artifact-snapshots").exists());

    let opened = call!(
        handle_open_artifact,
        args(&[("artifact_id", json!(artifact_id.clone()))])
    );
    assert_eq!(opened["status"], json!(STATUS_RUNNING));
    assert_eq!(
        fs::read_to_string(root.artifact_file("chat-custom", &artifact_id, "index.html")).unwrap(),
        "custom"
    );

    fs::write(custom_root.join("index.html"), "custom-v2").unwrap();
    let versioned = call!(
        handle_create_artifact_version,
        args(&[
            ("artifact_id", json!(artifact_id.clone())),
            ("chat_id", json!("chat-custom")),
            ("source_vm_id", json!("missing-dev-vm"))
        ])
    );
    assert_eq!(versioned["version"], json!(2));
    assert_eq!(
        fs::read_to_string(root.artifact_file("chat-custom", &artifact_id, "index.html")).unwrap(),
        "custom-v2"
    );
    assert_eq!(
        fs::read_to_string(root.version_artifact_file(&artifact_id, 2, "index.html")).unwrap(),
        "custom-v2"
    );

    let downloaded = call!(
        handle_download_artifact,
        args(&[
            ("artifact_id", json!(artifact_id)),
            ("chat_id", json!("chat-custom"))
        ])
    );
    assert_eq!(
        downloaded["file_path"],
        json!("output/Custom_Workspace_v2.tar.gz")
    );
    assert!(custom_root
        .join("output/Custom_Workspace_v2.tar.gz")
        .exists());
}

#[test]
fn helper_branches_cover_defaults_disk_state_and_chat_index_fallbacks() {
    let root = TestRoot::new("helper-branches");

    assert_eq!(
        artifact_key("artifact-1"),
        format!("{ARTIFACT_PREFIX}artifact-1")
    );
    assert_eq!(
        chat_artifacts_key("chat-1"),
        format!("{CHAT_ARTIFACTS_PREFIX}chat-1")
    );
    assert_eq!(
        disk_state_root().unwrap(),
        container_artifact_snapshots_dir()
            .unwrap()
            .join(DISK_STATE_DIR)
    );
    assert_eq!(
        chat_index_path("../chat id").unwrap(),
        disk_state_root()
            .unwrap()
            .join(CHAT_INDEX_DIR)
            .join(format!("{}.json", safe_path_component("../chat id")))
    );

    let parsed = ArtifactInfo::from_json(&json!({
        "artifact_id": "artifact-defaults",
        "chat_id": "chat-defaults",
        "name": "Defaults",
        "created_at": 1.5,
        "start_command": "npm run dev",
    }))
    .unwrap();
    assert_eq!(parsed.description, "");
    assert_eq!(parsed.working_directory, "/work");
    assert_eq!(parsed.container_port, 5173);
    assert_eq!(parsed.current_version, 1);
    assert_eq!(parsed.host_port, None);
    assert_eq!(parsed.running_vm_id, None);
    assert_eq!(parsed.bound_vm_id, None);
    assert_eq!(parsed.status, STATUS_STOPPED);
    assert_eq!(parsed.error_message, None);
    assert!(parsed.versions.is_empty());

    let version_error = ArtifactVersion::from_json(&json!({
        "created_at": 1.0,
        "snapshot_path": "v1.tar.gz",
    }))
    .unwrap_err();
    assert!(version_error.to_string().contains("missing version"));

    let info_error = ArtifactInfo::from_json(&json!({
        "artifact_id": "artifact-defaults",
    }))
    .unwrap_err();
    assert!(info_error.to_string().contains("missing chat_id"));

    let counter_path = port_counter_path().unwrap();
    write_json_atomic(&counter_path, &json!({ "counter": "oops" })).unwrap();
    assert_eq!(next_host_port().unwrap(), ARTIFACT_PORT_START as u16);
    assert!(is_browser_unsafe_port(10080));
    write_json_atomic(&counter_path, &json!({ "counter": 80 })).unwrap();
    assert_eq!(next_host_port().unwrap(), 10081);
    write_json_atomic(&counter_path, &json!({ "counter": ARTIFACT_PORT_RANGE })).unwrap();
    assert_eq!(next_host_port().unwrap(), ARTIFACT_PORT_START as u16);

    assert_eq!(read_chat_index("chat-empty").unwrap(), Vec::<String>::new());
    write_json_atomic(
        &chat_index_path("chat-bad").unwrap(),
        &json!({ "artifact_ids": "not-an-array" }),
    )
    .unwrap();
    assert!(read_chat_index("chat-bad").unwrap().is_empty());

    add_chat_artifact("chat-index", "artifact-b").unwrap();
    add_chat_artifact("chat-index", "artifact-a").unwrap();
    add_chat_artifact("chat-index", "artifact-a").unwrap();
    assert_eq!(
        read_chat_index("chat-index").unwrap(),
        vec!["artifact-a".to_string(), "artifact-b".to_string()]
    );
    remove_chat_artifact("chat-index", "missing").unwrap();
    assert_eq!(
        read_chat_index("chat-index").unwrap(),
        vec!["artifact-a".to_string(), "artifact-b".to_string()]
    );
    remove_chat_artifact("chat-index", "artifact-a").unwrap();
    assert_eq!(
        read_chat_index("chat-index").unwrap(),
        vec!["artifact-b".to_string()]
    );

    let source = root.path.join("source-dir");
    fs::create_dir_all(&source).unwrap();
    fs::write(source.join("fresh.txt"), "fresh").unwrap();
    let archive = root.path.join("helper.tar.gz");
    tar_directory(&source, &archive).unwrap();
    let dest = root.path.join("dest");
    fs::create_dir_all(&dest).unwrap();
    fs::write(dest.join("stale.txt"), "stale").unwrap();
    untar_directory(&archive, &dest).unwrap();
    assert!(!dest.join("stale.txt").exists());
    assert_eq!(fs::read_to_string(dest.join("fresh.txt")).unwrap(), "fresh");

    let info = sample_info();
    save_artifact(&info).unwrap();
    assert_eq!(load_artifact(&info.artifact_id).unwrap(), info);
    delete_artifact_record(&info.artifact_id).unwrap();
    assert!(!artifact_metadata_path(&info.artifact_id).unwrap().exists());
    let missing = load_artifact(&info.artifact_id).unwrap_err();
    assert!(missing.to_string().contains("artifact not found"));
}

#[test]
fn helper_branches_cover_memory_redis_and_notification_flag_parsing() {
    let _root = TestRoot::new("memory-helpers");
    let _redis = EnvVarGuard::set("CORE_MCP_TEST_REDIS", "memory");

    let artifact_id = format!("artifact-{}", Uuid::new_v4().simple());
    let mut info = sample_info();
    info.artifact_id = artifact_id.clone();
    info.chat_id = "chat-memory".to_string();
    let serialized = serde_json::to_string(&info.to_json()).unwrap();
    redis_set_string(&artifact_key(&artifact_id), &serialized).unwrap();
    assert_eq!(load_artifact(&artifact_id).unwrap(), info);

    let broken_artifact_id = format!("artifact-{}", Uuid::new_v4().simple());
    redis_set_string(&artifact_key(&broken_artifact_id), "{").unwrap();
    let broken = load_artifact(&broken_artifact_id).unwrap_err();
    assert!(broken
        .to_string()
        .contains("failed to decode artifact JSON"));

    let chat_id = format!("chat-{}", Uuid::new_v4().simple());
    let disk_ids = vec!["artifact-c".to_string(), "artifact-a".to_string()];
    write_chat_index(&chat_id, &disk_ids).unwrap();
    redis_sadd(&chat_artifacts_key(&chat_id), "artifact-b").unwrap();
    redis_sadd(&chat_artifacts_key(&chat_id), "artifact-a").unwrap();
    assert_eq!(
        list_chat_artifact_ids(&chat_id).unwrap(),
        vec![
            "artifact-a".to_string(),
            "artifact-b".to_string(),
            "artifact-c".to_string()
        ]
    );

    let notifications_disabled = EnvVarGuard::set("DISABLE_ELECTRON_NOTIFICATIONS", "yes");
    assert!(!electron_notifications_enabled());
    drop(notifications_disabled);
    let _notifications_enabled = EnvVarGuard::set("DISABLE_ELECTRON_NOTIFICATIONS", "0");
    assert!(electron_notifications_enabled());
}

#[tokio::test]
async fn handlers_cover_seed_workspace_defaults_and_listing_fallbacks() {
    let root = TestRoot::new("seed-defaults");

    let created = call!(
        handle_create_artifact,
        args(&[
            ("chat_id", json!("chat-seed")),
            ("name", json!("Seed Artifact")),
            ("start_command", json!("npm run dev"))
        ])
    );
    let artifact_id = created["artifact_id"].as_str().unwrap().to_string();
    let info = load_artifact(&artifact_id).unwrap();
    assert_eq!(info.description, "");
    assert_eq!(info.working_directory, "/work");
    assert_eq!(info.container_port, 5173);
    assert_eq!(info.versions[0].version_note, "Initial version");
    assert!(info.running_vm_id.is_some());
    assert!(info.bound_vm_id.is_none());
    assert!(source_workspace("chat-seed", None).unwrap().exists());
    assert_eq!(
        fs::read_dir(current_artifact_workspace("chat-seed", &artifact_id).unwrap())
            .unwrap()
            .count(),
        0
    );

    let mut older = sample_info();
    older.artifact_id = "artifact-older".to_string();
    older.chat_id = "chat-seed".to_string();
    older.created_at = 0.0;
    older.host_port = None;
    older.running_vm_id = None;
    older.bound_vm_id = Some("bound-only".to_string());
    older.status = STATUS_STOPPED.to_string();
    save_artifact(&older).unwrap();
    add_chat_artifact("chat-seed", &older.artifact_id).unwrap();
    add_chat_artifact("chat-seed", "missing-artifact").unwrap();

    let listed = call!(
        handle_list_artifacts,
        args(&[
            ("chat_id", json!("chat-seed")),
            ("include_all_versions", json!(true))
        ])
    );
    assert_eq!(listed["count"], json!(2));
    assert_eq!(listed["artifacts"][0]["artifact_id"], json!(artifact_id));
    assert_eq!(
        listed["artifacts"][1]["artifact_id"],
        json!("artifact-older")
    );
    assert_eq!(
        listed["artifacts"][1]["versions"].as_array().unwrap().len(),
        2
    );
    assert!(listed["artifacts"][1].get("running_vm_id").is_none());
    assert!(listed["artifacts"][1].get("bound_vm_id").is_none());

    let running = call!(
        handle_get_artifact_running_versions,
        args(&[("artifact_id", json!("artifact-older"))])
    );
    assert_eq!(running["running_versions"], json!([]));
    assert_eq!(running["pool_used"], json!(0));

    assert!(root
        .path
        .join("artifact-snapshots")
        .join("_workspaces")
        .join(&artifact_id)
        .exists());
}

#[tokio::test]
async fn handlers_refresh_stale_running_metadata_before_reporting_status() {
    let _root = TestRoot::new("stale-runtime");
    let _docker = EnvVarGuard::set("CORE_MCP_TEST_DOCKER", "real");
    let mut stale = sample_info();
    stale.artifact_id = "artifact-stale".to_string();
    stale.chat_id = "chat-stale".to_string();
    stale.status = STATUS_RUNNING.to_string();
    stale.running_vm_id = None;
    stale.host_port = Some(10123);
    save_artifact(&stale).unwrap();
    add_chat_artifact(&stale.chat_id, &stale.artifact_id).unwrap();

    let status = call!(
        handle_get_artifact_status,
        args(&[("artifact_id", json!("artifact-stale"))])
    );
    assert_eq!(status["status"], json!(STATUS_STOPPED));
    assert_eq!(status["preview_url"], Value::Null);

    let listed = call!(
        handle_list_artifacts,
        args(&[
            ("chat_id", json!("chat-stale")),
            ("include_all_versions", json!(true))
        ])
    );
    assert_eq!(listed["artifacts"][0]["status"], json!(STATUS_STOPPED));

    let running = call!(
        handle_get_artifact_running_versions,
        args(&[("artifact_id", json!("artifact-stale"))])
    );
    assert_eq!(running["running_versions"], json!([]));
    assert_eq!(running["pool_used"], json!(0));

    let saved = load_artifact("artifact-stale").unwrap();
    assert_eq!(saved.status, STATUS_STOPPED);
    assert!(saved.running_vm_id.is_none());
}

#[tokio::test]
async fn handlers_cover_host_port_reallocation_restore_and_default_download() {
    let root = TestRoot::new("host-port-fallbacks");
    root.write_source_file("chat-1", "dev-vm", "index.html", "v1");

    let created = call!(
        handle_create_artifact,
        args(&[
            ("chat_id", json!("chat-1")),
            ("name", json!("Calculator App!")),
            ("start_command", json!("npm run dev")),
            ("vm_id", json!("dev-vm"))
        ])
    );
    let artifact_id = created["artifact_id"].as_str().unwrap().to_string();
    let initial_host_port = created["host_port"].as_u64().unwrap();

    call!(
        handle_close_artifact,
        args(&[("artifact_id", json!(artifact_id.clone()))])
    );
    let closed_info = load_artifact(&artifact_id).unwrap();
    assert_eq!(closed_info.status, STATUS_STOPPED);
    assert!(closed_info.running_vm_id.is_none());
    assert_eq!(closed_info.bound_vm_id.as_deref(), Some("dev-vm"));

    root.write_source_file("chat-1", "dev-vm", "index.html", "v2");
    call!(
        handle_create_artifact_version,
        args(&[
            ("artifact_id", json!(artifact_id.clone())),
            ("chat_id", json!("chat-1")),
            ("source_vm_id", json!("dev-vm")),
            ("version_note", json!("second"))
        ])
    );

    let mut info = load_artifact(&artifact_id).unwrap();
    info.host_port = Some(10080);
    info.status = STATUS_STOPPED.to_string();
    info.error_message = Some("broken".to_string());
    save_artifact(&info).unwrap();

    let opened = call!(
        handle_open_artifact,
        args(&[("artifact_id", json!(artifact_id.clone()))])
    );
    let reopened_port = opened["preview_url"]
        .as_str()
        .and_then(|value| value.rsplit(':').next())
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap();
    assert_eq!(opened["status"], json!(STATUS_RUNNING));
    assert!(reopened_port > initial_host_port);
    assert_ne!(reopened_port, 10080);
    assert_eq!(
        fs::read_to_string(root.artifact_file("chat-1", &artifact_id, "index.html")).unwrap(),
        "v2"
    );
    let reopened = load_artifact(&artifact_id).unwrap();
    assert_eq!(reopened.host_port, Some(reopened_port as u16));
    assert!(reopened.error_message.is_none());

    root.write_source_file("chat-1", "dev-vm", "index.html", "v3");
    let mut reopened = reopened;
    reopened.host_port = None;
    reopened.status = STATUS_STOPPED.to_string();
    reopened.error_message = Some("still broken".to_string());
    save_artifact(&reopened).unwrap();

    let created_version = call!(
        handle_create_artifact_version,
        args(&[
            ("artifact_id", json!(artifact_id.clone())),
            ("chat_id", json!("chat-1")),
            ("source_vm_id", json!("dev-vm"))
        ])
    );
    assert_eq!(created_version["version"], json!(3));
    let created_version_port = created_version["host_port"].as_u64().unwrap();
    assert!(created_version_port > reopened_port);
    assert_eq!(created_version["version_note"], json!(""));
    assert_eq!(
        fs::read_to_string(root.artifact_file("chat-1", &artifact_id, "index.html")).unwrap(),
        "v3"
    );
    let after_version = load_artifact(&artifact_id).unwrap();
    assert_eq!(after_version.host_port, Some(created_version_port as u16));
    assert_eq!(after_version.current_version, 3);
    assert!(after_version.error_message.is_none());

    let mut stopped = after_version;
    stopped.status = STATUS_STOPPED.to_string();
    stopped.error_message = Some("needs restore".to_string());
    save_artifact(&stopped).unwrap();

    let restored = call!(
        handle_restore_artifact_version,
        args(&[
            ("artifact_id", json!(artifact_id.clone())),
            ("version", json!(1)),
            ("chat_id", json!("chat-1"))
        ])
    );
    assert_eq!(restored["message"], json!("Restored to version 1."));
    let after_restore = load_artifact(&artifact_id).unwrap();
    assert_eq!(after_restore.current_version, 1);
    assert_eq!(after_restore.status, STATUS_RUNNING);
    assert!(after_restore.error_message.is_none());
    assert_eq!(
        fs::read_to_string(root.artifact_file("chat-1", &artifact_id, "index.html")).unwrap(),
        "v1"
    );

    let downloaded = call!(
        handle_download_artifact,
        args(&[
            ("artifact_id", json!(artifact_id)),
            ("chat_id", json!("chat-1"))
        ])
    );
    assert_eq!(
        downloaded["file_path"],
        json!("output/Calculator_App_v1.tar.gz")
    );
}

#[tokio::test]
async fn handlers_cover_error_branches_and_delete_without_directories() {
    let root = TestRoot::new("handler-errors");
    root.write_source_file("chat-1", "dev-vm", "index.html", "v1");

    let created = call!(
        handle_create_artifact,
        args(&[
            ("chat_id", json!("chat-1")),
            ("name", json!("Calculator App!")),
            ("start_command", json!("npm run dev")),
            ("vm_id", json!("dev-vm"))
        ])
    );
    let artifact_id = created["artifact_id"].as_str().unwrap().to_string();

    let create_version_error = handle_create_artifact_version(&args(&[
        ("artifact_id", json!(artifact_id.clone())),
        ("chat_id", json!("chat-2")),
        ("source_vm_id", json!("dev-vm")),
    ]))
    .await
    .unwrap_err();
    assert!(create_version_error
        .to_string()
        .contains("artifact does not belong to chat_id"));

    let restore_error = handle_restore_artifact_version(&args(&[
        ("artifact_id", json!(artifact_id.clone())),
        ("version", json!(1)),
        ("chat_id", json!("chat-2")),
    ]))
    .await
    .unwrap_err();
    assert!(restore_error
        .to_string()
        .contains("artifact does not belong to chat_id"));

    let delete_confirm_error = handle_delete_artifact(&args(&[
        ("artifact_id", json!(artifact_id.clone())),
        ("chat_id", json!("chat-1")),
    ]))
    .await
    .unwrap_err();
    assert!(delete_confirm_error
        .to_string()
        .contains("confirm=true is required"));

    let delete_chat_error = handle_delete_artifact(&args(&[
        ("artifact_id", json!(artifact_id.clone())),
        ("chat_id", json!("chat-2")),
        ("confirm", json!(true)),
    ]))
    .await
    .unwrap_err();
    assert!(delete_chat_error
        .to_string()
        .contains("artifact does not belong to chat_id"));

    let open_error = handle_open_artifact(&args(&[
        ("artifact_id", json!(artifact_id.clone())),
        ("version", json!(99)),
    ]))
    .await
    .unwrap_err();
    assert!(open_error
        .to_string()
        .contains("artifact version not found"));

    fs::remove_dir_all(artifact_snapshots_root(&artifact_id).unwrap()).unwrap();
    fs::remove_dir_all(current_artifact_workspace("chat-1", &artifact_id).unwrap()).unwrap();
    let deleted = call!(
        handle_delete_artifact,
        args(&[
            ("artifact_id", json!(artifact_id)),
            ("chat_id", json!("chat-1")),
            ("confirm", json!(true))
        ])
    );
    assert_eq!(deleted["message"], json!("Artifact deleted."));
}

#[tokio::test]
async fn dispatcher_sanitizes_artifact_errors_for_callers() {
    let root = TestRoot::new("dispatcher-sanitized-errors");
    let dispatcher = Dispatcher;

    let chat_id = "chat-corrupt-index";
    let index_path = chat_index_path(chat_id).unwrap();
    fs::create_dir_all(index_path.parent().unwrap()).unwrap();
    fs::write(&index_path, "{not-json").unwrap();
    let list_error = response_payload(
        dispatcher
            .call("list_artifacts", &args(&[("chat_id", json!(chat_id))]))
            .await
            .unwrap()
            .expect("sanitized list_artifacts response"),
    );
    assert_eq!(list_error["success"], json!(false));
    assert_eq!(list_error["code"], json!("artifact_list_failed"));
    let list_text = serde_json::to_string(&list_error).unwrap();
    assert!(!list_text.contains(root.path.to_string_lossy().as_ref()));
    assert!(!list_text.contains("_native_state"));
    assert!(!list_text.contains("chat_index"));
}

#[path = "artifacts_coverage_tests.rs"]
mod coverage_tests;
