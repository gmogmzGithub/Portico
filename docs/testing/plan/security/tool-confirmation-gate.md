# L.6 — MCP tool-confirmation gate

Seven scenarios for the per-action confirmation gate that protects every MCP write/action tool call. The gate is the structural defense against the failure mode reported under threat-model item N-012 — an MCP write tool firing without an explicit, action-specific user confirmation. Prompt-level policy (see [`docs/security/tool-confirmation.md`](../../../security/tool-confirmation.md)) is the soft layer; this gate is the hard one.

**Resolution flow (Cursor-style batched chips, current design):** when the assistant emits one or more destructive tool calls in a turn, each blocked call surfaces a chip in the chat input frame. Each chip's Yes / No / Reply-with-changes button hits the dedicated REST endpoint `POST /api/v1/utils/chip/resolve` directly — independent of the chat-completion pipeline — so stacked chips can be resolved in any order without one chip's processing blocking another. Once every chip on screen is in a terminal state (approved, cancelled, or modify-submitted), the renderer auto-fires ONE chat completion. The backend's `_resolve_pending_tool_confirmations` drains the per-chat resolution log via `Gate.pop_resolutions_for_batch` and injects a hidden `system` note describing each chip's outcome before the model sees the turn — the model then re-emits approvals (which dispatch silently against the cached approval), acknowledges cancellations, and re-issues modifications with adjusted args.

- Up: [`docs/testing/plan/security/README.md`](README.md).
- Threats: N-012.

---

## Scenarios

### L-18 — Destructive tool blocks on first call without user confirmation (N-012)

**Coverage:** Auto — [`tests/test_tool_confirmation_gate.py`](../../../../tests/test_tool_confirmation_gate.py), [`tests/test_tool_confirmation_gate_end_to_end.py`](../../../../tests/test_tool_confirmation_gate_end_to_end.py)
**Type:** Security
**Preconditions:** None — pure unit/E2E.

**Steps (regression-investigation only):**
1. Run `python -m pytest tests/test_tool_confirmation_gate.py tests/test_tool_confirmation_gate_end_to_end.py`.
2. Confirm `test_destructive_tool_blocks_first_call`, `test_first_destructive_call_never_dispatches`, and `test_planning_yes_far_from_propose_does_not_dispatch` all pass.
3. Manual sanity (optional, on the running app): start a chat, ask the model to "send a Slack message to my DM saying hi". Verify a confirmation **chip appears above the chat input** (alongside any Pending Steer chip) and Slack receives nothing until you click Yes.

**Expected:**
- The first dispatch attempt of any tool matched by [`mcp-policy/destructive-tools.json`](../../../../mcp-policy/destructive-tools.json) returns `action="block"` from the gate; the dispatcher (MCP/OpenAPI) is never invoked; an `audit_log` entry of kind `proposed` is recorded.
- A pre-existing affirmative reply that arrived BEFORE the gate proposed the action does NOT authorize the new call.

**Fail indicators:**
- Tests fail.
- Manual sanity check shows the Slack DM was sent without a card.

<!-- @portico:test-status:begin id=L-18 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-05-07T08:38:17.502Z
- Build: pre-beta-tmp @ 2ea7155d-dirty
- Executor: odubo
- Notes: pytest tests/test_tool_confirmation_gate.py tests/test_tool_confirmation_gate_end_to_end.py -- 94/94 passed
<!-- @portico:test-status:end -->

---

### L-19 — Explicit user confirmation drives a single dispatch (N-012)

**Coverage:** Auto — [`tests/test_tool_confirmation_gate_end_to_end.py`](../../../../tests/test_tool_confirmation_gate_end_to_end.py)
**Type:** Security
**Preconditions:** None.

**Steps (regression-investigation only):**
1. Run `python -m pytest tests/test_tool_confirmation_gate_end_to_end.py::test_yes_after_propose_results_in_one_dispatch`.
2. Manual sanity (optional): open a chat, ask the model to draft and send a Slack DM. Click **Yes, do it** on the chip in the input frame.

**Expected:**
- Exactly one dispatch is recorded against the fake dispatcher with the original args.
- After approval, the gate's `_pending` and `_approved` stores for the chat are empty (single-use).
- Manually: chip transitions to "Approved" state, dismisses on the next turn, and the Slack message arrives.

