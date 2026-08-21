use anyhow::{Context, Result};
use rmcp::model::{CallToolRequestParams, CallToolResult};
use rmcp::{transport::TokioChildProcess, ServiceExt};
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use std::env;
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

struct TestRoot {
    path: PathBuf,
}

impl TestRoot {
    fn new(name: &str) -> Self {
        let path =
            env::temp_dir().join(format!("agent-vm-stdio-{name}-{}", Uuid::new_v4().simple()));
        fs::create_dir_all(path.join("mcp-configs")).expect("create mcp-configs");
        fs::create_dir_all(path.join("mcp-configs-user")).expect("create mcp-configs-user");
        fs::create_dir_all(path.join("skills-user")).expect("create skills-user");
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

#[test]
fn coverage_manifest_matches_declared_tools() {
    let covered = BTreeSet::from([
        "create".to_string(),
        "destroy".to_string(),
        "get_status".to_string(),
        "bash".to_string(),
        "python".to_string(),
        "create_file".to_string(),
        "create_files".to_string(),
        "edit_file".to_string(),
        "edit_files".to_string(),
        "read_file".to_string(),
        "read_fragment".to_string(),
        "read_files".to_string(),
        "delete_file".to_string(),
        "list_files".to_string(),
        "execute_skill_script".to_string(),
        "get_workspace_file_link".to_string(),
        "display_files".to_string(),
        "request_images".to_string(),
        "request_sensitive_information".to_string(),
        "set_chat_workspace".to_string(),
        "unzip_file".to_string(),
        "find_files".to_string(),
        "grep".to_string(),
        "grep_file".to_string(),
    ]);
    assert_eq!(
        covered,
        declared_tools(),
        "Update the coverage manifest and tests when agent-vm tool_spec.json changes",
    );
}

#[tokio::test]
async fn binary_starts_and_handles_basic_vm_lifecycle_over_stdio() -> Result<()> {
    let root = TestRoot::new("lifecycle");
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_agent-vm-server"));
    command.env("CONTAINER_PROJECT_ROOT", &root.path);
    command.env("HOST_PROJECT_ROOT", &root.path);
    command.env("CORE_MCP_TEST_REDIS", "memory");
    command.env("CORE_MCP_TEST_DOCKER", "memory");

    let transport = TokioChildProcess::new(command)?;
    let client = ().serve(transport).await?;
    let tools = client.list_all_tools().await?;
    assert_eq!(tools.len(), declared_tools().len());

    let created = parse_tool_payload(
        client
            .call_tool(CallToolRequestParams::new("create").with_arguments(args(&[
                ("chat_id", json!("chat-stdio")),
                ("timeout_hours", json!(2.0)),
            ])))
            .await?,
    );
    let vm_id = created["vm_id"]
        .as_str()
        .context("missing vm_id in create response")?
        .to_string();
    assert_eq!(created["success"], json!(true));

    let status = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("get_status")
                    .with_arguments(args(&[("vm_id", json!(vm_id.clone()))])),
            )
            .await?,
    );
    assert_eq!(status["success"], json!(true));
    assert_eq!(status["owner_chat_id"], json!("chat-stdio"));

    let created_file = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("create_file").with_arguments(args(&[
                    ("vm_id", json!(vm_id.clone())),
                    ("path", json!("/work/demo.txt")),
                    ("content", json!("hello from stdio")),
                ])),
            )
            .await?,
    );
    assert_eq!(created_file["success"], json!(true));

    let read_file = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("read_file").with_arguments(args(&[
                    ("vm_id", json!(vm_id.clone())),
                    ("path", json!("/work/demo.txt")),
                ])),
            )
            .await?,
    );
    assert_eq!(read_file["success"], json!(true));
    assert_eq!(read_file["content"], json!("hello from stdio"));

    let wrote_workspace = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("create_file").with_arguments(args(&[
                    ("vm_id", json!(vm_id.clone())),
                    (
                        "path",
                        json!("/work/reports/Agg Disco Pipeline 2025 Overview (v2).md"),
                    ),
                    ("content", json!("stdio workspace link")),
                ])),
            )
            .await?,
    );
    assert_eq!(wrote_workspace["success"], json!(true));
    assert_eq!(
        fs::read_to_string(
            root.path
                .join("workspaces/chat-stdio/reports/Agg Disco Pipeline 2025 Overview (v2).md",),
        )?,
        "stdio workspace link",
    );

    let workspace_link = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("get_workspace_file_link").with_arguments(args(&[
                    ("vm_id", json!(vm_id.clone())),
                    (
                        "file_path",
                        json!("/work/reports/Agg Disco Pipeline 2025 Overview (v2).md"),
                    ),
                ])),
            )
            .await?,
    );
    assert_eq!(workspace_link["success"], json!(true));
    assert_eq!(
        workspace_link["download_url"],
        json!(
            "http://localhost:9876/workspace/chat-stdio/reports/Agg%20Disco%20Pipeline%202025%20Overview%20%28v2%29.md"
        )
    );
    assert_eq!(
        workspace_link["markdown_link"],
        json!(
            "[Download Agg Disco Pipeline 2025 Overview (v2).md](http://localhost:9876/workspace/chat-stdio/reports/Agg%20Disco%20Pipeline%202025%20Overview%20%28v2%29.md)"
        )
    );

    let destroyed = parse_tool_payload(
        client
            .call_tool(CallToolRequestParams::new("destroy").with_arguments(args(&[
                ("vm_id", json!(vm_id)),
                ("requester_chat_id", json!("chat-stdio")),
            ])))
            .await?,
    );
    assert_eq!(destroyed["success"], json!(true));

    client.cancel().await?;
    Ok(())
}
