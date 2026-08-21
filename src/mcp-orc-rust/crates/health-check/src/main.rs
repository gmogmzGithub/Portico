use anyhow::{anyhow, Result};
use env_logger::Env;
use health_check::app;
use log::error;

pub(crate) fn init_logging() {
    let env = Env::default().default_filter_or("info");
    let mut builder = env_logger::Builder::from_env(env);
    builder.format_timestamp_secs();
    let _ = builder.try_init();
}

pub(crate) fn exit_code(result: Result<bool>) -> i32 {
    match result {
        Ok(true) => 0,
        Ok(false) => 1,
        Err(error) => {
            error!("{error:#}");
            1
        }
    }
}

#[cfg_attr(test, allow(dead_code))]
pub(crate) async fn real_main() -> Result<bool> {
    real_main_with_args(std::env::args().skip(1).collect()).await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HealthCheckCommand {
    Full,
    StartupReadiness,
}

fn command_from_args(args: Vec<String>) -> Result<HealthCheckCommand> {
    match args.as_slice() {
        [] => Ok(HealthCheckCommand::Full),
        [command] if command == "startup-readiness" => Ok(HealthCheckCommand::StartupReadiness),
        [command] => Err(anyhow!("unknown health-check command '{command}'")),
        _ => Err(anyhow!(
            "expected at most one health-check command, got {}",
            args.len()
        )),
    }
}

#[cfg_attr(test, allow(dead_code))]
pub(crate) async fn real_main_with_args(args: Vec<String>) -> Result<bool> {
    match command_from_args(args)? {
        HealthCheckCommand::Full => app::run_default().await,
        HealthCheckCommand::StartupReadiness => app::run_startup_readiness_from_env().await,
    }
}

#[cfg(not(test))]
#[tokio::main]
async fn main() {
    init_logging();
    std::process::exit(exit_code(real_main().await));
}

#[cfg(test)]
fn main() {}

#[cfg(test)]
mod tests {
    use super::{command_from_args, exit_code, init_logging, main, HealthCheckCommand};

    #[test]
    fn init_logging_is_idempotent() {
        init_logging();
        init_logging();
    }

    #[test]
    fn exit_code_maps_results() {
        assert_eq!(exit_code(Ok(true)), 0);
        assert_eq!(exit_code(Ok(false)), 1);
        assert_eq!(
            exit_code(Result::<bool, anyhow::Error>::Err(anyhow::anyhow!("boom"))),
            1
        );
    }

    #[test]
    fn main_stub_is_noop() {
        main();
    }

    #[test]
    fn command_from_args_defaults_to_full_and_accepts_startup_readiness() {
        assert_eq!(command_from_args(vec![]).unwrap(), HealthCheckCommand::Full);
        assert_eq!(
            command_from_args(vec!["startup-readiness".to_string()]).unwrap(),
            HealthCheckCommand::StartupReadiness
        );
        assert!(command_from_args(vec!["bogus".to_string()]).is_err());
        assert!(
            command_from_args(vec!["startup-readiness".to_string(), "extra".to_string()]).is_err()
        );
    }
}