**Fail indicators:**
- More than one dispatch.
- Chip stays "pending" after approval.
- Tool result returns success but the dispatcher was never called.

<!-- @portico:test-status:begin id=L-19 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-05-07T08:38:17.546Z
- Build: pre-beta-tmp @ 2ea7155d-dirty
- Executor: odubo
- Notes: pytest tests/test_tool_confirmation_gate_end_to_end.py::test_yes_after_propose_results_in_one_dispatch -- passed (within 94/94 batch)
<!-- @portico:test-status:end -->

---

### L-20 — Hash binding rejects argument and tool drift after approval (N-012)

**Coverage:** Auto — [`tests/test_tool_confirmation_gate.py`](../../../../tests/test_tool_confirmation_gate.py), [`tests/test_tool_confirmation_gate_end_to_end.py`](../../../../tests/test_tool_confirmation_gate_end_to_end.py)
**Type:** Security
**Preconditions:** None.

**Steps (regression-investigation only):**
1. Run `python -m pytest tests/test_tool_confirmation_gate.py -k 'arg_drift or tool_drift or different_payload or different_destination'`.
2. Inspect [`src/patches/backend/open_webui/utils/tool_confirmation_gate.py`](../../../../src/patches/backend/open_webui/utils/tool_confirmation_gate.py) and verify `compute_call_hash` covers `(tool_name, canonicalized_args)`.

**Expected:**
- Approval for `(tool=A, args=X)` does NOT authorize `(tool=A, args=Y)` or `(tool=B, args=X)`. The gate either rejects with `hash_mismatch` (when a token is presented) or blocks again (when the model retries without a token).
- An `audit_log` `hash_mismatch` entry is recorded for the explicit-token case.

**Fail indicators:**
- Tests fail.
- Hash collisions across distinct args.
- Approval leaks across distinct tool names.

<!-- @portico:test-status:begin id=L-20 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-05-07T08:38:17.590Z
- Build: pre-beta-tmp @ 2ea7155d-dirty
- Executor: odubo
- Notes: pytest tests/test_tool_confirmation_gate.py -k 'arg_drift or tool_drift or different_payload or different_destination' -- passed (within 94/94 batch)
<!-- @portico:test-status:end -->

---

### L-21 — Stale "yes" cannot authorize a future action (N-012)

**Coverage:** Auto — [`tests/test_tool_confirmation_gate.py::test_resolve_yes_with_multiple_pending_drops_all_no_approval`](../../../../tests/test_tool_confirmation_gate.py), [`tests/test_tool_confirmation_gate_end_to_end.py::test_planning_yes_far_from_propose_does_not_dispatch`](../../../../tests/test_tool_confirmation_gate_end_to_end.py)
**Type:** Security
**Preconditions:** None.

**Steps (regression-investigation only):**
1. Run `python -m pytest tests/test_tool_confirmation_gate.py tests/test_tool_confirmation_gate_end_to_end.py -k 'stale or planning_yes or multiple_pending'`.
2. Manual sanity: in a chat, say "yes" to a planning question that contains no proposed action, then ask the model an unrelated follow-up that ends up calling Slack send. Verify the model still has to surface a chip in the input frame.

**Expected:**
- A "yes" in a turn with no pending actions is forwarded as a normal user message; no approval residue is left for a future turn.
- A "yes" with multiple pending actions is treated as ambiguous: all pending drop, no approval is granted, and the user must answer specifically.
- After `consume_assistant_turn`, any unused approved hashes expire.

**Fail indicators:**
- Test failures.
- Manual: the model auto-sends the Slack DM without a chip after the unrelated "yes".

<!-- @portico:test-status:begin id=L-21 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-05-07T08:38:17.634Z
- Build: pre-beta-tmp @ 2ea7155d-dirty
- Executor: odubo
- Notes: pytest tests/test_tool_confirmation_gate*.py -k 'stale or planning_yes or multiple_pending' -- passed (within 94/94 batch)
<!-- @portico:test-status:end -->

---

### L-22 — Confirmation chip UI fails closed and resolves via the dedicated REST endpoint (N-012)

