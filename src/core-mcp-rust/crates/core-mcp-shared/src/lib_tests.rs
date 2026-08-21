use super::*;

#[test]
fn init_logging_covers_default_and_env_filter_paths() {
    let guard = TEST_ENV_LOCK
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let previous = env::var("RUST_LOG").ok();

    env::remove_var("RUST_LOG");
    init_logging();

    env::set_var("RUST_LOG", "debug");
    init_logging();

    if let Some(value) = previous {
        env::set_var("RUST_LOG", value);
    } else {
        env::remove_var("RUST_LOG");
    }

    drop(guard);
}
