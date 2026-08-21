use anyhow::{Context, Result};
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::future::join_all;
use log::{error, info, warn};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::net::TcpListener;

use crate::config::{extract_oauth_state, invalidate_caches, server_endpoint, SharedState};
use crate::oauth::{fetch_oauth_current, fetch_oauth_status, merge_oauth_statuses};
use crate::openapi::{
    discover_mcpo_servers, fetch_openapi_spec, get_aggregated_spec, refresh_cached_server_specs,
    summarize_server_specs,
};
use crate::status::get_server_status;

#[derive(Debug, Default, Deserialize)]
struct InvalidateRequest {
    reason: Option<String>,
    server_id: Option<String>,
    #[serde(default)]
    server_ids: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
struct QueryParams {
    code: Option<String>,
    state: Option<String>,
    server_name: Option<String>,
    reason: Option<String>,
    server_id: Option<String>,
}

async fn handle_openapi(State(state): State<SharedState>) -> Json<Value> {
    Json(get_aggregated_spec(&state).await)
}

async fn handle_health() -> impl IntoResponse {
    (StatusCode::OK, "healthy")
}

async fn handle_servers(State(state): State<SharedState>) -> Json<Value> {
    let servers = discover_mcpo_servers(&state).await;
    Json(json!({
        "servers": servers,
        "count": servers.len(),
    }))
}

fn host_group_label(state: &SharedState) -> &'static str {
    if state.config().port == 8082 {
        "core"
    } else {
        "regular"
    }
}

async fn handle_servers_summary(State(state): State<SharedState>) -> Json<Value> {
    let servers = discover_mcpo_servers(&state).await;
    let specs = join_all(servers.iter().map(|server_id| async {
        (
            server_id.clone(),
            fetch_openapi_spec(&state, server_id.as_str()).await,
        )
    }))
    .await;
    let oauth_statuses = join_all(servers.iter().map(|server_id| async {
        (
            server_id.clone(),
            fetch_oauth_status(&state, server_id.as_str()).await,
        )
    }))
    .await;

    Json(json!({
        "servers": summarize_server_specs(host_group_label(&state), &specs),
        "oauth_status": merge_oauth_statuses(&oauth_statuses),
    }))
}

async fn handle_server_status(
    State(state): State<SharedState>,
    Path(server_id): Path<String>,
) -> Json<Value> {
    let servers = discover_mcpo_servers(&state).await;
    let discovered = servers.iter().any(|candidate| candidate == &server_id);
    let mut status = get_server_status(&state, &server_id).await;

    if let Some(object) = status.as_object_mut() {
        object.insert("discovered".to_string(), Value::Bool(discovered));
        let missing = !discovered
            && !object
                .get("openapi_available")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            && object
                .get("oauth_state")
                .map(|value| value.is_null())
                .unwrap_or(true);
        if missing
            && object
                .get("error")
                .map(|value| value.is_null())
                .unwrap_or(true)
        {
            object.insert(
                "error".to_string(),
                Value::String("not_discovered".to_string()),
            );
        }
    }

    Json(status)
}

async fn handle_cache_invalidate(
    State(state): State<SharedState>,
    Query(query): Query<QueryParams>,
    body: Bytes,
) -> Json<Value> {
    let payload = serde_json::from_slice::<InvalidateRequest>(&body).unwrap_or_default();
    let reason = payload
        .reason
        .or(query.reason)
        .unwrap_or_else(|| "manual".to_string());
    let server_id = payload.server_id.or(query.server_id);
    let mut server_ids = payload
        .server_ids
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    if let Some(single_server_id) = server_id.as_ref() {
        if !server_ids.contains(single_server_id) {
            server_ids.push(single_server_id.clone());
        }
    }
    server_ids.sort();
    server_ids.dedup();
    let reason_suffix = if server_ids.is_empty() {
        String::new()
    } else {
        format!(":{}", server_ids.join(","))
    };

    let targeted = !server_ids.is_empty();
    let targeted_refresh_applied = if targeted {
        refresh_cached_server_specs(&state, &server_ids).await
    } else {
        false
    };
    if !targeted || !targeted_refresh_applied {
        invalidate_caches(&state, &format!("{reason}{reason_suffix}")).await;
    }

    Json(json!({
        "success": true,
        "reason": reason,
        "server_id": server_id,
        "server_ids": server_ids,
        "targeted": targeted,
        "targeted_refresh_applied": targeted_refresh_applied,
        "cache_ttl_seconds": state.config().cache_ttl.as_secs(),
        "servers_cache_ttl_seconds": state.config().servers_cache_ttl.as_secs(),
    }))
}

