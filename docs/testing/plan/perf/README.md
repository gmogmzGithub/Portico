# O — Performance / regression smoke

Five performance-oriented sanity checks on each release candidate: cold start, bulk MCP toggling, the no-new-timers workspace rule, memory ceilings, and OWUI tab suspension behavior.

- Up: [`docs/testing/README.md`](../../README.md).
- Reference: [CLAUDE.md](../../../../CLAUDE.md) for the no-new-timers rule.

---

## Status snapshot

<!-- @portico:status-snapshot:begin -->
| Total | NotRun | Pass | Fail | Skipped | Blocked | N/A |
|---:|---:|---:|---:|---:|---:|---:|
|     5 |      4 |    1 |    0 |       0 |       0 |   0 |
<!-- @portico:status-snapshot:end -->

## At-a-glance

| ID   | Scenario                                                                                  | Type | Coverage | Status | Last run |
|------|-------------------------------------------------------------------------------------------|------|----------|--------|----------|
| O-01 | Cold start to interactive main shell ≤ 5s on a warm machine                                | Perf | Manual   | NotRun | -        |
| O-02 | Toggling 5 servers off in bulk completes within 8s and clears startup failures             | Perf | Auto     | Pass   | 2026-04-28 |
| O-03 | No new timers/intervals/polling loops added                                                | Perf | Manual   | NotRun | -        |
| O-04 | Memory of main shell stays below 800 MB after 1h chat session                              | Perf | Manual   | NotRun | -        |
| O-05 | OWUI tab suspension reduces memory after >12 tabs                                          | Perf | Manual   | NotRun | -        |

---

## Scenarios

### O-01 — Cold start to interactive main shell ≤ 5s on a warm machine

**Coverage:** Manual
**Type:** Perf
**Preconditions:** Machine that has previously launched this build (filesystem caches warm). App fully quit (`Cmd+Q`).

**Steps:**
1. Quit the app: `Cmd+Q`. Wait 5 seconds.
2. Start a stopwatch. Launch the app from `Applications/`.
3. Stop the stopwatch when the main shell is interactive (typing in the model picker or the composer responds).

**Expected:**
- Total elapsed time ≤ 5 seconds.

**Fail indicators:**
- > 5 seconds to interactivity on warm machine.
- Loading overlay still showing.

<!-- @portico:test-status:begin id=O-01 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### O-02 — Toggling 5 servers off in bulk completes within 8s and clears startup failures

**Coverage:** Auto — [`mcp-bulk-toggle-ipc-regressions.test.js`](../../../../electron-app/src/services/mcp-bulk-toggle-ipc-regressions.test.js)
**Type:** Perf
**Preconditions:** None — investigation only.

**Steps:**
1. Run `node --test electron-app/src/services/mcp-bulk-toggle-ipc-regressions.test.js`.
2. Manually: open Settings → MCP; bulk-disable five servers in one action.
3. Time the operation (stopwatch).

**Expected:**
- Tests pass.
- Bulk operation completes within 8 seconds; no leftover startup-failure badges referencing the disabled servers.

**Fail indicators:**
- Operation takes longer than 8 seconds.
- Startup-failure badge persists after disable.

<!-- @portico:test-status:begin id=O-02 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:22.385Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/mcp-bulk-toggle-ipc-regressions.test.js -- 0s
<!-- @portico:test-status:end -->

---

### O-03 — No new timers/intervals/polling loops added (workspace rule from `CLAUDE.md`)

**Coverage:** Manual — code review / linter
**Type:** Perf
**Preconditions:** Working tree at the release candidate.

**Steps:**
1. From repo root, run: `rg --line-number "setInterval|setTimeout\\s*\\(" --glob '!node_modules' --glob '!**/*.test.js' --glob '!docs' --glob '!.cursor' electron-app/src`.
2. Cross-check each hit against existing entries (i.e. introduced before the candidate diff). The CLAUDE workspace rule prohibits introducing new ones without explicit justification.
3. Document any new entries with the responsible PR / justification in the Notes line.

**Expected:**
- No new `setInterval` calls.
- No new long-running `setTimeout` polling chains.

**Fail indicators:**
- New unsanctioned polling loop introduced this release.

<!-- @portico:test-status:begin id=O-03 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### O-04 — Memory of main shell stays below 800 MB after 1h chat session

**Coverage:** Manual
**Type:** Perf
**Preconditions:** Fresh launch; no prior chat history loaded.

**Steps:**
1. Launch the app; verify main shell is interactive.
2. Conduct a one-hour realistic chat session: ~30 messages, mix of text-only and a couple of file-attachment + tool-call exchanges.
3. After ~60 minutes elapsed, in macOS Activity Monitor, find the helper process labeled "Portico Helper (Renderer)" attached to the main shell window; record the Memory column.

**Expected:**
- Resident memory of the main-shell renderer ≤ 800 MB.

**Fail indicators:**
- Memory > 800 MB.
- Visible UI lag, swap pressure on host.

<!-- @portico:test-status:begin id=O-04 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### O-05 — OWUI tab suspension reduces memory after >12 tabs

**Coverage:** Manual
**Type:** Perf
**Preconditions:** Fresh launch.

**Steps:**
1. Open 13 OWUI chat tabs (use `Cmd+T` repeatedly or open conversations from the list).
2. In Activity Monitor, record the cumulative memory of all "Portico Helper (Renderer)" processes.
3. Switch to one tab and stop interacting with the others for ≥ 90 seconds (LRU suspension threshold).
4. Re-record the cumulative memory.

**Expected:**
- The cumulative memory drops noticeably (suspended tabs release at least their working set).
- Suspended tabs reflate quickly when re-selected (≤ 1 second perceived).

**Fail indicators:**
- No drop after suspension threshold.
- Reflate stalls > 3 seconds.

<!-- @portico:test-status:begin id=O-05 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->
