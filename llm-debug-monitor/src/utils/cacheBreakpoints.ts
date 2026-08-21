import type {
  LLMMessage,
  LLMRequest,
  LLMTool,
  LLMTransformedPayloadStage,
} from "@/types/llm";

export type CacheBreakpointScope = "tool" | "system" | "message" | "request";
export type CacheBreakpointOrigin = "explicit" | "request-level" | "automatic";
export type CacheBreakpointStageKind = "pre-bridge" | "bridge" | "provider";

export interface CacheBreakpoint {
  id: string;
  scope: CacheBreakpointScope;
  origin: CacheBreakpointOrigin;
  stageKind: CacheBreakpointStageKind;
  apiPath?: string;
  jsonPath: string;
  targetPath?: string;
  displayPath: string;
  summary: string;
  preview?: string;
  systemIndex?: number;
  messageIndex?: number;
  contentBlockIndex?: number;
  toolIndex?: number;
}

export interface InspectorBreakpointData {
  displayMessages: LLMMessage[];
  displayTools: LLMTool[];
  systemByMessageIndex: Record<number, CacheBreakpoint[]>;
  conversationByMessageIndex: Record<number, CacheBreakpoint[]>;
  toolsByIndex: Record<number, CacheBreakpoint[]>;
}

export function cacheBreakpointOriginLabel(
  origin: CacheBreakpointOrigin,
): string {
  switch (origin) {
    case "explicit":
      return "Explicit";
    case "request-level":
      return "Request-Level";
    case "automatic":
      return "Automatic";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasCacheControl(value: unknown): boolean {
  return isRecord(value) && isRecord(value.cache_control);
}

function isCachePointBlock(value: unknown): boolean {
  return isRecord(value) && isRecord(value.cachePoint);
}

function classifyStageKind(
  apiPath?: string,
): CacheBreakpointStageKind {
  if (apiPath === "bedrock-converse") {
    return "provider";
  }
  if (apiPath) {
    return "bridge";
  }
  return "pre-bridge";
}

function roleLabel(role?: string): string {
  switch (role) {
    case "assistant":
      return "Assistant";
    case "user":
      return "User";
    case "tool":
      return "Tool";
    case "system":
      return "System";
    default:
      return "Message";
  }
}

function truncate(value: string, maxLength = 120): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}…`;
}

function blockPreview(value: unknown): string | undefined {
  if (!isRecord(value)) {
    if (typeof value === "string") {
      return truncate(value.trim());
    }
    return undefined;
  }
  if (typeof value.text === "string" && value.text.trim()) {
    return truncate(value.text.trim());
  }
  if (typeof value.thinking === "string" && value.thinking.trim()) {
    return truncate(value.thinking.trim());
  }
  if (isRecord(value.toolSpec) && typeof value.toolSpec.name === "string") {
    return value.toolSpec.name;
  }
  if (isRecord(value.toolUse) && typeof value.toolUse.name === "string") {
    return value.toolUse.name;
  }
  if (isRecord(value.toolResult) && typeof value.toolResult.toolUseId === "string") {
    return value.toolResult.toolUseId;
  }
  return undefined;
}

function toolName(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (isRecord(value.function) && typeof value.function.name === "string") {
    return value.function.name;
  }
  if (typeof value.name === "string") {
    return value.name;
  }
  if (isRecord(value.toolSpec) && typeof value.toolSpec.name === "string") {
    return value.toolSpec.name;
  }
  return undefined;
}

function bridgeMessages(payload: Record<string, unknown>): LLMMessage[] | null {
  return Array.isArray(payload.messages)
    ? (payload.messages.filter(isRecord) as unknown as LLMMessage[])
    : null;
}

function bridgeTools(payload: Record<string, unknown>): LLMTool[] | null {
  return Array.isArray(payload.tools)
    ? (payload.tools.filter(isRecord) as unknown as LLMTool[])
    : null;
}

function latestStage(
  stages: LLMTransformedPayloadStage[] | undefined,
  apiPath: string,
): LLMTransformedPayloadStage | undefined {
  return [...(stages ?? [])]
    .reverse()
    .find((stage) => stage.api_path === apiPath);
}

function groupByIndex(
  breakpoints: CacheBreakpoint[],
  key: "systemIndex" | "messageIndex" | "toolIndex",
): Record<number, CacheBreakpoint[]> {
  const grouped: Record<number, CacheBreakpoint[]> = {};
  for (const breakpoint of breakpoints) {
    const index = breakpoint[key];
    if (index == null) {
      continue;
    }
    grouped[index] = grouped[index] ?? [];
    grouped[index].push(breakpoint);
  }
  return grouped;
}

function providerBreakpointOrigin(
  key: string,
  bridgeExplicitKeys: Set<string>,
  bridgeHasRequestLevelCacheControl: boolean,
): CacheBreakpointOrigin {
  if (bridgeExplicitKeys.has(key)) {
    return "explicit";
  }
  if (bridgeHasRequestLevelCacheControl) {
    return "request-level";
  }
  return "automatic";
}

function providerBreakpointSummary(
  origin: CacheBreakpointOrigin,
  target: string,
): string {
  switch (origin) {
    case "explicit":
      return `Explicit provider cachePoint ${target}`;
    case "request-level":
      return `Provider cachePoint derived from request-level cache_control ${target}`;
    case "automatic":
      return `Automatic provider cachePoint ${target}`;
  }
}

function extractBridgeBreakpoints(
  payload: Record<string, unknown>,
  apiPath?: string,
): CacheBreakpoint[] {
  const breakpoints: CacheBreakpoint[] = [];
  const stageKind = classifyStageKind(apiPath);
  const messages = Array.isArray(payload.messages)
    ? payload.messages.filter(isRecord)
    : [];

  let systemIndex = 0;
  let conversationIndex = 0;
  for (let messageArrayIndex = 0; messageArrayIndex < messages.length; messageArrayIndex += 1) {
    const message = messages[messageArrayIndex];
    const role =
      typeof message.role === "string" ? message.role : undefined;
    const content = message.content;
    const contentBlocks = Array.isArray(content)
      ? content.filter(isRecord)
      : [];
    const isSystem = role === "system";
    const scopedIndex = isSystem ? systemIndex : conversationIndex;

    for (let contentBlockIndex = 0; contentBlockIndex < contentBlocks.length; contentBlockIndex += 1) {
      const block = contentBlocks[contentBlockIndex];
      if (!hasCacheControl(block)) {
        continue;
      }

      const scope: CacheBreakpointScope = isSystem ? "system" : "message";
      const jsonPath = `messages[${messageArrayIndex}].content[${contentBlockIndex}].cache_control`;
      const displayPath = isSystem
        ? `System message ${scopedIndex + 1}, block ${contentBlockIndex + 1}`
        : `${roleLabel(role)} message ${scopedIndex + 1}, block ${contentBlockIndex + 1}`;
      breakpoints.push({
        id: `${apiPath || "pre-bridge"}:${scope}:${messageArrayIndex}:${contentBlockIndex}`,
        scope,
        origin: "explicit",
        stageKind,
        apiPath,
        jsonPath,
        targetPath: `messages[${messageArrayIndex}].content[${contentBlockIndex}]`,
        displayPath,
        summary: `Explicit cache_control on ${displayPath.toLowerCase()}`,
        preview: blockPreview(block),
        systemIndex: isSystem ? scopedIndex : undefined,
        messageIndex: isSystem ? undefined : scopedIndex,
        contentBlockIndex,
      });
    }

    if (isSystem) {
      systemIndex += 1;
    } else {
      conversationIndex += 1;
    }
  }

  const tools = Array.isArray(payload.tools)
    ? payload.tools.filter(isRecord)
    : [];
  for (let toolIndex = 0; toolIndex < tools.length; toolIndex += 1) {
    const tool = tools[toolIndex];
    if (!hasCacheControl(tool)) {
      continue;
    }
    const name = toolName(tool) ?? `tool ${toolIndex + 1}`;
    breakpoints.push({
      id: `${apiPath || "pre-bridge"}:tool:${toolIndex}`,
      scope: "tool",
      origin: "explicit",
      stageKind,
      apiPath,
      jsonPath: `tools[${toolIndex}].cache_control`,
      targetPath: `tools[${toolIndex}]`,
      displayPath: `Tool ${toolIndex + 1}`,
      summary: `Explicit cache_control on tool ${toolIndex + 1}`,
      preview: name,
      toolIndex,
    });
  }

  if (hasCacheControl(payload)) {
    breakpoints.push({
      id: `${apiPath || "pre-bridge"}:request`,
      scope: "request",
      origin: "request-level",
      stageKind,
      apiPath,
      jsonPath: "cache_control",
      displayPath: "Request-level cache_control",
      summary:
        "Top-level Anthropic request cache_control. The provider stage shows the translated Bedrock cachePoint placement.",
    });
  }

  return breakpoints;
}

function explicitKey(breakpoint: CacheBreakpoint): string | null {
  switch (breakpoint.scope) {
    case "tool":
      return breakpoint.toolIndex != null ? `tool:${breakpoint.toolIndex}` : null;
    case "system":
      return breakpoint.systemIndex != null
        ? `system:${breakpoint.systemIndex}:${breakpoint.contentBlockIndex ?? 0}`
        : null;
    case "message":
      return breakpoint.messageIndex != null
        ? `message:${breakpoint.messageIndex}:${breakpoint.contentBlockIndex ?? 0}`
        : null;
    default:
      return null;
  }
}

function extractProviderBreakpoints(
  payload: Record<string, unknown>,
  apiPath?: string,
  bridgeBreakpoints: CacheBreakpoint[] = [],
): CacheBreakpoint[] {
  const stageKind = classifyStageKind(apiPath);
  const breakpoints: CacheBreakpoint[] = [];
  const bridgeExplicitKeys = new Set(
    bridgeBreakpoints
      .filter((breakpoint) => breakpoint.origin === "explicit")
      .map(explicitKey)
      .filter((key): key is string => !!key),
  );
  const bridgeHasRequestLevelCacheControl = bridgeBreakpoints.some(
    (breakpoint) =>
      breakpoint.scope === "request" &&
      breakpoint.origin === "request-level",
  );

  const toolBlocks =
    isRecord(payload.toolConfig) && Array.isArray(payload.toolConfig.tools)
      ? payload.toolConfig.tools
      : [];
  let toolIndex = -1;
  let previousToolName: string | undefined;
  for (let blockIndex = 0; blockIndex < toolBlocks.length; blockIndex += 1) {
    const block = toolBlocks[blockIndex];
    if (isCachePointBlock(block)) {
      if (toolIndex < 0) {
        continue;
      }
      const key = `tool:${toolIndex}`;
      const origin = providerBreakpointOrigin(
        key,
        bridgeExplicitKeys,
        bridgeHasRequestLevelCacheControl,
      );
      breakpoints.push({
        id: `${apiPath || "provider"}:tool:${toolIndex}:${blockIndex}`,
        scope: "tool",
        origin,
        stageKind,
        apiPath,
        jsonPath: `toolConfig.tools[${blockIndex}]`,
        targetPath:
          blockIndex > 0 ? `toolConfig.tools[${blockIndex - 1}]` : undefined,
        displayPath: `Tool ${toolIndex + 1}, after block ${toolIndex + 1}`,
        summary: providerBreakpointSummary(
          origin,
          `after tool ${toolIndex + 1}`,
        ),
        preview: previousToolName,
        toolIndex,
      });
      continue;
    }
    toolIndex += 1;
    previousToolName = toolName(block);
  }

  const systemBlocks = Array.isArray(payload.system)
    ? payload.system
    : [];
  let systemIndex = -1;
  let previousSystemPreview: string | undefined;
  for (let blockIndex = 0; blockIndex < systemBlocks.length; blockIndex += 1) {
    const block = systemBlocks[blockIndex];
    if (isCachePointBlock(block)) {
      if (systemIndex < 0) {
        continue;
      }
      const key = `system:${systemIndex}:0`;
      const origin = providerBreakpointOrigin(
        key,
        bridgeExplicitKeys,
        bridgeHasRequestLevelCacheControl,
      );
      breakpoints.push({
        id: `${apiPath || "provider"}:system:${systemIndex}:${blockIndex}`,
        scope: "system",
        origin,
        stageKind,
        apiPath,
        jsonPath: `system[${blockIndex}]`,
        targetPath: blockIndex > 0 ? `system[${blockIndex - 1}]` : undefined,
        displayPath: `System block ${systemIndex + 1}, after block ${systemIndex + 1}`,
        summary: providerBreakpointSummary(
          origin,
          `after system block ${systemIndex + 1}`,
        ),
        preview: previousSystemPreview,
        systemIndex,
        contentBlockIndex: 0,
      });
      continue;
    }
    systemIndex += 1;
    previousSystemPreview = blockPreview(block);
  }

  const messages = Array.isArray(payload.messages)
    ? payload.messages.filter(isRecord)
    : [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    const role =
      typeof message.role === "string" ? message.role : undefined;
    const contentBlocks = Array.isArray(message.content)
      ? message.content
      : [];
    let messageContentIndex = -1;
    let previousBlockPreview: string | undefined;
    for (let blockIndex = 0; blockIndex < contentBlocks.length; blockIndex += 1) {
      const block = contentBlocks[blockIndex];
        if (isCachePointBlock(block)) {
          const targetContentBlockIndex = Math.max(messageContentIndex, 0);
          const key = `message:${messageIndex}:${targetContentBlockIndex}`;
          const origin = providerBreakpointOrigin(
            key,
            bridgeExplicitKeys,
            bridgeHasRequestLevelCacheControl,
          );
          breakpoints.push({
            id: `${apiPath || "provider"}:message:${messageIndex}:${blockIndex}`,
            scope: "message",
          origin,
          stageKind,
          apiPath,
          jsonPath: `messages[${messageIndex}].content[${blockIndex}]`,
          targetPath:
            blockIndex > 0
              ? `messages[${messageIndex}].content[${blockIndex - 1}]`
              : undefined,
            displayPath: `${roleLabel(role)} message ${messageIndex + 1}, after block ${targetContentBlockIndex + 1}`,
            summary: providerBreakpointSummary(
              origin,
              `in ${roleLabel(role).toLowerCase()} message ${messageIndex + 1}`,
            ),
            preview: previousBlockPreview,
            messageIndex,
            contentBlockIndex: targetContentBlockIndex,
        });
        continue;
      }
      messageContentIndex += 1;
      previousBlockPreview = blockPreview(block);
    }
  }

  return breakpoints;
}

export function extractStageCacheBreakpoints(
  stage: Pick<LLMTransformedPayloadStage, "api_path" | "payload"> | {
    api_path?: string;
    payload: Record<string, unknown>;
  },
  options: {
    bridgeStage?: Pick<LLMTransformedPayloadStage, "api_path" | "payload"> | null;
  } = {},
): CacheBreakpoint[] {
  const apiPath = stage.api_path;
  const payload = stage.payload;
  if (!payload || typeof payload !== "object") {
    return [];
  }

  if (apiPath === "bedrock-converse") {
    const bridgeBreakpoints = options.bridgeStage
      ? extractStageCacheBreakpoints(options.bridgeStage)
      : [];
    return extractProviderBreakpoints(payload, apiPath, bridgeBreakpoints);
  }

  return extractBridgeBreakpoints(payload, apiPath);
}

export function buildRequestInspectorBreakpointData(
  request: Pick<LLMRequest, "messages" | "tools" | "transformed_payloads">,
): InspectorBreakpointData {
  const bridgeStage = latestStage(request.transformed_payloads, "chat-completions");
  const providerStage = latestStage(
    request.transformed_payloads,
    "bedrock-converse",
  );

  const displayMessages =
    (bridgeStage && bridgeMessages(bridgeStage.payload)) ??
    request.messages ??
    [];
  const displayTools =
    (bridgeStage && bridgeTools(bridgeStage.payload)) ??
    request.tools ??
    [];

  const bridgeBreakpoints = bridgeStage
    ? extractStageCacheBreakpoints(bridgeStage)
    : [];
  const providerBreakpoints = providerStage
    ? extractStageCacheBreakpoints(providerStage, { bridgeStage })
    : [];

  const explicitConversationKeys = new Set(
    bridgeBreakpoints
      .filter((breakpoint) => breakpoint.scope === "message")
      .map(explicitKey)
      .filter((key): key is string => !!key),
  );

  const conversationBreakpoints = [
    ...bridgeBreakpoints.filter((breakpoint) => breakpoint.scope === "message"),
    ...providerBreakpoints.filter((breakpoint) => {
      if (breakpoint.scope !== "message" || breakpoint.origin === "explicit") {
        return false;
      }
      const key = explicitKey(breakpoint);
      return !key || !explicitConversationKeys.has(key);
    }),
  ];

  return {
    displayMessages,
    displayTools,
    systemByMessageIndex: groupByIndex(
      bridgeBreakpoints.filter((breakpoint) => breakpoint.scope === "system"),
      "systemIndex",
    ),
    conversationByMessageIndex: groupByIndex(
      conversationBreakpoints,
      "messageIndex",
    ),
    toolsByIndex: groupByIndex(
      bridgeBreakpoints.filter((breakpoint) => breakpoint.scope === "tool"),
      "toolIndex",
    ),
  };
}
