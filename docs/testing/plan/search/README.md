# E — Search & navigation

PORTICO-67 introduced unified result cards, regex toggle, and the **Include Agent Traces** opt-in. PORTICO-68 hardened the FTS regex path against ReDoS.

- Up: [`docs/testing/README.md`](../../README.md).
- Related: [`docs/howto/users/search.md`](../../../howto/users/search.md), [`docs/architecture/chat-ui/search.md`](../../../architecture/chat-ui/search.md).

---

## Status snapshot

<!-- @portico:status-snapshot:begin -->
| Total | NotRun | Pass | Fail | Skipped | Blocked | N/A |
|---:|---:|---:|---:|---:|---:|---:|
|    19 |      1 |   18 |    0 |       0 |       0 |   0 |
<!-- @portico:status-snapshot:end -->

## At-a-glance

| ID    | Scenario                                                                          | Type   | Coverage | Status | Last run | File |
|-------|-----------------------------------------------------------------------------------|--------|----------|--------|----------|------|
| E-01  | `Shift+Cmd+F` global search shows unified cards (title + snippet hits merged)     | Search | Auto     | Pass   | 2026-04-28 | [global-search.md](global-search.md) |
| E-02  | Plain-text query with punctuation returns literal results, not FTS errors         | Search | Auto     | Pass   | 2026-04-28 | [global-search.md](global-search.md) |
| E-03  | Regex mode toggle is opt-in; ReDoS patterns time out safely                       | Search | Auto     | Pass   | 2026-04-28 | [global-search.md](global-search.md) |
| E-04  | "Include Agent Traces" toggle exposes hidden tool/reasoning content; default off  | Search | Auto     | Pass   | 2026-04-28 | [global-search.md](global-search.md) |
| E-05  | Click on a result jumps to that chat and scrolls to the matched message           | Search | Partial  | NotRun | -        | [global-search.md](global-search.md) |
| E-06  | Result list is ordered by recency after merging title + snippet hits              | Search | Auto     | Pass   | 2026-04-28 | [global-search.md](global-search.md) |
| E-07  | Find-in-page (`Cmd+F`) highlights matches; Esc restores focus                     | Search | Auto     | Pass   | 2026-04-28 | [in-chat-find.md](in-chat-find.md) |
| E-08  | Search modal `_FTS_VERSION` matches production schema (currently 7)               | Search | Auto     | Pass   | 2026-04-28 | [in-chat-find.md](in-chat-find.md) |
| E-09  | Search index updates after a message edit (resync)                                | Search | Auto     | Pass   | 2026-04-28 | [in-chat-find.md](in-chat-find.md) |

## Files in this folder

- [global-search.md](global-search.md) — `Shift+Cmd+F` global FTS (E-01 .. E-06).
- [in-chat-find.md](in-chat-find.md) — `Cmd+F` find-in-page, schema version, edit resync (E-07 .. E-09).
