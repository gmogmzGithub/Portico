#[rustfmt::skip]
use super::*;
use crate::native::shared::{redis_delete, redis_get_string, redis_set_string};
use crate::native::TEST_ENV_LOCK;
use serde_json::json;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::Duration;

struct TestEnv {
    _guard: MutexGuard<'static, ()>,
    root: PathBuf,
    previous_cwd: PathBuf,
    previous_container_root: Option<String>,
    previous_host_root: Option<String>,
    previous_test_redis: Option<String>,
    previous_openwebui_base_url: Option<String>,
    previous_chat_state_api_base_url: Option<String>,
    previous_electron_api_base: Option<String>,
    previous_bridge_secret: Option<String>,
    previous_bridge_secret_file: Option<String>,
}

impl TestEnv {
    fn new(name: &str) -> Self {
        let guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        clear_cached_openwebui_token();
        let root = env::temp_dir().join(format!(
            "core-mcp-rust-subagents-{name}-{}",
            Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&root).expect("failed to create temp root");
        fs::create_dir_all(root.join("mcp-configs")).expect("failed to create mcp-configs");
        fs::create_dir_all(root.join("mcp-configs-user"))
            .expect("failed to create mcp-configs-user");
        fs::create_dir_all(root.join("skills")).expect("failed to create skills");
        fs::create_dir_all(root.join("skills-user")).expect("failed to create skills-user");
        fs::create_dir_all(root.join("skills-marketplace"))
            .expect("failed to create skills-marketplace");
        fs::create_dir_all(root.join("assets")).expect("failed to create assets");
        let previous_cwd = env::current_dir().expect("failed to capture cwd");
        let previous_container_root = env::var("CONTAINER_PROJECT_ROOT").ok();
        let previous_host_root = env::var("HOST_PROJECT_ROOT").ok();
        let previous_test_redis = env::var("CORE_MCP_TEST_REDIS").ok();
        let previous_openwebui_base_url = env::var("OPENWEBUI_BASE_URL").ok();
        let previous_chat_state_api_base_url = env::var("CHAT_STATE_API_BASE_URL").ok();
        let previous_electron_api_base = env::var("ELECTRON_API_BASE").ok();
        let previous_bridge_secret = env::var(OWUI_AUTH_BRIDGE_SECRET_ENV).ok();
        let previous_bridge_secret_file = env::var(OWUI_AUTH_BRIDGE_SECRET_FILE_ENV).ok();
        env::set_var("CONTAINER_PROJECT_ROOT", &root);
        env::set_var("HOST_PROJECT_ROOT", &root);
        env::set_var("CORE_MCP_TEST_REDIS", "memory");
        env::set_var(OWUI_AUTH_BRIDGE_SECRET_ENV, "bridge-test-secret");
        env::remove_var(OWUI_AUTH_BRIDGE_SECRET_FILE_ENV);
        env::set_current_dir(&root).expect("failed to chdir into temp root");
        Self {
            _guard: guard,
            root,
            previous_cwd,
            previous_container_root,
            previous_host_root,
            previous_test_redis,
            previous_openwebui_base_url,
            previous_chat_state_api_base_url,
            previous_electron_api_base,
            previous_bridge_secret,
            previous_bridge_secret_file,
        }
    }

    fn set_openwebui_base_url(&self, base_url: &str) {
        env::set_var("OPENWEBUI_BASE_URL", base_url);
    }

    fn set_chat_state_api_base_url(&self, base_url: &str) {
        env::set_var("CHAT_STATE_API_BASE_URL", base_url);
    }

    fn set_electron_api_base(&self, base_url: &str) {
        env::set_var("ELECTRON_API_BASE", base_url);
    }

    fn set_openwebui_token(&self, token: &str) {
        redis_set_string(OPENWEBUI_TOKEN_KEY, token).expect("failed to seed token");
    }

    fn set_openwebui_user_id(&self, user_id: &str) {
        redis_set_string(OPENWEBUI_USER_KEY, user_id).expect("failed to seed user");
    }

    fn write_server_yaml(
        &self,
        user_installed: bool,
        server_id: &str,
        description: &str,
        use_cases: &[&str],
    ) {
        let base = if user_installed {
            self.root.join("mcp-configs-user")
        } else {
            self.root.join("mcp-configs")
        };
        let server_dir = base.join(server_id);
        fs::create_dir_all(&server_dir).expect("failed to create server dir");
        let mut yaml = format!(
            "name: {server_id}\ndisplay_name: {server_id}\ndeployment_type: docker\ndescription: {description}\n"
        );
        if !use_cases.is_empty() {
            yaml.push_str("use_cases:\n");
            for value in use_cases {
                yaml.push_str(&format!("  - {value}\n"));
            }
        }
        fs::write(server_dir.join(format!("{server_id}.yaml")), yaml)
            .expect("failed to write yaml");
    }

    fn write_skill(&self, skill_name: &str, description: &str, required_mcp_servers: &[&str]) {
        let skill_dir = self.root.join("skills").join(skill_name);
        fs::create_dir_all(&skill_dir).expect("failed to create skill dir");
        fs::write(
            skill_dir.join("SKILL.md"),
            skill_markdown(skill_name, description, required_mcp_servers),
        )
        .expect("failed to write skill");
    }

    fn write_model_catalog(&self, yaml: &str) {
        fs::write(self.root.join("model_catalog.yaml"), yaml)
            .expect("failed to write model catalog");
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
        if let Some(value) = &self.previous_test_redis {
            env::set_var("CORE_MCP_TEST_REDIS", value);
        } else {
            env::remove_var("CORE_MCP_TEST_REDIS");
        }
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
        if let Some(value) = &self.previous_electron_api_base {
            env::set_var("ELECTRON_API_BASE", value);
        } else {
            env::remove_var("ELECTRON_API_BASE");
        }
        if let Some(value) = &self.previous_bridge_secret {
            env::set_var(OWUI_AUTH_BRIDGE_SECRET_ENV, value);
        } else {
            env::remove_var(OWUI_AUTH_BRIDGE_SECRET_ENV);
        }
        if let Some(value) = &self.previous_bridge_secret_file {
            env::set_var(OWUI_AUTH_BRIDGE_SECRET_FILE_ENV, value);
        } else {
            env::remove_var(OWUI_AUTH_BRIDGE_SECRET_FILE_ENV);
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn response_payload(response: Value) -> Value {
    serde_json::from_str(
        response["content"][0]["text"]
            .as_str()
            .expect("missing response text"),
    )
    .expect("invalid JSON payload")
}

fn args(entries: &[(&str, Value)]) -> Map<String, Value> {
    entries
        .iter()
        .map(|(key, value)| ((*key).to_string(), value.clone()))
        .collect()
}

fn skill_markdown(skill_name: &str, description: &str, required_mcp_servers: &[&str]) -> String {
    let required = if required_mcp_servers.is_empty() {
        "required_mcp_servers: []".to_string()
    } else {
        format!(
            "required_mcp_servers:\n{}",
            required_mcp_servers
                .iter()
                .map(|server| format!("  - {server}"))
                .collect::<Vec<_>>()
                .join("\n")
        )
    };
    format!(
        "\
---
name: {skill_name}
description: {description}
{required}
metadata:
  priority: high
---
# {skill_name}
"
    )
}

fn assert_err_contains<T: std::fmt::Debug>(result: Result<T>, expected: &str) {
    let error = result.expect_err("expected handler to fail");
    assert!(
        error.to_string().contains(expected),
        "expected error containing {expected:?}, got {error:#}"
    );
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
        let address = listener
            .local_addr()
            .expect("failed to inspect mock address");
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
                            requests
                                .lock()
                                .unwrap_or_else(|poison| poison.into_inner())
                                .push(request.clone());
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
        self.requests
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
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
        409 => "Conflict",
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
async fn subagent_completion_retries_transient_chat_read_errors() {
    let env = TestEnv::new("poll-chat-read-retry");
    env.set_openwebui_token("token");
    let chat_get_count = Arc::new(AtomicUsize::new(0));
    let chat_get_count_for_server = Arc::clone(&chat_get_count);
    let server =
        MockServer::start(
            move |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/chats/chat-retry") => {
                    if chat_get_count_for_server.fetch_add(1, Ordering::SeqCst) == 0 {
                        return MockResponse {
                            status: 500,
                            body: json!({ "detail": "chat row is temporarily unavailable" }),
                        };
                    }
                    MockResponse::json(json!({
                        "chat": {
                            "models": ["test-model"],
                            "history": {
                                "messages": {
                                    "assistant-1": {
                                        "id": "assistant-1",
                                        "role": "assistant",
                                        "content": "Recovered answer",
                                        "finishReason": "stop",
                                        "usage": { "prompt_tokens": 4 }
                                    }
                                }
                            },
                            "messages": [
                                {
                                    "id": "assistant-1",
                                    "role": "assistant",
                                    "content": "Recovered answer",
                                    "finishReason": "stop",
                                    "usage": { "prompt_tokens": 4 }
                                }
                            ]
                        }
                    }))
                }
                _ => MockResponse {
                    status: 404,
                    body: json!({ "detail": "not found" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());

    let result = poll_subagent_completion_with_timeout(
        "token",
        "chat-retry",
        "test-model",
        None,
        Duration::from_secs(2),
        Duration::from_millis(10),
    )
    .await
    .expect("transient chat GET should be retried");

    assert_eq!(result["success"], json!(true));
    assert_eq!(result["response"], json!("Recovered answer"));
    assert!(
        chat_get_count.load(Ordering::SeqCst) >= 2,
        "poller should retry after a transient chat read failure"
    );
}

#[tokio::test]
async fn subagent_completion_chat_poll_does_not_refresh_to_service_token_on_auth_error() {
    let env = TestEnv::new("poll-chat-auth-error-no-service-refresh");
    env.set_openwebui_token("owner-token");
    clear_cached_openwebui_token();
    let service_token_called = Arc::new(AtomicBool::new(false));
    let service_token_called_for_server = Arc::clone(&service_token_called);
    let server =
        MockServer::start(
            move |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/chats/chat-forbidden") => MockResponse {
                    status: 403,
                    body: json!({ "detail": "forbidden" }),
                },
                ("POST", "/api/v1/portico/auth/service-token") => {
                    service_token_called_for_server.store(true, Ordering::SeqCst);
                    MockResponse::json(json!({ "token": "service-token" }))
                }
                _ => MockResponse {
                    status: 404,
                    body: json!({ "detail": "not found" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());

    assert_err_contains(
        poll_subagent_completion_with_timeout(
            "owner-token",
            "chat-forbidden",
            "test-model",
            None,
            Duration::ZERO,
            Duration::from_millis(1),
        )
        .await,
        "GET /api/v1/chats/chat-forbidden returned error",
    );

    assert!(
        !service_token_called.load(Ordering::SeqCst),
        "chat completion polling must not replace the chat owner token with a service token"
    );
    assert_eq!(
        redis_get_string(OPENWEBUI_TOKEN_KEY).unwrap().as_deref(),
        Some("owner-token")
    );
}

#[tokio::test]
async fn await_subagent_completion_uses_run_handle_token_without_global_token() {
    let env = TestEnv::new("await-uses-handle-token");
    redis_delete(OPENWEBUI_TOKEN_KEY).unwrap();
    clear_cached_openwebui_token();
    let server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/chats/chat-owner") => MockResponse::json(json!({
                    "chat": {
                        "models": ["test-model"],
                        "history": {
                            "messages": {
                                "assistant-1": {
                                    "id": "assistant-1",
                                    "role": "assistant",
                                    "content": "Owner token answer",
                                    "finishReason": "stop",
                                    "usage": { "prompt_tokens": 4 }
                                }
                            }
                        },
                        "messages": [
                            {
                                "id": "assistant-1",
                                "role": "assistant",
                                "content": "Owner token answer",
                                "finishReason": "stop",
                                "usage": { "prompt_tokens": 4 }
                            }
                        ]
                    }
                })),
                _ => MockResponse {
                    status: 404,
                    body: json!({ "detail": "not found" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());

    let outcome = await_subagent_completion(StartedSubagentRun {
        chat_id: "chat-owner".to_string(),
        session_id: "session-owner".to_string(),
        task_id: "task-owner".to_string(),
        model: "test-model".to_string(),
        reasoning_effort: None,
        token: "owner-token".to_string(),
    })
    .await
    .expect("await should use token carried by the run handle");

    let AwaitOutcome::Done(result) = outcome else {
        panic!("expected completed subagent run");
    };
    assert_eq!(result.chat_id, "chat-owner");
    assert_eq!(result.response, "Owner token answer");
    assert!(result.success);
}

#[test]
fn pure_helpers_cover_description_loading_and_model_filters() {
    let env = TestEnv::new("helpers");
    env.write_server_yaml(false, "time", "Time tools", &["convert", "inspect"]);
    env.write_server_yaml(true, "custom", "", &["browse"]);
    env.write_server_yaml(false, "empty", "", &[]);

    let tools_map = build_tools_map(&json!([
        { "id": "server:time", "name": "Time" },
        { "id": "server:custom", "name": "Custom" },
        { "id": "orphan", "name": "Orphan" }
    ]))
    .unwrap();
    assert_eq!(
        tools_map["server:time"]["description"],
        json!("Time tools. convert, inspect")
    );
    assert_eq!(tools_map["server:custom"]["description"], json!("browse"));
    assert!(tools_map["orphan"].get("description").is_none());
    assert_eq!(
        load_mcp_server_description("server:time").as_deref(),
        Some("Time tools. convert, inspect")
    );
    assert_eq!(load_mcp_server_description("missing"), None);
    assert_eq!(load_mcp_server_description("empty"), None);
    assert!(build_tools_map(&json!({ "tools": [] })).is_err());

    let plain_models = json!([{ "id": "base" }]);
    assert_eq!(extract_models(&plain_models).unwrap().len(), 1);
    let wrapped_models = json!({ "data": [{ "id": "derived" }] });
    assert_eq!(extract_models(&wrapped_models).unwrap().len(), 1);
    assert!(extract_models(&json!({ "invalid": true })).is_err());

    let base_model =
        json!({ "id": "base", "name": "Base", "meta": { "description": "Base model" } });
    let derived_model = json!({
        "id": "derived",
        "name": "Derived",
        "is_active": false,
        "info": {
            "base_model_id": "base",
            "meta": {
                "toolIds": ["server:time", "server:custom"],
                "subagent_tool_server_ids": ["server:time", "server:custom"],
                "subagent_skill_ids": ["company-knowledge"],
                "subagent_reasoning_effort": "high"
            }
        },
        "meta": {
            "description": "Derived model",
            "subagent_tool_server_ids": ["server:time", "server:custom"],
            "subagent_skill_ids": ["company-knowledge"],
            "subagent_reasoning_effort": "high",
            "subagent_created_by_email": "dsantiago@example.invalid",
            "subagent_creation_source": "local",
            "subagent_marketplace_relationship": "published",
            "subagent_marketplace_solution_id": "solution-derived"
        },
        "params": { "system": "Act carefully." }
    });
    assert!(!has_base_model_id(&base_model));
    assert!(has_base_model_id(&derived_model));
    assert_eq!(
        tool_server_ids_from_agent(&derived_model),
        vec!["server:time".to_string(), "server:custom".to_string()]
    );
    assert_eq!(
        subagent_skill_ids_from_model(&derived_model),
        vec!["company-knowledge".to_string()]
    );
    assert_eq!(
        subagent_reasoning_effort_from_model(&derived_model).as_deref(),
        Some("high")
    );
    assert!(is_base_model(&base_model));
    assert!(!is_base_model(&derived_model));
    assert!(is_system_agent("portico_agent_writer"));
    assert!(!is_system_agent("writer"));

    let filtered = filter_agent_data(&derived_model, &tools_map).unwrap();
    assert_eq!(filtered["id"], json!("derived"));
    assert_eq!(filtered["base_model_id"], json!("base"));
    assert_eq!(filtered["tools"].as_array().unwrap().len(), 2);
    assert_eq!(
        filtered["tool_server_ids"],
        json!(["server:time", "server:custom"])
    );
    assert_eq!(filtered["skill_ids"], json!(["company-knowledge"]));
    assert_eq!(filtered["reasoning_effort"], json!("high"));
    assert_eq!(filtered["created_by_email"], json!("dsantiago@example.invalid"));
    assert_eq!(filtered["creation_source"], json!("local"));
    assert_eq!(filtered["marketplace_relationship"], json!("published"));
    assert_eq!(
        filtered["marketplace_solution_id"],
        json!("solution-derived")
    );

    let filtered_with_prompt = filter_agent_value(&derived_model, true, &tools_map);
    assert_eq!(
        filtered_with_prompt["system_prompt"],
        json!("Act carefully.")
    );
    assert_eq!(
        filtered_with_prompt["created_by_email"],
        json!("dsantiago@example.invalid")
    );
    let filtered_without_prompt = filter_agent_value(&derived_model, false, &tools_map);
    assert!(filtered_without_prompt.get("system_prompt").is_none());

    let model_without_creator = json!({
        "id": "no-creator",
        "name": "No Creator",
        "meta": { "description": "" }
    });
    let filtered_without_creator = filter_agent_value(&model_without_creator, false, &tools_map);
    assert_eq!(filtered_without_creator["created_by_email"], Value::Null);
}

#[test]
fn disabled_model_helpers_cover_recursive_reasons_latest_aliases_and_cycles() {
    let disabled_base = json!({
        "id": "GPT-5.4 pro:latest",
        "name": "GPT-5.4 pro",
        "meta": {
            "disabled": true,
            "disabled_reason": "Temporarily disabled due to high costs"
        }
    });
    let derived_model = json!({
        "id": "agent-using-pro",
        "name": "Agent Using Pro",
        "info": {
            "base_model_id": "GPT-5.4 pro"
        }
    });
    let enabled_model = json!({
        "id": "GPT-5.4",
        "name": "GPT-5.4",
        "is_default": true
    });
    let models = vec![
        disabled_base.clone(),
        derived_model.clone(),
        enabled_model.clone(),
    ];

    assert_eq!(
        find_model_by_id(&models, "GPT-5.4 pro")
            .and_then(|model| model_id(model))
            .unwrap(),
        "GPT-5.4 pro:latest"
    );
    assert_eq!(
        resolve_model_disabled_reason(&derived_model, &models, &mut Vec::new()),
        Some("Temporarily disabled due to high costs".to_string())
    );
    assert_err_contains(
        validate_model_is_enabled(&derived_model, &models),
        "Model 'agent-using-pro' is disabled: Temporarily disabled due to high costs",
    );
    assert_eq!(
        resolve_subagent_model(&models, None).unwrap(),
        "GPT-5.4".to_string()
    );

    let cycle_a = json!({
        "id": "cycle-a",
        "info": { "base_model_id": "cycle-b" }
    });
    let cycle_b = json!({
        "id": "cycle-b",
        "info": { "base_model_id": "cycle-a" }
    });
    let cycled_models = vec![cycle_a.clone(), cycle_b.clone(), enabled_model];
    assert_eq!(
        resolve_model_disabled_reason(&cycle_a, &cycled_models, &mut Vec::new()),
        None
    );
}

#[test]
fn reasoning_validation_helpers_cover_defaults_invalid_values_and_non_reasoning_models() {
    let env = TestEnv::new("reasoning-validation");
    env.write_model_catalog(
        r#"model_list:
  - model_name: "GPT-5.4 pro"
    picker:
      provider: openai
      tier: premium
    model_info:
      supports_reasoning: true
      reasoning_effort_options: ["medium", "high", "max"]
  - model_name: "claude-3.5-haiku"
    picker:
      provider: anthropic
      tier: lightweight
    model_info:
      supports_reasoning: false
"#,
    );
    let base_reasoning_model = json!({
        "id": "gpt-5.4-pro",
        "name": "GPT-5.4 pro",
    });
    let derived_reasoning_model = json!({
        "id": "writer-agent",
        "name": "Writer Agent",
        "base_model_id": "gpt-5.4-pro",
        "info": { "base_model_id": "gpt-5.4-pro" }
    });
    let non_reasoning_model = json!({
        "id": "haiku",
        "name": "claude-3.5-haiku",
    });
    let models = vec![
        base_reasoning_model.clone(),
        derived_reasoning_model.clone(),
        non_reasoning_model.clone(),
    ];

    assert_eq!(
        validate_reasoning_effort_for_model(&derived_reasoning_model, &models, None).unwrap(),
        Some("medium".to_string())
    );
    assert_eq!(
        resolve_runtime_reasoning_effort(&derived_reasoning_model, &models, None, Some("high"),)
            .unwrap(),
        Some("high".to_string())
    );
    assert_err_contains(
        validate_reasoning_effort_for_model(&derived_reasoning_model, &models, Some("low")),
        "Allowed values: medium, high, max",
    );
    assert_err_contains(
        validate_reasoning_effort_for_model(&non_reasoning_model, &models, Some("high")),
        "does not support reasoning_effort",
    );

    let reasoning_listing = filter_agent_data(&base_reasoning_model, &HashMap::new()).unwrap();
    assert_eq!(reasoning_listing["supports_reasoning"], json!(true));
    assert_eq!(reasoning_listing["picker_provider"], json!("openai"));
    assert_eq!(reasoning_listing["picker_tier"], json!("premium"));
    assert_eq!(reasoning_listing["is_local"], json!(false));
    assert_eq!(reasoning_listing["hidden"], json!(false));
    assert_eq!(
        reasoning_listing["reasoning_effort_options"],
        json!(["medium", "high", "max"])
    );
    let non_reasoning_listing = filter_agent_data(&non_reasoning_model, &HashMap::new()).unwrap();
    assert_eq!(non_reasoning_listing["supports_reasoning"], json!(false));
    assert_eq!(non_reasoning_listing["reasoning_effort_options"], json!([]));
    assert_eq!(non_reasoning_listing["picker_provider"], json!("anthropic"));
    assert_eq!(non_reasoning_listing["picker_tier"], json!("lightweight"));

    let local_listing = filter_agent_data(
        &json!({
            "id": "local/qwen",
            "name": "Qwen local",
            "meta": { "local_provider": "lm_studio", "hidden": true }
        }),
        &HashMap::new(),
    )
    .unwrap();
    assert_eq!(local_listing["picker_provider"], json!("local"));
    assert_eq!(local_listing["picker_tier"], Value::Null);
    assert_eq!(local_listing["is_local"], json!(true));
    assert_eq!(local_listing["hidden"], json!(true));

    let unclassified_listing = filter_agent_data(
        &json!({
            "id": "text-embedding-3-large",
            "name": "text-embedding-3-large",
        }),
        &HashMap::new(),
    )
    .unwrap();
    assert_eq!(unclassified_listing["picker_provider"], Value::Null);
    assert_eq!(unclassified_listing["picker_tier"], Value::Null);
    assert_eq!(unclassified_listing["is_local"], json!(false));
    assert_eq!(unclassified_listing["hidden"], json!(true));
}

#[tokio::test]
async fn handle_list_agents_filters_and_formats_server_descriptions() {
    let env = TestEnv::new("list-agents");
    env.set_openwebui_token("token");
    env.write_server_yaml(false, "time", "Time tools", &["convert"]);
    env.write_server_yaml(true, "custom", "Custom tools", &[]);
    let server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/models") => MockResponse::json(json!([
                    {
                        "id": "base",
                        "name": "Base Model",
                        "meta": {
                            "description": "Base description",
                            "toolIds": ["server:time"],
                            "hidden": true,
                            "disabled": true,
                            "disabled_reason": "Temporarily disabled due to high costs"
                        }
                    },
                    {
                        "id": "derived",
                        "name": "Derived Model",
                        "is_active": false,
                        "info": {
                            "base_model_id": "base",
                            "meta": {
                                "toolIds": ["server:custom"],
                                "subagent_skill_ids": ["company-knowledge"],
                                "subagent_reasoning_effort": "high"
                            }
                        },
                        "meta": { "description": "Derived description" }
                    }
                ])),
                ("GET", "/api/v1/tools/") => MockResponse::json(json!([
                    { "id": "server:time", "name": "Time Tool" },
                    { "id": "server:custom", "name": "Custom Tool" }
                ])),
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "not found" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());

    let all_agents = response_payload(
        handle_list_agents(&args(&[("filter_type", json!("all"))]))
            .await
            .unwrap(),
    );
    assert_eq!(all_agents.as_array().unwrap().len(), 2);
    assert_eq!(
        all_agents[0]["tools"][0]["description"],
        json!("Time tools. convert")
    );
    assert_eq!(all_agents[1]["base_model_id"], json!("base"));
    assert_eq!(all_agents[1]["tool_server_ids"], json!(["server:custom"]));
    assert_eq!(all_agents[1]["skill_ids"], json!(["company-knowledge"]));
    assert_eq!(all_agents[1]["reasoning_effort"], json!("high"));

    let base_agents = response_payload(
        handle_list_agents(&args(&[("filter_type", json!("base"))]))
            .await
            .unwrap(),
    );
    assert_eq!(base_agents.as_array().unwrap().len(), 1);
    assert_eq!(base_agents[0]["id"], json!("base"));
    assert_eq!(base_agents[0]["disabled"], json!(true));
    assert_eq!(base_agents[0]["hidden"], json!(true));
    assert_eq!(base_agents[0]["is_local"], json!(false));
    assert_eq!(
        base_agents[0]["disabled_reason"],
        json!("Temporarily disabled due to high costs")
    );

    let derived_agents = response_payload(
        handle_list_agents(&args(&[("filter_type", json!("derived"))]))
            .await
            .unwrap(),
    );
    assert_eq!(derived_agents.as_array().unwrap().len(), 1);
    assert_eq!(derived_agents[0]["id"], json!("derived"));
}

#[tokio::test]
async fn handle_list_agents_retries_transient_models_failure() {
    let env = TestEnv::new("list-agents-models-retry");
    env.set_openwebui_token("token");
    let models_attempts = Arc::new(Mutex::new(0_usize));
    let server = MockServer::start({
        let models_attempts = Arc::clone(&models_attempts);
        move |request| match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/api/models") => {
                let mut attempts = models_attempts
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner());
                *attempts += 1;
                if *attempts == 1 {
                    return MockResponse {
                        status: 503,
                        body: json!({ "error": "models temporarily unavailable" }),
                    };
                }
                MockResponse::json(json!([{
                    "id": "derived",
                    "name": "Derived Model",
                    "base_model_id": "base"
                }]))
            }
            ("GET", "/api/v1/tools/") => MockResponse::json(json!([])),
            _ => MockResponse {
                status: 404,
                body: json!({ "error": "not found" }),
            },
        }
    });
    env.set_openwebui_base_url(server.base_url());

    let agents = response_payload(
        handle_list_agents(&args(&[("filter_type", json!("derived"))]))
            .await
            .unwrap(),
    );

    assert_eq!(agents.as_array().unwrap().len(), 1);
    assert_eq!(agents[0]["id"], json!("derived"));
    assert_eq!(
        *models_attempts
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()),
        2
    );
}

