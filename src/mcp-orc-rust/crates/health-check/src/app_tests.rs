use crate::app::*;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::header::CONTENT_TYPE;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::response::Response;
use axum::routing::any;
use axum::Router;
use percent_encoding::percent_decode_str;
use reqwest::Client;
use serde_json::{json, Value};
use serial_test::serial;
use sha2::Digest as _;
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener as StdTcpListener;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tempfile::TempDir;
use tokio::net::TcpListener as TokioTcpListener;
use tokio::sync::oneshot;

#[test]
fn operation_publication_marker_blocks_stale_periodic_health_writes() {
    let temp = TempDir::new().unwrap();
    let health_dir = temp.path();
    let marker_path = health_dir.join(MCP_OPERATION_PUBLICATION_MARKER_FILE);
    let baseline = read_operation_publication_marker(health_dir);
    assert!(!operation_publication_blocks_periodic_write(
        health_dir, &baseline,
    ));

    fs::write(
        &marker_path,
        r#"{"revision":"one","status":"active","operationId":"op-1"}"#,
    )
    .unwrap();
    assert!(operation_publication_blocks_periodic_write(
        health_dir, &baseline,
    ));

    let active_baseline = read_operation_publication_marker(health_dir);
    assert!(operation_publication_blocks_periodic_write(
        health_dir,
        &active_baseline,
    ));
    fs::write(
        &marker_path,
        r#"{"revision":"two","status":"completed","operationId":"op-1"}"#,
    )
    .unwrap();
    assert!(operation_publication_blocks_periodic_write(
        health_dir,
        &active_baseline,
    ));
    let completed_baseline = read_operation_publication_marker(health_dir);
    assert!(!operation_publication_blocks_periodic_write(
        health_dir,
        &completed_baseline,
    ));
}

#[test]
fn health_status_write_lock_drop_removes_empty_lock_file() {
    let temp = TempDir::new().unwrap();
    let health_path = temp.path().join("health_status.json");
    let lock_path = temp.path().join("health_status.json.lock");

    let lock = acquire_health_status_write_lock(&health_path).unwrap();
    assert!(lock_path.exists());
    drop(lock);
    // Electron main treats the mere existence of this path as "lock held";
    // the empty flock-style file must not be left behind.
    assert!(!lock_path.exists());
}

#[test]
fn health_status_write_lock_drop_preserves_nonempty_node_lock_file() {
    let temp = TempDir::new().unwrap();
    let health_path = temp.path().join("health_status.json");
    let lock_path = temp.path().join("health_status.json.lock");

    // Simulate an Electron-main lockfile ("<pid> <ts>\n"): flock still
    // succeeds on it, but drop must never unlink Node's non-empty lock.
    fs::write(&lock_path, "1234 0\n").unwrap();
    let lock = acquire_health_status_write_lock(&health_path).unwrap();
    drop(lock);
    assert!(lock_path.exists());
    assert_eq!(fs::read_to_string(&lock_path).unwrap(), "1234 0\n");
}

#[test]
fn write_health_status_atomically_leaves_no_lock_residue() {
    let temp = TempDir::new().unwrap();
    let health_path = temp.path().join("health_status.json");

    let wrote = write_health_status_atomically(&health_path, b"{\"servers\":{}}\n", &None).unwrap();
    assert!(wrote);
    assert_eq!(fs::read(&health_path).unwrap(), b"{\"servers\":{}}\n");

    let entries: Vec<_> = fs::read_dir(temp.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(
        entries,
        vec![std::ffi::OsString::from("health_status.json")],
        "no .lock or .tmp residue should remain after an atomic health write",
    );
}

#[test]
#[serial]
fn revisioned_toggle_snapshot_overrides_legacy_file_and_fails_closed_on_mismatch() {
    let env = TestEnv::new("revisioned-toggle-snapshot");
    fs::write(&env.paths.mcp_toggles_file, r#"{"slack":false}"#).unwrap();
    let snapshot_path = env
        .paths
        .health_status_dir
        .join("mcp_toggles_snapshot.json");
    let expected = HashMap::from([
        ("slack".to_string(), true),
        ("snowflake".to_string(), false),
    ]);
    let revision = compute_mcp_toggle_revision(&expected).unwrap();
    fs::write(
        &snapshot_path,
        serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "revision": revision,
            "toggles": {
                "snowflake": false,
                "slack": true
            }
        }))
        .unwrap(),
    )
    .unwrap();

    let loaded = load_mcp_toggle_snapshot(&env.paths).unwrap();
    assert_eq!(loaded.toggles, expected);
    assert_eq!(loaded.revision, revision);
    assert_eq!(loaded.source, snapshot_path);

    fs::write(
        &loaded.source,
        r#"{"revision":"sha256:wrong","toggles":{"slack":true}}"#,
    )
    .unwrap();
    assert!(load_mcp_toggle_snapshot(&env.paths)
        .unwrap_err()
        .to_string()
        .contains("revision mismatch"));
}

#[test]
#[serial]
fn configured_toggle_snapshot_path_is_required() {
    let env = TestEnv::new("required-toggle-snapshot");
    let missing = env.paths.app_root.join("missing-toggle-snapshot.json");
    std::env::set_var("MCP_TOGGLE_SNAPSHOT_FILE", &missing);
    let result = load_mcp_toggle_snapshot(&env.paths);
    std::env::remove_var("MCP_TOGGLE_SNAPSHOT_FILE");

    assert!(result
        .unwrap_err()
        .to_string()
        .contains("configured MCP toggle snapshot is missing"));
}

#[test]
fn toggle_snapshots_reject_wrong_shapes_and_non_boolean_values() {
    let env = TestEnv::new("invalid-toggle-shapes");
    for payload in [
        r#"[]"#,
        r#"{"slack":"true"}"#,
        r#"{"slack":true,"snowflake":1}"#,
        r#"{"revision":"sha256:any","toggles":[]}"#,
    ] {
        fs::write(&env.paths.mcp_toggles_file, payload).unwrap();
        assert!(
            load_mcp_toggle_snapshot(&env.paths).is_err(),
            "payload should fail closed: {payload}"
        );
    }
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
struct RecordedRequest {
    method: String,
    path: String,
    authorization: Option<String>,
    body: String,
}

#[derive(Clone, Debug)]
struct ResponseSpec {
    status: u16,
    content_type: String,
    body: String,
}

impl ResponseSpec {
    fn json(status: u16, body: serde_json::Value) -> Self {
        Self {
            status,
            content_type: "application/json".to_string(),
            body: serde_json::to_string(&body).unwrap(),
        }
    }

    fn text(status: u16, body: &str, content_type: &str) -> Self {
        Self {
            status,
            content_type: content_type.to_string(),
            body: body.to_string(),
        }
    }
}

#[derive(Default)]
struct MockServerState {
    responses: Mutex<HashMap<(String, String), VecDeque<ResponseSpec>>>,
    requests: Mutex<Vec<RecordedRequest>>,
}

struct MockServer {
    base_url: String,
    state: Arc<MockServerState>,
    shutdown: Option<oneshot::Sender<()>>,
}

impl MockServer {
    async fn start() -> Self {
        let state = Arc::new(MockServerState::default());
        let listener = TokioTcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = Router::new()
            .fallback(any(handle_mock_request))
            .with_state(state.clone());
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        tokio::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await;
        });
        Self {
            base_url: format!("http://{address}"),
            state,
            shutdown: Some(shutdown_tx),
        }
    }

    fn queue_json(&self, method: &str, path: &str, status: u16, body: serde_json::Value) {
        self.queue(method, path, ResponseSpec::json(status, body));
    }

    fn queue_text(&self, method: &str, path: &str, status: u16, body: &str, content_type: &str) {
        self.queue(method, path, ResponseSpec::text(status, body, content_type));
    }

    fn queue(&self, method: &str, path: &str, response: ResponseSpec) {
        let key = (method.to_string(), path.to_string());
        self.state
            .responses
            .lock()
            .unwrap()
            .entry(key)
            .or_default()
            .push_back(response);
    }

    fn requests(&self) -> Vec<RecordedRequest> {
        self.state.requests.lock().unwrap().clone()
    }
}

impl Drop for MockServer {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReconcileFailurePoint {
    TargetCreate,
    TargetReadback,
    DerivedMigration,
    SettingsUpdate,
    Retirement,
    InvalidScheduledTask,
}

struct ReconcileServerState {
    models: BTreeMap<String, Value>,
    settings: Value,
    failure: ReconcileFailurePoint,
    failure_consumed: bool,
    target_readback_failures_remaining: usize,
    requests: Vec<RecordedRequest>,
}

impl ReconcileServerState {
    fn new(failure: ReconcileFailurePoint) -> Self {
        Self {
            models: BTreeMap::from([
                (
                    "GPT-5.4".to_string(),
                    json!({
                        "id": "GPT-5.4",
                        "name": "GPT-5.4",
                        "base_model_id": null,
                        "info": { "base_model_id": null },
                        "meta": {},
                        "params": { "system": "" },
                        "is_active": true,
                        "is_default": true
                    }),
                ),
                (
                    "agent-old".to_string(),
                    json!({
                        "id": "agent-old",
                        "name": "Legacy Agent",
                        "base_model_id": "GPT-5.4",
                        "info": { "base_model_id": "GPT-5.4" },
                        "meta": {},
                        "user": {}
                    }),
                ),
            ]),
            settings: json!({ "ui": { "models": ["GPT-5.4"] } }),
            failure,
            failure_consumed: false,
            target_readback_failures_remaining: 0,
            requests: Vec::new(),
        }
    }

    fn should_fail_once(&mut self, point: ReconcileFailurePoint) -> bool {
        if self.failure == point && !self.failure_consumed {
            self.failure_consumed = true;
            true
        } else {
            false
        }
    }
}

struct ReconcileServer {
    base_url: String,
    state: Arc<Mutex<ReconcileServerState>>,
    shutdown: Option<oneshot::Sender<()>>,
}

impl ReconcileServer {
    async fn start(failure: ReconcileFailurePoint) -> Self {
        let state = Arc::new(Mutex::new(ReconcileServerState::new(failure)));
        let listener = TokioTcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = Router::new()
            .fallback(any(handle_reconcile_request))
            .with_state(state.clone());
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        tokio::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await;
        });
        Self {
            base_url: format!("http://{address}"),
            state,
            shutdown: Some(shutdown_tx),
        }
    }

    fn snapshot(&self) -> (BTreeMap<String, Value>, Value, bool) {
        let state = self.state.lock().unwrap();
        (
            state.models.clone(),
            state.settings.clone(),
            state.failure_consumed,
        )
    }
}

impl Drop for ReconcileServer {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

fn reconcile_response(status: StatusCode, body: Value) -> Response {
    let mut response = Response::new(Body::from(serde_json::to_vec(&body).unwrap()));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    response
}

fn reconcile_model_id(uri: &Uri) -> Option<String> {
    if matches!(
        uri.path(),
        "/api/v1/models/model" | "/api/v1/models/model/update"
    ) {
        let encoded = uri.query()?.strip_prefix("id=")?.replace('+', " ");
        return percent_decode_str(&encoded)
            .decode_utf8()
            .ok()
            .map(|value| value.into_owned());
    }
    for prefix in ["/api/models/", "/api/v1/models/"] {
        if let Some(encoded) = uri.path().strip_prefix(prefix) {
            return percent_decode_str(encoded)
                .decode_utf8()
                .ok()
                .map(|value| value.into_owned());
        }
    }
    None
}

async fn handle_reconcile_request(
    State(state): State<Arc<Mutex<ReconcileServerState>>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let path = uri
        .path_and_query()
        .map(|value| value.as_str().to_string())
        .unwrap_or_else(|| uri.path().to_string());
    let body_text = String::from_utf8(body.to_vec()).unwrap_or_default();
    let mut state = state.lock().unwrap();
    state.requests.push(RecordedRequest {
        method: method.to_string(),
        path,
        authorization: headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .map(ToOwned::to_owned),
        body: body_text.clone(),
    });

    match (method.as_str(), uri.path()) {
        ("GET", "/api/v1/tools/") => reconcile_response(
            StatusCode::OK,
            json!([
                { "id": "server:mcp-assistant" },
                { "id": "server:subagents" },
                { "id": "server:skills" },
                { "id": "server:agent-vm" }
            ]),
        ),
        ("POST", "/api/v1/configs/tool_servers") => {
            reconcile_response(StatusCode::OK, json!({ "ok": true }))
        }
        ("GET", "/api/v1/auths/") => {
            reconcile_response(StatusCode::OK, json!({ "id": "reconcile-user" }))
        }
        ("GET", "/api/models") | ("GET", "/api/models/") | ("GET", "/api/models?") => {
            reconcile_response(
                StatusCode::OK,
                json!({ "data": state.models.values().cloned().collect::<Vec<_>>() }),
            )
        }
        ("GET", "/api/v1/models") => reconcile_response(
            StatusCode::OK,
            Value::Array(state.models.values().cloned().collect()),
        ),
        ("GET", "/api/v1/users/user/settings") => {
            reconcile_response(StatusCode::OK, state.settings.clone())
        }
        ("POST", "/api/v1/users/user/settings/update") => {
            if state.should_fail_once(ReconcileFailurePoint::SettingsUpdate) {
                return reconcile_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    json!({ "error": "injected settings failure" }),
                );
            }
            match serde_json::from_str::<Value>(&body_text) {
                Ok(settings) => {
                    state.settings = settings;
                    reconcile_response(StatusCode::OK, json!({ "ok": true }))
                }
                Err(error) => reconcile_response(
                    StatusCode::BAD_REQUEST,
                    json!({ "error": error.to_string() }),
                ),
            }
        }
        ("POST", "/api/v1/models/create") => {
            if state.should_fail_once(ReconcileFailurePoint::TargetCreate) {
                return reconcile_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    json!({ "error": "injected create failure" }),
                );
            }
            match serde_json::from_str::<Value>(&body_text) {
                Ok(model) => {
                    let Some(model_id) = model.get("id").and_then(Value::as_str) else {
                        return reconcile_response(
                            StatusCode::BAD_REQUEST,
                            json!({ "error": "missing model id" }),
                        );
                    };
                    let model_id = model_id.to_string();
                    state.models.insert(model_id.clone(), model);
                    if state.failure == ReconcileFailurePoint::TargetReadback
                        && !state.failure_consumed
                        && model_id == "GPT-5.6 Sol"
                    {
                        state.target_readback_failures_remaining = 1;
                    }
                    reconcile_response(StatusCode::OK, json!({ "ok": true }))
                }
                Err(error) => reconcile_response(
                    StatusCode::BAD_REQUEST,
                    json!({ "error": error.to_string() }),
                ),
            }
        }
        ("POST", "/api/v1/models/model/update") => {
            let Some(model_id) = reconcile_model_id(&uri) else {
                return reconcile_response(
                    StatusCode::BAD_REQUEST,
                    json!({ "error": "missing model id" }),
                );
            };
            let mut model = match serde_json::from_str::<Value>(&body_text) {
                Ok(model) => model,
                Err(error) => {
                    return reconcile_response(
                        StatusCode::BAD_REQUEST,
                        json!({ "error": error.to_string() }),
                    );
                }
            };
            let is_derived_migration = model_id == "agent-old"
                && model.get("base_model_id").and_then(Value::as_str) == Some("GPT-5.6 Sol");
            let is_retirement = model_id == "GPT-5.4"
                && model
                    .get("meta")
                    .and_then(Value::as_object)
                    .and_then(|meta| meta.get("disabled"))
                    .and_then(Value::as_bool)
                    == Some(true);
            if (is_derived_migration
                && state.should_fail_once(ReconcileFailurePoint::DerivedMigration))
                || (is_retirement && state.should_fail_once(ReconcileFailurePoint::Retirement))
            {
                return reconcile_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    json!({ "error": "injected model update failure" }),
                );
            }
            if let Some(object) = model.as_object_mut() {
                object.insert("id".to_string(), json!(model_id.clone()));
                if is_derived_migration {
                    object.insert("base_model_id".to_string(), json!("GPT-5.6 Sol"));
                    ensure_object_field(&mut model, "info")
                        .insert("base_model_id".to_string(), json!("GPT-5.6 Sol"));
                }
            }
            state.models.insert(model_id, model);
            reconcile_response(StatusCode::OK, json!({ "ok": true }))
        }
        ("GET", _) if reconcile_model_id(&uri).is_some() => {
            let model_id = reconcile_model_id(&uri).unwrap();
            if model_id == "GPT-5.6 Sol" && state.target_readback_failures_remaining > 0 {
                state.target_readback_failures_remaining -= 1;
                if state.target_readback_failures_remaining == 0 {
                    state.failure_consumed = true;
                }
                return reconcile_response(
                    StatusCode::NOT_FOUND,
                    json!({ "error": "injected readback miss" }),
                );
            }
            match state.models.get(&model_id) {
                Some(model) => reconcile_response(StatusCode::OK, model.clone()),
                None => {
                    reconcile_response(StatusCode::NOT_FOUND, json!({ "error": "model not found" }))
                }
            }
        }
        _ => reconcile_response(
            StatusCode::NOT_FOUND,
            json!({ "error": format!("unexpected {} {}", method, uri) }),
        ),
    }
}
fn summary_entry(
    id: &str,
    host_group: &str,
    reachable: bool,
    has_tools: bool,
    tools_count: usize,
) -> serde_json::Value {
    json!({
        "id": id,
        "host_group": host_group,
        "reachable": reachable,
        "has_tools": has_tools,
        "tools_count": tools_count,
    })
}

fn queue_summary(server: &MockServer, entries: Vec<serde_json::Value>) {
    server.queue_json(
        "GET",
        "/servers/summary",
        200,
        json!({
            "servers": entries,
            "oauth_status": {
                "current": null,
                "active": [],
                "pending": [],
                "checking": [],
                "waiting_callback": [],
                "completed": [],
                "failed": [],
                "timeout": [],
            }
        }),
    );
}

fn queue_empty_oauth_status(server: &MockServer) {
    server.queue_json(
        "GET",
        "/oauth/status",
        200,
        json!({
            "current": null,
            "active": [],
            "pending": [],
            "checking": [],
            "waiting_callback": [],
            "completed": [],
            "failed": [],
            "timeout": []
        }),
    );
}

fn write_core_server_configs(env: &TestEnv) {
    for server in ["mcp-assistant", "subagents", "skills"] {
        env.write_server_yaml(
            false,
            server,
            "display_name: Core\ndeployment_type: docker\nis_core: true\n",
        );
    }
}

async fn handle_mock_request(
    State(state): State<Arc<MockServerState>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let path = uri
        .path_and_query()
        .map(|value| value.as_str().to_string())
        .unwrap_or_else(|| uri.path().to_string());
    state.requests.lock().unwrap().push(RecordedRequest {
        method: method.to_string(),
        path: path.clone(),
        authorization: headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .map(ToOwned::to_owned),
        body: String::from_utf8(body.to_vec()).unwrap_or_default(),
    });

    let response = state
        .responses
        .lock()
        .unwrap()
        .get_mut(&(method.to_string(), path.clone()))
        .and_then(VecDeque::pop_front)
        .unwrap_or_else(|| {
            ResponseSpec::json(
                404,
                json!({ "error": format!("unexpected {method} {path}") }),
            )
        });

    let mut axum_response = Response::new(Body::from(response.body));
    *axum_response.status_mut() = StatusCode::from_u16(response.status).unwrap();
    axum_response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_str(&response.content_type).unwrap(),
    );
    axum_response
}

#[derive(Default)]
struct MockTokenStore {
    writes: Mutex<Vec<(String, String)>>,
    releases: Mutex<Vec<(String, u64)>>,
}

impl TokenStore for MockTokenStore {
    fn set(&self, key: &str, value: &str) -> anyhow::Result<()> {
        self.writes
            .lock()
            .unwrap()
            .push((key.to_string(), value.to_string()));
        Ok(())
    }

    fn release_model_sync_epoch(&self, owner: &str, epoch: u64) -> anyhow::Result<bool> {
        self.releases
            .lock()
            .unwrap()
            .push((owner.to_string(), epoch));
        Ok(true)
    }
}

#[derive(Default)]
struct LeaseTestStore {
    state: Mutex<LeaseTestState>,
}

#[derive(Default)]
struct LeaseTestState {
    epoch: u64,
    active: Option<(String, u64)>,
    release_error: bool,
}

impl LeaseTestStore {
    fn expire(&self) {
        self.state.lock().unwrap().active = None;
    }

    fn fail_release(&self) {
        self.state.lock().unwrap().release_error = true;
    }
}

impl TokenStore for LeaseTestStore {
    fn set(&self, _key: &str, _value: &str) -> anyhow::Result<()> {
        Ok(())
    }

    fn begin_model_sync_epoch(
        &self,
        owner: &str,
        _ttl_ms: u64,
        minimum_epoch: u64,
    ) -> anyhow::Result<u64> {
        let mut state = self.state.lock().unwrap();
        if state.active.is_some() {
            anyhow::bail!("another model sync lease is still active");
        }
        state.epoch = state.epoch.max(minimum_epoch).saturating_add(1);
        let epoch = state.epoch;
        state.active = Some((owner.to_string(), epoch));
        Ok(epoch)
    }

    fn verify_model_sync_epoch(&self, owner: &str, epoch: u64) -> anyhow::Result<()> {
        let state = self.state.lock().unwrap();
        if state.active.as_ref() != Some(&(owner.to_string(), epoch)) {
            anyhow::bail!("model sync epoch lease expired or was superseded");
        }
        Ok(())
    }

    fn release_model_sync_epoch(&self, owner: &str, epoch: u64) -> anyhow::Result<bool> {
        let mut state = self.state.lock().unwrap();
        if state.release_error {
            anyhow::bail!("model sync lease release failed");
        }
        if state.active.as_ref() != Some(&(owner.to_string(), epoch)) {
            return Ok(false);
        }
        state.active = None;
        Ok(true)
    }
}

#[test]
fn model_sync_lease_rejects_contention_and_allows_reacquire_after_expiry() {
    let store = LeaseTestStore::default();
    let first = store.begin_model_sync_epoch("owner-a", 1_000, 0).unwrap();
    assert!(store.begin_model_sync_epoch("owner-b", 1_000, 0).is_err());
    store.expire();
    let second = store.begin_model_sync_epoch("owner-b", 1_000, 0).unwrap();
    assert!(second > first);
}

#[test]
fn model_sync_lease_release_allows_immediate_reacquire() {
    let store = LeaseTestStore::default();
    let first = store.begin_model_sync_epoch("owner-a", 1_000, 0).unwrap();
    assert!(store.release_model_sync_epoch("owner-a", first).unwrap());
    let second = store.begin_model_sync_epoch("owner-b", 1_000, 0).unwrap();
    assert!(second > first);
}
#[test]
fn model_sync_epoch_seeds_above_persisted_marker_after_store_reset() {
    let store = LeaseTestStore::default();
    let epoch = store.begin_model_sync_epoch("owner-a", 1_000, 742).unwrap();
    assert_eq!(epoch, 743);
    assert!(store.release_model_sync_epoch("owner-a", epoch).unwrap());

    let successor = store.begin_model_sync_epoch("owner-b", 1_000, 1).unwrap();
    assert_eq!(successor, 744);
}

#[test]
fn obsolete_model_ids_normalize_case_and_latest_suffix_for_retirement() {
    for model_id in [
        "gpt-5.4:latest",
        "GPT-5.4 PRO:LATEST",
        " gPt-4.1 ",
        "GPT-4.1 Mini:Latest",
        "gpt-4.1 NANO:latest ",
        "OpenAI/Responses/GPT-5.4-PRO:Latest",
        "portico-openai/GPT-4.1-MINI:LATEST",
        "Claude OPUS 4.6:latest",
        " claude opus 4.7 ",
        "Claude_Opus_4.6",
    ] {
        assert!(
            is_obsolete_managed_model_id(model_id),
            "expected obsolete model variant: {model_id}"
        );
    }
    for (model_id, expected) in [
        (" OpenAI/Responses/GPT-5.4-PRO:LaTeSt ", "GPT-5.6 Sol Pro"),
        ("portico-openai/GPT-4.1-MINI:LATEST", "GPT-5.6 Terra"),
        ("OPENAI/gpt-4.1_nano:Latest", "GPT-5.6 Luna"),
        ("responses/GPT-5.4:latest", "GPT-5.6 Sol"),
        ("Claude OPUS 4.6:LaTeSt", "Claude Opus 5"),
        (" claude opus 4.7 ", "Claude Opus 5"),
        ("claude-opus-4-6", "Claude Opus 5"),
        ("claude-opus-4-7:latest", "Claude Opus 5"),
        // Gemini upgrades are migrate-without-retire: display-name, slug,
        // case/`:latest`/underscore variants all map, but stay non-obsolete.
        ("Gemini 3.5 Flash", "Gemini 3.6 Flash"),
        ("gemini-3.5-flash", "Gemini 3.6 Flash"),
        (" GEMINI 3.5 FLASH:LaTeSt ", "Gemini 3.6 Flash"),
        ("Gemini_3.5_Flash", "Gemini 3.6 Flash"),
        ("Gemini 3.1 Flash-Lite", "Gemini 3.5 Flash-Lite"),
        ("gemini-3.1-flash-lite:latest", "Gemini 3.5 Flash-Lite"),
    ] {
        assert_eq!(
            deprecated_base_model_migration_target(model_id),
            Some(expected),
            "expected migration target for {model_id}"
        );
    }
    assert!(!is_obsolete_managed_model_id("GPT-5.6 Sol:latest"));
    assert!(!is_obsolete_managed_model_id("Claude Opus 4.8:latest"));
    assert!(!is_obsolete_managed_model_id("Claude Opus 5"));
    assert!(!is_obsolete_managed_model_id("Gemini 3.5 Flash"));
    assert!(!is_obsolete_managed_model_id("gemini-3.5-flash:latest"));
    assert!(!is_obsolete_managed_model_id("Gemini 3.1 Flash-Lite"));
    assert_eq!(
        deprecated_base_model_migration_target("Gemini 3.6 Flash"),
        None
    );
    assert_eq!(
        deprecated_base_model_migration_target("Gemini 3.5 Flash-Lite"),
        None
    );
    assert_eq!(
        deprecated_base_model_migration_target("openai/responses/GPT-5.6-SOL:latest"),
        None
    );
    assert_eq!(
        deprecated_base_model_migration_target("Claude Opus 4.8"),
        None
    );
    assert!(obsolete_model_retirement_matches(&json!({
        "id": "gPt-5.4:LaTeSt",
        "meta": { "disabled": true, "hidden": true },
        "is_active": false
    })));
    assert!(obsolete_model_retirement_matches(&json!({
        "id": "Claude Opus 4.6",
        "meta": { "disabled": true, "hidden": true },
        "is_active": false
    })));
}
#[test]
fn model_sync_lease_release_failure_preserves_the_active_owner() {
    let store = LeaseTestStore::default();
    let epoch = store.begin_model_sync_epoch("owner-a", 1_000, 0).unwrap();
    store.fail_release();
    assert!(store.release_model_sync_epoch("owner-a", epoch).is_err());
    store.verify_model_sync_epoch("owner-a", epoch).unwrap();
}

#[test]
fn stale_model_sync_owner_cannot_release_a_successor_lease() {
    let store = LeaseTestStore::default();
    let stale_epoch = store.begin_model_sync_epoch("owner-a", 1_000, 0).unwrap();
    store.expire();
    let successor_epoch = store.begin_model_sync_epoch("owner-b", 1_000, 0).unwrap();
    assert!(!store
        .release_model_sync_epoch("owner-a", stale_epoch)
        .unwrap());
    store
        .verify_model_sync_epoch("owner-b", successor_epoch)
        .unwrap();
}

#[test]
fn marker_publish_fails_if_lease_expires_after_audit() {
    let env = TestEnv::new("marker-expired-before-publish");
    env.write_base_system_prompt("Prompt");
    env.write_model_catalog_models(&["GPT-5.6 Sol"]);
    let store = LeaseTestStore::default();
    let epoch = store.begin_model_sync_epoch("owner", 1_000, 0).unwrap();
    mark_model_sync_pending_for_epoch(&env.paths, "session", epoch, "owner", Some(&store)).unwrap();
    store.verify_model_sync_epoch("owner", epoch).unwrap();
    store.expire();
    assert!(mark_model_sync_completed_for_epoch(
        &env.paths,
        "session",
        epoch,
        "owner",
        Some(&store),
    )
    .is_err());
    assert_eq!(
        model_sync_marker_status(&env.paths, "session")
            .unwrap()
            .stored_state
            .as_deref(),
        Some("pending")
    );
}

#[test]
fn marker_publish_is_fenced_if_lease_expires_between_verification_and_rename() {
    let env = TestEnv::new("marker-expired-at-publish");
    env.write_base_system_prompt("Prompt");
    env.write_model_catalog_models(&["GPT-5.6 Sol"]);
    let store = Arc::new(LeaseTestStore::default());
    let stale_epoch = store
        .begin_model_sync_epoch("stale-owner", 1_000, 0)
        .unwrap();
    mark_model_sync_pending_for_epoch(
        &env.paths,
        "session",
        stale_epoch,
        "stale-owner",
        Some(store.as_ref()),
    )
    .unwrap();

    let stale_complete = ModelSyncMarkerV2 {
        version: MODEL_SYNC_MARKER_VERSION,
        state: "complete".to_string(),
        fingerprint: compute_model_sync_completion_marker(&env.paths, "session").unwrap(),
        epoch: stale_epoch,
        owner: "stale-owner".to_string(),
        policy_version: MODEL_SYNC_POLICY_VERSION.to_string(),
    };
    let successor = Arc::new(Mutex::new(None));
    let successor_slot = Arc::clone(&successor);
    let successor_store = Arc::clone(&store);
    let successor_paths = env.paths.clone();

    let result = write_model_sync_marker_atomic_with_hook(
        &env.paths,
        &stale_complete,
        Some((store.as_ref(), "stale-owner", stale_epoch)),
        move || {
            successor_store.expire();
            let successor_epoch = successor_store
                .begin_model_sync_epoch("successor", 1_000, stale_epoch)
                .unwrap();
            let handle = thread::spawn(move || {
                mark_model_sync_pending_for_epoch(
                    &successor_paths,
                    "session",
                    successor_epoch,
                    "successor",
                    Some(successor_store.as_ref()),
                )
                .map(|()| successor_epoch)
            });
            *successor_slot.lock().unwrap() = Some(handle);
            thread::sleep(Duration::from_millis(100));
        },
    );

    assert!(result.is_err());
    let successor_epoch = successor
        .lock()
        .unwrap()
        .take()
        .unwrap()
        .join()
        .unwrap()
        .unwrap();
    let status = model_sync_marker_status(&env.paths, "session").unwrap();
    assert_eq!(status.stored_epoch, Some(successor_epoch));
    assert_eq!(status.stored_state.as_deref(), Some("pending"));
}

#[test]
fn marker_completion_rejects_fingerprint_drift_and_preserves_pending() {
    let env = TestEnv::new("marker-fingerprint-drift");
    env.write_base_system_prompt("Prompt");
    env.write_model_catalog_models(&["GPT-5.6 Sol"]);
    fs::remove_file(&env.paths.konami_unlock_flag_file).ok();
    mark_model_sync_pending_for_epoch(&env.paths, "session", 7, "owner", None).unwrap();
    let before = fs::read(&env.paths.model_sync_completed_session_file).unwrap();

    fs::write(&env.paths.konami_unlock_flag_file, "").unwrap();
    assert!(mark_model_sync_completed_for_epoch(&env.paths, "session", 7, "owner", None,).is_err());
    assert_eq!(
        fs::read(&env.paths.model_sync_completed_session_file).unwrap(),
        before
    );
    let status = model_sync_marker_status(&env.paths, "session").unwrap();
    assert_eq!(status.stored_state.as_deref(), Some("pending"));
    assert!(!status.matches);
}

#[test]
fn marker_transition_enforces_epoch_identity_and_state() {
    let pending = ModelSyncMarkerV2 {
        version: MODEL_SYNC_MARKER_VERSION,
        state: "pending".to_string(),
        fingerprint: "a".repeat(32),
        epoch: 4,
        owner: "owner".to_string(),
        policy_version: MODEL_SYNC_POLICY_VERSION.to_string(),
    };
    let complete = ModelSyncMarkerV2 {
        state: "complete".to_string(),
        ..pending.clone()
    };
    assert!(validate_model_sync_marker_transition(None, &pending).is_ok());
    assert!(validate_model_sync_marker_transition(None, &complete).is_err());
    assert!(validate_model_sync_marker_transition(Some(&pending), &pending).is_ok());
    assert!(validate_model_sync_marker_transition(Some(&pending), &complete).is_ok());
    assert!(validate_model_sync_marker_transition(Some(&complete), &complete).is_ok());
    assert!(validate_model_sync_marker_transition(Some(&complete), &pending).is_err());

    let changed_owner = ModelSyncMarkerV2 {
        owner: "other".to_string(),
        ..complete.clone()
    };
    let changed_policy = ModelSyncMarkerV2 {
        policy_version: "other-policy".to_string(),
        ..complete.clone()
    };
    let changed_fingerprint = ModelSyncMarkerV2 {
        fingerprint: "b".repeat(32),
        ..complete.clone()
    };
    for changed in [&changed_owner, &changed_policy, &changed_fingerprint] {
        assert!(validate_model_sync_marker_transition(Some(&pending), changed).is_err());
    }

    let lower_pending = ModelSyncMarkerV2 {
        epoch: 3,
        ..pending.clone()
    };
    let higher_pending = ModelSyncMarkerV2 {
        epoch: 5,
        ..pending.clone()
    };
    let higher_complete = ModelSyncMarkerV2 {
        state: "complete".to_string(),
        ..higher_pending.clone()
    };
    assert!(validate_model_sync_marker_transition(Some(&pending), &lower_pending).is_err());
    assert!(validate_model_sync_marker_transition(Some(&pending), &higher_pending).is_ok());
    assert!(validate_model_sync_marker_transition(Some(&pending), &higher_complete).is_err());
}

async fn run_reconcile_acceptance_attempt(
    env: &TestEnv,
    server: &ReconcileServer,
    store: Arc<LeaseTestStore>,
    core: &MockServer,
    regular: &MockServer,
    host: &MockServer,
    session: &str,
) -> anyhow::Result<bool> {
    queue_summary(
        core,
        vec![
            summary_entry("mcp-assistant", "core", true, true, 1),
            summary_entry("subagents", "core", true, true, 1),
            summary_entry("skills", "core", true, true, 1),
        ],
    );
    queue_summary(regular, vec![]);
    queue_empty_oauth_status(regular);
    queue_empty_oauth_status(core);

    let app = HealthCheckApp::new(
        env.paths.clone(),
        base_config(
            HealthCheckMode::StartupCore,
            &server.base_url,
            &core.base_url,
            &regular.base_url,
            &host.base_url,
            session,
        ),
        fast_retries(),
        Some(store as Arc<dyn TokenStore>),
        Arc::new(MockLogInspector::default()) as Arc<dyn ContainerLogInspector>,
    );
    let client = OpenWebUiClient::new(Client::new(), &server.base_url, Duration::from_secs(5));
    app.run_authenticated(client).await
}

