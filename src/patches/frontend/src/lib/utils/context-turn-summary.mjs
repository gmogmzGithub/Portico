// Pure helpers for the composer context gauge: normalize the Electron host's
// per-turn usage summary and pick the value that represents true context
// occupancy. Kept dependency-free so behavioral tests can bundle this module
// directly (see tests/test_context_turn_summary_frontend.cjs).

const toNonNegativeInteger = (value) => {
	const parsed = Number.parseInt(String(value ?? ''), 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return 0;
	}
	return parsed;
};

export const createEmptyChatTurnSummary = () => ({
	promptTokens: 0,
	contextTokens: 0,
	requestCount: 0
});

export const normalizeChatTurnSummary = (summary) => {
	const promptTokens = toNonNegativeInteger(summary?.promptTokens);
	const contextTokens = toNonNegativeInteger(summary?.contextTokens);
	return {
		promptTokens,
		// Older Electron hosts predate the contextTokens field; fall back to
		// the legacy peak-billed figure so the gauge keeps working.
		contextTokens: contextTokens > 0 ? contextTokens : promptTokens,
		requestCount: toNonNegativeInteger(summary?.requestCount)
	};
};

// Chooses what the context gauge shows. Order: the host turn summary's
// occupancy figure (bridge-side estimate, immune to pro-mode billing
// inflation), then its legacy billed figure, then the newest usage found in
// chat history (old chats with no reporting events).
export const deriveContextUsage = ({ turnSummary, historyUsage }) => {
	const contextTokens = toNonNegativeInteger(turnSummary?.contextTokens);
	if (contextTokens > 0) {
		return { prompt_tokens: contextTokens };
	}
	const promptTokens = toNonNegativeInteger(turnSummary?.promptTokens);
	if (promptTokens > 0) {
		return { prompt_tokens: promptTokens };
	}
	return historyUsage ?? null;
};
