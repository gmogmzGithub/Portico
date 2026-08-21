// PORTICO PATCH (N-012): smoke tests for ToolConfirmationChip.svelte and the
// Cursor-style batched-resolution flow it drives in Chat.svelte.
//
// We don't have a Svelte compiler available in this test ring, so this
// suite exercises three layers:
//
// 1. Structural invariants on the .svelte sources — guards the contract
//    the rest of the system depends on (REST resolve endpoint path,
//    button selectors, modify textarea, anchoring rules).
// 2. The pure-JS handlers we can pull out of the component as plain
//    functions, exercised under a fake fetch so we can assert the
//    button click path POSTs the right payload to the REST endpoint.
// 3. Anchoring + cleanup invariants — the chip MUST live in the chat
//    input frame (MessageInput.svelte), Chat.svelte MUST clear chips
//    on Stop / error / chat switch, and the auto-fire MUST guard
//    against re-firing while a batch is in flight.
//
// Backs scenarios L-22, L-23 (security) and G-31, G-32 (mcp) in
// docs/testing/plan/.

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const REPO_ROOT = path.resolve(__dirname, "..");
const CHIP_PATH = path.join(
  REPO_ROOT,
  "src",
  "patches",
  "frontend",
  "src",
  "lib",
  "components",
  "chat",
  "MessageInput",
  "ToolConfirmationChip.svelte",
);
const MESSAGE_INPUT_PATH = path.join(
  REPO_ROOT,
  "src",
  "patches",
  "frontend",
  "src",
  "lib",
  "components",
  "chat",
  "MessageInput.svelte",
);
const RESPONSE_MESSAGE_PATH = path.join(
  REPO_ROOT,
  "src",
  "patches",
  "frontend",
  "src",
  "lib",
  "components",
  "chat",
  "Messages",
  "ResponseMessage.svelte",
);
const CHAT_PATH = path.join(
  REPO_ROOT,
  "src",
  "patches",
  "frontend",
  "src",
  "lib",
  "components",
  "chat",
  "Chat.svelte",
);

const chipSource = fs.readFileSync(CHIP_PATH, "utf8");
const messageInputSource = fs.readFileSync(MESSAGE_INPUT_PATH, "utf8");
const responseMessageSource = fs.readFileSync(RESPONSE_MESSAGE_PATH, "utf8");
const chatSource = fs.readFileSync(CHAT_PATH, "utf8");

// ---------------------------------------------------------------------------
// Structural invariants on the chip itself (smoke layer 1)
// ---------------------------------------------------------------------------

