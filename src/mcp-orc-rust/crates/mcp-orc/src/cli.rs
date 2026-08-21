use anyhow::{anyhow, Result};
use std::ffi::OsString;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedInvocation {
    pub program_name: String,
    pub raw_args: Vec<String>,
    pub command: Invocation,
}

impl ParsedInvocation {
    pub fn parse_from<I, S>(iter: I) -> Result<Self>
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        let argv: Vec<String> = iter
            .into_iter()
            .map(|value| value.into().to_string_lossy().into_owned())
            .collect();
        let (program_name, raw_args) = argv
            .split_first()
            .ok_or_else(|| anyhow!("missing argv[0]"))?;

        let command = if raw_args
            .first()
            .map(|value| value == "generate-mcp-config")
            .unwrap_or(false)
        {
            Invocation::GenerateMcpConfig(parse_generator_args(&raw_args[1..])?)
        } else if raw_args
            .first()
            .map(|value| value == "generate-docker-compose-override")
            .unwrap_or(false)
        {
            Invocation::GenerateDockerComposeOverride(parse_generator_args(&raw_args[1..])?)
        } else if raw_args
            .first()
            .map(|value| value == "prepare-managed-node-packages")
            .unwrap_or(false)
        {
            Invocation::PrepareManagedNodePackages(parse_generator_args(&raw_args[1..])?)
        } else if raw_args
            .first()
            .map(|value| value == "inspect-server-metadata")
            .unwrap_or(false)
        {
            Invocation::InspectServerMetadata(parse_server_metadata_args(&raw_args[1..])?)
        } else if raw_args
            .first()
            .map(|value| value == "bridge")
            .unwrap_or(false)
        {
            Invocation::Bridge(parse_bridge_args(&raw_args[1..])?)
        } else if raw_args
            .first()
            .map(|value| value == "export-legacy-oauth-record")
            .unwrap_or(false)
        {
            Invocation::ExportLegacyOAuthRecord(parse_legacy_oauth_export_args(&raw_args[1..])?)
        } else {
            Invocation::Serve(parse_serve_args(raw_args).map_err(|err| anyhow!(err))?)
        };

