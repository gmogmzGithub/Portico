# Scenario template

Copy this block when adding a new scenario to any file under `docs/testing/plan/`. Keep field names and headings exact so the section README at-a-glance tables stay consistent.

---

### `<ID>` — `<one-line title>`

**Coverage:** `Auto` | `Partial` | `Manual` — [`<test path>`](<relative-path-from-this-file>)
**Type:** Shell | Chat | MCP | Auth | Security | Theme | Search | Update | Performance
**Preconditions:**
- (one or more bullet points describing setup state required before the steps)

**Steps:**
1. (action a tester can perform with no prior code knowledge)
2. (next action)
3. (...)

**Expected:**
- (visible outcome at each meaningful checkpoint)

**Fail indicators:**
- (specific symptoms that prove the scenario is broken — handy for bug filing)

**Cleanup:** *(optional — anything to undo before the next scenario)*

<!-- @portico:test-status:begin id=<ID> -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

## Field reference

### Coverage

- `Auto` — fully covered by automated test(s); manual run is regression-investigation only.
- `Partial` — has automated coverage of one layer (often a regex on source); user-visible behavior still needs a hand check.
- `Manual` — no automated coverage; must be executed by hand on the release build.

### Last execution status vocabulary

| Status          | Meaning                                                                                                |
|-----------------|--------------------------------------------------------------------------------------------------------|
| `NotRun`        | Default. Has not been executed against the current build.                                              |
| `Pass`          | Executed; expected outcome observed.                                                                   |
| `Fail`          | Executed; outcome did not match. Notes line MUST include a bug link or a 1-line cause.                 |
| `Skipped`       | Conscious skip for this release (release does not touch the surface).                                  |
| `Blocked`       | A precondition or earlier scenario failed and prevents execution.                                      |
| `NotApplicable` | Out of scope for this release.                                                                         |

### Notes-line conventions

- For `Auto` coverage executed by command, record the exact command and pass count. Example: `node --test electron-app/src/services/main-window-close-regressions.test.js — 22/22 passed`.
- For manual verification, record the build/commit and any caveats. Example: `pre-beta-tmp @ a1b2c3d; reproduced on macOS 25.4`.

### Build field

- For dev builds: `<branch> @ <short-sha>` (e.g. `pre-beta-tmp @ 9f3e2c1`).
- For packaged builds: `<version> (<channel>)` (e.g. `1.42.0 (beta)`).

### Executor field

- `agent` — automated run by the AI assistant.
- `<your name>` — manual run by a tester.
- `ci` — run in continuous integration.
