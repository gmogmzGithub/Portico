use anyhow::Result;
use rmcp::model::{CallToolRequestParams, CallToolResult};
use rmcp::{transport::TokioChildProcess, ServiceExt};
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;
use uuid::Uuid;

struct TestRoot {
    path: PathBuf,
}

impl TestRoot {
    fn new(name: &str) -> Self {
        let path = env::temp_dir().join(format!(
            "mcp-assistant-stdio-{name}-{}",
            Uuid::new_v4().simple()
        ));
        fs::create_dir_all(path.join("mcp-configs")).expect("create mcp-configs");
        fs::create_dir_all(path.join("mcp-configs-user")).expect("create mcp-configs-user");
        Self { path }
    }

    fn write_system_server(&self, server_id: &str, yaml: &str, fragment: &Value) {
        let dir = self.path.join("mcp-configs").join(server_id);
        fs::create_dir_all(&dir).expect("create system server dir");
        fs::write(dir.join(format!("{server_id}.yaml")), yaml).expect("write system yaml");
        fs::write(
            dir.join(format!("{server_id}.fragment")),
            serde_json::to_string_pretty(fragment).expect("encode fragment"),
        )
        .expect("write system fragment");
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
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

fn declared_tools() -> BTreeSet<String> {
    serde_json::from_str::<Vec<Value>>(include_str!("../tool_spec.json"))
        .expect("tool spec JSON")
        .into_iter()
        .map(|value| value["name"].as_str().expect("tool name").to_string())
        .collect()
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
            line.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .map(|value| value.trim().parse::<usize>().expect("content length"))
        })
        .unwrap_or(0);
    let mut body = buffer[header_end..].to_vec();
    while body.len() < content_length {
        let read = stream.read(&mut chunk).expect("read body");
        assert!(read > 0, "client closed before body complete");
        body.extend_from_slice(&chunk[..read]);
    }
    CapturedRequest {
        method,
        path,
        body: String::from_utf8(body).expect("body utf8"),
    }
}

fn serve_replies(replies: Vec<MockReply>) -> (String, mpsc::Receiver<CapturedRequest>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind listener");
    let base = format!("http://{}", listener.local_addr().expect("listener addr"));
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        for reply in replies {
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
        }
    });
    (base, rx)
}

#[test]
fn coverage_manifest_matches_declared_tools() {
    let covered = BTreeSet::from([
        "list_mcp_servers".to_string(),
        "get_system_mcp_config".to_string(),
        "create_user_mcp_server".to_string(),
        "read_user_mcp_server".to_string(),
        "update_user_mcp_server".to_string(),
        "delete_user_mcp_server".to_string(),
        "validate_mcp_fragment".to_string(),
        "restart_mcp_infrastructure".to_string(),
        "restart_mcp_server".to_string(),
        "activate_integration".to_string(),
        "get_chat_tools".to_string(),
        "get_host_mcp_bridge_status".to_string(),
        "configure_host_mcp_bridge_clients".to_string(),
        "toggle_integration".to_string(),
        "authorize_integration".to_string(),
        "get_mcp_server_logs".to_string(),
        "trigger_guided_setup".to_string(),
    ]);
    assert_eq!(
        covered,
        declared_tools(),
        "Update the coverage manifest and tests when mcp-assistant tool_spec.json changes",
    );
}

