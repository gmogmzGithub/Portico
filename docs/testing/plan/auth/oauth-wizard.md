# H.2 — OAuth wizard (per server)

Twelve scenarios for the per-server OAuth wizard, including the cert-trust flow, sequential setup, dismissal handling, and IPC single-fire enforcement.

- Up: [`docs/testing/plan/auth/README.md`](README.md).
- Cross-references: N-008 in [`docs/security/hardening-overview.md`](../../../security/hardening-overview.md).

---

## Scenarios

### H-10 — Slack OAuth: HTTPS callback succeeds; token stored

**Coverage:** Auto — [`oauth-wizard-modal.test.js`](../../../../electron-app/src/services/oauth-wizard-modal.test.js) (N-008)
**Type:** Auth / Security
**Preconditions:** A clean Slack state (no token); Slack toggled off.

**Steps:**
1. Toggle Slack on; the OAuth modal opens.
2. Click Authorize → browser opens `https://localhost:<port>/callback` (or Slack's OAuth page).
3. Approve scopes; browser returns success.
4. Confirm token stored: `security find-generic-password -s portico-slack-token` returns an entry.

**Expected:**
- Authorize succeeds with a valid lock icon.
- Token persists in Keychain.
- No "Connection is not private" warning.

**Fail indicators:**
- Browser cert warning.
- No Keychain entry post-flow.

<!-- @portico:test-status:begin id=H-10 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:01.541Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/oauth-wizard-modal.test.js -- 0s
<!-- @portico:test-status:end -->

---

### H-11 — Slack: cert is trusted in login Keychain (no "Connection is not private" warning)

**Coverage:** Manual (N-008)
**Type:** Auth / Security
**Preconditions:** Same as H-10.

**Steps:**
1. Trigger Slack OAuth.
2. When the browser opens the local HTTPS callback, look at the address bar.
3. Run `security find-certificate -c "localhost" ~/Library/Keychains/login.keychain-db | grep -E "labl|trust"` and confirm the cert exists with `trustRoot` policies `ssl` + `basic`.

**Expected:**
- Browser shows valid lock icon.
- Cert exists in login Keychain with policies `ssl` and `basic`.

**Fail indicators:**
- Browser shows certificate warning page.
- Cert missing from Keychain.

<!-- @portico:test-status:begin id=H-11 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-05-05T12:44:20.687Z
- Build: pre-beta-fix-message-sending @ a1e1f70f
- Executor: odubo
- Notes: manual: Slack OAuth — browser shows valid lock, security find-certificate returns localhost cert with trustRoot ssl+basic
<!-- @portico:test-status:end -->

---

### H-12 — Slack tool call after OAuth succeeds without exposing token-type jargon

**Coverage:** Manual (regression #64 fork)
**Type:** Auth
**Preconditions:** Slack OAuth complete (H-10).

**Steps:**
1. Send a chat message: `list my Slack channels`.
2. Inspect the assistant's response and any inline error / log surfaces.

**Expected:**
- Tool call completes.
- Errors / messages do not surface "xoxp" / "xoxb" token-type strings to the user.

**Fail indicators:**
- "xoxp_..."  / "xoxb_..." literal in any user-visible message.

<!-- @portico:test-status:begin id=H-12 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-05-05T12:44:20.851Z
- Build: pre-beta-fix-message-sending @ a1e1f70f-dirty
- Executor: odubo
- Notes: manual: Slack tool call (list channels) succeeded; no xoxp/xoxb token-type strings surfaced to user
<!-- @portico:test-status:end -->

---

### H-13 — Google Workspace: full OAuth flow + tool call works

**Coverage:** Manual (legacy item 12)
**Type:** Auth
**Preconditions:** Google account with workspace tools available; Google Workspace integration available.

**Steps:**
1. Toggle Google Workspace on.
2. Walk through the OAuth flow.
3. Ask the agent to list the next 3 calendar events or recent emails.

**Expected:**
- OAuth completes.
- Tool call returns workspace data.

**Fail indicators:**
- OAuth never returns.
- Token-scope mismatch.

<!-- @portico:test-status:begin id=H-13 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-05-05T12:44:21.016Z
- Build: pre-beta-fix-message-sending @ a1e1f70f-dirty
- Executor: odubo
- Notes: manual: Google Workspace OAuth completed; agent listed calendar events and recent emails
<!-- @portico:test-status:end -->

---

### H-14 — Glean: full OAuth flow + search tool works

**Coverage:** Manual (legacy item 11)
**Type:** Auth
**Preconditions:** Glean account.

**Steps:**
1. Toggle Glean on.
2. Walk through OAuth.
3. Ask the agent to perform a Glean search.

**Expected:**
- OAuth completes.
- Glean search returns results.

**Fail indicators:**
- OAuth fails.
- Search returns 401.

<!-- @portico:test-status:begin id=H-14 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-05-05T12:44:21.172Z
- Build: pre-beta-fix-message-sending @ a1e1f70f-dirty
- Executor: odubo
- Notes: manual: Glean OAuth completed; search tool returned results
<!-- @portico:test-status:end -->

---

### H-15 — Already-authorized server reopens chat without showing OAuth modal

**Coverage:** Auto — [`oauth-flow-lifecycle.test.js`](../../../../electron-app/src/services/oauth-flow-lifecycle.test.js)
**Type:** Auth
**Preconditions:** Slack already authorized (H-10).

**Steps:**
1. Quit the app and relaunch.
2. Open a chat tab.

**Expected:**
- No OAuth modal appears.
- Slack tools are available immediately in the LLM context.

**Fail indicators:**
- OAuth modal pops on relaunch (token forgotten).

<!-- @portico:test-status:begin id=H-15 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:02.232Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/oauth-flow-lifecycle.test.js -- 1s
<!-- @portico:test-status:end -->

---

### H-16 — Sequential setup of two OAuth servers does not overlap modals

**Coverage:** Auto — [`oauth-flow-lifecycle.test.js`](../../../../electron-app/src/services/oauth-flow-lifecycle.test.js) (regression #13)
**Type:** Auth
**Preconditions:** Two un-authorized OAuth servers (e.g. Slack + Google Workspace).

**Steps:**
1. In rapid succession, toggle both servers on.

**Expected:**
- The first OAuth modal renders.
- The second is queued; it appears only after the first completes / dismisses.

**Fail indicators:**
- Both modals render simultaneously.
- Second modal lost.

<!-- @portico:test-status:begin id=H-16 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:02.342Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/oauth-flow-lifecycle.test.js -- 1s
<!-- @portico:test-status:end -->

---

### H-17 — Dismiss OAuth modal mid-flow → AI receives `dismissed` reason and offers retry

**Coverage:** Manual (regression #22)
**Type:** Auth
**Preconditions:** OAuth modal currently open mid-flow.

**Steps:**
1. Click the modal's close (X).
2. Observe the AI's next message in the chat.

**Expected:**
- Assistant message acknowledges dismissal (`dismissed` reason).
- Offers a retry option (button or inline link).

**Fail indicators:**
- Assistant silently waits forever.
- No retry surfaced.

<!-- @portico:test-status:begin id=H-17 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-05-05T12:44:21.317Z
- Build: pre-beta-fix-message-sending @ a1e1f70f-dirty
- Executor: odubo
- Notes: manual: dismissed OAuth modal mid-flow; assistant acknowledged 'dismissed' and offered retry
<!-- @portico:test-status:end -->

---

### H-18 — OAuth callback timeout fires within ~10s for contractor / data-plat-mcp; ~30s for others

**Coverage:** Manual (regression #55)
**Type:** Auth
**Preconditions:** A controlled environment where the OAuth callback can be delayed (e.g. block the loopback port).

**Steps:**
1. Trigger OAuth for a contractor / data-plat-mcp server.
2. Block the callback so it never returns.
3. Wait — the timeout should fire ≤10s.
4. Repeat for any other OAuth server (default ~30s timeout).

**Expected:**
- Per-server timeouts respected.
- Failure surfaced cleanly to the user with a retry option.

**Fail indicators:**
- Timeout never fires.
- Wrong-window timeout (e.g. 30s for contractor).

<!-- @portico:test-status:begin id=H-18 -->
**Last execution:**
- Status: `NotApplicable`
- Date: 2026-05-06T07:55:39.228Z
- Build: pre-beta-fix-message-sending @ 6644c592-dirty
- Executor: odubo
- Notes: Per prior thread decision: scenario assumes a clock-based fast-fail that we've intentionally chosen NOT to implement. Recovery is strictly user-driven (Stuck?Retry, modal X, 10-min outer budget, contractor+data-plat-mcp 4xx auth-URL probe). Rationale documented next to WIZARD_OAUTH_FLOW_TIMEOUT_MS in oauth-wizard-modal.js and atop oauth-flow-lifecycle.js.
<!-- @portico:test-status:end -->

---

### H-19 — OAuth IPC is single-fire (one auth URL via single wizard)

**Coverage:** Auto — [`control-plane-oauth-regressions.test.js`](../../../../electron-app/src/services/control-plane-oauth-regressions.test.js) (regression #54)
**Type:** Auth
**Preconditions:** An OAuth flow in progress.

**Steps (regression-investigation only):**
1. From `electron-app/`, run `node --test src/services/control-plane-oauth-regressions.test.js`.

**Expected:**
- Test passes.
- A single IPC dispatch produces one auth URL via one wizard instance.

**Fail indicators:**
- Test fails: duplicate dispatch.

<!-- @portico:test-status:begin id=H-19 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:02.997Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/control-plane-oauth-regressions.test.js -- 0s
<!-- @portico:test-status:end -->

---

### H-20 — OAuth tokens delete cleanly via control plane → server enters `<needs_auth>`

**Coverage:** Auto — [`oauth-token-storage.test.js`](../../../../electron-app/src/services/oauth-token-storage.test.js) (regression #15)
**Type:** Auth
**Preconditions:** A server already authorized (e.g. Slack).

**Steps:**
1. Settings → MCP → Slack → Delete tokens.
2. Inspect the server's status badge.

**Expected:**
- Badge transitions to `<needs_auth>`.
- `security find-generic-password -s portico-slack-token` returns nothing.

**Fail indicators:**
- Badge shows `available` after delete.
- Keychain entry remains.

<!-- @portico:test-status:begin id=H-20 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:03.561Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/oauth-token-storage.test.js -- 0s
<!-- @portico:test-status:end -->

---

### H-21 — Token refresh / expired 401 prompts user before re-triggering guided setup

**Coverage:** Manual (regression #18)
**Type:** Auth
**Preconditions:** A token expired or revoked on the server side (e.g. you revoke Slack from Slack admin).

**Steps:**
1. Send a chat message that triggers a Slack tool call.
2. Observe the assistant's response.

**Expected:**
- The assistant detects 401 and prompts the user with a clear "your token expired — re-authenticate?" message before any guided-setup re-entry.

**Fail indicators:**
- App silently re-launches the OAuth wizard with no warning.
- Assistant returns the raw 401.

<!-- @portico:test-status:begin id=H-21 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-05-06T08:42:45.418Z
- Build: pre-beta-fix-message-sending @ 7233568a-dirty
- Executor: odubo
- Notes: manual: revoked/expired token triggered 401; assistant prompted user to re-authenticate before re-entering guided setup
<!-- @portico:test-status:end -->
