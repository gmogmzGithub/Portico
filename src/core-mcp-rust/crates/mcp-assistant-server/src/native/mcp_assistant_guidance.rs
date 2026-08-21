use super::*;

pub(super) fn single_server_restart_guidance(
    _server_id: &str,
    readiness_phase: &str,
) -> (String, Vec<String>) {
    if readiness_phase == READINESS_PHASE_TOOL_READY {
        (
            "Restart complete. tool_ready. Use the server tools directly if they are already attached to this chat.".to_string(),
            vec!["Only call activate_integration if get_chat_tools shows this server is missing from the current chat.".to_string()],
        )
    } else {
        (
            "Restart complete but still starting.".to_string(),
            vec!["Server still starting; wait for tool_ready before using its tools.".to_string()],
        )
    }
}

pub(super) fn toggle_integration_next_steps(enabled: bool, readiness_phase: &str) -> Vec<String> {
    if enabled && readiness_phase == READINESS_PHASE_TOOL_READY {
        vec!["tool_ready. Next: activate(chat_id, [server:ID]).".to_string()]
    } else if enabled
        && matches!(
            readiness_phase,
            READINESS_PHASE_CHECKING_TOKENS
                | READINESS_PHASE_NEEDS_OAUTH
                | READINESS_PHASE_WAITING_CALLBACK
        )
    {
        vec!["OAuth needed. Next: authorize(server_id, chat_id).".to_string()]
    } else if enabled {
        vec!["Still starting. Call authorize_integration or activate_integration — they will wait for readiness automatically.".to_string()]
    } else {
        vec!["Disabled. Tools removed.".to_string()]
    }
}

pub(super) fn toggle_not_configured_guidance(server_id: &str) -> (String, Vec<String>) {
    (
        format!("Not configured. Next: trigger_guided_setup(server_id=\"{server_id}\")."),
        vec![format!(
            "Call trigger_guided_setup(server_id=\"{server_id}\")."
        )],
    )
}

pub(super) fn toggle_saved_secret_unavailable_guidance(server_id: &str) -> (String, Vec<String>) {
    if server_id == "snowflake" {
        return (
            "The saved Snowflake connection is unavailable. Replace it securely before enabling Snowflake; do not open generic guided setup and do not retry the current toggle.".to_string(),
            vec![
                "Continue the active Snowflake setup skill's Secure PAT flow: collect a fresh PAT in the masked dialog plus the LDAP username, replace only connections.toml, and validate it.".to_string(),
                "After validation succeeds, enable Snowflake exactly once and then activate server:snowflake for this chat when tool_ready.".to_string(),
                "Do not call mcp_assistant_trigger_guided_setup and do not ask the user to paste the PAT in chat.".to_string(),
            ],
        );
    }

    (
        format!(
            "The saved secure configuration for {server_id} is unavailable. Follow its setup or repair skill to replace the credential securely; do not retry the toggle or open generic guided setup."
        ),
        vec![
            "Continue the integration-specific secure credential replacement flow.".to_string(),
            "Do not call mcp_assistant_trigger_guided_setup or retry the current toggle.".to_string(),
        ],
    )
}

pub(super) fn authorize_integration_guidance(
    server_id: &str,
    already_authorized: bool,
    readiness_phase: &str,
    waited_seconds: f64,
    auto_activated: bool,
) -> (String, Vec<String>) {
    if already_authorized {
        if readiness_phase == READINESS_PHASE_TOOL_READY {
            if auto_activated {
                (
                    format!("{server_id}: tokens valid, tool_ready, auto-activated."),
                    vec!["Proceed with tools.".to_string()],
                )
            } else {
                (
                    format!("{server_id}: tokens valid, tool_ready."),
                    vec!["Next: activate(chat_id, [server:ID]).".to_string()],
                )
            }
        } else {
            (
                format!("{server_id}: tokens valid but still starting."),
                vec![format!(
                    "activate() will wait up to {:.0}s.",
                    ACTIVATION_WAIT_SECONDS
                )],
            )
        }
    } else if readiness_phase == READINESS_PHASE_TOOL_READY {
        if auto_activated {
            (
                format!("{server_id}: OAuth done, tool_ready, auto-activated."),
                vec!["Proceed with tools.".to_string()],
            )
        } else {
            (
                format!("{server_id}: OAuth done, tool_ready."),
                vec!["Next: activate(chat_id, [server:ID]).".to_string()],
            )
        }
    } else {
        (
            format!(
                "{server_id}: OAuth done but not ready after {waited_seconds:.0}s (phase: {readiness_phase})."
            ),
            vec!["Tell user auth succeeded but server still starting.".to_string()],
        )
    }
}

pub(super) fn guided_setup_guidance(
    server_id: &str,
    readiness_phase: &str,
) -> (String, Vec<String>) {
    if readiness_phase == READINESS_PHASE_TOOL_READY {
        (
            format!("{server_id}: configured, tool_ready."),
            vec!["Next: activate(chat_id, [server:ID]).".to_string()],
        )
    } else if matches!(
        readiness_phase,
        READINESS_PHASE_CHECKING_TOKENS
            | READINESS_PHASE_NEEDS_OAUTH
            | READINESS_PHASE_WAITING_CALLBACK
    ) {
        (
            format!("{server_id}: configured, OAuth needed."),
            vec!["Next: authorize(server_id, chat_id).".to_string()],
        )
    } else {
        (
            format!("{server_id}: configured but still starting."),
            vec![format!(
                "activate() will wait up to {:.0}s.",
                ACTIVATION_WAIT_SECONDS
            )],
        )
    }
}

#[cfg(test)]
#[path = "mcp_assistant_guidance_tests.rs"]
mod tests;
