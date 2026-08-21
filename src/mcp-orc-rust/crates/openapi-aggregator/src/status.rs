use axum::http::StatusCode;
use serde_json::{json, Map, Value};

use crate::config::{server_endpoint, SharedState};
use crate::oauth::fetch_oauth_status;
use crate::openapi::fetch_openapi_spec;

const READINESS_PHASE_TOOL_READY: &str = "tool_ready";
const READINESS_PHASE_STARTING: &str = "starting";
const READINESS_PHASE_CHECKING_TOKENS: &str = "checking_tokens";
const READINESS_PHASE_NEEDS_OAUTH: &str = "needs_oauth";
const READINESS_PHASE_WAITING_CALLBACK: &str = "waiting_callback";
const READINESS_PHASE_FAILED: &str = "failed";
const PROVIDER_READINESS_NOT_REQUIRED: &str = "not_required";
const PROVIDER_READINESS_STARTING: &str = "starting";
const PROVIDER_READINESS_READY: &str = "ready";
const PROVIDER_READINESS_UNSUPPORTED: &str = "unsupported";
const PROVIDER_READINESS_PROBE_FAILED: &str = "probe_failed";
const OAUTH_PATHS: [&str; 4] = [
    "/oauth/status",
    "/oauth/current",
    "/oauth/pending",
    "/oauth/callback",
];

#[derive(Debug)]
pub struct ProbeResult {
    pub ok: bool,
    pub status: Option<u16>,
    pub tool_path: Option<String>,
    pub error: Option<String>,
}

fn is_oauth_path(path: &str) -> bool {
    OAUTH_PATHS.contains(&path)
}

fn proxy_probe_base_url(container_prefix: &str) -> &'static str {
    if container_prefix == "mcpo-core" {
        "http://mcpo-core:8081"
    } else {
        "http://mcpo"
    }
}

fn proxy_probe_openapi_path(server_id: &str) -> String {
    format!("/{server_id}/openapi.json")
}

fn find_server_oauth_handshake(
    server_id: &str,
    oauth_status: Option<&Value>,
) -> (Option<Map<String, Value>>, Option<String>) {
    let Some(oauth_status) = oauth_status else {
        return (None, None);
    };

    if let Some(current) = oauth_status.get("current").and_then(Value::as_object) {
        if current
            .get("server_name")
            .and_then(Value::as_str)
            .is_some_and(|name| name == server_id)
        {
            let state = current
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or("active")
                .to_ascii_lowercase();
            return (Some(current.clone()), Some(state));
        }
    }

    for bucket in [
        "active",
        "waiting_callback",
        "checking",
        "pending",
        "completed",
        "failed",
        "timeout",
    ] {
        if let Some(items) = oauth_status.get(bucket).and_then(Value::as_array) {
            for item in items {
                if let Some(object) = item.as_object() {
                    if object
                        .get("server_name")
                        .and_then(Value::as_str)
                        .is_some_and(|name| name == server_id)
                    {
                        return (Some(object.clone()), Some(bucket.to_string()));
                    }
                }
            }
        }
    }

    (None, None)
}

fn should_skip_openapi_probe_for_oauth_state(
    server_id: &str,
    oauth_status: Option<&Value>,
) -> bool {
    let (_handshake, oauth_bucket) = find_server_oauth_handshake(server_id, oauth_status);
    matches!(
        oauth_bucket.as_deref(),
        Some("active" | "pending" | "checking" | "waiting_callback" | "failed" | "timeout")
    )
}

pub fn classify_server_status(
    server_id: &str,
    spec: Option<&Value>,
    oauth_status: Option<&Value>,
    probe: &ProbeResult,
) -> Value {
    classify_server_status_with_provider(server_id, spec, oauth_status, probe, None, None)
}