#[tokio::test]
async fn ensure_subagents_folder_creates_when_missing() {
    let env = TestEnv::new("folder-create-missing");
    env.set_openwebui_user_id("cached-user");
    let server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/folders/") => MockResponse::json(json!([])),
                ("POST", "/api/v1/folders/") => MockResponse::json(json!({ "id": "folder-1" })),
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "not found" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());

    assert_eq!(ensure_subagents_folder("token").await.unwrap(), "folder-1");

    let requests = server.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].method, "GET");
    assert_eq!(requests[0].path, "/api/v1/folders/");
    assert_eq!(requests[1].method, "POST");
    assert_eq!(requests[1].path, "/api/v1/folders/");
    let folder_create_body: Value = serde_json::from_str(&requests[1].body).unwrap();
    assert_eq!(folder_create_body["name"], json!("Sub-agents"));
}

#[tokio::test]
async fn ensure_subagents_folder_reuses_single_existing_folder() {
    let env = TestEnv::new("folder-reuse-single");
    env.set_openwebui_user_id("cached-user");
    let server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/folders/") => {
                    MockResponse::json(json!([{ "id": "folder-existing", "name": "Sub-agents" }]))
                }
                ("POST", "/api/v1/folders/") => MockResponse {
                    status: 500,
                    body: json!({ "error": "folder should not be created" }),
                },
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "not found" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());

    assert_eq!(
        ensure_subagents_folder("token").await.unwrap(),
        "folder-existing"
    );

    let requests = server.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "GET");
    assert_eq!(requests[0].path, "/api/v1/folders/");
}

#[tokio::test]
async fn ensure_subagents_folder_prefers_canonical_duplicate_by_oldest_created_at() {
    let env = TestEnv::new("folder-canonical-duplicate");
    env.set_openwebui_user_id("cached-user");
    let server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/folders/") => MockResponse::json(json!([
                    {
                        "id": "folder-a-newer",
                        "name": "Sub-agents",
                        "parent_id": null,
                        "created_at": 20.0
                    },
                    {
                        "id": "folder-z-oldest",
                        "name": "Sub-agents",
                        "parent_id": null,
                        "created_at": 10.0
                    },
                    {
                        "id": "folder-ignore",
                        "name": "Other",
                        "parent_id": null,
                        "created_at": 1.0
                    }
                ])),
                ("POST", "/api/v1/folders/") => MockResponse {
                    status: 500,
                    body: json!({ "error": "folder should not be created" }),
                },
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "not found" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());

    assert_eq!(
        ensure_subagents_folder("token").await.unwrap(),
        "folder-z-oldest"
    );

    let requests = server.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "GET");
    assert_eq!(requests[0].path, "/api/v1/folders/");
}

#[tokio::test]
async fn ensure_subagents_folder_prefers_root_level_over_nested_duplicate() {
    let env = TestEnv::new("folder-root-over-nested");
    env.set_openwebui_user_id("cached-user");
    let server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/folders/") => MockResponse::json(json!([
                    {
                        "id": "folder-a-nested",
                        "name": "Sub-agents",
                        "parent_id": "parent-1",
                        "created_at": 1.0
                    },
                    {
                        "id": "folder-z-root",
                        "name": "Sub-agents",
                        "parent_id": "",
                        "created_at": 99.0
                    }
                ])),
                ("POST", "/api/v1/folders/") => MockResponse {
                    status: 500,
                    body: json!({ "error": "folder should not be created" }),
                },
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "not found" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());

    assert_eq!(
        ensure_subagents_folder("token").await.unwrap(),
        "folder-z-root"
    );

    let requests = server.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "GET");
    assert_eq!(requests[0].path, "/api/v1/folders/");
}

#[tokio::test]
async fn ensure_named_folder_supports_custom_folder_names_and_duplicate_selection() {
    let env = TestEnv::new("folder-custom-name");
    env.set_openwebui_user_id("cached-user");
    let server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/folders/") => MockResponse::json(json!([
                    {
                        "id": "scheduled-nested",
                        "name": "Scheduled Tasks",
                        "parent_id": "parent-1",
                        "created_at": 1.0
                    },
                    {
                        "id": "scheduled-root",
                        "name": "Scheduled Tasks",
                        "parent_id": null,
                        "created_at": 2.0
                    }
                ])),
                ("POST", "/api/v1/folders/") => MockResponse {
                    status: 500,
                    body: json!({ "error": "folder should not be created" }),
                },
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "not found" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());

    assert_eq!(
        ensure_named_folder("token", "Scheduled Tasks")
            .await
            .unwrap(),
        "scheduled-root"
    );

    let requests = server.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "GET");
    assert_eq!(requests[0].path, "/api/v1/folders/");
}

#[tokio::test]
async fn ensure_named_folder_serializes_parallel_creates_for_same_user_and_name() {
    let env = TestEnv::new("folder-parallel-create");
    env.set_openwebui_user_id("cached-user");
    let folder_created = Arc::new(Mutex::new(false));
    let post_count = Arc::new(Mutex::new(0_usize));
    let server = MockServer::start({
        let folder_created = Arc::clone(&folder_created);
        let post_count = Arc::clone(&post_count);
        move |request| match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/api/v1/folders/") => {
                if *folder_created
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                {
                    MockResponse::json(json!([{
                        "id": "scheduled-folder",
                        "name": "Scheduled Tasks",
                        "parent_id": null,
                        "created_at": 1.0
                    }]))
                } else {
                    MockResponse::json(json!([]))
                }
            }
            ("POST", "/api/v1/folders/") => {
                *post_count
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner()) += 1;
                *folder_created
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner()) = true;
                MockResponse::json(json!({ "id": "scheduled-folder" }))
            }
            _ => MockResponse {
                status: 404,
                body: json!({ "error": "not found" }),
            },
        }
    });
    env.set_openwebui_base_url(server.base_url());

    let (first, second, third) = tokio::join!(
        ensure_named_folder("token", "Scheduled Tasks"),
        ensure_named_folder("token", "Scheduled Tasks"),
        ensure_named_folder("token", "Scheduled Tasks"),
    );
    assert_eq!(first.unwrap(), "scheduled-folder");
    assert_eq!(second.unwrap(), "scheduled-folder");
    assert_eq!(third.unwrap(), "scheduled-folder");
    assert_eq!(
        *post_count
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()),
        1
    );

    let requests = server.requests();
    assert_eq!(
        requests
            .iter()
            .filter(|request| request.method == "POST" && request.path == "/api/v1/folders/")
            .count(),
        1
    );
}

#[tokio::test]
async fn ensure_named_folder_recovers_when_create_races_with_existing_folder() {
    let env = TestEnv::new("folder-post-race");
    env.set_openwebui_user_id("cached-user");
    let get_count = Arc::new(Mutex::new(0_usize));
    let server = MockServer::start({
        let get_count = Arc::clone(&get_count);
        move |request| match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/api/v1/folders/") => {
                let mut count = get_count
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner());
                *count += 1;
                if *count == 1 {
                    MockResponse::json(json!([]))
                } else {
                    MockResponse::json(json!([{
                        "id": "folder-existing",
                        "name": "Scheduled Tasks",
                        "parent_id": null,
                        "created_at": 1.0
                    }]))
                }
            }
            ("POST", "/api/v1/folders/") => MockResponse {
                status: 400,
                body: json!({ "detail": "Folder already exists" }),
            },
            _ => MockResponse {
                status: 404,
                body: json!({ "error": "not found" }),
            },
        }
    });
    env.set_openwebui_base_url(server.base_url());

    assert_eq!(
        ensure_named_folder("token", "Scheduled Tasks")
            .await
            .unwrap(),
        "folder-existing"
    );

    let requests = server.requests();
    assert_eq!(
        requests
            .iter()
            .filter(|request| request.method == "GET" && request.path == "/api/v1/folders/")
            .count(),
        2
    );
    assert_eq!(
        requests
            .iter()
            .filter(|request| request.method == "POST" && request.path == "/api/v1/folders/")
            .count(),
        1
    );
}

#[tokio::test]
async fn folder_and_chat_helpers_follow_openwebui_contract() {
    let env = TestEnv::new("folder-chat");
    env.set_openwebui_user_id("cached-user");
    let server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/folders/") => MockResponse::json(json!([])),
                ("POST", "/api/v1/folders/") => MockResponse::json(json!({ "id": "folder-1" })),
                ("POST", "/api/v1/chats/new") => MockResponse::json(json!({ "id": "chat-1" })),
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "not found" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());

    let folder_id = ensure_subagents_folder("token").await.unwrap();
    assert_eq!(folder_id, "folder-1");

    let (chat_id, user_message_id, timestamp) = create_subagent_chat(
        "token",
        "gpt-4.1",
        &Value::String("Investigate this".to_string()),
        &folder_id,
        None,
        Some("high"),
    )
    .await
    .unwrap();
    assert_eq!(chat_id, "chat-1");
    assert!(!user_message_id.is_empty());
    assert!(timestamp > 0);

    let requests = server.requests();
    assert_eq!(requests.len(), 3);
    let folder_create_body: Value = serde_json::from_str(&requests[1].body).unwrap();
    assert_eq!(folder_create_body["name"], json!("Sub-agents"));
    let chat_create_body: Value = serde_json::from_str(&requests[2].body).unwrap();
    assert_eq!(chat_create_body["folder_id"], json!("folder-1"));
    assert_eq!(
        chat_create_body["chat"]["messages"][0]["content"],
        json!("Investigate this")
    );
    assert_eq!(chat_create_body["chat"]["models"][0], json!("gpt-4.1"));
    // The effort is persisted on the chat's own params so a delegated view can
    // read it even when the chat-state-api read is blocked by service ownership.
    assert_eq!(
        chat_create_body["chat"]["params"]["reasoning_effort"],
        json!("high")
    );
    // No metadata supplied: ``chat.meta`` must NOT be present in the
    // payload at all so unrelated callers (interactive sub-agents
    // dispatched by the model) don't accidentally inherit a
    // scheduled-run binding. The gate's metadata reader treats a
    // missing ``meta`` block as "not a scheduled run".
    assert!(
        chat_create_body["chat"].get("meta").is_none(),
        "chat.meta must be absent when no metadata is supplied",
    );
}

#[tokio::test]
async fn create_subagent_chat_attaches_chat_meta_when_metadata_supplied() {
    // Phase 1 of the chip rework: the scheduling daemon stamps the
    // sub-agent chat with run_origin / scheduled_task_id /
    // scheduled_approved_scope so the gate can recognise the chat
    // and bypass chips for in-scope tools. This test pins the
    // contract — if the wire shape ever drifts, the gate will start
    // missing the binding and silently fall back to interactive
    // chips on every scheduled run.
    let env = TestEnv::new("chat-meta");
    env.set_openwebui_user_id("cached-user");
    let server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("POST", "/api/v1/chats/new") => MockResponse::json(json!({ "id": "chat-meta" })),
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "not found" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());

    let metadata = json!({
        "run_origin": "scheduled",
        "scheduled_task_id": "task-1",
        "scheduled_approved_scope": ["slack", "gmail"],
    });
    let (_chat_id, _msg_id, _ts) = create_subagent_chat(
        "token",
        "gpt-4.1",
        &Value::String("scheduled prompt".to_string()),
        "folder-1",
        Some(&metadata),
        None,
    )
    .await
    .unwrap();

    let requests = server.requests();
    assert_eq!(requests.len(), 1);
    let body: Value = serde_json::from_str(&requests[0].body).unwrap();
    let meta = body["chat"]
        .get("meta")
        .expect("chat.meta must be attached when metadata is supplied");
    assert_eq!(meta["run_origin"], json!("scheduled"));
    assert_eq!(meta["scheduled_task_id"], json!("task-1"));
    assert_eq!(meta["scheduled_approved_scope"], json!(["slack", "gmail"]));
}

#[test]
fn subagent_chat_metadata_merges_parent_linkage_with_scheduled_metadata() {
    let base = json!({
        "run_origin": "scheduled",
        "scheduled_task_id": "task-1",
        "scheduled_run_id": "run-1",
    });
    let inheritance = WorkspaceInheritance {
        parent_chat_id: "parent-chat".to_string(),
        root_parent_chat_id: "root-chat".to_string(),
        root_workspace_host_path: PathBuf::from("/tmp/root-chat"),
    };

    let metadata = subagent_chat_metadata(
        Some(&base),
        Some("ignored-parent"),
        Some("tool-call-1"),
        Some(&inheritance),
    )
    .expect("metadata should be emitted");

    assert_eq!(metadata["run_origin"], json!("scheduled"));
    assert_eq!(metadata["scheduled_task_id"], json!("task-1"));
    assert_eq!(metadata["scheduled_run_id"], json!("run-1"));
    assert_eq!(metadata["subagent"]["parent_chat_id"], json!("parent-chat"));
    assert_eq!(
        metadata["subagent"]["root_parent_chat_id"],
        json!("root-chat")
    );
    assert_eq!(
        metadata["subagent"]["parent_tool_call_id"],
        json!("tool-call-1")
    );
}

#[test]
fn subagent_chat_metadata_uses_host_parent_when_workspace_is_absent() {
    let metadata = subagent_chat_metadata(None, Some(" parent-chat "), Some(" tool-call-1 "), None)
        .expect("metadata should be emitted");

    assert_eq!(metadata["subagent"]["parent_chat_id"], json!("parent-chat"));
    assert_eq!(
        metadata["subagent"]["root_parent_chat_id"],
        json!("parent-chat")
    );
    assert_eq!(
        metadata["subagent"]["parent_tool_call_id"],
        json!("tool-call-1")
    );
}

#[tokio::test]
async fn completion_and_existing_folder_helpers_return_finished_content() {
    let env = TestEnv::new("completion");
    env.set_openwebui_user_id("cached-user");
    let responses = Arc::new(Mutex::new(vec![
        json!({
            "chat": {
                "models": ["gpt-4.1"],
                "history": { "messages": {
                    "assistant-1": {
                        "role": "assistant",
                        "lastSentence": "History answer",
                        "done": true
                    }
                }},
                "messages": []
            }
        }),
        json!({
            "chat": {
                "models": ["gpt-4.1-mini"],
                "history": { "messages": {} },
                "messages": [
                    { "role": "user", "content": "hello" },
                    {
                        "role": "assistant",
                        "content": "Message answer",
                        "finishReason": "stop",
                        "usage": { "prompt_tokens": 2 }
                    }
                ]
            }
        }),
    ]));
    let server = MockServer::start({
        let responses = Arc::clone(&responses);
        move |request| match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/api/v1/folders/") => {
                MockResponse::json(json!([{ "id": "folder-existing", "name": "Sub-agents" }]))
            }
            ("GET", "/api/v1/chats/chat-1") => {
                let response = responses
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .remove(0);
                MockResponse::json(response)
            }
            ("GET", "/api/v1/chats/chat-2") => {
                let response = responses
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .remove(0);
                MockResponse::json(response)
            }
            _ => MockResponse {
                status: 404,
                body: json!({ "error": "not found" }),
            },
        }
    });
    env.set_openwebui_base_url(server.base_url());

    assert_eq!(
        ensure_subagents_folder("token").await.unwrap(),
        "folder-existing"
    );

    let history_completion = poll_subagent_completion("token", "chat-1", "Claude Opus 4.6", None)
        .await
        .unwrap();
    assert_eq!(history_completion["model"], json!("gpt-4.1"));
    assert_eq!(history_completion["response"], json!("History answer"));

    let message_completion = poll_subagent_completion("token", "chat-2", "Claude Opus 4.6", None)
        .await
        .unwrap();
    assert_eq!(message_completion["model"], json!("gpt-4.1-mini"));
    assert_eq!(message_completion["response"], json!("Message answer"));
}

#[tokio::test]
async fn helper_and_lookup_paths_cover_auth_fetch_failures_and_agent_views() {
    let env = TestEnv::new("helper-lookups");
    redis_delete(OPENWEBUI_TOKEN_KEY).unwrap();
    redis_delete(OPENWEBUI_USER_KEY).unwrap();
    assert_err_contains(
        get_openwebui_token().await,
        "Open WebUI API token not available in Redis",
    );
    env.set_openwebui_token("   ");
    clear_cached_openwebui_token();
    assert_err_contains(
        get_openwebui_token().await,
        "Open WebUI API token not available in Redis",
    );
    env.set_openwebui_token("token");
    clear_cached_openwebui_token();
    assert_eq!(get_openwebui_token().await.unwrap(), "token");
    env.set_openwebui_user_id("cached-user");
    assert_eq!(get_openwebui_user_id().await.unwrap(), "cached-user");
    env.set_openwebui_user_id("");
    env.write_server_yaml(false, "time", "Time tools", &["convert"]);
    env.write_server_yaml(true, "custom", "Custom tools", &[]);
    let server = MockServer::start(|request| {
        match (request.method.as_str(), request.path.as_str()) {
            ("POST", "/api/v1/portico/auth/service-token") => {
                MockResponse::json(json!({ "token": "fresh-token" }))
            }
            ("GET", "/api/v1/auths/") => MockResponse::json(json!({ "id": "remote-user" })),
            ("GET", "/api/v1/tools/") => MockResponse::json(
                json!([{ "id": "server:time", "name": "Time Tool" }, { "id": "server:custom", "name": "Custom Tool" }, { "id": "standalone", "name": "Standalone Tool" }]),
            ),
            ("GET", "/api/v1/models/model?id=agent-lookup") => MockResponse {
                status: 404,
                body: json!({ "error": "not found" }),
            },
            ("GET", "/api/models/agent%2Dlookup") => MockResponse::json(
                json!({ "id": "agent-lookup", "name": "Lookup Agent", "base_model_id": "base-model", "meta": { "description": "Lookup description", "subagent_tool_server_ids": ["server:time", "missing"], "subagent_skill_ids": ["company-knowledge"], "subagent_reasoning_effort": "max" }, "is_active": false }),
            ),
            ("GET", "/api/v1/models/model?id=agent-system") => MockResponse {
                status: 404,
                body: json!({ "error": "not found" }),
            },
            ("GET", "/api/models/agent%2Dsystem") => MockResponse {
                status: 404,
                body: json!({ "error": "still missing" }),
            },
            ("GET", "/api/v1/models/agent%2Dsystem") => {
                MockResponse::json(json!({ "id": "agent-system", "name": "System Prompt Agent" }))
            }
            ("GET", "/api/v1/models/model?id=missing-agent") => MockResponse {
                status: 404,
                body: json!({ "error": "missing" }),
            },
            ("GET", "/api/models/missing%2Dagent") => MockResponse {
                status: 404,
                body: json!({ "error": "missing" }),
            },
            ("GET", "/api/v1/models/missing%2Dagent") => MockResponse {
                status: 404,
                body: json!({ "error": "missing" }),
            },
            _ => MockResponse {
                status: 404,
                body: json!({ "error": "unexpected" }),
            },
        }
    });
    env.set_openwebui_base_url(server.base_url());
    assert_eq!(get_openwebui_user_id().await.unwrap(), "remote-user");
    assert_eq!(
        redis_get_string(OPENWEBUI_USER_KEY).unwrap().as_deref(),
        Some("remote-user")
    );
    let tools = response_payload(handle_list_available_tools(&Map::new()).await.unwrap());
    assert_eq!(tools[0]["description"], json!("Time tools. convert"));
    assert_eq!(tools[1]["description"], json!("Custom tools"));
    assert!(tools[2].get("description").is_none());
    let agent = response_payload(
        handle_get_agent(&args(&[("model_id", json!("agent-lookup"))]))
            .await
            .unwrap(),
    );
    assert_eq!(agent["base_model_id"], json!("base-model"));
    assert_eq!(agent["description"], json!("Lookup description"));
    assert_eq!(agent["tool_server_ids"], json!(["server:time", "missing"]));
    assert_eq!(agent["skill_ids"], json!(["company-knowledge"]));
    assert_eq!(agent["reasoning_effort"], json!("max"));
    assert_eq!(
        agent["tools"][0]["description"],
        json!("Time tools. convert")
    );
    let prompt = response_payload(
        handle_get_agent_system_prompt(&args(&[("model_id", json!("agent-system"))]))
            .await
            .unwrap(),
    );
    assert_eq!(
        prompt,
        json!({ "model_id": "agent-system", "system_prompt": "" })
    );
    assert_err_contains(
        fetch_model_by_id("missing-agent").await,
        "Could not fetch model missing-agent",
    );
    let paths = server
        .requests()
        .into_iter()
        .map(|request| request.path)
        .collect::<Vec<_>>();
    assert!(paths.contains(&"/api/v1/auths/".to_string()));
    assert!(paths.contains(&"/api/v1/tools/".to_string()));
    assert!(paths.contains(&"/api/models/agent%2Dlookup".to_string()));
    assert!(paths.contains(&"/api/models/agent%2Dsystem".to_string()));
    assert_eq!(
        &paths[7..10],
        [
            "/api/v1/models/agent%2Dsystem",
            "/api/v1/models/model?id=missing-agent",
            "/api/models/missing%2Dagent"
        ]
    );
    assert_eq!(paths[10], "/api/v1/models/missing%2Dagent");
}

