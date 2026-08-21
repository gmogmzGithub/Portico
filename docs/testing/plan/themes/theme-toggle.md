# C.1 — Theme toggle

Four scenarios for the global theme: default state, sun/moon button, persistence, and cross-window broadcast.

- Up: [`docs/testing/plan/themes/README.md`](README.md).

---

## Scenarios

### C-01 — App boots in dark theme by default on first run

**Coverage:** Partial — [`konami-theme-toggle.test.js`](../../../../electron-app/src/services/konami-theme-toggle.test.js)
**Type:** Theme
**Preconditions:**
- Fresh install (post-`clean_full.sh`) — no `localStorage.theme` set.

**Steps:**
1. Launch the app.
2. Observe the initial theme.

**Expected:**
- Background is dark.
- Sun icon appears in the header (indicating "click to switch to light").

**Fail indicators:**
- Light theme on first run.
- Theme indeterminate / flicker.

<!-- @portico:test-status:begin id=C-01 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:56.655Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/konami-theme-toggle.test.js -- 0s
<!-- @portico:test-status:end -->

---

### C-02 — Sun/moon button in the header toggles between dark and light

**Coverage:** Auto — [`konami-theme-toggle.test.js`](../../../../electron-app/src/services/konami-theme-toggle.test.js)
**Type:** Theme
**Preconditions:** App launched.

**Steps:**
1. Click the sun/moon icon in the header.
2. Click it again.

**Expected:**
- First click switches dark→light (or vice-versa).
- Icon flips after each click.
- Second click returns to original theme.

**Fail indicators:**
- Click does nothing.
- Icon stuck.
- Only main shell switches but OWUI view stays old (handled by C-04).

<!-- @portico:test-status:begin id=C-02 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:56.733Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/konami-theme-toggle.test.js -- 0s
<!-- @portico:test-status:end -->

---

### C-03 — Theme choice persists across restart (`localStorage.theme`)

**Coverage:** Manual
**Type:** Theme
**Preconditions:** App launched and theme intentionally set to light (C-02).

**Steps:**
1. Confirm light theme is active.
2. Press `Cmd+Q` to quit.
3. Relaunch from `/Applications/Portico.app`.

**Expected:**
- App relaunches in light theme.
- No flicker through dark.

**Fail indicators:**
- Defaults back to dark on relaunch.
- Visible dark→light flicker.

<!-- @portico:test-status:begin id=C-03 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### C-04 — Theme broadcasts to all windows in sync

**Coverage:** Auto — [`konami-theme-toggle.test.js`](../../../../electron-app/src/services/konami-theme-toggle.test.js)
**Type:** Theme
**Preconditions:**
- Main shell open.
- A detached chat window open.
- An open conversation tab and the OWUI webview visible.

**Steps:**
1. Toggle theme via the sun/moon button.

**Expected:**
- Main shell, detached window, conversation tab, and OWUI webview all flip together.

**Fail indicators:**
- One surface lags or stays in old theme.

<!-- @portico:test-status:begin id=C-04 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:56.802Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/konami-theme-toggle.test.js -- 0s
<!-- @portico:test-status:end -->
