use super::*;
use crate::TEST_ENV_LOCK;
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;

struct RootEnv {
    _guard: MutexGuard<'static, ()>,
    root: PathBuf,
    previous_cwd: PathBuf,
    previous_container_root: Option<String>,
    previous_host_root: Option<String>,
    previous_electron_api_base: Option<String>,
    previous_openwebui_base_url: Option<String>,
}

impl RootEnv {
    fn new(name: &str) -> Self {
        let guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let root = env::temp_dir().join(format!(
            "core-mcp-rust-integration-{name}-{}",
            Uuid::new_v4().simple()
        ));
        fs::create_dir_all(root.join("mcp-configs")).expect("failed to create mcp-configs");
        fs::create_dir_all(root.join("mcp-configs-user"))
            .expect("failed to create mcp-configs-user");
        let previous_cwd = env::current_dir().expect("failed to capture cwd");
        let previous_container_root = env::var("CONTAINER_PROJECT_ROOT").ok();
        let previous_host_root = env::var("HOST_PROJECT_ROOT").ok();
        let previous_electron_api_base = env::var("ELECTRON_API_BASE").ok();
        let previous_openwebui_base_url = env::var("OPENWEBUI_BASE_URL").ok();
        env::set_var("CONTAINER_PROJECT_ROOT", &root);
        env::set_var("HOST_PROJECT_ROOT", &root);
        env::set_current_dir(&root).expect("failed to chdir into temp root");
        Self {
            _guard: guard,
            root,
            previous_cwd,
            previous_container_root,
            previous_host_root,
            previous_electron_api_base,
            previous_openwebui_base_url,
        }
    }

    fn set_electron_base(&self, base: &str) {
        env::set_var("ELECTRON_API_BASE", base);
    }

    fn set_openwebui_base(&self, base: &str) {
        env::set_var("OPENWEBUI_BASE_URL", base);
    }
}

impl Drop for RootEnv {
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
    body: String,
}

fn read_http_request(stream: &mut std::net::TcpStream) -> CapturedRequest {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 1024];
    let header_end;
    loop {
        let read = stream.read(&mut chunk).expect("failed to read request");
        assert!(read > 0, "client closed before request completed");
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(index) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            header_end = index + 4;
            break;
        }
    }
    let header_text =
        String::from_utf8(buffer[..header_end].to_vec()).expect("invalid request text");
    let request_line = header_text
        .split("\r\n")
        .find(|line| !line.is_empty())
        .expect("missing request line");
    let mut parts = request_line.split_whitespace();
    let _method = parts.next().unwrap_or_default();
    let path = parts.next().unwrap_or_default().to_string();
    let content_length = header_text
        .split("\r\n")
        .find_map(|line| {
            let lower = line.to_ascii_lowercase();
            lower
                .strip_prefix("content-length:")
                .map(|value| value.trim().parse::<usize>().expect("content length"))
        })
        .unwrap_or(0);
    let mut body = buffer[header_end..].to_vec();
    while body.len() < content_length {
        let read = stream
            .read(&mut chunk)
            .expect("failed to read request body");
        assert!(read > 0, "client closed before request body completed");
        body.extend_from_slice(&chunk[..read]);
    }
    CapturedRequest {
        path,
        body: String::from_utf8(body[..content_length].to_vec()).expect("body utf8"),
    }
}

fn serve_responses(replies: Vec<MockReply>) -> (String, mpsc::Receiver<CapturedRequest>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("failed to bind listener");
    let address = format!(
        "http://{}",
        listener.local_addr().expect("missing listener addr")
    );
    let (tx, rx) = mpsc::channel();
    let replies = Arc::new(Mutex::new(VecDeque::from(replies)));
    thread::spawn(move || loop {
        let next = replies
            .lock()
            .expect("failed to lock reply queue")
            .pop_front();
        let Some(reply) = next else {
            break;
        };
        let (mut stream, _) = listener.accept().expect("failed to accept request");
        let request = read_http_request(&mut stream);
        let _ = tx.send(request);
        let body = serde_json::to_vec(&reply.body).expect("failed to encode response");
        let response = format!(
                "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                reply.status,
                body.len()
            );
        stream
            .write_all(response.as_bytes())
            .and_then(|_| stream.write_all(&body))
            .expect("failed to write response");
    });
    (address, rx)
}

fn map(entries: &[(&str, Value)]) -> Map<String, Value> {
    entries
        .iter()
        .map(|(key, value)| ((*key).to_string(), value.clone()))
        .collect()
}

#[test]
fn server_id_validation_and_paths_cover_validity_and_collisions() {
    let env = RootEnv::new("paths");
    fs::create_dir_all(env.root.join("mcp-configs/sys-server")).unwrap();
    fs::create_dir_all(env.root.join("mcp-configs-user/user-server")).unwrap();

    validate_server_id("user_server-1", false).expect("valid server id");
    assert!(validate_server_id("UPPER", false).is_err());
    assert!(validate_server_id("ab", false).is_err());

    let collision = validate_server_id("sys-server", true).unwrap_err();
    assert!(collision
        .to_string()
        .contains("collides with existing system-delivered server"));
    assert!(validate_server_id("sys-server", true).is_err());

    assert_eq!(
        fs::canonicalize(user_server_path("user-server").unwrap()).unwrap(),
        fs::canonicalize(env.root.join("mcp-configs-user/user-server")).unwrap()
    );
    assert_eq!(
        fs::canonicalize(system_server_path("sys-server").unwrap()).unwrap(),
        fs::canonicalize(env.root.join("mcp-configs/sys-server")).unwrap()
    );
}

