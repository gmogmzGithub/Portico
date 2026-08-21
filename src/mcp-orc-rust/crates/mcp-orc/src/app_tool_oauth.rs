use std::time::{Duration, Instant};

use log::{error, info, warn};
use reqwest::StatusCode;
const MCP_RESTART_ENDPOINT_PREFIX: &str =
    "http://host.docker.internal:9876/api/restart-mcp-server/";
const RESTART_HANDOFF_RETRY_DELAYS_SECONDS: [u64; 5] = [2, 4, 8, 16, 30];
const RESTART_HANDOFF_MAX_ELAPSED: Duration = Duration::from_secs(120);

pub(crate) fn is_probable_oauth_error_text(text: &str) -> bool {
    let normalized = text.to_ascii_lowercase();
    let compact = normalized
        .chars()
        .filter(|ch| !matches!(ch, '_' | '-' | ' '))
        .collect::<String>();
    normalized.contains("invalid_token")
        || normalized.contains("invalid token")
        || normalized.contains("token expired")
        || normalized.contains("expired token")
        || compact.contains("invalidtoken")
        || compact.contains("tokenexpired")
        || compact.contains("expiredtoken")
        || normalized.contains("reauthorization")
        || normalized.contains("re-authorization")
        || normalized.contains("authorization required")
        || normalized.contains("reauthenticate")
        || normalized.contains("re-authenticate")
        || normalized.contains("authentication failed")
        || normalized.contains("auth failed")
        || (normalized.contains("credentials do not contain")
            && normalized.contains("refresh the access token")
            && normalized.contains("refresh_token")
            && normalized.contains("client_id")
            && normalized.contains("client_secret"))
        || (normalized.contains("401")
            && (normalized.contains("oauth")
                || normalized.contains("token")
                || normalized.contains("unauthorized")))
        || (normalized.contains("unauthorized")
            && (normalized.contains("oauth") || normalized.contains("token")))
}

pub(crate) async fn trigger_restart_hook(server_id: &str, reason: &str) {
    warn!(
        "[{}] triggering MCP server restart hook after {}",
        server_id, reason
    );
    let url = format!("{}{}", restart_endpoint_prefix(), server_id);
    let client_request_id = format!("mcp-timeout-recovery:{server_id}");
    let client = reqwest::Client::new();
    let started = Instant::now();
    let mut retry_index = 0usize;
    loop {
        let remaining = RESTART_HANDOFF_MAX_ELAPSED.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            error!(
                "[{}] automatic restart handoff exhausted its two-minute coordinator window request_id={}",
                server_id, client_request_id
            );
            return;
        }
        match client
            .post(&url)
            .header("x-client-request-id", &client_request_id)
            .json(&serde_json::json!({
                "clientRequestId": client_request_id,
                "automaticRecovery": true,
                "recoveryReason": reason,
                "recoverySource": "mcp-orc",
            }))
            .timeout(Duration::from_secs(10).min(remaining))
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                info!(
                    "[{}] coordinated MCP restart handoff completed successfully request_id={}",
                    server_id, client_request_id
                );
                return;
            }
            Ok(response)
                if response.status() == StatusCode::CONFLICT
                    && started.elapsed() < RESTART_HANDOFF_MAX_ELAPSED =>
            {
                let delay = RESTART_HANDOFF_RETRY_DELAYS_SECONDS
                    [retry_index.min(RESTART_HANDOFF_RETRY_DELAYS_SECONDS.len() - 1)];
                retry_index += 1;
                let delay_duration = Duration::from_secs(delay);
                let remaining = RESTART_HANDOFF_MAX_ELAPSED.saturating_sub(started.elapsed());
                if delay_duration >= remaining {
                    error!(
                        "[{}] automatic restart handoff remained coordinator-busy for two minutes request_id={}",
                        server_id, client_request_id
                    );
                    return;
                }
                warn!(
                    "[{}] MCP mutation coordinator is busy; retrying automatic restart handoff in {} seconds request_id={}",
                    server_id, delay, client_request_id
                );
                tokio::time::sleep(delay_duration).await;
            }
            Ok(response) => {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                error!(
                    "[{}] MCP restart hook failed with HTTP {}: {}",
                    server_id, status, body
                );
                return;
            }
            Err(error) => {
                error!("[{}] MCP restart hook request failed: {error:#}", server_id);
                return;
            }
        }
    }
}

fn restart_endpoint_prefix() -> String {
    std::env::var("MCPO_RESTART_ENDPOINT_PREFIX")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| MCP_RESTART_ENDPOINT_PREFIX.to_string())
}

pub(crate) fn status_from_tool_error(message: &str, authorization_url: Option<&str>) -> StatusCode {
    let normalized = message.to_ascii_lowercase();
    if authorization_url.is_some() || is_probable_oauth_error_text(&normalized) {
        StatusCode::UNAUTHORIZED
    } else if normalized.contains("timeout") {
        StatusCode::GATEWAY_TIMEOUT
    } else if normalized.contains("not connected") || normalized.contains("failed to connect") {
        StatusCode::BAD_GATEWAY
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    }
}

pub(crate) fn extract_authorization_url(message: &str) -> Option<String> {
    message
        .split("authorization_url=")
        .nth(1)
        .map(str::trim)
        .map(ToOwned::to_owned)
}