#[tokio::test]
async fn model_reconciliation_failures_remain_pending_then_retry_to_audited_completion() {
    for failure in [
        ReconcileFailurePoint::TargetCreate,
        ReconcileFailurePoint::TargetReadback,
        ReconcileFailurePoint::DerivedMigration,
        ReconcileFailurePoint::SettingsUpdate,
        ReconcileFailurePoint::InvalidScheduledTask,
        ReconcileFailurePoint::Retirement,
    ] {
        let name = format!("reconcile-retry-{failure:?}");
        let env = TestEnv::new(&name);
        env.write_base_system_prompt("Base prompt");
        env.write_model_catalog_models(&["GPT-5.6 Sol"]);
        write_core_server_configs(&env);

        let task_path = if failure == ReconcileFailurePoint::InvalidScheduledTask {
            let tasks_dir = env.paths.app_support_dir.join("scheduled_tasks");
            fs::create_dir_all(&tasks_dir).unwrap();
            let path = tasks_dir.join("task.json");
            fs::write(&path, "{ invalid").unwrap();
            Some(path)
        } else {
            None
        };

        let server = ReconcileServer::start(failure).await;
        let store = Arc::new(LeaseTestStore::default());
        let core = MockServer::start().await;
        let regular = MockServer::start().await;
        let host = MockServer::start().await;
        let session = format!("session-{failure:?}");

        assert!(run_reconcile_acceptance_attempt(
            &env,
            &server,
            store.clone(),
            &core,
            &regular,
            &host,
            &session,
        )
        .await
        .unwrap());
        let pending = model_sync_marker_status(&env.paths, &session).unwrap();
        assert_eq!(
            pending.stored_state.as_deref(),
            Some("pending"),
            "{failure:?} must not publish a completion marker"
        );
        assert!(!pending.matches, "{failure:?} unexpectedly completed");
        let (models, settings, failure_consumed) = server.snapshot();
        let legacy = models.get("GPT-5.4").unwrap();
        assert!(
            !obsolete_model_retirement_matches(legacy),
            "{failure:?} retired the source model after a failed attempt"
        );
        let expected_default = if failure == ReconcileFailurePoint::Retirement {
            "GPT-5.6 Sol"
        } else {
            "GPT-5.4"
        };
        assert_eq!(
            settings["ui"]["models"][0],
            json!(expected_default),
            "{failure:?} left an unexpected default after the failed attempt"
        );
        if failure != ReconcileFailurePoint::InvalidScheduledTask {
            assert!(failure_consumed, "{failure:?} injection was not exercised");
        }

        if let Some(task_path) = task_path.as_ref() {
            fs::write(task_path, r#"{ "model_id": "GPT-5.4" }"#).unwrap();
        }

        assert!(run_reconcile_acceptance_attempt(
            &env,
            &server,
            store.clone(),
            &core,
            &regular,
            &host,
            &session,
        )
        .await
        .unwrap());
        let completed = model_sync_marker_status(&env.paths, &session).unwrap();
        let health_log =
            fs::read_to_string(health_sync_log_file_path(&env.paths)).unwrap_or_default();
        assert_eq!(
            completed.stored_state.as_deref(),
            Some("complete"),
            "{failure:?} retry stayed pending: {health_log}"
        );
        assert!(completed.matches, "{failure:?} retry did not complete");

        let (models, settings, _) = server.snapshot();
        assert!(models.contains_key("GPT-5.6 Sol"));
        assert_eq!(
            parse_base_model_ref(models.get("agent-old").unwrap())
                .unwrap()
                .as_deref(),
            Some("GPT-5.6 Sol")
        );
        assert_eq!(settings["ui"]["models"][0], json!("GPT-5.6 Sol"));
        assert!(obsolete_model_retirement_matches(
            models.get("GPT-5.4").unwrap()
        ));
        if let Some(task_path) = task_path {
            let task: Value = serde_json::from_slice(&fs::read(task_path).unwrap()).unwrap();
            assert_eq!(task["model_id"], json!("GPT-5.6 Sol"));
        }

        let audit_client =
            OpenWebUiClient::new(Client::new(), &server.base_url, Duration::from_secs(5));
        audit_model_sync_referential_integrity(
            &audit_client,
            &env.paths,
            &["GPT-5.6 Sol".to_string()],
            &["GPT-5.4".to_string()],
            "GPT-5.6 Sol",
        )
        .await
        .unwrap();
    }
}
#[derive(Default)]
struct MockLogInspector {
    failures: Mutex<HashMap<String, bool>>,
}

impl MockLogInspector {
    fn set_failure(&self, container_name: &str, has_error: bool) {
        self.failures
            .lock()
            .unwrap()
            .insert(container_name.to_string(), has_error);
    }
}

impl ContainerLogInspector for MockLogInspector {
    fn has_errors(&self, container_name: &str, _lines: usize) -> bool {
        self.failures
            .lock()
            .unwrap()
            .get(container_name)
            .copied()
            .unwrap_or(false)
    }
}

struct TestEnv {
    _tempdir: TempDir,
    paths: AppPaths,
}

#[derive(Default)]
struct FailingTokenStore;

impl TokenStore for FailingTokenStore {
    fn set(&self, _key: &str, _value: &str) -> anyhow::Result<()> {
        anyhow::bail!("boom")
    }
}

struct MockRedisServer {
    url: String,
    commands: Arc<Mutex<Vec<String>>>,
    shutdown: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
}

impl MockRedisServer {
    async fn start() -> Self {
        let listener = StdTcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let commands = Arc::new(Mutex::new(Vec::new()));
        let shared_commands = commands.clone();
        let shutdown = Arc::new(AtomicBool::new(false));
        let shutdown_thread = shutdown.clone();
        let handle = thread::spawn(move || {
            while !shutdown_thread.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut socket, _)) => {
                        socket
                            .set_read_timeout(Some(Duration::from_millis(250)))
                            .ok();
                        let mut buffer = [0_u8; 4096];
                        loop {
                            match socket.read(&mut buffer) {
                                Ok(0) => break,
                                Ok(read) => {
                                    let chunk =
                                        String::from_utf8_lossy(&buffer[..read]).to_string();
                                    shared_commands.lock().unwrap().push(chunk.clone());
                                    let replies = chunk.matches('*').count().max(1);
                                    for _ in 0..replies {
                                        if socket.write_all(b"+OK\r\n").is_err() {
                                            return;
                                        }
                                    }
                                }
                                Err(error)
                                    if error.kind() == std::io::ErrorKind::WouldBlock
                                        || error.kind() == std::io::ErrorKind::TimedOut =>
                                {
                                    if shutdown_thread.load(Ordering::Relaxed) {
                                        break;
                                    }
                                }
                                Err(_) => break,
                            }
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            url: format!("redis://{address}/"),
            commands,
            shutdown,
            handle: Some(handle),
        }
    }
}

impl Drop for MockRedisServer {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
        let _ = std::net::TcpStream::connect(
            self.url
                .trim_start_matches("redis://")
                .trim_end_matches('/'),
        );
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl TestEnv {
    fn new(name: &str) -> Self {
        let tempdir = TempDir::new().unwrap();
        let root = tempdir.path().join(name);
        fs::create_dir_all(&root).unwrap();
        let paths = build_paths(&root);
        fs::create_dir_all(&paths.src_root).unwrap();
        fs::create_dir_all(&paths.filters_dir).unwrap();
        fs::create_dir_all(&paths.agents_dir).unwrap();
        fs::create_dir_all(&paths.app_support_dir).unwrap();
        fs::create_dir_all(&paths.health_status_dir).unwrap();
        fs::create_dir_all(&paths.backup_dir).unwrap();
        fs::create_dir_all(&paths.mcp_configs_dir).unwrap();
        fs::create_dir_all(&paths.mcp_configs_user_dir).unwrap();
        fs::create_dir_all(&paths.mcpo_configs_generated_dir).unwrap();
        fs::create_dir_all(paths.agent_icon_file.parent().unwrap()).unwrap();
        fs::write(&paths.claude_icon_file, b"claude").unwrap();
        fs::write(&paths.gpt_icon_file, b"gpt").unwrap();
        fs::write(&paths.gemini_icon_file, b"gemini").unwrap();
        fs::write(&paths.sol_icon_file, b"sol").unwrap();
        fs::write(&paths.terra_icon_file, b"terra").unwrap();
        fs::write(&paths.luna_icon_file, b"luna").unwrap();
        fs::write(&paths.agent_icon_file, b"agent").unwrap();
        fs::write(&paths.user_env_file, "").unwrap();
        fs::write(&paths.mcp_toggles_file, "{}").unwrap();
        fs::write(&paths.health_check_mode_file, "full").unwrap();
        fs::write(&paths.health_sync_session_id_file, "session-1").unwrap();
        Self {
            _tempdir: tempdir,
            paths,
        }
    }

    fn write_filter(&self, name: &str, code: &str) {
        fs::write(self.paths.filters_dir.join(format!("{name}.py")), code).unwrap();
    }

    fn write_valves(&self, name: &str, body: serde_json::Value) {
        fs::write(
            self.paths.filters_dir.join(format!("{name}.valves")),
            serde_json::to_vec(&body).unwrap(),
        )
        .unwrap();
    }

    fn write_agent(&self, dir: &str, config_yaml: &str, system_prompt: &str) {
        let root = self.paths.agents_dir.join(dir);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("config.yaml"), config_yaml).unwrap();
        fs::write(root.join("system_prompt.md"), system_prompt).unwrap();
    }

    fn write_base_system_prompt(&self, prompt: &str) {
        fs::write(self.paths.agents_dir.join("base_system_prompt.md"), prompt).unwrap();
    }

    fn write_server_yaml(&self, user_installed: bool, server_id: &str, yaml_body: &str) {
        let root = if user_installed {
            self.paths.mcp_configs_user_dir.join(server_id)
        } else {
            self.paths.mcp_configs_dir.join(server_id)
        };
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(format!("{server_id}.yaml")), yaml_body).unwrap();
    }

    fn write_model_catalog_models(&self, models: &[&str]) {
        let model_entries = models
            .iter()
            .map(|model| format!("  - model_name: \"{model}\""))
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(
            &self.paths.model_catalog_file,
            format!("model_list:\n{model_entries}\n"),
        )
        .unwrap();
    }

    fn write_model_catalog(&self, yaml_body: &str) {
        fs::write(&self.paths.model_catalog_file, yaml_body).unwrap();
    }
}

fn configured_model_readback(
    env: &TestEnv,
    model_id: &str,
    disabled: bool,
    disabled_reason: Option<&str>,
    tools: &[String],
    target_default_model: &str,
) -> Value {
    let configured = ConfiguredBaseModel {
        id: model_id.to_string(),
        source_model_id: None,
        disabled,
        disabled_reason: disabled_reason.map(ToOwned::to_owned),
    };
    let mut payload = json!({});
    canonicalize_base_model_payload(
        &env.paths,
        &mut payload,
        &configured,
        "Base prompt",
        tools,
        target_default_model,
    );
    payload
}

fn build_paths(root: &Path) -> AppPaths {
    let app_root = root.to_path_buf();
    let src_root = app_root.join("src");
    let health_status_dir = app_root.join("health-status");
    let app_support_dir = app_root.join("app-support");
    AppPaths {
        app_root: app_root.clone(),
        src_root: src_root.clone(),
        app_support_dir: app_support_dir.clone(),
        filters_dir: src_root.join("filters"),
        agents_dir: app_root.join("agents"),
        health_status_dir: health_status_dir.clone(),
        backup_dir: app_root.join("backup"),
        mcp_configs_dir: app_root.join("mcp-configs"),
        mcp_configs_user_dir: app_root.join("mcp-configs-user"),
        mcpo_configs_generated_dir: app_root.join("mcpo-configs-generated"),
        runtime_file_status_file: app_root
            .join("mcpo-configs-generated")
            .join("runtime-file-status.json"),
        server_config_status_file: app_root
            .join("mcpo-configs-generated")
            .join("server-config-status.json"),
        oauth_tokens_dir: app_root.join("mcpo-oauth-tokens"),
        host_mode_file: app_root.join("HOST_MODE"),
        mcp_toggles_file: app_root.join("mcp_toggles.json"),
        user_env_file: app_root.join("user.env"),
        model_catalog_file: app_root.join("model_catalog.yaml"),
        claude_icon_file: app_root.join("claude.png"),
        gpt_icon_file: app_root.join("gpt.png"),
        gemini_icon_file: app_root.join("gemini.png"),
        sol_icon_file: app_root.join("sol.png"),
        terra_icon_file: app_root.join("terra.png"),
        luna_icon_file: app_root.join("luna.png"),
        agent_icon_file: app_root.join("assets/agent-icon.png"),
        health_check_mode_file: health_status_dir.join("health_check_mode"),
        health_sync_session_id_file: health_status_dir.join("health_sync_session_id"),
        health_sync_run_id_file: health_status_dir.join("health_sync_run_id"),
        health_sync_reason_file: health_status_dir.join("health_sync_reason"),
        health_sync_timeout_budget_ms_file: health_status_dir.join("health_sync_timeout_budget_ms"),
        model_sync_completed_session_file: health_status_dir
            .join("model_sync_completed_session_id"),
        konami_unlock_flag_file: health_status_dir.join("KONAMI"),
        lm_studio_config_file: app_support_dir.join("lm-studio.json"),
        api_log_dir: health_status_dir.join("api-logs"),
    }
}

fn base_config(
    mode: HealthCheckMode,
    openwebui_url: &str,
    core_url: &str,
    regular_url: &str,
    host_url: &str,
    session_id: &str,
) -> RuntimeConfig {
    RuntimeConfig {
        openwebui_base_url: openwebui_url.to_string(),
        mcpo_regular_host: "regular-mcpo".to_string(),
        mcpo_regular_base_url: regular_url.to_string(),
        mcpo_core_host: "core-mcpo".to_string(),
        mcpo_core_base_url: core_url.to_string(),
        host_mcpo_host: "host-mcpo".to_string(),
        host_mcpo_base_url: host_url.to_string(),
        mcpo_regular_localhost_port: "8765".to_string(),
        mcpo_core_localhost_port: "8766".to_string(),
        host_mcpo_localhost_port: "8890".to_string(),
        mode,
        sync_enabled: mode != HealthCheckMode::Light,
        core_only_sync: mode == HealthCheckMode::StartupCore,
        health_sync_session_id: session_id.to_string(),
        health_sync_run_id: format!("run-{session_id}"),
        health_sync_reason: "test".to_string(),
        health_sync_timeout_budget_ms: Some(120_000),
        write_api_logs: true,
        oauth_token_max_age_seconds: 7 * 24 * 60 * 60,
    }
}

fn startup_readiness_config(
    gateway_health_url: String,
    openwebui_base_url: String,
) -> StartupReadinessConfig {
    StartupReadinessConfig {
        llm_gateway_health_url: gateway_health_url,
        openwebui_base_url,
        require_bifrost_ready: true,
        max_attempts: 1,
        bootstrapping: false,
        request_timeout: Duration::from_secs(2),
        retry_delay: Duration::ZERO,
    }
}

#[tokio::test]
async fn startup_readiness_succeeds_when_bifrost_openwebui_and_frontend_are_ready() {
    let gateway = MockServer::start().await;
    let openwebui = MockServer::start().await;
    gateway.queue_json(
        "GET",
        "/health",
        200,
        json!({ "status": "ok", "bifrost_ready": true }),
    );
    openwebui.queue_json("GET", "/health", 200, json!({ "status": "ok" }));
    openwebui.queue_text(
        "GET",
        "/",
        200,
        "<!doctype html><html><body><script src=\"/_app/immutable/start.js\"></script></body></html>",
        "text/html; charset=utf-8",
    );

    assert!(run_startup_readiness(startup_readiness_config(
        format!("{}/health", gateway.base_url),
        openwebui.base_url.clone(),
    ))
    .await
    .unwrap());
}

#[tokio::test]
async fn startup_readiness_fails_when_bifrost_is_not_ready() {
    let gateway = MockServer::start().await;
    let openwebui = MockServer::start().await;
    gateway.queue_json(
        "GET",
        "/health",
        200,
        json!({ "status": "ok", "bifrost_ready": false }),
    );

    assert!(!run_startup_readiness(startup_readiness_config(
        format!("{}/health", gateway.base_url),
        openwebui.base_url.clone(),
    ))
    .await
    .unwrap());
    assert!(openwebui.requests().is_empty());
}

#[tokio::test]
async fn startup_readiness_fails_when_openwebui_health_payload_is_unhealthy() {
    let gateway = MockServer::start().await;
    let openwebui = MockServer::start().await;
    gateway.queue_json(
        "GET",
        "/health",
        200,
        json!({ "status": "ok", "bifrost_ready": true }),
    );
    openwebui.queue_json("GET", "/health", 200, json!({ "status": false }));

    assert!(!run_startup_readiness(startup_readiness_config(
        format!("{}/health", gateway.base_url),
        openwebui.base_url.clone(),
    ))
    .await
    .unwrap());
}

#[tokio::test]
async fn startup_readiness_fails_when_frontend_document_is_not_ready() {
    let gateway = MockServer::start().await;
    let openwebui = MockServer::start().await;
    gateway.queue_json(
        "GET",
        "/health",
        200,
        json!({ "status": "ok", "bifrost_ready": true }),
    );
    openwebui.queue_json("GET", "/health", 200, json!({ "status": "ok" }));
    openwebui.queue_text(
        "GET",
        "/",
        200,
        "<html><body>loading</body></html>",
        "text/html",
    );

    assert!(!run_startup_readiness(startup_readiness_config(
        format!("{}/health", gateway.base_url),
        openwebui.base_url.clone(),
    ))
    .await
    .unwrap());
}

#[test]
fn base_model_payload_is_visible_to_all_users() {
    let tempdir = TempDir::new().unwrap();
    let paths = build_paths(tempdir.path());
    let mut payload = json!({
        "access_control": {
            "read": { "group_ids": [], "user_ids": [] },
            "write": { "group_ids": [], "user_ids": [] }
        }
    });

    canonicalize_base_model_payload(
        &paths,
        &mut payload,
        &ConfiguredBaseModel {
            id: "Claude Sonnet 4.6".to_string(),
            source_model_id: None,
            disabled: false,
            disabled_reason: None,
        },
        "base prompt",
        &["portico_core_unified_context".to_string()],
        "Claude Sonnet 4.6",
    );

    assert_eq!(payload["access_control"], Value::Null);
    assert_eq!(payload["is_active"], Value::Bool(true));
    assert_eq!(payload["is_default"], Value::Bool(true));
}

#[test]
fn base_model_payload_uses_provider_specific_icons() {
    let env = TestEnv::new("provider-icons");
    let tools = vec!["portico_core_unified_context".to_string()];
    let cases = [
        (
            ConfiguredBaseModel {
                id: "GPT-5.6 Sol".to_string(),
                source_model_id: None,
                disabled: false,
                disabled_reason: None,
            },
            "data:image/png;base64,c29s",
        ),
        (
            ConfiguredBaseModel {
                id: "GPT-5.6 Sol Pro:LaTeSt".to_string(),
                source_model_id: None,
                disabled: false,
                disabled_reason: None,
            },
            "data:image/png;base64,c29s",
        ),
        (
            ConfiguredBaseModel {
                id: "GPT-5.6 Terra".to_string(),
                source_model_id: None,
                disabled: false,
                disabled_reason: None,
            },
            "data:image/png;base64,dGVycmE=",
        ),
        (
            ConfiguredBaseModel {
                id: "GPT-5.6 Luna".to_string(),
                source_model_id: None,
                disabled: false,
                disabled_reason: None,
            },
            "data:image/png;base64,bHVuYQ==",
        ),
        (
            ConfiguredBaseModel {
                id: "Provider Display Name".to_string(),
                source_model_id: Some("gpt-5.6-sol".to_string()),
                disabled: false,
                disabled_reason: None,
            },
            "data:image/png;base64,c29s",
        ),
        (
            ConfiguredBaseModel {
                id: "Provider Display Name".to_string(),
                source_model_id: Some("openai/responses/gpt-5.6-terra:latest".to_string()),
                disabled: false,
                disabled_reason: None,
            },
            "data:image/png;base64,dGVycmE=",
        ),
        (
            ConfiguredBaseModel {
                id: "Provider Display Name".to_string(),
                source_model_id: Some("router/v1/portico-openai/gpt_5.6_luna:LaTeSt".to_string()),
                disabled: false,
                disabled_reason: None,
            },
            "data:image/png;base64,bHVuYQ==",
        ),
        (
            ConfiguredBaseModel {
                id: "Gemini 3.5 Flash".to_string(),
                source_model_id: Some("openai/stale-provider".to_string()),
                disabled: false,
                disabled_reason: None,
            },
            "data:image/png;base64,Z2VtaW5p",
        ),
        (
            ConfiguredBaseModel {
                id: "Provider Display Name".to_string(),
                source_model_id: Some("gemini/vertex/gemini-3.1-pro-preview".to_string()),
                disabled: false,
                disabled_reason: None,
            },
            "data:image/png;base64,Z2VtaW5p",
        ),
        (
            ConfiguredBaseModel {
                id: "Claude Sonnet 4.6".to_string(),
                source_model_id: Some("anthropic/claude-sonnet-4-6".to_string()),
                disabled: false,
                disabled_reason: None,
            },
            "data:image/png;base64,Y2xhdWRl",
        ),
        (
            ConfiguredBaseModel {
                id: "GPT-5.5".to_string(),
                source_model_id: Some("openai/gpt-5.5".to_string()),
                disabled: false,
                disabled_reason: None,
            },
            "data:image/png;base64,Z3B0",
        ),
        (
            ConfiguredBaseModel {
                id: "GPT-5.6 Solstice".to_string(),
                source_model_id: Some("custom/gpt-5.6-sol-prototype:latest".to_string()),
                disabled: false,
                disabled_reason: None,
            },
            "data:image/png;base64,Z3B0",
        ),
    ];

    for (configured_model, expected_icon) in cases {
        let mut payload = json!({});
        canonicalize_base_model_payload(
            &env.paths,
            &mut payload,
            &configured_model,
            "base prompt",
            &tools,
            "Gemini 3.5 Flash",
        );
        assert_eq!(payload["meta"]["profile_image_url"], json!(expected_icon));
    }
}

#[test]
fn model_sync_marker_includes_model_icon_inputs() {
    let env = TestEnv::new("model-sync-icon-marker");
    env.write_base_system_prompt("Prompt A");
    env.write_model_catalog_models(&["Gemini 3.5 Flash"]);

    let original_marker =
        compute_model_sync_completion_marker(&env.paths, "session-icons").unwrap();
    let metadata = model_sync_fingerprint_metadata(&env.paths, "session-icons");
    assert_eq!(
        metadata.model_icon_resolver_version,
        MODEL_ICON_RESOLVER_VERSION
    );
    assert!(metadata.claude_icon_exists);
    assert!(metadata.gpt_icon_exists);
    assert!(metadata.gemini_icon_exists);
    assert!(metadata.sol_icon_exists);
    assert!(metadata.terra_icon_exists);
    assert!(metadata.luna_icon_exists);
    assert_eq!(metadata.gemini_icon_bytes, 6);
    assert_eq!(metadata.sol_icon_bytes, 3);
    assert_eq!(metadata.terra_icon_bytes, 5);
    assert_eq!(metadata.luna_icon_bytes, 4);

    for (path, original_bytes) in [
        (&env.paths.sol_icon_file, b"sol".as_slice()),
        (&env.paths.terra_icon_file, b"terra".as_slice()),
        (&env.paths.luna_icon_file, b"luna".as_slice()),
    ] {
        fs::write(path, b"changed-celestial-icon").unwrap();
        let updated_marker =
            compute_model_sync_completion_marker(&env.paths, "session-icons").unwrap();
        assert_ne!(
            original_marker,
            updated_marker,
            "changing {} must invalidate the model sync marker",
            path.display()
        );
        fs::write(path, original_bytes).unwrap();
        assert_eq!(
            original_marker,
            compute_model_sync_completion_marker(&env.paths, "session-icons").unwrap()
        );
    }
}

#[test]
fn health_check_docker_wiring_includes_celestial_model_icons() {
    const DOCKERFILE: &str = include_str!("../../../../../Dockerfile.health-check");
    const COMPOSE: &str = include_str!("../../../../../docker-compose.yml");
    const DOCKERIGNORE: &str = include_str!("../../../../../.dockerignore");

    for icon in ["sol", "terra", "luna"] {
        assert!(
            DOCKERFILE.contains(&format!("COPY electron-app/assets/{icon}.png .")),
            "Dockerfile.health-check must copy {icon}.png"
        );
        assert!(
            COMPOSE.contains(&format!(
                "./electron-app/assets/{icon}.png:/app/{icon}.png:ro"
            )),
            "docker-compose.yml must mount {icon}.png read-only"
        );
        assert!(
            DOCKERIGNORE.contains(&format!("!electron-app/assets/{icon}.png")),
            ".dockerignore must allow {icon}.png into the build context"
        );
    }
}

#[test]
fn legacy_model_sync_marker_is_recognized_and_upgraded_to_v2() {
    let env = TestEnv::new("legacy-model-sync-marker");
    env.write_base_system_prompt("Prompt");
    env.write_model_catalog_models(&["GPT-5.6 Sol"]);
    let legacy = compute_legacy_model_sync_completion_marker(&env.paths, "session").unwrap();
    fs::write(&env.paths.model_sync_completed_session_file, legacy).unwrap();
    let status = model_sync_marker_status(&env.paths, "session").unwrap();
    assert!(status.matches);
    assert!(status.legacy_marker);
    mark_model_sync_completed_for_session(&env.paths, "session").unwrap();
    let status = model_sync_marker_status(&env.paths, "session").unwrap();
    assert!(status.matches);
    assert!(!status.legacy_marker);
    assert_eq!(status.stored_state.as_deref(), Some("complete"));
    mark_model_sync_completed_for_session(&env.paths, "session").unwrap();
}

#[test]
fn raw_session_model_sync_marker_is_treated_as_stale_and_upgraded_to_v2() {
    let env = TestEnv::new("raw-session-model-sync-marker");
    env.write_base_system_prompt("Prompt");
    env.write_model_catalog_models(&["GPT-5.6 Sol"]);
    fs::write(
        &env.paths.model_sync_completed_session_file,
        "1785312852703-75010-c9c85e75b04b",
    )
    .unwrap();

    let stale = model_sync_marker_status(&env.paths, "current-session").unwrap();
    assert!(stale.marker_file_exists);
    assert!(!stale.matches);
    assert!(!stale.legacy_marker);

    mark_model_sync_completed_for_session(&env.paths, "current-session").unwrap();
    let upgraded = model_sync_marker_status(&env.paths, "current-session").unwrap();
    assert!(upgraded.matches);
    assert_eq!(upgraded.stored_state.as_deref(), Some("complete"));
}

#[test]
fn stale_legacy_hex_marker_is_reconciled_but_future_or_malformed_records_fail_closed() {
    let env = TestEnv::new("model-sync-marker-validation");
    env.write_base_system_prompt("Prompt");
    env.write_model_catalog_models(&["GPT-5.6 Sol"]);

    fs::write(&env.paths.model_sync_completed_session_file, "0".repeat(32)).unwrap();
    let stale_legacy = model_sync_marker_status(&env.paths, "session").unwrap();
    assert!(!stale_legacy.matches);
    assert!(!stale_legacy.legacy_marker);
    mark_model_sync_completed_for_session(&env.paths, "session").unwrap();
    assert!(
        model_sync_marker_status(&env.paths, "session")
            .unwrap()
            .matches
    );

    let future = json!({
        "version": MODEL_SYNC_MARKER_VERSION + 1,
        "state": "complete",
        "fingerprint": compute_model_sync_completion_marker(&env.paths, "session").unwrap(),
        "epoch": 99,
        "owner": "future-owner",
        "policy_version": MODEL_SYNC_POLICY_VERSION,
    });
    fs::write(
        &env.paths.model_sync_completed_session_file,
        serde_json::to_vec(&future).unwrap(),
    )
    .unwrap();
    assert!(model_sync_marker_status(&env.paths, "session").is_err());
    assert!(mark_model_sync_completed_for_session(&env.paths, "session").is_err());

    fs::write(
        &env.paths.model_sync_completed_session_file,
        br#"{"version":2,"state":"complete"}"#,
    )
    .unwrap();
    assert!(model_sync_marker_status(&env.paths, "session").is_err());
    assert!(mark_model_sync_completed_for_session(&env.paths, "session").is_err());
}

#[test]
fn equivalent_provider_prefixed_base_references_are_not_treated_as_drift() {
    let equivalent = json!({
        "base_model_id": "OpenAI/Responses/GPT-5.4-PRO:Latest",
        "info": {"base_model_id": "gpt-5.4-pro"},
    });
    assert_eq!(
        parse_base_model_ref(&equivalent).unwrap().as_deref(),
        Some("OpenAI/Responses/GPT-5.4-PRO:Latest")
    );
    assert!(parse_base_model_ref(&json!({
        "base_model_id": "GPT-5.4",
        "info": {"base_model_id": "GPT-4.1"},
    }))
    .is_err());
}

#[test]
fn catalog_retirement_migrations_match_the_health_reconcile_map() {
    let yaml: serde_yaml::Value = serde_yaml::from_slice(
        &fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../model_catalog.yaml"))
            .unwrap(),
    )
    .unwrap();
    let migrations = yaml
        .get("model_migrations")
        .and_then(serde_yaml::Value::as_mapping)
        .unwrap();
    assert_eq!(migrations.len(), obsolete_managed_model_ids().len());
    for source in obsolete_managed_model_ids() {
        let target = migrations
            .get(serde_yaml::Value::String((*source).to_string()))
            .and_then(serde_yaml::Value::as_str)
            .unwrap();
        assert_eq!(
            Some(target),
            deprecated_base_model_migration_target(source),
            "catalog migration mismatch for {source}"
        );
    }
}

#[test]
fn marker_repair_only_rechecks_tasks_on_retired_models() {
    let env = TestEnv::new("retired-task-marker-repair");
    let tasks_dir = env.paths.app_support_dir.join("scheduled_tasks");
    fs::create_dir_all(&tasks_dir).unwrap();
    fs::write(
        tasks_dir.join("selectable.json"),
        serde_json::to_vec(&json!({ "model_id": "Claude Sonnet 4.6" })).unwrap(),
    )
    .unwrap();
    // Gemini 3.5 Flash migrates without being retired (like Sonnet 4.6), so a
    // task pinned to it must not force marker self-repair either.
    fs::write(
        tasks_dir.join("selectable-gemini.json"),
        serde_json::to_vec(&json!({ "model_id": "Gemini 3.5 Flash" })).unwrap(),
    )
    .unwrap();
    assert!(!scheduled_tasks_need_model_migration(&env.paths).unwrap());

    fs::write(
        tasks_dir.join("retired.json"),
        serde_json::to_vec(&json!({ "model_id": "GPT-5.4" })).unwrap(),
    )
    .unwrap();
    assert!(scheduled_tasks_need_model_migration(&env.paths).unwrap());

    // Retired Opus models participate in marker self-repair the same way.
    fs::remove_file(tasks_dir.join("retired.json")).unwrap();
    assert!(!scheduled_tasks_need_model_migration(&env.paths).unwrap());
    fs::write(
        tasks_dir.join("retired-opus.json"),
        serde_json::to_vec(&json!({ "model_id": "Claude Opus 4.7" })).unwrap(),
    )
    .unwrap();
    assert!(scheduled_tasks_need_model_migration(&env.paths).unwrap());
}

#[test]
fn scheduled_task_cas_rejects_a_stale_prewrite_digest() {
    let env = TestEnv::new("scheduled-task-stale-cas");
    let path = env.paths.app_support_dir.join("scheduled-task.json");
    let original = json!({ "model_id": "GPT-5.4", "revision": 1 });
    fs::write(&path, serde_json::to_vec(&original).unwrap()).unwrap();
    let stale_digest = sha2::Sha256::digest(b"different revision").to_vec();
    let replacement = json!({ "model_id": "GPT-5.6 Sol", "revision": 2 });
    assert!(write_json_atomic_cas(&path, &stale_digest, &replacement).is_err());
    let readback: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(readback, original);
    let current_digest = sha2::Sha256::digest(&fs::read(&path).unwrap()).to_vec();
    write_json_atomic_cas(&path, &current_digest, &replacement).unwrap();
    let readback: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(readback, replacement);
}

#[test]
fn health_sync_event_log_writes_text_appends_and_redacts_sensitive_fields() {
    let env = TestEnv::new("health-sync-log");
    let config = base_config(
        HealthCheckMode::Full,
        "http://open-webui:8080",
        "http://mcpo-core:8081",
        "http://mcpo",
        "http://host.docker.internal:8890",
        "session-redaction",
    );
    let log_path = health_sync_log_file_path(&env.paths);
    fs::create_dir_all(log_path.parent().unwrap()).unwrap();
    fs::write(
        &log_path,
        "{\"event\":\"old_json\"}\nold text line\n  {\"event\":\"old_json_2\"}\n",
    )
    .unwrap();

    log_health_sync_event(
        &env.paths,
        &config,
        "model_sync_test",
        json!({
            "model_ids": ["Claude Sonnet 4.6"],
            "request": { "messages": ["private prompt"] },
            "nested": {
                "token": "secret-token",
                "safe_count": 2
            },
            "error": "HTTP 502: raw proxy response body",
            "message": "Expected JSON response from /api/models (content-type=text/html): parse failure. Body preview: raw html proxy body",
            "response": "raw model response"
        }),
    )
    .unwrap();
    log_health_sync_event(
        &env.paths,
        &config,
        "model_sync_test_2",
        json!({ "body": "raw body", "model_count": 1 }),
    )
    .unwrap();

    assert!(log_path.starts_with(env.paths.app_support_dir.join("logs")));
    assert_eq!(
        log_path.extension().and_then(|ext| ext.to_str()),
        Some("log")
    );
    let raw_text = fs::read_to_string(&log_path).unwrap();
    assert_eq!(raw_text.lines().count(), 3);
    assert!(raw_text.starts_with("old text line\n"));
    assert!(!raw_text.contains("old_json"));
    assert!(raw_text.contains("model_sync_test"));
    assert!(raw_text.contains("run=run-session-redaction"));
    assert!(!raw_text.lines().next().unwrap_or("").starts_with('{'));
    assert!(!raw_text.contains("private prompt"));
    assert!(!raw_text.contains("secret-token"));
    assert!(!raw_text.contains("raw model response"));
    assert!(!raw_text.contains("raw body"));
    assert!(!raw_text.contains("raw proxy response body"));
    assert!(!raw_text.contains("raw html proxy body"));
    assert!(raw_text.contains("model_ids=[Claude Sonnet 4.6]"));
    assert!(raw_text.contains("request=[redacted]"));
    assert!(raw_text.contains("error=HTTP 502: [response body redacted]"));
    assert!(raw_text.contains("message=Expected JSON response from /api/models (content-type=text/html): parse failure. Body preview: [redacted]"));
    assert!(raw_text.contains("body=[redacted]"));
    let log_dir = log_path.parent().unwrap();
    assert!(!fs::read_dir(log_dir).unwrap().any(|entry| entry
        .unwrap()
        .path()
        .extension()
        .and_then(|extension| extension.to_str())
        == Some("jsonl")));
}

#[test]
fn lm_studio_config_parsing_and_defaults_are_stable() {
    let env = TestEnv::new("lm-studio-config");
    assert!(load_lm_studio_config(&env.paths).unwrap().is_none());

    fs::write(
        &env.paths.lm_studio_config_file,
        r#"{"enabled":true,"port":4567}"#,
    )
    .unwrap();
    let parsed = load_lm_studio_config(&env.paths).unwrap().unwrap();
    assert_eq!(parsed.port, Some(4567));
    let resolved = resolve_lm_studio_config(Some(&parsed));
    assert_eq!(resolved.host_base_url, "http://127.0.0.1:4567/v1");
    assert_eq!(
        resolved.docker_base_url,
        "http://host.docker.internal:4567/v1"
    );
    assert_eq!(
        normalize_lm_studio_base_url("http://127.0.0.1:1234/v1/models"),
        "http://127.0.0.1:1234/v1"
    );
}

#[tokio::test]
async fn lm_studio_sync_no_config_is_noop() {
    let env = TestEnv::new("lm-studio-no-config");
    let client = OpenWebUiClient::new(
        Client::new(),
        "http://127.0.0.1:1",
        Duration::from_millis(10),
    );
    let result = sync_lm_studio_models(
        &env.paths,
        &Client::new(),
        &client,
        "user-id",
        Duration::from_millis(10),
    )
    .await
    .unwrap();
    assert_eq!(result, LmStudioSyncResult::default());
}

#[tokio::test]
async fn lm_studio_sync_registers_connection_and_creates_wrappers() {
    let env = TestEnv::new("lm-studio-success");
    let lm_studio = MockServer::start().await;
    lm_studio.queue_json(
        "GET",
        "/api/v1/models",
        200,
        json!({
            "object": "list",
            "data": [
                {
                    "id": "llama-3-local",
                    "max_context_length": 131072,
                    "loaded_instances": [{ "config": { "context_length": 65536 } }]
                },
                {
                    "id": "downloaded-but-not-loaded",
                    "max_context_length": 32768,
                    "loaded_instances": []
                },
                {
                    "id": "text-embedding-nomic-embed-text-v1.5",
                    "type": "embedding",
                    "loaded_instances": [{ "config": { "context_length": 8192 } }]
                }
            ]
        }),
    );

    fs::write(
        &env.paths.lm_studio_config_file,
        serde_json::to_vec(&LmStudioConfig {
            enabled: Some(true),
            port: Some(1234),
            host_base_url: Some("http://127.0.0.1:1234/v1".to_string()),
            docker_base_url: Some(format!("{}/v1", lm_studio.base_url)),
            api_key: Some(String::new()),
        })
        .unwrap(),
    )
    .unwrap();

    let openwebui = MockServer::start().await;
    openwebui.queue_json(
        "GET",
        "/api/models?",
        200,
        json!({ "data": [{ "id": "GPT-5.4", "info": { "base_model_id": null } }] }),
    );
    openwebui.queue_json(
        "GET",
        "/openai/config",
        200,
        json!({
            "ENABLE_OPENAI_API": true,
            "OPENAI_API_BASE_URLS": ["https://api.openai.com/v1"],
            "OPENAI_API_KEYS": ["existing-key"],
            "OPENAI_API_CONFIGS": { "0": { "enable": true, "model_ids": ["GPT-5.4"] } }
        }),
    );
    openwebui.queue_json("POST", "/openai/config/update", 200, json!({ "ok": true }));
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=llama-3-local",
        404,
        json!({ "detail": "missing" }),
    );
    openwebui.queue_json("POST", "/api/v1/models/create", 200, json!({ "ok": true }));

    let mut client = OpenWebUiClient::new(
        Client::new(),
        openwebui.base_url.clone(),
        Duration::from_secs(2),
    );
    client.set_token("token");
    let result = sync_lm_studio_models(
        &env.paths,
        &Client::new(),
        &client,
        "user-id",
        Duration::from_secs(2),
    )
    .await
    .unwrap();
    assert!(result.reachable);
    assert_eq!(result.model_ids, vec!["llama-3-local"]);
    assert_eq!(result.created, 1);

    let requests = openwebui.requests();
    let config_update = requests
        .iter()
        .find(|request| request.method == "POST" && request.path == "/openai/config/update")
        .expect("config update request");
    let body: Value = serde_json::from_str(&config_update.body).unwrap();
    assert_eq!(body["OPENAI_API_BASE_URLS"][0], "https://api.openai.com/v1");
    assert_eq!(body["OPENAI_API_KEYS"][0], "existing-key");
    assert_eq!(
        body["OPENAI_API_BASE_URLS"][1],
        format!("{}/v1", lm_studio.base_url)
    );
    assert_eq!(body["OPENAI_API_CONFIGS"]["1"]["portico_provider"], "lm_studio");
    assert_eq!(
        body["OPENAI_API_CONFIGS"]["1"]["model_ids"][0],
        "llama-3-local"
    );

    let create = requests
        .iter()
        .find(|request| request.method == "POST" && request.path == "/api/v1/models/create")
        .expect("model create request");
    let body: Value = serde_json::from_str(&create.body).unwrap();
    assert_eq!(body["meta"]["local_provider"], "lm_studio");
    assert_eq!(body["meta"]["disabled"], false);
    assert_eq!(body["meta"]["max_context_tokens"], 65536);
    assert_eq!(body["meta"]["lm_studio_max_context_tokens"], 131072);
    assert!(requests.iter().all(|request| {
        !request
            .body
            .contains("text-embedding-nomic-embed-text-v1.5")
    }));
    assert!(requests
        .iter()
        .all(|request| !request.body.contains("downloaded-but-not-loaded")));
}

#[tokio::test]
async fn lm_studio_sync_unreachable_disables_existing_local_models_without_deleting() {
    let env = TestEnv::new("lm-studio-unreachable");
    let lm_studio = MockServer::start().await;
    lm_studio.queue_json("GET", "/api/v1/models", 500, json!({ "error": "down" }));
    lm_studio.queue_json("GET", "/v1/models", 500, json!({ "error": "down" }));
    fs::write(
        &env.paths.lm_studio_config_file,
        serde_json::to_vec(&LmStudioConfig {
            enabled: Some(true),
            port: Some(1234),
            host_base_url: Some("http://127.0.0.1:1234/v1".to_string()),
            docker_base_url: Some(format!("{}/v1", lm_studio.base_url)),
            api_key: Some(String::new()),
        })
        .unwrap(),
    )
    .unwrap();

    let local_model = json!({
        "id": "local-model",
        "name": "local-model",
        "meta": {
            "local_provider": "lm_studio",
            "local_model_id": "local-model"
        },
        "info": { "base_model_id": null, "meta": { "local_provider": "lm_studio" } }
    });
    let openwebui = MockServer::start().await;
    openwebui.queue_json(
        "GET",
        "/api/models?",
        200,
        json!({ "data": [local_model.clone()] }),
    );
    openwebui.queue_json(
        "GET",
        "/openai/config",
        200,
        json!({
            "ENABLE_OPENAI_API": true,
            "OPENAI_API_BASE_URLS": [format!("{}/v1", lm_studio.base_url)],
            "OPENAI_API_KEYS": [""],
            "OPENAI_API_CONFIGS": {
                "0": {
                    "portico_provider": "lm_studio",
                    "model_ids": ["local-model"]
                }
            }
        }),
    );
    openwebui.queue_json("POST", "/openai/config/update", 200, json!({ "ok": true }));
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=local-model",
        200,
        local_model,
    );
    openwebui.queue_json(
        "POST",
        "/api/v1/models/model/update?id=local-model",
        200,
        json!({ "ok": true }),
    );

    let mut client = OpenWebUiClient::new(
        Client::new(),
        openwebui.base_url.clone(),
        Duration::from_secs(2),
    );
    client.set_token("token");
    let result = sync_lm_studio_models(
        &env.paths,
        &Client::new(),
        &client,
        "user-id",
        Duration::from_secs(2),
    )
    .await
    .unwrap();
    assert!(!result.reachable);
    assert_eq!(result.disabled, 1);

    let requests = openwebui.requests();
    assert!(
        !requests.iter().any(|request| request.method == "DELETE"),
        "LM Studio sync must not delete local model wrappers when server is down"
    );
    let update = requests
        .iter()
        .find(|request| {
            request.method == "POST" && request.path == "/api/v1/models/model/update?id=local-model"
        })
        .expect("model update request");
    let body: Value = serde_json::from_str(&update.body).unwrap();
    assert_eq!(body["meta"]["disabled"], true);
    assert_eq!(body["meta"]["disabled_reason"], LM_STUDIO_DISABLED_REASON);

    let config_update = requests
        .iter()
        .find(|request| request.method == "POST" && request.path == "/openai/config/update")
        .expect("config update request");
    let body: Value = serde_json::from_str(&config_update.body).unwrap();
    assert_eq!(body["OPENAI_API_CONFIGS"]["0"]["enable"], false);
}

