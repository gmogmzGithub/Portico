use super::*;
use crate::native::TEST_ENV_LOCK;
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
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
            "core-mcp-rust-mcp-assistant-parity-{name}-{}",
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

fn serve_delayed_ready_responses(
    expected_connections: usize,
    delay_ms: u64,
) -> (String, mpsc::Receiver<CapturedRequest>, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind listener");
    let base = format!("http://{}", listener.local_addr().expect("listener addr"));
    let (tx, rx) = mpsc::channel();
    let in_flight = Arc::new(AtomicUsize::new(0));
    let max_in_flight = Arc::new(AtomicUsize::new(0));
    let response_body = serde_json::to_vec(&json!({
        "healthy": true,
        "readiness_phase": READINESS_PHASE_TOOL_READY,
        "discovered": true
    }))
    .expect("encode reply");
    let max_in_flight_handle = Arc::clone(&max_in_flight);
    let in_flight_handle = Arc::clone(&in_flight);
    thread::spawn(move || {
        for _ in 0..expected_connections {
            let (mut stream, _) = listener.accept().expect("accept request");
            let tx = tx.clone();
            let in_flight = Arc::clone(&in_flight_handle);
            let max_in_flight = Arc::clone(&max_in_flight_handle);
            let body = response_body.clone();
            thread::spawn(move || {
                let request = read_http_request(&mut stream);
                let _ = tx.send(request);
                let active = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                let _ = max_in_flight.fetch_max(active, Ordering::SeqCst);
                thread::sleep(Duration::from_millis(delay_ms));
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                stream
                    .write_all(response.as_bytes())
                    .and_then(|_| stream.write_all(&body))
                    .expect("write response");
                in_flight.fetch_sub(1, Ordering::SeqCst);
            });
        }
    });
    (base, rx, max_in_flight)
}

fn serve_timed_responses(
    replies: Vec<(u64, MockReply)>,
) -> (String, mpsc::Receiver<CapturedRequest>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind listener");
    let base = format!("http://{}", listener.local_addr().expect("listener addr"));
    let (tx, rx) = mpsc::channel();
    let replies = Arc::new(Mutex::new(replies));
    thread::spawn(move || loop {
        let (delay_ms, reply) = {
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
        thread::sleep(Duration::from_millis(delay_ms));
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

#[tokio::test]
async fn restart_responses_include_rust_summary_and_next_steps() {
    let env = TestEnv::new("restart-guidance");
    let (base, _requests) = serve_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "mode": "docker", "healthy": true, "readiness_phase": READINESS_PHASE_TOOL_READY}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "healthCheckPassed": true, "logs": ["one", "two"]}),
        },
    ]);
    env.set_electron_base(&base);

    let single = response_payload(
        handle_restart_mcp_infrastructure(&args(&[("server_id", json!("time"))]))
            .await
            .unwrap(),
    );
    assert_eq!(
        single["summary"],
        json!(
            "Restart complete. tool_ready. Use the server tools directly if they are already attached to this chat."
        )
    );
    assert_eq!(
        single["next_steps"][0],
        json!(
            "Only call activate_integration if get_chat_tools shows this server is missing from the current chat."
        )
    );

    let full = response_payload(
        handle_restart_mcp_infrastructure(&Map::new())
            .await
            .unwrap(),
    );
    assert_eq!(
        full["summary"],
        json!("All services have been restarted and are healthy")
    );
    assert_eq!(full["logs"], json!("one\ntwo"));
}

