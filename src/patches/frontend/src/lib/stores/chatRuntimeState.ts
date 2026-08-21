import { get, writable } from 'svelte/store';
import { getTaskIdsByChatId } from '$lib/apis';
import { getChatById } from '$lib/apis/chats';
import { models, socket } from '$lib/stores';
import { resolveChatNotificationModelIdentity } from '$lib/utils/chatNotificationModel';
import { resolveChatRuntimeEntry } from '$lib/utils/chatRuntimeUnread';

export type ChatRuntimeState = {
	busy: boolean;
	phase: string;
	unread: boolean;
	attentionRequired: boolean;
};

type ChatActivitySnapshot = {
	version?: number;
	chats?: Array<{
		chatId?: string;
		busy?: boolean;
		phase?: string;
		unread?: boolean;
		attentionRequired?: boolean;
	}>;
};

type ChatShellStateSnapshot = {
	version?: number;
	chats?: Array<{
		chatId?: string;
		unread?: boolean;
		attentionRequired?: boolean;
	}>;
};

type NativeInputPresentationSnapshot = {
	version?: number;
	flows?: Array<{
		kind?: string;
		flow_id?: string;
		chat_id?: string;
		presentation?: string;
		item_count?: number;
	}>;
};

type ChatRuntimeHostApi = {
	getChatActivitySnapshot?: () => Promise<ChatActivitySnapshot>;
	reconcileChatRuntime?: (payload: {
		chatId: string;
		busy: boolean;
		phase: string;
		title?: string;
		modelIdentity?: Record<string, string> | null;
	}) => Promise<ChatActivitySnapshot>;
	acknowledgeChatRuntime?: (chatId: string) => Promise<ChatActivitySnapshot>;
	getChatAttentionSnapshot?: () => ChatShellStateSnapshot;
	getNativeInputPresentationSnapshot?: () => Promise<NativeInputPresentationSnapshot>;
};

export const chatRuntimeState = writable<Map<string, ChatRuntimeState>>(new Map());

let activityByChatId = new Map<
	string,
	{ busy: boolean; phase: string; unread: boolean; attentionRequired: boolean }
>();
let shellStateByChatId = new Map<string, { unread: boolean; attentionRequired: boolean }>();
let nativeInputAttentionByChatId = new Set<string>();
let initialized = false;
let backgroundReconcileTimer: number | null = null;
let backgroundReconcileInFlight = false;
const busyFirstObservedAt = new Map<string, number>();
const emptyTaskChecksByChatId = new Map<string, number>();

const BACKGROUND_RECONCILE_INTERVAL_MS = 3_500;
const BACKGROUND_RECONCILE_GRACE_MS = 4_500;
const BACKGROUND_EMPTY_CONFIRMATIONS = 2;

const publishCombinedState = () => {
	const next = new Map<string, ChatRuntimeState>();
	for (const [chatId, activity] of activityByChatId) {
		const shellState = shellStateByChatId.get(chatId);
		// PORTICO-432: unread is the activity registry's alone; see
		// $lib/utils/chatRuntimeUnread for why the shell's per-tab copy was
		// removed from this union and what still owns attentionRequired.
		next.set(
			chatId,
			resolveChatRuntimeEntry({
				activity,
				shellState,
				nativeInputAttention: nativeInputAttentionByChatId.has(chatId)
			})
		);
	}
	for (const [chatId, shellState] of shellStateByChatId) {
		if (!next.has(chatId)) {
			// PORTICO-432: a chat the registry is not tracking has nothing unread. The
			// registry retains any chat whose unread is set (shouldRetainChatState),
			// so reaching this branch means there is no unread for it and shell state
			// contributes attention only.
			next.set(
				chatId,
				resolveChatRuntimeEntry({
					activity: null,
					shellState,
					nativeInputAttention: nativeInputAttentionByChatId.has(chatId)
				})
			);
		}
	}
	for (const chatId of nativeInputAttentionByChatId) {
		const current = next.get(chatId);
		next.set(
			chatId,
			current
				? { ...current, attentionRequired: true }
				: {
						busy: false,
						phase: 'idle',
						unread: false,
						attentionRequired: true
					}
		);
	}
	chatRuntimeState.set(next);
};

