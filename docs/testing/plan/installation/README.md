# A — Installation, build channels & clean state

Covers the install/uninstall/reinstall life cycle, build-channel switching, and the first-run guided setup wizard.

- Up: [`docs/testing/README.md`](../../README.md).
- Related: [`install_v2.sh`](../../../../install_v2.sh), [`clean_full.sh`](../../../../clean_full.sh), [`docs/security/hardening-overview.md`](../../../security/hardening-overview.md) (for runtime-secrets cleanup).

---

## Status snapshot

<!-- @portico:status-snapshot:begin -->
| Total | NotRun | Pass | Fail | Skipped | Blocked | N/A |
|---:|---:|---:|---:|---:|---:|---:|
|    18 |     14 |    4 |    0 |       0 |       0 |   0 |
<!-- @portico:status-snapshot:end -->

## At-a-glance

| ID    | Scenario                                                                                          | Type    | Coverage | Status | Last run | File |
|-------|---------------------------------------------------------------------------------------------------|---------|----------|--------|----------|------|
| A-01  | `install_v2.sh` (no flags) installs Bifrost stack + advanced config and launches                  | Setup   | Partial  | Pass   | 2026-04-28 | [install-v2-flags.md](install-v2-flags.md) |
| A-02  | `install_v2.sh --no-launch` builds without launching                                              | Setup   | Manual   | NotRun | -        | [install-v2-flags.md](install-v2-flags.md) |
| A-03  | `install_v2.sh --skip-deps` rebuilds Electron only                                                | Setup   | Manual   | NotRun | -        | [install-v2-flags.md](install-v2-flags.md) |
| A-04  | `install_v2.sh --node` runs local dev build via `npm`                                             | Setup   | Manual   | NotRun | -        | [install-v2-flags.md](install-v2-flags.md) |
| A-06  | `install_v2.sh --no-cache` rebuilds Docker images without cache                                   | Setup   | Manual   | NotRun | -        | [install-v2-flags.md](install-v2-flags.md) |
| A-07  | `install_v2.sh --force-no-host` forces `HOST_MODE=FALSE`                                          | Setup   | Auto     | Pass   | 2026-04-28 | [install-v2-flags.md](install-v2-flags.md) |
| A-08  | `install_v2.sh --force-local-build` skips Harbor pull and builds locally                          | Setup   | Manual   | NotRun | -        | [install-v2-flags.md](install-v2-flags.md) |
| A-09  | `install_v2.sh --mac-all-arch` produces both x64 and arm64 builds                                 | Setup   | Manual   | NotRun | -        | [install-v2-flags.md](install-v2-flags.md) |
| A-10  | `install_v2.sh --rust-full` fails install when Rust toolchain is missing                          | Setup   | Manual   | NotRun | -        | [install-v2-flags.md](install-v2-flags.md) |
| A-11  | `install_v2.sh` auto-installs Rust toolchain on a fresh macOS profile                             | Setup   | Manual   | NotRun | -        | [install-v2-flags.md](install-v2-flags.md) |
| A-12  | `clean_full.sh` removes Docker, app bundle, AS state, runtime-secrets, OAuth tokens, Keychain     | Setup   | Partial  | NotRun | -        | [clean-and-state.md](clean-and-state.md) |
| A-13  | `clean_full.sh` removes trusted self-signed certificates from the login Keychain                  | Setup   | Manual   | NotRun | -        | [clean-and-state.md](clean-and-state.md) |
| A-14  | `clean_full.sh --dry-run` lists planned actions and changes nothing                               | Setup   | Manual   | NotRun | -        | [clean-and-state.md](clean-and-state.md) |
| A-15  | `clean_full.sh` does not restart OrbStack when no Docker artefacts exist                          | Setup   | Manual   | NotRun | -        | [clean-and-state.md](clean-and-state.md) |
| A-16  | Switch release channel via menu seeds `UPDATE_CHANNEL` and rebuilds the menu                      | Setup   | Partial  | Pass   | 2026-04-28 | [channels-and-guided-setup.md](channels-and-guided-setup.md) |
| A-17  | First-run guided setup walks all 9 screens                                                        | Setup   | Auto     | NotRun | -        | [channels-and-guided-setup.md](channels-and-guided-setup.md) |
| A-18  | Finalize blocks then unblocks correctly when prereqs change underneath                            | Setup   | Auto     | Pass   | 2026-04-28 | [channels-and-guided-setup.md](channels-and-guided-setup.md) |

## Files in this folder

- [install-v2-flags.md](install-v2-flags.md) — `install_v2.sh` invocations and flag matrix (A-01 .. A-11).
- [clean-and-state.md](clean-and-state.md) — `clean_full.sh` and clean-state checks (A-12 .. A-15).
- [channels-and-guided-setup.md](channels-and-guided-setup.md) — release channels and first-run wizard (A-16 .. A-18).
