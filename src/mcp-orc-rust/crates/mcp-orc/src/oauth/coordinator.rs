use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::logging::{oauth_error, oauth_info, oauth_warn};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OAuthState {
    Pending,
    Checking,
    Active,
    WaitingCallback,
    Completed,
    Failed,
    Timeout,
}

impl OAuthState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Checking => "checking",
            Self::Active => "active",
            Self::WaitingCallback => "waiting_callback",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Timeout => "timeout",
        }
    }
}

#[derive(Debug, Clone)]
pub struct OAuthHandshake {
    pub server_name: String,
    pub state: OAuthState,
    pub authorization_url: Option<String>,
    pub state_param: Option<String>,
    pub error_message: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub has_auth_context: bool,
}

impl OAuthHandshake {
    fn new(server_name: impl Into<String>) -> Self {
        Self {
            server_name: server_name.into(),
            state: OAuthState::Pending,
            authorization_url: None,
            state_param: None,
            error_message: None,
            started_at: None,
            completed_at: None,
            has_auth_context: false,
        }
    }

    fn to_json(&self) -> Value {
        json!({
            "server_name": self.server_name,
            "state": self.state.as_str(),
            "authorization_url": self.authorization_url,
            "state_param": self.state_param,
            "error_message": self.error_message,
            "started_at": self.started_at.map(|value| value.to_rfc3339()),
            "completed_at": self.completed_at.map(|value| value.to_rfc3339()),
            "has_auth_context": self.has_auth_context,
        })
    }
}

fn clear_authorization_artifacts(handshake: &mut OAuthHandshake) {
    handshake.authorization_url = None;
    handshake.state_param = None;
}

#[derive(Debug, Default)]
struct CoordinatorState {
    handshakes: BTreeMap<String, OAuthHandshake>,
    current: Option<String>,
    serving: bool,
}

#[derive(Debug, Default)]
pub struct OAuthCoordinator {
    state: Mutex<CoordinatorState>,
}

impl OAuthCoordinator {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn mark_serving(&self) {
        self.state.lock().await.serving = true;
    }

    pub async fn register_handshake(&self, server_name: &str) {
        let mut state = self.state.lock().await;
        state
            .handshakes
            .entry(server_name.to_string())
            .or_insert_with(|| {
                oauth_info(format!(
                    "[{server_name}] registered OAuth handshake for server startup"
                ));
                OAuthHandshake::new(server_name)
            });
    }

    pub async fn mark_checking(&self, server_name: &str) {
        let mut state = self.state.lock().await;
        {
            let handshake = state
                .handshakes
                .entry(server_name.to_string())
                .or_insert_with(|| OAuthHandshake::new(server_name));
            handshake.state = OAuthState::Checking;
            handshake.completed_at = None;
            handshake.error_message = None;
            clear_authorization_artifacts(handshake);
        }
        if state.current.as_deref() == Some(server_name) {
            state.current = None;
        }
    }

    pub async fn set_authorization_url(
        &self,
        server_name: &str,
        authorization_url: String,
        has_auth_context: bool,
    ) {
        let mut state = self.state.lock().await;
        let handshake = state
            .handshakes
            .entry(server_name.to_string())
            .or_insert_with(|| OAuthHandshake::new(server_name));
        if handshake.authorization_url.is_some()
            && handshake.completed_at.is_none()
            && matches!(
                handshake.state,
                OAuthState::Active | OAuthState::WaitingCallback
            )
        {
            if handshake.authorization_url.as_deref() != Some(authorization_url.as_str()) {
                log::warn!(
                    "ignoring duplicate OAuth authorization URL for '{}' while flow is active",
                    server_name
                );
                oauth_warn(format!(
                    "[{server_name}] ignoring duplicate authorization URL while OAuth flow is active"
                ));
            }
            state.current = Some(server_name.to_string());
            return;
        }
        handshake.authorization_url = Some(authorization_url.clone());
        handshake.state_param = extract_state_param(&authorization_url);
        handshake.state = OAuthState::Active;
        handshake.started_at = Some(Utc::now());
        handshake.completed_at = None;
        handshake.error_message = None;
        handshake.has_auth_context = has_auth_context;
        state.current = Some(server_name.to_string());
        oauth_info(format!(
            "[{server_name}] OAuth authorization URL generated (has_auth_context={has_auth_context})"
        ));
    }

