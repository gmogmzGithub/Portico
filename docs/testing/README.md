# Portico — Release Test Plan

> **Purpose** — A comprehensive, structured catalog of test scenarios that should pass before cutting any new release of Portico. Every scenario has a stable ID, a coverage status, an explicit set of executable steps, and a `Last execution` tracker that records whether it has been run, by whom, against which build, and the outcome.
>
> **Source-of-truth principle** — This tree is authoritative for *what* must be exercised at release time. Implementation details and post-mortems live in [`docs/CHANGELOG.md`](../CHANGELOG.md) and [`docs/incidents/`](../incidents/). Security threat-model rationale lives in [`docs/security/hardening-overview.md`](../security/hardening-overview.md). This index references both.

---

## How to use this plan

1. Start with **[§ 0 — Pre-release smoke](plan/pre-release-smoke/README.md)**. If any P0 fails, do not ship.
2. Walk the remaining sections in order during the candidate-build burndown. Each section is a folder with its own `README.md` index plus topic subfiles.
3. For every scenario:
   - Read **Preconditions** to set up state.
   - Execute **Steps** in order.
   - Compare actual outcome with **Expected**.
   - Record the result with the tools below — they update the **Last execution** block, the section snapshot, and the top-level dashboard automatically.

The canonical per-scenario template lives at [`templates/scenario.md`](templates/scenario.md).

### Recording results (no manual table edits)

Status lives in [`status.json`](status.json) and is rendered into all the markdown blocks/tables marked `<!-- @portico:* -->`. Three entry points cover everything; full docs at [`tools/test-plan/README.md`](../../tools/test-plan/README.md).

```bash
# Run any test through the wrapper. It auto-resolves which scenario IDs
# cite the test path and records Pass/Fail per scenario based on exit code.
./tools/test-plan/run-and-record.sh node --test electron-app/src/services/shell-open.test.js

# Run every Auto-coverage scenario (or filter by ID prefix).
node tools/test-plan/run-auto.mjs --filter '^L-'

# Record a manual scenario.
node tools/test-plan/record.mjs --id B-17 --status Pass --notes "manual on macOS 25.4"

# Re-render only (after editing status.json by hand or pulling someone's update).
node tools/test-plan/render.mjs

# CI guardrail: exits 1 if the markdown is out of sync with status.json.
node tools/test-plan/render.mjs --check
```

For frozen per-release records, copy this whole tree into [`releases/<version>/`](releases/) and update the dashboard there.

---

## Status dashboard

> Auto-rendered from [`status.json`](status.json) by [`tools/test-plan/render.mjs`](../../tools/test-plan/render.mjs). Do not edit between the markers — run `node tools/test-plan/render.mjs` after recording results.

<!-- @portico:status-dashboard:begin -->
| Section                          | Total | NotRun | Pass | Fail | Skipped | Blocked | N/A |
|----------------------------------|------:|-------:|-----:|-----:|--------:|--------:|----:|
| 0. Pre-release smoke             |     8 |      3 |    5 |    0 |       0 |       0 |   0 |
| A. Installation & clean state    |    18 |     14 |    4 |    0 |       0 |       0 |   0 |
| B. Shell, windows & shortcuts    |    34 |     12 |   22 |    0 |       0 |       0 |   0 |
| C. Themes & UI preferences       |     9 |      2 |    7 |    0 |       0 |       0 |   0 |
| D. Chat UI & OWUI patches        |    10 |      7 |    3 |    0 |       0 |       0 |   0 |
| E. Search & navigation           |    19 |      1 |   18 |    0 |       0 |       0 |   0 |
| F. Detached windows & artifacts  |     6 |      1 |    5 |    0 |       0 |       0 |   0 |
| G. MCP orchestration             |    25 |     11 |   14 |    0 |       0 |       0 |   0 |
| H. Auth, OAuth & integrations    |    19 |      0 |   18 |    0 |       0 |       0 |   1 |
| I. LLM routing                   |     8 |      3 |    5 |    0 |       0 |       0 |   0 |
| J. Agent skills & sub-agents     |     9 |      1 |    7 |    0 |       1 |       0 |   0 |
| K. Update & distribution         |    10 |      1 |    9 |    0 |       0 |       0 |   0 |
| L. Security hardening            |    24 |      0 |   24 |    0 |       0 |       0 |   0 |
| M. Other UI & observability      |     9 |      3 |    6 |    0 |       0 |       0 |   0 |
| N. Konami / hidden features      |     5 |      1 |    4 |    0 |       0 |       0 |   0 |
| O. Performance & smoke           |     5 |      4 |    1 |    0 |       0 |       0 |   0 |
| **Total**                        | **218** | **64** | **152** | **0** | **1** | **0** | **1** |
<!-- @portico:status-dashboard:end -->

---

## Section index

