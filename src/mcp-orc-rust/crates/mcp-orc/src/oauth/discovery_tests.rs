use super::{discover_from_auth_challenge, discover_from_base_url};
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

#[derive(Clone, Default)]
struct TestState {
    base_url: String,
    responses: Arc<Mutex<BTreeMap<String, Value>>>,
}

struct DiscoveryServer {
    base_url: String,
    task: JoinHandle<()>,
}

impl Drop for DiscoveryServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl DiscoveryServer {
    async fn spawn(responses: BTreeMap<String, Value>) -> Self {
        async fn handler(
            State(state): State<TestState>,
            uri: axum::http::Uri,
        ) -> (StatusCode, Json<Value>) {
            let path = uri.path().to_string();
            let body = state
                .responses
                .lock()
                .unwrap()
                .get(&path)
                .cloned()
                .unwrap_or_else(|| json!({"error": "missing"}));
            let body = replace_self_urls(body, &state.base_url);
            let status =
                if body.get("error").is_some() && body.get("authorization_endpoint").is_none() {
                    StatusCode::NOT_FOUND
                } else {
                    StatusCode::OK
                };
            (status, Json(body))
        }

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = Router::new()
            .route("/", get(handler))
            .route("/mcp", get(handler))
            .route("/mcp/.well-known/oauth-protected-resource", get(handler))
            .route("/prm", get(handler))
            .route("/prm-direct", get(handler))
            .route("/.well-known/oauth-protected-resource", get(handler))
            .route("/.well-known/oauth-protected-resource/mcp", get(handler))
            .route("/auth/.well-known/oauth-protected-resource", get(handler))
            .route("/.well-known/oauth-authorization-server", get(handler))
            .route("/.well-known/oauth-authorization-server/mcp", get(handler))
            .route("/.well-known/oauth-authorization-server/auth", get(handler))
            .route("/.well-known/openid-configuration", get(handler))
            .route("/auth/.well-known/openid-configuration", get(handler))
            .with_state(TestState {
                base_url: format!("http://{}", address),
                responses: Arc::new(Mutex::new(responses)),
            });
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self {
            base_url: format!("http://{}", address),
            task,
        }
    }
}

fn replace_self_urls(value: Value, base_url: &str) -> Value {
    match value {
        Value::String(raw) => Value::String(raw.replace("SELF", base_url)),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| replace_self_urls(item, base_url))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| (key, replace_self_urls(value, base_url)))
                .collect(),
        ),
        other => other,
    }
}