#[tokio::test]
async fn toggle_and_guided_setup_responses_include_rust_next_steps() {
    let env = TestEnv::new("toggle-guidance");
    let (base, _requests) = serve_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "message": "enabled", "healthy": true, "readiness_phase": READINESS_PHASE_TOOL_READY}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "message": "oauth", "healthy": false, "readiness_phase": READINESS_PHASE_NEEDS_OAUTH}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"success": false, "error": "missing token", "errorCode": "NOT_CONFIGURED"}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "completed": true, "healthy": true, "readiness_phase": READINESS_PHASE_TOOL_READY}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "completed": true, "healthy": false, "readiness_phase": READINESS_PHASE_CHECKING_TOKENS}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"success": false, "completed": false, "dismissed": true}),
        },
    ]);
    env.set_electron_base(&base);

    let enabled = response_payload(
        handle_toggle_integration(&args(&[
            ("server_id", json!("drive")),
            ("enabled", json!(true)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(
        enabled["next_steps"][0],
        json!("tool_ready. Next: activate(chat_id, [server:ID]).")
    );

    let oauth = response_payload(
        handle_toggle_integration(&args(&[
            ("server_id", json!("docs")),
            ("enabled", json!(true)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(
        oauth["next_steps"][0],
        json!("OAuth needed. Next: authorize(server_id, chat_id).")
    );

    let needs_setup = response_payload(
        handle_toggle_integration(&args(&[
            ("server_id", json!("slack")),
            ("enabled", json!(true)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(
        needs_setup["next_steps"][0],
        json!("Call trigger_guided_setup(server_id=\"slack\").")
    );

    let guided_ready = response_payload(
        handle_trigger_guided_setup(&args(&[("server_id", json!("drive"))]))
            .await
            .unwrap(),
    );
    assert_eq!(
        guided_ready["next_steps"][0],
        json!("Next: activate(chat_id, [server:ID]).")
    );

    let guided_oauth = response_payload(
        handle_trigger_guided_setup(&args(&[("server_id", json!("docs"))]))
            .await
            .unwrap(),
    );
    assert_eq!(
        guided_oauth["next_steps"][0],
        json!("Next: authorize(server_id, chat_id).")
    );

    let guided_dismissed = response_payload(
        handle_trigger_guided_setup(&args(&[("server_id", json!("calendar"))]))
            .await
            .unwrap(),
    );
    assert_eq!(guided_dismissed["dismissed"], json!(true));
    assert!(guided_dismissed["note"]
        .as_str()
        .unwrap()
        .contains("Control Plane"));
}

#[tokio::test]
async fn authorize_responses_include_rust_next_steps_and_skip_non_waitable_repoll() {
    let env = TestEnv::new("authorize-guidance");
    let (base, requests) = serve_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({
                "success": true,
                "completed": true,
                "healthy": true,
                "already_authorized": true,
                "readiness_phase": READINESS_PHASE_TOOL_READY
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "success": true,
                "completed": true,
                "healthy": false,
                "already_authorized": false,
                "readiness_phase": READINESS_PHASE_WAITING_CALLBACK
            }),
        },
    ]);
    env.set_electron_base(&base);

    let immediate = response_payload(
        handle_authorize_integration(&args(&[("server_id", json!("drive"))]))
            .await
            .unwrap(),
    );
    assert_eq!(
        immediate["message"],
        json!("drive: tokens valid, tool_ready.")
    );
    assert_eq!(
        immediate["next_steps"][0],
        json!("Next: activate(chat_id, [server:ID]).")
    );

    let waiting_callback = response_payload(
        handle_authorize_integration(&args(&[("server_id", json!("docs"))]))
            .await
            .unwrap(),
    );
    assert_eq!(
        waiting_callback["readiness_phase"],
        json!(READINESS_PHASE_WAITING_CALLBACK)
    );
    assert_eq!(
        waiting_callback["next_steps"][0],
        json!("Tell user auth succeeded but server still starting.")
    );
    assert!(waiting_callback["message"]
        .as_str()
        .unwrap()
        .contains("phase: waiting_callback"));

    assert_eq!(recv_request(&requests).path, "/api/trigger-oauth-flow");
    assert_eq!(recv_request(&requests).path, "/api/trigger-oauth-flow");
    assert!(requests.try_recv().is_err());
}

#[tokio::test]
async fn activate_integration_probes_readiness_concurrently() {
    let env = TestEnv::new("activate-concurrency");
    save_mcp_toggles(&HashMap::from([
        ("time".to_string(), true),
        ("notes".to_string(), true),
    ]))
    .unwrap();
    let (base, requests, max_in_flight) = serve_delayed_ready_responses(2, 150);
    env.set_electron_base(&base);

    let payload = response_payload(
        handle_activate_integration(&args(&[
            ("chat_id", json!("chat-1")),
            ("tool_server_ids", json!(["server:time", "server:notes"])),
        ]))
        .await
        .unwrap(),
    );

    assert_eq!(payload["success"], json!(true));
    assert!(max_in_flight.load(Ordering::SeqCst) >= 2);

    let paths = vec![recv_request(&requests).path, recv_request(&requests).path];
    assert!(paths.contains(&"/api/server-readiness/time".to_string()));
    assert!(paths.contains(&"/api/server-readiness/notes".to_string()));
}

#[tokio::test]
async fn concurrent_activate_integration_calls_merge_chat_state() {
    let env = TestEnv::new("activate-race");
    save_mcp_toggles(&HashMap::from([
        ("time".to_string(), true),
        ("notes".to_string(), true),
    ]))
    .unwrap();
    let (base, requests) = serve_timed_responses(vec![
        (
            200,
            MockReply {
                status: "200 OK",
                body: json!({
                    "healthy": true,
                    "readiness_phase": READINESS_PHASE_TOOL_READY,
                    "discovered": true
                }),
            },
        ),
        (
            0,
            MockReply {
                status: "200 OK",
                body: json!({
                    "healthy": true,
                    "readiness_phase": READINESS_PHASE_TOOL_READY,
                    "discovered": true
                }),
            },
        ),
    ]);
    env.set_electron_base(&base);

    let slow_args = args(&[
        ("chat_id", json!("chat-race")),
        ("tool_server_ids", json!(["server:time"])),
    ]);
    let slow = tokio::spawn(async move {
        response_payload(handle_activate_integration(&slow_args).await.unwrap())
    });

    tokio::time::sleep(Duration::from_millis(25)).await;

    let fast_args = args(&[
        ("chat_id", json!("chat-race")),
        ("tool_server_ids", json!(["server:notes"])),
    ]);
    let fast = tokio::spawn(async move {
        response_payload(handle_activate_integration(&fast_args).await.unwrap())
    });

    let slow = slow.await.unwrap();
    let fast = fast.await.unwrap();

    assert_eq!(slow["success"], json!(true));
    assert_eq!(fast["success"], json!(true));
    assert_eq!(
        serde_json::from_str::<Vec<String>>(
            &redis_get_string("chat_tools:chat-race").unwrap().unwrap()
        )
        .unwrap(),
        vec!["server:time".to_string(), "server:notes".to_string()]
    );

    assert_eq!(recv_request(&requests).path, "/api/server-readiness/time");
    assert_eq!(recv_request(&requests).path, "/api/server-readiness/notes");
}
