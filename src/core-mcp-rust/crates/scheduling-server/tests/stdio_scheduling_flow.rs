use anyhow::Result;
use rmcp::model::{CallToolRequestParams, CallToolResult};
use rmcp::transport::TokioChildProcess;
use rmcp::ServiceExt;
use serde_json::{json, Map, Value};
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use uuid::Uuid;

struct TestRoot {
    path: PathBuf,
}

impl TestRoot {
    fn new(name: &str) -> Self {
        let path = env::temp_dir().join(format!(
            "scheduling-stdio-flow-{name}-{}",
            Uuid::new_v4().simple()
        ));
        for dir in [
            "mcp-configs",
            "mcp-configs-user",
            "skills",
            "skills-user",
            "skills-marketplace",
            "app-support",
        ] {
            fs::create_dir_all(path.join(dir)).expect("create test dir");
        }
        Self { path }
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn args(entries: &[(&str, Value)]) -> Map<String, Value> {
    entries
        .iter()
        .map(|(key, value)| ((*key).to_string(), value.clone()))
        .collect()
}

fn parse_tool_payload(result: CallToolResult) -> Value {
    let text = result
        .content
        .first()
        .and_then(|item| item.raw.as_text())
        .map(|text| text.text.as_ref())
        .expect("missing text tool result");
    serde_json::from_str(text).expect("tool result should contain JSON")
}

#[derive(Clone, Debug)]
struct RecordedRequest {
    method: String,
    path: String,
    body: String,
}

#[derive(Clone)]
struct MockResponse {
    status: u16,
    body: Value,
}

impl MockResponse {
    fn json(body: Value) -> Self {
        Self { status: 200, body }
    }
}

struct MockServer {
    base_url: String,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
    shutdown: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl MockServer {
    fn start(handler: impl Fn(&RecordedRequest) -> MockResponse + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("failed to bind mock server");
        let address = listener.local_addr().expect("failed to inspect address");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let shutdown = Arc::new(AtomicBool::new(false));
        let handler = Arc::new(handler);
        let requests_clone = Arc::clone(&requests);
        let shutdown_clone = Arc::clone(&shutdown);
        let thread = thread::spawn(move || loop {
            if shutdown_clone.load(Ordering::SeqCst) {
                break;
            }
            match listener.accept() {
                Ok((stream, _)) => {
                    let handler = Arc::clone(&handler);
                    let requests = Arc::clone(&requests_clone);
                    thread::spawn(move || {
                        if let Some((stream, request)) = read_request(stream) {
                            requests.lock().unwrap().push(request.clone());
                            let response = handler(&request);
                            write_response(stream, response);
                        }
                    });
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::Interrupted
                            | std::io::ErrorKind::ConnectionAborted
                            | std::io::ErrorKind::ConnectionReset
                    ) =>
                {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(_) => break,
            }
        });
        Self {
            base_url: format!("http://{}", address),
            requests,
            shutdown,
            thread: Some(thread),
        }
    }

    fn base_url(&self) -> &str {
        &self.base_url
    }

    fn requests(&self) -> Vec<RecordedRequest> {
        self.requests.lock().unwrap().clone()
    }
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        if let Ok(address) = self
            .base_url
            .trim_start_matches("http://")
            .parse::<SocketAddr>()
        {
            let _ = TcpStream::connect(address);
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn read_request(mut stream: TcpStream) -> Option<(TcpStream, RecordedRequest)> {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 1024];
    let header_end;
    loop {
        let read = stream.read(&mut chunk).ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(index) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            header_end = index + 4;
            break;
        }
    }

    let header = String::from_utf8(buffer[..header_end].to_vec()).ok()?;
    let request_line = header.split("\r\n").find(|line| !line.is_empty())?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();
    let content_length = header
        .split("\r\n")
        .find_map(|line| {
            let lower = line.to_ascii_lowercase();
            lower
                .strip_prefix("content-length:")
                .and_then(|value| value.trim().parse::<usize>().ok())
        })
        .unwrap_or(0);

    let mut body = buffer[header_end..].to_vec();
    while body.len() < content_length {
        let read = stream.read(&mut chunk).ok()?;
        if read == 0 {
            return None;
        }
        body.extend_from_slice(&chunk[..read]);
    }

    Some((
        stream,
        RecordedRequest {
            method,
            path,
            body: String::from_utf8(body).unwrap_or_default(),
        },
    ))
}

fn write_response(mut stream: TcpStream, response: MockResponse) {
    let body = serde_json::to_string(&response.body).expect("failed to encode JSON response");
    let status_text = match response.status {
        200 => "OK",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "OK",
    };
    let response = format!(
        "HTTP/1.1 {} {}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
        response.status,
        status_text,
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

#[tokio::test]
async fn binary_handles_scheduling_crud_and_manual_run_over_stdio() -> Result<()> {
    let root = TestRoot::new("workflow");
    fs::create_dir_all(root.path.join("mcp-configs/slack"))?;
    let server = MockServer::start(|request| {
        if request.method == "GET" && request.path.starts_with("/api/models") {
            return MockResponse::json(json!({
                "data": [{ "id": "GPT-5.4", "is_default": true, "name": "GPT-5.4" }]
            }));
        }

        match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/api/v1/auths/") => MockResponse::json(json!({ "id": "scheduled-user" })),
            ("GET", "/api/v1/folders/") => MockResponse::json(json!([
                {
                    "id": "legacy-scheduled-folder",
                    "name": "Scheduled Tasks",
                    "parent_id": null,
                    "created_at": 1.0
                }
            ])),
            ("POST", "/api/v1/folders/") => MockResponse::json(json!({ "id": "scheduled-folder" })),
            ("POST", "/api/v1/chats/new") => MockResponse::json(json!({ "id": "chat-scheduled" })),
            ("POST", "/api/chat/completions") => {
                MockResponse::json(json!({ "task_id": "task-scheduled" }))
            }
            ("POST", "/api/v1/chats/chat-scheduled") => {
                MockResponse::json(json!({ "success": true }))
            }
            ("GET", "/api/v1/chats/chat-scheduled") => MockResponse::json(json!({
                "chat": {
                    "models": ["GPT-5.4"],
                    "history": {
                        "messages": {
                            "assistant-1": {
                                "id": "assistant-1",
                                "role": "assistant",
                                "content": "Scheduled execution finished",
                                "finishReason": "stop",
                                "usage": { "prompt_tokens": 5 }
                            }
                        }
                    },
                    "messages": [
                        {
                            "role": "assistant",
                            "content": "Scheduled execution finished",
                            "finishReason": "stop",
                            "usage": { "prompt_tokens": 5 }
                        }
                    ]
                }
            })),
            _ => MockResponse {
                status: 404,
                body: json!({ "error": "not found" }),
            },
        }
    });

    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_scheduling-server"));
    command.current_dir(&root.path);
    command.env("CONTAINER_PROJECT_ROOT", &root.path);
    command.env("HOST_PROJECT_ROOT", &root.path);
    command.env(
        "PORTICO_APP_SUPPORT_DIR",
        root.path.join("app-support"),
    );
    command.env("OPENWEBUI_BASE_URL", server.base_url());
    command.env("OPENWEBUI_API_TOKEN", "token");
    command.env("CORE_MCP_TEST_REDIS", "memory");

    let transport = TokioChildProcess::new(command)?;
    let client = ().serve(transport).await?;

    let created = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("create_task").with_arguments(args(&[
                    ("name", json!("Email summary")),
                    ("prompt", json!("Email me a summary")),
                    ("model_id", json!("GPT-5.4")),
                    (
                        "schedule",
                        json!({
                            "kind": "once",
                            "run_at": "2030-01-01T12:00:00Z",
                            "timezone": "UTC"
                        }),
                    ),
                    ("skill_ids", json!(["slack", "slack"])),
                    ("tool_server_ids", json!(["server:slack"])),
                ])),
            )
            .await?,
    );
    let task_id = created["id"].as_str().expect("task id").to_string();
    assert_eq!(created["name"], json!("Email summary"));
    assert_eq!(created["next_run_at"], json!("2030-01-01T12:00:00Z"));
    assert_eq!(created["skill_ids"], json!(["slack"]));

    let listed = parse_tool_payload(
        client
            .call_tool(CallToolRequestParams::new("list_tasks"))
            .await?,
    );
    assert_eq!(listed["count"], json!(1));
    assert_eq!(listed["tasks"][0]["id"], json!(task_id.clone()));

    let fetched = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("get_task")
                    .with_arguments(args(&[("task_id", json!(task_id.clone()))])),
            )
            .await?,
    );
    assert_eq!(fetched["id"], json!(task_id.clone()));

    let updated = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("update_task").with_arguments(args(&[
                    ("task_id", json!(task_id.clone())),
                    ("name", json!("Slack summary")),
                    ("prompt", json!("Slack me the summary instead")),
                    ("skill_ids", json!(["slack"])),
                    ("tool_server_ids", json!(["server:slack"])),
                    ("enabled", json!(false)),
                ])),
            )
            .await?,
    );
    assert_eq!(updated["name"], json!("Slack summary"));
    assert_eq!(updated["enabled"], json!(false));
    assert_eq!(updated["next_run_at"], Value::Null);

    let ran = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("run_task_now")
                    .with_arguments(args(&[("task_id", json!(task_id.clone()))])),
            )
            .await?,
    );
    assert_eq!(ran["chat_id"], json!("chat-scheduled"));
    assert_eq!(ran["trigger"], json!("manual"));
    assert_eq!(ran["status"], json!("running"));

    let running = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("get_task")
                    .with_arguments(args(&[("task_id", json!(task_id.clone()))])),
            )
            .await?,
    );
    assert_eq!(running["current_run"]["chat_id"], json!("chat-scheduled"));
    assert_eq!(running["current_run"]["trigger"], json!("manual"));
    assert_eq!(running["last_run_status"], Value::Null);
    assert_eq!(running["next_run_at"], Value::Null);
    assert_eq!(running["runs"][0]["chat_id"], json!("chat-scheduled"));
    assert_eq!(running["runs"][0]["status"], Value::Null);

    let deleted = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("delete_task")
                    .with_arguments(args(&[("task_id", json!(task_id.clone()))])),
            )
            .await?,
    );
    assert_eq!(deleted["success"], json!(true));

    let listed_after_delete = parse_tool_payload(
        client
            .call_tool(CallToolRequestParams::new("list_tasks"))
            .await?,
    );
    assert_eq!(listed_after_delete["count"], json!(0));

    let requests = server.requests();
    let chat_create_body: Value = serde_json::from_str(
        &requests
            .iter()
            .find(|request| request.method == "POST" && request.path == "/api/v1/chats/new")
            .expect("expected chat create request")
            .body,
    )
    .unwrap();
    assert_eq!(chat_create_body["folder_id"], json!("scheduled-folder"));
    let folder_create_body: Value = serde_json::from_str(
        &requests
            .iter()
            .find(|request| request.method == "POST" && request.path == "/api/v1/folders/")
            .expect("expected folder create request")
            .body,
    )
    .unwrap();
    let folder_suffix = task_id
        .trim_start_matches("scheduled-task-")
        .chars()
        .take(8)
        .collect::<String>();
    assert_eq!(
        folder_create_body["name"],
        json!(format!("Slack summary · {folder_suffix}"))
    );

    Ok(())
}
