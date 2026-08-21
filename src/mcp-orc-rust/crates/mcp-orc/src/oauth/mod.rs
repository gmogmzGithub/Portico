mod binding;
mod binding_discovery_support;
mod binding_support;
mod config;
mod coordinator;
mod discovery;
mod logging;
mod storage;

use std::env;

pub(crate) use binding::{oauth_access_token_sha256, OAuthSecureRecordRefreshOutcome};
pub use binding::{
    OAuthBinding, OAuthBrokerSeedOutcome, OAuthRefreshOutcome, OAuthStreamableHttpClient,
    OAuthTransportError,
};
pub(crate) use binding_discovery_support::discover_metadata_from_authorization_server;
pub use config::{CredentialSourceConfig, LoadedCredentials, OAuthConfig};
pub use coordinator::{OAuthCoordinator, OAuthHandshake, OAuthState};
pub(crate) use discovery::{discover_from_auth_challenge, OAuthDiscovery};
pub use logging::configure_env_logger;
pub(crate) use logging::{oauth_info, oauth_warn};
pub use storage::{
    export_legacy_oauth_record_value, CompatClientInfo, CompatStateStore, CompatTokenFile,
    CompatTokenStore,
};

pub const NATIVE_MODE_ENV: &str = "MCP_ORC_NATIVE_MODE";
pub const DEFAULT_NATIVE_MODE: &str = "native";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeImplementationState {
    Native,
}

pub fn native_mode_from_env() -> String {
    env::var(NATIVE_MODE_ENV).unwrap_or_else(|_| DEFAULT_NATIVE_MODE.to_string())
}

pub fn implementation_state() -> NativeImplementationState {
    NativeImplementationState::Native
}

#[cfg(test)]
struct EnvGuard(Vec<(String, Option<String>)>);

#[cfg(test)]
impl EnvGuard {
    fn capture(keys: &[&str]) -> Self {
        Self(
            keys.iter()
                .map(|key| ((*key).to_string(), std::env::var(key).ok()))
                .collect(),
        )
    }
}

#[cfg(test)]
impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (key, value) in self.0.drain(..) {
            match value {
                Some(value) => std::env::set_var(&key, value),
                None => std::env::remove_var(&key),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        implementation_state, native_mode_from_env, EnvGuard, NativeImplementationState,
        DEFAULT_NATIVE_MODE, NATIVE_MODE_ENV,
    };
    use serial_test::serial;

    #[test]
    fn defaults_to_native_runtime() {
        assert_eq!(DEFAULT_NATIVE_MODE, "native");
        assert_eq!(implementation_state(), NativeImplementationState::Native);
    }

    #[test]
    #[serial]
    fn reads_native_mode_from_env() {
        let _env = EnvGuard::capture(&[NATIVE_MODE_ENV]);
        std::env::remove_var(NATIVE_MODE_ENV);
        assert_eq!(native_mode_from_env(), DEFAULT_NATIVE_MODE);
        std::env::set_var(NATIVE_MODE_ENV, "compatibility");
        assert_eq!(native_mode_from_env(), "compatibility");
    }
}

#[cfg(test)]
#[path = "mod_extra_tests.rs"]
mod extra_tests;

#[cfg(test)]
#[path = "binding_discovery_fallback_tests.rs"]
mod binding_discovery_fallback_tests;
