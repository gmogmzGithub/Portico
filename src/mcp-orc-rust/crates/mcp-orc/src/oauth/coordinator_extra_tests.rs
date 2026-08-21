use super::{OAuthCoordinator, OAuthState};

#[test]
fn oauth_state_strings_cover_every_variant() {
    let all = [
        (OAuthState::Pending, "pending"),
        (OAuthState::Checking, "checking"),
        (OAuthState::Active, "active"),
        (OAuthState::WaitingCallback, "waiting_callback"),
        (OAuthState::Completed, "completed"),
        (OAuthState::Failed, "failed"),
        (OAuthState::Timeout, "timeout"),
    ];
    for (state, expected) in all {
        assert_eq!(state.as_str(), expected);
    }
}

#[tokio::test]
async fn register_and_lookup_helpers_cover_missing_and_invalid_state_cases() {
    let coordinator = OAuthCoordinator::new();
    coordinator.register_handshake("glean").await;
    coordinator
        .set_authorization_url("glean", "not-a-valid-url".to_string(), false)
        .await;

    let current = coordinator.current().await.unwrap();
    assert_eq!(current.server_name, "glean");
    assert_eq!(current.state, OAuthState::Active);
    assert_eq!(current.state_param, None);
    assert_eq!(coordinator.server_for_state("missing").await, None);
    assert!(coordinator
        .get_handshake_by_state(Some("missing"))
        .await
        .is_none());
    assert_eq!(coordinator.authorization_url_for("unknown").await, None);

    let current_json = coordinator.current_json().await;
    assert_eq!(current_json["current"]["server_name"], "glean");
    assert_eq!(current_json["current"]["has_auth_context"], false);
}

#[tokio::test]
async fn non_transient_states_do_not_change_on_mark_connected_or_missing_updates() {
    let coordinator = OAuthCoordinator::new();

    coordinator.mark_waiting_callback("missing").await;
    coordinator.mark_completed("missing").await;
    assert!(coordinator.get_handshake("missing").await.is_none());

    coordinator.mark_failed("failed", "boom").await;
    coordinator.mark_connected("failed").await;
    assert_eq!(
        coordinator.get_handshake("failed").await.unwrap().state,
        OAuthState::Failed
    );

    coordinator.mark_timeout("slow", "timed out").await;
    coordinator.mark_connected("slow").await;
    assert_eq!(
        coordinator.get_handshake("slow").await.unwrap().state,
        OAuthState::Timeout
    );

    coordinator.register_handshake("pending").await;
    coordinator.mark_connected("pending").await;
    let pending = coordinator.get_handshake("pending").await.unwrap();
    assert_eq!(pending.state, OAuthState::Completed);
    assert!(pending.completed_at.is_some());
}

#[tokio::test]
async fn repeated_registration_preserves_existing_active_handshake() {
    let coordinator = OAuthCoordinator::new();
    coordinator.register_handshake("demo").await;
    coordinator
        .set_authorization_url(
            "demo",
            "https://example.test/authorize?state=abc123".to_string(),
            true,
        )
        .await;

    coordinator.register_handshake("demo").await;
    let handshake = coordinator.get_handshake("demo").await.unwrap();
    assert_eq!(handshake.state, OAuthState::Active);
    assert_eq!(
        handshake.authorization_url.as_deref(),
        Some("https://example.test/authorize?state=abc123")
    );
    assert_eq!(handshake.state_param.as_deref(), Some("abc123"));
    assert!(handshake.started_at.is_some());
    assert_eq!(coordinator.current_server().await.as_deref(), Some("demo"));
}

#[tokio::test]
async fn checking_clears_callback_artifacts_and_validation_failure_is_terminal() {
    let coordinator = OAuthCoordinator::new();
    coordinator.register_handshake("demo").await;
    coordinator
        .set_authorization_url(
            "demo",
            "https://example.test/authorize?state=abc123".to_string(),
            true,
        )
        .await;

    coordinator.mark_checking("demo").await;
    let checking = coordinator.get_handshake("demo").await.unwrap();
    assert_eq!(checking.state, OAuthState::Checking);
    assert!(checking.authorization_url.is_none());
    assert!(checking.state_param.is_none());
    assert_eq!(coordinator.current_server().await, None);

    coordinator
        .mark_validation_failed("demo", "token rejected")
        .await;
    let failed = coordinator.get_handshake("demo").await.unwrap();
    assert_eq!(failed.state, OAuthState::Failed);
    assert_eq!(failed.error_message.as_deref(), Some("token rejected"));

    coordinator
        .mark_validation_failed("demo", "must not overwrite")
        .await;
    assert_eq!(
        coordinator
            .get_handshake("demo")
            .await
            .unwrap()
            .error_message
            .as_deref(),
        Some("token rejected")
    );
}

#[tokio::test]
async fn active_handshake_ignores_duplicate_authorization_urls() {
    let coordinator = OAuthCoordinator::new();
    coordinator.register_handshake("demo").await;
    coordinator
        .set_authorization_url(
            "demo",
            "https://example.test/authorize?state=original".to_string(),
            true,
        )
        .await;
    coordinator.mark_waiting_callback("demo").await;
    coordinator
        .set_authorization_url(
            "demo",
            "https://example.test/authorize?state=replaced".to_string(),
            true,
        )
        .await;

    let handshake = coordinator.get_handshake("demo").await.unwrap();
    assert_eq!(handshake.state, OAuthState::WaitingCallback);
    assert_eq!(
        handshake.authorization_url.as_deref(),
        Some("https://example.test/authorize?state=original")
    );
    assert_eq!(handshake.state_param.as_deref(), Some("original"));
}
