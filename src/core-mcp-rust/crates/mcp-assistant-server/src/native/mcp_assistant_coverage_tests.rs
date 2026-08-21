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

struct TestEnv {
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
    fn new(name: &str) -> Self {
        let guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let root = env::temp_dir().join(format!(
            "core-mcp-rust-mcp-assistant-coverage-{name}-{}",
            Uuid::new_v4().simple()
        ));
        fs::create_dir_all(root.join("mcp-configs")).expect("create mcp-configs");
        fs::create_dir_all(root.join("mcp-configs-user")).expect("create mcp-configs-user");
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

    fn set_electron_base(&self, base: &str) {
        env::set_var("ELECTRON_API_BASE", base);
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
struct MockReply {
    status: &'static str,
    body: Value,
}

#[derive(Debug)]
struct CapturedRequest {
    path: String,
}

fn args(entries: &[(&str, Value)]) -> Map<String, Value> {
    entries
        .iter()
        .map(|(key, value)| ((*key).to_string(), value.clone()))
        .collect()
}

fn response_payload(response: Value) -> Value {
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
    let _method = parts.next().unwrap_or_default();
    let path = parts.next().unwrap_or_default().to_string();
    CapturedRequest { path }
}

fn serve_responses(replies: Vec<MockReply>) -> (String, mpsc::Receiver<CapturedRequest>) {
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

#[cfg(unix)]
#[test]
fn rollback_user_server_create_surfaces_remove_errors() {
    let _env = TestEnv::new("rollback");
    let proc_path = PathBuf::from("/proc/self/stat");
    if !proc_path.exists() {
        return;
    }

    let error = rollback_user_server_create(&[proc_path.as_path()]).unwrap_err();
    assert!(!error.to_string().is_empty());
}

#[tokio::test]
async fn wait_for_post_auth_readiness_repolls_and_respects_wait_budget() {
    let env = TestEnv::new("post-auth");
    let (base, requests) = serve_responses(vec![MockReply {
        status: "200 OK",
        body: json!({
            "healthy": true,
            "readiness_phase": READINESS_PHASE_TOOL_READY,
            "waited_seconds": 1.5,
            "discovered": true
        }),
    }]);
    env.set_electron_base(&base);

    let repolled = wait_for_post_auth_readiness(
        "server:drive",
        &json!({
            "healthy": false,
            "readiness_phase": READINESS_PHASE_CHECKING_TOKENS,
            "waited_seconds": 1.0,
            "discovered": true
        }),
    )
    .await;
    assert_eq!(repolled["server_id"], json!("drive"));
    assert_eq!(repolled["healthy"], json!(true));
    assert_eq!(
        repolled["readiness_phase"],
        json!(READINESS_PHASE_TOOL_READY)
    );
    assert!(repolled["waited_seconds"].as_f64().unwrap_or_default() >= 1.0);
    assert_eq!(recv_request(&requests).path, "/api/server-readiness/drive");

    let exhausted = wait_for_post_auth_readiness(
        "drive",
        &json!({
            "healthy": false,
            "readiness_phase": READINESS_PHASE_CHECKING_TOKENS,
            "waited_seconds": AUTHORIZE_POST_AUTH_WAIT_SECONDS
        }),
    )
    .await;
    assert_eq!(exhausted["server_id"], json!("drive"));
    assert_eq!(
        exhausted["waited_seconds"],
        json!(AUTHORIZE_POST_AUTH_WAIT_SECONDS)
    );
    assert_eq!(
        exhausted["readiness_phase"],
        json!(READINESS_PHASE_CHECKING_TOKENS)
    );
}

#[tokio::test]
async fn toggle_disable_uses_default_message_and_activation_deduplicates_new_tools() {
    let env = TestEnv::new("toggle-disable");
    let chat_id = format!("chat-dedupe-{}", Uuid::new_v4().simple());
    let (base, requests) = serve_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({
                "success": true,
                "healthy": false,
                "readiness_phase": READINESS_PHASE_DISABLED
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({"healthy": true, "readiness_phase": READINESS_PHASE_TOOL_READY, "discovered": true}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"healthy": true, "readiness_phase": READINESS_PHASE_TOOL_READY, "discovered": true}),
        },
    ]);
    env.set_electron_base(&base);
    save_mcp_toggles(&HashMap::from([("notes".to_string(), true)])).expect("save toggles");

    let toggled = response_payload(
        handle_toggle_integration(&args(&[
            ("server_id", json!("notes")),
            ("enabled", json!(false)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(toggled["success"], json!(true));
    assert_eq!(toggled["healthy"], json!(false));
    assert_eq!(
        toggled["message"],
        json!("Server notes disabled successfully")
    );
    assert_eq!(recv_request(&requests).path, "/api/toggle-mcp-server");

    let activated = response_payload(
        handle_activate_integration(&args(&[
            ("chat_id", json!(chat_id.clone())),
            ("tool_server_ids", json!(["server:notes", "server:notes"])),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(activated["success"], json!(true));
    assert_eq!(activated["enabled_tools"], json!(["server:notes"]));
    assert_eq!(
        redis_get_string(&format!("chat_tools:{chat_id}"))
            .expect("redis read")
            .expect("redis value"),
        "[\"server:notes\"]"
    );
    assert_eq!(recv_request(&requests).path, "/api/server-readiness/notes");
    assert!(requests.try_recv().is_err());
}

#[tokio::test]
async fn guided_setup_failure_uses_default_message_when_backend_omits_one() {
    let env = TestEnv::new("guided-failure");
    let (base, _requests) = serve_responses(vec![MockReply {
        status: "200 OK",
        body: json!({"success": false, "completed": false, "dismissed": false}),
    }]);
    env.set_electron_base(&base);

    let payload = response_payload(
        handle_trigger_guided_setup(&args(&[("server_id", json!("drive"))]))
            .await
            .unwrap(),
    );
    assert_eq!(payload["success"], json!(false));
    assert_eq!(
        payload["message"],
        json!("Guided setup was not completed for drive")
    );
}