#[test]
fn warnings_normalization_and_yaml_validation_cover_success_and_errors() {
    let _env = RootEnv::new("normalize");

    let warnings = sensitive_warnings(Some(&map(&[
        ("API_TOKEN", json!("secret")),
        ("REGULAR_NAME", json!("value")),
    ])));
    assert_eq!(warnings.len(), 1);
    assert!(warnings[0].contains("API_TOKEN"));

    let untouched = map(&[("command", json!("python")), ("args", json!(["server.py"]))]);
    assert_eq!(
        normalize_remote_public_oauth_fragment(&untouched).unwrap(),
        (untouched.clone(), Vec::new())
    );

    let normalized_source = map(&[
        ("command", json!("npx")),
        (
            "args",
            json!([
                "mcp-remote",
                "https://example.com/mcp",
                "--static-oauth-client-metadata",
                "{\"redirect_uris\":[\"http://localhost/callback\"]}"
            ]),
        ),
        ("env", json!({"API_TOKEN": "secret"})),
    ]);
    let (normalized, notices) = normalize_remote_public_oauth_fragment(&normalized_source).unwrap();
    assert_eq!(normalized["type"], json!("streamable-http"));
    assert_eq!(normalized["url"], json!("https://example.com/mcp"));
    assert_eq!(
        normalized["oauth"]["server_url"],
        json!("https://example.com")
    );
    assert_eq!(
        normalized["oauth"]["resource"],
        json!("https://example.com/mcp")
    );
    assert_eq!(
        normalized["oauth"]["client_metadata"]["client_name"],
        json!(DEFAULT_OAUTH_CLIENT_NAME)
    );
    assert_eq!(
        normalized["oauth"]["client_metadata"]["token_endpoint_auth_method"],
        json!("none")
    );
    assert_eq!(normalized["env"]["API_TOKEN"], json!("secret"));
    assert_eq!(notices.len(), 1);

    let (normalized_without_env, notices) = normalize_remote_public_oauth_fragment(&map(&[
        ("command", json!("npx")),
        (
            "args",
            json!([
                "mcp-remote",
                "https://example.com/mcp",
                "--static-oauth-client-metadata",
                "{\"redirect_uris\":[\"http://localhost/callback\"]}"
            ]),
        ),
        ("env", json!({})),
    ]))
    .unwrap();
    assert!(normalized_without_env.get("env").is_none());
    assert_eq!(notices.len(), 1);

    let invalid_metadata = normalize_remote_public_oauth_fragment(&map(&[
        ("command", json!("npx")),
        (
            "args",
            json!([
                "mcp-remote",
                "https://example.com/mcp",
                "--static-oauth-client-metadata",
                "[]"
            ]),
        ),
    ]))
    .unwrap_err();
    assert!(invalid_metadata.to_string().contains("must be an object"));

    validate_user_yaml_config(&map(&[
        ("name", json!("Demo")),
        ("id", json!("demo")),
        ("display_name", json!("Demo Server")),
        ("deployment_type", json!("docker")),
        ("description", json!("desc")),
        ("user_installed", json!(true)),
        ("is_core", json!(false)),
        ("required_env_vars", json!([])),
        (
            "runtime_files",
            json!([
                { "source": "~/portico/trust-kit/mcp_config.yaml", "filename": "mcp_config.yaml" },
                { "source": "~/.snowflake/connections.toml", "target": "/root/.snowflake/connections.toml" }
            ])
        ),
    ]))
    .expect("valid yaml config");

    assert!(validate_user_yaml_config(&map(&[
        ("name", json!("Demo")),
        ("id", json!("demo")),
        ("display_name", json!("Bad*Name")),
        ("deployment_type", json!("invalid")),
        ("description", json!("desc")),
        ("user_installed", json!(false)),
        ("is_core", json!(true)),
        ("required_env_vars", json!([])),
    ]))
    .is_err());
}

