use super::{
    implementation_state, native_mode_from_env, EnvGuard, NativeImplementationState,
    NATIVE_MODE_ENV,
};
use serial_test::serial;

#[test]
#[serial]
fn native_mode_from_env_returns_exact_custom_values() {
    let _env = EnvGuard::capture(&[NATIVE_MODE_ENV]);
    std::env::set_var(NATIVE_MODE_ENV, "rust-full");
    assert_eq!(native_mode_from_env(), "rust-full");

    std::env::set_var(NATIVE_MODE_ENV, "");
    assert_eq!(native_mode_from_env(), "");
}

#[test]
#[serial]
fn implementation_state_stays_native_regardless_of_env() {
    let _env = EnvGuard::capture(&[NATIVE_MODE_ENV]);
    std::env::set_var(NATIVE_MODE_ENV, "compatibility");
    assert_eq!(implementation_state(), NativeImplementationState::Native);

    std::env::set_var(NATIVE_MODE_ENV, "native");
    assert_eq!(implementation_state(), NativeImplementationState::Native);
}