    pub async fn mark_authorization_required(
        &self,
        server_name: &str,
        error_message: impl Into<String>,
    ) {
        let error_message = error_message.into();
        let mut state = self.state.lock().await;
        let handshake = state
            .handshakes
            .entry(server_name.to_string())
            .or_insert_with(|| OAuthHandshake::new(server_name));
        let already_marked = handshake.state == OAuthState::Active
            && handshake.authorization_url.is_none()
            && handshake.completed_at.is_none()
            && handshake.error_message.as_deref() == Some(error_message.as_str())
            && handshake.has_auth_context;
        handshake.state = OAuthState::Active;
        handshake.authorization_url = None;
        handshake.state_param = None;
        handshake.started_at = Some(Utc::now());
        handshake.completed_at = None;
        handshake.error_message = Some(error_message);
        handshake.has_auth_context = true;
        state.current = Some(server_name.to_string());
        if already_marked {
            return;
        }
        let message = state
            .handshakes
            .get(server_name)
            .and_then(|handshake| handshake.error_message.clone())
            .unwrap_or_else(|| "authorization required".to_string());
        oauth_warn(format!(
            "[{server_name}] OAuth authorization required without container-local authorization URL: {message}"
        ));
    }

    pub async fn mark_waiting_callback(&self, server_name: &str) {
        let mut state = self.state.lock().await;
        if let Some(handshake) = state.handshakes.get_mut(server_name) {
            handshake.state = OAuthState::WaitingCallback;
        }
    }

    pub async fn mark_completed(&self, server_name: &str) {
        let mut state = self.state.lock().await;
        if let Some(handshake) = state.handshakes.get_mut(server_name) {
            handshake.state = OAuthState::Completed;
            handshake.completed_at = Some(Utc::now());
            handshake.error_message = None;
            clear_authorization_artifacts(handshake);
            if state.current.as_deref() == Some(server_name) {
                state.current = None;
            }
            oauth_info(format!("[{server_name}] OAuth handshake completed"));
        }
    }

    pub async fn mark_failed(&self, server_name: &str, error_message: impl Into<String>) {
        let mut state = self.state.lock().await;
        let handshake = state
            .handshakes
            .entry(server_name.to_string())
            .or_insert_with(|| OAuthHandshake::new(server_name));
        handshake.state = OAuthState::Failed;
        handshake.error_message = Some(error_message.into());
        handshake.completed_at = Some(Utc::now());
        let message = handshake
            .error_message
            .clone()
            .unwrap_or_else(|| "unknown error".to_string());
        if state.current.as_deref() == Some(server_name) {
            state.current = None;
        }
        oauth_error(format!("[{server_name}] OAuth handshake failed: {message}"));
    }

    pub async fn mark_validation_failed(
        &self,
        server_name: &str,
        error_message: impl Into<String>,
    ) {
        let mut state = self.state.lock().await;
        let message = error_message.into();
        {
            let handshake = state
                .handshakes
                .entry(server_name.to_string())
                .or_insert_with(|| OAuthHandshake::new(server_name));
            if matches!(
                handshake.state,
                OAuthState::Completed | OAuthState::Failed | OAuthState::Timeout
            ) {
                return;
            }
            handshake.state = OAuthState::Failed;
            handshake.error_message = Some(message.clone());
            handshake.completed_at = Some(Utc::now());
            clear_authorization_artifacts(handshake);
        }
        if state.current.as_deref() == Some(server_name) {
            state.current = None;
        }
        oauth_error(format!(
            "[{server_name}] OAuth token validation failed: {message}"
        ));
    }

