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
use walkdir::WalkDir;

use core_mcp_shared::*;

pub(crate) use core_mcp_shared::TEST_ENV_LOCK;

pub(crate) mod shared {
    pub use core_mcp_shared::*;
}

mod marketplace;
mod questions;
mod skills;
mod skills_ai_marketplace;

pub(crate) use marketplace::*;
pub(crate) use questions::*;
pub(crate) use skills::*;
use skills_ai_marketplace::*;

pub(crate) struct Dispatcher;

#[async_trait::async_trait]
impl ToolDispatcher for Dispatcher {
    async fn call(&self, tool_name: &str, arguments: &Map<String, Value>) -> Result<Option<Value>> {
        let result = match tool_name {
            "create_skill" => Some(handle_create_skill(arguments).await?),
            "copy_skill" => Some(handle_copy_skill(arguments).await?),
            "rename_skill" => Some(handle_rename_skill(arguments).await?),
            "read_skill" => Some(handle_read_skill(arguments).await?),
            "export_skill_bundle" => Some(handle_export_skill_bundle(arguments).await?),
            "update_skill" => Some(handle_update_skill(arguments).await?),
            "delete_skill" => Some(handle_delete_skill(arguments).await?),
            "create_skill_reference" => Some(handle_create_skill_reference(arguments).await?),
            "update_skill_reference" => Some(handle_update_skill_reference(arguments).await?),
            "delete_skill_reference" => Some(handle_delete_skill_reference(arguments).await?),
            "create_skill_script" => Some(handle_create_skill_script(arguments).await?),
            "update_skill_script" => Some(handle_update_skill_script(arguments).await?),
            "delete_skill_script" => Some(handle_delete_skill_script(arguments).await?),
            "activate_skill" => Some(handle_activate_skill(arguments).await?),
            "deactivate_skill" => Some(handle_deactivate_skill(arguments).await?),
            "list_skills" => Some(handle_list_skills(arguments).await?),
            "get_skill_reference" => Some(handle_get_skill_reference(arguments).await?),
            "get_skill_assets" => Some(handle_get_skill_assets(arguments).await?),
            "get_activated_skills" => Some(handle_get_activated_skills(arguments).await?),
            "list_marketplaces" => Some(handle_list_marketplaces(arguments).await?),
            "add_marketplace" => Some(handle_add_marketplace(arguments).await?),
            "remove_marketplace" => Some(handle_remove_marketplace(arguments).await?),
            "sync_marketplace" => Some(handle_sync_marketplace(arguments).await?),
            "sync_all_marketplaces" => Some(handle_sync_all_marketplaces(arguments).await?),
            "apply_marketplace_sync_removals" => {
                Some(handle_apply_marketplace_sync_removals(arguments).await?)
            }
            "get_marketplace_skills" => Some(handle_get_marketplace_skills(arguments).await?),
            "install_marketplace_skill" => Some(handle_install_marketplace_skill(arguments).await?),
            "replace_user_skill_with_marketplace_install" => {
                Some(handle_replace_user_skill_with_marketplace_install(arguments).await?)
            }
            "uninstall_marketplace_skill" => {
                Some(handle_uninstall_marketplace_skill(arguments).await?)
            }
            "detach_marketplace_skill_to_user_skill" => {
                Some(handle_detach_marketplace_skill_to_user_skill(arguments).await?)
            }
            "check_marketplace_skill_updates" => {
                Some(handle_check_marketplace_skill_updates(arguments).await?)
            }
            "update_marketplace_skill" => Some(handle_update_marketplace_skill(arguments).await?),
            "ask_user_question" => Some(handle_ask_user_question(arguments).await?),
            "wait" => Some(handle_wait(arguments).await?),
            "publish_skill" => Some(handle_publish_skill(arguments).await?),
            "unpublish_skill" => Some(handle_unpublish_skill(arguments).await?),
            "reclaim_skill" => Some(handle_reclaim_skill(arguments).await?),
            "install_marketplace_solution" => {
                Some(handle_install_marketplace_solution(arguments).await?)
            }
            "search_marketplace_solutions" => {
                Some(handle_search_marketplace_solutions(arguments).await?)
            }
            "get_marketplace_solution" => Some(handle_get_marketplace_solution(arguments).await?),
            "get_marketplace_bundle" => Some(handle_get_marketplace_bundle(arguments).await?),
            "list_published_skills" => Some(handle_list_published_skills(arguments).await?),
            _ => None,
        };

        Ok(result)
    }
}

#[cfg(test)]
mod dispatcher_tests {
    use super::*;

    struct EnvRestore {
        electron_api_base: Option<String>,
    }

    impl Drop for EnvRestore {
        fn drop(&mut self) {
            if let Some(value) = &self.electron_api_base {
                env::set_var("ELECTRON_API_BASE", value);
            } else {
                env::remove_var("ELECTRON_API_BASE");
            }
        }
    }

    #[test]
    fn tool_spec_descriptions_reference_prefixed_route_names() {
        let specs: Vec<Value> =
            serde_json::from_str(include_str!("../../tool_spec.json")).expect("tool spec JSON");

        let activate_skill = specs
            .iter()
            .find(|spec| spec.get("name").and_then(Value::as_str) == Some("activate_skill"))
            .expect("activate_skill spec");
        let description = activate_skill["description"]
            .as_str()
            .expect("activate_skill description");
        assert!(description.contains("mcp_assistant_toggle_integration"));
    }

    #[tokio::test]
    async fn dispatcher_routes_every_declared_tool() {
        let _guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let _restore = EnvRestore {
            electron_api_base: env::var("ELECTRON_API_BASE").ok(),
        };
        env::set_var("ELECTRON_API_BASE", "http://127.0.0.1:9");

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
