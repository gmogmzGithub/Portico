import { create } from 'zustand';
import type { DebugEvent, ChatSession, ActiveTool, ActiveSkill } from '@/types/events';
import type {
  LLMRequest,
  LLMTransformedPayloadStage,
  LLMUsage,
  ReasoningConfig,
  RequestSummary,
} from '@/types/llm';

function requestMatchesTransformedModel(request: LLMRequest, transformedModel?: string): boolean {
  if (!transformedModel) {
    return true;
  }
  return request.model === transformedModel || request.base_model === transformedModel;
}

function extractMetadataString(metadata: unknown, key: string): string | undefined {
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function getEventDataRecord(event: DebugEvent): Record<string, unknown> | undefined {
  return event.data && typeof event.data === 'object'
    ? (event.data as unknown as Record<string, unknown>)
    : undefined;
}

function getEventMetadata(event: DebugEvent): Record<string, unknown> | undefined {
  const data = getEventDataRecord(event);
  return data && typeof data.metadata === 'object' && data.metadata
    ? (data.metadata as Record<string, unknown>)
    : undefined;
}

function getEventRawPayload(event: DebugEvent): Record<string, unknown> | undefined {
  const data = getEventDataRecord(event);
  return data && typeof data.raw_payload === 'object' && data.raw_payload
    ? (data.raw_payload as Record<string, unknown>)
    : undefined;
}

function getEventPayload(event: DebugEvent): Record<string, unknown> | undefined {
  const data = getEventDataRecord(event);
  return data && typeof data.payload === 'object' && data.payload
    ? (data.payload as Record<string, unknown>)
    : undefined;
}

function getEventPayloadMetadata(event: DebugEvent): Record<string, unknown> | undefined {
  const payload = getEventPayload(event);
  return payload && typeof payload.metadata === 'object'
    ? (payload.metadata as Record<string, unknown>)
    : undefined;
}

function extractMessageIdFromMetadata(metadata: unknown): string | undefined {
  return extractMetadataString(metadata, 'message_id');
}

function extractDebugRequestIdFromMetadata(metadata: unknown): string | undefined {
  return extractMetadataString(metadata, 'debug_request_id');
}

function extractUpstreamRequestIdFromMetadata(metadata: unknown): string | undefined {
  return extractMetadataString(metadata, 'upstream_request_id');
}

function extractTaskNameFromMetadata(metadata: unknown): string | undefined {
  return extractMetadataString(metadata, 'task');
}

function extractOuterMessageIdFromMetadata(metadata: unknown): string | undefined {
  return extractMetadataString(metadata, 'outer_message_id');
}

function extractTriggerMessageIdFromMetadata(metadata: unknown): string | undefined {
  return extractMetadataString(metadata, 'trigger_message_id');
}

function extractTranscriptAnchorKindFromMetadata(
  metadata: unknown
): 'user_message' | 'assistant_tool_block' | 'background' | undefined {
  const value = extractMetadataString(metadata, 'transcript_anchor_kind');
  return value === 'user_message' || value === 'assistant_tool_block' || value === 'background'
    ? value
    : undefined;
}

function extractTranscriptAnchorMessageIdFromMetadata(metadata: unknown): string | undefined {
  return extractMetadataString(metadata, 'transcript_anchor_message_id');
}

function extractRequestPhaseFromMetadata(metadata: unknown): string | undefined {
  return extractMetadataString(metadata, 'request_phase');
}

function extractFollowupIndexFromMetadata(metadata: unknown): number | undefined {
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }
  const value = (metadata as Record<string, unknown>).followup_index;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function extractTranscriptAnchorToolBlockIndexFromMetadata(
  metadata: unknown
): number | undefined {
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }
  const value = (metadata as Record<string, unknown>).transcript_anchor_tool_block_index;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function extractMessageIdFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  return extractMessageIdFromMetadata((payload as Record<string, unknown>).metadata);
}

function extractDebugRequestIdFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  return extractDebugRequestIdFromMetadata((payload as Record<string, unknown>).metadata);
}

function extractUpstreamRequestIdFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  return extractUpstreamRequestIdFromMetadata((payload as Record<string, unknown>).metadata);
}

function extractTaskNameFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  return extractTaskNameFromMetadata((payload as Record<string, unknown>).metadata);
}

function extractOuterMessageIdFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  return extractOuterMessageIdFromMetadata((payload as Record<string, unknown>).metadata);
}

function extractTriggerMessageIdFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  return extractTriggerMessageIdFromMetadata((payload as Record<string, unknown>).metadata);
}

function extractTranscriptAnchorKindFromPayload(
  payload: unknown
): 'user_message' | 'assistant_tool_block' | 'background' | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  return extractTranscriptAnchorKindFromMetadata((payload as Record<string, unknown>).metadata);
}

function extractTranscriptAnchorMessageIdFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  return extractTranscriptAnchorMessageIdFromMetadata((payload as Record<string, unknown>).metadata);
}

function extractRequestPhaseFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  return extractRequestPhaseFromMetadata((payload as Record<string, unknown>).metadata);
}

function extractFollowupIndexFromPayload(payload: unknown): number | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  return extractFollowupIndexFromMetadata((payload as Record<string, unknown>).metadata);
}

function extractTranscriptAnchorToolBlockIndexFromPayload(payload: unknown): number | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  return extractTranscriptAnchorToolBlockIndexFromMetadata(
    (payload as Record<string, unknown>).metadata
  );
}

function extractDebugRequestIdFromEvent(event: DebugEvent): string | undefined {
  return firstDefined(
    event.debug_request_id,
    extractDebugRequestIdFromMetadata(getEventMetadata(event)),
    extractDebugRequestIdFromMetadata(getEventPayloadMetadata(event)),
    extractDebugRequestIdFromPayload(getEventRawPayload(event))
  );
}

function extractUpstreamRequestIdFromEvent(event: DebugEvent): string | undefined {
  return firstDefined(
    event.upstream_request_id,
    extractUpstreamRequestIdFromMetadata(getEventMetadata(event)),
    extractUpstreamRequestIdFromMetadata(getEventPayloadMetadata(event)),
    extractUpstreamRequestIdFromPayload(getEventRawPayload(event))
  );
}

function extractTaskNameFromEvent(event: DebugEvent): string | undefined {
  return firstDefined(
    event.task_name,
    extractTaskNameFromMetadata(getEventMetadata(event)),
    extractTaskNameFromMetadata(getEventPayloadMetadata(event)),
    extractTaskNameFromPayload(getEventRawPayload(event))
  );
}

function extractRequestPhaseFromEvent(event: DebugEvent): string | undefined {
  return firstDefined(
    event.request_phase,
    extractRequestPhaseFromMetadata(getEventMetadata(event)),
    extractRequestPhaseFromMetadata(getEventPayloadMetadata(event)),
    extractRequestPhaseFromPayload(getEventRawPayload(event))
  );
}

function extractFollowupIndexFromEvent(event: DebugEvent): number | undefined {
  return firstDefined(
    event.followup_index,
    extractFollowupIndexFromMetadata(getEventMetadata(event)),
    extractFollowupIndexFromMetadata(getEventPayloadMetadata(event)),
    extractFollowupIndexFromPayload(getEventRawPayload(event))
  );
}

function extractOuterMessageIdFromEvent(event: DebugEvent): string | undefined {
  return firstDefined(
    event.outer_message_id,
    extractOuterMessageIdFromMetadata(getEventMetadata(event)),
    extractOuterMessageIdFromMetadata(getEventPayloadMetadata(event)),
    extractOuterMessageIdFromPayload(getEventRawPayload(event))
  );
}

function extractTriggerMessageIdFromEvent(event: DebugEvent): string | undefined {
  return firstDefined(
    event.trigger_message_id,
    extractTriggerMessageIdFromMetadata(getEventMetadata(event)),
    extractTriggerMessageIdFromMetadata(getEventPayloadMetadata(event)),
    extractTriggerMessageIdFromPayload(getEventRawPayload(event))
  );
}

function extractTranscriptAnchorKindFromEvent(
  event: DebugEvent
): 'user_message' | 'assistant_tool_block' | 'background' | undefined {
  return firstDefined(
    event.transcript_anchor_kind,
    extractTranscriptAnchorKindFromMetadata(getEventMetadata(event)),
    extractTranscriptAnchorKindFromMetadata(getEventPayloadMetadata(event)),
    extractTranscriptAnchorKindFromPayload(getEventRawPayload(event))
  );
}

function extractTranscriptAnchorMessageIdFromEvent(event: DebugEvent): string | undefined {
  return firstDefined(
    event.transcript_anchor_message_id,
    extractTranscriptAnchorMessageIdFromMetadata(getEventMetadata(event)),
    extractTranscriptAnchorMessageIdFromMetadata(getEventPayloadMetadata(event)),
    extractTranscriptAnchorMessageIdFromPayload(getEventRawPayload(event))
  );
}

function extractTranscriptAnchorToolBlockIndexFromEvent(event: DebugEvent): number | undefined {
  return firstDefined(
    event.transcript_anchor_tool_block_index,
    extractTranscriptAnchorToolBlockIndexFromMetadata(getEventMetadata(event)),
    extractTranscriptAnchorToolBlockIndexFromMetadata(getEventPayloadMetadata(event)),
    extractTranscriptAnchorToolBlockIndexFromPayload(getEventRawPayload(event))
  );
}

