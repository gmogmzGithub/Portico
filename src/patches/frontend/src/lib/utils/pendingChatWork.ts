import type { PendingWorkItem, PendingWorkState } from '$lib/apis/chatPendingWork';

export type PendingWorkEditMode = 'none' | 'steer' | 'queue';
export type QueuedPromptEditDirection = 'previous' | 'next';
export type PendingWorkShortcutKind =
	| 'steer-submit'
	| 'queue-submit'
	| 'queue-edit-previous'
	| 'queue-edit-next';

export type ComposerHotkeyAction =
	| 'none'
	| 'stop'
	| 'cancel-pending-work-edit'
	| 'submit-steer'
	| 'submit-queue'
	| 'restore-steer'
	| 'restore-queue-previous'
	| 'restore-queue-next';

export interface ResolveComposerHotkeyActionInput {
	key: string;
	altKey: boolean;
	shiftKey: boolean;
	isStreaming: boolean;
	prompt: string;
	hasFiles: boolean;
	hasPendingSteer: boolean;
	queuedPromptCount: number;
	pendingWorkEditMode: PendingWorkEditMode;
}

export interface ShouldReconcileBackendStartedTurnEventInput {
	eventType: string | null | undefined;
	messageId: string | null | undefined;
	messages: Record<string, unknown> | null | undefined;
}

export interface ComposerStreamingStateInput {
	currentId: string | null | undefined;
	messages:
		| Record<
				string,
				{
					id?: unknown;
					parentId?: unknown;
					childrenIds?: unknown;
					role?: unknown;
					done?: unknown;
					error?: unknown;
					stop_reason?: unknown;
				}
		  >
		| null
		| undefined;
	activeTaskIds?: string[] | null | undefined;
	activeStreamingMessageIds?: string[] | null | undefined;
	forceStoppedMessageIds?: string[] | null | undefined;
}

export interface ComposerStreamingState {
	isStreaming: boolean;
	currentTurnAssistantIds: string[];
	visibleMessageIds: string[];
	visibleTailMessageId: string | null;
	usedActiveTaskFallback: boolean;
}

const parsePendingWorkUpdatedAtMs = (value: string | null | undefined): number | null => {
	if (typeof value !== 'string' || value.trim().length === 0) {
		return null;
	}

	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
};

const BACKEND_STARTED_TURN_EVENT_TYPES = new Set([
	'status',
	'chat:completion',
	'chat:message:delta',
	'message',
	'chat:message',
	'replace',
	'chat:message:files',
	'files',
	'chat:message:embeds',
	'embeds',
	'chat:message:error',
	'chat:message:follow_ups'
]);

const hasAssistantTerminalError = (message: {
	error?: unknown;
	stop_reason?: unknown;
	done?: unknown;
} | null | undefined) => {
	if (!message || typeof message !== 'object') {
		return false;
	}

	const error = message.error;
	if (error == null) {
		return false;
	}

	if (typeof error === 'string') {
		return error.trim().length > 0;
	}

	return true;
};

export const isAssistantMessageTerminalForComposer = (message: {
	role?: unknown;
	done?: unknown;
	error?: unknown;
	stop_reason?: unknown;
} | null | undefined) => {
	if (!message || message.role !== 'assistant') {
		return false;
	}

	return (
		message.done === true ||
		hasAssistantTerminalError(message) ||
		Boolean(message.stop_reason)
	);
};

export const hasVisibleActiveAssistantMessages = ({
	currentId,
	messages
}: ComposerStreamingStateInput): boolean =>
	getCurrentTurnAssistantMessageIds({ currentId, messages }).some((messageId) => {
		const message = messages?.[messageId];
		return !isAssistantMessageTerminalForComposer(message);
	});

export const getVisibleConversationMessageIds = ({
	currentId,
	messages
}: ComposerStreamingStateInput): string[] => {
	if (!currentId || !messages) {
		return [];
	}

	const visibleMessageIds: string[] = [];
	const seenMessageIds = new Set<string>();
	let messageId: string | null = currentId;

	while (messageId && !seenMessageIds.has(messageId)) {
		const message = messages[messageId];
		if (!message) {
			break;
		}

		visibleMessageIds.unshift(messageId);
		seenMessageIds.add(messageId);
		messageId = typeof message.parentId === 'string' ? message.parentId : null;
	}

	return visibleMessageIds;
};

const pushAssistantMessageId = ({
	messageId,
	messages,
	seenMessageIds,
	assistantMessageIds
}: {
	messageId: unknown;
	messages: ComposerStreamingStateInput['messages'];
	seenMessageIds: Set<string>;
	assistantMessageIds: string[];
}) => {
	if (typeof messageId !== 'string' || seenMessageIds.has(messageId)) {
		return;
	}

	const message = messages?.[messageId];
	if (!message || message.role !== 'assistant') {
		return;
	}

	seenMessageIds.add(messageId);
	assistantMessageIds.push(messageId);
};