#[test]
fn required_env_vars_normalization_and_validation_cover_branches() {
    fn base_with_required(required: Value) -> Map<String, Value> {
        map(&[
            ("name", json!("Demo")),
            ("id", json!("demo")),
            ("display_name", json!("Demo")),
            ("deployment_type", json!("docker")),
            ("description", json!("demo")),
            ("user_installed", json!(true)),
            ("is_core", json!(false)),
            ("required_env_vars", required),
        ])
    }
    fn expect_error(required: Value, needle: &str) {
        let error = validate_user_yaml_config(&base_with_required(required)).unwrap_err();
        assert!(
            error.to_string().contains(needle),
            "expected '{needle}' in '{error}'"
        );
    }

    // The shipped trust-kit shape (lowercase names allowed, all four keys).
    validate_user_yaml_config(&base_with_required(json!([
        {
            "name": "MARVIN_PASSWORD",
            "placeholder": "Paste the Marvin password",
            "description": "Marvin password",
            "sensitive": true
        },
        { "name": "waldoapikey" },
        { "name": "_TOKEN2" }
    ])))
    .expect("object entries are valid");

    // Bare strings normalize to the canonical object form. Credential-shaped
    // names fail closed to sensitive storage even when the caller omits the
    // flag, while ordinary configuration remains non-sensitive.
    let mut config = base_with_required(json!(["MARVIN_PASSWORD", { "name": "OTHER" }]));
    normalize_required_env_vars(&mut config);
    assert_eq!(
        config.get("required_env_vars"),
        Some(&json!([
            { "name": "MARVIN_PASSWORD", "sensitive": true },
            { "name": "OTHER" }
        ]))
    );
    validate_user_yaml_config(&config).expect("normalized entries are valid");

    let mut secret_names = base_with_required(json!([
        { "name": "FIGMA_API_KEY" },
        { "name": "githubToken", "sensitive": false },
        { "name": "PUBLIC_API_URL", "sensitive": false },
        { "name": "TOKEN_URL" },
        { "name": "KEY_ID" },
        { "name": "API_KEY_FILE" },
        { "name": "DB_PASS" },
        { "name": "DB_PWD" },
        { "name": "KEY_PASSPHRASE" },
        { "name": "SSH_PRIVATEKEY" },
        { "name": "PASSWORD_HASH" },
        { "name": "PASSWORD_HASH", "sensitive": false },
        { "name": "MONKEY", "sensitive": false }
    ]));
    normalize_required_env_vars(&mut secret_names);
    assert_eq!(
        secret_names.get("required_env_vars"),
        Some(&json!([
            { "name": "FIGMA_API_KEY", "sensitive": true },
            { "name": "githubToken", "sensitive": false },
            { "name": "PUBLIC_API_URL", "sensitive": false },
            { "name": "TOKEN_URL" },
            { "name": "KEY_ID" },
            { "name": "API_KEY_FILE" },
            { "name": "DB_PASS", "sensitive": true },
            { "name": "DB_PWD", "sensitive": true },
            { "name": "KEY_PASSPHRASE", "sensitive": true },
            { "name": "SSH_PRIVATEKEY", "sensitive": true },
            { "name": "PASSWORD_HASH", "sensitive": true },
            { "name": "PASSWORD_HASH", "sensitive": false },
            { "name": "MONKEY", "sensitive": false }
        ]))
    );

    // Absent key stays absent through normalization and validates.
    let mut absent = base_with_required(json!([]));
    absent.remove("required_env_vars");
    normalize_required_env_vars(&mut absent);
    assert!(!absent.contains_key("required_env_vars"));
    validate_user_yaml_config(&absent).expect("absent required_env_vars is valid");

    // Rejections (un-normalized strings are strict-rejected; handlers
    // normalize before validating).
    expect_error(json!(["MARVIN_PASSWORD"]), "must be an object");
    expect_error(json!("nope"), "must be a list");
    expect_error(json!([{ "sensitive": true }]), "non-empty string 'name'");
    expect_error(json!([{ "name": "  " }]), "non-empty string 'name'");
    expect_error(json!([{ "name": "1BAD" }]), "[A-Za-z_][A-Za-z0-9_]*");
    expect_error(json!([{ "name": "BAD-NAME" }]), "[A-Za-z_][A-Za-z0-9_]*");
    expect_error(
        Value::Array(vec![
            json!({ "name": "A".repeat(MAX_REQUIRED_ENV_VAR_NAME_LEN + 1) }),
        ]),
        "exceeds",
    );
    expect_error(json!([{ "name": "A" }, { "name": "A" }]), "duplicate");
    expect_error(
        json!([{ "name": "A", "sesitive": true }]),
        "unknown required_env_vars key",
    );
    expect_error(
        json!([{ "name": "A", "placeholder": 5 }]),
        "must be a string",
    );
    expect_error(
        json!([{ "name": "A", "description": "x".repeat(MAX_REQUIRED_ENV_VAR_TEXT_LEN + 1) }]),
        "exceeds",
    );
    expect_error(json!([{ "name": "A", "sensitive": "yes" }]), "boolean");

    // Entry-count cap: at the cap passes, one over fails.
    let at_cap: Vec<Value> = (0..MAX_REQUIRED_ENV_VARS)
        .map(|index| json!({ "name": format!("VAR_{index}") }))
        .collect();
    validate_user_yaml_config(&base_with_required(Value::Array(at_cap)))
        .expect("cap-count entries are valid");
    let over_cap: Vec<Value> = (0..=MAX_REQUIRED_ENV_VARS)
        .map(|index| json!({ "name": format!("VAR_{index}") }))
        .collect();
    expect_error(Value::Array(over_cap), "at most");
}

#[test]
fn required_env_var_names_are_trimmed_during_normalization() {
    let mut config = map(&[(
        "required_env_vars",
        json!([" BARE_PADDED ", { "name": "  OBJ_PADDED  ", "sensitive": true }]),
    )]);
    normalize_required_env_vars(&mut config);
    assert_eq!(
        config.get("required_env_vars"),
        Some(&json!([
            { "name": "BARE_PADDED" },
            { "name": "OBJ_PADDED", "sensitive": true }
        ])),
        "padded names must be trimmed so KEY=value lines and ${{NAME}} placeholders match"
    );
}

#[test]
fn fragment_env_reference_validation_covers_branches() {
    fn yaml_with(required: Value, preset: Option<Value>) -> Map<String, Value> {
        let mut entries = vec![("required_env_vars", required)];
        if let Some(preset) = preset {
            entries.push(("preset_env_vars", preset));
        }
        map(&entries)
    }
    fn fragment(value: Value) -> Map<String, Value> {
        value.as_object().cloned().expect("fragment object")
    }

    // Declared references pass: braced, bare, nested in arrays/objects.
    validate_fragment_env_references(
        &fragment(json!({
            "command": "docker",
            "args": ["run", "-e", "MARVIN_PASSWORD=${MARVIN_PASSWORD}"],
            "env": { "TOKEN": "$API_TOKEN" },
            "headers": { "auth": { "inner": "${API_TOKEN}" } }
        })),
        &yaml_with(
            json!([{ "name": "MARVIN_PASSWORD" }, { "name": "API_TOKEN" }]),
            None,
        ),
    )
    .expect("declared references are valid");

    // preset_env_vars satisfy references too.
    validate_fragment_env_references(
        &fragment(json!({ "url": "${SOURCEGRAPH_URL}/api" })),
        &yaml_with(
            json!([]),
            Some(json!([{ "name": "SOURCEGRAPH_URL", "value": "https://example" }])),
        ),
    )
    .expect("preset references are valid");

    // Undeclared references fail with the missing names listed.
    let missing = validate_fragment_env_references(
        &fragment(json!({ "env": { "A": "${UNDECLARED_ONE}", "B": "$UNDECLARED_TWO" } })),
        &yaml_with(json!([{ "name": "OTHER" }]), None),
    )
    .unwrap_err()
    .to_string();
    assert!(missing.contains("UNDECLARED_ONE"), "{missing}");
    assert!(missing.contains("UNDECLARED_TWO"), "{missing}");
    assert!(missing.contains("required_env_vars"), "{missing}");

    // Non-references are ignored: no name, digits, unterminated brace,
    // plain text, and prices.
    validate_fragment_env_references(
        &fragment(json!({
            "args": ["awk", "{print $1}", "$", "${", "${1BAD}", "costs $5", "end$"]
        })),
        &yaml_with(json!([]), None),
    )
    .expect("non-references must not require declarations");

    // Placeholder-free fragments always pass, even with nothing declared.
    validate_fragment_env_references(
        &fragment(json!({ "command": "python3", "args": ["server.py"] })),
        &map(&[]),
    )
    .expect("placeholder-free fragment is valid");
}

