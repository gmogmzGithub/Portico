# N — Konami / hidden features

Five scenarios covering the secret 10-rapid-clicks gesture on the theme-toggle button that unlocks GPT-5.6 Sol Pro and surfaces the unlock modal, plus persistence and dismissal behavior.

- Up: [`docs/testing/README.md`](../../README.md).

---

## Status snapshot

<!-- @portico:status-snapshot:begin -->
| Total | NotRun | Pass | Fail | Skipped | Blocked | N/A |
|---:|---:|---:|---:|---:|---:|---:|
|     5 |      1 |    4 |    0 |       0 |       0 |   0 |
<!-- @portico:status-snapshot:end -->

## At-a-glance

| ID   | Scenario                                                                                  | Type   | Coverage | Status | Last run |
|------|-------------------------------------------------------------------------------------------|--------|----------|--------|----------|
| N-01 | 10 rapid clicks on the theme toggle button (≤400ms gap) unlock GPT-5.6 Sol Pro                | Shell  | Auto     | Pass   | 2026-04-28 |
| N-02 | Unlock state persists across restarts                                                     | Shell  | Auto     | Pass   | 2026-04-28 |
| N-03 | Konami unlock logs to main process via the secure logger bridge (no direct console)       | Security | Auto   | Pass   | 2026-04-28 |
| N-04 | Slow / non-rapid clicks **do not** unlock                                                 | Shell  | Auto     | Pass   | 2026-04-28 |
| N-05 | Konami modal dismiss / Esc / overlay click all close the modal cleanly                    | Shell  | Partial  | NotRun | -        |

---

## Scenarios

### N-01 — 10 rapid clicks on the theme toggle button (≤400ms gap) unlock GPT-5.6 Sol Pro and surface the unlock modal

**Coverage:** Auto — [`konami-unlock.test.js`](../../../../electron-app/src/services/konami-unlock.test.js)
**Type:** Shell
**Preconditions:** Fresh app state where GPT-5.6 Sol Pro is locked.

**Steps:**
1. Run `node --test electron-app/src/services/konami-unlock.test.js`.
2. Manually: open the main shell. Click the theme-toggle button 10 times in rapid succession (each click ≤400ms apart from the previous one).
3. Confirm an unlock modal appears announcing GPT-5.6 Sol Pro is unlocked.
4. Open the model picker; confirm GPT-5.6 Sol Pro is now in the list.

**Expected:**
- Modal renders after the 10th rapid click.
- GPT-5.6 Sol Pro becomes selectable.

**Fail indicators:**
- No modal after 10 clicks.
- GPT-5.6 Sol Pro absent from picker.

<!-- @portico:test-status:begin id=N-01 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:09.880Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/konami-unlock.test.js -- 0s
<!-- @portico:test-status:end -->

---

### N-02 — Unlock state persists across restarts

**Coverage:** Auto — [`konami-startup-reconcile.unit.test.js`](../../../../electron-app/src/services/konami-startup-reconcile.unit.test.js)
**Type:** Shell
**Preconditions:** N-01 completed; unlock state stored.

**Steps:**
1. Run `node --test electron-app/src/services/konami-startup-reconcile.unit.test.js`.
2. Manually: quit the app completely (`Cmd+Q`); relaunch.
3. Open the model picker; confirm GPT-5.6 Sol Pro is still listed.

**Expected:**
- Unlock persists across cold start.

**Fail indicators:**
- GPT-5.6 Sol Pro re-locked on relaunch.
- User must redo the 10-click gesture.

<!-- @portico:test-status:begin id=N-02 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:10.588Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/konami-startup-reconcile.unit.test.js -- 0s
<!-- @portico:test-status:end -->

---

### N-03 — Konami unlock logs to main process via the secure logger bridge (no direct console)

**Coverage:** Auto — [`konami-logger.test.js`](../../../../electron-app/src/services/konami-logger.test.js)
**Type:** Security
**Preconditions:** None — investigation only.

**Steps (regression-investigation only):**
1. Run `node --test electron-app/src/services/konami-logger.test.js`.
2. Confirm assertions check:
   - Konami unlock event is logged via `window.electronAPI.log` (or equivalent secure bridge).
   - No direct `console.log` from the renderer for this event.

**Expected:**
- Tests pass.

**Fail indicators:**
- Direct `console.log` in source for the unlock path.

<!-- @portico:test-status:begin id=N-03 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:11.130Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/konami-logger.test.js -- 1s
<!-- @portico:test-status:end -->

---

### N-04 — Slow / non-rapid clicks do not unlock

**Coverage:** Auto — [`konami-unlock.test.js`](../../../../electron-app/src/services/konami-unlock.test.js)
**Type:** Shell
**Preconditions:** Fresh state where GPT-5.6 Sol Pro is locked.

**Steps:**
1. Run `node --test electron-app/src/services/konami-unlock.test.js`.
2. Manually: click the theme-toggle 10 times with >400ms gaps between clicks (e.g. once per second).
3. Confirm no unlock modal appears.

**Expected:**
- No unlock; GPT-5.6 Sol Pro remains locked.

**Fail indicators:**
- Slow clicks unlock the model.

<!-- @portico:test-status:begin id=N-04 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:09.963Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/konami-unlock.test.js -- 0s
<!-- @portico:test-status:end -->

---

### N-05 — Konami modal dismiss / Esc / overlay click all close the modal cleanly

**Coverage:** Partial — manual
**Type:** Shell
**Preconditions:** Konami unlock modal currently visible (after N-01).

**Steps:**
1. Trigger the modal (10 rapid clicks per N-01).
2. Press the modal's "Close" button — confirm modal disappears, app remains responsive.
3. Re-trigger the modal (since the unlock is now persistent, you may need to fake a fresh trigger via dev tools, or rely on the second-unlock detection if state persists).
4. Press `Esc` while the modal is focused — confirm modal closes.
5. Re-trigger; click outside the modal (on the overlay backdrop) — confirm modal closes.

**Expected:**
- All three dismiss methods close the modal without leaving overlay state stuck or focus orphaned.

**Fail indicators:**
- Modal doesn't close on Esc.
- Overlay click doesn't dismiss.
- App becomes input-blocked after dismiss.

<!-- @portico:test-status:begin id=N-05 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->
