use super::{CredentialSourceConfig, EnvGuard, OAuthConfig};
use serde_json::json;
use serial_test::serial;
use std::fs;
use tempfile::tempdir;

#[test]
fn from_value_rejects_invalid_shapes_and_splits_metadata_scope_whitespace() {
    let error = OAuthConfig::from_value(&json!({
        "client_metadata": "wrong-shape"
    }))
    .unwrap_err();
    assert!(error.to_string().contains("invalid oauth config"));

    let config = OAuthConfig::from_value(&json!({
        "client_metadata": {
            "scope": "  openid \n offline_access   profile  "
        }
    }))
    .unwrap();
    assert_eq!(
        config.configured_scopes(),
        vec![
            "openid".to_string(),
            "offline_access".to_string(),
            "profile".to_string(),
        ]
    );
}

#[tokio::test]
#[serial]
async fn env_and_file_sources_cover_default_vars_overrides_and_invalid_json() {
    let _env = EnvGuard::capture(&["OAUTH_CLIENT_ID", "OAUTH_CLIENT_SECRET"]);
    std::env::set_var("OAUTH_CLIENT_ID", "default-client");
    std::env::set_var("OAUTH_CLIENT_SECRET", "default-secret");

    let default_env: CredentialSourceConfig = serde_json::from_value(json!({
        "type": "env",
        "scopes": ["openid"]
    }))
    .unwrap();
    let default_loaded = default_env.load().await.unwrap();
    assert_eq!(default_loaded.client_id, "default-client");
    assert_eq!(
        default_loaded.client_secret.as_deref(),
        Some("default-secret")
    );
    assert_eq!(default_loaded.scopes, vec!["openid".to_string()]);

    std::env::remove_var("OAUTH_CLIENT_SECRET");
    let missing_secret_error = default_env.load().await.unwrap_err();
    assert!(missing_secret_error
        .to_string()
        .contains("missing environment variable 'OAUTH_CLIENT_SECRET'"));

    let dir = tempdir().unwrap();
    let file_path = dir.path().join("creds.json");
    fs::write(
        &file_path,
        r#"{"client_id":"file-client","client_secret":"file-secret","scopes":["from-file"]}"#,
    )
    .unwrap();
    let override_file: CredentialSourceConfig = serde_json::from_value(json!({
        "type": "file",
        "path": file_path,
        "scopes": ["override-scope"]
    }))
    .unwrap();
    let override_loaded = override_file.load().await.unwrap();
    assert_eq!(override_loaded.scopes, vec!["override-scope".to_string()]);

    let invalid_path = dir.path().join("bad.json");
    fs::write(&invalid_path, "{not-json").unwrap();
    let invalid_file: CredentialSourceConfig = serde_json::from_value(json!({
        "type": "file",
        "path": invalid_path
    }))
    .unwrap();
    let invalid_error = invalid_file.load().await.unwrap_err();
    assert!(invalid_error.to_string().contains("invalid JSON"));
}