fn fast_retries() -> RetryConfig {
    RetryConfig {
        main_retries: 2,
        main_delay: std::time::Duration::ZERO,
        redis_retries: 1,
        redis_delay: std::time::Duration::ZERO,
        auth_retries: 2,
        auth_delay: std::time::Duration::ZERO,
        discovery_retries: 2,
        discovery_delay: std::time::Duration::ZERO,
        request_timeout: std::time::Duration::from_secs(5),
    }
}

fn build_app(
    env: &TestEnv,
    config: RuntimeConfig,
    token_store: Arc<MockTokenStore>,
    log_inspector: Arc<MockLogInspector>,
) -> HealthCheckApp {
    HealthCheckApp::new(
        env.paths.clone(),
        config,
        fast_retries(),
        Some(token_store as Arc<dyn TokenStore>),
        log_inspector as Arc<dyn ContainerLogInspector>,
    )
}

#[test]
#[serial]
fn helper_round_trips_cover_mode_session_env_and_configuration_parsing() {
    let env = TestEnv::new("helpers");
    std::env::remove_var("HEALTH_CHECK_MODE");
    fs::write(&env.paths.health_check_mode_file, "startup-core").unwrap();
    assert_eq!(
        get_health_check_mode(&env.paths),
        HealthCheckMode::StartupCore
    );

    std::env::set_var("HEALTH_CHECK_MODE", "light");
    assert_eq!(get_health_check_mode(&env.paths), HealthCheckMode::Light);
    std::env::remove_var("HEALTH_CHECK_MODE");

    fs::write(&env.paths.health_sync_session_id_file, "file-session").unwrap();
    assert_eq!(get_health_sync_session_id(&env.paths), "file-session");
    std::env::set_var("HEALTH_SYNC_SESSION_ID", "env-session");
    assert_eq!(get_health_sync_session_id(&env.paths), "env-session");
    std::env::remove_var("HEALTH_SYNC_SESSION_ID");

    assert!(!has_model_sync_completed_for_session(&env.paths, "missing").unwrap());
    env.write_base_system_prompt("Prompt A");
    env.write_model_catalog_models(&["Claude Sonnet 4.5"]);
    let done_marker = compute_model_sync_completion_marker(&env.paths, "done").unwrap();
    mark_model_sync_completed_for_session(&env.paths, "done").unwrap();
    assert!(has_model_sync_completed_for_session(&env.paths, "done").unwrap());
    let stored_marker: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(&env.paths.model_sync_completed_session_file).unwrap(),
    )
    .unwrap();
    assert_eq!(stored_marker["fingerprint"], done_marker);
    env.write_base_system_prompt("Prompt B");
    assert!(!has_model_sync_completed_for_session(&env.paths, "done").unwrap());

    fs::write(
        &env.paths.user_env_file,
        "# comment\nGOOD=value\nEMPTY=\nPLACEHOLDER=your_key\n",
    )
    .unwrap();
    let user_env = load_env_file(&env.paths.user_env_file).unwrap();
    let yaml_ok: serde_yaml::Value = serde_yaml::from_str(
        r#"
required_env_vars:
  - GOOD
  - name: ALSO_GOOD
"#,
    )
    .unwrap();
    let yaml_bad: serde_yaml::Value = serde_yaml::from_str(
        r#"
required_env_vars:
  - EMPTY
  - PLACEHOLDER
"#,
    )
    .unwrap();
    let mut ok_env = user_env.clone();
    ok_env.insert("ALSO_GOOD".to_string(), "custom".to_string());
    assert!(is_server_configured("good", &yaml_ok, &ok_env));
    assert!(!is_server_configured("bad", &yaml_bad, &user_env));

    assert_eq!(
        build_http_error_message(Some(500), "boom"),
        "HTTP 500: boom"
    );
    assert_eq!(build_http_error_message(Some(404), ""), "HTTP 404");
    assert_eq!(build_http_error_message(None, ""), "Unknown error");
    assert!(is_numeric_tool_id("server:12"));
    assert!(!is_numeric_tool_id("server:abc"));
    let (best, score) =
        find_best_match("Glean", &["glean".to_string(), "gitlab".to_string()], 0.60);
    assert_eq!(best.as_deref(), Some("glean"));
    assert!(score >= 0.60);
}

#[test]
fn server_scanning_and_enablement_cover_collisions_toggles_and_recent_tokens() {
    let env = TestEnv::new("scan");
    fs::write(&env.paths.user_env_file, "API_KEY=real\n").unwrap();
    fs::write(
        &env.paths.mcp_toggles_file,
        r#"{"disabled-server":false,"enabled-server":true}"#,
    )
    .unwrap();
    env.write_server_yaml(
        false,
        "core-server",
        r#"
display_name: Core Server
deployment_type: docker
is_core: true
"#,
    );
    env.write_server_yaml(
        false,
        "disabled-server",
        r#"
display_name: Disabled Server
deployment_type: docker
required_env_vars:
  - API_KEY
oauth: {}
"#,
    );
    env.write_server_yaml(
        false,
        "recent-server",
        r#"
display_name: Recent Server
deployment_type: docker
required_env_vars:
  - API_KEY
"#,
    );
    env.write_server_yaml(
        true,
        "core-server",
        r#"
display_name: Collision
deployment_type: docker
"#,
    );
    let tokens_dir = env.paths.oauth_tokens_dir.join("recent-server/tokens");
    fs::create_dir_all(&tokens_dir).unwrap();
    fs::write(tokens_dir.join("user_tokens.json"), "{}").unwrap();

    let (servers, ignored) = scan_configured_servers(&env.paths).unwrap();
    assert_eq!(ignored, vec!["core-server".to_string()]);
    assert!(servers.contains_key("core-server"));
    assert!(servers.contains_key("disabled-server"));
    assert!(servers.contains_key("recent-server"));

    let toggles = load_mcp_toggles(&env.paths).unwrap();
    assert_eq!(toggles.get("ignored"), None);
    assert_eq!(
        get_server_enablement_state(
            "core-server",
            servers.get("core-server").unwrap(),
            &toggles,
            &env.paths,
            60,
        ),
        (true, "core".to_string())
    );
    assert_eq!(
        get_server_enablement_state(
            "disabled-server",
            servers.get("disabled-server").unwrap(),
            &toggles,
            &env.paths,
            60,
        ),
        (false, "explicit_false".to_string())
    );
    assert_eq!(
        get_server_enablement_state(
            "recent-server",
            servers.get("recent-server").unwrap(),
            &HashMap::new(),
            &env.paths,
            60,
        ),
        (true, "oauth_recent_tokens".to_string())
    );
}

#[test]
fn runtime_file_yaml_sources_are_not_checked_from_health_check_container() {
    let env = TestEnv::new("runtime-file-health-container-boundary");
    fs::write(
        &env.paths.mcp_toggles_file,
        r#"{"missing-runtime":true,"disabled-runtime":false}"#,
    )
    .unwrap();
    env.write_server_yaml(
        false,
        "missing-runtime",
        r#"
display_name: Missing Runtime
deployment_type: docker
required_env_vars: []
runtime_files:
  - source: ./missing-runtime-file.yaml
"#,
    );
    env.write_server_yaml(
        false,
        "disabled-runtime",
        r#"
display_name: Disabled Runtime
deployment_type: docker
required_env_vars: []
runtime_files:
  - source: ./missing-runtime-file.yaml
"#,
    );

    let (servers, _) = scan_configured_servers(&env.paths).unwrap();
    let missing = servers.get("missing-runtime").unwrap();
    assert!(missing.is_configured);
    assert_eq!(missing.config_error, None);

    let inspector = MockLogInspector::default();
    let status = health_status_for_missing_server(
        "missing-runtime",
        missing,
        &OAuthStatusPayload::default(),
        &inspector,
    );
    assert_eq!(status["status"], json!("starting"));
    assert_eq!(status["configured"], json!(true));

    let toggles = load_mcp_toggles(&env.paths).unwrap();
    assert_eq!(
        get_server_enablement_state(
            "disabled-runtime",
            servers.get("disabled-runtime").unwrap(),
            &toggles,
            &env.paths,
            60,
        ),
        (false, "explicit_false".to_string())
    );
}

