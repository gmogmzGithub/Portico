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
            "core-mcp-rust-agent-vm-stdio-{name}-{}",
            Uuid::new_v4().simple()
        ));
        fs::create_dir_all(path.join("mcp-configs"))?;
        fs::create_dir_all(path.join("mcp-configs-user"))?;
        fs::create_dir_all(path.join("skills-user"))?;
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
async fn stdio_agent_vm_supports_lifecycle_and_workspace_file_flow() -> Result<()> {
    let root = TempRoot::new("agentic-flow")?;
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_agent-vm-server"));
    command.current_dir(&root.path);
    command.env("CONTAINER_PROJECT_ROOT", &root.path);
    command.env("HOST_PROJECT_ROOT", &root.path);
    command.env("CORE_MCP_TEST_REDIS", "memory");
    command.env("CORE_MCP_TEST_DOCKER", "memory");

    let transport = TokioChildProcess::new(command)?;
    let client = ().serve(transport).await?;

    let tools = client.list_all_tools().await?;
    assert!(!tools.is_empty());

    let created = call_tool_json!(client, "create", args(&[("chat_id", json!("chat-stdio"))]))?;
    let vm_id = created
        .get("vm_id")
        .and_then(Value::as_str)
        .context("create did not return vm_id")?
        .to_string();
    assert_eq!(created["success"], json!(true));
    assert_eq!(created["status"], json!("running"));
    assert!(root.path.join("workspaces/chat-stdio").exists());
    assert!(!root
        .path
        .join("workspaces/chat-stdio")
        .join(&vm_id)
        .exists());

    let created_file = call_tool_json!(
        client,
        "create_file",
        args(&[
            ("vm_id", json!(vm_id)),
            ("path", json!("/work/src/main.py")),
            ("content", json!("print('ready')\n")),
        ])
    )?;
    assert_eq!(created_file["success"], json!(true));

    let executed = call_tool_json!(
        client,
        "bash",
        args(&[
            ("vm_id", json!(vm_id)),
            ("command", json!("test -f src/main.py && printf ready")),
        ])
    )?;
    assert_eq!(executed["success"], json!(true));
    assert_eq!(executed["stdout"], json!("ready"));

    let read_file = call_tool_json!(
        client,
        "read_file",
        args(&[
            ("vm_id", json!(vm_id)),
            ("path", json!("/work/src/main.py")),
        ])
    )?;
    assert_eq!(read_file["success"], json!(true));
    assert_eq!(read_file["content"], json!("print('ready')\n"));

    let link = call_tool_json!(
        client,
        "get_workspace_file_link",
        args(&[
            ("vm_id", json!(vm_id)),
            ("file_path", json!("/work/src/main.py")),
        ])
    )?;
    assert_eq!(link["success"], json!(true));
    assert_eq!(
        fs::read_to_string(root.path.join("workspaces/chat-stdio/src/main.py"))?,
        "print('ready')\n"
    );
    assert_eq!(
        link["download_url"],
        json!("http://localhost:9876/workspace/chat-stdio/src/main.py")
    );

    let destroyed = call_tool_json!(
        client,
        "destroy",
        args(&[
            ("vm_id", json!(vm_id)),
            ("requester_chat_id", json!("chat-stdio")),
        ])
    )?;
    assert_eq!(destroyed["success"], json!(true));

    let status = call_tool_json!(client, "get_status", args(&[("vm_id", json!(vm_id))]))?;
    assert_eq!(status["success"], json!(false));

    client.cancel().await?;
    Ok(())
}
