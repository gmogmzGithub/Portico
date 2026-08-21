use super::*;
use crate::native::TEST_ENV_LOCK;
use std::env;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;
use uuid::Uuid;

struct EnvGuard {
    _guard: MutexGuard<'static, ()>,
    previous_openwebui_base_url: Option<String>,
    previous_chat_state_api_base_url: Option<String>,
}

impl EnvGuard {
    fn new() -> Self {
        let guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let previous_openwebui_base_url = env::var("OPENWEBUI_BASE_URL").ok();
        let previous_chat_state_api_base_url = env::var("CHAT_STATE_API_BASE_URL").ok();
        Self {
            _guard: guard,
            previous_openwebui_base_url,
            previous_chat_state_api_base_url,
        }
    }

    fn set_openwebui_base(&self, value: &str) {
        env::set_var("OPENWEBUI_BASE_URL", value);
    }

    fn set_chat_state_api_base(&self, value: &str) {
        env::set_var("CHAT_STATE_API_BASE_URL", value);
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        if let Some(value) = &self.previous_openwebui_base_url {
            env::set_var("OPENWEBUI_BASE_URL", value);
        } else {
            env::remove_var("OPENWEBUI_BASE_URL");
        }
        if let Some(value) = &self.previous_chat_state_api_base_url {
            env::set_var("CHAT_STATE_API_BASE_URL", value);
        } else {
            env::remove_var("CHAT_STATE_API_BASE_URL");
        }
    }
}

#[derive(Clone)]
struct MockReply {
    status: &'static str,
    body: Value,
}

#[derive(Debug)]
struct CapturedRequest {
    method: String,
    path: String,
    body: String,
    authorization: Option<String>,
}

struct ReplyServer {
    base_url: String,
    requests: mpsc::Receiver<CapturedRequest>,
    shutdown: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl ReplyServer {
    fn base_url(&self) -> &str {
        &self.base_url
    }

    fn recv(&self) -> Result<CapturedRequest, mpsc::RecvError> {
        self.requests.recv()
    }
}

impl Drop for ReplyServer {
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

fn read_request(mut stream: TcpStream) -> Option<(TcpStream, CapturedRequest)> {
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

    let authorization = header.split("\r\n").find_map(|line| {
        let lower = line.to_ascii_lowercase();
        lower
            .strip_prefix("authorization:")
            .map(|_| line[line.find(':').map(|i| i + 1).unwrap_or(0)..].trim().to_string())
    });

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
        CapturedRequest {
            method,
            path,
            body: String::from_utf8(body).unwrap_or_default(),
            authorization,
        },
    ))
}

