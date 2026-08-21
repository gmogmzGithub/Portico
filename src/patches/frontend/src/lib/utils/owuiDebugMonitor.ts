export const OWUI_DEBUG_MONITOR_BASE_URL = 'http://localhost:8879';

export type DebugMonitorAccess = {
	baseUrl?: string;
	token?: string;
};

export type DebugMonitorUsage = {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
	cached_tokens?: number;
};

export type DebugMonitorTranscriptAnchorKind =
	| 'user_message'
	| 'assistant_tool_block'
	| 'background';

export type DebugMonitorRequestSummary = {
	request_id: string;
	timestamp: string;
	chat_id?: string;
	message_id?: string;
	debug_request_id?: string;
	upstream_request_id?: string;
	model: string;
	base_model?: string;
	task_name?: string;
	is_auxiliary?: boolean;
	request_phase?: string;
	followup_index?: number;
	outer_message_id?: string;
	trigger_message_id?: string;
	transcript_anchor_kind?: DebugMonitorTranscriptAnchorKind;
	transcript_anchor_message_id?: string;
	transcript_anchor_tool_block_index?: number;
	message_count: number;
	tool_count: number;
	status: 'pending' | 'streaming' | 'complete' | 'error';
	duration_ms?: number;
	usage?: DebugMonitorUsage;
};

export type DebugMonitorRequestDetail = {
	request: {
		request_id: string;
		chat_id?: string;
		model: string;
		base_model?: string;
		request_phase?: string;
		followup_index?: number;
		outer_message_id?: string;
		trigger_message_id?: string;
		transcript_anchor_kind?: DebugMonitorTranscriptAnchorKind;
		transcript_anchor_message_id?: string;
		transcript_anchor_tool_block_index?: number;
		raw_payload?: Record<string, unknown>;
		transformed_payloads?: Array<{
			payload?: Record<string, unknown>;
			api_path?: string;
		}>;
	};
};

export type DebugMonitorEvent = {
	event_id: string;
	event_type: string;
	timestamp: string;
	chat_id?: string;
	message_id?: string;
	debug_request_id?: string;
	upstream_request_id?: string;
	task_name?: string;
	request_phase?: string;
	followup_index?: number;
	outer_message_id?: string;
	trigger_message_id?: string;
	transcript_anchor_kind?: DebugMonitorTranscriptAnchorKind;
	transcript_anchor_message_id?: string;
	transcript_anchor_tool_block_index?: number;
	data?: Record<string, any>;
};

type DebugMonitorHistoryMessage = {
	id?: string;
	role?: string;
	parentId?: string | null;
	contentBlocks?: Array<Record<string, unknown>>;
};

export type DebugMarkerPlacement =
	| { kind: 'after_message'; messageId: string }
	| { kind: 'after_tool_block'; messageId: string; toolBlockIndex: number }
	| { kind: 'background' };

function safeNumber(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === 'string' && value.trim() !== '') {
		const parsed = Number.parseInt(value, 10);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
	for (const value of values) {
		if (value !== undefined) {
			return value;
		}
	}
	return undefined;
}

function normalizeDebugMonitorBaseUrl(access?: DebugMonitorAccess): string {
	const baseUrl = typeof access?.baseUrl === 'string' ? access.baseUrl.trim() : '';
	return baseUrl || OWUI_DEBUG_MONITOR_BASE_URL;
}

function normalizeDebugMonitorToken(access?: DebugMonitorAccess): string {
	return typeof access?.token === 'string' ? access.token.trim() : '';
}

function getDebugMonitorFetchOptions(access?: DebugMonitorAccess): RequestInit | undefined {
	const token = normalizeDebugMonitorToken(access);
	return token
		? {
				headers: {
					'X-Debug-Monitor-Token': token
				}
			}
		: undefined;
}

function getEventMetadata(event: DebugMonitorEvent): Record<string, unknown> | undefined {
	return typeof event?.data?.metadata === 'object' && event.data.metadata
		? (event.data.metadata as Record<string, unknown>)
		: undefined;
}