#[tokio::test]
async fn get_openwebui_token_accepts_environment_fallback_for_child_process_tests() {
    let _env = TestEnv::new("env-token");
    redis_delete(OPENWEBUI_TOKEN_KEY).unwrap();
    clear_cached_openwebui_token();
    let previous = env::var("OPENWEBUI_API_TOKEN").ok();
    env::set_var("OPENWEBUI_API_TOKEN", "env-token");

    assert_eq!(get_openwebui_token().await.unwrap(), "env-token");

    if let Some(value) = previous {
        env::set_var("OPENWEBUI_API_TOKEN", value);
    } else {
        env::remove_var("OPENWEBUI_API_TOKEN");
    }
}

#[tokio::test]
async fn get_openwebui_token_refreshes_stale_cached_token_via_service_bridge() {
    let env = TestEnv::new("refresh-stale-token");
    let auth_checks = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let auth_checks_clone = Arc::clone(&auth_checks);
    let server =
        MockServer::start(
            move |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/models?") => {
                    if auth_checks_clone.fetch_add(1, Ordering::SeqCst) == 0 {
                        MockResponse {
                            status: 401,
                            body: json!({ "error": "stale token" }),
                        }
                    } else {
                        MockResponse::json(json!({ "data": [{ "id": "Claude Sonnet 4.5" }] }))
                    }
                }
                ("POST", "/api/v1/portico/auth/service-token") => {
                    MockResponse::json(json!({ "token": "fresh-token" }))
                }
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "unexpected" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());
    env.set_openwebui_token("stale-token");

    let models = fetch_all_models().await.unwrap();
    assert_eq!(models.len(), 1);
    assert_eq!(models[0]["id"], json!("Claude Sonnet 4.5"));
    assert_eq!(
        redis_get_string(OPENWEBUI_TOKEN_KEY).unwrap().as_deref(),
        Some("fresh-token")
    );
}