fn classify_server_status_with_provider(
    server_id: &str,
    spec: Option<&Value>,
    oauth_status: Option<&Value>,
    probe: &ProbeResult,
    provider_readiness: Option<&str>,
    provider_warmup: Option<&Value>,
) -> Value {
    let paths = spec
        .and_then(|value| value.get("paths"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let tool_paths = paths
        .keys()
        .filter(|path| !is_oauth_path(path.as_str()))
        .count();
    let total_paths = paths.len();
    let openapi_available = spec.is_some();

    let (handshake, oauth_bucket) = find_server_oauth_handshake(server_id, oauth_status);
    let oauth_state = handshake
        .as_ref()
        .and_then(|item| item.get("state").and_then(Value::as_str))
        .map(|value| value.to_ascii_lowercase())
        .or_else(|| oauth_bucket.clone());
    let authorization_url_available = handshake
        .as_ref()
        .and_then(|item| item.get("authorization_url"))
        .and_then(Value::as_str)
        .is_some();
    let oauth_error = handshake
        .as_ref()
        .and_then(|item| item.get("error_message"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();

    let mut readiness_phase = READINESS_PHASE_STARTING.to_string();
    let mut status = "starting".to_string();
    let mut healthy = false;

    if oauth_bucket.as_deref() == Some("checking") {
        readiness_phase = READINESS_PHASE_CHECKING_TOKENS.to_string();
        status = "checking".to_string();
    } else if oauth_bucket.as_deref() == Some("waiting_callback") {
        readiness_phase = READINESS_PHASE_WAITING_CALLBACK.to_string();
        status = "waiting_callback".to_string();
    } else if matches!(oauth_bucket.as_deref(), Some("failed" | "timeout")) {
        readiness_phase = READINESS_PHASE_FAILED.to_string();
        status = "failed".to_string();
    } else if matches!(oauth_bucket.as_deref(), Some("active" | "pending"))
        && (authorization_url_available || matches!(oauth_state.as_deref(), Some("active")))
    {
        readiness_phase = READINESS_PHASE_NEEDS_OAUTH.to_string();
        status = "needs_oauth".to_string();
    } else if provider_readiness.is_some_and(|value| {
        !matches!(
            value,
            PROVIDER_READINESS_NOT_REQUIRED | PROVIDER_READINESS_READY
        )
    }) {
        readiness_phase = READINESS_PHASE_STARTING.to_string();
        status = "starting".to_string();
    } else if tool_paths > 0 && probe.ok {
        readiness_phase = READINESS_PHASE_TOOL_READY.to_string();
        status = "healthy".to_string();
        healthy = true;
    } else if tool_paths > 0 && !probe.ok {
        readiness_phase = READINESS_PHASE_STARTING.to_string();
        status = "starting".to_string();
    } else if oauth_bucket.as_deref() == Some("completed") {
        readiness_phase = READINESS_PHASE_STARTING.to_string();
        status = "starting".to_string();
    } else if !openapi_available {
        status = "unavailable".to_string();
    }

    json!({
        "server_id": server_id,
        "status": status,
        "readiness_phase": readiness_phase,
        "healthy": healthy,
        "tools_count": tool_paths,
        "total_paths": total_paths,
        "openapi_available": openapi_available,
        "oauth_state": oauth_state,
        "authorization_url_available": authorization_url_available,
        "error": if oauth_error.is_empty() { probe.error.clone() } else { Some(oauth_error) },
        "proxy_probe_ok": probe.ok,
        "proxy_probe_status": probe.status,
        "proxy_probe_tool_path": probe.tool_path,
        "proxy_probe_error": probe.error,
        "provider_readiness": provider_readiness,
        "provider_warmup": provider_warmup,
    })
}

// Only values mcp-orc actually asserted may gate readiness. A missing or
// unrecognized field means the inner mcp-orc made no usable assertion
// (older image, newer vocabulary) — never a reason to degrade the server.
fn normalize_provider_readiness(value: Option<&str>) -> Option<&'static str> {
    match value {
        Some(PROVIDER_READINESS_NOT_REQUIRED) => Some(PROVIDER_READINESS_NOT_REQUIRED),
        Some(PROVIDER_READINESS_STARTING) => Some(PROVIDER_READINESS_STARTING),
        Some(PROVIDER_READINESS_READY) => Some(PROVIDER_READINESS_READY),
        Some(PROVIDER_READINESS_UNSUPPORTED) => Some(PROVIDER_READINESS_UNSUPPORTED),
        Some(PROVIDER_READINESS_PROBE_FAILED) => Some(PROVIDER_READINESS_PROBE_FAILED),
        _ => None,
    }
}

async fn fetch_provider_readiness(
    state: &SharedState,
    server_id: &str,
) -> (Option<&'static str>, Option<Value>) {
    let (host, port) = server_endpoint(state.config(), server_id);
    let status_url = format!("http://{host}:{port}/servers/{server_id}/status");
    match state
        .0
        .client
        .get(status_url)
        .timeout(std::time::Duration::from_millis(750))
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => match response.json::<Value>().await {
            Ok(payload) => {
                let readiness = normalize_provider_readiness(
                    payload.get("provider_readiness").and_then(Value::as_str),
                );
                let warmup = payload
                    .get("provider_warmup")
                    .filter(|value| value.is_object())
                    .cloned();
                (readiness, warmup)
            }
            Err(_) => (None, None),
        },
        // An aggregator-side fetch problem (missing route, timeout, 5xx) is
        // not a provider assertion. Gating on it flipped every healthy
        // server to "starting" under image skew or one slow status call.
        Ok(_) | Err(_) => (None, None),
    }
}

async fn probe_server_openapi_via_proxy(state: &SharedState, server_id: &str) -> ProbeResult {
    let proxied_path = proxy_probe_openapi_path(server_id);
    let probe_url = format!(
        "{}{}",
        proxy_probe_base_url(&state.config().container_prefix),
        proxied_path
    );

    match state
        .0
        .client
        .get(&probe_url)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
    {
        Ok(response) if response.status() == StatusCode::NOT_FOUND => ProbeResult {
            ok: false,
            status: Some(response.status().as_u16()),
            tool_path: Some(proxied_path.clone()),
            error: Some("route_not_found".to_string()),
        },
        Ok(response) if response.status().is_server_error() => ProbeResult {
            ok: false,
            status: Some(response.status().as_u16()),
            tool_path: Some(proxied_path.clone()),
            error: Some(format!("http_{}", response.status().as_u16())),
        },
        Ok(response) => ProbeResult {
            ok: true,
            status: Some(response.status().as_u16()),
            tool_path: Some(proxied_path.clone()),
            error: None,
        },
        Err(error) => ProbeResult {
            ok: false,
            status: None,
            tool_path: Some(proxied_path),
            error: Some(error.to_string()),
        },
    }
}

pub(crate) async fn get_server_status(state: &SharedState, server_id: &str) -> Value {
    let (oauth_status, (provider_readiness, provider_warmup)) = tokio::join!(
        fetch_oauth_status(state, server_id),
        fetch_provider_readiness(state, server_id),
    );
    let skip_openapi_probe =
        should_skip_openapi_probe_for_oauth_state(server_id, oauth_status.as_ref());
    let spec = if skip_openapi_probe {
        None
    } else {
        fetch_openapi_spec(state, server_id).await
    };

    let probe = if skip_openapi_probe {
        ProbeResult {
            ok: false,
            status: None,
            tool_path: None,
            error: None,
        }
    } else if spec.is_some() {
        probe_server_openapi_via_proxy(state, server_id).await
    } else {
        ProbeResult {
            ok: false,
            status: None,
            tool_path: None,
            error: None,
        }
    };

    classify_server_status_with_provider(
        server_id,
        spec.as_ref(),
        oauth_status.as_ref(),
        &probe,
        provider_readiness,
        provider_warmup.as_ref(),
    )
}

#[cfg(test)]
mod tests {
    use super::{
        classify_server_status_with_provider, fetch_provider_readiness, get_server_status,
        proxy_probe_base_url, proxy_probe_openapi_path, should_skip_openapi_probe_for_oauth_state,
        ProbeResult, PROVIDER_READINESS_PROBE_FAILED, PROVIDER_READINESS_STARTING,
        PROVIDER_READINESS_UNSUPPORTED,
    };
    use crate::config::{AppConfig, AppState};
    use axum::{http::StatusCode, routing::get, Json, Router};
    use serde_json::json;
    use std::fs;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use tokio::net::TcpListener;

    #[test]
    fn explicit_provider_nonready_states_override_tool_and_proxy_liveness() {
        let spec = json!({"paths": {"/slack/slack_channels_me": {"post": {}}}});
        for provider_readiness in [
            PROVIDER_READINESS_STARTING,
            PROVIDER_READINESS_UNSUPPORTED,
            PROVIDER_READINESS_PROBE_FAILED,
        ] {
            let status = classify_server_status_with_provider(
                "slack",
                Some(&spec),
                None,
                &ProbeResult {
                    ok: true,
                    status: Some(200),
                    tool_path: Some("/slack/openapi.json".to_string()),
                    error: None,
                },
                Some(provider_readiness),
                None,
            );
            assert_eq!(status["status"], "starting");
            assert_eq!(status["readiness_phase"], "starting");
            assert_eq!(status["healthy"], false);
            assert_eq!(status["provider_readiness"], provider_readiness);
        }
    }

    #[test]
    fn missing_provider_assertion_leaves_tool_ready_server_healthy() {
        let spec = json!({"paths": {"/glean/glean_search": {"post": {}}}});
        let status = classify_server_status_with_provider(
            "glean",
            Some(&spec),
            None,
            &ProbeResult {
                ok: true,
                status: Some(200),
                tool_path: Some("/glean/openapi.json".to_string()),
                error: None,
            },
            None,
            None,
        );
        assert_eq!(
            status["status"], "healthy",
            "no provider assertion must never degrade a tool-ready server \
             (image skew / transient status-call failure regression)"
        );
        assert_eq!(status["readiness_phase"], "tool_ready");
        assert_eq!(status["healthy"], true);
        assert!(status["provider_readiness"].is_null());
    }

    #[tokio::test]
    async fn fetch_returns_none_when_inner_status_omits_provider_readiness() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new()
                    .route("/servers/glean/status", get(|| async { Json(json!({})) })),
            )
            .await
            .unwrap();
        });

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let route_file = std::env::temp_dir().join(format!(
            "openapi-aggregator-missing-readiness-{}-{nonce}.json",
            std::process::id()
        ));
        fs::write(
            &route_file,
            format!(
                r#"{{"glean":{{"network_host":"127.0.0.1","port":{port},"deployment_scope":"docker"}}}}"#
            ),
        )
        .unwrap();
        let state = AppState::new(AppConfig {
            mcpo_servers: vec!["glean".to_string()],
            container_prefix: "mcpo".to_string(),
            use_static_servers: true,
            cache_ttl: Duration::from_secs(5),
            servers_cache_ttl: Duration::from_secs(5),
            port: 8080,
            electron_api_url: "http://example.test/oauth-log".to_string(),
            mcp_assistant_url: "http://example.test/mcp-assistant".to_string(),
            server_routes_file: route_file.display().to_string(),
        })
        .unwrap();

        assert_eq!(fetch_provider_readiness(&state, "glean").await, (None, None));
        // Unreachable inner status endpoint must also stay a non-assertion.
        assert_eq!(fetch_provider_readiness(&state, "missing").await, (None, None));
        fs::remove_file(route_file).unwrap();
    }

    #[tokio::test]
    async fn outer_status_uses_inner_provider_readiness_over_http() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new()
                    .route(
                        "/servers/slack/status",
                        get(|| async {
                            Json(json!({
                                "provider_readiness": PROVIDER_READINESS_STARTING,
                                "provider_warmup": {
                                    "phase": "users",
                                    "elapsed_seconds": 185,
                                    "progress_percent": 40
                                }
                            }))
                        }),
                    )
                    .route("/oauth/status", get(|| async { Json(json!({})) }))
                    .route(
                        "/slack/openapi.json",
                        get(|| async { (StatusCode::SERVICE_UNAVAILABLE, "warming") }),
                    ),
            )
            .await
            .unwrap();
        });

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let route_file = std::env::temp_dir().join(format!(
            "openapi-aggregator-provider-readiness-{}-{nonce}.json",
            std::process::id()
        ));
        fs::write(
            &route_file,
            format!(
                r#"{{"slack":{{"network_host":"127.0.0.1","port":{port},"deployment_scope":"docker"}}}}"#
            ),
        )
        .unwrap();
        let state = AppState::new(AppConfig {
            mcpo_servers: vec!["slack".to_string()],
            container_prefix: "mcpo".to_string(),
            use_static_servers: true,
            cache_ttl: Duration::from_secs(5),
            servers_cache_ttl: Duration::from_secs(5),
            port: 8080,
            electron_api_url: "http://example.test/oauth-log".to_string(),
            mcp_assistant_url: "http://example.test/mcp-assistant".to_string(),
            server_routes_file: route_file.display().to_string(),
        })
        .unwrap();

        let (readiness, warmup) = fetch_provider_readiness(&state, "slack").await;
        assert_eq!(readiness, Some(PROVIDER_READINESS_STARTING));
        assert_eq!(
            warmup.as_ref().and_then(|value| value.get("elapsed_seconds")),
            Some(&json!(185)),
            "structured warmup payload must pass through the aggregator"
        );
        let status = get_server_status(&state, "slack").await;
        assert_eq!(status["healthy"], false);
        assert_eq!(status["status"], "starting");
        assert_eq!(status["readiness_phase"], "starting");
        assert_eq!(status["provider_readiness"], "starting");
        assert_eq!(status["provider_warmup"]["progress_percent"], 40);
        fs::remove_file(route_file).unwrap();
    }

    #[test]
    fn proxy_probe_path_targets_server_openapi_front_door() {
        assert_eq!(proxy_probe_openapi_path("glean"), "/glean/openapi.json");
        assert_eq!(proxy_probe_openapi_path("skills"), "/skills/openapi.json");
    }

    #[test]
    fn proxy_probe_base_url_scopes_regular_and_core_front_doors() {
        assert_eq!(proxy_probe_base_url("mcpo"), "http://mcpo");
        assert_eq!(proxy_probe_base_url("mcpo-core"), "http://mcpo-core:8081");
    }

    #[test]
    fn skips_openapi_probe_while_oauth_is_pending() {
        let oauth_status = json!({
            "current": {
                "server_name": "portico-taxonomy",
                "state": "active",
                "authorization_url": "https://example.test/auth"
            }
        });

        assert!(should_skip_openapi_probe_for_oauth_state(
            "portico-taxonomy",
            Some(&oauth_status)
        ));
    }

    #[test]
    fn does_not_skip_openapi_probe_after_oauth_completes() {
        let oauth_status = json!({
            "completed": [
                {
                    "server_name": "portico-taxonomy",
                    "state": "completed"
                }
            ]
        });

        assert!(!should_skip_openapi_probe_for_oauth_state(
            "portico-taxonomy",
            Some(&oauth_status)
        ));
    }
}
