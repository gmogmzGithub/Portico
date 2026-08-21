# B.2 — Keyboard shortcuts

Fifteen scenarios covering the browser-style shortcut model adopted in PORTICO-67/68. The model:

- `Cmd+W` closes the active chat tab in main shell (or the detached window if the focused window is detached).
- `Cmd+Shift+W` closes the entire main window (or a detached/dialog window).
- `Cmd+Q` quits the app.

Utility/dialog windows are NOT intercepted by `Cmd+W` (regression #305).

- Up: [`docs/testing/plan/shell/README.md`](README.md).
- Source: [`electron-app/src/services/main.js`](../../../../electron-app/src/services/main.js).

---

## Scenarios

### B-10 — `Cmd+N` / `Cmd+T`: new chat tab in main shell

**Coverage:** Partial — menu-template assertions in [`main-window-close-regressions.test.js`](../../../../electron-app/src/services/main-window-close-regressions.test.js)
**Type:** Shell
**Preconditions:** Main shell focused.

**Steps:**
1. Press `Cmd+T`.
2. Press `Cmd+N`.

**Expected:**
- Each press creates a new chat tab and focuses it.
- The new tab title is `New Chat`.
- Both shortcuts behave identically.

**Fail indicators:**
- One of the two creates a window instead of a tab.
- Nothing happens.
- Focus stays on the previous tab.

<!-- @portico:test-status:begin id=B-10 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:06.843Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/main-window-close-regressions.test.js -- 0s
<!-- @portico:test-status:end -->

---

### B-11 — `Cmd+Shift+N`: new detached chat window

**Coverage:** Partial — menu-template assertions
**Type:** Shell
**Preconditions:** Main shell focused.

**Steps:**
1. Press `Cmd+Shift+N`.

**Expected:**
- A separate chat window opens (own dock entry; own `Cmd+\`` cycle target).
- Its tab strip shows just one chat tab.

**Fail indicators:**
- A new tab opens in the main shell instead.

<!-- @portico:test-status:begin id=B-11 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### B-12 — `Cmd+W` on main shell with a closable chat tab

**Coverage:** Auto — [`main-window-close-regressions.test.js`](../../../../electron-app/src/services/main-window-close-regressions.test.js)
**Type:** Shell
**Preconditions:**
- Main shell focused.
- ≥1 user-opened chat tab in the strip.

**Steps:**
1. Focus a chat tab.
2. Press `Cmd+W`.

**Expected:**
- The active chat tab closes.
- Focus moves to the adjacent tab.
- The system `chat` and `control` tabs are NOT closeable.

**Fail indicators:**
- The entire window closes (regression of B-12 vs. B-15).
- System tabs vanish.
- App quits.

<!-- @portico:test-status:begin id=B-12 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:06.915Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/main-window-close-regressions.test.js -- 0s
<!-- @portico:test-status:end -->

---

### B-13 — `Cmd+W` on a detached chat window

**Coverage:** Auto — [`main-window-close-regressions.test.js`](../../../../electron-app/src/services/main-window-close-regressions.test.js)
**Type:** Shell
**Preconditions:**
- A detached chat window exists (use B-11 to create one).

**Steps:**
1. Click the detached window to focus it.
2. Press `Cmd+W`.

**Expected:**
- That window closes.
- Main shell unaffected.

**Fail indicators:**
- Main shell loses a tab.
- App quits.
- Window remains open.

<!-- @portico:test-status:begin id=B-13 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:06.982Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/main-window-close-regressions.test.js -- 0s
<!-- @portico:test-status:end -->

---

### B-14 — `Cmd+W` on a utility/dialog window does NOT intercept

**Coverage:** Auto — [`main-window-close-regressions.test.js`](../../../../electron-app/src/services/main-window-close-regressions.test.js) (regression #305)
**Type:** Shell
**Preconditions:**
- Open any non-chat window — e.g. `Help → About`, OAuth wizard, or a settings dialog.

**Steps:**
1. With that window focused, press `Cmd+W`.

**Expected:**
- The dialog closes via Electron's native close handling.
- This is the fix from regression #305 — `event.preventDefault()` must NOT fire for non-chat windows.

**Fail indicators:**
- The dialog stays open and `Cmd+W` is silently swallowed.
- Main shell tab closes instead.

<!-- @portico:test-status:begin id=B-14 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:07.103Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/main-window-close-regressions.test.js -- 0s
<!-- @portico:test-status:end -->

---

### B-15 — `Cmd+Shift+W`: close the entire main shell window

**Coverage:** Auto — [`main-window-close-regressions.test.js`](../../../../electron-app/src/services/main-window-close-regressions.test.js)
**Type:** Shell
**Preconditions:**
- Main shell with ≥2 chat tabs.
- Optionally another window (e.g. detached chat) open.

**Steps:**
1. Focus the main shell.
2. Press `Cmd+Shift+W`.

**Expected:**
- Main window closes immediately along with all its tabs.
- App stays running (visible via `Cmd+Tab`).
- Detached windows continue to work.
- Pressing `Cmd+Q` afterwards quits the app entirely.

**Fail indicators:**
- App quits entirely (regression to old `role: 'close'` behavior).
- Window stays open.
- Tabs leak.

<!-- @portico:test-status:begin id=B-15 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:07.267Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/main-window-close-regressions.test.js -- 0s
<!-- @portico:test-status:end -->

---

### B-16 — `Cmd+Shift+W` on a detached or dialog window

**Coverage:** Partial — same test file as B-15
**Type:** Shell
**Preconditions:**
- A detached chat window OR a dialog window open.

**Steps:**
1. Focus a detached chat window. Press `Cmd+Shift+W`.
2. Repeat with a dialog (e.g. About).

**Expected:**
- That window closes.
- Equivalent to `Cmd+W` for these surfaces.

**Fail indicators:**
- Shortcut does nothing.

<!-- @portico:test-status:begin id=B-16 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### B-17 — `Cmd+Q`: quit entire app

**Coverage:** Manual
**Type:** Shell
**Preconditions:**
- Multiple windows + tabs open.

**Steps:**
1. Press `Cmd+Q` from any window.

**Expected:**
- App exits.
- All windows/tabs close.
- No orphan dock entry.
- Relaunch resumes the workspace (per P0-07).

**Fail indicators:**
- A window stays open.
- macOS prompts "App is not responding".
- Quit takes >5s.

<!-- @portico:test-status:begin id=B-17 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### B-18 — `Cmd+1` … `Cmd+9` switch directly to tab N

**Coverage:** Manual
**Type:** Shell
**Preconditions:**
- Main shell with ≥3 chat tabs.

**Steps:**
1. Press `Cmd+1`, `Cmd+2`, `Cmd+3` in turn.

**Expected:**
- Focus snaps to tab N (1-indexed; system tabs counted first).
- `Cmd+9` jumps to the *last* tab regardless of count (browser convention).

**Fail indicators:**
- Shortcut activates a menu item instead.
- Nothing happens.

<!-- @portico:test-status:begin id=B-18 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### B-19 — `Cmd+Opt+←` / `Cmd+Opt+→` previous / next tab

**Coverage:** Manual
**Type:** Shell
**Preconditions:** ≥2 tabs.

**Steps:**
1. Press `Cmd+Opt+→` to advance.
2. Press `Cmd+Opt+←` to go back.

**Expected:**
- Wraps around at the ends.
- Skips system tabs only if focus is currently on a chat tab.

**Fail indicators:**
- Shortcut moves focus elsewhere.
- Hangs.

<!-- @portico:test-status:begin id=B-19 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### B-20 — `Cmd+F` opens local find; `Shift+Cmd+F` opens global search

**Coverage:** Auto — [`tab-search-regressions.test.js`](../../../../electron-app/src/services/tab-search-regressions.test.js)
**Type:** Search
**Preconditions:** Focus on an OWUI view.

**Steps:**
1. Press `Cmd+F`.
2. Press `Esc` to dismiss.
3. Press `Shift+Cmd+F`.

**Expected:**
- `Cmd+F` opens the local find overlay for the current chat.
- `Shift+Cmd+F` opens the global search overlay.
- Exactly one overlay at a time (no double-render).
- `Esc` dismisses; focus returns to the OWUI view (validates B-50).

**Fail indicators:**
- Two overlays stack.
- `Esc` does not return focus.

<!-- @portico:test-status:begin id=B-20 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:36.330Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/tab-search-regressions.test.js -- 0s
<!-- @portico:test-status:end -->

---

### B-21 — `Cmd+G` / `Shift+Cmd+G` find-next/prev

**Coverage:** Partial — [`tab-search-regressions.test.js`](../../../../electron-app/src/services/tab-search-regressions.test.js)
**Type:** Search
**Preconditions:** A chat with ≥3 occurrences of a known token (e.g. `the`).

**Steps:**
1. Press `Cmd+F` and type `the`.
2. Press `Cmd+G` repeatedly.
3. Press `Shift+Cmd+G`.

**Expected:**
- Viewport scrolls to next/previous match each time.
- Counter `n / total` updates.

**Fail indicators:**
- Counter stuck at `1`.
- Viewport does not move.

<!-- @portico:test-status:begin id=B-21 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:36.401Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/tab-search-regressions.test.js -- 0s
<!-- @portico:test-status:end -->

---

### B-22 — `Cmd+=` / `Cmd+-` / `Cmd+0` UI scale

**Coverage:** Auto — [`main-window-close-regressions.test.js`](../../../../electron-app/src/services/main-window-close-regressions.test.js)
**Type:** Theme
**Preconditions:** Main shell focused.

**Steps:**
1. Press `Cmd+=` three times.
2. Press `Cmd+-` twice.
3. Press `Cmd+0`.

**Expected:**
- Main shell scales up/down.
- Detached windows and OWUI view scale in lockstep.
- `Cmd+0` resets to default.
- Setting persists across restart.

**Fail indicators:**
- OWUI view doesn't scale (broadcast regression).
- Reset is incomplete.

<!-- @portico:test-status:begin id=B-22 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:07.389Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/main-window-close-regressions.test.js -- 0s
<!-- @portico:test-status:end -->

---

### B-23 — Standard Edit-menu shortcuts in input fields

**Coverage:** Auto — [`setup-copy.unit.test.js`](../../../../electron-app/src/services/setup-copy.unit.test.js)
**Type:** Shell
**Preconditions:** A focused input field anywhere (chat input, setup wizard, OAuth secure input).

**Steps:**
1. In the chat input, type some text.
2. Use `Cmd+A`, `Cmd+C`, `Cmd+X`, `Cmd+V`, `Cmd+Z`, `Cmd+Shift+Z`.
3. Repeat in setup-wizard inputs and the OAuth secure input.

**Expected:**
- Every shortcut behaves natively.
- No prompt about clipboard fallback (validates the runtime path: prefer Electron IPC, fall back to `navigator.clipboard`).

**Fail indicators:**
- Paste pastes stale data.
- Undo skips a step.

<!-- @portico:test-status:begin id=B-23 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:04.945Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/setup-copy.unit.test.js -- 0s
<!-- @portico:test-status:end -->

---

### B-24 — `Cmd+W` is NOT forwarded to renderer for utility windows

**Coverage:** Auto — [`main-window-close-regressions.test.js`](../../../../electron-app/src/services/main-window-close-regressions.test.js) (regression #305 follow-up)
**Type:** Shell
**Preconditions:** None — investigation only if B-14 already passes.

**Steps (regression-investigation only):**
1. Open the OAuth wizard.
2. Open DevTools (`Cmd+Option+I`) on the main shell.
3. With the wizard focused, press `Cmd+W`.
4. Verify the renderer console did NOT receive a `close-active-tab` IPC.

**Expected:**
- No `close-active-tab` event in the renderer console for the wizard window press.

**Fail indicators:**
- IPC fires anyway.

<!-- @portico:test-status:begin id=B-24 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:07.472Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/main-window-close-regressions.test.js -- 0s
<!-- @portico:test-status:end -->