async fn handle_oauth_status(State(state): State<SharedState>) -> Json<Value> {
    let servers = discover_mcpo_servers(&state).await;
    let statuses = join_all(servers.iter().map(|server_id| async {
        (
            server_id.clone(),
            fetch_oauth_status(&state, server_id.as_str()).await,
        )
    }))
    .await;

    let merged = merge_oauth_statuses(&statuses);
    let message = format!(
        "Merged OAuth status: {}/{} responding, {} active, {} pending, {} waiting",
        merged
            .get("servers_responding")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        merged
            .get("servers_queried")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        merged
            .get("active")
            .and_then(Value::as_array)
            .map(|items| items.len())
            .unwrap_or(0),
        merged
            .get("pending")
            .and_then(Value::as_array)
            .map(|items| items.len())
            .unwrap_or(0),
        merged
            .get("waiting_callback")
            .and_then(Value::as_array)
            .map(|items| items.len())
            .unwrap_or(0),
    );
    info!("{message}");
    state.log_oauth("INFO", &message, "Aggregator").await;
    Json(merged)
}

async fn handle_oauth_current(State(state): State<SharedState>) -> Json<Value> {
    let servers = discover_mcpo_servers(&state).await;
    let results = join_all(
        servers
            .iter()
            .map(|server_id| fetch_oauth_current(&state, server_id)),
    )
    .await;

    for current in results.into_iter().flatten() {
        let source = current
            .get("_source_container")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let message = format!("Found active OAuth handshake from {source}");
        info!("{message}");
        state.log_oauth("INFO", &message, "Aggregator").await;
        return Json(json!({ "current": current }));
    }

    Json(json!({
        "message": "No active OAuth handshake",
        "current": Value::Null,
    }))
}

async fn handle_oauth_pending(State(state): State<SharedState>) -> Json<Value> {
    let servers = discover_mcpo_servers(&state).await;
    let results = join_all(servers.iter().map(|server_id| async {
        (
            server_id.clone(),
            fetch_oauth_status(&state, server_id.as_str()).await,
        )
    }))
    .await;

    let mut pending = Vec::new();
    let mut waiting_callback = Vec::new();

    for (server_id, status) in results {
        let Some(status) = status else {
            continue;
        };

        if let Some(items) = status.get("pending").and_then(Value::as_array) {
            for item in items {
                if let Some(object) = item.as_object() {
                    let mut enriched = object.clone();
                    enriched.insert(
                        "_source_container".to_string(),
                        Value::String(server_id.clone()),
                    );
                    pending.push(Value::Object(enriched));
                }
            }
        }

        if let Some(items) = status.get("waiting_callback").and_then(Value::as_array) {
            for item in items {
                if let Some(object) = item.as_object() {
                    let mut enriched = object.clone();
                    enriched.insert(
                        "_source_container".to_string(),
                        Value::String(server_id.clone()),
                    );
                    waiting_callback.push(Value::Object(enriched));
                }
            }
        }
    }

    Json(json!({
        "pending": pending,
        "waiting_callback": waiting_callback,
    }))
}

async fn handle_oauth_refresh(
    State(state): State<SharedState>,
    Path(server_name): Path<String>,
) -> Response {
    state
        .log_oauth(
            "INFO",
            &format!("OAuth refresh requested for {server_name}"),
            "Aggregator",
        )
        .await;

    let servers = discover_mcpo_servers(&state).await;
    let target_container = servers
        .iter()
        .find(|candidate| candidate.as_str() == server_name)
        .cloned();

    let Some(target_container) = target_container else {
        state
            .log_oauth(
                "WARN",
                &format!("Server {server_name} not found in discovered servers"),
                "Aggregator",
            )
            .await;
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("Server {server_name} not found") })),
        )
            .into_response();
    };

    let (host, port) = server_endpoint(state.config(), &target_container);
    let url = format!("http://{host}:{port}/oauth/refresh/{server_name}");
    state
        .log_oauth(
            "INFO",
            &format!("Forwarding OAuth refresh to {host}:{port}"),
            "Aggregator",
        )
        .await;

    proxy_json_request(
        &state,
        state
            .0
            .client
            .post(url)
            .timeout(std::time::Duration::from_secs(60)),
        Some(format!("OAuth refresh result for {server_name}")),
    )
    .await
}