#[tokio::test]
async fn discovers_metadata_via_explicit_resource_metadata_url() {
    let server = DiscoveryServer::spawn(BTreeMap::from([
        (
            "/prm".to_string(),
            json!({
                "authorization_servers": ["SELF"],
                "resource": "SELF/resource/default",
                "scopes_supported": ["openid", "offline_access"]
            }),
        ),
        (
            "/.well-known/oauth-authorization-server".to_string(),
            json!({
                "authorization_endpoint": "SELF/authorize",
                "token_endpoint": "SELF/token",
                "registration_endpoint": "SELF/register",
                "scopes_supported": ["openid", "offline_access"]
            }),
        ),
    ]))
    .await;
    let prm_url = format!("{}/prm", server.base_url);
    let mcp_url = format!("{}/mcp", server.base_url);
    let resource = format!("{}/resource/default", server.base_url);
    let expected_authorize = format!("{}/authorize", server.base_url);
    let expected_register = format!("{}/register", server.base_url);

    let discovery = discover_from_auth_challenge(
        &reqwest::Client::new(),
        "glean",
        &format!(r#"Bearer resource_metadata="{prm_url}""#),
        &mcp_url,
    )
    .await
    .unwrap()
    .unwrap();
    let metadata = discovery.metadata.unwrap();
    assert_eq!(discovery.resource.as_deref(), Some(resource.as_str()));
    assert_eq!(
        discovery.protected_resource_scopes,
        vec!["openid".to_string(), "offline_access".to_string()]
    );
    assert_eq!(metadata.authorization_endpoint, expected_authorize);
    assert_eq!(
        metadata.registration_endpoint.as_deref(),
        Some(expected_register.as_str())
    );
    assert_eq!(
        metadata.scopes_supported.unwrap(),
        vec!["openid".to_string(), "offline_access".to_string()]
    );
}

#[tokio::test]
async fn discovers_direct_endpoints_embedded_in_resource_metadata() {
    let server = DiscoveryServer::spawn(BTreeMap::from([(
        "/prm-direct".to_string(),
        json!({
            "authorization_endpoint": "https://issuer.example/authorize",
            "token_endpoint": "https://issuer.example/token",
            "registration_endpoint": "https://issuer.example/register",
            "resource": "https://resource.example/mcp/default",
            "scopes_supported": ["scope-a"]
        }),
    )]))
    .await;

    let discovery = discover_from_auth_challenge(
        &reqwest::Client::new(),
        "google_workspace",
        &format!(
            r#"Bearer resource_metadata="{}/prm-direct""#,
            server.base_url
        ),
        &format!("{}/mcp", server.base_url),
    )
    .await
    .unwrap()
    .unwrap();
    let metadata = discovery.metadata.unwrap();
    assert_eq!(
        discovery.resource.as_deref(),
        Some("https://resource.example/mcp/default")
    );
    assert_eq!(
        discovery.protected_resource_scopes,
        vec!["scope-a".to_string()]
    );
    assert_eq!(
        metadata.authorization_endpoint,
        "https://issuer.example/authorize"
    );
    assert_eq!(metadata.token_endpoint, "https://issuer.example/token");
    assert_eq!(
        metadata.registration_endpoint.as_deref(),
        Some("https://issuer.example/register")
    );
}

#[tokio::test]
async fn falls_back_to_well_known_resource_metadata_without_header_url() {
    let server = DiscoveryServer::spawn(BTreeMap::from([
        (
            "/.well-known/oauth-protected-resource/mcp".to_string(),
            json!({
                "authorization_servers": ["SELF"],
                "resource": "https://fallback.example/mcp"
            }),
        ),
        (
            "/.well-known/oauth-authorization-server".to_string(),
            json!({
                "authorization_endpoint": "https://issuer.example/authorize",
                "token_endpoint": "https://issuer.example/token"
            }),
        ),
    ]))
    .await;

    let discovery = discover_from_auth_challenge(
        &reqwest::Client::new(),
        "fallback",
        "Bearer realm=\"example\"",
        &format!("{}/mcp", server.base_url),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        discovery.resource.as_deref(),
        Some("https://fallback.example/mcp")
    );
    assert_eq!(
        discovery.metadata.unwrap().authorization_endpoint,
        "https://issuer.example/authorize"
    );
}

#[tokio::test]
async fn discovers_metadata_from_base_url_without_auth_challenge() {
    let server = DiscoveryServer::spawn(BTreeMap::from([
        (
            "/.well-known/oauth-protected-resource".to_string(),
            json!({
                "authorization_servers": ["SELF"],
                "resource": "SELF/mcp",
                "scopes_supported": ["offline_access", "scope-a"]
            }),
        ),
        (
            "/.well-known/oauth-authorization-server".to_string(),
            json!({
                "authorization_endpoint": "SELF/authorize",
                "token_endpoint": "SELF/token",
                "registration_endpoint": "SELF/register"
            }),
        ),
    ]))
    .await;

    let expected_resource = format!("{}/mcp", server.base_url);
    let expected_authorize = format!("{}/authorize", server.base_url);
    let expected_token = format!("{}/token", server.base_url);
    let expected_register = format!("{}/register", server.base_url);

    let discovery =
        discover_from_base_url(&reqwest::Client::new(), "data-plat-mcp", &expected_resource)
            .await
            .unwrap()
            .unwrap();

    let metadata = discovery.metadata.unwrap();
    assert_eq!(
        discovery.resource.as_deref(),
        Some(expected_resource.as_str())
    );
    assert_eq!(
        discovery.protected_resource_scopes,
        vec!["offline_access".to_string(), "scope-a".to_string()]
    );
    assert_eq!(metadata.authorization_endpoint, expected_authorize);
    assert_eq!(metadata.token_endpoint, expected_token);
    assert_eq!(
        metadata.registration_endpoint.as_deref(),
        Some(expected_register.as_str())
    );
}

#[tokio::test]
async fn preserves_scope_from_www_authenticate_challenge() {
    let server = DiscoveryServer::spawn(BTreeMap::new()).await;
    let discovery = discover_from_auth_challenge(
        &reqwest::Client::new(),
        "scope-test",
        r#"Bearer scope="read:data write:data""#,
        &format!("{}/mcp", server.base_url),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        discovery.challenge_scopes,
        vec!["read:data".to_string(), "write:data".to_string()]
    );
}

#[tokio::test]
async fn skips_unsuccessful_resource_candidates_before_using_canonical_metadata() {
    let server = DiscoveryServer::spawn(BTreeMap::from([
        (
            "/mcp/.well-known/oauth-protected-resource".to_string(),
            json!({"error":"auth-required"}),
        ),
        (
            "/.well-known/oauth-protected-resource".to_string(),
            json!({
                "authorization_servers": ["SELF"],
                "resource": "SELF/mcp"
            }),
        ),
        (
            "/.well-known/oauth-authorization-server".to_string(),
            json!({
                "authorization_endpoint": "SELF/authorize",
                "token_endpoint": "SELF/token",
                "registration_endpoint": "SELF/register"
            }),
        ),
    ]))
    .await;

    let resource_url = format!("{}/mcp", server.base_url);
    let discovery = discover_from_base_url(&reqwest::Client::new(), "data-plat-mcp", &resource_url)
        .await
        .unwrap()
        .unwrap();
    let metadata = discovery.metadata.unwrap();

    assert_eq!(discovery.resource.as_deref(), Some(resource_url.as_str()));
    assert_eq!(
        metadata.authorization_endpoint,
        format!("{}/authorize", server.base_url)
    );
    assert_eq!(
        discovery.authorization_servers,
        vec![format!("{}/", server.base_url)]
    );
}