#[test]
fn generated_runtime_file_status_marks_enabled_missing_source_not_configured() {
    let env = TestEnv::new("runtime-file-generated-status");
    fs::write(&env.paths.mcp_toggles_file, r#"{"missing-runtime":true}"#).unwrap();
    env.write_server_yaml(
        false,
        "missing-runtime",
        r#"
display_name: Missing Runtime
deployment_type: docker
required_env_vars: []
runtime_files:
  - source: ./missing-runtime-file.yaml
"#,
    );
    fs::write(
        &env.paths.runtime_file_status_file,
        serde_json::to_vec_pretty(&json!({
            "servers": {
                "missing-runtime": {
                    "configured": false,
                    "status": "not_configured",
                    "error": "Missing runtime file: ./missing-runtime-file.yaml"
                }
            }
        }))
        .unwrap(),
    )
    .unwrap();

    let (servers, _) = scan_configured_servers(&env.paths).unwrap();
    let missing = servers.get("missing-runtime").unwrap();
    assert!(!missing.is_configured);
    assert_eq!(
        missing.config_error.as_deref(),
        Some("Missing runtime file: ./missing-runtime-file.yaml")
    );

    let status = health_status_for_missing_server(
        "missing-runtime",
        missing,
        &OAuthStatusPayload::default(),
        &MockLogInspector::default(),
    );
    assert_eq!(status["status"], json!("not_configured"));
    assert_eq!(status["configured"], json!(false));
    assert_eq!(
        status["error"],
        json!("Missing runtime file: ./missing-runtime-file.yaml")
    );
}

#[test]
fn sensitive_required_env_without_generated_status_stays_configured_boundary() {
    let env = TestEnv::new("sensitive-required-env-status-boundary");
    fs::write(&env.paths.mcp_toggles_file, r#"{"gitlab-mcp":true}"#).unwrap();
    env.write_server_yaml(
        false,
        "gitlab-mcp",
        r#"
display_name: GitLab
deployment_type: docker
required_env_vars:
  - name: GITLAB_PERSONAL_ACCESS_TOKEN
    sensitive: true
"#,
    );

    let (servers, _) = scan_configured_servers(&env.paths).unwrap();
    let metadata = servers.get("gitlab-mcp").unwrap();
    assert!(
        metadata.is_configured,
        "health-check must not infer sensitive required-env configured state from an empty env when generated status is absent"
    );

    let status = health_status_for_missing_server(
        "gitlab-mcp",
        metadata,
        &OAuthStatusPayload::default(),
        &MockLogInspector::default(),
    );
    assert_eq!(status["status"], json!("starting"));
    assert_eq!(status["configured"], json!(true));
}

#[test]
fn generated_server_config_status_still_marks_sensitive_required_env_not_configured() {
    let env = TestEnv::new("sensitive-required-env-generated-status");
    fs::write(&env.paths.mcp_toggles_file, r#"{"sourcegraph":true}"#).unwrap();
    env.write_server_yaml(
        false,
        "sourcegraph",
        r#"
display_name: Sourcegraph
deployment_type: docker
required_env_vars:
  - name: SOURCEGRAPH_TOKEN
    sensitive: true
"#,
    );
    fs::write(
        &env.paths.server_config_status_file,
        serde_json::to_vec_pretty(&json!({
            "servers": {
                "sourcegraph": {
                    "configured": false,
                    "status": "not_configured",
                    "error": "SOURCEGRAPH_TOKEN is missing"
                }
            }
        }))
        .unwrap(),
    )
    .unwrap();

    let (servers, _) = scan_configured_servers(&env.paths).unwrap();
    let metadata = servers.get("sourcegraph").unwrap();
    assert!(!metadata.is_configured);
    assert_eq!(
        metadata.config_error.as_deref(),
        Some("SOURCEGRAPH_TOKEN is missing")
    );
}

#[test]
fn authoritative_server_config_status_overrides_stale_runtime_file_status() {
    let env = TestEnv::new("authoritative-server-status");
    fs::write(&env.paths.mcp_toggles_file, r#"{"runtime-demo":true}"#).unwrap();
    env.write_server_yaml(
        false,
        "runtime-demo",
        r#"
display_name: Runtime Demo
deployment_type: docker
required_env_vars: []
"#,
    );
    fs::write(
        &env.paths.runtime_file_status_file,
        serde_json::to_vec_pretty(&json!({
            "servers": {
                "runtime-demo": {
                    "configured": false,
                    "status": "not_configured",
                    "error": "stale missing runtime file"
                }
            }
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(
        &env.paths.server_config_status_file,
        serde_json::to_vec_pretty(&json!({
            "servers": {
                "runtime-demo": {
                    "configured": true,
                    "status": "configured",
                    "error": ""
                }
            }
        }))
        .unwrap(),
    )
    .unwrap();

    let (servers, _) = scan_configured_servers(&env.paths).unwrap();
    let metadata = servers.get("runtime-demo").unwrap();
    assert!(metadata.is_configured);
    assert_eq!(metadata.config_error, None);
}

#[test]
fn generated_server_config_status_keeps_malformed_user_yaml_visible() {
    let env = TestEnv::new("malformed-user-generated-status");
    fs::write(&env.paths.mcp_toggles_file, r#"{"broken-user":true}"#).unwrap();
    env.write_server_yaml(true, "broken-user", "display_name: [unterminated\n");
    fs::write(
        &env.paths.server_config_status_file,
        serde_json::to_vec_pretty(&json!({
            "servers": {
                "broken-user": {
                    "configured": false,
                    "status": "not_configured",
                    "error": "invalid YAML in broken-user.yaml"
                }
            }
        }))
        .unwrap(),
    )
    .unwrap();

    let (servers, _) = scan_configured_servers(&env.paths).unwrap();
    let metadata = servers.get("broken-user").unwrap();
    assert!(metadata.user_installed);
    assert!(!metadata.is_configured);
    assert_eq!(
        metadata.config_error.as_deref(),
        Some("invalid YAML in broken-user.yaml")
    );
}

#[tokio::test]
async fn discover_and_generate_health_status_cover_oauth_and_container_branches() {
    let env = TestEnv::new("status");
    let core_server = MockServer::start().await;
    let regular_server = MockServer::start().await;
    let host_server = MockServer::start().await;
    let config = base_config(
        HealthCheckMode::Light,
        "http://unused",
        &core_server.base_url,
        &regular_server.base_url,
        &host_server.base_url,
        "session-status",
    );

    queue_summary(
        &core_server,
        vec![
            summary_entry("mcp-assistant", "core", true, true, 1),
            summary_entry("subagents", "core", true, true, 1),
            summary_entry("skills", "core", true, true, 1),
            summary_entry("oauth-no-tools", "core", true, false, 0),
        ],
    );
    queue_summary(
        &regular_server,
        vec![summary_entry("running-timeout", "regular", true, true, 1)],
    );
    regular_server.queue_json(
        "GET",
        "/oauth/status",
        200,
        json!({
            "current": null,
            "active": [{ "server_name": "oauth-no-tools", "state": "active" }],
            "pending": [],
            "checking": [],
            "waiting_callback": [],
            "completed": [{ "server_name": "mcp-assistant" }],
            "failed": [{ "server_name": "missing-docker-failed", "error_message": "boom" }],
            "timeout": [{ "server_name": "running-timeout", "error_message": "late" }],
        }),
    );
    core_server.queue_json(
        "GET",
        "/oauth/status",
        200,
        json!({
            "current": { "server_name": "missing-needs-auth", "state": "waiting_callback" },
            "active": [],
            "pending": [{ "server_name": "missing-pending" }],
            "checking": [],
            "waiting_callback": [],
            "completed": [],
            "failed": [],
            "timeout": [],
        }),
    );

    let (core_tools, regular_tools, servers_without_tools) =
        discover_mcp_servers(&Client::new(), &config, &fast_retries(), false)
            .await
            .unwrap();
    assert_eq!(core_tools.len(), 3);
    assert_eq!(regular_tools.len(), 1);
    assert!(servers_without_tools.contains("oauth-no-tools"));

    env.write_server_yaml(
        false,
        "mcp-assistant",
        "display_name: Assistant\ndeployment_type: docker\nis_core: true\n",
    );
    env.write_server_yaml(
        false,
        "subagents",
        "display_name: Subagents\ndeployment_type: docker\nis_core: true\n",
    );
    env.write_server_yaml(
        false,
        "skills",
        "display_name: Skills\ndeployment_type: docker\nis_core: true\n",
    );
    env.write_server_yaml(
        false,
        "oauth-no-tools",
        "display_name: OAuth\ndeployment_type: docker\n",
    );
    env.write_server_yaml(
        false,
        "running-timeout",
        "display_name: Timeout\ndeployment_type: docker\n",
    );
    env.write_server_yaml(
        false,
        "disabled-server",
        "display_name: Disabled\ndeployment_type: docker\n",
    );
    env.write_server_yaml(
        false,
        "missing-needs-auth",
        "display_name: NeedsAuth\ndeployment_type: docker\n",
    );
    env.write_server_yaml(
        false,
        "missing-not-configured",
        "display_name: MissingConfig\ndeployment_type: docker\nrequired_env_vars:\n  - MISSING\n",
    );
    env.write_server_yaml(
        false,
        "missing-docker-failed",
        "display_name: DockerFail\ndeployment_type: docker\n",
    );
    env.write_server_yaml(
        false,
        "missing-docker-starting",
        "display_name: DockerStart\ndeployment_type: docker\n",
    );
    fs::write(
        &env.paths.mcp_toggles_file,
        r#"{"disabled-server":false,"oauth-no-tools":true,"running-timeout":true,"missing-needs-auth":true,"missing-not-configured":true,"missing-docker-failed":true,"missing-docker-starting":true}"#,
    )
    .unwrap();
    let (servers, ignored) = scan_configured_servers(&env.paths).unwrap();
    let toggles = load_mcp_toggles(&env.paths).unwrap();
    let inspector = Arc::new(MockLogInspector::default());
    inspector.set_failure("mcpo-missing-docker-failed", true);
    inspector.set_failure("mcpo-missing-docker-starting", false);

    let tool_host_map = {
        let mut map = core_tools.clone();
        map.extend(regular_tools.clone());
        map
    };
    assert!(generate_health_status(
        &env.paths,
        &config,
        &servers,
        &toggles,
        &tool_host_map,
        &servers_without_tools,
        &BTreeMap::new(),
        &BTreeSet::new(),
        &ignored,
        inspector.as_ref(),
        &Client::new(),
    )
    .await
    .unwrap());

    let payload: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(env.paths.health_status_dir.join("health_status.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        payload["servers"]["disabled-server"]["status"],
        json!("disabled")
    );
    assert_eq!(
        payload["servers"]["oauth-no-tools"]["status"],
        json!("needs_oauth")
    );
    assert_eq!(
        payload["servers"]["running-timeout"]["status"],
        json!("timeout")
    );
    assert_eq!(
        payload["servers"]["missing-needs-auth"]["status"],
        json!("needs_oauth")
    );
    assert_eq!(
        payload["servers"]["missing-not-configured"]["status"],
        json!("not_configured")
    );
    assert_eq!(
        payload["servers"]["missing-docker-failed"]["status"],
        json!("failed")
    );
    assert_eq!(
        payload["servers"]["missing-docker-starting"]["status"],
        json!("starting")
    );
    assert_eq!(payload["servers"]["mcp-assistant"]["is_core"], json!(true));
    assert_eq!(
        payload["servers"]["missing-docker-failed"]["is_core"],
        json!(false)
    );
    assert_eq!(payload["summary"]["disabled"], json!(1));
    assert_eq!(
        payload["sync_diagnostics"]["health_sync_run_id"],
        json!("run-session-status")
    );
    assert_eq!(
        payload["sync_diagnostics"]["health_check_mode"],
        json!("light")
    );
    assert_eq!(
        payload["sync_diagnostics"]["configured_core_server_ids"],
        json!(["mcp-assistant", "skills", "subagents"])
    );
    assert_eq!(payload["sync_diagnostics"]["preserved_servers"], json!(0));
    assert_eq!(
        payload["sync_diagnostics"]["preserved_server_ids"],
        json!([])
    );
}

#[tokio::test]
async fn status_probe_marks_summary_missing_configured_server_healthy() {
    let env = TestEnv::new("status-probe-healthy");
    let core_server = MockServer::start().await;
    let regular_server = MockServer::start().await;
    let host_server = MockServer::start().await;
    let config = base_config(
        HealthCheckMode::Light,
        "http://unused",
        &core_server.base_url,
        &regular_server.base_url,
        &host_server.base_url,
        "session-status-probe",
    );

    queue_summary(
        &core_server,
        vec![
            summary_entry("mcp-assistant", "core", true, true, 1),
            summary_entry("subagents", "core", true, true, 1),
            summary_entry("skills", "core", true, true, 1),
        ],
    );
    queue_summary(&regular_server, vec![]);
    regular_server.queue_json(
        "GET",
        "/servers/gitlab-mcp/status",
        200,
        json!({
            "server_id": "gitlab-mcp",
            "status": "healthy",
            "readiness_phase": "tool_ready",
            "healthy": true,
            "tools_count": 97,
            "total_paths": 97,
        }),
    );
    queue_empty_oauth_status(&regular_server);
    queue_empty_oauth_status(&core_server);

    let (mut core_tools, mut regular_tools, mut servers_without_tools) =
        discover_mcp_servers(&Client::new(), &config, &fast_retries(), false)
            .await
            .unwrap();
    assert!(!regular_tools.contains_key("gitlab-mcp"));

    env.write_server_yaml(
        false,
        "gitlab-mcp",
        "display_name: GitLab\ndeployment_type: docker\n",
    );
    fs::write(&env.paths.mcp_toggles_file, r#"{"gitlab-mcp":true}"#).unwrap();
    let (servers, ignored) = scan_configured_servers(&env.paths).unwrap();
    let toggles = load_mcp_toggles(&env.paths).unwrap();
    let mut status_probe_details = BTreeMap::new();

    reconcile_missing_configured_servers_from_status(
        &Client::new(),
        &config,
        &fast_retries(),
        &servers,
        &toggles,
        &env.paths,
        &mut core_tools,
        &mut regular_tools,
        &mut servers_without_tools,
        &mut status_probe_details,
    )
    .await
    .unwrap();

    assert_eq!(
        regular_tools.get("gitlab-mcp"),
        Some(&DiscoveredTool {
            host: "regular-mcpo".to_string(),
            port: "8765".to_string(),
        })
    );

    let tool_host_map = {
        let mut map = core_tools.clone();
        map.extend(regular_tools.clone());
        map
    };
    let inspector = MockLogInspector::default();
    assert!(generate_health_status(
        &env.paths,
        &config,
        &servers,
        &toggles,
        &tool_host_map,
        &servers_without_tools,
        &status_probe_details,
        &BTreeSet::new(),
        &ignored,
        &inspector,
        &Client::new(),
    )
    .await
    .unwrap());

    let payload: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(env.paths.health_status_dir.join("health_status.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(payload["servers"]["gitlab-mcp"]["status"], json!("healthy"));
    assert_eq!(
        payload["servers"]["gitlab-mcp"]["host"],
        json!("regular-mcpo")
    );
    assert_eq!(payload["servers"]["gitlab-mcp"]["port"], json!("8765"));
}

#[tokio::test]
async fn status_probe_surfaces_host_runtime_error_without_not_running_message() {
    let env = TestEnv::new("status-probe-host-error");
    let core_server = MockServer::start().await;
    let regular_server = MockServer::start().await;
    let host_server = MockServer::start().await;
    let config = base_config(
        HealthCheckMode::Light,
        "http://unused",
        &core_server.base_url,
        &regular_server.base_url,
        &host_server.base_url,
        "session-status-probe-host-error",
    );

    host_server.queue_json(
        "GET",
        "/servers/chrome-devtools/status",
        200,
        json!({
            "server_id": "chrome-devtools",
            "status": "failed",
            "readiness_phase": "failed",
            "healthy": false,
            "tools_count": 0,
            "error": "failed to connect stdio server 'chrome-devtools'",
        }),
    );
    queue_empty_oauth_status(&regular_server);
    queue_empty_oauth_status(&core_server);

    env.write_server_yaml(
        false,
        "chrome-devtools",
        "display_name: Chrome DevTools\ndeployment_type: host\n",
    );
    fs::write(&env.paths.mcp_toggles_file, r#"{"chrome-devtools":true}"#).unwrap();
    let (servers, ignored) = scan_configured_servers(&env.paths).unwrap();
    let toggles = load_mcp_toggles(&env.paths).unwrap();
    let mut core_tools = BTreeMap::new();
    let mut regular_tools = BTreeMap::new();
    let mut servers_without_tools = BTreeSet::new();
    let mut status_probe_details = BTreeMap::new();

    reconcile_missing_configured_servers_from_status(
        &Client::new(),
        &config,
        &fast_retries(),
        &servers,
        &toggles,
        &env.paths,
        &mut core_tools,
        &mut regular_tools,
        &mut servers_without_tools,
        &mut status_probe_details,
    )
    .await
    .unwrap();

    assert!(status_probe_details.contains_key("chrome-devtools"));
    let inspector = MockLogInspector::default();
    assert!(generate_health_status(
        &env.paths,
        &config,
        &servers,
        &toggles,
        &BTreeMap::new(),
        &servers_without_tools,
        &status_probe_details,
        &BTreeSet::new(),
        &ignored,
        &inspector,
        &Client::new(),
    )
    .await
    .unwrap());

    let payload: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(env.paths.health_status_dir.join("health_status.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        payload["servers"]["chrome-devtools"]["status"],
        json!("failed")
    );
    assert_eq!(
        payload["servers"]["chrome-devtools"]["error"],
        json!("failed to connect stdio server 'chrome-devtools'")
    );
    assert_ne!(
        payload["servers"]["chrome-devtools"]["error"],
        json!("Host MCP server is not running - check Host MCPO logs for startup errors")
    );
}

#[tokio::test]
async fn status_probe_failures_do_not_block_other_missing_servers() {
    let env = TestEnv::new("status-probe-partial");
    let core_server = MockServer::start().await;
    let regular_server = MockServer::start().await;
    let host_server = MockServer::start().await;
    let config = base_config(
        HealthCheckMode::Light,
        "http://unused",
        &core_server.base_url,
        &regular_server.base_url,
        &host_server.base_url,
        "session-status-probe-partial",
    );

    queue_summary(
        &core_server,
        vec![
            summary_entry("mcp-assistant", "core", true, true, 1),
            summary_entry("subagents", "core", true, true, 1),
            summary_entry("skills", "core", true, true, 1),
        ],
    );
    queue_summary(&regular_server, vec![]);
    regular_server.queue_json(
        "GET",
        "/servers/slack/status",
        200,
        json!({
            "server_id": "slack",
            "status": "healthy",
            "readiness_phase": "tool_ready",
            "healthy": true,
            "tools_count": 5,
            "total_paths": 5,
        }),
    );
    regular_server.queue_text(
        "GET",
        "/servers/gitlab-mcp/status",
        500,
        "boom",
        "text/plain",
    );
    queue_empty_oauth_status(&regular_server);
    queue_empty_oauth_status(&core_server);

    let (mut core_tools, mut regular_tools, mut servers_without_tools) =
        discover_mcp_servers(&Client::new(), &config, &fast_retries(), false)
            .await
            .unwrap();
    for server_id in ["slack", "gitlab-mcp"] {
        env.write_server_yaml(
            false,
            server_id,
            &format!("display_name: {server_id}\ndeployment_type: docker\n"),
        );
    }
    fs::write(
        &env.paths.mcp_toggles_file,
        r#"{"slack":true,"gitlab-mcp":true}"#,
    )
    .unwrap();
    let (servers, ignored) = scan_configured_servers(&env.paths).unwrap();
    let toggles = load_mcp_toggles(&env.paths).unwrap();
    let mut status_probe_details = BTreeMap::new();

    reconcile_missing_configured_servers_from_status(
        &Client::new(),
        &config,
        &fast_retries(),
        &servers,
        &toggles,
        &env.paths,
        &mut core_tools,
        &mut regular_tools,
        &mut servers_without_tools,
        &mut status_probe_details,
    )
    .await
    .unwrap();

    assert!(regular_tools.contains_key("slack"));
    assert!(!regular_tools.contains_key("gitlab-mcp"));

    let tool_host_map = {
        let mut map = core_tools.clone();
        map.extend(regular_tools.clone());
        map
    };
    let inspector = MockLogInspector::default();
    assert!(generate_health_status(
        &env.paths,
        &config,
        &servers,
        &toggles,
        &tool_host_map,
        &servers_without_tools,
        &status_probe_details,
        &BTreeSet::new(),
        &ignored,
        &inspector,
        &Client::new(),
    )
    .await
    .unwrap());

    let payload: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(env.paths.health_status_dir.join("health_status.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(payload["servers"]["slack"]["status"], json!("healthy"));
    assert_eq!(
        payload["servers"]["gitlab-mcp"]["status"],
        json!("starting")
    );
}

#[tokio::test]
async fn generate_health_status_returns_false_on_write_failure() {
    let env = TestEnv::new("status-write-failure");
    let core_server = MockServer::start().await;
    let regular_server = MockServer::start().await;
    let host_server = MockServer::start().await;
    let config = base_config(
        HealthCheckMode::Light,
        "http://unused",
        &core_server.base_url,
        &regular_server.base_url,
        &host_server.base_url,
        "session-write-failure",
    );
    regular_server.queue_json(
        "GET",
        "/oauth/status",
        200,
        json!({
            "current": null,
            "active": [],
            "pending": [],
            "checking": [],
            "waiting_callback": [],
            "completed": [],
            "failed": [],
            "timeout": [],
        }),
    );
    core_server.queue_json(
        "GET",
        "/oauth/status",
        200,
        json!({
            "current": null,
            "active": [],
            "pending": [],
            "checking": [],
            "waiting_callback": [],
            "completed": [],
            "failed": [],
            "timeout": [],
        }),
    );

    let blocked_path = env.paths.app_root.join("blocked-health-status");
    fs::write(&blocked_path, "file").unwrap();
    let mut broken_paths = env.paths.clone();
    broken_paths.health_status_dir = blocked_path;

    assert!(!generate_health_status(
        &broken_paths,
        &config,
        &BTreeMap::new(),
        &HashMap::new(),
        &BTreeMap::new(),
        &BTreeSet::new(),
        &BTreeMap::new(),
        &BTreeSet::new(),
        &[],
        &MockLogInspector::default(),
        &Client::new(),
    )
    .await
    .unwrap());
}

#[tokio::test]
async fn discover_mcp_servers_retries_http_and_parse_failures() {
    let core_server = MockServer::start().await;
    let regular_server = MockServer::start().await;
    let config = base_config(
        HealthCheckMode::Full,
        "http://unused",
        &core_server.base_url,
        &regular_server.base_url,
        "http://unused-host",
        "session-discovery-retry",
    );

    core_server.queue_text("GET", "/servers/summary", 500, "boom", "text/plain");
    core_server.queue_text("GET", "/servers/summary", 200, "{", "application/json");
    queue_summary(
        &core_server,
        vec![summary_entry("mcp-assistant", "core", true, true, 1)],
    );
    queue_summary(&regular_server, Vec::new());

    let retries = RetryConfig {
        discovery_retries: 3,
        discovery_delay: Duration::ZERO,
        ..fast_retries()
    };
    let (core_tools, regular_tools, servers_without_tools) =
        discover_mcp_servers(&Client::new(), &config, &retries, false)
            .await
            .unwrap();
    assert!(core_tools.contains_key("mcp-assistant"));
    assert!(regular_tools.is_empty());
    assert!(servers_without_tools.is_empty());
    assert_eq!(
        core_server
            .requests()
            .into_iter()
            .filter(|request| request.path == "/servers/summary")
            .count(),
        3
    );
}

#[tokio::test]
async fn discover_mcp_servers_can_extract_server_ids_from_root_paths() {
    let core_server = MockServer::start().await;
    let regular_server = MockServer::start().await;
    let host_server = MockServer::start().await;
    let config = base_config(
        HealthCheckMode::Light,
        "http://unused",
        &core_server.base_url,
        &regular_server.base_url,
        &host_server.base_url,
        "session-path-discovery",
    );

    queue_summary(
        &core_server,
        vec![summary_entry("mcp-assistant", "core", true, true, 1)],
    );
    queue_summary(
        &regular_server,
        vec![summary_entry("time", "regular", true, true, 1)],
    );

    host_server.queue_json(
        "GET",
        "/openapi.json",
        200,
        json!({
            "info": { "description": "" },
            "paths": {
                "/chrome-devtools/docs": {},
                "/servers": {}
            }
        }),
    );
    host_server.queue_json(
        "GET",
        "/chrome-devtools/openapi.json",
        200,
        json!({ "paths": { "/tool": {} } }),
    );

    let (core_tools, regular_tools, servers_without_tools) =
        discover_mcp_servers(&Client::new(), &config, &fast_retries(), true)
            .await
            .unwrap();

    assert!(servers_without_tools.is_empty());
    assert!(core_tools.contains_key("mcp-assistant"));
    assert!(regular_tools.contains_key("time"));
    assert!(regular_tools.contains_key("chrome-devtools"));
    assert_eq!(regular_tools["chrome-devtools"].host, config.host_mcpo_host);
}

#[tokio::test]
async fn discover_mcp_servers_prefers_summary_for_core_and_regular_hosts() {
    let core_server = MockServer::start().await;
    let regular_server = MockServer::start().await;
    let config = base_config(
        HealthCheckMode::Light,
        "http://unused",
        &core_server.base_url,
        &regular_server.base_url,
        "http://unused-host",
        "session-summary-discovery",
    );

    core_server.queue_json(
        "GET",
        "/servers/summary",
        200,
        json!({
            "servers": [
                {
                    "id": "mcp-assistant",
                    "host_group": "core",
                    "reachable": true,
                    "has_tools": true,
                    "tools_count": 1,
                },
                {
                    "id": "skills",
                    "host_group": "core",
                    "reachable": false,
                    "has_tools": false,
                    "tools_count": 0,
                }
            ],
            "oauth_status": {
                "current": null,
                "active": [],
                "pending": [],
                "checking": [],
                "waiting_callback": [],
                "completed": [],
                "failed": [],
                "timeout": []
            }
        }),
    );
    regular_server.queue_json(
        "GET",
        "/servers/summary",
        200,
        json!({
            "servers": [
                {
                    "id": "time",
                    "host_group": "regular",
                    "reachable": true,
                    "has_tools": true,
                    "tools_count": 1,
                },
                {
                    "id": "oauth-no-tools",
                    "host_group": "regular",
                    "reachable": true,
                    "has_tools": false,
                    "tools_count": 0,
                }
            ],
            "oauth_status": {
                "current": null,
                "active": [],
                "pending": [],
                "checking": [],
                "waiting_callback": [],
                "completed": [],
                "failed": [],
                "timeout": []
            }
        }),
    );

    let (core_tools, regular_tools, servers_without_tools) =
        discover_mcp_servers(&Client::new(), &config, &fast_retries(), false)
            .await
            .unwrap();

    assert!(core_tools.contains_key("mcp-assistant"));
    assert!(regular_tools.contains_key("time"));
    assert!(servers_without_tools.contains("oauth-no-tools"));
    assert!(core_server
        .requests()
        .iter()
        .any(|request| request.path == "/servers/summary"));
    assert!(regular_server
        .requests()
        .iter()
        .any(|request| request.path == "/servers/summary"));
    assert!(!core_server
        .requests()
        .iter()
        .any(|request| request.path == "/openapi.json"));
    assert!(!regular_server
        .requests()
        .iter()
        .any(|request| request.path == "/openapi.json"));
    assert!(!core_server
        .requests()
        .iter()
        .any(|request| request.path == "/mcp-assistant/openapi.json"));
    assert!(!regular_server
        .requests()
        .iter()
        .any(|request| request.path == "/time/openapi.json"));
}

#[tokio::test]
async fn discover_mcp_servers_falls_back_to_root_openapi_when_summary_is_missing() {
    let core_server = MockServer::start().await;
    let regular_server = MockServer::start().await;
    let config = base_config(
        HealthCheckMode::Light,
        "http://unused",
        &core_server.base_url,
        &regular_server.base_url,
        "http://unused-host",
        "session-summary-fallback",
    );

    core_server.queue_json(
        "GET",
        "/openapi.json",
        200,
        json!({ "info": { "description": "[mcp-assistant]" } }),
    );
    core_server.queue_json(
        "GET",
        "/mcp-assistant/openapi.json",
        200,
        json!({ "paths": { "/tool": {} } }),
    );
    regular_server.queue_json(
        "GET",
        "/openapi.json",
        200,
        json!({ "info": { "description": "[time]" } }),
    );
    regular_server.queue_json(
        "GET",
        "/time/openapi.json",
        200,
        json!({ "paths": { "/tool": {} } }),
    );

    let (core_tools, regular_tools, servers_without_tools) =
        discover_mcp_servers(&Client::new(), &config, &fast_retries(), false)
            .await
            .unwrap();

    assert!(servers_without_tools.is_empty());
    assert!(core_tools.contains_key("mcp-assistant"));
    assert!(regular_tools.contains_key("time"));
    assert!(core_server
        .requests()
        .iter()
        .any(|request| request.path == "/servers/summary"));
    assert!(regular_server
        .requests()
        .iter()
        .any(|request| request.path == "/servers/summary"));
    assert!(core_server
        .requests()
        .iter()
        .any(|request| request.path == "/openapi.json"));
    assert!(regular_server
        .requests()
        .iter()
        .any(|request| request.path == "/openapi.json"));
}

#[tokio::test]
async fn validate_server_has_tools_returns_inconclusive_for_unreachable_route() {
    let regular_server = MockServer::start().await;
    let config = base_config(
        HealthCheckMode::Full,
        "http://openwebui.invalid",
        "http://core.invalid",
        &regular_server.base_url,
        "http://host.invalid",
        "session",
    );

    regular_server.queue_json(
        "GET",
        "/glean/openapi.json",
        404,
        json!({ "error": "not found" }),
    );

    let (has_tools, tool_count) =
        validate_server_has_tools(&Client::new(), &config, &config.mcpo_regular_host, "glean")
            .await
            .unwrap();

    assert_eq!(has_tools, None);
    assert_eq!(tool_count, 0);
}

#[tokio::test]
async fn discover_mcp_servers_uses_aggressive_light_mode_retry_budget() {
    let core_server = MockServer::start().await;
    let regular_server = MockServer::start().await;
    let host_server = MockServer::start().await;
    let config = base_config(
        HealthCheckMode::Light,
        "http://unused",
        &core_server.base_url,
        &regular_server.base_url,
        &host_server.base_url,
        "session-light-budget",
    );

    for _ in 0..4 {
        core_server.queue_text("GET", "/servers/summary", 500, "boom", "text/plain");
        regular_server.queue_text("GET", "/servers/summary", 500, "boom", "text/plain");
        host_server.queue_text("GET", "/openapi.json", 500, "boom", "text/plain");
    }

    let (core_tools, regular_tools, servers_without_tools) =
        discover_mcp_servers(&Client::new(), &config, &RetryConfig::default(), true)
            .await
            .unwrap();

    assert!(core_tools.is_empty());
    assert!(regular_tools.is_empty());
    assert!(servers_without_tools.is_empty());
    assert_eq!(
        core_server
            .requests()
            .into_iter()
            .filter(|request| request.path == "/servers/summary")
            .count(),
        2
    );
    assert_eq!(
        regular_server
            .requests()
            .into_iter()
            .filter(|request| request.path == "/servers/summary")
            .count(),
        1
    );
    assert_eq!(
        host_server
            .requests()
            .into_iter()
            .filter(|request| request.path == "/openapi.json")
            .count(),
        1
    );
}

#[tokio::test]
async fn filter_reconciliation_deletes_stale_repairs_flags_creates_missing_and_skips_healthy() {
    let env = TestEnv::new("filters");
    env.write_filter(
        "unified_context",
        "\"\"\"\ndescription: Unified Context\n\"\"\"\n# comment\nprint('alpha')\n",
    );
    env.write_filter(
        "beta",
        "\"\"\"\ndescription: Beta filter\n\"\"\"\nprint('beta')\n",
    );
    env.write_filter(
        "gamma",
        "\"\"\"\ndescription: Gamma filter\n\"\"\"\nprint('gamma')\n",
    );
    env.write_valves("unified_context", json!({ "enabled": true }));

    let openwebui = MockServer::start().await;
    let client = OpenWebUiClient::new(Client::new(), &openwebui.base_url, Duration::from_secs(5));
    openwebui.queue_json(
        "GET",
        "/api/v1/functions/",
        200,
        json!([
            { "id": "portico_core_legacy" },
            { "id": "portico_core_unified_context" },
            { "id": "portico_core_gamma" }
        ]),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/portico/managed-functions/id/portico_core_unified_context",
        200,
        json!({
            "id": "portico_core_unified_context",
            "name": "portico_core_unified_context",
            "type": "filter",
            "content": "print('formatted')",
            "meta": { "description": "Unified Context" },
            "valves": { "enabled": true },
            "is_active": false,
            "is_global": false
        }),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/portico/managed-functions/id/portico_core_gamma",
        200,
        json!({
            "id": "portico_core_gamma",
            "name": "portico_core_gamma",
            "type": "filter",
            "content": "print('gamma')",
            "meta": { "description": "Gamma filter" },
            "valves": null,
            "is_active": true,
            "is_global": true
        }),
    );
    for code in ["print('formatted')", "print('gamma')", "print('formatted')"] {
        openwebui.queue_json(
            "POST",
            "/api/v1/utils/code/format",
            200,
            json!({ "code": code }),
        );
    }
    openwebui.queue_json(
        "DELETE",
        "/api/v1/functions/id/portico_core_legacy/delete",
        200,
        json!(true),
    );
    openwebui.queue_json(
        "PUT",
        "/api/v1/portico/managed-functions/id/portico_core_unified_context",
        200,
        json!({
            "id": "portico_core_unified_context",
            "name": "portico_core_unified_context",
            "type": "filter",
            "content": "print('formatted')",
            "meta": { "description": "Unified Context" },
            "valves": { "enabled": true },
            "is_active": true,
            "is_global": true
        }),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/portico/managed-functions/id/portico_core_unified_context",
        200,
        json!({
            "id": "portico_core_unified_context",
            "name": "portico_core_unified_context",
            "type": "filter",
            "content": "print('formatted')",
            "meta": { "description": "Unified Context" },
            "valves": { "enabled": true },
            "is_active": true,
            "is_global": true
        }),
    );
    openwebui.queue_json(
        "PUT",
        "/api/v1/portico/managed-functions/id/portico_core_beta",
        200,
        json!({
            "id": "portico_core_beta",
            "name": "portico_core_beta",
            "type": "filter",
            "content": "print('formatted')",
            "meta": { "description": "Beta filter" },
            "valves": null,
            "is_active": true,
            "is_global": true
        }),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/functions/",
        200,
        json!([
            { "id": "portico_core_unified_context" },
            { "id": "portico_core_beta" },
            { "id": "portico_core_gamma" }
        ]),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/portico/managed-functions/id/portico_core_beta",
        200,
        json!({
            "id": "portico_core_beta",
            "name": "portico_core_beta",
            "type": "filter",
            "content": "print('formatted')",
            "meta": { "description": "Beta filter" },
            "valves": null,
            "is_active": true,
            "is_global": true
        }),
    );

    assert!(install_all_filters(&env.paths, &client).await.unwrap());
    let requests = openwebui.requests();
    assert!(requests
        .iter()
        .any(|request| request.path == "/api/v1/functions/id/portico_core_legacy/delete"));
    let upserts = requests
        .iter()
        .filter(|request| {
            request.method == "PUT"
                && request
                    .path
                    .starts_with("/api/v1/portico/managed-functions/id/")
        })
        .collect::<Vec<_>>();
    assert_eq!(upserts.len(), 2);
    assert!(upserts.iter().all(|request| {
        request.method == "PUT"
            && request.body.contains("\"is_active\":true")
            && request.body.contains("\"is_global\":true")
    }));
    assert!(upserts
        .iter()
        .any(|request| request.path.ends_with("/portico_core_unified_context")));
    assert!(upserts
        .iter()
        .any(|request| request.path.ends_with("/portico_core_beta")));
    assert!(requests.iter().all(|request| {
        request.path != "/api/v1/functions/create"
            && !request.path.ends_with("/toggle")
            && !request.path.ends_with("/toggle/global")
            && request.path != "/api/v1/functions/id/portico_core_unified_context/delete"
    }));
}

#[tokio::test]
async fn filter_reconciliation_fails_closed_when_list_or_read_is_unknown() {
    let env = TestEnv::new("filters-observation-failures");
    env.write_filter(
        "unified_context",
        "\"\"\"description: Unified Context\"\"\"\nprint('alpha')\n",
    );

    let list_failure_server = MockServer::start().await;
    list_failure_server.queue_text("GET", "/api/v1/functions/", 500, "boom", "text/plain");
    let list_failure_client = OpenWebUiClient::new(
        Client::new(),
        &list_failure_server.base_url,
        Duration::from_secs(1),
    );
    assert!(install_all_filters(&env.paths, &list_failure_client)
        .await
        .is_err());
    assert_eq!(list_failure_server.requests().len(), 1);

    let read_failure_server = MockServer::start().await;
    read_failure_server.queue_json(
        "GET",
        "/api/v1/functions/",
        200,
        json!([
            { "id": "portico_core_unified_context" },
            { "id": "portico_core_stale" }
        ]),
    );
    read_failure_server.queue_text(
        "GET",
        "/api/v1/portico/managed-functions/id/portico_core_unified_context",
        500,
        "boom",
        "text/plain",
    );
    let read_failure_client = OpenWebUiClient::new(
        Client::new(),
        &read_failure_server.base_url,
        Duration::from_secs(1),
    );
    assert!(install_all_filters(&env.paths, &read_failure_client)
        .await
        .is_err());
    assert!(read_failure_server
        .requests()
        .iter()
        .all(|request| request.method == "GET" && !request.path.contains("/delete")));

    let formatter_failure_server = MockServer::start().await;
    formatter_failure_server.queue_json(
        "GET",
        "/api/v1/functions/",
        200,
        json!([{ "id": "portico_core_stale" }]),
    );
    formatter_failure_server.queue_json("POST", "/api/v1/utils/code/format", 200, json!({}));
    let formatter_failure_client = OpenWebUiClient::new(
        Client::new(),
        &formatter_failure_server.base_url,
        Duration::from_secs(1),
    );
    assert!(install_all_filters(&env.paths, &formatter_failure_client)
        .await
        .is_err());
    assert!(formatter_failure_server
        .requests()
        .iter()
        .all(|request| request.method != "DELETE" && request.method != "PUT"));
}

#[tokio::test]
async fn filter_reconciliation_rejects_incomplete_upsert_readback() {
    let env = TestEnv::new("filter-incomplete-readback");
    env.write_filter(
        "unified_context",
        "\"\"\"description: Unified Context\"\"\"\nprint('alpha')\n",
    );
    let openwebui = MockServer::start().await;
    openwebui.queue_json(
        "GET",
        "/api/v1/functions/",
        200,
        json!([{ "id": "portico_core_stale" }]),
    );
    openwebui.queue_json(
        "POST",
        "/api/v1/utils/code/format",
        200,
        json!({ "code": "print('alpha')" }),
    );
    openwebui.queue_json(
        "PUT",
        "/api/v1/portico/managed-functions/id/portico_core_unified_context",
        200,
        json!({ "ok": true }),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/portico/managed-functions/id/portico_core_unified_context",
        200,
        json!({
            "id": "portico_core_unified_context",
            "name": "portico_core_unified_context",
            "type": "filter",
            "content": "print('alpha')",
            "valves": null,
            "is_active": false,
            "is_global": true
        }),
    );
    let client = OpenWebUiClient::new(Client::new(), &openwebui.base_url, Duration::from_secs(1));

    assert!(!install_all_filters(&env.paths, &client).await.unwrap());
    assert_eq!(
        openwebui
            .requests()
            .iter()
            .filter(|request| request.method == "PUT")
            .count(),
        1
    );
    assert!(openwebui
        .requests()
        .iter()
        .all(|request| request.method != "DELETE"));
}

#[tokio::test]
async fn filter_reconciliation_accepts_ambiguous_put_only_after_canonical_readback() {
    let env = TestEnv::new("filter-ambiguous-put");
    env.write_filter(
        "unified_context",
        "\"\"\"\ndescription: Unified Context\n\"\"\"\nprint('alpha')\n",
    );
    let openwebui = MockServer::start().await;
    openwebui.queue_json("GET", "/api/v1/functions/", 200, json!([]));
    openwebui.queue_json(
        "POST",
        "/api/v1/utils/code/format",
        200,
        json!({ "code": "print('alpha')" }),
    );
    openwebui.queue_text(
        "PUT",
        "/api/v1/portico/managed-functions/id/portico_core_unified_context",
        500,
        "response failed after commit",
        "text/plain",
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/portico/managed-functions/id/portico_core_unified_context",
        200,
        json!({
            "id": "portico_core_unified_context",
            "name": "portico_core_unified_context",
            "type": "filter",
            "content": "print('alpha')",
            "meta": { "description": "Unified Context" },
            "valves": null,
            "is_active": true,
            "is_global": true
        }),
    );
    let client = OpenWebUiClient::new(Client::new(), &openwebui.base_url, Duration::from_secs(1));

    assert!(install_all_filters(&env.paths, &client).await.unwrap());
    assert_eq!(
        openwebui
            .requests()
            .iter()
            .filter(|request| request.method == "PUT")
            .count(),
        1
    );
}

#[tokio::test]
async fn filter_reconciliation_rejects_failed_stale_deletion_after_inventory_readback() {
    let env = TestEnv::new("filter-failed-stale-deletion");
    env.write_filter(
        "unified_context",
        "\"\"\"\ndescription: Unified Context\n\"\"\"\nprint('ctx')\n",
    );
    let openwebui = MockServer::start().await;
    openwebui.queue_json(
        "GET",
        "/api/v1/functions/",
        200,
        json!([
            { "id": "portico_core_unified_context" },
            { "id": "portico_core_stale" }
        ]),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/portico/managed-functions/id/portico_core_unified_context",
        200,
        json!({
            "id": "portico_core_unified_context",
            "name": "portico_core_unified_context",
            "type": "filter",
            "content": "print('ctx')",
            "meta": { "description": "Unified Context" },
            "valves": null,
            "is_active": true,
            "is_global": true
        }),
    );
    openwebui.queue_json(
        "POST",
        "/api/v1/utils/code/format",
        200,
        json!({ "code": "print('ctx')" }),
    );
    openwebui.queue_json(
        "DELETE",
        "/api/v1/functions/id/portico_core_stale/delete",
        200,
        json!(false),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/functions/",
        200,
        json!([
            { "id": "portico_core_unified_context" },
            { "id": "portico_core_stale" }
        ]),
    );
    let client = OpenWebUiClient::new(Client::new(), &openwebui.base_url, Duration::from_secs(1));

    assert!(!install_all_filters(&env.paths, &client).await.unwrap());
    assert_eq!(
        openwebui
            .requests()
            .iter()
            .filter(|request| request.path == "/api/v1/functions/")
            .count(),
        2
    );
}

#[tokio::test]
async fn agent_and_model_helpers_cover_tool_modes_prompt_updates_and_delete_fallbacks() {
    let env = TestEnv::new("agents");
    env.write_base_system_prompt("base prompt");
    env.write_agent(
        "existing",
        r#"
name: "Existing"
base_model_id: "Claude Sonnet 4.5"
description: "update me"
tools_mode: "core"
hidden: true
"#,
        "system existing",
    );
    env.write_agent(
        "new-all",
        r#"
name: "New All"
base_model_id: "Claude Sonnet 4.5"
description: "new all"
tools_mode: "all"
"#,
        "system all",
    );
    env.write_agent(
        "new-specific",
        r#"
name: "New Specific"
base_model_id: "Claude Sonnet 4.5"
description: "new specific"
tools_mode: "specific"
tools_list:
  - server:time
"#,
        "system specific",
    );
    env.write_agent(
        "new-none",
        r#"
name: "New None"
base_model_id: "Claude Sonnet 4.5"
description: "new none"
tools_mode: "none"
"#,
        "system none",
    );

    let openwebui = MockServer::start().await;
    let client = OpenWebUiClient::new(
        Client::new(),
        &openwebui.base_url,
        std::time::Duration::from_secs(5),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=portico_agent_existing",
        200,
        json!({
            "id": "portico_agent_existing",
            "name": "Existing",
            "base_model_id": "Claude Sonnet 3.5",
            "meta": { "toolIds": [] },
            "params": {}
        }),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=portico_agent_existing",
        200,
        json!({
            "id": "portico_agent_existing",
            "name": "Existing",
            "base_model_id": "Claude Sonnet 3.5",
            "meta": { "toolIds": [] },
            "params": {}
        }),
    );
    openwebui.queue_json("GET", "/api/v1/auths/", 200, json!({ "id": "user-1" }));
    openwebui.queue_json("GET", "/api/v1/auths/", 200, json!({ "id": "user-1" }));
    openwebui.queue_text(
        "POST",
        "/api/v1/models/model/update?id=portico_agent_existing",
        200,
        "ok",
        "text/plain",
    );
    for agent_id in [
        "portico_agent_new-all",
        "portico_agent_new-specific",
        "portico_agent_new-none",
    ] {
        openwebui.queue_json(
            "GET",
            &format!("/api/v1/models/model?id={agent_id}"),
            404,
            json!({ "error": "missing" }),
        );
    }
    for _ in 0..3 {
        openwebui.queue_text("POST", "/api/v1/models/create", 200, "ok", "text/plain");
    }

    assert!(install_all_agents(
        &env.paths,
        &client,
        &[
            "server:mcp-assistant".to_string(),
            "server:subagents".to_string()
        ],
        &[
            "server:mcp-assistant".to_string(),
            "server:subagents".to_string(),
            "server:time".to_string(),
        ],
    )
    .await
    .unwrap());

    openwebui.queue_json("GET", "/api/v1/auths/", 200, json!({ "id": "user-2" }));
    openwebui.queue_json(
        "GET",
        "/api/models?",
        200,
        json!({
            "data": [
                { "id": "base-a", "info": { "base_model_id": null } },
                { "id": "base-b", "info": { "base_model_id": null } },
                { "id": "skip-me", "info": { "base_model_id": null } }
            ]
        }),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=base-a",
        200,
        json!({ "id": "base-a", "params": {}, "meta": {}, "user": {}, "info": {} }),
    );
    openwebui.queue_text(
        "POST",
        "/api/v1/models/model/update?id=base-a",
        200,
        "ok",
        "text/plain",
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=base-b",
        200,
        json!({ "id": "base-b", "params": {}, "meta": {}, "user": {}, "info": {} }),
    );
    openwebui.queue_text(
        "POST",
        "/api/v1/models/model/update?id=base-b",
        200,
        "ok",
        "text/plain",
    );
    assert!(
        update_base_models_system_prompt(&client, "base prompt", &["skip-me".to_string()])
            .await
            .unwrap()
    );

    openwebui.queue_text(
        "POST",
        "/api/v1/models/model/delete",
        404,
        "missing",
        "text/plain",
    );
    openwebui.queue_text(
        "DELETE",
        "/api/v1/models/base%2Da/delete",
        200,
        "ok",
        "text/plain",
    );
    assert!(delete_model_with_fallbacks(&client, "base-a")
        .await
        .unwrap());

    openwebui.queue_text(
        "POST",
        "/api/v1/models/model/delete",
        404,
        "missing",
        "text/plain",
    );
    openwebui.queue_text(
        "DELETE",
        "/api/v1/models/base%2Db/delete",
        404,
        "missing",
        "text/plain",
    );
    openwebui.queue_text(
        "DELETE",
        "/api/v1/models/model/delete?id=base-b",
        200,
        "ok",
        "text/plain",
    );
    assert!(delete_model_with_fallbacks(&client, "base-b")
        .await
        .unwrap());
}

#[tokio::test]
async fn migration_helpers_cover_glean_mapping_unmappable_ids_and_report_generation() {
    let env = TestEnv::new("migration");
    let openwebui = MockServer::start().await;
    let client = OpenWebUiClient::new(
        Client::new(),
        &openwebui.base_url,
        std::time::Duration::from_secs(5),
    );

    openwebui.queue_json(
        "GET",
        "/api/v1/tools/",
        200,
        json!([
            { "id": "server:0", "name": "Glean" },
            { "id": "server:1", "name": "Time" },
            { "id": "server:2", "name": "Unknown Thing" },
            { "id": "server:skills", "name": "Skills" }
        ]),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models",
        200,
        json!([
            { "id": "base", "base_model_id": null, "meta": { "toolIds": ["server:0"] } },
            { "id": "user-1", "name": "User One", "base_model_id": "Claude", "meta": { "toolIds": ["server:0", "server:1"] } },
            { "id": "user-2", "name": "User Two", "base_model_id": "Claude", "meta": { "toolIds": ["server:2", "server:skills"] } }
        ]),
    );
    let discovered = BTreeMap::from([
        (
            "glean".to_string(),
            DiscoveredTool {
                host: "core".to_string(),
                port: "8766".to_string(),
            },
        ),
        (
            "time".to_string(),
            DiscoveredTool {
                host: "regular".to_string(),
                port: "8765".to_string(),
            },
        ),
    ]);
    let (mapping, mut data) = build_migration_mapping(&client, &discovered).await.unwrap();
    assert_eq!(
        mapping.get("user-1").unwrap(),
        &vec!["server:glean".to_string(), "server:time".to_string()]
    );
    assert_eq!(
        mapping.get("user-2").unwrap(),
        &vec!["server:skills".to_string()]
    );
    data["models_migrated"] = json!([{
        "model_id": "user-1",
        "model_name": "User One",
        "old_ids": ["server:0", "server:1"],
        "new_ids": ["server:glean", "server:time"],
        "status": "SUCCESS"
    }]);
    data["models_skipped"] = json!([]);
    let report = generate_migration_report(&env.paths, &data).unwrap();
    let report_body = fs::read_to_string(report).unwrap();
    assert!(report_body.contains("NUMERIC ID → STABLE ID MAPPING"));
    assert!(report_body.contains("MODELS MIGRATED"));
    assert!(report_body.contains("OLD tool IDs: ['server:0', 'server:1']"));
    assert!(report_body.contains("NEW tool IDs: ['server:glean', 'server:time']"));
    assert!(report_body.contains("MIGRATION SUMMARY"));
    assert!(report_body.contains("END OF REPORT"));
}

#[tokio::test]
async fn run_full_and_startup_core_cover_end_to_end_paths() {
    let env = TestEnv::new("run-full");
    env.write_filter(
        "unified_context",
        "\"\"\"\ndescription: Unified Context\n\"\"\"\nprint('ctx')\n",
    );
    env.write_base_system_prompt("Base prompt");
    env.write_agent(
        "mcp-context-resolver",
        r#"
name: "MCP Context Resolver"
base_model_id: "Claude Sonnet 4.6"
description: "Resolver"
tools_mode: "all"
hidden: true
"#,
        "Resolve context",
    );
    for server in ["mcp-assistant", "subagents", "skills", "time"] {
        let yaml = if server == "time" {
            "display_name: Time\ndeployment_type: docker\n"
        } else {
            "display_name: Core\ndeployment_type: docker\nis_core: true\n"
        };
        env.write_server_yaml(false, server, yaml);
    }
    env.write_model_catalog(
        r#"
model_list:
  - model_name: "Claude Sonnet 4.6"
    model_info:
      disabled: true
      disabled_reason: "Coming soon."
  - model_name: "Claude Sonnet 4.5"
  - model_name: "GPT-5.5"
"#,
    );
    fs::write(&env.paths.mcp_toggles_file, r#"{"time":true}"#).unwrap();

    let openwebui = MockServer::start().await;
    let core_server = MockServer::start().await;
    let regular_server = MockServer::start().await;
    let host_server = MockServer::start().await;

    queue_summary(
        &core_server,
        vec![
            summary_entry("mcp-assistant", "core", true, true, 1),
            summary_entry("subagents", "core", true, true, 1),
            summary_entry("skills", "core", true, true, 1),
        ],
    );
    queue_summary(
        &regular_server,
        vec![summary_entry("time", "regular", true, true, 1)],
    );
    regular_server.queue_json(
        "GET",
        "/oauth/status",
        200,
        json!({
            "current": null,
            "active": [],
            "pending": [],
            "checking": [],
            "waiting_callback": [],
            "completed": [],
            "failed": [],
            "timeout": []
        }),
    );
    regular_server.queue_json(
        "GET",
        "/oauth/status",
        200,
        json!({
            "current": null,
            "active": [],
            "pending": [],
            "checking": [],
            "waiting_callback": [],
            "completed": [],
            "failed": [],
            "timeout": []
        }),
    );
    core_server.queue_json(
        "GET",
        "/oauth/status",
        200,
        json!({
            "current": null,
            "active": [],
            "pending": [],
            "checking": [],
            "waiting_callback": [],
            "completed": [],
            "failed": [],
            "timeout": []
        }),
    );
    core_server.queue_json(
        "GET",
        "/oauth/status",
        200,
        json!({
            "current": null,
            "active": [],
            "pending": [],
            "checking": [],
            "waiting_callback": [],
            "completed": [],
            "failed": [],
            "timeout": []
        }),
    );

    openwebui.queue_json(
        "POST",
        "/api/v1/portico/auth/service-token",
        500,
        json!({ "error": "retry" }),
    );
    openwebui.queue_json(
        "POST",
        "/api/v1/portico/auth/service-token",
        200,
        json!({ "token": "token-123" }),
    );
    openwebui.queue_json("GET", "/api/v1/functions/", 200, json!([]));
    openwebui.queue_json(
        "POST",
        "/api/v1/utils/code/format",
        200,
        json!({ "code": "print('ctx')" }),
    );
    openwebui.queue_json(
        "PUT",
        "/api/v1/portico/managed-functions/id/portico_core_unified_context",
        200,
        json!({ "ok": true }),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/portico/managed-functions/id/portico_core_unified_context",
        200,
        json!({
            "id": "portico_core_unified_context",
            "name": "portico_core_unified_context",
            "type": "filter",
            "content": "print('ctx')",
            "meta": { "description": "Unified Context" },
            "valves": null,
            "is_active": true,
            "is_global": true
        }),
    );
    openwebui.queue_json("GET", "/api/v1/tools/", 200, json!([]));
    openwebui.queue_json(
        "POST",
        "/api/v1/configs/tool_servers",
        200,
        json!({ "ok": true }),
    );
    openwebui.queue_json("GET", "/api/v1/auths/", 200, json!({ "id": "user-1" }));
    openwebui.queue_json("GET", "/api/v1/auths/", 200, json!({ "id": "user-1" }));
    openwebui.queue_json(
        "GET",
        "/api/v1/tools/",
        200,
        json!([
            { "id": "server:subagents" },
            { "id": "server:skills" },
            { "id": "server:mcp-assistant" },
            { "id": "server:agent-vm" },
            { "id": "server:time" }
        ]),
    );
    let managed_tools = vec![
        "server:subagents".to_string(),
        "server:skills".to_string(),
        "server:mcp-assistant".to_string(),
        "server:agent-vm".to_string(),
    ];
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=portico_agent_mcp-context-resolver",
        404,
        json!({ "error": "missing" }),
    );
    openwebui.queue_text("POST", "/api/v1/models/create", 200, "ok", "text/plain");
    openwebui.queue_json("GET", "/api/models?", 200, json!({ "data": [] }));
    openwebui.queue_json("GET", "/api/v1/models", 200, json!([]));
    openwebui.queue_json("GET", "/api/models?", 200, json!({ "data": [] }));
    openwebui.queue_json("GET", "/api/models?", 200, json!({ "data": [] }));
    openwebui.queue_json("GET", "/api/v1/users/user/settings", 200, json!({}));
    openwebui.queue_json("GET", "/api/v1/users/user/settings", 200, json!({}));
    openwebui.queue_json("GET", "/api/v1/models", 200, json!([]));
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=Claude+Sonnet+4.6",
        404,
        json!({ "detail": "missing" }),
    );
    openwebui.queue_text("POST", "/api/v1/models/create", 200, "ok", "text/plain");
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=Claude+Sonnet+4.6",
        200,
        configured_model_readback(
            &env,
            "Claude Sonnet 4.6",
            true,
            Some("Coming soon."),
            &managed_tools,
            "Claude Sonnet 4.5",
        ),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=Claude+Sonnet+4.5",
        404,
        json!({ "detail": "missing" }),
    );
    openwebui.queue_text("POST", "/api/v1/models/create", 200, "ok", "text/plain");
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=Claude+Sonnet+4.5",
        200,
        configured_model_readback(
            &env,
            "Claude Sonnet 4.5",
            false,
            None,
            &managed_tools,
            "Claude Sonnet 4.5",
        ),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=GPT-5.5",
        404,
        json!({ "detail": "missing" }),
    );
    openwebui.queue_text("POST", "/api/v1/models/create", 200, "ok", "text/plain");
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=GPT-5.5",
        200,
        configured_model_readback(
            &env,
            "GPT-5.5",
            false,
            None,
            &managed_tools,
            "Claude Sonnet 4.5",
        ),
    );
    openwebui.queue_json("GET", "/api/v1/models", 200, json!([]));
    openwebui.queue_json(
        "POST",
        "/api/v1/users/user/settings/update",
        200,
        json!({ "ok": true }),
    );
    openwebui.queue_json(
        "GET",
        "/api/models?",
        200,
        json!({
            "data": [
                { "id": "Claude Sonnet 4.6", "info": { "base_model_id": null, "meta": { "disabled": true } } },
                { "id": "Claude Sonnet 4.5", "info": { "base_model_id": null, "meta": {} } },
                { "id": "GPT-5.5", "info": { "base_model_id": null, "meta": {} } }
            ]
        }),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models",
        200,
        json!([
            { "id": "Claude Sonnet 4.6", "base_model_id": null },
            { "id": "Claude Sonnet 4.5", "base_model_id": null },
            { "id": "GPT-5.5", "base_model_id": null }
        ]),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/users/user/settings",
        200,
        json!({ "ui": { "models": ["Claude Sonnet 4.5"] } }),
    );

    let token_store = Arc::new(MockTokenStore::default());
    let log_inspector = Arc::new(MockLogInspector::default());
    let config = base_config(
        HealthCheckMode::Full,
        &openwebui.base_url,
        &core_server.base_url,
        &regular_server.base_url,
        &host_server.base_url,
        "session-1",
    );
    let app = build_app(&env, config, token_store.clone(), log_inspector);
    let first_result = app.run().await.unwrap();
    assert!(
        first_result,
        "unexpected full-run requests: {:?}",
        openwebui.requests()
    );
    assert_eq!(
        token_store.writes.lock().unwrap().first().cloned(),
        Some(("openwebui:api_token".to_string(), "token-123".to_string()))
    );
    assert!(env.paths.model_sync_completed_session_file.exists());
    assert_eq!(
        token_store.releases.lock().unwrap().as_slice(),
        &[("run-session-1".to_string(), 1)]
    );
    let base_model_request = openwebui
        .requests()
        .into_iter()
        .filter(|request| request.path == "/api/v1/models/create")
        .map(|request| serde_json::from_str::<serde_json::Value>(&request.body).unwrap())
        .find(|body| body["id"] == json!("Claude Sonnet 4.6"))
        .unwrap();
    assert_eq!(base_model_request["meta"]["disabled"], json!(true));
    assert_eq!(
        base_model_request["meta"]["disabled_reason"],
        json!("Coming soon.")
    );
    assert_eq!(
        base_model_request["meta"]["toolIds"],
        json!([
            "server:subagents",
            "server:skills",
            "server:mcp-assistant",
            "server:agent-vm"
        ])
    );
    let default_model_request = openwebui
        .requests()
        .into_iter()
        .filter(|request| request.path == "/api/v1/models/create")
        .map(|request| serde_json::from_str::<serde_json::Value>(&request.body).unwrap())
        .find(|body| body["id"] == json!("Claude Sonnet 4.5"))
        .unwrap();
    assert_eq!(default_model_request["is_default"], json!(true));
    let health_sync_log = fs::read_to_string(health_sync_log_file_path(&env.paths)).unwrap();
    assert!(!health_sync_log.contains("token-123"));
    for expected_event in [
        "health_sync_start",
        "openwebui_auth_failure",
        "openwebui_auth_success",
        "model_sync_marker_decision",
        "model_catalog_loaded",
        "owui_model_inventory_loaded",
        "base_model_sync_complete",
        "health_sync_summary",
    ] {
        assert!(
            health_sync_log.contains(expected_event),
            "missing health sync event {expected_event}: {health_sync_log}"
        );
    }
    let summary = health_sync_log
        .lines()
        .find(|line| line.contains("health_sync_summary"))
        .expect("health sync summary event");
    assert!(summary.contains("base_models_created=3"));
    assert!(summary.contains("base_models_updated=0"));
    assert!(summary.contains("lm_studio_configured=false"));
    let model_sync = health_sync_log
        .lines()
        .find(|line| line.contains("base_model_sync_complete"))
        .expect("base model sync event");
    assert!(model_sync.contains("configured=3"));

    fs::write(&env.paths.health_check_mode_file, "startup-core").unwrap();
    let env_startup = TestEnv::new("run-startup");
    env_startup.write_base_system_prompt("Base prompt");
    env_startup.write_model_catalog(
        r#"
model_list:
  - model_name: "Claude Sonnet 5"
  - model_name: "GPT-5.5"
"#,
    );
    env_startup.write_agent(
        "mcp-context-resolver",
        r#"
name: "MCP Context Resolver"
base_model_id: "Claude Sonnet 5"
description: "Resolver"
tools_mode: "all"
"#,
        "Resolve context",
    );
    for server in ["mcp-assistant", "subagents", "skills", "time"] {
        let yaml = if server == "time" {
            "display_name: Time\ndeployment_type: docker\n"
        } else {
            "display_name: Core\ndeployment_type: docker\nis_core: true\n"
        };
        env_startup.write_server_yaml(false, server, yaml);
    }
    fs::write(&env_startup.paths.mcp_toggles_file, r#"{"time":true}"#).unwrap();
    mark_model_sync_completed_for_session(&env_startup.paths, "session-2").unwrap();

    let openwebui2 = MockServer::start().await;
    let core2 = MockServer::start().await;
    let regular2 = MockServer::start().await;
    let host2 = MockServer::start().await;
    queue_summary(
        &core2,
        vec![
            summary_entry("mcp-assistant", "core", true, true, 1),
            summary_entry("subagents", "core", true, true, 1),
            summary_entry("skills", "core", true, true, 1),
        ],
    );
    queue_summary(
        &regular2,
        vec![summary_entry("time", "regular", true, true, 1)],
    );
    regular2.queue_json("GET", "/oauth/status", 200, json!({ "current": null, "active": [], "pending": [], "checking": [], "waiting_callback": [], "completed": [], "failed": [], "timeout": [] }));
    core2.queue_json("GET", "/oauth/status", 200, json!({ "current": null, "active": [], "pending": [], "checking": [], "waiting_callback": [], "completed": [], "failed": [], "timeout": [] }));
    openwebui2.queue_json(
        "POST",
        "/api/v1/portico/auth/service-token",
        200,
        json!({ "token": "token-234" }),
    );
    openwebui2.queue_json("GET", "/api/v1/tools/", 200, json!([]));
    openwebui2.queue_json(
        "POST",
        "/api/v1/configs/tool_servers",
        200,
        json!({ "ok": true }),
    );
    openwebui2.queue_json("GET", "/api/v1/auths/", 200, json!({ "id": "user-2" }));
    openwebui2.queue_json(
        "GET",
        "/api/v1/tools/",
        200,
        json!([
            { "id": "server:mcp-assistant" },
            { "id": "server:subagents" },
            { "id": "server:skills" },
            { "id": "server:agent-vm" }
        ]),
    );
    openwebui2.queue_json(
        "GET",
        "/api/v1/models/model?id=portico_agent_mcp-context-resolver",
        404,
        json!({ "error": "missing" }),
    );
    openwebui2.queue_text("POST", "/api/v1/models/create", 200, "ok", "text/plain");
    openwebui2.queue_json(
        "GET",
        "/api/models?",
        200,
        json!({
            "data": [
                { "id": "Claude Sonnet 5", "info": { "base_model_id": null, "meta": {} } },
                { "id": "GPT-5.5", "info": { "base_model_id": null, "meta": {} } }
            ]
        }),
    );
    openwebui2.queue_json(
        "GET",
        "/api/v1/models",
        200,
        json!([
            { "id": "Claude Sonnet 5", "base_model_id": null },
            { "id": "GPT-5.5", "base_model_id": null },
            { "id": "legacy-agent", "info": { "base_model_id": "Claude Sonnet 5" } }
        ]),
    );
    openwebui2.queue_json(
        "GET",
        "/api/v1/models",
        200,
        json!([
            { "id": "legacy-agent", "info": { "base_model_id": "Claude Sonnet 4.5" } }
        ]),
    );
    openwebui2.queue_json(
        "GET",
        "/api/v1/models/model?id=legacy-agent",
        200,
        json!({
            "id": "legacy-agent",
            "name": "Legacy Agent",
            "base_model_id": "Claude Sonnet 4.5",
            "meta": {},
            "user": {},
            "info": {}
        }),
    );
    openwebui2.queue_text(
        "POST",
        "/api/v1/models/model/update?id=legacy-agent",
        200,
        "ok",
        "text/plain",
    );
    openwebui2.queue_json(
        "GET",
        "/api/v1/users/user/settings",
        200,
        json!({ "ui": { "models": ["Custom Model"] } }),
    );
    openwebui2.queue_json(
        "POST",
        "/api/v1/users/user/settings/update",
        200,
        json!({ "ok": true }),
    );

    let token_store2 = Arc::new(MockTokenStore::default());
    let config2 = base_config(
        HealthCheckMode::StartupCore,
        &openwebui2.base_url,
        &core2.base_url,
        &regular2.base_url,
        &host2.base_url,
        "session-2",
    );
    let app2 = build_app(
        &env_startup,
        config2,
        token_store2,
        Arc::new(MockLogInspector::default()),
    );
    let second_result = app2.run().await.unwrap();
    assert!(
        second_result,
        "unexpected startup-core requests: {:?}",
        openwebui2.requests()
    );
    let configure_request = openwebui2
        .requests()
        .into_iter()
        .find(|request| request.path == "/api/v1/configs/tool_servers")
        .unwrap();
    let body: serde_json::Value = serde_json::from_str(&configure_request.body).unwrap();
    assert_eq!(body["TOOL_SERVER_CONNECTIONS"].as_array().unwrap().len(), 3);
    // With a valid model-sync marker (no sync required), the one-time model
    // migrations must NOT run: the legacy agent keeps its base model and no
    // migration update is issued (PORTICO-213 one-time semantics).
    let second_run_requests = openwebui2.requests();
    assert!(!second_run_requests
        .iter()
        .any(|request| request.path == "/api/v1/models/model/update?id=legacy-agent"));
}

#[tokio::test]
async fn marker_complete_empty_owui_inventory_invalidates_and_resyncs_models() {
    let env = TestEnv::new("marker-empty-resync");
    env.write_base_system_prompt("Base prompt");
    env.write_model_catalog(
        r#"
model_list:
  - model_name: "Claude Sonnet 4.6"
  - model_name: "GPT-5.5"
"#,
    );
    write_core_server_configs(&env);
    mark_model_sync_completed_for_session(&env.paths, "session-empty").unwrap();

    let openwebui = MockServer::start().await;
    let core = MockServer::start().await;
    let regular = MockServer::start().await;
    let host = MockServer::start().await;
    queue_summary(
        &core,
        vec![
            summary_entry("mcp-assistant", "core", true, true, 1),
            summary_entry("subagents", "core", true, true, 1),
            summary_entry("skills", "core", true, true, 1),
        ],
    );
    queue_summary(&regular, vec![]);
    queue_empty_oauth_status(&regular);
    queue_empty_oauth_status(&core);

    openwebui.queue_json(
        "POST",
        "/api/v1/portico/auth/service-token",
        200,
        json!({ "token": "token-empty" }),
    );
    openwebui.queue_json("GET", "/api/v1/tools/", 200, json!([]));
    openwebui.queue_json(
        "POST",
        "/api/v1/configs/tool_servers",
        200,
        json!({ "ok": true }),
    );
    openwebui.queue_json("GET", "/api/v1/auths/", 200, json!({ "id": "user-empty" }));
    openwebui.queue_json(
        "GET",
        "/api/v1/tools/",
        200,
        json!([
            { "id": "server:mcp-assistant" },
            { "id": "server:subagents" },
            { "id": "server:skills" },
            { "id": "server:agent-vm" }
        ]),
    );
    let managed_tools = vec![
        "server:mcp-assistant".to_string(),
        "server:subagents".to_string(),
        "server:skills".to_string(),
        "server:agent-vm".to_string(),
    ];
    openwebui.queue_json("GET", "/api/models?", 200, json!({ "data": [] }));
    openwebui.queue_json("GET", "/api/v1/models", 200, json!([]));
    openwebui.queue_json("GET", "/api/v1/users/user/settings", 200, json!({}));
    openwebui.queue_json("GET", "/api/v1/auths/", 200, json!({ "id": "user-empty" }));
    openwebui.queue_json("GET", "/api/models?", 200, json!({ "data": [] }));
    openwebui.queue_json("GET", "/api/models?", 200, json!({ "data": [] }));
    openwebui.queue_json("GET", "/api/v1/models", 200, json!([]));
    openwebui.queue_json("GET", "/api/v1/users/user/settings", 200, json!({}));
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=Claude+Sonnet+4.6",
        404,
        json!({ "detail": "missing" }),
    );
    openwebui.queue_text("POST", "/api/v1/models/create", 200, "ok", "text/plain");
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=Claude+Sonnet+4.6",
        200,
        configured_model_readback(
            &env,
            "Claude Sonnet 4.6",
            false,
            None,
            &managed_tools,
            "Claude Sonnet 4.6",
        ),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=GPT-5.5",
        404,
        json!({ "detail": "missing" }),
    );
    openwebui.queue_text("POST", "/api/v1/models/create", 200, "ok", "text/plain");
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=GPT-5.5",
        200,
        configured_model_readback(
            &env,
            "GPT-5.5",
            false,
            None,
            &managed_tools,
            "Claude Sonnet 4.6",
        ),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models",
        200,
        json!([
            { "id": "sonnet-46-live", "info": { "base_model_id": "Claude Sonnet 4.6" } }
        ]),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=sonnet-46-live",
        200,
        json!({ "id": "sonnet-46-live", "base_model_id": "Claude Sonnet 4.6", "meta": {}, "user": {}, "info": {} }),
    );
    openwebui.queue_text(
        "POST",
        "/api/v1/models/model/update?id=sonnet-46-live",
        200,
        "ok",
        "text/plain",
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=sonnet-46-live",
        200,
        json!({ "id": "sonnet-46-live", "base_model_id": "Claude Sonnet 5", "meta": {}, "info": { "base_model_id": "Claude Sonnet 5" } }),
    );
    openwebui.queue_json(
        "POST",
        "/api/v1/users/user/settings/update",
        200,
        json!({ "ok": true }),
    );
    openwebui.queue_json(
        "GET",
        "/api/models?",
        200,
        json!({
            "data": [
                { "id": "Claude Sonnet 4.6", "info": { "base_model_id": null, "meta": {} } },
                { "id": "GPT-5.5", "info": { "base_model_id": null, "meta": {} } },
                { "id": "sonnet-46-live", "info": { "base_model_id": "Claude Sonnet 5", "meta": {} } }
            ]
        }),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models",
        200,
        json!([
            { "id": "Claude Sonnet 4.6", "base_model_id": null },
            { "id": "GPT-5.5", "base_model_id": null },
            { "id": "sonnet-46-live", "base_model_id": "Claude Sonnet 5" }
        ]),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/users/user/settings",
        200,
        json!({ "ui": { "models": ["Claude Sonnet 4.6"] } }),
    );

    let app = build_app(
        &env,
        base_config(
            HealthCheckMode::StartupCore,
            &openwebui.base_url,
            &core.base_url,
            &regular.base_url,
            &host.base_url,
            "session-empty",
        ),
        Arc::new(MockTokenStore::default()),
        Arc::new(MockLogInspector::default()),
    );

    assert!(app.run().await.unwrap());
    let requests = openwebui.requests();
    assert_eq!(
        requests
            .iter()
            .filter(|request| request.path == "/api/v1/models/create")
            .count(),
        2,
        "unexpected model requests: {requests:?}"
    );
    // When the sync IS required, the one-time model migrations run: the agent
    // pinned to Claude Sonnet 4.6 is upgraded to Claude Sonnet 5 (PORTICO-213).
    let live_migration_update = requests
        .iter()
        .find(|request| request.path == "/api/v1/models/model/update?id=sonnet-46-live")
        .expect("sonnet-46-live migration update");
    let live_migration_body: serde_json::Value =
        serde_json::from_str(&live_migration_update.body).unwrap();
    assert_eq!(
        live_migration_body["base_model_id"],
        json!("Claude Sonnet 5")
    );
    let health_sync_log = fs::read_to_string(health_sync_log_file_path(&env.paths)).unwrap();
    assert!(health_sync_log.contains("model_sync_marker_invalidated"));
    let base_sync = health_sync_log
        .lines()
        .find(|line| line.contains("base_model_sync_complete"))
        .expect("base model sync event");
    assert!(base_sync.contains("required=true"));
    assert!(base_sync.contains("created=2"));
}

#[test]
fn base_model_record_detection_accepts_top_level_and_info_null() {
    assert!(is_base_model_record(&json!({ "base_model_id": null })));
    assert!(is_base_model_record(
        &json!({ "info": { "base_model_id": null } })
    ));
    assert!(!is_base_model_record(
        &json!({ "base_model_id": "agent-wrapper", "info": { "base_model_id": null } })
    ));
    assert!(!is_base_model_record(
        &json!({ "info": { "base_model_id": "Claude Sonnet 4.6" } })
    ));
    assert!(!is_base_model_record(&json!({ "id": "no-base-marker" })));
}

#[tokio::test]
async fn owui_inventory_flags_configured_models_missing_from_picker_base_models() {
    let openwebui = MockServer::start().await;
    let client = OpenWebUiClient::new(Client::new(), &openwebui.base_url, Duration::from_secs(5));

    openwebui.queue_json(
        "GET",
        "/api/models?",
        200,
        json!({
            "data": [
                {
                    "id": "Claude Sonnet 4.6",
                    "info": {
                        "base_model_id": "portico_agent_custom",
                        "meta": { "disabled": true }
                    }
                },
                { "id": "GPT-5.4", "base_model_id": null, "meta": {} }
            ]
        }),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models",
        200,
        json!([
            { "id": "Claude Sonnet 4.6", "base_model_id": null },
            { "id": "GPT-5.4", "info": { "base_model_id": null } },
            {
                "id": "mixed-case-retired-agent",
                "base_model_id": "OpenAI/Responses/GPT-5.4-PRO:LaTeSt"
            },
            {
                "id": "still-selectable-sonnet-agent",
                "base_model_id": "Claude Sonnet 4.6"
            }
        ]),
    );

    let configured_model_ids = vec![
        "Claude Sonnet 4.6".to_string(),
        "GPT-5.4".to_string(),
        "Claude Opus 5".to_string(),
    ];
    let inventory = load_owui_model_inventory(&client, &configured_model_ids)
        .await
        .unwrap();

    assert_eq!(inventory.picker_model_count, 2);
    assert_eq!(inventory.wrapper_model_count, 4);
    assert_eq!(inventory.base_model_count, 1);
    assert_eq!(inventory.disabled_model_count, 1);
    assert_eq!(inventory.deprecated_reference_count, 1);
    assert_eq!(
        inventory.existing_base_model_ids,
        vec!["Claude Sonnet 4.6".to_string(), "GPT-5.4".to_string()]
    );
    assert_eq!(
        inventory.missing_configured_model_ids,
        vec!["Claude Opus 5".to_string()]
    );
    assert_eq!(
        inventory.configured_model_ids_missing_from_picker_base_models,
        vec!["Claude Sonnet 4.6".to_string()]
    );
}

#[tokio::test]
async fn marker_complete_wrapper_only_configured_model_invalidates_and_updates_existing_model() {
    let env = TestEnv::new("marker-wrapper-resync");
    env.write_base_system_prompt("Base prompt");
    env.write_model_catalog(
        r#"
model_list:
  - model_name: "Claude Sonnet 4.6"
"#,
    );
    write_core_server_configs(&env);
    mark_model_sync_completed_for_session(&env.paths, "session-wrapper").unwrap();

    let openwebui = MockServer::start().await;
    let core = MockServer::start().await;
    let regular = MockServer::start().await;
    let host = MockServer::start().await;
    queue_summary(
        &core,
        vec![
            summary_entry("mcp-assistant", "core", true, true, 1),
            summary_entry("subagents", "core", true, true, 1),
            summary_entry("skills", "core", true, true, 1),
        ],
    );
    queue_summary(&regular, vec![]);
    queue_empty_oauth_status(&regular);
    queue_empty_oauth_status(&core);

    openwebui.queue_json(
        "POST",
        "/api/v1/portico/auth/service-token",
        200,
        json!({ "token": "token-wrapper" }),
    );
    openwebui.queue_json("GET", "/api/v1/tools/", 200, json!([]));
    openwebui.queue_json(
        "POST",
        "/api/v1/configs/tool_servers",
        200,
        json!({ "ok": true }),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/auths/",
        200,
        json!({ "id": "user-wrapper" }),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/tools/",
        200,
        json!([
            { "id": "server:mcp-assistant" },
            { "id": "server:subagents" },
            { "id": "server:skills" },
            { "id": "server:agent-vm" }
        ]),
    );
    openwebui.queue_json(
        "GET",
        "/api/models?",
        200,
        json!({
            "data": [
                {
                    "id": "Claude Sonnet 4.6",
                    "info": {
                        "base_model_id": "portico_agent_custom",
                        "meta": { "disabled": true }
                    }
                }
            ]
        }),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models",
        200,
        json!([
            { "id": "Claude Sonnet 4.6", "base_model_id": null }
        ]),
    );
    openwebui.queue_json("GET", "/api/v1/users/user/settings", 200, json!({}));
    openwebui.queue_json(
        "GET",
        "/api/v1/auths/",
        200,
        json!({ "id": "user-wrapper" }),
    );
    openwebui.queue_json(
        "GET",
        "/api/models?",
        200,
        json!({
            "data": [
                {
                    "id": "Claude Sonnet 4.6",
                    "info": {
                        "base_model_id": "portico_agent_custom",
                        "meta": { "disabled": true }
                    }
                }
            ]
        }),
    );
    openwebui.queue_json(
        "GET",
        "/api/models?",
        200,
        json!({
            "data": [
                {
                    "id": "Claude Sonnet 4.6",
                    "info": {
                        "base_model_id": "portico_agent_custom",
                        "meta": { "disabled": true }
                    }
                }
            ]
        }),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models",
        200,
        json!([
            { "id": "Claude Sonnet 4.6", "base_model_id": null }
        ]),
    );
    openwebui.queue_json("GET", "/api/v1/users/user/settings", 200, json!({}));
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=Claude+Sonnet+4.6",
        200,
        json!({
            "id": "Claude Sonnet 4.6",
            "name": "Claude Sonnet 4.6",
            "base_model_id": "portico_agent_custom",
            "is_active": false,
            "meta": {
                "disabled": true,
                "disabled_reason": "stale"
            },
            "params": { "system": "stale prompt" },
            "user": {},
            "info": {}
        }),
    );
    openwebui.queue_text(
        "POST",
        "/api/v1/models/model/update?id=Claude+Sonnet+4.6",
        200,
        "ok",
        "text/plain",
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=Claude+Sonnet+4.6",
        200,
        configured_model_readback(
            &env,
            "Claude Sonnet 4.6",
            false,
            None,
            &[
                "server:mcp-assistant".to_string(),
                "server:subagents".to_string(),
                "server:skills".to_string(),
                "server:agent-vm".to_string(),
            ],
            "Claude Sonnet 4.6",
        ),
    );
    openwebui.queue_json("GET", "/api/v1/models", 200, json!([]));
    openwebui.queue_json(
        "POST",
        "/api/v1/users/user/settings/update",
        200,
        json!({ "ok": true }),
    );
    openwebui.queue_json(
        "GET",
        "/api/models?",
        200,
        json!({
            "data": [
                { "id": "Claude Sonnet 4.6", "info": { "base_model_id": null, "meta": {} } }
            ]
        }),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models",
        200,
        json!([
            { "id": "Claude Sonnet 4.6", "base_model_id": null }
        ]),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/users/user/settings",
        200,
        json!({ "ui": { "models": ["Claude Sonnet 4.6"] } }),
    );

    let app = build_app(
        &env,
        base_config(
            HealthCheckMode::StartupCore,
            &openwebui.base_url,
            &core.base_url,
            &regular.base_url,
            &host.base_url,
            "session-wrapper",
        ),
        Arc::new(MockTokenStore::default()),
        Arc::new(MockLogInspector::default()),
    );

    assert!(app.run().await.unwrap());
    let requests = openwebui.requests();
    assert!(!requests
        .iter()
        .any(|request| request.path == "/api/v1/models/create"));
    let update_request = requests
        .iter()
        .find(|request| request.path == "/api/v1/models/model/update?id=Claude+Sonnet+4.6")
        .expect("existing configured model should be updated");
    let update_body: serde_json::Value = serde_json::from_str(&update_request.body).unwrap();
    assert_eq!(
        update_body["base_model_id"],
        serde_json::Value::Null,
        "unexpected model requests: {requests:?}"
    );
    assert_eq!(update_body["is_active"], json!(true));
    assert_eq!(update_body["is_default"], json!(true));
    assert_eq!(update_body["params"]["system"], json!("Base prompt"));
    assert_eq!(update_body["meta"]["disabled"], json!(false));
    assert!(update_body["meta"].get("disabled_reason").is_none());
    assert_eq!(
        update_body["meta"]["toolIds"],
        json!([
            "server:mcp-assistant",
            "server:subagents",
            "server:skills",
            "server:agent-vm"
        ])
    );
    assert!(update_body.get("info").is_none());
    assert!(update_body.get("user").is_none());

    let health_sync_log = fs::read_to_string(health_sync_log_file_path(&env.paths)).unwrap();
    assert!(health_sync_log.contains("configured_models_not_visible_as_base_models"));
    assert!(health_sync_log.contains("not_picker_base=[Claude Sonnet 4.6]"));
}

#[tokio::test]
async fn marker_complete_healthy_owui_inventory_skips_destructive_model_sync_but_logs_inventory() {
    let env = TestEnv::new("marker-healthy-skip");
    env.write_base_system_prompt("Base prompt");
    env.write_model_catalog(
        r#"
model_list:
  - model_name: "Claude Sonnet 4.6"
  - model_name: "GPT-5.5"
"#,
    );
    write_core_server_configs(&env);
    mark_model_sync_completed_for_session(&env.paths, "session-healthy").unwrap();

    let openwebui = MockServer::start().await;
    let core = MockServer::start().await;
    let regular = MockServer::start().await;
    let host = MockServer::start().await;
    queue_summary(
        &core,
        vec![
            summary_entry("mcp-assistant", "core", true, true, 1),
            summary_entry("subagents", "core", true, true, 1),
            summary_entry("skills", "core", true, true, 1),
        ],
    );
    queue_summary(&regular, vec![]);
    queue_empty_oauth_status(&regular);
    queue_empty_oauth_status(&core);

    openwebui.queue_json(
        "POST",
        "/api/v1/portico/auth/service-token",
        200,
        json!({ "token": "token-healthy" }),
    );
    openwebui.queue_json("GET", "/api/v1/tools/", 200, json!([]));
    openwebui.queue_json(
        "POST",
        "/api/v1/configs/tool_servers",
        200,
        json!({ "ok": true }),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/auths/",
        200,
        json!({ "id": "user-healthy" }),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/tools/",
        200,
        json!([
            { "id": "server:mcp-assistant" },
            { "id": "server:subagents" },
            { "id": "server:skills" },
            { "id": "server:agent-vm" }
        ]),
    );
    openwebui.queue_json(
        "GET",
        "/api/models?",
        200,
        json!({
            "data": [
                { "id": "Claude Sonnet 4.6", "info": { "base_model_id": null, "meta": {} } },
                { "id": "GPT-5.5", "info": { "base_model_id": null, "meta": {} } }
            ]
        }),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models",
        200,
        json!([
            { "id": "Claude Sonnet 4.6", "base_model_id": null },
            { "id": "GPT-5.5", "base_model_id": null }
        ]),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/users/user/settings",
        200,
        json!({ "ui": { "models": ["GPT-5.5"] } }),
    );
    openwebui.queue_json("GET", "/api/v1/models", 200, json!([]));
    openwebui.queue_json(
        "POST",
        "/api/v1/users/user/settings/update",
        200,
        json!({ "ok": true }),
    );

    let app = build_app(
        &env,
        base_config(
            HealthCheckMode::StartupCore,
            &openwebui.base_url,
            &core.base_url,
            &regular.base_url,
            &host.base_url,
            "session-healthy",
        ),
        Arc::new(MockTokenStore::default()),
        Arc::new(MockLogInspector::default()),
    );

    assert!(app.run().await.unwrap());
    let requests = openwebui.requests();
    assert!(!requests
        .iter()
        .any(|request| request.path == "/api/v1/models/create"));
    let health_sync_log = fs::read_to_string(health_sync_log_file_path(&env.paths)).unwrap();
    assert!(health_sync_log
        .lines()
        .any(|line| line.contains("owui_model_inventory_loaded")
            && line.contains("picker=2")
            && line.contains("missing=[]")));
    let base_sync = health_sync_log
        .lines()
        .find(|line| line.contains("base_model_sync_complete"))
        .expect("base model sync event");
    assert!(base_sync.contains("required=false"));
}

#[tokio::test]
async fn owui_inventory_non_json_logs_http_failure_and_does_not_mark_sync_complete() {
    let env = TestEnv::new("inventory-non-json");
    env.write_base_system_prompt("Base prompt");
    env.write_model_catalog(
        r#"
model_list:
  - model_name: "Claude Sonnet 4.6"
"#,
    );
    write_core_server_configs(&env);

    let openwebui = MockServer::start().await;
    let core = MockServer::start().await;
    let regular = MockServer::start().await;
    let host = MockServer::start().await;
    queue_summary(
        &core,
        vec![
            summary_entry("mcp-assistant", "core", true, true, 1),
            summary_entry("subagents", "core", true, true, 1),
            summary_entry("skills", "core", true, true, 1),
        ],
    );
    queue_summary(&regular, vec![]);
    queue_empty_oauth_status(&regular);
    queue_empty_oauth_status(&core);

    openwebui.queue_json(
        "POST",
        "/api/v1/portico/auth/service-token",
        200,
        json!({ "token": "token-non-json" }),
    );
    openwebui.queue_json("GET", "/api/v1/tools/", 200, json!([]));
    openwebui.queue_json(
        "POST",
        "/api/v1/configs/tool_servers",
        200,
        json!({ "ok": true }),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/auths/",
        200,
        json!({ "id": "user-non-json" }),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/tools/",
        200,
        json!([
            { "id": "server:mcp-assistant" },
            { "id": "server:subagents" },
            { "id": "server:skills" },
            { "id": "server:agent-vm" }
        ]),
    );
    openwebui.queue_text(
        "GET",
        "/api/models?",
        200,
        "<html>bad gateway</html>",
        "text/html",
    );

    let app = build_app(
        &env,
        base_config(
            HealthCheckMode::StartupCore,
            &openwebui.base_url,
            &core.base_url,
            &regular.base_url,
            &host.base_url,
            "session-non-json",
        ),
        Arc::new(MockTokenStore::default()),
        Arc::new(MockLogInspector::default()),
    );

    assert!(app.run().await.unwrap());
    assert!(!env.paths.model_sync_completed_session_file.exists());
    let raw = fs::read_to_string(health_sync_log_file_path(&env.paths)).unwrap();
    assert!(raw
        .lines()
        .any(|line| line.contains("owui_json_parse_error") && line.contains("path=/api/models?")));
    assert!(raw.contains("owui_model_inventory_error"));
    assert!(raw.contains("model_sync_status=degraded"));
    assert!(!raw.contains("bad gateway"));
}

#[test]
#[serial]
fn gpt_56_sol_pro_konami_gate_controls_catalog_fingerprint_and_default_migration() {
    std::env::remove_var("PORTICO_KONAMI_UNLOCK_GPT54_PRO");
    let env = TestEnv::new("gpt-56-sol-pro-konami");
    env.write_base_system_prompt("Base prompt");
    env.write_model_catalog(
        r#"
model_list:
  - model_name: "GPT-5.6 Sol Pro"
    model_info:
      disabled: true
      disabled_reason: "Enter the Konami code to unlock."
  - model_name: "GPT-5.6 Sol"
"#,
    );
    fs::remove_file(&env.paths.konami_unlock_flag_file).ok();

    let locked = load_models_from_model_catalog(&env.paths).unwrap();
    let locked_pro = locked
        .iter()
        .find(|model| model.id == "GPT-5.6 Sol Pro")
        .unwrap();
    assert!(locked_pro.disabled);
    assert_eq!(
        locked_pro.disabled_reason.as_deref(),
        Some("Enter the Konami code to unlock.")
    );
    assert_eq!(
        deprecated_base_model_migration_target("GPT-5.4 pro"),
        Some("GPT-5.6 Sol Pro")
    );
    assert_eq!(
        resolve_target_default_model(
            Some(" OpenAI/Responses/GPT-5.4-PRO:LaTeSt ".to_string()),
            &locked,
            true,
        ),
        "GPT-5.6 Sol"
    );
    let accessible_retired_default =
        BTreeSet::from(["OpenAI/Responses/GPT-5.4-PRO:LaTeSt".to_string()]);
    assert_eq!(
        resolve_target_default_model_with_accessible(
            Some("OpenAI/Responses/GPT-5.4-PRO:LaTeSt".to_string()),
            &locked,
            true,
            &accessible_retired_default,
        ),
        "GPT-5.6 Sol"
    );
    let locked_payload = configured_model_readback(
        &env,
        "GPT-5.6 Sol Pro",
        locked_pro.disabled,
        locked_pro.disabled_reason.as_deref(),
        &[],
        "GPT-5.6 Sol",
    );
    assert_eq!(locked_payload["meta"]["disabled"], json!(true));
    assert_eq!(locked_payload["is_default"], json!(false));

    let locked_fingerprint =
        compute_model_sync_completion_marker(&env.paths, "konami-session").unwrap();
    mark_model_sync_completed_for_session(&env.paths, "konami-session").unwrap();
    assert!(
        model_sync_marker_status(&env.paths, "konami-session")
            .unwrap()
            .matches
    );

    fs::write(&env.paths.konami_unlock_flag_file, "").unwrap();
    let unlocked = load_models_from_model_catalog(&env.paths).unwrap();
    let unlocked_pro = unlocked
        .iter()
        .find(|model| model.id == "GPT-5.6 Sol Pro")
        .unwrap();
    assert!(!unlocked_pro.disabled);
    assert!(unlocked_pro.disabled_reason.is_none());
    assert_eq!(
        resolve_target_default_model(
            Some(" OpenAI/Responses/GPT-5.4-PRO:LaTeSt ".to_string()),
            &unlocked,
            true,
        ),
        "GPT-5.6 Sol Pro"
    );
    let unlocked_payload = configured_model_readback(
        &env,
        "GPT-5.6 Sol Pro",
        unlocked_pro.disabled,
        unlocked_pro.disabled_reason.as_deref(),
        &[],
        "GPT-5.6 Sol Pro",
    );
    assert_eq!(unlocked_payload["meta"]["disabled"], json!(false));
    assert_eq!(unlocked_payload["is_default"], json!(true));

    let unlocked_fingerprint =
        compute_model_sync_completion_marker(&env.paths, "konami-session").unwrap();
    assert_ne!(locked_fingerprint, unlocked_fingerprint);
    assert!(
        !model_sync_marker_status(&env.paths, "konami-session")
            .unwrap()
            .matches,
        "unlocking Sol Pro must invalidate the model sync fingerprint"
    );
}
#[test]
#[serial]
fn env_and_local_helpers_cover_defaults_runtime_loading_and_files() {
    std::env::remove_var("portico_HEALTH_CHECK_APP_ROOT");
    std::env::remove_var("MCPO_REGULAR_HOST");
    std::env::remove_var("MCPO_REGULAR_BASE_URL");
    std::env::remove_var("MCPO_CORE_HOST");
    std::env::remove_var("MCPO_CORE_BASE_URL");
    std::env::remove_var("HOST_MCPO_HOST");
    std::env::remove_var("HOST_MCPO_BASE_URL");
    std::env::remove_var("MCPO_REGULAR_LOCALHOST_PORT");
    std::env::remove_var("MCPO_CORE_LOCALHOST_PORT");
    std::env::remove_var("HOST_MCPO_LOCALHOST_PORT");
    std::env::remove_var("WRITE_API_LOGS");
    std::env::remove_var("HEALTH_CHECK_MODE");
    std::env::remove_var("HEALTH_SYNC_SESSION_ID");
    std::env::remove_var("HEALTH_SYNC_RUN_ID");
    std::env::remove_var("HEALTH_SYNC_REASON");
    std::env::remove_var("HEALTH_SYNC_TIMEOUT_BUDGET_MS");

    let default_paths = AppPaths::from_env();
    assert_eq!(default_paths.app_root, PathBuf::from("/app"));

    let env = TestEnv::new("env-load");
    std::env::set_var("portico_HEALTH_CHECK_APP_ROOT", &env.paths.app_root);
    std::env::set_var("MCPO_REGULAR_HOST", "regular.example");
    std::env::set_var("MCPO_REGULAR_BASE_URL", "http://regular.example/base/");
    std::env::set_var("MCPO_CORE_HOST", "core.example");
    std::env::set_var("MCPO_CORE_BASE_URL", "http://core.example/base/");
    std::env::set_var("HOST_MCPO_HOST", "host.example");
    std::env::set_var("HOST_MCPO_BASE_URL", "http://host.example/base/");
    std::env::set_var("MCPO_REGULAR_LOCALHOST_PORT", "18765");
    std::env::set_var("MCPO_CORE_LOCALHOST_PORT", "18766");
    std::env::set_var("HOST_MCPO_LOCALHOST_PORT", "18890");
    std::env::set_var("WRITE_API_LOGS", "true");
    std::env::set_var("HEALTH_CHECK_MODE", "bogus");
    std::env::set_var("HEALTH_SYNC_SESSION_ID", "env-session");
    std::env::set_var("HEALTH_SYNC_RUN_ID", "env-run");
    std::env::set_var("HEALTH_SYNC_REASON", "env-reason");
    std::env::set_var("HEALTH_SYNC_TIMEOUT_BUDGET_MS", "12345");
    let from_env_paths = AppPaths::from_env();
    let config = RuntimeConfig::load(&from_env_paths);

    assert_eq!(from_env_paths.app_root, env.paths.app_root);
    assert_eq!(config.openwebui_base_url, "http://open-webui:8080");
    assert_eq!(config.mcpo_regular_host, "regular.example");
    assert_eq!(config.mcpo_regular_base_url, "http://regular.example/base");
    assert_eq!(config.mcpo_core_host, "core.example");
    assert_eq!(config.mcpo_core_base_url, "http://core.example/base");
    assert_eq!(config.host_mcpo_host, "host.example");
    assert_eq!(config.host_mcpo_base_url, "http://host.example/base");
    assert_eq!(config.mcpo_regular_localhost_port, "18765");
    assert_eq!(config.mcpo_core_localhost_port, "18766");
    assert_eq!(config.host_mcpo_localhost_port, "18890");
    assert_eq!(config.mode, HealthCheckMode::Full);
    assert!(config.sync_enabled);
    assert!(!config.core_only_sync);
    assert_eq!(config.health_sync_session_id, "env-session");
    assert_eq!(config.health_sync_run_id, "env-run");
    assert_eq!(config.health_sync_reason, "env-reason");
    assert_eq!(config.health_sync_timeout_budget_ms, Some(12345));
    assert!(config.write_api_logs);
    assert_eq!(
        HealthCheckMode::from_str("LIGHT"),
        Some(HealthCheckMode::Light)
    );
    assert_eq!(
        HealthCheckMode::from_str("startup-core"),
        Some(HealthCheckMode::StartupCore)
    );
    assert_eq!(HealthCheckMode::from_str("unknown"), None);
    assert_eq!(HealthCheckMode::Full.as_str(), "full");
    assert_eq!(HealthCheckMode::Light.as_str(), "light");
    assert_eq!(HealthCheckMode::StartupCore.as_str(), "startup-core");

    let retries = RetryConfig::default();
    assert_eq!(retries.main_retries, 50);
    assert_eq!(retries.main_delay, Duration::from_secs(5));
    assert_eq!(retries.redis_retries, 5);
    assert_eq!(retries.redis_delay, Duration::from_secs(2));
    assert_eq!(retries.auth_retries, 5);
    assert_eq!(retries.discovery_retries, 20);
    assert_eq!(retries.request_timeout, Duration::from_secs(20));

    fs::write(&env.paths.model_catalog_file, "[]").unwrap();
    assert!(load_models_from_model_catalog(&env.paths).is_err());
    fs::write(
        &env.paths.model_catalog_file,
        r#"
model_list:
  - model_name: "Claude Sonnet 4.6"
    model_info:
      disabled: true
      disabled_reason: "Coming soon."
      supports_reasoning: true
  - model_name: "Claude Sonnet 4.5"
    model_info:
      supports_reasoning: true
  - model_name: "Gemini 3.5 Flash"
    litellm_params:
      model: gemini/vertex/gemini-3.5-flash
    model_info:
      base_model: gemini-3.5-flash
      supports_reasoning: true
  - model_name: "embedding-model"
    model_info:
      supports_reasoning: true
"#,
    )
    .unwrap();
    assert_eq!(
        load_models_from_model_catalog(&env.paths).unwrap(),
        vec![
            ConfiguredBaseModel {
                id: "Claude Sonnet 4.6".to_string(),
                source_model_id: None,
                disabled: true,
                disabled_reason: Some("Coming soon.".to_string()),
            },
            ConfiguredBaseModel {
                id: "Claude Sonnet 4.5".to_string(),
                source_model_id: None,
                disabled: false,
                disabled_reason: None,
            },
            ConfiguredBaseModel {
                id: "Gemini 3.5 Flash".to_string(),
                source_model_id: Some("gemini-3.5-flash".to_string()),
                disabled: false,
                disabled_reason: None,
            },
        ]
    );
    fs::write(&env.paths.konami_unlock_flag_file, "").unwrap();
    fs::write(
        &env.paths.model_catalog_file,
        r#"
model_list:
  - model_name: "GPT-5.4 pro"
    model_info:
      disabled: true
      disabled_reason: "Temporarily disabled due to high costs"
  - model_name: "GPT-5.4"
"#,
    )
    .unwrap();
    assert_eq!(
        load_models_from_model_catalog(&env.paths).unwrap(),
        vec![
            ConfiguredBaseModel {
                id: "GPT-5.4 pro".to_string(),
                source_model_id: None,
                disabled: true,
                disabled_reason: Some("Temporarily disabled due to high costs".to_string()),
            },
            ConfiguredBaseModel {
                id: "GPT-5.4".to_string(),
                source_model_id: None,
                disabled: false,
                disabled_reason: None,
            },
        ]
    );
    fs::remove_file(&env.paths.konami_unlock_flag_file).ok();

    assert_eq!(build_http_error_message(None, "boom"), "boom");
    assert!(!has_model_sync_completed_for_session(&env.paths, "").unwrap());
    let marker = env.paths.model_sync_completed_session_file.clone();
    fs::remove_file(&marker).ok();
    mark_model_sync_completed_for_session(&env.paths, "").unwrap();
    assert!(!marker.exists());

    fs::remove_dir_all(&env.paths.api_log_dir).ok();
    log_api_call(&env.paths, false, "disabled", None, None, None).unwrap();
    assert!(!env.paths.api_log_dir.exists());
    log_api_call(
        &env.paths,
        true,
        "enabled",
        Some(json!({ "request": true })),
        Some(json!({ "response": true })),
        Some("problem"),
    )
    .unwrap();
    let log_file = fs::read_dir(&env.paths.api_log_dir)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let log_payload: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(log_file).unwrap()).unwrap();
    assert_eq!(log_payload["operation"], json!("enabled"));
    assert_eq!(log_payload["success"], json!(false));

    fs::write(&env.paths.host_mode_file, "TRUE").unwrap();
    assert!(is_host_mode_supported(&env.paths));
    fs::write(&env.paths.host_mode_file, "true\n").unwrap();
    assert!(is_host_mode_supported(&env.paths));
    fs::write(&env.paths.host_mode_file, " True \n").unwrap();
    assert!(is_host_mode_supported(&env.paths));
    fs::write(&env.paths.host_mode_file, "FALSE").unwrap();
    assert!(!is_host_mode_supported(&env.paths));

    fs::remove_file(&env.paths.mcp_toggles_file).unwrap();
    assert!(load_mcp_toggles(&env.paths).is_err());
    fs::write(&env.paths.mcp_toggles_file, "{not json").unwrap();
    assert!(load_mcp_toggles(&env.paths).is_err());
    fs::remove_file(&env.paths.user_env_file).unwrap();
    assert!(load_env_file(&env.paths.user_env_file).unwrap().is_empty());
    let missing_file = env.paths.app_root.join("missing.env");
    assert!(load_env_file(&missing_file).unwrap().is_empty());

    assert!(is_truthy("on"));
    assert!(is_truthy("YES"));
    assert!(!is_truthy("off"));
    let tagged_yaml: serde_yaml::Value = serde_yaml::from_str("!Tagged value").unwrap();
    assert!(yaml_truthy(Some(&serde_yaml::Value::Bool(true))));
    assert!(yaml_truthy(Some(&serde_yaml::Value::Sequence(vec![
        serde_yaml::Value::Bool(false)
    ]))));
    assert!(yaml_truthy(Some(&serde_yaml::Value::Mapping(
        serde_yaml::Mapping::from_iter([(
            serde_yaml::Value::String("key".to_string()),
            serde_yaml::Value::String("value".to_string()),
        )])
    ))));
    assert!(yaml_truthy(Some(&serde_yaml::Value::String(
        "x".to_string()
    ))));
    assert!(yaml_truthy(Some(&serde_yaml::Value::Number(
        serde_yaml::Number::from(1)
    ))));
    assert!(yaml_truthy(Some(&tagged_yaml)));
    assert!(!yaml_truthy(Some(&serde_yaml::Value::Null)));
    assert!(!yaml_truthy(None));

    assert_eq!(
        get_proxy_base_url_for_host(&config, &config.mcpo_core_host),
        config.mcpo_core_base_url
    );
    assert_eq!(
        get_proxy_base_url_for_host(&config, &config.mcpo_regular_host),
        config.mcpo_regular_base_url
    );
    assert_eq!(
        get_proxy_base_url_for_host(&config, &config.host_mcpo_host),
        config.host_mcpo_base_url
    );
    assert_eq!(
        get_proxy_base_url_for_host(&config, "unknown-host"),
        "http://unknown-host"
    );

    let mut oauth = OAuthStatusPayload::default();
    merge_oauth_status_payload(
        &mut oauth,
        &json!({
            "current": { "server_name": "alpha" },
            "active": [{ "server_name": "active" }],
            "pending": [{ "server_name": "pending" }],
            "checking": [{ "server_name": "checking" }],
            "waiting_callback": [{ "server_name": "waiting" }],
            "completed": [{ "server_name": "completed" }],
            "failed": [{ "server_name": "failed" }],
            "timeout": [{ "server_name": "timeout" }]
        }),
    );
    assert_eq!(
        oauth.current.as_ref().unwrap()["server_name"],
        json!("alpha")
    );
    assert_eq!(oauth.active.len(), 1);
    assert_eq!(oauth.timeout.len(), 1);

    let mut model = json!({ "id": "model-1", "user": { "old": true }, "info": { "old": true } });
    let meta = ensure_object_field(&mut model, "meta");
    meta.insert("toolIds".to_string(), json!(["server:skills"]));
    let sanitized = sanitize_model_for_update(&model, "user-9");
    assert_eq!(sanitized["user_id"], json!("user-9"));
    assert!(sanitized.get("user").is_none());
    assert!(sanitized.get("info").is_none());
    assert_eq!(title_case_tool_name("hello_world-tool"), "Hello World Tool");
    assert_eq!(
        title_case_tool_name("get_lm_studio_status"),
        "Get LM Studio Status"
    );
    assert_eq!(sequence_match_ratio("", ""), 1.0);
    let configured_models = vec![
        ConfiguredBaseModel {
            id: "kept".to_string(),
            source_model_id: None,
            disabled: false,
            disabled_reason: None,
        },
        ConfiguredBaseModel {
            id: "other".to_string(),
            source_model_id: None,
            disabled: false,
            disabled_reason: None,
        },
        ConfiguredBaseModel {
            id: "disabled".to_string(),
            source_model_id: None,
            disabled: true,
            disabled_reason: Some("cost".to_string()),
        },
    ];
    assert_eq!(
        resolve_target_default_model(Some("kept".to_string()), &configured_models, true),
        "kept"
    );
    assert_eq!(
        resolve_target_default_model(Some("missing".to_string()), &configured_models, true),
        "kept"
    );
    assert_eq!(
        resolve_target_default_model(Some("kept".to_string()), &[], false),
        "kept"
    );
    assert_eq!(
        resolve_target_default_model(Some("disabled".to_string()), &configured_models, true),
        "kept"
    );
    assert_eq!(
        resolve_target_default_model(Some("missing".to_string()), &[], true),
        "Claude Sonnet 5"
    );
    assert_eq!(
        resolve_target_default_model(Some("".to_string()), &[], true),
        "Claude Sonnet 5"
    );
    assert_eq!(
        resolve_target_default_model(Some("   ".to_string()), &[], false),
        "Claude Sonnet 5"
    );
    let mixed_default_models = vec![
        ConfiguredBaseModel {
            id: "GPT-5.4".to_string(),
            source_model_id: None,
            disabled: false,
            disabled_reason: None,
        },
        ConfiguredBaseModel {
            id: "Claude Sonnet 5".to_string(),
            source_model_id: None,
            disabled: false,
            disabled_reason: None,
        },
        ConfiguredBaseModel {
            id: "Claude Sonnet 4.6".to_string(),
            source_model_id: None,
            disabled: false,
            disabled_reason: None,
        },
    ];
    assert_eq!(
        resolve_target_default_model(None, &mixed_default_models, true),
        "Claude Sonnet 5"
    );
    let claude_models = vec![
        ConfiguredBaseModel {
            id: "Claude Sonnet 5".to_string(),
            source_model_id: None,
            disabled: false,
            disabled_reason: None,
        },
        ConfiguredBaseModel {
            id: "Claude Sonnet 4.6".to_string(),
            source_model_id: None,
            disabled: false,
            disabled_reason: None,
        },
        ConfiguredBaseModel {
            id: "Claude Opus 5".to_string(),
            source_model_id: None,
            disabled: false,
            disabled_reason: None,
        },
        ConfiguredBaseModel {
            id: "Claude Opus 4.8".to_string(),
            source_model_id: None,
            disabled: false,
            disabled_reason: None,
        },
    ];
    // A default previously set to Sonnet 4.6 migrates to Sonnet 5 on sync.
    assert_eq!(
        resolve_target_default_model(Some("Claude Sonnet 4.6".to_string()), &claude_models, true),
        "Claude Sonnet 5"
    );
    // Without a model sync, an explicit Sonnet 4.6 default is preserved.
    assert_eq!(
        resolve_target_default_model(Some("Claude Sonnet 4.6".to_string()), &claude_models, false),
        "Claude Sonnet 4.6"
    );
    assert_eq!(
        resolve_target_default_model(Some("Claude Sonnet 5".to_string()), &claude_models, true),
        "Claude Sonnet 5"
    );
    // Retired Opus defaults migrate to Claude Opus 5 on sync.
    assert_eq!(
        resolve_target_default_model(Some("Claude Opus 4.7".to_string()), &claude_models, true),
        "Claude Opus 5"
    );
    assert_eq!(
        resolve_target_default_model(Some("Claude Opus 4.6".to_string()), &claude_models, true),
        "Claude Opus 5"
    );
    assert_eq!(
        resolve_target_default_model(Some("Claude Opus 5".to_string()), &claude_models, true),
        "Claude Opus 5"
    );
    assert_eq!(
        resolve_target_default_model(Some("Claude Opus 4.8".to_string()), &claude_models, true),
        "Claude Opus 4.8"
    );
    assert_eq!(
        resolve_target_default_model(Some("claude-sonnet-4".to_string()), &claude_models, true),
        "Claude Sonnet 5"
    );
    assert_eq!(
        unwrap_models_response(&json!([{ "id": 1 }])),
        vec![json!({ "id": 1 })]
    );
    assert!(unwrap_models_response(&json!({ "not": "an array" })).is_empty());

    for key in [
        "portico_HEALTH_CHECK_APP_ROOT",
        "MCPO_REGULAR_HOST",
        "MCPO_REGULAR_BASE_URL",
        "MCPO_CORE_HOST",
        "MCPO_CORE_BASE_URL",
        "HOST_MCPO_HOST",
        "HOST_MCPO_BASE_URL",
        "MCPO_REGULAR_LOCALHOST_PORT",
        "MCPO_CORE_LOCALHOST_PORT",
        "HOST_MCPO_LOCALHOST_PORT",
        "WRITE_API_LOGS",
        "HEALTH_CHECK_MODE",
        "HEALTH_SYNC_SESSION_ID",
        "HEALTH_SYNC_RUN_ID",
        "HEALTH_SYNC_REASON",
        "HEALTH_SYNC_TIMEOUT_BUDGET_MS",
    ] {
        std::env::remove_var(key);
    }
}

#[test]
#[serial]
fn health_sync_metadata_uses_env_then_files_then_defaults() {
    for key in [
        "HEALTH_SYNC_RUN_ID",
        "HEALTH_SYNC_REASON",
        "HEALTH_SYNC_TIMEOUT_BUDGET_MS",
    ] {
        std::env::remove_var(key);
    }

    let env = TestEnv::new("metadata-files");
    fs::create_dir_all(&env.paths.health_status_dir).unwrap();
    fs::write(&env.paths.health_sync_run_id_file, " file-run \n").unwrap();
    fs::write(&env.paths.health_sync_reason_file, " file-reason \n").unwrap();
    fs::write(&env.paths.health_sync_timeout_budget_ms_file, " 45678 \n").unwrap();

    assert_eq!(get_health_sync_run_id(&env.paths), "file-run");
    assert_eq!(get_health_sync_reason(&env.paths), "file-reason");
    assert_eq!(get_health_sync_timeout_budget_ms(&env.paths), Some(45678));

    std::env::set_var("HEALTH_SYNC_RUN_ID", " env-run ");
    std::env::set_var("HEALTH_SYNC_REASON", " env-reason ");
    std::env::set_var("HEALTH_SYNC_TIMEOUT_BUDGET_MS", "12345");
    assert_eq!(get_health_sync_run_id(&env.paths), "env-run");
    assert_eq!(get_health_sync_reason(&env.paths), "env-reason");
    assert_eq!(get_health_sync_timeout_budget_ms(&env.paths), Some(12345));

    std::env::remove_var("HEALTH_SYNC_RUN_ID");
    std::env::remove_var("HEALTH_SYNC_REASON");
    std::env::remove_var("HEALTH_SYNC_TIMEOUT_BUDGET_MS");
    fs::write(&env.paths.health_sync_run_id_file, " \n").unwrap();
    fs::write(&env.paths.health_sync_reason_file, " \n").unwrap();
    fs::write(
        &env.paths.health_sync_timeout_budget_ms_file,
        "not-a-number\n",
    )
    .unwrap();

    assert!(!get_health_sync_run_id(&env.paths).is_empty());
    assert_eq!(get_health_sync_reason(&env.paths), "unspecified");
    assert_eq!(get_health_sync_timeout_budget_ms(&env.paths), None);

    fs::remove_file(&env.paths.health_sync_run_id_file).unwrap();
    fs::remove_file(&env.paths.health_sync_reason_file).unwrap();
    fs::remove_file(&env.paths.health_sync_timeout_budget_ms_file).unwrap();
    assert!(!get_health_sync_run_id(&env.paths).is_empty());
    assert_eq!(get_health_sync_reason(&env.paths), "unspecified");
    assert_eq!(get_health_sync_timeout_budget_ms(&env.paths), None);
}

#[test]
fn build_user_settings_payload_preserves_numeric_text_scale_only() {
    let payload = build_user_settings_payload(
        &json!({
            "ui": {
                "models": ["Custom"],
                "textScale": 1.25,
                "chatDirection": "RTL",
                "params": {
                    "temperature": 0.4
                }
            }
        }),
        "Claude Sonnet 4.5",
    );

    assert_eq!(payload["ui"]["models"], json!(["Claude Sonnet 4.5"]));
    assert_eq!(payload["ui"]["textScale"], json!(1.25));
    assert_eq!(payload["ui"]["params"]["function_calling"], json!("native"));
    assert!(payload["ui"].get("chatDirection").is_none());
    assert!(payload["ui"]["params"].get("temperature").is_none());
}

#[test]
fn build_user_settings_payload_ignores_missing_or_invalid_text_scale() {
    for user_settings in [
        json!({}),
        json!({ "ui": { "textScale": null } }),
        json!({ "ui": { "textScale": "1.25" } }),
        json!({ "ui": { "textScale": true } }),
    ] {
        let payload = build_user_settings_payload(&user_settings, "Claude Sonnet 4.5");
        assert!(payload["ui"].get("textScale").is_none());
    }
}

#[tokio::test]
async fn api_client_and_model_crud_helpers_cover_success_and_error_paths() {
    let server = MockServer::start().await;
    let mut client = OpenWebUiClient::new(Client::new(), &server.base_url, Duration::from_secs(5));
    client.set_token("token-1");

    server.queue_json("GET", "/query?a=1&b=two", 200, json!({ "ok": true }));
    let query_payload = client
        .get_json(
            "/query",
            Some(&[
                ("a", "1".to_string()),
                ("b", "two".to_string()),
                ("skip", "".to_string()),
            ]),
        )
        .await
        .unwrap();
    assert_eq!(query_payload["ok"], json!(true));
    let query_request = server
        .requests()
        .into_iter()
        .find(|request| request.path.starts_with("/query"))
        .unwrap();
    assert_eq!(
        query_request.authorization.as_deref(),
        Some("Bearer token-1")
    );

    let empty_json = parse_json_response(
        "/empty",
        &RawResponse {
            ok: true,
            status: Some(200),
            content_type: "application/json".to_string(),
            text: "".to_string(),
            method: "GET".to_string(),
            path: "/empty".to_string(),
            duration_ms: 1,
            response_bytes: 0,
        },
    )
    .unwrap();
    assert_eq!(empty_json, serde_json::Value::Null);
    let parse_error = parse_json_response(
        "/bad",
        &RawResponse {
            ok: true,
            status: Some(200),
            content_type: "".to_string(),
            text: "not-json body".to_string(),
            method: "GET".to_string(),
            path: "/bad".to_string(),
            duration_ms: 1,
            response_bytes: 13,
        },
    )
    .unwrap_err();
    assert!(parse_error.to_string().contains("content-type=unknown"));

    server.queue_json("POST", "/post-json", 200, json!({ "saved": true }));
    assert_eq!(
        client
            .post_json("/post-json", Some(&json!({ "x": 1 })), None)
            .await
            .unwrap()["saved"],
        json!(true)
    );

    server.queue_text("POST", "/post-text", 200, "done", "text/plain");
    assert_eq!(
        client
            .post_text("/post-text", Some(&json!({ "x": 1 })), None)
            .await
            .unwrap(),
        "done"
    );

    server.queue_text("DELETE", "/delete-me", 200, "", "text/plain");
    client.delete("/delete-me", None).await.unwrap();
    server.queue_text("DELETE", "/delete-fail", 500, "broken", "text/plain");
    let delete_error = client.delete("/delete-fail", None).await.unwrap_err();
    assert_eq!(delete_error.status, Some(500));

    server.queue_json(
        "POST",
        "/api/v1/portico/auth/service-token",
        200,
        json!({ "access_token": "service-token" }),
    );
    assert_eq!(
        client.service_token("bridge-test-secret").await.unwrap(),
        "service-token"
    );
    assert_eq!(
        server
            .requests()
            .last()
            .and_then(|request| request.authorization.as_deref()),
        Some("Bearer bridge-test-secret")
    );
    server.queue_json(
        "POST",
        "/api/v1/portico/auth/service-token",
        200,
        json!({ "ok": true }),
    );
    assert!(client
        .service_token("bridge-test-secret")
        .await
        .unwrap_err()
        .to_string()
        .contains("no token"));

    let retries = RetryConfig {
        auth_retries: 3,
        auth_delay: Duration::ZERO,
        ..fast_retries()
    };
    server.queue_json("GET", "/api/v1/auths/", 500, json!({ "error": "retry" }));
    server.queue_json("GET", "/api/v1/auths/", 200, json!({ "id": "" }));
    server.queue_json("GET", "/api/v1/auths/", 200, json!({ "id": "user-42" }));
    assert_eq!(
        get_openwebui_user_id(&client, &retries).await.unwrap(),
        Some("user-42".to_string())
    );
    server.queue_json("GET", "/api/v1/auths/", 200, json!({ "id": "" }));
    assert_eq!(
        get_openwebui_user_id(
            &client,
            &RetryConfig {
                auth_retries: 1,
                auth_delay: Duration::ZERO,
                ..fast_retries()
            }
        )
        .await
        .unwrap(),
        None
    );

    server.queue_json(
        "GET",
        "/api/v1/models/model?id=model-ok",
        200,
        json!({ "id": "model-ok" }),
    );
    assert_eq!(
        get_model_by_id(&client, "model-ok").await.unwrap().unwrap()["id"],
        json!("model-ok")
    );
    server.queue_json(
        "GET",
        "/api/v1/models/model?id=model-null",
        200,
        serde_json::Value::Null,
    );
    assert!(get_model_by_id(&client, "model-null")
        .await
        .unwrap()
        .is_none());
    server.queue_json(
        "GET",
        "/api/v1/models/model?id=model-list",
        200,
        json!([{ "id": "wrong-shape" }]),
    );
    assert!(get_model_by_id(&client, "model-list")
        .await
        .unwrap()
        .is_none());
    server.queue_json(
        "GET",
        "/api/v1/models/model?id=model-missing",
        404,
        json!({ "error": "missing" }),
    );
    assert!(get_model_by_id(&client, "model-missing")
        .await
        .unwrap()
        .is_none());
    server.queue_json(
        "GET",
        "/api/v1/models/model?id=model-owui-401-missing",
        401,
        json!({ "detail": "We could not find what you're looking for :/" }),
    );
    assert!(get_model_by_id(&client, "model-owui-401-missing")
        .await
        .unwrap()
        .is_none());
    server.queue_json(
        "GET",
        "/api/v1/models/model?id=model-auth-failure",
        401,
        json!({ "detail": "Not authenticated" }),
    );
    assert!(get_model_by_id(&client, "model-auth-failure")
        .await
        .is_err());
    server.queue_text(
        "POST",
        "/api/v1/models/model/update?id=model-ok",
        200,
        "ok",
        "text/plain",
    );
    assert!(
        update_model_by_id(&client, "model-ok", &json!({ "id": "model-ok" }))
            .await
            .unwrap()
    );
    server.queue_text(
        "POST",
        "/api/v1/models/model/update?id=model-fail",
        500,
        "nope",
        "text/plain",
    );
    assert!(
        !update_model_by_id(&client, "model-fail", &json!({ "id": "model-fail" }))
            .await
            .unwrap()
    );
    server.queue_text("POST", "/api/v1/models/create", 500, "bad", "text/plain");
    assert!(!create_model(&client, &json!({ "id": "created" }))
        .await
        .unwrap());

    server.queue_text(
        "POST",
        "/api/v1/models/model/delete",
        200,
        "ok",
        "text/plain",
    );
    assert!(delete_model_with_fallbacks(&client, "delete-now")
        .await
        .unwrap());

    server.queue_json(
        "GET",
        "/api/v1/portico/managed-functions/id/portico_core_absent",
        404,
        json!({ "error": "missing" }),
    );
    assert!(get_managed_function(&client, "portico_core_absent")
        .await
        .is_err());
}

#[test]
fn oauth_status_and_health_mapping_helpers_cover_all_states() {
    let config = base_config(
        HealthCheckMode::Light,
        "http://openwebui",
        "http://core.base",
        "http://regular.base",
        "http://host.base",
        "session-status-helpers",
    );
    let docker_metadata = ServerMetadata {
        id: "server-a".to_string(),
        name: "Server A".to_string(),
        deployment_type: "docker".to_string(),
        is_core: false,
        has_oauth: true,
        user_installed: false,
        is_configured: true,
        config_error: None,
    };
    let host_metadata = ServerMetadata {
        deployment_type: "host".to_string(),
        ..docker_metadata.clone()
    };
    let unconfigured_metadata = ServerMetadata {
        is_configured: false,
        ..docker_metadata.clone()
    };
    let payload = OAuthStatusPayload {
        current: Some(
            json!({ "server_name": "current", "state": "waiting_callback", "error_message": "wait" }),
        ),
        active: vec![
            json!({ "server_name": "active", "state": "active", "error_message": "active error" }),
        ],
        pending: vec![json!({ "server_name": "pending" })],
        checking: vec![json!({ "server_name": "checking", "error_message": "checking error" })],
        waiting_callback: vec![json!({ "server_name": "waiting" })],
        completed: vec![json!({ "server_name": "done" })],
        failed: vec![json!({ "server_name": "failed", "error_message": "failed error" })],
        timeout: vec![json!({ "server_name": "timeout", "error_message": "timeout error" })],
    };

    assert_eq!(
        lookup_oauth_status_no_tools("current", &payload),
        (
            Some("waiting_callback".to_string()),
            Some("wait".to_string())
        )
    );
    assert_eq!(
        lookup_oauth_status_no_tools("active", &payload),
        (Some("active".to_string()), Some("active error".to_string()))
    );
    assert_eq!(
        lookup_oauth_status_no_tools("pending", &payload),
        (Some("pending".to_string()), None)
    );
    assert_eq!(
        lookup_oauth_status_no_tools("checking", &payload),
        (
            Some("checking".to_string()),
            Some("checking error".to_string())
        )
    );
    assert_eq!(
        lookup_oauth_status_no_tools("waiting", &payload),
        (Some("waiting_callback".to_string()), None)
    );
    assert_eq!(
        lookup_oauth_status_no_tools("timeout", &payload),
        (
            Some("timeout".to_string()),
            Some("timeout error".to_string())
        )
    );
    assert_eq!(
        lookup_oauth_status_no_tools("failed", &payload),
        (Some("failed".to_string()), Some("failed error".to_string()))
    );
    assert_eq!(
        lookup_oauth_status_no_tools("unknown", &payload),
        (None, None)
    );

    assert_eq!(
        lookup_oauth_status_running("current", &payload),
        (
            Some("waiting_callback".to_string()),
            Some("wait".to_string())
        )
    );
    assert_eq!(
        lookup_oauth_status_running("active", &payload),
        (Some("active".to_string()), Some("active error".to_string()))
    );
    assert_eq!(
        lookup_oauth_status_running("pending", &payload),
        (Some("pending".to_string()), None)
    );
    assert_eq!(
        lookup_oauth_status_running("checking", &payload),
        (
            Some("checking".to_string()),
            Some("checking error".to_string())
        )
    );
    assert_eq!(
        lookup_oauth_status_running("waiting", &payload),
        (Some("waiting_callback".to_string()), None)
    );
    assert_eq!(
        lookup_oauth_status_running("timeout", &payload),
        (
            Some("timeout".to_string()),
            Some("timeout error".to_string())
        )
    );
    assert_eq!(
        lookup_oauth_status_running("done", &payload),
        (Some("completed".to_string()), None)
    );
    assert_eq!(
        lookup_oauth_status_running("failed", &payload),
        (Some("failed".to_string()), Some("failed error".to_string()))
    );
    assert_eq!(
        lookup_oauth_status_running("unknown", &payload),
        (None, None)
    );

    assert_eq!(
        lookup_oauth_status_missing("current", &payload),
        (
            Some("waiting_callback".to_string()),
            Some("wait".to_string())
        )
    );
    assert_eq!(
        lookup_oauth_status_missing("active", &payload),
        (Some("active".to_string()), Some("active error".to_string()))
    );
    assert_eq!(
        lookup_oauth_status_missing("pending", &payload),
        (Some("pending".to_string()), None)
    );
    assert_eq!(
        lookup_oauth_status_missing("checking", &payload),
        (
            Some("checking".to_string()),
            Some("checking error".to_string())
        )
    );
    assert_eq!(
        lookup_oauth_status_missing("waiting", &payload),
        (Some("waiting_callback".to_string()), None)
    );
    assert_eq!(
        lookup_oauth_status_missing("timeout", &payload),
        (
            Some("timeout".to_string()),
            Some("timeout error".to_string())
        )
    );
    assert_eq!(
        lookup_oauth_status_missing("failed", &payload),
        (Some("failed".to_string()), Some("failed error".to_string()))
    );
    assert_eq!(
        lookup_oauth_status_missing("unknown", &payload),
        (None, None)
    );

    assert_eq!(
        health_status_for_no_tools_server(
            "active",
            &docker_metadata,
            &payload,
            &MockLogInspector::default(),
        )["status"],
        json!("needs_oauth")
    );
    assert_eq!(
        health_status_for_no_tools_server(
            "timeout",
            &docker_metadata,
            &payload,
            &MockLogInspector::default(),
        )["status"],
        json!("timeout")
    );
    assert_eq!(
        health_status_for_no_tools_server(
            "failed",
            &docker_metadata,
            &payload,
            &MockLogInspector::default(),
        )["status"],
        json!("failed")
    );
    assert_eq!(
        health_status_for_no_tools_server(
            "unknown",
            &docker_metadata,
            &payload,
            &MockLogInspector::default(),
        )["status"],
        json!("failed")
    );
    assert_eq!(
        health_status_for_no_tools_server(
            "unknown",
            &docker_metadata,
            &payload,
            &MockLogInspector::default(),
        )["error"],
        json!("Server started but exposed no tools (MCP server failed to initialize)")
    );

    let core_host = DiscoveredTool {
        host: config.mcpo_core_host.clone(),
        port: "8766".to_string(),
    };
    let regular_host = DiscoveredTool {
        host: config.mcpo_regular_host.clone(),
        port: "8765".to_string(),
    };
    let host_host = DiscoveredTool {
        host: config.host_mcpo_host.clone(),
        port: "8890".to_string(),
    };
    let unknown_host = DiscoveredTool {
        host: "other-host".to_string(),
        port: "9999".to_string(),
    };
    assert_eq!(
        health_status_for_running_server("failed", &docker_metadata, &core_host, &payload, &config)
            ["status"],
        json!("failed")
    );
    assert_eq!(
        health_status_for_running_server(
            "timeout",
            &docker_metadata,
            &regular_host,
            &payload,
            &config
        )["status"],
        json!("timeout")
    );
    assert_eq!(
        health_status_for_running_server(
            "pending",
            &docker_metadata,
            &regular_host,
            &payload,
            &config
        )["status"],
        json!("checking")
    );
    assert_eq!(
        health_status_for_running_server(
            "pending",
            &docker_metadata,
            &regular_host,
            &payload,
            &config
        )["error"],
        serde_json::Value::Null
    );
    assert_eq!(
        health_status_for_running_server(
            "current",
            &docker_metadata,
            &host_host,
            &payload,
            &config
        )["status"],
        json!("needs_oauth")
    );
    assert_eq!(
        health_status_for_running_server(
            "current",
            &docker_metadata,
            &host_host,
            &payload,
            &config
        )["error"],
        serde_json::Value::Null
    );
    assert_eq!(
        health_status_for_running_server(
            "done",
            &docker_metadata,
            &unknown_host,
            &payload,
            &config
        )["status"],
        json!("healthy")
    );
    assert_eq!(
        health_status_for_running_server(
            "done",
            &unconfigured_metadata,
            &regular_host,
            &payload,
            &config
        )["configured"],
        json!(true)
    );
    assert_eq!(
        health_status_for_running_server(
            "current",
            &docker_metadata,
            &host_host,
            &payload,
            &config
        )["deployment"],
        json!("host")
    );
    assert_eq!(
        health_status_for_running_server(
            "done",
            &docker_metadata,
            &unknown_host,
            &payload,
            &config
        )["deployment"],
        json!("unknown")
    );

    let inspector = MockLogInspector::default();
    let timeout_missing =
        health_status_for_missing_server("timeout", &docker_metadata, &payload, &inspector);
    assert_eq!(timeout_missing["status"], json!("timeout"));
    let pending_missing =
        health_status_for_missing_server("pending", &docker_metadata, &payload, &inspector);
    assert_eq!(pending_missing["status"], json!("checking"));
    let active_missing =
        health_status_for_missing_server("active", &docker_metadata, &payload, &inspector);
    assert_eq!(active_missing["status"], json!("needs_oauth"));
    let failed_missing =
        health_status_for_missing_server("failed", &docker_metadata, &payload, &inspector);
    assert_eq!(failed_missing["status"], json!("failed"));
    let not_configured =
        health_status_for_missing_server("unknown", &unconfigured_metadata, &payload, &inspector);
    assert_eq!(not_configured["status"], json!("not_configured"));
    let host_failed =
        health_status_for_missing_server("unknown", &host_metadata, &payload, &inspector);
    assert_eq!(host_failed["status"], json!("failed"));

    let inspector_failed = {
        let inspector = MockLogInspector::default();
        inspector.set_failure("mcpo-unknown", true);
        inspector
    };
    let docker_failed =
        health_status_for_missing_server("unknown", &docker_metadata, &payload, &inspector_failed);
    assert_eq!(docker_failed["status"], json!("failed"));

    let docker_starting = health_status_for_missing_server(
        "unknown",
        &docker_metadata,
        &payload,
        &MockLogInspector::default(),
    );
    assert_eq!(docker_starting["status"], json!("starting"));
}

#[tokio::test]
async fn model_sync_helpers_cover_backup_configure_migrate_apply_and_delete() {
    let env = TestEnv::new("model-sync-helpers");
    let openwebui = MockServer::start().await;
    let client = OpenWebUiClient::new(Client::new(), &openwebui.base_url, Duration::from_secs(5));

    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=backup-model",
        200,
        json!({ "params": { "system": "Backup prompt" } }),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=blank-model",
        200,
        json!({ "params": { "system": "" } }),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=missing-model",
        404,
        json!({ "error": "missing" }),
    );
    assert_eq!(
        backup_system_prompts(
            &env.paths,
            &client,
            &["backup-model".to_string(), "blank-model".to_string()],
        )
        .await
        .unwrap(),
        1
    );
    let backup_file = fs::read_dir(&env.paths.backup_dir)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert!(fs::read_to_string(backup_file)
        .unwrap()
        .contains("Backup prompt"));
    assert!(
        backup_system_prompts(&env.paths, &client, &["missing-model".to_string()],)
            .await
            .is_err()
    );

    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=Claude+Sonnet+4.5",
        200,
        json!({ "id": "Claude Sonnet 4.5", "meta": {}, "user": {}, "info": {} }),
    );
    openwebui.queue_text(
        "POST",
        "/api/v1/models/model/update?id=Claude+Sonnet+4.5",
        200,
        "ok",
        "text/plain",
    );
    let tools = vec![
        "server:mcp-assistant".to_string(),
        "server:skills".to_string(),
    ];
    let mut unchanged_model = json!({});
    let unchanged_configured_model = ConfiguredBaseModel {
        id: "Noop Model".to_string(),
        source_model_id: None,
        disabled: false,
        disabled_reason: None,
    };
    canonicalize_base_model_payload(
        &env.paths,
        &mut unchanged_model,
        &unchanged_configured_model,
        "Base system prompt",
        &tools,
        "Claude Sonnet 4.5",
    );
    let unchanged_model = sanitize_model_for_update(&unchanged_model, "user-1");
    let claude_configured_model = ConfiguredBaseModel {
        id: "Claude Sonnet 4.5".to_string(),
        source_model_id: None,
        disabled: false,
        disabled_reason: None,
    };
    let mut claude_readback = json!({});
    canonicalize_base_model_payload(
        &env.paths,
        &mut claude_readback,
        &claude_configured_model,
        "Base system prompt",
        &tools,
        "Claude Sonnet 4.5",
    );
    for transient_field in [
        "object",
        "created",
        "owned_by",
        "connection_type",
        "openai",
        "urlIdx",
        "is_default",
    ] {
        claude_readback
            .as_object_mut()
            .unwrap()
            .remove(transient_field);
    }
    claude_readback["created_at"] = json!(1_783_735_933_i64);
    claude_readback["updated_at"] = json!(1_783_735_933_i64);
    let gpt_configured_model = ConfiguredBaseModel {
        id: "GPT-5.4".to_string(),
        source_model_id: None,
        disabled: true,
        disabled_reason: Some("Temporarily disabled due to high costs".to_string()),
    };
    let mut gpt_readback = json!({});
    canonicalize_base_model_payload(
        &env.paths,
        &mut gpt_readback,
        &gpt_configured_model,
        "Base system prompt",
        &tools,
        "Claude Sonnet 4.5",
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=Noop+Model",
        200,
        unchanged_model,
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=GPT-5.4",
        404,
        json!({ "detail": "missing" }),
    );
    openwebui.queue_text("POST", "/api/v1/models/create", 200, "ok", "text/plain");
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=Claude+Sonnet+4.5",
        200,
        claude_readback,
    );
    openwebui.queue_json("GET", "/api/v1/models/model?id=GPT-5.4", 200, gpt_readback);
    let counts = configure_base_models(
        &env.paths,
        &client,
        "user-1",
        &[
            ConfiguredBaseModel {
                id: "Claude Sonnet 4.5".to_string(),
                source_model_id: None,
                disabled: false,
                disabled_reason: None,
            },
            ConfiguredBaseModel {
                id: "GPT-5.4".to_string(),
                source_model_id: None,
                disabled: true,
                disabled_reason: Some("Temporarily disabled due to high costs".to_string()),
            },
            unchanged_configured_model,
        ],
        &["Claude Sonnet 4.5".to_string()],
        "Base system prompt",
        &tools,
        "Claude Sonnet 4.5",
    )
    .await
    .unwrap();
    assert_eq!(
        (counts.updated, counts.created, counts.unchanged),
        (1, 1, 1)
    );
    let requests = openwebui.requests();
    let update_request = requests
        .iter()
        .find(|request| request.path == "/api/v1/models/model/update?id=Claude+Sonnet+4.5")
        .unwrap();
    let update_body: serde_json::Value = serde_json::from_str(&update_request.body).unwrap();
    assert_eq!(update_body["base_model_id"], serde_json::Value::Null);
    assert_eq!(update_body["is_active"], json!(true));
    assert_eq!(update_body["is_default"], json!(true));
    assert_eq!(update_body["params"]["system"], json!("Base system prompt"));
    assert_eq!(update_body["meta"]["disabled"], json!(false));
    assert!(update_body["meta"].get("disabled_reason").is_none());
    assert!(!requests
        .iter()
        .any(|request| request.path == "/api/v1/models/model/update?id=Noop+Model"));
    let create_request = requests
        .iter()
        .find(|request| request.path == "/api/v1/models/create")
        .unwrap();
    let create_body: serde_json::Value = serde_json::from_str(&create_request.body).unwrap();
    assert_eq!(create_body["id"], json!("GPT-5.4"));
    assert_eq!(create_body["base_model_id"], serde_json::Value::Null);
    assert_eq!(create_body["is_active"], json!(true));
    assert_eq!(create_body["is_default"], json!(false));
    assert_eq!(create_body["params"]["system"], json!("Base system prompt"));
    assert_eq!(create_body["meta"]["disabled"], json!(true));
    assert_eq!(
        create_body["meta"]["disabled_reason"],
        json!("Temporarily disabled due to high costs")
    );

    openwebui.queue_json(
        "GET",
        "/api/v1/models",
        200,
        json!([
            { "id": "migrate-me", "info": { "base_model_id": " OpenAI/Responses/GPT-5.4-PRO:LaTeSt " } },
            { "id": "sonnet-migrate", "info": { "base_model_id": "Claude Sonnet 4.5" } },
            { "id": "sonnet-46-agent", "info": { "base_model_id": "Claude Sonnet 4.6" } },
            { "id": "opus-migrate", "info": { "base_model_id": "Claude Opus 4.5" } },
            { "id": "opus-slug-migrate", "info": { "base_model_id": "claude-opus-4-5-thinking" } },
            { "id": "keep-me", "info": { "base_model_id": "not-mapped" } }
        ]),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=migrate-me",
        200,
        json!({ "id": "migrate-me", "base_model_id": " OpenAI/Responses/GPT-5.4-PRO:LaTeSt ", "meta": {}, "user": {}, "info": {} }),
    );
    openwebui.queue_text(
        "POST",
        "/api/v1/models/model/update?id=migrate-me",
        200,
        "ok",
        "text/plain",
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=sonnet-migrate",
        200,
        json!({ "id": "sonnet-migrate", "base_model_id": "Claude Sonnet 4.5", "meta": {}, "user": {}, "info": {} }),
    );
    openwebui.queue_text(
        "POST",
        "/api/v1/models/model/update?id=sonnet-migrate",
        200,
        "ok",
        "text/plain",
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=sonnet-46-agent",
        200,
        json!({ "id": "sonnet-46-agent", "base_model_id": "Claude Sonnet 4.6", "meta": {}, "user": {}, "info": {} }),
    );
    openwebui.queue_text(
        "POST",
        "/api/v1/models/model/update?id=sonnet-46-agent",
        200,
        "ok",
        "text/plain",
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=opus-migrate",
        200,
        json!({ "id": "opus-migrate", "base_model_id": "Claude Opus 4.5", "meta": {}, "user": {}, "info": {} }),
    );
    openwebui.queue_text(
        "POST",
        "/api/v1/models/model/update?id=opus-migrate",
        200,
        "ok",
        "text/plain",
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=opus-slug-migrate",
        200,
        json!({ "id": "opus-slug-migrate", "base_model_id": "claude-opus-4-5-thinking", "meta": {}, "user": {}, "info": {} }),
    );
    openwebui.queue_text(
        "POST",
        "/api/v1/models/model/update?id=opus-slug-migrate",
        200,
        "ok",
        "text/plain",
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=migrate-me",
        200,
        json!({ "id": "migrate-me", "base_model_id": "GPT-5.6 Sol Pro", "meta": {}, "info": { "base_model_id": "GPT-5.6 Sol Pro" } }),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=sonnet-migrate",
        200,
        json!({ "id": "sonnet-migrate", "base_model_id": "Claude Sonnet 5", "meta": {}, "info": { "base_model_id": "Claude Sonnet 5" } }),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=sonnet-46-agent",
        200,
        json!({ "id": "sonnet-46-agent", "base_model_id": "Claude Sonnet 5", "meta": {}, "info": { "base_model_id": "Claude Sonnet 5" } }),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=opus-migrate",
        200,
        json!({ "id": "opus-migrate", "base_model_id": "Claude Opus 5", "meta": {}, "info": { "base_model_id": "Claude Opus 5" } }),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=opus-slug-migrate",
        200,
        json!({ "id": "opus-slug-migrate", "base_model_id": "Claude Opus 5", "meta": {}, "info": { "base_model_id": "Claude Opus 5" } }),
    );
    assert_eq!(migrate_user_models(&client, "user-2").await.unwrap(), 5);
    let migration_requests = openwebui.requests();
    assert!(migration_requests
        .iter()
        .any(|request| { request.path == "/api/v1/models/model?id=sonnet-migrate" }));
    let mixed_case_migration_update = migration_requests
        .iter()
        .find(|request| request.path == "/api/v1/models/model/update?id=migrate-me")
        .unwrap();
    let mixed_case_migration_body: serde_json::Value =
        serde_json::from_str(&mixed_case_migration_update.body).unwrap();
    assert_eq!(
        mixed_case_migration_body["base_model_id"],
        json!("GPT-5.6 Sol Pro")
    );
    let sonnet_migration_update = migration_requests
        .iter()
        .find(|request| request.path == "/api/v1/models/model/update?id=sonnet-migrate")
        .unwrap();
    let sonnet_migration_body: serde_json::Value =
        serde_json::from_str(&sonnet_migration_update.body).unwrap();
    assert_eq!(
        sonnet_migration_body["base_model_id"],
        json!("Claude Sonnet 5")
    );
    // Agents pinned to Claude Sonnet 4.6 auto-upgrade to Claude Sonnet 5 (PORTICO-213).
    let sonnet_46_migration_update = migration_requests
        .iter()
        .find(|request| request.path == "/api/v1/models/model/update?id=sonnet-46-agent")
        .unwrap();
    let sonnet_46_migration_body: serde_json::Value =
        serde_json::from_str(&sonnet_46_migration_update.body).unwrap();
    assert_eq!(
        sonnet_46_migration_body["base_model_id"],
        json!("Claude Sonnet 5")
    );
    let opus_migration_update = migration_requests
        .iter()
        .find(|request| request.path == "/api/v1/models/model/update?id=opus-migrate")
        .unwrap();
    let opus_migration_body: serde_json::Value =
        serde_json::from_str(&opus_migration_update.body).unwrap();
    assert_eq!(
        opus_migration_body["base_model_id"],
        json!("Claude Opus 5")
    );
    let opus_slug_migration_update = migration_requests
        .iter()
        .find(|request| request.path == "/api/v1/models/model/update?id=opus-slug-migrate")
        .unwrap();
    let opus_slug_migration_body: serde_json::Value =
        serde_json::from_str(&opus_slug_migration_update.body).unwrap();
    assert_eq!(
        opus_slug_migration_body["base_model_id"],
        json!("Claude Opus 5")
    );

    let no_match_server = MockServer::start().await;
    let no_match_client = OpenWebUiClient::new(
        Client::new(),
        &no_match_server.base_url,
        Duration::from_secs(1),
    );
    no_match_server.queue_json(
        "GET",
        "/api/v1/models",
        200,
        json!([
            { "id": "keep-me", "info": { "base_model_id": "not-mapped" } },
            { "id": "base-model", "info": { "base_model_id": null } }
        ]),
    );
    assert_eq!(
        migrate_user_models(&no_match_client, "user-3")
            .await
            .unwrap(),
        0
    );
    let no_match_requests = no_match_server.requests();
    assert_eq!(
        no_match_requests
            .iter()
            .filter(|request| request.path.starts_with("/api/v1/models/model?id="))
            .count(),
        0
    );
    assert_eq!(
        no_match_requests
            .iter()
            .filter(|request| request.path.starts_with("/api/v1/models/model/update?id="))
            .count(),
        0
    );

    let scheduled_tasks_dir = env.paths.app_support_dir.join("scheduled_tasks");
    fs::create_dir_all(&scheduled_tasks_dir).unwrap();
    let sonnet_task_path = scheduled_tasks_dir.join("scheduled-task-sonnet.json");
    let sonnet_46_task_path = scheduled_tasks_dir.join("scheduled-task-sonnet-46.json");
    let opus_task_path = scheduled_tasks_dir.join("scheduled-task-opus-disabled.json");
    let gpt_task_path = scheduled_tasks_dir.join("scheduled-task-gpt.json");
    let keep_task_path = scheduled_tasks_dir.join("scheduled-task-keep.json");
    let sonnet_task = json!({
        "id": "scheduled-task-sonnet",
        "prompt": "Run a daily summary",
        "model_id": "Claude Sonnet 4.5",
        "schedule": {
            "kind": "cron",
            "cron_expression": "0 6 * * *",
            "run_at": null,
            "timezone": "America/New_York"
        },
        "skill_ids": [],
        "tool_server_ids": ["server:slack"],
        "enabled": true,
        "created_at": "2026-04-02T08:01:17Z",
        "updated_at": "2026-04-20T14:24:34Z",
        "next_run_at": "2026-04-21T10:00:00Z",
        "last_run_at": "2026-04-20T14:24:34Z",
        "last_run_status": "failed",
        "last_run_chat_id": null,
        "last_run_error": "Model 'Claude Sonnet 4.5' not found in available models",
        "last_run_response_preview": null,
        "last_run_trigger": "scheduled",
        "future_unknown_field": {
            "preserve": true
        }
    });
    let opus_task = json!({
        "id": "scheduled-task-opus-disabled",
        "prompt": "Run an old opus task",
        "model_id": "Claude Opus 4.5",
        "schedule": {
            "kind": "cron",
            "cron_expression": "0 9 * * *",
            "run_at": null,
            "timezone": "UTC"
        },
        "skill_ids": [],
        "tool_server_ids": [],
        "enabled": false,
        "created_at": "2026-04-01T00:00:00Z",
        "updated_at": "2026-04-01T00:00:00Z",
        "next_run_at": null,
        "last_run_at": null,
        "last_run_status": null,
        "last_run_chat_id": null,
        "last_run_error": null,
        "last_run_response_preview": null,
        "last_run_trigger": null
    });
    let gpt_task = json!({
        "id": "scheduled-task-gpt",
        "prompt": "Run an old GPT task",
        "model_id": "portico-openai/GPT-4.1-MINI:LATEST",
        "schedule": {
            "kind": "once",
            "cron_expression": null,
            "run_at": "2030-01-01T00:00:00Z",
            "timezone": "UTC"
        },
        "skill_ids": [],
        "tool_server_ids": [],
        "enabled": true,
        "created_at": "2026-04-01T00:00:00Z",
        "updated_at": "2026-04-01T00:00:00Z",
        "next_run_at": "2030-01-01T00:00:00Z",
        "last_run_at": null,
        "last_run_status": null,
        "last_run_chat_id": null,
        "last_run_error": null,
        "last_run_response_preview": null,
        "last_run_trigger": null
    });
    let sonnet_46_task = json!({
        "id": "scheduled-task-sonnet-46",
        "prompt": "Runs on the previous default model",
        "model_id": "Claude Sonnet 4.6",
        "schedule": {
            "kind": "cron",
            "cron_expression": "0 8 * * *",
            "run_at": null,
            "timezone": "UTC"
        },
        "skill_ids": [],
        "tool_server_ids": [],
        "enabled": true,
        "created_at": "2026-04-01T00:00:00Z",
        "updated_at": "2026-04-01T00:00:00Z",
        "next_run_at": "2026-04-02T08:00:00Z",
        "last_run_at": null,
        "last_run_status": null,
        "last_run_chat_id": null,
        "last_run_error": null,
        "last_run_response_preview": null,
        "last_run_trigger": null
    });
    let keep_task = json!({
        "id": "scheduled-task-keep",
        "prompt": "Already current",
        "model_id": "Claude Haiku 4.5",
        "schedule": {
            "kind": "cron",
            "cron_expression": "0 10 * * *",
            "run_at": null,
            "timezone": "UTC"
        },
        "skill_ids": [],
        "tool_server_ids": [],
        "enabled": true,
        "created_at": "2026-04-01T00:00:00Z",
        "updated_at": "2026-04-01T00:00:00Z",
        "next_run_at": "2026-04-02T10:00:00Z",
        "last_run_at": null,
        "last_run_status": null,
        "last_run_chat_id": null,
        "last_run_error": null,
        "last_run_response_preview": null,
        "last_run_trigger": null
    });
    fs::write(
        &sonnet_task_path,
        serde_json::to_string_pretty(&sonnet_task).unwrap(),
    )
    .unwrap();
    fs::write(
        &opus_task_path,
        serde_json::to_string_pretty(&opus_task).unwrap(),
    )
    .unwrap();
    fs::write(
        &gpt_task_path,
        serde_json::to_string_pretty(&gpt_task).unwrap(),
    )
    .unwrap();
    fs::write(
        &sonnet_46_task_path,
        serde_json::to_string_pretty(&sonnet_46_task).unwrap(),
    )
    .unwrap();
    fs::write(
        &keep_task_path,
        serde_json::to_string_pretty(&keep_task).unwrap(),
    )
    .unwrap();
    assert_eq!(migrate_scheduled_task_models(&env.paths).unwrap(), 4);

    let sonnet_after: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&sonnet_task_path).unwrap()).unwrap();
    let mut expected_sonnet = sonnet_task.clone();
    expected_sonnet["model_id"] = json!("Claude Sonnet 5");
    expected_sonnet["updated_at"] = sonnet_after["updated_at"].clone();
    assert_ne!(sonnet_after["updated_at"], sonnet_task["updated_at"]);
    assert_eq!(sonnet_after, expected_sonnet);

    let sonnet_46_after: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&sonnet_46_task_path).unwrap()).unwrap();
    assert_eq!(sonnet_46_after["model_id"], json!("Claude Sonnet 5"));
    assert_ne!(sonnet_46_after["updated_at"], sonnet_46_task["updated_at"]);

    let opus_after: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&opus_task_path).unwrap()).unwrap();
    assert_eq!(opus_after["model_id"], json!("Claude Opus 5"));
    assert_eq!(opus_after["enabled"], json!(false));

    let gpt_after: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&gpt_task_path).unwrap()).unwrap();
    assert_eq!(gpt_after["model_id"], json!("GPT-5.6 Terra"));

    let keep_after: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&keep_task_path).unwrap()).unwrap();
    assert_eq!(keep_after, keep_task);
    fs::write(scheduled_tasks_dir.join("broken.json"), "{").unwrap();
    fs::write(scheduled_tasks_dir.join("array.json"), "[]").unwrap();
    fs::write(scheduled_tasks_dir.join("ignored.txt"), "not json").unwrap();
    assert!(migrate_scheduled_task_models(&env.paths).is_err());
    assert_eq!(
        fs::read_to_string(scheduled_tasks_dir.join("broken.json")).unwrap(),
        "{"
    );

    let mut migration_data = json!({
        "numeric_to_stable": { "server:1": "server:skills" },
        "unmappable_ids": {},
        "models_with_unmappable": []
    });
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=apply-ok",
        200,
        json!({ "id": "apply-ok", "name": "Apply Ok", "meta": { "toolIds": ["server:1"] }, "user": {}, "info": {} }),
    );
    openwebui.queue_text(
        "POST",
        "/api/v1/models/model/update?id=apply-ok",
        200,
        "ok",
        "text/plain",
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=apply-ok",
        200,
        json!({ "id": "apply-ok", "name": "Apply Ok", "meta": { "toolIds": ["server:skills"] }, "info": {} }),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=apply-missing",
        404,
        json!({ "error": "missing" }),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=apply-fail",
        200,
        json!({ "id": "apply-fail", "name": "Apply Fail", "meta": { "toolIds": ["server:2"] }, "user": {}, "info": {} }),
    );
    openwebui.queue_text(
        "POST",
        "/api/v1/models/model/update?id=apply-fail",
        500,
        "nope",
        "text/plain",
    );
    let migrated = apply_tool_id_migration(
        &env.paths,
        &client,
        "user-3",
        &BTreeMap::from([("apply-ok".to_string(), vec!["server:skills".to_string()])]),
        &mut migration_data,
    )
    .await
    .unwrap();
    assert_eq!(migrated, 1);
    assert_eq!(
        migration_data["models_migrated"].as_array().unwrap().len(),
        1
    );
    assert!(apply_tool_id_migration(
        &env.paths,
        &client,
        "user-3",
        &BTreeMap::from([("apply-missing".to_string(), vec!["server:time".to_string()])]),
        &mut migration_data,
    )
    .await
    .is_err());
    assert!(apply_tool_id_migration(
        &env.paths,
        &client,
        "user-3",
        &BTreeMap::from([(
            "apply-fail".to_string(),
            vec!["server:mcp-assistant".to_string()],
        )]),
        &mut migration_data,
    )
    .await
    .is_err());
    assert_eq!(
        migration_data["models_migrated"].as_array().unwrap().len(),
        1
    );
    assert!(fs::read_dir(&env.paths.backup_dir)
        .unwrap()
        .any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("migration_report_")));

    openwebui.queue_text(
        "POST",
        "/api/v1/models/model/delete",
        404,
        "missing",
        "text/plain",
    );
    openwebui.queue_text(
        "DELETE",
        "/api/v1/models/obsolete%2Dok/delete",
        200,
        "ok",
        "text/plain",
    );
    openwebui.queue_text(
        "POST",
        "/api/v1/models/model/delete",
        404,
        "missing",
        "text/plain",
    );
    openwebui.queue_text(
        "DELETE",
        "/api/v1/models/obsolete%2Dfail/delete",
        404,
        "missing",
        "text/plain",
    );
    openwebui.queue_text(
        "DELETE",
        "/api/v1/models/model/delete?id=obsolete-fail",
        500,
        "missing",
        "text/plain",
    );
    assert_eq!(
        delete_obsolete_models(
            &client,
            &["obsolete-ok".to_string(), "obsolete-fail".to_string()],
        )
        .await
        .unwrap(),
        1
    );

    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=full-model",
        404,
        json!({ "error": "missing" }),
    );
    openwebui.queue_json(
        "GET",
        "/api/models/full%2Dmodel",
        200,
        json!({ "id": "full-model" }),
    );
    assert_eq!(
        fetch_full_model(&client, "full-model")
            .await
            .unwrap()
            .unwrap()["id"],
        json!("full-model")
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=none-model",
        404,
        json!({ "error": "missing" }),
    );
    openwebui.queue_json(
        "GET",
        "/api/models/none%2Dmodel",
        404,
        json!({ "error": "missing" }),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models/none%2Dmodel",
        404,
        json!({ "error": "missing" }),
    );
    assert!(fetch_full_model(&client, "none-model")
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn retired_gpt_agent_migration_covers_every_source_and_exact_target() {
    let openwebui = MockServer::start().await;
    let client = OpenWebUiClient::new(Client::new(), &openwebui.base_url, Duration::from_secs(5));
    let cases = [
        ("gpt-54", "GPT-5.4", "GPT-5.6 Sol"),
        (
            "gpt-54-pro",
            " OpenAI/Responses/GPT-5.4-PRO:LaTeSt ",
            "GPT-5.6 Sol Pro",
        ),
        ("gpt-41", "GPT-4.1", "GPT-5.6 Sol"),
        ("gpt-41-mini", "GPT-4.1 mini", "GPT-5.6 Terra"),
        ("gpt-41-nano", "GPT-4.1 nano", "GPT-5.6 Luna"),
    ];
    openwebui.queue_json(
        "GET",
        "/api/v1/models",
        200,
        Value::Array(
            cases
                .iter()
                .map(|(id, source, _)| json!({"id": id, "info": {"base_model_id": source}}))
                .collect(),
        ),
    );
    for (id, source, target) in cases {
        openwebui.queue_json(
            "GET",
            &format!("/api/v1/models/model?id={id}"),
            200,
            json!({
                "id": id,
                "base_model_id": source,
                "info": {"base_model_id": source},
                "meta": {"preserve": true},
                "user": {},
            }),
        );
        openwebui.queue_text(
            "POST",
            &format!("/api/v1/models/model/update?id={id}"),
            200,
            "ok",
            "text/plain",
        );
        openwebui.queue_json(
            "GET",
            &format!("/api/v1/models/model?id={id}"),
            200,
            json!({
                "id": id,
                "base_model_id": target,
                "info": {"base_model_id": target},
            }),
        );
    }

    assert_eq!(migrate_user_models(&client, "user").await.unwrap(), 5);
    let requests = openwebui.requests();
    for (id, _, target) in cases {
        let update = requests
            .iter()
            .find(|request| request.path == format!("/api/v1/models/model/update?id={id}"))
            .unwrap();
        let body: Value = serde_json::from_str(&update.body).unwrap();
        assert_eq!(body["base_model_id"], json!(target));
        assert_eq!(body["meta"]["preserve"], json!(true));
    }
}

#[test]
fn retired_gpt_scheduled_task_migration_is_complete_and_idempotent() {
    let env = TestEnv::new("retired-gpt-task-matrix");
    let tasks_dir = env.paths.app_support_dir.join("scheduled_tasks");
    fs::create_dir_all(&tasks_dir).unwrap();
    let cases = [
        ("gpt-54", "GPT-5.4", "GPT-5.6 Sol"),
        ("gpt-54-pro", "GPT-5.4 pro", "GPT-5.6 Sol Pro"),
        ("gpt-41", "GPT-4.1", "GPT-5.6 Sol"),
        ("gpt-41-mini", "GPT-4.1 mini", "GPT-5.6 Terra"),
        ("gpt-41-nano", "GPT-4.1 nano", "GPT-5.6 Luna"),
    ];
    for (id, source, _) in cases {
        fs::write(
            tasks_dir.join(format!("{id}.json")),
            serde_json::to_vec_pretty(&json!({
                "id": id,
                "model_id": source,
                "updated_at": "2026-01-01T00:00:00Z",
                "future_field": {"preserve": true},
            }))
            .unwrap(),
        )
        .unwrap();
    }

    assert_eq!(migrate_scheduled_task_models(&env.paths).unwrap(), 5);
    for (id, _, target) in cases {
        let task: Value =
            serde_json::from_slice(&fs::read(tasks_dir.join(format!("{id}.json"))).unwrap())
                .unwrap();
        assert_eq!(task["model_id"], json!(target));
        assert_eq!(task["future_field"]["preserve"], json!(true));
    }
    assert_eq!(migrate_scheduled_task_models(&env.paths).unwrap(), 0);
}

#[tokio::test]
async fn retired_claude_opus_agent_migration_covers_every_source_and_exact_target() {
    let openwebui = MockServer::start().await;
    let client = OpenWebUiClient::new(Client::new(), &openwebui.base_url, Duration::from_secs(5));
    let cases = [
        ("opus-46", "Claude Opus 4.6", "Claude Opus 5"),
        ("opus-46-latest", " Claude OPUS 4.6:LaTeSt ", "Claude Opus 5"),
        ("opus-47", "Claude Opus 4.7", "Claude Opus 5"),
        ("opus-46-slug", "claude-opus-4-6", "Claude Opus 5"),
        ("opus-47-slug", "claude-opus-4-7:latest", "Claude Opus 5"),
    ];
    openwebui.queue_json(
        "GET",
        "/api/v1/models",
        200,
        Value::Array(
            cases
                .iter()
                .map(|(id, source, _)| json!({"id": id, "info": {"base_model_id": source}}))
                .collect(),
        ),
    );
    for (id, source, target) in cases {
        openwebui.queue_json(
            "GET",
            &format!("/api/v1/models/model?id={id}"),
            200,
            json!({
                "id": id,
                "base_model_id": source,
                "info": {"base_model_id": source},
                "meta": {"preserve": true},
                "user": {},
            }),
        );
        openwebui.queue_text(
            "POST",
            &format!("/api/v1/models/model/update?id={id}"),
            200,
            "ok",
            "text/plain",
        );
        openwebui.queue_json(
            "GET",
            &format!("/api/v1/models/model?id={id}"),
            200,
            json!({
                "id": id,
                "base_model_id": target,
                "info": {"base_model_id": target},
            }),
        );
    }

    assert_eq!(migrate_user_models(&client, "user").await.unwrap(), 5);
    let requests = openwebui.requests();
    for (id, _, target) in cases {
        let update = requests
            .iter()
            .find(|request| request.path == format!("/api/v1/models/model/update?id={id}"))
            .unwrap();
        let body: Value = serde_json::from_str(&update.body).unwrap();
        assert_eq!(body["base_model_id"], json!(target));
        assert_eq!(body["meta"]["preserve"], json!(true));
    }
}

#[tokio::test]
async fn disable_obsolete_models_writes_a_per_model_replacement_reason() {
    let openwebui = MockServer::start().await;
    let client = OpenWebUiClient::new(Client::new(), &openwebui.base_url, Duration::from_secs(5));
    let cases = [
        ("Claude Opus 4.6", "Replaced by Claude Opus 5"),
        ("Claude Opus 4.7", "Replaced by Claude Opus 5"),
        ("GPT-5.4", "Replaced by GPT-5.6 Sol"),
    ];
    for (model_id, _) in cases {
        let encoded = model_id.replace(' ', "+");
        openwebui.queue_json(
            "GET",
            &format!("/api/v1/models/model?id={encoded}"),
            200,
            json!({ "id": model_id, "meta": {}, "user": {}, "info": {} }),
        );
        openwebui.queue_text(
            "POST",
            &format!("/api/v1/models/model/update?id={encoded}"),
            200,
            "ok",
            "text/plain",
        );
        openwebui.queue_json(
            "GET",
            &format!("/api/v1/models/model?id={encoded}"),
            200,
            json!({
                "id": model_id,
                "meta": { "disabled": true, "hidden": true },
                "is_active": false,
            }),
        );
    }
    let ids: Vec<String> = cases.iter().map(|(id, _)| (*id).to_string()).collect();
    assert_eq!(
        disable_obsolete_models(&client, "user", &ids).await.unwrap(),
        3
    );
    let requests = openwebui.requests();
    for (model_id, expected_reason) in cases {
        let encoded = model_id.replace(' ', "+");
        let update = requests
            .iter()
            .find(|request| request.path == format!("/api/v1/models/model/update?id={encoded}"))
            .unwrap();
        let body: Value = serde_json::from_str(&update.body).unwrap();
        assert_eq!(body["meta"]["disabled"], json!(true));
        assert_eq!(body["meta"]["hidden"], json!(true));
        assert_eq!(body["meta"]["disabled_reason"], json!(expected_reason));
    }
}

#[test]
fn retired_claude_opus_scheduled_task_migration_is_complete_and_idempotent() {
    let env = TestEnv::new("retired-opus-task-matrix");
    let tasks_dir = env.paths.app_support_dir.join("scheduled_tasks");
    fs::create_dir_all(&tasks_dir).unwrap();
    let cases = [
        ("opus-46", "Claude Opus 4.6", "Claude Opus 5"),
        ("opus-47", "Claude Opus 4.7", "Claude Opus 5"),
        ("opus-46-slug", "claude-opus-4-6", "Claude Opus 5"),
        ("opus-47-latest", "Claude Opus 4.7:latest", "Claude Opus 5"),
    ];
    for (id, source, _) in cases {
        fs::write(
            tasks_dir.join(format!("{id}.json")),
            serde_json::to_vec_pretty(&json!({
                "id": id,
                "model_id": source,
                "updated_at": "2026-01-01T00:00:00Z",
                "future_field": {"preserve": true},
            }))
            .unwrap(),
        )
        .unwrap();
    }

    assert_eq!(migrate_scheduled_task_models(&env.paths).unwrap(), 4);
    for (id, _, target) in cases {
        let task: Value =
            serde_json::from_slice(&fs::read(tasks_dir.join(format!("{id}.json"))).unwrap())
                .unwrap();
        assert_eq!(task["model_id"], json!(target));
        assert_eq!(task["future_field"]["preserve"], json!(true));
    }
    assert_eq!(migrate_scheduled_task_models(&env.paths).unwrap(), 0);
}

// Gemini 3.5 Flash / 3.1 Flash-Lite stay in the catalog (migrate-without-
// retire, like Sonnet 4.6): the sweep still rewrites agents pointing at them.
#[tokio::test]
async fn available_gemini_agent_migration_covers_display_and_slug_sources() {
    let openwebui = MockServer::start().await;
    let client = OpenWebUiClient::new(Client::new(), &openwebui.base_url, Duration::from_secs(5));
    let cases = [
        ("gemini-flash", "Gemini 3.5 Flash", "Gemini 3.6 Flash"),
        ("gemini-flash-latest", " GEMINI 3.5 Flash:LaTeSt ", "Gemini 3.6 Flash"),
        ("gemini-flash-slug", "gemini-3.5-flash", "Gemini 3.6 Flash"),
        ("gemini-lite", "Gemini 3.1 Flash-Lite", "Gemini 3.5 Flash-Lite"),
        (
            "gemini-lite-slug",
            "gemini-3.1-flash-lite:latest",
            "Gemini 3.5 Flash-Lite",
        ),
    ];
    openwebui.queue_json(
        "GET",
        "/api/v1/models",
        200,
        Value::Array(
            cases
                .iter()
                .map(|(id, source, _)| json!({"id": id, "info": {"base_model_id": source}}))
                .collect(),
        ),
    );
    for (id, source, target) in cases {
        openwebui.queue_json(
            "GET",
            &format!("/api/v1/models/model?id={id}"),
            200,
            json!({
                "id": id,
                "base_model_id": source,
                "info": {"base_model_id": source},
                "meta": {"preserve": true},
                "user": {},
            }),
        );
        openwebui.queue_text(
            "POST",
            &format!("/api/v1/models/model/update?id={id}"),
            200,
            "ok",
            "text/plain",
        );
        openwebui.queue_json(
            "GET",
            &format!("/api/v1/models/model?id={id}"),
            200,
            json!({
                "id": id,
                "base_model_id": target,
                "info": {"base_model_id": target},
            }),
        );
    }

    assert_eq!(migrate_user_models(&client, "user").await.unwrap(), 5);
    let requests = openwebui.requests();
    for (id, _, target) in cases {
        let update = requests
            .iter()
            .find(|request| request.path == format!("/api/v1/models/model/update?id={id}"))
            .unwrap();
        let body: Value = serde_json::from_str(&update.body).unwrap();
        assert_eq!(body["base_model_id"], json!(target));
        assert_eq!(body["meta"]["preserve"], json!(true));
    }
}

#[test]
fn available_gemini_scheduled_task_migration_is_complete_and_idempotent() {
    let env = TestEnv::new("available-gemini-task-matrix");
    let tasks_dir = env.paths.app_support_dir.join("scheduled_tasks");
    fs::create_dir_all(&tasks_dir).unwrap();
    let cases = [
        ("gemini-flash", "Gemini 3.5 Flash", "Gemini 3.6 Flash"),
        ("gemini-flash-slug", "gemini-3.5-flash", "Gemini 3.6 Flash"),
        ("gemini-lite", "Gemini 3.1 Flash-Lite", "Gemini 3.5 Flash-Lite"),
        (
            "gemini-lite-latest",
            "Gemini 3.1 Flash-Lite:latest",
            "Gemini 3.5 Flash-Lite",
        ),
    ];
    for (id, source, _) in cases {
        fs::write(
            tasks_dir.join(format!("{id}.json")),
            serde_json::to_vec_pretty(&json!({
                "id": id,
                "model_id": source,
                "updated_at": "2026-01-01T00:00:00Z",
                "future_field": {"preserve": true},
            }))
            .unwrap(),
        )
        .unwrap();
    }
    // Tasks already on the migration targets must be left untouched.
    fs::write(
        tasks_dir.join("gemini-36.json"),
        serde_json::to_vec_pretty(&json!({ "id": "gemini-36", "model_id": "Gemini 3.6 Flash" }))
            .unwrap(),
    )
    .unwrap();

    assert_eq!(migrate_scheduled_task_models(&env.paths).unwrap(), 4);
    for (id, _, target) in cases {
        let task: Value =
            serde_json::from_slice(&fs::read(tasks_dir.join(format!("{id}.json"))).unwrap())
                .unwrap();
        assert_eq!(task["model_id"], json!(target));
        assert_eq!(task["future_field"]["preserve"], json!(true));
    }
    let untouched: Value =
        serde_json::from_slice(&fs::read(tasks_dir.join("gemini-36.json")).unwrap()).unwrap();
    assert_eq!(untouched["model_id"], json!("Gemini 3.6 Flash"));
    assert_eq!(migrate_scheduled_task_models(&env.paths).unwrap(), 0);
}

#[tokio::test]
async fn configure_base_models_updates_gemini_when_only_profile_icon_differs() {
    let env = TestEnv::new("gemini-icon-update");
    let openwebui = MockServer::start().await;
    let client = OpenWebUiClient::new(Client::new(), &openwebui.base_url, Duration::from_secs(5));
    let tools = vec!["portico_core_unified_context".to_string()];
    let configured_model = ConfiguredBaseModel {
        id: "Gemini 3.5 Flash".to_string(),
        source_model_id: Some("gemini-3.5-flash".to_string()),
        disabled: false,
        disabled_reason: None,
    };
    let mut existing_model = json!({});
    canonicalize_base_model_payload(
        &env.paths,
        &mut existing_model,
        &configured_model,
        "Base system prompt",
        &tools,
        "Gemini 3.5 Flash",
    );
    existing_model["meta"]["profile_image_url"] = json!("data:image/png;base64,Z3B0");

    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=Gemini+3.5+Flash",
        200,
        existing_model,
    );
    openwebui.queue_text(
        "POST",
        "/api/v1/models/model/update?id=Gemini+3.5+Flash",
        200,
        "ok",
        "text/plain",
    );

    let mut expected_model = json!({});
    canonicalize_base_model_payload(
        &env.paths,
        &mut expected_model,
        &configured_model,
        "Base system prompt",
        &tools,
        "Gemini 3.5 Flash",
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=Gemini+3.5+Flash",
        200,
        expected_model,
    );

    let counts = configure_base_models(
        &env.paths,
        &client,
        "user-1",
        &[configured_model],
        &["Gemini 3.5 Flash".to_string()],
        "Base system prompt",
        &tools,
        "Gemini 3.5 Flash",
    )
    .await
    .unwrap();
    assert_eq!(
        (counts.updated, counts.created, counts.unchanged),
        (1, 0, 0)
    );

    let requests = openwebui.requests();
    let update_request = requests
        .iter()
        .find(|request| request.path == "/api/v1/models/model/update?id=Gemini+3.5+Flash")
        .unwrap();
    let update_body: serde_json::Value = serde_json::from_str(&update_request.body).unwrap();
    assert_eq!(
        update_body["meta"]["profile_image_url"],
        json!("data:image/png;base64,Z2VtaW5p")
    );
}