async fn handle_oauth_reload(
    State(state): State<SharedState>,
    Path(server_name): Path<String>,
) -> Response {
    let servers = discover_mcpo_servers(&state).await;
    let target_container = servers
        .iter()
        .find(|candidate| candidate.as_str() == server_name)
        .cloned();

    let Some(target_container) = target_container else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("Server {server_name} not found") })),
        )
            .into_response();
    };

    let (host, port) = server_endpoint(state.config(), &target_container);
    let url = format!("http://{host}:{port}/oauth/reload/{server_name}");
    state
        .log_oauth(
            "INFO",
            &format!("Forwarding OAuth reload to {host}:{port}"),
            "Aggregator",
        )
        .await;

    proxy_json_request(
        &state,
        state
            .0
            .client
            .post(url)
            .timeout(std::time::Duration::from_secs(60)),
        Some(format!("OAuth reload result for {server_name}")),
    )
    .await
}

async fn handle_oauth_callback(
    State(state): State<SharedState>,
    Query(query): Query<QueryParams>,
) -> Response {
    let Some(code) = query.code.clone() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "status": "error",
                "message": "Missing required parameter: code",
            })),
        )
            .into_response();
    };

    let state_param = query.state.clone();
    let mut server_name = query.server_name.clone();
    let servers = discover_mcpo_servers(&state).await;
    let mut target_container = server_name.as_ref().and_then(|requested| {
        servers
            .iter()
            .find(|server_id| server_id.as_str() == requested || server_id.contains(requested))
            .cloned()
    });

    if target_container.is_none() {
        if let Some(state_value) = state_param.as_ref() {
            info!(
                "Looking up container by state: {}...",
                state_value.chars().take(20).collect::<String>()
            );

            let statuses = join_all(servers.iter().map(|server_id| async {
                (
                    server_id.clone(),
                    fetch_oauth_status(&state, server_id.as_str()).await,
                )
            }))
            .await;

            'outer: for (server_id, status) in statuses {
                let Some(status) = status else {
                    continue;
                };

                if let Some(current) = status.get("current").and_then(Value::as_object) {
                    let current_state = current
                        .get("state_param")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                        .or_else(|| {
                            current
                                .get("authorization_url")
                                .and_then(Value::as_str)
                                .and_then(extract_oauth_state)
                        });
                    if current_state.as_deref() == Some(state_value.as_str()) {
                        server_name = current
                            .get("server_name")
                            .and_then(Value::as_str)
                            .map(ToOwned::to_owned)
                            .or_else(|| Some(server_id.clone()));
                        target_container = Some(server_id.clone());
                        info!(
                            "Found container {server_id} in current handshake (server: {:?}, state_param matched)",
                            server_name
                        );
                        break 'outer;
                    }
                }

                for item in status
                    .get("waiting_callback")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    if item
                        .get("state_param")
                        .and_then(Value::as_str)
                        .or_else(|| item.get("state").and_then(Value::as_str))
                        == Some(state_value.as_str())
                    {
                        server_name = item
                            .get("server_name")
                            .and_then(Value::as_str)
                            .map(ToOwned::to_owned)
                            .or_else(|| Some(server_id.clone()));
                        target_container = Some(server_id.clone());
                        info!(
                            "Found container {server_id} in waiting_callback (server: {:?})",
                            server_name
                        );
                        break 'outer;
                    }
                }

                for category in ["pending", "checking", "failed", "timeout"] {
                    for item in status
                        .get(category)
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                    {
                        if item.get("state_param").and_then(Value::as_str)
                            == Some(state_value.as_str())
                        {
                            server_name = item
                                .get("server_name")
                                .and_then(Value::as_str)
                                .map(ToOwned::to_owned)
                                .or_else(|| Some(server_id.clone()));
                            target_container = Some(server_id.clone());
                            info!(
                                "Found container {server_id} in {category} (server: {:?})",
                                server_name
                            );
                            break 'outer;
                        }
                    }
                }
            }
        }
    }

    let Some(target_container) = target_container else {
        let message = format!(
            "Could not find container for OAuth callback (state: {}...)",
            state_param
                .as_deref()
                .unwrap_or("none")
                .chars()
                .take(20)
                .collect::<String>()
        );
        warn!("{message}");
        state.log_oauth("WARN", &message, "Aggregator").await;
        return (
            StatusCode::NOT_FOUND,
            Json(json!({
                "status": "error",
                "message": "Could not find container for OAuth callback. State may have expired.",
            })),
        )
            .into_response();
    };

    let (host, port) = server_endpoint(state.config(), &target_container);
    let url = format!("http://{host}:{port}/oauth/callback");
    state
        .log_oauth(
            "INFO",
            &format!(
                "Forwarding OAuth callback to {host}:{port} (server: {:?})",
                server_name
            ),
            "Aggregator",
        )
        .await;

    let mut params: Vec<(&str, String)> = vec![("code", code)];
    if let Some(server_name) = server_name {
        params.push(("server_name", server_name));
    }
    if let Some(state_param) = state_param {
        params.push(("state", state_param));
    }

    proxy_json_request(
        &state,
        state
            .0
            .client
            .post(url)
            .timeout(std::time::Duration::from_secs(30))
            .query(&params),
        Some(format!("OAuth callback forwarded to {target_container}")),
    )
    .await
}

