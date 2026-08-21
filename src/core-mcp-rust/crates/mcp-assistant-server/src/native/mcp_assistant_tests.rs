use super::*;
use crate::native::TEST_ENV_LOCK;
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;
use uuid::Uuid;

const PNG_BYTES: &[u8] = b"\x89PNG\r\n\x1a\nfakepng";

pub(super) struct TestEnv {
    _guard: MutexGuard<'static, ()>,
    root: PathBuf,
    previous_cwd: PathBuf,
    previous_container_root: Option<String>,
    previous_host_root: Option<String>,
    previous_electron_api_base: Option<String>,
    previous_openwebui_base_url: Option<String>,
    previous_test_redis: Option<String>,
}

impl TestEnv {
    pub(super) fn new(name: &str) -> Self {
        let guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let root = env::temp_dir().join(format!(
            "core-mcp-rust-mcp-assistant-{name}-{}",
            Uuid::new_v4().simple()
        ));
        fs::create_dir_all(root.join("mcp-configs")).expect("create mcp-configs");
        fs::create_dir_all(root.join("mcp-configs-user")).expect("create mcp-configs-user");
        fs::create_dir_all(root.join("assets")).expect("create assets");
        let previous_cwd = env::current_dir().expect("current dir");
        let previous_container_root = env::var("CONTAINER_PROJECT_ROOT").ok();
        let previous_host_root = env::var("HOST_PROJECT_ROOT").ok();
        let previous_electron_api_base = env::var("ELECTRON_API_BASE").ok();
        let previous_openwebui_base_url = env::var("OPENWEBUI_BASE_URL").ok();
        let previous_test_redis = env::var("CORE_MCP_TEST_REDIS").ok();
        env::set_current_dir(&root).expect("set current dir");
        env::set_var("CONTAINER_PROJECT_ROOT", &root);
        env::set_var("HOST_PROJECT_ROOT", &root);
        env::set_var("CORE_MCP_TEST_REDIS", "memory");
        env::set_var("OPENWEBUI_BASE_URL", "http://127.0.0.1:9");
        Self {
            _guard: guard,
            root,
            previous_cwd,
            previous_container_root,
            previous_host_root,
            previous_electron_api_base,
            previous_openwebui_base_url,
            previous_test_redis,
        }
    }

    pub(super) fn set_electron_base(&self, base: &str) {
        env::set_var("ELECTRON_API_BASE", base);
    }

    fn write_yaml(&self, user: bool, server_id: &str, yaml: &str) -> PathBuf {
        let dir = if user {
            self.root.join("mcp-configs-user").join(server_id)
        } else {
            self.root.join("mcp-configs").join(server_id)
        };
        fs::create_dir_all(&dir).expect("create server dir");
        let path = dir.join(format!("{server_id}.yaml"));
        fs::write(&path, yaml).expect("write yaml");
        path
    }

    fn write_fragment(&self, user: bool, server_id: &str, fragment: &Value) -> PathBuf {
        let dir = if user {
            self.root.join("mcp-configs-user").join(server_id)
        } else {
            self.root.join("mcp-configs").join(server_id)
        };
        fs::create_dir_all(&dir).expect("create server dir");
        let path = dir.join(format!("{server_id}.fragment"));
        fs::write(&path, serde_json::to_string_pretty(fragment).unwrap()).expect("write fragment");
        path
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
        if let Some(value) = &self.previous_electron_api_base {
            env::set_var("ELECTRON_API_BASE", value);
        } else {
            env::remove_var("ELECTRON_API_BASE");
        }
        if let Some(value) = &self.previous_openwebui_base_url {
            env::set_var("OPENWEBUI_BASE_URL", value);
        } else {
            env::remove_var("OPENWEBUI_BASE_URL");
        }
        if let Some(value) = &self.previous_test_redis {
            env::set_var("CORE_MCP_TEST_REDIS", value);
        } else {
            env::remove_var("CORE_MCP_TEST_REDIS");
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[derive(Clone)]
pub(super) struct MockReply {
    pub(super) status: &'static str,
    pub(super) body: Value,
}

#[derive(Debug)]
pub(super) struct CapturedRequest {
    pub(super) method: String,
    pub(super) path: String,
    pub(super) headers: String,
    pub(super) body: String,
}

pub(super) fn args(entries: &[(&str, Value)]) -> Map<String, Value> {
    entries
        .iter()
        .map(|(key, value)| ((*key).to_string(), value.clone()))
        .collect()
}

pub(super) fn response_payload(response: Value) -> Value {
    serde_json::from_str(
        response["content"][0]["text"]
            .as_str()
            .expect("missing response text"),
    )
    .expect("invalid JSON payload")
}

fn recv_request(receiver: &mpsc::Receiver<CapturedRequest>) -> CapturedRequest {
    receiver
        .recv_timeout(Duration::from_secs(5))
        .expect("mock Electron request")
}

fn yaml_config(name: &str, server_id: &str, deployment_type: &str) -> Map<String, Value> {
    Map::from_iter([
        ("name".to_string(), json!(name)),
        ("id".to_string(), json!(server_id)),
        ("display_name".to_string(), json!(format!("{name} Display"))),
        ("deployment_type".to_string(), json!(deployment_type)),
        (
            "description".to_string(),
            json!(format!("{name} description")),
        ),
    ])
}

fn stdio_fragment() -> Map<String, Value> {
    Map::from_iter([
        ("command".to_string(), json!("python3")),
        ("args".to_string(), json!(["server.py"])),
        ("env".to_string(), json!({"API_TOKEN": "secret"})),
    ])
}

fn read_http_request(stream: &mut std::net::TcpStream) -> CapturedRequest {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 1024];
    let header_end;
    loop {
        let read = stream.read(&mut chunk).expect("read request");
        assert!(read > 0, "client closed before headers");
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(index) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            header_end = index + 4;
            break;
        }
    }

    let header_text = String::from_utf8(buffer[..header_end].to_vec()).expect("header utf8");
    let request_line = header_text
        .split("\r\n")
        .find(|line| !line.is_empty())
        .expect("missing request line");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    let content_length = header_text
        .split("\r\n")
        .find_map(|line| {
            let lower = line.to_ascii_lowercase();
            lower
                .strip_prefix("content-length:")
                .map(|value| value.trim().parse::<usize>().expect("valid content length"))
        })
        .unwrap_or(0);
    let mut body = buffer[header_end..].to_vec();
    while body.len() < content_length {
        let read = stream.read(&mut chunk).expect("read body");
        assert!(read > 0, "client closed before body complete");
        body.extend_from_slice(&chunk[..read]);
    }
    CapturedRequest {
        method,
        path,
        headers: header_text,
        body: String::from_utf8(body).expect("body utf8"),
    }
}

pub(super) fn serve_responses(
    replies: Vec<MockReply>,
) -> (String, mpsc::Receiver<CapturedRequest>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind listener");
    let base = format!("http://{}", listener.local_addr().expect("listener addr"));
    let (tx, rx) = mpsc::channel();
    let replies = Arc::new(Mutex::new(replies));
    thread::spawn(move || loop {
        let reply = {
            let mut lock = replies.lock().expect("lock replies");
            if lock.is_empty() {
                return;
            }
            lock.remove(0)
        };
        let (mut stream, _) = listener.accept().expect("accept request");
        let request = read_http_request(&mut stream);
        let _ = tx.send(request);
        let body = serde_json::to_vec(&reply.body).expect("encode reply");
        let response = format!(
                "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                reply.status,
                body.len()
            );
        stream
            .write_all(response.as_bytes())
            .and_then(|_| stream.write_all(&body))
            .expect("write response");
    });
    (base, rx)
}

pub(super) fn serve_disconnect_then_responses(
    replies: Vec<MockReply>,
) -> (String, mpsc::Receiver<CapturedRequest>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind listener");
    let base = format!("http://{}", listener.local_addr().expect("listener addr"));
    let (tx, rx) = mpsc::channel();

    thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let request = read_http_request(&mut stream);
            tx.send(request).expect("send request");
            drop(stream);
        }

        for reply in replies {
            let (mut stream, _) = listener.accept().expect("accept connection");
            let request = read_http_request(&mut stream);
            tx.send(request).expect("send request");

            let body = serde_json::to_string(&reply.body).expect("serialize reply body");
            let response = format!(
                "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                reply.status,
                body.len(),
                body
            );
            stream
                .write_all(response.as_bytes())
                .expect("write response");
        }
    });

    (base, rx)
}

#[tokio::test]
async fn list_servers_reads_filters_and_skips_bad_entries() {
    let env = TestEnv::new("list");
    env.write_yaml(
        false,
        "system-one",
        "name: System One\ndisplay_name: System One\ndescription: System desc\nis_core: true\noauth:\n  mode: browser\n",
    );
    env.write_yaml(true, "user-one", "name: User One\n");
    fs::create_dir_all(env.root.join("mcp-configs/no-yaml")).unwrap();
    fs::write(env.root.join("mcp-configs/README.txt"), "not a dir").unwrap();
    env.write_yaml(false, "broken", "not: [valid");

    let all = response_payload(handle_list_mcp_servers(&Map::new()).await.unwrap());
    assert_eq!(all["summary"]["total"], json!(2));
    assert_eq!(all["summary"]["system"], json!(1));
    assert_eq!(all["summary"]["user"], json!(1));
    assert_eq!(all["summary"]["core"], json!(1));
    assert_eq!(all["servers"][0]["oauth"]["mode"], json!("browser"));
    assert_eq!(all["servers"][1]["deployment_type"], json!("docker"));

    let system = response_payload(
        handle_list_mcp_servers(&args(&[("filter", json!("system"))]))
            .await
            .unwrap(),
    );
    assert_eq!(system["summary"]["total"], json!(1));

    let user = response_payload(
        handle_list_mcp_servers(&args(&[("filter", json!("user"))]))
            .await
            .unwrap(),
    );
    assert_eq!(user["summary"]["total"], json!(1));

    let unknown = response_payload(
        handle_list_mcp_servers(&args(&[("filter", json!("unknown"))]))
            .await
            .unwrap(),
    );
    assert_eq!(unknown["summary"]["total"], json!(0));

    fs::remove_dir_all(env.root.join("mcp-configs-user")).unwrap();
    assert!(read_mcp_servers(true).unwrap().is_empty());
}