| Section | Folder | Highlights |
|---|---|---|
| 0. Pre-release smoke | [`plan/pre-release-smoke/`](plan/pre-release-smoke/README.md) | Eight P0 must-pass scenarios |
| A. Installation     | [`plan/installation/`](plan/installation/README.md) | install_v2 flags, clean_full, channels, guided setup |
| B. Shell            | [`plan/shell/`](plan/shell/README.md) | Window/menu structure, shortcuts, tabs, focus handoff |
| C. Themes           | [`plan/themes/`](plan/themes/README.md) | Theme toggle, scale, sidebar prefs |
| D. Chat UI          | [`plan/chat-ui/`](plan/chat-ui/README.md) | Model picker, streaming, attachments, copy |
| E. Search           | [`plan/search/`](plan/search/README.md) | Global FTS, in-chat find, ReDoS guards |
| F. Detached windows | [`plan/detached-windows/`](plan/detached-windows/README.md) | Detach/reattach, artifact panel |
| G. MCP              | [`plan/mcp/`](plan/mcp/README.md) | Toggles, marketplace, per-server debug |
| H. Auth             | [`plan/auth/`](plan/auth/README.md) | Portico login, OAuth wizard, token-based setup |
| I. LLM              | [`plan/llm/`](plan/llm/README.md) | Bifrost, bridge bearer, health checks |
| J. Skills           | [`plan/skills/`](plan/skills/README.md) | Built-in skills, agent VM, sub-agents |
| K. Updates          | [`plan/updates/`](plan/updates/README.md) | Auto-update, manual install, channels, DMG |
| L. Security         | [`plan/security/`](plan/security/README.md) | V-/N- threat-model coverage |
| M. Misc UI          | [`plan/misc-ui/`](plan/misc-ui/README.md) | Modals, log viewer, header, debug monitor |
| N. Konami           | [`plan/konami/`](plan/konami/README.md) | Hidden 10-click unlock |
| O. Performance      | [`plan/perf/`](plan/perf/README.md) | Cold start, memory, bulk operations |

---

## Coverage map (Auto / Partial / Manual)

> Auto-rendered from each scenario's `**Coverage:**` line by [`tools/test-plan/render.mjs`](../../tools/test-plan/render.mjs). Do not edit between the markers.

<!-- @portico:coverage-map:begin -->
| Section                          | Total | Auto | Partial | Manual |
|----------------------------------|------:|-----:|--------:|-------:|
| 0. Pre-release smoke             |     8 |    1 |       6 |      1 |
| A. Installation & clean state    |    18 |    3 |       3 |     12 |
| B. Shell, windows & shortcuts    |    34 |   17 |      10 |      7 |
| C. Themes & UI preferences       |     9 |    6 |       1 |      2 |
| D. Chat UI & OWUI patches        |    10 |    2 |       3 |      5 |
| E. Search & navigation           |    19 |    8 |       1 |     10 |
| F. Detached windows & artifacts  |     6 |    5 |       0 |      1 |
| G. MCP orchestration             |    25 |   19 |       3 |      3 |
| H. Auth, OAuth & integrations    |    19 |    9 |       0 |     10 |
| I. LLM routing                   |     8 |    6 |       1 |      1 |
| J. Agent skills & sub-agents     |     9 |    8 |       0 |      1 |
| K. Update & distribution         |    10 |    8 |       1 |      1 |
| L. Security hardening            |    24 |   20 |       1 |      3 |
| M. Other UI & observability      |     9 |    7 |       0 |      2 |
| N. Konami / hidden features      |     5 |    4 |       1 |      0 |
| O. Performance & smoke           |     5 |    1 |       0 |      4 |
| **Total**                        | **218** | **124 (57%)** | **31 (14%)** | **63 (29%)** |
<!-- @portico:coverage-map:end -->

---

## Suggested next coverage targets

These currently-manual scenarios are the highest-value candidates for new automation. Re-evaluate before each release — the live `Coverage map` above is the source of truth for what is still Manual.

1. **A-13** — script-level test that exercises `clean_full.sh` end-to-end (covered for the cert-SHA1 / Keychain layers in [`tests/clean-full.unit.test.js`](../../tests/clean-full.unit.test.js); the install-side parity is still Manual).
2. **B-17 / B-18 / B-19** — Playwright/Spectron-style integration test driving `Cmd+Q`, `Cmd+1..9`, `Cmd+Opt+←`/`→` against a live shell.
3. **C-03** — restart-persistence test for the theme; wrap into [`konami-theme-toggle.test.js`](../../electron-app/src/services/konami-theme-toggle.test.js) or a new file.
4. **G-06** — assert the cross-validation between the LLM context and the Electron API (extend `unified_context` integration tests).
5. **H-11** — automated cert-trust verification (likely a shell script that calls `security verify-cert`).
6. **K-09** — release-CI step that verifies the produced DMG passes `spctl --assess --type execute`.
7. **D-04 / D-10** — model-access-denied UX and Bedrock-thinking-signature regression coverage.

---

## Per-release usage

For each release, copy this whole `docs/testing/` subtree to `docs/testing/releases/<version>/` and:

1. Record results as you execute, using the entry points in [Recording results](#recording-results-no-manual-table-edits) above. The render step propagates each result into the per-scenario `Last execution` block, the per-section snapshot, and the top-level dashboard automatically.
2. Link the resulting folder from the release notes.
3. File any failures as issues with the test ID (e.g. `B-15`) in the title for traceability.

---

## Cross-references

- Historical issues / fixes / phases: [`docs/CHANGELOG.md`](../CHANGELOG.md) and [`docs/incidents/`](../incidents/)
- Security threat model and mitigations: [`docs/security/hardening-overview.md`](../security/hardening-overview.md)
- Architecture layers (used to frame discussions): [`.atlas/docs/architecture-layers.md`](../../.atlas/docs/architecture-layers.md)
- Tab behavior reference: [`docs/howto/users/tabs.md`](../howto/users/tabs.md)
- Search reference: [`docs/howto/users/search.md`](../howto/users/search.md), [`docs/architecture/chat-ui/search.md`](../architecture/chat-ui/search.md)
- Slack OAuth architecture: [`docs/architecture/auth/slack-oauth.md`](../architecture/auth/slack-oauth.md)
