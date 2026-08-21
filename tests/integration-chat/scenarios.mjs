// Scenario definitions + assertions for the Tier-2 headless repro suite.
//
// Each scenario drives a REAL chat through the isolated OWUI+gateway stack
// against the scripted mock Bedrock upstream, then evaluates invariants over
// the mock's /bedrock/converse request log (the primary assertion surface)
// and the persisted chat document.
//
// Invariant kinds:
//   "defect"  — the documented defect signature. Failing => scenario is RED.
//   "harness" — plumbing guarantees (loop completed, tools executed, no 5xx,
//               steer actually consumed, ...). Failing => scenario is ERROR,
//               never an acceptable red.
//
// observed: "green" (all ok) | "red" (defect invariant failed, harness ok)
//         | "error" (harness failed)

import { sleep, waitFor } from "./driver/api.mjs";
import { analyzeBedrockPayload, toolResultContentForId } from "./driver/mock.mjs";

const BIGFETCH_MARKER_END = "END_OF_BIGFETCH_MARKER"; // keep in sync with mock-bedrock/server.mjs
const TRUNCATION_MARKER = "truncated_tool_result"; // middleware.py _compact_tool_result_for_internal_replay

function inv(name, kind, ok, detail) {
  return { name, kind, ok: Boolean(ok), detail };
}

function classify(invariants) {
  if (invariants.some((i) => i.kind === "harness" && !i.ok)) return "error";
  return invariants.some((i) => i.kind === "defect" && !i.ok) ? "red" : "green";
}

function thinkingTurn(text, toolName, args, extra = {}) {
  return {
    thinking: { text: `Thinking about ${text}` },
    text: `Working on ${text}.`,
    tool_calls: toolName ? [{ name: toolName, args }] : undefined,
    stop: toolName ? "tool_use" : "end_turn",
    ...extra,
  };
}

function preSteerToolUseIds(state, steerGateTurnIndex) {
  return (state.emittedTurns || [])
    .filter(
      (t) =>
        t.turnIndex !== null &&
        t.turnIndex <= steerGateTurnIndex &&
        (t.toolUseIds || []).length > 0
    )
    .flatMap((t) => t.toolUseIds);
}

function computeReasoningEcho(state, request) {
  // For a followup request, every PRIOR tool turn's assistant message must
  // carry a reasoningContent block (byte-equal signature) BEFORE its toolUse.
  const analysis = analyzeBedrockPayload(request.payload);
  const priorToolTurns = (state.emittedTurns || []).filter(
    (t) =>
      t.turnIndex !== null &&
      request.turnIndex !== null &&
      t.turnIndex < request.turnIndex &&
      (t.toolUseIds || []).length > 0 &&
      t.thinking
  );
  let matched = 0;
  const details = [];
  for (const turn of priorToolTurns) {
    const toolUseId = turn.toolUseIds[0];
    const assistantTurn = analysis.assistantTurns.find((a) =>
      a.toolUse.some((tu) => tu.id === toolUseId)
    );
    if (!assistantTurn) {
      details.push({ toolUseId, found: false, reason: "assistant toolUse turn missing from payload" });
      continue;
    }
    const toolUseBlock = assistantTurn.toolUse.find((tu) => tu.id === toolUseId);
    const echo = assistantTurn.reasoning.find(
      (r) => r.signature === turn.thinking.signature && r.blockIndex < toolUseBlock.blockIndex
    );
    if (echo) {
      matched += 1;
      details.push({ toolUseId, found: true });
    } else {
      details.push({
        toolUseId,
        found: false,
        reason:
          assistantTurn.reasoning.length === 0
            ? "no reasoningContent blocks on assistant turn"
            : "reasoningContent present but signature/order mismatch",
        expectedSignature: turn.thinking.signature,
        reasoningSeen: assistantTurn.reasoning,
      });
    }
  }
  return { expected: priorToolTurns.length, matched, details };
}

