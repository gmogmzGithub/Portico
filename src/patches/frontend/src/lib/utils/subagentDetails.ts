export const SUBAGENT_DETAILS_CONTEXT = 'portico-subagent-tool-call-details';

export interface SubagentToolCallDetail {
	chatId: string;
	toolCallCount: number | null;
	displayTokens: number | null;
}

export type SubagentToolCallDetails = Record<string, SubagentToolCallDetail>;

const toNonNegativeInteger = (value: unknown): number | null => {
	const numeric = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : null;
};

export const normalizeSubagentToolCallDetails = (value: unknown): SubagentToolCallDetails => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

	const details: SubagentToolCallDetails = {};
	for (const [toolCallIdValue, detailValue] of Object.entries(value)) {
		const toolCallId = String(toolCallIdValue ?? '').trim();
		if (!toolCallId || !detailValue || typeof detailValue !== 'object') continue;
		const detail = detailValue as Record<string, unknown>;
		const chatId = String(detail.chat_id ?? detail.chatId ?? '').trim();
		if (!chatId) continue;
		details[toolCallId] = {
			chatId,
			toolCallCount: toNonNegativeInteger(detail.tool_call_count ?? detail.toolCallCount),
			displayTokens: toNonNegativeInteger(detail.display_tokens ?? detail.displayTokens)
		};
	}
	return details;
};

export const resolveSubagentToolCallDetail = ({
	embeddedStats,
	deferredDetail,
	isTerminal
}: {
	embeddedStats?: {
		chatId?: string | null;
		toolCallCount?: number | null;
		displayTokens?: number | null;
	} | null;
	deferredDetail?: SubagentToolCallDetail | null;
	isTerminal: boolean;
}): SubagentToolCallDetail | null => {
	const deferred = isTerminal ? deferredDetail : null;
	const chatId = String(embeddedStats?.chatId ?? deferred?.chatId ?? '').trim();
	if (!chatId) return null;

	const embeddedToolCallCount = toNonNegativeInteger(embeddedStats?.toolCallCount);
	const embeddedDisplayTokens = toNonNegativeInteger(embeddedStats?.displayTokens);
	return {
		chatId,
		toolCallCount:
			embeddedToolCallCount !== null &&
			(embeddedToolCallCount > 0 ||
				deferred?.toolCallCount === null ||
				deferred?.toolCallCount === undefined)
				? embeddedToolCallCount
				: (deferred?.toolCallCount ?? embeddedToolCallCount),
		displayTokens:
			embeddedDisplayTokens && embeddedDisplayTokens > 0
				? embeddedDisplayTokens
				: (deferred?.displayTokens ?? embeddedDisplayTokens)
	};
};
