const cloneValue = (value) => {
	if (value === undefined) return undefined;
	if (typeof structuredClone === 'function') {
		try {
			return structuredClone(value);
		} catch {
			// Chat payloads should be serializable; retain a JSON fallback for tests
			// and older browser runtimes.
		}
	}
	return JSON.parse(JSON.stringify(value));
};

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const identityFor = (value, index, collectionName) => {
	if (!isObject(value)) return `${typeof value}:${String(value)}`;
	for (const key of [
		'id',
		'tool_call_id',
		'tool_use_id',
		'call_id',
		'file_id',
		'url',
		'name'
	]) {
		const candidate = value[key];
		if (candidate !== null && candidate !== undefined && String(candidate).trim()) {
			return `${key}:${String(candidate)}`;
		}
	}
	if (collectionName === 'statusHistory') {
		return `status:${String(value.timestamp ?? value.created_at ?? '')}:${String(
			value.action ?? value.status ?? value.description ?? ''
		)}`;
	}
	if (collectionName === 'contentBlocks') {
		return `block:${String(value.type ?? '')}:${index}`;
	}
	try {
		return `json:${JSON.stringify(value)}`;
	} catch {
		return `index:${index}`;
	}
};

const GROWING_TEXT_KEYS = new Set([
	'content',
	'text',
	'reasoning',
	'reasoning_content',
	'summary',
	'output',
	'result'
]);

const MONOTONIC_BOOLEAN_KEYS = new Set([
	'done',
	'completed',
	'cancelled',
	'canceled',
	'failed',
	'finished',
	'stopped',
	'terminal'
]);

const statusRank = (value) => {
	const normalized = String(value ?? '')
		.trim()
		.toLowerCase();
	if (['complete', 'completed', 'done', 'failed', 'error', 'cancelled', 'canceled', 'stopped'].includes(normalized)) {
		return 2;
	}
	if (['active', 'running', 'in_progress', 'in-progress', 'working', 'review'].includes(normalized)) {
		return 1;
	}
	return 0;
};

const COLLECTION_KEYS = new Set([
	'files',
	'sources',
	'citations',
	'results',
	'tool_results',
	'attachments'
]);

const STRUCTURED_SEQUENCE_KEYS = new Set([
	'contentBlocks',
	'tool_calls',
	'statusHistory'
]);

const mergeGrowingText = (localValue, remoteValue) => {
	if (typeof localValue !== 'string') return remoteValue;
	if (typeof remoteValue !== 'string') return localValue;
	if (remoteValue === localValue || remoteValue.startsWith(localValue)) return remoteValue;
	if (localValue.startsWith(remoteValue)) return localValue;
	return remoteValue.length >= localValue.length ? remoteValue : localValue;
};

const mergeArray = (localValue, remoteValue, collectionName, inUsage) => {
	const local = Array.isArray(localValue) ? localValue : [];
	const remote = Array.isArray(remoteValue) ? remoteValue : [];
	if (remote.length === 0) return cloneValue(local);
	if (local.length === 0) return cloneValue(remote);

	if (COLLECTION_KEYS.has(collectionName)) {
		const merged = local.map((value) => cloneValue(value));
		const indexByIdentity = new Map(
			merged.map((value, index) => [identityFor(value, index, collectionName), index])
		);
		for (const [remoteIndex, remoteItem] of remote.entries()) {
			const identity = identityFor(remoteItem, remoteIndex, collectionName);
			const localIndex = indexByIdentity.get(identity);
			if (localIndex === undefined) {
				indexByIdentity.set(identity, merged.length);
				merged.push(cloneValue(remoteItem));
			} else {
				merged[localIndex] = mergeValue(
					merged[localIndex],
					remoteItem,
					collectionName,
					inUsage
				);
			}
		}
		return merged;
	}

	if (STRUCTURED_SEQUENCE_KEYS.has(collectionName)) {
		const merged = local.map((value) => cloneValue(value));
		const indexByIdentity = new Map(
			merged.map((value, index) => [identityFor(value, index, collectionName), index])
		);
		for (const [remoteIndex, remoteItem] of remote.entries()) {
			const identity = identityFor(remoteItem, remoteIndex, collectionName);
			const localIndex = indexByIdentity.get(identity);
			if (localIndex === undefined) {
				indexByIdentity.set(identity, merged.length);
				merged.push(cloneValue(remoteItem));
			} else {
				merged[localIndex] = mergeValue(
					merged[localIndex],
					remoteItem,
					collectionName,
					inUsage
				);
			}
		}
		return merged;
	}

	const length = Math.max(local.length, remote.length);
	return Array.from({ length }, (_, index) => {
		if (index >= remote.length) return cloneValue(local[index]);
		if (index >= local.length) return cloneValue(remote[index]);
		return mergeValue(local[index], remote[index], collectionName, inUsage);
	});
};

