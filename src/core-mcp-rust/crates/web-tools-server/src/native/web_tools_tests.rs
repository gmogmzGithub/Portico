use super::*;
use crate::native::TEST_ENV_LOCK;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::sync::MutexGuard;
use std::thread;

struct EnvGuard {
    _guard: MutexGuard<'static, ()>,
    vars: Vec<(&'static str, Option<String>)>,
}

impl EnvGuard {
    fn set(pairs: &[(&'static str, &str)]) -> Self {
        let guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        reset_web_tools_config();
        let mut vars = Vec::new();
        for (key, value) in pairs {
            vars.push((*key, env::var(key).ok()));
            env::set_var(key, value);
        }
        Self {
            _guard: guard,
            vars,
        }
    }

    fn set_with_clears(pairs: &[(&'static str, &str)], clear_keys: &[&'static str]) -> Self {
        let guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        reset_web_tools_config();
        let mut vars = Vec::new();
        for key in clear_keys {
            vars.push((*key, env::var(key).ok()));
            env::remove_var(key);
        }
        for (key, value) in pairs {
            if !vars.iter().any(|(saved_key, _)| saved_key == key) {
                vars.push((*key, env::var(key).ok()));
            }
            env::set_var(key, value);
        }
        Self {
            _guard: guard,
            vars,
        }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (key, previous) in self.vars.drain(..) {
            if let Some(value) = previous {
                env::set_var(key, value);
            } else {
                env::remove_var(key);
            }
        }
    }
}

#[derive(Debug)]
struct CapturedRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Value,
}

fn parse_response_payload(response: Value) -> Value {
    serde_json::from_str(
        response["content"][0]["text"]
            .as_str()
            .expect("missing response text"),
    )
    .expect("invalid JSON payload")
}

fn read_http_request(stream: &mut std::net::TcpStream) -> CapturedRequest {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 1024];
    let header_end;
    loop {
        let read = stream.read(&mut chunk).expect("failed to read request");
        assert!(read > 0, "client closed connection before sending request");
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(index) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            header_end = index + 4;
            break;
        }
    }

    let header_text =
        String::from_utf8(buffer[..header_end].to_vec()).expect("invalid HTTP headers");
    let mut lines = header_text.split("\r\n").filter(|line| !line.is_empty());
    let request_line = lines.next().expect("missing request line");
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default().to_string();
    let path = request_parts.next().unwrap_or_default().to_string();

    let mut headers = HashMap::new();
    let mut content_length = 0_usize;
    for line in lines {
        let (name, value) = line.split_once(':').expect("invalid header line");
        let normalized = name.trim().to_ascii_lowercase();
        let trimmed = value.trim().to_string();
        if normalized == "content-length" {
            content_length = trimmed.parse::<usize>().expect("invalid content length");
        }
        headers.insert(normalized, trimmed);
    }

    let mut body = buffer[header_end..].to_vec();
    while body.len() < content_length {
        let read = stream
            .read(&mut chunk)
            .expect("failed to read request body");
        assert!(
            read > 0,
            "client closed connection before body was complete"
        );
        body.extend_from_slice(&chunk[..read]);
    }

    CapturedRequest {
        method,
        path,
        headers,
        body: serde_json::from_slice(&body[..content_length]).expect("invalid request JSON"),
    }
}

fn respond_json(stream: &mut std::net::TcpStream, status: &str, body: &Value) {
    let encoded = serde_json::to_vec(body).expect("failed to encode response body");
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        encoded.len()
    );
    stream
        .write_all(response.as_bytes())
        .and_then(|_| stream.write_all(&encoded))
        .expect("failed to write response");
}

fn serve_once(status: &'static str, body: Value) -> (String, mpsc::Receiver<CapturedRequest>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("failed to bind listener");
    let address = format!(
        "http://{}",
        listener.local_addr().expect("missing listener addr")
    );
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("failed to accept connection");
        let request = read_http_request(&mut stream);
        let _ = tx.send(request);
        respond_json(&mut stream, status, &body);
    });
    (address, rx)
}

fn args(entries: &[(&str, Value)]) -> Map<String, Value> {
    entries
        .iter()
        .map(|(key, value)| ((*key).to_string(), value.clone()))
        .collect()
}