function getEventRawPayload(event: DebugMonitorEvent): Record<string, unknown> | undefined {
	return typeof event?.data?.raw_payload === 'object' && event.data.raw_payload
		? (event.data.raw_payload as Record<string, unknown>)
		: undefined;
}

function getEventPayload(event: DebugMonitorEvent): Record<string, unknown> | undefined {
	return typeof event?.data?.payload === 'object' && event.data.payload
		? (event.data.payload as Record<string, unknown>)
		: undefined;
}

function getEventPayloadMetadata(event: DebugMonitorEvent): Record<string, unknown> | undefined {
	const payload = getEventPayload(event);
	return typeof payload?.metadata === 'object' && payload.metadata
		? (payload.metadata as Record<string, unknown>)
		: undefined;
}

function extractStringFromMetadata(metadata: unknown, key: string): string | undefined {
	if (!metadata || typeof metadata !== 'object') {
		return undefined;
	}
	const value = (metadata as Record<string, unknown>)[key];
	return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function normalizeTranscriptAnchorKind(
	value: unknown,
): DebugMonitorTranscriptAnchorKind | undefined {
	return value === 'user_message' ||
		value === 'assistant_tool_block' ||
		value === 'background'
		? value
		: undefined;
}

export function resolveDebugMonitorRequestId(event: DebugMonitorEvent): string {
	return (
		event.upstream_request_id ||
		extractStringFromMetadata(getEventMetadata(event), 'upstream_request_id') ||
		extractStringFromMetadata(getEventPayloadMetadata(event), 'upstream_request_id') ||
		event.debug_request_id ||
		extractStringFromMetadata(getEventMetadata(event), 'debug_request_id') ||
		extractStringFromMetadata(getEventPayloadMetadata(event), 'debug_request_id') ||
		event.event_id
	);
}

export function normalizeDebugMonitorRequestSummary(
	value: Record<string, any>,
): DebugMonitorRequestSummary {
	return {
		request_id: String(value?.request_id || ''),
		timestamp: String(value?.timestamp || ''),
		chat_id: typeof value?.chat_id === 'string' ? value.chat_id : undefined,
		message_id: typeof value?.message_id === 'string' ? value.message_id : undefined,
		debug_request_id:
			typeof value?.debug_request_id === 'string' ? value.debug_request_id : undefined,
		upstream_request_id:
			typeof value?.upstream_request_id === 'string' ? value.upstream_request_id : undefined,
		model: typeof value?.model === 'string' && value.model ? value.model : 'unknown',
		base_model: typeof value?.base_model === 'string' ? value.base_model : undefined,
		task_name: typeof value?.task_name === 'string' ? value.task_name : undefined,
		is_auxiliary: Boolean(value?.is_auxiliary),
		request_phase:
			typeof value?.request_phase === 'string' ? value.request_phase : undefined,
		followup_index: safeNumber(value?.followup_index),
		outer_message_id:
			typeof value?.outer_message_id === 'string' ? value.outer_message_id : undefined,
		trigger_message_id:
			typeof value?.trigger_message_id === 'string' ? value.trigger_message_id : undefined,
		transcript_anchor_kind: normalizeTranscriptAnchorKind(
			value?.transcript_anchor_kind,
		),
		transcript_anchor_message_id:
			typeof value?.transcript_anchor_message_id === 'string'
				? value.transcript_anchor_message_id
				: undefined,
		transcript_anchor_tool_block_index: safeNumber(
			value?.transcript_anchor_tool_block_index,
		),
		message_count: safeNumber(value?.message_count) ?? 0,
		tool_count: safeNumber(value?.tool_count) ?? 0,
		status:
			value?.status === 'complete' || value?.status === 'error' || value?.status === 'streaming'
				? value.status
				: 'pending',
		duration_ms: safeNumber(value?.duration_ms),
		usage: typeof value?.usage === 'object' && value.usage ? value.usage : undefined
	};
}

export async function fetchChatDebugRequests(
	chatId: string,
	access?: DebugMonitorAccess
): Promise<DebugMonitorRequestSummary[]> {
	const response = await fetch(
		`${normalizeDebugMonitorBaseUrl(access)}/api/chats/${encodeURIComponent(chatId)}/requests?limit=200`,
		getDebugMonitorFetchOptions(access)
	);
	if (!response.ok) {
		throw new Error(`Debug monitor request list failed: ${response.status}`);
	}
	const payload = await response.json();
	return Array.isArray(payload?.requests)
		? payload.requests.map((request) => normalizeDebugMonitorRequestSummary(request))
		: [];
}

export async function fetchDebugRequestDetail(
	requestId: string,
	access?: DebugMonitorAccess
): Promise<DebugMonitorRequestDetail> {
	const response = await fetch(
		`${normalizeDebugMonitorBaseUrl(access)}/api/requests/${encodeURIComponent(requestId)}`,
		getDebugMonitorFetchOptions(access)
	);
	if (!response.ok) {
		throw new Error(`Debug monitor request detail failed: ${response.status}`);
	}
	return response.json();
}

export function buildDebugMonitorRequestUrl({
	chatId,
	requestId,
	sidebar = 'hidden',
	access
}: {
	chatId?: string;
	requestId: string;
	sidebar?: 'hidden' | 'visible';
	access?: DebugMonitorAccess;
}): string {
	const url = new URL(normalizeDebugMonitorBaseUrl(access));
	if (chatId) {
		url.searchParams.set('chat', chatId);
	}
	url.searchParams.set('request', requestId);
	if (sidebar === 'hidden' || sidebar === 'visible') {
		url.searchParams.set('sidebar', sidebar);
	}
	const token = normalizeDebugMonitorToken(access);
	if (token) {
		url.searchParams.set('token', token);
	}
	return url.toString();
}

export function buildDebugMonitorWebSocketUrl({
	chatId,
	access
}: {
	chatId: string;
	access?: DebugMonitorAccess;
}): string {
	const url = new URL(normalizeDebugMonitorBaseUrl(access));
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	url.pathname = '/ws/events';
	url.search = new URLSearchParams({ chat_id: chatId }).toString();
	const token = normalizeDebugMonitorToken(access);
	if (token) {
		url.searchParams.set('token', token);
	}
	return url.toString();
}

export function applyDebugMonitorEventToSummary(
	existing: DebugMonitorRequestSummary | undefined,
	event: DebugMonitorEvent,
): DebugMonitorRequestSummary {
	const requestId = resolveDebugMonitorRequestId(event);
	const eventMetadata = getEventMetadata(event);
	const eventPayload = getEventPayload(event);
	const eventPayloadMetadata = getEventPayloadMetadata(event);
	const eventRawPayload = getEventRawPayload(event);
	const model =
		typeof event?.data?.model === 'string' && event.data.model
			? event.data.model
			: typeof eventPayload?.model === 'string' && eventPayload.model
				? eventPayload.model
			: existing?.model || 'unknown';
	const baseModel =
		typeof event?.data?.base_model === 'string'
			? event.data.base_model
			: typeof eventPayload?.base_model === 'string'
				? eventPayload.base_model
			: existing?.base_model;
	const requestPhase = firstDefined(
		typeof event.request_phase === 'string' ? event.request_phase : undefined,
		extractStringFromMetadata(eventMetadata, 'request_phase'),
		extractStringFromMetadata(eventPayloadMetadata, 'request_phase'),
		extractStringFromMetadata(eventRawPayload?.metadata, 'request_phase'),
		existing?.request_phase
	);
	const followupIndex = firstDefined(
		safeNumber(event.followup_index),
		safeNumber(eventMetadata?.followup_index),
		safeNumber(eventPayloadMetadata?.followup_index),
		safeNumber(eventRawPayload?.metadata?.followup_index),
		existing?.followup_index
	);
	const outerMessageId = firstDefined(
		typeof event.outer_message_id === 'string' ? event.outer_message_id : undefined,
		extractStringFromMetadata(eventMetadata, 'outer_message_id'),
		extractStringFromMetadata(eventPayloadMetadata, 'outer_message_id'),
		extractStringFromMetadata(eventRawPayload?.metadata, 'outer_message_id'),
		existing?.outer_message_id
	);
	const triggerMessageId = firstDefined(
		typeof event.trigger_message_id === 'string' ? event.trigger_message_id : undefined,
		extractStringFromMetadata(eventMetadata, 'trigger_message_id'),
		extractStringFromMetadata(eventPayloadMetadata, 'trigger_message_id'),
		extractStringFromMetadata(eventRawPayload?.metadata, 'trigger_message_id'),
		existing?.trigger_message_id
	);
	const transcriptAnchorKind = firstDefined(
		normalizeTranscriptAnchorKind(event.transcript_anchor_kind),
		normalizeTranscriptAnchorKind(extractStringFromMetadata(eventMetadata, 'transcript_anchor_kind')),
		normalizeTranscriptAnchorKind(
			extractStringFromMetadata(eventPayloadMetadata, 'transcript_anchor_kind')
		),
		normalizeTranscriptAnchorKind(
			extractStringFromMetadata(eventRawPayload?.metadata, 'transcript_anchor_kind')
		),
		existing?.transcript_anchor_kind
	);
	const transcriptAnchorMessageId = firstDefined(
		typeof event.transcript_anchor_message_id === 'string'
			? event.transcript_anchor_message_id
			: undefined,
		extractStringFromMetadata(eventMetadata, 'transcript_anchor_message_id'),
		extractStringFromMetadata(eventPayloadMetadata, 'transcript_anchor_message_id'),
		extractStringFromMetadata(
			eventRawPayload?.metadata,
			'transcript_anchor_message_id'
		),
		existing?.transcript_anchor_message_id
	);
	const transcriptAnchorToolBlockIndex = firstDefined(
		safeNumber(event.transcript_anchor_tool_block_index),
		safeNumber(eventMetadata?.transcript_anchor_tool_block_index),
		safeNumber(eventPayloadMetadata?.transcript_anchor_tool_block_index),
		safeNumber(eventRawPayload?.metadata?.transcript_anchor_tool_block_index),
		existing?.transcript_anchor_tool_block_index
	);
	const messageId = firstDefined(
		typeof event.message_id === 'string' ? event.message_id : undefined,
		extractStringFromMetadata(eventMetadata, 'message_id'),
		extractStringFromMetadata(eventPayloadMetadata, 'message_id'),
		extractStringFromMetadata(eventRawPayload?.metadata, 'message_id'),
		existing?.message_id
	);
	const debugRequestId = firstDefined(
		typeof event.debug_request_id === 'string' ? event.debug_request_id : undefined,
		extractStringFromMetadata(eventMetadata, 'debug_request_id'),
		extractStringFromMetadata(eventPayloadMetadata, 'debug_request_id'),
		existing?.debug_request_id
	);
	const upstreamRequestId = firstDefined(
		typeof event.upstream_request_id === 'string' ? event.upstream_request_id : undefined,
		extractStringFromMetadata(eventMetadata, 'upstream_request_id'),
		extractStringFromMetadata(eventPayloadMetadata, 'upstream_request_id'),
		existing?.upstream_request_id
	);
	const taskName = firstDefined(
		typeof event.task_name === 'string' ? event.task_name : undefined,
		extractStringFromMetadata(eventMetadata, 'task'),
		extractStringFromMetadata(eventPayloadMetadata, 'task'),
		existing?.task_name
	);

	const next: DebugMonitorRequestSummary = {
		request_id: requestId,
		timestamp: existing?.timestamp || event.timestamp || '',
		chat_id: event.chat_id || existing?.chat_id,
		message_id: messageId,
		debug_request_id: debugRequestId,
		upstream_request_id: upstreamRequestId,
		model,
		base_model: baseModel,
		task_name: taskName,
		is_auxiliary: Boolean(taskName || existing?.is_auxiliary),
		request_phase: requestPhase,
		followup_index: followupIndex,
		outer_message_id: outerMessageId,
		trigger_message_id: triggerMessageId,
		transcript_anchor_kind: transcriptAnchorKind,
		transcript_anchor_message_id: transcriptAnchorMessageId,
		transcript_anchor_tool_block_index: transcriptAnchorToolBlockIndex,
		message_count: existing?.message_count ?? 0,
		tool_count: existing?.tool_count ?? 0,
		status: existing?.status || 'pending',
		duration_ms: existing?.duration_ms,
		usage: existing?.usage,
	};

	if (event.event_type === 'llm_request_start') {
		next.message_count = safeNumber(event?.data?.message_count) ?? next.message_count;
		next.tool_count = Array.isArray(event?.data?.tool_ids)
			? event.data.tool_ids.length
			: next.tool_count;
		next.status = 'pending';
		return next;
	}

	if (event.event_type === 'llm_request_payload') {
		next.message_count = Array.isArray(event?.data?.messages)
			? event.data.messages.length
			: next.message_count;
		next.tool_count = Array.isArray(event?.data?.tools)
			? event.data.tools.length
			: next.tool_count;
		next.status = 'streaming';
		return next;
	}

	if (event.event_type === 'llm_request_transformed') {
		next.message_count = Array.isArray(eventPayload?.messages)
			? eventPayload.messages.length
			: next.message_count;
		next.tool_count = Array.isArray(eventPayload?.tools)
			? eventPayload.tools.length
			: next.tool_count;
		next.status = next.status === 'complete' || next.status === 'error' ? next.status : 'streaming';
		return next;
	}

	if (event.event_type === 'llm_response_complete') {
		next.duration_ms = safeNumber(event?.data?.duration_ms) ?? next.duration_ms;
		next.usage =
			typeof event?.data?.usage === 'object' && event.data.usage
				? event.data.usage
				: next.usage;
		next.status = 'complete';
		return next;
	}

	if (event.event_type === 'error') {
		next.status = 'error';
		return next;
	}

	return next;
}

function countToolCallBlocks(message: DebugMonitorHistoryMessage | undefined): number {
	const contentBlocks = Array.isArray(message?.contentBlocks) ? message.contentBlocks : [];
	let count = 0;
	for (const block of contentBlocks) {
		if (block?.type === 'tool_calls') {
			count += 1;
		}
	}
	return count;
}

function buildVisibleIdSet(visibleMessageIds?: Iterable<string>): Set<string> | null {
	return visibleMessageIds ? new Set(visibleMessageIds) : null;
}

function isVisibleMessageId(
	messageId: string | undefined,
	visibleIdSet: Set<string> | null,
): messageId is string {
	return Boolean(messageId && (!visibleIdSet || visibleIdSet.has(messageId)));
}

function resolveUserAnchorMessageId(
	request: Pick<
		DebugMonitorRequestSummary,
		| 'trigger_message_id'
		| 'outer_message_id'
		| 'message_id'
		| 'transcript_anchor_message_id'
	>,
	messageMap: Record<string, DebugMonitorHistoryMessage>,
	visibleIdSet: Set<string> | null,
): string | undefined {
	const resolveFromMessage = (messageId: string | undefined): string | undefined => {
		if (!messageId || !messageMap?.[messageId]) {
			return undefined;
		}
		const message = messageMap[messageId];
		if (message?.role === 'user' && isVisibleMessageId(messageId, visibleIdSet)) {
			return messageId;
		}
		const parentId =
			typeof message?.parentId === 'string' && message.parentId.trim() !== ''
				? message.parentId
				: undefined;
		if (message?.role === 'assistant' && parentId) {
			const parent = messageMap[parentId];
			if (parent?.role === 'user' && isVisibleMessageId(parentId, visibleIdSet)) {
				return parentId;
			}
		}
		return undefined;
	};

	for (const candidateId of [
		request.transcript_anchor_message_id,
		request.trigger_message_id,
		request.outer_message_id,
		request.message_id
	]) {
		const resolved = resolveFromMessage(candidateId);
		if (resolved) {
			return resolved;
		}
	}

	return undefined;
}

function resolveAssistantAnchorMessageId(
	request: Pick<
		DebugMonitorRequestSummary,
		'outer_message_id' | 'message_id' | 'transcript_anchor_message_id'
	>,
	messageMap: Record<string, DebugMonitorHistoryMessage>,
	visibleIdSet: Set<string> | null,
): string | undefined {
	for (const candidateId of [
		request.transcript_anchor_message_id,
		request.outer_message_id,
		request.message_id
	]) {
		if (!candidateId || !isVisibleMessageId(candidateId, visibleIdSet)) {
			continue;
		}
		const message = messageMap?.[candidateId];
		if (message?.role === 'assistant') {
			return candidateId;
		}
	}
	return undefined;
}

function resolveAssistantToolBlockPlacement(
	assistantAnchorMessageId: string | undefined,
	toolBlockIndex: number | undefined,
): DebugMarkerPlacement | undefined {
	if (
		assistantAnchorMessageId &&
		toolBlockIndex !== undefined &&
		toolBlockIndex >= 0
	) {
		return {
			kind: 'after_tool_block',
			messageId: assistantAnchorMessageId,
			toolBlockIndex
		};
	}
	return undefined;
}

export function resolveDebugMarkerPlacement(
	request: Pick<
		DebugMonitorRequestSummary,
		| 'request_phase'
		| 'followup_index'
		| 'trigger_message_id'
		| 'outer_message_id'
		| 'message_id'
		| 'transcript_anchor_kind'
		| 'transcript_anchor_message_id'
		| 'transcript_anchor_tool_block_index'
	>,
	messageMap: Record<string, DebugMonitorHistoryMessage>,
	visibleMessageIds?: Iterable<string>,
): DebugMarkerPlacement {
	const visibleIdSet = buildVisibleIdSet(visibleMessageIds);
	const assistantAnchorMessageId = resolveAssistantAnchorMessageId(
		request,
		messageMap,
		visibleIdSet,
	);
	const explicitAnchorKind = normalizeTranscriptAnchorKind(
		request.transcript_anchor_kind,
	);

	if (explicitAnchorKind === 'background') {
		return { kind: 'background' };
	}

	if (explicitAnchorKind === 'assistant_tool_block') {
		const toolBlockIndex = safeNumber(request.transcript_anchor_tool_block_index);
		const placement = resolveAssistantToolBlockPlacement(
			assistantAnchorMessageId,
			toolBlockIndex,
		);
		if (placement) {
			return placement;
		}
		return { kind: 'background' };
	}

	if (explicitAnchorKind === 'user_message') {
		const userAnchorMessageId = resolveUserAnchorMessageId(
			request,
			messageMap,
			visibleIdSet,
		);
		if (userAnchorMessageId) {
			return { kind: 'after_message', messageId: userAnchorMessageId };
		}
		return { kind: 'background' };
	}

	const requestPhase = String(request.request_phase ?? '').trim().toLowerCase();
	if (
		requestPhase === 'tool_followup' ||
		requestPhase === 'code_interpreter_followup'
	) {
		const toolBlockIndex = safeNumber(request.followup_index);
		const placement = resolveAssistantToolBlockPlacement(
			assistantAnchorMessageId,
			toolBlockIndex,
		);
		if (placement) {
			return placement;
		}
	}

	const userAnchorMessageId = resolveUserAnchorMessageId(
		request,
		messageMap,
		visibleIdSet,
	);
	if (userAnchorMessageId) {
		return { kind: 'after_message', messageId: userAnchorMessageId };
	}

	return { kind: 'background' };
}

export function buildDebugRequestModalPayload(detail: DebugMonitorRequestDetail): {
	requestId: string;
	model: string;
	requestPhase?: string;
	subtitle: string;
	json: string;
} {
	const request = detail?.request ?? {};
	const transformedPayloads = Array.isArray(request?.transformed_payloads)
		? request.transformed_payloads
		: [];
	const transformedPayload =
		transformedPayloads.length > 0
			? transformedPayloads[transformedPayloads.length - 1]?.payload
			: undefined;
	const payload = transformedPayload || request?.raw_payload || {};
	const subtitleParts = [
		request?.base_model || request?.model || 'unknown',
		request?.request_phase ? `phase=${request.request_phase}` : null,
		typeof request?.followup_index === 'number'
			? `followup=${request.followup_index}`
			: null,
	];

	return {
		requestId: String(request?.request_id || ''),
		model: String(request?.base_model || request?.model || 'unknown'),
		requestPhase:
			typeof request?.request_phase === 'string' ? request.request_phase : undefined,
		subtitle: subtitleParts.filter(Boolean).join(' • '),
		json: JSON.stringify(payload, null, 2),
	};
}
