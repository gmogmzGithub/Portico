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
            "core-mcp-rust-web-tools-stdio-{name}-{}",
            Uuid::new_v4().simple()
        ));
        fs::create_dir_all(path.join("mcp-configs"))?;
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
    headers: HashMap<String, String>,
    body: String,
}

struct MockHttpServer {
    base_url: String,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
    shutdown: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl MockHttpServer {
    fn start(response_body: Value) -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let address = listener.local_addr()?;
        let requests = Arc::new(Mutex::new(Vec::new()));
        let shutdown = Arc::new(AtomicBool::new(false));
        let requests_clone = Arc::clone(&requests);
        let shutdown_clone = Arc::clone(&shutdown);
        let body = Arc::new(response_body);
        let body_clone = Arc::clone(&body);
        let thread = thread::spawn(move || loop {
            if shutdown_clone.load(Ordering::SeqCst) {
                break;
            }
            match listener.accept() {
                Ok((stream, _)) => {
                    let requests = Arc::clone(&requests_clone);
                    let response_body = Arc::clone(&body_clone);
                    thread::spawn(move || {
                        if let Some((mut stream, request)) = read_request(stream) {
                            requests
                                .lock()
                                .unwrap_or_else(|poison| poison.into_inner())
                                .push(request);
                            let body = serde_json::to_string(&*response_body)
                                .expect("failed to encode mock body");
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
            requests,
            shutdown,
            thread: Some(thread),
        })
    }

    fn base_url(&self) -> &str {
        &self.base_url
    }

    fn requests(&self) -> Vec<RecordedRequest> {
        self.requests
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
    }
}

impl Drop for MockHttpServer {
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
    let headers = header
        .split("\r\n")
        .skip(1)
        .filter_map(|line| {
            let (key, value) = line.split_once(':')?;
            Some((key.trim().to_ascii_lowercase(), value.trim().to_string()))
        })
        .collect::<HashMap<_, _>>();
    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
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
            headers,
            body: String::from_utf8(body).unwrap_or_default(),
        },
    ))
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
async fn stdio_web_tools_executes_mocked_web_search_flow() -> Result<()> {
    let root = TempRoot::new("web-search").context("create temp root")?;
    let proxy = match MockHttpServer::start(json!({
        "output": [
            { "type": "web_search_call" },
            {
                "type": "message",
                "content": [{
                    "type": "output_text",
                    "text": "Rust release notes mention improved testing support.",
                    "annotations": [{
                        "type": "url_citation",
                        "url": "https://example.test/rust",
                        "title": "Rust testing",
                        "start_index": 0,
                        "end_index": 10
                    }]
                }]
            }
        ],
        "usage": { "input_tokens": 123, "output_tokens": 45 }
    })) {
        Ok(proxy) => Some(proxy),
        Err(error) if is_permission_error(&error) => None,
        Err(error) => return Err(error.context("start mock proxy")),
    };

    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_web-tools-server"));
    command.current_dir(&root.path);
    command.env("WEB_TOOLS_OPENAI_MODEL", "gpt-5.6-sol");
    command.env("PORTICO_LLM_API_KEY", "test-api-key");
    command.env("PORTICO_USER_ID", "user-123");
    command.env("PORTICO_REDACT_ALLOW", "internal");
    command.env("PORTICO_BUILD_TRACK", "integration");
    if let Some(proxy) = proxy.as_ref() {
        command.env("WEB_TOOLS_PROXY_URL", proxy.base_url());
    } else {
        command.env("WEB_TOOLS_PROXY_URL", "http://127.0.0.1:9");
    }

    let transport = TokioChildProcess::new(command).context("spawn web-tools child")?;
    let client = ().serve(transport).await.context("connect RMCP client")?;

    assert!(!client
        .list_all_tools()
        .await
        .context("list tools over stdio")?
        .is_empty());

    if let Some(proxy) = proxy {
        let result = call_tool_json!(
            client,
            "web_search",
            args(&[
                ("query", json!("rust test harness improvements")),
                ("allowed_domains", json!(["example.test"])),
                (
                    "user_location",
                    json!({
                        "country": "US",
                        "city": "Austin",
                        "timezone": "America/Chicago"
                    })
                ),
            ])
        )?;
        assert_eq!(result["success"], json!(true));
        assert_eq!(
            result["response"],
            json!("Rust release notes mention improved testing support.")
        );
        assert_eq!(result["usage"]["web_search_calls"], json!(1));
        assert_eq!(
            result["citations"][0]["url"],
            json!("https://example.test/rust")
        );

        let requests = proxy.requests();
        assert_eq!(requests.len(), 1);
        let request = &requests[0];
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/responses");
        assert_eq!(
            request.headers.get("authorization").map(String::as_str),
            Some("Bearer test-api-key")
        );
        assert_eq!(
            request.headers.get("x-portico-userid").map(String::as_str),
            Some("user-123")
        );
        let body: Value = serde_json::from_str(&request.body)?;
        assert_eq!(body["model"], json!("gpt-5.6-sol"));
        assert_eq!(
            body["tools"][0]["filters"]["allowed_domains"],
            json!(["example.test"])
        );
    } else {
        let result = call_tool_json!(
            client,
            "web_search",
            args(&[("query", json!("rust test harness improvements"))])
        )?;
        assert_eq!(result["success"], json!(false));
        assert_eq!(result["tool"], json!("web_search"));
        assert_eq!(result["error_type"], json!("RuntimeError"));
    }

    client.cancel().await?;
    Ok(())
}
