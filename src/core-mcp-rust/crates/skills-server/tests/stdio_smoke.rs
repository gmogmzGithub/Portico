use anyhow::Result;
use rmcp::model::{CallToolRequestParams, CallToolResult};
use rmcp::{transport::TokioChildProcess, ServiceExt};
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::thread;
use uuid::Uuid;

const TEST_CREATOR_EMAIL: &str = "stdio.user@example.com";

struct TestRoot {
    path: PathBuf,
}

impl TestRoot {
    fn new(name: &str) -> Self {
        let path = env::temp_dir().join(format!("skills-stdio-{name}-{}", Uuid::new_v4().simple()));
        fs::create_dir_all(path.join("mcp-configs")).expect("create mcp-configs");
        fs::create_dir_all(path.join("mcp-configs-user")).expect("create mcp-configs-user");
        fs::create_dir_all(path.join("skills")).expect("create skills");
        fs::create_dir_all(path.join("skills-user")).expect("create skills-user");
        fs::create_dir_all(path.join("skills-marketplace")).expect("create skills-marketplace");
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

fn declared_tools() -> BTreeSet<String> {
    serde_json::from_str::<Vec<Value>>(include_str!("../tool_spec.json"))
        .expect("tool spec JSON")
        .into_iter()
        .map(|value| value["name"].as_str().expect("tool name").to_string())
        .collect()
}

fn skill_content(name: &str, description: &str) -> String {
    format!(
        "\
---
name: {name}
description: {description}
required_mcp_servers: []
metadata:
  priority: high
---
# {name}
Body for {name}
"
    )
}

fn read_http_request(stream: &mut TcpStream) -> (String, String) {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 1024];
    let header_end = loop {
        let read = stream.read(&mut chunk).expect("read Electron API request");
        assert!(
            read > 0,
            "Electron API client closed before headers completed"
        );
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(index) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
    };
    let headers = String::from_utf8(buffer[..header_end].to_vec()).expect("request headers utf8");
    let path = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .expect("request path")
        .to_string();
    let content_length = headers
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .map(|value| value.trim().parse::<usize>().expect("content length"))
        })
        .unwrap_or(0);
    let mut body = buffer[header_end..].to_vec();
    while body.len() < content_length {
        let read = stream.read(&mut chunk).expect("read Electron API body");
        assert!(read > 0, "Electron API client closed before body completed");
        body.extend_from_slice(&chunk[..read]);
    }
    (
        path,
        String::from_utf8(body[..content_length].to_vec()).expect("request body utf8"),
    )
}

fn split_frontmatter(content: &str) -> (serde_yaml::Mapping, &str) {
    let rest = content
        .strip_prefix("---\n")
        .expect("test skill frontmatter opener");
    let (frontmatter, body) = rest
        .split_once("\n---\n")
        .expect("test skill frontmatter closer");
    (
        serde_yaml::from_str(frontmatter).expect("test skill frontmatter YAML"),
        body,
    )
}

fn canonical_test_skill(skill_name: &str, content: &str, creator: &str) -> String {
    let (mut metadata, body) = split_frontmatter(content);
    metadata.insert(
        serde_yaml::Value::String("name".to_string()),
        serde_yaml::Value::String(skill_name.to_string()),
    );
    metadata.insert(
        serde_yaml::Value::String("created_by_email".to_string()),
        serde_yaml::Value::String(creator.to_string()),
    );
    format!(
        "---\n{}---\n{}",
        serde_yaml::to_string(&metadata).expect("serialize canonical skill metadata"),
        body
    )
}

