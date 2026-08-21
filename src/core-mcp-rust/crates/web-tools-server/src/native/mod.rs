use std::collections::{BTreeMap, HashMap, HashSet};
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde_json::{json, Map, Value};
use tracing::warn;
use uuid::Uuid;

use core_mcp_shared::*;

pub(crate) use core_mcp_shared::TEST_ENV_LOCK;

pub(crate) mod shared {
    pub use core_mcp_shared::*;
}

mod web_tools;

pub(crate) use web_tools::*;

pub(crate) struct Dispatcher;

#[async_trait::async_trait]
impl ToolDispatcher for Dispatcher {
    async fn call(&self, tool_name: &str, arguments: &Map<String, Value>) -> Result<Option<Value>> {
        let result = match tool_name {
            "web_search" => Some(handle_web_search(arguments).await?),
            _ => None,
        };

        Ok(result)
    }
}

#[cfg(test)]
mod dispatcher_tests {
    use super::*;

    #[test]
    fn shared_reexports_are_accessible() {
        let _guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        assert_eq!(shared::OPENWEBUI_TOKEN_KEY, OPENWEBUI_TOKEN_KEY);
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

    #[tokio::test]
    async fn dispatcher_returns_web_search_error_payload_for_invalid_requests() {
        let dispatcher = Dispatcher;
        let response = dispatcher
            .call("web_search", &Map::new())
            .await
            .expect("dispatcher call should succeed")
            .expect("web_search should produce a payload");

        let payload: Value = serde_json::from_str(
            response["content"][0]["text"]
                .as_str()
                .expect("response text should exist"),
        )
        .expect("payload JSON");

        assert_eq!(payload["success"], json!(false));
        assert_eq!(payload["tool"], json!("web_search"));
        assert_eq!(payload["error_type"], json!("KeyError"));
    }
}
