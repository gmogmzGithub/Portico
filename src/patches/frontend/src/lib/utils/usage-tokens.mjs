function toFiniteNumber(value, fallback = 0) {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}

	if (typeof value === 'string') {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}

	return fallback;
}

function toInteger(value, fallback = 0) {
	return Math.max(0, Math.floor(toFiniteNumber(value, fallback)));
}

export function getDisplayTokenCountFromUsage(usage = {}) {
	if (!usage || typeof usage !== 'object') {
		return 0;
	}

	// Some flows (e.g. ULTRA multi-agent) report cumulative prompt_tokens for
	// spend alongside a non-cumulative context_tokens for occupancy; the
	// latter is the context-style counter.
	const contextTokens = toInteger(usage.context_tokens ?? usage.contextTokens);
	if (contextTokens > 0) {
		return contextTokens;
	}

	const promptTokens = toInteger(
		usage.prompt_tokens ?? usage.promptTokens ?? usage.input_tokens ?? usage.inputTokens
	);
	const completionTokens = toInteger(
		usage.completion_tokens ??
			usage.completionTokens ??
			usage.output_tokens ??
			usage.outputTokens
	);
	const totalTokens = toInteger(usage.total_tokens ?? usage.totalTokens);

	// For context-style displays, prompt/input tokens are the relevant counter.
	// Total tokens can legitimately exceed the context window because it includes output
	// tokens, so prefer prompt/input tokens when available.
	if (promptTokens > 0) {
		return promptTokens;
	}

	if (totalTokens > 0) {
		return totalTokens;
	}

	return Math.max(promptTokens, completionTokens);
}

export function getLatestContextUsageFromHistory(messages = {}, currentMessageId = null) {
	if (!messages || typeof messages !== 'object' || Array.isArray(messages)) {
		return undefined;
	}

	let activeMessageId = String(currentMessageId ?? '').trim();
	const visitedMessageIds = new Set();

	while (activeMessageId && !visitedMessageIds.has(activeMessageId)) {
		visitedMessageIds.add(activeMessageId);
		const message = messages[activeMessageId];
		if (!message || typeof message !== 'object' || Array.isArray(message)) {
			return undefined;
		}

		if (
			message.role === 'assistant' &&
			getDisplayTokenCountFromUsage(message.usage) > 0
		) {
			return message.usage;
		}

		activeMessageId =
			typeof message.parentId === 'string' ? message.parentId.trim() : '';
	}

	return undefined;
}

export function getDisplayContextTokenCount({
	usage,
	persistedContextTokens = 0,
	persistedMaxContextTokens = 0
} = {}) {
	const liveUsageTokens = getDisplayTokenCountFromUsage(usage);
	const cappedLiveUsageTokens =
		toInteger(persistedMaxContextTokens) > 0
			? Math.min(liveUsageTokens, toInteger(persistedMaxContextTokens))
			: liveUsageTokens;

	if (cappedLiveUsageTokens > 0) {
		return cappedLiveUsageTokens;
	}

	return toInteger(persistedContextTokens);
}
