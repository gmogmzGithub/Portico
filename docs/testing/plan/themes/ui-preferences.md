# C.2 — UI preferences

Five scenarios for the rest of the UI prefs surface: token-based light theme styling, hidden-theme guard, scale persistence, sidebar state, and one-shot font migration.

- Up: [`docs/testing/plan/themes/README.md`](README.md).

---

## Scenarios

### C-05 — Light theme uses tokens (no hex literals)

**Coverage:** Auto — [`main-window-header-layout.test.js`](../../../../electron-app/src/services/main-window-header-layout.test.js)
**Type:** Theme
**Preconditions:** App launched in light theme.

**Steps (regression-investigation only):**
1. From `electron-app/`, run `node --test src/services/main-window-header-layout.test.js`.
2. Manually inspect the header / tab strip in light mode for any visibly-wrong-color element.

**Expected:**
- All header / tab-strip surfaces use the `--portico-accent-fill` and `--portico-accent-text` tokens.
- Test passes.

**Fail indicators:**
- A hex literal sneaks into the header CSS — visible as a contrast mismatch in light mode.

<!-- @portico:test-status:begin id=C-05 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:43.425Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/main-window-header-layout.test.js -- 0s
<!-- @portico:test-status:end -->

---

### C-06 — OWUI hidden `'her'` theme is NOT triggerable from PORTICO shell UI

**Coverage:** Manual
**Type:** Theme / Security
**Preconditions:** App launched.

**Steps:**
1. In the main shell header, click the sun/moon button rapidly (slower than the Konami threshold of ≤400ms — see § N).
2. In the OWUI sidebar (Settings → Personalization), confirm the `'her'` theme option is not surfaced from any PORTICO shell control.

**Expected:**
- Theme cycle stays within `dark` and `light`.
- The hidden OWUI `'her'` theme is unreachable from PORTICO shell UI.

**Fail indicators:**
- Header toggle ever lands on the `'her'` theme.

<!-- @portico:test-status:begin id=C-06 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### C-07 — UI scale (zoom) persists across restart and per-view

**Coverage:** Auto — [`main-window-close-regressions.test.js`](../../../../electron-app/src/services/main-window-close-regressions.test.js)
**Type:** Theme
**Preconditions:** Main shell focused.

**Steps:**
1. Press `Cmd+=` three times in the main shell.
2. Open a detached chat (B-11) and verify it picks up the scale.
3. Quit (`Cmd+Q`) and relaunch.

**Expected:**
- Scale applies to main shell, detached windows, and OWUI views.
- Scale persists across restart.

**Fail indicators:**
- Detached window stays at default scale.
- Scale resets after relaunch.

<!-- @portico:test-status:begin id=C-07 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:07.667Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/main-window-close-regressions.test.js -- 0s
<!-- @portico:test-status:end -->

---

### C-08 — OWUI sidebar collapse/expand state persists

**Coverage:** Auto — [`owui-sidebar-preferences.unit.test.js`](../../../../electron-app/src/services/owui-sidebar-preferences.unit.test.js)
**Type:** Theme
**Preconditions:** OWUI view visible with sidebar open.

**Steps:**
1. Collapse the OWUI sidebar.
2. Quit the app.
3. Relaunch.

**Expected:**
- Sidebar is still collapsed on relaunch.

**Fail indicators:**
- Sidebar reopens on relaunch.

<!-- @portico:test-status:begin id=C-08 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:57.289Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/owui-sidebar-preferences.unit.test.js -- 0s
<!-- @portico:test-status:end -->

---

### C-09 — Font migration runs once on first launch and is idempotent

**Coverage:** Auto — [`font-migration.unit.test.js`](../../../../electron-app/src/services/font-migration.unit.test.js)
**Type:** Theme
**Preconditions:** Fresh install or first run after the font-migration fix.

**Steps (regression-investigation only):**
1. Launch the app.
2. Re-launch the app twice.
3. Check `~/Library/Application Support/portico/runtime-state.json` for the migration flag (set true after first run).

**Expected:**
- Migration runs once, sets the flag.
- Subsequent launches skip migration.

**Fail indicators:**
- Migration runs on every launch.
- Flag never set.

<!-- @portico:test-status:begin id=C-09 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:57.794Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/font-migration.unit.test.js -- 0s
<!-- @portico:test-status:end -->