#[test]
fn fragment_validation_sanitization_and_limits_cover_branches() {
    let env = RootEnv::new("fragments");

    let stdio = map(&[
        ("command", json!("python")),
        ("args", json!(["server.py"])),
        ("env", json!({"API_TOKEN": "secret"})),
    ]);
    let warnings = validate_fragment(&stdio).unwrap();
    assert_eq!(warnings.len(), 1);
    assert!(warnings[0].contains("API_TOKEN"));

    let missing_args = validate_fragment(&map(&[("command", json!("python"))])).unwrap_err();
    assert!(missing_args.to_string().contains("args is required"));

    let dangerous = validate_fragment(&map(&[
        ("command", json!("python; rm -rf /")),
        ("args", json!(["server.py"])),
    ]))
    .unwrap_err();
    assert!(dangerous.to_string().contains("dangerous characters"));

    let unsupported_npm = validate_fragment(&map(&[
        ("command", json!("npm")),
        ("args", json!(["start"])),
    ]))
    .unwrap_err();
    assert!(unsupported_npm
        .to_string()
        .contains("UNSUPPORTED_NPM_SUBCOMMAND"));

    validate_fragment(&map(&[
        ("command", json!("npm")),
        ("args", json!(["exec", "demo-server@1.2.3"])),
    ]))
    .expect("npm exec is a supported managed Node recipe");

    let http = map(&[
        ("type", json!("streamable-http")),
        ("url", json!("https://example.com/mcp")),
        (
            "oauth",
            json!({
                "server_url": "https://example.com",
                "scope": "demo",
                "authorization_endpoint": "https://example.com/auth",
                "token_endpoint": "https://example.com/token"
            }),
        ),
    ]);
    let http_warnings = validate_fragment(&http).unwrap();
    assert_eq!(http_warnings.len(), 3);

    assert!(validate_fragment(&map(&[
        ("type", json!("ftp")),
        ("url", json!("ftp://example.com")),
    ]))
    .is_err());
    assert!(validate_fragment(&map(&[
        ("type", json!("sse")),
        ("url", json!("https://example.com/mcp")),
        ("oauth", json!({"server_url": "example.com"})),
    ]))
    .is_err());

    let sanitized = sanitize_fragment_for_display(&map(&[
        ("command", json!("python")),
        ("env", json!({"API_TOKEN": "secret", "PLAIN": "value"})),
    ]));
    assert_eq!(sanitized["env"]["API_TOKEN"], json!("***REDACTED***"));
    assert_eq!(sanitized["env"]["PLAIN"], json!("value"));

    let untouched = sanitize_fragment_for_display(&map(&[("command", json!("python"))]));
    assert_eq!(untouched["command"], json!("python"));
    assert!(untouched.get("env").is_none());

    check_user_server_limit().expect("empty skills-user directory should be allowed");
    for index in 0..MAX_USER_MCP_SERVERS {
        fs::create_dir_all(
            env.root
                .join("mcp-configs-user")
                .join(format!("server-{index}")),
        )
        .unwrap();
    }
    let limit_error = check_user_server_limit().unwrap_err();
    assert!(limit_error.to_string().contains("Maximum of"));
}

#[test]
fn readiness_helpers_and_activation_steps_cover_decision_logic() {
    let _env = RootEnv::new("readiness");

    assert_eq!(
        readiness_phase(&json!({"readiness_phase": "waiting_callback"})),
        "waiting_callback"
    );
    assert_eq!(
        readiness_phase(&json!({"healthy": true})),
        READINESS_PHASE_TOOL_READY
    );
    assert_eq!(readiness_phase(&json!({})), READINESS_PHASE_STARTING);

    assert!(!server_visible(&json!({})));
    assert!(server_visible(&json!({"deployment_type": "host"})));
    assert!(server_visible(&json!({"proxy_probe_ok": true})));
    assert!(server_visible(&json!({"tools_count": 1})));

    assert!(should_wait_for_tool_ready(&json!({
        "readiness_phase": READINESS_PHASE_STARTING,
        "discovered": true
    })));
    assert!(should_wait_for_tool_ready(&json!({
        "readiness_phase": READINESS_PHASE_CHECKING_TOKENS,
        "discovered": true
    })));
    assert!(!should_wait_for_tool_ready(&json!({
        "readiness_phase": READINESS_PHASE_NEEDS_OAUTH,
        "discovered": true
    })));
    assert!(!should_wait_for_tool_ready(&json!({
        "readiness_phase": READINESS_PHASE_WAITING_CALLBACK,
        "discovered": true
    })));
    assert!(!should_wait_for_tool_ready(&json!({
        "readiness_phase": READINESS_PHASE_TOOL_READY,
        "healthy": true,
        "tools_count": 1
    })));

    let oauth_block = blocked_integration(
        "server:demo",
        &json!({
            "healthy": false,
            "readiness_phase": READINESS_PHASE_NEEDS_OAUTH,
            "discovered": true
        }),
    );
    assert_eq!(oauth_block["recovery_hint"], json!("oauth_required"));
    assert_eq!(oauth_block["server_id"], json!("demo"));
    assert_eq!(oauth_block["actively_starting"], json!(false));

    let disabled_block = blocked_integration(
        "server:demo",
        &json!({"healthy": false, "readiness_phase": READINESS_PHASE_DISABLED}),
    );
    assert_eq!(
        disabled_block["recovery_hint"],
        json!("integration_disabled")
    );

    let restart_block = blocked_integration(
        "server:demo",
        &json!({"healthy": false, "readiness_phase": "failed"}),
    );
    assert_eq!(restart_block["recovery_hint"], json!("restart_recommended"));

    let steps = activation_next_steps(
        &[
            oauth_block,
            disabled_block,
            json!({"actively_starting": true, "recovery_hint": "still_starting"}),
            restart_block,
        ],
        false,
    );
    assert!(steps
        .iter()
        .any(|item| item.contains("mcp_assistant_toggle_integration")));
    assert!(steps
        .iter()
        .any(|item| item.contains("mcp_assistant_authorize_integration")));
    assert!(steps.iter().any(|item| item.contains("still starting")));
    assert!(steps
        .iter()
        .any(|item| item.contains("last-resort recovery")));

    let skill_steps = activation_next_steps(&[], true);
    assert_eq!(skill_steps.len(), 2);
    assert!(skill_steps[0].contains("Do NOT rely on this skill"));

    assert_eq!(
        activation_failure_message(&[json!({"restart_recommended": true})], false),
        "One or more integrations are not ready for chat activation yet. At least one blocked server is not actively starting, so startup waiting will not fix it by itself."
    );
    assert_eq!(
        activation_failure_message(&[json!({"recovery_hint": "integration_disabled"})], false),
        "One or more integrations are not ready for chat activation yet because the server is disabled."
    );
    assert_eq!(
        activation_failure_message(&[json!({"recovery_hint": "oauth_required"})], true),
        "One or more MCP servers required by this skill are not ready yet because OAuth authorization is still required."
    );
}

