# C — Themes & UI preferences

Theme defaults, sun/moon toggle, persistence, broadcast across windows, and miscellaneous UI prefs (scale, sidebar, fonts).

- Up: [`docs/testing/README.md`](../../README.md).

---

## Status snapshot

<!-- @portico:status-snapshot:begin -->
| Total | NotRun | Pass | Fail | Skipped | Blocked | N/A |
|---:|---:|---:|---:|---:|---:|---:|
|     9 |      2 |    7 |    0 |       0 |       0 |   0 |
<!-- @portico:status-snapshot:end -->

## At-a-glance

| ID    | Scenario                                                                            | Type   | Coverage | Status | Last run | File |
|-------|-------------------------------------------------------------------------------------|--------|----------|--------|----------|------|
| C-01  | App boots in dark theme by default on first run                                     | Theme  | Partial  | Pass   | 2026-04-28 | [theme-toggle.md](theme-toggle.md) |
| C-02  | Sun/moon button in the header toggles between dark and light                        | Theme  | Auto     | Pass   | 2026-04-28 | [theme-toggle.md](theme-toggle.md) |
| C-03  | Theme choice persists across restart (`localStorage.theme`)                         | Theme  | Manual   | NotRun | -        | [theme-toggle.md](theme-toggle.md) |
| C-04  | Theme broadcasts to all windows (detached / OWUI webview / conversation)            | Theme  | Auto     | Pass   | 2026-04-28 | [theme-toggle.md](theme-toggle.md) |
| C-05  | Light theme uses tokens (`--portico-accent-fill` / `--portico-accent-text`)                 | Theme  | Auto     | Pass   | 2026-04-28 | [ui-preferences.md](ui-preferences.md) |
| C-06  | OWUI hidden `'her'` theme is NOT triggerable from PORTICO shell UI                      | Theme  | Manual   | NotRun | -        | [ui-preferences.md](ui-preferences.md) |
| C-07  | UI scale (zoom) persists across restart and per-view                                | Theme  | Auto     | Pass   | 2026-04-28 | [ui-preferences.md](ui-preferences.md) |
| C-08  | OWUI sidebar collapse/expand state persists                                         | Theme  | Auto     | Pass   | 2026-04-28 | [ui-preferences.md](ui-preferences.md) |
| C-09  | Font migration runs once on first launch and is idempotent                          | Theme  | Auto     | Pass   | 2026-04-28 | [ui-preferences.md](ui-preferences.md) |

## Files in this folder

- [theme-toggle.md](theme-toggle.md) — Theme default, toggle, persistence, broadcast (C-01 .. C-04).
- [ui-preferences.md](ui-preferences.md) — Scale, sidebar, fonts, hidden theme guards (C-05 .. C-09).
