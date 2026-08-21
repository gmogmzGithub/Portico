# D.2 — Composer & attachments

Five scenarios for composer actions (edit/resend), attachments, the two copy paths, and the Bedrock thinking-signature regression.

- Up: [`docs/testing/plan/chat-ui/README.md`](README.md).

---

## Scenarios

### D-06 — Message edit & resend

**Coverage:** Manual
**Type:** Chat
**Preconditions:** A chat with at least one user message + one assistant response.

**Steps:**
1. Hover the user message; click the edit button.
2. Change the text and submit.

**Expected:**
- Subsequent assistant messages are dropped (or marked stale).
- A fresh response is generated for the edited message.

**Fail indicators:**
- Edit is silently ignored.
- Original assistant response stays visible alongside the new one as if both were valid.

<!-- @portico:test-status:begin id=D-06 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### D-07 — Attach a file/image and have the model reference it

**Coverage:** Manual
**Type:** Chat / MCP
**Preconditions:** A model that supports attachments.

**Steps:**
1. Click the attachment button in the composer; pick a `.png` and a `.txt` from disk.
2. Send `Describe the attached files`.

**Expected:**
- The assistant references both attachments by name and content.
- File preview appears in the user message bubble.

**Fail indicators:**
- Attachment silently dropped.
- Assistant says it has no attachments.

<!-- @portico:test-status:begin id=D-07 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### D-08 — Copy text from a message via Electron IPC

**Coverage:** Auto — [`setup-copy.unit.test.js`](../../../../electron-app/src/services/setup-copy.unit.test.js)
**Type:** Chat / Shell
**Preconditions:** An assistant message with text.

**Steps:**
1. Hover the assistant message; click the copy icon.
2. Paste into a separate text editor.

**Expected:**
- Pasted text matches the message text exactly.
- The copy used Electron IPC (no browser permission prompt).

**Fail indicators:**
- Browser permission prompt appears.
- Pasted text is empty or contains HTML.

<!-- @portico:test-status:begin id=D-08 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:04.797Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/setup-copy.unit.test.js -- 0s
<!-- @portico:test-status:end -->

---

### D-09 — Copy fallback uses `navigator.clipboard.writeText`

**Coverage:** Auto — [`setup-copy.unit.test.js`](../../../../electron-app/src/services/setup-copy.unit.test.js)
**Type:** Chat / Shell
**Preconditions:** None — investigation only.

**Steps (regression-investigation only):**
1. From `electron-app/`, run `node --test src/services/setup-copy.unit.test.js`.

**Expected:**
- Test asserts that when Electron IPC is unavailable, the renderer falls back to `navigator.clipboard.writeText`.

**Fail indicators:**
- Test fails: fallback never reached, or both paths attempted simultaneously.

<!-- @portico:test-status:begin id=D-09 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:04.871Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/setup-copy.unit.test.js -- 0s
<!-- @portico:test-status:end -->

---

### D-10 — Bedrock thinking signature survives long guided setup (~83s)

**Coverage:** Partial — manual smoke (regression #15)
**Type:** Chat / LLM
**Preconditions:** A Bedrock-backed model selected; reproducible long-running guided-setup operation that takes ~80s.

**Steps:**
1. Trigger a guided-setup operation that requires a long Bedrock thinking-block (e.g. agent decides which integrations to enable).
2. Wait for completion.
3. Inspect the assistant's reasoning block — it should not be truncated.

**Expected:**
- Final response includes the full reasoning trace.
- Signature on the thinking block is intact.
- No mid-stream cutoff.

**Fail indicators:**
- Reasoning truncated at 60s / 80s.
- Bedrock signature error in main log.

<!-- @portico:test-status:begin id=D-10 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->
