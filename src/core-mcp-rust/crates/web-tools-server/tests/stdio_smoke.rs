use anyhow::Result;
use rmcp::{transport::TokioChildProcess, ServiceExt};
use serde_json::Value;
use std::collections::BTreeSet;

fn declared_tools() -> BTreeSet<String> {
    serde_json::from_str::<Vec<Value>>(include_str!("../tool_spec.json"))
        .expect("tool spec JSON")
        .into_iter()
        .map(|value| value["name"].as_str().expect("tool name").to_string())
        .collect()
}

#[test]
fn coverage_manifest_matches_declared_tools() {
    let covered = BTreeSet::from(["web_search".to_string()]);
    assert_eq!(
        covered,
        declared_tools(),
        "Update the coverage manifest and tests when web-tools tool_spec.json changes",
    );
}

#[tokio::test]
async fn binary_starts_and_lists_tools_over_stdio() -> Result<()> {
    let transport = TokioChildProcess::new(tokio::process::Command::new(env!(
        "CARGO_BIN_EXE_web-tools-server"
    )))?;
    let client = ().serve(transport).await?;
    let tools = client.list_all_tools().await?;
    assert_eq!(tools.len(), declared_tools().len());
    client.cancel().await?;
    Ok(())
}
