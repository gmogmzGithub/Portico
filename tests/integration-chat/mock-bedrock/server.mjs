// Mock Bedrock Converse upstream + mock OpenAPI tool server for the Tier-2
// headless integration repro suite (tests/integration-chat).
//
// Plain node, zero npm deps. Speaks the exact wire contracts the bifrost
// bridge consumes (src/bifrost-bridge-rust/src/converse.rs):
//   - POST /bedrock/converse  -> SSE lines `data: {<Bedrock chunk JSON>}\n\n`
//     terminated by `data: [DONE]\n\n`. Chunk shapes verified against
//     translate_bedrock_stream_chunk / ensure_tool_use_block_start:
//       {"messageStart":{"role":"assistant"}}
//       {"contentBlockDelta":{"contentBlockIndex":N,"delta":{"reasoningContent":{"text":"..."}}}}
//       {"contentBlockDelta":{"contentBlockIndex":N,"delta":{"reasoningContent":{"signature":"..."}}}}
//       {"contentBlockDelta":{"contentBlockIndex":N,"delta":{"text":"..."}}}
//       {"contentBlockStart":{"contentBlockIndex":N,"start":{"toolUse":{"toolUseId":"...","name":"..."}}}}
//       {"contentBlockDelta":{"contentBlockIndex":N,"delta":{"toolUse":{"input":"<partial json>"}}}}
//       {"contentBlockStop":{"contentBlockIndex":N}}
//       {"messageStop":{"stopReason":"tool_use"|"end_turn"|"max_tokens"}}
//       {"metadata":{"usage":{"inputTokens":..,"outputTokens":..}}}
//     NOTE: the bridge only emits message_stop to its client after the
//     `metadata` chunk arrives (pending_stop_reason is taken in the metadata
//     branch), so metadata MUST follow messageStop. Reasoning text must be
//     emitted before its signature (signature-first is stashed and dropped at
//     contentBlockStop). A "tool_use" stopReason without a prior toolUse block
//     triggers the bridge's malformed_tool_use error path.
//   - GET /mocktools/openapi.json + POST /mocktools/<operationId> implement
//     the stock OWUI direct tool server contract (utils/tools.py
//     execute_tool_server: operationId lookup in openapi.paths, POST json body).
//
// Control API (host port 29700):
//   POST /control/scenario {name, turns:[...]}   activate + reset a scenario
//   GET  /control/requests?scenario=NAME         full request log + bookkeeping
//   POST /control/release {scenario}             release the pending stream gate
//   POST /control/reset                          drop all state
//   GET  /healthz
//
// Turn schema:
//   {
//     thinking: {text, signature?}   optional reasoning block
//     text: "..."                    optional visible text
//     tool_calls: [{name, args, id?}]
//     stop: "tool_use"|"end_turn"|"max_tokens"
//     gate: true                     hold the stream open before messageStop
//                                    until /control/release (30s auto-release)
//   }

import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.MOCK_PORT || 9700);
const GATE_AUTO_RELEASE_MS = Number(process.env.MOCK_GATE_AUTO_RELEASE_MS || 30000);

/** @type {Map<string, Scenario>} */
const scenarios = new Map();
let activeScenarioName = null;

const BIGFETCH_MARKER_START = "WEBTOOLS_BIGFETCH_PAYLOAD_START";
const BIGFETCH_MARKER_END = "END_OF_BIGFETCH_MARKER";
const BIGFETCH_TARGET_CHARS = 24000;

function newScenario(name, turns) {
  return {
    name,
    turns: Array.isArray(turns) ? turns : [],
    cursor: 0,
    requests: [], // {index, receivedAt, turnIndex, gated, released, overrun, payload}
    toolCalls: [], // {op, params, at}
    emittedThinking: {}, // toolUseId -> {text, signature, turnIndex}
    emittedTurns: [], // {turnIndex, toolUseIds, thinking}
    overruns: 0,
    pendingGate: null, // {turnIndex, resolve}
    errors: [],
  };
}