function findRequestByIdentity(
  requests: Map<string, LLMRequest>,
  {
    upstreamRequestId,
    debugRequestId,
  }: {
    upstreamRequestId?: string;
    debugRequestId?: string;
  }
): LLMRequest | undefined {
  if (upstreamRequestId) {
    const upstreamMatch = requests.get(upstreamRequestId)
      || Array.from(requests.values()).find((request) => request.upstream_request_id === upstreamRequestId);
    if (upstreamMatch) {
      return upstreamMatch;
    }
    if (debugRequestId) {
      const debugMatch = requests.get(debugRequestId)
        || Array.from(requests.values()).find(
          (request) => request.debug_request_id === debugRequestId && !request.upstream_request_id
        );
      if (debugMatch && !debugMatch.upstream_request_id) {
        return debugMatch;
      }
    }
    return undefined;
  }
  if (!debugRequestId) {
    return undefined;
  }
  return requests.get(debugRequestId)
    || Array.from(requests.values()).find((request) => request.debug_request_id === debugRequestId);
}

function rekeyRequest(
  requests: Map<string, LLMRequest>,
  request: LLMRequest,
  requestId: string
): void {
  if (request.request_id !== requestId) {
    requests.delete(request.request_id);
    request.request_id = requestId;
  }
}

function updateRequestIdentity(
  request: LLMRequest,
  {
    messageId,
    debugRequestId,
    upstreamRequestId,
    taskName,
    requestPhase,
    followupIndex,
    outerMessageId,
    triggerMessageId,
    transcriptAnchorKind,
    transcriptAnchorMessageId,
    transcriptAnchorToolBlockIndex,
  }: {
    messageId?: string;
    debugRequestId?: string;
    upstreamRequestId?: string;
    taskName?: string;
    requestPhase?: string;
    followupIndex?: number;
    outerMessageId?: string;
    triggerMessageId?: string;
    transcriptAnchorKind?: 'user_message' | 'assistant_tool_block' | 'background';
    transcriptAnchorMessageId?: string;
    transcriptAnchorToolBlockIndex?: number;
  }
): void {
  request.message_id = request.message_id || messageId;
  request.debug_request_id = request.debug_request_id || debugRequestId;
  request.upstream_request_id = request.upstream_request_id || upstreamRequestId;
  request.task_name = request.task_name || taskName;
  request.request_phase = request.request_phase || requestPhase;
  request.followup_index = request.followup_index ?? followupIndex;
  request.outer_message_id = request.outer_message_id || outerMessageId;
  request.trigger_message_id = request.trigger_message_id || triggerMessageId;
  request.transcript_anchor_kind = request.transcript_anchor_kind || transcriptAnchorKind;
  request.transcript_anchor_message_id =
    request.transcript_anchor_message_id || transcriptAnchorMessageId;
  request.transcript_anchor_tool_block_index =
    request.transcript_anchor_tool_block_index ?? transcriptAnchorToolBlockIndex;
  request.is_auxiliary = Boolean(request.task_name);
}

function createRequestShell(
  event: DebugEvent,
  model: string | undefined,
  {
    baseModel,
    messageId,
    debugRequestId,
    upstreamRequestId,
    taskName,
    requestPhase,
    followupIndex,
    outerMessageId,
    triggerMessageId,
    transcriptAnchorKind,
    transcriptAnchorMessageId,
    transcriptAnchorToolBlockIndex,
    rawPayload,
  }: {
    baseModel?: string;
    messageId?: string;
    debugRequestId?: string;
    upstreamRequestId?: string;
    taskName?: string;
    requestPhase?: string;
    followupIndex?: number;
    outerMessageId?: string;
    triggerMessageId?: string;
    transcriptAnchorKind?: 'user_message' | 'assistant_tool_block' | 'background';
    transcriptAnchorMessageId?: string;
    transcriptAnchorToolBlockIndex?: number;
    rawPayload?: Record<string, unknown>;
  } = {}
): LLMRequest {
  const requestId = upstreamRequestId || debugRequestId || event.event_id;
  return {
    request_id: requestId,
    chat_id: event.chat_id,
    session_id: event.session_id,
    timestamp: event.timestamp,
    model: model || 'unknown',
    base_model: baseModel,
    message_id: messageId,
    debug_request_id: debugRequestId,
    upstream_request_id: upstreamRequestId,
    task_name: taskName,
    request_phase: requestPhase,
    followup_index: followupIndex,
    outer_message_id: outerMessageId,
    trigger_message_id: triggerMessageId,
    transcript_anchor_kind: transcriptAnchorKind,
    transcript_anchor_message_id: transcriptAnchorMessageId,
    transcript_anchor_tool_block_index: transcriptAnchorToolBlockIndex,
    is_auxiliary: Boolean(taskName),
    messages: [],
    parameters: {},
    raw_payload: rawPayload || {},
    transformed_payloads: [],
    status: 'pending',
  };
}

function requestMatchesTransformedEvent(
  request: LLMRequest,
  transformedModel: string | undefined,
  transformedMessageId: string | undefined,
  transformedUpstreamRequestId: string | undefined,
  transformedDebugRequestId: string | undefined
): boolean {
  if (request.upstream_request_id && transformedUpstreamRequestId) {
    return request.upstream_request_id === transformedUpstreamRequestId;
  }
  if (request.debug_request_id && transformedDebugRequestId) {
    return request.debug_request_id === transformedDebugRequestId;
  }
  if (request.message_id && transformedMessageId) {
    return request.message_id === transformedMessageId;
  }
  return requestMatchesTransformedModel(request, transformedModel);
}

