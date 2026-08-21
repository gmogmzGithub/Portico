# test-plan tools

Records test execution status for [`docs/testing/`](../../docs/testing/) into a JSON sidecar and re-renders the markdown tree from it. Zero external dependencies — pure Node.js (>=18) plus a thin Bash wrapper.

```
docs/testing/status.json   <-- single source of truth (do not hand-edit during a release pass)
docs/testing/plan/**/*.md  <-- generated regions inside HTML-comment markers
docs/testing/README.md     <-- generated dashboard inside HTML-comment markers
docs/testing/runs/         <-- gitignored fail logs
```

## Quick start

### Auto-recording when you run a single test

Replace your usual `node --test ...` (or `bash tests/foo.sh`, or `pytest ...`) with the wrapper:

```bash
./tools/test-plan/run-and-record.sh node --test electron-app/src/services/shell-open.test.js
```

The wrapper:

1. Inspects the args, finds tokens that look like test paths.
2. Asks the parser which scenario IDs cite those paths in their `Coverage:` line.
3. Runs your command verbatim, streaming output to your terminal.
4. On exit, marks every matched scenario `Pass` (exit 0) or `Fail` (exit != 0).
5. Re-renders the markdown tree.

If you forget the wrapper and run the test directly, the docs simply do not update — there's no surprise mutation.

### Auto-recording all `Auto`-coverage scenarios

```bash
node tools/test-plan/run-auto.mjs                   # every Auto scenario
node tools/test-plan/run-auto.mjs --filter '^L-'     # only L-* (security)
node tools/test-plan/run-auto.mjs --filter '^B-'     # only B-* (shell)
node tools/test-plan/run-auto.mjs --dry-run         # list planned commands; do nothing
node tools/test-plan/run-auto.mjs --stop-on-fail    # halt on first failing test
```

A test file cited by multiple scenarios is run once; all citing scenarios are recorded from that single execution (e.g. `konami-unlock.test.js` covers both N-01 and N-04).

### Recording a manual scenario

```bash
node tools/test-plan/record.mjs --id B-17 --status Pass --notes "manual on macOS 25.4"
node tools/test-plan/record.mjs --id H-13 --status Fail --notes "OAuth callback 500; bug PORTICO-1234"
node tools/test-plan/record.mjs --id O-04 --status Skipped --notes "no time this release"
```

Allowed statuses: `NotRun`, `Pass`, `Fail`, `Skipped`, `Blocked`, `NotApplicable`.

### Re-rendering only

If you hand-edit `status.json` (e.g. importing per-release results) or pull someone else's status update:

```bash
node tools/test-plan/render.mjs              # apply
node tools/test-plan/render.mjs --check      # CI guardrail; exits 1 if dirty
node tools/test-plan/render.mjs --verbose    # list every file that changed
```

## What's actually managed

The renderer only touches text inside HTML-comment markers; everything else (scenario titles, preconditions, steps, expected outcomes) is owned by humans.

### Per-scenario `Last execution` block

```markdown
<!-- @portico:test-status:begin id=L-04 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:10:54.185Z
- Build: feature-x @ a1b2c3d
- Executor: bshor
- Notes: node --test electron-app/src/services/shell-open.test.js -- 1s
<!-- @portico:test-status:end -->
```

### Section README `## Status snapshot`

```markdown
<!-- @portico:status-snapshot:begin -->
| Total | NotRun | Pass | Fail | Skipped | Blocked | N/A |
|---:|---:|---:|---:|---:|---:|---:|
|    34 |     33 |    1 |    0 |       0 |       0 |   0 |
<!-- @portico:status-snapshot:end -->
```

### Section README `## At-a-glance`

The renderer updates only the `Status` and `Last run` columns of every row in-place, preserving column widths. Other columns (Threat, Coverage, File, etc.) are owned by the scenario authors.

### Top-level `docs/testing/README.md` dashboard

```markdown
<!-- @portico:status-dashboard:begin -->
| Section | Total | NotRun | Pass | Fail | Skipped | Blocked | N/A |
| ...
<!-- @portico:status-dashboard:end -->
```

## Build / executor / notes auto-detection

The wrapper and `record.mjs` populate these fields automatically:

| Field    | Source                                                                                                    |
|----------|-----------------------------------------------------------------------------------------------------------|
| Date     | `new Date().toISOString()`                                                                                |
| Build    | `<branch> @ <short-sha>` from `git`. Adds `-dirty` if the working tree is dirty. Override with `$portico_RELEASE_TAG` (formatted as `1.42.0 (beta)` if `$UPDATE_CHANNEL` is set). |
| Executor | `$portico_EXECUTOR` if set, else `agent` if `$portico_AGENT=1`, else `ci` if `$CI=true`, else `$USER`.            |
| Notes    | `<command> -- <duration>s` on Pass; `<command> exited <code> after <duration>s` on Fail. Override with `$portico_RECORD_NOTES`. |

## Adding a new scenario

1. Author the scenario in the appropriate file under [`docs/testing/plan/`](../../docs/testing/plan/) using the canonical [scenario template](../../docs/testing/templates/scenario.md). The template already includes the `<!-- @portico:test-status:begin id=<ID> -->` marker — replace `<ID>` with the new scenario ID.
2. Add a row to the section's `## At-a-glance` table with `Status: NotRun`, `Last run: -`.
3. Run `node tools/test-plan/render.mjs --check` — should report clean. If not, the renderer will tell you what differs.

If you forget the markers, the renderer detects an unmarked `**Last execution:**` block and wraps it on next run, so it's recoverable.

## Edge cases

- **Test path moves**: if a test file is renamed, update the `Coverage:` link in the scenario. The matcher does substring matching but won't auto-discover renames.
- **One test file → many scenarios**: handled. The matcher returns every scenario whose `Coverage:` link points at the path; the wrapper records all of them as Pass/Fail together based on the file-level exit code. Per-test-case granularity is a follow-up.
- **`status.json` conflicts in git**: keys are sorted alphabetically by ID on every save, so merge conflicts are usually resolvable line-by-line.
- **Concurrent runs**: not currently locked. Don't run `run-auto.mjs` and `run-and-record.sh` simultaneously.
- **Hidden Rust test paths**: the matcher recognizes `*.test.js`, `*.test.mjs`, `*.test.cjs`, `*.unit.test.js`, `tests/test_*.py`, and `*.test.sh` / `test-*.sh` / `test_*.sh`. Other extensions are ignored — they show up as `unsupported test extension` in `run-auto.mjs --dry-run`.

## Out of scope (future work)

- Per-test-case mapping via TAP parser or `// @scenario: ID` comments inside test code.
- Manual-scenario auto-detection from app logs (mining `~/Library/Logs/portico/` for known events).
- Promoting `Manual` scenarios to `Auto` by adding Playwright fixtures.
- Pre-commit / CI hook wiring for `render --check`.
- Per-release frozen snapshots under [`docs/testing/releases/<version>/`](../../docs/testing/releases/) (the directory is scaffolded; the renderer accepts a `--target` flag is not yet implemented).
