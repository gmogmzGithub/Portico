use super::*;
use std::future::Future;
use std::sync::OnceLock;

static ELECTRON_HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

pub fn electron_http_client() -> &'static reqwest::Client {
    ELECTRON_HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .pool_max_idle_per_host(4)
            .build()
            .expect("failed to build shared Electron HTTP client")
    })
}

pub fn success_text(payload: Value) -> Result<Value> {
    Ok(json!({
        "content": [{
            "type": "text",
            // Compact JSON: every byte here lands in model context. Pretty
            // indentation roughly doubled large catalog payloads for zero
            // model benefit (models parse compact JSON fine).
            "text": serde_json::to_string(&payload)?,
        }],
        "structuredContent": Value::Null,
        "isError": false,
    }))
}

// MCP tool ERROR carrying the envelope verbatim. Confirmed-write failures
// (denied / timed-out / cancelled approvals, failed publishes) must be
// unmistakable: a success-shaped result wrapping {success:false} let models
// narrate expired approval flows as completed work (2026-08-03 incident).
pub fn error_text(payload: Value) -> Result<Value> {
    Ok(json!({
        "content": [{
            "type": "text",
            "text": serde_json::to_string(&payload)?,
        }],
        "structuredContent": Value::Null,
        "isError": true,
    }))
}

pub fn plain_text(text: impl Into<String>) -> Value {
    json!({
        "content": [{
            "type": "text",
            "text": text.into(),
        }],
        "structuredContent": Value::Null,
        "isError": false,
    })
}

pub fn app_root() -> Result<PathBuf> {
    if Path::new("/app").exists() {
        return Ok(PathBuf::from("/app"));
    }

    let mut current = env::current_dir().context("failed to determine current directory")?;
    loop {
        if current.join("mcp-configs").exists() {
            return Ok(current);
        }
        if !current.pop() {
            bail!("failed to locate project root containing mcp-configs");
        }
    }
}

pub fn container_root() -> Result<PathBuf> {
    if let Ok(path) = env::var("CONTAINER_PROJECT_ROOT") {
        if !path.trim().is_empty() {
            return Ok(PathBuf::from(path));
        }
    }
    app_root()
}

pub fn mcp_configs_dir() -> Result<PathBuf> {
    Ok(app_root()?.join("mcp-configs"))
}

pub fn mcp_configs_user_dir() -> Result<PathBuf> {
    Ok(app_root()?.join("mcp-configs-user"))
}

pub fn redis_url() -> String {
    let host = env::var("REDIS_HOST").unwrap_or_else(|_| "redis".to_string());
    let port = env::var("REDIS_PORT").unwrap_or_else(|_| "6379".to_string());
    format!("redis://{host}:{port}/")
}

pub fn redis_connection() -> Result<redis::Connection> {
    let client = redis::Client::open(redis_url()).context("failed to create redis client")?;
    client
        .get_connection()
        .context("failed to connect to redis")
}

pub fn redis_get_string(key: &str) -> Result<Option<String>> {
    if let Some(value) = test_redis_get_string(key) {
        return Ok(value);
    }
    let mut conn = redis_connection()?;
    conn.get(key).context(format!("failed redis GET for {key}"))
}

pub fn redis_setex_string(key: &str, value: &str, ttl_seconds: u64) -> Result<()> {
    if test_redis_setex_string(key, value, ttl_seconds) {
        return Ok(());
    }
    let mut conn = redis_connection()?;
    let _: () = conn
        .set_ex(key, value, ttl_seconds)
        .context(format!("failed redis SETEX for {key}"))?;
    Ok(())
}

pub fn redis_set_nx_ex_string(key: &str, value: &str, ttl_seconds: u64) -> Result<bool> {
    if let Some(acquired) = test_redis_set_nx_ex_string(key, value, ttl_seconds) {
        return Ok(acquired);
    }
    let mut conn = redis_connection()?;
    let result: Option<String> = redis::cmd("SET")
        .arg(key)
        .arg(value)
        .arg("NX")
        .arg("EX")
        .arg(ttl_seconds)
        .query(&mut conn)
        .context(format!("failed redis SET NX EX for {key}"))?;
    Ok(result.is_some())
}

pub fn redis_compare_delete(key: &str, expected_value: &str) -> Result<bool> {
    if let Some(deleted) = test_redis_compare_delete(key, expected_value) {
        return Ok(deleted);
    }
    let mut conn = redis_connection()?;
    let deleted: i32 = redis::Script::new(
        r#"
            if redis.call("GET", KEYS[1]) == ARGV[1] then
                return redis.call("DEL", KEYS[1])
            end
            return 0
        "#,
    )
    .key(key)
    .arg(expected_value)
    .invoke(&mut conn)
    .context(format!("failed redis compare-delete for {key}"))?;
    Ok(deleted > 0)
}

fn chat_capabilities_lock_key(chat_id: &str) -> String {
    format!("chat_capabilities_lock:{chat_id}")
}

struct ChatCapabilitiesLockGuard {
    key: String,
    token: String,
    released: bool,
}