#[tokio::test]
async fn list_servers_reserves_system_ids_before_parsing_user_configs() {
    let env = TestEnv::new("list-collision-precedence");
    env.write_yaml(false, "collision", "name: System Collision\n");
    env.write_yaml(true, "collision", "name: User Collision\n");
    fs::create_dir_all(env.root.join("mcp-configs/incomplete")).unwrap();
    env.write_yaml(true, "incomplete", "name: User Must Not Leak\n");
    env.write_yaml(true, "user-only", "name: User Only\n");

    let all = response_payload(handle_list_mcp_servers(&Map::new()).await.unwrap());
    assert_eq!(all["summary"]["total"], json!(2));
    assert_eq!(all["summary"]["system"], json!(1));
    assert_eq!(all["summary"]["user"], json!(1));
    let ids = all["servers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|server| server["id"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(ids, vec!["collision", "user-only"]);

    let user = response_payload(
        handle_list_mcp_servers(&args(&[("filter", json!("user"))]))
            .await
            .unwrap(),
    );
    assert_eq!(user["summary"]["total"], json!(1));
    assert_eq!(user["servers"][0]["id"], json!("user-only"));
}

#[tokio::test]
async fn list_servers_honors_include_disabled_toggle_policy() {
    let env = TestEnv::new("list-enabled-filter");
    env.write_yaml(false, "core-one", "name: Core One\nis_core: true\n");
    env.write_yaml(false, "enabled-one", "name: Enabled One\n");
    env.write_yaml(false, "disabled-one", "name: Disabled One\n");
    env.write_yaml(false, "token-one", "name: Token One\n");
    env.write_yaml(false, "missing-one", "name: Missing One\n");

    save_mcp_toggles(&HashMap::from([
        ("enabled-one".to_string(), true),
        ("disabled-one".to_string(), false),
    ]))
    .unwrap();

    let token_dir = env.root.join("mcpo-oauth-tokens/token-one/tokens");
    fs::create_dir_all(&token_dir).unwrap();
    fs::write(token_dir.join("saved_tokens.json"), "{}").unwrap();

    let filtered = response_payload(
        handle_list_mcp_servers(&args(&[("include_disabled", json!(false))]))
            .await
            .unwrap(),
    );
    let returned_ids = filtered["servers"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|server| server.get("id").and_then(Value::as_str))
        .collect::<Vec<_>>();

    assert_eq!(
        returned_ids,
        vec!["core-one", "enabled-one", "missing-one", "token-one"]
    );
    assert_eq!(filtered["summary"]["total"], json!(4));
}

#[tokio::test]
async fn read_json_compatible_yaml_and_system_config_cover_errors() {
    let env = TestEnv::new("yaml");
    let missing = read_json_compatible_yaml(&env.root.join("missing.yaml")).unwrap_err();
    assert!(missing.to_string().contains("failed to read YAML file"));

    let invalid_path = env.root.join("bad.yaml");
    fs::write(&invalid_path, "not: [valid").unwrap();
    let invalid = read_json_compatible_yaml(&invalid_path).unwrap_err();
    assert!(invalid.to_string().contains("failed to parse YAML file"));

    let numeric_key_path = env.root.join("numeric.yaml");
    fs::write(&numeric_key_path, "? [1, 2]\n: value\n").unwrap();
    let conversion = read_json_compatible_yaml(&numeric_key_path).unwrap_err();
    assert!(conversion
        .to_string()
        .contains("failed to convert YAML to JSON"));

    env.write_yaml(
        false,
        "chrome-devtools",
        "name: Chrome DevTools\ndisplay_name: Chrome DevTools\ndeployment_type: host\ndescription: test\n",
    );
    env.write_fragment(
        false,
        "chrome-devtools",
        &json!({"command": "npx", "args": ["chrome-devtools-mcp@latest"]}),
    );
    let payload = response_payload(
        handle_get_system_mcp_config(&args(&[("server_id", json!("chrome-devtools"))]))
            .await
            .unwrap(),
    );
    assert_eq!(payload["server_id"], json!("chrome-devtools"));
    assert_eq!(payload["readonly"], json!(true));
    assert_eq!(payload["fragment"]["command"], json!("npx"));
}

#[tokio::test]
async fn persist_toggle_and_create_user_server_cover_success_and_errors() {
    let env = TestEnv::new("create");
    fs::write(env.root.join("assets/agent-icon.png"), PNG_BYTES).unwrap();

    let (base, requests) = serve_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({"success": true}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "enabled": true, "healthy": true, "readiness_phase": "tool_ready"}),
        },
    ]);
    env.set_electron_base(&base);

    persist_mcp_toggle("alpha", true).await.unwrap();
    assert_eq!(load_mcp_toggles().get("alpha"), Some(&true));
    let request = recv_request(&requests);
    assert_eq!(request.path, "/api/persist-mcp-toggle");
    assert_eq!(request.method, "POST");
    assert!(request.body.contains("\"server_id\":\"alpha\""));

    let payload = response_payload(
        handle_create_user_mcp_server(&args(&[
            ("server_id", json!("remote-one")),
            (
                "yaml_config",
                Value::Object(yaml_config("Remote One", "remote-one", "host")),
            ),
            (
                "fragment",
                json!({
                    "command": "npx",
                    "args": [
                        "mcp-remote",
                        "https://example.com/mcp",
                        "--static-oauth-client-metadata",
                        "{\"redirect_uris\":[\"http://localhost/callback\"]}"
                    ]
                }),
            ),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(payload["success"], json!(true));
    assert_eq!(payload["enabled"], json!(true));
    assert_eq!(payload["auto_enabled"], json!(true));
    assert_eq!(
        payload["message"],
        json!("User-installed MCP server 'remote-one' created and enabled")
    );
    assert!(payload["warnings"].as_array().unwrap().iter().any(|item| {
        item.as_str()
            .unwrap()
            .contains("Normalized mcp-remote OAuth fragment")
    }));
    assert!(env
        .root
        .join("mcp-configs-user/remote-one/remote-one.png")
        .exists());
    assert_eq!(
        read_json_file(
            &env.root
                .join("mcp-configs-user/remote-one/remote-one.fragment")
        )
        .unwrap()["type"],
        json!("streamable-http")
    );
    let create_request = recv_request(&requests);
    assert_eq!(create_request.path, "/api/toggle-mcp-server");
    assert_eq!(create_request.method, "POST");
    assert!(create_request.body.contains("\"server_id\":\"remote-one\""));
    assert!(create_request.body.contains("\"enabled\":true"));

    env.set_electron_base("http://127.0.0.1:9");
    let failed_toggle = persist_mcp_toggle("beta", false).await.unwrap_err();
    assert!(failed_toggle
        .to_string()
        .contains("cannot connect to Electron app"));
    assert!(load_mcp_toggles().get("beta").is_none());
    let create_error = handle_create_user_mcp_server(&args(&[
        ("server_id", json!("rolled-back")),
        (
            "yaml_config",
            Value::Object(yaml_config("Rolled Back", "rolled-back", "docker")),
        ),
        ("fragment", Value::Object(stdio_fragment())),
    ]))
    .await
    .unwrap();
    let create_error = response_payload(create_error);
    assert_eq!(create_error["success"], json!(true));
    assert_eq!(create_error["enabled"], json!(false));
    assert_eq!(create_error["auto_enabled"], json!(false));
    assert_eq!(
        create_error["message"],
        json!("User-installed MCP server 'rolled-back' created, but auto-enable failed")
    );
    assert!(env.root.join("mcp-configs-user/rolled-back").exists());

    let (base_error_body, _error_body_requests) = serve_responses(vec![
        MockReply {
            status: "500 ERROR",
            body: json!({"success": false, "error": "persist rejected"}),
        },
        MockReply {
            status: "500 ERROR",
            body: json!({"success": false, "error": "toggle rejected"}),
        },
    ]);
    env.set_electron_base(&base_error_body);
    let structured_toggle_error = persist_mcp_toggle("beta-structured", false)
        .await
        .unwrap_err();
    assert!(structured_toggle_error
        .to_string()
        .contains("persist rejected"));
    let create_structured_error = handle_create_user_mcp_server(&args(&[
        ("server_id", json!("rolled-back-structured")),
        (
            "yaml_config",
            Value::Object(yaml_config(
                "Rolled Back Structured",
                "rolled-back-structured",
                "docker",
            )),
        ),
        ("fragment", Value::Object(stdio_fragment())),
    ]))
    .await
    .unwrap();
    let create_structured_error = response_payload(create_structured_error);
    assert_eq!(create_structured_error["success"], json!(true));
    assert_eq!(create_structured_error["auto_enabled"], json!(false));
    assert_eq!(create_structured_error["error"], json!("toggle rejected"));
    assert!(env
        .root
        .join("mcp-configs-user/rolled-back-structured")
        .exists());

    let (base_followup, _followup_requests) = serve_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({"success": true}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "enabled": true, "healthy": true, "readiness_phase": "tool_ready"}),
        },
    ]);
    env.set_electron_base(&base_followup);
    let toggles_path = env.root.join("mcp_toggles.json");
    fs::remove_file(&toggles_path).unwrap();
    fs::create_dir_all(&toggles_path).unwrap();

    persist_mcp_toggle("gamma", true).await.unwrap();

    let create_with_broken_local_toggle = response_payload(
        handle_create_user_mcp_server(&args(&[
            ("server_id", json!("local-mirror-warning")),
            (
                "yaml_config",
                Value::Object(yaml_config(
                    "Local Mirror Warning",
                    "local-mirror-warning",
                    "docker",
                )),
            ),
            ("fragment", Value::Object(stdio_fragment())),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(create_with_broken_local_toggle["success"], json!(true));
    assert_eq!(create_with_broken_local_toggle["auto_enabled"], json!(true));
    assert!(env
        .root
        .join("mcp-configs-user/local-mirror-warning")
        .exists());

    for idx in 0..MAX_USER_MCP_SERVERS {
        fs::create_dir_all(env.root.join("mcp-configs-user").join(format!("srv-{idx}"))).unwrap();
    }
    let limit_error = handle_create_user_mcp_server(&args(&[
        ("server_id", json!("too-many")),
        (
            "yaml_config",
            Value::Object(yaml_config("Too Many", "too-many", "docker")),
        ),
        ("fragment", Value::Object(stdio_fragment())),
    ]))
    .await
    .unwrap_err();
    assert!(limit_error.to_string().contains("Maximum of"));
}

#[tokio::test]
async fn update_user_server_refuses_when_yaml_missing() {
    // PORTICO-276: updating a user server whose <id>.yaml does not exist must be
    // refused without writing anything, so the update APIs can never leave the
    // fragment-only state that hard-fails startup (PORTICO-261).
    let env = TestEnv::new("portico276-update-missing-yaml");

    // Case A: server was never created — no directory at all.
    let err = handle_update_user_mcp_server(&args(&[
        ("server_id", json!("orphaned-user")),
        (
            "fragment",
            json!({"command": "uvx", "args": ["synthetic-mcp"]}),
        ),
    ]))
    .await
    .unwrap_err();
    assert!(
        err.to_string().contains("does not exist"),
        "unexpected error: {err}"
    );
    assert!(
        !env.root.join("mcp-configs-user/orphaned-user").exists(),
        "a refused update must not create the server directory"
    );

    // Case B: partial directory (fragment present, yaml missing) — the exact
    // PORTICO-261 fragment-only state. The update must still be refused and must not
    // create the yaml or otherwise repair the broken server.
    let dir = env.root.join("mcp-configs-user/partial-user");
    fs::create_dir_all(&dir).expect("create partial dir");
    fs::write(
        dir.join("partial-user.fragment"),
        "{\n  \"command\": \"uvx\"\n}\n",
    )
    .expect("write fragment");

    let err = handle_update_user_mcp_server(&args(&[
        ("server_id", json!("partial-user")),
        ("fragment", json!({"command": "uvx", "args": ["x.py"]})),
    ]))
    .await
    .unwrap_err();
    assert!(
        err.to_string().contains("does not exist"),
        "unexpected error: {err}"
    );
    assert!(
        !dir.join("partial-user.yaml").is_file(),
        "a refused update must not create the missing yaml"
    );
}

#[tokio::test]
async fn get_mcp_server_logs_covers_success_and_error_paths() {
    let env = TestEnv::new("logs");
    env.write_yaml(false, "demo", "name: Demo\n");
    let (base, requests) = serve_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({
                "success": true,
                "logs": "mcpo-demo  | line one\nmcpo-demo  | [2026-04-08T17:47:32Z] INFO line two",
                "log_source": "managed_container",
                "container_name": "mcpo-demo",
            }),
        },
        MockReply {
            status: "500 ERROR",
            body: json!({
                "success": false,
                "error": "raw host path /Users/example/open-webui-mcp/src/scripts/docker-compose.sh",
                "logs": "runtime image registry.example/internal/image:tag",
            }),
        },
    ]);
    env.set_electron_base(&base);

    let success = response_payload(
        handle_get_mcp_server_logs(&args(&[
            ("server_id", json!("demo")),
            ("lines", json!(5000)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(success["success"], json!(true));
    assert_eq!(success["lines"], json!(1000));
    assert_eq!(success["log_source"], json!("managed_container"));
    assert_eq!(success["container_name"], json!("mcpo-demo"));
    assert_eq!(
        success["logs"],
        json!("mcpo-demo  | line one\nmcpo-demo  | [2026-04-08T17:47:32Z] INFO line two")
    );

    let first_request = recv_request(&requests);
    assert_eq!(first_request.method, "GET");
    assert_eq!(first_request.path, "/api/mcp-server-logs/demo?lines=1000");

    let failure = response_payload(
        handle_get_mcp_server_logs(&args(&[("server_id", json!("demo"))]))
            .await
            .unwrap(),
    );
    assert_eq!(failure["success"], json!(false));
    assert_eq!(failure["lines"], json!(200));
    assert_eq!(failure["code"], json!("log_fetch_failed"));
    assert_eq!(failure["logs"], json!(""));
    assert_eq!(failure["error"], json!("Unable to fetch MCP server logs."));

    let second_request = recv_request(&requests);
    assert_eq!(second_request.method, "GET");
    assert_eq!(second_request.path, "/api/mcp-server-logs/demo?lines=200");

    env.set_electron_base("http://127.0.0.1:9");
    let transport_failure = response_payload(
        handle_get_mcp_server_logs(&args(&[("server_id", json!("demo"))]))
            .await
            .unwrap(),
    );
    assert_eq!(transport_failure["success"], json!(false));
    assert_eq!(transport_failure["code"], json!("log_fetch_failed"));
    assert!(matches!(
        transport_failure["error"].as_str().unwrap(),
        "Cannot connect to the local app service." | "Unable to fetch MCP server logs."
    ));
    assert_eq!(transport_failure["logs"], json!(""));
}

#[tokio::test]
async fn get_mcp_server_logs_rejects_unknown_server_without_host_probe() {
    let env = TestEnv::new("logs-unknown");
    env.set_electron_base("http://127.0.0.1:9");

    let failure = response_payload(
        handle_get_mcp_server_logs(&args(&[("server_id", json!("missing-demo"))]))
            .await
            .unwrap(),
    );

    assert_eq!(failure["success"], json!(false));
    assert_eq!(failure["code"], json!("server_not_found"));
    assert_eq!(failure["server_id"], json!("missing-demo"));
    assert_eq!(failure["logs"], json!(""));
    assert_eq!(failure["error"], json!("MCP server not found."));
}

#[tokio::test]
async fn host_mcp_bridge_tools_forward_status_and_configuration() {
    let env = TestEnv::new("host-bridge");
    let (base, requests) = serve_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({
                "success": true,
                "bridgeReady": true,
                "configuredClients": ["workbench"],
                "detectedClients": ["workbench", "atlas-code"],
                "scriptAction": "ready",
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "success": true,
                "bridgeReady": true,
                "selectedClientIds": ["workbench", "atlas-code"],
                "results": [
                    {"clientId": "workbench", "success": true},
                    {"clientId": "atlas-code", "success": true}
                ],
            }),
        },
    ]);
    env.set_electron_base(&base);

    let status = response_payload(
        handle_get_host_mcp_bridge_status(&Map::new())
            .await
            .unwrap(),
    );
    assert_eq!(status["success"], json!(true));
    assert_eq!(status["bridgeReady"], json!(true));
    assert_eq!(status["configuredClients"], json!(["workbench"]));
    assert_eq!(status["caller"], json!("portico_chat"));
    let status_request = recv_request(&requests);
    assert_eq!(status_request.method, "GET");
    assert_eq!(
        status_request.path,
        "/api/mcp/bridge/clients?caller=portico_chat"
    );

    let confirmation_error =
        handle_configure_host_mcp_bridge_clients(&args(&[("client_ids", json!(["workbench"]))]))
            .await
            .unwrap_err();
    assert!(confirmation_error
        .to_string()
        .contains("Confirmation required"));

    let missing_clients_error =
        handle_configure_host_mcp_bridge_clients(&args(&[("confirm", json!(true))]))
            .await
            .unwrap_err();
    assert!(missing_clients_error
        .to_string()
        .contains("client_ids is required"));

    let configure = response_payload(
        handle_configure_host_mcp_bridge_clients(&args(&[
            ("confirm", json!(true)),
            ("client_ids", json!(["workbench", "atlas-code", "workbench"])),
            ("timeout_ms", json!(45_000)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(configure["success"], json!(true));
    assert_eq!(configure["bridgeReady"], json!(true));
    assert_eq!(configure["caller"], json!("portico_chat"));
    let configure_request = recv_request(&requests);
    assert_eq!(configure_request.method, "POST");
    assert_eq!(configure_request.path, "/api/mcp/bridge/enable");
    assert!(configure_request
        .headers
        .to_ascii_lowercase()
        .contains("x-portico-programmatic-bridge: 1"));
    assert!(configure_request
        .headers
        .to_ascii_lowercase()
        .contains("x-portico-bridge-caller: portico_chat"));
    let configure_body: Value =
        serde_json::from_str(&configure_request.body).expect("configure body JSON");
    assert_eq!(configure_body["caller"], json!("portico_chat"));
    assert_eq!(configure_body["timeout_ms"], json!(45_000));
    assert_eq!(
        configure_body["client_ids"],
        json!(["workbench", "atlas-code"])
    );

    let unsupported_error = handle_configure_host_mcp_bridge_clients(&args(&[
        ("confirm", json!(true)),
        ("client_ids", json!(["windsurf"])),
    ]))
    .await
    .unwrap_err();
    assert!(unsupported_error
        .to_string()
        .contains("Unsupported Host MCP Bridge client"));
}

#[tokio::test]
async fn create_read_update_delete_and_validate_user_server_cover_paths() {
    let env = TestEnv::new("crud");
    let icon_base64 = BASE64_STANDARD.encode(PNG_BYTES);
    let (base, requests) = serve_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({
                "success": true,
                "enabled": true,
                "healthy": true,
                "readiness_phase": "tool_ready"
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "healthy": false}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "healthy": false}),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "success": true,
                "server_id": "user-one",
                "files_deleted_count": 3,
                "toggle_removed": true,
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "success": true,
                "server_id": "missing-one",
                "files_deleted_count": 0,
                "toggle_removed": false,
            }),
        },
    ]);
    env.set_electron_base(&base);

    let large_yaml = Value::Object(Map::from_iter([
        ("name".to_string(), json!("X")),
        ("id".to_string(), json!("big")),
        ("display_name".to_string(), json!("X")),
        ("deployment_type".to_string(), json!("docker")),
        (
            "description".to_string(),
            json!("x".repeat(MAX_YAML_SIZE + 32)),
        ),
    ]));
    let yaml_error = handle_create_user_mcp_server(&args(&[
        ("server_id", json!("big")),
        ("yaml_config", large_yaml),
        ("fragment", Value::Object(stdio_fragment())),
    ]))
    .await
    .unwrap_err();
    assert!(yaml_error.to_string().contains("YAML file too large"));

    let fragment_error = handle_create_user_mcp_server(&args(&[
        ("server_id", json!("fraggy")),
        (
            "yaml_config",
            Value::Object(yaml_config("Fraggy", "fraggy", "docker")),
        ),
        (
            "fragment",
            json!({
                "command": "python3",
                "args": ["server.py"],
                "env": {"A": "x".repeat(MAX_FRAGMENT_SIZE + 32)}
            }),
        ),
    ]))
    .await
    .unwrap_err();
    assert!(fragment_error
        .to_string()
        .contains("Fragment file too large"));

    for (name, icon, expected) in [
        ("bad-base64", json!("%%%"), "invalid base64"),
        (
            "bad-png",
            json!(BASE64_STANDARD.encode(b"not-png")),
            "Icon must be a PNG image",
        ),
        (
            "big-icon",
            json!(BASE64_STANDARD.encode(vec![b'x'; MAX_ICON_SIZE + 1])),
            "Icon too large",
        ),
    ] {
        let error = handle_create_user_mcp_server(&args(&[
            ("server_id", json!(name)),
            (
                "yaml_config",
                Value::Object(yaml_config("Icon", name, "docker")),
            ),
            ("fragment", Value::Object(stdio_fragment())),
            ("icon_base64", icon),
        ]))
        .await
        .unwrap_err();
        assert!(error.to_string().contains(expected));
    }

    let created = response_payload(
        handle_create_user_mcp_server(&args(&[
            ("server_id", json!("user-one")),
            (
                "yaml_config",
                Value::Object(yaml_config("User One", "user-one", "docker")),
            ),
            ("fragment", json!({"command": "python3", "args": ["server.py"], "env": {"API_TOKEN": "secret"}})),
            ("icon_base64", json!(icon_base64.clone())),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(created["success"], json!(true));

    fs::write(
        env.root.join("mcp-configs-user/user-array/user-array.yaml"),
        "name: User Array\n",
    )
    .err();
    env.write_yaml(true, "user-array", "name: User Array\n");
    fs::write(
        env.root
            .join("mcp-configs-user/user-array/user-array.fragment"),
        "[]",
    )
    .unwrap();

    let read_user = response_payload(
        handle_read_user_mcp_server(&args(&[("server_id", json!("user-one"))]))
            .await
            .unwrap(),
    );
    assert_eq!(
        read_user["fragment"]["env"]["API_TOKEN"],
        json!("***REDACTED***")
    );
    let read_array = response_payload(
        handle_read_user_mcp_server(&args(&[("server_id", json!("user-array"))]))
            .await
            .unwrap(),
    );
    assert_eq!(read_array["fragment"], json!({}));

    let updated = response_payload(
        handle_update_user_mcp_server(&args(&[
            ("server_id", json!("user-one")),
            (
                "yaml_config",
                Value::Object(yaml_config("User One Updated", "user-one", "host")),
            ),
            (
                "fragment",
                json!({"command": "python3", "args": ["updated.py"]}),
            ),
            ("icon_base64", json!(icon_base64)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(updated["success"], json!(true));
    assert_eq!(
        read_json_compatible_yaml(&env.root.join("mcp-configs-user/user-one/user-one.yaml"))
            .unwrap()["deployment_type"],
        json!("host")
    );
    assert_eq!(
        read_json_file(&env.root.join("mcp-configs-user/user-one/user-one.fragment")).unwrap()
            ["args"][0],
        json!("updated.py")
    );

    let updated_without_icon = response_payload(
        handle_update_user_mcp_server(&args(&[
            ("server_id", json!("user-one")),
            (
                "fragment",
                json!({"command": "python3", "args": ["again.py"]}),
            ),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(updated_without_icon["success"], json!(true));

    for (icon, expected) in [
        (json!("%%%"), "invalid base64"),
        (
            json!(BASE64_STANDARD.encode(vec![b'x'; MAX_ICON_SIZE + 1])),
            "Icon too large",
        ),
        (
            json!(BASE64_STANDARD.encode(b"nope")),
            "Icon must be a PNG image",
        ),
    ] {
        let error = handle_update_user_mcp_server(&args(&[
            ("server_id", json!("user-one")),
            ("icon_base64", icon),
        ]))
        .await
        .unwrap_err();
        assert!(error.to_string().contains(expected));
    }

    let validate = response_payload(
        handle_validate_mcp_fragment(&args(&[(
            "fragment",
            json!({"command": "python3", "args": ["server.py"], "env": {"API_TOKEN": "secret"}}),
        )]))
        .await
        .unwrap(),
    );
    assert_eq!(validate["valid"], json!(true));
    assert_eq!(validate["warnings"].as_array().unwrap().len(), 1);

    assert!(
        handle_delete_user_mcp_server(&args(&[("server_id", json!("user-one"))]))
            .await
            .is_err()
    );
    let deleted = response_payload(
        handle_delete_user_mcp_server(&args(&[
            ("server_id", json!("user-one")),
            ("confirm", json!(true)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(deleted["files_deleted_count"], json!(3));
    assert_eq!(recv_request(&requests).path, "/api/toggle-mcp-server");
    assert_eq!(
        recv_request(&requests).path,
        "/api/restart-mcp-server/user-one"
    );
    assert_eq!(
        recv_request(&requests).path,
        "/api/restart-mcp-server/user-one"
    );
    let delete_request = recv_request(&requests);
    assert_eq!(delete_request.path, "/api/delete-mcp-server/user-one");
    let missing = response_payload(
        handle_delete_user_mcp_server(&args(&[
            ("server_id", json!("missing-one")),
            ("confirm", json!(true)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(missing["files_deleted_count"], json!(0));
    assert_eq!(
        recv_request(&requests).path,
        "/api/delete-mcp-server/missing-one"
    );
}

#[tokio::test]
async fn managed_node_lifecycle_commands_are_rejected_before_create_or_update_writes() {
    let env = TestEnv::new("managed-node-validation");

    for (suffix, fragment, expected_code) in [
        (
            "start",
            json!({"command": "npm", "args": ["start"]}),
            "UNSUPPORTED_NPM_SUBCOMMAND",
        ),
        (
            "install",
            json!({"command": "npm", "args": ["install"]}),
            "UNSUPPORTED_NPM_SUBCOMMAND",
        ),
        (
            "run",
            json!({"command": "npm", "args": ["run"]}),
            "UNSUPPORTED_NPM_SUBCOMMAND",
        ),
        (
            "registry",
            json!({"command": "npx", "args": ["--registry=https://registry.npmjs.org", "demo"]}),
            "MANAGED_NODE_FLAG_NOT_ALLOWED",
        ),
    ] {
        let validate_error = handle_validate_mcp_fragment(&args(&[("fragment", fragment.clone())]))
            .await
            .unwrap_err();
        assert!(validate_error.to_string().contains(expected_code));

        let server_id = format!("invalid-{suffix}");
        let create_error = handle_create_user_mcp_server(&args(&[
            ("server_id", json!(server_id.clone())),
            (
                "yaml_config",
                Value::Object(yaml_config("Invalid Node", &server_id, "docker")),
            ),
            ("fragment", fragment),
        ]))
        .await
        .unwrap_err();
        assert!(create_error.to_string().contains(expected_code));
        assert!(!env.root.join("mcp-configs-user").join(&server_id).exists());
    }

    let server_id = "existing-node";
    let yaml_path = env.write_yaml(
        true,
        server_id,
        "name: Existing Node\nid: existing-node\ndeployment_type: docker\nrequired_env_vars: []\n",
    );
    let fragment_path = env.write_fragment(
        true,
        server_id,
        &json!({"command": "npx", "args": ["valid-server@1.0.0"]}),
    );
    let original_yaml = fs::read(&yaml_path).unwrap();
    let original_fragment = fs::read(&fragment_path).unwrap();

    let update_error = handle_update_user_mcp_server(&args(&[
        ("server_id", json!(server_id)),
        (
            "fragment",
            json!({"command": "npm", "args": ["run", "serve"]}),
        ),
    ]))
    .await
    .unwrap_err();
    assert!(update_error
        .to_string()
        .contains("UNSUPPORTED_NPM_SUBCOMMAND"));
    assert_eq!(fs::read(yaml_path).unwrap(), original_yaml);
    assert_eq!(fs::read(fragment_path).unwrap(), original_fragment);
}

#[tokio::test]
async fn create_user_server_recovers_auto_enable_timeout_when_readiness_needs_oauth() {
    let env = TestEnv::new("create-timeout-oauth");
    let (base, requests) = serve_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({
                "success": false,
                "error": "Toggle request timed out for slack-official"
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "healthy": false,
                "readiness_phase": READINESS_PHASE_NEEDS_OAUTH,
                "authorization_url_available": true,
                "oauth_state": "active"
            }),
        },
    ]);
    env.set_electron_base(&base);

    let created = response_payload(
        handle_create_user_mcp_server(&args(&[
            ("server_id", json!("slack-official")),
            (
                "yaml_config",
                Value::Object(yaml_config("Slack Official", "slack-official", "docker")),
            ),
            (
                "fragment",
                json!({
                    "type": "streamable-http",
                    "url": "https://mcp.slack.com/mcp",
                    "oauth": {
                        "server_url": "https://mcp.slack.com",
                        "client_id": "2317524819.11152506261415"
                    }
                }),
            ),
        ]))
        .await
        .unwrap(),
    );

    assert_eq!(created["success"], json!(true));
    assert_eq!(created["auto_enabled"], json!(true));
    assert_eq!(created["enabled"], json!(true));
    assert_eq!(created["healthy"], json!(false));
    assert_eq!(
        created["readiness_phase"],
        json!(READINESS_PHASE_NEEDS_OAUTH)
    );
    assert_eq!(recv_request(&requests).path, "/api/toggle-mcp-server");
    assert_eq!(
        recv_request(&requests).path,
        "/api/server-readiness/slack-official"
    );
    assert!(requests.try_recv().is_err());
}

#[tokio::test]
async fn system_server_ids_remain_immutable_and_do_not_create_user_shadow_dirs() {
    let env = TestEnv::new("system-immutable");
    let (base, requests) = serve_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "healthy": false}),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "success": true,
                "server_id": "user-two",
                "files_deleted_count": 2,
                "toggle_removed": true,
            }),
        },
    ]);
    env.set_electron_base(&base);
    env.write_yaml(
        false,
        "core-one",
        r#"
name: Core One
id: core-one
display_name: Core One
deployment_type: docker
description: System server
"#,
    );
    env.write_fragment(
        false,
        "core-one",
        &json!({"command": "python3", "args": ["system.py"]}),
    );
    let system_yaml_path = env.root.join("mcp-configs/core-one/core-one.yaml");
    let system_fragment_path = env.root.join("mcp-configs/core-one/core-one.fragment");
    let system_yaml_before = fs::read_to_string(&system_yaml_path).unwrap();
    let system_fragment_before = fs::read_to_string(&system_fragment_path).unwrap();

    let create_error = handle_create_user_mcp_server(&args(&[
        ("server_id", json!("core-one")),
        (
            "yaml_config",
            Value::Object(yaml_config("Shadowed Core One", "core-one", "docker")),
        ),
        ("fragment", Value::Object(stdio_fragment())),
    ]))
    .await
    .unwrap_err();
    assert!(create_error
        .to_string()
        .contains("collides with existing system-delivered server"));

    let update_error = handle_update_user_mcp_server(&args(&[
        ("server_id", json!("core-one")),
        (
            "yaml_config",
            Value::Object(yaml_config("Updated Core One", "core-one", "host")),
        ),
        (
            "fragment",
            json!({"command": "python3", "args": ["updated.py"]}),
        ),
    ]))
    .await
    .unwrap_err();
    assert!(update_error.to_string().contains("immutable"));
    assert!(update_error.to_string().contains("cannot be modified"));

    let delete_error = handle_delete_user_mcp_server(&args(&[
        ("server_id", json!("core-one")),
        ("confirm", json!(true)),
    ]))
    .await
    .unwrap_err();
    assert!(delete_error.to_string().contains("immutable"));
    assert!(delete_error.to_string().contains("cannot be deleted"));

    assert_eq!(
        fs::read_to_string(&system_yaml_path).unwrap(),
        system_yaml_before
    );
    assert_eq!(
        fs::read_to_string(&system_fragment_path).unwrap(),
        system_fragment_before
    );
    assert!(!env.root.join("mcp-configs-user/core-one").exists());

    env.write_yaml(
        true,
        "user-two",
        r#"
name: User Two
id: user-two
display_name: User Two
deployment_type: docker
description: User server
"#,
    );
    env.write_fragment(
        true,
        "user-two",
        &json!({"command": "python3", "args": ["server.py"]}),
    );
    assert!(env.root.join("mcp-configs-user/user-two").exists());

    let updated = response_payload(
        handle_update_user_mcp_server(&args(&[
            ("server_id", json!("user-two")),
            (
                "yaml_config",
                Value::Object(yaml_config("User Two Updated", "user-two", "host")),
            ),
            (
                "fragment",
                json!({"command": "python3", "args": ["user-two-updated.py"]}),
            ),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(updated["success"], json!(true));
    assert_eq!(
        read_json_compatible_yaml(&env.root.join("mcp-configs-user/user-two/user-two.yaml"))
            .unwrap()["deployment_type"],
        json!("host")
    );
    assert_eq!(
        read_json_file(&env.root.join("mcp-configs-user/user-two/user-two.fragment")).unwrap()
            ["args"][0],
        json!("user-two-updated.py")
    );

    let deleted = response_payload(
        handle_delete_user_mcp_server(&args(&[
            ("server_id", json!("user-two")),
            ("confirm", json!(true)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(deleted["files_deleted_count"], json!(2));
    assert_eq!(
        recv_request(&requests).path,
        "/api/restart-mcp-server/user-two"
    );
    assert_eq!(
        recv_request(&requests).path,
        "/api/delete-mcp-server/user-two"
    );
}

#[tokio::test]
async fn delete_user_mcp_server_preserves_structured_and_plaintext_errors() {
    let env = TestEnv::new("delete-errors");
    let (base, requests) = serve_responses(vec![
        MockReply {
            status: "500 ERROR",
            body: json!({"success": false, "error": "delete rejected"}),
        },
        MockReply {
            status: "500 ERROR",
            body: json!("bad gateway html proxy body"),
        },
    ]);
    env.set_electron_base(&base);

    let structured = handle_delete_user_mcp_server(&args(&[
        ("server_id", json!("user-one")),
        ("confirm", json!(true)),
    ]))
    .await
    .unwrap_err();
    assert!(structured
        .to_string()
        .contains("Failed to delete MCP server user-one: delete rejected"));
    assert_eq!(
        recv_request(&requests).path,
        "/api/delete-mcp-server/user-one"
    );

    let plaintext = handle_delete_user_mcp_server(&args(&[
        ("server_id", json!("user-two")),
        ("confirm", json!(true)),
    ]))
    .await
    .unwrap_err();
    assert!(plaintext
        .to_string()
        .contains("Failed to delete MCP server user-two"));
    assert!(plaintext
        .to_string()
        .contains("bad gateway html proxy body"));
    assert_eq!(
        recv_request(&requests).path,
        "/api/delete-mcp-server/user-two"
    );
}

#[tokio::test]
async fn restart_and_toggle_handlers_cover_success_and_fallbacks() {
    let env = TestEnv::new("restart");
    let (base, _requests) = serve_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "mode": "docker", "healthy": false}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "healthCheckPassed": true, "logs": ["one", "two"]}),
        },
        MockReply {
            status: "500 ERROR",
            body: json!({"error": "boom"}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"success": false, "healthCheckPassed": false, "error": "restart failed"}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "message": "enabled", "healthy": true, "errorCode": "OK"}),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "success": true,
                "message": "enabled but starting",
                "healthy": false,
                "readiness_phase": "starting"
            }),
        },
        MockReply {
            status: "500 ERROR",
            body: json!({"error": "toggle failed"}),
        },
        MockReply {
            status: "500 ERROR",
            body: json!({
                "success": false,
                "error": "Server needs configuration",
                "errorCode": "NOT_CONFIGURED"
            }),
        },
    ]);
    env.set_electron_base(&base);

    let single = response_payload(
        handle_restart_mcp_infrastructure(&args(&[("server_id", json!("time"))]))
            .await
            .unwrap(),
    );
    assert_eq!(single["mode"], json!("single_server"));
    assert_eq!(single["healthy"], json!(false));
    assert!(single["message"]
        .as_str()
        .unwrap()
        .contains("still starting"));

    let full = response_payload(
        handle_restart_mcp_infrastructure(&Map::new())
            .await
            .unwrap(),
    );
    assert_eq!(full["mode"], json!("full_restart"));
    assert_eq!(full["logs"], json!("one\ntwo"));

    let delegated = response_payload(
        handle_restart_mcp_server(&args(&[("server_id", json!("browser"))]))
            .await
            .unwrap(),
    );
    assert_eq!(delegated["success"], json!(false));
    assert!(delegated.get("healthy").is_none());
    assert!(delegated.get("readiness_phase").is_none());
    assert!(delegated.get("restart_mode").is_none());

    let full_failed = response_payload(
        handle_restart_mcp_infrastructure(&Map::new())
            .await
            .unwrap(),
    );
    assert_eq!(full_failed["success"], json!(false));
    assert_eq!(
        full_failed["message"],
        json!("MCP infrastructure restart failed")
    );

    let toggled = response_payload(
        handle_toggle_integration(&args(&[
            ("server_id", json!("time")),
            ("enabled", json!(true)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(toggled["healthy"], json!(true));
    assert_eq!(toggled["enabled"], json!(true));
    assert!(toggled.get("error").is_none());
    assert!(toggled.get("errorCode").is_none());

    let toggled_starting = response_payload(
        handle_toggle_integration_with_wait(
            &args(&[
                ("server_id", json!("google_workspace")),
                ("enabled", json!(true)),
            ]),
            0.0,
            0.01,
        )
        .await
        .unwrap(),
    );
    assert_eq!(toggled_starting["success"], json!(true));
    assert_eq!(toggled_starting["healthy"], json!(false));
    assert_eq!(toggled_starting["readiness_phase"], json!("starting"));
    assert_eq!(toggled_starting["message"], json!("enabled but starting"));
    assert!(toggled_starting["next_steps"]
        .as_array()
        .unwrap()
        .iter()
        .any(|step| step.as_str().unwrap().contains("Still starting")));

    let toggled_fallback = response_payload(
        handle_toggle_integration(&args(&[
            ("server_id", json!("time")),
            ("enabled", json!(false)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(toggled_fallback["success"], json!(false));
    assert_eq!(toggled_fallback["error"], json!("toggle failed"));
    assert!(toggled_fallback.get("enabled").is_none());
    assert!(toggled_fallback.get("healthy").is_none());
    assert!(toggled_fallback.get("readiness_phase").is_none());
    assert!(toggled_fallback.get("next_steps").is_none());

    let toggled_not_configured = response_payload(
        handle_toggle_integration(&args(&[
            ("server_id", json!("slack")),
            ("enabled", json!(true)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(toggled_not_configured["success"], json!(false));
    assert_eq!(toggled_not_configured["errorCode"], json!("NOT_CONFIGURED"));
    assert!(toggled_not_configured.get("enabled").is_none());
    assert!(toggled_not_configured.get("healthy").is_none());
    assert!(toggled_not_configured.get("readiness_phase").is_none());
    assert!(toggled_not_configured["message"]
        .as_str()
        .unwrap()
        .contains("Not configured."));
    assert!(toggled_not_configured["next_steps"]
        .as_array()
        .unwrap()
        .iter()
        .any(|step| step.as_str().unwrap().contains("trigger_guided_setup")));

    env.set_electron_base("http://127.0.0.1:9");

    let single_connect_error = response_payload(
        handle_restart_mcp_infrastructure(&args(&[("server_id", json!("time"))]))
            .await
            .unwrap(),
    );
    assert_eq!(single_connect_error["success"], json!(false));
    assert_eq!(single_connect_error["mode"], json!("single_server"));
    assert!(single_connect_error["error"]
        .as_str()
        .unwrap()
        .contains("Could not connect to Electron app REST API"));
    assert_eq!(
        single_connect_error["message"],
        json!("The Electron app may not be running or the REST API is not available.")
    );
    assert!(single_connect_error.get("healthy").is_none());
    assert!(single_connect_error.get("readiness_phase").is_none());
    assert!(single_connect_error.get("restart_mode").is_none());

    let full_connect_error = response_payload(
        handle_restart_mcp_infrastructure(&Map::new())
            .await
            .unwrap(),
    );
    assert_eq!(full_connect_error["success"], json!(false));
    assert_eq!(full_connect_error["mode"], json!("full_restart"));
    assert!(full_connect_error["error"]
        .as_str()
        .unwrap()
        .contains("Could not connect to Electron app REST API"));
    assert_eq!(
        full_connect_error["message"],
        json!(
            "The Electron app may not be running or the REST API is not available. Ensure the Electron app is running."
        )
    );
    assert_eq!(full_connect_error["logs"], json!(""));
    assert!(handle_toggle_integration(&args(&[
        ("server_id", json!("time")),
        ("enabled", json!("yes")),
    ]))
    .await
    .is_err());
}

#[tokio::test]
async fn toggle_integration_waits_for_oauth_or_tool_ready_before_returning_starting() {
    let env = TestEnv::new("toggle-wait");
    let (base, requests) = serve_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({
                "success": true,
                "message": "enabled but starting",
                "healthy": false,
                "readiness_phase": READINESS_PHASE_STARTING
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "healthy": false,
                "readiness_phase": READINESS_PHASE_STARTING,
                "discovered": true
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "healthy": false,
                "readiness_phase": READINESS_PHASE_NEEDS_OAUTH,
                "discovered": true
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "success": true,
                "message": "enabled but starting",
                "healthy": false,
                "readiness_phase": READINESS_PHASE_STARTING
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "healthy": false,
                "readiness_phase": READINESS_PHASE_STARTING,
                "discovered": true
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "healthy": true,
                "readiness_phase": READINESS_PHASE_TOOL_READY,
                "tools_count": 1
            }),
        },
    ]);
    env.set_electron_base(&base);

    let oauth_ready = response_payload(
        handle_toggle_integration_with_wait(
            &args(&[
                ("server_id", json!("google_workspace")),
                ("enabled", json!(true)),
            ]),
            0.1,
            0.01,
        )
        .await
        .unwrap(),
    );
    assert_eq!(oauth_ready["success"], json!(true));
    assert_eq!(oauth_ready["healthy"], json!(false));
    assert_eq!(
        oauth_ready["readiness_phase"],
        json!(READINESS_PHASE_NEEDS_OAUTH)
    );
    assert!(oauth_ready["message"]
        .as_str()
        .unwrap()
        .contains("ready for OAuth authorization"));
    assert!(oauth_ready["next_steps"][0]
        .as_str()
        .unwrap()
        .contains("authorize"));

    let tool_ready = response_payload(
        handle_toggle_integration_with_wait(
            &args(&[("server_id", json!("calendar")), ("enabled", json!(true))]),
            0.1,
            0.01,
        )
        .await
        .unwrap(),
    );
    assert_eq!(tool_ready["success"], json!(true));
    assert_eq!(tool_ready["healthy"], json!(true));
    assert_eq!(
        tool_ready["readiness_phase"],
        json!(READINESS_PHASE_TOOL_READY)
    );
    assert!(tool_ready["message"]
        .as_str()
        .unwrap()
        .contains("tools are ready"));
    assert!(tool_ready["next_steps"][0]
        .as_str()
        .unwrap()
        .contains("activate"));

    assert_eq!(recv_request(&requests).path, "/api/toggle-mcp-server");
    assert_eq!(
        recv_request(&requests).path,
        "/api/server-readiness/google_workspace"
    );
    assert_eq!(
        recv_request(&requests).path,
        "/api/server-readiness/google_workspace"
    );
    assert_eq!(recv_request(&requests).path, "/api/toggle-mcp-server");
    assert_eq!(
        recv_request(&requests).path,
        "/api/server-readiness/calendar"
    );
    assert_eq!(
        recv_request(&requests).path,
        "/api/server-readiness/calendar"
    );
    assert!(requests.try_recv().is_err());
}

#[tokio::test]
async fn toggle_integration_forwards_chat_id_to_electron_when_provided() {
    let env = TestEnv::new("toggle-chat-id");
    let (base, requests) = serve_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({
                "success": true,
                "message": "enabled",
                "healthy": true,
                "readiness_phase": READINESS_PHASE_TOOL_READY
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "success": true,
                "message": "enabled",
                "healthy": true,
                "readiness_phase": READINESS_PHASE_TOOL_READY
            }),
        },
    ]);
    env.set_electron_base(&base);

    // chat_id present -> it is threaded into the toggle request body.
    response_payload(
        handle_toggle_integration(&args(&[
            ("server_id", json!("time")),
            ("enabled", json!(true)),
            ("chat_id", json!("chat-xyz")),
        ]))
        .await
        .unwrap(),
    );
    let with_chat_id = recv_request(&requests);
    assert_eq!(with_chat_id.path, "/api/toggle-mcp-server");
    assert!(with_chat_id.body.contains("\"chat_id\":\"chat-xyz\""));

    // chat_id absent (or blank) -> the field is omitted entirely.
    response_payload(
        handle_toggle_integration(&args(&[
            ("server_id", json!("time")),
            ("enabled", json!(true)),
            ("chat_id", json!("   ")),
        ]))
        .await
        .unwrap(),
    );
    let without_chat_id = recv_request(&requests);
    assert_eq!(without_chat_id.path, "/api/toggle-mcp-server");
    assert!(!without_chat_id.body.contains("chat_id"));

    assert!(requests.try_recv().is_err());
}

#[tokio::test]
async fn toggle_disable_waits_until_backend_reports_disabled() {
    let env = TestEnv::new("toggle-disable-wait");
    let (base, requests) = serve_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({
                "success": true,
                "message": "Disable operation started",
                "healthy": false,
                "readiness_phase": READINESS_PHASE_STARTING
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "healthy": false,
                "readiness_phase": READINESS_PHASE_STARTING
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "healthy": false,
                "readiness_phase": READINESS_PHASE_DISABLED
            }),
        },
    ]);
    env.set_electron_base(&base);

    let disabled = response_payload(
        handle_toggle_integration_with_wait(
            &args(&[("server_id", json!("slack")), ("enabled", json!(false))]),
            0.1,
            0.01,
        )
        .await
        .unwrap(),
    );
    assert_eq!(disabled["success"], json!(true));
    assert_eq!(disabled["enabled"], json!(false));
    assert_eq!(disabled["healthy"], json!(false));
    assert_eq!(disabled["readiness_phase"], json!(READINESS_PHASE_DISABLED));
    assert!(disabled["message"]
        .as_str()
        .unwrap()
        .contains("disabled successfully"));

    assert_eq!(recv_request(&requests).path, "/api/toggle-mcp-server");
    assert_eq!(recv_request(&requests).path, "/api/server-readiness/slack");
    assert_eq!(recv_request(&requests).path, "/api/server-readiness/slack");
    assert!(requests.try_recv().is_err());
}

#[tokio::test]
async fn toggle_disable_waits_through_rich_operation_phases() {
    let env = TestEnv::new("toggle-disable-rich-operation-phases");
    let (base, requests) = serve_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({
                "success": true,
                "message": "Disable operation started",
                "healthy": false,
                "readiness_phase": READINESS_PHASE_STARTING
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "healthy": false,
                "readiness_phase": "preflight"
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "healthy": false,
                "readiness_phase": "regenerating_config"
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "healthy": false,
                "readiness_phase": READINESS_PHASE_DISABLED
            }),
        },
    ]);
    env.set_electron_base(&base);

    let disabled = response_payload(
        handle_toggle_integration_with_wait(
            &args(&[("server_id", json!("slack")), ("enabled", json!(false))]),
            0.2,
            0.01,
        )
        .await
        .unwrap(),
    );

    assert_eq!(disabled["success"], json!(true));
    assert_eq!(disabled["enabled"], json!(false));
    assert_eq!(disabled["readiness_phase"], json!(READINESS_PHASE_DISABLED));
    assert_eq!(recv_request(&requests).path, "/api/toggle-mcp-server");
    assert_eq!(recv_request(&requests).path, "/api/server-readiness/slack");
    assert_eq!(recv_request(&requests).path, "/api/server-readiness/slack");
    assert_eq!(recv_request(&requests).path, "/api/server-readiness/slack");
    assert!(requests.try_recv().is_err());
}

#[tokio::test]
async fn toggle_disable_does_not_claim_success_before_disabled() {
    let env = TestEnv::new("toggle-disable-no-wait");
    let (base, requests) = serve_responses(vec![MockReply {
        status: "200 OK",
        body: json!({
            "success": true,
            "message": "Disable operation started",
            "healthy": false,
            "readiness_phase": READINESS_PHASE_STARTING
        }),
    }]);
    env.set_electron_base(&base);

    let pending = response_payload(
        handle_toggle_integration_with_wait(
            &args(&[("server_id", json!("slack")), ("enabled", json!(false))]),
            0.0,
            0.01,
        )
        .await
        .unwrap(),
    );
    assert_eq!(pending["success"], json!(false));
    assert!(pending["error"]
        .as_str()
        .unwrap()
        .contains("did not reach disabled state"));
    assert!(pending.get("enabled").is_none());
    assert_eq!(recv_request(&requests).path, "/api/toggle-mcp-server");
    assert!(requests.try_recv().is_err());
}

#[tokio::test]
async fn toggle_integration_returns_starting_only_after_wait_budget_expires() {
    let env = TestEnv::new("toggle-timeout");
    let (base, requests) = serve_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({
                "success": true,
                "message": "enabled but starting",
                "healthy": false,
                "readiness_phase": READINESS_PHASE_STARTING
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "healthy": false,
                "readiness_phase": READINESS_PHASE_STARTING
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "healthy": false,
                "readiness_phase": READINESS_PHASE_STARTING
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "healthy": false,
                "readiness_phase": READINESS_PHASE_STARTING
            }),
        },
    ]);
    env.set_electron_base(&base);

    let starting = response_payload(
        handle_toggle_integration_with_wait(
            &args(&[
                ("server_id", json!("google_workspace")),
                ("enabled", json!(true)),
            ]),
            0.02,
            0.01,
        )
        .await
        .unwrap(),
    );
    assert_eq!(starting["success"], json!(true));
    assert_eq!(starting["healthy"], json!(false));
    assert_eq!(starting["readiness_phase"], json!(READINESS_PHASE_STARTING));
    assert_eq!(starting["message"], json!("enabled but starting"));
    assert!(starting["next_steps"][0]
        .as_str()
        .unwrap()
        .contains("Still starting"));

    assert_eq!(recv_request(&requests).path, "/api/toggle-mcp-server");
    assert_eq!(
        recv_request(&requests).path,
        "/api/server-readiness/google_workspace"
    );
    assert_eq!(
        recv_request(&requests).path,
        "/api/server-readiness/google_workspace"
    );
    if let Ok(request) = requests.recv_timeout(Duration::from_millis(100)) {
        assert_eq!(request.path, "/api/server-readiness/google_workspace");
    }
    assert!(requests.try_recv().is_err());
}

#[tokio::test]
async fn toggle_transport_errors_recover_when_readiness_advances() {
    let env = TestEnv::new("toggle-transport-recovery");
    let (base, requests) = serve_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({
                "success": false,
                "error": "Server disconnected"
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "healthy": false,
                "readiness_phase": READINESS_PHASE_STARTING,
                "discovered": true
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "healthy": false,
                "readiness_phase": READINESS_PHASE_NEEDS_OAUTH,
                "discovered": true
            }),
        },
    ]);
    env.set_electron_base(&base);

    let recovered = response_payload(
        handle_toggle_integration_with_wait(
            &args(&[
                ("server_id", json!("google_workspace")),
                ("enabled", json!(true)),
            ]),
            0.1,
            0.01,
        )
        .await
        .unwrap(),
    );
    assert_eq!(recovered["success"], json!(true));
    assert_eq!(recovered["enabled"], json!(true));
    assert_eq!(recovered["healthy"], json!(false));
    assert_eq!(
        recovered["readiness_phase"],
        json!(READINESS_PHASE_NEEDS_OAUTH)
    );
    assert!(recovered["message"]
        .as_str()
        .unwrap()
        .contains("ready for OAuth authorization"));
    assert!(recovered["next_steps"][0]
        .as_str()
        .unwrap()
        .contains("authorize"));
    assert!(recovered.get("error").is_none());
    assert!(recovered.get("toggle_likely_succeeded").is_none());

    assert_eq!(recv_request(&requests).path, "/api/toggle-mcp-server");
    assert_eq!(
        recv_request(&requests).path,
        "/api/server-readiness/google_workspace"
    );
    assert_eq!(
        recv_request(&requests).path,
        "/api/server-readiness/google_workspace"
    );
    assert!(requests.try_recv().is_err());
}

#[tokio::test]
async fn toggle_timeout_errors_recover_when_readiness_advances() {
    let env = TestEnv::new("toggle-timeout-recovery");
    let (base, requests) = serve_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({
                "success": false,
                "error": "Toggle request timed out for slack-official"
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "healthy": false,
                "readiness_phase": READINESS_PHASE_NEEDS_OAUTH,
                "authorization_url_available": true,
                "oauth_state": "active"
            }),
        },
    ]);
    env.set_electron_base(&base);

    let recovered = response_payload(
        handle_toggle_integration_with_wait(
            &args(&[
                ("server_id", json!("slack-official")),
                ("enabled", json!(true)),
            ]),
            0.1,
            0.01,
        )
        .await
        .unwrap(),
    );
    assert_eq!(recovered["success"], json!(true));
    assert_eq!(recovered["enabled"], json!(true));
    assert_eq!(recovered["healthy"], json!(false));
    assert_eq!(
        recovered["readiness_phase"],
        json!(READINESS_PHASE_NEEDS_OAUTH)
    );
    assert!(recovered["message"]
        .as_str()
        .unwrap()
        .contains("ready for OAuth authorization"));

    assert_eq!(recv_request(&requests).path, "/api/toggle-mcp-server");
    assert_eq!(
        recv_request(&requests).path,
        "/api/server-readiness/slack-official"
    );
    assert!(requests.try_recv().is_err());
}

#[tokio::test]
async fn toggle_flow_in_progress_errors_recover_when_readiness_advances() {
    let env = TestEnv::new("toggle-flow-in-progress-recovery");
    let (base, requests) = serve_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({
                "success": false,
                "error": "A setup flow is already in progress for this server (google_workspace(toggle)). Wait for it to complete.",
                "errorCode": "FLOW_IN_PROGRESS"
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "healthy": false,
                "readiness_phase": READINESS_PHASE_STARTING,
                "discovered": true
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "healthy": true,
                "readiness_phase": READINESS_PHASE_TOOL_READY,
                "discovered": true
            }),
        },
    ]);
    env.set_electron_base(&base);

    let recovered = response_payload(
        handle_toggle_integration_with_wait(
            &args(&[
                ("server_id", json!("google_workspace")),
                ("enabled", json!(true)),
            ]),
            0.1,
            0.01,
        )
        .await
        .unwrap(),
    );
    assert_eq!(recovered["success"], json!(true));
    assert_eq!(recovered["enabled"], json!(true));
    assert_eq!(recovered["healthy"], json!(true));
    assert_eq!(
        recovered["readiness_phase"],
        json!(READINESS_PHASE_TOOL_READY)
    );
    assert!(recovered["message"]
        .as_str()
        .unwrap()
        .contains("tools are ready"));
    assert!(recovered.get("error").is_none());

    assert_eq!(recv_request(&requests).path, "/api/toggle-mcp-server");
    assert_eq!(
        recv_request(&requests).path,
        "/api/server-readiness/google_workspace"
    );
    assert_eq!(
        recv_request(&requests).path,
        "/api/server-readiness/google_workspace"
    );
    assert!(requests.try_recv().is_err());
}

#[tokio::test]
async fn toggle_reqwest_transport_errors_recover_when_readiness_advances() {
    let env = TestEnv::new("toggle-reqwest-transport-recovery");
    let (base, requests) = serve_disconnect_then_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({
                "healthy": false,
                "readiness_phase": READINESS_PHASE_STARTING,
                "discovered": true
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "healthy": false,
                "readiness_phase": READINESS_PHASE_NEEDS_OAUTH,
                "discovered": true
            }),
        },
    ]);
    env.set_electron_base(&base);

    let recovered = response_payload(
        handle_toggle_integration_with_wait(
            &args(&[
                ("server_id", json!("google_workspace")),
                ("enabled", json!(true)),
            ]),
            0.2,
            0.01,
        )
        .await
        .unwrap(),
    );
    assert_eq!(recovered["success"], json!(true));
    assert_eq!(recovered["enabled"], json!(true));
    assert_eq!(
        recovered["readiness_phase"],
        json!(READINESS_PHASE_NEEDS_OAUTH)
    );
    assert!(recovered["message"]
        .as_str()
        .unwrap()
        .contains("ready for OAuth authorization"));

    assert_eq!(recv_request(&requests).path, "/api/toggle-mcp-server");
    assert_eq!(
        recv_request(&requests).path,
        "/api/server-readiness/google_workspace"
    );
    assert_eq!(
        recv_request(&requests).path,
        "/api/server-readiness/google_workspace"
    );
}

#[tokio::test]
async fn authorize_post_auth_wait_stops_after_budget_is_exhausted() {
    assert_eq!(remaining_post_auth_wait_seconds(31.0), 0.0);

    let env = TestEnv::new("authorize-post-auth-budget");
    let (base, requests) = serve_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({
                "healthy": false,
                "readiness_phase": READINESS_PHASE_CHECKING_TOKENS,
                "discovered": true
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "healthy": true,
                "readiness_phase": READINESS_PHASE_TOOL_READY,
                "tools_count": 1
            }),
        },
    ]);
    env.set_electron_base(&base);

    let waited = wait_for_post_auth_readiness_with_poll(
        "google_workspace",
        &json!({
            "healthy": false,
            "readiness_phase": READINESS_PHASE_CHECKING_TOKENS,
            "waited_seconds": 31.0,
            "discovered": true
        }),
        0.01,
    )
    .await;
    assert_eq!(waited["server_id"], json!("google_workspace"));
    assert_eq!(waited["healthy"], json!(false));
    assert_eq!(
        waited["readiness_phase"],
        json!(READINESS_PHASE_CHECKING_TOKENS)
    );
    assert_eq!(waited["waited_seconds"], json!(31.0));
    assert!(requests.try_recv().is_err());
}