**Coverage:** Auto — [`tests/test_tool_confirmation_chip.node.test.js`](../../../../tests/test_tool_confirmation_chip.node.test.js), [`tests/test_tool_confirmation_gate.py::test_utils_router_exposes_tool_confirmation_resolve_endpoint`](../../../../tests/test_tool_confirmation_gate.py)
**Type:** Security
**Preconditions:** Node 20+ available.

**Steps (regression-investigation only):**
1. Run `node --test tests/test_tool_confirmation_chip.node.test.js`.
2. Run `python -m pytest tests/test_tool_confirmation_gate.py -k 'chip_resolve_endpoint'`.
3. Open [`src/patches/frontend/src/lib/components/chat/MessageInput/ToolConfirmationChip.svelte`](../../../../src/patches/frontend/src/lib/components/chat/MessageInput/ToolConfirmationChip.svelte) and confirm option buttons route through `fetch("/api/v1/utils/chip/resolve", {method: "POST", ...})` with `{chat_id, hash, option_id, freeform_payload?}` and an `Authorization: Bearer <token>` header.
4. Confirm the chip is rendered from inside the input frame in [`MessageInput.svelte`](../../../../src/patches/frontend/src/lib/components/chat/MessageInput.svelte), not from inside the message body in [`ResponseMessage.svelte`](../../../../src/patches/frontend/src/lib/components/chat/Messages/ResponseMessage.svelte).
5. Confirm the REST handler in [`src/patches/backend/open_webui/routers/utils.py`](../../../../src/patches/backend/open_webui/routers/utils.py) requires `Depends(get_verified_user)` AND verifies chat ownership via `Chats.get_chat_by_id_and_user_id` before forwarding to `Gate.resolve_via_chip_click`.

**Expected:**
- All structural invariant tests pass: Yes / No / Reply buttons present with `data-test-id`, modify textarea wired to its own submit (Cmd/Ctrl+Enter sends; Escape cancels), four chip states (`pending`, `approved`, `cancelled`, `modify-submitted`) all render.
- Anchoring tests pass: chip is imported and rendered from `MessageInput.svelte`, not from `ResponseMessage.svelte`.
- REST handler tests pass: route registered, auth dependency present, chat-ownership ACL enforced, `resolve_via_chip_click` invoked with the per-hash decision.
- Pure-JS handler tests pass: approve / cancel / submitModify each POST the right body; no-op on already-resolved chips; network failure surfaces as `ok=false` in the dispatched event.
- Auto-fire scheduler tests pass: triggers exactly once when every chip is terminal; suppressed while any chip is still pending, while `generating` is true, or while a previous batch is still in flight.

**Fail indicators:**
- Renderer test fails.
- A new code path bypasses the REST endpoint and tries to dispatch from the renderer directly to an MCP backend (the dedicated endpoint is the only sanctioned chip surface).
- The REST handler skips chat-ownership verification or the auth dependency.
- A future PR re-introduces the inline-in-message-body card (the anchoring tests guard against this).

<!-- @portico:test-status:begin id=L-22 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-05-07T08:38:17.679Z
- Build: pre-beta-tmp @ 2ea7155d-dirty
- Executor: odubo
- Notes: node --test tests/test_tool_confirmation_chip.node.test.js -- 51/51 passed; pytest test_utils_router_exposes_chip_resolve_endpoint -- passed; required _toolConfirmationBatchSend rename in Chat.svelte sendMessage/sendMessageSocket
<!-- @portico:test-status:end -->

---

### L-23 — Forged / unknown confirmation token is rejected (N-012)

**Coverage:** Auto — [`tests/test_tool_confirmation_gate.py::test_unknown_token_is_rejected`](../../../../tests/test_tool_confirmation_gate.py), [`tests/test_tool_confirmation_gate.py::test_destructive_token_is_single_use`](../../../../tests/test_tool_confirmation_gate.py), [`tests/test_tool_confirmation_gate.py::test_pending_actions_are_per_chat`](../../../../tests/test_tool_confirmation_gate.py)
**Type:** Security
**Preconditions:** None.

**Steps (regression-investigation only):**
1. Run `python -m pytest tests/test_tool_confirmation_gate.py -k 'unknown_token or single_use or per_chat'`.
2. Inspect the audit log assertions to verify `gate_bypass_attempted` is the recorded event for an unknown token and `hash_mismatch` for a known token whose args drifted.

**Type:** Security