function upsertTransformedStage(
  stages: LLMTransformedPayloadStage[] | undefined,
  nextStage: LLMTransformedPayloadStage
): LLMTransformedPayloadStage[] {
  const nextStages = [...(stages ?? [])];
  const existingIndex = nextStages.findIndex(
    (stage) => stage.api_path === nextStage.api_path || stage.event_id === nextStage.event_id
  );
  if (existingIndex >= 0) {
    nextStages[existingIndex] = nextStage;
  } else {
    nextStages.push(nextStage);
  }
  return nextStages;
}

interface EventStore {
  // Events
  events: DebugEvent[];
  addEvent: (event: DebugEvent) => void;
  clearEvents: () => void;

  // Chats
  chats: Map<string, ChatSession>;
  selectedChatId: string | null;
  selectionOrigin: 'user' | 'auto' | 'deep_link' | null;
  selectChat: (chatId: string | null) => void;
  setSelection: (
    chatId: string | null,
    requestId: string | null,
    origin?: 'user' | 'auto' | 'deep_link' | null
  ) => void;
  hydrateChatRequests: (
    chatId: string,
    requests: RequestSummary[],
    total?: number
  ) => void;
  hydrateRequestDetail: (request: LLMRequest) => void;

  // Requests
  requests: Map<string, LLMRequest>;
  selectedRequestId: string | null;
  selectRequest: (requestId: string | null) => void;

  // Tool Call Selection (global across requests)
  selectedToolCallId: string | null;
  selectToolCall: (toolCallId: string | null) => void;
  toggleToolCallSelection: (toolCallId: string) => void;

  // Connection
  isConnected: boolean;
  setConnected: (connected: boolean) => void;

  // Process incoming event
  processEvent: (event: DebugEvent) => void;
}