#[test]
fn activation_helpers_cover_skill_specific_and_generic_fallback_branches() {
    let _env = RootEnv::new("activation-fallbacks");

    let checking_tokens_block = blocked_integration(
        "server:demo",
        &json!({
            "healthy": false,
            "readiness_phase": READINESS_PHASE_CHECKING_TOKENS,
            "discovered": true
        }),
    );
    assert_eq!(
        checking_tokens_block["recovery_hint"],
        json!("still_starting")
    );

    let waiting_callback_block = blocked_integration(
        "server:demo",
        &json!({"healthy": false, "readiness_phase": READINESS_PHASE_WAITING_CALLBACK}),
    );
    assert_eq!(
        waiting_callback_block["recovery_hint"],
        json!("oauth_required")
    );

    let missing_block = blocked_integration(
        "server:missing",
        &json!({
            "healthy": false,
            "readiness_phase": READINESS_PHASE_SERVICE_NOT_FOUND,
            "error": "service_not_found"
        }),
    );
    assert_eq!(missing_block["recovery_hint"], json!("integration_missing"));
    assert_eq!(missing_block["restart_recommended"], json!(false));

    let not_ready_block = blocked_integration(
        "server:demo",
        &json!({"healthy": true, "readiness_phase": "warming"}),
    );
    assert_eq!(not_ready_block["recovery_hint"], json!("not_ready"));

    let skill_steps = activation_next_steps(
        &[
            json!({"recovery_hint": "integration_missing"}),
            json!({"recovery_hint": "integration_disabled"}),
            json!({"recovery_hint": "oauth_required"}),
            json!({"restart_recommended": true}),
        ],
        true,
    );
    assert!(skill_steps
        .iter()
        .any(|item| item.contains("service_not_found")));
    assert!(skill_steps
        .iter()
        .any(|item| item.contains("required MCP server is disabled")));
    assert!(skill_steps
        .iter()
        .any(|item| item.contains("required server is in needs_oauth")));
    assert!(skill_steps
        .iter()
        .any(|item| item.contains("required server is not actively starting")));

    let generic_steps = activation_next_steps(&[], false);
    assert_eq!(generic_steps.len(), 2);
    assert!(generic_steps[1].contains("resolve the server state"));

    assert_eq!(
        activation_failure_message(&[json!({"recovery_hint": "integration_missing"})], true),
        "One or more MCP servers required by this skill are not installed in this app."
    );
    assert_eq!(
        activation_failure_message(&[json!({"restart_recommended": true})], true),
        "One or more MCP servers required by this skill are not ready yet. At least one blocked dependency is not actively starting, so waiting longer will not fix it by itself."
    );
    assert_eq!(
        activation_failure_message(&[json!({"recovery_hint": "oauth_required"})], false),
        "One or more integrations are not ready for chat activation yet because OAuth authorization is still required."
    );
    assert_eq!(
        activation_failure_message(&[json!({"recovery_hint": "integration_disabled"})], true),
        "One or more MCP servers required by this skill are not ready yet because the dependency is disabled."
    );
    assert_eq!(
        activation_failure_message(&[], true),
        "One or more MCP servers required by this skill are not ready yet. skills_activate_skill already waited up to 30 seconds for visible servers in transitional readiness phases, but at least one dependency is still not tool_ready."
    );
    assert_eq!(
        activation_failure_message(&[], false),
        "One or more integrations are not ready for chat activation yet. mcp_assistant_activate_integration already waited up to 30 seconds for visible servers in transitional readiness phases, but at least one server is still not tool_ready."
    );
}

