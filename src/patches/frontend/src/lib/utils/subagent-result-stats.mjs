import { resolveSubagentDisplayTokenCount } from './subagent-tokens.mjs';

function toPositiveInteger(value) {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return Math.max(0, Math.floor(value));
	}

	if (typeof value === 'string') {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) {
			return Math.max(0, Math.floor(parsed));
		}
	}

	return null;
}

export function parseSubagentResultPayload(value) {
	let parsed = value;

	for (let depth = 0; depth < 3; depth += 1) {
		if (typeof parsed !== 'string') {
			break;
		}

		const trimmed = parsed.trim();
		if (!trimmed) {
			return null;
		}

		try {
			parsed = JSON.parse(trimmed);
		} catch (error) {
			return null;
		}
	}

	return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

export function extractSubagentResultStats(value) {
	const parsed = parseSubagentResultPayload(value);
	if (!parsed) {
		return null;
	}

	const chatId =
		typeof parsed.chat_id === 'string' && parsed.chat_id.trim() && !parsed.chat_id.startsWith('local:')
			? parsed.chat_id.trim()
			: null;
	const toolCallCount = toPositiveInteger(parsed.tool_call_count);
	const usageTokens = toPositiveInteger(parsed.usage_tokens);
	const contextTokens = toPositiveInteger(parsed.context_tokens);
	const maxContextTokens = toPositiveInteger(parsed.max_context_tokens);
	const displayTokens = resolveSubagentDisplayTokenCount({
		contextTokens,
		maxContextTokens,
		usageTokens
	});

	return {
		parsed,
		chatId,
		toolCallCount,
		usageTokens,
		contextTokens,
		maxContextTokens,
		displayTokens
	};
}
