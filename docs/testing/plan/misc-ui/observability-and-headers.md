# M.2 — Observability and headers

Loading overlay safety timeout, current-user header refresh, About dialog wiring, and the bearer-protected LLM debug monitor.

- Up: [`docs/testing/plan/misc-ui/README.md`](README.md).

---

## Scenarios

### M-06 — Loading overlay auto-hides after the 60s safety timeout (regression #53)

**Coverage:** Auto — [`main-chat-loading-overlay.test.js`](../../../../electron-app/src/services/main-chat-loading-overlay.test.js)
**Type:** Shell
**Preconditions:** None — investigation only.

**Steps (regression-investigation only):**
1. Run `node --test electron-app/src/services/main-chat-loading-overlay.test.js`.
2. Confirm the test asserts the overlay hides after 60 seconds even if the success signal never arrives.

**Expected:**
- Test passes.

**Fail indicators:**
- Loading overlay sticks indefinitely on a stalled OWUI load.

<!-- @portico:test-status:begin id=M-06 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:27.228Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/main-chat-loading-overlay.test.js -- 0s
<!-- @portico:test-status:end -->

---

### M-07 — Current-user header refreshes after Portico auth

**Coverage:** Auto — [`current-user.test.js`](../../../../electron-app/src/services/current-user.test.js)
**Type:** Shell
**Preconditions:** None — investigation only.

**Steps (regression-investigation only):**
1. Run `node --test electron-app/src/services/current-user.test.js`.
2. Manually: complete Portico corporate auth (H-01); confirm the header in the main shell updates to show the authenticated user's name/email.

**Expected:**
- Header reflects authenticated user immediately after auth completes.

**Fail indicators:**
- Header stays "guest" or empty.
- Requires app restart to reflect.

<!-- @portico:test-status:begin id=M-07 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:27.711Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/current-user.test.js -- 0s
<!-- @portico:test-status:end -->

---

### M-08 — About dialog reads version + build + channel from `build-info.json`

**Coverage:** Manual
**Type:** Shell
**Preconditions:** Running build with a known `build-info.json`.

**Steps:**
1. Locate `build-info.json`: `cat ~/Applications/Portico\ AI\ Chat.app/Contents/Resources/app.asar.unpacked/electron-app/build-info.json` (or equivalent in your install).
2. Open the app; menu → "About Portico".
3. Confirm version, build hash, and channel match `build-info.json`.

**Expected:**
- Three fields match the file exactly.

**Fail indicators:**
- Hardcoded fallback strings ("dev"/"unknown") shown.
- Mismatch with `build-info.json`.

<!-- @portico:test-status:begin id=M-08 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### M-09 — LLM debug monitor exposes traffic; bearer-protected with `compare_digest`

**Coverage:** Auto — [`tests/llm-debug-monitor-*.unit.test.js`](../../../../tests)
**Type:** Security
**Preconditions:** None — investigation only.

**Steps (regression-investigation only):**
1. Run all matching tests: `node --test tests/llm-debug-monitor-*.unit.test.js`.
2. Confirm assertions cover:
   - Bearer required for monitor endpoint.
   - Comparison uses constant-time / `compare_digest`.
   - Mismatched bearer returns `401` with no traffic body.

**Expected:**
- Tests pass.
- No source path uses `==` for bearer comparison.

**Fail indicators:**
- Plain `==` comparison.
- Endpoint reachable without auth.

<!-- @portico:test-status:begin id=M-09 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->