#[tokio::test]
async fn activate_and_get_chat_tools_cover_validation_blocking_and_success() {
    let env = TestEnv::new("activate");
    save_mcp_toggles(&HashMap::from([
        ("time".to_string(), true),
        ("calendar".to_string(), false),
        ("notes".to_string(), true),
    ]))
    .unwrap();

    let (base, requests) = serve_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({"healthy": false, "readiness_phase": "failed", "discovered": true}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"healthy": true, "readiness_phase": "tool_ready", "discovered": true}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"healthy": true, "readiness_phase": "tool_ready", "discovered": true}),
        },
    ]);
    env.set_electron_base(&base);

    assert!(handle_activate_integration(&args(&[
        ("chat_id", json!("chat-1")),
        ("tool_server_ids", json!([])),
    ]))
    .await
    .is_err());
    assert!(handle_activate_integration(&args(&[
        ("chat_id", json!("chat-1")),
        ("tool_server_ids", json!(["bad-id"])),
    ]))
    .await
    .is_err());

    redis_setex_string(
        "chat_tools:chat-1",
        &serde_json::to_string(&vec!["server:already"]).unwrap(),
        60,
    )
    .unwrap();
    let blocked = response_payload(
        handle_activate_integration(&args(&[
            ("chat_id", json!("chat-1")),
            (
                "tool_server_ids",
                json!([
                    "server:already",
                    "server:calendar",
                    "server:time",
                    "server:untoggled"
                ]),
            ),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(blocked["success"], json!(false));
    assert_eq!(blocked["already_enabled"], json!(["server:already"]));
    assert_eq!(blocked["blocked_integrations"].as_array().unwrap().len(), 2);
    assert_eq!(recv_request(&requests).path, "/api/server-readiness/time");
    assert_eq!(
        recv_request(&requests).path,
        "/api/server-readiness/untoggled"
    );

    let success = response_payload(
        handle_activate_integration(&args(&[
            ("chat_id", json!("chat-2")),
            ("tool_server_ids", json!(["server:notes"])),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(success["success"], json!(true));
    assert_eq!(success["newly_added"], json!(["server:notes"]));
    assert_eq!(success["ready_tool_server_ids"], json!(["server:notes"]));
    assert!(success["message"]
        .as_str()
        .unwrap()
        .contains("Use the loaded tools directly"));
    assert_eq!(recv_request(&requests).path, "/api/server-readiness/notes");

    let core_only = response_payload(
        handle_activate_integration(&args(&[
            ("chat_id", json!("chat-core")),
            (
                "tool_server_ids",
                json!([
                    "server:mcp-assistant",
                    "server:mcp-assistant",
                    "server:subagents"
                ]),
            ),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(core_only["success"], json!(true));
    assert_eq!(core_only["newly_added"], json!([]));
    assert_eq!(
        core_only["already_enabled"],
        json!(["server:mcp-assistant", "server:subagents"])
    );
    assert_eq!(
        core_only["ready_tool_server_ids"],
        json!(["server:mcp-assistant", "server:subagents"])
    );
    assert!(core_only["message"]
        .as_str()
        .unwrap()
        .contains("already active for this chat"));
    let stored_core_only = redis_get_string("chat_tools:chat-core").unwrap().unwrap();
    assert_eq!(
        serde_json::from_str::<Vec<String>>(&stored_core_only).unwrap(),
        Vec::<String>::new()
    );

    redis_setex_string(
        "subagent_chat:chat-subagent",
        &json!({
            "parent_tool_call_id": "tooluse_123",
            "allowed_tool_server_ids": [
                "server:mcp-assistant",
                "server:subagents",
                "server:skills",
                "server:glean",
                "server:agent-vm"
            ],
            "explicit_skill_ids": ["company-knowledge", "code-execution"]
        })
        .to_string(),
        60,
    )
    .unwrap();
    let delegated = response_payload(
        handle_activate_integration(&args(&[
            ("chat_id", json!("chat-subagent")),
            ("tool_server_ids", json!(["server:google_workspace"])),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(delegated["success"], json!(false));
    assert_eq!(
        delegated["blocked_integrations"][0]["readiness_phase"],
        json!("subagent_scope_locked")
    );
    assert_eq!(
        delegated["blocked_integrations"][0]["tool_server_id"],
        json!("server:google_workspace")
    );
    assert!(requests.try_recv().is_err());

    redis_set_string("chat_tools:chat-3", "not-json").unwrap();
    let invalid = response_payload(
        handle_get_chat_tools(&args(&[("chat_id", json!("chat-3"))]))
            .await
            .unwrap(),
    );
    assert_eq!(invalid["chat_specific_tools"], json!([]));
    redis_setex_string(
        "chat_tools:chat-4",
        &serde_json::to_string(&vec![
            "server:mcp-assistant",
            "server:notes",
            "server:subagents",
            "server:notes",
        ])
        .unwrap(),
        30,
    )
    .unwrap();
    let with_ttl = response_payload(
        handle_get_chat_tools(&args(&[("chat_id", json!("chat-4"))]))
            .await
            .unwrap(),
    );
    assert!(with_ttl["ttl_seconds"].as_i64().unwrap() > 0);
    assert_eq!(with_ttl["chat_specific_tools"], json!(["server:notes"]));
    assert_eq!(
        with_ttl["all_enabled_tools"],
        json!(["server:mcp-assistant", "server:subagents", "server:notes"])
    );
    assert_eq!(with_ttl["total_enabled"], json!(3));
    assert!(with_ttl["message"]
        .as_str()
        .unwrap()
        .contains("Chat has 3 tool servers enabled"));
    assert!(with_ttl["message"]
        .as_str()
        .unwrap()
        .contains("use its loaded tools directly"));
}

#[tokio::test]
async fn authorize_and_guided_setup_cover_completion_and_failure_paths() {
    let env = TestEnv::new("authorize");
    let (base, requests) = serve_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "completed": true, "healthy": true, "already_authorized": true}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "completed": true, "healthy": false}),
        },
        MockReply {
            status: "500 ERROR",
            body: json!({"error": "oauth failed"}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "completed": true, "healthy": true, "dismissed": false}),
        },
        MockReply {
            status: "500 ERROR",
            body: json!({"error": "guided failed"}),
        },
    ]);
    env.set_electron_base(&base);

    let immediate = response_payload(
        handle_authorize_integration(&args(&[("server_id", json!("drive"))]))
            .await
            .unwrap(),
    );
    assert_eq!(immediate["success"], json!(true));
    assert_eq!(immediate["already_authorized"], json!(true));

    let waited = response_payload(
        handle_authorize_integration(&args(&[("server_id", json!("docs"))]))
            .await
            .unwrap(),
    );
    assert_eq!(waited["success"], json!(true));
    assert_eq!(waited["readiness_phase"], json!(READINESS_PHASE_STARTING));
    assert_eq!(recv_request(&requests).path, "/api/trigger-oauth-flow");
    assert_eq!(recv_request(&requests).path, "/api/trigger-oauth-flow");
    assert!(requests.try_recv().is_err());

    let failed = response_payload(
        handle_authorize_integration(&args(&[("server_id", json!("bad"))]))
            .await
            .unwrap(),
    );
    assert_eq!(failed["success"], json!(false));

    let guided = response_payload(
        handle_trigger_guided_setup(&args(&[
            ("server_id", json!("drive")),
            ("reason", json!("oauth_required")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(guided["success"], json!(true));

    let guided_failed = response_payload(
        handle_trigger_guided_setup(&args(&[("server_id", json!("drive"))]))
            .await
            .unwrap(),
    );
    assert_eq!(guided_failed["success"], json!(false));
}

#[tokio::test]
async fn authorize_integration_polls_async_oauth_flow_until_completion() {
    let env = TestEnv::new("authorize-async-polling");
    let (base, requests) = serve_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({
                "started": true,
                "flow_id": "oauth-taxo-1",
                "server_id": "taxo-mcp",
                "readiness_phase": "waiting_callback"
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "flow_id": "oauth-taxo-1",
                "server_id": "taxo-mcp",
                "status": "in_progress",
                "readiness_phase": "waiting_callback"
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "flow_id": "oauth-taxo-1",
                "server_id": "taxo-mcp",
                "status": "completed",
                "result": {
                    "success": true,
                    "completed": true,
                    "healthy": true,
                    "readiness_phase": READINESS_PHASE_TOOL_READY,
                    "server_id": "taxo-mcp"
                }
            }),
        },
    ]);
    env.set_electron_base(&base);

    let authorized = response_payload(
        handle_authorize_integration(&args(&[("server_id", json!("taxo-mcp"))]))
            .await
            .unwrap(),
    );

    assert_eq!(authorized["success"], json!(true));
    assert_eq!(authorized["completed"], json!(true));
    assert_eq!(authorized["healthy"], json!(true));
    assert_eq!(
        authorized["readiness_phase"],
        json!(READINESS_PHASE_TOOL_READY)
    );

    assert_eq!(recv_request(&requests).path, "/api/trigger-oauth-flow");
    assert_eq!(
        recv_request(&requests).path,
        "/api/oauth-flow-status/oauth-taxo-1"
    );
    assert_eq!(
        recv_request(&requests).path,
        "/api/oauth-flow-status/oauth-taxo-1"
    );
    assert!(requests.try_recv().is_err());
}

#[tokio::test]
async fn authorize_integration_surfaces_user_dismissal() {
    let env = TestEnv::new("authorize-dismissed");
    let (base, requests) = serve_responses(vec![MockReply {
        status: "200 OK",
        body: json!({
            "success": false,
            "completed": false,
            "dismissed": true,
            "error": "User dismissed OAuth authorization",
            "message": "OAuth authorization was dismissed by the user."
        }),
    }]);
    env.set_electron_base(&base);

    let dismissed = response_payload(
        handle_authorize_integration(&args(&[("server_id", json!("glean"))]))
            .await
            .unwrap(),
    );

    assert_eq!(dismissed["success"], json!(false));
    assert_eq!(dismissed["completed"], json!(false));
    assert_eq!(dismissed["dismissed"], json!(true));
    assert_eq!(
        dismissed["error"],
        json!("User dismissed OAuth authorization")
    );
    assert_eq!(recv_request(&requests).path, "/api/trigger-oauth-flow");
    assert!(requests.try_recv().is_err());
}

#[tokio::test]
async fn authorize_integration_forwards_force_auth_to_electron_api() {
    let env = TestEnv::new("authorize-force-auth");
    let (base, requests) = serve_responses(vec![MockReply {
        status: "200 OK",
        body: json!({
            "success": false,
            "completed": false,
            "error": "forced auth requested"
        }),
    }]);
    env.set_electron_base(&base);

    let _ = handle_authorize_integration(&args(&[
        ("server_id", json!("data-plat-mcp")),
        ("force_auth", json!(true)),
        ("chat_id", json!("chat-auth-1")),
    ]))
    .await
    .unwrap();

    let request = recv_request(&requests);
    assert_eq!(request.path, "/api/trigger-oauth-flow");
    let payload: Value = serde_json::from_str(&request.body).unwrap();
    assert_eq!(payload["server_id"], json!("data-plat-mcp"));
    assert_eq!(payload["force_auth"], json!(true));
    assert_eq!(payload["chat_id"], json!("chat-auth-1"));
    assert!(requests.try_recv().is_err());
}

#[tokio::test]
async fn authorize_integration_canonicalizes_qualified_server_id_before_activation() {
    let env = TestEnv::new("authorize-canonical-server-id");
    let (base, requests) = serve_responses(vec![MockReply {
        status: "200 OK",
        body: json!({
            "success": true,
            "completed": true,
            "healthy": true,
            "readiness_phase": READINESS_PHASE_TOOL_READY
        }),
    }]);
    env.set_electron_base(&base);

    let authorized = response_payload(
        handle_authorize_integration(&args(&[
            ("server_id", json!("server:server:google_workspace")),
            ("chat_id", json!("chat-qualified-server-id")),
        ]))
        .await
        .unwrap(),
    );

    assert_eq!(authorized["server_id"], json!("google_workspace"));
    assert_eq!(authorized["auto_activated"], json!(true));
    let request = recv_request(&requests);
    assert_eq!(request.path, "/api/trigger-oauth-flow");
    let payload: Value = serde_json::from_str(&request.body).unwrap();
    assert_eq!(payload["server_id"], json!("google_workspace"));
    assert_eq!(
        serde_json::from_str::<Vec<String>>(
            &redis_get_string("chat_tools:chat-qualified-server-id")
                .unwrap()
                .unwrap()
        )
        .unwrap(),
        vec!["server:google_workspace".to_string()]
    );
    assert!(requests.try_recv().is_err());
}

#[tokio::test]
async fn trigger_guided_setup_forwards_chat_id_to_electron_api() {
    let env = TestEnv::new("guided-setup-chat-id");
    let (base, requests) = serve_responses(vec![MockReply {
        status: "200 OK",
        body: json!({
            "success": true,
            "completed": true,
            "healthy": true,
            "readiness_phase": READINESS_PHASE_TOOL_READY
        }),
    }]);
    env.set_electron_base(&base);

    let guided = response_payload(
        handle_trigger_guided_setup(&args(&[
            ("server_id", json!("gitlab-mcp")),
            ("chat_id", json!("chat-config-1")),
            ("reason", json!("credentials_invalid")),
        ]))
        .await
        .unwrap(),
    );

    assert_eq!(guided["success"], json!(true));
    let request = recv_request(&requests);
    assert_eq!(request.path, "/api/trigger-guided-setup");
    let payload: Value = serde_json::from_str(&request.body).unwrap();
    assert_eq!(payload["server_id"], json!("gitlab-mcp"));
    assert_eq!(payload["chat_id"], json!("chat-config-1"));
    assert_eq!(payload["reason"], json!("credentials_invalid"));
    assert!(requests.try_recv().is_err());
}

#[tokio::test]
async fn guided_setup_distinguishes_test_failure_and_chat_redirect_from_dismissal() {
    let env = TestEnv::new("guided-setup-outcomes");
    let (base, _requests) = serve_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({
                "success": false,
                "completed": false,
                "dismissed": false,
                "test_failed": true,
                "outcome": "test_failed",
                "errorCode": "SAVED_SECRET_UNAVAILABLE",
                "configurationIssue": "saved_secret_unavailable",
                "requiredAction": "replace_saved_secret",
                "message": "The saved Snowflake connection is unavailable."
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "success": false,
                "completed": false,
                "dismissed": false,
                "redirected_to_chat": true,
                "outcome": "redirected_to_chat"
            }),
        },
    ]);
    env.set_electron_base(&base);

    let failed = response_payload(
        handle_trigger_guided_setup(&args(&[("server_id", json!("snowflake"))]))
            .await
            .unwrap(),
    );
    assert_eq!(failed["outcome"], json!("test_failed"));
    assert_eq!(failed["test_failed"], json!(true));
    assert_eq!(failed["dismissed"], json!(false));
    assert_eq!(
        failed["configurationIssue"],
        json!("saved_secret_unavailable")
    );
    assert!(failed["note"]
        .as_str()
        .unwrap()
        .contains("not a user dismissal"));

    let redirected = response_payload(
        handle_trigger_guided_setup(&args(&[("server_id", json!("snowflake"))]))
            .await
            .unwrap(),
    );
    assert_eq!(redirected["outcome"], json!("redirected_to_chat"));
    assert_eq!(redirected["redirected_to_chat"], json!(true));
    assert_eq!(redirected["dismissed"], json!(false));
    assert!(redirected["message"].as_str().unwrap().contains("new chat"));
}

#[tokio::test]
async fn authorize_integration_defaults_force_auth_true_unless_overridden() {
    let env = TestEnv::new("authorize-force-auth-default");
    let (base, requests) = serve_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({
                "success": false,
                "completed": false,
                "error": "default force auth"
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "success": false,
                "completed": false,
                "error": "explicit force auth override"
            }),
        },
    ]);
    env.set_electron_base(&base);

    let _ = handle_authorize_integration(&args(&[("server_id", json!("google_workspace"))]))
        .await
        .unwrap();
    let _ = handle_authorize_integration(&args(&[
        ("server_id", json!("google_workspace")),
        ("force_auth", json!(false)),
    ]))
    .await
    .unwrap();

    let first_request = recv_request(&requests);
    assert_eq!(first_request.path, "/api/trigger-oauth-flow");
    let first_payload: Value = serde_json::from_str(&first_request.body).unwrap();
    assert_eq!(first_payload["server_id"], json!("google_workspace"));
    assert_eq!(first_payload["force_auth"], json!(true));

    let second_request = recv_request(&requests);
    assert_eq!(second_request.path, "/api/trigger-oauth-flow");
    let second_payload: Value = serde_json::from_str(&second_request.body).unwrap();
    assert_eq!(second_payload["server_id"], json!("google_workspace"));
    assert_eq!(second_payload["force_auth"], json!(false));
    assert!(requests.try_recv().is_err());
}

#[tokio::test]
async fn authorize_transport_errors_recover_when_readiness_reaches_tool_ready() {
    let env = TestEnv::new("authorize-transport-recovery");
    let (base, requests) = serve_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({
                "success": false,
                "error": "400, message='Expected HTTP/'"
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "healthy": false,
                "readiness_phase": READINESS_PHASE_STARTING,
                "discovered": true
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "healthy": true,
                "readiness_phase": READINESS_PHASE_TOOL_READY,
                "discovered": true
            }),
        },
    ]);
    env.set_electron_base(&base);

    let recovered = response_payload(
        handle_authorize_integration(&args(&[
            ("server_id", json!("google_workspace")),
            ("chat_id", json!("chat-auth")),
        ]))
        .await
        .unwrap(),
    );

    assert_eq!(recovered["success"], json!(true));
    assert_eq!(recovered["completed"], json!(true));
    assert_eq!(recovered["healthy"], json!(true));
    assert_eq!(
        recovered["readiness_phase"],
        json!(READINESS_PHASE_TOOL_READY)
    );
    assert_eq!(recovered["auto_activated"], json!(true));
    assert_eq!(
        serde_json::from_str::<Vec<String>>(
            &redis_get_string("chat_tools:chat-auth").unwrap().unwrap()
        )
        .unwrap(),
        vec!["server:google_workspace".to_string()]
    );

    assert_eq!(recv_request(&requests).path, "/api/trigger-oauth-flow");
    assert_eq!(
        recv_request(&requests).path,
        "/api/server-readiness/google_workspace"
    );
    assert_eq!(
        recv_request(&requests).path,
        "/api/server-readiness/google_workspace"
    );
    assert!(requests.try_recv().is_err());
}

#[tokio::test]
async fn user_server_required_env_vars_persist_across_create_and_update() {
    let env = TestEnv::new("required-env");
    fs::write(env.root.join("assets/agent-icon.png"), PNG_BYTES).unwrap();

    let (base, _requests) = serve_responses(vec![
        // create → toggle enable
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "enabled": true, "healthy": true, "readiness_phase": "tool_ready"}),
        },
        // three updates → three restarts
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "healthy": true, "readiness_phase": "tool_ready"}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "healthy": true, "readiness_phase": "tool_ready"}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "healthy": true, "readiness_phase": "tool_ready"}),
        },
    ]);
    env.set_electron_base(&base);

    let declared = json!([
        {
            "name": "MARVIN_PASSWORD",
            "placeholder": "Paste the Marvin password",
            "description": "Marvin password",
            "sensitive": true
        },
        { "name": "FIGMA_API_KEY" },
        { "name": "githubToken", "sensitive": false },
        "BARE_VAR"
    ]);
    let mut create_config = yaml_config("Req Env", "req-env", "docker");
    create_config.insert("required_env_vars".to_string(), declared);
    let created = response_payload(
        handle_create_user_mcp_server(&args(&[
            ("server_id", json!("req-env")),
            ("yaml_config", Value::Object(create_config)),
            (
                "fragment",
                json!({"command": "python3", "args": ["server.py"]}),
            ),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(created["success"], json!(true));

    let yaml_path = env.root.join("mcp-configs-user/req-env/req-env.yaml");
    let written = read_json_compatible_yaml(&yaml_path).unwrap();
    assert_eq!(
        written["required_env_vars"],
        json!([
            {
                "name": "MARVIN_PASSWORD",
                "placeholder": "Paste the Marvin password",
                "description": "Marvin password",
                "sensitive": true
            },
            { "name": "FIGMA_API_KEY", "sensitive": true },
            { "name": "githubToken", "sensitive": false },
            { "name": "BARE_VAR" }
        ]),
        "create must preserve caller-supplied entries while normalizing bare and credential-shaped entries"
    );

    // Invalid names are rejected with an instructive error before any write.
    let mut invalid_config = yaml_config("Req Env", "req-env", "docker");
    invalid_config.insert("required_env_vars".to_string(), json!([{ "name": "1BAD" }]));
    let invalid = handle_update_user_mcp_server(&args(&[
        ("server_id", json!("req-env")),
        ("yaml_config", Value::Object(invalid_config)),
    ]))
    .await
    .unwrap_err();
    assert!(invalid.to_string().contains("[A-Za-z_][A-Za-z0-9_]*"));
    assert_eq!(
        read_json_compatible_yaml(&yaml_path).unwrap()["required_env_vars"],
        written["required_env_vars"],
        "failed validation must not touch the yaml"
    );

    // Update with a new list replaces the entries.
    let mut replace_config = yaml_config("Req Env", "req-env", "docker");
    replace_config.insert(
        "required_env_vars".to_string(),
        json!([{ "name": "OTHER_TOKEN" }]),
    );
    let replaced = response_payload(
        handle_update_user_mcp_server(&args(&[
            ("server_id", json!("req-env")),
            ("yaml_config", Value::Object(replace_config)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(replaced["success"], json!(true));
    assert_eq!(
        read_json_compatible_yaml(&yaml_path).unwrap()["required_env_vars"],
        json!([{ "name": "OTHER_TOKEN", "sensitive": true }])
    );

    // Update without yaml_config leaves the yaml (and entries) untouched.
    let untouched = response_payload(
        handle_update_user_mcp_server(&args(&[
            ("server_id", json!("req-env")),
            (
                "fragment",
                json!({"command": "python3", "args": ["again.py"]}),
            ),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(untouched["success"], json!(true));
    assert_eq!(
        read_json_compatible_yaml(&yaml_path).unwrap()["required_env_vars"],
        json!([{ "name": "OTHER_TOKEN", "sensitive": true }])
    );

    // Update whose yaml_config omits the key clears it (whole-file replace).
    let cleared = response_payload(
        handle_update_user_mcp_server(&args(&[
            ("server_id", json!("req-env")),
            (
                "yaml_config",
                Value::Object(yaml_config("Req Env", "req-env", "docker")),
            ),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(cleared["success"], json!(true));
    assert_eq!(
        read_json_compatible_yaml(&yaml_path).unwrap()["required_env_vars"],
        json!([])
    );
}

#[tokio::test]
async fn toggle_maps_unavailable_saved_snowflake_secret_to_secure_replacement() {
    let env = TestEnv::new("toggle-saved-secret-unavailable");
    let (base, requests) = serve_responses(vec![MockReply {
        status: "200 OK",
        body: json!({
            "success": false,
            "server_id": "snowflake",
            "errorCode": "SAVED_SECRET_UNAVAILABLE",
            "configurationIssue": "saved_secret_unavailable",
            "requiresConfiguration": true,
            "requiresSecretReplacement": true,
            "requiredAction": "replace_saved_secret",
            "severity": "warning",
            "error": "The saved Snowflake connection is unavailable.",
            "recoveryPrompt": "My Snowflake token is broken. Help me replace it with a fresh token.",
            "recoveryLabel": "Replace Snowflake connection in chat"
        }),
    }]);
    env.set_electron_base(&base);

    let payload = response_payload(
        handle_toggle_integration(&args(&[
            ("server_id", json!("snowflake")),
            ("enabled", json!(true)),
        ]))
        .await
        .unwrap(),
    );

    let request = recv_request(&requests);
    assert_eq!(request.path, "/api/toggle-mcp-server");
    assert!(requests.try_recv().is_err());
    assert_eq!(payload["success"], json!(false));
    assert_eq!(payload["errorCode"], json!("SAVED_SECRET_UNAVAILABLE"));
    assert_eq!(
        payload["configurationIssue"],
        json!("saved_secret_unavailable")
    );
    assert_eq!(payload["requiresSecretReplacement"], json!(true));
    assert_eq!(payload["requiredAction"], json!("replace_saved_secret"));
    assert_eq!(
        payload["recoveryPrompt"],
        json!("My Snowflake token is broken. Help me replace it with a fresh token.")
    );
    let next_steps = payload["next_steps"].as_array().unwrap();
    assert!(next_steps
        .iter()
        .any(|step| step.as_str().unwrap().contains("Secure PAT flow")));
    assert!(next_steps.iter().any(|step| step
        .as_str()
        .unwrap()
        .contains("Do not call mcp_assistant_trigger_guided_setup")));
}

#[tokio::test]
async fn update_user_server_maps_not_configured_restart_to_guidance() {
    let env = TestEnv::new("update-not-configured");
    fs::write(env.root.join("assets/agent-icon.png"), PNG_BYTES).unwrap();

    let (base, _requests) = serve_responses(vec![MockReply {
        status: "200 OK",
        body: json!({
            "success": true,
            "restarted": false,
            "requiresConfiguration": true,
            "uiStatus": "not_configured",
            "errorCode": "NOT_CONFIGURED",
            "error": "Missing required environment variables",
            "healthy": false,
            "readiness_phase": "not_configured",
            "message": "Server needs configuration"
        }),
    }]);
    env.set_electron_base(&base);

    let mut config = yaml_config("Needy", "needy", "docker");
    config.insert(
        "required_env_vars".to_string(),
        json!([{ "name": "MARVIN_PASSWORD", "sensitive": true }]),
    );
    let updated = response_payload(
        handle_update_user_mcp_server(&args(&[
            ("server_id", json!("needy")),
            ("yaml_config", Value::Object(config)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(updated["success"], json!(true));
    assert_eq!(updated["healthy"], json!(false));
    assert_eq!(updated["readiness_phase"], json!("not_configured"));
    assert_eq!(updated["errorCode"], json!("NOT_CONFIGURED"));
    assert_eq!(updated["requiresConfiguration"], json!(true));
    assert!(updated["message"]
        .as_str()
        .unwrap()
        .contains("needs configuration"));
    assert!(updated["next_steps"]
        .as_array()
        .unwrap()
        .iter()
        .any(|step| step.as_str().unwrap().contains("trigger_guided_setup")));
}

#[tokio::test]
async fn restart_tool_maps_not_configured_to_guided_setup_guidance() {
    let env = TestEnv::new("restart-not-configured");

    let (base, _requests) = serve_responses(vec![MockReply {
        status: "200 OK",
        body: json!({
            "success": true,
            "restarted": false,
            "requiresConfiguration": true,
            "uiStatus": "not_configured",
            "errorCode": "NOT_CONFIGURED",
            "error": "Missing required environment variables",
            "healthy": false,
            "readiness_phase": "not_configured",
            "message": "Server marvin needs configuration"
        }),
    }]);
    env.set_electron_base(&base);

    let payload = response_payload(
        handle_restart_mcp_infrastructure(&args(&[("server_id", json!("marvin"))]))
            .await
            .unwrap(),
    );
    assert_eq!(payload["success"], json!(true));
    assert_eq!(payload["errorCode"], json!("NOT_CONFIGURED"));
    assert_eq!(payload["readiness_phase"], json!("not_configured"));
    assert_eq!(payload["healthy"], json!(false));
    assert!(payload["summary"]
        .as_str()
        .unwrap()
        .contains("Not configured"));
    assert!(payload["next_steps"]
        .as_array()
        .unwrap()
        .iter()
        .any(|step| step.as_str().unwrap().contains("trigger_guided_setup")));
}

#[tokio::test]
async fn fragment_env_references_are_enforced_on_create_and_update() {
    let env = TestEnv::new("fragment-refs");
    fs::write(env.root.join("assets/agent-icon.png"), PNG_BYTES).unwrap();

    let (base, _requests) = serve_responses(vec![
        // successful create → toggle enable
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "enabled": true, "healthy": true, "readiness_phase": "tool_ready"}),
        },
        // fragment-swap update → restart
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "healthy": true, "readiness_phase": "tool_ready"}),
        },
    ]);
    env.set_electron_base(&base);

    // Create with an undeclared reference is rejected before any write.
    let mut leaky_config = yaml_config("Leaky", "leaky", "docker");
    leaky_config.insert("required_env_vars".to_string(), json!([]));
    let undeclared = handle_create_user_mcp_server(&args(&[
        ("server_id", json!("leaky")),
        ("yaml_config", Value::Object(leaky_config)),
        (
            "fragment",
            json!({"command": "python3", "args": ["server.py"], "env": {"TOKEN": "${UNDECLARED_TOKEN}"}}),
        ),
    ]))
    .await
    .unwrap_err();
    assert!(undeclared.to_string().contains("UNDECLARED_TOKEN"));
    assert!(
        !env.root.join("mcp-configs-user/leaky").exists(),
        "failed create must not leave files behind"
    );

    // Create with the declaration (padded name exercises trimming) succeeds.
    let mut good_config = yaml_config("Sealed", "sealed", "docker");
    good_config.insert(
        "required_env_vars".to_string(),
        json!([{ "name": " SEALED_TOKEN ", "sensitive": true }]),
    );
    let created = response_payload(
        handle_create_user_mcp_server(&args(&[
            ("server_id", json!("sealed")),
            ("yaml_config", Value::Object(good_config)),
            (
                "fragment",
                json!({"command": "python3", "args": ["server.py"], "env": {"TOKEN": "${SEALED_TOKEN}"}}),
            ),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(created["success"], json!(true));
    let yaml_path = env.root.join("mcp-configs-user/sealed/sealed.yaml");
    assert_eq!(
        read_json_compatible_yaml(&yaml_path).unwrap()["required_env_vars"],
        json!([{ "name": "SEALED_TOKEN", "sensitive": true }]),
        "padded names are trimmed at write time"
    );

    // Description-only update (omits required_env_vars) must be rejected
    // while the on-disk fragment still references the declared var.
    let clearing = handle_update_user_mcp_server(&args(&[
        ("server_id", json!("sealed")),
        (
            "yaml_config",
            Value::Object(yaml_config("Sealed", "sealed", "docker")),
        ),
    ]))
    .await
    .unwrap_err();
    assert!(clearing.to_string().contains("SEALED_TOKEN"));
    assert_eq!(
        read_json_compatible_yaml(&yaml_path).unwrap()["required_env_vars"],
        json!([{ "name": "SEALED_TOKEN", "sensitive": true }]),
        "rejected update must not touch the yaml"
    );

    // Fragment-only update introducing an undeclared reference is rejected
    // against the on-disk yaml.
    let fragment_only = handle_update_user_mcp_server(&args(&[
        ("server_id", json!("sealed")),
        (
            "fragment",
            json!({"command": "python3", "args": ["server.py"], "env": {"TOKEN": "${NOT_DECLARED}"}}),
        ),
    ]))
    .await
    .unwrap_err();
    assert!(fragment_only.to_string().contains("NOT_DECLARED"));

    // Swapping to a placeholder-free fragment succeeds and consumes the
    // restart mock.
    let swapped = response_payload(
        handle_update_user_mcp_server(&args(&[
            ("server_id", json!("sealed")),
            (
                "fragment",
                json!({"command": "python3", "args": ["server.py"]}),
            ),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(swapped["success"], json!(true));
}
