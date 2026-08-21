export type ChatStatusEntry = {
	action?: string;
	description?: string;
	done?: boolean;
	error?: boolean;
	hidden?: boolean;
	observed_at?: number | string;
	query?: string;
	queries?: string[];
	status_key?: string;
	urls?: string[];
	[key: string]: unknown;
};

const normalizeStatusKey = (value: unknown): string | null => {
	if (typeof value !== 'string') {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
};

const UPSTREAM_RETRY_STATUS_KEY = 'upstream_retry';

const isUpstreamRetryStatusEntry = (status: ChatStatusEntry | null | undefined): boolean => {
	return (
		normalizeStatusKey(status?.status_key) === UPSTREAM_RETRY_STATUS_KEY ||
		normalizeStatusKey(status?.action) === UPSTREAM_RETRY_STATUS_KEY
	);
};

export const partitionStatusHistory = (
	statusHistory: ChatStatusEntry[] | null | undefined
): { top: ChatStatusEntry[]; bottom: ChatStatusEntry[] } => {
	const history = Array.isArray(statusHistory) ? statusHistory : [];
	return {
		top: history.filter((status) => !isUpstreamRetryStatusEntry(status)),
		bottom: history.filter((status) => isUpstreamRetryStatusEntry(status))
	};
};

export const upsertStatusHistoryEntry = (
	statusHistory: ChatStatusEntry[] | null | undefined,
	incomingStatus: ChatStatusEntry | null | undefined
): ChatStatusEntry[] => {
	const nextHistory = Array.isArray(statusHistory) ? [...statusHistory] : [];
	if (!incomingStatus || typeof incomingStatus !== 'object') {
		return nextHistory;
	}

	const statusKey = normalizeStatusKey(incomingStatus.status_key);
	if (!statusKey) {
		nextHistory.push(incomingStatus);
		return nextHistory;
	}

	const existingIndex = nextHistory.findIndex(
		(status) => normalizeStatusKey(status?.status_key) === statusKey
	);

	if (existingIndex >= 0) {
		if (incomingStatus.hidden === true) {
			nextHistory.splice(existingIndex, 1);
			return nextHistory;
		}
		nextHistory[existingIndex] = {
			...(nextHistory[existingIndex] ?? {}),
			...incomingStatus
		};
		return nextHistory;
	}

	if (incomingStatus.hidden === true) {
		return nextHistory;
	}

	nextHistory.push(incomingStatus);
	return nextHistory;
};