    pub async fn mark_timeout(&self, server_name: &str, error_message: impl Into<String>) {
        let mut state = self.state.lock().await;
        let handshake = state
            .handshakes
            .entry(server_name.to_string())
            .or_insert_with(|| OAuthHandshake::new(server_name));
        handshake.state = OAuthState::Timeout;
        handshake.error_message = Some(error_message.into());
        handshake.completed_at = Some(Utc::now());
        let message = handshake
            .error_message
            .clone()
            .unwrap_or_else(|| "unknown timeout".to_string());
        if state.current.as_deref() == Some(server_name) {
            state.current = None;
        }
        oauth_warn(format!(
            "[{server_name}] OAuth handshake timed out: {message}"
        ));
    }

    pub async fn mark_connected(&self, server_name: &str) {
        let mut state = self.state.lock().await;
        let handshake = state
            .handshakes
            .entry(server_name.to_string())
            .or_insert_with(|| OAuthHandshake::new(server_name));
        if matches!(
            handshake.state,
            OAuthState::Pending
                | OAuthState::Checking
                | OAuthState::WaitingCallback
                | OAuthState::Active
        ) {
            handshake.state = OAuthState::Completed;
            handshake.completed_at = Some(Utc::now());
            handshake.error_message = None;
            clear_authorization_artifacts(handshake);
            if state.current.as_deref() == Some(server_name) {
                state.current = None;
            }
            oauth_info(format!(
                "[{server_name}] transport connected successfully with usable OAuth state"
            ));
        }
    }

    pub async fn restart_oauth_flow(&self, server_name: &str) {
        let mut state = self.state.lock().await;
        state
            .handshakes
            .insert(server_name.to_string(), OAuthHandshake::new(server_name));
        if state.current.as_deref() == Some(server_name) {
            state.current = None;
        }
        oauth_info(format!(
            "[{server_name}] reset OAuth handshake state for a fresh authorization flow"
        ));
    }

    pub async fn current(&self) -> Option<OAuthHandshake> {
        let state = self.state.lock().await;
        state
            .current
            .as_ref()
            .and_then(|server_name| state.handshakes.get(server_name).cloned())
    }

    pub async fn current_server(&self) -> Option<String> {
        self.current().await.map(|handshake| handshake.server_name)
    }

    pub async fn get_handshake(&self, server_name: &str) -> Option<OAuthHandshake> {
        let state = self.state.lock().await;
        state.handshakes.get(server_name).cloned()
    }

    pub async fn get_handshake_by_state(
        &self,
        state_param: Option<&str>,
    ) -> Option<OAuthHandshake> {
        let Some(state_param) = state_param else {
            return None;
        };
        let state = self.state.lock().await;
        state
            .handshakes
            .values()
            .find(|handshake| handshake.state_param.as_deref() == Some(state_param))
            .cloned()
    }

    pub async fn server_for_state(&self, state_param: &str) -> Option<String> {
        self.get_handshake_by_state(Some(state_param))
            .await
            .map(|handshake| handshake.server_name)
    }

    pub async fn authorization_url_for(&self, server_name: &str) -> Option<String> {
        self.get_handshake(server_name)
            .await
            .and_then(|handshake| handshake.authorization_url)
    }

    pub async fn status_json(&self) -> Value {
        let state = self.state.lock().await;
        json!({
            "current": state.current.as_ref().and_then(|server_name| state.handshakes.get(server_name)).map(OAuthHandshake::to_json),
            "pending": collect_state(&state, OAuthState::Pending),
            "checking": collect_state(&state, OAuthState::Checking),
            "waiting_callback": collect_state(&state, OAuthState::WaitingCallback),
            "completed": collect_state(&state, OAuthState::Completed),
            "failed": collect_state(&state, OAuthState::Failed),
            "timeout": collect_state(&state, OAuthState::Timeout),
            "active": collect_state(&state, OAuthState::Active),
            "callback_server_running": state.serving,
        })
    }

    pub async fn current_json(&self) -> Value {
        match self.current().await {
            Some(current) => json!({ "current": current.to_json() }),
            None => json!({ "message": "No active OAuth handshake", "current": Value::Null }),
        }
    }

    pub async fn pending_json(&self) -> Value {
        let state = self.state.lock().await;
        json!({
            "pending": collect_state(&state, OAuthState::Pending),
            "waiting_callback": collect_state(&state, OAuthState::WaitingCallback),
        })
    }
}