#[tokio::test]
async fn create_agent_posts_expected_payload_and_returns_filtered_value() {
    let env = TestEnv::new("create-agent");
    // Linked skills must exist locally (skill_not_installed_locally gate).
    env.write_skill("company-knowledge", "Company knowledge", &[]);
    env.set_openwebui_token("token");
    env.write_server_yaml(false, "time", "Time tools", &["convert"]);
    let server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/agent-attribution/current-user") => {
                    MockResponse::json(json!({ "email": "dsantiago@example.invalid" }))
                }
                ("POST", "/api/agent-skills/validate-attachable") => {
                    MockResponse::json(json!({ "success": true, "allowed": ["company-knowledge"], "rejected": [] }))
                }
                ("GET", "/api/models?") => {
                    MockResponse::json(json!({ "data": [{ "id": "gpt-4.1", "name": "GPT-4.1" }] }))
                }
                ("POST", "/api/v1/models/create") => MockResponse::json(json!({
                    "id": "data-analyst-marketplace",
                    "name": "Data Analyst",
                    "base_model_id": "gpt-4.1",
                    "meta": {
                        "description": "Investigates datasets",
                        "subagent_tool_server_ids": ["server:time", "missing"],
                        "subagent_skill_ids": ["company-knowledge"],
                        "subagent_created_by_email": "dsantiago@example.invalid",
                        "subagent_creation_source": "local"
                    },
                    "params": { "system": "Be precise." }
                })),
                ("GET", "/api/v1/tools/") => {
                    MockResponse::json(json!([{ "id": "server:time", "name": "Time Tool" }]))
                }
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "unexpected" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());
    let created = response_payload(
        handle_create_agent(&args(&[
            ("name", json!("Data Analyst")),
            ("model_id", json!("data-analyst-marketplace")),
            ("base_model_id", json!("gpt-4.1")),
            ("system_prompt", json!("Be precise.")),
            ("description", json!("Investigates datasets")),
            ("tool_server_ids", json!([" server:time ", "", 99])),
            ("skill_ids", json!(["company-knowledge"])),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(created["id"], json!("data-analyst-marketplace"));
    assert_eq!(created["description"], json!("Investigates datasets"));
    assert_eq!(
        created["tool_server_ids"],
        json!(["server:time", "missing"])
    );
    assert_eq!(created["skill_ids"], json!(["company-knowledge"]));
    assert_eq!(created["reasoning_effort"], Value::Null);
    assert_eq!(created["created_by_email"], json!("dsantiago@example.invalid"));
    assert_eq!(created["creation_source"], json!("local"));
    assert_eq!(
        created["tools"][0]["description"],
        json!("Time tools. convert")
    );
    let create_body: Value = serde_json::from_str(
        &server
            .requests()
            .into_iter()
            .find(|request| request.method == "POST" && request.path == "/api/v1/models/create")
            .expect("expected create request")
            .body,
    )
    .unwrap();
    assert_eq!(create_body["id"], json!("data-analyst-marketplace"));
    assert_eq!(
        create_body["meta"]["description"],
        json!("Investigates datasets")
    );
    assert_eq!(
        create_body["meta"]["profile_image_url"],
        json!("/static/favicon.png")
    );
    assert_eq!(
        create_body["meta"]["subagent_tool_server_ids"],
        json!(["server:time"])
    );
    assert_eq!(
        create_body["meta"]["subagent_skill_ids"],
        json!(["company-knowledge"])
    );
    assert_eq!(
        create_body["meta"]["subagent_created_by_email"],
        json!("dsantiago@example.invalid")
    );
    assert_eq!(
        create_body["meta"]["subagent_creation_source"],
        json!("local")
    );
    assert!(create_body["meta"].get("toolIds").is_none());
    assert_eq!(create_body["params"]["system"], json!("Be precise."));
    assert!(create_body.get("access_control").is_none());
}

#[tokio::test]
async fn copy_agent_preserves_configuration_and_resets_marketplace_provenance() {
    let env = TestEnv::new("copy-agent");
    env.set_openwebui_token("token");
    env.write_model_catalog(
        r#"model_list:
  - model_name: "gpt-4.1"
    model_info:
      supports_reasoning: true
      reasoning_effort_options: ["medium", "high"]
"#,
    );
    env.write_server_yaml(false, "time", "Time tools", &["convert"]);
    let server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/models/model?id=foreign-installed") => MockResponse::json(json!({
                    "id": "foreign-installed",
                    "name": "Foreign Installed",
                    "base_model_id": "gpt-4.1",
                    "meta": {
                        "description": "Installed configuration",
                        "subagent_tool_server_ids": ["server:time"],
                        "subagent_skill_ids": ["company-knowledge"],
                        "subagent_reasoning_effort": "medium",
                        "subagent_created_by_email": "foreign@example.org",
                        "subagent_creation_source": "marketplace",
                        "subagent_marketplace_relationship": "installed",
                        "subagent_marketplace_solution_id": "foreign-solution"
                    },
                    "params": { "system": "Preserve this prompt." }
                })),
                ("GET", "/api/models?") => {
                    MockResponse::json(json!({ "data": [{ "id": "gpt-4.1", "name": "GPT-4.1" }] }))
                }
                ("GET", "/api/agent-attribution/current-user") => {
                    MockResponse::json(json!({ "email": "dsantiago@example.invalid" }))
                }
                ("POST", "/api/v1/models/create") => MockResponse::json(
                    serde_json::from_str(&request.body).expect("invalid copy create payload"),
                ),
                ("GET", "/api/v1/tools/") => {
                    MockResponse::json(json!([{ "id": "server:time", "name": "Time Tool" }]))
                }
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "unexpected" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());

    let copied = response_payload(
        handle_copy_agent(&args(&[
            ("source_agent_id", json!("foreign-installed")),
            ("new_agent_id", json!("editable-copy")),
            ("name", json!("Editable Copy")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(copied["id"], json!("editable-copy"));
    assert_eq!(copied["name"], json!("Editable Copy"));
    assert_eq!(copied["description"], json!("Installed configuration"));
    assert_eq!(copied["tool_server_ids"], json!(["server:time"]));
    assert_eq!(copied["skill_ids"], json!(["company-knowledge"]));
    assert_eq!(copied["reasoning_effort"], json!("medium"));
    assert_eq!(copied["created_by_email"], json!("dsantiago@example.invalid"));
    assert_eq!(copied["creation_source"], json!("local"));
    assert_eq!(copied["marketplace_relationship"], Value::Null);
    assert_eq!(copied["marketplace_solution_id"], Value::Null);
    assert_eq!(copied["is_read_only"], json!(false));

    let create_body: Value = serde_json::from_str(
        &server
            .requests()
            .into_iter()
            .find(|request| request.method == "POST" && request.path == "/api/v1/models/create")
            .expect("expected copy create request")
            .body,
    )
    .unwrap();
    assert_eq!(create_body["id"], json!("editable-copy"));
    assert_eq!(create_body["base_model_id"], json!("gpt-4.1"));
    assert_eq!(
        create_body["params"]["system"],
        json!("Preserve this prompt.")
    );
    assert_eq!(
        create_body["meta"]["subagent_tool_server_ids"],
        json!(["server:time"])
    );
    assert_eq!(
        create_body["meta"]["subagent_skill_ids"],
        json!(["company-knowledge"])
    );
    assert_eq!(
        create_body["meta"]["subagent_reasoning_effort"],
        json!("medium")
    );
    assert_eq!(
        create_body["meta"]["subagent_created_by_email"],
        json!("dsantiago@example.invalid")
    );
    assert_eq!(
        create_body["meta"]["subagent_creation_source"],
        json!("local")
    );
    assert!(create_body["meta"]
        .get("subagent_marketplace_relationship")
        .is_none());
    assert!(create_body["meta"]
        .get("subagent_marketplace_solution_id")
        .is_none());
}

#[tokio::test]
async fn copy_agent_rejects_missing_system_and_base_sources_without_creation() {
    let env = TestEnv::new("copy-agent-invalid");
    env.set_openwebui_token("token");
    let server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/models/model?id=base-model") => {
                    MockResponse::json(json!({ "id": "base-model", "name": "Base Model" }))
                }
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "not found" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());

    let missing = response_payload(
        handle_copy_agent(&args(&[
            ("source_agent_id", json!("missing-agent")),
            ("new_agent_id", json!("copy-one")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(missing["success"], json!(false));
    assert_eq!(missing["code"], json!("agent_not_found"));

    let system = response_payload(
        handle_copy_agent(&args(&[
            ("source_agent_id", json!("portico_agent_writer")),
            ("new_agent_id", json!("copy-two")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(system["success"], json!(false));
    assert_eq!(system["code"], json!("system_agent_read_only"));

    let base = response_payload(
        handle_copy_agent(&args(&[
            ("source_agent_id", json!("base-model")),
            ("new_agent_id", json!("copy-three")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(base["success"], json!(false));
    assert_eq!(base["code"], json!("base_model_not_copyable"));
    assert!(!server
        .requests()
        .iter()
        .any(|request| request.method == "POST" && request.path == "/api/v1/models/create"));
}

#[tokio::test]
async fn create_agent_ignores_spoofed_creator_and_uses_electron_identity() {
    let env = TestEnv::new("create-agent-created-by-email");
    env.set_openwebui_token("token");
    let server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/agent-attribution/current-user") => {
                    MockResponse::json(json!({ "email": " dsantiago@example.invalid " }))
                }
                ("GET", "/api/models?") => {
                    MockResponse::json(json!({ "data": [{ "id": "gpt-4.1", "name": "GPT-4.1" }] }))
                }
                ("POST", "/api/v1/models/create") => MockResponse::json(
                    serde_json::from_str(&request.body).expect("invalid create payload"),
                ),
                ("GET", "/api/v1/tools/") => MockResponse::json(json!([])),
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "unexpected" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());
    let created = response_payload(
        handle_create_agent(&args(&[
            ("name", json!("Dsantiago Agent")),
            ("model_id", json!("dsantiago-agent")),
            ("base_model_id", json!("gpt-4.1")),
            ("system_prompt", json!("Be precise.")),
            ("created_by_email", json!("attacker@example.com")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(created["created_by_email"], json!("dsantiago@example.invalid"));
    let create_body: Value = serde_json::from_str(
        &server
            .requests()
            .into_iter()
            .find(|request| request.method == "POST" && request.path == "/api/v1/models/create")
            .expect("expected create request")
            .body,
    )
    .unwrap();
    // The legacy caller value is ignored; the exact trimmed Electron session
    // identity is authoritative.
    assert_eq!(
        create_body["meta"]["subagent_created_by_email"],
        json!("dsantiago@example.invalid")
    );
    assert_eq!(
        create_body["meta"]["subagent_creation_source"],
        json!("local")
    );
}

#[tokio::test]
async fn create_agent_fails_before_create_when_electron_identity_is_unavailable() {
    let env = TestEnv::new("create-agent-created-by-email-unavailable");
    env.set_openwebui_token("token");
    let server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/agent-attribution/current-user") => MockResponse {
                    status: 503,
                    body: json!({ "code": "missing_user_identity" }),
                },
                ("GET", "/api/models?") => {
                    MockResponse::json(json!({ "data": [{ "id": "gpt-4.1", "name": "GPT-4.1" }] }))
                }
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "unexpected" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());
    assert_err_contains(
        handle_create_agent(&args(&[
            ("name", json!("No Attribution Agent")),
            ("model_id", json!("no-attribution-agent")),
            ("base_model_id", json!("gpt-4.1")),
            ("system_prompt", json!("Be precise.")),
        ]))
        .await,
        "GET /api/agent-attribution/current-user returned error",
    );
    assert!(!server
        .requests()
        .iter()
        .any(|request| request.method == "POST" && request.path == "/api/v1/models/create"));
}

#[tokio::test]
async fn create_agent_rejects_a_non_email_electron_identity_before_create() {
    let env = TestEnv::new("create-agent-created-by-handle");
    env.set_openwebui_token("token");
    let server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/agent-attribution/current-user") => {
                    MockResponse::json(json!({ "email": "dsantiago" }))
                }
                ("GET", "/api/models?") => {
                    MockResponse::json(json!({ "data": [{ "id": "gpt-4.1", "name": "GPT-4.1" }] }))
                }
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "unexpected" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());

    assert_err_contains(
        handle_create_agent(&args(&[
            ("name", json!("Handle Agent")),
            ("model_id", json!("handle-agent")),
            ("base_model_id", json!("gpt-4.1")),
            ("system_prompt", json!("Be precise.")),
        ]))
        .await,
        "authenticated user email is unavailable",
    );
    assert!(!server
        .requests()
        .iter()
        .any(|request| request.method == "POST" && request.path == "/api/v1/models/create"));
}

#[tokio::test]
async fn reconcile_preserves_foreign_installed_meta_when_unlinked() {
    // 2026-08-14 Smart Slides incident: a pruned sidecar link made the
    // reconcile's None-arm scrub delete subagent_marketplace_relationship +
    // subagent_marketplace_solution_id from a FOREIGN installed copy — the
    // only surviving copy of the solution id once the listing was deleted.
    // Unlinked foreign installed copies must keep their marketplace metas.
    let env = TestEnv::new("reconcile-preserves-foreign-installed-meta");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("service-user");

    let listings = json!({
        "data": [
            { "id": "gpt-4.1", "name": "GPT-4.1" },
            { "id": "stranded-foreign-install", "info": { "base_model_id": "gpt-4.1" } }
        ]
    });
    let models = Arc::new(Mutex::new(std::collections::HashMap::from([(
        "stranded-foreign-install".to_string(),
        json!({
            "id": "stranded-foreign-install",
            "base_model_id": "gpt-4.1",
            "meta": {
                "subagent_created_by_email": "zstevens",
                "subagent_creation_source": "marketplace",
                "subagent_marketplace_relationship": "installed",
                "subagent_marketplace_solution_id": "solution-stranded"
            }
        }),
    )])));
    let updates = Arc::new(Mutex::new(Vec::<Value>::new()));
    let models_for_server = Arc::clone(&models);
    let updates_for_server = Arc::clone(&updates);
    let server = MockServer::start(move |request| {
        if request.method == "GET" && request.path == "/api/agent-attribution/context" {
            return MockResponse::json(json!({
                "email": "dsantiago@example.invalid",
                "links": {}
            }));
        }
        if request.method == "GET" && request.path == "/api/models?" {
            return MockResponse::json(listings.clone());
        }
        if request.method == "GET" && request.path.starts_with("/api/v1/models/model?id=") {
            let id = request
                .path
                .strip_prefix("/api/v1/models/model?id=")
                .unwrap_or_default();
            return models_for_server
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .get(id)
                .cloned()
                .map(MockResponse::json)
                .unwrap_or(MockResponse {
                    status: 404,
                    body: json!({ "error": "not found" }),
                });
        }
        if request.method == "POST" && request.path.starts_with("/api/v1/models/model/update?id=") {
            let body: Value =
                serde_json::from_str(&request.body).expect("invalid model update body");
            updates_for_server
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .push(body.clone());
            return MockResponse::json(body);
        }
        MockResponse {
            status: 404,
            body: json!({ "error": "unexpected" }),
        }
    });
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());

    let result = response_payload(
        handle_reconcile_agent_attribution(&Map::new())
            .await
            .unwrap(),
    );
    // Metas already match the preserved values -> no write at all.
    assert_eq!(result["unchanged_ids"], json!(["stranded-foreign-install"]));
    assert_eq!(result["repaired_ids"], json!([]));
    assert_eq!(result["failures"], json!([]));
    let updated = updates
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone();
    assert!(
        updated.is_empty(),
        "no model update should fire for a preserved foreign install"
    );
}

#[tokio::test]
async fn reconcile_agent_attribution_matches_current_migration_fixture_and_is_idempotent() {
    let env = TestEnv::new("reconcile-agent-attribution-migration");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("service-user");

    let listings = json!({
        "data": [
            { "id": "gpt-4.1", "name": "GPT-4.1" },
            { "id": "portico_agent_mcp-context-resolver", "info": { "base_model_id": "gpt-4.1" } },
            { "id": "chuckles", "info": { "base_model_id": "gpt-4.1" } },
            { "id": "research-pro", "info": { "base_model_id": "gpt-4.1" } },
            { "id": "everyday-helper", "info": { "base_model_id": "gpt-4.1" } },
            { "id": "linked-install-null", "info": { "base_model_id": "gpt-4.1" } },
            { "id": "already-attributed", "info": { "base_model_id": "gpt-4.1" } },
            { "id": "formerly-published", "info": { "base_model_id": "gpt-4.1" } },
            { "id": "market-agent", "info": { "base_model_id": "gpt-4.1" } }
        ]
    });
    let models = Arc::new(Mutex::new(std::collections::HashMap::from([
        (
            "chuckles".to_string(),
            json!({ "id": "chuckles", "base_model_id": "gpt-4.1", "meta": {} }),
        ),
        (
            "research-pro".to_string(),
            json!({
                "id": "research-pro",
                "base_model_id": "gpt-4.1",
                "meta": { "subagent_created_by_email": "   " }
            }),
        ),
        (
            "everyday-helper".to_string(),
            json!({ "id": "everyday-helper", "base_model_id": "gpt-4.1", "meta": {} }),
        ),
        (
            "linked-install-null".to_string(),
            json!({ "id": "linked-install-null", "base_model_id": "gpt-4.1", "meta": {} }),
        ),
        (
            "already-attributed".to_string(),
            json!({
                "id": "already-attributed",
                "base_model_id": "gpt-4.1",
                "meta": { "subagent_created_by_email": "owner@example.invalid" }
            }),
        ),
        (
            "formerly-published".to_string(),
            json!({
                "id": "formerly-published",
                "base_model_id": "gpt-4.1",
                "meta": {
                    "subagent_created_by_email": "dsantiago@example.invalid",
                    "subagent_creation_source": "local",
                    "subagent_marketplace_relationship": "published",
                    "subagent_marketplace_solution_id": "solution-removed"
                }
            }),
        ),
        (
            "market-agent".to_string(),
            json!({
                "id": "market-agent",
                "base_model_id": "gpt-4.1",
                "meta": {
                    "subagent_created_by_email": "dsantiago@example.invalid",
                    "subagent_creation_source": "local"
                }
            }),
        ),
    ])));
    let updates = Arc::new(Mutex::new(Vec::<Value>::new()));
    let pending = Arc::new(AtomicBool::new(true));
    let models_for_server = Arc::clone(&models);
    let updates_for_server = Arc::clone(&updates);
    let pending_for_server = Arc::clone(&pending);
    let server = MockServer::start(move |request| {
        if request.method == "GET" && request.path == "/api/agent-attribution/context" {
            return MockResponse::json(json!({
                "email": "dsantiago@example.invalid",
                "links": {
                    "everyday-helper": {
                        "solutionId": "solution-everyday",
                        "relationship": "unknown",
                        "authorIdentity": null,
                        "attributionPending": false
                    },
                    "linked-install-null": {
                        "solutionId": "solution-linked",
                        "relationship": "installed",
                        "authorIdentity": "publisher",
                        "attributionPending": false
                    },
                    "market-agent": {
                        "solutionId": "solution-market",
                        "relationship": "installed",
                        "authorIdentity": "OriginalPublisher",
                        "attributionPending": pending_for_server.load(Ordering::SeqCst)
                    }
                }
            }));
        }
        if request.method == "GET" && request.path == "/api/models?" {
            return MockResponse::json(listings.clone());
        }
        if request.method == "GET" && request.path.starts_with("/api/v1/models/model?id=") {
            let id = request
                .path
                .strip_prefix("/api/v1/models/model?id=")
                .unwrap_or_default();
            return models_for_server
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .get(id)
                .cloned()
                .map(MockResponse::json)
                .unwrap_or(MockResponse {
                    status: 404,
                    body: json!({ "error": "not found" }),
                });
        }
        if request.method == "POST" && request.path.starts_with("/api/v1/models/model/update?id=") {
            let body: Value =
                serde_json::from_str(&request.body).expect("invalid model update body");
            let id = body["id"]
                .as_str()
                .expect("updated model missing id")
                .to_string();
            updates_for_server
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .push(body.clone());
            models_for_server
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .insert(id, body.clone());
            return MockResponse::json(body);
        }
        MockResponse {
            status: 404,
            body: json!({ "error": "unexpected" }),
        }
    });
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());

    let first = response_payload(
        handle_reconcile_agent_attribution(&Map::new())
            .await
            .unwrap(),
    );
    assert_eq!(
        first["repaired_ids"],
        json!([
            "already-attributed",
            "chuckles",
            "formerly-published",
            "market-agent",
            "research-pro"
        ])
    );
    assert_eq!(
        first["creator_backfilled_ids"],
        json!(["chuckles", "research-pro"])
    );
    assert_eq!(
        first["source_backfilled_ids"],
        json!(["already-attributed"])
    );
    assert_eq!(first["marketplace_attributed_ids"], json!(["market-agent"]));
    assert_eq!(first["marketplace_adopted_ids"], json!([]));
    assert_eq!(first["finalized_pending_ids"], json!(["market-agent"]));
    assert_eq!(
        first["skipped_linked_ids"],
        json!(["everyday-helper", "linked-install-null"])
    );
    assert_eq!(
        first["missing_creator_linked_ids"],
        json!(["everyday-helper", "linked-install-null"])
    );
    assert_eq!(first["failures"], json!([]));
    assert_eq!(first["checked"], json!(9));
    assert_eq!(first["skipped_base_ids"], json!(["gpt-4.1"]));
    assert_eq!(
        first["skipped_system_ids"],
        json!(["portico_agent_mcp-context-resolver"])
    );

    let updated = updates
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone();
    assert_eq!(updated.len(), 5);
    let by_id = updated
        .into_iter()
        .map(|model| (model["id"].as_str().unwrap().to_string(), model))
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(
        by_id["chuckles"]["meta"]["subagent_created_by_email"],
        json!("dsantiago@example.invalid")
    );
    assert_eq!(
        by_id["research-pro"]["meta"]["subagent_created_by_email"],
        json!("dsantiago@example.invalid")
    );
    assert_eq!(
        by_id["already-attributed"]["meta"]["subagent_created_by_email"],
        json!("owner@example.invalid")
    );
    assert_eq!(
        by_id["already-attributed"]["meta"]["subagent_creation_source"],
        json!("local")
    );
    assert_eq!(
        by_id["formerly-published"]["meta"]["subagent_created_by_email"],
        json!("dsantiago@example.invalid")
    );
    assert_eq!(
        by_id["formerly-published"]["meta"]["subagent_creation_source"],
        json!("local")
    );
    assert!(by_id["formerly-published"]["meta"]
        .get("subagent_marketplace_relationship")
        .is_none());
    assert!(by_id["formerly-published"]["meta"]
        .get("subagent_marketplace_solution_id")
        .is_none());
    assert_eq!(
        by_id["market-agent"]["meta"]["subagent_created_by_email"],
        json!("OriginalPublisher")
    );
    assert_eq!(
        by_id["market-agent"]["meta"]["subagent_creation_source"],
        json!("marketplace")
    );
    assert_eq!(
        by_id["market-agent"]["meta"]["subagent_marketplace_relationship"],
        json!("installed")
    );

    pending.store(false, Ordering::SeqCst);
    updates
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clear();
    let second = response_payload(
        handle_reconcile_agent_attribution(&Map::new())
            .await
            .unwrap(),
    );
    assert_eq!(second["repaired_ids"], json!([]));
    assert_eq!(second["creator_backfilled_ids"], json!([]));
    assert_eq!(second["source_backfilled_ids"], json!([]));
    assert_eq!(second["marketplace_adopted_ids"], json!([]));
    assert_eq!(
        updates
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .len(),
        0
    );
}

#[tokio::test]
async fn reconcile_agent_attribution_keeps_an_absent_pending_install_retryable() {
    let env = TestEnv::new("reconcile-agent-attribution-pending-model-missing");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("service-user");
    let server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/agent-attribution/context") => MockResponse::json(json!({
                    "email": "dsantiago@example.invalid",
                    "links": {
                        "reserved-market-agent": {
                            "solutionId": "solution-market",
                            "relationship": "installed",
                            "authorIdentity": "OriginalPublisher",
                            "attributionPending": true
                        }
                    }
                })),
                ("GET", "/api/models?") => MockResponse::json(json!({ "data": [] })),
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "unexpected" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());

    let result = response_payload(
        handle_reconcile_agent_attribution(&Map::new())
            .await
            .unwrap(),
    );
    assert_eq!(result["repaired_ids"], json!([]));
    assert_eq!(result["finalized_pending_ids"], json!([]));
    assert_eq!(result["failures"][0]["id"], json!("reserved-market-agent"));
    assert!(result["failures"][0]["error"]
        .as_str()
        .unwrap_or_default()
        .contains("not present"));
}

#[tokio::test]
async fn reconcile_agent_attribution_fails_closed_before_model_writes_on_bad_registry() {
    let env = TestEnv::new("reconcile-agent-attribution-bad-registry");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("service-user");
    let server = MockServer::start(|request| {
        if request.method == "GET" && request.path == "/api/agent-attribution/context" {
            return MockResponse {
                status: 500,
                body: json!({ "code": "agent_link_registry_unreadable" }),
            };
        }
        MockResponse {
            status: 500,
            body: json!({ "error": "must not be reached" }),
        }
    });
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());

    assert_err_contains(
        handle_reconcile_agent_attribution(&Map::new()).await,
        "GET /api/agent-attribution/context returned error",
    );
    assert!(!server
        .requests()
        .iter()
        .any(|request| request.method == "POST"));
}

#[tokio::test]
async fn reconcile_agent_attribution_retries_only_partial_failures() {
    let env = TestEnv::new("reconcile-agent-attribution-partial-retry");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("service-user");
    let models = Arc::new(Mutex::new(std::collections::HashMap::from([
        (
            "chuckles".to_string(),
            json!({ "id": "chuckles", "base_model_id": "base", "meta": {} }),
        ),
        (
            "research-pro".to_string(),
            json!({ "id": "research-pro", "base_model_id": "base", "meta": {} }),
        ),
    ])));
    let fail_research_once = Arc::new(AtomicBool::new(true));
    let successful_updates = Arc::new(Mutex::new(Vec::<String>::new()));
    let models_for_server = Arc::clone(&models);
    let fail_for_server = Arc::clone(&fail_research_once);
    let updates_for_server = Arc::clone(&successful_updates);
    let server = MockServer::start(move |request| {
        if request.method == "GET" && request.path == "/api/agent-attribution/context" {
            return MockResponse::json(json!({
                "email": "dsantiago@example.invalid",
                "links": {}
            }));
        }
        if request.method == "GET" && request.path == "/api/models?" {
            return MockResponse::json(json!({
                "data": [
                    { "id": "chuckles", "info": { "base_model_id": "base" } },
                    { "id": "research-pro", "info": { "base_model_id": "base" } }
                ]
            }));
        }
        if request.method == "GET" && request.path.starts_with("/api/v1/models/model?id=") {
            let id = request
                .path
                .strip_prefix("/api/v1/models/model?id=")
                .unwrap_or_default();
            return models_for_server
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .get(id)
                .cloned()
                .map(MockResponse::json)
                .unwrap_or(MockResponse {
                    status: 404,
                    body: json!({ "error": "not found" }),
                });
        }
        if request.method == "POST" && request.path.starts_with("/api/v1/models/model/update?id=") {
            let body: Value = serde_json::from_str(&request.body).expect("invalid update body");
            let id = body["id"].as_str().expect("missing model id").to_string();
            if id == "research-pro" && fail_for_server.swap(false, Ordering::SeqCst) {
                return MockResponse {
                    status: 500,
                    body: json!({ "error": "temporary write failure" }),
                };
            }
            models_for_server
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .insert(id.clone(), body.clone());
            updates_for_server
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .push(id);
            return MockResponse::json(body);
        }
        MockResponse {
            status: 404,
            body: json!({ "error": "unexpected" }),
        }
    });
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());

    let first = response_payload(
        handle_reconcile_agent_attribution(&Map::new())
            .await
            .unwrap(),
    );
    assert_eq!(first["repaired_ids"], json!(["chuckles"]));
    assert_eq!(first["failures"][0]["id"], json!("research-pro"));

    let second = response_payload(
        handle_reconcile_agent_attribution(&Map::new())
            .await
            .unwrap(),
    );
    assert_eq!(second["repaired_ids"], json!(["research-pro"]));
    assert_eq!(second["failures"], json!([]));
    assert_eq!(
        successful_updates
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .as_slice(),
        ["chuckles", "research-pro"]
    );
}

#[tokio::test]
async fn reconcile_agent_attribution_backfills_missing_source_for_pre_provenance_agents() {
    let env = TestEnv::new("reconcile-agent-attribution-source-backfill");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("service-user");
    let models = Arc::new(Mutex::new(std::collections::HashMap::from([
        (
            "custom-helper-agent".to_string(),
            json!({
                "id": "custom-helper-agent",
                "base_model_id": "gpt-4.1",
                "meta": { "subagent_created_by_email": "dsantiago@example.invalid" }
            }),
        ),
        (
            "legacy-third-party".to_string(),
            json!({
                "id": "legacy-third-party",
                "base_model_id": "gpt-4.1",
                "meta": { "subagent_created_by_email": "colleague@example.invalid" }
            }),
        ),
    ])));
    let updates = Arc::new(Mutex::new(Vec::<Value>::new()));
    let models_for_server = Arc::clone(&models);
    let updates_for_server = Arc::clone(&updates);
    let server = MockServer::start(move |request| {
        if request.method == "GET" && request.path == "/api/agent-attribution/context" {
            return MockResponse::json(json!({
                "email": "dsantiago@example.invalid",
                "links": {}
            }));
        }
        if request.method == "GET" && request.path == "/api/models?" {
            return MockResponse::json(json!({
                "data": [
                    { "id": "custom-helper-agent", "info": { "base_model_id": "gpt-4.1" } },
                    { "id": "legacy-third-party", "info": { "base_model_id": "gpt-4.1" } }
                ]
            }));
        }
        if request.method == "GET" && request.path.starts_with("/api/v1/models/model?id=") {
            let id = request
                .path
                .strip_prefix("/api/v1/models/model?id=")
                .unwrap_or_default();
            return models_for_server
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .get(id)
                .cloned()
                .map(MockResponse::json)
                .unwrap_or(MockResponse {
                    status: 404,
                    body: json!({ "error": "not found" }),
                });
        }
        if request.method == "POST" && request.path.starts_with("/api/v1/models/model/update?id=") {
            let body: Value = serde_json::from_str(&request.body).expect("invalid update body");
            let id = body["id"].as_str().expect("missing model id").to_string();
            updates_for_server
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .push(body.clone());
            models_for_server
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .insert(id, body.clone());
            return MockResponse::json(body);
        }
        MockResponse {
            status: 404,
            body: json!({ "error": "unexpected" }),
        }
    });
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());

    let first = response_payload(
        handle_reconcile_agent_attribution(&Map::new())
            .await
            .unwrap(),
    );
    assert_eq!(
        first["repaired_ids"],
        json!(["custom-helper-agent", "legacy-third-party"])
    );
    assert_eq!(
        first["source_backfilled_ids"],
        json!(["custom-helper-agent", "legacy-third-party"])
    );
    assert_eq!(first["creator_backfilled_ids"], json!([]));
    assert_eq!(first["marketplace_adopted_ids"], json!([]));
    assert_eq!(first["failures"], json!([]));

    let updated = updates
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone();
    assert_eq!(updated.len(), 2);
    let by_id = updated
        .into_iter()
        .map(|model| (model["id"].as_str().unwrap().to_string(), model))
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(
        by_id["custom-helper-agent"]["meta"]["subagent_creation_source"],
        json!("local")
    );
    assert_eq!(
        by_id["custom-helper-agent"]["meta"]["subagent_created_by_email"],
        json!("dsantiago@example.invalid")
    );
    assert_eq!(
        by_id["legacy-third-party"]["meta"]["subagent_creation_source"],
        json!("local")
    );
    assert_eq!(
        by_id["legacy-third-party"]["meta"]["subagent_created_by_email"],
        json!("colleague@example.invalid")
    );

    updates
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clear();
    let second = response_payload(
        handle_reconcile_agent_attribution(&Map::new())
            .await
            .unwrap(),
    );
    assert_eq!(second["repaired_ids"], json!([]));
    assert_eq!(second["source_backfilled_ids"], json!([]));
    assert_eq!(
        updates
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .len(),
        0
    );
}

#[tokio::test]
async fn reconcile_agent_attribution_adopts_only_self_authored_stranded_marketplace_copies() {
    let env = TestEnv::new("reconcile-agent-attribution-stranded-adoption");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("service-user");
    let models = Arc::new(Mutex::new(std::collections::HashMap::from([
        (
            "everyday-stranded".to_string(),
            json!({
                "id": "everyday-stranded",
                "base_model_id": "gpt-4.1",
                "meta": {
                    "subagent_created_by_email": "dsantiago@example.invalid",
                    "subagent_creation_source": "marketplace"
                }
            }),
        ),
        (
            "handle-creator".to_string(),
            json!({
                "id": "handle-creator",
                "base_model_id": "gpt-4.1",
                "meta": {
                    "subagent_created_by_email": "dsantiago",
                    "subagent_creation_source": "marketplace"
                }
            }),
        ),
        (
            "case-creator".to_string(),
            json!({
                "id": "case-creator",
                "base_model_id": "gpt-4.1",
                "meta": {
                    "subagent_created_by_email": "test@example.invalid",
                    "subagent_creation_source": "marketplace"
                }
            }),
        ),
        (
            "third-party-stranded".to_string(),
            json!({
                "id": "third-party-stranded",
                "base_model_id": "gpt-4.1",
                "meta": {
                    "subagent_created_by_email": "someone-else@example.invalid",
                    "subagent_creation_source": "marketplace"
                }
            }),
        ),
    ])));
    let updates = Arc::new(Mutex::new(Vec::<Value>::new()));
    let models_for_server = Arc::clone(&models);
    let updates_for_server = Arc::clone(&updates);
    let server = MockServer::start(move |request| {
        if request.method == "GET" && request.path == "/api/agent-attribution/context" {
            return MockResponse::json(json!({
                "email": "dsantiago@example.invalid",
                "links": {}
            }));
        }
        if request.method == "GET" && request.path == "/api/models?" {
            return MockResponse::json(json!({
                "data": [
                    { "id": "everyday-stranded", "info": { "base_model_id": "gpt-4.1" } },
                    { "id": "handle-creator", "info": { "base_model_id": "gpt-4.1" } },
                    { "id": "case-creator", "info": { "base_model_id": "gpt-4.1" } },
                    { "id": "third-party-stranded", "info": { "base_model_id": "gpt-4.1" } }
                ]
            }));
        }
        if request.method == "GET" && request.path.starts_with("/api/v1/models/model?id=") {
            let id = request
                .path
                .strip_prefix("/api/v1/models/model?id=")
                .unwrap_or_default();
            return models_for_server
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .get(id)
                .cloned()
                .map(MockResponse::json)
                .unwrap_or(MockResponse {
                    status: 404,
                    body: json!({ "error": "not found" }),
                });
        }
        if request.method == "POST" && request.path.starts_with("/api/v1/models/model/update?id=") {
            let body: Value = serde_json::from_str(&request.body).expect("invalid update body");
            let id = body["id"].as_str().expect("missing model id").to_string();
            updates_for_server
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .push(body.clone());
            models_for_server
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .insert(id, body.clone());
            return MockResponse::json(body);
        }
        MockResponse {
            status: 404,
            body: json!({ "error": "unexpected" }),
        }
    });
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());

    let first = response_payload(
        handle_reconcile_agent_attribution(&Map::new())
            .await
            .unwrap(),
    );
    assert_eq!(
        first["marketplace_adopted_ids"],
        json!(["case-creator", "everyday-stranded", "handle-creator"])
    );
    assert_eq!(
        first["repaired_ids"],
        json!(["case-creator", "everyday-stranded", "handle-creator"])
    );
    assert_eq!(first["source_backfilled_ids"], json!([]));
    assert_eq!(first["failures"], json!([]));
    assert!(first["unchanged_ids"]
        .as_array()
        .unwrap()
        .contains(&json!("third-party-stranded")));

    let updated = updates
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone();
    assert_eq!(updated.len(), 3);
    for model in &updated {
        assert_eq!(model["meta"]["subagent_creation_source"], json!("local"));
        assert!(model["meta"]
            .get("subagent_marketplace_relationship")
            .is_none());
        assert!(model["meta"]
            .get("subagent_marketplace_solution_id")
            .is_none());
    }
    let by_id = updated
        .into_iter()
        .map(|model| (model["id"].as_str().unwrap().to_string(), model))
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(
        by_id["everyday-stranded"]["meta"]["subagent_created_by_email"],
        json!("dsantiago@example.invalid")
    );
    assert_eq!(
        by_id["handle-creator"]["meta"]["subagent_created_by_email"],
        json!("dsantiago")
    );
    assert_eq!(
        by_id["case-creator"]["meta"]["subagent_created_by_email"],
        json!("test@example.invalid")
    );

    updates
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clear();
    let second = response_payload(
        handle_reconcile_agent_attribution(&Map::new())
            .await
            .unwrap(),
    );
    assert_eq!(second["repaired_ids"], json!([]));
    assert_eq!(second["marketplace_adopted_ids"], json!([]));
    assert_eq!(
        updates
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .len(),
        0
    );
}

#[tokio::test]
async fn reconcile_agent_attribution_never_adopts_a_copy_that_is_mid_install_or_relinked() {
    let env = TestEnv::new("reconcile-agent-attribution-adoption-guards");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("service-user");
    let models = Arc::new(Mutex::new(std::collections::HashMap::from([
        (
            "freshly-stranded".to_string(),
            json!({
                "id": "freshly-stranded",
                "base_model_id": "gpt-4.1",
                "meta": {
                    "subagent_created_by_email": "dsantiago@example.invalid",
                    "subagent_creation_source": "marketplace",
                    "subagent_marketplace_relationship": "installed",
                    "subagent_marketplace_solution_id": "solution-fresh"
                }
            }),
        ),
        (
            "relinked-copy".to_string(),
            json!({
                "id": "relinked-copy",
                "base_model_id": "gpt-4.1",
                "meta": {
                    "subagent_created_by_email": "dsantiago@example.invalid",
                    "subagent_creation_source": "marketplace"
                }
            }),
        ),
    ])));
    let updates = Arc::new(Mutex::new(Vec::<Value>::new()));
    let context_calls = Arc::new(AtomicUsize::new(0));
    let models_for_server = Arc::clone(&models);
    let updates_for_server = Arc::clone(&updates);
    let context_calls_for_server = Arc::clone(&context_calls);
    let server = MockServer::start(move |request| {
        if request.method == "GET" && request.path == "/api/agent-attribution/context" {
            // First read (the reconcile's opening snapshot) shows no links;
            // every later read shows relinked-copy re-linked, so the adoption
            // re-check must observe it and refuse the flip.
            let call_index = context_calls_for_server.fetch_add(1, Ordering::SeqCst);
            if call_index == 0 {
                return MockResponse::json(json!({
                    "email": "dsantiago@example.invalid",
                    "links": {}
                }));
            }
            return MockResponse::json(json!({
                "email": "dsantiago@example.invalid",
                "links": {
                    "relinked-copy": {
                        "solutionId": "solution-relinked",
                        "relationship": "installed",
                        "authorIdentity": "dsantiago",
                        "attributionPending": false
                    }
                }
            }));
        }
        if request.method == "GET" && request.path == "/api/models?" {
            return MockResponse::json(json!({
                "data": [
                    { "id": "freshly-stranded", "info": { "base_model_id": "gpt-4.1" } },
                    { "id": "relinked-copy", "info": { "base_model_id": "gpt-4.1" } }
                ]
            }));
        }
        if request.method == "GET" && request.path.starts_with("/api/v1/models/model?id=") {
            let id = request
                .path
                .strip_prefix("/api/v1/models/model?id=")
                .unwrap_or_default();
            return models_for_server
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .get(id)
                .cloned()
                .map(MockResponse::json)
                .unwrap_or(MockResponse {
                    status: 404,
                    body: json!({ "error": "not found" }),
                });
        }
        if request.method == "POST" && request.path.starts_with("/api/v1/models/model/update?id=") {
            let body: Value = serde_json::from_str(&request.body).expect("invalid update body");
            let id = body["id"].as_str().expect("missing model id").to_string();
            updates_for_server
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .push(body.clone());
            models_for_server
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .insert(id, body.clone());
            return MockResponse::json(body);
        }
        MockResponse {
            status: 404,
            body: json!({ "error": "unexpected" }),
        }
    });
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());

    // Pass 1: freshly-stranded still carries relationship/solution metas (as a
    // finalized install always does), so the metas gate blocks adoption and the
    // pre-existing strip runs instead; relinked-copy passes the metas gate but
    // the fresh registry re-check sees the new link and refuses.
    let first = response_payload(
        handle_reconcile_agent_attribution(&Map::new())
            .await
            .unwrap(),
    );
    assert_eq!(first["marketplace_adopted_ids"], json!([]));
    assert_eq!(first["repaired_ids"], json!(["freshly-stranded"]));
    assert!(first["unchanged_ids"]
        .as_array()
        .unwrap()
        .contains(&json!("relinked-copy")));
    assert_eq!(first["failures"], json!([]));
    let context_gets = server
        .requests()
        .iter()
        .filter(|request| {
            request.method == "GET" && request.path == "/api/agent-attribution/context"
        })
        .count();
    assert_eq!(
        context_gets, 2,
        "adoption re-check must re-read the registry"
    );
    {
        let updated = updates
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone();
        assert_eq!(updated.len(), 1);
        assert_eq!(
            updated[0]["meta"]["subagent_creation_source"],
            json!("marketplace")
        );
        assert!(updated[0]["meta"]
            .get("subagent_marketplace_relationship")
            .is_none());
        assert!(updated[0]["meta"]
            .get("subagent_marketplace_solution_id")
            .is_none());
    }

    // Pass 2: freshly-stranded is now provably unlinked with no metas, so it is
    // adopted; relinked-copy is owned by the linked branch, which restores its
    // relationship/solution metas from the registry record.
    updates
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clear();
    let second = response_payload(
        handle_reconcile_agent_attribution(&Map::new())
            .await
            .unwrap(),
    );
    assert_eq!(
        second["marketplace_adopted_ids"],
        json!(["freshly-stranded"])
    );
    assert_eq!(
        second["repaired_ids"],
        json!(["freshly-stranded", "relinked-copy"])
    );
    let updated = updates
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone();
    let by_id = updated
        .into_iter()
        .map(|model| (model["id"].as_str().unwrap().to_string(), model))
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(
        by_id["freshly-stranded"]["meta"]["subagent_creation_source"],
        json!("local")
    );
    assert!(by_id["freshly-stranded"]["meta"]
        .get("subagent_marketplace_relationship")
        .is_none());
    assert_eq!(
        by_id["relinked-copy"]["meta"]["subagent_creation_source"],
        json!("marketplace")
    );
    assert_eq!(
        by_id["relinked-copy"]["meta"]["subagent_marketplace_relationship"],
        json!("installed")
    );
    assert_eq!(
        by_id["relinked-copy"]["meta"]["subagent_marketplace_solution_id"],
        json!("solution-relinked")
    );
}

fn reconcile_mock_server(
    context_links: Value,
    models: Arc<Mutex<std::collections::HashMap<String, Value>>>,
    updates: Arc<Mutex<Vec<Value>>>,
    listings: Value,
) -> MockServer {
    MockServer::start(move |request| {
        if request.method == "GET" && request.path == "/api/agent-attribution/context" {
            return MockResponse::json(json!({
                "email": "dsantiago@example.invalid",
                "links": context_links,
            }));
        }
        if request.method == "GET" && request.path == "/api/models?" {
            return MockResponse::json(listings.clone());
        }
        if request.method == "GET" && request.path.starts_with("/api/v1/models/model?id=") {
            let id = request
                .path
                .strip_prefix("/api/v1/models/model?id=")
                .unwrap_or_default();
            return models
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .get(id)
                .cloned()
                .map(MockResponse::json)
                .unwrap_or(MockResponse {
                    status: 404,
                    body: json!({ "error": "not found" }),
                });
        }
        if request.method == "POST" && request.path.starts_with("/api/v1/models/model/update?id=") {
            let body: Value = serde_json::from_str(&request.body).expect("invalid update body");
            let id = body["id"].as_str().expect("missing model id").to_string();
            updates
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .push(body.clone());
            models
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .insert(id, body.clone());
            return MockResponse::json(body);
        }
        MockResponse {
            status: 404,
            body: json!({ "error": "unexpected" }),
        }
    })
}

fn derived_listing(ids: &[&str]) -> Value {
    json!({
        "data": ids
            .iter()
            .map(|id| json!({ "id": id, "info": { "base_model_id": "gpt-4.1" } }))
            .collect::<Vec<_>>()
    })
}

#[tokio::test]
async fn reconcile_agent_attribution_normalizes_reclaimed_published_copies_to_local() {
    let env = TestEnv::new("reconcile-agent-attribution-reclaim-normalize");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("service-user");
    let models = Arc::new(Mutex::new(std::collections::HashMap::from([(
        "zzz-copy".to_string(),
        json!({
            "id": "zzz-copy",
            "base_model_id": "gpt-4.1",
            "meta": {
                "subagent_created_by_email": "dsantiago@example.invalid",
                "subagent_creation_source": "marketplace",
                "subagent_marketplace_relationship": "installed",
                "subagent_marketplace_solution_id": "sol-1"
            }
        }),
    )])));
    let updates = Arc::new(Mutex::new(Vec::<Value>::new()));
    let server = reconcile_mock_server(
        json!({
            "zzz-copy": {
                "solutionId": "sol-1",
                "relationship": "published",
                "authorIdentity": "dsantiago",
                "attributionPending": false
            }
        }),
        Arc::clone(&models),
        Arc::clone(&updates),
        derived_listing(&["zzz-copy"]),
    );
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());

    let first = response_payload(
        handle_reconcile_agent_attribution(&Map::new())
            .await
            .unwrap(),
    );
    assert_eq!(first["repaired_ids"], json!(["zzz-copy"]));
    assert_eq!(
        first["published_source_normalized_ids"],
        json!(["zzz-copy"])
    );
    assert_eq!(first["failures"], json!([]));
    {
        let updated = updates
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone();
        assert_eq!(updated.len(), 1);
        assert_eq!(
            updated[0]["meta"]["subagent_creation_source"],
            json!("local")
        );
        assert_eq!(
            updated[0]["meta"]["subagent_marketplace_relationship"],
            json!("published")
        );
        assert_eq!(
            updated[0]["meta"]["subagent_marketplace_solution_id"],
            json!("sol-1")
        );
        assert_eq!(
            updated[0]["meta"]["subagent_created_by_email"],
            json!("dsantiago@example.invalid")
        );
    }

    updates
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clear();
    let second = response_payload(
        handle_reconcile_agent_attribution(&Map::new())
            .await
            .unwrap(),
    );
    assert_eq!(second["repaired_ids"], json!([]));
    assert_eq!(second["published_source_normalized_ids"], json!([]));
    assert_eq!(
        updates
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .len(),
        0
    );
}

#[tokio::test]
async fn reconcile_agent_attribution_keeps_foreign_and_junk_sources_read_only_under_published_links(
) {
    let env = TestEnv::new("reconcile-agent-attribution-published-fail-closed");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("service-user");
    let models = Arc::new(Mutex::new(std::collections::HashMap::from([
        (
            "foreign-copy".to_string(),
            json!({
                "id": "foreign-copy",
                "base_model_id": "gpt-4.1",
                "meta": {
                    "subagent_created_by_email": "colleague@example.invalid",
                    "subagent_creation_source": "marketplace"
                }
            }),
        ),
        (
            "junk-source".to_string(),
            json!({
                "id": "junk-source",
                "base_model_id": "gpt-4.1",
                "meta": {
                    "subagent_created_by_email": "dsantiago@example.invalid",
                    "subagent_creation_source": "system"
                }
            }),
        ),
    ])));
    let updates = Arc::new(Mutex::new(Vec::<Value>::new()));
    let server = reconcile_mock_server(
        json!({
            "foreign-copy": {
                "solutionId": "sol-f",
                "relationship": "published",
                "authorIdentity": "colleague",
                "attributionPending": false
            },
            "junk-source": {
                "solutionId": "sol-j",
                "relationship": "published",
                "authorIdentity": "dsantiago",
                "attributionPending": false
            }
        }),
        Arc::clone(&models),
        Arc::clone(&updates),
        derived_listing(&["foreign-copy", "junk-source"]),
    );
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());

    let result = response_payload(
        handle_reconcile_agent_attribution(&Map::new())
            .await
            .unwrap(),
    );
    assert_eq!(result["published_source_normalized_ids"], json!([]));
    // The relationship/solution metas are still persisted from the links, but
    // neither copy's source is upgraded to editable.
    let updated = updates
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone();
    let by_id = updated
        .into_iter()
        .map(|model| (model["id"].as_str().unwrap().to_string(), model))
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(
        by_id["foreign-copy"]["meta"]["subagent_creation_source"],
        json!("marketplace")
    );
    assert_eq!(
        by_id["junk-source"]["meta"]["subagent_creation_source"],
        json!("system")
    );
}

#[tokio::test]
async fn reconcile_agent_attribution_still_skips_creator_missing_published_links() {
    let env = TestEnv::new("reconcile-agent-attribution-published-creator-missing");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("service-user");
    let models = Arc::new(Mutex::new(std::collections::HashMap::from([(
        "orphan-copy".to_string(),
        json!({
            "id": "orphan-copy",
            "base_model_id": "gpt-4.1",
            "meta": { "subagent_creation_source": "marketplace" }
        }),
    )])));
    let updates = Arc::new(Mutex::new(Vec::<Value>::new()));
    let server = reconcile_mock_server(
        json!({
            "orphan-copy": {
                "solutionId": "sol-o",
                "relationship": "published",
                "authorIdentity": "dsantiago",
                "attributionPending": false
            }
        }),
        Arc::clone(&models),
        Arc::clone(&updates),
        derived_listing(&["orphan-copy"]),
    );
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());

    let result = response_payload(
        handle_reconcile_agent_attribution(&Map::new())
            .await
            .unwrap(),
    );
    assert_eq!(result["missing_creator_linked_ids"], json!(["orphan-copy"]));
    assert_eq!(result["published_source_normalized_ids"], json!([]));
    assert_eq!(
        updates
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .len(),
        0
    );
}

#[tokio::test]
async fn reconcile_agent_attribution_leaves_installed_relationship_copies_marketplace() {
    let env = TestEnv::new("reconcile-agent-attribution-installed-not-normalized");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("service-user");
    let models = Arc::new(Mutex::new(std::collections::HashMap::from([(
        "installed-copy".to_string(),
        json!({
            "id": "installed-copy",
            "base_model_id": "gpt-4.1",
            "meta": {
                "subagent_created_by_email": "dsantiago@example.invalid",
                "subagent_creation_source": "marketplace",
                "subagent_marketplace_relationship": "installed",
                "subagent_marketplace_solution_id": "sol-i"
            }
        }),
    )])));
    let updates = Arc::new(Mutex::new(Vec::<Value>::new()));
    let server = reconcile_mock_server(
        json!({
            "installed-copy": {
                "solutionId": "sol-i",
                "relationship": "installed",
                "authorIdentity": "dsantiago",
                "attributionPending": false
            }
        }),
        Arc::clone(&models),
        Arc::clone(&updates),
        derived_listing(&["installed-copy"]),
    );
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());

    let result = response_payload(
        handle_reconcile_agent_attribution(&Map::new())
            .await
            .unwrap(),
    );
    assert_eq!(result["published_source_normalized_ids"], json!([]));
    assert_eq!(result["unchanged_ids"], json!(["installed-copy"]));
    assert_eq!(
        updates
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .len(),
        0
    );
}

#[tokio::test]
async fn create_agent_rejects_disabled_base_model() {
    let env = TestEnv::new("create-agent-disabled-base-model");
    env.set_openwebui_token("token");
    let server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/models?") => MockResponse::json(json!({
                    "data": [{
                        "id": "GPT-5.4 pro",
                        "name": "GPT-5.4 pro",
                        "meta": {
                            "disabled": true,
                            "disabled_reason": "Temporarily disabled due to high costs"
                        }
                    }]
                })),
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "unexpected" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());
    assert_err_contains(
        handle_create_agent(&args(&[
            ("name", json!("Blocked Agent")),
            ("base_model_id", json!("GPT-5.4 pro")),
        ]))
        .await,
        "Base model 'GPT-5.4 pro' is disabled: Temporarily disabled due to high costs",
    );
}

