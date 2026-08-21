#[cfg(not(test))]
use std::env;
use std::ffi::OsString;

use anyhow::Result;
use env_logger::Env;
use log::{error, info};
use mcp_orc::cli::Invocation;
use mcp_orc::oauth::configure_env_logger;
use mcp_orc::{bridge, cli, generator, managed_node, runtime};
use thiserror::Error;

#[derive(Debug, Error)]
#[error("{0}")]
struct QuietExitError(anyhow::Error);

pub(crate) fn init_logging() {
    let env = Env::default().default_filter_or("info");
    let mut builder = env_logger::Builder::from_env(env);
    configure_env_logger(&mut builder);
    let _ = builder.try_init();
}

pub(crate) fn exit_code(result: Result<()>) -> i32 {
    match result {
        Ok(()) => 0,
        Err(error) => {
            if error.downcast_ref::<QuietExitError>().is_none() {
                error!("{error:#}");
            }
            1
        }
    }
}

pub(crate) async fn real_main_from_args<I, S>(iter: I) -> Result<()>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let parsed = cli::ParsedInvocation::parse_from(iter)?;
    match &parsed.command {
        Invocation::Serve(_) => {
            info!("Starting native mcp-orc CLI");
            runtime::run(&parsed).await
        }
        Invocation::GenerateMcpConfig(args) => {
            generator::run_generate_mcp_config(args).map_err(|error| QuietExitError(error).into())
        }
        Invocation::GenerateDockerComposeOverride(args) => {
            generator::run_generate_docker_compose_override(args)
                .map_err(|error| QuietExitError(error).into())
        }
        Invocation::PrepareManagedNodePackages(args) => {
            let project_root = generator::resolve_project_root(args.project_root.as_deref())?;
            managed_node::run_prepare_managed_node_packages(
                &project_root,
                args.server_id.as_deref(),
                args.enabled_only,
                args.deployment_type.as_deref(),
                args.best_effort,
                args.status_file.as_deref(),
            )
        }
        Invocation::InspectServerMetadata(args) => {
            generator::run_inspect_server_metadata(&args.yaml)
        }
        Invocation::Bridge(args) => {
            info!("Starting Host MCP bridge");
            bridge::run(args).await
        }
        Invocation::ExportLegacyOAuthRecord(args) => {
            let value = mcp_orc::oauth::export_legacy_oauth_record_value(
                &args.server_id,
                &args.storage_dir,
            )
            .map_err(QuietExitError)?;
            println!("{}", serde_json::to_string(&value)?);
            Ok(())
        }
    }
}

#[cfg(not(test))]
#[tokio::main]
async fn main() {
    init_logging();
    std::process::exit(exit_code(real_main_from_args(env::args()).await));
}

#[cfg(test)]
fn main() {}

#[cfg(test)]
mod tests {
    use super::{exit_code, init_logging, main, real_main_from_args, QuietExitError};
    use serial_test::serial;

    #[test]
    fn init_logging_is_idempotent() {
        init_logging();
        init_logging();
    }

    #[test]
    fn exit_code_maps_results() {
        assert_eq!(exit_code(Ok(())), 0);
        assert_eq!(
            exit_code(Result::<(), anyhow::Error>::Err(anyhow::anyhow!("boom"))),
            1
        );
    }

    #[tokio::test]
    async fn real_main_rejects_missing_args() {
        let error = real_main_from_args(Vec::<String>::new()).await.unwrap_err();
        assert!(error.to_string().contains("missing argv[0]"));
    }

    #[tokio::test]
    #[serial]
    async fn real_main_routes_into_runtime() {
        let error = real_main_from_args(["mcpo", "--config", "/tmp/missing-mcp-config.json"])
            .await
            .unwrap_err();
        assert!(error.to_string().contains("failed to read"));
    }

    #[tokio::test]
    async fn real_main_routes_into_generator() {
        let tempdir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tempdir.path().join("mcp-configs")).unwrap();
        let result = real_main_from_args([
            "mcp-orc",
            "generate-mcp-config",
            "--project-root",
            tempdir.path().to_str().unwrap(),
        ])
        .await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn metadata_inspection_reports_parse_failures() {
        let tempdir = tempfile::tempdir().unwrap();
        let yaml = tempdir.path().join("invalid.yaml");
        std::fs::write(&yaml, "required_env_vars: [\n").unwrap();
        let error = real_main_from_args([
            "mcp-orc",
            "inspect-server-metadata",
            "--yaml",
            yaml.to_str().unwrap(),
        ])
        .await
        .unwrap_err();
        assert!(error.to_string().contains("invalid YAML"));
        assert!(error.downcast_ref::<QuietExitError>().is_none());
    }

    #[test]
    fn test_main_stub_is_a_noop() {
        main();
    }
}
