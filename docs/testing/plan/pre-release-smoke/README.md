# 0 — Pre-release smoke (P0)

These eight scenarios are the *minimum* a release candidate must pass before any deeper testing. If any P0 fails, **stop and re-spin the build**.

- Related docs: [`docs/security/hardening-overview.md`](../../../security/hardening-overview.md), [`docs/CHANGELOG.md`](../../../CHANGELOG.md).
- Up: [`docs/testing/README.md`](../../README.md).

---

## Status snapshot

<!-- @portico:status-snapshot:begin -->
| Total | NotRun | Pass | Fail | Skipped | Blocked | N/A |
|---:|---:|---:|---:|---:|---:|---:|
|     8 |      3 |    5 |    0 |       0 |       0 |   0 |
<!-- @portico:status-snapshot:end -->

## At-a-glance

| ID    | Scenario                                                                         | Type     | Coverage | Status | Last run |
|-------|----------------------------------------------------------------------------------|----------|----------|--------|----------|
| P0-01 | Clean install via `clean_full.sh && install_v2.sh`                               | Setup    | Manual   | NotRun | -        |
| P0-02 | Portico corporate login from guided setup                                         | Auth     | Partial  | Pass   | 2026-04-28 |
| P0-03 | Send a chat message and receive a streamed response                              | Chat     | Partial  | NotRun | -        |
| P0-04 | Slack OAuth end-to-end (cert + token storage)                                    | Auth     | Partial  | Pass   | 2026-04-28 |
| P0-05 | GitLab token-based integration via guided setup                                  | MCP      | Partial  | Pass   | 2026-04-28 |
| P0-06 | Tabs: open second tab, switch, close active with `Cmd+W`                         | Shell    | Partial  | Pass   | 2026-04-28 |
| P0-07 | Quit and relaunch — state persists                                               | Shell    | Partial  | NotRun | -        |
| P0-08 | No plaintext API key in Application Support                                      | Security | Auto     | Pass   | 2026-04-28 |

---

## Scenarios

### P0-01 — Clean install via `clean_full.sh && install_v2.sh`

**Coverage:** Manual
**Type:** Setup / Install
**Preconditions:**
- Mac with OrbStack (or Docker Desktop) running.
- Repo cloned at a known path.
- No prior install required, but if there is one this scenario verifies it can be wiped.

**Steps:**
1. From the repo root, run `./clean_full.sh` and answer any confirmation prompts. Wait for it to print `clean_full.sh: done`.
2. Run `./install_v2.sh` and watch the terminal output.
3. Once the script finishes, the app should auto-launch. If not, open `Portico.app` from `/Applications`.

**Expected:**
- `clean_full.sh` removes Application Support state, runtime-secrets cache, OAuth tokens, Keychain entries, Docker resources, and trusted certs.
- `install_v2.sh` ends with no `[ERROR]` lines; final lines mention `Installation complete` (or equivalent) and the app launch.
- Main shell renders with a "New Chat" tab; no error modal.

**Fail indicators:**
- Installer exits non-zero.
- App crashes on launch.
- Main shell stuck on splash.
- OrbStack login error in install log.

<!-- @portico:test-status:begin id=P0-01 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### P0-02 — Portico corporate login from guided setup

**Coverage:** Partial — [`setup-auth.test.js`](../../../../electron-app/src/services/setup-auth.test.js)
**Type:** Auth
**Preconditions:**
- P0-01 complete.
- Valid Portico corporate account.
- On VPN if your org requires it.

**Steps:**
1. On first launch the guided-setup wizard auto-opens. Click through to the **User** screen.
2. Click **Sign in with Portico**. The system browser should open `https://oauth.example.invalid/...`.
3. Complete corporate login + 2FA.
4. The browser shows "You can return to the app". Switch back to PORTICO.

**Expected:**
- User screen displays your corporate name/email.
- **Continue** unblocks; subsequent screens proceed.

**Fail indicators:**
- Browser shows certificate warning.
- Redirect lands on a blank page.
- PORTICO stays on **Waiting for sign-in** indefinitely.

<!-- @portico:test-status:begin id=P0-02 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:50:59.801Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/setup-auth.test.js -- 4s
<!-- @portico:test-status:end -->

---

### P0-03 — Send a chat message and receive a streamed response

**Coverage:** Partial — `cargo test --manifest-path src/mcp-orc-rust/Cargo.toml -p health-check`
**Type:** Chat / LLM
**Preconditions:**
- P0-02 complete; finalize step succeeded.
- A default model is selected in the model picker.

**Steps:**
1. In the chat input, type `Hello, what can you do?` and press Enter.
2. Watch the message stream into the assistant bubble.

**Expected:**
- Tokens stream in (not a single dump at the end).
- Response completes without an error toast.
- The chat title updates from "New Chat" to a generated title within a few seconds.

**Fail indicators:**
- `401` / `502` in the chat or in `~/Library/Logs/portico/main.log`.
- Response never starts.
- Tokens never stream (validates Bifrost SSE pipeline).

<!-- @portico:test-status:begin id=P0-03 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### P0-04 — Slack OAuth end-to-end (covers HTTPS cert + token storage)

**Coverage:** Partial — [`oauth-wizard-modal.test.js`](../../../../electron-app/src/services/oauth-wizard-modal.test.js)
**Type:** Auth / Security
**Preconditions:**
- P0-03 complete.
- You have rights to authorize Slack against your workspace.