const mergeValue = (localValue, remoteValue, key = '', inUsage = false) => {
	if (remoteValue === undefined || remoteValue === null) return cloneValue(localValue);
	if (localValue === undefined || localValue === null) return cloneValue(remoteValue);

	const nextInUsage = inUsage || key === 'usage';
	if (Array.isArray(localValue) || Array.isArray(remoteValue)) {
		return mergeArray(localValue, remoteValue, key, nextInUsage);
	}
	if (isObject(localValue) && isObject(remoteValue)) {
		const merged = cloneValue(localValue);
		for (const [remoteKey, remoteChild] of Object.entries(remoteValue)) {
			merged[remoteKey] = mergeValue(
				localValue[remoteKey],
				remoteChild,
				remoteKey,
				nextInUsage
			);
		}
		return merged;
	}
	if (MONOTONIC_BOOLEAN_KEYS.has(key)) return localValue === true || remoteValue === true;
	if (key === 'status' && typeof localValue === 'string' && typeof remoteValue === 'string') {
		return statusRank(localValue) > statusRank(remoteValue) ? localValue : remoteValue;
	}
	if (nextInUsage && typeof localValue === 'number' && typeof remoteValue === 'number') {
		return Math.max(localValue, remoteValue);
	}
	if (GROWING_TEXT_KEYS.has(key)) return mergeGrowingText(localValue, remoteValue);
	if (typeof remoteValue === 'string' && remoteValue.length === 0 && localValue) {
		return cloneValue(localValue);
	}
	return cloneValue(remoteValue);
};

const serializableSignature = (value) => {
	try {
		return JSON.stringify(value);
	} catch {
		return '';
	}
};

export const extractDetachedSubagentPayload = (snapshot) => {
	if (!isObject(snapshot)) return null;
	if (
		isObject(snapshot.chat) &&
		(isObject(snapshot.chat.history) || Array.isArray(snapshot.chat.messages))
	) {
		return snapshot.chat;
	}
	return snapshot;
};

export const extractDetachedSubagentHistory = (snapshot) => {
	const payload = extractDetachedSubagentPayload(snapshot);
	if (!payload) return null;
	return isObject(payload.history) ? payload.history : null;
};

const messageIsAncestor = (messages, ancestorId, descendantId) => {
	if (!ancestorId || !descendantId || ancestorId === descendantId) return false;
	const visited = new Set();
	let currentId = descendantId;
	while (currentId && !visited.has(currentId)) {
		visited.add(currentId);
		const parentId = messages[currentId]?.parentId;
		if (parentId === ancestorId) return true;
		currentId = typeof parentId === 'string' ? parentId : '';
	}
	return false;
};

const shouldAdvanceCurrentId = (messages, localCurrentId, remoteCurrentId) => {
	if (!remoteCurrentId || !messages[remoteCurrentId]) return false;
	if (!localCurrentId || !messages[localCurrentId] || localCurrentId === remoteCurrentId) return true;
	if (messageIsAncestor(messages, localCurrentId, remoteCurrentId)) return true;
	if (messageIsAncestor(messages, remoteCurrentId, localCurrentId)) return false;

	const localMessage = messages[localCurrentId];
	const remoteMessage = messages[remoteCurrentId];
	if (localMessage?.role === 'assistant' && remoteMessage?.role === 'user') return false;
	if (localMessage?.role === 'user' && remoteMessage?.role === 'assistant') return true;
	return Number(remoteMessage?.timestamp ?? 0) > Number(localMessage?.timestamp ?? 0);
};

