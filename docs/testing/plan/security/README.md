# L — Security hardening

Cross-listed with [`docs/security/hardening-overview.md`](../../../security/hardening-overview.md). Most of these have automated guards. Manual verification on the release build is still recommended for any items that touch Keychain, Docker secrets, or filesystem permissions.

- Up: [`docs/testing/README.md`](../../README.md).

---

## Status snapshot

<!-- @portico:status-snapshot:begin -->
| Total | NotRun | Pass | Fail | Skipped | Blocked | N/A |
|---:|---:|---:|---:|---:|---:|---:|
|    24 |      0 |   24 |    0 |       0 |       0 |   0 |
<!-- @portico:status-snapshot:end -->

## At-a-glance

| ID    | Threat | Scenario                                                                                  | Coverage | Status | Last run | File |
|-------|--------|-------------------------------------------------------------------------------------------|----------|--------|----------|------|
| L-01  | V-001  | `PORTICO_LLM_API_KEY` fetched from Vault when available; never plaintext on disk            | Auto     | Pass   | 2026-04-28 | [runtime-secrets.md](runtime-secrets.md) |
| L-02  | V-002  | Bifrost bearer auth uses constant-time compare                                             | Auto     | Pass   | 2026-05-07 | [bifrost-bridge.md](bifrost-bridge.md) |
| L-03  | V-003  | Runtime-secrets registry strips `_FILE` aliases from logs / .env                           | Auto     | Pass   | 2026-04-28 | [runtime-secrets.md](runtime-secrets.md) |
| L-04  | V-004  | Outbound URL validation rejects javascript:/file:/data: schemes                            | Auto     | Pass   | 2026-04-28 | [misc-hardening.md](misc-hardening.md) |
| L-05  | V-005  | Bridge bearer key persisted in Keychain only                                               | Auto     | Pass   | 2026-04-28 | [bifrost-bridge.md](bifrost-bridge.md) |
| L-06  | V-007  | Portico LLM API key install-time embed (legacy fallback)                                    | Auto     | Pass   | 2026-04-28 | [runtime-secrets.md](runtime-secrets.md) |
| L-07  | N-001  | FTS regex query timeout (ReDoS mitigation)                                                 | Auto     | Pass   | 2026-04-28 | [misc-hardening.md](misc-hardening.md) |
| L-08  | N-003  | Docker Compose secrets dirs `0700`, files `0600`; `/dev/null` fallback                     | Auto     | Pass   | 2026-05-07 | [misc-hardening.md](misc-hardening.md) |
| L-09  | N-004  | Project-root plaintext twins of secrets are ignored at runtime                             | Auto     | Pass   | 2026-04-28 | [runtime-secrets.md](runtime-secrets.md) |
| L-10  | N-005  | Cloudsmith upload key not present in packaged builds                                       | Auto     | Pass   | 2026-04-28 | [misc-hardening.md](misc-hardening.md) |
| L-11  | N-007  | Slack OAuth client credentials install-time embed; auto-scrub plaintext after Keychain    | Auto     | Pass   | 2026-04-28 | [oauth-and-tokens.md](oauth-and-tokens.md) |
| L-12  | N-008  | Single-server SSL: cert in user cache, narrow EKU, loopback bind, idempotent re-trust     | Partial  | Pass   | 2026-05-07 | [cert-trust-and-cleanup.md](cert-trust-and-cleanup.md) |
| L-13  | N-009  | OAuth token file ingress + zeroize in Rust http_subprocess sessions                       | Auto     | Pass   | 2026-05-07 | [oauth-and-tokens.md](oauth-and-tokens.md) |
| L-14  | N-010  | OAuth callback HTTPS server bound to `127.0.0.1` only                                     | Auto     | Pass   | 2026-05-15 | [oauth-and-tokens.md](oauth-and-tokens.md) |
| L-15  | N-011  | `clean_full.sh` sweeps Slack Keychain entries + orphan `CN=localhost` certs + token dirs | Manual   | Pass   | 2026-05-07 | [cert-trust-and-cleanup.md](cert-trust-and-cleanup.md) |
| L-16  | —      | After install: `runtime-secrets/` only `0600` files; no env file in project root has key  | Manual   | Pass   | 2026-05-07 | [misc-hardening.md](misc-hardening.md) |
| L-17  | —      | After uninstall: no Keychain entries owned by `portico-*` remain                    | Manual   | Pass   | 2026-05-07 | [cert-trust-and-cleanup.md](cert-trust-and-cleanup.md) |
| L-18  | N-012  | Destructive tool blocks on first call without user confirmation                            | Auto     | Pass   | 2026-05-07 | [tool-confirmation-gate.md](tool-confirmation-gate.md) |
| L-19  | N-012  | Explicit user confirmation drives a single dispatch                                         | Auto     | Pass   | 2026-05-07 | [tool-confirmation-gate.md](tool-confirmation-gate.md) |
| L-20  | N-012  | Hash binding rejects argument and tool drift after approval                                 | Auto     | Pass   | 2026-05-07 | [tool-confirmation-gate.md](tool-confirmation-gate.md) |
| L-21  | N-012  | Stale "yes" cannot authorize a future action                                                | Auto     | Pass   | 2026-05-07 | [tool-confirmation-gate.md](tool-confirmation-gate.md) |
| L-22  | N-012  | Confirmation card UI fails closed and routes through normal chat input                      | Auto     | Pass   | 2026-05-07 | [tool-confirmation-gate.md](tool-confirmation-gate.md) |
| L-23  | N-012  | Forged / unknown confirmation token is rejected                                             | Auto     | Pass   | 2026-05-07 | [tool-confirmation-gate.md](tool-confirmation-gate.md) |

## Files in this folder

- [runtime-secrets.md](runtime-secrets.md) — runtime secrets registry (L-01, L-03, L-06, L-09).
- [bifrost-bridge.md](bifrost-bridge.md) — bridge bearer flow (L-02, L-05).
- [oauth-and-tokens.md](oauth-and-tokens.md) — OAuth credential flow (L-11, L-13, L-14).
- [cert-trust-and-cleanup.md](cert-trust-and-cleanup.md) — cert lifecycle and uninstall sweep (L-12, L-15, L-17).
- [misc-hardening.md](misc-hardening.md) — URL guard, ReDoS, file perms, Cloudsmith, post-install grep (L-04, L-07, L-08, L-10, L-16).
- [tool-confirmation-gate.md](tool-confirmation-gate.md) — per-action MCP write/action confirmation gate (L-18, L-19, L-20, L-21, L-22, L-23).
