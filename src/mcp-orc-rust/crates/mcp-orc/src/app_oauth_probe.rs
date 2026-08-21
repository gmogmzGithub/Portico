use std::time::Duration;

use anyhow::{Context, Result};
use log::{info, warn};
use reqwest::header::{ACCEPT, WWW_AUTHENTICATE};
use reqwest::StatusCode;
use serde_json::{json, Map, Value};

use crate::config::{normalize_server_type, ServerConfig};
use crate::oauth::{discover_from_auth_challenge, oauth_info, oauth_warn, OAuthDiscovery};

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) async fn probe_server_for_oauth_config(
    server_name: &str,
    config: &ServerConfig,
) -> Result<Option<Value>> {
    let Some(server_url) = config.url.as_deref() else {
        return Ok(None);
    };

    let Some(discovery) = probe_server_for_oauth_discovery(server_name, config).await? else {
        return Ok(None);
    };

    Ok(Some(discovered_oauth_config(server_url, discovery)))
}

pub(crate) async fn probe_server_for_oauth_discovery(
    server_name: &str,
    config: &ServerConfig,
) -> Result<Option<OAuthDiscovery>> {
    let server_type = normalize_server_type(config.server_type.as_deref());
    if !matches!(
        server_type.as_deref(),
        Some("streamable-http") | Some("sse")
    ) {
        return Ok(None);
    }

    let Some(server_url) = config.url.as_deref() else {
        return Ok(None);
    };

    info!(
        "[{}] probing MCP server for OAuth requirements (RFC 9728)",
        server_name
    );
    oauth_info(format!(
        "[{server_name}] probing MCP server for OAuth requirements (RFC 9728 startup probe)"
    ));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .context("failed to build OAuth probe client")?;
    let response = match client
        .get(server_url)
        .header(ACCEPT, "text/event-stream")
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            warn!(
                "[{}] OAuth startup probe failed for '{}': {error:#}",
                server_name, server_url
            );
            oauth_warn(format!(
                "[{server_name}] OAuth startup probe failed for '{server_url}': {error:#}"
            ));
            return Ok(None);
        }
    };

    if response.status() != StatusCode::UNAUTHORIZED {
        info!(
            "[{}] OAuth startup probe returned HTTP {}, continuing without OAuth",
            server_name,
            response.status()
        );
        oauth_info(format!(
            "[{server_name}] OAuth startup probe returned HTTP {}; continuing without OAuth",
            response.status()
        ));
        return Ok(None);
    }

    let Some(auth_header) = response
        .headers()
        .get(WWW_AUTHENTICATE)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.trim().is_empty())
    else {
        warn!(
            "[{}] OAuth startup probe returned 401 without WWW-Authenticate",
            server_name
        );
        oauth_warn(format!(
            "[{server_name}] OAuth startup probe returned 401 without WWW-Authenticate"
        ));
        return Ok(None);
    };

    let Some(discovery) =
        discover_from_auth_challenge(&client, server_name, auth_header, server_url).await?
    else {
        warn!(
            "[{}] OAuth startup probe could not discover authorization metadata",
            server_name
        );
        oauth_warn(format!(
            "[{server_name}] OAuth startup probe could not discover authorization metadata"
        ));
        return Ok(None);
    };

    Ok(Some(discovery))
}

pub(crate) fn discovered_oauth_config(server_url: &str, discovery: OAuthDiscovery) -> Value {
    let OAuthDiscovery {
        metadata,
        resource,
        challenge_scopes,
        ..
    } = discovery;
    let configured_server_url = server_url.trim().to_string();
    let mut oauth_config = Map::new();
    oauth_config.insert(
        "server_url".to_string(),
        Value::String(configured_server_url),
    );
    oauth_config.insert("discovered".to_string(), Value::Bool(true));

    if let Some(resource) = resource
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        oauth_config.insert("resource".to_string(), Value::String(resource.to_string()));
    }

    if !challenge_scopes.is_empty() {
        oauth_config.insert("scopes".to_string(), json!(challenge_scopes));
    }

    if let Some(metadata) = metadata {
        oauth_config.insert(
            "authorization_endpoint".to_string(),
            Value::String(metadata.authorization_endpoint),
        );
        oauth_config.insert(
            "token_endpoint".to_string(),
            Value::String(metadata.token_endpoint),
        );
        if let Some(registration_endpoint) = metadata.registration_endpoint {
            oauth_config.insert(
                "registration_endpoint".to_string(),
                Value::String(registration_endpoint),
            );
        }
    }

    Value::Object(oauth_config)
}

