//! Pre-flight integration health check for scheduled-run dispatch.
//!
//! Phase 2 (round 4 of the chip rework extends this to auth-state).
//! Before the daemon starts a run, it consults the local MCP server
//! registry to ensure every entry in ``ScheduledTask::tool_server_ids``
//! is installed, enabled, AND (where applicable) authenticated.
//!
//! Contract:
//!
//! * Every id in ``tool_server_ids`` must resolve to a config directory
//!   under ``app_root/mcp-configs`` (system) OR ``mcp-configs-user``
//!   (user-installed) — i.e. the MCP server is INSTALLED.
//!
//! * Every id must be ENABLED in the user's toggle file. If the user
//!   disabled the integration manually we honour that and refuse the
//!   run rather than silently ignoring their wish.
//!
//! * Every id whose auth state is KNOWN to be ``NotAuthenticated`` or
//!   ``Expired`` fails preflight with the matching reason
//!   (``LastRunStatus::AuthRequired`` rather than the generic
//!   ``MissingIntegration``). Servers with ``NotApplicable`` /
//!   ``Authenticated`` / unknown state pass — the caller's auth-state
//!   provider returns the empty map when it has no information, which
//!   preserves the original phase-2 behavior.
//!
//! Defense-in-depth: the skill instructs the model to do the same
//! check at task creation time. This module is the executor-side belt
//! that fires even when the model drifts (or when an integration is
//! removed / de-authenticated AFTER task creation).

use core_mcp_shared::{bare_server_id, load_mcp_toggles, mcp_configs_dir, mcp_configs_user_dir};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::env;
use std::path::{Path, PathBuf};
use std::time::Duration;

const SCHEDULER_BRIDGE_STATUS_URL_ENV: &str = "portico_SCHEDULER_BRIDGE_STATUS_URL";
const SCHEDULER_BRIDGE_STATUS_TOKEN_ENV: &str = "portico_SCHEDULER_BRIDGE_STATUS_TOKEN";
const SCHEDULER_BRIDGE_STATUS_TIMEOUT_MS: u64 = 1000;

/// One offline / missing tool server with the reason it failed the
/// preflight. Surfaced verbatim into ``last_run_error`` so the user
/// knows exactly which integration to fix.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OfflineToolServer {
    pub id: String,
    pub reason: OfflineReason,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OfflineReason {
    /// No config directory exists for this id under either configs
    /// dir. The integration was never installed (or was uninstalled).
    NotInstalled,
    /// Config directory exists but the user toggled the integration
    /// off in their settings.
    Disabled,
    /// Round 4 / Issue 5a — server is installed and enabled, but no
    /// OAuth token is on file. The user needs to authorize the
    /// integration before scheduled runs can use it.
    NotAuthenticated,
    /// Round 4 / Issue 5a — token exists but is expired or has been
    /// revoked. The user needs to re-authorize.
    AuthExpired,
}

impl OfflineReason {
    /// Round 4 / Issue 5a — distinguishes "needs install/enable" from
    /// "needs auth". The executor uses this to record the precise
    /// ``LastRunStatus`` (``AuthRequired`` vs ``MissingIntegration``)
    /// so the user knows whether to re-install or re-authenticate.
    pub fn is_auth_failure(&self) -> bool {
        matches!(
            self,
            OfflineReason::NotAuthenticated | OfflineReason::AuthExpired
        )
    }
}

/// Per-server auth state surfaced into the preflight check. The
/// scheduling-server populates this from whatever auth-status source
/// is available (OAuth token store, mcp-assistant readiness, etc.); a
/// default of ``NotApplicable`` (or just an empty map) is fine for
/// servers without OAuth.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AuthState {
    /// Server doesn't require auth (e.g. local agent VM, read-only
    /// public endpoints) or the auth provider has no opinion.
    NotApplicable,
    /// Auth is required and a valid token is on file.
    Authenticated,
    /// Auth is required and no token is on file.
    NotAuthenticated,
    /// Auth is required and the token is known to be expired/revoked.
    Expired,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SchedulerBridgeReadiness {
    pub ready: bool,
    pub reason: String,
}

