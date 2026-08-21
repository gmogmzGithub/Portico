use futures::future::join_all;
use log::{debug, info, warn};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::time::Instant;

use crate::config::{
    cache_fresh, configured_regular_servers, regular_routes_are_authoritative, server_endpoint,
    SharedState,
};

const OAUTH_PATHS: [&str; 4] = [
    "/oauth/status",
    "/oauth/current",
    "/oauth/pending",
    "/oauth/callback",
];

fn filter_discovered_servers(discovered: Vec<String>, configured: &[String]) -> Vec<String> {
    if configured.is_empty() {
        return discovered;
    }

    let allowed: HashSet<&str> = configured.iter().map(String::as_str).collect();
    discovered
        .into_iter()
        .filter(|server_id| allowed.contains(server_id.as_str()))
        .collect()
}

fn resolve_server_list(configured: &[String], discovered: Vec<String>) -> Vec<String> {
    if !discovered.is_empty() || configured.is_empty() {
        return discovered;
    }

    configured.to_vec()
}

pub async fn discover_mcpo_servers(state: &SharedState) -> Vec<String> {
    if state.config().use_static_servers {
        debug!(
            "Using static server list: {:?}",
            state.config().mcpo_servers
        );
        return state.config().mcpo_servers.clone();
    }

    {
        let cache = state.0.servers_cache.read().await;
        if cache_fresh(&cache, state.config().servers_cache_ttl) {
            if let Some(value) = cache.value.as_ref() {
                return value.clone();
            }
        }
    }

    let configured_servers = configured_regular_servers(state.config());
    if regular_routes_are_authoritative(state.config()) {
        info!(
            "Using route-configured regular server list: {:?}",
            configured_servers
        );

        let mut cache = state.0.servers_cache.write().await;
        cache.value = Some(configured_servers.clone());
        cache.timestamp = Some(Instant::now());
        return configured_servers;
    }

    if !configured_servers.is_empty() {
        info!(
            "Configured fallback server list for dynamic discovery: {:?}",
            configured_servers
        );
    }

    info!("Refreshing server list from mcp-assistant...");
    let request_body = json!({
        "filter": "all",
        "include_disabled": false,
    });

    let discovered = match state
        .0
        .client
        .post(&state.config().mcp_assistant_url)
        .timeout(std::time::Duration::from_secs(5))
        .json(&request_body)
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => match response.json::<Value>().await {
            Ok(payload) => payload
                .get("servers")
                .and_then(Value::as_array)
                .map(|servers| {
                    servers
                        .iter()
                        .filter(|server| {
                            !server
                                .get("is_core")
                                .and_then(Value::as_bool)
                                .unwrap_or(false)
                        })
                        .filter(|server| {
                            server
                                .get("deployment_type")
                                .and_then(Value::as_str)
                                .unwrap_or("docker")
                                == "docker"
                        })
                        .filter_map(|server| server.get("id").and_then(Value::as_str))
                        .map(ToOwned::to_owned)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default(),
            Err(error) => {
                warn!("Failed to parse mcp-assistant discovery response: {error}");
                Vec::new()
            }
        },
        Ok(response) => {
            warn!(
                "mcp-assistant discovery returned HTTP {}, using fallback",
                response.status()
            );
            Vec::new()
        }
        Err(error) => {
            warn!("Failed to query mcp-assistant: {error}, using fallback");
            Vec::new()
        }
    };

    let filtered = filter_discovered_servers(discovered, &configured_servers);
    let servers = resolve_server_list(&configured_servers, filtered);
    if !servers.is_empty() && servers == configured_servers {
        info!("Using configured fallback server list: {:?}", servers);
    } else {
        info!("Discovered {} MCPO servers: {:?}", servers.len(), servers);
    }

    let mut cache = state.0.servers_cache.write().await;
    cache.value = Some(servers.clone());
    cache.timestamp = Some(Instant::now());

    servers
}

pub async fn fetch_openapi_spec(state: &SharedState, server_id: &str) -> Option<Value> {
    let (host, port) = server_endpoint(state.config(), server_id);
    let url = format!("http://{host}:{port}/{server_id}/openapi.json");

    match state
        .0
        .client
        .get(&url)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => match response.json::<Value>().await {
            Ok(spec) => {
                debug!(
                    "Fetched spec from {server_id}: {} paths",
                    spec.get("paths")
                        .and_then(Value::as_object)
                        .map(|paths| paths.len())
                        .unwrap_or(0)
                );
                Some(spec)
            }
            Err(error) => {
                warn!("Failed to parse OpenAPI spec from {server_id}: {error}");
                None
            }
        },
        Ok(response) => {
            debug!(
                "OpenAPI spec not ready for {server_id}: HTTP {}",
                response.status()
            );
            None
        }
        Err(error) => {
            debug!("OpenAPI spec not ready for {server_id}: {error}");
            None
        }
    }
}