#[tokio::test]
async fn run_returns_false_when_token_store_write_fails() {
    let env = TestEnv::new("run-token-store-fail");
    let openwebui = MockServer::start().await;
    openwebui.queue_json(
        "POST",
        "/api/v1/portico/auth/service-token",
        200,
        json!({ "token": "token-fail" }),
    );

    let app = HealthCheckApp::new(
        env.paths,
        base_config(
            HealthCheckMode::Light,
            &openwebui.base_url,
            "http://unused-core",
            "http://unused-regular",
            "http://unused-host",
            "",
        ),
        RetryConfig {
            main_retries: 1,
            main_delay: Duration::ZERO,
            ..fast_retries()
        },
        Some(Arc::new(FailingTokenStore) as Arc<dyn TokenStore>),
        Arc::new(MockLogInspector::default()),
    );
    assert!(!app.run().await.unwrap());
}

#[tokio::test]
#[serial]
async fn external_wrappers_and_run_default_cover_docker_redis_and_bootstrap_paths() {
    let docker_dir = TempDir::new().unwrap();
    let docker_path = docker_dir.path().join("docker");
    fs::write(
        &docker_path,
        "#!/bin/sh\nif [ \"$1\" = \"logs\" ]; then\n  echo 'Exception: boom' 1>&2\nfi\n",
    )
    .unwrap();
    #[cfg(unix)]
    fs::set_permissions(&docker_path, fs::Permissions::from_mode(0o755)).unwrap();
    let original_path = std::env::var("PATH").unwrap_or_default();
    std::env::set_var(
        "PATH",
        format!("{}:{}", docker_dir.path().display(), original_path),
    );
    assert!(DockerCliLogInspector.has_errors("container-a", 20));
    std::env::set_var(
        "PATH",
        docker_dir.path().join("missing").display().to_string(),
    );
    assert!(!DockerCliLogInspector.has_errors("container-a", 20));
    std::env::set_var("PATH", original_path);

    let redis = MockRedisServer::start().await;
    std::env::set_var("HEALTH_CHECK_REDIS_URL", &redis.url);
    let store = RedisTokenStore::connect_once().unwrap();
    store.set("alpha", "beta").unwrap();
    assert!(redis
        .commands
        .lock()
        .unwrap()
        .iter()
        .any(|command| command.contains("SET")));

    std::env::set_var("HEALTH_CHECK_REDIS_URL", "redis://127.0.0.1:1/");
    let retries = RetryConfig {
        redis_retries: 1,
        redis_delay: Duration::ZERO,
        ..fast_retries()
    };
    assert!(connect_redis_token_store(&retries).await.unwrap().is_none());

    let env = TestEnv::new("run-default");
    let openwebui = MockServer::start().await;
    let core = MockServer::start().await;
    let regular = MockServer::start().await;
    openwebui.queue_json(
        "POST",
        "/api/v1/portico/auth/service-token",
        200,
        json!({ "token": "run-default-token" }),
    );
    queue_summary(
        &core,
        vec![summary_entry("mcp-assistant", "core", true, true, 1)],
    );
    core.queue_json(
        "GET",
        "/oauth/status",
        200,
        json!({
            "current": null,
            "active": [],
            "pending": [],
            "checking": [],
            "waiting_callback": [],
            "completed": [],
            "failed": [],
            "timeout": []
        }),
    );
    queue_summary(
        &regular,
        vec![summary_entry("time", "regular", true, true, 1)],
    );
    regular.queue_json(
        "GET",
        "/oauth/status",
        200,
        json!({
            "current": null,
            "active": [],
            "pending": [],
            "checking": [],
            "waiting_callback": [],
            "completed": [],
            "failed": [],
            "timeout": []
        }),
    );
    let app = HealthCheckApp::new(
        env.paths.clone(),
        base_config(
            HealthCheckMode::Light,
            &openwebui.base_url,
            &core.base_url,
            &regular.base_url,
            "http://unused-host",
            "session-run-default-test",
        ),
        RetryConfig {
            main_retries: 1,
            main_delay: Duration::ZERO,
            ..fast_retries()
        },
        None,
        Arc::new(MockLogInspector::default()),
    );
    assert!(app.run().await.unwrap());
    assert!(env
        .paths
        .health_status_dir
        .join("health_status.json")
        .exists());

    std::env::remove_var("HEALTH_CHECK_REDIS_URL");
}