#[test]
fn insert_header_rejects_invalid_name_and_value() {
    let mut headers = HeaderMap::new();
    insert_header(&mut headers, "x-test", "value").expect("valid header");
    assert_eq!(headers.get("x-test").unwrap(), "value");

    let invalid_name = insert_header(&mut headers, "bad header", "value").unwrap_err();
    assert!(invalid_name.to_string().contains("invalid header name"));

    let invalid_value = insert_header(&mut headers, "x-test-two", "bad\nvalue").unwrap_err();
    assert!(invalid_value.to_string().contains("invalid header value"));
}

#[test]
fn env_helpers_return_defaults_and_overrides() {
    let _env = EnvGuard::set_with_clears(&[], &["WEB_TOOLS_OPENAI_MODEL", "WEB_TOOLS_PROXY_URL"]);
    assert_eq!(web_tools_openai_model(), "gpt-5.6-sol");
    assert_eq!(
        web_tools_proxy_url(),
        "https://api.openai.com/v1"
    );
    assert_eq!(web_tools_request_timeout_seconds(), 300.0);

    env::set_var("WEB_TOOLS_OPENAI_MODEL", "gpt-override");
    env::set_var("WEB_TOOLS_PROXY_URL", "http://proxy.override");
    assert_eq!(web_tools_openai_model(), "gpt-5.6-sol");
    assert_eq!(
        web_tools_proxy_url(),
        "https://api.openai.com/v1"
    );

    reset_web_tools_config();
    assert_eq!(web_tools_openai_model(), "gpt-override");
    assert_eq!(web_tools_proxy_url(), "http://proxy.override");
}

#[test]
fn web_tools_config_caches_loaded_environment_until_reset() {
    let _env = EnvGuard::set(&[
        ("WEB_TOOLS_PROXY_URL", "http://proxy.initial"),
        ("WEB_TOOLS_OPENAI_MODEL", "gpt-initial"),
        ("PORTICO_LLM_API_KEY", "secret-1"),
        ("PORTICO_USER_ID", "user-1"),
        ("PORTICO_REDACT_ALLOW", "example.com"),
        ("PORTICO_BUILD_TRACK", "dev"),
    ]);

    let first = web_tools_config();
    assert_eq!(first.proxy_url, "http://proxy.initial");
    assert_eq!(first.openai_model, "gpt-initial");
    assert_eq!(first.api_key, "secret-1");

    env::set_var("WEB_TOOLS_PROXY_URL", "http://proxy.changed");
    env::set_var("WEB_TOOLS_OPENAI_MODEL", "gpt-changed");
    env::set_var("PORTICO_LLM_API_KEY", "secret-2");

    let cached = web_tools_config();
    assert_eq!(cached.proxy_url, "http://proxy.initial");
    assert_eq!(cached.openai_model, "gpt-initial");
    assert_eq!(cached.api_key, "secret-1");

    reset_web_tools_config();
    let reloaded = web_tools_config();
    assert_eq!(reloaded.proxy_url, "http://proxy.changed");
    assert_eq!(reloaded.openai_model, "gpt-changed");
    assert_eq!(reloaded.api_key, "secret-2");
}

#[test]
fn api_key_falls_back_to_portico_llm_api_key_file() {
    let secret_path =
        env::temp_dir().join(format!("web-tools-api-key-{}.secret", std::process::id()));
    std::fs::write(&secret_path, "  file-secret-key\n").expect("write secret file");

    let _env = EnvGuard::set_with_clears(
        &[(
            "PORTICO_LLM_API_KEY_FILE",
            secret_path.to_str().expect("secret path is valid UTF-8"),
        )],
        &["PORTICO_LLM_API_KEY"],
    );

    assert_eq!(web_tools_config().api_key, "file-secret-key");

    let _ = std::fs::remove_file(&secret_path);
}

