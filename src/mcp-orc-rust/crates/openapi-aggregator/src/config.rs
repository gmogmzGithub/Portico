use std::collections::HashMap;
use std::io::ErrorKind;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use chrono::Utc;
use log::warn;
use reqwest::{Client, Url};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::RwLock;

const DEFAULT_ELECTRON_API_URL: &str = "http://host.docker.internal:9876/api/oauth-log";
const DEFAULT_MCP_ASSISTANT_URL: &str =
    "http://mcpo-core:8081/mcp-assistant/mcp_assistant_list_mcp_servers";
const DEFAULT_SERVER_ROUTES_FILE: &str = "/app/mcpo-configs-generated/server-routing.json";

#[derive(Clone)]
pub struct SharedState(pub Arc<AppState>);

pub struct AppState {
    pub(crate) config: AppConfig,
    pub(crate) client: Client,
    pub(crate) spec_cache: RwLock<TimedCache<Value>>,
    pub(crate) servers_cache: RwLock<TimedCache<Vec<String>>>,
}

#[derive(Clone, Debug)]
pub struct AppConfig {
    pub mcpo_servers: Vec<String>,
    pub container_prefix: String,
    pub use_static_servers: bool,
    pub cache_ttl: Duration,
    pub servers_cache_ttl: Duration,
    pub port: u16,
    pub electron_api_url: String,
    pub mcp_assistant_url: String,
    pub server_routes_file: String,
}

#[derive(Debug, Default)]
pub(crate) struct TimedCache<T> {
    pub(crate) value: Option<T>,
    pub(crate) timestamp: Option<Instant>,
}

impl AppConfig {
    pub fn from_env() -> Result<Self> {
        Ok(Self {
            mcpo_servers: std::env::var("MCPO_SERVERS")
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .collect(),
            container_prefix: std::env::var("MCPO_CONTAINER_PREFIX")
                .unwrap_or_else(|_| "mcpo".to_string()),
            use_static_servers: parse_bool_env("MCPO_USE_STATIC_SERVERS", false),
            cache_ttl: Duration::from_secs(parse_u64_env(
                "OPENAPI_AGGREGATOR_CACHE_TTL_SECONDS",
                5,
                2,
            )),
            servers_cache_ttl: Duration::from_secs(parse_u64_env(
                "OPENAPI_AGGREGATOR_SERVERS_CACHE_TTL_SECONDS",
                5,
                2,
            )),
            port: parse_u16_env("PORT", 8080),
            electron_api_url: std::env::var("OPENAPI_AGGREGATOR_ELECTRON_API_URL")
                .unwrap_or_else(|_| DEFAULT_ELECTRON_API_URL.to_string()),
            mcp_assistant_url: std::env::var("OPENAPI_AGGREGATOR_MCP_ASSISTANT_URL")
                .unwrap_or_else(|_| DEFAULT_MCP_ASSISTANT_URL.to_string()),
            server_routes_file: std::env::var("MCPO_SERVER_ROUTES_FILE")
                .unwrap_or_else(|_| DEFAULT_SERVER_ROUTES_FILE.to_string()),
        })
    }
}

impl AppState {
    pub fn new(config: AppConfig) -> Result<SharedState> {
        let client = Client::builder()
            .build()
            .context("failed to create HTTP client for OpenAPI aggregator")?;

        Ok(SharedState(Arc::new(Self {
            config,
            client,
            spec_cache: RwLock::new(TimedCache::default()),
            servers_cache: RwLock::new(TimedCache::default()),
        })))
    }
}

impl SharedState {
    pub(crate) fn config(&self) -> &AppConfig {
        &self.0.config
    }

    pub(crate) async fn log_oauth(&self, level: &str, message: &str, layer: &str) {
        let timestamp = Utc::now().to_rfc3339();
        eprintln!(
            "[{}] [OAuth:{}] [{}] {}",
            timestamp.replace("+00:00", "Z"),
            layer,
            level,
            message
        );

        let payload = json!({
            "layer": layer,
            "level": level,
            "message": message,
        });

        let _ = self
            .0
            .client
            .post(&self.config().electron_api_url)
            .timeout(Duration::from_secs(2))
            .json(&payload)
            .send()
            .await;
    }
}