#[tokio::test]
async fn subagent_handlers_reject_legacy_tool_ids_arguments() {
    assert_err_contains(
        handle_create_agent(&args(&[
            ("name", json!("Legacy Agent")),
            ("base_model_id", json!("gpt-5.4")),
            ("tool_ids", json!(["server:time"])),
        ]))
        .await,
        "no longer accept 'tool_ids'. Use 'tool_server_ids' instead",
    );
    assert_err_contains(
        handle_update_agent(&args(&[
            ("model_id", json!("writer-agent")),
            ("tool_ids", json!(["server:time"])),
        ]))
        .await,
        "no longer accept 'tool_ids'. Use 'tool_server_ids' instead",
    );
    assert_err_contains(
        handle_run_subagent(&args(&[
            ("prompt", json!("Investigate")),
            ("tool_ids", json!(["server:time"])),
        ]))
        .await,
        "no longer accept 'tool_ids'. Use 'tool_server_ids' instead",
    );
}

#[tokio::test]
async fn update_agent_covers_system_base_and_success_paths() {
    let env = TestEnv::new("update-agent");
    // Linked skills must exist locally (skill_not_installed_locally gate).
    env.write_skill("company-knowledge", "Company knowledge", &[]);
    env.set_openwebui_token("token");
    env.write_model_catalog(
        r#"model_list:
  - model_name: "base-new"
    model_info:
      supports_reasoning: true
      reasoning_effort_options: ["medium", "high", "max"]
"#,
    );
    assert_err_contains(
        handle_update_agent(&args(&[("model_id", json!("portico_agent_writer"))])).await,
        "Cannot update system-delivered agent 'portico_agent_writer'",
    );
    env.set_openwebui_user_id("cached-user");
    env.write_server_yaml(false, "time", "Time tools", &["convert"]);
    env.write_server_yaml(true, "custom", "Custom tools", &[]);
    let server = MockServer::start(|request| {
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/api/models?") => {
                MockResponse::json(json!({ "data": [{ "id": "base-new", "name": "Base New" }] }))
            }
            ("GET", "/api/v1/models/model?id=base-agent") => {
                MockResponse::json(json!({ "id": "base-agent", "name": "Base Agent" }))
            }
            ("GET", "/api/v1/auths/") => MockResponse::json(json!({ "id": "user-42" })),
            ("GET", "/api/v1/models/model?id=agent-updatable") => MockResponse {
                status: 404,
                body: json!({ "error": "not found" }),
            },
            ("GET", "/api/models/agent%2Dupdatable") => MockResponse {
                status: 404,
                body: json!({ "error": "still not found" }),
            },
            ("GET", "/api/v1/models/agent%2Dupdatable") => MockResponse::json(
                json!({ "id": "agent-updatable", "name": "Old Agent", "base_model_id": "base-old", "info": { "base_model_id": "base-old" }, "meta": { "subagent_tool_server_ids": ["server:time"], "subagent_reasoning_effort": "high", "subagent_creation_source": "local", "subagent_created_by_email": "user@example.invalid" }, "user": { "id": "legacy-user" }, "is_active": false }),
            ),
            ("POST", "/api/v1/models/model/update?id=agent%2Dupdatable") => MockResponse::json(
                json!({ "id": "agent-updatable", "name": "Refined Agent", "base_model_id": "base-new", "meta": { "description": "Refined description", "subagent_tool_server_ids": ["server:time", "server:custom"], "subagent_skill_ids": ["company-knowledge"], "subagent_reasoning_effort": "max" }, "params": { "system": "Operate carefully." }, "is_active": false }),
            ),
            ("GET", "/api/v1/tools/") => MockResponse::json(
                json!([{ "id": "server:time", "name": "Time Tool" }, { "id": "server:custom", "name": "Custom Tool" }]),
            ),
            ("POST", "/api/agent-skills/validate-attachable") => MockResponse::json(
                json!({ "success": true, "allowed": ["company-knowledge"], "rejected": [] }),
            ),
            _ => MockResponse {
                status: 404,
                body: json!({ "error": "unexpected" }),
            },
        }
    });
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());
    assert_err_contains(
        handle_update_agent(&args(&[("model_id", json!("base-agent"))])).await,
        "Cannot update base model 'base-agent'",
    );
    redis_delete(OPENWEBUI_USER_KEY).unwrap();
    let updated = response_payload(
        handle_update_agent(&args(&[
            ("model_id", json!("agent-updatable")),
            ("name", json!("Refined Agent")),
            ("base_model_id", json!("base-new")),
            ("description", json!("Refined description")),
            ("system_prompt", json!("Operate carefully.")),
            ("tool_server_ids", json!(["server:time", "server:custom"])),
            ("skill_ids", json!(["company-knowledge"])),
            ("reasoning_effort", json!("max")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(updated["description"], json!("Refined description"));
    assert_eq!(
        updated["tool_server_ids"],
        json!(["server:time", "server:custom"])
    );
    assert_eq!(updated["skill_ids"], json!(["company-knowledge"]));
    assert_eq!(updated["reasoning_effort"], json!("max"));
    assert_eq!(
        updated["tools"][0]["description"],
        json!("Time tools. convert")
    );
    assert_eq!(updated["tools"][1]["description"], json!("Custom tools"));
    let update_request = server
        .requests()
        .into_iter()
        .find(|request| {
            request.method == "POST"
                && request.path == "/api/v1/models/model/update?id=agent%2Dupdatable"
        })
        .expect("missing update request");
    let body: Value = serde_json::from_str(&update_request.body).unwrap();
    assert_eq!(body["user_id"], json!("user-42"));
    assert_eq!(
        body["meta"]["subagent_tool_server_ids"],
        json!(["server:time", "server:custom"])
    );
    assert_eq!(
        body["meta"]["subagent_skill_ids"],
        json!(["company-knowledge"])
    );
    assert_eq!(body["meta"]["subagent_reasoning_effort"], json!("max"));
    assert!(body["meta"].get("toolIds").is_none());
    assert_eq!(
        body["meta"]["profile_image_url"],
        json!("/static/favicon.png")
    );
    assert_eq!(body["params"]["system"], json!("Operate carefully."));
    assert!(body.get("info").is_none() && body.get("user").is_none());
    assert_eq!(
        redis_get_string(OPENWEBUI_USER_KEY).unwrap().as_deref(),
        Some("user-42")
    );
}

#[tokio::test]
async fn update_agent_rejects_disabled_base_model_selection() {
    let env = TestEnv::new("update-agent-disabled-base-model");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("cached-user");
    let server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/models/model?id=agent-updatable") => MockResponse {
                    status: 404,
                    body: json!({ "error": "not found" }),
                },
                ("GET", "/api/models/agent%2Dupdatable") => MockResponse {
                    status: 404,
                    body: json!({ "error": "still not found" }),
                },
                ("GET", "/api/v1/models/agent%2Dupdatable") => MockResponse::json(json!({
                    "id": "agent-updatable",
                    "name": "Agent Updatable",
                    "base_model_id": "base-old",
                    "info": { "base_model_id": "base-old" },
                    "meta": {
                        "subagent_creation_source": "local",
                        "subagent_created_by_email": "user@example.invalid"
                    }
                })),
                ("GET", "/api/models?") => MockResponse::json(json!({
                    "data": [{
                        "id": "GPT-5.4 pro",
                        "name": "GPT-5.4 pro",
                        "meta": {
                            "disabled": true,
                            "disabled_reason": "Temporarily disabled due to high costs"
                        }
                    }]
                })),
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "unexpected" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());
    assert_err_contains(
        handle_update_agent(&args(&[
            ("model_id", json!("agent-updatable")),
            ("base_model_id", json!("GPT-5.4 pro")),
        ]))
        .await,
        "Base model 'GPT-5.4 pro' is disabled: Temporarily disabled due to high costs",
    );
}

#[tokio::test]
async fn update_agent_clears_saved_reasoning_when_switching_to_non_reasoning_base_model() {
    let env = TestEnv::new("update-agent-clear-reasoning");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("cached-user");
    env.write_model_catalog(
        r#"model_list:
  - model_name: "base-old"
    model_info:
      supports_reasoning: true
      reasoning_effort_options: ["medium", "high", "max"]
  - model_name: "base-plain"
    model_info:
      supports_reasoning: false
"#,
    );
    let server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/models/model?id=agent-updatable") => MockResponse {
                    status: 404,
                    body: json!({ "error": "not found" }),
                },
                ("GET", "/api/models/agent%2Dupdatable") => MockResponse {
                    status: 404,
                    body: json!({ "error": "still not found" }),
                },
                ("GET", "/api/v1/models/agent%2Dupdatable") => MockResponse::json(json!({
                    "id": "agent-updatable",
                    "name": "Agent Updatable",
                    "base_model_id": "base-old",
                    "info": { "base_model_id": "base-old" },
                    "meta": {
                        "subagent_tool_server_ids": ["server:time"],
                        "subagent_reasoning_effort": "high",
                        "subagent_creation_source": "local",
                        "subagent_created_by_email": "user@example.invalid"
                    },
                    "user": { "id": "legacy-user" }
                })),
                ("GET", "/api/models?") => MockResponse::json(json!({
                    "data": [
                        { "id": "base-old", "name": "base-old" },
                        { "id": "base-plain", "name": "base-plain" }
                    ]
                })),
                ("POST", "/api/v1/models/model/update?id=agent%2Dupdatable") => {
                    MockResponse::json(json!({
                        "id": "agent-updatable",
                        "name": "Agent Updatable",
                        "base_model_id": "base-plain",
                        "meta": {
                            "subagent_tool_server_ids": ["server:time"]
                        },
                        "params": {}
                    }))
                }
                ("GET", "/api/v1/tools/") => MockResponse::json(json!([])),
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "unexpected" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());

    let updated = response_payload(
        handle_update_agent(&args(&[
            ("model_id", json!("agent-updatable")),
            ("base_model_id", json!("base-plain")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(updated["reasoning_effort"], Value::Null);

    let request = server
        .requests()
        .into_iter()
        .find(|request| {
            request.method == "POST"
                && request.path == "/api/v1/models/model/update?id=agent%2Dupdatable"
        })
        .expect("missing update request");
    let body: Value = serde_json::from_str(&request.body).unwrap();
    assert!(body["meta"].get("subagent_reasoning_effort").is_none());
}

/// Editable, real-id, non-base model body for the writer-lease tests below.
fn lease_test_agent_body(id: &str) -> Value {
    json!({
        "id": id,
        "name": "Lease Guarded Agent",
        "base_model_id": "base-model",
        "meta": {
            "subagent_creation_source": "local",
            "subagent_created_by_email": "user@example.invalid"
        },
        "params": { "system": "prompt" }
    })
}

#[tokio::test]
async fn update_agent_retries_past_transient_writer_lease_conflicts() {
    let env = TestEnv::new("update-agent-lease-retry");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("cached-user");
    let update_attempts = Arc::new(AtomicUsize::new(0));
    let update_attempts_for_server = Arc::clone(&update_attempts);
    let server = MockServer::start(move |request| {
        if request.method == "POST"
            && request.path == "/api/v1/models/model/update?id=agent%2Dleased"
        {
            if update_attempts_for_server.fetch_add(1, Ordering::SeqCst) < 2 {
                return MockResponse {
                    status: 409,
                    body: json!({ "detail": "model writer lease is held by another process" }),
                };
            }
            let mut updated = lease_test_agent_body("agent-leased");
            updated["meta"]["description"] = json!("after");
            return MockResponse::json(updated);
        }
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/api/v1/models/model?id=agent-leased") => {
                MockResponse::json(lease_test_agent_body("agent-leased"))
            }
            ("GET", "/api/v1/tools/") => MockResponse::json(json!([])),
            ("POST", "/api/ai-marketplace/mark-agent-link-dirty") => {
                MockResponse::json(json!({ "success": true }))
            }
            _ => MockResponse {
                status: 404,
                body: json!({ "error": "unexpected" }),
            },
        }
    });
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());

    let updated = response_payload(
        handle_update_agent(&args(&[
            ("model_id", json!("agent-leased")),
            ("description", json!("after")),
        ]))
        .await
        .expect("lease conflicts inside the retry budget should not fail the tool call"),
    );
    assert_eq!(updated["description"], json!("after"));
    assert_eq!(
        update_attempts.load(Ordering::SeqCst),
        3,
        "two scripted conflicts plus the succeeding attempt"
    );
}

#[tokio::test]
async fn update_agent_surfaces_clear_error_when_writer_lease_stays_busy() {
    let env = TestEnv::new("update-agent-lease-busy");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("cached-user");
    let update_attempts = Arc::new(AtomicUsize::new(0));
    let update_attempts_for_server = Arc::clone(&update_attempts);
    let server = MockServer::start(move |request| {
        if request.method == "POST"
            && request.path == "/api/v1/models/model/update?id=agent%2Dleased"
        {
            update_attempts_for_server.fetch_add(1, Ordering::SeqCst);
            return MockResponse {
                status: 409,
                body: json!({ "detail": "model writer lease is held by another process" }),
            };
        }
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/api/v1/models/model?id=agent-leased") => {
                MockResponse::json(lease_test_agent_body("agent-leased"))
            }
            _ => MockResponse {
                status: 404,
                body: json!({ "error": "unexpected" }),
            },
        }
    });
    env.set_openwebui_base_url(server.base_url());

    let error = handle_update_agent(&args(&[
        ("model_id", json!("agent-leased")),
        ("description", json!("after")),
    ]))
    .await
    .expect_err("a persistently held writer lease should surface an error");
    let rendered = error.to_string();
    assert!(
        rendered.contains("Open WebUI is busy with another agent mutation"),
        "expected the writer-busy explanation, got {rendered:?}"
    );
    assert!(
        !rendered.contains("409"),
        "the chat-facing message must not be a bare 409, got {rendered:?}"
    );
    assert_eq!(
        update_attempts.load(Ordering::SeqCst),
        6,
        "one attempt plus five bounded retries"
    );
}

#[tokio::test]
async fn parallel_update_agent_calls_never_race_the_writer_lease() {
    let env = TestEnv::new("update-agent-lease-parallel");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("cached-user");
    let update_attempts = Arc::new(AtomicUsize::new(0));
    let overlap_conflicts = Arc::new(AtomicUsize::new(0));
    let lease_held = Arc::new(AtomicBool::new(false));
    let update_attempts_for_server = Arc::clone(&update_attempts);
    let overlap_conflicts_for_server = Arc::clone(&overlap_conflicts);
    let lease_held_for_server = Arc::clone(&lease_held);
    let server = MockServer::start(move |request| {
        if request.method == "POST"
            && request.path == "/api/v1/models/model/update?id=agent%2Dparallel"
        {
            update_attempts_for_server.fetch_add(1, Ordering::SeqCst);
            // Simulate the OWUI global writer lease: any update that arrives
            // while another is still in flight gets a 409 holder conflict.
            if lease_held_for_server.swap(true, Ordering::SeqCst) {
                overlap_conflicts_for_server.fetch_add(1, Ordering::SeqCst);
                return MockResponse {
                    status: 409,
                    body: json!({ "detail": "model writer lease is held by another process" }),
                };
            }
            thread::sleep(Duration::from_millis(120));
            lease_held_for_server.store(false, Ordering::SeqCst);
            let mut updated = lease_test_agent_body("agent-parallel");
            updated["meta"]["description"] = json!("done");
            return MockResponse::json(updated);
        }
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/api/v1/models/model?id=agent-parallel") => {
                MockResponse::json(lease_test_agent_body("agent-parallel"))
            }
            ("GET", "/api/v1/tools/") => MockResponse::json(json!([])),
            ("POST", "/api/ai-marketplace/mark-agent-link-dirty") => {
                MockResponse::json(json!({ "success": true }))
            }
            _ => MockResponse {
                status: 404,
                body: json!({ "error": "unexpected" }),
            },
        }
    });
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());

    let first_args = args(&[
        ("model_id", json!("agent-parallel")),
        ("description", json!("first")),
    ]);
    let second_args = args(&[
        ("model_id", json!("agent-parallel")),
        ("description", json!("second")),
    ]);
    let (first, second) = tokio::join!(
        handle_update_agent(&first_args),
        handle_update_agent(&second_args),
    );
    let first = response_payload(first.expect("first parallel update should succeed"));
    let second = response_payload(second.expect("second parallel update should succeed"));
    assert_eq!(first["description"], json!("done"));
    assert_eq!(second["description"], json!("done"));
    assert_eq!(
        overlap_conflicts.load(Ordering::SeqCst),
        0,
        "the in-process mutex must keep parallel updates from overlapping on the lease"
    );
    assert_eq!(
        update_attempts.load(Ordering::SeqCst),
        2,
        "serialized calls need exactly one attempt each"
    );
}

