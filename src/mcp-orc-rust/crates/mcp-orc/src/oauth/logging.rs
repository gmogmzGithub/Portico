use std::io::Write;
use std::sync::OnceLock;
use std::time::Duration;

use log::{debug, error, info, warn, Level};
use regex::Regex;
use serde::Serialize;

const DEFAULT_ELECTRON_OAUTH_LOG_URL: &str = "http://host.docker.internal:9876/api/oauth-log";
const OAUTH_LOG_LAYER: &str = "MCPO";
const OAUTH_MESSAGE_PREFIX: &str = "[OAuth:MCPO]";
const OAUTH_KEYWORDS: &[&str] = &[
    "oauth",
    "authorization",
    "token",
    "refresh",
    "authenticate",
    "credential",
    "client_id",
    "client_secret",
    "access_token",
    "refresh_token",
    "code_verifier",
    "code_challenge",
    "pkce",
    "401 unauthorized",
    "dcr",
    "dynamic client registration",
    "handshake",
    "callback",
    "redirect_uri",
    "redirect_url",
    "authorization_url",
    "authorize",
    "well-known",
    "scope",
    "scopes",
    "tool call start",
    "tool call response",
    "tool call completed",
    "tool call timeout",
    "tool call failed",
    "toggle",
    "timed out",
    "elapsed_ms",
];
const OAUTH_LOGGER_NAMES: &[&str] = &[
    "mcp_orc::oauth",
    "mcp_orc::app_oauth_probe",
    "mcp_orc::app_tool_oauth",
];

#[derive(Debug, Clone, Copy)]
enum OAuthLogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

impl OAuthLogLevel {
    fn as_str(self) -> &'static str {
        match self {
            Self::Debug => "DEBUG",
            Self::Info => "INFO",
            Self::Warn => "WARN",
            Self::Error => "ERROR",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct OAuthLogEntry {
    layer: String,
    level: String,
    message: String,
}

pub(crate) fn oauth_info(message: impl Into<String>) {
    log_and_forward(OAuthLogLevel::Info, message.into());
}

pub(crate) fn oauth_warn(message: impl Into<String>) {
    log_and_forward(OAuthLogLevel::Warn, message.into());
}

pub(crate) fn oauth_error(message: impl Into<String>) {
    log_and_forward(OAuthLogLevel::Error, message.into());
}

#[allow(dead_code)]
pub(crate) fn oauth_debug(message: impl Into<String>) {
    log_and_forward(OAuthLogLevel::Debug, message.into());
}

fn log_and_forward(level: OAuthLogLevel, message: String) {
    match level {
        OAuthLogLevel::Debug => debug!("{OAUTH_MESSAGE_PREFIX} {message}"),
        OAuthLogLevel::Info => info!("{OAUTH_MESSAGE_PREFIX} {message}"),
        OAuthLogLevel::Warn => warn!("{OAUTH_MESSAGE_PREFIX} {message}"),
        OAuthLogLevel::Error => error!("{OAUTH_MESSAGE_PREFIX} {message}"),
    }

    let Some(url) = oauth_log_url() else {
        return;
    };

    let entry = OAuthLogEntry {
        layer: OAUTH_LOG_LAYER.to_string(),
        level: level.as_str().to_string(),
        message,
    };

    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        return;
    };
    let client = oauth_http_client().clone();
    handle.spawn(async move {
        let _ = client
            .post(url)
            .json(&entry)
            .timeout(Duration::from_secs(2))
            .send()
            .await;
    });
}

pub fn configure_env_logger(builder: &mut env_logger::Builder) {
    builder.format(|buf, record| {
        let timestamp = buf.timestamp_seconds();
        let target = record.target();
        let message = record.args().to_string();
        let oauth_related = is_oauth_related(target, &message);
        if oauth_related {
            maybe_forward_log_record(target, record.level(), &message);
        }
        let rendered_message = if oauth_related && !message.contains(OAUTH_MESSAGE_PREFIX) {
            format!("{OAUTH_MESSAGE_PREFIX} {message}")
        } else {
            message
        };
        writeln!(
            buf,
            "[{timestamp}] {} [{}] {}",
            record.level(),
            target,
            rendered_message
        )
    });
}

pub(crate) fn maybe_forward_log_record(target: &str, level: Level, message: &str) {
    if !is_oauth_related(target, message) {
        return;
    }
    forward_generic(level, message.to_string());
}

fn oauth_http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

fn oauth_log_url() -> Option<String> {
    if std::env::var("MCPO_DISABLE_OAUTH_LOG_FORWARDING")
        .ok()
        .as_deref()
        == Some("1")
    {
        return None;
    }

    if let Ok(url) = std::env::var("MCPO_OAUTH_LOG_URL") {
        let trimmed = url.trim();
        return (!trimmed.is_empty()).then(|| trimmed.to_string());
    }

    if cfg!(test) {
        return None;
    }

    Some(DEFAULT_ELECTRON_OAUTH_LOG_URL.to_string())
}

fn forward_generic(level: Level, message: String) {
    let Some(url) = oauth_log_url() else {
        return;
    };
    let entry = OAuthLogEntry {
        layer: OAUTH_LOG_LAYER.to_string(),
        level: level_to_name(level).to_string(),
        message,
    };
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        return;
    };
    let client = oauth_http_client().clone();
    handle.spawn(async move {
        let _ = client
            .post(url)
            .json(&entry)
            .timeout(Duration::from_secs(2))
            .send()
            .await;
    });
}

fn level_to_name(level: Level) -> &'static str {
    match level {
        Level::Error => "ERROR",
        Level::Warn => "WARN",
        Level::Info => "INFO",
        Level::Debug | Level::Trace => "DEBUG",
    }
}

