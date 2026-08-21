# G.4 — MCP × tool-confirmation gate integration

Three scenarios validating that the per-action confirmation gate (see [`docs/testing/plan/security/tool-confirmation-gate.md`](../security/tool-confirmation-gate.md) for the security-side coverage and [`docs/security/tool-confirmation.md`](../../../security/tool-confirmation.md) for the catalogue) plays correctly with the MCP dispatch layer: read-only tools are never gated, multi-call assistant turns each get their own card, and the registry stays in sync as new MCPs land.

- Up: [`docs/testing/plan/mcp/README.md`](README.md).
- Threats: N-012 (cross-listed with the L.6 security scenarios).

---

## Scenarios

### G-30 — Read-only MCP tools bypass the gate (N-012)

**Coverage:** Auto — [`tests/test_tool_confirmation_gate.py::test_read_only_tools_never_block`](../../../../tests/test_tool_confirmation_gate.py), [`tests/test_tool_confirmation_gate_end_to_end.py::test_read_tools_pass_through_without_user_input`](../../../../tests/test_tool_confirmation_gate_end_to_end.py)
**Type:** MCP
**Preconditions:** None.

**Steps (regression-investigation only):**
1. Run `python -m pytest tests/test_tool_confirmation_gate.py tests/test_tool_confirmation_gate_end_to_end.py -k 'read_only or read_tools_pass_through'`.
2. In the running app: ask the assistant a question that triggers `slack_conversations_search_messages`, `slack_conversations_history`, `gmail_messages_list`, or `drive_files_list`. Verify NO chip appears above the chat input and the tool answers immediately.

**Expected:**
- Each read tool returns `action="dispatch"` from the gate.
- No `proposed` audit entry is logged for these calls; only `dispatched_safe`.
- `data_plat_query_generate` (which the fallback regex would match on `_generate`) is treated as safe via the explicit `side_effect: "read"` allowlist entry.

**Fail indicators:**
- Tests fail.
- A chip appears for a read tool in manual sanity.

<!-- @portico:test-status:begin id=G-30 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### G-31 — Multi-call assistant turn surfaces one chip per destructive call and resolves as a batch (N-012)

**Coverage:** Auto — [`tests/test_tool_confirmation_gate.py`](../../../../tests/test_tool_confirmation_gate.py) (`test_multi_call_batch_each_blocks_independently`, `test_resolve_via_chip_click_three_chips_mixed_decisions`, `test_pop_resolutions_for_batch_drains_in_order_and_clears`), [`tests/test_tool_confirmation_gate_end_to_end.py::test_multi_call_batch_requires_per_call_approval`](../../../../tests/test_tool_confirmation_gate_end_to_end.py), [`tests/test_tool_confirmation_chip.node.test.js`](../../../../tests/test_tool_confirmation_chip.node.test.js)
**Type:** MCP + UX
**Preconditions:** None for unit/E2E. Manual portion needs a model that emits parallel tool calls.

**Steps (regression-investigation only):**
1. Run `python -m pytest tests/test_tool_confirmation_gate.py tests/test_tool_confirmation_gate_end_to_end.py -k 'multi_call or batch or three_chips_mixed or pop_resolutions'`.
2. Run `node --test tests/test_tool_confirmation_chip.node.test.js`.
3. Manual: ask the model "Send a Slack DM to Alice saying hi, and also email bob@example.com a status update" — a single assistant turn should produce two stacked chips above the chat input, each with its own Yes / No / Reply-with-changes buttons and a `1 / 2` count badge. Click Yes on chip 1, No on chip 2 — both should commit immediately (no chat-completion fires between them); once both chips show their resolved status, ONE chat completion fires automatically; the model dispatches the Slack DM, acknowledges the email cancellation, and returns. Repeat with one Yes + one Reply-with-changes (e.g. "use a different email subject") — the modify chip's textarea is per-chip and locked to that chip's hash.

**Expected:**
- Each pending action has its own hash; `gate.pending_for_chat(chat_id)` reflects the count.
- A bare typed "yes" with multiple pending actions is still treated as ambiguous (all pending drop, no approval is granted) — the original Slack-incident invariant survives the batched-chip rework.
- Each chip's Yes / No / Reply-with-changes hits `POST /api/v1/utils/chip/resolve` independently. `Gate.resolve_via_chip_click` records a `ResolutionRecord` per click.
- The renderer mounts one `<ToolConfirmationChip>` per hash above the chat input; clicking Yes on one does NOT approve, cancel, or block the other.
- After every chip is in a terminal state, the renderer auto-fires exactly ONE chat completion with `tool_confirmation_batch_send: true`. The middleware drains the resolution log via `Gate.pop_resolutions_for_batch` and synthesizes the per-chip system note.
- Modify clicks carry their `payload` verbatim into the synthesized note; the model's re-issue produces a fresh chip with the new args.

**Fail indicators:**
- A single approval discharges multiple pending actions.
- Clicking No on chip 2 cancels chip 1.
- The renderer collapses two chips into one.
- A bare "yes" auto-approves the first chip.
- More than one chat completion fires for a single batch.
- Approved hashes expire before the model retries on the batch turn.
- A modify textarea on one chip leaks payload into another chip or the global composer.

<!-- @portico:test-status:begin id=G-31 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### G-32 — Destructive-tool registry stays in sync with `mcp-configs/` (N-012)

**Coverage:** Manual — [`docs/security/tool-confirmation.md`](../../../security/tool-confirmation.md), [`mcp-policy/destructive-tools.json`](../../../../mcp-policy/destructive-tools.json)
**Type:** MCP
**Preconditions:** Editor access. Run during release prep or whenever a new MCP server is added.

**Steps (manual):**
1. List the MCP fragments and YAML files under `mcp-configs/` that introduce write OAuth scopes (look for `*.write`, `chat:write`, `gmail.send`, `query.execute`, `idash_workspace.write`, `GITLAB_READ_ONLY_MODE=false`, etc.).
2. For each new write capability since the previous release (see `git log mcp-configs/`), confirm:
   - A row exists for the tool in [`docs/security/tool-confirmation.md`](../../../security/tool-confirmation.md).
   - A `tool_name_glob` rule exists in [`mcp-policy/destructive-tools.json`](../../../../mcp-policy/destructive-tools.json) with a meaningful `summary_template`.
   - If the tool is a counter-example (looks destructive but is actually read-only — e.g. SQL generators that don't execute), an explicit `side_effect: "read"` rule overrides the fallback regex.
3. Run `python -m pytest tests/test_tool_confirmation_gate.py::test_registry_json_is_well_formed tests/test_tool_confirmation_gate.py::test_registry_loads_known_destructive_tools`.
4. Sanity-check the fallback regex against a few names from new MCPs: invoke `Registry.load(...).classify("<name>")` in a Python REPL; new `*_create_*`, `*_send_*`, etc. should fall back to destructive without an explicit rule.

**Expected:**
- Every write tool added since the last release has a corresponding doc row AND registry rule.
- Tests pass.
- Fallback regex still catches names you'd expect to be destructive.

**Fail indicators:**
- A new write tool ships with neither a registry rule nor coverage by the fallback regex.
- Doc and JSON disagree on the tool name or destination semantics.
- A read-only tool is being prompted for confirmation due to a missing `side_effect: "read"` exception.

<!-- @portico:test-status:begin id=G-32 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->
