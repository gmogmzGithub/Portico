# I — LLM routing

Bifrost gateway, bridge bearer, runtime-secrets path, health checks, and OWUI model list refresh.

- Up: [`docs/testing/README.md`](../../README.md).
- Cross-references: V-002, V-005, V-007 in [`docs/security/hardening-overview.md`](../../../security/hardening-overview.md).

---

## Status snapshot

<!-- @portico:status-snapshot:begin -->
| Total | NotRun | Pass | Fail | Skipped | Blocked | N/A |
|---:|---:|---:|---:|---:|---:|---:|
|     8 |      3 |    5 |    0 |       0 |       0 |   0 |
<!-- @portico:status-snapshot:end -->

## At-a-glance

| ID    | Scenario                                                                          | Type | Coverage | Status | Last run |
|-------|-----------------------------------------------------------------------------------|------|----------|--------|----------|
| I-01  | Bifrost is the active gateway by default                                          | LLM  | Auto     | Pass   | 2026-04-28 |
| I-02  | Bifrost bearer auth uses constant-time compare                                    | LLM  | Auto     | NotRun | -        |
| I-03  | Bridge bearer key is generated once, persisted to Keychain, mounted via Docker secret | LLM | Auto  | Pass   | 2026-04-28 |
| I-04  | `PORTICO_LLM_API_KEY` is sourced via the V-007 chain (env → Keychain → embed)      | LLM  | Auto     | Pass   | 2026-04-28 |
| I-05  | Health check polls Bifrost via local Node HTTP                                    | LLM  | Partial  | NotRun | -        |
| I-07  | Cost-dashboard tracks token usage when enabled                                    | LLM  | Auto     | Pass   | 2026-04-28 |
| I-08  | OWUI model list refreshes after enabling a new model in Bifrost                   | LLM  | Auto     | Pass   | 2026-04-28 |

See [routing.md](routing.md) for full per-scenario procedures.

## Files in this folder

- [routing.md](routing.md) — All 8 routing scenarios (I-01 .. I-08).