fn spawn_test_electron_skill_api(root: PathBuf) -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind test Electron API");
    let base = format!(
        "http://{}",
        listener.local_addr().expect("test Electron API address")
    );
    let handle = thread::spawn(move || {
        for expected_path in ["/api/user-skills/create", "/api/user-skills/update"] {
            let (mut stream, _) = listener.accept().expect("accept Electron API request");
            let (path, body) = read_http_request(&mut stream);
            assert_eq!(path, expected_path);
            let payload: Value = serde_json::from_str(&body).expect("Electron API request JSON");
            assert!(
                payload.get("author").is_none(),
                "legacy caller author must not reach the authoritative service"
            );
            let skill_name = payload["skill_name"].as_str().expect("skill_name");
            let skill_content = payload["skill_content"].as_str().expect("skill_content");
            let skill_dir = root.join("skills-user").join(skill_name);
            fs::create_dir_all(&skill_dir).expect("create authoritative skill directory");
            fs::write(
                skill_dir.join("SKILL.md"),
                canonical_test_skill(skill_name, skill_content, TEST_CREATOR_EMAIL),
            )
            .expect("write authoritative skill file");

            let response_body = serde_json::to_vec(&json!({
                "success": true,
                "skill_name": skill_name,
                "path": skill_dir,
                "created_by_email": TEST_CREATOR_EMAIL,
            }))
            .expect("serialize Electron API response");
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                response_body.len()
            )
            .and_then(|_| stream.write_all(&response_body))
            .expect("write Electron API response");
        }
    });
    (base, handle)
}

#[test]
fn coverage_manifest_matches_declared_tools() {
    let covered = BTreeSet::from([
        "create_skill".to_string(),
        "copy_skill".to_string(),
        "rename_skill".to_string(),
        "read_skill".to_string(),
        "export_skill_bundle".to_string(),
        "update_skill".to_string(),
        "delete_skill".to_string(),
        "create_skill_reference".to_string(),
        "update_skill_reference".to_string(),
        "delete_skill_reference".to_string(),
        "create_skill_script".to_string(),
        "update_skill_script".to_string(),
        "delete_skill_script".to_string(),
        "activate_skill".to_string(),
        "deactivate_skill".to_string(),
        "list_skills".to_string(),
        "get_skill_reference".to_string(),
        "get_skill_assets".to_string(),
        "get_activated_skills".to_string(),
        "list_marketplaces".to_string(),
        "add_marketplace".to_string(),
        "remove_marketplace".to_string(),
        "sync_marketplace".to_string(),
        "sync_all_marketplaces".to_string(),
        // Covered by stdio_marketplace_flow.rs
        // stdio_apply_sync_removals_requires_confirm_then_proxies.
        "apply_marketplace_sync_removals".to_string(),
        "get_marketplace_skills".to_string(),
        "install_marketplace_skill".to_string(),
        "replace_user_skill_with_marketplace_install".to_string(),
        "uninstall_marketplace_skill".to_string(),
        "detach_marketplace_skill_to_user_skill".to_string(),
        "check_marketplace_skill_updates".to_string(),
        "update_marketplace_skill".to_string(),
        "ask_user_question".to_string(),
        "wait".to_string(),
        "publish_skill".to_string(),
        "unpublish_skill".to_string(),
        "reclaim_skill".to_string(),
        "install_marketplace_solution".to_string(),
        "search_marketplace_solutions".to_string(),
        "get_marketplace_solution".to_string(),
        "get_marketplace_bundle".to_string(),
        "list_published_skills".to_string(),
    ]);
    assert_eq!(
        covered,
        declared_tools(),
        "Update the coverage manifest and tests when skills tool_spec.json changes",
    );
}