export const getCurrentTurnAssistantMessageIds = ({
	currentId,
	messages
}: ComposerStreamingStateInput): string[] => {
	if (!currentId || !messages) {
		return [];
	}

	const currentMessage = messages[currentId];
	if (!currentMessage) {
		return [];
	}

	const assistantMessageIds: string[] = [];
	const seenMessageIds = new Set<string>();

	if (currentMessage.role === 'user') {
		for (const childId of Array.isArray(currentMessage.childrenIds) ? currentMessage.childrenIds : []) {
			pushAssistantMessageId({
				messageId: childId,
				messages,
				seenMessageIds,
				assistantMessageIds
			});
		}
		return assistantMessageIds;
	}

	if (currentMessage.role !== 'assistant') {
		return assistantMessageIds;
	}

	const parentId = typeof currentMessage.parentId === 'string' ? currentMessage.parentId : null;
	const parentMessage = parentId ? messages[parentId] : null;

	if (parentMessage?.role === 'user') {
		for (const childId of Array.isArray(parentMessage.childrenIds) ? parentMessage.childrenIds : []) {
			pushAssistantMessageId({
				messageId: childId,
				messages,
				seenMessageIds,
				assistantMessageIds
			});
		}
	}

	if (assistantMessageIds.length === 0) {
		pushAssistantMessageId({
			messageId: currentId,
			messages,
			seenMessageIds,
			assistantMessageIds
		});
	}

	return assistantMessageIds;
};

export const deriveComposerStreamingState = ({
	currentId,
	messages,
	activeTaskIds,
	activeStreamingMessageIds,
	forceStoppedMessageIds
}: ComposerStreamingStateInput): ComposerStreamingState => {
	const currentTurnAssistantIds = getCurrentTurnAssistantMessageIds({ currentId, messages });
	const visibleMessageIds = getVisibleConversationMessageIds({ currentId, messages });
	const visibleTailMessageId =
		visibleMessageIds.length > 0 ? visibleMessageIds[visibleMessageIds.length - 1] : null;

	if (
		currentTurnAssistantIds.some((messageId) => {
			const message = messages?.[messageId];
			return !isAssistantMessageTerminalForComposer(message);
		})
	) {
		return {
			isStreaming: true,
			currentTurnAssistantIds,
			visibleMessageIds,
			visibleTailMessageId,
			usedActiveTaskFallback: false
		};
	}

	const hasActiveTasks = Array.isArray(activeTaskIds) && activeTaskIds.length > 0;
	if (!hasActiveTasks || !visibleTailMessageId) {
		return {
			isStreaming: false,
			currentTurnAssistantIds,
			visibleMessageIds,
			visibleTailMessageId,
			usedActiveTaskFallback: false
		};
	}

	const visibleTailMessage = messages?.[visibleTailMessageId];
	if (!visibleTailMessage || visibleTailMessage.role !== 'assistant') {
		return {
			isStreaming: false,
			currentTurnAssistantIds,
			visibleMessageIds,
			visibleTailMessageId,
			usedActiveTaskFallback: false
		};
	}

	const forceStoppedMessageIdSet = new Set(forceStoppedMessageIds ?? []);
	if (forceStoppedMessageIdSet.has(visibleTailMessageId)) {
		return {
			isStreaming: false,
			currentTurnAssistantIds,
			visibleMessageIds,
			visibleTailMessageId,
			usedActiveTaskFallback: false
		};
	}

	const activeStreamingMessageIdSet = new Set(activeStreamingMessageIds ?? []);
	const hasTrackedStreamingProgress =
		activeStreamingMessageIdSet.has(visibleTailMessageId) ||
		currentTurnAssistantIds.some((messageId) => activeStreamingMessageIdSet.has(messageId));

	return {
		isStreaming: hasTrackedStreamingProgress,
		currentTurnAssistantIds,
		visibleMessageIds,
		visibleTailMessageId,
		usedActiveTaskFallback: hasTrackedStreamingProgress
	};
};

export const isComposerEmpty = (prompt: string, files: unknown[] = []) =>
	(prompt || '').trim() === '' && files.length === 0;

export const sortQueuedPromptsForDispatch = (items: PendingWorkItem[] = []) =>
	[...items].sort((left, right) => (left.sort_index ?? 0) - (right.sort_index ?? 0));

export const sortQueuedPromptsForEditing = (items: PendingWorkItem[] = []) =>
	[...items].sort((left, right) => (right.sort_index ?? 0) - (left.sort_index ?? 0));

export const getQueuedPromptEditTarget = (
	items: PendingWorkItem[] = [],
	currentItemId: string | null,
	direction: QueuedPromptEditDirection = 'previous'
) => {
	const ordered =
		direction === 'previous'
			? sortQueuedPromptsForEditing(items)
			: sortQueuedPromptsForDispatch(items);
	if (ordered.length === 0) {
		return null;
	}

	if (!currentItemId) {
		return ordered[0];
	}

	const currentIndex = ordered.findIndex((item) => item.id === currentItemId);
	if (currentIndex === -1) {
		return ordered[0];
	}

	return ordered[(currentIndex + 1) % ordered.length];
};