impl ChatCapabilitiesLockGuard {
    async fn acquire(chat_id: &str) -> Result<Self> {
        let key = chat_capabilities_lock_key(chat_id);
        let token = Uuid::new_v4().to_string();
        let started_at = now_epoch_seconds();
        loop {
            if redis_set_nx_ex_string(&key, &token, CHAT_CAPABILITIES_LOCK_TTL_SECONDS)? {
                return Ok(Self {
                    key,
                    token,
                    released: false,
                });
            }
            if (now_epoch_seconds() - started_at).max(0.0) >= CHAT_CAPABILITIES_LOCK_WAIT_SECONDS {
                bail!("timed out acquiring chat capabilities lock for {chat_id}");
            }
            tokio::time::sleep(std::time::Duration::from_millis(
                CHAT_CAPABILITIES_LOCK_POLL_INTERVAL_MILLIS,
            ))
            .await;
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

impl Drop for ChatCapabilitiesLockGuard {
    fn drop(&mut self) {
        self.release();
    }
}

pub async fn with_chat_capabilities_lock<F, Fut, T>(chat_id: &str, operation: F) -> Result<T>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<T>>,
{
    let _guard = ChatCapabilitiesLockGuard::acquire(chat_id).await?;
    operation().await
}

pub fn redis_delete(key: &str) -> Result<()> {
    if test_redis_delete(key) {
        return Ok(());
    }
    let mut conn = redis_connection()?;
    let _: usize = conn
        .del(key)
        .context(format!("failed redis DEL for {key}"))?;
    Ok(())
}

pub fn redis_scan_keys(pattern: &str) -> Result<Vec<String>> {
    if let Some(keys) = test_redis_scan_keys(pattern) {
        return Ok(keys);
    }

    let mut conn = redis_connection()?;
    let mut cursor: u64 = 0;
    let mut keys = Vec::new();

    loop {
        let (next_cursor, batch): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg(pattern)
            .arg("COUNT")
            .arg(100)
            .query(&mut conn)
            .context(format!("failed redis SCAN for {pattern}"))?;
        keys.extend(batch);
        if next_cursor == 0 {
            break;
        }
        cursor = next_cursor;
    }

    keys.sort();
    keys.dedup();
    Ok(keys)
}

pub fn redis_smembers(key: &str) -> Result<Vec<String>> {
    if let Some(members) = test_redis_smembers(key) {
        return Ok(members);
    }
    let mut conn = redis_connection()?;
    conn.smembers(key)
        .context(format!("failed redis SMEMBERS for {key}"))
}

pub fn now_epoch_seconds() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64())
        .unwrap_or(0.0)
}

pub fn yaml_map(path: &Path) -> Result<serde_yaml::Mapping> {
    let raw = fs::read_to_string(path)
        .with_context(|| format!("failed to read YAML config {}", path.display()))?;
    let parsed: serde_yaml::Value = serde_yaml::from_str(&raw)
        .with_context(|| format!("failed to parse YAML config {}", path.display()))?;
    parsed
        .as_mapping()
        .cloned()
        .ok_or_else(|| anyhow!("YAML config is not a mapping: {}", path.display()))
}

pub fn yaml_value_to_json(value: &serde_yaml::Value) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

pub fn yaml_string(map: &serde_yaml::Mapping, key: &str) -> Option<String> {
    map.get(&serde_yaml::Value::String(key.to_string()))
        .and_then(|value| value.as_str())
        .map(str::to_string)
}

pub fn yaml_bool(map: &serde_yaml::Mapping, key: &str) -> Option<bool> {
    map.get(&serde_yaml::Value::String(key.to_string()))
        .and_then(|value| value.as_bool())
}

pub fn yaml_array_strings(map: &serde_yaml::Mapping, key: &str) -> Vec<String> {
    map.get(&serde_yaml::Value::String(key.to_string()))
        .and_then(|value| value.as_sequence())
        .map(|seq| {
            seq.iter()
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

pub fn path_to_unix_string(root: &Path, path: &Path) -> Option<String> {
    path.strip_prefix(root).ok().map(|relative| {
        relative
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/")
    })
}

struct VmExecResult {
    exit_code: i64,
    stdout: String,
    stderr: String,
}

pub fn host_root() -> Result<PathBuf> {
    if let Ok(path) = env::var("HOST_PROJECT_ROOT") {
        if !path.trim().is_empty() {
            return Ok(PathBuf::from(path));
        }
    }
    container_root()
}

pub fn container_workspaces_dir() -> Result<PathBuf> {
    Ok(container_root()?.join("workspaces"))
}

pub fn host_workspaces_dir() -> Result<PathBuf> {
    Ok(host_root()?.join("workspaces"))
}

pub fn container_artifact_snapshots_dir() -> Result<PathBuf> {
    Ok(container_root()?.join(ARTIFACT_SNAPSHOTS_DIR))
}

pub fn host_artifact_snapshots_dir() -> Result<PathBuf> {
    Ok(host_root()?.join(ARTIFACT_SNAPSHOTS_DIR))
}

pub fn app_support_dir() -> Result<PathBuf> {
    if let Ok(path) = env::var("PORTICO_APP_SUPPORT_DIR") {
        if !path.trim().is_empty() {
            return Ok(PathBuf::from(path));
        }
    }

    let mounted = container_root()?.join("app-support");
    if mounted.exists() {
        return Ok(mounted);
    }

    Ok(app_root()?.join("open-webui-data").join("app-support"))
}

pub fn workspace_cfg_dir() -> Result<PathBuf> {
    if let Ok(path) = env::var("PORTICO_WORKSPACE_CFG_DIR") {
        if !path.trim().is_empty() {
            return Ok(PathBuf::from(path));
        }
    }

    let mounted = container_root()?.join("workspace-cfg");
    if mounted.exists() {
        return Ok(mounted);
    }

    Ok(app_root()?.join("open-webui-data").join("workspace-cfg"))
}

pub const CHAT_WORKSPACES_SETTINGS_FILE_NAME: &str = "chat-workspaces.json";

#[derive(Debug, Clone)]
pub struct ResolvedChatWorkspaceBinding {
    pub host_path: PathBuf,
    /// True when host_path is a GENERATED directory under the workspaces
    /// root — either the chat's own `workspaces/<chat_id>` or, for
    /// workspace-linked chats, the root chat's `workspaces/<root_id>`.
    /// Consumers use this to know the dir is container-visible and safe to
    /// create on demand.
    pub canonical: bool,
}

pub fn chat_workspace_settings_file_path() -> Result<PathBuf> {
    Ok(workspace_cfg_dir()?.join(CHAT_WORKSPACES_SETTINGS_FILE_NAME))
}

fn legacy_chat_workspace_settings_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(path) = app_support_dir().map(|dir| dir.join(CHAT_WORKSPACES_SETTINGS_FILE_NAME)) {
        paths.push(path);
    }
    if let Ok(path) = app_root().map(|root| {
        root.join("open-webui-data")
            .join("app-support")
            .join(CHAT_WORKSPACES_SETTINGS_FILE_NAME)
    }) {
        if !paths.iter().any(|existing| existing == &path) {
            paths.push(path);
        }
    }
    paths
}

pub fn read_chat_workspace_settings_value() -> Option<Value> {
    let settings_path = chat_workspace_settings_file_path().ok()?;
    let mut path_to_read = settings_path.clone();
    if !path_to_read.exists() {
        path_to_read = legacy_chat_workspace_settings_paths()
            .into_iter()
            .find(|path| path != &settings_path && path.exists())?;
    }

    let raw = fs::read_to_string(&path_to_read).ok()?;
    let parsed = serde_json::from_str::<Value>(&raw).ok()?;
    if path_to_read != settings_path {
        if let Some(parent) = settings_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(rendered) = serde_json::to_string_pretty(&parsed) {
            let _ = fs::write(&settings_path, format!("{rendered}\n"));
        }
    }
    Some(parsed)
}

/// Chat-id sanity check for ids read from tool args or the settings file
/// before they participate in a path join.
fn sane_workspace_chat_id(chat_id: &str) -> Option<&str> {
    let normalized = chat_id.trim();
    if normalized.is_empty()
        || normalized.contains('/')
        || normalized.contains('\\')
        || normalized.contains('\0')
        || normalized.starts_with('.')
    {
        return None;
    }
    Some(normalized)
}

fn custom_entry_host_path(entry: &Map<String, Value>) -> Option<PathBuf> {
    if entry.get("source").and_then(Value::as_str) != Some("custom") {
        return None;
    }
    let host_path = PathBuf::from(entry.get("host_path").and_then(Value::as_str)?);
    host_path.is_absolute().then_some(host_path)
}

fn entry_is_linked(entry: &Map<String, Value>) -> bool {
    entry.get("linked_workspace").and_then(Value::as_bool) == Some(true)
}

pub fn resolve_chat_workspace_binding(chat_id: &str) -> Result<ResolvedChatWorkspaceBinding> {
    let canonical_for = |id: &str| -> Result<ResolvedChatWorkspaceBinding> {
        Ok(ResolvedChatWorkspaceBinding {
            host_path: host_workspaces_dir()?.join(id),
            canonical: true,
        })
    };

    let Some(value) = read_chat_workspace_settings_value() else {
        return canonical_for(chat_id);
    };
    let chats = value.get("chats").and_then(Value::as_object);
    let Some(entry) = chats
        .and_then(|chats| chats.get(chat_id))
        .and_then(Value::as_object)
    else {
        return canonical_for(chat_id);
    };

    // Workspace-linked chats (started by another chat) follow the ROOT
    // chat's CURRENT binding, one hop only. Any anomaly — bad root id,
    // self-link, root itself linked — falls through to the entry's own
    // snapshot host_path below.
    if entry_is_linked(entry) {
        if let Some(root_chat_id) = entry
            .get("root_parent_chat_id")
            .and_then(Value::as_str)
            .and_then(sane_workspace_chat_id)
            .filter(|root| *root != chat_id)
        {
            let root_entry = chats
                .and_then(|chats| chats.get(root_chat_id))
                .and_then(Value::as_object);
            match root_entry {
                Some(root_entry) if entry_is_linked(root_entry) => {}
                Some(root_entry) => {
                    if let Some(host_path) = custom_entry_host_path(root_entry) {
                        return Ok(ResolvedChatWorkspaceBinding {
                            host_path,
                            canonical: false,
                        });
                    }
                    return canonical_for(root_chat_id);
                }
                None => return canonical_for(root_chat_id),
            }
        }
    }

    match custom_entry_host_path(entry) {
        Some(host_path) => Ok(ResolvedChatWorkspaceBinding {
            host_path,
            canonical: false,
        }),
        None => canonical_for(chat_id),
    }
}

pub fn resolve_local_workspace_path(path: &Path) -> Result<PathBuf> {
    let host_root = host_root()?;
    let container_root = container_root()?;
    if host_root == container_root {
        return Ok(path.to_path_buf());
    }

    let container_workspaces = container_workspaces_dir()?;
    if let Ok(relative) = path.strip_prefix(&container_workspaces) {
        return Ok(container_workspaces.join(relative));
    }

    let host_workspaces = host_workspaces_dir()?;
    if let Ok(relative) = path.strip_prefix(&host_workspaces) {
        return Ok(container_workspaces.join(relative));
    }

    bail!(
        "workspace root '{}' is not accessible from this process; expected it under '{}'",
        path.display(),
        host_workspaces.display()
    )
}

pub fn scheduled_tasks_dir() -> Result<PathBuf> {
    Ok(app_support_dir()?.join("scheduled_tasks"))
}

pub fn skills_system_dir() -> Result<PathBuf> {
    Ok(app_root()?.join("skills"))
}

pub fn skills_user_dir() -> Result<PathBuf> {
    Ok(app_root()?.join("skills-user"))
}

pub fn skills_marketplace_dir() -> Result<PathBuf> {
    Ok(app_root()?.join("skills-marketplace"))
}

pub fn electron_api_base() -> String {
    env::var("ELECTRON_API_BASE").unwrap_or_else(|_| "http://host.docker.internal:9876".to_string())
}

pub fn openwebui_base_url() -> String {
    env::var("OPENWEBUI_BASE_URL").unwrap_or_else(|_| "http://open-webui:8080".to_string())
}

pub fn safe_path_component(value: &str) -> String {
    let mut cleaned = value
        .replace('/', "")
        .replace('\\', "")
        .replace('\0', "")
        .trim()
        .trim_start_matches('.')
        .to_string();
    if cleaned.len() > 255 {
        cleaned.truncate(255);
    }
    cleaned
}

pub fn write_text_atomic(path: &Path, contents: &str) -> Result<()> {
    path.parent()
        .map(|parent| {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create parent dir {}", parent.display()))
        })
        .transpose()?;
    let temp_path = path.with_extension(format!(
        "{}.tmp",
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or("tmp")
    ));
    fs::write(&temp_path, contents)
        .with_context(|| format!("failed to write temp file {}", temp_path.display()))?;
    finalize_atomic_write(&temp_path, path, contents, rename_path, write_path_contents)?;
    Ok(())
}

fn rename_path(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::rename(source, target)
}

fn write_path_contents(path: &Path, contents: &str) -> std::io::Result<()> {
    fs::write(path, contents)
}

fn finalize_atomic_write<R, W>(
    temp_path: &Path,
    path: &Path,
    contents: &str,
    rename_fn: R,
    write_fn: W,
) -> Result<()>
where
    R: FnOnce(&Path, &Path) -> std::io::Result<()>,
    W: FnOnce(&Path, &str) -> std::io::Result<()>,
{
    match rename_fn(temp_path, path) {
        Ok(()) => Ok(()),
        Err(rename_error) => {
            write_fn(path, contents).with_context(|| {
                format!(
                    "failed to move {} to {} and fallback write failed: {rename_error}",
                    temp_path.display(),
                    path.display()
                )
            })?;
            let _ = fs::remove_file(temp_path);
            Ok(())
        }
    }
}

pub fn write_json_atomic(path: &Path, value: &Value) -> Result<()> {
    write_text_atomic(path, &serde_json::to_string_pretty(value)?)
}

pub fn write_yaml_atomic(path: &Path, value: &Value) -> Result<()> {
    let yaml = serde_yaml::to_string(value).context("failed to encode YAML")?;
    write_text_atomic(path, &yaml)
}

pub fn read_json_file(path: &Path) -> Result<Value> {
    let raw = fs::read_to_string(path)
        .with_context(|| format!("failed to read JSON file {}", path.display()))?;
    serde_json::from_str(&raw)
        .with_context(|| format!("failed to decode JSON file {}", path.display()))
}

pub fn redis_set_string(key: &str, value: &str) -> Result<()> {
    if test_redis_set_string(key, value) {
        return Ok(());
    }
    let mut conn = redis_connection()?;
    let _: () = conn
        .set(key, value)
        .context(format!("failed redis SET for {key}"))?;
    Ok(())
}

pub fn redis_persist(key: &str) -> Result<bool> {
    if let Some(persisted) = test_redis_persist(key) {
        return Ok(persisted);
    }
    let mut conn = redis_connection()?;
    conn.persist(key)
        .context(format!("failed redis PERSIST for {key}"))
}

pub fn redis_ttl(key: &str) -> Result<i64> {
    if let Some(ttl) = test_redis_ttl(key) {
        return Ok(ttl);
    }
    let mut conn = redis_connection()?;
    conn.ttl(key).context(format!("failed redis TTL for {key}"))
}

pub fn redis_sadd(key: &str, member: &str) -> Result<()> {
    if test_redis_sadd(key, member) {
        return Ok(());
    }
    let mut conn = redis_connection()?;
    let _: usize = conn
        .sadd(key, member)
        .context(format!("failed redis SADD for {key}"))?;
    Ok(())
}

pub fn redis_srem(key: &str, member: &str) -> Result<()> {
    if test_redis_srem(key, member) {
        return Ok(());
    }
    let mut conn = redis_connection()?;
    let _: usize = conn
        .srem(key, member)
        .context(format!("failed redis SREM for {key}"))?;
    Ok(())
}

pub fn redis_sismember(key: &str, member: &str) -> Result<bool> {
    if let Some(value) = test_redis_sismember(key, member) {
        return Ok(value);
    }
    let mut conn = redis_connection()?;
    conn.sismember(key, member)
        .context(format!("failed redis SISMEMBER for {key}"))
}

pub fn redis_incr(key: &str) -> Result<i64> {
    if let Some(value) = test_redis_incr(key)? {
        return Ok(value);
    }
    let mut conn = redis_connection()?;
    conn.incr(key, 1)
        .context(format!("failed redis INCR for {key}"))
}

pub fn redis_lpush(key: &str, value: &str) -> Result<()> {
    if test_redis_lpush(key, value) {
        return Ok(());
    }
    let mut conn = redis_connection()?;
    let _: i64 = conn
        .lpush(key, value)
        .context(format!("failed redis LPUSH for {key}"))?;
    Ok(())
}

/// Pop a single value from the right of `key`. Non-blocking. Returns
/// `Ok(None)` if the list is empty. Used by the in-memory test stub and as a
/// fallback path; production callers prefer `redis_brpop_blocking` for
/// instant wake-ups.
pub fn redis_rpop(key: &str) -> Result<Option<String>> {
    if let Some(value) = test_redis_rpop(key) {
        return Ok(value);
    }
    let mut conn = redis_connection()?;
    let value: Option<String> = conn
        .rpop(key, None)
        .context(format!("failed redis RPOP for {key}"))?;
    Ok(value)
}

/// Block on `BRPOP key timeout` for up to `timeout_seconds`. Returns
/// `Ok(Some(value))` on signal, `Ok(None)` on timeout. `timeout_seconds` of
/// 0 means block forever. WARNING: this blocks the calling thread; from
/// async contexts call it inside `tokio::task::spawn_blocking`.
pub fn redis_brpop_blocking(key: &str, timeout_seconds: u64) -> Result<Option<String>> {
    if test_redis_enabled() {
        // Test stub does not implement true blocking; return any queued
        // value or None immediately so tests don't hang.
        return Ok(test_redis_rpop(key).flatten());
    }
    let mut conn = redis_connection()?;
    let result: Option<(String, String)> = redis::cmd("BRPOP")
        .arg(key)
        .arg(timeout_seconds)
        .query(&mut conn)
        .context(format!("failed redis BRPOP for {key}"))?;
    Ok(result.map(|(_, value)| value))
}

#[derive(Default)]
struct TestRedisState {
    strings: HashMap<String, TestRedisString>,
    sets: HashMap<String, HashSet<String>>,
    lists: HashMap<String, std::collections::VecDeque<String>>,
}

#[derive(Clone)]
struct TestRedisString {
    value: String,
    expires_at: Option<f64>,
}

fn test_redis_enabled() -> bool {
    env::var("CORE_MCP_TEST_REDIS").ok().as_deref() == Some("memory")
}

fn test_redis_state() -> &'static std::sync::Mutex<TestRedisState> {
    static STATE: std::sync::OnceLock<std::sync::Mutex<TestRedisState>> =
        std::sync::OnceLock::new();
    STATE.get_or_init(|| std::sync::Mutex::new(TestRedisState::default()))
}

pub fn reset_test_redis_state() {
    let mut state = test_redis_state()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    *state = TestRedisState::default();
}

fn with_test_redis<R>(operation: impl FnOnce(&mut TestRedisState) -> R) -> Option<R> {
    if !test_redis_enabled() {
        return None;
    }
    let mut state = test_redis_state()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    prune_test_redis(&mut state);
    Some(operation(&mut state))
}

fn prune_test_redis(state: &mut TestRedisState) {
    let now = now_epoch_seconds();
    state
        .strings
        .retain(|_, value| value.expires_at.map(|ttl| ttl > now).unwrap_or(true));
}

fn test_redis_get_string(key: &str) -> Option<Option<String>> {
    with_test_redis(|state| state.strings.get(key).map(|entry| entry.value.clone()))
}

fn test_redis_setex_string(key: &str, value: &str, ttl_seconds: u64) -> bool {
    with_test_redis(|state| {
        state.strings.insert(
            key.to_string(),
            TestRedisString {
                value: value.to_string(),
                expires_at: Some(now_epoch_seconds() + ttl_seconds as f64),
            },
        );
    })
    .is_some()
}

fn test_redis_set_nx_ex_string(key: &str, value: &str, ttl_seconds: u64) -> Option<bool> {
    with_test_redis(|state| {
        if state.strings.contains_key(key) {
            false
        } else {
            state.strings.insert(
                key.to_string(),
                TestRedisString {
                    value: value.to_string(),
                    expires_at: Some(now_epoch_seconds() + ttl_seconds as f64),
                },
            );
            true
        }
    })
}

fn test_redis_set_string(key: &str, value: &str) -> bool {
    with_test_redis(|state| {
        state.strings.insert(
            key.to_string(),
            TestRedisString {
                value: value.to_string(),
                expires_at: None,
            },
        );
    })
    .is_some()
}

fn test_redis_persist(key: &str) -> Option<bool> {
    with_test_redis(|state| {
        let Some(entry) = state.strings.get_mut(key) else {
            return false;
        };
        let had_expiry = entry.expires_at.is_some();
        entry.expires_at = None;
        had_expiry
    })
}

fn test_redis_ttl(key: &str) -> Option<i64> {
    with_test_redis(|state| match state.strings.get(key) {
        Some(TestRedisString {
            expires_at: Some(expires_at),
            ..
        }) => ((*expires_at - now_epoch_seconds()).ceil() as i64).max(0),
        Some(TestRedisString {
            expires_at: None, ..
        }) => -1,
        None => -2,
    })
}

fn test_redis_sadd(key: &str, member: &str) -> bool {
    with_test_redis(|state| {
        state
            .sets
            .entry(key.to_string())
            .or_default()
            .insert(member.to_string());
    })
    .is_some()
}

fn test_redis_delete(key: &str) -> bool {
    with_test_redis(|state| {
        state.strings.remove(key);
        state.sets.remove(key);
    })
    .is_some()
}

fn test_redis_scan_keys(pattern: &str) -> Option<Vec<String>> {
    with_test_redis(|state| {
        let matcher = Pattern::new(pattern).ok();
        let mut keys = state
            .strings
            .keys()
            .chain(state.sets.keys())
            .chain(state.lists.keys())
            .filter(|key| matcher.as_ref().is_none_or(|pattern| pattern.matches(key)))
            .cloned()
            .collect::<Vec<_>>();
        keys.sort();
        keys.dedup();
        keys
    })
}

fn test_redis_lpush(key: &str, value: &str) -> bool {
    with_test_redis(|state| {
        state
            .lists
            .entry(key.to_string())
            .or_default()
            .push_front(value.to_string());
    })
    .is_some()
}

/// Returns `Some(Some(value))` when a value was popped, `Some(None)` when
/// the test stub is enabled but the list is empty, or `None` when the test
/// stub is disabled (caller should fall through to real Redis).
fn test_redis_rpop(key: &str) -> Option<Option<String>> {
    with_test_redis(|state| {
        state
            .lists
            .get_mut(key)
            .and_then(|deque| deque.pop_back())
            .map(Some)
            .unwrap_or(None)
    })
}

/// Test-only helper: return the contents of a list (front to back) without
/// removing them. Useful for asserting that signals were enqueued.
pub fn test_redis_list_snapshot(key: &str) -> Option<Vec<String>> {
    with_test_redis(|state| {
        state
            .lists
            .get(key)
            .map(|deque| deque.iter().cloned().collect::<Vec<_>>())
            .unwrap_or_default()
    })
}

fn test_redis_compare_delete(key: &str, expected_value: &str) -> Option<bool> {
    with_test_redis(|state| match state.strings.get(key) {
        Some(entry) if entry.value == expected_value => {
            state.strings.remove(key);
            true
        }
        _ => false,
    })
}

fn test_redis_smembers(key: &str) -> Option<Vec<String>> {
    with_test_redis(|state| {
        let mut members = state
            .sets
            .get(key)
            .map(|set| set.iter().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        members.sort();
        members
    })
}

fn test_redis_srem(key: &str, member: &str) -> bool {
    with_test_redis(|state| {
        let should_remove = state.sets.get_mut(key).is_some_and(|set| {
            set.remove(member);
            set.is_empty()
        });
        if should_remove {
            state.sets.remove(key);
        }
    })
    .is_some()
}

fn test_redis_sismember(key: &str, member: &str) -> Option<bool> {
    with_test_redis(|state| {
        state
            .sets
            .get(key)
            .map(|set| set.contains(member))
            .unwrap_or(false)
    })
}

fn test_redis_incr(key: &str) -> Result<Option<i64>> {
    match with_test_redis(|state| {
        let next = match state.strings.get(key) {
            Some(entry) => entry.value.parse::<i64>(),
            None => Ok(0),
        };
        next.map(|value| {
            let updated = value + 1;
            state.strings.insert(
                key.to_string(),
                TestRedisString {
                    value: updated.to_string(),
                    expires_at: None,
                },
            );
            updated
        })
    }) {
        Some(Ok(value)) => Ok(Some(value)),
        Some(Err(_)) => bail!("failed redis INCR for {key}"),
        None => Ok(None),
    }
}

pub fn array_strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str().map(str::trim))
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

pub fn map_arg(arguments: &Map<String, Value>, key: &str) -> Result<Map<String, Value>> {
    arguments
        .get(key)
        .and_then(Value::as_object)
        .cloned()
        .context(format!("{key} must be an object"))
}

pub fn string_arg(arguments: &Map<String, Value>, key: &str) -> Result<String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .context(format!("{key} is required"))
}

pub fn bool_arg(arguments: &Map<String, Value>, key: &str, default: bool) -> bool {
    arguments
        .get(key)
        .and_then(Value::as_bool)
        .unwrap_or(default)
}

pub fn float_arg(arguments: &Map<String, Value>, key: &str, default: f64) -> f64 {
    arguments
        .get(key)
        .and_then(Value::as_f64)
        .unwrap_or(default)
}

pub fn int_arg(arguments: &Map<String, Value>, key: &str, default: i64) -> i64 {
    arguments
        .get(key)
        .and_then(Value::as_i64)
        .unwrap_or(default)
}

pub fn toggle_file_candidates() -> Result<Vec<PathBuf>> {
    Ok(vec![
        app_root()?.join("mcp_toggles.json"),
        host_root()?.join("mcp_toggles.json"),
    ])
}

fn server_yaml_candidates(server_id: &str) -> Vec<PathBuf> {
    let bare_id = bare_server_id(server_id);
    let file_name = format!("{bare_id}.yaml");
    let mut candidates = Vec::new();

    if let Ok(dir) = mcp_configs_dir() {
        candidates.push(dir.join(bare_id).join(&file_name));
    }
    if let Ok(dir) = mcp_configs_user_dir() {
        candidates.push(dir.join(bare_id).join(&file_name));
    }

    candidates
}

pub fn is_core_server_config(server_id: &str) -> bool {
    for yaml_path in server_yaml_candidates(server_id) {
        if !yaml_path.exists() {
            continue;
        }

        if let Ok(yaml) = yaml_map(&yaml_path) {
            return yaml_bool(&yaml, "is_core").unwrap_or(false);
        }
    }

    false
}

pub fn load_mcp_toggles() -> HashMap<String, bool> {
    toggle_file_candidates()
        .ok()
        .into_iter()
        .flatten()
        .find_map(|path| {
            if !path.exists() {
                return None;
            }
            match fs::read_to_string(&path) {
                Ok(raw) => serde_json::from_str::<HashMap<String, bool>>(&raw).ok(),
                Err(_) => None,
            }
        })
        .unwrap_or_default()
}

pub fn save_mcp_toggles(toggles: &HashMap<String, bool>) -> Result<()> {
    let value = serde_json::to_value(toggles).context("failed to encode toggle JSON")?;
    let candidates = toggle_file_candidates()?;
    let path = candidates
        .into_iter()
        .find(|path| path.exists())
        .unwrap_or_else(|| {
            app_root()
                .unwrap_or_else(|_| PathBuf::from("/app"))
                .join("mcp_toggles.json")
        });
    write_json_atomic(&path, &value)
}

pub fn bare_server_id(server_id: &str) -> &str {
    server_id.strip_prefix("server:").unwrap_or(server_id)
}

/// PORTICO-410 hard-disable sidecar candidates, snapshot-first.
///
/// The health-status snapshot is preferred because it is reached through a
/// DIRECTORY bind mount, which keeps following the host's atomic rename
/// replacements; an individual file bind pins the original inode and goes
/// stale (or ENOENT) after the first rewrite. Electron rewrites both files on
/// every mutation, and compose seeding refreshes the snapshot at start.
pub fn disable_modes_file_candidates() -> Result<Vec<PathBuf>> {
    let app = app_root()?;
    let host = host_root()?;
    Ok(vec![
        app.join("health-status").join("mcp_disable_modes_snapshot.json"),
        app.join("mcp_disable_modes.json"),
        host.join("health-status").join("mcp_disable_modes_snapshot.json"),
        host.join("mcp_disable_modes.json"),
    ])
}

/// Parse a disable-modes payload: either the bare `{id: "hard"}` map or the
/// snapshot wrapper `{"modes": {...}}`. Returns `None` for invalid JSON or a
/// non-object payload (so callers can fall through to the next candidate),
/// and keeps only string "hard" entries otherwise.
pub fn parse_disable_modes_payload(raw: &str) -> Option<HashMap<String, String>> {
    let parsed: Value = serde_json::from_str(raw).ok()?;
    let mut map = parsed.as_object()?;
    if let Some(inner) = map.get("modes").and_then(Value::as_object) {
        map = inner;
    }
    Some(
        map.iter()
            .filter_map(|(server_id, value)| {
                let mode = value.as_str()?.trim().to_ascii_lowercase();
                if mode == "hard" {
                    Some((server_id.clone(), mode))
                } else {
                    None
                }
            })
            .collect::<HashMap<String, String>>(),
    )
}

/// Load the PORTICO-410 hard-disable sidecar map (server id -> "hard").
///
/// Deliberately tolerant, unlike the strict boolean toggle parse: only string
/// "hard" entries are kept and ANY read/parse problem yields an empty map —
/// missing or corrupt state degrades to today's soft-disable behavior instead
/// of dead-ending tool calls.
pub fn load_mcp_disable_modes() -> HashMap<String, String> {
    disable_modes_file_candidates()
        .ok()
        .into_iter()
        .flatten()
        .find_map(|path| {
            if !path.exists() {
                return None;
            }
            let raw = fs::read_to_string(&path).ok()?;
            parse_disable_modes_payload(&raw)
        })
        .unwrap_or_default()
}

/// True when the user hard-disabled this server from the Control Plane.
/// Hard-disabled servers must be opaque to the model: excluded from listings
/// and never enable-able from chat.
pub fn is_server_hard_disabled(server_id: &str) -> bool {
    let bare_id = bare_server_id(server_id);
    load_mcp_disable_modes()
        .get(bare_id)
        .map(|mode| mode == "hard")
        .unwrap_or(false)
}

pub fn is_server_enabled_in_toggles(server_id: &str) -> bool {
    let bare_id = bare_server_id(server_id);
    if is_core_server_config(bare_id) {
        return true;
    }

    let toggles = load_mcp_toggles();
    match toggles.get(bare_id).copied() {
        Some(enabled) => enabled,
        None => true,
    }
}

pub async fn electron_get_json(path: &str, timeout_seconds: f64) -> Result<Value> {
    electron_http_client()
        .get(format!("{}{}", electron_api_base(), path))
        .timeout(std::time::Duration::from_secs_f64(timeout_seconds))
        .send()
        .await
        .with_context(|| format!("failed GET {}", path))?
        .error_for_status()
        .with_context(|| format!("GET {} returned error", path))?
        .json()
        .await
        .with_context(|| format!("failed to decode GET {}", path))
}

pub async fn electron_post_json(
    path: &str,
    payload: &Value,
    timeout_seconds: f64,
) -> Result<Value> {
    electron_http_client()
        .post(format!("{}{}", electron_api_base(), path))
        .timeout(std::time::Duration::from_secs_f64(timeout_seconds))
        .json(payload)
        .send()
        .await
        .with_context(|| format!("failed POST {}", path))?
        .error_for_status()
        .with_context(|| format!("POST {} returned error", path))?
        .json()
        .await
        .with_context(|| format!("failed to decode POST {}", path))
}

// Marketplace write confirmations (publish-agent / publish-skill / unpublish)
// use the app's standard long-flow contract — the same start+poll shape as
// ask_user_question and request_sensitive_information: the Electron route
// registers the confirmation flow and responds immediately with a pending
// flow id, and the tool polls the flow-status endpoint with short requests
// while the user decides in the modal. Budgets mirror
// marketplace-publish-confirm-flows.js: a 300s decision window plus the
// publish-execution phase = 420s total, and the poller waits that plus a 30s
// grace. Nothing here blocks a single HTTP call on the user.
pub const MARKETPLACE_PUBLISH_START_TIMEOUT_SECONDS: f64 = 45.0;
pub const MARKETPLACE_PUBLISH_FLOW_BUDGET_SECONDS: u64 = 420;
const MARKETPLACE_PUBLISH_POLL_TIMEOUT_SECONDS: f64 = 15.0;
const MARKETPLACE_PUBLISH_POLL_INTERVAL_MS: u64 = 1000;

/// Best-effort: dismiss the pending confirmation when this tool call ends
/// without an outcome (poll failure / tool timeout). Failures are ignored —
/// the flow-level timers in Electron remain the backstop.
async fn cancel_marketplace_publish_flow(flow_id: &str, reason: &str) {
    let _ = electron_post_json(
        "/api/ai-marketplace/cancel-publish-flow",
        &json!({ "flow_id": flow_id, "reason": reason }),
        MARKETPLACE_PUBLISH_POLL_TIMEOUT_SECONDS,
    )
    .await;
}

/// POST a confirmation-gated marketplace write and wait out the user's
/// decision via flow-status polling. Returns the route's FINAL envelope —
/// non-pending START responses (validation errors, degraded fallback paths,
/// or an older Electron build that still blocks) pass through unchanged.
pub async fn electron_marketplace_confirmed_write(path: &str, payload: &Value) -> Result<Value> {
    let response =
        electron_post_json(path, payload, MARKETPLACE_PUBLISH_START_TIMEOUT_SECONDS).await?;
    let flow_id = match (
        response.get("status").and_then(Value::as_str),
        response.get("flow_id").and_then(Value::as_str),
    ) {
        (Some("pending"), Some(flow_id)) => flow_id.to_string(),
        _ => return Ok(response),
    };
    let max_wait = std::time::Duration::from_secs(
        MARKETPLACE_PUBLISH_FLOW_BUDGET_SECONDS.saturating_add(30),
    );
    let started = std::time::Instant::now();
    while started.elapsed() <= max_wait {
        tokio::time::sleep(std::time::Duration::from_millis(
            MARKETPLACE_PUBLISH_POLL_INTERVAL_MS,
        ))
        .await;
        let status = match electron_get_json(
            &format!("/api/ai-marketplace/publish-flow-status/{flow_id}"),
            MARKETPLACE_PUBLISH_POLL_TIMEOUT_SECONDS,
        )
        .await
        {
            Ok(status) => status,
            Err(error) => {
                cancel_marketplace_publish_flow(&flow_id, "poll_error").await;
                return Ok(json!({
                    "success": false,
                    "status": "error",
                    "error": format!("Failed to poll the publish confirmation flow: {error}"),
                }));
            }
        };
        if status.get("success").and_then(Value::as_bool) != Some(true) {
            cancel_marketplace_publish_flow(&flow_id, "status_error").await;
            return Ok(status);
        }
        if status.get("status").and_then(Value::as_str) == Some("completed") {
            return Ok(status.get("result").cloned().unwrap_or_else(|| {
                json!({
                    "success": false,
                    "status": "error",
                    "error": "Electron reported a completed publish flow without a result",
                })
            }));
        }
    }
    cancel_marketplace_publish_flow(&flow_id, "tool_timeout").await;
    Ok(json!({
        "success": false,
        "status": "timeout",
        "error": "The publish confirmation timed out before the flow finished, so nothing further was written.",
    }))
}

pub async fn openwebui_get_json(path: &str, token: &str) -> Result<Value> {
    reqwest::Client::new()
        .get(format!("{}{}", openwebui_base_url(), path))
        .headers(auth_headers(token)?)
        .send()
        .await
        .with_context(|| format!("failed GET {}", path))?
        .error_for_status()
        .with_context(|| format!("GET {} returned error", path))?
        .json()
        .await
        .with_context(|| format!("failed to decode GET {}", path))
}

pub async fn openwebui_post_json(
    path: &str,
    token: &str,
    payload: &Value,
    timeout_seconds: f64,
) -> Result<Value> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs_f64(timeout_seconds))
        .build()
        .context("failed to build Open WebUI client")?
        .post(format!("{}{}", openwebui_base_url(), path))
        .headers(auth_headers(token)?)
        .json(payload)
        .send()
        .await
        .with_context(|| format!("failed POST {}", path))?
        .error_for_status()
        .with_context(|| format!("POST {} returned error", path))?
        .json()
        .await
        .with_context(|| format!("failed to decode POST {}", path))
}

