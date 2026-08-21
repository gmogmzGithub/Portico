use super::*;

#[test]
fn restart_guidance_covers_ready_and_starting_paths() {
    let (summary, next_steps) = single_server_restart_guidance("drive", READINESS_PHASE_TOOL_READY);
    assert!(summary.contains("tool_ready"));
    assert!(summary.contains("Use the server tools directly"));
    assert_eq!(next_steps.len(), 1);
    assert!(!next_steps[0].starts_with("Next: activate"));
    assert!(next_steps[0].contains("Only call activate_integration"));

    let (summary, next_steps) = single_server_restart_guidance("drive", READINESS_PHASE_STARTING);
    assert!(summary.contains("still starting"));
    assert_eq!(next_steps.len(), 1);
    assert!(!next_steps[0].contains("activate"));
}

#[test]
fn toggle_guidance_covers_ready_oauth_starting_and_disabled_paths() {
    let ready = toggle_integration_next_steps(true, READINESS_PHASE_TOOL_READY);
    assert_eq!(ready.len(), 1);
    assert!(ready[0].contains("activate"));

    let oauth = toggle_integration_next_steps(true, READINESS_PHASE_CHECKING_TOKENS);
    assert_eq!(oauth.len(), 1);
    assert!(oauth[0].contains("authorize"));

    let starting = toggle_integration_next_steps(true, READINESS_PHASE_STARTING);
    assert_eq!(starting.len(), 1);
    assert!(starting[0].contains("starting"));

    let disabled = toggle_integration_next_steps(false, READINESS_PHASE_DISABLED);
    assert_eq!(disabled.len(), 1);
    assert!(disabled[0].contains("Disabled"));
}

#[test]
fn toggle_not_configured_guidance_references_guided_setup() {
    let (summary, next_steps) = toggle_not_configured_guidance("calendar");
    assert!(summary.contains("calendar"));
    assert!(summary.contains("guided_setup"));
    assert_eq!(next_steps.len(), 1);
    assert!(next_steps[0].contains("guided_setup"));
}

#[test]
fn authorize_guidance_covers_all_major_branches() {
    let (summary, next_steps) =
        authorize_integration_guidance("drive", true, READINESS_PHASE_TOOL_READY, 0.0, false);
    assert!(summary.contains("tokens valid"));
    assert!(summary.contains("tool_ready"));
    assert_eq!(next_steps.len(), 1);
    assert!(next_steps[0].contains("activate"));

    let (summary, next_steps) =
        authorize_integration_guidance("drive", true, READINESS_PHASE_TOOL_READY, 0.0, true);
    assert!(summary.contains("auto-activated"));
    assert_eq!(next_steps.len(), 1);

    let (summary, next_steps) =
        authorize_integration_guidance("drive", true, READINESS_PHASE_STARTING, 2.5, false);
    assert!(summary.contains("tokens valid"));
    assert!(summary.contains("still starting"));
    assert_eq!(next_steps.len(), 1);

    let (summary, next_steps) =
        authorize_integration_guidance("drive", false, READINESS_PHASE_TOOL_READY, 1.0, false);
    assert!(summary.contains("OAuth done"));
    assert!(summary.contains("tool_ready"));
    assert_eq!(next_steps.len(), 1);

    let (summary, next_steps) =
        authorize_integration_guidance("drive", false, READINESS_PHASE_TOOL_READY, 1.0, true);
    assert!(summary.contains("auto-activated"));
    assert_eq!(next_steps.len(), 1);

    let (summary, next_steps) =
        authorize_integration_guidance("drive", false, READINESS_PHASE_STARTING, 12.3, false);
    assert!(summary.contains("12"));
    assert!(summary.contains("starting"));
    assert_eq!(next_steps.len(), 1);

    let (summary, _next_steps) = authorize_integration_guidance(
        "drive",
        false,
        READINESS_PHASE_WAITING_CALLBACK,
        8.0,
        false,
    );
    assert!(summary.contains("waiting_callback"));
}

#[test]
fn guided_setup_guidance_covers_ready_oauth_and_starting_paths() {
    let (summary, next_steps) = guided_setup_guidance("docs", READINESS_PHASE_TOOL_READY);
    assert!(summary.contains("tool_ready"));
    assert_eq!(next_steps.len(), 1);
    assert!(next_steps[0].contains("activate"));

    let (summary, next_steps) = guided_setup_guidance("docs", READINESS_PHASE_NEEDS_OAUTH);
    assert!(summary.contains("OAuth needed"));
    assert_eq!(next_steps.len(), 1);
    assert!(next_steps[0].contains("authorize"));

    let (summary, next_steps) = guided_setup_guidance("docs", READINESS_PHASE_STARTING);
    assert!(summary.contains("still starting"));
    assert_eq!(next_steps.len(), 1);
}

#[test]
fn waiting_callback_guidance_matches_oauth_recovery_copy() {
    let toggle = toggle_integration_next_steps(true, READINESS_PHASE_WAITING_CALLBACK);
    assert_eq!(toggle.len(), 1);
    assert!(toggle[0].contains("authorize"));

    let (summary, next_steps) = guided_setup_guidance("drive", READINESS_PHASE_WAITING_CALLBACK);
    assert!(summary.contains("OAuth needed"));
    assert_eq!(next_steps.len(), 1);
    assert!(next_steps[0].contains("authorize"));
}

#[test]
fn tool_specs_contain_expected_descriptions() {
    let specs: Vec<Value> =
        serde_json::from_str(include_str!("../../tool_spec.json")).expect("tool spec JSON");

    let activate_description = specs
        .iter()
        .find(|spec| spec.get("name").and_then(Value::as_str) == Some("activate_integration"))
        .and_then(|spec| spec.get("description"))
        .and_then(Value::as_str)
        .expect("activate_integration description");
    assert!(activate_description.contains("Attach enabled tool servers"));

    let toggle_description = specs
        .iter()
        .find(|spec| spec.get("name").and_then(Value::as_str) == Some("toggle_integration"))
        .and_then(|spec| spec.get("description"))
        .and_then(Value::as_str)
        .expect("toggle_integration description");
    assert!(toggle_description.contains("Enable or disable"));
}