const applyActivitySnapshot = (snapshot: ChatActivitySnapshot | null | undefined) => {
	const next = new Map<
		string,
		{ busy: boolean; phase: string; unread: boolean; attentionRequired: boolean }
	>();
	for (const item of Array.isArray(snapshot?.chats) ? snapshot.chats : []) {
		const chatId = typeof item?.chatId === 'string' ? item.chatId.trim() : '';
		if (
			!chatId ||
			(item?.busy !== true && item?.unread !== true && item?.attentionRequired !== true)
		) continue;
		next.set(chatId, {
			busy: item?.busy === true,
			phase:
				item?.busy === true && typeof item.phase === 'string' && item.phase ? item.phase : 'idle',
			unread: item?.unread === true,
			attentionRequired: item?.attentionRequired === true
		});
	}
	const now = Date.now();
	for (const [chatId, state] of next) {
		if (state.busy && !busyFirstObservedAt.has(chatId)) {
			busyFirstObservedAt.set(chatId, now);
		}
	}
	for (const chatId of busyFirstObservedAt.keys()) {
		if (next.get(chatId)?.busy !== true) {
			busyFirstObservedAt.delete(chatId);
			emptyTaskChecksByChatId.delete(chatId);
		}
	}
	activityByChatId = next;
	publishCombinedState();
};

