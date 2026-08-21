use anyhow::{Context, Result};
use rmcp::model::{CallToolRequestParams, CallToolResult};
use rmcp::{transport::TokioChildProcess, ServiceExt};
use serde_json::{json, Map, Value};
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;
use uuid::Uuid;

struct TempRoot {
    path: PathBuf,
}

impl TempRoot {
    fn new(name: &str) -> Result<Self> {
        let path = env::temp_dir().join(format!(
            "core-mcp-rust-skills-user-question-stdio-{name}-{}",
            Uuid::new_v4().simple()
        ));
        fs::create_dir_all(path.join("mcp-configs"))?;
        fs::create_dir_all(path.join("mcp-configs-user"))?;
        fs::create_dir_all(path.join("skills"))?;
        fs::create_dir_all(path.join("skills-user"))?;
        fs::create_dir_all(path.join("skills-marketplace"))?;
        Ok(Self { path })
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[derive(Debug)]
struct CapturedRequest {
    method: String,
    path: String,
    body: String,
}

#[derive(Clone)]
struct MockReply {
    status: &'static str,
    body: Value,
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
            let (name, value) = line.split_once(':')?;
            if !name.eq_ignore_ascii_case("content-length") {
                return None;
            }
            value.trim().parse::<usize>().ok()
        })
        .unwrap_or(0);

    let mut body_bytes = buffer[header_end..].to_vec();
    while body_bytes.len() < content_length {
        let read = stream.read(&mut chunk).expect("read request body");
        if read == 0 {
            break;
        }
        body_bytes.extend_from_slice(&chunk[..read]);
    }
    body_bytes.truncate(content_length);

    CapturedRequest {
        method,
        path,
        body: String::from_utf8(body_bytes).expect("body utf8"),
    }
}

fn serve_responses(replies: Vec<MockReply>) -> (String, mpsc::Receiver<CapturedRequest>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind listener");
    let base = format!("http://{}", listener.local_addr().expect("listener addr"));
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        for reply in replies {
            let (mut stream, _) = listener.accept().expect("accept request");
            let request = read_http_request(&mut stream);
            tx.send(request).expect("send request");
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
        }
    });
    (base, rx)
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

#[tokio::test]
async fn stdio_ask_user_question_proxies_to_electron_and_waits_for_submission() -> Result<()> {
    let root = TempRoot::new("flow")?;
    let (base, requests) = serve_responses(vec![
        MockReply {
            status: "202 Accepted",
            body: json!({
                "success": true,
                "started": true,
                "flow_id": "flow-stdio",
                "timeout_seconds": 90
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "success": true,
                "flow_id": "flow-stdio",
                "status": "in_progress"
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "success": true,
                "flow_id": "flow-stdio",
                "status": "completed",
                "result": {
                    "success": true,
                    "status": "submitted",
                    "answers": [{
                        "question_id": "marketplace",
                        "selected_option_id": "portico-ai-marketplace",
                        "selected_option_label": "portico-ai-marketplace",
                        "freeform_text": null
                    }]
                }
            }),
        },
    ]);

    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_skills-server"));
    command.current_dir(&root.path);
    command.env("CONTAINER_PROJECT_ROOT", &root.path);
    command.env("HOST_PROJECT_ROOT", &root.path);
    command.env("CORE_MCP_TEST_REDIS", "memory");
    command.env("ELECTRON_API_BASE", &base);

    let transport = TokioChildProcess::new(command)?;
    let client = ().serve(transport).await?;

    let response = payload(
        client
            .call_tool(tool_request(
                "ask_user_question",
                args(&[
                    ("chat_id", json!("chat-publish-1")),
                    (
                        "questions",
                        json!([{
                            "id": "marketplace",
                            "header": "Marketplace",
                            "question": "Which marketplace should receive this skill?",
                            "options": [
                                {
                                    "id": "my-agent-skills",
                                    "label": "My Agent Skills",
                                    "component_defaults": { "skills": ["company-knowledge"] }
                                },
                                { "id": "portico-ai-marketplace", "label": "portico-ai-marketplace" }
                            ],
                            "components": [
                                {
                                    "type": "skill_picker",
                                    "id": "skills",
                                    "default_selected": ["web-search"]
                                }
                            ]
                        }]),
                    ),
                    ("timeout_seconds", json!(90)),
                ]),
            ))
            .await?,
    )?;

    assert_eq!(response["success"], json!(true));
    assert_eq!(response["status"], json!("submitted"));
    assert_eq!(
        response["answers"][0]["selected_option_id"],
        json!("portico-ai-marketplace")
    );

    let request = requests.recv().expect("trigger request");
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/api/trigger-user-question-flow");
    assert_eq!(
        serde_json::from_str::<Value>(&request.body).unwrap(),
        json!({
            "chat_id": "chat-publish-1",
            "questions": [{
                "id": "marketplace",
                "header": "Marketplace",
                "question": "Which marketplace should receive this skill?",
                "freeform_placeholder": "Add any extra context for this answer (optional).",
                "options": [
                    {
                        "id": "my-agent-skills",
                        "label": "My Agent Skills",
                        "description": null,
                        "component_defaults": { "skills": ["company-knowledge"] }
                    },
                    {
                        "id": "portico-ai-marketplace",
                        "label": "portico-ai-marketplace",
                        "description": null,
                        "component_defaults": null
                    }
                ],
                "components": [{
                    "type": "skill_picker",
                    "id": "skills",
                    "label": null,
                    "multiple": true,
                    "default_selected": ["web-search"]
                }],
                "components_gated_by_option_id": null
            }],
            "timeout_seconds": 90
        })
    );

    let request = requests.recv().expect("first poll request");
    assert_eq!(request.method, "GET");
    assert_eq!(request.path, "/api/user-question-flow-status/flow-stdio");

    let request = requests.recv().expect("second poll request");
    assert_eq!(request.method, "GET");
    assert_eq!(request.path, "/api/user-question-flow-status/flow-stdio");

    Ok(())
}
