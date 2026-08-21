type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
	value !== null && typeof value === 'object' && !Array.isArray(value);

const stableValue = (value: unknown): unknown => {
	if (Array.isArray(value)) {
		return value.map(stableValue);
	}
	if (!isRecord(value)) {
		return value;
	}

	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, stableValue(value[key])])
	);
};

const stableFingerprint = (value: unknown): string => {
	try {
		return JSON.stringify(stableValue(value)) ?? String(value);
	} catch {
		return String(value);
	}
};

const executionId = (toolCall: unknown): string => {
	if (!isRecord(toolCall)) return '';
	for (const key of ['id', 'tool_call_id', 'call_id']) {
		const value = toolCall[key];
		if (typeof value === 'string' && value.trim()) return value.trim();
	}
	return '';
};

const mergeDefinedRecord = (existing: UnknownRecord, incoming: UnknownRecord): UnknownRecord => {
	const merged: UnknownRecord = { ...existing };
	for (const [key, value] of Object.entries(incoming)) {
		if (value === undefined || (value === null && merged[key] != null)) continue;
		if (isRecord(merged[key]) && isRecord(value)) {
			merged[key] = mergeDefinedRecord(merged[key] as UnknownRecord, value);
		} else {
			merged[key] = value;
		}
	}
	return merged;
};

const mergeRecordedToolCall = (existing: unknown, incoming: unknown): unknown =>
	isRecord(existing) && isRecord(incoming)
		? mergeDefinedRecord(existing, incoming)
		: existing;

export const reconcileRecordedToolCalls = (
	payloadCalls: unknown[],
	payloadBlockCalls: unknown[],
	messageBlockCalls: unknown[]
): unknown[] => {
	const reconciled: unknown[] = [];
	const executionIndex = new Map<string, number>();
	const idlessOccurrenceIndex = new Map<string, number>();

	for (const [sourceIndex, calls] of [payloadCalls, payloadBlockCalls, messageBlockCalls].entries()) {
		const sourceOccurrences = new Map<string, number>();
		for (const toolCall of calls.filter(Boolean)) {
			const id = executionId(toolCall);
			if (id) {
				const existingIndex = executionIndex.get(id);
				if (existingIndex === undefined) {
					executionIndex.set(id, reconciled.length);
					reconciled.push(toolCall);
				} else {
					reconciled[existingIndex] = mergeRecordedToolCall(
						reconciled[existingIndex],
						toolCall
					);
				}
				continue;
			}

			const fingerprint = stableFingerprint(toolCall);
			const occurrence = sourceOccurrences.get(fingerprint) ?? 0;
			sourceOccurrences.set(fingerprint, occurrence + 1);
			const occurrenceKey = `${fingerprint}\u0000${occurrence}`;
			const existingIndex = idlessOccurrenceIndex.get(occurrenceKey);
			if (existingIndex === undefined) {
				idlessOccurrenceIndex.set(occurrenceKey, reconciled.length);
				reconciled.push(toolCall);
			} else if (sourceIndex > 0) {
				reconciled[existingIndex] = mergeRecordedToolCall(
					reconciled[existingIndex],
					toolCall
				);
			}
		}
	}

	return reconciled;
};

export const recordedToolCallArraysEqual = (left: unknown, right: unknown): boolean =>
	Array.isArray(left) && Array.isArray(right) && stableFingerprint(left) === stableFingerprint(right);