fn serve_responses(replies: Vec<MockReply>) -> ReplyServer {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind listener");
    let base_url = format!("http://{}", listener.local_addr().expect("listener addr"));
    let (tx, rx) = mpsc::channel();
    let replies = Arc::new(Mutex::new(replies));
    let shutdown = Arc::new(AtomicBool::new(false));
    let shutdown_clone = Arc::clone(&shutdown);
    let replies_clone = Arc::clone(&replies);
    let thread = thread::spawn(move || loop {
        if shutdown_clone.load(Ordering::SeqCst) {
            break;
        }
        match listener.accept() {
            Ok((stream, _)) => {
                let replies = Arc::clone(&replies_clone);
                let tx = tx.clone();
                thread::spawn(move || {
                    let Some((mut stream, request)) = read_request(stream) else {
                        return;
                    };
                    let reply = {
                        let mut lock = replies.lock().expect("lock replies");
                        if lock.is_empty() {
                            return;
                        }
                        lock.remove(0)
                    };
                    let _ = tx.send(request);
                    let body = serde_json::to_vec(&reply.body).expect("encode body");
                    let response = format!(
                            "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            reply.status,
                            body.len()
                        );
                    let _ = stream
                        .write_all(response.as_bytes())
                        .and_then(|_| stream.write_all(&body));
                    let _ = stream.flush();
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
            Err(error) => panic!("accept request: {error}"),
        }
    });
    ReplyServer {
        base_url,
        requests: rx,
        shutdown,
        thread: Some(thread),
    }
}

#[test]
fn variable_and_error_helpers_cover_all_branches() {
    let variables = generate_variables();
    assert_eq!(variables["{{USER_NAME}}"], json!("Sub-Agent"));
    assert_eq!(variables["{{CURRENT_TIMEZONE}}"], json!("America/New_York"));
    assert!(variables["{{CURRENT_DATETIME}}"]
        .as_str()
        .unwrap_or_default()
        .contains('-'));

    assert_eq!(extract_last_sentence("plain text"), "plain text");
    assert_eq!(
        extract_last_sentence("Before<details type=\"tool_calls\">hidden</details>After"),
        "BeforeAfter"
    );
    assert_eq!(
        extract_parent_facing_response(&json!({
            "role": "assistant",
            "contentBlocks": [
                {"type": "text", "content": "I will inspect the overflow artifact first.to=functions.vm_execute_bash  json\n{\"vm_id\":\"abc\"}\n## Executive summary\n- Clean synthesis\n- Actionable next steps"}
            ]
        })),
        "## Executive summary\n- Clean synthesis\n- Actionable next steps"
    );
    assert_eq!(
        extract_parent_facing_response(&json!({
            "role": "assistant",
            "content": "Short clean answer"
        })),
        "Short clean answer"
    );

    assert_eq!(extract_error_message(&json!("plain-error")), "plain-error");
    assert_eq!(
        extract_error_message(&json!({ "content": "content-error" })),
        "content-error"
    );
    assert_eq!(
        extract_error_message(&json!({ "content": { "message": "nested-message" } })),
        "nested-message"
    );
    assert_eq!(
        extract_error_message(&json!({ "content": { "content": "nested-content" } })),
        "nested-content"
    );
    assert_eq!(
        extract_error_message(&json!({ "content": { "error": "nested-error" } })),
        "nested-error"
    );
    assert_eq!(
        extract_error_message(&json!({ "message": "top-message" })),
        "top-message"
    );
    assert_eq!(
        extract_error_message(&json!({ "error": "top-error" })),
        "top-error"
    );
    assert_eq!(
        extract_error_message(&json!({ "detail": "top-detail" })),
        "top-detail"
    );
    assert_eq!(
        extract_error_message(&json!({ "other": "value" })),
        "{\"other\":\"value\"}"
    );

    assert!(is_context_window_error("Context window exceeded"));
    assert!(is_context_window_error("context budget exhausted"));
    assert!(is_context_window_error("max context hit"));
    assert!(is_context_window_error(
        "You exceeded the available context"
    ));
    assert!(!is_context_window_error("network timeout"));
}

#[test]
fn completion_helpers_cover_pending_and_finished_paths() {
    assert!(has_pending_tool_calls(&json!({
        "contentBlocks": [{
            "type": "tool_calls",
            "results": [],
        }]
    })));
    assert!(has_pending_tool_calls(&json!({
        "contentBlocks": [{
            "type": "tool_calls",
            "content": [{ "id": "tool-1" }],
        }]
    })));
    assert!(has_pending_tool_calls(&json!({
        "contentBlocks": [{
            "type": "tool_calls",
            "content": [{ "id": "tool-1" }],
            "results": [],
            "ended_at": "2026-03-07T10:00:00Z"
        }]
    })));
    assert!(has_pending_tool_calls(&json!({
        "contentBlocks": [{
            "type": "tool_calls",
            "content": [{ "id": "tool-1" }],
            "results": [{ "id": "tool-1" }]
        }]
    })));
    assert!(has_pending_tool_calls(&json!({
        "content": "<details type=\"tool_calls\" done=\"false\">pending</details>"
    })));
    assert!(has_pending_tool_calls(&json!({
        "tool_calls": [{ "id": "tool-1" }]
    })));
    assert!(!has_pending_tool_calls(&json!({
        "contentBlocks": [{
            "type": "tool_calls",
            "content": [{ "id": "tool-1" }],
            "results": [{ "id": "tool-1" }],
            "ended_at": "2026-03-07T10:00:00Z"
        }]
    })));

    assert!(!message_is_complete(
        &json!({ "role": "user", "done": true })
    ));
    assert!(message_is_complete(
        &json!({ "role": "assistant", "done": "TRUE" })
    ));
    assert!(message_is_complete(&json!({
        "role": "assistant",
        "done": true,
        "content": "tool call phase",
        "finish_reason": "tool_calls",
        "usage": { "prompt_tokens": 1 }
    })));
    assert!(message_is_complete(&json!({
        "role": "assistant",
        "done": true,
        "content": "tool call phase",
        "stopReason": "tool_use",
        "usage": { "prompt_tokens": 1 }
    })));
    assert!(!message_is_complete(&json!({
        "role": "assistant",
        "done": true,
        "contentBlocks": [{
            "type": "tool_calls",
            "content": [{ "id": "tool-1" }],
            "results": [],
            "ended_at": "2026-03-07T10:00:00Z"
        }],
        "usage": { "prompt_tokens": 1 }
    })));
    assert!(!message_is_complete(&json!({
        "role": "assistant",
        "content": "done",
        "finish_reason": "tool_calls",
        "usage": { "prompt_tokens": 1 }
    })));
    assert!(!message_is_complete(&json!({
        "role": "assistant",
        "content": "done",
        "stopReason": "tool_use",
        "usage": { "prompt_tokens": 1 }
    })));
    assert!(!message_is_complete(&json!({
        "role": "assistant",
        "content": "done",
        "tool_calls": [{ "id": "tool-1" }],
        "usage": { "prompt_tokens": 1 }
    })));
    assert!(message_is_complete(&json!({
        "role": "assistant",
        "content": "done",
        "usage": { "completion_tokens": 2 }
    })));
}

#[test]
fn usage_extraction_supports_all_known_token_keys() {
    assert_eq!(
        extract_usage_from_chat(&json!({
            "chat": { "history": { "messages": {
                "a": { "role": "assistant", "usage": { "prompt_tokens": 11 } }
            }}}
        })),
        11
    );
    assert_eq!(
        extract_usage_from_chat(&json!({
            "chat": { "history": { "messages": {
                "a": { "role": "assistant", "usage": { "input_tokens": 22 } }
            }}}
        })),
        22
    );
    assert_eq!(
        extract_usage_from_chat(&json!({
            "chat": { "history": { "messages": {
                "a": { "role": "assistant", "usage": { "inputTokens": 33 } }
            }}}
        })),
        33
    );
    assert_eq!(extract_usage_from_chat(&json!({})), 0);
}

#[test]
fn tool_call_count_extraction_counts_structured_and_legacy_tool_calls() {
    assert_eq!(
        extract_tool_call_count_from_chat(&json!({
            "chat": { "history": { "messages": {
                "assistant-1": {
                    "role": "assistant",
                    "contentBlocks": [
                        { "type": "tool_calls", "content": [{ "id": "a" }, { "id": "b" }] },
                        { "type": "text", "content": "ignored" }
                    ]
                },
                "assistant-2": {
                    "role": "assistant",
                    "tool_calls": [{ "id": "c" }]
                },
                "user-1": {
                    "role": "user",
                    "contentBlocks": [{ "type": "tool_calls", "content": [{ "id": "ignored" }] }]
                }
            }}}
        })),
        3
    );
    assert_eq!(
        extract_tool_call_count_from_chat(&json!({
            "chat": { "history": { "messages": {
                "assistant-1": {
                    "role": "assistant",
                    "contentBlocks": [
                        { "type": "tool_calls", "content": { "id": "single" } }
                    ]
                }
            }}}
        })),
        1
    );
    assert_eq!(extract_tool_call_count_from_chat(&json!({})), 0);
}

#[tokio::test]
async fn align_messages_posts_normalized_chat_payload() {
    let env = EnvGuard::new();
    let server = serve_responses(vec![MockReply {
        status: "200 OK",
        body: json!({ "success": true, "id": Uuid::new_v4().to_string() }),
    }]);
    env.set_openwebui_base(server.base_url());

    let chat_data = json!({
        "chat": {
            "models": ["gpt-test"],
            "params": { "temperature": 0.2 },
            "files": ["f-1"],
            "history": {
                "messages": {
                    "user-1": {
                        "role": "user",
                        "content": [
                            { "type": "text", "text": "Hello" },
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": "http://host.docker.internal:9876/workspace/chat/slide-1.jpg"
                                }
                            }
                        ],
                        "timestamp": 123,
                        "models": ["gpt-test"]
                    },
                    "assistant-1": {
                        "role": "assistant",
                        "content": "Before<details type=\"tool_calls\">hidden</details>After",
                        "usage": { "prompt_tokens": 55 }
                    }
                }
            }
        }
    });

    align_messages("token-123", "chat-1", "gpt-test", &chat_data)
        .await
        .expect("align should succeed");

    let request = server.recv().expect("captured request");
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/api/v1/chats/chat-1");

    let body: Value = serde_json::from_str(&request.body).expect("request json");
    assert_eq!(body["chat"]["history"]["currentId"], json!("assistant-1"));
    assert_eq!(
        body["chat"]["history"]["messages"]["user-1"]["childrenIds"],
        json!(["assistant-1"])
    );
    assert_eq!(
        body["chat"]["history"]["messages"]["user-1"]["content"],
        json!(
            "Hello\n\nImage inputs attached for model analysis:\n1. http://localhost:9876/workspace/chat/slide-1.jpg"
        )
    );
    assert_eq!(
        body["chat"]["history"]["messages"]["assistant-1"]["parentId"],
        json!("user-1")
    );
    assert_eq!(
        body["chat"]["history"]["messages"]["assistant-1"]["lastSentence"],
        json!("BeforeAfter")
    );
    assert_eq!(body["chat"]["messages"][0]["role"], json!("user"));
    assert_eq!(
        body["chat"]["messages"][0]["content"],
        json!(
            "Hello\n\nImage inputs attached for model analysis:\n1. http://localhost:9876/workspace/chat/slide-1.jpg"
        )
    );
    assert_eq!(body["chat"]["messages"][1]["model"], json!("gpt-test"));
}

#[tokio::test]
async fn align_messages_rejects_missing_required_history_entries() {
    let env = EnvGuard::new();
    env.set_openwebui_base("http://127.0.0.1:9");

    let missing_user = align_messages(
        "token",
        "chat-1",
        "gpt-test",
        &json!({
            "chat": {
                "history": { "messages": {
                    "assistant-1": { "role": "assistant", "content": "done" }
                }}
            }
        }),
    )
    .await
    .expect_err("missing user should fail");
    assert!(missing_user
        .to_string()
        .contains("Could not identify user message"));

    let missing_assistant = align_messages(
        "token",
        "chat-1",
        "gpt-test",
        &json!({
            "chat": {
                "history": { "messages": {
                    "user-1": { "role": "user", "content": "hello" }
                }}
            }
        }),
    )
    .await
    .expect_err("missing assistant should fail");
    assert!(missing_assistant
        .to_string()
        .contains("Could not identify assistant message"));
}

#[tokio::test]
async fn save_chat_state_posts_reasoning_payload_for_reasoning_subagent_chats() {
    let env = EnvGuard::new();
    let server = serve_responses(vec![MockReply {
        status: "200 OK",
        body: json!({ "success": true }),
    }]);
    env.set_chat_state_api_base(server.base_url());

    save_chat_state(
        "chat-123",
        321,
        1_000_000,
        Some("max"),
        Some("GPT-5.4"),
        "test-token",
    )
    .await;

    let request = server.recv().expect("captured request");
    assert_eq!(request.method, "PUT");
    assert_eq!(request.path, "/api/v1/chat-state/chat-123");
    // The chat-state-api requires auth; without it the PUT is rejected and the
    // subagent chat's reasoning effort is never persisted.
    assert_eq!(request.authorization.as_deref(), Some("Bearer test-token"));
    let body: Value = serde_json::from_str(&request.body).expect("request json");
    assert_eq!(body["context_tokens"], json!(321));
    assert_eq!(body["max_context_tokens"], json!(1_000_000));
    assert_eq!(body["reasoning_effort"], json!("max"));
    assert_eq!(body["reasoning_effort_by_model"], json!({ "0": "max" }));
    assert_eq!(body["model_name"], json!("GPT-5.4"));
}

#[tokio::test]
async fn save_chat_state_uses_empty_reasoning_map_for_non_reasoning_subagent_chats() {
    let env = EnvGuard::new();
    let server = serve_responses(vec![MockReply {
        status: "200 OK",
        body: json!({ "success": true }),
    }]);
    env.set_chat_state_api_base(server.base_url());

    save_chat_state(
        "chat-plain",
        42,
        200_000,
        None,
        Some("claude-3.5-haiku"),
        "test-token",
    )
    .await;

    let request = server.recv().expect("captured request");
    assert_eq!(request.method, "PUT");
    assert_eq!(request.path, "/api/v1/chat-state/chat-plain");
    assert_eq!(request.authorization.as_deref(), Some("Bearer test-token"));
    let body: Value = serde_json::from_str(&request.body).expect("request json");
    assert_eq!(body["reasoning_effort"], Value::Null);
    assert_eq!(body["reasoning_effort_by_model"], json!({}));
    assert_eq!(body["model_name"], json!("claude-3.5-haiku"));
}

#[test]
fn error_and_pending_helpers_cover_fallback_and_non_tool_blocks() {
    let detail = extract_error_message(&json!({
        "content": { "ignored": "nested" },
        "detail": "outer-detail",
    }));
    assert_eq!(detail, "outer-detail");

    let fallback = extract_error_message(&json!({
        "content": { "ignored": "nested" },
    }));
    assert!(fallback.contains("\"ignored\":\"nested\""));

    assert!(!has_pending_tool_calls(&json!({
        "contentBlocks": [{
            "type": "text",
            "content": [{"type": "text", "text": "done"}],
        }]
    })));
}
