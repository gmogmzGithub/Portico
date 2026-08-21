use super::{CompatClientInfo, CompatTokenFile, CompatTokenStore};

#[test]
fn memory_storage_preserves_tokens_refresh_token_and_client_info() {
    let store = CompatTokenStore::with_storage_type("memory-parity", Some("memory")).unwrap();

    store
        .save_client_info(&CompatClientInfo {
            client_id: "client".to_string(),
            token_endpoint_auth_method: Some("client_secret_post".to_string()),
            client_secret: Some("secret".to_string()),
            ..Default::default()
        })
        .unwrap();
    store
        .save_token_file(&CompatTokenFile {
            access_token: "first-token".to_string(),
            token_type: Some("Bearer".to_string()),
            expires_in: Some(300),
            refresh_token: Some("refresh-token".to_string()),
            scope: None,
            extra: Default::default(),
        })
        .unwrap();
    store
        .save_token_file(&CompatTokenFile {
            access_token: "second-token".to_string(),
            token_type: Some("Bearer".to_string()),
            expires_in: Some(300),
            refresh_token: None,
            scope: None,
            extra: Default::default(),
        })
        .unwrap();

    let client_info = store.load_client_info().unwrap().unwrap();
    assert_eq!(client_info.client_id, "client");

    let token = store.load_token_file().unwrap().unwrap();
    assert_eq!(token.access_token, "second-token");
    assert_eq!(token.refresh_token.as_deref(), Some("refresh-token"));

    store.clear_tokens().unwrap();
    assert!(store.load_token_file().unwrap().is_none());
    assert!(store.load_client_info().unwrap().is_some());
}

#[test]
fn rejects_unknown_storage_type() {
    let error = CompatTokenStore::with_storage_type("bad-storage", Some("sqlite")).unwrap_err();
    assert!(error.to_string().contains("unsupported oauth storage_type"));
}
