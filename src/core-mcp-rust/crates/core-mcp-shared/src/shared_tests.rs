use super::*;
use crate::TEST_ENV_LOCK;
use std::sync::MutexGuard;

fn make_temp_dir(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("core-mcp-rust-{name}-{}", Uuid::new_v4()));
    fs::create_dir_all(&path).expect("create temp dir");
    path
}

struct RootEnv {
    _guard: MutexGuard<'static, ()>,
    previous_container_root: Option<String>,
    previous_host_root: Option<String>,
}

impl RootEnv {
    fn set(container_root: Option<&Path>, host_root: Option<&Path>) -> Self {
        let guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let previous_container_root = env::var("CONTAINER_PROJECT_ROOT").ok();
        let previous_host_root = env::var("HOST_PROJECT_ROOT").ok();
        if let Some(path) = container_root {
            env::set_var("CONTAINER_PROJECT_ROOT", path);
        } else {
            env::remove_var("CONTAINER_PROJECT_ROOT");
        }
        if let Some(path) = host_root {
            env::set_var("HOST_PROJECT_ROOT", path);
        } else {
            env::remove_var("HOST_PROJECT_ROOT");
        }
        Self {
            _guard: guard,
            previous_container_root,
            previous_host_root,
        }
    }

    fn restore_env_vars(&self) {
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
    }
}

struct CurrentDirGuard {
    previous_dir: PathBuf,
}

impl CurrentDirGuard {
    fn set(path: &Path) -> Self {
        let previous_dir = env::current_dir().expect("current dir");
        env::set_current_dir(path).expect("set current dir");
        Self { previous_dir }
    }
}

impl Drop for CurrentDirGuard {
    fn drop(&mut self) {
        let _ = env::set_current_dir(&self.previous_dir);
    }
}

impl Drop for RootEnv {
    fn drop(&mut self) {
        self.restore_env_vars();
    }
}

#[test]
fn finalize_atomic_write_uses_rename_when_available() {
    let temp_dir = make_temp_dir("rename-success");
    let target_path = temp_dir.join("target.json");
    let temp_path = temp_dir.join("target.json.tmp");
    fs::write(&temp_path, "new").expect("write temp");

    finalize_atomic_write(
        &temp_path,
        &target_path,
        "new",
        rename_path,
        write_path_contents,
    )
    .expect("finalize should succeed");

    assert_eq!(
        fs::read_to_string(&target_path).expect("read target"),
        "new"
    );
    assert!(!temp_path.exists(), "rename should consume the temp file");
    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn root_env_drop_restores_previous_root_overrides() {
    let container_root_path = make_temp_dir("restore-container");
    let host_root_path = make_temp_dir("restore-host");
    let replacement_root_path = make_temp_dir("restore-replacement");
    let guard = TEST_ENV_LOCK
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());

    env::set_var("CONTAINER_PROJECT_ROOT", &container_root_path);
    env::set_var("HOST_PROJECT_ROOT", &host_root_path);
    let previous_container_root = env::var("CONTAINER_PROJECT_ROOT").ok();
    let previous_host_root = env::var("HOST_PROJECT_ROOT").ok();
    env::set_var("CONTAINER_PROJECT_ROOT", &replacement_root_path);
    env::set_var("HOST_PROJECT_ROOT", &replacement_root_path);
    let env_guard = RootEnv {
        _guard: guard,
        previous_container_root,
        previous_host_root,
    };
    assert_eq!(
        env::var("CONTAINER_PROJECT_ROOT").ok().as_deref(),
        replacement_root_path.to_str()
    );
    assert_eq!(
        env::var("HOST_PROJECT_ROOT").ok().as_deref(),
        replacement_root_path.to_str()
    );

    env_guard.restore_env_vars();

    assert_eq!(
        env::var("CONTAINER_PROJECT_ROOT").ok().as_deref(),
        container_root_path.to_str()
    );
    assert_eq!(
        env::var("HOST_PROJECT_ROOT").ok().as_deref(),
        host_root_path.to_str()
    );

    env::remove_var("CONTAINER_PROJECT_ROOT");
    env::remove_var("HOST_PROJECT_ROOT");
    let _ = fs::remove_dir_all(&container_root_path);
    let _ = fs::remove_dir_all(&host_root_path);
    let _ = fs::remove_dir_all(&replacement_root_path);
}

