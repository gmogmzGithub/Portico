use super::{parse_token_response, CompatClientInfo, CompatTokenFile, CompatTokenStore};
use crate::oauth::config::OAuthConfig;
use filetime::{set_file_mtime, FileTime};
use serde_json::json;
use std::fs;
use std::time::{Duration, SystemTime};
use tempfile::tempdir;

fn temp_store(name: &str) -> CompatTokenStore {
    let root = std::env::temp_dir().join(format!(
        "mcp-orc-oauth-extra-test-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&root).unwrap();
    CompatTokenStore::with_storage_dir(name, root).unwrap()
}

fn write_token(
    store: &CompatTokenStore,
    access_token: &str,
    expires_in: Option<i64>,
    refresh_token: Option<&str>,
) {
    store
        .save_token_file(&CompatTokenFile {
            access_token: access_token.to_string(),
            token_type: Some("Bearer".to_string()),
            expires_in,
            refresh_token: refresh_token.map(str::to_string),
            scope: None,
            extra: Default::default(),
        })
        .unwrap();
}

#[test]
fn load_info_methods_report_invalid_json_and_parse_token_rejects_wrong_shape() {
    let store = temp_store("invalid-json");

    fs::write(store.client_file(), "{not-json").unwrap();
    let client_error = store.load_client_info().unwrap_err();
    assert!(client_error.to_string().contains("invalid JSON"));

    fs::write(store.token_file(), "{not-json").unwrap();
    let token_error = store.load_token_file().unwrap_err();
    assert!(token_error.to_string().contains("invalid JSON"));

    let parse_error = parse_token_response(json!("not-an-object")).unwrap_err();
    assert!(parse_error
        .to_string()
        .contains("token endpoint response is not a valid token"));
}

#[test]
fn parse_token_response_surfaces_explicit_token_endpoint_errors() {
    let parse_error = parse_token_response(json!({
        "ok": false,
        "error": "bad_redirect_uri"
    }))
    .unwrap_err();

    assert!(parse_error
        .to_string()
        .contains("token endpoint error: bad_redirect_uri"));
}

#[test]
fn parse_token_response_promotes_nested_user_token_fields() {
    let token = parse_token_response(json!({
        "ok": true,
        "user_token": {
            "id": "U123",
            "scope": "channels:read search:read",
            "access_token": "xoxp-user-token",
            "token_type": "user",
            "expires_in": 43200,
            "refresh_token": "xoxe-refresh-token"
        },
        "team": {
            "id": "T123"
        }
    }))
    .unwrap();

    assert_eq!(token.access_token, "xoxp-user-token");
    assert_eq!(token.scope.as_deref(), Some("channels:read search:read"));
    assert_eq!(token.token_type.as_deref(), Some("user"));
    assert_eq!(token.expires_in, Some(43200));
    assert_eq!(token.refresh_token.as_deref(), Some("xoxe-refresh-token"));
}

#[test]
fn parse_token_response_keeps_top_level_token_fields_when_nested_also_exists() {
    let token = parse_token_response(json!({
        "ok": true,
        "access_token": "top-level-token",
        "token_type": "Bearer",
        "expires_in": 3600,
        "refresh_token": "top-level-refresh",
        "scope": "top-level-scope",
        "user_token": {
            "access_token": "nested-token",
            "token_type": "user",
            "expires_in": 43200,
            "refresh_token": "nested-refresh",
            "scope": "nested-scope"
        }
    }))
    .unwrap();

    assert_eq!(token.access_token, "top-level-token");
    assert_eq!(token.scope.as_deref(), Some("top-level-scope"));
    assert_eq!(token.token_type.as_deref(), Some("Bearer"));
    assert_eq!(token.expires_in, Some(3600));
    assert_eq!(token.refresh_token.as_deref(), Some("top-level-refresh"));
}

#[test]
fn clear_tokens_is_idempotent_and_missing_refresh_does_not_create_one() {
    let store = temp_store("idempotent-clear");
    store.clear_tokens().unwrap();

    write_token(&store, "opaque-token", Some(300), None);
    let saved = store.load_token_file().unwrap().unwrap();
    assert_eq!(saved.refresh_token, None);

    store.clear_tokens().unwrap();
    store.clear_tokens().unwrap();
    assert!(store.load_token_file().unwrap().is_none());
}

#[test]
fn save_token_file_preserves_existing_scope_when_new_scope_is_missing() {
    let store = temp_store("preserve-scope");
    store
        .save_token_file(&CompatTokenFile {
            access_token: "old".to_string(),
            token_type: Some("Bearer".to_string()),
            expires_in: Some(300),
            refresh_token: Some("refresh".to_string()),
            scope: Some("scope-a offline_access".to_string()),
            extra: Default::default(),
        })
        .unwrap();
    store
        .save_token_file(&CompatTokenFile {
            access_token: "new".to_string(),
            token_type: Some("Bearer".to_string()),
            expires_in: Some(300),
            refresh_token: Some("refresh-2".to_string()),
            scope: None,
            extra: Default::default(),
        })
        .unwrap();

    let saved = store.load_token_file().unwrap().unwrap();
    assert_eq!(saved.refresh_token.as_deref(), Some("refresh-2"));
    assert_eq!(saved.scope.as_deref(), Some("scope-a offline_access"));
}

#[test]
fn load_status_covers_public_clients_same_origin_audience_and_unrefreshable_expiry() {
    let store = temp_store("public-client");
    store
        .save_client_info(&CompatClientInfo {
            client_id: "client".to_string(),
            token_endpoint_auth_method: Some("none".to_string()),
            ..Default::default()
        })
        .unwrap();

    write_token(
        &store,
        "eyJhbGciOiJub25lIn0.eyJhdWQiOiJodHRwczovL2V4YW1wbGUudGVzdC9hcGkiLCJleHAiOjk5OTk5OTk5OTl9.",
        Some(3600),
        Some("refresh"),
    );
    let same_origin_config = OAuthConfig::from_value(&json!({
        "resource": "https://example.test"
    }))
    .unwrap();
    let status = store
        .load_status(&same_origin_config, &[])
        .unwrap()
        .unwrap();
    assert!(!status.audience_mismatch);
    assert!(status.can_refresh);
    assert!(store.has_usable_tokens(&same_origin_config, &[]).unwrap());

    let expired_store = temp_store("expired-no-refresh");
    expired_store
        .save_client_info(&CompatClientInfo {
            client_id: "client".to_string(),
            token_endpoint_auth_method: Some("client_secret_post".to_string()),
            ..Default::default()
        })
        .unwrap();
    write_token(&expired_store, "opaque-token", Some(1), Some("refresh"));
    let old_time = FileTime::from_system_time(SystemTime::now() - Duration::from_secs(300));
    set_file_mtime(expired_store.token_file(), old_time).unwrap();
    let empty_config = OAuthConfig::from_value(&json!({})).unwrap();
    let expired_status = expired_store
        .load_status(&empty_config, &[])
        .unwrap()
        .unwrap();
    assert!(expired_status.is_expired);
    assert!(!expired_status.can_refresh);
    assert!(!expired_store.has_usable_tokens(&empty_config, &[]).unwrap());
}

#[test]
fn load_status_allows_configured_scope_gaps_without_challenge_requirements() {
    let store = temp_store("scope-mismatch");
    store
        .save_client_info(&CompatClientInfo {
            client_id: "client".to_string(),
            token_endpoint_auth_method: Some("none".to_string()),
            ..Default::default()
        })
        .unwrap();
    store
        .save_token_file(&CompatTokenFile {
            access_token: "opaque-token".to_string(),
            token_type: Some("Bearer".to_string()),
            expires_in: Some(3600),
            refresh_token: Some("refresh".to_string()),
            scope: Some("offline_access".to_string()),
            extra: Default::default(),
        })
        .unwrap();

    let config = OAuthConfig::from_value(&json!({
        "scopes": ["scope-a", "offline_access"]
    }))
    .unwrap();
    let status = store.load_status(&config, &[]).unwrap().unwrap();
    assert!(!status.scope_mismatch);
    assert!(store.has_usable_tokens(&config, &[]).unwrap());
}

#[test]
fn load_status_rejects_missing_persisted_discovered_challenge_scope() {
    let store = temp_store("discovered-scope-mismatch");
    store
        .save_client_info(&CompatClientInfo {
            client_id: "client".to_string(),
            token_endpoint_auth_method: Some("none".to_string()),
            ..Default::default()
        })
        .unwrap();
    store
        .save_token_file(&CompatTokenFile {
            access_token: "opaque-token".to_string(),
            token_type: Some("Bearer".to_string()),
            expires_in: Some(3600),
            refresh_token: Some("refresh".to_string()),
            scope: Some("offline_access".to_string()),
            extra: Default::default(),
        })
        .unwrap();

    let config = OAuthConfig::from_value(&json!({
        "discovered": true,
        "scopes": ["scope-a", "offline_access"]
    }))
    .unwrap();
    let required_scopes = config.persisted_discovered_challenge_scopes();
    let status = store
        .load_status(&config, &required_scopes)
        .unwrap()
        .unwrap();
    assert!(status.scope_mismatch);
    assert!(!store.has_usable_tokens(&config, &required_scopes).unwrap());
}

#[test]
fn load_status_covers_jwt_without_exp_and_path_mismatch_without_refresh() {
    let store = temp_store("jwt-no-exp");
    store
        .save_client_info(&CompatClientInfo {
            client_id: "client".to_string(),
            token_endpoint_auth_method: Some("none".to_string()),
            ..Default::default()
        })
        .unwrap();
    write_token(
        &store,
        "eyJhbGciOiJub25lIn0.eyJhdWQiOlsiaHR0cHM6Ly9leGFtcGxlLnRlc3QvYXBpIl19.",
        Some(120),
        None,
    );
    let old_time = FileTime::from_system_time(SystemTime::now() - Duration::from_secs(300));
    set_file_mtime(store.token_file(), old_time).unwrap();
    let no_resource = OAuthConfig::from_value(&json!({})).unwrap();
    let status = store.load_status(&no_resource, &[]).unwrap().unwrap();
    assert_eq!(status.expires_in, Some(120));
    assert!(!status.is_expired);

    let mismatch_store = temp_store("path-mismatch-no-refresh");
    mismatch_store
        .save_client_info(&CompatClientInfo {
            client_id: "client".to_string(),
            token_endpoint_auth_method: Some("none".to_string()),
            ..Default::default()
        })
        .unwrap();
    write_token(
        &mismatch_store,
        "eyJhbGciOiJub25lIn0.eyJhdWQiOiJodHRwczovL2V4YW1wbGUudGVzdC9hcGkifQ.",
        Some(120),
        None,
    );
    let mismatch_config = OAuthConfig::from_value(&json!({
        "resource": "https://example.test/mcp/default"
    }))
    .unwrap();
    let mismatch_status = mismatch_store
        .load_status(&mismatch_config, &[])
        .unwrap()
        .unwrap();
    assert!(mismatch_status.audience_mismatch);
    assert!(!mismatch_status.can_refresh);
    assert!(!mismatch_store
        .has_usable_tokens(&mismatch_config, &[])
        .unwrap());
}

#[test]
fn token_store_reads_saved_client_info_round_trip() {
    let store = temp_store("client-round-trip");
    let config = OAuthConfig::from_value(&json!({})).unwrap();
    assert!(!store.has_usable_tokens(&config, &[]).unwrap());

    let temp = tempdir().unwrap();
    store
        .save_client_info(&CompatClientInfo {
            client_id: "roundtrip-client".to_string(),
            client_secret: Some("secret".to_string()),
            redirect_uris: vec![temp.path().display().to_string()],
            ..Default::default()
        })
        .unwrap();
    let saved = store.load_client_info().unwrap().unwrap();
    assert_eq!(saved.client_id, "roundtrip-client");
    assert_eq!(saved.client_secret.as_deref(), Some("secret"));
}

#[test]
fn load_client_info_removes_unsupported_localhost_callback_uris() {
    let store = temp_store("sanitize-client-redirects");
    fs::write(
        store.client_file(),
        serde_json::to_vec(&CompatClientInfo {
            client_id: "client".to_string(),
            redirect_uris: vec![
                "http://localhost:3996/callback".to_string(),
                "http://localhost:3834/callback".to_string(),
                "http://localhost:3836/callback".to_string(),
            ],
            ..Default::default()
        })
        .unwrap(),
    )
    .unwrap();

    let client_info = store.load_client_info().unwrap().unwrap();

    assert_eq!(
        client_info.redirect_uris,
        vec![
            "http://localhost:3834/callback".to_string(),
            "http://localhost:3836/callback".to_string(),
        ]
    );
    let persisted = store.load_client_info().unwrap().unwrap();
    assert_eq!(persisted.redirect_uris, client_info.redirect_uris);
}

#[test]
fn load_client_info_drops_cache_with_only_unsupported_localhost_callbacks() {
    let store = temp_store("drop-unsupported-client-redirects");
    fs::write(
        store.client_file(),
        serde_json::to_vec(&CompatClientInfo {
            client_id: "client".to_string(),
            redirect_uris: vec!["http://localhost:3996/callback".to_string()],
            ..Default::default()
        })
        .unwrap(),
    )
    .unwrap();

    assert!(store.load_client_info().unwrap().is_none());
    assert!(!store.client_file().exists());
}

#[test]
fn save_methods_recreate_missing_storage_directory() {
    let root = tempdir().unwrap();
    let store = CompatTokenStore::with_storage_dir("recreate-dir", root.path()).unwrap();

    fs::remove_dir_all(root.path()).unwrap();

    store
        .save_client_info(&CompatClientInfo {
            client_id: "recreated-client".to_string(),
            ..Default::default()
        })
        .unwrap();
    store
        .save_token_file(&CompatTokenFile {
            access_token: "opaque-token".to_string(),
            token_type: Some("Bearer".to_string()),
            expires_in: Some(300),
            refresh_token: Some("refresh".to_string()),
            scope: None,
            extra: Default::default(),
        })
        .unwrap();

    assert_eq!(
        store.load_client_info().unwrap().unwrap().client_id,
        "recreated-client"
    );
    assert_eq!(
        store.load_token_file().unwrap().unwrap().access_token,
        "opaque-token"
    );
}