#[test]
fn api_key_prefers_plain_env_over_file() {
    let secret_path = env::temp_dir().join(format!(
        "web-tools-api-key-plain-{}.secret",
        std::process::id()
    ));
    std::fs::write(&secret_path, "file-secret-key").expect("write secret file");

    let _env = EnvGuard::set(&[
        ("PORTICO_LLM_API_KEY", "plain-key"),
        (
            "PORTICO_LLM_API_KEY_FILE",
            secret_path.to_str().expect("secret path is valid UTF-8"),
        ),
    ]);

    assert_eq!(web_tools_config().api_key, "plain-key");

    let _ = std::fs::remove_file(&secret_path);
}

#[tokio::test]
async fn handle_web_search_builds_request_and_parses_response() {
    let response_body = json!({
        "output": [
            {"type": "web_search_call"},
            {"type": "message", "content": [
                {
                    "type": "output_text",
                    "text": "Search result summary.",
                    "annotations": [
                        {
                            "type": "url_citation",
                            "url": "https://example.com/result",
                            "title": "Example Result",
                            "start_index": 0,
                            "end_index": 6
                        }
                    ]
                }
            ]}
        ],
        "usage": {"input_tokens": 11, "output_tokens": 22}
    });
    let (base_url, captured) = serve_once("200 OK", response_body);
    let _env = EnvGuard::set(&[
        ("WEB_TOOLS_PROXY_URL", &base_url),
        ("WEB_TOOLS_OPENAI_MODEL", "gpt-test"),
        ("PORTICO_LLM_API_KEY", "secret"),
        ("PORTICO_USER_ID", "user-123"),
        ("PORTICO_REDACT_ALLOW", "example.com"),
        ("PORTICO_BUILD_TRACK", "dev"),
    ]);

    let result = handle_web_search(&args(&[
        ("query", json!("rust mcp")),
        ("allowed_domains", json!(["example.com"])),
        (
            "user_location",
            json!({
                "country": "US",
                "city": "New York",
                "region": "NY",
                "timezone": "America/New_York"
            }),
        ),
    ]))
    .await
    .expect("web search request should succeed");

    let payload = parse_response_payload(result);
    assert_eq!(payload["success"], json!(true));
    assert_eq!(payload["query"], json!("rust mcp"));
    assert_eq!(payload["response"], json!("Search result summary."));
    assert_eq!(
        payload["citations"][0]["url"],
        json!("https://example.com/result")
    );
    assert_eq!(payload["usage"]["input_tokens"], json!(11));
    assert_eq!(payload["usage"]["output_tokens"], json!(22));
    assert_eq!(payload["usage"]["web_search_calls"], json!(1));
    assert_eq!(payload["model"], json!("gpt-test"));

    let request = captured.recv().expect("missing captured request");
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/responses");
    assert_eq!(
        request.headers.get("authorization").unwrap(),
        "Bearer secret"
    );
    assert_eq!(request.headers.get("x-portico-userid").unwrap(), "user-123");
    assert_eq!(
        request.headers.get("x-portico-redact-allow").unwrap(),
        "example.com"
    );
    assert_eq!(
        request.headers.get("x-portico-appid").unwrap(),
        "portico"
    );
    assert_eq!(request.headers.get("x-portico-track").unwrap(), "dev");
    assert_eq!(
        request.headers.get("x-portico-log-request").unwrap(),
        "false"
    );
    assert_eq!(
        request.headers.get("x-portico-log-response").unwrap(),
        "false"
    );
    assert_eq!(request.body["model"], json!("gpt-test"));
    assert_eq!(
        request.body["tools"][0]["filters"]["allowed_domains"],
        json!(["example.com"])
    );
    assert_eq!(
        request.body["tools"][0]["user_location"],
        json!({
            "type": "approximate",
            "country": "US",
            "city": "New York",
            "region": "NY",
            "timezone": "America/New_York"
        })
    );
}