#[test]
fn configured_server_ids_include_system_and_user_servers_and_skip_junk() {
    let env = RootEnv::new("configured-server-ids");
    fs::create_dir_all(env.root.join("mcp-configs/sys-one")).unwrap();
    fs::write(
        env.root.join("mcp-configs/sys-one/sys-one.yaml"),
        "name: Sys One\n",
    )
    .unwrap();
    fs::create_dir_all(env.root.join("mcp-configs/skip-no-yaml")).unwrap();
    fs::write(env.root.join("mcp-configs/.DS_Store"), "junk").unwrap();
    fs::write(env.root.join("mcp-configs/README.md"), "not a dir").unwrap();
    fs::create_dir_all(env.root.join("mcp-configs-user/user-one")).unwrap();
    fs::write(
        env.root.join("mcp-configs-user/user-one/user-one.yaml"),
        "name: User One\n",
    )
    .unwrap();
    fs::write(env.root.join("mcp-configs-user/.gitkeep"), "").unwrap();

    let mut ids = configured_server_ids()
        .unwrap()
        .into_iter()
        .collect::<Vec<_>>();
    ids.sort();
    assert_eq!(ids, vec!["sys-one".to_string(), "user-one".to_string()]);
}

#[test]
fn configured_server_ids_tolerate_empty_and_missing_user_dirs() {
    let env = RootEnv::new("configured-server-ids-empty-user");
    fs::create_dir_all(env.root.join("mcp-configs/sys-one")).unwrap();
    fs::write(
        env.root.join("mcp-configs/sys-one/sys-one.yaml"),
        "name: Sys One\n",
    )
    .unwrap();

    let mut ids = configured_server_ids()
        .unwrap()
        .into_iter()
        .collect::<Vec<_>>();
    ids.sort();
    assert_eq!(ids, vec!["sys-one".to_string()]);

    fs::remove_dir_all(env.root.join("mcp-configs-user")).unwrap();
    let mut ids = configured_server_ids()
        .unwrap()
        .into_iter()
        .collect::<Vec<_>>();
    ids.sort();
    assert_eq!(ids, vec!["sys-one".to_string()]);
}

#[tokio::test]
async fn readiness_requests_use_electron_api_and_wait_for_success() {
    let env = RootEnv::new("electron");

    let (base_url, requests) = serve_responses(vec![MockReply {
        status: "200 OK",
        body: json!({"healthy": false, "readiness_phase": READINESS_PHASE_CHECKING_TOKENS}),
    }]);
    env.set_electron_base(&base_url);
    let readiness = get_server_readiness("server:demo").await;
    assert_eq!(readiness["server_id"], json!("demo"));
    assert_eq!(requests.recv().unwrap().path, "/api/server-readiness/demo");

    let (base_url, requests) = serve_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({"healthy": false, "readiness_phase": READINESS_PHASE_STARTING, "discovered": true}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"healthy": true, "readiness_phase": READINESS_PHASE_TOOL_READY, "tools_count": 1}),
        },
    ]);
    env.set_electron_base(&base_url);
    let waited = wait_for_server_tool_ready("server:demo", 0.2).await;
    assert_eq!(waited["server_id"], json!("demo"));
    assert_eq!(waited["readiness_phase"], json!(READINESS_PHASE_TOOL_READY));
    assert_eq!(waited["healthy"], json!(true));
    assert!(waited["waited_seconds"].as_f64().unwrap() >= 0.0);
    assert_eq!(requests.recv().unwrap().path, "/api/server-readiness/demo");
    assert_eq!(requests.recv().unwrap().path, "/api/server-readiness/demo");

    let (base_url, requests) = serve_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({"healthy": false, "readiness_phase": READINESS_PHASE_NEEDS_OAUTH, "discovered": true}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"healthy": true, "readiness_phase": READINESS_PHASE_TOOL_READY, "tools_count": 1}),
        },
    ]);
    env.set_electron_base(&base_url);
    let no_wait = wait_for_server_tool_ready("server:demo", 0.2).await;
    assert_eq!(
        no_wait["readiness_phase"],
        json!(READINESS_PHASE_NEEDS_OAUTH)
    );
    assert_eq!(requests.recv().unwrap().path, "/api/server-readiness/demo");
    assert!(requests.try_recv().is_err());

    env.set_electron_base("http://127.0.0.1:9");
    let failed = get_server_readiness("demo").await;
    assert_eq!(failed["healthy"], json!(false));
    assert_eq!(failed["readiness_phase"], json!(READINESS_PHASE_STARTING));
}

#[tokio::test]
async fn notify_capabilities_changed_formats_tools_and_skills() {
    let env = RootEnv::new("notify");
    let (base, requests) = serve_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({"ok": true}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"ok": true}),
        },
    ]);
    env.set_openwebui_base(&base);

    notify_capabilities_changed(
        "chat-1",
        "tools",
        &[
            "server:mcp-assistant".to_string(),
            "server:agent-vm".to_string(),
            "server:google_workspace".to_string(),
            "server:weird--api".to_string(),
        ],
    )
    .await;
    notify_capabilities_changed("chat-1", "skills", &["foo/bar-skill".to_string()]).await;

    let tool_request = requests.recv().unwrap();
    assert_eq!(
        tool_request.path,
        "/api/v1/chats/chat-1/capabilities-changed"
    );
    assert!(tool_request.body.contains("\"server_id\":\"weird--api\""));
    assert!(tool_request
        .body
        .contains("\"display_name\":\"Google Workspace\""));
    assert!(tool_request
        .body
        .contains("\"display_name\":\"Weird  API\""));
    assert!(tool_request
        .body
        .contains("\"icon_url\":\"/api/v1/chats/mcp/servers/weird--api/icon\""));

    let skill_request = requests.recv().unwrap();
    assert_eq!(
        skill_request.path,
        "/api/v1/chats/chat-1/capabilities-changed"
    );
    assert!(skill_request
        .body
        .contains("\"display_name\":\"foo / bar skill\""));
}

