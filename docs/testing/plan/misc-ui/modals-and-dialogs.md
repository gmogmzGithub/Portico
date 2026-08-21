# M.1 — Modals and dialogs

User-question modal, MCP config modal, marketplace UI, and the log viewer.

- Up: [`docs/testing/plan/misc-ui/README.md`](README.md).

---

## Scenarios

### M-01 — User-question modal renders multi-question review controls

**Coverage:** Auto — [`user-question-modal-regressions.test.js`](../../../../electron-app/src/services/user-question-modal-regressions.test.js)
**Type:** Shell
**Preconditions:** None — investigation only.

**Steps (regression-investigation only):**
1. Run `node --test electron-app/src/services/user-question-modal-regressions.test.js`.
2. Confirm assertions cover multi-question rendering, review controls, and accept/cancel handlers.

**Expected:**
- All cases pass.

**Fail indicators:**
- Test fails or asserts collapse multiple questions into one.

<!-- @portico:test-status:begin id=M-01 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:26.270Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/user-question-modal-regressions.test.js -- 0s
<!-- @portico:test-status:end -->

---

### M-02 — User-question modal accepts the built-in "none of the above" option

**Coverage:** Auto — [`user-question-flows.test.js`](../../../../electron-app/src/services/user-question-flows.test.js)
**Type:** Shell
**Preconditions:** None — investigation only.

**Steps (regression-investigation only):**
1. Run `node --test electron-app/src/services/user-question-flows.test.js`.

**Expected:**
- "None of the above" path returns a sentinel value distinct from any rendered option index.

**Fail indicators:**
- Test fails.

<!-- @portico:test-status:begin id=M-02 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:26.745Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/user-question-flows.test.js -- 0s
<!-- @portico:test-status:end -->

---

### M-03 — MCP config modal renders markdown setup instructions

**Coverage:** Auto — [`mcp-config-modal.test.js`](../../../../electron-app/src/services/mcp-config-modal.test.js)
**Type:** Shell
**Preconditions:** A configured MCP server with markdown setup instructions in its `mcp-skills.yaml` definition.

**Steps:**
1. Run `node --test electron-app/src/services/mcp-config-modal.test.js`.
2. Manually: open Settings → MCP → click "Configure" on a token-based integration with markdown setup instructions; confirm the markdown renders (headings, links, code spans).

**Expected:**
- Markdown is rendered as HTML (not as raw markdown text).
- Links open externally.

**Fail indicators:**
- Raw `# heading` text shown.
- Links inert.

<!-- @portico:test-status:begin id=M-03 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:04.172Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/mcp-config-modal.test.js -- 0s
<!-- @portico:test-status:end -->

---

### M-04 — Marketplace UI lists all configured marketplaces and per-marketplace failure reasons

**Coverage:** Auto — [`marketplace-service.test.js`](../../../../electron-app/src/services/marketplace-service.test.js)
**Type:** Shell
**Preconditions:** Two configured marketplaces; one with a deliberate sync failure (e.g. unreachable URL).

**Steps:**
1. Run `node --test electron-app/src/services/marketplace-service.test.js`.
2. Manually: open Settings → Marketplaces; confirm both are listed with their last-sync state and the failing one shows the failure reason.

**Expected:**
- All configured marketplaces shown.
- Per-marketplace failure reason displayed for the failing entry.

**Fail indicators:**
- Failing entry hidden.
- Generic "marketplace error" with no per-marketplace context.

<!-- @portico:test-status:begin id=M-04 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:20.851Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/marketplace-service.test.js -- 1s
<!-- @portico:test-status:end -->

---

### M-05 — Log viewer streams lines without blocking the renderer

**Coverage:** Manual
**Type:** Shell
**Preconditions:** App running; main shell focused.

**Steps:**
1. Open Help → Show Logs (or via `Cmd+Shift+L` if bound) to open the log viewer.
2. Trigger a chat that produces volume in the logs (run a sub-agent or any flow with verbose output).
3. Confirm the renderer remains responsive — the log viewer should not freeze the main shell. Click around in the conversation list; switch tabs.

**Expected:**
- Log viewer streams new lines incrementally; renderer stays responsive.

**Fail indicators:**
- UI hangs while logs scroll.
- Significant frame drops.

<!-- @portico:test-status:begin id=M-05 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->