#[tokio::test]
async fn binary_handles_agentic_mcp_server_crud_and_system_protection_over_stdio() -> Result<()> {
    let root = TestRoot::new("crud");
    root.write_system_server(
        "core-one",
        "name: Core One\ndisplay_name: Core One\ndeployment_type: docker\ndescription: System server\n",
        &json!({"command": "python3", "args": ["system.py"]}),
    );
    let (electron_base, requests) = serve_replies(vec![
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "enabled": true, "healthy": true, "readiness_phase": "tool_ready"}),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "success": true,
                "server_id": "remote-one",
                "files_deleted_count": 2,
                "toggle_removed": true,
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({"success": true}),
        },
    ]);

    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_mcp-assistant-server"));
    command.current_dir(&root.path);
    command.env("CONTAINER_PROJECT_ROOT", &root.path);
    command.env("HOST_PROJECT_ROOT", &root.path);
    command.env("CORE_MCP_TEST_REDIS", "memory");
    command.env("OPENWEBUI_BASE_URL", "http://127.0.0.1:9");
    command.env("ELECTRON_API_BASE", &electron_base);

    let transport = TokioChildProcess::new(command)?;
    let client = ().serve(transport).await?;
    let tools = client.list_all_tools().await?;
    assert_eq!(tools.len(), declared_tools().len());

    let system_config = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("get_system_mcp_config")
                    .with_arguments(args(&[("server_id", json!("core-one"))])),
            )
            .await?,
    );
    assert_eq!(system_config["readonly"], json!(true));

    let created = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("create_user_mcp_server").with_arguments(args(&[
                    ("server_id", json!("remote-one")),
                    (
                        "yaml_config",
                        json!({
                            "name": "Remote One",
                            "display_name": "Remote One",
                            "deployment_type": "docker",
                            "description": "stdio-created"
                        }),
                    ),
                    (
                        "fragment",
                        json!({"command": "python3", "args": ["server.py"]}),
                    ),
                ])),
            )
            .await?,
    );
    assert_eq!(created["success"], json!(true));
    assert_eq!(created["enabled"], json!(true));
    assert_eq!(created["auto_enabled"], json!(true));
    assert_eq!(created["readiness_phase"], json!("tool_ready"));

    let listed = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("list_mcp_servers")
                    .with_arguments(args(&[("filter", json!("user"))])),
            )
            .await?,
    );
    assert_eq!(listed["summary"]["user"], json!(1));

    let read_user = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("read_user_mcp_server")
                    .with_arguments(args(&[("server_id", json!("remote-one"))])),
            )
            .await?,
    );
    assert_eq!(read_user["readonly"], json!(false));

    let updated = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("update_user_mcp_server").with_arguments(args(&[
                    ("server_id", json!("remote-one")),
                    (
                        "fragment",
                        json!({"command": "python3", "args": ["updated.py"]}),
                    ),
                ])),
            )
            .await?,
    );
    assert_eq!(updated["success"], json!(true));

    let system_update_error = client
        .call_tool(
            CallToolRequestParams::new("update_user_mcp_server").with_arguments(args(&[
                ("server_id", json!("core-one")),
                (
                    "fragment",
                    json!({"command": "python3", "args": ["mutated.py"]}),
                ),
            ])),
        )
        .await
        .expect_err("system server mutation should fail");
    assert!(system_update_error.to_string().contains("immutable"));

    let deleted = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("delete_user_mcp_server").with_arguments(args(&[
                    ("server_id", json!("remote-one")),
                    ("confirm", json!(true)),
                ])),
            )
            .await?,
    );
    assert_eq!(deleted["success"], json!(true));

    let first_request = requests.recv().unwrap();
    assert_eq!(first_request.method, "POST");
    assert!(first_request.body.contains("\"server_id\":\"remote-one\""));
    let captured_paths = [
        first_request.path,
        requests.recv().unwrap().path,
        requests.recv().unwrap().path,
    ];
    assert_eq!(
        captured_paths,
        [
            "/api/toggle-mcp-server",
            "/api/restart-mcp-server/remote-one",
            "/api/delete-mcp-server/remote-one",
        ]
    );
    assert!(!root.path.join("mcp-configs-user/core-one").exists());

    client.cancel().await?;
    Ok(())
}

