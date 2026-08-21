# F — Detached windows & artifact panel

Six scenarios for the detach/reattach lifecycle, the dynamic Window menu, the artifact panel, and the legacy privacy-banner removal.

- Up: [`docs/testing/README.md`](../../README.md).
- Cross-references: B-35 / B-36 (drag-detach and button-only reattach), B-13 / B-15 (close shortcuts).

---

## Status snapshot

<!-- @portico:status-snapshot:begin -->
| Total | NotRun | Pass | Fail | Skipped | Blocked | N/A |
|---:|---:|---:|---:|---:|---:|---:|
|     6 |      1 |    5 |    0 |       0 |       0 |   0 |
<!-- @portico:status-snapshot:end -->

## At-a-glance

| ID    | Scenario                                                                          | Type   | Coverage | Status | Last run |
|-------|-----------------------------------------------------------------------------------|--------|----------|--------|----------|
| F-01  | Detach a chat tab → fresh window opens, chat continues without reconnect          | Shell  | Auto     | Pass   | 2026-04-28 |
| F-02  | Return button redocks the detached window with the same session                   | Shell  | Auto     | Pass   | 2026-04-28 |
| F-03  | Detached window closes via `Cmd+W` / traffic light without affecting other windows | Shell | Auto     | Pass   | 2026-04-28 |
| F-04  | Window menu lists every detached chat window dynamically                          | Shell  | Manual   | NotRun | -        |
| F-05  | Open an artifact → artifact window opens; Window menu lists it                    | Shell  | Auto     | Pass   | 2026-04-28 |
| F-06  | Privacy banner is NOT present in detached chat windows                            | Shell  | Auto     | Pass   | 2026-04-28 |

---

## Scenarios

### F-01 — Detach a chat tab → fresh window opens, chat continues without reconnect

**Coverage:** Auto — [`detached-chat-window-policy.test.js`](../../../../electron-app/src/services/detached-chat-window-policy.test.js)
**Type:** Shell
**Preconditions:** A chat tab with at least one assistant message in flight or completed.

**Steps:**
1. Drag the chat tab out of the strip downwards.
2. Release.
3. In the new window, send another message.

**Expected:**
- A new chat window opens with that chat as its content.
- OWUI session is preserved (no reload, scroll position kept).
- Sending a new message just continues the conversation; no fresh OAuth or model handshake.

**Fail indicators:**
- Tab closes and a fresh window opens with `New Chat` (session lost — regression #59).

<!-- @portico:test-status:begin id=F-01 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:05.580Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/detached-chat-window-policy.test.js -- 0s
<!-- @portico:test-status:end -->

---

### F-02 — Return button redocks the detached window with the same session

**Coverage:** Auto — [`detached-chat-window-policy.test.js`](../../../../electron-app/src/services/detached-chat-window-policy.test.js)
**Type:** Shell
**Preconditions:** A detached chat window from F-01.

**Steps:**
1. Drag the detached window's title bar onto the main shell tab strip and release it.
2. Verify the window remains detached.
3. Click the detached header's **Return to Tab** button.

**Expected:**
- Native window movement never reattaches the conversation.
- Window closes.
- The chat reattaches as a tab in main shell.
- Session preserved (scroll position, in-flight stream).

**Fail indicators:**
- Releasing the detached window over the tab strip redocks it.
- Window stays open after clicking **Return to Tab**.
- Tab created without session.

<!-- @portico:test-status:begin id=F-02 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:05.651Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/detached-chat-window-policy.test.js -- 0s
<!-- @portico:test-status:end -->

---

### F-03 — Detached window closes via `Cmd+W` / traffic light without affecting other windows

**Coverage:** Auto — [`main-window-close-regressions.test.js`](../../../../electron-app/src/services/main-window-close-regressions.test.js) (regression #305)
**Type:** Shell
**Preconditions:** A detached chat window AND a main shell with ≥1 tab AND optionally another detached window.

**Steps:**
1. Focus the detached chat window.
2. Press `Cmd+W` (then on a separate detached window, click the red traffic light).

**Expected:**
- Each operation closes only the focused detached window.
- Main shell unaffected.
- Other detached windows unaffected.

**Fail indicators:**
- Other windows close as collateral.
- App quits.

<!-- @portico:test-status:begin id=F-03 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:06.753Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/main-window-close-regressions.test.js -- 0s
<!-- @portico:test-status:end -->

---

### F-04 — Window menu lists every detached chat window dynamically

**Coverage:** Manual
**Type:** Shell
**Preconditions:** ≥2 detached chat windows open.

**Steps:**
1. Open the `Window` menu.
2. Inspect the dynamic block at the bottom (after the static items).
3. Click one of the listed entries.

**Expected:**
- One menu entry per detached chat window, labeled with the chat title.
- Selecting an entry focuses that window.

**Fail indicators:**
- Entries missing.
- Stale entries for closed windows.

<!-- @portico:test-status:begin id=F-04 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### F-05 — Open an artifact → artifact window opens; Window menu lists it

**Coverage:** Auto — [`artifact-panel-layout.unit.test.js`](../../../../electron-app/src/services/artifact-panel-layout.unit.test.js)
**Type:** Shell
**Preconditions:** A chat that produced an artifact (e.g. ran the PDF skill from J-04).

**Steps:**
1. Click the artifact link/icon in the chat.
2. Open the `Window` menu.

**Expected:**
- A separate artifact window opens with the artifact content.
- The artifact appears as a new entry in the Window menu under the dynamic block.

**Fail indicators:**
- Artifact opens inline only.
- Window menu does not list the artifact.

<!-- @portico:test-status:begin id=F-05 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:08.179Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/artifact-panel-layout.unit.test.js -- 1s
<!-- @portico:test-status:end -->

---

### F-06 — Privacy banner is NOT present in detached chat windows

**Coverage:** Auto — [`detached-chat-window-policy.test.js`](../../../../electron-app/src/services/detached-chat-window-policy.test.js)
**Type:** Shell
**Preconditions:** A detached chat window.

**Steps (regression-investigation only):**
1. Visually inspect the detached window for the legacy `warning-banner` element.
2. Open DevTools on the detached window and `document.querySelector('.warning-banner')` should return `null`.

**Expected:**
- No banner is present.
- DOM does not contain the legacy element (it is dead code by design).

**Fail indicators:**
- Banner appears (legacy regression).

<!-- @portico:test-status:begin id=F-06 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:05.721Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/detached-chat-window-policy.test.js -- 0s
<!-- @portico:test-status:end -->