#[tokio::test]
async fn delete_agent_reports_writer_busy_without_legacy_route_fallback() {
    let env = TestEnv::new("delete-agent-lease-busy");
    env.set_openwebui_token("token");
    let delete_attempts = Arc::new(AtomicUsize::new(0));
    let delete_attempts_for_server = Arc::clone(&delete_attempts);
    let server = MockServer::start(move |request| {
        if request.method == "POST" && request.path == "/api/v1/models/model/delete" {
            delete_attempts_for_server.fetch_add(1, Ordering::SeqCst);
            return MockResponse {
                status: 409,
                body: json!({ "detail": "model writer lease is held by another process" }),
            };
        }
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/api/v1/models/model?id=agent-lease-blocked") => {
                MockResponse::json(lease_test_agent_body("agent-lease-blocked"))
            }
            _ => MockResponse {
                status: 404,
                body: json!({ "error": "unexpected" }),
            },
        }
    });
    env.set_openwebui_base_url(server.base_url());

    let envelope = response_payload(
        handle_delete_agent(&args(&[
            ("model_id", json!("agent-lease-blocked")),
            ("confirm", json!(true)),
        ]))
        .await
        .expect("writer-busy deletes should return an envelope, not a raw error"),
    );
    assert_eq!(envelope["success"], json!(false));
    assert_eq!(envelope["code"], json!("openwebui_writer_busy"));
    let message = envelope["error"].as_str().unwrap_or_default();
    assert!(
        message.contains("Open WebUI is busy with another agent mutation"),
        "expected the writer-busy explanation, got {message:?}"
    );
    assert!(
        !message.contains("409"),
        "the envelope must not be a bare 409, got {message:?}"
    );
    assert_eq!(
        delete_attempts.load(Ordering::SeqCst),
        6,
        "one attempt plus five bounded retries on the primary delete route"
    );
    // A lease conflict is not "route not found": the legacy fallback routes
    // contend for the same lease, so the handler must stop instead of
    // tripling the backoff. Not-found fallbacks are covered by
    // delete_agent_covers_system_base_fallback_and_failure_paths.
    assert!(
        server
            .requests()
            .iter()
            .all(|request| request.method != "DELETE"),
        "no legacy delete-route fallback may run after a lease conflict"
    );
}

#[tokio::test]
async fn delete_agent_covers_system_base_fallback_and_failure_paths() {
    let env = TestEnv::new("delete-agent");
    env.set_openwebui_token("token");
    assert_err_contains(
        handle_delete_agent(&args(&[("model_id", json!("portico_agent_writer"))])).await,
        "Cannot delete system-delivered agent 'portico_agent_writer'",
    );
    // Destructive gate: without confirm=true the handler refuses before any
    // lookup or delete request goes out (no mock server is running yet, so a
    // network attempt here would error instead of returning the refusal).
    let refused = response_payload(
        handle_delete_agent(&args(&[("model_id", json!("agent-unconfirmed"))]))
            .await
            .unwrap(),
    );
    assert_eq!(refused["success"], json!(false));
    assert_eq!(
        refused["error"],
        json!("Set confirm=true to delete the agent")
    );
    let server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/models/model?id=base-agent") => {
                    MockResponse::json(json!({ "id": "base-agent", "name": "Base Agent" }))
                }
                ("GET", "/api/v1/models/model?id=agent-success") => MockResponse::json(
                    json!({ "id": "agent-success", "base_model_id": "base-model" }),
                ),
                ("GET", "/api/v1/models/model?id=agent-failure") => MockResponse::json(
                    json!({ "id": "agent-failure", "base_model_id": "base-model" }),
                ),
                ("POST", "/api/v1/models/model/delete") => {
                    match serde_json::from_str::<Value>(&request.body).unwrap()["id"].as_str() {
                        Some("agent-success") => MockResponse {
                            status: 500,
                            body: json!({ "error": "retry" }),
                        },
                        Some("agent-failure") => MockResponse {
                            status: 500,
                            body: json!({ "error": "still failing" }),
                        },
                        _ => MockResponse {
                            status: 404,
                            body: json!({ "error": "unknown agent" }),
                        },
                    }
                }
                ("DELETE", "/api/v1/models/agent%2Dsuccess/delete") => {
                    MockResponse::json(json!({ "success": true }))
                }
                ("POST", "/api/ai-marketplace/clear-deleted-agent-link") => {
                    MockResponse::json(json!({ "success": true, "data": { "cleared": true } }))
                }
                ("DELETE", "/api/v1/models/agent%2Dfailure/delete") => MockResponse {
                    status: 500,
                    body: json!({ "error": "delete failed" }),
                },
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "unexpected" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());
    assert_err_contains(
        handle_delete_agent(&args(&[("model_id", json!("base-agent")), ("confirm", json!(true))]))
            .await,
        "Cannot delete base model 'base-agent'",
    );
    let deleted = response_payload(
        handle_delete_agent(&args(&[("model_id", json!("agent-success")), ("confirm", json!(true))]))
            .await
            .unwrap(),
    );
    let failed = response_payload(
        handle_delete_agent(&args(&[("model_id", json!("agent-failure")), ("confirm", json!(true))]))
            .await
            .unwrap(),
    );
    assert_eq!(
        deleted["message"],
        json!("Agent deleted locally; any Marketplace solution remains published")
    );
    assert_eq!(
        failed["message"],
        json!("Failed to delete local agent 'agent-failure'")
    );
    let requests = server.requests();
    let delete_paths = requests
        .iter()
        .filter(|request| request.path.contains("/delete"))
        .map(|request| request.path.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        delete_paths,
        vec![
            "/api/v1/models/model/delete",
            "/api/v1/models/model/delete?id=agent%2Dsuccess",
            "/api/v1/models/agent%2Dsuccess/delete",
            "/api/v1/models/model/delete",
            "/api/v1/models/model/delete?id=agent%2Dfailure",
            "/api/v1/models/agent%2Dfailure/delete",
        ]
    );
}