#[test]
fn validation_covers_missing_required_flags_and_dual_fragment_errors() {
    let _env = RootEnv::new("extra-validation");

    let missing_name = validate_user_yaml_config(&map(&[
        ("id", json!("demo")),
        ("display_name", json!("Demo")),
        ("deployment_type", json!("docker")),
        ("description", json!("desc")),
        ("user_installed", json!(true)),
        ("is_core", json!(false)),
        ("required_env_vars", json!([])),
    ]))
    .unwrap_err();
    assert!(missing_name.to_string().contains("'name' is required"));

    let bad_user_installed = validate_user_yaml_config(&map(&[
        ("name", json!("Demo")),
        ("id", json!("demo")),
        ("display_name", json!("Demo")),
        ("deployment_type", json!("docker")),
        ("description", json!("desc")),
        ("user_installed", json!(false)),
        ("is_core", json!(false)),
        ("required_env_vars", json!([])),
    ]))
    .unwrap_err();
    assert!(bad_user_installed
        .to_string()
        .contains("user_installed must be true"));

    let bad_core_flag = validate_user_yaml_config(&map(&[
        ("name", json!("Demo")),
        ("id", json!("demo")),
        ("display_name", json!("Demo")),
        ("deployment_type", json!("docker")),
        ("description", json!("desc")),
        ("user_installed", json!(true)),
        ("is_core", json!(true)),
        ("required_env_vars", json!([])),
    ]))
    .unwrap_err();
    assert!(bad_core_flag.to_string().contains("cannot be core"));

    let conflicting_fragment = validate_fragment(&map(&[
        ("command", json!("python3")),
        ("args", json!(["server.py"])),
        ("type", json!("streamable-http")),
        ("url", json!("https://example.com/mcp")),
    ]))
    .unwrap_err();
    assert!(conflicting_fragment
        .to_string()
        .contains("either stdio-based"));
}

#[test]
fn additional_normalization_validation_and_limit_edges_are_covered() {
    let env = RootEnv::new("extra-edges");

    assert_eq!(
        normalize_remote_public_oauth_fragment(&map(&[
            ("command", json!("npx")),
            ("args", json!(["plain-command"])),
        ]))
        .unwrap(),
        (
            map(&[
                ("command", json!("npx")),
                ("args", json!(["plain-command"]))
            ]),
            Vec::new(),
        )
    );
    assert_eq!(
        normalize_remote_public_oauth_fragment(&map(&[
            ("command", json!("npx")),
            (
                "args",
                json!(["mcp-remote", "--static-oauth-client-metadata", "{\"a\":1}"])
            ),
        ]))
        .unwrap()
        .0["command"],
        json!("npx")
    );
    assert_eq!(
        normalize_remote_public_oauth_fragment(&map(&[
            ("command", json!("npx")),
            ("args", json!(["mcp-remote", "https://example.com/mcp"])),
        ]))
        .unwrap()
        .0["command"],
        json!("npx")
    );
    assert_eq!(
        normalize_remote_public_oauth_fragment(&map(&[
            ("command", json!("npx")),
            (
                "args",
                json!([
                    "mcp-remote",
                    "https://example.com/mcp",
                    "--static-oauth-client-metadata",
                    "@client.json"
                ]),
            ),
        ]))
        .unwrap()
        .0["command"],
        json!("npx")
    );

    let invalid_display = validate_user_yaml_config(&map(&[
        ("name", json!("Demo")),
        ("id", json!("demo")),
        ("display_name", json!("Bad!Name")),
        ("deployment_type", json!("docker")),
        ("description", json!("demo")),
        ("user_installed", json!(true)),
        ("is_core", json!(false)),
        ("required_env_vars", json!([])),
    ]))
    .unwrap_err();
    assert!(invalid_display.to_string().contains("display_name"));

    // PORTICO-224: declared required_env_vars are now supported for
    // user-installed servers (object form; see the dedicated matrix test).
    validate_user_yaml_config(&map(&[
        ("name", json!("Demo")),
        ("id", json!("demo")),
        ("display_name", json!("Demo")),
        ("deployment_type", json!("docker")),
        ("description", json!("demo")),
        ("user_installed", json!(true)),
        ("is_core", json!(false)),
        (
            "required_env_vars",
            json!([{ "name": "MARVIN_PASSWORD", "sensitive": true }]),
        ),
    ]))
    .expect("declared required_env_vars are valid for user-installed servers");

    let host_runtime_files = validate_user_yaml_config(&map(&[
        ("name", json!("Demo")),
        ("id", json!("demo")),
        ("display_name", json!("Demo")),
        ("deployment_type", json!("host")),
        ("description", json!("demo")),
        ("user_installed", json!(true)),
        ("is_core", json!(false)),
        ("required_env_vars", json!([])),
        ("runtime_files", json!([{ "source": "config.yaml" }])),
    ]))
    .unwrap_err();
    assert!(host_runtime_files
        .to_string()
        .contains("runtime_files are only supported for docker"));

    let duplicate_runtime_file = validate_user_yaml_config(&map(&[
        ("name", json!("Demo")),
        ("id", json!("demo")),
        ("display_name", json!("Demo")),
        ("deployment_type", json!("docker")),
        ("description", json!("demo")),
        ("user_installed", json!(true)),
        ("is_core", json!(false)),
        ("required_env_vars", json!([])),
        (
            "runtime_files",
            json!([
                { "source": "one.yaml", "filename": "config.yaml" },
                { "source": "two.yaml", "target": "/app/runtime/config.yaml" }
            ]),
        ),
    ]))
    .unwrap_err();
    assert!(duplicate_runtime_file
        .to_string()
        .contains("Duplicate runtime_files target"));

    let invalid_target = validate_user_yaml_config(&map(&[
        ("name", json!("Demo")),
        ("id", json!("demo")),
        ("display_name", json!("Demo")),
        ("deployment_type", json!("docker")),
        ("description", json!("demo")),
        ("user_installed", json!(true)),
        ("is_core", json!(false)),
        ("required_env_vars", json!([])),
        (
            "runtime_files",
            json!([{ "source": "connections.toml", "target": "root/.snowflake/connections.toml" }]),
        ),
    ]))
    .unwrap_err();
    assert!(invalid_target
        .to_string()
        .contains("absolute container file path"));

    let target_parent_dir = validate_user_yaml_config(&map(&[
        ("name", json!("Demo")),
        ("id", json!("demo")),
        ("display_name", json!("Demo")),
        ("deployment_type", json!("docker")),
        ("description", json!("demo")),
        ("user_installed", json!(true)),
        ("is_core", json!(false)),
        ("required_env_vars", json!([])),
        (
            "runtime_files",
            json!([{ "source": "connections.toml", "target": "/root/../connections.toml" }]),
        ),
    ]))
    .unwrap_err();
    assert!(target_parent_dir.to_string().contains("must not contain"));

    let target_directory = validate_user_yaml_config(&map(&[
        ("name", json!("Demo")),
        ("id", json!("demo")),
        ("display_name", json!("Demo")),
        ("deployment_type", json!("docker")),
        ("description", json!("demo")),
        ("user_installed", json!(true)),
        ("is_core", json!(false)),
        ("required_env_vars", json!([])),
        (
            "runtime_files",
            json!([{ "source": "connections.toml", "target": "/root/.snowflake/" }]),
        ),
    ]))
    .unwrap_err();
    assert!(target_directory.to_string().contains("include a file name"));

    let filename_and_target = validate_user_yaml_config(&map(&[
        ("name", json!("Demo")),
        ("id", json!("demo")),
        ("display_name", json!("Demo")),
        ("deployment_type", json!("docker")),
        ("description", json!("demo")),
        ("user_installed", json!(true)),
        ("is_core", json!(false)),
        ("required_env_vars", json!([])),
        (
            "runtime_files",
            json!([{ "source": "connections.toml", "filename": "connections.toml", "target": "/root/.snowflake/connections.toml" }]),
        ),
    ]))
    .unwrap_err();
    assert!(filename_and_target
        .to_string()
        .contains("target cannot be combined with filename"));

    let invalid_sensitive_runtime_file = validate_user_yaml_config(&map(&[
        ("name", json!("Demo")),
        ("id", json!("demo")),
        ("display_name", json!("Demo")),
        ("deployment_type", json!("docker")),
        ("description", json!("demo")),
        ("user_installed", json!(true)),
        ("is_core", json!(false)),
        ("required_env_vars", json!([])),
        (
            "runtime_files",
            json!([{ "source": "connections.toml", "target": "/root/.snowflake/connections.toml", "sensitive": "yes" }]),
        ),
    ]))
    .unwrap_err();
    assert!(invalid_sensitive_runtime_file
        .to_string()
        .contains("runtime_files sensitive must be true or false"));

    let dangerous = validate_fragment(&map(&[
        ("command", json!("python3; rm -rf /")),
        ("args", json!(["server.py"])),
    ]))
    .unwrap_err();
    assert!(dangerous.to_string().contains("dangerous characters"));

    let bad_url = validate_fragment(&map(&[
        ("type", json!("streamable-http")),
        ("url", json!("ftp://example.com")),
    ]))
    .unwrap_err();
    assert!(bad_url.to_string().contains("http:// or https://"));

    let bad_server_url = validate_fragment(&map(&[
        ("type", json!("streamable-http")),
        ("url", json!("https://example.com")),
        ("oauth", json!({"server_url": "ftp://example.com"})),
    ]))
    .unwrap_err();
    assert!(bad_server_url.to_string().contains("OAuth server_url"));

    fs::remove_dir_all(env.root.join("mcp-configs-user")).unwrap();
    check_user_server_limit().expect("missing user dir should be allowed");

    let starting_block = blocked_integration(
        "server:demo",
        &json!({"healthy": false, "readiness_phase": READINESS_PHASE_STARTING, "discovered": true}),
    );
    assert_eq!(starting_block["recovery_hint"], json!("still_starting"));
}