export const useEventStore = create<EventStore>((set, get) => ({
  events: [],
  chats: new Map(),
  selectedChatId: null,
  selectionOrigin: null,
  requests: new Map(),
  selectedRequestId: null,
  selectedToolCallId: null,
  isConnected: false,

  addEvent: (event) => {
    set((state) => ({
      events: [...state.events.slice(-999), event], // Keep last 1000 events
    }));
  },

  clearEvents: () => {
    set({
      events: [],
      chats: new Map(),
      requests: new Map(),
      selectedChatId: null,
      selectedRequestId: null,
      selectionOrigin: null,
    });
  },

  selectChat: (chatId) => {
    set({ selectedChatId: chatId, selectedRequestId: null, selectionOrigin: 'user' });
  },

  setSelection: (chatId, requestId, origin = null) => {
    set({
      selectedChatId: chatId,
      selectedRequestId: requestId,
      selectionOrigin: origin,
    });
  },

  hydrateChatRequests: (chatId, summaries, total) => {
    const chats = new Map(get().chats);
    const requests = new Map(get().requests);
    const sortedSummaries = [...summaries].sort((left, right) => {
      const leftTime = new Date(left.timestamp).getTime();
      const rightTime = new Date(right.timestamp).getTime();
      if (leftTime !== rightTime) {
        return leftTime - rightTime;
      }
      return left.request_id.localeCompare(right.request_id);
    });

    const existingChat = chats.get(chatId);
    const firstSummary = sortedSummaries[0];
    const lastSummary = sortedSummaries[sortedSummaries.length - 1];
    chats.set(chatId, {
      chat_id: chatId,
      title: existingChat?.title,
      model:
        existingChat?.model ||
        firstSummary?.base_model ||
        firstSummary?.model,
      base_model:
        existingChat?.base_model ||
        firstSummary?.base_model,
      created_at: existingChat?.created_at || firstSummary?.timestamp || new Date().toISOString(),
      last_activity: lastSummary?.timestamp || existingChat?.last_activity || new Date().toISOString(),
      request_count: Math.max(
        existingChat?.request_count || 0,
        typeof total === 'number' && Number.isFinite(total) ? total : sortedSummaries.length,
      ),
      capabilities: existingChat?.capabilities || { tools: [], skills: [] },
    });

    for (const summary of sortedSummaries) {
      const existingRequest = requests.get(summary.request_id)
        || findRequestByIdentity(requests, {
          upstreamRequestId: summary.upstream_request_id,
          debugRequestId: summary.debug_request_id,
        });
      const existingSessionId = existingRequest ? existingRequest.session_id : '';
      const request: LLMRequest = existingRequest || {
        request_id: summary.request_id,
        chat_id: chatId,
        session_id: existingSessionId,
        timestamp: summary.timestamp,
        model: summary.model,
        base_model: summary.base_model,
        messages: [],
        parameters: {},
        raw_payload: {},
        transformed_payloads: [],
        status: summary.status,
        tool_ids: summary.tool_ids || [],
        skills: summary.skills || [],
      };

      rekeyRequest(requests, request, summary.request_id);
      request.chat_id = chatId;
      request.timestamp = summary.timestamp;
      request.model = summary.model;
      request.base_model = summary.base_model || request.base_model;
      request.status = summary.status;
      request.duration_ms = summary.duration_ms;
      request.tool_ids = summary.tool_ids || request.tool_ids || [];
      request.skills = summary.skills || request.skills || [];
      request.response = request.response || undefined;
      if (summary.usage) {
        request.response = {
          content: request.response?.content || '',
          tool_calls: request.response?.tool_calls || [],
          finish_reason: request.response?.finish_reason || '',
          usage: summary.usage,
          thinking: request.response?.thinking || '',
        };
      }
      request.tools = request.tools || (summary.tool_count > 0 ? [] : request.tools);
      updateRequestIdentity(request, {
        messageId: summary.message_id,
        debugRequestId: summary.debug_request_id,
        upstreamRequestId: summary.upstream_request_id,
        taskName: summary.task_name,
        requestPhase: summary.request_phase,
        followupIndex: summary.followup_index,
        outerMessageId: summary.outer_message_id,
        triggerMessageId: summary.trigger_message_id,
        transcriptAnchorKind: summary.transcript_anchor_kind,
        transcriptAnchorMessageId: summary.transcript_anchor_message_id,
        transcriptAnchorToolBlockIndex: summary.transcript_anchor_tool_block_index,
      });
      requests.set(request.request_id, request);
    }

    set({
      chats,
      requests,
    });
  },

  hydrateRequestDetail: (requestDetail) => {
    const chats = new Map(get().chats);
    const requests = new Map(get().requests);
    const existingRequest = requests.get(requestDetail.request_id)
      || findRequestByIdentity(requests, {
        upstreamRequestId: requestDetail.upstream_request_id,
        debugRequestId: requestDetail.debug_request_id,
      });
    const nextRequest = {
      ...(existingRequest || {}),
      ...requestDetail,
      response: requestDetail.response ?? existingRequest?.response,
      transformed_payloads:
        requestDetail.transformed_payloads ?? existingRequest?.transformed_payloads ?? [],
      tool_ids: requestDetail.tool_ids ?? existingRequest?.tool_ids ?? [],
      skills: requestDetail.skills ?? existingRequest?.skills ?? [],
    } as LLMRequest;

    rekeyRequest(requests, nextRequest, requestDetail.request_id);
    requests.set(nextRequest.request_id, nextRequest);

    const existingChat = chats.get(requestDetail.chat_id);
    chats.set(requestDetail.chat_id, {
      chat_id: requestDetail.chat_id,
      title: existingChat?.title,
      model:
        existingChat?.model ||
        requestDetail.base_model ||
        requestDetail.model,
      base_model:
        existingChat?.base_model ||
        requestDetail.base_model,
      created_at: existingChat?.created_at || requestDetail.timestamp,
      last_activity: existingChat?.last_activity || requestDetail.timestamp,
      request_count: Math.max(existingChat?.request_count || 0, 1),
      capabilities: existingChat?.capabilities || { tools: [], skills: [] },
    });

    set({
      chats,
      requests,
    });
  },

  selectRequest: (requestId) => {
    set({ selectedRequestId: requestId, selectionOrigin: 'user' });
  },

  selectToolCall: (toolCallId) => {
    set({ selectedToolCallId: toolCallId });
  },

  toggleToolCallSelection: (toolCallId) => {
    set((state) => ({
      selectedToolCallId: state.selectedToolCallId === toolCallId ? null : toolCallId,
    }));
  },

  setConnected: (connected) => {
    set({ isConnected: connected });
  },

  processEvent: (event) => {
    const { chats, requests } = get();

    // Update events list
    get().addEvent(event);

    // Update chat session
    const existingChat = chats.get(event.chat_id);
    const updatedChat: ChatSession = existingChat || {
      chat_id: event.chat_id,
      created_at: event.timestamp,
      last_activity: event.timestamp,
      request_count: 0,
    };
    updatedChat.last_activity = event.timestamp;
    const eventDebugRequestId = extractDebugRequestIdFromEvent(event);
    const eventUpstreamRequestId = extractUpstreamRequestIdFromEvent(event);
    const eventTaskName = extractTaskNameFromEvent(event);
    const eventRequestPhase = extractRequestPhaseFromEvent(event);
    const eventFollowupIndex = extractFollowupIndexFromEvent(event);
    const eventOuterMessageId = extractOuterMessageIdFromEvent(event);
    const eventTriggerMessageId = extractTriggerMessageIdFromEvent(event);
    const eventTranscriptAnchorKind = extractTranscriptAnchorKindFromEvent(event);
    const eventTranscriptAnchorMessageId = extractTranscriptAnchorMessageIdFromEvent(event);
    const eventTranscriptAnchorToolBlockIndex =
      extractTranscriptAnchorToolBlockIndexFromEvent(event);

    // Process based on event type
    switch (event.event_type) {
      case 'llm_request_start': {
        if (!eventTaskName || !updatedChat.model) {
          updatedChat.model = event.data.model;
          updatedChat.base_model = event.data.base_model;
        }
        updatedChat.request_count++;

        const requestId = eventUpstreamRequestId || eventDebugRequestId || event.event_id;
        const existingRequest = requests.get(requestId) || findRequestByIdentity(requests, {
          upstreamRequestId: eventUpstreamRequestId,
          debugRequestId: eventDebugRequestId,
        });
        const request: LLMRequest = existingRequest || {
          request_id: requestId,
          chat_id: event.chat_id,
          session_id: event.session_id,
          timestamp: event.timestamp,
          model: event.data.model,
          base_model: event.data.base_model,
          messages: [],
          parameters: {},
          raw_payload: {},
          transformed_payloads: [],
          status: 'pending',
          tool_ids: [],
          skills: [],
        };
        rekeyRequest(requests, request, requestId);
        request.chat_id = event.chat_id;
        request.session_id = event.session_id;
        request.timestamp = event.timestamp;
        request.model = event.data.model;
        request.base_model = event.data.base_model ?? request.base_model;
        request.status = request.status === 'complete' || request.status === 'streaming'
          ? request.status
          : 'pending';
        request.tool_ids = event.data.tool_ids || [];
        request.skills = event.data.skills || [];
        updateRequestIdentity(request, {
          messageId: extractMessageIdFromMetadata(event.data.metadata),
          debugRequestId: eventDebugRequestId,
          upstreamRequestId: eventUpstreamRequestId,
          taskName: eventTaskName,
          requestPhase: eventRequestPhase,
          followupIndex: eventFollowupIndex,
          outerMessageId: eventOuterMessageId,
          triggerMessageId: eventTriggerMessageId,
          transcriptAnchorKind: eventTranscriptAnchorKind,
          transcriptAnchorMessageId: eventTranscriptAnchorMessageId,
          transcriptAnchorToolBlockIndex: eventTranscriptAnchorToolBlockIndex,
        });
        requests.set(request.request_id, request);
        break;
      }

      case 'llm_request_payload': {
        let request = findRequestByIdentity(requests, {
          upstreamRequestId: eventUpstreamRequestId,
          debugRequestId: eventDebugRequestId,
        });
        if (!request && !eventUpstreamRequestId && !eventDebugRequestId) {
          if (event.chat_id === 'unknown') {
            request = Array.from(requests.values())
              .reverse()
              .find((r) => r.status === 'pending');
          } else {
            request = Array.from(requests.values())
              .reverse()
              .find((r) => r.chat_id === event.chat_id && r.status === 'pending');
          }
        }

        if (!request) {
          if (event.chat_id === 'unknown') {
            break;
          }
          request = createRequestShell(event, event.data.model || 'unknown', {
            baseModel: event.data.base_model,
            messageId: extractMessageIdFromPayload(event.data.raw_payload),
            debugRequestId: eventDebugRequestId,
            upstreamRequestId: eventUpstreamRequestId,
            taskName: eventTaskName,
            requestPhase: eventRequestPhase,
            followupIndex: eventFollowupIndex,
            outerMessageId: eventOuterMessageId,
            triggerMessageId: eventTriggerMessageId,
            transcriptAnchorKind: eventTranscriptAnchorKind,
            transcriptAnchorMessageId: eventTranscriptAnchorMessageId,
            transcriptAnchorToolBlockIndex: eventTranscriptAnchorToolBlockIndex,
          });
          if (!eventTaskName || !updatedChat.model) {
            updatedChat.model = event.data.model;
            updatedChat.base_model = event.data.base_model;
          }
          updatedChat.request_count++;
        }

        rekeyRequest(
          requests,
          request,
          request.upstream_request_id || eventUpstreamRequestId || request.debug_request_id || eventDebugRequestId || request.request_id
        );
        request.chat_id = event.chat_id;
        request.session_id = event.session_id;
        request.timestamp = request.timestamp || event.timestamp;
        // Update request with payload data
        request.messages = event.data.messages || [];
        request.tools = event.data.tools;
        request.base_model = event.data.base_model || request.base_model;
        updateRequestIdentity(request, {
          messageId: extractMessageIdFromPayload(event.data.raw_payload),
          debugRequestId: eventDebugRequestId,
          upstreamRequestId: eventUpstreamRequestId,
          taskName: eventTaskName,
          requestPhase: eventRequestPhase,
          followupIndex: eventFollowupIndex,
          outerMessageId: eventOuterMessageId,
          triggerMessageId: eventTriggerMessageId,
          transcriptAnchorKind: eventTranscriptAnchorKind,
          transcriptAnchorMessageId: eventTranscriptAnchorMessageId,
          transcriptAnchorToolBlockIndex: eventTranscriptAnchorToolBlockIndex,
        });
        request.parameters = {
          temperature: event.data.temperature,
          max_tokens: event.data.max_tokens,
          // Handle both old (string) and new (object) reasoning formats
          reasoning_effort: (event.data.reasoning_config?.ui_effort
            || event.data.reasoning_effort) as LLMRequest['parameters']['reasoning_effort'],
          reasoning_config: event.data.reasoning_config as ReasoningConfig | undefined,
        };
        request.raw_payload = event.data.raw_payload || {};
        request.status = 'streaming';
        requests.set(request.request_id, request);
        break;
      }

      case 'llm_response_complete': {
        let request = findRequestByIdentity(requests, {
          upstreamRequestId: eventUpstreamRequestId,
          debugRequestId: eventDebugRequestId,
        });
        if (!request && !eventUpstreamRequestId && !eventDebugRequestId) {
          if (event.chat_id === 'unknown') {
            request = Array.from(requests.values())
              .reverse()
              .find((r) => r.status === 'pending' || r.status === 'streaming');
          } else {
            request = Array.from(requests.values())
              .reverse()
              .find((r) => r.chat_id === event.chat_id && (r.status === 'pending' || r.status === 'streaming'));
          }
        }
        if (!request && (eventUpstreamRequestId || eventDebugRequestId) && event.chat_id !== 'unknown') {
          request = createRequestShell(event, event.data.model || 'unknown', {
            debugRequestId: eventDebugRequestId,
            upstreamRequestId: eventUpstreamRequestId,
            taskName: eventTaskName,
            requestPhase: eventRequestPhase,
            followupIndex: eventFollowupIndex,
            outerMessageId: eventOuterMessageId,
            triggerMessageId: eventTriggerMessageId,
            transcriptAnchorKind: eventTranscriptAnchorKind,
            transcriptAnchorMessageId: eventTranscriptAnchorMessageId,
            transcriptAnchorToolBlockIndex: eventTranscriptAnchorToolBlockIndex,
          });
          updatedChat.request_count++;
        }

        if (request) {
          rekeyRequest(
            requests,
            request,
            request.upstream_request_id || eventUpstreamRequestId || request.debug_request_id || eventDebugRequestId || request.request_id
          );
          updateRequestIdentity(request, {
            debugRequestId: eventDebugRequestId,
            upstreamRequestId: eventUpstreamRequestId,
            taskName: eventTaskName,
            requestPhase: eventRequestPhase,
            followupIndex: eventFollowupIndex,
            outerMessageId: eventOuterMessageId,
            triggerMessageId: eventTriggerMessageId,
            transcriptAnchorKind: eventTranscriptAnchorKind,
            transcriptAnchorMessageId: eventTranscriptAnchorMessageId,
            transcriptAnchorToolBlockIndex: eventTranscriptAnchorToolBlockIndex,
          });
          request.status = 'complete';
          request.duration_ms = event.data.duration_ms;
          request.response = {
            content: event.data.response_content || '',
            tool_calls: event.data.tool_calls || [],
            finish_reason: event.data.finish_reason,
            usage: event.data.usage as LLMUsage,
            thinking: event.data.thinking_content || '',
            ultra_audit: event.data.ultra_audit,
          };
          requests.set(request.request_id, request);
        }
        break;
      }

      case 'llm_request_transformed': {
        const transformedData = event.data as {
          model?: string;
          payload: Record<string, unknown>;
          api_path: string;
          provider_headers_redacted?: Record<string, string>;
        };
        const transformedModel = transformedData.model;
        const transformedMessageId = event.message_id;
        const transformedUpstreamRequestId = eventUpstreamRequestId;
        const transformedDebugRequestId = eventDebugRequestId;
        let transformedRequest = findRequestByIdentity(requests, {
          upstreamRequestId: transformedUpstreamRequestId,
          debugRequestId: transformedDebugRequestId,
        });
        if (!transformedRequest && !transformedUpstreamRequestId && !transformedDebugRequestId) {
          transformedRequest = Array.from(requests.values())
            .reverse()
            .find(
              (r) =>
                r.chat_id === event.chat_id &&
                (r.status === 'streaming' || r.status === 'pending' || r.status === 'complete') &&
                requestMatchesTransformedEvent(
                  r,
                  transformedModel,
                  transformedMessageId,
                  transformedUpstreamRequestId,
                  transformedDebugRequestId
                )
            );
        }
        if (!transformedRequest && (transformedUpstreamRequestId || transformedDebugRequestId) && event.chat_id !== 'unknown') {
          transformedRequest = createRequestShell(event, transformedModel || 'unknown', {
            messageId: transformedMessageId || extractMessageIdFromPayload(transformedData.payload),
            debugRequestId: transformedDebugRequestId,
            upstreamRequestId: transformedUpstreamRequestId,
            taskName: eventTaskName || extractTaskNameFromPayload(transformedData.payload),
            requestPhase: eventRequestPhase,
            followupIndex: eventFollowupIndex,
            outerMessageId: eventOuterMessageId,
            triggerMessageId: eventTriggerMessageId,
            transcriptAnchorKind: eventTranscriptAnchorKind,
            transcriptAnchorMessageId: eventTranscriptAnchorMessageId,
            transcriptAnchorToolBlockIndex: eventTranscriptAnchorToolBlockIndex,
          });
          updatedChat.request_count++;
        }
        if (transformedRequest) {
          rekeyRequest(
            requests,
            transformedRequest,
            transformedRequest.upstream_request_id
              || transformedUpstreamRequestId
              || transformedRequest.debug_request_id
              || transformedDebugRequestId
              || transformedRequest.request_id
          );
          updateRequestIdentity(transformedRequest, {
            debugRequestId: transformedDebugRequestId,
            upstreamRequestId: transformedUpstreamRequestId,
            requestPhase: eventRequestPhase,
            followupIndex: eventFollowupIndex,
            outerMessageId: eventOuterMessageId,
            triggerMessageId: eventTriggerMessageId,
            transcriptAnchorKind: eventTranscriptAnchorKind,
            transcriptAnchorMessageId: eventTranscriptAnchorMessageId,
            transcriptAnchorToolBlockIndex: eventTranscriptAnchorToolBlockIndex,
          });
          transformedRequest.transformed_payloads = upsertTransformedStage(
            transformedRequest.transformed_payloads,
            {
              event_id: event.event_id,
              api_path: transformedData.api_path,
              payload: transformedData.payload,
              provider_headers_redacted: transformedData.provider_headers_redacted,
              timestamp: event.timestamp,
            }
          );
          requests.set(transformedRequest.request_id, transformedRequest);
        }
        break;
      }

      case 'capabilities_change': {
        updatedChat.capabilities = {
          tools: event.data.tools as ActiveTool[],
          skills: event.data.skills as ActiveSkill[],
        };
        break;
      }

      case 'error': {
        let request = findRequestByIdentity(requests, {
          upstreamRequestId: eventUpstreamRequestId,
          debugRequestId: eventDebugRequestId,
        });
        if (!request && !eventUpstreamRequestId && !eventDebugRequestId) {
          request = Array.from(requests.values())
            .reverse()
            .find((r) => r.chat_id === event.chat_id && (r.status === 'pending' || r.status === 'streaming'));
        }
        if (!request && (eventUpstreamRequestId || eventDebugRequestId) && event.chat_id !== 'unknown') {
          request = createRequestShell(event, 'unknown', {
            debugRequestId: eventDebugRequestId,
            upstreamRequestId: eventUpstreamRequestId,
            taskName: eventTaskName,
            requestPhase: eventRequestPhase,
            followupIndex: eventFollowupIndex,
            outerMessageId: eventOuterMessageId,
            triggerMessageId: eventTriggerMessageId,
            transcriptAnchorKind: eventTranscriptAnchorKind,
            transcriptAnchorMessageId: eventTranscriptAnchorMessageId,
            transcriptAnchorToolBlockIndex: eventTranscriptAnchorToolBlockIndex,
          });
          updatedChat.request_count++;
        }

        if (request) {
          rekeyRequest(
            requests,
            request,
            request.upstream_request_id || eventUpstreamRequestId || request.debug_request_id || eventDebugRequestId || request.request_id
          );
          updateRequestIdentity(request, {
            debugRequestId: eventDebugRequestId,
            upstreamRequestId: eventUpstreamRequestId,
            taskName: eventTaskName,
            requestPhase: eventRequestPhase,
            followupIndex: eventFollowupIndex,
            outerMessageId: eventOuterMessageId,
            triggerMessageId: eventTriggerMessageId,
          });
          request.status = 'error';
          requests.set(request.request_id, request);
        }
        break;
      }
    }

    // Update state
    const newChats = new Map(chats);
    newChats.set(event.chat_id, updatedChat);

    set({
      chats: newChats,
      requests: new Map(requests),
    });

    // Auto-select first chat if none selected
    if (!get().selectedChatId && newChats.size > 0) {
      set({ selectedChatId: event.chat_id, selectionOrigin: 'auto' });
    }
  },
}));

// Selectors
export const useSelectedChat = () => {
  const selectedChatId = useEventStore((state) => state.selectedChatId);
  const chats = useEventStore((state) => state.chats);
  return selectedChatId ? chats.get(selectedChatId) : null;
};

export const useSelectedRequest = () => {
  const selectedRequestId = useEventStore((state) => state.selectedRequestId);
  const requests = useEventStore((state) => state.requests);
  return selectedRequestId ? requests.get(selectedRequestId) : null;
};

export const useChatRequests = (chatId: string | null) => {
  const requests = useEventStore((state) => state.requests);
  if (!chatId) return [];
  return Array.from(requests.values())
    .filter((r) => r.chat_id === chatId)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
};