function buildRounds(state, { steerText = null, preSteerIds = null, withEcho = false } = {}) {
  return (state.requests || []).map((request) => {
    const analysis = analyzeBedrockPayload(request.payload);
    const round = {
      index: request.index,
      turnIndex: request.turnIndex,
      overrun: request.overrun,
      messageCount: analysis.messageCount,
      reasoningBlockCount: analysis.reasoningBlockCount,
      steerPresent: steerText ? analysis.flat.includes(steerText) : null,
      priorToolIdsPresent:
        preSteerIds && preSteerIds.length
          ? preSteerIds.every(
              (id) => analysis.toolUseIds.includes(id) && analysis.toolResultIds.includes(id)
            )
          : null,
      reasoningSignatureEcho: null,
    };
    if (withEcho) {
      const echo = computeReasoningEcho(state, request);
      round.reasoningSignatureEcho = `${echo.matched}/${echo.expected}`;
      round._echoDetails = echo.details;
    }
    return round;
  });
}

// ---------------------------------------------------------------------------
// Shared drive loop
// ---------------------------------------------------------------------------

export async function runScriptedChat(ctx, { name, turns, prompt, toolIds, gateHooks = {}, timeoutMs = 150000 }) {
  const { api, mock, modelId, log } = ctx;
  await mock.setScenario(name, turns);
  const chat = await api.createChat({ modelId, prompt, title: name });
  log(`  chat ${chat.chatId} created; dispatching completion`);
  const taskId = await api.dispatchCompletion({
    modelId,
    chatId: chat.chatId,
    messages: [{ role: "user", content: prompt }],
    userMessage: chat.userMessage,
    assistantMessageId: chat.assistantMessage.id,
    toolIds,
  });
  log(`  task ${taskId} started`);

  const firedGates = new Set();
  const start = Date.now();
  let completed = false;
  let stopRequested = false;

  while (Date.now() - start < timeoutMs) {
    const state = await mock.requests(name);
    if (state.gatePending !== null && !firedGates.has(state.gatePending)) {
      firedGates.add(state.gatePending);
      const hook = gateHooks[state.gatePending];
      let hookResult = {};
      if (hook) {
        log(`  gate open at turn ${state.gatePending}; running hook`);
        hookResult = (await hook({ taskId, chat, state, ctx })) || {};
      }
      await mock.release(name);
      if (hookResult.stopped) stopRequested = true;
      continue;
    }

    const status = await api.getChatStatus(chat.chatId);
    if (status.busy === false && state.gatePending === null) {
      if (state.cursor >= turns.length && !stopRequested) {
        completed = true;
        break;
      }
      // Stopped or short-circuited runs: settle when the request log is stable.
      await sleep(1500);
      const again = await mock.requests(name);
      if (again.requests.length === state.requests.length && again.gatePending === null) {
        completed = true;
        break;
      }
    }
    await sleep(400);
  }

  const state = await mock.requests(name);
  const chatDoc = await api.getChat(chat.chatId);
  return { chat, taskId, state, chatDoc, completed, stopRequested };
}