export const mergeDetachedSubagentHistory = (localHistory, snapshot) => {
	const remoteHistory = extractDetachedSubagentHistory(snapshot);
	if (!remoteHistory || !isObject(remoteHistory.messages)) {
		return { history: localHistory, changed: false };
	}

	const local = isObject(localHistory)
		? cloneValue(localHistory)
		: { messages: {}, currentId: null };
	if (!isObject(local.messages)) local.messages = {};
	const before = serializableSignature(local);

	for (const [messageId, remoteMessage] of Object.entries(remoteHistory.messages)) {
		local.messages[messageId] = mergeValue(
			local.messages[messageId],
			remoteMessage,
			'message',
			false
		);
	}

	const remoteCurrentId = remoteHistory.currentId;
	if (
		typeof remoteCurrentId === 'string' &&
		shouldAdvanceCurrentId(local.messages, local.currentId, remoteCurrentId)
	) {
		local.currentId = remoteCurrentId;
	}
	for (const [key, remoteValue] of Object.entries(remoteHistory)) {
		if (key === 'messages' || key === 'currentId') continue;
		local[key] = mergeValue(local[key], remoteValue, key, false);
	}

	return {
		history: local,
		changed: before !== serializableSignature(local)
	};
};

export const mergeDetachedSubagentCollection = (localValue, remoteValue, key) =>
	mergeArray(localValue, remoteValue, key, false);

export const normalizeDetachedSubagentActiveHistory = (history, now = Date.now()) => {
	if (!isObject(history) || !isObject(history.messages)) {
		return { history, changed: false };
	}

	const currentId = typeof history.currentId === 'string' ? history.currentId : '';
	const current = currentId ? history.messages[currentId] : null;
	if (!isObject(current) || current.role !== 'assistant') {
		return { history, changed: false };
	}
	const hasAuthoritativeTerminalState = Boolean(
		current.done === true ||
		current.error ||
		current.stop_reason ||
		current.stopReason ||
		current.finish_reason ||
		current.completed === true ||
		current.cancelled === true ||
		current.canceled === true ||
		current.failed === true ||
		current.finished === true ||
		current.stopped === true ||
		current.terminal === true ||
		statusRank(current.status) === 2
	);
	if (hasAuthoritativeTerminalState) {
		return { history, changed: false };
	}
	if (current.done !== false && current.done !== undefined && current.done !== null) {
		return { history, changed: false };
	}

	// Missing `done` is ambiguous in ordinary legacy history. Detached child
	// generations have a strict two-hour lifetime, so an older unmarked record
	// must not be revived as active. Explicit done=false remains authoritative.
	const rawTimestamp = Number(current.timestamp ?? 0);
	const timestampMs = Number.isFinite(rawTimestamp) && rawTimestamp > 0
		? rawTimestamp > 1_000_000_000_000
			? rawTimestamp
			: rawTimestamp * 1000
		: null;
	if (
		current.done !== false &&
		timestampMs !== null &&
		Math.max(0, now - timestampMs) >= 2 * 60 * 60 * 1000
	) {
		return { history, changed: false };
	}

	const existingStartedAt = Number(current.streamStartedAt ?? 0);
	const streamStartedAt = Number.isFinite(existingStartedAt) && existingStartedAt > 0
		? existingStartedAt
		: timestampMs !== null
			? timestampMs
			: now;
	if (current.done === false && current.streamStartedAt === streamStartedAt) {
		return { history, changed: false };
	}

	return {
		history: {
			...history,
			messages: {
				...history.messages,
				[currentId]: {
					...current,
					done: false,
					streamStartedAt
				}
			}
		},
		changed: true
	};
};

export const isDetachedSubagentHistoryTerminal = (history) => {
	if (!isObject(history) || !isObject(history.messages)) return false;
	const assistantMessages = Object.values(history.messages).filter(
		(message) => isObject(message) && message.role === 'assistant'
	);
	if (assistantMessages.length === 0) return false;

	const current =
		typeof history.currentId === 'string' ? history.messages[history.currentId] : null;
	const candidate =
		isObject(current) && current.role === 'assistant'
			? current
			: assistantMessages
					.slice()
					.sort(
						(a, b) => Number(a.timestamp ?? 0) - Number(b.timestamp ?? 0)
					)
					.at(-1);

	return Boolean(
		candidate?.done === true ||
		candidate?.completed === true ||
		candidate?.cancelled === true ||
		candidate?.canceled === true ||
		candidate?.failed === true ||
		candidate?.finished === true ||
		candidate?.stopped === true ||
		candidate?.terminal === true ||
			candidate?.error ||
			candidate?.stop_reason ||
			candidate?.stopReason ||
			candidate?.finish_reason ||
			statusRank(candidate?.status) === 2
	);
};
