use anyhow::{Context, Result};
use rmcp::model::{CallToolRequestParams, CallToolResult};
use rmcp::{transport::TokioChildProcess, ServiceExt};
use serde_json::{json, Map, Value};
use std::env;
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

struct TempRoot {
    path: PathBuf,
}

impl TempRoot {
    fn new(name: &str) -> Result<Self> {
        let path = env::temp_dir().join(format!(
            "core-mcp-rust-artifacts-stdio-{name}-{}",
            Uuid::new_v4().simple()
        ));
        fs::create_dir_all(path.join("mcp-configs"))?;
        fs::create_dir_all(path.join("workspaces/chat-artifacts"))?;
        fs::write(
            path.join("workspaces/chat-artifacts/index.html"),
            "<h1>artifact v1</h1>",
        )?;
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

macro_rules! call_tool_json {
    ($client:expr, $name:expr, $args:expr) => {
        payload($client.call_tool(tool_request($name, $args)).await?)
    };
}

#[tokio::test]
async fn stdio_artifacts_support_create_list_and_status_flow() -> Result<()> {
    let root = TempRoot::new("artifact-flow")?;
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_artifacts-server"));
    command.current_dir(&root.path);
    command.env("CONTAINER_PROJECT_ROOT", &root.path);
    command.env("HOST_PROJECT_ROOT", &root.path);
    command.env("CORE_MCP_TEST_REDIS", "memory");
    command.env("CORE_MCP_TEST_DOCKER", "fake");
    command.env("DISABLE_ELECTRON_NOTIFICATIONS", "1");

    let transport = TokioChildProcess::new(command)?;
    let client = ().serve(transport).await?;

    assert!(!client.list_all_tools().await?.is_empty());

    let created = call_tool_json!(
        client,
        "create_artifact",
        args(&[
            ("chat_id", json!("chat-artifacts")),
            ("name", json!("Release Dashboard")),
            ("description", json!("Generated preview build")),
            ("start_command", json!("npm run dev")),
            ("vm_id", json!("builder")),
        ])
    )?;
    let artifact_id = created
        .get("artifact_id")
        .and_then(Value::as_str)
        .context("create_artifact did not return artifact_id")?
        .to_string();
    assert_eq!(created["success"], json!(true));
    assert_eq!(created["status"], json!("running"));
    assert!(created["preview_url"].as_str().is_some());
    assert_eq!(
        fs::read_to_string(
            root.path
                .join("artifact-snapshots/_workspaces")
                .join(&artifact_id)
                .join("index.html")
        )?,
        "<h1>artifact v1</h1>"
    );

    let listed = call_tool_json!(
        client,
        "list_artifacts",
        args(&[
            ("chat_id", json!("chat-artifacts")),
            ("include_all_versions", json!(false)),
        ])
    )?;
    assert_eq!(listed["success"], json!(true));
    assert_eq!(listed["count"], json!(1));
    assert_eq!(listed["artifacts"][0]["artifact_id"], json!(artifact_id));
    assert_eq!(
        listed["artifacts"][0]["versions"].as_array().map(Vec::len),
        Some(1)
    );

    let status = call_tool_json!(
        client,
        "get_artifact_status",
        args(&[("artifact_id", json!(artifact_id))])
    )?;
    assert_eq!(status["success"], json!(true));
    assert_eq!(status["status"], json!("running"));
    assert_eq!(status["current_version"], json!(1));
    assert_eq!(status["total_versions"], json!(1));

    client.cancel().await?;
    Ok(())
}
