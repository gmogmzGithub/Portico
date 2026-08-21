use anyhow::Result;
use rmcp::transport::TokioChildProcess;
use rmcp::ServiceExt;
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
            "scheduling-stdio-{name}-{}",
            Uuid::new_v4().simple()
        ));
        fs::create_dir_all(path.join("mcp-configs")).expect("create mcp-configs");
        fs::create_dir_all(path.join("mcp-configs-user")).expect("create mcp-configs-user");
        fs::create_dir_all(path.join("skills")).expect("create skills");
        fs::create_dir_all(path.join("skills-user")).expect("create skills-user");
        fs::create_dir_all(path.join("skills-marketplace")).expect("create skills-marketplace");
        fs::create_dir_all(path.join("app-support")).expect("create app-support");
        Self { path }
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn declared_tools() -> BTreeSet<String> {
    serde_json::from_str::<Vec<serde_json::Value>>(include_str!("../tool_spec.json"))
        .expect("tool spec JSON")
        .into_iter()
        .map(|value| value["name"].as_str().expect("tool name").to_string())
        .collect()
}

#[test]
fn coverage_manifest_matches_declared_tools() {
    let covered = BTreeSet::from([
        "create_task".to_string(),
        "get_task".to_string(),
        "list_tasks".to_string(),
        "update_task".to_string(),
        "delete_task".to_string(),
        "run_task_now".to_string(),
        "cancel_run".to_string(),
        "finalize_run".to_string(),
    ]);
    assert_eq!(
        covered,
        declared_tools(),
        "Update the coverage manifest and tests when scheduling tool_spec.json changes",
    );
}

#[tokio::test]
async fn binary_lists_declared_tools_over_stdio() -> Result<()> {
    let root = TestRoot::new("smoke");
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_scheduling-server"));
    command.current_dir(&root.path);
    command.env("CONTAINER_PROJECT_ROOT", &root.path);
    command.env("HOST_PROJECT_ROOT", &root.path);
    command.env(
        "PORTICO_APP_SUPPORT_DIR",
        root.path.join("app-support"),
    );

    let transport = TokioChildProcess::new(command)?;
    let client = ().serve(transport).await?;
    let tools = client.list_all_tools().await?;
    assert_eq!(tools.len(), declared_tools().len());
    Ok(())
}