fn rewrite_schema_refs(value: &mut Value, server_id: &str) {
    match value {
        Value::Object(object) => {
            if let Some(Value::String(reference)) = object.get_mut("$ref") {
                if let Some(schema_name) = reference.strip_prefix("#/components/schemas/") {
                    *reference = format!("#/components/schemas/{}_{}", server_id, schema_name);
                }
            }

            for child in object.values_mut() {
                rewrite_schema_refs(child, server_id);
            }
        }
        Value::Array(items) => {
            for item in items {
                rewrite_schema_refs(item, server_id);
            }
        }
        _ => {}
    }
}

fn prefixed_operation(path_item: &Map<String, Value>, server_id: &str) -> Map<String, Value> {
    let normalized_server_id = server_id.replace('-', "_");
    let mut updated_path_item = Map::new();

    for (method, operation) in path_item {
        if let Value::Object(operation_object) = operation {
            let mut updated_operation = Value::Object(operation_object.clone());
            rewrite_schema_refs(&mut updated_operation, server_id);

            if let Some(updated_object) = updated_operation.as_object_mut() {
                if let Some(Value::String(operation_id)) = updated_object.get_mut("operationId") {
                    if !operation_id.starts_with(&format!("{normalized_server_id}_")) {
                        *operation_id = format!("{normalized_server_id}_{}", operation_id.as_str());
                    }
                }
            }

            updated_path_item.insert(method.clone(), updated_operation);
        } else {
            updated_path_item.insert(method.clone(), operation.clone());
        }
    }

    updated_path_item
}

pub fn merge_openapi_specs(specs: &[(String, Option<Value>)]) -> Value {
    let mut merged_paths = Map::new();
    let mut merged_schemas = Map::new();
    let mut available_servers = Vec::new();

    for (server_id, spec) in specs {
        let Some(spec) = spec.as_ref() else {
            continue;
        };

        available_servers.push(server_id.clone());

        let Some(paths) = spec.get("paths").and_then(Value::as_object) else {
            continue;
        };

        for (path, path_item) in paths {
            let prefixed_path = format!("/{server_id}{}", path);
            if let Value::Object(path_object) = path_item {
                merged_paths.insert(
                    prefixed_path,
                    Value::Object(prefixed_operation(path_object, server_id)),
                );
            } else {
                merged_paths.insert(prefixed_path, path_item.clone());
            }
        }

        if let Some(schemas) = spec
            .get("components")
            .and_then(|components| components.get("schemas"))
            .and_then(Value::as_object)
        {
            for (schema_name, schema_def) in schemas {
                let mut prefixed_schema = schema_def.clone();
                rewrite_schema_refs(&mut prefixed_schema, server_id);
                merged_schemas.insert(format!("{server_id}_{schema_name}"), prefixed_schema);
            }
        }
    }

    let description = if available_servers.is_empty() {
        "Aggregated OpenAPI spec from multiple MCPO containers".to_string()
    } else {
        format!(
            "Aggregated API from {} MCP servers: [{}]",
            available_servers.len(),
            available_servers.join("] [")
        )
    };

    info!(
        "Merged {} specs with {} total paths",
        available_servers.len(),
        merged_paths.len()
    );

    json!({
        "openapi": "3.1.0",
        "info": {
            "title": "MCPO Aggregated API",
            "description": description,
            "version": "1.0.0",
        },
        "paths": Value::Object(merged_paths),
        "components": {
            "schemas": Value::Object(merged_schemas),
        },
    })
}

pub(crate) fn replace_server_specs_in_merged(
    merged: &mut Value,
    specs: &[(String, Option<Value>)],
) {
    let server_ids = specs
        .iter()
        .map(|(server_id, _)| server_id.as_str())
        .collect::<Vec<_>>();

    if let Some(paths) = merged.get_mut("paths").and_then(Value::as_object_mut) {
        paths.retain(|path, _| {
            !server_ids.iter().any(|server_id| {
                path == &format!("/{server_id}") || path.starts_with(&format!("/{server_id}/"))
            })
        });
    }
    if let Some(schemas) = merged
        .get_mut("components")
        .and_then(|components| components.get_mut("schemas"))
        .and_then(Value::as_object_mut)
    {
        schemas.retain(|schema, _| {
            !server_ids
                .iter()
                .any(|server_id| schema.starts_with(&format!("{server_id}_")))
        });
    }

    let replacement = merge_openapi_specs(specs);
    if let (Some(target), Some(source)) = (
        merged.get_mut("paths").and_then(Value::as_object_mut),
        replacement.get("paths").and_then(Value::as_object),
    ) {
        target.extend(source.clone());
    }
    if let (Some(target), Some(source)) = (
        merged
            .get_mut("components")
            .and_then(|components| components.get_mut("schemas"))
            .and_then(Value::as_object_mut),
        replacement
            .get("components")
            .and_then(|components| components.get("schemas"))
            .and_then(Value::as_object),
    ) {
        target.extend(source.clone());
    }
}

