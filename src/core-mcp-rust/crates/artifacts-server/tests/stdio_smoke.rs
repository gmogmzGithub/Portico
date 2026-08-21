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
        let path = env::temp_dir().join(format!(
            "artifacts-stdio-{name}-{}",
            Uuid::new_v4().simple()
        ));
        fs::create_dir_all(path.join("workspaces/chat-stdio")).expect("create source workspace");
        Self { path }
    }

    fn write_source_file(&self, relative_path: &str, contents: &str) {
        let path = self.path.join("workspaces/chat-stdio").join(relative_path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create source parent");
        }
        fs::write(path, contents).expect("write source file");
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
        "create_artifact".to_string(),
        "create_artifact_version".to_string(),
        "open_artifact".to_string(),
        "switch_artifact_version".to_string(),
        "list_artifacts".to_string(),
        "get_artifact_status".to_string(),
        "close_artifact".to_string(),
        "delete_artifact".to_string(),
        "restore_artifact_version".to_string(),
        "download_artifact".to_string(),
        "get_artifact_running_versions".to_string(),
    ]);
    assert_eq!(
        covered,
        declared_tools(),
        "Update the coverage manifest and tests when artifacts tool_spec.json changes",
    );
}

#[tokio::test]
async fn binary_creates_versions_lists_and_downloads_artifacts_over_stdio() -> Result<()> {
    let root = TestRoot::new("workflow");
    root.write_source_file("index.html", "v1");

    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_artifacts-server"));
    command.env("CONTAINER_PROJECT_ROOT", &root.path);
    command.env("HOST_PROJECT_ROOT", &root.path);
    command.env("CORE_MCP_TEST_REDIS", "memory");
    command.env("CORE_MCP_TEST_DOCKER", "fake");
    command.env("DISABLE_ELECTRON_NOTIFICATIONS", "1");

    let transport = TokioChildProcess::new(command)?;
    let client = ().serve(transport).await?;
    let tools = client.list_all_tools().await?;
    assert_eq!(tools.len(), declared_tools().len());

    let created = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("create_artifact").with_arguments(args(&[
                    ("chat_id", json!("chat-stdio")),
                    ("name", json!("Calculator App")),
                    ("start_command", json!("npm run dev")),
                    ("vm_id", json!("dev-vm")),
                ])),
            )
            .await?,
    );
    let artifact_id = created["artifact_id"]
        .as_str()
        .context("missing artifact_id in create_artifact response")?
        .to_string();
    assert_eq!(created["success"], json!(true));

    let listed = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("list_artifacts")
                    .with_arguments(args(&[("chat_id", json!("chat-stdio"))])),
            )
            .await?,
    );
    assert_eq!(listed["count"], json!(1));
    assert_eq!(
        listed["artifacts"][0]["artifact_id"],
        json!(artifact_id.clone())
    );

    root.write_source_file("index.html", "v2");
    let created_version = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("create_artifact_version").with_arguments(args(&[
                    ("artifact_id", json!(artifact_id.clone())),
                    ("chat_id", json!("chat-stdio")),
                    ("source_vm_id", json!("dev-vm")),
                    ("version_note", json!("agentic update")),
                ])),
            )
            .await?,
    );
    assert_eq!(created_version["version"], json!(2));

    let status = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("get_artifact_status")
                    .with_arguments(args(&[("artifact_id", json!(artifact_id.clone()))])),
            )
            .await?,
    );
    assert_eq!(status["success"], json!(true));
    assert_eq!(status["current_version"], json!(2));

    let downloaded = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("download_artifact").with_arguments(args(&[
                    ("artifact_id", json!(artifact_id.clone())),
                    ("chat_id", json!("chat-stdio")),
                    ("version", json!(1)),
                ])),
            )
            .await?,
    );
    let download_path = downloaded["file_path"]
        .as_str()
        .context("missing file_path in download_artifact response")?;
    assert_eq!(download_path, "output/Calculator_App_v1.tar.gz");
    assert!(root
        .path
        .join("workspaces/chat-stdio")
        .join(download_path)
        .exists());

    let deleted = parse_tool_payload(
        client
            .call_tool(
                CallToolRequestParams::new("delete_artifact").with_arguments(args(&[
                    ("artifact_id", json!(artifact_id)),
                    ("chat_id", json!("chat-stdio")),
                    ("confirm", json!(true)),
                ])),
            )
            .await?,
    );
    assert_eq!(deleted["success"], json!(true));

    client.cancel().await?;
    Ok(())
}