**Expected:**
- The gate refuses dispatch when:
  - the model passes a token that no pending action matches (`gate_bypass_attempted`),
  - a token from chat A is replayed against the same call shape in chat B (`gate_bypass_attempted`, per-chat isolation),
  - a token is replayed for the same call after it has already dispatched once (`gate_bypass_attempted`, single-use).

**Fail indicators:**
- Any of the above ends with `action="dispatch"`.
- No audit entry is emitted for the bypass attempt.

<!-- @portico:test-status:begin id=L-23 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-05-07T08:38:17.728Z
- Build: pre-beta-tmp @ 2ea7155d-dirty
- Executor: odubo
- Notes: pytest tests/test_tool_confirmation_gate.py -k 'unknown_token or single_use or per_chat' -- passed (within 94/94 batch)
<!-- @portico:test-status:end -->

---

### L-24 — Stacked chips resolve independently and auto-fire one batch turn (N-012)

**Coverage:** Auto — [`tests/test_tool_confirmation_gate.py`](../../../../tests/test_tool_confirmation_gate.py) (`test_resolve_via_chip_click_*`, `test_pop_resolutions_for_batch_*`, `test_middleware_wires_batch_resolution_synthesis_into_resolve`), [`tests/test_tool_confirmation_chip.node.test.js`](../../../../tests/test_tool_confirmation_chip.node.test.js) (auto-fire scheduler tests)
**Type:** Security + UX
**Preconditions:** None for the unit tests. Manual sanity needs the running app.

**Steps (regression-investigation only):**
1. Run `python -m pytest tests/test_tool_confirmation_gate.py -k 'chip_click or pop_resolutions_for_batch or batch_resolution_synthesis or three_chips_mixed'`.
2. Run `node --test tests/test_tool_confirmation_chip.node.test.js` and confirm the four `auto-fire` scheduler tests pass.
3. Manual sanity (optional, on the running app): in a single chat turn, ask the model to do **two destructive things at once**, e.g. "Send a Slack message to #ss-portico-team saying 'TEST' and DM @me saying 'hello'". You should see two stacked chips appear above the input. Click Yes on chip 1, No on chip 2 — both should commit immediately without firing a chat completion. Once both chips show their resolved state, the renderer auto-fires one chat turn; chip 1's action dispatches, chip 2 is acknowledged as cancelled. Repeat with one Yes + one Reply-with-changes ("use #different-channel") — the modify chip's textarea is per-chip and must NOT share state with the global composer.

**Expected:**
- Each chip click hits `POST /api/v1/utils/chip/resolve` and the gate updates only the targeted hash; siblings stay independently resolvable.
- The gate's `_resolutions` log accumulates one record per chip click, with `decision` ∈ {`approve`, `cancel`, `modify`} and `modify_payload` set verbatim on modify clicks.
- After every chip on screen reaches a terminal state, the renderer fires exactly ONE chat completion with `tool_confirmation_batch_send: true` in the body.
- The middleware drains the resolution log via `Gate.pop_resolutions_for_batch` and injects a `system` message bracketed by `[PORTICO-PORTICO-N-012-BATCH-RESOLUTION-START] ... -END]` describing each chip's outcome.
- Approved hashes survive the resolve call (they are NOT cleared by `consume_assistant_turn` on the batch-send path) and the model's re-emit dispatches against the cached approval.
- Modify decisions produce a fresh chip on the model's re-issue with the new args (the gate hashes the new args; the user re-confirms).
- Per-chip modify textareas are independent: typing into chip 1's modify textarea does not touch chip 2's modify textarea or the global composer.

**Fail indicators:**
- Resolving chip 1 cancels or auto-resolves chip 2 (sibling collision).
- The renderer fires more than one chat completion for a single batch (auto-fire re-entry).
- The model receives the batch turn without the synthesized system note (model re-prompts in plain text).
- Approved hashes expire before the model retries.
- A modify textarea on one chip leaks payload into another chip or into the global composer.

<!-- @portico:test-status:begin id=L-24 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-05-07T08:38:17.776Z
- Build: pre-beta-tmp @ 2ea7155d-dirty
- Executor: odubo
- Notes: pytest tests/test_tool_confirmation_gate.py + node chip test auto-fire scheduler tests -- all passed
<!-- @portico:test-status:end -->