function harnessBasics({ ctx, state, completed, expectedRequests }) {
  const checks = [
    inv(
      "loop-completed",
      "harness",
      completed,
      completed ? "drive loop reached a settled state" : "drive loop timed out"
    ),
    inv(
      "no-mock-overrun",
      "harness",
      (state.overruns || 0) === 0,
      `overruns=${state.overruns}`
    ),
    inv(
      "no-owui-5xx",
      "harness",
      ctx.api.fiveHundreds().length === 0,
      JSON.stringify(ctx.api.fiveHundreds())
    ),
  ];
  if (expectedRequests != null) {
    checks.push(
      inv(
        "expected-request-count",
        "harness",
        state.requests.length === expectedRequests,
        `expected ${expectedRequests} /bedrock/converse requests, saw ${state.requests.length}`
      )
    );
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

export function buildScenarios() {
  const scenarios = [];

  // ------------------------------------------------------------------ S-0
  // Harness smoke: one scripted end_turn completion flows OWUI -> gateway ->
  // mock and the reply lands in the persisted chat. All invariants are
  // harness-class: any failure is an ERROR (bad harness), never a "red".
  scenarios.push({
    name: "S-0-smoke-end-turn",
    defect: "none (harness smoke)",
    expected: "green",
    async run(ctx) {
      const replyText = "SMOKE_REPLY_OK: the mock upstream answered.";
      const turns = [{ text: replyText, stop: "end_turn" }];
      const result = await runScriptedChat(ctx, {
        name: this.name,
        turns,
        prompt: "S-0: say hello.",
        toolIds: [],
      });
      const { state, chatDoc, completed } = result;
      const rounds = buildRounds(state, {});
      const historyMessages = chatDoc?.chat?.history?.messages || {};
      const assistantNodes = Object.values(historyMessages).filter(
        (m) => m?.role === "assistant"
      );
      const replyLanded = assistantNodes.some((m) =>
        String(m?.content || "").includes(replyText)
      );
      const invariants = [
        ...harnessBasics({ ctx, state, completed, expectedRequests: 1 }),
        inv(
          "assistant-reply-persisted",
          "harness",
          replyLanded,
          replyLanded
            ? "scripted reply found in persisted chat"
            : `assistant contents: ${JSON.stringify(assistantNodes.map((m) => m.content))}`
        ),
      ];
      return { rounds, invariants, extra: { chatId: result.chat.chatId } };
    },
  });

  // ------------------------------------------------------------------ B-I1
  scenarios.push({
    name: "B-I1-steer-seam",
    defect: "B (steer seam loss on tool_calls followup rebuild)",
    expected: "green",
    async run(ctx) {
      const steerText = "STEER-B1: ALSO include competitor pricing in the final summary.";
      const steerGateTurn = 1; // steer lands while turn 1 (round 2) is gated
      const turns = [
        thinkingTurn("round 1", "mock_lookup", { q: "round-1" }),
        thinkingTurn("round 2", "mock_lookup", { q: "round-2" }, { gate: true }),
        thinkingTurn("round 3", "mock_lookup", { q: "round-3" }),
        thinkingTurn("round 4", "mock_lookup", { q: "round-4" }),
        { text: "Final answer after five rounds.", stop: "end_turn" },
      ];
      const result = await runScriptedChat(ctx, {
        name: this.name,
        turns,
        prompt: "B-I1: research the topic thoroughly using your tools.",
        toolIds: ["server:web-tools"],
        gateHooks: {
          [steerGateTurn]: async ({ chat }) => {
            await ctx.api.putPendingSteer(chat.chatId, {
              prompt: steerText,
              modelId: ctx.modelId,
            });
            await waitFor(
              async () => (await ctx.api.getChatStatus(chat.chatId)).has_pending_steer,
              { timeoutMs: 10000, desc: "pending steer visible in chat status" }
            );
          },
        },
      });

      const { state, chatDoc, completed } = result;
      const preIds = preSteerToolUseIds(state, steerGateTurn);
      const rounds = buildRounds(state, { steerText, preSteerIds: preIds });

      const steerIntroducedAt = rounds.findIndex((r) => r.steerPresent);
      const postSteer = steerIntroducedAt >= 0 ? rounds.slice(steerIntroducedAt) : [];
      const countDrops = rounds
        .slice(1)
        .filter((r, i) => r.messageCount < rounds[i].messageCount)
        .map((r) => `req${r.index}:${rounds[r.index - 1].messageCount}->${r.messageCount}`);

      const historyMessages = chatDoc?.chat?.history?.messages || {};
      const userNodes = Object.values(historyMessages).filter((m) => m?.role === "user");
      const steerNodes = userNodes.filter((m) => String(m?.content || "").includes(steerText));

      const invariants = [
        ...harnessBasics({ ctx, state, completed, expectedRequests: turns.length }),
        inv(
          "steer-was-consumed-mid-turn",
          "harness",
          steerIntroducedAt >= 0,
          steerIntroducedAt >= 0
            ? `steer first appeared in request ${steerIntroducedAt}`
            : "steer text never reached any model payload"
        ),
        inv(
          "message-counts-non-decreasing",
          "defect",
          countDrops.length === 0,
          countDrops.length ? `count drops: ${countDrops.join(", ")}` : "monotonic"
        ),
        inv(
          "steer-present-in-every-post-steer-request",
          "defect",
          postSteer.length > 0 && postSteer.every((r) => r.steerPresent),
          `post-steer presence: [${postSteer.map((r) => `req${r.index}=${r.steerPresent}`).join(", ")}]`
        ),
        inv(
          "pre-steer-tool-pairs-present-post-steer",
          "defect",
          postSteer.length > 0 && postSteer.every((r) => r.priorToolIdsPresent),
          `pre-steer ids ${JSON.stringify(preIds)}; presence: [${postSteer
            .map((r) => `req${r.index}=${r.priorToolIdsPresent}`)
            .join(", ")}]`
        ),
        inv(
          "exactly-one-outer-rollover",
          "defect",
          userNodes.length === 2 && steerNodes.length === 1,
          `user nodes=${userNodes.length}, steer nodes=${steerNodes.length} (expect 2/1: original + promoted steer)`
        ),
      ];

      return { rounds, invariants, extra: { steerIntroducedAt, preSteerIds: preIds } };
    },
  });

  // ------------------------------------------------------------------ B-I2
  scenarios.push({
    name: "B-I2-stream-continue-steer",
    defect: "B (steer seam loss on stream_continue/length seam)",
    expected: "green",
    async run(ctx) {
      const steerText = "STEER-B2: switch the report format to a bulleted list.";
      const steerGateTurn = 1;
      const turns = [
        thinkingTurn("round 1", "mock_lookup", { q: "continue-1" }),
        {
          thinking: { text: "Thinking about the long summary" },
          text: "This summary is getting long and will be cut ",
          stop: "max_tokens",
          gate: true,
        },
        thinkingTurn("round 3", "mock_lookup", { q: "continue-3" }),
        { text: "Finished after the continuation.", stop: "end_turn" },
      ];
      const result = await runScriptedChat(ctx, {
        name: this.name,
        turns,
        prompt: "B-I2: write a very long report using your tools.",
        toolIds: ["server:web-tools"],
        gateHooks: {
          [steerGateTurn]: async ({ chat }) => {
            await ctx.api.putPendingSteer(chat.chatId, {
              prompt: steerText,
              modelId: ctx.modelId,
            });
            await waitFor(
              async () => (await ctx.api.getChatStatus(chat.chatId)).has_pending_steer,
              { timeoutMs: 10000, desc: "pending steer visible in chat status" }
            );
          },
        },
      });

      const { state, chatDoc, completed } = result;
      const preIds = preSteerToolUseIds(state, steerGateTurn);
      const rounds = buildRounds(state, { steerText, preSteerIds: preIds });
      const steerIntroducedAt = rounds.findIndex((r) => r.steerPresent);
      const postSteer = steerIntroducedAt >= 0 ? rounds.slice(steerIntroducedAt) : [];
      const countDrops = rounds
        .slice(1)
        .filter((r, i) => r.messageCount < rounds[i].messageCount)
        .map((r) => `req${r.index}:${rounds[r.index - 1].messageCount}->${r.messageCount}`);

      const historyMessages = chatDoc?.chat?.history?.messages || {};
      const userNodes = Object.values(historyMessages).filter((m) => m?.role === "user");
      const steerNodes = userNodes.filter((m) => String(m?.content || "").includes(steerText));

      const invariants = [
        ...harnessBasics({ ctx, state, completed, expectedRequests: turns.length }),
        inv(
          "steer-was-consumed-mid-turn",
          "harness",
          steerIntroducedAt >= 0,
          steerIntroducedAt >= 0
            ? `steer first appeared in request ${steerIntroducedAt}`
            : "steer text never reached any model payload"
        ),
        inv(
          "message-counts-non-decreasing",
          "defect",
          countDrops.length === 0,
          countDrops.length ? `count drops: ${countDrops.join(", ")}` : "monotonic"
        ),
        inv(
          "steer-present-in-every-post-steer-request",
          "defect",
          postSteer.length > 0 && postSteer.every((r) => r.steerPresent),
          `post-steer presence: [${postSteer.map((r) => `req${r.index}=${r.steerPresent}`).join(", ")}]`
        ),
        inv(
          "pre-steer-tool-pairs-present-post-steer",
          "defect",
          postSteer.length > 0 && postSteer.every((r) => r.priorToolIdsPresent),
          `pre-steer ids ${JSON.stringify(preIds)}; presence: [${postSteer
            .map((r) => `req${r.index}=${r.priorToolIdsPresent}`)
            .join(", ")}]`
        ),
        inv(
          "exactly-one-outer-rollover",
          "defect",
          userNodes.length === 2 && steerNodes.length === 1,
          `user nodes=${userNodes.length}, steer nodes=${steerNodes.length}`
        ),
      ];

      return { rounds, invariants, extra: { steerIntroducedAt, preSteerIds: preIds } };
    },
  });

  // ------------------------------------------------------------------ B-I3
  scenarios.push({
    name: "B-I3-true-stop-then-new-completion",
    defect: "B control: a true stop must not leak old-turn followups",
    expected: "green",
    async run(ctx) {
      const { api, mock, modelId, log } = ctx;
      const correction = "CORRECTION-B3: the stop was intentional; summarize what you had.";
      const firstPrompt = "B-I3: start a long research task.";
      const turns = [
        thinkingTurn("round 1", "mock_lookup", { q: "stop-1" }),
        thinkingTurn("round 2", "mock_lookup", { q: "stop-2" }, { gate: true }),
        { text: "Corrected summary delivered.", stop: "end_turn" },
      ];

      let stopAck = null;
      const result = await runScriptedChat(ctx, {
        name: this.name,
        turns,
        prompt: firstPrompt,
        toolIds: ["server:web-tools"],
        gateHooks: {
          1: async ({ taskId }) => {
            const res = await api.stopTask(taskId);
            stopAck = res;
            log(`  stop ack: HTTP ${res.status} ${JSON.stringify(res.json)}`);
            return { stopped: true };
          },
        },
      });

      const { chat, state: stateAfterStop, completed } = result;

      // Post-stop silence window: no further /bedrock/converse traffic for the
      // stopped turn may arrive after the acknowledgment.
      await sleep(4000);
      const silent = await mock.requests(this.name);
      const requestsAfterStop = silent.requests.length;

      // New completion: interrupted turn + correction, the way the frontend
      // would resend (prior user turn, partial assistant content, new user turn).
      const chatDoc1 = await api.getChat(chat.chatId);
      const assistantNode =
        chatDoc1?.chat?.history?.messages?.[chat.assistantMessage.id] || {};
      const partialAssistantContent = String(assistantNode.content || "");
      const { userMessage: user2, assistantMessage: assistant2 } = api.buildTurnNodes({
        modelId,
        prompt: correction,
        parentId: chat.assistantMessage.id,
      });
      const messages = [
        { role: "user", content: firstPrompt },
        ...(partialAssistantContent
          ? [{ role: "assistant", content: partialAssistantContent }]
          : []),
        { role: "user", content: correction },
      ];
      await api.dispatchCompletion({
        modelId,
        chatId: chat.chatId,
        messages,
        userMessage: user2,
        assistantMessageId: assistant2.id,
        toolIds: ["server:web-tools"],
      });
      await api.waitForIdle(chat.chatId, { desc: "second completion idle" });
      await sleep(1000);

      const state = await mock.requests(this.name);
      const rounds = buildRounds(state, {});
      const newRequests = state.requests.slice(requestsAfterStop);
      const newFlat = newRequests.map((r) => JSON.stringify(r.payload));

      const invariants = [
        ...harnessBasics({ ctx, state, completed, expectedRequests: null }),
        inv(
          "stop-acknowledged",
          "harness",
          stopAck && stopAck.status === 200,
          `stop response: ${JSON.stringify(stopAck)}`
        ),
        inv(
          "no-old-turn-requests-after-stop",
          "defect",
          requestsAfterStop === stateAfterStop.requests.length && requestsAfterStop === 2,
          `requests at stop=${stateAfterStop.requests.length}, after 4s silence window=${requestsAfterStop}`
        ),
        inv(
          "new-completion-dispatched",
          "harness",
          newRequests.length >= 1,
          `new-completion requests: ${newRequests.length}`
        ),
        inv(
          "new-completion-contains-interrupted-turn-and-correction",
          "defect",
          newFlat.length > 0 &&
            newFlat.every((flat) => flat.includes(correction) && flat.includes(firstPrompt)),
          `correction+first-prompt present in all ${newFlat.length} new request(s)`
        ),
      ];

      return {
        rounds,
        invariants,
        extra: { stopAck, requestsAfterStop, partialAssistantContentLength: partialAssistantContent.length },
      };
    },
  });

  // ------------------------------------------------------------------ A-I1
  scenarios.push({
    name: "A-I1-thinking-echo",
    defect: "A (thinking/signature never replayed to Bedrock on followups)",
    expected: "green",
    async run(ctx) {
      const turns = [
        thinkingTurn("step 1", "mock_lookup", { q: "think-1" }),
        thinkingTurn("step 2", "mock_lookup", { q: "think-2" }),
        thinkingTurn("step 3", "mock_lookup", { q: "think-3" }),
        { text: "Done thinking through all steps.", stop: "end_turn" },
      ];
      const result = await runScriptedChat(ctx, {
        name: this.name,
        turns,
        prompt: "A-I1: solve this step by step with your tools.",
        toolIds: ["server:web-tools"],
      });

      const { state, completed } = result;
      const rounds = buildRounds(state, { withEcho: true });
      const followups = state.requests.filter((r) => r.index > 0);
      const echoResults = followups.map((r) => ({
        index: r.index,
        echo: computeReasoningEcho(state, r),
      }));
      const allEchoed = echoResults.every((e) => e.echo.matched === e.echo.expected && e.echo.expected > 0);

      const invariants = [
        ...harnessBasics({ ctx, state, completed, expectedRequests: turns.length }),
        inv(
          "followups-exist",
          "harness",
          followups.length === turns.length - 1,
          `followup requests: ${followups.length}`
        ),
        inv(
          "prior-turn-thinking-echoed-with-byte-equal-signature",
          "defect",
          allEchoed,
          echoResults
            .map((e) => `req${e.index}: ${e.echo.matched}/${e.echo.expected} prior tool turns echoed`)
            .join("; ")
        ),
      ];

      return { rounds, invariants, extra: { echoResults } };
    },
  });

  // ------------------------------------------------------------------ C-I1
  scenarios.push({
    name: "C-I1-webtools-truncation",
    defect: "C (web-tools results >4000 chars compacted on followup replay)",
    expected: "green",
    async run(ctx) {
      const turns = [
        {
          thinking: { text: "Need the full page" },
          text: "Fetching the big page.",
          tool_calls: [{ name: "mock_bigfetch", args: { url: "https://mock.example/big" } }],
          stop: "tool_use",
        },
        { text: "Summarized the page.", stop: "end_turn" },
      ];
      const result = await runScriptedChat(ctx, {
        name: this.name,
        turns,
        prompt: "C-I1: fetch the page and summarize it fully.",
        toolIds: ["server:web-tools"],
      });

      const { state, completed } = result;
      const rounds = buildRounds(state, {});
      const bigfetchExecuted = (state.toolCalls || []).some((c) => c.op === "mock_bigfetch");
      const bigToolUseId = (state.emittedTurns?.[0]?.toolUseIds || [])[0];
      const followup = state.requests[1];
      const followupFlat = followup ? JSON.stringify(followup.payload) : "";
      const resultContent = followup && bigToolUseId ? toolResultContentForId(followup.payload, bigToolUseId) : null;

      const invariants = [
        ...harnessBasics({ ctx, state, completed, expectedRequests: turns.length }),
        inv(
          "web-tools-server-executed-tool",
          "harness",
          bigfetchExecuted,
          bigfetchExecuted
            ? "mock_bigfetch executed via server:web-tools registration"
            : `tool never executed; toolCalls=${JSON.stringify(state.toolCalls)}`
        ),
        inv(
          "followup-carries-full-web-tools-result",
          "defect",
          followupFlat.includes(BIGFETCH_MARKER_END) && !followupFlat.includes(TRUNCATION_MARKER),
          `end-marker present=${followupFlat.includes(BIGFETCH_MARKER_END)}, ` +
            `truncation-marker present=${followupFlat.includes(TRUNCATION_MARKER)}, ` +
            `toolResult chars=${resultContent ? resultContent.length : "n/a"}`
        ),
      ];

      return { rounds, invariants, extra: { bigToolUseId, resultChars: resultContent?.length ?? null } };
    },
  });

  return scenarios;
}

export async function executeScenario(ctx, scenario) {
  const startedAt = new Date().toISOString();
  ctx.api.httpLog.length = 0; // per-scenario 5xx scoping
  let outcome;
  try {
    const result = await scenario.run(ctx);
    const observed = classify(result.invariants);
    outcome = {
      scenario: scenario.name,
      defect: scenario.defect,
      expected: scenario.expected,
      observed,
      pass: observed === scenario.expected,
      rounds: result.rounds,
      invariants: result.invariants,
      extra: result.extra || {},
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  } catch (error) {
    outcome = {
      scenario: scenario.name,
      defect: scenario.defect,
      expected: scenario.expected,
      observed: "error",
      pass: false,
      rounds: [],
      invariants: [inv("scenario-executed", "harness", false, String(error?.stack || error))],
      extra: {},
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
  return outcome;
}
