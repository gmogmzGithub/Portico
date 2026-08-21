use anyhow::Result;
use serde_json::{Map, Value};

use core_mcp_shared::ToolDispatcher;

mod scheduling;

pub(crate) struct Dispatcher;

#[async_trait::async_trait]
impl ToolDispatcher for Dispatcher {
    async fn call(&self, tool_name: &str, arguments: &Map<String, Value>) -> Result<Option<Value>> {
        let result = match tool_name {
            "create_task" => Some(scheduling::handle_create_task(arguments).await?),
            "get_task" => Some(scheduling::handle_get_task(arguments).await?),
            "list_tasks" => Some(scheduling::handle_list_tasks(arguments).await?),
            "update_task" => Some(scheduling::handle_update_task(arguments).await?),
            "delete_task" => Some(scheduling::handle_delete_task(arguments).await?),
            "run_task_now" => Some(scheduling::handle_run_task_now(arguments).await?),
            "cancel_run" => Some(scheduling::handle_cancel_run(arguments).await?),
            "finalize_run" => Some(scheduling::handle_finalize_run(arguments).await?),
            _ => None,
        };

        Ok(result)
    }
}

#[cfg(test)]
mod dispatcher_tests {
    use super::*;

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

    #[test]
    fn task_tool_schema_guides_first_person_action_prompts_timezone_defaults_and_ad_hoc_skills() {
        let specs: Vec<Value> =
            serde_json::from_str(include_str!("../../tool_spec.json")).expect("tool spec JSON");
        let create = specs
            .iter()
            .find(|spec| spec.get("name").and_then(Value::as_str) == Some("create_task"))
            .expect("create_task spec");
        let properties = &create["inputSchema"]["properties"];

        let prompt_description = properties["prompt"]["description"]
            .as_str()
            .expect("prompt description");
        assert!(prompt_description.contains("action-oriented job specification"));
        assert!(prompt_description.contains("first-person owner wording"));
        assert!(prompt_description.contains("Remind me"));
        assert!(prompt_description.contains("do not supply assumed output"));

        let timezone_description = properties["schedule"]["properties"]["timezone"]["description"]
            .as_str()
            .expect("timezone description");
        assert!(timezone_description.contains("current user's timezone"));
        assert!(timezone_description.contains("daylight-saving"));

        let skills_description = properties["skill_ids"]["description"]
            .as_str()
            .expect("skill_ids description");
        assert!(skills_description.contains("Leave empty by default"));
        assert!(skills_description.contains("ad hoc"));
    }
}
