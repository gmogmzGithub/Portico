pub mod app;
mod app_oauth_probe;
mod app_support;
mod app_tool_oauth;
pub mod bridge;
mod bridge_telemetry;
mod classic_sse;
pub mod cli;
pub mod config;
pub mod generator;
pub mod managed_node;
pub mod oauth;
pub mod openapi;
mod overflow;
pub mod response;
pub mod runtime;
pub mod session;
mod streamable_http_reqwest_compat;

#[cfg(test)]
pub mod test_support;

#[cfg(test)]
pub(crate) fn test_env_lock() -> std::sync::MutexGuard<'static, ()> {
    use std::sync::{Mutex as StdMutex, OnceLock};

    static LOCK: OnceLock<StdMutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| StdMutex::new(()))
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}
