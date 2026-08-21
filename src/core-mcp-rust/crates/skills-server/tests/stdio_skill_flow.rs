use anyhow::{Context, Result};
use rmcp::model::{CallToolRequestParams, CallToolResult};
use rmcp::{transport::TokioChildProcess, ServiceExt};
use serde_json::{json, Map, Value};
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::thread;
use uuid::Uuid;

struct TempRoot {
    path: PathBuf,
}

impl TempRoot {
    fn new(name: &str) -> Result<Self> {
        let path = env::temp_dir().join(format!(
            "core-mcp-rust-skills-stdio-{name}-{}",
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

fn skill_markdown(description: &str) -> String {
    format!(
        "\
---
name: release-checker
description: {description}
required_mcp_servers:
  - server:subagents
metadata:
  priority: high
---
# Release Checker

Validate release readiness.
"
    )
}

fn read_http_request(stream: &mut TcpStream) -> (String, Value) {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 1024];
    let header_end = loop {
        let read = stream.read(&mut chunk).expect("read Electron API request");
        assert!(read > 0, "request ended before headers completed");
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
        .unwrap_or_default();
    let mut body = buffer[header_end..].to_vec();
    while body.len() < content_length {
        let read = stream.read(&mut chunk).expect("read Electron API body");
        assert!(read > 0, "request ended before body completed");
        body.extend_from_slice(&chunk[..read]);
    }
    (
        path,
        serde_json::from_slice(&body[..content_length]).expect("request JSON"),
    )
}

fn spawn_test_electron_skill_api(root: PathBuf) -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind test Electron API");
    let base = format!(
        "http://{}",
        listener.local_addr().expect("listener address")
    );
    let handle = thread::spawn(move || {
        for (request_index, expected_path) in [
            "/api/user-skills/create",
            "/api/user-skills/update",
            "/api/user-skills/update",
        ]
        .into_iter()
        .enumerate()
        {
            let (mut stream, _) = listener.accept().expect("accept Electron API request");
            let (path, payload) = read_http_request(&mut stream);
            assert_eq!(path, expected_path);
            let skill_name = payload["skill_name"].as_str().expect("skill_name");
            let skill_content = payload["skill_content"].as_str().expect("skill_content");
            let skill_dir = root.join("skills-user").join(skill_name);
            if request_index == 2 {
                let response = serde_json::to_vec(&json!({
                    "success": false,
                    "code": "malformed_skill_frontmatter",
                    "error": "SKILL.md updates require YAML frontmatter",
                }))
                .expect("response JSON");
                write!(
                    stream,
                    "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    response.len()
                )
                .and_then(|_| stream.write_all(&response))
                .expect("write Electron API response");
                continue;
            }
            fs::create_dir_all(&skill_dir).expect("create skill directory");
            fs::write(skill_dir.join("SKILL.md"), skill_content).expect("write skill");
            let response = serde_json::to_vec(&json!({
                "success": true,
                "skill_name": skill_name,
            }))
            .expect("response JSON");
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                response.len()
            )
            .and_then(|_| stream.write_all(&response))
            .expect("write Electron API response");
        }
    });
    (base, handle)
}

macro_rules! call_tool_json {
    ($client:expr, $name:expr, $args:expr) => {
        payload($client.call_tool(tool_request($name, $args)).await?)
    };
}

#[tokio::test]
async fn stdio_skills_support_crud_and_reference_flow() -> Result<()> {
    let root = TempRoot::new("skills-flow")?;
    let (electron_api_base, electron_api_thread) = spawn_test_electron_skill_api(root.path.clone());
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_skills-server"));
    command.current_dir(&root.path);
    command.env("CONTAINER_PROJECT_ROOT", &root.path);
    command.env("HOST_PROJECT_ROOT", &root.path);
    command.env("CORE_MCP_TEST_REDIS", "memory");
    command.env("ELECTRON_API_BASE", electron_api_base);

    let transport = TokioChildProcess::new(command)?;
    let client = ().serve(transport).await?;

    assert!(!client.list_all_tools().await?.is_empty());

    let created = call_tool_json!(
        client,
        "create_skill",
        args(&[
            ("skill_name", json!("release-checker")),
            (
                "skill_content",
                json!(skill_markdown("Checks release readiness"))
            ),
        ])
    )?;
    assert_eq!(created["success"], json!(true));
    assert!(root
        .path
        .join("skills-user/release-checker/SKILL.md")
        .exists());

    let read = call_tool_json!(
        client,
        "read_skill",
        args(&[("skill_name", json!("release-checker"))])
    )?;
    assert_eq!(read["success"], json!(true));
    assert_eq!(
        read["metadata"]["description"],
        json!("Checks release readiness")
    );

    let updated = call_tool_json!(
        client,
        "update_skill",
        args(&[
            ("skill_name", json!("release-checker")),
            (
                "skill_content",
                json!(skill_markdown("Updated release gatekeeper"))
            ),
        ])
    )?;
    assert_eq!(updated["success"], json!(true));
    assert!(
        fs::read_to_string(root.path.join("skills-user/release-checker/SKILL.md"))?
            .contains("Updated release gatekeeper")
    );

    let skill_path = root.path.join("skills-user/release-checker/SKILL.md");
    let before_rejected_update = fs::read_to_string(&skill_path)?;
    // Electron validation failures now cross the RMCP boundary as structured
    // {success:false, code, error} payloads the model can read and remediate,
    // not as opaque transport errors (proxy_user_skill_mutation contract).
    let rejected_update = call_tool_json!(
        client,
        "update_skill",
        args(&[
            ("skill_name", json!("release-checker")),
            ("skill_content", json!("# Missing frontmatter\n")),
        ])
    )?;
    assert_eq!(rejected_update["success"], json!(false));
    assert_eq!(rejected_update["code"], json!("malformed_skill_frontmatter"));
    assert!(
        rejected_update["error"]
            .as_str()
            .unwrap_or_default()
            .contains("YAML frontmatter"),
        "unexpected rejection payload: {rejected_update}"
    );
    assert_eq!(fs::read_to_string(&skill_path)?, before_rejected_update);

    let created_reference = call_tool_json!(
        client,
        "create_skill_reference",
        args(&[
            ("skill_name", json!("release-checker")),
            ("reference_path", json!("references/checklist.md")),
            ("content", json!("1. Run tests\n2. Publish build\n")),
        ])
    )?;
    assert_eq!(created_reference["success"], json!(true));

    let updated_reference = call_tool_json!(
        client,
        "update_skill_reference",
        args(&[
            ("skill_name", json!("release-checker")),
            ("reference_path", json!("references/checklist.md")),
            (
                "content",
                json!("1. Run tests\n2. Publish build\n3. Verify smoke tests\n")
            ),
        ])
    )?;
    assert_eq!(updated_reference["success"], json!(true));

    let fetched_reference = call_tool_json!(
        client,
        "get_skill_reference",
        args(&[
            ("skill_name", json!("release-checker")),
            ("reference_path", json!("references/checklist.md")),
            ("chat_id", json!("chat-skills")),
        ])
    )?;
    assert_eq!(fetched_reference["success"], json!(true));
    assert!(fetched_reference["content"]
        .as_str()
        .unwrap_or_default()
        .contains("Verify smoke tests"));

    let listed = call_tool_json!(
        client,
        "list_skills",
        args(&[
            ("filter_source", json!("user")),
            ("include_content", json!(false)),
        ])
    )?;
    assert_eq!(listed["success"], json!(true));
    assert_eq!(listed["total"], json!(1));
    assert_eq!(listed["skills"][0]["name"], json!("release-checker"));

    let deleted_reference = call_tool_json!(
        client,
        "delete_skill_reference",
        args(&[
            ("skill_name", json!("release-checker")),
            ("reference_path", json!("references/checklist.md")),
        ])
    )?;
    assert_eq!(deleted_reference["success"], json!(true));
    assert!(!root
        .path
        .join("skills-user/release-checker/references/checklist.md")
        .exists());

    let deleted_skill = call_tool_json!(
        client,
        "delete_skill",
        args(&[
            ("skill_name", json!("release-checker")),
            ("confirm", json!(true)),
        ])
    )?;
    assert_eq!(deleted_skill["success"], json!(true));
    assert!(!root.path.join("skills-user/release-checker").exists());

    client.cancel().await?;
    electron_api_thread
        .join()
        .expect("test Electron API thread should finish");
    Ok(())
}