fn is_oauth_related(target: &str, message: &str) -> bool {
    if should_skip(message) {
        return false;
    }

    let lower_target = target.to_ascii_lowercase();
    if OAUTH_LOGGER_NAMES
        .iter()
        .any(|candidate| lower_target.contains(candidate))
    {
        return true;
    }

    let normalized = message.to_ascii_lowercase();
    if OAUTH_KEYWORDS
        .iter()
        .any(|keyword| normalized.contains(keyword))
    {
        return true;
    }

    oauth_patterns()
        .iter()
        .any(|pattern| pattern.is_match(message))
}

fn should_skip(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    normalized.contains("oauth-log")
        || normalized.contains("/api/oauth-log")
        || message.contains(OAUTH_MESSAGE_PREFIX)
}

fn oauth_patterns() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS
        .get_or_init(|| {
            [
                r"(?i)\boauth\b",
                r"(?i)\btoken\b",
                r"(?i)\bauthoriz",
                r"(?i)\bauthenticat",
                r"(?i)401\s*Unauthorized",
                r"(?i)\bPKCE\b",
                r"\bDCR\b",
                r"(?i)client[_-]?(id|secret)",
                r"(?i)(access|refresh)[_-]?token",
                r"(?i)\[mcp-[^\]]+\].*(?:refresh|token|auth|401)",
            ]
            .into_iter()
            .map(|pattern| Regex::new(pattern).expect("OAuth regex patterns must compile"))
            .collect()
        })
        .as_slice()
}

#[cfg(test)]
mod tests {
    use super::{
        configure_env_logger, maybe_forward_log_record, oauth_error, oauth_info, oauth_log_url,
        oauth_warn,
    };
    use axum::extract::State;
    use axum::routing::post;
    use axum::{Json, Router};
    use env_logger::Builder;
    use log::Level;
    use serde_json::{json, Value};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::net::TcpListener;
    use tokio::sync::oneshot;

    #[derive(Clone, Default)]
    struct LogState {
        entries: Arc<Mutex<Vec<Value>>>,
    }

    struct TestServer {
        url: String,
        shutdown: Option<oneshot::Sender<()>>,
    }

    impl TestServer {
        async fn spawn() -> (Self, LogState) {
            async fn handler(
                State(state): State<LogState>,
                Json(payload): Json<Value>,
            ) -> Json<Value> {
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

    impl Drop for TestServer {
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

    #[test]
    fn log_url_defaults_to_disabled_in_tests() {
        let _lock = crate::test_env_lock();
        std::env::remove_var("MCPO_OAUTH_LOG_URL");
        std::env::remove_var("MCPO_DISABLE_OAUTH_LOG_FORWARDING");
        assert!(oauth_log_url().is_none());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn forwards_oauth_logs_to_configured_endpoint() {
        let _lock = crate::test_env_lock();
        let (server, state) = TestServer::spawn().await;
        let _env = EnvGuard::set(&[
            ("MCPO_OAUTH_LOG_URL", server.url.clone()),
            ("MCPO_DISABLE_OAUTH_LOG_FORWARDING", "0".to_string()),
        ]);

        oauth_info("info message");
        oauth_warn("warn message");
        oauth_error("error message");

        tokio::time::sleep(Duration::from_millis(200)).await;

        let entries = state.entries.lock().unwrap().clone();
        let expected_entries: Vec<_> = entries
            .iter()
            .filter(|entry| {
                matches!(
                    entry["message"].as_str(),
                    Some("info message" | "warn message" | "error message")
                )
            })
            .collect();
        assert_eq!(expected_entries.len(), 3);
        assert_eq!(expected_entries[0]["layer"], "MCPO");
        assert_eq!(expected_entries[0]["level"], "INFO");
        assert_eq!(expected_entries[0]["message"], "info message");
        assert_eq!(expected_entries[1]["level"], "WARN");
        assert_eq!(expected_entries[2]["level"], "ERROR");
    }

    #[test]
    fn disable_flag_wins_over_configured_url() {
        let _lock = crate::test_env_lock();
        let _env = EnvGuard::set(&[
            (
                "MCPO_OAUTH_LOG_URL",
                "http://example.test/oauth-log".to_string(),
            ),
            ("MCPO_DISABLE_OAUTH_LOG_FORWARDING", "1".to_string()),
        ]);
        assert!(oauth_log_url().is_none());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn forwards_generic_oauth_related_records_without_dup_or_recursion() {
        let _lock = crate::test_env_lock();
        let (server, state) = TestServer::spawn().await;
        let _env = EnvGuard::set(&[
            ("MCPO_OAUTH_LOG_URL", server.url.clone()),
            ("MCPO_DISABLE_OAUTH_LOG_FORWARDING", "0".to_string()),
        ]);

        maybe_forward_log_record(
            "mcp_orc::session",
            Level::Info,
            "OAuth refresh succeeded for demo server",
        );
        maybe_forward_log_record(
            "reqwest::connect",
            Level::Info,
            "POST http://host.docker.internal:9876/api/oauth-log",
        );
        maybe_forward_log_record("plain::target", Level::Info, "ordinary message");
        maybe_forward_log_record(
            "mcp_orc::oauth::binding",
            Level::Info,
            "[OAuth:MCPO] explicit helper log should not duplicate",
        );

        tokio::time::sleep(Duration::from_millis(200)).await;

        let entries = state.entries.lock().unwrap().clone();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["level"], "INFO");
        assert_eq!(
            entries[0]["message"],
            "OAuth refresh succeeded for demo server"
        );
    }

    #[test]
    fn configure_env_logger_installs_custom_formatter() {
        let mut builder = Builder::new();
        configure_env_logger(&mut builder);
    }
}