async fn proxy_json_request(
    state: &SharedState,
    request: reqwest::RequestBuilder,
    success_log: Option<String>,
) -> Response {
    match request.send().await {
        Ok(response) => {
            let status = StatusCode::from_u16(response.status().as_u16())
                .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            match response.json::<Value>().await {
                Ok(payload) => {
                    if let Some(message) = success_log {
                        let success = payload
                            .get("success")
                            .and_then(Value::as_bool)
                            .unwrap_or_else(|| {
                                payload
                                    .get("status")
                                    .and_then(Value::as_str)
                                    .map(|value| value == "success")
                                    .unwrap_or(false)
                            });
                        state
                            .log_oauth(
                                "INFO",
                                &format!("{message}: success={success}"),
                                "Aggregator",
                            )
                            .await;
                    }
                    (status, Json(payload)).into_response()
                }
                Err(error) => (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({
                        "status": "error",
                        "message": format!("Failed to parse upstream JSON response: {error}"),
                    })),
                )
                    .into_response(),
            }
        }
        Err(error) => {
            let message = error.to_string();
            error!("{message}");
            state.log_oauth("ERROR", &message, "Aggregator").await;
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({
                    "status": "error",
                    "message": message,
                })),
            )
                .into_response()
        }
    }
}

pub fn create_app(state: SharedState) -> Router {
    Router::new()
        .route("/openapi.json", get(handle_openapi))
        .route("/health", get(handle_health))
        .route("/servers", get(handle_servers))
        .route("/servers/summary", get(handle_servers_summary))
        .route("/servers/{server_id}/status", get(handle_server_status))
        .route("/internal/cache/invalidate", post(handle_cache_invalidate))
        .route("/oauth/status", get(handle_oauth_status))
        .route("/oauth/current", get(handle_oauth_current))
        .route("/oauth/pending", get(handle_oauth_pending))
        .route("/oauth/refresh/{server_name}", post(handle_oauth_refresh))
        .route("/oauth/reload/{server_name}", post(handle_oauth_reload))
        .route(
            "/oauth/callback",
            get(handle_oauth_callback).post(handle_oauth_callback),
        )
        .with_state(state)
}

pub async fn run(state: SharedState) -> Result<()> {
    state.log_oauth("INFO", &"=".repeat(60), "Aggregator").await;
    state
        .log_oauth("INFO", "RUST OpenAPI Aggregator initializing", "Aggregator")
        .await;
    state.log_oauth("INFO", &"=".repeat(60), "Aggregator").await;

    if state.config().use_static_servers {
        info!("Starting OpenAPI Aggregator with static server list (no dynamic discovery)");
        info!(
            "Static server list from env: {:?}",
            state.config().mcpo_servers
        );
    } else {
        info!("Starting OpenAPI Aggregator with dynamic server discovery");
        if !state.config().mcpo_servers.is_empty() {
            info!(
                "Fallback server list from env: {:?}",
                state.config().mcpo_servers
            );
        } else {
            info!("No MCPO_SERVERS env var - will rely on mcp-assistant for discovery");
        }
    }

    info!("Listening on port {}", state.config().port);
    let listener = TcpListener::bind(("0.0.0.0", state.config().port))
        .await
        .with_context(|| {
            format!(
                "failed to bind OpenAPI aggregator to port {}",
                state.config().port
            )
        })?;

    axum::serve(listener, create_app(state))
        .await
        .context("OpenAPI aggregator server exited unexpectedly")
}