pub async fn refresh_cached_server_specs(state: &SharedState, server_ids: &[String]) -> bool {
    if server_ids.is_empty() {
        return false;
    }
    {
        let cache = state.0.spec_cache.read().await;
        if cache.value.is_none() {
            return false;
        }
    }

    let specs = join_all(server_ids.iter().map(|server_id| async {
        (
            server_id.clone(),
            fetch_openapi_spec(state, server_id.as_str()).await,
        )
    }))
    .await;

    let mut cache = state.0.spec_cache.write().await;
    let Some(merged) = cache.value.as_mut() else {
        return false;
    };
    replace_server_specs_in_merged(merged, &specs);
    cache.timestamp = Some(Instant::now());
    true
}

pub(crate) fn spec_path_count(spec: &Value) -> usize {
    spec.get("paths")
        .and_then(Value::as_object)
        .map(|paths| paths.len())
        .unwrap_or(0)
}

pub(crate) fn spec_tool_count(spec: &Value) -> usize {
    spec.get("paths")
        .and_then(Value::as_object)
        .map(|paths| {
            paths
                .keys()
                .filter(|path| !OAUTH_PATHS.contains(&path.as_str()))
                .count()
        })
        .unwrap_or(0)
}

pub(crate) fn summarize_server_specs(host_group: &str, specs: &[(String, Option<Value>)]) -> Value {
    Value::Array(
        specs
            .iter()
            .map(|(server_id, spec)| {
                let tools_count = spec.as_ref().map(spec_tool_count).unwrap_or(0);
                json!({
                    "id": server_id,
                    "host_group": host_group,
                    "reachable": spec.is_some(),
                    "has_tools": tools_count > 0,
                    "tools_count": tools_count,
                })
            })
            .collect(),
    )
}

pub async fn get_aggregated_spec(state: &SharedState) -> Value {
    {
        let cache = state.0.spec_cache.read().await;
        if cache_fresh(&cache, state.config().cache_ttl) {
            if let Some(spec) = cache.value.as_ref() {
                if spec_path_count(spec) > 0 {
                    return spec.clone();
                }
            }
        }
    }

    let servers = discover_mcpo_servers(state).await;
    info!(
        "Refreshing aggregated spec from {} servers...",
        servers.len()
    );

    let specs = join_all(servers.iter().map(|server_id| async {
        (
            server_id.clone(),
            fetch_openapi_spec(state, server_id.as_str()).await,
        )
    }))
    .await;

    let successful_specs = specs.iter().filter(|(_, spec)| spec.is_some()).count();
    let merged = merge_openapi_specs(&specs);
    let merged_path_count = spec_path_count(&merged);

    if (successful_specs == 0 || merged_path_count == 0) && !servers.is_empty() {
        info!(
            "Server specs were not ready yet for {} discovered servers (successful_specs={}, merged_paths={}); skipping cache update",
            servers.len(),
            successful_specs,
            merged_path_count
        );
        return merged;
    }

    let mut cache = state.0.spec_cache.write().await;
    cache.value = Some(merged.clone());
    cache.timestamp = Some(Instant::now());
    merged
}

