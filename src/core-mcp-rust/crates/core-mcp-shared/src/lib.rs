use std::collections::{BTreeMap, HashMap, HashSet};
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Context, Result};
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
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use redis::Commands;
use regex::Regex;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde_json::{json, Map, Value};
use tracing::{error, info, warn};
use uuid::Uuid;
use walkdir::WalkDir;
use zip::ZipArchive;

mod integration;
#[cfg(test)]
mod lib_tests;
mod managed_node_recipe;
mod overflow;
mod runtime;
mod shared;
mod skills_catalog;

pub use integration::*;
pub use managed_node_recipe::*;
pub use overflow::*;
pub use runtime::*;
pub use shared::*;
pub use skills_catalog::*;

pub const OPENWEBUI_TOKEN_KEY: &str = "openwebui:api_token";
pub const OPENWEBUI_USER_KEY: &str = "openwebui:user_id";
pub const ARTIFACT_PREFIX: &str = "artifact:";
pub const CHAT_ARTIFACTS_PREFIX: &str = "chat_artifacts:";
pub const ARTIFACT_PORT_COUNTER_KEY: &str = "artifact_next_port";
pub const VM_INFO_PREFIX: &str = "agent_vm_info:";
pub const FILE_READS_PREFIX: &str = "agent_vm_file_reads:";
pub const CONTAINER_PREFIX: &str = "agent-vm-";
pub const ARTIFACT_SNAPSHOTS_DIR: &str = "artifact-snapshots";
pub const SKILL_TTL_SECONDS: u64 = 604_800;
pub const MAX_INLINE_IMAGE_SIZE: u64 = 5 * 1024 * 1024;
pub const MAX_ICON_SIZE: usize = 1_048_576;
pub const MAX_YAML_SIZE: usize = 10_240;
pub const MAX_FRAGMENT_SIZE: usize = 10_240;
pub const MAX_USER_MCP_SERVERS: usize = 50;
pub const AUTHORIZE_POST_AUTH_WAIT_SECONDS: f64 = 30.0;
pub const ACTIVATION_WAIT_SECONDS: f64 = 30.0;
pub const ACTIVATION_POLL_INTERVAL_SECONDS: f64 = 1.0;
pub const CHAT_CAPABILITIES_LOCK_TTL_SECONDS: u64 = 180;
pub const CHAT_CAPABILITIES_LOCK_WAIT_SECONDS: f64 = 125.0;
pub const CHAT_CAPABILITIES_LOCK_POLL_INTERVAL_MILLIS: u64 = 100;
pub const READINESS_PHASE_DISABLED: &str = "disabled";
pub const READINESS_PHASE_STARTING: &str = "starting";
pub const READINESS_PHASE_TOOL_READY: &str = "tool_ready";
pub const READINESS_PHASE_CHECKING_TOKENS: &str = "checking_tokens";
pub const READINESS_PHASE_NEEDS_OAUTH: &str = "needs_oauth";
pub const READINESS_PHASE_WAITING_CALLBACK: &str = "waiting_callback";
pub const READINESS_PHASE_SERVICE_NOT_FOUND: &str = "service_not_found";
pub const READINESS_PHASE_NOT_CONFIGURED: &str = "not_configured";
pub const DEFAULT_OAUTH_CLIENT_NAME: &str = "Portico";

pub static TEST_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn init_logging() {
    let filter = std::env::var("RUST_LOG").unwrap_or_else(|_| "info".to_string());

    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .with_target(false)
        .with_ansi(false)
        .try_init();
}

pub fn connect_docker_client() -> Result<Docker> {
    Docker::connect_with_defaults().context("failed to connect to Docker daemon")
}