**Steps:**
1. Open **Settings → MCP integrations → Slack**.
2. Click **Authorize**. Browser should open `https://localhost:<port>/...` (or the Slack OAuth landing page) with a valid lock icon (no cert warning).
3. Approve the Slack scopes; browser returns to a "Connected" page.
4. Back in PORTICO, click **Save & Test**.
5. Send a chat message asking the agent to perform a Slack tool call (e.g. `list my Slack channels`).

**Expected:**
- Authorize step succeeds with no certificate warning.
- **Test** returns green.
- Agent performs the Slack tool call and returns workspace data.

**Fail indicators:**
- "Connection is not private" page (regression of N-008 cert-trust fix).
- `401` from Slack.
- Tool call fails with `unauthorized_app`.

**Cleanup:** You can leave Slack enabled for the rest of the test pass; § H exercises it further.

<!-- @portico:test-status:begin id=P0-04 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:01.629Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/oauth-wizard-modal.test.js -- 0s
<!-- @portico:test-status:end -->

---

### P0-05 — GitLab token-based integration via guided setup

**Coverage:** Partial — [`mcp-config-modal.test.js`](../../../../electron-app/src/services/mcp-config-modal.test.js)
**Type:** MCP / Auth
**Preconditions:**
- GitLab personal access token available with `read_api` scope.
- Slack already enabled (per P0-04) is OK.

**Steps:**
1. Open **Settings → MCP integrations → GitLab** (or run the **Re-run guided setup** menu item if needed).
2. Paste the token in the secure input.
3. Click **Save & Test**.
4. Ask the agent to call a GitLab tool (e.g. `show my open merge requests`).

**Expected:**
- Test succeeds.
- Tool call returns data.
- Token never appears in any log file or in `~/Library/Application Support/portico/runtime-secrets.env` as a plaintext literal (it is stored under a `_FILE` pointer or in the Keychain — see § L).

**Fail indicators:**
- Token saved as a literal value in `runtime-secrets.env`.
- Tool call returns `401`.

<!-- @portico:test-status:begin id=P0-05 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:04.246Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/mcp-config-modal.test.js -- 0s
<!-- @portico:test-status:end -->

---

### P0-06 — Tabs: open second tab, switch, close active with `Cmd+W`

**Coverage:** Partial — [`tab-search-regressions.test.js`](../../../../electron-app/src/services/tab-search-regressions.test.js)
**Type:** Shell
**Preconditions:**
- Main shell focused.
- At least one chat tab already open.

**Steps:**
1. Press `Cmd+T` (or click the `+` on the tab strip) to create a second tab.
2. Press `Cmd+1` and `Cmd+2` to switch between them.
3. Focus the second tab and press `Cmd+W`.

**Expected:**
- Second tab opens and becomes active.
- `Cmd+1` / `Cmd+2` switch instantly.
- `Cmd+W` closes the active chat tab and returns focus to the previous tab. The system `chat` / `control` tabs are *not* closeable by `Cmd+W`.

**Fail indicators:**
- `Cmd+W` quits the app or closes the entire window (regression of B-15 vs. B-12).
- System tabs disappear.
- Tab switch leaves the OWUI view blank.

<!-- @portico:test-status:begin id=P0-06 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:35.881Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/tab-search-regressions.test.js -- 0s
<!-- @portico:test-status:end -->

---

### P0-07 — Quit and relaunch — state persists

**Coverage:** Partial — [`chat-workspaces.test.js`](../../../../electron-app/src/services/chat-workspaces.test.js)
**Type:** Shell / Persistence
**Preconditions:**
- ≥2 open chat tabs.
- At least one chat with messages.

**Steps:**
1. Press `Cmd+Q`. App exits (no app windows remain; not just hidden).
2. Re-launch from `/Applications/Portico.app` (or via Spotlight).

**Expected:**
- Same set of tabs reappears.
- Previously active tab is still active.
- Chat history is intact (scroll into one of the chats and find an older message).

**Fail indicators:**
- Tabs reset.
- Chat history empty.
- "First run" guided setup pops again.

<!-- @portico:test-status:begin id=P0-07 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### P0-08 — No plaintext API key in Application Support

**Coverage:** Auto — [`runtime-secrets-hardening.unit.test.js`](../../../../electron-app/src/config/runtime-secrets-hardening.unit.test.js) (cross-listed with V-007 / N-004 / N-007)
**Type:** Security
**Preconditions:**
- P0-01 complete (so the install has had a chance to write its runtime files).

**Steps:**
1. From terminal, run:
   ```bash
   grep -r "PORTICO_LLM_API_KEY=[A-Za-z0-9]" ~/Library/Application\ Support/portico || echo "OK: no plaintext key found"
   ```
2. Repeat for sensitive MCP keys such as `GITLAB_PERSONAL_ACCESS_TOKEN=`, `SOURCEGRAPH_TOKEN=`, `N8N_API_KEY=`, plus legacy Slack client keys (`SLACK_OAUTH_CLIENT_ID=` / `SLACK_OAUTH_CLIENT_SECRET=`) which should remain absent after the PKCE migration.

**Expected:**
- `OK: no plaintext key found` for every grep.
- Allowed forms instead: `PORTICO_LLM_API_KEY_FILE=/path/...` (a path pointer) or no entry at all (Keychain-resolved).

**Fail indicators:**
- A literal value match — file and line should be reported as a regression of V-007 / N-004 / N-007.

<!-- @portico:test-status:begin id=P0-08 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:12.466Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/config/runtime-secrets-hardening.unit.test.js -- 0s
<!-- @portico:test-status:end -->
