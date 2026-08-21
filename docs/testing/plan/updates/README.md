# K — Update & distribution

Auto-update poll, manual reinstall flows, channel switching, prep-script error surfacing, DMG/Gatekeeper, and Cloudsmith token policy.

- Up: [`docs/testing/README.md`](../../README.md).
- Cross-references: N-005 in [`docs/security/hardening-overview.md`](../../../security/hardening-overview.md).

---

## Status snapshot

<!-- @portico:status-snapshot:begin -->
| Total | NotRun | Pass | Fail | Skipped | Blocked | N/A |
|---:|---:|---:|---:|---:|---:|---:|
|    10 |      1 |    9 |    0 |       0 |       0 |   0 |
<!-- @portico:status-snapshot:end -->

## At-a-glance

| ID    | Scenario                                                                            | Type   | Coverage | Status | Last run |
|-------|-------------------------------------------------------------------------------------|--------|----------|--------|----------|
| K-01  | Auto-update poll detects a newer Cloudsmith build on the active channel             | Update | Auto     | Pass   | 2026-04-28 |
| K-02  | Manual "Check for Updates…" forces a poll                                           | Update | Auto     | Pass   | 2026-04-28 |
| K-03  | "Reinstall Latest Build…" downloads + applies the latest build                      | Update | Auto     | Pass   | 2026-04-28 |
| K-04  | "Install Specific Build…" lets the user pick a build by hash and applies it         | Update | Auto     | Pass   | 2026-04-28 |
| K-05  | Prepare-update script refuses staging inside the managed app directory              | Update | Auto     | Pass   | 2026-04-28 |
| K-06  | Update progress shows machine-readable markers                                      | Update | Auto     | Pass   | 2026-04-28 |
| K-07  | Update failure surfaces the *real* prep-script error                                | Update | Auto     | Pass   | 2026-04-28 |
| K-08  | Channel switch (Stable → Beta) immediately re-evaluates available updates           | Update | Partial  | Pass   | 2026-04-28 |
| K-09  | Release ZIP round-trip and DMG preserve signatures/notarization                     | Update | Manual   | NotRun | -        |
| K-10  | Cloudsmith read-token in packaged builds; upload-token NOT present                  | Update | Auto     | Pass   | 2026-04-28 |

See [auto-update-and-distribution.md](auto-update-and-distribution.md) for full per-scenario procedures.

## Files in this folder

- [auto-update-and-distribution.md](auto-update-and-distribution.md) — All 10 update scenarios (K-01 .. K-10).
