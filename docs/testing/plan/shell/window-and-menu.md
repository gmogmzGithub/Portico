# B.1 — Window & menu structure

Five scenarios validating that the macOS menu bar exposes File / Edit / View / Window / Help with the expected native roles, and that the Window menu has the explicit Close Tab + Close Window + Minimize + Zoom block.

- Up: [`docs/testing/plan/shell/README.md`](README.md).
- Source: [`bootstrap.js`](../../../../electron-app/src/services/bootstrap.js).

---

## Scenarios

### B-01 — App menu has File / Edit / View / Window / Help with native roles

**Coverage:** Partial — [`main-window-close-regressions.test.js`](../../../../electron-app/src/services/main-window-close-regressions.test.js)
**Type:** Shell
**Preconditions:**
- App launched (packaged build preferred).

**Steps:**
1. Look at the macOS menu bar at the top of the screen (the focused-app menu, *not* a window-level menu).
2. Confirm the order of top-level menus: `Portico`, `File`, `Edit`, `View`, `Window`, `Help`.
3. Open `Portico` and confirm `Quit Portico` accelerator is `Cmd+Q`.
4. Open `Edit` and confirm `Cut`, `Copy`, `Paste`, `Select All`, `Undo`, `Redo` are present with their native accelerators.
5. Open `Window` and confirm `Minimize` (`Cmd+M`) and `Zoom` are present.

**Expected:**
- Every item present.
- No duplicate `Quit`/`Close`.
- The accelerators above are bound to the correct roles.

**Fail indicators:**
- A menu is missing.
- An accelerator is bound to a different role.
- `Cmd+W` shown in the App menu (it should live under `Window` / `File`).

<!-- @portico:test-status:begin id=B-01 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:07.537Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/main-window-close-regressions.test.js -- 0s
<!-- @portico:test-status:end -->

---

### B-02 — Window menu lists the full Tab+Window block

**Coverage:** Auto — [`main-window-close-regressions.test.js`](../../../../electron-app/src/services/main-window-close-regressions.test.js)
**Type:** Shell
**Preconditions:**
- App launched.

**Steps (regression-investigation only):**
1. Click `Window` menu.
2. Verify items in this order (skipping any auto-generated detached/artifact entries that follow): `New Tab` (`Cmd+T`), `New Chat Window` (`Cmd+Shift+N`), `Close Tab` (`Cmd+W`), `Close Window` (`Cmd+Shift+W`), separator, `Minimize`, `Zoom`, `Main Window`.

**Expected:**
- The explicit `Close Window` entry sits *before* the separator/minimize/zoom block (regression test 304).

**Fail indicators:**
- `Close Window` missing.
- Accelerator collides with `Close Tab`.
- `Close Window` uses a native `role: 'close'` (would break B-15 by closing only the focused window via Electron's `close` rather than the app-level dispatcher).

<!-- @portico:test-status:begin id=B-02 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:07.603Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/main-window-close-regressions.test.js -- 0s
<!-- @portico:test-status:end -->

---

### B-03 — About dialog renders correct version, build number, and channel label

**Coverage:** Manual
**Type:** Shell
**Preconditions:**
- App launched. Ideally a packaged build with a known version.

**Steps:**
1. Open `Portico → About Portico`.
2. Cross-check the version against [`electron-app/package.json`](../../../../electron-app/package.json) `version` field.
3. Cross-check the channel label against `Help → Channel`.

**Expected:**
- Dialog displays correct version (`x.y.z`), build number, and channel label (Stable/Beta/Dev).
- Version matches `package.json` for the running build.

**Fail indicators:**
- Version reads `0.0.0` or `unknown`.
- Channel label says `Stable` on a Beta/Dev build.

<!-- @portico:test-status:begin id=B-03 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### B-04 — Reinstall / Install Specific Build menu items

**Coverage:** Partial — [`update-preparation.test.js`](../../../../electron-app/src/services/update-preparation.test.js)
**Type:** Shell / Update
**Preconditions:**
- You can tolerate an app reinstall (use a non-primary tester profile if uncertain).
- Packaged build.

**Steps:**
1. `Help → Reinstall Latest Build…` — confirm prompt → app downloads and reinstalls.
2. Once relaunched, open `Help → Install Specific Build…`, paste a known-good prior build URL or version, confirm.

**Expected:**
- Both flows complete without manual terminal intervention.
- App relaunches in the new build.
- Tabs/state are preserved.

**Fail indicators:**
- Download fails silently.
- Reinstall hangs at "Preparing".
- Relaunched app shows the previous version (silent failure).

<!-- @portico:test-status:begin id=B-04 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:59.428Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/update-preparation.test.js -- 1s
<!-- @portico:test-status:end -->

---

### B-05 — Bundled icons in About / dock / task switcher

**Coverage:** Manual
**Type:** Shell
**Preconditions:**
- App launched (packaged build).

**Steps:**
1. Look at the dock icon for the running app.
2. Open the macOS task switcher (`Cmd+Tab`); inspect the PORTICO icon there.
3. Open `Portico → About Portico` and inspect the icon shown in the dialog.

**Expected:**
- All three locations show the PORTICO bundle icon (not the Electron default).

**Fail indicators:**
- Generic Electron mask icon visible anywhere.

<!-- @portico:test-status:begin id=B-05 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->