test("chip source renders dynamic option buttons for each option in the chip's options list", () => {
  // Phase 3: the chip is now generic. Default tool-confirmation chips
  // declare three options (approve / cancel / modify), but the
  // renderer must drive button rendering off the option set rather
  // than three hardcoded buttons. Selector format is stable:
  // ``tool-confirmation-chip-option-<id>`` so the existing approve /
  // cancel / modify automation keeps working AND new option ids
  // (e.g. out-of-scope_block) get matching selectors automatically.
  assert.match(chipSource, /data-test-id=\{?`tool-confirmation-chip-option-\$\{option\.id\}`/);
  // The {#each} drives off the chip's declared options, not a fixed
  // tuple of buttons.
  assert.match(chipSource, /\{#each\s+chipOptions\b/);
  // Modify textarea selectors stay the same so existing automation
  // around the freeform path keeps working.
  assert.match(chipSource, /data-test-id="tool-confirmation-chip-modify-textarea"/);
  assert.match(chipSource, /data-test-id="tool-confirmation-chip-modify-submit"/);
  assert.match(chipSource, /data-test-id="tool-confirmation-chip-modify-cancel"/);
});

test("chip POSTs to /api/v1/utils/chip/resolve with option_id payload", () => {
  // Phase 3: the chip migrates to the generic resolve endpoint and
  // sends ``option_id`` (mandatory) + optional ``freeform_payload``.
  // The KISS prune dropped the legacy /tool-confirmation/resolve
  // wrapper; only the generic endpoint exists now, and any chip
  // kind (tool_confirmation, clarification, ...) flows through it.
  assert.match(chipSource, /\/api\/v1\/utils\/chip\/resolve/);
  assert.match(chipSource, /method:\s*['"]POST['"]/);
  assert.match(chipSource, /chat_id:\s*chatId/);
  assert.match(chipSource, /hash:\s*card\.hash/);
  assert.match(chipSource, /option_id:\s*optionId/);
  // Lock the legacy endpoint OUT — if it ever creeps back in (e.g.
  // a bad rebase), this assertion fires.
  assert.ok(
    !/\/api\/v1\/utils\/tool-confirmation\/resolve/.test(chipSource),
    "legacy /tool-confirmation/resolve should not appear in the chip component",
  );
});

test("chip carries an Authorization bearer when localStorage has a token", () => {
  // Auth must travel with the request — the resolve endpoint requires
  // get_verified_user. A missing token would 401, leaving the chip
  // stuck in pending and the user unable to confirm anything.
  assert.match(chipSource, /localStorage\.getItem\(['"]token['"]\)/);
  assert.match(chipSource, /Authorization:\s*`Bearer \$\{token\}`/);
});

test("chip routes 'modify' through the inline textarea (not an immediate POST)", () => {
  // Tool-confirmation chips keep the historical UX: clicking
  // "Reply with changes" opens an inline textarea instead of
  // resolving immediately. The textarea then POSTs the modify
  // option with freeform payload. Clarification chips don't use
  // this branch — they post directly when the user clicks an
  // option button.
  assert.match(chipSource, /option\.id === ['"]modify['"]/);
  assert.match(chipSource, /openModify\(\)/);
  // submitModify always posts the matching option id and the
  // trimmed freeform text.
  assert.match(chipSource, /postResolve\(optionId,\s*trimmed\)/);
});

test("chip exposes a separate modify textarea wired to its own submit", () => {
  // The user reported: "what if I need to modify response for both
  // chips? But I have only single chat input field." The modify
  // textarea must be rendered INSIDE the chip (per-chip closure
  // binding) so two stacked chips have two independent modify fields.
  // The textarea is conditional on ``modifyOpen`` and bound to a
  // chip-scoped variable.
  assert.match(chipSource, /\{#if modifyOpen && card\.state === ['"]pending['"]\}/);
  assert.match(chipSource, /bind:value=\{modifyText\}/);
  assert.match(chipSource, /bind:this=\{modifyTextarea\}/);
  // Cmd/Ctrl+Enter submits, Escape cancels — keep keyboard parity with
  // the global composer.
  assert.match(chipSource, /event\.metaKey \|\| event\.ctrlKey/);
  assert.match(chipSource, /event\.key === ['"]Escape['"]/);
});

test("chip renders all terminal states: pending, approved, cancelled, modify-submitted, resolved", () => {
  // Phase 3 adds the generic ``resolved`` terminal state used by
  // clarification chips so the renderer can show "Resolved: <option
  // label>" once the user picks. Tool-confirmation chips still use
  // the historical approved / cancelled / modify-submitted states.
  assert.match(chipSource, /data-state=\{card\.state\s*\?\?\s*['"]pending['"]\}/);
  assert.match(chipSource, /card\.state === ['"]approved['"]/);
  assert.match(chipSource, /card\.state === ['"]cancelled['"]/);
  assert.match(chipSource, /card\.state === ['"]modify-submitted['"]/);
  assert.match(chipSource, /card\.state === ['"]resolved['"]/);
});

test("chip header changes between tool_confirmation and clarification kinds", () => {
  // tool_confirmation chips show the MCP + tool name as a code chip
  // (the historical layout). Clarification chips show "Action needed"
  // with no tool/mcp surface (none exists for a generic question).
  assert.match(chipSource, /chipKind === ['"]clarification['"]/);
  assert.match(chipSource, /Confirm action/);
  assert.match(chipSource, /Action needed/);
});

test("chip surfaces the gate-provided summary or prompt", () => {
  // tool_confirmation: card.summary; clarification: card.prompt.
  // The chipPrompt derived view-model picks the right one.
  assert.match(chipSource, /\{chipPrompt\}/);
  assert.match(chipSource, /tool-confirmation-chip__toggle/);
});

test("chip default option set falls back to legacy approve/cancel/modify when card.options is empty", () => {
  // Backward compat: payloads from old backends that don't carry
  // options[] still render as the historical Yes / No / Reply-with-
  // changes layout. Default is computed from $i18n so labels stay
  // localizable.
  assert.match(chipSource, /defaultToolConfirmationOptions/);
  // The default set must contain all three canonical option ids in
  // the expected order so legacy automation keeps working.
  assert.match(
    chipSource,
    /id:\s*['"]approve['"][\s\S]*?id:\s*['"]cancel['"][\s\S]*?id:\s*['"]modify['"]/,
  );
});

// ---------------------------------------------------------------------------
// Anchoring invariants
// ---------------------------------------------------------------------------

test("chip is rendered from MessageInput.svelte (input frame anchor)", () => {
  // Round 4 / Issue 4 — the chip-list is now wrapped in
  // ``ChipClusterGroup`` so 6+ same-shape chips collapse into a
  // bulk-action cluster. The wrapper still mounts ToolConfirmationChip
  // internally, so the anchor invariant ("chips live inside the chat
  // input frame, not in the response stream") is preserved through the
  // wrapper component.
  assert.match(messageInputSource, /import ChipClusterGroup\b/);
  assert.match(messageInputSource, /<ChipClusterGroup\b/);
  assert.match(messageInputSource, /pendingToolConfirmations/);
  // The cluster wrapper passes the per-hash decision events straight
  // up to Chat.svelte's onToolConfirmationDecision handler — both for
  // inline chips and for bulk Approve / Cancel clicks.
  assert.match(messageInputSource, /on:decision=\{onToolConfirmationDecision\}/);
  assert.match(messageInputSource, /chatId=\{chatId\}/);
});

test("chip is NOT rendered from ResponseMessage.svelte (no inline regression)", () => {
  assert.doesNotMatch(responseMessageSource, /^\s*import\s+ToolConfirmationChip\b/m);
  assert.doesNotMatch(responseMessageSource, /^\s*import\s+ToolConfirmationCard\b/m);
  assert.doesNotMatch(responseMessageSource, /<ToolConfirmationChip\b/);
  assert.doesNotMatch(responseMessageSource, /<ToolConfirmationCard\b/);
  assert.doesNotMatch(
    responseMessageSource,
    /\{#each\s+message\.toolConfirmations\b/,
  );
});

// ---------------------------------------------------------------------------
// Chat.svelte: chip-state lifecycle, batch auto-fire, cleanup
// ---------------------------------------------------------------------------

test("Chat.svelte routes confirmation events into the chat-scoped chip list", () => {
  assert.match(chatSource, /chat:tool_confirmation/);
  assert.match(chatSource, /pendingToolConfirmations\s*=/);
  assert.doesNotMatch(chatSource, /message\.toolConfirmations\s*=/);
  assert.match(chatSource, /pendingToolConfirmations\s*=\s*\[\]/);
});

test("Chat.svelte handleToolConfirmationChipDecision flips chip state per click", () => {
  // The handler must update the local chip list to match what the
  // chip already committed to the backend via REST. It also must
  // gate auto-fire behind ``allTerminal`` and the batch-in-flight
  // flag — re-firing while a previous batch turn is still draining
  // would race with the gate's _resolutions buffer.
  assert.match(chatSource, /function handleToolConfirmationChipDecision/);
  assert.match(chatSource, /state:\s*['"]approved['"]/);
  assert.match(chatSource, /state:\s*['"]cancelled['"]/);
  assert.match(chatSource, /state:\s*['"]modify-submitted['"]/);
  assert.match(chatSource, /toolConfirmationBatchInFlight/);
  assert.match(chatSource, /allTerminal/);
});

test("Chat.svelte maps always_allow option_id to the 'approved' chip state (not modify-submitted)", () => {
  // Round 4 hotfix: the legacy ``decision`` field is empty (`''`) for
  // any option outside the historical approve/cancel/modify trio
  // (always_allow, future per-tool options, …). Branching on
  // ``decision`` falls through to the ``modify-submitted`` else-branch
  // and the chip renders as "Modify". The handler MUST branch on
  // ``option_id`` so always_allow stamps the green "Approved" badge.
  // We pin both the new branch AND the absence of the old fall-through
  // so a regression that re-introduces ``decision``-based branching
  // fails this test loudly.
  const handlerBlock = chatSource
    .split("function handleToolConfirmationChipDecision")[1]
    .split("function buildBatchResolutionUserMessage")[0];
  assert.match(
    handlerBlock,
    /optionId\s*===\s*['"]approve['"]\s*\|\|\s*optionId\s*===\s*['"]always_allow['"]/,
    "always_allow must share the approved branch with regular approve",
  );
  assert.match(
    handlerBlock,
    /optionId\s*===\s*['"]cancel['"]/,
    "cancel branch must compare against optionId, not decision",
  );
  assert.match(
    handlerBlock,
    /optionId\s*===\s*['"]modify['"]/,
    "modify branch must compare against optionId, not decision",
  );
  // Defensive: the handler must NOT fall back to a default
  // ``modify-submitted`` for unknown option ids (the old bug).
  // Verify there's no unguarded "return { ...chip, state: 'modify-submitted' }"
  // sitting at the end of the tool_confirmation branch.
  assert.doesNotMatch(
    handlerBlock,
    /\}\s*\n\s*return\s*\{\s*\.\.\.chip,\s*\n\s*state:\s*['"]modify-submitted['"]/,
    "tool-confirmation branch must not unconditionally fall through to modify-submitted",
  );
});

test("simulated handler: always_allow stamps approved (not modify-submitted)", () => {
  // Behavioural mirror of the patched handler. Ensures the source-
  // level guard above is also semantically correct: an always_allow
  // dispatch from the chip lands on state='approved' and never on
  // state='modify-submitted'.
  function applyDecision(chip, event) {
    if (chip.hash !== event.hash) return chip;
    const kind = chip.kind ?? "tool_confirmation";
    if (kind === "tool_confirmation") {
      if (
        event.option_id === "approve" ||
        event.option_id === "always_allow"
      ) {
        return { ...chip, state: "approved" };
      }
      if (event.option_id === "cancel") {
        return { ...chip, state: "cancelled" };
      }
      if (event.option_id === "modify") {
        return {
          ...chip,
          state: "modify-submitted",
          modify_payload: event.payload ?? "",
        };
      }
      return chip;
    }
    return {
      ...chip,
      state: "resolved",
      resolved_option_id: event.option_id,
      freeform_payload: event.payload ?? "",
    };
  }

  const chip = {
    hash: "h1",
    kind: "tool_confirmation",
    state: "pending",
    tool_name: "slack_conversations_add_message",
  };
  // Simulate exactly what ToolConfirmationChip.svelte dispatches when
  // the user clicks the "Always allow" button: legacy decision='' AND
  // canonical option_id='always_allow'. Pre-fix this hit the else
  // branch and got 'modify-submitted'.
  const after = applyDecision(chip, {
    hash: "h1",
    decision: "",
    option_id: "always_allow",
    ok: true,
  });
  assert.equal(after.state, "approved");
  assert.notEqual(after.state, "modify-submitted");
  assert.equal(after.modify_payload, undefined);
});

test("Chat.svelte routes clarification chips to the 'resolved' terminal state", () => {
  // Phase 3: clarification chips collapse all options to a single
  // ``resolved`` terminal state and stash the option id so the
  // renderer can show "Resolved: <option label>". The handler must
  // branch on chip.kind so tool-confirmation chips keep the legacy
  // approve/cancel/modify-submitted state machine while
  // clarification chips use the new state.
  assert.match(chatSource, /state:\s*['"]resolved['"]/);
  assert.match(chatSource, /resolved_option_id/);
  // The chip-event-ingestion path must forward the new generic chip
  // fields from the backend payload (kind / prompt / options /
  // allow_freeform) so the chip component can render proposer-
  // supplied option sets.
  assert.match(chatSource, /kind:\s*data\?\.kind === ['"]clarification['"]/);
  assert.match(chatSource, /Array\.isArray\(data\?\.options\)/);
  assert.match(chatSource, /allow_freeform/);
});

test("Chat.svelte buildBatchResolutionUserMessage describes clarification resolutions", () => {
  // Auto-fired batch turn after a clarification chip resolves must
  // surface the user's choice in chat scrollback so the model (and
  // the human operator reading the conversation) can see what was
  // selected, not a generic "Confirmed.".
  assert.match(chatSource, /Selected/);
  assert.match(chatSource, /chip\.options\?\.find/);
});

test("Chat.svelte auto-fires a batch-send chat turn when every chip is terminal", () => {
  // The whole point of the rework: the user resolves the entire
  // stack of chips, and ONE chat completion fires (not one per
  // click). The body must carry ``tool_confirmation_batch_send: true``
  // so the backend synthesizes the per-chip note for the model.
  assert.match(chatSource, /fireToolConfirmationBatchSend/);
  assert.match(chatSource, /tool_confirmation_batch_send:\s*true/);
  assert.match(chatSource, /buildBatchResolutionUserMessage/);
});

test("Chat.svelte threads the batch-send flag through submitPrompt -> sendMessage -> sendMessageSocket", () => {
  // Regression guard for the runtime ReferenceError in the screenshot:
  // ``_toolConfirmationBatchSend`` only exists in submitPrompt scope,
  // so the downstream request builder must receive the value via
  // explicit parameters instead of closing over an undefined name.
  assert.match(chatSource, /toolConfirmationBatchSend:\s*_toolConfirmationBatchSend/);
  assert.match(chatSource, /toolConfirmationBatchSend\s*=\s*false/);
  assert.match(chatSource, /sendMessageSocket\([\s\S]*toolConfirmationBatchSend\s*\)/);
  assert.doesNotMatch(chatSource, /\.\.\.\(_toolConfirmationBatchSend/);
});

test("Chat.svelte drops chips on user-stop, terminal stream error, chat switch, and successful batch turn", () => {
  // Chips are tied to a specific assistant turn. When that turn is
  // force-stopped, errored, or switched away from, leaving them
  // visible is both a UX bug and a subtle gate-bypass risk. The
  // batch-send turn ALSO clears chips — the synthesized note is now
  // in conversation history, the model is processing.
  const stopBlockMatch = chatSource.match(
    /applyImmediateStopState[\s\S]+?(?=const\s+stopTasksBestEffort|\n\t};\n)/,
  );
  assert.ok(stopBlockMatch, "could not locate applyImmediateStopState body");
  assert.match(stopBlockMatch[0], /pendingToolConfirmations\s*=\s*\[\]/);
  assert.match(stopBlockMatch[0], /toolConfirmationBatchInFlight\s*=\s*false/);

  const errorBlockMatch = chatSource.match(
    /finalizeAssistantErrorMessage\s*=\s*async[\s\S]+?(?=\n\tconst\s+handleChatRequestError|\n\t};\n)/,
  );
  assert.ok(errorBlockMatch, "could not locate finalizeAssistantErrorMessage body");
  assert.match(errorBlockMatch[0], /pendingToolConfirmations\s*=\s*\[\]/);
  assert.match(errorBlockMatch[0], /toolConfirmationBatchInFlight\s*=\s*false/);

  // Chat switch reset.
  assert.match(
    chatSource,
    /pendingToolConfirmations\s*=\s*\[\];\s*\n\s*toolConfirmationBatchInFlight\s*=\s*false;/,
  );
});

test("Chat.svelte does not retain a legacy in-band click variable", () => {
  // Regression guard against re-introducing the old single-pending click
  // path. The chip resolves via REST; nothing in Chat.svelte should hold
  // a per-hash click intent across submitPrompt invocations any more.
  // Letting this variable drift back in would re-create the
  // "approving chip 1 silently consumes chip 2" stacked-chip bug.
  assert.doesNotMatch(chatSource, /pendingToolConfirmationClick/);
  assert.doesNotMatch(chatSource, /toolConfirmationClickForRequest/);
  assert.doesNotMatch(chatSource, /tool_confirmation_click\s*:/);
});

test("Chat.svelte threads _toolConfirmationBatchSend through submitPrompt -> sendMessage -> sendMessageSocket", () => {
  // Regression guard for the "_toolConfirmationBatchSend is not defined"
  // ReferenceError that surfaced after cleanup. The flag MUST live in the
  // parameter list of every function whose body references it; otherwise
  // the closure captures nothing and the request body throws at runtime
  // (silently breaking chip auto-fire and Slack tool integration along
  // with it).
  const submitPromptDecl = chatSource.match(
    /const\s+submitPrompt\s*=\s*async\s*\([\s\S]+?\)\s*=>/,
  );
  assert.ok(submitPromptDecl, "submitPrompt declaration not found");
  assert.match(
    submitPromptDecl[0],
    /_toolConfirmationBatchSend\s*=\s*false/,
    "submitPrompt must accept _toolConfirmationBatchSend as a parameter",
  );

  const sendMessageDecl = chatSource.match(
    /const\s+sendMessage\s*=\s*async\s*\([\s\S]+?\)\s*=>/,
  );
  assert.ok(sendMessageDecl, "sendMessage declaration not found");
  assert.match(
    sendMessageDecl[0],
    /_toolConfirmationBatchSend\s*=\s*false/,
    "sendMessage must destructure _toolConfirmationBatchSend from its options",
  );

  const sendMessageSocketDecl = chatSource.match(
    /const\s+sendMessageSocket\s*=\s*async\s*\([\s\S]+?\)\s*=>/,
  );
  assert.ok(sendMessageSocketDecl, "sendMessageSocket declaration not found");
  assert.match(
    sendMessageSocketDecl[0],
    /_toolConfirmationBatchSend\s*=\s*false/,
    "sendMessageSocket must accept _toolConfirmationBatchSend as a parameter (request body uses it)",
  );

  // submitPrompt must forward to sendMessage; sendMessage must forward to
  // sendMessageSocket. Without these the param defaults to false at every
  // hop and batch resolution silently regresses to the natural-language
  // path even for legitimate auto-fired turns.
  assert.match(
    chatSource,
    /await sendMessage\(history,\s*userMessageId,\s*\{[\s\S]+?_toolConfirmationBatchSend[\s\S]*?\}\);/,
    "submitPrompt must pass _toolConfirmationBatchSend to sendMessage",
  );
  assert.match(
    chatSource,
    /await sendMessageSocket\([\s\S]+?_toolConfirmationBatchSend[\s\S]+?\);/,
    "sendMessage must pass _toolConfirmationBatchSend to sendMessageSocket",
  );
});

// ---------------------------------------------------------------------------
// Pure-JS handler (smoke layer 2): re-implement the chip's resolve path
// under a fake fetch and assert the right URL, method, and payload.
// ---------------------------------------------------------------------------

function buildChipDriver(card, opts = {}) {
  // Mirror of ToolConfirmationChip.svelte's resolve path. The driver
  // models the option-id-based REST shape the chip now uses; tests
  // can verify both default tool-confirmation chips (approve / cancel
  // / modify) AND clarification chips (caller-declared option set).
  const fetched = [];
  const dispatched = [];
  const chipKind = card.kind ?? "tool_confirmation";

  function legacyDecisionFor(optionId) {
    if (chipKind !== "tool_confirmation") return "";
    if (
      optionId === "approve" ||
      optionId === "cancel" ||
      optionId === "modify"
    ) {
      return optionId;
    }
    return "";
  }

  async function postResolve(optionId, freeformPayload) {
    const body = {
      chat_id: opts.chatId ?? "chat-xyz",
      hash: card.hash,
      option_id: optionId,
      ...(freeformPayload ? { freeform_payload: freeformPayload } : {}),
    };
    const res = {
      ok: !opts.failNetwork,
      status: opts.failNetwork ? 500 : 200,
      json: async () =>
        opts.failNetwork
          ? null
          : { ok: true, option_id: optionId, hash: card.hash },
      text: async () => "",
    };
    fetched.push({
      url: "/api/v1/utils/chip/resolve",
      method: "POST",
      body,
    });
    if (!res.ok) return false;
    const out = await res.json();
    return Boolean(out && out.ok);
  }

  async function selectOption(optionId) {
    if (card.state !== "pending") return;
    // tool-confirmation 'modify' opens the textarea in the real
    // component; the driver short-circuits to the submitModify path.
    if (chipKind === "tool_confirmation" && optionId === "modify") return;
    const ok = await postResolve(optionId);
    dispatched.push({
      decision: legacyDecisionFor(optionId),
      option_id: optionId,
      hash: card.hash,
      ok,
    });
  }

  async function approve() {
    return selectOption("approve");
  }
  async function cancel() {
    return selectOption("cancel");
  }
  async function submitModify(text) {
    const trimmed = (text || "").trim();
    if (!trimmed || card.state !== "pending") return;
    const optionId = chipKind === "tool_confirmation" ? "modify" : "freeform";
    const ok = await postResolve(optionId, trimmed);
    dispatched.push({
      decision: legacyDecisionFor(optionId),
      option_id: optionId,
      hash: card.hash,
      payload: trimmed,
      ok,
    });
  }

  return { approve, cancel, submitModify, selectOption, fetched, dispatched };
}

test("approve POSTs {chat_id, hash, option_id: approve} and dispatches success", async () => {
  const chip = buildChipDriver({ hash: "abc123", state: "pending" });
  await chip.approve();
  assert.equal(chip.fetched.length, 1);
  assert.deepEqual(chip.fetched[0], {
    url: "/api/v1/utils/chip/resolve",
    method: "POST",
    body: { chat_id: "chat-xyz", hash: "abc123", option_id: "approve" },
  });
  assert.deepEqual(chip.dispatched, [
    {
      decision: "approve",
      option_id: "approve",
      hash: "abc123",
      ok: true,
    },
  ]);
});

test("cancel POSTs option_id: cancel and never carries a freeform payload", async () => {
  const chip = buildChipDriver({ hash: "abc123", state: "pending" });
  await chip.cancel();
  assert.deepEqual(chip.fetched[0].body, {
    chat_id: "chat-xyz",
    hash: "abc123",
    option_id: "cancel",
  });
});

test("submitModify POSTs option_id: modify with freeform_payload field", async () => {
  const chip = buildChipDriver({ hash: "abc123", state: "pending" });
  await chip.submitModify("  use #different-channel  ");
  assert.deepEqual(chip.fetched[0].body, {
    chat_id: "chat-xyz",
    hash: "abc123",
    option_id: "modify",
    freeform_payload: "use #different-channel",
  });
  assert.deepEqual(chip.dispatched, [
    {
      decision: "modify",
      option_id: "modify",
      hash: "abc123",
      payload: "use #different-channel",
      ok: true,
    },
  ]);
});

test("submitModify with empty / whitespace-only payload is a no-op", async () => {
  const chip = buildChipDriver({ hash: "abc123", state: "pending" });
  await chip.submitModify("   ");
  await chip.submitModify("");
  assert.deepEqual(chip.fetched, []);
  assert.deepEqual(chip.dispatched, []);
});

test("approve / cancel / submitModify on already-resolved chip is a no-op", async () => {
  const cases = ["approved", "cancelled", "modify-submitted", "resolved"];
  for (const state of cases) {
    const chip = buildChipDriver({ hash: "abc123", state });
    await chip.approve();
    await chip.cancel();
    await chip.submitModify("hi");
    assert.deepEqual(
      chip.fetched,
      [],
      `chip in state=${state} must not POST resolves`,
    );
    assert.deepEqual(chip.dispatched, []);
  }
});

test("network failure surfaces as ok=false in the dispatched event", async () => {
  const chip = buildChipDriver(
    { hash: "abc123", state: "pending" },
    { failNetwork: true },
  );
  await chip.approve();
  assert.deepEqual(chip.dispatched, [
    {
      decision: "approve",
      option_id: "approve",
      hash: "abc123",
      ok: false,
    },
  ]);
});

test("two stacked chips POST independent decisions to the same chat", async () => {
  const chipA = buildChipDriver(
    { hash: "hash-a", state: "pending" },
    { chatId: "chat-1" },
  );
  const chipB = buildChipDriver(
    { hash: "hash-b", state: "pending" },
    { chatId: "chat-1" },
  );

  await chipA.approve();
  await chipB.cancel();

  assert.deepEqual(chipA.fetched[0].body, {
    chat_id: "chat-1",
    hash: "hash-a",
    option_id: "approve",
  });
  assert.deepEqual(chipB.fetched[0].body, {
    chat_id: "chat-1",
    hash: "hash-b",
    option_id: "cancel",
  });
  // Each click hits the REST endpoint independently — no chat
  // completion fires per click. The Chat.svelte auto-fire effect
  // is responsible for the single batch-send turn afterwards.
  assert.equal(chipA.fetched.length, 1);
  assert.equal(chipB.fetched.length, 1);
});

test("clarification chip POSTs the proposer-declared option_id without legacy decision mapping", async () => {
  // Phase 3: a clarification chip carries caller-supplied option ids
  // (e.g. out_of_scope_block / out_of_scope_approve_once /
  // out_of_scope_widen_scope) and the chip MUST send those verbatim
  // — no implicit translation into approve/cancel/modify.
  const chip = buildChipDriver({
    hash: "clar-1",
    kind: "clarification",
    state: "pending",
  });
  await chip.selectOption("out_of_scope_block");
  assert.deepEqual(chip.fetched[0].body, {
    chat_id: "chat-xyz",
    hash: "clar-1",
    option_id: "out_of_scope_block",
  });
  // Legacy decision is empty for clarifications — listeners must
  // branch on option_id.
  assert.deepEqual(chip.dispatched, [
    {
      decision: "",
      option_id: "out_of_scope_block",
      hash: "clar-1",
      ok: true,
    },
  ]);
});

test("clarification chip with allow_freeform=true posts a freeform option_id with payload", async () => {
  const chip = buildChipDriver({
    hash: "clar-2",
    kind: "clarification",
    state: "pending",
    allow_freeform: true,
  });
  await chip.submitModify("retry tomorrow at 9am");
  assert.deepEqual(chip.fetched[0].body, {
    chat_id: "chat-xyz",
    hash: "clar-2",
    option_id: "freeform",
    freeform_payload: "retry tomorrow at 9am",
  });
});

// ---------------------------------------------------------------------------
// Auto-fire scheduler: simulate the Chat.svelte handler logic
// ---------------------------------------------------------------------------

function simulateAutoFire(chips, opts = {}) {
  // Mirror of handleToolConfirmationChipDecision in Chat.svelte. We
  // only model the auto-fire branch — terminating-state mutation is
  // tested separately via the structural assertions.
  let toolConfirmationBatchInFlight = opts.batchInFlight ?? false;
  const generating = opts.generating ?? false;
  const fired = [];

  function handleDecision() {
    if (chips.length === 0 || toolConfirmationBatchInFlight || generating) {
      return;
    }
    const allTerminal = chips.every((c) => c.state !== "pending");
    if (allTerminal) {
      toolConfirmationBatchInFlight = true;
      fired.push(true);
    }
  }

  for (let i = 0; i < chips.length; i++) {
    handleDecision();
  }
  return { fired: fired.length, batchInFlight: toolConfirmationBatchInFlight };
}

test("auto-fire triggers exactly once when all chips reach a terminal state", () => {
  const chips = [
    { state: "approved", hash: "a" },
    { state: "cancelled", hash: "b" },
    { state: "modify-submitted", hash: "c" },
  ];
  const result = simulateAutoFire(chips);
  assert.equal(result.fired, 1);
  assert.equal(result.batchInFlight, true);
});

test("auto-fire does NOT trigger while any chip is still pending", () => {
  const chips = [
    { state: "approved", hash: "a" },
    { state: "pending", hash: "b" },
  ];
  const result = simulateAutoFire(chips);
  assert.equal(result.fired, 0);
});

test("auto-fire does NOT trigger when a previous batch is still in flight", () => {
  const chips = [
    { state: "approved", hash: "a" },
    { state: "approved", hash: "b" },
  ];
  const result = simulateAutoFire(chips, { batchInFlight: true });
  assert.equal(result.fired, 0);
});

test("auto-fire does NOT trigger while generating is true", () => {
  const chips = [
    { state: "approved", hash: "a" },
    { state: "approved", hash: "b" },
  ];
  const result = simulateAutoFire(chips, { generating: true });
  assert.equal(result.fired, 0);
});

// ---------------------------------------------------------------------------
// Reactive watcher: catches the case where a chip is approved while the
// assistant is still streaming, so the click-time auto-fire is skipped.
// Without the $: watcher, the chip stays orphaned in 'approved' state
// forever and the backend approval is never drained.
// ---------------------------------------------------------------------------

test("Chat.svelte has a reactive watcher that re-fires batch-send when generating flips false", () => {
  const path = require("path").join(
    __dirname,
    "..",
    "src",
    "patches",
    "frontend",
    "src",
    "lib",
    "components",
    "chat",
    "Chat.svelte",
  );
  const source = require("fs").readFileSync(path, "utf8");

  // Look for the four conjuncts that gate the reactive auto-fire retry.
  // We assert on the textual presence of all guards so a future refactor
  // can't silently drop one and re-introduce the orphan-chip regression.
  const watcher = source.match(
    /\$:\s*if\s*\(\s*!generating\s*&&[\s\S]{0,400}?fireToolConfirmationBatchSend\(\)/,
  );
  assert.ok(
    watcher,
    "Chat.svelte must contain a `$:` reactive watcher that calls fireToolConfirmationBatchSend when !generating",
  );
  const block = watcher[0];
  assert.match(block, /pendingToolConfirmations\.length\s*>\s*0/);
  assert.match(block, /!toolConfirmationBatchInFlight/);
  assert.match(block, /every\(\(chip\)\s*=>\s*chip\.state\s*!==\s*'pending'\)/);
});

function simulateGeneratingTransition({ chips, generatingThenIdle }) {
  // Models the reactive watcher: at first generating=true, then flips
  // false. Returns whether the watcher fired the batch-send exactly once
  // across the transition.
  let toolConfirmationBatchInFlight = false;
  const fired = [];

  function watcherTick(generating) {
    if (
      !generating &&
      chips.length > 0 &&
      !toolConfirmationBatchInFlight &&
      chips.every((c) => c.state !== "pending")
    ) {
      toolConfirmationBatchInFlight = true;
      fired.push(true);
    }
  }

  for (const generating of generatingThenIdle) {
    watcherTick(generating);
  }
  return { fired: fired.length, batchInFlight: toolConfirmationBatchInFlight };
}

test("reactive watcher fires once after generating transitions true→false with all chips terminal", () => {
  const chips = [{ state: "approved", hash: "a" }];
  const result = simulateGeneratingTransition({
    chips,
    generatingThenIdle: [true, true, false],
  });
  assert.equal(result.fired, 1);
  assert.equal(result.batchInFlight, true);
});

test("reactive watcher does not fire if a chip is still pending after generating ends", () => {
  const chips = [
    { state: "approved", hash: "a" },
    { state: "pending", hash: "b" },
  ];
  const result = simulateGeneratingTransition({
    chips,
    generatingThenIdle: [true, false],
  });
  assert.equal(result.fired, 0);
});

test("reactive watcher does not double-fire if a batch is already in flight", () => {
  // Simulate the case where the click-time path already kicked the
  // batch (batchInFlight=true). The watcher must respect the guard.
  const chips = [{ state: "approved", hash: "a" }];
  let toolConfirmationBatchInFlight = true;
  const fired = [];
  function watcherTick(generating) {
    if (
      !generating &&
      chips.length > 0 &&
      !toolConfirmationBatchInFlight &&
      chips.every((c) => c.state !== "pending")
    ) {
      toolConfirmationBatchInFlight = true;
      fired.push(true);
    }
  }
  watcherTick(false);
  assert.equal(fired.length, 0);
});

// ---------------------------------------------------------------------------
// Round 4 / Issue 4 — chip clustering and bulk approve / cancel
// ---------------------------------------------------------------------------

// chipClusters.js is consumed by the Svelte/Vite build as native
// ESM (the OWUI frontend package.json declares ``"type": "module"``).
// Node-side ``require()`` of an ESM file would throw
// ``ERR_REQUIRE_ESM`` at module load time, so we bridge with a
// dynamic ``import(...)`` inside a ``before`` hook and stash the
// named exports in module-scoped ``let``s. This keeps every individual
// test body synchronous while satisfying the runtime's CJS/ESM rules.
let CHIP_CLUSTER_COLLAPSE_THRESHOLD_DEFAULT;
let clusterPendingChips;
let pendingChipsInCluster;
test.before(async () => {
  const mod = await import(
    "../src/patches/frontend/src/lib/components/chat/MessageInput/chipClusters.js"
  );
  CHIP_CLUSTER_COLLAPSE_THRESHOLD_DEFAULT = mod.CHIP_CLUSTER_COLLAPSE_THRESHOLD_DEFAULT;
  clusterPendingChips = mod.clusterPendingChips;
  pendingChipsInCluster = mod.pendingChipsInCluster;
});

const CLUSTER_GROUP_PATH = path.join(
  REPO_ROOT,
  "src",
  "patches",
  "frontend",
  "src",
  "lib",
  "components",
  "chat",
  "MessageInput",
  "ChipClusterGroup.svelte",
);
const clusterGroupSource = fs.readFileSync(CLUSTER_GROUP_PATH, "utf8");

test("chip cluster threshold is six (anything fewer renders inline)", () => {
  // Six is the inflection point the user agreed to during planning:
  // "if I asked to remove 100 tasks". Five chips still feel manageable
  // as a vertical stack; six and above benefit from collapse + bulk
  // actions. The constant lives in the helper so a future tuning
  // doesn't require chasing it across components.
  assert.equal(CHIP_CLUSTER_COLLAPSE_THRESHOLD_DEFAULT, 6);
});

test("clusterPendingChips groups chips by (tool_name, mcp) preserving insertion order", () => {
  const chips = [
    { hash: "h1", tool_name: "slack_post", mcp: "slack" },
    { hash: "h2", tool_name: "gmail_send", mcp: "gmail" },
    { hash: "h3", tool_name: "slack_post", mcp: "slack" },
    { hash: "h4", tool_name: "gmail_send", mcp: "gmail" },
  ];
  const clusters = clusterPendingChips(chips);
  assert.equal(clusters.length, 2);
  assert.equal(clusters[0].tool_name, "slack_post");
  assert.equal(clusters[0].chips.length, 2);
  assert.equal(clusters[1].tool_name, "gmail_send");
  assert.equal(clusters[1].chips.length, 2);
  // Smaller-than-threshold clusters are not collapsible — they
  // render inline as before to preserve the historical UX.
  assert.equal(clusters[0].is_collapsible, false);
  assert.equal(clusters[1].is_collapsible, false);
});

test("clusterPendingChips marks clusters of six or more as collapsible", () => {
  const chips = Array.from({ length: 6 }, (_, i) => ({
    hash: `h${i}`,
    tool_name: "scheduling_delete_task",
    mcp: "scheduling",
  }));
  const [cluster] = clusterPendingChips(chips);
  assert.equal(cluster.chips.length, 6);
  assert.equal(cluster.is_collapsible, true);
});

test("clusterPendingChips threshold is configurable for tests", () => {
  const chips = Array.from({ length: 3 }, (_, i) => ({
    hash: `h${i}`,
    tool_name: "x",
    mcp: "y",
  }));
  const clusters = clusterPendingChips(chips, 3);
  assert.equal(clusters[0].is_collapsible, true);
});

test("clusterPendingChips tolerates missing tool_name / mcp without crashing", () => {
  const chips = [
    { hash: "h1" },
    { hash: "h2", tool_name: "slack_post" },
    { hash: "h3", mcp: "slack" },
  ];
  const clusters = clusterPendingChips(chips);
  // 3 distinct buckets: ("","" ), ("slack_post",""), ("","slack").
  assert.equal(clusters.length, 3);
});

test("clusterPendingChips returns [] for non-array inputs (defensive)", () => {
  assert.deepEqual(clusterPendingChips(null), []);
  assert.deepEqual(clusterPendingChips(undefined), []);
  assert.deepEqual(clusterPendingChips({} /* not array */), []);
});

test("pendingChipsInCluster filters out resolved chips so bulk-approve does not clobber prior decisions", () => {
  const cluster = {
    chips: [
      { hash: "h1", state: "pending" },
      { hash: "h2", state: "approved" },
      { hash: "h3" /* default == pending */ },
      { hash: "h4", state: "cancelled" },
    ],
  };
  const pending = pendingChipsInCluster(cluster);
  assert.deepEqual(
    pending.map((c) => c.hash),
    ["h1", "h3"],
  );
});

test("ChipClusterGroup component renders both bulk-approve and bulk-cancel buttons", () => {
  // Structural assertion: the wrapper MUST expose two bulk-action
  // selectors so automation can drive a "yes for all" / "no for all"
  // flow once the cluster is expanded. Selectors are stable
  // ``chip-cluster-approve-all`` / ``chip-cluster-cancel-all`` so a
  // future refactor can't silently break the e2e contract.
  assert.match(clusterGroupSource, /data-test-id="chip-cluster-approve-all"/);
  assert.match(clusterGroupSource, /data-test-id="chip-cluster-cancel-all"/);
  // Toggle button selector for expand/collapse.
  assert.match(clusterGroupSource, /data-test-id="chip-cluster-toggle"/);
});

test("ChipClusterGroup hides bulk actions until the cluster is expanded", () => {
  // Bulk-approve must NOT be reachable while the cluster is
  // collapsed. The user agreed during planning that bulk approval is
  // only safe AFTER they've seen the individual chips. This is
  // enforced structurally: the bulk-action row sits inside the
  // ``{#if clusterIsExpanded(...)}`` branch.
  // We assert the bulk-action selectors only exist inside an
  // ``{#if`` block, not at the top level of each cluster.
  const bulkApproveIdx = clusterGroupSource.indexOf(
    'data-test-id="chip-cluster-approve-all"',
  );
  assert.ok(bulkApproveIdx >= 0, "bulk-approve selector missing");
  // Walk backwards looking for ``{#if`` before the next ``{:else}`` /
  // ``{/if}`` token. If we find an opening ``{#if`` first the bulk
  // row is gated; if we find a closing first the bulk row leaks out.
  const before = clusterGroupSource.slice(0, bulkApproveIdx);
  const lastIfIdx = before.lastIndexOf("{#if ");
  const lastEndifIdx = before.lastIndexOf("{/if}");
  assert.ok(
    lastIfIdx > lastEndifIdx,
    "bulk-action row must live inside an {#if} branch (the cluster expansion guard); got it outside any {#if}",
  );
});

test("ChipClusterGroup renders the inline ToolConfirmationChip path for non-collapsible clusters", () => {
  // The {#each cluster.chips} fallback for the non-collapsible
  // branch must keep rendering ToolConfirmationChip so the historical
  // 1-5 chip stack still works. Without this branch the user with 3
  // pending chips would see a confusing "Action group" header for
  // each chip.
  assert.match(clusterGroupSource, /\{:else\}\s*\{#each\s+cluster\.chips/);
});

test("ChipClusterGroup forwards the on:decision event up to MessageInput unchanged", () => {
  // ToolConfirmationChip emits a ``decision`` CustomEvent that the
  // parent MessageInput passes to ``onToolConfirmationDecision``.
  // The cluster wrapper sits BETWEEN them, so it must propagate the
  // event verbatim — both for inline chips (per-chip click) and for
  // bulk actions (one event per pending chip in the cluster).
  // ``on:decision`` (no handler) re-fires the child event up the
  // parent chain.
  assert.match(clusterGroupSource, /on:decision\b/);
  // For bulk actions, the dispatcher must emit one ``decision``
  // event per pending chip — verify by structurally checking the
  // bulkResolve helper iterates over ``pendingChipsInCluster``.
  assert.match(clusterGroupSource, /pendingChipsInCluster\(/);
  assert.match(clusterGroupSource, /dispatch\(['"]decision['"]/);
});

test("MessageInput.svelte uses ChipClusterGroup wrapper instead of looping chips directly", () => {
  // Round 4 regression guard: a future refactor that drops the
  // wrapper and falls back to the {#each pendingToolConfirmations}
  // pattern would silently re-introduce the "delete 100 tasks" UX
  // bug. Pin the wrapper presence + import.
  assert.match(messageInputSource, /import\s+ChipClusterGroup\s+from/);
  assert.match(
    messageInputSource,
    /<ChipClusterGroup[\s\S]*?chips=\{pendingToolConfirmations\}/,
  );
});