#[tokio::test]
async fn run_authenticated_failure_matrix_covers_early_returns_and_skip_paths() {
    let core = MockServer::start().await;
    let regular = MockServer::start().await;
    let host = MockServer::start().await;
    let config = |mode, session| {
        base_config(
            mode,
            "http://openwebui-unused",
            &core.base_url,
            &regular.base_url,
            &host.base_url,
            session,
        )
    };

    let env_filters = TestEnv::new("run-auth-filters");
    env_filters.write_filter(
        "broken",
        "\"\"\"description: Broken\"\"\"\nprint('broken')\n",
    );
    let app_filters = build_app(
        &env_filters,
        config(HealthCheckMode::Full, "session-filters"),
        Arc::new(MockTokenStore::default()),
        Arc::new(MockLogInspector::default()),
    );
    let openwebui_filters = MockServer::start().await;
    openwebui_filters.queue_json("GET", "/api/v1/functions/", 200, json!([]));
    openwebui_filters.queue_text(
        "POST",
        "/api/v1/utils/code/format",
        500,
        "bad",
        "text/plain",
    );
    let client_filters = OpenWebUiClient::new(
        Client::new(),
        &openwebui_filters.base_url,
        Duration::from_secs(5),
    );
    assert!(app_filters.run_authenticated(client_filters).await.is_err());

    let env_no_core = TestEnv::new("run-auth-no-core");
    queue_summary(&core, Vec::new());
    queue_summary(
        &regular,
        vec![summary_entry("time", "regular", true, true, 1)],
    );
    let app_no_core = build_app(
        &env_no_core,
        config(HealthCheckMode::Light, "session-no-core"),
        Arc::new(MockTokenStore::default()),
        Arc::new(MockLogInspector::default()),
    );
    let client_no_core =
        OpenWebUiClient::new(Client::new(), "http://unused", Duration::from_secs(5));
    assert!(!app_no_core.run_authenticated(client_no_core).await.unwrap());

    let env_configure_fail = TestEnv::new("run-auth-configure-fail");
    for _ in 0..5 {
        queue_summary(
            &core,
            vec![
                summary_entry("mcp-assistant", "core", true, true, 1),
                summary_entry("subagents", "core", true, true, 1),
                summary_entry("skills", "core", true, true, 1),
            ],
        );
        queue_summary(
            &regular,
            vec![summary_entry("time", "regular", true, true, 1)],
        );
    }
    let openwebui_configure = MockServer::start().await;
    openwebui_configure.queue_json("GET", "/api/v1/tools/", 200, json!([]));
    openwebui_configure.queue_json(
        "POST",
        "/api/v1/configs/tool_servers",
        500,
        json!({ "error": "nope" }),
    );
    let app_configure = build_app(
        &env_configure_fail,
        config(HealthCheckMode::StartupCore, "session-configure"),
        Arc::new(MockTokenStore::default()),
        Arc::new(MockLogInspector::default()),
    );
    let client_configure = OpenWebUiClient::new(
        Client::new(),
        &openwebui_configure.base_url,
        Duration::from_secs(5),
    );
    assert!(!app_configure
        .run_authenticated(client_configure)
        .await
        .unwrap());

    let env_missing_user = TestEnv::new("run-auth-user");
    let openwebui_user = MockServer::start().await;
    openwebui_user.queue_json("GET", "/api/v1/tools/", 200, json!([]));
    openwebui_user.queue_json(
        "POST",
        "/api/v1/configs/tool_servers",
        200,
        json!({ "ok": true }),
    );
    openwebui_user.queue_json("GET", "/api/v1/auths/", 200, json!({ "id": "" }));
    let app_missing_user = build_app(
        &env_missing_user,
        config(HealthCheckMode::StartupCore, "session-user"),
        Arc::new(MockTokenStore::default()),
        Arc::new(MockLogInspector::default()),
    );
    let client_missing_user = OpenWebUiClient::new(
        Client::new(),
        &openwebui_user.base_url,
        Duration::from_secs(5),
    );
    assert!(!app_missing_user
        .run_authenticated(client_missing_user)
        .await
        .unwrap());

    let env_missing_tools = TestEnv::new("run-auth-tools");
    let openwebui_tools = MockServer::start().await;
    openwebui_tools.queue_json("GET", "/api/v1/tools/", 200, json!([]));
    openwebui_tools.queue_json(
        "POST",
        "/api/v1/configs/tool_servers",
        200,
        json!({ "ok": true }),
    );
    openwebui_tools.queue_json("GET", "/api/v1/auths/", 200, json!({ "id": "user-1" }));
    openwebui_tools.queue_json(
        "GET",
        "/api/v1/tools/",
        200,
        json!([{ "id": "server:mcp-assistant" }]),
    );
    let app_missing_tools = build_app(
        &env_missing_tools,
        config(HealthCheckMode::StartupCore, "session-tools"),
        Arc::new(MockTokenStore::default()),
        Arc::new(MockLogInspector::default()),
    );
    let client_missing_tools = OpenWebUiClient::new(
        Client::new(),
        &openwebui_tools.base_url,
        Duration::from_secs(5),
    );
    assert!(!app_missing_tools
        .run_authenticated(client_missing_tools)
        .await
        .unwrap());

    let env_agent_fail = TestEnv::new("run-auth-agent-fail");
    env_agent_fail.write_agent(
        "agent-fail",
        r#"
name: "Agent Fail"
base_model_id: "Claude Sonnet 4.5"
description: "Agent"
tools_mode: "all"
"#,
        "Agent prompt",
    );
    let openwebui_agent = MockServer::start().await;
    openwebui_agent.queue_json("GET", "/api/v1/tools/", 200, json!([]));
    openwebui_agent.queue_json(
        "POST",
        "/api/v1/configs/tool_servers",
        200,
        json!({ "ok": true }),
    );
    openwebui_agent.queue_json("GET", "/api/v1/auths/", 200, json!({ "id": "user-2" }));
    openwebui_agent.queue_json(
        "GET",
        "/api/v1/tools/",
        200,
        json!([
            { "id": "server:mcp-assistant" },
            { "id": "server:subagents" },
            { "id": "server:skills" },
            { "id": "server:agent-vm" }
        ]),
    );
    openwebui_agent.queue_json(
        "GET",
        "/api/v1/models/model?id=portico_agent_agent-fail",
        404,
        json!({ "error": "missing" }),
    );
    openwebui_agent.queue_text("POST", "/api/v1/models/create", 500, "bad", "text/plain");
    let app_agent_fail = build_app(
        &env_agent_fail,
        config(HealthCheckMode::StartupCore, "session-agent"),
        Arc::new(MockTokenStore::default()),
        Arc::new(MockLogInspector::default()),
    );
    let client_agent_fail = OpenWebUiClient::new(
        Client::new(),
        &openwebui_agent.base_url,
        Duration::from_secs(5),
    );
    assert!(!app_agent_fail
        .run_authenticated(client_agent_fail)
        .await
        .unwrap());

    let env_skip_model_sync = TestEnv::new("run-auth-skip-model-sync");
    env_skip_model_sync.write_base_system_prompt("Base prompt");
    env_skip_model_sync.write_model_catalog_models(&["Claude Sonnet 4.6"]);
    let openwebui_skip_model_sync = MockServer::start().await;
    openwebui_skip_model_sync.queue_json(
        "GET",
        "/api/v1/tools/",
        500,
        json!({ "error": "skip migration map" }),
    );
    openwebui_skip_model_sync.queue_json(
        "POST",
        "/api/v1/configs/tool_servers",
        200,
        json!({ "ok": true }),
    );
    openwebui_skip_model_sync.queue_json("GET", "/api/v1/auths/", 200, json!({ "id": "user-3" }));
    openwebui_skip_model_sync.queue_json("GET", "/api/v1/auths/", 200, json!({ "id": "user-3" }));
    openwebui_skip_model_sync.queue_json(
        "GET",
        "/api/v1/tools/",
        200,
        json!([
            { "id": "server:mcp-assistant" },
            { "id": "server:subagents" },
            { "id": "server:skills" },
            { "id": "server:agent-vm" }
        ]),
    );
    openwebui_skip_model_sync.queue_json("GET", "/api/models?", 200, json!({ "data": [] }));
    openwebui_skip_model_sync.queue_json("GET", "/api/models?", 200, json!({ "data": [] }));
    openwebui_skip_model_sync.queue_json("GET", "/api/models?", 200, json!({ "data": [] }));
    openwebui_skip_model_sync.queue_json("GET", "/api/v1/models", 200, json!([]));
    openwebui_skip_model_sync.queue_json("GET", "/api/v1/models", 200, json!([]));
    openwebui_skip_model_sync.queue_json(
        "GET",
        "/api/v1/users/user/settings",
        200,
        json!({ "ui": { "models": ["Custom"] } }),
    );
    openwebui_skip_model_sync.queue_json(
        "GET",
        "/api/v1/users/user/settings",
        200,
        json!({ "ui": { "models": ["Custom"] } }),
    );
    openwebui_skip_model_sync.queue_json(
        "GET",
        "/api/v1/models/model?id=Claude+Sonnet+4.6",
        404,
        json!({ "detail": "missing" }),
    );
    openwebui_skip_model_sync.queue_text("POST", "/api/v1/models/create", 200, "ok", "text/plain");
    openwebui_skip_model_sync.queue_json(
        "GET",
        "/api/v1/models/model?id=Claude+Sonnet+4.6",
        200,
        configured_model_readback(
            &env_skip_model_sync,
            "Claude Sonnet 4.6",
            false,
            None,
            &[
                "server:mcp-assistant".to_string(),
                "server:subagents".to_string(),
                "server:skills".to_string(),
                "server:agent-vm".to_string(),
            ],
            "Claude Sonnet 4.6",
        ),
    );
    openwebui_skip_model_sync.queue_json("GET", "/api/v1/models", 200, json!([]));
    openwebui_skip_model_sync.queue_json(
        "POST",
        "/api/v1/users/user/settings/update",
        500,
        json!({ "error": "bad" }),
    );
    let token_store_skip_model_sync = Arc::new(MockTokenStore::default());
    let app_skip_model_sync = build_app(
        &env_skip_model_sync,
        config(HealthCheckMode::StartupCore, "session-skip-sync"),
        token_store_skip_model_sync.clone(),
        Arc::new(MockLogInspector::default()),
    );
    let client_skip_model_sync = OpenWebUiClient::new(
        Client::new(),
        &openwebui_skip_model_sync.base_url,
        Duration::from_secs(5),
    );
    assert!(app_skip_model_sync
        .run_authenticated(client_skip_model_sync)
        .await
        .unwrap());
    let raw = fs::read_to_string(health_sync_log_file_path(&env_skip_model_sync.paths)).unwrap();
    assert!(
        raw.contains("user_settings_update_failed"),
        "unexpected degraded stage: {raw}\nrequests: {:?}",
        openwebui_skip_model_sync.requests()
    );
    assert!(raw.contains("model_sync_status=degraded"));
    assert_eq!(
        token_store_skip_model_sync
            .releases
            .lock()
            .unwrap()
            .as_slice(),
        &[("run-session-skip-sync".to_string(), 1)]
    );
}

