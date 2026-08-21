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
    let covered = BTreeSet::from([
        "run_subagent".to_string(),
        "list_chats".to_string(),
        "get_chat_status".to_string(),
        "send_message_to_chat".to_string(),
        "start_chat".to_string(),
        "create_agent".to_string(),
        "copy_agent".to_string(),
        "get_agent".to_string(),
        "get_agent_system_prompt".to_string(),
        "update_agent".to_string(),
        "delete_agent".to_string(),
        "list_agents".to_string(),
        "reconcile_agent_attribution".to_string(),
        "list_available_tools".to_string(),
        "publish_agent".to_string(),
        "unpublish_agent".to_string(),
        "install_agent".to_string(),
        "reclaim_agent".to_string(),
        "search_marketplace_agents".to_string(),
        "get_marketplace_agent".to_string(),
        "list_published_agents".to_string(),
        "configure_lm_studio".to_string(),
        "get_lm_studio_status".to_string(),
        "get_system_information".to_string(),
    ]);
    assert_eq!(
        covered,
        declared_tools(),
        "Update the coverage manifest and tests when subagents tool_spec.json changes",
    );
}

#[tokio::test]
async fn binary_starts_and_lists_tools_over_stdio() -> Result<()> {
    let transport = TokioChildProcess::new(tokio::process::Command::new(env!(
        "CARGO_BIN_EXE_subagents-server"
    )))?;
    let client = ().serve(transport).await?;
    let tools = client.list_all_tools().await?;
    assert_eq!(tools.len(), declared_tools().len());
    client.cancel().await?;
    Ok(())
}
