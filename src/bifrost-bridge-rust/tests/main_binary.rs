use axum::{routing::get, Json, Router};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::oneshot;

const LOCAL_API_KEY: &str = "bifrost-local-test-key-with-distinct-purpose";
const ULTRA_SIGNING_SECRET: &str =
    "ultra-sign-v1-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";

struct MockServer {
    base_url: String,
    shutdown: Option<oneshot::Sender<()>>,
    handle: Option<tokio::task::JoinHandle<()>>,
}

impl MockServer {
    async fn shutdown(mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(handle) = self.handle.take() {
            let _ = handle.await;
        }
    }
}

impl Drop for MockServer {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(handle) = self.handle.as_ref() {
            if !handle.is_finished() {
                handle.abort();
            }
        }
    }
}

fn temp_path(name: &str, ext: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("bifrost-bridge-binary-{name}-{nanos}.{ext}"))
}

fn reserve_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    port
}

async fn start_mock_bifrost() -> MockServer {
    let app = Router::new()
        .route("/health", get(|| async { Json(json!({"ok": true})) }))
        .route(
            "/v1/models",
            get(|| async { Json(json!({"object":"list","data":[{"id":"gpt-4.1"}]})) }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let handle = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    MockServer {
        base_url: format!("http://{}", addr),
        shutdown: Some(shutdown_tx),
        handle: Some(handle),
    }
}

#[tokio::test]
async fn binary_main_starts_and_shuts_down_cleanly() {
    let mock_bifrost = start_mock_bifrost().await;
    let config_path = temp_path("model-catalog", "yaml");
    let config_output_path = temp_path("bifrost-config", "json");
    fs::write(
        &config_path,
        r#"
x-headers: &headers
  x-portico-userid: os.environ/PORTICO_USER_ID
  x-portico-redact-allow: os.environ/PORTICO_REDACT_ALLOW
  x-portico-appid: portico
  x-portico-track: os.environ/PORTICO_BUILD_TRACK
  x-portico-log-request: "false"
  x-portico-log-response: "false"
  Content-Type: application/json
model_list:
  - model_name: GPT-4.1
    litellm_params:
      model: gpt-4.1
      api_base: https://api.openai.com/v1
      extra_headers: *headers
"#,
    )
    .unwrap();

    let port = reserve_port();
    let bind_addr = format!("127.0.0.1:{port}");
    let child = Command::new(env!("CARGO_BIN_EXE_bifrost-bridge"))
        .env("MODEL_CATALOG_PATH", &config_path)
        .env("BIFROST_CONFIG_OUTPUT", &config_output_path)
        .env("BIFROST_BRIDGE_BIND", &bind_addr)
        .env("BIFROST_BASE_URL", &mock_bifrost.base_url)
        .env("LLM_PROXY_BASE_URL", "http://127.0.0.1:9")
        .env("BIFROST_BRIDGE_ADVERTISED_HOST", &bind_addr)
        .env("PORTICO_LLM_API_KEY", "key")
        .env("BIFROST_BRIDGE_LOCAL_API_KEY", LOCAL_API_KEY)
        .env("ULTRA_MULTI_AGENT_SIGNING_SECRET", ULTRA_SIGNING_SECRET)
        .env("PORTICO_USER_ID", "user")
        .env("PORTICO_REDACT_ALLOW", "*")
        .env("PORTICO_BUILD_TRACK", "dev-build")
        .env("PORTICO_APP_ID", "portico")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    let client = reqwest::Client::builder().use_rustls_tls().build().unwrap();
    let health_url = format!("http://{bind_addr}/health");
    let models_url = format!("http://{bind_addr}/v1/models");

    let mut healthy = None;
    for _ in 0..50 {
        if let Ok(response) = client.get(&health_url).send().await {
            if response.status().is_success() {
                healthy = Some(response.json::<Value>().await.unwrap());
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    let Some(health_payload) = healthy else {
        let _ = Command::new("kill")
            .args(["-TERM", &child.id().to_string()])
            .status();
        let output = child.wait_with_output().unwrap();
        panic!(
            "bridge did not become healthy\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    };

    assert_eq!(health_payload["status"], json!("ok"));
    assert_eq!(health_payload["bifrost_ready"], json!(true));
    assert_eq!(health_payload["model_count"], json!(1));

    let models = client
        .get(&models_url)
        .bearer_auth(LOCAL_API_KEY)
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(models["data"][0]["id"], json!("GPT-4.1"));

    let bifrost_config: Value =
        serde_json::from_str(&fs::read_to_string(&config_output_path).unwrap()).unwrap();
    assert_eq!(
        bifrost_config["providers"]["openai"]["network_config"]["base_url"],
        json!("https://api.openai.com/v1")
    );
    assert_eq!(bifrost_config["client"]["enable_logging"], json!(true));
    assert_eq!(
        bifrost_config["client"]["required_headers"],
        json!([
            "x-portico-userid",
            "x-portico-redact-allow",
            "x-portico-appid",
            "x-portico-track",
            "x-portico-log-request",
            "x-portico-log-response",
            "content-type"
        ])
    );
    assert_eq!(
        bifrost_config["client"]["logging_headers"],
        json!([
            "x-portico-appid",
            "x-portico-track",
            "x-portico-log-request",
            "x-portico-log-response",
            "content-type",
            "x-openwebui-chat-id",
            "x-openwebui-session-id",
            "x-openwebui-message-id",
            "x-openwebui-debug-request-id",
            "x-openwebui-upstream-request-id",
            "x-openwebui-prompt-submitted-at-ms",
            "x-openwebui-request-phase",
            "x-openwebui-followup-index",
            "x-openwebui-outer-message-id",
            "x-openwebui-trigger-message-id",
            "x-openwebui-transcript-anchor-kind",
            "x-openwebui-transcript-anchor-message-id",
            "x-openwebui-transcript-anchor-tool-block-index",
            "traceparent",
            "x-bf-lh-portico-userid-present",
            "x-bf-lh-portico-userid-fingerprint",
            "x-bf-lh-portico-redact-allow-present",
            "x-bf-lh-portico-redact-allow-fingerprint"
        ])
    );
    assert_eq!(
        bifrost_config["providers"]["openai"]["network_config"]["extra_headers"],
        json!({
            "x-portico-userid":"user",
            "x-portico-redact-allow":"*",
            "x-portico-appid":"portico",
            "x-portico-track":"dev-build",
            "x-portico-log-request":"false",
            "x-portico-log-response":"false",
            "content-type":"application/json"
        })
    );

    assert!(Command::new("kill")
        .args(["-TERM", &child.id().to_string()])
        .status()
        .unwrap()
        .success());
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "bridge exited unsuccessfully\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    mock_bifrost.shutdown().await;
    fs::remove_file(&config_path).ok();
    fs::remove_file(&config_output_path).ok();
}

#[test]
fn binary_cleans_legacy_payloads_before_later_startup_failure() {
    let reporting_root = tempfile::tempdir().unwrap();
    let payloads = reporting_root.path().join("payloads");
    fs::create_dir_all(payloads.join("nested")).unwrap();
    fs::write(payloads.join("request.json"), b"legacy").unwrap();
    fs::write(payloads.join("nested/request.tmp"), b"partial").unwrap();
    let events = reporting_root.path().join("events");
    fs::create_dir_all(&events).unwrap();
    fs::write(events.join("keep.json"), b"safe").unwrap();

    let missing_config = reporting_root.path().join("missing-config.yaml");
    let output = Command::new(env!("CARGO_BIN_EXE_bifrost-bridge"))
        .env("PORTICO_COST_REPORTING_DIR", reporting_root.path())
        .env("MODEL_CATALOG_PATH", &missing_config)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();

    assert!(
        !output.status.success(),
        "invalid config should fail startup"
    );
    assert!(
        !payloads.exists(),
        "legacy payload cleanup must precede later fallible startup work"
    );
    assert!(events.join("keep.json").exists());
}

#[tokio::test]
async fn binary_main_shuts_down_cleanly_on_sigint() {
    let mock_bifrost = start_mock_bifrost().await;
    let config_path = temp_path("model-catalog-sigint", "yaml");
    let config_output_path = temp_path("bifrost-config-sigint", "json");
    fs::write(
        &config_path,
        r#"
x-headers: &headers
  x-portico-userid: os.environ/PORTICO_USER_ID
  x-portico-redact-allow: os.environ/PORTICO_REDACT_ALLOW
  x-portico-appid: portico
  x-portico-track: os.environ/PORTICO_BUILD_TRACK
  x-portico-log-request: "false"
  x-portico-log-response: "false"
  Content-Type: application/json
model_list:
  - model_name: GPT-4.1
    litellm_params:
      model: gpt-4.1
      api_base: https://api.openai.com/v1
      extra_headers: *headers
"#,
    )
    .unwrap();

    let port = reserve_port();
    let bind_addr = format!("127.0.0.1:{port}");
    let child = Command::new(env!("CARGO_BIN_EXE_bifrost-bridge"))
        .env("MODEL_CATALOG_PATH", &config_path)
        .env("BIFROST_CONFIG_OUTPUT", &config_output_path)
        .env("BIFROST_BRIDGE_BIND", &bind_addr)
        .env("BIFROST_BASE_URL", &mock_bifrost.base_url)
        .env("LLM_PROXY_BASE_URL", "http://127.0.0.1:9")
        .env("BIFROST_BRIDGE_ADVERTISED_HOST", &bind_addr)
        .env("PORTICO_LLM_API_KEY", "key")
        .env("BIFROST_BRIDGE_LOCAL_API_KEY", LOCAL_API_KEY)
        .env("ULTRA_MULTI_AGENT_SIGNING_SECRET", ULTRA_SIGNING_SECRET)
        .env("PORTICO_USER_ID", "user")
        .env("PORTICO_REDACT_ALLOW", "*")
        .env("PORTICO_BUILD_TRACK", "dev-build")
        .env("PORTICO_APP_ID", "portico")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    let client = reqwest::Client::builder().use_rustls_tls().build().unwrap();
    let health_url = format!("http://{bind_addr}/health");
    let mut healthy = false;
    for _ in 0..50 {
        if let Ok(response) = client.get(&health_url).send().await {
            if response.status().is_success() {
                healthy = true;
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(healthy, "bridge did not become healthy before SIGINT");

    assert!(Command::new("kill")
        .args(["-INT", &child.id().to_string()])
        .status()
        .unwrap()
        .success());
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "bridge exited unsuccessfully after SIGINT\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    mock_bifrost.shutdown().await;
    fs::remove_file(&config_path).ok();
    fs::remove_file(&config_output_path).ok();
}

#[test]
fn binary_rejects_missing_weak_or_reused_ultra_signing_secrets() {
    struct Case {
        name: &'static str,
        ultra_secret: Option<&'static str>,
        local_key: &'static str,
        upstream_key: &'static str,
        expected_error: &'static str,
    }

    let cases = [
        Case {
            name: "missing",
            ultra_secret: None,
            local_key: LOCAL_API_KEY,
            upstream_key: "upstream-key",
            expected_error:
                "Missing required environment variable: ULTRA_MULTI_AGENT_SIGNING_SECRET",
        },
        Case {
            name: "weak",
            ultra_secret: Some("ultra-sign-v1-short"),
            local_key: LOCAL_API_KEY,
            upstream_key: "upstream-key",
            expected_error: "Invalid ULTRA_MULTI_AGENT_SIGNING_SECRET",
        },
        Case {
            name: "bearer-equal",
            ultra_secret: Some(ULTRA_SIGNING_SECRET),
            local_key: ULTRA_SIGNING_SECRET,
            upstream_key: "upstream-key",
            expected_error: "must be distinct from bearer credentials",
        },
        Case {
            name: "upstream-equal",
            ultra_secret: Some(ULTRA_SIGNING_SECRET),
            local_key: LOCAL_API_KEY,
            upstream_key: ULTRA_SIGNING_SECRET,
            expected_error: "must be distinct from bearer credentials",
        },
    ];

    for case in cases {
        let config_path = temp_path(case.name, "yaml");
        let config_output_path = temp_path(case.name, "json");
        fs::write(
            &config_path,
            r#"
x-headers: &headers
  x-portico-userid: os.environ/PORTICO_USER_ID
  x-portico-redact-allow: os.environ/PORTICO_REDACT_ALLOW
  x-portico-appid: portico
  x-portico-track: os.environ/PORTICO_BUILD_TRACK
  x-portico-log-request: "false"
  x-portico-log-response: "false"
  Content-Type: application/json
model_list:
  - model_name: GPT-4.1
    litellm_params:
      model: gpt-4.1
      api_base: https://api.openai.com/v1
      extra_headers: *headers
"#,
        )
        .unwrap();

        let mut command = Command::new(env!("CARGO_BIN_EXE_bifrost-bridge"));
        command
            .env("MODEL_CATALOG_PATH", &config_path)
            .env("BIFROST_CONFIG_OUTPUT", &config_output_path)
            .env("BIFROST_BASE_URL", "http://127.0.0.1:9")
            .env("PORTICO_LLM_API_KEY", case.upstream_key)
            .env("BIFROST_BRIDGE_LOCAL_API_KEY", case.local_key)
            .env("PORTICO_USER_ID", "user")
            .env("PORTICO_REDACT_ALLOW", "*")
            .env("PORTICO_BUILD_TRACK", "dev-build")
            .env("PORTICO_APP_ID", "portico")
            .env_remove("ULTRA_MULTI_AGENT_SIGNING_SECRET")
            .env_remove("ULTRA_MULTI_AGENT_SIGNING_SECRET_FILE")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(secret) = case.ultra_secret {
            command.env("ULTRA_MULTI_AGENT_SIGNING_SECRET", secret);
        }
        let output = command.output().unwrap();
        assert!(
            !output.status.success(),
            "{} unexpectedly started",
            case.name
        );
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains(case.expected_error),
            "{}: {stderr}",
            case.name
        );

        fs::remove_file(&config_path).ok();
        fs::remove_file(&config_output_path).ok();
    }
}