#[derive(Clone, Debug)]
pub struct SchedulerBridgeReadinessClient {
    url: String,
    token: String,
    http: reqwest::Client,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeStatusPayload {
    #[serde(default)]
    success: bool,
    #[serde(default)]
    bridge_ready: bool,
    // `bridgeEnabled` may still be present on the wire; it reflects the
    // optional external-client bridge preference and is intentionally not
    // part of scheduler readiness (PORTICO-200), so it is not deserialized.
    #[serde(default)]
    broker_auth_ready: bool,
    #[serde(default)]
    error_code: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

impl SchedulerBridgeReadinessClient {
    pub fn new(url: String, token: String) -> Self {
        Self {
            url,
            token,
            http: reqwest::Client::builder()
                .timeout(Duration::from_millis(SCHEDULER_BRIDGE_STATUS_TIMEOUT_MS))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
        }
    }

    pub async fn check(&self) -> SchedulerBridgeReadiness {
        let first = self.check_once().await;
        if first.ready {
            return first;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        self.check_once().await
    }

    async fn check_once(&self) -> SchedulerBridgeReadiness {
        let response = match self
            .http
            .get(&self.url)
            .bearer_auth(&self.token)
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                return SchedulerBridgeReadiness {
                    ready: false,
                    reason: format!("Scheduler bridge readiness request failed: {error}"),
                };
            }
        };
        if !response.status().is_success() {
            return SchedulerBridgeReadiness {
                ready: false,
                reason: format!(
                    "Scheduler bridge readiness returned HTTP {}",
                    response.status().as_u16()
                ),
            };
        }
        let payload = match response.json::<BridgeStatusPayload>().await {
            Ok(payload) => payload,
            Err(error) => {
                return SchedulerBridgeReadiness {
                    ready: false,
                    reason: format!("Scheduler bridge readiness returned invalid JSON: {error}"),
                };
            }
        };
        // Scheduler readiness deliberately ignores the external-client
        // `bridgeEnabled` preference: scheduled runs depend on the app and the
        // OAuth broker, not on the external MCP client feature (PORTICO-200).
        if payload.success && payload.bridge_ready && payload.broker_auth_ready {
            return SchedulerBridgeReadiness {
                ready: true,
                reason: "Host MCP Bridge is ready".to_string(),
            };
        }
        SchedulerBridgeReadiness {
            ready: false,
            reason: payload
                .reason
                .or(payload.error_code)
                .unwrap_or_else(|| "Scheduler bridge readiness reported not ready".to_string()),
        }
    }
}

pub async fn check_scheduler_bridge_readiness_from_env() -> SchedulerBridgeReadiness {
    let url = env::var(SCHEDULER_BRIDGE_STATUS_URL_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let token = env::var(SCHEDULER_BRIDGE_STATUS_TOKEN_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let (Some(url), Some(token)) = (url, token) else {
        #[cfg(test)]
        {
            return SchedulerBridgeReadiness {
                ready: true,
                reason: "test default: Host MCP Bridge readiness not configured".to_string(),
            };
        }
        #[cfg(not(test))]
        return SchedulerBridgeReadiness {
            ready: false,
            reason: format!(
                "Scheduler bridge readiness is not configured ({SCHEDULER_BRIDGE_STATUS_URL_ENV}/{SCHEDULER_BRIDGE_STATUS_TOKEN_ENV} missing)"
            ),
        };
    };
    SchedulerBridgeReadinessClient::new(url, token)
        .check()
        .await
}

impl Default for AuthState {
    fn default() -> Self {
        AuthState::NotApplicable
    }
}

/// Run the pre-flight check against the current local registry. Returns
/// the list of offline ids; an empty list means the run is cleared to
/// start. Returns an Err only on filesystem failures we cannot
/// distinguish from "everything is fine"; on Err the caller should
/// FAIL CLOSED (treat the check as failing).
///
/// The legacy two-arg helper preserves the phase-2 behaviour: no auth
/// state information, only install/enable. New call sites should
/// prefer ``check_tool_servers_with_auth`` so the executor can
/// distinguish ``MissingIntegration`` from ``AuthRequired``.
pub fn check_tool_servers_available(
    tool_server_ids: &[String],
) -> anyhow::Result<Vec<OfflineToolServer>> {
    check_tool_servers_with_auth(tool_server_ids, &HashMap::new())
}

/// Round 4 / Issue 5a — same as ``check_tool_servers_available`` but
/// also considers per-server auth state. Servers whose state is
/// explicitly ``NotAuthenticated`` or ``Expired`` are flagged with the
/// matching ``OfflineReason``; missing entries (or ``NotApplicable`` /
/// ``Authenticated``) pass the auth check, which preserves the legacy
/// behavior when callers don't have auth-state data yet.
pub fn check_tool_servers_with_auth(
    tool_server_ids: &[String],
    auth_states: &HashMap<String, AuthState>,
) -> anyhow::Result<Vec<OfflineToolServer>> {
    let configs_dirs = [mcp_configs_dir().ok(), mcp_configs_user_dir().ok()]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    let toggles = load_mcp_toggles();
    check_tool_servers_against(tool_server_ids, &configs_dirs, &toggles, auth_states)
}

/// Test-friendly seam: same as ``check_tool_servers_with_auth`` but
/// reads from explicit configs dirs, toggles, and auth-state map. The
/// production wrappers above just plug in the real-world inputs.
pub fn check_tool_servers_against(
    tool_server_ids: &[String],
    configs_dirs: &[PathBuf],
    toggles: &HashMap<String, bool>,
    auth_states: &HashMap<String, AuthState>,
) -> anyhow::Result<Vec<OfflineToolServer>> {
    if tool_server_ids.is_empty() {
        return Ok(Vec::new());
    }

    let mut installed_ids = HashSet::new();
    for dir in configs_dirs {
        collect_dir_ids(dir, &mut installed_ids)?;
    }

    let mut offline = Vec::new();
    for raw_id in tool_server_ids {
        let bare = bare_server_id(raw_id);
        if !installed_ids.contains(bare) {
            offline.push(OfflineToolServer {
                id: raw_id.clone(),
                reason: OfflineReason::NotInstalled,
            });
            continue;
        }
        // ``load_mcp_toggles`` defaults missing entries to enabled
        // (matches ``assistant_tool_server_enabled`` in
        // mcp-assistant-server). We only flag a server as Disabled if
        // it is EXPLICITLY toggled false.
        if matches!(toggles.get(bare), Some(false)) {
            offline.push(OfflineToolServer {
                id: raw_id.clone(),
                reason: OfflineReason::Disabled,
            });
            continue;
        }
        // Round 4 / Issue 5a — auth-state check. We try the bare id
        // first, then fall back to the raw id (callers may store
        // either form). An entry of ``NotApplicable`` / ``Authenticated``
        // / a missing entry passes; only explicit ``NotAuthenticated``
        // / ``Expired`` fail the preflight.
        let auth_state = auth_states
            .get(bare)
            .or_else(|| auth_states.get(raw_id))
            .cloned()
            .unwrap_or_default();
        match auth_state {
            AuthState::NotAuthenticated => offline.push(OfflineToolServer {
                id: raw_id.clone(),
                reason: OfflineReason::NotAuthenticated,
            }),
            AuthState::Expired => offline.push(OfflineToolServer {
                id: raw_id.clone(),
                reason: OfflineReason::AuthExpired,
            }),
            AuthState::Authenticated | AuthState::NotApplicable => {}
        }
    }

    Ok(offline)
}

/// Round 4 / Issue 5a — does any entry indicate an auth failure (vs an
/// install/disable failure)? The executor uses this to record the
/// precise ``LastRunStatus`` for the run.
pub fn any_auth_failure(offline: &[OfflineToolServer]) -> bool {
    offline.iter().any(|item| item.reason.is_auth_failure())
}

/// Render an OfflineToolServer list as a human-readable error message
/// that's safe to put in ``last_run_error``. Lists every offending
/// integration so the user can fix them in one pass.
pub fn render_missing_integration_message(offline: &[OfflineToolServer]) -> String {
    let parts: Vec<String> = offline
        .iter()
        .map(|item| match item.reason {
            OfflineReason::NotInstalled => format!("{} (not installed)", item.id),
            OfflineReason::Disabled => format!("{} (disabled in settings)", item.id),
            OfflineReason::NotAuthenticated => {
                format!(
                    "{} (not authenticated — open Integrations to authorize)",
                    item.id
                )
            }
            OfflineReason::AuthExpired => {
                format!(
                    "{} (authentication expired — open Integrations to re-authorize)",
                    item.id
                )
            }
        })
        .collect();
    let action = if any_auth_failure(offline) {
        "Re-authorize the affected integrations and run the task again."
    } else {
        "Install or re-enable them and run the task again."
    };
    format!(
        "Aborting run: required integrations are not available: {}. {}",
        parts.join(", "),
        action,
    )
}

fn collect_dir_ids(dir: &Path, into: &mut HashSet<String>) -> anyhow::Result<()> {
    if !dir.exists() {
        return Ok(());
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(value) => value,
        Err(error) => {
            // A read failure on the configs dir is suspicious but not
            // fatal — we simply can't verify these ids. We record
            // nothing from this dir, which means an installed id
            // would be flagged as missing → fail-closed semantics.
            tracing::warn!(
                "failed to enumerate MCP configs dir {}: {error}",
                dir.display()
            );
            return Ok(());
        }
    };
    for entry in entries.flatten() {
        if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            into.insert(entry.file_name().to_string_lossy().to_string());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::fs;
    use uuid::Uuid;

    struct TempConfigs {
        root: PathBuf,
        configs_dir: PathBuf,
        user_configs_dir: PathBuf,
    }

    impl TempConfigs {
        fn new(name: &str) -> Self {
            let root = env::temp_dir().join(format!(
                "scheduling-preflight-{name}-{}",
                Uuid::new_v4().simple()
            ));
            let configs_dir = root.join("mcp-configs");
            let user_configs_dir = root.join("mcp-configs-user");
            fs::create_dir_all(&configs_dir).unwrap();
            fs::create_dir_all(&user_configs_dir).unwrap();
            Self {
                root,
                configs_dir,
                user_configs_dir,
            }
        }

        fn install(&self, id: &str, user_installed: bool) {
            let base = if user_installed {
                &self.user_configs_dir
            } else {
                &self.configs_dir
            };
            fs::create_dir_all(base.join(id)).unwrap();
        }

        fn dirs(&self) -> Vec<PathBuf> {
            vec![self.configs_dir.clone(), self.user_configs_dir.clone()]
        }
    }

    impl Drop for TempConfigs {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn empty_tool_server_ids_returns_empty_offline_list() {
        let configs = TempConfigs::new("empty");
        let result =
            check_tool_servers_against(&[], &configs.dirs(), &HashMap::new(), &HashMap::new())
                .unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn installed_and_enabled_server_passes_preflight() {
        let configs = TempConfigs::new("installed-enabled");
        configs.install("slack", false);
        let result = check_tool_servers_against(
            &["slack".to_string()],
            &configs.dirs(),
            &HashMap::new(),
            &HashMap::new(),
        )
        .unwrap();
        assert!(
            result.is_empty(),
            "expected slack to pass: got {:?}",
            result
        );
    }

    #[test]
    fn user_installed_server_also_passes_preflight() {
        let configs = TempConfigs::new("user-installed");
        configs.install("custom-mcp", true);
        let result = check_tool_servers_against(
            &["custom-mcp".to_string()],
            &configs.dirs(),
            &HashMap::new(),
            &HashMap::new(),
        )
        .unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn missing_server_is_flagged_not_installed() {
        let configs = TempConfigs::new("missing");
        let result = check_tool_servers_against(
            &["nonexistent-server".to_string()],
            &configs.dirs(),
            &HashMap::new(),
            &HashMap::new(),
        )
        .unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "nonexistent-server");
        assert_eq!(result[0].reason, OfflineReason::NotInstalled);
    }

    #[test]
    fn disabled_server_is_flagged_disabled_even_when_installed() {
        let configs = TempConfigs::new("disabled");
        configs.install("slack", false);
        let mut toggles = HashMap::new();
        toggles.insert("slack".to_string(), false);
        let result = check_tool_servers_against(
            &["slack".to_string()],
            &configs.dirs(),
            &toggles,
            &HashMap::new(),
        )
        .unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "slack");
        assert_eq!(result[0].reason, OfflineReason::Disabled);
    }

    #[test]
    fn missing_toggle_entry_defaults_to_enabled() {
        // ``load_mcp_toggles`` returns a HashMap that doesn't include
        // every server — only those the user has explicitly toggled.
        // The preflight MUST treat missing entries as enabled (default
        // behaviour) so a freshly-installed integration with no toggle
        // entry isn't flagged as Disabled.
        let configs = TempConfigs::new("default-enabled");
        configs.install("slack", false);
        let result = check_tool_servers_against(
            &["slack".to_string()],
            &configs.dirs(),
            &HashMap::new(),
            &HashMap::new(),
        )
        .unwrap();
        assert!(result.is_empty(), "no toggle entry should mean enabled");
    }

    #[test]
    fn server_prefix_is_normalized_via_bare_server_id() {
        // Some callers pass ``server:slack`` (the OWUI-style fully
        // qualified id), others pass the bare ``slack`` (the on-disk
        // directory name). The preflight must accept both.
        let configs = TempConfigs::new("prefixed");
        configs.install("slack", false);
        let result = check_tool_servers_against(
            &["server:slack".to_string()],
            &configs.dirs(),
            &HashMap::new(),
            &HashMap::new(),
        )
        .unwrap();
        assert!(
            result.is_empty(),
            "prefixed id should resolve: got {:?}",
            result
        );
    }

    #[test]
    fn multiple_offline_servers_all_surface_in_one_call() {
        let configs = TempConfigs::new("multi-offline");
        configs.install("slack", false);
        let mut toggles = HashMap::new();
        toggles.insert("slack".to_string(), false);
        let result = check_tool_servers_against(
            &[
                "slack".to_string(),
                "missing-one".to_string(),
                "missing-two".to_string(),
            ],
            &configs.dirs(),
            &toggles,
            &HashMap::new(),
        )
        .unwrap();
        assert_eq!(result.len(), 3);
        let ids_and_reasons: Vec<(String, OfflineReason)> = result
            .into_iter()
            .map(|item| (item.id, item.reason))
            .collect();
        assert!(ids_and_reasons.contains(&("slack".to_string(), OfflineReason::Disabled)));
        assert!(
            ids_and_reasons.contains(&("missing-one".to_string(), OfflineReason::NotInstalled,))
        );
        assert!(
            ids_and_reasons.contains(&("missing-two".to_string(), OfflineReason::NotInstalled,))
        );
    }

    #[test]
    fn render_missing_integration_message_includes_each_offending_id_and_reason() {
        let offline = vec![
            OfflineToolServer {
                id: "slack".to_string(),
                reason: OfflineReason::NotInstalled,
            },
            OfflineToolServer {
                id: "gmail".to_string(),
                reason: OfflineReason::Disabled,
            },
        ];
        let message = render_missing_integration_message(&offline);
        assert!(message.contains("slack (not installed)"));
        assert!(message.contains("gmail (disabled in settings)"));
        assert!(message.contains("Install or re-enable"));
    }

    // Round 4 / Issue 5a — auth-state preflight tests.

    #[test]
    fn server_with_no_auth_token_is_flagged_not_authenticated() {
        let configs = TempConfigs::new("auth-missing");
        configs.install("slack", false);
        let mut auth = HashMap::new();
        auth.insert("slack".to_string(), AuthState::NotAuthenticated);
        let result = check_tool_servers_against(
            &["slack".to_string()],
            &configs.dirs(),
            &HashMap::new(),
            &auth,
        )
        .unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "slack");
        assert_eq!(result[0].reason, OfflineReason::NotAuthenticated);
        assert!(result[0].reason.is_auth_failure());
        assert!(any_auth_failure(&result));
    }

    #[test]
    fn server_with_expired_token_is_flagged_auth_expired() {
        let configs = TempConfigs::new("auth-expired");
        configs.install("gmail", false);
        let mut auth = HashMap::new();
        auth.insert("gmail".to_string(), AuthState::Expired);
        let result = check_tool_servers_against(
            &["gmail".to_string()],
            &configs.dirs(),
            &HashMap::new(),
            &auth,
        )
        .unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].reason, OfflineReason::AuthExpired);
        assert!(result[0].reason.is_auth_failure());
    }

    #[test]
    fn server_with_authenticated_state_passes_preflight() {
        let configs = TempConfigs::new("auth-ok");
        configs.install("slack", false);
        let mut auth = HashMap::new();
        auth.insert("slack".to_string(), AuthState::Authenticated);
        let result = check_tool_servers_against(
            &["slack".to_string()],
            &configs.dirs(),
            &HashMap::new(),
            &auth,
        )
        .unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn server_with_unknown_auth_state_passes_preflight_for_compat() {
        // Auth-state map intentionally doesn't include this server.
        // We pass — caller's auth provider has no opinion (and we
        // don't want to false-flag auth-less integrations like the
        // local agent VM).
        let configs = TempConfigs::new("auth-unknown");
        configs.install("agent_vm", false);
        let result = check_tool_servers_against(
            &["agent_vm".to_string()],
            &configs.dirs(),
            &HashMap::new(),
            &HashMap::new(),
        )
        .unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn install_failure_takes_precedence_over_auth_failure() {
        // If the server isn't installed at all, we don't bother
        // emitting a confusing "and also no auth" line — install is
        // the prerequisite. Single offline entry per id.
        let configs = TempConfigs::new("auth-vs-install");
        let mut auth = HashMap::new();
        auth.insert("phantom".to_string(), AuthState::NotAuthenticated);
        let result = check_tool_servers_against(
            &["phantom".to_string()],
            &configs.dirs(),
            &HashMap::new(),
            &auth,
        )
        .unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].reason, OfflineReason::NotInstalled);
    }

    #[test]
    fn render_missing_integration_message_handles_auth_reasons() {
        let offline = vec![
            OfflineToolServer {
                id: "slack".to_string(),
                reason: OfflineReason::NotAuthenticated,
            },
            OfflineToolServer {
                id: "gmail".to_string(),
                reason: OfflineReason::AuthExpired,
            },
        ];
        let message = render_missing_integration_message(&offline);
        assert!(message.contains("slack (not authenticated"));
        assert!(message.contains("gmail (authentication expired"));
        assert!(
            message.contains("Re-authorize"),
            "auth-only failures must steer the user to re-authorize, not re-install: got {message}"
        );
    }

    #[test]
    fn render_message_keeps_install_action_when_no_auth_failures() {
        let offline = vec![OfflineToolServer {
            id: "slack".to_string(),
            reason: OfflineReason::Disabled,
        }];
        let message = render_missing_integration_message(&offline);
        assert!(message.contains("Install or re-enable"));
    }

    fn serve_bridge_status_responses(
        connection_count: usize,
        status_line: &'static str,
        body: &'static str,
    ) -> std::net::SocketAddr {
        use std::io::{Read, Write};

        let listener =
            std::net::TcpListener::bind("127.0.0.1:0").expect("failed to bind status stub");
        let addr = listener.local_addr().expect("failed to read stub address");
        std::thread::spawn(move || {
            for _ in 0..connection_count {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let mut buffer = [0u8; 2048];
                let _ = stream.read(&mut buffer);
                let response = format!(
                    "{status_line}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len(),
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        addr
    }

    #[tokio::test]
    async fn scheduler_bridge_readiness_ignores_external_client_bridge_enabled_flag() {
        // PORTICO-200: `bridgeEnabled` (the external-client bridge preference) may
        // still appear on the wire but must not gate scheduler readiness.
        let addr = serve_bridge_status_responses(
            1,
            "HTTP/1.1 200 OK",
            r#"{"success":true,"bridgeReady":true,"bridgeEnabled":false,"brokerAuthReady":true}"#,
        );
        let readiness = SchedulerBridgeReadinessClient::new(
            format!("http://{addr}/bridge/status"),
            "status-token".to_string(),
        )
        .check()
        .await;
        assert!(
            readiness.ready,
            "readiness must ignore bridgeEnabled:false, got reason: {}",
            readiness.reason
        );
    }

    #[tokio::test]
    async fn scheduler_bridge_readiness_still_fails_when_broker_auth_not_ready() {
        // `success:true` isolates the `broker_auth_ready` conjunct so this
        // test fails if that gate is ever dropped from the readiness formula.
        // `check()` retries once on a not-ready result, so serve two responses.
        let addr = serve_bridge_status_responses(
            2,
            "HTTP/1.1 200 OK",
            r#"{"success":true,"bridgeReady":true,"bridgeEnabled":true,"brokerAuthReady":false,"errorCode":"broker_auth_rejected"}"#,
        );
        let readiness = SchedulerBridgeReadinessClient::new(
            format!("http://{addr}/bridge/status"),
            "status-token".to_string(),
        )
        .check()
        .await;
        assert!(!readiness.ready);
        assert_eq!(readiness.reason, "broker_auth_rejected");
    }
}