#[tokio::test]
async fn bundled_source_covers_tuple_custom_function_and_error_paths() {
    let dir = tempdir().unwrap();

    let tuple_path = dir.path().join("tuple_creds.py");
    fs::write(
        &tuple_path,
        concat!(
            "def provide_creds():\n",
            "    return ('tuple-client', 'tuple-secret')\n",
        ),
    )
    .unwrap();
    let tuple_source: CredentialSourceConfig = serde_json::from_value(json!({
        "type": "bundled",
        "module_path": tuple_path,
        "function_name": "provide_creds",
        "scopes": ["offline_access"]
    }))
    .unwrap();
    let tuple_loaded = tuple_source.load().await.unwrap();
    assert_eq!(tuple_loaded.client_id, "tuple-client");
    assert_eq!(tuple_loaded.client_secret.as_deref(), Some("tuple-secret"));
    assert_eq!(tuple_loaded.scopes, vec!["offline_access".to_string()]);

    let constant_tuple_path = dir.path().join("constant_tuple.py");
    fs::write(
        &constant_tuple_path,
        concat!(
            "PORTICO_CLIENT_ID = (\n",
            "    \"tuple-const-client\"\n",
            ")\n",
            "PORTICO_CLIENT_SECRET = \"tuple-const-secret\"\n",
            "\n",
            "def get_bundled_credentials():\n",
            "    return PORTICO_CLIENT_ID, PORTICO_CLIENT_SECRET\n",
        ),
    )
    .unwrap();
    let constant_tuple_source: CredentialSourceConfig = serde_json::from_value(json!({
        "type": "bundled",
        "module_path": constant_tuple_path
    }))
    .unwrap();
    let constant_tuple_loaded = constant_tuple_source.load().await.unwrap();
    assert_eq!(constant_tuple_loaded.client_id, "tuple-const-client");
    assert_eq!(
        constant_tuple_loaded.client_secret.as_deref(),
        Some("tuple-const-secret")
    );

    let dict_return_path = dir.path().join("dict_creds.py");
    fs::write(
        &dict_return_path,
        concat!(
            "CLIENT_ID = \"dict-client\"\n",
            "CLIENT_SECRET = \"dict-secret\"\n",
            "\n",
            "def get_bundled_credentials():\n",
            "    return {\n",
            "        'client_id': CLIENT_ID,\n",
            "        'client_secret': CLIENT_SECRET,\n",
            "    }\n",
        ),
    )
    .unwrap();
    let dict_return_source: CredentialSourceConfig = serde_json::from_value(json!({
        "type": "bundled",
        "module_path": dict_return_path
    }))
    .unwrap();
    let dict_return_loaded = dict_return_source.load().await.unwrap();
    assert_eq!(dict_return_loaded.client_id, "dict-client");
    assert_eq!(
        dict_return_loaded.client_secret.as_deref(),
        Some("dict-secret")
    );

    let invalid_return_path = dir.path().join("invalid_return.py");
    fs::write(
        &invalid_return_path,
        concat!("def get_bundled_credentials():\n", "    return 'nope'\n",),
    )
    .unwrap();
    let invalid_return_source: CredentialSourceConfig = serde_json::from_value(json!({
        "type": "bundled",
        "module_path": invalid_return_path
    }))
    .unwrap();
    let invalid_return_error = invalid_return_source.load().await.unwrap_err();
    assert!(invalid_return_error
        .to_string()
        .contains("Unsupported bundled credential return type"));

    let missing_client_path = dir.path().join("missing_client.py");
    fs::write(
        &missing_client_path,
        concat!(
            "def get_bundled_credentials():\n",
            "    return {'client_secret': 'secret-only'}\n",
        ),
    )
    .unwrap();
    let missing_client_source: CredentialSourceConfig = serde_json::from_value(json!({
        "type": "bundled",
        "module_path": missing_client_path
    }))
    .unwrap();
    let missing_client_error = missing_client_source.load().await.unwrap_err();
    assert!(missing_client_error
        .to_string()
        .contains("bundled credentials missing client_id"));

    let missing_function_path = dir.path().join("missing_function.py");
    fs::write(&missing_function_path, "CLIENT_ID = 'abc'\n").unwrap();
    let missing_function_source: CredentialSourceConfig = serde_json::from_value(json!({
        "type": "bundled",
        "module_path": missing_function_path
    }))
    .unwrap();
    let missing_function_error = missing_function_source.load().await.unwrap_err();
    assert!(missing_function_error
        .to_string()
        .contains("function 'get_bundled_credentials' not found"));
}

#[test]
#[serial]
fn callback_port_and_redirect_uris_cover_invalid_env_and_default_fallbacks() {
    let _env = EnvGuard::capture(&[
        "MCPO_OAUTH_CALLBACK_PORT",
        "OAUTH_CALLBACK_PORT",
        "MCPO_OAUTH_COMPAT_CALLBACK_PORTS",
    ]);
    std::env::set_var("MCPO_OAUTH_CALLBACK_PORT", "not-a-port");
    std::env::set_var("OAUTH_CALLBACK_PORT", "also-bad");
    std::env::set_var("MCPO_OAUTH_COMPAT_CALLBACK_PORTS", "3834, 3834, ,invalid");

    let config = OAuthConfig::from_value(&json!({
        "scopes": ["tool.read", "tool.write"]
    }))
    .unwrap();
    assert_eq!(config.callback_port(), 3834);
    assert_eq!(
        config.redirect_uris(),
        vec![
            "http://localhost:3834/callback".to_string(),
            "http://localhost:3836/callback".to_string(),
        ]
    );
    assert_eq!(
        config.configured_scopes(),
        vec!["tool.read".to_string(), "tool.write".to_string()]
    );

    let discovery = OAuthConfig::from_value(&json!({})).unwrap();
    assert_eq!(
        discovery.discovery_base("https://fallback.example"),
        "https://fallback.example"
    );
    assert_eq!(
        discovery.resource_url("https://fallback.example"),
        "https://fallback.example"
    );
    assert!(!discovery.infer_resource_from_url());
}

#[test]
fn configured_resource_and_legacy_infer_flag_are_normalized() {
    let config = OAuthConfig::from_value(&json!({
        "resource": "  https://example.test/mcp/default/  ",
        "infer_resource_from_url": true
    }))
    .unwrap();
    assert_eq!(
        config.configured_resource().as_deref(),
        Some("https://example.test/mcp/default/")
    );
    assert!(config.infer_resource_from_url());
}

#[test]
fn google_provider_gets_static_endpoint_fallback() {
    let google = OAuthConfig::from_value(&json!({
        "server_url": "https://accounts.google.com"
    }))
    .unwrap();
    assert_eq!(
        google.fallback_authorization_endpoints(),
        Some((
            "https://accounts.google.com/o/oauth2/v2/auth",
            "https://oauth2.googleapis.com/token"
        ))
    );

    let other = OAuthConfig::from_value(&json!({
        "server_url": "https://example.test"
    }))
    .unwrap();
    assert_eq!(other.fallback_authorization_endpoints(), None);
}