#[tokio::test]
async fn binary_handles_skill_crud_references_scripts_and_activation_over_stdio() -> Result<()> {
    let root = TestRoot::new("workflow");
    let (electron_api_base, electron_api_thread) = spawn_test_electron_skill_api(root.path.clone());
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_skills-server"));
    command.current_dir(&root.path);
    command.env("CONTAINER_PROJECT_ROOT", &root.path);
    command.env("HOST_PROJECT_ROOT", &root.path);
    command.env("CORE_MCP_TEST_REDIS", "memory");
    command.env("OPENWEBUI_BASE_URL", "http://127.0.0.1:9");
    command.env("ELECTRON_API_BASE", electron_api_base);

    let transport = TokioChildProcess::new(command)?;
    let client = ().serve(transport).await?;
    let tools = client.list_all_tools().await?;
    assert_eq!(tools.len(), declared_tools().len());

    let created = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("create_skill").with_arguments(args(&[
                    ("skill_name", json!("writer")),
                    (
                        "skill_content",
                        json!(skill_content("Writer", "Draft text agentically")),
                    ),
                ])),
            )
            .await?,
    );
    assert_eq!(created["success"], json!(true));
    assert_eq!(created["created_by_email"], json!(TEST_CREATOR_EMAIL));

    let updated = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("update_skill").with_arguments(args(&[
                    ("skill_name", json!("writer")),
                    (
                        "skill_content",
                        json!(skill_content("Writer", "Revised drafting instructions")),
                    ),
                ])),
            )
            .await?,
    );
    assert_eq!(updated["success"], json!(true));
    assert_eq!(updated["created_by_email"], json!(TEST_CREATOR_EMAIL));

    let created_reference = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("create_skill_reference").with_arguments(args(&[
                    ("skill_name", json!("writer")),
                    ("reference_path", json!("guide.md")),
                    ("content", json!("reference v1")),
                ])),
            )
            .await?,
    );
    assert_eq!(created_reference["success"], json!(true));

    let updated_reference = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("update_skill_reference").with_arguments(args(&[
                    ("skill_name", json!("writer")),
                    ("reference_path", json!("guide.md")),
                    ("content", json!("reference v2")),
                ])),
            )
            .await?,
    );
    assert_eq!(updated_reference["success"], json!(true));

    let created_script = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("create_skill_script").with_arguments(args(&[
                    ("skill_name", json!("writer")),
                    ("script_path", json!("runner.py")),
                    ("content", json!("print('script v1')")),
                ])),
            )
            .await?,
    );
    assert_eq!(created_script["success"], json!(true));

    let updated_script = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("update_skill_script").with_arguments(args(&[
                    ("skill_name", json!("writer")),
                    ("script_path", json!("runner.py")),
                    ("content", json!("print('script v2')")),
                ])),
            )
            .await?,
    );
    assert_eq!(updated_script["success"], json!(true));

    let listed = parse_tool_payload(
        client
            .call_tool(CallToolRequestParams::new("list_skills"))
            .await?,
    );
    assert_eq!(listed["success"], json!(true));
    assert_eq!(listed["total"], json!(1));

    let read_skill = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("read_skill")
                    .with_arguments(args(&[("skill_name", json!("writer"))])),
            )
            .await?,
    );
    assert_eq!(read_skill["metadata"]["source"], json!("user"));
    assert_eq!(
        read_skill["metadata"]["created_by_email"],
        json!(TEST_CREATOR_EMAIL)
    );

    let read_reference = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("get_skill_reference").with_arguments(args(&[
                    ("skill_name", json!("writer")),
                    ("reference_path", json!("guide.md")),
                ])),
            )
            .await?,
    );
    assert_eq!(read_reference["content"], json!("reference v2"));

    let activated = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("activate_skill").with_arguments(args(&[
                    ("skill_name", json!("writer")),
                    ("chat_id", json!("chat-stdio")),
                ])),
            )
            .await?,
    );
    assert_eq!(activated["success"], json!(true));
    assert_eq!(activated["activated_skills"], json!(["writer"]));

    let activated_list = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("get_activated_skills")
                    .with_arguments(args(&[("chat_id", json!("chat-stdio"))])),
            )
            .await?,
    );
    assert_eq!(activated_list["success"], json!(true));
    assert_eq!(activated_list["total"], json!(1));

    let deactivated = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("deactivate_skill").with_arguments(args(&[
                    ("skill_name", json!("writer")),
                    ("chat_id", json!("chat-stdio")),
                ])),
            )
            .await?,
    );
    assert_eq!(deactivated["success"], json!(true));

    let deleted = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("delete_skill").with_arguments(args(&[
                    ("skill_name", json!("writer")),
                    ("confirm", json!(true)),
                ])),
            )
            .await?,
    );
    assert_eq!(deleted["success"], json!(true));
    assert!(
        !root.path.join("skills-user/writer").exists(),
        "delete_skill should remove the user skill directory"
    );

    client.cancel().await?;
    electron_api_thread
        .join()
        .expect("test Electron skill API thread");
    Ok(())
}