#[test]
fn finalize_atomic_write_falls_back_to_direct_write() {
    let temp_dir = make_temp_dir("rename-fallback");
    let target_path = temp_dir.join("target.json");
    let temp_path = temp_dir.join("target.json.tmp");
    fs::write(&target_path, "old").expect("write target");
    fs::write(&temp_path, "new").expect("write temp");

    finalize_atomic_write(
        &temp_path,
        &target_path,
        "new",
        |_, _| Err(std::io::Error::other("rename blocked")),
        write_path_contents,
    )
    .expect("fallback write should succeed");

    assert_eq!(
        fs::read_to_string(&target_path).expect("read target"),
        "new"
    );
    assert!(!temp_path.exists());
    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn finalize_atomic_write_surfaces_fallback_write_failure() {
    let temp_dir = make_temp_dir("rename-failure");
    let target_path = temp_dir.join("target.json");
    let temp_path = temp_dir.join("target.json.tmp");
    fs::write(&temp_path, "new").expect("write temp");

    let error = finalize_atomic_write(
        &temp_path,
        &target_path,
        "new",
        |_, _| Err(std::io::Error::other("rename blocked")),
        |_, _| Err(std::io::Error::other("write blocked")),
    )
    .expect_err("fallback write should fail");

    let rendered = format!("{error:#}");
    assert!(rendered.contains("failed to move"));
    assert!(rendered.contains("write blocked"));
    assert!(temp_path.exists());
    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn root_helpers_prefer_explicit_overrides() {
    let container_root_path = make_temp_dir("container-root");
    let host_root_path = make_temp_dir("host-root");
    env::set_var("CONTAINER_PROJECT_ROOT", "/tmp/previous-container-root");
    env::set_var("HOST_PROJECT_ROOT", "/tmp/previous-host-root");
    let _env = RootEnv::set(Some(&container_root_path), Some(&host_root_path));

    assert_eq!(container_root().unwrap(), container_root_path);
    assert_eq!(host_root().unwrap(), host_root_path);
    assert_eq!(
        container_workspaces_dir().unwrap(),
        container_root_path.join("workspaces")
    );
    assert_eq!(
        host_workspaces_dir().unwrap(),
        host_root_path.join("workspaces")
    );
    assert_eq!(
        container_artifact_snapshots_dir().unwrap(),
        container_root_path.join(ARTIFACT_SNAPSHOTS_DIR)
    );
    assert_eq!(
        host_artifact_snapshots_dir().unwrap(),
        host_root_path.join(ARTIFACT_SNAPSHOTS_DIR)
    );

    let _ = fs::remove_dir_all(&container_root_path);
    let _ = fs::remove_dir_all(&host_root_path);
}

#[test]
fn host_root_falls_back_to_container_override() {
    let container_root_path = make_temp_dir("container-fallback");
    let _env = RootEnv::set(Some(&container_root_path), None);

    assert_eq!(host_root().unwrap(), container_root_path);
    assert_eq!(
        host_workspaces_dir().unwrap(),
        container_root_path.join("workspaces")
    );
    assert_eq!(
        host_artifact_snapshots_dir().unwrap(),
        container_root_path.join(ARTIFACT_SNAPSHOTS_DIR)
    );

    let _ = fs::remove_dir_all(&container_root_path);
}

#[test]
fn container_root_falls_back_to_app_root_when_override_missing() {
    let _env = RootEnv::set(None, None);
    let fallback_root = make_temp_dir("app-root-fallback");
    fs::create_dir_all(fallback_root.join("mcp-configs")).expect("create mcp-configs");
    let _cwd = CurrentDirGuard::set(&fallback_root);

    assert_eq!(
        fs::canonicalize(container_root().unwrap()).unwrap(),
        fs::canonicalize(&fallback_root).unwrap()
    );

    let _ = fs::remove_dir_all(&fallback_root);
}

#[test]
fn empty_host_override_falls_back_to_container_root() {
    let container_root_path = make_temp_dir("container-empty-host");
    let _env = RootEnv::set(Some(&container_root_path), None);
    env::set_var("HOST_PROJECT_ROOT", "");

    assert_eq!(host_root().unwrap(), container_root_path);

    let _ = fs::remove_dir_all(&container_root_path);
}

#[test]
fn empty_container_override_falls_back_to_app_root_search() {
    let _env = RootEnv::set(None, None);
    let fallback_root = make_temp_dir("empty-container-fallback");
    fs::create_dir_all(fallback_root.join("mcp-configs")).expect("create mcp-configs");
    let _cwd = CurrentDirGuard::set(&fallback_root);
    env::set_var("CONTAINER_PROJECT_ROOT", "");

    assert_eq!(
        fs::canonicalize(container_root().unwrap()).unwrap(),
        fs::canonicalize(&fallback_root).unwrap()
    );

    let _ = fs::remove_dir_all(&fallback_root);
}

#[test]
fn resolve_chat_workspace_binding_follows_linked_root_current_binding() {
    let container_root = make_temp_dir("linked-binding-container");
    let host_root = make_temp_dir("linked-binding-host");
    let env_guard = RootEnv::set(Some(&container_root), Some(&host_root));
    let previous_cfg = env::var("PORTICO_WORKSPACE_CFG_DIR").ok();
    let cfg_dir = make_temp_dir("linked-binding-cfg");
    env::set_var("PORTICO_WORKSPACE_CFG_DIR", &cfg_dir);

    let write_settings = |settings: Value| {
        fs::write(
            cfg_dir.join(CHAT_WORKSPACES_SETTINGS_FILE_NAME),
            serde_json::to_string_pretty(&settings).unwrap(),
        )
        .unwrap();
    };

    // Linked entry follows the root's CURRENT custom binding.
    write_settings(json!({"chats": {
        "root-chat": {"source": "custom", "host_path": "/tmp/custom-root-dir"},
        "child-chat": {"source": "custom", "host_path": "/tmp/stale-snapshot",
                       "linked_workspace": true, "root_parent_chat_id": "root-chat"},
    }}));
    let binding = resolve_chat_workspace_binding("child-chat").unwrap();
    assert_eq!(binding.host_path, PathBuf::from("/tmp/custom-root-dir"));
    assert!(!binding.canonical);

    // Root entry absent: the shared generated dir under workspaces/<root>,
    // flagged canonical so consumers may create it on demand.
    write_settings(json!({"chats": {
        "child-chat": {"source": "custom", "host_path": "/tmp/stale-snapshot",
                       "linked_workspace": true, "root_parent_chat_id": "root-chat"},
    }}));
    let binding = resolve_chat_workspace_binding("child-chat").unwrap();
    assert_eq!(
        binding.host_path,
        host_root.join("workspaces").join("root-chat")
    );
    assert!(binding.canonical);

    // Anomalies fall back to the snapshot: a root that is itself linked...
    write_settings(json!({"chats": {
        "root-chat": {"source": "custom", "host_path": "/tmp/other",
                      "linked_workspace": true, "root_parent_chat_id": "elsewhere"},
        "child-chat": {"source": "custom", "host_path": "/tmp/stale-snapshot",
                       "linked_workspace": true, "root_parent_chat_id": "root-chat"},
    }}));
    let binding = resolve_chat_workspace_binding("child-chat").unwrap();
    assert_eq!(binding.host_path, PathBuf::from("/tmp/stale-snapshot"));
    assert!(!binding.canonical);

    // ...a self-link...
    write_settings(json!({"chats": {
        "child-chat": {"source": "custom", "host_path": "/tmp/stale-snapshot",
                       "linked_workspace": true, "root_parent_chat_id": "child-chat"},
    }}));
    let binding = resolve_chat_workspace_binding("child-chat").unwrap();
    assert_eq!(binding.host_path, PathBuf::from("/tmp/stale-snapshot"));

    // ...and a malformed root id.
    write_settings(json!({"chats": {
        "child-chat": {"source": "custom", "host_path": "/tmp/stale-snapshot",
                       "linked_workspace": true, "root_parent_chat_id": "../evil"},
    }}));
    let binding = resolve_chat_workspace_binding("child-chat").unwrap();
    assert_eq!(binding.host_path, PathBuf::from("/tmp/stale-snapshot"));

    if let Some(value) = previous_cfg {
        env::set_var("PORTICO_WORKSPACE_CFG_DIR", value);
    } else {
        env::remove_var("PORTICO_WORKSPACE_CFG_DIR");
    }
    env_guard.restore_env_vars();
    let _ = fs::remove_dir_all(&container_root);
    let _ = fs::remove_dir_all(&host_root);
    let _ = fs::remove_dir_all(&cfg_dir);
}
