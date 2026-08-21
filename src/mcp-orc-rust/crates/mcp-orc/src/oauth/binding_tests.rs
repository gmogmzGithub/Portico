use super::{
    build_client_info_from_credentials, joined_scope, map_streamable_error,
    oauth_access_token_sha256, resolve_redirect_uri, OAuthBinding, OAuthDiscovery,
    OAuthRefreshOutcome, OAuthStreamableHttpClient, OAuthTransportError,
    OAUTH_BROKER_SERVER_ID_ENV, OAUTH_BROKER_TOKEN_ENV, OAUTH_BROKER_URL_ENV,
};
use crate::config::ServerConfig;
use crate::oauth::config::{LoadedCredentials, OAuthConfig};
use crate::oauth::{CompatClientInfo, CompatTokenFile, OAuthCoordinator, OAuthState};
use axum::body::Bytes;
use axum::extract::State;
use axum::http::header::{HeaderName, HeaderValue};
use axum::http::{HeaderMap, StatusCode as HttpStatus, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use futures::stream::{self, BoxStream, StreamExt};
use rmcp::model::ClientJsonRpcMessage;
use rmcp::transport::auth::{AuthError, AuthorizationMetadata, StoredAuthorizationState};
use rmcp::transport::streamable_http_client::{
    AuthRequiredError, InsufficientScopeError, StreamableHttpClient, StreamableHttpError,
    StreamableHttpPostResponse,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::env;
use std::error::Error;
use std::fmt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

#[derive(Clone)]
enum ResponseBody {
    Json(Value),
    Text(String),
}

#[derive(Clone)]
struct ResponseSpec {
    status: HttpStatus,
    body: ResponseBody,
    headers: Vec<(String, String)>,
}

impl ResponseSpec {
    fn json(status: HttpStatus, body: Value) -> Self {
        Self {
            status,
            body: ResponseBody::Json(body),
            headers: Vec::new(),
        }
    }

    fn text(status: HttpStatus, body: impl Into<String>) -> Self {
        Self {
            status,
            body: ResponseBody::Text(body.into()),
            headers: Vec::new(),
        }
    }

    fn with_header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_string(), value.to_string()));
        self
    }
}

#[derive(Clone, Debug)]
struct RequestRecord {
    path: String,
    authorization: Option<String>,
    body: String,
}

#[derive(Clone)]
struct TestServerState {
    token_response: ResponseSpec,
    registration_response: ResponseSpec,
    scope_rejected_registration_response: Option<ResponseSpec>,
    redirect_response: ResponseSpec,
    requests: Arc<StdMutex<Vec<RequestRecord>>>,
}

struct TestHttpServer {
    base_url: String,
    requests: Arc<StdMutex<Vec<RequestRecord>>>,
    task: JoinHandle<()>,
}

impl Drop for TestHttpServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl TestHttpServer {
    async fn spawn(token_response: ResponseSpec, registration_response: ResponseSpec) -> Self {
        Self::spawn_with_scope_rejection(token_response, registration_response, None).await
    }

    async fn spawn_with_scope_rejection(
        token_response: ResponseSpec,
        registration_response: ResponseSpec,
        scope_rejected_registration_response: Option<ResponseSpec>,
    ) -> Self {
        async fn token_handler(
            State(state): State<TestServerState>,
            headers: HeaderMap,
            body: Bytes,
        ) -> impl IntoResponse {
            state.requests.lock().unwrap().push(RequestRecord {
                path: "/token".to_string(),
                authorization: headers
                    .get(axum::http::header::AUTHORIZATION)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_string),
                body: String::from_utf8_lossy(&body).into_owned(),
            });
            render_response(&state.token_response)
        }

        async fn registration_handler(
            State(state): State<TestServerState>,
            headers: HeaderMap,
            body: Bytes,
        ) -> impl IntoResponse {
            let body_text = String::from_utf8_lossy(&body).into_owned();
            state.requests.lock().unwrap().push(RequestRecord {
                path: "/register".to_string(),
                authorization: headers
                    .get(axum::http::header::AUTHORIZATION)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_string),
                body: body_text.clone(),
            });
            let scope_rejected = serde_json::from_slice::<Value>(&body)
                .ok()
                .and_then(|payload| payload.get("scope").cloned())
                .is_some();
            if scope_rejected {
                if let Some(response) = state.scope_rejected_registration_response.as_ref() {
                    return render_response(response);
                }
            }
            render_response(&state.registration_response)
        }

        async fn redirect_handler(
            State(state): State<TestServerState>,
            uri: Uri,
        ) -> impl IntoResponse {
            state.requests.lock().unwrap().push(RequestRecord {
                path: uri.path().to_string(),
                authorization: None,
                body: String::new(),
            });
            render_response(&state.redirect_response)
        }

        fn render_response(spec: &ResponseSpec) -> Response {
            let mut response = match &spec.body {
                ResponseBody::Json(body) => (spec.status, Json(body.clone())).into_response(),
                ResponseBody::Text(body) => (spec.status, body.clone()).into_response(),
            };
            for (name, value) in &spec.headers {
                response.headers_mut().insert(
                    HeaderName::from_bytes(name.as_bytes()).expect("valid test header name"),
                    HeaderValue::from_str(value).expect("valid test header value"),
                );
            }
            response
        }

        let requests = Arc::new(StdMutex::new(Vec::new()));
        let state = TestServerState {
            token_response,
            registration_response,
            scope_rejected_registration_response,
            redirect_response: ResponseSpec::text(HttpStatus::OK, "<html>redirect target</html>")
                .with_header("content-type", "text/html"),
            requests: requests.clone(),
        };
        let router = Router::new()
            .route("/token", post(token_handler))
            .route("/register", post(registration_handler))
            .route("/html", get(redirect_handler))
            .with_state(state);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self {
            base_url: format!("http://{}", address),
            requests,
            task,
        }
    }

    fn request(&self, path: &str) -> RequestRecord {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|record| record.path == path)
            .cloned()
            .unwrap()
    }

    fn requests(&self) -> Vec<RequestRecord> {
        self.requests.lock().unwrap().clone()
    }
}

fn env_lock() -> MutexGuard<'static, ()> {
    super::oauth_test_env_lock()
}

struct TokenEnv {
    _guard: MutexGuard<'static, ()>,
    previous: Option<String>,
    path: PathBuf,
}

impl TokenEnv {
    fn new(test_name: &str) -> Self {
        let guard = env_lock();
        let previous = env::var("MCPO_TOKEN_STORAGE_DIR").ok();
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = env::temp_dir().join(format!("mcp-orc-binding-{test_name}-{unique}"));
        std::fs::create_dir_all(&path).unwrap();
        env::set_var("MCPO_TOKEN_STORAGE_DIR", &path);
        Self {
            _guard: guard,
            previous,
            path,
        }
    }
}

impl Drop for TokenEnv {
    fn drop(&mut self) {
        if let Some(previous) = self.previous.as_ref() {
            env::set_var("MCPO_TOKEN_STORAGE_DIR", previous);
        } else {
            env::remove_var("MCPO_TOKEN_STORAGE_DIR");
        }
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

#[derive(Clone, Default)]
struct LogState {
    entries: Arc<StdMutex<Vec<Value>>>,
}

struct LogServer {
    url: String,
    shutdown: Option<oneshot::Sender<()>>,
}

impl LogServer {
    async fn spawn() -> (Self, LogState) {
        async fn handler(State(state): State<LogState>, Json(payload): Json<Value>) -> Json<Value> {
            state.entries.lock().unwrap().push(payload);
            Json(json!({"ok": true}))
        }

        let state = LogState::default();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let router = Router::new()
            .route("/oauth-log", post(handler))
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
                url: format!("http://{address}/oauth-log"),
                shutdown: Some(shutdown_tx),
            },
            state,
        )
    }
}

