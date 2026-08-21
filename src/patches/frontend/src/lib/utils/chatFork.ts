// PORTICO PATCH (fork-chat): pure helpers for forking a chat at a specific
// assistant message. Must stay free of runtime imports — the unit test
// (tests/chat-fork.unit.test.js) bundles this file standalone.

export type ForkSourceHistory = {
	messages?: Record<string, Record<string, any>> | null;
	currentId?: string | null;
	[key: string]: unknown;
};

export type ForkedHistory = {
	messages: Record<string, Record<string, any>>;
	currentId: string;
};

export type ForkedHistoryResult = {
	history: ForkedHistory;
	messageIds: string[];
};

export type ForkedChatPayloadInput = {
	history: ForkSourceHistory | null | undefined;
	messageId: string;
	id: string;
	title: string;
	models?: string[] | null;
	system?: string;
	params?: Record<string, any> | null;
	files?: any[] | null;
	sourceChatId?: string | null;
	timestamp: number;
};

const cloneMessage = (message: Record<string, any>): Record<string, any> | null => {
	try {
		return JSON.parse(JSON.stringify(message));
	} catch {
		return null;
	}
};

export const buildForkedHistory = (
	history: ForkSourceHistory | null | undefined,
	messageId: string
): ForkedHistoryResult | null => {
	const messages = history?.messages;
	if (!messages || typeof messages !== 'object' || !messages[messageId]) {
		return null;
	}

	const messageIds: string[] = [];
	const visited = new Set<string>();
	let walkId: string | null = messageId;
	while (walkId !== null && walkId !== undefined) {
		if (visited.has(walkId)) {
			return null;
		}
		visited.add(walkId);
		messageIds.unshift(walkId);
		const parentId = messages[walkId]?.parentId ?? null;
		if (parentId !== null && !messages[parentId]) {
			break;
		}
		walkId = parentId;
	}

	const forkedMessages: Record<string, Record<string, any>> = {};
	for (let index = 0; index < messageIds.length; index += 1) {
		const id = messageIds[index];
		const copy = cloneMessage(messages[id]);
		if (!copy) {
			return null;
		}
		copy.childrenIds = index < messageIds.length - 1 ? [messageIds[index + 1]] : [];
		forkedMessages[id] = copy;
	}

	// Collapse multi-model turns onto the kept branch's model so the fork
	// renders as a single-response thread instead of a MultiResponseMessages
	// grid whose other columns no longer exist.
	for (let index = 0; index < messageIds.length - 1; index += 1) {
		const copy = forkedMessages[messageIds[index]];
		if (!Array.isArray(copy?.models) || copy.models.length <= 1) {
			continue;
		}
		const child = forkedMessages[messageIds[index + 1]];
		if (typeof child?.model === 'string' && child.model.length > 0) {
			copy.models = [child.model];
			if (child.modelIdx !== undefined) {
				child.modelIdx = 0;
			}
		}
	}

	return {
		history: { messages: forkedMessages, currentId: messageId },
		messageIds
	};
};

export const buildForkedChatPayload = (
	input: ForkedChatPayloadInput
): Record<string, any> | null => {
	const fork = buildForkedHistory(input?.history, input?.messageId);
	if (!fork) {
		return null;
	}

	return {
		id: input.id,
		title: input.title,
		models: Array.isArray(input.models) ? input.models : [],
		...(input.system !== undefined ? { system: input.system } : {}),
		params: input.params ?? {},
		history: fork.history,
		messages: fork.messageIds.map((id) => fork.history.messages[id]),
		files: Array.isArray(input.files) ? input.files : [],
		tags: [],
		timestamp: input.timestamp,
		originalChatId: input.sourceChatId ?? null,
		branchPointMessageId: input.messageId
	};
};
