use anyhow::{Context, Result};
use rmcp::model::{CallToolRequestParams, CallToolResult};
use rmcp::{transport::TokioChildProcess, ServiceExt};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use uuid::Uuid;

struct TempRoot {
    path: PathBuf,
}

impl TempRoot {
    fn new(name: &str) -> Result<Self> {
        let path = env::temp_dir().join(format!(
            "core-mcp-rust-subagents-stdio-{name}-{}",
            Uuid::new_v4().simple()
        ));
        fs::create_dir_all(path.join("mcp-configs/time"))?;
        fs::create_dir_all(path.join("mcp-configs-user"))?;
        fs::create_dir_all(path.join("skills"))?;
        fs::create_dir_all(path.join("skills-user"))?;
        fs::create_dir_all(path.join("skills-marketplace"))?;
        fs::write(
            path.join("mcp-configs/time/time.yaml"),
            "\
name: time
display_name: Time
deployment_type: docker
description: Time conversion tools
use_cases:
  - convert timezones
  - inspect offsets
",
        )?;
        Ok(Self { path })
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[derive(Clone, Debug)]
struct RecordedRequest {
    method: String,
    path: String,
    body: String,
}

#[derive(Default)]
struct OpenWebUiState {
    created_agent: Option<Value>,
    requests: Vec<RecordedRequest>,
}

struct MockOpenWebUi {
    base_url: String,
    state: Arc<Mutex<OpenWebUiState>>,
    shutdown: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl MockOpenWebUi {
    fn start() -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let address = listener.local_addr()?;
        let state = Arc::new(Mutex::new(OpenWebUiState::default()));
        let shutdown = Arc::new(AtomicBool::new(false));
        let state_clone = Arc::clone(&state);
        let shutdown_clone = Arc::clone(&shutdown);

        let thread = thread::spawn(move || loop {
            if shutdown_clone.load(Ordering::SeqCst) {
                break;
            }
            match listener.accept() {
                Ok((stream, _)) => {
                    let state = Arc::clone(&state_clone);
                    thread::spawn(move || {
                        if let Some((mut stream, request)) = read_http_request(stream) {
                            let response = handle_openwebui_request(&state, &request);
                            {
                                let mut lock =
                                    state.lock().unwrap_or_else(|poison| poison.into_inner());
                                lock.requests.push(request);
                            }
                            let body = serde_json::to_string(&response)
                                .expect("failed to encode mock response");
                            let response = format!(
                                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                                body.len(),
                                body
                            );
                            let _ = stream.write_all(response.as_bytes());
                            let _ = stream.flush();
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
                    thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(_) => break,
            }
        });

        Ok(Self {
            base_url: format!("http://{}", address),
            state,
            shutdown,
            thread: Some(thread),
        })
    }

    fn base_url(&self) -> &str {
        &self.base_url
    }

    fn requests(&self) -> Vec<RecordedRequest> {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .requests
            .clone()
    }
}

impl Drop for MockOpenWebUi {
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

fn is_permission_error(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .map(|io| {
                io.kind() == std::io::ErrorKind::PermissionDenied || io.raw_os_error() == Some(1)
            })
            .unwrap_or_else(|| cause.to_string().contains("Operation not permitted"))
    })
}

fn handle_openwebui_request(
    state: &Arc<Mutex<OpenWebUiState>>,
    request: &RecordedRequest,
) -> Value {
    let base_model = json!({
        "id": "gpt-5.4",
        "name": "GPT 5.4",
        "is_active": true,
        "meta": { "description": "Base model" }
    });
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/api/agent-attribution/current-user") => {
            json!({ "email": "integration-user@example.invalid" })
        }
        ("GET", path) if path.starts_with("/api/v1/tools/") => json!([
            { "id": "server:time", "name": "Time" },
            { "id": "server:skills", "name": "Skills" }
        ]),
        ("GET", path) if path.starts_with("/api/models") => {
            let agent = state
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .created_agent
                .clone();
            let mut data = vec![base_model];
            if let Some(agent) = agent {
                data.push(agent);
            }
            json!({ "data": data })
        }
        ("POST", "/api/v1/models/create") => {
            let mut created: Value =
                serde_json::from_str(&request.body).expect("invalid create_agent payload");
            if let Some(object) = created.as_object_mut() {
                object.insert("is_active".to_string(), Value::Bool(true));
            }
            state
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .created_agent = Some(created.clone());
            created
        }
        ("GET", path) if path.starts_with("/api/v1/models/model?id=") => {
            let id = path.trim_start_matches("/api/v1/models/model?id=");
            if id == "gpt-5.4" {
                base_model
            } else {
                state
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .created_agent
                    .clone()
                    .unwrap_or_else(|| json!({ "id": id }))
            }
        }
        ("GET", path)
            if path.starts_with("/api/models/") || path.starts_with("/api/v1/models/") =>
        {
            let id = path
                .rsplit('/')
                .next()
                .unwrap_or_default()
                .trim_end_matches(":latest");
            if id == "gpt-5.4" {
                base_model
            } else {
                state
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .created_agent
                    .clone()
                    .unwrap_or_else(|| json!({ "id": id }))
            }
        }
        _ => json!({}),
    }
}

fn read_http_request(mut stream: TcpStream) -> Option<(TcpStream, RecordedRequest)> {
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
            let (key, value) = line.split_once(':')?;
            (key.trim().eq_ignore_ascii_case("content-length"))
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
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

struct FakeRedis {
    address: SocketAddr,
    shutdown: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl FakeRedis {
    fn start(seed: &[(&str, &str)]) -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let address = listener.local_addr()?;
        let values = Arc::new(Mutex::new(
            seed.iter()
                .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
                .collect::<HashMap<_, _>>(),
        ));
        let shutdown = Arc::new(AtomicBool::new(false));
        let shutdown_clone = Arc::clone(&shutdown);
        let values_clone = Arc::clone(&values);

        let thread = thread::spawn(move || loop {
            if shutdown_clone.load(Ordering::SeqCst) {
                break;
            }
            match listener.accept() {
                Ok((stream, _)) => {
                    let values = Arc::clone(&values_clone);
                    thread::spawn(move || {
                        let _ = handle_redis_client(stream, values);
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
                    thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(_) => break,
            }
        });

        Ok(Self {
            address,
            shutdown,
            thread: Some(thread),
        })
    }

    fn host(&self) -> &str {
        "127.0.0.1"
    }

    fn port(&self) -> u16 {
        self.address.port()
    }
}

impl Drop for FakeRedis {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.address);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn handle_redis_client(
    mut stream: TcpStream,
    values: Arc<Mutex<HashMap<String, String>>>,
) -> Result<()> {
    while let Some(parts) = read_resp_array(&mut stream)? {
        if parts.is_empty() {
            write_resp_error(&mut stream, "empty command")?;
            continue;
        }
        match parts[0].to_ascii_uppercase().as_str() {
            "GET" => {
                let value = parts
                    .get(1)
                    .and_then(|key| values.lock().ok().and_then(|map| map.get(key).cloned()));
                write_resp_bulk_string(&mut stream, value.as_deref())?;
            }
            "SETEX" => {
                if let (Some(key), Some(value)) = (parts.get(1), parts.get(3)) {
                    values
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner())
                        .insert(key.clone(), value.clone());
                    write_resp_simple_string(&mut stream, "OK")?;
                } else {
                    write_resp_error(&mut stream, "wrong number of arguments")?;
                }
            }
            "DEL" => {
                let deleted = parts
                    .iter()
                    .skip(1)
                    .filter(|key| {
                        values
                            .lock()
                            .unwrap_or_else(|poison| poison.into_inner())
                            .remove(*key)
                            .is_some()
                    })
                    .count();
                write_resp_integer(&mut stream, deleted as i64)?;
            }
            _ => write_resp_error(&mut stream, "unsupported command")?,
        }
    }
    Ok(())
}

fn read_resp_array(stream: &mut TcpStream) -> Result<Option<Vec<String>>> {
    let mut prefix = [0_u8; 1];
    let read = stream.read(&mut prefix)?;
    if read == 0 {
        return Ok(None);
    }
    if prefix[0] != b'*' {
        anyhow::bail!("expected RESP array");
    }
    let len = read_resp_line(stream)?.parse::<usize>()?;
    let mut parts = Vec::with_capacity(len);
    for _ in 0..len {
        let mut bulk = [0_u8; 1];
        stream.read_exact(&mut bulk)?;
        if bulk[0] != b'$' {
            anyhow::bail!("expected RESP bulk string");
        }
        let bulk_len = read_resp_line(stream)?.parse::<usize>()?;
        let mut data = vec![0_u8; bulk_len];
        stream.read_exact(&mut data)?;
        let mut crlf = [0_u8; 2];
        stream.read_exact(&mut crlf)?;
        parts.push(String::from_utf8(data).context("invalid RESP UTF-8")?);
    }
    Ok(Some(parts))
}

fn read_resp_line(stream: &mut TcpStream) -> Result<String> {
    let mut bytes = Vec::new();
    let mut buf = [0_u8; 1];
    loop {
        stream.read_exact(&mut buf)?;
        if buf[0] == b'\r' {
            let mut lf = [0_u8; 1];
            stream.read_exact(&mut lf)?;
            if lf[0] == b'\n' {
                break;
            }
            bytes.push(buf[0]);
            bytes.push(lf[0]);
        } else {
            bytes.push(buf[0]);
        }
    }
    Ok(String::from_utf8(bytes).context("invalid RESP line UTF-8")?)
}

fn write_resp_simple_string(stream: &mut TcpStream, value: &str) -> Result<()> {
    stream.write_all(format!("+{value}\r\n").as_bytes())?;
    stream.flush()?;
    Ok(())
}

fn write_resp_bulk_string(stream: &mut TcpStream, value: Option<&str>) -> Result<()> {
    match value {
        Some(value) => {
            stream.write_all(format!("${}\r\n{}\r\n", value.len(), value).as_bytes())?;
        }
        None => {
            stream.write_all(b"$-1\r\n")?;
        }
    }
    stream.flush()?;
    Ok(())
}

fn write_resp_integer(stream: &mut TcpStream, value: i64) -> Result<()> {
    stream.write_all(format!(":{value}\r\n").as_bytes())?;
    stream.flush()?;
    Ok(())
}

fn write_resp_error(stream: &mut TcpStream, message: &str) -> Result<()> {
    stream.write_all(format!("-ERR {message}\r\n").as_bytes())?;
    stream.flush()?;
    Ok(())
}

fn args(entries: &[(&str, Value)]) -> Map<String, Value> {
    entries
        .iter()
        .map(|(key, value)| ((*key).to_string(), value.clone()))
        .collect()
}

fn tool_request(name: &'static str, arguments: Map<String, Value>) -> CallToolRequestParams {
    CallToolRequestParams::new(name).with_arguments(arguments)
}

fn payload(result: CallToolResult) -> Result<Value> {
    let text = result
        .content
        .first()
        .context("missing tool result content")?
        .raw
        .as_text()
        .context("expected text tool result")?
        .text
        .as_ref();
    serde_json::from_str(text).context("tool result should be JSON")
}

macro_rules! call_tool_json {
    ($client:expr, $name:expr, $args:expr) => {
        payload($client.call_tool(tool_request($name, $args)).await?)
    };
}

#[tokio::test]
async fn stdio_subagents_support_tool_discovery_and_agent_crud_reads() -> Result<()> {
    let root = TempRoot::new("subagents-flow").context("create temp root")?;
    let openwebui = match MockOpenWebUi::start() {
        Ok(server) => Some(server),
        Err(error) if is_permission_error(&error) => None,
        Err(error) => return Err(error.context("start mock Open WebUI")),
    };
    let redis = if openwebui.is_some() {
        match FakeRedis::start(&[("openwebui:api_token", "integration-token")]) {
            Ok(redis) => Some(redis),
            Err(error) if is_permission_error(&error) => None,
            Err(error) => return Err(error.context("start fake redis")),
        }
    } else {
        None
    };

    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_subagents-server"));
    command.current_dir(&root.path);
    command.env("CONTAINER_PROJECT_ROOT", &root.path);
    command.env("HOST_PROJECT_ROOT", &root.path);
    if let (Some(openwebui), Some(redis)) = (openwebui.as_ref(), redis.as_ref()) {
        command.env("OPENWEBUI_BASE_URL", openwebui.base_url());
        command.env("ELECTRON_API_BASE", openwebui.base_url());
        command.env("REDIS_HOST", redis.host());
        command.env("REDIS_PORT", redis.port().to_string());
    } else {
        command.env("CORE_MCP_TEST_REDIS", "memory");
    }

    let transport = TokioChildProcess::new(command).context("spawn subagents child")?;
    let client = ().serve(transport).await.context("connect RMCP client")?;

    assert!(!client
        .list_all_tools()
        .await
        .context("list tools over stdio")?
        .is_empty());

    if let Some(openwebui) = openwebui {
        let available_tools = call_tool_json!(client, "list_available_tools", Map::new())?;
        assert_eq!(available_tools[0]["id"], json!("server:time"));
        assert_eq!(
            available_tools[0]["description"],
            json!("Time conversion tools. convert timezones, inspect offsets")
        );

        let created = call_tool_json!(
            client,
            "create_agent",
            args(&[
                ("name", json!("Writer Agent")),
                ("base_model_id", json!("gpt-5.4")),
                ("description", json!("Writes concise release notes")),
                (
                    "system_prompt",
                    json!("Respond with crisp release summaries.")
                ),
                ("tool_server_ids", json!(["server:time"])),
            ])
        )?;
        assert_eq!(created["id"], json!("writer-agent"));
        assert_eq!(created["base_model_id"], json!("gpt-5.4"));
        assert_eq!(created["tool_server_ids"], json!(["server:time"]));
        assert_eq!(created["skill_ids"], json!([]));
        assert_eq!(
            created["created_by_email"],
            json!("integration-user@example.invalid")
        );
        assert_eq!(created["creation_source"], json!("local"));
        assert_eq!(created["tools"][0]["id"], json!("server:time"));

        let fetched = call_tool_json!(
            client,
            "get_agent",
            args(&[("model_id", json!("writer-agent"))])
        )?;
        assert_eq!(fetched["id"], json!("writer-agent"));
        assert_eq!(fetched["tool_server_ids"], json!(["server:time"]));
        assert_eq!(
            fetched["description"],
            json!("Writes concise release notes")
        );

        let system_prompt = call_tool_json!(
            client,
            "get_agent_system_prompt",
            args(&[("model_id", json!("writer-agent"))])
        )?;
        assert_eq!(
            system_prompt["system_prompt"],
            json!("Respond with crisp release summaries.")
        );

        let listed_agents = call_tool_json!(
            client,
            "list_agents",
            args(&[("filter_type", json!("all"))])
        )?;
        let agents = listed_agents
            .as_array()
            .context("list_agents should return an array")?;
        assert!(agents
            .iter()
            .any(|agent| agent["id"] == json!("writer-agent")));

        let requests = openwebui.requests();
        assert!(requests
            .iter()
            .any(|request| request.method == "POST" && request.path == "/api/v1/models/create"));
    } else {
        let error = client
            .call_tool(tool_request("list_available_tools", Map::new()))
            .await
            .expect_err("list_available_tools should fail without a seeded token");
        assert!(error
            .to_string()
            .contains("Open WebUI API token not available in Redis"));
    }

    client.cancel().await?;
    Ok(())
}