fn extract_state_param(authorization_url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(authorization_url).ok()?;
    parsed
        .query_pairs()
        .find_map(|(key, value)| (key == "state").then(|| value.to_string()))
}

fn collect_state(state: &CoordinatorState, target: OAuthState) -> Vec<Value> {
    state
        .handshakes
        .values()
        .filter(|handshake| handshake.state == target)
        .map(OAuthHandshake::to_json)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{OAuthCoordinator, OAuthState};
    use serde_json::Value;

    #[tokio::test]
    async fn tracks_active_authorization_url() {
        let coordinator = OAuthCoordinator::new();
        coordinator.register_handshake("glean").await;
        coordinator
            .set_authorization_url(
                "glean",
                "https://example.com/auth?state=abc".to_string(),
                true,
            )
            .await;
        let current = coordinator.current().await.unwrap();
        assert_eq!(current.server_name, "glean");
        assert_eq!(current.state, OAuthState::Active);
        assert_eq!(current.state_param.as_deref(), Some("abc"));
    }

    #[tokio::test]
    async fn restarts_handshake_cleanly() {
        let coordinator = OAuthCoordinator::new();
        coordinator.register_handshake("glean").await;
        coordinator.mark_failed("glean", "boom").await;
        coordinator.restart_oauth_flow("glean").await;
        let handshake = coordinator.get_handshake("glean").await.unwrap();
        assert_eq!(handshake.state, OAuthState::Pending);
        assert!(handshake.authorization_url.is_none());
    }

    #[tokio::test]
    async fn transitions_through_all_states_and_json_views() {
        let coordinator = OAuthCoordinator::new();
        coordinator.register_handshake("glean").await;
        coordinator.mark_checking("glean").await;
        assert_eq!(
            coordinator.get_handshake("glean").await.unwrap().state,
            OAuthState::Checking
        );

        coordinator
            .set_authorization_url(
                "glean",
                "https://example.com/auth?state=xyz".to_string(),
                false,
            )
            .await;
        assert_eq!(
            coordinator.authorization_url_for("glean").await.as_deref(),
            Some("https://example.com/auth?state=xyz")
        );
        assert_eq!(
            coordinator.server_for_state("xyz").await.as_deref(),
            Some("glean")
        );
        assert!(coordinator.get_handshake_by_state(None).await.is_none());

        coordinator.mark_waiting_callback("glean").await;
        assert_eq!(
            coordinator.get_handshake("glean").await.unwrap().state,
            OAuthState::WaitingCallback
        );

        let pending = coordinator.pending_json().await;
        assert_eq!(
            pending["waiting_callback"][0]["server_name"],
            Value::String("glean".to_string())
        );

        coordinator.mark_completed("glean").await;
        assert!(coordinator.current().await.is_none());
        assert!(coordinator.authorization_url_for("glean").await.is_none());
        let current = coordinator.current_json().await;
        assert_eq!(current["current"], Value::Null);

        coordinator
            .set_authorization_url(
                "fresh",
                "https://example.com/auth?state=fresh".to_string(),
                false,
            )
            .await;
        coordinator.mark_failed("other", "boom").await;
        coordinator.mark_timeout("slow", "timed out").await;
        coordinator.mark_connected("fresh").await;
        let fresh = coordinator.get_handshake("fresh").await.unwrap();
        assert_eq!(fresh.state, OAuthState::Completed);
        assert!(fresh.authorization_url.is_none());
        assert!(fresh.state_param.is_none());

        let status = coordinator.status_json().await;
        assert_eq!(status["completed"].as_array().unwrap().len(), 2);
        assert_eq!(status["failed"][0]["server_name"], "other");
        assert_eq!(status["timeout"][0]["server_name"], "slow");
        assert_eq!(status["callback_server_running"], false);

        coordinator.mark_serving().await;
        let status = coordinator.status_json().await;
        assert_eq!(status["callback_server_running"], true);
    }
}

#[cfg(test)]
#[path = "coordinator_extra_tests.rs"]
mod extra_tests;
