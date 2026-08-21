use std::collections::BTreeMap;

use anyhow::{anyhow, Result};
use log::info;
use serde_json::Value;

use crate::app;
use crate::cli::ParsedInvocation;
use crate::config::{McpConfig, ServerConfig};
use crate::oauth::{implementation_state, native_mode_from_env, NativeImplementationState};

pub async fn run(parsed: &ParsedInvocation) -> Result<()> {
    let serve = parsed
        .serve_args()
        .ok_or_else(|| anyhow!("mcp-orc runtime requires a serve invocation"))?;

    let config = match serve.config_path.as_ref() {
        Some(path) => McpConfig::load_from_path(path)?,
        None => synthetic_config(parsed)?,
    };

    info!("Backend selection: rust");
    info!("Native mode: {}", native_mode_from_env());
    info!("Program: {}", parsed.program_name);
    info!("Host: {:?}", serve.host);
    info!("Port: {:?}", serve.port);
    info!("Config: {:?}", serve.config_path);
    log_config_summary(&config);

    match implementation_state() {
        NativeImplementationState::Native => {
            let host = parsed
                .serve_args()
                .expect("serve invocation already validated")
                .host
                .clone()
                .unwrap_or_else(|| "127.0.0.1".to_string());
            let port = serve.port.unwrap_or(8000);
            app::serve(config, &host, port).await
        }
    }
}

fn synthetic_config(parsed: &ParsedInvocation) -> Result<McpConfig> {
    let serve = parsed
        .serve_args()
        .ok_or_else(|| anyhow!("mcp-orc requires a serve invocation"))?;

    if serve.server_command.is_empty() {
        return Err(anyhow!("mcp-orc requires --config or --server-command"));
    }

    let server_id = parsed
        .serve_args()
        .expect("serve invocation already validated")
        .name
        .clone()
        .unwrap_or_else(|| "server".to_string())
        .replace(' ', "-")
        .to_ascii_lowercase();
    let headers = match serve.headers.as_ref() {
        Some(raw) => Some(serde_json::from_str::<Value>(raw)?),
        None => None,
    };

    let mut servers = BTreeMap::new();
    let server_type = serve.server_type.clone();
    let first = serve.server_command.first().cloned();
    let args = serve
        .server_command
        .iter()
        .skip(1)
        .cloned()
        .collect::<Vec<_>>();

    let config = if matches!(
        server_type.as_deref(),
        Some("streamable-http") | Some("sse")
    ) {
        ServerConfig {
            server_type,
            url: first,
            command: None,
            args: Vec::new(),
            env: BTreeMap::new(),
            oauth: None,
            headers,
            disabled_tools: Vec::new(),
            sensitive_env_vars: Vec::new(),
            tool_rename_mapping: BTreeMap::new(),
            tool_call_timeout: None,
            client_header_forwarding: None,
            http_subprocess: None,
            extra: BTreeMap::new(),
        }
    } else {
        ServerConfig {
            server_type: Some("stdio".to_string()),
            url: None,
            command: first,
            args,
            env: std::env::vars().collect(),
            oauth: None,
            headers,
            disabled_tools: Vec::new(),
            sensitive_env_vars: Vec::new(),
            tool_rename_mapping: BTreeMap::new(),
            tool_call_timeout: None,
            client_header_forwarding: None,
            http_subprocess: None,
            extra: BTreeMap::new(),
        }
    };

    servers.insert(server_id, config);
    let config = McpConfig {
        mcp_servers: servers,
    };
    config.validate()?;
    Ok(config)
}

fn log_config_summary(config: &McpConfig) {
    let mut oauth_servers = 0usize;
    let mut stream_servers = 0usize;
    let mut stdio_servers = 0usize;
    let mut http_subprocess_servers = 0usize;

    for server in config.mcp_servers.values() {
        if server.oauth.is_some() {
            oauth_servers += 1;
        }
        if server.http_subprocess.is_some() {
            http_subprocess_servers += 1;
        }

        match server.server_type.as_deref() {
            Some("sse") | Some("streamable-http") | Some("streamable_http") => stream_servers += 1,
            _ => stdio_servers += 1,
        }
    }

    info!(
        "Config summary: {} stdio/http-subprocess, {} streaming, {} oauth-enabled, {} http_subprocess",
        stdio_servers,
        stream_servers,
        oauth_servers,
        http_subprocess_servers
    );
}

#[cfg(test)]
mod tests {
    use super::{log_config_summary, run, synthetic_config};
    use crate::cli::ParsedInvocation;
    use serial_test::serial;
    use std::fs;
    use std::time::Duration;
    use tempfile::tempdir;
    use tokio::task::JoinHandle;

    #[test]
    fn builds_synthetic_stdio_config() {
        let parsed =
            ParsedInvocation::parse_from(["mcpo", "--server-command", "uvx", "mcp-server-time"])
                .unwrap();
        let config = synthetic_config(&parsed).unwrap();
        assert_eq!(config.mcp_servers.len(), 1);
        let server = config.mcp_servers.get("server").unwrap();
        assert_eq!(server.server_type.as_deref(), Some("stdio"));
        assert_eq!(server.command.as_deref(), Some("uvx"));
        assert_eq!(server.args, vec!["mcp-server-time".to_string()]);
        assert!(server.env.contains_key("PATH"));
    }