        Ok(Self {
            program_name: program_name.clone(),
            raw_args: raw_args.to_vec(),
            command,
        })
    }

    pub fn serve_args(&self) -> Option<&ServeArgs> {
        match &self.command {
            Invocation::Serve(args) => Some(args),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Invocation {
    Serve(ServeArgs),
    GenerateMcpConfig(GeneratorArgs),
    GenerateDockerComposeOverride(GeneratorArgs),
    PrepareManagedNodePackages(GeneratorArgs),
    InspectServerMetadata(ServerMetadataArgs),
    Bridge(BridgeArgs),
    ExportLegacyOAuthRecord(LegacyOAuthExportArgs),
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct GeneratorArgs {
    pub force: bool,
    pub project_root: Option<PathBuf>,
    pub server_id: Option<String>,
    pub enabled_only: bool,
    pub deployment_type: Option<String>,
    pub best_effort: bool,
    pub status_file: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerMetadataArgs {
    pub yaml: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeArgs {
    pub host: String,
    pub port: u16,
    pub mcp_path: String,
    pub core_url: String,
    pub regular_url: String,
    pub host_url: String,
    pub stdio_proxy: bool,
    pub remote_url: String,
    pub remote_auth_token_file: Option<PathBuf>,
    pub expose_all_tools: bool,
    pub auth_registry_path: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyOAuthExportArgs {
    pub server_id: String,
    pub storage_dir: PathBuf,
}

impl Default for BridgeArgs {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".to_string(),
            port: 8891,
            mcp_path: "/mcp".to_string(),
            core_url: "http://127.0.0.1:8766".to_string(),
            regular_url: "http://127.0.0.1:8765".to_string(),
            host_url: "http://127.0.0.1:8890".to_string(),
            stdio_proxy: false,
            remote_url: "http://127.0.0.1:8891/mcp".to_string(),
            remote_auth_token_file: None,
            expose_all_tools: false,
            auth_registry_path: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServeArgs {
    pub host: Option<String>,
    pub port: Option<u16>,
    pub config_path: Option<PathBuf>,
    pub name: Option<String>,
    pub description: Option<String>,
    pub version: Option<String>,
    pub server_type: Option<String>,
    pub server_command: Vec<String>,
    pub headers: Option<String>,
    pub path_prefix: Option<String>,
    pub root_path: Option<String>,
    pub hot_reload: bool,
    pub passthrough: Vec<String>,
}

impl ServeArgs {
    pub fn to_forwarded_args(&self) -> Vec<String> {
        self.to_python_args()
    }

    pub fn to_python_args(&self) -> Vec<String> {
        self.passthrough.clone()
    }
}

pub fn parse_legacy_oauth_export_args(raw_args: &[String]) -> Result<LegacyOAuthExportArgs> {
    let mut server_id = None;
    let mut storage_dir = None;
    let mut index = 0usize;
    while index < raw_args.len() {
        let current = &raw_args[index];
        if let Some(value) = inline_value(current, &["--server-id"]) {
            server_id = Some(value.to_string());
        } else if let Some(value) = inline_value(current, &["--storage-dir"]) {
            storage_dir = Some(PathBuf::from(value));
        } else {
            match current.as_str() {
                "--server-id" => {
                    server_id = Some(
                        take_value(raw_args, &mut index, "--server-id")
                            .map_err(|err| anyhow!(err))?,
                    );
                }
                "--storage-dir" => {
                    storage_dir = Some(PathBuf::from(
                        take_value(raw_args, &mut index, "--storage-dir")
                            .map_err(|err| anyhow!(err))?,
                    ));
                }
                other => {
                    return Err(anyhow!(
                        "unknown export-legacy-oauth-record argument: {other}"
                    ));
                }
            }
        }
        index += 1;
    }

    let server_id = server_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("missing value for --server-id"))?;
    let storage_dir = storage_dir.ok_or_else(|| anyhow!("missing value for --storage-dir"))?;
    Ok(LegacyOAuthExportArgs {
        server_id,
        storage_dir,
    })
}

pub fn parse_bridge_args(raw_args: &[String]) -> Result<BridgeArgs> {
    let mut args = BridgeArgs::default();
    let mut index = 0usize;
    while index < raw_args.len() {
        let current = &raw_args[index];
        if let Some(value) = inline_value(current, &["--host", "-h"]) {
            args.host = value.to_string();
        } else if let Some(value) = inline_value(current, &["--port", "-p"]) {
            args.port = value
                .parse::<u16>()
                .map_err(|err| anyhow!("invalid --port value '{value}': {err}"))?;
        } else if let Some(value) = inline_value(current, &["--mcp-path"]) {
            args.mcp_path = normalize_mcp_path(value);
        } else if let Some(value) = inline_value(current, &["--core-url"]) {
            args.core_url = trim_url(value);
        } else if let Some(value) = inline_value(current, &["--regular-url"]) {
            args.regular_url = trim_url(value);
        } else if let Some(value) = inline_value(current, &["--host-url"]) {
            args.host_url = trim_url(value);
        } else if let Some(value) = inline_value(current, &["--remote-url"]) {
            args.remote_url = trim_url(value);
        } else if let Some(value) = inline_value(current, &["--remote-auth-token-file"]) {
            if !value.trim().is_empty() {
                args.remote_auth_token_file = Some(PathBuf::from(value));
            }
        } else if let Some(value) = inline_value(current, &["--auth-registry"]) {
            if !value.trim().is_empty() {
                args.auth_registry_path = Some(PathBuf::from(value));
            }
        } else {
            match current.as_str() {
                "--host" | "-h" => {
                    args.host =
                        take_value(raw_args, &mut index, "--host").map_err(|err| anyhow!(err))?;
                }
                "--port" | "-p" => {
                    let raw_port =
                        take_value(raw_args, &mut index, "--port").map_err(|err| anyhow!(err))?;
                    args.port = raw_port
                        .parse::<u16>()
                        .map_err(|err| anyhow!("invalid --port value '{raw_port}': {err}"))?;
                }
                "--mcp-path" => {
                    let value =
                        take_value(raw_args, &mut index, current).map_err(|err| anyhow!(err))?;
                    args.mcp_path = normalize_mcp_path(&value);
                }
                "--core-url" => {
                    let value =
                        take_value(raw_args, &mut index, current).map_err(|err| anyhow!(err))?;
                    args.core_url = trim_url(&value);
                }
                "--regular-url" => {
                    let value =
                        take_value(raw_args, &mut index, current).map_err(|err| anyhow!(err))?;
                    args.regular_url = trim_url(&value);
                }
                "--host-url" => {
                    let value =
                        take_value(raw_args, &mut index, current).map_err(|err| anyhow!(err))?;
                    args.host_url = trim_url(&value);
                }
                "--stdio-proxy" => {
                    args.stdio_proxy = true;
                }
                "--remote-url" => {
                    let value =
                        take_value(raw_args, &mut index, current).map_err(|err| anyhow!(err))?;
                    args.remote_url = trim_url(&value);
                }
                "--remote-auth-token-file" => {
                    let value =
                        take_value(raw_args, &mut index, current).map_err(|err| anyhow!(err))?;
                    if !value.trim().is_empty() {
                        args.remote_auth_token_file = Some(PathBuf::from(value));
                    }
                }
                "--expose-all-tools" => {
                    args.expose_all_tools = true;
                }
                "--auth-registry" => {
                    let value =
                        take_value(raw_args, &mut index, current).map_err(|err| anyhow!(err))?;
                    if !value.trim().is_empty() {
                        args.auth_registry_path = Some(PathBuf::from(value));
                    }
                }
                other => {
                    return Err(anyhow!("unknown bridge argument: {other}"));
                }
            }
        }
        index += 1;
    }
    Ok(args)
}

fn normalize_mcp_path(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return "/mcp".to_string();
    }
    let with_prefix = if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    };
    if with_prefix.len() > 1 {
        with_prefix.trim_end_matches('/').to_string()
    } else {
        with_prefix
    }
}

fn trim_url(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

pub fn parse_serve_args(raw_args: &[String]) -> Result<ServeArgs, String> {
    let passthrough = strip_subcommand(raw_args);
    let mut host = None;
    let mut port = None;
    let mut config_path = None;
    let mut name = None;
    let mut description = None;
    let mut version = None;
    let mut server_type = None;
    let mut server_command = Vec::new();
    let mut headers = None;
    let mut path_prefix = None;
    let mut root_path = None;
    let mut hot_reload = false;

    let mut index = 0usize;
    while index < passthrough.len() {
        let current = &passthrough[index];
        if let Some(value) = inline_value(current, &["--host", "-h"]) {
            host = Some(value.to_string());
        } else if let Some(value) = inline_value(current, &["--port", "-p"]) {
            let parsed_port = value
                .parse::<u16>()
                .map_err(|err| format!("invalid --port value '{value}': {err}"))?;
            port = Some(parsed_port);
        } else if let Some(value) = inline_value(current, &["--config", "--config-path", "-c"]) {
            config_path = Some(PathBuf::from(value));
        } else if let Some(value) = inline_value(current, &["--name", "-n"]) {
            name = Some(value.to_string());
        } else if let Some(value) = inline_value(current, &["--description", "-d"]) {
            description = Some(value.to_string());
        } else if let Some(value) = inline_value(current, &["--version", "-v"]) {
            version = Some(value.to_string());
        } else if let Some(value) = inline_value(current, &["--server-type", "--type"]) {
            server_type = Some(value.to_string());
        } else if let Some(value) = inline_value(current, &["--headers", "--header", "-H"]) {
            headers = Some(value.to_string());
        } else if let Some(value) = inline_value(current, &["--path-prefix"]) {
            path_prefix = Some(value.to_string());
        } else if let Some(value) = inline_value(current, &["--root-path"]) {
            root_path = Some(value.to_string());
        } else {
            match current.as_str() {
                "--host" | "-h" => {
                    host = Some(take_value(&passthrough, &mut index, "--host")?);
                }
                "--port" | "-p" => {
                    let raw_port = take_value(&passthrough, &mut index, "--port")?;
                    let parsed_port = raw_port
                        .parse::<u16>()
                        .map_err(|err| format!("invalid --port value '{raw_port}': {err}"))?;
                    port = Some(parsed_port);
                }
                "--config" | "--config-path" | "-c" => {
                    let path = take_value(&passthrough, &mut index, current)?;
                    config_path = Some(PathBuf::from(path));
                }
                "--name" | "-n" => {
                    name = Some(take_value(&passthrough, &mut index, "--name")?);
                }
                "--description" | "-d" => {
                    description = Some(take_value(&passthrough, &mut index, "--description")?);
                }
                "--version" | "-v" => {
                    version = Some(take_value(&passthrough, &mut index, "--version")?);
                }
                "--server-type" | "--type" => {
                    server_type = Some(take_value(&passthrough, &mut index, "--server-type")?);
                }
                "--server-command" => {
                    server_command =
                        take_multi_value(&passthrough, &mut index, "--server-command")?;
                }
                "--headers" | "--header" | "-H" => {
                    headers = Some(take_value(&passthrough, &mut index, "--headers")?);
                }
                "--path-prefix" => {
                    path_prefix = Some(take_value(&passthrough, &mut index, "--path-prefix")?);
                }
                "--root-path" => {
                    root_path = Some(take_value(&passthrough, &mut index, "--root-path")?);
                }
                "--hot-reload" => {
                    hot_reload = true;
                }
                "--" => {
                    server_command = passthrough[index + 1..].to_vec();
                    break;
                }
                _ => {}
            }
        }
        index += 1;
    }

    Ok(ServeArgs {
        host,
        port,
        config_path,
        name,
        description,
        version,
        server_type,
        server_command,
        headers,
        path_prefix,
        root_path,
        hot_reload,
        passthrough,
    })
}

fn parse_generator_args(raw_args: &[String]) -> Result<GeneratorArgs> {
    let mut parsed = GeneratorArgs::default();
    let mut index = 0usize;
    while index < raw_args.len() {
        let current = &raw_args[index];
        if current == "--force" {
            parsed.force = true;
        } else if current == "--enabled-only" {
            parsed.enabled_only = true;
        } else if current == "--best-effort" {
            parsed.best_effort = true;
        } else if let Some(value) = current.strip_prefix("--project-root=") {
            if value.is_empty() {
                return Err(anyhow!("missing value for --project-root"));
            }
            parsed.project_root = Some(PathBuf::from(value));
        } else if current == "--project-root" {
            parsed.project_root = Some(PathBuf::from(
                take_value(raw_args, &mut index, "--project-root").map_err(|err| anyhow!(err))?,
            ));
        } else if let Some(value) = current.strip_prefix("--server-id=") {
            if value.is_empty() {
                return Err(anyhow!("missing value for --server-id"));
            }
            parsed.server_id = Some(value.to_string());
        } else if current == "--server-id" {
            parsed.server_id =
                Some(take_value(raw_args, &mut index, "--server-id").map_err(|err| anyhow!(err))?);
        } else if let Some(value) = current.strip_prefix("--deployment-type=") {
            parsed.deployment_type = Some(parse_deployment_type(value)?);
        } else if current == "--deployment-type" {
            let value = take_value(raw_args, &mut index, "--deployment-type")
                .map_err(|err| anyhow!(err))?;
            parsed.deployment_type = Some(parse_deployment_type(&value)?);
        } else if let Some(value) = current.strip_prefix("--status-file=") {
            if value.is_empty() {
                return Err(anyhow!("missing value for --status-file"));
            }
            parsed.status_file = Some(PathBuf::from(value));
        } else if current == "--status-file" {
            parsed.status_file = Some(PathBuf::from(
                take_value(raw_args, &mut index, "--status-file").map_err(|err| anyhow!(err))?,
            ));
        } else {
            return Err(anyhow!("unrecognized argument: {current}"));
        }
        index += 1;
    }
    if parsed.best_effort && parsed.server_id.is_some() {
        return Err(anyhow!(
            "--best-effort is only supported for full managed Node package preparation"
        ));
    }
    Ok(parsed)
}

fn parse_server_metadata_args(raw_args: &[String]) -> Result<ServerMetadataArgs> {
    let mut yaml = None;
    let mut index = 0usize;
    while index < raw_args.len() {
        let current = &raw_args[index];
        if let Some(value) = current.strip_prefix("--yaml=") {
            if value.is_empty() {
                return Err(anyhow!("missing value for --yaml"));
            }
            yaml = Some(PathBuf::from(value));
        } else if current == "--yaml" {
            yaml = Some(PathBuf::from(
                take_value(raw_args, &mut index, "--yaml").map_err(|err| anyhow!(err))?,
            ));
        } else if current == "--project-root" {
            let _ =
                take_value(raw_args, &mut index, "--project-root").map_err(|err| anyhow!(err))?;
        } else if current.starts_with("--project-root=") {
            // Accepted for compatibility with run_mcp_orc_generator.
        } else {
            return Err(anyhow!("unrecognized argument: {current}"));
        }
        index += 1;
    }
    Ok(ServerMetadataArgs {
        yaml: yaml.ok_or_else(|| anyhow!("missing value for --yaml"))?,
    })
}

fn parse_deployment_type(value: &str) -> Result<String> {
    let normalized = value.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "docker" | "host" => Ok(normalized),
        "" => Err(anyhow!("missing value for --deployment-type")),
        _ => Err(anyhow!(
            "invalid --deployment-type '{value}'; expected docker or host"
        )),
    }
}

fn strip_subcommand(raw_args: &[String]) -> Vec<String> {
    if raw_args
        .first()
        .map(|value| value == "serve" || value == "run")
        .unwrap_or(false)
    {
        raw_args[1..].to_vec()
    } else {
        raw_args.to_vec()
    }
}

fn inline_value<'a>(arg: &'a str, flags: &[&str]) -> Option<&'a str> {
    flags.iter().find_map(|flag| {
        arg.strip_prefix(flag)
            .and_then(|rest| rest.strip_prefix('='))
            .filter(|value| !value.is_empty())
    })
}

fn take_value(args: &[String], index: &mut usize, flag: &str) -> Result<String, String> {
    let next_index = *index + 1;
    args.get(next_index)
        .cloned()
        .ok_or_else(|| format!("missing value for {flag}"))
        .map(|value| {
            *index = next_index;
            value
        })
}

fn take_multi_value(args: &[String], index: &mut usize, flag: &str) -> Result<Vec<String>, String> {
    let mut values = Vec::new();
    let mut cursor = *index + 1;
    while let Some(candidate) = args.get(cursor) {
        if candidate.starts_with("--") {
            break;
        }
        values.push(candidate.clone());
        cursor += 1;
    }

    if values.is_empty() {
        return Err(format!("missing value for {flag}"));
    }

    *index = cursor.saturating_sub(1);
    Ok(values)
}

#[cfg(test)]
mod tests {
    use super::{
        parse_bridge_args, parse_serve_args, BridgeArgs, GeneratorArgs, Invocation,
        LegacyOAuthExportArgs, ParsedInvocation, ServerMetadataArgs,
    };
    use std::path::PathBuf;

    #[test]
    fn parses_mcpo_style_flags() {
        let args = vec![
            "--host".to_string(),
            "0.0.0.0".to_string(),
            "--port".to_string(),
            "8000".to_string(),
            "--config".to_string(),
            "/tmp/config.json".to_string(),
            "--hot-reload".to_string(),
        ];
        let parsed = parse_serve_args(&args).expect("cli should parse");
        assert_eq!(parsed.host.as_deref(), Some("0.0.0.0"));
        assert_eq!(parsed.port, Some(8000));
        assert_eq!(parsed.config_path, Some(PathBuf::from("/tmp/config.json")));
        assert!(parsed.hot_reload);
        assert_eq!(parsed.to_forwarded_args(), args);
    }

    #[test]
    fn strips_serve_subcommand_before_forwarding() {
        let args = vec![
            "serve".to_string(),
            "--config".to_string(),
            "mcp_config.json".to_string(),
            "--server-command".to_string(),
            "uv".to_string(),
            "run".to_string(),
        ];
        let parsed = parse_serve_args(&args).expect("cli should parse");
        assert_eq!(
            parsed.to_forwarded_args(),
            vec![
                "--config".to_string(),
                "mcp_config.json".to_string(),
                "--server-command".to_string(),
                "uv".to_string(),
                "run".to_string()
            ]
        );
        assert_eq!(
            parsed.server_command,
            vec!["uv".to_string(), "run".to_string()]
        );
    }

    #[test]
    fn parses_short_and_inline_flags() {
        let args = vec![
            "-h=127.0.0.1".to_string(),
            "-p".to_string(),
            "9000".to_string(),
            "-c=./config.json".to_string(),
            "--header={\"Authorization\":\"Bearer test\"}".to_string(),
        ];
        let parsed = parse_serve_args(&args).expect("cli should parse");
        assert_eq!(parsed.host.as_deref(), Some("127.0.0.1"));
        assert_eq!(parsed.port, Some(9000));
        assert_eq!(parsed.config_path, Some(PathBuf::from("./config.json")));
        assert_eq!(
            parsed.headers.as_deref(),
            Some("{\"Authorization\":\"Bearer test\"}")
        );
    }

    #[test]
    fn parses_short_config_flag_without_inline_value() {
        let args = vec!["-c".to_string(), "./config.json".to_string()];
        let parsed = parse_serve_args(&args).unwrap();
        assert_eq!(parsed.config_path, Some(PathBuf::from("./config.json")));
    }

    #[test]
    fn captures_server_command_after_double_dash() {
        let args = vec![
            "--port".to_string(),
            "8000".to_string(),
            "--".to_string(),
            "uvx".to_string(),
            "some-server".to_string(),
        ];
        let parsed = parse_serve_args(&args).expect("cli should parse");
        assert_eq!(
            parsed.server_command,
            vec!["uvx".to_string(), "some-server".to_string()]
        );
    }

    #[test]
    fn parses_long_form_flags_and_stops_server_command_before_next_flag() {
        let args = vec![
            "run".to_string(),
            "--config-path".to_string(),
            "./config.json".to_string(),
            "--description".to_string(),
            "demo server".to_string(),
            "--version".to_string(),
            "2.0.0".to_string(),
            "--type".to_string(),
            "sse".to_string(),
            "--path-prefix".to_string(),
            "/demo".to_string(),
            "--root-path".to_string(),
            "/root".to_string(),
            "ignored-token".to_string(),
            "--server-command".to_string(),
            "uvx".to_string(),
            "time-server".to_string(),
            "--host".to_string(),
            "0.0.0.0".to_string(),
        ];
        let parsed = parse_serve_args(&args).unwrap();
        assert_eq!(parsed.config_path, Some(PathBuf::from("./config.json")));
        assert_eq!(parsed.description.as_deref(), Some("demo server"));
        assert_eq!(parsed.version.as_deref(), Some("2.0.0"));
        assert_eq!(parsed.server_type.as_deref(), Some("sse"));
        assert_eq!(parsed.path_prefix.as_deref(), Some("/demo"));
        assert_eq!(parsed.root_path.as_deref(), Some("/root"));
        assert_eq!(parsed.host.as_deref(), Some("0.0.0.0"));
        assert_eq!(
            parsed.server_command,
            vec!["uvx".to_string(), "time-server".to_string()]
        );
        assert_eq!(parsed.to_python_args(), args[1..].to_vec());
    }

    #[test]
    fn parses_inline_and_optional_flags() {
        let args = vec![
            "--host=127.0.0.1".to_string(),
            "--port=9000".to_string(),
            "--name=demo".to_string(),
            "--description=desc".to_string(),
            "--version=1.2.3".to_string(),
            "--server-type=streamable-http".to_string(),
            "--headers={\"x-demo\":\"1\"}".to_string(),
            "--path-prefix=/demo".to_string(),
            "--root-path=/root".to_string(),
        ];
        let parsed = parse_serve_args(&args).unwrap();
        assert_eq!(parsed.host.as_deref(), Some("127.0.0.1"));
        assert_eq!(parsed.port, Some(9000));
        assert_eq!(parsed.name.as_deref(), Some("demo"));
        assert_eq!(parsed.description.as_deref(), Some("desc"));
        assert_eq!(parsed.version.as_deref(), Some("1.2.3"));
        assert_eq!(parsed.server_type.as_deref(), Some("streamable-http"));
        assert_eq!(parsed.headers.as_deref(), Some("{\"x-demo\":\"1\"}"));
        assert_eq!(parsed.path_prefix.as_deref(), Some("/demo"));
        assert_eq!(parsed.root_path.as_deref(), Some("/root"));
    }

    #[test]
    fn returns_errors_for_missing_and_invalid_values() {
        let missing_host = parse_serve_args(&["--host".to_string()]).unwrap_err();
        assert!(missing_host.contains("missing value for --host"));

        let invalid_port =
            parse_serve_args(&["--port".to_string(), "wat".to_string()]).unwrap_err();
        assert!(invalid_port.contains("invalid --port value"));

        let inline_invalid_port = parse_serve_args(&["--port=wat".to_string()]).unwrap_err();
        assert!(inline_invalid_port.contains("invalid --port value"));

        let missing_port = parse_serve_args(&["--port".to_string()]).unwrap_err();
        assert!(missing_port.contains("missing value for --port"));

        let missing_config = parse_serve_args(&["--config".to_string()]).unwrap_err();
        assert!(missing_config.contains("missing value for --config"));

        let missing_name = parse_serve_args(&["--name".to_string()]).unwrap_err();
        assert!(missing_name.contains("missing value for --name"));

        let missing_description = parse_serve_args(&["--description".to_string()]).unwrap_err();
        assert!(missing_description.contains("missing value for --description"));

        let missing_version = parse_serve_args(&["--version".to_string()]).unwrap_err();
        assert!(missing_version.contains("missing value for --version"));

        let missing_server_type = parse_serve_args(&["--server-type".to_string()]).unwrap_err();
        assert!(missing_server_type.contains("missing value for --server-type"));

        let missing_headers = parse_serve_args(&["--headers".to_string()]).unwrap_err();
        assert!(missing_headers.contains("missing value for --headers"));

        let missing_path_prefix = parse_serve_args(&["--path-prefix".to_string()]).unwrap_err();
        assert!(missing_path_prefix.contains("missing value for --path-prefix"));

        let missing_root_path = parse_serve_args(&["--root-path".to_string()]).unwrap_err();
        assert!(missing_root_path.contains("missing value for --root-path"));

        let missing_server_command =
            parse_serve_args(&["--server-command".to_string()]).unwrap_err();
        assert!(missing_server_command.contains("missing value for --server-command"));
    }

    #[test]
    fn parses_invocation_and_requires_program_name() {
        let parsed = ParsedInvocation::parse_from([
            "mcpo",
            "--config",
            "/tmp/config.json",
            "--server-command",
            "uvx",
            "time-server",
        ])
        .unwrap();
        assert_eq!(parsed.program_name, "mcpo");
        assert_eq!(parsed.raw_args[0], "--config");
        assert!(matches!(parsed.command, Invocation::Serve(_)));

        let error = ParsedInvocation::parse_from(Vec::<String>::new()).unwrap_err();
        assert!(error.to_string().contains("missing argv[0]"));

        let nested_error =
            ParsedInvocation::parse_from(["mcpo", "--port", "not-a-port"]).unwrap_err();
        assert!(nested_error.to_string().contains("invalid --port value"));
    }

    #[test]
    fn parses_bridge_subcommand_defaults_and_overrides() {
        let parsed = ParsedInvocation::parse_from(["mcp-orc", "bridge"]).unwrap();
        assert_eq!(parsed.command, Invocation::Bridge(BridgeArgs::default()));

        let parsed = ParsedInvocation::parse_from([
            "mcp-orc",
            "bridge",
            "--host=0.0.0.0",
            "--port",
            "9001",
            "--mcp-path",
            "custom",
            "--core-url",
            "http://core/",
            "--regular-url=http://regular/",
            "--host-url",
            "http://host/",
            "--stdio-proxy",
            "--remote-url",
            "http://bridge/mcp/",
            "--remote-auth-token-file",
            "/tmp/bridge-token",
            "--expose-all-tools",
            "--auth-registry=/tmp/bridge-registry.json",
        ])
        .unwrap();
        assert_eq!(
            parsed.command,
            Invocation::Bridge(BridgeArgs {
                host: "0.0.0.0".to_string(),
                port: 9001,
                mcp_path: "/custom".to_string(),
                core_url: "http://core".to_string(),
                regular_url: "http://regular".to_string(),
                host_url: "http://host".to_string(),
                stdio_proxy: true,
                remote_url: "http://bridge/mcp".to_string(),
                remote_auth_token_file: Some(PathBuf::from("/tmp/bridge-token")),
                expose_all_tools: true,
                auth_registry_path: Some(PathBuf::from("/tmp/bridge-registry.json")),
            })
        );
    }

    #[test]
    fn bridge_parser_rejects_invalid_values() {
        let invalid_port = parse_bridge_args(&["--port=wat".to_string()]).unwrap_err();
        assert!(invalid_port.to_string().contains("invalid --port value"));

        let missing_remote = parse_bridge_args(&["--remote-url".to_string()]).unwrap_err();
        assert!(missing_remote
            .to_string()
            .contains("missing value for --remote-url"));

        let unknown = parse_bridge_args(&["--unknown".to_string()]).unwrap_err();
        assert!(unknown.to_string().contains("unknown bridge argument"));
    }

    #[test]
    fn parses_generator_subcommands() {
        let parsed = ParsedInvocation::parse_from([
            "mcp-orc",
            "generate-mcp-config",
            "--force",
            "--project-root",
            "/tmp/project",
        ])
        .unwrap();
        assert_eq!(parsed.program_name, "mcp-orc");
        assert_eq!(
            parsed.command,
            Invocation::GenerateMcpConfig(GeneratorArgs {
                force: true,
                project_root: Some(PathBuf::from("/tmp/project")),
                server_id: None,
                enabled_only: false,
                deployment_type: None,
                best_effort: false,
                status_file: None,
            })
        );

        let parsed = ParsedInvocation::parse_from([
            "mcp-orc",
            "generate-docker-compose-override",
            "--project-root=/tmp/project",
        ])
        .unwrap();
        assert_eq!(
            parsed.command,
            Invocation::GenerateDockerComposeOverride(GeneratorArgs {
                force: false,
                project_root: Some(PathBuf::from("/tmp/project")),
                server_id: None,
                enabled_only: false,
                deployment_type: None,
                best_effort: false,
                status_file: None,
            })
        );

        let parsed = ParsedInvocation::parse_from([
            "mcp-orc",
            "prepare-managed-node-packages",
            "--project-root=/tmp/project",
            "--enabled-only",
            "--deployment-type",
            "host",
            "--server-id",
            "chrome-devtools",
            "--status-file",
            "/tmp/status.json",
        ])
        .unwrap();
        assert_eq!(
            parsed.command,
            Invocation::PrepareManagedNodePackages(GeneratorArgs {
                force: false,
                project_root: Some(PathBuf::from("/tmp/project")),
                server_id: Some("chrome-devtools".to_string()),
                enabled_only: true,
                deployment_type: Some("host".to_string()),
                best_effort: false,
                status_file: Some(PathBuf::from("/tmp/status.json")),
            })
        );

        let parsed = ParsedInvocation::parse_from([
            "mcp-orc",
            "inspect-server-metadata",
            "--yaml",
            "/tmp/server.yaml",
            "--project-root=/tmp/project",
        ])
        .unwrap();
        assert_eq!(
            parsed.command,
            Invocation::InspectServerMetadata(ServerMetadataArgs {
                yaml: PathBuf::from("/tmp/server.yaml"),
            })
        );

        let invalid = ParsedInvocation::parse_from([
            "mcp-orc",
            "prepare-managed-node-packages",
            "--deployment-type=sidecar",
        ])
        .unwrap_err();
        assert!(invalid.to_string().contains("invalid --deployment-type"));

        let parsed = ParsedInvocation::parse_from([
            "mcp-orc",
            "export-legacy-oauth-record",
            "--server-id",
            "glean",
            "--storage-dir=/tmp/mcpo-oauth-tokens/glean/tokens",
        ])
        .unwrap();
        assert_eq!(
            parsed.command,
            Invocation::ExportLegacyOAuthRecord(LegacyOAuthExportArgs {
                server_id: "glean".to_string(),
                storage_dir: PathBuf::from("/tmp/mcpo-oauth-tokens/glean/tokens"),
            })
        );

        let invalid = ParsedInvocation::parse_from([
            "mcp-orc",
            "export-legacy-oauth-record",
            "--server-id",
            "glean",
        ])
        .unwrap_err();
        assert!(invalid
            .to_string()
            .contains("missing value for --storage-dir"));
    }
}
