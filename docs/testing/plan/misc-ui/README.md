# M — Other UI: dialogs, log viewer, modals, observability

Nine scenarios that don't fit cleanly into the chat / search / shell sections — modals, log viewer, marketplace UI surface, the loading-overlay safety timeout, the LLM debug monitor, etc.

- Up: [`docs/testing/README.md`](../../README.md).

---

## Status snapshot

<!-- @portico:status-snapshot:begin -->
| Total | NotRun | Pass | Fail | Skipped | Blocked | N/A |
|---:|---:|---:|---:|---:|---:|---:|
|     9 |      3 |    6 |    0 |       0 |       0 |   0 |
<!-- @portico:status-snapshot:end -->

## At-a-glance

| ID   | Scenario                                                                                  | Type     | Coverage | Status | Last run | File |
|------|-------------------------------------------------------------------------------------------|----------|----------|--------|----------|------|
| M-01 | User-question modal renders multi-question review controls                               | Shell    | Auto     | Pass   | 2026-04-28 | [modals-and-dialogs.md](modals-and-dialogs.md) |
| M-02 | User-question modal accepts the built-in "none of the above" option                       | Shell    | Auto     | Pass   | 2026-04-28 | [modals-and-dialogs.md](modals-and-dialogs.md) |
| M-03 | MCP config modal renders markdown setup instructions                                      | Shell    | Auto     | Pass   | 2026-04-28 | [modals-and-dialogs.md](modals-and-dialogs.md) |
| M-04 | Marketplace UI lists all configured marketplaces and per-marketplace failure reasons      | Shell    | Auto     | Pass   | 2026-04-28 | [modals-and-dialogs.md](modals-and-dialogs.md) |
| M-05 | Log viewer streams lines without blocking the renderer                                    | Shell    | Manual   | NotRun | -        | [modals-and-dialogs.md](modals-and-dialogs.md) |
| M-06 | Loading overlay auto-hides after the 60s safety timeout (regression #53)                  | Shell    | Auto     | Pass   | 2026-04-28 | [observability-and-headers.md](observability-and-headers.md) |
| M-07 | Current-user header refreshes after Portico auth                                           | Shell    | Auto     | Pass   | 2026-04-28 | [observability-and-headers.md](observability-and-headers.md) |
| M-08 | About dialog reads version + build + channel from `build-info.json`                       | Shell    | Manual   | NotRun | -        | [observability-and-headers.md](observability-and-headers.md) |
| M-09 | LLM debug monitor exposes traffic; bearer-protected with `compare_digest`                 | Security | Auto     | NotRun | -        | [observability-and-headers.md](observability-and-headers.md) |

## Files in this folder

- [modals-and-dialogs.md](modals-and-dialogs.md) — user-question, MCP config, marketplace, and log viewer modals (M-01..M-05).
- [observability-and-headers.md](observability-and-headers.md) — loading overlay, current-user header, About dialog, debug monitor (M-06..M-09).