/// POST that surfaces the HTTP status and parsed body instead of erroring on
/// non-2xx. Callers that must read structured error payloads (e.g. policy
/// rejection codes in a 400's `detail`) use this; `openwebui_post_json`'s
/// `error_for_status()` discards the response body.
pub async fn openwebui_post_json_status(
    path: &str,
    token: &str,
    payload: &Value,
    timeout_seconds: f64,
) -> Result<(u16, Value)> {
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs_f64(timeout_seconds))
        .build()
        .context("failed to build Open WebUI client")?
        .post(format!("{}{}", openwebui_base_url(), path))
        .headers(auth_headers(token)?)
        .json(payload)
        .send()
        .await
        .with_context(|| format!("failed POST {}", path))?;
    let status = response.status().as_u16();
    let body = response.json::<Value>().await.unwrap_or(Value::Null);
    Ok((status, body))
}

pub async fn openwebui_delete_json(
    path: &str,
    token: &str,
    payload: Option<&Value>,
) -> Result<Value> {
    let client = reqwest::Client::new();
    let mut request = client.delete(format!("{}{}", openwebui_base_url(), path));
    request = request.headers(auth_headers(token)?);
    if let Some(payload) = payload {
        request = request.json(payload);
    }
    request
        .send()
        .await
        .with_context(|| format!("failed DELETE {}", path))?
        .error_for_status()
        .with_context(|| format!("DELETE {} returned error", path))?
        .json()
        .await
        .with_context(|| format!("failed to decode DELETE {}", path))
}

pub fn auth_headers(token: &str) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    if !token.is_empty() {
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}"))
                .context("invalid bearer token header")?,
        );
    }
    Ok(headers)
}

#[cfg(test)]
#[path = "shared_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "shared_more_tests.rs"]
mod more_tests;