    #[test]
    fn rejects_missing_server_command() {
        let parsed = ParsedInvocation::parse_from(["mcpo", "--host", "127.0.0.1"]).unwrap();
        let error = synthetic_config(&parsed).unwrap_err();
        assert!(error.to_string().contains("--config or --server-command"));
    }

    #[test]
    fn builds_synthetic_streaming_config_and_normalizes_name() {
        let parsed = ParsedInvocation::parse_from([
            "mcpo",
            "--name",
            "My Server",
            "--server-type",
            "streamable-http",
            "--headers",
            "{\"authorization\":\"Bearer test\"}",
            "--server-command",
            "http://example.test/mcp",
        ])
        .unwrap();
        let config = synthetic_config(&parsed).unwrap();
        let server = config.mcp_servers.get("my-server").unwrap();
        assert_eq!(server.server_type.as_deref(), Some("streamable-http"));
        assert_eq!(server.url.as_deref(), Some("http://example.test/mcp"));
        assert!(server.command.is_none());
        assert_eq!(
            server.headers.as_ref().unwrap()["authorization"],
            "Bearer test"
        );
    }

    #[test]
    fn builds_synthetic_sse_config() {
        let parsed = ParsedInvocation::parse_from([
            "mcpo",
            "--server-type",
            "sse",
            "--server-command",
            "http://example.test/sse",
        ])
        .unwrap();
        let config = synthetic_config(&parsed).unwrap();
        let server = config.mcp_servers.get("server").unwrap();
        assert_eq!(server.server_type.as_deref(), Some("sse"));
        assert_eq!(server.url.as_deref(), Some("http://example.test/sse"));
        assert!(server.command.is_none());
    }

    #[test]
    fn rejects_invalid_header_json() {
        let parsed = ParsedInvocation::parse_from([
            "mcpo",
            "--headers",
            "{broken",
            "--server-command",
            "uvx",
            "time",
        ])
        .unwrap();
        assert!(synthetic_config(&parsed).is_err());
    }

    #[test]
    fn logs_config_summary_for_mixed_servers() {
        let config = serde_json::from_value(serde_json::json!({
            "mcpServers": {
                "stdio": {"command": "uvx"},
                "stream": {"type": "streamable_http", "url": "http://example.test"},
                "oauth": {"type": "streamable-http", "url": "http://example.test", "oauth": {}},
                "http_subprocess": {"command": "uvx", "http_subprocess": {"enabled": true}}
            }
        }))
        .unwrap();
        log_config_summary(&config);
    }

    #[tokio::test]
    async fn run_reports_missing_config_file() {
        let parsed =
            ParsedInvocation::parse_from(["mcpo", "--config", "/tmp/definitely-missing.json"])
                .unwrap();
        let error = run(&parsed).await.unwrap_err();
        assert!(error.to_string().contains("failed to read"));
    }

    #[tokio::test]
    #[serial]
    async fn run_enters_native_serve_path_for_synthetic_config() {
        let parsed = ParsedInvocation::parse_from([
            "mcpo",
            "--host",
            "127.0.0.1",
            "--port",
            "0",
            "--server-command",
            "/usr/bin/true",
        ])
        .unwrap();
        let task: JoinHandle<anyhow::Result<()>> = tokio::spawn(async move { run(&parsed).await });
        tokio::time::sleep(Duration::from_millis(150)).await;
        task.abort();
        let _ = task.await;
    }

    #[tokio::test]
    #[serial]
    async fn run_loads_config_file_before_serving() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        fs::write(
            &path,
            r#"{
                "mcpServers": {
                    "demo": {
                        "command": "/usr/bin/true"
                    }
                }
            }"#,
        )
        .unwrap();
        let parsed = ParsedInvocation::parse_from([
            "mcpo",
            "--host",
            "127.0.0.1",
            "--port",
            "0",
            "--config",
            path.to_str().unwrap(),
        ])
        .unwrap();
        let task: JoinHandle<anyhow::Result<()>> = tokio::spawn(async move { run(&parsed).await });
        tokio::time::sleep(Duration::from_millis(150)).await;
        task.abort();
        let _ = task.await;
    }

    #[tokio::test]
    #[serial]
    async fn run_uses_default_host_and_port_when_unspecified() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        fs::write(
            &path,
            r#"{
                "mcpServers": {
                    "demo": {
                        "command": "/usr/bin/true"
                    }
                }
            }"#,
        )
        .unwrap();
        let parsed =
            ParsedInvocation::parse_from(["mcpo", "--config", path.to_str().unwrap()]).unwrap();
        let task: JoinHandle<anyhow::Result<()>> = tokio::spawn(async move { run(&parsed).await });
        tokio::time::sleep(Duration::from_millis(150)).await;
        task.abort();
        let _ = task.await;
    }
}