function getActiveScenario() {
  if (!activeScenarioName) return null;
  return scenarios.get(activeScenarioName) || null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sanitizeId(text) {
  return String(text || "").replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40);
}

function toolUseIdFor(scenarioName, turnIndex, callIndex, explicit) {
  if (explicit) return explicit;
  return `toolu_${sanitizeId(scenarioName)}_t${turnIndex}_${callIndex}`;
}

function defaultSignature(scenarioName, turnIndex) {
  return `SIG_${sanitizeId(scenarioName)}_t${turnIndex}_${crypto
    .createHash("sha256")
    .update(`${scenarioName}:${turnIndex}`)
    .digest("hex")
    .slice(0, 24)}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function writeSse(res, obj) {
  // Best-effort write; the client may have disconnected (e.g. B-I3 stop).
  try {
    if (res.destroyed || res.writableEnded) return false;
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

async function handleConverse(req, res, rawBody) {
  const scenario = getActiveScenario();
  let payload = null;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    payload = { unparseable_body: rawBody.slice(0, 2000) };
  }

  if (!scenario) {
    sendJson(res, 500, { error: "no active scenario configured on mock-bedrock" });
    return;
  }

  const turnIndex = scenario.cursor;
  const turn = scenario.turns[turnIndex] || null;
  const overrun = !turn;
  if (!overrun) scenario.cursor += 1;
  else scenario.overruns += 1;

  const record = {
    index: scenario.requests.length,
    receivedAt: new Date().toISOString(),
    turnIndex: overrun ? null : turnIndex,
    gated: Boolean(turn && turn.gate),
    released: false,
    overrun,
    payload,
  };
  scenario.requests.push(record);

  const effectiveTurn = turn || {
    text: "MOCK_OVERRUN: scenario script exhausted",
    stop: "end_turn",
  };

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "x-request-id": `mock-${sanitizeId(scenario.name)}-${record.index}`,
  });

  await writeSse(res, { messageStart: { role: "assistant" } });

  let blockIndex = 0;
  const turnToolUseIds = [];
  let emittedThinking = null;

  if (effectiveTurn.thinking && effectiveTurn.thinking.text) {
    const signature =
      effectiveTurn.thinking.signature || defaultSignature(scenario.name, turnIndex);
    emittedThinking = { text: effectiveTurn.thinking.text, signature, turnIndex };
    // Text first, then signature (bridge stashes signature-first deltas and
    // drops them at contentBlockStop when no thinking text was seen).
    await writeSse(res, {
      contentBlockDelta: {
        contentBlockIndex: blockIndex,
        delta: { reasoningContent: { text: effectiveTurn.thinking.text } },
      },
    });
    await writeSse(res, {
      contentBlockDelta: {
        contentBlockIndex: blockIndex,
        delta: { reasoningContent: { signature } },
      },
    });
    await writeSse(res, { contentBlockStop: { contentBlockIndex: blockIndex } });
    blockIndex += 1;
  }

  if (typeof effectiveTurn.text === "string" && effectiveTurn.text.length > 0) {
    const text = effectiveTurn.text;
    const midpoint = Math.ceil(text.length / 2);
    for (const piece of [text.slice(0, midpoint), text.slice(midpoint)]) {
      if (!piece) continue;
      await writeSse(res, {
        contentBlockDelta: {
          contentBlockIndex: blockIndex,
          delta: { text: piece },
        },
      });
      await sleep(3);
    }
    await writeSse(res, { contentBlockStop: { contentBlockIndex: blockIndex } });
    blockIndex += 1;
  }

  const toolCalls = Array.isArray(effectiveTurn.tool_calls)
    ? effectiveTurn.tool_calls
    : [];
  for (let i = 0; i < toolCalls.length; i++) {
    const call = toolCalls[i];
    const toolUseId = toolUseIdFor(scenario.name, turnIndex, i, call.id);
    turnToolUseIds.push(toolUseId);
    const inputJson = JSON.stringify(call.args || {});
    await writeSse(res, {
      contentBlockStart: {
        contentBlockIndex: blockIndex,
        start: { toolUse: { toolUseId, name: call.name } },
      },
    });
    // Split the input json into two partial deltas like real Bedrock does.
    const mid = Math.ceil(inputJson.length / 2);
    for (const piece of [inputJson.slice(0, mid), inputJson.slice(mid)]) {
      if (!piece) continue;
      await writeSse(res, {
        contentBlockDelta: {
          contentBlockIndex: blockIndex,
          delta: { toolUse: { input: piece } },
        },
      });
    }
    await writeSse(res, { contentBlockStop: { contentBlockIndex: blockIndex } });
    blockIndex += 1;
  }

  // Bookkeeping: remember the thinking we emitted, keyed by this turn's tool
  // use ids (strict-echo checks join on toolUseId).
  if (emittedThinking) {
    for (const id of turnToolUseIds) {
      scenario.emittedThinking[id] = emittedThinking;
    }
  }
  scenario.emittedTurns.push({
    turnIndex: overrun ? null : turnIndex,
    toolUseIds: turnToolUseIds,
    thinking: emittedThinking,
    stop: effectiveTurn.stop || "end_turn",
  });

  // Gate: hold the stream open (pre-messageStop) until /control/release.
  if (turn && turn.gate) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (scenario.pendingGate && scenario.pendingGate.resolve === finish) {
          scenario.pendingGate = null;
        }
        finish("auto_timeout");
      }, GATE_AUTO_RELEASE_MS);
      let finished = false;
      function finish(reason) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        record.released = reason;
        resolve();
      }
      scenario.pendingGate = { turnIndex, resolve: finish };
    });
  }

  const stopReason = effectiveTurn.stop || "end_turn";
  // Guard rail: never emit stopReason tool_use without a toolUse block —
  // the bridge would synthesize a malformed_tool_use stream error.
  const safeStop =
    stopReason === "tool_use" && turnToolUseIds.length === 0 ? "end_turn" : stopReason;
  await writeSse(res, { messageStop: { stopReason: safeStop } });
  await writeSse(res, {
    metadata: { usage: { inputTokens: 100 + turnIndex, outputTokens: 50 + turnIndex } },
  });
  try {
    if (!res.destroyed && !res.writableEnded) {
      res.write("data: [DONE]\n\n");
      res.end();
    }
  } catch {
    /* client gone */
  }
}

// ---------------------------------------------------------------------------
// Mock OpenAPI tool server (OWUI direct tool servers contract)
// ---------------------------------------------------------------------------

const OPENAPI_SPEC = {
  openapi: "3.1.0",
  info: { title: "Mock Web Tools", version: "1.0.0", description: "Integration mock tools" },
  paths: {
    "/mock_lookup": {
      post: {
        operationId: "mock_lookup",
        summary: "Look up a small fact",
        description: "Returns a small scripted result.",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { q: { type: "string", description: "query" } },
                required: ["q"],
              },
            },
          },
        },
        responses: { 200: { description: "ok" } },
      },
    },
    "/mock_bigfetch": {
      post: {
        operationId: "mock_bigfetch",
        summary: "Fetch a large web page",
        description: "Returns a >20KB payload (web-tools truncation repro).",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { url: { type: "string", description: "url" } },
                required: ["url"],
              },
            },
          },
        },
        responses: { 200: { description: "ok" } },
      },
    },
  },
};

function bigfetchContent() {
  const filler = "The quick brown fox jumps over the lazy dog. ".repeat(
    Math.ceil(BIGFETCH_TARGET_CHARS / 46)
  );
  const body = `${BIGFETCH_MARKER_START}\n${filler}`.slice(
    0,
    BIGFETCH_TARGET_CHARS - BIGFETCH_MARKER_END.length - 1
  );
  return `${body}\n${BIGFETCH_MARKER_END}`;
}

function handleMockTool(op, params, res) {
  const scenario = getActiveScenario();
  if (scenario) scenario.toolCalls.push({ op, params, at: new Date().toISOString() });
  if (op === "mock_lookup") {
    sendJson(res, 200, {
      ok: true,
      result: `lookup-result for ${JSON.stringify(params && params.q)}`,
      echo: params,
    });
    return;
  }
  if (op === "mock_bigfetch") {
    sendJson(res, 200, {
      url: (params && params.url) || "https://mock.example/big",
      content: bigfetchContent(),
    });
    return;
  }
  sendJson(res, 404, { error: `unknown mock tool operation: ${op}` });
}

// ---------------------------------------------------------------------------
// HTTP routing
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "mock"}`);
  const path = url.pathname;

  try {
    if (req.method === "GET" && path === "/healthz") {
      sendJson(res, 200, { ok: true, active: activeScenarioName });
      return;
    }

    if (req.method === "POST" && path === "/bedrock/converse") {
      const body = await readBody(req);
      await handleConverse(req, res, body);
      return;
    }

    if (req.method === "GET" && path === "/mocktools/openapi.json") {
      sendJson(res, 200, OPENAPI_SPEC);
      return;
    }

    if (req.method === "POST" && path.startsWith("/mocktools/")) {
      const op = path.slice("/mocktools/".length);
      const body = await readBody(req);
      let params = {};
      try {
        params = body ? JSON.parse(body) : {};
      } catch {
        params = { raw: body };
      }
      handleMockTool(op, params, res);
      return;
    }

    if (req.method === "POST" && path === "/control/scenario") {
      const body = JSON.parse(await readBody(req));
      if (!body || !body.name) {
        sendJson(res, 400, { error: "name is required" });
        return;
      }
      scenarios.set(body.name, newScenario(body.name, body.turns));
      activeScenarioName = body.name;
      sendJson(res, 200, { ok: true, name: body.name, turns: (body.turns || []).length });
      return;
    }

    if (req.method === "GET" && path === "/control/requests") {
      const name = url.searchParams.get("scenario") || activeScenarioName;
      const scenario = name ? scenarios.get(name) : null;
      if (!scenario) {
        sendJson(res, 404, { error: `unknown scenario: ${name}` });
        return;
      }
      sendJson(res, 200, {
        scenario: scenario.name,
        cursor: scenario.cursor,
        turnsTotal: scenario.turns.length,
        overruns: scenario.overruns,
        gatePending: scenario.pendingGate ? scenario.pendingGate.turnIndex : null,
        requests: scenario.requests,
        toolCalls: scenario.toolCalls,
        emittedThinking: scenario.emittedThinking,
        emittedTurns: scenario.emittedTurns,
        errors: scenario.errors,
      });
      return;
    }

    if (req.method === "POST" && path === "/control/release") {
      let name = activeScenarioName;
      try {
        const body = JSON.parse(await readBody(req));
        if (body && body.scenario) name = body.scenario;
      } catch {
        /* empty body ok */
      }
      const scenario = name ? scenarios.get(name) : null;
      if (!scenario) {
        sendJson(res, 404, { error: `unknown scenario: ${name}` });
        return;
      }
      if (scenario.pendingGate) {
        const gate = scenario.pendingGate;
        scenario.pendingGate = null;
        gate.resolve("control_release");
        sendJson(res, 200, { ok: true, released: gate.turnIndex });
      } else {
        sendJson(res, 200, { ok: true, released: null, note: "no gate pending" });
      }
      return;
    }

    if (req.method === "POST" && path === "/control/reset") {
      scenarios.clear();
      activeScenarioName = null;
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, { error: `no route: ${req.method} ${path}` });
  } catch (error) {
    const scenario = getActiveScenario();
    if (scenario) scenario.errors.push(String((error && error.stack) || error));
    try {
      sendJson(res, 500, { error: String(error) });
    } catch {
      /* response already streaming */
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[mock-bedrock] listening on :${PORT}`);
});