#[tokio::test]
async fn handle_web_search_supports_blocked_domains_and_default_usage() {
    let (base_url, captured) = serve_once(
        "200 OK",
        json!({
            "output": [
                {"type": "message", "content": [
                    {"type": "output_text", "text": "Blocked-domain answer", "annotations": []}
                ]}
            ]
        }),
    );
    let _env = EnvGuard::set(&[
        ("WEB_TOOLS_PROXY_URL", &format!("{base_url}/")),
        ("WEB_TOOLS_OPENAI_MODEL", "gpt-minimal"),
        ("PORTICO_LLM_API_KEY", ""),
        ("PORTICO_USER_ID", ""),
        ("PORTICO_REDACT_ALLOW", "*"),
        ("PORTICO_BUILD_TRACK", "sandbox"),
    ]);

    let result = handle_web_search(&args(&[
        ("query", json!("blocked domains")),
        ("allowed_domains", json!([])),
        ("blocked_domains", json!(["example.org"])),
        ("user_location", json!({})),
    ]))
    .await
    .expect("web search request should succeed");

    let payload = parse_response_payload(result);
    assert_eq!(payload["response"], json!("Blocked-domain answer"));
    assert_eq!(payload["usage"], json!({}));

    let request = captured.recv().expect("missing captured request");
    assert!(!request.headers.contains_key("authorization"));
    assert_eq!(
        request.body["tools"][0]["filters"]["blocked_domains"],
        json!(["example.org"])
    );
    assert!(request.body["tools"][0].get("user_location").is_none());
}

#[tokio::test]
async fn handle_web_search_omits_empty_domain_filters_and_empty_location() {
    let (base_url, captured) = serve_once(
        "200 OK",
        json!({
            "output": [
                {"type": "message", "content": [
                    {"type": "output_text", "text": "No filters", "annotations": []}
                ]}
            ]
        }),
    );
    let _env = EnvGuard::set(&[
        ("WEB_TOOLS_PROXY_URL", &base_url),
        ("WEB_TOOLS_OPENAI_MODEL", "gpt-empty"),
        ("PORTICO_LLM_API_KEY", ""),
        ("PORTICO_USER_ID", ""),
        ("PORTICO_REDACT_ALLOW", "*"),
        ("PORTICO_BUILD_TRACK", "sandbox"),
    ]);

    let result = handle_web_search(&args(&[
        ("query", json!("empty filters")),
        ("allowed_domains", json!([])),
        ("blocked_domains", json!([])),
        ("user_location", json!({})),
    ]))
    .await
    .expect("web search request should succeed");

    let payload = parse_response_payload(result);
    assert_eq!(payload["response"], json!("No filters"));
    assert_eq!(payload["usage"], json!({}));

    let request = captured.recv().expect("missing captured request");
    assert_eq!(request.body["tools"][0], json!({ "type": "web_search" }));
}

#[tokio::test]
async fn handle_web_search_uses_default_headers_and_ignores_non_text_blocks() {
    let (base_url, captured) = serve_once(
        "200 OK",
        json!({
            "output": [
                {"type": "other"},
                {"type": "message", "content": [
                    {"type": "tool_result", "text": "ignore me"},
                    {"type": "output_text", "text": "Kept text.", "annotations": []}
                ]}
            ]
        }),
    );
    let _env = EnvGuard::set(&[
        ("WEB_TOOLS_PROXY_URL", &base_url),
        ("WEB_TOOLS_OPENAI_MODEL", "gpt-defaults"),
    ]);

    let result = handle_web_search(&args(&[("query", json!("defaults"))]))
        .await
        .expect("default web search should succeed");
    let payload = parse_response_payload(result);
    assert_eq!(payload["response"], json!("Kept text."));
    assert_eq!(payload["usage"], json!({}));

    let request = captured.recv().expect("missing captured request");
    assert_eq!(request.headers.get("x-portico-userid").unwrap(), "");
    assert_eq!(request.headers.get("x-portico-redact-allow").unwrap(), "*");
    assert_eq!(request.headers.get("x-portico-track").unwrap(), "sandbox");
    assert!(!request.headers.contains_key("authorization"));
}