pub(crate) fn strip_authorization_url(message: &str) -> String {
    message
        .split("; authorization_url=")
        .next()
        .unwrap_or(message)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::{
        extract_authorization_url, is_probable_oauth_error_text, status_from_tool_error,
        strip_authorization_url, trigger_restart_hook, RESTART_HANDOFF_MAX_ELAPSED,
        RESTART_HANDOFF_RETRY_DELAYS_SECONDS,
    };
    use axum::extract::State;
    use axum::http::HeaderMap;
    use axum::routing::post;
    use axum::{Json, Router};
    use serde_json::{json, Value};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::net::TcpListener;
    use tokio::sync::oneshot;

    #[test]
    fn classifies_oauth_error_text() {
        assert!(is_probable_oauth_error_text(
            "401 unauthorized invalid_token"
        ));
        assert!(is_probable_oauth_error_text("token expired"));
        assert!(is_probable_oauth_error_text("token_expired"));
        assert!(is_probable_oauth_error_text("token-expired"));
        assert!(is_probable_oauth_error_text("invalid-token"));
        assert!(is_probable_oauth_error_text(
            "Authentication failed. Please re-authenticate with a valid token."
        ));
        assert!(is_probable_oauth_error_text(
            "Failed to fetch document: The credentials do not contain the necessary fields need to refresh the access token. You must specify refresh_token, token_uri, client_id, and client_secret."
        ));
        assert!(!is_probable_oauth_error_text("plain upstream failure"));
    }

    #[test]
    fn error_helpers_match_http_mapping() {
        let message = "boom; authorization_url=https://example.test/auth";
        assert_eq!(
            extract_authorization_url(message).as_deref(),
            Some("https://example.test/auth")
        );
        assert_eq!(strip_authorization_url(message), "boom");
        assert_eq!(
            status_from_tool_error("timeout", None),
            reqwest::StatusCode::GATEWAY_TIMEOUT
        );
        assert_eq!(
            status_from_tool_error("whatever", Some("https://example.test/auth")),
            reqwest::StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            status_from_tool_error(
                "Authentication failed. Please re-authenticate with a valid token.",
                None
            ),
            reqwest::StatusCode::UNAUTHORIZED
        );
    }

    #[test]
    fn automatic_restart_handoff_uses_bounded_coordinator_backoff() {
        assert_eq!(RESTART_HANDOFF_RETRY_DELAYS_SECONDS, [2, 4, 8, 16, 30]);
        assert_eq!(RESTART_HANDOFF_MAX_ELAPSED, Duration::from_secs(120));
    }

    #[derive(Clone, Default)]
    struct RestartState {
        hits: Arc<Mutex<Vec<Value>>>,
    }

    async fn restart_handler(
        State(state): State<RestartState>,
        headers: HeaderMap,
        Json(payload): Json<Value>,
    ) -> Json<Value> {
        state.hits.lock().unwrap().push(json!({
            "request_id": headers
                .get("x-client-request-id")
                .and_then(|value| value.to_str().ok()),
            "payload": payload,
        }));
        Json(json!({"success": true}))
    }

    struct RestartServer {
        url: String,
        shutdown: Option<oneshot::Sender<()>>,
    }

    impl RestartServer {
        async fn spawn() -> (Self, RestartState) {
            let state = RestartState::default();
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let (shutdown_tx, shutdown_rx) = oneshot::channel();
            let router = Router::new()
                .route("/demo", post(restart_handler))
                .with_state(state.clone());
            tokio::spawn(async move {
                let _ = axum::serve(listener, router)
                    .with_graceful_shutdown(async move {
                        let _ = shutdown_rx.await;
                    })
                    .await;
            });
            (
                Self {
                    url: format!("http://{address}/"),
                    shutdown: Some(shutdown_tx),
                },
                state,
            )
        }
    }

    impl Drop for RestartServer {
        fn drop(&mut self) {
            if let Some(shutdown) = self.shutdown.take() {
                let _ = shutdown.send(());
            }
        }
    }

    struct EnvGuard(Vec<(String, Option<String>)>);

    impl EnvGuard {
        fn set(entries: &[(&str, String)]) -> Self {
            let previous = entries
                .iter()
                .map(|(key, value)| {
                    let previous = std::env::var(key).ok();
                    std::env::set_var(key, value);
                    ((*key).to_string(), previous)
                })
                .collect();
            Self(previous)
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (key, value) in self.0.drain(..) {
                match value {
                    Some(value) => std::env::set_var(&key, value),
                    None => std::env::remove_var(&key),
                }
            }
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn restart_hook_posts_to_configured_endpoint() {
        let _lock = crate::test_env_lock();
        let (server, state) = RestartServer::spawn().await;
        let _env = EnvGuard::set(&[("MCPO_RESTART_ENDPOINT_PREFIX", server.url.clone())]);

        trigger_restart_hook("demo", "test").await;

        tokio::time::sleep(Duration::from_millis(100)).await;
        let hits = state.hits.lock().unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["request_id"], "mcp-timeout-recovery:demo");
        assert_eq!(hits[0]["payload"]["automaticRecovery"], true);
        assert_eq!(hits[0]["payload"]["recoverySource"], "mcp-orc");
        assert_eq!(hits[0]["payload"]["recoveryReason"], "test");
    }
}