#[cfg(test)]
mod tests {
    use super::{
        discover_mcpo_servers, filter_discovered_servers, replace_server_specs_in_merged,
        resolve_server_list, summarize_server_specs,
    };
    use crate::config::{regular_servers_from_routes, AppConfig, AppState};
    use serde_json::json;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    static UNIQUE_ROUTE_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_temp_path() -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before epoch")
            .as_nanos();
        let counter = UNIQUE_ROUTE_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let pid = std::process::id();
        std::env::temp_dir().join(format!(
            "openapi-aggregator-discovery-routes-{pid}-{nonce}-{counter}.json"
        ))
    }

    fn test_config(server_routes_file: String) -> AppConfig {
        AppConfig {
            mcpo_servers: vec!["stale-discovery".to_string()],
            container_prefix: "mcpo".to_string(),
            use_static_servers: false,
            cache_ttl: Duration::from_secs(5),
            servers_cache_ttl: Duration::from_secs(5),
            port: 8080,
            electron_api_url: "http://example.test/oauth-log".to_string(),
            mcp_assistant_url: "http://example.test/mcp-assistant".to_string(),
            server_routes_file,
        }
    }

    #[test]
    fn filters_discovered_servers_to_configured_set() {
        let filtered = filter_discovered_servers(
            vec![
                "data-plat-mcp".to_string(),
                "gitlab-mcp".to_string(),
                "slack".to_string(),
                "glean".to_string(),
            ],
            &[
                "data-plat-mcp".to_string(),
                "glean".to_string(),
                "google_workspace".to_string(),
            ],
        );

        assert_eq!(
            filtered,
            vec!["data-plat-mcp".to_string(), "glean".to_string()]
        );
    }

    #[test]
    fn keeps_dynamic_discovery_when_no_configured_servers_are_provided() {
        let filtered = filter_discovered_servers(vec!["chrome-devtools".to_string()], &[]);

        assert_eq!(filtered, vec!["chrome-devtools".to_string()]);
    }

    #[test]
    fn prefers_live_discovery_when_available() {
        let resolved = resolve_server_list(
            &[
                "gitlab-mcp".to_string(),
                "slack".to_string(),
                "sourcegraph".to_string(),
            ],
            vec!["gitlab-mcp".to_string(), "slack".to_string()],
        );

        assert_eq!(
            resolved,
            vec!["gitlab-mcp".to_string(), "slack".to_string()]
        );
    }

    #[test]
    fn falls_back_to_configured_servers_when_discovery_is_empty() {
        let resolved = resolve_server_list(
            &[
                "gitlab-mcp".to_string(),
                "slack".to_string(),
                "sourcegraph".to_string(),
            ],
            Vec::new(),
        );

        assert_eq!(
            resolved,
            vec![
                "gitlab-mcp".to_string(),
                "slack".to_string(),
                "sourcegraph".to_string()
            ]
        );
    }

    #[test]
    fn route_file_with_only_core_servers_is_still_authoritative() {
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

    #[tokio::test]
    async fn discover_mcpo_servers_prefers_route_file_over_stale_env_fallbacks() {
        let route_file = unique_temp_path();
        fs::write(
            &route_file,
            r#"{
  "glean": {
    "network_host": "mcpo-glean",
    "port": 8000
  }
}"#,
        )
        .expect("write route file");

        let state = AppState::new(test_config(route_file.display().to_string()))
            .expect("build shared state");

        let servers = discover_mcpo_servers(&state).await;

        let _ = fs::remove_file(&route_file);
        assert_eq!(servers, vec!["glean".to_string()]);
    }

    #[tokio::test]
    async fn discover_mcpo_servers_keeps_empty_regular_route_set_authoritative() {
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

        let state = AppState::new(test_config(route_file.display().to_string()))
            .expect("build shared state");

        let servers = discover_mcpo_servers(&state).await;

        let _ = fs::remove_file(&route_file);
        assert!(servers.is_empty());
    }

    #[test]
    fn summarize_server_specs_marks_reachability_and_filters_oauth_paths() {
        let summary = summarize_server_specs(
            "regular",
            &[
                (
                    "google_workspace".to_string(),
                    Some(json!({
                        "paths": {
                            "/oauth/status": { "get": {} },
                            "/oauth/current": { "get": {} },
                            "/gmail_list_messages": { "post": {} },
                        }
                    })),
                ),
                ("slack".to_string(), None),
            ],
        );

        assert_eq!(
            summary,
            json!([
                {
                    "id": "google_workspace",
                    "host_group": "regular",
                    "reachable": true,
                    "has_tools": true,
                    "tools_count": 1,
                },
                {
                    "id": "slack",
                    "host_group": "regular",
                    "reachable": false,
                    "has_tools": false,
                    "tools_count": 0,
                }
            ])
        );
    }

    #[test]
    fn targeted_spec_replacement_preserves_unrelated_cached_servers() {
        let mut merged = json!({
            "openapi": "3.1.0",
            "paths": {
                "/slack/old_tool": { "post": {} },
                "/glean/search": { "post": {} }
            },
            "components": {
                "schemas": {
                    "slack_Old": { "type": "object" },
                    "glean_Result": { "type": "object" }
                }
            }
        });

        replace_server_specs_in_merged(
            &mut merged,
            &[(
                "slack".to_string(),
                Some(json!({
                    "paths": { "/new_tool": { "post": {} } },
                    "components": {
                        "schemas": { "New": { "type": "object" } }
                    }
                })),
            )],
        );

        assert!(merged["paths"].get("/slack/old_tool").is_none());
        assert!(merged["paths"].get("/slack/new_tool").is_some());
        assert!(merged["paths"].get("/glean/search").is_some());
        assert!(merged["components"]["schemas"].get("slack_Old").is_none());
        assert!(merged["components"]["schemas"].get("slack_New").is_some());
        assert!(merged["components"]["schemas"]
            .get("glean_Result")
            .is_some());
    }
}