#[tokio::test]
async fn installed_agent_reads_are_explicit_updates_fail_closed_and_delete_is_local_only() {
    let env = TestEnv::new("installed-agent-lifecycle");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("user-1");
    let installed_model = json!({
        "id": "installed-agent",
        "name": "Installed Agent",
        "base_model_id": "base-model",
        "info": { "base_model_id": "base-model" },
        "meta": {
            "description": "Foreign installed agent",
            "subagent_created_by_email": "foreign@example.invalid",
            "subagent_creation_source": "marketplace",
            "subagent_marketplace_relationship": "installed",
            "subagent_marketplace_solution_id": "foreign-solution",
            "subagent_tool_server_ids": [],
            "subagent_skill_ids": []
        },
        "params": { "system": "Read only." },
        "is_active": true
    });
    let list_model = installed_model.clone();
    let get_model = installed_model.clone();
    let server =
        MockServer::start(
            move |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/models") => MockResponse::json(json!([list_model.clone()])),
                ("GET", "/api/v1/tools/") => MockResponse::json(json!([])),
                ("GET", "/api/v1/models/model?id=installed-agent") => {
                    MockResponse::json(get_model.clone())
                }
                ("POST", "/api/v1/models/model/delete") => {
                    MockResponse::json(json!({ "success": true }))
                }
                ("POST", "/api/ai-marketplace/clear-deleted-agent-link") => {
                    MockResponse::json(json!({
                        "success": true,
                        "data": {
                            "success": true,
                            "local_agent_id": "installed-agent",
                            "link_removed": true,
                            "remote_solution_deleted": false
                        }
                    }))
                }
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "unexpected" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());

    let listed = response_payload(handle_list_agents(&Map::new()).await.unwrap());
    let listed_agent = &listed[0];
    assert_eq!(listed_agent["creation_source"], json!("marketplace"));
    assert_eq!(listed_agent["marketplace_relationship"], json!("installed"));
    assert_eq!(
        listed_agent["marketplace_solution_id"],
        json!("foreign-solution")
    );
    assert_eq!(
        listed_agent["created_by_email"],
        json!("foreign@example.invalid")
    );
    assert_eq!(listed_agent["is_read_only"], json!(true));

    let fetched = response_payload(
        handle_get_agent(&args(&[("model_id", json!("installed-agent"))]))
            .await
            .unwrap(),
    );
    assert_eq!(fetched["creation_source"], json!("marketplace"));
    assert_eq!(fetched["marketplace_relationship"], json!("installed"));
    assert_eq!(fetched["is_read_only"], json!(true));

    let update = response_payload(
        handle_update_agent(&args(&[
            ("model_id", json!("installed-agent")),
            ("description", json!("Must not change")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(update["success"], json!(false));
    assert_eq!(update["code"], json!("installed_copy_read_only"));
    assert!(update["remediation"]
        .as_str()
        .unwrap()
        .contains("editable user copy"));

    let deleted = response_payload(
        handle_delete_agent(&args(&[("model_id", json!("installed-agent")), ("confirm", json!(true))]))
            .await
            .unwrap(),
    );
    assert_eq!(deleted["success"], json!(true));
    assert_eq!(deleted["local_deleted"], json!(true));
    assert_eq!(deleted["remote_solution_deleted"], json!(false));

    let requests = server.requests();
    assert!(
        !requests.iter().any(|request| {
            request.method == "POST" && request.path.starts_with("/api/v1/models/model/update")
        }),
        "installed update must not reach the local mutation endpoint"
    );
    assert!(
        !requests
            .iter()
            .any(|request| request.path.contains("/ai-marketplace/unpublish")),
        "local delete must not unpublish the remote solution"
    );
    assert!(requests.iter().any(|request| {
        request.method == "POST" && request.path == "/api/ai-marketplace/clear-deleted-agent-link"
    }));
}

#[tokio::test]
async fn agent_marketplace_proxy_preserves_structured_failures_and_expected_type() {
    let env = TestEnv::new("agent-marketplace-structured-error");
    let server = MockServer::start(|request| {
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/api/ai-marketplace/install");
        MockResponse::json(json!({
            "success": false,
            "code": "solution_type_mismatch",
            "error": "Expected an agent solution.",
            "remediation": "Use a solution id whose Marketplace type matches this tool."
        }))
    });
    env.set_electron_api_base(server.base_url());

    let response = response_payload(
        handle_install_agent(&args(&[("solution_id", json!("skill-solution"))]))
            .await
            .unwrap(),
    );
    assert_eq!(response["success"], json!(false));
    assert_eq!(response["code"], json!("solution_type_mismatch"));
    assert_eq!(
        response["remediation"],
        json!("Use a solution id whose Marketplace type matches this tool.")
    );

    let request = server.requests().into_iter().next().unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&request.body).unwrap(),
        json!({
            "id": "skill-solution",
            "expected_type": "portico-agents"
        })
    );
}

// ---------------------------------------------------------------------------
// Round 9: skill-addition provenance gate (keep-allowed / add-blocked).
// ---------------------------------------------------------------------------

fn update_gate_mock_routes(request: &RecordedRequest, validate: MockResponse) -> MockResponse {
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/api/v1/models/model?id=gated-agent") => MockResponse {
            status: 404,
            body: json!({ "error": "not found" }),
        },
        ("GET", "/api/models/gated%2Dagent") => MockResponse {
            status: 404,
            body: json!({ "error": "still not found" }),
        },
        ("GET", "/api/v1/models/gated%2Dagent") => MockResponse::json(json!({
            "id": "gated-agent",
            "name": "Gated Agent",
            "base_model_id": "base-old",
            "info": { "base_model_id": "base-old" },
            "meta": {
                "subagent_skill_ids": ["shady/exfil"],
                "subagent_creation_source": "local",
                "subagent_created_by_email": "user@example.invalid"
            },
            "user": { "id": "legacy-user" },
            "is_active": false
        })),
        ("POST", "/api/agent-skills/validate-attachable") => validate,
        ("POST", "/api/ai-marketplace/mark-agent-link-dirty") => {
            MockResponse::json(json!({ "success": true, "marked": true }))
        }
        ("GET", "/api/v1/auths/") => MockResponse::json(json!({ "id": "user-42" })),
        ("POST", "/api/v1/models/model/update?id=gated%2Dagent") => MockResponse::json(json!({
            "id": "gated-agent",
            "name": "Gated Agent",
            "base_model_id": "base-old",
            "meta": { "subagent_skill_ids": ["shady/exfil", "kwp/document-skills/pdf"] },
            "params": {},
            "is_active": false
        })),
        ("GET", "/api/v1/tools/") => MockResponse::json(json!([])),
        _ => MockResponse {
            status: 404,
            body: json!({ "error": "unexpected" }),
        },
    }
}

fn write_marketplace_skill(env: &TestEnv, marketplace_id: &str, skill_name: &str) {
    let skill_dir = env
        .root
        .join("skills-marketplace")
        .join(marketplace_id)
        .join(skill_name);
    fs::create_dir_all(&skill_dir).expect("failed to create marketplace skill dir");
    fs::write(
        skill_dir.join("SKILL.md"),
        format!("---\nname: {skill_name}\ndescription: test marketplace skill\n---\n\n# {skill_name}\n"),
    )
    .expect("failed to write marketplace skill");
}

#[tokio::test]
async fn update_agent_rejects_non_attachable_skill_additions_with_structured_error() {
    let env = TestEnv::new("update-gate-reject");
    // The addition exists on disk so the local-existence gate passes and the
    // PROVENANCE gate is what rejects it.
    write_marketplace_skill(&env, "shadier", "new-skill");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("user-42");
    let server = MockServer::start(|request| {
        update_gate_mock_routes(
            request,
            MockResponse::json(json!({
                "success": true,
                "allowed": [],
                "rejected": [
                    { "id": "shadier/new-skill", "reason": "marketplace_source_not_allowed", "marketplaceName": "Shadier Skills" }
                ]
            })),
        )
    });
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());

    let payload = response_payload(
        handle_update_agent(&args(&[
            ("model_id", json!("gated-agent")),
            // Keeps the grandfathered skill AND tries to add a new one.
            ("skill_ids", json!(["shady/exfil", "shadier/new-skill"])),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(payload["success"], json!(false));
    assert_eq!(payload["code"], json!("skill_not_attachable"));
    assert!(payload["error"]
        .as_str()
        .unwrap()
        .contains("shadier/new-skill"));
    assert_eq!(
        payload["rejected_skills"][0]["id"],
        json!("shadier/new-skill")
    );

    // ONLY the additions were sent to the gate — grandfathered ids stay out.
    let validate_request = server
        .requests()
        .into_iter()
        .find(|request| request.path == "/api/agent-skills/validate-attachable")
        .expect("validate-attachable was consulted");
    let body: Value = serde_json::from_str(&validate_request.body).unwrap();
    assert_eq!(body["skill_ids"], json!(["shadier/new-skill"]));

    // Nothing was written to OWUI.
    assert!(server
        .requests()
        .into_iter()
        .all(|request| !request.path.contains("/models/model/update")));
}

#[tokio::test]
async fn update_agent_rejects_additions_that_do_not_exist_locally() {
    // 2026-08-01 sharing-plan S15: phantom skill ids (not installed anywhere
    // locally) used to sail through the provenance gate as "inert" and then
    // silently drop at run time. The existence gate now fails closed BEFORE
    // any provenance transport.
    let env = TestEnv::new("update-gate-missing-local");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("user-42");
    let server = MockServer::start(|request| {
        update_gate_mock_routes(
            request,
            // Provenance would allow everything — proving the EXISTENCE gate
            // is what rejects.
            MockResponse::json(json!({ "success": true, "allowed": [], "rejected": [] })),
        )
    });
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());

    let payload = response_payload(
        handle_update_agent(&args(&[
            ("model_id", json!("gated-agent")),
            ("skill_ids", json!(["shady/exfil", "totally-made-up-skill"])),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(payload["success"], json!(false));
    assert_eq!(payload["code"], json!("skill_not_installed_locally"));
    assert!(payload["error"]
        .as_str()
        .unwrap()
        .contains("totally-made-up-skill"));
    assert_eq!(payload["missing_skills"], json!(["totally-made-up-skill"]));

    // Failed before any provenance transport or OWUI write.
    assert!(server
        .requests()
        .into_iter()
        .all(|request| request.path != "/api/agent-skills/validate-attachable"
            && !request.path.contains("/models/model/update")));
}

#[tokio::test]
async fn update_agent_keeps_grandfathered_skills_without_consulting_the_gate() {
    let env = TestEnv::new("update-gate-grandfather");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("user-42");
    let server = MockServer::start(|request| {
        update_gate_mock_routes(
            request,
            // Any validate call would reject — proving it is never made.
            MockResponse::json(json!({
                "success": true,
                "allowed": [],
                "rejected": [{ "id": "shady/exfil", "reason": "marketplace_source_not_allowed" }]
            })),
        )
    });
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());

    let payload = response_payload(
        handle_update_agent(&args(&[
            ("model_id", json!("gated-agent")),
            // Same set as the stored meta: keep-allowed, no additions.
            ("skill_ids", json!(["shady/exfil"])),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(payload["id"], json!("gated-agent"));
    assert!(server
        .requests()
        .into_iter()
        .all(|request| request.path != "/api/agent-skills/validate-attachable"));

    // 2026-08-01 sharing-plan S11.5 regression: the successful agentic edit
    // reported itself to the agent-link dirty marker.
    assert!(server
        .requests()
        .into_iter()
        .any(|request| request.path == "/api/ai-marketplace/mark-agent-link-dirty"
            && request.body.contains("gated-agent")));
}

#[tokio::test]
async fn update_agent_fails_closed_for_additions_when_the_gate_is_unreachable() {
    let env = TestEnv::new("update-gate-transport");
    // The addition exists locally so the flow reaches the (down) provenance gate.
    let plugin_dir = env
        .root
        .join("skills-marketplace")
        .join("kwp")
        .join("document-skills")
        .join("pdf");
    fs::create_dir_all(&plugin_dir).expect("failed to create plugin skill dir");
    fs::write(
        plugin_dir.join("SKILL.md"),
        "---\nname: pdf\ndescription: pdf skill\n---\n\n# pdf\n",
    )
    .expect("failed to write plugin skill");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("user-42");
    let server = MockServer::start(|request| {
        update_gate_mock_routes(
            request,
            MockResponse {
                status: 500,
                body: json!({ "error": "electron down" }),
            },
        )
    });
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());

    let payload = response_payload(
        handle_update_agent(&args(&[
            ("model_id", json!("gated-agent")),
            ("skill_ids", json!(["shady/exfil", "kwp/document-skills/pdf"])),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(payload["success"], json!(false));
    assert_eq!(payload["code"], json!("skill_provenance_unverified"));
    assert!(payload["error"]
        .as_str()
        .unwrap()
        .contains("blocked"));
}

#[path = "subagents_run_tests.rs"]
mod run_tests;

#[path = "subagents_coverage_tests.rs"]
mod coverage_tests;

// -----------------------------------------------------------------------------
// 2026-08-01 sharing-plan S11.10/ISSUE-9: the sanctioned marketplace refresh
// may mutate an installed copy ONLY with content matching the linked listing's
// bundle; anything else stays read-only.
// -----------------------------------------------------------------------------
fn marketplace_refresh_mock_routes(request: &RecordedRequest) -> MockResponse {
    let installed_model = json!({
        "id": "installed-agent",
        "name": "Note Taker",
        "base_model_id": "base-old",
        "info": { "base_model_id": "base-old" },
        "meta": {
            "subagent_creation_source": "marketplace",
            "subagent_marketplace_relationship": "installed",
            "subagent_marketplace_solution_id": "foreign-solution",
            "subagent_created_by_email": "foreign@example.invalid"
        },
        "params": { "system": "Take notes v1." },
        "is_active": true
    });
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/api/v1/models/model?id=installed%2Dagent")
        | ("GET", "/api/v1/models/model?id=installed-agent") => {
            MockResponse::json(installed_model)
        }
        ("POST", "/api/ai-marketplace/get-bundle") => MockResponse::json(json!({
            "success": true,
            "data": {
                "type": "portico-agents",
                "payload": {
                    "name": "Note Taker",
                    "description": "Takes meeting notes",
                    "base_model_id": "base-old",
                    "system_prompt": "Take notes v2 with action items."
                }
            }
        })),
        ("GET", "/api/v1/auths/") => MockResponse::json(json!({ "id": "user-42" })),
        ("POST", "/api/v1/models/model/update?id=installed%2Dagent") => {
            MockResponse::json(json!({
                "id": "installed-agent",
                "name": "Note Taker",
                "base_model_id": "base-old",
                "meta": {
                    "subagent_marketplace_relationship": "installed",
                    "subagent_marketplace_solution_id": "foreign-solution"
                },
                "params": { "system": "Take notes v2 with action items." },
                "is_active": true
            }))
        }
        ("GET", "/api/v1/tools/") => MockResponse::json(json!([])),
        _ => MockResponse {
            status: 404,
            body: json!({ "error": format!("unexpected {} {}", request.method, request.path) }),
        },
    }
}

#[tokio::test]
async fn marketplace_refresh_updates_installed_copy_with_listing_content() {
    let env = TestEnv::new("refresh-installed-allowed");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("user-42");
    let server = MockServer::start(marketplace_refresh_mock_routes);
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());

    let payload = response_payload(
        handle_update_agent(&args(&[
            ("model_id", json!("installed-agent")),
            ("marketplace_refresh", json!(true)),
            ("name", json!("Note Taker")),
            ("description", json!("Takes meeting notes")),
            ("system_prompt", json!("Take notes v2 with action items.")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(payload["id"], json!("installed-agent"));
    assert_ne!(payload["code"], json!("installed_copy_read_only"));

    // The refresh is a clean sync — the dirty marker must NOT fire.
    assert!(server
        .requests()
        .into_iter()
        .all(|request| request.path != "/api/ai-marketplace/mark-agent-link-dirty"));
}

#[tokio::test]
async fn marketplace_refresh_rejects_content_that_differs_from_the_listing() {
    let env = TestEnv::new("refresh-installed-mismatch");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("user-42");
    let server = MockServer::start(marketplace_refresh_mock_routes);
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());

    let payload = response_payload(
        handle_update_agent(&args(&[
            ("model_id", json!("installed-agent")),
            ("marketplace_refresh", json!(true)),
            ("system_prompt", json!("Injected prompt that is not on the listing.")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(payload["success"], json!(false));
    assert_eq!(payload["code"], json!("marketplace_refresh_mismatch"));

    // Nothing was written to OWUI.
    assert!(server
        .requests()
        .into_iter()
        .all(|request| !request.path.contains("/models/model/update")));
}

// -----------------------------------------------------------------------------
// R2-2 regression (2026-08-02): a raw marketplace_refresh:true on an EDITABLE
// published agent is NOT a verified refresh — the verification gate only runs
// for read-only installed copies, so the flag must not buy the dirty-marking
// exemption. The edit lands like any other agentic edit, dirty marker included.
// -----------------------------------------------------------------------------
fn editable_published_refresh_mock_routes(request: &RecordedRequest) -> MockResponse {
    // Editable published agent: local creation source + published
    // relationship + linked solution id (agent_is_read_only == false).
    let published_model = json!({
        "id": "published-agent",
        "name": "Note Taker",
        "base_model_id": "base-old",
        "info": { "base_model_id": "base-old" },
        "meta": {
            "subagent_creation_source": "local",
            "subagent_marketplace_relationship": "published",
            "subagent_marketplace_solution_id": "own-solution",
            "subagent_created_by_email": "user@example.invalid"
        },
        "params": { "system": "Take notes v1." },
        "is_active": true
    });
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/api/v1/models/model?id=published%2Dagent")
        | ("GET", "/api/v1/models/model?id=published-agent") => {
            MockResponse::json(published_model)
        }
        ("GET", "/api/v1/auths/") => MockResponse::json(json!({ "id": "user-42" })),
        ("POST", "/api/v1/models/model/update?id=published%2Dagent") => {
            MockResponse::json(json!({
                "id": "published-agent",
                "name": "Note Taker",
                "base_model_id": "base-old",
                "meta": {
                    "subagent_creation_source": "local",
                    "subagent_marketplace_relationship": "published",
                    "subagent_marketplace_solution_id": "own-solution"
                },
                "params": { "system": "Prompt that diverges from the listing." },
                "is_active": true
            }))
        }
        ("POST", "/api/ai-marketplace/mark-agent-link-dirty") => {
            MockResponse::json(json!({ "success": true, "marked": true }))
        }
        ("GET", "/api/v1/tools/") => MockResponse::json(json!([])),
        _ => MockResponse {
            status: 404,
            body: json!({ "error": format!("unexpected {} {}", request.method, request.path) }),
        },
    }
}

#[tokio::test]
async fn marketplace_refresh_flag_on_editable_agent_still_marks_the_link_dirty() {
    let env = TestEnv::new("refresh-editable-dirty");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("user-42");
    let server = MockServer::start(editable_published_refresh_mock_routes);
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());

    let payload = response_payload(
        handle_update_agent(&args(&[
            ("model_id", json!("published-agent")),
            ("marketplace_refresh", json!(true)),
            ("system_prompt", json!("Prompt that diverges from the listing.")),
        ]))
        .await
        .unwrap(),
    );
    // The edit itself succeeds — editable agents are never refresh-gated.
    assert_eq!(payload["id"], json!("published-agent"));

    let requests = server.requests();
    // The editable path never consults the listing bundle...
    assert!(requests
        .iter()
        .all(|request| request.path != "/api/ai-marketplace/get-bundle"));
    // ...and the successful edit reported itself to the agent-link dirty
    // marker exactly like a flag-less edit would.
    assert!(requests
        .iter()
        .any(|request| request.path == "/api/ai-marketplace/mark-agent-link-dirty"
            && request.body.contains("published-agent")));
}

// -----------------------------------------------------------------------------
// R2-3 regression (2026-08-02): unknown agent ids used to come back as an
// all-null agent envelope ({id:null, is_read_only:true, ...}); they are a
// domain not-found failure.
// -----------------------------------------------------------------------------
#[tokio::test]
async fn get_agent_unknown_id_returns_agent_not_found_envelope() {
    let env = TestEnv::new("get-agent-not-found");
    env.set_openwebui_token("token");
    let server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                // OWUI's lookup can "succeed" with a null body for unknown ids.
                ("GET", "/api/v1/models/model?id=ghost-agent")
                | ("GET", "/api/v1/models/model?id=ghost%2Dagent") => {
                    MockResponse::json(json!(null))
                }
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "unexpected" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());

    let payload = response_payload(
        handle_get_agent(&args(&[("model_id", json!("ghost-agent"))]))
            .await
            .unwrap(),
    );
    assert_eq!(payload["success"], json!(false));
    assert_eq!(payload["code"], json!("agent_not_found"));
    assert!(payload["error"].as_str().unwrap().contains("ghost-agent"));
    assert!(payload["remediation"]
        .as_str()
        .unwrap()
        .contains("list_agents"));

    // A hard miss on every lookup route lands on the same envelope.
    let payload = response_payload(
        handle_get_agent(&args(&[("model_id", json!("fully-missing"))]))
            .await
            .unwrap(),
    );
    assert_eq!(payload["success"], json!(false));
    assert_eq!(payload["code"], json!("agent_not_found"));
}

// -----------------------------------------------------------------------------
// ISSUE-A regression (2026-08-02): the same null-body lookup blind spot in the
// sibling routes. Unknown ids used to read as base models downstream
// (`is_base_model(null)` is true), so get_agent_system_prompt returned a
// phantom empty prompt, copy_agent reported base_model_not_copyable, and
// delete_agent failed with a "Cannot delete base model" protocol error.
// -----------------------------------------------------------------------------

/// OWUI's model lookup "succeeds" with a null body for unknown ids on the
/// first endpoint shape; every other route is a hard 404 (so "fully-missing"
/// exercises the miss-on-every-endpoint path).
fn ghost_agent_lookup_mock_routes(request: &RecordedRequest) -> MockResponse {
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/api/v1/models/model?id=ghost-agent") => MockResponse::json(json!(null)),
        _ => MockResponse {
            status: 404,
            body: json!({ "error": "unexpected" }),
        },
    }
}

fn assert_agent_not_found_envelope(payload: &Value, model_id: &str) {
    assert_eq!(payload["success"], json!(false));
    assert_eq!(payload["code"], json!("agent_not_found"));
    assert!(payload["error"].as_str().unwrap().contains(model_id));
    assert!(payload["remediation"]
        .as_str()
        .unwrap()
        .contains("list_agents"));
}

#[tokio::test]
async fn get_agent_system_prompt_unknown_id_returns_agent_not_found_envelope() {
    let env = TestEnv::new("system-prompt-not-found");
    env.set_openwebui_token("token");
    let server = MockServer::start(ghost_agent_lookup_mock_routes);
    env.set_openwebui_base_url(server.base_url());

    // Null-body lookup: previously a phantom success claiming the agent
    // exists with an empty system prompt.
    let payload = response_payload(
        handle_get_agent_system_prompt(&args(&[("model_id", json!("ghost-agent"))]))
            .await
            .unwrap(),
    );
    assert_agent_not_found_envelope(&payload, "ghost-agent");
    assert!(payload.get("system_prompt").is_none());

    // A hard miss on every lookup route lands on the same envelope
    // (previously a protocol error).
    let payload = response_payload(
        handle_get_agent_system_prompt(&args(&[("model_id", json!("fully-missing"))]))
            .await
            .unwrap(),
    );
    assert_agent_not_found_envelope(&payload, "fully-missing");
}

#[tokio::test]
async fn copy_agent_unknown_source_returns_agent_not_found_without_creating() {
    let env = TestEnv::new("copy-agent-not-found");
    env.set_openwebui_token("token");
    let server = MockServer::start(ghost_agent_lookup_mock_routes);
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());

    // Null-body source lookup: previously misread as base_model_not_copyable.
    let payload = response_payload(
        handle_copy_agent(&args(&[
            ("source_agent_id", json!("ghost-agent")),
            ("new_agent_id", json!("ghost-copy")),
        ]))
        .await
        .unwrap(),
    );
    assert_agent_not_found_envelope(&payload, "ghost-agent");

    // A hard miss on every lookup route lands on the same envelope.
    let payload = response_payload(
        handle_copy_agent(&args(&[
            ("source_agent_id", json!("fully-missing")),
            ("new_agent_id", json!("missing-copy")),
        ]))
        .await
        .unwrap(),
    );
    assert_agent_not_found_envelope(&payload, "fully-missing");

    // Neither source produced a copy.
    assert!(!server
        .requests()
        .iter()
        .any(|request| request.method == "POST" && request.path == "/api/v1/models/create"));
}

#[tokio::test]
async fn delete_agent_unknown_id_returns_agent_not_found_without_deleting() {
    let env = TestEnv::new("delete-agent-not-found");
    env.set_openwebui_token("token");
    let server = MockServer::start(ghost_agent_lookup_mock_routes);
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());

    // Null-body lookup: previously misread as a base model and rejected with
    // a "Cannot delete base model 'ghost-agent'" protocol error. OWUI is
    // authoritative that the id is unknown, so no delete attempt or link
    // cleanup goes out at all.
    let payload = response_payload(
        handle_delete_agent(&args(&[
            ("model_id", json!("ghost-agent")),
            ("confirm", json!(true)),
        ]))
        .await
        .unwrap(),
    );
    assert_agent_not_found_envelope(&payload, "ghost-agent");
    assert!(!server.requests().iter().any(|request| {
        request.path.contains("/delete") || request.path.contains("clear-deleted-agent-link")
    }));

    // A hard miss on every lookup route lands on the same envelope, but keeps
    // the lookup-resilient contract: the delete endpoints stay authoritative
    // (attempts go out), and when they all miss the delete fails closed.
    let payload = response_payload(
        handle_delete_agent(&args(&[
            ("model_id", json!("fully-missing")),
            ("confirm", json!(true)),
        ]))
        .await
        .unwrap(),
    );
    assert_agent_not_found_envelope(&payload, "fully-missing");
    assert_eq!(payload["local_deleted"], json!(false));
    assert!(server
        .requests()
        .iter()
        .any(|request| request.path.contains("/delete")));
}

// --- Cross-chat messaging tools ---------------------------------------------

fn epoch_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock before epoch")
        .as_secs() as i64
}

fn chat_row(id: &str, title: &str, model_id: Option<&str>, created_at: i64) -> Value {
    json!({
        "id": id,
        "title": title,
        "model_id": model_id,
        "created_at": created_at,
        "updated_at": created_at,
    })
}

fn mock_page_number(path: &str) -> usize {
    path.split("page=")
        .nth(1)
        .and_then(|rest| rest.split('&').next())
        .and_then(|value| value.parse().ok())
        .unwrap_or(1)
}

#[tokio::test]
async fn handle_list_chats_filters_by_days_and_enriches_driver_kind() {
    let env = TestEnv::new("list-chats-filter");
    env.set_openwebui_token("token");
    let now = epoch_now();
    let server =
        MockServer::start(
            move |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", path) if path.starts_with("/api/v1/chats/list/user/human1?") => {
                    MockResponse::json(json!([
                        chat_row("chat-agent", "Agent chat", Some("portico_agent_x"), now - 100),
                        chat_row("chat-model", "Model chat", Some("gpt"), now - 200),
                        chat_row("chat-ghost", "Ghost chat", Some("ghost"), now - 300),
                        chat_row("chat-stale", "Old chat", Some("gpt"), now - 30 * 86_400),
                    ]))
                }
                ("GET", path) if path.starts_with("/api/models") => MockResponse::json(json!([
                    {
                        "id": "portico_agent_x",
                        "name": "Research Agent",
                        "info": { "base_model_id": "gpt" }
                    },
                    { "id": "gpt", "name": "GPT-5.6 Terra" }
                ])),
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "not found" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());

    let payload = response_payload(
        handle_list_chats(&args(&[("owner_user_id", json!("human1"))]))
            .await
            .unwrap(),
    );

    assert_eq!(payload["count"], json!(3));
    assert_eq!(payload["days"], json!(7));
    assert_eq!(payload["truncated"], json!(false));
    let chats = payload["chats"].as_array().unwrap();
    assert_eq!(chats.len(), 3);
    assert_eq!(chats[0]["id"], json!("chat-agent"));
    assert_eq!(chats[0]["driver"]["kind"], json!("agent"));
    assert_eq!(chats[0]["driver"]["name"], json!("Research Agent"));
    assert_eq!(chats[1]["driver"]["kind"], json!("model"));
    assert_eq!(chats[1]["driver"]["name"], json!("GPT-5.6 Terra"));
    assert_eq!(chats[2]["driver"]["kind"], json!("unknown"));
    assert_eq!(chats[2]["driver"]["name"], json!("ghost"));
    assert!(chats[0]["created_at_iso"]
        .as_str()
        .expect("iso timestamp")
        .contains('T'));

    let list_requests: Vec<_> = server
        .requests()
        .into_iter()
        .filter(|request| request.path.starts_with("/api/v1/chats/list/user/"))
        .collect();
    assert_eq!(list_requests.len(), 1);
    assert!(list_requests[0]
        .path
        .contains("order_by=created_at&direction=desc"));
}

#[tokio::test]
async fn handle_list_chats_early_stops_pagination_on_stale_page() {
    let env = TestEnv::new("list-chats-early-stop");
    env.set_openwebui_token("token");
    let now = epoch_now();
    let server = MockServer::start(move |request| {
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", path) if path.starts_with("/api/v1/chats/list/user/human1?") => {
                let rows: Vec<Value> = match mock_page_number(path) {
                    1 => (0..60)
                        .map(|index| {
                            chat_row(
                                &format!("chat-{index}"),
                                "Recent",
                                Some("gpt"),
                                now - 60 - index,
                            )
                        })
                        .collect(),
                    _ => vec![chat_row("chat-stale", "Old", Some("gpt"), now - 30 * 86_400)],
                };
                MockResponse::json(json!(rows))
            }
            ("GET", path) if path.starts_with("/api/models") => MockResponse::json(json!([])),
            _ => MockResponse {
                status: 404,
                body: json!({ "error": "not found" }),
            },
        }
    });
    env.set_openwebui_base_url(server.base_url());

    let payload = response_payload(
        handle_list_chats(&args(&[
            ("owner_user_id", json!("human1")),
            ("days", json!(14)),
        ]))
        .await
        .unwrap(),
    );

    assert_eq!(payload["count"], json!(60));
    assert_eq!(payload["days"], json!(14));
    assert_eq!(payload["truncated"], json!(false));
    let list_requests: Vec<_> = server
        .requests()
        .into_iter()
        .filter(|request| request.path.starts_with("/api/v1/chats/list/user/"))
        .collect();
    assert_eq!(list_requests.len(), 2);
}

#[tokio::test]
async fn handle_list_chats_caps_pagination_and_reports_truncation() {
    let env = TestEnv::new("list-chats-truncation");
    env.set_openwebui_token("token");
    let now = epoch_now();
    let server = MockServer::start(move |request| {
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", path) if path.starts_with("/api/v1/chats/list/user/human1?") => {
                let page = mock_page_number(path);
                let rows: Vec<Value> = (0..60)
                    .map(|index| {
                        chat_row(
                            &format!("chat-{page}-{index}"),
                            "Recent",
                            Some("gpt"),
                            now - 60,
                        )
                    })
                    .collect();
                MockResponse::json(json!(rows))
            }
            ("GET", path) if path.starts_with("/api/models") => MockResponse::json(json!([])),
            _ => MockResponse {
                status: 404,
                body: json!({ "error": "not found" }),
            },
        }
    });
    env.set_openwebui_base_url(server.base_url());

    let payload = response_payload(
        handle_list_chats(&args(&[("owner_user_id", json!("human1"))]))
            .await
            .unwrap(),
    );

    assert_eq!(payload["count"], json!(600));
    assert_eq!(payload["truncated"], json!(true));
    let list_requests: Vec<_> = server
        .requests()
        .into_iter()
        .filter(|request| request.path.starts_with("/api/v1/chats/list/user/"))
        .collect();
    assert_eq!(list_requests.len(), 10);
}

#[tokio::test]
async fn handle_list_chats_falls_back_to_primary_human_owner() {
    let env = TestEnv::new("list-chats-owner-fallback");
    env.set_openwebui_token("token");
    let now = epoch_now();
    let server = MockServer::start(move |request| {
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", path) if path.starts_with("/api/v1/users/") => {
                MockResponse::json(json!({
                    "users": [
                        { "id": "portico-service", "last_active_at": now },
                        { "id": "human1", "last_active_at": now - 50 },
                        { "id": "human2", "last_active_at": now - 500 }
                    ],
                    "total": 3
                }))
            }
            ("GET", path) if path.starts_with("/api/v1/chats/list/user/human1?") => {
                MockResponse::json(json!([chat_row(
                    "chat-1",
                    "Recent",
                    Some("gpt"),
                    now - 60
                )]))
            }
            ("GET", path) if path.starts_with("/api/models") => MockResponse::json(json!([])),
            _ => MockResponse {
                status: 404,
                body: json!({ "error": "not found" }),
            },
        }
    });
    env.set_openwebui_base_url(server.base_url());

    // No owner injected (e.g. curl invocation): resolve the most recently
    // active non-service user.
    let payload = response_payload(handle_list_chats(&args(&[])).await.unwrap());
    assert_eq!(payload["count"], json!(1));

    // Service principal injected (subagent child chat): same fallback.
    let payload = response_payload(
        handle_list_chats(&args(&[("owner_user_id", json!("portico-service"))]))
            .await
            .unwrap(),
    );
    assert_eq!(payload["count"], json!(1));
}

#[tokio::test]
async fn handle_list_chats_owner_fallback_accepts_bare_users_array() {
    let env = TestEnv::new("list-chats-owner-bare-array");
    env.set_openwebui_token("token");
    let now = epoch_now();
    let server = MockServer::start(move |request| {
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", path) if path.starts_with("/api/v1/users/") => MockResponse::json(json!([
                { "id": "portico-service", "last_active_at": now },
                { "id": "human1", "last_active_at": now - 50 }
            ])),
            ("GET", path) if path.starts_with("/api/v1/chats/list/user/human1?") => {
                MockResponse::json(json!([chat_row(
                    "chat-1",
                    "Recent",
                    Some("gpt"),
                    now - 60
                )]))
            }
            ("GET", path) if path.starts_with("/api/models") => MockResponse::json(json!([])),
            _ => MockResponse {
                status: 404,
                body: json!({ "error": "not found" }),
            },
        }
    });
    env.set_openwebui_base_url(server.base_url());

    let payload = response_payload(handle_list_chats(&args(&[])).await.unwrap());
    assert_eq!(payload["count"], json!(1));
}

fn queued_prompt_state(chat_id: &str) -> Value {
    json!({
        "chat_id": chat_id,
        "queued_prompts": [{ "id": "queued-item", "status": "queued" }],
        "pending_steer": null
    })
}

#[tokio::test]
async fn handle_send_message_to_chat_queues_prefixed_prompt() {
    let env = TestEnv::new("send-message-agent-prefix");
    env.set_openwebui_token("token");
    let server =
        MockServer::start(
            move |request| match (request.method.as_str(), request.path.as_str()) {
                ("POST", "/api/v1/chats/target-1/queued-prompts") => {
                    MockResponse::json(queued_prompt_state("target-1"))
                }
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "not found" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());

    let payload = response_payload(
        handle_send_message_to_chat(&args(&[
            ("target_chat_id", json!("target-1")),
            ("message", json!("Hello there")),
            ("source_chat_id", json!("source-1")),
            ("source_display_name", json!("Reviewer")),
            ("source_model_name", json!("Research Agent")),
            ("source_model_id", json!("portico_agent_research")),
            ("source_is_agent", json!(true)),
        ]))
        .await
        .unwrap(),
    );

    assert_eq!(payload["success"], json!(true));
    assert_eq!(payload["status"], json!("queued"));
    assert_eq!(payload["target_chat_id"], json!("target-1"));
    assert_eq!(payload["queued_prompts"], json!(1));
    let item_id = payload["item_id"].as_str().expect("item id");
    assert!(!item_id.is_empty());

    let requests = server.requests();
    assert_eq!(requests.len(), 1);
    let body: Value = serde_json::from_str(&requests[0].body).expect("request body JSON");
    assert_eq!(
        body["prompt"],
        json!("[Message from another chat: [[xchat:source-1|Reviewer|Research Agent|portico_agent_research|agent]]]\n\nHello there")
    );
    assert_eq!(body["request_context"], json!({}));
    assert_eq!(body["files"], json!([]));
    assert_eq!(body["id"], json!(item_id));
}

#[tokio::test]
async fn handle_send_message_to_chat_model_prefix_and_generic_fallbacks() {
    let env = TestEnv::new("send-message-prefix-variants");
    env.set_openwebui_token("token");
    let server =
        MockServer::start(
            move |request| match (request.method.as_str(), request.path.as_str()) {
                ("POST", "/api/v1/chats/target-1/queued-prompts") => {
                    MockResponse::json(queued_prompt_state("target-1"))
                }
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "not found" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());

    handle_send_message_to_chat(&args(&[
        ("target_chat_id", json!("target-1")),
        ("message", json!("ping")),
        ("source_chat_id", json!("source-1")),
        ("source_model_name", json!("GPT-5.6 Terra")),
        ("source_is_agent", json!(false)),
    ]))
    .await
    .unwrap();

    handle_send_message_to_chat(&args(&[
        ("target_chat_id", json!("target-1")),
        ("message", json!("ping")),
        ("source_chat_id", json!("source-1")),
    ]))
    .await
    .unwrap();

    handle_send_message_to_chat(&args(&[
        ("target_chat_id", json!("target-1")),
        ("message", json!("ping")),
    ]))
    .await
    .unwrap();

    let prompts: Vec<String> = server
        .requests()
        .iter()
        .map(|request| {
            serde_json::from_str::<Value>(&request.body).expect("body JSON")["prompt"]
                .as_str()
                .expect("prompt")
                .to_string()
        })
        .collect();
    assert_eq!(
        prompts,
        vec![
            // No display name injected → the sender reads as the root chat.
            "[Message from another chat: [[xchat:source-1|Orchestrator|GPT-5.6 Terra||model]]]\n\nping"
                .to_string(),
            "[Message from another chat: [[xchat:source-1|Orchestrator|||model]]]\n\nping".to_string(),
            "[Message from another chat]\n\nping".to_string(),
        ]
    );
}

#[tokio::test]
async fn cross_chat_prefix_escapes_token_breaking_characters() {
    let env = TestEnv::new("send-message-prefix-escaping");
    env.set_openwebui_token("token");
    let server =
        MockServer::start(
            move |request| match (request.method.as_str(), request.path.as_str()) {
                ("POST", "/api/v1/chats/target-1/queued-prompts") => {
                    MockResponse::json(queued_prompt_state("target-1"))
                }
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "not found" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());

    handle_send_message_to_chat(&args(&[
        ("target_chat_id", json!("target-1")),
        ("message", json!("ping")),
        ("source_chat_id", json!("source-1")),
        ("source_display_name", json!("Rev|iewer")),
        ("source_model_name", json!("GPT [v2] 50%")),
        ("source_model_id", json!("gpt|v2")),
    ]))
    .await
    .unwrap();

    let body: Value =
        serde_json::from_str(&server.requests()[0].body).expect("request body JSON");
    assert_eq!(
        body["prompt"],
        json!("[Message from another chat: [[xchat:source-1|Rev%7Ciewer|GPT %5Bv2%5D 50%25|gpt%7Cv2|model]]]\n\nping")
    );
}

#[tokio::test]
async fn handle_send_message_to_chat_rejects_self_send_and_empty_message() {
    let env = TestEnv::new("send-message-validation");
    env.set_openwebui_token("token");
    let server = MockServer::start(|_| MockResponse::json(json!({})));
    env.set_openwebui_base_url(server.base_url());

    let payload = response_payload(
        handle_send_message_to_chat(&args(&[
            ("target_chat_id", json!("chat-1")),
            ("message", json!("hello")),
            ("source_chat_id", json!("chat-1")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(payload["success"], json!(false));
    assert_eq!(payload["code"], json!("self_send"));

    let payload = response_payload(
        handle_send_message_to_chat(&args(&[
            ("target_chat_id", json!("chat-1")),
            ("message", json!("   ")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(payload["success"], json!(false));
    assert_eq!(payload["code"], json!("empty_message"));

    assert!(server.requests().is_empty());
}

#[tokio::test]
async fn handle_send_message_to_chat_maps_missing_target_to_structured_error() {
    let env = TestEnv::new("send-message-missing-target");
    env.set_openwebui_token("token");
    let server = MockServer::start(|_| MockResponse {
        status: 404,
        body: json!({ "detail": "Not found" }),
    });
    env.set_openwebui_base_url(server.base_url());

    let payload = response_payload(
        handle_send_message_to_chat(&args(&[
            ("target_chat_id", json!("ghost-chat")),
            ("message", json!("hello")),
            ("source_chat_id", json!("source-1")),
        ]))
        .await
        .unwrap(),
    );

    assert_eq!(payload["success"], json!(false));
    assert_eq!(payload["code"], json!("target_chat_not_found"));
    assert_eq!(payload["target_chat_id"], json!("ghost-chat"));
}

// --- get_chat_status ---------------------------------------------------------

#[tokio::test]
async fn handle_get_chat_status_reports_busy_and_idle_with_counts() {
    let env = TestEnv::new("get-chat-status");
    env.set_openwebui_token("token");
    let server = MockServer::start(|request| {
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/api/v1/chats/chat-busy/status") => MockResponse::json(json!({
                "chat_id": "chat-busy",
                "busy": true,
                "task_count": 1,
                "active_turn": false,
                "title": "Reviewer",
                "model_id": "gpt",
                "updated_at": 1754000000,
                "queued_prompt_count": 2,
                "has_pending_steer": false,
            })),
            ("GET", "/api/v1/chats/chat-idle/status") => MockResponse::json(json!({
                "chat_id": "chat-idle",
                "busy": false,
                "task_count": 0,
                "active_turn": false,
                "title": "Helper",
                "model_id": "claude",
                "updated_at": 1754000001,
                "queued_prompt_count": 0,
                "has_pending_steer": false,
            })),
            _ => MockResponse {
                status: 404,
                body: json!({ "detail": "Not found" }),
            },
        }
    });
    env.set_openwebui_base_url(server.base_url());

    let busy = response_payload(
        handle_get_chat_status(&args(&[("chat_id", json!("chat-busy"))]))
            .await
            .unwrap(),
    );
    assert_eq!(busy["success"], json!(true));
    assert_eq!(busy["busy"], json!(true));
    assert_eq!(busy["state"], json!("busy"));
    assert_eq!(busy["task_count"], json!(1));
    assert_eq!(busy["queued_prompt_count"], json!(2));
    assert_eq!(busy["title"], json!("Reviewer"));
    assert!(busy["note"].as_str().unwrap().contains("Do NOT wait or poll"));

    let idle = response_payload(
        handle_get_chat_status(&args(&[("chat_id", json!("chat-idle"))]))
            .await
            .unwrap(),
    );
    assert_eq!(idle["busy"], json!(false));
    assert_eq!(idle["state"], json!("idle"));
    assert_eq!(idle["model_id"], json!("claude"));
}

#[tokio::test]
async fn handle_get_chat_status_maps_missing_chat_to_structured_error() {
    let env = TestEnv::new("get-chat-status-missing");
    env.set_openwebui_token("token");
    let server = MockServer::start(|_| MockResponse {
        status: 404,
        body: json!({ "detail": "Not found" }),
    });
    env.set_openwebui_base_url(server.base_url());

    let payload = response_payload(
        handle_get_chat_status(&args(&[("chat_id", json!("ghost-chat"))]))
            .await
            .unwrap(),
    );
    assert_eq!(payload["success"], json!(false));
    assert_eq!(payload["code"], json!("chat_not_found"));
    assert_eq!(payload["chat_id"], json!("ghost-chat"));
}

// --- start_chat --------------------------------------------------------------

fn start_chat_created_response(chat_id: &str, owner: &str) -> Value {
    json!({
        "id": chat_id,
        "user_id": owner,
        "title": "New Chat",
        "chat": {},
        "updated_at": 0,
        "created_at": 0,
        "archived": false,
    })
}

#[tokio::test]
async fn handle_start_chat_creates_human_chat_and_queues_prefixed_first_prompt() {
    let env = TestEnv::new("start-chat-happy");
    env.set_openwebui_token("token");
    env.write_skill("docs", "Documentation writing", &[]);
    env.write_model_catalog(
        r#"model_list:
  - model_name: "GPT-5.6 Terra"
    picker:
      provider: openai
      tier: premium
    model_info:
      supports_reasoning: true
      reasoning_effort_options: ["low", "medium", "high"]
"#,
    );
    let server = MockServer::start(move |request| {
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", path) if path.starts_with("/api/models") => MockResponse::json(json!({ "data": [
                {
                    "id": "portico_agent_w",
                    "name": "Writer Agent",
                    "info": {
                        "base_model_id": "gpt",
                        "meta": {
                            "subagent_tool_server_ids": ["server:glean"],
                            "subagent_skill_ids": ["docs"]
                        }
                    }
                },
                { "id": "gpt", "name": "GPT-5.6 Terra" }
            ] })),
            ("POST", "/api/v1/chats/new") => {
                MockResponse::json(start_chat_created_response("new-chat-1", "human-1"))
            }
            ("POST", "/api/v1/chats/new-chat-1/queued-prompts") => {
                MockResponse::json(queued_prompt_state("new-chat-1"))
            }
            _ => MockResponse {
                status: 404,
                body: json!({ "error": "not found" }),
            },
        }
    });
    env.set_openwebui_base_url(server.base_url());

    let payload = response_payload(
        handle_start_chat(&args(&[
            ("model", json!("portico_agent_w")),
            ("prompt", json!("Write the doc")),
            ("display_name", json!("Writer")),
            ("tool_server_ids", json!(["server:slack"])),
            ("reasoning_effort", json!("high")),
            ("folder_name", json!("Research")),
            (
                "image_urls",
                json!(["http://localhost:9876/workspace/a.png"]),
            ),
            ("source_chat_id", json!("src-1")),
            ("source_display_name", json!("Orchestrator")),
            ("source_model_name", json!("Research Agent")),
            ("source_model_id", json!("portico_agent_r")),
            ("source_is_agent", json!(true)),
        ]))
        .await
        .unwrap(),
    );

    assert_eq!(payload["success"], json!(true));
    assert_eq!(payload["status"], json!("started"));
    assert_eq!(payload["chat_id"], json!("new-chat-1"));
    assert_eq!(payload["owner_user_id"], json!("human-1"));
    assert_eq!(payload["display_name"], json!("Writer"));
    assert_eq!(payload["model"], json!("portico_agent_w"));
    assert_eq!(payload["reasoning_effort"], json!("high"));
    assert_eq!(payload["folder_name"], json!("Research"));
    assert_eq!(payload["activated_skill_ids"], json!(["docs"]));

    let requests = server.requests();
    let create_request = requests
        .iter()
        .find(|request| request.path == "/api/v1/chats/new")
        .expect("chat creation request");
    let create_body: Value = serde_json::from_str(&create_request.body).expect("create body");
    assert_eq!(create_body["service_owner"], json!("primary-human"));
    assert_eq!(create_body["service_folder_name"], json!("Research"));
    assert_eq!(create_body["service_started_by_chat_id"], json!("src-1"));
    assert_eq!(create_body["service_pane_display_name"], json!("Writer"));
    assert_eq!(create_body["chat"]["models"], json!(["portico_agent_w"]));
    assert_eq!(create_body["chat"]["title"], json!("New Chat"));
    assert_eq!(create_body["chat"]["history"]["messages"], json!({}));
    assert_eq!(create_body["chat"]["params"]["reasoning_effort"], json!("high"));

    let queue_request = requests
        .iter()
        .find(|request| request.path.ends_with("/queued-prompts"))
        .expect("queued prompt request");
    let queue_body: Value = serde_json::from_str(&queue_request.body).expect("queue body");
    assert_eq!(
        queue_body["prompt"],
        json!("[Message from another chat: [[xchat:src-1|Orchestrator|Research Agent|portico_agent_r|agent]]]\n\nWrite the doc")
    );
    assert_eq!(
        queue_body["files"],
        json!([{ "type": "image", "url": "http://host.docker.internal:9876/workspace/a.png" }])
    );
    let request_context = &queue_body["request_context"];
    assert_eq!(request_context["selected_model_ids"], json!(["portico_agent_w"]));
    assert!(request_context["selected_model_items"]["portico_agent_w"].is_object());
    let tool_ids: Vec<String> = request_context["tool_ids"]
        .as_array()
        .expect("tool ids")
        .iter()
        .map(|value| value.as_str().unwrap().to_string())
        .collect();
    for expected in [
        "server:glean",
        "server:slack",
        "server:mcp-assistant",
        "server:subagents",
        "server:skills",
        "server:agent-vm",
    ] {
        assert!(tool_ids.contains(&expected.to_string()), "missing {expected}");
    }
    assert_eq!(
        request_context["reasoning_effort_by_model"],
        json!({ "0": "high" })
    );
    assert_eq!(
        request_context["background_tasks"],
        json!({
            "title_generation": true,
            "tags_generation": true,
            "follow_up_generation": true
        })
    );

    let seeded_tools = redis_get_string("chat_tools:new-chat-1")
        .unwrap()
        .expect("chat_tools seeded");
    assert!(seeded_tools.contains("server:glean"));
    assert_eq!(
        redis_get_string("chat_skills:new-chat-1").unwrap(),
        Some("[\"docs\"]".to_string())
    );
    assert_eq!(
        redis_get_string("subagent_explicit_skills:new-chat-1").unwrap(),
        Some("[\"docs\"]".to_string())
    );
    assert_eq!(redis_get_string("subagent_chat:new-chat-1").unwrap(), None);
}

#[tokio::test]
async fn handle_start_chat_uses_default_model_and_generic_prefix() {
    let env = TestEnv::new("start-chat-defaults");
    env.set_openwebui_token("token");
    let server = MockServer::start(move |request| {
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", path) if path.starts_with("/api/models") => MockResponse::json(json!({ "data": [
                { "id": "m1", "name": "Other Model" },
                { "id": "m2", "name": "Default Model", "is_default": true }
            ] })),
            ("POST", "/api/v1/chats/new") => {
                MockResponse::json(start_chat_created_response("new-chat-2", "human-1"))
            }
            ("POST", "/api/v1/chats/new-chat-2/queued-prompts") => {
                MockResponse::json(queued_prompt_state("new-chat-2"))
            }
            _ => MockResponse {
                status: 404,
                body: json!({ "error": "not found" }),
            },
        }
    });
    env.set_openwebui_base_url(server.base_url());

    let payload = response_payload(
        handle_start_chat(&args(&[
            ("prompt", json!("hello")),
            ("display_name", json!("Helper")),
            ("include_core_tools", json!(false)),
        ]))
        .await
        .unwrap(),
    );

    assert_eq!(payload["success"], json!(true));
    assert_eq!(payload["model"], json!("m2"));
    assert_eq!(payload["reasoning_effort"], Value::Null);
    // Omitted folder_name defaults to the shared subagent-chat folder.
    assert_eq!(payload["folder_name"], json!("Sub-agents"));

    let requests = server.requests();
    let create_body: Value = serde_json::from_str(
        &requests
            .iter()
            .find(|request| request.path == "/api/v1/chats/new")
            .expect("chat creation request")
            .body,
    )
    .expect("create body");
    assert_eq!(create_body["service_folder_name"], json!("Sub-agents"));
    // No source chat: the display name still rides along, but there is no
    // root link, so the backend never treats this as a tiling start.
    assert!(create_body.get("service_started_by_chat_id").is_none());
    assert_eq!(create_body["service_pane_display_name"], json!("Helper"));
    assert_eq!(create_body["chat"]["params"], json!({}));

    let queue_body: Value = serde_json::from_str(
        &requests
            .iter()
            .find(|request| request.path.ends_with("/queued-prompts"))
            .expect("queued prompt request")
            .body,
    )
    .expect("queue body");
    assert_eq!(
        queue_body["prompt"],
        json!("[Message from another chat]\n\nhello")
    );
    assert_eq!(queue_body["request_context"]["tool_ids"], json!([]));
    assert!(queue_body["request_context"]
        .get("reasoning_effort_by_model")
        .is_none());
}

#[tokio::test]
async fn handle_start_chat_validation_failures_make_no_chat_calls() {
    let env = TestEnv::new("start-chat-validation");
    env.set_openwebui_token("token");
    let server = MockServer::start(|request| {
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", path) if path.starts_with("/api/models") => {
                MockResponse::json(json!({ "data": [{ "id": "m1", "name": "Only Model" }] }))
            }
            _ => MockResponse {
                status: 404,
                body: json!({ "error": "not found" }),
            },
        }
    });
    env.set_openwebui_base_url(server.base_url());

    let payload = response_payload(
        handle_start_chat(&args(&[("prompt", json!("   "))]))
            .await
            .unwrap(),
    );
    assert_eq!(payload["success"], json!(false));
    assert_eq!(payload["code"], json!("empty_prompt"));
    assert!(server.requests().is_empty());

    // display_name is required and validated before any network call.
    let missing_name = response_payload(
        handle_start_chat(&args(&[("prompt", json!("hello"))]))
            .await
            .unwrap(),
    );
    assert_eq!(missing_name["success"], json!(false));
    assert_eq!(missing_name["code"], json!("invalid_display_name"));
    for bad in ["two words", "Orchestrator", "orchestrator", "x".repeat(25).as_str(), "a|b"] {
        let payload = response_payload(
            handle_start_chat(&args(&[
                ("prompt", json!("hello")),
                ("display_name", json!(bad)),
            ]))
            .await
            .unwrap(),
        );
        assert_eq!(
            payload["code"],
            json!("invalid_display_name"),
            "expected rejection for {bad:?}"
        );
    }
    assert!(server.requests().is_empty());

    let unknown_model = handle_start_chat(&args(&[
        ("prompt", json!("hello")),
        ("display_name", json!("Helper")),
        ("model", json!("ghost-model")),
    ]))
    .await;
    assert!(unknown_model.is_err(), "unknown model should be an error");

    let too_many_images: Vec<String> = (0..21).map(|index| format!("http://x/{index}.png")).collect();
    assert_err_contains(
        handle_start_chat(&args(&[
            ("prompt", json!("hello")),
            ("display_name", json!("Helper")),
            ("image_urls", json!(too_many_images)),
        ]))
        .await,
        "image_urls supports at most",
    );

    assert!(!server
        .requests()
        .iter()
        .any(|request| request.path.starts_with("/api/v1/chats/")));
}

