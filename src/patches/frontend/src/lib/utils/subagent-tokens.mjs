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

	return 0;
}

export function clampContextTokensToWindow(contextTokens, maxContextTokens) {
	const normalizedContextTokens = toPositiveInteger(contextTokens);
	const normalizedMaxContextTokens = toPositiveInteger(maxContextTokens);

	if (normalizedContextTokens === 0) {
		return 0;
	}

	if (normalizedMaxContextTokens === 0) {
		return normalizedContextTokens;
	}

	return Math.min(normalizedContextTokens, normalizedMaxContextTokens);
}

export function resolveSubagentDisplayTokenCount({
	contextTokens,
	maxContextTokens,
	usageTokens,
	approximateTokens
} = {}) {
	const normalizedContextTokens = clampContextTokensToWindow(contextTokens, maxContextTokens);
	if (normalizedContextTokens > 0) {
		return normalizedContextTokens;
	}

	const normalizedUsageTokens = toPositiveInteger(usageTokens);
	if (normalizedUsageTokens > 0) {
		return normalizedUsageTokens;
	}

	const normalizedApproximateTokens = toPositiveInteger(approximateTokens);
	if (normalizedApproximateTokens > 0) {
		return normalizedApproximateTokens;
	}

	return null;
}