export const getNextQueuedPromptEditTarget = (
	items: PendingWorkItem[] = [],
	currentItemId: string | null
) => getQueuedPromptEditTarget(items, currentItemId, 'previous');

export const isMacLikePlatform = (platform: string | null | undefined) =>
	/(mac|iphone|ipad|ipod)/i.test(String(platform ?? '').trim());

export const getPendingWorkShortcutKeycaps = (
	platform: string | null | undefined,
	shortcutKind: PendingWorkShortcutKind
) => {
	const isMacLike = isMacLikePlatform(platform);
	const shortcutMap: Record<PendingWorkShortcutKind, string[]> = isMacLike
		? {
				'steer-submit': ['↩'],
				'queue-submit': ['⌥', '↩'],
				'queue-edit-previous': ['⌥', '↑'],
				'queue-edit-next': ['⌥', '↓']
			}
		: {
				'steer-submit': ['Enter'],
				'queue-submit': ['Alt', 'Enter'],
				'queue-edit-previous': ['Alt', 'Up'],
				'queue-edit-next': ['Alt', 'Down']
			};

	return shortcutMap[shortcutKind];
};

export const getPendingWorkPreviewText = (item: PendingWorkItem | null) => {
	const promptPreview = String(item?.prompt ?? '').trim();
	if (promptPreview) {
		return promptPreview.split(/\r?\n/, 1)[0];
	}

	if (!item?.files?.length) {
		return 'Ready to send';
	}

	return item.files.length === 1 ? '1 attachment ready' : `${item.files.length} attachments ready`;
};

export const shouldApplyPendingWorkStateSnapshot = (
	currentState: PendingWorkState | null | undefined,
	nextState: PendingWorkState | null | undefined
) => {
	if (!nextState || !currentState) {
		return true;
	}

	if (
		currentState.chat_id &&
		nextState.chat_id &&
		currentState.chat_id !== nextState.chat_id
	) {
		return true;
	}

	const currentUpdatedAtMs = parsePendingWorkUpdatedAtMs(currentState.updated_at);
	const nextUpdatedAtMs = parsePendingWorkUpdatedAtMs(nextState.updated_at);

	if (
		currentUpdatedAtMs !== null &&
		nextUpdatedAtMs !== null &&
		currentUpdatedAtMs !== nextUpdatedAtMs
	) {
		return nextUpdatedAtMs > currentUpdatedAtMs;
	}

	if (currentUpdatedAtMs === null && nextUpdatedAtMs !== null) {
		return true;
	}

	if (currentUpdatedAtMs !== null && nextUpdatedAtMs === null) {
		return false;
	}

	const currentVersion = Number.isFinite(Number(currentState.version))
		? Number(currentState.version)
		: 0;
	const nextVersion = Number.isFinite(Number(nextState.version)) ? Number(nextState.version) : 0;

	if (currentVersion !== nextVersion) {
		return nextVersion > currentVersion;
	}

	return true;
};

export const shouldReconcileBackendStartedTurnEvent = ({
	eventType,
	messageId,
	messages
}: ShouldReconcileBackendStartedTurnEventInput): boolean => {
	if (!messageId || !eventType) {
		return false;
	}

	if (messages?.[messageId]) {
		return false;
	}

	return BACKEND_STARTED_TURN_EVENT_TYPES.has(eventType);
};

export const resolveComposerHotkeyAction = ({
	key,
	altKey,
	shiftKey,
	isStreaming,
	prompt,
	hasFiles,
	hasPendingSteer,
	queuedPromptCount,
	pendingWorkEditMode
}: ResolveComposerHotkeyActionInput): ComposerHotkeyAction => {
	if (key === 'Escape' && pendingWorkEditMode !== 'none') {
		return 'cancel-pending-work-edit';
	}

	if (key === 'Enter' && pendingWorkEditMode === 'steer' && !shiftKey) {
		return 'submit-steer';
	}

	if (key === 'Enter' && pendingWorkEditMode === 'queue' && !shiftKey) {
		return 'submit-queue';
	}

	if (key === 'Enter' && isStreaming) {
		if (altKey) {
			return 'submit-queue';
		}
		if (!shiftKey) {
			return 'submit-steer';
		}
		return 'none';
	}

	if (
		pendingWorkEditMode === 'queue' &&
		altKey &&
		(key === 'ArrowUp' || key === 'ArrowDown')
	) {
		if (queuedPromptCount === 0) {
			return 'none';
		}
		return key === 'ArrowDown' ? 'restore-queue-next' : 'restore-queue-previous';
	}

	if (isComposerEmpty(prompt, hasFiles ? [{}] : [])) {
		if (altKey && key === 'ArrowUp') {
			return queuedPromptCount > 0 ? 'restore-queue-previous' : 'none';
		}
		if (altKey && key === 'ArrowDown') {
			return queuedPromptCount > 0 ? 'restore-queue-next' : 'none';
		}
		if (key !== 'ArrowUp') {
			return 'none';
		}
		if (hasPendingSteer) {
			return 'restore-steer';
		}
		return 'none';
	}

	return 'none';
};