#[cfg(test)]
mod tests {
    use super::{discovered_oauth_config, probe_server_for_oauth_config};
    use crate::config::ServerConfig;
    use crate::oauth::OAuthDiscovery;
    use axum::http::{HeaderValue, StatusCode};
    use axum::routing::{get, post};
    use axum::{Json, Router};
    use rmcp::transport::auth::AuthorizationMetadata;
    use serde_json::{json, Value};
    use std::collections::BTreeMap;
    use tokio::net::TcpListener;
    use tokio::sync::oneshot;

    struct ProbeHarness {
        base_url: String,
        shutdown: Option<oneshot::Sender<()>>,
    }

    impl ProbeHarness {
        async fn oauth_required() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let base_url = format!("http://{address}");
            let challenge = format!(
                r#"Bearer resource_metadata="{base_url}/prm", scope="read:data write:data""#
            );
            let prm_body = json!({
                "authorization_endpoint": format!("{base_url}/authorize"),
                "token_endpoint": format!("{base_url}/token"),
                "registration_endpoint": format!("{base_url}/register"),
                "resource": format!("{base_url}/mcp"),
                "scopes_supported": ["offline_access"]
            });
            let router = Router::new()
                .route(
                    "/mcp",
                    get({
                        let challenge = challenge.clone();
                        move || {
                            let challenge = challenge.clone();
                            async move {
                                (
                                    StatusCode::UNAUTHORIZED,
                                    [(
                                        "WWW-Authenticate",
                                        HeaderValue::from_str(&challenge).unwrap(),
                                    )],
                                    "auth required",
                                )
                            }
                        }
                    }),
                )
                .route("/prm", get(move || async move { Json(prm_body.clone()) }))
                .route(
                    "/authorize",
                    get(|| async { (StatusCode::OK, "authorize") }),
                )
                .route(
                    "/register",
                    post(|| async {
                        Json(json!({
                            "client_id": "dynamic-client",
                            "redirect_uris": ["http://localhost:3834/callback"],
                            "grant_types": ["authorization_code", "refresh_token"],
                            "response_types": ["code"],
                            "token_endpoint_auth_method": "none"
                        }))
                    }),
                )
                .route(
                    "/token",
                    post(|| async { Json(json!({"access_token": "token"})) }),
                );
            let (shutdown_tx, shutdown_rx) = oneshot::channel();
            tokio::spawn(async move {
                let _ = axum::serve(listener, router)
                    .with_graceful_shutdown(async move {
                        let _ = shutdown_rx.await;
                    })
                    .await;
            });
            Self {
                base_url,
                shutdown: Some(shutdown_tx),
            }
        }