#[tokio::test]
async fn handle_start_chat_maps_backend_policy_rejections_to_tool_errors() {
    for (code, remediation_needle) in [
        ("child_chat_cannot_start_chats", "orchestrator"),
        ("multi_chat_tiles_full", "tile grid is full"),
    ] {
        let env = TestEnv::new(&format!("start-chat-policy-{code}"));
        env.set_openwebui_token("token");
        let code_owned = code.to_string();
        let server = MockServer::start(move |request| {
            match (request.method.as_str(), request.path.as_str()) {
                ("GET", path) if path.starts_with("/api/models") => {
                    MockResponse::json(json!({ "data": [{ "id": "m1", "name": "Only Model" }] }))
                }
                ("POST", "/api/v1/chats/new") => MockResponse {
                    status: 400,
                    body: json!({ "detail": { "code": code_owned, "message": "refused" } }),
                },
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "not found" }),
                },
            }
        });
        env.set_openwebui_base_url(server.base_url());

        let payload = response_payload(
            handle_start_chat(&args(&[
                ("prompt", json!("hello")),
                ("display_name", json!("Helper")),
                ("model", json!("m1")),
                ("source_chat_id", json!("child-1")),
            ]))
            .await
            .unwrap(),
        );
        assert_eq!(payload["success"], json!(false), "{code}");
        assert_eq!(payload["code"], json!(code));
        assert_eq!(payload["error"], json!("refused"));
        assert!(
            payload["remediation"]
                .as_str()
                .unwrap()
                .to_ascii_lowercase()
                .contains(remediation_needle),
            "remediation for {code} should mention {remediation_needle}"
        );
        // The rejected creation must not queue a first prompt.
        assert!(!server
            .requests()
            .iter()
            .any(|request| request.path.ends_with("/queued-prompts")));
    }
}

#[tokio::test]
async fn handle_start_chat_returns_recoverable_error_when_first_prompt_fails() {
    let env = TestEnv::new("start-chat-first-prompt-failure");
    env.set_openwebui_token("token");
    let server = MockServer::start(move |request| {
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", path) if path.starts_with("/api/models") => {
                MockResponse::json(json!({ "data": [{ "id": "m1", "name": "Only Model" }] }))
            }
            ("POST", "/api/v1/chats/new") => {
                MockResponse::json(start_chat_created_response("orphan-chat", "human-1"))
            }
            ("POST", "/api/v1/chats/orphan-chat/queued-prompts") => MockResponse {
                status: 500,
                body: json!({ "detail": "boom" }),
            },
            _ => MockResponse {
                status: 404,
                body: json!({ "error": "not found" }),
            },
        }
    });
    env.set_openwebui_base_url(server.base_url());

    let payload = response_payload(
        handle_start_chat(&args(&[
            ("display_name", json!("Helper")),
            ("prompt", json!("hello")),
            ("model", json!("m1")),
        ]))
        .await
        .unwrap(),
    );

    assert_eq!(payload["success"], json!(false));
    assert_eq!(payload["code"], json!("first_prompt_failed"));
    assert_eq!(payload["chat_id"], json!("orphan-chat"));
    assert!(payload["remediation"]
        .as_str()
        .expect("remediation")
        .contains("subagents_send_message_to_chat"));
    // Redis was seeded before the queue attempt, so a retry via
    // send_message_to_chat inherits the chat's capability keys.
    assert!(redis_get_string("chat_tools:orphan-chat").unwrap().is_some());
}

#[tokio::test]
async fn prepare_without_folder_skips_folder_and_user_lookup() {
    let env = TestEnv::new("prepare-without-folder");
    env.set_openwebui_token("token");
    let server = MockServer::start(|request| {
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", path) if path.starts_with("/api/models") => {
                MockResponse::json(json!({ "data": [{ "id": "m1", "name": "Only Model" }] }))
            }
            _ => MockResponse {
                status: 404,
                body: json!({ "error": "not found" }),
            },
        }
    });
    env.set_openwebui_base_url(server.base_url());

    let prepared = prepare_subagent_request_without_folder(RunSubagentRequest {
        model: Some("m1".to_string()),
        prompt: "hello".to_string(),
        ..RunSubagentRequest::default()
    })
    .await
    .unwrap();

    assert_eq!(prepared.model, "m1");
    assert_eq!(prepared.folder_id, "");
    assert!(!server.requests().iter().any(|request| {
        request.path.starts_with("/api/v1/folders") || request.path.starts_with("/api/v1/auths")
    }));
}

fn write_workspace_settings(settings: Value) {
    let settings_path = chat_workspace_settings_path().unwrap();
    fs::create_dir_all(settings_path.parent().unwrap()).unwrap();
    fs::write(
        &settings_path,
        serde_json::to_string_pretty(&settings).unwrap(),
    )
    .unwrap();
}

fn read_workspace_settings_value() -> Value {
    serde_json::from_str(
        &fs::read_to_string(chat_workspace_settings_path().unwrap())
            .expect("workspace settings should exist"),
    )
    .expect("workspace settings should be JSON")
}

fn start_chat_workspace_mock(created_chat_id: &'static str) -> MockServer {
    MockServer::start(move |request| {
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", path) if path.starts_with("/api/models") => {
                MockResponse::json(json!({ "data": [{ "id": "m1", "name": "Only Model" }] }))
            }
            ("POST", "/api/v1/chats/new") => {
                MockResponse::json(start_chat_created_response(created_chat_id, "human-1"))
            }
            ("POST", path)
                if path.starts_with("/api/v1/chats/") && path.ends_with("/queued-prompts") =>
            {
                MockResponse::json(queued_prompt_state(created_chat_id))
            }
            _ => MockResponse {
                status: 404,
                body: json!({ "error": "not found" }),
            },
        }
    })
}

#[tokio::test]
async fn handle_start_chat_links_workspace_to_source_root() {
    let env = TestEnv::new("start-chat-workspace-link");
    env.set_openwebui_token("token");
    write_workspace_settings(json!({
        "chats": {
            "source-1": {
                "source": "custom",
                "host_path": "/tmp/source root dir",
                "selected_at": "2026-08-05T00:00:00.000Z"
            }
        }
    }));
    let server = start_chat_workspace_mock("new-chat-ws");
    env.set_openwebui_base_url(server.base_url());

    let payload = response_payload(
        handle_start_chat(&args(&[
            ("display_name", json!("Helper")),
            ("prompt", json!("hello")),
            ("model", json!("m1")),
            ("source_chat_id", json!("source-1")),
        ]))
        .await
        .unwrap(),
    );

    assert_eq!(payload["success"], json!(true));
    assert_eq!(payload["workspace_shared"], json!(true));
    assert_eq!(payload["workspace_root_chat_id"], json!("source-1"));
    assert_eq!(payload["workspace_host_path"], json!("/tmp/source root dir"));

    let settings = read_workspace_settings_value();
    let entry = &settings["chats"]["new-chat-ws"];
    assert_eq!(entry["source"], json!("custom"));
    assert_eq!(entry["linked_workspace"], json!(true));
    assert_eq!(entry["host_path"], json!("/tmp/source root dir"));
    assert_eq!(entry["root_parent_chat_id"], json!("source-1"));
    assert_eq!(entry["inherited_from_chat_id"], json!("source-1"));
    assert_eq!(entry.get("inherited_workspace"), None);
}

#[tokio::test]
async fn handle_start_chat_workspace_link_flattens_linked_source() {
    let env = TestEnv::new("start-chat-workspace-flatten");
    env.set_openwebui_token("token");
    // The source chat is itself a started chat linked to true-root.
    write_workspace_settings(json!({
        "chats": {
            "source-linked": {
                "source": "custom",
                "host_path": "/tmp/stale-snapshot",
                "linked_workspace": true,
                "inherited_from_chat_id": "true-root",
                "root_parent_chat_id": "true-root"
            }
        }
    }));
    let server = start_chat_workspace_mock("new-chat-flat");
    env.set_openwebui_base_url(server.base_url());

    let payload = response_payload(
        handle_start_chat(&args(&[
            ("display_name", json!("Helper")),
            ("prompt", json!("hello")),
            ("model", json!("m1")),
            ("source_chat_id", json!("source-linked")),
        ]))
        .await
        .unwrap(),
    );

    let expected_root_dir = env.root.join("workspaces").join("true-root");
    assert_eq!(payload["workspace_shared"], json!(true));
    assert_eq!(payload["workspace_root_chat_id"], json!("true-root"));
    assert_eq!(
        payload["workspace_host_path"],
        json!(expected_root_dir.to_string_lossy().to_string())
    );

    let settings = read_workspace_settings_value();
    let entry = &settings["chats"]["new-chat-flat"];
    assert_eq!(entry["root_parent_chat_id"], json!("true-root"));
    assert_eq!(entry["inherited_from_chat_id"], json!("source-linked"));
}

#[tokio::test]
async fn handle_start_chat_workspace_sharing_opt_out_and_missing_source() {
    let env = TestEnv::new("start-chat-workspace-opt-out");
    env.set_openwebui_token("token");
    let server = start_chat_workspace_mock("new-chat-solo");
    env.set_openwebui_base_url(server.base_url());

    // share_workspace: false → no link even with a source chat.
    let payload = response_payload(
        handle_start_chat(&args(&[
            ("display_name", json!("Helper")),
            ("prompt", json!("hello")),
            ("model", json!("m1")),
            ("source_chat_id", json!("source-1")),
            ("share_workspace", json!(false)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(payload["workspace_shared"], json!(false));
    assert_eq!(payload["workspace_root_chat_id"], Value::Null);
    assert!(!chat_workspace_settings_path().unwrap().exists());

    // No source chat (e.g. direct invocation) → no link either.
    let payload = response_payload(
        handle_start_chat(&args(&[
            ("prompt", json!("hello")),
            ("display_name", json!("Helper")),
            ("model", json!("m1")),
        ]))
            .await
            .unwrap(),
    );
    assert_eq!(payload["workspace_shared"], json!(false));
    assert!(!chat_workspace_settings_path().unwrap().exists());
}