const currentVisibleChatId = (): string => {
	if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
		return '';
	}
	const match = window.location.pathname.match(/^\/c\/([^/?#]+)/);
	return match ? decodeURIComponent(match[1]).trim() : '';
};

const reconcileBackgroundActiveChats = async (): Promise<void> => {
	if (backgroundReconcileInFlight || typeof window === 'undefined') {
		return;
	}

	const hostApi = (window as any)?.webviewHost as ChatRuntimeHostApi | undefined;
	const token = window.localStorage?.token;
	if (!token || typeof hostApi?.reconcileChatRuntime !== 'function') {
		return;
	}

	const visibleChatId = currentVisibleChatId();
	const now = Date.now();
	const candidates = Array.from(activityByChatId.entries()).filter(
		([chatId, state]) =>
			state.busy &&
			chatId !== visibleChatId &&
			now - (busyFirstObservedAt.get(chatId) ?? now) >= BACKGROUND_RECONCILE_GRACE_MS
	);
	if (candidates.length === 0) {
		return;
	}

	backgroundReconcileInFlight = true;
	try {
		await Promise.all(
			candidates.map(async ([chatId]) => {
				const taskResult = await getTaskIdsByChatId(token, chatId).catch(() => null);
				if (!Array.isArray(taskResult?.task_ids)) {
					return;
				}

				if (taskResult.task_ids.length > 0) {
					emptyTaskChecksByChatId.delete(chatId);
					return;
				}

				const emptyChecks = (emptyTaskChecksByChatId.get(chatId) ?? 0) + 1;
				emptyTaskChecksByChatId.set(chatId, emptyChecks);
				if (emptyChecks < BACKGROUND_EMPTY_CONFIRMATIONS) {
					return;
				}

				try {
					const chatRecord = await getChatById(token, chatId).catch(() => null);
					const title = String(chatRecord?.title || chatRecord?.chat?.title || '').trim();
					const modelIdentity = resolveChatNotificationModelIdentity({
						chatRow: chatRecord,
						modelCatalog: get(models) ?? []
					});
					const snapshot = await hostApi.reconcileChatRuntime({
						chatId,
						busy: false,
						phase: 'idle',
						...(title ? { title } : {}),
						...(modelIdentity ? { modelIdentity } : {})
					});
					emptyTaskChecksByChatId.delete(chatId);
					applyActivitySnapshot(snapshot);
				} catch (error) {
					console.warn('[chatRuntimeState] background task reconciliation failed:', error);
				}
			})
		);
	} finally {
		backgroundReconcileInFlight = false;
	}
};

const startBackgroundReconciliation = () => {
	if (backgroundReconcileTimer !== null) {
		return;
	}
	backgroundReconcileTimer = window.setInterval(
		() => void reconcileBackgroundActiveChats(),
		BACKGROUND_RECONCILE_INTERVAL_MS
	);
};

// Server-side dispatches (queued prompts, cross-chat messages, chats started
// by other chats) run completions with NO renderer view attached, so nothing
// reports busy to the Electron activity registry until the user opens the
// chat. The backend already emits `chat:background-turn:inserted` to the
// owner's socket room at dispatch start — translate it into the same
// reconcileChatRuntime call an open view would make. The existing background
// poller clears busy once the chat's task list drains.
export const backgroundBusyChatIdFromSocketEvent = (
	event: { chat_id?: unknown; data?: { type?: unknown } } | null | undefined,
	visibleChatId: string
): string | null => {
	if (event?.data?.type !== 'chat:background-turn:inserted') {
		return null;
	}
	const chatId = typeof event?.chat_id === 'string' ? event.chat_id.trim() : '';
	if (!chatId || chatId === visibleChatId) {
		return null;
	}
	return chatId;
};

const markChatBusyFromSocketEvent = async (event: unknown): Promise<void> => {
	const chatId = backgroundBusyChatIdFromSocketEvent(
		event as { chat_id?: unknown; data?: { type?: unknown } },
		currentVisibleChatId()
	);
	if (!chatId || activityByChatId.get(chatId)?.busy === true) {
		return;
	}
	const hostApi = (window as any)?.webviewHost as ChatRuntimeHostApi | undefined;
	if (typeof hostApi?.reconcileChatRuntime !== 'function') {
		return;
	}
	try {
		const token = window.localStorage?.token;
		let title = '';
		let modelIdentity: Record<string, string> | null = null;
		if (token) {
			const chatRecord = await getChatById(token, chatId).catch(() => null);
			title = String(chatRecord?.title || chatRecord?.chat?.title || '').trim();
			modelIdentity = resolveChatNotificationModelIdentity({
				chatRow: chatRecord,
				modelCatalog: get(models) ?? []
			});
		}
		const snapshot = await hostApi.reconcileChatRuntime({
			chatId,
			busy: true,
			phase: 'generating',
			...(title ? { title } : {}),
			...(modelIdentity ? { modelIdentity } : {})
		});
		applyActivitySnapshot(snapshot);
	} catch (error) {
		console.warn('[chatRuntimeState] background busy marking failed:', error);
	}
};

const bindBackgroundBusySocketListener = () => {
	let boundSocket: { on?: Function; off?: Function } | null = null;
	const handler = (event: unknown) => void markChatBusyFromSocketEvent(event);
	socket.subscribe((instance: { on?: Function; off?: Function } | null) => {
		if (!instance || instance === boundSocket) {
			return;
		}
		boundSocket?.off?.('events', handler);
		boundSocket = instance;
		instance.on?.('events', handler);
	});
};

const applyShellStateSnapshot = (snapshot: ChatShellStateSnapshot | null | undefined) => {
	const next = new Map<string, { unread: boolean; attentionRequired: boolean }>();
	for (const item of Array.isArray(snapshot?.chats) ? snapshot.chats : []) {
		const chatId = typeof item?.chatId === 'string' ? item.chatId.trim() : '';
		if (chatId && (item?.unread === true || item?.attentionRequired === true)) {
			next.set(chatId, {
				unread: item?.unread === true,
				attentionRequired: item?.attentionRequired === true
			});
		}
	}
	shellStateByChatId = next;
	publishCombinedState();
};

const NATIVE_INPUT_ATTENTION_KINDS = new Set([
	'user_question',
	'sensitive_info',
	'chat_workspace_consent',
	'marketplace_publish'
]);

const applyNativeInputPresentationSnapshot = (
	snapshot: NativeInputPresentationSnapshot | null | undefined
) => {
	const next = new Set<string>();
	for (const flow of Array.isArray(snapshot?.flows) ? snapshot.flows : []) {
		const kind = typeof flow?.kind === 'string' ? flow.kind.trim() : '';
		const chatId = typeof flow?.chat_id === 'string' ? flow.chat_id.trim() : '';
		if (chatId && NATIVE_INPUT_ATTENTION_KINDS.has(kind)) {
			next.add(chatId);
		}
	}
	nativeInputAttentionByChatId = next;
	publishCombinedState();
};

export const initializeChatRuntimeStateBridge = async (): Promise<void> => {
	if (initialized || typeof window === 'undefined') {
		return;
	}
	initialized = true;

	window.addEventListener('owui-chat-activity-snapshot', ((event: CustomEvent) => {
		applyActivitySnapshot(event.detail);
	}) as EventListener);
	window.addEventListener('owui-chat-attention-snapshot', ((event: CustomEvent) => {
		applyShellStateSnapshot(event.detail);
	}) as EventListener);
	window.addEventListener('owui-native-input-presentation-snapshot', ((event: CustomEvent) => {
		applyNativeInputPresentationSnapshot(event.detail);
	}) as EventListener);

	const hostApi = (window as any)?.webviewHost as ChatRuntimeHostApi | undefined;
	applyShellStateSnapshot(hostApi?.getChatAttentionSnapshot?.());
	if (typeof hostApi?.getNativeInputPresentationSnapshot === 'function') {
		try {
			applyNativeInputPresentationSnapshot(await hostApi.getNativeInputPresentationSnapshot());
		} catch (error) {
			console.warn('[chatRuntimeState] initial native-input attention snapshot failed:', error);
		}
	}
	if (typeof hostApi?.getChatActivitySnapshot === 'function') {
		try {
			applyActivitySnapshot(await hostApi.getChatActivitySnapshot());
		} catch (error) {
			console.warn('[chatRuntimeState] initial activity snapshot failed:', error);
		}
	}
	startBackgroundReconciliation();
	bindBackgroundBusySocketListener();
};