#[tokio::test]
async fn handle_web_search_applies_the_configured_service_tier() {
    let (base_url, captured) = serve_once(
        "200 OK",
        json!({
            "output": [
                {"type": "message", "content": [
                    {"type": "output_text", "text": "Fast answer", "annotations": []}
                ]}
            ]
        }),
    );
    let _env = EnvGuard::set(&[
        ("WEB_TOOLS_PROXY_URL", &base_url),
        ("WEB_TOOLS_OPENAI_MODEL", "gpt-fast"),
        ("WEB_TOOLS_SERVICE_TIER", " priority "),
        ("PORTICO_LLM_API_KEY", ""),
        ("PORTICO_USER_ID", ""),
        ("PORTICO_REDACT_ALLOW", "*"),
        ("PORTICO_BUILD_TRACK", "sandbox"),
    ]);

    let result = handle_web_search(&args(&[("query", json!("fast mode"))]))
        .await
        .expect("web search request should succeed");
    let payload = parse_response_payload(result);
    assert_eq!(payload["response"], json!("Fast answer"));

    let request = captured.recv().expect("missing captured request");
    assert_eq!(request.body["service_tier"], json!("priority"));
}

#[tokio::test]
async fn handle_web_search_omits_service_tier_when_unset_or_off() {
    {
        let (base_url, captured) = serve_once(
            "200 OK",
            json!({
                "output": [
                    {"type": "message", "content": [
                        {"type": "output_text", "text": "Standard answer", "annotations": []}
                    ]}
                ]
            }),
        );
        let _env = EnvGuard::set_with_clears(
            &[
                ("WEB_TOOLS_PROXY_URL", &base_url),
                ("WEB_TOOLS_OPENAI_MODEL", "gpt-standard"),
            ],
            &["WEB_TOOLS_SERVICE_TIER"],
        );

        handle_web_search(&args(&[("query", json!("standard"))]))
            .await
            .expect("web search request should succeed");
        let request = captured.recv().expect("missing captured request");
        assert!(request.body.get("service_tier").is_none());
    }

    {
        let (base_url, captured) = serve_once(
            "200 OK",
            json!({
                "output": [
                    {"type": "message", "content": [
                        {"type": "output_text", "text": "Opted out", "annotations": []}
                    ]}
                ]
            }),
        );
        let _env = EnvGuard::set(&[
            ("WEB_TOOLS_PROXY_URL", &base_url),
            ("WEB_TOOLS_OPENAI_MODEL", "gpt-standard"),
            ("WEB_TOOLS_SERVICE_TIER", "off"),
        ]);

        handle_web_search(&args(&[("query", json!("opted out"))]))
            .await
            .expect("web search request should succeed");
        let request = captured.recv().expect("missing captured request");
        assert!(request.body.get("service_tier").is_none());
    }
}