#[tokio::test]
async fn binary_preserves_required_env_vars_and_reports_not_configured_over_stdio() -> Result<()> {
    let root = TestRoot::new("required-env");
    let (electron_base, requests) = serve_replies(vec![
        // create → toggle enable: Electron's NOT_CONFIGURED preflight shape
        // (success, no readiness_phase/healthy fields).
        MockReply {
            status: "200 OK",
            body: json!({
                "success": true,
                "server_id": "secret-one",
                "enabled": true,
                "requiresConfiguration": true,
                "started": false,
                "uiStatus": "not_configured",
                "errorCode": "NOT_CONFIGURED",
                "error": "Missing required environment variables: MARVIN_PASSWORD",
                "message": "Server requires configuration before it can start"
            }),
        },
        // create → readiness poll resolves the phase.
        MockReply {
            status: "200 OK",
            body: json!({"healthy": false, "readiness_phase": "not_configured"}),
        },
        // update (replace entries) → restart endpoint NOT_CONFIGURED preflight shape.
        MockReply {
            status: "200 OK",
            body: json!({
                "success": true,
                "server_id": "secret-one",
                "restarted": false,
                "requiresConfiguration": true,
                "uiStatus": "not_configured",
                "errorCode": "NOT_CONFIGURED",
                "error": "Missing required environment variables: OTHER_TOKEN",
                "healthy": false,
                "readiness_phase": "not_configured",
                "message": "Server requires configuration before it can start"
            }),
        },
        // update (omit key) → normal healthy restart.
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "healthy": true, "readiness_phase": "tool_ready"}),
        },
    ]);

    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_mcp-assistant-server"));
    command.current_dir(&root.path);
    command.env("CONTAINER_PROJECT_ROOT", &root.path);
    command.env("HOST_PROJECT_ROOT", &root.path);
    command.env("CORE_MCP_TEST_REDIS", "memory");
    command.env("OPENWEBUI_BASE_URL", "http://127.0.0.1:9");
    command.env("ELECTRON_API_BASE", &electron_base);

    let transport = TokioChildProcess::new(command)?;
    let client = ().serve(transport).await?;

    let created = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("create_user_mcp_server").with_arguments(args(&[
                    ("server_id", json!("secret-one")),
                    (
                        "yaml_config",
                        json!({
                            "name": "Secret One",
                            "display_name": "Secret One",
                            "deployment_type": "docker",
                            "description": "stdio-created with secrets",
                            "required_env_vars": [
                                {
                                    "name": "MARVIN_PASSWORD",
                                    "placeholder": "Paste the Marvin password",
                                    "description": "Marvin password",
                                    "sensitive": true
                                },
                                "BARE_VAR"
                            ]
                        }),
                    ),
                    (
                        "fragment",
                        json!({"command": "python3", "args": ["server.py"], "env": {"MARVIN_PASSWORD": "${MARVIN_PASSWORD}"}}),
                    ),
                ])),
            )
            .await?,
    );
    assert_eq!(created["success"], json!(true));
    assert_eq!(created["auto_enabled"], json!(true));
    assert_eq!(created["healthy"], json!(false));
    assert_eq!(created["readiness_phase"], json!("not_configured"));
    assert!(
        created["next_steps"]
            .as_array()
            .expect("create next_steps")
            .iter()
            .any(|step| step.as_str().unwrap_or("").contains("trigger_guided_setup")),
        "create must direct the caller to the Configure flow: {created}"
    );
    assert_eq!(created["errorCode"], json!("NOT_CONFIGURED"));
    assert_eq!(created["requiresConfiguration"], json!(true));
    assert!(created["message"]
        .as_str()
        .unwrap_or("")
        .contains("needs configuration"));

    let yaml_path = root
        .path
        .join("mcp-configs-user/secret-one/secret-one.yaml");
    let written: Value =
        serde_yaml::from_str(&fs::read_to_string(&yaml_path)?).expect("parse written yaml");
    assert_eq!(
        written["required_env_vars"],
        json!([
            {
                "name": "MARVIN_PASSWORD",
                "placeholder": "Paste the Marvin password",
                "description": "Marvin password",
                "sensitive": true
            },
            { "name": "BARE_VAR" }
        ]),
        "written yaml must preserve declared entries (bare strings normalized)"
    );

    let invalid_create_error = client
        .call_tool(
            CallToolRequestParams::new("create_user_mcp_server").with_arguments(args(&[
                ("server_id", json!("bad-one")),
                (
                    "yaml_config",
                    json!({
                        "name": "Bad One",
                        "display_name": "Bad One",
                        "deployment_type": "docker",
                        "description": "invalid env var name",
                        "required_env_vars": [{ "name": "1BAD" }]
                    }),
                ),
                (
                    "fragment",
                    json!({"command": "python3", "args": ["server.py"]}),
                ),
            ])),
        )
        .await
        .expect_err("invalid env var name must fail validation");
    assert!(invalid_create_error
        .to_string()
        .contains("[A-Za-z_][A-Za-z0-9_]*"));

    // The blank-credential door (review M1): a fragment referencing an
    // undeclared env var must be rejected at create.
    let undeclared_create_error = client
        .call_tool(
            CallToolRequestParams::new("create_user_mcp_server").with_arguments(args(&[
                ("server_id", json!("leaky-one")),
                (
                    "yaml_config",
                    json!({
                        "name": "Leaky One",
                        "display_name": "Leaky One",
                        "deployment_type": "docker",
                        "description": "fragment references undeclared var"
                    }),
                ),
                (
                    "fragment",
                    json!({"command": "python3", "args": ["server.py"], "env": {"TOKEN": "${UNDECLARED_TOKEN}"}}),
                ),
            ])),
        )
        .await
        .expect_err("undeclared fragment reference must fail validation");
    assert!(undeclared_create_error
        .to_string()
        .contains("UNDECLARED_TOKEN"));

    // ...and an update that resends yaml_config without required_env_vars
    // while the on-disk fragment still references the var must be rejected
    // instead of clearing the declaration (the clear-then-blank-start door).
    let clearing_update_error = client
        .call_tool(
            CallToolRequestParams::new("update_user_mcp_server").with_arguments(args(&[
                ("server_id", json!("secret-one")),
                (
                    "yaml_config",
                    json!({
                        "name": "Secret One",
                        "display_name": "Secret One",
                        "deployment_type": "docker",
                        "description": "description-only update"
                    }),
                ),
            ])),
        )
        .await
        .expect_err("update clearing a still-referenced declaration must fail");
    assert!(clearing_update_error
        .to_string()
        .contains("MARVIN_PASSWORD"));

    let updated = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("update_user_mcp_server").with_arguments(args(&[
                    ("server_id", json!("secret-one")),
                    (
                        "yaml_config",
                        json!({
                            "name": "Secret One",
                            "display_name": "Secret One",
                            "deployment_type": "docker",
                            "description": "stdio-created with secrets",
                            "required_env_vars": [{ "name": "OTHER_TOKEN", "sensitive": true }]
                        }),
                    ),
                    (
                        "fragment",
                        json!({"command": "python3", "args": ["server.py"], "env": {"TOKEN": "${OTHER_TOKEN}"}}),
                    ),
                ])),
            )
            .await?,
    );
    assert_eq!(updated["success"], json!(true));
    assert_eq!(updated["errorCode"], json!("NOT_CONFIGURED"));
    assert_eq!(updated["readiness_phase"], json!("not_configured"));
    assert!(
        updated["next_steps"]
            .as_array()
            .expect("update next_steps")
            .iter()
            .any(|step| step.as_str().unwrap_or("").contains("trigger_guided_setup")),
        "update must direct the caller to the Configure flow: {updated}"
    );
    let replaced: Value =
        serde_yaml::from_str(&fs::read_to_string(&yaml_path)?).expect("parse replaced yaml");
    assert_eq!(
        replaced["required_env_vars"],
        json!([{ "name": "OTHER_TOKEN", "sensitive": true }])
    );

    // Clearing declarations is allowed once the fragment no longer
    // references them (whole-file-replace semantics, placeholder-free pair).
    let cleared = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("update_user_mcp_server").with_arguments(args(&[
                    ("server_id", json!("secret-one")),
                    (
                        "yaml_config",
                        json!({
                            "name": "Secret One",
                            "display_name": "Secret One",
                            "deployment_type": "docker",
                            "description": "stdio-created with secrets"
                        }),
                    ),
                    (
                        "fragment",
                        json!({"command": "python3", "args": ["server.py"]}),
                    ),
                ])),
            )
            .await?,
    );
    assert_eq!(cleared["success"], json!(true));
    let cleared_yaml: Value =
        serde_yaml::from_str(&fs::read_to_string(&yaml_path)?).expect("parse cleared yaml");
    assert_eq!(cleared_yaml["required_env_vars"], json!([]));

    let captured_paths = [
        requests.recv().unwrap().path,
        requests.recv().unwrap().path,
        requests.recv().unwrap().path,
        requests.recv().unwrap().path,
    ];
    assert_eq!(
        captured_paths,
        [
            "/api/toggle-mcp-server",
            "/api/server-readiness/secret-one",
            "/api/restart-mcp-server/secret-one",
            "/api/restart-mcp-server/secret-one",
        ]
    );

    client.cancel().await?;
    Ok(())
}