impl Drop for LogServer {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

async fn wait_for_forwarded_log_message(log_state: &LogState, needle: &str) -> String {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let entries = log_state.entries.lock().unwrap().clone();
        if let Some(message) = entries
            .iter()
            .filter_map(|entry| entry.get("message").and_then(Value::as_str))
            .find(|message| message.contains(needle))
        {
            return message.to_string();
        }
        if tokio::time::Instant::now() >= deadline {
            panic!(
                "expected OAuth parse failure log containing {:?}; observed entries: {:?}",
                needle, entries
            );
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

struct EnvVarGuard(Vec<(String, Option<String>)>);

impl EnvVarGuard {
    fn set(entries: &[(&str, String)]) -> Self {
        let previous = entries
            .iter()
            .map(|(key, value)| {
                let previous = env::var(key).ok();
                env::set_var(key, value);
                ((*key).to_string(), previous)
            })
            .collect();
        Self(previous)
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        for (key, value) in self.0.drain(..) {
            match value {
                Some(value) => env::set_var(&key, value),
                None => env::remove_var(&key),
            }
        }
    }
}

#[derive(Debug, Clone)]
struct DummyClientError(&'static str);

impl fmt::Display for DummyClientError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl Error for DummyClientError {}

#[derive(Clone, Default)]
struct DummyClient {
    tokens: Arc<StdMutex<Vec<Option<String>>>>,
}

impl StreamableHttpClient for DummyClient {
    type Error = DummyClientError;

    fn delete_session(
        &self,
        _uri: Arc<str>,
        _session_id: Arc<str>,
        auth_token: Option<String>,
        _custom_headers: HashMap<http::HeaderName, http::HeaderValue>,
    ) -> impl std::future::Future<Output = Result<(), StreamableHttpError<Self::Error>>> + Send + '_
    {
        let tokens = self.tokens.clone();
        async move {
            tokens.lock().unwrap().push(auth_token);
            Ok(())
        }
    }

    fn get_stream(
        &self,
        _uri: Arc<str>,
        _session_id: Arc<str>,
        _last_event_id: Option<String>,
        auth_token: Option<String>,
        _custom_headers: HashMap<http::HeaderName, http::HeaderValue>,
    ) -> impl std::future::Future<
        Output = Result<
            BoxStream<'static, Result<sse_stream::Sse, sse_stream::Error>>,
            StreamableHttpError<Self::Error>,
        >,
    > + Send
           + '_ {
        let tokens = self.tokens.clone();
        async move {
            tokens.lock().unwrap().push(auth_token);
            Ok(stream::empty().boxed())
        }
    }

    fn post_message(
        &self,
        _uri: Arc<str>,
        _message: ClientJsonRpcMessage,
        _session_id: Option<Arc<str>>,
        auth_token: Option<String>,
        _custom_headers: HashMap<http::HeaderName, http::HeaderValue>,
    ) -> impl std::future::Future<
        Output = Result<StreamableHttpPostResponse, StreamableHttpError<Self::Error>>,
    > + Send
           + '_ {
        let tokens = self.tokens.clone();
        async move {
            tokens.lock().unwrap().push(auth_token);
            Ok(StreamableHttpPostResponse::Accepted)
        }
    }
}

fn jwt(payload: Value) -> String {
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(&payload).unwrap());
    format!("eyJhbGciOiJub25lIn0.{encoded}.")
}

fn base_config(base_url: &str) -> ServerConfig {
    ServerConfig {
        server_type: Some("streamable-http".to_string()),
        url: Some(format!("{base_url}/mcp")),
        command: None,
        args: Vec::new(),
        env: BTreeMap::new(),
        sensitive_env_vars: Vec::new(),
        oauth: Some(json!({
            "type": "non-dcr",
            "authorization_endpoint": format!("{base_url}/authorize"),
            "token_endpoint": format!("{base_url}/token"),
            "registration_endpoint": format!("{base_url}/register"),
            "resource": format!("{base_url}/mcp"),
            "scopes": ["openid", "offline_access"],
            "credentials_source": {
                "type": "inline",
                "client_id": "client-id",
                "client_secret": "client-secret"
            }
        })),
        headers: None,
        disabled_tools: Vec::new(),
        tool_rename_mapping: BTreeMap::new(),
        tool_call_timeout: None,
        client_header_forwarding: None,
        http_subprocess: None,
        extra: BTreeMap::new(),
    }
}

fn dcr_config(base_url: &str) -> ServerConfig {
    let mut config = base_config(base_url);
    config.oauth = Some(json!({
        "authorization_endpoint": format!("{base_url}/authorize"),
        "token_endpoint": format!("{base_url}/token"),
        "registration_endpoint": format!("{base_url}/register"),
        "resource": format!("{base_url}/mcp"),
        "scopes": ["openid", "offline_access"]
    }));
    config
}

async fn binding_for(
    name: &str,
    config: &ServerConfig,
) -> (Arc<OAuthBinding>, Arc<OAuthCoordinator>) {
    let coordinator = Arc::new(OAuthCoordinator::new());
    let binding = OAuthBinding::new(name, config, coordinator.clone())
        .await
        .unwrap();
    (binding, coordinator)
}

fn static_metadata(base_url: &str) -> AuthorizationMetadata {
    AuthorizationMetadata {
        authorization_endpoint: format!("{base_url}/authorize"),
        token_endpoint: format!("{base_url}/token"),
        registration_endpoint: Some(format!("{base_url}/register")),
        issuer: None,
        jwks_uri: None,
        scopes_supported: Some(vec!["openid".to_string(), "offline_access".to_string()]),
        response_types_supported: None,
        code_challenge_methods_supported: Some(vec!["S256".to_string()]),
        additional_fields: HashMap::new(),
    }
}

fn future_exp() -> i64 {
    (SystemTime::now() + Duration::from_secs(3600))
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn past_exp() -> i64 {
    1
}

#[tokio::test]
async fn new_requires_oauth_config_and_url() {
    let _env = TokenEnv::new("new-errors");
    let config = ServerConfig {
        server_type: Some("streamable-http".to_string()),
        url: None,
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
    };
    let coordinator = Arc::new(OAuthCoordinator::new());
    let missing_oauth = OAuthBinding::new("demo", &config, coordinator.clone())
        .await
        .err()
        .unwrap();
    assert!(missing_oauth.to_string().contains("missing oauth config"));

    let mut with_oauth = config.clone();
    with_oauth.oauth = Some(json!({}));
    let missing_url = OAuthBinding::new("demo", &with_oauth, coordinator)
        .await
        .err()
        .unwrap();
    assert!(missing_url
        .to_string()
        .contains("requires a streamable-http url"));
}

#[tokio::test]
async fn initializes_startup_state_and_marks_checking_for_usable_tokens() {
    let _env = TokenEnv::new("startup");
    let server = TestHttpServer::spawn(
        ResponseSpec::json(HttpStatus::OK, json!({"access_token":"new-token"})),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;
    let (binding, coordinator) = binding_for("glean", &base_config(&server.base_url)).await;
    binding
        .token_store
        .save_client_info(&CompatClientInfo {
            client_id: "client".to_string(),
            token_endpoint_auth_method: Some("none".to_string()),
            ..Default::default()
        })
        .unwrap();
    binding
        .token_store
        .save_token_file(&CompatTokenFile {
            access_token: jwt(
                json!({"exp": future_exp(), "aud": format!("{}/mcp", server.base_url)}),
            ),
            token_type: Some("Bearer".to_string()),
            expires_in: Some(3600),
            refresh_token: Some("refresh-token".to_string()),
            scope: None,
            extra: Default::default(),
        })
        .unwrap();

    binding.initialize_startup_state().await.unwrap();
    let handshake = coordinator.get_handshake("glean").await.unwrap();
    assert_eq!(handshake.state, OAuthState::Checking);
}

#[tokio::test]
async fn finalize_post_connect_state_marks_completed_for_usable_tokens() {
    let _env = TokenEnv::new("post-connect-usable");
    let server = TestHttpServer::spawn(
        ResponseSpec::json(HttpStatus::OK, json!({"access_token":"new-token"})),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;
    let (binding, coordinator) = binding_for("glean", &base_config(&server.base_url)).await;
    binding
        .token_store
        .save_client_info(&CompatClientInfo {
            client_id: "client".to_string(),
            token_endpoint_auth_method: Some("none".to_string()),
            ..Default::default()
        })
        .unwrap();
    binding
        .token_store
        .save_token_file(&CompatTokenFile {
            access_token: jwt(
                json!({"exp": future_exp(), "aud": format!("{}/mcp", server.base_url)}),
            ),
            token_type: Some("Bearer".to_string()),
            expires_in: Some(3600),
            refresh_token: Some("refresh-token".to_string()),
            scope: None,
            extra: Default::default(),
        })
        .unwrap();

    binding.finalize_post_connect_state().await.unwrap();
    let handshake = coordinator.get_handshake("glean").await.unwrap();
    assert_eq!(handshake.state, OAuthState::Completed);
    assert!(handshake.authorization_url.is_none());
}

#[tokio::test]
async fn finalize_post_connect_state_generates_auth_url_for_non_dcr_without_tokens() {
    let _env = TokenEnv::new("post-connect-non-dcr");
    let server = TestHttpServer::spawn(
        ResponseSpec::json(HttpStatus::OK, json!({"access_token":"new-token"})),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;
    let (binding, coordinator) = binding_for("google", &base_config(&server.base_url)).await;

    binding.finalize_post_connect_state().await.unwrap();
    let handshake = coordinator.get_handshake("google").await.unwrap();
    assert_eq!(handshake.state, OAuthState::Active);
    assert!(handshake
        .authorization_url
        .as_deref()
        .unwrap()
        .starts_with(&format!("{}/authorize?", server.base_url)));
    assert!(handshake.state_param.is_some());
}

#[tokio::test]
async fn builds_auth_urls_and_reuses_cached_active_url() {
    let _env = TokenEnv::new("auth-url");
    let server = TestHttpServer::spawn(
        ResponseSpec::json(HttpStatus::OK, json!({"access_token":"new-token"})),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;
    let (binding, coordinator) = binding_for("glean", &base_config(&server.base_url)).await;

    let generated = binding.ensure_authorization_url(true).await.unwrap();
    assert!(generated.starts_with(&format!("{}/authorize?", server.base_url)));
    assert!(binding
        .oauth_config()
        .resource_url("fallback")
        .ends_with("/mcp"));

    coordinator.restart_oauth_flow("glean").await;
    coordinator
        .set_authorization_url(
            "glean",
            "https://cached.example/auth?state=abc".to_string(),
            true,
        )
        .await;
    let cached = binding.ensure_authorization_url(false).await.unwrap();
    assert_eq!(cached, "https://cached.example/auth?state=abc");

    let auth_required = AuthRequiredError {
        www_authenticate_header: "Bearer realm=example".to_string(),
    };
    let returned = binding.handle_auth_required(&auth_required).await.unwrap();
    assert_eq!(
        returned.as_deref(),
        Some("https://cached.example/auth?state=abc")
    );
}

#[test]
fn authorization_url_resource_rewrite_preserves_other_params() {
    let input = "https://secure.example.invalid/oauth/v2/authorize?client_id=client-id&redirect_uri=http%3A%2F%2Flocalhost%3A3834%2Fcallback&resource=https%3A%2F%2Fold.example%2F&scope=workforce.trust_and_safety.read+offline_access&state=state-123&code_challenge=challenge&code_challenge_method=S256#fragment";

    let rewritten = super::rewrite_authorization_url_resource(
        input,
        Some("https://trust-kit-mcp.sandbox.example.invalid"),
    )
    .unwrap();

    assert_eq!(
        rewritten,
        "https://secure.example.invalid/oauth/v2/authorize?client_id=client-id&redirect_uri=http%3A%2F%2Flocalhost%3A3834%2Fcallback&resource=https%3A%2F%2Ftrust-kit-mcp.sandbox.example.invalid&scope=workforce.trust_and_safety.read+offline_access&state=state-123&code_challenge=challenge&code_challenge_method=S256#fragment"
    );
}

#[tokio::test]
async fn generated_auth_url_preserves_origin_only_resource_without_slash() {
    let _env = TokenEnv::new("origin-resource-auth-url");
    let server = TestHttpServer::spawn(
        ResponseSpec::json(HttpStatus::OK, json!({"access_token":"new-token"})),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;
    let mut config = base_config(&server.base_url);
    config.oauth = Some(json!({
        "type": "non-dcr",
        "authorization_endpoint": format!("{}/authorize", server.base_url),
        "token_endpoint": format!("{}/token", server.base_url),
        "registration_endpoint": format!("{}/register", server.base_url),
        "resource": server.base_url.clone(),
        "scopes": ["openid", "offline_access"],
        "credentials_source": {
            "type": "inline",
            "client_id": "client-id",
            "client_secret": "client-secret"
        }
    }));

    let (binding, _) = binding_for("origin-resource", &config).await;
    let generated = binding.ensure_authorization_url(true).await.unwrap();
    let parsed = reqwest::Url::parse(&generated).unwrap();
    let resource = parsed
        .query_pairs()
        .find_map(|(key, value)| (key == "resource").then(|| value.into_owned()))
        .unwrap();

    assert_eq!(resource, server.base_url);
    assert!(!resource.ends_with('/'));
}

#[tokio::test]
async fn auth_url_includes_singular_compat_scope() {
    let _env = TokenEnv::new("auth-url-compat-scope");
    let server = TestHttpServer::spawn(
        ResponseSpec::json(HttpStatus::OK, json!({"access_token":"new-token"})),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;
    let mut config = base_config(&server.base_url);
    config.oauth = Some(json!({
        "type": "non-dcr",
        "authorization_endpoint": format!("{}/authorize", server.base_url),
        "token_endpoint": format!("{}/token", server.base_url),
        "registration_endpoint": format!("{}/register", server.base_url),
        "resource": format!("{}/mcp", server.base_url),
        "scope": "openid email",
        "credentials_source": {
            "type": "inline",
            "client_id": "client-id",
            "client_secret": "client-secret"
        }
    }));

    let (binding, _) = binding_for("productkit", &config).await;
    let generated = binding.ensure_authorization_url(true).await.unwrap();
    let parsed = reqwest::Url::parse(&generated).unwrap();
    let scope = parsed
        .query_pairs()
        .find_map(|(key, value)| (key == "scope").then(|| value.into_owned()));
    assert_eq!(scope.as_deref(), Some("openid email"));
}

#[tokio::test]
async fn callback_allows_partial_configured_scope_response_without_challenge_requirements() {
    let _env = TokenEnv::new("productkit-partial-scope-callback");
    let server = TestHttpServer::spawn(
        ResponseSpec::json(
            HttpStatus::OK,
            json!({
                "access_token":"callback-token",
                "token_type":"Bearer",
                "expires_in":3600,
                "refresh_token":"refresh-2",
                "scope":"email"
            }),
        ),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;
    let mut config = base_config(&server.base_url);
    config.oauth = Some(json!({
        "type": "non-dcr",
        "authorization_endpoint": format!("{}/authorize", server.base_url),
        "token_endpoint": format!("{}/token", server.base_url),
        "registration_endpoint": format!("{}/register", server.base_url),
        "resource": format!("{}/mcp", server.base_url),
        "scope": "openid email",
        "credentials_source": {
            "type": "inline",
            "client_id": "client-id",
            "client_secret": "client-secret"
        }
    }));

    let (binding, _) = binding_for("productkit-callback", &config).await;
    let callback_url = binding.ensure_authorization_url(true).await.unwrap();
    let callback_state = reqwest::Url::parse(&callback_url)
        .unwrap()
        .query_pairs()
        .find(|(key, _)| key == "state")
        .map(|(_, value)| value.to_string())
        .unwrap();

    binding
        .handle_callback("auth-code", &callback_state)
        .await
        .unwrap();

    let stored = binding.token_store.load_token_file().unwrap().unwrap();
    assert_eq!(stored.access_token, "callback-token");
    assert_eq!(stored.scope.as_deref(), Some("email"));
}

#[tokio::test]
async fn callback_allows_productkit_oidc_challenge_scopes_without_access_token_echo() {
    let _env = TokenEnv::new("productkit-oidc-scope-callback");
    let server = TestHttpServer::spawn(
        ResponseSpec::json(
            HttpStatus::OK,
            json!({
                "access_token":"callback-token",
                "token_type":"Bearer",
                "expires_in":3600,
                "refresh_token":"refresh-token",
                "scope":"email offline_access"
            }),
        ),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;
    let (binding, _) =
        binding_for("productkit-oidc-callback", &base_config(&server.base_url)).await;
    binding
        .apply_discovery(OAuthDiscovery {
            metadata: Some(static_metadata(&server.base_url)),
            challenge_scopes: vec![
                "openid".to_string(),
                "email".to_string(),
                "offline_access".to_string(),
            ],
            ..Default::default()
        })
        .await
        .unwrap();

    let callback_url = binding.ensure_authorization_url(true).await.unwrap();
    let parsed = reqwest::Url::parse(&callback_url).unwrap();
    let requested_scope = parsed
        .query_pairs()
        .find_map(|(key, value)| (key == "scope").then(|| value.into_owned()))
        .unwrap();
    assert_eq!(requested_scope, "openid email offline_access");
    let callback_state = parsed
        .query_pairs()
        .find_map(|(key, value)| (key == "state").then(|| value.into_owned()))
        .unwrap();

    binding
        .handle_callback("auth-code", &callback_state)
        .await
        .unwrap();

    let stored = binding.token_store.load_token_file().unwrap().unwrap();
    assert_eq!(stored.access_token, "callback-token");
    assert_eq!(stored.scope.as_deref(), Some("email offline_access"));
}

#[tokio::test]
async fn callback_rejects_under_scoped_resource_token_response() {
    let _env = TokenEnv::new("callback-resource-scope-reject");
    let server = TestHttpServer::spawn(
        ResponseSpec::json(
            HttpStatus::OK,
            json!({
                "access_token":"callback-token",
                "token_type":"Bearer",
                "expires_in":3600,
                "refresh_token":"refresh-token",
                "scope":"email offline_access"
            }),
        ),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;
    let (binding, _) = binding_for("resource-scope-callback", &base_config(&server.base_url)).await;
    binding
        .apply_discovery(OAuthDiscovery {
            metadata: Some(static_metadata(&server.base_url)),
            challenge_scopes: vec![
                "openid".to_string(),
                "offline_access".to_string(),
                "workforce.product.read".to_string(),
            ],
            ..Default::default()
        })
        .await
        .unwrap();

    let callback_url = binding.ensure_authorization_url(true).await.unwrap();
    let parsed = reqwest::Url::parse(&callback_url).unwrap();
    let requested_scope = parsed
        .query_pairs()
        .find_map(|(key, value)| (key == "scope").then(|| value.into_owned()))
        .unwrap();
    assert_eq!(
        requested_scope,
        "openid offline_access workforce.product.read"
    );
    let callback_state = parsed
        .query_pairs()
        .find_map(|(key, value)| (key == "state").then(|| value.into_owned()))
        .unwrap();

    let error = binding
        .handle_callback("auth-code", &callback_state)
        .await
        .unwrap_err();
    assert!(error
        .to_string()
        .contains("token response missing required scopes: workforce.product.read"));
    assert!(server.request("/token").body.contains("resource="));
    assert!(binding.token_store.load_token_file().unwrap().is_none());
}

#[tokio::test]
async fn non_dcr_without_credentials_source_fails_fast_before_registration() {
    let _env = TokenEnv::new("non-dcr-missing-credentials");
    let server = TestHttpServer::spawn(
        ResponseSpec::json(HttpStatus::OK, json!({"access_token":"new-token"})),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;
    let mut config = dcr_config(&server.base_url);
    config.oauth = Some(json!({
        "type": "non-dcr",
        "authorization_endpoint": format!("{}/authorize", server.base_url),
        "token_endpoint": format!("{}/token", server.base_url),
        "registration_endpoint": format!("{}/register", server.base_url),
        "resource": format!("{}/mcp", server.base_url),
        "scope": "openid email"
    }));

    let (binding, _) = binding_for("productkit-missing-creds", &config).await;
    let error = binding
        .ensure_client_info(&static_metadata(&server.base_url))
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("OAuth type 'non-dcr' requires credentials_source"));
    assert!(server
        .requests()
        .iter()
        .all(|request| request.path != "/register"));
}

#[tokio::test]
async fn non_dcr_public_clients_skip_registration_and_use_none_auth_method() {
    let _env = TokenEnv::new("non-dcr-public-client");
    let server = TestHttpServer::spawn(
        ResponseSpec::json(HttpStatus::OK, json!({"access_token":"new-token"})),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;
    let mut config = dcr_config(&server.base_url);
    config.oauth = Some(json!({
        "type": "non-dcr",
        "authorization_endpoint": format!("{}/authorize", server.base_url),
        "token_endpoint": format!("{}/token", server.base_url),
        "registration_endpoint": format!("{}/register", server.base_url),
        "resource": format!("{}/mcp", server.base_url),
        "scope": "openid email",
        "credentials_source": {
            "type": "inline",
            "client_id": "public-client-id"
        }
    }));

    let (binding, _) = binding_for("productkit-public-client", &config).await;
    let client_info = binding
        .ensure_client_info(&static_metadata(&server.base_url))
        .await
        .unwrap();
    assert_eq!(client_info.client_id, "public-client-id");
    assert_eq!(client_info.client_secret, None);
    assert_eq!(
        client_info.token_endpoint_auth_method.as_deref(),
        Some("none")
    );
    assert!(server
        .requests()
        .iter()
        .all(|request| request.path != "/register"));
}

#[tokio::test]
async fn direct_client_id_shorthand_skips_dynamic_registration() {
    let _env = TokenEnv::new("direct-client-id-shorthand");
    let server = TestHttpServer::spawn(
        ResponseSpec::json(HttpStatus::OK, json!({"access_token":"new-token"})),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;
    let mut config = dcr_config(&server.base_url);
    config.oauth = Some(json!({
        "authorization_endpoint": format!("{}/authorize", server.base_url),
        "token_endpoint": format!("{}/token", server.base_url),
        "resource": format!("{}/mcp", server.base_url),
        "scope_parameter_name": "user_scope",
        "scopes": ["channels:read", "channels:history"],
        "client_id": "2317524819.11152506261415"
    }));

    let (binding, _) = binding_for("slack-shorthand", &config).await;
    let authorization_url = binding.ensure_authorization_url(true).await.unwrap();
    let stored_client_info = binding.token_store.load_client_info().unwrap().unwrap();
    assert_eq!(stored_client_info.client_id, "2317524819.11152506261415");
    assert_eq!(
        stored_client_info.token_endpoint_auth_method.as_deref(),
        Some("none")
    );
    assert!(server
        .requests()
        .iter()
        .all(|request| request.path != "/register"));

    let parsed = reqwest::Url::parse(&authorization_url).unwrap();
    let query = parsed
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<HashMap<_, _>>();
    assert_eq!(
        query.get("client_id").map(String::as_str),
        Some("2317524819.11152506261415")
    );
    assert_eq!(
        query.get("user_scope").map(String::as_str),
        Some("channels:read channels:history")
    );
}

#[tokio::test]
async fn slack_pkce_public_client_never_sends_client_secret() {
    let _env = TokenEnv::new("slack-pkce-public-client");
    let server = TestHttpServer::spawn(
        ResponseSpec::json(
            HttpStatus::OK,
            json!({
                "ok": true,
                "authed_user": {
                    "access_token":"slack-token",
                    "token_type":"user",
                    "expires_in":43200,
                    "refresh_token":"slack-refresh",
                    "scope":"channels:read channels:history"
                }
            }),
        ),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;
    let mut config = dcr_config(&server.base_url);
    config.oauth = Some(json!({
        "type": "non-dcr",
        "authorization_endpoint": format!("{}/authorize", server.base_url),
        "token_endpoint": format!("{}/token", server.base_url),
        "resource": format!("{}/mcp", server.base_url),
        "scope_parameter_name": "user_scope",
        "scopes": ["channels:read", "channels:history"],
        "credentials_source": {
            "type": "inline",
            "client_id": "2317524819.11152506261415"
        }
    }));

    let (binding, _) = binding_for("slack", &config).await;
    binding
        .token_store
        .save_client_info(&CompatClientInfo {
            client_id: "2317524819.11152506261415".to_string(),
            client_secret: Some("legacy-confidential-secret".to_string()),
            token_endpoint_auth_method: Some("client_secret_post".to_string()),
            redirect_uris: vec!["https://localhost:3838/callback".to_string()],
            ..Default::default()
        })
        .unwrap();
    binding
        .token_store
        .save_token_file(&CompatTokenFile {
            access_token: "legacy-token".to_string(),
            token_type: Some("Bearer".to_string()),
            expires_in: Some(3600),
            refresh_token: Some("legacy-refresh".to_string()),
            scope: Some("channels:read channels:history".to_string()),
            extra: Default::default(),
        })
        .unwrap();

    let authorization_url = binding.ensure_authorization_url(true).await.unwrap();
    let stored_client_info = binding.token_store.load_client_info().unwrap().unwrap();
    assert_eq!(stored_client_info.client_secret, None);
    assert_eq!(
        stored_client_info.token_endpoint_auth_method.as_deref(),
        Some("none")
    );
    assert!(binding.token_store.load_token_file().unwrap().is_none());

    let parsed = reqwest::Url::parse(&authorization_url).unwrap();
    let query = parsed
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<HashMap<_, _>>();
    assert_eq!(
        query.get("client_id").map(String::as_str),
        Some("2317524819.11152506261415")
    );
    assert_eq!(
        query.get("redirect_uri").map(String::as_str),
        Some("http://localhost:3834/callback")
    );
    assert_eq!(
        query.get("user_scope").map(String::as_str),
        Some("channels:read channels:history")
    );
    assert!(!query.contains_key("scope"));
    assert!(query.get("code_challenge").is_some());
    assert_eq!(
        query.get("code_challenge_method").map(String::as_str),
        Some("S256")
    );
    let state = query.get("state").unwrap().clone();

    binding.handle_callback("auth-code", &state).await.unwrap();
    let code_request = server.request("/token");
    assert!(code_request
        .body
        .contains("client_id=2317524819.11152506261415"));
    assert!(code_request.body.contains("code=auth-code"));
    assert!(code_request.body.contains("code_verifier="));
    assert!(!code_request.body.contains("client_secret"));
    let stored_token = binding.token_store.load_token_file().unwrap().unwrap();
    assert_eq!(stored_token.access_token, "slack-token");
    assert_eq!(stored_token.expires_in, Some(43200));
    assert_eq!(stored_token.refresh_token.as_deref(), Some("slack-refresh"));
    let stored_status = binding
        .token_store
        .load_status(
            binding.oauth_config(),
            &["channels:read".to_string(), "channels:history".to_string()],
        )
        .unwrap()
        .unwrap();
    assert!(stored_status.can_refresh);

    let refresh_status = crate::oauth::storage::TokenStatus {
        token: CompatTokenFile {
            access_token: jwt(
                json!({"exp": past_exp(), "aud": format!("{}/mcp", server.base_url)}),
            ),
            token_type: Some("Bearer".to_string()),
            expires_in: Some(1),
            refresh_token: Some("slack-refresh".to_string()),
            scope: Some("channels:read channels:history".to_string()),
            extra: Default::default(),
        },
        client_info: CompatClientInfo {
            client_id: "2317524819.11152506261415".to_string(),
            token_endpoint_auth_method: Some("none".to_string()),
            ..Default::default()
        },
        expires_in: Some(1),
        is_expired: true,
        audience_mismatch: false,
        scope_mismatch: false,
        can_refresh: true,
    };

    let refreshed = binding.refresh_access_token(&refresh_status).await.unwrap();
    assert_eq!(refreshed.access_token, "slack-token");
    assert_eq!(refreshed.expires_in, Some(43200));
    assert_eq!(refreshed.refresh_token.as_deref(), Some("slack-refresh"));
    let refresh_request = server.request("/token");
    assert!(refresh_request.body.contains("grant_type=refresh_token"));
    assert!(refresh_request
        .body
        .contains("client_id=2317524819.11152506261415"));
    assert!(!refresh_request.body.contains("client_secret"));
    assert!(!refresh_request.body.contains("code_verifier"));
}

#[tokio::test]
async fn dcr_retries_without_scope_when_explicit_scope_metadata_is_rejected() {
    let _env = TokenEnv::new("dcr-scope-retry-success");
    let server = TestHttpServer::spawn_with_scope_rejection(
        ResponseSpec::json(HttpStatus::OK, json!({"access_token":"new-token"})),
        ResponseSpec::json(
            HttpStatus::OK,
            json!({
                "client_id":"retry-client",
                "redirect_uris": [],
                "grant_types": [],
                "response_types": []
            }),
        ),
        Some(ResponseSpec::json(
            HttpStatus::BAD_REQUEST,
            json!({
                "error":"invalid_client_metadata",
                "error_description":"Requested scopes are invalid or not supported"
            }),
        )),
    )
    .await;
    let mut config = dcr_config(&server.base_url);
    config.oauth = Some(json!({
        "authorization_endpoint": format!("{}/authorize", server.base_url),
        "token_endpoint": format!("{}/token", server.base_url),
        "registration_endpoint": format!("{}/register", server.base_url),
        "resource": format!("{}/mcp", server.base_url),
        "scope": "openid email"
    }));

    let (binding, _) = binding_for("productkit-dcr-retry", &config).await;
    let client_info = binding
        .ensure_client_info(&static_metadata(&server.base_url))
        .await
        .unwrap();

    assert_eq!(client_info.client_id, "retry-client");
    assert_eq!(client_info.scope.as_deref(), Some("openid email"));

    let requests = server.requests();
    let register_requests = requests
        .iter()
        .filter(|request| request.path == "/register")
        .collect::<Vec<_>>();
    assert_eq!(register_requests.len(), 2);
    assert!(register_requests[0]
        .body
        .contains("\"scope\":\"openid email\""));
    assert!(!register_requests[1].body.contains("\"scope\""));
}

#[tokio::test]
async fn dcr_retry_without_scope_surfaces_retry_failure() {
    let _env = TokenEnv::new("dcr-scope-retry-failure");
    let server = TestHttpServer::spawn_with_scope_rejection(
        ResponseSpec::json(HttpStatus::OK, json!({"access_token":"new-token"})),
        ResponseSpec::json(
            HttpStatus::BAD_REQUEST,
            json!({
                "error":"invalid_client_metadata",
                "error_description":"retry still failed"
            }),
        ),
        Some(ResponseSpec::json(
            HttpStatus::BAD_REQUEST,
            json!({
                "error":"invalid_client_metadata",
                "error_description":"Requested scopes are invalid or not supported"
            }),
        )),
    )
    .await;
    let mut config = dcr_config(&server.base_url);
    config.oauth = Some(json!({
        "authorization_endpoint": format!("{}/authorize", server.base_url),
        "token_endpoint": format!("{}/token", server.base_url),
        "registration_endpoint": format!("{}/register", server.base_url),
        "resource": format!("{}/mcp", server.base_url),
        "scope": "openid email"
    }));

    let (binding, _) = binding_for("productkit-dcr-retry-failure", &config).await;
    let error = binding
        .ensure_client_info(&static_metadata(&server.base_url))
        .await
        .unwrap_err()
        .to_string();

    assert!(error.contains("dynamic client registration failed with HTTP 400 Bad Request"));
    assert!(error.contains("retry still failed"));

    let requests = server.requests();
    let register_requests = requests
        .iter()
        .filter(|request| request.path == "/register")
        .collect::<Vec<_>>();
    assert_eq!(register_requests.len(), 2);
    assert!(register_requests[0]
        .body
        .contains("\"scope\":\"openid email\""));
    assert!(!register_requests[1].body.contains("\"scope\""));
}

#[tokio::test]
async fn metadata_and_client_info_cover_static_inline_saved_and_dcr_paths() {
    let _env = TokenEnv::new("metadata-client-info");
    let server = TestHttpServer::spawn(
        ResponseSpec::json(HttpStatus::OK, json!({"access_token":"new-token"})),
        ResponseSpec::json(
            HttpStatus::OK,
            json!({
                "client_id":"dcr-client",
                "redirect_uris": [],
                "grant_types": [],
                "response_types": []
            }),
        ),
    )
    .await;

    let (binding, _) = binding_for("inline", &base_config(&server.base_url)).await;
    let metadata = binding.ensure_metadata().await.unwrap();
    assert_eq!(
        metadata.authorization_endpoint,
        format!("{}/authorize", server.base_url)
    );
    let inline = binding.ensure_client_info(&metadata).await.unwrap();
    assert_eq!(inline.client_id, "client-id");
    assert_eq!(
        binding
            .token_store
            .load_client_info()
            .unwrap()
            .unwrap()
            .client_id,
        "client-id"
    );

    binding
        .token_store
        .save_client_info(&CompatClientInfo {
            client_id: "saved-client".to_string(),
            ..Default::default()
        })
        .unwrap();
    let saved = binding.ensure_client_info(&metadata).await.unwrap();
    assert_eq!(saved.client_id, "client-id");
    assert_eq!(
        binding
            .token_store
            .load_client_info()
            .unwrap()
            .unwrap()
            .client_id,
        "client-id"
    );

    let (cached_dcr_binding, _) = binding_for("dcr-saved", &dcr_config(&server.base_url)).await;
    cached_dcr_binding
        .token_store
        .save_client_info(&CompatClientInfo {
            client_id: "saved-client".to_string(),
            ..Default::default()
        })
        .unwrap();
    let cached_dcr_metadata = cached_dcr_binding.ensure_metadata().await.unwrap();
    let saved = cached_dcr_binding
        .ensure_client_info(&cached_dcr_metadata)
        .await
        .unwrap();
    assert_eq!(saved.client_id, "saved-client");

    let (dcr_binding, _) = binding_for("dcr", &dcr_config(&server.base_url)).await;
    let dcr_metadata = dcr_binding.ensure_metadata().await.unwrap();
    let dcr_info = dcr_binding.ensure_client_info(&dcr_metadata).await.unwrap();
    assert_eq!(dcr_info.client_id, "dcr-client");
    assert_eq!(dcr_info.token_endpoint_auth_method.as_deref(), Some("none"));
    assert!(dcr_info
        .redirect_uris
        .iter()
        .any(|uri| uri.contains("3834")));
    assert!(server
        .request("/register")
        .body
        .contains("authorization_code"));
}

#[test]
fn build_client_info_from_credentials_marks_public_and_confidential_clients() {
    let oauth_config = OAuthConfig::from_value(&json!({
        "scope": "openid email"
    }))
    .unwrap();

    let public = build_client_info_from_credentials(
        &oauth_config,
        LoadedCredentials {
            client_id: "public-client".to_string(),
            client_secret: None,
            scopes: Vec::new(),
        },
    );
    assert_eq!(public.token_endpoint_auth_method.as_deref(), Some("none"));
    assert_eq!(public.scope.as_deref(), Some("openid email"));

    let confidential = build_client_info_from_credentials(
        &oauth_config,
        LoadedCredentials {
            client_id: "confidential-client".to_string(),
            client_secret: Some("secret".to_string()),
            scopes: Vec::new(),
        },
    );
    assert_eq!(
        confidential.token_endpoint_auth_method.as_deref(),
        Some("client_secret_post")
    );
    assert_eq!(confidential.scope.as_deref(), Some("openid email"));
}

#[tokio::test]
async fn google_server_url_exposes_static_metadata_fallback() {
    let _env = TokenEnv::new("google-metadata-fallback");
    let config = ServerConfig {
        server_type: Some("streamable-http".to_string()),
        url: Some("http://127.0.0.1:8080/mcp/".to_string()),
        command: None,
        args: Vec::new(),
        env: BTreeMap::new(),
        sensitive_env_vars: Vec::new(),
        oauth: Some(json!({
            "server_url": "https://accounts.google.com",
            "scopes": ["openid", "https://www.googleapis.com/auth/calendar"],
            "credentials_source": {
                "type": "inline",
                "client_id": "client-id",
                "client_secret": "client-secret"
            }
        })),
        headers: None,
        disabled_tools: Vec::new(),
        tool_rename_mapping: BTreeMap::new(),
        tool_call_timeout: None,
        client_header_forwarding: None,
        http_subprocess: None,
        extra: BTreeMap::new(),
    };
    let (binding, _) = binding_for("google_workspace", &config).await;

    let metadata = binding.fallback_metadata().unwrap();
    assert_eq!(
        metadata.authorization_endpoint,
        "https://accounts.google.com/o/oauth2/v2/auth"
    );
    assert_eq!(
        metadata.token_endpoint,
        "https://oauth2.googleapis.com/token"
    );
    assert_eq!(
        metadata.scopes_supported,
        Some(vec![
            "openid".to_string(),
            "https://www.googleapis.com/auth/calendar".to_string()
        ])
    );
}

#[tokio::test]
async fn discover_metadata_scope_selection_prefers_challenge_then_config_then_metadata() {
    let _env = TokenEnv::new("discover");
    let server = TestHttpServer::spawn(
        ResponseSpec::json(HttpStatus::OK, json!({"access_token":"new-token"})),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;
    let mut config = base_config(&server.base_url);
    config.oauth = Some(json!({
        "resource": format!("{}/mcp", server.base_url),
        "authorization_server": server.base_url
    }));
    let (binding, _) = binding_for("discover", &config).await;
    let error = binding.discover_metadata().await.unwrap_err();
    assert!(error
        .to_string()
        .contains("failed to discover OAuth metadata"));

    let metadata = static_metadata(&server.base_url);
    let from_client = binding.request_scopes(
        &metadata,
        &CompatClientInfo {
            client_id: "client".to_string(),
            scope: Some("scope-a scope-b".to_string()),
            ..Default::default()
        },
    );
    assert_eq!(
        from_client,
        vec!["openid".to_string(), "offline_access".to_string()]
    );
    let from_metadata = binding.request_scopes(
        &AuthorizationMetadata {
            scopes_supported: Some(vec!["scope-c".to_string()]),
            ..static_metadata(&server.base_url)
        },
        &CompatClientInfo {
            client_id: "client".to_string(),
            ..Default::default()
        },
    );
    assert_eq!(from_metadata, vec!["scope-c".to_string()]);

    binding
        .apply_discovery(OAuthDiscovery {
            challenge_scopes: vec!["scope-d".to_string(), "scope-e".to_string()],
            ..Default::default()
        })
        .await
        .unwrap();
    let from_challenge = binding.request_scopes(
        &AuthorizationMetadata {
            scopes_supported: Some(vec!["scope-f".to_string()]),
            ..static_metadata(&server.base_url)
        },
        &CompatClientInfo {
            client_id: "client".to_string(),
            scope: Some("scope-a scope-b".to_string()),
            ..Default::default()
        },
    );
    assert_eq!(
        from_challenge,
        vec!["scope-d".to_string(), "scope-e".to_string()]
    );
}

#[tokio::test]
async fn public_non_dcr_requests_advertised_offline_access() {
    let _env = TokenEnv::new("public-non-dcr-offline-access");
    let server = TestHttpServer::spawn(
        ResponseSpec::json(HttpStatus::OK, json!({"access_token":"unused"})),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;
    let mut config = base_config(&server.base_url);
    config.oauth = Some(json!({
        "type": "non-dcr",
        "authorization_endpoint": format!("{}/authorize", server.base_url),
        "token_endpoint": format!("{}/token", server.base_url),
        "resource": format!("{}/mcp", server.base_url),
        "scopes": ["resource.read"],
        "credentials_source": {
            "type": "inline",
            "client_id": "public-client"
        }
    }));
    let (binding, _) = binding_for("public-non-dcr", &config).await;
    let metadata = AuthorizationMetadata {
        scopes_supported: Some(vec![
            "resource.read".to_string(),
            "offline_access".to_string(),
        ]),
        ..static_metadata(&server.base_url)
    };

    let public_scopes = binding.request_scopes(
        &metadata,
        &CompatClientInfo {
            client_id: "public-client".to_string(),
            token_endpoint_auth_method: Some("none".to_string()),
            ..Default::default()
        },
    );
    assert_eq!(
        public_scopes,
        vec!["resource.read".to_string(), "offline_access".to_string()]
    );

    let confidential_scopes = binding.request_scopes(
        &metadata,
        &CompatClientInfo {
            client_id: "confidential-client".to_string(),
            client_secret: Some("secret".to_string()),
            token_endpoint_auth_method: Some("client_secret_post".to_string()),
            ..Default::default()
        },
    );
    assert_eq!(confidential_scopes, vec!["resource.read".to_string()]);
}

#[tokio::test]
async fn refresh_allows_metadata_only_scopes_without_token_validation() {
    let _env = TokenEnv::new("refresh-metadata-scope-fallback");
    let server = TestHttpServer::spawn(
        ResponseSpec::json(
            HttpStatus::OK,
            json!({
                "access_token":"refreshed-token",
                "token_type":"Bearer",
                "expires_in":3600,
                "scope":"offline_access"
            }),
        ),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;
    let config = ServerConfig {
        server_type: Some("streamable-http".to_string()),
        url: Some(format!("{}/mcp", server.base_url)),
        command: None,
        args: Vec::new(),
        env: BTreeMap::new(),
        sensitive_env_vars: Vec::new(),
        oauth: Some(json!({
            "authorization_endpoint": format!("{}/authorize", server.base_url),
            "token_endpoint": format!("{}/token", server.base_url),
            "registration_endpoint": format!("{}/register", server.base_url),
            "resource": format!("{}/mcp", server.base_url)
        })),
        headers: None,
        disabled_tools: Vec::new(),
        tool_rename_mapping: BTreeMap::new(),
        tool_call_timeout: None,
        client_header_forwarding: None,
        http_subprocess: None,
        extra: BTreeMap::new(),
    };
    let (binding, _) = binding_for("metadata-scope-refresh-reject", &config).await;
    binding
        .apply_discovery(OAuthDiscovery {
            metadata: Some(AuthorizationMetadata {
                scopes_supported: Some(vec!["offline_access".to_string(), "scope-a".to_string()]),
                ..static_metadata(&server.base_url)
            }),
            ..Default::default()
        })
        .await
        .unwrap();
    let refresh_status = crate::oauth::storage::TokenStatus {
        token: CompatTokenFile {
            access_token: jwt(
                json!({"exp": past_exp(), "aud": format!("{}/mcp", server.base_url)}),
            ),
            token_type: Some("Bearer".to_string()),
            expires_in: Some(1),
            refresh_token: Some("refresh-token".to_string()),
            scope: Some("offline_access scope-a".to_string()),
            extra: Default::default(),
        },
        client_info: CompatClientInfo {
            client_id: "client-id".to_string(),
            token_endpoint_auth_method: Some("none".to_string()),
            ..Default::default()
        },
        expires_in: Some(1),
        is_expired: true,
        audience_mismatch: false,
        scope_mismatch: false,
        can_refresh: true,
    };

    let refreshed = binding.refresh_access_token(&refresh_status).await.unwrap();
    assert_eq!(refreshed.access_token, "refreshed-token");
    assert_eq!(refreshed.scope.as_deref(), Some("offline_access"));
    assert!(server.request("/token").body.contains("resource="));
    assert!(!server.request("/token").body.contains("scope="));
    assert_eq!(
        binding
            .token_store
            .load_token_file()
            .unwrap()
            .unwrap()
            .access_token,
        "refreshed-token"
    );
}

#[tokio::test]
async fn refresh_rejects_sibling_resource_audience_before_persisting() {
    let _env = TokenEnv::new("refresh-sibling-audience");
    let refreshed_access_token = jwt(json!({
        "exp": future_exp(),
        "aud": "https://resource.example.test/api/other"
    }));
    let server = TestHttpServer::spawn(
        ResponseSpec::json(
            HttpStatus::OK,
            json!({
                "access_token": refreshed_access_token,
                "token_type": "Bearer",
                "expires_in": 3600
            }),
        ),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;
    let mut config = base_config(&server.base_url);
    config.oauth = Some(json!({
        "type": "non-dcr",
        "authorization_endpoint": format!("{}/authorize", server.base_url),
        "token_endpoint": format!("{}/token", server.base_url),
        "resource": "https://resource.example.test/api/tenant",
        "credentials_source": {
            "type": "inline",
            "client_id": "public-client"
        }
    }));
    let (binding, _) = binding_for("refresh-sibling-audience", &config).await;
    let client_info = CompatClientInfo {
        client_id: "public-client".to_string(),
        token_endpoint_auth_method: Some("none".to_string()),
        ..Default::default()
    };
    let old_token = CompatTokenFile {
        access_token: "old-token".to_string(),
        token_type: Some("Bearer".to_string()),
        expires_in: Some(1),
        refresh_token: Some("refresh-token".to_string()),
        scope: None,
        extra: Default::default(),
    };
    binding.token_store.save_client_info(&client_info).unwrap();
    binding.token_store.save_token_file(&old_token).unwrap();
    let refresh_status = crate::oauth::storage::TokenStatus {
        token: old_token,
        client_info,
        expires_in: Some(1),
        is_expired: true,
        audience_mismatch: false,
        scope_mismatch: false,
        can_refresh: true,
    };

    let error = binding
        .refresh_access_token(&refresh_status)
        .await
        .unwrap_err();
    assert!(error
        .to_string()
        .contains("audience does not match the configured OAuth resource"));
    assert_eq!(
        binding
            .token_store
            .load_token_file()
            .unwrap()
            .unwrap()
            .access_token,
        "old-token"
    );
}

#[tokio::test]
async fn refresh_accepts_authorization_server_abstract_audience_mapping() {
    let _env = TokenEnv::new("refresh-abstract-audience");
    let refreshed_access_token = jwt(json!({
        "exp": future_exp(),
        "aud": [
            "https://auth.example.test/tenants/example/resources",
            "public_api"
        ]
    }));
    let server = TestHttpServer::spawn(
        ResponseSpec::json(
            HttpStatus::OK,
            json!({
                "access_token": refreshed_access_token,
                "token_type": "Bearer",
                "expires_in": 3600
            }),
        ),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;
    let mut config = base_config(&server.base_url);
    config.oauth = Some(json!({
        "type": "non-dcr",
        "authorization_endpoint": format!("{}/authorize", server.base_url),
        "token_endpoint": format!("{}/token", server.base_url),
        "resource": "https://mcp.example.test/v1/tenants/example",
        "credentials_source": {
            "type": "inline",
            "client_id": "public-client"
        }
    }));
    let (binding, _) = binding_for("refresh-abstract-audience", &config).await;
    let client_info = CompatClientInfo {
        client_id: "public-client".to_string(),
        token_endpoint_auth_method: Some("none".to_string()),
        ..Default::default()
    };
    let old_token = CompatTokenFile {
        access_token: "old-token".to_string(),
        token_type: Some("Bearer".to_string()),
        expires_in: Some(1),
        refresh_token: Some("refresh-token".to_string()),
        scope: None,
        extra: Default::default(),
    };
    binding.token_store.save_client_info(&client_info).unwrap();
    binding.token_store.save_token_file(&old_token).unwrap();
    let refresh_status = crate::oauth::storage::TokenStatus {
        token: old_token,
        client_info,
        expires_in: Some(1),
        is_expired: true,
        audience_mismatch: false,
        scope_mismatch: false,
        can_refresh: true,
    };

    let refreshed = binding.refresh_access_token(&refresh_status).await.unwrap();
    assert_eq!(
        binding
            .token_store
            .load_token_file()
            .unwrap()
            .unwrap()
            .access_token,
        refreshed.access_token
    );
}

#[tokio::test]
async fn protected_resource_scopes_do_not_invalidate_stored_tokens() {
    let _env = TokenEnv::new("protected-resource-request-scopes");
    let server = TestHttpServer::spawn(
        ResponseSpec::json(
            HttpStatus::OK,
            json!({
                "access_token": "new-token",
                "scope": "offline_access workforce.trust_and_safety.read"
            }),
        ),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;
    let mut config = base_config(&server.base_url);
    config.oauth = Some(json!({
        "type": "non-dcr",
        "authorization_endpoint": format!("{}/authorize", server.base_url),
        "token_endpoint": format!("{}/token", server.base_url),
        "resource": format!("{}/mcp", server.base_url),
        "credentials_source": {
            "type": "inline",
            "client_id": "client-id",
            "client_secret": "client-secret"
        }
    }));
    let (binding, _) = binding_for("trust-kit-scope-check", &config).await;
    binding
        .token_store
        .save_client_info(&CompatClientInfo {
            client_id: "client-id".to_string(),
            client_secret: Some("client-secret".to_string()),
            token_endpoint_auth_method: Some("client_secret_post".to_string()),
            ..Default::default()
        })
        .unwrap();
    binding
        .token_store
        .save_token_file(&CompatTokenFile {
            access_token: jwt(json!({
                "exp": future_exp(),
                "aud": format!("{}/mcp", server.base_url)
            })),
            token_type: Some("Bearer".to_string()),
            refresh_token: Some("refresh-token".to_string()),
            expires_in: Some(3600),
            scope: Some("offline_access".to_string()),
            extra: Default::default(),
        })
        .unwrap();
    let stored_access_token = binding
        .token_store
        .load_token_file()
        .unwrap()
        .unwrap()
        .access_token;

    assert!(
        binding.has_usable_tokens().await.unwrap(),
        "token should be usable before protected-resource scopes are discovered"
    );

    binding
        .apply_discovery(OAuthDiscovery {
            protected_resource_scopes: vec![
                "offline_access".to_string(),
                "workforce.trust_and_safety.read".to_string(),
            ],
            ..Default::default()
        })
        .await
        .unwrap();

    assert!(
        binding.has_usable_tokens().await.unwrap(),
        "protected-resource scopes are request hints, not token validation requirements"
    );
    assert_eq!(
        binding.access_token().await.unwrap().as_deref(),
        Some(stored_access_token.as_str())
    );
    assert!(server.requests().is_empty());
}

#[tokio::test]
async fn data_platform_configured_scopes_override_protected_resource_scope_hints() {
    let _env = TokenEnv::new("data-platform-prm-scope-hints");
    let server = TestHttpServer::spawn(
        ResponseSpec::json(
            HttpStatus::OK,
            json!({
                "access_token":"callback-token",
                "token_type":"Bearer",
                "expires_in":3600,
                "refresh_token":"refresh-token",
                "scope":"offline_access"
            }),
        ),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"dynamic-client"})),
    )
    .await;
    let configured_scope = "workforce.data_platform.data_asset_metadata.read workforce.data_platform.idash_workspace.write workforce.data_platform.idash_workspace.read workforce.data_platform.query.execute workforce.data_platform.query.generate offline_access";
    let resource_url = format!("{}/mcp", server.base_url);
    let config = ServerConfig {
        server_type: Some("streamable-http".to_string()),
        url: Some(resource_url.clone()),
        command: None,
        args: Vec::new(),
        env: BTreeMap::new(),
        sensitive_env_vars: Vec::new(),
        oauth: Some(json!({
            "server_url": server.base_url.clone(),
            "resource": resource_url,
            "client_metadata": {
                "client_name": "Portico",
                "token_endpoint_auth_method": "none",
                "scope": configured_scope
            }
        })),
        headers: None,
        disabled_tools: Vec::new(),
        tool_rename_mapping: BTreeMap::new(),
        tool_call_timeout: None,
        client_header_forwarding: None,
        http_subprocess: None,
        extra: BTreeMap::new(),
    };
    let (binding, _) = binding_for("data-platform-prm-hints", &config).await;
    binding
        .apply_discovery(OAuthDiscovery {
            metadata: Some(static_metadata(&server.base_url)),
            protected_resource_scopes: vec![
                "offline_access".to_string(),
                "workforce.data_platform.data_asset_metadata.read".to_string(),
                "workforce.data_platform.experimentation.read".to_string(),
                "workforce.data_platform.experimentation.write".to_string(),
            ],
            ..Default::default()
        })
        .await
        .unwrap();

    let authorization_url = binding.ensure_authorization_url(true).await.unwrap();
    let parsed = reqwest::Url::parse(&authorization_url).unwrap();
    let requested_scope = parsed
        .query_pairs()
        .find_map(|(key, value)| (key == "scope").then(|| value.into_owned()))
        .unwrap();
    assert_eq!(requested_scope, configured_scope);
    assert!(!requested_scope.contains("experimentation"));
    let callback_state = parsed
        .query_pairs()
        .find_map(|(key, value)| (key == "state").then(|| value.into_owned()))
        .unwrap();

    binding
        .handle_callback("auth-code", &callback_state)
        .await
        .unwrap();

    let stored = binding.token_store.load_token_file().unwrap().unwrap();
    assert_eq!(stored.access_token, "callback-token");
    assert_eq!(stored.scope.as_deref(), Some("offline_access"));
}

#[tokio::test]
async fn trust_kit_uses_protected_resource_scopes_as_request_fallback_only() {
    let _env = TokenEnv::new("trust-kit-prm-scope-fallback");
    let server = TestHttpServer::spawn(
        ResponseSpec::json(
            HttpStatus::OK,
            json!({
                "access_token":"callback-token",
                "token_type":"Bearer",
                "expires_in":3600,
                "refresh_token":"refresh-token"
            }),
        ),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"dynamic-client"})),
    )
    .await;
    let resource_url = format!("{}/mcp", server.base_url);
    let config = ServerConfig {
        server_type: Some("streamable-http".to_string()),
        url: Some(resource_url),
        command: None,
        args: Vec::new(),
        env: BTreeMap::new(),
        sensitive_env_vars: Vec::new(),
        oauth: Some(json!({
            "server_url": server.base_url.clone()
        })),
        headers: None,
        disabled_tools: Vec::new(),
        tool_rename_mapping: BTreeMap::new(),
        tool_call_timeout: None,
        client_header_forwarding: None,
        http_subprocess: None,
        extra: BTreeMap::new(),
    };
    let (binding, _) = binding_for("trust-kit-prm-fallback", &config).await;
    binding
        .apply_discovery(OAuthDiscovery {
            metadata: Some(static_metadata(&server.base_url)),
            resource: Some(server.base_url.clone()),
            protected_resource_scopes: vec![
                "workforce.trust_and_safety.read".to_string(),
                "offline_access".to_string(),
            ],
            ..Default::default()
        })
        .await
        .unwrap();

    let authorization_url = binding.ensure_authorization_url(true).await.unwrap();
    let parsed = reqwest::Url::parse(&authorization_url).unwrap();
    let requested_scope = parsed
        .query_pairs()
        .find_map(|(key, value)| (key == "scope").then(|| value.into_owned()))
        .unwrap();
    assert_eq!(
        requested_scope,
        "workforce.trust_and_safety.read offline_access"
    );
    let requested_resource = parsed
        .query_pairs()
        .find_map(|(key, value)| (key == "resource").then(|| value.into_owned()))
        .unwrap();
    assert_eq!(requested_resource, server.base_url);
    assert!(!requested_resource.ends_with('/'));
    let callback_state = parsed
        .query_pairs()
        .find_map(|(key, value)| (key == "state").then(|| value.into_owned()))
        .unwrap();

    binding
        .handle_callback("auth-code", &callback_state)
        .await
        .unwrap();

    let stored = binding.token_store.load_token_file().unwrap().unwrap();
    assert_eq!(stored.access_token, "callback-token");
    assert_eq!(stored.scope, None);
}

#[tokio::test]
async fn discover_metadata_uses_custom_protected_resource_flow_for_explicit_oauth_servers() {
    #[derive(Clone)]
    struct DiscoveryState {
        base_url: String,
    }

    async fn discovery_handler(State(state): State<DiscoveryState>, uri: Uri) -> impl IntoResponse {
        let body = match uri.path() {
            "/.well-known/oauth-protected-resource" => json!({
                "authorization_servers": [state.base_url],
                "resource": format!("{}/mcp", state.base_url),
                "scopes_supported": ["offline_access", "scope-a"]
            }),
            "/.well-known/oauth-authorization-server" => json!({
                "authorization_endpoint": format!("{}/authorize", state.base_url),
                "token_endpoint": format!("{}/token", state.base_url),
                "registration_endpoint": format!("{}/register", state.base_url)
            }),
            _ => json!({"error": "missing"}),
        };
        let status = if body.get("error").is_some() {
            HttpStatus::NOT_FOUND
        } else {
            HttpStatus::OK
        };
        (status, Json(body))
    }

    let _env = TokenEnv::new("custom-protected-resource");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let base_url = format!("http://{}", address);
    let router = Router::new()
        .route(
            "/.well-known/oauth-protected-resource",
            get(discovery_handler),
        )
        .route(
            "/.well-known/oauth-authorization-server",
            get(discovery_handler),
        )
        .with_state(DiscoveryState {
            base_url: base_url.clone(),
        });
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });

    let resource_url = format!("{base_url}/mcp");
    let config = ServerConfig {
        server_type: Some("streamable-http".to_string()),
        url: Some(resource_url.clone()),
        command: None,
        args: Vec::new(),
        env: BTreeMap::new(),
        sensitive_env_vars: Vec::new(),
        oauth: Some(json!({
            "server_url": base_url,
            "resource": resource_url,
            "client_metadata": {
                "client_name": "Portico",
                "token_endpoint_auth_method": "none",
                "scope": "offline_access scope-a"
            }
        })),
        headers: None,
        disabled_tools: Vec::new(),
        tool_rename_mapping: BTreeMap::new(),
        tool_call_timeout: None,
        client_header_forwarding: None,
        http_subprocess: None,
        extra: BTreeMap::new(),
    };
    let (binding, _) = binding_for("data-plat-mcp", &config).await;

    let metadata = binding.ensure_metadata().await.unwrap();
    assert_eq!(
        metadata.authorization_endpoint,
        format!("{}/authorize", base_url)
    );
    assert_eq!(metadata.token_endpoint, format!("{}/token", base_url));
    let expected_resource = format!("{}/mcp", base_url);
    assert_eq!(
        binding.effective_resource().await.as_deref(),
        Some(expected_resource.as_str())
    );
    assert_eq!(
        *binding.protected_resource_scopes.read().await,
        vec!["offline_access".to_string(), "scope-a".to_string()]
    );

    task.abort();
}

#[tokio::test]
async fn preserves_authoritative_discovered_resource_with_trailing_slash() {
    let _env = TokenEnv::new("canonical-discovery");
    let config = ServerConfig {
        server_type: Some("streamable-http".to_string()),
        url: Some("https://taxo-mcp.sandbox.example.invalid/mcp/".to_string()),
        command: None,
        args: Vec::new(),
        env: BTreeMap::new(),
        sensitive_env_vars: Vec::new(),
        oauth: Some(json!({})),
        headers: None,
        disabled_tools: Vec::new(),
        tool_rename_mapping: BTreeMap::new(),
        tool_call_timeout: None,
        client_header_forwarding: None,
        http_subprocess: None,
        extra: BTreeMap::new(),
    };
    let (binding, _) = binding_for("portico-taxonomy", &config).await;

    binding
        .apply_discovery(OAuthDiscovery {
            resource: Some("https://taxo-mcp.sandbox.example.invalid/mcp/".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();

    assert_eq!(
        binding.discovered_resource.read().await.as_deref(),
        Some("https://taxo-mcp.sandbox.example.invalid/mcp/")
    );
    assert_eq!(
        binding.effective_oauth_config().await.resource.as_deref(),
        Some("https://taxo-mcp.sandbox.example.invalid/mcp/")
    );
}

#[tokio::test]
async fn persistent_unauthorized_failure_records_canonical_resource_diagnostics() {
    let _env = TokenEnv::new("persistent-unauthorized");
    let config = ServerConfig {
        server_type: Some("streamable-http".to_string()),
        url: Some("https://taxo-mcp.sandbox.example.invalid/mcp/".to_string()),
        command: None,
        args: Vec::new(),
        env: BTreeMap::new(),
        sensitive_env_vars: Vec::new(),
        oauth: Some(json!({})),
        headers: None,
        disabled_tools: Vec::new(),
        tool_rename_mapping: BTreeMap::new(),
        tool_call_timeout: None,
        client_header_forwarding: None,
        http_subprocess: None,
        extra: BTreeMap::new(),
    };
    let (binding, coordinator) = binding_for("portico-taxonomy", &config).await;
    binding
        .apply_discovery(OAuthDiscovery {
            resource: Some("https://taxo-mcp.sandbox.example.invalid/mcp/".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();
    binding
        .token_store
        .save_client_info(&CompatClientInfo {
            client_id: "client".to_string(),
            token_endpoint_auth_method: Some("none".to_string()),
            ..Default::default()
        })
        .unwrap();
    binding
        .token_store
        .save_token_file(&CompatTokenFile {
            access_token: jwt(json!({
                "exp": future_exp(),
                "aud": ["https://default.example.invalid", "https://taxo-mcp.sandbox.example.invalid/mcp/"]
            })),
            token_type: Some("Bearer".to_string()),
            expires_in: Some(3600),
            refresh_token: Some("refresh-token".to_string()),
            scope: Some("offline_access".to_string()),
            extra: Default::default(),
        })
        .unwrap();

    binding
        .mark_persistent_unauthorized_failure(
            "persistent unauthorized response from streamable-http connect after 3 OAuth refresh attempts",
            Some(
                "Bearer resource_metadata=\"https://taxo-mcp.sandbox.example.invalid/.well-known/oauth-protected-resource\"",
            ),
        )
        .await;

    assert!(binding.token_store.load_token_file().unwrap().is_none());
    let handshake = coordinator.get_handshake("portico-taxonomy").await.unwrap();
    assert_eq!(handshake.state, OAuthState::Failed);
    let error = handshake.error_message.unwrap();
    assert!(error.contains("mcp_url=https://taxo-mcp.sandbox.example.invalid/mcp"));
    assert!(error.contains("discovered_resource=https://taxo-mcp.sandbox.example.invalid/mcp/"));
    assert!(error.contains("effective_resource=https://taxo-mcp.sandbox.example.invalid/mcp/"));
    assert!(error.contains(
        "token_aud=https://default.example.invalid, https://taxo-mcp.sandbox.example.invalid/mcp/"
    ));
}

#[tokio::test]
async fn access_token_refresh_and_callback_paths_work_end_to_end() {
    let _env = TokenEnv::new("access-callback");
    let server = TestHttpServer::spawn(
        ResponseSpec::json(
            HttpStatus::OK,
            json!({"access_token":"refreshed-token","token_type":"Bearer","expires_in":3600}),
        ),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;
    let (binding, coordinator) = binding_for("glean", &base_config(&server.base_url)).await;
    binding
        .token_store
        .save_client_info(&CompatClientInfo {
            client_id: "client-id".to_string(),
            token_endpoint_auth_method: Some("none".to_string()),
            ..Default::default()
        })
        .unwrap();
    binding
        .token_store
        .save_token_file(&CompatTokenFile {
            access_token: jwt(
                json!({"exp": past_exp(), "aud": format!("{}/mcp", server.base_url)}),
            ),
            token_type: Some("Bearer".to_string()),
            expires_in: Some(1),
            refresh_token: Some("refresh-token".to_string()),
            scope: None,
            extra: Default::default(),
        })
        .unwrap();

    let access = binding.access_token().await.unwrap();
    assert_eq!(access.as_deref(), Some("refreshed-token"));
    let refresh_request = server.request("/token");
    assert!(refresh_request.body.contains("grant_type=refresh_token"));
    assert!(refresh_request.body.contains("resource="));
    assert!(!refresh_request.body.contains("scope="));
    let refreshed = binding.token_store.load_token_file().unwrap().unwrap();
    assert_eq!(refreshed.access_token, "refreshed-token");
    assert_eq!(refreshed.scope.as_deref(), None);

    let callback_server = TestHttpServer::spawn(
        ResponseSpec::json(
            HttpStatus::OK,
            json!({"access_token":"callback-token","token_type":"Bearer","expires_in":3600,"refresh_token":"refresh-2"}),
        ),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;
    let (callback_binding, _) =
        binding_for("callback", &base_config(&callback_server.base_url)).await;
    let callback_url = callback_binding
        .ensure_authorization_url(true)
        .await
        .unwrap();
    let callback_state = reqwest::Url::parse(&callback_url)
        .unwrap()
        .query_pairs()
        .find(|(key, _)| key == "state")
        .map(|(_, value)| value.to_string())
        .unwrap();
    callback_binding
        .handle_callback("auth-code", &callback_state)
        .await
        .unwrap();
    assert_eq!(
        callback_binding
            .token_store
            .load_token_file()
            .unwrap()
            .unwrap()
            .access_token,
        "callback-token"
    );
    assert_eq!(
        callback_binding
            .coordinator
            .get_handshake("callback")
            .await
            .unwrap()
            .state,
        OAuthState::Checking
    );
    assert_eq!(coordinator.current_server().await, None);

    let outcome = callback_binding
        .handle_unauthorized_header(Some("Bearer error=\"invalid_token\""))
        .await
        .unwrap();
    assert_eq!(outcome, OAuthRefreshOutcome::Refreshed);
    assert_eq!(
        callback_binding
            .coordinator
            .get_handshake("callback")
            .await
            .unwrap()
            .state,
        OAuthState::Checking
    );
}

#[tokio::test]
async fn concurrent_access_token_calls_share_one_refresh() {
    let _env = TokenEnv::new("single-flight-refresh");
    let server = TestHttpServer::spawn(
        ResponseSpec::json(
            HttpStatus::OK,
            json!({
                "access_token":"refreshed-token",
                "token_type":"Bearer",
                "expires_in":3600
            }),
        ),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;
    let (binding, _) = binding_for("single-flight-refresh", &base_config(&server.base_url)).await;
    binding
        .token_store
        .save_client_info(&CompatClientInfo {
            client_id: "client-id".to_string(),
            token_endpoint_auth_method: Some("none".to_string()),
            ..Default::default()
        })
        .unwrap();
    binding
        .token_store
        .save_token_file(&CompatTokenFile {
            access_token: jwt(json!({
                "exp": past_exp(),
                "aud": format!("{}/mcp", server.base_url)
            })),
            token_type: Some("Bearer".to_string()),
            expires_in: Some(1),
            refresh_token: Some("refresh-token".to_string()),
            scope: None,
            extra: Default::default(),
        })
        .unwrap();

    let (first, second) = tokio::join!(binding.access_token(), binding.access_token());
    assert_eq!(first.unwrap().as_deref(), Some("refreshed-token"));
    assert_eq!(second.unwrap().as_deref(), Some("refreshed-token"));
    assert_eq!(
        server
            .requests()
            .iter()
            .filter(|request| request.path == "/token")
            .count(),
        1
    );
}

#[tokio::test]
async fn url_only_broker_env_does_not_disable_durable_refresh() {
    let _env = TokenEnv::new("url-only-broker-env");
    let _broker_env = EnvVarGuard::set(&[
        (
            OAUTH_BROKER_URL_ENV,
            "http://host.docker.internal:8891/secrets/oauth/access-token".to_string(),
        ),
        (OAUTH_BROKER_SERVER_ID_ENV, "".to_string()),
        (OAUTH_BROKER_TOKEN_ENV, "".to_string()),
    ]);
    let server = TestHttpServer::spawn(
        ResponseSpec::json(
            HttpStatus::OK,
            json!({"access_token":"durable-refreshed-token","token_type":"Bearer","expires_in":3600}),
        ),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;
    let (binding, _) = binding_for("host-bridge-oauth", &base_config(&server.base_url)).await;
    assert!(!binding.uses_access_token_broker());
    binding
        .token_store
        .save_client_info(&CompatClientInfo {
            client_id: "client-id".to_string(),
            token_endpoint_auth_method: Some("none".to_string()),
            ..Default::default()
        })
        .unwrap();
    binding
        .token_store
        .save_token_file(&CompatTokenFile {
            access_token: jwt(json!({
                "exp": past_exp(),
                "aud": format!("{}/mcp", server.base_url)
            })),
            token_type: Some("Bearer".to_string()),
            expires_in: Some(1),
            refresh_token: Some("refresh-token".to_string()),
            scope: None,
            extra: Default::default(),
        })
        .unwrap();

    let access = binding.access_token().await.unwrap();

    assert_eq!(access.as_deref(), Some("durable-refreshed-token"));
    let refresh_request = server.request("/token");
    assert!(refresh_request.body.contains("grant_type=refresh_token"));
    assert!(refresh_request.body.contains("resource="));
}

#[tokio::test]
async fn partial_broker_env_with_server_id_missing_token_fails_closed() {
    let _env = TokenEnv::new("partial-broker-env");
    let server_id = "google_workspace";
    let _broker_env = EnvVarGuard::set(&[
        (
            OAUTH_BROKER_URL_ENV,
            "http://host.docker.internal:8891/secrets/oauth/access-token".to_string(),
        ),
        (OAUTH_BROKER_SERVER_ID_ENV, server_id.to_string()),
        (OAUTH_BROKER_TOKEN_ENV, "".to_string()),
    ]);
    let server = TestHttpServer::spawn(
        ResponseSpec::json(
            HttpStatus::OK,
            json!({"access_token":"should-not-refresh","token_type":"Bearer","expires_in":3600}),
        ),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;

    let error = OAuthBinding::new(
        server_id,
        &base_config(&server.base_url),
        Arc::new(OAuthCoordinator::new()),
    )
    .await
    .err()
    .unwrap();

    assert!(error
        .to_string()
        .contains("OAuth access-token broker token is not configured"));
}

#[tokio::test]
async fn broker_seeded_expired_access_token_refreshes_through_host_broker() {
    let _env = TokenEnv::new("broker-seeded-expired");
    let broker_requests = Arc::new(StdMutex::new(Vec::<Value>::new()));

    async fn broker_handler(
        State(requests): State<Arc<StdMutex<Vec<Value>>>>,
        Json(payload): Json<Value>,
    ) -> Json<Value> {
        requests.lock().unwrap().push(payload.clone());
        Json(json!({
            "server_id": payload.get("server_id").cloned().unwrap_or(Value::Null),
            "access_token": "fresh-broker-token",
            "token_type": "Bearer",
            "expires_in": 3600,
            "expires_at": future_exp(),
        }))
    }

    let broker_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let broker_addr = broker_listener.local_addr().unwrap();
    let (broker_shutdown_tx, broker_shutdown_rx) = oneshot::channel();
    let broker_app = Router::new()
        .route("/secrets/oauth/access-token", post(broker_handler))
        .with_state(Arc::clone(&broker_requests));
    let broker_join = tokio::spawn(async move {
        let _ = axum::serve(broker_listener, broker_app)
            .with_graceful_shutdown(async move {
                let _ = broker_shutdown_rx.await;
            })
            .await;
    });
    let server_id = "google_workspace";
    let _broker_env = EnvVarGuard::set(&[
        (
            OAUTH_BROKER_URL_ENV,
            format!("http://{broker_addr}/secrets/oauth/access-token"),
        ),
        (OAUTH_BROKER_SERVER_ID_ENV, server_id.to_string()),
        (OAUTH_BROKER_TOKEN_ENV, "scoped-broker-token".to_string()),
    ]);
    let config = ServerConfig {
        server_type: Some("streamable-http".to_string()),
        url: Some("http://127.0.0.1:8080/mcp".to_string()),
        command: None,
        args: Vec::new(),
        env: BTreeMap::new(),
        sensitive_env_vars: Vec::new(),
        oauth: Some(json!({
            "authorization_endpoint": "http://127.0.0.1:9999/authorize",
            "token_endpoint": "http://127.0.0.1:9999/token",
        })),
        headers: None,
        disabled_tools: Vec::new(),
        tool_rename_mapping: BTreeMap::new(),
        tool_call_timeout: None,
        client_header_forwarding: None,
        http_subprocess: None,
        extra: BTreeMap::new(),
    };
    let (binding, coordinator) = binding_for(server_id, &config).await;
    coordinator.register_handshake(server_id).await;
    coordinator.mark_completed(server_id).await;
    binding
        .seed_oauth_record(
            &CompatTokenFile {
                access_token: "expired-broker-token".to_string(),
                token_type: Some("Bearer".to_string()),
                expires_in: Some(-1),
                refresh_token: None,
                scope: None,
                extra: BTreeMap::from([("expires_at".to_string(), json!(past_exp()))]),
            },
            &CompatClientInfo {
                client_id: "host-mcp-bridge-oauth-access-token-broker".to_string(),
                token_endpoint_auth_method: Some("none".to_string()),
                ..Default::default()
            },
        )
        .unwrap();

    let access = binding.access_token().await.unwrap();

    assert_eq!(access.as_deref(), Some("fresh-broker-token"));
    let requests = broker_requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["server_id"], json!(server_id));
    assert_eq!(requests[0]["force_refresh"], json!(true));
    assert_eq!(
        requests[0]["rejected_access_token_sha256"],
        json!(oauth_access_token_sha256("expired-broker-token"))
    );
    let stored = binding.token_store.load_token_file().unwrap().unwrap();
    assert_eq!(stored.access_token, "fresh-broker-token");
    assert_eq!(stored.refresh_token, None);
    assert_eq!(
        coordinator.get_handshake(server_id).await.unwrap().state,
        OAuthState::Completed,
        "transparent broker refresh must not downgrade a healthy server to checking"
    );

    binding
        .mark_persistent_unauthorized_failure(
            "refreshed token was rejected downstream",
            Some("Bearer error=\"invalid_token\""),
        )
        .await;
    let requests = broker_requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1]["invalidate_rejected"], json!(true));
    assert_eq!(requests[1]["force_refresh"], json!(true));
    assert_eq!(
        requests[1]["rejected_access_token_sha256"],
        json!(oauth_access_token_sha256("fresh-broker-token"))
    );
    assert_eq!(
        coordinator.get_handshake(server_id).await.unwrap().state,
        OAuthState::Completed,
        "preserving a newer broker token must not downgrade lifecycle state"
    );

    let _ = broker_shutdown_tx.send(());
    let _ = broker_join.await;
}

#[tokio::test]
async fn dynamic_registration_client_scope_does_not_drive_authorization_or_callback_validation() {
    let _env = TokenEnv::new("dcr-client-scope");
    let server = TestHttpServer::spawn(
        ResponseSpec::json(
            HttpStatus::OK,
            json!({
                "access_token":"callback-token",
                "token_type":"Bearer",
                "expires_in":3600,
                "refresh_token":"refresh-2",
                "scope":"search tools"
            }),
        ),
        ResponseSpec::json(
            HttpStatus::OK,
            json!({
                "client_id":"registered-client",
                "scope":"activity agents announcements answers search tools",
                "redirect_uris":["http://localhost:3834/callback"],
                "grant_types":["authorization_code", "refresh_token"],
                "response_types":["code"],
                "token_endpoint_auth_method":"none"
            }),
        ),
    )
    .await;
    let config = ServerConfig {
        server_type: Some("streamable-http".to_string()),
        url: Some(format!("{}/mcp", server.base_url)),
        command: None,
        args: Vec::new(),
        env: BTreeMap::new(),
        sensitive_env_vars: Vec::new(),
        oauth: Some(json!({
            "authorization_endpoint": format!("{}/authorize", server.base_url),
            "token_endpoint": format!("{}/token", server.base_url),
            "registration_endpoint": format!("{}/register", server.base_url),
            "resource": format!("{}/mcp", server.base_url)
        })),
        headers: None,
        disabled_tools: Vec::new(),
        tool_rename_mapping: BTreeMap::new(),
        tool_call_timeout: None,
        client_header_forwarding: None,
        http_subprocess: None,
        extra: BTreeMap::new(),
    };
    let (binding, _) = binding_for("glean-dcr-scope", &config).await;

    let authorization_url = binding.ensure_authorization_url(true).await.unwrap();
    let parsed = reqwest::Url::parse(&authorization_url).unwrap();
    assert!(parsed.query_pairs().all(|(key, _)| key != "scope"));
    let callback_state = parsed
        .query_pairs()
        .find(|(key, _)| key == "state")
        .map(|(_, value)| value.to_string())
        .unwrap();

    binding
        .handle_callback("auth-code", &callback_state)
        .await
        .unwrap();

    let stored = binding.token_store.load_token_file().unwrap().unwrap();
    assert_eq!(stored.access_token, "callback-token");
    assert_eq!(stored.scope.as_deref(), Some("search tools"));
}

#[tokio::test]
async fn persisted_client_scope_is_not_authoritative_without_explicit_scope_configuration() {
    let _env = TokenEnv::new("persisted-client-scope");
    let server = TestHttpServer::spawn(
        ResponseSpec::json(
            HttpStatus::OK,
            json!({
                "access_token":"callback-token",
                "token_type":"Bearer",
                "expires_in":3600,
                "refresh_token":"refresh-2",
                "scope":"search tools"
            }),
        ),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;
    let config = ServerConfig {
        server_type: Some("streamable-http".to_string()),
        url: Some(format!("{}/mcp", server.base_url)),
        command: None,
        args: Vec::new(),
        env: BTreeMap::new(),
        sensitive_env_vars: Vec::new(),
        oauth: Some(json!({
            "authorization_endpoint": format!("{}/authorize", server.base_url),
            "token_endpoint": format!("{}/token", server.base_url),
            "registration_endpoint": format!("{}/register", server.base_url),
            "resource": format!("{}/mcp", server.base_url)
        })),
        headers: None,
        disabled_tools: Vec::new(),
        tool_rename_mapping: BTreeMap::new(),
        tool_call_timeout: None,
        client_header_forwarding: None,
        http_subprocess: None,
        extra: BTreeMap::new(),
    };
    let (binding, _) = binding_for("glean-stale-client-scope", &config).await;
    binding
        .token_store
        .save_client_info(&CompatClientInfo {
            client_id: "client-id".to_string(),
            token_endpoint_auth_method: Some("none".to_string()),
            scope: Some("activity agents announcements answers search tools".to_string()),
            ..Default::default()
        })
        .unwrap();

    let authorization_url = binding.ensure_authorization_url(true).await.unwrap();
    let parsed = reqwest::Url::parse(&authorization_url).unwrap();
    assert!(parsed.query_pairs().all(|(key, _)| key != "scope"));
    let callback_state = parsed
        .query_pairs()
        .find(|(key, _)| key == "state")
        .map(|(_, value)| value.to_string())
        .unwrap();

    binding
        .handle_callback("auth-code", &callback_state)
        .await
        .unwrap();

    let stored = binding.token_store.load_token_file().unwrap().unwrap();
    assert_eq!(stored.access_token, "callback-token");
    assert_eq!(stored.scope.as_deref(), Some("search tools"));
}

#[tokio::test]
async fn refresh_rejects_under_scoped_token_response() {
    let _env = TokenEnv::new("refresh-scope-reject");
    let server = TestHttpServer::spawn(
        ResponseSpec::json(
            HttpStatus::OK,
            json!({
                "access_token":"refreshed-token",
                "token_type":"Bearer",
                "expires_in":3600,
                "scope":"offline_access"
            }),
        ),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;
    let (binding, _) = binding_for("scope-reject", &base_config(&server.base_url)).await;
    binding
        .apply_discovery(OAuthDiscovery {
            challenge_scopes: vec![
                "openid".to_string(),
                "offline_access".to_string(),
                "workforce.product.read".to_string(),
            ],
            ..Default::default()
        })
        .await
        .unwrap();
    let refresh_status = crate::oauth::storage::TokenStatus {
        token: CompatTokenFile {
            access_token: jwt(
                json!({"exp": past_exp(), "aud": format!("{}/mcp", server.base_url)}),
            ),
            token_type: Some("Bearer".to_string()),
            expires_in: Some(1),
            refresh_token: Some("refresh-token".to_string()),
            scope: Some("openid offline_access".to_string()),
            extra: Default::default(),
        },
        client_info: CompatClientInfo {
            client_id: "client-id".to_string(),
            token_endpoint_auth_method: Some("none".to_string()),
            ..Default::default()
        },
        expires_in: Some(1),
        is_expired: true,
        audience_mismatch: false,
        scope_mismatch: false,
        can_refresh: true,
    };

    let error = binding
        .refresh_access_token(&refresh_status)
        .await
        .unwrap_err();
    assert!(error
        .to_string()
        .contains("token response missing required scopes: workforce.product.read"));
    assert!(server.request("/token").body.contains("resource="));
    assert!(!server.request("/token").body.contains("scope="));
    assert!(binding.token_store.load_token_file().unwrap().is_none());
}

#[tokio::test]
async fn access_token_requires_reauthorization_when_refresh_returns_invalid_grant() {
    let _env = TokenEnv::new("access-refresh-fallback");
    let server = TestHttpServer::spawn(
        ResponseSpec::json(
            HttpStatus::BAD_REQUEST,
            json!({"error":"invalid_grant","error_description":"Token has expired"}),
        ),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;
    let (binding, coordinator) =
        binding_for("google_workspace", &base_config(&server.base_url)).await;
    let stored_token = jwt(json!({
        "exp": past_exp(),
        "aud": format!("{}/mcp", server.base_url)
    }));
    binding
        .token_store
        .save_client_info(&CompatClientInfo {
            client_id: "client-id".to_string(),
            token_endpoint_auth_method: Some("none".to_string()),
            ..Default::default()
        })
        .unwrap();
    binding
        .token_store
        .save_token_file(&CompatTokenFile {
            access_token: stored_token.clone(),
            token_type: Some("Bearer".to_string()),
            expires_in: Some(1),
            refresh_token: Some("refresh-token".to_string()),
            scope: None,
            extra: Default::default(),
        })
        .unwrap();

    let error = binding.access_token().await.unwrap_err();
    assert!(error
        .to_string()
        .contains("OAuth re-authorization required for server"));
    assert!(error.to_string().contains("authorization_url="));
    assert!(server
        .request("/token")
        .body
        .contains("grant_type=refresh_token"));
    assert!(binding.token_store.load_token_file().unwrap().is_none());
    assert!(binding.token_store.load_client_info().unwrap().is_some());
    let handshake = coordinator.get_handshake("google_workspace").await.unwrap();
    assert_eq!(handshake.state, OAuthState::Active);
    assert!(handshake
        .authorization_url
        .as_deref()
        .unwrap_or_default()
        .starts_with(&format!("{}/authorize?", server.base_url)));
}

#[tokio::test]
async fn access_token_requires_reauthorization_when_refresh_errors_array_contains_invalid_grant() {
    let _env = TokenEnv::new("access-refresh-errors-array");
    let server = TestHttpServer::spawn(
        ResponseSpec::json(
            HttpStatus::BAD_REQUEST,
            json!({
                "errors": [
                    "invalid_grant - Invalid or expired refresh token or code verifier."
                ]
            }),
        ),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;
    let (binding, coordinator) = binding_for("datadog", &base_config(&server.base_url)).await;
    binding
        .token_store
        .save_client_info(&CompatClientInfo {
            client_id: "client-id".to_string(),
            token_endpoint_auth_method: Some("none".to_string()),
            ..Default::default()
        })
        .unwrap();
    binding
        .token_store
        .save_token_file(&CompatTokenFile {
            access_token: jwt(json!({
                "exp": past_exp(),
                "aud": format!("{}/mcp", server.base_url)
            })),
            token_type: Some("Bearer".to_string()),
            expires_in: Some(1),
            refresh_token: Some("refresh-token".to_string()),
            scope: None,
            extra: Default::default(),
        })
        .unwrap();

    let error = binding.access_token().await.unwrap_err();
    assert!(error
        .to_string()
        .contains("OAuth re-authorization required for server"));
    assert!(error.to_string().contains("authorization_url="));
    assert!(server
        .request("/token")
        .body
        .contains("grant_type=refresh_token"));
    assert!(binding.token_store.load_token_file().unwrap().is_none());
    assert!(binding.token_store.load_client_info().unwrap().is_some());
    let handshake = coordinator.get_handshake("datadog").await.unwrap();
    assert_eq!(handshake.state, OAuthState::Active);
    assert!(handshake
        .authorization_url
        .as_deref()
        .unwrap_or_default()
        .starts_with(&format!("{}/authorize?", server.base_url)));
}

#[tokio::test]
async fn access_token_falls_back_to_stored_token_when_refresh_fails_non_terminally() {
    let _env = TokenEnv::new("access-refresh-fallback");
    let server = TestHttpServer::spawn(
        ResponseSpec::text(HttpStatus::INTERNAL_SERVER_ERROR, "gateway unavailable"),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;
    let (binding, _) = binding_for("google_workspace", &base_config(&server.base_url)).await;
    let stored_token = jwt(json!({
        "exp": past_exp(),
        "aud": format!("{}/mcp", server.base_url)
    }));
    binding
        .token_store
        .save_client_info(&CompatClientInfo {
            client_id: "client-id".to_string(),
            token_endpoint_auth_method: Some("none".to_string()),
            ..Default::default()
        })
        .unwrap();
    binding
        .token_store
        .save_token_file(&CompatTokenFile {
            access_token: stored_token.clone(),
            token_type: Some("Bearer".to_string()),
            expires_in: Some(1),
            refresh_token: Some("refresh-token".to_string()),
            scope: None,
            extra: Default::default(),
        })
        .unwrap();

    let access = binding.access_token().await.unwrap();
    assert_eq!(access.as_deref(), Some(stored_token.as_str()));
    assert!(binding.token_store.load_token_file().unwrap().is_some());
}

#[tokio::test(flavor = "current_thread")]
async fn access_token_requires_reauthorization_when_refresh_returns_invalid_json() {
    let _env = TokenEnv::new("access-refresh-invalid-json");
    let server = TestHttpServer::spawn(
        ResponseSpec::text(HttpStatus::OK, "<html>oauth edge failure</html>")
            .with_header("content-type", "text/html"),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;
    let (binding, _) = binding_for("data-plat-mcp", &base_config(&server.base_url)).await;
    let stored_token = jwt(json!({
        "exp": past_exp(),
        "aud": format!("{}/mcp", server.base_url)
    }));
    binding
        .token_store
        .save_client_info(&CompatClientInfo {
            client_id: "client-id".to_string(),
            token_endpoint_auth_method: Some("none".to_string()),
            ..Default::default()
        })
        .unwrap();
    binding
        .token_store
        .save_token_file(&CompatTokenFile {
            access_token: stored_token,
            token_type: Some("Bearer".to_string()),
            expires_in: Some(1),
            refresh_token: Some("refresh-token".to_string()),
            scope: Some("openid offline_access".to_string()),
            extra: Default::default(),
        })
        .unwrap();

    let error = binding.access_token().await.unwrap_err();
    assert!(error
        .to_string()
        .contains("OAuth re-authorization required for server"));
    assert!(error.to_string().contains("authorization_url="));
    assert!(binding.token_store.load_token_file().unwrap().is_none());
    assert!(binding.token_store.load_client_info().unwrap().is_some());
}

#[tokio::test(flavor = "current_thread")]
async fn refresh_redirect_is_not_followed_and_reports_location() {
    let _env = TokenEnv::new("refresh-redirect");
    let server = TestHttpServer::spawn(
        ResponseSpec::text(HttpStatus::FOUND, "").with_header("location", "/html"),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;
    let (binding, _) = binding_for("data-plat-mcp", &base_config(&server.base_url)).await;
    let refresh_status = crate::oauth::storage::TokenStatus {
        token: CompatTokenFile {
            access_token: jwt(
                json!({"exp": past_exp(), "aud": format!("{}/mcp", server.base_url)}),
            ),
            token_type: Some("Bearer".to_string()),
            expires_in: Some(1),
            refresh_token: Some("refresh-token".to_string()),
            scope: Some("openid offline_access".to_string()),
            extra: Default::default(),
        },
        client_info: CompatClientInfo {
            client_id: "client-id".to_string(),
            token_endpoint_auth_method: Some("none".to_string()),
            ..Default::default()
        },
        expires_in: Some(1),
        is_expired: true,
        audience_mismatch: false,
        scope_mismatch: false,
        can_refresh: true,
    };

    let error = binding
        .refresh_access_token(&refresh_status)
        .await
        .unwrap_err();
    assert!(error
        .to_string()
        .contains("token refresh failed with HTTP 302"));
    assert!(error.to_string().contains("location=/html"));
    assert!(!server
        .requests()
        .iter()
        .any(|request| request.path == "/html"));
}

#[tokio::test(flavor = "current_thread")]
async fn code_exchange_redirect_is_not_followed_and_reports_location() {
    let _env = TokenEnv::new("code-exchange-redirect");
    let server = TestHttpServer::spawn(
        ResponseSpec::text(HttpStatus::FOUND, "").with_header("location", "/html"),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;
    let (binding, _) = binding_for("data-plat-mcp", &base_config(&server.base_url)).await;
    let auth_url = binding.ensure_authorization_url(true).await.unwrap();
    let state = reqwest::Url::parse(&auth_url)
        .unwrap()
        .query_pairs()
        .find(|(key, _)| key == "state")
        .map(|(_, value)| value.to_string())
        .unwrap();

    let error = binding
        .handle_callback("auth-code", &state)
        .await
        .unwrap_err();
    assert!(error
        .to_string()
        .contains("token exchange failed with HTTP 302"));
    assert!(error.to_string().contains("location=/html"));
    assert!(!server
        .requests()
        .iter()
        .any(|request| request.path == "/html"));
}

#[tokio::test(flavor = "current_thread")]
async fn refresh_invalid_json_logs_safe_headers_and_body_snippet() {
    let _env = TokenEnv::new("refresh-invalid-json-log");
    let (log_server, log_state) = LogServer::spawn().await;
    let _log_env = EnvVarGuard::set(&[
        ("MCPO_OAUTH_LOG_URL", log_server.url.clone()),
        ("MCPO_DISABLE_OAUTH_LOG_FORWARDING", "0".to_string()),
    ]);
    let html_body = "<html><body>gateway error for refresh path</body></html>";
    let server = TestHttpServer::spawn(
        ResponseSpec::text(HttpStatus::OK, html_body)
            .with_header("content-type", "text/html")
            .with_header("portico-request-id", "req-123")
            .with_header("set-cookie", "session=secret"),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;
    let (binding, _) = binding_for("data-plat-mcp", &base_config(&server.base_url)).await;
    let refresh_status = crate::oauth::storage::TokenStatus {
        token: CompatTokenFile {
            access_token: jwt(
                json!({"exp": past_exp(), "aud": format!("{}/mcp", server.base_url)}),
            ),
            token_type: Some("Bearer".to_string()),
            expires_in: Some(1),
            refresh_token: Some("refresh-token".to_string()),
            scope: Some("openid offline_access".to_string()),
            extra: Default::default(),
        },
        client_info: CompatClientInfo {
            client_id: "client-id".to_string(),
            token_endpoint_auth_method: Some("none".to_string()),
            ..Default::default()
        },
        expires_in: Some(1),
        is_expired: true,
        audience_mismatch: false,
        scope_mismatch: false,
        can_refresh: true,
    };

    let error = binding
        .refresh_access_token(&refresh_status)
        .await
        .unwrap_err();
    assert!(error
        .to_string()
        .contains("token refresh returned invalid JSON"));

    let message =
        wait_for_forwarded_log_message(&log_state, "token refresh returned invalid JSON from")
            .await;
    assert!(message.contains("/token"));
    assert!(message.contains("status=200"));
    assert!(message.contains("content-type=text/html"));
    assert!(message.contains("portico-request-id=req-123"));
    assert!(message.contains(&format!("body_bytes={}", html_body.len())));
    assert!(message.contains("gateway error for refresh path"));
    assert!(!message.contains("set-cookie=session=secret"));
}

#[tokio::test(flavor = "current_thread")]
async fn refresh_invalid_json_log_redacts_secrets_and_truncates() {
    let _env = TokenEnv::new("refresh-invalid-json-redaction");
    let (log_server, log_state) = LogServer::spawn().await;
    let _log_env = EnvVarGuard::set(&[
        ("MCPO_OAUTH_LOG_URL", log_server.url.clone()),
        ("MCPO_DISABLE_OAUTH_LOG_FORWARDING", "0".to_string()),
    ]);
    let large_body = format!(
        "access_token=super-secret-token refresh_token=refresh-secret authorization: Bearer top-secret client_secret=client-secret {}",
        "A".repeat(700)
    );
    let server = TestHttpServer::spawn(
        ResponseSpec::text(HttpStatus::OK, large_body).with_header("content-type", "text/plain"),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;
    let (binding, _) = binding_for("data-plat-mcp", &base_config(&server.base_url)).await;
    let refresh_status = crate::oauth::storage::TokenStatus {
        token: CompatTokenFile {
            access_token: jwt(
                json!({"exp": past_exp(), "aud": format!("{}/mcp", server.base_url)}),
            ),
            token_type: Some("Bearer".to_string()),
            expires_in: Some(1),
            refresh_token: Some("refresh-token".to_string()),
            scope: Some("openid offline_access".to_string()),
            extra: Default::default(),
        },
        client_info: CompatClientInfo {
            client_id: "client-id".to_string(),
            token_endpoint_auth_method: Some("none".to_string()),
            ..Default::default()
        },
        expires_in: Some(1),
        is_expired: true,
        audience_mismatch: false,
        scope_mismatch: false,
        can_refresh: true,
    };

    let error = binding
        .refresh_access_token(&refresh_status)
        .await
        .unwrap_err();
    assert!(error
        .to_string()
        .contains("token refresh returned invalid JSON"));

    let message =
        wait_for_forwarded_log_message(&log_state, "token refresh returned invalid JSON from")
            .await;
    assert!(message.contains("body_snippet="));
    assert!(message.contains("<redacted>"));
    assert!(message.contains("...[truncated]"));
    assert!(!message.contains("super-secret-token"));
    assert!(!message.contains("refresh-secret"));
    assert!(!message.contains("client-secret"));
    assert!(!message.contains("top-secret"));
}

#[tokio::test]
async fn refresh_or_reauthorize_and_direct_token_methods_cover_auth_modes() {
    let _env = TokenEnv::new("refresh-modes");
    let server = TestHttpServer::spawn(
        ResponseSpec::json(
            HttpStatus::OK,
            json!({"access_token":"mode-token","token_type":"Bearer","expires_in":3600}),
        ),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;
    let (binding, _) = binding_for("glean", &base_config(&server.base_url)).await;
    let metadata = static_metadata(&server.base_url);

    let refresh_status = crate::oauth::storage::TokenStatus {
        token: CompatTokenFile {
            access_token: jwt(
                json!({"exp": past_exp(), "aud": format!("{}/mcp", server.base_url)}),
            ),
            token_type: Some("Bearer".to_string()),
            expires_in: Some(1),
            refresh_token: Some("refresh-basic".to_string()),
            scope: None,
            extra: Default::default(),
        },
        client_info: CompatClientInfo {
            client_id: "basic-client".to_string(),
            client_secret: Some("basic-secret".to_string()),
            token_endpoint_auth_method: Some("client_secret_basic".to_string()),
            ..Default::default()
        },
        expires_in: Some(1),
        is_expired: true,
        audience_mismatch: false,
        scope_mismatch: false,
        can_refresh: true,
    };
    let refreshed = binding.refresh_access_token(&refresh_status).await.unwrap();
    assert_eq!(refreshed.access_token, "mode-token");
    let refresh_request = server.request("/token");
    assert!(refresh_request.authorization.unwrap().starts_with("Basic "));

    let exchanged = binding
        .exchange_code_for_tokens(
            &metadata,
            &CompatClientInfo {
                client_id: "post-client".to_string(),
                client_secret: Some("post-secret".to_string()),
                token_endpoint_auth_method: Some("client_secret_post".to_string()),
                ..Default::default()
            },
            "auth-code",
            "pkce-verifier",
            "http://localhost:3834/callback",
        )
        .await
        .unwrap();
    assert_eq!(exchanged.access_token, "mode-token");
    let code_request = server.request("/token");
    assert!(code_request.body.contains("client_id=post-client"));
    assert!(code_request.body.contains("client_secret=post-secret"));
    assert!(code_request.body.contains("code_verifier=pkce-verifier"));
    assert!(code_request.body.contains("resource="));

    binding
        .token_store
        .save_client_info(&CompatClientInfo {
            client_id: "client-id".to_string(),
            token_endpoint_auth_method: Some("none".to_string()),
            ..Default::default()
        })
        .unwrap();
    binding
        .token_store
        .save_token_file(&CompatTokenFile {
            access_token: jwt(
                json!({"exp": past_exp(), "aud": format!("{}/mcp", server.base_url)}),
            ),
            token_type: Some("Bearer".to_string()),
            expires_in: Some(1),
            refresh_token: Some("refresh-token".to_string()),
            scope: None,
            extra: Default::default(),
        })
        .unwrap();
    let outcome = binding.refresh_or_reauthorize().await.unwrap();
    assert_eq!(outcome, OAuthRefreshOutcome::Refreshed);

    let empty_server = TestHttpServer::spawn(
        ResponseSpec::json(HttpStatus::BAD_REQUEST, json!({"error":"bad"})),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;
    let (fresh_binding, _) = binding_for("fresh", &base_config(&empty_server.base_url)).await;
    let auth_url = fresh_binding.refresh_or_reauthorize().await.unwrap();
    assert!(matches!(
        auth_url,
        OAuthRefreshOutcome::AuthorizationRequired(_)
    ));
    assert!(fresh_binding
        .handle_callback("code", "missing")
        .await
        .is_err());
}

#[tokio::test]
async fn refresh_or_reauthorize_invalid_grant_clears_tokens_and_requires_reauth() {
    let _env = TokenEnv::new("refresh-invalid-grant");
    let server = TestHttpServer::spawn(
        ResponseSpec::json(
            HttpStatus::BAD_REQUEST,
            json!({"error":"invalid_grant","error_description":"Token has expired"}),
        ),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;
    let (binding, coordinator) = binding_for("data-plat-mcp", &base_config(&server.base_url)).await;
    binding
        .token_store
        .save_client_info(&CompatClientInfo {
            client_id: "client-id".to_string(),
            token_endpoint_auth_method: Some("none".to_string()),
            ..Default::default()
        })
        .unwrap();
    binding
        .token_store
        .save_token_file(&CompatTokenFile {
            access_token: jwt(
                json!({"exp": past_exp(), "aud": format!("{}/mcp", server.base_url)}),
            ),
            token_type: Some("Bearer".to_string()),
            expires_in: Some(1),
            refresh_token: Some("refresh-token".to_string()),
            scope: Some("openid offline_access".to_string()),
            extra: Default::default(),
        })
        .unwrap();

    let outcome = binding.refresh_or_reauthorize().await.unwrap();
    let authorization_url = match outcome {
        OAuthRefreshOutcome::AuthorizationRequired(url) => url,
        other => panic!("expected authorization required outcome, got {other:?}"),
    };
    assert!(authorization_url.starts_with(&format!("{}/authorize?", server.base_url)));
    assert!(binding.token_store.load_token_file().unwrap().is_none());
    assert!(binding.token_store.load_client_info().unwrap().is_some());
    let handshake = coordinator.get_handshake("data-plat-mcp").await.unwrap();
    assert_eq!(handshake.state, OAuthState::Active);
    assert_eq!(
        handshake.authorization_url.as_deref(),
        Some(authorization_url.as_str())
    );
}

#[tokio::test]
async fn wrapper_transport_and_error_mapping_cover_all_explicit_variants() {
    let _env = TokenEnv::new("wrapper");
    let server = TestHttpServer::spawn(
        ResponseSpec::json(HttpStatus::OK, json!({"access_token":"wrapper-token"})),
        ResponseSpec::json(HttpStatus::OK, json!({"client_id":"unused"})),
    )
    .await;
    let (binding, _) = binding_for("glean", &base_config(&server.base_url)).await;
    binding
        .token_store
        .save_client_info(&CompatClientInfo {
            client_id: "client-id".to_string(),
            token_endpoint_auth_method: Some("none".to_string()),
            ..Default::default()
        })
        .unwrap();
    binding
        .token_store
        .save_token_file(&CompatTokenFile {
            access_token: jwt(
                json!({"exp": future_exp(), "aud": format!("{}/mcp", server.base_url)}),
            ),
            token_type: Some("Bearer".to_string()),
            expires_in: Some(3600),
            refresh_token: None,
            scope: None,
            extra: Default::default(),
        })
        .unwrap();

    let inner = DummyClient::default();
    let wrapped = OAuthStreamableHttpClient::new(inner.clone(), binding.clone());
    wrapped
        .delete_session(
            Arc::<str>::from("http://example.test"),
            Arc::<str>::from("session"),
            None,
            HashMap::new(),
        )
        .await
        .unwrap();
    let mut stream = wrapped
        .get_stream(
            Arc::<str>::from("http://example.test"),
            Arc::<str>::from("session"),
            None,
            Some("provided-token".to_string()),
            HashMap::new(),
        )
        .await
        .unwrap();
    assert!(stream.next().await.is_none());
    let message: ClientJsonRpcMessage = serde_json::from_value(json!({
        "jsonrpc":"2.0",
        "method":"notifications/initialized"
    }))
    .unwrap();
    wrapped
        .post_message(
            Arc::<str>::from("http://example.test"),
            message,
            None,
            None,
            HashMap::new(),
        )
        .await
        .unwrap();
    let tokens = inner.tokens.lock().unwrap().clone();
    let expected_token = binding.access_token().await.unwrap().unwrap();
    assert_eq!(tokens[0].as_deref(), Some(expected_token.as_str()));
    assert_eq!(tokens[1].as_deref(), Some("provided-token"));
    assert_eq!(tokens[2].as_deref(), Some(expected_token.as_str()));

    std::fs::write(binding.token_store.client_file(), b"{not json").unwrap();
    let invalid = wrapped.resolve_auth_token(None).await.unwrap_err();
    assert!(matches!(
        invalid,
        StreamableHttpError::Client(OAuthTransportError::Internal(_))
    ));

    assert!(matches!(
        map_streamable_error(StreamableHttpError::<DummyClientError>::Client(
            DummyClientError("client"),
        )),
        StreamableHttpError::Client(OAuthTransportError::Client(_))
    ));
    assert!(matches!(
        map_streamable_error(StreamableHttpError::<DummyClientError>::UnexpectedEndOfStream),
        StreamableHttpError::UnexpectedEndOfStream
    ));
    assert!(matches!(
        map_streamable_error(
            StreamableHttpError::<DummyClientError>::UnexpectedContentType(Some(
                "json".to_string()
            ),)
        ),
        StreamableHttpError::UnexpectedContentType(_)
    ));
    assert!(matches!(
        map_streamable_error(StreamableHttpError::<DummyClientError>::ServerDoesNotSupportSse),
        StreamableHttpError::ServerDoesNotSupportSse
    ));
    assert!(matches!(
        map_streamable_error(
            StreamableHttpError::<DummyClientError>::ServerDoesNotSupportDeleteSession,
        ),
        StreamableHttpError::ServerDoesNotSupportDeleteSession
    ));
    let join_error = tokio::spawn(async move {
        panic!("boom");
    })
    .await
    .unwrap_err();
    assert!(matches!(
        map_streamable_error(StreamableHttpError::<DummyClientError>::TokioJoinError(
            join_error,
        )),
        StreamableHttpError::TokioJoinError(_)
    ));
    let json_error = serde_json::from_str::<Value>("not-json").unwrap_err();
    assert!(matches!(
        map_streamable_error(StreamableHttpError::<DummyClientError>::Deserialize(
            json_error
        )),
        StreamableHttpError::Deserialize(_)
    ));
    assert!(matches!(
        map_streamable_error(StreamableHttpError::<DummyClientError>::TransportChannelClosed),
        StreamableHttpError::TransportChannelClosed
    ));
    assert!(matches!(
        map_streamable_error(StreamableHttpError::<DummyClientError>::MissingSessionIdInResponse),
        StreamableHttpError::MissingSessionIdInResponse
    ));
    assert!(matches!(
        map_streamable_error(StreamableHttpError::<DummyClientError>::Auth(
            AuthError::NoAuthorizationSupport,
        )),
        StreamableHttpError::Auth(_)
    ));
    assert!(matches!(
        map_streamable_error(StreamableHttpError::<DummyClientError>::AuthRequired(
            AuthRequiredError {
                www_authenticate_header: "Bearer".to_string(),
            },
        )),
        StreamableHttpError::AuthRequired(_)
    ));
    assert!(matches!(
        map_streamable_error(StreamableHttpError::<DummyClientError>::InsufficientScope(
            InsufficientScopeError {
                www_authenticate_header: "Bearer".to_string(),
                required_scope: Some("scope".to_string()),
            },
        )),
        StreamableHttpError::InsufficientScope(_)
    ));
    assert!(matches!(
        map_streamable_error(
            StreamableHttpError::<DummyClientError>::ReservedHeaderConflict("x-test".to_string(),)
        ),
        StreamableHttpError::ReservedHeaderConflict(_)
    ));
    assert!(matches!(
        map_streamable_error(
            StreamableHttpError::<DummyClientError>::UnexpectedServerResponse("oops".into(),)
        ),
        StreamableHttpError::UnexpectedServerResponse(_)
    ));
    assert!(matches!(
        map_streamable_error(StreamableHttpError::<DummyClientError>::Io(
            std::io::Error::other("io",)
        )),
        StreamableHttpError::Io(_)
    ));
}

#[test]
fn helper_functions_cover_scope_joining_and_redirect_selection() {
    let oauth_config = OAuthConfig::from_value(&json!({
        "scopes": ["openid"],
        "client_metadata": {
            "client_name": "Demo"
        }
    }))
    .unwrap();
    let info = build_client_info_from_credentials(
        &oauth_config,
        LoadedCredentials {
            client_id: "client".to_string(),
            client_secret: Some("secret".to_string()),
            scopes: vec![],
        },
    );
    assert_eq!(info.client_id, "client");
    assert_eq!(info.client_name.as_deref(), Some("Demo"));

    let redirect_client = CompatClientInfo {
        redirect_uris: vec![
            "http://localhost:3836/callback".to_string(),
            "http://localhost:3834/callback".to_string(),
        ],
        client_id: "client".to_string(),
        ..Default::default()
    };
    assert_eq!(
        resolve_redirect_uri(
            &OAuthConfig::from_value(&json!({"callback_port": 3834})).unwrap(),
            &redirect_client,
        ),
        "http://localhost:3834/callback"
    );
    assert_eq!(
        joined_scope(vec!["a".to_string(), "b".to_string()]).as_deref(),
        Some("a b")
    );
    assert!(joined_scope(Vec::new()).is_none());

    let manual_state = StoredAuthorizationState::new(
        &oauth2::PkceCodeVerifier::new("verifier".to_string()),
        &oauth2::CsrfToken::new("csrf".to_string()),
    );
    assert_eq!(
        manual_state.clone().into_pkce_verifier().secret(),
        "verifier"
    );
}
