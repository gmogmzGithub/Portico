const normalizeModelId = (value: unknown): string | null => {
	const normalized = `${value ?? ''}`.trim();
	return normalized && normalized !== 'null' && normalized !== 'undefined' ? normalized : null;
};

/** Resolve the latest assistant model on the active branch of a full or lightweight chat row. */
export const resolveSidebarChatModelId = (chatRow: any): string | null => {
	const lightweightModelId = normalizeModelId(chatRow?.model_id);
	if (lightweightModelId) {
		return lightweightModelId;
	}

	const chat = chatRow?.chat ?? chatRow ?? {};
	const history = chat?.history ?? {};
	const messages = history?.messages ?? {};
	let messageId = history?.currentId;
	const visited = new Set<string>();

	while (messageId && messages?.[messageId] && !visited.has(messageId)) {
		visited.add(messageId);
		const message = messages[messageId];
		if (message?.role === 'assistant') {
			const responseModelId = normalizeModelId(message?.model);
			if (responseModelId) {
				return responseModelId;
			}
		}
		messageId = message?.parentId;
	}

	const primaryModels = chat?.models ?? chatRow?.models;
	return normalizeModelId(Array.isArray(primaryModels) ? primaryModels[0] : null) ??
		normalizeModelId(chat?.model ?? chatRow?.model);
};
