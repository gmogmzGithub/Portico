export function resolveSubagentPollingMode({ hasToolCallId, isDone, open }) {
	if (!hasToolCallId || isDone) {
		return null;
	}

	return open ? 'foreground' : 'background';
}

export function resolveSubagentLookupResult({ previousChatId = null, lookupPayload }) {
	const rawChatId = lookupPayload?.chat_id;
	const nextChatId =
		typeof rawChatId === 'string' && rawChatId.trim().length > 0 ? rawChatId.trim() : null;

	return {
		nextChatId,
		shouldFetchStats: !!nextChatId && nextChatId !== previousChatId
	};
}
