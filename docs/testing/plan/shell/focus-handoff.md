# B.4 — Focus handoff

Three scenarios for the trickiest focus transitions: closing the find overlay, switching tabs mid-typing, and OAuth callbacks competing with detached windows.

- Up: [`docs/testing/plan/shell/README.md`](README.md).

---

## Scenarios

### B-50 — Close find overlay → focus returns to OWUI view

**Coverage:** Auto — [`tab-search-regressions.test.js`](../../../../electron-app/src/services/tab-search-regressions.test.js) (regression #63)
**Type:** Search
**Preconditions:** A chat with content, focus on the OWUI view.

**Steps:**
1. Press `Cmd+F`.
2. Press `Esc`.
3. Type into the chat input.

**Expected:**
- Keystrokes go to the chat input, not to a stale find input.

**Fail indicators:**
- First keystroke after `Esc` is swallowed.

<!-- @portico:test-status:begin id=B-50 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:36.180Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/tab-search-regressions.test.js -- 0s
<!-- @portico:test-status:end -->

---

### B-51 — Switching tabs hands off focus

**Coverage:** Auto — [`tab-search-regressions.test.js`](../../../../electron-app/src/services/tab-search-regressions.test.js)
**Type:** Shell
**Preconditions:** ≥2 chat tabs.

**Steps:**
1. Press `Cmd+1`, then `Cmd+2`.
2. Immediately type without clicking.

**Expected:**
- Characters go to the active tab's input.

**Fail indicators:**
- Focus stuck in the previous tab's input.

<!-- @portico:test-status:begin id=B-51 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:36.258Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/tab-search-regressions.test.js -- 0s
<!-- @portico:test-status:end -->

---

### B-52 — OAuth/guided-setup focus does not flicker the main window

**Coverage:** Partial — [`control-plane-oauth-regressions.test.js`](../../../../electron-app/src/services/control-plane-oauth-regressions.test.js) (regression #52)
**Type:** Auth / Shell
**Preconditions:**
- Main shell + a detached window + an OAuth wizard open simultaneously.

**Steps:**
1. Trigger an OAuth callback (e.g. complete Slack authorize) so the wizard advances.

**Expected:**
- Only the main window receives focus on completion.
- The detached window does NOT flash to front and back (regression #52).

**Fail indicators:**
- Visible flicker.
- Detached window briefly receives focus.

<!-- @portico:test-status:begin id=B-52 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:03.063Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/control-plane-oauth-regressions.test.js -- 0s
<!-- @portico:test-status:end -->
