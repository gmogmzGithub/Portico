use std::collections::{BTreeMap, HashMap, HashSet};
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde_json::{json, Map, Value};
use tracing::warn;
use uuid::Uuid;

use core_mcp_shared::*;

pub(crate) use core_mcp_shared::TEST_ENV_LOCK;

pub(crate) mod shared {
    pub use core_mcp_shared::*;
}

mod mcp_assistant;

pub(crate) use mcp_assistant::*;

pub(crate) struct Dispatcher;

#[async_trait::async_trait]
impl ToolDispatcher for Dispatcher {
    async fn call(&self, tool_name: &str, arguments: &Map<String, Value>) -> Result<Option<Value>> {
        let result = match tool_name {
            "list_mcp_servers" => Some(handle_list_mcp_servers(arguments).await?),
            "get_system_mcp_config" => Some(handle_get_system_mcp_config(arguments).await?),
            "create_user_mcp_server" => Some(handle_create_user_mcp_server(arguments).await?),
            "read_user_mcp_server" => Some(handle_read_user_mcp_server(arguments).await?),
            "update_user_mcp_server" => Some(handle_update_user_mcp_server(arguments).await?),
            "delete_user_mcp_server" => Some(handle_delete_user_mcp_server(arguments).await?),
            "validate_mcp_fragment" => Some(handle_validate_mcp_fragment(arguments).await?),
            "restart_mcp_infrastructure" => {
                Some(handle_restart_mcp_infrastructure(arguments).await?)
            }
            "restart_mcp_server" => Some(handle_restart_mcp_server(arguments).await?),
            "activate_integration" => Some(handle_activate_integration(arguments).await?),
            "get_chat_tools" => Some(handle_get_chat_tools(arguments).await?),
            "get_host_mcp_bridge_status" => {
                Some(handle_get_host_mcp_bridge_status(arguments).await?)
            }
            "configure_host_mcp_bridge_clients" => {
                Some(handle_configure_host_mcp_bridge_clients(arguments).await?)
            }
            "toggle_integration" => Some(handle_toggle_integration(arguments).await?),
            "authorize_integration" => Some(handle_authorize_integration(arguments).await?),
            "trigger_guided_setup" => Some(handle_trigger_guided_setup(arguments).await?),
            "get_mcp_server_logs" => Some(handle_get_mcp_server_logs(arguments).await?),
            _ => None,
        };

        Ok(result)
    }
}

#[cfg(test)]
mod dispatcher_tests {
    use std::env;

    use super::*;

    fn probe_arguments(tool_name: &str) -> Map<String, Value> {
        match tool_name {
            "restart_mcp_infrastructure"
            | "restart_mcp_server"
            | "authorize_integration"
            | "trigger_guided_setup"
            | "get_mcp_server_logs" => {
                Map::from_iter([("server_id".to_string(), json!("probe-server"))])
            }
            "toggle_integration" => Map::from_iter([
                ("server_id".to_string(), json!("probe-server")),
                ("enabled".to_string(), json!(true)),
            ]),
            "activate_integration" => Map::from_iter([
                ("chat_id".to_string(), json!("probe-chat")),
                ("tool_server_ids".to_string(), json!([])),
            ]),
            "get_chat_tools" => Map::from_iter([("chat_id".to_string(), json!("probe-chat"))]),
            _ => Map::new(),
        }
    }

    #[tokio::test]
    async fn dispatcher_routes_every_declared_tool() {
        let _guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let original_electron_api_base = env::var("ELECTRON_API_BASE").ok();
        let previous_electron_api_base = Some(
            original_electron_api_base
                .clone()
                .unwrap_or_else(|| "http://seeded.previous.invalid".to_string()),
        );
        env::set_var("ELECTRON_API_BASE", "http://127.0.0.1:9");

        let dispatcher = Dispatcher;
        let specs: Vec<Value> =
            serde_json::from_str(include_str!("../../tool_spec.json")).expect("tool spec JSON");

        for spec in specs {
            let tool_name = spec.get("name").and_then(Value::as_str).expect("tool name");
            let result = dispatcher
                .call(tool_name, &probe_arguments(tool_name))
                .await;
            assert!(
                !matches!(result, Ok(None)),
                "dispatcher did not route declared tool {tool_name}"
            );
        }

        let missing = dispatcher
            .call("__missing_tool__", &Map::new())
            .await
            .unwrap();
        assert!(missing.is_none());

        if let Some(value) = previous_electron_api_base {
            env::set_var("ELECTRON_API_BASE", value);
        }
        if original_electron_api_base.is_none() {
            env::remove_var("ELECTRON_API_BASE");
        }
    }
}