        async fn public_server() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let base_url = format!("http://{address}");
            let router = Router::new().route("/mcp", get(|| async { (StatusCode::OK, "ok") }));
            let (shutdown_tx, shutdown_rx) = oneshot::channel();
            tokio::spawn(async move {
                let _ = axum::serve(listener, router)
                    .with_graceful_shutdown(async move {
                        let _ = shutdown_rx.await;
                    })
                    .await;
            });
            Self {
                base_url,
                shutdown: Some(shutdown_tx),
            }
        }
    }

    impl Drop for ProbeHarness {
        fn drop(&mut self) {
            if let Some(shutdown) = self.shutdown.take() {
                let _ = shutdown.send(());
            }
        }
    }

    fn http_config(server_type: &str, url: String) -> ServerConfig {
        ServerConfig {
            server_type: Some(server_type.to_string()),
            url: Some(url),
            command: None,
            args: Vec::new(),
            env: BTreeMap::new(),
            sensitive_env_vars: Vec::new(),
            oauth: None,
            headers: None,
            disabled_tools: Vec::new(),
            tool_rename_mapping: BTreeMap::new(),
            tool_call_timeout: None,
            client_header_forwarding: None,
            http_subprocess: None,
            extra: BTreeMap::new(),
        }
    }

    #[tokio::test]
    async fn discovers_oauth_config_from_401_probe() {
        let harness = ProbeHarness::oauth_required().await;
        let config = http_config("streamable-http", format!("{}/mcp", harness.base_url));

        let discovered = probe_server_for_oauth_config("glean", &config)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(
            discovered["server_url"],
            Value::String(format!("{}/mcp", harness.base_url))
        );
        assert_eq!(
            discovered["authorization_endpoint"],
            Value::String(format!("{}/authorize", harness.base_url))
        );
        assert_eq!(
            discovered["registration_endpoint"],
            Value::String(format!("{}/register", harness.base_url))
        );
        assert_eq!(
            discovered["resource"],
            Value::String(format!("{}/mcp", harness.base_url))
        );
        assert_eq!(discovered["scopes"], json!(["read:data", "write:data"]));
    }

    #[test]
    fn preserves_authoritative_probe_resource_with_trailing_slash() {
        let discovered = discovered_oauth_config(
            "https://example.test/mcp/",
            OAuthDiscovery {
                resource: Some("https://example.test/mcp/".to_string()),
                ..Default::default()
            },
        );

        assert_eq!(
            discovered["server_url"],
            Value::String("https://example.test/mcp/".to_string())
        );
        assert_eq!(
            discovered["resource"],
            Value::String("https://example.test/mcp/".to_string())
        );
    }

    #[test]
    fn preserves_materially_distinct_probe_resource() {
        let discovered = discovered_oauth_config(
            "https://example.test/mcp/",
            OAuthDiscovery {
                resource: Some("https://example.test/protected-resource/".to_string()),
                ..Default::default()
            },
        );

        assert_eq!(
            discovered["server_url"],
            Value::String("https://example.test/mcp/".to_string())
        );
        assert_eq!(
            discovered["resource"],
            Value::String("https://example.test/protected-resource/".to_string())
        );
    }

    #[test]
    fn omits_metadata_only_scopes_from_discovered_config() {
        let discovered = discovered_oauth_config(
            "https://example.test/mcp/",
            OAuthDiscovery {
                metadata: Some(AuthorizationMetadata {
                    authorization_endpoint: "https://auth.example.test/authorize".to_string(),
                    token_endpoint: "https://auth.example.test/token".to_string(),
                    registration_endpoint: Some("https://auth.example.test/register".to_string()),
                    issuer: None,
                    jwks_uri: None,
                    scopes_supported: Some(vec![
                        "offline_access".to_string(),
                        "scope-a".to_string(),
                    ]),
                    response_types_supported: None,
                    code_challenge_methods_supported: Some(vec!["S256".to_string()]),
                    additional_fields: Default::default(),
                }),
                resource: Some("https://example.test/mcp/".to_string()),
                ..Default::default()
            },
        );

        assert!(discovered.get("scopes").is_none());
        assert_eq!(
            discovered["authorization_endpoint"],
            Value::String("https://auth.example.test/authorize".to_string())
        );
        assert_eq!(
            discovered["registration_endpoint"],
            Value::String("https://auth.example.test/register".to_string())
        );
    }

    #[tokio::test]
    async fn ignores_servers_that_do_not_require_oauth() {
        let harness = ProbeHarness::public_server().await;
        let config = http_config("sse", format!("{}/mcp", harness.base_url));

        assert!(probe_server_for_oauth_config("public", &config)
            .await
            .unwrap()
            .is_none());
    }
}
