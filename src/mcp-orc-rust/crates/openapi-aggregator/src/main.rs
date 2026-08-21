use anyhow::Result;
use env_logger::Env;
use log::error;
use openapi_aggregator::{run, AppConfig, AppState};

fn init_logging() {
    let env = Env::default().default_filter_or("info");
    let mut builder = env_logger::Builder::from_env(env);
    builder.format_timestamp_secs();
    let _ = builder.try_init();
}

#[tokio::main]
async fn main() {
    init_logging();

    if let Err(error) = real_main().await {
        error!("{error:#}");
        std::process::exit(1);
    }
}

async fn real_main() -> Result<()> {
    let config = AppConfig::from_env()?;
    let state = AppState::new(config)?;
    run(state).await
}
