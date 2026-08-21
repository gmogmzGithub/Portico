use std::collections::{BTreeMap, HashMap, HashSet};
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::{STANDARD as BASE64_STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use regex::Regex;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tracing::warn;
use uuid::Uuid;
use walkdir::WalkDir;

use core_mcp_shared::*;

pub(crate) use core_mcp_shared::TEST_ENV_LOCK;

pub(crate) mod shared {
    pub use core_mcp_shared::*;
}

mod subagents;
mod subagents_marketplace;

pub(crate) use subagents::*;
pub use subagents::{
    await_subagent_completion, prepare_subagent_request, run_subagent, start_subagent_run,
    AwaitOutcome, PreparedSubagentRequest, RunSubagentRequest, RunSubagentResult,
    StartedSubagentRun, DEFAULT_SUBAGENT_FOLDER_NAME,
};
use subagents_marketplace::*;

pub(crate) struct Dispatcher;

#[async_trait::async_trait]
impl ToolDispatcher for Dispatcher {
    async fn call(&self, tool_name: &str, arguments: &Map<String, Value>) -> Result<Option<Value>> {
        let result = match tool_name {
            "run_subagent" => Some(handle_run_subagent(arguments).await?),
            "list_chats" => Some(handle_list_chats(arguments).await?),
            "get_chat_status" => Some(handle_get_chat_status(arguments).await?),
            "send_message_to_chat" => Some(handle_send_message_to_chat(arguments).await?),
            "start_chat" => Some(handle_start_chat(arguments).await?),
            "create_agent" => Some(handle_create_agent(arguments).await?),
            "copy_agent" => Some(handle_copy_agent(arguments).await?),
            "get_agent" => Some(handle_get_agent(arguments).await?),
            "get_agent_system_prompt" => Some(handle_get_agent_system_prompt(arguments).await?),
            "update_agent" => Some(handle_update_agent(arguments).await?),
            "delete_agent" => Some(handle_delete_agent(arguments).await?),
            "list_agents" => Some(handle_list_agents(arguments).await?),
            "reconcile_agent_attribution" => {
                Some(handle_reconcile_agent_attribution(arguments).await?)
            }
            "list_available_tools" => Some(handle_list_available_tools(arguments).await?),
            "publish_agent" => Some(handle_publish_agent(arguments).await?),
            "unpublish_agent" => Some(handle_unpublish_agent(arguments).await?),
            "install_agent" => Some(handle_install_agent(arguments).await?),
            "reclaim_agent" => Some(handle_reclaim_agent(arguments).await?),
            "search_marketplace_agents" => Some(handle_search_marketplace_agents(arguments).await?),
            "get_marketplace_agent" => Some(handle_get_marketplace_agent(arguments).await?),
            "list_published_agents" => Some(handle_list_published_agents(arguments).await?),
            "configure_lm_studio" => Some(handle_configure_lm_studio(arguments).await?),
            "get_lm_studio_status" => Some(handle_get_lm_studio_status(arguments).await?),
            "get_system_information" => Some(handle_get_system_information(arguments).await?),
            _ => None,
        };

        Ok(result)
    }
}

#[cfg(test)]
mod dispatcher_tests {
    use super::*;

    #[test]
    fn tool_spec_descriptions_reference_prefixed_route_names() {
        let specs: Vec<Value> =
            serde_json::from_str(include_str!("../../tool_spec.json")).expect("tool spec JSON");

        let run_subagent = specs
            .iter()
            .find(|spec| spec.get("name").and_then(Value::as_str) == Some("run_subagent"))
            .expect("run_subagent spec");
        let tool_ids_description = run_subagent["inputSchema"]["properties"]["tool_server_ids"]
            ["description"]
            .as_str()
            .expect("run_subagent tool_server_ids description");
        let prompt_description = run_subagent["inputSchema"]["properties"]["prompt"]["description"]
            .as_str()
            .expect("run_subagent prompt description");
        assert!(tool_ids_description.contains("subagents_list_available_tools"));
        assert!(tool_ids_description.contains("mcp_assistant_get_chat_tools"));
        assert!(prompt_description.contains("avoid embedding detailed tool-by-tool procedures"));

        let list_chats = specs
            .iter()
            .find(|spec| spec.get("name").and_then(Value::as_str) == Some("list_chats"))
            .expect("list_chats spec");
        let list_chats_description = list_chats["description"]
            .as_str()
            .expect("list_chats description");
        assert!(list_chats_description.contains("subagents_send_message_to_chat"));

        let send_message = specs
            .iter()
            .find(|spec| spec.get("name").and_then(Value::as_str) == Some("send_message_to_chat"))
            .expect("send_message_to_chat spec");
        let target_chat_id_description = send_message["inputSchema"]["properties"]
            ["target_chat_id"]["description"]
            .as_str()
            .expect("send_message_to_chat target_chat_id description");
        assert!(target_chat_id_description.contains("subagents_list_chats"));

        let start_chat = specs
            .iter()
            .find(|spec| spec.get("name").and_then(Value::as_str) == Some("start_chat"))
            .expect("start_chat spec");
        let start_chat_description = start_chat["description"]
            .as_str()
            .expect("start_chat description");
        assert!(start_chat_description.contains("subagents_run_subagent"));
        assert!(start_chat_description.contains("subagents_send_message_to_chat"));
        let start_chat_folder_description = start_chat["inputSchema"]["properties"]["folder_name"]
            ["description"]
            .as_str()
            .expect("start_chat folder_name description");
        assert!(start_chat_folder_description.contains("Defaults to 'Sub-agents'"));
    }

    #[tokio::test]
    async fn dispatcher_routes_every_declared_tool() {
        let dispatcher = Dispatcher;
        let specs: Vec<Value> =
            serde_json::from_str(include_str!("../../tool_spec.json")).expect("tool spec JSON");

        for spec in specs {
            let tool_name = spec.get("name").and_then(Value::as_str).expect("tool name");
            let result = dispatcher.call(tool_name, &Map::new()).await;
            assert!(
                !matches!(result, Ok(None)),
                "dispatcher did not route declared tool {tool_name}"
            );
        }

        assert!(matches!(
            dispatcher
                .call("__missing_tool__", &Map::new())
                .await
                .unwrap(),
            None
        ));
    }
}