#[test]
fn hard_disabled_dependencies_get_refusal_guidance_not_toggle_advice() {
    let _env = RootEnv::new("hard-disable-hints");

    let hard_block = blocked_integration(
        "server:n8n",
        &json!({
            "healthy": false,
            "readiness_phase": READINESS_PHASE_DISABLED,
            "error": "integration_hard_disabled",
        }),
    );
    assert_eq!(
        hard_block["recovery_hint"],
        json!("integration_hard_disabled")
    );
    assert_eq!(hard_block["server_id"], json!("n8n"));
    assert_eq!(hard_block["restart_recommended"], json!(false));

    // Guidance must firmly refuse — and never suggest calling the toggle tool.
    let steps = activation_next_steps(&[hard_block.clone()], false);
    assert!(steps
        .iter()
        .any(|item| item.contains("do NOT call toggle_integration")));
    assert!(!steps
        .iter()
        .any(|item| item.contains("mcp_assistant_toggle_integration(server_id=")));

    let skill_steps = activation_next_steps(&[hard_block.clone()], true);
    assert!(skill_steps
        .iter()
        .any(|item| item.contains("only the user can re-enable it from the Control Plane")));

    assert_eq!(
        activation_failure_message(&[hard_block.clone()], false),
        "One or more requested integrations were hard-disabled by the user and are unavailable. Do not attempt to enable them; only the user can re-enable them from the Control Plane."
    );
    assert_eq!(
        activation_failure_message(&[hard_block], true),
        "One or more MCP servers required by this skill were hard-disabled by the user and are unavailable. Do not attempt to enable them; only the user can re-enable them from the Control Plane."
    );

    // A plain soft disable keeps today's toggle-first guidance.
    let soft_block = blocked_integration(
        "server:demo",
        &json!({
            "healthy": false,
            "readiness_phase": READINESS_PHASE_DISABLED,
            "error": "integration_disabled",
        }),
    );
    assert_eq!(soft_block["recovery_hint"], json!("integration_disabled"));
    let soft_steps = activation_next_steps(&[soft_block], false);
    assert!(soft_steps
        .iter()
        .any(|item| item.contains("mcp_assistant_toggle_integration(server_id=")));
}