#[tokio::test]
async fn run_authenticated_preserves_transiently_missing_servers() {
    let env = TestEnv::new("run-auth-preserve");
    for server in ["mcp-assistant", "subagents", "skills"] {
        env.write_server_yaml(
            false,
            server,
            "display_name: Core\ndeployment_type: docker\nis_core: true\n",
        );
    }
    env.write_server_yaml(
        false,
        "google_workspace",
        "display_name: Google Workspace\ndeployment_type: docker\n",
    );
    fs::write(&env.paths.mcp_toggles_file, r#"{"google_workspace":true}"#).unwrap();
    fs::write(
        env.paths.health_status_dir.join("health_status.json"),
        serde_json::to_vec_pretty(&json!({
            "sync_diagnostics": {
                "discovered_server_ids": [
                    "mcp-assistant",
                    "skills",
                    "subagents",
                    "google_workspace"
                ]
            }
        }))
        .unwrap(),
    )
    .unwrap();

    let openwebui = MockServer::start().await;
    let core = MockServer::start().await;
    let regular = MockServer::start().await;
    let host = MockServer::start().await;
    queue_summary(
        &core,
        vec![
            summary_entry("mcp-assistant", "core", true, true, 1),
            summary_entry("subagents", "core", true, true, 1),
            summary_entry("skills", "core", true, true, 1),
        ],
    );
    queue_summary(&regular, vec![]);
    regular.queue_json(
        "GET",
        "/oauth/status",
        200,
        json!({ "current": null, "active": [], "pending": [], "checking": [], "waiting_callback": [], "completed": [], "failed": [], "timeout": [] }),
    );
    core.queue_json(
        "GET",
        "/oauth/status",
        200,
        json!({ "current": null, "active": [], "pending": [], "checking": [], "waiting_callback": [], "completed": [], "failed": [], "timeout": [] }),
    );
    openwebui.queue_json("GET", "/api/v1/tools/", 200, json!([]));
    let existing_google_connection = json!({
        "url": "http://mcpo/google_workspace",
        "path": "openapi.json",
        "type": "openapi",
        "auth_type": "oauth_2.1",
        "headers": Value::Null,
        "key": "",
        "config": {
            "enable": true,
            "access_control": Value::Null
        },
        "info": {
            "id": "google_workspace",
            "name": "Google Workspace",
            "description": "Workspace",
            "oauth_client_info": "encrypted"
        }
    });
    openwebui.queue_json(
        "GET",
        "/api/v1/configs/tool_servers",
        200,
        json!({ "TOOL_SERVER_CONNECTIONS": [existing_google_connection.clone()] }),
    );
    openwebui.queue_json(
        "POST",
        "/api/v1/configs/tool_servers",
        200,
        json!({ "ok": true }),
    );
    openwebui.queue_json("GET", "/api/v1/auths/", 200, json!({ "id": "" }));

    let app = build_app(
        &env,
        base_config(
            HealthCheckMode::StartupCore,
            &openwebui.base_url,
            &core.base_url,
            &regular.base_url,
            &host.base_url,
            "session-preserve",
        ),
        Arc::new(MockTokenStore::default()),
        Arc::new(MockLogInspector::default()),
    );
    let client = OpenWebUiClient::new(Client::new(), &openwebui.base_url, Duration::from_secs(5));

    assert!(!app.run_authenticated(client).await.unwrap());

    let requests = openwebui.requests();
    assert!(requests
        .iter()
        .any(|request| request.method == "GET" && request.path == "/api/v1/configs/tool_servers"));
    let configure_request = requests
        .iter()
        .find(|request| request.method == "POST" && request.path == "/api/v1/configs/tool_servers")
        .unwrap();
    let body: serde_json::Value = serde_json::from_str(&configure_request.body).unwrap();
    let connections = body["TOOL_SERVER_CONNECTIONS"].as_array().unwrap();
    assert_eq!(connections.len(), 4);
    assert!(connections
        .iter()
        .any(|connection| connection == &existing_google_connection));
}

#[tokio::test]
async fn run_authenticated_returns_error_when_preserve_readback_fails() {
    let env = TestEnv::new("run-auth-preserve-readback-fail");
    for server in ["mcp-assistant", "subagents", "skills"] {
        env.write_server_yaml(
            false,
            server,
            "display_name: Core\ndeployment_type: docker\nis_core: true\n",
        );
    }
    env.write_server_yaml(
        false,
        "google_workspace",
        "display_name: Google Workspace\ndeployment_type: docker\n",
    );
    fs::write(&env.paths.mcp_toggles_file, r#"{"google_workspace":true}"#).unwrap();
    fs::write(
        env.paths.health_status_dir.join("health_status.json"),
        serde_json::to_vec_pretty(&json!({
            "sync_diagnostics": {
                "discovered_server_ids": ["mcp-assistant", "subagents", "skills", "google_workspace"]
            }
        }))
        .unwrap(),
    )
    .unwrap();

    let openwebui = MockServer::start().await;
    let core = MockServer::start().await;
    let regular = MockServer::start().await;
    let host = MockServer::start().await;
    queue_summary(
        &core,
        vec![
            summary_entry("mcp-assistant", "core", true, true, 1),
            summary_entry("subagents", "core", true, true, 1),
            summary_entry("skills", "core", true, true, 1),
        ],
    );
    queue_summary(&regular, vec![]);
    regular.queue_json(
        "GET",
        "/oauth/status",
        200,
        json!({ "current": null, "active": [], "pending": [], "checking": [], "waiting_callback": [], "completed": [], "failed": [], "timeout": [] }),
    );
    core.queue_json(
        "GET",
        "/oauth/status",
        200,
        json!({ "current": null, "active": [], "pending": [], "checking": [], "waiting_callback": [], "completed": [], "failed": [], "timeout": [] }),
    );
    openwebui.queue_json("GET", "/api/v1/tools/", 200, json!([]));
    openwebui.queue_json(
        "GET",
        "/api/v1/configs/tool_servers",
        500,
        json!({ "error": "unavailable" }),
    );

    let app = build_app(
        &env,
        base_config(
            HealthCheckMode::StartupCore,
            &openwebui.base_url,
            &core.base_url,
            &regular.base_url,
            &host.base_url,
            "session-preserve-fail",
        ),
        Arc::new(MockTokenStore::default()),
        Arc::new(MockLogInspector::default()),
    );
    let client = OpenWebUiClient::new(Client::new(), &openwebui.base_url, Duration::from_secs(5));

    let error = app.run_authenticated(client).await.unwrap_err();
    assert!(error
        .to_string()
        .contains("failed to read current Open WebUI tool server config"));
    assert!(openwebui.requests().iter().all(
        |request| !(request.method == "POST" && request.path == "/api/v1/configs/tool_servers")
    ));
}

#[tokio::test]
async fn run_authenticated_skips_preserve_readback_without_candidates() {
    let env = TestEnv::new("run-auth-no-preserve");
    for server in ["mcp-assistant", "subagents", "skills"] {
        env.write_server_yaml(
            false,
            server,
            "display_name: Core\ndeployment_type: docker\nis_core: true\n",
        );
    }

    let openwebui = MockServer::start().await;
    let core = MockServer::start().await;
    let regular = MockServer::start().await;
    let host = MockServer::start().await;
    queue_summary(
        &core,
        vec![
            summary_entry("mcp-assistant", "core", true, true, 1),
            summary_entry("subagents", "core", true, true, 1),
            summary_entry("skills", "core", true, true, 1),
        ],
    );
    queue_summary(&regular, vec![]);
    regular.queue_json(
        "GET",
        "/oauth/status",
        200,
        json!({ "current": null, "active": [], "pending": [], "checking": [], "waiting_callback": [], "completed": [], "failed": [], "timeout": [] }),
    );
    core.queue_json(
        "GET",
        "/oauth/status",
        200,
        json!({ "current": null, "active": [], "pending": [], "checking": [], "waiting_callback": [], "completed": [], "failed": [], "timeout": [] }),
    );
    openwebui.queue_json("GET", "/api/v1/tools/", 200, json!([]));
    openwebui.queue_json(
        "POST",
        "/api/v1/configs/tool_servers",
        200,
        json!({ "ok": true }),
    );
    openwebui.queue_json("GET", "/api/v1/auths/", 200, json!({ "id": "" }));

    let app = build_app(
        &env,
        base_config(
            HealthCheckMode::StartupCore,
            &openwebui.base_url,
            &core.base_url,
            &regular.base_url,
            &host.base_url,
            "session-no-preserve",
        ),
        Arc::new(MockTokenStore::default()),
        Arc::new(MockLogInspector::default()),
    );
    let client = OpenWebUiClient::new(Client::new(), &openwebui.base_url, Duration::from_secs(5));

    assert!(!app.run_authenticated(client).await.unwrap());
    assert!(openwebui.requests().iter().all(
        |request| !(request.method == "GET" && request.path == "/api/v1/configs/tool_servers")
    ));
}

#[tokio::test]
#[serial]
async fn edge_case_helpers_cover_remaining_branches() {
    let env = TestEnv::new("edge-cases");
    let server = MockServer::start().await;
    let client = OpenWebUiClient::new(Client::new(), &server.base_url, Duration::from_secs(1));

    server.queue_json("GET", "/absolute?x=1", 200, json!({ "ok": true }));
    assert_eq!(
        client
            .request(
                Method::GET,
                &format!("{}/absolute", server.base_url),
                None,
                Some(&[("x", "1".to_string())]),
                false,
            )
            .await
            .unwrap()
            .status,
        Some(200)
    );
    let request_error = client
        .request(
            Method::GET,
            "http://127.0.0.1:1/unreachable",
            None,
            None,
            false,
        )
        .await
        .unwrap_err();
    assert!(request_error.to_string().contains("error") || request_error.status.is_none());

    server.queue_json("POST", "/post-error", 400, json!({ "error": "bad" }));
    assert_eq!(
        client
            .post_json("/post-error", Some(&json!({ "x": 1 })), None)
            .await
            .unwrap_err()
            .status,
        Some(400)
    );
    let parse_error = parse_json_response(
        "/typed-bad",
        &RawResponse {
            ok: true,
            status: Some(200),
            content_type: "application/json".to_string(),
            text: "{".to_string(),
            method: "GET".to_string(),
            path: "/typed-bad".to_string(),
            duration_ms: 1,
            response_bytes: 1,
        },
    )
    .unwrap_err();
    assert!(parse_error.to_string().contains("application/json"));

    let mut broken_paths = env.paths.clone();
    broken_paths.model_sync_completed_session_file = PathBuf::new();
    assert!(mark_model_sync_completed_for_session(&broken_paths, "session").is_err());

    let tokens_file = env.paths.oauth_tokens_dir.join("file-server/tokens");
    fs::create_dir_all(tokens_file.parent().unwrap()).unwrap();
    fs::write(&tokens_file, "not a dir").unwrap();
    assert!(!has_recent_oauth_tokens(&env.paths, "file-server", 60));

    let metadata = ServerMetadata {
        id: "srv".to_string(),
        name: "Srv".to_string(),
        deployment_type: "docker".to_string(),
        is_core: false,
        has_oauth: false,
        user_installed: false,
        is_configured: true,
        config_error: None,
    };
    assert_eq!(
        get_server_enablement_state(
            "srv",
            &metadata,
            &HashMap::from([("srv".to_string(), true)]),
            &env.paths,
            60
        ),
        (true, "explicit_true".to_string())
    );
    assert_eq!(
        get_server_enablement_state("srv", &metadata, &HashMap::new(), &env.paths, 60),
        (false, "default_disabled".to_string())
    );

    let yaml_weird: serde_yaml::Value = serde_yaml::from_str(
        r#"
required_env_vars:
  - {}
  - [nested]
  - name: API_KEY
"#,
    )
    .unwrap();
    assert!(is_server_configured(
        "srv",
        &yaml_weird,
        &HashMap::from([("API_KEY".to_string(), "real".to_string())]),
    ));

    let empty_root = TempDir::new().unwrap();
    let missing_paths = build_paths(&empty_root.path().join("missing"));
    let (empty_servers, empty_ignored) = scan_configured_servers(&missing_paths).unwrap();
    assert!(empty_servers.is_empty());
    assert!(empty_ignored.is_empty());

    fs::create_dir_all(&env.paths.mcp_configs_dir).unwrap();
    fs::write(env.paths.mcp_configs_dir.join("plain.txt"), "x").unwrap();
    let dir_without_yaml = env.paths.mcp_configs_dir.join("dir-without-yaml");
    fs::create_dir_all(&dir_without_yaml).unwrap();
    let (servers_after_noise, _) = scan_configured_servers(&env.paths).unwrap();
    assert!(servers_after_noise.is_empty());
    env.write_server_yaml(
        false,
        "good-server",
        "display_name: Good\ndeployment_type: docker\n",
    );
    let broken_server_dir = env.paths.mcp_configs_dir.join("broken-server");
    fs::create_dir_all(&broken_server_dir).unwrap();
    fs::write(broken_server_dir.join("broken-server.yaml"), "{").unwrap();
    let (servers_after_broken_yaml, _) = scan_configured_servers(&env.paths).unwrap();
    assert!(servers_after_broken_yaml.contains_key("good-server"));
    assert!(!servers_after_broken_yaml.contains_key("broken-server"));

    let missing_filters_root = build_paths(&empty_root.path().join("missing-filters"));
    assert!(discover_filters(&missing_filters_root).is_err());
    fs::write(
        env.paths.filters_dir.join("_private.py"),
        "print('private')",
    )
    .unwrap();
    fs::write(env.paths.filters_dir.join("note.txt"), "ignore").unwrap();
    fs::create_dir_all(env.paths.filters_dir.join("subdir")).unwrap();
    assert!(discover_filters(&env.paths).unwrap().is_empty());
    env.write_filter(
        "broken",
        "\"\"\"description: Broken filter\"\"\"\nprint('broken')\n",
    );
    fs::write(env.paths.filters_dir.join("broken.valves"), "{").unwrap();
    assert!(discover_filters(&env.paths).is_err());
    fs::write(env.paths.filters_dir.join("broken.valves"), "[]").unwrap();
    assert!(discover_filters(&env.paths).is_err());
    fs::remove_file(env.paths.filters_dir.join("broken.valves")).unwrap();
    let discovered_filters = discover_filters(&env.paths).unwrap();
    assert_eq!(discovered_filters.len(), 1);
    assert_eq!(discovered_filters[0].filter_id, "portico_core_broken");
    assert!(discovered_filters[0].valves.is_none());

    let missing_agents_root = build_paths(&empty_root.path().join("missing-agents"));
    assert!(discover_agents(&missing_agents_root).unwrap().is_empty());
    fs::write(env.paths.agents_dir.join("orphan.txt"), "ignore").unwrap();
    fs::create_dir_all(env.paths.agents_dir.join("dir-no-config")).unwrap();
    assert!(discover_agents(&env.paths).unwrap().is_empty());
    let hidden_agent_dir = env.paths.agents_dir.join("_hidden");
    fs::create_dir_all(&hidden_agent_dir).unwrap();
    fs::write(hidden_agent_dir.join("config.yaml"), "name: Hidden\n").unwrap();
    let broken_agent_dir = env.paths.agents_dir.join("broken-agent");
    fs::create_dir_all(&broken_agent_dir).unwrap();
    fs::write(broken_agent_dir.join("config.yaml"), "{").unwrap();
    env.write_agent(
        "visible-agent",
        "name: Visible\nbase_model_id: GPT-4.1\n",
        "Prompt",
    );
    let discovered_agents = discover_agents(&env.paths).unwrap();
    assert_eq!(discovered_agents.len(), 1);
    assert_eq!(discovered_agents[0].agent_id, "portico_agent_visible-agent");

    let app_install = build_app(
        &env,
        base_config(
            HealthCheckMode::Light,
            "http://unused",
            "http://unused-core",
            "http://unused-regular",
            "http://unused-host",
            "session",
        ),
        Arc::new(MockTokenStore::default()),
        Arc::new(MockLogInspector::default()),
    );
    let install_env = TestEnv::new("edge-case-install-empty");
    let empty_client =
        OpenWebUiClient::new(Client::new(), &server.base_url, Duration::from_secs(1));
    assert!(install_all_filters(&install_env.paths, &empty_client)
        .await
        .is_err());
    assert!(
        install_all_agents(&install_env.paths, &empty_client, &[], &[])
            .await
            .unwrap()
    );
    let wrapped_functions_env = TestEnv::new("edge-case-wrapped-functions");
    wrapped_functions_env.write_filter(
        "unified_context",
        "\"\"\"description: Wrapped filter\"\"\"\nprint('wrapped')\n",
    );
    let wrapped_functions_server = MockServer::start().await;
    let wrapped_functions_client = OpenWebUiClient::new(
        Client::new(),
        &wrapped_functions_server.base_url,
        Duration::from_secs(1),
    );
    wrapped_functions_server.queue_json("GET", "/api/v1/functions/", 200, json!({ "data": [] }));
    assert!(
        install_all_filters(&wrapped_functions_env.paths, &wrapped_functions_client)
            .await
            .is_err()
    );
    assert!(app_install.config.mode == HealthCheckMode::Light);

    let tools_error_server = MockServer::start().await;
    let tools_error_client = OpenWebUiClient::new(
        Client::new(),
        &tools_error_server.base_url,
        Duration::from_secs(1),
    );
    tools_error_server.queue_json("GET", "/api/v1/tools/", 500, json!({ "error": "fail" }));
    assert_eq!(
        build_migration_mapping(&tools_error_client, &BTreeMap::new())
            .await
            .unwrap(),
        (BTreeMap::new(), json!({}))
    );
    let wrapped_tools_server = MockServer::start().await;
    let wrapped_tools_client = OpenWebUiClient::new(
        Client::new(),
        &wrapped_tools_server.base_url,
        Duration::from_secs(1),
    );
    wrapped_tools_server.queue_json("GET", "/api/v1/tools/", 200, json!({ "data": [] }));
    assert!(
        build_migration_mapping(&wrapped_tools_client, &BTreeMap::new())
            .await
            .is_err()
    );
    let models_error_server = MockServer::start().await;
    let models_error_client = OpenWebUiClient::new(
        Client::new(),
        &models_error_server.base_url,
        Duration::from_secs(1),
    );
    models_error_server.queue_json(
        "GET",
        "/api/v1/tools/",
        200,
        json!([{ "id": "server:0", "name": "Zero" }]),
    );
    models_error_server.queue_json("GET", "/api/v1/models", 500, json!({ "error": "fail" }));
    assert_eq!(
        build_migration_mapping(&models_error_client, &BTreeMap::new())
            .await
            .unwrap(),
        (BTreeMap::new(), json!({}))
    );
    let wrapped_models_server = MockServer::start().await;
    let wrapped_models_client = OpenWebUiClient::new(
        Client::new(),
        &wrapped_models_server.base_url,
        Duration::from_secs(1),
    );
    wrapped_models_server.queue_json(
        "GET",
        "/api/v1/tools/",
        200,
        json!([{ "id": "server:0", "name": "Zero" }]),
    );
    wrapped_models_server.queue_json("GET", "/api/v1/models", 200, json!({ "data": [] }));
    assert!(
        build_migration_mapping(&wrapped_models_client, &BTreeMap::new())
            .await
            .is_err()
    );
    assert_eq!(find_best_match("target", &[], 0.6), (None, 0.0));

    let toggles_dir = env.paths.app_root.join("toggles-dir");
    fs::create_dir_all(&toggles_dir).unwrap();
    let mut directory_paths = env.paths.clone();
    directory_paths.mcp_toggles_file = toggles_dir.clone();
    assert!(load_mcp_toggles(&directory_paths).is_err());
    assert!(load_env_file(&toggles_dir).unwrap().is_empty());

    let empty_report = generate_migration_report(
        &env.paths,
        &json!({
            "models_skipped": [{ "model_id": "skip", "model_name": "Skip", "reason": "reason" }]
        }),
    )
    .unwrap();
    let empty_report_text = fs::read_to_string(empty_report).unwrap();
    assert!(empty_report_text.contains("No numeric IDs found"));
    assert!(empty_report_text.contains("No models needed migration"));
    assert!(empty_report_text.contains("MODELS SKIPPED"));

    assert_eq!(
        sanitize_model_for_update(&json!("value"), "user"),
        json!("value")
    );
    let model_error_server = MockServer::start().await;
    let model_error_client = OpenWebUiClient::new(
        Client::new(),
        &model_error_server.base_url,
        Duration::from_secs(1),
    );
    model_error_server.queue_json(
        "GET",
        "/api/v1/models/model?id=boom",
        500,
        json!({ "error": "boom" }),
    );
    assert!(get_model_by_id(&model_error_client, "boom").await.is_err());

    model_error_server.queue_text("POST", "/api/v1/models/create", 500, "bad", "text/plain");
    assert!(!create_model(&model_error_client, &json!({})).await.unwrap());

    model_error_server.queue_text(
        "POST",
        "/api/v1/models/model/delete",
        404,
        "missing",
        "text/plain",
    );
    model_error_server.queue_text(
        "DELETE",
        "/api/v1/models/final%2Dpath/delete",
        404,
        "missing",
        "text/plain",
    );
    model_error_server.queue_text(
        "DELETE",
        "/api/v1/models/model/delete?id=final-path",
        200,
        "ok",
        "text/plain",
    );
    assert!(
        delete_model_with_fallbacks(&model_error_client, "final-path")
            .await
            .unwrap()
    );

    let compare_server = MockServer::start().await;
    let compare_client = OpenWebUiClient::new(
        Client::new(),
        &compare_server.base_url,
        Duration::from_secs(1),
    );
    compare_server.queue_json(
        "GET",
        "/api/v1/portico/managed-functions/id/portico_core_match",
        200,
        json!({
            "id": "portico_core_match",
            "name": "portico_core_match",
            "type": "filter",
            "content": "print('same')",
            "meta": { "description": "Match" },
            "valves": { "enabled": true },
            "is_active": true,
            "is_global": true
        }),
    );
    let filter = FilterFile {
        file_path: env.paths.filters_dir.join("match.py"),
        filter_id: "portico_core_match".to_string(),
        name: "portico_core_match".to_string(),
        description: "Match".to_string(),
        code: "print('same')".to_string(),
        valves: Some(json!({ "enabled": true })),
    };
    let current = get_managed_function(&compare_client, "portico_core_match")
        .await
        .unwrap();
    assert!(managed_filter_state_matches(
        &filter,
        "print('same')",
        &current
    ));
    let mut changed_content = current.clone();
    changed_content["content"] = json!("# semantically important change\nprint('same')");
    assert!(!managed_filter_state_matches(
        &filter,
        "print('same')",
        &changed_content
    ));
    let mut changed_description = current.clone();
    changed_description["meta"]["description"] = json!("Stale description");
    assert!(!managed_filter_state_matches(
        &filter,
        "print('same')",
        &changed_description
    ));

    let oauth = OAuthStatusPayload {
        current: Some(json!({ "server_name": "other", "state": "active" })),
        ..OAuthStatusPayload::default()
    };
    let mut merged = OAuthStatusPayload {
        current: Some(json!({ "server_name": "keep", "state": "active" })),
        ..OAuthStatusPayload::default()
    };
    merge_oauth_status_payload(&mut merged, &json!({ "current": oauth.current.clone() }));
    assert_eq!(merged.current.unwrap()["server_name"], json!("keep"));
    assert_eq!(lookup_oauth_status_no_tools("nobody", &oauth), (None, None));
    assert_eq!(lookup_oauth_status_missing("nobody", &oauth), (None, None));
}

#[tokio::test]
async fn install_all_filters_and_agents_continue_after_failures() {
    let env = TestEnv::new("best-effort-install");
    env.write_filter(
        "unified_context",
        "\"\"\"description: First filter\"\"\"\nprint('first')\n",
    );
    env.write_filter(
        "second",
        "\"\"\"\ndescription: Second filter\n\"\"\"\nprint('second')\n",
    );
    env.write_agent(
        "first-agent",
        "name: First Agent\nbase_model_id: GPT-4.1\n",
        "One",
    );
    env.write_agent(
        "second-agent",
        "name: Second Agent\nbase_model_id: GPT-4.1\n",
        "Two",
    );

    let openwebui = MockServer::start().await;
    openwebui.queue_json("GET", "/api/v1/functions/", 200, json!([]));
    openwebui.queue_json(
        "POST",
        "/api/v1/utils/code/format",
        200,
        json!({ "code": "print('first')" }),
    );
    openwebui.queue_text(
        "PUT",
        "/api/v1/portico/managed-functions/id/portico_core_unified_context",
        500,
        "boom",
        "text/plain",
    );
    openwebui.queue_json(
        "POST",
        "/api/v1/utils/code/format",
        200,
        json!({ "code": "print('second')" }),
    );
    openwebui.queue_json(
        "PUT",
        "/api/v1/portico/managed-functions/id/portico_core_second",
        200,
        json!({ "ok": true }),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/portico/managed-functions/id/portico_core_second",
        200,
        json!({
            "id": "portico_core_second",
            "name": "portico_core_second",
            "type": "filter",
            "content": "print('second')",
            "meta": { "description": "Second filter" },
            "valves": null,
            "is_active": true,
            "is_global": true
        }),
    );

    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=portico_agent_first-agent",
        404,
        json!({ "error": "missing" }),
    );
    openwebui.queue_text("POST", "/api/v1/models/create", 500, "boom", "text/plain");
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=portico_agent_second-agent",
        404,
        json!({ "error": "missing" }),
    );
    openwebui.queue_text("POST", "/api/v1/models/create", 200, "ok", "text/plain");

    let client = OpenWebUiClient::new(Client::new(), &openwebui.base_url, Duration::from_secs(1));
    assert!(!install_all_filters(&env.paths, &client).await.unwrap());
    assert!(!install_all_agents(&env.paths, &client, &[], &[])
        .await
        .unwrap());

    let requests = openwebui.requests();
    assert!(requests
        .iter()
        .any(|request| request.path.ends_with("/id/portico_core_second")));
    assert!(requests
        .iter()
        .any(|request| request.body.contains("\"id\":\"portico_agent_second-agent\"")));
}

