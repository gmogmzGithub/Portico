// Control-plane client for the mock Bedrock server (tests/integration-chat).

export class MockBedrockClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async request(method, path, body) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text.slice(0, 500) };
    }
    if (!res.ok) {
      throw new Error(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return json;
  }

  healthz() {
    return this.request("GET", "/healthz");
  }

  setScenario(name, turns) {
    return this.request("POST", "/control/scenario", { name, turns });
  }

  requests(scenario) {
    return this.request(
      "GET",
      `/control/requests?scenario=${encodeURIComponent(scenario)}`
    );
  }

  release(scenario) {
    return this.request("POST", "/control/release", { scenario });
  }

  reset() {
    return this.request("POST", "/control/reset");
  }
}

// ---------------------------------------------------------------------------
// Bedrock request payload analysis (assertion surface)
// ---------------------------------------------------------------------------
// Payload shape (bridge -> mock, from converse.rs anthropic_request_to_bedrock):
//   { messages: [{role, content: [{text}|{toolUse:{toolUseId,name,input}}|
//                                 {toolResult:{toolUseId,content,status}}|
//                                 {reasoningContent:{reasoningText:{text,signature}}}]}],
//     system: [...], inferenceConfig: {...}, toolConfig: {...} }

export function analyzeBedrockPayload(payload) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const flat = JSON.stringify(payload ?? {});
  const toolUseIds = [];
  const toolResultIds = [];
  const assistantTurns = [];

  messages.forEach((message, msgIndex) => {
    const content = Array.isArray(message?.content) ? message.content : [];
    const turn = {
      msgIndex,
      role: message?.role,
      toolUse: [],
      reasoning: [],
      textBlocks: 0,
    };
    content.forEach((block, blockIndex) => {
      if (block && typeof block === "object") {
        if (block.toolUse) {
          toolUseIds.push(block.toolUse.toolUseId);
          turn.toolUse.push({ blockIndex, id: block.toolUse.toolUseId, name: block.toolUse.name });
        }
        if (block.toolResult) {
          toolResultIds.push(block.toolResult.toolUseId);
        }
        if (block.reasoningContent) {
          const rt = block.reasoningContent.reasoningText || {};
          turn.reasoning.push({
            blockIndex,
            text: rt.text,
            signature: rt.signature,
            redacted: "redactedContent" in block.reasoningContent,
          });
        }
        if (typeof block.text === "string") turn.textBlocks += 1;
      }
    });
    if (message?.role === "assistant") assistantTurns.push(turn);
  });

  return {
    messageCount: messages.length,
    roles: messages.map((m) => m?.role),
    toolUseIds,
    toolResultIds,
    assistantTurns,
    reasoningBlockCount: assistantTurns.reduce((acc, t) => acc + t.reasoning.length, 0),
    flat,
  };
}

export function toolResultContentForId(payload, toolUseId) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  for (const message of messages) {
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      if (block?.toolResult?.toolUseId === toolUseId) {
        return JSON.stringify(block.toolResult.content ?? null);
      }
    }
  }
  return null;
}
