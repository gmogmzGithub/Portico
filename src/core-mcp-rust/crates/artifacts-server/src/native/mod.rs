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
use bollard::container::LogOutput;
use bollard::exec::{CreateExecOptions, StartExecOptions, StartExecResults};
use bollard::models::{ContainerCreateBody, HostConfig};
use bollard::query_parameters::{
    CreateContainerOptions, DownloadFromContainerOptionsBuilder, InspectContainerOptions,
    RemoveContainerOptions, StartContainerOptions, UploadToContainerOptionsBuilder,
};
use bollard::Docker;
use flate2::write::GzEncoder;
use flate2::Compression;
use futures_util::StreamExt;
use glob::Pattern;
use mime_guess::MimeGuess;
use regex::Regex;
use serde_json::{json, Map, Value};
use tracing::warn;
use uuid::Uuid;
use walkdir::WalkDir;
use zip::ZipArchive;

use core_mcp_shared::*;

pub(crate) use core_mcp_shared::TEST_ENV_LOCK;

pub(crate) mod shared {
    pub use core_mcp_shared::*;
}

mod artifacts;

pub(crate) use artifacts::*;

const STATUS_RUNNING: &str = "running";
const STATUS_STOPPED: &str = "stopped";
const ARTIFACT_PORT_START: i64 = 10_000;
const ARTIFACT_PORT_RANGE: i64 = 10_000;
const MAX_VERSION_NOTE_LEN: usize = 50;
const DISK_STATE_DIR: &str = "_native_state";
const CHAT_INDEX_DIR: &str = "chat_index";

pub(crate) struct Dispatcher;

#[async_trait::async_trait]
impl ToolDispatcher for Dispatcher {
    async fn call(&self, tool_name: &str, arguments: &Map<String, Value>) -> Result<Option<Value>> {
        let result = match tool_name {
            "create_artifact" => handle_create_artifact(arguments).await.map(Some),
            "create_artifact_version" => handle_create_artifact_version(arguments).await.map(Some),
            "open_artifact" => handle_open_artifact(arguments).await.map(Some),
            "switch_artifact_version" => handle_switch_artifact_version(arguments).await.map(Some),
            "list_artifacts" => handle_list_artifacts(arguments).await.map(Some),
            "get_artifact_status" => handle_get_artifact_status(arguments).await.map(Some),
            "close_artifact" => handle_close_artifact(arguments).await.map(Some),
            "delete_artifact" => handle_delete_artifact(arguments).await.map(Some),
            "restore_artifact_version" => {
                handle_restore_artifact_version(arguments).await.map(Some)
            }
            "download_artifact" => handle_download_artifact(arguments).await.map(Some),
            "get_artifact_running_versions" => handle_get_artifact_running_versions(arguments)
                .await
                .map(Some),
            _ => Ok(None),
        };

        match result {
            Ok(value) => Ok(value),
            Err(error) => {
                warn!(
                    tool = tool_name,
                    error = %format!("{error:#}"),
                    "artifacts tool failed; returning sanitized caller-facing error"
                );
                artifact_tool_error_response(tool_name, &error).map(Some)
            }
        }
    }
}

#[cfg(test)]
mod dispatcher_tests {
    use super::*;

    #[test]
    fn tool_spec_descriptions_reference_prefixed_route_names() {
        let specs: Vec<Value> =
            serde_json::from_str(include_str!("../../tool_spec.json")).expect("tool spec JSON");

        let create_version = specs
            .iter()
            .find(|spec| {
                spec.get("name").and_then(Value::as_str) == Some("create_artifact_version")
            })
            .expect("create_artifact_version spec");
        let source_vm_description = create_version["inputSchema"]["properties"]["source_vm_id"]
            ["description"]
            .as_str()
            .expect("source_vm_id description");
        assert!(source_vm_description.contains("agent_vm_create"));
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