#[tokio::test]
async fn handle_web_search_rejects_missing_query_and_proxy_errors() {
    let missing_query = parse_response_payload(handle_web_search(&Map::new()).await.unwrap());
    assert_eq!(missing_query["success"], json!(false));
    assert_eq!(missing_query["tool"], json!("web_search"));
    assert_eq!(missing_query["error"], json!("'query'"));
    assert_eq!(missing_query["error_type"], json!("KeyError"));

    let conflicting_domain_filters = parse_response_payload(
        handle_web_search(&args(&[
            ("query", json!("conflicting filters")),
            ("allowed_domains", json!(["wikipedia.org"])),
            ("blocked_domains", json!(["wikipedia.org"])),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(conflicting_domain_filters["success"], json!(false));
    assert_eq!(conflicting_domain_filters["tool"], json!("web_search"));
    assert_eq!(
        conflicting_domain_filters["error"],
        json!("allowed_domains and blocked_domains cannot be used together")
    );
    assert_eq!(
        conflicting_domain_filters["error_type"],
        json!("ValueError")
    );

    let (base_url, _) = serve_once("500 Internal Server Error", json!({"error": "nope"}));
    let _env = EnvGuard::set(&[
        ("WEB_TOOLS_PROXY_URL", &base_url),
        ("WEB_TOOLS_OPENAI_MODEL", "gpt-fail"),
        ("PORTICO_LLM_API_KEY", ""),
        ("PORTICO_USER_ID", ""),
        ("PORTICO_REDACT_ALLOW", "*"),
        ("PORTICO_BUILD_TRACK", "sandbox"),
    ]);

    let proxy_error = parse_response_payload(
        handle_web_search(&args(&[("query", json!("failure"))]))
            .await
            .unwrap(),
    );
    let error_text = proxy_error["error"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    assert!(
        error_text.contains("web search proxy returned an error")
            || error_text.contains("failed to execute web search")
    );
    assert_eq!(proxy_error["success"], json!(false));
    assert_eq!(proxy_error["tool"], json!("web_search"));
    assert_eq!(proxy_error["error_type"], json!("RuntimeError"));
}

#[tokio::test]
async fn handle_web_search_surfaces_invalid_env_header_values() {
    let _env = EnvGuard::set(&[
        ("WEB_TOOLS_PROXY_URL", "http://proxy.invalid"),
        ("WEB_TOOLS_OPENAI_MODEL", "gpt-invalid-header"),
        ("PORTICO_USER_ID", "bad\nuser"),
    ]);

    let payload = parse_response_payload(
        handle_web_search(&args(&[("query", json!("bad header"))]))
            .await
            .expect("web search error response"),
    );

    assert_eq!(payload["success"], json!(false));
    assert_eq!(payload["tool"], json!("web_search"));
    assert_eq!(payload["error_type"], json!("RuntimeError"));
    assert!(payload["error"]
        .as_str()
        .unwrap_or_default()
        .contains("invalid header value for x-portico-userid"));
}

#[tokio::test]
async fn handle_web_search_handles_missing_text_and_partial_citation_fields() {
    let (base_url, _) = serve_once(
        "200 OK",
        json!({
            "output": [
                {"type": "web_search_call"},
                {"type": "message", "content": [
                    {
                        "type": "output_text",
                        "annotations": [
                            {
                                "type": "url_citation",
                                "url": "https://example.com/partial"
                            }
                        ]
                    }
                ]}
            ]
        }),
    );
    let _env = EnvGuard::set(&[
        ("WEB_TOOLS_PROXY_URL", &base_url),
        ("WEB_TOOLS_OPENAI_MODEL", "gpt-partial"),
    ]);

    let result = handle_web_search(&args(&[("query", json!("partial citation"))]))
        .await
        .expect("web search request should succeed");
    let payload = parse_response_payload(result);

    assert_eq!(payload["success"], json!(true));
    assert_eq!(payload["response"], json!(""));
    assert_eq!(
        payload["citations"][0]["url"],
        json!("https://example.com/partial")
    );
    assert_eq!(payload["citations"][0]["title"], json!(""));
    assert_eq!(payload["citations"][0]["start_index"], Value::Null);
    assert_eq!(payload["citations"][0]["end_index"], Value::Null);
}

#[tokio::test]
async fn handle_web_search_ignores_malformed_optional_inputs_and_keeps_partial_location() {
    let (base_url, captured) = serve_once(
        "200 OK",
        json!({
            "output": [
                {"type": "message", "content": [
                    {"type": "output_text", "text": "Partial location", "annotations": []}
                ]}
            ],
            "usage": {"input_tokens": 3, "output_tokens": 5}
        }),
    );
    let _env = EnvGuard::set(&[
        ("WEB_TOOLS_PROXY_URL", &base_url),
        ("WEB_TOOLS_OPENAI_MODEL", "gpt-partial-location"),
        ("PORTICO_LLM_API_KEY", ""),
        ("PORTICO_USER_ID", "user-7"),
        ("PORTICO_REDACT_ALLOW", "*"),
        ("PORTICO_BUILD_TRACK", "sandbox"),
    ]);

    let result = handle_web_search(&args(&[
        ("query", json!("partial location")),
        ("allowed_domains", json!("example.com")),
        ("blocked_domains", json!("example.org")),
        (
            "user_location",
            json!({
                "country": "US",
                "ignored": "value"
            }),
        ),
    ]))
    .await
    .expect("web search request should succeed");

    let payload = parse_response_payload(result);
    assert_eq!(payload["success"], json!(true));
    assert_eq!(payload["response"], json!("Partial location"));
    assert_eq!(payload["usage"]["web_search_calls"], json!(0));
    assert_eq!(payload["model"], json!("gpt-partial-location"));

    let request = captured.recv().expect("missing captured request");
    assert!(request.body["tools"][0].get("filters").is_none());
    assert_eq!(
        request.body["tools"][0]["user_location"],
        json!({
            "type": "approximate",
            "country": "US"
        })
    );
}