fn parse_bool_env(key: &str, default: bool) -> bool {
    match std::env::var(key) {
        Ok(value) => matches!(
            value.to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        Err(_) => default,
    }
}

fn parse_u64_env(key: &str, default: u64, min: u64) -> u64 {
    std::env::var(key)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(default)
        .max(min)
}

fn parse_u16_env(key: &str, default: u16) -> u16 {
    std::env::var(key)
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(default)
}

pub(crate) fn container_host(container_prefix: &str, server_id: &str) -> String {
    let normalized_server_id = server_id.replace('_', "-");
    format!("{container_prefix}-{normalized_server_id}")
}

#[derive(Debug, Deserialize)]
struct ServerRoute {
    network_host: Option<String>,
    host: Option<String>,
    port: Option<u16>,
    deployment_scope: Option<String>,
}

fn route_host(route: &ServerRoute) -> Option<String> {
    route
        .network_host
        .as_deref()
        .or(route.host.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn load_server_routes(routes_file: &str) -> Option<HashMap<String, ServerRoute>> {
    let routes_path = Path::new(routes_file);
    let contents = match std::fs::read_to_string(routes_path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == ErrorKind::NotFound => return None,
        Err(error) => {
            warn!(
                "Failed to read server routes file {}: {}",
                routes_path.display(),
                error
            );
            return None;
        }
    };

    match serde_json::from_str::<HashMap<String, ServerRoute>>(&contents) {
        Ok(routes) => Some(routes),
        Err(error) => {
            warn!(
                "Failed to parse server routes file {}: {}",
                routes_path.display(),
                error
            );
            None
        }
    }
}

pub(crate) fn regular_servers_from_routes(config: &AppConfig) -> Option<Vec<String>> {
    let mut servers = load_server_routes(&config.server_routes_file)?
        .into_iter()
        .filter_map(|(server_id, route)| {
            let scope = route.deployment_scope.as_deref().unwrap_or("docker");
            if scope == "docker" {
                Some(server_id)
            } else {
                None
            }
        })
        .collect::<Vec<_>>();

    servers.sort();
    Some(servers)
}

pub(crate) fn regular_routes_are_authoritative(config: &AppConfig) -> bool {
    load_server_routes(&config.server_routes_file).is_some()
}

pub(crate) fn configured_regular_servers(config: &AppConfig) -> Vec<String> {
    regular_servers_from_routes(config).unwrap_or_else(|| {
        let mut servers = config.mcpo_servers.clone();
        servers.sort();
        servers
    })
}

pub(crate) fn server_endpoint(config: &AppConfig, server_id: &str) -> (String, u16) {
    if let Some(routes) = load_server_routes(&config.server_routes_file) {
        if let Some(route) = routes.get(server_id) {
            if let Some(host) = route_host(route) {
                return (host, route.port.unwrap_or(8000));
            }
        }
    }

    (container_host(&config.container_prefix, server_id), 8000)
}

pub(crate) fn extract_oauth_state(authorization_url: &str) -> Option<String> {
    let parsed = Url::parse(authorization_url).ok()?;
    parsed
        .query_pairs()
        .find(|(key, _)| key == "state")
        .map(|(_, value)| value.into_owned())
}

pub(crate) fn cache_fresh<T>(cache: &TimedCache<T>, ttl: Duration) -> bool {
    cache.value.is_some()
        && cache
            .timestamp
            .map(|timestamp| timestamp.elapsed() < ttl)
            .unwrap_or(false)
}

pub async fn invalidate_caches(state: &SharedState, reason: &str) {
    {
        let mut cache = state.0.spec_cache.write().await;
        cache.value = None;
        cache.timestamp = None;
    }
    {
        let mut cache = state.0.servers_cache.write().await;
        cache.value = None;
        cache.timestamp = None;
    }
    log::info!("Invalidated aggregator caches (reason={reason})");
}

#[cfg(test)]
mod tests {
    use super::{
        configured_regular_servers, regular_routes_are_authoritative, regular_servers_from_routes,
        server_endpoint, AppConfig,
    };
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    static UNIQUE_ROUTE_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn test_config(server_routes_file: String) -> AppConfig {
        AppConfig {
            mcpo_servers: Vec::new(),
            container_prefix: "mcpo-core".to_string(),
            use_static_servers: true,
            cache_ttl: Duration::from_secs(5),
            servers_cache_ttl: Duration::from_secs(5),
            port: 8080,
            electron_api_url: "http://example.test/oauth-log".to_string(),
            mcp_assistant_url: "http://example.test/mcp-assistant".to_string(),
            server_routes_file,
        }
    }

    fn unique_temp_path() -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before epoch")
            .as_nanos();
        let counter = UNIQUE_ROUTE_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let pid = std::process::id();
        std::env::temp_dir().join(format!(
            "openapi-aggregator-routes-{pid}-{nonce}-{counter}.json"
        ))
    }

    #[test]
    fn server_endpoint_uses_route_file_when_present() {
        let route_file = unique_temp_path();
        fs::write(
            &route_file,
            r#"{
  "agent-vm": {
    "network_host": "mcpo-group-core",
    "port": 8100
  }
}"#,
        )
        .expect("write route file");

        let config = test_config(route_file.display().to_string());
        let endpoint = server_endpoint(&config, "agent-vm");

        fs::remove_file(&route_file).expect("cleanup route file");
        assert_eq!(endpoint, ("mcpo-group-core".to_string(), 8100));
    }

    #[test]
    fn server_endpoint_falls_back_to_container_host_when_route_missing() {
        let config = test_config("/tmp/does-not-exist-openapi-aggregator-routes.json".to_string());
        let endpoint = server_endpoint(&config, "agent_vm");

        assert_eq!(endpoint, ("mcpo-core-agent-vm".to_string(), 8000));
    }

    #[test]
    fn configured_regular_servers_uses_route_file_when_present() {
        let route_file = unique_temp_path();
        fs::write(
            &route_file,
            r#"{
  "agent-vm": {
    "network_host": "mcpo-group-core",
    "port": 8100,
    "deployment_scope": "core"
  },
  "mcp-n8n": {
    "network_host": "mcpo-mcp-n8n",
    "port": 8000,
    "deployment_scope": "docker"
  },
  "glean": {
    "network_host": "mcpo-glean",
    "port": 8000,
    "deployment_scope": "docker"
  }
}"#,
        )
        .expect("write route file");

        let config = test_config(route_file.display().to_string());
        let servers = configured_regular_servers(&config);

        fs::remove_file(&route_file).expect("cleanup route file");
        assert_eq!(servers, vec!["glean".to_string(), "mcp-n8n".to_string()]);
    }

    #[test]
    fn regular_servers_from_routes_returns_empty_when_only_core_routes_exist() {
        let route_file = unique_temp_path();
        fs::write(
            &route_file,
            r#"{
  "agent-vm": {
    "network_host": "mcpo-group-core",
    "port": 8100,
    "deployment_scope": "core"
  }
}"#,
        )
        .expect("write route file");

        let config = test_config(route_file.display().to_string());
        let servers = regular_servers_from_routes(&config);

        fs::remove_file(&route_file).expect("cleanup route file");
        assert_eq!(servers, Some(Vec::new()));
    }

    #[test]
    fn regular_routes_are_authoritative_when_route_file_exists() {
        let route_file = unique_temp_path();
        fs::write(
            &route_file,
            r#"{
  "agent-vm": {
    "network_host": "mcpo-group-core",
    "port": 8100,
    "deployment_scope": "core"
  }
}"#,
        )
        .expect("write route file");

        let config = test_config(route_file.display().to_string());
        let authoritative = regular_routes_are_authoritative(&config);

        fs::remove_file(&route_file).expect("cleanup route file");
        assert!(authoritative);
    }
}
