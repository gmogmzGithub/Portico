// Standalone in-memory mock of the Open WebUI surface consumed by the
// subagents-server MCP binary (see the endpoint inventory in
// tests/agentic/README.md). Point the binary at it with OPENWEBUI_BASE_URL and
// set OPENWEBUI_API_TOKEN so the auth-bridge refresh path is never needed.
//
// The model store is the OWUI "custom models" table: agents are models whose
// meta carries the subagent_* fields. run_subagent support: chat records are
// kept in memory; POST /api/chat/completions marks the chat complete with a
// canned assistant message (done:true) so the 5s poll terminates on its first
// pass.

"use strict";

const http = require("node:http");
const crypto = require("node:crypto");

function startMockOwui({
  port = 0,
  host = "127.0.0.1",
  baseModels = [
    {
      id: "mock-base-model",
      name: "Mock Base Model",
      is_active: true,
      is_default: true,
      owned_by: "openai",
    },
  ],
  toolServers = [
    { id: "server:skills", name: "Skills" },
    { id: "server:subagents", name: "Subagents" },
    { id: "server:mcp-assistant", name: "MCP Assistant" },
    { id: "server:agent-vm", name: "Agent VM" },
  ],
  log = () => {},
} = {}) {
  const models = new Map(); // id -> model object (custom models)
  const chats = new Map(); // id -> chat body
  const completionCalls = []; // request payloads to /api/chat/completions
  const requestLog = [];
  // Fork-parity model-writer lease (see the handler comment below).
  const MODEL_WRITER_GUARDED_PATHS = new Set([
    "/api/v1/models/create",
    "/api/v1/models/model/update",
    "/api/v1/models/model/delete",
    "/api/v1/users/user/settings/update",
  ]);
  let modelWriterLeaseHeld = false;

  for (const base of baseModels) {
    models.set(base.id, { ...base, base_model_id: null, meta: {} });
  }

  const readJson = (req) =>
    new Promise((resolve) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        try {
          resolve(raw ? JSON.parse(raw) : null);
        } catch {
          resolve(null);
        }
      });
    });

  const send = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${host}`);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    requestLog.push({ method: req.method, path: url.pathname });
    log(`[mock-owui] ${req.method} ${url.pathname}`);

    // ---------------- test hooks ----------------
    if (pathname === "/__test/state" && req.method === "GET") {
      return send(res, 200, {
        models: [...models.values()],
        chats: [...chats.entries()].map(([id, chat]) => ({ id, chat })),
        completionCalls,
        requests: requestLog,
      });
    }
    if (pathname === "/__test/reset" && req.method === "POST") {
      models.clear();
      chats.clear();
      completionCalls.length = 0;
      requestLog.length = 0;
      for (const base of baseModels) {
        models.set(base.id, { ...base, base_model_id: null, meta: {} });
      }
      return send(res, 200, { ok: true });
    }

    // ---------------- auth ----------------
    if (pathname === "/api/v1/auths" && req.method === "GET") {
      return send(res, 200, { id: "mock-owui-user", email: "mock@example.invalid" });
    }
    if (pathname === "/api/v1/portico/auth/service-token" && req.method === "POST") {
      return send(res, 200, { token: "mock-owui-token" });
    }

    // ---------------- models ----------------
    // Model-writer lease parity with the OWUI fork (main.py middleware): all
    // model mutations are serialized behind ONE writer lease; an overlapping
    // mutation gets 409 "Model reconciliation or another model mutation is in
    // progress". Clients must serialize or retry (subagents-server does both).
    // The 25ms hold widens the race window so a client-side regression
    // (parallel mutations reaching OWUI) reliably collides in tests.
    if (MODEL_WRITER_GUARDED_PATHS.has(pathname) && req.method === "POST") {
      if (modelWriterLeaseHeld) {
        return send(res, 409, {
          detail: "Model reconciliation or another model mutation is in progress",
        });
      }
      modelWriterLeaseHeld = true;
      res.once("close", () => {
        modelWriterLeaseHeld = false;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (pathname === "/api/models" && req.method === "GET") {
      return send(res, 200, { data: [...models.values()] });
    }
    if (pathname === "/api/v1/models/model" && req.method === "GET") {
      const id = url.searchParams.get("id");
      const model = models.get(id);
      return send(res, 200, model || null);
    }
    if (pathname === "/api/v1/models/create" && req.method === "POST") {
      const body = await readJson(req);
      if (!body || !body.id) return send(res, 400, { detail: "id required" });
      if (models.has(body.id)) {
        return send(res, 400, { detail: "model id taken" });
      }
      models.set(body.id, body);
      return send(res, 200, body);
    }
    if (pathname === "/api/v1/models/model/update" && req.method === "POST") {
      const id = url.searchParams.get("id");
      if (!models.has(id)) return send(res, 404, { detail: "model not found" });
      const body = await readJson(req);
      if (!body) return send(res, 400, { detail: "invalid body" });
      models.set(id, body);
      return send(res, 200, body);
    }
    if (pathname === "/api/v1/models/model/delete" && req.method === "POST") {
      const body = await readJson(req);
      const id = body && body.id;
      const removed = models.delete(id);
      return send(res, removed ? 200 : 404, removed ? true : { detail: "not found" });
    }

    // ---------------- tools ----------------
    if (pathname === "/api/v1/tools" && req.method === "GET") {
      return send(res, 200, toolServers);
    }

    // ---------------- folders ----------------
    if (pathname === "/api/v1/folders" && req.method === "GET") {
      return send(res, 200, []);
    }
    if (pathname === "/api/v1/folders" && req.method === "POST") {
      return send(res, 200, { id: "mock-folder", name: "Sub-agents" });
    }

    // ---------------- chats ----------------
    if (pathname === "/api/v1/chats/new" && req.method === "POST") {
      const body = (await readJson(req)) || {};
      const id = crypto.randomUUID();
      chats.set(id, body.chat || {});
      return send(res, 200, { id });
    }
    const chatMatch = pathname.match(/^\/api\/v1\/chats\/([^/]+)$/);
    if (chatMatch && req.method === "GET") {
      const chat = chats.get(chatMatch[1]);
      if (!chat) return send(res, 404, { detail: "chat not found" });
      return send(res, 200, { id: chatMatch[1], chat });
    }
    if (chatMatch && req.method === "POST") {
      const body = (await readJson(req)) || {};
      if (body.chat) chats.set(chatMatch[1], body.chat);
      return send(res, 200, { id: chatMatch[1] });
    }
    if (/^\/api\/v1\/chats\/[^/]+\/capabilities-changed$/.test(pathname)) {
      return send(res, 200, { ok: true });
    }

    if (pathname === "/api/chat/completions" && req.method === "POST") {
      const body = (await readJson(req)) || {};
      completionCalls.push(body);
      const chatId = body.chat_id;
      const chat = chats.get(chatId);
      if (chat) {
        // Complete the chat immediately: one assistant turn answering the
        // user message, shaped so message_is_complete() passes.
        const messageId = crypto.randomUUID();
        const assistant = {
          id: messageId,
          role: "assistant",
          content: `Mock subagent response for model ${body.model || "unknown"}.`,
          done: true,
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          timestamp: Math.floor(Date.now() / 1000),
        };
        chat.history = chat.history || { messages: {} };
        chat.history.messages = chat.history.messages || {};
        chat.history.messages[messageId] = assistant;
        chat.messages = Array.isArray(chat.messages) ? chat.messages : [];
        chat.messages.push(assistant);
      }
      return send(res, 200, { task_id: `mock-task-${completionCalls.length}` });
    }

    // ---------------- openai config (LM Studio flows) ----------------
    if (pathname === "/openai/config" && req.method === "GET") {
      return send(res, 200, {});
    }
    if (pathname === "/openai/config/update" && req.method === "POST") {
      return send(res, 200, {});
    }

    return send(res, 404, { detail: `mock-owui: no route ${req.method} ${url.pathname}` });
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const boundPort = server.address().port;
      resolve({
        baseUrl: `http://${host}:${boundPort}`,
        port: boundPort,
        models,
        chats,
        completionCalls,
        requestLog,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

module.exports = { startMockOwui };

if (require.main === module) {
  startMockOwui({
    port: Number(process.env.MOCK_OWUI_PORT || 0),
    log: (line) => process.stderr.write(`${line}\n`),
  }).then((handle) => {
    console.log(JSON.stringify({ baseUrl: handle.baseUrl }));
  });
}
