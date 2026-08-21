// Headless OWUI driver for the Tier-2 integration repro suite.
//
// Talks to the patched Open WebUI exactly the way the frontend does:
//  - POST /api/v1/auths/signup            (first signup = admin)
//  - POST /api/v1/chats/new               (Chat.svelte-shaped history/messages)
//  - POST /api/chat/completions           (background-task dispatch; returns
//                                          {status, task_id} — the tool loop
//                                          runs server-side, no SSE to consume)
//  - PUT  /api/v1/chats/{id}/pending-steer (frontend caller:
//         src/patches/frontend/src/lib/apis/chatPendingWork.ts replacePendingSteer)
//  - POST /api/tasks/stop/{task_id}       (true stop; main.py @2741)
//  - GET  /api/v1/chats/{id}/status       (busy/idle + has_pending_steer)
//
// Every response status is recorded into httpLog for the "no 5xx" invariant.

import crypto from "node:crypto";

export const uuid = () => crypto.randomUUID();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeoutMs = 60000, intervalMs = 300, desc = "condition" } = {}) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${desc}${lastError ? ` (last error: ${lastError})` : ""}`
  );
}

export class OwuiClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = null;
    this.httpLog = []; // {method, path, status, at}
  }

  async request(method, path, { body, headers, allowStatuses } = {}) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(headers || {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.httpLog.push({ method, path, status: res.status, at: new Date().toISOString() });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text.slice(0, 2000) };
    }
    if (!res.ok && !(allowStatuses || []).includes(res.status)) {
      throw new Error(
        `${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 500)}`
      );
    }
    return { status: res.status, json };
  }

  fiveHundreds() {
    return this.httpLog.filter((e) => e.status >= 500);
  }

  async ensureAuth() {
    const email = "integration@example.test";
    const password = "integration-password-1";
    try {
      const { json } = await this.request("POST", "/api/v1/auths/signup", {
        body: { name: "Integration Admin", email, password, profile_image_url: "/user.png" },
      });
      this.token = json.token;
    } catch {
      const { json } = await this.request("POST", "/api/v1/auths/signin", {
        body: { email, password },
      });
      this.token = json.token;
    }
    if (!this.token) throw new Error("Could not obtain OWUI auth token");
    return this.token;
  }

  async getModels() {
    const { json } = await this.request("GET", "/api/models");
    return json?.data ?? json ?? [];
  }

  buildTurnNodes({ modelId, prompt, parentId = null }) {
    const userMessageId = uuid();
    const assistantMessageId = uuid();
    const timestamp = Math.floor(Date.now() / 1000);
    const userMessage = {
      id: userMessageId,
      parentId,
      childrenIds: [assistantMessageId],
      role: "user",
      content: prompt,
      timestamp,
      models: [modelId],
    };
    const assistantMessage = {
      id: assistantMessageId,
      parentId: userMessageId,
      childrenIds: [],
      role: "assistant",
      content: "",
      model: modelId,
      modelName: modelId,
      modelIdx: 0,
      timestamp,
    };
    return { userMessage, assistantMessage };
  }

  // Mirrors Chat.svelte's initChatHandler persistence shape: history map with
  // parent/children links + currentId at the assistant placeholder + the flat
  // messages list. Steer promotion (promote_consumed_steer_to_live_turn ->
  // insert_background_dispatch_messages / is_background_turn_branch_persisted)
  // requires all three to be present and consistent.
  async createChat({ modelId, prompt, title }) {
    const { userMessage, assistantMessage } = this.buildTurnNodes({ modelId, prompt });
    const chat = {
      id: "",
      title: title || "Integration repro chat",
      models: [modelId],
      params: {},
      history: {
        messages: {
          [userMessage.id]: userMessage,
          [assistantMessage.id]: assistantMessage,
        },
        currentId: assistantMessage.id,
      },
      messages: [userMessage, assistantMessage],
      tags: [],
      timestamp: Date.now(),
    };
    const { json } = await this.request("POST", "/api/v1/chats/new", { body: { chat } });
    return { chatId: json.id, userMessage, assistantMessage, chat: json };
  }

  async getChat(chatId) {
    const { json } = await this.request("GET", `/api/v1/chats/${chatId}`);
    return json;
  }

  async getChatStatus(chatId) {
    const { json } = await this.request("GET", `/api/v1/chats/${chatId}/status`);
    return json;
  }

  // Mirrors Chat.svelte's generateOpenAIChatCompletion payload (session_id +
  // chat_id + id trigger the background-task path in main.py chat_completion).
  async dispatchCompletion({
    modelId,
    chatId,
    messages,
    userMessage,
    assistantMessageId,
    toolIds = [],
    sessionId = "portico-integration-session",
  }) {
    const body = {
      stream: true,
      model: modelId,
      messages,
      params: { function_calling: "native" },
      filter_ids: undefined,
      tool_ids: toolIds.length ? toolIds : undefined,
      tool_servers: [],
      features: {},
      variables: {},
      session_id: sessionId,
      chat_id: chatId,
      id: assistantMessageId,
      parent_id: userMessage?.id ?? null,
      parent_message: userMessage ?? null,
      background_tasks: {
        title_generation: false,
        tags_generation: false,
        follow_up_generation: false,
      },
    };
    const { json } = await this.request("POST", "/api/chat/completions", { body });
    if (!json || json.status !== true || !json.task_id) {
      throw new Error(
        `chat completion did not return a background task handle: ${JSON.stringify(json).slice(0, 300)}`
      );
    }
    return json.task_id;
  }

  async putPendingSteer(chatId, { prompt, modelId }) {
    const { json } = await this.request("PUT", `/api/v1/chats/${chatId}/pending-steer`, {
      body: {
        prompt,
        files: [],
        status: "active",
        request_context: {
          selected_model_ids: [modelId],
          selected_model_items: { [modelId]: { name: modelId } },
          tool_ids: [],
          tool_servers: [],
          filter_ids: [],
          features: {},
          reasoning_effort_by_model: {},
          params: {},
          variables: {},
          background_tasks: {
            title_generation: false,
            tags_generation: false,
            follow_up_generation: false,
          },
          session_id: null,
        },
      },
    });
    return json;
  }

  async stopTask(taskId) {
    const { status, json } = await this.request("POST", `/api/tasks/stop/${taskId}`, {
      body: {},
      allowStatuses: [400, 404],
    });
    return { status, json };
  }

  async listChatTasks(chatId) {
    const { json } = await this.request("GET", `/api/tasks/chat/${chatId}`, {
      allowStatuses: [404],
    });
    return json?.task_ids ?? [];
  }

  async waitForIdle(chatId, { timeoutMs = 90000, desc = "chat idle" } = {}) {
    return waitFor(
      async () => {
        const status = await this.getChatStatus(chatId);
        return status && status.busy === false ? status : null;
      },
      { timeoutMs, intervalMs: 500, desc }
    );
  }
}