#[tokio::test]
async fn base_prompt_and_backup_helpers_are_best_effort() {
    let env = TestEnv::new("best-effort-models");
    let openwebui = MockServer::start().await;
    let client = OpenWebUiClient::new(Client::new(), &openwebui.base_url, Duration::from_secs(1));

    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=missing-backup",
        500,
        json!({ "error": "boom" }),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=good-backup",
        200,
        json!({ "id": "good-backup", "params": { "system": "keep me" } }),
    );
    assert!(
        backup_system_prompts(&env.paths, &client, &["missing-backup".to_string()],)
            .await
            .is_err()
    );
    let backed_up = backup_system_prompts(&env.paths, &client, &["good-backup".to_string()])
        .await
        .unwrap();
    assert_eq!(backed_up, 1);
    assert!(fs::read_dir(&env.paths.backup_dir)
        .unwrap()
        .flatten()
        .any(|entry| entry.file_name().to_string_lossy().contains("good-backup")));

    openwebui.queue_json("GET", "/api/v1/auths/", 200, json!({ "id": "user-1" }));
    openwebui.queue_json(
        "GET",
        "/api/models?",
        200,
        json!({
            "data": [
                { "id": "missing-model", "info": { "base_model_id": null } },
                { "id": "good-model", "info": { "base_model_id": null } }
            ]
        }),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=missing-model",
        404,
        json!({ "error": "missing" }),
    );
    openwebui.queue_json(
        "GET",
        "/api/models/missing%2Dmodel",
        404,
        json!({ "error": "missing" }),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models/missing%2Dmodel",
        404,
        json!({ "error": "missing" }),
    );
    openwebui.queue_json(
        "GET",
        "/api/v1/models/model?id=good-model",
        200,
        json!({ "id": "good-model", "params": {}, "info": {} }),
    );
    openwebui.queue_text(
        "POST",
        "/api/v1/models/model/update?id=good-model",
        200,
        "ok",
        "text/plain",
    );
    assert!(!update_base_models_system_prompt(&client, "prompt", &[])
        .await
        .unwrap());
    assert!(openwebui
        .requests()
        .iter()
        .any(|request| request.path == "/api/v1/models/model/update?id=good-model"));

    openwebui.queue_json("GET", "/api/v1/auths/", 200, json!({ "id": "user-1" }));
    openwebui.queue_json("GET", "/api/models?", 200, json!({ "models": [] }));
    assert!(update_base_models_system_prompt(&client, "prompt", &[])
        .await
        .is_err());
}

#[tokio::test]
async fn remaining_helper_failures_cover_filter_agent_prompt_and_migration_edges() {
    let env_filters = TestEnv::new("remaining-filter-failure");
    env_filters.write_filter(
        "unified_context",
        "\"\"\"description: Alpha\"\"\"\nprint('alpha')\n",
    );
    let openwebui_filters = MockServer::start().await;
    let client_filters = OpenWebUiClient::new(
        Client::new(),
        &openwebui_filters.base_url,
        Duration::from_secs(1),
    );
    openwebui_filters.queue_json(
        "GET",
        "/api/v1/functions/",
        200,
        json!([{ "id": "portico_core_unified_context" }]),
    );
    openwebui_filters.queue_json(
        "GET",
        "/api/v1/portico/managed-functions/id/portico_core_unified_context",
        200,
        json!({ "content": "print('old alpha')" }),
    );
    openwebui_filters.queue_text(
        "POST",
        "/api/v1/utils/code/format",
        500,
        "bad",
        "text/plain",
    );
    assert!(install_all_filters(&env_filters.paths, &client_filters)
        .await
        .is_err());
    assert!(openwebui_filters
        .requests()
        .iter()
        .all(|request| request.method == "GET" || request.path == "/api/v1/utils/code/format"));

    let env_agents = TestEnv::new("remaining-agent-failure");
    env_agents.write_agent(
        "odd-tools-mode",
        r#"
name: "Odd Tools"
base_model_id: "Claude Sonnet 4.5"
description: "Odd"
tools_mode: "weird"
"#,
        "Prompt",
    );
    let openwebui_agents = MockServer::start().await;
    let client_agents = OpenWebUiClient::new(
        Client::new(),
        &openwebui_agents.base_url,
        Duration::from_secs(1),
    );
    openwebui_agents.queue_json(
        "GET",
        "/api/v1/models/model?id=portico_agent_odd-tools-mode",
        200,
        json!({ "id": "portico_agent_odd-tools-mode" }),
    );
    openwebui_agents.queue_json(
        "GET",
        "/api/v1/models/model?id=portico_agent_odd-tools-mode",
        200,
        json!({ "id": "portico_agent_odd-tools-mode" }),
    );
    openwebui_agents.queue_json("GET", "/api/v1/auths/", 200, json!({ "id": "user-1" }));
    openwebui_agents.queue_text(
        "POST",
        "/api/v1/models/model/update?id=portico_agent_odd-tools-mode",
        500,
        "bad",
        "text/plain",
    );
    assert!(!install_all_agents(
        &env_agents.paths,
        &client_agents,
        &["server:mcp-assistant".to_string()],
        &[
            "server:mcp-assistant".to_string(),
            "server:skills".to_string()
        ],
    )
    .await
    .unwrap());

    let prompt_server = MockServer::start().await;
    let prompt_client = OpenWebUiClient::new(
        Client::new(),
        &prompt_server.base_url,
        Duration::from_secs(1),
    );
    assert!(update_base_models_system_prompt(&prompt_client, "", &[])
        .await
        .unwrap());
    prompt_server.queue_json("GET", "/api/v1/auths/", 200, json!({ "id": "" }));
    assert!(
        !update_base_models_system_prompt(&prompt_client, "prompt", &[])
            .await
            .unwrap()
    );
    prompt_server.queue_json("GET", "/api/v1/auths/", 200, json!({ "id": "user-2" }));
    prompt_server.queue_json(
        "GET",
        "/api/models?",
        200,
        json!({
            "data": [{ "id": "base-a", "info": { "base_model_id": null } }]
        }),
    );
    prompt_server.queue_json(
        "GET",
        "/api/v1/models/model?id=base-a",
        404,
        json!({ "error": "missing" }),
    );
    prompt_server.queue_json(
        "GET",
        "/api/models/base%2Da",
        404,
        json!({ "error": "missing" }),
    );
    prompt_server.queue_json(
        "GET",
        "/api/v1/models/base%2Da",
        404,
        json!({ "error": "missing" }),
    );
    assert!(
        !update_base_models_system_prompt(&prompt_client, "prompt", &[])
            .await
            .unwrap()
    );
    prompt_server.queue_json("GET", "/api/v1/auths/", 200, json!({ "id": "user-3" }));
    prompt_server.queue_json(
        "GET",
        "/api/models?",
        200,
        json!({
            "data": [{ "id": "base-b", "info": { "base_model_id": null } }]
        }),
    );
    prompt_server.queue_json(
        "GET",
        "/api/v1/models/model?id=base-b",
        200,
        json!({ "id": "base-b", "params": {}, "user": {}, "info": {} }),
    );
    prompt_server.queue_text(
        "POST",
        "/api/v1/models/model/update?id=base-b",
        500,
        "bad",
        "text/plain",
    );
    assert!(
        !update_base_models_system_prompt(&prompt_client, "prompt", &[])
            .await
            .unwrap()
    );

    let migration_server = MockServer::start().await;
    let migration_client = OpenWebUiClient::new(
        Client::new(),
        &migration_server.base_url,
        Duration::from_secs(1),
    );
    migration_server.queue_json(
        "GET",
        "/api/v1/tools/",
        200,
        json!([{ "id": "server:1", "name": "Time" }]),
    );
    migration_server.queue_json(
        "GET",
        "/api/v1/models",
        200,
        json!([{ "id": "user-1", "base_model_id": "Claude", "meta": { "toolIds": [] } }]),
    );
    assert!(build_migration_mapping(
        &migration_client,
        &BTreeMap::from([(
            "time".to_string(),
            DiscoveredTool {
                host: "regular".to_string(),
                port: "8765".to_string(),
            },
        )]),
    )
    .await
    .unwrap()
    .0
    .is_empty());

    let compare_server = MockServer::start().await;
    let compare_client = OpenWebUiClient::new(
        Client::new(),
        &compare_server.base_url,
        Duration::from_secs(1),
    );
    compare_server.queue_json(
        "GET",
        "/api/v1/portico/managed-functions/id/portico_core_valves",
        200,
        json!({
            "id": "portico_core_valves",
            "name": "portico_core_valves",
            "type": "filter",
            "content": "print('same')",
            "meta": { "description": "Valves" },
            "valves": { "enabled": true, "obsolete": true },
            "is_active": true,
            "is_global": true
        }),
    );
    let filter = FilterFile {
        file_path: env_filters.paths.filters_dir.join("alpha.py"),
        filter_id: "portico_core_valves".to_string(),
        name: "portico_core_valves".to_string(),
        description: "Valves".to_string(),
        code: "print('same')".to_string(),
        valves: Some(json!({ "enabled": true })),
    };
    let current = get_managed_function(&compare_client, "portico_core_valves")
        .await
        .unwrap();
    assert!(!managed_filter_state_matches(
        &filter,
        "print('same')",
        &current
    ));
}

#[tokio::test]
#[serial]
async fn retry_and_redis_paths_cover_remaining_bootstrap_branches() {
    let redis = MockRedisServer::start().await;
    std::env::set_var("HEALTH_CHECK_REDIS_URL", &redis.url);
    let good_retries = RetryConfig {
        redis_retries: 1,
        redis_delay: Duration::ZERO,
        ..fast_retries()
    };
    assert!(connect_redis_token_store(&good_retries)
        .await
        .unwrap()
        .is_some());

    std::env::set_var("HEALTH_CHECK_REDIS_URL", "redis://127.0.0.1:1/");
    let bad_retries = RetryConfig {
        redis_retries: 2,
        redis_delay: Duration::ZERO,
        ..fast_retries()
    };
    assert!(connect_redis_token_store(&bad_retries)
        .await
        .unwrap()
        .is_none());

    let env = TestEnv::new("run-retry");
    fs::remove_file(&env.paths.health_check_mode_file).unwrap();
    let broken_yaml_dir = env.paths.mcp_configs_dir.join("broken");
    fs::create_dir_all(&broken_yaml_dir).unwrap();
    fs::write(broken_yaml_dir.join("broken.yaml"), ":\n").unwrap();
    let openwebui = MockServer::start().await;
    openwebui.queue_json(
        "POST",
        "/api/v1/portico/auth/service-token",
        200,
        json!({ "token": "token-1" }),
    );
    openwebui.queue_json(
        "POST",
        "/api/v1/portico/auth/service-token",
        200,
        json!({ "token": "token-2" }),
    );
    let app = HealthCheckApp::new(
        env.paths.clone(),
        base_config(
            HealthCheckMode::Full,
            &openwebui.base_url,
            "http://unused-core",
            "http://unused-regular",
            "http://unused-host",
            "",
        ),
        RetryConfig {
            main_retries: 2,
            main_delay: Duration::ZERO,
            ..fast_retries()
        },
        None,
        Arc::new(MockLogInspector::default()),
    );
    std::env::remove_var("HEALTH_CHECK_MODE");
    assert!(!app.run().await.unwrap());

    std::env::set_var("HEALTH_CHECK_MODE", "light");
    let env_mode = TestEnv::new("run-env-mode");
    fs::remove_file(&env_mode.paths.health_check_mode_file).unwrap();
    let openwebui_mode = MockServer::start().await;
    openwebui_mode.queue_json(
        "POST",
        "/api/v1/portico/auth/service-token",
        500,
        json!({ "error": "fail" }),
    );
    let app_mode = HealthCheckApp::new(
        env_mode.paths,
        base_config(
            HealthCheckMode::Light,
            &openwebui_mode.base_url,
            "http://unused-core",
            "http://unused-regular",
            "http://unused-host",
            "session",
        ),
        RetryConfig {
            main_retries: 1,
            main_delay: Duration::ZERO,
            ..fast_retries()
        },
        None,
        Arc::new(MockLogInspector::default()),
    );
    assert!(!app_mode.run().await.unwrap());

    let run_default_env = TestEnv::new("run-default-no-skip");
    std::env::set_var("portico_HEALTH_CHECK_APP_ROOT", &run_default_env.paths.app_root);
    std::env::set_var("HEALTH_CHECK_MODE", "light");
    assert!(!run_default().await.unwrap());

    for key in [
        "HEALTH_CHECK_REDIS_URL",
        "portico_HEALTH_CHECK_APP_ROOT",
        "HEALTH_CHECK_MODE",
    ] {
        std::env::remove_var(key);
    }
}
